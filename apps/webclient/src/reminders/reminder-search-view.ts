import { reminderDetailLink, type ReminderSearchStatus, type ReminderView } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { renderSearchHighlights } from '../data/search-excerpt.js';
import { REMINDER_STATUS_LABELS, type ReminderSearchState } from './reminder-search.js';

export const SEARCH_OPEN_REMINDER_ACTION = 'universal-search-open-reminder';
export const SEARCH_MORE_REMINDERS_ACTION = 'universal-search-more-reminders';
export const SEARCH_REMINDER_ID_ATTR = 'data-search-reminder-id';
export const SEARCH_REMINDER_STATUS_ATTR = 'data-search-reminder-status';

export interface ReminderSearchTriageView {
  html: string;
  writing: boolean;
  selection: (row: ReminderView) => string;
}
export const renderReminderSearch = (state: ReminderSearchState | undefined, actionAttr: string, status?: ReminderSearchStatus, datesHtml = '', triage?: ReminderSearchTriageView, showFilters = true): string => {
  if (!state) return '';
  return `<section class="rq-group" aria-label="Reminder search results" aria-busy="${state.loading}">
    <h3 class="rq-group-head"><span class="rq-group-name">Reminders</span><span class="rq-group-count" role="status">${state.unsupported ? 'Update required'
      : state.loading && !state.matches.length ? 'Searching' : state.error && !state.matches.length ? 'Unavailable' : `${state.matches.length} of ${state.total}`}</span></h3>
    ${showFilters ? `<div class="rq-type-controls"><label for="rq-reminder-state">Reminder status</label><select id="rq-reminder-state" ${SEARCH_REMINDER_STATUS_ATTR}${triage?.writing ? ' disabled' : ''}>
      ${Object.entries(REMINDER_STATUS_LABELS).map(([value, label]) => `<option value="${value}"${value === (status ?? state.input.state) ? ' selected' : ''}>${label}</option>`).join('')}
    </select></div>
    <p class="rq-subtle">Searches waiting reminders and retained 30-day history. Times use each reminder’s stated time zone.</p>${datesHtml}` : '<p class="rq-subtle">' + e(REMINDER_STATUS_LABELS[status ?? state.input.state]) + (state.input.from !== undefined || state.input.before !== undefined ? ' · Dates filtered' : '') + ' · Choose Reminders to change filters.</p>'}
    ${state.unsupported ? '<p class="rq-subtle" role="status">Update your Recued server to search reminders and their history here.</p>' : ''}
    ${triage?.html ?? ''}
    ${state.error ? `<p class="rq-error" role="alert">${e(state.error)}</p>` : ''}
    ${state.loading ? '<p class="rq-hint" role="status">Searching reminders…</p>' : ''}
    ${!state.loading && !state.error && !state.unsupported && state.pages > 0 && !state.matches.length ? '<p class="rq-subtle">No reminders match this search.</p>' : ''}
    <ul class="rq-rows">${state.matches.map(row => `<li class="rq-row">${triage?.selection(row) ?? ''}<a class="rq-row-btn" href="${e(reminderDetailLink(row.reminder_id))}"
      ${e(actionAttr)}="${SEARCH_OPEN_REMINDER_ACTION}" ${SEARCH_REMINDER_ID_ATTR}="${e(row.reminder_id)}">
      <span class="rq-row-title">${renderSearchHighlights(row.text, state.input.query ?? '')}</span>
      <span class="rq-row-when">${REMINDER_STATUS_LABELS[row.state]} · ${e(row.when)} · ${e(row.time_zone ?? 'UTC')}${row.managed_by === 'clock' ? ' · Managed in Yours' : ''}</span>
    </a></li>`).join('')}</ul>
    ${!state.unsupported && (state.next_cursor || state.error) ? `<button type="button" class="rq-more" ${e(actionAttr)}="${SEARCH_MORE_REMINDERS_ACTION}"${triage?.writing ? ' disabled' : ''}${state.loading ? ' aria-disabled="true"' : ''}>${state.error ? 'Retry reminder search' : 'More reminders'}</button>` : ''}
  </section>`;
};
