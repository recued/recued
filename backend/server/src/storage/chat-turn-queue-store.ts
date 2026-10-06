/** D-265. Admission is a short SQLite transaction; payload encryption happens
 * before it. No model/network work runs in a transaction. */
import { createFileAttachmentLifecycle } from './file-attachment-lifecycle.js';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ChatQueuedTurnStatus, ChatTurnAcceptance, ChatTurnQueueSnapshot, ChatWithdrawnDraft, ChatMessageAttachment } from '@recued/contracts';
import { RpcError } from '@recued/contracts';
import {
  encodeChatContentForStorage, decodeChatContentFromStorage, type ChatKeyProvider,
} from './chat-store.js';

export interface QueuedChatCommand {
  family: string;
  session_id: string;
  message: string;
  input: Record<string, unknown>;
  /** Trusted ingress projection of execution intent, without delivery IDs. */
  comparison?: Record<string, unknown>;
  native_receipt?: { vendor: string; recipient: string; message_id: string; thread_id?: string; account?: string };
}

interface QueueRow {
  position: number;
  turn_id: string;
  session_id: string;
  family: string;
  status: ChatQueuedTurnStatus;
  fingerprint: string;
  payload: string;
  created_at: number;
  worker_id: string | null;
  worker_pid: number | null;
  worker_started_at: number | null;
  duplicate_count: number;
  failure_reason?: string | null;
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => {
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
  }
  return entry;
});

const comparisonForCommand = (command: QueuedChatCommand): string => canonical(command.comparison
  ? { family: command.family, session_id: command.session_id, comparison: command.comparison }
  : { ...command, input: Object.fromEntries(Object.entries(command.input)
    // A prepared investigation (read-only plus mail locators) and an ordinary
    // request with the same message are one turn to duplicate protection:
    // a duplicate only suppresses a run, it never grants authority. Otherwise
    // re-sending a finished investigation's text would start an ordinary turn.
    .filter(([name]) => name !== 'queue_generation' && name !== 'read_only' && name !== 'mail_work')
    // Legacy provenance is displayed to the owner; it does not create a new turn.
    .map(([name, value]) => [name, name === 'attachments' && Array.isArray(value)
      ? value.map(file => ({ file_id: file.file_id, media_class: file.media_class })) : value])) });
const terminal = (status: ChatQueuedTurnStatus): boolean =>
  !['queued', 'running', 'cancelling'].includes(status);
export const isChatQueueTerminal = terminal;

// Fail closed for native ingress and structured actions: a text composer cannot
// faithfully restore their deferred ingestion or execution context.
const composerInputKeys = new Set(['session_id', 'message', 'picker_state', 'model_pref', 'time_zone',
  'attachments', 'reply_to_message_id', 'model_routing_snapshot', 'delivery_thread_id', 'queue_generation']);
const composerDraft = (command: QueuedChatCommand): Omit<ChatWithdrawnDraft, 'turn_id'> | null => {
  if (command.family !== 'chat' || command.native_receipt || command.comparison
    || command.input.session_id !== command.session_id || command.input.message !== command.message
    || Object.keys(command.input).some(key => !composerInputKeys.has(key))) return null;
  const attachments: NonNullable<ChatWithdrawnDraft['attachments']> = [];
  if (command.input.attachments !== undefined) {
    if (!Array.isArray(command.input.attachments)) return null;
    for (const file of command.input.attachments) {
      if (!file || typeof file !== 'object' || typeof file.file_id !== 'string' || typeof file.media_class !== 'string') return null;
      attachments.push({ file_id: file.file_id, media_class: file.media_class });
    }
  }
  const reply = command.input.reply_to_message_id;
  if (reply !== undefined && typeof reply !== 'string') return null;
  return { session_id: command.session_id, message: command.message,
    ...(attachments.length ? { attachments } : {}), ...(reply ? { reply_to_message_id: reply } : {}) };
};

