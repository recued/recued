/** A calendar stop returns within the grace, however long its servers take.
 *
 *  The lifecycle drain stops every calendar in `pause_collections`, a step
 *  with 5 s; a stop that waits out a remote party makes an update refuse to
 *  swap versions, while the process exits right after the drain anyway. Each
 *  case holds a remote call open and checks that the stop returns within
 *  `STOP_GRACE_MS`, that the call in flight was told to stop, and that the
 *  provider's cursor (sync token, ETags, delta link) did not move — and that a
 *  pass cut short removed nothing it never reached. */

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CalendarCollectionCaps } from '@recued/contracts';
import type { StorageGate } from '@recued/storage-gate';
import { createWarehouseEventBus } from '@recued/warehouse-events';

import { STOP_GRACE_MS } from '../../../lifecycle/settle-within.js';
import { createInstanceStore } from '../../instance-store.js';
import type { HttpFetcher, OAuthAccountStore, OAuthProviderConfig } from '../../mail/oauth.js';
import { CollectionStoppedError } from '../../stop-signal.js';
import type { CalendarAdapterFactory } from '../adapter-registry.js';
import { createCalDavProvider, type CalDavEtagStore } from '../caldav-provider.js';
import { composeCalendarStack } from '../compose.js';
import { createGcalProvider } from '../gcal-provider.js';
import { createGraphCalProvider } from '../graph-provider.js';
import type { CalendarProvider, CalendarSyncEvent } from '../provider.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Whether a promise has settled yet, readable without awaiting it. */
const track = (work: Promise<unknown>): { readonly done: boolean } => {
  const settled = { done: false };
  void work.then(() => { settled.done = true; }, () => { settled.done = true; });
  return settled;
};

const makeStore = (seed: Record<string, string> = {}): OAuthAccountStore & { data: Map<string, string> } => {
  const data = new Map<string, string>(Object.entries(seed));
  return {
    data,
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
  };
};

const tokens = (provider: 'gcal' | 'graph'): Record<string, string> => ({
  [`${provider}.work.access_token`]: 'at',
  [`${provider}.work.expires_at`]: String(Date.now() + 3_600_000),
  [`${provider}.work.refresh_token`]: 'rt',
});

const providerConfig: OAuthProviderConfig = {
  tokenUrl: 'https://login.example.test/token',
  clientId: 'cid',
  clientSecret: 'secret',
};

type Answer = { status: number; body: unknown } | 'held';

interface HeldCall {
  url: string;
  signal: AbortSignal | undefined;
}

/** A fetcher that answers by URL and method. `held` never answers on its own
 *  but rejects when its signal aborts, as the bounded fetcher does. */
const scriptedFetcher = (
  route: (url: string, method: string) => Answer,
): { fetcher: HttpFetcher; held: HeldCall[] } => {
  const held: HeldCall[] = [];
  const fetcher: HttpFetcher = (url, init) => {
    const answer = route(url, init?.method ?? 'GET');
    if (answer === 'held') {
      held.push({ url, signal: init?.signal });
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      });
    }
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return Promise.resolve({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: { get: () => null },
      async json() { return answer.body; },
      async text() { return text; },
    });
  };
  return { fetcher, held };
};

const ok = (body: unknown): Answer => ({ status: 200, body });
const missing: Answer = { status: 404, body: {} };

const gcalEvent = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  status: 'confirmed',
  summary: id,
  iCalUID: `${id}@example.com`,
  start: { dateTime: '2026-10-27T10:00:00Z' },
  end: { dateTime: '2026-10-27T11:00:00Z' },
  ...extra,
});

const gcalConfig = { account_slug: 'work', expansion_future_days: 30, expansion_past_days: 7, poll_seconds: 60 };

const syncTokens = (store: ReturnType<typeof makeStore>, provider: 'gcal'): string[] =>
  [...store.data.entries()].filter(([key]) => key.startsWith(`${provider}.work.sync_token.`)).map(([, value]) => value);

