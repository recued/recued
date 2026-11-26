import { e } from '@recued/ui-shared';
import { renderSearchHighlights } from '../data/search-excerpt.js';
import { settingsFinderHash } from './settings-finder-targets.js';
import { SEARCH_OPEN_SETTING, SEARCH_SETTING_ID, type SettingsSearchResults } from './settings-search.js';
export { SEARCH_OPEN_SETTING, SEARCH_SETTING_ID };
export const SEARCH_SETTING_GROUP = 'data-search-setting-results';
export const renderSettingsSearch = (results: SettingsSearchResults | undefined, query: string, actionAttr: string,
  debouncing = false, writing = false): string => {
  if (!results) return '';
  return `<section class="rq-group" aria-label="Settings search results" ${SEARCH_SETTING_GROUP} aria-busy="${debouncing}">
    <h3 class="rq-group-head"><span class="rq-group-name">Settings</span><span class="rq-group-count" role="status">${results.matches.length} loaded</span></h3>
    <p class="rq-subtle">Find settings by name and open the matching panel.</p>
    <ul class="rq-rows">${results.matches.map(row => `<li class="rq-row"><a class="rq-row-btn" href="${e(settingsFinderHash(row))}" ${actionAttr}="${SEARCH_OPEN_SETTING}" ${SEARCH_SETTING_ID}="${e(row.id)}" aria-label="${e(`Open setting: ${row.title}`)}"${debouncing || writing ? ' aria-disabled="true"' : ''}>
      <span class="rq-row-title">${renderSearchHighlights(row.title, query)}</span>
      <span class="rq-row-excerpt">${renderSearchHighlights(row.description, query)}</span>
      <span class="rq-row-when">${renderSearchHighlights(row.location, query)}</span></a></li>`).join('')}</ul>
    ${!debouncing && !results.matches.length ? '<p class="rq-subtle">No settings match this search.</p>' : ''}
  </section>`;
};
