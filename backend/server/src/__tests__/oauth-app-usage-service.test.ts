import Database from 'better-sqlite3';
import { createAuthenticationIncidentStore } from '../authentication-incident-store.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL, isOAuthAppUsageReview, isOAuthAppSecretRotationOutcome,
  type ConnectionAuth, type OAuthAppsRequest, type ManagedOAuthConnectionUse, type CollectionCaps } from '@recued/contracts';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createServerAccountStore } from '../account-store.js';
import { makeOAuthAppConfigHandlers, oauthAppUses } from '../oauth-app-config-handler.js';
import { createOAuthAppUsageService } from '../oauth-app-usage-service.js';
import { decodeAuthFromStorage, encodeAuthForStorage } from '../connection-auth-storage.js';
import { handleConnectionEnroll, handleConnectionProbe } from '../connection-handler.js';
import { createFileSourceConnectionResolver } from '../file-source-connection-resolver.js';
import { createCollectionOAuthSources } from '../collection-oauth-sources.js';
import { collectionAuthenticationLocks } from '../collection-authentication-locks.js';
import { getAccessToken } from '../collections/mail/oauth.js';
import { refreshOAuth2WithMetadata, createEnsureFreshAuthDetailed } from '@recued/ingredients';
import { persistNativeOAuthRenewal, withCurrentConnectionRenewal } from '../native-oauth-renewal.js';
const dbs: Database.Database[] = []; afterEach(() => dbs.splice(0).forEach(db => db.close()));
const fixture = async () => {
  const db = new Database(':memory:'); dbs.push(db); let unlocked = true; let clock = 1000; let keyHook: (() => void) | undefined;
  const key = () => { keyHook?.(); return unlocked ? Buffer.alloc(32, 12) : null; };
  const apps = createOAuthAppConfigStore(db, { getEncryptionKey: key });
  const app = apps.saveApp({ issuer: 'google', label: 'Work', client_id: 'google-client', client_secret: 'fixture-old-secret' });
  const other = apps.saveApp({ issuer: 'google', label: 'Separate credentials', client_id: app.client_id, client_secret: 'fixture-other-secret' });
  apps.setIssuer('microsoft', 'ms-client', 'fixture-ms-secret');
  const connections = createConnectionStore(db); const instances = createInstanceStore({ db, now: () => clock });
  const account = createServerAccountStore(db); await account.set('gmail.work.refresh_token', 'native-refresh'); await account.set('gmail.work.history_id', 'cursor');
  const caps: CollectionCaps = { read: 'yes', write: 'no', delete: 'no', watch: 'realtime', mirror: 'required', auth: 'oauth', path_style: 'uri' };
  for (const [platform, adapter] of [['mail', 'gmail'], ['calendar', 'gcal']] as const) instances.upsert({ platform, slug: 'work', adapter_type: adapter,
    config: { oauth_app_id: app.id, account_slug: 'work' }, caps, auth_state: 'healthy', last_synced_at: 77 });
  const enroll = async (name: string, id = app.id) => handleConnectionEnroll({ store: connections, oauthAppConfig: apps, getEncryptionKey: key, now: () => clock }, {
    kind: 'api', name, display_name: name + ' display', config: { vendor: 'generic', base_url: 'https://www.googleapis.com' },
    auth: { type: 'oauth2_refresh', client_id: app.client_id, refresh_token: name + '-refresh', token_endpoint: GOOGLE_TOKEN_URL,
      current_access_token: name + '-access', expires_at: 500000 }, oauth_app_issuer: 'google', oauth_app_id: id, granted_scopes: ['read'] });
  const raw = async (name: string, patch: Partial<Extract<ConnectionAuth, { type: 'oauth2_refresh' }>> = {}) => {
    const auth: ConnectionAuth = { type: 'oauth2_refresh', client_id: app.client_id, client_secret: 'fixture-old-secret', refresh_token: name + '-refresh',
      token_endpoint: GOOGLE_TOKEN_URL, current_access_token: name + '-access', expires_at: 500000, ...patch };
    connections.upsert({ kind: 'api', name, display_name: name + ' display', config_json: '{"base_url":"https://www.googleapis.com","vendor":"generic"}',
      auth_ciphertext: await encodeAuthForStorage(auth, { kind: 'api', name }, key), enrolled_at: 100, updated_at: clock, granted_scopes_json: '["read"]',
      subresource_path: '/team', health_json: '{"status":"ok","last_probed_at":1000}', last_used_at: 900 });
  };
  await enroll('confirmed'); await enroll('excluded'); await enroll('another-profile', other.id); await raw('legacy');
  let uses: ManagedOAuthConnectionUse[] = [{ kind: 'pack', id: 'pack', label: 'Work pack' }, { kind: 'recipe', id: 'recipe', label: 'Recipe' },
    { kind: 'schedule', id: 'schedule', label: 'Schedule' }, { kind: 'mail', id: 'borrowed', label: 'Borrowed mailbox' }, { kind: 'file', id: 'file', label: 'Files' }];
  const deps = { db, apps, connections, instances, key, now: () => clock, connectionUses: () => ({ uses, complete: true }) };
  const service = createOAuthAppUsageService(deps);
  const handlers = makeOAuthAppConfigHandlers({ store: apps, uses: (issuer, id) => oauthAppUses(instances, issuer, id), usage: service })!.handlers;
  const call = (request: OAuthAppsRequest) => handlers['server.oauthApps'](request, undefined as never);
  const usage = async () => { const response = await call({ action: 'usage', issuer: app.issuer, id: app.id, expected_revision: apps.getApp(app.issuer, app.id)!.revision });
    if (!response.usage) throw Error('usage'); return response.usage; };
  const rotate = (review: Awaited<ReturnType<typeof usage>>, selected = ['confirmed'], attempt_id = 'a'.repeat(43)) => call({ action: 'rotate_secret',
    review_id: review.id, fingerprint: review.fingerprint, selected_names: selected, client_secret: 'fixture-new-secret', attempt_id });
  const auth = async (name: string) => { const row = connections.get('api', name)!; return decodeAuthFromStorage(row.auth_ciphertext, row, key); };
  return { db, apps, app, other, connections, instances, account, key, deps, service, call, usage, rotate, raw, enroll, auth,
    lock: () => { unlocked = false; }, clock: (n: number) => { clock = n; }, hook: (fn: () => void) => { keyHook = fn; },
    uses: (next: ManagedOAuthConnectionUse[]) => { uses = next; } };
};
describe('saved app usage and coordinated secret rotation', () => {
  it('journals only the selected credential copies and native accounts, preserving unverified rotation and retry identity', async () => {
    const f = await fixture(); const review = await f.usage(); const result = await f.rotate(review);
    const history = createAuthenticationIncidentStore(f.db); const page = history.history({ scope: { kind: 'connection', name: 'confirmed' } }, 1_001);
    expect(page.repairs).toHaveLength(1); expect(page.repairs![0]).toMatchObject({ action: 'rotate_secret', status: 'applied', to: { app_id: f.app.id, label: 'Work' } });
    expect(page.repairs![0]!.recovery_confirmed_at).toBeUndefined();
    expect(history.history({ scope: { kind: 'connection', name: 'excluded' } }, 1_001).repairs).toEqual([]);
    expect(history.history({ scope: { kind: 'collection', platform: 'mail', slug: 'work' } }, 1_001).repairs).toHaveLength(1);
    expect(JSON.stringify(page)).not.toMatch(/fixture-new-secret|fixture-old-secret|client_secret/);
    expect(await f.rotate(review)).toEqual(result); expect(history.history({ scope: { kind: 'all' } }, 1_001).repairs).toHaveLength(1);
  });
  it('rolls back a coordinated secret rotation when its applied history cannot be saved', async () => {
    const f = await fixture(); const review = await f.usage(); const before = f.connections.list(); const app = f.apps.getApp('google', f.app.id);
    f.db.exec("CREATE TRIGGER reject_repair BEFORE UPDATE ON authentication_incident_history WHEN NEW.kind = 'repair' AND json_extract(NEW.data, '$.status') = 'applied' BEGIN SELECT RAISE(ABORT, 'fixture history failure'); END");
    expect(await f.rotate(review)).toMatchObject({ rotation_outcome: { status: 'failed' } }); expect(f.connections.list()).toEqual(before); expect(f.apps.getApp('google', f.app.id)).toEqual(app);
    expect(createAuthenticationIncidentStore(f.db).history({ scope: { kind: 'all' } }, 1_001).repairs![0]).toMatchObject({ status: 'failed' });
  });
  it.each([undefined, null, '2027-11-14'])('replaces the old expiry atomically with the rotation date %s', async expiry => {
    const f = await fixture(); const current = f.apps.getApp('google', f.app.id)!;
    f.apps.saveApp({ ...current, expected_revision: current.revision, secret_expires_on: '2026-10-15' });
    const review = await f.usage(); const result = await f.call({ action: 'rotate_secret', review_id: review.id, fingerprint: review.fingerprint,
      selected_names: ['confirmed'], client_secret: 'fixture-new-secret', attempt_id: 'a'.repeat(43), ...(expiry === undefined ? {} : { secret_expires_on: expiry }) });
    expect(result.rotation_outcome).toMatchObject({ status: 'applied', verification: 'not_checked' });
    expect(f.apps.getApp('google', f.app.id)?.secret_expires_on).toBe(expiry ?? undefined);
    expect((await f.auth('confirmed') as Extract<ConnectionAuth, { type: 'oauth2_refresh' }>).client_secret).toBe('fixture-new-secret');
    const reopened = createOAuthAppUsageService(f.deps);
    expect((await reopened.handle({ action: 'rotation_status', attempt_id: 'a'.repeat(43) })).rotation_outcome).toEqual(result.rotation_outcome);
    expect(result.rotation_outcome?.secret_expires_on).toBe(expiry ?? undefined);
  });
  it('refuses changing the date on a repeated rotation attempt', async () => {
    const f = await fixture(); const review = await f.usage();
    const request = { action: 'rotate_secret' as const, review_id: review.id, fingerprint: review.fingerprint,
      selected_names: ['confirmed'], client_secret: 'fixture-new-secret', attempt_id: 'a'.repeat(43), secret_expires_on: '2027-11-14' };
    const result = await f.call(request); const before = f.connections.list();
    expect((await f.call(request)).rotation_outcome).toEqual(result.rotation_outcome);
    await expect(f.call({ ...request, secret_expires_on: '2028-11-14' })).rejects.toMatchObject({ code: 'conflict' });
    expect(f.connections.list()).toEqual(before);
  });
  it('rejects an impossible rotation date before reserving an attempt or changing credentials', async () => {
    const f = await fixture(); const review = await f.usage(); const before = f.connections.list();
    await expect(f.call({ action: 'rotate_secret', review_id: review.id, fingerprint: review.fingerprint,
      selected_names: ['confirmed'], client_secret: 'fixture-new-secret', attempt_id: 'a'.repeat(43), secret_expires_on: '2027-02-29' })).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.connections.list()).toEqual(before);
    expect(f.db.prepare('SELECT count(*) n FROM oauth_app_secret_rotation_attempts').get()).toEqual({ n: 0 });
  });
  it('rolls back the new date when a rotation receipt cannot be saved', async () => {
    const f = await fixture(); const current = f.apps.getApp('google', f.app.id)!;
    const before = f.apps.saveApp({ ...current, expected_revision: current.revision, secret_expires_on: '2026-10-15' });
    const review = await f.usage(); const copies = f.connections.list();
    f.db.exec("CREATE TRIGGER fail_expiry_receipt BEFORE UPDATE ON oauth_app_secret_rotation_attempts WHEN json_extract(NEW.outcome_json, '$.status') = 'applied' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    const result = await f.call({ action: 'rotate_secret', review_id: review.id, fingerprint: review.fingerprint,
      selected_names: ['confirmed'], client_secret: 'fixture-new-secret', attempt_id: 'a'.repeat(43), secret_expires_on: '2027-11-14' });
    expect(result.rotation_outcome).toMatchObject({ status: 'failed' });
    expect(f.apps.getApp('google', f.app.id)).toEqual(before); expect(f.connections.list()).toEqual(copies);
  });
  it('requires a new usage review after the saved expiry date changes', async () => {
    const f = await fixture(); const review = await f.usage(); const current = f.apps.getApp('google', f.app.id)!;
    f.apps.saveApp({ ...current, expected_revision: current.revision, secret_expires_on: '2027-11-14' });
    await expect(f.rotate(review)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('preserves a date edited while rotation is preparing encrypted credential copies', async () => {
    const f = await fixture(); const review = await f.usage(); const current = f.apps.getApp('google', f.app.id)!;
    const before = f.connections.list(); let edited = false;
    f.hook(() => {
      if (edited) return; edited = true;
      f.apps.saveApp({ ...current, expected_revision: current.revision, secret_expires_on: '2028-01-01' });
    });
    const result = await f.call({ action: 'rotate_secret', review_id: review.id, fingerprint: review.fingerprint,
      selected_names: ['confirmed'], client_secret: 'fixture-new-secret', attempt_id: 'a'.repeat(43), secret_expires_on: '2027-11-14' });
    expect(edited).toBe(true); expect(result.rotation_outcome).toMatchObject({ status: 'failed', reason: 'changed' });
    expect(f.apps.getApp('google', f.app.id)?.secret_expires_on).toBe('2028-01-01');
    expect(f.apps.getClientSecret('google', f.app.id)).toBe('fixture-old-secret'); expect(f.connections.list()).toEqual(before);
  });
  it('distinguishes native references, confirmed copies, unknown origins and another named app', async () => {
    const f = await fixture(); const usage = await f.usage(); expect(isOAuthAppUsageReview(usage)).toBe(true);
    expect(usage.native_accounts).toEqual([{ platform: 'calendar', slug: 'work' }, { platform: 'mail', slug: 'work' }]);
    expect(usage.connections.map(c => [c.name, c.origin, c.selected_by_default])).toEqual([
      ['confirmed', 'confirmed', true], ['excluded', 'confirmed', true], ['legacy', 'unknown', false] ]);
    expect(usage.connections[0]!.uses.map(u => u.kind).sort()).toEqual(['file', 'mail', 'pack', 'recipe', 'schedule']);
    expect(JSON.stringify(usage)).not.toMatch(/fixture-.*secret|access_token|refresh_token|ciphertext/);
  });
  it('updates the app and selected copies atomically while preserving grants, scopes and native sync state', async () => {
    const f = await fixture(); const usage = await f.usage(); const native = f.instances.list(); const tokens = await f.account.getAll();
    const before = f.connections.get('api', 'confirmed')!; const original = await f.auth('confirmed'); const source = f.connections.getAuthSourceId!('api', 'confirmed');
    const skipped = ['excluded', 'legacy', 'another-profile'].map(n => f.connections.get('api', n));
    const observers = vi.fn(() => {
      expect(f.apps.getClientSecret('google', f.app.id)).toBe('fixture-new-secret');
      expect(f.db.prepare('SELECT outcome_json FROM oauth_app_secret_rotation_attempts').get()).toBeTruthy();
    }); f.connections.addOnUpsert(observers);
    const response = await f.rotate(usage);
    expect(response.rotation_outcome).toMatchObject({ status: 'applied', selected_names: ['confirmed'], skipped_names: ['excluded', 'legacy'], verification: 'not_checked' });
    expect(isOAuthAppSecretRotationOutcome(response.rotation_outcome)).toBe(true);
    expect(await f.auth('confirmed')).toEqual({ ...original, client_secret: 'fixture-new-secret' });
    const updated = f.connections.get('api', 'confirmed')!;
    expect(updated).toEqual({ ...before, auth_ciphertext: updated.auth_ciphertext, updated_at: before.updated_at + 1 });
    expect(f.connections.getAuthSourceId!('api', 'confirmed')).toBe(source);
    expect(['excluded', 'legacy', 'another-profile'].map(n => f.connections.get('api', n))).toEqual(skipped);
    expect(f.instances.list()).toEqual(native); expect(await f.account.getAll()).toEqual(tokens); expect(observers).toHaveBeenCalledOnce();
    expect(f.apps.getClientSecret('google', f.other.id)).toBe('fixture-other-secret');
    expect(JSON.stringify(f.db.prepare('SELECT * FROM oauth_app_config').all())).not.toContain('fixture-new-secret');
    expect(JSON.stringify(response)).not.toContain('fixture-new-secret');
  });
  it('lets the owner explicitly include an old copy with unknown origin and records that choice', async () => {
    const f = await fixture(); await f.raw('legacy', { client_secret: 'fixture-older-secret' }); const usage = await f.usage();
    expect(usage.connections.find(c => c.name === 'legacy')).toMatchObject({ origin: 'unknown', secret_matches: false, selected_by_default: false });
    await f.rotate(usage, ['legacy']); expect(await f.auth('legacy')).toMatchObject({ client_secret: 'fixture-new-secret', saved_oauth_app: { issuer: 'google', id: f.app.id } });
  });
  it('requires all shared-grant members and preserves their grant identity', async () => {
    const f = await fixture(); const family = 'g'.repeat(43);
    for (const name of ['one', 'two']) await f.raw(name, { native_credential_id: family, saved_oauth_app: { issuer: 'google', id: f.app.id } });
    const usage = await f.usage(); const group = usage.connections.filter(c => ['one', 'two'].includes(c.name));
    expect(group[0]!.group_id).toBe(group[1]!.group_id); expect(group.every(c => c.selected_by_default)).toBe(true);
    await expect(f.rotate(usage, ['one'])).rejects.toMatchObject({ code: 'bad_request' });
    await f.rotate(usage, ['one', 'two']);
    for (const name of ['one', 'two']) expect(await f.auth(name)).toMatchObject({ native_credential_id: family, client_secret: 'fixture-new-secret' });
  });
  it('does not auto-select an unconfirmed member of a shared authorization', async () => {
    const f = await fixture(); const family = 'g'.repeat(43);
    await f.raw('one', { native_credential_id: family, saved_oauth_app: { issuer: 'google', id: f.app.id } });
    await f.raw('two', { native_credential_id: family }); const usage = await f.usage();
    expect(usage.connections.filter(c => ['one', 'two'].includes(c.name)).every(c => !c.selected_by_default)).toBe(true);
  });
  it('blocks a family that also uses another saved app rather than partially rotating it', async () => {
    const f = await fixture(); const family = 'g'.repeat(43);
    await f.raw('one', { native_credential_id: family, saved_oauth_app: { issuer: 'google', id: f.app.id } });
    await f.raw('two', { native_credential_id: family, saved_oauth_app: { issuer: 'google', id: f.other.id } }); const usage = await f.usage();
    expect(usage.connections.find(c => c.name === 'one')?.group_complete).toBe(false);
    await expect(f.rotate(usage, ['one'])).rejects.toMatchObject({ code: 'bad_request' });
  });
  it.each(['app', 'new copy', 'usage', 'retired', 'expired'] as const)('refuses a review after %s changes', async change => {
    const f = await fixture(); const usage = await f.usage(); const before = f.connections.list();
    if (change === 'app') f.apps.saveApp({ ...f.app, expected_revision: f.app.revision, label: 'Changed' });
    if (change === 'new copy') await f.enroll('new-copy');
    if (change === 'usage') f.uses([]);
    if (change === 'retired') await f.call({ action: 'retire_usage', id: usage.id });
    if (change === 'expired') f.clock(usage.expires_at + 1);
    await expect(f.rotate(usage)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.apps.getClientSecret('google', f.app.id)).toBe('fixture-old-secret');
    expect(f.connections.get('api', 'confirmed')).toEqual(before.find(r => r.name === 'confirmed'));
  });
  it('retains visible native usage and names unreadable copies while locked', async () => {
    const f = await fixture(); f.lock(); const usage = await f.usage();
    expect(usage.native_accounts).toHaveLength(2); expect(usage.can_rotate).toBe(false);
    expect(usage.unreadable_connections).toContain('confirmed');
    await expect(f.rotate(usage)).rejects.toMatchObject({ code: 'locked' });
  });
  it.each(['copy', 'receipt'] as const)('rolls the app, every copy and result back after a %s write failure', async failure => {
    const f = await fixture(); const usage = await f.usage(); const before = f.connections.list(); const observer = vi.fn(); f.connections.addOnUpsert(observer);
    if (failure === 'copy') f.db.exec("CREATE TRIGGER fail_secret_copy BEFORE UPDATE OF auth_json ON connections WHEN NEW.name = 'excluded' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    else f.db.exec("CREATE TRIGGER fail_secret_receipt BEFORE UPDATE ON oauth_app_secret_rotation_attempts WHEN json_extract(NEW.outcome_json, '$.status') = 'applied' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    const response = await f.rotate(usage, ['confirmed', 'excluded']);
    expect(response.rotation_outcome).toMatchObject({ status: 'failed' }); expect(response.rotation_outcome).not.toHaveProperty('app_revision');
    expect(f.apps.getApp('google', f.app.id)).toEqual(f.app); expect(f.apps.getClientSecret('google', f.app.id)).toBe('fixture-old-secret');
    expect(f.connections.list()).toEqual(before); expect(observer).not.toHaveBeenCalled();
  });
  it('preserves a concurrent credential replacement during asynchronous encryption', async () => {
    const f = await fixture(); const usage = await f.usage(); const row = f.connections.get('api', 'confirmed')!;
    let changed = false; f.hook(() => { if (!changed) { changed = true; f.connections.upsert({ ...row, config_json: '{"owner_edit":true}', updated_at: 2000 }); } });
    const response = await f.rotate(usage); expect(response.rotation_outcome).toMatchObject({ status: 'failed', reason: 'changed' });
    expect(f.connections.get('api', 'confirmed')!.config_json).toBe('{"owner_edit":true}');
    expect(f.apps.getClientSecret('google', f.app.id)).toBe('fixture-old-secret');
  });
  it('recovers an applied result and makes repeated apply idempotent without saving the secret in the receipt', async () => {
    const f = await fixture(); const usage = await f.usage(); const result = await f.rotate(usage); const after = f.connections.list();
    expect((await f.rotate(usage)).rotation_outcome).toEqual(result.rotation_outcome);
    const reopened = createOAuthAppUsageService(f.deps);
    expect((await reopened.handle({ action: 'rotation_status', attempt_id: 'a'.repeat(43) })).rotation_outcome).toEqual(result.rotation_outcome);
    expect(f.connections.list()).toEqual(after);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM oauth_app_secret_rotation_attempts').all())).not.toMatch(/fixture-.*secret|client_secret|refresh_token/);
  });
  it('uses the common native migration locks', async () => {
    const f = await fixture(); const usage = await f.usage(); const locks = collectionAuthenticationLocks(f.db); locks.add('mail:work');
    await expect(f.rotate(usage)).rejects.toMatchObject({ code: 'conflict' }); locks.delete('mail:work');
    expect((await f.rotate(usage)).rotation_outcome?.status).toBe('applied');
  });
  it('never selects a saved secret for an untrusted token endpoint', async () => {
    const f = await fixture(); await f.raw('unsafe', { token_endpoint: 'https://example.test/token', saved_oauth_app: { issuer: 'google', id: f.app.id } });
    const usage = await f.usage(); expect(usage.connections.find(c => c.name === 'unsafe')).toMatchObject({ group_complete: false, selected_by_default: false });
    await expect(f.rotate(usage, ['unsafe'])).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('renews native credentials with the rotated app and API copies retain origin through actual renewal', async () => {
    const f = await fixture(); const usage = await f.usage(); await f.rotate(usage);
    const fetcher = vi.fn(async (_url: string, init?: { body?: string }) => {
      expect(new URLSearchParams(init?.body).get('client_secret')).toBe('fixture-new-secret');
      const result = { access_token: 'renewed', refresh_token: 'rotated-refresh', expires_in: 3600, scope: 'read' };
      return { status: 200, ok: true, json: async () => result, text: async () => JSON.stringify(result) };
    });
    await getAccessToken({ provider: 'gmail', slug: 'work', accountStore: f.account, providerConfig: {
      clientId: f.apps.getClientId('google', f.app.id)!, clientSecret: f.apps.getClientSecret('google', f.app.id)!, tokenUrl: GOOGLE_TOKEN_URL }, fetcher, now: () => 1000 });
    const row = f.connections.get('api', 'confirmed')!; const auth = await f.auth('confirmed'); if (auth.type !== 'oauth2_refresh') throw Error('auth');
    const result = await refreshOAuth2WithMetadata(auth, fetcher as unknown as typeof fetch, () => 1000);
    await persistNativeOAuthRenewal({ store: f.connections, encode: encodeAuthForStorage, decode: decodeAuthFromStorage, key: f.key, now: () => 1000 }, row, result.auth);
    expect(await f.auth('confirmed')).toMatchObject({ client_secret: 'fixture-new-secret', saved_oauth_app: { issuer: 'google', id: f.app.id }, refresh_token: 'rotated-refresh' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('keeps Microsoft and Google app copies separate even when Client IDs match', async () => {
    const f = await fixture(); await f.raw('microsoft', { client_id: f.app.client_id, token_endpoint: MICROSOFT_TOKEN_URL });
    const usage = await f.usage(); expect(usage.connections.some(c => c.name === 'microsoft')).toBe(false);
  });
  it('rotates the Microsoft default profile and its native Graph and API uses', async () => {
    const f = await fixture(); const app = f.apps.getApp('microsoft', 'default')!;
    await f.raw('outlook', { client_id: app.client_id, client_secret: 'fixture-ms-secret', token_endpoint: MICROSOFT_TOKEN_URL,
      saved_oauth_app: { issuer: 'microsoft', id: 'default' } });
    const original = f.instances.get('mail', 'work')!;
    f.instances.upsert({ ...original, slug: 'outlook', adapter_type: 'graph', config: {} });
    const response = await f.call({ action: 'usage', issuer: 'microsoft', id: 'default', expected_revision: app.revision });
    expect(response.usage?.native_accounts).toEqual([{ platform: 'mail', slug: 'outlook' }]);
    expect(response.usage?.connections.map(c => c.name)).toEqual(['outlook']);
    await f.rotate(response.usage!, ['outlook']);
    expect(f.apps.getClientSecret('microsoft')).toBe('fixture-new-secret');
    expect(f.apps.getClientSecret('google', f.app.id)).toBe('fixture-old-secret');
    expect(await f.auth('outlook')).toMatchObject({ token_endpoint: MICROSOFT_TOKEN_URL, client_secret: 'fixture-new-secret' });
  });
  it('waits through an in-flight API refresh and keeps its rotated token before refusing a stale preview', async () => {
    const f = await fixture(); const usage = await f.usage(); const row = f.connections.get('api', 'confirmed')!;
    const auth = await f.auth('confirmed'); if (auth.type !== 'oauth2_refresh') throw Error('auth');
    let release!: () => void; const gate = new Promise<void>(done => { release = done; });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { await gate; return Response.json({ access_token: 'refreshed', refresh_token: 'one-use-rotated', expires_in: 3600 }); });
    const renew = createEnsureFreshAuthDetailed({ fetchImpl: fetch, now: () => 1000,
      withAuthRenewal: (r, run) => withCurrentConnectionRenewal(f.connections, r, run),
      persistAuth: async (r, next) => { const blob = await encodeAuthForStorage(next, r, f.key);
        expect(f.connections.persistRefreshedAuth!(r, blob, 1001)).toBe(true); } });
    const refresh = renew(row, { ...auth, expires_at: 0 });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const rotation = f.rotate(usage); let done = false; void rotation.then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false); release(); await refresh;
    expect((await rotation).rotation_outcome).toMatchObject({ status: 'failed', reason: 'changed' });
    expect(await f.auth('confirmed')).toMatchObject({ refresh_token: 'one-use-rotated', client_secret: 'fixture-old-secret' });
    expect(f.apps.getClientSecret('google', f.app.id)).toBe('fixture-old-secret');
  });
  it.each(['file', 'file family', 'probe', 'probe family', 'collection read', 'collection prepare'] as const)(
    'coordinates secret rotation with %s renewal through durable token persistence', async route => {
      const f = await fixture(); const family = 'f'.repeat(43);
      await f.raw('confirmed', { saved_oauth_app: { issuer: 'google', id: f.app.id }, expires_at: 0,
        ...(route.includes('family') || route === 'collection read' ? { native_credential_id: family } : {}) });
      const row = f.connections.get('api', 'confirmed')!;
      const base = 'https://www.googleapis.com/calendar/v3';
      f.connections.upsert({ ...row, config_json: JSON.stringify({ base_url: base, vendor: 'generic' }) });
      const usage = await f.usage(); let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const fetchImpl = vi.fn<typeof fetch>(async url => {
        if (new URL(String(url)).hostname === 'oauth2.googleapis.com') {
          await gate;
          return Response.json({ access_token: 'refreshed', refresh_token: 'one-use-rotated', expires_in: 3600 });
        }
        return Response.json({ items: [] });
      });
      const sources = createCollectionOAuthSources({ store: f.connections, broker: { fetch: vi.fn() },
        decode: decodeAuthFromStorage, encode: encodeAuthForStorage, key: f.key, now: () => 1000, fetchImpl });
      const run = () => route.startsWith('file')
        ? createFileSourceConnectionResolver({ connectionStore: f.connections, decodeAuthFromStorage, encodeAuthForStorage,
          keyProvider: f.key, fetchImpl, now: () => 1000 })('confirmed')
        : route.startsWith('probe') ? handleConnectionProbe({ store: f.connections, getEncryptionKey: f.key,
          resolveFetch: fetchImpl, fetcher: async () => Response.json({ items: [] }), now: () => 1000 }, { kind: 'api', name: 'confirmed' })
        : route === 'collection prepare' ? sources.prepare('gcal', 'confirmed', [])
        : sources.fetch('gcal', { type: 'direct_oauth', connection_name: 'confirmed', native_credential_id: family,
          target_origin: new URL(base).origin })(base + '/users/me/calendarList', { method: 'GET' });
      const refresh = run();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
      let completed = false; const rotation = f.rotate(usage).finally(() => { completed = true; });
      // Leave time for an incorrectly unleased rotation to reach its SQLite commit.
      await new Promise(resolve => setTimeout(resolve, 40)); const completedBeforeRenewal = completed;
      release(); await refresh;
      expect((await rotation).rotation_outcome).toMatchObject({ status: 'failed', reason: 'changed' });
      expect(completedBeforeRenewal).toBe(false);
      expect(await f.auth('confirmed')).toMatchObject({ refresh_token: 'one-use-rotated', client_secret: 'fixture-old-secret' });
      expect(f.apps.getClientSecret('google', f.app.id)).toBe('fixture-old-secret');
    });
  it('preserves each shared-grant member\'s saved-app origin, including unknown origin, during renewal', async () => {
    const f = await fixture(); const family = 'f'.repeat(43);
    for (const [name, origin] of [['one', f.app.id], ['two', f.other.id], ['unknown', undefined]] as const) {
      await f.raw(name, { native_credential_id: family, required_scopes: [name],
        ...(origin ? { saved_oauth_app: { issuer: 'google', id: origin } } : {}) });
    }
    const row = f.connections.get('api', 'one')!; const auth = await f.auth('one'); if (auth.type !== 'oauth2_refresh') throw Error('auth');
    await persistNativeOAuthRenewal({ store: f.connections, decode: decodeAuthFromStorage, encode: encodeAuthForStorage,
      key: f.key, now: () => 1000 }, row, { ...auth, refresh_token: 'rotated', current_access_token: 'fresh' });
    for (const [name, origin] of [['one', f.app.id], ['two', f.other.id], ['unknown', undefined]] as const) {
      const saved = await f.auth(name); if (saved.type !== 'oauth2_refresh') throw Error('auth');
      expect(saved.refresh_token).toBe('rotated'); expect(saved.required_scopes).toEqual([name]);
      expect(saved.saved_oauth_app).toEqual(origin ? { issuer: 'google', id: origin } : undefined);
    }
  });
  it('keeps local saved-app origins when shared-grant callers join one renewal flight', async () => {
    const f = await fixture(); const family = 'f'.repeat(43);
    await f.raw('one', { native_credential_id: family, expires_at: 0, saved_oauth_app: { issuer: 'google', id: f.app.id } });
    await f.raw('two', { native_credential_id: family, expires_at: 0, saved_oauth_app: { issuer: 'google', id: f.other.id } });
    await f.raw('unknown', { native_credential_id: family, expires_at: 0 });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async () => { await gate; return Response.json({ access_token: 'fresh', expires_in: 3600 }); });
    const renew = createEnsureFreshAuthDetailed({ fetchImpl, now: () => 1000, persistAuth: async () => {} });
    const input = await Promise.all(['one', 'two', 'unknown'].map(async name => ({ row: f.connections.get('api', name)!, auth: await f.auth(name) })));
    const flights = input.map(({ row, auth }) => renew(row, auth)); release(); const results = await Promise.all(flights);
    expect(fetchImpl).toHaveBeenCalledOnce();
    results.forEach((result, i) => {
      if (result.auth.type !== 'oauth2_refresh' || input[i]!.auth.type !== 'oauth2_refresh') throw Error('auth');
      expect(result.auth.saved_oauth_app).toEqual(input[i]!.auth.saved_oauth_app);
    });
  });
  it('repairs a missing saved secret through coordinated rotation without changing its Client ID or native accounts', async () => {
    const f = await fixture(); const native = f.instances.list();
    f.db.prepare('DELETE FROM oauth_app_config WHERE key = ?').run(`google.app.${f.app.id}.client_secret`);
    const usage = await f.usage(); expect(usage.app.has_secret).toBe(false); expect(usage.can_rotate).toBe(true);
    expect(usage.connections.every(c => !c.secret_matches)).toBe(true);
    expect((await f.rotate(usage)).rotation_outcome?.status).toBe('applied');
    expect(f.apps.getClientId('google', f.app.id)).toBe(f.app.client_id);
    expect(f.apps.getClientSecret('google', f.app.id)).toBe('fixture-new-secret');
    expect(f.instances.list()).toEqual(native);
  });
  it('requires an unlocked vault to repair a missing app secret even without API copies', async () => {
    const f = await fixture();
    for (const row of f.connections.list()) f.connections.delete(row.kind, row.name);
    f.db.prepare('DELETE FROM oauth_app_config WHERE key = ?').run(`google.app.${f.app.id}.client_secret`); f.lock();
    const usage = await f.usage(); expect(usage.unreadable_connections).toEqual([]); expect(usage.can_rotate).toBe(false);
    await expect(f.rotate(usage, [])).rejects.toMatchObject({ code: 'locked' });
    expect(f.apps.hasSecret('google', f.app.id)).toBe(false);
  });
  it('marks interrupted pre-commit attempts failed without applying them after reopening', async () => {
    const f = await fixture(); const original = f.apps.getClientSecret('google', f.app.id);
    const outcome = { attempt_id: 'a'.repeat(43), issuer: 'google', app_id: f.app.id, status: 'checking', selected_names: ['confirmed'],
      skipped_names: [], native_accounts: [], verification: 'not_checked' };
    f.db.prepare('INSERT INTO oauth_app_secret_rotation_attempts VALUES (?, ?, ?, ?)').run(outcome.attempt_id, 'r'.repeat(43), 'a'.repeat(64), JSON.stringify(outcome));
    const reopened = createOAuthAppUsageService(f.deps);
    expect((await reopened.handle({ action: 'rotation_status', attempt_id: outcome.attempt_id })).rotation_outcome).toMatchObject({ status: 'failed', reason: 'interrupted' });
    expect(f.apps.getClientSecret('google', f.app.id)).toBe(original);
  });
  it('refuses a queued stale renewal before the provider is called after rotation', async () => {
    const f = await fixture(); const usage = await f.usage(); const row = f.connections.get('api', 'confirmed')!;
    const auth = await f.auth('confirmed'); let release!: () => void;
    if (auth.type !== 'oauth2_refresh') throw Error('auth');
    const held = f.connections.withCredentialLease!(['confirmed'], () => new Promise<void>(done => { release = done; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const rotation = f.rotate(usage);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ access_token: 'unused', expires_in: 3600 }));
    const renew = createEnsureFreshAuthDetailed({ fetchImpl: fetch, now: () => 1000, persistAuth: async () => {},
      withAuthRenewal: (r, run) => withCurrentConnectionRenewal(f.connections, r, run) });
    const pending = renew(row, { ...auth, expires_at: 0 });
    const rejected = expect(pending).rejects.toThrow('changed before credential renewal');
    release(); await held; expect((await rotation).rotation_outcome?.status).toBe('applied'); await rejected;
    expect(fetch).not.toHaveBeenCalled(); expect(await f.auth('confirmed')).toMatchObject({ client_secret: 'fixture-new-secret' });
  });
  it('keeps historical copies visible after a profile Client ID changes, without rotating them', async () => {
    const f = await fixture();
    f.instances.delete('mail', 'work'); f.instances.delete('calendar', 'work');
    f.apps.saveApp({ ...f.app, client_id: 'replacement-client', client_secret: 'fixture-new-secret', expected_revision: f.app.revision });
    const usage = await f.usage();
    expect(usage.connections.find(c => c.name === 'confirmed')).toMatchObject({ origin: 'confirmed', client_id_matches: false, group_complete: false, selected_by_default: false });
    await expect(f.rotate(usage, ['confirmed'])).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('offers an orphaned same-Client-ID copy only as an explicit, unconfirmed choice', async () => {
    const f = await fixture(); f.apps.deleteApp('google', f.other.id, f.other.revision);
    const usage = await f.usage();
    expect(usage.connections.find(c => c.name === 'another-profile')).toMatchObject({ origin: 'unknown', selected_by_default: false });
    await f.rotate(usage, ['another-profile']); expect(await f.auth('another-profile')).toMatchObject({ saved_oauth_app: { issuer: 'google', id: f.app.id } });
  });
});
