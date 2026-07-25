/** D-148 P9 § A.13 — vendor webhook port composer tests.
 *
 *  Pins the composer's gate semantics and the wired Slack + Telegram
 *  vendor descriptors against the live `createWebhookPortHandler`.
 *  The substrate slice (commit 81554dc8) already had routing tests
 *  with hand-built descriptors; this suite ratifies that the composer
 *  builds the same descriptor set from a `ConnectionStoreSqlite` and
 *  hands them to the port handler with the right defaults. */

import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConnectionKind, ConnectionRow } from '@recued/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  composeVendorWebhookPort,
} from '../composition/bin/wire-vendor-webhook-port.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';

const NOW_MS = Date.parse('2026-05-27T12:00:00.000Z');
const NOW_SEC = Math.floor(NOW_MS / 1000);
const SLACK_SECRET = 'slack-signing-secret-test';
const TG_SECRET = 'telegram-webhook-secret-test';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

const buildRow = (overrides: {
  name: string;
  config: Record<string, unknown>;
  kind?: ConnectionKind;
}): ConnectionRow => ({
  pk: `${overrides.kind ?? 'notification'}:${overrides.name}`,
  kind: overrides.kind ?? 'notification',
  name: overrides.name,
  display_name: overrides.name,
  config_json: JSON.stringify(overrides.config),
  auth_ciphertext: '',
  enrolled_at: NOW_MS,
  updated_at: NOW_MS,
});

const stubConnectionStore = (
  rows: ReadonlyArray<ConnectionRow>,
): ConnectionStoreSqlite =>
  ({
    get: vi.fn((kind: ConnectionKind, name: string): ConnectionRow | null => {
      const match = rows.find((r) => r.kind === kind && r.name === name);
      return match ?? null;
    }),
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

const buildReq = (opts: {
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage => {
  const stream = Readable.from([Buffer.from(opts.body ?? '', 'utf-8')]) as unknown as IncomingMessage;
  (stream as unknown as { url: string }).url = opts.url;
  (stream as unknown as { method: string }).method = 'POST';
  (stream as unknown as { headers: Record<string, string> }).headers = opts.headers ?? {};
  return stream;
};

const signSlack = (body: string, ts: number, secret: string): string => {
  const canonical = `v0:${ts}:${body}`;
  return `v0=${createHmac('sha256', secret).update(canonical).digest('hex')}`;
};

describe('composeVendorWebhookPort — gates', () => {
  it('returns undefined when webhookPort <= 0', () => {
    const handler = composeVendorWebhookPort({
      webhookPort: 0,
      connectionStore: stubConnectionStore([]),
    });
    expect(handler).toBeUndefined();
  });

  it('returns undefined when connectionStore is absent', () => {
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
    });
    expect(handler).toBeUndefined();
  });

  it('returns a handler when port > 0 AND connectionStore is wired', () => {
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([]),
    });
    expect(typeof handler).toBe('function');
  });
});

describe('composeVendorWebhookPort — D-188 master pause', () => {
  const slackRow = buildRow({
    name: 'slack-prod',
    config: { signing_secret: SLACK_SECRET, channel_id: 'C123' },
  });

  const sendSignedSlack = async (isPaused: boolean) => {
    const dispatchSlackEvent = vi.fn(async () => undefined);
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([slackRow]),
      messengerDispatchers: { slack: dispatchSlackEvent },
      isPaused: () => isPaused,
      now: () => NOW_MS,
    })!;
    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev_pause' });
    const sig = signSlack(body, NOW_SEC, SLACK_SECRET);
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: { 'x-slack-request-timestamp': String(NOW_SEC), 'x-slack-signature': sig },
        body,
      }),
      res as unknown as ServerResponse,
    );
    return { res, dispatchSlackEvent };
  };

  it('closes the port with 503 SERVER_PAUSED while paused (no dispatch)', async () => {
    const { res, dispatchSlackEvent } = await sendSignedSlack(true);
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('SERVER_PAUSED');
    expect(dispatchSlackEvent).not.toHaveBeenCalled();
  });

  it('serves the (valid) callback normally when not paused', async () => {
    const { res, dispatchSlackEvent } = await sendSignedSlack(false);
    expect(res.statusCode).toBe(200);
    expect(dispatchSlackEvent).toHaveBeenCalledTimes(1);
  });
});

