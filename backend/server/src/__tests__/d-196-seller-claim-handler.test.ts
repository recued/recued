import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createSellerClaimStore,
  type SellerClaimPayload,
} from '../storage/seller-claim-store.js';
import {
  RECEPTION_SELLER_CLAIM_ENDPOINT_ID,
  RECEPTION_SELLER_CLAIM_PATH,
  SELLER_CLAIM_TOKEN_PLACEHOLDER,
  buildSellerClaimSetupSnippets,
  createSellerClaimHandler,
  renderSellerClaimResultHtml,
} from '../ports/reception/handlers/seller-claim.js';
import { createReceptionPortHandler } from '../ports/reception/handler.js';
import { deriveReceptionPepper } from '../ports/reception/server-secret-pepper.js';

const NOW = 1_800_000_000_000;
const CLAIM = `recued_claim_${'a'.repeat(43)}`;
const OTHER_CLAIM = `recued_claim_${'b'.repeat(43)}`;
const BEARER = `recued_${'z'.repeat(43)}`;

const payload = (overrides: Partial<SellerClaimPayload> = {}): SellerClaimPayload => ({
  bearer_plaintext: BEARER,
  mcp_url: 'https://seller.example/mcp',
  llm_gateway_base_url: 'https://seller.example/v1',
  llm_gateway_model_alias: 'seller-pro',
  ...overrides,
});

interface FakeResponse {
  response: ServerResponse;
  readonly headers: Map<string, string>;
  statusCode: number;
  body: string;
}

const fakeResponse = (): FakeResponse => {
  const out: FakeResponse = {
    headers: new Map(),
    statusCode: 0,
    body: '',
    response: null as unknown as ServerResponse,
  };
  out.response = {
    set statusCode(value: number) { out.statusCode = value; },
    get statusCode() { return out.statusCode; },
    setHeader(name: string, value: string | number) {
      out.headers.set(name.toLowerCase(), String(value));
    },
    end(body?: string | Buffer) {
      out.body = body === undefined ? '' : body.toString();
    },
  } as ServerResponse;
  return out;
};

const fakeRequest = (input: {
  method: string;
  url?: string;
  body?: string;
  origin?: string;
  contentType?: string;
}): IncomingMessage => {
  const request = new EventEmitter() as IncomingMessage;
  request.method = input.method;
  request.url = input.url ?? RECEPTION_SELLER_CLAIM_PATH;
  request.headers = {
    host: 'seller.example',
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.contentType !== undefined ? { 'content-type': input.contentType } : {}),
  };
  Object.defineProperty(request, 'socket', {
    value: { remoteAddress: '203.0.113.10' },
  });
  queueMicrotask(() => {
    if (input.body !== undefined) request.emit('data', Buffer.from(input.body));
    request.emit('end');
  });
  return request;
};

