import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionAuth } from '@recued/contracts';
import { createAuthenticationAccessChecks } from '../authentication-access-checks.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { encodeAuthForStorage, decodeAuthFromStorage } from '../connection-auth-storage.js';
import { createManagedOAuthService } from '../managed-oauth-service.js';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';

const dbs: Database.Database[] = []; afterEach(() => dbs.splice(0).forEach(db => db.close()));
const fixture = async (kind: 'bearer' | 'direct' | 'broker' = 'direct') => {
  const db = new Database(':memory:'); dbs.push(db); const key = () => new Uint8Array(32).fill(5); const store = createConnectionStore(db);
  let anonymous = 401; let authenticated = 200; let refreshed = false;
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const u = new URL(String(input));
    if (u.pathname === '/token') { refreshed = true; return Response.json({ access_token: 'refreshed-secret', refresh_token: 'rotated-secret', expires_in: 3600 }); }
    return new Response('{}', { status: new Headers(init?.headers).has('authorization') ? authenticated : anonymous });
  });
  const profiles = createManagedOAuthProfileStore(db, key);
  profiles.save({ id: 'team', label: 'Team', broker: 'nango', base_url: 'https://api.nango.dev', api_key: 'never-export-broker-key', revision: 1 });
  const broker = createManagedOAuthService({ profiles, listConnections: () => store.list(), decodeAuth: row => decodeAuthFromStorage(row.auth_ciphertext, row, key), fetchImpl, now: () => 1000 });
  const auth: ConnectionAuth = kind === 'bearer' ? { type: 'bearer', token: 'never-export-token' } : kind === 'broker'
    ? { type: 'managed_oauth', broker_profile_id: 'team', integration_id: 'vendor', connection_id: 'owner', target_origin: 'https://vendor.test', requested_scopes: ['read'] }
    : { type: 'oauth2_refresh', native_credential_id: 'native-family', client_id: 'app', client_secret: 'app-secret', refresh_token: 'refresh-secret',
      token_endpoint: 'https://vendor.test/token', current_access_token: 'access-secret', expires_at: 1000000 };
  const put = async (next: ConnectionAuth = auth) => store.upsert({ kind: 'api', name: 'work', display_name: 'Work', enrolled_at: 1, updated_at: 2,
    config_json: JSON.stringify({ vendor: 'custom', base_url: 'https://vendor.test/v1' }), auth_ciphertext: await encodeAuthForStorage(next, { kind: 'api', name: 'work' }, key) });
  await put();
  const prepare = createAuthenticationAccessChecks({ store, key, broker, instances: createInstanceStore({ db }), source: () => undefined, fetchImpl, now: () => 1000 });
  return { db, store, key, prepare, put, auth, broker, profiles, fetchImpl, refreshed: () => refreshed,
    anonymous: (n: number) => { anonymous = n; }, authenticated: (n: number) => { authenticated = n; } };
};

