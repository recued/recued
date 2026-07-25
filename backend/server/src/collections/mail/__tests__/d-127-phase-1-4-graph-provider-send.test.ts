/** D-127 Phase 1.4 — graph-provider.send tests.
 *
 *  Mirrors the P1.3 gmail shape but pinned to Graph's drafts → send
 *  chain (POST /me/messages then POST /me/messages/{id}/send) so
 *  recipes get the canonical `internetMessageId` back synchronously.
 *
 *  Tests cover:
 *    - sendCapable derives from granted_scopes containing Mail.Send.
 *    - Graph Message JSON shape (text/plain default, HTML wins when
 *      both supplied, recipient + reply_to + threading-header arrays).
 *    - happy path: 2-step chain returns SentMessageMeta with
 *      source_id (Graph id) + message_id (internetMessageId) +
 *      thread_id (conversationId).
 *    - status mapping: 401/403 → MAIL_SEND_AUTH_FAILED,
 *      4xx other → MAIL_SEND_RECIPIENT_INVALID,
 *      5xx + malformed-200 → MAIL_SEND_NETWORK_FAILED.
 *    - 401 once → token refresh → retry succeeds.
 */

import { describe, it, expect } from 'vitest';
import { IngredientError } from '@recued/ingredients';
import {
  buildGraphMessage,
  createGraphProvider,
  GRAPH_SEND_SCOPE,
  type GraphProviderConfig,
} from '../graph-provider.js';
import {
  assertSendCapable,
  type OutgoingMessage,
} from '../provider.js';
import type { HttpFetcher, OAuthAccountStore, OAuthProviderConfig } from '../oauth.js';

// ────────────────────────────────────────────────────────────────
// Harness
// ────────────────────────────────────────────────────────────────

const providerConfig: OAuthProviderConfig = {
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  clientId: 'cid',
};

const makeStore = (
  seed: Record<string, string> = {},
): OAuthAccountStore & { data: Map<string, string> } => {
  const data = new Map<string, string>(Object.entries(seed));
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
  };
};

const mkConfig = (
  overrides: Partial<GraphProviderConfig> = {},
): GraphProviderConfig => ({
  account_slug: 'work',
  backfill_days: 7,
  poll_seconds: 30,
  granted_scopes: [GRAPH_SEND_SCOPE],
  ...overrides,
});

interface FetchCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface ChainResponse {
  /** Status for the create-draft POST (`/me/messages`). */
  createStatus: number;
  /** Body returned for the create-draft POST. */
  createBody: unknown;
  /** Status for the send-draft POST (`/me/messages/{id}/send`).
   *  Defaults to 202 (Graph's accepted-empty-body shape). */
  sendStatus?: number;
  /** Body returned for the send-draft POST. Defaults to ''. */
  sendBody?: unknown;
}

const tokenResponse = {
  status: 200, ok: true,
  async json() { return { access_token: 'at-fresh', expires_in: 3600 }; },
  async text() { return '{}'; },
};

const ok = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  async json() { return body; },
  async text() {
    return typeof body === 'string' ? body : JSON.stringify(body);
  },
});

const makeChainFetcher = (
  chain: ChainResponse,
  log: FetchCall[],
): HttpFetcher => async (url, init) => {
  log.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
  if (url === providerConfig.tokenUrl) {
    return tokenResponse;
  }
  if (init?.method === 'POST' && url.endsWith('/me/messages')) {
    return ok(chain.createStatus, chain.createBody);
  }
  if (init?.method === 'POST' && /\/me\/messages\/.+\/send$/.test(url)) {
    return ok(chain.sendStatus ?? 202, chain.sendBody ?? '');
  }
  return ok(404, { error: 'unmapped', url });
};

const newSender = (
  cfgOverrides: Partial<GraphProviderConfig>,
  fetcher: HttpFetcher,
) => {
  const store = makeStore({
    'graph.work.access_token': 'at-seed',
    'graph.work.expires_at': String(Date.now() + 3600_000),
    'graph.work.refresh_token': 'rt-seed',
  });
  return createGraphProvider({
    slug: 'work',
    config: () => mkConfig(cfgOverrides),
    accountStore: store,
    providerConfig,
    fetcher,
    scheduler: () => () => undefined,
  });
};

const minimalMsg: OutgoingMessage = {
  to: ['bob@example.com'],
  subject: 'hello',
  body_text: 'world',
};

