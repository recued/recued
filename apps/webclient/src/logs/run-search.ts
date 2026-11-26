import { ACTORS, CLI_FAILURE_REASONS, HEAVY_OP_ERROR_CATEGORIES, RUN_ANCHOR_STATUSES, RpcError,
  parseRunSearchFilters, parseRunSearchScope, sameRunSearchScope, resolveRunSearchScope, runMatchesSearchScope,
  type RunSearchFilters, type RunSearchScope,
  type RunAuditSummary,
  type ExecutionGetRequest, type ExecutionGetResponse, type ExecutionSearchCursor, type ExecutionSearchRequest,
  type ExecutionSearchResponse, type RunFeedRow } from '@recued/contracts';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { validRunYield } from './run-management.js';
import { runReviewHref } from './run-review.js';

export const SEARCH_OPEN_RUN = 'universal-search-open-run';
export const runSearchHref = (id: string): string => {
  const href = runReviewHref(id); if (!href) throw Error('This run address could not be confirmed.'); return href;
};
export interface RunSearchCallers {
  search: (args: ExecutionSearchRequest) => Promise<ExecutionSearchResponse>;
  get: (args: ExecutionGetRequest) => Promise<ExecutionGetResponse>;
  observe?: (changed: () => void) => () => void;
}
export interface RunSearchState {
  query: string; matches: readonly RunFeedRow[]; next_cursor?: ExecutionSearchCursor;
  filters?: RunSearchFilters; scope?: RunSearchScope;
  last_page_empty?: boolean;
  loaded: boolean; loading: boolean; stale: boolean; error?: string; unsupported?: boolean; retry_append?: boolean;
}
/** A frozen search row identifies one run lifetime. Re-read filters against
 * the current audit summary before showing it, without repeating execution. */
export const checkRunSearchSelection = (selected: RunFeedRow, current: RunAuditSummary | undefined, scope: RunSearchScope = {}): void => {
  if (!current || current.run_id !== selected.run_id || current.recipe_id !== selected.recipe_id || current.started_at !== selected.started_at
    || !RUN_ANCHOR_STATUSES.includes(current.status))
    throw Error('This run could not be confirmed. Refresh run history before opening it.');
  // Detail keeps legacy tallies verbatim. The shared outcome classifier treats
  // unusable counts as unknown item results without hiding an identifiable run.
  if (!runMatchesSearchScope(current, scope))
    throw Error('This run no longer matches the selected filters. Return to search to check the current matches.');
};
const empty = (filters: RunSearchFilters = {}): RunSearchState => ({ query: '', filters, matches: [], loaded: false, loading: false, stale: false });
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2000;
const at = (value: unknown): value is number => Number.isFinite(value) && Math.abs(Number(value)) <= 8.64e15;
const cursor = (value: ExecutionSearchCursor): boolean => !!value && at(value.last_event_at) && id(value.last_run_id);

/** Retain the readable run projection only. Payloads, error details, token
 * identities and arbitrary legacy properties never enter Search snapshots. */
export const readRunSearchPage = (input: ExecutionSearchResponse, before?: ExecutionSearchCursor, scope: RunSearchScope = {}): ExecutionSearchResponse => {
  const invalid = (): never => { throw Error('The run history search page could not be confirmed. Refresh and try again.'); };
  if (Object.keys(scope).length && input?.applied_filters === undefined)
    throw new RpcError('not_configured', 'Update your Recued server to filter run history.');
  const acknowledged = input?.applied_filters === undefined ? {} : parseRunSearchScope(input.applied_filters);
  if (!acknowledged || !sameRunSearchScope(scope, acknowledged)) return invalid();
  if (!input || !Array.isArray(input.runs) || input.runs.length > 50) return invalid();
  const seen = new Set<string>();
  const runs = input.runs.map(row => {
    if (!row || !id(row.run_id) || !runReviewHref(row.run_id) || !id(row.recipe_id) || !id(row.name) || seen.has(row.run_id)
      || !at(row.started_at) || !at(row.finished_at) || !Number.isFinite(row.duration_ms) || row.duration_ms < 0
      || !RUN_ANCHOR_STATUSES.includes(row.status) || !row.origin || !ACTORS.includes(row.origin.actor)
      || ![...ACTORS, 'self-restricted'].includes(row.origin.label)
      || !['allowed', 'approval-requested', 'denied', 'released-after-approval', 'blocked'].includes(row.policy_result)
      || row.error_category !== undefined && !HEAVY_OP_ERROR_CATEGORIES.includes(row.error_category)
      || row.cli_failure_reason !== undefined && !CLI_FAILURE_REASONS.includes(row.cli_failure_reason)
      || row.run_yield !== undefined && !validRunYield(row.run_yield)
      || !runMatchesSearchScope(row, scope)) return invalid();
    seen.add(row.run_id);
    return { run_id: row.run_id, recipe_id: row.recipe_id, name: row.name, started_at: row.started_at,
      finished_at: row.finished_at, duration_ms: row.duration_ms, status: row.status, policy_result: row.policy_result,
      origin: { actor: row.origin.actor, label: row.origin.label }, links: [],
      ...(row.error_category ? { error_category: row.error_category } : {}),
      ...(row.cli_failure_reason ? { cli_failure_reason: row.cli_failure_reason } : {}),
      ...(row.run_yield ? { run_yield: { steps_run: row.run_yield.steps_run, steps_skipped: row.run_yield.steps_skipped,
        items_total: row.run_yield.items_total, items_failed: row.run_yield.items_failed,
        ...(row.run_yield.stopped_at === null ? { stopped_at: null } : row.run_yield.stopped_at ? { stopped_at: 'recorded' } : {}) } } : {}),
    } satisfies RunFeedRow;
  });
  if (input.next_cursor !== undefined && (!cursor(input.next_cursor)
    || before && (input.next_cursor.last_event_at > before.last_event_at
      || input.next_cursor.last_event_at === before.last_event_at && input.next_cursor.last_run_id >= before.last_run_id))) return invalid();
  return { runs, ...(input.next_cursor ? { next_cursor: { last_event_at: input.next_cursor.last_event_at, last_run_id: input.next_cursor.last_run_id } } : {}) };
};

