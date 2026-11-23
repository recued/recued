/** D-406 slice 1 — an email the owner picked for a chat message: the message names it by its mailbox and record
 *  id (P2), the turn reads it with `mail.read` by that id before its first round as a call of its own (P3), and
 *  every `mail.read` says the message's place in its thread (P4, Q3). Through `chat.send`, the real orchestrator
 *  and its executor and the real chat store, with a scripted model; the thread's place through real tables. */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AIOutput,
  ChatDispatchContext,
  ChatDispatchResult,
  ChatMailRef,
  ChatMailRefInput,
  CollectionRecord,
  InternalToolRegistry,
  RecuedServerSignature,
  ToolEntry,
} from '@recued/contracts';

import { handleSend } from '../chat-handler.js';
import { createChatOrchestrator, type ChatTurnInput } from '../chat-orchestrator.js';
import { pickedMailNote, pickedMailReads } from '../chat-picked-mail.js';
import type { ChatToolHandlerDeps } from '../chat-tool-handlers.js';
import { createCollectionTable } from '../collections/table.js';
import { createMailReadHandler } from '../mail-read-tool.js';
import { createChatStore, ensureChatSchema, type ChatStore } from '../storage/chat-store.js';

const signature: RecuedServerSignature = { server_kind: 'recued', version: '1.0.0', instance_id: 'inst-test' };
const ownerCtx = { channel: 'internal_function_call', session_id: 's', turn_id: 't',
  execution_source: { channel: 'chat', actor: 'user_self', chat_session_id: 's', user_id: 'owner' } } as ChatDispatchContext;

const mail = (record_id: string, received_at: number, thread_id?: string): CollectionRecord => ({
  record_id, source_id: `src-${record_id}`, received_at, modified_at: received_at, size_bytes: 40,
  hot_fields: { from: 'Anna Keller <anna@example.com>', subject: 'Lease renewal', ...(thread_id !== undefined ? { thread_id } : {}) },
  body_inline: `Body of ${record_id}`,
});

describe('a message\'s place in its thread', () => {
  const tables = () => {
    const db = new Database(':memory:');
    const gmail = createCollectionTable({ db, platform: 'mail', slug: 'gmail' });
    const work = createCollectionTable({ db, platform: 'mail', slug: 'work' });
    for (const record of [mail('t-3', 30, 'T'), mail('t-1', 10, 'T'), mail('t-2b', 20, 'T'), mail('t-2a', 20, 'T'), mail('alone', 5),
      mail('other', 15, 'U')]) gmail.upsert(record);
    work.upsert(mail('w-1', 1, 'T'));
    return { gmail, work };
  };

  it('oldest first, 1-based, ties by record id; one with no thread is its thread alone; within its own mailbox', () => {
    const { gmail, work } = tables();
    expect(['t-1', 't-2a', 't-2b', 't-3'].map((id) => gmail.threadPlace(id))).toEqual([
      { index: 1, total: 4 }, { index: 2, total: 4 }, { index: 3, total: 4 }, { index: 4, total: 4 },
    ]);
    expect(gmail.threadPlace('alone')).toEqual({ index: 1, total: 1 });
    expect(gmail.threadPlace('other')).toEqual({ index: 1, total: 1 });
    // The same thread id in another mailbox is that mailbox's thread.
    expect(work.threadPlace('w-1')).toEqual({ index: 1, total: 1 });
    expect(gmail.threadPlace('nothing')).toBeNull();
  });

  it('every mail.read carries it; a mailbox that cannot say leaves it out', async () => {
    const { gmail } = tables();
    const registry = { get: (_platform: string, slug: string) => (slug === 'gmail' ? gmail : slug === 'plain'
      ? { get: gmail.get } : undefined) };
    const read = createMailReadHandler({ getCollectionRegistry: () => registry } as unknown as ChatToolHandlerDeps);
    const result = await read({ slug: 'gmail', record_id: 't-2a' }, ownerCtx) as { ok: true; result: Record<string, unknown> };
    expect(result.result).toMatchObject({ status: 'read', thread: { index: 2, total: 4 } });
    // The wording measured live (2026-11-19): the thread is its own thread, listed by its thread_id; near_id's
    // results are not the thread unless their thread_id matches; and an email last in its thread may still have a
    // reply outside it. "Its conversation" + near_id had the model call another thread's email part of this one,
    // and "2 of 2" alone had it answer that nobody replied without looking.
    const hint = String(result.result.hint);
    expect(hint).toContain('thread is this message\'s place in its own thread, by thread_id');
    expect(hint).toContain('mail.search with filters.thread_id lists that thread');
    expect(hint).toContain('near_id also returns other mail between the same people, so call a result part of this thread only when its thread_id matches');
    expect(hint).toContain('being last in it does not mean nobody replied');
    expect(hint).not.toContain('its conversation');
    const plain = await read({ slug: 'plain', record_id: 't-2a' }, ownerCtx) as { ok: true; result: Record<string, unknown> };
    expect(plain.result.status).toBe('read');
    expect(plain.result).not.toHaveProperty('thread');
  });
});

