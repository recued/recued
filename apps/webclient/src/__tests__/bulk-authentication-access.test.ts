import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticationAccessRecheckResults, type AuthenticationAccessPreview, type AuthenticationAccessVerification, type AuthenticationRepairGroup, type ManagedOAuthRequest, type ManagedOAuthResponse } from '@recued/contracts';
import type { ManagedOAuthCaller } from '../settings/managed-oauth-panel.js';
import { createBulkAuthenticationAccess } from '../connections/bulk-authentication-access.js';
import { bulkAuthenticationAccessRechecks } from '../connections/bulk-authentication-access-rechecks.js';

afterEach(() => vi.useRealTimers());
const hash = (n: number) => n.toString(16).padStart(64, '0');
const group = (n: number): AuthenticationRepairGroup => ({ id: hash(n), label: 'Account ' + n, kind: 'account', authentication: 'direct_oauth',
  connection_names: ['api-' + n], targets: [{ kind: 'connection', name: 'api-' + n }], issues: [], uses: [], usage_available: true });
const fixture = (count = 2) => {
  const groups = Array.from({ length: count }, (_, n) => group(n + 1)); const jobs = new Map<string, AuthenticationAccessVerification>();
  const attempts = new Map<string, string>(); const previews = new Map<string, AuthenticationAccessPreview>(); let clock = 1000; let immediate = true; let serial = 0;
  const review = (g: AuthenticationRepairGroup): AuthenticationAccessPreview => ({ id: 'p'.repeat(40) + g.id.slice(-3), fingerprint: g.id, expires_at: 100000,
    selection: { kind: 'group', id: g.id }, label: g.label, targets_truncated: false, usage_available: true, uses: [],
    targets: g.targets.map(t => ({ id: hash(t.kind === 'connection' ? Number(t.name.replace('api-', '')) : 100), target: t,
      label: g.label, authentication_revision: 'b'.repeat(64), check: 'api_read', base_url: 'https://vendor.test/v1' })) });
  const normal = async (args: ManagedOAuthRequest): Promise<ManagedOAuthResponse> => {
    if (args.action === 'authentication_access_retire') return { action: args.action };
    if (args.action === 'authentication_access_preview') {
      const p = args.selection.kind === 'verification' ? {
        ...review(groups[0]!), id: 'r'.repeat(40) + (previews.size + 1).toString().padStart(3, '0'), selection: args.selection,
        targets: authenticationAccessRecheckResults(jobs.get(args.selection.id)!).map(r => ({ id: r.id, target: r.target, label: r.label, authentication_revision: 'b'.repeat(64), check: 'api_read' as const, base_url: 'https://vendor.test/v1' })),
      } : review(groups.find(g => g.id === args.selection.id)!);
      previews.set(p.id, p); return { action: args.action, preview: structuredClone(p) };
    }
    if (args.action === 'authentication_access_run') {
      const previous = attempts.get(args.attempt_id); if (previous) return { action: args.action, verification: structuredClone(jobs.get(previous)!) };
      const p = previews.get(args.review_id)!; const id = 'verify-' + (++serial).toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc';
      const v: AuthenticationAccessVerification = { id, selection: p.selection, status: immediate ? 'completed' : 'checking', started_at: 1000,
        ...(immediate ? { finished_at: 2000 } : {}), targets_truncated: false, uses: [], usage_available: true,
        results: p.targets.filter(t => args.target_ids?.includes(t.id)).map(t => ({ id: t.id, target: t.target, label: t.label, authentication_revision: t.authentication_revision, current: 'yes',
          checks: [{ kind: 'api_read', status: immediate ? 'passed' : 'unconfirmed', ...(immediate ? {} : { reason: 'not_checked' as const }) }] })) };
      jobs.set(id, v); attempts.set(args.attempt_id, id); return { action: args.action, verification: structuredClone(v) };
    }
    if (args.action === 'authentication_access_status') return { action: args.action, verification: structuredClone(jobs.get(args.id)!) };
    throw new Error('Unexpected action');
  };
  const call = vi.fn<ManagedOAuthCaller>(normal); const changed = vi.fn(); const updated = vi.fn();
  const batch = createBulkAuthenticationAccess({ call, changed, updated, now: () => clock });
  const requests = (action: string) => call.mock.calls.map(([r]) => r).filter(r => r.action === action);
  const complete = (failed = false) => { const job = [...jobs.values()].at(-1)!; job.status = 'completed'; job.finished_at = 2000;
    job.results.forEach(r => { r.checks = failed ? [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }] : [{ kind: 'api_read', status: 'passed' }]; }); };
  return { groups, jobs, previews, normal, call, batch, changed, updated, review, requests, complete,
    immediate: (v: boolean) => { immediate = v; }, time: (v: number) => { clock = v; } };
};
const recheckFixture = async () => {
  const f = fixture(); f.groups[0]!.targets.push({ kind: 'connection', name: 'api-3' });
  await f.batch.prepare(f.groups); await f.batch.start([]); const sources = [...f.jobs.values()];
  sources[0]!.results[0]!.checks = [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }];
  sources[1]!.results[0]!.checks = [{ kind: 'api_read', status: 'unconfirmed', reason: 'resource_required' }];
  f.groups.forEach((g, i) => { g.access_verification = structuredClone(sources[i]!); });
  const candidates = bulkAuthenticationAccessRechecks({ groups: f.groups, observed_at: 3000, unavailable: [] }).checks; f.call.mockClear();
  return { ...f, sources, candidates };
};
describe('bulk access review and queue', () => {
  it('prepares locally and checks a duplicate resource once with separate group receipts', async () => {
    const f = fixture(); f.groups[1]!.targets.unshift(f.groups[0]!.targets[0]!); await f.batch.prepare(f.groups);
    expect(f.requests('authentication_access_run')).toHaveLength(0); expect(f.batch.snapshot().rows.map(r => r.target_ids)).toEqual([[hash(1)], [hash(2)]]);
    await f.batch.start([{ target_id: hash(1), url: 'https://vendor.test/v1/private' }]);
    expect(f.batch.snapshot().phase).toBe('finished'); expect(f.jobs.size).toBe(2);
    expect(f.requests('authentication_access_run').map(r => r.action === 'authentication_access_run' && r.choices)).toEqual([[{ target_id: hash(1), url: 'https://vendor.test/v1/private' }], []]);
    expect(f.updated).toHaveBeenCalledTimes(2); f.batch.dispose();
  });
  it('waits for one saved job, then continues after a failed read', async () => {
    vi.useFakeTimers(); const f = fixture(); f.immediate(false); await f.batch.prepare(f.groups); await f.batch.start([]);
    expect(f.requests('authentication_access_run')).toHaveLength(1); expect(f.batch.snapshot().rows[1]!.state).toBe('queued');
    f.complete(true); await vi.advanceTimersByTimeAsync(1500); expect(f.requests('authentication_access_run')).toHaveLength(2);
    expect(f.batch.snapshot().rows[0]!.result!.results[0]!.checks[0]!.status).toBe('failed');
    f.complete(); await vi.advanceTimersByTimeAsync(1500); expect(f.batch.snapshot().phase).toBe('finished'); f.batch.dispose();
  });
  it('reports an unavailable local review and continues with the other accounts', async () => {
    const f = fixture(); f.call.mockRejectedValueOnce(new Error('private secret')); await f.batch.prepare(f.groups);
    expect(f.batch.snapshot().rows[0]!.state).toBe('unavailable'); await f.batch.start([]); expect(f.jobs.size).toBe(1);
    expect(JSON.stringify(f.batch.snapshot())).not.toContain('private secret'); f.batch.dispose();
  });
  it('skips a completely duplicated account and retires its unused review', async () => {
    const f = fixture(); f.groups[1]!.targets = f.groups[0]!.targets.slice(); await f.batch.prepare(f.groups);
    expect(f.batch.snapshot().rows[1]!.state).toBe('duplicate'); expect(f.requests('authentication_access_retire')).toHaveLength(1);
    await f.batch.start([]); expect(f.jobs.size).toBe(1); f.batch.dispose();
  });
  it('rejects more than 16 accounts and marks resources beyond 128 unavailable', async () => {
    const f = fixture(17); await f.batch.prepare(f.groups); expect(f.call).not.toHaveBeenCalled();
    for (const [index, g] of f.groups.slice(0, 5).entries()) g.targets = Array.from({ length: 32 }, (_, n) => ({ kind: 'connection', name: 'api-' + (index * 32 + n + 1) }));
    await f.batch.prepare(f.groups.slice(0, 5)); expect(f.batch.snapshot().rows.map(r => r.state)).toEqual(['ready', 'ready', 'ready', 'ready', 'unavailable']);
    expect(f.batch.snapshot().rows.flatMap(r => r.target_ids)).toHaveLength(128); f.batch.dispose();
  });
  it('refuses inconsistent revisions of a shared resource instead of deduplicating them', async () => {
    const f = fixture(); f.groups[1]!.targets = f.groups[0]!.targets.slice();
    f.call.mockImplementation(async args => { const reply = await f.normal(args); if (reply.action === 'authentication_access_preview' && reply.preview.selection.id === hash(2)) reply.preview.targets[0]!.authentication_revision = 'c'.repeat(64); return reply; });
    await f.batch.prepare(f.groups); expect(f.batch.snapshot().rows.every(r => r.state === 'unavailable')).toBe(true); await f.batch.start([]);
    expect(f.requests('authentication_access_run')).toHaveLength(0); f.batch.dispose();
  });
  it('recovers a lost start reply with the frozen request and does not repeat the vendor job', async () => {
    const f = fixture(); let lost = true;
    f.call.mockImplementation(async args => { const reply = await f.normal(args); if (args.action === 'authentication_access_run' && lost) { lost = false; throw new Error('lost'); } return reply; });
    await f.batch.prepare(f.groups); const choices = [{ target_id: hash(1), url: 'https://vendor.test/v1/chosen' }]; await f.batch.start(choices);
    expect(f.batch.snapshot().phase).toBe('paused'); expect(f.jobs.size).toBe(1); choices[0]!.url = 'https://vendor.test/v1/changed'; f.time(200000);
    await f.batch.recover(); const starts = f.requests('authentication_access_run'); expect(starts[1]).toEqual(starts[0]); expect(f.jobs.size).toBe(1);
    expect(f.batch.snapshot().rows[1]!.state).toBe('unavailable'); expect(f.batch.snapshot().phase).toBe('finished'); f.batch.dispose();
  });
  it('recovers a status failure by reading the same job, then continues the queue', async () => {
    vi.useFakeTimers(); const f = fixture(); f.immediate(false); let fail = true;
    f.call.mockImplementation(async args => { if (args.action === 'authentication_access_status' && fail) { fail = false; throw new Error('offline'); } return f.normal(args); });
    await f.batch.prepare(f.groups); await f.batch.start([]); await vi.advanceTimersByTimeAsync(1500); expect(f.batch.snapshot().phase).toBe('paused');
    f.complete(); f.immediate(true); await f.batch.recover(); expect(f.requests('authentication_access_run')).toHaveLength(2); expect(f.jobs.size).toBe(2);
    const statuses = f.requests('authentication_access_status'); expect(statuses[1]).toEqual(statuses[0]); expect(f.batch.snapshot().phase).toBe('finished'); f.batch.dispose();
  });
  it.each(['target', 'revision', 'clock'] as const)('pauses on a saved-status %s mismatch and retains the previous result', async mismatch => {
    vi.useFakeTimers(); const f = fixture(); f.immediate(false); await f.batch.prepare(f.groups); await f.batch.start([]); f.complete();
    f.call.mockImplementation(async args => { const reply = await f.normal(args); if (reply.action === 'authentication_access_status') {
      if (mismatch === 'target') reply.verification.results[0]!.target = { kind: 'connection', name: 'other' };
      if (mismatch === 'revision') reply.verification.results[0]!.authentication_revision = 'd'.repeat(64);
      if (mismatch === 'clock') reply.verification.started_at = 999;
    } return reply; });
    await vi.advanceTimersByTimeAsync(1500); expect(f.batch.snapshot().phase).toBe('paused');
    expect(f.batch.snapshot().rows[0]!.result!.status).toBe('checking'); expect(f.requests('authentication_access_run')).toHaveLength(1); f.batch.dispose();
  });
  it('stops queued work and refreshes only already-started receipts', async () => {
    vi.useFakeTimers(); const f = fixture(); f.immediate(false); await f.batch.prepare(f.groups); await f.batch.start([]); f.batch.stop();
    await vi.advanceTimersByTimeAsync(30000); expect(f.requests('authentication_access_status')).toHaveLength(0); f.complete(); await f.batch.refresh();
    expect(f.requests('authentication_access_run')).toHaveLength(1); expect(f.batch.snapshot().rows.map(r => r.state)).toEqual(['completed', 'stopped']);
    expect(f.batch.snapshot().phase).toBe('stopped'); f.batch.dispose();
  });
  it('does not recover an uncertain start after Stop', async () => {
    const f = fixture(); await f.batch.prepare(f.groups); f.call.mockRejectedValueOnce(new Error('offline')); await f.batch.start([]);
    f.batch.stop(); await f.batch.recover(); expect(f.requests('authentication_access_run')).toHaveLength(1); f.batch.dispose();
  });
  it('keeps a late start receipt after Stop without starting the next account', async () => {
    const f = fixture(); await f.batch.prepare(f.groups); let release!: () => void;
    f.call.mockImplementationOnce(async args => { const reply = await f.normal(args); await new Promise<void>(resolve => { release = resolve; }); return reply; });
    const pending = f.batch.start([]); await Promise.resolve(); f.batch.stop(); release(); await pending;
    expect(f.batch.snapshot().phase).toBe('stopped'); expect(f.batch.snapshot().rows.map(r => r.state)).toEqual(['completed', 'stopped']);
    expect(f.requests('authentication_access_run')).toHaveLength(1); expect(f.jobs.size).toBe(1); f.batch.dispose();
  });
  it('ignores a late start receipt after the stopped review is closed', async () => {
    const f = fixture(); await f.batch.prepare(f.groups); let release!: () => void;
    f.call.mockImplementationOnce(async args => { const reply = await f.normal(args); await new Promise<void>(resolve => { release = resolve; }); return reply; });
    const pending = f.batch.start([]); await Promise.resolve(); f.batch.stop(); f.batch.reset(); const before = f.changed.mock.calls.length; release(); await pending;
    expect(f.batch.snapshot().phase).toBe('idle'); expect(f.batch.snapshot().rows).toHaveLength(0); expect(f.changed).toHaveBeenCalledTimes(before);
    expect(f.requests('authentication_access_run')).toHaveLength(1); expect(f.jobs.size).toBe(1); f.batch.dispose();
  });
  it.each(['foreign target', 'external URL'] as const)('rejects an injected %s before starting', async what => {
    const f = fixture(); await f.batch.prepare(f.groups); await f.batch.start([{ target_id: what === 'foreign target' ? hash(99) : hash(1), url: 'https://elsewhere.test/private' }]);
    expect(f.batch.snapshot().phase).toBe('review'); expect(f.requests('authentication_access_run')).toHaveLength(0); f.batch.dispose();
  });
  it('retires a late preview after disposal without reopening or running it', async () => {
    const f = fixture(); let release!: (reply: ManagedOAuthResponse) => void;
    f.call.mockImplementationOnce(() => new Promise(resolve => { release = resolve; })); const p = f.batch.prepare(f.groups); f.batch.dispose();
    const before = f.changed.mock.calls.length; release({ action: 'authentication_access_preview', preview: f.review(f.groups[0]!) }); await p;
    expect(f.requests('authentication_access_retire')).toHaveLength(1); expect(f.requests('authentication_access_run')).toHaveLength(0); expect(f.changed).toHaveBeenCalledTimes(before);
  });
});

