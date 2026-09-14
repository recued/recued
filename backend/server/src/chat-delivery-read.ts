/** Bounded, paired-owner projections of the existing delivery journal. */
import type Database from 'better-sqlite3';
import { RpcError, type ChatDeliveryItem, type ChatDeliveryListRequest, type ChatDeliverySnapshot,
  type ChatDeliveryState, type ChatMessage } from '@recued/contracts';
import { decodeChatContentFromStorage, type ChatKeyProvider } from './storage/chat-store.js';
import { parseMessengerAttachmentPlan } from './chat-messenger-attachments.js';

interface DeliveryRow {
  sequence: number; delivery_id: string; message_id: string; state: ChatDeliveryState;
  error: string | null; error_file_id: string | null; attachments_compiled: number; native: number;
}
interface PartRow {
  chunk_index: number; kind: 'text' | 'attachment'; state: ChatDeliveryState; payload: string;
}

export const parseChatDeliveryListRequest = (session_id: string, args: Record<string, unknown>): ChatDeliveryListRequest => {
  const { view, cursor, limit, message_ids, details } = args;
  if ((view !== undefined && view !== 'history' && view !== 'messages')
    || (details !== undefined && typeof details !== 'boolean')
    || (cursor !== undefined && (view !== 'history' || typeof cursor !== 'string' || !cursor || cursor.length > 4096))
    || (limit !== undefined && (view !== 'history' || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100))
    || (message_ids !== undefined && (view !== 'messages' || !Array.isArray(message_ids)))
    || (view === 'messages' && (!Array.isArray(message_ids) || message_ids.length > 200
      || message_ids.some(id => typeof id !== 'string' || !id || id.length > 512)))) {
    throw new RpcError('bad_request', 'Invalid delivery history request.', 400);
  }
  return { session_id, ...(view !== undefined ? { view } : {}), ...(details !== undefined ? { details } : {}),
    ...(cursor !== undefined ? { cursor: cursor as string } : {}), ...(limit !== undefined ? { limit: limit as number } : {}),
    ...(message_ids !== undefined ? { message_ids: [...new Set(message_ids as string[])] } : {}),
  };
};

