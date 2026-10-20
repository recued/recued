import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAuthenticationHistoryExport, authenticationHistoryEntryType, type AuthenticationAccessVerification, type AuthenticationHistoryEntry,
  type AuthenticationIncidentScope, type AuthenticationRepairAction, type AuthenticationRenewalHistory } from '@recued/contracts';
import { createAuthenticationIncidentStore } from '../authentication-incident-store.js';

const now = Date.parse('2026-10-17T12:00:00Z');
const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
const access = (n: number, label = 'Work API'): AuthenticationAccessVerification => ({ id: 'verify-' + String(n).padStart(36, '0'), selection: { kind: 'group', id: 'a'.repeat(64) },
  started_at: now - 1000, finished_at: now, status: 'completed', results: [{ id: 'b'.repeat(64), label, target: { kind: 'connection', name: 'work' },
    authentication_revision: 'c'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] }],
  targets_truncated: false, uses: [], usage_available: true });
const fixture = (path = ':memory:') => {
  const db = new Database(path); databases.push(db); const store = createAuthenticationIncidentStore(db);
  const insert = db.prepare('INSERT INTO authentication_incident_history (id, group_id, ended_at, signature, data, kind) VALUES (?, ?, ?, ?, ?, ?)');
  const add = (value: AuthenticationHistoryEntry, scope: AuthenticationIncidentScope = { kind: 'connection', name: 'work' }) => {
    insert.run(value.id, 'a'.repeat(64), 'finished_at' in value ? value.finished_at ?? null : 'ended_at' in value ? value.ended_at ?? null : null, '', JSON.stringify(value), authenticationHistoryEntryType(value));
    db.prepare('INSERT INTO authentication_incident_targets (incident_id, scope_key) VALUES (?, ?)').run(value.id, JSON.stringify(scope));
  };
  return { db, store, add };
};

