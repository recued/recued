/** D-125 Phase 4.3 — connection.notification per-kind handler tests.
 *
 *  Pins the wire-construction + subtype-dispatch + auth-injection +
 *  bus-emit + bytes-telemetry contract for `kind: 'connection' +
 *  connection_kind: 'notification'` ingredients (spec § 4.3):
 *
 *    1. Subtype dispatch:
 *       - slack    → POST chat.postMessage with bearer auth.
 *       - telegram → POST api.telegram.org/bot<token>/sendMessage.
 *       - in-app   → broadcast bus emit (no HTTP).
 *       - email    → mailRpc.send façade (D-127 P3.1); when mailRpc
 *                    is unwired, surfaces NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED.
 *    2. Subtype derivation: row.subtype wins over config.subtype
 *       (legacy fallback for pre-stamp enrollments).
 *    3. Top-level input: 'text' required + non-empty across all
 *       subtypes; subtype-specific fields validated lazily inside the
 *       branch.
 *    4. Slack: title prefixes text; link_url appended; recipient
 *       overrides config.channel_id; ok=false → status: 'send_error'
 *       with vendor: 'slack' + error tail; bearer-only auth (other
 *       auth types → IOVF).
 *    5. Telegram: title double-newline; link_url appended; chat_id
 *       from config or recipient override; numeric chat_id accepted;
 *       ok=false → status: 'send_error' with vendor: 'telegram' +
 *       description tail.
 *    6. In-app: emitInApp called with {text, title?, link_url?};
 *       no fetch made; no auth decoded; missing emitInApp →
 *       NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED.
 *    7. HTTP error classification (slack + telegram):
 *       401/403 → OAUTH_EXPIRED; 429 → API_RATE_LIMITED;
 *       5xx read → NETWORK_ERROR; 5xx write → ACTION_DELIVERY_UNCERTAIN;
 *       other 4xx → NETWORK_ERROR; abort → STEP_TIMEOUT (read) /
 *       ACTION_DELIVERY_UNCERTAIN (write).
 *    8. Bytes telemetry: ctx.setBytes called for slack/telegram with
 *       request body length + response length; in-app sets bytes_in=0
 *       + bytes_out = JSON-stringified body length; email never
 *       reaches the telemetry hook (throws first).
 *    9. Email subtype no-mailRpc fallback: throws
 *       NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED with subtype: 'email'.
 *       Wired-path coverage moved to D-127 P3.1 test file.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ConnectionAuth, ConnectionRow } from '@recued/contracts';
import {
  createConnectionNotificationHandler,
} from '../connection-notification.js';
import type { ConnectionNotificationHandlerDeps, NotificationBusBody } from '../connection-notification.js';
import { IngredientError, type ResolvedCall } from '../types.js';
import type { ConnectionHandlerCtx } from '../connection.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

const mkRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => ({
  pk: `${overrides.kind ?? 'notification'}:${overrides.name ?? 'team-slack'}`,
  kind: overrides.kind ?? 'notification',
  name: overrides.name ?? 'team-slack',
  display_name: overrides.display_name ?? 'Team Slack',
  config_json: overrides.config_json ?? '{"channel_id":"C0123456"}',
  auth_ciphertext: overrides.auth_ciphertext ?? 'opaque-blob',
  enrolled_at: overrides.enrolled_at ?? 1_700_000_000_000,
  updated_at: overrides.updated_at ?? 1_700_000_000_000,
  subtype: overrides.subtype ?? 'slack',
  ...(overrides.publisher_id !== undefined ? { publisher_id: overrides.publisher_id } : {}),
  ...(overrides.last_used_at !== undefined ? { last_used_at: overrides.last_used_at } : {}),
  ...(overrides.health_json !== undefined ? { health_json: overrides.health_json } : {}),
});

const mkCall = (overrides: Partial<ResolvedCall> = {}): ResolvedCall => ({
  slug: overrides.slug ?? 'connection',
  risk_tier: overrides.risk_tier ?? 'write',
  input: overrides.input ?? {},
  output: overrides.output ?? {},
  ...(overrides.fallback ? { fallback: overrides.fallback } : {}),
});

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

const captureFetch = (
  responder: (call: FetchCall) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => { headers[k] = v; });
    }
    const captured: FetchCall = {
      url: typeof input === 'string' ? input : input.toString(),
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: init?.body == null ? undefined : String(init.body),
    };
    calls.push(captured);
    return responder(captured);
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
};

const okJson = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const mkCtx = (): { ctx: ConnectionHandlerCtx; bytesIn?: number; bytesOut?: number } => {
  const state: { ctx: ConnectionHandlerCtx; bytesIn?: number; bytesOut?: number } = {
    ctx: {
      setBytes(bytes_in, bytes_out) {
        state.bytesIn = bytes_in;
        state.bytesOut = bytes_out;
      },
    },
  };
  return state;
};

const slackBearer: ConnectionAuth = { type: 'bearer', token: 'xoxb-1-2-3' };
const telegramBearer: ConnectionAuth = { type: 'bearer', token: 'BOT-TOKEN' };

const mkDeps = (
  overrides: Partial<ConnectionNotificationHandlerDeps> = {},
): ConnectionNotificationHandlerDeps => ({
  decodeAuth: overrides.decodeAuth
    ?? vi.fn(async () => slackBearer),
  ...(overrides.emitInApp ? { emitInApp: overrides.emitInApp } : {}),
  ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
  ...(overrides.now ? { now: overrides.now } : {}),
});

// ────────────────────────────────────────────────────────────────
// Subtype derivation
// ────────────────────────────────────────────────────────────────

describe('D-125 P4.3 — subtype derivation', () => {
  it('row.subtype wins over config.subtype', async () => {
    const { fetch } = captureFetch(() => okJson({ ok: true, ts: '1.1', channel: 'C1' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    const row = mkRow({
      subtype: 'slack',
      config_json: JSON.stringify({ channel_id: 'C1', subtype: 'telegram' }),
    });
    const result = await handler(row, { text: 'hi' }, mkCall());
    expect((result as { status: string }).status).toBe('ok');
  });

  it('falls back to config.subtype when row.subtype is missing', async () => {
    const { fetch } = captureFetch(() => okJson({ ok: true, ts: '1.1' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    const row = mkRow({
      config_json: JSON.stringify({ channel_id: 'C1', subtype: 'slack' }),
    });
    delete (row as { subtype?: string }).subtype;
    const result = await handler(row, { text: 'hi' }, mkCall());
    expect((result as { status: string }).status).toBe('ok');
  });

  it('throws IOVF when neither row.subtype nor config.subtype is set', async () => {
    const handler = createConnectionNotificationHandler(mkDeps({}));
    const row = mkRow({ config_json: '{"channel_id":"C1"}' });
    delete (row as { subtype?: string }).subtype;
    await expect(handler(row, { text: 'hi' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF on unknown subtype', async () => {
    const handler = createConnectionNotificationHandler(mkDeps({}));
    const row = mkRow({ subtype: 'sms-not-real' });
    await expect(handler(row, { text: 'hi' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });
});

// ────────────────────────────────────────────────────────────────
// Top-level input validation
// ────────────────────────────────────────────────────────────────

describe('D-125 P4.3 — top-level input validation', () => {
  it('throws IOVF when text is missing', async () => {
    const handler = createConnectionNotificationHandler(mkDeps());
    await expect(handler(mkRow(), {}, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF when text is empty / whitespace-only', async () => {
    const handler = createConnectionNotificationHandler(mkDeps());
    await expect(handler(mkRow(), { text: '   ' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws IOVF when text is not a string', async () => {
    const handler = createConnectionNotificationHandler(mkDeps());
    await expect(handler(mkRow(), { text: 42 }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });
});

// ────────────────────────────────────────────────────────────────
// Slack subtype
// ────────────────────────────────────────────────────────────────

describe('D-125 P4.3 — slack subtype', () => {
  it('POSTs chat.postMessage with bearer auth and channel from config', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ ok: true, ts: '12345.67', channel: 'C0123456' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    const result = await handler(mkRow(), { text: 'Build green' }, mkCall());
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.authorization).toBe('Bearer xoxb-1-2-3');
    expect(calls[0].headers['content-type']).toContain('application/json');
    const body = JSON.parse(calls[0].body!);
    expect(body.channel).toBe('C0123456');
    expect(body.text).toBe('Build green');
    expect(result).toMatchObject({
      status: 'ok',
      result: { ts: '12345.67', channel: 'C0123456' },
      headers: undefined,
    });
  });

  it('prefixes title with bold markdown when set', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ ok: true, ts: '1' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    await handler(mkRow(), { text: 'body', title: 'Heading' }, mkCall());
    const body = JSON.parse(calls[0].body!);
    expect(body.text).toBe('*Heading*\nbody');
  });

  it('appends link_url on its own line', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ ok: true, ts: '1' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    await handler(mkRow(), {
      text: 'body',
      title: 'Heading',
      link_url: 'https://example.com/x',
    }, mkCall());
    const body = JSON.parse(calls[0].body!);
    expect(body.text).toBe('*Heading*\nbody\nhttps://example.com/x');
  });

  it('recipient param overrides config.channel_id', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ ok: true, ts: '1' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    await handler(mkRow(), { text: 'hi', recipient: '#alerts-prod' }, mkCall());
    const body = JSON.parse(calls[0].body!);
    expect(body.channel).toBe('#alerts-prod');
  });

  it('vendor ok:false maps to status: send_error', async () => {
    const { fetch } = captureFetch(() => okJson({ ok: false, error: 'channel_not_found' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    const result = await handler(mkRow(), { text: 'hi' }, mkCall());
    expect(result).toMatchObject({
      status: 'send_error',
      result: {
        vendor: 'slack',
        error: 'channel_not_found',
      },
      headers: undefined,
    });
  });

  it('rejects non-bearer auth with IOVF', async () => {
    const handler = createConnectionNotificationHandler(mkDeps({
      decodeAuth: async () => ({ type: 'basic', username: 'u', password: 'p' }) as ConnectionAuth,
    }));
    await expect(handler(mkRow(), { text: 'hi' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('rejects bearer auth missing token before dispatch', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ ok: true }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => ({ type: 'bearer' }) as unknown as ConnectionAuth,
    }));
    await expect(handler(mkRow(), { text: 'hi' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
  });

  it('throws IOVF when no channel_id in config and no recipient', async () => {
    const handler = createConnectionNotificationHandler(mkDeps({
      decodeAuth: async () => slackBearer,
    }));
    const row = mkRow({ config_json: '{}' });
    await expect(handler(row, { text: 'hi' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('throws OAUTH_EXPIRED on 401', async () => {
    const { fetch } = captureFetch(() => new Response('unauthorized', { status: 401 }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    await expect(handler(mkRow(), { text: 'hi' }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'OAUTH_EXPIRED' });
  });

  it('throws API_RATE_LIMITED on 429', async () => {
    const { fetch } = captureFetch(() => new Response('rate', { status: 429 }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    await expect(handler(mkRow(), { text: 'hi' }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'API_RATE_LIMITED' });
  });

  it('write-tier 5xx maps to ACTION_DELIVERY_UNCERTAIN', async () => {
    const { fetch } = captureFetch(() => new Response('boom', { status: 503 }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    await expect(handler(mkRow(), { text: 'hi' }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('read-tier 5xx maps to NETWORK_ERROR', async () => {
    const { fetch } = captureFetch(() => new Response('boom', { status: 503 }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    await expect(handler(mkRow(), { text: 'hi' }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('write-tier abort maps to ACTION_DELIVERY_UNCERTAIN', async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      throw new Error('unreachable');
    }) as unknown as typeof fetch;
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl,
      decodeAuth: async () => slackBearer,
    }));
    await expect(handler(mkRow(), { text: 'hi', timeout_ms: 10 }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });

  it('read-tier abort maps to STEP_TIMEOUT', async () => {
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      throw new Error('unreachable');
    }) as unknown as typeof fetch;
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl,
      decodeAuth: async () => slackBearer,
    }));
    await expect(handler(mkRow(), { text: 'hi', timeout_ms: 10 }, mkCall({ risk_tier: 'read' })))
      .rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
  });

  it('malformed response JSON throws NETWORK_ERROR', async () => {
    const { fetch } = captureFetch(() =>
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    await expect(handler(mkRow(), { text: 'hi' }, mkCall()))
      .rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
});

// ────────────────────────────────────────────────────────────────
// Telegram subtype
// ────────────────────────────────────────────────────────────────

describe('D-125 P4.3 — telegram subtype', () => {
  const tgRow = (overrides: Partial<ConnectionRow> = {}): ConnectionRow => mkRow({
    subtype: 'telegram',
    name: 'oncall-bot',
    config_json: '{"chat_id":-1001234567890}',
    ...overrides,
  });

  it('POSTs to api.telegram.org with token in URL path', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ ok: true, result: { message_id: 42 } }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => telegramBearer,
    }));
    const result = await handler(tgRow(), { text: 'Build green' }, mkCall());
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://api.telegram.org/botBOT-TOKEN/sendMessage');
    expect(calls[0].method).toBe('POST');
    // Telegram doesn't take Authorization header — token is in path.
    expect(calls[0].headers.authorization).toBeUndefined();
    const body = JSON.parse(calls[0].body!);
    expect(body.chat_id).toBe(-1001234567890);
    expect(body.text).toBe('Build green');
    expect(result).toMatchObject({
      status: 'ok',
      result: { message_id: 42 },
      headers: undefined,
    });
  });

  it('formats title with double-newline separator', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ ok: true, result: { message_id: 1 } }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => telegramBearer,
    }));
    await handler(tgRow(), { text: 'body', title: 'Heading' }, mkCall());
    const body = JSON.parse(calls[0].body!);
    expect(body.text).toBe('Heading\n\nbody');
  });

  it('appends link_url on its own line', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ ok: true, result: { message_id: 1 } }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => telegramBearer,
    }));
    await handler(tgRow(), { text: 'body', link_url: 'https://x.io' }, mkCall());
    const body = JSON.parse(calls[0].body!);
    expect(body.text).toBe('body\nhttps://x.io');
  });

  it('recipient param overrides config.chat_id', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ ok: true, result: { message_id: 1 } }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => telegramBearer,
    }));
    await handler(tgRow(), { text: 'hi', recipient: '@alerts' }, mkCall());
    const body = JSON.parse(calls[0].body!);
    expect(body.chat_id).toBe('@alerts');
  });

  it('numeric recipient is coerced to string', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ ok: true, result: { message_id: 1 } }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => telegramBearer,
    }));
    await handler(tgRow({ config_json: '{}' }), { text: 'hi', recipient: 12345 }, mkCall());
    const body = JSON.parse(calls[0].body!);
    expect(body.chat_id).toBe('12345');
  });

  it('vendor ok:false maps to status: send_error with description tail', async () => {
    const { fetch } = captureFetch(() => okJson({ ok: false, description: 'chat not found', error_code: 400 }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => telegramBearer,
    }));
    const result = await handler(tgRow(), { text: 'hi' }, mkCall());
    expect(result).toMatchObject({
      status: 'send_error',
      result: {
        vendor: 'telegram',
        error: 'chat not found',
      },
      headers: undefined,
    });
  });

  it('throws IOVF when no chat_id in config and no recipient', async () => {
    const handler = createConnectionNotificationHandler(mkDeps({
      decodeAuth: async () => telegramBearer,
    }));
    const row = tgRow({ config_json: '{}' });
    await expect(handler(row, { text: 'hi' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('rejects non-bearer auth with IOVF', async () => {
    const handler = createConnectionNotificationHandler(mkDeps({
      decodeAuth: async () => ({ type: 'none' }) as ConnectionAuth,
    }));
    await expect(handler(tgRow(), { text: 'hi' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
  });

  it('rejects bearer auth missing token before dispatch', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ ok: true }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => ({ type: 'bearer' }) as unknown as ConnectionAuth,
    }));
    await expect(handler(tgRow(), { text: 'hi' }, mkCall()))
      .rejects.toMatchObject({ code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED' });
    expect(calls).toHaveLength(0);
  });

  it('write-tier 5xx maps to ACTION_DELIVERY_UNCERTAIN', async () => {
    const { fetch } = captureFetch(() => new Response('boom', { status: 502 }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => telegramBearer,
    }));
    await expect(handler(tgRow(), { text: 'hi' }, mkCall({ risk_tier: 'write' })))
      .rejects.toMatchObject({ code: 'ACTION_DELIVERY_UNCERTAIN' });
  });
});

// ────────────────────────────────────────────────────────────────
// Discord subtype (D-192 — roles.notification:true, so it MUST deliver)
// ────────────────────────────────────────────────────────────────

describe('D-192 — discord subtype', () => {
  const discordBearer: ConnectionAuth = { type: 'bearer', token: 'BOT-abc' };
  const discordRow = (): ConnectionRow => mkRow({
    name: 'my-discord',
    subtype: 'discord',
    config_json: JSON.stringify({ channel_id: '123456789012345678' }),
  });

  it('POSTs to the channel-messages API with the Bot (not Bearer) scheme', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ id: '999' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => discordBearer,
    }));
    const result = await handler(discordRow(), { text: 'Build green' }, mkCall());
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      'https://discord.com/api/v10/channels/123456789012345678/messages',
    );
    expect(calls[0].method).toBe('POST');
    // ⚠ `Bot `, NOT `Bearer ` — the load-bearing distinction for Discord.
    expect(calls[0].headers.authorization).toBe('Bot BOT-abc');
    const body = JSON.parse(calls[0].body!);
    expect(body.content).toBe('Build green');
    expect(result).toMatchObject({ status: 'ok', result: { id: '999' } });
  });

  it('composes a bold title heading, body, and link on its own line', async () => {
    const { fetch, calls } = captureFetch(() => okJson({ id: '1' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => discordBearer,
    }));
    await handler(discordRow(), {
      text: 'body',
      title: 'Heading',
      link_url: 'https://example.com/x',
    }, mkCall());
    const body = JSON.parse(calls[0].body!);
    expect(body.content).toBe('**Heading**\nbody\nhttps://example.com/x');
  });
});

// ────────────────────────────────────────────────────────────────
// Fail-closed dispatch (D-192 — no declared subtype may silently no-op)
// ────────────────────────────────────────────────────────────────

describe('D-192 — dispatch is fail-closed for a non-delivery subtype', () => {
  it('whatsapp (roles.notification:false) throws LOUD, never a silent undefined', async () => {
    // WhatsApp is a valid NotificationSubtype (it enrolls as a messenger
    // connection) but declares roles.notification:false — Meta's 24h window
    // forbids the unprompted send `notification.send` is. Before D-192 it fell
    // through the switch to an implicit `undefined` (green-but-mute); it must now
    // fail with a clear error so the gap is visible, not silent.
    const { fetch } = captureFetch(() => okJson({ id: '1' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => ({ type: 'bearer', token: 't' }),
    }));
    const row = mkRow({ subtype: 'whatsapp', config_json: '{"channel_id":"x"}' });
    await expect(handler(row, { text: 'hi' }, mkCall())).rejects.toMatchObject({
      code: 'INGREDIENT_OUTPUT_VALIDATION_FAILED',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// In-app subtype
// ────────────────────────────────────────────────────────────────

describe('D-125 P4.3 — in-app subtype', () => {
  const inAppRow = (): ConnectionRow => mkRow({
    subtype: 'in-app',
    name: 'self',
    config_json: '{}',
  });

  it('emits via emitInApp callback with text only', async () => {
    const emits: NotificationBusBody[] = [];
    const handler = createConnectionNotificationHandler(mkDeps({
      emitInApp: (body) => { emits.push(body); },
      decodeAuth: vi.fn(),
    }));
    const result = await handler(inAppRow(), { text: 'hello' }, mkCall());
    expect(emits.length).toBe(1);
    expect(emits[0]).toEqual({ text: 'hello' });
    expect(result).toMatchObject({
      status: 'ok',
      result: undefined,
      headers: undefined,
    });
  });

  it('emits with title + link_url when provided', async () => {
    const emits: NotificationBusBody[] = [];
    const handler = createConnectionNotificationHandler(mkDeps({
      emitInApp: (body) => { emits.push(body); },
      decodeAuth: vi.fn(),
    }));
    await handler(inAppRow(), {
      text: 'body',
      title: 'Heading',
      link_url: 'https://example.com/x',
    }, mkCall());
    expect(emits[0]).toEqual({
      text: 'body',
      title: 'Heading',
      link_url: 'https://example.com/x',
    });
  });

  it('does NOT decode auth (no creds for in-app)', async () => {
    const decodeAuth = vi.fn();
    const handler = createConnectionNotificationHandler({
      decodeAuth,
      emitInApp: () => {},
    });
    await handler(inAppRow(), { text: 'hi' }, mkCall());
    expect(decodeAuth).not.toHaveBeenCalled();
  });

  it('does NOT call fetch (in-app is in-process bus)', async () => {
    const fetchImpl = vi.fn();
    const handler = createConnectionNotificationHandler({
      decodeAuth: vi.fn(),
      emitInApp: () => {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await handler(inAppRow(), { text: 'hi' }, mkCall());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED when emitInApp is not wired', async () => {
    const handler = createConnectionNotificationHandler({
      decodeAuth: vi.fn(),
      // no emitInApp
    });
    await expect(handler(inAppRow(), { text: 'hi' }, mkCall()))
      .rejects.toMatchObject({ code: 'NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED' });
  });
});

// ────────────────────────────────────────────────────────────────
// Email subtype — no-mailRpc fallback
// ────────────────────────────────────────────────────────────────
// D-127 P3.1 graduated the email subtype to a real handler that
// dispatches via `deps.mailRpc`. When no `mailRpc` is wired (dbless /
// ext-side / pre-pair harness) the handler still surfaces a clean
// `NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED` so the diagnostic stays
// recognizable in environments where mail isn't reachable.
//
// The wired-path coverage (subtype dispatch, default_recipient,
// sender ≠ to propagation, body / text fallback, body_format=html,
// CONNECTION_NOT_BOUND on missing config) lives in
// d-127-phase-3-1-connection-notification-email.test.ts.

describe('D-125 P4.3 — email subtype (no-mailRpc fallback)', () => {
  it('throws NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED with subtype: email', async () => {
    const handler = createConnectionNotificationHandler(mkDeps({
      decodeAuth: vi.fn(),
    }));
    const row = mkRow({
      subtype: 'email',
      name: 'gmail',
      config_json: '{"host":"smtp.example","port":587,"from_address":"me@x"}',
    });
    let caught: unknown;
    try {
      await handler(row, { text: 'hi' }, mkCall());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(IngredientError);
    expect((caught as IngredientError).code).toBe('NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED');
    expect((caught as IngredientError).details?.subtype).toBe('email');
  });

  it('does NOT decode auth before throwing', async () => {
    const decodeAuth = vi.fn();
    const handler = createConnectionNotificationHandler({
      decodeAuth,
    });
    const row = mkRow({ subtype: 'email', config_json: '{}' });
    await expect(handler(row, { text: 'hi' }, mkCall()))
      .rejects.toMatchObject({ code: 'NOTIFICATION_TRANSPORT_NOT_IMPLEMENTED' });
    expect(decodeAuth).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────
// Bytes telemetry
// ────────────────────────────────────────────────────────────────

describe('D-125 P4.3 — bytes telemetry', () => {
  it('slack: ctx.setBytes called with request body length + response length', async () => {
    const { fetch } = captureFetch(() => okJson({ ok: true, ts: '1', channel: 'C' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    const ctxState = mkCtx();
    await handler(mkRow(), { text: 'hello' }, mkCall(), ctxState.ctx);
    expect(ctxState.bytesIn).toBeGreaterThan(0);
    expect(ctxState.bytesOut).toBeGreaterThan(0);
    // Body should match what we POSTed.
    const expectedOut = new TextEncoder().encode(
      JSON.stringify({ channel: 'C0123456', text: 'hello' }),
    ).byteLength;
    expect(ctxState.bytesOut).toBe(expectedOut);
  });

  it('telegram: ctx.setBytes called with request body length + response length', async () => {
    const { fetch } = captureFetch(() => okJson({ ok: true, result: { message_id: 1 } }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => telegramBearer,
    }));
    const ctxState = mkCtx();
    const row = mkRow({
      subtype: 'telegram',
      config_json: '{"chat_id":42}',
    });
    await handler(row, { text: 'hi' }, mkCall(), ctxState.ctx);
    expect(ctxState.bytesIn).toBeGreaterThan(0);
    expect(ctxState.bytesOut).toBeGreaterThan(0);
  });

  it('in-app: bytes_in is 0, bytes_out is JSON-stringified body length', async () => {
    const handler = createConnectionNotificationHandler(mkDeps({
      emitInApp: () => {},
      decodeAuth: vi.fn(),
    }));
    const ctxState = mkCtx();
    const row = mkRow({ subtype: 'in-app', config_json: '{}' });
    await handler(row, { text: 'hi', title: 'T' }, mkCall(), ctxState.ctx);
    expect(ctxState.bytesIn).toBe(0);
    const expectedOut = new TextEncoder().encode(
      JSON.stringify({ text: 'hi', title: 'T' }),
    ).byteLength;
    expect(ctxState.bytesOut).toBe(expectedOut);
  });

  it('email (no mailRpc): ctx not invoked (throws first)', async () => {
    const handler = createConnectionNotificationHandler(mkDeps({
      decodeAuth: vi.fn(),
    }));
    const ctxState = mkCtx();
    const row = mkRow({ subtype: 'email', config_json: '{}' });
    await expect(handler(row, { text: 'hi' }, mkCall(), ctxState.ctx)).rejects.toThrow();
    expect(ctxState.bytesIn).toBeUndefined();
    expect(ctxState.bytesOut).toBeUndefined();
  });

  it('handler signature stays backward-compat with 3-arg stubs', async () => {
    // Mirror P4.2's pinned invariant: a handler invoked without ctx
    // (P3.x test stubs) must keep working — JS ignores extra positional
    // args but we want to pin the "ctx is optional" contract here too.
    const { fetch } = captureFetch(() => okJson({ ok: true, ts: '1' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    // Call without ctx — must succeed.
    const result = await handler(mkRow(), { text: 'hi' }, mkCall());
    expect((result as { status: string }).status).toBe('ok');
  });
});

// ────────────────────────────────────────────────────────────────
// Adapter integration smoke (handler under createConnectionAdapter)
// ────────────────────────────────────────────────────────────────

describe('D-125 P4.3 — adapter integration', () => {
  it('round-trips through createConnectionAdapter for slack subtype', async () => {
    const { createConnectionAdapter } = await import('../connection.js');
    const { fetch } = captureFetch(() => okJson({ ok: true, ts: '1', channel: 'C' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    const row = mkRow();
    const adapter = createConnectionAdapter({
      store: { get: () => row },
      handlers: { notification: handler },
    });
    const result = await adapter(mkCall({
      slug: 'slack-post',
      input: {
        connection_kind: 'notification',
        connection: 'team-slack',
        text: 'hi',
      },
    }));
    expect((result as { status: string }).status).toBe('ok');
  });

  it('round-trips through createConnectionAdapter for in-app subtype', async () => {
    const { createConnectionAdapter } = await import('../connection.js');
    const emits: NotificationBusBody[] = [];
    const handler = createConnectionNotificationHandler({
      decodeAuth: vi.fn(),
      emitInApp: (body) => { emits.push(body); },
    });
    const row = mkRow({
      subtype: 'in-app',
      name: 'self',
      config_json: '{}',
    });
    const adapter = createConnectionAdapter({
      store: { get: () => row },
      handlers: { notification: handler },
    });
    const result = await adapter(mkCall({
      slug: 'notification-in-app',
      input: {
        connection_kind: 'notification',
        connection: 'self',
        text: 'banner',
      },
    }));
    expect((result as { status: string }).status).toBe('ok');
    expect(emits[0]).toEqual({ text: 'banner' });
  });

  it('audit emission carries subtype + status: ok', async () => {
    const { createConnectionAdapter } = await import('../connection.js');
    const { fetch } = captureFetch(() => okJson({ ok: true, ts: '1', channel: 'C' }));
    const handler = createConnectionNotificationHandler(mkDeps({
      fetchImpl: fetch,
      decodeAuth: async () => slackBearer,
    }));
    const row = mkRow();
    const emissions: unknown[] = [];
    const adapter = createConnectionAdapter({
      store: { get: () => row },
      handlers: { notification: handler },
      emitAudit: (e) => { emissions.push(e); },
    });
    await adapter(mkCall({
      slug: 'slack-post',
      input: {
        connection_kind: 'notification',
        connection: 'team-slack',
        text: 'hi',
      },
    }));
    expect(emissions.length).toBe(1);
    expect(emissions[0]).toMatchObject({
      kind: 'notification',
      name: 'team-slack',
      subtype: 'slack',
      status: 'ok',
    });
  });
});
