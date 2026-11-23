import { parseMailDraftId, type MailDraftSummary } from '@recued/contracts';
import type { MailDraftCallers } from './mail-compose-host.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export type MailDraftListCaller = MailDraftCallers['list'];
type DraftPage = Awaited<ReturnType<MailDraftListCaller>>;

export const mailDraftRecipients = (draft: MailDraftSummary): string =>
  (['to', 'cc', 'bcc'] as const).flatMap(key => draft[key]?.length
    ? [`${key === 'to' ? 'To' : key === 'cc' ? 'Cc' : 'Bcc'}: ${draft[key].join(', ')}`] : []).join(' · ');

/** An encrypted scan may advance without finding a match. Continue those
 * pages before claiming an empty result, checking the view after every await. */
export const readMailDraftPage = async (caller: MailDraftListCaller,
  request: Parameters<MailDraftListCaller>[0], isCurrent: () => boolean): Promise<DraftPage | undefined> => {
  let cursor = request.cursor;
  // Each server call bounds decryption work; the cursor and cancellation fence
  // let the client cover the complete store without imposing a result cutoff.
  for (;;) {
    if (!isCurrent()) return undefined;
    const page = await caller({ ...request, ...(cursor ? { cursor } : {}) });
    if (!isCurrent()) return undefined;
    if (!page || !Array.isArray(page.drafts) || !(page.next_cursor === null || typeof page.next_cursor === 'string'))
      throw new Error('The saved draft page could not be confirmed. Try again.');
    if (page.next_cursor !== null) {
      parseMailDraftId(page.next_cursor);
      if (page.next_cursor <= (cursor ?? '')) throw new Error('The saved draft page did not advance. Refresh and try again.');
    }
    for (const row of page.drafts) {
      parseMailDraftId(row.draft_id);
      if (typeof row.subject !== 'string' || typeof row.sender_mail_instance !== 'string'
        || (['to', 'cc', 'bcc'] as const).some(key => row[key] !== undefined
          && (!Array.isArray(row[key]) || row[key].some(value => typeof value !== 'string'))))
        throw new Error('The saved draft preview could not be confirmed. Try again.');
    }
    if (page.drafts.length || page.next_cursor === null) return page;
    cursor = page.next_cursor;
  }
};

export interface MailDraftSearchState {
  query: string;
  matches: readonly MailDraftSummary[];
  next_cursor: string | null;
  loading: boolean;
  error?: string;
  unsupported?: boolean;
  retry_append?: boolean;
}
const empty = (): MailDraftSearchState => ({ query: '', matches: [], next_cursor: null, loading: false });
const copy = (row: MailDraftSummary): MailDraftSummary => ({ ...row,
  ...(row.to ? { to: [...row.to] } : {}), ...(row.cc ? { cc: [...row.cc] } : {}), ...(row.bcc ? { bcc: [...row.bcc] } : {}) });

export const createMailDraftSearch = (caller: MailDraftListCaller | undefined, changed: () => void) => {
  let state = empty(), generation = 0, disposed = false;
  let pending = Promise.resolve();
  const reset = (): void => { generation++; state = empty(); };
  const read = async (query: string, append: boolean): Promise<void> => {
    if (!caller) return;
    const token = ++generation, previous = state;
    const current = (): boolean => !disposed && token === generation;
    const keep = previous.query === query;
    const found = new Map((append && keep ? previous.matches : []).map(row => [row.draft_id, row]));
    const goal = append ? found.size + 10 : Math.max(5, keep ? previous.matches.length : 0);
    let cursor = append ? previous.next_cursor : null;
    state = { ...(keep ? previous : empty()), query, loading: true, error: undefined, retry_append: undefined };
    changed();
    try {
      do {
        const page = await readMailDraftPage(caller, { query, limit: Math.min(100, goal - found.size),
          ...(cursor ? { cursor } : {}) }, current);
        if (!page || !current()) return;
        const size = found.size;
        for (const row of page.drafts) found.set(row.draft_id, row);
        if (page.drafts.length && size === found.size) throw new Error('The saved draft page did not advance. Refresh and try again.');
        cursor = page.next_cursor;
      } while (cursor && found.size < goal);
      state = { query, matches: [...found.values()], next_cursor: cursor, loading: false };
    } catch (error) {
      if (!current()) return;
      const unsupported = classifyRpcError(error).code === 'unknown_method';
      state = { ...state, loading: false, unsupported, retry_append: append,
        error: unsupported ? undefined : humanizeRpcError(error) };
    }
    changed();
  };
  return {
    state: (): MailDraftSearchState => state,
    snapshot: (): MailDraftSearchState => ({ ...state, matches: state.matches.map(copy), loading: false }),
    restore(value: MailDraftSearchState) { generation++; state = { ...value, matches: value.matches.map(copy), loading: false }; },
    load(query: string, append = false): Promise<void> {
      if (disposed) return Promise.resolve();
      const term = query.trim();
      if (!term) { reset(); changed(); return Promise.resolve(); }
      if (append && (state.loading || !state.next_cursor)) return pending;
      pending = read(term, append); return pending;
    },
    reset,
    whenLoaded: () => pending,
    dispose() { disposed = true; generation++; },
  };
};
