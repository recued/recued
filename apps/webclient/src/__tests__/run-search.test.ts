import { describe, expect, it, vi } from 'vitest';
import type { ExecutionGetResponse, ExecutionSearchRequest, ExecutionSearchResponse, RunFeedRow } from '@recued/contracts';
import { createRunSearch, readRunSearchPage } from '../logs/run-search.js';
import { renderRunSearch } from '../logs/run-search-view.js';
const row = (id: string, patch: Partial<RunFeedRow> = {}): RunFeedRow => ({ run_id: id, recipe_id: 'follow-up', name: 'Customer follow-up',
  started_at: 100, finished_at: 120, duration_ms: 20, origin: { actor: 'user_self', label: 'user_self' }, status: 'succeeded', policy_result: 'allowed', links: [], ...patch });
const detail = (value: RunFeedRow): ExecutionGetResponse => ({ run: {
  audit: { ...value, recipe_hash: 'fixture', trigger_source: 'manual', instance_id: 'fixture-server', errors: [] },
  approvals: { checkpoints: [] }, errors: [], links: [],
  gateway: { policy_result: value.policy_result, per_call_trace: [] },
} });

describe('run history search', () => {
  it('keeps a fixed start-time window through paging, restore and failed refresh, then resolves it again on a successful refresh', async () => {
    const start = 10 * 86400000; let now = start, fail = false;
    const requests: ExecutionSearchRequest[] = [];
    const search = vi.fn(async (args: ExecutionSearchRequest) => {
      requests.push(args); if (fail) throw Error('Read failed');
      return { runs: [row(args.cursor ? 'older' : 'first', { status: 'failed', started_at: start - (args.cursor ? 200 : 100) })],
        applied_filters: args.filters, ...(!args.cursor ? { next_cursor: { last_event_at: start - 150, last_run_id: 'boundary' } } : {}) };
    });
    const source = createRunSearch({ search, get: async () => detail(row('first')) }, () => {}, { initialFilters: { outcome: 'failed', time_range: '7d' }, now: () => now });
    await source.load('invoice'); const original = { outcome: 'failed', started_from: start - 7 * 86400000, started_before: start + 1 };
    expect(requests[0]!.filters).toEqual(original); now += 1000;
    const snapshot = source.snapshot(); source.reset(); source.restore(snapshot); await source.load('invoice'); expect(search).toHaveBeenCalledTimes(1);
    fail = true; await source.load('invoice', false, true); expect(requests[1]!.filters?.started_before).toBe(now + 1);
    expect(source.state().scope).toEqual(original); expect(source.state().matches[0]!.run_id).toBe('first');
    fail = false; await source.load('invoice', true);
    expect(requests[2]!.filters).toEqual(original); expect(requests[2]!.cursor).toEqual(snapshot.next_cursor);
    expect(source.state().matches.map(value => value.run_id)).toEqual(['first', 'older']);
    await source.load('invoice', false, true); expect(requests[3]!.filters?.started_before).toBe(now + 1);
    expect(source.state().matches.map(value => value.run_id)).toEqual(['first']); source.dispose();
  });

  it('retires held reads and exact selections when the applied run filters change', async () => {
    let finish!: (value: ExecutionSearchResponse) => void, finishGet!: (value: ExecutionGetResponse) => void;
    const search = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ runs: [row('failed', { status: 'failed' })], applied_filters: { outcome: 'failed' } });
    const source = createRunSearch({ search, get: () => new Promise(resolve => { finishGet = resolve; }) }, () => {});
    const old = source.load('invoice'); expect(source.setFilters({ outcome: 'failed' })).toBe(true);
    await source.load('invoice'); finish({ runs: [row('late')] }); await old;
    expect(source.state().matches.map(value => value.run_id)).toEqual(['failed']);
    const selection = source.resolve(source.state().matches[0]!); expect(source.setFilters({ outcome: 'partial' })).toBe(true);
    finishGet(detail(row('failed'))); expect(await selection).toBe(false); expect(source.state().matches).toEqual([]);
    expect(source.setFilters({ outcome: 'not-supported' })).toBe(false); expect(source.state().filters).toEqual({ outcome: 'partial' }); source.dispose();
  });

  it('requires server acknowledgement and validates every returned row against the complete requested scope', async () => {
    const scope = { outcome: 'failed' as const, started_from: 50, started_before: 150 };
    expect(() => readRunSearchPage({ runs: [] }, undefined, scope)).toThrow('Update your Recued server');
    expect(() => readRunSearchPage({ runs: [], applied_filters: { ...scope, started_from: 0 } }, undefined, scope)).toThrow('could not be confirmed');
    for (const run of [row('wrong-outcome'), row('too-old', { status: 'failed', started_at: 49 }), row('too-new', { status: 'failed', started_at: 150 })])
      expect(() => readRunSearchPage({ runs: [run], applied_filters: scope }, undefined, scope)).toThrow('could not be confirmed');
    expect(readRunSearchPage({ runs: [row('boundary', { status: 'failed', started_at: 50 })], applied_filters: scope }, undefined, scope).runs).toHaveLength(1);
    const source = createRunSearch({ search: async () => ({ runs: [] }), get: async () => detail(row('first')) }, () => {}, { initialFilters: { outcome: 'failed' } });
    await source.load('invoice'); expect(source.state().unsupported).toBe(true);
    expect(renderRunSearch(source.state(), 'data-action')).toContain('These run filters are unavailable');
    expect(renderRunSearch(source.state(), 'data-action')).not.toContain('No recorded runs match'); source.dispose();
  });

  it('keeps only readable metadata and shares History outcome and failure wording', () => {
    const source = row('run-a', { run_yield: { steps_run: 2, steps_skipped: 0, items_total: 5, items_failed: 2, stopped_at: 'private-step-name' } });
    Object.assign(source, { raw_payload: 'private-result', origin: { ...source.origin, client_token_id: 'private-token' } });
    const page = readRunSearchPage({ runs: [source] });
    const snapshot = JSON.stringify(page); expect(snapshot).not.toContain('private-');
    const html = renderRunSearch({ query: 'follow-up', matches: page.runs, loaded: true, loading: false, stale: false }, 'data-action');
    expect(html).toContain('Partial result'); expect(html).toContain('2 of 5 items failed. Ended early.');
    expect(renderRunSearch({ query: '', matches: [row('failed', { status: 'in_doubt' })], loaded: true, loading: false, stale: false }, 'data-action')).toContain('Needs checking');
    expect(() => readRunSearchPage({ runs: [row('bad', { status: 'invented' as never })] })).toThrow('could not be confirmed');
  });

  it('retains confirmed pages on a failed older-history read and retries the same cursor without duplicating rows', async () => {
    const boundary = { last_event_at: 80, last_run_id: 'boundary' };
    const search = vi.fn().mockResolvedValueOnce({ runs: [row('first')], next_cursor: boundary })
      .mockRejectedValueOnce(Error('Temporarily unavailable')).mockResolvedValueOnce({ runs: [row('older', { started_at: 10 })] });
    const source = createRunSearch({ search, get: async () => detail(row('first')) }, () => {});
    await source.load('follow'); await source.load('follow', true);
    expect(source.state().matches.map(value => value.run_id)).toEqual(['first']); expect(source.state().retry_append).toBe(true);
    await source.load('follow', true);
    expect(search.mock.calls[1]![0].cursor).toEqual(boundary); expect(search.mock.calls[2]![0].cursor).toEqual(boundary);
    expect(source.state().matches.map(value => value.run_id)).toEqual(['first', 'older']); expect(source.state().next_cursor).toBeUndefined(); source.dispose();
  });

  it('retires late reads and exact selections after edits, restore and disposal; live events only mark activity', async () => {
    let finish!: (value: ExecutionSearchResponse) => void, finishGet!: (value: ExecutionGetResponse) => void, activity!: () => void;
    const off = vi.fn(); const source = createRunSearch({ search: () => new Promise(resolve => { finish = resolve; }),
      get: () => new Promise(resolve => { finishGet = resolve; }), observe: changed => { activity = changed; return off; } }, () => {});
    const pending = source.load('old'); source.reset(); finish({ runs: [row('retired')] }); await pending; expect(source.state().matches).toEqual([]);
    source.restore({ query: 'follow', matches: [row('chosen')], loaded: true, loading: false, stale: false });
    activity(); expect(source.state().stale).toBe(true); expect(source.state().matches[0]!.run_id).toBe('chosen');
    const selection = source.resolve(row('chosen')); source.reset(); finishGet(detail(row('chosen'))); expect(await selection).toBe(false);
    const second = source.load('later'); source.dispose(); finish({ runs: [row('late')] }); await second; expect(source.state().matches).toEqual([]); expect(off).toHaveBeenCalledOnce();
  });

  it('refuses missing or substituted run anchors and keeps sparse searches and unsupported servers honest', async () => {
    const get = vi.fn().mockResolvedValueOnce({ run: null }).mockResolvedValueOnce(detail(row('other')));
    const source = createRunSearch({ search: async () => ({ runs: [], next_cursor: { last_event_at: 80, last_run_id: 'scan' } }), get }, () => {});
    await source.load('old'); const html = renderRunSearch(source.state(), 'data-action');
    expect(html).toContain('Search older runs'); expect(html).not.toContain('No recorded runs match');
    await expect(source.resolve(row('chosen'))).rejects.toThrow('no longer available');
    await expect(source.resolve(row('chosen'))).rejects.toThrow('could not be confirmed'); source.dispose();
    const absent = createRunSearch({ search: async () => { throw { code: 'unknown_method', message: 'Unknown rpc method: execution.search' }; }, get }, () => {});
    await absent.load('old'); expect(absent.state().unsupported).toBe(true); expect(renderRunSearch(absent.state(), 'data-action')).not.toContain('No recorded runs match'); absent.dispose();
  });
});
