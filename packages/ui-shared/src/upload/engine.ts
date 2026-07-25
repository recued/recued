/** Shared resumable-upload engine — the pure network state machine.
 *
 *  No DOM, no transport details. Drives one file at a time over the abstract
 *  control plane (`UploadCallers`) + DATA plane (`UploadTransport`):
 *
 *    upload.create (or upload.probe to resume)            [callers]
 *      → transport.open()                                 [transport]
 *      → loop: slice → sha256 → transport.send(chunk)
 *               advance to the server's authoritative offset
 *      → upload.finalize                                   [callers]
 *      → emit `done`
 *
 *  Robustness the loop folds in:
 *   - resume — a re-picked SAME file (name+size+lastModified) probes the
 *     persisted offset and continues; a different file creates fresh.
 *   - offset_conflict — re-sync to the server's real offset and continue.
 *   - checksum_mismatch — re-send the same slice in place.
 *   - transport fault (timeout / dropped connection / network) — reset + probe +
 *     resume, bounded by `maxReconnects` (the budget resets on any progress).
 *
 *  The TRANSPORT owns the chunk round-trip + its own connection lifecycle (the
 *  webclient's binary WS socket, or reception's fetch-per-chunk); the engine is
 *  transport-agnostic. Everything is injectable (callers, transport, digest,
 *  store) so the whole machine is exercised headless with fakes.
 */

import type {
  UploadCallers,
  UploadChunkOutcome,
  UploadDigest,
  UploadEngine,
  UploadEngineOptions,
  UploadFile,
  UploadProgress,
  UploadProgressListener,
  UploadResumeStore,
  UploadTransport,
} from './types.js';

/** 4 MiB — comfortably under the server's 16 MiB `UPLOAD_CHUNK_MAX_BYTES`. */
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_RECONNECTS = 5;
/** Consecutive re-sends of the SAME slice (a `checksum_mismatch` loop) before
 *  giving up — bounds a pathological client/server digest disagreement that
 *  would otherwise spin forever. Reset on any forward progress. */
const MAX_SLICE_RETRIES = 3;

/** A malformed-frame / session-gone outcome the loop cannot recover from —
 *  surfaces as a terminal `error` progress event. */
class FatalUpload extends Error {
  constructor(
    readonly reason: string,
    readonly detail?: string,
  ) {
    super(reason);
    this.name = 'FatalUpload';
  }
}

const hex = (bytes: Uint8Array): string => {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
};

const defaultDigest: UploadDigest = async (bytes) => {
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle;
  if (subtle === undefined) {
    throw new Error('crypto.subtle unavailable for upload checksum');
  }
  const digest = await subtle.digest('SHA-256', bytes as BufferSource);
  return hex(new Uint8Array(digest));
};

const createMemoryStore = (): UploadResumeStore => {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    delete: (key) => {
      map.delete(key);
    },
  };
};

/** Resume key — a file is "the same file" iff name + size + mtime all match
 *  (the server's `upload.probe` independently gates on file identity too). */
const resumeKey = (file: UploadFile): string =>
  `${file.name}:${file.size}:${file.lastModified}`;

