/** Phase D (D-106) — Gmail provider tests (Commit 14).
 *
 *  Exercises the Gmail REST provider against a scripted HTTP fetcher.
 *  The fetcher matches the URL against a routing table and returns
 *  canned responses — we don't talk to Google in CI.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalizeGmail,
  createGmailProvider,
  type GmailProviderConfig,
} from '../collections/mail/gmail-provider.js';
import type { HttpFetcher, OAuthAccountStore, OAuthProviderConfig } from '../collections/mail/oauth.js';
import type { MailProvider, ProviderSyncEvent } from '../collections/mail/provider.js';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const makeStore = (seed: Record<string, string> = {}): OAuthAccountStore & { data: Map<string, string> } => {
  const data = new Map<string, string>(Object.entries(seed));
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
  };
};

const providerConfig: OAuthProviderConfig = {
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientId: 'cid',
  clientSecret: 'csecret',
};

const makeRfc822Base64Url = (opts: {
  from?: string; to?: string; cc?: string; subject?: string;
  body?: string; messageId?: string;
} = {}): string => {
  const lines = [
    `From: ${opts.from ?? 'alice@example.com'}`,
    `To: ${opts.to ?? 'bob@example.com'}`,
    ...(opts.cc ? [`Cc: ${opts.cc}`] : []),
    `Subject: ${opts.subject ?? 'hi'}`,
    `Message-ID: <${opts.messageId ?? 'msg@example.com'}>`,
    'Date: Mon, 1 Jan 2024 10:00:00 +0000',
    'Content-Type: text/plain; charset="utf-8"',
    '',
    opts.body ?? 'hello',
  ].join('\r\n');
  return Buffer.from(lines).toString('base64url');
};

const makeRfc822WithAttachmentBase64Url = (opts: {
  filename?: string;
  mime?: string;
  bytes: Buffer;
}): string => {
  const boundary = 'recued-test-boundary';
  const lines = [
    'From: alice@example.com',
    'To: bob@example.com',
    'Subject: attachment',
    'Message-ID: <attach@example.com>',
    'Date: Mon, 1 Jan 2024 10:00:00 +0000',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'body',
    `--${boundary}`,
    `Content-Type: ${opts.mime ?? 'application/pdf'}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${opts.filename ?? 'report.pdf'}"`,
    '',
    opts.bytes.toString('base64'),
    `--${boundary}--`,
  ].join('\r\n');
  return Buffer.from(lines).toString('base64url');
};

interface Route {
  match: (url: string) => boolean;
  response: { status: number; body: unknown };
}

const makeRouter = (routes: Route[]): { fetcher: HttpFetcher; calls: string[] } => {
  const calls: string[] = [];
  const fetcher: HttpFetcher = async (url, _init) => {
    calls.push(url);
    for (const r of routes) {
      if (r.match(url)) {
        return {
          status: r.response.status,
          ok: r.response.status >= 200 && r.response.status < 300,
          async json() { return r.response.body; },
          async text() { return typeof r.response.body === 'string' ? r.response.body : JSON.stringify(r.response.body); },
        };
      }
    }
    // Default — 404 for unmapped routes. Fails loud in tests.
    return {
      status: 404,
      ok: false,
      async json() { return { error: 'unmapped', url }; },
      async text() { return `unmapped ${url}`; },
    };
  };
  return { fetcher, calls };
};

const mkConfig = (o: Partial<GmailProviderConfig> = {}): GmailProviderConfig => ({
  account_slug: 'work',
  backfill_days: 7,
  poll_seconds: 30,
  ...o,
});

interface Harness {
  provider: MailProvider;
  store: ReturnType<typeof makeStore>;
  calls: string[];
  events: ProviderSyncEvent[];
}

interface HarnessOpts {
  cfg?: Partial<GmailProviderConfig>;
  routes: Route[];
  accessToken?: string;
}

const newHarness = (opts: HarnessOpts): Harness => {
  const nowMs = Date.now() + 3600_000; // seeds a fresh token by default
  const store = makeStore({
    'gmail.work.access_token': opts.accessToken ?? 'at-seed',
    'gmail.work.expires_at': String(nowMs),
    'gmail.work.refresh_token': 'rt-seed',
  });
  const { fetcher, calls } = makeRouter(opts.routes);
  const events: ProviderSyncEvent[] = [];
  const provider = createGmailProvider({
    slug: 'work',
    config: () => mkConfig(opts.cfg),
    accountStore: store,
    providerConfig,
    fetcher,
    // Inject a noop scheduler so startSync doesn't fire background ticks.
    scheduler: () => () => undefined,
  });
  return { provider, store, calls, events };
};

let h: Harness;
afterEach(async () => { await h?.provider.close(); });

// ────────────────────────────────────────────────────────────────
// connect
// ────────────────────────────────────────────────────────────────

describe('GmailProvider — connect', () => {
  it('ensures a usable access token', async () => {
    h = newHarness({ routes: [] });
    await h.provider.connect();
    // cached token preserved (no network calls)
    expect(h.calls.length).toBe(0);
  });

  it('refreshes via token endpoint when stored token is expired', async () => {
    const store = makeStore({
      'gmail.work.refresh_token': 'rt-only',
    });
    const { fetcher, calls } = makeRouter([
      { match: (u) => u === 'https://oauth2.googleapis.com/token',
        response: { status: 200, body: { access_token: 'fresh', expires_in: 3600 } } },
    ]);
    const provider = createGmailProvider({
      slug: 'work',
      config: () => mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    await provider.connect();
    expect(calls.length).toBe(1);
    expect(store.data.get('gmail.work.access_token')).toBe('fresh');
  });
});

// ────────────────────────────────────────────────────────────────
// initialScan
// ────────────────────────────────────────────────────────────────

describe('GmailProvider — initialScan', () => {
  it('fetches newer_than:Nd and streams canonical messages', async () => {
    const raw = makeRfc822Base64Url({ subject: 'first', messageId: 'a@x' });
    h = newHarness({
      routes: [
        { match: (u) => u.includes('/profile'),
          response: { status: 200, body: { historyId: '1000', emailAddress: 'a@x' } } },
        { match: (u) => u.includes('/messages?') || u.endsWith('/messages'),
          response: { status: 200, body: { messages: [{ id: 'id-1', threadId: 't-1' }] } } },
        { match: (u) => u.includes('/messages/id-1'),
          response: { status: 200, body: { id: 'id-1', threadId: 't-1', labelIds: ['INBOX'], raw, internalDate: '1700000000000' } } },
      ],
    });
    await h.provider.connect();
    const got: string[] = [];
    await h.provider.initialScan({
      backfill_days: 7,
      onMessage: async (m) => { got.push(m.subject); return true; },
    });
    expect(got).toEqual(['first']);
    expect(h.store.data.get('gmail.work.history_id')).toBe('1000');
  });

  it('honors onMessage returning false (abort)', async () => {
    const rawA = makeRfc822Base64Url({ subject: 'a' });
    const rawB = makeRfc822Base64Url({ subject: 'b' });
    const routes: Route[] = [
      { match: (u) => u.includes('/profile'), response: { status: 200, body: { historyId: '1', emailAddress: 'a' } } },
      { match: (u) => u.includes('/messages?'), response: { status: 200, body: { messages: [{ id: 'A', threadId: 't' }, { id: 'B', threadId: 't' }] } } },
      { match: (u) => u.includes('/messages/A'), response: { status: 200, body: { id: 'A', threadId: 't', raw: rawA, internalDate: '1' } } },
      { match: (u) => u.includes('/messages/B'), response: { status: 200, body: { id: 'B', threadId: 't', raw: rawB, internalDate: '2' } } },
    ];
    h = newHarness({ routes });
    await h.provider.connect();
    const got: string[] = [];
    await h.provider.initialScan({
      backfill_days: 7,
      onMessage: async (m) => { got.push(m.subject); return false; },
    });
    expect(got).toEqual(['a']);
  });

  it('follows nextPageToken for paginated lists', async () => {
    const raw = makeRfc822Base64Url({});
    let phase = 0;
    const routes: Route[] = [
      { match: (u) => u.includes('/profile'), response: { status: 200, body: { historyId: '1' } } },
      { match: (u) => u.includes('/messages/'), response: { status: 200, body: { id: 'X', threadId: 't', raw, internalDate: '1' } } },
    ];
    h = newHarness({ routes });
    // Swap the list route to a two-page response.
    const listHandler = {
      match: (u: string) => u.includes('/messages?'),
      response: { status: 200, body: { messages: [], nextPageToken: '' } },
    };
    // Implement pagination by re-running fetch via a bespoke fetcher.
    const store = h.store;
    const pageCount = { n: 0 };
    const pagingFetcher: HttpFetcher = async (url, _init) => {
      if (url.includes('/profile')) {
        return { status: 200, ok: true, async json() { return { historyId: '1' }; }, async text() { return '{}'; } };
      }
      if (url.includes('/messages?')) {
        phase = 0;
        pageCount.n++;
        if (pageCount.n === 1) {
          return { status: 200, ok: true,
            async json() { return { messages: [{ id: 'A', threadId: 't' }], nextPageToken: 'P2' }; },
            async text() { return '{}'; } };
        }
        return { status: 200, ok: true,
          async json() { return { messages: [{ id: 'B', threadId: 't' }] }; },
          async text() { return '{}'; } };
      }
      if (url.includes('/messages/')) {
        return { status: 200, ok: true,
          async json() { return { id: 'A', threadId: 't', raw, internalDate: '1' }; },
          async text() { return '{}'; } };
      }
      return { status: 404, ok: false, async json() { return {}; }, async text() { return 'nope'; } };
    };
    const provider = createGmailProvider({
      slug: 'work',
      config: () => mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher: pagingFetcher,
      scheduler: () => () => undefined,
    });
    await provider.connect();
    const got: string[] = [];
    await provider.initialScan({ backfill_days: 7, onMessage: async () => { got.push('ok'); return true; } });
    expect(got.length).toBe(2);
    await provider.close();
  });

  it('retries once on 401 with force-refreshed token', async () => {
    let attempts = 0;
    const raw = makeRfc822Base64Url({ subject: 's' });
    const store = makeStore({
      'gmail.work.access_token': 'at-stale',
      'gmail.work.expires_at': String(Date.now() + 3600_000),
      'gmail.work.refresh_token': 'rt',
    });
    const fetcher: HttpFetcher = async (url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return {
          status: 200, ok: true,
          async json() { return { access_token: 'at-fresh', expires_in: 3600 }; },
          async text() { return '{}'; },
        };
      }
      if (url.includes('/profile')) {
        attempts++;
        if (attempts === 1 && (init?.headers as any)?.Authorization?.includes('at-stale')) {
          return { status: 401, ok: false, async json() { return {}; }, async text() { return 'unauthorized'; } };
        }
        return { status: 200, ok: true,
          async json() { return { historyId: '1' }; },
          async text() { return '{}'; } };
      }
      if (url.includes('/messages?')) {
        return { status: 200, ok: true,
          async json() { return { messages: [] }; },
          async text() { return '{}'; } };
      }
      return { status: 404, ok: false, async json() { return {}; }, async text() { return 'nope'; } };
    };
    const provider = createGmailProvider({
      slug: 'work',
      config: () => mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    await provider.connect();
    await provider.initialScan({ backfill_days: 7, onMessage: async () => true });
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(store.data.get('gmail.work.access_token')).toBe('at-fresh');
    await provider.close();
  });

  it('surfaces attachment parts with Gmail attachment fetch handles', async () => {
    const bytes = Buffer.from('%PDF-1.4 gmail attachment bytes');
    const raw = makeRfc822WithAttachmentBase64Url({
      filename: '../report.pdf',
      mime: 'application/pdf',
      bytes,
    });
    h = newHarness({
      routes: [
        { match: (u) => u.includes('/profile'),
          response: { status: 200, body: { historyId: '1000', emailAddress: 'a@x' } } },
        { match: (u) => u.includes('/messages?') || u.endsWith('/messages'),
          response: { status: 200, body: { messages: [{ id: 'id-attach', threadId: 't-1' }] } } },
        { match: (u) => u.includes('/messages/id-attach?format=raw'),
          response: { status: 200, body: { id: 'id-attach', threadId: 't-1', labelIds: ['INBOX'], raw, internalDate: '1700000000000' } } },
        { match: (u) => u.includes('/messages/id-attach?format=full'),
          response: { status: 200, body: {
            id: 'id-attach',
            threadId: 't-1',
            labelIds: ['INBOX'],
            payload: {
              partId: '',
              mimeType: 'multipart/mixed',
              parts: [{
                partId: '1',
                mimeType: 'application/pdf',
                filename: '../report.pdf',
                body: { attachmentId: 'ATT-1', size: bytes.length },
              }],
            },
          } } },
        { match: (u) => u.includes('/messages/id-attach/attachments/ATT-1'),
          response: { status: 200, body: { data: bytes.toString('base64url'), size: bytes.length } } },
      ],
    });
    await h.provider.connect();
    let message;
    await h.provider.initialScan({
      backfill_days: 7,
      onMessage: async (m) => { message = m; return true; },
    });
    const part = message!.attachments![0];
    expect(part).toMatchObject({
      filename: 'report.pdf',
      mime_type: 'application/pdf',
      size: bytes.length,
      source_part_id: 'ATT-1',
    });
    await expect(part.fetchBytes()).resolves.toEqual(bytes);
    expect(h.calls.some((u) => u.includes('/messages/id-attach/attachments/ATT-1'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// startSync — historyId polling
// ────────────────────────────────────────────────────────────────

describe('GmailProvider — incremental sync', () => {
  it('translates messagesAdded/Deleted/labelAdded(TRASH) to events', async () => {
    const raw = makeRfc822Base64Url({ subject: 'added' });
    const store = makeStore({
      'gmail.work.access_token': 'at-seed',
      'gmail.work.expires_at': String(Date.now() + 3600_000),
      'gmail.work.refresh_token': 'rt',
      'gmail.work.history_id': '100',
    });
    const historyBody = {
      history: [
        { id: '101', messagesAdded: [{ message: { id: 'id-A', threadId: 't' } }] },
        { id: '102', messagesDeleted: [{ message: { id: 'id-B', threadId: 't' } }] },
        { id: '103', labelsAdded: [{ message: { id: 'id-C', threadId: 't' }, labelIds: ['TRASH'] }] },
        { id: '104', labelsAdded: [{ message: { id: 'id-D', threadId: 't' }, labelIds: ['IMPORTANT'] }] },
      ],
      historyId: '105',
    };
    const fetcher: HttpFetcher = async (url) => {
      if (url.includes('/history')) {
        return { status: 200, ok: true, async json() { return historyBody; }, async text() { return '{}'; } };
      }
      const match = url.match(/\/messages\/(id-[A-D])/);
      if (match) {
        const id = match[1];
        return { status: 200, ok: true,
          async json() { return { id, threadId: 't', raw, internalDate: '1', labelIds: ['INBOX'] }; },
          async text() { return '{}'; } };
      }
      return { status: 404, ok: false, async json() { return {}; }, async text() { return 'nope'; } };
    };
    const events: ProviderSyncEvent[] = [];
    const provider = createGmailProvider({
      slug: 'work',
      config: () => mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    await provider.connect();
    await provider.startSync(async (e) => { events.push(e); });
    const kinds = events.map((e) => `${e.kind}:${e.source_id}`);
    expect(kinds).toEqual(expect.arrayContaining([
      'created:id-A',
      'deleted:id-B',
      'deleted:id-C', // TRASH label → deleted
      'updated:id-D',
    ]));
    expect(store.data.get('gmail.work.history_id')).toBe('105');
    await provider.close();
  });

  it('reseeds watermark from profile when none stored', async () => {
    const store = makeStore({
      'gmail.work.access_token': 'at', 'gmail.work.expires_at': String(Date.now() + 3600_000),
      'gmail.work.refresh_token': 'rt',
    });
    const fetcher: HttpFetcher = async (url) => {
      if (url.includes('/profile')) {
        return { status: 200, ok: true, async json() { return { historyId: '999' }; }, async text() { return '{}'; } };
      }
      return { status: 404, ok: false, async json() { return {}; }, async text() { return 'nope'; } };
    };
    const provider = createGmailProvider({
      slug: 'work',
      config: () => mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    await provider.connect();
    await provider.startSync(async () => undefined);
    expect(store.data.get('gmail.work.history_id')).toBe('999');
    await provider.close();
  });
});

// ────────────────────────────────────────────────────────────────
// canonicalizeGmail
// ────────────────────────────────────────────────────────────────

describe('canonicalizeGmail', () => {
  it('decodes base64url raw + populates labels / folder / read state', async () => {
    const raw = makeRfc822Base64Url({ subject: 'Q3' });
    const msg = await canonicalizeGmail({
      id: 'id-1',
      threadId: 't-1',
      labelIds: ['INBOX', 'IMPORTANT'],
      raw,
      internalDate: '1700000000000',
    });
    expect(msg.source_id).toBe('id-1');
    expect(msg.thread_id).toBe('t-1');
    expect(msg.folder_or_label).toBe('INBOX');
    expect(msg.labels).toEqual(['INBOX', 'IMPORTANT']);
    expect(msg.is_read).toBe(true);  // no UNREAD in labels
  });

  it('marks as unread when UNREAD label present', async () => {
    const raw = makeRfc822Base64Url({});
    const msg = await canonicalizeGmail({
      id: 'id-1', threadId: 't', labelIds: ['INBOX', 'UNREAD'], raw, internalDate: '1',
    });
    expect(msg.is_read).toBe(false);
  });

  it('throws when raw is missing', async () => {
    await expect(canonicalizeGmail({ id: 'id-1', threadId: 't' } as any))
      .rejects.toThrow(/missing raw body/);
  });
});
