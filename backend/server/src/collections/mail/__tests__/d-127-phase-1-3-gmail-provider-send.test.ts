/** D-127 Phase 1.3 — gmail-provider.send tests.
 *
 *  Pins the wire shape:
 *    - sendCapable derives from `granted_scopes` containing
 *      `https://www.googleapis.com/auth/gmail.send`.
 *    - send() POSTs base64url-encoded RFC 5322 to
 *      `users/me/messages/send`.
 *    - text-only body emits `Content-Type: text/plain`; supplying
 *      body_html upgrades to `multipart/alternative`.
 *    - threading headers (In-Reply-To / References / Reply-To)
 *      flow into the RFC 5322 verbatim.
 *    - status mapping: 401/403 → MAIL_SEND_AUTH_FAILED,
 *      4xx other → MAIL_SEND_RECIPIENT_INVALID,
 *      5xx → MAIL_SEND_NETWORK_FAILED.
 *    - 401 once → token refresh → retry succeeds.
 */

import { describe, it, expect } from 'vitest';
import { IngredientError } from '@recued/ingredients';
import {
  buildGmailRfc5322,
  createGmailProvider,
  GMAIL_SEND_SCOPE,
  type GmailProviderConfig,
} from '../gmail-provider.js';
import {
  assertSendCapable,
  type OutgoingMessage,
} from '../provider.js';
import type { HttpFetcher, OAuthAccountStore, OAuthProviderConfig } from '../oauth.js';

// ────────────────────────────────────────────────────────────────
// Harness (parallel to gmail-provider.test.ts but scoped to send)
// ────────────────────────────────────────────────────────────────

const providerConfig: OAuthProviderConfig = {
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientId: 'cid',
  clientSecret: 'csecret',
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
  overrides: Partial<GmailProviderConfig> = {},
): GmailProviderConfig => ({
  account_slug: 'work',
  backfill_days: 7,
  poll_seconds: 30,
  granted_scopes: [GMAIL_SEND_SCOPE],
  ...overrides,
});

interface SendCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface SendCanary {
  status: number;
  body: unknown;
  /** Optional callback invoked with the raw RFC 5322 (after base64url
   *  decode) for header / multipart assertions. */
  onSend?: (rfc822: string) => void;
}

const decodeRaw = (b64url: string): string => {
  const padded = b64url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(b64url.length + ((4 - b64url.length % 4) % 4), '=');
  return Buffer.from(padded, 'base64').toString('utf-8');
};

const makeSendFetcher = (
  canary: SendCanary,
  log: SendCall[],
): HttpFetcher => async (url, init) => {
  log.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
  if (url === 'https://oauth2.googleapis.com/token') {
    return {
      status: 200, ok: true,
      async json() { return { access_token: 'at-fresh', expires_in: 3600 }; },
      async text() { return '{}'; },
    };
  }
  if (url.endsWith('/messages/send') && init?.method === 'POST') {
    if (canary.onSend && init?.body) {
      const parsed = JSON.parse(init.body) as { raw?: string };
      if (parsed.raw) canary.onSend(decodeRaw(parsed.raw));
    }
    return {
      status: canary.status,
      ok: canary.status >= 200 && canary.status < 300,
      async json() { return canary.body; },
      async text() {
        return typeof canary.body === 'string' ? canary.body : JSON.stringify(canary.body);
      },
    };
  }
  return {
    status: 404, ok: false,
    async json() { return { error: 'unmapped', url }; },
    async text() { return `unmapped ${url}`; },
  };
};