export const createUploadEngine = (
  options: UploadEngineOptions,
): UploadEngine => {
  const callers: UploadCallers = options.callers;
  const transport: UploadTransport = options.transport;
  const digest = options.digest ?? defaultDigest;
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const maxReconnects = options.maxReconnects ?? DEFAULT_MAX_RECONNECTS;
  const store = options.store ?? createMemoryStore();

  const listeners = new Set<UploadProgressListener>();

  // ── per-run mutable state ──────────────────────────────────────────
  let generation = 0; // bumped to invalidate an in-flight run (cancel/destroy)
  let running = false;
  let cancelled = false;
  let destroyed = false;
  let uploadId = '';
  let activeKey: string | null = null;

  const emit = (progress: UploadProgress): void => {
    if (destroyed) return;
    for (const listener of listeners) listener(progress);
  };

  // ── control-plane helpers ──────────────────────────────────────────

  /** Resolve the starting offset: resume a stored session via `probe`, else
   *  `create` a fresh one. Returns `file.size` when the server already holds
   *  the whole file (→ straight to finalize). Throws `FatalUpload` on reject. */
  const resolveStart = async (file: UploadFile, key: string): Promise<number> => {
    const stored = store.get(key);
    if (stored !== null) {
      const probe = await callers.probe({
        upload_id: stored,
        filename: file.name,
        declared_size: file.size,
      });
      if (probe.resumable) {
        uploadId = stored;
        return probe.complete ? file.size : probe.offset;
      }
      store.delete(key); // not_found / expired / file_mismatch → recreate
    }
    const created = await callers.create({
      filename: file.name,
      declared_size: file.size,
      mime_reported: file.type !== '' ? file.type : 'application/octet-stream',
    });
    if (created.status === 'rejected') {
      throw new FatalUpload(created.reason, created.detail);
    }
    uploadId = created.upload_id;
    store.set(key, uploadId);
    return 0;
  };

  /** Re-probe the active session's persisted offset (used after a fault).
   *  Throws `FatalUpload` if the session vanished mid-stream. */
  const probeOffset = async (file: UploadFile): Promise<number> => {
    const probe = await callers.probe({
      upload_id: uploadId,
      filename: file.name,
      declared_size: file.size,
    });
    if (probe.resumable) return probe.complete ? file.size : probe.offset;
    throw new FatalUpload(probe.reason);
  };

  // ── the run loop ───────────────────────────────────────────────────
  const run = async (file: UploadFile, gen: number): Promise<void> => {
    const aborted = (): boolean => cancelled || destroyed || gen !== generation;
    const total = file.size;
    const fail = (sent: number, reason: string): void => {
      if (!aborted()) {
        emit({ filename: file.name, sent, total, phase: 'error', error: reason });
      }
    };

    const key = resumeKey(file);
    activeKey = key;
    let offset = 0;
    let reconnects = 0;
    let sliceRetries = 0; // consecutive same-slice re-sends (checksum loop guard)

    emit({ filename: file.name, sent: 0, total, phase: 'uploading' });
    try {
      offset = await resolveStart(file, key);
    } catch (err) {
      if (aborted()) return;
      return fail(0, reasonOf(err));
    }
    // A cancel/destroy that landed WHILE `create` was in flight couldn't reap
    // (uploadId was still ''); now that the session exists, reap it here.
    if (aborted()) {
      reapSession(uploadId, key);
      return;
    }
    emit({ filename: file.name, sent: offset, total, phase: 'uploading' });

    // Outer loop: chunk phase → finalize. A finalize-`pending` loops back.
    for (;;) {
      // ── chunk phase ──
      while (offset < total) {
        if (aborted()) return;
        let ack: UploadChunkOutcome;
        try {
          await transport.open(aborted);
          const end = Math.min(offset + chunkBytes, total);
          const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
          if (aborted()) return;
          const checksum = await digest(bytes);
          if (aborted()) return;
          ack = await transport.send({ uploadId, offset, checksum, bytes });
        } catch (err) {
          if (aborted()) return;
          if (err instanceof FatalUpload) return fail(offset, err.reason);
          // UploadTransportFault (or any non-fatal throw) — resync the offset
          // and retry, bounded by the reconnect budget.
          if (++reconnects > maxReconnects) return fail(offset, 'connection_lost');
          const priorOffset = offset;
          transport.reset();
          try {
            offset = await probeOffset(file);
          } catch (probeErr) {
            if (aborted()) return;
            return fail(
              offset,
              probeErr instanceof FatalUpload ? probeErr.reason : 'connection_lost',
            );
          }
          if (aborted()) return;
          // A dropped ack whose chunk the server actually persisted IS forward
          // progress — refill the reconnect budget so a flaky link that keeps
          // landing bytes never exhausts it (mirrors the ok-ack reset).
          if (offset > priorOffset) reconnects = 0;
          sliceRetries = 0;
          emit({ filename: file.name, sent: offset, total, phase: 'uploading' });
          continue;
        }

        if (ack.ok) {
          offset = ack.offset; // the server's authoritative new offset
          reconnects = 0; // forward progress refills the reconnect budget
          sliceRetries = 0;
          emit({ filename: file.name, sent: offset, total, phase: 'uploading' });
          if (ack.complete) break;
          continue;
        }
        // Recoverable !ok reasons; everything else is terminal.
        if (ack.reason === 'offset_conflict') {
          // The real persisted offset MUST ride the conflict so a stale client
          // re-syncs; without it there's nothing to resync to → terminal.
          if (typeof ack.offset !== 'number') return fail(offset, 'offset_conflict');
          offset = ack.offset;
          sliceRetries = 0;
          emit({ filename: file.name, sent: offset, total, phase: 'uploading' });
          continue;
        }
        if (ack.reason === 'checksum_mismatch') {
          // Re-send the same slice in place — but bound the loop so a stable
          // digest disagreement can't spin forever.
          if (++sliceRetries > MAX_SLICE_RETRIES) {
            return fail(offset, 'checksum_mismatch');
          }
          continue;
        }
        return fail(offset, ack.reason);
      }
      if (aborted()) return;

      // ── finalize phase ──
      emit({ filename: file.name, sent: total, total, phase: 'finalizing' });
      let fin;
      try {
        fin = await callers.finalize({ upload_id: uploadId });
      } catch (err) {
        if (aborted()) return;
        return fail(total, reasonOf(err));
      }
      if (aborted()) return;
      if (fin.status === 'finalized') {
        store.delete(key);
        emit({
          filename: file.name,
          sent: total,
          total,
          phase: 'done',
          recordId: fin.record_id,
        });
        return;
      }
      if (fin.status === 'gone') {
        store.delete(key);
        return fail(total, fin.reason);
      }
      // status === 'pending' (incomplete) — the server's offset wins; resume.
      // A correct server reports offset < total here; guard the contradiction
      // (offset already full yet still "incomplete") so we don't re-finalize
      // in a tight loop.
      if (fin.offset >= total) return fail(total, 'incomplete');
      offset = fin.offset;
      sliceRetries = 0;
      emit({ filename: file.name, sent: offset, total, phase: 'uploading' });
    }
  };

  // ── public surface ─────────────────────────────────────────────────
  const start = (file: UploadFile): void => {
    if (destroyed || running) return;
    cancelled = false;
    running = true;
    const gen = ++generation;
    void run(file, gen).finally(() => {
      if (gen === generation) running = false;
    });
  };

  /** Best-effort reap of a scratch session: drop the local resume entry +
   *  tell the server to free the scratch. Idempotent (a double-delete is
   *  harmless) so the in-flight-`create` cancel race below can reap twice. */
  const reapSession = (id: string, key: string | null): void => {
    if (key !== null) store.delete(key);
    if (id !== '') void callers.delete({ upload_id: id }).catch(() => {});
  };

  const cancel = (): void => {
    if (!running) return;
    cancelled = true;
    generation++; // invalidate the in-flight run
    running = false;
    transport.reset();
    // `uploadId` may still be '' if `create` is in-flight; the post-resolve
    // abort guard in `run` reaps the late-created session in that case.
    reapSession(uploadId, activeKey);
  };

  const on = (
    _event: 'progress',
    listener: UploadProgressListener,
  ): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const destroy = (): void => {
    destroyed = true;
    cancelled = true;
    generation++;
    running = false;
    transport.reset();
    // Symmetric with cancel — an in-flight upload abandoned by teardown also
    // frees its server scratch instead of lingering until the sweeper reaps it.
    reapSession(uploadId, activeKey);
    listeners.clear();
  };

  return { start, cancel, on, destroy };
};

const reasonOf = (err: unknown): string =>
  err instanceof FatalUpload
    ? err.reason
    : err instanceof Error
      ? err.message
      : String(err);
