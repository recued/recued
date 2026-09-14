import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMiddlewareRegistry } from '@recued/middleware';
import { registerFirstPartyMiddlewares } from '@recued/middleware-recued';
import type { ChatReplyReference, ChatMessageRole } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { handleSend, handleSessionGet } from '../chat-handler.js';
import { createChatMessengerBridge } from '../chat-messenger-bridge.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'quoted-replies' };
const fixture = () => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  let key: Uint8Array | null = new Uint8Array(32).fill(47);
  const getKey = () => key;
  const store = createChatStore(db, getKey); store.createSession({ id: 's' });
  const middlewareRegistry = createMiddlewareRegistry(); registerFirstPartyMiddlewares(middlewareRegistry);
  const prompts: string[] = [];
  let gate: Promise<void> | undefined; let release = () => {}; let active = 0;
  const raw = createChatOrchestrator({ chatStore: store, selfSignature: signature, middlewareRegistry,
    registry: { list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} },
    executeAiCall: async (_tool, args) => {
      prompts.push(String(args['llm.prompt'])); active++;
      try { const held = gate; gate = undefined; await held;
        return { body: { response: `answer ${prompts.length}`, events: [], tool_calls: [] } };
      } finally { active--; }
    },
  });
  const orchestrator = withQueuedChatTurns(raw, { db, store, getKey, pollMs: 5 });
  cleanups.push(async () => { orchestrator.turnQueue!.close(); release();
    await vi.waitFor(() => expect(active).toBe(0)); db.close(); });
  const deps = { store, orchestrator, selfSignature: signature };
  let nextTs = Date.now();
  const add = (id: string, content: string, reply_to?: ChatReplyReference, role: ChatMessageRole = 'assistant', session_id = 's') =>
    store.appendMessage({ id, session_id, role, content, target_server: 'self', ts: nextTs++,
      picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'fixture', model_id: 'fixture' },
      ...(reply_to ? { reply_to } : {}),
    });
  const send = (message: string, submission_id: string, reply_to_message_id?: string) => handleSend(deps, {
    session_id: 's', message, submission_id, picker_state: { current: 'self' },
    ...(reply_to_message_id ? { reply_to_message_id } : {}),
  });
  return { db, store, deps, getKey, add, send, prompts, orchestrator,
    lock: () => { key = null; },
    hold: () => { gate = new Promise<void>(resolve => { release = resolve; }); }, release: () => release(),
  };
};