const newSender = (
  cfgOverrides: Partial<GmailProviderConfig>,
  fetcher: HttpFetcher,
) => {
  const store = makeStore({
    'gmail.work.access_token': 'at-seed',
    'gmail.work.expires_at': String(Date.now() + 3600_000),
    'gmail.work.refresh_token': 'rt-seed',
  });
  return createGmailProvider({
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

describe('D-127 P1.3 — sendCapable scope wiring', () => {
  it('flips true iff granted_scopes contains gmail.send', () => {
    const fetcher: HttpFetcher = async () => ({
      status: 200, ok: true, async json() { return {}; }, async text() { return ''; },
    });
    const cap = newSender({ granted_scopes: [GMAIL_SEND_SCOPE] }, fetcher);
    expect(cap.sendCapable).toBe(true);
    expect(typeof cap.send).toBe('function');

    const noScope = newSender({ granted_scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }, fetcher);
    expect(noScope.sendCapable).toBe(false);
    expect(noScope.send).toBeUndefined();

    const empty = newSender({ granted_scopes: [] }, fetcher);
    expect(empty.sendCapable).toBe(false);
    expect(empty.send).toBeUndefined();

    const undef = newSender({ granted_scopes: undefined }, fetcher);
    expect(undef.sendCapable).toBe(false);
    expect(undef.send).toBeUndefined();
  });

  it('assertSendCapable narrows on a send-capable gmail provider', () => {
    const fetcher: HttpFetcher = async () => ({
      status: 200, ok: true, async json() { return {}; }, async text() { return ''; },
    });
    const provider = newSender({}, fetcher);
    expect(() => assertSendCapable(provider)).not.toThrow();
  });
});

// ────────────────────────────────────────────────────────────────
// 2. RFC 5322 construction (pure)
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.3 — buildGmailRfc5322', () => {
  it('produces text/plain headers + body when body_html is omitted', () => {
    const out = buildGmailRfc5322(
      { to: ['a@example.com'], subject: 'hi', body_text: 'hello' },
      Date.UTC(2024, 0, 1, 10, 0, 0),
    );
    expect(out).toContain('MIME-Version: 1.0');
    expect(out).toContain('To: a@example.com');
    expect(out).toContain('Subject: hi');
    expect(out).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(out.endsWith('hello')).toBe(true);
    // Header / body separator is CRLF CRLF.
    expect(out).toContain('\r\n\r\n');
  });

  it('produces multipart/alternative + both parts when body_html is set', () => {
    const out = buildGmailRfc5322(
      {
        to: ['a@example.com'], cc: ['c@example.com'], bcc: ['d@example.com'],
        subject: 'hi', body_text: 'plain', body_html: '<p>rich</p>',
      },
      Date.UTC(2024, 0, 1, 10, 0, 0),
      () => 0.42, // deterministic boundary suffix
    );
    expect(out).toMatch(/Content-Type: multipart\/alternative; boundary="recued_[a-z0-9_]+"/);
    expect(out).toContain('Cc: c@example.com');
    expect(out).toContain('Bcc: d@example.com');
    // Both parts present.
    expect(out).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(out).toContain('Content-Type: text/html; charset=UTF-8');
    expect(out).toContain('plain');
    expect(out).toContain('<p>rich</p>');
    // Closing boundary delimiter is the multipart/alternative terminator.
    expect(out).toMatch(/--recued_[a-z0-9_]+--$/);
  });

  it('emits threading headers verbatim (In-Reply-To / References / Reply-To)', () => {
    const out = buildGmailRfc5322(
      {
        to: ['a@example.com'], subject: 're', body_text: 'thx',
        in_reply_to: '<parent@example.com>',
        references: ['<gp@example.com>', '<parent@example.com>'],
        reply_to: 'replies@example.com',
      },
      Date.UTC(2024, 0, 1, 10, 0, 0),
    );
    expect(out).toContain('In-Reply-To: <parent@example.com>');
    expect(out).toContain('References: <gp@example.com> <parent@example.com>');
    expect(out).toContain('Reply-To: replies@example.com');
  });

  it('serializes Date header in RFC 5322 +0000 form (not GMT)', () => {
    const out = buildGmailRfc5322(
      { to: ['a@example.com'], subject: 's', body_text: 'b' },
      Date.UTC(2024, 0, 1, 10, 0, 0),
    );
    expect(out).toMatch(/Date: Mon, 01 Jan 2024 10:00:00 \+0000/);
    expect(out).not.toContain(' GMT\r\n');
  });
});

// ────────────────────────────────────────────────────────────────
// 3. send() — happy path + canonical output mapping
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.3 — send() happy path', () => {
  it('POSTs base64url raw and returns SentMessageMeta from response', async () => {
    const log: SendCall[] = [];
    let captured = '';
    const fetcher = makeSendFetcher(
      {
        status: 200,
        body: { id: 'gm-123', threadId: 'th-1', labelIds: ['SENT', 'INBOX'] },
        onSend: (rfc822) => { captured = rfc822; },
      },
      log,
    );
    const provider = newSender({}, fetcher);
    assertSendCapable(provider);
    const meta = await provider.send({
      ...minimalMsg,
      cc: ['c@example.com'],
      reply_to: 'r@example.com',
      in_reply_to: '<p@example.com>',
    });

    expect(meta).toMatchObject({
      source_id: 'gm-123',
      message_id: 'gm-123',
      thread_id: 'th-1',
    });
    expect(typeof meta.sent_at).toBe('number');
    // POST went to the send endpoint with bearer auth + JSON body.
    const sendCall = log.find((c) => c.url.endsWith('/messages/send'));
    expect(sendCall?.method).toBe('POST');
    expect(sendCall?.headers?.Authorization).toMatch(/^Bearer /);
    expect(sendCall?.headers?.['Content-Type']).toBe('application/json');
    // RFC 5322 round-trip — captured headers reflect the input.
    expect(captured).toContain('To: bob@example.com');
    expect(captured).toContain('Cc: c@example.com');
    expect(captured).toContain('Reply-To: r@example.com');
    expect(captured).toContain('In-Reply-To: <p@example.com>');
  });
});

