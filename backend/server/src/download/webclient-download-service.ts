/** M4 archive download — server-side streaming pump for the binary
 *  `/ws/download` socket.
 *
 *  Resolves the requested export file (confined to a generated name under
 *  `<data>/exports/`) and streams it to the socket with backpressure: one chunk
 *  is read + sent, and the NEXT is pulled only after the send flushes (the
 *  `ws.send` completion callback), so a slow client paces the read stream
 *  instead of ballooning the send buffer. Single-shot, no session state — the
 *  export is the server's single-latest snapshot, already on disk (the M2
 *  streaming assembler wrote it), so download never buffers the archive in RAM.
 *
 *  Auth is the socket's verified bearer (checked at upgrade, scoped to the
 *  paired instance); the archive bytes are ciphertext under the recovery-key, so
 *  even an over-broad reader gains nothing without the key. */

import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  decodeDownloadStart,
  type DownloadControlFrame,
} from '@recued/contracts';
import {
  EXPORT_TTL_MS,
  exportsDir,
  isGeneratedExportName,
} from '../archive/export-store.js';

/** Read-stream chunk size for the outbound pump. Larger ⇒ fewer frames + less
 *  per-chunk overhead; smaller ⇒ finer backpressure granularity. 512 KiB sits
 *  well under any ws frame ceiling and keeps the per-chunk send buffer modest. */
export const DOWNLOAD_CHUNK_BYTES = 512 * 1024;

/** Tight inbound cap for the download socket's `maxPayload`: the client only
 *  ever sends ONE small `download_start` text frame, so reject anything larger
 *  at the WS layer before it reaches this service. */
export const DOWNLOAD_WS_MAX_INBOUND_BYTES = 64 * 1024;

export interface DownloadServiceDeps {
  /** `dirname(dbPath)` — the archive runtime's data dir; exports live in
   *  `<dataPath>/exports/` (`export-store.exportsDir`). */
  readonly dataPath: string;
  /** Clock — injected for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Minimal socket the pump drives — the ws-server wraps the raw socket so the
 *  service stays unit-testable with a fake. `sendBinary`'s callback fires after
 *  the frame is flushed (the ws backpressure signal); `sendControl` is
 *  fire-and-forget text. */
export interface DownloadSink {
  isOpen(): boolean;
  sendBinary(chunk: Uint8Array, cb: (err?: Error) => void): void;
  sendControl(frame: string): void;
}

export interface WebclientDownloadService {
  /** Handle one inbound text frame (a `download_start`) by streaming the named
   *  export to the sink. Total — every path resolves to a terminal control
   *  frame, or a quiet abandon if the socket closed mid-stream. */
  handleStart(raw: string, sink: DownloadSink): Promise<void>;
}

/** Deps the ws-server hands the upgrade router (mirrors `UploadHandlerDeps`). */
export interface DownloadHandlerDeps {
  service: WebclientDownloadService;
}

const control = (frame: DownloadControlFrame): string => JSON.stringify(frame);

export const createWebclientDownloadService = (
  deps: DownloadServiceDeps,
): WebclientDownloadService => ({
  async handleStart(raw, sink) {
    const decoded = decodeDownloadStart(raw);
    if (!decoded.ok) {
      sink.sendControl(control({ type: 'download_error', reason: 'bad_request' }));
      return;
    }
    const { req_id, name } = decoded.frame;

    // Confine to a generated export file under `exports/`: only the basename is
    // honored, so a path / `..` traversal in `name` can never escape the dir,
    // and the generated-name shape gate means only our own export slots — never
    // an arbitrary hand-placed restore source — are ever served out.
    const safeName = basename(name);
    if (!isGeneratedExportName(safeName)) {
      sink.sendControl(control({ type: 'download_error', req_id, reason: 'invalid_name' }));
      return;
    }
    const path = join(exportsDir(deps.dataPath), safeName);

    let size: number;
    try {
      const s = await stat(path);
      if (!s.isFile()) throw new Error('not a regular file');
      // Honor the same 7-day `download by <date>` boundary `archive.status`
      // enforces: an export past its TTL is treated as gone (and reclaimed),
      // so a kept filename can't pull a stale archive that should have expired
      // before the next boot / export-start prune sweep runs.
      const nowMs = deps.now?.() ?? Date.now();
      if (s.mtimeMs < nowMs - EXPORT_TTL_MS) {
        await unlink(path).catch(() => { /* raced with a sweep — fine */ });
        sink.sendControl(control({ type: 'download_error', req_id, reason: 'not_found' }));
        return;
      }
      size = s.size;
    } catch {
      sink.sendControl(control({ type: 'download_error', req_id, reason: 'not_found' }));
      return;
    }

    const stream = createReadStream(path, { highWaterMark: DOWNLOAD_CHUNK_BYTES });
    try {
      for await (const chunk of stream) {
        if (!sink.isOpen()) return; // client vanished — abandon quietly
        // Await the flush callback before pulling the next chunk: this is the
        // backpressure. A slow / stalled client holds the read stream paused
        // rather than letting the send buffer grow without bound.
        await new Promise<void>((resolve, reject) => {
          sink.sendBinary(chunk as Uint8Array, (err) => (err ? reject(err) : resolve()));
        });
      }
      if (sink.isOpen()) {
        sink.sendControl(control({ type: 'download_complete', req_id, size_bytes: size }));
      }
    } catch {
      // Read error, or the socket failed mid-send — report iff still open.
      if (sink.isOpen()) {
        sink.sendControl(control({ type: 'download_error', req_id, reason: 'read_error' }));
      }
    } finally {
      stream.destroy();
    }
  },
});
