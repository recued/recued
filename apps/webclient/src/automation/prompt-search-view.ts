import { selectSearchPassage } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { renderSearchHighlights } from '../data/search-excerpt.js';
import { promptScheduleChip, promptScheduleHref, type PromptSearchState } from './prompt-search.js';
import { promptSearchTimingText } from './prompt-search-timing.js';
export const SEARCH_OPEN_PROMPT = 'universal-search-open-prompt';
export const SEARCH_REFRESH_PROMPTS = 'universal-search-refresh-prompts';
export const SEARCH_PROMPT_ID = 'data-search-prompt-id';
export const SEARCH_PROMPT_REVISION = 'data-search-prompt-revision';
export const SEARCH_PROMPT_GROUP = 'data-search-prompt-results';
export const SEARCH_PROMPT_BULK_SLOT = 'data-search-prompt-bulk-slot';
export const SEARCH_PROMPT_SELECT_SLOT = 'data-search-prompt-select-slot';
export const renderPromptSearch = (state: PromptSearchState | undefined, actionAttr: string, opening?: string, error?: string, debouncing = false, writing = false): string => {
  if (!state) return '';
  const pending = state.loading || debouncing;
  return `<section class="rq-group" role="region" aria-label="Scheduled prompt search results" ${SEARCH_PROMPT_GROUP} aria-busy="${pending || writing}">
    <h3 class="rq-group-head"><span class="rq-group-name">Scheduled prompts</span>${state.loaded ? '<span class="rq-group-count" role="status">' + state.matches.length + '</span>' : ''}</h3>
    ${pending ? '<p class="rq-hint" role="status">Finding saved scheduled prompts…</p>' : ''}
    ${state.unsupported ? '<p class="rq-hint" role="status">Saved scheduled prompt search is unavailable on this server.</p>' : state.error ? `<p class="rq-error" role="alert">${e(state.error)}</p>` : ''}
    ${error ? `<p class="rq-error" role="alert" tabindex="-1" data-prompt-search-error>${e(error)}</p>` : ''}
    <div ${SEARCH_PROMPT_BULK_SLOT}></div>
    ${state.matches.map(row => {
      const passage = selectSearchPassage(row.prompt, state.query, 220);
      const snippet = (passage.start ? '…' : '') + passage.text.slice(passage.start, passage.end) + (passage.end < passage.text.length ? '…' : '');
      const chip = promptScheduleChip(row), base = row.enabled ? 'Active' : row.mode === 'one_shot' && row.last_run_at !== null ? 'No future runs' : 'Paused';
      const timingId = 'prompt-search-timing-' + encodeURIComponent(row.schedule_id);
      const status = base + (chip === 'needs-you' ? ' · Needs you' : chip === 'failing' ? row.scheduling_issue ? ' · Scheduling delayed' : ' · Last run needs attention' : '');
      const next = row.enabled && row.next_run_at !== null ? ` · Next run <time datetime="${new Date(row.next_run_at).toISOString()}">${e(new Date(row.next_run_at).toLocaleString(undefined, {
        timeZone: row.time_zone, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset',
      }))}</time>` : '';
      return `<article class="rq-row"><div ${SEARCH_PROMPT_SELECT_SLOT}="${e(row.schedule_id)}"></div><a class="rq-row-btn" href="${e(promptScheduleHref(row.schedule_id))}" ${e(actionAttr)}="${SEARCH_OPEN_PROMPT}"
        ${SEARCH_PROMPT_ID}="${e(row.schedule_id)}" ${SEARCH_PROMPT_REVISION}="${row.revision}" aria-label="Open scheduled prompt ${e(row.title)}" aria-describedby="${e(timingId)}"${opening || pending || writing ? ' aria-disabled="true"' : ''}>
        <span class="rq-row-title">${renderSearchHighlights(row.title, state.query)}</span><span class="rq-row-excerpt">${renderSearchHighlights(snippet, state.query)}</span>
        <span class="rq-row-when rq-row-cadence" id="${e(timingId)}">${renderSearchHighlights(promptSearchTimingText(row, state.query), state.query)}</span>
        <span class="rq-row-when">${e(status)}${next}</span></a></article>`;
    }).join('')}
    ${state.loaded && !state.matches.length && !state.error && !pending ? '<p class="rq-hint">No saved scheduled prompts match this search.</p>' : ''}
    <button type="button" class="rq-retry" ${e(actionAttr)}="${SEARCH_REFRESH_PROMPTS}"${pending || writing ? ' disabled' : ''}>Refresh scheduled prompts</button>
  </section>`;
};
