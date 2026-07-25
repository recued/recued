/** D-148 P9 § A.13 — `server.ts` path-router branch for the vendor
 *  webhook port (`POST /webhooks/<vendor>/<connection_name>`).
 *
 *  Pins:
 *    - `/webhooks/<vendor>/<connection_name>` routes to the
 *      `vendorWebhookListener` slot (not to Phase D's `webhookListener`
 *      nor D-128 P3's `connectionWebhookListener`).
 *    - `/webhook/<slug>` (singular, Phase D) still routes to the
 *      `webhookListener` slot — the trailing `s` disambiguates.
 *    - Absent `vendorWebhookListener` ⇒ `/webhooks/*` falls through
 *      to the floor 404 (vendor-agnostic per spec § P6 acceptance). */

import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServerHandlerSet } from '../server.js';
import {
  createVendorOAuthFlowStore,
  createVendorOAuthResultStore,
} from '../connection-vendor-oauth-flow.js';
import { createServerIdentity } from '../identity/index.js';
import { createInMemoryServerKeyStore } from '../keys/index.js';
import type { VendorOAuthCompletePortHandlerDeps } from '../connection-vendor-oauth-complete-port.js';

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body: string | null = null;
  setHeader(key: string, value: string): void {
    this.headers[key.toLowerCase()] = value;
  }
  end(body?: string): void {
    this.body = body ?? '';
  }
}

const buildReq = (opts: {
  url: string;
  method?: string;
  body?: string;
}): IncomingMessage => {
  const stream = Readable.from([Buffer.from(opts.body ?? '', 'utf-8')]) as unknown as IncomingMessage;
  (stream as unknown as { url: string }).url = opts.url;
  (stream as unknown as { method: string }).method = opts.method ?? 'POST';
  (stream as unknown as { headers: Record<string, string> }).headers = {};
  return stream;
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

describe('server.ts webhooks role — D-148 P9 vendor path-router branch', () => {
  it('routes POST /webhooks/<vendor>/<name> to vendorWebhookListener', async () => {
    const vendorWebhookListener = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.end('vendor-handled');
    });
    const webhookListener = vi.fn();

    const handlerSet = createServerHandlerSet({
      webhookListener,
      vendorWebhookListener,
    });
    cleanups.push(() => handlerSet.close());

    const res = new FakeRes();
    await handlerSet.handlers.webhooks!(
      buildReq({ url: '/webhooks/slack/slack-prod', body: '{}' }),
      res as unknown as ServerResponse,
    );

    expect(vendorWebhookListener).toHaveBeenCalledTimes(1);
    expect(webhookListener).not.toHaveBeenCalled();
    expect(res.body).toBe('vendor-handled');
  });

  it('routes POST /webhook/<slug> (singular) to webhookListener — trailing `s` disambiguates', async () => {
    const vendorWebhookListener = vi.fn();
    const webhookListener = vi.fn(async (
      _req: IncomingMessage,
      res: ServerResponse,
      _slug: string,
    ) => {
      res.statusCode = 200;
      res.end('phase-d-handled');
    });

    const handlerSet = createServerHandlerSet({
      webhookListener,
      vendorWebhookListener,
    });
    cleanups.push(() => handlerSet.close());

    const res = new FakeRes();
    await handlerSet.handlers.webhooks!(
      buildReq({ url: '/webhook/some-slug', body: '{}' }),
      res as unknown as ServerResponse,
    );

    expect(webhookListener).toHaveBeenCalledTimes(1);
    expect(webhookListener).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'some-slug',
    );
    expect(vendorWebhookListener).not.toHaveBeenCalled();
    expect(res.body).toBe('phase-d-handled');
  });

  it('returns 404 for /webhooks/* when vendorWebhookListener is absent (floor)', async () => {
    const webhookListener = vi.fn();
    const handlerSet = createServerHandlerSet({
      webhookListener,
      // vendorWebhookListener intentionally omitted
    });
    cleanups.push(() => handlerSet.close());

    const res = new FakeRes();
    await handlerSet.handlers.webhooks!(
      buildReq({ url: '/webhooks/slack/some-name', body: '{}' }),
      res as unknown as ServerResponse,
    );

    expect(webhookListener).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });

  it('delegates GET to the port (a vendor handshake), and still gates every other method', async () => {
    // D-192 WhatsApp make-live — this used to assert "404 for any non-POST". GET is
    // now DELEGATED, because Meta will not deliver a single POST until the endpoint
    // echoes `hub.challenge` on a GET: a POST-only router makes an entire vendor
    // class impossible to host.
    //
    // Nothing became newly reachable. The PORT still answers a GET with the same
    // generic 404 for any vendor that declares no `verifyChallenge`, and answers a
    // FAILED handshake identically — so a GET cannot be used to discover which
    // connections exist (pinned in `d-192-whatsapp-webhook.test.ts`). The gate moved
    // from the router to the port; it did not disappear.
    const vendorWebhookListener = vi.fn();
    const handlerSet = createServerHandlerSet({ vendorWebhookListener });
    cleanups.push(() => handlerSet.close());

    await handlerSet.handlers.webhooks!(
      buildReq({ url: '/webhooks/whatsapp/whatsapp', method: 'GET' }),
      new FakeRes() as unknown as ServerResponse,
    );
    expect(vendorWebhookListener).toHaveBeenCalledTimes(1);

    // Every OTHER method is still stopped dead at the router — it never reaches the
    // port at all.
    for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const) {
      const res = new FakeRes();
      await handlerSet.handlers.webhooks!(
        buildReq({ url: '/webhooks/slack/slack-prod', method }),
        res as unknown as ServerResponse,
      );
      expect(res.statusCode, `${method} must not reach the port`).toBe(404);
    }
    // Still only the one GET — no other method was delegated.
    expect(vendorWebhookListener).toHaveBeenCalledTimes(1);
  });
});