describe('Google Calendar — a stop aborts what it is waiting on', () => {
  it('aborts the poll startSync runs at once, keeps the sync token, and starts no loop', async () => {
    const store = makeStore(tokens('gcal'));
    // A first scan leaves the calendar's sync token.
    const first = scriptedFetcher((url) => {
      if (url.includes('/users/me/calendarList')) return ok({ items: [{ id: 'primary', summary: 'Me', primary: true }] });
      if (url.includes('/calendars/primary/events')) return ok({ items: [], nextSyncToken: 'token-before' });
      return missing;
    });
    const seeding = createGcalProvider({
      slug: 'work', config: gcalConfig, accountStore: store, providerConfig, fetcher: first.fetcher, scheduler: () => () => undefined,
    });
    await seeding.connect();
    await seeding.initialScan({ backfill_days: 7, expansion_future_days: 30, expansion_past_days: 7, onEvent: async () => true });
    await seeding.close();
    expect(syncTokens(store, 'gcal')).toEqual(['token-before']);

    const { fetcher, held } = scriptedFetcher((url) => {
      if (url.includes('/users/me/calendarList')) return ok({ items: [{ id: 'primary', summary: 'Me', primary: true }] });
      if (url.includes('/calendars/primary/events')) return 'held';
      return missing;
    });
    const scheduler = vi.fn(() => () => undefined);
    const provider = createGcalProvider({
      slug: 'work', config: gcalConfig, accountStore: store, providerConfig, fetcher, scheduler,
    });
    const outcomes: unknown[] = [];
    provider.onSyncOutcome?.((outcome) => { outcomes.push(outcome); });
    await provider.connect();
    const starting = provider.startSync(async () => {});
    starting.catch(() => {});
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await provider.close();

    expect(held[0]!.signal?.aborted).toBe(true);
    await expect(starting).rejects.toBeInstanceOf(CollectionStoppedError);
    expect(syncTokens(store, 'gcal')).toEqual(['token-before']);
    expect(scheduler).not.toHaveBeenCalled();
    // A stop is not a failed poll: nothing tells the collection it failed.
    expect(outcomes).toEqual([]);
  });

  it('rejects a first scan stopped mid-calendar and stores no sync token for it', async () => {
    const store = makeStore(tokens('gcal'));
    const { fetcher, held } = scriptedFetcher((url) => {
      if (url.includes('/users/me/calendarList')) return ok({ items: [{ id: 'primary', summary: 'Me', primary: true }] });
      if (url.includes('/events/series-1')) return 'held';
      if (url.includes('/calendars/primary/events')) {
        return ok({
          items: [gcalEvent('one'), gcalEvent('two'), gcalEvent('series-1_20261027', { recurringEventId: 'series-1' })],
          nextSyncToken: 'token-after',
        });
      }
      return missing;
    });
    const provider = createGcalProvider({
      slug: 'work', config: gcalConfig, accountStore: store, providerConfig, fetcher, scheduler: () => () => undefined,
    });
    await provider.connect();
    const scanned: string[] = [];
    const scanning = provider.initialScan({
      backfill_days: 7, expansion_future_days: 30, expansion_past_days: 7,
      onEvent: async (payload) => { scanned.push(payload.event.source_id); return true; },
    });
    scanning.catch(() => {});
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await provider.close();

    await expect(scanning).rejects.toBeInstanceOf(CollectionStoppedError);
    expect(held[0]!.signal?.aborted).toBe(true);
    expect(scanned).toContain('one');
    expect(syncTokens(store, 'gcal')).toEqual([]);
  });
});

const homeXml = '<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
  + '<response><href>/calendars/alice/work/</href><propstat><prop><displayname>Work</displayname>'
  + '<resourcetype><collection/><c:calendar/></resourcetype></prop></propstat></response></multistatus>';

const report = (entries: Array<{ href: string; etag: string; ics?: string }>): string =>
  '<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
  + entries.map((e) => `<response><href>${e.href}</href><propstat><prop><getetag>${e.etag}</getetag>`
    + `${e.ics ? `<c:calendar-data>${e.ics}</c:calendar-data>` : ''}</prop></propstat></response>`).join('')
  + '</multistatus>';

const eventIcs = (uid: string): string => [
  'BEGIN:VEVENT', `UID:${uid}`, 'DTSTART:20261027T120000Z', 'DTEND:20261027T130000Z', `SUMMARY:${uid}`, 'END:VEVENT',
].join('\r\n');

const makeEtagStore = (): CalDavEtagStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async list(prefix) {
      return [...data.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }));
    },
  };
};

const caldavConfig = {
  server_url: 'https://caldav.example.com',
  username: 'alice',
  password: 'secret',
  calendar_home_url: 'https://caldav.example.com/calendars/alice/',
  expansion_future_days: 30,
  expansion_past_days: 7,
  poll_seconds: 60,
};

