import { describe, expect, it, vi } from 'vitest';
import type { ExecutionSearchResponse, RunAuditSummary, RunFeedRow } from '@recued/contracts';
import { checkRunSearchSelection, SEARCH_OPEN_RUN, type RunSearchState } from '../logs/run-search.js';
import { readRunSearchReview } from '../logs/run-search-review.js';
import { readSearchNavigationReturn, saveSearchNavigationReturn, trackSearchNavigationRoute } from '../shell/search-navigation-return.js';

const row = (id: string): RunFeedRow => ({ run_id: id, recipe_id: 'invoice', name: 'Invoice follow-up',
  started_at: 100, finished_at: 120, duration_ms: 20, status: 'failed',
  origin: { actor: 'user_self', label: 'user_self' }, policy_result: 'allowed', links: [] });
const origin = () => {
  const search: RunSearchState = { query: 'invoice', filters: { outcome: 'failed', time_range: '7d' },
    scope: { outcome: 'failed', started_from: 50, started_before: 150 }, matches: [row('one'), row('two')],
    next_cursor: { last_event_at: 80, last_run_id: 'older' }, loaded: true, loading: false, stale: false };
  return { destinationHash: '#logs/one', returnHash: '#views/invoice-errors',
    state: { runs: search, universalSearchQuery: 'invoice', unrelatedGroup: { matches: ['retained'] } },
    focus: { action: SEARCH_OPEN_RUN, attribute: 'data-search-run-id', id: 'one' }, scrollTop: 450 };
};

