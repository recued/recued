import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAuthenticationAccessSummary, type AuthenticationAccessVerification, type AuthenticationRepairTarget } from '@recued/contracts';
import { createAuthenticationAccessSummaries } from '../authentication-access-summary.js';
import type { PreparedAuthenticationAccess } from '../authentication-access-verification.js';

const dbs: Database.Database[] = []; afterEach(() => dbs.splice(0).forEach(db => db.close()));
const targetId = (t: AuthenticationRepairTarget) => createHash('sha256').update(JSON.stringify(JSON.stringify(t))).digest('hex');
const api: AuthenticationRepairTarget = { kind: 'connection', name: 'work' };
const mail: AuthenticationRepairTarget = { kind: 'collection', platform: 'mail', slug: 'work' };
const files: AuthenticationRepairTarget = { kind: 'file_source', source_id: 'work.files' };
const selection = { kind: 'group' as const, id: 'a'.repeat(64) };
const fixture = () => {
  const db = new Database(':memory:'); dbs.push(db); let clock = 10_000; let serial = 0; let revision = 'b'.repeat(64);
  db.exec('CREATE TABLE authentication_access_verifications (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, data TEXT, finished_at INTEGER)');
  const run = vi.fn<PreparedAuthenticationAccess['run']>(async () => { throw new Error('Summary must never run vendor checks'); });
  const prepare = vi.fn(async (_target: AuthenticationRepairTarget): Promise<PreparedAuthenticationAccess> => ({ descriptor: { check: 'unsupported', label: 'Current account', authentication_revision: revision }, run }));
  const create = () => createAuthenticationAccessSummaries({ db, prepare, now: () => clock });
  const value = (targets: AuthenticationRepairTarget[]): AuthenticationAccessVerification => {
    const n = ++serial;
    return { id: 'verify-' + n.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc', selection,
      status: 'completed', started_at: 1000 + n * 10, finished_at: 1005 + n * 10, targets_truncated: false, uses: [], usage_available: true,
      results: targets.map(t => ({ id: targetId(t), target: t, label: 'Saved account', authentication_revision: revision, current: 'yes',
        checks: [{ kind: t.kind === 'collection' ? 'collection_read' : t.kind === 'file_source' ? 'file_metadata' : 'api_read', status: 'passed' },
          { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] })) };
  };
  const put = (v: AuthenticationAccessVerification) => db.prepare('INSERT INTO authentication_access_verifications (id, data, finished_at) VALUES (?, ?, ?)').run(v.id, JSON.stringify(v), v.finished_at ?? null);
  return { db, create, prepare, run, value, put, time: (v: number) => { clock = v; }, revision: (v: string) => { revision = v; } };
};
describe('latest saved access per target', () => {
  it('backfills legacy receipts and reflects a partial retry without changing previous checks or clocks', async () => {
    const f = fixture(); const old = f.value([api, mail, files]); old.results[1]!.checks = [{ kind: 'collection_read', status: 'failed', reason: 'access_rejected' }]; f.put(old);
    const before = f.db.prepare('SELECT data FROM authentication_access_verifications WHERE id = ?').get(old.id);
    const store = f.create(); const retry = f.value([mail]); retry.selection = { kind: 'verification', id: old.id };
    f.db.transaction(() => { f.put(retry); store.register(retry); })();
    const [summary] = await store.project([{ selection, targets: [api, mail, files] }]); expect(isAuthenticationAccessSummary(summary)).toBe(true);
    expect(summary!.targets.map(r => r.latest!.id)).toEqual([old.id, retry.id, old.id]);
    expect(summary!.targets[0]!.latest!.finished_at).toBe(old.finished_at); expect(summary!.targets[1]!.latest!.finished_at).toBe(retry.finished_at);
    expect(summary!.targets[1]!.latest!.result.checks[0]!.status).toBe('passed'); expect(f.run).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT data FROM authentication_access_verifications WHERE id = ?').get(old.id)).toEqual(before);
    expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_targets').get()).toEqual({ n: 4 });
    f.create(); expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_targets').get()).toEqual({ n: 4 });
  });
  it('uses reservation order when an older slow check finishes later, and shows a pending newer attempt', async () => {
    const f = fixture(); const old = f.value([api]); old.finished_at = 9000; f.put(old); const store = f.create();
    const newer = f.value([api]); newer.status = 'checking'; delete newer.finished_at; newer.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }];
    f.put(newer); store.register(newer);
    const [summary] = await store.project([{ selection, targets: [api] }]);
    expect(summary!.targets[0]!.latest).toMatchObject({ id: newer.id, status: 'checking', result: { checks: [{ reason: 'not_checked' }] } });
    expect(summary!.targets[0]!.latest!.finished_at).toBeUndefined();
  });
  it('does not carry a previous file download pass into a later metadata-only check', async () => {
    const f = fixture(); const old = f.value([files]); old.results[0]!.checks.push({ kind: 'file_download', status: 'passed' }); f.put(old); const store = f.create();
    const next = f.value([files]); next.results[0]!.checks.push({ kind: 'file_download', status: 'unconfirmed', reason: 'resource_required' }); f.put(next); store.register(next);
    const [summary] = await store.project([{ selection, targets: [files] }]);
    expect(summary!.targets[0]!.latest!.result.checks).toContainEqual({ kind: 'file_download', status: 'unconfirmed', reason: 'resource_required' });
  });
  it('marks changed and unreadable authentication while retaining the recorded revision', async () => {
    const f = fixture(); const old = f.value([api]); f.put(old); const store = f.create(); f.revision('c'.repeat(64));
    const [changed] = await store.project([{ selection, targets: [api] }]); expect(changed!.targets[0]!.latest!.result).toMatchObject({ current: 'no', authentication_revision: 'b'.repeat(64) });
    f.prepare.mockRejectedValueOnce(new Error('private vault failure'));
    const [unknown] = await store.project([{ selection, targets: [api] }]); expect(unknown!.targets[0]!.latest!.result.current).toBe('unknown');
    expect(JSON.stringify(unknown)).not.toContain('private vault failure'); expect(f.run).not.toHaveBeenCalled();
  });
  it('deduplicates current targets, omits app settings, marks unchecked resources and bounds the list', async () => {
    const f = fixture(); const old = f.value([api]); f.put(old); const store = f.create();
    const extra: AuthenticationRepairTarget[] = Array.from({ length: 33 }, (_, n) => ({ kind: 'connection', name: 'extra-' + n }));
    const [summary] = await store.project([{ selection, targets: [api, api, { kind: 'oauth_apps' }, ...extra] }]);
    expect(summary!.targets).toHaveLength(32); expect(summary!.targets_truncated).toBe(true);
    expect(summary!.targets[1]!.state).toBe('not_checked'); expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it('never falls back to an older pass when the newest indexed receipt is unreadable', async () => {
    const f = fixture(); const old = f.value([api]); f.put(old); const store = f.create(); const newer = f.value([api]); f.put(newer); store.register(newer);
    f.db.prepare('UPDATE authentication_access_verifications SET data = ? WHERE id = ?').run('{}', newer.id);
    const [summary] = await store.project([{ selection, targets: [api] }]);
    expect(summary!.lookup_incomplete).toBe(true); expect(summary!.targets[0]).toMatchObject({ state: 'unavailable' }); expect(summary!.targets[0]!.latest).toBeUndefined();
  });
  it('fails closed for an unreadable retained legacy row and cleans index entries after source retention', async () => {
    const f = fixture(); const old = f.value([api]); f.put(old); f.db.prepare('INSERT INTO authentication_access_verifications (id, data, finished_at) VALUES (?, ?, ?)').run('bad', '{}', 2000);
    const broken = f.create(); const [unavailable] = await broken.project([{ selection, targets: [api] }]); expect(unavailable!.targets[0]!.state).toBe('unavailable');
    f.db.prepare('DELETE FROM authentication_access_verifications WHERE id = ?').run('bad');
    const [restored] = await broken.project([{ selection, targets: [api] }]); expect(restored!.targets[0]!.latest!.id).toBe(old.id);
    const store = f.create(); f.time(91 * 86_400_000);
    const [expired] = await store.project([{ selection, targets: [api] }]); expect(expired!.targets[0]!.state).toBe('not_checked');
    f.db.prepare('DELETE FROM authentication_access_verifications').run(); store.prune(); expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_targets').get()).toEqual({ n: 0 });
  });
  it('recovers incomplete legacy indexing after the damaged receipt expires without restarting', async () => {
    const f = fixture(); f.db.prepare('INSERT INTO authentication_access_verifications (id, data, finished_at) VALUES (?, ?, ?)').run('bad', '{}', 2000);
    const store = f.create(); const [before] = await store.project([{ selection, targets: [api] }]); expect(before!.targets[0]!.state).toBe('unavailable');
    f.time(90 * 86_400_000 + 2001); const [after] = await store.project([{ selection, targets: [api] }]);
    expect(after!.targets[0]!.state).toBe('not_checked'); expect(after!.lookup_incomplete).toBe(false); expect(f.run).not.toHaveBeenCalled();
  });
  it('shares local comparisons across groups and rereads a job reserved during preparation', async () => {
    const f = fixture(); const old = f.value([api]); f.put(old); const store = f.create(); const normal = f.prepare.getMockImplementation()!; const next = f.value([api]);
    f.prepare.mockImplementationOnce(async target => { f.put(next); store.register(next); return normal(target); });
    const results = await store.project([{ selection, targets: [api] }, { selection: { kind: 'group', id: 'c'.repeat(64) }, targets: [api] }]);
    expect(f.prepare).toHaveBeenCalledTimes(1); expect(results.map(s => s.targets[0]!.latest!.id)).toEqual([next.id, next.id]);
  });
  it('does not project a pass evicted while current authentication is being compared', async () => {
    const f = fixture(); const old = f.value([api]); f.put(old); const store = f.create(); const normal = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async target => { f.db.prepare('DELETE FROM authentication_access_verifications WHERE id = ?').run(old.id); return normal(target); });
    const [summary] = await store.project([{ selection, targets: [api] }]); expect(summary!.targets[0]!.state).toBe('not_checked'); expect(summary!.targets[0]!.latest).toBeUndefined();
  });
  it('bounds local comparisons and leaves unexamined credentials explicitly unknown', async () => {
    const f = fixture(); const groups = Array.from({ length: 17 }, (_, group) => Array.from({ length: 32 }, (_, n): AuthenticationRepairTarget => ({ kind: 'connection', name: 'work-' + group + '-' + n })));
    for (const targets of groups) f.put(f.value(targets)); const store = f.create(); const results = await store.project(groups.map(targets => ({ selection, targets })));
    expect(f.prepare).toHaveBeenCalledTimes(512); expect(results.at(-1)!.targets.every(r => r.latest!.result.current === 'unknown')).toBe(true);
    expect(results.at(-1)!.lookup_incomplete).toBe(true); expect(f.run).not.toHaveBeenCalled();
  });
  it('does not return unknown stored metadata or credentials in the projection', async () => {
    const f = fixture(); const v = f.value([api]); Object.assign(v, { client_secret: 'private-extra' }); Object.assign(v.results[0]!, { url: 'https://vendor.test/private-extra' }); f.put(v);
    const [summary] = await f.create().project([{ selection, targets: [api] }]); expect(JSON.stringify(summary)).not.toContain('private-extra');
  });
});
