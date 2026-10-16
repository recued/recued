/** D-322 §44 — owner-guided Google reset, followed by verified native replacement. */
import { createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { GOOGLE_TOKEN_URL, RpcError, UNECHOED_AUTHORIZATION_SCOPES, type OAuthAppsResponse,
  type OAuthPermissionCleanupJob, type OAuthPermissionCleanupRequest, type OAuthPermissionCleanupTarget,
  type OAuthPermissionInventory, type OAuthPermissionGroup, type SavedOAuthApp } from '@recued/contracts';
import type { OAuthAppConfigStore } from './oauth-app-config-store.js';
import type { ServerAccountStore, AccountStoreWrite } from './account-store.js';
import type { CollectionInstanceRecord, CollectionInstanceStore } from './collections/instance-store.js';
import type { MailEnrollDeps } from './collections/mail/enroll.js';
import type { CalendarEnrollDeps } from './collections/calendar/enroll.js';
import { defaultHttpFetcher, exchangeCodeForTokens, getAccessToken, keyPrefix, type HttpFetcher } from './collections/mail/oauth.js';
import { collectionProvider, readCollectionIdentity, matchingCollectionAccount, verifyCollectionReads, collectionIdentityUrl } from './collection-authentication-checks.js';
import { collectionOAuthBinding, collectionOAuthSourceName } from './collection-oauth-sources.js';
import { collectionAuthenticationLocks } from './collection-authentication-locks.js';
import { oauthPermissionScopeCovers, type OAuthPermissionService } from './oauth-permission-consolidation.js';
import { createOAuthPermissionCleanupStore, permissionCleanupFinished, type OAuthPermissionCleanupData } from './oauth-permission-cleanup-store.js';
import { createOAuthPermissionCleanupApi } from './oauth-permission-cleanup-api.js';
import type { ConnectionStoreSqlite } from './storage/connection-store.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonce = () => randomBytes(32).toString('base64url');
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const union = (...values: readonly (readonly string[])[]) => [...new Set(values.flat())].sort();
const rowKey = (row: { platform: string; slug: string }) => row.platform + ':' + row.slug;
const grantSlug = (row: CollectionInstanceRecord) => typeof row.config.account_slug === 'string' ? row.config.account_slug : row.slug;
const prefix = (row: CollectionInstanceRecord) => keyPrefix(collectionProvider(row), grantSlug(row));
const material = (row: CollectionInstanceRecord) => hash([row.platform, row.slug, row.created_at, row.adapter_type, row.config, row.caps]);
const dependency = (inv: OAuthPermissionInventory) => hash([inv.groups.filter(g => g.issuer === 'google'), inv.unavailable]);
const covers = (grants: readonly string[], needs: readonly string[]) => needs.every(need => UNECHOED_AUTHORIZATION_SCOPES.has(need)
  || grants.some(grant => oauthPermissionScopeCovers('google', 'https://sheets.googleapis.com', grant, need)));
const changed = () => new RpcError('conflict', 'The account or its local permissions changed. Refresh this cleanup before continuing, or restore access without removing permissions.');
const failure = (message: string) => new RpcError('credential_verification_failed', message, 422);

export interface OAuthPermissionCleanupService {
  list(): OAuthPermissionCleanupJob[];
  handle(request: OAuthPermissionCleanupRequest): Promise<Omit<OAuthAppsResponse, 'apps'>>;
}
export const createOAuthPermissionCleanupService = (deps: {
  db: Database.Database; instances: CollectionInstanceStore; apps: OAuthAppConfigStore; permissions: OAuthPermissionService;
  accountStore: ServerAccountStore; mail: MailEnrollDeps; calendar: CalendarEnrollDeps; key(): Uint8Array | null;
  now?(): number; anonymous?: HttpFetcher;
  connections?: ConnectionStoreSqlite; connectionKey?: () => Uint8Array | null; apiFetch?: typeof fetch;
}): OAuthPermissionCleanupService => {
  const now = deps.now ?? Date.now; const store = createOAuthPermissionCleanupStore(deps.db, deps.key, now);
  const api = deps.connections ? createOAuthPermissionCleanupApi({ connections: deps.connections, apps: deps.apps,
    key: deps.connectionKey, now, fetchImpl: deps.apiFetch }) : undefined;
  const grantKeys = (data: OAuthPermissionCleanupData) => union(Object.keys(data.generations), api?.grantKeys(data) ?? []);
  const grantKey = (data: OAuthPermissionCleanupData, row: CollectionInstanceRecord) => {
    const source = collectionOAuthSourceName(row.config);
    if (source) { const target = data.api_connections?.find(t => t.row.name === source); if (!target) throw changed(); return target.grant_key; }
    return prefix(row);
  };
  deps.db.exec(`CREATE TABLE IF NOT EXISTS collection_authentication_identities (
    platform TEXT NOT NULL, slug TEXT NOT NULL, created_at INTEGER NOT NULL, binding_hash TEXT NOT NULL,
    identity_json TEXT NOT NULL, PRIMARY KEY(platform, slug))`);
  const active = collectionAuthenticationLocks(deps.db); const busy = new Set<string>();
  const lane = (row: CollectionInstanceRecord) => row.platform === 'mail' ? deps.mail : deps.calendar;
  const http = (row: CollectionInstanceRecord) => lane(row).fetcher ?? defaultHttpFetcher;
  const bearer = (row: CollectionInstanceRecord, token: string): HttpFetcher => (url, init) => http(row)(url, {
    ...init, headers: { ...init?.headers, Authorization: 'Bearer ' + token } });
  const inventory = async () => {
    const result = await deps.permissions.handle({ action: 'permission_inventory' });
    if (!result.permission_inventory) throw changed(); return result.permission_inventory;
  };
  const supportedGroups = (inv: OAuthPermissionInventory, appKey: string) => {
    const groups = inv.groups.filter(g => g.issuer === 'google');
    if (inv.unavailable.length || groups.some(g => g.authentication !== 'direct_oauth' || g.app_key !== appKey
      || g.connection_names.length > 0 && !api || !g.connection_names.length && !g.native_accounts.length || !g.requirements_complete || !g.grants_known
      || g.uses.some(use => use.kind === 'file'))) {
      throw new RpcError('bad_request', 'Other Google apps, brokers or file sources need a verified recovery path before this combined consent can be reset. Keep this cleanup as a preview.');
    }
    return groups;
  };
  const appFor = (row: CollectionInstanceRecord): SavedOAuthApp => {
    const id = typeof row.config.oauth_app_id === 'string' ? row.config.oauth_app_id : 'default';
    const app = deps.apps.getApp('google', id); if (!app?.has_secret) throw new RpcError('not_configured', 'Restore this saved Google OAuth app before continuing.');
    return app;
  };
  const config = (row: CollectionInstanceRecord, app: SavedOAuthApp) => {
    const cfg = row.platform === 'mail' ? deps.mail.oauthConfig?.('gmail', app.id) : deps.calendar.oauthConfig?.('gcal', app.id);
    if (!cfg?.clientSecret || cfg.clientId !== app.client_id || cfg.tokenUrl !== GOOGLE_TOKEN_URL) throw new RpcError('not_configured', 'Check the saved Google OAuth app credentials in Apps & APIs.');
    return cfg;
  };
  const appConfig = (app: SavedOAuthApp) => {
    const clientSecret = deps.apps.getClientSecret('google', app.id);
    if (!clientSecret || deps.apps.getApp('google', app.id)?.client_id !== app.client_id) throw changed();
    return { clientId: app.client_id, clientSecret, tokenUrl: GOOGLE_TOKEN_URL };
  };
  const appSignature = (data: OAuthPermissionCleanupData) => hash([data.public.app, appConfig(data.public.app)]);
  const credentialSignature = (rows: readonly CollectionInstanceRecord[], app: SavedOAuthApp, apis: OAuthPermissionCleanupData['api_connections'] = []) => {
    const selected = appConfig(app);
    const copies = rows.filter(row => collectionOAuthBinding(row.config) === undefined).map(row => { const saved = appFor(row); const current = config(row, saved);
      if (current.clientId !== selected.clientId || current.clientSecret !== selected.clientSecret) {
        throw new RpcError('bad_request', 'These saved copies of the Google app use different credentials. Coordinate their secrets before guided cleanup.');
      }
      return [saved, current]; });
    return apis.length ? hash([copies, api?.signature(apis, app) ?? []]) : hash(copies);
  };
  const identityBinding = (row: CollectionInstanceRecord) => hash([row.adapter_type, row.config.account_slug ?? row.slug, collectionOAuthBinding(row.config) ?? 'original_native']);
  const rememberIdentity = (row: CollectionInstanceRecord, identity: OAuthPermissionCleanupTarget['account']) => {
    const saved = deps.db.prepare<[string, string], { created_at: number; binding_hash: string; identity_json: string }>(
      'SELECT created_at, binding_hash, identity_json FROM collection_authentication_identities WHERE platform = ? AND slug = ?').get(row.platform, row.slug);
    if (saved && saved.created_at === row.created_at && saved.binding_hash === identityBinding(row)
      && !matchingCollectionAccount(JSON.parse(saved.identity_json) as OAuthPermissionCleanupTarget['account'], identity)) throw changed();
    deps.db.prepare('INSERT OR REPLACE INTO collection_authentication_identities VALUES (?, ?, ?, ?, ?)')
      .run(row.platform, row.slug, row.created_at, identityBinding(row), JSON.stringify(identity));
  };
  const currentRows = (data: OAuthPermissionCleanupData): CollectionInstanceRecord[] => data.rows.map(row => {
    const live = deps.instances.get(row.platform, row.slug);
    if (!live || material(live) !== material(row)) throw changed(); return live;
  });
  const assertMembership = (data: OAuthPermissionCleanupData, inv: OAuthPermissionInventory) => {
    const groups = inv.groups.filter(g => data.group_ids.includes(g.id));
    const names = union(...groups.map(g => g.connection_names));
    const expectedNames = (data.api_connections ?? []).map(t => t.row.name).sort();
    const collections = union(groups.flatMap(g => g.native_accounts).map(rowKey), deps.instances.list()
      .filter(row => ['mail', 'calendar'].includes(row.platform) && names.includes(collectionOAuthSourceName(row.config) ?? '')).map(rowKey));
    if (hash(names) !== hash(expectedNames) || hash(collections) !== hash(data.rows.map(rowKey).sort())) {
      throw new RpcError('conflict', 'This sign-in gained or lost a local credential copy or collection. Review those uses before resuming this cleanup.');
    }
  };
  const assertCurrent = async (data: OAuthPermissionCleanupData) => {
    currentRows(data);
    api?.assertCurrent(data);
    const inv = await inventory(); assertMembership(data, inv);
    if (deps.apps.getApp('google', data.public.app.id)?.revision !== data.public.app.revision
      || credentialSignature(data.rows, data.public.app, data.api_connections) !== data.credentials_signature
      || dependency(inv) !== data.dependency) throw changed();
    for (const [key, expected] of Object.entries(data.generations)) {
      if (await deps.accountStore.get(key + '.grant_generation') !== expected
        || await deps.accountStore.get(key + '.granted_scopes') !== data.original_scopes[key]
        || hash(await deps.accountStore.get(key + '.refresh_token')) !== data.source_tokens[key]
        || await deps.accountStore.get(key + '.permission_cleanup_pending') !== (data.public.status === 'prepared' ? null : data.public.id)) throw changed();
    }
  };
  const beforeApiCommit = async (data: OAuthPermissionCleanupData) => {
    await assertCurrent(data); const expected = deps.permissions.signature?.();
    return () => { if (deps.permissions.signature?.() !== expected) throw changed(); };
  };
  const readTargets = async (groups: readonly OAuthPermissionGroup[], selected: string, selectedScopes: readonly string[], urls?: readonly { name: string; url: string }[]) => {
    const rows: CollectionInstanceRecord[] = []; const targets: OAuthPermissionCleanupTarget[] = [];
    const byGroup = new Map<string, string[]>(); const proofs: Record<string, { token: string; generation: string | null }> = {};
    const apis = groups.some(g => g.connection_names.length) ? await api!.readTargets(groups, selectedScopes, urls) : { rows: [], targets: [] };
    for (const group of groups) {
      const addresses: string[] = [];
      for (const ref of group.native_accounts) {
        const row = deps.instances.get(ref.platform, ref.slug);
        if (!row || !['gmail', 'gcal'].includes(row.adapter_type) || collectionOAuthBinding(row.config) !== undefined || active.has(rowKey(row))) throw changed();
        const app = appFor(row); const token = await getAccessToken({ provider: collectionProvider(row), slug: grantSlug(row),
          providerConfig: config(row, app), accountStore: deps.accountStore, fetcher: http(row), now });
        const key = prefix(row); const source = hash(await deps.accountStore.get(key + '.refresh_token'));
        const generation = await deps.accountStore.get(key + '.grant_generation');
        const identity = await readCollectionIdentity(row, bearer(row, token));
        if (source !== hash(await deps.accountStore.get(key + '.refresh_token')) || generation !== await deps.accountStore.get(key + '.grant_generation')) throw changed();
        proofs[key] = { token: source, generation };
        if (identity.status !== 'known' || !identity.account_id || !identity.email) throw failure('The current Google account could not be verified without extra permissions. Reconnect it before cleanup.');
        if (typeof row.config.account_email === 'string' && row.config.account_email.toLowerCase() !== identity.email.toLowerCase()) throw changed();
        rememberIdentity(row, identity);
        addresses.push(identity.email.toLowerCase()); rows.push(row);
        targets.push({ platform: ref.platform, slug: ref.slug, provider: row.adapter_type as 'gmail' | 'gcal', account: identity });
      }
      for (const name of group.connection_names) {
        const target = apis.targets.find(t => t.slug === name)!; const credential = apis.rows.find(t => t.row.name === name)!;
        addresses.push(target.account.email!.toLowerCase());
        for (const row of deps.instances.list().filter(r => ['mail', 'calendar'].includes(r.platform) && collectionOAuthSourceName(r.config) === name)) {
          if (!['gmail', 'gcal'].includes(row.adapter_type) || active.has(rowKey(row))) throw changed();
          const identity = await readCollectionIdentity(row, bearer(row, credential.auth.current_access_token!));
          if (identity.status !== 'known' || !identity.email || identity.email.toLowerCase() !== target.account.email!.toLowerCase()) throw changed();
          rememberIdentity(row, identity); rows.push(row);
          targets.push({ platform: row.platform as 'mail' | 'calendar', slug: row.slug, provider: row.adapter_type as 'gmail' | 'gcal', account: identity });
        }
      }
      if (!addresses.length || new Set(addresses).size !== 1) throw changed(); byGroup.set(group.id, addresses);
    }
    const address = byGroup.get(selected)?.[0]; if (!address) throw changed();
    const selectedApis = apis.rows.filter((_, i) => apis.targets[i]!.account.email!.toLowerCase() === address);
    return { rows: rows.filter((_, i) => targets[i]!.account.email!.toLowerCase() === address),
      targets: [...targets.filter(t => t.account.email!.toLowerCase() === address), ...apis.targets.filter(t => t.account.email!.toLowerCase() === address)],
      api_connections: selectedApis,
      group_ids: [...byGroup].filter(([, emails]) => emails[0] === address).map(([id]) => id), proofs };
  };
  const prepare = async (request: Extract<OAuthPermissionCleanupRequest, { action: 'prepare_permission_cleanup' }>) => {
    if (!deps.accountStore.transactionalWrite) throw new RpcError('not_configured', 'Update the server to clean up permissions safely.');
    await deps.permissions.handle({ ...request, action: 'preview_permission_cleanup' });
    const inv = await inventory(); const selected = inv.groups.find(g => g.id === request.group_id);
    if (!selected || selected.issuer !== 'google' || selected.authentication !== 'direct_oauth' || !selected.native_accounts.length && !selected.connection_names.length) {
      throw new RpcError('bad_request', 'Choose Recued direct Google OAuth for guided cleanup. Use vendor access review for brokers.');
    }
    const groups = supportedGroups(inv, selected.app_key);
    const resolved = await readTargets(groups, selected.id, request.selected_scopes, request.api_verification_urls);
    if (resolved.targets.length > 16) throw new RpcError('bad_request', 'Review at most 16 shared Google accounts and API connections at a time.');
    const fresh = await inventory(); const targetGroups = fresh.groups.filter(g => resolved.group_ids.includes(g.id));
    const reviewed_groups = supportedGroups(fresh, selected.app_key).map(g => g.id).sort();
    if (hash(reviewed_groups) !== hash(groups.map(g => g.id).sort())) throw changed();
    if (request.selected_scopes.some(s => !fresh.groups.find(g => g.id === selected.id)?.scopes.some(value => value.scope === s && value.status === 'unused_locally'))) throw changed();
    const required = union(...targetGroups.map(g => g.required_scopes));
    const retained = union(...targetGroups.map(g => g.scopes.filter(s => s.evidence === 'recorded_grant').map(s => s.scope))).filter(s => !request.selected_scopes.includes(s));
    if (request.selected_scopes.some(s => retained.some(keep => oauthPermissionScopeCovers('google', 'https://sheets.googleapis.com', keep, s)))) {
      throw new RpcError('bad_request', 'A permission you are keeping still grants the selected access. Review the broader permission before cleanup.');
    }
    const generations: Record<string, string | null> = {}; const original_scopes: Record<string, string> = {}; const source_tokens: Record<string, string> = {};
    for (const row of resolved.rows.filter(row => collectionOAuthBinding(row.config) === undefined)) { const key = prefix(row); generations[key] = resolved.proofs[key]!.generation;
      original_scopes[key] = await deps.accountStore.get(key + '.granted_scopes') ?? ''; source_tokens[key] = resolved.proofs[key]!.token; }
    for (const connection of resolved.api_connections) original_scopes[connection.grant_key] = union(
      (original_scopes[connection.grant_key] ?? '').split(/\s+/).filter(Boolean), JSON.parse(connection.row.granted_scopes_json!) as string[]).join(' ');
    const selectedApp = (selected.saved_app_id ? deps.apps.getApp('google', selected.saved_app_id) : undefined)
      ?? deps.apps.listApps('google').find(app => app.client_id === selected.client_id && app.has_secret);
    if (!selectedApp?.has_secret || selectedApp.client_id !== selected.client_id) throw new RpcError('not_configured', 'Save this Google OAuth app in Apps & APIs before starting guided cleanup.');
    const data: OAuthPermissionCleanupData = { rows: resolved.rows, group_ids: resolved.group_ids, reviewed_groups, dependency: dependency(fresh), generations, original_scopes, source_tokens,
      ...(resolved.api_connections.length ? { api_connections: resolved.api_connections } : {}),
      credentials_signature: credentialSignature(resolved.rows, selectedApp, resolved.api_connections),
      public: { id: nonce(), revision: 0, issuer: 'google', mode: 'cleanup', status: 'prepared', app: selectedApp, targets: resolved.targets,
        selected_scopes: [...request.selected_scopes].sort(), requested_scopes: union(retained, required), required_scopes: required,
        reset_confirmation: 'not_confirmed', verification: 'not_checked', updated_at: now() } };
    await assertCurrent(data); store.create(data, grantKeys(data)); return data.public;
  };
  const persistPause = async (data: OAuthPermissionCleanupData, rows: readonly CollectionInstanceRecord[]) => {
    const currentTokens: Record<string, string | null> = {};
    for (const key of Object.keys(data.generations)) {
      currentTokens[key] = await deps.accountStore.get(key + '.refresh_token'); if (hash(currentTokens[key]) !== data.source_tokens[key]) throw changed();
    }
    const nextGenerations: Record<string, string | null> = {};
    const writes: AccountStoreWrite[] = Object.entries(data.generations).flatMap(([key, expected]) => {
      const next = nonce(); nextGenerations[key] = next;
      return [{ key: key + '.grant_generation', value: next, expected }, { key: key + '.permission_cleanup_pending', value: data.public.id, expected: null },
        { key: key + '.refresh_token', value: currentTokens[key] ?? null, expected: currentTokens[key] ?? null }];
    });
    const commit = () => deps.accountStore.transactionalWrite!(writes, () => {
      currentRows(data); if (credentialSignature(data.rows, data.public.app, data.api_connections) !== data.credentials_signature) throw changed();
      data.generations = nextGenerations;
      data.public.status = 'stopping'; store.write(data, data.public.revision);
      for (const row of rows) deps.instances.updateAuthState(row.platform, row.slug, { auth_state: 'expired' });
    });
    if (api) await api.replace(data, 'pause', commit, () => beforeApiCommit(data)); else commit();
  };
  const pause = async (data: OAuthPermissionCleanupData) => {
    if (data.public.status !== 'prepared' && data.public.status !== 'stopping') throw changed();
    await assertCurrent(data); const rows = currentRows(data);
    if (rows.some(r => !lane(r).authenticationChange)) throw new RpcError('not_configured', 'This server cannot pause all affected collections safely.');
    let committed = data.public.status === 'stopping';
    if (!committed && rows.some(row => active.has(rowKey(row)))) throw changed();
    // Reserve before any more awaits: a deletion must not start its shutdown in this gap.
    rows.forEach(row => active.add(rowKey(row)));
    try {
      if (!committed) { await (api ? api.withLease(data, () => persistPause(data, rows)) : persistPause(data, rows)); committed = true; }
      for (const row of rows) await lane(row).authenticationChange!.stop(row.slug);
      data.public.status = data.public.mode === 'restore' ? 'awaiting_reconnect' : 'awaiting_reset';
      delete data.public.last_error; store.write(data, data.public.revision); return data.public;
    } finally { if (!committed) rows.forEach(row => active.delete(rowKey(row))); }
  };
  const authorize = async (data: OAuthPermissionCleanupData, reset: boolean) => {
    if (!['awaiting_reset', 'awaiting_reconnect', 'ready_to_apply'].includes(data.public.status)) throw changed();
    await assertCurrent(data);
    if (data.public.mode === 'cleanup' && reset !== true) throw new RpcError('bad_request', 'Remove the app access on Google and explicitly confirm that step before reconnecting.');
    data.public.reset_confirmation = data.public.mode === 'cleanup' ? 'owner_confirmed' : data.public.reset_confirmation;
    data.public.status = 'awaiting_reconnect'; data.public.verification = 'not_checked';
    if (Object.keys(data.candidates ?? {}).length === grantKeys(data).length) {
      delete data.candidates; delete data.public.verified_targets;
    }
    delete data.public.granted_scopes; delete data.public.review_expires_at; delete data.public.last_error;
    const key = grantKeys(data).find(value => !data.candidates?.[value]); if (!key) throw changed();
    const connection = data.api_connections?.find(target => target.grant_key === key);
    const row = data.rows.find(value => grantKey(data, value) === key);
    const target = connection ? { platform: 'api' as const, slug: connection.row.name, provider: 'google_api' as const }
      : row ? { platform: row.platform as 'mail' | 'calendar', slug: row.slug, provider: row.adapter_type as 'gmail' | 'gcal' } : undefined;
    if (!target) throw changed();
    data.authorization = { id: nonce(), expires_at: now() + 10 * 60_000, app_signature: appSignature(data), grant_key: key }; store.write(data, data.public.revision);
    return { id: data.authorization.id, job_id: data.public.id, revision: data.public.revision, expires_at: data.authorization.expires_at,
      app: data.public.app, requested_scopes: data.public.requested_scopes,
      target };
  };
  const verify = async (data: OAuthPermissionCleanupData, key: string, values: Record<string, string | null>) => {
    await assertCurrent(data); const token = values[key + '.access_token'];
    const expires = Number(values[key + '.expires_at']); const grants = (values[key + '.granted_scopes'] ?? '').split(/\s+/).filter(Boolean);
    if (!token || !Number.isFinite(expires) || expires - now() <= 30_000 || !grants.length || !covers(grants, data.public.requested_scopes)) {
      throw failure('Google did not report every permission needed by this review. Keep the accounts paused and reconnect again.');
    }
    if (data.public.mode === 'cleanup' && data.public.selected_scopes.some(s => covers(grants, [s]))) {
      throw failure('The new Google grant still includes selected access. Remove the app access on Google, then reconnect again.');
    }
    for (const [i, row] of data.rows.entries()) {
      if (grantKey(data, row) !== key) continue;
      const fetcher = bearer(row, token); const identity = await readCollectionIdentity(row, fetcher);
      if (!matchingCollectionAccount(data.public.targets[i]!.account, identity)) throw failure('The new sign-in belongs to a different or unconfirmed Google account. Existing collection data was kept.');
      await verifyCollectionReads(row, fetcher, grants);
      const control = await (deps.anonymous ?? http(row))(collectionIdentityUrl(row), { method: 'GET' });
      if (control.status !== 401 && control.status !== 403) throw failure('The vendor check did not prove protected account access.');
    }
    await api?.verify(data, key, values);
    await assertCurrent(data); if (expires - now() <= 30_000) throw changed(); return { grants, expires };
  };
  const review = async (data: OAuthPermissionCleanupData, request: Extract<OAuthPermissionCleanupRequest, { action: 'review_permission_cleanup' }>) => {
    const auth = data.authorization;
    if (!auth || auth.id !== request.authorization_id || auth.expires_at <= now() || auth.app_signature !== appSignature(data)) throw changed();
    if (typeof request.code !== 'string' || !request.code || request.code.length > 16_384) throw new RpcError('bad_request', 'Complete a fresh Google sign-in before review.');
    let redirect: URL; try { redirect = new URL(request.redirect_uri); } catch { throw new RpcError('bad_request', 'Choose a valid OAuth callback URL.'); }
    if (redirect.username || redirect.password || redirect.hash || redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname))) throw new RpcError('bad_request', 'Choose a secure OAuth callback URL.');
    await assertCurrent(data); delete data.authorization; store.write(data, data.public.revision);
    const values: Record<string, string | null> = Object.create(null);
    const connection = data.api_connections?.find(target => target.grant_key === auth.grant_key);
    const row = data.rows.find(value => grantKey(data, value) === auth.grant_key);
    if (!connection && !row) throw changed();
    const provider = connection ? 'gmail' : collectionProvider(row!);
    const slug = connection ? auth.grant_key.slice('api.'.length) : grantSlug(row!);
    const exchangeKey = keyPrefix(provider, slug);
    const valueKey = (key: string) => {
      if (!connection) return key;
      if (!key.startsWith(exchangeKey + '.')) throw changed();
      // Reuse Google's token parser without aliasing any real Gmail grant.
      return auth.grant_key + key.slice(exchangeKey.length);
    };
    await exchangeCodeForTokens({ provider, slug, code: request.code, redirectUri: redirect.toString(),
      providerConfig: appConfig(data.public.app), fetcher: connection ? api!.http : http(row!), now,
      beforePersist: () => { if (appSignature(data) !== auth.app_signature) throw changed(); },
      accountStore: { get: async key => values[valueKey(key)] ?? null, set: async (key, value) => { values[valueKey(key)] = value; }, delete: async key => { delete values[valueKey(key)]; } } });
    const { expires } = await verify(data, auth.grant_key, values);
    if (appSignature(data) !== auth.app_signature || auth.expires_at <= now()) throw changed();
    data.candidates ??= {}; data.candidates[auth.grant_key] = { values, expires_at: Math.min(expires - 30_000, auth.expires_at), app_signature: auth.app_signature };
    data.public.verified_targets = data.public.targets.filter(target => {
      const key = target.platform === 'api' ? data.api_connections?.find(value => value.row.name === target.slug)?.grant_key
        : grantKey(data, data.rows.find(value => rowKey(value) === rowKey(target))!);
      return key && data.candidates?.[key];
    }).map(({ platform, slug }) => ({ platform, slug }));
    const complete = grantKeys(data).every(key => data.candidates?.[key]);
    data.public.status = complete ? 'ready_to_apply' : 'awaiting_reconnect'; data.public.verification = complete ? 'fresh_grant_checked' : 'not_checked';
    if (complete) data.public.granted_scopes = union(...Object.entries(data.candidates).map(([key, value]) => (value.values[key + '.granted_scopes'] ?? '').split(/\s+/).filter(Boolean)));
    data.public.review_expires_at = Math.min(...Object.values(data.candidates).map(value => value.expires_at)); store.write(data, data.public.revision); return data.public;
  };
  const restart = async (data: OAuthPermissionCleanupData) => {
    currentRows(data); if (data.rows.some(row => active.has(rowKey(row)))) throw changed();
    const remaining: { platform: 'mail' | 'calendar'; slug: string }[] = [];
    for (const row of data.rows) {
      if (data.public.restart_needed && !data.public.restart_needed.some(t => rowKey(t) === rowKey(row))) continue;
      try {
        if (active.has(rowKey(row))) throw changed(); currentRows(data);
        await lane(row).authenticationChange!.restart(row.slug);
      }
      catch {
        remaining.push({ platform: row.platform as 'mail' | 'calendar', slug: row.slug });
        const live = deps.instances.get(row.platform, row.slug);
        if (live && material(live) === material(row) && !active.has(rowKey(row))) deps.instances.updateAuthState(row.platform, row.slug, { auth_state: 'degraded' });
      }
    }
    if (remaining.length) data.public.restart_needed = remaining; else delete data.public.restart_needed;
    store.write(data, data.public.revision); return data.public;
  };
  const apply = async (data: OAuthPermissionCleanupData) => {
    if (data.public.status === 'applied' || data.public.status === 'restored') return data.public;
    const candidates = data.candidates;
    if (data.public.status !== 'ready_to_apply' || !candidates || grantKeys(data).some(key => !candidates[key]
      || candidates[key].expires_at <= now() || candidates[key].app_signature !== appSignature(data))) throw changed();
    for (const [key, candidate] of Object.entries(candidates)) await verify(data, key, candidate.values);
    const writes: AccountStoreWrite[] = [];
    for (const [key, generation] of Object.entries(data.generations)) {
      const candidate = candidates[key]!;
      for (const name of ['refresh_token', 'access_token', 'expires_at', 'granted_scopes']) writes.push({ key: key + '.' + name, value: candidate.values[key + '.' + name] ?? null,
        ...(name === 'granted_scopes' ? { expected: data.original_scopes[key]! } : {}) });
      writes.push({ key: key + '.grant_generation', value: nonce(), expected: generation }, { key: key + '.permission_cleanup_pending', value: null, expected: data.public.id });
    }
    const commit = () => deps.accountStore.transactionalWrite!(writes, () => {
      currentRows(data); if (credentialSignature(data.rows, data.public.app, data.api_connections) !== data.credentials_signature
        || Object.values(candidates).some(candidate => candidate.expires_at <= now() || candidate.app_signature !== appSignature(data))) throw changed();
      data.public.status = data.public.mode === 'cleanup' ? 'applied' : 'restored';
      data.public.restart_needed = data.rows.map(({ platform, slug }) => ({ platform: platform as 'mail' | 'calendar', slug }));
      delete data.candidates; delete data.authorization; delete data.public.last_error; store.write(data, data.public.revision);
      for (const row of data.rows) deps.instances.updateAuthState(row.platform, row.slug, { auth_state: 'healthy' });
      for (const [i, row] of data.rows.entries()) rememberIdentity(row, data.public.targets[i]!.account);
    });
    if (api) await api.replace(data, 'apply', commit, () => beforeApiCommit(data)); else commit();
    data.rows.forEach(row => active.delete(rowKey(row))); return restart(data);
  };
  const refresh = async (data: OAuthPermissionCleanupData, restore: boolean, urls?: readonly { name: string; url: string }[]) => {
    if (permissionCleanupFinished(data.public.status)) throw changed();
    const restoring = restore || data.public.mode === 'restore';
    // A new dependency review can change folder selections, never the corpus identity or app.
    data.rows = data.rows.map(row => { const live = deps.instances.get(row.platform, row.slug);
      if (!live || live.created_at !== row.created_at || live.adapter_type !== row.adapter_type || grantSlug(live) !== grantSlug(row)
        || JSON.stringify(collectionOAuthBinding(live.config)) !== JSON.stringify(collectionOAuthBinding(row.config))
        || collectionOAuthBinding(live.config) === undefined && appFor(live).client_id !== data.public.app.client_id) throw changed(); return live; });
    api?.assertCurrent(data);
    const inv = await inventory(); const groups = inv.groups.filter(g => data.group_ids.includes(g.id));
    assertMembership(data, inv);
    if (groups.length !== data.group_ids.length || inv.unavailable.length || groups.some(g => !g.requirements_complete || !g.grants_known)) throw changed();
    if (!restoring && data.public.mode === 'cleanup' && hash(supportedGroups(inv, groups[0]!.app_key).map(g => g.id).sort()) !== hash(data.reviewed_groups)) throw changed();
    if (!restoring && data.public.selected_scopes.some(s => groups.some(g => g.scopes.some(v => v.scope === s && v.status !== 'unused_locally')))) throw changed();
    const required = union(...groups.map(g => g.required_scopes));
    const retained = union(...Object.values(data.original_scopes).map(v => v.split(/\s+/).filter(Boolean))).filter(s => restoring || !data.public.selected_scopes.includes(s));
    if (restoring) data.public.mode = 'restore';
    const app = deps.apps.getApp('google', data.public.app.id); if (!app?.has_secret || app.client_id !== data.public.app.client_id) throw changed();
    api?.updateVerificationUrls(data, urls);
    for (const target of data.api_connections ?? []) {
      const group = groups.find(g => g.id === target.group_id); if (!group) throw changed(); target.required_scopes = [...group.required_scopes];
    }
    api?.refreshCredentials(data, app);
    data.public.app = app; data.credentials_signature = credentialSignature(data.rows, app, data.api_connections);
    data.public.required_scopes = required; data.public.requested_scopes = union(required, retained);
    data.dependency = dependency(inv); data.public.verification = 'not_checked';
    if (!['prepared', 'stopping'].includes(data.public.status)) data.public.status = 'awaiting_reconnect';
    delete data.authorization; delete data.candidates; delete data.public.granted_scopes; delete data.public.review_expires_at; delete data.public.verified_targets; delete data.public.last_error;
    await assertCurrent(data); store.write(data, data.public.revision); return data.public;
  };
  return { list: () => store.list(), async handle(request) {
    if (request.action === 'prepare_permission_cleanup') return { action: request.action, permission_cleanup_job: await prepare(request) };
    if (request.action === 'permission_cleanup_status' && request.id === undefined) return { action: request.action, permission_cleanup_jobs: store.list() };
    if (!validId(request.id)) throw new RpcError('bad_request', 'Choose a saved permission cleanup.');
    if (busy.has(request.id)) throw new RpcError('conflict', 'This cleanup is already being checked. Refresh its status before retrying.');
    const data = store.get(request.id);
    if (request.action === 'permission_cleanup_status') return { action: request.action, permission_cleanup_job: data.public };
    if (request.action === 'apply_permission_cleanup' && ['applied', 'restored'].includes(data.public.status)) return { action: request.action, permission_cleanup_job: data.public };
    if (request.expected_revision !== data.public.revision) throw changed();
    busy.add(request.id);
    try {
      let job: OAuthPermissionCleanupJob;
      if (request.action === 'pause_permission_cleanup') {
        if (request.confirm_shared_access !== true) throw new RpcError('bad_request', 'Review and confirm the affected accounts before pausing them.'); job = await pause(data);
      } else if (request.action === 'authorize_permission_cleanup') return { action: request.action, permission_cleanup_job: data.public,
        permission_cleanup_authorization: await authorize(data, request.reset_confirmed) };
      else if (request.action === 'review_permission_cleanup') job = await review(data, request);
      else if (request.action === 'apply_permission_cleanup') job = await (api ? api.withLease(data, () => apply(data)) : apply(data));
      else if (request.action === 'restart_permission_cleanup') {
        if (!['applied', 'restored'].includes(data.public.status)) throw changed();
        job = data.public.restart_needed?.length ? await restart(data) : data.public;
      }
      else if (request.action === 'refresh_permission_cleanup' || request.action === 'restore_permission_cleanup') job = await refresh(data,
        request.action === 'restore_permission_cleanup', request.action === 'refresh_permission_cleanup' ? request.api_verification_urls : undefined);
      else if (request.action === 'reset_permission_cleanup') {
        if (data.public.mode !== 'cleanup' || ['prepared', 'stopping'].includes(data.public.status) || permissionCleanupFinished(data.public.status)) throw changed();
        await assertCurrent(data); delete data.authorization; delete data.candidates; delete data.public.granted_scopes; delete data.public.review_expires_at; delete data.public.verified_targets;
        data.public.status = 'awaiting_reset'; data.public.reset_confirmation = 'not_confirmed'; data.public.verification = 'not_checked'; delete data.public.last_error;
        store.write(data, data.public.revision); job = data.public;
      }
      else if (request.action === 'cancel_permission_cleanup') {
        if (data.public.status !== 'prepared') throw new RpcError('conflict', 'These accounts are already paused. Restore access or finish cleanup before closing the task.');
        data.public.status = 'cancelled'; store.write(data, data.public.revision); job = data.public;
      } else throw new RpcError('bad_request', 'Choose a valid permission cleanup action.');
      return { action: request.action, permission_cleanup_job: job };
    } catch (error) {
      if (['review_permission_cleanup', 'apply_permission_cleanup'].includes(request.action)) {
        const latest = store.get(request.id);
        if (['awaiting_reconnect', 'ready_to_apply'].includes(latest.public.status)) {
          delete latest.candidates; delete latest.authorization; delete latest.public.granted_scopes; delete latest.public.review_expires_at; delete latest.public.verified_targets;
          latest.public.verification = 'not_checked'; latest.public.status = 'awaiting_reconnect';
          latest.public.last_error = error instanceof RpcError ? error.message : 'The fresh Google sign-in could not be verified. Saved collection data was kept.';
          store.write(latest, latest.public.revision);
        }
      }
      if (error instanceof RpcError) throw error;
      throw failure('The cleanup step could not finish. Refresh its saved status before retrying. Account data and sync history were kept.');
    } finally { busy.delete(request.id); }
  } };
};
