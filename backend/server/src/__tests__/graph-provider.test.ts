/** Phase D (D-106) — Graph provider tests (Commit 15).
 *
 *  Scripted HTTP fetcher drives the provider through initial scan +
 *  delta loops. Mocks Graph's pagination + `@odata.deltaLink` +
 *  `@removed` tombstones.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalizeGraph,
  createGraphProvider,
  type GraphMessagePayload,
  type GraphProviderConfig,
} from '../collections/mail/graph-provider.js';
import type {
  HttpFetcher,
  OAuthAccountStore,
  OAuthProviderConfig,
} from '../collections/mail/oauth.js';
import type { MailProvider, ProviderSyncEvent } from '../collections/mail/provider.js';

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
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  clientId: 'cid',
};
const DELTA_KEY = 'graph.work.delta_link.headers_v1.inbox';

const mkGraphMsg = (overrides: Partial<GraphMessagePayload> = {}): GraphMessagePayload => ({
  id: 'gid-1',
  subject: 'hello',
  from: { emailAddress: { address: 'a@x', name: 'A' } },
  toRecipients: [{ emailAddress: { address: 'b@x' } }],
  ccRecipients: [],
  conversationId: 'c-1',
  parentFolderId: 'inbox',
  isRead: false,
  hasAttachments: false,
  receivedDateTime: '2026-04-10T00:00:00Z',
  body: { contentType: 'text', content: 'body text' },
  ...overrides,
});

const mkConfig = (o: Partial<GraphProviderConfig> = {}): GraphProviderConfig => ({
  account_slug: 'work',
  backfill_days: 7,
  poll_seconds: 30,
  ...o,
});

interface Route {
  match: (url: string) => boolean;
  response: { status: number; body: unknown };
}

const mkFetcher = (routes: Route[]): { fetcher: HttpFetcher; calls: string[] } => {
  const calls: string[] = [];
  const fetcher: HttpFetcher = async (url) => {
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
    return {
      status: 404, ok: false,
      async json() { return { error: 'unmapped', url }; },
      async text() { return `unmapped ${url}`; },
    };
  };
  return { fetcher, calls };
};

interface Harness {
  provider: MailProvider;
  store: ReturnType<typeof makeStore>;
  calls: string[];
}

const newHarness = (opts: {
  cfg?: Partial<GraphProviderConfig>;
  routes: Route[];
  seed?: Record<string, string>;
}): Harness => {
  const nowMs = Date.now() + 3600_000;
  const store = makeStore({
    'graph.work.access_token': 'at-seed',
    'graph.work.expires_at': String(nowMs),
    'graph.work.refresh_token': 'rt',
    ...(opts.seed ?? {}),
  });
  const { fetcher, calls } = mkFetcher(opts.routes);
  const provider = createGraphProvider({
    slug: 'work',
    config: () => mkConfig(opts.cfg),
    accountStore: store,
    providerConfig,
    fetcher,
    scheduler: () => () => undefined,
  });
  return { provider, store, calls };
};

let h: Harness;
afterEach(async () => { await h?.provider.close(); });

// ────────────────────────────────────────────────────────────────
// connect
// ────────────────────────────────────────────────────────────────

describe('GraphProvider — connect', () => {
  it('ensures a usable access token', async () => {
    h = newHarness({ routes: [] });
    await h.provider.connect();
    expect(h.calls.length).toBe(0);
  });

  it('refreshes token when stored token is expired', async () => {
    const { fetcher, calls } = mkFetcher([
      { match: (u) => u === 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        response: { status: 200, body: { access_token: 'fresh', expires_in: 3600 } } },
    ]);
    const store = makeStore({ 'graph.work.refresh_token': 'rt-only' });
    const provider = createGraphProvider({
      slug: 'work',
      config: () => mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    await provider.connect();
    expect(calls.length).toBe(1);
    expect(store.data.get('graph.work.access_token')).toBe('fresh');
  });
});

// ────────────────────────────────────────────────────────────────
// initialScan
// ────────────────────────────────────────────────────────────────

describe('GraphProvider — initialScan', () => {
  it('streams messages matching $filter receivedDateTime ge', async () => {
    h = newHarness({
      routes: [
        { match: (u) => u.includes('/messages?'),
          response: { status: 200, body: { value: [mkGraphMsg({ id: 'gid-1', subject: 's1' })] } } },
        { match: (u) => u.includes('/messages/delta'),
          response: { status: 200, body: { value: [], '@odata.deltaLink': 'DELTA-LINK' } } },
      ],
    });
    await h.provider.connect();
    const got: string[] = [];
    await h.provider.initialScan({
      backfill_days: 7,
      onMessage: async (m) => { got.push(m.subject); return true; },
    });
    expect(got).toEqual(['s1']);
    expect(h.store.data.get(DELTA_KEY)).toBe('DELTA-LINK');
    expect(h.calls.some((url) =>
      url.includes('$select=') && url.includes('internetMessageHeaders'))).toBe(true);
  });

  it('honors onMessage returning false', async () => {
    h = newHarness({
      routes: [
        { match: (u) => u.includes('/messages?'),
          response: { status: 200, body: { value: [
            mkGraphMsg({ id: 'a', subject: 'sa' }),
            mkGraphMsg({ id: 'b', subject: 'sb' }),
          ] } } },
        { match: (u) => u.includes('/messages/delta'),
          response: { status: 200, body: { value: [], '@odata.deltaLink': 'DL' } } },
      ],
    });
    await h.provider.connect();
    const got: string[] = [];
    await h.provider.initialScan({
      backfill_days: 7,
      onMessage: async (m) => { got.push(m.subject); return false; },
    });
    expect(got).toEqual(['sa']);
  });

  it('follows @odata.nextLink for pagination', async () => {
    let page = 0;
    const routes: Route[] = [
      { match: (u) => u.includes('/messages/delta'),
        response: { status: 200, body: { value: [], '@odata.deltaLink': 'DL' } } },
    ];
    const fetcher: HttpFetcher = async (url) => {
      if (url.includes('/messages?')) {
        page++;
        if (page === 1) {
          return { status: 200, ok: true,
            async json() { return { value: [mkGraphMsg({ id: '1', subject: 'p1' })], '@odata.nextLink': 'PAGE2' }; },
            async text() { return '{}'; } };
        }
        return { status: 200, ok: true,
          async json() { return { value: [mkGraphMsg({ id: '2', subject: 'p2' })] }; },
          async text() { return '{}'; } };
      }
      if (url.includes('/messages/delta') || url === 'PAGE2') {
        if (url === 'PAGE2') {
          return { status: 200, ok: true,
            async json() { return { value: [mkGraphMsg({ id: '2', subject: 'p2' })] }; },
            async text() { return '{}'; } };
        }
        return { status: 200, ok: true,
          async json() { return { value: [], '@odata.deltaLink': 'DL' }; },
          async text() { return '{}'; } };
      }
      return { status: 404, ok: false, async json() { return {}; }, async text() { return 'nope'; } };
    };
    const store = makeStore({
      'graph.work.access_token': 'at',
      'graph.work.expires_at': String(Date.now() + 3600_000),
      'graph.work.refresh_token': 'rt',
    });
    const provider = createGraphProvider({
      slug: 'work',
      config: () => mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    await provider.connect();
    const got: string[] = [];
    await provider.initialScan({
      backfill_days: 7,
      onMessage: async (m) => { got.push(m.subject); return true; },
    });
    expect(got).toEqual(['p1', 'p2']);
    await provider.close();
  });

  it('skips @removed entries during initial scan', async () => {
    h = newHarness({
      routes: [
        { match: (u) => u.includes('/messages?'),
          response: { status: 200, body: { value: [
            mkGraphMsg({ id: 'live' }),
            { id: 'gone', '@removed': { reason: 'deleted' } },
          ] } } },
        { match: (u) => u.includes('/messages/delta'),
          response: { status: 200, body: { value: [], '@odata.deltaLink': 'DL' } } },
      ],
    });
    await h.provider.connect();
    const got: string[] = [];
    await h.provider.initialScan({
      backfill_days: 7,
      onMessage: async (m) => { got.push(m.source_id); return true; },
    });
    expect(got).toEqual(['live']);
  });

  it('surfaces attachment parts with Graph attachment fetch handles', async () => {
    const bytes = Buffer.from('%PDF-1.4 graph attachment bytes');
    h = newHarness({
      routes: [
        { match: (u) => u.includes('/messages?'),
          response: { status: 200, body: { value: [
            mkGraphMsg({ id: 'gid-attach', subject: 'with file', hasAttachments: true }),
          ] } } },
        { match: (u) => u.includes('/messages/gid-attach/attachments') && !u.endsWith('/att-1'),
          response: { status: 200, body: { value: [{
            id: 'att-1',
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: '../contract.pdf',
            contentType: 'application/pdf',
            size: bytes.length,
          }] } } },
        { match: (u) => u.includes('/messages/gid-attach/attachments/att-1'),
          response: { status: 200, body: {
            id: 'att-1',
            name: '../contract.pdf',
            contentType: 'application/pdf',
            size: bytes.length,
            contentBytes: bytes.toString('base64'),
          } } },
        { match: (u) => u.includes('/messages/delta'),
          response: { status: 200, body: { value: [], '@odata.deltaLink': 'DL' } } },
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
      filename: 'contract.pdf',
      mime_type: 'application/pdf',
      size: bytes.length,
      source_part_id: 'att-1',
    });
    await expect(part.fetchBytes()).resolves.toEqual(bytes);
    expect(h.calls.some((u) => u.includes('/messages/gid-attach/attachments/att-1'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// incremental sync via delta
// ────────────────────────────────────────────────────────────────

describe('GraphProvider — incremental sync', () => {
  it('applies delta updates + @removed tombstones', async () => {
    h = newHarness({
      seed: { [DELTA_KEY]: 'https://delta.example/inbox?t=1' },
      routes: [
        { match: (u) => u === 'https://delta.example/inbox?t=1',
          response: { status: 200, body: {
            value: [
              mkGraphMsg({ id: 'new-1', subject: 'new' }),
              { id: 'old-1', '@removed': { reason: 'deleted' } },
            ],
            '@odata.deltaLink': 'https://delta.example/inbox?t=2',
          } } },
      ],
    });
    await h.provider.connect();
    const events: ProviderSyncEvent[] = [];
    await h.provider.startSync(async (e) => { events.push(e); });
    const kinds = events.map((e) => `${e.kind}:${e.source_id}`);
    expect(kinds).toEqual(expect.arrayContaining(['updated:new-1', 'deleted:old-1']));
    expect(h.store.data.get(DELTA_KEY)).toBe('https://delta.example/inbox?t=2');
  });

  it('seeds a delta link on first run when none stored', async () => {
    h = newHarness({
      routes: [
        { match: (u) => u.includes('/messages/delta'),
          response: { status: 200, body: { value: [], '@odata.deltaLink': 'INITIAL-LINK' } } },
      ],
    });
    await h.provider.connect();
    await h.provider.startSync(async () => undefined);
    expect(h.store.data.get(DELTA_KEY)).toBe('INITIAL-LINK');
  });

  it('iterates across multiple folders from folder_filter', async () => {
    let inboxCalls = 0;
    let archiveCalls = 0;
    const fetcher: HttpFetcher = async (url) => {
      if (url.includes('/mailFolders/inbox/messages/delta')) {
        inboxCalls++;
        return { status: 200, ok: true,
          async json() { return { value: [], '@odata.deltaLink': 'inbox-delta' }; },
          async text() { return '{}'; } };
      }
      if (url.includes('/mailFolders/archive/messages/delta')) {
        archiveCalls++;
        return { status: 200, ok: true,
          async json() { return { value: [], '@odata.deltaLink': 'archive-delta' }; },
          async text() { return '{}'; } };
      }
      return { status: 404, ok: false, async json() { return {}; }, async text() { return 'nope'; } };
    };
    const store = makeStore({
      'graph.work.access_token': 'at',
      'graph.work.expires_at': String(Date.now() + 3600_000),
      'graph.work.refresh_token': 'rt',
    });
    const provider = createGraphProvider({
      slug: 'work',
      config: () => mkConfig({ folder_filter: ['inbox', 'archive'] }),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    await provider.connect();
    await provider.startSync(async () => undefined);
    expect(inboxCalls).toBeGreaterThanOrEqual(1);
    expect(archiveCalls).toBeGreaterThanOrEqual(1);
    expect(store.data.get('graph.work.delta_link.headers_v1.inbox')).toBe('inbox-delta');
    expect(store.data.get('graph.work.delta_link.headers_v1.archive')).toBe('archive-delta');
    await provider.close();
  });

  it('retries once on 401 with a force-refreshed token', async () => {
    let attempts = 0;
    const fetcher: HttpFetcher = async (url, init) => {
      if (url === 'https://login.microsoftonline.com/common/oauth2/v2.0/token') {
        return { status: 200, ok: true,
          async json() { return { access_token: 'fresh', expires_in: 3600 }; },
          async text() { return '{}'; } };
      }
      if (url.includes('/messages/delta')) {
        attempts++;
        if (attempts === 1 && (init?.headers as any)?.Authorization?.includes('at-stale')) {
          return { status: 401, ok: false, async json() { return {}; }, async text() { return 'nope'; } };
        }
        return { status: 200, ok: true,
          async json() { return { value: [], '@odata.deltaLink': 'DL' }; },
          async text() { return '{}'; } };
      }
      return { status: 404, ok: false, async json() { return {}; }, async text() { return 'nope'; } };
    };
    const store = makeStore({
      'graph.work.access_token': 'at-stale',
      'graph.work.expires_at': String(Date.now() + 3600_000),
      'graph.work.refresh_token': 'rt',
    });
    const provider = createGraphProvider({
      slug: 'work',
      config: () => mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    await provider.connect();
    await provider.startSync(async () => undefined);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(store.data.get('graph.work.access_token')).toBe('fresh');
    await provider.close();
  });
});

// ────────────────────────────────────────────────────────────────
// canonicalizeGraph
// ────────────────────────────────────────────────────────────────

describe('canonicalizeGraph', () => {
  it('maps Graph shape to CanonicalMessage', () => {
    const m = canonicalizeGraph(mkGraphMsg({
      id: 'x', subject: 'S',
      from: { emailAddress: { address: 'f@x' } },
      toRecipients: [{ emailAddress: { address: 't1@x' } }, { emailAddress: { address: 't2@x' } }],
      ccRecipients: [{ emailAddress: { address: 'c@x' } }],
      conversationId: 'CONV',
      parentFolderId: 'inbox',
      isRead: true,
      hasAttachments: true,
      receivedDateTime: '2026-04-10T00:00:00Z',
      body: { contentType: 'text', content: 'plain body' },
    }));
    expect(m.source_id).toBe('x');
    expect(m.from).toBe('f@x');
    expect(m.to).toEqual(['t1@x', 't2@x']);
    expect(m.cc).toEqual(['c@x']);
    expect(m.thread_id).toBe('CONV');
    expect(m.folder_or_label).toBe('inbox');
    expect(m.is_read).toBe(true);
    expect(m.has_attachments).toBe(true);
    expect(m.body_text).toBe('plain body');
    expect(m.body_html).toBeUndefined();
    expect(m.received_at).toBe(Date.parse('2026-04-10T00:00:00Z'));
  });

  it('strips HTML when body.contentType is html', () => {
    const m = canonicalizeGraph(mkGraphMsg({
      body: { contentType: 'html', content: '<p>Hello <b>world</b></p>' },
    }));
    expect(m.body_text).toBe('Hello world');
    expect(m.body_html).toBe('<p>Hello <b>world</b></p>');
  });

  it('defaults missing fields safely', () => {
    const m = canonicalizeGraph({ id: 'id-x' });
    expect(m.from).toBe('');
    expect(m.to).toEqual([]);
    expect(m.cc).toEqual([]);
    expect(m.subject).toBe('');
    expect(m.thread_id).toBe('');
    expect(m.folder_or_label).toBe('');
    expect(m.is_read).toBe(false);
    expect(m.has_attachments).toBe(false);
    expect(m.body_text).toBe('');
  });
});
