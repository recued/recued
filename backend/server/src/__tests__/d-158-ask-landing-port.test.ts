/** D-158 P2b-ii — `/ask/<ask_id>` notification ask-landing route.
 *
 *  Covers the three server-wiring units the slice adds:
 *    - `resolvePublicBaseUrl` / `buildAskLandingAnswerLink` — the email
 *      `answerLink` builder (presence keyed off a public base URL).
 *    - `createInMemoryAskLandingNonceStore` — single-use, TTL, ask-bound.
 *    - `createAskLandingPortHandler` — GET renders the form / answered /
 *      unavailable page; POST guards (same-origin + single-use nonce + body
 *      ask_id cross-check) then `submitAnswer`. */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { InboundReply, PendingAsk } from '@recued/notification';

import {
  ASK_LANDING_ENDPOINT_ID,
  createAskLandingPortHandler,
  type AskLandingAbuseDeps,
  type AskLandingPortHandlerDeps,
} from '../ask-landing-port.js';
import {
  createInMemoryAskLandingNonceStore,
  ASK_LANDING_NONCE_TTL_MS,
} from '../ask-landing-nonce-store.js';
import {
  resolvePublicBaseUrl,
  buildAskLandingAnswerLink,
} from '../ask-landing-answer-link.js';
import {
  allowingAskLandingAbuseDeps,
  attachAskTestSocket,
} from './ask-landing-test-helpers.js';
import { hashSourceIpServerWide } from '../ports/reception/server-secret-pepper.js';

const NOW = 1_700_000_000_000;
const HOST = 'h.example.com';
const ORIGIN = `https://${HOST}`;

// ── Fixtures + req/res harness (mirrors d-165-vendor-oauth-complete-port) ──

const buildAsk = (over: Partial<PendingAsk> = {}): PendingAsk => ({
  ask_id: 'ask-test-1',
  message: { title: 'Decision', text: 'Approve the deal?' },
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  handler_kind: 'noop',
  handler_payload: {},
  fanout_channels: ['email'],
  status: 'open',
  created_at: NOW,
  ...over,
});

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  ended: string;
  setHeader(k: string, v: string | number | readonly string[]): void;
  end(b?: string): void;
}

const makeRes = (): MockRes =>
  ({
    statusCode: 0,
    headers: {},
    ended: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    },
    end(b) {
      this.ended = b ?? '';
    },
  }) as MockRes;

const buildReq = (opts: {
  method: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
}): IncomingMessage => {
  const chunks = opts.body === undefined ? [] : [Buffer.from(opts.body, 'utf8')];
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  (stream as unknown as { method: string }).method = opts.method;
  (stream as unknown as { url: string }).url = opts.url;
  (stream as unknown as { headers: Record<string, string> }).headers =
    opts.headers ?? {};
  const request = attachAskTestSocket(stream);
  if (opts.remoteAddress !== undefined) {
    Object.defineProperty(request, 'socket', {
      configurable: true,
      value: { remoteAddress: opts.remoteAddress },
    });
  }
  return request;
};

const makeHarness = (over: { ask?: PendingAsk | null } = {}) => {
  let current: PendingAsk | null = over.ask !== undefined ? over.ask : buildAsk();
  const submitAnswer = vi.fn(async (reply: InboundReply) => {
    // Simulate the block: first-answer-wins flip on a matching open ask.
    if (current && current.status === 'open' && current.ask_id === reply.ask_id) {
      current = {
        ...current,
        status: 'answered',
        answer: { option: reply.option, answered_at: NOW },
        answered_via: reply.via,
      };
    }
  });
  const nonceStore = createInMemoryAskLandingNonceStore();
  const deps: AskLandingPortHandlerDeps = {
    getAsk: async (id) => (current && current.ask_id === id ? current : null),
    submitAnswer,
    getVerificationPhrase: async () => 'river-stone-velvet',
    nonceStore,
    now: () => NOW,
    abuse: allowingAskLandingAbuseDeps(),
  };
  const handler = createAskLandingPortHandler(deps);
  return { handler, nonceStore, submitAnswer, currentAsk: () => current };
};

const postBody = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

const sameOriginHeaders = (): Record<string, string> => ({
  host: HOST,
  origin: ORIGIN,
  'content-type': 'application/x-www-form-urlencoded',
});

// ────────────────────────────────────────────────────────────────
// answerLink builder
// ────────────────────────────────────────────────────────────────