describe('server.ts webhooks role — malformed-encoding + error-leak hardening', () => {
  it('maps a malformed %-escape on /v1/connection/webhook to a generic 400 (not a 500) without invoking the listener', async () => {
    const connectionWebhookListener = vi.fn();
    const handlerSet = createServerHandlerSet({ connectionWebhookListener });
    cleanups.push(() => handlerSet.close());

    const res = new FakeRes();
    await handlerSet.handlers.webhooks!(
      // Lone `%` in the connection-name segment → decodeURIComponent throws.
      buildReq({ url: '/v1/connection/webhook/hubspot/%', body: '{}' }),
      res as unknown as ServerResponse,
    );

    expect(connectionWebhookListener).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error.code).toBe('bad_request');
  });

  it('maps a malformed %-escape on /webhook/<slug> (Phase D) to a generic 400', async () => {
    const webhookListener = vi.fn();
    const handlerSet = createServerHandlerSet({ webhookListener });
    cleanups.push(() => handlerSet.close());

    const res = new FakeRes();
    await handlerSet.handlers.webhooks!(
      buildReq({ url: '/webhook/%zz', body: '{}' }),
      res as unknown as ServerResponse,
    );

    expect(webhookListener).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error.code).toBe('bad_request');
  });

  it('maps a malformed %-escape on /hook/<recipe>/<slug> to a generic 400', async () => {
    const hookListener = vi.fn();
    const handlerSet = createServerHandlerSet({ hookListener });
    cleanups.push(() => handlerSet.close());

    const res = new FakeRes();
    await handlerSet.handlers.webhooks!(
      buildReq({ url: '/hook/my-recipe/%E0%A4%A', body: '{}' }),
      res as unknown as ServerResponse,
    );

    expect(hookListener).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body!).error.code).toBe('bad_request');
  });

  it('never echoes the raw exception message when a downstream listener throws (500 stays generic)', async () => {
    const connectionWebhookListener = vi.fn(async () => {
      throw new Error('SECRET_INTERNAL_DETAIL /var/lib/recued/x');
    });
    const handlerSet = createServerHandlerSet({ connectionWebhookListener });
    cleanups.push(() => handlerSet.close());

    const res = new FakeRes();
    await handlerSet.handlers.webhooks!(
      buildReq({ url: '/v1/connection/webhook/hubspot/prod', body: '{}' }),
      res as unknown as ServerResponse,
    );

    expect(connectionWebhookListener).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('SECRET_INTERNAL_DETAIL');
    expect(JSON.parse(res.body!).error.message).toBe('internal error');
  });
});

describe('server.ts oauth role — D-165 enroll-host #1 mount seam (slice 2b Piece M)', () => {
  const makeOauthCompletePortDeps = (): VendorOAuthCompletePortHandlerDeps => ({
    identity: createServerIdentity({ store: createInMemoryServerKeyStore() }),
    flowStore: createVendorOAuthFlowStore(),
    resultStore: createVendorOAuthResultStore(),
    serverPublicUrl: () => 'https://h.example.com',
  });

  it('omits the oauth handler when oauthCompletePortDeps is absent (404 floor)', () => {
    const handlerSet = createServerHandlerSet({});
    cleanups.push(() => handlerSet.close());
    // No `oauth` entry in the handlers map → the path-router dispatches
    // `/oauth/complete` to its generic 404. The mount is conditional on
    // `oauthCompletePortDeps`; production supplies it from `composeListeners`
    // (slice 2b Piece W), a db-less harness like this one omits it.
    expect(handlerSet.handlers.oauth).toBeUndefined();
  });

  it('mounts the oauth handler when oauthCompletePortDeps is supplied', async () => {
    const handlerSet = createServerHandlerSet({
      oauthCompletePortDeps: makeOauthCompletePortDeps(),
    });
    cleanups.push(() => handlerSet.close());

    expect(handlerSet.handlers.oauth).toBeDefined();

    // A bare GET (no signed state) dispatches into the adapter — it
    // responds rather than throwing, and stamps the oauth adapter's
    // `Cache-Control: no-store` header (proving it's the vendor-OAuth
    // handler, not a generic floor). The full state-validation flow is
    // covered in the adapter + core suites.
    const res = new FakeRes();
    await handlerSet.handlers.oauth!(
      buildReq({ url: '/oauth/complete', method: 'GET' }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
