import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_TOKEN_URL, isOAuthPermissionCleanupJob, type OAuthPermissionCleanupJob, type OAuthPermissionCleanupRequest,
  resolveBearerAccessToken, type CollectionCaps, type ConnectionAuth, type OAuthPermissionNeeds } from '@recued/contracts';
import { createConnectionApiHandler, createEnsureFreshAuth, injectConnectionApiAuth, refreshOAuth2WithMetadata } from '@recued/ingredients';
import { createServerAccountStore } from '../account-store.js';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createCalendarAdapterRegistry } from '../collections/calendar/adapter-registry.js';
import { createOAuthPermissionService } from '../oauth-permission-consolidation.js';
import { createOAuthPermissionCleanupService } from '../oauth-permission-cleanup.js';
import { createOAuthPermissionCleanupStore } from '../oauth-permission-cleanup-store.js';
import { makeOAuthAppConfigHandlers } from '../oauth-app-config-handler.js';
import { decodeAuthFromStorage, encodeAuthForStorage } from '../connection-auth-storage.js';
import { collectionAuthenticationLocks } from '../collection-authentication-locks.js';
import { decodeCurrentNativeOAuth } from '../native-oauth-renewal.js';
import type { HttpFetcher } from '../collections/mail/oauth.js';

const drive = 'https://www.googleapis.com/auth/drive.readonly'; const sheets = 'https://www.googleapis.com/auth/spreadsheets';
const read = 'https://www.googleapis.com/auth/gmail.readonly'; const owner = 'owner@example.test';
const dbs: Database.Database[] = []; afterEach(() => { dbs.splice(0).forEach(db => db.close()); });
const caps: CollectionCaps = { read: 'yes', write: 'no', delete: 'no', auth: 'oauth', watch: 'poll', mirror: 'required', path_style: 'uri' };
const fixture = async (options: { mail?: boolean; copies?: number; shared?: boolean; boundMail?: boolean } = {}) => {
  const db = new Database(':memory:'); dbs.push(db); const key = () => Buffer.alloc(32, 7);
  let clock = 1000; let targetOwner = owner; let anonymousStatus = 401; let denied = ''; let grants = [drive, ...(options.mail ? [read, 'email'] : [])];
  let originalGrants = [drive, sheets, ...(options.boundMail ? [read] : [])]; let posts = 0;
  let needs: OAuthPermissionNeeds = { complete: true, warnings: [], requirements: [{ scope: drive, uses: [{ kind: 'pack', id: 'drive-pack', label: 'Drive pack' }] }] };
  const instances = createInstanceStore({ db, now: () => clock }); const connections = createConnectionStore(db); const account = createServerAccountStore(db);
  const apps = createOAuthAppConfigStore(db, { getEncryptionKey: key }); apps.setIssuer('google', 'fixture-client', 'fixture-secret');
  const request = vi.fn<typeof fetch>(async (raw, init) => {
    const url = new URL(String(raw)); const authorization = new Headers(init?.headers).get('Authorization');
    if (init?.method === 'POST') {
      expect(url.toString()).toBe(GOOGLE_TOKEN_URL); const body = new URLSearchParams(String(init.body)); posts++;
      const fresh = body.get('grant_type') !== 'refresh_token';
      return Response.json({ access_token: (fresh ? 'candidate-' : 'renewed-') + posts, refresh_token: (fresh ? 'candidate-refresh-' : 'renewed-refresh-') + posts,
        expires_in: 3600, scope: (fresh ? grants : originalGrants).join(' ') });
    }
    if (!authorization) return Response.json({}, { status: anonymousStatus });
    if (denied && url.pathname.includes(denied)) return Response.json({}, { status: 403 });
    const address = authorization.startsWith('Bearer candidate-') ? targetOwner : authorization.includes('other-account') ? 'different@example.test' : owner;
    return Response.json(url.pathname.endsWith('/about') ? { user: { emailAddress: address, permissionId: 'drive-' + address } }
      : url.pathname.endsWith('/profile') ? { emailAddress: address } : url.pathname.endsWith('/messages') ? { messages: [] }
        : url.pathname.includes('/spreadsheets/') ? { spreadsheetId: 'private-sheet' } : { id: 'team' });
  });
  const http: HttpFetcher = (url, init) => request(url, init);
  const config = (_p: string, id?: string) => ({ clientId: apps.getClientId('google', id)!, clientSecret: apps.getClientSecret('google', id)!, tokenUrl: GOOGLE_TOKEN_URL });
  const lifecycle = { stop: vi.fn(async (_s: string) => {}), restart: vi.fn(async (_s: string) => {}) };
  const mail = { instances, accountStore: account, oauthConfig: config, fetcher: http, authenticationChange: lifecycle };
  const calendar = { ...mail, adapters: createCalendarAdapterRegistry() };
  const addApi = async (name: string, patch: Partial<Extract<ConnectionAuth, { type: 'oauth2_refresh' }>> = {}, base = 'https://www.googleapis.com/drive/v3') => {
    const auth = { type: 'oauth2_refresh' as const, client_id: 'fixture-client', client_secret: 'fixture-secret', token_endpoint: GOOGLE_TOKEN_URL,
      refresh_token: options.shared ? 'original-shared-refresh' : 'original-refresh-' + name, current_access_token: 'original-' + name, expires_at: 99999999,
      required_scopes: [drive, sheets], saved_oauth_app: { issuer: 'google' as const, id: 'default' },
      ...(options.shared ? { native_credential_id: 'a'.repeat(43) } : {}), ...patch };
    return connections.upsert({ kind: 'api', name, display_name: name + ' account', enrolled_at: clock, updated_at: clock,
      config_json: JSON.stringify({ base_url: base, vendor: 'google', custom_config: 'keep' }), auth_ciphertext: await encodeAuthForStorage(auth, { kind: 'api', name }, key),
      granted_scopes_json: JSON.stringify(originalGrants), subresource_path: '/keep-this-folder', last_used_at: 800, health_json: '{"status":"unknown"}' });
  };
  await addApi('drive', {}, options.boundMail ? 'https://gmail.googleapis.com/gmail/v1' : 'https://www.googleapis.com/drive/v3');
  for (let i = 1; i < (options.copies ?? 1); i++) await addApi('drive-' + i);
  if (options.mail || options.boundMail) {
    instances.upsert({ platform: 'mail', slug: 'work', adapter_type: 'gmail', caps, auth_state: 'healthy', last_synced_at: 444,
      config: { account_slug: 'work', account_email: owner, label_filter: ['team'], ...(options.boundMail ? { oauth_connection: { type: 'direct_oauth',
        connection_name: 'drive', native_credential_id: 'a'.repeat(43), target_origin: 'https://gmail.googleapis.com' } } : {}) } });
    instances.markBackfillComplete('mail', 'work');
    if (!options.boundMail) for (const [name, value] of Object.entries({ refresh_token: 'native-original-refresh', access_token: 'native-original',
      expires_at: '99999999', granted_scopes: [read, sheets, 'email'].join(' '), history_id: 'keep-mail-history' })) await account.set('gmail.work.' + name, value);
  }
  const permissions = createOAuthPermissionService({ apps, instances, rows: () => connections.list(), accountStore: account, key,
    now: () => clock, connectionUses: () => ({ complete: true, uses: [] }), requirements: () => needs,
    nativeRequirements: () => ({ complete: true, requirements: [], warnings: [] }) });
  const deps = { db, apps, instances, permissions, accountStore: account, mail, calendar, key, connections, connectionKey: key, apiFetch: request, anonymous: http, now: () => clock };
  const service = createOAuthPermissionCleanupService(deps);
  const handlers = makeOAuthAppConfigHandlers({ store: apps, permissions, cleanup: service })!.handlers;
  const call = (r: OAuthPermissionCleanupRequest) => handlers['server.oauthApps'](r, undefined as never);
  const job = async (r: OAuthPermissionCleanupRequest): Promise<OAuthPermissionCleanupJob> => {
    const result = await call(r); if (!isOAuthPermissionCleanupJob(result.permission_cleanup_job)) throw Error('Missing job'); return result.permission_cleanup_job;
  };
  const prepare = async (urls?: { name: string; url: string }[]) => {
    const inventory = (await permissions.handle({ action: 'permission_inventory' })).permission_inventory!;
    return job({ action: 'prepare_permission_cleanup', inventory_fingerprint: inventory.fingerprint,
      group_id: inventory.groups.find(g => g.connection_names.includes('drive'))!.id, selected_scopes: [sheets], ...(urls !== undefined ? { api_verification_urls: urls } : {}) });
  };
  const pause = async (value?: OAuthPermissionCleanupJob) => { const j = value ?? await prepare(); return job({ action: 'pause_permission_cleanup', id: j.id, expected_revision: j.revision, confirm_shared_access: true }); };
  const one = async (value?: OAuthPermissionCleanupJob) => {
    const j = value ?? await pause();
    const result = await call({ action: 'authorize_permission_cleanup', id: j.id, expected_revision: j.revision, reset_confirmed: true });
    const a = result.permission_cleanup_authorization!; const current = result.permission_cleanup_job!;
    return job({ action: 'review_permission_cleanup', id: current.id, expected_revision: current.revision, authorization_id: a.id,
      code: 'fixture-code', redirect_uri: 'https://app.recued.com/oauth-callback' });
  };
  const review = async (value?: OAuthPermissionCleanupJob) => {
    let j = value ?? await pause();
    for (let i = 0; i < 16; i++) { j = await one(j); if (j.status === 'ready_to_apply') return j; } throw Error('Not ready');
  };
  const apply = (j: OAuthPermissionCleanupJob) => job({ action: 'apply_permission_cleanup', id: j.id, expected_revision: j.revision });
  const decodeRow = async (name = 'drive') => { const row = connections.get('api', name)!; return decodeAuthFromStorage(row.auth_ciphertext, row, key); };
  return { db, key, clock: (v: number) => { clock = v; }, deps, account, apps, connections, instances, permissions, service, lifecycle, request, addApi,
    call, job, prepare, pause, one, review, apply, decodeRow, posts: () => posts, owner: (v: string) => { targetOwner = v; },
    grants: (v: string[]) => { grants = v; }, originalGrants: (v: string[]) => { originalGrants = v; },
    anonymous: (v: number) => { anonymousStatus = v; }, deny: (v: string) => { denied = v; }, needs: (v: OAuthPermissionNeeds) => { needs = v; } };
};