describe('bulk rechecks of saved non-passing reads', () => {
  it('reviews sources locally and starts only their failed or unconfirmed targets with separate receipts', async () => {
    const f = await recheckFixture(); const original = structuredClone(f.sources); await f.batch.prepareRechecks(f.candidates);
    expect(f.requests('authentication_access_status')).toHaveLength(2); expect(f.requests('authentication_access_preview')).toHaveLength(2); expect(f.requests('authentication_access_run')).toHaveLength(0);
    expect(f.batch.snapshot().rows.map(r => r.target_ids)).toEqual([[hash(1)], [hash(2)]]);
    expect(f.batch.snapshot().rows[0]!.source!.results.map(r => r.id)).toEqual([hash(1), hash(3)]);
    await f.batch.start([{ target_id: hash(1), url: 'https://vendor.test/v1/fresh' }]);
    expect(f.jobs.size).toBe(4); expect(f.sources).toEqual(original);
    expect(f.batch.snapshot().rows.map(r => r.result!.selection)).toEqual(f.sources.map(s => ({ kind: 'verification', id: s.id })));
    expect(f.requests('authentication_access_run').map(r => r.action === 'authentication_access_run' && r.target_ids)).toEqual([[hash(1)], [hash(2)]]); f.batch.dispose();
  });
  it('selects only latest non-passing targets even when the source review also includes an older failure', async () => {
    const f = await recheckFixture(); f.sources[0]!.results[1]!.checks = [{ kind: 'api_read', status: 'failed', reason: 'access_rejected' }];
    await f.batch.prepareRechecks(f.candidates.slice(0, 1));
    expect(f.batch.snapshot().rows[0]!.preview!.targets.map(t => t.id)).toEqual([hash(1), hash(3)]);
    expect(f.batch.snapshot().rows[0]!.target_ids).toEqual([hash(1)]); await f.batch.start([]);
    expect(f.batch.snapshot().rows[0]!.result!.results.map(r => r.id)).toEqual([hash(1)]); f.batch.dispose();
  });
  it.each(['id', 'selection', 'clock', 'target', 'revision', 'checks', 'unfinished'] as const)('rejects a changed source %s before requesting its review', async mismatch => {
    const f = await recheckFixture(); f.call.mockImplementation(async args => { const reply = await f.normal(args); if (reply.action === 'authentication_access_status') {
      if (mismatch === 'id') reply.verification.id = 'verify-00000009-1234-4123-8123-123456789abc';
      if (mismatch === 'selection') reply.verification.selection = { kind: 'group', id: hash(99) };
      if (mismatch === 'clock') reply.verification.finished_at = 2001;
      if (mismatch === 'target') reply.verification.results[0]!.target = { kind: 'connection', name: 'api-other' };
      if (mismatch === 'revision') reply.verification.results[0]!.authentication_revision = hash(99);
      if (mismatch === 'checks') reply.verification.results[0]!.checks = [{ kind: 'api_read', status: 'passed' }];
      if (mismatch === 'unfinished') { reply.verification.status = 'checking'; delete reply.verification.finished_at; }
    } return reply; });
    await f.batch.prepareRechecks(f.candidates.slice(0, 1)); expect(f.batch.snapshot().rows[0]!.state).toBe('unavailable');
    expect(f.requests('authentication_access_preview')).toHaveLength(0); await f.batch.start([]); expect(f.requests('authentication_access_run')).toHaveLength(0); f.batch.dispose();
  });
  it('retires a recheck preview that injects a passed or unrelated resource', async () => {
    const f = await recheckFixture(); f.call.mockImplementation(async args => { const reply = await f.normal(args); if (reply.action === 'authentication_access_preview') {
      const t = f.review(f.groups[0]!).targets.find(t => t.id === hash(3))!; reply.preview.targets.push(t);
    } return reply; });
    await f.batch.prepareRechecks(f.candidates.slice(0, 1)); expect(f.batch.snapshot().rows[0]!.state).toBe('unavailable');
    expect(f.requests('authentication_access_retire').length).toBeGreaterThan(0); expect(f.requests('authentication_access_run')).toHaveLength(0); f.batch.dispose();
  });
  it('skips a missing source and continues with another saved check', async () => {
    const f = await recheckFixture(); f.call.mockImplementation(async args => {
      if (args.action === 'authentication_access_status' && args.id === f.sources[0]!.id) throw Error('private source failure'); return f.normal(args);
    }); await f.batch.prepareRechecks(f.candidates); await f.batch.start([]);
    expect(f.batch.snapshot().rows.map(r => r.state)).toEqual(['unavailable', 'completed']); expect(f.requests('authentication_access_run')).toHaveLength(1);
    expect(JSON.stringify(f.batch.snapshot())).not.toContain('private source failure'); f.batch.dispose();
  });
  it('recovers an uncertain recheck start using the same frozen request', async () => {
    const f = await recheckFixture(); await f.batch.prepareRechecks(f.candidates); let lose = true;
    f.call.mockImplementation(async args => { const reply = await f.normal(args); if (args.action === 'authentication_access_run' && lose) { lose = false; throw Error('lost'); } return reply; });
    await f.batch.start([{ target_id: hash(1), url: 'https://vendor.test/v1/chosen' }]); expect(f.batch.snapshot().phase).toBe('paused');
    await f.batch.recover(); const starts = f.requests('authentication_access_run'); expect(starts[1]).toEqual(starts[0]); expect(f.jobs.size).toBe(4); expect(f.batch.snapshot().phase).toBe('finished'); f.batch.dispose();
  });
  it('does not request a source preview after its status reply arrives on a closed review', async () => {
    const f = await recheckFixture(); let release!: () => void;
    f.call.mockImplementation(async args => { const reply = await f.normal(args);
      if (args.action === 'authentication_access_status') await new Promise<void>(resolve => { release = resolve; }); return reply;
    });
    const pending = f.batch.prepareRechecks(f.candidates); await Promise.resolve(); f.batch.reset(); const changes = f.changed.mock.calls.length; release(); await pending;
    expect(f.requests('authentication_access_preview')).toHaveLength(0); expect(f.batch.snapshot().rows).toEqual([]); expect(f.changed).toHaveBeenCalledTimes(changes); f.batch.dispose();
  });
});
