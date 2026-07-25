import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { StorageGate } from '@recued/storage-gate';
import type { AuditLogStore } from '@recued/storage';
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
import {
  createCollectionTable,
  type CollectionTable,
} from '../table.js';
import { createCollectionEmitter } from '../events.js';
import {
  createCollectionRetention,
  type CollectionRetention,
} from '../retention.js';
import type {
  Collection,
  CollectionPruneResult,
  CollectionSyncAdapter,
} from '../types.js';

export type FileOrigin =
  | 'reception_drop'
  | 'messenger_media'
  | 'mail_attachment'
  // Document-toolkit — a deterministic local tool (docling / pandoc) wrote this
  // file as the captured output of a granted cli op (`CliOutputCaptureSpec`).
  // The bytes are content-addressed in the CAS; the producing op was already
  // grant-gated, and the resulting file_ref read stays Gateway-gated.
  | 'tool_output'
  // SMB-finance slice 3 (storage-gdrive) — the body of a granted REST
  // `response_capture` op (`file.download`) fetched over the network. Same
  // CAS / Gateway-gated posture as `tool_output`; a distinct origin keeps the
  // CAS sweep + audit honest about network egress provenance.
  | 'connection_download'
  // D-172 resumable uploads — the authenticated webclient owner pushed this
  // file from the Data -> File view via the resumable chunked uploader (control
  // plane over rpc, chunk bytes over the dedicated binary `/ws/upload` socket).
  // The chunk-core streamed the assembled scratch into the CAS, so the bytes are
  // already content-addressed at finalize; a distinct origin keeps provenance +
  // the CAS sweep honest about owner-pushed uploads vs. the reception-drop
  // (`reception_drop`) open-visitor path that shares the same upload substrate.
  | 'webclient_upload';

export type FileMediaClass = 'voice' | 'image' | 'document' | 'other';

export type FileScanStatus = 'pending' | 'clean' | 'flagged' | 'unscanned';

export type FileStorageRef =
  | { kind: 'cas'; blob_hash: string }
  | { kind: 'remote'; provider: string; remote_id: string; fetch_hint?: string };

export interface DataFileHotFields extends Record<string, unknown> {
  filename: string;
  mime_type: string;
  size: number;
  content_hash: string;
  origin: FileOrigin;
  scan_status: FileScanStatus;
  media_class: FileMediaClass;
}

export interface DataFileRecord extends CollectionRecord {
  hot_fields: DataFileHotFields;
  storage_ref: FileStorageRef;
}

export interface InboundFileIngestInput {
  bytes?: Buffer;
  storage_ref?: FileStorageRef;
  /** Stream a SOURCE FILE into the CAS via `BlobStore.putFile` — the
   *  large-untrusted-media path (messenger / future mail-stream). The whole
   *  plaintext never lands in memory; the producer streams the download to a
   *  temp file and passes the path here. The CAS content-addresses it; the
   *  resulting `content_hash`/`blob_hash` is the streamed sha256. The PRODUCER
   *  owns the temp file's lifecycle (delete after this resolves). Exactly one
   *  of `bytes` / `storage_ref` / `src_path`. */
  src_path?: string;
  filename: string;
  mime_type: string;
  content_hash?: string;
  size_bytes?: number;
  origin: FileOrigin;
  source_id: string;
  scan_status?: FileScanStatus;
  now?: number;
}

