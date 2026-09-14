import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_RESERVED_RPC_PREFIXES } from '@recued/contracts';
import { createChatStore, ensureChatSchema } from '../storage/chat-store.js';
import { createChatTurnQueueStore, type QueuedChatCommand } from '../storage/chat-turn-queue-store.js';
import { withQueuedChatTurns } from '../chat-turn-queue.js';
import { createChatOrchestrator } from '../chat-orchestrator.js';
import { handleSend, makeChatHandlers } from '../chat-handler.js';
import { createChatMessengerBridge } from '../chat-messenger-bridge.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const signature = { server_kind: 'recued' as const, version: '1', instance_id: 'test' };
const fixture = (path = ':memory:', getKey?: () => Uint8Array | null) => {
  const db = new Database(path); ensureChatSchema(db);
  const store = createChatStore(db, getKey);
  if (!store.getSession('s')) store.createSession({ id: 's' });
  cleanup.push(() => { if (db.open) db.close(); });
  return { db, store, queue: createChatTurnQueueStore(db, getKey) };
};
const command = (message = 'Original message'): QueuedChatCommand => ({ family: 'chat', session_id: 's', message,
  input: { session_id: 's', message, picker_state: { current: 'self' } } });
const worker = { id: 'worker', pid: process.pid, started_at: 1 };

