/** D-148 P9 § A.13 — Slack Events API webhook provider tests.
 *
 *  Coverage:
 *    - Path prefix + connection-name resolution.
 *    - HMAC signature verification (good / tampered / wrong / missing
 *      / invalid version prefix / non-hex digest).
 *    - Replay window enforcement (in-window / out-of-window).
 *    - URL verification challenge response.
 *    - Engine dispatch on `event_callback` events.
 *    - Connection lookup miss → null secret.
 *    - End-to-end dispatch through `createWebhookPortHandler`.
 *    - `signing_secret` is a registered inbound-secret field. */

import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CONNECTION_INBOUND_SECRET_FIELDS,
  type ConnectionRow,
} from '@recued/contracts';
import { createWebhookPortHandler } from '../ports/webhook/handler.js';
import { createIdempotencyLedger } from '../ports/webhook/idempotency-ledger.js';
import {
  createSlackVendorDescriptor,
  SLACK_REPLAY_WINDOW_SECONDS,
  type SlackInboundEvent,
  type SlackProviderDeps,
} from '../connections/providers/slack-provider.js';

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  body: string | null = null;
  setHeader(key: string, value: string): void {
    this.headers[key.toLowerCase()] = value;
  }
  getHeader(key: string): string | undefined {
    return this.headers[key.toLowerCase()];
  }
  end(body?: string): void {
    this.body = body ?? '';
  }
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

const SIGNING_SECRET = 'slack-signing-secret-fixture';
const FROZEN_NOW_MS = 1_730_000_000_000;
const FROZEN_NOW_SEC = Math.floor(FROZEN_NOW_MS / 1000);

const slackRow: ConnectionRow = {
  pk: 'notification:slack-prod',
  kind: 'notification',
  name: 'slack-prod',
  subtype: 'slack',
  display_name: 'Slack — Production',
  config_json: JSON.stringify({ channel_id: 'C123', signing_secret: SIGNING_SECRET }),
  auth_ciphertext: '',
  enrolled_at: FROZEN_NOW_MS - 60_000,
  updated_at: FROZEN_NOW_MS - 30_000,
};

const buildDeps = (
  overrides: Partial<SlackProviderDeps> = {},
): SlackProviderDeps & { dispatched: SlackInboundEvent[] } => {
  const dispatched: SlackInboundEvent[] = [];
  const deps: SlackProviderDeps & { dispatched: SlackInboundEvent[] } = {
    lookupSlackConnection: (name) =>
      name === slackRow.name ? { row: slackRow, signing_secret: SIGNING_SECRET } : null,
    dispatchEvent: async (e) => {
      dispatched.push(e);
    },
    now: () => FROZEN_NOW_MS,
    dispatched,
    ...overrides,
  };
  return deps;
};

const signSlack = (rawBody: string, ts: number, secret: string): string => {
  const canonical = `v0:${ts}:${rawBody}`;
  return `v0=${createHmac('sha256', secret).update(canonical).digest('hex')}`;
};