describe('composeVendorWebhookPort — Slack routing', () => {
  const slackRow = buildRow({
    name: 'slack-prod',
    config: { signing_secret: SLACK_SECRET, channel_id: 'C123' },
  });

  it('verifies a signed Slack event_callback and dispatches it', async () => {
    const dispatchSlackEvent = vi.fn(async () => undefined);
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([slackRow]),
      messengerDispatchers: { slack: dispatchSlackEvent },
      now: () => NOW_MS,
    })!;

    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev_compose_1' });
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
    expect(dispatchSlackEvent).toHaveBeenCalledTimes(1);
    expect(dispatchSlackEvent).toHaveBeenCalledWith(
      expect.objectContaining({ connection_name: 'slack-prod' }),
    );
  });

  it('rejects an invalid Slack signature with 401', async () => {
    const dispatchSlackEvent = vi.fn(async () => undefined);
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([slackRow]),
      messengerDispatchers: { slack: dispatchSlackEvent },
      now: () => NOW_MS,
    })!;

    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev_compose_2' });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(NOW_SEC),
          'x-slack-signature': 'v0=0000000000000000000000000000000000000000000000000000000000000000',
        },
        body,
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(401);
    expect(dispatchSlackEvent).not.toHaveBeenCalled();
  });

  it('returns 404 (vendor-agnostic) when Slack connection row is missing', async () => {
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([]),
      now: () => NOW_MS,
    })!;

    const body = JSON.stringify({ type: 'event_callback' });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/unknown',
        headers: {
          'x-slack-request-timestamp': String(NOW_SEC),
          'x-slack-signature': signSlack(body, NOW_SEC, SLACK_SECRET),
        },
        body,
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 when Slack row config_json is missing signing_secret', async () => {
    const malformedRow = buildRow({
      name: 'slack-prod',
      config: { channel_id: 'C123' }, // signing_secret missing
    });
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([malformedRow]),
      now: () => NOW_MS,
    })!;

    const body = JSON.stringify({ type: 'event_callback' });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(NOW_SEC),
          'x-slack-signature': signSlack(body, NOW_SEC, SLACK_SECRET),
        },
        body,
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(404);
  });

  it('default dispatchSlackEvent stub log+drops (no override)', async () => {
    const log = vi.fn();
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([slackRow]),
      log,
      now: () => NOW_MS,
    })!;

    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev_compose_log' });
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
    // Default stub fires the log at info level with the connection_name.
    expect(log).toHaveBeenCalledWith(
      'info',
      'webhook inbound (slack)',
      expect.objectContaining({ connection_name: 'slack-prod' }),
    );
  });
});

describe('composeVendorWebhookPort — Telegram routing', () => {
  const tgRow = buildRow({
    name: 'tg-prod',
    config: { webhook_secret: TG_SECRET, chat_id: '@my_channel' },
  });

  it('verifies a signed Telegram update and dispatches it', async () => {
    const dispatchTelegramEvent = vi.fn(async () => undefined);
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([tgRow]),
      messengerDispatchers: { telegram: dispatchTelegramEvent },
      now: () => NOW_MS,
    })!;

    const body = JSON.stringify({ update_id: 12345, message: { text: 'hi' } });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: {
          'x-telegram-bot-api-secret-token': TG_SECRET,
        },
        body,
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(dispatchTelegramEvent).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramEvent).toHaveBeenCalledWith(
      expect.objectContaining({ connection_name: 'tg-prod', update_id: '12345' }),
    );
  });

  it('rejects an invalid Telegram secret token with 401', async () => {
    const dispatchTelegramEvent = vi.fn(async () => undefined);
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([tgRow]),
      messengerDispatchers: { telegram: dispatchTelegramEvent },
      now: () => NOW_MS,
    })!;

    const body = JSON.stringify({ update_id: 12346, message: { text: 'hi' } });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: {
          'x-telegram-bot-api-secret-token': 'wrong-secret',
        },
        body,
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(401);
    expect(dispatchTelegramEvent).not.toHaveBeenCalled();
  });

  it('returns 404 when Telegram row config_json is missing webhook_secret', async () => {
    const malformedRow = buildRow({
      name: 'tg-prod',
      config: { chat_id: '@my_channel' }, // webhook_secret missing
    });
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([malformedRow]),
      now: () => NOW_MS,
    })!;

    const body = JSON.stringify({ update_id: 12347 });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: {
          'x-telegram-bot-api-secret-token': TG_SECRET,
        },
        body,
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(404);
  });

  it('default dispatchTelegramEvent stub log+drops (no override)', async () => {
    const log = vi.fn();
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([tgRow]),
      log,
      now: () => NOW_MS,
    })!;

    const body = JSON.stringify({ update_id: 12348, message: { text: 'hi' } });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: {
          'x-telegram-bot-api-secret-token': TG_SECRET,
        },
        body,
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(log).toHaveBeenCalledWith(
      'info',
      'webhook inbound (telegram)',
      expect.objectContaining({ connection_name: 'tg-prod', update_id: '12348' }),
    );
  });
});

describe('composeVendorWebhookPort — vendor-agnostic 404', () => {
  it('returns 404 for an unconfigured vendor prefix', async () => {
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([]),
      now: () => NOW_MS,
    })!;

    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/notavendor/some-name',
        body: '{}',
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(404);
  });

  it('rejects a malformed config_json on Slack row with 404 (vendor-agnostic)', async () => {
    const row = buildRow({
      name: 'slack-prod',
      config: { signing_secret: SLACK_SECRET },
    });
    (row as { config_json: string }).config_json = '{ not valid json';
    const handler = composeVendorWebhookPort({
      webhookPort: 8443,
      connectionStore: stubConnectionStore([row]),
      now: () => NOW_MS,
    })!;

    const body = JSON.stringify({ type: 'event_callback' });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(NOW_SEC),
          'x-slack-signature': signSlack(body, NOW_SEC, SLACK_SECRET),
        },
        body,
      }),
      res as unknown as ServerResponse,
    );

    expect(res.statusCode).toBe(404);
  });
});