export const readChatDeliveries = async (options: {
  db: Database.Database; request: ChatDeliveryListRequest; snapshot: Pick<ChatDeliverySnapshot, 'generation' | 'binding'>;
  getKey?: ChatKeyProvider | undefined;
  readMessage(id: string): Promise<ChatMessage | undefined>;
  describe(file_id: string): { filename: string } | undefined;
}): Promise<ChatDeliverySnapshot> => {
  const { db, request, snapshot, getKey } = options;
  const session = request.session_id;
  const limit = request.limit ?? 25;
  let ceiling = Number.MAX_SAFE_INTEGER; let before = Number.MAX_SAFE_INTEGER;
  if (request.cursor) {
    try {
      const value: unknown = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== snapshot.generation
        || !Number.isSafeInteger(value[2]) || value[2] < 0 || !Number.isSafeInteger(value[3]) || value[3] < 1
        || value[3] > value[2]) throw new Error('cursor');
      ceiling = value[2]; before = value[3];
    } catch { throw new RpcError('bad_request', 'Delivery history changed or its cursor is invalid. Open the latest deliveries.', 400); }
  }
  const select = `SELECT d.*, EXISTS (SELECT 1 FROM chat_messages m JOIN chat_native_receipts r
    ON r.session_id = m.session_id AND r.turn_id = m.turn_id WHERE m.message_id = d.message_id AND m.role = 'user') AS native
    FROM chat_deliveries d WHERE d.session_id = ?`;
  const { rows, page, plans, revision, counts } = db.transaction(() => {
    const revision = (db.prepare('SELECT revision FROM chat_delivery_revisions WHERE session_id = ?').get(session) as { revision: number } | undefined)?.revision ?? 0;
    const counts = db.prepare(`SELECT COUNT(CASE WHEN state NOT IN ('sent', 'skipped') THEN 1 END) AS pending_count,
      COUNT(CASE WHEN state = 'skipped' THEN 1 END) AS skipped_count FROM chat_deliveries WHERE session_id = ?`)
      .get(session) as { pending_count: number; skipped_count: number };
    const rows = request.view === 'history'
      ? db.prepare(`${select} AND d.sequence <= ? AND d.sequence < ? ORDER BY d.sequence DESC LIMIT ?`)
        .all(session, ceiling, before, limit + 1) as DeliveryRow[]
      : request.view === 'messages'
        ? request.message_ids?.length ? db.prepare(`${select} AND d.message_id IN (${request.message_ids.map(() => '?').join(',')}) ORDER BY d.sequence`)
          .all(session, ...request.message_ids) as DeliveryRow[] : []
        : db.prepare(`${select} AND (d.state NOT IN ('sent', 'skipped') OR d.sequence IN
          (SELECT sequence FROM chat_deliveries WHERE session_id = ? ORDER BY sequence DESC LIMIT 20)) ORDER BY d.sequence LIMIT 200`)
          .all(session, session) as DeliveryRow[];
    if (!request.cursor) ceiling = rows[0]?.sequence ?? 0;
    const page = request.view === 'history' ? rows.slice(0, limit) : rows;
    // A read transaction gives counts, rows and receipts one revision even
    // when another backend process commits a delivery at the same time.
    const plans = page.map(job => db.prepare('SELECT chunk_index, kind, state, payload FROM chat_delivery_chunks WHERE delivery_id = ? ORDER BY chunk_index')
      .all(job.delivery_id) as PartRow[]);
    return { rows, page, plans, revision, counts };
  })();
  const deliveries = await Promise.all(page.map(async (job, index): Promise<ChatDeliveryItem> => {
    const parts = plans[index]!;
    const item: ChatDeliveryItem = { delivery_id: job.delivery_id, message_id: job.message_id, state: job.state,
      sent_chunks: parts.filter(p => p.state === 'sent').length, total_chunks: parts.length,
      ...(job.error ? { error: job.error } : {}),
    };
    if (!request.details) return item;
    const plan = job.native ? 'native' : job.attachments_compiled ? 'prepared'
      : job.state === 'sent' ? 'legacy' : 'unprepared';
    const text = parts.filter(p => p.kind === 'text');
    const details: NonNullable<ChatDeliveryItem['details']> = { message: null, plan,
      text: (plan === 'unprepared' && !text.length) || plan === 'native' ? null
        : { sent_parts: text.filter(p => p.state === 'sent').length, total_parts: text.length }, attachments: [],
    };
    item.details = details;
    const uncertain = parts.filter(part => part.state === 'unknown' || part.state === 'sending').length;
    if (uncertain) details.uncertain_parts = uncertain;
    let message: ChatMessage | undefined;
    try {
      message = await options.readMessage(job.message_id);
      if (message && (message.role === 'user' || message.role === 'assistant')) details.message = {
        role: message.role, snippet: message.content.replace(/\s+/g, ' ').slice(0, 180), ts: message.ts,
      };
      else details.unavailable = true;
    } catch { details.unavailable = true; }
    const attachmentParts = parts.filter(p => p.kind === 'attachment');
    for (const part of attachmentParts) {
      try {
        const file = parseMessengerAttachmentPlan(await decodeChatContentFromStorage(part.payload,
          { session_id: session, message_id: `delivery:${job.delivery_id}:${part.chunk_index}` }, getKey));
        details.attachments.push({ file_id: file.file_id, filename: file.filename.slice(0, 512),
          state: job.state === 'skipped' && part.state !== 'sent' && part.state !== 'unknown' ? 'skipped' : part.state,
          ...(job.state === 'skipped' && part.state === 'unknown' ? { skipped: true } : {}),
          ...(job.error && (part.state === 'failed' || part.state === 'unknown'
            || part === parts.find(p => p.state !== 'sent')) ? { error: job.error } : {}),
        });
      } catch { details.unavailable = true; }
    }
    // Before compilation (including a scan failure), names may be displayed
    // from retained file metadata. This read neither validates nor opens bytes.
    if (!attachmentParts.length) for (const file of message?.attachments ?? []) {
      let filename: string | undefined;
      try { filename = options.describe(file.file_id)?.filename.slice(0, 512); } catch { /* Deleted metadata. */ }
      const error = job.error && (job.error_file_id === file.file_id || job.error === 'attachment_unsupported') ? job.error : undefined;
      details.attachments.push({ file_id: file.file_id, ...(filename !== undefined ? { filename } : {}),
        state: plan === 'native' ? 'sent' : plan === 'legacy' ? 'not_mirrored'
          : job.state === 'skipped' ? 'skipped' : error ? 'failed' : 'pending', ...(error ? { error } : {}),
      });
    }
    return item;
  }));
  if (request.details && getKey && !getKey()) throw new RpcError('unauthorized', 'Unlock the vault to read delivery details.', 401);
  return { ...snapshot, ...counts, revision, deliveries, ...(request.details ? { details_available: true } : {}),
    ...(request.view === 'history' && rows.length > limit ? {
      next_cursor: Buffer.from(JSON.stringify([1, snapshot.generation, ceiling, page.at(-1)!.sequence])).toString('base64url'),
    } : {}),
  };
};
