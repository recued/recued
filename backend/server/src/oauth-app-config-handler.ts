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
  OAUTH_APP_ID,
  isOAuthAppSecretExpiryDate,
  OAUTH_PERMISSION_CLEANUP_ACTIONS,
  type SavedOAuthApp,
} from '@recued/contracts';
import type { WsClient } from './ws-server.js';
import type { OAuthAppConfigStore } from './oauth-app-config-store.js';
import type { CollectionInstanceStore } from './collections/instance-store.js';

/** References are public collection config, so usage checks never decrypt tokens. */
export const oauthAppUses = (instances: Pick<CollectionInstanceStore, 'list'>, issuer: OAuthAppIssuer, id: string): NonNullable<SavedOAuthApp['uses']> =>
  instances.list().flatMap(row => (row.platform === 'mail' || row.platform === 'calendar')
    && (row.adapter_type === 'gmail' || row.adapter_type === 'gcal' || row.adapter_type === 'graph')
    && row.config.managed_oauth === undefined && row.config.oauth_connection === undefined
    && (row.adapter_type === 'graph' ? 'microsoft' : 'google') === issuer
    && (row.config.oauth_app_id ?? 'default') === id ? [{ lane: row.platform, slug: row.slug }] : []);

export interface OAuthAppConfigHandlerDeps {
  store: OAuthAppConfigStore;
  uses?(issuer: OAuthAppIssuer, id: string): NonNullable<SavedOAuthApp['uses']>;
  usage?: import('./oauth-app-usage-service.js').OAuthAppUsageService;
  permissions?: import('./oauth-permission-consolidation.js').OAuthPermissionService;
  cleanup?: import('./oauth-permission-cleanup.js').OAuthPermissionCleanupService;
}

export type OAuthAppConfigMethods =
  | 'server.getOAuthAppConfig'
  | 'server.oauthApps'
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
  const uses = (issuer: OAuthAppIssuer, id: string) => deps.uses?.(issuer, id) ?? [];
  const assertUnused = (issuer: OAuthAppIssuer, id: string): void => {
    if (uses(issuer, id).length) throw new RpcError('conflict', 'Mail or Calendar uses this app. Reconnect or remove those accounts before removing the app or changing its Client ID.');
  };
  const apps = (): SavedOAuthApp[] => store.listApps().map(app => ({ ...app, uses: uses(app.issuer, app.id) }));

  const statusFor = (issuer: OAuthAppIssuer): OAuthAppConfigStatus => {
    const storedId = store.getClientId(issuer);
    if (storedId) {
      return { client_id: storedId, has_secret: store.hasSecret(issuer), source: 'stored', apps: store.listApps(issuer) };
    }
    return { client_id: null, has_secret: false, source: null, apps: store.listApps(issuer) };
  };

  return {
    methods: ['server.getOAuthAppConfig', 'server.oauthApps', 'server.setOAuthAppConfig', 'server.clearOAuthAppConfig'],
    handlers: {
      'server.oauthApps': async args => {
        if (args && (OAUTH_PERMISSION_CLEANUP_ACTIONS as readonly string[]).includes(args.action)) {
          if (!deps.cleanup) throw new RpcError('not_configured', 'Update and unlock the server to use guided permission cleanup.');
          return { ...await deps.cleanup.handle(args as import('@recued/contracts').OAuthPermissionCleanupRequest), apps: apps(), secret_expiry_supported: true };
        }
        if (args && ['permission_inventory', 'preview_permission_cleanup'].includes(args.action)) {
          if (!deps.permissions) throw new RpcError('not_configured', 'Update the server to review consolidated OAuth permissions.');
          let cleanup: Pick<import('@recued/contracts').OAuthAppsResponse, 'permission_cleanup_available' | 'permission_cleanup_jobs'> = {};
          if (deps.cleanup && args.action === 'permission_inventory') {
            try { cleanup = { permission_cleanup_available: true, permission_cleanup_jobs: deps.cleanup.list() }; }
            catch { cleanup = { permission_cleanup_available: false }; }
          }
          return { ...await deps.permissions.handle(args as import('@recued/contracts').OAuthPermissionRequest), ...cleanup, apps: apps(), secret_expiry_supported: true };
        }
        if (args && ['usage', 'retire_usage', 'rotate_secret', 'rotation_status'].includes(args.action)) {
          if (!deps.usage) throw new RpcError('not_configured', 'Update the server to review saved-app usage and rotate secrets.');
          return { ...await deps.usage.handle(args as import('@recued/contracts').OAuthAppUsageRequest), apps: apps(), secret_expiry_supported: true };
        }
        if (!args || !['list', 'save', 'delete'].includes(args.action)) throw new RpcError('bad_request', 'Choose a saved OAuth app action.');
        if (args.action === 'list') return { action: 'list', apps: apps(), secret_expiry_supported: true };
        if (args.action !== 'save' && args.action !== 'delete') throw new RpcError('bad_request', 'Choose a saved OAuth app action.');
        if (!isIssuer(args.issuer) || 'id' in args && args.id !== undefined && (typeof args.id !== 'string' || !OAUTH_APP_ID.test(args.id))) {
          throw new RpcError('bad_request', 'Choose a Google or Microsoft saved app.');
        }
        if (args.action === 'delete') {
          assertUnused(args.issuer, args.id);
          store.deleteApp(args.issuer, args.id, args.expected_revision);
          return { action: 'delete', apps: apps(), secret_expiry_supported: true };
        }
        const label = typeof args.label === 'string' ? args.label.trim() : '';
        const clientId = typeof args.client_id === 'string' ? args.client_id.trim() : '';
        const secret = typeof args.client_secret === 'string' ? args.client_secret.trim() : undefined;
        if (args.secret_expires_on !== undefined && args.secret_expires_on !== null && !isOAuthAppSecretExpiryDate(args.secret_expires_on)) {
          throw new RpcError('bad_request', 'Enter a real expiry date as YYYY-MM-DD, or clear the date.');
        }
        if (!label || label.length > 80 || !clientId || clientId.length > 1024 || (secret?.length ?? 0) > 16_384) {
          throw new RpcError('bad_request', 'Enter an app name (up to 80 characters) and Client ID.');
        }
        const current = args.id ? store.getApp(args.issuer, args.id) : null;
        if (current && current.client_id !== clientId) assertUnused(args.issuer, current.id);
        try {
          const saved = store.saveApp({ issuer: args.issuer, ...(args.id ? { id: args.id } : {}), label, client_id: clientId,
            ...(secret ? { client_secret: secret } : {}), ...(args.expected_revision !== undefined ? { expected_revision: args.expected_revision } : {}),
            ...(args.secret_expires_on !== undefined ? { secret_expires_on: args.secret_expires_on } : {}) });
          return { action: 'save', saved_id: saved.id, apps: apps(), secret_expiry_supported: true };
        } catch (e) { throw asRpcError(e); }
      },
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
        if (store.getClientId(args.issuer) && store.getClientId(args.issuer) !== clientId) assertUnused(args.issuer, 'default');
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
        assertUnused(args.issuer, 'default');
        store.clearIssuer(args.issuer);
        return { ok: true as const };
      },
    },
  };
};
