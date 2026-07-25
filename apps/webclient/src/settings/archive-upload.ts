/** M4b.2 archive upload — the client protocol core (browser-agnostic).
 *
 *  The UPLOAD half of the no-SSH migrate (M4a gave download). A user picks a
 *  `.recued.archive` and this drives the `/ws/archive-upload` exchange:
 *
 *    server.archive.upload.create  →  chunk the file over the binary socket  →
 *    server.archive.upload.finalize → emit `done` with the server-minted
 *    `staged_name` (the basename under `exports/` the restore import resolves).
 *
 *  Rather than re-derive the resumable chunk-loop, this REUSES the shipped,
 *  battle-tested upload machinery WHOLESALE: `createWsUploadTransport` (the
 *  byte-identical binary data plane — its chunk frame is the same generic
 *  `upload-frame.ts` the webclient `/ws/upload` consumer uses) + `createUploadEngine`
 *  (offset tracking, resume, reconnect budget, offset-conflict / checksum
 *  re-sync). The ONLY archive-specific glue is four thin adapter callers that
 *  map the `server.archive.upload.*` control plane onto the engine's
 *  `UploadCallers` shape, plus surfacing `finalize`'s `staged_name` (the engine
 *  itself only needs a `finalized` marker — it never reads `content_hash`).
 *
 *  No `Buffer` — `apps/webclient` is an esbuild `platform:'browser'` bundle with
 *  no Buffer shim; the bytes stay `Uint8Array` / `ArrayBuffer` (the engine reads
 *  the file via `File.slice().arrayBuffer()` and digests with `crypto.subtle`). */

import { Upload } from '@recued/ui-shared';
import type {
  ArchiveUploadCreateRpcRequest,
  ArchiveUploadCreateRpcResponse,
  ArchiveUploadDeleteRpcRequest,
  ArchiveUploadDeleteRpcResponse,
  ArchiveUploadFinalizeRpcRequest,
  ArchiveUploadFinalizeRpcResponse,
  ArchiveUploadProbeRpcRequest,
  ArchiveUploadProbeRpcResponse,
} from '@recued/contracts';
import type { ArchiveUploadFn } from './archive-backup-panel.js';

/** The four `server.archive.upload.*` control-plane callers the host injects
 *  (each a thin `rpcConn.call('server.archive.upload.<x>', args)` wrapper).
 *  `scope_key` is never passed — the server resolves it from the verified
 *  bearer. */
export interface ArchiveUploadCallers {
  create(
    req: ArchiveUploadCreateRpcRequest,
  ): Promise<ArchiveUploadCreateRpcResponse>;
  probe(
    req: ArchiveUploadProbeRpcRequest,
  ): Promise<ArchiveUploadProbeRpcResponse>;
  finalize(
    req: ArchiveUploadFinalizeRpcRequest,
  ): Promise<ArchiveUploadFinalizeRpcResponse>;
  delete(
    req: ArchiveUploadDeleteRpcRequest,
  ): Promise<ArchiveUploadDeleteRpcResponse>;
}

export interface ArchiveUploadDeps {
  /** Open the authenticated binary `/ws/archive-upload` socket. The host owns
   *  the URL + bearer (this module can't reach the token store), so it injects
   *  the factory — mirrors the webclient `uploadConnectFactory`. */
  connect: Upload.UploadConnectFactory;
  /** The `server.archive.upload.*` rpc callers. */
  callers: ArchiveUploadCallers;
  /** Hex-SHA-256 digest. Default: the engine's `crypto.subtle`. Injected by
   *  tests for determinism. */
  digest?: Upload.UploadDigest;
  /** Bytes per chunk. Default: the engine's 4 MiB (server cap is 16 MiB).
   *  Tests shrink it to force multi-chunk paths. */
  chunkBytes?: number;
  /** How many times to (re)call `finalize` when the rpc drops on TRANSPORT
   *  (the lost-finalize-response recovery — the server finalize is idempotent,
   *  re-deriving `staged_name` from the staged file). Default 4. */
  finalizeMaxAttempts?: number;
  /** Delay between finalize retries (ms). Default 2000 — long enough for the WS
   *  rpc to reconnect + drain the queued call. */
  finalizeRetryDelayMs?: number;
  /** Sleep seam (tests inject an instant resolver to avoid real timers). */
  sleep?: (ms: number) => Promise<void>;
}

/** rpc-conn reject codes that mean the call didn't get a verdict because the
 *  socket dropped / the conn is reconnecting / a reauth is pending — i.e. the
 *  finalize RESPONSE may be lost while the server already staged the archive.
 *  Mirrors the panel's `isTransportDropError`. */
const isTransportError = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === 'transport' ||
    code === 'transport_disposed' ||
    code === 'timeout' ||
    code === 'webclient_reauth_required'
  );
};

/** Map an engine error reason (the chunk-core / control-plane reasons + the
 *  engine's own connection verdicts) to a short user-facing phrase. The panel
 *  prefixes it with "Upload failed:". */