describe('the picked-mail line', () => {
  it('names each pick\'s place in its own thread, and sends the model to no conversation for it', () => {
    for (const count of [1, 2]) {
      expect(pickedMailNote(count)).toContain('place in its own thread');
      expect(pickedMailNote(count)).not.toMatch(/conversation|near_id/u);
    }
  });
});

describe('picked emails on the stored message', () => {
  it('kept with the message, encrypted as its text is, and read back', async () => {
    const db = new Database(':memory:');
    ensureChatSchema(db);
    const store = createChatStore(db);
    store.createSession({ id: 's', now: 1_000 });
    const refs: ChatMailRef[] = [{ slug: 'gmail', record_id: 't-2a', from: 'Anna Keller <anna@example.com>', subject: 'Lease renewal', received_at: 20 }];
    await store.appendMessage({ id: 'u1', session_id: 's', role: 'user', content: 'Summarize it', ts: 1_001, target_server: 'self',
      picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'test', model_id: 'test' }, mail_refs: refs });
    expect((await store.listMessages('s'))[0]?.mail_refs).toEqual(refs);
    const raw = db.prepare('SELECT metadata_blob FROM chat_messages WHERE message_id = ?').get('u1') as { metadata_blob: string };
    expect(raw.metadata_blob).toContain('mail_refs_encrypted');
    expect(raw.metadata_blob).not.toContain('Lease renewal');
  });
});

const TOOLS: ToolEntry[] = ['mail.read', 'mail.search'].map((name) => ({
  name, tier: 1, description: name, arg_schema: { type: 'object' }, topic_tags: ['read'], classification: 'read', concurrency_safe: true,
}) as ToolEntry);
const READ: ChatDispatchResult = { ok: true, result: { status: 'read', slug: 'gmail', record_id: 't-2a', body: 'Your lease ends on 31 January.',
  thread: { index: 2, total: 4 } } };
const SWITCHED_OFF: ChatDispatchResult = { ok: true, result: { status: 'unavailable', hint: 'Reading the mail collection is turned off.' },
  fixes: [{ kind: 'switch', entry_key: 'data.mail', label: 'Read your mail' }] };
const PICK: ChatMailRefInput = { slug: 'gmail', record_id: 't-2a' };
const FOUND: ChatMailRef = { ...PICK, from: 'Anna Keller <anna@example.com>', subject: 'Lease renewal', received_at: 20 };

let store: ChatStore;
beforeEach(() => {
  const db = new Database(':memory:');
  ensureChatSchema(db);
  store = createChatStore(db);
  store.createSession({ id: 's', now: 1_000 });
});

/** `chat.send` over the real orchestrator: a model that answers at once; every call dispatched, and every input
 *  the model is sent, kept. */
/** `pickedMail`: the server's check of each pick (by default, each pick as stored); null: a server without one. */
const chat = (answer: ChatDispatchResult = READ,
  pickedMail: ((ref: ChatMailRefInput) => ChatMailRef | null) | null = (ref) => ({ ...FOUND, ...ref })) => {
  const inputs: string[] = [];
  const dispatched: Array<{ name: string; args: unknown }> = [];
  const registry: InternalToolRegistry = {
    list: () => TOOLS,
    listByTier: (tier) => (tier === 1 ? TOOLS : []),
    getByName: (name) => TOOLS.find((tool) => tool.name === name) ?? null,
    dispatch: async (name, args) => { dispatched.push({ name, args }); return answer; },
    subscribeRefresh: () => () => undefined,
  };
  let n = 0;
  const real = createChatOrchestrator({
    chatStore: store, registry, broadcast: { emit: () => undefined }, selfSignature: signature, mintId: () => `id-${String(++n)}`,
    executeAiCall: async (_manifest, input) => {
      inputs.push(JSON.stringify(input));
      const body: AIOutput = { response: 'Anna says the lease ends on 31 January.', events: [], tool_calls: [] };
      return { body };
    },
  });
  const turns: Array<Promise<unknown>> = [];
  const orchestrator = { ...real, runTurn: (input: ChatTurnInput) => { const turn = real.runTurn(input); turns.push(turn); return turn; } };
  const send = async (args: { message: string; mail_refs?: unknown }) => {
    await handleSend({ store, orchestrator, selfSignature: signature, ...(pickedMail !== null ? { pickedMail } : {}) } as never,
      { session_id: 's', picker_state: { current: 'self' }, ...args });
    await Promise.all(turns);
    const messages = await store.listMessages('s');
    return { user: messages.find((m) => m.role === 'user'), answer: messages.filter((m) => m.role === 'assistant').at(-1) };
  };
  return { send, inputs, dispatched };
};

