/** D-265: the production admission/worker boundary for durable conversations. */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, type ChatWithdrawnDraft, type ChatTurnAcceptance, type ChatTurnQueueSnapshot } from '@recued/contracts';
import type { ChatBroadcastEmitter, ChatOrchestrator, ChatTurnInput, ChatTurnAck } from './chat-orchestrator.js';
import type { ChatKeyProvider, ChatStore } from './storage/chat-store.js';
import { createChatTurnQueueStore, isChatQueueTerminal, type QueuedChatCommand } from './storage/chat-turn-queue-store.js';

export interface ChatTurnQueue {
  ensureSession(session: string, title?: string): void;
  routing(session: string): ChatTurnInput['model_routing_snapshot'];
  nativeSession(receipt: NonNullable<QueuedChatCommand['native_receipt']>): string | null | undefined;
  nativeReply(session: string, vendor: string, message: string): Promise<{ message_id: string; role: string; text: string } | undefined>;
  snapshot(session: string): Promise<ChatTurnQueueSnapshot>;
  withdraw(session: string, turn: string): Promise<ChatWithdrawnDraft>;
  cancel(session: string, turn: string): Promise<void>;
  retry(session: string, turn: string, submission: string): Promise<ChatTurnAcceptance>;
  submit(command: QueuedChatCommand, submission: string, repeat?: boolean): Promise<ChatTurnAcceptance>;
  register(family: string, execute: (command: QueuedChatCommand, turn: string, assertActive: () => void, complete: () => void) => Promise<ChatTurnAck>): void;
  close(): void;
}

