import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionApiAccessKey, createConnectionApiHandler, type ResolvedCall } from '@recued/ingredients';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import { createAuditLogStore, createInMemoryCollection, type AuditEntry, type ActivityEntry } from '@recued/storage';
import type { NotificationBlock } from '@recued/notification';
import { createAuthenticationAlertStore } from '../authentication-alert-store.js';
import { createAuthenticationAlertRuntime } from '../authentication-alert-runtime.js';
import { createAuthenticationRepairSnapshot } from '../authentication-repair-worklist.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { decodeAuthFromStorage, encodeAuthForStorage } from '../connection-handler.js';
import { createConnectionAccessObserver } from '../connection-access-observer.js';
import { persistNativeOAuthRenewal } from '../native-oauth-renewal.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const clock = Date.parse('2026-10-16T12:00:00Z');
const call: ResolvedCall = { slug: 'read-test', risk_tier: 'read', input: {}, output: {} };
const key = () => Buffer.alloc(32, 73);
const fixture = async (auth: ConnectionAuth = { type: 'bearer', token: 'fixture-access-secret' }) => {
  const db = new Database(':memory:'); cleanups.push(() => db.close()); const store = createConnectionStore(db);
  const identity = { kind: 'api' as const, name: 'work' };
  store.upsert({ ...identity, display_name: 'Work', config_json: '{"base_url":"https://vendor.example.test/v1"}',
    auth_ciphertext: await encodeAuthForStorage(auth, identity, key), enrolled_at: 1, updated_at: 2 });
  const row = () => store.get('api', 'work')!;
  const decode = (r: ConnectionRow) => decodeAuthFromStorage(r.auth_ciphertext, r, key);
  const observe = createConnectionAccessObserver({ store, decode });
  const health = () => JSON.parse(row().health_json ?? '{}') as { status?: string; access_verified_at?: number; last_error?: string };
  const dispatch = (fetchImpl: typeof fetch) => createConnectionApiHandler({ decodeAuth: decode, observeAccess: observe, fetchImpl, now: () => clock,
    persistAuth: (r, next, patch) => persistNativeOAuthRenewal({ store, encode: encodeAuthForStorage, decode: decodeAuthFromStorage, key, now: () => clock }, r, next, patch) });
  return { db, store, row, decode, observe, health, dispatch, auth };
};
describe('API access observations from real encrypted connection rows', () => {
  it.each([false, true])('carries an API rejection and later success to deduplicated owner alerts, including legacy saved health: %s', async legacy => {
    const f = await fixture(); let now = clock; let status = 401;
    const notify = vi.fn<NotificationBlock['notify']>(async () => {});
    const runtime = createAuthenticationAlertRuntime({ store: createAuthenticationAlertStore(f.db), notifier: { notify },
      auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
      read: createAuthenticationRepairSnapshot({ connections: () => f.store.list(), decode: f.decode,
        instances: () => [], sources: () => [], apps: () => [], now: () => now }) });
    const handler = createConnectionApiHandler({ decodeAuth: f.decode, persistAuth: async () => {}, observeAccess: f.observe, now: () => now,
      fetchImpl: async () => new Response('{"native":true}', { status, headers: { 'content-type': 'application/json' } }) });
    try {
      if (legacy) f.store.setHealth('api', 'work', JSON.stringify({ status: 'auth_failed', last_probed_at: clock }));
      else await expect(handler(f.row(), { method: 'GET', path: '/private-data' }, call)).rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
      await runtime.tick(); await runtime.tick(); expect(notify).toHaveBeenCalledTimes(1);
      status = 200; now += 100;
      await handler(f.row(), { method: 'GET', path: '/private-data' }, call); await runtime.tick(); await runtime.tick();
      expect(notify).toHaveBeenCalledTimes(2); expect(notify.mock.calls[1]![0].title).toBe('Connection operation succeeded again');
    } finally { await runtime.stop(); }
  });

  it.each([[false, false], [true, false], [true, true]])('requires every failed API resource to recover, including multiple resources %s and calls between polls %s', async (multiple, burst) => {
    const f = await fixture(); let now = clock;
    const notify = vi.fn<NotificationBlock['notify']>(async () => {});
    const runtime = createAuthenticationAlertRuntime({ store: createAuthenticationAlertStore(f.db), notifier: { notify },
      auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
      read: createAuthenticationRepairSnapshot({ connections: () => f.store.list(), decode: f.decode,
        instances: () => [], sources: () => [], apps: () => [], now: () => now }) });
    const invoke = async (path: string, status: number, poll = true) => {
      now += 100;
      const handler = createConnectionApiHandler({ decodeAuth: f.decode, persistAuth: async () => {}, observeAccess: f.observe, now: () => now,
        fetchImpl: async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }) });
      const request = handler(f.row(), { method: 'GET', path }, call);
      if (status === 200) await request; else await expect(request).rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
      if (poll) await runtime.tick();
    };
    try {
      await invoke('/private-first', 403);
      if (multiple) await invoke('/private-second', 403);
      await invoke('/public', 200); expect(notify).toHaveBeenCalledTimes(1);
      await invoke('/private-first', 200, !burst); expect(notify).toHaveBeenCalledTimes(multiple ? 1 : 2);
      if (multiple) { await invoke('/private-second', 200); expect(notify).toHaveBeenCalledTimes(2); }
    } finally { await runtime.stop(); }
  });

  it('keeps failed-resource proof through automatic token renewal and drops it when the credential family changes', async () => {
    const f = await fixture({ type: 'oauth2_refresh', native_credential_id: 'first-family', client_id: 'client', refresh_token: 'old-refresh',
      token_endpoint: 'https://oauth.example.test/token', current_access_token: 'old-access', expires_at: clock + 100 });
    const resource = connectionApiAccessKey('GET', 'https://vendor.example.test/private');
    await f.observe(f.row(), f.auth, { status: 'auth_failed', at: clock, base_url: 'https://vendor.example.test/v1', check_key: resource });
    const renewed: ConnectionAuth = { ...f.auth, type: 'oauth2_refresh', native_credential_id: 'first-family', client_id: 'client',
      token_endpoint: 'https://oauth.example.test/token', refresh_token: 'new-refresh', current_access_token: 'new-access', expires_at: clock + 3600 };
    f.store.upsert({ ...f.row(), auth_ciphertext: await encodeAuthForStorage(renewed, f.row(), key), updated_at: clock + 1 });
    await f.observe(f.row(), renewed, { status: 'ok', at: clock + 1, base_url: 'https://vendor.example.test/v1', check_key: resource });
    expect(JSON.parse(f.row().health_json!)).toMatchObject({ access_checks: [{ key: resource, status: 'ok', at: clock + 1 }] });
    const replacement: ConnectionAuth = { ...renewed, native_credential_id: 'second-family' };
    f.store.upsert({ ...f.row(), auth_ciphertext: await encodeAuthForStorage(replacement, f.row(), key), updated_at: clock + 2 });
    await f.observe(f.row(), replacement, { status: 'ok', at: clock + 2, base_url: 'https://vendor.example.test/v1', check_key: resource });
    expect(JSON.parse(f.row().health_json!)).toMatchObject({ access_checks: [{ key: resource, status: 'ok', at: clock + 2, recent: true }] });
    expect(f.row().health_json).not.toMatch(/old-refresh|new-refresh|new-access|first-family|second-family|vendor\.example/);
  });

  it.each([200, 401, 403, 404, 429, 500])('records only the meaning of HTTP %s and keeps the native result/error behavior', async status => {
    const f = await fixture(); const network = vi.fn<typeof fetch>(async () => new Response('{"vendor_field":{"native_value":7}}', { status, headers: { 'content-type': 'application/json' } }));
    const handler = f.dispatch(network);
    if (status === 200) {
      await expect(handler(f.row(), { method: 'GET', path: '/items' }, call)).resolves.toMatchObject({ status: 200, result: { vendor_field: { native_value: 7 } } });
      expect(f.health()).toMatchObject({ status: 'ok', access_verified_at: clock });
    } else {
      await expect(handler(f.row(), { method: 'GET', path: '/items' }, call)).rejects.toBeDefined();
      expect(f.health().status).toBe(status === 401 || status === 403 ? 'auth_failed' : status === 404 ? undefined : 'unreachable');
    }
    expect(network).toHaveBeenCalledTimes(1); expect(JSON.stringify(f.health())).not.toContain('fixture-access-secret');
  });

  it('records a network failure without changing an uncertain write into a retry', async () => {
    const f = await fixture(); const network = vi.fn<typeof fetch>(async () => { throw new Error('private credential in network error'); });
    await expect(f.dispatch(network)(f.row(), { method: 'POST', path: '/items', 'body.name': 'test' }, { ...call, risk_tier: 'write' })).rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
    expect(f.health()).toMatchObject({ status: 'unreachable', last_error: 'The service could not be reached or returned a temporary error.' }); expect(network).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invalid_grant', 400, 'auth_failed'], ['invalid_client', 400, 'auth_failed'], ['temporarily_unavailable', 503, 'unreachable'],
    ['invalid_request', 400, undefined], ['invalid_scope', 400, undefined], ['private-unknown-error', 400, undefined],
    ['invalid_grant', 503, 'unreachable'], ['invalid_grant', 429, 'unreachable'],
  ])('classifies token-endpoint %s without parsing provider descriptions or treating every 400 as a dead token', async (error, status, expected) => {
    const f = await fixture({ type: 'oauth2_refresh', client_id: 'client', client_secret: 'fixture-secret', refresh_token: 'fixture-refresh',
      token_endpoint: 'https://oauth.example.test/token', expires_at: clock - 1 });
    const network = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error, error_description: 'private body secret' }), { status, headers: { 'content-type': 'application/json' } }));
    await expect(f.dispatch(network)(f.row(), { method: 'GET', path: '/items' }, call)).rejects.toMatchObject({ code: 'TOKEN_REFRESH_FAILED' });
    expect(f.health().status).toBe(expected); expect(network).toHaveBeenCalledTimes(1); expect(JSON.stringify(f.health())).not.toMatch(/private|fixture-secret/);
  });

  it('accepts the just-persisted renewal and marks a completed operation as positive evidence', async () => {
    const f = await fixture({ type: 'oauth2_refresh', native_credential_id: 'native-grant', client_id: 'client', refresh_token: 'fixture-refresh',
      token_endpoint: 'https://oauth.example.test/token', expires_at: clock - 1 });
    const original = f.row(); const network = vi.fn<typeof fetch>(async input => new Response(JSON.stringify(input.toString().includes('/token')
      ? { access_token: 'fixture-new-access', expires_in: 3600 } : { items: [] }), { headers: { 'content-type': 'application/json' } }));
    await f.dispatch(network)(original, { method: 'GET', path: '/items' }, call);
    expect(f.row().auth_ciphertext).not.toBe(original.auth_ciphertext); expect(f.health()).toMatchObject({ status: 'ok', access_verified_at: clock });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('does not let an old request report recovery for a credential replaced while it was in flight', async () => {
    const f = await fixture(); const original = f.row(); let finish!: (response: Response) => void;
    let sent!: () => void; const sending = new Promise<void>(resolve => { sent = resolve; });
    const network = vi.fn<typeof fetch>(async () => { sent(); return new Promise<Response>(resolve => { finish = resolve; }); });
    const result = f.dispatch(network)(original, { method: 'GET', path: '/items' }, call); await sending;
    f.store.upsert({ ...f.row(), auth_ciphertext: await encodeAuthForStorage({ type: 'bearer', token: 'other-secret' }, f.row(), key), updated_at: 3,
      health_json: JSON.stringify({ status: 'auth_failed', last_probed_at: clock - 1 }) });
    finish(new Response('{"items":[]}', { headers: { 'content-type': 'application/json' } })); await result;
    expect(f.health().status).toBe('auth_failed'); expect(f.health().access_verified_at).toBeUndefined();
  });

  it('fences service/configuration changes, asynchronous decode races and newer observations', async () => {
    const f = await fixture(); const original = f.row();
    f.store.upsert({ ...original, config_json: '{"base_url":"https://other.example.test/v1"}', updated_at: 3 });
    await f.observe(original, f.auth, { status: 'ok', at: clock, base_url: 'https://vendor.example.test/v1' }); expect(f.health()).toEqual({});
    f.store.upsert(original);
    const observer = createConnectionAccessObserver({ store: f.store, decode: async row => {
      const decoded = await f.decode(row); f.store.upsert({ ...row, auth_ciphertext: 'replacement', updated_at: 4 }); return decoded;
    } });
    await observer(original, f.auth, { status: 'ok', at: clock, base_url: 'https://vendor.example.test/v1' }); expect(f.health()).toEqual({});
    f.store.upsert({ ...original, health_json: JSON.stringify({ status: 'auth_failed', last_probed_at: clock + 1 }) });
    await f.observe(original, f.auth, { status: 'ok', at: clock, base_url: 'https://vendor.example.test/v1' }); expect(f.health().status).toBe('auth_failed');
  });

  it.each([false, true])('keeps independent resource evidence when a newer result wins during decode, including recovery: %s', async recovery => {
    const f = await fixture(); const base = 'https://vendor.example.test/v1';
    let now = clock;
    const privateKey = connectionApiAccessKey('GET', base + '/private'); const publicKey = connectionApiAccessKey('GET', base + '/public');
    const notify = vi.fn<NotificationBlock['notify']>(async () => {});
    const runtime = createAuthenticationAlertRuntime({ store: createAuthenticationAlertStore(f.db), notifier: { notify },
      auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
      read: createAuthenticationRepairSnapshot({ connections: () => f.store.list(), decode: f.decode,
        instances: () => [], sources: () => [], apps: () => [], now: () => now }) });
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const decoding = new Promise<void>(resolve => { entered = resolve; });
    const delayed = createConnectionAccessObserver({ store: f.store, decode: async row => {
      const auth = await f.decode(row); entered(); await held; return auth;
    } });
    try {
      if (recovery) {
        await f.observe(f.row(), f.auth, { status: 'auth_failed', at: clock, base_url: base, check_key: privateKey });
        await runtime.tick(); expect(notify).toHaveBeenCalledTimes(1);
      }
      const older = delayed(f.row(), f.auth, { status: recovery ? 'ok' : 'auth_failed', at: clock + 1, base_url: base, check_key: privateKey });
      await decoding;
      await f.observe(f.row(), f.auth, { status: 'ok', at: clock + 2, base_url: base, check_key: publicKey });
      release(); await older;
      expect(JSON.parse(f.row().health_json!)).toMatchObject({ status: 'ok', last_probed_at: clock + 2,
        access_verified_at: clock + 2, access_check_key: publicKey,
        access_checks: expect.arrayContaining([{ key: privateKey, status: recovery ? 'ok' : 'auth_failed', at: clock + 1 }]) });
      now = clock + 3; await runtime.tick();
      expect(notify).toHaveBeenCalledTimes(recovery ? 2 : 1);
      expect(notify.mock.calls.at(-1)![0].title).toBe(recovery ? 'Connection operation succeeded again' : 'Connection access was rejected');
    } finally { release(); await runtime.stop(); }
  });

  it('does not let an older success erase a newer rejection for the same resource', async () => {
    const f = await fixture(); const base = 'https://vendor.example.test/v1';
    const resource = connectionApiAccessKey('GET', base + '/private');
    await f.observe(f.row(), f.auth, { status: 'auth_failed', at: clock + 2, base_url: base, check_key: resource });
    const latest = JSON.parse(f.row().health_json!);
    await f.observe(f.row(), f.auth, { status: 'ok', at: clock + 1, base_url: base, check_key: resource });
    expect(JSON.parse(f.row().health_json!)).toEqual(latest);
  });

  it.each([false, true])('does not reopen a resource from a delayed failure after its newer first success, including subsequent unrelated traffic: %s', async otherTraffic => {
    const f = await fixture(); const base = 'https://vendor.example.test/v1';
    const resource = connectionApiAccessKey('GET', base + '/private');
    await f.observe(f.row(), f.auth, { status: 'ok', at: clock + 2, base_url: base, check_key: resource });
    if (otherTraffic) await f.observe(f.row(), f.auth, { status: 'ok', at: clock + 3, base_url: base,
      check_key: connectionApiAccessKey('GET', base + '/other') });
    await f.observe(f.row(), f.auth, { status: 'auth_failed', at: clock + 1, base_url: base, check_key: resource });
    const read = createAuthenticationRepairSnapshot({ connections: () => f.store.list(), decode: f.decode,
      instances: () => [], sources: () => [], apps: () => [], now: () => clock + 4 });
    expect((await read()).worklist.groups[0]!.issues).toEqual([]);
  });

  it('does not evict recovery proof during a burst of unrelated successful requests between alert polls', async () => {
    const f = await fixture(); const base = 'https://vendor.example.test/v1'; let now = clock;
    const resource = connectionApiAccessKey('GET', base + '/private');
    const notify = vi.fn<NotificationBlock['notify']>(async () => {});
    const runtime = createAuthenticationAlertRuntime({ store: createAuthenticationAlertStore(f.db), notifier: { notify },
      auditLog: createAuditLogStore(createInMemoryCollection<AuditEntry>(), createInMemoryCollection<ActivityEntry>()),
      read: createAuthenticationRepairSnapshot({ connections: () => f.store.list(), decode: f.decode,
        instances: () => [], sources: () => [], apps: () => [], now: () => now }) });
    try {
      await f.observe(f.row(), f.auth, { status: 'auth_failed', at: now, base_url: base, check_key: resource });
      await runtime.tick(); expect(notify).toHaveBeenCalledTimes(1);
      await f.observe(f.row(), f.auth, { status: 'ok', at: ++now, base_url: base, check_key: resource });
      for (let i = 0; i < 70; i++) await f.observe(f.row(), f.auth, { status: 'ok', at: ++now, base_url: base,
        check_key: connectionApiAccessKey('GET', base + '/public/' + i) });
      await runtime.tick();
      expect(notify).toHaveBeenCalledTimes(2); expect(notify.mock.calls[1]![0].title).toBe('Connection operation succeeded again');
    } finally { await runtime.stop(); }
  });

  it.each([false, true])('keeps over-limit resource history unconfirmed, including recent-only history: %s', async recent => {
    const f = await fixture(); const base = 'https://vendor.example.test/v1';
    await f.observe(f.row(), f.auth, { status: 'auth_failed', at: clock, base_url: base, check_key: connectionApiAccessKey('GET', base + '/private') });
    f.store.setHealth('api', 'work', JSON.stringify({ ...JSON.parse(f.row().health_json!), status: 'ok', last_probed_at: clock + 1, access_verified_at: clock + 1,
      access_checks: Array.from({ length: 65 }, (_, i) => ({ key: connectionApiAccessKey('GET', base + '/' + i),
        status: recent ? 'ok' : 'auth_failed', at: clock + 1, ...(recent ? { recent: true } : {}) })) }));
    const read = createAuthenticationRepairSnapshot({ connections: () => f.store.list(), decode: f.decode,
      instances: () => [], sources: () => [], apps: () => [], now: () => clock + 2 });
    expect((await read()).worklist.groups[0]!.issues.some(issue => issue.message.includes('history is incomplete'))).toBe(true);
  });

  it.each(['ok', 'unreachable'] as const)('keeps a rejection when the same resource reports %s in the same millisecond', async status => {
    const f = await fixture(); const base = 'https://vendor.example.test/v1';
    const rejected = connectionApiAccessKey('GET', base + '/private'); const other = connectionApiAccessKey('GET', base + '/other');
    await f.observe(f.row(), f.auth, { status: 'auth_failed', at: clock, base_url: base, check_key: rejected });
    await f.observe(f.row(), f.auth, { status: 'unreachable', at: clock, base_url: base, check_key: other });
    await f.observe(f.row(), f.auth, { status, at: clock, base_url: base, check_key: rejected });
    const read = createAuthenticationRepairSnapshot({ connections: () => f.store.list(), decode: f.decode,
      instances: () => [], sources: () => [], apps: () => [], now: () => clock + 1 });
    expect((await read()).worklist.groups[0]!.issues.some(issue => issue.code === 'credential_rejected')).toBe(true);
    await f.observe(f.row(), f.auth, { status: 'ok', at: clock + 1, base_url: base, check_key: rejected });
    expect((await read()).worklist.groups[0]!.issues.some(issue => issue.code === 'credential_rejected')).toBe(false);
  });

  it('does not report access recovery on an unreadable response or a refusal of the operation itself', async () => {
    const f = await fixture();
    await expect(f.dispatch(async () => new Response('{', { headers: { 'content-type': 'application/json' } }))(f.row(), { method: 'GET', path: '/items' }, call)).rejects.toBeDefined();
    expect(f.health()).toEqual({});
  });

  it('preserves a successful operation when its reporting hook throws', async () => {
    const f = await fixture(); const network = vi.fn<typeof fetch>(async () => new Response('{"native":true}', { headers: { 'content-type': 'application/json' } }));
    const handler = createConnectionApiHandler({ decodeAuth: f.decode, persistAuth: async () => {}, fetchImpl: network,
      observeAccess: async () => { throw new Error('report unavailable'); } });
    await expect(handler(f.row(), { method: 'GET', path: '/items' }, call)).resolves.toMatchObject({ result: { native: true } }); expect(network).toHaveBeenCalledTimes(1);
  });

  it('records raw broker requests using the same observer and response shape', async () => {
    const auth: ConnectionAuth = { type: 'managed_oauth', broker_profile_id: 'nango', integration_id: 'sheets', connection_id: 'account',
      target_origin: 'https://vendor.example.test', requested_scopes: ['sheets'] };
    const f = await fixture(auth); const native = vi.fn<typeof fetch>(); const broker = vi.fn(async () => new Response('{"vendor":[1,2]}', { headers: { 'content-type': 'application/json' } }));
    const handler = createConnectionApiHandler({ decodeAuth: f.decode, persistAuth: async () => {}, observeAccess: f.observe, managedOAuthFetch: broker, fetchImpl: native, now: () => clock });
    await expect(handler(f.row(), { method: 'GET', path: '/items' }, call)).resolves.toMatchObject({ result: { vendor: [1, 2] } });
    expect(native).not.toHaveBeenCalled(); expect(broker).toHaveBeenCalledTimes(1); expect(f.health().status).toBe('ok');
  });
});
