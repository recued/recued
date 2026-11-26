import { e } from '@recued/ui-shared';
import { renderSearchHighlights } from './search-excerpt.js';
import { SEARCH_OPEN_SAVED_VIEW, SEARCH_SAVED_VIEW_ID, savedViewSearchHref, type SavedViewSearchState } from './saved-view-search.js';
export { SEARCH_OPEN_SAVED_VIEW, SEARCH_SAVED_VIEW_ID };
export const SEARCH_SAVED_VIEW_GROUP = 'data-search-saved-view-results';
export const SEARCH_SAVED_VIEW_FOCUS = 'data-search-saved-view-focus';
export const SEARCH_REFRESH_SAVED_VIEWS = 'universal-search-refresh-saved-views';
export const renderSavedViewSearch = (state: SavedViewSearchState | undefined, actionAttr: string,
  opening?: string, error?: string, debouncing = false, writing = false, currentViewId?: string): string => {
  if (!state) return '';
  const busy = state.loading || debouncing, disabled = busy || !!opening || writing;
  return `<section class="rq-group" aria-label="Saved view search results" ${SEARCH_SAVED_VIEW_GROUP} aria-busy="${busy}">
    <h3 class="rq-group-head"><span class="rq-group-name">Saved views</span><span class="rq-group-count" role="status">${state.matches.length} loaded</span></h3>
    <p class="rq-subtle">Find named views by name, data type, saved filters or pack. Opening a view loads its saved settings.</p>
    ${busy ? '<p class="rq-hint" role="status">Reading saved views…</p>' : ''}
    ${state.unsupported ? '<p class="rq-hint" role="status">Saved view search is unavailable on this server.</p>' : state.error ? `<p class="rq-error" role="alert">${e(state.error)}</p>` : ''}
    ${state.stale ? '<p class="rq-hint" role="status">Saved views may have changed. Refresh saved views to check them.</p>' : ''}
    ${opening || error ? `<p class="${error ? 'rq-error' : 'rq-hint'}" role="${error ? 'alert' : 'status'}" tabindex="-1" ${SEARCH_SAVED_VIEW_FOCUS}>${e(error ?? 'Checking the selected saved view…')}</p>` : ''}
    <ul class="rq-rows">${state.matches.map(row => {
      const current = row.id === currentViewId, tag = current ? 'div' : 'a';
      return `<li class="rq-row"><${tag} class="rq-row-btn" ${current ? 'aria-current="page"' : `href="${e(savedViewSearchHref(row.id))}" ${actionAttr}="${SEARCH_OPEN_SAVED_VIEW}" ${SEARCH_SAVED_VIEW_ID}="${e(row.id)}" aria-label="${e(`Open saved view: ${row.name}`)}"${disabled ? ' aria-disabled="true"' : ''}`}>
        <span class="rq-row-title">${renderSearchHighlights(row.name, state.query)}${current ? ' · Current view' : ''}</span>
        <span class="rq-row-excerpt">${renderSearchHighlights(row.summary, state.query)}</span>
        <span class="rq-row-when">${e(row.pack ? `From ${row.pack.publisher}/${row.pack.slug}` : 'Your view')}${row.alert ? ' · ' + e(row.alert) : ''}</span></${tag}></li>`;
    }).join('')}</ul>
    ${state.loaded && !busy && !state.error && !state.unsupported && !state.stale && !state.matches.length ? '<p class="rq-subtle">No saved views match this search.</p>' : ''}
    <button type="button" class="rq-retry" ${actionAttr}="${SEARCH_REFRESH_SAVED_VIEWS}"${disabled ? ' disabled' : ''}>Refresh saved views</button>
  </section>`;
};
