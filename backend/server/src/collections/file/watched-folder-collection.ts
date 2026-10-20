/** D-106 follow-up — a watched folder's records (2026-10-10).
 *
 *  Production watches every enrolled `fs` folder through the D-110 file stack
 *  (`compose.ts` → `adapters/fs`). Until 2026-10-10 every event that watcher
 *  produced was dropped (`onEvent` defaulted to a no-op): a watched folder gave
 *  no records, no search hits and no `data.file.*` trigger, while the Phase D
 *  collection that once turned those events into records had no production
 *  caller. This is the collection the stack now feeds. It owns NO watcher, so a
 *  folder is walked and watched once, by its adapter.
 *
 *  One per enrolled folder, registered as `('file', <slug>)`:
 *    - a record per file: `filename`, `path` (relative to the folder, POSIX
 *      separators), `mime_type`, `size`, `mtime`. The bytes stay on disk; only
 *      a small text file's text is kept, for search (`TEXT_KEPT_BYTES`, and only
 *      while the folder's gate admits it).
 *    - search over the name, the path and the kept text.
 *    - `data.file.<slug>.file.{created,updated,deleted}` on the warehouse bus.
 *      An `updated` only when something changed, so a restart's walk, which
 *      lists every stored file again, is quiet.
 *    - after a walk that read every directory, a stored file the walk did not
 *      see is taken out: it went while the server was down, or the folder's
 *      path was changed.
 *    - a removal naming a folder inside it takes out the files under that
 *      folder: a folder moved out is reported as the folder alone.
 *
 *  Record ids are `file:local:<b64url slug>:<b64url path>`, reversible like
 *  `file:remote:*`. ⛔ Never the `file:<32 hex>` shape: that means "bytes in the
 *  CAS" to every reader of a file ref (`isInboundFileRecordId`), and a watched
 *  file's bytes are not there. */

import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { StorageGate } from '@recued/storage-gate';
import type {
  CollectionAuthState,
  CollectionHealth,
  CollectionListQuery,
  CollectionRecord,
  CollectionSearchMatch,
  CollectionSearchQuery,
  CollectionState,
} from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import { quoteSqliteIdent } from '../../storage/collection-blob-refs.js';
import { changedHotFields, createCollectionEmitter } from '../events.js';
import { createCollectionRetention } from '../retention.js';
import { createCollectionTable, INLINE_CUTOFF_BYTES, type CollectionTable } from '../table.js';
import type { Collection, CollectionPruneResult, CollectionSyncAdapter } from '../types.js';
import type { FileAdapterEvent, FileMutationCapable } from './adapter-registry.js';

/** The largest text file whose text is kept for search: the table's inline
 *  cutoff, so kept text is always searchable (a CAS-stored body never is). */
export const TEXT_KEPT_BYTES = INLINE_CUTOFF_BYTES;

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.css': 'text/css',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};

/** By extension; unknown is `application/octet-stream`. */
export const sniffMimeType = (path: string): string =>
  MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';

const isTextMime = (mime: string): boolean =>
  mime.startsWith('text/')
  || mime === 'application/json'
  || mime === 'application/yaml'
  || mime === 'application/toml'
  || mime === 'application/xml';

const toPosix = (p: string): string => p.split(sep).join('/');

const LOCAL_ID_PREFIX = 'file:local:';

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

/** Strict: the canonical unpadded alphabet, and a re-encode that matches
 *  (Node's decoder silently skips stray characters). `null` = not canonical. */
const unb64urlStrict = (enc: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(enc)) return null;
  const decoded = Buffer.from(enc, 'base64url').toString('utf8');
  return Buffer.from(decoded, 'utf8').toString('base64url') === enc ? decoded : null;
};

/** The record id of the file at `path` (relative, POSIX) in folder `slug`. */
export const watchedFileRecordId = (slug: string, path: string): string =>
  `${LOCAL_ID_PREFIX}${b64url(slug)}:${b64url(path)}`;

