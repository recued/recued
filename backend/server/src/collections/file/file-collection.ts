/** Phase D (D-106) — file collection.
 *
 *  Composes `CollectionTable` + `FsWatcher` + retention + emitter
 *  into the `Collection` surface the server's rpc dispatcher + drain
 *  orchestrator consume.
 *
 *  Body storage follows the spec's three-way split:
 *    size ≤ 64 KB                    → `body_inline` (FTS-indexed).
 *    64 KB < size ≤ max_body_bytes   → CAS blob via `blob_hash`.
 *    size > max_body_bytes           → record only, body_on_disk
 *                                      (no copy, no FTS).
 *
 *  Hot fields are hand-specified:
 *    { path, mime_type, size, mtime, on_disk_only? }
 *  MIME is extension-based (trivially enough for user files; a future
 *  Commit may layer content sniffing on top). `path` is stored
 *  relative to the configured root with POSIX separators so recipes
 *  don't break on path comparisons across machines.
 *
 *  Retention: file collections default to `retention_days: 0` (users
 *  own the filesystem; retention-based deletion would be surprising).
 *  `runRetention` still delegates to `CollectionRetention`, which
 *  short-circuits with `skipped_reason: 'retention_disabled'`.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import type Database from 'better-sqlite3';
import type { StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
import { createBackfillAuditRecorder } from '../../triggers/backfill-audit.js';
import type {
  CollectionHealth,
  CollectionListQuery,
  CollectionRecord,
  CollectionSearchMatch,
  CollectionSearchQuery,
  CollectionState,
} from '@recued/contracts';
import type { WarehouseEventBus } from '@recued/warehouse-events';

import type { BlobStore } from '../../storage/blob-store.js';
import type { CollectionInstanceStore } from '../instance-store.js';
import {
  createCollectionTable,
  INLINE_CUTOFF_BYTES,
  type CollectionTable,
} from '../table.js';
import { quoteSqliteIdent } from '../../storage/collection-blob-refs.js';
import { changedHotFields, createCollectionEmitter } from '../events.js';
import {
  createCollectionRetention,
  type CollectionRetention,
} from '../retention.js';
import type {
  Collection,
  CollectionPruneResult,
  CollectionSyncAdapter,
} from '../types.js';
import { createFsWatcher, type FsWatcher } from './fs-adapter.js';

/** Hard default matching the spec. Overridable per-collection from
 *  TOML; at 10 MB we still mirror the vast majority of user files
 *  while capping worst-case CAS growth. */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface FileCollectionConfig {
  /** Absolute directory to watch. */
  path: string;
  /** Glob patterns (gitignore-subset — see `fs-adapter.ts`). */
  ignore: string[];
  /** Ceiling on the bytes we'll mirror for a single file. Files
   *  above this are recorded (path + size + mtime + MIME) but their
   *  body stays on disk. */
  max_body_bytes: number;
  /** Forwarded to `CollectionRetention`. Defaults to 0 for files. */
  retention_days: number;
  /** Forwarded to the Phase B gate registration in bin.ts. */
  quota_bytes: number;
}

export interface CreateFileCollectionOptions {
  db: Database.Database;
  blobs: BlobStore;
  gate: StorageGate;
  bus: WarehouseEventBus;
  slug: string;
  config: () => FileCollectionConfig;
  auditLog?: AuditLogStore;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
  /** D-124 Phase 2.1 — instance store reference used to flip
   *  `collection_instances.backfill_complete` to true after the fs
   *  watcher's initial directory walk resolves. Optional so test
   *  harnesses that drive the watcher synthetically (no instance row)
   *  keep working; production stacks always supply it via the file
   *  compose root. */
  instances?: CollectionInstanceStore;
}

// ────────────────────────────────────────────────────────────────
// MIME detection — extension-based. Common types only; unknown
// extensions map to application/octet-stream. A future commit may
// layer content sniffing (first 4 KB) on top per the Phase D spec.
// ────────────────────────────────────────────────────────────────

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