// ────────────────────────────────────────────────────────────────
// 4. send() — error mapping
// ────────────────────────────────────────────────────────────────

describe('D-127 P1.3 — send() error taxonomy', () => {
  it('401 (after token refresh retry also 401) → MAIL_SEND_AUTH_FAILED', async () => {
    const log: SendCall[] = [];
    const fetcher: HttpFetcher = async (url, init) => {
      log.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
      if (url === 'https://oauth2.googleapis.com/token') {
        return { status: 200, ok: true,
          async json() { return { access_token: 'at-fresh', expires_in: 3600 }; },
          async text() { return '{}'; } };
      }
      // Always 401 — even after refresh.
      return { status: 401, ok: false,
        async json() { return { error: 'unauthorized' }; },
        async text() { return 'unauthorized'; } };
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
        kind: 'gmail', slug: 'work', status: 401,
      });
    }
    // Token refresh + retry: at least 2 send POSTs + 1 token refresh.
    const sendPosts = log.filter((c) => c.url.endsWith('/messages/send'));
    expect(sendPosts.length).toBeGreaterThanOrEqual(2);
    expect(log.some((c) => c.url === 'https://oauth2.googleapis.com/token')).toBe(true);
  });

  it('401 once → forced refresh → retry succeeds (no error)', async () => {
    let sendCalls = 0;
    const fetcher: HttpFetcher = async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { status: 200, ok: true,
          async json() { return { access_token: 'at-fresh', expires_in: 3600 }; },
          async text() { return '{}'; } };
      }
      if (url.endsWith('/messages/send')) {
        sendCalls++;
        if (sendCalls === 1) {
          return { status: 401, ok: false,
            async json() { return { error: 'expired' }; },
            async text() { return 'expired'; } };
        }
        return { status: 200, ok: true,
          async json() { return { id: 'gm-after-refresh', threadId: 't' }; },
          async text() { return '{}'; } };
      }
      return { status: 404, ok: false,
        async json() { return {}; }, async text() { return 'nope'; } };
    };
    const provider = newSender({}, fetcher);
    assertSendCapable(provider);
    const meta = await provider.send(minimalMsg);
    expect(meta.source_id).toBe('gm-after-refresh');
    expect(sendCalls).toBe(2);
  });

  it('403 → MAIL_SEND_AUTH_FAILED (scope downgrade / permission revocation)', async () => {
    const log: SendCall[] = [];
    const fetcher = makeSendFetcher(
      { status: 403, body: { error: { code: 403, message: 'insufficient scope' } } },
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

  it('400 (recipient rejected) → MAIL_SEND_RECIPIENT_INVALID', async () => {
    const log: SendCall[] = [];
    const fetcher = makeSendFetcher(
      { status: 400, body: { error: { code: 400, message: 'Invalid To header' } } },
      log,
    );
    const provider = newSender({}, fetcher);
    assertSendCapable(provider);
    try {
      await provider.send({ ...minimalMsg, to: ['not-an-email'] });
      expect.fail('expected MAIL_SEND_RECIPIENT_INVALID');
    } catch (err) {
      expect(err).toBeInstanceOf(IngredientError);
      expect((err as IngredientError).code).toBe('MAIL_SEND_RECIPIENT_INVALID');
      expect((err as IngredientError).details).toMatchObject({
        kind: 'gmail', status: 400,
        // Gmail REFUSED it: nothing was sent, so a fenced send may try again.
        not_sent: true,
      });
    }
  });

  it('500 (transient) → MAIL_SEND_NETWORK_FAILED', async () => {
    const log: SendCall[] = [];
    const fetcher = makeSendFetcher(
      { status: 503, body: { error: { code: 503, message: 'backend unavailable' } } },
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
      // A 5xx proves nothing either way.
      expect((err as IngredientError).details?.not_sent).toBeUndefined();
    }
  });

  it('200 with malformed body (no id) → MAIL_SEND_NETWORK_FAILED', async () => {
    const log: SendCall[] = [];
    const fetcher = makeSendFetcher({ status: 200, body: { threadId: 't' } }, log);
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