const processStartedAt = Date.now() - Math.round(process.uptime() * 1000);
const workerAlive = (pid: number, started: number): boolean => {
  if (pid === process.pid) return Math.abs(started - processStartedAt) < 2000;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

export const withQueuedChatTurns = (
  base: ChatOrchestrator,
  options: { db: Database.Database; store: ChatStore; getKey?: ChatKeyProvider | undefined;
    messengerBridge?: import('./chat-messenger-bridge.js').ChatMessengerBridge;
    broadcast?: ChatBroadcastEmitter | undefined; pollMs?: number; recoverAlive?: typeof workerAlive },
): ChatOrchestrator => {
  const journal = createChatTurnQueueStore(options.db, options.getKey);
  const worker = { id: randomUUID(), pid: process.pid, started_at: processStartedAt };
  const handlers = new Map<string, Parameters<ChatTurnQueue['register']>[1]>();
  const active = new Set<string>();
  const retired = new Set<string>();
  const waiters = new Map<string, Array<(ack: ChatTurnAck) => void>>();
  let closed = false;
  let pumping = false;
  let indexing = false;
  const notify = (session: string): void => {
    try { options.broadcast?.emit({ kind: 'chat.session_changed', session_id: session, field: 'queue', value: true }); }
    catch { /* Durable snapshots recover an unavailable broadcast. */ }
  };
  const flushWaiters = (): void => {
    if (!options.db.open) return;
    for (const [turn, callbacks] of waiters) {
      const row = journal.get(turn);
      if (row && !isChatQueueTerminal(row.status)) continue;
      waiters.delete(turn);
      for (const done of callbacks) done({ turn_id: turn });
    }
  };
  const pump = (): void => {
    if (closed || !options.db.open || pumping || (options.getKey && !options.getKey())) return;
    if (journal.needsAttachmentIndexing()) {
      if (!indexing) {
        indexing = true;
        void journal.indexLegacyAttachments().then(() => { indexing = false; pump(); })
          .catch(() => { indexing = false; });
      }
    }
    pumping = true;
    try {
      for (const turn of retired) {
        const row = journal.get(turn);
        journal.settle(turn, worker.id, 'interrupted'); retired.delete(turn);
        if (row && !isChatQueueTerminal(row.status)) notify(row.session_id);
      }
      for (const session of journal.recover(options.recoverAlive ?? workerAlive)) notify(session);
      flushWaiters();
      while (active.size < 4) {
        const row = journal.claim([...handlers.keys()], worker);
        if (!row) break;
        const execute = handlers.get(row.family)!;
        active.add(row.turn_id);
        notify(row.session_id);
        const assertActive = (): void => {
          if (closed || !options.db.open) throw new Error('Conversation worker is shutting down.');
          const current = journal.get(row.turn_id);
          if (closed || current?.status !== 'running' || current.worker_id !== worker.id) {
            throw new Error('Conversation turn is no longer active.');
          }
        };
        void (async () => {
          try {
            const command = await journal.read(row);
            assertActive();
            if (!options.store.getSession(row.session_id)) throw new Error('Conversation deleted.');
            await execute(command, row.turn_id, assertActive,
              () => { journal.settle(row.turn_id, worker.id, 'completed'); notify(row.session_id); });
            if (options.db.open) journal.settle(row.turn_id, worker.id, 'completed');
          } catch (error) {
            if (!options.db.open) return;
            journal.settle(row.turn_id, worker.id, closed ? 'interrupted' : 'failed');
            // Status is durable and contains no error text or user payload.
            if (journal.get(row.turn_id)?.status === 'failed') console.error('[chat queue] turn failed', row.turn_id);
          } finally {
            active.delete(row.turn_id);
            retired.add(row.turn_id);
            notify(row.session_id);
            try { flushWaiters(); } catch { /* Retry after SQLite becomes available. */ }
            queueMicrotask(pump);
          }
        })().catch(() => { /* A failed terminal write is retried as interrupted; never rerun the operation. */ });
      }
    } catch { /* No in-memory acceptance fallback. The durable rows survive a busy/full database. */
    } finally { pumping = false; }
  };
  const timer = setInterval(pump, options.pollMs ?? 1000);
  timer.unref();
  const queue: ChatTurnQueue = {
    ensureSession(session, title) {
      if (!options.store.getSession(session)) {
        options.store.createSession({ id: session, ...(title ? { title } : {}) });
        try { options.broadcast?.emit({ kind: 'chat.session_changed', session_id: session, field: 'title', value: title ?? null }); }
        catch { /* Listing recovers a missed announcement. */ }
      }
    },
    routing: (session) => options.store.getSession(session)?.model_routing,
    nativeSession: journal.nativeSession,
    async nativeReply(session, vendor, message) {
      const target = options.db.prepare(`SELECT m.message_id FROM chat_native_receipts r
        JOIN chat_messages m ON m.session_id = r.session_id AND m.turn_id = r.turn_id AND m.role = 'user'
        WHERE r.session_id = ? AND r.vendor = ? AND r.message_id = ? LIMIT 1`).get(session, vendor, message) as { message_id: string } | undefined;
      if (!target) return undefined;
      const page = await options.store.listMessagePage(session, 1, undefined, { around_message_id: target.message_id });
      const row = page.messages.find(m => m.id === target.message_id);
      return row ? { message_id: row.id, role: row.role, text: row.content } : undefined;
    },
    snapshot: journal.snapshot,
    async withdraw(session, turn) {
      const draft = await journal.withdraw(session, turn);
      notify(session); flushWaiters(); pump();
      return draft;
    },
    async cancel(session, turn) { journal.cancel(session, turn); notify(session); flushWaiters(); pump(); },
    async retry(session, turn, submission) {
      const row = journal.get(turn);
      if (!row || row.session_id !== session) throw new RpcError('not_found', 'Turn not found in this conversation.', 404);
      return queue.submit(await journal.read(row), submission, true);
    },
    async submit(command, submission, repeat) {
      if (closed) throw new Error('Conversation worker is shutting down.');
      const ack = await journal.admit(command, submission, repeat);
      notify(command.session_id);
      // Defer execution until the admission caller has received its receipt.
      queueMicrotask(pump);
      return ack;
    },
    register(family, execute) { handlers.set(family, execute); queueMicrotask(pump); },
    close() {
      closed = true; clearInterval(timer); options.messengerBridge?.close();
      for (const [turn, callbacks] of waiters) for (const done of callbacks) done({ turn_id: turn });
      waiters.clear();
    },
  };
  queue.register('chat', (command, turn, assertActive) => base.runTurn({
    ...(command.input as unknown as ChatTurnInput), queue_turn_id: turn, assert_active: assertActive,
    complete_turn: () => { journal.settle(turn, worker.id, 'completed'); notify(command.session_id); },
  }));
  return {
    ...base,
    turnQueue: queue,
    ...(options.messengerBridge ? { messengerBridge: options.messengerBridge } : {}),
    async runMessengerTurn(input) {
      if (!input.queue_turn_id || !input.assert_active) throw new Error('Messenger execution requires a durable queue claim.');
      input.assert_active();
      return base.runMessengerTurn(input);
    },
    async runTurn(input) {
      const stored = Object.fromEntries(Object.entries(input).filter(([key]) =>
        !['on_accepted', 'queue_turn_id', 'assert_active', 'complete_turn', 'submission_id', 'repeat'].includes(key)));
      stored.model_routing_snapshot = options.store.getSession(input.session_id)?.model_routing;
      const thread = options.messengerBridge?.binding(input.session_id)?.default_thread;
      if (thread) stored.delivery_thread_id = thread;
      const ack = await queue.submit({ family: 'chat', session_id: input.session_id, message: input.message, input: stored },
        input.submission_id ?? randomUUID(), input.repeat);
      try { input.on_accepted?.(ack); } catch { /* The durable receipt still stands. */ }
      const row = journal.get(ack.turn_id);
      if (!row || isChatQueueTerminal(row.status)) return { turn_id: ack.turn_id };
      return new Promise<ChatTurnAck>((resolve) => {
        const callbacks = waiters.get(ack.turn_id) ?? [];
        callbacks.push(resolve);
        waiters.set(ack.turn_id, callbacks);
        flushWaiters();
      });
    },
  };
};
