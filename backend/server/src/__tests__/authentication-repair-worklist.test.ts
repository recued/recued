import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { isAuthenticationRepairWorklist, type ConnectionAuth, type ConnectionRow, type SourceRegistration, type SavedOAuthApp } from '@recued/contracts';
import { createAuthenticationRepairWorklist, type AuthenticationRepairDeps } from '../authentication-repair-worklist.js';
import type { CollectionInstanceRecord } from '../collections/instance-store.js';
import { createInstanceStore } from '../collections/instance-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createManagedOAuthService } from '../managed-oauth-service.js';
import { createManagedOAuthProfileStore } from '../managed-oauth-profile-store.js';
import { createOAuthAppConfigStore } from '../oauth-app-config-store.js';
import { createWorkEntityStore, ensureWorkEntitySchema } from '../storage/work-entity-store.js';
import { createFileSourceSyncStateStore, ensureFileSourceSyncStateSchema, initialFileSourceSyncState, type FileSourceSyncState } from '../storage/file-source-sync-state.js';
import { decodeAuthFromStorage, encodeAuthForStorage, makeConnectionHandlers } from '../connection-handler.js';

const clock = Date.parse('2026-10-15T12:00:00Z');
const native = (grant = 'grant-one'): ConnectionAuth => ({ type: 'oauth2_refresh', native_credential_id: grant, client_id: 'client',
  client_secret: 'never-export-app-secret', refresh_token: 'never-export-refresh', token_endpoint: 'https://oauth2.googleapis.com/token',
  current_access_token: 'never-export-access', expires_at: clock - 1000 });
const connection = (name = 'work', status = 'auth_failed'): ConnectionRow => ({ pk: 'api/' + name, kind: 'api', name, display_name: name,
  config_json: JSON.stringify({ vendor: 'google', base_url: 'https://www.googleapis.com/drive/v3' }), auth_ciphertext: 'opaque', enrolled_at: 1, updated_at: 2,
  health_json: JSON.stringify({ status, last_probed_at: clock - 100, last_error: 'private vendor error never-export' }) });
const instance = (platform: 'mail' | 'calendar' = 'mail', slug = 'inbox', adapter = 'graph', config: Record<string, unknown> = {}): CollectionInstanceRecord => ({
  platform, slug, adapter_type: adapter, config, auth_state: 'expired', last_synced_at: 3, created_at: 1, updated_at: 2, backfill_complete: true,
  caps: { read: 'yes', write: 'no', delete: 'no', watch: 'poll', mirror: 'disabled', auth: 'oauth', path_style: 'uri' },
});
const source = (name = 'work'): SourceRegistration => ({ id: 'google.' + name + '.file', source_label: name + ' files',
  top_tier_kind: 'file', source_kind: 'connection', sync_posture: 'file_meta_ref', write_capable: false, registered_at: 1 });
const app = (): SavedOAuthApp => ({ issuer: 'microsoft', id: 'default', label: 'Work app', client_id: 'client', has_secret: true, revision: 1, secret_expires_on: '2026-10-20' });
const fixture = (patch: Partial<AuthenticationRepairDeps> = {}) => {
  const rows = [connection()]; const auth = native(); const instances: CollectionInstanceRecord[] = [];
  const deps: AuthenticationRepairDeps = { connections: () => rows, decode: async () => auth, instances: () => instances, sources: () => [],
    apps: () => [], fileState: () => null, connectionUses: () => ({ complete: true, uses: [{ kind: 'pack', id: 'drive', label: 'Drive pack' }] }), now: () => clock, ...patch };
  return { read: createAuthenticationRepairWorklist(deps), deps, rows, instances, auth };
};