/** Back to `(slug, path)`, or `null` for anything that is not one. */
export const parseWatchedFileRecordId = (
  record_id: string,
): { slug: string; path: string } | null => {
  if (!record_id.startsWith(LOCAL_ID_PREFIX)) return null;
  const parts = record_id.slice(LOCAL_ID_PREFIX.length).split(':');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) return null;
  const slug = unb64urlStrict(parts[0]);
  const path = unb64urlStrict(parts[1]);
  if (slug === null || path === null || slug.length === 0 || path.length === 0) return null;
  return { slug, path };
};

/** Text, or `null` when the bytes are not clean UTF-8 text. */
const decodeText = (bytes: Uint8Array): string | null => {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return text.includes('\u0000') ? null : text;
};

/** What one event did: the file backfill audit counts `stored` and `failed`
 *  during a walk. */
export type WatchedFileIngest =
  | { outcome: 'stored'; mtime: number }
  | { outcome: 'removed' | 'unchanged_absent' | 'outside' }
  | { outcome: 'failed' };

/** Why a watched file's bytes could not be read. */
export type WatchedFileReadFailure = 'folder_unavailable' | 'not_found' | 'too_large';

export class WatchedFileReadError extends Error {
  constructor(readonly reason: WatchedFileReadFailure, message: string) {
    super(message);
    this.name = 'WatchedFileReadError';
  }
}

/** The adapter's side of health, which this collection cannot see: whether
 *  the folder's adapter is running, whether a realtime watch is attached right
 *  now, and the instance's auth state. */
export interface WatchedFolderStatus {
  running: boolean;
  watching: boolean;
  auth_state: CollectionAuthState;
}

export interface WatchedFolderCollection extends Collection {
  /** Tells a watched folder from the received files, the other `file` collection. */
  readonly watchedFolder: true;
  /** One adapter event. Events are applied one at a time, in arrival order. */
  ingest(event: FileAdapterEvent): Promise<WatchedFileIngest>;
  /** The adapter is about to walk the folder: remember what is stored. */
  beginWalk(): void;
  /** The walk is over. `complete`: it read every directory. Only then is a
   *  stored file it did not see taken out — a walk that could not read part of
   *  the folder is no list of what is on disk. */
  endWalk(opts: { complete: boolean }): Promise<void>;
  /** When the last walk ended, or 0 before the first. */
  lastWalkAt(): number;
  /** The folder's enrollment was deleted: its tables go, with no events —
   *  removing a source is not deleting its files. */
  drop(): void;
  /** Bytes kept for search, for the gate. */
  totalBytes(): number;
  /** One file's bytes, read from disk through the folder's live adapter (which
   *  refuses a path outside the folder). Throws `WatchedFileReadError`. */
  readFile(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; mime_type: string; filename: string }>;
}

export const isWatchedFolderCollection = (collection: Collection): collection is WatchedFolderCollection =>
  (collection as Partial<WatchedFolderCollection>).watchedFolder === true;

