import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL, isOAuthAppRenewalReview, isOAuthAppRenewalVerification, isAuthenticationIncidentHistoryPage,
  type OAuthAppIssuer, type ConnectionAuth, type CollectionCaps, type OAuthAppRenewalReview, type AuthenticationIncidentHistoryQuery } from '@recued/contracts';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createServerAccountStore } from '../account-store.js';
import { createOAuthAppRenewalService } from '../oauth-app-renewal-service.js';
import { createOAuthAppRenewalChecks } from '../oauth-app-renewal-checks.js';
import { makeOAuthAppConfigHandlers } from '../oauth-app-config-handler.js';
import { decodeAuthFromStorage, encodeAuthForStorage } from '../connection-auth-storage.js';
import { getAccessToken } from '../collections/mail/oauth.js';
import { createAuthenticationIncidentStore } from '../authentication-incident-store.js';
import { createAuthenticationRepairSnapshot } from '../authentication-repair-worklist.js';
import { authenticationAppHistoryGroupId } from '../authentication-repair-action-store.js';
import { createAuthenticationAlertStore } from '../authentication-alert-store.js';

const dbs: Database.Database[] = []; afterEach(() => { vi.restoreAllMocks(); dbs.splice(0).forEach(db => db.close()); });
const fixture = async (issuer: OAuthAppIssuer = 'google') => {
  const db = new Database(':memory:'); dbs.push(db); let unlocked = true; let clock = 1000;
  const key = () => unlocked ? new Uint8Array(32).fill(7) : null;
  const apps = createOAuthAppConfigStore(db, { getEncryptionKey: key });
  const app = apps.saveApp({ issuer, label: 'Work app', client_id: 'client', client_secret: 'current-secret' });
  const connections = createConnectionStore(db); const instances = createInstanceStore({ db }); const accountStore = createServerAccountStore(db);
  const auth: Extract<ConnectionAuth, { type: 'oauth2_refresh' }> = { type: 'oauth2_refresh', client_id: app.client_id, client_secret: 'current-secret',
    token_endpoint: issuer === 'google' ? GOOGLE_TOKEN_URL : MICROSOFT_TOKEN_URL, native_credential_id: 'family', refresh_token: 'api-refresh',
    current_access_token: 'still-valid-api-cache', expires_at: 9_999_999, saved_oauth_app: { issuer, id: app.id } };
  const put = async (name: string, value = auth) => connections.upsert({ kind: 'api', name, display_name: name + ' display', enrolled_at: 1, updated_at: 2,
    config_json: '{"vendor":"generic","base_url":"https://sheets.googleapis.com/v4"}', granted_scopes_json: '["kept"]',
    auth_ciphertext: await encodeAuthForStorage(value, { kind: 'api', name }, key), health_json: '{"status":"ok","last_probed_at":2}' });
  await put('one', { ...auth, required_scopes: ['read-one'] }); await put('two', { ...auth, required_scopes: ['read-two'] });
  const caps: CollectionCaps = { read: 'yes', write: 'no', delete: 'no', watch: 'realtime', mirror: 'required', auth: 'oauth', path_style: 'uri' };
  for (const platform of ['mail', 'calendar'] as const) {
    const provider = issuer === 'microsoft' ? 'graph' : platform === 'mail' ? 'gmail' : 'gcal';
    instances.upsert({ platform, slug: 'work', adapter_type: provider, config: { account_slug: 'shared', oauth_app_id: app.id }, caps, auth_state: 'healthy', last_synced_at: 77 });
    for (const [suffix, value] of Object.entries({ refresh_token: provider + '-refresh', access_token: 'still-valid-native', expires_at: '9999999',
      grant_generation: provider + '-generation', granted_scopes: 'kept', cursor: 'keep-sync-cursor' })) await accountStore.set(provider + '.shared.' + suffix, value);
  }
  let response: (url: string, body: URLSearchParams) => Promise<Response> = async (_url, body) => Response.json({ access_token: body.get('refresh_token') + '-access',
    refresh_token: body.get('refresh_token') + '-rotated', expires_in: 3600 });
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => response(String(input), new URLSearchParams(String(init?.body))));
  const deps = { db, apps, connections, instances, accountStore, key, fetchImpl, now: () => clock,
    connectionUses: (_name: string) => ({ uses: [{ kind: 'file' as const, id: 'sample-source', label: 'Sample files' }], complete: true }) };
  const service = createOAuthAppRenewalService(deps);
  const call = makeOAuthAppConfigHandlers({ store: apps, renewal: service })!.handlers['server.oauthApps'];
  const preview = async () => { const r = await call({ action: 'renewal_preview', issuer, id: app.id, expected_revision: apps.getApp(issuer, app.id)!.revision }, undefined as never);
    expect(isOAuthAppRenewalReview(r.renewal_review)).toBe(true); return r.renewal_review!; };
  const run = async (review: OAuthAppRenewalReview, ids = review.grants.filter(g => g.eligible).map(g => g.id), attempt = 'a'.repeat(43)) => {
    const result = await service.handle({ action: 'renewal_run', review_id: review.id, fingerprint: review.fingerprint, selected_ids: ids, attempt_id: attempt });
    expect(isOAuthAppRenewalVerification(result.renewal_verification)).toBe(true); return result.renewal_verification!;
  };
  const finish = async (id: string) => {
    let value = (await service.handle({ action: 'renewal_status', id })).renewal_verification!;
    await vi.waitFor(async () => { value = (await service.handle({ action: 'renewal_status', id })).renewal_verification!; expect(value.status).toBe('completed'); }, { timeout: 3000, interval: 10 });
    return value;
  };
  const read = async (name: string) => { const row = connections.get('api', name)!; return decodeAuthFromStorage(row.auth_ciphertext, row, key); };
  const historyStore = createAuthenticationIncidentStore(db);
  const history = (query: AuthenticationIncidentHistoryQuery = { scope: { kind: 'all' }, include_renewals: true }) => service.history(historyStore.history(query, clock));
  return { db, app, apps, auth, accountStore, connections, instances, service, deps, fetchImpl, preview, run, finish, put, read,
    history, historyStore,
    response: (fn: typeof response) => { response = fn; }, lock: () => { unlocked = false; }, time: (n: number) => { clock = n; } };
};

