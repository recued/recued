/** D-148 P6 — webhook port handler: vendor-agnostic 404 + HMAC + replay dedup. */

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { createIdempotencyLedger } from '../ports/webhook/idempotency-ledger.js';
import {
  createWebhookPortHandler,
  type WebhookVendorDescriptor,
} from '../ports/webhook/handler.js';

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body: string | null = null;
  setHeader(key: string, value: string): void { this.headers[key.toLowerCase()] = value; }
  getHeader(key: string): string | undefined { return this.headers[key.toLowerCase()]; }
  end(body?: string): void { this.body = body ?? ''; }
}

interface BuildReqOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const buildReq = ({ url, method = 'POST', headers = {}, body = '' }: BuildReqOptions): IncomingMessage => {
  const stream = Readable.from([Buffer.from(body, 'utf-8')]) as unknown as IncomingMessage;
  (stream as unknown as { url: string }).url = url;
  (stream as unknown as { method: string }).method = method;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  return stream;
};

const json = (res: FakeRes): unknown => JSON.parse(res.body ?? 'null');

const buildHubspotDescriptor = (
  secret: string,
  dispatchedRef: { calls: number },
): WebhookVendorDescriptor => ({
  path_prefix: '/v1/connection/webhook/hubspot/',
  extractEventId: (_req, body) => {
    try {
      const parsed = JSON.parse(body.toString('utf-8'));
      if (Array.isArray(parsed) && parsed[0]?.eventId !== undefined) {
        return String(parsed[0].eventId);
      }
      return null;
    } catch {
      return null;
    }
  },
  verifySignature: (req, body, sec) => {
    const sig = req.headers['x-hubspot-signature-v3'];
    if (typeof sig !== 'string') return false;
    const expected = createHmac('sha256', sec).update(body).digest('hex');
    return sig === expected;
  },
  resolveSecret: (name) => (name === 'main' ? secret : null),
  dispatch: async () => {
    dispatchedRef.calls += 1;
    return { ok: true };
  },
});

