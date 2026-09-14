/** D-265: the canonical message commit creates an outbound obligation in the
 * SAME transaction. A separate worker sends it, without holding the AI queue. */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, type ChatDeliverySnapshot, type ChatDeliveryListRequest, type ChatDeliveryState,
  type ChatMessengerSessionStatus, type ChatMessengerReceiveState } from '@recued/contracts';
import type { OutboundAttachment, OutboundMessage, TransportSendResult } from '@recued/transport';
import { MessengerAttachmentError, parseMessengerAttachmentPlan, type MessengerAttachmentSource } from './chat-messenger-attachments.js';
import { readChatDeliveries } from './chat-delivery-read.js';
import type { ChatBroadcastEmitter } from './chat-orchestrator.js';
import { createChatTurnQueueStore } from './storage/chat-turn-queue-store.js';
import { decodeChatContentFromStorage, encodeChatContentForStorage, type ChatKeyProvider, type ChatStore } from './storage/chat-store.js';

export interface MessengerDeliveryAdapter {
  resolve(): Promise<{ token: string; recipient: string; account: string } | null>;
  send(message: OutboundMessage): Promise<TransportSendResult>;
  attachments?: MessengerAttachmentSource;
  sendAttachment?(attachment: OutboundAttachment): Promise<TransportSendResult>;
  /** Local credential/configuration version. Never exposed in Chat responses. */
  revision?(): string;
}
interface Binding { binding_id: string; session_id: string; vendor: string; recipient: string; account: string; default_thread: string | null; next_send_at: number }
interface Delivery { sequence: number; delivery_id: string; binding_id: string; session_id: string; message_id: string;
  state: ChatDeliveryState; worker_id: string | null; worker_pid: number | null; worker_started: number | null; error: string | null; next_attempt_at: number; attachments_compiled: number }
interface Chunk { delivery_id: string; chunk_index: number; payload: string; state: ChatDeliveryState;
  vendor_message_id: string | null; vendor_file_id: string | null; kind: 'text' | 'attachment'; thread_id: string | null; reply_to: string | null; attempts: number }
class AttachmentPreparationError extends MessengerAttachmentError {
  constructor(error: MessengerAttachmentError, readonly fileId: string) { super(error.code); }
}
class ReplyTargetUnavailableError extends Error {}
const processStarted = Date.now() - Math.round(process.uptime() * 1000);
const alive = (pid: number, started: number): boolean => {
  if (pid === process.pid) return Math.abs(started - processStarted) < 2000;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};
/** Uniform conservative UTF-16 budget. Plain Slack markup is disabled, so no
 * escaping expansion consumes this budget. Splitting preserves every code point. */
