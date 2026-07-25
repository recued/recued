/** D-148 P9 § A.13 — webhook port routing across multiple vendors.
 *
 *  Asserts that the Slack + Telegram providers coexist behind the
 *  shared webhook port handler and that:
 *    - Path-prefix dispatch picks the right vendor.
 *    - Self-hosted (free-tier custom domain) and Pro DDNS hosts both
 *      route the same way (port handler is host-agnostic).
 *    - Cross-vendor traffic doesn't leak vendor names in 404 bodies.
 *    - Both vendors share the same idempotency ledger without
 *      colliding (vendor key is namespaced). */

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConnectionRow } from '@recued/contracts';
import { createWebhookPortHandler } from '../ports/webhook/handler.js';
import { createIdempotencyLedger } from '../ports/webhook/idempotency-ledger.js';
import {
  createSlackVendorDescriptor,
  type SlackInboundEvent,
} from '../connections/providers/slack-provider.js';
import {
  createTelegramVendorDescriptor,
  TELEGRAM_SECRET_HEADER,
  type TelegramInboundUpdate,
} from '../connections/providers/telegram-provider.js';

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

interface BuildReqOptions {
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

const buildReq = ({ url, headers = {}, body = '' }: BuildReqOptions): IncomingMessage => {
  const stream = Readable.from([Buffer.from(body, 'utf-8')]) as unknown as IncomingMessage;
  (stream as unknown as { url: string }).url = url;
  (stream as unknown as { method: string }).method = 'POST';
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  return stream;
};

const SLACK_SECRET = 'slack-fixture';
const TG_SECRET = 'tg-fixture-token';
const NOW_MS = 1_730_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);

const slackRow: ConnectionRow = {
  pk: 'notification:slack-prod',
  kind: 'notification',
  name: 'slack-prod',
  subtype: 'slack',
  display_name: 'Slack — Prod',
  config_json: '{}',
  auth_ciphertext: '',
  enrolled_at: NOW_MS,
  updated_at: NOW_MS,
};

const tgRow: ConnectionRow = {
  pk: 'notification:tg-prod',
  kind: 'notification',
  name: 'tg-prod',
  subtype: 'telegram',
  display_name: 'Telegram — Prod',
  config_json: '{}',
  auth_ciphertext: '',
  enrolled_at: NOW_MS,
  updated_at: NOW_MS,
};

const signSlack = (rawBody: string, ts: number, secret: string): string => {
  const canonical = `v0:${ts}:${rawBody}`;
  return `v0=${createHmac('sha256', secret).update(canonical).digest('hex')}`;
};

const buildHandler = () => {
  const slackDispatched: SlackInboundEvent[] = [];
  const tgDispatched: TelegramInboundUpdate[] = [];

  const slack = createSlackVendorDescriptor({
    lookupSlackConnection: (name) =>
      name === 'slack-prod' ? { row: slackRow, signing_secret: SLACK_SECRET } : null,
    dispatchEvent: async (e) => {
      slackDispatched.push(e);
    },
    now: () => NOW_MS,
  });

  const telegram = createTelegramVendorDescriptor({
    lookupTelegramConnection: (name) =>
      name === 'tg-prod' ? { row: tgRow, secret_token: TG_SECRET } : null,
    dispatchEvent: async (e) => {
      tgDispatched.push(e);
    },
  });

  const handler = createWebhookPortHandler({
    vendors: { slack, telegram },
    ledger: createIdempotencyLedger(),
  });

  return { handler, slackDispatched, tgDispatched };
};

