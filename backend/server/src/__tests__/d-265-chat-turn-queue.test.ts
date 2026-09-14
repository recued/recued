import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_RESERVED_RPC_PREFIXES, type InternalToolRegistry } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatTurnQueueStore, type QueuedChatCommand } from '../storage/chat-turn-queue-store.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createChatOrchestrator, type ChatTurnInput } from '../chat-orchestrator.js';
import { handleSend, handleSessionCreate, makeChatHandlers } from '../chat-handler.js';

const selfSignature = { server_kind: 'recued' as const, version: '1', instance_id: 'test' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const fixture = (path = ':memory:', key?: () => Uint8Array | null) => {
  const db = new Database(path); ensureChatSchema(db);
  const store = createChatStore(db, key);
  if (!store.getSession('s')) store.createSession({ id: 's' });
  const queue = createChatTurnQueueStore(db, key);
  cleanups.push(() => { if (db.open) db.close(); });
  return { db, store, queue };
};
const command = (message: string, session_id = 's'): QueuedChatCommand => ({
  family: 'chat', session_id, message,
  input: { session_id, message, picker_state: { current: 'self' } },
});
const worker = { id: 'worker', pid: 101, started_at: 1 };
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};

describe('D-265 durable admission', () => {
  it('atomically admits simultaneous A/A/A once and encrypts retained input', async () => {
    const { queue, db } = fixture(':memory:', () => new Uint8Array(32).fill(19));
    const results = await Promise.all(Array.from({ length: 20 }, () => queue.admit(command('private needle'), randomUUID())));
    expect(new Set(results.map((result) => result.turn_id)).size).toBe(1);
    expect(results.filter((result) => result.disposition === 'accepted')).toHaveLength(1);
    expect((await queue.snapshot('s')).turns[0]).toMatchObject({ message: 'private needle', duplicate_count: 19 });
    expect(JSON.stringify(db.prepare('SELECT * FROM chat_turn_queue').all())).not.toContain('private needle');
  });
  it('deduplicates completed A/A but executes A/B/A and exact retries after B join the first writer', async () => {
    const { queue } = fixture();
    const a = await queue.admit(command('A'), 'a');
    queue.claim('chat', worker); queue.settle(a.turn_id, worker.id, 'completed');
    expect(await queue.admit(command('A'), 'a2')).toMatchObject({ turn_id: a.turn_id, status: 'completed', disposition: 'duplicate' });
    const b = await queue.admit(command('B'), 'b');
    const replay = await queue.admit(command('A'), 'a');
    expect(replay).toMatchObject({ turn_id: a.turn_id, disposition: 'replayed' });
    const again = await queue.admit(command('A'), 'a3');
    expect(again.turn_id).not.toBe(a.turn_id);
    expect((await queue.snapshot('s')).turns.map((turn) => turn.turn_id)).toEqual([a.turn_id, b.turn_id, again.turn_id]);
    await expect(queue.admit(command('different'), 'a')).rejects.toThrow('different message');
  });
  it('compares execution intent, and Repeat creates one new attempt even after a failed turn', async () => {
    const { queue, store } = fixture();
    await store.appendMessage({ id: 'other-question', session_id: 's', role: 'assistant', content: 'Question',
      target_server: 'self', picker_at_send: { display_name: 'Self', signature: selfSignature },
      model_used: { provider: 'fixture', model_id: 'fixture' } });
    const a = await queue.admit(command('A'), 'a');
    queue.claim('chat', worker); queue.settle(a.turn_id, worker.id, 'failed');
    expect((await queue.admit(command('A'), 'a2')).turn_id).toBe(a.turn_id);
    const repeated = await queue.admit(command('A'), 'repeat', true);
    expect(repeated.turn_id).not.toBe(a.turn_id);
    expect((await queue.admit(command('A'), 'repeat', true)).turn_id).toBe(repeated.turn_id);
    const reply = command('A'); reply.input.reply_to_message_id = 'other-question';
    expect((await queue.admit(reply, 'different-reply')).turn_id).not.toBe(repeated.turn_id);
    const file = command('A'); file.input.attachments = [{ file_id: 'different-file', media_class: 'file' }];
    expect((await queue.admit(file, 'different-file')).disposition).toBe('accepted');
  });
  it('joins concurrent native envelopes by receipt across SQLite handles while preserving explicit Retry', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-receipt-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'queue.sqlite');
    const key = () => new Uint8Array(32).fill(23);
    const first = fixture(path, key);
    const second = fixture(path, key);
    const native = (envelope: string): QueuedChatCommand => ({ family: 'messenger', session_id: 's', message: 'native input',
      input: { payload: { envelope_id: envelope }, model_routing_snapshot: { envelope } },
      native_receipt: { vendor: 'slack', recipient: 'C1', message_id: 'M1', account: 'slack:T1:B1' },
    });
    const results = await Promise.all([first.queue.admit(native('first'), 'native:M1'), second.queue.admit(native('redelivery'), 'native:M1')]);
    expect(results.map(r => r.disposition).sort()).toEqual(['accepted', 'replayed']);
    expect(new Set(results.map(r => r.turn_id)).size).toBe(1);
    const original = results[0]!.turn_id;
    first.queue.claim('messenger', worker);
    first.queue.settle(original, worker.id, 'failed');
    const retry = await second.queue.admit(native('owner retry'), 'retry', true);
    expect(retry.disposition).toBe('accepted');
    expect(retry.turn_id).not.toBe(original);
    expect(await second.queue.admit(native('owner retry'), 'retry', true)).toMatchObject({ turn_id: retry.turn_id, disposition: 'replayed' });
    expect(await first.queue.admit(native('later redelivery'), 'native:M1')).toMatchObject({ turn_id: original, status: 'failed', disposition: 'replayed' });
    expect(first.db.prepare('SELECT turn_id FROM chat_native_receipts').all()).toEqual([{ turn_id: original }]);
    first.store.deleteSession('s'); first.store.createSession({ id: 's' });
    await expect(second.queue.admit(native('after deletion'), 'native:M1')).rejects.toThrow('conversation was removed');
  });
  it('claims one turn per session across workers, but another session progresses', async () => {
    const { queue, store } = fixture(); store.createSession({ id: 'other' });
    const a = await queue.admit(command('A'), 'a');
    await queue.admit(command('B'), 'b');
    const other = await queue.admit(command('C', 'other'), 'c');
    expect(queue.claim('chat', worker)?.turn_id).toBe(a.turn_id);
    expect(queue.claim('chat', { ...worker, id: 'second' })?.turn_id).toBe(other.turn_id);
    expect(queue.claim('chat', worker)).toBeUndefined();
    queue.settle(a.turn_id, 'wrong-owner', 'completed');
    expect(queue.get(a.turn_id)?.status).toBe('running');
  });
  it('keeps an active turn visible after more than a preview window of later cancellations', async () => {
    const { queue } = fixture(); const active = await queue.admit(command('active'), 'active');
    queue.claim('chat', worker);
    for (let i = 0; i < 140; i += 1) {
      const turn = await queue.admit(command(`cancelled ${i}`), `cancelled-${i}`);
      queue.cancel('s', turn.turn_id);
    }
    const snapshot = await queue.snapshot('s');
    expect(snapshot.turns[0]).toMatchObject({ turn_id: active.turn_id, status: 'running' });
    expect(snapshot.turns.length).toBeLessThanOrEqual(128);
  });
  it('recovers queued work and receipts across a real SQLite reopen without replaying active effects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chat-queue-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'queue.sqlite');
    const first = fixture(path);
    const a = await first.queue.admit(command('A'), 'a');
    const b = await first.queue.admit(command('B'), 'b');
    first.queue.claim('chat', worker); first.db.close();
    const second = fixture(path);
    expect(second.queue.recover(() => true)).toEqual([]);
    expect(second.queue.recover(() => false)).toEqual(['s']);
    expect(second.queue.get(a.turn_id)?.status).toBe('interrupted');
    expect(second.queue.claim('chat', { ...worker, id: 'new' })?.turn_id).toBe(b.turn_id);
    expect((await second.queue.admit(command('A'), 'a')).turn_id).toBe(a.turn_id);
  });
  it('cancel and delete are fenced; locked admission never acknowledges', async () => {
    let key: Uint8Array | null = new Uint8Array(32).fill(17);
    const { queue, store } = fixture(':memory:', () => key);
    const a = await queue.admit(command('A'), 'a');
    queue.claim('chat', worker); queue.cancel('s', a.turn_id);
    expect(queue.get(a.turn_id)?.status).toBe('cancelling');
    queue.settle(a.turn_id, worker.id, 'completed');
    expect(queue.get(a.turn_id)?.status).toBe('cancelled');
    const b = await queue.admit(command('B'), 'b'); queue.cancel('s', b.turn_id);
    expect(queue.claim('chat', worker)).toBeUndefined();
    key = null;
    await expect(queue.admit(command('C'), 'c')).rejects.toThrow('locked');
    store.deleteSession('s'); store.createSession({ id: 's' }); key = new Uint8Array(32).fill(17);
    expect(queue.get(a.turn_id)).toBeUndefined();
    expect((await queue.admit(command('A'), 'a')).turn_id).not.toBe(a.turn_id);
  });
  it('rejects a send racing deletion/recreation and a delayed client from the old generation', async () => {
    const { queue, store } = fixture();
    const generation = (await queue.snapshot('s')).generation;
    const pending = queue.admit(command('A'), 'a');
    store.deleteSession('s'); store.createSession({ id: 's' });
    await expect(pending).rejects.toThrow('changed while accepting');
    const stale = command('B'); stale.input.queue_generation = generation;
    await expect(queue.admit(stale, 'b')).rejects.toThrow('Reopen');
    expect((await queue.snapshot('s')).turns).toEqual([]);
  });
});

