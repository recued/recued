/** D-115 Phase 6 — http-watcher handler.
 *
 *  Polls `target_url` and fires when the response has changed since
 *  the stored cursor. Change detection prefers ETag when the origin
 *  provides one; falls back to a SHA-256 hash of the body.
 *
 *  Conditional-request semantics: when `previous_etag` is supplied
 *  the handler sends `If-None-Match` and treats a 304 as a
 *  definitive "no change" (no body, cursor stays identical).
 *
 *  Non-fatal policy: network errors and non-2xx non-304 responses
 *  return `{should_run: false, status}` rather than throwing. A
 *  watcher polling a flapping URL must not keep tripping the
 *  reactive scheduler's circuit breaker — those are counted from
 *  thrown exceptions, not from no-fire ticks. Configuration errors
 *  (missing/invalid target_url) still throw, since they never
 *  resolve on retry.
 *
 *  Body size is capped at `MAX_BODY_BYTES`; larger responses are
 *  truncated before hashing to bound tick-time memory.
 *
 *  Lives in `@recued/ingredients` (not `backend/server/`) so both the
 *  server's watcher dispatcher and the extension's runtime watcher
 *  dispatcher share one source of truth — D-115 Phase 6D. Hashing
 *  uses the Web Crypto `crypto.subtle.digest` API which is available
 *  in both Node 16+ and MV3 service workers; node:crypto is avoided
 *  so the module loads in browser contexts. */

import { IngredientError } from '../types.js';
import { discardResponseBody } from '../bounded-response-body.js';
import { fetchOriginPinned } from '../origin-pinned-fetch.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface HttpWatcherArgs {
  target_url: string;
  previous_etag?: string;
  previous_hash?: string;
}

export interface HttpWatcherOutput {
  should_run: boolean;
  body: string;
  status: number;
  etag: string | null;
  hash: string | null;
  [field: string]: unknown;
}

export interface HttpWatcherDeps {
  /** Injected fetch for tests. Production defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
  /** Injected timeout. Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

const validate = (args: HttpWatcherArgs): URL => {
  if (typeof args.target_url !== 'string' || args.target_url.length === 0) {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'http-watcher: target_url must be a non-empty string',
      { got: args.target_url },
    );
  }
  let url: URL;
  try {
    url = new URL(args.target_url);
  } catch {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      `http-watcher: target_url must be a valid URL — got ${args.target_url}`,
      { got: args.target_url },
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      `http-watcher: target_url must use http(s) — got ${url.protocol}`,
      { protocol: url.protocol },
    );
  }
  if (args.previous_etag !== undefined && typeof args.previous_etag !== 'string') {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'http-watcher: previous_etag must be a string if provided',
      { got: args.previous_etag },
    );
  }
  if (args.previous_hash !== undefined && typeof args.previous_hash !== 'string') {
    throw new IngredientError(
      'TRANSFORM_INVALID_INPUT',
      'http-watcher: previous_hash must be a string if provided',
      { got: args.previous_hash },
    );
  }
  return url;
};

const toHex = (buf: ArrayBuffer): string =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const hashBody = async (body: string): Promise<string> => {
  const bytes = new TextEncoder().encode(body);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(digest);
};

const concatChunks = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/** Read at most the documented response prefix without first buffering the
 * whole upstream body. The extra read after exactly MAX_BODY_BYTES is
 * intentional: it distinguishes an exact-size response from an oversized one.
 * Once an oversize byte is observed the rest of the stream is cancelled. */
const sliceBody = async (res: Response): Promise<string> => {
  const body = res.body;
  if (body === null) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = MAX_BODY_BYTES - total;
      if (next.value.byteLength > remaining) {
        if (remaining > 0) {
          // `slice`, rather than `subarray`, releases a potentially very large
          // hostile chunk before the bounded prefix is decoded.
          chunks.push(next.value.slice(0, remaining));
          total += remaining;
        }
        // Do not await cancellation: cleanup supplied by an untrusted stream
        // must not turn the size ceiling into another unbounded wait.
        void reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Abort/cancellation already owns the stream lock.
    }
  }
  return new TextDecoder().decode(concatChunks(chunks, total));
};

const noFire = (status: number): HttpWatcherOutput => ({
  should_run: false,
  body: '',
  status,
  etag: null,
  hash: null,
});

export const evaluateHttpWatcher = async (
  args: HttpWatcherArgs,
  deps: HttpWatcherDeps = {},
): Promise<HttpWatcherOutput> => {
  const url = validate(args);

  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let res: Response;
    const headers: Record<string, string> = {};
    if (args.previous_etag) headers['If-None-Match'] = args.previous_etag;
    // SSRF: follow redirects manually, pinned to the watcher's declared
    // target origin. A server-driven 3xx can't pivot the poll off that
    // origin to an internal / metadata host; the declared target
    // (localhost / LAN included) is honored. A cross-origin redirect (or
    // redirect loop) throws and is caught below as a non-fatal no-fire —
    // consistent with this watcher's "don't trip the circuit breaker"
    // policy (fail-safe: the watcher simply doesn't fire).
    res = await fetchOriginPinned(fetchFn, args.target_url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    }, url.origin);

    // 304 — explicit "not modified". Preserve the caller's cursor.
    if (res.status === 304) {
      return {
        should_run: false,
        body: '',
        status: 304,
        etag: args.previous_etag ?? null,
        hash: args.previous_hash ?? null,
      };
    }

    // Non-2xx — non-fatal no-fire so flapping URLs don't trip the
    // scheduler's circuit breaker. Release the unread body so repeated
    // watcher ticks cannot strand provider connections.
    if (res.status < 200 || res.status >= 300) {
      discardResponseBody(res);
      return noFire(res.status);
    }

    const body = await sliceBody(res);
    const etag = res.headers.get('etag');
    const hash = await hashBody(body);

    // First tick (no cursor) ⇒ fire. Recipe author is expected to
    // store `etag` + `hash` in shared.* so subsequent ticks compare.
    const firstTick = !args.previous_etag && !args.previous_hash;
    if (firstTick) {
      return { should_run: true, body, status: res.status, etag, hash };
    }

    // Prefer ETag comparison when both sides provide it.
    if (etag !== null && args.previous_etag !== undefined) {
      return {
        should_run: etag !== args.previous_etag,
        body,
        status: res.status,
        etag,
        hash,
      };
    }

    // Fallback — body hash. Compares against previous_hash when set; if
    // the caller only has previous_etag but the new response lacks one,
    // fall back to hash equality against previous_hash too (may be
    // absent; treat absence as "changed" so the author gets to
    // bootstrap the hash cursor).
    const prevHash = args.previous_hash ?? null;
    return {
      should_run: prevHash === null || prevHash !== hash,
      body,
      status: res.status,
      etag,
      hash,
    };
  } catch {
    // Network error / abort / DNS failure / refused redirect / body-stream
    // failure — non-fatal. Cursor unchanged and the scheduler keeps running.
    return noFire(0);
  } finally {
    // The deadline covers the entire response lifecycle, including the body;
    // clearing it immediately after headers leaves a slow body unbounded.
    clearTimeout(timer);
  }
};
