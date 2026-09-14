import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createMiddlewareRegistry } from '@recued/middleware';
import { registerFirstPartyMiddlewares } from '@recued/middleware-recued';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { handleSend } from '../chat-handler.js';
import { searchChatHistory } from '../chat-history-search.js';
import { composeMessengerTurnIngest } from '../composition/bin/wire-messenger-turn.js';
import { composeInboundAnswerDispatcher } from '../composition/bin/wire-inbound-answer-dispatcher.js';
import { buildConnectionRow, encodePlaintextAuth, stubConnectionStore } from './d-163-remote-channel-test-helpers.js';

const close: Array<() => void> = [];
afterEach(() => { for (const cleanup of close.splice(0).reverse()) cleanup(); });
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'test' };
const session = 'messenger:slack:C123';
const payload = (text: string, id: string) => ({ type: 'event_callback', event_id: `Ev-${id}`,
  event: { type: 'message', channel: 'C123', user: 'U1', ts: id, text } });
const setup = () => {
  const db = new Database(':memory:'); ensureChatSchema(db);
  const key = () => new Uint8Array(32).fill(37); const store = createChatStore(db, key);
  const auth = { type: 'bearer' as const, token: 'xoxb-fixture' };
  const row = { ...buildConnectionRow({ name: 'slack', auth, config: { channel_id: 'C123' } }), auth_ciphertext: encodePlaintextAuth(auth) };
  const connectionStore = stubConnectionStore(row);
  const middlewareRegistry = createMiddlewareRegistry(); registerFirstPartyMiddlewares(middlewareRegistry);
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const prompts: string[] = []; const events: unknown[] = [];
  const raw = createChatOrchestrator({ chatStore: store, selfSignature: signature, middlewareRegistry,
    broadcast: { emit: event => { events.push(event); } },
    registry: { list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} },
    executeAiCall: async (_tool, args) => {
      prompts.push(String(args['llm.prompt'])); const n = prompts.length;
      if (n === 1) await hold;
      return { body: { response: `retained answer ${n}`, events: [], tool_calls: [] } };
    },
  });
  const orchestrator = withQueuedChatTurns(raw, { db, store, getKey: key, pollMs: 10 });
  const sent: string[] = [];
  const ingest = composeMessengerTurnIngest({ orchestrator, connectionStore, fetchImpl: async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)).text); return Response.json({ ok: true, ts: `sent-${sent.length}` });
  } })!;
  close.push(() => { release(); orchestrator.turnQueue!.close(); db.close(); });
  return { db, store, orchestrator, ingest, prompts, release, events, sent };
};

describe('D-265 production Messenger admission and retained conversations', () => {
  it('serializes native/web/native turns, keeps queued text out of earlier prompts and searches every retained answer', async () => {
    const f = setup();
    await expect(f.ingest('slack', 'slack', payload('native A secret', '1'))).resolves.toBe(true);
    await vi.waitFor(() => expect(f.prompts).toHaveLength(1));
    await handleSend({ store: f.store, orchestrator: f.orchestrator, selfSignature: signature },
      { session_id: session, message: 'web B secret', submission_id: 'web-b', picker_state: { current: 'self' } });
    await f.ingest('slack', 'slack', payload('native C secret', '3'));
    await f.ingest('slack', 'slack', payload('native C secret', '4'));
    await f.ingest('slack', 'slack', payload('native A secret', '1'));
    expect((await f.orchestrator.turnQueue!.snapshot(session)).turns.map(t => t.status)).toEqual(['running', 'queued', 'queued']);
    expect(f.prompts[0]).not.toContain('web B secret'); expect(f.prompts[0]).not.toContain('native C secret');
    expect(JSON.stringify(f.db.prepare('SELECT payload FROM chat_turn_queue').all())).not.toContain('secret');
    f.release();
    await vi.waitFor(async () => expect((await f.orchestrator.turnQueue!.snapshot(session)).turns.map(t => t.status)).toEqual(['completed', 'completed', 'completed']));
    expect(f.prompts).toHaveLength(3); expect(f.prompts[1]).toContain('retained answer 1');
    expect(f.prompts[1]).not.toContain('native C secret'); expect(f.prompts[2]).toContain('retained answer 2');
    const messages = await f.store.listMessages(session);
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_native_receipts').get()).toEqual({ n: 3 });
    expect(await f.orchestrator.turnQueue!.nativeReply(session, 'slack', '4')).toEqual({
      message_id: messages[4]!.id, role: 'user', text: 'native C secret',
    });
    const search = await searchChatHistory(f.store, { query: 'retained answer' });
    expect(search.matches.map(m => m.message_id).sort()).toEqual(messages.filter(m => m.role === 'assistant').map(m => m.id).sort());
    expect(f.events.filter(e => (e as { kind: string }).kind === 'chat.message_complete')).toHaveLength(3);
  });

  it('propagates an actual SQLite admission failure through the inbound dispatcher before acknowledgement', async () => {
    const f = setup();
    f.db.exec("CREATE TRIGGER fail_admission BEFORE INSERT ON chat_turn_queue BEGIN SELECT RAISE(ABORT, 'fixture storage unavailable'); END;");
    const dispatch = composeInboundAnswerDispatcher({ messengerTurnIngest: f.ingest,
      messengerChannels: { slack: { parseInboundReply: () => null } as never },
    }).messengerDispatchers.slack!;
    const event = { connection_name: 'slack', payload: payload('must retry', '1'), event_id: 'Ev-1' };
    await expect(dispatch(event)).rejects.toThrow('fixture storage unavailable');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_turn_submissions').get()).toEqual({ n: 0 });
    f.db.exec('DROP TRIGGER fail_admission');
    await expect(dispatch(event)).resolves.toBeUndefined();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM chat_turn_submissions').get()).toEqual({ n: 1 });
    f.release();
    await vi.waitFor(async () => expect((await f.orchestrator.turnQueue!.snapshot(session)).turns[0]?.status).toBe('completed'));
  });
});
