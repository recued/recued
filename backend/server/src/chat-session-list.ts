import { createHash } from 'node:crypto';
import { RpcError, CHAT_SESSION_REFRESH_LIMIT, DEFAULT_CHAT_HISTORY_FILTERS, parseChatHistoryFilters, hasChatHistoryFilters, chatSessionMatchesFilters,
  type ChatSessionListRequest, type ChatSessionListResult } from '@recued/contracts';
import type { ChatRpcDeps } from './chat-handler.js';

export const parseSessionListRequest = (args: unknown): ChatSessionListRequest => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new RpcError('bad_request', 'Provide a chat batch size.', 400);
  const input = args as Record<string, unknown>;
  if (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100) throw new RpcError('bad_request', 'Load between 1 and 100 chats at a time.', 400);
  if (input.query !== undefined && (typeof input.query !== 'string' || Buffer.byteLength(input.query, 'utf8') > 512)) throw new RpcError('bad_request', 'Search chat names with up to 512 bytes.', 400);
  const filters = input.filters === undefined ? DEFAULT_CHAT_HISTORY_FILTERS : parseChatHistoryFilters(input.filters);
  if (!filters) throw new RpcError('bad_request', 'Invalid chat filters.', 400);
  if (input.refresh_count !== undefined && (!Number.isSafeInteger(input.refresh_count)
    || (input.refresh_count as number) < (input.limit as number) || (input.refresh_count as number) > CHAT_SESSION_REFRESH_LIMIT
    || !hasChatHistoryFilters(filters))) throw new RpcError('bad_request', 'Invalid filtered chat refresh window.', 400);
  let before: ChatSessionListRequest['before'];
  if (input.before !== undefined) {
    if (!input.before || typeof input.before !== 'object' || Array.isArray(input.before)) throw new RpcError('bad_request', 'Invalid chat position.', 400);
    const cursor = input.before as Record<string, unknown>;
    if (!Number.isSafeInteger(cursor.last_active_at) || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 2048) throw new RpcError('bad_request', 'Invalid chat position.', 400);
    before = { last_active_at: cursor.last_active_at as number, id: cursor.id };
  }
  return { limit: input.limit as number, ...(before ? { before } : {}),
    ...(typeof input.query === 'string' ? { query: input.query.trim() } : {}), ...(hasChatHistoryFilters(filters) ? { filters } : {}),
    ...(typeof input.refresh_count === 'number' ? { refresh_count: input.refresh_count } : {}) };
};

/** Only explicit filtered browsing inspects whole-corpus Messenger membership.
 * Ordinary opens read one metadata batch and count messages for that batch. */
export const readChatSessionPage = (deps: ChatRpcDeps, request: ChatSessionListRequest): ChatSessionListResult => {
  const bridge = deps.orchestrator.messengerBridge;
  let membership: { ids: string[]; exclude: boolean } | undefined;
  let statuses: ReturnType<NonNullable<typeof bridge>['sessionStatuses']> | undefined;
  if (request.filters) {
    if (!bridge) throw new RpcError('unavailable', 'Current chat status is unavailable.', 503);
    try { statuses = bridge.allSessionStatuses(deps.messengerReceiveStatus); }
    catch { throw new RpcError('unavailable', 'Current chat status is unavailable.', 503); }
    const exclude = request.filters.source === 'webclient' && request.filters.vendor === 'all' && !request.filters.needs_attention;
    const ids = [...statuses].filter(([id, messenger]) => exclude || chatSessionMatchesFilters({ id, messenger }, request.filters!)).map(([id]) => id).sort();
    membership = { ids, exclude };
  }
  // Each explicit refresh owns one fresh projection, shared only within this
  // synchronous request. No status or membership survives into a later read.
  const count = request.refresh_count ?? request.limit;
  const sessions: ChatSessionListResult['sessions'] = [];
  let cursor = request.before;
  let page: ReturnType<NonNullable<ChatRpcDeps['store']['listSessionsPage']>>;
  do {
    const limit = Math.min(request.limit, count - sessions.length);
    page = deps.store.listSessionsPage!({ limit, ...(cursor ? { before: cursor } : {}),
      ...(request.query ? { query: request.query } : {}), ...(membership ? { membership } : {}) });
    sessions.push(...page.sessions);
    if (page.next_cursor && (!page.sessions.length || page.next_cursor.id === cursor?.id
      && page.next_cursor.last_active_at === cursor.last_active_at)) throw new RpcError('unavailable', 'Invalid chat refresh position.', 503);
    cursor = page.next_cursor;
  } while (cursor && sessions.length < count);
  let available: boolean | undefined;
  if (bridge) {
    try { statuses ??= bridge.sessionStatuses(sessions.map(s => s.id), deps.messengerReceiveStatus, { requestedOnly: true }); available = true; }
    catch { available = false; }
  }
  return { ...page, sessions: sessions.map(session => {
    const messenger = statuses?.get(session.id); return messenger ? { ...session, messenger } : session;
  }), ...(deps.sessionBusy ? { busy_session_ids: deps.sessionBusy.busySessionIds() } : {}),
    ...(available !== undefined ? { messenger_status_available: available } : {}),
    history_filters_available: true, messenger_status_refresh_available: true, history_paging_available: true, history_refresh_available: true,
    ...(membership ? { filter_membership: createHash('sha256').update(JSON.stringify(membership)).digest('hex') } : {}),
  };
};
