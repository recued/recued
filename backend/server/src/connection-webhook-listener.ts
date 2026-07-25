/** D-128 Phase 3 — `/v1/connection/webhook/<vendor>/<connection_name>`
 *  HTTP receiver.
 *
 *  Reads the request body up to a hard cap, parses JSON, normalises
 *  headers, then hands off to the webhook funnel
 *  (`housekeeping/reconciliation/webhook-funnel.ts`). The funnel does
 *  the HMAC verification, dedup, and synthetic-event dispatch — this
 *  module is the thin HTTP plumbing.
 *
 *  Per D-097 / D-127, vendor webhook ingestion is **self-host only**.
 *  The cloud relay never forwards inbound webhooks. Self-hosters bring
 *  their own public-reachable address (or run a tunnel). Operators
 *  enable the receiver at all by passing this listener through
 *  `ServerConfig.connectionWebhookListener`; absent → POSTs return
 *  404 like any unknown route. */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { WebhookFunnelHandler } from './housekeeping/reconciliation/webhook-funnel.js';

export interface ConnectionWebhookListenerOptions {
  funnel: WebhookFunnelHandler;
  /** Public-reachable gate. Wired the same way the Phase D webhook
   *  listener gates: operators flip `public_reachable` via
   *  `server.setConfigField` and the change takes effect on next
   *  request without a restart. */
  publicReachable: () => boolean;
  /** D-188 — master "Pause server" flag. When true, this connection
   *  webhook receiver is CLOSED: requests are rejected (503 SERVER_PAUSED)
   *  without funnelling, until the owner resumes. Read per-request (like
   *  `publicReachable`). Absent ⇒ never paused. */
  isPaused?: () => boolean;
  /** Body cap. Vendor webhooks are typically small (< 32 KB); the
   *  default 1 MB matches the Phase D webhook listener so a single
   *  ceiling carries across both inbound surfaces. */
  maxBodyBytes?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: unknown) => void;
}

export type ConnectionWebhookRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  vendor: string,
  connection_name: string,
) => Promise<void>;

const DEFAULT_MAX_BODY_BYTES = 1 * 1024 * 1024;

const writeJsonResponse = (
  res: ServerResponse,
  status: number,
  body: unknown,
): void => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

const readBodyWithCap = async (
  req: IncomingMessage,
  cap: number,
): Promise<{ ok: true; body: Buffer } | { ok: false; reason: 'too_large' | 'stream_error' }> => {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overLimit = false;
    let settled = false;
    const done = (
      r: { ok: true; body: Buffer } | { ok: false; reason: 'too_large' | 'stream_error' },
    ): void => {
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

const normaliseHeaders = (req: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
    else if (Array.isArray(v) && v.length > 0) out[k.toLowerCase()] = v[0]!;
  }
  return out;
};

const isJsonContentType = (raw: string | undefined): boolean => {
  if (!raw) return false;
  const idx = raw.indexOf(';');
  const trimmed = (idx === -1 ? raw : raw.slice(0, idx)).trim().toLowerCase();
  return trimmed === 'application/json' || trimmed.endsWith('+json');
};

export const createConnectionWebhookListener = (
  opts: ConnectionWebhookListenerOptions,
): ConnectionWebhookRequestHandler => {
  const cap = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (req, res, vendor, connection_name) => {
    // D-188 — a paused server closes inbound intake. Checked first.
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
          message:
            'connection webhook receiver requires public_reachable=true (D-097: no cloud relay for inbound webhooks)',
        },
      });
      return;
    }

    if (req.method !== 'POST') {
      writeJsonResponse(res, 405, {
        ok: false,
        error: { code: 'method_not_allowed', message: 'POST only' },
      });
      return;
    }

    const headers = normaliseHeaders(req);
    if (!isJsonContentType(headers['content-type'])) {
      writeJsonResponse(res, 415, {
        ok: false,
        error: {
          code: 'unsupported_media_type',
          message: 'connection webhook receiver only accepts application/json',
        },
      });
      return;
    }

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

    let payload: unknown;
    try {
      payload = JSON.parse(bodyRead.body.toString('utf-8') || 'null');
    } catch (e) {
      writeJsonResponse(res, 400, {
        ok: false,
        error: {
          code: 'invalid_json',
          message: e instanceof Error ? e.message : 'invalid JSON body',
        },
      });
      return;
    }

    const result = await opts.funnel({
      vendor,
      connection_name,
      payload,
      headers,
      rawBody: bodyRead.body,
    });

    if (!result.ok) {
      writeJsonResponse(res, result.status, {
        ok: false,
        error: { code: result.code, message: result.message },
      });
      opts.log?.('warn', 'connection webhook rejected', {
        vendor,
        connection_name,
        code: result.code,
      });
      return;
    }

    writeJsonResponse(res, result.status, {
      ok: true,
      processed: result.processed,
      deduped: result.deduped,
      failed: result.failed,
    });
  };
};
