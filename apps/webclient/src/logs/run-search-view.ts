import { e } from '@recued/ui-shared';
import { renderSearchHighlights } from '../data/search-excerpt.js';
import { CLI_FAILURE_LABELS, ERROR_CATEGORY_LABELS, historyOutcome } from './run-management.js';
import { SEARCH_OPEN_RUN, runSearchHref, type RunSearchState } from './run-search.js';
import { describeRunSearchFilters, renderRunSearchFilters } from './run-search-filters.js';
import { SEARCH_REVIEW_RUNS } from './run-search-review.js';
export const SEARCH_RUN_ID = 'data-search-run-id';
export const SEARCH_RUN_GROUP = 'data-search-run-results';
export const SEARCH_RUN_FOCUS = 'data-search-run-focus';
export { SEARCH_OPEN_RUN };
export const SEARCH_REFRESH_RUNS = 'universal-search-refresh-runs';
export const SEARCH_MORE_RUNS = 'universal-search-more-runs';
export const renderRunSearch = (state: RunSearchState | undefined, actionAttr: string,
  opening?: string, error?: string, debouncing = false, writing = false, showFilters = true): string => {
  if (!state) return '';
  const busy = state.loading || debouncing;
  return `<section class="rq-group" aria-label="Run history search results" ${SEARCH_RUN_GROUP} aria-busy="${busy}">
    <h3 class="rq-group-head"><span class="rq-group-name">Run history</span><span class="rq-group-count" role="status">${state.matches.length}${state.next_cursor ? '+' : ''} loaded</span></h3>
    ${showFilters ? `<p class="rq-subtle">Find recorded runs by recipe name, recipe ID, or run ID.</p>${renderRunSearchFilters(state.filters ?? {}, actionAttr, debouncing || writing)}` : describeRunSearchFilters(state.filters ?? {}) ? `<p class="rq-subtle">${e(describeRunSearchFilters(state.filters ?? {}))} · Choose Runs to change filters.</p>` : ''}
    ${state.matches.length ? `<button type="button" class="rq-retry" ${actionAttr}="${SEARCH_REVIEW_RUNS}"${busy || opening || writing ? ' disabled' : ''}>Review matching runs</button>` : ''}
    ${busy ? '<p class="rq-hint" role="status">Searching run history…</p>' : ''}
    ${state.unsupported ? `<p class="rq-hint" role="status">${Object.keys(state.filters ?? {}).length ? 'These run filters are unavailable on this server. Update your server to use them.' : 'Run history search is unavailable on this server.'}</p>` : state.error ? `<p class="rq-error" role="alert">${e(state.error)}</p>` : ''}
    ${state.stale ? '<p class="rq-hint" role="status">New run activity is available. Refresh run history to check it.</p>' : ''}
    ${opening || error ? `<p class="${error ? 'rq-error' : 'rq-hint'}" role="${error ? 'alert' : 'status'}" tabindex="-1" ${SEARCH_RUN_FOCUS}>${e(error ?? 'Checking the selected run…')}</p>` : ''}
    <ul class="rq-rows">${state.matches.map(row => {
      const outcome = historyOutcome(row), failure = row.error_category ? ERROR_CATEGORY_LABELS[row.error_category]
        : row.cli_failure_reason ? CLI_FAILURE_LABELS[row.cli_failure_reason] : '';
      return `<li class="rq-row"><a class="rq-row-btn" href="${e(runSearchHref(row.run_id))}" ${actionAttr}="${SEARCH_OPEN_RUN}" ${SEARCH_RUN_ID}="${e(row.run_id)}"
        aria-label="Review run: ${e(row.name)} · ${e(row.run_id)}"${busy || opening || writing ? ' aria-disabled="true"' : ''}>
        <span class="rq-row-title">${renderSearchHighlights(row.name, state.query)}</span>
        <span class="rq-row-excerpt">${renderSearchHighlights(row.recipe_id + ' · ' + row.run_id, state.query)}</span>
        <span class="rq-row-when">${e(outcome.label)}${failure ? ' · ' + e(failure) : ''} · <time datetime="${new Date(row.started_at).toISOString()}">${e(new Date(row.started_at).toLocaleString())}</time></span>
        ${outcome.note ? `<span class="rq-row-excerpt">${e(outcome.note)}</span>` : ''}</a></li>`;
    }).join('')}</ul>
    ${!busy && state.loaded && !state.error && !state.unsupported && !state.stale && !state.matches.length && !state.next_cursor ? '<p class="rq-subtle">No recorded runs match this search.</p>' : ''}
    ${state.next_cursor ? `<p class="rq-hint">More run history remains.</p><button type="button" class="rq-retry" ${actionAttr}="${SEARCH_MORE_RUNS}"${busy || opening || writing ? ' disabled' : ''}>${state.error && state.retry_append ? 'Retry older runs' : 'Search older runs'}</button>` : ''}
    <button type="button" class="rq-retry" ${actionAttr}="${SEARCH_REFRESH_RUNS}"${busy || opening || writing ? ' disabled' : ''}>Refresh run history</button>
  </section>`;
};