const messageForUploadReason = (reason: string): string => {
  switch (reason) {
    case 'connection_lost':
      return 'the connection was lost.';
    case 'size_cap_exceeded':
      return 'the file is too large.';
    case 'too_many_sessions':
    case 'pending_bytes_exceeded':
      return 'the server is busy — try again in a moment.';
    case 'insufficient_disk':
      // M5 S3 — the restore upload's statfs pre-flight (`server.archive.upload.
      // create`) refused because the declared archive plus headroom won't fit
      // the server's free disk. Now reachable (the create `reason` union gained
      // it), so map it to plain copy rather than echoing the raw token.
      return "there isn't enough free space on your server for this backup.";
    case 'not_found':
    case 'expired':
      return 'the upload session expired — try again.';
    case 'checksum_mismatch':
      return 'the upload was corrupted in transit — try again.';
    case 'incomplete':
      return 'the upload did not complete — try again.';
    case 'invalid_declared_size':
      return 'that file could not be read.';
    default:
      return reason;
  }
};

export const createArchiveUpload = (deps: ArchiveUploadDeps): ArchiveUploadFn => (
  req,
) => {
  // The engine emits `done` with `recordId` only; the archive's authoritative
  // result (staged_name + size) is captured here from the real finalize reply.
  let lastFinalize: { staged_name: string; size_bytes: number } | null = null;

  const finalizeMaxAttempts = deps.finalizeMaxAttempts ?? 4;
  const finalizeRetryDelayMs = deps.finalizeRetryDelayMs ?? 2000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** Call `finalize`, retrying ONLY on a transport drop. A drop can lose the
   *  finalize RESPONSE after the server already staged the archive; the server
   *  finalize is idempotent (re-derives `staged_name` from the staged file), so
   *  re-calling recovers it — the WS rpc queues the call + drains on reconnect.
   *  Non-transport rejects (a real server error) propagate immediately; once the
   *  transport budget is spent, surface a clean `connection_lost` the panel maps. */
  const callFinalize = async (
    upload_id: string,
  ): Promise<ArchiveUploadFinalizeRpcResponse> => {
    for (let attempt = 1; attempt <= finalizeMaxAttempts; attempt += 1) {
      try {
        return await deps.callers.finalize({ upload_id });
      } catch (err) {
        if (!isTransportError(err)) throw err;
        if (attempt < finalizeMaxAttempts) await sleep(finalizeRetryDelayMs);
      }
    }
    throw new Error('connection_lost');
  };

  // Adapt the `server.archive.upload.*` control plane onto the engine's
  // `UploadCallers`. `create` drops the engine's `mime_reported` (the archive
  // create has no such field); `finalize` returns a synthetic `finalized`
  // marker (engine never reads `content_hash`) while stashing the real result.
  const callers: Upload.UploadCallers = {
    create: (r) =>
      deps.callers.create({
        filename: r.filename,
        declared_size: r.declared_size,
        ...(r.fingerprint != null ? { fingerprint: r.fingerprint } : {}),
      }),
    probe: (r) =>
      deps.callers.probe({
        upload_id: r.upload_id,
        filename: r.filename,
        declared_size: r.declared_size,
        ...(r.fingerprint != null ? { fingerprint: r.fingerprint } : {}),
      }),
    finalize: async (r) => {
      const res = await callFinalize(r.upload_id);
      if (res.status === 'finalized') {
        lastFinalize = {
          staged_name: res.staged_name,
          size_bytes: res.size_bytes,
        };
        return {
          status: 'finalized',
          record_id: res.staged_name,
          content_hash: '',
          size_bytes: res.size_bytes,
        };
      }
      return res; // pending | gone — structurally identical to the engine's union
    },
    delete: (r) => deps.callers.delete({ upload_id: r.upload_id }),
  };

  const transport = Upload.createWsUploadTransport({ connect: deps.connect });
  const engine = Upload.createUploadEngine({
    callers,
    transport,
    ...(deps.digest !== undefined ? { digest: deps.digest } : {}),
    ...(deps.chunkBytes !== undefined ? { chunkBytes: deps.chunkBytes } : {}),
  });

  // Single-shot + idempotent: the first terminal outcome (done / error / cancel)
  // settles it; every later engine event is ignored.
  let settled = false;
  const unsub = engine.on('progress', (p) => {
    if (settled) return;
    if (p.phase === 'uploading' || p.phase === 'finalizing') {
      req.onProgress(p.sent, p.total);
      return;
    }
    settled = true;
    unsub();
    // The run already completed — just close the socket (NO reap): a `done`
    // session was deleted server-side by finalize, and an `error` scratch is
    // left for the TTL sweep, exactly as the shipped `/ws/upload` consumer does.
    transport.reset();
    if (p.phase === 'done') {
      const result = lastFinalize ?? {
        staged_name: p.recordId ?? '',
        size_bytes: p.total,
      };
      req.onDone(result);
    } else {
      // phase === 'error'
      req.onError(messageForUploadReason(p.error ?? 'error'));
    }
  });

  engine.start(req.file as Upload.UploadFile);

  // Cancel: settle silently. `engine.cancel()` reaps the server scratch (the
  // user abandoned it) AND closes the socket; `unsub` first so no terminal
  // outcome callback fires. The caller drove the cancel.
  return () => {
    if (settled) return;
    settled = true;
    unsub();
    engine.cancel();
  };
};
