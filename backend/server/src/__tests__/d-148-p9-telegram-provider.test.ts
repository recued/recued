/** D-148 P9 § A.13 — Telegram bot updates webhook provider tests.
 *
 *  Coverage:
 *    - Path prefix + connection-name resolution.
 *    - `X-Telegram-Bot-Api-Secret-Token` header verification (correct
 *      / wrong / missing / length-mismatch / case-sensitive).
 *    - Engine dispatch on bot updates.
 *    - Connection lookup miss → null secret.
 *    - End-to-end dispatch through `createWebhookPortHandler`.
 *    - `setWebhook` happy path.
 *    - `setWebhook` rejects non-Telegram-supported ports with
 *      `telegram_port_unsupported`.
 *    - `setWebhook` propagates Telegram API failures.
 *    - `webhook_secret` is a registered inbound-secret field. */

import { describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CONNECTION_INBOUND_SECRET_FIELDS,
  TELEGRAM_SUPPORTED_PORTS,
  type ConnectionRow,
} from '@recued/contracts';
import { createWebhookPortHandler } from '../ports/webhook/handler.js';
import { createIdempotencyLedger } from '../ports/webhook/idempotency-ledger.js';
import {
  createTelegramVendorDescriptor,
  setTelegramWebhook,
  TELEGRAM_SECRET_HEADER,
  type TelegramInboundUpdate,
  type TelegramProviderDeps,
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

const SECRET_TOKEN = 'tg-secret-token-fixture-1234567890';

const tgRow: ConnectionRow = {
  pk: 'notification:tg-prod',
  kind: 'notification',
  name: 'tg-prod',
  subtype: 'telegram',
  display_name: 'Telegram — Production Bot',
  config_json: JSON.stringify({ chat_id: '789', webhook_secret: SECRET_TOKEN }),
  auth_ciphertext: '',
  enrolled_at: 1_000,
  updated_at: 2_000,
};

const buildDeps = (
  overrides: Partial<TelegramProviderDeps> = {},
): TelegramProviderDeps & { dispatched: TelegramInboundUpdate[] } => {
  const dispatched: TelegramInboundUpdate[] = [];
  const deps: TelegramProviderDeps & { dispatched: TelegramInboundUpdate[] } = {
    lookupTelegramConnection: (name) =>
      name === tgRow.name ? { row: tgRow, secret_token: SECRET_TOKEN } : null,
    dispatchEvent: async (e) => {
      dispatched.push(e);
    },
    dispatched,
    ...overrides,
  };
  return deps;
};

describe('createTelegramVendorDescriptor', () => {
  it('exposes path_prefix /webhooks/telegram/', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    expect(descriptor.path_prefix).toBe('/webhooks/telegram/');
  });

  it('TELEGRAM_SECRET_HEADER is the lowercased canonical header', () => {
    expect(TELEGRAM_SECRET_HEADER).toBe('x-telegram-bot-api-secret-token');
  });

  it('resolveSecret returns the connection secret_token', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    expect(descriptor.resolveSecret('tg-prod')).toBe(SECRET_TOKEN);
  });

  it('resolveSecret returns null for unknown connection', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    expect(descriptor.resolveSecret('does-not-exist')).toBeNull();
  });

  it('resolveSecret returns null when secret_token is empty string', () => {
    const descriptor = createTelegramVendorDescriptor(
      buildDeps({
        lookupTelegramConnection: () => ({ row: tgRow, secret_token: '' }),
      }),
    );
    expect(descriptor.resolveSecret('tg-prod')).toBeNull();
  });

  it('resolveSecret rejects tokens outside Telegram setWebhook grammar', () => {
    for (const secret_token of ['contains spaces', 'a'.repeat(257)]) {
      const descriptor = createTelegramVendorDescriptor(
        buildDeps({
          lookupTelegramConnection: () => ({ row: tgRow, secret_token }),
        }),
      );
      expect(descriptor.resolveSecret('tg-prod')).toBeNull();
    }
  });

  it('verifySignature accepts a request whose header matches the secret', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    const body = JSON.stringify({ update_id: 1, message: { text: 'hi' } });
    const req = buildReq({
      url: '/webhooks/telegram/tg-prod',
      headers: { [TELEGRAM_SECRET_HEADER]: SECRET_TOKEN },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SECRET_TOKEN)).toBe(true);
  });

  it('verifySignature rejects when header value is wrong', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    const body = JSON.stringify({ update_id: 1 });
    const req = buildReq({
      url: '/webhooks/telegram/tg-prod',
      headers: { [TELEGRAM_SECRET_HEADER]: 'wrong-secret' },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SECRET_TOKEN)).toBe(false);
  });

  it('verifySignature rejects when header is missing', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    const body = JSON.stringify({ update_id: 1 });
    const req = buildReq({
      url: '/webhooks/telegram/tg-prod',
      headers: {},
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SECRET_TOKEN)).toBe(false);
  });

  it('verifySignature rejects when header value is empty', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    const body = JSON.stringify({ update_id: 1 });
    const req = buildReq({
      url: '/webhooks/telegram/tg-prod',
      headers: { [TELEGRAM_SECRET_HEADER]: '' },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SECRET_TOKEN)).toBe(false);
  });

  it('verifySignature rejects when header value differs by length', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    const body = JSON.stringify({ update_id: 1 });
    const shorter = SECRET_TOKEN.slice(0, SECRET_TOKEN.length - 5);
    const req = buildReq({
      url: '/webhooks/telegram/tg-prod',
      headers: { [TELEGRAM_SECRET_HEADER]: shorter },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SECRET_TOKEN)).toBe(false);
  });

  it('verifySignature is case-sensitive on the secret value (Telegram secrets are exact-match)', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    const body = JSON.stringify({ update_id: 1 });
    const req = buildReq({
      url: '/webhooks/telegram/tg-prod',
      headers: { [TELEGRAM_SECRET_HEADER]: SECRET_TOKEN.toUpperCase() },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SECRET_TOKEN)).toBe(false);
  });

  it('extractEventId returns the update_id stringified when numeric', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    const body = JSON.stringify({ update_id: 42, message: { text: 'hi' } });
    const req = buildReq({ url: '/webhooks/telegram/tg-prod', body });
    expect(descriptor.extractEventId(req, Buffer.from(body, 'utf-8'))).toBe('42');
  });

  it('extractEventId returns null on malformed JSON', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    const body = '{ malformed';
    const req = buildReq({ url: '/webhooks/telegram/tg-prod', body });
    expect(descriptor.extractEventId(req, Buffer.from(body, 'utf-8'))).toBeNull();
  });
});

