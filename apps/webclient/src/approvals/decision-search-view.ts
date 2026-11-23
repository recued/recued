import { e } from '@recued/ui-shared';
import { renderSearchHighlights } from '../data/search-excerpt.js';
import { decisionSearchHref } from './decision-search-record.js';
import type { PendingDecisionSearchState } from './pending-decision-search.js';
export const SEARCH_OPEN_DECISION = 'universal-search-open-decision';
export const SEARCH_REFRESH_DECISIONS = 'universal-search-refresh-decisions';
export const SEARCH_DECISION_KEY = 'data-search-decision-key';
export const SEARCH_DECISION_FOCUS = 'data-search-decision-focus';
export const DECISION_LABELS = { gate: 'Approval', ask: 'Question', plan: 'Chat plan' } as const;
export const renderDecisionSearch = (state: PendingDecisionSearchState | undefined, actionAttr: string,
  opening?: string, error?: string, debouncing = false, writing = false): string => {
  if (!state) return '';
  const busy = state.loading || debouncing;
  return `<section class="rq-group" aria-label="Pending decision search results" aria-busy="${busy}">
    <h3 class="rq-group-head"><span class="rq-group-name">Pending decisions</span><span class="rq-group-count" role="status">${state.matches.length}${state.incomplete || busy ? ' loaded' : ''}</span></h3>
    <p class="rq-subtle">Approvals, unanswered questions, and proposed Chat plans waiting for you. Open a decision to review it.</p>
    ${busy ? '<p class="rq-hint" role="status">Checking pending decisions…</p>' : ''}
    ${Object.entries(state.sources).filter(([, source]) => source.error).map(([kind, source]) => `<p class="rq-error" role="alert">${DECISION_LABELS[kind as keyof typeof DECISION_LABELS]}: ${e(source.error!)}</p>`).join('')}
    ${opening || error ? `<p class="${error ? 'rq-error' : 'rq-hint'}" role="${error ? 'alert' : 'status'}" tabindex="-1" ${SEARCH_DECISION_FOCUS} data-decision-search-error>${e(error ?? 'Checking the selected decision…')}</p>` : ''}
    <ul class="rq-rows">${state.matches.map(row => `<li class="rq-row"><a class="rq-row-btn" href="${e(decisionSearchHref(row.id))}"
      ${actionAttr}="${SEARCH_OPEN_DECISION}" ${SEARCH_DECISION_KEY}="${e(row.key)}" aria-label="Open ${DECISION_LABELS[row.kind].toLowerCase()}: ${e(row.title)}"${busy || writing || opening ? ' aria-disabled="true"' : ''}>
      <span class="rq-row-title">${renderSearchHighlights(row.title, state.query)}</span><span class="rq-row-when">${DECISION_LABELS[row.kind]}</span>
      <span class="rq-row-excerpt">${renderSearchHighlights(row.review.slice(0, 500), state.query)}</span></a></li>`).join('')}</ul>
    ${!busy && !state.incomplete && state.loaded && !state.matches.length ? '<p class="rq-subtle">No pending decisions match this search.</p>' : ''}
    <button type="button" class="rq-retry" ${actionAttr}="${SEARCH_REFRESH_DECISIONS}"${busy || writing ? ' disabled' : ''}>Refresh pending decisions</button>
  </section>`;
};
