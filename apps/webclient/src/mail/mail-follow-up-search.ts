import {
  MAIL_FOLLOW_UP_STATES, mailFollowUpHref, mailFollowUpReplyHref, mailFollowUpReportHref, readReminderMailReference, matchesMailFollowUp,
  type MailFollowUp, type MailFollowUpCursor, type MailFollowUpFilters, type MailFollowUpList, type MailFollowUpPage,
} from '@recued/contracts';
import type { MailFollowUpCallers } from './mail-follow-up-surface.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export type MailFollowUpListCaller = MailFollowUpCallers['list'];
const date = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
const validId = (id: unknown): id is string => typeof id === 'string' && /^mfw_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const cursorValid = (cursor: MailFollowUpCursor): boolean => !!cursor && date(cursor.updated_at) && validId(cursor.id);
export const followUpNeedsAttention = (watch: MailFollowUp, now: number): boolean =>
  watch.state === 'delivery_failed' || watch.state === 'draft_ready' || watch.state === 'needs_attention' || watch.state === 'waiting' && watch.check_at <= now;
export const followUpResultHref = (watch: MailFollowUp): string => watch.state === 'draft_ready' && watch.draft_id
  ? mailFollowUpHref(watch.id, watch.draft_id, watch.schedule_version ?? 0)
  : watch.state === 'delivery_failed' && watch.delivery_failure ? mailFollowUpReportHref(watch.id) : watch.state === 'replied' && watch.reply_ref ? mailFollowUpReplyHref(watch.id) : mailFollowUpHref(watch.id);
export const copyFollowUp = (watch: MailFollowUp): MailFollowUp => ({ ...watch, mail_ref: { ...watch.mail_ref },
  ...(watch.delivery_failure ? { delivery_failure: { ...watch.delivery_failure, report_ref: { ...watch.delivery_failure.report_ref } } } : {}),
  ...(watch.reply_ref ? { reply_ref: { ...watch.reply_ref } } : {}) });

/** Bound each encrypted read and reject stalled/malformed pagination rather
 * than interpreting an incomplete response as a finished empty search. */
export const readFollowUpPage = async (call: MailFollowUpListCaller, request: MailFollowUpList): Promise<MailFollowUpPage> => {
  const page = await call(request);
  if (!page || !Array.isArray(page.watches) || page.watches.length > 50
    || page.next_cursor !== null && !cursorValid(page.next_cursor)) throw Error('Reply watches could not all be read. Refresh and try again.');
  const next = page.next_cursor, previous = request.cursor;
  if (next && previous && !(next.updated_at < previous.updated_at || next.updated_at === previous.updated_at && next.id > previous.id))
    throw Error('The reply watch page did not advance. Refresh and try again.');
  const ids = new Set<string>();
  for (const watch of page.watches) {
    if (!watch || !validId(watch.id) || ids.has(watch.id) || !Number.isSafeInteger(watch.revision) || watch.revision < 1
      || typeof watch.subject !== 'string' || !MAIL_FOLLOW_UP_STATES.includes(watch.state) || !readReminderMailReference(watch.mail_ref)
      || !date(watch.check_at) || !date(watch.updated_at) || !date(watch.created_at)
      || watch.checked_at !== undefined && !date(watch.checked_at)
      || watch.schedule_version !== undefined && (!Number.isSafeInteger(watch.schedule_version) || watch.schedule_version < 0)
      || watch.delivery_failure !== undefined && (typeof watch.delivery_failure.recipient !== 'string' || typeof watch.delivery_failure.status !== 'string' || !readReminderMailReference(watch.delivery_failure.report_ref))
      || watch.reply_ref !== undefined && !readReminderMailReference(watch.reply_ref)) throw Error('A reply watch could not be confirmed. Refresh and try again.');
    // Also validates a draft identity before it can become a result link.
    if (watch.replacement_draft_id) mailFollowUpHref(watch.id, watch.replacement_draft_id);
    if (watch.draft_id) mailFollowUpHref(watch.id, watch.draft_id, watch.schedule_version ?? 0);
    if (!matchesMailFollowUp(watch, request)) throw Error('This server could not confirm the reply watch filters. Update the server and try again.');
    ids.add(watch.id);
  }
  return page;
};

