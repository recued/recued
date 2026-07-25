/** D-148 § A.6.5 + § A.9 — `passport.fetch` rpc handler slice.
 *
 *  Webclient post-WS-connect verify path. Every successful reconnect,
 *  the webclient calls `passport.fetch` and threads the result through
 *  `verifyPassportCertAttestation` to seed / promote / no-op / re-pair
 *  its pinned `WebclientCertPinState`. Closes the gap between the
 *  rotation-notice handler (which stages a `next_fingerprint` but
 *  cannot observe a TLS cert directly through the browser's
 *  `WebSocket` API) and real promotion of the staged-next to current.
 *
 *  Why this differs from a future user-initiated `passport.export`:
 *
 *    - **No audit row.** The `passport.exported` high-assurance audit
 *      row's semantics is "user-initiated INTENT to export" — a
 *      ledger entry the user can later review in Settings → Account →
 *      Passport History. A passport-fetch fires on every successful
 *      WS reconnect (could be dozens of times per day per client per
 *      paired surface); writing one audit row per call would flood
 *      the ledger + drown the signal a real export emits. The
 *      passport-fetch substrate composes the same providers + signs
 *      with the same key but routes around the audit emitter.
 *
 *    - **No history-store row.** Same rationale — the history store is
 *      a denormalized cache of user-initiated exports for fast list
 *      rendering. Reconnect verifications belong to the WS-handshake
 *      lifecycle, not the user-visible export history.
 *
 *    - **Always `support_redacted`.** The fetch path only needs the
 *      cert-fingerprint claim + the identity public key + the
 *      passport's `exported_at` (freshness gate) + the signature.
 *      `support_redacted` carries exactly those plus the minimum the
 *      verify wrapper needs to compose. `enterprise_audit` /
 *      `migration_full` carry sensitive topology that the verify path
 *      has no business reading.
 *
 *  Channel isolation: `passport.` is in `MCP_RESERVED_RPC_PREFIXES`
 *  (see `packages/contracts/src/mcp-tool-catalog.ts`). External MCP
 *  agents cannot reach this handler — the audit-row exemption above is
 *  safe ONLY behind the reserved-prefix gate. If `passport.` ever
 *  leaks onto the MCP surface, a compromised agent could enumerate the
 *  verify substrate at high cadence to exfiltrate identity fingerprints
 *  + LAN claims through the ledger-free path. Channel-isolation
 *  invariant; the ratchet test asserts the prefix stays reserved.
 *
 *  Codex P1-style fold (preemptive) — caller-identity gate. The rpc
 *  surface is operator-only. A connection that hasn't completed
 *  `register` (instance_id === null) is rejected with `forbidden`
 *  rather than running with a sentinel id. Belt-and-braces with the
 *  dispatcher's own register gate; no passport projection should ever
 *  ship to an unregistered caller.
 */

import type {
  HandlerSlice,
  ServerPassportProjection,
  ServerRpcRegistry,
} from '@recued/contracts';

import type { WsClient } from '../ws-server.js';
import { exportServerPassport, type PassportBlockProviders } from './index.js';
import type { Ed25519Keypair } from '../keys/index.js';

/** No-op audit emitter for the passport-fetch path. The substrate's
 *  `exportServerPassport` requires a `PassportAuditEmitter`; the fetch
 *  surface intentionally skips audit emission (see module-level
 *  rationale — every WS reconnect would otherwise write an audit row).
 *  Production wiring + tests pass this constant so the substrate sees
 *  a uniform "audit emitter" surface even when the slice routes around
 *  it. */
const NO_OP_PASSPORT_AUDIT_EMITTER = {
  log() {
    /* deliberate no-op — see module-level rationale */
  },
} as const;

