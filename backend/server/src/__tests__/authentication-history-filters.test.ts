import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAuthenticationIncidentHistoryPage, type AuthenticationAccessVerification, type AuthenticationHistoryEntry,
  type AuthenticationIncidentHistoryFilters, type AuthenticationRepairAction, type AuthenticationRenewalHistory } from '@recued/contracts';
import { createAuthenticationIncidentStore } from '../authentication-incident-store.js';

const clock = Date.parse('2026-10-17T12:00:00Z');
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });
const access = (n: number, label = 'Work API'): AuthenticationAccessVerification => ({ id: 'verify-' + String(n).padStart(36, '0'), selection: { kind: 'group', id: 'a'.repeat(64) },
  started_at: clock - 1000, finished_at: clock, status: 'completed', results: [{ id: 'b'.repeat(64), label, target: { kind: 'connection', name: 'work' },
    authentication_revision: 'c'.repeat(64), current: 'no', checks: [{ kind: 'api_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] }],
  targets_truncated: false, uses: [], usage_available: true });
const fixture = () => {
  const db = new Database(':memory:'); databases.push(db); const store = createAuthenticationIncidentStore(db);
  const add = (kind: string, value: AuthenticationHistoryEntry) => {
    const ended = 'ended_at' in value ? value.ended_at : 'finished_at' in value ? value.finished_at : undefined;
    db.prepare('INSERT INTO authentication_incident_history (id, group_id, ended_at, signature, data, kind) VALUES (?, ?, ?, ?, ?, ?)')
      .run(value.id, 'a'.repeat(64), ended ?? null, '', JSON.stringify(value), kind);
    db.prepare('INSERT INTO authentication_incident_targets (incident_id, scope_key) VALUES (?, ?)').run(value.id, JSON.stringify({ kind: 'connection', name: 'work' }));
  };
  const history = (filters?: AuthenticationIncidentHistoryFilters, cursor?: string, limit = 20) => store.history({ scope: { kind: 'all' }, include_renewals: true,
    ...(filters ? { filters } : {}), ...(cursor ? { cursor } : {}), limit }, clock);
  return { db, store, add, history };
};

describe('server history filtering before pagination', () => {
  it('finds sparse older matches across the retained corpus and advances only through matching pages', () => {
    const f = fixture();
    for (let n = 0; n < 70; n++) f.add('verification', access(n, [3, 21, 60].includes(n) ? 'École 100%_ reports' : 'Other account'));
    const filters = { search: '  E\u0301COLE 100%_  ', type: 'verification' as const, outcome: 'passed' as const };
    const first = f.history(filters, undefined, 1); const second = f.history(filters, first.next_cursor, 1); const third = f.history(filters, second.next_cursor, 1);
    expect([first, second, third].flatMap(p => p.order!)).toEqual([60, 21, 3].map(n => access(n).id)); expect(third.next_cursor).toBeUndefined();
    expect(first.filters).toEqual({ search: 'ÉCOLE 100%_', type: 'verification', outcome: 'passed' });
    for (const p of [first, second, third]) expect(isAuthenticationIncidentHistoryPage(p)).toBe(true);
    expect(f.history({ search: "%' OR 1=1 --" }).order).toEqual([]);
  });
  it('binds cursors to every canonical filter, renewal mode and scope while preserving unfiltered cursor compatibility', () => {
    const f = fixture(); for (let n = 0; n < 4; n++) f.add('verification', access(n));
    const filters = { search: ' Work ', type: 'verification' as const, outcome: 'passed' as const, from: '2026-10-16', through: '2026-10-18' };
    const first = f.history(filters, undefined, 1); expect(first.next_cursor).toBeDefined();
    expect(f.history({ through: filters.through, from: filters.from, outcome: filters.outcome, type: filters.type, search: 'Work' }, first.next_cursor, 1).order).toHaveLength(1);
    for (const patch of [{ search: 'other' }, { type: 'repair' as const }, { outcome: 'failed' as const }, { from: '2026-10-15' }, { through: '2026-10-19' }]) {
      expect(() => f.history({ ...filters, ...patch }, first.next_cursor)).toThrow('invalid for the selected connection');
    }
    expect(() => f.store.history({ scope: { kind: 'connection', name: 'work' }, include_renewals: true, filters, cursor: first.next_cursor })).toThrow('invalid for the selected connection');
    expect(() => f.store.history({ scope: { kind: 'all' }, filters, cursor: first.next_cursor })).toThrow('invalid for the selected connection');
    const ordinary = f.history(undefined, undefined, 1); expect(f.history({ search: ' ' }, ordinary.next_cursor, 1).order).toHaveLength(1);
    expect(() => f.history({}, first.next_cursor)).toThrow('invalid for the selected connection');
  });
  it('uses inclusive original UTC start dates, preserving retention even when a wider date range is requested', () => {
    const f = fixture(); const starts = ['2026-10-15T23:59:59.999Z', '2026-10-16T00:00:00Z', '2026-10-16T23:59:59.999Z', '2026-10-17T00:00:00Z'];
    starts.forEach((s, n) => { const v = access(n); v.started_at = Date.parse(s); v.finished_at = v.started_at + 1; f.add('verification', v); });
    const expired = access(9); expired.started_at = expired.finished_at = clock - 91 * 86_400_000; f.add('verification', expired);
    expect(f.history({ from: '2026-10-16', through: '2026-10-16' }).order).toEqual([access(2).id, access(1).id]);
    expect(f.history({ from: '2026-01-01' }).order).not.toContain(expired.id);
  });
  it('filters mixed recorded outcomes without promoting applied repairs, retired incidents or unchecked writes to access proof', () => {
    const f = fixture(); const good = access(0); f.add('verification', good);
    const failed = access(1); failed.results[0]!.checks[0] = { kind: 'api_read', status: 'failed', reason: 'access_rejected' }; f.add('verification', failed);
    const unknown = access(2); unknown.results[0]!.checks = [{ kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }]; f.add('verification', unknown);
    const running = access(3); running.status = 'checking'; delete running.finished_at; f.add('verification', running);
    const repair: AuthenticationRepairAction = { id: 'repair-' + 'd'.repeat(64), action: 'reauthorize', status: 'applied', started_at: clock - 100, finished_at: clock,
      targets: [{ kind: 'connection', name: 'work' }], targets_truncated: false, incidents: [], incidents_truncated: false }; f.add('repair', repair);
    const token: AuthenticationRenewalHistory = { id: 'renewal-12345678-1234-4123-8123-123456789abc', issuer: 'google', app_id: 'default', app_revision: 1, app_label: 'Team app',
      status: 'completed', started_at: clock - 100, history_started_at: clock, finished_at: clock, incomplete: false,
      results: [{ id: 'e'.repeat(64), revision: 'f'.repeat(64), label: 'Work', connections: ['work'], native_accounts: [], eligible: true, status: 'unconfirmed', reason: 'not_selected', current: 'unknown' }] }; f.add('renewal', token);
    expect(f.history({ outcome: 'passed' }).order).toEqual([good.id]); expect(f.history({ outcome: 'failed' }).order).toEqual([failed.id]);
    expect(f.history({ outcome: 'unconfirmed' }).order).toEqual([token.id, unknown.id]); expect(f.history({ outcome: 'running' }).order).toEqual([running.id]);
    expect(f.history({ outcome: 'applied' }).order).toEqual([repair.id]); expect(f.history({ outcome: 'recovered' }).order).toEqual([]);
    expect(f.history({ type: 'renewal' }).order).toEqual([token.id]);
  });
  it('does not write receipts or contact providers, and searches only allowed metadata', () => {
    const f = fixture(); const v = access(0); Object.assign(v, { client_secret: 'private-marker' }); f.add('verification', v);
    const before = f.db.prepare('SELECT * FROM authentication_incident_history').all(); const fetch = vi.spyOn(globalThis, 'fetch');
    expect(f.history({ search: 'private-marker' }).order).toEqual([]); expect(f.history({ search: 'work', outcome: 'passed' }).order).toEqual([v.id]);
    expect(f.db.prepare('SELECT * FROM authentication_incident_history').all()).toEqual(before); expect(fetch).not.toHaveBeenCalled();
  });
});