describe('Telegram provider — dispatch through webhook port', () => {
  it('dispatches a verified update to the engine', async () => {
    const deps = buildDeps();
    const descriptor = createTelegramVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { telegram: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const body = JSON.stringify({
      update_id: 100,
      message: { text: 'hello bot' },
    });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: { [TELEGRAM_SECRET_HEADER]: SECRET_TOKEN },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(200);
    expect(deps.dispatched).toHaveLength(1);
    expect(deps.dispatched[0]).toMatchObject({
      connection_name: 'tg-prod',
      update_id: '100',
    });
  });

  it('rejects a request with the wrong header secret as 401 signature_invalid', async () => {
    const deps = buildDeps();
    const descriptor = createTelegramVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { telegram: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const body = JSON.stringify({ update_id: 100 });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: { [TELEGRAM_SECRET_HEADER]: 'attacker-secret' },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body ?? 'null')).toEqual({ error: { code: 'signature_invalid' } });
    expect(deps.dispatched).toHaveLength(0);
  });

  it('rejects a request with no header (missing secret) as 401', async () => {
    const deps = buildDeps();
    const descriptor = createTelegramVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { telegram: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const body = JSON.stringify({ update_id: 100 });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: {},
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(401);
    expect(deps.dispatched).toHaveLength(0);
  });

  it('returns generic 404 when the connection_name is unknown', async () => {
    const deps = buildDeps();
    const descriptor = createTelegramVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { telegram: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const body = JSON.stringify({ update_id: 100 });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/does-not-exist',
        headers: { [TELEGRAM_SECRET_HEADER]: SECRET_TOKEN },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? 'null')).toEqual({ error: { code: 'not_found' } });
  });

  it('idempotency ledger dedupes a replayed update_id within window', async () => {
    const deps = buildDeps();
    const descriptor = createTelegramVendorDescriptor(deps);
    const ledger = createIdempotencyLedger();
    const handler = createWebhookPortHandler({
      vendors: { telegram: descriptor },
      ledger,
    });

    const body = JSON.stringify({ update_id: 555 });
    const r1 = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: { [TELEGRAM_SECRET_HEADER]: SECRET_TOKEN },
        body,
      }),
      r1 as unknown as ServerResponse,
    );
    expect(r1.statusCode).toBe(200);
    expect(JSON.parse(r1.body ?? 'null')).toEqual({ ok: true, deduped: false });

    const r2 = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: { [TELEGRAM_SECRET_HEADER]: SECRET_TOKEN },
        body,
      }),
      r2 as unknown as ServerResponse,
    );
    expect(JSON.parse(r2.body ?? 'null')).toEqual({ ok: true, deduped: true });
    expect(deps.dispatched).toHaveLength(1);
  });

  it('rejects malformed-JSON body after header verify (502 dispatch_failed)', async () => {
    const deps = buildDeps();
    const descriptor = createTelegramVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { telegram: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const body = '{not valid json';
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: { [TELEGRAM_SECRET_HEADER]: SECRET_TOKEN },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(502);
  });

  it('engine dispatch failure surfaces as 502', async () => {
    const deps = buildDeps({
      dispatchEvent: vi.fn().mockRejectedValue(new Error('engine boom')),
    });
    const descriptor = createTelegramVendorDescriptor(deps);
    const handler = createWebhookPortHandler({
      vendors: { telegram: descriptor },
      ledger: createIdempotencyLedger(),
    });

    const body = JSON.stringify({ update_id: 1 });
    const res = new FakeRes();
    await handler(
      buildReq({
        url: '/webhooks/telegram/tg-prod',
        headers: { [TELEGRAM_SECRET_HEADER]: SECRET_TOKEN },
        body,
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(502);
  });

  it('webhook_secret is a registered inbound-secret field', () => {
    expect(CONNECTION_INBOUND_SECRET_FIELDS).toContain('webhook_secret');
  });
});

describe('setTelegramWebhook port-binding constraint + API path', () => {
  it('accepts each Telegram-supported port via setWebhook', async () => {
    for (const port of TELEGRAM_SUPPORTED_PORTS) {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ok: true, result: true, description: 'Webhook was set' }),
      });
      const result = await setTelegramWebhook({
        bot_token: '12345:ABC-DEF',
        webhook_url: `https://example.com:${port}/webhooks/telegram/main`,
        secret_token: 'secret-fixture',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.port).toBe(port);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  it('rejects an unsupported port (9999) with telegram_port_unsupported', async () => {
    const fetchImpl = vi.fn();
    const result = await setTelegramWebhook({
      bot_token: '12345:ABC-DEF',
      webhook_url: 'https://example.com:9999/webhooks/telegram/main',
      secret_token: 'secret-fixture',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'telegram_port_unsupported') {
      expect(result.port).toBe(9999);
      expect(result.supported_ports).toEqual(TELEGRAM_SUPPORTED_PORTS);
    } else {
      throw new Error(`expected telegram_port_unsupported, got ${JSON.stringify(result)}`);
    }
    // Must not call fetch — the port check is local-first.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects port 8080 (commonly mistaken for HTTPS) as unsupported', async () => {
    const fetchImpl = vi.fn();
    const result = await setTelegramWebhook({
      bot_token: '12345:ABC-DEF',
      webhook_url: 'https://example.com:8080/webhooks/telegram/main',
      secret_token: 'secret-fixture',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'telegram_port_unsupported') {
      expect(result.port).toBe(8080);
    } else {
      throw new Error(`expected telegram_port_unsupported, got ${JSON.stringify(result)}`);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed URLs with telegram_port_unsupported (port: -1)', async () => {
    const fetchImpl = vi.fn();
    const result = await setTelegramWebhook({
      bot_token: '12345:ABC-DEF',
      webhook_url: 'not-a-url',
      secret_token: 'secret-fixture',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'telegram_port_unsupported') {
      expect(result.port).toBe(-1);
    } else {
      throw new Error(`expected telegram_port_unsupported, got ${JSON.stringify(result)}`);
    }
  });

  it('default https port (443) when no port specified is allowed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ok: true, result: true }),
    });
    const result = await setTelegramWebhook({
      bot_token: '12345:ABC-DEF',
      webhook_url: 'https://example.com/webhooks/telegram/main',
      secret_token: 'secret-fixture',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.port).toBe(443);
  });

  it('passes the secret_token to Telegram setWebhook', async () => {
    let capturedBody: unknown = null;
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedBody = init.body !== undefined ? JSON.parse(String(init.body)) : null;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ok: true, result: true }),
      };
    });
    const result = await setTelegramWebhook({
      bot_token: '12345:ABC-DEF',
      webhook_url: 'https://example.com:443/webhooks/telegram/main',
      secret_token: 'fixture-secret-12345',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(capturedBody).toEqual({
      url: 'https://example.com:443/webhooks/telegram/main',
      secret_token: 'fixture-secret-12345',
    });
  });

  it('hits the Telegram Bot API setWebhook endpoint with the bot token in path', async () => {
    let capturedUrl = '';
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ok: true, result: true }),
      };
    });
    await setTelegramWebhook({
      bot_token: '12345:ABC-DEF',
      webhook_url: 'https://example.com:443/webhooks/telegram/main',
      secret_token: 'fixture',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(capturedUrl).toBe('https://api.telegram.org/bot12345%3AABC-DEF/setWebhook');
  });

  it('surfaces Telegram API non-OK status as telegram_api_error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ ok: false, description: 'invalid bot token' }),
    });
    const result = await setTelegramWebhook({
      bot_token: 'bad-token',
      webhook_url: 'https://example.com:443/webhooks/telegram/main',
      secret_token: 'fixture',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'telegram_api_error') {
      expect(result.status).toBe(401);
    } else {
      throw new Error(`expected telegram_api_error, got ${JSON.stringify(result)}`);
    }
  });

  it('surfaces Telegram API ok:false (HTTP 200) as telegram_api_error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ok: false, description: 'Bad request: invalid url' }),
    });
    const result = await setTelegramWebhook({
      bot_token: '12345:ABC-DEF',
      webhook_url: 'https://example.com:443/webhooks/telegram/main',
      secret_token: 'fixture',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'telegram_api_error') {
      expect(result.message).toContain('Bad request');
    } else {
      throw new Error(`expected telegram_api_error, got ${JSON.stringify(result)}`);
    }
  });

  it('surfaces network-layer failures as network_error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await setTelegramWebhook({
      bot_token: '12345:ABC-DEF',
      webhook_url: 'https://example.com:443/webhooks/telegram/main',
      secret_token: 'fixture',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'network_error') {
      expect(result.message).toContain('ECONNREFUSED');
    } else {
      throw new Error(`expected network_error, got ${JSON.stringify(result)}`);
    }
  });
});

