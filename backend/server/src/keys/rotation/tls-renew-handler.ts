/** D-148 § A.6.5 — `tls.renew` rpc handler slice.
 *
 *  Pair-rpc surface for operator-initiated TLS cert renewal. Delegates
 *  to the per-server `RotationEngine.renewTls(...)` which invokes the
 *  ACME helper (Pro tier) or local certbot/caddy hook (free tier),
 *  signs the resulting `cert_rotation_notice` with the current
 *  `server_identity_key`, and broadcasts the notice on the realtime
 *  bus so pinned clients pick up the next fingerprint over the
 *  overlap window.
 *
 *  Surfaces the full `RotationResult` discriminated union verbatim
 *  (matches the contract comment in `d-148-rotation.ts` — the rpc
 *  layer doesn't project; UI consumers narrow on `ok`).
 *
 *  Channel isolation: `tls.` is in `MCP_RESERVED_RPC_PREFIXES`
 *  (see `packages/contracts/src/mcp-tool-catalog.ts`) so external
 *  MCP agents cannot reach this handler. The ratchet test asserts
 *  the prefix stays reserved.
 *
 *  `triggered_by_client_id` is the caller's `instance_id` from the
 *  WS context — pinned to the connected client so the rotation audit
 *  row identifies who initiated the renew. Codex P1 fold — the rpc
 *  surface is operator-only, so a connection that hasn't completed
 *  `register` (instance_id === null) is rejected with `forbidden`
 *  rather than running with a sentinel id. Belt-and-braces with the
 *  dispatcher's own register gate; no operator-bound rotation should
 *  ever surface an "unknown caller" audit row.
 *
 *  Codex P2 fold — `rotation_at_offset_ms` must be strictly positive
 *  at this surface. The engine substrate still accepts 0 for
 *  synchronous test flows, but cert-pin appliers reject any notice
 *  whose `rotation_at <= now` as `rotation_at_in_past`. A 0-offset
 *  rpc call would emit a notice clients silently ignore while the
 *  rpc + audit row report success; require a positive offset so
 *  pinned clients always have a future flip window to pick up.
 */

import { RpcError } from '@recued/contracts';
import type {
  HandlerSlice,
  RotationResult,
  ServerRpcRegistry,
} from '@recued/contracts';

import type { WsClient } from '../../ws-server.js';
import type { RotationEngine } from './index.js';

export interface TlsRenewRpcDeps {
  engine: RotationEngine;
}

export const handleTlsRenew = async (
  deps: TlsRenewRpcDeps,
  args: { reason?: string; rotation_at_offset_ms?: number },
  ctx: WsClient,
): Promise<RotationResult> => {
  if (args.reason !== undefined && typeof args.reason !== 'string') {
    throw new RpcError('bad_request', 'tls.renew: reason must be a string when set', 400);
  }
  if (
    args.rotation_at_offset_ms !== undefined &&
    (typeof args.rotation_at_offset_ms !== 'number' ||
      !Number.isFinite(args.rotation_at_offset_ms) ||
      args.rotation_at_offset_ms <= 0)
  ) {
    throw new RpcError(
      'bad_request',
      'tls.renew: rotation_at_offset_ms must be a positive finite number when set ' +
        '(zero would emit a notice clients reject as rotation_at_in_past; omit to ' +
        'use the 7d default lead)',
      400,
    );
  }
  if (ctx.instance_id === null) {
    throw new RpcError(
      'forbidden',
      'tls.renew: operator-only surface — caller must complete pair registration before rotating TLS',
      401,
    );
  }
  return deps.engine.renewTls({
    triggered_by_client_id: ctx.instance_id,
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
    ...(args.rotation_at_offset_ms !== undefined
      ? { rotation_at_offset_ms: args.rotation_at_offset_ms }
      : {}),
  });
};

export const makeTlsRenewHandlers = (
  deps: TlsRenewRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, 'tls.renew', WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['tls.renew'],
    handlers: {
      'tls.renew': async (args, ctx) =>
        handleTlsRenew(deps, args as Parameters<typeof handleTlsRenew>[1], ctx),
    },
  };
};