/** Sentinel used for `exported_by_client_id` when the caller's
 *  `WsClient.instance_id` is null (webclient bearer auth that hasn't
 *  sent the legacy `register` message — the spec routes webclients
 *  through bearer-only auth post-D-148, not the legacy extension
 *  register flow). The field flows ONLY into the passport projection's
 *  metadata + the audit row; since the fetch path NEVER writes an
 *  audit row (per module-level rationale), the sentinel is purely
 *  informational + lets the projection still verify end-to-end.
 *
 *  Codex 2026-05-17 P1 fold (slice 116) — pre-fold the handler gated
 *  on `instance_id === null` with `RpcError('forbidden')`. Every
 *  default-on webclient call would have 403'd because the webclient
 *  bootstrap doesn't send `register` over the WS (only the legacy
 *  extension transport did). The verify path is read-only, has no
 *  audit row, and is reached only behind `MCP_RESERVED_RPC_PREFIXES`
 *  — channel isolation is the operator-only gate, not a per-call
 *  instance_id check (distinct from `tls.renew` which DOES write an
 *  audit row and binds `triggered_by_client_id` for forensic linkage). */
const UNREGISTERED_WEBCLIENT_BEARER_SENTINEL = 'webclient-bearer-unregistered';

export interface PassportFetchRpcDeps {
  /** Substrate block providers — same shape `passport.export` consumes.
   *  Wired from bin.ts against the live identity / network / clients /
   *  capabilities / recovery / key_health providers when those land in
   *  the substrate composition. Until then the slice ships absent +
   *  the dispatcher returns `not_configured`. */
  providers: PassportBlockProviders;
  /** Getter for the current `server_identity_key` keypair. Resolved on
   *  every `passport.fetch` invocation so a rotation that lands
   *  between deps construction (server boot) and the fetch call signs
   *  with the LIVE key instead of a stale boot snapshot.
   *
   *  Codex 2026-05-17 P1 fold (slice 117 — substrate composer review) —
   *  pre-fold this field was an `Ed25519Keypair` snapshot. After a
   *  rotation, `loadIdentity()` reads the live public key from the
   *  identity manager but the signature was made with the cached
   *  boot-time private key. Newly re-paired clients (which pin the new
   *  public key) would reject the passport `signature_invalid`; pre-
   *  rotation clients would reject `identity_key_mismatch` because the
   *  identity block's public key wouldn't match their pinned one.
   *  Either way the verify path would stay broken until restart.
   *  Bumping to a getter keeps both surfaces aligned per-call. */
  serverIdentity: () => Ed25519Keypair;
  /** Clock seam (tests). Defaults to `Date.now`. Pins `exported_at`. */
  now?: () => number;
  /** Id mint seam (tests). Defaults to `randomUUID`. Pins
   *  `passport_id`. */
  mintId?: () => string;
}

export const handlePassportFetch = async (
  deps: PassportFetchRpcDeps,
  _args: void,
  ctx: WsClient,
): Promise<{ passport: ServerPassportProjection }> => {
  // No instance_id gate (Codex 2026-05-17 P1 fold, slice 116) — see
  // UNREGISTERED_WEBCLIENT_BEARER_SENTINEL JSDoc.
  const exported_by_client_id =
    ctx.instance_id ?? UNREGISTERED_WEBCLIENT_BEARER_SENTINEL;
  const signed = await exportServerPassport({
    providers: deps.providers,
    // Per-call getter — see PassportFetchRpcDeps.serverIdentity JSDoc.
    serverIdentity: deps.serverIdentity(),
    audit: NO_OP_PASSPORT_AUDIT_EMITTER,
    exported_by_client_id,
    options: { profile: 'support_redacted' },
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.mintId !== undefined ? { mintId: deps.mintId } : {}),
    // No `history` — fetch path never persists into the passport
    // history store. Same audit-exemption rationale.
  });
  return { passport: signed };
};

export const makePassportFetchHandlers = (
  deps: PassportFetchRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'passport.fetch', WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['passport.fetch'],
    handlers: {
      'passport.fetch': async (_args, ctx) => handlePassportFetch(deps, _args, ctx),
    },
  };
};
