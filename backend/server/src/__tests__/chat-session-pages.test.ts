import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatMessengerBridge } from '../chat-messenger-bridge.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { handleSessionsList, makeChatHandlers, type ChatRpcDeps } from '../chat-handler.js';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const fixture = () => {
  const db = new Database(':memory:'); ensureChatSchema(db); const store = createChatStore(db);
  const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'batch-test' };
  const raw = createChatOrchestrator({ chatStore: store, selfSignature: signature,
    registry: { list: () => [], listByTier: () => [], getByName: () => null, dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} } });
  const bridge = createChatMessengerBridge({ db, store, pollMs: 60_000 });
  let receive = 'active' as 'active' | 'retrying';
  const deps: ChatRpcDeps = { store, orchestrator: { ...raw, messengerBridge: bridge }, selfSignature: signature, messengerReceiveStatus: () => receive };
  cleanup.push(() => { bridge.close(); db.close(); });
  return { db, store, bridge, deps, receive: () => { receive = 'retrying'; },
    message: (session_id: string) => store.appendMessage({ session_id, id: `m-${session_id}`, role: 'assistant', content: 'Private retained message', target_server: 'self',
      picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'fixture', model_id: 'fixture' } }) };
};

describe('bounded Chat history batches', () => {
  it('shares one fresh global projection within a bounded filtered refresh, then rechecks the next request', () => {
    const f = fixture();
    for (let i = 0; i < 181; i++) {
      const id = `s${String(i).padStart(3, '0')}`;
      f.store.createSession({ id, now: i + 1 });
      if (i < 180) f.bridge.bind('telegram', `recipient-${i}`, 'bot', id);
    }
    const statuses = vi.spyOn(f.bridge, 'allSessionStatuses');
    const read = vi.spyOn(f.store, 'listSessionsPage');
    const changes = f.db.prepare('SELECT total_changes() AS n').get();
    const filters = { source: 'messenger' as const, vendor: 'telegram' as const, needs_attention: false };
    const first = handleSessionsList(f.deps, { limit: 50, filters, refresh_count: 150 });
    expect(first.sessions.map(row => row.id)).toEqual(Array.from({ length: 150 }, (_, i) => `s${String(179 - i).padStart(3, '0')}`));
    expect(first.history_refresh_available).toBe(true); expect(statuses).toHaveBeenCalledTimes(1);
    expect(read.mock.calls.map(([args]) => args.limit)).toEqual([50, 50, 50]);
    expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    f.bridge.bind('telegram', 'new-recipient', 'bot', 's180');
    const second = handleSessionsList(f.deps, { limit: 50, before: first.next_cursor, filters });
    expect(statuses).toHaveBeenCalledTimes(2); expect(second.filter_membership).not.toBe(first.filter_membership);
    const partial = handleSessionsList(f.deps, { limit: 50, filters, refresh_count: 75 });
    expect(partial.sessions).toHaveLength(75);
    expect(read.mock.calls.slice(-2).map(([args]) => args.limit)).toEqual([50, 25]);
  });

  it('bounds refresh windows and leaves legacy full-list requests unchanged', () => {
    const f = fixture(); f.store.createSession({ id: 's' });
    const filters = { source: 'messenger' as const, vendor: 'all' as const, needs_attention: false };
    for (const refresh_count of [0, 49, 1001, 50.5, '150', null])
      expect(() => handleSessionsList(f.deps, { limit: 50, filters, refresh_count } as never)).toThrow();
    expect(() => handleSessionsList(f.deps, { limit: 50, refresh_count: 150 })).toThrow();
    expect(handleSessionsList(f.deps, { limit: 50, filters, refresh_count: 1000 }).sessions).toEqual([]);
    expect(handleSessionsList(f.deps)).not.toHaveProperty('history_refresh_available');
  });

  it('keeps sparse member ordering, Unicode search, counts and cursor boundaries across archived and missing IDs', async () => {
    const f = fixture();
    for (let i = 0; i < 240; i++) f.store.createSession({ id: `s${String(i).padStart(3, '0')}`, now: 1, title: i % 3 ? 'Other' : 'ÉCOLE' });
    for (const id of ['s003', 's021', 's180']) await f.message(id);
    f.db.prepare('UPDATE chat_sessions SET last_active_at=1, archived=CASE WHEN session_id=? THEN 1 ELSE 0 END').run('s003');
    const ids = Array.from({ length: 90 }, (_, i) => `s${String(i * 2 + 1).padStart(3, '0')}`);
    ids.push('missing', 's003');
    const expected = f.store.listSessions().filter(row => ids.includes(row.id) && row.title === 'ÉCOLE')
      .sort((a, b) => Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)));
    const actual = [];
    let before: { id: string; last_active_at: number } | undefined;
    do {
      const page = f.store.listSessionsPage!({ limit: 7, before, membership: { ids, exclude: false }, query: 'école' });
      actual.push(...page.sessions); before = page.next_cursor;
    } while (before);
    expect(actual).toEqual(expected); expect(actual.find(row => row.id === 's003')).toMatchObject({ archived: true, message_count: 1 });
    const empty = f.store.listSessionsPage!({ limit: 7, membership: { ids: [], exclude: false } });
    expect(empty.sessions).toEqual([]); expect(empty.has_sessions).toBe(true); expect(empty.has_saved_chats).toBe(true);
  });

  it('walks equal activity times, includes archived chats and survives deletion of the cursor row', async () => {
    const f = fixture();
    for (let i = 0; i < 123; i++) f.store.createSession({ id: `s${String(i).padStart(3, '0')}`, now: 1 });
    await f.message('s001'); f.db.prepare('UPDATE chat_sessions SET archived = 1, last_active_at = 1 WHERE session_id = ?').run('s001');
    const full = f.store.listSessions();
    vi.spyOn(f.store, 'listSessions').mockImplementation(() => { throw new Error('Must not load the whole history'); });
    const before = f.db.prepare('SELECT total_changes() AS n').get();
    const first = handleSessionsList(f.deps, { limit: 50 });
    expect(first.sessions).toHaveLength(50); expect(first.sessions[0]?.id).toBe('s122');
    expect(first.has_saved_chats).toBe(true); expect(first.has_sessions).toBe(true);
    expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
    f.store.deleteSession(first.next_cursor!.id);
    const second = handleSessionsList(f.deps, { limit: 50, before: first.next_cursor! });
    const third = handleSessionsList(f.deps, { limit: 50, before: second.next_cursor! });
    const rows = [...first.sessions, ...second.sessions, ...third.sessions];
    expect(rows.map(s => s.id)).toEqual(full.map(s => s.id).sort().reverse());
    expect(third.sessions).toHaveLength(23); expect(third.next_cursor).toBeUndefined();
    expect(rows.find(s => s.id === 's001')).toMatchObject({ archived: true, message_count: 1, last_seen_message_count: 0 });
    expect(JSON.stringify(rows)).not.toContain('Private retained message');
  });

  it('finds Unicode titles and canonical Messenger identities beyond the first batch', async () => {
    const f = fixture();
    for (let i = 0; i < 80; i++) f.store.createSession({ id: `recent-${i}`, title: 'Recent', now: 100 + i });
    f.store.createSession({ id: 'old', title: 'ÉCOLE and family', now: 1 });
    f.bridge.bind('telegram', '42', 'bot', 'old');
    f.bridge.register('telegram', { resolve: async () => ({ token: 'secret', recipient: '42', account: 'bot' }), send: vi.fn() });
    expect(handleSessionsList(f.deps, { limit: 50 }).sessions.some(s => s.id === 'old')).toBe(false);
    expect(handleSessionsList(f.deps, { limit: 50, query: 'école' }).sessions.map(s => s.id)).toEqual(['old']);
    const filters = { source: 'messenger' as const, vendor: 'telegram' as const, needs_attention: false };
    expect(handleSessionsList(f.deps, { limit: 50, filters }).sessions[0]).toMatchObject({ id: 'old', messenger: { vendor: 'telegram' } });
    await vi.waitFor(() => expect(handleSessionsList(f.deps, { limit: 50, filters }).sessions[0]?.messenger?.receive).toBe('active'));
    const attention = { ...filters, needs_attention: true };
    const healthy = handleSessionsList(f.deps, { limit: 50, filters: attention });
    expect(healthy.sessions).toEqual([]); expect(healthy.has_sessions).toBe(true);
    f.receive(); const changed = handleSessionsList(f.deps, { limit: 50, filters: attention });
    expect(changed.sessions.map(s => s.id)).toEqual(['old']); expect(changed.filter_membership).not.toBe(healthy.filter_membership);
    vi.spyOn(f.bridge, 'allSessionStatuses').mockImplementation(() => { throw new Error('Cannot establish global membership'); });
    expect(() => handleSessionsList(f.deps, { limit: 50, filters: attention })).toThrow('Current chat status is unavailable');
  });

  it('keeps legacy identities in Messenger filters and excludes them from Webclient browsing', () => {
    const f = fixture();
    for (const id of ['web', 'messenger:discord:old', 'messenger::not-an-identity']) f.store.createSession({ id, now: 1 });
    const filters = { source: 'webclient' as const, vendor: 'all' as const, needs_attention: false };
    expect(handleSessionsList(f.deps, { limit: 50, filters }).sessions.map(s => s.id).sort()).toEqual(['messenger::not-an-identity', 'web']);
    expect(handleSessionsList(f.deps, { limit: 50, filters: { ...filters, source: 'messenger' } }).sessions.map(s => s.id)).toEqual(['messenger:discord:old']);
  });

  it('validates batch bounds and preserves the no-argument and older-adapter list contracts', () => {
    const f = fixture(); for (let i = 0; i < 61; i++) f.store.createSession({ id: `s${i}` });
    for (const args of [null, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: 50, before: {} }, { limit: 50, query: 'x'.repeat(513) }, { limit: 50, filters: { vendor: 'bad' } }]) {
      expect(() => handleSessionsList(f.deps, args as never)).toThrow();
    }
    expect(handleSessionsList(f.deps)).not.toHaveProperty('history_paging_available');
    const wire = handleSessionsList(f.deps, {} as never);
    expect(wire.sessions).toHaveLength(61); expect(wire.history_paging_available).toBeUndefined();
    const { listSessionsPage: _paging, ...store } = f.store;
    expect(handleSessionsList({ ...f.deps, store }, { limit: 50 })).not.toHaveProperty('history_paging_available');
  });

  it('accepts the transport-normalized empty payload at the registered legacy method', async () => {
    const f = fixture(); f.store.createSession({ id: 's' });
    const list = makeChatHandlers(f.deps)!.handlers['chat.sessions.list']!;
    const result = await list({} as never, undefined as never);
    expect(result.sessions.map(s => s.id)).toEqual(['s']); expect(result.history_paging_available).toBeUndefined();
  });

  it('upgrades the existing partial recency index without changing chat data', () => {
    const f = fixture(); f.store.createSession({ id: 's', now: 1 });
    f.db.exec('DROP INDEX idx_chat_sessions_last_active; CREATE INDEX idx_chat_sessions_last_active ON chat_sessions(last_active_at DESC) WHERE archived = 0');
    const before = f.store.getSession('s'); ensureChatSchema(f.db); ensureChatSchema(f.db);
    expect(f.store.getSession('s')).toEqual(before);
    expect((f.db.prepare('PRAGMA index_info(idx_chat_sessions_last_active)').all() as { name: string }[]).map(c => c.name)).toEqual(['last_active_at', 'session_id']);
    expect((f.db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'idx_chat_sessions_last_active'").get() as { sql: string }).sql).not.toContain('WHERE');
  });
});