describe('passive unified authentication inventory', () => {
  it('projects recorded failures and affected uses without exposing tokens or raw errors', async () => {
    const f = fixture(); const fetch = vi.spyOn(globalThis, 'fetch');
    try { const result = await f.read(); expect(isAuthenticationRepairWorklist(result)).toBe(true);
      expect(result.groups[0]).toMatchObject({ authentication: 'direct_oauth', connection_names: ['work'], usage_available: true,
        issues: [{ code: 'credential_rejected', observed_at: clock - 100 }], uses: [{ kind: 'pack', id: 'drive' }] });
      expect(JSON.stringify(result)).not.toMatch(/never-export|opaque|token_endpoint|client_secret|private vendor/);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it('does not treat a normally expired access token or an old successful check as a failed grant', async () => {
    const f = fixture(); f.rows[0] = connection('work', 'ok');
    expect((await f.read()).groups[0]!.issues).toEqual([]);
  });
  it('does not turn a future-dated rejection into current failure evidence', async () => {
    const f = fixture(); f.rows[0]!.health_json = JSON.stringify({ status: 'auth_failed', last_probed_at: clock + 1 });
    expect((await f.read()).groups[0]!.issues).toEqual([]);
  });
  it('groups shared native grants while keeping different grants with the same Client ID separate', async () => {
    const rows = [connection('one'), connection('two'), connection('separate')];
    const f = fixture({ connections: () => rows, decode: async row => native(row.name === 'separate' ? 'grant-two' : 'grant-one') });
    const result = await f.read(); expect(result.groups).toHaveLength(2);
    expect(result.groups.map(g => g.connection_names).sort()).toEqual([['one', 'two'], ['separate']]);
  });
  it('groups broker references within the same profile, without merging another environment', async () => {
    const rows = [connection('one'), connection('two'), connection('other-environment')];
    const f = fixture({ connections: () => rows, decode: async row => ({ type: 'managed_oauth', broker_profile_id: row.name === 'other-environment' ? 'other' : 'cloud',
      integration_id: 'drive', connection_id: 'account', target_origin: 'https://www.googleapis.com', requested_scopes: [] }) });
    const result = await f.read(); expect(result.groups).toHaveLength(2); expect(result.groups.every(g => g.authentication === 'broker')).toBe(true);
  });
  it('joins linked Mail and Calendar uses to their exact saved connection', async () => {
    const rows = [connection('mail-api'), connection('calendar-api')];
    rows[0]!.config_json = '{"base_url":"https://gmail.googleapis.com/gmail/v1"}'; rows[1]!.config_json = '{"base_url":"https://www.googleapis.com/calendar/v3"}';
    const binding = { type: 'direct_oauth', native_credential_id: 'grant-one' };
    const f = fixture({ connections: () => rows, instances: () => [
      instance('mail', 'inbox', 'gmail', { oauth_connection: { ...binding, connection_name: 'mail-api', target_origin: 'https://gmail.googleapis.com' } }),
      instance('calendar', 'events', 'gcal', { oauth_connection: { ...binding, connection_name: 'calendar-api', target_origin: 'https://www.googleapis.com' } })] });
    const result = await f.read(); expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.uses.map(u => u.kind)).toEqual(['calendar', 'mail', 'pack']);
    expect(result.groups[0]!.issues.map(i => i.code)).toEqual(Array(4).fill('credential_rejected'));
  });
  it('flags a collection still pinned to a replaced native authorization even before its next sync', async () => {
    const row = instance('mail', 'inbox', 'gmail', { oauth_connection: { type: 'direct_oauth', connection_name: 'work', native_credential_id: 'old-grant' } });
    row.auth_state = 'healthy'; const f = fixture({ instances: () => [row] });
    expect((await f.read()).groups[0]!.issues.map(i => i.code)).toContain('binding_changed');
  });
  it('keeps a removed connection visible through the collection repair target', async () => {
    const f = fixture({ connections: () => [], instances: () => [instance('mail', 'inbox', 'gmail', { oauth_connection: { type: 'direct_oauth', connection_name: 'gone' } })] });
    expect((await f.read()).groups[0]).toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: 'connection_missing' })]),
      targets: [{ kind: 'collection', platform: 'mail', slug: 'inbox' }] });
  });
  it('joins the native Microsoft Mail and Calendar grant using account_slug, without joining Google lanes by email', async () => {
    const f = fixture({ connections: () => [], apps: () => [app()], instances: () => [instance('mail', 'inbox', 'graph', { account_slug: 'shared' }),
      instance('calendar', 'events', 'graph', { account_slug: 'shared' }), instance('mail', 'same', 'gmail'), instance('calendar', 'same', 'gcal')] });
    const groups = (await f.read()).groups.filter(g => g.kind === 'account'); expect(groups).toHaveLength(3);
    expect(groups.find(g => g.uses.some(u => u.id === 'inbox'))!.uses).toHaveLength(2);
  });
  it('reports a missing native OAuth app without requiring access to any tokens', async () => {
    const row = instance('mail', 'inbox', 'gmail'); row.auth_state = 'healthy';
    const f = fixture({ connections: () => [], instances: () => [row] });
    expect((await f.read()).groups[0]!.issues[0]!.code).toBe('app_missing');
  });
  it('includes a running Calendar failure without treating historical error counts as current rejection', async () => {
    const row = instance('calendar', 'events', 'graph', { account_email: 'owner@example.test' }); row.auth_state = 'healthy';
    const health = { platform: 'calendar' as const, slug: 'events', state: 'error' as 'error' | 'connected', last_indexed_at: 1, pending_queue_size: 0, error_count_24h: 2 };
    const f = fixture({ connections: () => [], instances: () => [row], apps: () => [{ ...app(), secret_expires_on: '2027-12-01' }], health: () => health });
    expect((await f.read()).groups[0]).toMatchObject({ label: 'owner@example.test', usage_available: false, issues: [{ code: 'access_unconfirmed' }] });
    health.state = 'connected'; expect((await f.read()).groups[0]!.issues).toEqual([]);
  });
  it('keeps file failures unconfirmed rather than diagnosing scopes from provider text', async () => {
    const state: FileSourceSyncState = { ...initialFileSourceSyncState(source().id), degraded: true, last_error_code: 'fetch_policy', last_error_message: 'never-export-raw-error', last_sync_completed_at: clock - 1000 };
    const f = fixture({ sources: () => [source()], fileState: () => state }); const result = await f.read();
    expect(result.groups[0]!.issues.map(i => i.code)).toContain('source_check_failed');
    expect(result.groups[0]!.targets).toContainEqual({ kind: 'file_source', source_id: source().id });
    expect(JSON.stringify(result)).not.toContain('never-export-raw-error');
    state.degraded = false; state.last_error_code = null;
    expect((await f.read()).groups[0]!.issues.some(i => i.code === 'source_check_failed')).toBe(false);
  });
  it('reports an orphaned file source without inventing a saved connection', async () => {
    const f = fixture({ connections: () => [], sources: () => [source('gone')] });
    expect((await f.read()).groups[0]!.issues[0]!.code).toBe('connection_missing');
  });
  it('shows an owner-recorded secret date separately from vendor authentication failure', async () => {
    const f = fixture({ apps: () => [app()], instances: () => [instance('mail')] });
    const expiry = (await f.read()).groups.find(g => g.kind === 'app')!;
    expect(expiry.issues).toMatchObject([{ code: 'secret_expiry', secret_expires_on: '2026-10-20' }]);
    expect(expiry.issues[0]!.message).toContain('does not prove'); expect(expiry.uses).toEqual([{ kind: 'mail', id: 'inbox', label: 'inbox' }]);
  });
  it('reports unavailable inventory and locked credentials without returning a false empty-health claim', async () => {
    const f = fixture({ decode: async () => { throw new Error('never-export-key'); }, instances: () => { throw new Error('never-export-sql'); } });
    delete f.deps.sources; delete f.deps.apps;
    const result = await f.read(); expect(result.unavailable).toHaveLength(4); expect(isAuthenticationRepairWorklist(result)).toBe(true);
    expect(result.groups[0]!.authentication).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('never-export');
  });
  it.each(['unreadable', 'oversized'])('does not diagnose deleted connections from %s inventory', async mode => {
    const row = instance('mail', 'inbox', 'gmail', { oauth_connection: { type: 'direct_oauth', connection_name: 'work', native_credential_id: 'grant-one', target_origin: 'https://gmail.googleapis.com' } });
    row.auth_state = 'healthy';
    const f = fixture({ connections: () => { if (mode === 'unreadable') throw new Error('private database failure');
      return Array.from({ length: 513 }, (_, i) => connection('row-' + i)); }, instances: () => [row], sources: () => [source()] });
    const result = await f.read();
    expect(result.unavailable).toContain('Saved connection status is unavailable.');
    expect(result.groups).toHaveLength(2);
    for (const group of result.groups) {
      expect(group.issues.map(i => i.code)).not.toContain('connection_missing');
      expect(group.issues.map(i => i.code)).toContain('access_unconfirmed');
      expect(group.usage_available).toBe(false);
    }
  });
  it.each(['origin', 'service'])('detects changed direct-OAuth %s pins before a collection sync fails', async change => {
    const saved = connection('work', 'ok'); saved.config_json = JSON.stringify({ base_url: change === 'service' ? 'https://gmail.googleapis.com/other' : 'https://gmail.googleapis.com/gmail/v1' });
    const row = instance('mail', 'inbox', 'gmail', { oauth_connection: { type: 'direct_oauth', connection_name: 'work', native_credential_id: 'grant-one',
      target_origin: change === 'origin' ? 'https://www.googleapis.com' : 'https://gmail.googleapis.com' } }); row.auth_state = 'healthy';
    const f = fixture({ connections: () => [saved], instances: () => [row] });
    expect((await f.read()).groups[0]!.issues.map(i => i.code)).toContain('binding_changed');
  });
  it('detects a changed broker server pin without contacting the broker', async () => {
    const saved = connection('work', 'ok'); saved.config_json = '{"base_url":"https://graph.microsoft.com/v1.0"}';
    const auth: ConnectionAuth = { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'outlook', connection_id: 'account', target_origin: 'https://graph.microsoft.com', requested_scopes: [] };
    const row = instance('calendar', 'events', 'graph', { oauth_connection: { ...auth, type: 'managed_oauth', connection_name: 'work', broker_profile_signature: 'old-server' } }); row.auth_state = 'healthy';
    const f = fixture({ connections: () => [saved], decode: async () => auth, instances: () => [row], brokerProfileSignature: () => 'current-server' });
    expect((await f.read()).groups[0]!.issues.map(i => i.code)).toContain('binding_changed');
  });
  it.each(['direct', 'broker', 'legacy broker'])('retains a working %s collection binding', async kind => {
    const direct = kind === 'direct'; const saved = connection('work', 'ok');
    const origin = direct ? 'https://gmail.googleapis.com' : 'https://graph.microsoft.com';
    saved.config_json = JSON.stringify({ base_url: direct ? origin + '/gmail/v1/' : origin + '/v1.0/' });
    const auth: ConnectionAuth = direct ? native() : { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'outlook', connection_id: 'account', target_origin: origin, requested_scopes: [] };
    const binding = direct ? { type: 'direct_oauth', connection_name: 'work', native_credential_id: 'grant-one', target_origin: origin }
      : { connection_name: 'work', broker_profile_id: 'cloud', integration_id: 'outlook', connection_id: 'account', target_origin: origin,
        ...(kind === 'broker' ? { type: 'managed_oauth', broker_profile_signature: 'current-server' } : {}) };
    const row = instance('mail', 'inbox', direct ? 'gmail' : 'graph', { oauth_connection: binding }); row.auth_state = 'healthy';
    const f = fixture({ connections: () => [saved], decode: async () => auth, instances: () => [row], brokerProfileSignature: () => 'current-server' });
    expect((await f.read()).groups[0]!.issues).toEqual([]);
  });
  it('reports an unavailable broker profile as unconfirmed local status and omits private errors', async () => {
    const f = fixture({ connections: () => [connection('work', 'ok')], decode: async () => ({ type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'drive', connection_id: 'account', target_origin: 'https://www.googleapis.com', requested_scopes: [] }),
      brokerProfileSignature: () => { throw new Error('never-export-profile-key'); } });
    const result = await f.read(); expect(result.groups[0]!.issues.map(i => i.code)).toContain('access_unconfirmed');
    expect(result.unavailable).toContain('Some broker profile status could not be read.');
    expect(JSON.stringify(result)).not.toContain('never-export-profile-key');
  });
  it('fences a broker server change while other credential details are being read', async () => {
    let signature = 'before';
    const f = fixture({ connections: () => [connection('one', 'ok'), connection('two', 'ok')], decode: async row => {
      if (row.name === 'two') signature = 'after';
      return { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'drive', connection_id: row.name, target_origin: 'https://www.googleapis.com', requested_scopes: [] };
    }, brokerProfileSignature: () => signature });
    await expect(f.read()).rejects.toMatchObject({ code: 'conflict' });
  });
  it('fences an account replacement while credentials are being read', async () => {
    const f = fixture(); f.deps.decode = async () => { f.rows[0] = { ...f.rows[0]!, auth_ciphertext: 'replacement' }; return native(); };
    await expect(createAuthenticationRepairWorklist(f.deps)()).rejects.toMatchObject({ code: 'conflict' });
  });
  it('fences an in-place service change while credentials are being read', async () => {
    const f = fixture(); f.deps.decode = async () => {
      f.rows[0]!.config_json = '{"base_url":"https://changed.example.test"}'; return native();
    };
    await expect(f.read()).rejects.toMatchObject({ code: 'conflict' });
  });
  it.each(['api', 'collection'])('reads fresh %s observations after asynchronous credential decoding without a spurious conflict', async lane => {
    let now = clock;
    let account: CollectionInstanceRecord = { ...instance('mail', 'inbox', 'graph'), auth_state: 'healthy' };
    const f = fixture({ instances: () => [account], apps: () => [{ ...app(), secret_expires_on: '2027-12-01' }], now: () => now });
    f.rows[0] = connection('work', 'ok');
    f.deps.decode = async () => {
      now = clock + 5;
      if (lane === 'api') f.rows[0] = { ...f.rows[0]!, last_used_at: now,
        health_json: JSON.stringify({ status: 'auth_failed', last_probed_at: now }) };
      else account = { ...instance('mail', 'inbox', 'graph'), updated_at: now, auth_state: 'expired' };
      return native();
    };
    const result = await createAuthenticationRepairWorklist(f.deps)();
    expect(result.observed_at).toBe(now);
    expect(result.groups.flatMap(group => group.issues)).toContainEqual(expect.objectContaining({ code: 'credential_rejected', observed_at: now }));
    expect(result.unavailable).toEqual([]);
  });
  it('does not silently truncate a large inventory', async () => {
    const f = fixture({ connections: () => Array.from({ length: 513 }, (_, i) => connection('row-' + i)) });
    const result = await f.read(); expect(result.groups).toEqual([]); expect(result.unavailable).toContain('Saved connection status is unavailable.');
  });
});