describe('createSlackVendorDescriptor', () => {
  it('exposes path_prefix /webhooks/slack/', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    expect(descriptor.path_prefix).toBe('/webhooks/slack/');
  });

  it('resolveSecret returns the connection signing_secret', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    expect(descriptor.resolveSecret('slack-prod')).toBe(SIGNING_SECRET);
  });

  it('resolveSecret returns null for unknown connection', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    expect(descriptor.resolveSecret('does-not-exist')).toBeNull();
  });

  it('resolveSecret returns null when secret is empty string', () => {
    const descriptor = createSlackVendorDescriptor(
      buildDeps({
        lookupSlackConnection: () => ({ row: slackRow, signing_secret: '' }),
      }),
    );
    expect(descriptor.resolveSecret('slack-prod')).toBeNull();
  });

  it('verifySignature accepts a correctly-signed body in window', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const body = JSON.stringify({ type: 'event_callback', event: { type: 'message' } });
    const sig = signSlack(body, FROZEN_NOW_SEC, SIGNING_SECRET);
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: {
        'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
        'x-slack-signature': sig,
      },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SIGNING_SECRET)).toBe(true);
  });

  it('verifySignature rejects a tampered body', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const body = JSON.stringify({ type: 'event_callback', event: { type: 'message' } });
    const tampered = JSON.stringify({ type: 'event_callback', event: { type: 'tampered' } });
    const sig = signSlack(body, FROZEN_NOW_SEC, SIGNING_SECRET);
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: {
        'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
        'x-slack-signature': sig,
      },
      body: tampered,
    });
    expect(descriptor.verifySignature(req, Buffer.from(tampered, 'utf-8'), SIGNING_SECRET)).toBe(false);
  });

  it('verifySignature rejects a body signed under a different secret', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const body = JSON.stringify({ type: 'event_callback' });
    const sig = signSlack(body, FROZEN_NOW_SEC, 'different-secret');
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: {
        'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
        'x-slack-signature': sig,
      },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SIGNING_SECRET)).toBe(false);
  });

  it('verifySignature rejects when the timestamp header is missing', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const body = JSON.stringify({ type: 'event_callback' });
    const sig = signSlack(body, FROZEN_NOW_SEC, SIGNING_SECRET);
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: { 'x-slack-signature': sig },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SIGNING_SECRET)).toBe(false);
  });

  it('verifySignature rejects when the signature header is missing', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const body = JSON.stringify({ type: 'event_callback' });
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: { 'x-slack-request-timestamp': String(FROZEN_NOW_SEC) },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SIGNING_SECRET)).toBe(false);
  });

  it('verifySignature rejects when the timestamp is non-numeric', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const body = JSON.stringify({ type: 'event_callback' });
    const sig = signSlack(body, FROZEN_NOW_SEC, SIGNING_SECRET);
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: {
        'x-slack-request-timestamp': 'not-a-number',
        'x-slack-signature': sig,
      },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SIGNING_SECRET)).toBe(false);
  });

  it('verifySignature rejects when timestamp is outside the ±5-minute replay window', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const body = JSON.stringify({ type: 'event_callback' });
    const stale_ts = FROZEN_NOW_SEC - SLACK_REPLAY_WINDOW_SECONDS - 1;
    const sig = signSlack(body, stale_ts, SIGNING_SECRET);
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: {
        'x-slack-request-timestamp': String(stale_ts),
        'x-slack-signature': sig,
      },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SIGNING_SECRET)).toBe(false);
  });

  it('verifySignature rejects future timestamps outside the window', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const body = JSON.stringify({ type: 'event_callback' });
    const future_ts = FROZEN_NOW_SEC + SLACK_REPLAY_WINDOW_SECONDS + 1;
    const sig = signSlack(body, future_ts, SIGNING_SECRET);
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: {
        'x-slack-request-timestamp': String(future_ts),
        'x-slack-signature': sig,
      },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SIGNING_SECRET)).toBe(false);
  });

  it('verifySignature rejects when the signature lacks the v0= prefix', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const body = JSON.stringify({ type: 'event_callback' });
    const expected = createHmac('sha256', SIGNING_SECRET)
      .update(`v0:${FROZEN_NOW_SEC}:${body}`)
      .digest('hex');
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: {
        'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
        // No `v0=` prefix — Slack always emits one; missing-prefix
        // rejects to fail-closed.
        'x-slack-signature': expected,
      },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SIGNING_SECRET)).toBe(false);
  });

  it('extractEventId reads X-Slack-Event-Id header when present', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const body = JSON.stringify({ type: 'event_callback' });
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: { 'x-slack-event-id': 'Ev0123ABCD' },
      body,
    });
    expect(descriptor.extractEventId(req, Buffer.from(body, 'utf-8'))).toBe('Ev0123ABCD');
  });

  it('extractEventId falls back to envelope event_id when header absent', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev_envelope' });
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: {},
      body,
    });
    expect(descriptor.extractEventId(req, Buffer.from(body, 'utf-8'))).toBe('Ev_envelope');
  });

  it('extractEventId returns null on malformed JSON without header', () => {
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const body = '{not valid json';
    const req = buildReq({ url: '/webhooks/slack/slack-prod', headers: {}, body });
    expect(descriptor.extractEventId(req, Buffer.from(body, 'utf-8'))).toBeNull();
  });
});

