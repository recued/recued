/** D-160 P0 — the shared timed JSON POST for the Slack / Telegram
 *  transports. Both vendors expose a JSON envelope with an `ok` boolean;
 *  this helper resolves the HTTP layer (timeout / network / status) and
 *  hands the parsed envelope back. Vendor-level `ok: false` is the
 *  per-transport caller's concern, not this helper's.
 *
 *  Spec: docs/d-160-spec.md § A.5.
 */

import type { TransportErrorKind } from './types.js';
import { Buffer } from 'node:buffer';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Default per-request timeout. Overridable per transport. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Head bytes captured from a streamed download for server-side magic-byte
 *  detection (D-172 N.1 — the stored mime is detected, not vendor-reported). */
const DEFAULT_HEAD_CAPTURE_BYTES = 16;

export interface HttpPostOptions {
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

export interface HttpGetBytesOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

/** Discriminated HTTP-layer outcome. `ok: true` carries the parsed JSON
 *  envelope; the per-transport caller inspects the vendor `ok` flag.
 *
 *  D-192 WhatsApp — `http_error` carries the parsed error BODY too, when there is
 *  one. Slack and Telegram never need it: both answer 200 with `{ok:false,…}`, so
 *  a non-2xx from them is a transport fault and the status says everything. Graph
 *  is the opposite — it signals a vendor error with the HTTP STATUS and puts the
 *  only useful information in the body (`{error:{message,type,code}}`). Without
 *  this, a WhatsApp send failure reported "400 Bad Request" and nothing else,
 *  which cannot distinguish a bad token from an invalid number from the one that
 *  actually matters: message sent outside the 24-hour customer-service window.
 *  Optional + additive, so no existing consumer changes. */
export type HttpPostOutcome =
  | { ok: true; status: number; json: unknown }
  | { ok: false; kind: 'timeout' | 'network'; detail: string }
  | { ok: false; kind: 'http_error'; status: number; detail: string; json?: unknown };

export interface HttpGetJsonOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

/** Discriminated HTTP-layer outcome for binary downloads. */
export type HttpBytesOutcome =
  | { ok: true; status: number; bytes: Buffer; contentType?: string }
  | { ok: false; kind: 'timeout' | 'network'; detail: string }
  | { ok: false; kind: 'http_error'; status: number; detail: string };

/** ONE JSON round-trip, method-parameterised. Never throws — every failure mode
 *  resolves as a discriminated `{ ok: false }`.
 *
 *  D-192 Discord — extracted. `postJson` and `getJson` were already near-identical
 *  50-line twins, and Discord needs a third method (PATCH, to strip a delivered
 *  prompt's buttons by editing the message). A third copy of the same abort-timer /
 *  error-body / parse dance would be exactly the hand-spelled-enumeration smell this
 *  arc exists to remove — in the HTTP layer this time. The three exports below are
 *  now thin, and a fourth method is one line.
 *
 *  One abort timer spans the WHOLE round-trip — connect, response, AND the body
 *  read. A stalled body stream must resolve as `timeout`, so the timer is cleared
 *  only once the JSON parse is done (`finally`). */
const requestJson = async (
  url: string,
  opts: {
    method: 'GET' | 'POST' | 'PATCH';
    headers?: Record<string, string>;
    body?: string;
    timeoutMs: number;
    fetchImpl: typeof fetch;
  },
): Promise<HttpPostOutcome> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let response: Response;
    try {
      response = await opts.fetchImpl(url, {
        method: opts.method,
        ...(opts.headers ? { headers: opts.headers } : {}),
        ...(opts.body !== undefined ? { body: opts.body } : {}),
        signal: controller.signal,
      });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err?.name === 'AbortError') {
        return {
          ok: false,
          kind: 'timeout',
          detail: `request timed out after ${opts.timeoutMs}ms`,
        };
      }
      return { ok: false, kind: 'network', detail: err?.message ?? 'network error' };
    }

    if (!response.ok) {
      // Best-effort read of the error body — a vendor that reports faults by HTTP
      // status (Graph, Discord) puts the only actionable detail there. A body that
      // is absent, non-JSON, or unreadable leaves `json` undefined and the outcome
      // is exactly what it was before: the status and nothing more.
      let errJson: unknown;
      try {
        errJson = await response.json();
      } catch {
        errJson = undefined;
      }
      return {
        ok: false,
        kind: 'http_error',
        status: response.status,
        detail: `${response.status} ${response.statusText}`.trim(),
        ...(errJson !== undefined ? { json: errJson } : {}),
      };
    }

    // ⚠ `response.json()`, deliberately — NOT a `.text()` + `JSON.parse` with an
    // empty-body fallback, which is what this briefly was. That version was written
    // to tolerate a 204, tolerated far more than it meant to, and broke a live path:
    // it swallowed ANY failure of the body read into `{ ok: true, json: null }`, so a
    // caller reading a field off the envelope got `null` and NO error — the Slack
    // profile-email writer quietly stopped linking senders. A silent null in the one
    // shared HTTP helper, introduced during an arc about silent nulls. It bought
    // nothing either: no endpoint any transport calls returns a 204 (Discord's message
    // edit answers 200 with the message). Tolerate less; fail louder.
    let json: unknown;
    try {
      json = await response.json();
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err?.name === 'AbortError') {
        return {
          ok: false,
          kind: 'timeout',
          detail: `response body read timed out after ${opts.timeoutMs}ms`,
        };
      }
      return {
        ok: false,
        kind: 'network',
        detail: `malformed JSON response: ${err?.message ?? 'parse error'}`,
      };
    }
    return { ok: true, status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
};