export interface CreateWatchedFolderCollectionOptions {
  db: Database.Database;
  gate: StorageGate;
  bus: WarehouseEventBus;
  slug: string;
  /** The folder, read live, so an edited path applies at the next walk. */
  root: () => string;
  status: () => WatchedFolderStatus;
  /** The folder's live adapter, or undefined while it is not running. */
  adapter: () => FileMutationCapable | undefined;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const createWatchedFolderCollection = (
  opts: CreateWatchedFolderCollectionOptions,
): WatchedFolderCollection => {
  const { db, gate, bus, slug, log } = opts;
  const nowOf = (): number => opts.now?.() ?? Date.now();

  const table: CollectionTable = createCollectionTable({
    db,
    platform: 'file',
    slug,
    onBytesChanged: (delta) => { gate.addUsed(delta); },
    ftsTextFor: (record) => [
      typeof record.hot_fields.filename === 'string' ? record.hot_fields.filename : '',
      typeof record.hot_fields.path === 'string' ? record.hot_fields.path : '',
      record.body_inline ?? '',
    ].join('\n'),
  });
  const emitter = createCollectionEmitter({
    bus,
    platform: 'file',
    slug,
    entityType: 'file',
    now: nowOf,
  });
  // The owner's files are never pruned by age.
  const retention = createCollectionRetention({
    table,
    platform: 'file',
    slug,
    now: nowOf,
    config: () => ({ retentionDays: 0 }),
  });

  let lastWalkAt = 0;
  let walking = false;
  let storedBeforeWalk: string[] = [];
  const walked = new Set<string>();
  let failures: number[] = [];
  let tail: Promise<unknown> = Promise.resolve();

  /** Applied one at a time: a `change` then a `remove` of one file must not
   *  race, and the walk's reconciliation must see every event before it. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  const failed = (absPath: string, err: unknown): WatchedFileIngest => {
    failures.push(nowOf());
    log?.('warn', `watched folder '${slug}': could not index ${absPath}`, {
      err: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'failed' };
  };

  const removeRecord = (recordId: string): WatchedFileIngest => {
    const prev = table.delete(recordId);
    if (!prev) return { outcome: 'unchanged_absent' };
    emitter.deleted(recordId, prev.hot_fields);
    return { outcome: 'removed' };
  };

  /** The records of the files under `path` (relative, POSIX): the folder's
   *  `source_id` range, which is indexed. */
  const recordIdsUnder = (path: string): string[] =>
    (db.prepare(`SELECT record_id FROM ${quoteSqliteIdent(table.tableName)} WHERE source_id >= ? AND source_id < ?`)
      .all(`${path}/`, `${path}0`) as { record_id: string }[])   // '0' is the character after '/'
      .map((row) => row.record_id);

  /** A path the watcher reports gone. Not a file's: then a folder's, and its
   *  files went with it — the watch may name only the folder. */
  const removePath = (path: string, recordId: string): WatchedFileIngest => {
    const file = removeRecord(recordId);
    if (file.outcome === 'removed') return file;
    let removed = false;
    for (const id of recordIdsUnder(path)) removed = removeRecord(id).outcome === 'removed' || removed;
    return removed ? { outcome: 'removed' } : file;
  };

  const apply = async (event: FileAdapterEvent): Promise<WatchedFileIngest> => {
    const rootAbs = resolve(opts.root());
    const absPath = resolve(event.path);
    const rel = relative(rootAbs, absPath);
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return { outcome: 'outside' };
    const path = toPosix(rel);
    const recordId = watchedFileRecordId(slug, path);
    if (walking && event.type === 'present') walked.add(recordId);
    if (event.type === 'remove') return removePath(path, recordId);

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(absPath);
    } catch (err) {
      // Gone between the watcher's look and ours: that is a removal.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return removeRecord(recordId);
      return failed(absPath, err);
    }
    if (!info.isFile()) return { outcome: 'outside' };
    try {
      const mime_type = sniffMimeType(absPath);
      const mtime = Math.floor(info.mtimeMs);
      const prev = table.get(recordId);
      // Unchanged since it was stored: nothing to read and nothing to write. A
      // restart's walk meets every stored file, so this is what keeps a large
      // folder's restart cheap.
      if (prev && prev.hot_fields.mtime === mtime && prev.hot_fields.size === info.size) {
        return { outcome: 'stored', mtime };
      }
      let body_inline: string | undefined;
      if (isTextMime(mime_type) && info.size <= TEXT_KEPT_BYTES) {
        const text = decodeText(await readFile(absPath));
        if (text !== null) {
          const keptBefore = prev?.body_inline !== undefined ? Buffer.byteLength(prev.body_inline, 'utf8') : 0;
          const growth = Buffer.byteLength(text, 'utf8') - keptBefore;
          if (growth <= 0 || gate.canWrite(growth).ok) body_inline = text;
        }
      }
      const record: CollectionRecord = {
        record_id: recordId,
        received_at: prev?.received_at ?? nowOf(),
        modified_at: mtime,
        hot_fields: { filename: basename(path), path, mime_type, size: info.size, mtime },
        size_bytes: body_inline !== undefined ? Buffer.byteLength(body_inline, 'utf8') : 0,
        source_id: path,
        ...(body_inline !== undefined ? { body_inline } : {}),
      };
      const before = table.upsert(record);
      if (before) {
        const changed = changedHotFields(before.hot_fields, record.hot_fields);
        if ((before.body_inline ?? null) !== (record.body_inline ?? null)) changed.push('body');
        // The file's fields ride the event, so a trigger's `filter` and the run
        // see the path without a read. Never the kept text.
        if (changed.length > 0) emitter.updated(recordId, before.hot_fields, changed, { record: record.hot_fields });
      } else {
        emitter.created(recordId, { record: record.hot_fields });
      }
      return { outcome: 'stored', mtime };
    } catch (err) {
      return failed(absPath, err);
    }
  };