describe('D-265 RPC, worker and real Chat transcript composition', () => {
  const setup = () => {
    const { db, store } = fixture();
    const registry: InternalToolRegistry = { list: () => [], listByTier: () => [], getByName: () => null,
      dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} };
    const raw = createChatOrchestrator({ chatStore: store, registry,
      selfSignature: { server_kind: 'recued', version: '1', instance_id: 'test' } });
    return { db, store, raw };
  };
  it('acks before execution, keeps queued B out of A context, and returns the existing result for duplicate A', async () => {
    const { db, store, raw } = setup(); const held = gate();
    const inputs: string[] = []; const tails: string[][] = [];
    const orchestrator = withQueuedChatTurns({ ...raw, runTurn: async (input) => {
      inputs.push(input.message); tails.push((await store.listMessages(input.session_id)).map((m) => m.content));
      if (input.message === 'A') await held.promise;
      return raw.runTurn(input);
    } }, { db, store, pollMs: 20 });
    cleanups.push(() => orchestrator.turnQueue!.close());
    const deps = { store, orchestrator, selfSignature };
    const send = (message: string, submission_id: string) => handleSend(deps, { session_id: 's', message, submission_id, picker_state: { current: 'self' } });
    const a = await send('A', 'a'); await vi.waitFor(() => expect(inputs).toEqual(['A']));
    expect(await send('A', 'a2')).toMatchObject({ turn_id: a.turn_id, disposition: 'duplicate' });
    const b = await send('B', 'b');
    expect((await store.listMessages('s')).length).toBe(0);
    expect((await orchestrator.turnQueue!.snapshot('s')).turns.map((t) => t.status)).toEqual(['running', 'queued']);
    held.release();
    await vi.waitFor(async () => expect((await orchestrator.turnQueue!.snapshot('s')).turns.map((t) => t.status)).toEqual(['completed', 'completed']));
    expect(inputs).toEqual(['A', 'B']); expect(tails[1]).toEqual(['A', '']);
    expect((await store.listMessages('s')).map((m) => m.turn_id)).toEqual([a.turn_id, a.turn_id, b.turn_id, b.turn_id]);
    expect(makeChatHandlers(deps)?.methods).toEqual(expect.arrayContaining(['chat.turns.list', 'chat.turn.cancel', 'chat.turn.retry']));
  });
  it('recovers a failed terminal write as interrupted without executing the command again', async () => {
    const { db, store, raw } = setup(); const executed: string[] = [];
    const orchestrator = withQueuedChatTurns({ ...raw, runTurn: async input => {
      executed.push(input.message);
      db.exec("CREATE TRIGGER reject_terminal BEFORE UPDATE OF status ON chat_turn_queue WHEN NEW.status != 'running' BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
      return { turn_id: input.queue_turn_id! };
    } }, { db, store, pollMs: 5 });
    cleanups.push(() => orchestrator.turnQueue!.close());
    await orchestrator.turnQueue!.submit(command('run once'), 'once');
    await vi.waitFor(() => expect(executed).toEqual(['run once']));
    db.exec('DROP TRIGGER reject_terminal');
    await vi.waitFor(async () => expect((await orchestrator.turnQueue!.snapshot('s')).turns[0]?.status).toBe('interrupted'));
    expect(executed).toEqual(['run once']);
  });
  it('pins routing at admission while an identical submission ID survives a default change', async () => {
    const { db, store, raw } = setup(); const held = gate();
    const observed: Array<ChatTurnInput['model_routing_snapshot']> = [];
    store.setModelPref('s', { current: 'byok', source_id: 'slot_1', overridden: true });
    const orchestrator = withQueuedChatTurns({ ...raw, runTurn: async (input) => {
      await held.promise; observed.push(input.model_routing_snapshot); return raw.runTurn(input);
    } }, { db, store, pollMs: 20 });
    cleanups.push(() => orchestrator.turnQueue!.close());
    const deps = { store, orchestrator, selfSignature };
    const payload = { session_id: 's', message: 'A', submission_id: 'same', picker_state: { current: 'self' as const } };
    const first = await handleSend(deps, payload);
    store.setModelPref('s', { current: 'byok', source_id: 'slot_2', overridden: true });
    expect(await handleSend(deps, payload)).toMatchObject({ turn_id: first.turn_id, disposition: 'replayed' });
    held.release();
    await vi.waitFor(() => expect(observed).toHaveLength(1));
    expect(observed[0]?.source_id).toBe('slot_1');
  });
  it('cancel bypasses queued work and fences a late active result', async () => {
    const { db, store, raw } = setup(); const held = gate(); let entered = false;
    const orchestrator = withQueuedChatTurns({ ...raw, runTurn: async (input: ChatTurnInput) => {
      entered = true; await held.promise; return raw.runTurn(input);
    } }, { db, store, pollMs: 20 });
    cleanups.push(() => orchestrator.turnQueue!.close());
    const a = await handleSend({ store, orchestrator, selfSignature }, { session_id: 's', message: 'A', submission_id: 'a', picker_state: { current: 'self' } });
    await vi.waitFor(() => expect(entered).toBe(true));
    await orchestrator.turnQueue!.cancel('s', a.turn_id); held.release();
    await vi.waitFor(async () => expect((await orchestrator.turnQueue!.snapshot('s')).turns[0]?.status).toBe('cancelled'));
    expect(await store.listMessages('s')).toEqual([]);
  });
  it('retries lazy session creation without creating a second conversation and reserves queue RPCs from MCP', async () => {
    const { store, raw } = setup(); const creation_id = randomUUID(); const deps = { store, orchestrator: raw, selfSignature };
    const first = await handleSessionCreate(deps, { title: 'New conversation', creation_id });
    expect(await handleSessionCreate(deps, { title: 'New conversation', creation_id })).toEqual(first);
    expect(store.listSessions()).toHaveLength(2);
    for (const method of ['chat.turns.list', 'chat.turn.cancel', 'chat.turn.retry']) {
      expect(MCP_RESERVED_RPC_PREFIXES.some((prefix) => method.startsWith(prefix))).toBe(true);
    }
  });
});