describe('D-158 P2b-ii — resolvePublicBaseUrl', () => {
  it('accepts an https public URL and strips trailing slashes', () => {
    expect(resolvePublicBaseUrl('https://app.example.com/')).toBe(
      'https://app.example.com',
    );
    expect(resolvePublicBaseUrl('https://app.example.com///')).toBe(
      'https://app.example.com',
    );
  });

  it('rejects local / empty / unparseable / non-http values → null', () => {
    expect(resolvePublicBaseUrl(undefined)).toBeNull();
    expect(resolvePublicBaseUrl('')).toBeNull();
    expect(resolvePublicBaseUrl('   ')).toBeNull();
    expect(resolvePublicBaseUrl('https://localhost')).toBeNull();
    expect(resolvePublicBaseUrl('https://host.localhost')).toBeNull();
    expect(resolvePublicBaseUrl('https://nas.local')).toBeNull();
    expect(resolvePublicBaseUrl('https://127.0.0.1:8080')).toBeNull();
    expect(resolvePublicBaseUrl('ftp://example.com')).toBeNull();
    expect(resolvePublicBaseUrl('not a url')).toBeNull();
  });

  it('rejects RFC1918 / link-local / ULA private hosts → null (Codex P2 fold)', () => {
    expect(resolvePublicBaseUrl('http://10.0.0.5')).toBeNull();
    expect(resolvePublicBaseUrl('http://192.168.1.10')).toBeNull();
    expect(resolvePublicBaseUrl('http://172.16.0.2')).toBeNull();
    expect(resolvePublicBaseUrl('http://172.31.255.254')).toBeNull();
    expect(resolvePublicBaseUrl('http://169.254.1.1')).toBeNull();
    expect(resolvePublicBaseUrl('http://0.0.0.0')).toBeNull();
    expect(resolvePublicBaseUrl('http://[fe80::1]')).toBeNull();
    expect(resolvePublicBaseUrl('http://[fd00::1]')).toBeNull();
    // …but a public IP / domain (incl. 172.x outside 16-31) still resolves.
    expect(resolvePublicBaseUrl('https://203.0.113.7')).toBe('https://203.0.113.7');
    expect(resolvePublicBaseUrl('http://172.32.0.1')).toBe('http://172.32.0.1');
    expect(resolvePublicBaseUrl('https://app.example.com')).toBe('https://app.example.com');
  });
});