// ────────────────────────────────────────────────────────────────
// 1. sendCapable wired to scope-presence check
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.4 — sendCapable scope wiring', () => {
  const fetcher: HttpFetcher = async () => ok(200, {});
  it('flips true iff granted_scopes contains Mail.Send', () => {
    const cap = newSender({ granted_scopes: [GRAPH_SEND_SCOPE] }, fetcher);
    expect(cap.sendCapable).toBe(true);
    expect(typeof cap.send).toBe('function');

    const noScope = newSender({ granted_scopes: ['Mail.Read'] }, fetcher);
    expect(noScope.sendCapable).toBe(false);
    expect(noScope.send).toBeUndefined();

    const empty = newSender({ granted_scopes: [] }, fetcher);
    expect(empty.sendCapable).toBe(false);
    expect(empty.send).toBeUndefined();

    const undef = newSender({ granted_scopes: undefined }, fetcher);
    expect(undef.sendCapable).toBe(false);
    expect(undef.send).toBeUndefined();
  });

  it('assertSendCapable narrows on a send-capable graph provider', () => {
    const provider = newSender({}, fetcher);
    expect(() => assertSendCapable(provider)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Graph Message JSON construction (pure)
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.4 — buildGraphMessage', () => {
  it('produces text-only body when body_html is omitted', () => {
    const m = buildGraphMessage({ to: ['a@example.com'], subject: 's', body_text: 'b' });
    expect(m.subject).toBe('s');
    expect(m.body).toEqual({ contentType: 'Text', content: 'b' });
    expect(m.toRecipients).toEqual([{ emailAddress: { address: 'a@example.com' } }]);
    expect(m.ccRecipients).toBeUndefined();
    expect(m.bccRecipients).toBeUndefined();
    expect(m.replyTo).toBeUndefined();
    expect(m.internetMessageHeaders).toBeUndefined();
  });

  it('uses HTML body when body_html is supplied (Graph body is single-structure, not multipart)', () => {
    const m = buildGraphMessage({
      to: ['a@example.com'], subject: 's', body_text: 'plain', body_html: '<p>rich</p>',
    });
    expect(m.body).toEqual({ contentType: 'HTML', content: '<p>rich</p>' });
  });

  it('maps cc / bcc / reply_to into the corresponding recipient arrays', () => {
    const m = buildGraphMessage({
      to: ['a@example.com'],
      cc: ['c@example.com'],
      bcc: ['d@example.com'],
      subject: 's',
      body_text: 'b',
      reply_to: 'r@example.com',
    });
    expect(m.ccRecipients).toEqual([{ emailAddress: { address: 'c@example.com' } }]);
    expect(m.bccRecipients).toEqual([{ emailAddress: { address: 'd@example.com' } }]);
    expect(m.replyTo).toEqual([{ emailAddress: { address: 'r@example.com' } }]);
  });

  it('emits threading headers via internetMessageHeaders (In-Reply-To / References)', () => {
    const m = buildGraphMessage({
      to: ['a@example.com'], subject: 're', body_text: 'thx',
      in_reply_to: '<parent@example.com>',
      references: ['<gp@example.com>', '<parent@example.com>'],
    });
    expect(m.internetMessageHeaders).toEqual([
      { name: 'In-Reply-To', value: '<parent@example.com>' },
      { name: 'References', value: '<gp@example.com> <parent@example.com>' },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. send() — happy path drafts → send chain
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.4 — send() happy path', () => {
  it('POSTs draft + send and maps SentMessageMeta from the create-draft response', async () => {
    const log: FetchCall[] = [];
    const fetcher = makeChainFetcher(
      {
        createStatus: 201,
        createBody: {
          id: 'draft-123',
          internetMessageId: '<imid-abc@example.com>',
          conversationId: 'conv-1',
        },
        sendStatus: 202,
        sendBody: '',
      },
      log,
    );
    const provider = newSender({}, fetcher);
    assertSendCapable(provider);
    const meta = await provider.send({
      ...minimalMsg,
      cc: ['c@example.com'],
      reply_to: 'r@example.com',
    });

    expect(meta).toMatchObject({
      source_id: 'draft-123',
      message_id: '<imid-abc@example.com>',
      thread_id: 'conv-1',
    });
    expect(typeof meta.sent_at).toBe('number');

    // Two POSTs in order: create draft, then send draft.
    const posts = log.filter((c) => c.method === 'POST' && !c.url.includes('/oauth2/'));
    expect(posts).toHaveLength(2);
    expect(posts[0]?.url.endsWith('/me/messages')).toBe(true);
    expect(posts[1]?.url).toMatch(/\/me\/messages\/draft-123\/send$/);
    expect(posts[0]?.headers?.Authorization).toMatch(/^Bearer /);
    expect(posts[0]?.headers?.['Content-Type']).toBe('application/json');

    // Body of create-draft round-trips OutgoingMessage → Graph JSON.
    const createBody = posts[0]?.body ? JSON.parse(posts[0].body) : null;
    expect(createBody).toMatchObject({
      subject: 'hello',
      body: { contentType: 'Text', content: 'world' },
      toRecipients: [{ emailAddress: { address: 'bob@example.com' } }],
      ccRecipients: [{ emailAddress: { address: 'c@example.com' } }],
      replyTo: [{ emailAddress: { address: 'r@example.com' } }],
    });
  });

  it('falls back to draft.id for message_id when internetMessageId is missing', async () => {
    const log: FetchCall[] = [];
    const fetcher = makeChainFetcher(
      {
        createStatus: 201,
        createBody: { id: 'draft-no-imid', conversationId: 'c' },
      },
      log,
    );
    const provider = newSender({}, fetcher);
    assertSendCapable(provider);
    const meta = await provider.send(minimalMsg);
    expect(meta.source_id).toBe('draft-no-imid');
    expect(meta.message_id).toBe('draft-no-imid');
  });
});

// ────────────────────────────────────────────────────────────────
// 4. send() — error mapping
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.4 — send() error taxonomy', () => {
  it('401 (after refresh retry also 401) → MAIL_SEND_AUTH_FAILED', async () => {
    const log: FetchCall[] = [];
    const fetcher: HttpFetcher = async (url, init) => {
      log.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
      if (url === providerConfig.tokenUrl) return tokenResponse;
      // Always 401, even after refresh.
      return ok(401, { error: { code: 'unauth', message: 'token expired' } });
    };
    const provider = newSender({}, fetcher);
    assertSendCapable(provider);
    try {
      await provider.send(minimalMsg);
      expect.fail('expected MAIL_SEND_AUTH_FAILED');
    } catch (err) {
      expect(err).toBeInstanceOf(IngredientError);
      expect((err as IngredientError).code).toBe('MAIL_SEND_AUTH_FAILED');
      expect((err as IngredientError).details).toMatchObject({
        kind: 'graph', slug: 'work', status: 401,
      });
    }
    // Token refresh fired at least once.
    expect(log.some((c) => c.url === providerConfig.tokenUrl)).toBe(true);
  });

  it('401 once on create-draft → forced refresh → retry succeeds', async () => {
    let createCalls = 0;
    const fetcher: HttpFetcher = async (url, init) => {
      if (url === providerConfig.tokenUrl) return tokenResponse;
      if (init?.method === 'POST' && url.endsWith('/me/messages')) {
        createCalls++;
        if (createCalls === 1) return ok(401, { error: 'expired' });
        return ok(201, {
          id: 'draft-after-refresh',
          internetMessageId: '<imid@example.com>',
          conversationId: 'c',
        });
      }
      if (init?.method === 'POST' && /\/me\/messages\/.+\/send$/.test(url)) {
        return ok(202, '');
      }
      return ok(404, 'nope');
    };
    const provider = newSender({}, fetcher);
    assertSendCapable(provider);
    const meta = await provider.send(minimalMsg);
    expect(meta.source_id).toBe('draft-after-refresh');
    expect(createCalls).toBe(2);
  });

  it('403 on create-draft (insufficient scope) → MAIL_SEND_AUTH_FAILED', async () => {
    const log: FetchCall[] = [];
    const fetcher = makeChainFetcher(
      { createStatus: 403, createBody: { error: { code: 'Forbidden', message: 'insufficient' } } },
      log,
    );
    const provider = newSender({}, fetcher);
    assertSendCapable(provider);
    try {
      await provider.send(minimalMsg);
      expect.fail('expected MAIL_SEND_AUTH_FAILED');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_AUTH_FAILED');
    }
  });

  it('400 on create-draft (recipient rejected) → MAIL_SEND_RECIPIENT_INVALID', async () => {
    const log: FetchCall[] = [];
    const fetcher = makeChainFetcher(
      {
        createStatus: 400,
        createBody: { error: { code: 'BadRequest', message: 'Invalid recipient' } },
      },
      log,
    );
    const provider = newSender({}, fetcher);
    assertSendCapable(provider);
    try {
      await provider.send({ ...minimalMsg, to: ['not-an-email'] });
      expect.fail('expected MAIL_SEND_RECIPIENT_INVALID');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_RECIPIENT_INVALID');
      expect((err as IngredientError).details).toMatchObject({
        kind: 'graph', status: 400,
      });
    }
  });

  it('5xx on send-draft (after draft created) → MAIL_SEND_NETWORK_FAILED', async () => {
    const log: FetchCall[] = [];
    const fetcher = makeChainFetcher(
      {
        createStatus: 201,
        createBody: { id: 'draft-1', internetMessageId: '<i@example.com>' },
        sendStatus: 503,
        sendBody: { error: { code: 'ServiceUnavailable' } },
      },
      log,
    );
    const provider = newSender({}, fetcher);
    assertSendCapable(provider);
    try {
      await provider.send(minimalMsg);
      expect.fail('expected MAIL_SEND_NETWORK_FAILED');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_NETWORK_FAILED');
      expect((err as IngredientError).details).toMatchObject({ status: 503 });
    }
  });

  it('201 with malformed create-draft response (no id) → MAIL_SEND_NETWORK_FAILED', async () => {
    const log: FetchCall[] = [];
    const fetcher = makeChainFetcher(
      { createStatus: 201, createBody: { conversationId: 'c' } },
      log,
    );
    const provider = newSender({}, fetcher);
    assertSendCapable(provider);
    try {
      await provider.send(minimalMsg);
      expect.fail('expected MAIL_SEND_NETWORK_FAILED');
    } catch (err) {
      expect((err as IngredientError).code).toBe('MAIL_SEND_NETWORK_FAILED');
    }
  });
});