describe('Slack provider — dispatch through webhook port', () => {
  it('responds to URL verification by echoing the challenge as JSON', async () => {
    const deps = buildDeps();
    const descriptor = createSlackVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { slack: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const challenge = 'verify-token-abc';
    const body = JSON.stringify({ type: 'url_verification', token: 'tok', challenge });
    const sig = signSlack(body, FROZEN_NOW_SEC, SIGNING_SECRET);

    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(res.body ?? 'null')).toEqual({ challenge });
    // URL verification must NOT reach the dispatcher — those events
    // are control plane, not engine ingest.
    expect(deps.dispatched).toHaveLength(0);
  });

  it('dispatches event_callback to the engine after signature verify', async () => {
    const deps = buildDeps();
    const descriptor = createSlackVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { slack: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev_dispatch_1',
      team_id: 'T_TEAM',
      event: { type: 'message', text: 'hi' },
    });
    const sig = signSlack(body, FROZEN_NOW_SEC, SIGNING_SECRET);

    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(deps.dispatched).toHaveLength(1);
    expect(deps.dispatched[0]).toMatchObject({
      connection_name: 'slack-prod',
      type: 'event_callback',
      event_id: 'Ev_dispatch_1',
      team_id: 'T_TEAM',
    });
  });

  it('rejects a tampered body with 401 + signature_invalid', async () => {
    const deps = buildDeps();
    const descriptor = createSlackVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { slack: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const original = JSON.stringify({ type: 'event_callback', event_id: 'Ev_ok' });
    const tampered = JSON.stringify({ type: 'event_callback', event_id: 'Ev_TAMPERED' });
    const sig = signSlack(original, FROZEN_NOW_SEC, SIGNING_SECRET);
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
          'x-slack-signature': sig,
        },
        body: tampered,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body ?? 'null')).toEqual({ error: { code: 'signature_invalid' } });
    expect(deps.dispatched).toHaveLength(0);
  });

  it('rejects a stale timestamp (replay window) with 401', async () => {
    const deps = buildDeps();
    const descriptor = createSlackVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { slack: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const stale_ts = FROZEN_NOW_SEC - SLACK_REPLAY_WINDOW_SECONDS - 10;
    const body = JSON.stringify({ type: 'event_callback' });
    const sig = signSlack(body, stale_ts, SIGNING_SECRET);
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(stale_ts),
          'x-slack-signature': sig,
        },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
    expect(deps.dispatched).toHaveLength(0);
  });

  it('returns generic 404 when the connection_name is unknown', async () => {
    const deps = buildDeps();
    const descriptor = createSlackVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { slack: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const body = JSON.stringify({ type: 'event_callback' });
    const sig = signSlack(body, FROZEN_NOW_SEC, SIGNING_SECRET);
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/does-not-exist',
        headers: {
          'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? 'null')).toEqual({ error: { code: 'not_found' } });
    expect(deps.dispatched).toHaveLength(0);
  });

  it('rejects malformed-JSON body after signature verify (502 dispatch_failed)', async () => {
    const deps = buildDeps();
    const descriptor = createSlackVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { slack: descriptor },
      ledger: createIdempotencyLedger(),
    });

    // Sign the malformed bytes — passes signature, fails parse.
    const body = '{not valid json';
    const sig = signSlack(body, FROZEN_NOW_SEC, SIGNING_SECRET);
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(502);
  });

  it('idempotency ledger dedupes a replayed event_id within window', async () => {
    const deps = buildDeps();
    const descriptor = createSlackVendorDescriptor(deps);
    const ledger = createIdempotencyLedger();
    const handler = createWebhookPortHandler({
      vendors: { slack: descriptor },
      ledger,
    });

    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev_dedup_1',
      event: { type: 'message' },
    });
    const sig = signSlack(body, FROZEN_NOW_SEC, SIGNING_SECRET);

    // First delivery — fresh.
    const r1 = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      r1 as unknown as ServerResponse,
    );
    expect(r1.statusCode).toBe(200);
    expect(JSON.parse(r1.body ?? 'null')).toEqual({ ok: true, deduped: false });

    // Second delivery — same event_id → deduped.
    const r2 = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      r2 as unknown as ServerResponse,
    );
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.body ?? 'null')).toEqual({ ok: true, deduped: true });
    // Dispatcher only fired once.
    expect(deps.dispatched).toHaveLength(1);
  });

  it('engine dispatch failure surfaces as 502', async () => {
    const deps = buildDeps({
      dispatchEvent: vi.fn().mockRejectedValue(new Error('engine boom')),
    });
    const descriptor = createSlackVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { slack: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev_fail' });
    const sig = signSlack(body, FROZEN_NOW_SEC, SIGNING_SECRET);
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(502);
  });
});

describe('Slack signing_secret is registered as an inbound-secret field', () => {
  it('signing_secret appears in CONNECTION_INBOUND_SECRET_FIELDS', () => {
    expect(CONNECTION_INBOUND_SECRET_FIELDS).toContain('signing_secret');
  });
});

