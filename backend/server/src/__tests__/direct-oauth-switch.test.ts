/** D-322 §27 — real encrypted handlers, native vendor reads, and durable switch receipts. */
import Database from 'better-sqlite3';
import { createAuthenticationIncidentStore } from '../authentication-incident-store.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDirectOAuthAuthenticationReview, type ConnectionAuth, type DirectOAuthAuth,
  type ManagedOAuthRequest, type ManagedOAuthMigrationView } from '@recued/contracts';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';
import { createManagedOAuthService } from '../managed-oauth-service.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { makeConnectionHandlers, encodeAuthForStorage, decodeAuthFromStorage } from '../connection-handler.js';
import { createConnectionApiHandler, type ResolvedCall } from '@recued/ingredients';
import { persistNativeOAuthRenewal, decodeCurrentNativeOAuth } from '../native-oauth-renewal.js';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const scope = 'https://www.googleapis.com/auth/gmail.readonly';
const base = 'https://gmail.googleapis.com/gmail/v1';
const url = (name: string): string => base + '/users/me/profile?resource=' + name;
const native: DirectOAuthAuth = { type: 'oauth2_refresh', client_id: 'native-app', client_secret: 'native-secret',
  token_endpoint: 'https://oauth2.googleapis.com/token', refresh_token: 'native-refresh' };