export const createRunSearch = (callers: RunSearchCallers | undefined, changed: () => void,
  options: { initialFilters?: RunSearchFilters; now?: () => number } = {}) => {
  let state = empty(options.initialFilters), generation = 0, activity = 0, disposed = false, pending = Promise.resolve();
  const reset = () => { generation++; state = empty(state.filters); };
  const read = async (query: string, append: boolean, refresh: boolean): Promise<void> => {
    if (!callers || disposed || append && (state.loading || !state.next_cursor || state.query !== query)) return;
    const mine = ++generation, version = activity, previous = state, keep = previous.query === query;
    const before = append ? previous.next_cursor : undefined;
    const filters = previous.filters ?? {};
    state = { ...(keep ? previous : empty(filters)), query, loading: true, error: undefined, unsupported: false, retry_append: undefined }; changed();
    try {
      const scope = !refresh && keep && previous.scope ? previous.scope : resolveRunSearchScope(filters, (options.now ?? Date.now)());
      state = { ...state, scope };
      const page = readRunSearchPage(await callers.search({ query, limit: 20, ...(before ? { cursor: before } : {}),
        ...(Object.keys(scope).length ? { filters: scope } : {}) }), before, scope);
      if (disposed || mine !== generation) return;
      const rows = append ? [...previous.matches] : [], seen = new Set(rows.map(row => row.run_id));
      for (const row of page.runs) {
        if (seen.has(row.run_id)) throw Error('Run history changed while loading. Refresh the search and try again.');
        rows.push(row); seen.add(row.run_id);
      }
      state = { query, filters, scope, matches: rows, ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
        last_page_empty: page.runs.length === 0, loaded: true, loading: false, stale: version !== activity };
    } catch (error) {
      if (disposed || mine !== generation) return;
      const code = classifyRpcError(error).code;
      state = { ...(keep ? previous : empty(filters)), scope: keep && previous.loaded ? previous.scope : state.scope, query, loading: false, error: humanizeRpcError(error),
        unsupported: code === 'unknown_method' || code === 'not_configured', retry_append: append };
    }
    if (!disposed && mine === generation) changed();
  };
  const load = (query: string, append = false, refresh = false): Promise<void> => {
    if (disposed || !callers || !append && !refresh && state.query === query && (state.loaded || state.loading)) return pending;
    pending = read(query, append, refresh); return pending;
  };
  const unsubscribe = callers?.observe?.(() => {
    activity++;
    if (!disposed && (state.loaded || state.loading)) { state = { ...state, stale: true }; changed(); }
  });
  return {
    state: () => state, load, reset, whenLoaded: () => pending,
    setFilters(value: unknown): boolean {
      if (disposed) return false;
      const filters = parseRunSearchFilters(value);
      if (!filters || JSON.stringify(filters) === JSON.stringify(state.filters ?? {})) return false;
      generation++; state = empty(filters); return true;
    },
    async resolve(selected: RunFeedRow): Promise<boolean> {
      if (!callers || disposed) return false;
      const mine = generation;
      let out: ExecutionGetResponse;
      try { out = await callers.get({ run_id: selected.run_id }); }
      catch (failure) {
        if (disposed || mine !== generation) return false;
        if (classifyRpcError(failure).code === 'not_found') throw Error('This run is no longer available. Refresh run history to check it again.');
        throw failure;
      }
      if (disposed || mine !== generation) return false;
      if (!out?.run) throw Error('This run is no longer available. Refresh run history to check it again.');
      checkRunSearchSelection(selected, out.run.audit, state.scope);
      return true;
    },
    snapshot: () => structuredClone({ ...state, loading: false }),
    restore(value: RunSearchState) { generation++; state = structuredClone({ ...value, loading: false }); },
    dispose() { disposed = true; generation++; unsubscribe?.(); },
  };
};
