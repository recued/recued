/** Retained attachments share the collection CAS and its backup/GC keepset.
 * File IDs exposed to existing readers name immutable versions; mutable library
 * IDs remain the root for impact previews. No byte access authority is added. */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { RpcError, type ChatMessageAttachment, type FileLifecyclePreview, type FileUsage,
  type FileAttachmentSelection, type FileAttachmentListRequest, type FileAttachmentListResult, type ConversationFileListRequest } from '@recued/contracts';
import type { DataFileRecord } from '../collections/file/inbound-file-collection.js';
import { listConversationFiles } from './conversation-files.js';
import { quoteSqliteIdent } from './collection-blob-refs.js';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const processStarted = Date.now() - Math.round(process.uptime() * 1000);
const exists = (db: Database.Database, table: string): boolean => !!db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
interface VersionRow {
  version_id: string; source_id: string; blob_hash: string | null; content_hash: string;
  record_json: string; state: 'retained' | 'deleted' | 'missing'; legacy: number; scan_status: string;
}
interface PreparedFile {
  attachment: ChatMessageAttachment; version: VersionRow;
  /** Original library row identity, rechecked after asynchronous encryption. */
  expected?: string;
  existing?: boolean;
}
export interface PreparedAttachments { files: PreparedFile[]; error?: Error }
/** Internal acknowledgement marker: replay must not cascade into a newer upload. */
export type FileLifecycleResult = FileLifecyclePreview & { replayed?: boolean };

