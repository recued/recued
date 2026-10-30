/** Derived document text in the realm's encrypted SQLite database. No file bytes
 * or extracted text are written to a separate plaintext database. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ChatDispatchContext } from '@recued/contracts';
import { FTS_CONTENT_FORMAT, segmentUnspacedForFts, toFtsMatch } from '@recued/fts';
import { collectionTableName } from '../collections/table.js';
import { quoteSqliteIdent } from './collection-blob-refs.js';

export type DocumentIndexStatus = 'indexed' | 'unreadable' | 'missing_converter' | 'too_large' | 'empty_extraction' | 'unsupported_encoding';
export interface DocumentIndexEntry {
  authority: string;
  fingerprint: string;
  file_ref: string;
  content_hash: string;
  status: DocumentIndexStatus;
  text: string;
  converter: string;
  read_version: string;
  extraction_complete: boolean;
  updated_at: number;
}
export type DocumentIndexState = Omit<DocumentIndexEntry, 'text'>;

/** Owner conversations may share derived text. Distinct external identities and
 * contract versions cannot. Every hit still re-admits its source read. */
export const documentIndexAuthority = (ctx: ChatDispatchContext): string => createHash('sha256').update(JSON.stringify(
  [ctx.channel, ctx.mcp_token_id ?? null, ctx.execution_source ?? null,
    ctx.contract_snapshot ? [ctx.contract_snapshot.contract_id, ctx.contract_snapshot.contract_version] : null],
  (key, value: unknown) => ['turn_id', 'tool_call_id', 'chat_session_id'].includes(key) ? undefined : value,
)).digest('hex');

const keyOf = (authority: string, fingerprint: string): string => `${authority}:${fingerprint}`;
const FAILURE_TTL = 5 * 60 * 1000;
export const documentIndexUsable = (entry: DocumentIndexState | undefined, now: number): boolean =>
  entry !== undefined && (entry.status === 'indexed' || now - entry.updated_at < FAILURE_TTL);