export const sniffMimeType = (path: string): string => {
  const ext = extname(path).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
};

const toPosix = (p: string): string => p.split(sep).join('/');

const recordIdFor = (relativePath: string): string =>
  `file:${createHash('sha256').update(relativePath).digest('hex').slice(0, 32)}`;

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

export const createFileCollection = (
  opts: CreateFileCollectionOptions,
): Collection => {
  const { db, blobs, gate, bus, slug, log } = opts;
  const nowOf = (): number => opts.now?.() ?? Date.now();
  const initialConfig = opts.config();
  const rootAbs = resolve(initialConfig.path);

  const table: CollectionTable = createCollectionTable({
    db,
    platform: 'file',
    slug,
    onBytesChanged: (delta) => { gate.addUsed(delta); },
  });

  const emitter = createCollectionEmitter({
    bus,
    platform: 'file',
    slug,
    entityType: 'file',
    now: () => nowOf(),
  });

  const retention: CollectionRetention = createCollectionRetention({
    table,
    platform: 'file',
    slug,
    auditLog: opts.auditLog,
    now: () => nowOf(),
    config: () => ({ retentionDays: opts.config().retention_days }),
  });

  // Adapter-level bookkeeping for the health snapshot.
  let lastIndexedAt = 0;
  let errorCount24h = 0;
  let pending = 0;
  let state: CollectionState = 'idle';

  const bumpError = (): void => {
    errorCount24h++;
  };

  // D-124 Phase 2.4 — backfill audit recorder. Created at sync.start
  // and finished after `watcher.start()` resolves (or on throw). All
  // `present` events that ingest during the initial walk feed
  // `recordImport(mtime)`; failed ingests feed `recordFailure()`.
  // Post-finish calls become no-ops, so live `change` / `remove`
  // events that arrive after the initial walk don't pollute the
  // counts. fs-adapter attaches `fs.watch` only AFTER `scanDir`
  // resolves, so during the walk only `present` fires.
  let backfillRecorder: ReturnType<typeof createBackfillAuditRecorder> | undefined;

  const ingestEvent = async (type: 'present' | 'change' | 'remove', absPath: string): Promise<void> => {
    const relPath = toPosix(relative(rootAbs, absPath));
    const recordId = recordIdFor(relPath);
    const cfg = opts.config();
    try {
      if (type === 'remove') {
        const prev = table.delete(recordId);
        if (prev) emitter.deleted(recordId, prev.hot_fields);
        return;
      }

      const s = await stat(absPath);
      const size = s.size;
      const mtime = s.mtimeMs;
      const mimeType = sniffMimeType(absPath);
      const hotFields: Record<string, unknown> = {
        path: relPath,
        mime_type: mimeType,
        size,
        mtime,
      };

      let body_inline: string | undefined;
      let blob_hash: string | undefined;
      if (size <= INLINE_CUTOFF_BYTES) {
        // Treat as UTF-8 text if the MIME is textual; otherwise store
        // a base64 representation so binary bodies still round-trip.
        const bytes = await readFile(absPath);
        body_inline = mimeType.startsWith('text/') || mimeType === 'application/json'
          ? bytes.toString('utf8')
          : bytes.toString('base64');
      } else if (size <= cfg.max_body_bytes) {
        const bytes = await readFile(absPath);
        blob_hash = await blobs.put(bytes);
      } else {
        // Too big to mirror — record the metadata only. Callers see
        // `on_disk_only: true` in hot_fields and can open the file
        // directly via `path`.
        hotFields.on_disk_only = true;
      }

      const record: CollectionRecord = {
        record_id: recordId,
        received_at: nowOf(),
        modified_at: Math.floor(mtime),
        hot_fields: hotFields,
        size_bytes: size,
        source_id: relPath,
      };
      if (body_inline !== undefined) record.body_inline = body_inline;
      if (blob_hash !== undefined) record.blob_hash = blob_hash;

      const prev = table.upsert(record);
      if (prev) {
        // Only a change is an update, named by what changed: a restart's walk
        // lists every stored file again.
        const changed = changedHotFields(prev.hot_fields, record.hot_fields);
        if ((prev.body_inline ?? null) !== (record.body_inline ?? null) || (prev.blob_hash ?? null) !== (record.blob_hash ?? null)) {
          changed.push('body');
        }
        if (changed.length > 0) emitter.updated(recordId, prev.hot_fields, changed);
      } else emitter.created(recordId);
      lastIndexedAt = record.received_at;
      // D-124 Phase 2.4 — count successful imports during initial walk.
      // No-op once `backfillRecorder.finish()` runs (post-walk).
      if (type === 'present') {
        backfillRecorder?.recordImport(Math.floor(mtime));
      }
    } catch (err) {
      bumpError();
      if (type === 'present') backfillRecorder?.recordFailure();
      log?.('warn', `file ingest failed for ${absPath}`, { err: err instanceof Error ? err.message : String(err) });
    }
  };

  let watcher: FsWatcher | undefined;
  const sync: CollectionSyncAdapter = {
    async start() {
      if (watcher) return;
      const cfg = opts.config();
      state = 'syncing';
      // What was stored before the walk, and what the walk found on disk: a
      // file removed while the server was down is on no list, and its record
      // would stay forever.
      const storedBefore = (opts.db.prepare(`SELECT record_id, source_id FROM ${quoteSqliteIdent(table.tableName)}`)
        .all() as { record_id: string; source_id: string }[]);
      const walked = new Set<string>();
      watcher = createFsWatcher({
        root: rootAbs,
        ignore: cfg.ignore,
        debounceMs: 500,
        onEvent: async (event) => {
          pending++;
          try {
            if (event.type === 'present') walked.add(recordIdFor(toPosix(relative(rootAbs, event.path))));
            await ingestEvent(event.type, event.path);
          } finally {
            pending = Math.max(0, pending - 1);
          }
        },
        log,
      });
      backfillRecorder = createBackfillAuditRecorder({
        auditLog: opts.auditLog,
        platform: 'file',
        slug,
        now: nowOf,
        log,
      });
      try {
        await watcher.start();
        state = 'connected';
        // Gone while the server was down: taken out as a live `remove` takes
        // a file out — after a walk that read every directory. One that could
        // not read the folder (a drive unplugged, a folder moved) is no list
        // of what is on disk, and takes nothing out.
        if (watcher.walkErrors() === 0) {
          for (const { record_id, source_id } of storedBefore) {
            if (!walked.has(record_id)) await ingestEvent('remove', resolve(rootAbs, source_id));
          }
        }
        // D-124 Phase 2.1 — fs watcher's `start()` resolves only after
        // the initial directory walk completes (`scanDir(root)` in
        // fs-adapter.ts). Flip the denormalized backfill bool exactly
        // once now that every existing file has been observed. The
        // write is idempotent on restart.
        try { opts.instances?.markBackfillComplete('file', slug); }
        catch (err) {
          bumpError();
          log?.('warn', `file markBackfillComplete failed for slug=${slug}`, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
        await backfillRecorder.finish();
      } catch (err) {
        state = 'error';
        bumpError();
        await backfillRecorder.finish('failed');
        throw err;
      }
    },
    async stop() {
      state = 'disconnected';
      if (!watcher) return;
      const w = watcher;
      watcher = undefined;
      await w.stop();
    },
  };

  const health = (): CollectionHealth => ({
    platform: 'file',
    slug,
    last_indexed_at: lastIndexedAt,
    pending_queue_size: pending,
    error_count_24h: errorCount24h,
    state,
  });

  const runRetention = async (): Promise<CollectionPruneResult> => retention.run();

  return {
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
    runRetention,
    async close() {
      await sync.stop();
    },
  };
};
