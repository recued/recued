/** D-172 resumable uploads — SHARED server chunk-core.
 *
 *  Build step 2 of the rev-4 locked plan. The consumer-agnostic transport half
 *  of resumable chunked uploads, shared by BOTH consumers (reception drop +
 *  webclient Data→File). The HTTP/auth half lives in each consumer's endpoint
 *  wiring (step 4 webclient / step 5 reception) — that layer authenticates,
 *  resolves `(scope_kind, scope_key)`, and calls into this core. Keeping the
 *  core HTTP-agnostic is what makes it testable headless (the design's stated
 *  P1 goal) and reusable across the two surfaces.
 *
 *  The core owns the hard, safety-critical mechanics:
 *    - Scratch fs lifecycle under `<uploadsRoot>/<upload_id>` (separate from the
 *      CAS objects + the single-POST `_tmp` tree).
 *    - **Crash-correctness:** every chunk truncates the scratch back to the
 *      PERSISTED offset (the source of truth) before the positional append, then
 *      fsync's the bytes BEFORE persisting the new offset. A crash that left the
 *      scratch longer than the acked offset (bytes written, offset un-acked) is
 *      self-healing — the re-sent chunk overwrites the un-acked tail instead of
 *      double-appending.
 *    - Contiguous offset validation (gaps/rewrites/overflow rejected; the
 *      offset-as-truth `advanceOffset` is the atomic authority).
 *    - Optional per-chunk sha256 checksum (the flaky-link win: reject + retry a
 *      corrupt chunk in place).
 *    - Disk-DoS caps at create (concurrent-per-scope + global pending-bytes +
 *      declared_size ≤ size_cap), recomputed from live rows — never a drifting
 *      counter.
 *    - **Fail-closed expiry:** an op on a session past `expires_at` (expired but
 *      not yet swept) returns `expired`, never resurrects it. The store stays an
 *      expiry-agnostic primitive (step 1); the EXPIRY CONTRACT is enforced here,
 *      at the policy layer above the store — consistent with the budget queries
 *      that already treat `expires_at <= now` as dead.
 *
 *  The CONSUMER supplies a policy `{ guardCreate?, finalize }`:
 *    - `guardCreate` — consumer-specific create gate run AFTER the core disk
 *      caps (reception: per-IP rate-limit + daily-cap + form-nonce consume;
 *      webclient: light / owner-quota). Optional.
 *    - `finalize` — consumer materialization once the bytes are complete +
 *      content-addressed: reception writes `reception_drop_blob_metadata`
 *      (magic-byte/MIME cross-check on `head_bytes` lives in the reception
 *      policy, not here — the allowlist is reception-specific) + drains;
 *      webclient calls `InboundFileCollection.ingest`.
 *
 *  Spec: internal design notes
 *  (rev 2 protocol + rev 3 shared-split + rev 4 build order). */

import { randomBytes, createHash } from 'node:crypto';
import { mkdir, open, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BlobStore } from '../storage/blob-store.js';
import {
  UPLOAD_SESSION_TTL_MS,
  UPLOAD_CHUNK_MAX_BYTES,
  UPLOAD_MAX_CONCURRENT_SESSIONS_PER_SCOPE,
  UPLOAD_MAX_PENDING_BYTES,
  type UploadScopeKind,
  type UploadSession,
  type UploadSessionStore,
} from '../storage/upload-session-store.js';

// ────────────────────────────────────────────────────────────────
// Policy seam (consumer-supplied)
// ────────────────────────────────────────────────────────────────

/** Handed to `policy.finalize` once the scratch is complete + CAS-stored. The
 *  bytes are already content-addressed at `content_hash`; `head_bytes` is the
 *  first ≤16 bytes (the reception policy runs magic-byte detection over it). */
export interface UploadFinalizeInput {
  readonly session: UploadSession;
  readonly content_hash: string;
  readonly size_bytes: number;
  readonly head_bytes: Buffer;
  /** Opaque consumer context carried on the finalize request (reception: sealed
   *  visitor PII; webclient: an attach target). The core forwards it untouched. */
  readonly finalize_context?: unknown;
}

