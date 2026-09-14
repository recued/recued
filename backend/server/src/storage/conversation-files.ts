import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, type ConversationFileListRequest, type ConversationFileListResult } from '@recued/contracts';
import type { DataFileRecord } from '../collections/file/inbound-file-collection.js';

/** Read the retained binding index, including messages outside the visible window.
 * No message bodies or file bytes are read, and queued drafts are not history. */
export const listConversationFiles = (
  db: Database.Database, args: ConversationFileListRequest,
  index: { prepare: () => void; archived: (sourceId: string) => boolean },
): ConversationFileListResult => {
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || typeof args.session_id !== 'string' || !args.session_id.trim() || args.session_id.length > 512
    || (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200))
    || (args.media_class !== undefined && !['image', 'voice', 'document', 'other'].includes(args.media_class))
    || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100))) {
    throw new RpcError('bad_request', 'Invalid conversation file search.', 400);
  }
  const hasChat = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_sessions'").get();
  const session = (hasChat ? db.prepare('SELECT created_at FROM chat_sessions WHERE session_id=?').get(args.session_id) : undefined) as
    { created_at: number } | undefined;
  if (!session) throw new RpcError('not_found', 'The conversation no longer exists.', 404);
  const query = (args.query ?? '').trim();
  const scope = createHash('sha256').update(JSON.stringify([args.session_id, session.created_at, query, args.media_class ?? null])).digest('hex');
  let after: { time: number; id: string } | undefined;
  if (args.cursor !== undefined) {
    try {
      if (typeof args.cursor !== 'string' || args.cursor.length > 500) throw new Error();
      const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString()) as { scope: string; time: number; id: string };
      if (cursor.scope !== scope || !Number.isSafeInteger(cursor.time) || typeof cursor.id !== 'string' || !/^file:[0-9a-f]{32}$/.test(cursor.id)) throw new Error();
      after = cursor;
    } catch { throw new RpcError('bad_request', 'The file search changed. Refresh the files and try again.', 400); }
  }
  // Legacy references are indexed only after the request and its conversation
  // are validated. A Files read does not migrate unrelated conversations.
  index.prepare();
  const limit = args.limit ?? 30;
  const rows = db.prepare(`WITH uses AS (
      SELECT v.*, m.message_id, m.ts,
        ROW_NUMBER() OVER (PARTITION BY v.version_id ORDER BY m.ts DESC,m.message_id DESC) AS position,
        COUNT(*) OVER (PARTITION BY v.version_id) AS message_count,
        MIN(m.ts) OVER (PARTITION BY v.version_id) AS first_used
      FROM file_attachment_bindings b
      JOIN collection_file_attachment_versions v ON v.version_id=b.version_id
      JOIN chat_messages m ON m.message_id=b.owner_id AND m.session_id=b.session_id
      WHERE b.kind='message' AND b.session_id=? AND m.role IN ('user','assistant')
    ), files AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY first_used,version_id) AS version_number,
        COUNT(*) OVER (PARTITION BY source_id) AS version_count
      FROM uses WHERE position=1
    ) SELECT * FROM files
    WHERE instr(lower(json_extract(record_json,'$.hot_fields.filename')),lower(?))>0
      ${args.media_class ? "AND json_extract(record_json,'$.hot_fields.media_class')=?" : ''}
      ${after ? 'AND (ts < ? OR (ts = ? AND version_id > ?))' : ''}
    ORDER BY ts DESC,version_id ASC LIMIT ?`).all(args.session_id, query,
    ...(args.media_class ? [args.media_class] : []), ...(after ? [after.time, after.time, after.id] : []), limit + 1,
  ) as Array<{ version_id: string; source_id: string; record_json: string; state: 'retained' | 'deleted' | 'missing';
    legacy: number; message_count: number; message_id: string; ts: number; version_number: number; version_count: number }>;
  const page = rows.slice(0, limit); const last = page.at(-1);
  return { files: page.map(row => {
    const hot = (JSON.parse(row.record_json) as DataFileRecord).hot_fields;
    return { file_id: row.version_id, source_file_id: row.source_id, filename: hot.filename,
      mime_type: hot.mime_type, media_class: hot.media_class, size: hot.size,
      availability: row.state === 'retained' ? 'available' : row.state, archived: index.archived(row.source_id),
      legacy_capture: row.legacy === 1, message_count: row.message_count,
      ...(hot.cloud_capture ? { cloud_capture: hot.cloud_capture } : {}),
      last_message_id: row.message_id, last_message_at: row.ts,
      version_number: row.version_number, version_count: row.version_count };
  }), ...(rows.length > limit && last ? { next_cursor: Buffer.from(JSON.stringify({ scope, time: last.ts, id: last.version_id })).toString('base64url') } : {}) };
};