describe('D-406 slice 1 — a picked email, read before the turn\'s first round', () => {
  it('the message keeps it; mail.read by its id runs first, as a call of the turn, and the model is told it is there', async () => {
    const { send, inputs, dispatched } = chat();
    const { user, answer } = await send({ message: 'Summarize this email for me.', mail_refs: [PICK] });
    expect(user?.mail_refs).toEqual([FOUND]);
    expect(dispatched).toEqual([{ name: 'mail.read', args: { slug: 'gmail', record_id: 't-2a' } }]);
    // The model's first input already holds the read, and one line about it.
    expect(inputs[0]).toContain('Your lease ends on 31 January.');
    expect(inputs[0]).toContain(pickedMailNote(1).slice(0, 60));
    // It is recorded as a call of the turn, on the answer.
    expect(answer?.tool_calls?.map((call) => call.tool_name)).toContain('mail.read');
  });

  it('several picked: each read, side by side; a message with picks and no words is a turn', async () => {
    const { send, dispatched, inputs } = chat();
    await send({ message: '', mail_refs: [PICK, { slug: 'gmail', record_id: 't-3' }] });
    expect(dispatched.map((call) => call.args)).toEqual([{ slug: 'gmail', record_id: 't-2a' }, { slug: 'gmail', record_id: 't-3' }]);
    expect(inputs[0]).toContain(pickedMailNote(2).slice(0, 50));
  });

  it('⛔ the owner\'s switch holds (Q2): the read says it is off, and its row comes under the answer', async () => {
    const { send, dispatched } = chat(SWITCHED_OFF);
    const { answer } = await send({ message: 'Summarize this email for me.', mail_refs: [PICK] });
    expect(dispatched).toHaveLength(1);
    expect(answer?.fixes).toEqual([{ kind: 'switch', entry_key: 'data.mail', label: 'Read your mail' }]);
  });

  it('⛔ refused in words, never dropped: an email no longer there, too many, a malformed one, a server that cannot read one', async () => {
    await expect(chat(READ, () => null).send({ message: 'x', mail_refs: [PICK] })).rejects.toThrow('no longer in its mailbox');
    const four = ['a', 'b', 'c', 'd'].map((record_id) => ({ slug: 'gmail', record_id }));
    await expect(chat().send({ message: 'x', mail_refs: four })).rejects.toThrow('at most 3');
    await expect(chat().send({ message: 'x', mail_refs: [{ slug: 'gmail' }] })).rejects.toThrow('not one');
    await expect(chat(READ, null).send({ message: 'x', mail_refs: [PICK] })).rejects.toThrow('cannot read a picked email');
    expect(await store.listMessages('s')).toEqual([]);
  });

  it('a message with no pick reads nothing first, and tells the model nothing', async () => {
    const { send, dispatched, inputs } = chat();
    const { user } = await send({ message: 'Hello' });
    expect(dispatched).toEqual([]);
    expect(user).not.toHaveProperty('mail_refs');
    expect(inputs[0]).not.toContain('The owner picked');
  });
});

describe('who may pick', () => {
  it('the pickedMail check is asked once per pick, before the turn', async () => {
    const pickedMail = vi.fn((ref: ChatMailRefInput) => ({ ...FOUND, ...ref }));
    await chat(READ, pickedMail).send({ message: 'x', mail_refs: [PICK, { slug: 'gmail', record_id: 't-3' }] });
    expect(pickedMail.mock.calls.map(([ref]) => ref)).toEqual([PICK, { slug: 'gmail', record_id: 't-3' }]);
  });
});

describe('which turns read the picks first', () => {
  const OWNER_TURN = { picker_target: 'self', execution_source: { channel: 'chat', actor: 'user_self' }, mail_refs: [FOUND] };
  it('the owner\'s own chat turn that opened with them, answered by their own model: each pick, by its id', () => {
    expect(pickedMailReads(OWNER_TURN)).toEqual([{ slug: 'gmail', record_id: 't-2a' }]);
    expect(pickedMailReads({ ...OWNER_TURN, mail_refs: [] })).toEqual([]);
  });

  it('⛔ none for another picker\'s model, another channel or actor, mail work, a retry, a continuation, held results', () => {
    for (const turn of [
      { ...OWNER_TURN, picker_target: 'connection.mcp.peer' },
      { ...OWNER_TURN, execution_source: { channel: 'messenger', actor: 'user_self' } },
      { ...OWNER_TURN, execution_source: { channel: 'chat', actor: 'ai_agent' } },
      { ...OWNER_TURN, mail_work: { seeds: [] } },
      { ...OWNER_TURN, retry_of_plan_id: 'plan-1' },
      { ...OWNER_TURN, continuation_of_turn_id: 'turn-1' },
      { ...OWNER_TURN, held_results: [] },
    ]) expect(pickedMailReads(turn)).toEqual([]);
  });
});
