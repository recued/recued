/** HTTP upload transport — reception's fetch-per-chunk DATA plane.
 *
 *  Reception (rev 5) is a visitor on a page the server itself renders, at a
 *  server-controlled origin — so the chunk BYTES ride an HTTP body, not a binary
 *  WS frame. One `POST <chunkUrl>` per chunk: `Upload-Offset` + `Upload-Checksum`
 *  headers, raw bytes as the body. The server response — even a 4xx — is an
 *  OUTCOME the engine decides on (409 offset_conflict re-syncs, 422
 *  checksum_mismatch re-sends, every other non-2xx is terminal); only a network
 *  failure (fetch reject / unparseable 2xx) is a transient `UploadTransportFault`
 *  the engine reconnect+reprobes.
 *
 *  Connectionless: `open` / `reset` are no-ops (each chunk is an independent
 *  request; an abandoned upload is reaped by the server's TTL sweeper).
 *
 *  The protocol mirrors `backend/server/src/ports/reception/handlers/drop-upload.ts`.
 */

import {
  UploadTransportFault,
  type HttpUploadTransportOptions,
  type UploadChunkOutcome,
  type UploadChunkSend,
  type UploadFetch,
  type UploadTransport,
} from './types.js';

const defaultFetch: UploadFetch = (url, init) =>
  globalThis.fetch(url, init as RequestInit | undefined);

/** Pull `error.code` (a string) out of a JSON error body — `null` when absent. */
const errorCode = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) return null;
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

export const createHttpUploadTransport = (
  options: HttpUploadTransportOptions,
): UploadTransport => {
  const chunkUrl = options.chunkUrl;
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  // The chunk request currently in flight, so `reset()` (cancel / destroy) can
  // abort it — parity with the WS transport, which closes its socket on reset.
  let inFlight: AbortController | null = null;

  const send = async (chunk: UploadChunkSend): Promise<UploadChunkOutcome> => {
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'upload-offset': String(chunk.offset),
    };
    // The engine always digests, so `checksum` is non-empty — the server's
    // per-chunk integrity check is the flaky-link win.
    if (chunk.checksum.length > 0) headers['upload-checksum'] = chunk.checksum;

    const controller = new AbortController();
    inFlight = controller;
    let res;
    try {
      res = await fetchImpl(chunkUrl(chunk.uploadId), {
        method: 'POST',
        headers,
        body: chunk.bytes,
        signal: controller.signal,
      });
    } catch (err) {
      // Network-level failure (incl. an abort from `reset()`) — transient; the
      // engine reconnect+reprobes (or, after cancel/destroy, ignores it).
      throw new UploadTransportFault(err instanceof Error ? err.message : 'network_error');
    } finally {
      if (inFlight === controller) inFlight = null;
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* tolerate a missing / non-JSON body — handled per-status below */
    }

    if (res.ok) {
      const b = body as { offset?: unknown; complete?: unknown } | null;
      if (b !== null && typeof b.offset === 'number' && typeof b.complete === 'boolean') {
        return { ok: true, offset: b.offset, complete: b.complete };
      }
      // A 2xx with an unparseable body is a server fault — resync via reprobe.
      throw new UploadTransportFault('bad_chunk_response');
    }

    const reason = errorCode(body) ?? 'failed';
    if (reason === 'offset_conflict') {
      // 409 carries the real persisted offset so the engine re-syncs (without it
      // there's nothing to resync to → the engine treats it as terminal).
      const off = (body as { offset?: unknown } | null)?.offset;
      return typeof off === 'number'
        ? { ok: false, reason, offset: off }
        : { ok: false, reason };
    }
    return { ok: false, reason };
  };

  return {
    // Connectionless — nothing to open ahead of a chunk.
    open: async () => {},
    send,
    // Abort an in-flight chunk so cancel/destroy frees the connection promptly
    // (the open surface shouldn't keep streaming a torn-down upload).
    reset: () => {
      inFlight?.abort();
      inFlight = null;
    },
  };
};