describe('Withdraw to edit', () => {
  it('retains encrypted evidence, restores complete text/files/reply and replays after SQLite reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'withdraw-edit-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'queue.sqlite'); const key = () => new Uint8Array(32).fill(23);
    const first = fixture(path, key);
    await first.store.appendMessage({ id: 'target', session_id: 's', role: 'assistant', content: 'Question',
      target_server: 'self', picker_at_send: { display_name: 'Self', signature }, model_used: { provider: 'test', model_id: 'test' } });
    const input = command('private text '.repeat(180));
    input.input.attachments = [{ file_id: 'file:finalized', media_class: 'image' }];
    input.input.reply_to_message_id = 'target';
    const accepted = await first.queue.admit(input, 'send');
    const payload = first.queue.get(accepted.turn_id)!.payload;
    const draft = await first.queue.withdraw('s', accepted.turn_id);
    expect(draft).toEqual({ session_id: 's', turn_id: accepted.turn_id, message: input.message,
      attachments: input.input.attachments, reply_to_message_id: 'target' });
    expect(first.queue.get(accepted.turn_id)).toMatchObject({ status: 'withdrawn', payload });
    expect(payload).not.toContain('private text');
    expect(first.queue.claim('chat', worker)).toBeUndefined();
    expect(await first.store.listMessages('s')).toHaveLength(1);
    const revision = (await first.queue.snapshot('s')).revision;
    first.db.close();
    const second = fixture(path, key);
    expect(await second.queue.withdraw('s', accepted.turn_id)).toEqual(draft);
    expect((await second.queue.snapshot('s')).revision).toBe(revision);
    expect(await second.queue.admit(input, 'send')).toMatchObject({ turn_id: accepted.turn_id, status: 'withdrawn', disposition: 'replayed' });
    const resent = await second.queue.admit(input, 'new-send');
    expect(resent).toMatchObject({ status: 'queued', disposition: 'accepted' });
    expect(resent.turn_id).not.toBe(accepted.turn_id);
  });

  it('withdraws once across SQLite clients and all deduplicated submissions remain withdrawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'withdraw-race-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'queue.sqlite'); const a = fixture(path); const b = fixture(path);
    const first = await a.queue.admit(command(), 'a');
    await b.queue.admit(command(), 'b'); await a.queue.admit(command(), 'c');
    const revision = (await a.queue.snapshot('s')).revision;
    const results = await Promise.all([a.queue.withdraw('s', first.turn_id), b.queue.withdraw('s', first.turn_id)]);
    expect(results[0]).toEqual(results[1]);
    expect((await b.queue.snapshot('s')).revision).toBe(revision + 1);
    expect(await a.queue.admit(command(), 'b')).toMatchObject({ status: 'withdrawn', disposition: 'replayed' });
    expect(b.queue.claim('chat', worker)).toBeUndefined();
  });

  it('rejects withdrawal if the worker claims during payload decryption', async () => {
    const { queue } = fixture(':memory:', () => new Uint8Array(32).fill(3));
    const accepted = await queue.admit(command(), 'a');
    const withdrawing = queue.withdraw('s', accepted.turn_id);
    expect(queue.claim('chat', worker)?.turn_id).toBe(accepted.turn_id);
    await expect(withdrawing).rejects.toThrow('no longer queued');
    expect(queue.get(accepted.turn_id)?.status).toBe('running');
  });

  it.each(['running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'])('never unlocks an %s turn', async status => {
    const { queue, db } = fixture(); const turn = await queue.admit(command(), 'a');
    db.prepare('UPDATE chat_turn_queue SET status = ? WHERE turn_id = ?').run(status, turn.turn_id);
    await expect(queue.withdraw('s', turn.turn_id)).rejects.toThrow('no longer queued');
    expect(queue.get(turn.turn_id)?.status).toBe(status);
    expect((await queue.snapshot('s')).turns[0]?.withdraw_to_edit_available).toBeUndefined();
  });

  it('does not withdraw corrupt, locked, deleted or cross-session input', async () => {
    let key: Uint8Array | null = new Uint8Array(32).fill(5);
    const { queue, store, db } = fixture(':memory:', () => key);
    const turn = await queue.admit(command(), 'a');
    await expect(queue.withdraw('other', turn.turn_id)).rejects.toThrow('not found');
    const pending = queue.withdraw('s', turn.turn_id); key = null;
    await expect(pending).rejects.toThrow('vault');
    expect(queue.get(turn.turn_id)?.status).toBe('queued');
    key = new Uint8Array(32).fill(5);
    const payload = queue.get(turn.turn_id)!.payload;
    db.prepare('UPDATE chat_turn_queue SET payload = ? WHERE turn_id = ?').run('corrupt', turn.turn_id);
    await expect(queue.withdraw('s', turn.turn_id)).rejects.toThrow();
    expect(queue.get(turn.turn_id)?.status).toBe('queued');
    db.prepare('UPDATE chat_turn_queue SET payload = ? WHERE turn_id = ?').run(payload, turn.turn_id);
    const deleted = queue.withdraw('s', turn.turn_id); store.deleteSession('s'); store.createSession({ id: 's' });
    await expect(deleted).rejects.toThrow('no longer available');
    expect(queue.get(turn.turn_id)).toBeUndefined();
  });

  it('does not flatten native ingestion or structured execution into a text draft', async () => {
    const { queue } = fixture();
    for (const input of [{ ...command(), family: 'messenger' },
      ...['data_diagnosis', 'retry_of_plan_id', 'continuation_of_turn_id', 'future_intent'].map(key => {
        const c = command(); c.input[key] = 'structured'; return c;
      })]) {
      const turn = await queue.admit(input, randomUUID());
      await expect(queue.withdraw('s', turn.turn_id)).rejects.toThrow('cannot be restored');
      expect(queue.get(turn.turn_id)?.status).toBe('queued');
    }
    expect((await queue.snapshot('s')).turns.every(turn => !turn.withdraw_to_edit_available)).toBe(true);
  });

  it.each([false, true])('uses paired-owner dispatch and skips withdrawn input before the new tail (Messenger linked: %s)', async linked => {
    const { db, store } = fixture(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const executed: string[] = []; const emit = vi.fn();
    const delivered: string[] = [];
    const bridge = linked ? createChatMessengerBridge({ db, store, pollMs: 5, minSendIntervalMs: 0 }) : undefined;
    if (bridge) {
      bridge.bind('slack', 'channel', 'account', 's');
      bridge.register('slack', { resolve: async () => ({ token: 'fixture', recipient: 'channel', account: 'account' }),
        send: async message => { delivered.push(message.text); return { ok: true, vendor_message_id: randomUUID() }; } });
    }
    const raw = createChatOrchestrator({ chatStore: store, selfSignature: signature, broadcast: { emit },
      registry: { list: () => [], listByTier: () => [], getByName: () => null,
        dispatch: async () => ({ ok: true, result: {} }), subscribeRefresh: () => () => {} } });
    const orchestrator = withQueuedChatTurns({ ...raw, runTurn: async input => {
      executed.push(input.message); if (input.message === 'first') await held; return raw.runTurn(input);
    } }, { db, store, pollMs: 10, broadcast: { emit }, ...(bridge ? { messengerBridge: bridge } : {}) });
    cleanup.push(() => { release(); orchestrator.turnQueue!.close(); });
    const deps = { store, orchestrator, selfSignature: signature };
    const send = (message: string) => handleSend(deps, { session_id: 's', message, submission_id: randomUUID(), picker_state: { current: 'self' } });
    await send('first'); await vi.waitFor(() => expect(executed).toEqual(['first']));
    const second = await send('original'); await send('next');
    const handlers = makeChatHandlers(deps)!;
    expect(handlers.methods).toContain('chat.turn.withdraw');
    expect(MCP_RESERVED_RPC_PREFIXES.some(prefix => 'chat.turn.withdraw'.startsWith(prefix))).toBe(true);
    await expect(handlers.handlers['chat.turn.withdraw']({ session_id: 's', turn_id: second.turn_id }, {} as never)).rejects.toThrow('paired client');
    await handlers.handlers['chat.turn.withdraw']({ session_id: 's', turn_id: second.turn_id }, { instance_id: 'owner' } as never);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ kind: 'chat.session_changed', session_id: 's', field: 'queue' }));
    await send('edited'); release();
    await vi.waitFor(() => expect(executed).toEqual(['first', 'next', 'edited']));
    await vi.waitFor(async () => expect((await orchestrator.turnQueue!.snapshot('s')).turns.map(turn => turn.status))
      .toEqual(['completed', 'withdrawn', 'completed', 'completed']));
    expect((await store.listMessages('s')).filter(message => message.role === 'user').map(message => message.content))
      .toEqual(['first', 'next', 'edited']);
    if (linked) {
      await vi.waitFor(() => expect(delivered.filter(text => text.startsWith('Owner (via webclient)')))
        .toEqual(['first', 'next', 'edited'].map(text => `Owner (via webclient)\n${text}`)));
      expect(delivered.join('\n')).not.toContain('original');
    }
  });
});