describe('retained quoted replies', () => {
  it('encrypts references, rebuilds previews outside a history window and survives store recreation', async () => {
    const f = fixture(); const original = '<script>private original</script> ' + '😀'.repeat(300);
    await f.add('original', original);
    for (let i = 0; i < 120; i++) await f.add(`middle-${i}`, `middle ${i}`);
    const reply = await f.add('reply', 'yes', { message_id: 'original' }, 'user');
    expect(reply.reply_to?.preview?.text).toContain('<script>private original</script>');
    expect(Array.from(reply.reply_to!.preview!.text)).toHaveLength(241);
    const metadata = f.db.prepare("SELECT metadata_blob FROM chat_messages WHERE message_id = 'reply'").get();
    expect(JSON.stringify(metadata)).not.toContain('original');
    expect(JSON.stringify(metadata)).not.toContain('private');
    const reopened = createChatStore(f.db, f.getKey);
    const page = await reopened.listMessagePage('s', 1);
    expect(page.messages).toHaveLength(1); expect(page.has_more).toBe(true);
    expect(page.messages[0]?.reply_to).toEqual(reply.reply_to);
    expect(page.messages[0]?.content).toBe('yes');
    expect(await handleSessionGet(f.deps, { session_id: 's', limit: 1 })).toMatchObject({ quoted_replies_available: true });
  });

  it('does not recurse through replies or copy quote text into the searchable message body', async () => {
    const f = fixture(); await f.add('a', 'private oldest question');
    await f.add('b', 'middle answer', { message_id: 'a' });
    const reply = await f.add('c', 'yes', { message_id: 'b' }, 'user');
    expect(reply.reply_to).toEqual({ message_id: 'b', preview: { role: 'assistant', text: 'middle answer' } });
    expect(reply.content).toBe('yes');
  });

  it('keeps missing native and removed retained targets explicit', async () => {
    const f = fixture(); await f.add('original', 'question');
    await f.add('reply', 'yes', { message_id: 'original' }, 'user');
    await f.add('native', 'native reply', { vendor: 'telegram', native_message_id: '123' }, 'user');
    f.db.prepare('DELETE FROM chat_messages WHERE message_id = ?').run('original');
    expect((await f.store.listMessages('s')).map(message => message.reply_to)).toEqual([
      { message_id: 'original' }, { vendor: 'telegram', native_message_id: '123' },
    ]);
  });

  it('never resolves a foreign conversation or tool message as a quote', async () => {
    const f = fixture(); f.store.createSession({ id: 'other' });
    await f.add('foreign', 'foreign private body', undefined, 'assistant', 'other');
    await f.add('tool', 'private tool details', undefined, 'tool');
    for (const id of ['foreign', 'tool']) {
      const reply = await f.add(`reply-${id}`, 'yes', { message_id: id }, 'user');
      expect(reply.reply_to).toEqual({ message_id: id });
      await expect(f.send('no', `attempt-${id}`, id)).rejects.toThrow('no longer available');
    }
    expect(f.prompts).toEqual([]);
    expect((await f.orchestrator.turnQueue!.snapshot('s')).turns).toEqual([]);
  });

  it('binds encrypted references to their message and refuses reads while locked', async () => {
    const f = fixture(); await f.add('a', 'question a'); await f.add('b', 'question b');
    await f.add('ra', 'yes', { message_id: 'a' }, 'user'); await f.add('rb', 'yes', { message_id: 'b' }, 'user');
    f.db.exec("UPDATE chat_messages SET metadata_blob = (SELECT metadata_blob FROM chat_messages WHERE message_id = 'ra') WHERE message_id = 'rb'");
    expect((await f.store.listMessagePage('s', 1)).messages[0]?.reply_to).toBeUndefined();
    f.lock(); await expect(f.store.listMessages('s')).rejects.toThrow('locked');
  });

  it('deduplicates the same target and runs identical text aimed at different questions separately', async () => {
    const f = fixture(); await f.add('q1', 'First question'); await f.add('q2', 'Second question');
    const first = await f.send('yes', 'a', 'q1');
    const second = await f.send('yes', 'b', 'q2');
    const duplicate = await f.send('yes', 'c', 'q2');
    expect(second.turn_id).not.toBe(first.turn_id); expect(duplicate.turn_id).toBe(second.turn_id);
    await vi.waitFor(async () => expect((await f.orchestrator.turnQueue!.snapshot('s')).turns.map(turn => turn.status))
      .toEqual(['completed', 'completed']));
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts.map(prompt => JSON.parse(JSON.parse(prompt).user_message))).toEqual([
      { reply_to: { message_id: 'q1', role: 'assistant', text: 'First question' }, message: 'yes' },
      { reply_to: { message_id: 'q2', role: 'assistant', text: 'Second question' }, message: 'yes' },
    ]);
    expect((await f.store.listMessages('s')).filter(message => message.role === 'user').map(message => message.reply_to))
      .toEqual([{ message_id: 'q1', preview: { role: 'assistant', text: 'First question' } },
        { message_id: 'q2', preview: { role: 'assistant', text: 'Second question' } }]);
  });

  it('keeps an accepted reply visible when its target disappears before the queued turn starts', async () => {
    const f = fixture(); await f.add('original', 'question'); f.hold();
    await f.send('hold this turn', 'hold'); await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    const reply = await f.send('yes', 'reply', 'original');
    f.db.prepare('DELETE FROM chat_messages WHERE message_id = ?').run('original'); f.release();
    await vi.waitFor(async () => expect((await f.orchestrator.turnQueue!.snapshot('s')).turns.find(turn => turn.turn_id === reply.turn_id)?.status).toBe('failed'));
    expect(f.prompts).toHaveLength(1);
    const retained = (await f.store.listMessages('s')).find(message => message.content === 'yes')!;
    expect(retained.reply_to).toEqual({ message_id: 'original' });
    expect(f.db.prepare('SELECT source_lifecycle FROM chat_messages WHERE message_id = ?').get(retained.id))
      .toEqual({ source_lifecycle: 'failed' });
    expect(await f.send('yes', 'reply', 'original')).toMatchObject({ turn_id: reply.turn_id, disposition: 'replayed' });
    expect(await f.send('yes', 'duplicate', 'original')).toMatchObject({ turn_id: reply.turn_id, disposition: 'duplicate' });
    await expect(f.send('different text', 'new-reply', 'original')).rejects.toThrow('no longer available');
    await expect(f.send('changed text', 'reply', 'original')).rejects.toThrow('different message');
    expect(f.prompts).toHaveLength(1);
  });

  it('blocks delivery to an unmirrored target and can deliver a retained reply without queue metadata', async () => {
    const f = fixture(); await f.add('historical', 'not mirrored');
    const bridge = createChatMessengerBridge({ db: f.db, store: f.store, getKey: f.getKey, pollMs: 5, minSendIntervalMs: 0 });
    cleanups.push(() => bridge.close()); bridge.bind('slack', 'C123', 'slack:T:B', 's');
    const sends: import('@recued/transport').OutboundMessage[] = [];
    bridge.register('slack', { resolve: async () => ({ token: 'fixture', recipient: 'C123', account: 'slack:T:B' }),
      send: async message => { sends.push(message); return { ok: true, vendor_message_id: `posted-${sends.length}` }; },
    });
    await f.add('reply-missing', 'yes', { message_id: 'historical' }, 'user');
    await vi.waitFor(async () => expect((await bridge.snapshot('s')).deliveries[0]?.state).toBe('failed'));
    expect(sends).toEqual([]);
    const blocked = (await bridge.snapshot('s')).deliveries[0]!;
    expect(blocked.error).toBe('reply_target_unavailable');
    bridge.act('s', blocked.delivery_id, 'skip', 'skip');
    await f.add('confirmed', 'mirrored question');
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await vi.waitFor(async () => expect((await bridge.snapshot('s')).deliveries.find(row => row.message_id === 'confirmed')?.state).toBe('sent'));
    await f.add('reply-confirmed', 'yes', { message_id: 'confirmed' }, 'user');
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ reply_to_message_id: 'posted-1', thread_id: 'posted-1' });
    expect(f.prompts).toEqual([]);
  });
});