it('serves the owner worklist without Nango or live calls, preserving encrypted credentials, source and sync state across repeated reads', async () => {
  const db = new Database(':memory:'); const key = () => Buffer.alloc(32, 19);
  try {
    const store = createConnectionStore(db); const instances = createInstanceStore({ db });
    const apps = createOAuthAppConfigStore(db, { getEncryptionKey: key }); apps.setIssuer('google', 'client', 'secret');
    ensureWorkEntitySchema(db); const sources = createWorkEntityStore(db); sources.registerSource(source());
    ensureFileSourceSyncStateSchema(db); const sync = createFileSourceSyncStateStore(db);
    sync.upsert({ ...initialFileSourceSyncState(source().id), cursor_blob: 'never-export-cursor', degraded: true, last_error_code: 'fetch_config' });
    store.upsert({ ...connection(), auth_ciphertext: await encodeAuthForStorage(native(), connection(), key) });
    const row = instance('mail', 'inbox', 'gmail', { oauth_connection: { type: 'direct_oauth', connection_name: 'work', native_credential_id: 'grant-one' } });
    instances.upsert(row);
    const deps: AuthenticationRepairDeps = { connections: () => store.list(), decode: row => decodeAuthFromStorage(row.auth_ciphertext, row, key),
      instances: () => instances.list(), sources: () => sources.listSources('file'), fileState: id => sync.get(id), apps: () => apps.listApps(), now: () => clock };
    const before = { row: store.get('api', 'work'), instance: instances.get('mail', 'inbox'), source: sources.getSource(source().id), sync: sync.get(source().id) };
    const make = () => makeConnectionHandlers({ store, getEncryptionKey: key, authenticationRepairs: createAuthenticationRepairWorklist(deps) })!.handlers;
    for (let i = 0; i < 2; i++) { const result = await make()['collection.connection.managedOAuth']({ action: 'authentication_worklist' }, undefined as never);
      if (result.action !== 'authentication_worklist') throw new Error('Unexpected response'); expect(isAuthenticationRepairWorklist(result.worklist)).toBe(true);
      expect(result.worklist.groups[0]!.issues.length).toBeGreaterThan(0); expect(JSON.stringify(result)).not.toMatch(/never-export|auth_ciphertext|refresh_token/);
    }
    expect({ row: store.get('api', 'work'), instance: instances.get('mail', 'inbox'), source: sources.getSource(source().id), sync: sync.get(source().id) }).toEqual(before);
    await expect(makeConnectionHandlers({ store })!.handlers['collection.connection.managedOAuth']({ action: 'authentication_worklist' }, undefined as never)).rejects.toMatchObject({ code: 'not_configured' });
  } finally { db.close(); }
});

