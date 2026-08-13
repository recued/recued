/** R26.4 Delta 3 (D-148 § A.11 / § P7) — `key.rotate` + `key.health`
 *  rpc handler slice.
 *
 *  The operator-facing surface behind Settings → Server → Key Health.
 *  Two methods:
 *
 *    - `key.health` — read the full per-class `KeyHealthBundle` (incl.
 *      live `compromise_alert` from the compromise ledger) + the
 *      per-class `availability` map. The page renders status + greys /
 *      points-elsewhere / enables each class's action from this.
 *    - `key.rotate` — dispatch an operator-initiated rotation to the
 *      per-server `RotationEngine`. Covers the ops WITHOUT a dedicated
 *      rpc: `server_identity_rotate` / `master_dek_rotate` /
 *      `publisher_identity_rotate` / `webhook_secret_rotate` /
 *      `mark_compromised`. `tls_renew` keeps `tls.renew`;
 *      `webclient_token_rotate` keeps `token.rotate` — routing them here
 *      too would double the path.
 *
 *  Surfaces the full `RotationResult` discriminated union verbatim
 *  (matches the contract comment in `d-148-rotation.ts` — the rpc layer
 *  doesn't project; UI consumers narrow on `ok`). On a self-host realm
 *  the unwired ops (`master_dek` / `publisher_identity` / `webhook_secret`)
 *  return `key_not_loaded` from the engine; the `key.health` availability
 *  map is what lets the UI grey them up front instead of surfacing the
 *  error on click.
 *
 *  Channel isolation: `key.` is in `MCP_RESERVED_RPC_PREFIXES`
 *  (see `packages/contracts/src/mcp-tool-catalog.ts`) so external MCP
 *  agents cannot reach this handler — a compromised agent calling
 *  `key.rotate` could de-pair every client by rotating
 *  `server_identity_key`, or mark a key compromised to force a
 *  disruptive cascade. The D-138 ratchet test asserts the prefix stays
 *  reserved.
 *
 *  `triggered_by_client_id` is the caller's `instance_id` from the WS
 *  context — pinned to the connected client so the rotation audit row
 *  identifies who initiated it. A connection that hasn't completed
 *  `register` (instance_id === null) is rejected with `forbidden` rather
 *  than running with a sentinel id (mirrors `tls.renew`). */

import { KEY_CLASSES, RpcError, totalRecord } from '@recued/contracts';
import type {
  HandlerSlice,
  KeyClass,
  KeyHealthEntry,
  KeyHealthView,
  KeyRotateRequest,
  RotationAvailability,
  RotationResult,
  ServerRpcRegistry,
} from '@recued/contracts';

import type { WsClient } from '../../ws-server.js';
import type { RotationEngine } from './index.js';

/** The ops `key.rotate` accepts. `tls_renew` + `webclient_token_rotate`
 *  are deliberately excluded — they keep their dedicated `tls.renew` /
 *  `token.rotate` surfaces. */
const KEY_ROTATE_ACCEPTED_OPS: ReadonlyArray<KeyRotateRequest['op']> = [
  'master_dek_rotate',
  'server_identity_rotate',
  'publisher_identity_rotate',
  'webhook_secret_rotate',
  'mark_compromised',
];

const isKeyClass = (value: unknown): value is KeyClass =>
  typeof value === 'string' && (KEY_CLASSES as ReadonlyArray<string>).includes(value);

export interface KeyRotationRpcDeps {
  /** The composed per-server rotation engine. */
  engine: RotationEngine;
  /** Reads the live Key Health view — the full per-class bundle (with
   *  `compromise_alert` overlaid from the compromise ledger) + the
   *  per-class availability map. Built by the cert-stack composer, which
   *  knows which rotation hooks are wired on this realm. */
  loadHealthView: () => Promise<KeyHealthView>;
}

/** Pure Key Health view builder. Overlays the live `compromise_alert`
 *  (read per class from the ledger) onto a placeholder-healthy base +
 *  attaches the caller-supplied availability map. Kept pure so the
 *  cert-stack composer supplies the production availability + ledger,
 *  and tests pin both.
 *
 *  NOTE — the base `status` is `'healthy'` for every class (the passport
 *  `loadKeyHealth` provider is likewise a placeholder today). The signal
 *  that is wired to real state is `compromise_alert`; surfacing real
 *  `status` / `last_rotated_at` (TLS cert expiry, audit-derived rotation
 *  timestamps) is a follow-up. */
