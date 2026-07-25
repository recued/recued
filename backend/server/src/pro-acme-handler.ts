/** D-148 follow-up #5 — `pro_acme.unbind` rpc handler.
 *
 *  Wire-A entry point for the Pro Settings page's "Release `<handle>.recued.cloud`"
 *  affordance. Adapts the wire-shaped args to the `proAcmeUnbind` substrate
 *  (`backend/server/src/pro-acme/unbind.ts`) + maps the tagged-union
 *  result to a wire response / `RpcError`.
 *
 *  The handler is a thin adapter (mirrors `tls-domain-handler.ts`):
 *
 *    1. Reject calls from unregistered (non-paired) WS clients — handle
 *       release is operator-only. Mirrors `tls_domain.*` / `exposure.*`
 *       posture per § A.13.5 P7.G.
 *    2. Validate the wire-shaped args (non-empty domain hostname,
 *       optional reason string).
 *    3. Call `proAcmeUnbind` substrate.
 *    4. Map the tagged-union result:
 *         - `ok: true`  → wire response { released, domain, handle }.
 *         - `ok: false` → `RpcError(error_code, ...)` keyed on the closed
 *           `NetworkErrorCode` value (`pro_acme_not_found` /
 *           `pro_acme_ddns_release_failed`).
 *
 *  Channel isolation: `pro_acme.*` is in `MCP_RESERVED_RPC_PREFIXES`
 *  (ratchet test asserts the prefix stays reserved). External AI agents
 *  must never drive a handle release — the DDNS subdomain release
 *  reshapes every paired client's server-address pin.
 *
 *  Spec: D-148 § A.5.2 + § A.6.3. */

import {
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { ProAcmeUnbindOptions } from './pro-acme/unbind.js';
import { proAcmeUnbind } from './pro-acme/unbind.js';
import type { WsClient } from './ws-server.js';

/** Lazy substrate accessor — mirrors `getStore` / `getMachine` pattern.
 *  bin.ts composes the `ProAcmeUnbindOptions` once the production
 *  `DdnsHandleControl` + audit sink are wired downstream of the lifecycle
 *  lock + identity boot. */
export interface ProAcmeRpcDeps {
  getOptions: () => ProAcmeUnbindOptions;
}

type ProAcmeMethods = 'pro_acme.unbind';

// ────────────────────────────────────────────────────────────────
// Caller-identity gate + arg validators
// ────────────────────────────────────────────────────────────────

const requireCallerInstance = (
  caller: { instance_id: string | null | undefined } | undefined,
  method: string,
): string => {
  if (!caller?.instance_id) {
    throw new RpcError(
      'permission_denied',
      `${method}: requires a paired client (D-121); rpc dispatched from an unregistered connection`,
      403,
    );
  }
  return caller.instance_id;
};

const badRequest = (message: string): RpcError =>
  new RpcError('bad_request', message, 400);

const looksLikeHostname = (s: unknown): s is string => {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (trimmed.length === 0 || trimmed.length > 253) return false;
  if (/[\s/?#:]/.test(trimmed)) return false;
  return true;
};

// ────────────────────────────────────────────────────────────────
// Handler function
// ────────────────────────────────────────────────────────────────

export const handleProAcmeUnbind = async (
  deps: ProAcmeRpcDeps,
  args: { domain?: unknown; reason?: unknown },
  caller: { instance_id: string | null | undefined } | undefined,
): Promise<{ released: boolean; domain: string; handle: string }> => {
  const method = 'pro_acme.unbind';
  const unbound_by_client_id = requireCallerInstance(caller, method);

  const rawDomain = args.domain;
  if (!looksLikeHostname(rawDomain)) {
    throw badRequest(
      `${method}: domain must be a non-empty hostname (no scheme, no path); got ${JSON.stringify(rawDomain)}`,
    );
  }

  if (args.reason !== undefined && typeof args.reason !== 'string') {
    throw badRequest(`${method}: reason must be a string when present`);
  }

  const result = await proAcmeUnbind(deps.getOptions(), {
    domain: rawDomain,
    unbound_by_client_id,
    ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
  });

  if (result.ok) {
    return {
      released: result.released,
      domain: result.domain,
      handle: result.handle,
    };
  }

  // Closed-list error codes; the dispatcher carries `RpcError.code`
  // through to the wire. Substrate-defined error codes map 1:1 to wire
  // codes — no translation layer.
  if (result.error === 'pro_acme_not_found') {
    throw new RpcError(
      'pro_acme_not_found',
      `${method}: no Pro-managed cert for ${result.domain}`,
      404,
    );
  }
  // pro_acme_ddns_release_failed
  throw new RpcError(
    'pro_acme_ddns_release_failed',
    `${method}: cloud DDNS release failed for ${result.domain}; cert row preserved — retry the unbind`,
    503,
  );
};

// ────────────────────────────────────────────────────────────────
// Slice factory
// ────────────────────────────────────────────────────────────────

export const makeProAcmeHandlers = (
  deps: ProAcmeRpcDeps | undefined,
): HandlerSlice<ServerRpcRegistry, ProAcmeMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: ['pro_acme.unbind'],
    handlers: {
      'pro_acme.unbind': async (args, client) =>
        handleProAcmeUnbind(
          deps,
          args as { domain?: unknown; reason?: unknown },
          client ? { instance_id: client.instance_id ?? null } : undefined,
        ),
    },
  };
};
