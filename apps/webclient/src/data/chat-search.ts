import type { ChatHistoryCursor, ChatMessageSearchMatch, ChatMessageSearchRequest, ChatMessageSearchResult } from '@recued/contracts';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';

export type ChatSearchCaller = (request: ChatMessageSearchRequest) => Promise<ChatMessageSearchResult>;
export interface ChatSearchState {
  query: string;
  matches: readonly ChatMessageSearchMatch[];
  next_cursor?: ChatHistoryCursor;
  incomplete: boolean;
  pages: number;
  loading: boolean;
  error?: string;
  unsupported?: boolean;
  retry_append?: boolean;
}
export const chatSearchKey = (match: Pick<ChatMessageSearchMatch, 'session_id' | 'message_id'>): string =>
  JSON.stringify([match.session_id, match.message_id]);
const empty = (): ChatSearchState => ({ query: '', matches: [], incomplete: false, pages: 0, loading: false });
const compareId = (left: string, right: string): number => {
  // Match the encrypted store's SQLite BINARY cursor ordering at timestamp ties.
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};
const older = (left: ChatHistoryCursor, right: ChatHistoryCursor): boolean =>
  left.ts < right.ts || left.ts === right.ts && compareId(left.message_id, right.message_id) < 0;
const validCursor = (value: ChatHistoryCursor): boolean => !!value && Number.isSafeInteger(value.ts)
  && typeof value.message_id === 'string' && value.message_id.length > 0 && value.message_id.length <= 512;
const validate = (page: ChatMessageSearchResult, before?: ChatHistoryCursor): void => {
  const invalid = (): never => { throw new Error('The chat search page could not be confirmed. Try again.'); };
  if (!page || !Array.isArray(page.matches) || typeof page.incomplete !== 'boolean') invalid();
  let previous = before;
  for (const match of page.matches) {
    if (!validCursor(match) || typeof match.session_id !== 'string' || !match.session_id || match.session_id.length > 512
      || typeof match.snippet !== 'string' || match.title !== undefined && typeof match.title !== 'string'
      || match.role !== 'user' && match.role !== 'assistant' || previous && !older(match, previous)) invalid();
    previous = match;
  }
  const cursor = page.next_cursor;
  if (cursor !== undefined && (!validCursor(cursor) || before && !older(cursor, before)
    || previous && (cursor.ts !== previous.ts || cursor.message_id !== previous.message_id) && !older(cursor, previous))) invalid();
};

/** Search the same retained user/assistant messages as Chat History. Empty
 * scan pages and unreadable rows stay explicit rather than implying no hits. */
export const createChatSearch = (caller: ChatSearchCaller | undefined, changed: () => void) => {
  let state = empty(), generation = 0, disposed = false;
  let pending = Promise.resolve();
  const reset = (): void => { generation++; state = empty(); };
  const read = async (query: string, append: boolean): Promise<void> => {
    if (!caller) return;
    const seq = ++generation, previous = state, keep = previous.query === query;
    const goal = append ? 1 : Math.max(1, keep ? previous.pages : 0);
    const found = new Map((append && keep ? previous.matches : []).map(match => [chatSearchKey(match), match]));
    let cursor = append ? previous.next_cursor : undefined;
    let incomplete = append && previous.incomplete, pages = append ? previous.pages : 0;
    state = { ...(keep ? previous : empty()), query, loading: true, error: undefined, retry_append: undefined };
    changed();
    try {
      for (let pageNumber = 0; pageNumber < goal; pageNumber++) {
        const page = await caller({ query, ...(cursor ? { before: cursor } : {}) });
        if (disposed || seq !== generation) return;
        validate(page, cursor);
        for (const match of page.matches) found.set(chatSearchKey(match), match);
        cursor = page.next_cursor; incomplete ||= page.incomplete; pages++;
        if (!cursor) break;
      }
      state = { query, matches: [...found.values()], next_cursor: cursor, incomplete, pages, loading: false };
    } catch (error) {
      if (disposed || seq !== generation) return;
      const code = classifyRpcError(error).code;
      const unsupported = code === 'unknown_method' || code === 'not_configured';
      state = { ...state, loading: false, retry_append: append, unsupported,
        error: unsupported ? undefined : humanizeRpcError(error) };
    }
    changed();
  };
  return {
    state: (): ChatSearchState => state,
    snapshot: (): ChatSearchState => ({ ...state, matches: state.matches.map(match => ({ ...match })),
      next_cursor: state.next_cursor ? { ...state.next_cursor } : undefined, loading: false }),
    restore(value: ChatSearchState) { generation++; state = { ...value, matches: value.matches.map(match => ({ ...match })),
      next_cursor: value.next_cursor ? { ...value.next_cursor } : undefined, loading: false }; },
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