/** POST a JSON body. */
export const postJson = (
  url: string,
  opts: HttpPostOptions,
): Promise<HttpPostOutcome> =>
  requestJson(url, {
    method: 'POST',
    headers: opts.headers,
    body: opts.body,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });

/** GET a JSON body — the read-side twin. Added for WhatsApp's two-step media fetch
 *  (resolve a media id to a short-lived bearer-authenticated URL, then stream it);
 *  Slack resolves media through `files.info` and Telegram through `getFile`, both
 *  of which are POSTs. */
export const getJson = (
  url: string,
  opts: HttpGetJsonOptions,
): Promise<HttpPostOutcome> =>
  requestJson(url, {
    method: 'GET',
    ...(opts.headers ? { headers: opts.headers } : {}),
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });

/** PATCH a JSON body. D-192 Discord — editing a sent message is how a prompt's
 *  buttons are stripped once the question is answered (`closePrompt`). Slack does
 *  the same thing through a POST (`chat.update`); Discord is REST-shaped and wants
 *  the verb. */
export const patchJson = (
  url: string,
  opts: HttpPostOptions,
): Promise<HttpPostOutcome> =>
  requestJson(url, {
    method: 'PATCH',
    headers: opts.headers,
    body: opts.body,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });

/** GET bytes with an abort-backed timeout. Never throws — every failure
 *  mode resolves as a discriminated `{ ok: false }`. */
export const getBytes = async (
  url: string,
  opts: HttpGetBytesOptions,
): Promise<HttpBytesOutcome> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let response: Response;
    try {
      response = await opts.fetchImpl(url, {
        method: 'GET',
        headers: opts.headers ?? {},
        signal: controller.signal,
      });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err?.name === 'AbortError') {
        return {
          ok: false,
          kind: 'timeout',
          detail: `request timed out after ${opts.timeoutMs}ms`,
        };
      }
      return { ok: false, kind: 'network', detail: err?.message ?? 'network error' };
    }

    if (!response.ok) {
      return {
        ok: false,
        kind: 'http_error',
        status: response.status,
        detail: `${response.status} ${response.statusText}`.trim(),
      };
    }

    try {
      const arrayBuffer = await response.arrayBuffer();
      const contentType = response.headers.get('content-type') ?? undefined;
      return {
        ok: true,
        status: response.status,
        bytes: Buffer.from(arrayBuffer),
        ...(contentType !== undefined ? { contentType } : {}),
      };
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err?.name === 'AbortError') {
        return {
          ok: false,
          kind: 'timeout',
          detail: `response body read timed out after ${opts.timeoutMs}ms`,
        };
      }
      return {
        ok: false,
        kind: 'network',
        detail: `malformed bytes response: ${err?.message ?? 'read error'}`,
      };
    }
  } finally {
    clearTimeout(timer);
  }
};

export interface HttpDownloadOptions {
  headers?: Record<string, string>;
  /** Destination temp path the body is streamed into. The CALLER owns this
   *  file's lifecycle (delete after consuming). On any failure this helper
   *  unlinks the partial dest itself. */
  destPath: string;
  /** IDLE timeout — aborts only when no chunk arrives for this long, so a
   *  large-but-progressing download is never killed mid-stream (the D-172
   *  cap-less ingest model: file size is bounded by the channel/vendor limit
   *  + the user's disk, not a Recued ceiling). A stalled stream still aborts. */
  idleTimeoutMs: number;
  fetchImpl: typeof fetch;
  /** Bytes captured from the head for downstream magic-byte detection. */
  headCaptureBytes?: number;
}