const world = async () => {
  const db = new Database(':memory:'); dbs.push(db); const key = () => new Uint8Array(32).fill(7);
  const store = createConnectionStore(db); const profiles = createManagedOAuthProfileStore(db, key);
  const apps = createOAuthAppConfigStore(db, { getEncryptionKey: key }); apps.setIssuer('google', native.client_id, native.client_secret!);
  let clock = 1000; let email = 'native@example.test'; let grant: string | undefined = scope;
  let tokenFailure = false; let anonymousStatus = 401; let resourceGate: Promise<void> | undefined;
  let tokenLifetime = 3600;
  let uses = [{ kind: 'mail' as const, id: 'inbox', label: 'Inbox' }];
  const denied = new Set<string>();
  const fetch = vi.fn<typeof globalThis.fetch>(async (raw, init) => {
    const u = new URL(String(raw)); const headers = new Headers(init?.headers);
    if (u.hostname === 'oauth2.googleapis.com') {
      if (tokenFailure) return Response.json({ error: 'invalid_client', detail: 'private-native-secret' }, { status: 401 });
      return Response.json({ access_token: 'native-access', refresh_token: 'native-rotated-refresh', expires_in: tokenLifetime,
        ...(grant !== undefined ? { scope: grant } : {}) });
    }
    if (u.hostname === 'gmail.googleapis.com') {
      if (!headers.has('Authorization')) return new Response(null, { status: anonymousStatus });
      if (u.searchParams.has('resource')) {
        await resourceGate;
        if (denied.has(u.searchParams.get('resource')!)) return new Response(null, { status: 403 });
        return Response.json({ private: 'discard-native-response-body' });
      }
      return Response.json({ emailAddress: email });
    }
    // The ordinary Google credential probe uses its registered Drive identity read.
    if (u.hostname === 'www.googleapis.com') return Response.json({ user: { permissionId: 'native-user', emailAddress: email } });
    if (u.pathname === '/integrations') return Response.json({ data: [{ unique_key: 'gmail', provider: 'google-mail' }] });
    if (u.pathname.startsWith('/proxy/')) return Response.json({ emailAddress: 'broker@example.test' });
    throw new Error('Unexpected fixture URL');
  });
  const decode = (r: NonNullable<ReturnType<typeof store.get>>) => decodeAuthFromStorage(r.auth_ciphertext, r, key);
  const broker = createManagedOAuthService({ profiles, listConnections: () => store.list(), decodeAuth: decode, fetchImpl: fetch,
    now: () => clock, requiredScopes: () => [scope], connectionUses: () => ({ uses, complete: true }) });
  const p = await broker.handle({ action: 'save_profile', label: 'Cloud', broker: 'nango', base_url: 'https://api.nango.dev', api_key: 'broker-secret' });
  if (p.action !== 'save_profile') throw new Error('Fixture profile');
  for (const name of ['first', 'second', 'source']) {
    const auth: ConnectionAuth = name === 'source' ? { ...native, current_access_token: 'source-cache', expires_at: 9999999 }
      : { type: 'managed_oauth', broker_profile_id: p.profile.id, integration_id: 'gmail', connection_id: 'old-broker-account',
          target_origin: 'https://gmail.googleapis.com', requested_scopes: [scope], required_scopes: [scope] };
    store.upsert({ kind: 'api', name, display_name: name + ' label', config_json: JSON.stringify({ base_url: base, vendor: 'google', retained: true }),
      auth_ciphertext: await encodeAuthForStorage(auth, { kind: 'api', name }, key), enrolled_at: 1, updated_at: 2,
      subresource_path: '/team', granted_scopes_json: '["old-broker-grant"]', last_used_at: 9 });
  }
  const handlers = makeConnectionHandlers({ store, managedOAuth: broker, oauthAppConfig: apps, getEncryptionKey: key,
    fetcher: (url, init) => fetch(url, init), resolveFetch: fetch, now: () => clock })!.handlers;
  const rpc = (args: ManagedOAuthRequest) => handlers['collection.connection.managedOAuth'](args, undefined as never);
  const review = async (names = ['first'], source = false) => {
    const r = await rpc({ action: 'review_direct_authentication', selections: names.map(name => ({ name, expected_updated_at: 2 })),
      ...(source ? { source_name: 'source' } : { auth: native }), scopes: [scope] });
    if (r.action !== 'review_direct_authentication') throw new Error('Fixture native review'); return r;
  };
  const apply = (r: Awaited<ReturnType<typeof review>>, name = 'first', id = 'direct-oauth-switch-0001', verification_url = url(name)) =>
    rpc({ action: 'apply_authentication_switch', name, expected_updated_at: 2, attempt_id: id, auth: r.auth,
      impact_fingerprint: r.impact.fingerprint, verification_url });
  const until = async (id: string, state: ManagedOAuthMigrationView['state']) => {
    let found!: ManagedOAuthMigrationView;
    await vi.waitFor(async () => {
      const r = await rpc({ action: 'migration_status', id });
      if (r.action !== 'migration_status') throw new Error('Fixture status');
      found = r.migrations[0]!; expect(found?.state).toBe(state);
    }); return found;
  };
  const prepare = async (r: Awaited<ReturnType<typeof review>>, names = ['first', 'second']) => {
    const id = 'direct-migration-fixture-0001';
    await rpc({ action: 'migration_prepare', id, auth: r.auth, impact_fingerprint: r.impact.fingerprint,
      selections: names.map(name => ({ name, expected_updated_at: 2, verification_url: url(name) })) });
    return until(id, 'ready');
  };
  return { db, rpc, store, fetch, decode, review, apply, prepare, until, handlers, profiles, denied,
    grant: (value?: string) => { grant = value; }, tokenFailure: () => { tokenFailure = true; },
    email: (value: string) => { email = value; }, clock: (value: number) => { clock = value; },
    lifetime: (seconds: number) => { tokenLifetime = seconds; },
    anonymous: (value: number) => { anonymousStatus = value; },
    uses: () => { uses = [{ kind: 'mail', id: 'other', label: 'Different mailbox' }]; },
    pause: () => { let resume!: () => void; resourceGate = new Promise(resolve => { resume = resolve; }); return () => { resourceGate = undefined; resume(); }; } };
};