describe('CalDAV — a stop aborts what it is waiting on', () => {
  it('stamps no ETag and removes no resource when a poll is stopped mid-calendar', async () => {
    const etagStore = makeEtagStore();
    const now = () => Date.parse('2026-10-26T12:00:00Z');
    // A first poll stores the ETags of two resources.
    const first = scriptedFetcher((_url, method) => {
      if (method === 'PROPFIND') return ok(homeXml);
      if (method === 'REPORT') {
        return ok(report([
          { href: '/calendars/alice/work/a.ics', etag: '"a-1"', ics: eventIcs('a') },
          { href: '/calendars/alice/work/gone.ics', etag: '"gone-1"', ics: eventIcs('gone') },
        ]));
      }
      return missing;
    });
    const seeding = createCalDavProvider({
      slug: 'personal', config: caldavConfig, fetcher: first.fetcher, etagStore, scheduler: () => () => undefined, now,
    });
    await seeding.startSync(async () => {});
    await seeding.close();
    const before = new Map(etagStore.data);
    expect(before.size).toBe(2);

    // Next poll: `a` changed (its body must be fetched, and that read hangs),
    // and `gone` is no longer listed.
    const { fetcher, held } = scriptedFetcher((url, method) => {
      if (method === 'PROPFIND') return ok(homeXml);
      if (method === 'REPORT') return ok(report([{ href: '/calendars/alice/work/a.ics', etag: '"a-2"' }]));
      if (method === 'GET' && url.endsWith('/a.ics')) return 'held';
      return missing;
    });
    const provider = createCalDavProvider({
      slug: 'personal', config: caldavConfig, fetcher, etagStore, scheduler: () => () => undefined, now,
    });
    const delivered: CalendarSyncEvent[] = [];
    const starting = provider.startSync(async (event) => { delivered.push(event); });
    starting.catch(() => {});
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await provider.close();

    await expect(starting).rejects.toBeInstanceOf(CollectionStoppedError);
    expect(held[0]!.signal?.aborted).toBe(true);
    // `gone`'s rows were not reconciled away, and no ETag moved: the next poll
    // reads `a` and handles `gone` again.
    expect(delivered).toEqual([]);
    expect(etagStore.data).toEqual(before);
  });
});

const GRAPH = 'https://graph.microsoft.com/v1.0';

describe('Graph calendar — a stop aborts what it is waiting on', () => {
  it('stops the delta walk a first scan seeds, and stores no delta link', async () => {
    const store = makeStore(tokens('graph'));
    const { fetcher, held } = scriptedFetcher((url) => {
      if (url.startsWith(`${GRAPH}/me/calendars?`)) {
        return ok({ value: [{ id: 'cal-1', name: 'Cal', isDefaultCalendar: true, owner: { address: 'me@example.com' } }] });
      }
      if (url.includes('$skiptoken=page2')) return 'held';
      if (url.includes('/calendarView/delta?')) {
        return ok({ value: [], '@odata.nextLink': `${GRAPH}/me/calendars/cal-1/calendarView/delta?$skiptoken=page2` });
      }
      return missing;
    });
    const provider = createGraphCalProvider({
      slug: 'work',
      config: { account_slug: 'work', expansion_future_days: 30, expansion_past_days: 7, poll_seconds: 60 },
      accountStore: store, providerConfig, fetcher, scheduler: () => () => undefined,
    });
    await provider.connect();
    const scanning = provider.initialScan({
      backfill_days: 7, expansion_future_days: 30, expansion_past_days: 7, onEvent: async () => true,
    });
    scanning.catch(() => {});
    await vi.waitFor(() => expect(held).toHaveLength(1));
    await provider.close();

    await expect(scanning).rejects.toBeInstanceOf(CollectionStoppedError);
    expect(held[0]!.signal?.aborted).toBe(true);
    expect([...store.data.keys()].filter((key) => key.startsWith('graph.work.cal_delta_link.'))).toEqual([]);
  });
});

const FULL_CAPS: CalendarCollectionCaps = {
  read: 'yes', list_calendars: 'yes', create_event: 'yes', update_event: 'yes', delete_event: 'yes',
  rsvp: 'yes', search: 'remote', watch: 'poll', auth: 'oauth', recurrence: 'server',
};

describe('calendar stack — disposeAll', () => {
  it('returns within the grace while a provider never finishes closing', async () => {
    const db = new Database(':memory:');
    const bus = createWarehouseEventBus();
    cleanups.push(() => { bus.dispose(); db.close(); });
    let closes = 0;
    const stuck: CalendarAdapterFactory = {
      kind: 'gcal',
      async probeCaps() { return FULL_CAPS; },
      create(ctx): CalendarProvider {
        return {
          kind: 'gcal',
          slug: ctx.slug,
          async connect() {},
          async initialScan() {},
          async startSync() { return async () => {}; },
          // A close waiting on a server that never answers.
          close: () => { closes += 1; return new Promise<void>(() => {}); },
          health: () => ({ last_successful_sync_at: 0, error_count_24h: 0, pending_queue_size: 0, pending_series_expansions: 0 }),
        } as unknown as CalendarProvider;
      },
    };
    const stack = composeCalendarStack(
      db,
      {
        blobs: { async put() { return 'blob:test'; }, async get() { return null; }, async delete() {} } as never,
        bus,
        getGate: () => ({ addUsed() {}, setUsed() {} }) as unknown as StorageGate,
      },
      { factories: [stuck] },
    );
    createInstanceStore({ db }).upsert({
      platform: 'calendar', slug: 'work', adapter_type: 'gcal', config: {}, caps: FULL_CAPS,
      auth_state: 'healthy', last_synced_at: null,
    });
    await stack.startAll();
    expect(stack.listLive()).toHaveLength(1);

    vi.useFakeTimers();
    const disposing = track(stack.disposeAll());
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS - 1);
    expect(disposing.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(disposing.done).toBe(true);
    expect(closes).toBe(1);
  });
});