export const createDocumentSearchIndex = (db: Database.Database, options: { maxTextBytes?: number; maxEntries?: number } = {}) => {
  const maxTextBytes = options.maxTextBytes ?? 64 * 1024 * 1024;
  const maxEntries = options.maxEntries ?? 2000;
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_search_entries (
      id INTEGER PRIMARY KEY, entry_key TEXT NOT NULL UNIQUE,
      authority TEXT NOT NULL, fingerprint TEXT NOT NULL, file_ref TEXT NOT NULL,
      content_hash TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL,
      converter TEXT NOT NULL, read_version TEXT NOT NULL,
      extraction_complete INTEGER NOT NULL, updated_at INTEGER NOT NULL, text_bytes INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS document_search_authority ON document_search_entries(authority);
    CREATE INDEX IF NOT EXISTS document_search_file ON document_search_entries(file_ref);
    CREATE TABLE IF NOT EXISTS document_search_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    CREATE VIRTUAL TABLE IF NOT EXISTS document_search_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER IF NOT EXISTS document_search_entry_deleted AFTER DELETE ON document_search_entries
      BEGIN DELETE FROM document_search_fts WHERE rowid=OLD.id; END;
  `);
  // Shared token segmentation can change between releases. Rebuild the derived
  // FTS rows atomically from the retained text instead of leaving old files
  // silently unsearchable under the new query format.
  const format = db.prepare("SELECT value FROM document_search_meta WHERE key='fts_format'").get() as { value: number } | undefined;
  if (format?.value !== FTS_CONTENT_FORMAT) db.transaction(() => {
    db.prepare('DELETE FROM document_search_fts').run();
    const page = db.prepare("SELECT id,text FROM document_search_entries WHERE id>? AND status='indexed' ORDER BY id LIMIT 64");
    const insertFts = db.prepare('INSERT INTO document_search_fts(rowid,text) VALUES (?,?)');
    let after = 0;
    for (;;) {
      const rows = page.all(after) as Array<{ id: number; text: string }>;
      if (!rows.length) break;
      for (const row of rows) { insertFts.run(row.id, segmentUnspacedForFts(row.text)); after = row.id; }
    }
    db.prepare("INSERT OR REPLACE INTO document_search_meta(key,value) VALUES ('fts_format',?)").run(FTS_CONTENT_FORMAT);
  })();
  // These triggers also cover direct retention/lifecycle SQL. A later source
  // replacement must not leave derived text behind until somebody searches.
  const installLifecycleTriggers = (): void => {
    for (const [table, identity] of [[collectionTableName('file', 'received'), 'record_id'],
      ['collection_file_attachment_versions', 'version_id']] as const) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      for (const event of ['DELETE', 'UPDATE'] as const) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${quoteSqliteIdent(`document_search_${table}_${event.toLowerCase()}`)}
          AFTER ${event} ON ${quoteSqliteIdent(table)} BEGIN
          DELETE FROM document_search_entries WHERE file_ref=OLD.${identity}; END;`);
      }
    }
  };
  installLifecycleTriggers();
  const remove = db.prepare('DELETE FROM document_search_entries WHERE entry_key=?');
  const insert = db.prepare(`INSERT INTO document_search_entries
    (entry_key,authority,fingerprint,file_ref,content_hash,status,text,converter,read_version,extraction_complete,updated_at,text_bytes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const decode = (row: unknown): DocumentIndexEntry | undefined => {
    if (!row) return undefined;
    const entry = row as Omit<DocumentIndexEntry, 'extraction_complete'> & { extraction_complete: number };
    return { ...entry, extraction_complete: entry.extraction_complete === 1 };
  };
  const put = db.transaction((entry: DocumentIndexEntry): boolean => {
    const bytes = Buffer.byteLength(entry.text, 'utf8');
    if (bytes > maxTextBytes) return false;
    const key = keyOf(entry.authority, entry.fingerprint);
    remove.run(key);
    const row = insert.run(key, entry.authority, entry.fingerprint, entry.file_ref, entry.content_hash,
      entry.status, entry.text, entry.converter, entry.read_version, entry.extraction_complete ? 1 : 0, entry.updated_at, bytes);
    if (entry.status === 'indexed') db.prepare('INSERT INTO document_search_fts(rowid,text) VALUES (?,?)')
      .run(row.lastInsertRowid, segmentUnspacedForFts(entry.text));
    let usage = db.prepare('SELECT count(*) AS entries, coalesce(sum(text_bytes),0) AS bytes FROM document_search_entries').get() as { entries: number; bytes: number };
    while (usage.entries > maxEntries || usage.bytes > maxTextBytes) {
      const oldest = db.prepare('SELECT id,text_bytes FROM document_search_entries ORDER BY updated_at,id LIMIT 1').get() as { id: number; text_bytes: number };
      db.prepare('DELETE FROM document_search_entries WHERE id=?').run(oldest.id);
      usage = { entries: usage.entries - 1, bytes: usage.bytes - oldest.text_bytes };
    }
    return db.prepare('SELECT 1 FROM document_search_entries WHERE entry_key=?').get(key) !== undefined;
  });
  return {
    installLifecycleTriggers,
    get: (authority: string, fingerprint: string): DocumentIndexEntry | undefined => decode(
      db.prepare('SELECT * FROM document_search_entries WHERE entry_key=?').get(keyOf(authority, fingerprint))),
    hasIndexed: (authority: string, fingerprint: string): boolean => db.prepare(
      "SELECT 1 FROM document_search_entries WHERE entry_key=? AND status='indexed'").get(keyOf(authority, fingerprint)) !== undefined,
    states: (authority: string): DocumentIndexState[] => db.prepare(`SELECT authority,fingerprint,file_ref,content_hash,status,
      converter,read_version,extraction_complete,updated_at FROM document_search_entries WHERE authority=?`).all(authority)
      .map(row => decode(row)!),
    put: (entry: DocumentIndexEntry): boolean => put(entry),
    deleteFile: (file_ref: string): void => { db.prepare('DELETE FROM document_search_entries WHERE file_ref=?').run(file_ref); },
    search: (authority: string, fingerprints: string[], query: string, limit: number, offset = 0): DocumentIndexEntry[] => {
      const expression = toFtsMatch(query);
      if (!expression || !fingerprints.length) return [];
      return db.prepare(`SELECT e.* FROM document_search_fts JOIN document_search_entries e ON e.id=document_search_fts.rowid
        WHERE document_search_fts MATCH ? AND e.authority=? AND e.status='indexed'
          AND e.fingerprint IN (SELECT value FROM json_each(?))
        ORDER BY bm25(document_search_fts),e.file_ref LIMIT ? OFFSET ?`)
        .all(expression, authority, JSON.stringify(fingerprints), limit, offset).map(row => decode(row)!);
    },
  };
};
export type DocumentSearchIndex = ReturnType<typeof createDocumentSearchIndex>;