export interface UploadCorePolicy<F> {
  /** Consumer-specific create gate, run AFTER the core disk caps pass. Reject
   *  (rate-limit / nonce / daily-cap) aborts the create with reason `rejected`. */
  guardCreate?(input: {
    readonly scope_kind: UploadScopeKind;
    readonly scope_key: string;
    readonly declared_size: number;
    readonly now: number;
  }): { ok: true } | { ok: false; detail?: string };
  /** Override the default "stream the completed scratch into the CAS" step.
   *  When present, the core calls this INSTEAD of `putFile(scratch)` once the
   *  scratch is complete, and threads the returned string to `finalize` as
   *  `content_hash`. The archive-upload consumer uses it to HARDLINK the scratch
   *  to an `exports/` staging path — no CAS write at all (the raw archive bytes
   *  are recovery-key ciphertext that would otherwise be needlessly re-encrypted
   *  into a multi-GB CAS orphan). Default (omitted) = `putFile` → the content
   *  hash (reception + webclient).
   *
   *  CONTRACT: MUST NOT remove `scratchPath` — the core reaps it after finalize,
   *  and finalize must stay retryable (a throw re-runs head-capture →
   *  materialize → finalize). A hardlink leaves the scratch in place, so the
   *  inode survives the core's later `unlinkScratch`. MUST be idempotent (a
   *  retry re-invokes it). */
  materialize?(input: {
    readonly scratchPath: string;
    readonly session: UploadSession;
  }): Promise<string>;
  /** Materialize the completed upload into the consumer's warehouse surface.
   *  MUST be idempotent — a finalize interrupted after `putFile` is retried (the
   *  session persists until this resolves + the scratch/session are reaped). */
  finalize(input: UploadFinalizeInput): Promise<F>;
}

// ────────────────────────────────────────────────────────────────
// Result discriminated unions (the consumer HTTP layer maps to status codes)
// ────────────────────────────────────────────────────────────────

export type UploadCreateResult =
  | { ok: true; upload_id: string; offset: 0 }
  | {
      ok: false;
      reason:
        | 'invalid_declared_size'
        | 'size_cap_exceeded'
        | 'too_many_sessions'
        | 'pending_bytes_exceeded'
        | 'rejected';
      detail?: string;
    };

export type UploadProbeResult =
  | { ok: true; offset: number; complete: boolean }
  | { ok: false; reason: 'not_found' | 'expired' | 'file_mismatch' };

export type UploadChunkResult =
  | { ok: true; offset: number; complete: boolean }
  // `offset_conflict` carries the real persisted offset so a stale client
  // (gap / rewrite / re-sent already-acked chunk) re-syncs without re-creating.
  | { ok: false; reason: 'offset_conflict'; offset: number }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'expired'
        | 'empty_chunk'
        | 'chunk_too_large'
        | 'overflow'
        | 'checksum_mismatch'
        | 'scratch_missing';
    };

export type UploadFinalizeResult<F> =
  | { ok: true; result: F }
  | { ok: false; reason: 'not_found' | 'expired' }
  | { ok: false; reason: 'incomplete'; offset: number };

export type UploadDeleteResult = { ok: true } | { ok: false; reason: 'not_found' };

export interface UploadSweepResult {
  /** Expired session rows reaped (row + scratch). */
  readonly reaped: number;
  /** Orphaned scratch files reaped (no live row, old mtime) — the fs-scan
   *  backstop for the delete-before-unlink crash window. */
  readonly orphans: number;
  readonly upload_ids: ReadonlyArray<string>;
}

// ────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────

export interface UploadCreateInput {
  readonly scope_kind: UploadScopeKind;
  readonly scope_key: string;
  readonly filename: string;
  readonly declared_size: number;
  readonly mime_reported: string;
  /** Per-create size ceiling (reception: the drop-link config cap; webclient:
   *  the owner cap). `declared_size` must not exceed it. */
  readonly size_cap_bytes: number;
  readonly fingerprint?: string | null;
  readonly source_ip_hash?: string | null;
  readonly now?: number;
}

