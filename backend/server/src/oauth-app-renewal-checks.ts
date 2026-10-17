/** Local grant inventory and explicit, persisted renewal of one saved authorization. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL, savedOAuthAppIssuerForEndpoints, RpcError,
  type ConnectionRow, type DirectOAuthAuth, type OAuthAppRenewalGrant, type OAuthAppRenewalReason, type SavedOAuthApp } from '@recued/contracts';
import { refreshOAuth2 } from '@recued/ingredients';
import type { OAuthAppConfigStore } from './oauth-app-config-store.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';
import type { CollectionInstanceRecord, CollectionInstanceStore } from './collections/instance-store.js';
import { decodeAuthFromStorage, encodeAuthForStorage } from './connection-auth-storage.js';
import { assertPersistedOAuthAccess, persistNativeOAuthRenewal } from './native-oauth-renewal.js';
import { makeBoundedOriginApiFetch, makeBoundedOriginHttpFetcher } from './bounded-origin-http-fetcher.js';
import { refreshAccessToken, keyPrefix, type OAuthAccountStore, type OAuthProvider } from './collections/mail/oauth.js';
import { collectionAuthenticationLocks } from './collection-authentication-locks.js';

const hash = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const changed = () => new RpcError('conflict', 'The saved app or authorization changed. Review renewal again.');
const persistence = () => new RpcError('credential_verification_failed', 'The renewed credential could not be confirmed in saved storage.', 500);
type Api = { row: ConnectionRow; auth: DirectOAuthAuth };
type Group = { public: OAuthAppRenewalGrant; assertSnapshot(): void; api?: Api[]; native?: { rows: CollectionInstanceRecord[]; provider: OAuthProvider; slug: string; generation: string | null; refresh: string | null } };
const native = (row: CollectionInstanceRecord) => ['mail', 'calendar'].includes(row.platform) && ['gmail', 'gcal', 'graph'].includes(row.adapter_type)
  && row.config.oauth_connection === undefined && row.config.managed_oauth === undefined;
const issuer = (row: CollectionInstanceRecord) => row.adapter_type === 'graph' ? 'microsoft' : 'google';
const slug = (row: CollectionInstanceRecord) => typeof row.config.account_slug === 'string' ? row.config.account_slug : row.slug;
const rowMaterial = (row: CollectionInstanceRecord) => [row.platform, row.slug, row.created_at, row.adapter_type, row.config];

export const createOAuthAppRenewalChecks = (deps: {
  db: Database.Database; apps: OAuthAppConfigStore; connections: ConnectionStoreSqlite; instances: CollectionInstanceStore;
  accountStore?: OAuthAccountStore; key?: () => Uint8Array | null; fetchImpl?: typeof fetch; now?(): number;
}) => {
  const now = deps.now ?? Date.now; const store = deps.connections; const locks = collectionAuthenticationLocks(deps.db);
  const guardedFetch = (assertSnapshot: () => void): typeof fetch => (input, init) => {
    assertSnapshot(); return (deps.fetchImpl ?? globalThis.fetch)(input, init);
  };
  const decode = (row: ConnectionRow) => decodeAuthFromStorage(row.auth_ciphertext, row, deps.key);
  const apiMaterial = (rows: readonly ConnectionRow[]) => [...rows].sort((a, b) => a.name.localeCompare(b.name)).map(row => [row.pk,
    row.enrolled_at, row.auth_ciphertext, row.config_json, row.display_name, store.getAuthSourceId?.('api', row.name),
    store.permissionCleanupId?.(row.name), store.getPendingCredentialRotationAttempt?.('api', row.name)]);
  const nativeMaterial = (rows: readonly CollectionInstanceRecord[]) => [...rows].sort((a, b) => (a.platform + a.slug).localeCompare(b.platform + b.slug)).map(rowMaterial);
  const grantMaterial = (values: readonly (string | null | undefined)[]) => [values[0] ?? null,
    values[0] == null ? values[1] ?? null : !!values[1], values[2] ?? null];
  const inventory = async (app: SavedOAuthApp): Promise<{ groups: Group[]; incomplete: boolean }> => {
    if (deps.apps.getApp(app.issuer, app.id)?.revision !== app.revision) throw changed();
    let secret: string | null = null; let readable = true;
    try { if (deps.key && !deps.key()) throw changed(); secret = deps.apps.getClientSecret(app.issuer, app.id); } catch { readable = false; }
    const rows = store.list({ kind: 'api' }); const nativeRows = deps.instances.list().filter(native); let incomplete = false;
    const snapshot = hash([apiMaterial(rows), nativeMaterial(nativeRows)]);
    const assertSnapshot = () => {
      if (deps.apps.getApp(app.issuer, app.id)?.revision !== app.revision
        || hash([apiMaterial(store.list({ kind: 'api' })), nativeMaterial(deps.instances.list().filter(native))]) !== snapshot) throw changed();
      if (readable && deps.key && !deps.key()) throw new RpcError('locked', 'Unlock Recued before verifying token renewal.');
    };
    const decoded = await Promise.all(rows.map(async row => {
      try { const auth = await decode(row); return auth.type === 'oauth2_refresh' ? { row, auth } : undefined; }
      catch { incomplete = true; return undefined; }
    }));
    assertSnapshot();
    const apis = decoded.filter((v): v is Api => v !== undefined); const groups: Group[] = []; const seen = new Set<string>();
    for (const member of apis) {
      const a = member.auth; const origin = a.saved_oauth_app;
      if (!(origin?.issuer === app.issuer && origin.id === app.id) && !(origin === undefined && a.client_id === app.client_id && savedOAuthAppIssuerForEndpoints(a) === app.issuer)) continue;
      const members = apis.filter(other => a.native_credential_id ? other.auth.native_credential_id === a.native_credential_id
        : !other.auth.native_credential_id && other.auth.refresh_token === a.refresh_token && other.auth.client_id === a.client_id && other.auth.token_endpoint === a.token_endpoint);
      members.sort((x, y) => x.row.name.localeCompare(y.row.name));
      const id = hash(['api', a.native_credential_id ?? members.map(m => [m.row.name, m.row.enrolled_at])]); if (seen.has(id)) continue; seen.add(id);
      let reason: OAuthAppRenewalReason | undefined;
      if (!readable || secret === null || !store.withCredentialLease || !store.persistRefreshedAuth) reason = 'unavailable';
      else if (members.some(m => m.auth.permission_cleanup_pending || store.permissionCleanupId?.(m.row.name)
        || store.getPendingCredentialRotationAttempt?.('api', m.row.name))) reason = 'paused';
      else if (members.some(m => m.auth.client_id !== app.client_id || savedOAuthAppIssuerForEndpoints(m.auth) !== app.issuer
        || m.auth.saved_oauth_app && (m.auth.saved_oauth_app.issuer !== app.issuer || m.auth.saved_oauth_app.id !== app.id)
        || m.auth.refresh_token !== a.refresh_token || m.auth.token_endpoint !== a.token_endpoint || m.auth.token_auth_style !== a.token_auth_style)) reason = 'shared_grant_conflict';
      else if (members.some(m => !m.auth.saved_oauth_app)) reason = 'origin_unknown';
      else if (members.some(m => m.auth.client_secret !== secret)) reason = 'secret_mismatch';
      else if (!a.refresh_token) reason = 'missing_grant';
      const revision = hash([app, secret, members.map(m => [m.row.pk, m.row.enrolled_at, m.row.config_json, store.getAuthSourceId?.('api', m.row.name),
        m.auth.native_credential_id, m.auth.client_id, m.auth.client_secret, m.auth.token_endpoint, m.auth.token_auth_style, m.auth.saved_oauth_app,
        store.getAuthSourceId ? undefined : m.auth.refresh_token, store.permissionCleanupId?.(m.row.name), m.auth.permission_cleanup_pending]), reason]);
      groups.push({ public: { id, revision, label: 'API authorization: ' + members.map(m => m.row.display_name).join(', ').slice(0, 1800),
        connections: members.map(m => m.row.name), native_accounts: [], eligible: !reason, ...(reason ? { reason } : {}) }, assertSnapshot, api: members });
    }
    const witnesses = new Map<string, string>();
    for (const row of nativeRows.filter(r => issuer(r) === app.issuer && (r.config.oauth_app_id ?? 'default') === app.id)) {
      const provider = row.adapter_type as OAuthProvider; const grantSlug = slug(row); const prefix = keyPrefix(provider, grantSlug);
      const id = hash(['native', prefix]); if (seen.has(id)) continue; seen.add(id);
      const members = nativeRows.filter(r => r.adapter_type === provider && slug(r) === grantSlug).sort((a, b) => (a.platform + a.slug).localeCompare(b.platform + b.slug));
      const [generation, refresh, paused] = deps.accountStore ? await Promise.all(['.grant_generation', '.refresh_token', '.permission_cleanup_pending'].map(k => deps.accountStore!.get(prefix + k))) : [null, null, null];
      if (deps.accountStore) witnesses.set(prefix, hash(grantMaterial([generation, refresh, paused])));
      let reason: OAuthAppRenewalReason | undefined;
      if (!readable || secret === null || !deps.accountStore?.transactionalWrite || !deps.accountStore.withOAuthGrantLease) reason = 'unavailable';
      else if (paused || members.some(m => locks.has(m.platform + ':' + m.slug))) reason = 'paused';
      else if (members.some(m => (m.config.oauth_app_id ?? 'default') !== app.id)) reason = 'shared_grant_conflict';
      else if (!refresh) reason = 'missing_grant';
      const revision = hash([app, secret, members.map(rowMaterial), generation ?? refresh, paused]);
      groups.push({ public: { id, revision, label: (provider === 'graph' ? 'Microsoft' : provider === 'gmail' ? 'Gmail' : 'Google Calendar') + ' authorization: ' + grantSlug,
        connections: [], native_accounts: members.map(m => ({ platform: m.platform as 'mail' | 'calendar', slug: m.slug })), eligible: !reason, ...(reason ? { reason } : {}) },
        assertSnapshot, native: { rows: members, provider, slug: grantSlug, generation: generation ?? null, refresh: refresh ?? null } });
    }
    await Promise.all([...witnesses].map(async ([prefix, witness]) => {
      const values = await Promise.all(['.grant_generation', '.refresh_token', '.permission_cleanup_pending'].map(k => deps.accountStore!.get(prefix + k)));
      if (hash(grantMaterial(values)) !== witness) throw changed();
    }));
    assertSnapshot();
    groups.sort((a, b) => a.public.id.localeCompare(b.public.id));
    for (const g of groups) if (g.public.connections.length + g.public.native_accounts.length > 256) throw new RpcError('bad_request', 'This authorization has too many local copies to check together.');
    return { groups: groups.slice(0, 32), incomplete: incomplete || groups.length > 32 };
  };
  const current = async (app: SavedOAuthApp, expected: OAuthAppRenewalGrant): Promise<Group> => {
    const group = (await inventory(app)).groups.find(g => g.public.id === expected.id);
    if (!group || group.public.revision !== expected.revision || !group.public.eligible) throw changed(); return group;
  };
  const renew = async (app: SavedOAuthApp, expected: OAuthAppRenewalGrant): Promise<string> => {
    const group = await current(app, expected);
    if (group.api) return store.withCredentialLease!(expected.connections, async () => {
      const live = await current(app, expected); const members = live.api!;
      const apiFetch = makeBoundedOriginApiFetch({ fetchImpl: guardedFetch(live.assertSnapshot), timeoutMs: 15_000, maxResponseBytes: 16_384, redirectPolicy: 'error' });
      const auth = members[0]!.auth; const next = await refreshOAuth2(auth, apiFetch, now);
      if (next.type !== 'oauth2_refresh') throw persistence();
      let failed = false;
      // Successful token rotation must be retained even when the app/config changes
      // during the exchange. CAS preserves any replacement owner's credential.
      if (auth.native_credential_id) {
        try { await persistNativeOAuthRenewal({ store, decode: decodeAuthFromStorage, encode: encodeAuthForStorage, key: deps.key, now }, members[0]!.row, next); }
        catch { failed = true; }
      } else for (const member of members) {
        try { await persistNativeOAuthRenewal({ store, decode: decodeAuthFromStorage, encode: encodeAuthForStorage, key: deps.key, now }, member.row,
          { ...next, saved_oauth_app: member.auth.saved_oauth_app, required_scopes: member.auth.required_scopes }); } catch { failed = true; }
      }
      for (const member of members) {
        try {
          const row = store.get('api', member.row.name); if (!row || row.pk !== member.row.pk || row.enrolled_at !== member.row.enrolled_at || row.config_json !== member.row.config_json) throw changed();
          assertPersistedOAuthAccess(next, await decode(row));
        } catch { failed = true; }
      }
      if (failed) throw persistence();
      return (await current(app, expected)).public.revision;
    });
    const source = group.native!; const accountStore = deps.accountStore!; const prefix = keyPrefix(source.provider, source.slug);
    let renewed = false;
    const config = { tokenUrl: app.issuer === 'google' ? GOOGLE_TOKEN_URL : MICROSOFT_TOKEN_URL, clientId: app.client_id,
      clientSecret: deps.apps.getClientSecret(app.issuer, app.id)! };
    const held: string[] = [];
    let assertTransport = group.assertSnapshot;
    const http = makeBoundedOriginHttpFetcher({ fetchImpl: guardedFetch(() => assertTransport()), timeoutMs: 15_000, maxResponseBytes: 16_384, redirectPolicy: 'error' });
    try {
      const verifiedStore: OAuthAccountStore = { ...accountStore, transactionalWrite(entries, commit) {
        try { accountStore.transactionalWrite!(entries, commit); }
        catch (error) { if (error instanceof Error && error.message === 'oauth_grant_changed') throw error; throw persistence(); }
      } };
      await refreshAccessToken({ provider: source.provider, slug: source.slug, providerConfig: config, accountStore: verifiedStore, fetcher: http, now,
        beforeRefresh: async () => {
          assertTransport = (await current(app, expected)).assertSnapshot;
          for (const row of source.rows) { const key = row.platform + ':' + row.slug; if (locks.has(key)) throw changed(); held.push(key); locks.add(key); }
        },
        afterPersist: async result => {
          renewed = true;
          if (await accountStore.get(prefix + '.grant_generation') !== source.generation) throw changed();
          if (await accountStore.get(prefix + '.access_token') !== result.access_token || Number(await accountStore.get(prefix + '.expires_at')) !== result.expires_at) throw persistence();
        } });
    } catch (error) {
      if (error instanceof Error && error.message === 'oauth_grant_changed') throw changed();
      if (error instanceof RpcError && error.code === 'conflict') throw error;
      if (renewed) throw persistence(); throw error;
    } finally { for (const key of held) locks.delete(key); }
    // Legacy grants without a generation can rotate their identity hash. Accept
    // only our saved renewal, with exactly the same local bindings and saved app.
    const after = (await inventory(app)).groups.find(g => g.public.id === expected.id);
    if (!after || !after.public.eligible || hash(after.public.native_accounts) !== hash(expected.native_accounts)
      || hash(after.native!.rows.map(rowMaterial)) !== hash(source.rows.map(rowMaterial)) || after.native!.generation !== source.generation) throw changed();
    return after.public.revision;
  };
  return { inventory, renew };
};
