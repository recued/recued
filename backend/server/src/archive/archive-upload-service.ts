/** M4b.1 — archive-upload service (no-SSH migrate: upload → STAGE to a path).
 *
 *  The browser-DOWNLOAD half (M4a) lets a no-SSH user get a backup OFF the box;
 *  this is the UPLOAD half that lets them put one BACK to MIGRATE. It reuses
 *  D-172's resumable chunk-core WHOLESALE for the transport (offset-as-truth,
 *  fsync'd positional append, per-chunk checksum, disk-DoS caps, the TTL
 *  sweeper) and swaps ONLY the finalize policy:
 *
 *    - The webclient consumer streams the completed scratch into the CAS + ingests
 *      a `data.file.received` warehouse row.
 *    - This consumer STAGES the assembled archive to `<data>/exports/` under a
 *      NON-generated name (`archiveStagingName`) — which the export GC + the
 *      `/ws/download` socket both ignore — and returns that `staged_name` for
 *      `server.archive.import` to resolve (`resolveImportPath` maps a relative
 *      basename under `exports/`). The M4b.0 streaming importer then consumes the
 *      file off disk, never holding the whole archive in RAM.
 *
 *  The staging uses the core's `materialize` seam to HARDLINK the scratch into
 *  the staging path — NO CAS write at all. The raw archive bytes are already
 *  recovery-key ciphertext; the default `putFile` would needlessly re-encrypt a
 *  multi-GB file into a CAS orphan (sweep-reaped later) and transiently double
 *  the disk footprint — exactly the ENOSPC hazard a user migrating off a small
 *  box must not hit. A hardlink is a metadata op (same data volume), so peak disk
 *  stays ≈ one copy of the archive (scratch ↔ staging share the inode until the
 *  core unlinks the scratch).
 *
 *  Scope: `(scope_kind: 'archive', scope_key: token_instance_id)` — the verified
 *  paired owner. Sessions + scratch share the one `upload_session` store + the
 *  one `upload_blobs` root with the other consumers, so the already-registered
 *  `upload-session-sweep` reaps an abandoned archive upload too (no new task). */

import { mkdir, unlink, link, copyFile, utimes, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  decodeUploadChunkFrame,
  type ArchiveUploadCreateRpcResponse,
  type ArchiveUploadProbeRpcResponse,
  type ArchiveUploadFinalizeRpcResponse,
  type ArchiveUploadDeleteRpcResponse,
  type UploadChunkAck,
} from '@recued/contracts';
import type Database from 'better-sqlite3';

import {
  createUploadSessionStore,
  UPLOAD_MAX_PENDING_BYTES,
  type UploadSession,
  type UploadSessionStore,
} from '../storage/upload-session-store.js';
import {
  createUploadChunkCore,
  type UploadChunkCore,
} from '../upload/upload-chunk-core.js';
import {
  archiveStagingName,
  exportsDir,
  formatBytes,
  pruneStagedArchives,
  ARCHIVE_STAGING_TTL_MS,
} from './export-store.js';
import { osFreeBytes } from '../storage/disk-free.js';

/** Per-FILE ceiling on a single uploaded archive. Set to the shared global
 *  pending-bytes cap (`UPLOAD_MAX_PENDING_BYTES`, 4 GiB) so one archive can use
 *  the whole transport budget; a larger backup must migrate via SSH/CLI
 *  (`archive import <path>`). The create gate rejects a `declared_size` past it
 *  (acked `size_cap_exceeded`) before any bytes are wasted. */
export const ARCHIVE_UPLOAD_SIZE_CAP_BYTES = UPLOAD_MAX_PENDING_BYTES; // 4 GiB

/** M5 S3 — free-disk headroom multiplier for the upload-create statfs
 *  pre-flight. A restore needs the staged archive on disk (≈ `declared_size`,
 *  the compressed ciphertext) PLUS the unpacked db + overlaid blobs before the
 *  swap frees the old data. The uncompressed size isn't known until the archive
 *  is read (dry-run), so the create-time check uses a conservative multiple of
 *  the declared (compressed) size — better to refuse a tight fit up front than
 *  ENOSPC mid-restore on a half-swapped server. A precise import-time check
 *  could later use the archive header's `db_size_bytes`. */
export const ARCHIVE_RESTORE_DISK_FACTOR = 2.5;

/** What the archive finalize hands back (the staged basename + byte count). */
export interface ArchiveUploadFinalizeResult {
  readonly staged_name: string;
  readonly size_bytes: number;
}

export interface ArchiveUploadCreateInput {
  readonly scope_key: string;
  readonly filename: string;
  readonly declared_size: number;
  readonly fingerprint?: string | null;
  readonly now?: number;
}