describe('direct Google API permission cleanup', () => {
  it('includes direct API services and a protected read in the secret-free recovery plan', async () => {
    const f = await fixture(); const before = f.connections.get('api', 'drive'); const j = await f.prepare();
    expect(j.targets).toEqual([expect.objectContaining({ platform: 'api', slug: 'drive', display_name: 'drive account',
      account: { status: 'known', account_id: 'drive-' + owner, email: owner }, verification_url: 'https://www.googleapis.com/drive/v3/about?fields=user' })]);
    expect(f.connections.get('api', 'drive')).toEqual(before); expect(f.posts()).toBe(0);
    expect(JSON.stringify(j)).not.toMatch(/fixture-secret|original-refresh|access_token/);
  });
  it.each([false, true])('rejects a queued pre-pause runtime snapshot (shared family: %s)', async shared => {
    const f = await fixture({ shared }); const before = f.connections.get('api', 'drive')!;
    await f.pause(); f.request.mockClear();
    const dispatch = createConnectionApiHandler({ decodeAuth: row => decodeCurrentNativeOAuth({ store: f.connections, decode: decodeAuthFromStorage, key: f.key }, row),
      persistAuth: async () => {}, fetchImpl: f.request, now: () => 1000 });
    await expect(dispatch(before, { method: 'GET', path: 'about' }, { slug: 'connection', risk_tier: 'read', input: {}, output: {} })).rejects.toThrow(/cleanup/);
    expect(f.request).not.toHaveBeenCalled();
  });
  it('refuses a pause while another credential replacement owns the connection', async () => {
    const f = await fixture(); const j = await f.prepare(); const before = f.connections.get('api', 'drive');
    expect(f.connections.claimCredentialRotationAttempt!({ kind: 'api', name: 'drive', attempt_id: 'concurrent-replacement', started_at: 1000 }).claimed).toBe(true);
    await expect(f.pause(j)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.connections.get('api', 'drive')).toEqual(before); expect(f.connections.permissionCleanupId!('drive')).toBeUndefined();
    expect((await f.job({ action: 'permission_cleanup_status', id: j.id })).status).toBe('prepared');
    expect(f.posts()).toBe(0);
  });
  it.each([false, true])('never dispatches a retired token after applying cleanup (shared family: %s)', async shared => {
    const f = await fixture({ shared }); const before = f.connections.get('api', 'drive')!;
    await f.apply(await f.review()); f.request.mockClear();
    const dispatch = createConnectionApiHandler({ decodeAuth: row => decodeCurrentNativeOAuth({ store: f.connections, decode: decodeAuthFromStorage, key: f.key }, row),
      persistAuth: async () => {}, fetchImpl: f.request, now: () => 1000 });
    const result = dispatch(before, { method: 'GET', path: 'about' }, { slug: 'connection', risk_tier: 'read', input: {}, output: {} });
    if (!shared) {
      await expect(result).rejects.toThrow(/changed/); expect(f.request).not.toHaveBeenCalled();
    } else {
      await result;
      expect(f.request.mock.calls.map(([, init]) => new Headers(init?.headers).get('Authorization'))).toEqual(['Bearer candidate-1']);
    }
  });
  it('refuses a new credential replacement claim while cleanup is paused', async () => {
    const f = await fixture(); await f.pause(); const other = createConnectionStore(f.db);
    expect(() => other.claimCredentialRotationAttempt!({ kind: 'api', name: 'drive', attempt_id: 'late-replacement', started_at: 1000 })).toThrow(/cleanup/);
    expect(f.connections.getCredentialRotationAttempt!('late-replacement')).toBeNull(); expect(f.posts()).toBe(0);
  });
  it.each([null, {}, [{ name: 'drive' }], [null], [{ name: 'drive', url: 'https://www.googleapis.com/drive/v3/about' }, null]].map(input => ({ input })))('rejects malformed API access-check input before changing credentials: $input', async ({ input }) => {
    const f = await fixture();
    await expect(f.prepare(input as never)).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.connections.permissionCleanupId!('drive')).toBeUndefined(); expect(f.service.list()).toEqual([]); expect(f.posts()).toBe(0);
  });
  it('removes live API tokens while paused and fences dispatch, refresh, replacement and deletion across store instances', async () => {
    const f = await fixture(); const j = await f.pause(); const row = f.connections.get('api', 'drive')!; const auth = await f.decodeRow();
    expect(auth).toMatchObject({ permission_cleanup_pending: j.id, refresh_token: '' }); expect(auth).not.toHaveProperty('current_access_token');
    expect(() => injectConnectionApiAuth(auth, new Headers(), new URL('https://www.googleapis.com/drive/v3/about'), { method: 'GET', nowMs: 1000 })).toThrow(/cleanup/);
    if (auth.type !== 'oauth2_refresh') throw Error('Wrong auth');
    expect(resolveBearerAccessToken({ ...auth, current_access_token: 'must-stay-paused' })).toBeUndefined();
    await expect(refreshOAuth2WithMetadata(auth, f.request, () => 1000)).rejects.toThrow(/cleanup/);
    await expect(createEnsureFreshAuth({ persistAuth: async () => {}, fetchImpl: f.request })(row, auth)).rejects.toThrow(/cleanup/);
    const other = createConnectionStore(f.db);
    expect(() => other.delete('api', 'drive')).toThrow(/cleanup/); expect(() => other.upsert(row)).toThrow(/cleanup/);
    expect(() => other.persistRefreshedAuth!(row, 'stale', 9000)).toThrow(/cleanup/); expect(f.posts()).toBe(0);
  });
  it('saves reduced grants and the active scope baseline while retaining names, app origins, configuration and usage', async () => {
    const f = await fixture(); const before = f.connections.get('api', 'drive')!; const sourceId = f.connections.getAuthSourceId!('api', 'drive');
    const j = await f.review(); expect((await f.decodeRow()).type).toBe('oauth2_refresh');
    const done = await f.apply(j); const row = f.connections.get('api', 'drive')!;
    expect(done.status).toBe('applied'); expect(done.targets[0]?.platform).toBe('api'); expect(done.restart_needed).toBeUndefined();
    expect(row).toMatchObject({ ...before, auth_ciphertext: expect.any(String), granted_scopes_json: JSON.stringify([drive]), updated_at: expect.any(Number) });
    expect(await f.decodeRow()).toMatchObject({ refresh_token: 'candidate-refresh-1', required_scopes: [drive], saved_oauth_app: { issuer: 'google', id: 'default' } });
    expect(await f.decodeRow()).not.toHaveProperty('permission_cleanup_pending'); expect(f.connections.permissionCleanupId!('drive')).toBeUndefined();
    expect(f.connections.getAuthSourceId!('api', 'drive')).toBe(sourceId);
    expect((await f.permissions.handle({ action: 'permission_inventory' })).permission_inventory?.groups[0]?.scopes.map(s => s.scope)).not.toContain(sheets);
    expect(JSON.stringify(done)).not.toMatch(/candidate-refresh|candidate-1|fixture-secret/);
  });
  it('reconnects each independent grant while sharing a candidate only among confirmed local copies', async () => {
    for (const shared of [false, true]) {
      const f = await fixture({ copies: 2, shared }); const j = await f.review(); await f.apply(j);
      expect(f.posts()).toBe(shared ? 1 : 2); expect(j.verified_targets).toHaveLength(2);
      const a = await f.decodeRow(); const b = await f.decodeRow('drive-1');
      if (a.type !== 'oauth2_refresh' || b.type !== 'oauth2_refresh') throw Error('Wrong auth');
      expect(a.refresh_token === b.refresh_token).toBe(shared); expect(a.native_credential_id).toBe(shared ? 'a'.repeat(43) : undefined);
    }
  });
  it('resumes encrypted partial API progress after rebuilding the service and leaves old grants unapplied until all checks pass', async () => {
    const f = await fixture({ copies: 2 }); const first = await f.one(); expect(first.status).toBe('awaiting_reconnect'); expect(first.verified_targets).toHaveLength(1);
    const restarted = createOAuthPermissionCleanupService(f.deps);
    expect((await restarted.handle({ action: 'permission_cleanup_status', id: first.id })).permission_cleanup_job).toEqual(first);
    expect(f.connections.list().every(row => row.granted_scopes_json?.includes(sheets))).toBe(true);
    const sealed = f.db.prepare<[], { data_ciphertext: string }>('SELECT data_ciphertext FROM oauth_permission_cleanups').get()!.data_ciphertext;
    expect(sealed).not.toContain('candidate'); expect((await f.apply(await f.one(first))).status).toBe('applied');
  });
  it('coordinates API and native Mail grants without changing the collection or its history', async () => {
    const f = await fixture({ mail: true }); const before = f.instances.get('mail', 'work')!;
    const j = await f.review(); expect(j.targets.map(t => t.platform).sort()).toEqual(['api', 'mail']); expect(f.posts()).toBe(2);
    await f.apply(j); expect(f.instances.get('mail', 'work')).toMatchObject(before); expect(f.lifecycle.stop).toHaveBeenCalledWith('work'); expect(f.lifecycle.restart).toHaveBeenCalledWith('work');
    expect(await f.account.get('gmail.work.history_id')).toBe('keep-mail-history'); expect(await f.account.get('gmail.work.granted_scopes')).not.toContain(sheets);
    expect(await f.account.get('gmail.work.refresh_token')).not.toBe((await f.decodeRow() as Extract<ConnectionAuth, { type: 'oauth2_refresh' }>).refresh_token);
  });
  it('keeps an API grant separate from a native mailbox whose slug matches the temporary exchange prefix', async () => {
    const f = await fixture({ mail: true }); const first = await f.prepare();
    const data = createOAuthPermissionCleanupStore(f.db, f.key, () => 1000).get(first.id);
    const grant = data.api_connections![0]!.grant_key; const slug = grant.slice(grant.indexOf('.') + 1);
    await f.job({ action: 'cancel_permission_cleanup', id: first.id, expected_revision: first.revision });
    const previous = f.instances.get('mail', 'work')!; f.instances.delete('mail', 'work');
    f.instances.upsert({ ...previous, slug, config: { ...previous.config, account_slug: slug } });
    for (const field of ['refresh_token', 'access_token', 'expires_at', 'granted_scopes']) await f.account.set('gmail.' + slug + '.' + field, (await f.account.get('gmail.work.' + field))!);
    await f.apply(await f.review()); expect(f.posts()).toBe(2);
    const auth = await f.decodeRow(); if (auth.type !== 'oauth2_refresh') throw Error('Wrong auth');
    expect(await f.account.get('gmail.' + slug + '.refresh_token')).not.toBe(auth.refresh_token);
  });
  it('pauses and verifies Mail collections bound to an API credential without changing their binding', async () => {
    const f = await fixture({ boundMail: true, shared: true });
    f.grants([drive, read]); const before = f.instances.get('mail', 'work')!;
    const j = await f.review(); expect(j.targets.map(t => t.platform).sort()).toEqual(['api', 'mail']); expect(f.posts()).toBe(1);
    await f.apply(j); expect(f.instances.get('mail', 'work')).toMatchObject(before); expect(f.lifecycle.restart).toHaveBeenCalledWith('work');
    expect(await f.account.get('gmail.work.refresh_token')).toBeNull();
  });
  it.each(['wrong-account', 'missing-scope', 'retained-scope', 'broader-scope', 'public-resource', 'denied-resource'] as const)('rejects %s without saving candidate credentials', async scenario => {
    const f = await fixture(); const j = await f.pause();
    if (scenario === 'wrong-account') f.owner('different@example.test');
    if (scenario === 'missing-scope') f.grants(['email']);
    if (scenario === 'retained-scope') f.grants([drive, sheets]);
    if (scenario === 'broader-scope') f.grants(['https://www.googleapis.com/auth/drive']);
    if (scenario === 'public-resource') f.anonymous(200);
    if (scenario === 'denied-resource') f.deny('/about');
    await expect(f.one(j)).rejects.toMatchObject({ code: 'credential_verification_failed' });
    expect(await f.decodeRow()).toMatchObject({ permission_cleanup_pending: j.id });
    expect(f.connections.get('api', 'drive')?.granted_scopes_json).toContain(sheets);
  });
  it('keeps API accounts with no surviving identity read protected without requesting new scopes', async () => {
    const f = await fixture(); f.originalGrants([sheets]); await f.addApi('drive');
    await expect(f.prepare()).rejects.toMatchObject({ code: 'credential_verification_failed' });
    expect(f.posts()).toBe(0); expect(f.connections.permissionCleanupId!('drive')).toBeUndefined();
  });
  it('can clean an unused API grant when no installed dependency remains and a retained grant still supports account and resource checks', async () => {
    const f = await fixture(); f.needs({ complete: true, requirements: [], warnings: [] });
    const j = await f.review(); expect(j.required_scopes).toEqual([]); expect(j.requested_scopes).toEqual([drive]);
    expect((await f.apply(j)).status).toBe('applied'); expect(f.connections.get('api', 'drive')?.granted_scopes_json).toBe(JSON.stringify([drive]));
  });
  it('checks a private Sheets URL using its native service while using an existing Drive grant for identity', async () => {
    const f = await fixture(); await f.addApi('drive', {}, 'https://sheets.googleapis.com/v4');
    const j = await f.pause(await f.prepare([{ name: 'drive', url: 'https://docs.google.com/spreadsheets/d/private-sheet/edit#gid=0' }]));
    const ready = await f.review(j); expect(ready.targets[0]).toMatchObject({ verification_url: 'https://sheets.googleapis.com/v4/spreadsheets/private-sheet?fields=spreadsheetId' });
    await f.apply(ready); expect(f.request.mock.calls.some(([url, init]) => String(url).includes('/v4/spreadsheets/private-sheet') && new Headers(init?.headers).has('Authorization'))).toBe(true);
  });
  it.each(['http://127.0.0.1/private', 'https://evil.test/private', 'https://www.googleapis.com/drive/v3/about?access_token=secret',
    'https://www.googleapis.com/drive/v3/about?key=secret'])('refuses an unpinned or credential-bearing read URL %s', async url => {
    const f = await fixture(); await expect(f.prepare([{ name: 'drive', url }])).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.posts()).toBe(0); expect(f.connections.permissionCleanupId!('drive')).toBeUndefined();
  });
  it('refreshes an expired original API token through the normal persisted renewal before pinning cleanup', async () => {
    const f = await fixture(); await f.addApi('drive', { expires_at: 0 }); const j = await f.prepare(); expect(j.status).toBe('prepared');
    expect(f.posts()).toBe(1); expect(await f.decodeRow()).toMatchObject({ refresh_token: 'renewed-refresh-1' });
  });
  it('refuses public access checks before creating a task or pausing credentials', async () => {
    const f = await fixture(); f.anonymous(200);
    await expect(f.prepare()).rejects.toMatchObject({ code: 'credential_verification_failed' });
    expect(f.connections.permissionCleanupId!('drive')).toBeUndefined(); expect(f.service.list()).toEqual([]);
  });
  it('can change a lost API resource through refresh review and discards all earlier candidate checks', async () => {
    const f = await fixture(); await f.addApi('drive', {}, 'https://sheets.googleapis.com/v4');
    const prepared = await f.prepare([{ name: 'drive', url: 'https://docs.google.com/spreadsheets/d/old-sheet/edit' }]);
    const ready = await f.review(await f.pause(prepared)); f.deny('/spreadsheets/old-sheet');
    await expect(f.apply(ready)).rejects.toMatchObject({ code: 'credential_verification_failed' });
    const current = await f.job({ action: 'permission_cleanup_status', id: ready.id });
    const refreshed = await f.job({ action: 'refresh_permission_cleanup', id: ready.id, expected_revision: current.revision,
      api_verification_urls: [{ name: 'drive', url: 'https://docs.google.com/spreadsheets/d/new-sheet/edit' }] });
    expect(refreshed.verified_targets).toBeUndefined(); expect(refreshed.targets[0]).toMatchObject({ verification_url: 'https://sheets.googleapis.com/v4/spreadsheets/new-sheet?fields=spreadsheetId' });
    expect((await f.apply(await f.review(refreshed))).status).toBe('applied');
  });
  it('does not adopt a new local grant-family member or bound collection without a recovery plan', async () => {
    const f = await fixture({ shared: true }); const paused = await f.pause(); await f.addApi('late-copy');
    await expect(f.job({ action: 'refresh_permission_cleanup', id: paused.id, expected_revision: paused.revision })).rejects.toMatchObject({ code: 'conflict' });
    f.connections.delete('api', 'late-copy');
    f.instances.upsert({ platform: 'mail', slug: 'late', adapter_type: 'gmail', caps, auth_state: 'healthy', last_synced_at: null,
      config: { oauth_connection: { type: 'direct_oauth', connection_name: 'drive', native_credential_id: 'a'.repeat(43), target_origin: 'https://gmail.googleapis.com' } } });
    await expect(f.job({ action: 'refresh_permission_cleanup', id: paused.id, expected_revision: paused.revision })).rejects.toMatchObject({ code: 'conflict' });
    expect(f.connections.permissionCleanupId!('drive')).toBe(paused.id);
  });
  it('retires expired API candidates while leaving the durable pause in place', async () => {
    const f = await fixture(); const ready = await f.review(); f.clock(700_000);
    const current = await f.job({ action: 'permission_cleanup_status', id: ready.id });
    expect(current).toMatchObject({ status: 'awaiting_reconnect', verification: 'not_checked' }); expect(current.verified_targets).toBeUndefined();
    expect(await f.decodeRow()).toMatchObject({ permission_cleanup_pending: ready.id });
  });
  it('keeps another verified Google account outside the selected account reset', async () => {
    const f = await fixture(); await f.addApi('other-account'); const j = await f.pause();
    expect(j.targets.map(t => t.slug)).toEqual(['drive']); expect(f.connections.permissionCleanupId!('other-account')).toBeUndefined();
  });
  it('supports the Gmail pack host-root service and its native profile check', async () => {
    const f = await fixture(); f.originalGrants([read, sheets]); await f.addApi('drive', {}, 'https://gmail.googleapis.com');
    f.needs({ complete: true, warnings: [], requirements: [{ scope: read, uses: [{ kind: 'pack', id: 'gmail', label: 'Gmail' }] }] });
    f.grants([read]); const ready = await f.review();
    expect(ready.targets[0]).toMatchObject({ verification_url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' });
    expect((await f.apply(ready)).status).toBe('applied');
  });
  it('adopts an updated saved app secret only through an explicit review refresh and fresh consent', async () => {
    const f = await fixture(); const j = await f.pause(); f.apps.setIssuer('google', 'fixture-client', 'replacement-secret');
    await expect(f.one(j)).rejects.toMatchObject({ code: 'conflict' });
    const refreshed = await f.job({ action: 'refresh_permission_cleanup', id: j.id, expected_revision: j.revision });
    const done = await f.apply(await f.review(refreshed)); expect(done.status).toBe('applied');
    expect(await f.decodeRow()).toMatchObject({ client_secret: 'replacement-secret' });
    const posted = f.request.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(new URLSearchParams(String(posted?.[1]?.body)).get('client_secret')).toBe('replacement-secret');
  });
  it('keeps changed dependencies protected and can restore the original API scope union', async () => {
    const f = await fixture(); const j = await f.review();
    f.needs({ complete: true, warnings: [], requirements: [{ scope: drive, uses: [{ kind: 'pack', id: 'drive-pack', label: 'Drive pack' }] },
      { scope: sheets, uses: [{ kind: 'pack', id: 'new-pack', label: 'New pack' }] }] });
    await expect(f.apply(j)).rejects.toMatchObject({ code: 'conflict' });
    const current = await f.job({ action: 'permission_cleanup_status', id: j.id });
    const restore = await f.job({ action: 'restore_permission_cleanup', id: j.id, expected_revision: current.revision });
    expect(restore.requested_scopes).toEqual([drive, sheets]);
    f.grants([drive, sheets]); const done = await f.apply(await f.review(restore)); expect(done.status).toBe('restored');
    expect(await f.decodeRow()).toMatchObject({ required_scopes: [drive, sheets] });
  });
  it.each(['pause', 'apply'] as const)('rolls back API and native changes together on an atomic %s refusal', async phase => {
    const f = await fixture({ mail: true }); const j = phase === 'pause' ? await f.prepare() : await f.review();
    const before = f.connections.get('api', 'drive')!; const native = await f.account.get('gmail.work.refresh_token');
    f.db.exec(`CREATE TRIGGER refuse_cleanup BEFORE UPDATE ON oauth_permission_cleanups WHEN NEW.status = '${phase === 'pause' ? 'stopping' : 'applied'}'
      BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END;`);
    await expect(phase === 'pause' ? f.pause(j) : f.apply(j)).rejects.toBeInstanceOf(Error);
    expect(f.connections.get('api', 'drive')).toEqual(before); expect(await f.account.get('gmail.work.refresh_token')).toBe(native);
    expect(f.connections.permissionCleanupId!('drive')).toBe(phase === 'pause' ? undefined : j.id);
    expect(collectionAuthenticationLocks(f.db).has('mail:work')).toBe(phase === 'apply');
  });
});
