/** D-196 S4 — Stripe timestamped webhook trust-boundary tests.
 *
 *  These tests drive the real vendor-port composer so they cover connection
 *  authority, raw-byte signature verification, replay freshness, optional
 *  route registration, event validation, and post-verification dispatch. */

import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ConnectionKind, ConnectionRow } from '@recued/contracts';
import { describe, expect, it, vi } from 'vitest';

import { composeVendorWebhookPort } from '../composition/bin/wire-vendor-webhook-port.js';
import { createServerHandlerSet } from '../server.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';

const NOW_MS = Date.parse('2026-07-10T17:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const STRIPE_SECRET = 'whsec_d196_test';

const buildRow = (overrides: {
  name?: string;
  kind?: ConnectionKind;
  subtype?: string;
  config?: Record<string, unknown>;
} = {}): ConnectionRow => {
  const name = overrides.name ?? 'stripe-main';
  const kind = overrides.kind ?? 'api';
  return {
    pk: `${kind}:${name}`,
    kind,
    name,
    display_name: 'Stripe Main',
    ...(overrides.subtype ? { subtype: overrides.subtype } : {}),
    config_json: JSON.stringify(overrides.config ?? {
      vendor: 'stripe',
      webhook_secret: STRIPE_SECRET,
    }),
    auth_ciphertext: 'ciphertext',
    enrolled_at: NOW_MS,
    updated_at: NOW_MS,
  };
};

const stubConnectionStore = (
  rows: ReadonlyArray<ConnectionRow>,
): ConnectionStoreSqlite => ({
  get: vi.fn((kind: ConnectionKind, name: string): ConnectionRow | null =>
    rows.find((row) => row.kind === kind && row.name === name) ?? null),
}) as unknown as ConnectionStoreSqlite;

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

const buildReq = (options: {
  body: string;
  header?: string;
  url?: string;
  extraHeaders?: Record<string, string>;
}): IncomingMessage => {
  const stream = Readable.from([
    Buffer.from(options.body, 'utf-8'),
  ]) as unknown as IncomingMessage;
  (stream as unknown as { method: string }).method = 'POST';
  (stream as unknown as { url: string }).url =
    options.url ?? '/webhooks/stripe/stripe-main';
  (stream as unknown as { headers: Record<string, string> }).headers = {
    ...(options.header ? { 'stripe-signature': options.header } : {}),
    ...options.extraHeaders,
  };
  return stream;
};

const stripeDigest = (
  body: string,
  timestamp: string | number = NOW_SECONDS,
  secret = STRIPE_SECRET,
): string => {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestamp}.`);
  hmac.update(Buffer.from(body, 'utf-8'));
  return hmac.digest('hex');
};

const stripeHeader = (
  body: string,
  timestamp: string | number = NOW_SECONDS,
  secret = STRIPE_SECRET,
): string => `t=${timestamp},v1=${stripeDigest(body, timestamp, secret)}`;

const eventBody = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  id: 'evt_d196_1',
  object: 'event',
  type: 'invoice.paid',
  created: NOW_SECONDS - 20,
  livemode: false,
  data: { object: { id: 'in_123' } },
  ...overrides,
});

const responseJson = (res: FakeRes): Record<string, unknown> =>
  JSON.parse(res.body ?? '{}') as Record<string, unknown>;

describe('D-196 Stripe webhook composition', () => {
  it('does not register a Stripe route without a real lifecycle dispatcher', async () => {
    const body = eventBody();
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([buildRow()]),
      now: () => NOW_MS,
    })!;
    const res = new FakeRes();

    await handler(
      buildReq({ body, header: stripeHeader(body) }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('stripe');
  });

  it('preserves exact raw bytes through the live server route and dispatches', async () => {
    const dispatchStripeEvent = vi.fn(async () => undefined);
    const vendorWebhookListener = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([buildRow()]),
      dispatchStripeEvent,
      now: () => NOW_MS,
    })!;
    const handlerSet = createServerHandlerSet({ vendorWebhookListener });
    const body = JSON.stringify({
      id: 'evt_exact_bytes',
      object: 'event',
      type: 'customer.subscription.updated',
      created: NOW_SECONDS - 10,
      livemode: true,
      data: { object: { id: 'sub_123' } },
    }, null, 2);
    const signature = stripeHeader(body);
    const res = new FakeRes();

    try {
      await handlerSet.handlers.webhooks!(
        buildReq({
          body,
          header: signature,
          extraHeaders: { 'x-request-trace': 'trace-1' },
        }),
        res as unknown as ServerResponse,
      );
    } finally {
      handlerSet.close();
    }

    expect(res.statusCode).toBe(200);
    expect(responseJson(res)).toMatchObject({ ok: true, deduped: false });
    expect(dispatchStripeEvent).toHaveBeenCalledTimes(1);
    expect(dispatchStripeEvent).toHaveBeenCalledWith({
      connection_name: 'stripe-main',
      event_id: 'evt_exact_bytes',
      type: 'customer.subscription.updated',
      created: NOW_SECONDS - 10,
      livemode: true,
      payload: JSON.parse(body),
      headers: {
        'stripe-signature': signature,
        'x-request-trace': 'trace-1',
      },
    });
  });

  it('accepts one matching v1 digest during endpoint-secret rotation', async () => {
    const dispatchStripeEvent = vi.fn(async () => undefined);
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([buildRow()]),
      dispatchStripeEvent,
      now: () => NOW_MS,
    })!;
    const body = eventBody({ id: 'evt_rotating_secret' });
    const valid = stripeDigest(body).toUpperCase();
    const invalid = '0'.repeat(64);
    const res = new FakeRes();

    await handler(
      buildReq({
        body,
        header: `t=${NOW_SECONDS},v1=${invalid},v0=${invalid},v1=${valid}`,
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(dispatchStripeEvent).toHaveBeenCalledTimes(1);
  });

  it('accepts the exact five-minute freshness boundary', async () => {
    const dispatchStripeEvent = vi.fn(async () => undefined);
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([buildRow()]),
      dispatchStripeEvent,
      now: () => NOW_MS,
    })!;
    const body = eventBody({ id: 'evt_boundary' });
    const timestamp = NOW_SECONDS - 300;
    const res = new FakeRes();

    await handler(
      buildReq({ body, header: stripeHeader(body, timestamp) }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(dispatchStripeEvent).toHaveBeenCalledTimes(1);
  });

  it('keeps Stripe retries dispatchable after a transient failure', async () => {
    const dispatchStripeEvent = vi.fn()
      .mockRejectedValueOnce(new Error('reconciliation unavailable'))
      .mockResolvedValueOnce(undefined);
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([buildRow()]),
      dispatchStripeEvent,
      now: () => NOW_MS,
    })!;
    const body = eventBody({ id: 'evt_retry_after_502' });
    const header = stripeHeader(body);
    const first = new FakeRes();
    const retry = new FakeRes();

    await handler(buildReq({ body, header }), first as unknown as ServerResponse);
    await handler(buildReq({ body, header }), retry as unknown as ServerResponse);

    expect(first.statusCode).toBe(502);
    expect(retry.statusCode).toBe(200);
    expect(dispatchStripeEvent).toHaveBeenCalledTimes(2);
  });

  it('lets idempotent lifecycle convergence absorb a replay inside the signature window', async () => {
    const dispatchStripeEvent = vi.fn(async () => undefined);
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([buildRow()]),
      dispatchStripeEvent,
      now: () => NOW_MS,
    })!;
    const body = eventBody({ id: 'evt_idempotent_replay' });
    const header = stripeHeader(body);
    const first = new FakeRes();
    const replay = new FakeRes();

    await handler(buildReq({ body, header }), first as unknown as ServerResponse);
    await handler(buildReq({ body, header }), replay as unknown as ServerResponse);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(responseJson(replay)).toMatchObject({ ok: true, deduped: false });
    expect(dispatchStripeEvent).toHaveBeenCalledTimes(2);
  });
});

describe('D-196 Stripe-Signature verification', () => {
  const send = async (options: {
    body?: string;
    header?: string;
    row?: ConnectionRow;
    rows?: ConnectionRow[];
  }) => {
    const body = options.body ?? eventBody();
    const dispatch = vi.fn(async () => undefined);
    const rows = options.rows ?? [options.row ?? buildRow()];
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore(rows),
      dispatchStripeEvent: dispatch,
      now: () => NOW_MS,
    })!;
    const res = new FakeRes();
    await handler(
      buildReq({ body, header: options.header }),
      res as unknown as ServerResponse,
    );
    return { res, dispatch };
  };

  it('rejects a body whose whitespace changed after signing', async () => {
    const compact = eventBody({ id: 'evt_whitespace' });
    const pretty = JSON.stringify(JSON.parse(compact), null, 2);
    const { res, dispatch } = await send({
      body: pretty,
      header: stripeHeader(compact),
    });

    expect(res.statusCode).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rejects a digest made with another endpoint secret', async () => {
    const body = eventBody({ id: 'evt_wrong_secret' });
    const { res, dispatch } = await send({
      body,
      header: stripeHeader(body, NOW_SECONDS, 'whsec_wrong'),
    });

    expect(res.statusCode).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['stale', NOW_SECONDS - 301],
    ['future-dated', NOW_SECONDS + 301],
  ])('rejects a valid but %s signature outside the replay window', async (_label, timestamp) => {
    const body = eventBody({ id: `evt_${_label}` });
    const { res, dispatch } = await send({
      body,
      header: stripeHeader(body, timestamp),
    });

    expect(res.statusCode).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['missing header', undefined],
    ['missing timestamp', `v1=${'0'.repeat(64)}`],
    ['missing v1', `t=${NOW_SECONDS},v0=${'0'.repeat(64)}`],
    ['short v1', `t=${NOW_SECONDS},v1=abc`],
    ['non-decimal timestamp', `t=${NOW_SECONDS}.0,v1=${'0'.repeat(64)}`],
    ['leading-zero timestamp', `t=0${NOW_SECONDS},v1=${'0'.repeat(64)}`],
    [
      'divergent timestamps',
      `t=${NOW_SECONDS},t=${NOW_SECONDS + 1},v1=${'0'.repeat(64)}`,
    ],
  ])('fails closed on a %s', async (_label, header) => {
    const { res, dispatch } = await send({ header });

    expect(res.statusCode).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('D-196 Stripe event and connection authority', () => {
  it.each([
    ['malformed JSON', '{"id":'],
    ['array envelope', '[]'],
    ['missing object tag', eventBody({ object: undefined })],
    ['thin-v2 object tag', eventBody({ object: 'v2.core.event' })],
    ['missing event id', eventBody({ id: undefined })],
    ['missing event type', eventBody({ type: undefined })],
    ['blank event id', eventBody({ id: '   ' })],
    ['blank event type', eventBody({ type: '\t' })],
    ['missing created timestamp', eventBody({ created: undefined })],
    ['fractional created timestamp', eventBody({ created: NOW_SECONDS - 0.5 })],
    ['negative created timestamp', eventBody({ created: -1 })],
    ['missing livemode', eventBody({ livemode: undefined })],
    ['non-boolean livemode', eventBody({ livemode: 'false' })],
  ])('returns 502 without dispatch for a signed %s', async (_label, body) => {
    const dispatchStripeEvent = vi.fn(async () => undefined);
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([buildRow()]),
      dispatchStripeEvent,
      now: () => NOW_MS,
    })!;
    const res = new FakeRes();

    await handler(
      buildReq({ body, header: stripeHeader(body) }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(502);
    expect(dispatchStripeEvent).not.toHaveBeenCalled();
  });

  it.each([
    [
      'missing webhook secret',
      buildRow({ config: { vendor: 'stripe' } }),
    ],
    [
      'different API vendor',
      buildRow({ config: { vendor: 'github', webhook_secret: STRIPE_SECRET } }),
    ],
    [
      'same-named notification connection',
      buildRow({
        kind: 'notification',
        config: { vendor: 'stripe', webhook_secret: STRIPE_SECRET },
      }),
    ],
  ])('returns the vendor-agnostic 404 for a %s', async (_label, row) => {
    const dispatchStripeEvent = vi.fn(async () => undefined);
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([row]),
      dispatchStripeEvent,
      now: () => NOW_MS,
    })!;
    const body = eventBody();
    const res = new FakeRes();

    await handler(
      buildReq({ body, header: stripeHeader(body) }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('stripe');
    expect(dispatchStripeEvent).not.toHaveBeenCalled();
  });

  it('accepts the shared subtype fallback for a canonical Stripe API row', async () => {
    const row = buildRow({
      subtype: 'stripe',
      config: { webhook_secret: STRIPE_SECRET },
    });
    const dispatchStripeEvent = vi.fn(async () => undefined);
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([row]),
      dispatchStripeEvent,
      now: () => NOW_MS,
    })!;
    const body = eventBody({ id: 'evt_subtype_fallback' });
    const res = new FakeRes();

    await handler(
      buildReq({ body, header: stripeHeader(body) }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(dispatchStripeEvent).toHaveBeenCalledTimes(1);
  });

  it('maps dispatcher rejection to 502 without acknowledging success', async () => {
    const dispatchStripeEvent = vi.fn(async () => {
      throw new Error('provider read-back failed');
    });
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([buildRow()]),
      dispatchStripeEvent,
      now: () => NOW_MS,
    })!;
    const body = eventBody({ id: 'evt_dispatch_failed' });
    const res = new FakeRes();

    await handler(
      buildReq({ body, header: stripeHeader(body) }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(502);
    expect(responseJson(res)).toMatchObject({
      error: { code: 'dispatch_failed' },
    });
  });
});
