/** Phase D (D-106) — webhook HTTP listener.
 *
 *  Backs `POST /webhook/{slug}`. Registered on the main server only
 *  when `public_reachable=true` AND `webhook_port>0` per the spec
 *  §webhook gate — the cloud never relays inbound webhooks (D-096),
 *  so self-hosters must bring their own public address or tunnel.
 *
 *  Per request:
 *    1. Public-reachable gate → 503 WEBHOOK_UNAVAILABLE if disabled.
 *    2. Lookup `(platform='webhook', slug)` in the registry → 404.
 *    3. Typeguard that the registered Collection is a WebhookCollection
 *       (defensive — only the factory produces one).
 *    4. Rate-limit bucket per endpoint slug → 429.
 *    5. Read body with a hard cap → 413.
 *    6. Delegate to `collection.ingest` which handles content-type,
 *       HMAC, IP allowlist, persistence.
 *    7. Respond 202 with `{ delivery_id }` or the translated error.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CollectionRegistry } from '../registry.js';
import type { Collection } from '../types.js';
import type { WebhookCollection } from './webhook-collection.js';

/** Quick typeguard so consumers don't need the narrow interface. */
export const isWebhookCollection = (c: Collection): c is WebhookCollection =>
  typeof (c as WebhookCollection).ingest === 'function'
  && typeof (c as WebhookCollection).accepting === 'function';

export interface WebhookListenerOptions {
  registry: CollectionRegistry;
  /** Live `public_reachable` flag. Read on each request so operators
   *  can flip it via `server.setConfigField` without restart. */
  publicReachable: () => boolean;
  /** D-188 — master "Pause server" flag. When it returns true, this
   *  inbound webhook listener is CLOSED: every request is rejected
   *  (503 SERVER_PAUSED) without dispatching, until the owner resumes.
   *  Read per-request (like `publicReachable`) so resume is instant.
   *  Absent ⇒ never paused (test / minimal compositions). */
  isPaused?: () => boolean;
  /** Resolve an HMAC secret for `(slug, vault_key)`. The listener
   *  hands the resolved secret to `ingest`. Absent → HMAC disabled
   *  globally; collections that configured `hmac_header` will fail
   *  closed with `auth_failed`. */
  getHmacSecret?: (slug: string, vaultKey: string) => string | null;
  /** Global ceiling on inbound body bytes. `CollectionConfig.max_body_bytes`
   *  can be lower per endpoint; the listener applies the tighter of
   *  the two. Defaults to 1 MB. */
  maxBodyBytes?: number;
  /** Time source for the rate-limit token buckets. */
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

/** The request handler the HTTP server dispatches to for
 *  `/webhook/{slug}` paths. */
export type WebhookRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
) => Promise<void>;

const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;
const DEFAULT_RATE_PER_SEC = 100;
const DEFAULT_RATE_BURST = 10;

// ────────────────────────────────────────────────────────────────
// Token bucket — one per endpoint.
// ────────────────────────────────────────────────────────────────

interface Bucket {
  capacity: number;
  refillPerSec: number;
  tokens: number;
  lastRefill: number;
}

const makeBucket = (capacity: number, refillPerSec: number, now: number): Bucket => ({
  capacity, refillPerSec, tokens: capacity, lastRefill: now,
});

const takeToken = (bucket: Bucket, now: number): boolean => {
  const elapsedS = Math.max(0, (now - bucket.lastRefill) / 1000);
  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + elapsedS * bucket.refillPerSec,
  );
  bucket.lastRefill = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
};

// ────────────────────────────────────────────────────────────────
// Body reader
// ────────────────────────────────────────────────────────────────

const readBodyWithCap = async (
  req: IncomingMessage,
  cap: number,
): Promise<{ ok: true; body: Buffer } | { ok: false; reason: 'too_large' | 'stream_error' }> => {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    let settled = false;
    const done = (r: { ok: true; body: Buffer } | { ok: false; reason: 'too_large' | 'stream_error' }): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        // Stop accumulating but keep draining so the client can
        // receive the 413 response cleanly (destroying the socket
        // mid-upload leaves the response un-delivered).
        overLimit = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overLimit) done({ ok: false, reason: 'too_large' });
      else done({ ok: true, body: Buffer.concat(chunks) });
    });
    req.on('error', () => done({ ok: false, reason: 'stream_error' }));
    req.on('close', () => done({ ok: false, reason: 'stream_error' }));
  });
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const trimContentType = (raw: string | undefined): string | null => {
  if (!raw) return null;
  const idx = raw.indexOf(';');
  return (idx === -1 ? raw : raw.slice(0, idx)).trim().toLowerCase();
};