describe('D-196 S3b seller claim renderer', () => {
  it('renders the bearer exactly once, escapes values, and emits no active content', () => {
    const unsafe = payload({
      bearer_plaintext: `${BEARER}<secret>`,
      llm_gateway_model_alias: '<img src=x onerror=alert(1)>',
    });
    const html = renderSellerClaimResultHtml(unsafe);
    expect(html.match(new RegExp(BEARER, 'g'))).toHaveLength(1);
    expect(html).not.toContain('<secret>');
    expect(html).toContain('&lt;secret&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('target=');
    expect(html).toContain(SELLER_CLAIM_TOKEN_PLACEHOLDER);
  });

  it('builds the named client snippets only for enabled door endpoints', () => {
    expect(buildSellerClaimSetupSnippets(payload()).map((row) => row.id)).toEqual([
      'claude_code',
      'claude_desktop',
      'cursor',
      'generic_mcp',
      'openai_compatible',
    ]);
    const mcpOnly = buildSellerClaimSetupSnippets(payload({
      llm_gateway_base_url: null,
      llm_gateway_model_alias: null,
    }));
    expect(mcpOnly.map((row) => row.id)).toEqual([
      'claude_code',
      'claude_desktop',
      'cursor',
      'generic_mcp',
    ]);
    expect(mcpOnly.some((row) => row.content.includes(BEARER))).toBe(false);
    expect(mcpOnly.filter((row) => row.format === 'code').every(
      (row) => row.content.includes(SELLER_CLAIM_TOKEN_PLACEHOLDER),
    ))
      .toBe(true);
    const claudeCode = mcpOnly.find((row) => row.id === 'claude_code');
    expect(claudeCode?.content).toContain(
      `--header 'Authorization: Bearer ${SELLER_CLAIM_TOKEN_PLACEHOLDER}'`,
    );
    expect(claudeCode?.content).toContain("recued 'https://seller.example/mcp'");
    const claudeDesktop = mcpOnly.find((row) => row.id === 'claude_desktop');
    expect(claudeDesktop).toMatchObject({ format: 'notice' });
    expect(claudeDesktop?.content).toContain('do not support this static bearer-header setup');
    const shellSensitive = buildSellerClaimSetupSnippets(payload({
      mcp_url: 'https://seller.example/mcp;$(id)',
    })).find((row) => row.id === 'claude_code');
    expect(shellSensitive?.content).toContain("recued 'https://seller.example/mcp;$(id)'");
    const openAi = buildSellerClaimSetupSnippets(payload()).find(
      (row) => row.id === 'openai_compatible',
    );
    expect(openAi?.content).toContain('from openai import OpenAI');
    expect(openAi?.content).toContain('base_url="https://seller.example/v1"');
    expect(openAi?.content).toContain('model="seller-pro"');
  });
});

describe('D-196 S3b seller claim HTTP handler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  const harness = () => {
    const store = createSellerClaimStore(db, {
      newClaimId: () => 'claim-1',
      newClaimSecret: () => CLAIM,
    });
    store.issue({
      customer_id: 'customer-1',
      contract_id: 'contract-1',
      payload: payload(),
      now: NOW,
    });
    return {
      store,
      handler: createSellerClaimHandler({ getClaimStore: () => store, now: () => NOW + 1 }),
    };
  };

  it('GET is scanner-safe: it renders a reveal form without consuming', async () => {
    const { store, handler } = harness();
    const consume = vi.spyOn(store, 'consume');
    const res = fakeResponse();
    const outcome = await handler(fakeRequest({
      method: 'GET',
      url: `${RECEPTION_SELLER_CLAIM_PATH}?t=${encodeURIComponent(CLAIM)}`,
    }), res.response);

    expect(outcome).toEqual({ action_taken: 'view', outcome: 'ok' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Reveal access token');
    expect(res.body).toContain(`value="${CLAIM}"`);
    expect(res.body).not.toContain(BEARER);
    expect(consume).not.toHaveBeenCalled();
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");

    const unknown = fakeResponse();
    const unknownOutcome = await handler(fakeRequest({
      method: 'GET',
      url: `${RECEPTION_SELLER_CLAIM_PATH}?t=${encodeURIComponent(OTHER_CLAIM)}`,
    }), unknown.response);
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toContain(`value="${OTHER_CLAIM}"`);
    expect(unknownOutcome).toEqual({ action_taken: 'view', outcome: 'ok' });
    expect(consume).not.toHaveBeenCalled();

    const widened = fakeResponse();
    await handler(fakeRequest({
      method: 'GET',
      url: `${RECEPTION_SELLER_CLAIM_PATH}?t=${encodeURIComponent(CLAIM)}&tracking=1`,
    }), widened.response);
    expect(widened.statusCode).toBe(404);
    expect(consume).not.toHaveBeenCalled();
  });

  it('POST consumes once and every replay returns the uniform unavailable page', async () => {
    const { handler } = harness();
    const body = `claim_secret=${encodeURIComponent(CLAIM)}`;
    const first = fakeResponse();
    const firstOutcome = await handler(fakeRequest({
      method: 'POST',
      body,
      origin: 'https://seller.example',
      contentType: 'application/x-www-form-urlencoded',
    }), first.response);
    expect(firstOutcome).toEqual({ action_taken: 'submit', outcome: 'ok' });
    expect(first.statusCode).toBe(200);
    expect(first.body).toContain(BEARER);
    expect(first.body.match(new RegExp(BEARER, 'g'))).toHaveLength(1);
    expect(first.body).toContain('https://seller.example/mcp');
    expect(first.body).toContain('https://seller.example/v1');

    const replay = fakeResponse();
    const replayOutcome = await handler(fakeRequest({
      method: 'POST',
      body,
      origin: 'https://seller.example',
      contentType: 'application/x-www-form-urlencoded',
    }), replay.response);
    expect(replayOutcome).toEqual({ action_taken: 'invalid_token', outcome: 'invalid_token' });
    expect(replay.statusCode).toBe(410);
    expect(replay.body).toContain('Claim link unavailable');
    expect(replay.body).not.toContain(BEARER);
  });

  it('accepts the opaque Origin emitted by the scanner-safe no-referrer form', async () => {
    const { handler } = harness();
    const res = fakeResponse();
    await handler(fakeRequest({
      method: 'POST',
      body: `claim_secret=${encodeURIComponent(CLAIM)}`,
      origin: 'null',
      contentType: 'application/x-www-form-urlencoded; charset=UTF-8',
    }), res.response);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(BEARER);
  });

  it('rejects malformed GETs, cross-origin POSTs, and widened form bodies', async () => {
    const { store, handler } = harness();
    const consume = vi.spyOn(store, 'consume');

    const malformed = fakeResponse();
    await handler(fakeRequest({ method: 'GET', url: `${RECEPTION_SELLER_CLAIM_PATH}?t=bad` }), malformed.response);
    expect(malformed.statusCode).toBe(404);

    const crossOrigin = fakeResponse();
    await handler(fakeRequest({
      method: 'POST',
      body: `claim_secret=${CLAIM}`,
      origin: 'https://attacker.example',
      contentType: 'application/x-www-form-urlencoded',
    }), crossOrigin.response);
    expect(crossOrigin.statusCode).toBe(403);

    const widened = fakeResponse();
    await handler(fakeRequest({
      method: 'POST',
      body: `claim_secret=${CLAIM}&redirect=https://attacker.example`,
      origin: 'https://seller.example',
      contentType: 'application/x-www-form-urlencoded',
    }), widened.response);
    expect(widened.statusCode).toBe(400);
    expect(consume).not.toHaveBeenCalled();

    const oversized = fakeResponse();
    await handler(fakeRequest({
      method: 'POST',
      body: `claim_secret=${CLAIM}&${'x'.repeat(4 * 1024)}`,
      origin: 'https://seller.example',
      contentType: 'application/x-www-form-urlencoded',
    }), oversized.response);
    expect(oversized.statusCode).toBe(413);
    expect(consume).not.toHaveBeenCalled();
  });

  it('rejects a non-form content type before reading or consuming the claim', async () => {
    const { store, handler } = harness();
    const consume = vi.spyOn(store, 'consume');
    const res = fakeResponse();
    await handler(fakeRequest({
      method: 'POST',
      body: JSON.stringify({ claim_secret: CLAIM }),
      origin: 'https://seller.example',
      contentType: 'application/json',
    }), res.response);
    expect(res.statusCode).toBe(415);
    expect(consume).not.toHaveBeenCalled();

    const widenedMediaType = fakeResponse();
    await handler(fakeRequest({
      method: 'POST',
      body: `claim_secret=${CLAIM}`,
      origin: 'https://seller.example',
      contentType: 'application/x-www-form-urlencoded-evil',
    }), widenedMediaType.response);
    expect(widenedMediaType.statusCode).toBe(415);
    expect(consume).not.toHaveBeenCalled();
  });

  it('mounts through the dedicated Reception route behind pre-verify rate limiting', async () => {
    const { store } = harness();
    const consumePreVerify = vi.fn(() => ({ ok: true as const }));
    const appendAccessLog = vi.fn();
    const handler = createReceptionPortHandler({
      getStore: () => ({ appendAccessLog } as never),
      getCache: () => ({} as never),
      getRateLimiter: () => ({ consumePreVerify } as never),
      getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 5)),
      getSellerClaimStore: () => store,
      now: () => NOW + 1,
    });
    const res = fakeResponse();
    await handler(fakeRequest({
      method: 'GET',
      url: `${RECEPTION_SELLER_CLAIM_PATH}?t=${encodeURIComponent(CLAIM)}`,
    }), res.response);

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Reveal access token');
    expect(consumePreVerify).toHaveBeenCalledWith(expect.objectContaining({
      endpoint_kind: 'reception_page',
      now: NOW + 1,
    }));
    expect(appendAccessLog).toHaveBeenCalledWith(expect.objectContaining({
      endpoint_id: RECEPTION_SELLER_CLAIM_ENDPOINT_ID,
      action_taken: 'view',
      outcome: 'ok',
      url_path_redacted: RECEPTION_SELLER_CLAIM_PATH,
    }));
    expect(JSON.stringify(appendAccessLog.mock.calls)).not.toContain(CLAIM);

    const claim = fakeResponse();
    await handler(fakeRequest({
      method: 'POST',
      body: `claim_secret=${encodeURIComponent(CLAIM)}`,
      origin: 'https://seller.example',
      contentType: 'application/x-www-form-urlencoded',
    }), claim.response);
    expect(claim.statusCode).toBe(200);
    expect(claim.body.match(new RegExp(BEARER, 'g'))).toHaveLength(1);
    expect(appendAccessLog).toHaveBeenLastCalledWith(expect.objectContaining({
      endpoint_id: RECEPTION_SELLER_CLAIM_ENDPOINT_ID,
      action_taken: 'submit',
      outcome: 'ok',
      url_path_redacted: RECEPTION_SELLER_CLAIM_PATH,
    }));
  });

  it('applies endpoint IP blocks and rate limits before claim lookup', async () => {
    const { store } = harness();
    const consume = vi.spyOn(store, 'consume');
    const blockedLog = vi.fn();
    const blockedLimiter = vi.fn(() => ({ ok: true as const }));
    const blockedHandler = createReceptionPortHandler({
      getStore: () => ({ appendAccessLog: blockedLog } as never),
      getCache: () => ({} as never),
      getRateLimiter: () => ({ consumePreVerify: blockedLimiter } as never),
      getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 5)),
      getIpBlockStore: () => ({ isBlocked: () => true } as never),
      getSellerClaimStore: () => store,
      now: () => NOW + 1,
    });
    const blocked = fakeResponse();
    await blockedHandler(fakeRequest({
      method: 'GET',
      url: `${RECEPTION_SELLER_CLAIM_PATH}?t=${encodeURIComponent(CLAIM)}`,
    }), blocked.response);
    expect(blocked.statusCode).toBe(403);
    expect(blockedLimiter).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(blockedLog).toHaveBeenCalledWith(expect.objectContaining({
      endpoint_id: RECEPTION_SELLER_CLAIM_ENDPOINT_ID,
      action_taken: 'reject',
      outcome: 'rejected',
      url_path_redacted: RECEPTION_SELLER_CLAIM_PATH,
    }));

    const rateLog = vi.fn();
    const rateHandler = createReceptionPortHandler({
      getStore: () => ({ appendAccessLog: rateLog } as never),
      getCache: () => ({} as never),
      getRateLimiter: () => ({
        consumePreVerify: () => ({
          ok: false,
          bucket_kind: 'per_ip_global',
          retry_after_at: NOW + 5_001,
        }),
      } as never),
      getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 5)),
      getSellerClaimStore: () => store,
      now: () => NOW + 1,
    });
    const rateLimited = fakeResponse();
    await rateHandler(fakeRequest({
      method: 'POST',
      body: `claim_secret=${encodeURIComponent(CLAIM)}`,
      origin: 'https://seller.example',
      contentType: 'application/x-www-form-urlencoded',
    }), rateLimited.response);
    expect(rateLimited.statusCode).toBe(429);
    expect(rateLimited.headers.get('retry-after')).toBe('5');
    expect(rateLimited.headers.get('cache-control')).toContain('no-store');
    expect(rateLimited.headers.get('referrer-policy')).toBe('no-referrer');
    expect(consume).not.toHaveBeenCalled();
    expect(rateLog).toHaveBeenCalledWith(expect.objectContaining({
      endpoint_id: RECEPTION_SELLER_CLAIM_ENDPOINT_ID,
      action_taken: 'rate_limited',
      outcome: 'rate_limited',
      url_path_redacted: RECEPTION_SELLER_CLAIM_PATH,
    }));
    expect(JSON.stringify(rateLimited.body)).not.toContain(CLAIM);
  });

  it('keeps claim URLs no-store and no-referrer while Reception is paused', async () => {
    const handler = createReceptionPortHandler({
      getStore: () => ({} as never),
      getCache: () => ({} as never),
      getRateLimiter: () => ({} as never),
      getPepper: () => deriveReceptionPepper(Buffer.alloc(32, 5)),
      getSellerClaimStore: () => ({} as never),
      isPaused: () => true,
      now: () => NOW,
    });
    const res = fakeResponse();
    await handler(fakeRequest({
      method: 'GET',
      url: `${RECEPTION_SELLER_CLAIM_PATH}?t=${encodeURIComponent(CLAIM)}`,
    }), res.response);
    expect(res.statusCode).toBe(503);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