export const splitMessengerText = (text: string, limit = 1800): string[] => {
  if (limit < 2) throw new Error('Message chunk budget is too small.');
  const chunks: string[] = []; let chunk = '';
  for (const point of text) {
    if (chunk.length + point.length > limit) { chunks.push(chunk); chunk = ''; }
    chunk += point;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
};

export const createChatMessengerBridge = (options: { db: Database.Database; store: ChatStore;
  getKey?: ChatKeyProvider | undefined; broadcast?: ChatBroadcastEmitter | undefined; pollMs?: number;
  workerAlive?: (pid: number, started: number) => boolean; minSendIntervalMs?: number; retryDelayMs?: number }) => {
  const { db, store, getKey } = options;
  const queue = createChatTurnQueueStore(db, getKey);
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messenger_bindings (
      binding_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      vendor TEXT NOT NULL, recipient TEXT NOT NULL, account TEXT NOT NULL, default_thread TEXT, next_send_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(vendor, recipient, account)
    );
    CREATE TABLE IF NOT EXISTS chat_deliveries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL UNIQUE,
      binding_id TEXT NOT NULL REFERENCES chat_messenger_bindings(binding_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES chat_messages(message_id) ON DELETE CASCADE,
      state TEXT NOT NULL, worker_id TEXT, worker_pid INTEGER, worker_started INTEGER, error TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(binding_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS chat_deliveries_order ON chat_deliveries(binding_id, sequence);
    CREATE INDEX IF NOT EXISTS chat_deliveries_state ON chat_deliveries(state, sequence);
    CREATE INDEX IF NOT EXISTS chat_deliveries_session ON chat_deliveries(session_id, sequence);
    CREATE INDEX IF NOT EXISTS chat_deliveries_unresolved ON chat_deliveries(binding_id, sequence, session_id)
      WHERE state NOT IN ('sent', 'skipped');
    CREATE INDEX IF NOT EXISTS chat_deliveries_list_status ON chat_deliveries(binding_id, state)
      WHERE state != 'sent';
    CREATE TABLE IF NOT EXISTS chat_delivery_chunks (
      delivery_id TEXT NOT NULL REFERENCES chat_deliveries(delivery_id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
      vendor_message_id TEXT, thread_id TEXT, reply_to TEXT, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(delivery_id, chunk_index)
    );
    CREATE TABLE IF NOT EXISTS chat_delivery_revisions (
      session_id TEXT PRIMARY KEY REFERENCES chat_sessions(session_id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS chat_delivery_actions (
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      submission_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(session_id, submission_id)
    );
    CREATE TRIGGER IF NOT EXISTS chat_messenger_commit AFTER INSERT ON chat_messages
      WHEN NEW.role IN ('user', 'assistant') AND EXISTS (SELECT 1 FROM chat_messenger_bindings WHERE session_id = NEW.session_id)
      BEGIN
        UPDATE chat_messenger_bindings SET default_thread =
          (SELECT thread_id FROM chat_native_receipts WHERE session_id = NEW.session_id AND turn_id = NEW.turn_id LIMIT 1)
          WHERE session_id = NEW.session_id AND NEW.role = 'user' AND EXISTS
            (SELECT 1 FROM chat_native_receipts WHERE session_id = NEW.session_id AND turn_id = NEW.turn_id);
        INSERT INTO chat_deliveries (delivery_id, binding_id, session_id, message_id, state)
          SELECT lower(hex(randomblob(16))), binding_id, NEW.session_id, NEW.message_id,
            CASE WHEN NEW.role = 'user' AND EXISTS
              (SELECT 1 FROM chat_native_receipts WHERE session_id = NEW.session_id AND turn_id = NEW.turn_id)
              THEN 'sent' ELSE 'pending' END
          FROM chat_messenger_bindings WHERE session_id = NEW.session_id;
        INSERT INTO chat_delivery_revisions VALUES (NEW.session_id, 1)
          ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
      END;
  `);
  // Additive migration: existing receipts remain text parts. Pending legacy
  // plans acquire their attachments once; completed historical sends stay put.
  for (const [table, column, definition] of [
    ['chat_deliveries', 'attachments_compiled', 'INTEGER NOT NULL DEFAULT 0'],
    ['chat_deliveries', 'error_file_id', 'TEXT'],
    ['chat_delivery_chunks', 'kind', "TEXT NOT NULL DEFAULT 'text'"],
    ['chat_delivery_chunks', 'vendor_file_id', 'TEXT'],
  ]) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  const adapters = new Map<string, MessengerDeliveryAdapter>();
  const connections = new Map<string, {
    revision: string | undefined;
    phase: 'checking' | 'ready' | 'unavailable';
    credential?: { recipient: string; account: string } | null;
    retry_at: number;
  }>();
  const workerId = randomUUID(); const active = new Set<string>(); let closed = false; let pumping = false;
  const binding = (session: string): Binding | undefined => db.prepare('SELECT * FROM chat_messenger_bindings WHERE session_id = ?').get(session) as Binding | undefined;
  const delivery = (id: string): Delivery | undefined => db.prepare('SELECT * FROM chat_deliveries WHERE delivery_id = ?').get(id) as Delivery | undefined;
  const chunks = (id: string): Chunk[] => db.prepare('SELECT * FROM chat_delivery_chunks WHERE delivery_id = ? ORDER BY chunk_index').all(id) as Chunk[];
  const notify = (session: string): void => {
    try { options.broadcast?.emit({ kind: 'chat.session_changed', session_id: session, field: 'delivery', value: true }); }
    catch { /* The durable snapshot remains authoritative. */ }
  };
  const changed = (session: string): void => {
    db.prepare('INSERT INTO chat_delivery_revisions VALUES (?, 1) ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1').run(session);
    notify(session);
  };
  const setState = (job: Delivery, state: ChatDeliveryState, error?: string, errorFileId?: string): void => db.transaction(() => {
    db.prepare('UPDATE chat_deliveries SET state = ?, error = ?, error_file_id = ? WHERE delivery_id = ?')
      .run(state, error ?? null, errorFileId ?? null, job.delivery_id);
    changed(job.session_id);
  })();
  const assertOwned = (job: Delivery): void => {
    if (closed || !db.open) throw new Error('Delivery worker closed.');
    const current = delivery(job.delivery_id);
    if (current?.state !== 'sending' || current.worker_id !== workerId || !binding(job.session_id)) throw new Error('Delivery no longer active.');
  };
  const readMessage = async (session: string, id: string) => {
    const page = await store.listMessagePage(session, 1, undefined, { around_message_id: id });
    return page.messages.find(m => m.id === id);
  };
  const externalMessage = (session: string, id: string): { message_id: string; thread_id: string | null } | undefined => {
    const sent = db.prepare(`SELECT c.vendor_message_id AS message_id,
      COALESCE(c.thread_id, CASE WHEN b.vendor = 'slack' THEN c.reply_to END) AS thread_id FROM chat_delivery_chunks c
      JOIN chat_deliveries d ON d.delivery_id = c.delivery_id
      JOIN chat_messenger_bindings b ON b.binding_id = d.binding_id WHERE d.session_id = ? AND d.message_id = ?
      AND c.state = 'sent' AND c.vendor_message_id IS NOT NULL ORDER BY c.chunk_index LIMIT 1`).get(session, id) as { message_id: string; thread_id: string | null } | undefined;
    if (sent) return sent;
    return db.prepare(`SELECT r.message_id, r.thread_id FROM chat_native_receipts r JOIN chat_messages m
      ON m.session_id = r.session_id AND m.turn_id = r.turn_id AND m.role = 'user'
      WHERE m.session_id = ? AND m.message_id = ? LIMIT 1`).get(session, id) as { message_id: string; thread_id: string | null } | undefined;
  };
  const compile = async (job: Delivery, bound: Binding, adapter: MessengerDeliveryAdapter): Promise<void> => {
    if (job.attachments_compiled) return;
    const existing = chunks(job.delivery_id);
    const message = await readMessage(job.session_id, job.message_id);
    if (!message) throw new Error('Message no longer retained.');
    let thread: string | undefined; let reply: string | undefined;
    // Retained replies outlive queue bookkeeping. Older messages can still
    // recover their reference from the original queued command.
    let replyId = message.reply_to && 'message_id' in message.reply_to ? message.reply_to.message_id : undefined;
    const turn = message.turn_id ? queue.get(message.turn_id) : undefined;
    if (turn) {
      const command = await queue.read(turn);
      thread = typeof command.input.delivery_thread_id === 'string' ? command.input.delivery_thread_id : undefined;
      if (command.family === 'messenger') {
        thread = typeof command.comparison?.thread === 'string' ? command.comparison.thread : undefined;
      }
      replyId ??= typeof command.input.reply_to_message_id === 'string' ? command.input.reply_to_message_id : undefined;
    }
    if (replyId && message.role === 'user') {
      const target = externalMessage(job.session_id, replyId);
      if (!target) throw new ReplyTargetUnavailableError('Reply target has no confirmed delivery.');
      reply = target.message_id;
      thread = target.thread_id ?? (bound.vendor === 'slack' ? target.message_id : undefined);
    }
    if (!reply && message.role === 'assistant' && message.turn_id) {
      const owner = db.prepare("SELECT message_id FROM chat_messages WHERE session_id = ? AND turn_id = ? AND role = 'user' ORDER BY ts LIMIT 1")
        .get(job.session_id, message.turn_id) as { message_id: string } | undefined;
      const ownerTarget = owner ? externalMessage(job.session_id, owner.message_id) : undefined;
      reply = ownerTarget?.message_id;
      if (ownerTarget) thread = ownerTarget.thread_id ?? undefined;
      else if (owner && db.prepare('SELECT 1 FROM chat_deliveries WHERE session_id = ? AND message_id = ?').get(job.session_id, owner.message_id)) {
        throw new ReplyTargetUnavailableError('The question has no confirmed Messenger representation.');
      }
    }
    if (bound.vendor === 'slack') thread ??= reply;
    const attachments = message.attachments ?? [];
    if (attachments.length && (!adapter.attachments || !adapter.sendAttachment)) throw new MessengerAttachmentError('attachment_unsupported');
    const files = attachments.map(file => {
      try { return adapter.attachments!.snapshot(file.file_id); }
      catch (error) { throw error instanceof MessengerAttachmentError ? new AttachmentPreparationError(error, file.file_id) : error; }
    });
    // The Slack adapter addresses a thread, so include the selected message's
    // bounded quote as plain text too. Telegram/Discord render native quotes.
    const quote = bound.vendor === 'slack' && replyId && message.role === 'user' && message.reply_to
      ? message.reply_to.preview
        ? `Replying to ${message.reply_to.preview.role === 'user' ? 'Owner' : 'Recued'}: ${message.reply_to.preview.text}\n\n`
        : 'Replying to an earlier message (text no longer available).\n\n'
      : '';
    const text = message.role === 'user' ? `${quote}Owner (via webclient)\n${message.content}`
      : message.content || (files.length ? 'Assistant attached a file.' : '');
    const parts: Array<{ kind: Chunk['kind']; text: string }> = existing.length ? []
      : splitMessengerText(text).map(text => ({ kind: 'text', text }));
    parts.push(...files.map(file => ({ kind: 'attachment' as const, text: JSON.stringify(file) })));
    const encrypted = await Promise.all(parts.map((part, index) => encodeChatContentForStorage(part.text,
      { session_id: job.session_id, message_id: `delivery:${job.delivery_id}:${existing.length + index}` }, getKey)));
    db.transaction(() => {
      assertOwned(job);
      for (const [i, payload] of encrypted.entries()) db.prepare('INSERT INTO chat_delivery_chunks (delivery_id, chunk_index, payload, kind, state, thread_id, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(job.delivery_id, existing.length + i, payload, parts[i]!.kind, 'pending', thread ?? null, reply ?? null);
      db.prepare('UPDATE chat_deliveries SET attachments_compiled = 1 WHERE delivery_id = ?').run(job.delivery_id);
      if (chunks(job.delivery_id).every(c => c.state === 'sent')) setState(job, 'sent');
      else changed(job.session_id);
    }).immediate();
  };
  const recover = (): void => {
    const jobs = db.prepare("SELECT * FROM chat_deliveries WHERE state = 'sending'").all() as Delivery[];
    for (const job of jobs) {
      if (job.worker_id === workerId && active.has(job.delivery_id)) continue;
      if (job.worker_id !== workerId && job.worker_pid !== null && (options.workerAlive ?? alive)(job.worker_pid, job.worker_started ?? 0)) continue;
      db.transaction(() => {
        const current = delivery(job.delivery_id);
        if (current?.state !== 'sending' || current.worker_id !== job.worker_id) return;
        const parts = chunks(job.delivery_id);
        const uncertain = parts.some(c => c.state === 'sending' || c.state === 'unknown');
        db.prepare("UPDATE chat_delivery_chunks SET state = 'unknown' WHERE delivery_id = ? AND state = 'sending'").run(job.delivery_id);
        const confirmed = job.attachments_compiled && parts.length > 0 && parts.every(c => c.state === 'sent');
        setState(job, uncertain ? 'unknown' : confirmed ? 'sent' : 'pending', uncertain ? 'restart_after_send' : undefined);
      }).immediate();
    }
  };
  const run = async (job: Delivery, bound: Binding, adapter: MessengerDeliveryAdapter): Promise<void> => {
    let preparingPart: Chunk | undefined;
    try {
      await compile(job, bound, adapter);
      if (delivery(job.delivery_id)?.state === 'sent') return;
      for (const chunk of chunks(job.delivery_id)) {
        if (chunk.state === 'sent') continue;
        preparingPart = chunk;
        assertOwned(job);
        if (chunk.state === 'unknown' || chunk.state === 'sending') { setState(job, 'unknown', 'restart_after_send'); return; }
        const credential = await adapter.resolve();
        assertOwned(job);
        if (!credential || credential.recipient !== bound.recipient || credential.account !== bound.account) {
          setState(job, 'failed', 'binding_changed'); return;
        }
        const text = await decodeChatContentFromStorage(chunk.payload,
          { session_id: job.session_id, message_id: `delivery:${job.delivery_id}:${chunk.chunk_index}` }, getKey);
        const file = chunk.kind === 'attachment' ? parseMessengerAttachmentPlan(text) : undefined;
        if (file) {
          const canonicalMessage = await readMessage(job.session_id, job.message_id);
          const reference = canonicalMessage?.attachments?.find(attachment => attachment.file_id === file.file_id || attachment.source_file_id === file.file_id);
          if (!canonicalMessage || reference?.availability === 'deleted' || reference?.availability === 'missing') {
            throw new MessengerAttachmentError('attachment_unavailable');
          }
        }
        if (file && (!adapter.attachments || !adapter.sendAttachment)) throw new MessengerAttachmentError('attachment_unsupported');
        const opened = file ? await adapter.attachments!.open(file) : undefined;
        let result: TransportSendResult;
        try {
          const beforeSend = async (): Promise<void> => {
            assertOwned(job);
            if (getKey && !getKey()) throw new Error('Vault locked.');
            const current = await adapter.resolve();
            assertOwned(job);
            if (getKey && !getKey()) throw new Error('Vault locked.');
            if (!current || current.account !== bound.account || current.recipient !== bound.recipient || current.token !== credential.token) {
              throw new Error('Delivery credential changed.');
            }
            if (file) adapter.attachments!.validate(file);
          };
          await beforeSend();
          db.transaction(() => {
            db.prepare("UPDATE chat_delivery_chunks SET state = 'sending', attempts = attempts + 1 WHERE delivery_id = ? AND chunk_index = ?")
              .run(job.delivery_id, chunk.chunk_index); changed(job.session_id);
          })();
          const common = { token: credential.token, recipient: bound.recipient, lossless: true,
            delivery_id: createHash('sha256').update(`${job.delivery_id}:${chunk.chunk_index}`).digest('hex').slice(0, 24),
            ...(chunk.reply_to ? { reply_to_message_id: chunk.reply_to } : {}), ...(chunk.thread_id ? { thread_id: chunk.thread_id } : {}),
          };
          // Every attachment follows the text anchor for this canonical
          // message. Slack files use its parent thread, never a file ID.
          const anchor = file ? externalMessage(job.session_id, job.message_id) : undefined;
          result = file && opened ? await adapter.sendAttachment!({ ...common,
            path: opened.path, filename: file.filename, mime_type: file.mime_type, size: file.size, beforeSend,
            ...(anchor ? { reply_to_message_id: anchor.message_id } : {}),
            ...(bound.vendor === 'slack' && anchor ? { thread_id: chunk.thread_id ?? anchor.thread_id ?? anchor.message_id } : {}),
          }) : await adapter.send({ ...common, text });
        } catch (error) {
          // Preparation failures happened before the durable send boundary.
          if (!chunks(job.delivery_id).some(c => c.state === 'sending')) throw error;
          result = { ok: false, error: { kind: 'network', detail: 'Delivery outcome unavailable.' } };
        } finally {
          // A cleanup error cannot erase an already returned vendor receipt.
          await opened?.dispose().catch(() => undefined);
        }
        if (!db.open || !delivery(job.delivery_id)) return;
        // A result belongs to this attempt even when shutdown began while the
        // vendor was responding; retain a receipt instead of losing its evidence.
        if (delivery(job.delivery_id)?.worker_id !== workerId) return;
        db.transaction(() => {
          if (result.ok && (result.vendor_message_id || (chunk.kind === 'attachment' && result.vendor_file_id))) {
            db.prepare("UPDATE chat_delivery_chunks SET state = 'sent', vendor_message_id = ?, vendor_file_id = ? WHERE delivery_id = ? AND chunk_index = ?")
              .run(result.vendor_message_id ?? null, result.vendor_file_id ?? null, job.delivery_id, chunk.chunk_index);
            db.prepare('UPDATE chat_messenger_bindings SET next_send_at = ? WHERE binding_id = ?')
              .run(Date.now() + (options.minSendIntervalMs ?? 1100), bound.binding_id);
            if (chunks(job.delivery_id).every(c => c.state === 'sent')) setState(job, 'sent');
            else setState(job, 'pending');
          } else {
            const definite = !result.ok && ['auth', 'rate_limited', 'invalid_request'].includes(result.error.kind);
            const retryable = !result.ok && result.error.kind === 'rate_limited' && chunk.attempts + 1 < 5;
            const state = retryable ? 'pending' : definite ? 'failed' : 'unknown';
            if (retryable) db.prepare('UPDATE chat_deliveries SET next_attempt_at = ? WHERE delivery_id = ?')
              .run(Date.now() + Math.max(options.retryDelayMs ?? 30000, !result.ok ? result.error.retry_after_ms ?? 0 : 0), job.delivery_id);
            db.prepare('UPDATE chat_delivery_chunks SET state = ? WHERE delivery_id = ? AND chunk_index = ?').run(state, job.delivery_id, chunk.chunk_index);
            setState(job, state, result.ok ? 'missing_receipt' : result.error.kind);
          }
        }).immediate();
        if (delivery(job.delivery_id)?.state !== 'sending') return;
      }
    } catch (error) {
      if (db.open && delivery(job.delivery_id)?.state === 'sending' && delivery(job.delivery_id)?.worker_id === workerId) {
        const uncertain = chunks(job.delivery_id).some(c => c.state === 'sending');
        db.transaction(() => {
          if (uncertain) db.prepare("UPDATE chat_delivery_chunks SET state = 'unknown' WHERE delivery_id = ? AND state = 'sending'").run(job.delivery_id);
          else if (preparingPart) db.prepare("UPDATE chat_delivery_chunks SET state = 'failed' WHERE delivery_id = ? AND chunk_index = ? AND state != 'sent'")
            .run(job.delivery_id, preparingPart.chunk_index);
          setState(job, uncertain ? 'unknown' : 'failed', error instanceof MessengerAttachmentError ? error.code
            : error instanceof ReplyTargetUnavailableError ? 'reply_target_unavailable' : 'delivery_unavailable',
            error instanceof AttachmentPreparationError ? error.fileId : undefined);
        }).immediate();
      }
    }
  };
  const pump = (): void => {
    if (closed || !db.open || pumping || (getKey && !getKey())) return;
    pumping = true;
    try {
      recover();
      while (active.size < 4 && adapters.size > 0) {
        const job = db.transaction(() => {
          const next = db.prepare(`SELECT d.* FROM chat_deliveries d JOIN chat_messenger_bindings b ON b.binding_id = d.binding_id
            WHERE d.state = 'pending' AND d.next_attempt_at <= ? AND b.next_send_at <= ? AND b.vendor IN (${[...adapters.keys()].map(() => '?').join(',')})
            AND NOT EXISTS (SELECT 1 FROM chat_deliveries prior WHERE prior.binding_id = d.binding_id AND prior.sequence < d.sequence
              AND prior.state NOT IN ('sent', 'skipped')) ORDER BY d.sequence LIMIT 1`).get(Date.now(), Date.now(), ...adapters.keys()) as Delivery | undefined;
          if (!next) return undefined;
          db.prepare("UPDATE chat_deliveries SET state = 'sending', worker_id = ?, worker_pid = ?, worker_started = ? WHERE delivery_id = ?")
            .run(workerId, process.pid, processStarted, next.delivery_id); changed(next.session_id);
          return delivery(next.delivery_id);
        }).immediate();
        if (!job) break;
        const bound = binding(job.session_id)!; const adapter = adapters.get(bound.vendor)!;
        active.add(job.delivery_id);
        void run(job, bound, adapter).catch(() => {
          // SQLite may reject even the failure write. Recovery sees this
          // inactive attempt and preserves uncertainty before advancing.
        }).finally(() => { active.delete(job.delivery_id); queueMicrotask(pump); });
      }
    } catch { /* Keep durable obligations intact until SQLite is writable again. */
    } finally { pumping = false; }
  };
  const timer = setInterval(pump, options.pollMs ?? 500); timer.unref();
  const bind = (vendor: string, recipient: string, account: string, adoptSession?: string): Binding => db.transaction(() => {
    const existing = db.prepare('SELECT * FROM chat_messenger_bindings WHERE vendor = ? AND recipient = ? AND account = ?')
      .get(vendor, recipient, account) as Binding | undefined;
    if (existing) {
      if (adoptSession && existing.session_id !== adoptSession) throw new RpcError('bad_request', 'Open the current linked conversation to continue on Messenger.', 400);
      return existing;
    }
    const base = `messenger:${vendor}:${recipient}`;
    // An unlabelled historic session has no account evidence. It is readable;
    // adopting its context for outbound use requires the paired owner's action.
    const session_id = adoptSession ?? (!store.getSession(base) ? base
      : `${base}:${createHash('sha256').update(account).digest('hex').slice(0, 16)}`);
    if (binding(session_id)) throw new RpcError('bad_request', 'This conversation is already linked.', 400);
    if (adoptSession && !store.getSession(adoptSession)) throw new RpcError('not_found', 'Conversation not found.', 404);
    if (!store.getSession(session_id)) store.createSession({ id: session_id, title: `${vendor} · ${recipient}` });
    const bound: Binding = { binding_id: randomUUID(), session_id, vendor, recipient, account, default_thread: null, next_send_at: 0 };
    db.prepare('INSERT INTO chat_messenger_bindings (binding_id, session_id, vendor, recipient, account, default_thread) VALUES (?, ?, ?, ?, ?, NULL)').run(bound.binding_id, session_id, vendor, recipient, account);
    changed(session_id);
    try { options.broadcast?.emit({ kind: 'chat.session_changed', session_id, field: 'title', value: `${vendor} · ${recipient}` }); } catch {}
    return bound;
  }).immediate();
  const snapshot = async (session: string, request: ChatDeliveryListRequest = { session_id: session }): Promise<ChatDeliverySnapshot> => {
    if (!store.getSession(session)) throw new RpcError('not_found', 'Conversation not found.', 404);
    const keyAtRead = request.details && getKey ? getKey()?.slice() : undefined;
    if (request.details && getKey && !keyAtRead) throw new RpcError('unauthorized', 'Unlock the vault to read delivery details.', 401);
    const sessionGeneration = queue.generation(session);
    const bound = binding(session);
    const result = await readChatDeliveries({ db, request: { ...request, session_id: session }, getKey,
      readMessage: id => readMessage(session, id),
      describe: fileId => bound ? adapters.get(bound.vendor)?.attachments?.describe?.(fileId) : undefined,
      snapshot: { generation: bound?.binding_id ?? sessionGeneration,
        binding: bound ? { vendor: bound.vendor, recipient: bound.recipient, account: bound.account,
          ...(bound.default_thread ? { thread_id: bound.default_thread } : {}) } : null,
      },
    });
    if (!bound) {
      const vendor = /^messenger:([^:]+):/.exec(session)?.[1]; const adapter = vendor ? adapters.get(vendor) : undefined;
      const credential = await adapter?.resolve().catch(() => null);
      if (vendor && credential) {
        const current = db.prepare('SELECT session_id FROM chat_messenger_bindings WHERE vendor = ? AND recipient = ? AND account = ?')
          .get(vendor, credential.recipient, credential.account) as { session_id: string } | undefined;
        result.available = { vendor, recipient: credential.recipient, ...(current ? { linked_session_id: current.session_id } : {}) };
      }
    }
    if (queue.generation(session) !== sessionGeneration || binding(session)?.binding_id !== bound?.binding_id
      || result.deliveries.some(job => !delivery(job.delivery_id))) {
      throw new RpcError('bad_request', 'Conversation changed while reading delivery history. Refresh it.', 400);
    }
    const currentKey = request.details && getKey ? getKey() : undefined;
    if (keyAtRead && (!currentKey || !Buffer.from(keyAtRead).equals(Buffer.from(currentKey)))) {
      throw new RpcError('unauthorized', 'The vault changed while reading delivery details. Unlock it and refresh.', 401);
    }
    return result;
  };
  const connectionState = (vendor: string) => {
    const adapter = adapters.get(vendor);
    if (!adapter) return { phase: 'ready' as const, credential: null };
    let revision: string | undefined;
    try { revision = adapter.revision?.(); } catch { return { phase: 'unavailable' as const }; }
    const cached = connections.get(vendor);
    if (cached && cached.revision === revision && (cached.phase !== 'unavailable' || cached.retry_at > Date.now())) return cached;
    const observation: NonNullable<typeof cached> = { revision, phase: 'checking', retry_at: 0 };
    connections.set(vendor, observation);
    // Listing never waits on vendor HTTP and never decrypts conversation text.
    // One observation serves every row for this vendor. Configuration changes
    // invalidate it immediately; a late result cannot validate a replacement.
    void Promise.resolve().then(() => adapter.resolve()).then(credential => {
      if (closed || !db.open || connections.get(vendor) !== observation || adapter.revision?.() !== revision) return;
      observation.phase = 'ready';
      observation.credential = credential ? { recipient: credential.recipient, account: credential.account } : null;
    }).catch(() => {
      if (connections.get(vendor) !== observation) return;
      observation.phase = 'unavailable'; observation.retry_at = Date.now() + 30_000;
    }).finally(() => {
      if (closed || !db.open || connections.get(vendor) !== observation) return;
      // Clients coalesce these journal notifications into one list read.
      try {
        for (const row of db.prepare('SELECT session_id FROM chat_messenger_bindings WHERE vendor = ?').all(vendor) as { session_id: string }[]) notify(row.session_id);
      } catch { /* A later list read recovers an unavailable notification. */ }
    });
    return observation;
  };
  const sessionStatuses = (
    sessionIds: readonly string[],
    receiveStatus: (vendor: string) => ChatMessengerReceiveState = () => 'unknown',
  ): Map<string, ChatMessengerSessionStatus> => {
    const rows = db.prepare(`SELECT b.*, COUNT(CASE WHEN d.state NOT IN ('sent', 'skipped') THEN 1 END) AS pending_count,
      COUNT(CASE WHEN d.state = 'sending' THEN 1 END) AS sending_count,
      COUNT(CASE WHEN d.state = 'failed' THEN 1 END) AS failed_count,
      COUNT(CASE WHEN d.state = 'unknown' THEN 1 END) AS unknown_count,
      COUNT(CASE WHEN d.state = 'skipped' THEN 1 END) AS skipped_count
      FROM chat_messenger_bindings b LEFT JOIN chat_deliveries d ON d.binding_id = b.binding_id AND d.state != 'sent'
      GROUP BY b.binding_id`).all() as Array<Binding & NonNullable<ChatMessengerSessionStatus['delivery']>>;
    const visible = new Set(sessionIds);
    const out = new Map<string, ChatMessengerSessionStatus>();
    const health = new Map<string, { connection: ReturnType<typeof connectionState>; ingress: ChatMessengerReceiveState }>();
    for (const row of rows) {
      if (!visible.has(row.session_id)) continue;
      let observed = health.get(row.vendor);
      if (!observed) {
        let ingress: ChatMessengerReceiveState;
        try { ingress = receiveStatus(row.vendor); } catch { ingress = 'unavailable'; }
        observed = { connection: connectionState(row.vendor), ingress }; health.set(row.vendor, observed);
      }
      const { connection, ingress } = observed;
      let receive: ChatMessengerReceiveState;
      if (ingress === 'locked' || ingress === 'paused') receive = ingress;
      else if (connection.phase === 'ready') {
        receive = !connection.credential ? 'not_connected'
          : connection.credential.account !== row.account || connection.credential.recipient !== row.recipient
            ? 'connection_changed' : ingress;
      } else receive = connection.phase;
      out.set(row.session_id, { vendor: row.vendor, recipient: row.recipient, linked: true, receive,
        delivery: { pending_count: row.pending_count, sending_count: row.sending_count, failed_count: row.failed_count,
          unknown_count: row.unknown_count, skipped_count: row.skipped_count } });
    }
    for (const id of sessionIds) {
      if (out.has(id)) continue;
      const legacy = /^messenger:([^:]+):(.+)$/.exec(id);
      if (legacy) out.set(id, { vendor: legacy[1]!, recipient: legacy[2]!, linked: false, receive: 'unlinked', delivery: null });
    }
    return out;
  };
  const act = (session: string, id: string, submission: string, action: 'retry' | 'skip', acceptUnknown = false): void => db.transaction(() => {
    const job = delivery(id);
    if (!job || job.session_id !== session) throw new RpcError('not_found', 'Delivery not found in this conversation.', 404);
    const fingerprint = JSON.stringify([id, action, acceptUnknown]);
    const prior = db.prepare('SELECT fingerprint FROM chat_delivery_actions WHERE session_id = ? AND submission_id = ?').get(session, submission) as { fingerprint: string } | undefined;
    if (prior) { if (prior.fingerprint !== fingerprint) throw new RpcError('bad_request', 'Submission ID was reused for another delivery action.', 400); return; }
    if (job.state === 'sending') throw new RpcError('bad_request', 'The delivery is still in flight.', 400);
    if (job.state === 'unknown' && action === 'retry' && !acceptUnknown) throw new RpcError('bad_request', 'This retry may duplicate a message. Acknowledge that risk before retrying.', 400);
    if (job.state !== 'sent' && job.state !== 'skipped') {
      if (action === 'skip') setState(job, 'skipped');
      else {
        db.prepare("UPDATE chat_delivery_chunks SET state = 'pending', attempts = 0 WHERE delivery_id = ? AND state != 'sent'").run(id);
        db.prepare('UPDATE chat_deliveries SET next_attempt_at = 0 WHERE delivery_id = ?').run(id);
        setState(job, 'pending');
      }
    }
    db.prepare('INSERT INTO chat_delivery_actions VALUES (?, ?, ?)').run(session, submission, fingerprint);
  }).immediate();
  return { bind, binding, snapshot, sessionStatuses, act,
    register(vendor: string, adapter: MessengerDeliveryAdapter) { adapters.set(vendor, adapter); connections.delete(vendor); queueMicrotask(pump); },
    async connect(session: string, vendor: string) {
      const generation = queue.generation(session);
      const credential = await adapters.get(vendor)?.resolve();
      if (!credential) throw new RpcError('bad_request', 'Messenger is not connected.', 400);
      if (queue.generation(session) !== generation) throw new RpcError('bad_request', 'The conversation changed while linking Messenger.', 400);
      return bind(vendor, credential.recipient, credential.account, session).session_id;
    },
    async nativeReply(session: string, vendor: string, id: string) {
      const target = db.prepare(`SELECT d.message_id FROM chat_delivery_chunks c JOIN chat_deliveries d ON d.delivery_id = c.delivery_id
        JOIN chat_messenger_bindings b ON b.binding_id = d.binding_id WHERE d.session_id = ? AND b.vendor = ?
        AND c.vendor_message_id = ? AND c.state = 'sent' LIMIT 1`).get(session, vendor, id) as { message_id: string } | undefined;
      const row = target ? await readMessage(session, target.message_id) : undefined;
      return row ? { message_id: row.id, role: row.role, text: row.content } : undefined;
    },
    kick: pump,
    close() { closed = true; clearInterval(timer); },
  };
};
export type ChatMessengerBridge = ReturnType<typeof createChatMessengerBridge>;