const pickHeadersSubset = (req: IncomingMessage): Record<string, string> => {
  // Keep a small set of commonly-useful headers — the full header
  // object balloons record size + leaks cookies / internal hops.
  const keep = [
    'user-agent',
    'x-forwarded-for',
    'x-request-id',
    'x-github-event',
    'x-github-delivery',
    'x-hub-signature-256',
    'x-slack-signature',
    'x-slack-request-timestamp',
    'stripe-signature',
    'x-recued-event',
  ];
  const out: Record<string, string> = {};
  for (const name of keep) {
    const val = req.headers[name];
    if (typeof val === 'string') out[name] = val;
  }
  return out;
};

const parseQuery = (url: string): Record<string, string> => {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const out: Record<string, string> = {};
  for (const pair of url.slice(idx + 1).split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    if (!k) continue;
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
};

const writeJsonResponse = (
  res: ServerResponse,
  status: number,
  body: unknown,
): void => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

export const createWebhookListener = (
  opts: WebhookListenerOptions,
): WebhookRequestHandler => {
  const nowOf = (): number => opts.now?.() ?? Date.now();
  const globalMaxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const buckets = new Map<string, Bucket>();

  return async (req, res, slug): Promise<void> => {
    // D-188 — a paused server closes inbound intake (the "stop the spam"
    // case). Checked first so a paused server reads as paused, not the
    // generic "unavailable". Contract-free intake bypasses the op gate, so
    // this listener-level close is how pause reaches webhooks.
    if (opts.isPaused?.()) {
      writeJsonResponse(res, 503, {
        ok: false,
        error: {
          code: 'SERVER_PAUSED',
          message: 'server is paused — inbound webhooks are closed until the owner resumes',
        },
      });
      return;
    }
    if (!opts.publicReachable()) {
      writeJsonResponse(res, 503, {
        ok: false,
        error: {
          code: 'WEBHOOK_UNAVAILABLE',
          message: 'webhook listener requires public_reachable=true + webhook_port>0 (D-096: no cloud relay)',
        },
      });
      return;
    }

    const collection = opts.registry.get('webhook', slug);
    if (!collection || !isWebhookCollection(collection)) {
      writeJsonResponse(res, 404, {
        ok: false,
        error: {
          code: 'COLLECTION_NOT_FOUND',
          message: `no webhook collection registered for slug '${slug}'`,
        },
      });
      return;
    }
    if (!collection.accepting()) {
      writeJsonResponse(res, 503, {
        ok: false,
        error: { code: 'not_accepting', message: 'webhook is draining or not yet started' },
      });
      return;
    }

    // Rate limit — read bucket config from the collection's own
    // config() so per-endpoint overrides (config.rate_limit_*) take
    // effect without restart.
    const liveCfg = collection.config();
    const rps = liveCfg.rate_limit_per_second ?? DEFAULT_RATE_PER_SEC;
    const burst = liveCfg.rate_limit_burst ?? DEFAULT_RATE_BURST;
    let bucket = buckets.get(slug);
    if (!bucket || bucket.capacity !== burst || bucket.refillPerSec !== rps) {
      bucket = makeBucket(burst, rps, nowOf());
      buckets.set(slug, bucket);
    }
    if (!takeToken(bucket, nowOf())) {
      writeJsonResponse(res, 429, {
        ok: false,
        error: { code: 'rate_limited', message: 'too many requests — try again shortly' },
      });
      return;
    }

    // Body cap — min of listener ceiling + collection-specific cap.
    const collectionCap = liveCfg.max_body_bytes ?? globalMaxBody;
    const cap = Math.min(globalMaxBody, collectionCap);
    const bodyRead = await readBodyWithCap(req, cap);
    if (!bodyRead.ok) {
      if (bodyRead.reason === 'too_large') {
        writeJsonResponse(res, 413, {
          ok: false,
          error: { code: 'payload_too_large', message: `body exceeds ${cap} bytes` },
        });
        return;
      }
      writeJsonResponse(res, 400, {
        ok: false,
        error: { code: 'stream_error', message: 'request body could not be read' },
      });
      return;
    }

    const hmacHeaderName = liveCfg.hmac_header;
    const hmacVaultKey = liveCfg.hmac_secret_vault_key;
    const hmacHeader = hmacHeaderName
      ? (req.headers[hmacHeaderName.toLowerCase()] as string | undefined) ?? null
      : null;
    const hmacSecret = hmacHeaderName && hmacVaultKey && opts.getHmacSecret
      ? opts.getHmacSecret(slug, hmacVaultKey)
      : null;

    const remoteIp = req.socket.remoteAddress ?? null;
    const url = req.url ?? `/webhook/${slug}`;

    const result = await collection.ingest({
      method: req.method ?? 'POST',
      body: bodyRead.body,
      contentType: trimContentType(req.headers['content-type'] as string | undefined),
      headersSubset: pickHeadersSubset(req),
      query: parseQuery(url),
      remoteIp,
      hmacHeader,
      hmacSecret,
    });

    if (!result.ok) {
      writeJsonResponse(res, result.status, {
        ok: false,
        error: { code: result.code, message: result.message },
      });
      return;
    }

    writeJsonResponse(res, 202, { ok: true, delivery_id: result.delivery_id });
  };
};

