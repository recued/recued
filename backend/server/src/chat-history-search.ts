/** Paired-owner conversation search over the authoritative encrypted rows.
 * Model recall has a different corpus and ranking budget. History uses the
 * same decoder, but returns every text match in newest-first scan order so
 * pagination cannot discard lower-ranked matches. No plaintext index/cache. */
import { performance } from 'node:perf_hooks';
import {
  RpcError,
  DEFAULT_CHAT_HISTORY_FILTERS, parseChatHistoryFilters, hasChatHistoryFilters, chatSessionMatchesFilters,
  type ChatHistoryCursor,
  type ChatMessageSearchResult,
  type ChatSessionSummary,
} from '@recued/contracts';
import type { ChatStore } from './storage/chat-store.js';

const normalizeText = (text: string): string =>
  text.normalize('NFKC').replace(/\s+/gu, ' ');

export const parseChatSearchCursor = (value: unknown): ChatHistoryCursor => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RpcError('bad_request', 'Invalid message search cursor', 400);
  }
  const { ts, message_id } = value as Record<string, unknown>;
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts)
    || typeof message_id !== 'string' || message_id.length === 0 || message_id.length > 512) {
    throw new RpcError('bad_request', 'Invalid message search cursor', 400);
  }
  return { ts, message_id };
};

/** Locate the match in display text, including Unicode case-fold expansions.
 * Trim by code points so a snippet never splits an emoji or surrogate pair. */
export const matchingChatSnippet = (content: string, query: string): string | null => {
  const display = normalizeText(content);
  const offset = display.toLowerCase().indexOf(query);
  if (offset < 0) return null;
  const points = Array.from(display);
  let foldedOffset = 0;
  let at = 0;
  while (at < points.length && foldedOffset < offset) {
    foldedOffset += points[at]!.toLowerCase().length;
    at += 1;
  }
  const start = Math.max(0, at - 70);
  const end = Math.min(points.length, Math.max(start + 320, at + Array.from(query).length));
  return `${start > 0 ? '…' : ''}${points.slice(start, end).join('')}${end < points.length ? '…' : ''}`;
};

export const searchChatHistory = async (
  store: Pick<ChatStore, 'scanHistoryMessagesPage' | 'getSession'>,
  args: unknown,
  now: () => number = () => performance.now(),
  readSessions?: () => { sessions: ChatSessionSummary[]; messenger_status_available?: boolean },
): Promise<ChatMessageSearchResult> => {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new RpcError('bad_request', 'Message search requires a query', 400);
  }
  const safe = args as Record<string, unknown>;
  if (typeof safe.query !== 'string' || safe.query.trim().length === 0
    || Buffer.byteLength(safe.query, 'utf8') > 512) {
    throw new RpcError('bad_request', 'Search text must contain 1–512 bytes', 400);
  }
  let cursor = safe.before === undefined ? undefined : parseChatSearchCursor(safe.before);
  const filters = safe.filters === undefined ? DEFAULT_CHAT_HISTORY_FILTERS : parseChatHistoryFilters(safe.filters);
  if (filters === null) throw new RpcError('bad_request', 'Invalid chat filters', 400);
  if (safe.session_id !== undefined && (typeof safe.session_id !== 'string' || safe.session_id.length === 0 || safe.session_id.length > 512)) {
    throw new RpcError('bad_request', 'Invalid conversation scope', 400);
  }
  const sessionId = typeof safe.session_id === 'string' ? safe.session_id : undefined;
  let sessionIds: string[] | undefined = sessionId === undefined ? undefined : [sessionId];
  if (hasChatHistoryFilters(filters)) {
    if (!readSessions) throw new RpcError('not_configured', 'Chat filters are unavailable on this server', 501);
    const snapshot = readSessions();
    if (snapshot.messenger_status_available === false) throw new RpcError('unavailable', 'Current chat status is unavailable', 503);
    sessionIds = snapshot.sessions.filter(session =>
      (sessionId === undefined || sessionId === session.id) && chatSessionMatchesFilters(session, filters),
    ).map(session => session.id);
  }
  if (store.scanHistoryMessagesPage === undefined) {
    throw new RpcError('not_configured', 'Conversation search is unavailable on this server', 501);
  }
  const query = normalizeText(safe.query).trim().toLowerCase();
  const result: ChatMessageSearchResult = { matches: [], incomplete: false };
  const started = now();
  let inspected = 0;
  // Each call bounds rows, decrypted pages, result bytes, and elapsed work.
  // Resume immediately after the last inspected row, including a full result
  // page ending midway through a decrypted batch. No matching row is lost.
  while (true) {
    const page = await store.scanHistoryMessagesPage({
      ...(cursor ? { before: cursor } : {}), limit: 32,
      ...(sessionIds !== undefined ? { session_ids: sessionIds } : {}),
    });
    for (let i = 0; i < page.rows.length; i += 1) {
      const row = page.rows[i]!;
      cursor = { ts: row.timestamp, message_id: row.item_id };
      inspected += 1;
      if (!row.readable) result.incomplete = true;
      else if (row.kind === 'user' || row.kind === 'assistant') {
        const snippet = matchingChatSnippet(row.content, query);
        if (snippet !== null) {
          // Deletion may race a decrypt. Do not return an orphaned hit.
          const session = store.getSession(row.session_id);
          if (session !== null) result.matches.push({
            session_id: row.session_id, message_id: row.item_id,
            ...(session.title ? { title: session.title } : {}),
            role: row.kind, ts: row.timestamp, snippet,
          });
        }
      }
      if (result.matches.length >= 30 || inspected >= 512 || now() - started >= 250) {
        if (i + 1 < page.rows.length || page.next_cursor !== undefined) result.next_cursor = cursor;
        return result;
      }
    }
    if (page.next_cursor === undefined) return result;
    cursor = page.next_cursor;
  }
};
