/** Direct Google API grants join the same durable reset as native collections. */
import { createHash } from 'node:crypto';
import { GOOGLE_TOKEN_URL, RpcError, managedOAuthDefaultVerificationUrl, managedOAuthVerificationUrl,
  type DirectOAuthAuth, type OAuthPermissionGroup, type OAuthPermissionCleanupTarget, type SavedOAuthApp } from '@recued/contracts';
import { createEnsureFreshAuth } from '@recued/ingredients';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { OAuthAppConfigStore } from './oauth-app-config-store.js';
import type { OAuthPermissionCleanupData, OAuthPermissionCleanupApiConnection } from './oauth-permission-cleanup-store.js';
import { encodeAuthForStorage, decodeAuthFromStorage } from './connection-auth-storage.js';
import { persistNativeOAuthRenewal, withCurrentConnectionRenewal } from './native-oauth-renewal.js';
import { makeBoundedOriginHttpFetcher } from './bounded-origin-http-fetcher.js';
import { oauthPermissionScopeCovers } from './oauth-permission-consolidation.js';
import { verifyDirectOAuthAccess } from './managed-oauth-verification.js';
import type { HttpFetcher } from './collections/mail/oauth.js';

const union = (...values: readonly (readonly string[])[]) => [...new Set(values.flat())].sort();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const changed = () => new RpcError('conflict', 'An API connection or its OAuth app changed. Refresh the saved permission cleanup.');
const refused = (message: string) => new RpcError('credential_verification_failed', message, 422);
const google = (scope: string) => 'https://www.googleapis.com/auth/' + scope;
const covers = (scopes: readonly string[], need: string) => scopes.some(s => oauthPermissionScopeCovers('google', 'https://sheets.googleapis.com', s, need));
const material = (row: OAuthPermissionCleanupApiConnection['row']) => hash([
  row.pk, row.enrolled_at, row.config_json, row.auth_ciphertext, row.granted_scopes_json,
]);
const readUrl = (base: string, raw: string): string | undefined => {
  const url = managedOAuthVerificationUrl(base, raw);
  // Google's API-key spelling also belongs to credentials, never an audit URL.
  return url && ![...new URL(url).searchParams.keys()].some(k => /^key$/i.test(k)) ? url : undefined;
};
const service = (raw: string): boolean => {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash
    && (u.origin === 'https://sheets.googleapis.com' && u.pathname.replace(/\/$/, '') === '/v4'
      || u.origin === 'https://gmail.googleapis.com' && ['', '/gmail/v1'].includes(u.pathname.replace(/\/$/, ''))
      || u.origin === 'https://www.googleapis.com' && ['/drive/v3', '/calendar/v3'].includes(u.pathname.replace(/\/$/, ''))); }
  catch { return false; }
};
const identityMethod = (granted: readonly string[], kept: readonly string[]): OAuthPermissionCleanupApiConnection['identity'] => {
  const both = (need: string) => covers(granted, need) && covers(kept, need);
  if (both(google('gmail.readonly'))) return { kind: 'gmail', url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' };
  if (both(google('calendar.readonly'))) return { kind: 'calendar', url: 'https://www.googleapis.com/calendar/v3/calendars/primary' };
  if (both(google('drive.readonly'))) return { kind: 'drive', url: 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,permissionId)' };
  if (granted.includes('openid') && kept.includes('openid') && [granted, kept].every(scopes => scopes.includes('email') || scopes.includes(google('userinfo.email')))) {
    return { kind: 'openid', url: 'https://openidconnect.googleapis.com/v1/userinfo' };
  }
  throw refused('This Google API account cannot be confirmed with its remaining permissions. Keep it protected; cleanup does not request extra identity permissions.');
};

export const createOAuthPermissionCleanupApi = (deps: {
  connections: ConnectionStoreSqlite; apps: OAuthAppConfigStore; key?: () => Uint8Array | null;
  now(): number; fetchImpl?: typeof fetch;
}) => {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const http = makeBoundedOriginHttpFetcher({ fetchImpl, timeoutMs: 15_000, maxResponseBytes: 16_384, redirectPolicy: 'error' });
  const decode = (row: OAuthPermissionCleanupApiConnection['row']) => decodeAuthFromStorage(row.auth_ciphertext, row, deps.key);
  const fresh = createEnsureFreshAuth({ fetchImpl, now: deps.now,
    withAuthRenewal: (row, run) => withCurrentConnectionRenewal(deps.connections, row, run),
    persistAuth: (row, auth, patch) => persistNativeOAuthRenewal({ store: deps.connections,
      decode: decodeAuthFromStorage, encode: encodeAuthForStorage, key: deps.key, now: deps.now }, row, auth, patch) });
  const assertCurrent = (data: OAuthPermissionCleanupData) => {
    for (const target of data.api_connections ?? []) {
      const live = deps.connections.get('api', target.row.name);
      if (!live || material(live) !== material(target.row)
        || deps.connections.getPendingCredentialRotationAttempt?.('api', target.row.name)
        || deps.connections.permissionCleanupId?.(live.name) !== (data.public.status === 'prepared' ? undefined : data.public.id)) throw changed();
    }
  };
  const readIdentity = async (target: Pick<OAuthPermissionCleanupApiConnection, 'identity'>, token: string) => {
    const response = await http(target.identity.url, { method: 'GET', headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!response.ok) throw refused('The Google API account could not be confirmed. Reconnect it before cleanup.');
    const data: unknown = await response.json();
    const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
    const root = record(data); const value = target.identity.kind === 'drive' ? record(root.user) : root;
    const rawEmail = target.identity.kind === 'openid' ? value.email : target.identity.kind === 'calendar' ? value.id : value.emailAddress;
    const email = typeof rawEmail === 'string' && rawEmail.length <= 254 && !/[\x00-\x1f\x7f]/.test(rawEmail)
      && /^[^\s@]+@[^\s@]+$/.test(rawEmail) ? rawEmail.toLowerCase() : undefined;
    const id = target.identity.kind === 'openid' ? value.sub : target.identity.kind === 'drive' ? value.permissionId : email;
    if (!email || typeof id !== 'string' || !id || id.length > 2048 || /[\x00-\x1f\x7f]/.test(id)
      || target.identity.kind === 'openid' && value.email_verified !== true) throw refused('Google did not return a verifiable API account. Its access remains protected.');
    return { status: 'known' as const, account_id: id, email };
  };
  const appCredentials = (app: SavedOAuthApp) => {
    const current = deps.apps.getApp('google', app.id); const secret = deps.apps.getClientSecret('google', app.id);
    if (!current || current.client_id !== app.client_id || !secret) throw changed(); return { current, secret };
  };
  return { http: http as HttpFetcher, assertCurrent,
    grantKeys: (data: OAuthPermissionCleanupData) => union(...(data.api_connections ?? []).map(t => [t.grant_key])),
    updateVerificationUrls(data: OAuthPermissionCleanupData, urls?: readonly { name: string; url: string }[]) {
      if (urls === undefined) return;
      if (!Array.isArray(urls) || urls.length > 16 || urls.some(v => !v || typeof v.name !== 'string' || typeof v.url !== 'string')
        || new Set(urls.map(v => v.name)).size !== urls.length) throw new RpcError('bad_request', 'Choose one protected read URL per API connection.');
      for (const value of urls) {
        const target = data.api_connections?.find(t => t.row.name === value.name);
        const url = target ? readUrl(target.base_url, value.url) : undefined;
        if (!target || !url) throw new RpcError('bad_request', 'Choose a protected read URL within the saved API service.');
        target.verification_url = url;
        data.public.targets = data.public.targets.map(t => t.platform === 'api' && t.slug === value.name ? { ...t, verification_url: url } : t);
      }
    },
    refreshCredentials(data: OAuthPermissionCleanupData, app: SavedOAuthApp) {
      const { secret } = appCredentials(app);
      for (const target of data.api_connections ?? []) {
        if (target.auth.client_id !== app.client_id) throw changed();
        const origin = target.auth.saved_oauth_app; const saved = origin ? deps.apps.getApp(origin.issuer, origin.id) : undefined;
        if (saved && (saved.issuer !== 'google' || saved.client_id !== app.client_id || deps.apps.getClientSecret('google', saved.id) !== secret)) throw changed();
        // The explicit review refresh adopts the current saved app. Paused row
        // material stays pinned until the next fresh consent and atomic apply.
        target.auth = { ...target.auth, client_secret: secret };
      }
    },
    signature(targets: readonly OAuthPermissionCleanupApiConnection[], app: SavedOAuthApp) {
      const { secret } = appCredentials(app);
      return targets.map(target => {
        if (target.auth.client_id !== app.client_id || target.auth.client_secret !== secret || target.auth.token_endpoint !== GOOGLE_TOKEN_URL) {
          throw new RpcError('bad_request', 'Coordinate the saved Google app and its API credential copies before cleanup.');
        }
        const origin = target.auth.saved_oauth_app;
        const saved = origin ? deps.apps.getApp(origin.issuer, origin.id) : undefined;
        if (saved && (saved.issuer !== 'google' || saved.client_id !== app.client_id || deps.apps.getClientSecret(saved.issuer, saved.id) !== secret)) throw changed();
        return [target.row.name, target.auth.client_id, target.auth.client_secret, saved];
      });
    },
    async readTargets(groups: readonly OAuthPermissionGroup[], selectedScopes: readonly string[], urls: readonly { name: string; url: string }[] = []) {
      if (!deps.connections.replacePermissionCleanupAuth || !deps.connections.withCredentialLease) throw new RpcError('not_configured', 'Update this server to recover API credentials during cleanup.');
      if (!Array.isArray(urls) || urls.length > 16
        || urls.some(v => !v || typeof v.name !== 'string' || typeof v.url !== 'string' || !groups.some(g => g.connection_names.includes(v.name)))
        || new Set(urls.map(v => v.name)).size !== urls.length) {
        throw new RpcError('bad_request', 'Choose one protected read URL for each affected API connection.');
      }
      const kept = union(...groups.map(g => [...g.scopes.filter(s => s.evidence === 'recorded_grant' && !selectedScopes.includes(s.scope)).map(s => s.scope), ...g.required_scopes]));
      const rows: OAuthPermissionCleanupApiConnection[] = []; const targets: OAuthPermissionCleanupTarget[] = [];
      for (const group of groups) for (const name of group.connection_names) {
        const original = deps.connections.get('api', name); if (!original || deps.connections.permissionCleanupId?.(name)) throw changed();
        if (deps.connections.getPendingCredentialRotationAttempt?.('api', name)) throw changed();
        const initial = await decode(original);
        if (initial.type !== 'oauth2_refresh' || initial.permission_cleanup_pending || initial.token_endpoint !== GOOGLE_TOKEN_URL) throw changed();
        await fresh(original, initial);
        const row = deps.connections.get('api', name); if (!row || row.pk !== original.pk || row.enrolled_at !== original.enrolled_at || row.config_json !== original.config_json) throw changed();
        const auth = await decode(row); if (auth.type !== 'oauth2_refresh' || auth.client_id !== group.client_id || auth.permission_cleanup_pending
          || !auth.current_access_token || auth.expires_at === undefined || auth.expires_at <= deps.now() + 30_000) throw changed();
        const config = JSON.parse(row.config_json) as { base_url?: string };
        if (typeof config.base_url !== 'string' || !service(config.base_url)) throw new RpcError('bad_request', 'This Google API service has no supported cleanup recovery check. Keep its permissions protected.');
        const raw = urls.find(v => v.name === name)?.url ?? managedOAuthDefaultVerificationUrl(config.base_url);
        const verification_url = readUrl(config.base_url, raw);
        if (!verification_url) throw new RpcError('bad_request', 'Choose a protected read URL for ' + row.display_name + '. For Sheets, paste a private spreadsheet URL.');
        const granted = JSON.parse(row.granted_scopes_json ?? 'null') as string[] | null; if (!Array.isArray(granted)) throw changed();
        const target: OAuthPermissionCleanupApiConnection = { row, auth, group_id: group.id, base_url: config.base_url,
          grant_key: 'api.cleanup-' + group.id.slice(0, 40), identity: identityMethod(granted, kept), verification_url, required_scopes: [...group.required_scopes] };
        const identity = await readIdentity(target, auth.current_access_token);
        await verifyDirectOAuthAccess({ fetchImpl, now: deps.now }, auth, verification_url);
        rows.push(target); targets.push({ platform: 'api', slug: name, provider: 'google_api', display_name: row.display_name, verification_url, account: identity });
      }
      // A shared family can have several local copies, but never several owners or refresh grants.
      for (const target of rows) if (rows.some(other => other.grant_key === target.grant_key
        && (other.auth.refresh_token !== target.auth.refresh_token || targets[rows.indexOf(other)]!.account.email !== targets[rows.indexOf(target)]!.account.email))) throw changed();
      return { rows, targets };
    },
    readIdentity,
    async verify(data: OAuthPermissionCleanupData, key: string, values: Record<string, string | null>) {
      for (const target of data.api_connections ?? []) {
        if (target.grant_key !== key) continue;
        const token = values[key + '.access_token']; if (!token) throw changed();
        const expected = data.public.targets.find(t => t.platform === 'api' && t.slug === target.row.name)?.account;
        const identity = await readIdentity(target, token);
        if (!expected || expected.account_id !== identity.account_id || expected.email?.toLowerCase() !== identity.email) {
          throw refused('The new API sign-in belongs to a different or unconfirmed Google account. Saved connections and bindings were kept.');
        }
        await verifyDirectOAuthAccess({ fetchImpl, now: deps.now }, { ...target.auth, current_access_token: token, expires_at: Number(values[key + '.expires_at']) }, target.verification_url);
      }
    },
    async replace(data: OAuthPermissionCleanupData, phase: 'pause' | 'apply', commit: () => void, beforeCommit?: () => Promise<(() => void) | void>) {
      const targets = data.api_connections ?? []; if (!targets.length) { commit(); return; }
      assertCurrent(data);
      const updates = await Promise.all(targets.map(async target => {
        const candidate = data.candidates?.[target.grant_key]; const values = candidate?.values;
        if (phase === 'apply' && !values) throw changed();
        const next: DirectOAuthAuth = phase === 'pause' ? { ...target.auth, permission_cleanup_pending: data.public.id,
          current_access_token: undefined, refresh_token: '', expires_at: undefined } : { ...target.auth,
          current_access_token: values![target.grant_key + '.access_token']!, refresh_token: values![target.grant_key + '.refresh_token']!,
          expires_at: Number(values![target.grant_key + '.expires_at']),
          required_scopes: union(target.required_scopes, (target.auth.required_scopes ?? []).filter(s => data.public.mode === 'restore' || !data.public.selected_scopes.includes(s))) };
        return { previous: target.row, auth_ciphertext: await encodeAuthForStorage(next, target.row, deps.key), updated_at: deps.now(),
          granted_scopes_json: phase === 'pause' ? target.row.granted_scopes_json! : JSON.stringify((values![target.grant_key + '.granted_scopes'] ?? '').split(/\s+/).filter(Boolean)) };
      }));
      const check = await beforeCommit?.();
      assertCurrent(data);
      check?.();
      deps.connections.replacePermissionCleanupAuth!(updates, data.public.id, phase, () => {
        data.api_connections = targets.map(target => ({ ...target, row: deps.connections.get('api', target.row.name)! }));
        commit();
      });
    },
    withLease<T>(data: OAuthPermissionCleanupData, run: () => Promise<T>): Promise<T> {
      const names = (data.api_connections ?? []).map(t => t.row.name);
      return names.length ? deps.connections.withCredentialLease!(names, run) : run();
    },
  };
};
