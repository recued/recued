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
  graphMessageDirectionForFolder,
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
const graphDeltaLink = (token: string, folder = 'inbox'): string =>
  `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta?$deltatoken=${token}`;

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
          response: { status: 200, body: { value: [], '@odata.deltaLink': graphDeltaLink('scan') } } },
      ],
    });
    await h.provider.connect();
    const got: string[] = [];
    await h.provider.initialScan({
      backfill_days: 7,
      onMessage: async (m) => { got.push(m.subject); return true; },
    });
    expect(got).toEqual(['s1']);
    expect(h.store.data.get(DELTA_KEY)).toBe(graphDeltaLink('scan'));
    expect(h.calls.some((url) =>
      url.includes('$select=') && url.includes('internetMessageHeaders'))).toBe(true);
  });

  it('captures the delta watermark before backfill so arrivals during the scan replay', async () => {
    const before = graphDeltaLink('before-scan');
    const after = graphDeltaLink('after-scan');
    const calls: string[] = [];
    let listStarted = false;
    const fetcher: HttpFetcher = async (url) => {
      calls.push(url);
      let body: unknown;
      let status = 200;
      if (url.includes('/messages/delta') && !url.includes('$deltatoken')) {
        body = { value: [], '@odata.deltaLink': listStarted ? after : before };
      } else if (url === before) {
        body = {
          value: [mkGraphMsg({ id: 'arrived-during-scan', subject: 'new arrival' })],
          '@odata.deltaLink': after,
        };
      } else if (url.includes('/messages?')) {
        listStarted = true;
        body = { value: [] };
      } else {
        status = 404;
        body = { error: 'unmapped', url };
      }
      return {
        status,
        ok: status >= 200 && status < 300,
        async json() { return body; },
        async text() { return JSON.stringify(body); },
      };
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
    try {
      await provider.connect();
      await provider.initialScan({ backfill_days: 7, onMessage: async () => true });
      const events: ProviderSyncEvent[] = [];
      const stop = await provider.startSync(async (event) => { events.push(event); });
      await stop();

      expect(events).toEqual([
        expect.objectContaining({ kind: 'updated', source_id: 'arrived-during-scan' }),
      ]);
      expect(calls.findIndex((url) => url.includes('/messages/delta')))
        .toBeLessThan(calls.findIndex((url) => url.includes('/messages?')));
    } finally {
      await provider.close();
    }
  });

  it('rejects an incomplete list page instead of completing the backfill', async () => {
    h = newHarness({
      routes: [
        { match: (u) => u.includes('/messages/delta'),
          response: { status: 200, body: { value: [], '@odata.deltaLink': graphDeltaLink('before-failure') } } },
        { match: (u) => u.includes('/messages?'),
          response: { status: 503, body: { error: 'temporarily unavailable' } } },
      ],
    });
    await h.provider.connect();

    await expect(h.provider.initialScan({
      backfill_days: 7,
      onMessage: async () => true,
    })).rejects.toThrow("could not fetch folder 'inbox'");
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
          response: { status: 200, body: { value: [], '@odata.deltaLink': graphDeltaLink('abort') } } },
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
    const page2Url = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=PAGE2';
    const routes: Route[] = [
      { match: (u) => u.includes('/messages/delta'),
        response: { status: 200, body: { value: [], '@odata.deltaLink': graphDeltaLink('paged') } } },
    ];
    const fetcher: HttpFetcher = async (url) => {
      if (url.includes('/messages?')) {
        page++;
        if (page === 1) {
          return { status: 200, ok: true,
            async json() { return { value: [mkGraphMsg({ id: '1', subject: 'p1' })], '@odata.nextLink': page2Url }; },
            async text() { return '{}'; } };
        }
        return { status: 200, ok: true,
          async json() { return { value: [mkGraphMsg({ id: '2', subject: 'p2' })] }; },
          async text() { return '{}'; } };
      }
      if (url.includes('/messages/delta') || url === page2Url) {
        if (url === page2Url) {
          return { status: 200, ok: true,
            async json() { return { value: [mkGraphMsg({ id: '2', subject: 'p2' })] }; },
            async text() { return '{}'; } };
        }
        return { status: 200, ok: true,
          async json() { return { value: [], '@odata.deltaLink': graphDeltaLink('paged') }; },
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

  it('refuses an off-origin nextLink before forwarding the Graph bearer', async () => {
    const attackerUrl = 'https://attacker.invalid/collect?cursor=mail';
    h = newHarness({
      routes: [
        { match: (u) => u.includes('/messages/delta'),
          response: { status: 200, body: { value: [], '@odata.deltaLink': graphDeltaLink('off-origin-list') } } },
        {
          match: (u) => u.includes('/messages?'),
          response: {
            status: 200,
            body: { value: [], '@odata.nextLink': attackerUrl },
          },
        },
      ],
    });
    await h.provider.connect();
    await expect(h.provider.initialScan({
      backfill_days: 7,
      onMessage: async () => true,
    })).rejects.toThrow('off-origin URL');
    expect(h.calls.some((url) => url === attackerUrl)).toBe(false);
  });

  it('refuses an off-origin deltaLink instead of persisting a poisoned watermark', async () => {
    const attackerUrl = 'https://attacker.invalid/collect?cursor=delta';
    h = newHarness({
      routes: [
        {
          match: (u) => u.includes('/messages?'),
          response: { status: 200, body: { value: [] } },
        },
        {
          match: (u) => u.includes('/messages/delta'),
          response: {
            status: 200,
            body: { value: [], '@odata.deltaLink': attackerUrl },
          },
        },
      ],
    });
    await h.provider.connect();
    await expect(h.provider.initialScan({
      backfill_days: 7,
      onMessage: async () => true,
    })).rejects.toThrow('off-origin URL');
    expect(h.store.data.has(DELTA_KEY)).toBe(false);
  });

  it('rejects a repeated nextLink before refetching the same page forever', async () => {
    const page2Url = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=repeat';
    h = newHarness({
      routes: [
        { match: (u) => u.includes('/messages/delta'),
          response: { status: 200, body: { value: [], '@odata.deltaLink': graphDeltaLink('repeat-list') } } },
        {
          match: (u) => u === page2Url,
          response: {
            status: 200,
            body: { value: [], '@odata.nextLink': page2Url },
          },
        },
        {
          match: (u) => u.includes('/messages?'),
          response: {
            status: 200,
            body: { value: [], '@odata.nextLink': page2Url },
          },
        },
      ],
    });
    await h.provider.connect();
    await expect(h.provider.initialScan({
      backfill_days: 7,
      onMessage: async () => true,
    })).rejects.toThrow('repeated a page reference');
    expect(h.calls.filter((url) => url === page2Url)).toHaveLength(1);
  });

  it('rejects a non-string nextLink instead of treating a partial list as exhausted', async () => {
    h = newHarness({
      routes: [
        { match: (u) => u.includes('/messages/delta'),
          response: { status: 200, body: { value: [], '@odata.deltaLink': graphDeltaLink('non-string-list') } } },
        {
          match: (u) => u.includes('/messages?'),
          response: {
            status: 200,
            body: { value: [], '@odata.nextLink': 0 },
          },
        },
      ],
    });
    await h.provider.connect();
    await expect(h.provider.initialScan({
      backfill_days: 7,
      onMessage: async () => true,
    })).rejects.toThrow('non-string continuation');
    expect(h.calls.filter((url) => url.includes('/messages?'))).toHaveLength(1);
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
          response: { status: 200, body: { value: [], '@odata.deltaLink': graphDeltaLink('removed') } } },
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
          response: { status: 200, body: { value: [], '@odata.deltaLink': graphDeltaLink('attachment') } } },
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
    const firstDelta = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=1';
    const nextDelta = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=2';
    h = newHarness({
      seed: { [DELTA_KEY]: firstDelta },
      routes: [
        { match: (u) => u === firstDelta,
          response: { status: 200, body: {
            value: [
              mkGraphMsg({ id: 'new-1', subject: 'new' }),
              { id: 'old-1', '@removed': { reason: 'deleted' } },
            ],
            '@odata.deltaLink': nextDelta,
          } } },
      ],
    });
    await h.provider.connect();
    const events: ProviderSyncEvent[] = [];
    await h.provider.startSync(async (e) => { events.push(e); });
    const kinds = events.map((e) => `${e.kind}:${e.source_id}`);
    expect(kinds).toEqual(expect.arrayContaining(['updated:new-1', 'deleted:old-1']));
    expect(h.store.data.get(DELTA_KEY)).toBe(nextDelta);
  });

  it('seeds a delta link on first run when none stored', async () => {
    h = newHarness({
      routes: [
        { match: (u) => u.includes('/messages/delta'),
          response: { status: 200, body: { value: [], '@odata.deltaLink': graphDeltaLink('initial') } } },
      ],
    });
    await h.provider.connect();
    await h.provider.startSync(async () => undefined);
    expect(h.store.data.get(DELTA_KEY)).toBe(graphDeltaLink('initial'));
  });

  it('replays the replacement full state before replacing an expired delta cursor', async () => {
    const expired = graphDeltaLink('expired');
    const replacement = graphDeltaLink('replacement');
    h = newHarness({
      seed: { [DELTA_KEY]: expired },
      routes: [
        { match: (u) => u === expired,
          response: { status: 410, body: { error: { code: 'syncStateNotFound' } } } },
        { match: (u) => u.includes('/messages/delta'),
          response: {
            status: 200,
            body: {
              value: [mkGraphMsg({ id: 'recovered-id', subject: 'Recovered' })],
              '@odata.deltaLink': replacement,
            },
          } },
      ],
    });
    const outcomes: Array<{ ok: boolean }> = [];
    h.provider.onSyncOutcome?.((outcome) => { outcomes.push(outcome); });
    await h.provider.connect();

    const events: ProviderSyncEvent[] = [];
    const stopFirst = await h.provider.startSync(async (event) => { events.push(event); });
    await stopFirst();
    expect(events).toEqual([
      expect.objectContaining({ kind: 'updated', source_id: 'recovered-id' }),
    ]);
    expect(h.store.data.get(DELTA_KEY)).toBe(replacement);
    expect(outcomes.at(-1)).toMatchObject({ ok: false });
  });

  it('retains an expired delta cursor when its recovery replay is rejected', async () => {
    const expired = graphDeltaLink('expired-retry');
    h = newHarness({
      seed: { [DELTA_KEY]: expired },
      routes: [
        { match: (u) => u === expired,
          response: { status: 410, body: { error: { code: 'syncStateNotFound' } } } },
        { match: (u) => u.includes('/messages/delta'),
          response: {
            status: 200,
            body: {
              value: [mkGraphMsg({ id: 'not-acked', subject: 'Retry recovery' })],
              '@odata.deltaLink': graphDeltaLink('must-not-commit'),
            },
          } },
      ],
    });
    await h.provider.connect();

    const stop = await h.provider.startSync(async () => {
      throw new Error('collection unavailable');
    });
    await stop();

    expect(h.store.data.get(DELTA_KEY)).toBe(expired);
  });

  it('holds and replays the deltaLink after a collection callback rejects', async () => {
    const prior = graphDeltaLink('prior');
    const next = graphDeltaLink('next');
    h = newHarness({
      seed: { [DELTA_KEY]: prior },
      routes: [{
        match: (u) => u === prior,
        response: {
          status: 200,
          body: {
            value: [mkGraphMsg({ id: 'retry-id', subject: 'must replay' })],
            '@odata.deltaLink': next,
          },
        },
      }],
    });
    const outcomes: Array<{ ok: boolean }> = [];
    h.provider.onSyncOutcome?.((outcome) => { outcomes.push(outcome); });
    await h.provider.connect();

    let attempts = 0;
    const firstStop = await h.provider.startSync(async () => {
      attempts++;
      throw new Error('collection write failed');
    });
    await firstStop();
    expect(h.store.data.get(DELTA_KEY)).toBe(prior);
    expect(outcomes.at(-1)).toMatchObject({ ok: false });

    const secondStop = await h.provider.startSync(async () => { attempts++; });
    await secondStop();
    expect(attempts).toBe(2);
    expect(h.store.data.get(DELTA_KEY)).toBe(next);
    expect(outcomes.at(-1)).toMatchObject({ ok: true });
  });

  it('iterates across multiple folders from folder_filter', async () => {
    let inboxCalls = 0;
    let archiveCalls = 0;
    const fetcher: HttpFetcher = async (url) => {
      if (url.includes('/mailFolders/inbox/messages/delta')) {
        inboxCalls++;
        return { status: 200, ok: true,
          async json() { return { value: [], '@odata.deltaLink': graphDeltaLink('folder', 'inbox') }; },
          async text() { return '{}'; } };
      }
      if (url.includes('/mailFolders/archive/messages/delta')) {
        archiveCalls++;
        return { status: 200, ok: true,
          async json() { return { value: [], '@odata.deltaLink': graphDeltaLink('folder', 'archive') }; },
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
    expect(store.data.get('graph.work.delta_link.headers_v1.inbox')).toBe(graphDeltaLink('folder', 'inbox'));
    expect(store.data.get('graph.work.delta_link.headers_v1.archive')).toBe(graphDeltaLink('folder', 'archive'));
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
          async json() { return { value: [], '@odata.deltaLink': graphDeltaLink('refresh') }; },
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
    expect(m.direction).toBe('inbound');
    expect(m.is_read).toBe(true);
    expect(m.has_attachments).toBe(true);
    expect(m.body_text).toBe('plain body');
    expect(m.body_html).toBeUndefined();
    expect(m.received_at).toBe(Date.parse('2026-04-10T00:00:00Z'));
  });

  it('derives direction from the queried well-known folder rather than opaque parentFolderId', () => {
    const message = mkGraphMsg({ parentFolderId: 'AAMkOpaqueFolderId' });

    expect(canonicalizeGraph(
      message,
      [],
      graphMessageDirectionForFolder('sentitems'),
    ).direction).toBe('outbound');
    expect(graphMessageDirectionForFolder('drafts')).toBe('draft');
    expect(graphMessageDirectionForFolder('AAMkOpaqueFolderId')).toBe('unknown');
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

describe('GraphProvider — a message read again on its own (D-315 §4.4, §7.4)', () => {
  const message = (id: string, parentFolderId: string) => ({
    id,
    parentFolderId,
    subject: 'Your parcel',
    from: { emailAddress: { address: 'me@contoso.com' } },
    toRecipients: [{ emailAddress: { address: 'buyer@shop.example' } }],
    receivedDateTime: '2026-09-20T10:00:00Z',
    body: { contentType: 'text', content: 'Tracking Number: 1Z999AA10123456784' },
    hasAttachments: false,
  });
  const folder = (name: string, id: string): Route => ({
    match: (url) => url === `https://graph.microsoft.com/v1.0/me/mailFolders/${name}?$select=id`,
    response: { status: 200, body: { id } },
  });
  const byId = (id: string, parent: string): Route => ({
    match: (url) => url.startsWith(`https://graph.microsoft.com/v1.0/me/messages/${id}?`),
    response: { status: 200, body: message(id, parent) },
  });

  it('keeps the direction its folder gives it, as live sync does, asking the folders once', async () => {
    h = newHarness({
      routes: [
        folder('inbox', 'F-IN'), folder('sentitems', 'F-SENT'), folder('outbox', 'F-OUT'), folder('drafts', 'F-DRAFT'),
        byId('m-sent', 'F-SENT'), byId('m-in', 'F-IN'), byId('m-other', 'F-ARCHIVE'),
      ],
    });
    await h.provider.connect();
    expect((await h.provider.fetchMessage!('m-sent'))?.direction).toBe('outbound');
    expect((await h.provider.fetchMessage!('m-in'))?.direction).toBe('inbound');
    expect((await h.provider.fetchMessage!('m-other'))?.direction).toBe('unknown');
    expect(h.calls.filter((url) => url.includes('/me/mailFolders/')).length).toBe(4);
  });

  it('asks again when a folder could not be looked up, and says unknown meanwhile', async () => {
    h = newHarness({ routes: [folder('inbox', 'F-IN'), folder('outbox', 'F-OUT'), folder('drafts', 'F-DRAFT'), byId('m-sent', 'F-SENT')] });
    await h.provider.connect();
    expect((await h.provider.fetchMessage!('m-sent'))?.direction).toBe('unknown');
    await h.provider.fetchMessage!('m-sent');
    expect(h.calls.filter((url) => url.includes('/me/mailFolders/sentitems')).length).toBe(2);
  });
});
