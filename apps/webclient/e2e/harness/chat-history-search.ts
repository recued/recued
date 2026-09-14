import type {
  ChatMessage, ChatMessageSearchRequest, ChatMessageSearchResult,
  ChatSession, ChatSessionGetRequest,
} from '@recued/contracts';

const session = (id: string): ChatSession => ({
  id, title: id === 'a' ? 'Weekly planning' : 'Travel notes',
  created_at: 1000, last_active_at: id === 'a' ? 3000 : 4000, archived: false,
  picker_state: { current: 'self' },
  model_routing: { current: 'byok', provider: 'openai', model_id: 'model', overridden: false },
});
const messages: Array<ChatMessage & { role: 'user' | 'assistant' }> = ['a', 'b'].flatMap(id => Array.from({ length: id === 'a' ? 250 : 2 }, (_, i) => ({
  id: `${id}-m${String(i).padStart(3, '0')}`, session_id: id,
  role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
  contributor: i % 2 === 0 ? 'user' as const : 'model' as const,
  content: id === 'b' && i === 1 ? 'The Kyoto needle is packed.'
    : id === 'a' && i === 20 ? 'Remember the secret needle <img src=x onerror=alert(1)> in this old message.'
      : id === 'a' && i === 21 ? 'The needle is safely stored.' : `Ordinary ${id} message ${i}`,
  target_server: 'self', ts: id === 'a' ? 1000 + i : 2000 + i,
  picker_at_send: { display_name: 'Self', signature: { server_kind: 'recued' as const, version: '1.0.0', instance_id: 'test' } },
  model_used: { provider: 'test', model_id: 'model' },
})));

export const chatHistorySearchReply = (method: string, args: unknown): {
  result?: unknown; error?: { code: string; message: string };
} | null => {
  if (!new URLSearchParams(location.search).has('chat_search')) return null;
  if (!['chat.sessions.list', 'chat.messages.search', 'chat.session.get'].includes(method)) return null;
  const key = 'recued-test-chat-search-requests';
  sessionStorage.setItem(key, JSON.stringify([
    ...JSON.parse(sessionStorage.getItem(key) ?? '[]'), { method, args },
  ]));
  if (method === 'chat.sessions.list') return { result: { sessions: ['a', 'b'].map(id => ({
    ...session(id), message_count: id === 'a' ? 250 : 2,
  })) } };
  if (method === 'chat.messages.search') {
    if (new URLSearchParams(location.search).get('chat_search') === 'unsupported') {
      return { error: { code: 'unknown_method', message: 'Unknown method' } };
    }
    const request = args as ChatMessageSearchRequest;
    const hits = messages.filter(message => message.content.toLowerCase().includes(request.query.toLowerCase()))
      .filter(message => request.before === undefined || message.ts < request.before.ts)
      .sort((a, b) => b.ts - a.ts);
    const page = hits.slice(0, 2);
    const last = page.at(-1);
    return { result: {
      matches: page.map(message => ({
        session_id: message.session_id, message_id: message.id, role: message.role,
        ts: message.ts, title: session(message.session_id).title!, snippet: message.content,
      })), incomplete: false,
      ...(hits.length > 2 && last ? { next_cursor: { ts: last.ts, message_id: last.id } } : {}),
    } satisfies ChatMessageSearchResult };
  }
  const request = args as ChatSessionGetRequest;
  if (request.around_message_id !== undefined
    && sessionStorage.getItem('recued-test-chat-fail-target') === request.around_message_id) {
    return { error: { code: 'internal', message: 'Could not load this message. Try again.' } };
  }
  const all = messages.filter(message => message.session_id === request.session_id
    && !(sessionStorage.getItem('recued-test-chat-missing-target') === message.id));
  const limit = request.limit ?? all.length;
  const anchor = all.findIndex(message => message.id === request.around_message_id);
  const before = all.findIndex(message => message.id === request.before?.message_id);
  const after = all.findIndex(message => message.id === request.after?.message_id);
  const end = before >= 0 ? before : all.length;
  const start = anchor >= 0 ? Math.max(0, anchor - Math.floor(limit / 2))
    : after >= 0 ? after + 1 : Math.max(0, end - limit);
  const page = all.slice(start, Math.min(end, start + limit));
  return { result: {
    ...session(request.session_id), messages: page, has_more: start > 0,
    has_more_after: start + page.length < all.length,
    oldest_cursor: page[0] && { ts: page[0].ts, message_id: page[0].id },
    newest_cursor: page.at(-1) && { ts: page.at(-1)!.ts, message_id: page.at(-1)!.id },
  } };
};