export const createFileAttachmentLifecycle = (db: Database.Database) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_attachment_sources (slug TEXT PRIMARY KEY, table_name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS collection_file_attachment_versions (
      version_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, blob_hash TEXT, content_hash TEXT NOT NULL,
      record_json TEXT NOT NULL, state TEXT NOT NULL, legacy INTEGER NOT NULL DEFAULT 0, scan_status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS file_attachment_version_source ON collection_file_attachment_versions(source_id);
    CREATE INDEX IF NOT EXISTS file_attachment_version_blob ON collection_file_attachment_versions(blob_hash);
    CREATE TABLE IF NOT EXISTS file_attachment_bindings (
      kind TEXT NOT NULL, owner_id TEXT NOT NULL, session_id TEXT NOT NULL, version_id TEXT NOT NULL
        REFERENCES collection_file_attachment_versions(version_id),
      PRIMARY KEY(kind, owner_id, version_id)
    );
    CREATE INDEX IF NOT EXISTS file_attachment_binding_version ON file_attachment_bindings(version_id);
    CREATE INDEX IF NOT EXISTS file_attachment_binding_session ON file_attachment_bindings(session_id);
    CREATE TABLE IF NOT EXISTS collection_file_attachment_leases (
      token TEXT PRIMARY KEY, source_id TEXT NOT NULL, blob_hash TEXT NOT NULL,
      pid INTEGER NOT NULL, started_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_attachment_delete_permits (source_id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS file_lifecycle_receipts (request_id TEXT PRIMARY KEY, result TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS file_attachment_release AFTER DELETE ON file_attachment_bindings BEGIN
      DELETE FROM collection_file_attachment_versions WHERE version_id = OLD.version_id
        AND NOT EXISTS (SELECT 1 FROM file_attachment_bindings WHERE version_id = OLD.version_id);
    END;
  `);
  if (exists(db, 'chat_messages')) db.exec(`CREATE TRIGGER IF NOT EXISTS chat_attachment_release
    AFTER DELETE ON chat_messages BEGIN DELETE FROM file_attachment_bindings WHERE kind='message' AND owner_id=OLD.message_id; END;`);
  if (exists(db, 'chat_sessions')) db.exec(`CREATE TRIGGER IF NOT EXISTS chat_attachment_session_release
    BEFORE DELETE ON chat_sessions BEGIN DELETE FROM file_attachment_bindings WHERE session_id=OLD.session_id; END;`);
  if (exists(db, 'chat_turn_queue')) db.exec(`CREATE TRIGGER IF NOT EXISTS chat_attachment_queue_release
    AFTER DELETE ON chat_turn_queue BEGIN DELETE FROM file_attachment_bindings WHERE kind='queue' AND owner_id=OLD.turn_id; END;`);

  const sourceTable = (): string | undefined => (db.prepare('SELECT table_name FROM file_attachment_sources WHERE slug=?')
    .get('received') as { table_name: string } | undefined)?.table_name;
  const configured = (): boolean => !!sourceTable();
  const version = (id: string): VersionRow | undefined => db.prepare(
    'SELECT * FROM collection_file_attachment_versions WHERE version_id=?').get(id) as VersionRow | undefined;
  const library = (id: string): DataFileRecord | undefined => {
    const table = sourceTable(); if (!table) return undefined;
    const row = db.prepare(`SELECT * FROM ${quoteSqliteIdent(table)} WHERE record_id=?`).get(id) as
      { record_id: string; received_at: number; modified_at: number; hot_fields: string; size_bytes: number; source_id: string; blob_hash: string | null } | undefined;
    if (!row?.blob_hash) return undefined;
    return { ...row, hot_fields: JSON.parse(row.hot_fields), blob_hash: row.blob_hash,
      storage_ref: { kind: 'cas', blob_hash: row.blob_hash } };
  };
  const rootId = (id: string): string => version(id)?.source_id ?? id;
  const selectionFor = (record: DataFileRecord): FileAttachmentSelection => {
    const hot = record.hot_fields;
    if (record.storage_ref.kind !== 'cas' || record.storage_ref.blob_hash !== hot.content_hash) {
      throw new RpcError('bad_request', 'This file is not retained locally.', 409);
    }
    return { file_id: record.record_id, media_class: hot.media_class, filename: hot.filename,
      mime_type: hot.mime_type, size: hot.size,
      selection_revision: hash(JSON.stringify([record.record_id, record.received_at, hot.content_hash, hot.filename, hot.mime_type, hot.size])) };
  };
  const selection = (id: string): FileAttachmentSelection => {
    const record = version(id) ? getVersion(id) : library(id);
    if (!record) throw new RpcError('file_not_found', 'This file is no longer available. Choose another file.', 409);
    return selectionFor(record);
  };
  const listSelections = (args: FileAttachmentListRequest): FileAttachmentListResult => {
    if (!args || typeof args !== 'object' || Array.isArray(args)
      || (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 200))
      || (args.archived !== undefined && typeof args.archived !== 'boolean')
      || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100))) {
      throw new RpcError('bad_request', 'Invalid file search.', 400);
    }
    const query = (args.query ?? '').trim(); const archived = args.archived === true;
    const limit = args.limit ?? 30; const scope = hash(JSON.stringify([query, archived]));
    let after: { time: number; id: string } | undefined;
    if (args.cursor !== undefined) {
      try {
        if (typeof args.cursor !== 'string' || args.cursor.length > 500) throw new Error();
        const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString()) as { scope: string; time: number; id: string };
        if (cursor.scope !== scope || !Number.isSafeInteger(cursor.time) || !/^file:[0-9a-f]{32}$/.test(cursor.id)) throw new Error();
        after = cursor;
      } catch { throw new RpcError('bad_request', 'File search changed. Search again.', 400); }
    }
    const table = sourceTable(); if (!table) throw new RpcError('not_configured', 'Retained files are unavailable.', 503);
    // Filter before limiting: older matching files must remain discoverable.
    const rows = db.prepare(`SELECT record_id,modified_at FROM ${quoteSqliteIdent(table)}
      WHERE blob_hash IS NOT NULL AND COALESCE(json_extract(hot_fields,'$.archived'),0)=?
        AND instr(lower(json_extract(hot_fields,'$.filename')),lower(?))>0
        ${after ? 'AND (modified_at < ? OR (modified_at = ? AND record_id > ?))' : ''}
      ORDER BY modified_at DESC,record_id ASC LIMIT ?`).all(
      archived ? 1 : 0, query, ...(after ? [after.time, after.time, after.id] : []), limit + 1,
    ) as Array<{ record_id: string; modified_at: number }>;
    const page = rows.slice(0, limit); const last = page.at(-1);
    return { files: page.map(row => selection(row.record_id)),
      ...(rows.length > limit && last ? { next_cursor: Buffer.from(JSON.stringify({ scope, time: last.modified_at, id: last.record_id })).toString('base64url') } : {}) };
  };
  const preparedOne = (attachment: ChatMessageAttachment, legacy: boolean): PreparedFile => {
    if (!legacy && attachment.selection_revision !== undefined
      && (typeof attachment.selection_revision !== 'string' || !/^[0-9a-f]{64}$/.test(attachment.selection_revision)
        || selection(attachment.file_id).selection_revision !== attachment.selection_revision)) {
      throw new RpcError('bad_request', 'The selected file changed. Remove it and choose it again before sending.', 409);
    }
    const found = version(attachment.file_id);
    if (found) {
      if (found.state !== 'retained' && !legacy) throw new RpcError('file_not_found', 'The attached file was deleted. Remove it before sending.', 409);
      return { attachment: { file_id: found.version_id, media_class: attachment.media_class, ...(legacy || attachment.legacy_capture ? { legacy_capture: true } : {}) }, version: found, existing: true };
    }
    const record = library(attachment.file_id);
    if (!record && !legacy) throw new RpcError('file_not_found', 'The attached file is unavailable. Remove it before sending.', 409);
    const snapshot = record ?? { record_id: attachment.file_id, received_at: 0, modified_at: 0, size_bytes: 0,
      source_id: attachment.file_id, hot_fields: { filename: 'Attachment', mime_type: 'application/octet-stream',
        size: 0, content_hash: '', origin: 'webclient_upload', media_class: attachment.media_class, scan_status: 'unscanned' },
      storage_ref: { kind: 'cas', blob_hash: '' } } as DataFileRecord;
    const hot = snapshot.hot_fields;
    if (record && (record.storage_ref.kind !== 'cas' || hot.content_hash !== record.storage_ref.blob_hash)) throw new RpcError('bad_request', 'Attachment content identity is inconsistent.', 409);
    const identity = JSON.stringify([attachment.file_id, snapshot.received_at, hot.content_hash, hot.filename, hot.mime_type, hot.size]);
    const version_id = `file:${hash(`attachment-version:${identity}`).slice(0, 32)}`;
    const prior = version(version_id);
    if (prior?.state === 'deleted' && !legacy) throw new RpcError('file_not_found', 'The attached version was permanently deleted.', 409);
    return { attachment: { file_id: version_id, media_class: attachment.media_class, ...(legacy ? { legacy_capture: true } : {}) },
      ...(record ? { expected: JSON.stringify(record) } : {}),
      version: prior ?? { version_id, source_id: attachment.file_id, blob_hash: record?.storage_ref.kind === 'cas' ? record.storage_ref.blob_hash : null,
        content_hash: hot.content_hash, record_json: JSON.stringify({ ...snapshot, record_id: version_id }),
        state: record ? 'retained' : 'missing', legacy: legacy ? 1 : 0, scan_status: hot.scan_status } };
  };
  const prepare = (attachments: readonly ChatMessageAttachment[], legacy = false): PreparedAttachments => {
    if (!configured()) return attachments.some(file => file.selection_revision !== undefined)
      ? { files: [], error: new RpcError('not_configured', 'Retained files are unavailable.', 503) } : { files: [] };
    try { return { files: attachments.map(attachment => preparedOne(attachment, legacy)) }; }
    catch (error) { return { files: [], error: error instanceof Error ? error : new Error('Attachment unavailable.') }; }
  };
  const bind = (kind: 'queue' | 'message', owner: string, session: string, prepared: PreparedAttachments): void => {
    if (prepared.error) throw prepared.error;
    for (const file of prepared.files) {
      const v = file.version;
      if (file.expected !== undefined && JSON.stringify(library(v.source_id)) !== file.expected) {
        throw new RpcError('bad_request', 'The attachment changed while accepting the message. Try again.', 409);
      }
      const current = version(v.version_id);
      if (file.existing && !current) throw new RpcError('file_not_found', 'The retained attachment was released before acceptance.', 409);
      if (current && current.state !== v.state) throw new RpcError('file_not_found', 'The attachment was deleted while accepting the message.', 409);
      db.prepare(`INSERT OR IGNORE INTO collection_file_attachment_versions
        (version_id, source_id, blob_hash, content_hash, record_json, state, legacy, scan_status)
        VALUES (@version_id,@source_id,@blob_hash,@content_hash,@record_json,@state,@legacy,@scan_status)`).run(v);
      db.prepare('INSERT OR IGNORE INTO file_attachment_bindings VALUES (?,?,?,?)').run(kind, owner, session, v.version_id);
    }
  };
  const getVersion = (id: string): DataFileRecord | null => {
    const v = version(id); if (!v || v.state !== 'retained' || !v.blob_hash) return null;
    const record = JSON.parse(v.record_json) as DataFileRecord;
    return { ...record, hot_fields: { ...record.hot_fields, scan_status: v.scan_status as DataFileRecord['hot_fields']['scan_status'] } };
  };
  const describe = (attachment: ChatMessageAttachment): ChatMessageAttachment => {
    const v = version(attachment.file_id); if (!v) return attachment;
    const record = JSON.parse(v.record_json) as DataFileRecord;
    return { ...attachment, filename: record.hot_fields.filename, mime_type: record.hot_fields.mime_type,
      size: record.hot_fields.size, source_file_id: v.source_id,
      availability: v.state === 'retained' ? 'available' : v.state, ...(v.legacy ? { legacy_capture: true } : {}) };
  };
  const migrateMessages = (sessionId?: string): void => {
    if (!configured() || !exists(db, 'chat_messages')) return;
    db.transaction(() => {
      const rows = db.prepare(`SELECT message_id, session_id, attachments_blob FROM chat_messages m
        WHERE attachments_blob IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM file_attachment_bindings b WHERE b.kind='message' AND b.owner_id=m.message_id)
          ${sessionId === undefined ? '' : 'AND m.session_id=?'}`).all(...(sessionId === undefined ? [] : [sessionId])) as
        Array<{ message_id: string; session_id: string; attachments_blob: string }>;
      for (const row of rows) {
        const files = JSON.parse(row.attachments_blob) as ChatMessageAttachment[];
        if (!Array.isArray(files) || !files.every(f => f && typeof f.file_id === 'string' && typeof f.media_class === 'string')) continue;
        const prepared = prepare(files, true); bind('message', row.message_id, row.session_id, prepared);
        if (prepared.files.length) db.prepare('UPDATE chat_messages SET attachments_blob=? WHERE message_id=?')
          .run(JSON.stringify(prepared.files.map(f => f.attachment)), row.message_id);
      }
    }).immediate();
  };
  const reapLeases = (): void => {
    const leases = db.prepare('SELECT token,pid,started_at FROM collection_file_attachment_leases').all() as
      Array<{ token: string; pid: number; started_at: number }>;
    for (const lease of leases) {
      let alive = true;
      if (lease.pid === process.pid) alive = Math.abs(lease.started_at - processStarted) < 2000;
      else try { process.kill(lease.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (!alive) db.prepare('DELETE FROM collection_file_attachment_leases WHERE token=?').run(lease.token);
    }
  };
  const lease = (id: string, expectedHash?: string): (() => void) => db.transaction(() => {
    const file = getVersion(id) ?? library(id);
    if (!file || file.storage_ref.kind !== 'cas') throw new RpcError('file_not_found', 'Retained file unavailable.', 404);
    if (expectedHash && file.storage_ref.blob_hash !== expectedHash) throw new RpcError('bad_request', 'File changed before the read. Try again.', 409);
    return leaseBlob(rootId(id), file.storage_ref.blob_hash);
  }).immediate();
  /** Protect bytes being imported before their library row is published. */
  const leaseBlob = (sourceId: string, blobHash: string): (() => void) => {
    const token = randomUUID();
    db.prepare('INSERT INTO collection_file_attachment_leases VALUES (?,?,?,?,?)')
      .run(token, sourceId, blobHash, process.pid, Math.round(processStarted));
    return () => { if (db.open) db.prepare('DELETE FROM collection_file_attachment_leases WHERE token=?').run(token); };
  };
  const usages = (source: string): FileUsage[] => {
    const bindings = db.prepare(`SELECT b.* FROM file_attachment_bindings b JOIN collection_file_attachment_versions v
      ON v.version_id=b.version_id WHERE v.source_id=? ORDER BY b.session_id,b.kind,b.owner_id,b.version_id`).all(source) as
      Array<{ kind: string; owner_id: string; session_id: string }>;
    const seen = new Set<string>(); const result: FileUsage[] = [];
    for (const b of bindings) {
      const key = `${b.kind}:${b.owner_id}`; if (seen.has(key)) continue; seen.add(key);
      if (b.kind === 'message') {
        const active = exists(db, 'chat_turn_queue') ? db.prepare(`SELECT q.status FROM chat_messages m
          JOIN chat_turn_queue q ON q.turn_id=m.turn_id WHERE m.message_id=? AND q.status IN ('running','cancelling')`).get(b.owner_id) as { status: string } | undefined : undefined;
        result.push({ session_id: b.session_id, message_id: b.owner_id, state: active?.status ?? 'retained' });
      }
      else if (exists(db, 'chat_turn_queue')) {
        const row = db.prepare('SELECT status FROM chat_turn_queue WHERE turn_id=?').get(b.owner_id) as { status: string } | undefined;
        if (row) result.push({ session_id: b.session_id, turn_id: b.owner_id, state: row.status });
      }
    }
    return result;
  };
  const preview = (id: string): FileLifecyclePreview => {
    migrateMessages(); reapLeases();
    if (exists(db, 'chat_turn_queue') && (db.prepare('PRAGMA table_info(chat_turn_queue)').all() as Array<{ name: string }>).some(c => c.name === 'attachments_indexed')
      && db.prepare('SELECT 1 FROM chat_turn_queue WHERE attachments_indexed=0 LIMIT 1').get()) {
      throw new RpcError('not_configured', 'Attachment history is still being indexed. Unlock the vault and try again shortly.', 503);
    }
    const source = rootId(id); const current = library(source);
    const versions = db.prepare('SELECT * FROM collection_file_attachment_versions WHERE source_id=? ORDER BY version_id').all(source) as VersionRow[];
    if (!current && !versions.length) throw new RpcError('file_not_found', 'File no longer available.', 404);
    const users = usages(source);
    const deliveries = exists(db, 'chat_deliveries') ? db.prepare(`SELECT DISTINCT d.delivery_id,d.state FROM chat_deliveries d
      JOIN file_attachment_bindings b ON b.kind='message' AND b.owner_id=d.message_id
      JOIN collection_file_attachment_versions v ON v.version_id=b.version_id WHERE v.source_id=? AND d.state NOT IN ('sent','skipped')
      ORDER BY d.delivery_id`).all(source) as Array<{ delivery_id: string; state: string }> : [];
    const leases = db.prepare('SELECT token FROM collection_file_attachment_leases WHERE source_id=? ORDER BY token').all(source);
    const revision = hash(JSON.stringify([source, current, versions, users, deliveries, leases]));
    const snapshot = current ?? (versions[0] ? JSON.parse(versions[0].record_json) as DataFileRecord : undefined);
    return { record_id: source, filename: snapshot?.hot_fields.filename ?? 'File', revision,
      ...(snapshot?.hot_fields.cloud_capture ? { cloud_capture: snapshot.hot_fields.cloud_capture } : {}),
      archived: !current || current.hot_fields.archived === 1, deleted: !current && versions.every(v => v.state !== 'retained'),
      message_count: users.filter(u => u.message_id).length, conversation_count: new Set(users.map(u => u.session_id)).size,
      queued_count: users.filter(u => u.state === 'queued').length, delivery_count: deliveries.length,
      in_use: leases.length > 0 || users.some(u => u.state === 'running' || u.state === 'cancelling') || deliveries.some(d => d.state === 'sending'),
      usages: users.slice(0, 100), usages_truncated: users.length > 100 };
  };
  const assertDelete = (id: string): void => {
    migrateMessages();
    if (exists(db, 'chat_turn_queue') && (db.prepare('PRAGMA table_info(chat_turn_queue)').all() as Array<{ name: string }>).some(c => c.name === 'attachments_indexed')
      && db.prepare('SELECT 1 FROM chat_turn_queue WHERE attachments_indexed=0 LIMIT 1').get()) {
      throw new RpcError('bad_request', 'Attachment history is still being indexed. Try again shortly.', 409);
    }
    const source = rootId(id);
    if (version(id) || db.prepare('SELECT 1 FROM collection_file_attachment_versions WHERE source_id=? LIMIT 1').get(source)) {
      throw new RpcError('bad_request', 'File is retained by conversations. Review its usage in Data → Files before deleting.', 409);
    }
    reapLeases();
    if (db.prepare('SELECT 1 FROM collection_file_attachment_leases WHERE source_id=? LIMIT 1').get(source)) {
      throw new RpcError('bad_request', 'File currently in use. Try again after the operation finishes.', 409);
    }
  };
  const mutate = (id: string, action: 'archive' | 'delete', revision: string, remove: (id: string) => void): FileLifecycleResult => db.transaction(() => {
    const request = hash(JSON.stringify([id, action, revision]));
    const receipt = db.prepare('SELECT result FROM file_lifecycle_receipts WHERE request_id=?').get(request) as { result: string } | undefined;
    if (receipt) return { ...JSON.parse(receipt.result) as FileLifecyclePreview, replayed: true };
    const before = preview(id);
    if (before.revision !== revision) throw new RpcError('bad_request', 'File usage changed. Review the updated impact before confirming again.', 409);
    if (action === 'delete' && before.in_use) throw new RpcError('bad_request', 'File currently in use. Try again after the operation finishes.', 409);
    db.prepare('INSERT INTO file_attachment_delete_permits VALUES (?)').run(before.record_id);
    try { remove(before.record_id); } finally { db.prepare('DELETE FROM file_attachment_delete_permits WHERE source_id=?').run(before.record_id); }
    if (action === 'delete') {
      db.prepare("UPDATE collection_file_attachment_versions SET blob_hash=NULL,state='deleted' WHERE source_id=?").run(before.record_id);
      if (exists(db, 'chat_turn_queue')) {
        const queued = db.prepare(`SELECT DISTINCT q.turn_id,q.session_id FROM chat_turn_queue q
          JOIN file_attachment_bindings b ON b.kind='queue' AND b.owner_id=q.turn_id
          JOIN collection_file_attachment_versions v ON v.version_id=b.version_id WHERE v.source_id=? AND q.status='queued'`).all(before.record_id) as Array<{ turn_id: string; session_id: string }>;
        for (const q of queued) {
          db.prepare("UPDATE chat_turn_queue SET status='failed',failure_reason='attachment_deleted' WHERE turn_id=?").run(q.turn_id);
          db.prepare('UPDATE chat_queue_revisions SET revision=revision+1 WHERE session_id=?').run(q.session_id);
        }
      }
    }
    const result = { ...before, archived: true, deleted: action === 'delete', revision: '', usages: [], usages_truncated: false };
    db.prepare('INSERT INTO file_lifecycle_receipts VALUES (?,?)').run(request, JSON.stringify(result));
    return result;
  }).immediate();
  const register = (slug: string, table: string): void => {
    db.prepare('INSERT INTO file_attachment_sources VALUES (?,?) ON CONFLICT(slug) DO UPDATE SET table_name=excluded.table_name').run(slug, table);
    if (slug !== 'received') return;
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${quoteSqliteIdent(`${table}_attachment_delete_guard`)} BEFORE DELETE ON ${quoteSqliteIdent(table)}
      WHEN NOT EXISTS (SELECT 1 FROM file_attachment_delete_permits WHERE source_id=OLD.record_id) AND (
        EXISTS (SELECT 1 FROM collection_file_attachment_versions WHERE source_id=OLD.record_id) OR
        EXISTS (SELECT 1 FROM collection_file_attachment_leases WHERE source_id=OLD.record_id))
      BEGIN SELECT RAISE(ABORT,'File retained or currently in use. Review its usage before deleting.'); END;`);
    if (exists(db, 'chat_turn_queue') && (db.prepare('PRAGMA table_info(chat_turn_queue)').all() as Array<{ name: string }>).some(c => c.name === 'attachments_indexed')) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${quoteSqliteIdent(`${table}_attachment_index_guard`)} BEFORE DELETE ON ${quoteSqliteIdent(table)}
        WHEN EXISTS (SELECT 1 FROM chat_turn_queue WHERE attachments_indexed=0)
        BEGIN SELECT RAISE(ABORT,'Attachment history is still being indexed.'); END;`);
    }
    migrateMessages();
  };
  const sessions = (id: string): string[] => [...new Set(usages(rootId(id)).map(u => u.session_id))];
  const resolveSnapshot = (id: string, blob: string, filename: string, mime: string, size: number): string | undefined => {
    // An explicit version can never follow a newer upload after purge/release.
    const exact = version(id); if (exact) return exact.state === 'retained' ? id : undefined;
    const rows = db.prepare("SELECT version_id,record_json FROM collection_file_attachment_versions WHERE source_id=? AND blob_hash=? AND state='retained'")
      .all(rootId(id), blob) as Array<{ version_id: string; record_json: string }>;
    return rows.find(row => { const record = JSON.parse(row.record_json) as DataFileRecord;
      return record.hot_fields.filename === filename && record.hot_fields.mime_type === mime && record.hot_fields.size === size;
    })?.version_id;
  };
  const registered = sourceTable(); if (registered) register('received', registered);
  return { configured, prepare, bind, getVersion, describe, version, rootId, migrateMessages, lease, sessions, resolveSnapshot,
    preview, assertDelete, mutate, register, selection, listSelections, leaseBlob,
    conversationFiles: (args: ConversationFileListRequest) => listConversationFiles(db, args, {
      prepare: () => migrateMessages(args.session_id), archived: id => library(id)?.hot_fields.archived === 1,
    }) };
};
export type FileAttachmentLifecycle = ReturnType<typeof createFileAttachmentLifecycle>;
