/** `server.{get,set,clear}OAuthAppConfig` handlers — BYO OAuth app credentials.
 *
 *  Lets the owner enter their own Google / Microsoft OAuth app `client_id` +
 *  `client_secret` in the UI. Backed by `OAuthAppConfigStore` (encrypted
 *  secret), which is the ONLY credential source — the `RECUED_{GMAIL,GCAL,
 *  GRAPH}_CLIENT_ID/_SECRET` env fallback and its `source: 'env'` status were
 *  deleted 2026-07-28. Mirrors the `server.{get,set}LLMConfig` shape
 *  (`config-schema.ts`): a paired get/set (+ clear) with `RpcError`
 *  `bad_request` / `locked` codes.
 *
 *  The `getOAuthAppConfig` read NEVER returns a `client_secret` — only
 *  `has_secret` + the (non-secret) `client_id` + `source`. */

import {
  OAUTH_APP_ISSUERS,
  totalRecord,
  RpcError,
  type HandlerSlice,
  type ServerRpcRegistry,
  type OAuthAppConfigSnapshot,
  type OAuthAppConfigStatus,
  type OAuthAppIssuer,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { OAuthAppConfigStore } from './oauth-app-config-store.js';

export interface OAuthAppConfigHandlerDeps {
  store: OAuthAppConfigStore;
}

export type OAuthAppConfigMethods =
  | 'server.getOAuthAppConfig'
  | 'server.setOAuthAppConfig'
  | 'server.clearOAuthAppConfig';

const isIssuer = (v: unknown): v is OAuthAppIssuer =>
  typeof v === 'string' && (OAUTH_APP_ISSUERS as readonly string[]).includes(v);

/** Map a store write/read failure onto the rpc error vocabulary. A locked
 *  server can neither encrypt a fresh secret nor decrypt a stored one. */
const asRpcError = (e: unknown): RpcError => {
  if (e instanceof RpcError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/locked/i.test(msg)) {
    return new RpcError('locked', 'Server is locked — unlock to manage OAuth app credentials', 423);
  }
  return new RpcError('internal', msg, 500);
};

export const makeOAuthAppConfigHandlers = (
  deps: OAuthAppConfigHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, OAuthAppConfigMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  const { store } = deps;

  const statusFor = (issuer: OAuthAppIssuer): OAuthAppConfigStatus => {
    const storedId = store.getClientId(issuer);
    if (storedId) {
      return { client_id: storedId, has_secret: store.hasSecret(issuer), source: 'stored' };
    }
    return { client_id: null, has_secret: false, source: null };
  };

  return {
    methods: ['server.getOAuthAppConfig', 'server.setOAuthAppConfig', 'server.clearOAuthAppConfig'],
    handlers: {
      'server.getOAuthAppConfig': async () => {
        return totalRecord(OAUTH_APP_ISSUERS, (issuer) => statusFor(issuer));
      },
      'server.setOAuthAppConfig': async (args) => {
        if (!isIssuer(args.issuer)) {
          throw new RpcError('bad_request', `unknown issuer '${String(args.issuer)}'`, 400);
        }
        const clientId = typeof args.client_id === 'string' ? args.client_id.trim() : '';
        const clientSecret = typeof args.client_secret === 'string' ? args.client_secret.trim() : '';
        if (!clientId) throw new RpcError('bad_request', 'client_id is required', 400);
        if (!clientSecret) throw new RpcError('bad_request', 'client_secret is required', 400);
        try {
          store.setIssuer(args.issuer, clientId, clientSecret);
        } catch (e) {
          throw asRpcError(e);
        }
        return { ok: true as const };
      },
      'server.clearOAuthAppConfig': async (args) => {
        if (!isIssuer(args.issuer)) {
          throw new RpcError('bad_request', `unknown issuer '${String(args.issuer)}'`, 400);
        }
        store.clearIssuer(args.issuer);
        return { ok: true as const };
      },
    },
  };
};