export interface UploadProbeInput {
  readonly upload_id: string;
  readonly filename: string;
  readonly declared_size: number;
  readonly fingerprint?: string | null;
  readonly now?: number;
}

export interface UploadChunkInput {
  readonly upload_id: string;
  readonly expected_offset: number;
  readonly bytes: Buffer;
  /** Optional sha256 (hex) of `bytes`; mismatch → `checksum_mismatch` (retry). */
  readonly checksum?: string;
  readonly now?: number;
}

export interface UploadFinalizeRequest {
  readonly upload_id: string;
  readonly finalize_context?: unknown;
  readonly now?: number;
}

// ────────────────────────────────────────────────────────────────
// Core
// ────────────────────────────────────────────────────────────────

export interface CreateUploadChunkCoreOptions<F> {
  readonly store: UploadSessionStore;
  /** Streaming-capable BlobStore (`putFile`) — finalize streams the scratch into
   *  the CAS without holding the whole (≤1 GB) file in memory. REQUIRED unless
   *  the policy supplies a `materialize` override (the archive consumer stages
   *  to a path instead of the CAS, so it needs no BlobStore). */
  readonly blobs?: BlobStore;
  /** Root of the dedicated scratch tree (`<uploadsRoot>/<upload_id>`). */
  readonly uploadsRoot: string;
  readonly policy: UploadCorePolicy<F>;
  readonly maxConcurrentPerScope?: number;
  readonly maxPendingBytes?: number;
  readonly chunkMaxBytes?: number;
  readonly ttlMs?: number;
  /** Injectable clock + id minter for tests. */
  readonly now?: () => number;
  readonly mintUploadId?: () => string;
  readonly log?: (level: 'info' | 'warn', msg: string, data?: unknown) => void;
}

export interface UploadChunkCore<F> {
  create(input: UploadCreateInput): Promise<UploadCreateResult>;
  probe(input: UploadProbeInput): UploadProbeResult;
  chunk(input: UploadChunkInput): Promise<UploadChunkResult>;
  finalize(input: UploadFinalizeRequest): Promise<UploadFinalizeResult<F>>;
  delete(upload_id: string): Promise<UploadDeleteResult>;
  /** TTL sweeper — reaps every session past `expires_at` (idle / abandoned /
   *  premature-quit catch-all) + unlinks its scratch. Housekeeping-driven. */
  sweepExpired(input?: { now?: number; limit?: number }): Promise<UploadSweepResult>;
}

/** First bytes captured for the finalize magic-byte cross-check (mirrors the
 *  single-POST `writeDropBlobStream` HEAD_CAPTURE_BYTES). */
const HEAD_CAPTURE_BYTES = 16;

const sha256Hex = (data: Buffer): string =>
  createHash('sha256').update(data).digest('hex');

const isEnoent = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException)?.code === 'ENOENT';

