import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError, isAuthenticationAccessPreview, isAuthenticationAccessVerification, type AuthenticationAccessPreview,
  type AuthenticationAccessVerification, type AuthenticationAccessSelection, type AuthenticationRepairTarget, type AuthenticationRepairWorklist, type OAuthAppRenewalVerification } from '@recued/contracts';
import { createAuthenticationAccessVerification, type PreparedAuthenticationAccess } from '../authentication-access-verification.js';
import { createAuthenticationRepairActionStore } from '../authentication-repair-action-store.js';
import { createAuthenticationIncidentStore } from '../authentication-incident-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { makeConnectionHandlers } from '../connection-handler.js';
import { createOAuthAppRenewalHistory } from '../oauth-app-renewal-history.js';

const dbs: Database.Database[] = []; afterEach(() => { vi.useRealTimers(); dbs.splice(0).forEach(db => db.close()); });
const nonce = () => randomBytes(32).toString('base64url');
const fixture = () => {
  const db = new Database(':memory:'); dbs.push(db); let clock = 1000;
  let revision = 'b'.repeat(64); let blocked = false;
  const target: AuthenticationRepairTarget = { kind: 'connection', name: 'work' };
  const inventory: AuthenticationRepairWorklist = { observed_at: clock, unavailable: [], groups: [{ id: 'a'.repeat(64), label: 'Work', kind: 'account', authentication: 'direct_oauth',
    connection_names: ['work'], targets: [target], issues: [], usage_available: true, uses: [{ kind: 'pack', id: 'sheet', label: 'Sheets' }, { kind: 'schedule', id: 'daily', label: 'Daily import' }] }] };
  const run = vi.fn<PreparedAuthenticationAccess['run']>(async () => [{ kind: 'api_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }]);
  const prepare = vi.fn(async (t: AuthenticationRepairTarget): Promise<PreparedAuthenticationAccess> => {
    if (blocked) throw new RpcError('locked', 'never-export-locked-secret');
    return { descriptor: { label: t.kind === 'connection' ? 'API: ' + t.name : 'Account', authentication_revision: revision,
      check: t.kind === 'connection' ? 'api_read' : t.kind === 'collection' ? 'collection_read' : t.kind === 'file_source' ? 'file_metadata' : 'unsupported',
      ...(t.kind === 'connection' ? { base_url: 'https://vendor.test/v1' } : {}) }, run };
  });
  const inventoryRead = vi.fn(async () => inventory);
  const create = () => createAuthenticationAccessVerification({ db, inventory: inventoryRead, prepare, now: () => clock });
  const service = create(); const selection = { kind: 'group' as const, id: inventory.groups[0]!.id };
  const preview = async (selected: AuthenticationAccessSelection = selection): Promise<AuthenticationAccessPreview> => {
    const reply = await service.handle({ action: 'authentication_access_preview', selection: selected });
    if (reply.action !== 'authentication_access_preview') throw new Error('preview'); return reply.preview;
  };
  const start = async (p: AuthenticationAccessPreview, attempt_id = nonce(), url = 'https://vendor.test/v1/protected?fields=id') => {
    const request = { action: 'authentication_access_run' as const, review_id: p.id, fingerprint: p.fingerprint, attempt_id, choices: [{ target_id: p.targets[0]!.id, url }] };
    const reply = await service.handle(request); if (reply.action !== request.action) throw new Error('run'); return { request, verification: reply.verification };
  };
  const status = async (id: string): Promise<AuthenticationAccessVerification> => {
    const reply = await service.handle({ action: 'authentication_access_status', id });
    if (reply.action !== 'authentication_access_status') throw new Error('status'); return reply.verification;
  };
  const finished = async (id: string): Promise<AuthenticationAccessVerification> => {
    let value = await status(id); await vi.waitFor(async () => { value = await status(id); expect(value.status).toBe('completed'); }); return value;
  };
  return { db, service, create, inventory, inventoryRead, target, selection, prepare, run, preview, start, status, finished,
    time: (v: number) => { clock = v; }, revision: (v: string) => { revision = v; }, locked: (v: boolean) => { blocked = v; } };
};

describe('fresh file authentication navigation', () => {
  const files = async () => {
    const f = fixture(); f.inventory.groups[0]!.targets = [{ kind: 'file_source', source_id: 'opaque-source' }];
    const normal = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementation(async target => {
      const prepared = await normal(target);
      return { ...prepared, descriptor: { ...prepared.descriptor, file_connection: { name: 'drive-work', updated_at: 7 } } };
    });
    f.run.mockResolvedValue([{ kind: 'file_metadata', status: 'failed', reason: 'access_rejected' }]);
    const p = await f.preview(); const first = await f.service.handle({ action: 'authentication_access_run', review_id: p.id, fingerprint: p.fingerprint, attempt_id: nonce(), choices: [] });
    if (first.action !== 'authentication_access_run') throw Error('run');
    const done = await f.finished(first.verification.id); return { ...f, done };
  };
  it('computes the exact file connection from local status without changing the receipt or running another provider check', async () => {
    const f = await files(); const raw = f.db.prepare('SELECT data FROM authentication_access_verifications WHERE id = ?').get(f.done.id);
    expect(JSON.stringify(raw)).not.toContain('file_connection'); f.run.mockClear();
    const fresh = await f.status(f.done.id);
    expect(fresh.results[0]).toMatchObject({ current: 'yes', file_connection: { name: 'drive-work', updated_at: 7 } });
    expect(isAuthenticationAccessVerification(fresh)).toBe(true); expect(f.run).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT data FROM authentication_access_verifications WHERE id = ?').get(f.done.id)).toEqual(raw);
  });
  it('replaces retained navigation fields with the freshly resolved mapping', async () => {
    const f = await files(); const stored = structuredClone(f.done); stored.results[0]!.file_connection = { name: 'wrong-account', updated_at: 1 };
    f.db.prepare('UPDATE authentication_access_verifications SET data = ? WHERE id = ?').run(JSON.stringify(stored), stored.id);
    expect((await f.status(stored.id)).results[0]!.file_connection).toEqual({ name: 'drive-work', updated_at: 7 });
  });
  it.each(['revision', 'locked', 'unsupported', 'missing'] as const)('does not retain a file destination when comparison is %s', async cause => {
    const f = await files(); const stored = structuredClone(f.done); stored.results[0]!.file_connection = { name: 'wrong-account', updated_at: 1 };
    f.db.prepare('UPDATE authentication_access_verifications SET data = ? WHERE id = ?').run(JSON.stringify(stored), stored.id);
    if (cause === 'revision') f.revision('c'.repeat(64));
    if (cause === 'locked') f.locked(true);
    if (cause === 'missing') f.prepare.mockResolvedValue(undefined as unknown as PreparedAuthenticationAccess);
    if (cause === 'unsupported') {
      const normal = f.prepare.getMockImplementation()!;
      f.prepare.mockImplementation(async target => { const p = await normal(target); return { ...p, descriptor: { ...p.descriptor, check: 'unsupported' } }; });
    }
    const fresh = await f.status(stored.id); expect(fresh.results[0]!.file_connection).toBeUndefined();
    expect(isAuthenticationAccessVerification(fresh)).toBe(true);
  });
});

describe('targeted access rechecks', () => {
  const source = async (f: ReturnType<typeof fixture>) => {
    f.inventory.groups[0]!.targets.push({ kind: 'collection', platform: 'mail', slug: 'work' }, { kind: 'file_source', source_id: 'work.files' });
    f.run.mockResolvedValueOnce([{ kind: 'api_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }])
      .mockResolvedValueOnce([{ kind: 'collection_read', status: 'failed', reason: 'access_rejected' }])
      .mockResolvedValueOnce([{ kind: 'file_metadata', status: 'passed' }, { kind: 'file_download', status: 'unconfirmed', reason: 'resource_required' }]);
    const first = await f.start(await f.preview()); const done = await f.finished(first.verification.id);
    return { done, selection: { kind: 'verification' as const, id: done.id } };
  };
  const start = async (f: ReturnType<typeof fixture>, p: AuthenticationAccessPreview, ids = p.targets.map(t => t.id)) => {
    const request = { action: 'authentication_access_run' as const, review_id: p.id, fingerprint: p.fingerprint, attempt_id: nonce(),
      target_ids: ids, choices: p.targets.filter(t => ids.includes(t.id)).map(t => ({ target_id: t.id, ...(t.check === 'file_metadata' ? { file_id: 'chosen' } : {}) })) };
    const reply = await f.service.handle(request); if (reply.action !== request.action) throw Error('run'); return { request, verification: reply.verification };
  };
  it('saves sequential bulk rechecks under their own sources while retaining passed resources and original receipt bytes', async () => {
    const f = fixture(); const first = await source(f);
    const other = { ...structuredClone(f.inventory.groups[0]!), id: 'd'.repeat(64), label: 'Other account', targets: [{ kind: 'connection' as const, name: 'other' }], connection_names: ['other'] };
    f.inventory.groups.push(other); f.run.mockResolvedValueOnce([{ kind: 'api_read', status: 'unconfirmed', reason: 'resource_required' }]);
    const secondStart = await f.start(await f.preview({ kind: 'group', id: other.id })); const second = await f.finished(secondStart.verification.id);
    const original = [first.done.id, second.id].map(id => f.db.prepare('SELECT data FROM authentication_access_verifications WHERE id = ?').get(id));
    const previews = [await f.preview(first.selection), await f.preview({ kind: 'verification', id: second.id })];
    expect(f.run).toHaveBeenCalledTimes(4); expect(previews[0]!.targets.map(t => t.target.kind)).toEqual(['collection', 'file_source']);
    f.run.mockResolvedValueOnce([{ kind: 'collection_read', status: 'failed', reason: 'access_rejected' }])
      .mockResolvedValueOnce([{ kind: 'file_metadata', status: 'passed' }, { kind: 'file_download', status: 'passed' }]);
    const left = await start(f, previews[0]!); await f.finished(left.verification.id);
    f.run.mockResolvedValueOnce([{ kind: 'api_read', status: 'passed' }]);
    const p = previews[1]!; const request = { action: 'authentication_access_run' as const, review_id: p.id, fingerprint: p.fingerprint, attempt_id: nonce(), target_ids: p.targets.map(t => t.id), choices: [{ target_id: p.targets[0]!.id, url: 'https://vendor.test/v1/fresh' }] };
    const right = await f.service.handle(request); if (right.action !== 'authentication_access_run') throw Error('run'); await f.finished(right.verification.id);
    expect(await f.service.handle(left.request)).toMatchObject({ verification: { id: left.verification.id } });
    expect(await f.service.handle(request)).toMatchObject({ verification: { id: right.verification.id } }); expect(f.run).toHaveBeenCalledTimes(7);
    expect([first.done.id, second.id].map(id => f.db.prepare('SELECT data FROM authentication_access_verifications WHERE id = ?').get(id))).toEqual(original);
    const latest = await f.service.worklist(f.inventory);
    expect(latest.groups[0]!.access_summary!.targets.map(t => t.latest!.id)).toEqual([first.done.id, left.verification.id, left.verification.id]);
    expect(latest.groups[1]!.access_summary!.targets[0]!.latest!.id).toBe(right.verification.id);
    expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 4 });
  });
  it('keeps repair incident group links across rechecks after the older source receipts are evicted', async () => {
    const f = fixture(); const history = createAuthenticationIncidentStore(f.db); const repairs = createAuthenticationRepairActionStore(f.db);
    history.record({ id: '12345678-1234-4123-8123-123456789abc', group_id: f.selection.id, status: 'open', first_seen_at: 800, last_seen_at: 800,
      problem_since_at: 800, present: true, issues: [], group: f.inventory.groups[0]!, announced: false }, 800);
    repairs.begin('connection_credentials', 'repaired', { action: 'reauthorize', targets: [f.target] }, 900);
    repairs.finish('connection_credentials', 'repaired', { status: 'applied' }, 950);
    const repair = history.history({ scope: { kind: 'all' } }, 1000).repairs![0]!;
    f.run.mockResolvedValue([{ kind: 'api_read', status: 'unconfirmed', reason: 'resource_required' }]);
    const first = await f.start(await f.preview({ kind: 'repair', id: repair.id })); await f.finished(first.verification.id);
    const incident = history.history({ scope: f.selection }, 1000).incidents[0];
    const retry = await start(f, await f.preview({ kind: 'verification', id: first.verification.id })); await f.finished(retry.verification.id);
    const groupHistory = history.history({ scope: f.selection }, 1000);
    expect.soft(groupHistory.verifications!.map(v => v.id)).toContain(retry.verification.id);
    expect.soft(groupHistory.incidents[0]).toEqual(incident); expect.soft(groupHistory.repairs![0]!.recovery_confirmed_at).toBeUndefined();
    f.db.prepare('DELETE FROM authentication_incident_history WHERE id IN (?, ?)').run(first.verification.id, repair.id); history.prune(1000);
    const next = await start(f, await f.preview({ kind: 'verification', id: retry.verification.id })); await f.finished(next.verification.id);
    expect(history.history({ scope: f.selection }, 1000).verifications!.map(v => v.id)).toContain(next.verification.id);
  });
  it.each(['target_ids', 'choices'] as const)('rejects sparse %s before reserving any recheck', async field => {
    const f = fixture(); const s = await source(f); const p = await f.preview(s.selection);
    const request = { action: 'authentication_access_run' as const, review_id: p.id, fingerprint: p.fingerprint, attempt_id: nonce(), choices: [], target_ids: [p.targets[0]!.id] };
    await expect(f.service.handle({ ...request, [field]: Array(1) })).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 1 }); expect(f.run).toHaveBeenCalledTimes(3);
  });
  it('reviews only non-passing reads locally and saves a selected subset without overwriting earlier passes', async () => {
    const f = fixture(); const s = await source(f); const original = f.db.prepare('SELECT data FROM authentication_access_verifications WHERE id = ?').get(s.done.id);
    f.inventory.groups[0]!.targets.push({ kind: 'connection', name: 'unrelated' });
    const p = await f.preview(s.selection); expect(f.run).toHaveBeenCalledTimes(3);
    expect(p.targets.map(t => t.target.kind)).toEqual(['collection', 'file_source']);
    f.run.mockResolvedValueOnce([{ kind: 'file_metadata', status: 'passed' }, { kind: 'file_download', status: 'passed' }]);
    const first = await start(f, p, [p.targets[1]!.id]); const done = await f.finished(first.verification.id);
    expect(done.selection).toEqual(s.selection); expect(done.results.map(r => r.target)).toEqual([{ kind: 'file_source', source_id: 'work.files' }]);
    expect(f.run).toHaveBeenCalledTimes(4); expect(f.run.mock.calls[3]![0]).toEqual({ target_id: p.targets[1]!.id, file_id: 'chosen' });
    expect(done.results[0]!.checks).toContainEqual({ kind: 'file_download', status: 'passed' });
    expect(f.db.prepare('SELECT data FROM authentication_access_verifications WHERE id = ?').get(s.done.id)).toEqual(original);
    const group = (await f.service.worklist(f.inventory)).groups[0]!;
    expect(group.access_summary!.targets.find(t => t.target.kind === 'file_source')!.latest!.id).toBe(done.id);
    expect(group.access_summary!.targets.find(t => t.target.kind === 'connection' && t.target.name === 'work')!.latest!.id).toBe(s.done.id);
    expect(group.access_summary!.targets.find(t => t.target.kind === 'connection' && t.target.name === 'unrelated')!.state).toBe('not_checked');
    const history = createAuthenticationIncidentStore(f.db).history({ scope: { kind: 'all' } }, 1000);
    expect(history.order).toEqual([done.id, s.done.id]); expect(history.verifications).toHaveLength(2);
    expect(JSON.stringify(f.db.prepare('SELECT * FROM authentication_access_verifications').all())).not.toContain('chosen');
  });
  it('retains app and group context but indexes only the newly checked resource targets', async () => {
    const f = fixture(); const s = await source(f); const appGroup = 'e'.repeat(64);
    f.db.prepare('INSERT INTO authentication_history_groups (entry_id, group_id) VALUES (?, ?)').run(s.done.id, appGroup);
    f.db.prepare('INSERT INTO authentication_incident_targets (incident_id, scope_key) VALUES (?, ?)').run(s.done.id, JSON.stringify({ kind: 'oauth_apps' }));
    const p = await f.preview(s.selection); const first = await start(f, p, [p.targets[1]!.id]); await f.finished(first.verification.id);
    const history = createAuthenticationIncidentStore(f.db);
    for (const scope of [{ kind: 'group' as const, id: appGroup }, { kind: 'group' as const, id: f.selection.id }, { kind: 'oauth_apps' as const }, { kind: 'file_source' as const, source_id: 'work.files' }]) {
      expect(history.history({ scope }, 1000).verifications!.map(v => v.id)).toContain(first.verification.id);
    }
    for (const scope of [f.target, { kind: 'collection' as const, platform: 'mail' as const, slug: 'work' }]) {
      expect(history.history({ scope }, 1000).verifications!.map(v => v.id)).not.toContain(first.verification.id);
    }
  });
  it.each(['expired', 'malformed', 'missing'] as const)('refuses a %s source before preparing any target', async cause => {
    const f = fixture(); const s = await source(f); f.prepare.mockClear();
    if (cause === 'expired') f.time(91 * 86_400_000);
    if (cause === 'malformed') f.db.prepare('UPDATE authentication_incident_history SET data = ? WHERE id = ?').run(JSON.stringify({ ...s.done, results: [] }), s.done.id);
    if (cause === 'missing') f.db.prepare('DELETE FROM authentication_incident_history WHERE id = ?').run(s.done.id);
    await expect(f.preview(s.selection)).rejects.toMatchObject({ code: cause === 'malformed' ? 'bad_request' : 'not_found' });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.run).toHaveBeenCalledTimes(3);
  });
  it('does not retry deliberately unperformed writes or a source that is still running', async () => {
    const f = fixture(); const first = await f.start(await f.preview()); const done = await f.finished(first.verification.id);
    await expect(f.preview({ kind: 'verification', id: done.id })).rejects.toMatchObject({ code: 'bad_request' });
    f.db.prepare("UPDATE authentication_incident_history SET ended_at = NULL WHERE id = ?").run(done.id);
    await expect(f.preview({ kind: 'verification', id: done.id })).rejects.toMatchObject({ code: 'not_found' });
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('rejects empty, implicit, passed, unrelated or deselected target resources before vendor work', async () => {
    const f = fixture(); const s = await source(f); const p = await f.preview(s.selection);
    const request = { action: 'authentication_access_run' as const, review_id: p.id, fingerprint: p.fingerprint, attempt_id: nonce(), choices: [] };
    for (const target_ids of [undefined, [], [s.done.results[0]!.id], ['f'.repeat(64)]]) {
      await expect(f.service.handle({ ...request, ...(target_ids === undefined ? {} : { target_ids }) })).rejects.toMatchObject({ code: 'bad_request' });
    }
    await expect(f.service.handle({ ...request, target_ids: [p.targets[0]!.id], choices: [{ target_id: p.targets[1]!.id, file_id: 'chosen' }] })).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.run).toHaveBeenCalledTimes(3); expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 1 });
  });
  it.each(['revision', 'uses', 'source', 'expiry'] as const)('requires a fresh review when %s changes', async change => {
    const f = fixture(); const s = await source(f); const p = await f.preview(s.selection);
    if (change === 'revision') f.revision('c'.repeat(64));
    if (change === 'uses') f.inventory.groups[0]!.uses.push({ kind: 'recipe', id: 'new', label: 'New use' });
    if (change === 'source') f.db.prepare('DELETE FROM authentication_incident_history WHERE id = ?').run(s.done.id);
    if (change === 'expiry') f.time(p.expires_at);
    await expect(start(f, p)).rejects.toMatchObject({ code: change === 'source' ? 'not_found' : 'conflict' }); expect(f.run).toHaveBeenCalledTimes(3);
  });
  it('rechecks source retention after asynchronous credential reads before reserving a job', async () => {
    const f = fixture(); const s = await source(f); const p = await f.preview(s.selection); const normal = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async target => { const prepared = await normal(target); f.db.prepare('DELETE FROM authentication_incident_history WHERE id = ?').run(s.done.id); return prepared; });
    await expect(start(f, p)).rejects.toMatchObject({ code: 'not_found' }); expect(f.run).toHaveBeenCalledTimes(3);
  });
  it('deduplicates lost replies, fences changed selections and resumes an active job without fresh preparation', async () => {
    const f = fixture(); const s = await source(f); const p = await f.preview(s.selection); let release!: () => void;
    f.run.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return [{ kind: 'collection_read', status: 'passed' }]; });
    const first = await start(f, p, [p.targets[0]!.id]); await vi.waitFor(() => expect(release).toBeDefined());
    const replay = await f.service.handle(first.request); expect('verification' in replay && replay.verification.id).toBe(first.verification.id);
    await expect(f.service.handle({ ...first.request, target_ids: [p.targets[1]!.id], choices: [] })).rejects.toMatchObject({ code: 'conflict' });
    f.locked(true); f.inventoryRead.mockRejectedValue(new Error('offline')); f.db.prepare('DELETE FROM authentication_incident_history WHERE id = ?').run(s.done.id);
    const resumed = await f.preview(s.selection); expect(resumed.running?.id).toBe(first.verification.id); expect(resumed.running?.results[0]!.current).toBe('unknown');
    await expect(start(f, resumed)).rejects.toMatchObject({ code: 'conflict' });
    f.locked(false); release(); await f.finished(first.verification.id); expect(f.run).toHaveBeenCalledTimes(4);
  });
  it('keeps reviewed selection and resource inputs stable across caller mutation during final validation', async () => {
    const f = fixture(); const s = await source(f); const p = await f.preview(s.selection); const normal = f.prepare.getMockImplementation()!;
    let entered!: () => void; let release!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    f.prepare.mockImplementationOnce(async target => { entered(); await gate; return normal(target); });
    const ids = [p.targets[1]!.id]; const starting = start(f, p, ids); await entering; ids[0] = p.targets[0]!.id; release();
    const first = await starting; const done = await f.finished(first.verification.id);
    expect(done.results.map(r => r.target.kind)).toEqual(['file_source']); expect(f.run.mock.calls[3]![0]?.file_id).toBe('chosen');
  });
});