export interface InboundFileCollection extends Collection {
  ingest(input: InboundFileIngestInput): Promise<DataFileRecord>;
  get(record_id: string): DataFileRecord | null;
  list(query: CollectionListQuery): DataFileRecord[];
  /** D-173 P5 (scan-gate part B) — patch one record's `scan_status` hot field
   *  to a scanner verdict (`clean` / `flagged` / `pending` / `unscanned`) and
   *  emit an `updated` event so the reception inbox + reactive subscribers see
   *  the new verdict. IDEMPOTENT: a no-op (no event) when the record already
   *  carries `status`, so a resumed run / duplicate reactive fire never emits a
   *  spurious `updated`. Returns the hydrated record, or `null` when the record
   *  is gone (a benign race — retention pruned it before the async scan
   *  finished). The ClamAV pack's reactive recipe reaches this through the
   *  MCP-reserved `file-set-scan-status` kernel op; it is never an agent tool
   *  (a forged `clean` verdict on a malicious upload must be impossible). */
  setScanStatus(record_id: string, status: FileScanStatus): DataFileRecord | null;
  /** SMB-finance slice 3 — read the CAS bytes for one record so a cli op can
   *  materialize a `file_ref` arg to a temp file (`CliInputMaterializeSpec`).
   *  Encapsulates the blob-store access so the engine wiring stays thin. Throws
   *  on an unknown record or a non-`cas` storage_ref. Mirrored provider files
   *  live in `file_meta_ref` and resolve through the D-192 file-read path, not
   *  through this CAS collection method.
   *  This is a server-internal read — the Gateway-gated content surface for
   *  recipes / AI is `data-file-read`; this path is reached only after the
   *  producing cli op was itself grant-gated. */
  readBytes(record_id: string): Promise<{ bytes: Buffer; mime_type: string; filename: string }>;
  liveCasBlobHashes(): Set<string>;
  sweepOrphanCasBlobs(): Promise<InboundFileCasSweepResult>;
  totalBytes(): number;
}

export interface InboundFileCasSweepResult {
  keep_count: number;
  deleted_count: number;
  covered: string[];
  truncated: false;
}

export interface CreateInboundFileCollectionOptions {
  db: Database.Database;
  blobs: BlobStore;
  gate: StorageGate;
  bus: WarehouseEventBus;
  slug: 'received' | string;
  auditLog?: AuditLogStore;
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

const sha256Hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

export const inboundFileRecordId = (
  origin: FileOrigin,
  source_id: string,
): string => `file:${sha256Hex(`${origin}:${source_id}`).slice(0, 32)}`;

/** The canonical `data.file.received` record_id shape minted by
 *  `inboundFileRecordId` — `file:` + 32 lowercase hex chars. Used to tell a
 *  `file_ref` apart from a literal local path / URL when a cli op's
 *  `input_materialize` arg can carry either (docling's `source` serves both a
 *  manual local-path lane and the storage-gdrive download→file_ref lane). A
 *  `file://` URI or local path never matches (no `//`, wrong length). */
export const INBOUND_FILE_RECORD_ID_PATTERN = /^file:[0-9a-f]{32}$/;

export const isInboundFileRecordId = (value: unknown): value is string =>
  typeof value === 'string' && INBOUND_FILE_RECORD_ID_PATTERN.test(value);

export const mediaClassForMimeType = (mime_type: string): FileMediaClass => {
  const lower = mime_type.toLowerCase();
  if (lower.startsWith('audio/')) return 'voice';
  if (lower.startsWith('image/')) return 'image';
  return 'document';
};

const FILENAME_MAX_BYTES = 255;

export const sanitizeFileDisplayName = (raw: string): string => {
  let s = String(raw ?? '').normalize('NFC');
  const parts = s.split(/[\\/]/);
  s = parts[parts.length - 1] ?? '';
  s = s.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length === 0 || s === '.' || s === '..') return 'file';
  if (Buffer.byteLength(s, 'utf8') <= FILENAME_MAX_BYTES) return s;

  const dotIdx = s.lastIndexOf('.');
  const ext = dotIdx > 0 && s.length - dotIdx <= 16 ? s.slice(dotIdx) : '';
  const extBytes = Buffer.byteLength(ext, 'utf8');
  const room = Math.max(1, FILENAME_MAX_BYTES - extBytes);
  const stem = dotIdx > 0 ? s.slice(0, dotIdx) : s;
  return Buffer.from(stem, 'utf8').subarray(0, room).toString('utf8') + ext;
};

const STORAGE_REFS_TABLE = 'collection_file_inbound_storage_refs';