export const createUploadChunkCore = <F>(
  options: CreateUploadChunkCoreOptions<F>,
): UploadChunkCore<F> => {
  const {
    store,
    blobs,
    uploadsRoot,
    policy,
    maxConcurrentPerScope = UPLOAD_MAX_CONCURRENT_SESSIONS_PER_SCOPE,
    maxPendingBytes = UPLOAD_MAX_PENDING_BYTES,
    chunkMaxBytes = UPLOAD_CHUNK_MAX_BYTES,
    ttlMs = UPLOAD_SESSION_TTL_MS,
    mintUploadId = () => randomBytes(32).toString('hex'),
    log,
  } = options;
  const nowOf = (): number => options.now?.() ?? Date.now();

  // The completed scratch must be materializable: either the consumer overrides
  // it (archive → hardlink to a staging path) or the default streams it into the
  // CAS (requires a `putFile`-capable BlobStore).
  if (!policy.materialize && !blobs?.putFile) {
    throw new Error(
      'createUploadChunkCore: requires a streaming-capable BlobStore (putFile) '
        + 'unless policy.materialize is supplied',
    );
  }
  const putFile = blobs?.putFile?.bind(blobs);

  const scratchPathFor = (upload_id: string): string => join(uploadsRoot, upload_id);

  /** Best-effort scratch unlink — a missing file is success (already gone). */
  const unlinkScratch = async (path: string): Promise<void> => {
    try {
      await unlink(path);
    } catch (err) {
      if (!isEnoent(err)) log?.('warn', 'upload-core: scratch unlink failed', { path });
    }
  };

  // Per-upload in-process serialization. chunk / finalize / delete each run a
  // get → check → mutate-scratch → persist-offset (or putFile → policy → reap)
  // critical section; a client (buggy or hostile — this can be an untrusted
  // surface) firing them concurrently for ONE upload must not interleave it, or
  // the loser of an offset race could corrupt the scratch before its conflict is
  // detected. One Node process owns each upload's scratch, so a FIFO async lock
  // keyed by upload_id is sufficient (no cross-process access to a scratch). A
  // prior holder that rejects does NOT block the queue (`then(fn, fn)`).
  const uploadChains = new Map<string, Promise<void>>();
  const withUploadLock = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const prev = uploadChains.get(id) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.then(
      () => {},
      () => {},
    );
    uploadChains.set(id, tail);
    void tail.then(() => {
      if (uploadChains.get(id) === tail) uploadChains.delete(id);
    });
    return result;
  };

  return {
    async create(input) {
      const now = input.now ?? nowOf();

      if (
        !Number.isSafeInteger(input.declared_size) ||
        input.declared_size < 0
      ) {
        return { ok: false, reason: 'invalid_declared_size' };
      }
      if (input.declared_size > input.size_cap_bytes) {
        return { ok: false, reason: 'size_cap_exceeded' };
      }

      // Core disk-DoS caps (recomputed from live rows — no drifting counter).
      const active = store.countActiveForScope({
        scope_kind: input.scope_kind,
        scope_key: input.scope_key,
        now,
      });
      if (active >= maxConcurrentPerScope) {
        return { ok: false, reason: 'too_many_sessions' };
      }
      const pending = store.sumActivePendingBytes({ now });
      if (pending + input.declared_size > maxPendingBytes) {
        return { ok: false, reason: 'pending_bytes_exceeded' };
      }

      // Consumer-specific gate (rate-limit / nonce / daily-cap).
      if (policy.guardCreate) {
        const verdict = policy.guardCreate({
          scope_kind: input.scope_kind,
          scope_key: input.scope_key,
          declared_size: input.declared_size,
          now,
        });
        if (!verdict.ok) {
          return { ok: false, reason: 'rejected', ...(verdict.detail ? { detail: verdict.detail } : {}) };
        }
      }

      const upload_id = mintUploadId();
      const scratch_path = scratchPathFor(upload_id);

      // Materialize the durable session row FIRST, then the empty scratch file;
      // if the file can't be created, roll the row back so a session never
      // points at a missing scratch.
      store.create({
        upload_id,
        scope_kind: input.scope_kind,
        scope_key: input.scope_key,
        filename: input.filename,
        declared_size: input.declared_size,
        fingerprint: input.fingerprint ?? null,
        mime_reported: input.mime_reported,
        scratch_path,
        source_ip_hash: input.source_ip_hash ?? null,
        now,
        ttl_ms: ttlMs,
      });
      try {
        // The scratch holds the file's PLAINTEXT for the whole life of the
        // upload, on the same volume as the encrypted database. Node's defaults
        // (0777 / 0666 & umask) would leave the tree traversable and the
        // assembling file readable by every local account, so both are created
        // owner-only.
        await mkdir(uploadsRoot, { recursive: true, mode: 0o700 });
        await writeFile(scratch_path, Buffer.alloc(0), { mode: 0o600 });
      } catch (err) {
        store.delete(upload_id);
        throw err;
      }

      return { ok: true, upload_id, offset: 0 };
    },

    probe(input) {
      const now = input.now ?? nowOf();
      const session = store.get(input.upload_id);
      if (!session) return { ok: false, reason: 'not_found' };
      if (now >= session.expires_at) return { ok: false, reason: 'expired' };
      if (
        session.filename !== input.filename ||
        session.declared_size !== input.declared_size ||
        (session.fingerprint != null &&
          input.fingerprint != null &&
          session.fingerprint !== input.fingerprint)
      ) {
        return { ok: false, reason: 'file_mismatch' };
      }
      // Active client → keep the session alive.
      store.touch({ upload_id: input.upload_id, now, ttl_ms: ttlMs });
      return {
        ok: true,
        offset: session.offset_bytes,
        complete: session.offset_bytes === session.declared_size,
      };
    },

    async chunk(input) {
     return withUploadLock(input.upload_id, async (): Promise<UploadChunkResult> => {
      const now = input.now ?? nowOf();
      const session = store.get(input.upload_id);
      if (!session) return { ok: false, reason: 'not_found' };
      if (now >= session.expires_at) return { ok: false, reason: 'expired' };

      const len = input.bytes.length;
      if (len === 0) return { ok: false, reason: 'empty_chunk' };
      if (len > chunkMaxBytes) return { ok: false, reason: 'chunk_too_large' };
      if (input.expected_offset !== session.offset_bytes) {
        return { ok: false, reason: 'offset_conflict', offset: session.offset_bytes };
      }
      if (input.expected_offset + len > session.declared_size) {
        return { ok: false, reason: 'overflow' };
      }
      if (input.checksum !== undefined && sha256Hex(input.bytes) !== input.checksum) {
        return { ok: false, reason: 'checksum_mismatch' };
      }

      // Open the scratch (must exist). A lost empty scratch at offset 0 is
      // re-created; a lost scratch mid-stream is unrecoverable → scratch_missing.
      let fh;
      try {
        fh = await open(session.scratch_path, 'r+');
      } catch (err) {
        if (isEnoent(err) && input.expected_offset === 0) {
          await writeFile(session.scratch_path, Buffer.alloc(0), { mode: 0o600 });
          fh = await open(session.scratch_path, 'r+');
        } else if (isEnoent(err)) {
          return { ok: false, reason: 'scratch_missing' };
        } else {
          throw err;
        }
      }
      try {
        // Crash-correctness: drop any un-acked tail past the persisted offset,
        // then positional-append, then fsync BEFORE persisting the new offset.
        await fh.truncate(input.expected_offset);
        await fh.write(input.bytes, 0, len, input.expected_offset);
        await fh.sync();
      } finally {
        await fh.close();
      }

      const new_offset = input.expected_offset + len;
      const advance = store.advanceOffset({
        upload_id: input.upload_id,
        expected_offset: input.expected_offset,
        new_offset,
        now,
        ttl_ms: ttlMs,
      });
      if (advance === 'not_found') return { ok: false, reason: 'not_found' };
      if (advance === 'conflict') {
        // Unreachable while the per-upload lock holds (no concurrent advance);
        // kept as a defensive re-sync reporting the now-real offset.
        const fresh = store.get(input.upload_id);
        return { ok: false, reason: 'offset_conflict', offset: fresh?.offset_bytes ?? new_offset };
      }
      return { ok: true, offset: new_offset, complete: new_offset === session.declared_size };
     });
    },

    async finalize(input) {
     return withUploadLock(input.upload_id, async (): Promise<UploadFinalizeResult<F>> => {
      const now = input.now ?? nowOf();
      const session = store.get(input.upload_id);
      if (!session) return { ok: false, reason: 'not_found' };
      if (now >= session.expires_at) return { ok: false, reason: 'expired' };
      if (session.offset_bytes !== session.declared_size) {
        return { ok: false, reason: 'incomplete', offset: session.offset_bytes };
      }

      // Capture the head (≤16 bytes, for the policy's magic-byte cross-check) +
      // materialize the scratch: stream it into the CAS (content_hash = the
      // streamed sha256) by default, or hand it to the policy's `materialize`
      // override (archive → hardlink to a staging path, returning an opaque
      // staged identifier). If the scratch has vanished (a prior finalize/delete
      // crash, or external removal), the bytes are unrecoverable → reap the
      // dangling row + report not_found rather than throwing an uncaught ENOENT.
      let head_bytes = Buffer.alloc(0);
      let content_hash: string;
      try {
        const headFh = await open(session.scratch_path, 'r');
        try {
          const buf = Buffer.alloc(Math.min(HEAD_CAPTURE_BYTES, session.declared_size));
          if (buf.length > 0) {
            const { bytesRead } = await headFh.read(buf, 0, buf.length, 0);
            head_bytes = buf.subarray(0, bytesRead);
          }
        } finally {
          await headFh.close();
        }
        content_hash = policy.materialize
          ? await policy.materialize({ scratchPath: session.scratch_path, session })
          : await putFile!(session.scratch_path);
      } catch (err) {
        if (isEnoent(err)) {
          store.delete(input.upload_id);
          return { ok: false, reason: 'not_found' };
        }
        throw err;
      }

      // Consumer materialization. If this throws, the session + scratch persist
      // so the client can retry finalize (putFile is content-addressed +
      // idempotent; the policy must be too).
      const result = await policy.finalize({
        session,
        content_hash,
        size_bytes: session.declared_size,
        head_bytes,
        ...(input.finalize_context !== undefined ? { finalize_context: input.finalize_context } : {}),
      });

      // Reap transport state. Delete the ROW before unlinking the scratch: a
      // crash in the window then leaves an orphaned scratch (reclaimed by the
      // sweeper's fs-scan backstop) instead of a live row pointing at a missing
      // scratch (which would make a finalize retry fail mid-stream).
      store.delete(input.upload_id);
      await unlinkScratch(session.scratch_path);
      return { ok: true, result };
     });
    },

    async delete(upload_id) {
     return withUploadLock(upload_id, async (): Promise<UploadDeleteResult> => {
      const session = store.get(upload_id);
      if (!session) return { ok: false, reason: 'not_found' };
      // Row before scratch (same ordering rationale as finalize).
      store.delete(upload_id);
      await unlinkScratch(session.scratch_path);
      return { ok: true };
     });
    },

    async sweepExpired(input) {
      const now = input?.now ?? nowOf();
      const expired = store.listExpired({ now, ...(input?.limit !== undefined ? { limit: input.limit } : {}) });
      const upload_ids: string[] = [];
      for (const session of expired) {
        await unlinkScratch(session.scratch_path);
        store.delete(session.upload_id);
        upload_ids.push(session.upload_id);
      }

      // Orphan backstop (rev-2 item 6): scratch files with NO live session row
      // and an old mtime — the residual the delete-before-unlink ordering can
      // briefly leak on a crash, plus any other stray. A live upload always has a
      // row (created before the file), so a row-less file is always an orphan; the
      // mtime > ttl guard is extra safety against reaping a just-created scratch.
      let orphans = 0;
      try {
        const names = await readdir(uploadsRoot);
        for (const name of names) {
          if (store.get(name)) continue; // a live session owns this scratch
          const p = join(uploadsRoot, name);
          try {
            const st = await stat(p);
            if (st.isFile() && now - st.mtimeMs > ttlMs) {
              await unlinkScratch(p);
              orphans++;
            }
          } catch (err) {
            if (!isEnoent(err)) log?.('warn', 'upload-core: orphan stat failed', { path: p });
          }
        }
      } catch (err) {
        if (!isEnoent(err)) log?.('warn', 'upload-core: orphan scan failed', { uploadsRoot });
      }

      if (upload_ids.length > 0 || orphans > 0) {
        log?.('info', 'upload-core: swept expired sessions', { reaped: upload_ids.length, orphans });
      }
      return { reaped: upload_ids.length, orphans, upload_ids };
    },
  };
};
