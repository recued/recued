/** RPC handlers for the pair.* namespace.
 *
 *  `pair.list` joins the durable `paired_instances` rows with live
 *  WS-connection state to produce one row per device the caller's
 *  account has ever paired. The extension's "new device or replace"
 *  UX consumes this.
 *
 *  `pair.revoke` marks a device revoked in the durable store AND
 *  closes any currently-open WebSocket belonging to it, sending
 *  `{ type: 'instance_revoked' }` so the ext can self-cleanup.
 *
 *  Audit emission (D-148 § A.2.1 — `pair_revoke` high-assurance row).
 *  `pair.revoke` emits one `pair_revoke` audit row on the success path,
 *  closing the mint → consume → revoke ledger arc. The
 *  `createSigningAuditLog` wrapper auto-signs against
 *  `server_identity_key` (kind is already in
 *  `HIGH_ASSURANCE_AUDIT_KINDS`) and `RESERVE_ACTIONS` auto-pins
 *  `reserve: true` so the row survives retention pruning. Target is
 *  the durable `instance_id` — extension's surface-level device
 *  identifier; `pair.list` resolves devices by this column so the
 *  audit row links 1:1 with the user-visible device entry. Detail
 *  carries `{ revoked_by_user_id, revoked_by_instance_id?,
 *  client_token_id?, display_name }`. The `client_token_id` field is
 *  the join key into the `pair_consume` ledger row (`pair_consume`'s
 *  `target` IS the `client_token_id`) — when populated, a SQL query
 *  like `pair_revoke.detail->>'client_token_id' = pair_consume.target`
 *  threads the full mint → consume → revoke arc for one device. The
 *  field is captured from the live `WsClient` at revoke time, so it
 *  resolves only for devices we caught online + whose bearer was
 *  verified against `client_tokens`. Offline-device revoke + db-less
 *  WS auth both omit the key rather than emitting null so the join
 *  row-set stays clean.
 *  Mirrors the `pair.mint` / `pair.consume` best-effort write pattern:
 *  a storage-layer throw at the audit sink doesn't roll back the
 *  already-persisted revoke + already-fired WS close (the device is
 *  gone the moment `paired.revoke` lands).
 */