describe('D-148 P9 — multi-vendor webhook port routing', () => {
  it('routes /webhooks/slack/<name> to the Slack provider', async () => {
    const { handler, slackDispatched, tgDispatched } = buildHandler();
    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev_route_1' });
    const sig = signSlack(body, NOW_SEC, SLACK_SECRET);
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(slackDispatched).toHaveLength(1);
    expect(tgDispatched).toHaveLength(0);
  });

  it('routes /webhooks/telegram/<name> to the Telegram provider', async () => {
    const { handler, slackDispatched, tgDispatched } = buildHandler();
    const body = JSON.stringify({ update_id: 1, message: { text: 'hi' } });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: { [TELEGRAM_SECRET_HEADER]: TG_SECRET },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(tgDispatched).toHaveLength(1);
    expect(slackDispatched).toHaveLength(0);
  });

  it('returns generic 404 for /webhooks/<unknown-vendor>/<name> with no vendor leak', async () => {
    const { handler } = buildHandler();
    const res = new FakeRes();
    await handler(
      buildReq({ url: '/webhooks/discord/main', body: '{}' }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
    const body = res.body ?? '';
    expect(body).not.toContain('slack');
    expect(body).not.toContain('telegram');
  });

  it('idempotency ledger namespaces by vendor (same id across vendors does not collide)', async () => {
    const { handler, slackDispatched, tgDispatched } = buildHandler();

    // Slack delivery with event_id="42"
    const slackBody = JSON.stringify({ type: 'event_callback', event_id: '42' });
    const sig = signSlack(slackBody, NOW_SEC, SLACK_SECRET);
    const r1 = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(NOW_SEC),
          'x-slack-signature': sig,
        },
        body: slackBody,
      }),
      r1 as unknown as ServerResponse,
    );
    expect(JSON.parse(r1.body ?? 'null')).toEqual({ ok: true, deduped: false });

    // Telegram delivery with update_id=42 — same numeric id, different vendor.
    const tgBody = JSON.stringify({ update_id: 42 });
    const r2 = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: { [TELEGRAM_SECRET_HEADER]: TG_SECRET },
        body: tgBody,
      }),
      r2 as unknown as ServerResponse,
    );
    // Must be fresh (vendor key namespacing prevents collision).
    expect(JSON.parse(r2.body ?? 'null')).toEqual({ ok: true, deduped: false });
    expect(slackDispatched).toHaveLength(1);
    expect(tgDispatched).toHaveLength(1);
  });

  it('Slack URL verification + Telegram update both succeed in one handler', async () => {
    const { handler, slackDispatched, tgDispatched } = buildHandler();

    // Slack URL verification — challenge echoed.
    const challenge = 'verify-token-routing';
    const slackBody = JSON.stringify({ type: 'url_verification', challenge });
    const sig = signSlack(slackBody, NOW_SEC, SLACK_SECRET);
    const r1 = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(NOW_SEC),
          'x-slack-signature': sig,
        },
        body: slackBody,
      }),
      r1 as unknown as ServerResponse,
    );
    expect(JSON.parse(r1.body ?? 'null')).toEqual({ challenge });
    expect(slackDispatched).toHaveLength(0);

    // Telegram update — engine dispatch.
    const tgBody = JSON.stringify({ update_id: 99 });
    const r2 = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: { [TELEGRAM_SECRET_HEADER]: TG_SECRET },
        body: tgBody,
      }),
      r2 as unknown as ServerResponse,
    );
    expect(r2.statusCode).toBe(200);
    expect(tgDispatched).toHaveLength(1);
  });

  it('free-tier (self-host custom domain) + Pro DDNS host both route the same way', async () => {
    // The webhook port handler is host-agnostic — the URL pathname is
    // the only routing signal. Free-tier (`https://my.example.com`)
    // and Pro (`https://alice.recued.cloud`) both produce the same
    // pathname (`/webhooks/slack/slack-prod`) so the handler decides
    // dispatch identically. This test asserts the routing contract by
    // executing the same path twice with different `Host` headers.
    const { handler, slackDispatched } = buildHandler();
    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev_host_1' });
    const sig = signSlack(body, NOW_SEC, SLACK_SECRET);

    const free = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'host': 'my.example.com',
          'x-slack-request-timestamp': String(NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      free as unknown as ServerResponse,
    );
    expect(free.statusCode).toBe(200);

    // Different event_id so dedup doesn't fire.
    const body2 = JSON.stringify({ type: 'event_callback', event_id: 'Ev_host_2' });
    const sig2 = signSlack(body2, NOW_SEC, SLACK_SECRET);
    const pro = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'host': 'alice.recued.cloud',
          'x-slack-request-timestamp': String(NOW_SEC),
          'x-slack-signature': sig2,
        },
        body: body2,
      }),
      pro as unknown as ServerResponse,
    );
    expect(pro.statusCode).toBe(200);
    expect(slackDispatched).toHaveLength(2);
  });
});
