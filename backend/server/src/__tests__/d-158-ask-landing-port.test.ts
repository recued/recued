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
  createAskLandingPortHandler,
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
}): IncomingMessage => {
  const chunks = opts.body === undefined ? [] : [Buffer.from(opts.body, 'utf8')];
  const stream = Readable.from(chunks) as unknown as IncomingMessage;
  (stream as unknown as { method: string }).method = opts.method;
  (stream as unknown as { url: string }).url = opts.url;
  (stream as unknown as { headers: Record<string, string> }).headers =
    opts.headers ?? {};
  return stream;
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
    // Still valid for the right ask within the window…
    const fresh = store.issue('ask-1', NOW);
    expect(store.consume('ask-1', fresh, NOW + ASK_LANDING_NONCE_TTL_MS + 1)).toBe(
      false,
    );
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