describe('saved API authentication protected reads', () => {
  it('refuses an unsaved renewed OAuth token before reading a protected resource', async () => {
    const f = await fixture(); if (f.auth.type !== 'oauth2_refresh') throw new Error('native'); await f.put({ ...f.auth, expires_at: 900 });
    vi.spyOn(f.store, 'persistRefreshedAuth').mockReturnValue(false);
    const check = await f.prepare({ kind: 'connection', name: 'work' });
    await expect(check.run({ target_id: 'chosen', url: 'https://vendor.test/v1/me' })).rejects.toMatchObject({ code: 'credential_verification_failed' });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1); expect(String(f.fetchImpl.mock.calls[0]![0])).toContain('/token');
  });
  it('supersedes a saved result as soon as its API grant is paused for permission cleanup', async () => {
    const f = await fixture(); f.store.upsert({ ...f.store.get('api', 'work')!, granted_scopes_json: '["read"]' });
    const before = await f.prepare({ kind: 'connection', name: 'work' }); const row = f.store.get('api', 'work')!;
    f.store.replacePermissionCleanupAuth!([{ previous: row, auth_ciphertext: row.auth_ciphertext, granted_scopes_json: row.granted_scopes_json!, updated_at: 3 }], 'cleanup-job', 'pause', () => {});
    const after = await f.prepare({ kind: 'connection', name: 'work' });
    expect(after.descriptor.authentication_revision).not.toBe(before.descriptor.authentication_revision);
    await expect(before.run({ target_id: 'chosen', url: 'https://vendor.test/v1/me' })).rejects.toMatchObject({ code: 'conflict' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('refuses a permission-evidence change while credentials are being decrypted', async () => {
    const f = await fixture(); f.store.upsert({ ...f.store.get('api', 'work')!, granted_scopes_json: '["read"]' });
    const preparing = f.prepare({ kind: 'connection', name: 'work' }); f.store.clearGrantedScopes!(['work']);
    await expect(preparing).rejects.toMatchObject({ code: 'conflict' }); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['bearer', 'direct', 'broker'] as const)('checks saved %s authentication with an anonymous vendor control and no consent receipt', async type => {
    const f = await fixture(type); const before = f.store.get('api', 'work'); const check = await f.prepare({ kind: 'connection', name: 'work' });
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(await check.run({ target_id: 'chosen', url: 'https://vendor.test/v1/account?fields=id' })).toEqual([{ kind: 'api_read', status: 'passed' },
      { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }]);
    expect(f.store.get('api', 'work')).toEqual(before); expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    const first = f.fetchImpl.mock.calls[0]!; expect(first[1]?.method).toBe('GET'); expect(first[1]?.redirect).toBe('error');
    if (type === 'broker') expect(String(first[0])).toContain('api.nango.dev/proxy/');
    const control = f.fetchImpl.mock.calls[1]!; expect(String(control[0])).toContain('vendor.test/v1/account'); expect(new Headers(control[1]?.headers).has('authorization')).toBe(false);
    expect(JSON.stringify(check.descriptor)).not.toMatch(/secret|never-export/);
  });
  it.each([200, 302, 404, 500])('keeps a public or inconclusive control unconfirmed (%s)', async status => {
    const f = await fixture(); f.anonymous(status); const check = await f.prepare({ kind: 'connection', name: 'work' });
    expect((await check.run({ target_id: 'chosen', url: 'https://vendor.test/v1/me' }))[0]).toEqual({ kind: 'api_read', status: 'unconfirmed', reason: 'inconclusive' });
  });
  it.each([401, 403, 429, 500])('classifies authenticated status %s without storing vendor responses', async status => {
    const f = await fixture(); f.authenticated(status); const check = await f.prepare({ kind: 'connection', name: 'work' });
    const result = await check.run({ target_id: 'chosen', url: 'https://vendor.test/v1/me' });
    expect(result[0]!.status).toBe(status === 401 || status === 403 ? 'failed' : 'unconfirmed'); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('requires a chosen API resource and prevents off-vendor reads', async () => {
    const f = await fixture(); const check = await f.prepare({ kind: 'connection', name: 'work' });
    for (const url of [undefined, '', 'https://other.test/v1/me', 'https://vendor.test/private', 'https://vendor.test/v1/me?api_key=secret']) {
      expect((await check.run({ target_id: 'chosen', ...(url ? { url } : {}) }))[0]).toMatchObject({ status: 'unconfirmed', reason: 'resource_required' });
    }
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('renews an expired direct token while retaining its authentication revision', async () => {
    const f = await fixture(); if (f.auth.type !== 'oauth2_refresh') throw new Error('native'); await f.put({ ...f.auth, expires_at: 900 });
    const before = await f.prepare({ kind: 'connection', name: 'work' }); const result = await before.run({ target_id: 'chosen', url: 'https://vendor.test/v1/me' });
    expect(result[0]!.status).toBe('passed'); expect(f.refreshed()).toBe(true);
    const after = await f.prepare({ kind: 'connection', name: 'work' }); expect(after.descriptor.authentication_revision).toBe(before.descriptor.authentication_revision);
    const saved = f.store.get('api', 'work')!; expect(await decodeAuthFromStorage(saved.auth_ciphertext, saved, f.key)).toMatchObject({ current_access_token: 'refreshed-secret', refresh_token: 'rotated-secret' });
  });
  it('detects a saved account replacement or broker key rotation and respects an aborted read', async () => {
    const f = await fixture('broker'); const before = await f.prepare({ kind: 'connection', name: 'work' });
    f.profiles.save({ ...f.profiles.get('team')!, revision: 2, api_key: 'new-key' });
    expect((await f.prepare({ kind: 'connection', name: 'work' })).descriptor.authentication_revision).not.toBe(before.descriptor.authentication_revision);
    await expect(before.run({ target_id: 'chosen', url: 'https://vendor.test/v1/me' })).rejects.toMatchObject({ code: 'conflict' });
    const after = await f.prepare({ kind: 'connection', name: 'work' }); const controller = new AbortController(); controller.abort();
    await expect(after.run({ target_id: 'chosen', url: 'https://vendor.test/v1/me' }, controller.signal)).rejects.toThrow('cancelled'); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
});
