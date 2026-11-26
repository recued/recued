import { MAIL_FOLLOW_UP_STATES, MAIL_FOLLOW_UP_LABELS, mailFollowUpHref, mailFollowUpLabel, type MailFollowUp } from '@recued/contracts';
import { e } from '@recued/ui-shared';
import { renderSearchHighlights } from '../data/search-excerpt.js';
import { followUpResultHref, type MailFollowUpSearchState } from './mail-follow-up-search.js';

export const SEARCH_OPEN_FOLLOW_UP = 'universal-search-open-follow-up';
export const SEARCH_MANAGE_FOLLOW_UP = 'universal-search-manage-follow-up';
export const SEARCH_MORE_FOLLOW_UPS = 'universal-search-more-follow-ups';
export const SEARCH_REFRESH_FOLLOW_UPS = 'universal-search-refresh-follow-ups';
export const SEARCH_FOLLOW_UP_ID = 'data-search-follow-up-id';
export const SEARCH_FOLLOW_UP_FILTER = 'data-search-follow-up-filter';
export const followUpActionLabel = (watch: MailFollowUp): string => watch.state === 'draft_ready' && watch.draft_id ? 'Open draft'
  : watch.state === 'delivery_failed' && watch.delivery_failure ? 'Open delivery report' : watch.state === 'replied' && watch.reply_ref ? 'Open reply' : 'Manage watch';
export const renderFollowUpSearch = (state: MailFollowUpSearchState | undefined, actionAttr: string, filters = false, debouncing = false, writing = false): string => {
  if (!state) return '';
  const pending = state.loading || debouncing, blocked = pending || writing ? ' aria-disabled="true"' : '';
  return `<section class="rq-group" role="region" aria-label="Reply watch search results" aria-busy="${pending}">
    <h3 class="rq-group-head"><span class="rq-group-name">Reply watches</span><span class="rq-group-count">${state.matches.length}${state.next_cursor ? '+' : ''}</span></h3>
    ${filters ? `<label>Status <select ${SEARCH_FOLLOW_UP_FILTER}="state" aria-label="Reply watch status"${writing ? ' disabled' : ''}>
      <option value="all">All statuses</option>${MAIL_FOLLOW_UP_STATES.map(value => `<option value="${value}"${state.filters.state === value ? ' selected' : ''}>${e(MAIL_FOLLOW_UP_LABELS[value])}</option>`).join('')}</select></label>
      <p class="rq-subtle">Search by subject, mailbox, or status. Watch history is included.</p>` : ''}
    ${!filters && (state.filters.state || state.filters.mailbox) ? `<p class="rq-subtle">${e([state.filters.state ? MAIL_FOLLOW_UP_LABELS[state.filters.state] : '', state.filters.mailbox ?? ''].filter(Boolean).join(' · '))}</p>` : ''}
    ${pending ? '<p class="rq-hint" role="status">Finding reply watches…</p>' : ''}
    ${state.unsupported ? '<p class="rq-hint" role="status">Reply watch search is unavailable on this server.</p>' : state.error ? `<p class="rq-error" role="alert">${e(state.error)}</p>` : ''}
    ${state.matches.map(watch => `<article class="rq-row"><a class="rq-row-btn" href="${e(followUpResultHref(watch))}" ${actionAttr}="${SEARCH_OPEN_FOLLOW_UP}" ${SEARCH_FOLLOW_UP_ID}="${e(watch.id)}" aria-label="Open follow-up ${e(watch.subject || '(No subject)')}"${blocked}>
      <span class="rq-row-title">${renderSearchHighlights(watch.subject || '(No subject)', state.query)}</span>
      <span class="rq-row-excerpt">${renderSearchHighlights(mailFollowUpLabel(watch), state.query)} · ${renderSearchHighlights(watch.mail_ref.slug, state.query)}</span>
      <span class="rq-row-when">${e(followUpActionLabel(watch))} · Check time <time datetime="${new Date(watch.check_at).toISOString()}">${e(new Date(watch.check_at).toLocaleString())}</time></span></a>
      ${['waiting', 'needs_attention', 'draft_ready'].includes(watch.state) ? `<a class="rq-retry" href="${e(mailFollowUpHref(watch.id))}" ${actionAttr}="${SEARCH_MANAGE_FOLLOW_UP}" ${SEARCH_FOLLOW_UP_ID}="${e(watch.id)}" aria-label="Check or snooze ${e(watch.subject || '(No subject)')}"${blocked}>Check or snooze</a>` : ''}</article>`).join('')}
    ${state.loaded && !state.matches.length && !state.next_cursor && !state.error && !pending ? '<p class="rq-hint">No reply watches match these filters.</p>' : ''}
    ${state.next_cursor && !pending ? '<p class="rq-subtle">More saved watches remain to be searched.</p>' : ''}
    ${state.next_cursor || state.error ? `<button type="button" class="rq-retry" ${actionAttr}="${SEARCH_MORE_FOLLOW_UPS}" aria-disabled="${pending || writing}">${state.error ? 'Retry watch search' : 'Search more watches'}</button>` : ''}
    <button type="button" class="rq-retry" ${actionAttr}="${SEARCH_REFRESH_FOLLOW_UPS}" aria-disabled="${pending || writing}">Refresh reply watches</button>
  </section>`;
};