export interface MailFollowUpSearchState {
  query: string; filters: MailFollowUpFilters; matches: readonly MailFollowUp[];
  next_cursor: MailFollowUpCursor | null; loaded: boolean; loading: boolean;
  error?: string; unsupported?: boolean; retry_append?: boolean;
}
const empty = (filters: MailFollowUpFilters = {}): MailFollowUpSearchState => ({ query: '', filters: { ...filters }, matches: [], next_cursor: null, loaded: false, loading: false });
export const createMailFollowUpSearch = (call: MailFollowUpListCaller | undefined, changed: () => void, initialFilters: MailFollowUpFilters = {}) => {
  let state = empty(initialFilters), generation = 0, disposed = false, pending = Promise.resolve();
  const reset = (): void => { generation++; state = empty(state.filters); };
  const read = async (query: string, append: boolean): Promise<void> => {
    if (!call) return;
    const token = ++generation, previous = state, filters = { ...state.filters };
    const current = () => !disposed && token === generation;
    const found = new Map((append ? previous.matches : []).map(watch => [watch.id, watch]));
    const goal = append ? found.size + 10 : Math.max(5, previous.query === query ? previous.matches.length : 0);
    let cursor = append ? previous.next_cursor : null;
    state = { ...previous, query, matches: append || previous.query === query ? previous.matches : [], loading: true, error: undefined, unsupported: false };
    changed();
    try {
      // A large encrypted history must not monopolize the server or browser.
      // Keep the advancing cursor visible when this pass reaches its budget.
      for (let pages = 0; pages < 32; pages++) {
        const page = await readFollowUpPage(call, { query, ...filters, limit: Math.min(50, goal - found.size), ...(cursor ? { cursor } : {}) });
        if (!current()) return;
        for (const watch of page.watches) found.set(watch.id, watch);
        cursor = page.next_cursor;
        if (!cursor || found.size >= goal) break;
      }
      state = { query, filters, matches: [...found.values()], next_cursor: cursor, loaded: true, loading: false };
    } catch (cause) {
      if (!current()) return;
      const code = classifyRpcError(cause).code;
      // A server without reply watches: one not yet updated (`unknown_method`), or one with the service unwired.
      const unsupported = code === 'unknown_method' || code === 'not_configured';
      state = { ...state, matches: found.size || append ? [...found.values()] : state.matches, next_cursor: cursor, loading: false, unsupported,
        error: unsupported ? undefined : humanizeRpcError(cause), retry_append: append || found.size > 0 || cursor !== null };
    }
    if (current()) changed();
  };
  return {
    state: (): MailFollowUpSearchState => state,
    snapshot: (): MailFollowUpSearchState => ({ ...state, filters: { ...state.filters }, next_cursor: state.next_cursor ? { ...state.next_cursor } : null, matches: state.matches.map(copyFollowUp), loading: false }),
    restore(value: MailFollowUpSearchState) { generation++; state = { ...value, filters: { ...value.filters }, next_cursor: value.next_cursor ? { ...value.next_cursor } : null, matches: value.matches.map(copyFollowUp), loading: false }; },
    setFilters(filters: MailFollowUpFilters) { reset(); state.filters = { ...filters }; },
    load(query: string, append = false, refresh = true): Promise<void> {
      if (disposed || !call) return Promise.resolve();
      const term = query.trim();
      if (append && (state.loading || !state.next_cursor && !state.error)) return pending;
      if (!append && !refresh && state.loaded && state.query === term) return pending;
      pending = read(term, append); return pending;
    },
    reset, whenLoaded: () => pending, dispose() { disposed = true; generation++; },
  };
};
