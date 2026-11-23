import { RpcError, isReminderState, readReminderRecordReference, sameReminderRecordReference, readReminderMailReference, sameReminderMailReference, type ReminderListPageInput, type ReminderListResult,
  type ReminderListRequest, type ReminderListCursor, type ReminderSearchStatus, type ReminderView } from '@recued/contracts';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export type ReminderSearchCaller = (request: ReminderListRequest) => Promise<ReminderListResult>;
export type ReminderSearchInput = ReminderListPageInput & { state: ReminderSearchStatus };
export interface ReminderSearchState {
  input: ReminderSearchInput;
  matches: readonly ReminderView[];
  total: number;
  next_cursor: ReminderListCursor | null;
  pages: number;
  loading: boolean;
  error?: string;
  unsupported?: boolean;
  retry_append?: boolean;
}
export const REMINDER_STATUS_LABELS: Record<ReminderSearchStatus, string> = {
  all: 'All statuses', pending: 'Waiting', delivered: 'Rang', cancelled: 'Cancelled',
};
const empty = (): ReminderSearchState => ({ input: { state: 'all' }, matches: [], total: 0, next_cursor: null, pages: 0, loading: false });
const validCursor = (value: ReminderListCursor): boolean => !!value && Number.isFinite(value.at)
  && Math.abs(value.at) <= 8.64e15 && typeof value.reminder_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.reminder_id);
const after = (left: ReminderListCursor, right: ReminderListCursor): boolean =>
  left.at > right.at || left.at === right.at && left.reminder_id > right.reminder_id;
const fold = (value: string): string => value.normalize('NFKC').toLowerCase();

/** Scope acknowledgement is required: old servers only search waiting rows.
 * Validate the same contract for the Reminders tab and universal search. */
export const validateReminderSearchPage = (out: ReminderListResult, input: ReminderSearchInput): void => {
  if (!out?.page || out.page.state === undefined)
    throw new RpcError('not_configured', 'Update your Recued server to search reminder history.');
  const invalid = (): never => { throw new Error('The reminder search page could not be confirmed. Refresh and try again.'); };
  const ref = input.record_ref;
  if (ref) {
    const ack = readReminderRecordReference(out.page.record_ref);
    if (!ack || !sameReminderRecordReference(ref, ack)) throw new RpcError('not_configured', 'Update your Recued server to find reminders linked to this exact record.');
  }
  const mail = input.mail_ref;
  if (mail) {
    const ack = readReminderMailReference(out.page.mail_ref);
    if (!ack || !sameReminderMailReference(mail, ack)) throw new RpcError('not_configured', 'Update your Recued server to find reminders linked to this exact email.');
  }
  if ((out.page.history_only === true) !== (input.history_only === true)) invalid();
  if (out.page.state !== input.state || !Array.isArray(out.reminders)
    || !Number.isSafeInteger(out.count) || out.count < 0 || !Number.isSafeInteger(out.page.matched_count) || out.page.matched_count < 0) invalid();
  let previous = input.cursor;
  for (const row of out.reminders) {
    const linked = readReminderRecordReference(row.record_ref);
    const email = readReminderMailReference(row.mail_ref);
    if (mail && (!email || !sameReminderMailReference(mail, email))) invalid();
    if (ref && (!linked || !sameReminderRecordReference(ref, linked)) || input.history_only && row.state === 'pending') invalid();
    if (!validCursor(row) || !isReminderState(row.state) || input.state !== 'all' && row.state !== input.state
      || typeof row.text !== 'string' || typeof row.when !== 'string' || row.time_zone !== null && typeof row.time_zone !== 'string'
      || row.delivered_at !== null && !Number.isFinite(row.delivered_at)
      || row.managed_by !== undefined && row.managed_by !== 'clock'
      || input.query && !fold(row.text).includes(fold(input.query.trim()))
      || input.from !== undefined && row.at < input.from || input.before !== undefined && row.at >= input.before
      || previous && !after(row, previous)) invalid();
    previous = row;
  }
  const cursor = out.page.next_cursor, last = out.reminders.at(-1);
  if (cursor !== null && (!validCursor(cursor) || !last || cursor.at !== last.at || cursor.reminder_id !== last.reminder_id
    || input.cursor && !after(cursor, input.cursor))) invalid();
};

/** One paged owner search, with old replies fenced on query/status changes,
 * navigation restoration, and disposal. Refresh rechecks every loaded page. */
export const createReminderSearch = (caller: ReminderSearchCaller | undefined, changed: () => void) => {
  let state = empty(), generation = 0, disposed = false, pending = Promise.resolve();
  const key = (input: ReminderSearchInput) => JSON.stringify([input.query ?? '', input.state, input.from, input.before, input.record_ref ?? null, input.mail_ref ?? null, input.history_only === true]);
  const reset = (): void => { generation++; state = empty(); };
  const read = async (input: ReminderSearchInput, append: boolean): Promise<void> => {
    if (!caller) return;
    const mine = ++generation, previous = state, keep = key(input) === key(previous.input);
    const found = new Map((append && keep ? previous.matches : []).map(row => [row.reminder_id, row]));
    const goal = append ? 1 : Math.max(1, keep ? previous.pages : 0);
    let cursor = append && keep ? previous.next_cursor : null, pages = append && keep ? previous.pages : 0;
    let total = 0, restart = false;
    state = { ...(keep ? previous : empty()), input, loading: true, error: undefined, unsupported: false, retry_append: undefined };
    changed();
    try {
      if ((input.query?.length ?? 0) > 200) throw new Error('Search reminders with at most 200 characters.');
      for (let page = 0; page < goal; page++) {
        const request = { ...input, ...(cursor ? { cursor } : {}) };
        const out = await caller({ limit: 50, page: request });
        if (disposed || mine !== generation) return;
        validateReminderSearchPage(out, request);
        for (const row of out.reminders) found.set(row.reminder_id, row);
        total = out.page!.matched_count;
        cursor = out.page!.next_cursor; pages++;
        if (found.size > total || !cursor && found.size !== total) {
          restart = true;
          throw new Error('The reminders changed while searching. Retry to refresh the results.');
        }
        if (!cursor) break;
      }
      state = { input, matches: [...found.values()], total, next_cursor: cursor, pages, loading: false };
    } catch (error) {
      if (disposed || mine !== generation) return;
      const code = classifyRpcError(error).code;
      const unsupported = code === 'unknown_method' || code === 'not_configured';
      state = { ...state, loading: false, unsupported, error: unsupported ? undefined : humanizeRpcError(error), retry_append: append && !restart };
    }
    changed();
  };
  const copy = (value: ReminderSearchState): ReminderSearchState => ({ ...value, input: { ...value.input },
    matches: value.matches.map(row => ({ ...row })), next_cursor: value.next_cursor ? { ...value.next_cursor } : null, loading: false });
  return {
    state: (): ReminderSearchState => state,
    snapshot: () => copy(state),
    restore(value: ReminderSearchState) { generation++; state = copy(value); },
    load(input: ReminderSearchInput, append = false): Promise<void> {
      if (disposed || !caller) return Promise.resolve();
      if (append && (state.loading || !state.next_cursor)) return pending;
      const clean = { ...input, query: input.query?.trim(), cursor: undefined };
      pending = read(clean, append); return pending;
    },
    reset, whenLoaded: () => pending,
    dispose() { disposed = true; generation++; },
  };
};
