/** M4 archive download — the client protocol core (browser-agnostic).
 *
 *  Drives the `/ws/download` exchange over an injected socket: send one
 *  `download_start`, collect the ordered binary chunks, and on a matching
 *  terminal `download_complete` verify the byte count before handing the
 *  assembled parts to `saveBlob`. The transport (a real WebSocket → URL +
 *  bearer) and the save mechanism (Blob + anchor) are injected so this stays a
 *  pure state machine the tests can drive with fakes. Single-shot + idempotent:
 *  the first terminal outcome (complete / error / close / cancel) settles it and
 *  every later event is ignored. Connection setup has a 60-second deadline and
 *  is cancelled through its signal. An opened transfer fails after five minutes
 *  without bytes; receiving a nonempty chunk restarts that inactivity deadline.
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
  openSocket: (signal: AbortSignal) => Promise<DownloadSocketLike>;
  /** Request a browser save of the assembled bytes. May throw. Returning
   *  confirms the save request, not a completed disk write. */
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
): ArchiveDownloadFn => ({ name, onProgress, onError, onDone }) => {
  let socket: DownloadSocketLike | null = null;
  let settled = false;
  const parts: ArrayBuffer[] = [];
  let received = 0;
  let reqId: string | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  const setup = new AbortController();
  const reportProgress = (): void => {
    try { onProgress?.(received); } catch { /* An observer must not interrupt the transfer. */ }
  };
  const clearSetupTimer = (): void => {
    if (setupTimer !== undefined) { clearTimeout(setupTimer); setupTimer = undefined; }
  };

  /** Terminal: close the socket once and fire at most one outcome callback. */
  const settle = (cb?: () => void): void => {
    if (settled) return;
    settled = true;
    clearSetupTimer();
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
    if (socket) {
      try { socket.close(); } catch { /* already closed */ }
      socket = null;
    } else setup.abort();
    cb?.();
  };

  const watchActivity = (): void => {
    if (settled) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => settle(() => onError('The download stopped receiving data. Check your connection and try again.')), 300_000);
  };

  setupTimer = setTimeout(() => settle(() => onError('The download connection took too long. Check your connection and try again.')), 60_000);
  void (async () => {
    let s: DownloadSocketLike;
    try {
      s = await deps.openSocket(setup.signal);
    } catch {
      clearSetupTimer();
      settle(() => onError('Recued could not start the download.'));
      return;
    }
    clearSetupTimer();
    // Cancelled while the socket was opening — drop it.
    if (settled) {
      try { s.close(); } catch { /* already closed */ }
      return;
    }
    socket = s;

    s.onBinary((chunk) => {
      if (settled || chunk.byteLength === 0) return;
      parts.push(chunk);
      received += chunk.byteLength;
      watchActivity();
      reportProgress();
    });
    s.onText((text) => {
      if (settled) return;
      const frame = parseDownloadControlFrame(text);
      if (!frame || reqId === undefined) return;
      // A server rejecting an undecodable start can only send bad_request
      // without an ID. Require the active ID on every other terminal frame.
      if (frame.req_id !== reqId && !(
        frame.type === 'download_error' && frame.req_id === undefined && frame.reason === 'bad_request'
      )) return;
      if (frame.type === 'download_complete') {
        if (received !== frame.size_bytes) {
          settle(() => onError('The download did not finish. Please try again.'));
          return;
        }
        // Request the save before reporting the handoff. The browser does not
        // report the user's save choice or the eventual disk write.
        let saveRequested = true;
        try { deps.saveBlob(name, parts); } catch { saveRequested = false; }
        settle(saveRequested ? onDone : () => onError('Recued could not start the browser save. Please try again.'));
      } else if (frame.type === 'download_error') {
        settle(() => onError(messageFor(frame.reason)));
      }
    });
    s.onClose(() => settle(() => onError('The download stopped before it finished.')));
    s.onError(() => settle(() => onError('The download went wrong.')));

    try {
      watchActivity();
      reportProgress();
      if (!settled) {
        reqId = deps.newReqId();
        s.send(JSON.stringify({ type: 'download_start', req_id: reqId, name }));
      }
    } catch {
      settle(() => onError('Recued could not start the download.'));
    }
  })();

  // The cancel fn: settle with no callback (the caller drove the cancel).
  return () => settle();
};