export const buildKeyHealthView = async (args: {
  availability: Record<KeyClass, RotationAvailability>;
  isCompromised: (key_class: KeyClass) => Promise<boolean>;
}): Promise<KeyHealthView> => {
  // Resolved first, sequentially, because `totalRecord` builds synchronously —
  // and sequential is what the loop did, so the store sees the same call order.
  const compromised = new Map<KeyClass, boolean>();
  for (const key_class of KEY_CLASSES) {
    compromised.set(key_class, await args.isCompromised(key_class));
  }
  const key_health = totalRecord(KEY_CLASSES, (key_class): KeyHealthEntry => ({
    status: 'healthy',
    ...(compromised.get(key_class) === true ? { compromise_alert: true } : {}),
  }));
  return { key_health, availability: args.availability };
};

export const handleKeyHealth = async (
  deps: KeyRotationRpcDeps,
  ctx: WsClient,
): Promise<KeyHealthView> => {
  // Operator-only, same posture as `key.rotate` — the view discloses the
  // full key inventory + per-class compromise flags, so an unregistered
  // caller (valid bearer, pre-`register`) must not read it. The Key
  // Health panel always loads post-register, so the happy path is
  // unaffected.
  if (ctx.instance_id === null) {
    throw new RpcError(
      'forbidden',
      'key.health: operator-only surface — caller must complete pair registration first',
      401,
    );
  }
  return deps.loadHealthView();
};

export const handleKeyRotate = async (
  deps: KeyRotationRpcDeps,
  args: KeyRotateRequest,
  ctx: WsClient,
): Promise<RotationResult> => {
  // Authorization before input processing — check the operator-only gate
  // FIRST so an unregistered caller can't probe accepted op names /
  // validation rules through the `bad_request` messages below (Codex P1
  // fold). `key.rotate` is the destructive surface; gate-first is the
  // right posture even though the sibling `tls.renew` validates first.
  if (ctx.instance_id === null) {
    throw new RpcError(
      'forbidden',
      'key.rotate: operator-only surface — caller must complete pair registration before rotating keys',
      401,
    );
  }
  if (args === null || typeof args !== 'object') {
    throw new RpcError('bad_request', 'key.rotate: a rotation request object is required', 400);
  }
  if (!KEY_ROTATE_ACCEPTED_OPS.includes((args as KeyRotateRequest).op)) {
    throw new RpcError(
      'bad_request',
      `key.rotate: unknown or unsupported op (accepted: ${KEY_ROTATE_ACCEPTED_OPS.join(', ')}; ` +
        'tls_renew → tls.renew, webclient_token_rotate → token.rotate)',
      400,
    );
  }
  if (args.reason !== undefined && typeof args.reason !== 'string') {
    throw new RpcError('bad_request', 'key.rotate: reason must be a string when set', 400);
  }
  const triggered_by_client_id = ctx.instance_id;
  const reasonField = args.reason !== undefined ? { reason: args.reason } : {};

  switch (args.op) {
    case 'master_dek_rotate':
      return deps.engine.rotateMasterDek({ triggered_by_client_id, ...reasonField });
    case 'server_identity_rotate':
      return deps.engine.rotateServerIdentity({ triggered_by_client_id, ...reasonField });
    case 'publisher_identity_rotate':
      return deps.engine.rotatePublisherIdentity({ triggered_by_client_id, ...reasonField });
    case 'webhook_secret_rotate':
      if (typeof args.vendor !== 'string' || args.vendor.length === 0) {
        throw new RpcError('bad_request', 'key.rotate: webhook_secret_rotate requires a non-empty vendor', 400);
      }
      return deps.engine.rotateWebhookSecret({ vendor: args.vendor, triggered_by_client_id, ...reasonField });
    case 'mark_compromised':
      if (!isKeyClass(args.key_class)) {
        throw new RpcError('bad_request', 'key.rotate: mark_compromised requires a known key_class', 400);
      }
      return deps.engine.markCompromised({ key_class: args.key_class, triggered_by_client_id, ...reasonField });
  }
};

export const makeKeyRotateHandlers = (
  deps: KeyRotationRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'key.health' | 'key.rotate', WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['key.health', 'key.rotate'],
    handlers: {
      'key.health': async (_args, ctx) => handleKeyHealth(deps, ctx),
      'key.rotate': async (args, ctx) =>
        handleKeyRotate(deps, args as KeyRotateRequest, ctx),
    },
  };
};
