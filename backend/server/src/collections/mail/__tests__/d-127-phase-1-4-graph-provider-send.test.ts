/** D-127 Phase 1.4 — graph-provider.send tests.
 *
 *  Mirrors the P1.3 gmail shape but pinned to Graph's drafts → send
 *  chain (POST /me/messages then POST /me/messages/{id}/send) so
 *  recipes get the canonical `internetMessageId` back synchronously.
 *
 *  Tests cover:
 *    - sendCapable derives from granted_scopes containing Mail.Send and
 *      Mail.ReadWrite: the send writes a draft first (2026-10-15).
 *    - Graph Message JSON shape (text/plain default, HTML wins when
 *      both supplied, recipient + reply_to arrays, `x-` headers alone).
 *    - happy path: 2-step chain returns SentMessageMeta with
 *      source_id (Graph id) + message_id (internetMessageId) +
 *      thread_id (conversationId).
 *    - a reply: createReply on the email it answers, found by its
 *      Message-ID; attachments after; a new message when the mailbox
 *      does not hold the email (2026-10-15).
 *    - status mapping: 401/403 → MAIL_SEND_AUTH_FAILED,
 *      400 InvalidInternetMessageHeader → MAIL_SEND_MESSAGE_REFUSED,
 *      429 → MAIL_SEND_NETWORK_FAILED,
 *      4xx other → MAIL_SEND_RECIPIENT_INVALID,
 *      5xx + malformed-200 → MAIL_SEND_NETWORK_FAILED.
 *    - 401 once → token refresh → retry succeeds.
 */