  const storedIds = (): string[] =>
    (db.prepare(`SELECT record_id FROM ${quoteSqliteIdent(table.tableName)}`).all() as { record_id: string }[])
      .map((row) => row.record_id);

  const health = (): CollectionHealth => {
    const now = nowOf();
    failures = failures.filter((at) => now - at < DAY_MS);
    const status = opts.status();
    // Not running: its adapter failed to start, or was stopped. What is stored
    // stays readable, and stops being current.
    const state: CollectionState = walking ? 'syncing'
      : !status.running ? 'disconnected'
      : lastWalkAt > 0 ? 'connected' : 'idle';
    return {
      platform: 'file',
      slug,
      // A live watch reports every change as it happens, so what is stored is
      // current now. Without one, it is as current as the last walk.
      last_indexed_at: status.watching && lastWalkAt > 0 ? now : lastWalkAt,
      pending_queue_size: 0,
      error_count_24h: failures.length,
      state,
      auth_state: status.auth_state,
    };
  };

  // The adapter owns the watcher; nothing here starts or stops one.
  const sync: CollectionSyncAdapter = { async start() {}, async stop() {} };

  return {
    watchedFolder: true,
    platform: 'file',
    slug,
    gate,
    sync,
    upsert: (record) => { table.upsert(record); },
    delete: (record_id) => table.delete(record_id) !== null,
    get: (record_id) => table.get(record_id),
    list: (query: CollectionListQuery) => table.list(query),
    search: (query: CollectionSearchQuery): CollectionSearchMatch[] => table.search(query),
    health,
    runRetention: async (): Promise<CollectionPruneResult> => retention.run(),
    async close() {},
    ingest: (event) => serial(() => apply(event)),
    beginWalk() {
      walking = true;
      walked.clear();
      storedBeforeWalk = storedIds();
    },
    endWalk: ({ complete }) => serial(async () => {
      walking = false;
      lastWalkAt = nowOf();
      if (!complete) return;
      for (const recordId of storedBeforeWalk) {
        if (!walked.has(recordId)) removeRecord(recordId);
      }
      storedBeforeWalk = [];
      walked.clear();
    }),
    lastWalkAt: () => lastWalkAt,
    drop() {
      table.dropSchema();
      gate.setUsed(0);
    },
    totalBytes: () => table.totalBytes(),
    async readFile(path, maxBytes) {
      const adapter = opts.adapter();
      if (!adapter) {
        throw new WatchedFileReadError('folder_unavailable', `the folder '${slug}' is not being watched right now`);
      }
      const info = await adapter.statRecord(path);
      if (!info.exists) throw new WatchedFileReadError('not_found', `'${path}' is no longer in the folder '${slug}'`);
      const tooLarge = (size: number): WatchedFileReadError =>
        new WatchedFileReadError('too_large', `'${path}' is ${size} bytes; reading over ${maxBytes} bytes this way is refused`);
      if ((info.size_bytes ?? 0) > maxBytes) throw tooLarge(info.size_bytes ?? 0);
      const bytes = await adapter.readRecord(path);
      // It may have grown since the stat.
      if (bytes.length > maxBytes) throw tooLarge(bytes.length);
      return { bytes, mime_type: sniffMimeType(path), filename: basename(path) };
    },
  };
};