describe('Codex P9 fold-back', () => {
  it('fold #1 — verifySignature uses the literal ts header value (leading-zero stable)', () => {
    // Sign a body with a literal `ts` containing a leading zero. The
    // canonical HMAC source MUST use the literal header value
    // (`'01730000000'`), not the parsed integer (`1730000000`). If the
    // verifier re-stringifies, the recomputed digest diverges from
    // Slack's signed digest and verification fails — even though the
    // integer values match.
    const ts_literal = '01730000000';
    const ts_num = 1_730_000_000;
    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev_lz' });
    // Slack's HMAC over `v0:01730000000:<body>` — note the leading zero
    // is preserved in the canonical bytes Slack signs.
    const sig = `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${ts_literal}:${body}`).digest('hex')}`;

    const descriptor = createSlackVendorDescriptor(
      buildDeps({ now: () => ts_num * 1000 }),
    );
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: {
        'x-slack-request-timestamp': ts_literal,
        'x-slack-signature': sig,
      },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SIGNING_SECRET)).toBe(true);
  });

  it('fold #2 — verifySignature signs over raw body bytes (not utf-8 round-trip)', () => {
    // Construct a body containing a byte sequence that's NOT valid
    // UTF-8 (a lone continuation byte 0x80). `Buffer.toString("utf-8")`
    // would replace it with U+FFFD; HMAC-ing the decoded string would
    // differ from HMAC-ing the raw bytes Slack signed. Real Slack
    // bodies are valid UTF-8, but this is the canonical correctness
    // assertion — the verifier MUST sign over the raw buffer.
    const rawBody = Buffer.concat([
      Buffer.from('{"type":"event_callback","junk":"', 'utf-8'),
      Buffer.from([0x80, 0x80, 0x80]),
      Buffer.from('"}', 'utf-8'),
    ]);
    const sig = `v0=${createHmac('sha256', SIGNING_SECRET)
      .update(`v0:${FROZEN_NOW_SEC}:`)
      .update(rawBody)
      .digest('hex')}`;
    const descriptor = createSlackVendorDescriptor(buildDeps());
    const req = buildReq({
      url: '/webhooks/slack/slack-prod',
      headers: {
        'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
        'x-slack-signature': sig,
      },
      body: rawBody.toString('binary'),
    });
    expect(descriptor.verifySignature(req, rawBody, SIGNING_SECRET)).toBe(true);
  });

  it('fold #4 — URL verification skips dedup ledger so re-verification still echoes the challenge', async () => {
    const deps = buildDeps();
    const descriptor = createSlackVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { slack: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const challenge = 'verify-token-reissue';
    const body = JSON.stringify({ type: 'url_verification', token: 'tok', challenge });
    const sig = signSlack(body, FROZEN_NOW_SEC, SIGNING_SECRET);

    // First verification succeeds.
    const r1 = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      r1 as unknown as ServerResponse,
    );
    expect(r1.statusCode).toBe(200);
    expect(JSON.parse(r1.body ?? 'null')).toEqual({ challenge });

    // Second verification with IDENTICAL challenge bytes (Slack
    // workspace-reconnect scenario) MUST echo the challenge again,
    // not return `{deduped: true}`.
    const r2 = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      r2 as unknown as ServerResponse,
    );
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.body ?? 'null')).toEqual({ challenge });
    // Engine dispatcher still saw zero events.
    expect(deps.dispatched).toHaveLength(0);
  });

  it('fold #4 — non-url_verification events still flow through dedup', async () => {
    const deps = buildDeps();
    const descriptor = createSlackVendorDescriptor(deps);
    const ledger = createIdempotencyLedger();
    const handler = createWebhookPortHandler({
      vendors: { slack: descriptor },
      ledger,
    });

    const body = JSON.stringify({
      type: 'event_callback',
      event_id: 'Ev_dedup_post_fold',
    });
    const sig = signSlack(body, FROZEN_NOW_SEC, SIGNING_SECRET);
    const r1 = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      r1 as unknown as ServerResponse,
    );
    expect(JSON.parse(r1.body ?? 'null')).toEqual({ ok: true, deduped: false });

    const r2 = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/slack/slack-prod',
        headers: {
          'x-slack-request-timestamp': String(FROZEN_NOW_SEC),
          'x-slack-signature': sig,
        },
        body,
      }),
      r2 as unknown as ServerResponse,
    );
    expect(JSON.parse(r2.body ?? 'null')).toEqual({ ok: true, deduped: true });
    expect(deps.dispatched).toHaveLength(1);
  });
});