import { describe, it, expect } from 'vitest';
import { MAIL_RECONCILIATION_ID_HEADER } from '@recued/contracts';
import { IngredientError } from '@recued/ingredients';
import {
  buildGraphMessage,
  createGraphProvider,
  GRAPH_MODIFY_SCOPE,
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
  granted_scopes: [GRAPH_SEND_SCOPE, GRAPH_MODIFY_SCOPE],
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
  if (init?.method === 'DELETE' && /\/me\/messages\/[^/]+$/.test(url)) return ok(204, '');
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
  it('flips true iff granted_scopes contains Mail.Send and Mail.ReadWrite', () => {
    const cap = newSender({ granted_scopes: [GRAPH_SEND_SCOPE, GRAPH_MODIFY_SCOPE] }, fetcher);
    expect(cap.sendCapable).toBe(true);
    expect(typeof cap.send).toBe('function');

    // ⛔ The send writes a draft first, which needs Mail.ReadWrite (2026-10-15).
    const sendOnly = newSender({ granted_scopes: [GRAPH_SEND_SCOPE] }, fetcher);
    expect(sendOnly.sendCapable).toBe(false);
    expect(sendOnly.send).toBeUndefined();

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

  it('⛔ never writes In-Reply-To / References: Graph refuses any header not named x-', () => {
    // Live, 2026-10-15: "The internet message header name 'In-Reply-To'
    // should start with 'x-' or 'X-'." A reply's come from createReply.
    const reply = {
      to: ['a@example.com'], subject: 're', body_text: 'thx',
      in_reply_to: '<parent@example.com>',
      references: ['<gp@example.com>', '<parent@example.com>'],
    };
    expect(buildGraphMessage(reply).internetMessageHeaders).toBeUndefined();
    const marked = buildGraphMessage({ ...reply, reconciliation_id: 'r-1', automatic: true });
    expect(marked.internetMessageHeaders?.map((header) => header.name).sort())
      .toEqual(['X-Auto-Response-Suppress', MAIL_RECONCILIATION_ID_HEADER].sort());
  });
});

// ────────────────────────────────────────────────────────────────
// 2b. a reply is Outlook's own: createReply on the email it answers
// ────────────────────────────────────────────────────────────────

describe('a Graph reply is Outlook’s own (createReply)', () => {
  const ORIGINAL = { id: 'orig-1', internetMessageId: '<parent@example.com>' };
  const reply: OutgoingMessage = {
    to: ['owner@example.com'],
    subject: 'Re: ask: lunch?',
    body_text: 'Booked for 7.',
    in_reply_to: '<parent@example.com>',
    references: ['<parent@example.com>'],
    reconciliation_id: 'r-1',
  };
  const file = { filename: 'menu.pdf', mime_type: 'application/pdf', bytes_b64: 'JVBERi0=', size_bytes: 5 };

  const replyFetcher = (log: FetchCall[], routes: {
    lookup?: { status: number; body: unknown };
    attachmentStatuses?: number[];
    createReplyBody?: unknown;
    sendStatus?: number;
  } = {}): HttpFetcher => {
    const attachmentStatuses = [...(routes.attachmentStatuses ?? [])];
    return async (url, init) => {
      log.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
      if (url === providerConfig.tokenUrl) return tokenResponse;
      const path = new URL(url).pathname;
      if ((init?.method ?? 'GET') === 'GET' && path.endsWith('/me/messages')) {
        return ok(routes.lookup?.status ?? 200, routes.lookup?.body ?? { value: [ORIGINAL] });
      }
      if (init?.method === 'POST' && path.endsWith('/me/messages/orig-1/createReply')) {
        return ok(201, routes.createReplyBody
          ?? { id: 'reply-1', internetMessageId: '<reply-1@outlook.example>', conversationId: 'conv-9' });
      }
      if (init?.method === 'POST' && path.endsWith('/me/messages')) {
        return ok(201, { id: 'new-1', internetMessageId: '<new-1@outlook.example>', conversationId: 'conv-new' });
      }
      if (init?.method === 'POST' && path.endsWith('/attachments')) return ok(attachmentStatuses.shift() ?? 201, {});
      if (init?.method === 'POST' && path.endsWith('/send')) {
        return ok(routes.sendStatus ?? 202, routes.sendStatus === undefined ? '' : { error: { code: 'ErrorAccountSuspend' } });
      }
      if (init?.method === 'DELETE') return ok(204, '');
      return ok(404, { error: 'unmapped', url });
    };
  };
  const calls = (log: FetchCall[]) => log
    .filter((call) => !call.url.includes('/oauth2/'))
    .map((call) => `${call.method ?? 'GET'} ${new URL(call.url).pathname.replace(/^\/v1\.0/, '')}`);

  it('finds the email by its Message-ID, replies to it, and sends the reply', async () => {
    const log: FetchCall[] = [];
    const provider = newSender({}, replyFetcher(log));
    assertSendCapable(provider);
    const meta = await provider.send(reply);

    expect(calls(log)).toEqual([
      'GET /me/messages',
      'POST /me/messages/orig-1/createReply',
      'POST /me/messages/reply-1/send',
    ]);
    const lookup = new URL(log.find((call) => (call.method ?? 'GET') === 'GET')!.url);
    expect(lookup.searchParams.get('$filter')).toBe("internetMessageId eq '<parent@example.com>'");
    const body = JSON.parse(log.find((call) => call.url.endsWith('/createReply'))!.body!) as {
      message: { subject: string; body: unknown; toRecipients: unknown; internetMessageHeaders?: Array<{ name: string }> };
      comment?: string;
    };
    expect(body.message).toMatchObject({
      subject: 'Re: ask: lunch?',
      body: { contentType: 'Text', content: 'Booked for 7.' },
      toRecipients: [{ emailAddress: { address: 'owner@example.com' } }],
    });
    // Graph returns 400 for a comment beside a body.
    expect(body.comment).toBeUndefined();
    expect(body.message.internetMessageHeaders?.map((header) => header.name)).toEqual([MAIL_RECONCILIATION_ID_HEADER]);
    expect(meta).toMatchObject({ source_id: 'reply-1', message_id: '<reply-1@outlook.example>', thread_id: 'conv-9' });
  });

  it('a reply to an email this mailbox does not hold goes as a new message, unthreaded', async () => {
    const log: FetchCall[] = [];
    const provider = newSender({}, replyFetcher(log, { lookup: { status: 200, body: { value: [] } } }));
    assertSendCapable(provider);
    const meta = await provider.send(reply);
    expect(calls(log)).toEqual(['GET /me/messages', 'POST /me/messages', 'POST /me/messages/new-1/send']);
    const created = JSON.parse(log.find((call) => call.method === 'POST' && call.url.endsWith('/me/messages'))!.body!) as {
      internetMessageHeaders?: Array<{ name: string }>;
    };
    expect(created.internetMessageHeaders?.map((header) => header.name)).toEqual([MAIL_RECONCILIATION_ID_HEADER]);
    expect(meta.source_id).toBe('new-1');
  });

  it('only an exact Message-ID is the email replied to', async () => {
    const log: FetchCall[] = [];
    const provider = newSender({}, replyFetcher(log, {
      lookup: { status: 200, body: { value: [{ id: 'other', internetMessageId: '<parent@example.com.evil>' }] } },
    }));
    assertSendCapable(provider);
    await provider.send(reply);
    expect(calls(log)).not.toContain('POST /me/messages/other/createReply');
    expect(calls(log)).toContain('POST /me/messages');
  });

  it('adds a reply’s attachments to its draft, then sends it', async () => {
    const log: FetchCall[] = [];
    const provider = newSender({}, replyFetcher(log));
    assertSendCapable(provider);
    await provider.send({ ...reply, attachments: [file] });
    expect(calls(log)).toEqual([
      'GET /me/messages',
      'POST /me/messages/orig-1/createReply',
      'POST /me/messages/reply-1/attachments',
      'POST /me/messages/reply-1/send',
    ]);
    const created = JSON.parse(log.find((call) => call.url.endsWith('/createReply'))!.body!) as { message: { attachments?: unknown } };
    expect(created.message.attachments).toBeUndefined();
    expect(JSON.parse(log.find((call) => call.url.endsWith('/attachments'))!.body!)).toEqual({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'menu.pdf',
      contentType: 'application/pdf',
      contentBytes: 'JVBERi0=',
    });
  });

  it('a reply whose attachment is refused is deleted and not sent', async () => {
    const log: FetchCall[] = [];
    const provider = newSender({}, replyFetcher(log, { attachmentStatuses: [413] }));
    assertSendCapable(provider);
    const err = await provider.send({ ...reply, attachments: [file] }).then(() => null, (caught: unknown) => caught);
    expect(err).toBeInstanceOf(IngredientError);
    expect((err as IngredientError).details).toMatchObject({ status: 413, not_sent: true });
    expect(calls(log)).toContain('DELETE /me/messages/reply-1');
    expect(calls(log).some((call) => call.endsWith('/send'))).toBe(false);
  });

  it('⛔ a reply whose send is refused leaves no draft behind', async () => {
    const log: FetchCall[] = [];
    const provider = newSender({}, replyFetcher(log, { sendStatus: 403 }));
    assertSendCapable(provider);
    const err = await provider.send(reply).then(() => null, (caught: unknown) => caught);
    expect((err as IngredientError).code).toBe('MAIL_SEND_AUTH_FAILED');
    expect(calls(log).slice(-2)).toEqual(['POST /me/messages/reply-1/send', 'DELETE /me/messages/reply-1']);
  });

  it('a lookup that fails sends nothing, rather than a reply unthreaded', async () => {
    const log: FetchCall[] = [];
    const provider = newSender({}, replyFetcher(log, { lookup: { status: 503, body: { error: { code: 'ServiceUnavailable' } } } }));
    assertSendCapable(provider);
    const err = await provider.send(reply).then(() => null, (caught: unknown) => caught);
    expect((err as IngredientError).code).toBe('MAIL_SEND_NETWORK_FAILED');
    expect((err as IngredientError).details).toMatchObject({ status: 503, not_sent: true });
    expect(calls(log)).toEqual(['GET /me/messages']);
  });

  it('⛔ a new message’s files go one per request too: inline, two 2 MB files made one request over Graph’s 4 MB', async () => {
    // "Write requests in the Microsoft Graph API have a size limit of 4 MB",
    // base64 included ("Use the Microsoft Graph API"); "To attach multiple files
    // to a message, … attach the files individually" ("Attach large files to
    // Outlook messages"), each under 3 MB.
    const log: FetchCall[] = [];
    const provider = newSender({}, replyFetcher(log));
    assertSendCapable(provider);
    const twoMb = (filename: string) => ({
      filename, mime_type: 'application/pdf', size_bytes: 2_000_000, bytes_b64: Buffer.alloc(2_000_000, 1).toString('base64'),
    });
    await provider.send({ ...minimalMsg, attachments: [twoMb('a.pdf'), twoMb('b.pdf')] });
    expect(calls(log)).toEqual([
      'POST /me/messages',
      'POST /me/messages/new-1/attachments',
      'POST /me/messages/new-1/attachments',
      'POST /me/messages/new-1/send',
    ]);
    const created = JSON.parse(log.find((call) => call.method === 'POST' && call.url.endsWith('/me/messages'))!.body!) as {
      attachments?: unknown;
    };
    expect(created.attachments).toBeUndefined();
    for (const call of log) expect((call.body ?? '').length, call.url).toBeLessThan(4_000_000);
  });

  it('a new message whose file is refused is deleted and not sent: the message refused', async () => {
    const log: FetchCall[] = [];
    const provider = newSender({}, replyFetcher(log, { attachmentStatuses: [201, 413] }));
    assertSendCapable(provider);
    const err = await provider.send({ ...minimalMsg, attachments: [file, { ...file, filename: 'scan.pdf' }] })
      .then(() => null, (caught: unknown) => caught);
    expect((err as IngredientError).code).toBe('MAIL_SEND_MESSAGE_REFUSED');
    expect((err as IngredientError).details).toMatchObject({ status: 413, not_sent: true });
    expect(calls(log)).toContain('DELETE /me/messages/new-1');
    expect(calls(log).some((call) => call.endsWith('/send'))).toBe(false);
  });

  it('a new saved draft takes its files one per request as well', async () => {
    const log: FetchCall[] = [];
    const provider = newSender({}, replyFetcher(log));
    const saved = await provider.saveDraft!({ ...minimalMsg, attachments: [file] });
    expect(saved.source_id).toBe('new-1');
    expect(calls(log)).toEqual(['POST /me/messages', 'POST /me/messages/new-1/attachments']);
  });

  it('a saved reply draft is Outlook’s reply too, with the draft taxonomy', async () => {
    const log: FetchCall[] = [];
    const provider = newSender({}, replyFetcher(log));
    const saved = await provider.saveDraft!(reply);
    expect(saved.source_id).toBe('reply-1');
    expect(calls(log)).toEqual(['GET /me/messages', 'POST /me/messages/orig-1/createReply']);
    const refused = newSender({}, replyFetcher([], { lookup: { status: 403, body: {} } }));
    await expect(refused.saveDraft!(reply)).rejects.toMatchObject({ code: 'MAIL_DRAFT_AUTH_FAILED' });
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
        // Only a draft was attempted: nothing was sent.
        not_sent: true,
      });
    }
  });

  it('429 (throttled) → MAIL_SEND_NETWORK_FAILED, not a recipient', async () => {
    const throttled = { error: { code: 'ApplicationThrottled', message: 'Application is over its MailboxConcurrency limit.' } };
    const provider = newSender({}, makeChainFetcher({ createStatus: 429, createBody: throttled }, []));
    assertSendCapable(provider);
    const err = await provider.send(minimalMsg).then(() => null, (caught: unknown) => caught);
    expect((err as IngredientError).code).toBe('MAIL_SEND_NETWORK_FAILED');
    expect((err as IngredientError).details).toMatchObject({ kind: 'graph', status: 429, not_sent: true });
  });

  it('413 (a request over Graph’s 4 MB write cap) → MAIL_SEND_MESSAGE_REFUSED, not a recipient', async () => {
    // "Requests exceeding the size limit fail with the status code HTTP 413, and
    // the error message 'Request entity too large'" ("Use the Microsoft Graph API").
    const provider = newSender({}, makeChainFetcher({ createStatus: 413, createBody: 'Request entity too large' }, []));
    assertSendCapable(provider);
    const err = await provider.send(minimalMsg).then(() => null, (caught: unknown) => caught);
    expect((err as IngredientError).code).toBe('MAIL_SEND_MESSAGE_REFUSED');
    expect((err as IngredientError).details).toMatchObject({ kind: 'graph', status: 413, not_sent: true });
  });

  it('400 InvalidInternetMessageHeader → MAIL_SEND_MESSAGE_REFUSED, not a recipient', async () => {
    // The body Graph sent back live, 2026-10-15, for an In-Reply-To header.
    const refusal = { error: { code: 'InvalidInternetMessageHeader',
      message: "The internet message header name 'In-Reply-To' should start with 'x-' or 'X-'." } };
    const provider = newSender({}, makeChainFetcher({ createStatus: 400, createBody: refusal }, []));
    assertSendCapable(provider);
    const err = await provider.send(minimalMsg).then(() => null, (caught: unknown) => caught);
    expect((err as IngredientError).code).toBe('MAIL_SEND_MESSAGE_REFUSED');
    expect((err as IngredientError).details).toMatchObject({ kind: 'graph', status: 400, not_sent: true });
  });

  it('⛔ a send refused after its draft was made (4xx) deletes the draft: each try would leave another', async () => {
    // As Graph answered live (2026-10-15) for an account whose sending
    // Microsoft had suspended: four refused answers left four drafts.
    const suspended = { error: { code: 'ErrorAccountSuspend', message: 'Account suspended. Follow the instructions in your Inbox to verify your account.' } };
    const log: FetchCall[] = [];
    const provider = newSender({}, makeChainFetcher({
      createStatus: 201, createBody: { id: 'draft-1', internetMessageId: '<i@example.com>' }, sendStatus: 403, sendBody: suspended,
    }, log));
    assertSendCapable(provider);
    const err = await provider.send(minimalMsg).then(() => null, (caught: unknown) => caught);
    expect((err as IngredientError).code).toBe('MAIL_SEND_AUTH_FAILED');
    expect((err as IngredientError).details).toMatchObject({ status: 403, not_sent: true });
    const deletes = log.filter((call) => call.method === 'DELETE').map((call) => new URL(call.url).pathname);
    expect(deletes).toEqual(['/v1.0/me/messages/draft-1']);
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
      // The draft existed and the send step failed with a 5xx: unknown.
      expect((err as IngredientError).details?.not_sent).toBeUndefined();
      // So the draft stays: it may be the message on its way.
      expect(log.filter((call) => call.method === 'DELETE')).toEqual([]);
    }
  });

  it('a create-draft step that fails any way at all sent nothing (`not_sent`)', async () => {
    const provider = newSender({}, (async () => {
      throw new TypeError('fetch failed');
    }) as never);
    assertSendCapable(provider);
    const err = await provider.send(minimalMsg).then(() => null, (caught: unknown) => caught);
    expect(err).toBeInstanceOf(IngredientError);
    expect((err as IngredientError).code).toBe('MAIL_SEND_NETWORK_FAILED');
    expect((err as IngredientError).details).toMatchObject({ kind: 'graph', not_sent: true });
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
