import type { DownloadSocketLike } from './archive-download.js';

/** Adopt a fresh download socket. Setup cancellation owns the raw socket until
 * open; afterward the download driver owns it. No credentials are retained. */
export const connectArchiveDownloadSocket = (ws: WebSocket, signal: AbortSignal): Promise<DownloadSocketLike> => new Promise((resolve, reject) => {
  let settled = false;
  const cleanup = (): void => {
    ws.removeEventListener('open', opened); ws.removeEventListener('error', failed); ws.removeEventListener('close', closed);
    signal.removeEventListener('abort', aborted);
  };
  const refuse = (message: string, close = true): void => {
    if (settled) return;
    settled = true; cleanup();
    if (close) { try { ws.close(); } catch { /* already closed */ } }
    reject(new Error(message));
  };
  const aborted = (): void => { refuse('Download connection setup cancelled.'); };
  const failed = (): void => { refuse('Download connection could not open.'); };
  const closed = (): void => { refuse('Download connection closed before opening.', false); };
  const opened = (): void => {
    if (settled) return;
    if (signal.aborted) { aborted(); return; }
    settled = true; cleanup();
    resolve({
      send: text => ws.send(text), close: () => ws.close(),
      onText: callback => ws.addEventListener('message', event => { if (typeof event.data === 'string') callback(event.data); }),
      onBinary: callback => ws.addEventListener('message', event => { if (event.data instanceof ArrayBuffer) callback(event.data); }),
      onClose: callback => ws.addEventListener('close', () => callback()),
      onError: callback => ws.addEventListener('error', () => callback()),
    });
  };
  ws.addEventListener('open', opened); ws.addEventListener('error', failed); ws.addEventListener('close', closed);
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
});
