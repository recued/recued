import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { deriveSubDEK } from '@recued/crypto';
import {
  CHAT_RPC_METHODS, SERVER_RPC_METHODS, isReservedLocalRpc,
  type ChatHistoryCursor, type ChatMessageRole,
} from '@recued/contracts';
import { createChatStore, ensureChatSchema, type ChatStore } from '../storage/chat-store.js';
import { handleSessionGet, makeChatHandlers, type ChatRpcDeps } from '../chat-handler.js';
import { matchingChatSnippet, searchChatHistory } from '../chat-history-search.js';

describe('paired-owner conversation search', () => {
  let db: Database.Database;
  let store: ChatStore;
  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatSchema(db);
    const key = deriveSubDEK(new Uint8Array(32).fill(42), 'chat');
    store = createChatStore(db, () => key);
    store.createSession({ id: 'a', title: 'Weekly planning', now: 1000 });
    store.createSession({ id: 'b', title: 'Archived notes', now: 1000 });
    store.setArchived('b', true);
  });
  afterEach(() => db.close());
  const add = (id: string, content: string, role: ChatMessageRole = 'user', session_id = 'a', ts = 1000) =>
    store.appendMessage({
      id, session_id, role, content, ts, target_server: 'self',
      picker_at_send: { display_name: 'Self', signature: {
        server_kind: 'recued', version: '1.0.0', instance_id: 'search',
      } },
      model_used: { provider: 'test', model_id: 'test' },
      // No recall eligibility: legacy messages still belong to owner History.
    });
  const deps = () => ({ store }) as unknown as ChatRpcDeps;

  it('searches encrypted retained user and assistant text across chats, including legacy and archived rows', async () => {
    await add('user', 'The ＡＣＭＥ\nlaunch is Friday.');
    await add('assistant', 'The ACME launch is confirmed.', 'assistant', 'b', 2000);
    await add('tool', 'ACME launch tool payload', 'tool');
    await add('system', 'ACME launch system prompt', 'system');
    const before = store.listSessions();
    const result = await searchChatHistory(store, { query: 'acme launch' });
    expect(result).toEqual({ incomplete: false, matches: [
      { session_id: 'b', message_id: 'assistant', role: 'assistant', ts: 2000,
        title: 'Archived notes', snippet: 'The ACME launch is confirmed.' },
      { session_id: 'a', message_id: 'user', role: 'user', ts: 1000,
        title: 'Weekly planning', snippet: 'The ACME launch is Friday.' },
    ] });
    expect(store.listSessions()).toEqual(before); // Searching does not mark chats seen.
    const rows = db.prepare('SELECT content_encrypted FROM chat_messages').all() as { content_encrypted: Buffer }[];
    expect(rows.every(row => !row.content_encrypted.includes(Buffer.from('launch')))).toBe(true);
    expect(await searchChatHistory(store, { query: 'Weekly planning' })).toEqual({ matches: [], incomplete: false });
  });

  it('registers the real RPC end to end and keeps it reserved for the owner UI', async () => {
    await add('m', 'find this needle');
    const slice = makeChatHandlers(deps())!;
    expect(slice.methods).toContain('chat.messages.search');
    expect(CHAT_RPC_METHODS).toContain('chat.messages.search');
    expect(SERVER_RPC_METHODS).toContain('chat.messages.search');
    expect(isReservedLocalRpc('chat.messages.search')).toBe(true);
    const handlers = slice.handlers as unknown as Record<string,
      (args: unknown, client: { instance_id: string | null }) => Promise<unknown>>;
    await expect(handlers['chat.messages.search']!({ query: 'needle' }, { instance_id: null }))
      .rejects.toMatchObject({ code: 'unauthorized' });
    expect(await handlers['chat.messages.search']!({ query: 'needle' }, { instance_id: 'paired' }))
      .toMatchObject({ matches: [{ message_id: 'm' }] });
  });

  it('pages past a full result buffer without dropping matches, including tied timestamps', async () => {
    for (let i = 0; i < 75; i += 1) await add(`m${String(i).padStart(3, '0')}`, `needle ${i}`);
    const ids: string[] = [];
    let before: ChatHistoryCursor | undefined;
    do {
      const page = await searchChatHistory(store, { query: 'needle', ...(before ? { before } : {}) });
      expect(page.matches.length).toBeLessThanOrEqual(30);
      ids.push(...page.matches.map(match => match.message_id));
      before = page.next_cursor;
    } while (before);
    expect(ids).toEqual(Array.from({ length: 75 }, (_, i) => `m${String(74 - i).padStart(3, '0')}`));
    expect(new Set(ids).size).toBe(75);
  });

  it('continues an empty bounded scan and eventually finds an older message', async () => {
    await add('old', 'buried needle', 'user', 'b', 1);
    for (let i = 0; i < 520; i += 1) await add(`m${i}`, 'different text');
    const first = await searchChatHistory(store, { query: 'needle' }, () => 0);
    expect(first.matches).toEqual([]);
    expect(first.next_cursor).toBeDefined();
    const second = await searchChatHistory(store, { query: 'needle', before: first.next_cursor });
    expect(second.matches.map(match => match.message_id)).toEqual(['old']);
    expect(second.next_cursor).toBeUndefined();
  });

  it('selects the conversation before the scan budget and unreadable-row accounting', async () => {
    await add('old', 'buried needle', 'user', 'b', 1);
    for (let i = 0; i < 520; i++) await add(`outside${i}`, 'needle');
    db.prepare("UPDATE chat_messages SET content_encrypted = randomblob(64) WHERE session_id = 'a'").run();
    const result = await searchChatHistory(store, { query: 'needle', session_id: 'b' }, () => 0);
    expect(result).toMatchObject({ incomplete: false, matches: [{ message_id: 'old' }] });
    expect(result.next_cursor).toBeUndefined();
    expect(await searchChatHistory(store, { query: 'needle', session_id: 'deleted' })).toEqual({ matches: [], incomplete: false });
  });

  it('intersects source, vendor and current conversation without widening empty selections', async () => {
    store.createSession({ id: 'messenger:telegram:42', title: 'Renamed' });
    await add('web', 'needle');
    await add('telegram', 'needle', 'user', 'messenger:telegram:42');
    const read = () => ({ sessions: store.listSessions() });
    const search = (filters: unknown, session_id?: string) => searchChatHistory(store,
      { query: 'needle', filters, ...(session_id ? { session_id } : {}) }, () => 0, read);
    expect((await search({ vendor: 'telegram' })).matches.map(m => m.message_id)).toEqual(['telegram']);
    expect((await search({ source: 'webclient' })).matches.map(m => m.message_id)).toEqual(['web']);
    expect((await search({ vendor: 'telegram' }, 'a')).matches).toEqual([]);
    expect((await search({ vendor: 'discord' })).matches).toEqual([]);
    expect((await search({ source: 'webclient', vendor: 'telegram' })).matches).toEqual([]);
  });

  it('pages tied timestamps within the selected sessions without dropping or mixing hits', async () => {
    for (let i = 0; i < 75; i++) {
      await add(`a${String(i).padStart(3, '0')}`, 'needle');
      await add(`b${String(i).padStart(3, '0')}`, 'needle', 'user', 'b');
    }
    const ids: string[] = [];
    let before: ChatHistoryCursor | undefined;
    do {
      const result = await searchChatHistory(store, { query: 'needle', session_id: 'b', ...(before ? { before } : {}) });
      ids.push(...result.matches.map(m => m.message_id)); before = result.next_cursor;
    } while (before);
    expect(ids).toEqual(Array.from({ length: 75 }, (_, i) => `b${String(74 - i).padStart(3, '0')}`));
  });

  it('fails explicitly when filter metadata cannot be read', async () => {
    await expect(searchChatHistory(store, { query: 'needle', filters: { source: 'messenger' } }))
      .rejects.toMatchObject({ code: 'not_configured' });
    await expect(searchChatHistory(store, { query: 'needle', filters: { source: 'webclient' } }, () => 0,
      () => ({ sessions: store.listSessions(), messenger_status_available: false })))
      .rejects.toMatchObject({ code: 'unavailable' });
  });

  it('continues from the last inspected row when the time budget expires mid-batch', async () => {
    for (let i = 0; i < 10; i += 1) await add(`m${i}`, 'needle');
    let time = 0;
    const first = await searchChatHistory(store, { query: 'needle' }, () => (time += 100));
    expect(first.matches).toHaveLength(3);
    const second = await searchChatHistory(store, { query: 'needle', before: first.next_cursor });
    expect([...first.matches, ...second.matches].map(match => match.message_id))
      .toEqual(Array.from({ length: 10 }, (_, i) => `m${9 - i}`));
  });

  it('reports unreadable rows and keeps readable matches', async () => {
    await add('bad', 'needle secret');
    await add('good', 'needle survives');
    db.prepare("UPDATE chat_messages SET content_encrypted = randomblob(64) WHERE message_id = 'bad'").run();
    const result = await searchChatHistory(store, { query: 'needle' });
    expect(result.incomplete).toBe(true);
    expect(result.matches.map(match => match.message_id)).toEqual(['good']);
  });

  it('honors deletion even when a row was decrypted before the session disappeared', async () => {
    await add('m', 'needle');
    const scan = store.scanHistoryMessagesPage!.bind(store);
    const result = await searchChatHistory({
      getSession: store.getSession,
      scanHistoryMessagesPage: async input => {
        const page = await scan(input);
        store.deleteSession('a');
        return page;
      },
    }, { query: 'needle' });
    expect(result.matches).toEqual([]);
    expect((await searchChatHistory(store, { query: 'needle' })).matches).toEqual([]);
  });

  it.each([null, {}, { query: '' }, { query: '  ' }, { query: '😀'.repeat(129) },
    { query: 'a', before: { ts: 1 } }, { query: 'a', before: { ts: NaN, message_id: 'm' } },
    { query: 'a', filters: null }, { query: 'a', filters: { vendor: 'email' } },
    { query: 'a', filters: { source: 'bogus' } }, { query: 'a', filters: { needs_attention: 'true' } },
    { query: 'a', session_id: '' }, { query: 'a', session_id: 42 }, { query: 'a', session_id: 'x'.repeat(513) },
  ])('rejects invalid query/cursor %j', async args => {
    await expect(searchChatHistory(store, args)).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('places a bounded snippet around a far-away Unicode match and treats punctuation literally', () => {
    const snippet = matchingChatSnippet(`${'İ😀 '.repeat(1000)}東京支社: [Friday]. ${'tail '.repeat(1000)}`, '東京支社: [friday]');
    expect(snippet).toContain('東京支社: [Friday]');
    expect(Array.from(snippet!).length).toBeLessThanOrEqual(322);
    expect(matchingChatSnippet('Acme project launches', 'acme launches')).toBeNull();
    expect(matchingChatSnippet('hello [.*] world', '[.*]')).toBe('hello [.*] world');
  });

  it('opens a bounded window around the exact message and can page in both directions', async () => {
    for (let i = 0; i < 250; i += 1) await add(`m${String(i).padStart(3, '0')}`, `text ${i}`, 'user', 'a', i);
    const middle = await handleSessionGet(deps(), { session_id: 'a', limit: 20, around_message_id: 'm120' });
    expect(middle.messages.map(message => message.id)).toEqual(Array.from({ length: 20 }, (_, i) => `m${110 + i}`));
    expect(middle).toMatchObject({ has_more: true, has_more_after: true,
      oldest_cursor: { ts: 110, message_id: 'm110' }, newest_cursor: { ts: 129, message_id: 'm129' } });
    const newer = await handleSessionGet(deps(), { session_id: 'a', limit: 20, after: middle.newest_cursor });
    expect(newer.messages[0]?.id).toBe('m130');
    const older = await handleSessionGet(deps(), { session_id: 'a', limit: 20, before: middle.oldest_cursor });
    expect(older.messages.at(-1)?.id).toBe('m109');
    expect((await handleSessionGet(deps(), { session_id: 'a' })).messages).toHaveLength(250);
  });

  it('finds tied timestamps and single-message windows without losing either cursor', async () => {
    for (const id of ['m1', 'm2', 'm3']) await add(id, id);
    const middle = await handleSessionGet(deps(), { session_id: 'a', limit: 1, around_message_id: 'm2' });
    expect(middle.messages.map(message => message.id)).toEqual(['m2']);
    expect(middle).toMatchObject({ has_more: true, has_more_after: true });
    const last = await handleSessionGet(deps(), { session_id: 'a', limit: 1, after: middle.newest_cursor });
    expect(last.messages.map(message => message.id)).toEqual(['m3']);
    expect(last.has_more_after).toBe(false);
  });

  it('does not use an anchor from another session and rejects conflicting positions', async () => {
    await add('a1', 'own message');
    await add('b1', 'other message', 'user', 'b');
    const result = await handleSessionGet(deps(), { session_id: 'a', limit: 20, around_message_id: 'b1' });
    expect(result.messages.map(message => message.id)).toEqual(['a1']);
    await expect(handleSessionGet(deps(), { session_id: 'a', around_message_id: 'a1',
      after: { ts: 1, message_id: 'a1' } })).rejects.toMatchObject({ code: 'bad_request' });
  });
});
