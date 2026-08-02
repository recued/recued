/** D-192 remote byte-fetch (follow-on B) — the shared HTTP byte-download spine
 *  for the bearer/Graph vendor resolvers (Dropbox / Google Drive / OneDrive /
 *  SharePoint / Box / Notion).
 *
 *  Every non-S3 vendor's byte read is the SAME shape once the vendor-specific
 *  URL + auth header is built: GET (or POST) the download endpoint, follow the
 *  vendor's redirect to its CDN transparently (the platform `fetch` does this —
 *  and strips the `Authorization` header on the cross-origin hop, so the bearer
 *  never leaks to the CDN), buffer the body, enforce the byte ceiling, and read
 *  the response `Content-Type` as the authoritative mime. This module writes that
 *  once (the §0 "shared logic written against the family once" rule); each vendor
 *  leaf supplies only the URL + headers it can't generalize.
 *
 *  Design: D-192. */

import { RpcError, resolveBearerAccessToken } from '@recued/contracts';
import {
  discardResponseBody,
  readBoundedResponseText,
} from '@recued/ingredients';

import type {
  FileConnectionCredential,
  FileFetch,
  FileFetchResponse,
} from '../../../file-source-adapters/index.js';

/** A `Content-Type` that carries no real signal — when the vendor's download
 *  responds with this generic type, omit the resolver's mime so the orchestrator
 *  falls back to the mirror's (often more precise) `meta.mime_type` rather than
 *  clobbering it. Mirrors the S3 resolver's "omit when empty" posture. */
const GENERIC_MIME = 'application/octet-stream';

/** A 25 MiB interactive read should not hold an RPC open indefinitely. */
export const REMOTE_BYTE_FETCH_TIMEOUT_MS = 2 * 60 * 1000;

/** Diagnostics need only a short provider error code/message. */
const REMOTE_ERROR_BODY_MAX_BYTES = 4 * 1024;

/** Resolve the OAuth/bearer access token for a file connection, or throw
 *  `file_storage_missing` — the same fail-closed posture the S3 resolver takes on
 *  a bad config. The orchestrator already resolved (and, via the file-source
 *  connection resolver, refreshed) the connection before dispatch, so a token
 *  still missing here is a genuine credential gap (a revoked / never-authorized
 *  connection), not a refresh race. */
export const bearerTokenOrThrow = (cred: FileConnectionCredential, vendorLabel: string): string => {
  const token = resolveBearerAccessToken(cred.auth);
  if (token === undefined) {
    throw new RpcError(
      'file_storage_missing',
      `${vendorLabel} remote read: connection has no usable access token`,
      500,
    );
  }
  return token;
};

export interface FetchRemoteBytesArgs {
  /** The injected fetch (platform `fetch` in prod, a stub in tests). */
  fetchImpl: FileFetch;
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  /** Request body (only the Dropbox arg-in-header download is body-less; present
   *  for completeness). */
  body?: string;
  /** The byte ceiling (`req.maxBytes`) — enforced as an early `Content-Length`
   *  preflight AND a post-buffer hard stop. */
  maxBytes: number;
  /** Vendor label + the remote locator — diagnostics only (error `reason`s). */
  vendorLabel: string;
  ref: string;
}

export interface FetchedRemoteBytes {
  bytes: Buffer;
  mime_type?: string;
}

/** Read the response body into a Buffer with a HARD byte ceiling. The
 *  `Content-Length` preflight only catches a download that HONESTLY declares its
 *  size; a chunked / length-less response (common on CDN download hops — Box's
 *  `dl.boxcloud.com`, the Graph / Google CDNs) has no length to preflight, so
 *  buffering the whole body via `arrayBuffer()` before checking would let an
 *  arbitrarily large object OOM the server. This streams chunk-by-chunk and aborts
 *  (cancelling the download) the moment the running total crosses `maxBytes`, so
 *  peak memory is bounded by `maxBytes + one chunk`. When the impl exposes no
 *  readable stream (a buffering test stub), fall back to a full read still guarded
 *  by the length check. */
const readBodyCapped = async (
  res: FileFetchResponse,
  maxBytes: number,
  vendorLabel: string,
  ref: string,
): Promise<Buffer> => {
  const tooLarge = (n: number): RpcError =>
    new RpcError(
      'remote_too_large',
      `${vendorLabel} object '${ref}' is ${n > maxBytes ? `> ${maxBytes}` : n} bytes (> ${maxBytes} ceiling)`,
      413,
    );
  const stream = res.body;
  if (stream === undefined || stream === null) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw tooLarge(buf.length);
    return buf;
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) throw tooLarge(total);
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    // Free the connection — a no-op on the normal (drained) path, and the early
    // abort that stops an oversize download on the throw path.
    void reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, total);
};

/** GET/POST a vendor download endpoint → bytes + mime, enforcing the byte
 *  ceiling. Throws `RpcError` with a `RemoteFileReadErrorCode`:
 *   - a network throw or a non-2xx response → `remote_fetch_failed` (transient;
 *     a 404 "gone at the vendor" also lands here — the periodic full walk
 *     tombstones the mirror row, so no dedicated code is warranted);
 *   - a `Content-Length` (when present) or a buffered length past `maxBytes` →
 *     `remote_too_large`.
 *  The authoritative mime is the response `Content-Type` (parameters stripped),
 *  omitted when absent or generic so the orchestrator's `meta.mime_type` fallback
 *  wins. */
export const fetchRemoteBytes = async (args: FetchRemoteBytesArgs): Promise<FetchedRemoteBytes> => {
  const { fetchImpl, url, headers, body, maxBytes, vendorLabel, ref } = args;
  const method = args.method ?? 'GET';

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REMOTE_BYTE_FETCH_TIMEOUT_MS);
  let res: FileFetchResponse | undefined;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await readBoundedResponseText(
        res as Response,
        REMOTE_ERROR_BODY_MAX_BYTES,
      ).then((value) => value.text, () => '');
      throw new RpcError(
        'remote_fetch_failed',
        `${vendorLabel} download '${ref}' → HTTP ${res.status} ${text.slice(0, 200)}`,
        502,
      );
    }
    // Early ceiling guard — reject an oversized object off its declared
    // `Content-Length` BEFORE buffering it (many vendor CDNs report one on the
    // final redirected response). The stream counter below is the backstop for
    // a chunked / length-less response.
    const lenRaw = res.headers.get('content-length');
    if (lenRaw !== null) {
      const len = Number(lenRaw);
      if (Number.isFinite(len) && len > maxBytes) {
        throw new RpcError(
          'remote_too_large',
          `${vendorLabel} object '${ref}' is ${len} bytes (> ${maxBytes} ceiling)`,
          413,
        );
      }
    }
    const bytes = await readBodyCapped(res, maxBytes, vendorLabel, ref);
    clearTimeout(timer);
    const ct = res.headers.get('content-type');
    const mime = ct !== null ? (ct.split(';')[0] ?? '').trim() : '';
    return { bytes, ...(mime.length > 0 && mime !== GENERIC_MIME ? { mime_type: mime } : {}) };
  } catch (err) {
    if (err instanceof RpcError) throw err;
    throw new RpcError(
      'remote_fetch_failed',
      timedOut
        ? `${vendorLabel} download timed out for '${ref}' after ${REMOTE_BYTE_FETCH_TIMEOUT_MS}ms`
        : `${vendorLabel} download failed for '${ref}': ${err instanceof Error ? err.message : String(err)}`,
      timedOut ? 504 : 502,
    );
  } finally {
    if (res !== undefined) discardResponseBody(res as Response);
    clearTimeout(timer);
  }
};
