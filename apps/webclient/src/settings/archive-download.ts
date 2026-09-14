/** M4 archive download — the client protocol core (browser-agnostic).
 *
 *  Drives the `/ws/download` exchange over an injected socket: send one
 *  `download_start`, collect the ordered binary chunks, and on the terminal
 *  `download_complete` verify the byte count matches before handing the
 *  assembled parts to `saveBlob`. The transport (a real WebSocket → URL +
 *  bearer) and the save mechanism (Blob + anchor) are injected so this stays a
 *  pure state machine the tests can drive with fakes. Single-shot + idempotent:
 *  the first terminal outcome (complete / error / close / cancel) settles it and
 *  every later event is ignored.
 *
 *  No `Buffer` — `apps/webclient` is an esbuild `platform:'browser'` bundle with
 *  no Buffer shim; the bytes stay `ArrayBuffer`. */

import {
  parseDownloadControlFrame,
  type DownloadErrorReason,
} from '@recued/contracts';
import type { ArchiveDownloadFn } from './archive-backup-panel.js';

/** A minimal view of the binary download socket — an adapter over the real
 *  WebSocket lives in the host (it owns the URL + bearer). */
export interface DownloadSocketLike {
  send(text: string): void;
  close(): void;
  onText(cb: (text: string) => void): void;
  onBinary(cb: (chunk: ArrayBuffer) => void): void;
  onClose(cb: () => void): void;
  onError(cb: () => void): void;
}

export interface ArchiveDownloadDeps {
  /** Open the authenticated binary `/ws/download` socket (resolved once it is
   *  open). Rejects when it can't be opened / authenticated. */
  openSocket: () => Promise<DownloadSocketLike>;
  /** Save the assembled bytes as a browser download. May throw. */
  saveBlob: (filename: string, parts: ArrayBuffer[]) => void;
  /** Mint a correlation id for the start frame. */
  newReqId: () => string;
}

const messageFor = (reason: DownloadErrorReason): string => {
  switch (reason) {
    case 'not_found':
      return 'That backup is no longer on the server.';
    case 'invalid_name':
      return 'That backup file name will not work.';
    case 'read_error':
      return 'The server could not read the backup.';
    case 'bad_request':
      return 'Your server said no to the download.';
    default:
      return 'The download failed.';
  }
};

export const createArchiveDownload = (
  deps: ArchiveDownloadDeps,
): ArchiveDownloadFn => ({ name, onError, onDone }) => {
  let socket: DownloadSocketLike | null = null;
  let settled = false;
  const parts: ArrayBuffer[] = [];
  let received = 0;

  /** Terminal: close the socket once and fire at most one outcome callback. */
  const settle = (cb?: () => void): void => {
    if (settled) return;
    settled = true;
    if (socket) {
      try { socket.close(); } catch { /* already closed */ }
      socket = null;
    }
    cb?.();
  };

  void (async () => {
    let s: DownloadSocketLike;
    try {
      s = await deps.openSocket();
    } catch {
      settle(() => onError('Recued could not start the download.'));
      return;
    }
    // Cancelled while the socket was opening — drop it.
    if (settled) {
      try { s.close(); } catch { /* already closed */ }
      return;
    }
    socket = s;

    s.onBinary((chunk) => {
      if (settled) return;
      parts.push(chunk);
      received += chunk.byteLength;
    });
    s.onText((text) => {
      if (settled) return;
      const frame = parseDownloadControlFrame(text);
      if (!frame) return;
      if (frame.type === 'download_complete') {
        if (received !== frame.size_bytes) {
          settle(() => onError('The download did not finish. Please try again.'));
          return;
        }
        // Save before reporting success — only `onDone` if it actually saved.
        let saved = true;
        try { deps.saveBlob(name, parts); } catch { saved = false; }
        settle(saved ? onDone : () => onError('Recued could not save the download.'));
      } else if (frame.type === 'download_error') {
        settle(() => onError(messageFor(frame.reason)));
      }
    });
    s.onClose(() => settle(() => onError('The download stopped before it finished.')));
    s.onError(() => settle(() => onError('The download went wrong.')));

    try {
      s.send(JSON.stringify({ type: 'download_start', req_id: deps.newReqId(), name }));
    } catch {
      settle(() => onError('Recued could not start the download.'));
    }
  })();

  // The cancel fn: settle with no callback (the caller drove the cancel).
  return () => settle();
};