export interface ArchiveUploadProbeInput {
  readonly scope_key: string;
  readonly upload_id: string;
  readonly filename: string;
  readonly declared_size: number;
  readonly fingerprint?: string | null;
  readonly now?: number;
}

export interface ArchiveUploadIdInput {
  readonly scope_key: string;
  readonly upload_id: string;
  readonly now?: number;
}

export interface ArchiveUploadService {
  create(input: ArchiveUploadCreateInput): Promise<ArchiveUploadCreateRpcResponse>;
  probe(input: ArchiveUploadProbeInput): ArchiveUploadProbeRpcResponse;
  finalize(input: ArchiveUploadIdInput): Promise<ArchiveUploadFinalizeRpcResponse>;
  delete(input: ArchiveUploadIdInput): Promise<ArchiveUploadDeleteRpcResponse>;
  /** Drive one chunk from a decoded binary `/ws/archive-upload` frame.
   *  `scope_key` is the BINARY socket's verified identity (must own the
   *  session). Never throws — every outcome maps to an ack. */
  handleChunkFrame(
    scope_key: string,
    frame: Uint8Array,
    now?: number,
  ): Promise<UploadChunkAck>;
  /** TTL + orphan reaper, driven by the `archive-upload-sweep` housekeeping
   *  task. Reaps expired upload SESSIONS + orphan scratch (shared core sweep —
   *  defensive overlap with the webclient `upload-session-sweep`, and the sole
   *  cover on a boot where the webclient service isn't wired) AND prunes staged
   *  archives in `exports/` past `stagingTtlMs` (the backstop the export GC can't
   *  provide, since it ignores staging names). */
  sweepExpired(
    input?: { now?: number; limit?: number },
  ): Promise<{ reaped: number; orphans: number; staged_reaped: number }>;
}

export interface CreateArchiveUploadServiceOptions {
  /** Per-pair SQLite handle — backs the shared `upload_session` store. */
  readonly db: Database.Database;
  /** Dedicated scratch tree, a data-volume sibling of the CAS (`upload_blobs`),
   *  shared with the other upload consumers. */
  readonly uploadsRoot: string;
  /** Server data dir (`dirname(dbPath)`) — exports/staging live in
   *  `<dataPath>/exports/`, the same dir `server.archive.import` resolves from. */
  readonly dataPath: string;
  /** Injectable clock (tests). Production omits it. */
  readonly now?: () => number;
  readonly log?: (level: 'info' | 'warn', msg: string, data?: unknown) => void;
  /** Test seam to make `upload_id`s deterministic. */
  readonly mintUploadId?: () => string;
  /** Override the per-file size cap (tests / future per-owner config). */
  readonly sizeCapBytes?: number;
  /** Override the session resume TTL (tests inject a short window). */
  readonly ttlMs?: number;
  /** Override the staged-file TTL the sweep reclaims past (tests). Defaults to
   *  `ARCHIVE_STAGING_TTL_MS` (6h). */
  readonly stagingTtlMs?: number;
  /** M5 S3 — override the free-disk probe for the create-time statfs pre-flight
   *  (tests inject a fixed value; a thrower simulates a statfs-unsupported FS).
   *  Defaults to `osFreeBytes`. */
  readonly freeBytesOf?: (path: string) => number;
}