export const createChatTurnQueueStore = (db: Database.Database, getKey?: ChatKeyProvider) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_turn_queue (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      family TEXT NOT NULL,
      status TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      worker_id TEXT, worker_pid INTEGER, worker_started_at INTEGER,
      duplicate_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS chat_turn_queue_session ON chat_turn_queue(session_id, position);
    CREATE UNIQUE INDEX IF NOT EXISTS chat_turn_queue_active ON chat_turn_queue(session_id)
      WHERE status IN ('running', 'cancelling');
    CREATE TABLE IF NOT EXISTS chat_turn_submissions (
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      submission_id TEXT NOT NULL,
      turn_id TEXT NOT NULL REFERENCES chat_turn_queue(turn_id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      PRIMARY KEY(session_id, submission_id)
    );
    CREATE TABLE IF NOT EXISTS chat_queue_revisions (
      session_id TEXT PRIMARY KEY REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0,
      generation TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_native_receipts (
      session_id TEXT NOT NULL REFERENCES chat_sessions(session_id) ON DELETE CASCADE,
      vendor TEXT NOT NULL, recipient TEXT NOT NULL, message_id TEXT NOT NULL,
      turn_id TEXT NOT NULL REFERENCES chat_turn_queue(turn_id) ON DELETE CASCADE,
      thread_id TEXT,
      PRIMARY KEY(session_id, vendor, message_id)
    );
    CREATE TABLE IF NOT EXISTS chat_native_admissions (
      source_key TEXT PRIMARY KEY, session_id TEXT REFERENCES chat_sessions(session_id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE TRIGGER IF NOT EXISTS chat_native_delete BEFORE DELETE ON chat_sessions BEGIN
      UPDATE chat_native_admissions SET deleted_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE session_id = OLD.session_id;
    END;
  `);
  if (!(db.prepare('PRAGMA table_info(chat_native_receipts)').all() as Array<{ name: string }>).some(c => c.name === 'thread_id')) {
    try { db.exec('ALTER TABLE chat_native_receipts ADD COLUMN thread_id TEXT'); }
    catch (error) {
      if (!(db.prepare('PRAGMA table_info(chat_native_receipts)').all() as Array<{ name: string }>).some(c => c.name === 'thread_id')) throw error;
    }
  }
  const columns = new Set((db.prepare('PRAGMA table_info(chat_turn_queue)').all() as Array<{ name: string }>).map(c => c.name));
  if (!columns.has('attachments_indexed')) db.exec('ALTER TABLE chat_turn_queue ADD COLUMN attachments_indexed INTEGER NOT NULL DEFAULT 0');
  if (!columns.has('failure_reason')) db.exec('ALTER TABLE chat_turn_queue ADD COLUMN failure_reason TEXT');
  const files = createFileAttachmentLifecycle(db);
  const commandAttachments = (command: QueuedChatCommand): ChatMessageAttachment[] => {
    const value = command.input.attachments;
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(f => f && typeof f.file_id === 'string' && typeof f.media_class === 'string')) {
      throw new RpcError('bad_request', 'Invalid attachments.', 400);
    }
    return value.map(f => {
      if (f.selection_revision !== undefined && (typeof f.selection_revision !== 'string' || !/^[0-9a-f]{64}$/.test(f.selection_revision))) {
        throw new RpcError('bad_request', 'Invalid file selection.', 400);
      }
      return { file_id: f.file_id, media_class: f.media_class,
        ...(f.selection_revision !== undefined ? { selection_revision: f.selection_revision } : {}) };
    });
  };
  const sourceKey = (receipt: NonNullable<QueuedChatCommand['native_receipt']>): string => {
    const key = getKey?.();
    if (getKey && !key) throw new Error('Chat vault is locked.');
    const data = canonical([receipt.vendor, receipt.recipient, receipt.account ?? '', receipt.message_id]);
    return key ? createHmac('sha256', key).update(data).digest('hex') : createHash('sha256').update(data).digest('hex');
  };
  const nativeSession = (receipt: NonNullable<QueuedChatCommand['native_receipt']>): string | null | undefined =>
    (db.prepare('SELECT session_id FROM chat_native_admissions WHERE source_key = ? AND (deleted_at IS NULL OR deleted_at >= ?)')
      .get(sourceKey(receipt), Date.now() - 30 * 86400000) as
      { session_id: string | null } | undefined)?.session_id;
  const changed = (session: string): void => {
    db.prepare(`INSERT INTO chat_queue_revisions VALUES (?, 1, ?)
      ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1`).run(session, randomUUID());
  };
  const generation = (session: string): string => {
    if (!db.prepare('SELECT 1 FROM chat_sessions WHERE session_id = ?').get(session)) {
      throw new RpcError('not_found', 'The conversation no longer exists.', 404);
    }
    db.prepare('INSERT OR IGNORE INTO chat_queue_revisions VALUES (?, 0, ?)').run(session, randomUUID());
    return (db.prepare('SELECT generation FROM chat_queue_revisions WHERE session_id = ?').get(session) as { generation: string }).generation;
  };
  const get = (turn: string): QueueRow | undefined =>
    db.prepare('SELECT * FROM chat_turn_queue WHERE turn_id = ?').get(turn) as QueueRow | undefined;
  const read = async (row: QueueRow): Promise<QueuedChatCommand> =>
    JSON.parse(await decodeChatContentFromStorage(row.payload,
      { session_id: row.session_id, message_id: `queue:${row.turn_id}` }, getKey)) as QueuedChatCommand;
  const admit = async (command: QueuedChatCommand, submission: string, repeat = false): Promise<ChatTurnAcceptance> => {
    const admittedGeneration = generation(command.session_id);
    if (command.input.queue_generation !== undefined && command.input.queue_generation !== admittedGeneration) {
      throw new RpcError('bad_request', 'The conversation changed. Reopen it before sending.', 400);
    }
    if (Buffer.byteLength(canonical(command)) > 1024 * 1024) throw new RpcError('bad_request', 'Chat input is too large.', 400);
    // HMAC prevents the deduplication index from becoming a plaintext dictionary
    // oracle. Unencrypted mode is reserved for the existing no-key test adapter.
    const key = getKey ? await getKey() : undefined;
    if (getKey && !key) throw new Error('Chat vault is locked.');
    const digest = (text: string): string => key
      ? createHmac('sha256', key).update(text).digest('hex')
      : createHash('sha256').update(text).digest('hex');
    const prepared = files.prepare(commandAttachments(command));
    const frozen = prepared.files.length ? { ...command, input: { ...command.input, attachments: prepared.files.map(f => f.attachment) } } : command;
    const body = canonical(frozen);
    const fingerprint = digest(comparisonForCommand(frozen));
    const request = { ...command, comparison: undefined, input: Object.fromEntries(Object.entries(command.input)
      .filter(([name]) => !['model_routing_snapshot', 'delivery_thread_id'].includes(name))) };
    const requestFingerprint = digest(`${repeat ? 'repeat' : 'send'}:${canonical(request)}`);
    const turn_id = randomUUID();
    const payload = await encodeChatContentForStorage(body,
      { session_id: command.session_id, message_id: `queue:${turn_id}` }, getKey);
    return db.transaction((): ChatTurnAcceptance => {
      if (!db.prepare('SELECT 1 FROM chat_sessions WHERE session_id = ?').get(command.session_id)) {
        throw new RpcError('not_found', 'The conversation no longer exists.', 404);
      }
      if (generation(command.session_id) !== admittedGeneration) {
        throw new RpcError('bad_request', 'The conversation changed while accepting the message.', 400);
      }
      if (command.native_receipt) {
        const receipt = command.native_receipt;
        const previousSession = nativeSession(receipt);
        if (previousSession !== undefined && previousSession !== command.session_id) {
          throw new RpcError('bad_request', 'The original Messenger conversation was removed.', 400);
        }
        // A vendor can redeliver the same message under a new update/envelope
        // ID. Its durable native receipt owns that input, independently of
        // wrapper metadata or a routing snapshot that changed after admission.
        // Check inside the transaction so concurrent redeliveries also join
        // the first committed turn. Webclient submission conflicts stay strict.
        const native = db.prepare(`SELECT turn_id FROM chat_native_receipts
          WHERE session_id = ? AND vendor = ? AND recipient = ? AND message_id = ?`)
          .get(command.session_id, receipt.vendor, receipt.recipient, receipt.message_id) as { turn_id: string } | undefined;
        if (!repeat && native && previousSession === command.session_id) {
          return { turn_id: native.turn_id, status: get(native.turn_id)!.status, disposition: 'replayed' };
        }
      }
      const replay = db.prepare(`SELECT turn_id, fingerprint FROM chat_turn_submissions
        WHERE session_id = ? AND submission_id = ?`).get(command.session_id, submission) as
        { turn_id: string; fingerprint: string } | undefined;
      if (replay) {
        if (replay.fingerprint !== requestFingerprint) throw new RpcError('bad_request', 'Submission ID was already used for a different message.', 400);
        return { turn_id: replay.turn_id, status: get(replay.turn_id)!.status, disposition: 'replayed' };
      }
      const count = db.prepare('SELECT COUNT(*) AS n FROM chat_turn_submissions WHERE session_id = ?')
        .get(command.session_id) as { n: number };
      if (count.n >= 10000) throw new RpcError('bad_request', 'This conversation has reached its submission limit. Start a new conversation.', 400);
      const last = db.prepare('SELECT * FROM chat_turn_queue WHERE session_id = ? ORDER BY position DESC LIMIT 1')
        .get(command.session_id) as QueueRow | undefined;
      const duplicate = !repeat && last?.status !== 'withdrawn' && last?.fingerprint === fingerprint ? last : undefined;
      if (!duplicate) {
        const reply = command.input.reply_to_message_id;
        if (command.family === 'chat' && reply !== undefined
          && (typeof reply !== 'string' || !db.prepare(`SELECT 1 FROM chat_messages
            WHERE session_id = ? AND message_id = ? AND role IN ('user', 'assistant')`).get(command.session_id, reply))) {
          throw new RpcError('not_found', 'The reply target is no longer available in this conversation. Clear the reply or choose another message.', 404);
        }
        const pending = db.prepare(`SELECT COUNT(*) AS n FROM chat_turn_queue
          WHERE session_id = ? AND status IN ('queued', 'running', 'cancelling')`).get(command.session_id) as { n: number };
        const total = db.prepare(`SELECT COUNT(*) AS n FROM chat_turn_queue
          WHERE status IN ('queued', 'running', 'cancelling')`).get() as { n: number };
        if (pending.n >= 64 || total.n >= 4096) throw new RpcError('bad_request', 'The conversation queue is full. Try again after a turn finishes.', 400);
        // Reserve two text obligations for each accepted linked turn. Delivery
        // lag never pauses accepted AI work, but finite journal capacity must
        // refuse a NEW command before acknowledging ownership of it.
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_messenger_bindings'").get()
          && db.prepare('SELECT 1 FROM chat_messenger_bindings WHERE session_id = ?').get(command.session_id)) {
          const backlog = db.prepare(`SELECT COUNT(*) AS total, COUNT(CASE WHEN session_id = ? THEN 1 END) AS session
            FROM chat_deliveries WHERE state NOT IN ('sent', 'skipped')`).get(command.session_id) as { total: number; session: number };
          const reserved = db.prepare(`SELECT COUNT(*) AS total, COUNT(CASE WHEN q.session_id = ? THEN 1 END) AS session
            FROM chat_turn_queue q JOIN chat_messenger_bindings b ON b.session_id = q.session_id
            WHERE q.status IN ('queued', 'running', 'cancelling')`).get(command.session_id) as { total: number; session: number };
          if (backlog.session + 2 * reserved.session + 2 > 2048 || backlog.total + 2 * reserved.total + 2 > 16384) {
            throw new RpcError('bad_request', 'Messenger delivery storage is full. Resolve pending deliveries before sending another message.', 400);
          }
        }
        db.prepare(`INSERT INTO chat_turn_queue
          (turn_id, session_id, family, status, fingerprint, payload, created_at, attachments_indexed)
          VALUES (?, ?, ?, 'queued', ?, ?, ?, 1)`).run(turn_id, command.session_id, command.family, fingerprint, payload, Date.now());
        files.bind('queue', turn_id, command.session_id, prepared);
      } else {
        db.prepare('UPDATE chat_turn_queue SET duplicate_count = duplicate_count + 1 WHERE turn_id = ?').run(duplicate.turn_id);
      }
      const original = duplicate?.turn_id ?? turn_id;
      db.prepare('INSERT INTO chat_turn_submissions VALUES (?, ?, ?, ?)')
        .run(command.session_id, submission, original, requestFingerprint);
      if (command.native_receipt) {
        const receipt = command.native_receipt;
        db.prepare('DELETE FROM chat_native_admissions WHERE session_id IS NULL AND deleted_at < ?').run(Date.now() - 30 * 86400000);
        db.prepare('INSERT OR IGNORE INTO chat_native_admissions (source_key, session_id, created_at) VALUES (?, ?, ?)').run(sourceKey(receipt), command.session_id, Date.now());
        // A deleted conversation retains only an opaque retry tombstone for
        // 30 days. No message text, account ID or destination is kept here.
        db.prepare('INSERT OR IGNORE INTO chat_native_receipts (session_id, vendor, recipient, message_id, turn_id, thread_id) VALUES (?, ?, ?, ?, ?, ?)')
          .run(command.session_id, receipt.vendor, receipt.recipient, receipt.message_id, original, receipt.thread_id ?? null);
      }
      changed(command.session_id);
      return { turn_id: original, status: duplicate?.status ?? 'queued', disposition: duplicate ? 'duplicate' : 'accepted' };
    }).immediate();
  };
  const snapshot = async (session_id: string): Promise<ChatTurnQueueSnapshot> => {
    // Capture revision and rows synchronously before decrypting; clients discard
    // stale snapshots that race later queue broadcasts.
    const sessionGeneration = generation(session_id);
    const revision = (db.prepare('SELECT revision FROM chat_queue_revisions WHERE session_id = ?')
      .get(session_id) as { revision: number } | undefined)?.revision ?? 0;
    const rows = db.prepare(`SELECT * FROM chat_turn_queue WHERE session_id = ? AND
      (status IN ('queued', 'running', 'cancelling') OR position IN
        (SELECT position FROM chat_turn_queue WHERE session_id = ? ORDER BY position DESC LIMIT 64))
      ORDER BY position`).all(session_id, session_id) as QueueRow[];
    const turns = await Promise.all(rows.map(async (row) => {
      const command = await read(row).catch(() => null);
      return {
        turn_id: row.turn_id, session_id, position: row.position, status: row.status,
        message: command?.message.slice(0, 1000) ?? 'Message unavailable',
        created_at: row.created_at, duplicate_count: row.duplicate_count,
        ...(row.failure_reason === 'attachment_deleted' ? { failure_reason: 'attachment_deleted' as const } : {}),
        ...((row.status === 'queued' || row.status === 'withdrawn') && command && composerDraft(command)
          ? { withdraw_to_edit_available: true } : {}),
      };
    }));
    return { generation: sessionGeneration, revision, turns };
  };
  const withdraw = async (session: string, turn: string): Promise<ChatWithdrawnDraft> => {
    const original = get(turn);
    if (!original || original.session_id !== session) throw new RpcError('not_found', 'Turn not found in this conversation.', 404);
    const key = getKey?.()?.slice();
    if (getKey && !key) throw new Error('Chat vault is locked.');
    // Decrypt before the transaction: corrupt/unavailable input must never
    // disappear from the queue without a recoverable draft.
    const draft = composerDraft(await read(original));
    return db.transaction(() => {
      const currentKey = getKey?.();
      if (getKey && (!key || !currentKey || !Buffer.from(key).equals(Buffer.from(currentKey)))) {
        throw new Error('Chat vault changed while withdrawing the message. Try again.');
      }
      const row = get(turn);
      if (!row || row.session_id !== session || row.payload !== original.payload) {
        throw new RpcError('not_found', 'The queued message is no longer available.', 404);
      }
      if (!draft) throw new RpcError('bad_request', 'This turn cannot be restored to the composer.', 400);
      if (row.status !== 'queued' && row.status !== 'withdrawn') {
        throw new RpcError('bad_request', 'This turn is no longer queued. Its original message cannot be edited.', 409);
      }
      // The same immediate SQLite transaction as claim(): either the worker
      // wins or withdrawal wins. A lost response can safely retry by turn ID.
      if (row.status === 'queued') {
        db.prepare("UPDATE chat_turn_queue SET status = 'withdrawn' WHERE turn_id = ? AND status = 'queued'").run(turn);
        changed(session);
      }
      return { ...draft, ...(draft.attachments ? { attachments: draft.attachments.map(files.describe) } : {}), turn_id: turn };
    }).immediate();
  };
  const claim = (family: string | string[], worker: { id: string; pid: number; started_at: number }): QueueRow | undefined => db.transaction(() => {
    const families = typeof family === 'string' ? [family] : family;
    if (families.length === 0) return undefined;
    const next = db.prepare(`SELECT q.* FROM chat_turn_queue q WHERE q.family IN (${families.map(() => '?').join(',')}) AND q.status = 'queued'
      ${files.configured() ? 'AND q.attachments_indexed=1' : ''}
      AND NOT EXISTS (SELECT 1 FROM chat_turn_queue active WHERE active.session_id = q.session_id
        AND active.status IN ('running', 'cancelling'))
      AND NOT EXISTS (SELECT 1 FROM chat_turn_queue prior WHERE prior.session_id = q.session_id
        AND prior.status = 'queued' AND prior.position < q.position)
      ORDER BY q.position LIMIT 1`).get(...families) as QueueRow | undefined;
    if (!next) return undefined;
    db.prepare(`UPDATE chat_turn_queue SET status = 'running', worker_id = ?, worker_pid = ?, worker_started_at = ? WHERE turn_id = ?`)
      .run(worker.id, worker.pid, worker.started_at, next.turn_id);
    changed(next.session_id);
    return get(next.turn_id);
  }).immediate();
  const settle = (turn: string, worker: string, status: 'completed' | 'failed' | 'cancelled' | 'interrupted'): void => db.transaction(() => {
    const row = get(turn);
    if (!row || row.worker_id !== worker || terminal(row.status)) return;
    db.prepare('UPDATE chat_turn_queue SET status = ? WHERE turn_id = ?').run(row.status === 'cancelling' ? 'cancelled' : status, turn);
    changed(row.session_id);
  }).immediate();
  const cancel = (session: string, turn: string): void => db.transaction(() => {
    const row = get(turn);
    if (!row || row.session_id !== session) throw new RpcError('not_found', 'Turn not found in this conversation.', 404);
    if (terminal(row.status)) return;
    db.prepare('UPDATE chat_turn_queue SET status = ? WHERE turn_id = ?')
      .run(row.status === 'queued' ? 'cancelled' : 'cancelling', turn);
    changed(session);
  }).immediate();
  const recover = (alive: (pid: number, started: number) => boolean): string[] => db.transaction(() => {
    const sessions = new Set<string>();
    const rows = db.prepare("SELECT * FROM chat_turn_queue WHERE status IN ('running', 'cancelling')").all() as QueueRow[];
    for (const row of rows) {
      if (row.worker_pid !== null && alive(row.worker_pid, row.worker_started_at ?? 0)) continue;
      db.prepare("UPDATE chat_turn_queue SET status = 'interrupted' WHERE turn_id = ?").run(row.turn_id);
      changed(row.session_id);
      sessions.add(row.session_id);
    }
    return [...sessions];
  }).immediate();
  const indexLegacyAttachments = async (): Promise<void> => {
    if (!files.configured()) return;
    const rows = db.prepare('SELECT * FROM chat_turn_queue WHERE attachments_indexed=0 ORDER BY position LIMIT 100').all() as QueueRow[];
    for (const row of rows) {
      const command = await read(row);
      const prepared = files.prepare(commandAttachments(command), true);
      const frozen = prepared.files.length ? { ...command, input: { ...command.input, attachments: prepared.files.map(f => f.attachment) } } : command;
      const key = getKey?.();
      if (getKey && !key) throw new Error('Chat vault is locked.');
      const fingerprint = key ? createHmac('sha256', key).update(comparisonForCommand(frozen)).digest('hex')
        : createHash('sha256').update(comparisonForCommand(frozen)).digest('hex');
      const payload = await encodeChatContentForStorage(canonical(frozen), { session_id: row.session_id, message_id: `queue:${row.turn_id}` }, getKey);
      db.transaction(() => {
        const current = get(row.turn_id); if (!current || current.payload !== row.payload) return;
        files.bind('queue', row.turn_id, row.session_id, prepared);
        db.prepare('UPDATE chat_turn_queue SET payload=?,fingerprint=?,attachments_indexed=1 WHERE turn_id=?').run(payload, fingerprint, row.turn_id);
      }).immediate();
    }
  };
  const needsAttachmentIndexing = (): boolean => files.configured()
    && !!db.prepare('SELECT 1 FROM chat_turn_queue WHERE attachments_indexed=0 LIMIT 1').get();
  return { admit, get, read, snapshot, claim, settle, cancel, withdraw, recover, nativeSession, generation, indexLegacyAttachments, needsAttachmentIndexing };
};

export type ChatTurnQueueStore = ReturnType<typeof createChatTurnQueueStore>;
