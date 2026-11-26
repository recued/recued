import { e } from '@recued/ui-shared';
import { renderSearchHighlights } from '../data/search-excerpt.js';
import { CONNECTION_SEARCH_LABELS, SEARCH_OPEN_CONNECTION, type ConnectionSearchState } from './connection-search.js';
export { SEARCH_OPEN_CONNECTION };
export const SEARCH_CONNECTION_KEY = 'data-search-connection-key';
export const SEARCH_CONNECTION_GROUP = 'data-search-connection-results';
export const SEARCH_CONNECTION_FOCUS = 'data-search-connection-focus';
export const SEARCH_REFRESH_CONNECTIONS = 'universal-search-refresh-connections';
export const renderConnectionSearch = (state: ConnectionSearchState | undefined, actionAttr: string,
  opening?: string, error?: string, debouncing = false, writing = false): string => {
  if (!state) return '';
  const busy = state.loading || debouncing, disabled = busy || !!opening || writing;
  return `<section class="rq-group" aria-label="Connection search results" ${SEARCH_CONNECTION_GROUP} aria-busy="${busy}">
    <h3 class="rq-group-head"><span class="rq-group-name">Connections</span><span class="rq-group-count" role="status">${state.matches.length} loaded</span></h3>
    <p class="rq-subtle">Find saved accounts, file sources and API connections. Status reflects saved metadata.</p>
    ${busy ? '<p class="rq-hint" role="status">Reading saved connections…</p>' : ''}
    ${state.sources.filter(source => source.error || source.unavailable).map(source => `<p class="rq-error" role="status">${e(CONNECTION_SEARCH_LABELS[source.kind])}: ${source.unavailable ? 'unavailable on this server.' : 'could not be read. Refresh connections to try again.'}</p>`).join('')}
    ${state.stale ? '<p class="rq-hint" role="status">Connection activity is available. Refresh connections to check it.</p>' : ''}
    ${opening || error ? `<p class="${error ? 'rq-error' : 'rq-hint'}" role="${error ? 'alert' : 'status'}" tabindex="-1" ${SEARCH_CONNECTION_FOCUS}>${e(error ?? 'Checking the selected connection…')}</p>` : ''}
    <ul class="rq-rows">${state.matches.map(row => `<li class="rq-row"><a class="rq-row-btn" href="${e(row.href)}" ${actionAttr}="${SEARCH_OPEN_CONNECTION}" ${SEARCH_CONNECTION_KEY}="${e(row.key)}" aria-label="${e(`Open connection: ${row.name} · ${CONNECTION_SEARCH_LABELS[row.kind]}`)}"${debouncing || opening || writing || state.sources.find(source => source.kind === row.kind)?.loading ? ' aria-disabled="true"' : ''}>
      <span class="rq-row-title">${renderSearchHighlights(row.name, state.query)}</span>
      <span class="rq-row-excerpt">${renderSearchHighlights([CONNECTION_SEARCH_LABELS[row.kind], row.providerLabel, row.id !== row.name ? row.id : '', row.email].filter(Boolean).join(' · '), state.query)}</span>
      <span class="rq-row-when">${e(row.status)}${row.lastSyncedAt === null ? ' · Never synced' : row.lastSyncedAt === undefined ? '' : ` · Last synced <time datetime="${new Date(row.lastSyncedAt).toISOString()}">${e(new Date(row.lastSyncedAt).toLocaleString())}</time>`}</span></a></li>`).join('')}</ul>
    ${state.loaded && !busy && !state.stale && !state.matches.length && !state.sources.some(source => source.error || source.unavailable) ? '<p class="rq-subtle">No saved connections match this search.</p>' : ''}
    <button type="button" class="rq-retry" ${actionAttr}="${SEARCH_REFRESH_CONNECTIONS}"${disabled ? ' disabled' : ''}>Refresh connections</button>
  </section>`;
};
