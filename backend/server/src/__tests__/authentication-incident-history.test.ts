import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAuthenticationIncidentHistoryPage, type ConnectionAuth, type ConnectionRow, type AuthenticationIncidentScope } from '@recued/contracts';
import { createConnectionStore } from '../storage/connection-store.js';
import { createAuthenticationAlertStore, type Episode } from '../authentication-alert-store.js';
import { createAuthenticationRepairSnapshot } from '../authentication-repair-worklist.js';
import { decodeAuthFromStorage, encodeAuthForStorage, makeConnectionHandlers } from '../connection-handler.js';

const clock = Date.parse('2026-10-16T12:00:00Z');
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });
const fixture = async (path = ':memory:') => {
  let now = clock; const db = new Database(path); cleanups.push(() => { if (db.open) db.close(); });
  const connections = createConnectionStore(db); const store = createAuthenticationAlertStore(db); const key = () => Buffer.alloc(32, 41);
  const auth = (id: string): ConnectionAuth => ({ type: 'oauth2_refresh', native_credential_id: id, client_id: 'client', client_secret: 'never-export-secret',
    refresh_token: 'never-export-refresh', token_endpoint: 'https://oauth.example.test/token' });
  const save = async (name = 'work', grant = 'grant-one'): Promise<void> => {
    const row: ConnectionRow = { pk: 'api/' + name, kind: 'api', name, display_name: 'Work account', enrolled_at: 1, updated_at: now,
      config_json: '{"base_url":"https://vendor.example.test"}', auth_ciphertext: '',
      health_json: JSON.stringify({ status: 'auth_failed', last_probed_at: now - 1, last_error: 'never-export-provider-error' }) };
    connections.upsert({ ...row, auth_ciphertext: await encodeAuthForStorage(auth(grant), row, key) });
  };
  const decode = vi.fn(async (row: ConnectionRow) => decodeAuthFromStorage(row.auth_ciphertext, row, key));
  let available = true;
  const read = createAuthenticationRepairSnapshot({ connections: () => { if (!available) throw new Error('private'); return connections.list(); }, decode,
    instances: () => [], sources: () => [], apps: () => [], connectionUses: name => ({ complete: true, uses: [{ kind: 'pack', id: name, label: 'Work Pack' }] }), now: () => now });
  const tick = async (): Promise<void> => { store.evaluate(await read()); };
  const health = (status: 'ok' | 'auth_failed', verified = false, name = 'work'): void => {
    connections.setHealth('api', name, JSON.stringify({ status, last_probed_at: now, ...(verified ? { access_verified_at: now } : {}) }));
  };
  const history = (scope: AuthenticationIncidentScope = { kind: 'all' }, cursor?: string, limit?: number) => store.history({ scope,
    ...(cursor ? { cursor } : {}), ...(limit ? { limit } : {}) }, now);
  await save();
  return { db, connections, store, decode, read, save, tick, health, history, setNow: (value: number) => { now = value; }, setAvailable: (value: boolean) => { available = value; },
    handlers: () => makeConnectionHandlers({ store: connections, authenticationHistory: async query => store.history(query, now), authenticationHistoryExport: async query => store.export(query, now) })!.handlers };
};