describe('Nango to Recued direct OAuth', () => {
  it('retains the selected saved-app origin through renewal, verification and the durable switch', async () => {
    const w = await world(); const { client_secret: ignored, ...auth } = native; void ignored;
    const review = await w.rpc({ action: 'review_direct_authentication', selections: [{ name: 'first', expected_updated_at: 2 }],
      auth, oauth_app_issuer: 'google', oauth_app_id: 'default', scopes: [scope] });
    if (review.action !== 'review_direct_authentication') throw Error('review');
    const result = await w.apply(review); expect(result).toMatchObject({ verification: { status: 'verified', auth_type: 'oauth2_refresh' } });
    expect(await w.decode(w.store.get('api', 'first')!)).toMatchObject({ saved_oauth_app: { issuer: 'google', id: 'default' } });
    expect(JSON.stringify(review)).not.toContain('native-secret');
  });
  it('reviews a renewed native app without replacing broker credentials or leaking secrets', async () => {
    const w = await world(); const before = w.store.get('api', 'first');
    const r = await w.rpc({ action: 'review_direct_authentication', selections: [{ name: 'first', expected_updated_at: 2 }],
      auth: { ...native, current_access_token: 'owner-cache', expires_at: 99999999 }, scopes: [scope] });
    expect(isDirectOAuthAuthenticationReview(r)).toBe(true); expect(w.store.get('api', 'first')).toEqual(before);
    expect(r).toMatchObject({ impact: { current: { authentication: 'broker', identity: { email: 'broker@example.test' } },
      target: { authentication: 'direct_oauth', identity: { email: 'native@example.test' } } } });
    expect(JSON.stringify(r)).not.toMatch(/native-secret|native-refresh|native-access|broker-secret/);
    expect(w.fetch.mock.calls.some(([u, init]) => String(u).includes('/token') && init?.method === 'POST')).toBe(true);
    expect(JSON.stringify(r)).toContain('reconnect');
  });
  it('keeps the named service and bindings, replaces grant evidence, and records a durable verified result', async () => {
    const w = await world(); const before = w.store.get('api', 'first')!; const r = await w.review();
    const deleted = vi.fn(); w.store.addOnDelete?.(deleted); w.fetch.mockClear();
    const result = await w.apply(r); const after = w.store.get('api', 'first')!;
    expect(result).toMatchObject({ action: 'apply_authentication_switch', verification: { status: 'verified', auth_type: 'oauth2_refresh' } });
    for (const key of ['pk', 'name', 'display_name', 'config_json', 'enrolled_at', 'subresource_path', 'last_used_at'] as const) expect(after[key]).toEqual(before[key]);
    expect(await w.decode(after)).toMatchObject({ type: 'oauth2_refresh', client_id: native.client_id, refresh_token: 'native-rotated-refresh', required_scopes: [scope] });
    expect(after.granted_scopes_json).toBe(JSON.stringify([scope])); expect(deleted).not.toHaveBeenCalled();
    const reads = w.fetch.mock.calls.filter(([u]) => String(u) === url('first'));
    expect(reads).toHaveLength(2); expect(new Headers(reads[0]![1]?.headers).get('Authorization')).toBe('Bearer native-access');
    expect(new Headers(reads[1]![1]?.headers).has('Authorization')).toBe(false);
    expect(w.fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    const count = w.fetch.mock.calls.length; await w.apply(r); expect(w.fetch).toHaveBeenCalledTimes(count);
    const status = await w.handlers['collection.connection.credentialRotationStatus']({ kind: 'api', name: 'first', attempt_id: 'direct-oauth-switch-0001' }, undefined as never);
    expect(status.outcome).toMatchObject({ status: 'succeeded', verification: { auth_type: 'oauth2_refresh' } });
    expect(JSON.stringify(result)).not.toMatch(/native-secret|native-access|discard-native-response-body/);
  });
  it('clears old grant evidence when the native vendor omits its scopes', async () => {
    const w = await world(); w.grant(); const r = await w.review();
    expect(r.warnings.join(' ')).toContain('unconfirmed'); await w.apply(r);
    expect(w.store.get('api', 'first')!.granted_scopes_json).toBeUndefined();
  });
  it('retires discarded native reviews before another attempt can use them', async () => {
    const w = await world(); const before = w.store.get('api', 'first'); const r = await w.review();
    await w.rpc({ action: 'retire_direct_authentication', auth: r.auth });
    await expect(w.apply(r)).rejects.toMatchObject({ code: 'conflict' }); expect(w.store.get('api', 'first')).toEqual(before);
    expect(await w.review()).toMatchObject({ impact: { target: { authentication: 'direct_oauth' } } });
  });
  it.each(['https://other.example.test/private', url('first') + '&access_token=embedded-secret'])('refuses unsafe native access-check destinations: %s', async verification_url => {
    const w = await world(); const r = await w.review(); const before = w.store.get('api', 'first'); w.fetch.mockClear();
    await expect(w.apply(r, 'first', 'unsafe-native-switch-001', verification_url)).rejects.toMatchObject({ code: 'bad_request' });
    expect(w.fetch).not.toHaveBeenCalled(); expect(w.store.get('api', 'first')).toEqual(before);
  });
  it.each(['access', 'public', 'identity', 'usage', 'expired'] as const)('keeps Nango when the %s check fails', async failure => {
    const w = await world(); const before = w.store.get('api', 'first'); const r = await w.review();
    if (failure === 'access') w.denied.add('first'); if (failure === 'public') w.anonymous(200);
    if (failure === 'identity') w.email('different@example.test'); if (failure === 'usage') w.uses();
    if (failure === 'expired') w.clock(r.expires_at + 1);
    await expect(w.apply(r)).rejects.toBeDefined(); expect(w.store.get('api', 'first')).toEqual(before);
  });
  it('rejects a failed token renewal and explicit grants missing the required permissions', async () => {
    const w = await world(); const before = w.store.get('api', 'first'); w.grant('unrelated');
    await expect(w.review()).rejects.toMatchObject({ details: { reason: 'direct_oauth_missing_scopes' } });
    w.tokenFailure(); await expect(w.review()).rejects.toMatchObject({ details: { reason: 'direct_oauth_refresh_failed' } });
    expect(w.store.get('api', 'first')).toEqual(before);
  });
  it('retains native scope needs through normal credential replacement and future migration reviews', async () => {
    const w = await world(); const r = await w.review(); await w.apply(r);
    await w.handlers['collection.connection.rotateCredentials']({ kind: 'api', name: 'first', attempt_id: 'native-followup-rotation-001',
      expected_updated_at: w.store.get('api', 'first')!.updated_at, patch: { auth: native } }, undefined as never);
    expect(await w.decode(w.store.get('api', 'first')!)).toMatchObject({ required_scopes: [scope] });
    expect(await w.rpc({ action: 'migration_candidates', names: ['first'] })).toMatchObject({ candidates: [{ required_scopes: [scope] }] });
  });
  it('keeps a rotated source token when its permissions cannot serve the migration', async () => {
    const w = await world(); const before = w.store.get('api', 'first'); const source = w.store.get('api', 'source')!;
    const sourceAuth = await w.decode(source);
    if (sourceAuth.type !== 'oauth2_refresh') throw new Error('Fixture native source');
    w.store.upsert({ ...source, auth_ciphertext: await encodeAuthForStorage({ ...sourceAuth, required_scopes: [scope, 'mail-send'] }, source, () => new Uint8Array(32).fill(7)) });
    await expect(w.review(['first', 'second'], true)).rejects.toMatchObject({ details: { reason: 'direct_oauth_missing_scopes' } });
    expect(w.store.get('api', 'first')).toEqual(before);
    expect(await w.decode(w.store.get('api', 'source')!)).toMatchObject({ refresh_token: 'native-rotated-refresh', required_scopes: [scope, 'mail-send'] });
  });
  it('keeps a successful source rotation even when its renewed vendor API address is incompatible', async () => {
    const w = await world(); const serviceBase = 'https://original.my.salesforce.com/services/data/v61.0';
    const key = () => new Uint8Array(32).fill(7);
    for (const name of ['first', 'second', 'source']) {
      const before = w.store.get('api', name)!; const auth = await w.decode(before);
      w.store.upsert({ ...before, config_json: JSON.stringify({ base_url: serviceBase, vendor: 'salesforce' }),
        auth_ciphertext: await encodeAuthForStorage(auth.type === 'managed_oauth' ? { ...auth, target_origin: new URL(serviceBase).origin } : auth, before, key) });
    }
    const fetchImpl = w.fetch.getMockImplementation()!;
    w.fetch.mockImplementation(async (raw, init) => {
      const response = await fetchImpl(raw, init);
      if (new URL(String(raw)).hostname !== 'oauth2.googleapis.com') return response;
      return Response.json({ ...await response.json(), instance_url: 'https://different.my.salesforce.com' });
    });
    const saved = w.store.get('api', 'first');
    await expect(w.review(['first', 'second'], true)).rejects.toMatchObject({ code: 'conflict' });
    expect(w.store.get('api', 'first')).toEqual(saved);
    expect(await w.decode(w.store.get('api', 'source')!)).toMatchObject({ refresh_token: 'native-rotated-refresh' });
  });
  it('preserves a concurrent metadata edit during the protected read', async () => {
    const w = await world(); const r = await w.review(); const resume = w.pause(); const applying = w.apply(r);
    const refused = expect(applying).rejects.toMatchObject({ code: 'conflict' });
    await vi.waitFor(() => expect(w.fetch.mock.calls.some(([u]) => String(u) === url('first'))).toBe(true));
    w.store.upsert({ ...w.store.get('api', 'first')!, display_name: 'Changed elsewhere', updated_at: 3 });
    resume(); await refused; expect(await w.decode(w.store.get('api', 'first')!)).toMatchObject({ type: 'managed_oauth' });
  });
  it('keeps a verified native review usable after a failed durable swap transaction', async () => {
    const w = await world(); const before = w.store.get('api', 'first'); const r = await w.review();
    vi.spyOn(w.store, 'completeCredentialRotationAttempt').mockImplementationOnce(() => { throw new Error('fixture transaction failure'); });
    await expect(w.apply(r)).rejects.toThrow('fixture transaction failure'); expect(w.store.get('api', 'first')).toEqual(before);
    expect(await w.apply(r, 'first', 'direct-oauth-switch-0002')).toMatchObject({ verification: { auth_type: 'oauth2_refresh' } });
  });
  it('migrates verified bulk rows, continues after a failure, and preserves the source and remote account', async () => {
    const w = await world(); const oldSecond = w.store.get('api', 'second'); const history = w.profiles.scopeHistorySignature();
    const r = await w.review(['first', 'second'], true); const ready = await w.prepare(r);
    expect(ready.rows.map(row => row.state)).toEqual(['verified', 'verified']);
    w.denied.add('second');
    await w.rpc({ action: 'migration_apply', id: ready.id, fingerprint: ready.fingerprint! });
    const result = await w.until(ready.id, 'completed'); expect(result.rows.map(row => row.state)).toEqual(['migrated', 'failed']);
    const repairHistory = createAuthenticationIncidentStore(w.db).history({ scope: { kind: 'all' } }, 1_001);
    expect(repairHistory.repairs).toHaveLength(2); expect(repairHistory.repairs).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'applied', targets: [{ kind: 'connection', name: 'first' }], from: expect.objectContaining({ type: 'broker' }), to: expect.objectContaining({ type: 'direct_oauth' }) }),
      expect.objectContaining({ status: 'failed', targets: [{ kind: 'connection', name: 'second' }] }),
    ]));
    expect(w.store.get('api', 'second')).toEqual(oldSecond);
    expect(await w.decode(w.store.get('api', 'first')!)).toMatchObject({ type: 'oauth2_refresh' });
    expect(await w.decode(w.store.get('api', 'source')!)).toMatchObject({ type: 'oauth2_refresh', refresh_token: 'native-rotated-refresh' });
    expect(w.profiles.scopeHistorySignature()).toBe(history);
    expect(w.fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/native-secret|native-access|native-rotated-refresh/);
  });
  it('allows later native rows to migrate after an earlier row fails', async () => {
    const w = await world(); const r = await w.review(['first', 'second'], true); const ready = await w.prepare(r); w.denied.add('first');
    await w.rpc({ action: 'migration_apply', id: ready.id, fingerprint: ready.fingerprint! });
    expect((await w.until(ready.id, 'completed')).rows.map(row => row.state)).toEqual(['failed', 'migrated']);
  });
  it.each(['before apply', 'between rows'] as const)('continues a reviewed bulk migration when the source token expires %s', async expiry => {
    const w = await world(); w.lifetime(60);
    const r = await w.review(['first', 'second'], true); const ready = await w.prepare(r);
    if (expiry === 'before apply') w.clock(62_000);
    else {
      const complete = w.store.completeCredentialRotationAttempt!.bind(w.store);
      vi.spyOn(w.store, 'completeCredentialRotationAttempt').mockImplementationOnce(input => {
        const saved = complete(input); w.clock(62_000); return saved;
      });
    }
    await w.rpc({ action: 'migration_apply', id: ready.id, fingerprint: ready.fingerprint! });
    expect((await w.until(ready.id, 'completed')).rows.map(row => row.state)).toEqual(['migrated', 'migrated']);
    for (const name of ['first', 'second', 'source']) expect(await w.decode(w.store.get('api', name)!)).toMatchObject({
      type: 'oauth2_refresh', expires_at: 122_000, required_scopes: [scope],
    });
  });
  it('keeps Nango when the reviewed token expires during its protected read', async () => {
    const w = await world(); w.lifetime(60); const r = await w.review(); const before = w.store.get('api', 'first');
    const resume = w.pause(); const applying = w.apply(r);
    const rejected = expect(applying).rejects.toMatchObject({ code: 'conflict' });
    await vi.waitFor(() => expect(w.fetch.mock.calls.some(([u]) => String(u) === url('first'))).toBe(true));
    w.clock(62_000); resume(); await rejected;
    expect(w.store.get('api', 'first')).toEqual(before);
  });
  it('keeps vendor grant evidence separate from the bounded local permission request', async () => {
    const w = await world(); const granted = [scope, 'email', ...Array.from({ length: 254 }, (_, i) => 'grant-' + i)];
    w.grant(granted.join(' '));
    const r = await w.rpc({ action: 'review_direct_authentication', selections: [{ name: 'first', expected_updated_at: 2 }],
      auth: native, scopes: ['https://www.googleapis.com/auth/userinfo.email'] });
    if (r.action !== 'review_direct_authentication') throw new Error('Fixture native review');
    // Both requested scopes must be granted, with the email alias accepted by Google.
    expect(isDirectOAuthAuthenticationReview(r)).toBe(true);
    expect(r.auth.requested_scopes).toEqual([scope, 'https://www.googleapis.com/auth/userinfo.email'].sort());
    await w.apply(r);
    expect(JSON.parse(w.store.get('api', 'first')!.granted_scopes_json!)).toEqual([...granted].sort());
  });
  it('refuses an owner edit during automatic source renewal while keeping its usable rotated credentials', async () => {
    const w = await world(); w.lifetime(60);
    const r = await w.review(['first', 'second'], true); const ready = await w.prepare(r);
    const saved = ['first', 'second'].map(name => w.store.get('api', name));
    const persist = w.store.persistRefreshedAuth!.bind(w.store);
    vi.spyOn(w.store, 'persistRefreshedAuth').mockImplementation((before, ...args) => {
      const renewed = persist(before, ...args);
      if (before.name === 'source') w.store.upsert({ ...w.store.get('api', 'source')!, display_name: 'Owner changed source' });
      return renewed;
    });
    w.clock(62_000); await w.rpc({ action: 'migration_apply', id: ready.id, fingerprint: ready.fingerprint! });
    expect((await w.until(ready.id, 'completed')).rows.map(row => row.state)).toEqual(['failed', 'failed']);
    expect(['first', 'second'].map(name => w.store.get('api', name))).toEqual(saved);
    expect(w.store.get('api', 'source')!.display_name).toBe('Owner changed source');
    expect(await w.decode(w.store.get('api', 'source')!)).toMatchObject({ expires_at: 122_000 });
  });
  it('keeps migrated rows usable with strict rotating tokens across separate API handlers and stale row snapshots', async () => {
    const w = await world(); const review = await w.review(['first', 'second'], true); const ready = await w.prepare(review);
    await w.rpc({ action: 'migration_apply', id: ready.id, fingerprint: ready.fingerprint! }); await w.until(ready.id, 'completed');
    const stale = w.store.get('api', 'first')!;
    let time = 4_000_000; let valid = 'native-rotated-refresh'; let renewals = 0;
    const fetchImpl: typeof fetch = async (raw, init) => {
      if (new URL(String(raw)).hostname === 'oauth2.googleapis.com') {
        if (new URLSearchParams(String(init?.body)).get('refresh_token') !== valid) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        valid = 'strict-rotation-' + ++renewals; await new Promise<void>(resolve => setTimeout(resolve, 10));
        return Response.json({ access_token: 'fresh-access-' + renewals, refresh_token: valid, expires_in: 3600, scope });
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fresh-access-' + renewals);
      return Response.json({ vendorField: { unchanged: [1, 2] } });
    };
    const key = () => new Uint8Array(32).fill(7);
    const deps = { fetchImpl, now: () => time,
      decodeAuth: (row: import('@recued/contracts').ConnectionRow) => decodeCurrentNativeOAuth({ store: w.store, decode: decodeAuthFromStorage, key }, row),
      persistAuth: (row: import('@recued/contracts').ConnectionRow, auth: ConnectionAuth, config?: { base_url: string }) =>
        persistNativeOAuthRenewal({ store: w.store, encode: encodeAuthForStorage, decode: decodeAuthFromStorage, key, now: () => time }, row, auth, config) };
    const first = createConnectionApiHandler(deps); const second = createConnectionApiHandler(deps);
    const call: ResolvedCall = { slug: 'native-scope-test', risk_tier: 'read', input: {}, output: {} };
    const invoke = (handler: ReturnType<typeof createConnectionApiHandler>, name: string, row = w.store.get('api', name)!) => handler(row, { method: 'GET', path: '/users/me/profile' }, call);
    await Promise.all([invoke(first, 'first'), invoke(second, 'second')]); expect(renewals).toBe(1);
    for (const name of ['first', 'second', 'source']) expect(await w.decode(w.store.get('api', name)!)).toMatchObject({ refresh_token: valid, required_scopes: [scope] });
    time += 4_000_000;
    const result = await invoke(first, 'first', stale); expect(renewals).toBe(2);
    expect(result).toMatchObject({ result: { vendorField: { unchanged: [1, 2] } } });
    const old = w.store.get('api', 'second')!;
    w.store.upsert({ ...old, auth_ciphertext: await encodeAuthForStorage(native, old, key) });
    await expect(invoke(second, 'second', old)).rejects.toThrow('native account changed');
  });
  it('preserves owner configuration edits without stranding a shared rotating token during encryption', async () => {
    const w = await world(); const review = await w.review(['first', 'second'], true); const ready = await w.prepare(review);
    await w.rpc({ action: 'migration_apply', id: ready.id, fingerprint: ready.fingerprint! }); await w.until(ready.id, 'completed');
    const before = w.store.get('api', 'first')!; const auth = await w.decode(before);
    if (auth.type !== 'oauth2_refresh') throw new Error('Fixture native member');
    const next = { ...auth, refresh_token: 'new-usable-rotation', current_access_token: 'new-access' };
    const key = () => new Uint8Array(32).fill(7);
    let edited = false;
    await persistNativeOAuthRenewal({ store: w.store, decode: decodeAuthFromStorage, key, now: () => 5_000,
      encode: async (value, identity, provider) => {
        const encrypted = await encodeAuthForStorage(value, identity, provider);
        if (!edited) {
          edited = true;
          for (const name of ['first', 'second']) {
            const current = w.store.get('api', name)!;
            w.store.upsert({ ...current, display_name: 'Owner edit ' + name,
              config_json: JSON.stringify({ ...JSON.parse(current.config_json), owner_edit: true }), updated_at: 4_000 });
          }
        }
        return encrypted;
      } }, before, next);
    for (const name of ['first', 'second', 'source']) {
      const current = w.store.get('api', name)!;
      expect(await w.decode(current)).toMatchObject({ refresh_token: 'new-usable-rotation', required_scopes: [scope] });
      if (name !== 'source') {
        expect(current.display_name).toBe('Owner edit ' + name);
        expect(JSON.parse(current.config_json).owner_edit).toBe(true);
      }
    }
  });
  it('keeps surviving members renewed when the owner replaces the initiating credential during encryption', async () => {
    const w = await world(); const r = await w.review(['first', 'second'], true); const ready = await w.prepare(r);
    await w.rpc({ action: 'migration_apply', id: ready.id, fingerprint: ready.fingerprint! }); await w.until(ready.id, 'completed');
    const before = w.store.get('api', 'first')!; const auth = await w.decode(before);
    if (auth.type !== 'oauth2_refresh') throw new Error('Fixture native member');
    const key = () => new Uint8Array(32).fill(7); let edited = false;
    await expect(persistNativeOAuthRenewal({ store: w.store, decode: decodeAuthFromStorage, key, now: () => 5_000,
      encode: async (value, identity, provider) => {
        const encrypted = await encodeAuthForStorage(value, identity, provider);
        if (!edited) {
          edited = true;
          w.store.upsert({ ...before, auth_ciphertext: await encodeAuthForStorage(native, before, key), updated_at: 4_000 });
        }
        return encrypted;
      } }, before, { ...auth, refresh_token: 'surviving-rotation' })).rejects.toThrow('native credential changed');
    expect(await w.decode(w.store.get('api', 'first')!)).toEqual(native);
    for (const name of ['second', 'source']) expect(await w.decode(w.store.get('api', name)!)).toMatchObject({ refresh_token: 'surviving-rotation' });
  });
  it.each([false, true])('persists shared native renewal during a manual probe, with owner edit=%s', async ownerEdit => {
    const w = await world(); const r = await w.review(['first', 'second'], true); const ready = await w.prepare(r);
    await w.rpc({ action: 'migration_apply', id: ready.id, fingerprint: ready.fingerprint! }); await w.until(ready.id, 'completed');
    const fetchImpl = w.fetch.getMockImplementation()!;
    w.fetch.mockImplementation(async (raw, init) => {
      const response = await fetchImpl(raw, init);
      if (new URL(String(raw)).hostname === 'oauth2.googleapis.com') {
        w.clock(4_000_500);
        if (ownerEdit) w.store.upsert({ ...w.store.get('api', 'first')!, display_name: 'Probe owner edit' });
        return Response.json({ access_token: 'probe-access', refresh_token: 'probe-rotation', expires_in: 3600 });
      }
      return response;
    });
    w.clock(4_000_000);
    const probing = w.handlers['collection.connection.probe']({ kind: 'api', name: 'first' }, undefined as never);
    if (ownerEdit) await expect(probing).rejects.toMatchObject({ code: 'conflict' });
    else expect((await probing).connection_updated_at).toBe(w.store.get('api', 'first')!.updated_at);
    for (const name of ['first', 'second', 'source']) expect(await w.decode(w.store.get('api', name)!)).toMatchObject({ refresh_token: 'probe-rotation' });
    if (ownerEdit) expect(w.store.get('api', 'first')!.display_name).toBe('Probe owner edit');
  });
  it('requires an unchanged same-service source and explicit apply; stop prevents replacements', async () => {
    const w = await world(); const old = w.store.get('api', 'first'); const r = await w.review(['first', 'second'], true); const ready = await w.prepare(r);
    expect(w.store.get('api', 'first')).toEqual(old);
    await w.rpc({ action: 'migration_stop', id: ready.id });
    expect(await w.rpc({ action: 'migration_apply', id: ready.id, fingerprint: ready.fingerprint! })).toMatchObject({ migration: { state: 'stopped' } });
    expect(w.store.get('api', 'first')).toEqual(old);
    const source = w.store.get('api', 'source')!;
    w.store.upsert({ ...source, config_json: JSON.stringify({ base_url: 'https://www.googleapis.com/drive/v3', vendor: 'google' }) });
    await expect(w.review(['first', 'second'], true)).rejects.toMatchObject({ code: 'bad_request' });
  });
});