describe('matching run review visits', () => {
  it('appends safe older matches with the original cursor and scope, preserving the selected run and every other search group', async () => {
    const doc = {} as Document, owner = {}, value = origin(); saveSearchNavigationReturn(doc, owner, value);
    const older = Object.assign(row('three'), { started_at: 60, payload: 'private-payload',
      origin: { actor: 'user_self', label: 'user_self', client_token_id: 'private-token' } });
    const search = vi.fn().mockResolvedValue({ runs: [older], applied_filters: value.state.runs.scope });
    const review = readRunSearchReview(doc, owner, '#logs/one', 'one', { search, get: vi.fn() })!.searchReview;
    await review.loadOlder!();
    expect(search).toHaveBeenCalledWith({ query: 'invoice', limit: 20, cursor: value.state.runs.next_cursor, filters: value.state.runs.scope });
    const saved = readSearchNavigationReturn<typeof value.state>(doc, owner)!;
    expect(saved.focus.id).toBe('one'); expect(saved.destinationHash).toBe('#logs/one');
    expect(saved.state.unrelatedGroup).toEqual(value.state.unrelatedGroup);
    expect(saved.state.runs.matches.map(run => run.run_id)).toEqual(['one', 'two', 'three']);
    expect(saved.state.runs.scope).toEqual(value.state.runs.scope);
    expect(JSON.stringify(saved.state)).not.toContain('private-');
    review.select('three'); expect(readSearchNavigationReturn(doc, owner)!.focus.id).toBe('three');
    expect(review.search.next_cursor).toBeUndefined(); review.dispose();
  });
  it('keeps confirmed pages and the cursor through failed reads, sparse pages and malformed continuations', async () => {
    const doc = {} as Document, owner = {}, value = origin(), scope = value.state.runs.scope!;
    saveSearchNavigationReturn(doc, owner, value);
    const sparse = { last_event_at: 70, last_run_id: 'sparse' };
    const search = vi.fn().mockRejectedValueOnce(Error('Unavailable'))
      .mockResolvedValueOnce({ runs: [], next_cursor: sparse, applied_filters: scope })
      .mockResolvedValueOnce({ runs: [], next_cursor: { ...sparse, last_run_id: 'z-newer' }, applied_filters: scope })
      .mockResolvedValueOnce({ runs: [row('one')], applied_filters: scope })
      .mockResolvedValueOnce({ runs: [row('three')], applied_filters: { ...scope, outcome: 'partial' } })
      .mockResolvedValueOnce({ runs: [], applied_filters: scope });
    const review = readRunSearchReview(doc, owner, '#logs/one', 'one', { search, get: vi.fn() })!.searchReview;
    await review.loadOlder!(); expect(review.search.error).toContain('Unavailable'); expect(review.search.retry_append).toBe(true);
    expect(review.search.next_cursor).toEqual(value.state.runs.next_cursor);
    await review.loadOlder!(); expect(review.search.last_page_empty).toBe(true); expect(review.search.next_cursor).toEqual(sparse);
    expect(search.mock.calls[0]![0]).toEqual(search.mock.calls[1]![0]);
    for (let attempt = 0; attempt < 3; attempt++) {
      await review.loadOlder!(); expect(review.search.error).toBeDefined();
      expect(review.search.matches.map(run => run.run_id)).toEqual(['one', 'two']); expect(review.search.next_cursor).toEqual(sparse);
    }
    await review.loadOlder!(); expect(review.search.error).toBeUndefined(); expect(review.search.next_cursor).toBeUndefined();
    expect(review.search.matches).toHaveLength(2); expect(review.search.last_page_empty).toBe(true); review.dispose();
  });
  it('makes one append read at a time and retires its reply when leaving or a newer visit takes ownership', async () => {
    const doc = {} as Document, owner = {}, value = origin(); saveSearchNavigationReturn(doc, owner, value);
    let finish!: (value: ExecutionSearchResponse) => void;
    const search = vi.fn(() => new Promise<ExecutionSearchResponse>(resolve => { finish = resolve; }));
    let activity!: () => void; const off = vi.fn();
    const review = readRunSearchReview(doc, owner, '#logs/one', 'one', { search, get: vi.fn(), observe: changed => { activity = changed; return off; } })!.searchReview;
    const changed = vi.fn(); review.onChange(changed);
    const pending = review.loadOlder!(); await review.loadOlder!(); expect(search).toHaveBeenCalledOnce();
    expect(readSearchNavigationReturn<typeof value.state>(doc, owner)!.state.runs.loading).toBe(false);
    review.select('two'); review.dispose(); review.dispose(); expect(off).toHaveBeenCalledOnce();
    const newer = { ...origin(), state: { ...value.state, universalSearchQuery: 'new query' } }; saveSearchNavigationReturn(doc, owner, newer);
    const notifications = changed.mock.calls.length;
    finish({ runs: [row('late')], applied_filters: value.state.runs.scope }); await pending;
    activity();
    expect(readSearchNavigationReturn(doc, owner)).toBe(newer); expect(changed).toHaveBeenCalledTimes(notifications);
    expect(review.search.matches.map(run => run.run_id)).toEqual(['one', 'two']);
    await review.loadOlder!(); expect(search).toHaveBeenCalledOnce();
  });

  it('retains the complete search snapshot while moving the exact Back/Forward target within the loaded matches', () => {
    const doc = {} as Document, owner = {}, value = origin(); saveSearchNavigationReturn(doc, owner, value);
    const review = readRunSearchReview(doc, owner, '#logs/one', 'one')!;
    expect(review.searchReturnHash).toBe(value.returnHash);
    review.searchReview.select('two');
    const saved = readSearchNavigationReturn(doc, owner)!;
    expect(saved.destinationHash).toBe('#logs/two'); expect(saved.focus).toEqual({ ...value.focus, id: 'two' });
    expect(saved.state).toEqual(value.state); expect(saved.scrollTop).toBe(450);
    expect(review.searchReview.search).toEqual(value.state.runs);
    review.searchReview.select('unloaded'); expect(readSearchNavigationReturn(doc, owner)).toBe(saved);
    expect(readRunSearchReview(doc, owner, '#logs/one', 'one')).toBeUndefined();
    for (const hash of [value.returnHash, '#logs/two']) {
      trackSearchNavigationRoute(doc, owner, hash); expect(readRunSearchReview(doc, owner, '#logs/two', 'two')).toBeDefined();
    }
    review.searchReview.changed();
    expect(readSearchNavigationReturn<typeof value.state>(doc, owner)!.state.runs.stale).toBe(true);
    expect(value.state.runs.stale).toBe(false);
  });
  it('isolates documents and connections, retires other routes, and never lets a late review update or clear a newer visit', () => {
    const doc = {} as Document, otherDoc = {} as Document, owner = {}, value = origin();
    saveSearchNavigationReturn(doc, owner, value);
    expect(readRunSearchReview(doc, {}, '#logs/one', 'one')).toBeUndefined();
    expect(readRunSearchReview(otherDoc, owner, '#logs/one', 'one')).toBeUndefined();
    expect(readRunSearchReview(doc, owner, '#logs/one', 'two')).toBeUndefined();
    const review = readRunSearchReview(doc, owner, '#logs/one', 'one')!.searchReview;
    trackSearchNavigationRoute(doc, owner, '#today'); review.select('two'); review.changed();
    expect(readSearchNavigationReturn(doc, owner)).toBeUndefined();
    const newer = { ...origin(), returnHash: '#data/search' }; saveSearchNavigationReturn(doc, owner, newer);
    review.select('two'); review.end(); expect(readSearchNavigationReturn(doc, owner)).toBe(newer);
    readRunSearchReview(doc, owner, '#logs/one', 'one')!.searchReview.end();
    expect(readSearchNavigationReturn(doc, owner)).toBeUndefined();
  });
  it('rechecks the exact run lifetime and current outcome against the original fixed window', () => {
    const selected = row('one'), scope = origin().state.runs.scope!;
    const current: RunAuditSummary = { ...selected, recipe_hash: 'fixture', trigger_source: 'manual', instance_id: 'fixture-server', errors: [] };
    expect(() => checkRunSearchSelection(selected, current, scope)).not.toThrow();
    expect(() => checkRunSearchSelection(selected, { ...current, status: 'succeeded' }, scope)).toThrow('no longer matches');
    for (const patch of [{ run_id: 'other' }, { recipe_id: 'other' }, { started_at: 99 }])
      expect(() => checkRunSearchSelection(selected, { ...current, ...patch }, scope)).toThrow('could not be confirmed');
    expect(() => checkRunSearchSelection(selected, undefined, scope)).toThrow('could not be confirmed');
    const partial = { ...current, status: 'succeeded' as const,
      run_yield: { steps_run: 1, steps_skipped: 0, items_total: 5, items_failed: 2, stopped_at: null } };
    expect(() => checkRunSearchSelection(selected, partial, { ...scope, outcome: 'partial' })).not.toThrow();
    expect(() => checkRunSearchSelection(selected, { ...partial, status: 'in_doubt' }, { ...scope, outcome: 'partial' })).toThrow('no longer matches');
    const legacy = { ...current, run_yield: { ...partial.run_yield, items_failed: 99 } };
    expect(() => checkRunSearchSelection(selected, legacy, scope)).not.toThrow();
    expect(() => checkRunSearchSelection(selected, { ...legacy, status: 'succeeded' })).not.toThrow();
    expect(() => checkRunSearchSelection(selected, { ...legacy, status: 'succeeded' }, { ...scope, outcome: 'partial' })).toThrow('no longer matches');
  });
});