interface StorageRefRow {
  storage_ref: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseStorageRef = (value: unknown): FileStorageRef | null => {
  if (!isObject(value)) return null;
  if (value.kind === 'cas' && typeof value.blob_hash === 'string' && value.blob_hash.length > 0) {
    return { kind: 'cas', blob_hash: value.blob_hash };
  }
  if (
    value.kind === 'remote' &&
    typeof value.provider === 'string' &&
    value.provider.length > 0 &&
    typeof value.remote_id === 'string' &&
    value.remote_id.length > 0
  ) {
    return {
      kind: 'remote',
      provider: value.provider,
      remote_id: value.remote_id,
      ...(typeof value.fetch_hint === 'string' && value.fetch_hint.length > 0
        ? { fetch_hint: value.fetch_hint }
        : {}),
    };
  }
  return null;
};

const assertStorageRef = (value: unknown): FileStorageRef => {
  const parsed = parseStorageRef(value);
  if (!parsed) {
    throw new Error('data.file.received: storage_ref must be {kind:"cas", blob_hash} or {kind:"remote", provider, remote_id}');
  }
  return parsed;
};

const normalizeRecordForStorage = (
  record: CollectionRecord,
  storage_ref: FileStorageRef,
): CollectionRecord => {
  const next: CollectionRecord = {
    ...record,
    hot_fields: { ...(record.hot_fields ?? {}) },
  };
  delete (next as { storage_ref?: unknown }).storage_ref;
  if (storage_ref.kind === 'cas') next.blob_hash = storage_ref.blob_hash;
  else delete next.blob_hash;
  delete next.body_inline;
  return next;
};

export const createInboundFileCollection = (
  opts: CreateInboundFileCollectionOptions,
): InboundFileCollection => {
  const { db, blobs, gate, bus, slug, log } = opts;
  const nowOf = (): number => opts.now?.() ?? Date.now();

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${STORAGE_REFS_TABLE} (
      slug TEXT NOT NULL,
      record_id TEXT NOT NULL,
      storage_ref TEXT NOT NULL,
      PRIMARY KEY (slug, record_id)
    );
  `);

  const refGet = db.prepare(
    `SELECT storage_ref FROM ${STORAGE_REFS_TABLE} WHERE slug = ? AND record_id = ?`,
  );
  const refUpsert = db.prepare(
    `INSERT INTO ${STORAGE_REFS_TABLE} (slug, record_id, storage_ref)
     VALUES (?, ?, ?)
     ON CONFLICT(slug, record_id) DO UPDATE SET
       storage_ref = excluded.storage_ref`,
  );
  const refDelete = db.prepare(
    `DELETE FROM ${STORAGE_REFS_TABLE} WHERE slug = ? AND record_id = ?`,
  );
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
    config: () => ({ retentionDays: 0 }),
  });

  let lastIndexedAt = 0;
  let errorCount24h = 0;
  let state: CollectionState = 'connected';

  const refForRecord = (record: CollectionRecord): FileStorageRef | null => {
    const row = refGet.get(slug, record.record_id) as StorageRefRow | undefined;
    if (row) {
      try {
        const parsed = parseStorageRef(JSON.parse(row.storage_ref));
        if (parsed) return parsed;
      } catch {
        log?.('warn', `data.file.${slug}: invalid storage_ref JSON`, {
          record_id: record.record_id,
        });
      }
    }
    if (typeof record.blob_hash === 'string' && record.blob_hash.length > 0) {
      return { kind: 'cas', blob_hash: record.blob_hash };
    }
    return null;
  };

  const hydrate = (record: CollectionRecord | null): DataFileRecord | null => {
    if (!record) return null;
    const storage_ref = refForRecord(record);
    if (!storage_ref) {
      errorCount24h++;
      throw new Error(`data.file.${slug}: record '${record.record_id}' has no storage_ref`);
    }
    const hot = record.hot_fields as unknown as DataFileHotFields;
    return {
      ...record,
      hot_fields: hot,
      storage_ref,
      ...(storage_ref.kind === 'cas' ? { blob_hash: storage_ref.blob_hash } : {}),
    };
  };

  const upsertWithRef = (record: CollectionRecord, storage_ref: FileStorageRef): CollectionRecord | null => {
    const stored = normalizeRecordForStorage(record, storage_ref);
    const tx = db.transaction(() => {
      const prev = table.upsert(stored);
      refUpsert.run(slug, record.record_id, JSON.stringify(storage_ref));
      return prev;
    });
    return tx();
  };

  const sync: CollectionSyncAdapter = {
    async start() {
      state = 'connected';
    },
    async stop() {
      state = 'disconnected';
    },
  };

  const ingest = async (input: InboundFileIngestInput): Promise<DataFileRecord> => {
    const forms =
      (input.bytes !== undefined ? 1 : 0) +
      (input.storage_ref !== undefined ? 1 : 0) +
      (input.src_path !== undefined ? 1 : 0);
    if (forms !== 1) {
      throw new Error('data.file.received.ingest: exactly one of bytes, storage_ref, or src_path is required');
    }

    let storage_ref: FileStorageRef;
    let content_hash: string;
    let size_bytes: number;

    if (input.bytes) {
      content_hash = sha256Hex(input.bytes);
      if (input.content_hash !== undefined && input.content_hash !== content_hash) {
        throw new Error('data.file.received.ingest: content_hash_mismatch');
      }
      storage_ref = { kind: 'cas', blob_hash: await blobs.put(input.bytes) };
      if (storage_ref.blob_hash !== content_hash) {
        throw new Error('data.file.received.ingest: blob_hash_mismatch');
      }
      size_bytes = input.bytes.length;
    } else if (input.src_path !== undefined) {
      // Stream the source file into the CAS — peak memory is one chunk, never
      // the whole file (the large-untrusted-media path). `putFile` returns the
      // streamed sha256 = the canonical content_hash + blob_hash.
      if (!blobs.putFile) {
        throw new Error('data.file.received.ingest: src_path requires a streaming-capable BlobStore (putFile)');
      }
      const blob_hash = await blobs.putFile(input.src_path);
      storage_ref = { kind: 'cas', blob_hash };
      content_hash = input.content_hash ?? blob_hash;
      if (content_hash !== blob_hash) {
        throw new Error('data.file.received.ingest: src_path_content_hash_mismatch');
      }
      if (input.size_bytes === undefined || input.size_bytes < 0 || !Number.isFinite(input.size_bytes)) {
        throw new Error('data.file.received.ingest: size_bytes required for src_path ingest');
      }
      size_bytes = input.size_bytes;
    } else {
      storage_ref = assertStorageRef(input.storage_ref);
      if (storage_ref.kind === 'cas') {
        content_hash = input.content_hash ?? storage_ref.blob_hash;
        if (content_hash !== storage_ref.blob_hash) {
          throw new Error('data.file.received.ingest: cas_content_hash_mismatch');
        }
      } else {
        if (!input.content_hash) {
          throw new Error('data.file.received.ingest: content_hash required for remote storage_ref');
        }
        content_hash = input.content_hash;
      }
      if (input.size_bytes === undefined || input.size_bytes < 0 || !Number.isFinite(input.size_bytes)) {
        throw new Error('data.file.received.ingest: size_bytes required for pre-stored storage_ref');
      }
      size_bytes = input.size_bytes;
    }

    const record_id = inboundFileRecordId(input.origin, input.source_id);
    const prior = table.get(record_id);
    const stamp = input.now ?? nowOf();
    const record: DataFileRecord = {
      record_id,
      received_at: prior?.received_at ?? stamp,
      modified_at: stamp,
      hot_fields: {
        filename: sanitizeFileDisplayName(input.filename),
        mime_type: input.mime_type,
        size: size_bytes,
        content_hash,
        origin: input.origin,
        scan_status: input.scan_status ?? 'unscanned',
        media_class: mediaClassForMimeType(input.mime_type),
      },
      size_bytes,
      source_id: input.source_id,
      storage_ref,
      ...(storage_ref.kind === 'cas' ? { blob_hash: storage_ref.blob_hash } : {}),
    };

    const prev = upsertWithRef(record, storage_ref);
    if (prev) emitter.updated(record_id, prev.hot_fields);
    else emitter.created(record_id);
    lastIndexedAt = stamp;
    return hydrate(table.get(record_id))!;
  };

  const readBytes = async (
    record_id: string,
  ): Promise<{ bytes: Buffer; mime_type: string; filename: string }> => {
    const record = hydrate(table.get(record_id));
    if (!record) {
      throw new Error(`data.file.${slug}.readBytes: unknown record '${record_id}'`);
    }
    if (record.storage_ref.kind !== 'cas') {
      throw new Error(`data.file.${slug}.readBytes: record '${record_id}' is not a CAS blob (remote refs resolve through the file_meta_ref read path)`);
    }
    const bytes = await blobs.get(record.storage_ref.blob_hash);
    if (!bytes) {
      throw new Error(`data.file.${slug}.readBytes: CAS blob missing for record '${record_id}'`);
    }
    return {
      bytes,
      mime_type: record.hot_fields.mime_type,
      filename: record.hot_fields.filename,
    };
  };

  const setScanStatus = (
    record_id: string,
    status: FileScanStatus,
  ): DataFileRecord | null => {
    const existing = hydrate(table.get(record_id));
    if (!existing) return null;
    // Idempotent — re-reporting the same verdict (a resumed run, a duplicate
    // reactive fire, a re-scan that confirms `clean`) must NOT emit a spurious
    // `updated`, which would re-trigger every `data.file.received.*.updated`
    // subscriber for no real change.
    if (existing.hot_fields.scan_status === status) return existing;
    const next: DataFileRecord = {
      ...existing,
      modified_at: nowOf(),
      hot_fields: { ...existing.hot_fields, scan_status: status },
    };
    // Re-use the same storage_ref — the bytes are untouched, only the verdict
    // changes. `upsertWithRef` strips the in-memory `storage_ref` back into the
    // side table + `blob_hash` (via `normalizeRecordForStorage`).
    const prev = upsertWithRef(next, existing.storage_ref);
    if (prev) emitter.updated(record_id, prev.hot_fields);
    else emitter.created(record_id);
    lastIndexedAt = nowOf();
    return hydrate(table.get(record_id))!;
  };

  const liveCasBlobHashes = (): Set<string> => {
    return table.referencedBlobHashes();
  };

  const sweepOrphanCasBlobs = async (): Promise<InboundFileCasSweepResult> => {
    const keepSet = liveCasBlobHashes();
    const covered = [
      `live data.file.${slug} records with storage_ref.kind=cas`,
    ];
    const deleted_count = await blobs.sweepOrphans(keepSet);
    const result: InboundFileCasSweepResult = {
      keep_count: keepSet.size,
      deleted_count,
      covered,
      truncated: false,
    };
    log?.('info', `data.file.${slug}.cas_sweep`, result);
    return result;
  };

  const health = (): CollectionHealth => ({
    platform: 'file',
    slug,
    last_indexed_at: lastIndexedAt,
    pending_queue_size: 0,
    error_count_24h: errorCount24h,
    state,
  });

  return {
    platform: 'file',
    slug,
    gate,
    sync,
    ingest,
    upsert(record) {
      const storage_ref = assertStorageRef(
        (record as { storage_ref?: unknown }).storage_ref ??
          (record.blob_hash ? { kind: 'cas', blob_hash: record.blob_hash } : undefined),
      );
      const prev = upsertWithRef(record, storage_ref);
      if (prev) emitter.updated(record.record_id, prev.hot_fields);
      else emitter.created(record.record_id);
      lastIndexedAt = nowOf();
    },
    delete(record_id) {
      const tx = db.transaction(() => {
        const prev = table.delete(record_id);
        refDelete.run(slug, record_id);
        return prev;
      });
      const prev = tx();
      if (prev) emitter.deleted(record_id, prev.hot_fields);
      return prev !== null;
    },
    get(record_id) {
      return hydrate(table.get(record_id));
    },
    list(query: CollectionListQuery) {
      return table.list(query).map((record) => hydrate(record)!);
    },
    search(query: CollectionSearchQuery): CollectionSearchMatch[] {
      return table.search(query);
    },
    health,
    runRetention: async (): Promise<CollectionPruneResult> => retention.run(),
    async close() {
      await sync.stop();
    },
    readBytes,
    setScanStatus,
    liveCasBlobHashes,
    sweepOrphanCasBlobs,
    totalBytes: () => table.totalBytes(),
  };
};