describe('createWebhookPortHandler', () => {
  it('shares concurrent admission and records replay success only after durable dispatch', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let attempts = 0; let succeeds = false;
    const descriptor = buildHubspotDescriptor('secret', { calls: 0 });
    descriptor.dispatch = async () => { attempts += 1; await gate; return { ok: succeeds }; };
    const handler = createWebhookPortHandler({ vendors: { hubspot: descriptor }, ledger: createIdempotencyLedger() });
    const body = JSON.stringify([{ eventId: 'same-native-message' }]);
    const request = () => buildReq({ url: '/v1/connection/webhook/hubspot/main', body,
      headers: { 'x-hubspot-signature-v3': createHmac('sha256', 'secret').update(body).digest('hex') } });
    const a = new FakeRes(); const b = new FakeRes();
    const pending = [handler(request(), a as unknown as ServerResponse), handler(request(), b as unknown as ServerResponse)];
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(attempts).toBe(1); expect(a.body).toBeNull(); expect(b.body).toBeNull();
    release(); await Promise.all(pending); expect([a.statusCode, b.statusCode]).toEqual([502, 502]);
    succeeds = true;
    const c = new FakeRes(); await handler(request(), c as unknown as ServerResponse);
    expect(c.statusCode).toBe(200); expect(attempts).toBe(2);
    const d = new FakeRes(); await handler(request(), d as unknown as ServerResponse);
    expect(json(d)).toEqual({ ok: true, deduped: true }); expect(attempts).toBe(2);
  });

  it('vendor-agnostic 404 on unknown path (no body fingerprint)', async () => {
    const dispatched = { calls: 0 };
    const handler = createWebhookPortHandler({
      vendors: { hubspot: buildHubspotDescriptor('secret', dispatched) },
      ledger: createIdempotencyLedger(),
    });
    const res = new FakeRes();
    await handler(
      buildReq({ url: '/v1/connection/webhook/unknown-vendor/main', body: '{}' }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
    // Body must NOT include the configured-vendor list — the canonical
    // shape for the not_found response is empty of vendor signals.
    const errBody = json(res);
    expect(JSON.stringify(errBody)).not.toContain('hubspot');
  });

  it('returns the same 404 shape regardless of which path probed', async () => {
    const dispatched = { calls: 0 };
    const handler = createWebhookPortHandler({
      vendors: { hubspot: buildHubspotDescriptor('secret', dispatched) },
      ledger: createIdempotencyLedger(),
    });
    const a = new FakeRes();
    await handler(buildReq({ url: '/random' }), a as unknown as ServerResponse);
    const b = new FakeRes();
    await handler(
      buildReq({ url: '/v1/connection/webhook/salesforce/main' }),
      b as unknown as ServerResponse,
    );
    expect(a.body).toBe(b.body);
  });

  it('non-POST returns 404 (no method-allowed leak)', async () => {
    const dispatched = { calls: 0 };
    const handler = createWebhookPortHandler({
      vendors: { hubspot: buildHubspotDescriptor('secret', dispatched) },
      ledger: createIdempotencyLedger(),
    });
    const res = new FakeRes();
    await handler(
      buildReq({ url: '/v1/connection/webhook/hubspot/main', method: 'GET' }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
  });

  it('rejects a request with a tampered body (signature mismatch)', async () => {
    const dispatched = { calls: 0 };
    const handler = createWebhookPortHandler({
      vendors: { hubspot: buildHubspotDescriptor('secret', dispatched) },
      ledger: createIdempotencyLedger(),
    });
    const goodBody = JSON.stringify([{ eventId: 'evt-1', payload: 1 }]);
    const goodSig = createHmac('sha256', 'secret').update(goodBody).digest('hex');
    // Tamper: send a different body, but keep the original signature.
    const tamperedBody = JSON.stringify([{ eventId: 'evt-1', payload: 99 }]);
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/v1/connection/webhook/hubspot/main',
        body: tamperedBody,
        headers: { 'x-hubspot-signature-v3': goodSig },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
    expect((json(res) as { error: { code: string } }).error.code).toBe('signature_invalid');
    expect(dispatched.calls).toBe(0);
  });

  it('accepts a well-signed request and dispatches it once', async () => {
    const dispatched = { calls: 0 };
    const handler = createWebhookPortHandler({
      vendors: { hubspot: buildHubspotDescriptor('secret', dispatched) },
      ledger: createIdempotencyLedger(),
    });
    const body = JSON.stringify([{ eventId: 'evt-1' }]);
    const sig = createHmac('sha256', 'secret').update(body).digest('hex');
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/v1/connection/webhook/hubspot/main',
        body,
        headers: { 'x-hubspot-signature-v3': sig },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(dispatched.calls).toBe(1);
  });

  it('dedup-replay returns 200 deduped:true on second delivery, no second dispatch', async () => {
    let t = 0;
    const dispatched = { calls: 0 };
    const ledger = createIdempotencyLedger({ now: () => t });
    const handler = createWebhookPortHandler({
      vendors: { hubspot: buildHubspotDescriptor('secret', dispatched) },
      ledger,
    });
    const body = JSON.stringify([{ eventId: 'evt-1' }]);
    const sig = createHmac('sha256', 'secret').update(body).digest('hex');
    const r1 = new FakeRes();
    await handler(
      buildReq({
        url: '/v1/connection/webhook/hubspot/main',
        body,
        headers: { 'x-hubspot-signature-v3': sig },
      }),
      r1 as unknown as ServerResponse,
    );
    expect(r1.statusCode).toBe(200);
    const r2 = new FakeRes();
    await handler(
      buildReq({
        url: '/v1/connection/webhook/hubspot/main',
        body,
        headers: { 'x-hubspot-signature-v3': sig },
      }),
      r2 as unknown as ServerResponse,
    );
    expect(r2.statusCode).toBe(200);
    expect((json(r2) as { deduped: boolean }).deduped).toBe(true);
    expect(dispatched.calls).toBe(1);
  });

  it('returns 404 when the (vendor, connection) tuple is unknown', async () => {
    const dispatched = { calls: 0 };
    const handler = createWebhookPortHandler({
      vendors: { hubspot: buildHubspotDescriptor('secret', dispatched) },
      ledger: createIdempotencyLedger(),
    });
    // path matches the prefix but `nonexistent` is not configured
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/v1/connection/webhook/hubspot/nonexistent',
        body: '[]',
        headers: { 'x-hubspot-signature-v3': 'whatever' },
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
  });

  it('rejects deeply-nested paths (only one segment after prefix)', async () => {
    const dispatched = { calls: 0 };
    const handler = createWebhookPortHandler({
      vendors: { hubspot: buildHubspotDescriptor('secret', dispatched) },
      ledger: createIdempotencyLedger(),
    });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/v1/connection/webhook/hubspot/main/extra',
        body: '[]',
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
  });

  it('rejects a percent-encoded slash that decodes into a second segment', async () => {
    const dispatched = { calls: 0 };
    const descriptor = buildHubspotDescriptor('secret', dispatched);
    descriptor.resolveSecret = (name) => (name === 'main/extra' ? 'secret' : null);
    const handler = createWebhookPortHandler({
      vendors: { hubspot: descriptor },
      ledger: createIdempotencyLedger(),
    });
    const body = JSON.stringify([{ eventId: 'evt-encoded-slash' }]);
    const signature = createHmac('sha256', 'secret').update(body).digest('hex');
    const res = new FakeRes();

    await handler(
      buildReq({
        url: '/v1/connection/webhook/hubspot/main%2Fextra',
        body,
        headers: { 'x-hubspot-signature-v3': signature },
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(404);
    expect(dispatched.calls).toBe(0);
  });
});