it('reads the real encrypted broker profile locally and detects a removed profile without network or writes', async () => {
  const db = new Database(':memory:'); const key = () => Buffer.alloc(32, 31); const fetchImpl = vi.fn<typeof fetch>();
  try {
    const profiles = createManagedOAuthProfileStore(db, key);
    profiles.save({ id: 'cloud', label: 'Nango Cloud', broker: 'nango', base_url: 'https://api.nango.dev', api_key: 'never-export-broker-key', revision: 1 });
    const store = createConnectionStore(db); const auth: ConnectionAuth = { type: 'managed_oauth', broker_profile_id: 'cloud', integration_id: 'outlook', connection_id: 'account', target_origin: 'https://graph.microsoft.com', requested_scopes: [] };
    const saved = connection('work', 'ok'); saved.config_json = '{"base_url":"https://graph.microsoft.com/v1.0"}';
    store.upsert({ ...saved, auth_ciphertext: await encodeAuthForStorage(auth, saved, key) });
    const broker = createManagedOAuthService({ profiles, listConnections: () => store.list(), decodeAuth: row => decodeAuthFromStorage(row.auth_ciphertext, row, key), fetchImpl });
    const row = instance('calendar', 'events', 'graph', { oauth_connection: { ...auth, type: 'managed_oauth', connection_name: 'work', broker_profile_signature: broker.collectionProfileSignature!('cloud') } }); row.auth_state = 'healthy';
    const f = fixture({ connections: () => store.list(), decode: row => decodeAuthFromStorage(row.auth_ciphertext, row, key), instances: () => [row], brokerProfileSignature: broker.collectionProfileSignature });
    const before = store.list(); expect((await f.read()).groups[0]!.issues).toEqual([]);
    profiles.delete('cloud'); const result = await f.read();
    expect(result.groups[0]!.issues.map(i => i.code)).toContain('access_unconfirmed');
    expect(JSON.stringify(result)).not.toMatch(/never-export|api_key|auth_ciphertext/);
    expect(store.list()).toEqual(before); expect(fetchImpl).not.toHaveBeenCalled();
  } finally { db.close(); }
});