describe('retained connection incident history', () => {
  it('exports through the owner RPC using only retained observations and fails clearly when support is unavailable', async () => {
    const f = await fixture(); await f.tick(); const before = f.db.prepare('SELECT * FROM authentication_incident_history').all(); const reads = f.decode.mock.calls.length;
    const response = await f.handlers()['collection.connection.managedOAuth']({ action: 'authentication_history_export', scope: { kind: 'connection', name: 'work' }, filters: { search: ' Work ', type: 'incident' } }, undefined as never);
    expect(response).toMatchObject({ action: 'authentication_history_export', report: { complete: true, entry_count: 1, filters: { search: 'Work', type: 'incident' },
      entries: [{ type: 'incident', outcome: 'open' }] } });
    expect(JSON.stringify(response)).not.toMatch(/never-export|ciphertext|resource_key|required_checks/);
    expect(f.decode).toHaveBeenCalledTimes(reads); expect(f.db.prepare('SELECT * FROM authentication_incident_history').all()).toEqual(before);
    const projection = { handle: vi.fn(), worklist: vi.fn(), history: vi.fn() };
    await makeConnectionHandlers({ store: f.connections, authenticationAccess: projection, authenticationHistoryExport: async query => f.store.export(query, clock) })!
      .handlers['collection.connection.managedOAuth']({ action: 'authentication_history_export', scope: { kind: 'all' } }, undefined as never);
    expect(projection.history).not.toHaveBeenCalled(); expect(projection.handle).not.toHaveBeenCalled(); expect(projection.worklist).not.toHaveBeenCalled();
    await expect(makeConnectionHandlers({ store: f.connections })!.handlers['collection.connection.managedOAuth']({ action: 'authentication_history_export', scope: { kind: 'all' } }, undefined as never)).rejects.toMatchObject({ code: 'not_configured' });
    await expect(f.handlers()['collection.connection.managedOAuth']({ action: 'authentication_history_export', scope: { kind: 'all' }, cursor: 'older' } as never, undefined as never)).rejects.toMatchObject({ code: 'bad_request' });
  });
  it.each([2, 4])('compares actual operation time %s with apply rather than the later passive monitor tick', async operationOffset => {
    const f = await fixture(); await f.tick();
    f.connections.authenticationRepairHistory!.begin('managed_reauthorization', 'proof-clock', { action: 'reauthorize', targets: [{ kind: 'connection', name: 'work' }] }, clock + 1);
    f.connections.authenticationRepairHistory!.finish('managed_reauthorization', 'proof-clock', { status: 'applied' }, clock + 3);
    f.setNow(clock + operationOffset); f.health('ok', true);
    f.setNow(clock + 10); await f.tick();
    const page = f.history(); expect(page.incidents[0]).toMatchObject({ status: 'recovered', ended_at: clock + 10,
      recovery_evidence: { earliest_at: clock + operationOffset, latest_at: clock + operationOffset } });
    expect(page.repairs![0]!.recovery_confirmed_at).toBe(operationOffset > 3 ? clock + operationOffset : undefined);
    expect(isAuthenticationIncidentHistoryPage(page)).toBe(true);
  });
  it('records first and last observations without adding an event per poll; history is passive and redacted', async () => {
    const f = await fixture(); await f.tick(); const first = f.history().incidents[0]!;
    expect(first).toMatchObject({ status: 'open', started_at: clock, last_problem_at: clock, currently_reported: true, events: [{ kind: 'opened', at: clock }] });
    f.setNow(clock + 10); f.health('auth_failed'); await f.tick();
    const before = f.connections.get('api', 'work'); const calls = f.decode.mock.calls.length; const fetch = vi.spyOn(globalThis, 'fetch');
    const page = f.history({ kind: 'connection', name: 'work' });
    expect(page.incidents[0]).toMatchObject({ id: first.id, last_problem_at: clock + 10, events: [{ kind: 'opened' }] });
    expect(isAuthenticationIncidentHistoryPage(page)).toBe(true); expect(JSON.stringify(page)).not.toMatch(/never-export|ciphertext|resource_key|required_checks/);
    expect(f.decode).toHaveBeenCalledTimes(calls); expect(fetch).not.toHaveBeenCalled(); expect(f.connections.get('api', 'work')).toEqual(before);
  });

  it('keeps missing positive evidence distinct from confirmed recovery and preserves a later new incident', async () => {
    const f = await fixture(); await f.tick(); f.setNow(clock + 1); f.health('ok'); await f.tick();
    expect(f.history().incidents[0]).toMatchObject({ status: 'open', currently_reported: false, last_problem_at: clock,
      events: [{ kind: 'opened' }, { kind: 'awaiting_confirmation' }] });
    f.setNow(clock + 2); f.health('ok', true); await f.tick();
    const recovered = f.history().incidents[0]!;
    expect(recovered).toMatchObject({ status: 'recovered', ended_at: clock + 2, last_problem_at: clock,
      recovery_evidence: { earliest_at: clock + 2, latest_at: clock + 2 } });
    expect(recovered.events.at(-1)?.kind).toBe('recovered');
    f.setNow(clock + 3); f.health('auth_failed'); await f.tick();
    const page = f.history(); expect(page.incidents.map(i => i.status)).toEqual(['open', 'recovered']); expect(page.incidents[1]!.id).toBe(recovered.id);
  });

  it('retires a changed authentication without claiming recovery and retains its exact connection association', async () => {
    const f = await fixture(); await f.tick(); f.setNow(clock + 5); await f.save('work', 'replacement-grant'); f.health('ok'); await f.tick();
    const page = f.history({ kind: 'connection', name: 'work' });
    expect(page.incidents).toHaveLength(1); expect(page.incidents[0]).toMatchObject({ status: 'retired', retirement_reason: 'authentication_changed', ended_at: clock + 5 });
    expect(page.incidents[0]!.events.at(-1)?.kind).toBe('retired'); expect(isAuthenticationIncidentHistoryPage(page)).toBe(true);
  });

  it('does not close an account when inventory is unavailable, then records actual removal', async () => {
    const f = await fixture(); await f.tick(); f.setAvailable(false); f.setNow(clock + 1); await f.tick();
    expect(f.history().incidents[0]!.status).toBe('open');
    f.setAvailable(true); f.connections.delete('api', 'work'); f.setNow(clock + 2); await f.tick();
    expect(f.history().incidents[0]).toMatchObject({ status: 'retired', retirement_reason: 'connection_removed' });
  });

  it('records date replacement as retirement and a new reminder incident, never access recovery', async () => {
    const f = await fixture(); const snapshot = await f.read(); const group = snapshot.worklist.groups[0]!;
    group.kind = 'app'; group.connection_names = []; group.targets = [{ kind: 'oauth_apps' }]; group.uses = [];
    group.issues = [{ id: 'c'.repeat(64), code: 'secret_expiry', message: 'Owner-recorded secret date.', secret_expires_on: '2026-10-20' }];
    snapshot.checks = []; f.store.evaluate(snapshot);
    snapshot.worklist.observed_at = clock + 1; group.issues[0]!.secret_expires_on = '2026-10-19'; f.store.evaluate(snapshot); f.setNow(clock + 1);
    const history = f.history({ kind: 'oauth_apps' });
    expect(history.incidents.map(i => i.status)).toEqual(['open', 'retired']);
    expect(history.incidents[1]!.retirement_reason).toBe('expiry_changed_or_removed'); expect(isAuthenticationIncidentHistoryPage(history)).toBe(true);
  });

  it('survives reopening SQLite and paging while newer incidents arrive; cursors cannot switch scopes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-incidents-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'history.sqlite'); const f = await fixture(path);
    for (let n = 0; n < 4; n++) { f.setNow(clock + n * 10); f.health('auth_failed'); await f.tick(); f.setNow(clock + n * 10 + 1); f.health('ok', true); await f.tick(); }
    const page = f.history({ kind: 'connection', name: 'work' }, undefined, 2); expect(page.next_cursor).toBeDefined();
    f.setNow(clock + 50); f.health('auth_failed'); await f.tick(); f.db.close();
    const db = new Database(path); cleanups.push(() => db.close()); const store = createAuthenticationAlertStore(db);
    const older = store.history({ scope: { kind: 'connection', name: 'work' }, cursor: page.next_cursor!, limit: 2 }, clock + 51);
    expect(older.incidents).toHaveLength(2); expect(new Set([...page.incidents, ...older.incidents].map(i => i.id)).size).toBe(4);
    expect(older.next_cursor).toBeUndefined(); expect(store.history({ scope: { kind: 'all' } }, clock + 51).incidents).toHaveLength(5);
    expect(() => store.history({ scope: { kind: 'all' }, cursor: page.next_cursor! })).toThrow('invalid for the selected connection');
    expect(() => store.history({ scope: { kind: 'all' }, cursor: 'not-json' })).toThrow('invalid for the selected connection');
    expect(() => store.history({ scope: { kind: 'all' }, limit: 51 })).toThrow('valid incident history');
  });

  it('retains history after alert deduplication expires and bounds closed history to 90 days', async () => {
    const f = await fixture(); await f.tick(); f.setNow(clock + 1); f.health('ok', true); await f.tick();
    f.setNow(clock + 31 * 86_400_000); await f.tick();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM authentication_alert_episodes').get()).toEqual({ n: 0 }); expect(f.history().incidents).toHaveLength(1);
    f.setNow(clock + 91 * 86_400_000); expect(f.history().incidents).toEqual([]); await f.tick();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM authentication_incident_history').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM authentication_incident_targets').get()).toEqual({ n: 0 });
  });

  it('caps closed incidents without evicting a current incident and removes stale target associations', async () => {
    const f = await fixture(); await f.tick(); const open = f.history().incidents[0]!;
    const add = f.db.prepare('INSERT INTO authentication_incident_history (id, group_id, ended_at, signature, data) VALUES (?, ?, ?, ?, ?)');
    const target = f.db.prepare('INSERT INTO authentication_incident_targets (incident_id, scope_key) VALUES (?, ?)');
    f.db.transaction(() => {
      for (let n = 0; n < 10002; n++) {
        const id = randomUUID(); const closed = { ...open, id, status: 'recovered', currently_reported: false, ended_at: clock + n,
          events: [...open.events, { kind: 'recovered', at: clock + n, level: open.level }] };
        add.run(id, open.group.id, closed.ended_at, '', JSON.stringify(closed)); target.run(id, JSON.stringify({ kind: 'connection', name: 'work' }));
      }
    })();
    f.setNow(clock + 20000); await f.tick();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM authentication_incident_history WHERE ended_at IS NOT NULL').get()).toEqual({ n: 10000 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM authentication_incident_history WHERE ended_at IS NULL').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM authentication_incident_targets WHERE incident_id NOT IN (SELECT id FROM authentication_incident_history)').get()).toEqual({ n: 0 });
  });

  it('imports known earlier alert dates without inventing earlier lifecycle events', async () => {
    const f = await fixture(); await f.tick(); f.db.exec('DELETE FROM authentication_incident_history; DELETE FROM authentication_incident_targets;');
    f.setNow(clock + 5); await f.tick();
    expect(f.history().incidents[0]).toMatchObject({ started_at: clock, history_started_at: clock + 5, events: [{ kind: 'recorded', at: clock + 5 }] });
  });

  it.each(['recovered', 'retired'] as const)('does not invent a last failure time for an imported %s alert', async status => {
    const f = await fixture(); await f.tick(); f.setNow(clock + 5);
    if (status === 'recovered') f.health('ok', true); else f.connections.delete('api', 'work');
    await f.tick(); f.db.exec('DELETE FROM authentication_incident_history; DELETE FROM authentication_incident_targets;');
    f.setNow(clock + 10); await f.tick(); const incident = f.history().incidents[0]!;
    expect(incident).toMatchObject({ status, started_at: clock, ended_at: clock + 5, history_started_at: clock + 10, events: [{ kind: 'recorded', at: clock + 10 }] });
    expect(incident.last_problem_at).toBeUndefined(); expect(isAuthenticationIncidentHistoryPage(f.history())).toBe(true);
  });

  it('preserves the known expiry level of an imported closed alert instead of advancing it at import time', async () => {
    const f = await fixture(); const g = (await f.read()).worklist.groups[0]!;
    g.id = 'c'.repeat(64); g.kind = 'app'; g.targets = [{ kind: 'oauth_apps' }]; g.connection_names = [];
    g.issues = [{ id: 'd'.repeat(64), code: 'secret_expiry', message: 'Owner-recorded secret date.', secret_expires_on: '2026-11-10' }];
    const legacy: Episode = { id: randomUUID(), group_id: g.id, status: 'retired', first_seen_at: clock, last_seen_at: clock + 1,
      problem_since_at: clock, present: true, announced: true, expiry_date: '2026-11-10', last_level: 'expiry_30', issues: g.issues, group: g };
    f.db.prepare('INSERT INTO authentication_alert_episodes (group_id, data) VALUES (?, ?)').run(g.id, JSON.stringify(legacy));
    f.connections.delete('api', 'work'); f.setNow(clock + 27 * 86_400_000); await f.tick();
    const incident = f.history({ kind: 'oauth_apps' }).incidents[0]!;
    expect(incident.level).toBe('expiry_30'); expect(incident.events[0]!.level).toBe('expiry_30'); expect(incident.last_problem_at).toBeUndefined();
  });

  it('keeps known history dates and lifecycle ordering valid across a backward clock correction', async () => {
    const f = await fixture(); await f.tick(); f.setNow(clock - 10); f.health('auth_failed');
    f.connections.upsert({ ...f.connections.get('api', 'work')!, display_name: 'Renamed work' }); await f.tick();
    expect(f.history().incidents[0]!.last_problem_at).toBe(clock);
    expect(f.history().incidents[0]!.events.map(e => e.at)).toEqual([clock, clock]);
    f.connections.delete('api', 'work'); f.setNow(clock - 5); await f.tick();
    const incident = f.history().incidents[0]!; expect(incident.ended_at).toBe(clock);
    expect(incident.events.map(e => e.at)).toEqual([clock, clock, clock]); expect(isAuthenticationIncidentHistoryPage(f.history())).toBe(true);
  });

  it('keeps change-detection storage bounded instead of retaining a second full impact inventory', async () => {
    const f = await fixture(); const snapshot = await f.read(); const g = snapshot.worklist.groups[0]!;
    g.uses = Array.from({ length: 1000 }, (_, i) => ({ kind: 'pack', id: 'pack-' + i, label: 'Long impact label ' + 'x'.repeat(200) + i }));
    f.store.evaluate(snapshot);
    const row = f.db.prepare('SELECT length(signature) AS size FROM authentication_incident_history').get() as { size: number };
    expect(row.size).toBeLessThanOrEqual(128); expect(f.history().incidents[0]!.group.uses).toHaveLength(50);
  });

  it('upgrades earlier plain fingerprints without adding change events to open or closed incidents', async () => {
    const f = await fixture(); const g = (await f.read()).worklist.groups[0]!; await f.tick();
    const plain = JSON.stringify([true, 'rejected', g.label, g.authentication, g.connection_names, g.uses, g.usage_available, g.targets,
      g.issues.map(i => [i.id, i.code, i.secret_expires_on ?? null])]);
    f.db.prepare('UPDATE authentication_incident_history SET signature = ?').run(plain); await f.tick();
    expect(f.history().incidents[0]!.events.map(e => e.kind)).toEqual(['opened']);
    f.setNow(clock + 1); f.health('ok', true); await f.tick();
    const closed = f.history().incidents[0]!; f.db.prepare('UPDATE authentication_incident_history SET signature = ?').run(plain); await f.tick();
    expect(f.history().incidents[0]).toEqual(closed);
    expect(f.db.prepare('SELECT length(signature) AS size FROM authentication_incident_history').get()).toEqual({ size: 64 });
  });

  it('bounds intermediate events and display details while preserving exact lookup for a use outside the preview', async () => {
    const f = await fixture();
    for (let n = 0; n < 40; n++) {
      const snapshot = await f.read(); snapshot.worklist.observed_at = clock + n;
      const group = snapshot.worklist.groups[0]!; group.label = 'Work ' + n;
      group.targets = Array.from({ length: 70 }, (_, i) => ({ kind: 'collection', platform: 'mail', slug: 'mail-' + i }));
      group.uses = Array.from({ length: 70 }, (_, i) => ({ kind: 'mail', id: 'mail-' + i, label: 'Mailbox ' + i })); f.store.evaluate(snapshot);
    }
    f.setNow(clock + 40); const incident = f.history({ kind: 'collection', platform: 'mail', slug: 'mail-69' }).incidents[0]!;
    expect(incident).toMatchObject({ events_truncated: true, details_truncated: true }); expect(incident.events).toHaveLength(32); expect(incident.events[0]!.kind).toBe('opened');
    expect(incident.group.targets).toHaveLength(64); expect(incident.group.uses).toHaveLength(50); expect(isAuthenticationIncidentHistoryPage(f.history())).toBe(true);
  });

  it('rolls back alert and history state together when history storage fails', async () => {
    const f = await fixture(); f.db.exec("CREATE TRIGGER block_incident BEFORE INSERT ON authentication_incident_history BEGIN SELECT RAISE(ABORT, 'fixture blocked'); END");
    await expect(f.tick()).rejects.toThrow('fixture blocked'); expect(f.store.pending()).toEqual([]); expect(f.history().incidents).toEqual([]);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM authentication_alert_episodes').get()).toEqual({ n: 0 });
    f.db.exec('DROP TRIGGER block_incident'); await f.tick(); expect(f.history().incidents).toHaveLength(1);
  });

  it('serves the paired-owner RPC without broker dependencies, credential reads or writes', async () => {
    const f = await fixture(); await f.tick(); const before = f.db.prepare('SELECT data FROM authentication_alert_episodes').all(); const reads = f.decode.mock.calls.length;
    const response = await f.handlers()['collection.connection.managedOAuth']({ action: 'authentication_history', scope: { kind: 'connection', name: 'work' } }, undefined as never);
    if (response.action !== 'authentication_history') throw new Error('Wrong response');
    expect(isAuthenticationIncidentHistoryPage(response.history)).toBe(true); expect(f.decode).toHaveBeenCalledTimes(reads);
    expect(f.db.prepare('SELECT data FROM authentication_alert_episodes').all()).toEqual(before);
    const filtered = await f.handlers()['collection.connection.managedOAuth']({ action: 'authentication_history', scope: { kind: 'connection', name: 'work' },
      filters: { search: ' Work ', type: 'incident', outcome: 'open' } }, undefined as never);
    expect(filtered.action === 'authentication_history' && filtered.history.filters).toEqual({ search: 'Work', type: 'incident', outcome: 'open' });
    expect(f.decode).toHaveBeenCalledTimes(reads); expect(f.db.prepare('SELECT data FROM authentication_alert_episodes').all()).toEqual(before);
    await expect(makeConnectionHandlers({ store: f.connections })!.handlers['collection.connection.managedOAuth']({ action: 'authentication_history', scope: { kind: 'all' } }, undefined as never)).rejects.toMatchObject({ code: 'not_configured' });
    await expect(f.handlers()['collection.connection.managedOAuth']({ action: 'authentication_history', scope: { kind: 'all' }, limit: 0 }, undefined as never)).rejects.toMatchObject({ code: 'bad_request' });
    await expect(f.handlers()['collection.connection.managedOAuth']({ action: 'authentication_history', scope: { kind: 'all' }, filters: { outcome: 'healthy' } as never }, undefined as never)).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('filters incident lifecycle states without treating retirement or a missing problem as recovery', async () => {
    const f = await fixture(); await f.tick(); f.setNow(clock + 1); f.health('ok'); await f.tick();
    const read = (outcome: 'open' | 'retired' | 'recovered') => f.store.history({ scope: { kind: 'all' }, filters: { type: 'incident', outcome } }, clock + 10);
    expect(read('open').incidents).toHaveLength(1); expect(read('recovered').incidents).toEqual([]);
    f.setNow(clock + 2); await f.save('work', 'new-grant'); await f.tick(); expect(read('retired').incidents).toHaveLength(1);
    f.setNow(clock + 3); f.health('auth_failed'); await f.tick(); f.setNow(clock + 4); f.health('ok', true); await f.tick();
    expect(read('recovered').incidents).toHaveLength(1); expect(read('open').incidents).toEqual([]); expect(read('retired').incidents).toHaveLength(1);
  });
});