describe('D-158 P2b-ii — buildAskLandingAnswerLink', () => {
  it('builds a /ask/<ask_id> URL when a base resolves; null otherwise', () => {
    const link = buildAskLandingAnswerLink('https://app.example.com');
    expect(link).not.toBeNull();
    expect(link!('ask-7f3a')).toBe('https://app.example.com/ask/ask-7f3a');
    // ask_id is URL-encoded.
    expect(link!('a/b?c')).toBe('https://app.example.com/ask/a%2Fb%3Fc');
    expect(buildAskLandingAnswerLink(null)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// nonce store
// ────────────────────────────────────────────────────────────────

describe('D-158 P2b-ii — ask-landing nonce store', () => {
  it('issues a single-use nonce that consume accepts exactly once', () => {
    const store = createInMemoryAskLandingNonceStore();
    const nonce = store.issue('ask-1', NOW);
    expect(store.consume('ask-1', nonce, NOW)).toBe(true);
    // Single-use — a second consume fails.
    expect(store.consume('ask-1', nonce, NOW)).toBe(false);
  });

  it('rejects an unknown nonce, a wrong ask_id, and an expired nonce', () => {
    const store = createInMemoryAskLandingNonceStore();
    const nonce = store.issue('ask-1', NOW);
    expect(store.consume('ask-1', 'never-issued', NOW)).toBe(false);
    // Bound to the ask it was issued for — a different ask_id can't consume it.
    expect(store.consume('ask-2', nonce, NOW)).toBe(false);
    // Presentation to the wrong ask spends it; a disclosed nonce is not
    // reusable against the right ask afterwards.
    expect(store.consume('ask-1', nonce, NOW)).toBe(false);
    // Still valid for the right ask within the window…
    const fresh = store.issue('ask-1', NOW);
    expect(store.consume('ask-1', fresh, NOW + ASK_LANDING_NONCE_TTL_MS + 1)).toBe(
      false,
    );
  });

  it('evicts the oldest nonce per ask and globally at the configured bounds', () => {
    const perAsk = createInMemoryAskLandingNonceStore({ maxEntries: 10, maxPerAsk: 2 });
    const a1 = perAsk.issue('ask-a', NOW);
    const a2 = perAsk.issue('ask-a', NOW + 1);
    const a3 = perAsk.issue('ask-a', NOW + 2);
    expect(perAsk.consume('ask-a', a1, NOW + 2)).toBe(false);
    expect(perAsk.consume('ask-a', a2, NOW + 2)).toBe(true);
    expect(perAsk.consume('ask-a', a3, NOW + 2)).toBe(true);

    const global = createInMemoryAskLandingNonceStore({ maxEntries: 2, maxPerAsk: 2 });
    const g1 = global.issue('ask-a', NOW);
    const g2 = global.issue('ask-b', NOW + 1);
    const g3 = global.issue('ask-c', NOW + 2);
    expect(global.consume('ask-a', g1, NOW + 2)).toBe(false);
    expect(global.consume('ask-b', g2, NOW + 2)).toBe(true);
    expect(global.consume('ask-c', g3, NOW + 2)).toBe(true);
  });

  it('sweeps expired entries before enforcing capacity and rejects invalid bounds', () => {
    const store = createInMemoryAskLandingNonceStore({ maxEntries: 1, maxPerAsk: 1 });
    const expired = store.issue('ask-old', NOW);
    const fresh = store.issue('ask-new', NOW + ASK_LANDING_NONCE_TTL_MS + 1);
    expect(store.consume('ask-old', expired, NOW + ASK_LANDING_NONCE_TTL_MS + 1)).toBe(false);
    expect(store.consume('ask-new', fresh, NOW + ASK_LANDING_NONCE_TTL_MS + 1)).toBe(true);
    expect(() => createInMemoryAskLandingNonceStore({ maxEntries: 0 })).toThrow(/positive integer/);
    expect(() => createInMemoryAskLandingNonceStore({ maxPerAsk: 1.5 })).toThrow(/positive integer/);
  });
});

// ────────────────────────────────────────────────────────────────
// GET
// ────────────────────────────────────────────────────────────────

describe('D-158 P2b-ii — ask-landing GET', () => {
  it('renders the option form + nonce + phrase + security headers for an open ask', async () => {
    const { handler } = makeHarness();
    const res = makeRes();
    await handler(buildReq({ method: 'GET', url: '/ask/ask-test-1' }), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.ended).toContain('<form method="POST"');
    expect(res.ended).toContain('value="yes"');
    expect(res.ended).toContain('river-stone-velvet'); // verification phrase
    expect(res.ended).toContain('name="form_nonce"');
  });

  it('renders the "already answered" page for a non-open ask (no form)', async () => {
    const ask = buildAsk({
      status: 'answered',
      answer: { option: 'yes', answered_at: NOW },
      answered_via: 'email',
    });
    const { handler } = makeHarness({ ask });
    const res = makeRes();
    await handler(buildReq({ method: 'GET', url: '/ask/ask-test-1' }), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.ended).not.toContain('<form method="POST"');
    expect(res.ended.toLowerCase()).toContain('already been answered');
  });

  it('renders a 404 unavailable page for an unknown ask_id', async () => {
    const { handler } = makeHarness({ ask: null });
    const res = makeRes();
    await handler(buildReq({ method: 'GET', url: '/ask/ask-gone' }), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(404);
    expect(res.ended.toLowerCase()).toContain('no longer available');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('404s a malformed path with no ask_id segment', async () => {
    const { handler } = makeHarness();
    const res = makeRes();
    await handler(buildReq({ method: 'GET', url: '/ask/' }), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(404);
  });
});

// ────────────────────────────────────────────────────────────────
// POST
// ────────────────────────────────────────────────────────────────

describe('D-158 P2b-ii — ask-landing POST', () => {
  it('records the answer on a valid same-origin POST with a fresh nonce', async () => {
    const { handler, nonceStore, submitAnswer, currentAsk } = makeHarness();
    const nonce = nonceStore.issue('ask-test-1', NOW);
    const res = makeRes();
    await handler(
      buildReq({
        method: 'POST',
        url: '/ask/ask-test-1',
        headers: sameOriginHeaders(),
        body: postBody({ ask_id: 'ask-test-1', option: 'yes', form_nonce: nonce }),
      }),
      res as unknown as ServerResponse,
    );
    expect(submitAnswer).toHaveBeenCalledWith({
      ask_id: 'ask-test-1',
      option: 'yes',
      via: 'email',
    });
    expect(res.statusCode).toBe(200);
    // The re-render reflects the now-answered ask.
    expect(currentAsk()?.status).toBe('answered');
    expect(res.ended.toLowerCase()).toContain('already been answered');
  });

  it('rejects a replayed nonce (single-use) without calling submitAnswer', async () => {
    const { handler, nonceStore, submitAnswer } = makeHarness();
    const nonce = nonceStore.issue('ask-test-1', NOW);
    // Consume it once out-of-band → the handler's consume now fails.
    nonceStore.consume('ask-test-1', nonce, NOW);
    const res = makeRes();
    await handler(
      buildReq({
        method: 'POST',
        url: '/ask/ask-test-1',
        headers: sameOriginHeaders(),
        body: postBody({ ask_id: 'ask-test-1', option: 'yes', form_nonce: nonce }),
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(403);
    expect(submitAnswer).not.toHaveBeenCalled();
  });

  it('rejects a cross-origin POST (no Origin/Referer) before reading the body', async () => {
    const { handler, nonceStore, submitAnswer } = makeHarness();
    const nonce = nonceStore.issue('ask-test-1', NOW);
    const res = makeRes();
    await handler(
      buildReq({
        method: 'POST',
        url: '/ask/ask-test-1',
        headers: { host: HOST }, // no origin/referer
        body: postBody({ ask_id: 'ask-test-1', option: 'yes', form_nonce: nonce }),
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(403);
    expect(submitAnswer).not.toHaveBeenCalled();
  });

  it('rejects a body ask_id that disagrees with the path (tampered form) → 400', async () => {
    const { handler, nonceStore, submitAnswer } = makeHarness();
    const nonce = nonceStore.issue('ask-test-1', NOW);
    const res = makeRes();
    await handler(
      buildReq({
        method: 'POST',
        url: '/ask/ask-test-1',
        headers: sameOriginHeaders(),
        body: postBody({ ask_id: 'ask-other', option: 'yes', form_nonce: nonce }),
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
    expect(submitAnswer).not.toHaveBeenCalled();
  });

  it('rejects a malformed body (missing fields) → 400', async () => {
    const { handler, submitAnswer } = makeHarness();
    const res = makeRes();
    await handler(
      buildReq({
        method: 'POST',
        url: '/ask/ask-test-1',
        headers: sameOriginHeaders(),
        body: 'option=yes', // no ask_id / form_nonce
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(400);
    expect(submitAnswer).not.toHaveBeenCalled();
  });

  it('rejects an oversized body → 413', async () => {
    const { handler, submitAnswer } = makeHarness();
    const res = makeRes();
    await handler(
      buildReq({
        method: 'POST',
        url: '/ask/ask-test-1',
        headers: sameOriginHeaders(),
        body: 'x'.repeat(32 * 1024),
      }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(413);
    expect(submitAnswer).not.toHaveBeenCalled();
  });
});

describe('D-158 P2b-ii — ask-landing method gate', () => {
  it('405s a non-GET/POST method with an Allow header', async () => {
    const { handler } = makeHarness();
    const res = makeRes();
    await handler(buildReq({ method: 'DELETE', url: '/ask/ask-test-1' }), res as unknown as ServerResponse);
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toBe('GET, POST');
  });
});

describe('D-210 — /ask abuse controls and redacted access logging', () => {
  const makeAbuseHarness = (input: {
    blocked?: boolean;
    rate?: { ok: true } | { ok: false; retry_after_at: number };
    trustForwardedFor?: boolean;
    pepperThrows?: boolean;
  } = {}) => {
    const accessLogs: Array<Record<string, unknown>> = [];
    const consumePreVerify = vi.fn(() => input.rate?.ok === false
      ? {
          ok: false as const,
          bucket_kind: 'per_ip_global' as const,
          retry_after_at: input.rate.retry_after_at,
        }
      : { ok: true as const });
    const getAsk = vi.fn(async (id: string) => id === 'ask-test-1' ? buildAsk() : null);
    const abuse: AskLandingAbuseDeps = {
      getRateLimiter: () => ({ consumePreVerify } as never),
      getPepper: () => {
        if (input.pepperThrows === true) throw new Error('vault locked');
        return Buffer.alloc(32, 9);
      },
      getStore: () => ({ appendAccessLog: (row) => accessLogs.push(row as never) }),
      getIpBlockStore: () => ({ isBlocked: () => input.blocked === true } as never),
      ...(input.trustForwardedFor !== undefined
        ? { trustForwardedFor: input.trustForwardedFor }
        : {}),
    };
    const handler = createAskLandingPortHandler({
      getAsk,
      submitAnswer: async () => {},
      getVerificationPhrase: async () => undefined,
      nonceStore: createInMemoryAskLandingNonceStore(),
      now: () => NOW,
      abuse,
    });
    return { handler, accessLogs, consumePreVerify, getAsk };
  };

  it('runs IP block and rate gates before touching the bearer store', async () => {
    const blocked = makeAbuseHarness({ blocked: true });
    const blockedRes = makeRes();
    await blocked.handler(
      buildReq({ method: 'GET', url: '/ask/ask-test-1' }),
      blockedRes as unknown as ServerResponse,
    );
    expect(blockedRes.statusCode).toBe(403);
    expect(blocked.consumePreVerify).not.toHaveBeenCalled();
    expect(blocked.getAsk).not.toHaveBeenCalled();
    expect(blocked.accessLogs.at(-1)).toMatchObject({
      endpoint_id: ASK_LANDING_ENDPOINT_ID,
      action_taken: 'reject',
      outcome: 'rejected',
      url_path_redacted: '/ask/<redacted>',
    });

    const limited = makeAbuseHarness({
      rate: { ok: false, retry_after_at: NOW + 5_001 },
    });
    const limitedRes = makeRes();
    await limited.handler(
      buildReq({ method: 'GET', url: '/ask/ask-test-1' }),
      limitedRes as unknown as ServerResponse,
    );
    expect(limitedRes.statusCode).toBe(429);
    expect(limitedRes.headers['retry-after']).toBe('6');
    expect(limited.getAsk).not.toHaveBeenCalled();
    expect(limited.accessLogs.at(-1)).toMatchObject({
      action_taken: 'rate_limited',
      outcome: 'rate_limited',
    });
  });

  it('uses X-Forwarded-For only when the listener explicitly trusts it', async () => {
    const remote = '203.0.113.10';
    const forwarded = '198.51.100.22';
    const untrusted = makeAbuseHarness({ trustForwardedFor: false });
    await untrusted.handler(buildReq({
      method: 'GET',
      url: '/ask/ask-test-1',
      headers: { 'x-forwarded-for': `${forwarded}, 10.0.0.1` },
      remoteAddress: remote,
    }), makeRes() as unknown as ServerResponse);
    expect(untrusted.consumePreVerify).toHaveBeenCalledWith(expect.objectContaining({
      source_ip_hash: hashSourceIpServerWide(remote, Buffer.alloc(32, 9)),
    }));

    const trusted = makeAbuseHarness({ trustForwardedFor: true });
    await trusted.handler(buildReq({
      method: 'GET',
      url: '/ask/ask-test-1',
      headers: { 'x-forwarded-for': `${forwarded}, 10.0.0.1` },
      remoteAddress: remote,
    }), makeRes() as unknown as ServerResponse);
    expect(trusted.consumePreVerify).toHaveBeenCalledWith(expect.objectContaining({
      source_ip_hash: hashSourceIpServerWide(forwarded, Buffer.alloc(32, 9)),
    }));
  });

  it('logs terminal outcomes without persisting the raw bearer', async () => {
    const harness = makeAbuseHarness();
    const ok = makeRes();
    await harness.handler(
      buildReq({ method: 'GET', url: '/ask/ask-test-1' }),
      ok as unknown as ServerResponse,
    );
    const missing = makeRes();
    await harness.handler(
      buildReq({ method: 'GET', url: '/ask/ask-does-not-exist' }),
      missing as unknown as ServerResponse,
    );
    expect(harness.accessLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({ action_taken: 'view', outcome: 'ok' }),
      expect.objectContaining({ action_taken: 'invalid_token', outcome: 'invalid_token' }),
    ]));
    expect(JSON.stringify(harness.accessLogs)).not.toContain('ask-test-1');
    expect(JSON.stringify(harness.accessLogs)).not.toContain('ask-does-not-exist');
  });

  it('fails closed when the stable pepper is unavailable, before bearer lookup', async () => {
    const harness = makeAbuseHarness({ pepperThrows: true });
    const res = makeRes();
    await harness.handler(
      buildReq({ method: 'GET', url: '/ask/ask-test-1' }),
      res as unknown as ServerResponse,
    );
    expect(res.statusCode).toBe(503);
    expect(harness.getAsk).not.toHaveBeenCalled();
    expect(harness.accessLogs.at(-1)).toMatchObject({
      action_taken: 'view',
      outcome: 'rejected',
      source_ip_hash: null,
      metadata: { rejection_reason: 'pepper_unavailable' },
    });
  });
});