/** Discriminated outcome for a streamed-to-disk download. */
export type HttpDownloadOutcome =
  | { ok: true; status: number; size: number; headBytes: Buffer; contentType?: string }
  | { ok: false; kind: 'timeout' | 'network'; detail: string }
  | { ok: false; kind: 'http_error'; status: number; detail: string };

/** GET a body and STREAM it to `destPath` — never buffers the whole body in
 *  memory (peak = one chunk). The inbound-media counterpart to `getBytes` for
 *  potentially-large untrusted downloads: the consumer hands the resulting
 *  temp path to `BlobStore.putFile` (also streaming), so a multi-hundred-MB
 *  file never lands fully in RAM. Captures the first `headCaptureBytes` for
 *  server-side magic-byte detection. Never throws — every failure resolves as
 *  a discriminated `{ ok: false }` and the partial dest is unlinked. */
export const downloadToFile = async (
  url: string,
  opts: HttpDownloadOptions,
): Promise<HttpDownloadOutcome> => {
  const headCap = opts.headCaptureBytes ?? DEFAULT_HEAD_CAPTURE_BYTES;
  const controller = new AbortController();
  // IDLE timer — reset on every chunk so only a STALL (no progress for
  // idleTimeoutMs) aborts, never a slow-but-moving large transfer.
  let timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), opts.idleTimeoutMs);
  const resetIdle = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), opts.idleTimeoutMs);
  };
  const cleanupPartial = async (): Promise<void> => {
    await unlink(opts.destPath).catch(() => {});
  };
  try {
    let response: Response;
    try {
      response = await opts.fetchImpl(url, {
        method: 'GET',
        headers: opts.headers ?? {},
        signal: controller.signal,
      });
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err?.name === 'AbortError') {
        return { ok: false, kind: 'timeout', detail: `request timed out after ${opts.idleTimeoutMs}ms idle` };
      }
      return { ok: false, kind: 'network', detail: err?.message ?? 'network error' };
    }

    if (!response.ok) {
      return {
        ok: false,
        kind: 'http_error',
        status: response.status,
        detail: `${response.status} ${response.statusText}`.trim(),
      };
    }

    const contentType = response.headers.get('content-type') ?? undefined;
    await mkdir(dirname(opts.destPath), { recursive: true });

    let size = 0;
    const headChunks: Buffer[] = [];
    let headLen = 0;
    // Tap the body as it flows — reset the idle timer + count size + capture the
    // head — then let `pipeline` own backpressure, error PROPAGATION, and stream
    // teardown. A manual write loop leaks an unhandled writable 'error' when a
    // write fails OUTSIDE a drain wait (e.g. ENOSPC on the cap-less large-media
    // path), which would crash the process instead of resolving `{ ok: false }`.
    const tap = async function* (
      src: AsyncIterable<Buffer>,
    ): AsyncGenerator<Buffer> {
      for await (const chunk of src) {
        resetIdle();
        const buf = chunk as Buffer;
        size += buf.length;
        if (headLen < headCap) {
          const slice = buf.subarray(0, headCap - headLen);
          headChunks.push(slice);
          headLen += slice.length;
        }
        yield buf;
      }
    };
    try {
      const body = response.body
        ? Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
        : Readable.from([]);
      await pipeline(body, tap, createWriteStream(opts.destPath));
    } catch (e) {
      await cleanupPartial();
      // An idle-timeout fires via the AbortController → the body stream errors;
      // `signal.aborted` distinguishes that from a write / network failure
      // (ENOSPC, EIO) — both now resolve cleanly instead of crashing.
      if (controller.signal.aborted) {
        return { ok: false, kind: 'timeout', detail: `download stalled (no data for ${opts.idleTimeoutMs}ms)` };
      }
      const err = e as { message?: string };
      return { ok: false, kind: 'network', detail: `download read failed: ${err?.message ?? 'read error'}` };
    }

    return {
      ok: true,
      status: response.status,
      size,
      headBytes: Buffer.concat(headChunks),
      ...(contentType !== undefined ? { contentType } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
};

/** Map an HTTP error status onto a `TransportErrorKind`. 401/403 →
 *  `auth`; 429 → `rate_limited`; 5xx → `server_error`; anything else →
 *  `network`. */
export const classifyHttpError = (status: number): TransportErrorKind => {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'network';
};