export const createArchiveUploadService = (
  options: CreateArchiveUploadServiceOptions,
): ArchiveUploadService => {
  const { db, uploadsRoot, dataPath, log } = options;
  const freeBytesOf = options.freeBytesOf ?? osFreeBytes;
  const sizeCapBytes = options.sizeCapBytes ?? ARCHIVE_UPLOAD_SIZE_CAP_BYTES;
  const stagingTtlMs = options.stagingTtlMs ?? ARCHIVE_STAGING_TTL_MS;
  const nowOf = (): number => options.now?.() ?? Date.now();

  const store: UploadSessionStore = createUploadSessionStore(db);

  /** The core's `materialize` override: HARDLINK the completed scratch into the
   *  staging path (no CAS write). The staging name is derived from `upload_id`,
   *  so EACH upload gets its OWN path — no single-slot eviction, which means two
   *  concurrent finalizes can never race the cleanup nor strand each other's
   *  still-valid staged file (the abandoned-but-finalized case is reclaimed by
   *  the `archive-upload-sweep` TTL backstop instead). Idempotent — drops any
   *  stale link at this path first so a finalize retry re-links cleanly; the
   *  scratch is left in place (hardlink) for the core to reap + the retry. */
  const materialize = async (input: {
    scratchPath: string;
    session: UploadSession;
  }): Promise<string> => {
    const dir = exportsDir(dataPath);
    await mkdir(dir, { recursive: true });
    const stagingName = archiveStagingName(input.session.upload_id);
    const stagingPath = join(dir, stagingName);

    // Drop a stale link at our own path first (finalize-retry idempotency), then
    // hardlink the raw scratch bytes in — a metadata op on the shared data
    // volume, no byte copy. EXDEV (exports on a different mount than the scratch)
    // falls back to a streaming copy. An ENOENT from `link` (scratch vanished)
    // propagates so the core maps it to `not_found`, exactly like `putFile`.
    await unlink(stagingPath).catch(() => { /* not there — fine */ });
    try {
      await link(input.scratchPath, stagingPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
        await copyFile(input.scratchPath, stagingPath);
      } else {
        throw err;
      }
    }

    // Stamp the staged file's mtime to NOW (finalize time). A hardlink inherits
    // the SCRATCH inode's mtime (= the last chunk write), which for a slow /
    // paused upload — or a complete-but-not-yet-finalized session held up to the
    // session TTL — can already be hours old. The staging TTL sweep ages files by
    // mtime, so without this refresh a freshly-staged archive could be reaped
    // before the user imports it. Stamping starts the staging TTL at finalize.
    const stampedAt = new Date(nowOf());
    await utimes(stagingPath, stampedAt, stampedAt);

    return stagingName;
  };

  // The archive finalize is trivial: `materialize` already staged the bytes and
  // threaded the staged basename through as `content_hash`. No warehouse ingest,
  // no CAS. Idempotent by construction (materialize re-links on a retry).
  const core: UploadChunkCore<ArchiveUploadFinalizeResult> = createUploadChunkCore({
    store,
    uploadsRoot,
    policy: {
      materialize,
      finalize: async (input) => ({
        staged_name: input.content_hash,
        size_bytes: input.size_bytes,
      }),
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.mintUploadId ? { mintUploadId: options.mintUploadId } : {}),
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(log ? { log } : {}),
  });

  /** Scope-ownership gate — the session must exist AND be an `archive` session
   *  belonging to this scope. A miss returns null; callers map that to a
   *  non-leaking "not found" so a wrong-scope/wrong-kind caller can't probe. */
  const ownedSession = (upload_id: string, scope_key: string): UploadSession | null => {
    const s = store.get(upload_id);
    if (!s || s.scope_kind !== 'archive' || s.scope_key !== scope_key) return null;
    return s;
  };

  /** Idempotent-finalize recovery. A finalize that SUCCEEDED server-side but
   *  whose RESPONSE the client lost leaves the session deleted yet the staged
   *  archive in place (the hardlink outlives the scratch unlink; kept until the
   *  staging TTL). Its name is deterministic from the unguessable, owner-held
   *  `upload_id`, so re-derive + return it — the client recovers WITHOUT
   *  re-uploading a multi-GB archive. Returns null when nothing is staged (never
   *  finalized, or already TTL-swept). The upload_id is the capability here (the
   *  session that bound it to a scope is gone); combined with the owner-only rpc
   *  gate that is the same posture as the rest of the archive surface. */
  const recoverStagedArchive = async (
    upload_id: string,
  ): Promise<ArchiveUploadFinalizeResult | null> => {
    const stagingName = archiveStagingName(upload_id);
    try {
      const st = await stat(join(exportsDir(dataPath), stagingName));
      if (st.isFile()) return { staged_name: stagingName, size_bytes: st.size };
    } catch { /* not staged — never finalized or already swept */ }
    return null;
  };

  return {
    async create(input) {
      // M5 S3 — live free-disk pre-flight BEFORE any bytes upload: refuse if the
      // declared archive plus the restore's unpack/swap headroom won't fit. Cap +
      // pending-bytes budget bound the transport; this bounds the actual disk.
      // statfs-unsupported ⇒ gate-open (mirror the export preflight + the
      // service's pending-bytes tracker): let it run + surface a natural ENOSPC
      // rather than wedge restores because the filesystem can't report free space.
      if (input.declared_size > 0) {
        let freeBytes: number | null = null;
        try {
          freeBytes = freeBytesOf(dataPath);
        } catch {
          freeBytes = null;
        }
        if (freeBytes !== null) {
          const needBytes = Math.ceil(input.declared_size * ARCHIVE_RESTORE_DISK_FACTOR);
          if (freeBytes < needBytes) {
            return {
              status: 'rejected',
              reason: 'insufficient_disk',
              detail: `need ~${formatBytes(needBytes)} free to restore, ${formatBytes(freeBytes)} available`,
            };
          }
        }
      }
      const result = await core.create({
        scope_kind: 'archive',
        scope_key: input.scope_key,
        filename: input.filename,
        declared_size: input.declared_size,
        // Archives are opaque ciphertext — no MIME semantics; a fixed marker
        // keeps the session row's NOT NULL `mime_reported` honest.
        mime_reported: 'application/octet-stream',
        size_cap_bytes: sizeCapBytes,
        ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      if (result.ok) return { status: 'created', upload_id: result.upload_id };
      return {
        status: 'rejected',
        reason: result.reason,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      };
    },

    probe(input) {
      if (!ownedSession(input.upload_id, input.scope_key)) {
        return { resumable: false, reason: 'not_found' };
      }
      const r = core.probe({
        upload_id: input.upload_id,
        filename: input.filename,
        declared_size: input.declared_size,
        ...(input.fingerprint !== undefined ? { fingerprint: input.fingerprint } : {}),
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      if (r.ok) return { resumable: true, offset: r.offset, complete: r.complete };
      return { resumable: false, reason: r.reason };
    },

    async finalize(input) {
      if (ownedSession(input.upload_id, input.scope_key)) {
        const r = await core.finalize({
          upload_id: input.upload_id,
          ...(input.now !== undefined ? { now: input.now } : {}),
        });
        if (r.ok) {
          return {
            status: 'finalized',
            staged_name: r.result.staged_name,
            size_bytes: r.result.size_bytes,
          };
        }
        if (r.reason === 'incomplete') {
          return { status: 'pending', reason: 'incomplete', offset: r.offset };
        }
        // not_found / expired despite a live owned session a tick ago (a
        // concurrent delete / sweep) — fall through to staged recovery.
      } else if (store.get(input.upload_id)) {
        // A live session exists but is NOT ours (wrong scope/kind) — never hand
        // back another scope's staged archive; it's still in flight anyway.
        return { status: 'gone', reason: 'not_found' };
      }
      // No live owned session: it was deleted after a SUCCESSFUL finalize whose
      // response the client lost (or swept). Recover the staged archive if it is
      // still present — idempotent finalize, no re-upload.
      const recovered = await recoverStagedArchive(input.upload_id);
      if (recovered) {
        return {
          status: 'finalized',
          staged_name: recovered.staged_name,
          size_bytes: recovered.size_bytes,
        };
      }
      return { status: 'gone', reason: 'not_found' };
    },

    async delete(input) {
      if (!ownedSession(input.upload_id, input.scope_key)) {
        return { deleted: false };
      }
      const r = await core.delete(input.upload_id);
      return { deleted: r.ok };
    },

    async handleChunkFrame(scope_key, frame, now) {
      // Decode + scope-check are identical to the webclient consumer; only the
      // owned-session kind differs (enforced in `ownedSession`). The chunk frame
      // is the shared, policy-blind `upload-frame.ts` wire format.
      const decoded = decodeUploadChunkFrame(frame);
      if (!decoded.ok) return { type: 'upload_error', reason: decoded.reason };
      const { req_id, upload_id, offset, checksum, bytes } = decoded.frame;

      if (!ownedSession(upload_id, scope_key)) {
        return { type: 'upload_ack', req_id, ok: false, reason: 'forbidden' };
      }

      const r = await core.chunk({
        upload_id,
        expected_offset: offset,
        // Copy out of the (possibly pooled) WS frame buffer before the async
        // fs write the core fsyncs.
        bytes: Buffer.from(bytes),
        ...(checksum !== undefined ? { checksum } : {}),
        ...(now !== undefined ? { now } : {}),
      });
      if (r.ok) {
        return { type: 'upload_ack', req_id, ok: true, offset: r.offset, complete: r.complete };
      }
      if (r.reason === 'offset_conflict') {
        return { type: 'upload_ack', req_id, ok: false, reason: 'offset_conflict', offset: r.offset };
      }
      return { type: 'upload_ack', req_id, ok: false, reason: r.reason };
    },

    async sweepExpired(input) {
      const now = input?.now ?? nowOf();
      const r = await core.sweepExpired(input);
      // Reclaim staged archives past their TTL — the backstop for a finalized
      // upload that was imported (or abandoned) and left behind in `exports/`.
      const staged = pruneStagedArchives(dataPath, stagingTtlMs, now);
      if (staged.length > 0) {
        log?.('info', 'archive-upload: swept staged archives', { reaped: staged.length });
      }
      return { reaped: r.reaped, orphans: r.orphans, staged_reaped: staged.length };
    },
  };
};
