import { e } from '@recued/ui-shared';
import { clearSearchNavigationReturn, readSearchNavigationReturn, saveSearchNavigationReturn } from '../shell/search-navigation-return.js';
import { createRunSearch, SEARCH_OPEN_RUN, runSearchHref, type RunSearchState, type RunSearchCallers } from './run-search.js';
import { describeRunSearchFilters } from './run-search-filters.js';

export const SEARCH_REVIEW_RUNS = 'universal-search-review-runs';
export const PREVIOUS_SEARCH_RUN = 'previous-search-run';
export const NEXT_SEARCH_RUN = 'next-search-run';
export const MORE_SEARCH_RUNS = 'more-search-runs';
export const RUN_SEARCH_REVIEW_HOST = 'data-run-search-review';
export interface RunSearchReview {
  readonly search: RunSearchState;
  loadOlder?: () => Promise<void>;
  onChange(listener: () => void): () => void;
  dispose(): void;
  select(runId: string): void;
  changed(): void;
  end(): void;
}
interface RunSearchOrigin { runs?: RunSearchState }

/** One document and server connection own this visit. Sibling reviews replace
 * the same native history entry; Back/Forward retain only its exact target. */
export const readRunSearchReview = (doc: Document, owner: object, hash: string, runId: string | undefined, callers?: RunSearchCallers):
  { searchReturnHash: string; searchReview: RunSearchReview } | undefined => {
  let visit = readSearchNavigationReturn<RunSearchOrigin>(doc, owner);
  if (!visit || visit.focus.action !== SEARCH_OPEN_RUN || visit.destinationHash !== hash || visit.focus.id !== runId
    || !visit.state.runs?.matches.some(row => row.run_id === runId)) return undefined;
  const search = structuredClone(visit.state.runs);
  let disposed = false, source: ReturnType<typeof createRunSearch> | undefined;
  const listeners = new Set<() => void>();
  const active = () => !disposed && readSearchNavigationReturn(doc, owner) === visit;
  const state = (): RunSearchState => ({ ...(source?.state() ?? search),
    stale: (source?.state().stale ?? search.stale) || visit?.state.runs?.stale === true });
  const notify = (): void => { if (active()) for (const listener of listeners) listener(); };
  const update = (id: string, stale = false): void => {
    if (!visit || !active() || !state().matches.some(row => row.run_id === id)) return;
    const snapshot = structuredClone({ ...state(), loading: false });
    visit = { ...visit, destinationHash: runSearchHref(id), focus: { ...visit.focus, id },
      state: { ...visit.state, runs: { ...snapshot, ...(stale ? { stale: true } : {}) } } };
    saveSearchNavigationReturn(doc, owner, visit);
  };
  if (callers) {
    source = createRunSearch(callers, () => { if (source && visit) { update(visit.focus.id); notify(); } });
    source.restore(search);
  }
  const dispose = (): void => { if (disposed) return; disposed = true; source?.dispose(); listeners.clear(); };
  return { searchReturnHash: visit.returnHash, searchReview: { get search() { return state(); },
    ...(source ? { loadOlder: async () => {
      if (!active() || !source || source.state().loading || !source.state().next_cursor) return;
      await source.load(source.state().query, true);
    } } : {}),
    onChange: listener => { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose, select: id => update(id),
    changed: () => { if (visit) { update(visit.focus.id, true); notify(); } },
    end: () => { if (active()) clearSearchNavigationReturn(doc, owner); dispose(); } } };
};

export const renderRunSearchReview = (review: RunSearchReview | undefined, selectedId: string | null, actionAttr: string, busy: boolean): string => {
  if (!review) return '';
  const { search } = review, index = search.matches.findIndex(row => row.run_id === selectedId);
  if (index < 0) return '';
  const filters = describeRunSearchFilters(search.filters ?? {}), scope = search.scope;
  const window = scope?.started_from !== undefined && scope.started_before !== undefined
    ? `<p>Run start window: ${e(new Date(scope.started_from).toLocaleString())} through ${e(new Date(scope.started_before - 1).toLocaleString())}.</p>` : '';
  return `<nav class="logs-search-review" ${RUN_SEARCH_REVIEW_HOST} aria-label="Matching run navigation" aria-busy="${busy || search.loading}">
    <p id="logs-search-review-position" data-run-review-position role="status" tabindex="-1">Run ${index + 1} of ${search.matches.length} loaded</p>
    <p>${search.query ? `Search: “${e(search.query)}”` : 'All run names'}${filters ? ` · ${e(filters)}` : ''}</p>${window}
    <div class="logs-search-review-buttons">
      <button type="button" class="logs-button" ${actionAttr}="${PREVIOUS_SEARCH_RUN}"${busy || index === 0 ? ' disabled' : ''}>Previous matching run</button>
      <button type="button" class="logs-button" ${actionAttr}="${NEXT_SEARCH_RUN}"${busy || index === search.matches.length - 1 ? ' disabled' : ''}>Next matching run</button>
    </div>
    ${search.next_cursor ? `<p>More history remains.</p>${review.loadOlder ? `<button type="button" class="logs-button" ${actionAttr}="${MORE_SEARCH_RUNS}" aria-describedby="logs-search-review-position" aria-disabled="${busy || search.loading}" aria-busy="${search.loading}"${busy ? ' disabled' : ''}>${search.loading ? 'Searching older runs…' : search.error && search.retry_append ? 'Retry older runs' : 'Search older runs'}</button>` : '<p>Back to search to load older matches.</p>'}` : ''}
    ${search.loading ? '<p role="status">Searching older run history…</p>'
      : search.unsupported ? '<p role="alert">Older run search is unavailable on this server. Your loaded matches are still available.</p>'
      : search.error ? `<p role="alert">${e(search.error)} Your loaded matches are still available.</p>`
      : search.last_page_empty ? `<p role="status">${search.next_cursor ? 'No additional matches in this part of history. More history remains.' : 'No more matching runs in the remaining history.'}</p>` : ''}
    ${search.stale ? '<p>Run activity has changed. Each selected run is checked again.</p>' : ''}
  </nav>`;
};