describe('Codex P9 fold-back', () => {
  it('fold #3 — setTelegramWebhook rejects non-https schemes (http://) without network call', async () => {
    const fetchImpl = vi.fn();
    const result = await setTelegramWebhook({
      bot_token: '12345:ABC-DEF',
      webhook_url: 'http://example.com/webhooks/telegram/main',
      secret_token: 'fixture',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'telegram_port_unsupported') {
      // `http://` defaults to port 80 (which IS in TELEGRAM_SUPPORTED_PORTS)
      // — the rejection must come from the scheme check, not the port
      // check. The port surfaced for diagnostic purposes is -1 (no
      // explicit port in URL) per the fold.
      expect(result.port).toBe(-1);
    } else {
      throw new Error(`expected telegram_port_unsupported (scheme), got ${JSON.stringify(result)}`);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fold #3 — setTelegramWebhook rejects file:// schemes without network call', async () => {
    const fetchImpl = vi.fn();
    const result = await setTelegramWebhook({
      bot_token: '12345:ABC-DEF',
      webhook_url: 'file:///tmp/webhook',
      secret_token: 'fixture',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'telegram_port_unsupported') {
      // file:// has no port; surfaced as -1.
      expect(result.port).toBe(-1);
    } else {
      throw new Error(`expected telegram_port_unsupported (scheme), got ${JSON.stringify(result)}`);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fold #3 — setTelegramWebhook still rejects unsupported port even when scheme is https', async () => {
    const fetchImpl = vi.fn();
    const result = await setTelegramWebhook({
      bot_token: '12345:ABC-DEF',
      webhook_url: 'https://example.com:9000/webhooks/telegram/main',
      secret_token: 'fixture',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (!result.ok && result.code === 'telegram_port_unsupported') {
      expect(result.port).toBe(9000);
    } else {
      throw new Error(`expected telegram_port_unsupported (port), got ${JSON.stringify(result)}`);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fold #5 — verifySignature still rejects a wrong secret of identical length', () => {
    // The shared digest comparison keeps an equal-length wrong secret closed.
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    const wrong = 'X'.repeat(SECRET_TOKEN.length);
    expect(wrong.length).toBe(SECRET_TOKEN.length);
    const body = JSON.stringify({ update_id: 1 });
    const req = buildReq({
      url: '/webhooks/telegram/tg-prod',
      headers: { [TELEGRAM_SECRET_HEADER]: wrong },
      body,
    });
    expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SECRET_TOKEN)).toBe(false);
  });

  it('fold #5 — shared secret verification stays stable across many calls', () => {
    // Stability assertion: 200 successive verifications all pass.
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    const body = JSON.stringify({ update_id: 1 });
    const req = buildReq({
      url: '/webhooks/telegram/tg-prod',
      headers: { [TELEGRAM_SECRET_HEADER]: SECRET_TOKEN },
      body,
    });
    for (let i = 0; i < 200; i += 1) {
      expect(descriptor.verifySignature(req, Buffer.from(body, 'utf-8'), SECRET_TOKEN)).toBe(true);
    }
  });

  it('fold #6 — extractEventId rejects non-integer numeric (NaN / Infinity)', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    // Construct payloads containing non-integer numbers — these are
    // not legal Telegram update_ids.
    const fractional = JSON.stringify({ update_id: 1.5 });
    const reqA = buildReq({ url: '/webhooks/telegram/tg-prod', body: fractional });
    expect(descriptor.extractEventId(reqA, Buffer.from(fractional, 'utf-8'))).toBeNull();
  });

  it('fold #6 — extractEventId rejects string update_id values', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    const stringy = JSON.stringify({ update_id: '42abc' });
    const req = buildReq({ url: '/webhooks/telegram/tg-prod', body: stringy });
    expect(descriptor.extractEventId(req, Buffer.from(stringy, 'utf-8'))).toBeNull();
  });

  it('fold #6 — extractEventId rejects null update_id', () => {
    const descriptor = createTelegramVendorDescriptor(buildDeps());
    const nullId = JSON.stringify({ update_id: null });
    const req = buildReq({ url: '/webhooks/telegram/tg-prod', body: nullId });
    expect(descriptor.extractEventId(req, Buffer.from(nullId, 'utf-8'))).toBeNull();
  });
});
