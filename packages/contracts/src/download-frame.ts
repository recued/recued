/** M4 archive download — webclient transport contract (shared wire format).
 *
 *  The export archive lives as a finished file on the server (`<data>/exports/`);
 *  the webclient pulls it over a DEDICATED binary `/ws/download` socket (the rpc
 *  wire is text-JSON only, so the bytes can't ride it). Unlike `/ws/upload`,
 *  download is SINGLE-SHOT and the SERVER owns the byte order, so the data
 *  direction needs no per-frame header — the server streams raw binary chunks in
 *  order and terminates with one text control frame. Only the three control
 *  frames are structured:
 *
 *    client -> server (text):   DownloadStartFrame   — names the archive to pull
 *    server -> client (binary):  raw chunk bytes, in order, NO header
 *    server -> client (text):   DownloadCompleteFrame | DownloadErrorFrame
 *
 *  The capability is the connection's verified bearer (the socket is
 *  authenticated + scoped to the paired instance at upgrade); the requested
 *  `name` is confined server-side to a generated export file under `exports/`,
 *  never an arbitrary path. The archive itself is encrypted under the
 *  recovery-key-derived content key, so the streamed ciphertext is inert without
 *  the key (decryption happens only at import time). Plain JSON / `Uint8Array`
 *  so it runs unchanged in the browser PWA and in node. */

export interface DownloadStartFrame {
  readonly type: 'download_start';
  /** Client-minted correlation id; echoed on the terminal control frame. */
  readonly req_id: string;
  /** Requested archive file name. Confined server-side to `basename(name)`
   *  matching a generated export under `exports/` — a path / traversal in
   *  `name` can never escape that directory. */
  readonly name: string;
}

export interface DownloadCompleteFrame {
  readonly type: 'download_complete';
  readonly req_id: string;
  /** Total bytes streamed — the client asserts it received exactly this many
   *  (catches a truncated transfer before it hands the file off). */
  readonly size_bytes: number;
}

export type DownloadErrorReason =
  | 'bad_request' // unparseable / missing-field start frame
  | 'invalid_name' // `name` isn't a generated export file
  | 'not_found' // no such export on disk
  | 'read_error'; // disk read / send failed mid-stream

export interface DownloadErrorFrame {
  readonly type: 'download_error';
  /** Absent only when the start frame was too malformed to echo a `req_id`. */
  readonly req_id?: string;
  readonly reason: DownloadErrorReason;
}

/** Every control frame on the socket (client + server directions). */
export type DownloadControlFrame =
  | DownloadStartFrame
  | DownloadCompleteFrame
  | DownloadErrorFrame;

export type DownloadStartDecodeResult =
  | { readonly ok: true; readonly frame: DownloadStartFrame }
  | { readonly ok: false; readonly reason: 'bad_request' };

/** Decode the client's `download_start` text frame (server side). Never throws —
 *  a malformed frame returns `{ ok: false }` so the caller replies with a
 *  `download_error` instead of tearing down the socket. */
export const decodeDownloadStart = (raw: string): DownloadStartDecodeResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'bad_request' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'bad_request' };
  }
  const f = parsed as Record<string, unknown>;
  if (
    f.type !== 'download_start' ||
    typeof f.req_id !== 'string' ||
    f.req_id.length === 0 ||
    typeof f.name !== 'string' ||
    f.name.length === 0
  ) {
    return { ok: false, reason: 'bad_request' };
  }
  return { ok: true, frame: { type: 'download_start', req_id: f.req_id, name: f.name } };
};

/** Parse a server -> client control frame (client side). Returns `null` for a
 *  non-control / unparseable text frame so the caller can ignore it. */
export const parseDownloadControlFrame = (raw: string): DownloadControlFrame | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const f = parsed as Record<string, unknown>;
  if (f.type === 'download_complete' && typeof f.req_id === 'string' && typeof f.size_bytes === 'number') {
    return { type: 'download_complete', req_id: f.req_id, size_bytes: f.size_bytes };
  }
  if (f.type === 'download_error' && typeof f.reason === 'string') {
    return {
      type: 'download_error',
      ...(typeof f.req_id === 'string' ? { req_id: f.req_id } : {}),
      reason: f.reason as DownloadErrorReason,
    };
  }
  return null;
};
