/** D-322 §26 — encrypted owner handlers, real consent reuse and partial bulk outcomes. */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isManagedOAuthMigrationView, type ManagedOAuthAuth, type ManagedOAuthMigrationView, type ManagedOAuthRequest } from '@recued/contracts';
import { createManagedOAuthService } from '../managed-oauth-service.js';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { decodeAuthFromStorage, encodeAuthForStorage, makeConnectionHandlers } from '../connection-handler.js';
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const scope = 'https://www.googleapis.com/auth/gmail.readonly';
const world = async () => {
  const db = new Database(':memory:'); dbs.push(db); const key = () => new Uint8Array(32).fill(6);
  const profiles = createManagedOAuthProfileStore(db, key); const store = createConnectionStore(db);
  const denied = new Set<string>(); let email = 'selected@example.test'; let refs = [{ kind: 'pack' as const, id: 'mail', label: 'Mail pack' }];
  let clock = 1000; let anonymousStatus = 401; let hook: ((resource: string) => void) | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async (raw, init) => {
    const url = new URL(String(raw)); const headers = new Headers(init?.headers);
    if (url.hostname === 'gmail.googleapis.com') {
      if (headers.has('Authorization')) return Response.json({ emailAddress: 'current@example.test' });
      hook?.(url.searchParams.get('resource') ?? '');
      return new Response(null, { status: anonymousStatus });
    }
    if (url.pathname === '/integrations') return Response.json({ data: [{ unique_key: 'gmail', provider: 'google-mail' }] });
    if (url.pathname === '/integrations/gmail') return Response.json({ data: { unique_key: 'gmail', provider: 'google-mail', credentials: { type: 'OAUTH2', scopes: scope } } });
    if (url.pathname === '/connections') return Response.json({ connections: [{ id: 201, connection_id: 'selected', provider_config_key: 'gmail',
      created: '2026-10-01T00:00:00Z', errors: [] }] });
    if (url.pathname.startsWith('/proxy/')) {
      if (denied.has(url.searchParams.get('resource') ?? '')) return new Response(null, { status: 403 });
      return Response.json({ emailAddress: email, access_token: 'private-vendor-value' });
    }
    throw new Error('Unexpected fixture URL');
  });
  const broker = createManagedOAuthService({ profiles, listConnections: () => store.list(), decodeAuth: r => decodeAuthFromStorage(r.auth_ciphertext, r, key),
    fetchImpl: fetch, now: () => clock, requiredScopes: () => [scope], connectionUses: () => ({ uses: refs, complete: true }) });
  const profile = await broker.handle({ action: 'save_profile', broker: 'nango', label: 'Cloud', base_url: 'https://api.nango.dev', api_key: 'private-broker-key' });
  if (profile.action !== 'save_profile') throw new Error('Fixture profile');
  const target: ManagedOAuthAuth = { type: 'managed_oauth', broker_profile_id: profile.profile.id, integration_id: 'gmail', connection_id: 'selected',
    target_origin: 'https://gmail.googleapis.com', requested_scopes: [scope], required_scopes: [scope] };
  for (const name of ['first', 'second', 'shared']) store.upsert({ kind: 'api', name, display_name: name, updated_at: 2, enrolled_at: 1,
    config_json: '{"base_url":"https://gmail.googleapis.com/gmail/v1","vendor":"google"}',
    auth_ciphertext: await encodeAuthForStorage(name === 'shared' ? target : { type: 'bearer', token: 'private-' + name }, { kind: 'api', name }, key) });
  profiles.rememberAccountScopes('https://api.nango.dev', 'gmail', JSON.stringify([201, Date.parse('2026-10-01T00:00:00Z')]), [scope]);
  const handlers = makeConnectionHandlers({ store, managedOAuth: broker, getEncryptionKey: key, resolveFetch: fetch, now: () => clock })!.handlers;
  const rpc = (args: ManagedOAuthRequest) => handlers['collection.connection.managedOAuth'](args, undefined as never);
  const begin = async () => {
    const request = { profile_id: profile.profile.id, integration_id: 'gmail', connection_id: 'selected', name: 'first',
      expected_updated_at: 2, switch_authentication: true as const, include_account_impact: true as const,
      base_url: 'https://gmail.googleapis.com/gmail/v1', vendor: 'google', scopes: [scope] };
    const preview = await rpc({ action: 'preview', ...request }); if (preview.action !== 'preview') throw new Error('Fixture preview');
    const started = await rpc({ action: 'start', ...request, preview_fingerprint: preview.preview.fingerprint });
    if (started.action !== 'reuse') throw new Error('Fixture reuse');
    const impact = await rpc({ action: 'account_impact', flow_id: started.flow_id, claim_secret: started.claim_secret });
    if (impact.action !== 'account_impact') throw new Error('Fixture impact');
    return { auth: started.auth, impact_fingerprint: impact.impact.fingerprint };
  };
  const wait = async (id: string, phase: 'ready' | 'completed' | 'stopped'): Promise<ManagedOAuthMigrationView> => {
    for (let i = 0; i < 200; i++) {
      const r = await rpc({ action: 'migration_status', id });
      if (r.action === 'migration_status' && r.migrations[0]?.state === phase) return r.migrations[0];
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('Fixture migration did not settle');
  };
  const prepare = async (id = 'bulk-migration-test-001') => {
    const grant = await begin();
    const request = { action: 'migration_prepare' as const, id, ...grant, selections: ['first', 'second'].map(name => ({
      name, expected_updated_at: 2, verification_url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile?resource=' + name })) };
    await rpc(request); return { request, review: await wait(id, 'ready') };
  };
  return { store, broker, profiles, fetch, rpc, begin, prepare, wait, denied, key,
    changeRefs: () => { refs = [...refs, { kind: 'pack', id: 'new', label: 'New pack' }]; },
    email: (value: string) => { email = value; }, clock: (value: number) => { clock = value; },
    anonymous: (value: number) => { anonymousStatus = value; },
    hook: (value: (resource: string) => void) => { hook = value; },
    decode: (name: string) => decodeAuthFromStorage(store.get('api', name)!.auth_ciphertext, { kind: 'api', name }, key) };
};
describe('D-322 bulk authentication migration', () => {
  it('rejects unknown actions without applying an already verified review', async () => {
    const w = await world(); const { review } = await w.prepare(); const before = w.store.list();
    await expect(w.rpc({ action: 'migration_typo', id: review.id, fingerprint: review.fingerprint! } as unknown as ManagedOAuthRequest))
      .rejects.toMatchObject({ code: 'bad_request' });
    expect(w.store.list()).toEqual(before);
  });
  it('requires a new review when another connection starts sharing the target account', async () => {
    const w = await world(); const { review } = await w.prepare();
    const shared = w.store.get('api', 'shared')!;
    w.store.upsert({ ...shared, name: 'late-shared', updated_at: 3,
      auth_ciphertext: await encodeAuthForStorage(await w.decode('shared'), { kind: 'api', name: 'late-shared' }, w.key) });
    const before = w.store.list();
    await w.rpc({ action: 'migration_apply', id: review.id, fingerprint: review.fingerprint! });
    const result = await w.wait(review.id, 'completed');
    expect(result.rows.map(r => [r.state, r.reason])).toEqual([['failed', 'changed'], ['failed', 'changed']]);
    expect(w.store.list()).toEqual(before);
  });
  it('bounds concurrent preparation requests to sixteen server reviews', async () => {
    const w = await world(); const grant = await w.begin();
    let release!: () => void; let arrived!: () => void; let count = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    const original = w.broker.verifyImpact!.bind(w.broker);
    vi.spyOn(w.broker, 'verifyImpact').mockImplementation(async (...args) => {
      await original(...args); if (++count === 16) arrived(); await gate;
    });
    const pending = Promise.allSettled(Array.from({ length: 17 }, (_, i) => w.rpc({
      action: 'migration_prepare', id: 'bulk-concurrent-review-' + i, ...grant,
      selections: ['first', 'second'].map(name => ({ name, expected_updated_at: 2,
        verification_url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile?resource=' + name })),
    })));
    await ready; await new Promise<void>(resolve => setImmediate(resolve)); release(); const prepared = await pending;
    for (const r of prepared) if (r.status === 'fulfilled' && r.value.action === 'migration_prepare') await w.wait(r.value.migration.id, 'ready');
    const result = await w.rpc({ action: 'migration_status' });
    if (result.action !== 'migration_status') throw new Error('Fixture status');
    expect(result.migrations.length).toBeLessThanOrEqual(16);
  });
  it.each([null, {}, { name: 'first', expected_updated_at: '2', verification_url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' }])(
    'rejects malformed selection %j before transferring authorization', async selection => {
      const w = await world(); const grant = await w.begin(); const before = w.store.list();
      await expect(w.rpc({ action: 'migration_prepare', id: 'bulk-invalid-selection-001', ...grant,
        selections: [selection] } as unknown as ManagedOAuthRequest)).rejects.toMatchObject({ code: 'bad_request' });
      expect(w.store.list()).toEqual(before); await w.broker.verifySwitchAccount(grant.auth);
    });
  it('reviews and checks every row without changing saved auth or creating more consent', async () => {
    const w = await world(); const before = w.store.list(); w.denied.add('first');
    const { review, request } = await w.prepare();
    expect(isManagedOAuthMigrationView(review)).toBe(true);
    expect(review.rows.map(r => [r.connection.name, r.state])).toEqual([['first', 'failed'], ['second', 'verified']]);
    expect(review.rows[0]!.http_status).toBe(403); expect(w.store.list()).toEqual(before);
    expect(JSON.stringify(review)).not.toMatch(/private-broker-key|private-vendor-value|authorization_receipt|auth_ciphertext/);
    const repeated = await w.rpc(request); expect(repeated).toMatchObject({ action: 'migration_prepare', migration: { id: review.id, fingerprint: review.fingerprint } });
    expect(w.fetch.mock.calls.some(([url]) => String(url).includes('/connect/sessions'))).toBe(false);
  });
  it('keeps a failed first row and migrates the verified second row with its original name and config', async () => {
    const w = await world(); w.denied.add('first'); const original = w.store.get('api', 'first');
    const { review } = await w.prepare();
    await w.rpc({ action: 'migration_apply', id: review.id, fingerprint: review.fingerprint! });
    const result = await w.wait(review.id, 'completed');
    expect(result.rows.map(r => r.state)).toEqual(['failed', 'migrated']);
    expect(w.store.get('api', 'first')).toEqual(original);
    expect(await w.decode('second')).toMatchObject({ type: 'managed_oauth', connection_id: 'selected', required_scopes: [scope] });
    expect(w.store.get('api', 'second')!.config_json).toBe(original!.config_json);
    const calls = w.fetch.mock.calls.length;
    await w.rpc({ action: 'migration_apply', id: review.id, fingerprint: review.fingerprint! });
    expect(w.fetch.mock.calls).toHaveLength(calls);
  });
  it('switches each verified connection once while the common account and dependencies remain pinned', async () => {
    const w = await world(); const { review } = await w.prepare();
    await w.rpc({ action: 'migration_apply', id: review.id, fingerprint: review.fingerprint! });
    const result = await w.wait(review.id, 'completed');
    expect(result.rows.map(r => r.state)).toEqual(['migrated', 'migrated']);
    for (const name of ['first', 'second']) expect(await w.decode(name)).toMatchObject({ type: 'managed_oauth', connection_id: 'selected' });
    expect(w.store.get('api', 'shared')!.updated_at).toBe(2);
  });
  it.each(['uses', 'account', 'native access'])('refuses changed %s after review and preserves failed auth', async changed => {
    const w = await world(); const { review } = await w.prepare(); const before = w.store.list();
    if (changed === 'uses') {
      w.changeRefs(); await expect(w.rpc({ action: 'migration_apply', id: review.id, fingerprint: review.fingerprint! })).rejects.toMatchObject({ code: 'conflict' });
      expect(w.store.list()).toEqual(before); return;
    }
    if (changed === 'account') w.email('another@example.test'); else w.denied.add('first');
    await w.rpc({ action: 'migration_apply', id: review.id, fingerprint: review.fingerprint! });
    const result = await w.wait(review.id, 'completed');
    expect(result.rows[0]!.state).toBe('failed'); expect(w.store.get('api', 'first')).toEqual(before.find(r => r.name === 'first'));
    expect(result.rows[1]!.state).toBe(changed === 'account' ? 'failed' : 'migrated');
  });
  it('blocks late changes in the final swap while retaining a prior successful row', async () => {
    const w = await world(); const { review } = await w.prepare(); const second = w.store.get('api', 'second');
    w.hook(resource => { if (resource === 'second') w.changeRefs(); });
    await w.rpc({ action: 'migration_apply', id: review.id, fingerprint: review.fingerprint! });
    const result = await w.wait(review.id, 'completed');
    expect(result.rows.map(r => r.state)).toEqual(['migrated', 'failed']); expect(w.store.get('api', 'second')).toEqual(second);
  });
  it('stops an unapplied review, releases its account reservation and makes no saved changes', async () => {
    const w = await world(); const before = w.store.list(); const { review } = await w.prepare();
    const r = await w.rpc({ action: 'migration_stop', id: review.id }); expect(r).toMatchObject({ action: 'migration_stop', migration: { state: 'stopped' } });
    await w.rpc({ action: 'migration_apply', id: review.id, fingerprint: review.fingerprint! }); expect(w.store.list()).toEqual(before);
    const next = await w.begin(); expect(next.auth.connection_id).toBe('selected');
  });
  it('stops during the final access check and prevents the current and remaining swaps', async () => {
    const w = await world(); const { review } = await w.prepare(); const before = w.store.list();
    w.hook(resource => { if (resource === 'first') void w.rpc({ action: 'migration_stop', id: review.id }); });
    await w.rpc({ action: 'migration_apply', id: review.id, fingerprint: review.fingerprint! });
    const result = await w.wait(review.id, 'stopped');
    expect(result.rows.map(r => r.state)).toEqual(['skipped', 'skipped']); expect(w.store.list()).toEqual(before);
  });
  it('never accepts a public resource as credential verification', async () => {
    const w = await world(); w.anonymous(200); const before = w.store.list(); const { review } = await w.prepare();
    expect(review.rows.every(r => r.state === 'failed')).toBe(true); expect(w.store.list()).toEqual(before);
  });
  it('expires unused reviews and permits another sign-in review without manual Nango changes', async () => {
    const w = await world(); const { review } = await w.prepare();
    w.clock(review.expires_at + 1);
    expect(await w.rpc({ action: 'migration_status', id: review.id })).toMatchObject({ action: 'migration_status', migrations: [{ state: 'expired' }] });
    const next = await w.begin(); expect(next.auth.connection_id).toBe('selected');
  });
  it('rejects credential-bearing check URLs and an unreviewed apply fingerprint', async () => {
    const w = await world(); const grant = await w.begin(); const before = w.store.list();
    await expect(w.rpc({ action: 'migration_prepare', id: 'bulk-invalid-url-001', ...grant, selections: [{
      name: 'first', expected_updated_at: 2, verification_url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile?access_token=private-query',
    }] })).rejects.toMatchObject({ code: 'bad_request' });
    expect(w.store.list()).toEqual(before);
    await w.broker.verifySwitchAccount(grant.auth);
    await w.rpc({ action: 'migration_prepare', id: 'bulk-valid-review-001', ...grant, selections: [{
      name: 'first', expected_updated_at: 2, verification_url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    }] });
    const review = await w.wait('bulk-valid-review-001', 'ready');
    await expect(w.rpc({ action: 'migration_apply', id: review.id, fingerprint: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'conflict' });
    expect(w.store.list()).toEqual(before);
  });
});
