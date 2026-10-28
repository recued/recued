import { CHAT_SESSION_BATCH, CHAT_SESSION_REFRESH_LIMIT, type ChatHistoryFilters, type ChatSessionListRequest, type ChatSessionListResult } from '@recued/contracts';

export type HistorySessionScope = { query?: string; filters?: ChatHistoryFilters };
/** Network ownership and transient cursors only; Chat keeps ownership of its
 * rows so Rename, deletion and incoming events can update them during a read. */
export const createHistorySessionPages = (read: (request: ChatSessionListRequest) => Promise<ChatSessionListResult>) => {
  let generation = 0;
  let disposed = false;
  let loading = false;
  let available = false;
  let scope: HistorySessionScope = {};
  let reply: ChatSessionListResult | undefined;
  let error = '';
  let operation: 'reload' | 'more' = 'reload';
  const scopeKey = (value: HistorySessionScope) => JSON.stringify(value);
  const check = (value: ChatSessionListResult, request: ChatSessionListRequest) => {
    if (!value || !Array.isArray(value.sessions)) throw new Error('Missing chat batch');
    if (value.history_paging_available !== true) return;
    if (value.sessions.length > (request.refresh_count ?? request.limit) || new Set(value.sessions.map(s => s.id)).size !== value.sessions.length) throw new Error('Invalid chat batch');
    if (value.next_cursor) {
      const last = value.sessions.at(-1); const cursor = value.next_cursor;
      if (!last || !Number.isSafeInteger(cursor.last_active_at) || typeof cursor.id !== 'string'
        || cursor.id !== last.id || cursor.last_active_at !== last.last_active_at
        || cursor.id === request.before?.id && cursor.last_active_at === request.before.last_active_at) throw new Error('Invalid chat position');
    }
  };
  const run = async (nextScope: HistorySessionScope, count: number, append: boolean): Promise<ChatSessionListResult | undefined> => {
    if (disposed || append && (loading || !reply?.next_cursor)) return;
    const own = ++generation;
    loading = true; error = ''; operation = append ? 'more' : 'reload';
    let cursor = append ? reply?.next_cursor : undefined;
    const seenCursors = new Set<string>(); const sessions: ChatSessionListResult['sessions'] = [];
    let last: ChatSessionListResult | undefined;
    try {
      do {
        const remaining = count - sessions.length;
        const refresh = !append && !!nextScope.filters && (last ?? reply)?.history_refresh_available === true && remaining > CHAT_SESSION_BATCH;
        const request = { ...nextScope, limit: CHAT_SESSION_BATCH, ...(cursor ? { before: cursor } : {}),
          ...(refresh ? { refresh_count: Math.min(remaining, CHAT_SESSION_REFRESH_LIMIT) } : {}) };
        const result = await read(request);
        if (disposed || own !== generation) return;
        check(result, request);
        if (append && reply?.filter_membership !== result.filter_membership) {
          operation = 'reload'; throw new Error('Chat membership changed before the next batch');
        }
        if (last && last.filter_membership !== result.filter_membership) throw new Error('Chat membership changed during refresh');
        const known = new Set(sessions.map(s => s.id));
        sessions.push(...result.sessions.filter(s => !known.has(s.id)));
        last = result; cursor = result.next_cursor;
        if (cursor) {
          const position = JSON.stringify([cursor.last_active_at, cursor.id]);
          if (seenCursors.has(position)) throw new Error('Repeated chat position');
          seenCursors.add(position);
        }
      } while (!append && last.history_paging_available === true && cursor && sessions.length < count);
      available = last!.history_paging_available === true;
      scope = nextScope;
      reply = { ...last!, sessions };
      return reply;
    } catch (cause) {
      if (!disposed && own === generation) error = 'Recued could not load these chats. Try again.';
      throw cause;
    } finally {
      if (!disposed && own === generation) loading = false;
    }
  };
  return {
    state: () => ({ loading, available, error, operation, reply }),
    scopeKey,
    reload: (nextScope: HistorySessionScope, count = CHAT_SESSION_BATCH) => run(nextScope, Math.max(CHAT_SESSION_BATCH, count), false),
    more: () => run(scope, CHAT_SESSION_BATCH, true),
    dispose: () => { disposed = true; generation++; },
  };
};