describe('complete filtered history export', () => {
  it('holds one snapshot when another WAL connection updates an unread record and inserts a newer one during the read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recued-history-export-')); directories.push(dir); const path = join(dir, 'history.sqlite');
    const f = fixture(path); f.db.pragma('journal_mode = WAL'); f.add(access(1, 'Original older label')); f.add(access(2, 'Original newer label'));
    // A test-only view exposes a read hook without changing the production
    // query. A separate connection commits while the first row is being read.
    f.db.exec('ALTER TABLE authentication_incident_history RENAME TO export_records');
    const writer = new Database(path); databases.push(writer); let wrote = false;
    f.db.function('observe_export_read', (data: unknown) => {
      if (typeof data !== 'string') throw Error('Invalid fixture data');
      if (!wrote) {
        wrote = true;
        writer.prepare('UPDATE export_records SET data = ? WHERE id = ?').run(JSON.stringify(access(1, 'Changed older label')), access(1).id);
        const incoming = access(3, 'Newly inserted label');
        writer.prepare('INSERT INTO export_records (id, group_id, ended_at, signature, data, kind) VALUES (?, ?, ?, ?, ?, ?)')
          .run(incoming.id, 'a'.repeat(64), now, '', JSON.stringify(incoming), 'verification');
      }
      return data;
    });
    f.db.exec('CREATE VIEW authentication_incident_history AS SELECT sequence, id, group_id, ended_at, signature, kind, observe_export_read(data) AS data FROM export_records');
    const labels = () => f.store.export({ scope: { kind: 'all' } }, now).entries.map(e => e.record.id.startsWith('verify-')
      ? (e.record as AuthenticationAccessVerification).results[0]!.label : 'Unexpected kind');
    expect(labels()).toEqual(['Original newer label', 'Original older label']);
    expect(labels()).toEqual(['Newly inserted label', 'Original newer label', 'Changed older label']);
  });
  it('exports every sparse match beyond the 50-row page limit with the exact canonical scope, filters and insertion order', () => {
    const f = fixture(); for (let n = 0; n < 140; n++) f.add(access(n, n % 2 === 0 ? 'École 100%_ reports' : 'Other account'));
    const filters = { search: '  E\u0301COLE 100%_  ', type: 'verification' as const, outcome: 'passed' as const, from: '2026-10-17', through: '2026-10-17' };
    const exported = f.store.export({ scope: { kind: 'connection', name: 'work' }, filters }, now);
    expect(exported).toMatchObject({ entry_count: 70, complete: true, exported_at: now, scope: { kind: 'connection', name: 'work' }, filters: { ...filters, search: 'ÉCOLE 100%_' } });
    expect(exported.entries.map(e => e.record.id)).toEqual(Array.from({ length: 70 }, (_, n) => access(138 - n * 2).id));
    expect(f.store.history({ scope: exported.scope, filters, limit: 50 }, now).order).toHaveLength(50);
    expect(isAuthenticationHistoryExport(exported)).toBe(true); expect(f.store.export({ scope: { kind: 'all' }, filters: { search: "%' OR 1=1 --" } }, now).entry_count).toBe(0);
  });
  it('shares exact target and group associations, including retained references omitted from the display', () => {
    const f = fixture(); const value = access(1); f.add(value);
    const scopes: AuthenticationIncidentScope[] = [{ kind: 'collection', platform: 'mail', slug: 'work' }, { kind: 'file_source', source_id: 'hidden-old-source' }, { kind: 'oauth_apps' }];
    for (const scope of scopes) f.db.prepare('INSERT INTO authentication_incident_targets (incident_id, scope_key) VALUES (?, ?)').run(value.id, JSON.stringify(scope));
    f.db.prepare('INSERT INTO authentication_history_groups (entry_id, group_id) VALUES (?, ?)').run(value.id, 'd'.repeat(64));
    f.db.prepare('INSERT INTO authentication_repair_incidents (repair_id, incident_id, group_id) VALUES (?, ?, ?)').run(value.id, 'old-id', 'e'.repeat(64));
    for (const scope of [...scopes, { kind: 'group' as const, id: 'a'.repeat(64) }, { kind: 'group' as const, id: 'd'.repeat(64) }, { kind: 'group' as const, id: 'e'.repeat(64) }]) {
      expect(f.store.export({ scope }, now).entries.map(e => e.record.id)).toEqual([value.id]);
    }
    expect(f.store.export({ scope: { kind: 'connection', name: 'other' } }, now).entry_count).toBe(0);
  });
  it('respects retention even with wide date filters and preserves unfinished older checks', () => {
    const f = fixture(); const cutoff = now - 90 * 86400000;
    const expired = { ...access(1), started_at: cutoff - 2, finished_at: cutoff - 1 }; f.add(expired);
    const boundary = { ...access(2), started_at: cutoff - 2, finished_at: cutoff }; f.add(boundary);
    const running = access(3); running.status = 'checking'; running.started_at = cutoff - 100; delete running.finished_at; f.add(running);
    const exported = f.store.export({ scope: { kind: 'all' }, filters: { from: '2020-01-01', through: '2026-12-31' } }, now);
    expect(exported.entries.map(e => e.record.id)).toEqual([running.id, boundary.id]); expect(exported.entries[0]!.outcome).toBe('running');
  });
  it('includes repair apply, read outcomes and excluded renewals as separate observations without checking current authentication', () => {
    const f = fixture(); const repair: AuthenticationRepairAction = { id: 'repair-' + 'd'.repeat(64), action: 'rotate_secret', status: 'applied', started_at: now - 1000, finished_at: now,
      targets: [{ kind: 'connection', name: 'work' }], targets_truncated: true, incidents: [], incidents_truncated: true };
    const renewal: AuthenticationRenewalHistory = { id: 'renewal-12345678-1234-4123-8123-123456789abc', issuer: 'google', app_id: 'default', app_revision: 1, app_label: 'Work',
      started_at: now - 1000, finished_at: now, history_started_at: now, status: 'completed', incomplete: false,
      results: [{ id: 'e'.repeat(64), revision: 'f'.repeat(64), label: 'Work grant', connections: ['work'], native_accounts: [], eligible: true, status: 'unconfirmed', reason: 'not_selected', current: 'yes' }] };
    const read = access(1); Object.assign(read.results[0]!, { refresh_token: 'private-marker', file_url: 'https://private.test/file?token=private-marker' });
    f.add(repair); f.add(read); f.add(renewal); const before = f.db.prepare('SELECT * FROM authentication_incident_history').all(); const fetch = vi.spyOn(globalThis, 'fetch');
    const exported = f.store.export({ scope: { kind: 'all' } }, now);
    expect(exported.entries.map(e => [e.type, e.outcome])).toEqual([['renewal', 'unconfirmed'], ['verification', 'passed'], ['repair', 'applied']]);
    expect(JSON.stringify(exported)).not.toContain('private-marker'); expect(JSON.stringify(exported)).not.toContain('"current":"yes"');
    expect(fetch).not.toHaveBeenCalled(); expect(f.db.prepare('SELECT * FROM authentication_incident_history').all()).toEqual(before);
  });
  it('fails safely for malformed or misidentified retained data without returning a partial report or leaving an iterator open', () => {
    const f = fixture(); f.add(access(1)); f.add(access(2));
    for (const data of ['{bad-json', JSON.stringify({ ...access(3), raw_error: 'private-marker' }), JSON.stringify({ ...access(1), status: 'unknown' })]) {
      f.db.prepare('UPDATE authentication_incident_history SET data = ? WHERE id = ?').run(data, access(1).id);
      expect(() => f.store.export({ scope: { kind: 'all' } }, now)).toThrow('No partial report');
    }
    f.db.prepare('UPDATE authentication_incident_history SET data = ? WHERE id = ?').run(JSON.stringify(access(1)), access(1).id);
    expect(f.store.export({ scope: { kind: 'all' } }, now).entry_count).toBe(2);
  });
  it('refuses an oversized report atomically and still permits a narrowed complete export', () => {
    const f = fixture(); const uses = Array.from({ length: 256 }, (_, i) => ({ kind: 'pack' as const, id: 'pack-' + i, label: 'x'.repeat(2000) }));
    f.db.transaction(() => { for (let n = 0; n < 20; n++) f.add({ ...access(n), uses }); f.add(access(30, 'Small report')); })();
    expect(() => f.store.export({ scope: { kind: 'all' } }, now)).toThrow('Narrow the applied filters');
    try { f.store.export({ scope: { kind: 'all' } }, now); } catch (error) { expect(error).toMatchObject({ code: 'payload_too_large', status: 413 }); }
    expect(f.store.export({ scope: { kind: 'all' }, filters: { search: 'Small report' } }, now).entry_count).toBe(1);
  });
  it('bounds unfinished matching records too, accepting exactly 20,000 and refusing one more without truncation', () => {
    const f = fixture(); const insert = f.db.prepare('INSERT INTO authentication_incident_history (id, group_id, signature, data, kind) VALUES (?, ?, ?, ?, ?)');
    const value = (n: number): AuthenticationRepairAction => ({ id: 'repair-' + String(n).padStart(64, '0'), action: 'reauthorize', status: 'checking', started_at: now,
      targets: [{ kind: 'oauth_apps' }], targets_truncated: false, incidents: [], incidents_truncated: false });
    f.db.transaction(() => { for (let n = 0; n < 20_000; n++) { const r = value(n); insert.run(r.id, 'a'.repeat(64), '', JSON.stringify(r), 'repair'); } })();
    expect(f.store.export({ scope: { kind: 'all' } }, now).entry_count).toBe(20_000);
    const extra = value(20_000); insert.run(extra.id, 'a'.repeat(64), '', JSON.stringify(extra), 'repair');
    expect(() => f.store.export({ scope: { kind: 'all' } }, now)).toThrow('Narrow the applied filters');
    expect(f.store.export({ scope: { kind: 'all' }, filters: { search: extra.id } }, now).entries.map(e => e.record.id)).toEqual([extra.id]);
  });
  it.each([{ limit: 1 }, { cursor: 'older' }, { filters: { outcome: 'healthy' } }])('rejects an export that requests partial or invalid selection %j', patch => {
    const f = fixture(); expect(() => f.store.export({ scope: { kind: 'all' }, ...patch } as never, now)).toThrow('valid history scope');
  });
});