import {
  RpcError,
  type HandlerSlice,
  type ServerEvent,
  type ServerPairedDevice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { AuditLogStore } from '@recued/storage';
import type { PairedInstancesStore } from './paired-instances-store.js';
import type { ClientTokenStore } from './pairing/client-tokens.js';
// Import the pure identity resolvers from the leaf module (NOT `ws-server.js`)
// to keep this handler runtime-decoupled from ws-server — ws-server imports
// `makePairHandlers`, so a runtime value import the other way would cycle.
import {
  resolveGatedClientInstanceId,
  resolveGatedClientOwnerId,
} from './ws-client-identity.js';
import type { WsClient, WsServerHandle } from './ws-server.js';

/** D-156 follow-on — the pair-roster broadcast variant minus the bus-assigned
 *  `cursor` field. The bus stamps the cursor; the handler supplies the kind +
 *  `op`. Mirrors `ContractBroadcastEvent` (contract-handler.ts). */
export type PairListChangedEvent = Omit<
  Extract<ServerEvent, { kind: 'pair.list_changed' }>,
  'cursor'
>;

export interface PairHandlerDeps {
  paired: PairedInstancesStore;
  wsServer: WsServerHandle;
  /** Audit sink. Optional — composer-side absence is a no-op (matches
   *  `mint-handler.ts` / `consume-handler.ts`). When present,
   *  `handlePairRevoke` emits one `pair_revoke` row on the success
   *  path AFTER both the durable store row + the live ws have been
   *  closed; failures (auth gate, not-found, cross-account) emit
   *  nothing so the ledger only carries rows that actually revoked a
   *  device. The signing wrapper (`createSigningAuditLog`) auto-stamps
   *  the Ed25519 signature when this dep is wired through it. */
  auditLog?: Pick<AuditLogStore, 'logActivity'>;
  /** Client-token store (D-148 § A.2.1). When wired, `handlePairRevoke`
   *  revokes the device's bearer credential(s) alongside the durable
   *  paired-instances row + the live ws close — without this, `pair.revoke`
   *  only marks the instance revoked and kicks the socket, but the bearer
   *  stays valid in `client_tokens`. An uncooperative / stolen revoked
   *  device that kept its bearer could then reconnect and `register` a FRESH
   *  (non-revoked) instance_id, regaining access (the register gate only
   *  checks `isRevoked` for the caller-supplied id, not the bearer's
   *  identity). Revoking the bearer here closes that bypass at the source.
   *  Composer-side absence is a no-op (db-less harnesses). */
  clientTokens?: Pick<ClientTokenStore, 'revoke' | 'list'>;
  /** Clock seam (tests). Defaults to `Date.now`. Pins the audit row
   *  `timestamp`. */
  now?: () => number;
  /** D-156 follow-on — broadcast bus emit seam for the `pair.list_changed`
   *  roster fan-out. The bus assigns the cursor; the handler supplies the
   *  kind + `op`. Fired on the `handlePairRevoke` success path (after the
   *  durable revoke + ws close land) so paired clients' Settings → Devices
   *  roster re-lists off the authoritative signal. Optional: a db-less /
   *  no-bus harness wires no broadcast (the revoke still succeeds; only the
   *  live fan-out is absent). Emit failures are swallowed (observability-only
   *  — never abort the rpc), mirroring the contract-handler's `deps.broadcast`
   *  discipline. (The `op: 'added'` companion is emitted from the two
   *  roster-add paths: the `/auth/pair` HTTP handler in `server.ts` and the
   *  ws-server `intent: 'replace'` register path.) */
  broadcast?: (event: PairListChangedEvent) => void;
}

/** D-156 follow-on — emit the `pair.list_changed` roster broadcast
 *  (best-effort). Called AFTER a successful revoke, so the idempotent
 *  already-revoked short-circuit (which returns before any mutation) never
 *  emits. Emit failures are swallowed: the bus is observability, never a
 *  reason to fail the rpc the user just made. */
const emitPairListChanged = (
  broadcast: PairHandlerDeps['broadcast'],
  op: 'added' | 'revoked',
): void => {
  if (!broadcast) return;
  try {
    broadcast({ kind: 'pair.list_changed', op });
  } catch {
    // observability-only; never abort the rpc on emit failure.
  }
};

/** List devices for a user. Joins durable rows with live ws presence. */
export const handlePairList = async (
  deps: PairHandlerDeps,
  userId: string,
): Promise<{ devices: ServerPairedDevice[] }> => {
  if (!userId) {
    // No signed-in user means no pairable account context — return
    // empty rather than error. The extension shows "no devices" which
    // is correct (nothing to replace; first pair path applies).
    return { devices: [] };
  }
  const durable = deps.paired.listAll(userId);
  // D-156 follow-on — `listConnectedPairedInstances` (not
  // `listConnectedInstances`) so a live bearer-only webclient — whose paired
  // identity lives in `token_instance_id`, absent from the extension-only
  // heartbeat roster — resolves `connected`/`connected_at` against its
  // durable row instead of always rendering offline.
  const live = new Map<string, { connected_at: number }>();
  for (const client of deps.wsServer.listConnectedPairedInstances()) {
    live.set(client.instance_id, { connected_at: client.connected_at });
  }

  const devices: ServerPairedDevice[] = durable.map((row) => {
    const liveRow = live.get(row.instance_id);
    return {
      instance_id: row.instance_id,
      display_name: row.display_name,
      // D-156 P10 — the durable per-device kind (NULL legacy rows already
      // resolved to 'webclient' by the store), so the roster shows the
      // real surface (Bridge / CLI / Webclient) instead of a constant.
      kind: row.kind,
      added_at: row.added_at,
      revoked_at: row.revoked_at,
      connected: liveRow !== undefined && row.revoked_at === null,
      ...(liveRow ? { connected_at: liveRow.connected_at } : {}),
    };
  });
  return { devices };
};

/** Revoke a device. Marks it revoked in the durable store and closes
 *  any active ws it holds so the ext can self-cleanup via the
 *  `instance_revoked` close path. */
export const handlePairRevoke = async (
  deps: PairHandlerDeps,
  userId: string,
  args: { instance_id: string },
  ctx?: { instance_id: string | null },
): Promise<{ ok: true }> => {
  if (!args.instance_id) {
    throw new RpcError('bad_request', 'instance_id is required', 400);
  }
  if (!userId) {
    throw new RpcError('unauthorized', 'must be signed in to revoke a device', 401);
  }
  const row = deps.paired.get(args.instance_id);
  if (!row) {
    throw new RpcError('not_found', `instance_id ${args.instance_id} is not paired with this server`, 404);
  }
  if (row.user_id !== userId) {
    // Defense: prevent cross-account revoke. Shouldn't happen in
    // single-user self-host mode; matters for Cloud-hosted multi-tenant.
    throw new RpcError('forbidden', 'device belongs to a different user', 403);
  }
  if (row.revoked_at !== null) {
    // Codex P2 2026-05-17 fold — idempotent retry / double-click safety.
    // Pre-fold the rpc would re-stamp `paired.revoked_at` to a later
    // timestamp AND emit a fresh `pair_revoke` audit row keyed on the
    // durable `instance_id`. Since the underlying audit store's
    // `activities.set(activity_id, stored)` overwrites on duplicate id
    // (`audit.ts:840`), the original signed revoke row would be lost —
    // the ledger should preserve the first revocation as the
    // authoritative event. Mirrors how a "pair_consume → race-loser"
    // path emits nothing rather than overwriting the winner's row.
    // Returning `{ ok: true }` keeps the rpc idempotent at the
    // boundary so a UI retry / double-click is a no-op (the device
    // is already gone). No ws close either — `revokeConnectedInstance`
    // would return false for an already-closed session.
    return { ok: true };
  }
  deps.paired.revoke(args.instance_id);
  // Close any live ws for this instance. Fires `instance_revoked`
  // close code + message; on reconnect the ext hits the register path
  // which checks isRevoked and rejects.
  //
  // D-148 § A.2.1 — capture the durable `client_tokens.token_id` the
  // closed socket was authenticated under so we can stamp
  // `detail.client_token_id` on the audit row below. The `WsClient`
  // field is populated by WS bearer-verify; when absent the detail
  // simply omits the field rather than emitting a null sentinel,
  // matching the optional-encoding pattern `revoked_by_instance_id`
  // already uses for the webclient bearer-only path. Offline-device
  // revoke (no live ws) returns `{ revoked: false }` here + the
  // detail correctly omits `client_token_id` — the join column only
  // resolves for devices we caught online at revoke time, which is
  // the same condition the WS-side `instance_revoked` close fires
  // under.
  const wsResult = deps.wsServer.revokeConnectedInstance(args.instance_id);

  // Revoke the device's BEARER credential(s) so a revoked device cannot
  // reconnect with its still-valid token and `register` a fresh, non-revoked
  // instance_id to regain access (the register gate only checks `isRevoked`
  // for the caller-supplied id, not the bearer's identity). Two paths:
  //   1. the live socket's `client_token_id` (when caught online), and
  //   2. any OFFLINE token bound to this instance via `metadata.instance_id`
  //      (a disconnected revoked device that kept its stored bearer).
  // `revoke` is idempotent (no-op on already-revoked/unknown); `list` is
  // bounded (one account's tokens). A legitimate re-pair is unaffected — it
  // mints a brand-new token through the consume substrate. Best-effort: a
  // store throw must not roll back the already-persisted instance revoke + ws
  // close (the device is already gone), so swallow.
  if (deps.clientTokens) {
    try {
      if (wsResult.client_token_id) {
        deps.clientTokens.revoke(wsResult.client_token_id, 'pair_revoked');
      }
      for (const token of deps.clientTokens.list({ include_revoked: false })) {
        if (token.metadata?.['instance_id'] === args.instance_id) {
          deps.clientTokens.revoke(token.token_id, 'pair_revoked');
        }
      }
    } catch { /* the instance revoke + ws close already landed */ }
  }

  // High-assurance audit row — emit AFTER both the durable revoke
  // stamp + the live ws close so a storage-layer throw at the audit
  // sink doesn't leave a "revoked" ledger entry pointing at a device
  // that's still paired. Best-effort: the device is already gone the
  // moment `paired.revoke` lands; rolling the rpc back on an audit-
  // sink throw would re-grant the credential, which is worse than a
  // missed-row gap. Mirrors `schedule-handler.ts`'s `void
  // ... .catch(() => {})` pattern + the mint/consume best-effort pin
  // (see `mint-handler.ts:251`, `consume-handler.ts:295`).
  //
  // `activity_id` MUST be populated BEFORE the entry reaches
  // `createSigningAuditLog`. The wrapper signs canonical JSON first,
  // then the underlying `createAuditLogStore.logActivity` mutates an
  // empty `activity_id` to a generated value before persisting —
  // leaving a stored row whose id differs from the signed bytes
  // (verification would surface `signature_invalid` for every revoke
  // row). Same defensive pattern as `bin.ts:5230`
  // (`exposure:<action>:<ts>`) + the mint/consume slices. Deterministic
  // id keyed on the durable `instance_id`. The already-revoked
  // short-circuit above keeps this id one-row-per-revoke (the audit
  // store's `set(activity_id, …)` would otherwise overwrite the
  // original signed row on retry — Codex P2 2026-05-17 fold). Same
  // `instance_id` cannot legitimately come back: a re-pair after revoke
  // mints a NEW CSPRNG instance_id via the consume substrate.
  if (deps.auditLog) {
    const ts = (deps.now ?? Date.now)();
    void deps.auditLog
      .logActivity({
        activity_id: `pair_revoke:${args.instance_id}`,
        timestamp: ts,
        action: 'pair_revoke',
        target: args.instance_id,
        detail: JSON.stringify({
          revoked_by_user_id: userId,
          ...(ctx?.instance_id !== undefined && ctx.instance_id !== null
            ? { revoked_by_instance_id: ctx.instance_id }
            : {}),
          // D-148 § A.2.1 — durable `client_tokens.token_id` the closed
          // socket authenticated under. Stamped only when WS auth
          // resolved it; offline-device revoke + db-less WS auth both
          // omit the key (rather than emitting null) so the row is
          // join-clean: `pair_revoke.detail->>'client_token_id' =
          // pair_consume.target` filters out rows whose source isn't
          // resolvable.
          ...(wsResult.client_token_id !== undefined
            ? { client_token_id: wsResult.client_token_id }
            : {}),
          display_name: row.display_name,
        }),
      })
      .catch(() => {
        /* best-effort */
      });
  }

  // D-156 follow-on — fan the roster change to every paired client so their
  // Settings → Devices view re-lists the now-revoked device live. Emitted
  // here (not on the idempotent already-revoked short-circuit above) so the
  // signal fires exactly once per genuine revoke. Best-effort.
  emitPairListChanged(deps.broadcast, 'revoked');

  return { ok: true };
};

// ────────────────────────────────────────────────────────────────
// Handler slice — composeHandlers factory
// ────────────────────────────────────────────────────────────────

export type PairMethods = 'pair.list' | 'pair.revoke';

/** `getHandle` is lazy because the WsServerHandle is defined AFTER the
 *  handler registry in ws-server.ts (the handle closes over state that
 *  references the dispatcher). A `() => handle` accessor lets us build
 *  the slice before the handle exists; handlers invoke it at call time
 *  when the handle is guaranteed initialised.
 *
 *  `auditLog` is optional and threads the `createSigningAuditLog`-
 *  wrapped store from bin.ts into the `handlePairRevoke` success path.
 *  Composer-side absence is a no-op (matches mint/consume); the
 *  handler still revokes the device + closes the ws, just without
 *  emitting a `pair_revoke` ledger row. */
export const makePairHandlers = (
  paired: PairedInstancesStore | undefined,
  getHandle: () => WsServerHandle,
  auditLog?: Pick<AuditLogStore, 'logActivity'>,
  clientTokens?: Pick<ClientTokenStore, 'revoke' | 'list'>,
  broadcast?: (event: PairListChangedEvent) => void,
): HandlerSlice<ServerRpcRegistry, PairMethods, WsClient> | undefined => {
  if (!paired) return undefined;
  return {
    methods: ['pair.list', 'pair.revoke'],
    handlers: {
      'pair.list': async (_args, client) =>
        handlePairList(
          { paired, wsServer: getHandle() },
          // D-156 follow-on — resolve the owner id (cloud `user_id` for a
          // signed-in extension, else `SELF_HOST_OWNER_ID` for a verified
          // bearer-only webclient) so a self-host webclient enumerates its
          // own `/auth/pair`-seeded rows instead of the empty roster.
          resolveGatedClientOwnerId(client),
        ),
      'pair.revoke': async (args, client) =>
        handlePairRevoke(
          {
            paired,
            wsServer: getHandle(),
            ...(auditLog ? { auditLog } : {}),
            ...(clientTokens ? { clientTokens } : {}),
            ...(broadcast ? { broadcast } : {}),
          },
          resolveGatedClientOwnerId(client),
          args,
          { instance_id: resolveGatedClientInstanceId(client) },
        ),
    },
  };
};