describe('saved app token-renewal verification', () => {
  it('keeps recovery available for a second client attempt after its duplicate reply is also lost', async () => {
    const f = await fixture(); const review = await f.preview(); const done = await f.finish((await f.run(review)).id);
    expect((await f.run(review, undefined, 'b'.repeat(43))).id).toBe(done.id);
    const reopened = createOAuthAppRenewalService(f.deps);
    expect((await reopened.handle({ action: 'renewal_status', attempt_id: 'b'.repeat(43) })).renewal_verification).toEqual(done);
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('rolls back reservation if its attempt lookup cannot be saved', async () => {
    const f = await fixture(); const review = await f.preview();
    f.db.exec("CREATE TRIGGER fail_renewal_attempt BEFORE INSERT ON oauth_app_renewal_attempts BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    await expect(f.run(review)).rejects.toThrow('fixture failure'); expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) n FROM oauth_app_renewal_verifications').get()).toEqual({ n: 0 });
  });
  it('keeps attempt aliases bound to one request and prunes them with their retained job', async () => {
    const f = await fixture(); const review = await f.preview(); const job = await f.run(review); await f.finish(job.id);
    await f.run(review, undefined, 'b'.repeat(43)); const later = await f.preview();
    await expect(f.run(later, undefined, 'b'.repeat(43))).rejects.toMatchObject({ code: 'conflict' });
    f.time(91 * 86_400_000); await f.finish((await f.run(await f.preview(), undefined, 'c'.repeat(43))).id);
    expect((await f.service.handle({ action: 'renewal_status', attempt_id: 'b'.repeat(43) })).renewal_verification).toBeNull();
    expect(f.db.prepare('SELECT count(*) n FROM oauth_app_renewal_attempts').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT count(*) n FROM oauth_app_renewal_verifications').get()).toEqual({ n: 1 });
  });
  it('blocks conflicting Microsoft token endpoints in one saved credential family', async () => {
    const f = await fixture('microsoft'); await f.put('two', { ...f.auth, token_endpoint: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token' });
    expect((await f.preview()).grants.find(g => g.connections.includes('one'))).toMatchObject({ eligible: false, reason: 'shared_grant_conflict' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('refuses an API cleanup pause introduced during the final asynchronous inventory read', async () => {
    const f = await fixture('microsoft'); const checks = createOAuthAppRenewalChecks(f.deps); const initial = await checks.inventory(f.app);
    const api = initial.groups.find(g => g.public.connections.length)!.public; const get = f.accountStore.get.bind(f.accountStore); let reads = 0;
    vi.spyOn(f.accountStore, 'get').mockImplementation(async key => {
      if (key === 'graph.shared.grant_generation' && ++reads === 2) {
        const row = f.connections.get('api', 'one')!;
        f.connections.replacePermissionCleanupAuth!([{ previous: row, auth_ciphertext: row.auth_ciphertext, granted_scopes_json: row.granted_scopes_json!, updated_at: 3 }], 'cleanup', 'pause', () => {});
      }
      return get(key);
    });
    await expect(checks.renew(f.app, api)).rejects.toMatchObject({ code: 'conflict' }); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('refuses a native account binding changed during the final asynchronous inventory read', async () => {
    const f = await fixture('microsoft'); const checks = createOAuthAppRenewalChecks(f.deps); const initial = await checks.inventory(f.app);
    const native = initial.groups.find(g => g.public.native_accounts.length)!.public; const get = f.accountStore.get.bind(f.accountStore); let reads = 0;
    vi.spyOn(f.accountStore, 'get').mockImplementation(async key => {
      if (key === 'graph.shared.grant_generation' && ++reads === 2) {
        const row = f.instances.get('mail', 'work')!; f.instances.upsert({ ...row, config: { ...row.config, account_slug: 'replacement' } });
      }
      return get(key);
    });
    await expect(checks.renew(f.app, native)).rejects.toMatchObject({ code: 'conflict' }); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['google', 'microsoft'] as const)('forces %s renewal with the current secret, groups shared grants, and preserves local needs and sync state', async issuer => {
    const f = await fixture(issuer); const rows = f.instances.list(); const review = await f.preview(); expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(review.grants.filter(g => g.connections.length).map(g => g.connections)).toEqual([['one', 'two']]);
    expect(review.grants).toHaveLength(issuer === 'google' ? 3 : 2);
    if (issuer === 'microsoft') expect(review.grants.find(g => g.native_accounts.length)?.native_accounts).toHaveLength(2);
    const job = await f.run(review); expect(job.status).toBe('checking'); expect(f.fetchImpl).not.toHaveBeenCalled();
    const done = await f.finish(job.id); expect(done.results.every(r => r.status === 'passed' && r.current === 'yes')).toBe(true);
    expect(f.fetchImpl).toHaveBeenCalledTimes(review.grants.length);
    for (const [url, init] of f.fetchImpl.mock.calls) {
      expect([GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL]).toContain(String(url)); const body = new URLSearchParams(String(init?.body));
      expect(body.get('client_secret')).toBe('current-secret'); expect(body.get('grant_type')).toBe('refresh_token'); expect(body.has('scope')).toBe(false);
    }
    expect(await f.read('one')).toMatchObject({ refresh_token: 'api-refresh-rotated', required_scopes: ['read-one'] });
    expect(await f.read('two')).toMatchObject({ refresh_token: 'api-refresh-rotated', required_scopes: ['read-two'] });
    expect(f.connections.get('api', 'one')!.granted_scopes_json).toBe('["kept"]'); expect(f.instances.list()).toEqual(rows);
    for (const [key, value] of Object.entries(await f.accountStore.getAll())) if (key.endsWith('.cursor')) expect(value).toBe('keep-sync-cursor');
    const raw = f.db.prepare<[], { data: string }>('SELECT data FROM oauth_app_renewal_verifications').get()!.data;
    expect(raw).not.toMatch(/current-secret|api-refresh|still-valid|access_token|refresh_token|ciphertext/);
    f.fetchImpl.mockClear(); const reopened = createOAuthAppRenewalService(f.deps);
    expect((await reopened.handle({ action: 'renewal_status', id: job.id })).renewal_verification).toEqual(done); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['invalid_client', 'unauthorized_client', 'invalid_grant', 'invalid_scope'] as const)('classifies %s without retaining provider descriptions and continues other grants', async error => {
    const f = await fixture(); f.response(async (_url, body) => body.get('refresh_token') === 'api-refresh'
      ? Response.json({ error, error_description: 'private-provider-detail current-secret' }, { status: 400 })
      : Response.json({ access_token: 'fresh', expires_in: 3600 }));
    const done = await f.finish((await f.run(await f.preview())).id); const api = done.results.find(r => r.connections.length)!;
    expect(api).toMatchObject(error === 'invalid_grant' ? { status: 'failed', reason: 'grant_rejected' }
      : error === 'invalid_scope' ? { status: 'unconfirmed', reason: 'unavailable' } : { status: 'failed', reason: 'client_rejected' });
    expect(done.results.filter(r => r.native_accounts.length).every(r => r.status === 'passed')).toBe(true);
    expect(JSON.stringify(done)).not.toContain('private-provider-detail'); expect(await f.read('one')).toMatchObject({ refresh_token: 'api-refresh' });
  });
  it('leaves unknown copies, different secrets and excluded authorizations unchecked', async () => {
    const f = await fixture(); await f.put('unknown', { ...f.auth, native_credential_id: 'legacy', saved_oauth_app: undefined });
    await f.put('old', { ...f.auth, native_credential_id: 'old', client_secret: 'old-secret' });
    const review = await f.preview(); expect(review.grants.find(g => g.connections.includes('unknown'))).toMatchObject({ eligible: false, reason: 'origin_unknown' });
    expect(review.grants.find(g => g.connections.includes('old'))).toMatchObject({ eligible: false, reason: 'secret_mismatch' });
    const api = review.grants.find(g => g.connections.includes('one'))!; const done = await f.finish((await f.run(review, [api.id])).id);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(done.results.filter(r => r.native_accounts.length).every(r => r.reason === 'not_selected')).toBe(true);
  });
  it('refuses stale or retired reviews before reserving a job', async () => {
    const f = await fixture(); const first = await f.preview(); await f.service.handle({ action: 'renewal_retire', review_id: first.id });
    await expect(f.run(first)).rejects.toMatchObject({ code: 'conflict' });
    const second = await f.preview(); f.apps.saveApp({ ...f.app, expected_revision: f.app.revision, client_secret: 'replacement-secret' });
    await expect(f.run(second)).rejects.toMatchObject({ code: 'conflict' }); expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) n FROM oauth_app_renewal_verifications').get()).toEqual({ n: 0 });
  });
  it('deduplicates a lost reply even with another client attempt and retires only unused reviews', async () => {
    const f = await fixture(); const review = await f.preview(); const job = await f.run(review); const done = await f.finish(job.id);
    await f.service.handle({ action: 'renewal_retire', review_id: review.id });
    expect((await f.run(review, undefined, 'b'.repeat(43))).id).toBe(job.id);
    expect((await f.service.handle({ action: 'renewal_status', attempt_id: 'a'.repeat(43) })).renewal_verification).toEqual(done);
    expect(f.fetchImpl).toHaveBeenCalledTimes(3); expect((await f.preview()).latest?.id).toBe(job.id);
  });
  it.each(['api', 'native'] as const)('does not pass an unsaved %s renewal', async mode => {
    const f = await fixture(); const review = await f.preview(); const group = review.grants.find(g => mode === 'api' ? g.connections.length : g.native_accounts.length)!;
    if (mode === 'api') vi.spyOn(f.connections, 'persistRefreshedAuth').mockReturnValue(false);
    else vi.spyOn(f.accountStore, 'transactionalWrite').mockImplementation(() => { throw Error('disk failure'); });
    const done = await f.finish((await f.run(review, [group.id])).id);
    expect(done.results.find(r => r.id === group.id)).toMatchObject({ status: 'unconfirmed', reason: 'persistence_failed' });
  });
  it('names a renewed-credential storage refusal as a server error', async () => {
    const f = await fixture(); const checks = createOAuthAppRenewalChecks(f.deps);
    const group = (await checks.inventory(f.app)).groups.find(g => g.public.connections.length)!.public;
    vi.spyOn(f.connections, 'persistRefreshedAuth').mockReturnValue(false);
    await expect(checks.renew(f.app, group)).rejects.toMatchObject({ code: 'credential_verification_failed', status: 500 });
  });
  it('retains a rotated token but supersedes its proof when the saved app secret changes in flight', async () => {
    const f = await fixture(); let release!: (r: Response) => void;
    f.response(() => new Promise(resolve => { release = resolve; })); const review = await f.preview(); const api = review.grants.find(g => g.connections.length)!;
    const job = await f.run(review, [api.id]); await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
    f.apps.saveApp({ ...f.app, expected_revision: f.app.revision, client_secret: 'next-secret' });
    release(Response.json({ access_token: 'received', refresh_token: 'must-retain', expires_in: 3600 }));
    const done = await f.finish(job.id); expect(done.results.find(r => r.id === api.id)).toMatchObject({ status: 'unconfirmed', reason: 'changed', current: 'no' });
    expect(await f.read('one')).toMatchObject({ refresh_token: 'must-retain' }); expect(await f.read('two')).toMatchObject({ refresh_token: 'must-retain' });
  });
  it('serializes native verification with normal refresh and shares the lease across store handles', async () => {
    const f = await fixture('microsoft'); const review = await f.preview(); const native = review.grants.find(g => g.native_accounts.length)!;
    let release!: (r: Response) => void; let first = true;
    f.response(async (_url, body) => { if (first) { first = false; return new Promise(resolve => { release = resolve; }); }
      expect(body.get('refresh_token')).toBe('native-rotated'); return Response.json({ access_token: 'final', refresh_token: 'last-rotated', expires_in: 3600 }); });
    const runtime = getAccessToken({ provider: 'graph', slug: 'shared', accountStore: createServerAccountStore(f.db), force: true,
      providerConfig: { tokenUrl: MICROSOFT_TOKEN_URL, clientId: 'client', clientSecret: 'current-secret' },
      fetcher: (url, init) => f.fetchImpl(url, init), now: () => 1000 });
    await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce()); const job = await f.run(review, [native.id]);
    await new Promise(resolve => setImmediate(resolve)); expect(f.fetchImpl).toHaveBeenCalledOnce();
    release(Response.json({ access_token: 'runtime', refresh_token: 'native-rotated', expires_in: 3600 })); await runtime;
    expect((await f.finish(job.id)).results.find(r => r.id === native.id)?.status).toBe('passed');
    expect(await f.accountStore.get('graph.shared.refresh_token')).toBe('last-rotated'); expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('reuses the first saved refresh when concurrent native reads find an expired cache', async () => {
    const f = await fixture('microsoft'); await f.accountStore.set('graph.shared.expires_at', '0');
    const get = () => getAccessToken({ provider: 'graph', slug: 'shared', accountStore: createServerAccountStore(f.db),
      providerConfig: { tokenUrl: MICROSOFT_TOKEN_URL, clientId: 'client', clientSecret: 'current-secret' },
      fetcher: (url, init) => f.fetchImpl(url, init), now: () => 1000 });
    const values = await Promise.all([get(), get(), get()]); expect(new Set(values).size).toBe(1); expect(f.fetchImpl).toHaveBeenCalledOnce();
  });
  it('preserves a replacement native grant and marks interrupted work without replay', async () => {
    const f = await fixture('microsoft'); let release!: (r: Response) => void;
    f.response(() => new Promise(resolve => { release = resolve; })); const review = await f.preview(); const native = review.grants.find(g => g.native_accounts.length)!;
    const job = await f.run(review, [native.id]); await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
    await f.accountStore.set('graph.shared.grant_generation', 'new-owner'); await f.accountStore.set('graph.shared.refresh_token', 'new-owner-token');
    release(Response.json({ access_token: 'late', refresh_token: 'late', expires_in: 3600 }));
    expect((await f.finish(job.id)).results.find(r => r.id === native.id)).toMatchObject({ status: 'unconfirmed', reason: 'changed', current: 'no' });
    expect(await f.accountStore.get('graph.shared.refresh_token')).toBe('new-owner-token');
    f.db.prepare('UPDATE oauth_app_renewal_verifications SET finished_at = NULL, data = ? WHERE id = ?').run(JSON.stringify({ ...job, results: job.results.map(r => ({ ...r, reason: r.id === native.id ? 'not_checked' : r.reason })) }), job.id);
    f.fetchImpl.mockClear(); const reopened = createOAuthAppRenewalService(f.deps);
    expect((await reopened.handle({ action: 'renewal_status', id: job.id })).renewal_verification?.results.find(r => r.id === native.id)).toMatchObject({ reason: 'interrupted' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('token renewal in connection history', () => {
  it.each(['', '   ', 42])('uses the passive account-group identity for a legacy native slug %j', async account_slug => {
    const f = await fixture(); const row = f.instances.get('mail', 'work')!;
    f.instances.upsert({ ...row, config: { ...row.config, account_slug } });
    const snapshot = await createAuthenticationRepairSnapshot({ connections: () => f.connections.list(),
      decode: row => decodeAuthFromStorage(row.auth_ciphertext, row, f.deps.key), instances: () => f.instances.list() })();
    const group = snapshot.worklist.groups.find(g => g.targets.some(t => t.kind === 'collection' && t.platform === 'mail'))!;
    const review = await f.preview(); await f.finish((await f.run(review)).id);
    expect((await f.history({ scope: { kind: 'group', id: group.id }, include_renewals: true })).renewals).toHaveLength(1);
  });
  it('associates connection-backed Mail and Calendar only with their pinned reviewed grant', async () => {
    const f = await fixture(); const base = f.instances.get('mail', 'work')!;
    for (const platform of ['mail', 'calendar'] as const) f.instances.upsert({ ...base, platform, slug: 'linked',
      adapter_type: platform === 'mail' ? 'gmail' : 'gcal', config: { oauth_connection: { type: 'direct_oauth', connection_name: 'one',
        native_credential_id: f.auth.native_credential_id, target_origin: 'https://sheets.googleapis.com' } } });
    f.instances.upsert({ ...base, slug: 'stale', config: { oauth_connection: { type: 'direct_oauth', connection_name: 'one',
      native_credential_id: 'previous-grant', target_origin: 'https://sheets.googleapis.com' } } });
    const review = await f.preview(); const api = review.grants.find(g => g.connections.length)!;
    const done = await f.finish((await f.run(review, [api.id])).id); f.fetchImpl.mockClear();
    const linked = f.instances.get('mail', 'linked')!;
    f.instances.upsert({ ...linked, config: { oauth_connection: { type: 'direct_oauth', connection_name: 'two', native_credential_id: 'later-grant' } } });
    for (const platform of ['mail', 'calendar'] as const) {
      expect((await f.history({ scope: { kind: 'collection', platform, slug: 'linked' }, include_renewals: true })).renewals!.map(v => v.id)).toEqual([done.id]);
    }
    expect((await f.history({ scope: { kind: 'collection', platform: 'mail', slug: 'stale' }, include_renewals: true })).order).toEqual([]);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('counts distinct file references before applying the bounded history association limit', async () => {
    const f = await fixture(); vi.spyOn(f.deps, 'connectionUses').mockImplementation(() => ({ complete: true,
      uses: [...Array.from({ length: 255 }, () => ({ kind: 'file' as const, id: 'same-file', label: 'Shared files' })),
        { kind: 'file' as const, id: 'second-file', label: 'Other files' }, { kind: 'file' as const, id: 'last-file', label: 'Last files' }] }));
    const done = await f.finish((await f.run(await f.preview())).id);
    expect((await f.history({ scope: { kind: 'file_source', source_id: 'last-file' }, include_renewals: true })).renewals!.map(v => v.id)).toEqual([done.id]);
  });
  it.each(['bounded', 'unavailable', 'incomplete'] as const)('keeps incomplete reference coverage separate from renewal proof: %s', async mode => {
    const f = await fixture(); vi.spyOn(f.deps, 'connectionUses').mockImplementation(() => {
      if (mode === 'unavailable') throw Error('private usage error');
      return { complete: mode !== 'incomplete', uses: Array.from({ length: mode === 'bounded' ? 257 : 1 }, (_, n) => ({ kind: 'file' as const, id: 'source-' + n, label: 'Files' })) };
    });
    const done = await f.finish((await f.run(await f.preview())).id); const page = await f.history();
    expect(done.results.every(r => r.status === 'passed')).toBe(true); expect(done.incomplete).toBe(false);
    expect(page.renewals![0]).toMatchObject({ references_incomplete: true, status: 'completed' });
    expect(isAuthenticationIncidentHistoryPage(page)).toBe(true); expect(JSON.stringify(page)).not.toContain('private usage error');
    if (mode === 'bounded') {
      expect((await f.history({ scope: { kind: 'file_source', source_id: 'source-255' }, include_renewals: true })).renewals).toHaveLength(1);
      expect((await f.history({ scope: { kind: 'file_source', source_id: 'source-256' }, include_renewals: true })).renewals).toEqual([]);
    }
  });
  it('retains a reported incident as open after successful renewal, without inventing protected-access evidence', async () => {
    const f = await fixture(); const alerts = createAuthenticationAlertStore(f.db);
    f.connections.setHealth('api', 'one', '{"status":"auth_failed","last_probed_at":990}');
    const snapshot = createAuthenticationRepairSnapshot({ connections: () => f.connections.list(),
      decode: row => decodeAuthFromStorage(row.auth_ciphertext, row, f.deps.key), instances: () => f.instances.list(), now: () => 1000 });
    alerts.evaluate(await snapshot()); const incident = f.historyStore.history({ scope: { kind: 'connection', name: 'one' } }, 1000).incidents[0]!;
    const health = f.connections.get('api', 'one')!.health_json;
    await f.finish((await f.run(await f.preview())).id); alerts.evaluate(await snapshot());
    const page = await f.history(); const retained = page.incidents.find(i => i.id === incident.id)!;
    expect(retained).toMatchObject({ status: 'open', currently_reported: true }); expect(retained.recovery_evidence).toBeUndefined();
    expect(page.renewals![0]!.results.every(r => r.status === 'passed')).toBe(true); expect(page.verifications).toEqual([]);
    expect(f.connections.get('api', 'one')!.health_json).toBe(health);
  });
  it('keeps one mixed-order entry through progress, partial failure, duplicate attempts and reopening', async () => {
    const f = await fixture(); f.connections.authenticationRepairHistory!.begin('oauth_app_secret', 'earlier-rotation', {
      action: 'rotate_secret', targets: [{ kind: 'oauth_apps' }, { kind: 'connection', name: 'one' }],
    }, 900);
    f.connections.authenticationRepairHistory!.finish('oauth_app_secret', 'earlier-rotation', { status: 'applied' }, 950);
    f.response(async (_url, body) => body.get('refresh_token') === 'api-refresh'
      ? Response.json({ error: 'invalid_client', error_description: 'private current-secret' }, { status: 400 })
      : Response.json({ access_token: 'fresh', expires_in: 3600 }));
    const review = await f.preview(); const job = await f.run(review);
    expect((await f.history()).renewals![0]).toMatchObject({ id: job.id, status: 'checking', history_started_at: 1000 });
    const done = await f.finish(job.id); await f.run(review, undefined, 'b'.repeat(43));
    const page = await f.history(); expect(isAuthenticationIncidentHistoryPage(page)).toBe(true);
    expect(page.order).toEqual([job.id, page.repairs![0]!.id]); expect(page.renewals).toHaveLength(1);
    expect(page.renewals![0]!.results).toEqual(done.results); expect(page.repairs![0]!.recovery_confirmed_at).toBeUndefined();
    expect(page.verifications).toEqual([]); expect(page.renewals![0]!.results.some(r => r.status === 'failed')).toBe(true);
    expect(page.renewals![0]!.results.some(r => r.status === 'passed')).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/current-secret|api-refresh|still-valid|access_token|refresh_token|ciphertext|private/);
    f.fetchImpl.mockClear(); const reopened = createOAuthAppRenewalService(f.deps);
    expect((await reopened.history(f.historyStore.history({ scope: { kind: 'all' }, include_renewals: true }, 1000))).renewals).toEqual(page.renewals);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['google', 'microsoft'] as const)('preserves exact reviewed account and known file scopes for %s, including excluded results', async issuer => {
    const f = await fixture(issuer); const review = await f.preview(); const api = review.grants.find(g => g.connections.length)!;
    const snapshot = await createAuthenticationRepairSnapshot({ connections: () => f.connections.list(),
      decode: row => decodeAuthFromStorage(row.auth_ciphertext, row, f.deps.key), instances: () => f.instances.list(), apps: () => f.apps.listApps() })();
    const done = await f.finish((await f.run(review, [api.id])).id); f.fetchImpl.mockClear();
    const scopes: AuthenticationIncidentHistoryQuery['scope'][] = [{ kind: 'all' }, { kind: 'oauth_apps' }, { kind: 'connection', name: 'one' },
      { kind: 'connection', name: 'two' }, { kind: 'collection', platform: 'mail', slug: 'work' }, { kind: 'collection', platform: 'calendar', slug: 'work' },
      { kind: 'file_source', source_id: 'sample-source' }, { kind: 'group', id: authenticationAppHistoryGroupId(issuer, f.app.id) },
      ...snapshot.worklist.groups.map(g => ({ kind: 'group' as const, id: g.id }))];
    for (const scope of scopes) expect((await f.history({ scope, include_renewals: true })).renewals!.map(v => v.id)).toEqual([done.id]);
    expect((await f.history({ scope: { kind: 'connection', name: 'unrelated' }, include_renewals: true })).order).toEqual([]);
    expect(done.results.filter(r => r.native_accounts.length).every(r => r.reason === 'not_selected')).toBe(true);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('rolls back source, alias and target reservation when history cannot be saved, before token I/O', async () => {
    const f = await fixture(); const review = await f.preview();
    f.db.exec("CREATE TRIGGER deny_renewal_history BEFORE INSERT ON authentication_incident_history WHEN NEW.kind = 'renewal' BEGIN SELECT RAISE(ABORT, 'history failure'); END");
    await expect(f.run(review)).rejects.toThrow('history failure');
    for (const table of ['oauth_app_renewal_verifications', 'oauth_app_renewal_attempts', 'authentication_incident_history', 'authentication_incident_targets', 'authentication_history_groups']) {
      expect(f.db.prepare('SELECT count(*) n FROM ' + table).get()).toEqual({ n: 0 });
    }
    expect(f.fetchImpl).not.toHaveBeenCalled(); f.db.exec('DROP TRIGGER deny_renewal_history');
    await f.finish((await f.run(review)).id);
  });
  it('keeps source and history atomic if result persistence fails, then records interruption without replay', async () => {
    const f = await fixture(); const review = await f.preview(); const api = review.grants.find(g => g.connections.length)!;
    f.db.exec("CREATE TRIGGER deny_renewal_update BEFORE UPDATE ON authentication_incident_history WHEN NEW.kind = 'renewal' BEGIN SELECT RAISE(ABORT, 'update failure'); END");
    const job = await f.run(review, [api.id]); await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledOnce());
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    const source = f.db.prepare<[string], { data: string }>('SELECT data FROM oauth_app_renewal_verifications WHERE id = ?').get(job.id)!;
    expect(JSON.parse(source.data).status).toBe('checking'); expect((await f.history()).renewals![0]!.status).toBe('checking');
    f.db.exec('DROP TRIGGER deny_renewal_update'); f.fetchImpl.mockClear(); const reopened = createOAuthAppRenewalService(f.deps);
    const page = await reopened.history(f.historyStore.history({ scope: { kind: 'all' }, include_renewals: true }, 1000));
    expect(page.renewals![0]).toMatchObject({ status: 'completed', results: expect.arrayContaining([expect.objectContaining({ id: api.id, reason: 'interrupted' })]) });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('compares retained proof with local current revisions without changing the receipt or contacting vendors', async () => {
    const f = await fixture(); const done = await f.finish((await f.run(await f.preview())).id); f.fetchImpl.mockClear();
    const saved = f.db.prepare('SELECT data FROM authentication_incident_history WHERE id = ?').get(done.id);
    expect((await f.history()).renewals![0]!.results.every(r => r.current === 'yes')).toBe(true);
    f.lock(); expect((await f.history()).renewals![0]!.results.every(r => r.current === 'unknown')).toBe(true);
    f.apps.deleteApp('google', f.app.id, f.app.revision);
    expect((await f.history()).renewals![0]!.results.every(r => r.current === 'no')).toBe(true);
    expect(f.db.prepare('SELECT data FROM authentication_incident_history WHERE id = ?').get(done.id)).toEqual(saved);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('keeps older callers and cursors separate while paging the new mixed timeline', async () => {
    const f = await fixture(); const first = await f.finish((await f.run(await f.preview())).id);
    f.time(1001); const second = await f.finish((await f.run(await f.preview(), undefined, 'b'.repeat(43))).id);
    expect((await f.history({ scope: { kind: 'all' } })).order).toEqual([]);
    expect((await f.history({ scope: { kind: 'all' } })).renewals).toBeUndefined();
    const query = { scope: { kind: 'all' as const }, include_renewals: true, limit: 1 }; const page = await f.history(query);
    expect(page.order).toEqual([second.id]); const older = await f.history({ ...query, cursor: page.next_cursor! }); expect(older.order).toEqual([first.id]);
    expect(older.next_cursor).toBeUndefined();
    expect(() => f.historyStore.history({ scope: { kind: 'all' }, cursor: page.next_cursor! }, 1001)).toThrow('invalid for the selected connection');
    expect(() => f.historyStore.history({ ...query, scope: { kind: 'oauth_apps' }, cursor: page.next_cursor! }, 1001)).toThrow('invalid for the selected connection');
  });
  it('imports prior retained checks once without reconstructing old account groups or evicted history', async () => {
    const f = await fixture(); const done = await f.finish((await f.run(await f.preview())).id);
    f.db.exec("DELETE FROM authentication_incident_history; DELETE FROM authentication_incident_targets; DELETE FROM authentication_history_groups; ALTER TABLE oauth_app_renewal_verifications DROP COLUMN history_recorded_at");
    f.time(2000); f.fetchImpl.mockClear(); const imported = createOAuthAppRenewalService(f.deps);
    const page = await imported.history(f.historyStore.history({ scope: { kind: 'connection', name: 'one' }, include_renewals: true }, 2000));
    expect(page.renewals![0]).toMatchObject({ id: done.id, history_started_at: 2000, started_at: 1000, references_incomplete: true });
    expect(f.db.prepare('SELECT count(*) n FROM authentication_history_groups').get()).toEqual({ n: 0 });
    expect(f.historyStore.history({ scope: { kind: 'file_source', source_id: 'sample-source' }, include_renewals: true }, 2000).order).toEqual([]);
    f.db.exec('DELETE FROM authentication_incident_history'); createOAuthAppRenewalService(f.deps);
    expect(f.db.prepare('SELECT count(*) n FROM authentication_incident_history').get()).toEqual({ n: 0 });
    expect((await imported.handle({ action: 'renewal_status', id: done.id })).renewal_verification?.id).toBe(done.id);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('does not import expired source results and prunes exact group and target associations', async () => {
    const f = await fixture(); const done = await f.finish((await f.run(await f.preview())).id);
    f.db.exec('UPDATE oauth_app_renewal_verifications SET history_recorded_at = NULL'); f.time(91 * 86_400_000);
    f.fetchImpl.mockClear(); createOAuthAppRenewalService(f.deps);
    for (const table of ['oauth_app_renewal_verifications', 'authentication_incident_history', 'authentication_incident_targets', 'authentication_history_groups']) {
      expect(f.db.prepare('SELECT count(*) n FROM ' + table).get()).toEqual({ n: 0 });
    }
    expect((await f.service.handle({ action: 'renewal_status', attempt_id: 'a'.repeat(43) })).renewal_verification).toBeNull();
    await expect(f.service.handle({ action: 'renewal_status', id: done.id })).rejects.toMatchObject({ code: 'not_found' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('shares the terminal history cap, keeps active checks, and never reimports evicted results', async () => {
    const f = await fixture(); const done = await f.finish((await f.run(await f.preview())).id);
    const active = { ...done, id: 'renewal-22345678-1234-4123-8123-123456789abc', status: 'checking', finished_at: undefined };
    f.db.prepare("INSERT INTO authentication_incident_history (id, group_id, signature, data, kind) VALUES (?, 'active', '', ?, 'renewal')").run(active.id, JSON.stringify({ ...active, history_started_at: 1000 }));
    f.db.transaction(() => {
      const insert = f.db.prepare("INSERT INTO authentication_incident_history (id, group_id, ended_at, signature, data, kind) VALUES (?, 'cap', ?, '', '{}', 'repair')");
      for (let n = 0; n < 10000; n++) insert.run('cap-' + n, 2000 + n);
    })();
    f.historyStore.prune(20000);
    expect(f.db.prepare('SELECT count(*) n FROM authentication_incident_history WHERE ended_at IS NOT NULL').get()).toEqual({ n: 10000 });
    expect(f.db.prepare('SELECT 1 FROM authentication_incident_history WHERE id = ?').get(active.id)).toBeDefined();
    expect(f.db.prepare('SELECT 1 FROM authentication_incident_history WHERE id = ?').get(done.id)).toBeUndefined();
    expect(f.db.prepare('SELECT count(*) n FROM authentication_history_groups WHERE entry_id = ?').get(done.id)).toEqual({ n: 0 });
    createOAuthAppRenewalService(f.deps);
    expect(f.db.prepare('SELECT 1 FROM authentication_incident_history WHERE id = ?').get(done.id)).toBeUndefined();
    expect((await f.service.handle({ action: 'renewal_status', id: done.id })).renewal_verification?.id).toBe(done.id);
  });
});