describe('explicit saved-authentication access jobs', () => {
  it('finishes an invalid sparse provider result as unconfirmed instead of saving unreadable evidence', async () => {
    const f = fixture(); f.run.mockResolvedValueOnce(Array(1));
    const first = await f.start(await f.preview()); const done = await f.finished(first.verification.id);
    expect(done.results[0]!.checks).toEqual([{ kind: 'api_read', status: 'unconfirmed', reason: 'unavailable' }]);
  });
  it('can read a lost-reply receipt created before target subsets, with the original resource object ordering', async () => {
    const f = fixture(); const p = await f.preview(); const first = await f.start(p); await f.finished(first.verification.id);
    const request = { ...first.request, choices: [{ url: first.request.choices[0]!.url, target_id: first.request.choices[0]!.target_id }] };
    const originalHash = createHash('sha256').update(JSON.stringify([request.review_id, request.fingerprint, request.choices])).digest('hex');
    f.db.prepare('UPDATE authentication_access_verifications SET request_hash = ? WHERE id = ?').run(originalHash, first.verification.id);
    const retry = await f.service.handle(request); expect('verification' in retry && retry.verification.id).toBe(first.verification.id); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('releases closed reviews without cancelling a reserved job or breaking a lost-reply retry', async () => {
    const f = fixture();
    for (let i = 0; i < 70; i++) {
      const p = await f.preview(); expect(await f.service.handle({ action: 'authentication_access_retire', review_id: p.id })).toEqual({ action: 'authentication_access_retire' });
      await expect(f.start(p)).rejects.toMatchObject({ code: 'conflict' });
    }
    let release!: () => void; f.run.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return [{ kind: 'api_read', status: 'passed' }]; });
    const p = await f.preview(); const first = await f.start(p); await f.service.handle({ action: 'authentication_access_retire', review_id: p.id });
    const retry = await f.service.handle(first.request); expect('verification' in retry && retry.verification.id).toBe(first.verification.id);
    release(); await f.finished(first.verification.id); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('honors review retirement during asynchronous final validation', async () => {
    const f = fixture(); const p = await f.preview(); const normal = f.prepare.getMockImplementation()!; let entered!: () => void; let release!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    f.prepare.mockImplementationOnce(async target => { entered(); await gate; return normal(target); });
    const starting = f.start(p); const rejected = expect(starting).rejects.toMatchObject({ code: 'conflict' }); await entering;
    await f.service.handle({ action: 'authentication_access_retire', review_id: p.id }); release(); await rejected; expect(f.run).not.toHaveBeenCalled();
  });
  it('reserves the preview capacity before asynchronous inventory reads', async () => {
    const f = fixture(); const results = await Promise.allSettled(Array.from({ length: 65 }, () => f.preview()));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(64);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1); expect(f.run).not.toHaveBeenCalled();
  });
  it('refuses a review that expires during asynchronous final validation', async () => {
    const f = fixture(); const p = await f.preview(); const normal = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async target => { const saved = await normal(target); f.time(p.expires_at); return saved; });
    await expect(f.start(p)).rejects.toMatchObject({ code: 'conflict' }); expect(f.run).not.toHaveBeenCalled();
  });
  it('prepares locally, saves per-target results, and leaves workflows, repair status and sync untouched', async () => {
    const f = fixture(); const p = await f.preview(); expect(isAuthenticationAccessPreview(p)).toBe(true); expect(f.run).not.toHaveBeenCalled();
    const { verification } = await f.start(p); const done = await f.finished(verification.id);
    expect(isAuthenticationAccessVerification(done)).toBe(true); expect(done.results[0]).toMatchObject({ target: f.target, current: 'yes', authentication_revision: 'b'.repeat(64),
      checks: [{ kind: 'api_read', status: 'passed' }, { kind: 'write_permissions', status: 'unconfirmed', reason: 'not_executed' }] });
    expect(done.uses).toEqual(f.inventory.groups[0]!.uses); expect(f.run).toHaveBeenCalledTimes(1);
    const decorated = await f.service.worklist(f.inventory); expect(decorated.groups[0]!.access_verification?.id).toBe(done.id);
    expect(f.inventory.groups[0]!.access_verification).toBeUndefined();
    await f.status(done.id); await f.service.worklist(f.inventory); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it.each(['group', 'repair'] as const)('keeps %s summaries available when the newest legacy source is unreadable', async kind => {
    const f = fixture(); const history = createAuthenticationIncidentStore(f.db); let selection: AuthenticationAccessSelection = f.selection;
    if (kind === 'repair') {
      const actions = createAuthenticationRepairActionStore(f.db);
      actions.begin('connection_credentials', 'audit', { action: 'reauthorize', targets: [f.target] }, 900);
      actions.finish('connection_credentials', 'audit', { status: 'applied' }, 950);
      selection = { kind: 'repair', id: history.history({ scope: { kind: 'all' } }, 1000).repairs![0]!.id };
    }
    const first = await f.start(await f.preview(selection)); await f.finished(first.verification.id);
    const worklist = await f.service.worklist(f.inventory); const page = await f.service.history(history.history({ scope: { kind: 'all' } }, 1000));
    const beforeRuns = f.run.mock.calls.length;
    for (const invalid of ['private-invalid-json', '{}', JSON.stringify({ ...(await f.status(first.verification.id)), id: 'verify-92345678-1234-4123-8123-123456789abc' })]) {
      f.db.prepare('UPDATE authentication_access_verifications SET data = ? WHERE id = ?').run(invalid, first.verification.id);
      const row = kind === 'group' ? (await f.service.worklist(worklist)).groups[0]! : (await f.service.history(page)).repairs![0]!;
      expect(row.access_summary!.targets[0]!.state).toBe('unavailable'); expect(row.access_verification).toBeUndefined();
      expect(JSON.stringify(row)).not.toContain('private-invalid-json');
      await expect(f.status(first.verification.id)).rejects.toMatchObject({ code: 'not_configured' });
    }
    expect(f.run).toHaveBeenCalledTimes(beforeRuns);
  });
  it('shares one bounded current-authentication comparison across summaries and legacy worklist results', async () => {
    const f = fixture(); const inventory: AuthenticationRepairWorklist = { observed_at: 1000, unavailable: [], groups: [] };
    for (let n = 0; n < 17; n++) {
      const group = { ...structuredClone(f.inventory.groups[0]!), id: n.toString(16).padStart(64, '0'),
        targets: Array.from({ length: 32 }, (_, i): AuthenticationRepairTarget => ({ kind: 'connection', name: 'work-' + n + '-' + i })) };
      inventory.groups.push(group);
      const value: AuthenticationAccessVerification = { id: 'verify-' + n.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc',
        selection: { kind: 'group', id: group.id }, status: 'completed', started_at: 900, finished_at: 950, targets_truncated: false, uses: [], usage_available: true,
        results: group.targets.map(target => ({ id: createHash('sha256').update(JSON.stringify(JSON.stringify(target))).digest('hex'), target,
          label: 'Work', authentication_revision: 'b'.repeat(64), current: 'yes', checks: [{ kind: 'api_read', status: 'passed' }] })) };
      f.db.prepare('INSERT INTO authentication_access_verifications (id, attempt_id, selection_key, request_hash, data, finished_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(value.id, 'attempt-' + n, JSON.stringify(['group', group.id]), 'test', JSON.stringify(value), value.finished_at);
    }
    const service = f.create(); f.prepare.mockClear(); const result = await service.worklist(inventory);
    expect(f.prepare).toHaveBeenCalledTimes(512); expect(result.groups.at(-1)!.access_summary!.lookup_incomplete).toBe(true);
    expect(result.groups.at(-1)!.access_verification!.results.every(r => r.current === 'unknown')).toBe(true); expect(f.run).not.toHaveBeenCalled();
  });
  it('accepts disjoint bulk group subsets, keeps separate receipts and does not recheck shared resources', async () => {
    const f = fixture(); const file: AuthenticationRepairTarget = { kind: 'file_source', source_id: 'work.files' };
    const other = { ...structuredClone(f.inventory.groups[0]!), id: 'd'.repeat(64), label: 'Other OAuth account', targets: [f.target, file] };
    f.inventory.groups.push(other);
    const first = await f.preview(); const second = await f.preview({ kind: 'group', id: other.id });
    f.run.mockResolvedValueOnce([{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }])
      .mockResolvedValueOnce([{ kind: 'file_metadata', status: 'passed' }, { kind: 'file_download', status: 'unconfirmed', reason: 'resource_required' }]);
    const left = await f.service.handle({ action: 'authentication_access_run', review_id: first.id, fingerprint: first.fingerprint, attempt_id: nonce(), choices: [], target_ids: [first.targets[0]!.id] });
    if (left.action !== 'authentication_access_run') throw Error('run'); await f.finished(left.verification.id);
    const fileId = second.targets.find(t => t.target.kind === 'file_source')!.id;
    const request = { action: 'authentication_access_run' as const, review_id: second.id, fingerprint: second.fingerprint, attempt_id: nonce(), choices: [], target_ids: [fileId] };
    const right = await f.service.handle(request); if (right.action !== 'authentication_access_run') throw Error('run'); await f.finished(right.verification.id);
    const replay = await f.service.handle(request); expect(replay).toMatchObject({ verification: { id: right.verification.id } }); expect(f.run).toHaveBeenCalledTimes(2);
    const worklist = await f.service.worklist(f.inventory); expect(worklist.groups[1]!.access_summary!.targets.map(t => t.latest!.id)).toEqual([left.verification.id, right.verification.id]);
    expect(worklist.groups[1]!.access_verification!.results.map(r => r.target)).toEqual([file]);
    expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_targets').get()).toEqual({ n: 2 });
  });
  it('returns a checking receipt before a slow vendor finishes and deduplicates a lost start reply', async () => {
    const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.run.mockImplementation(async () => { await gate; return [{ kind: 'api_read', status: 'passed' }]; });
    const p = await f.preview(); const first = await f.start(p); expect(first.verification.status).toBe('checking');
    const replay = await f.service.handle(first.request); expect('verification' in replay && replay.verification.id).toBe(first.verification.id);
    const duplicate = await f.service.handle({ ...first.request, attempt_id: nonce() }); expect('verification' in duplicate && duplicate.verification.id).toBe(first.verification.id);
    await expect(f.service.handle({ ...first.request, choices: [] })).rejects.toMatchObject({ code: 'conflict' });
    release(); await f.finished(first.verification.id); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('deduplicates simultaneous starts and rejects a different check for an already running selection', async () => {
    const f = fixture(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.run.mockImplementation(async () => { await gate; return [{ kind: 'api_read', status: 'passed' }]; });
    const p = await f.preview(); const [first, second] = await Promise.all([f.start(p), f.start(p)]);
    expect(first.verification.id).toBe(second.verification.id);
    await expect(f.start(p, nonce(), 'https://vendor.test/v1/other')).rejects.toMatchObject({ code: 'conflict' });
    release(); await f.finished(first.verification.id); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('rejects stale permission, membership, expired and malformed reviews before vendor work', async () => {
    const f = fixture(); const p = await f.preview(); f.revision('c'.repeat(64)); await expect(f.start(p)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.run).not.toHaveBeenCalled(); const next = await f.preview(); f.inventory.groups[0]!.uses.push({ kind: 'recipe', id: 'new', label: 'New recipe' });
    await expect(f.start(next)).rejects.toMatchObject({ code: 'conflict' });
    const expired = await f.preview(); f.time(expired.expires_at); await expect(f.start(expired)).rejects.toMatchObject({ code: 'conflict' });
    await expect(f.service.handle({ action: 'authentication_access_preview', selection: { kind: 'group', id: 'invalid' } })).rejects.toMatchObject({ code: 'bad_request' });
  });
  it.each(['https://evil.test/v1/account', 'https://vendor.test/v1/../private', 'https://vendor.test/v1/protected?access_token=secret'])('rejects an unsafe resource before a job is reserved: %s', async url => {
    const f = fixture(); await expect(f.start(await f.preview(), nonce(), url)).rejects.toMatchObject({ code: 'bad_request' });
    expect(f.run).not.toHaveBeenCalled(); expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 0 });
  });
  it('continues per target after failure and never copies raw errors or resource URLs into the receipt', async () => {
    const f = fixture(); f.inventory.groups[0]!.targets.push({ kind: 'connection', name: 'second' });
    f.run.mockRejectedValueOnce(new RpcError('credential_verification_failed', 'never-export-secret', 422, undefined, { verification_status: 'auth_failed' }));
    const { verification } = await f.start(await f.preview()); const done = await f.finished(verification.id);
    expect(done.results[0]!.checks[0]).toEqual({ kind: 'api_read', status: 'failed', reason: 'access_rejected' }); expect(done.results[1]!.checks[0]!.status).toBe('passed');
    expect(f.run).toHaveBeenCalledTimes(2); expect(JSON.stringify(f.db.prepare('SELECT * FROM authentication_access_verifications').all())).not.toMatch(/never-export|https:|fields=id/);
  });
  it('fences an authentication change during a successful read and supersedes earlier results on read', async () => {
    const f = fixture(); f.run.mockImplementationOnce(async () => { f.revision('d'.repeat(64)); return [{ kind: 'api_read', status: 'passed' }]; });
    const started = await f.start(await f.preview()); const done = await f.finished(started.verification.id);
    expect(done.results[0]).toMatchObject({ current: 'no', checks: [{ status: 'unconfirmed', reason: 'changed' }] });
    f.run.mockResolvedValue([{ kind: 'api_read', status: 'passed' }]); const fresh = await f.start(await f.preview()); await f.finished(fresh.verification.id);
    f.revision('e'.repeat(64)); expect((await f.status(fresh.verification.id)).results[0]!.current).toBe('no');
    f.locked(true); expect((await f.status(fresh.verification.id)).results[0]!.current).toBe('unknown');
  });
  it('retains a completed check after restart and closes interrupted work without replay', async () => {
    const f = fixture(); const first = await f.start(await f.preview()); const done = await f.finished(first.verification.id);
    done.status = 'checking'; delete done.finished_at; done.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'not_checked' }];
    f.db.prepare('UPDATE authentication_access_verifications SET data = ?, finished_at = NULL WHERE id = ?').run(JSON.stringify(done), done.id);
    const restarted = f.create(); const read = await restarted.handle({ action: 'authentication_access_status', id: done.id });
    expect('verification' in read && read.verification).toMatchObject({ status: 'completed', results: [{ checks: [{ reason: 'interrupted' }] }] });
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('retains checks started from the worklist in scoped history after authentication changes', async () => {
    const f = fixture(); const start = await f.start(await f.preview()); await f.finished(start.verification.id); f.revision('e'.repeat(64));
    const history = createAuthenticationIncidentStore(f.db);
    const page = await f.service.history(history.history({ scope: f.target }, 1000));
    expect(page.order).toEqual([start.verification.id]); expect(page.verifications).toHaveLength(1);
    expect(page.verifications![0]!.results[0]!.current).toBe('no');
    expect(history.history({ scope: { kind: 'group', id: f.selection.id } }, 1000).verifications).toHaveLength(1);
    expect(history.history({ scope: { kind: 'connection', name: 'unrelated' } }, 1000).verifications).toHaveLength(0);
  });
  it('reserves the source receipt and history atomically before any vendor work', async () => {
    const f = fixture(); const plan = await f.preview();
    f.db.exec("CREATE TRIGGER deny_verification BEFORE INSERT ON authentication_incident_history WHEN NEW.kind = 'verification' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
    await expect(f.start(plan)).rejects.toThrow('receipt failure'); expect(f.run).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 0 });
    expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_targets').get()).toEqual({ n: 0 });
  });
  it('bounds an ignored vendor abort and prevents late success from changing the saved outcome', async () => {
    vi.useFakeTimers(); const f = fixture(); let release!: () => void; let signal: AbortSignal | undefined;
    f.run.mockImplementation(async (_choice, incoming) => { signal = incoming; await new Promise<void>(resolve => { release = resolve; }); return [{ kind: 'api_read', status: 'passed' }]; });
    const first = await f.start(await f.preview()); for (let i = 0; i < 20; i++) await Promise.resolve(); expect(release).toBeDefined();
    await vi.advanceTimersByTimeAsync(65_000); expect(signal?.aborted).toBe(true);
    expect((await f.status(first.verification.id)).results[0]!.checks[0]).toMatchObject({ status: 'unconfirmed', reason: 'unavailable' });
    release(); for (let i = 0; i < 20; i++) await Promise.resolve();
    expect((await f.status(first.verification.id)).results[0]!.checks[0]!.status).toBe('unconfirmed'); expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('associates exact applied-repair targets, keeps old incidents separate, and decorates only the matching action', async () => {
    const f = fixture(); const repairs = createAuthenticationRepairActionStore(f.db); const history = createAuthenticationIncidentStore(f.db);
    repairs.begin('connection_credentials', 'apply', { action: 'reauthorize', targets: [f.target] }, 900); repairs.finish('connection_credentials', 'apply', { status: 'applied' }, 950);
    const action = history.history({ scope: { kind: 'all' } }, 1000).repairs![0]!;
    const reply = await f.service.handle({ action: 'authentication_access_preview', selection: { kind: 'repair', id: action.id } });
    if (reply.action !== 'authentication_access_preview') throw new Error('preview'); const start = await f.start(reply.preview); await f.finished(start.verification.id);
    f.prepare.mockClear(); const decorated = await f.service.history(history.history({ scope: { kind: 'all' } }, 1000));
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(decorated.repairs![0]).toMatchObject({ status: 'applied', access_verification: { status: 'completed' } });
    expect(decorated.repairs![0]!.recovery_confirmed_at).toBeUndefined(); expect(decorated.incidents).toEqual([]);
  });
  it('expires retained results after 90 days and refuses unsupported injected results', async () => {
    const f = fixture(); f.run.mockResolvedValueOnce([{ kind: 'api_read', status: 'passed', reason: 'not_executed' }]);
    const first = await f.start(await f.preview()); const done = await f.finished(first.verification.id);
    expect(done.results[0]!.checks[0]).toMatchObject({ status: 'unconfirmed', reason: 'unavailable' });
    f.time(1000 + 91 * 86_400_000); await expect(f.status(done.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await f.service.worklist(f.inventory)).groups[0]!.access_verification).toBeUndefined();
  });
  it('routes all access actions through the existing owner-managed authentication handler', async () => {
    const f = fixture(); const connections = createConnectionStore(f.db);
    const handler = makeConnectionHandlers({ store: connections, authenticationAccess: f.service, authenticationRepairs: async () => f.inventory })!;
    const reply = await handler.handlers['collection.connection.managedOAuth']({ action: 'authentication_access_preview', selection: f.selection }, undefined as never);
    expect(reply.action).toBe('authentication_access_preview'); expect(f.run).not.toHaveBeenCalled();
    const old = makeConnectionHandlers({ store: connections })!;
    await expect(old.handlers['collection.connection.managedOAuth']({ action: 'authentication_access_preview', selection: f.selection }, undefined as never)).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('access verification from retained token-renewal results', () => {
  const retain = (f: ReturnType<typeof fixture>, targets: AuthenticationRepairTarget[] = []) => {
    const value: OAuthAppRenewalVerification = { id: 'renewal-12345678-1234-4123-8123-123456789abc', issuer: 'google', app_id: 'default', app_revision: 1,
      app_label: 'Work app', status: 'completed', started_at: 800, finished_at: 900, incomplete: false,
      results: [{ id: 'c'.repeat(64), revision: 'd'.repeat(64), label: 'Shared API', connections: ['work'], native_accounts: [], eligible: true, status: 'passed', current: 'yes' },
        { id: 'e'.repeat(64), revision: 'f'.repeat(64), label: 'Native calendar', connections: [], native_accounts: [{ platform: 'calendar', slug: 'native' }],
          eligible: true, status: 'unconfirmed', reason: 'not_selected', current: 'yes' }] };
    createOAuthAppRenewalHistory(f.db).begin(value, 800, { groups: [f.selection.id], targets });
    return { value, selection: { kind: 'renewal' as const, id: value.id } };
  };
  const start = async (f: ReturnType<typeof fixture>, p: AuthenticationAccessPreview) => {
    const reply = await f.service.handle({ action: 'authentication_access_run', review_id: p.id, fingerprint: p.fingerprint, attempt_id: nonce(),
      choices: p.targets.filter(t => t.check === 'api_read').map(t => ({ target_id: t.id, url: 'https://vendor.test/v1/protected' })) });
    if (reply.action !== 'authentication_access_run') throw Error('run'); return reply.verification;
  };
  it.each(['vault locked', 'source evicted', 'inventory unavailable', 'review capacity full'] as const)('resumes saved status when fresh preparation is blocked: %s', async why => {
    const f = fixture(); const r = retain(f); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.run.mockImplementation(async () => { await gate; return [{ kind: 'api_read', status: 'passed' }]; });
    const first = await start(f, await f.preview(r.selection)); await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    let resumed: AuthenticationAccessPreview | undefined;
    try {
      if (why === 'vault locked') f.locked(true);
      if (why === 'source evicted') f.db.prepare('DELETE FROM authentication_incident_history WHERE id = ?').run(r.value.id);
      if (why === 'inventory unavailable') f.inventoryRead.mockRejectedValue(new Error('local inventory unavailable'));
      if (why === 'review capacity full') for (let i = 0; i < 64; i++) await f.preview();
      resumed = await f.preview(r.selection);
      expect(isAuthenticationAccessPreview(resumed)).toBe(true); expect(resumed.running?.id).toBe(first.id);
      expect(f.run).toHaveBeenCalledTimes(1);
      await expect(start(f, resumed)).rejects.toMatchObject({ code: 'conflict' });
      expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 1 });
    } finally { f.locked(false); release(); await f.finished(first.id); }
    await expect(start(f, resumed!)).rejects.toMatchObject({ code: 'conflict' });
    expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 1 });
  });
  it('retains only the typed selection identity and isolates it from caller metadata and later mutation', async () => {
    const f = fixture(); const r = retain(f); const selected = { ...r.selection, client_secret: 'private-extra-selection', url: 'https://vendor.test/private-extra-selection' };
    const p = await f.preview(selected); expect.soft(p.selection).toEqual(r.selection);
    const v = await start(f, p); await f.finished(v.id);
    expect.soft(JSON.stringify(f.db.prepare('SELECT data FROM authentication_access_verifications').all())).not.toContain('private-extra-selection');
    expect.soft(JSON.stringify(f.db.prepare("SELECT data FROM authentication_incident_history WHERE kind = 'verification'").all())).not.toContain('private-extra-selection');
    selected.id = 'renewal-22345678-1234-4123-8123-123456789abc'; expect(p.selection).toEqual(r.selection);
  });
  it('reviews retained API, native, connection-backed collection and file references without broadening to other app uses', async () => {
    const f = fixture(); const mail: AuthenticationRepairTarget = { kind: 'collection', platform: 'mail', slug: 'bound' };
    const file: AuthenticationRepairTarget = { kind: 'file_source', source_id: 'files-work' };
    f.inventory.groups[0]!.targets.push(mail, file);
    f.inventory.groups.push({ ...f.inventory.groups[0]!, id: '9'.repeat(64), connection_names: ['unrelated'], targets: [{ kind: 'connection', name: 'unrelated' }] });
    const r = retain(f, [mail, file]); const p = await f.preview(r.selection);
    expect(isAuthenticationAccessPreview(p)).toBe(true); expect(f.run).not.toHaveBeenCalled();
    expect(p.targets.map(t => t.target)).toEqual(expect.arrayContaining([f.target, mail, file, { kind: 'collection', platform: 'calendar', slug: 'native' }]));
    expect(p.targets).toHaveLength(4); expect(p.uses).toEqual(f.inventory.groups[0]!.uses);
    expect(p.label).toContain('Current saved authentication');
    const original = f.db.prepare('SELECT data FROM authentication_incident_history WHERE id = ?').get(r.value.id);
    const v = await start(f, p); const done = await f.finished(v.id);
    expect(done.selection).toEqual(r.selection); expect(f.run).toHaveBeenCalledTimes(4);
    expect(f.db.prepare('SELECT data FROM authentication_incident_history WHERE id = ?').get(r.value.id)).toEqual(original);
    const history = createAuthenticationIncidentStore(f.db);
    for (const scope of [{ kind: 'oauth_apps' as const }, { kind: 'group' as const, id: f.selection.id }, mail, file, f.target]) {
      expect(history.history({ scope, include_renewals: true }, 1000).verifications!.map(v => v.id)).toContain(done.id);
    }
    expect(history.history({ scope: { kind: 'connection', name: 'unrelated' } }, 1000).verifications).toEqual([]);
    expect(history.history({ scope: { kind: 'all' } }, 1000).incidents).toEqual([]);
  });
  it('resumes the matching active access receipt without replaying a vendor read', async () => {
    const f = fixture(); const r = retain(f); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    f.run.mockImplementation(async () => { await gate; return [{ kind: 'api_read', status: 'passed' }]; });
    const first = await start(f, await f.preview(r.selection)); await vi.waitFor(() => expect(f.run).toHaveBeenCalledTimes(1));
    const reopened = await f.preview(r.selection); expect(reopened.running?.id).toBe(first.id); expect(isAuthenticationAccessPreview(reopened)).toBe(true);
    expect(f.run).toHaveBeenCalledTimes(1); release(); await f.finished(first.id);
    expect((await f.preview(r.selection)).running).toBeUndefined();
  });
  it('uses only explicit references from older receipts and declares missing coverage', async () => {
    const f = fixture(); const r = retain(f); f.db.prepare('DELETE FROM authentication_incident_targets WHERE incident_id = ?').run(r.value.id);
    const p = await f.preview(r.selection); expect(p.targets.map(t => t.target)).toEqual([f.target, { kind: 'collection', platform: 'calendar', slug: 'native' }]);
    expect(p.targets_truncated).toBe(true); expect(f.run).not.toHaveBeenCalled();
  });
  it('bounds retained references and carries incomplete inventory into access evidence', async () => {
    const f = fixture(); const extra: AuthenticationRepairTarget[] = Array.from({ length: 35 }, (_, i) => ({ kind: 'connection', name: 'copy-' + i }));
    const r = retain(f, extra); const p = await f.preview(r.selection);
    expect(p.targets).toHaveLength(32); expect(p.targets_truncated).toBe(true); expect(f.run).not.toHaveBeenCalled();
  });
  it('blocks unfinished, expired and evicted renewal receipts before any vendor work', async () => {
    const f = fixture(); const r = retain(f);
    f.db.prepare('UPDATE authentication_incident_history SET ended_at = NULL, data = ? WHERE id = ?')
      .run(JSON.stringify({ ...r.value, status: 'checking', finished_at: undefined }), r.value.id);
    await expect(f.preview(r.selection)).rejects.toMatchObject({ code: 'bad_request' });
    f.db.prepare('UPDATE authentication_incident_history SET ended_at = 900, data = ? WHERE id = ?').run(JSON.stringify(r.value), r.value.id);
    f.time(91 * 86_400_000); await expect(f.preview(r.selection)).rejects.toMatchObject({ code: 'not_found' });
    f.time(1000); f.db.prepare('DELETE FROM authentication_incident_history WHERE id = ?').run(r.value.id);
    await expect(f.preview(r.selection)).rejects.toMatchObject({ code: 'not_found' }); expect(f.run).not.toHaveBeenCalled();
  });
  it('fences authentication, retained membership and source eviction during final validation', async () => {
    const f = fixture(); const r = retain(f); const p = await f.preview(r.selection);
    f.revision('8'.repeat(64)); await expect(start(f, p)).rejects.toMatchObject({ code: 'conflict' });
    const changed = await f.preview(r.selection);
    f.db.prepare('INSERT INTO authentication_incident_targets (incident_id, scope_key) VALUES (?, ?)').run(r.value.id, JSON.stringify({ kind: 'connection', name: 'added' }));
    await expect(start(f, changed)).rejects.toMatchObject({ code: 'conflict' });
    const fresh = await f.preview(r.selection); const normal = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async target => { const p = await normal(target); f.db.prepare('DELETE FROM authentication_incident_history WHERE id = ?').run(r.value.id); return p; });
    await expect(start(f, fresh)).rejects.toMatchObject({ code: 'not_found' }); expect(f.run).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT count(*) AS n FROM authentication_access_verifications').get()).toEqual({ n: 0 });
  });
});
