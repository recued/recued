/** D-115 Phase 6C — `/hook/{recipe_id}/{slug}` inbound HTTP listener.
 *
 *  Enqueues inbound POST bodies onto a WebhookWatcherQueue keyed
 *  by `(recipe_id, slug)`. Differs from the `/webhook/{slug}`
 *  listener (Phase D) in three ways:
 *
 *    1. No warehouse persistence — payloads live in RAM until
 *       the reactive recipe's next tick drains them.
 *    2. No HMAC / IP-allowlist — author validates inside the
 *       recipe via transforms against captured headers + body.
 *       Security comes from the recipe_id acting as a shared
 *       secret in the URL.
 *    3. Path carries the recipe_id so a single server can host
 *       many independent reactive recipes without routing
 *       collisions.
 *
 *  D-096 gate unchanged: `public_reachable=true` + `webhook_port>0`.
 *  Cloud never relays inbound webhooks. */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { WebhookWatcherQueue, WebhookWatcherRequest } from './webhook-watcher.js';

export const DEFAULT_HOOK_MAX_BODY_BYTES = 1 * 1024 * 1024;

export interface HookListenerOptions {
  queue: WebhookWatcherQueue;
  /** Live `public_reachable` flag. Read on each request so
   *  operators can flip it without a restart. */
  publicReachable: () => boolean;
  /** D-188 — master "Pause server" flag. When true, this `/hook` listener
   *  is CLOSED: requests are rejected (503 SERVER_PAUSED) without enqueuing,
   *  until the owner resumes. Read per-request (like `publicReachable`).
   *  Absent ⇒ never paused. */
  isPaused?: () => boolean;
  /** Global body-byte cap. Defaults to 1 MB (matches
   *  `/webhook/{slug}` listener). */
  maxBodyBytes?: number;
  /** Deterministic time + id injection for tests. */
  now?: () => number;
  deliveryId?: () => string;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

/** `(req, res, recipe_id, slug)` — invoked by the server HTTP
 *  router after parsing the `/hook/{recipe_id}/{slug}` path. */
export type HookRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  recipe_id: string,
  slug: string,
) => Promise<void>;

// ────────────────────────────────────────────────────────────────
// Header capture — narrow subset, always strip auth / cookies
// ────────────────────────────────────────────────────────────────

const SENSITIVE_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
]);

const CAPTURED_HEADERS: ReadonlyArray<string> = [
  'content-type',
  'content-length',
  'accept',
  'user-agent',
  'x-forwarded-for',
  'x-real-ip',
  'x-request-id',
  'x-github-event',
  'x-github-delivery',
  'x-hub-signature',
  'x-hub-signature-256',
  'x-gitlab-event',
  'x-gitlab-token',
  'x-slack-signature',
  'x-slack-request-timestamp',
  'stripe-signature',
  'x-recued-event',
  'x-webhook-event',
];

const pickHeaders = (req: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const name of CAPTURED_HEADERS) {
    if (SENSITIVE_HEADERS.has(name)) continue;
    const raw = req.headers[name];
    if (typeof raw === 'string') out[name] = raw;
    else if (Array.isArray(raw) && raw.length > 0) out[name] = raw.join(', ');
  }
  return out;
};

const pickSourceIp = (req: IncomingMessage): string | null => {
  // Prefer the raw socket address; the recipe author can use
  // `x-forwarded-for` from the captured headers if they've put a
  // trusted proxy in front.
  const addr = req.socket?.remoteAddress;
  return typeof addr === 'string' && addr.length > 0 ? addr : null;
};

// ────────────────────────────────────────────────────────────────
// Body reader — capped
// ────────────────────────────────────────────────────────────────

type ReadResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: 'too_large' | 'stream_error' };

const readBodyWithCap = async (
  req: IncomingMessage,
  cap: number,
): Promise<ReadResult> => {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    let settled = false;
    const done = (r: ReadResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
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

const writeJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

export const createHookListener = (
  opts: HookListenerOptions,
): HookRequestHandler => {
  const maxBody = opts.maxBodyBytes ?? DEFAULT_HOOK_MAX_BODY_BYTES;
  const now = opts.now ?? Date.now;
  const newDeliveryId = opts.deliveryId ?? (() => randomUUID());
  const log = opts.log ?? (() => {});

  return async (req, res, recipe_id, slug) => {
    // D-188 — a paused server closes inbound intake. Checked first.
    if (opts.isPaused?.()) {
      writeJson(res, 503, {
        ok: false,
        error: {
          code: 'SERVER_PAUSED',
          message: 'server is paused — inbound hooks are closed until the owner resumes',
        },
      });
      return;
    }
    if (!opts.publicReachable()) {
      writeJson(res, 503, {
        ok: false,
        error: {
          code: 'WEBHOOK_UNAVAILABLE',
          message:
            '/hook listener requires public_reachable=true + webhook_port>0 (D-096: no cloud relay)',
        },
      });
      return;
    }

    const read = await readBodyWithCap(req, maxBody);
    if (!read.ok) {
      if (read.reason === 'too_large') {
        writeJson(res, 413, {
          ok: false,
          error: {
            code: 'payload_too_large',
            message: `inbound body exceeds ${maxBody} bytes`,
          },
        });
        return;
      }
      writeJson(res, 400, {
        ok: false,
        error: { code: 'stream_error', message: 'request body could not be read' },
      });
      return;
    }

    const delivery_id = newDeliveryId();
    const request: WebhookWatcherRequest = {
      delivery_id,
      received_at: now(),
      method: req.method ?? 'POST',
      headers: pickHeaders(req),
      body: read.body.toString('utf8'),
      source_ip: pickSourceIp(req),
    };

    try {
      opts.queue.enqueue(recipe_id, slug, request);
    } catch (e) {
      log('error', '/hook enqueue failed', {
        recipe_id,
        slug,
        error: e instanceof Error ? e.message : String(e),
      });
      writeJson(res, 500, {
        ok: false,
        error: { code: 'queue_error', message: 'could not enqueue request' },
      });
      return;
    }

    writeJson(res, 202, { ok: true, delivery_id });
  };
};
