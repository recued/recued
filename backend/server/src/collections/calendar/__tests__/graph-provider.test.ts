/** D-117 Phase 4 — Microsoft Graph calendar adapter tests.
 *
 *  Covers:
 *    - Canonical mapping for timed + all-day + cancelled events,
 *      recurrence + online meeting URL + reminders + attendees +
 *      seriesMasterId → recurring_event_id.
 *    - connect: cached access token vs token-refresh path.
 *    - initialScan: calendarView window, streaming onEvent, abort,
 *      pagination via @odata.nextLink, cancelled skipping.
 *    - startSync: deltaLink seeding on first tick, reuse of stored
 *      link on subsequent ticks, 410 → seed-and-retry, @removed +
 *      isCancelled → deleted emission.
 *    - Write-back (create / update / delete / rsvp): verified-success
 *      via events.insert / patch / delete; rsvp via accept / decline /
 *      tentativelyAccept + refetch; io_error on empty create response;
 *      cap mismatches (404 → event_not_found, 429 → quota_exceeded,
 *      rrule_unsupported for this_and_future scope).
 *    - Factory probe: full caps sheet on 2xx, auth error on 401.
 *
 *  No live network — a routing fetcher returns canned responses per URL.
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  HttpFetcher,
  OAuthAccountStore,
  OAuthProviderConfig,
} from '../../mail/oauth.js';
import {
  canonicalizeGraphEvent,
  createGraphCalAdapterFactory,
  createGraphCalProvider,
  type GraphCalEvent,
  type GraphCalProviderConfig,
} from '../graph-provider.js';
import type { CalendarSyncEvent } from '../provider.js';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const makeStore = (
  seed: Record<string, string> = {},
): OAuthAccountStore & { data: Map<string, string> } => {
  const data = new Map<string, string>(Object.entries(seed));
  return {
    data,
    async get(k) {
      return data.get(k) ?? null;
    },
    async set(k, v) {
      data.set(k, v);
    },
    async delete(k) {
      data.delete(k);
    },
  };
};

const providerConfig: OAuthProviderConfig = {
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  clientId: 'cid',
  clientSecret: 'csecret',
};

interface Route {
  match: (url: string, init?: { method?: string }) => boolean;
  response: { status: number; body: unknown };
}

const makeRouter = (
  routes: Route[],
): { fetcher: HttpFetcher; calls: Array<{ url: string; method: string }> } => {
  const calls: Array<{ url: string; method: string }> = [];
  const fetcher: HttpFetcher = async (url, init) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    for (const r of routes) {
      if (r.match(url, init)) {
        const body = r.response.body;
        return {
          status: r.response.status,
          ok: r.response.status >= 200 && r.response.status < 300,
          async json() {
            return body;
          },
          async text() {
            return typeof body === 'string' ? body : JSON.stringify(body);
          },
        };
      }
    }
    return {
      status: 404,
      ok: false,
      async json() {
        return { error: 'unmapped', url };
      },
      async text() {
        return `unmapped ${url}`;
      },
    };
  };
  return { fetcher, calls };
};

const mkConfig = (
  o: Partial<GraphCalProviderConfig> = {},
): GraphCalProviderConfig => ({
  account_slug: 'work',
  expansion_future_days: 30,
  expansion_past_days: 7,
  poll_seconds: 60,
  ...o,
});

const seedStore = () =>
  makeStore({
    'graph.work.access_token': 'at-seed',
    'graph.work.expires_at': String(Date.now() + 3600_000),
    'graph.work.refresh_token': 'rt-seed',
  });

const calendarsListRoute = (
  entries: Array<{ id: string; name?: string }>,
): Route => ({
  match: (u) => u.includes('/me/calendars?') || u.endsWith('/me/calendars'),
  response: { status: 200, body: { value: entries } },
});

const initialDeltaRoute = (calendarId: string): Route => ({
  match: (u) =>
    u.includes(`/me/calendars/${calendarId}/calendarView/delta`)
    && !u.includes('$deltatoken'),
  response: {
    status: 200,
    body: {
      value: [],
      '@odata.deltaLink':
        `https://graph.microsoft.com/v1.0/me/calendars/${calendarId}/calendarView/delta?$deltatoken=before-scan`,
    },
  },
});

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

// ────────────────────────────────────────────────────────────────
// canonicalizeGraphEvent
// ────────────────────────────────────────────────────────────────

describe('canonicalizeGraphEvent', () => {
  it('maps a timed event with organizer + attendees + online meeting', () => {
    const ev: GraphCalEvent = {
      id: 'AAMkAEVENT1=',
      iCalUId: 'uid-1@outlook.com',
      subject: 'Weekly sync',
      body: { contentType: 'text', content: 'agenda here' },
      location: { displayName: 'Teams' },
      start: { dateTime: '2026-04-23T12:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-04-23T13:00:00', timeZone: 'UTC' },
      isAllDay: false,
      isCancelled: false,
      organizer: {
        emailAddress: { address: 'alice@x.com', name: 'Alice' },
      },
      attendees: [
        {
          emailAddress: { address: 'alice@x.com', name: 'Alice' },
          type: 'required',
          status: { response: 'organizer' },
        },
        {
          emailAddress: { address: 'bob@x.com' },
          type: 'required',
          status: { response: 'notResponded' },
        },
      ],
      type: 'singleInstance',
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup/abc' },
      originalStartTimeZone: 'America/New_York',
      isReminderOn: true,
      reminderMinutesBeforeStart: 15,
      createdDateTime: '2026-04-20T00:00:00Z',
      lastModifiedDateTime: '2026-04-21T12:00:00Z',
    };
    const c = canonicalizeGraphEvent(ev, 'cal-1', 'Work');
    expect(c.source_id).toBe('AAMkAEVENT1=');
    expect(c.ical_uid).toBe('uid-1@outlook.com');
    expect(c.calendar_id).toBe('cal-1');
    expect(c.calendar_name).toBe('Work');
    expect(c.summary).toBe('Weekly sync');
    expect(c.description).toBe('agenda here');
    expect(c.location).toBe('Teams');
    expect(c.start_at).toBe(Date.parse('2026-04-23T12:00:00Z'));
    expect(c.end_at).toBe(Date.parse('2026-04-23T13:00:00Z'));
    expect(c.timezone).toBe('America/New_York');
    expect(c.is_all_day).toBe(false);
    expect(c.organizer).toEqual({ email: 'alice@x.com', display_name: 'Alice' });
    expect(c.attendees).toHaveLength(2);
    expect(c.attendees?.[0].response_status).toBe('accepted');
    expect(c.attendees?.[1].response_status).toBe('needs_action');
    expect(c.conference_url).toBe(
      'https://teams.microsoft.com/l/meetup/abc',
    );
    expect(c.reminders).toEqual([{ method: 'popup', minutes: 15 }]);
    expect(c.status).toBe('confirmed');
    expect(c.created_at).toBe(Date.parse('2026-04-20T00:00:00Z'));
    expect(c.updated_at).toBe(Date.parse('2026-04-21T12:00:00Z'));
  });

  it('maps an all-day event with isAllDay=true', () => {
    const ev: GraphCalEvent = {
      id: 'bday',
      iCalUId: 'bday@x',
      subject: 'Birthday',
      start: { dateTime: '2026-05-01T00:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-05-02T00:00:00', timeZone: 'UTC' },
      isAllDay: true,
      originalStartTimeZone: 'America/Los_Angeles',
      createdDateTime: '2026-04-01T00:00:00Z',
      lastModifiedDateTime: '2026-04-01T00:00:00Z',
    };
    const c = canonicalizeGraphEvent(ev, 'default');
    expect(c.is_all_day).toBe(true);
    expect(c.start_at).toBe(Date.parse('2026-05-01T00:00:00Z'));
    expect(c.end_at).toBe(Date.parse('2026-05-02T00:00:00Z'));
    expect(c.timezone).toBe('America/Los_Angeles');
  });

  it('maps isCancelled → cancelled status', () => {
    const ev: GraphCalEvent = {
      id: 'x',
      iCalUId: 'u',
      subject: 'Cancelled',
      start: { dateTime: '2026-04-23T12:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-04-23T13:00:00', timeZone: 'UTC' },
      isCancelled: true,
    };
    expect(canonicalizeGraphEvent(ev, 'cal').status).toBe('cancelled');
  });

  it('maps showAs=tentative → tentative status', () => {
    const ev: GraphCalEvent = {
      id: 'x',
      iCalUId: 'u',
      subject: 'Maybe',
      start: { dateTime: '2026-04-23T12:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-04-23T13:00:00', timeZone: 'UTC' },
      showAs: 'tentative',
    };
    expect(canonicalizeGraphEvent(ev, 'cal').status).toBe('tentative');
  });

  it('preserves seriesMasterId as recurring_event_id', () => {
    const ev: GraphCalEvent = {
      id: 'inst1',
      iCalUId: 'u',
      subject: 'Weekly',
      start: { dateTime: '2026-04-23T12:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-04-23T13:00:00', timeZone: 'UTC' },
      type: 'occurrence',
      seriesMasterId: 'series-1',
      recurrence: { pattern: { type: 'weekly', interval: 1 } },
    };
    const c = canonicalizeGraphEvent(ev, 'cal');
    expect(c.recurring_event_id).toBe('series-1');
    expect(c.recurrence_rule).toBe('GRAPH:weekly');
  });

  it('strips HTML bodies into plaintext description', () => {
    const ev: GraphCalEvent = {
      id: 'x',
      iCalUId: 'u',
      subject: 's',
      start: { dateTime: '2026-04-23T12:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-04-23T13:00:00', timeZone: 'UTC' },
      body: { contentType: 'html', content: '<p>Hello <b>world</b></p>' },
    };
    expect(canonicalizeGraphEvent(ev, 'cal').description).toBe('Hello world');
  });

  it('drops attendees missing email', () => {
    const ev: GraphCalEvent = {
      id: 'x',
      iCalUId: 'u',
      subject: 's',
      start: { dateTime: '2026-04-23T12:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-04-23T13:00:00', timeZone: 'UTC' },
      attendees: [
        {
          emailAddress: { address: 'a@x' },
          type: 'required',
          status: { response: 'accepted' },
        },
        { emailAddress: { name: 'Group' }, type: 'resource' },
      ],
    };
    const c = canonicalizeGraphEvent(ev, 'cal');
    expect(c.attendees).toHaveLength(1);
    expect(c.attendees?.[0].email).toBe('a@x');
  });

  it('falls back to event.id when iCalUId is missing', () => {
    const ev: GraphCalEvent = {
      id: 'noical',
      subject: 's',
      start: { dateTime: '2026-04-23T12:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-04-23T13:00:00', timeZone: 'UTC' },
    };
    expect(canonicalizeGraphEvent(ev, 'cal').ical_uid).toBe('noical');
  });
});

// ────────────────────────────────────────────────────────────────
// connect
// ────────────────────────────────────────────────────────────────

describe('GraphCalProvider — connect', () => {
  it('uses cached access token when still valid', async () => {
    const store = seedStore();
    const { fetcher, calls } = makeRouter([]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await provider.connect();
    expect(calls).toHaveLength(0);
  });

  it('refreshes via token endpoint when cached token is expired', async () => {
    const store = makeStore({ 'graph.work.refresh_token': 'rt-only' });
    const { fetcher, calls } = makeRouter([
      {
        match: (u) => u.includes('login.microsoftonline.com'),
        response: {
          status: 200,
          body: { access_token: 'fresh', expires_in: 3600 },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await provider.connect();
    expect(calls).toHaveLength(1);
    expect(store.data.get('graph.work.access_token')).toBe('fresh');
  });
});

// ────────────────────────────────────────────────────────────────
// initialScan
// ────────────────────────────────────────────────────────────────

describe('GraphCalProvider — initialScan', () => {
  it('streams expanded instances from calendarView across selected calendars', async () => {
    const store = seedStore();
    const events: GraphCalEvent[] = [
      {
        id: 'e1',
        iCalUId: 'u1',
        subject: 'A',
        start: { dateTime: '2026-04-23T10:00:00', timeZone: 'UTC' },
        end: { dateTime: '2026-04-23T11:00:00', timeZone: 'UTC' },
      },
      {
        id: 'e2',
        iCalUId: 'u2',
        subject: 'B',
        start: { dateTime: '2026-04-24T10:00:00', timeZone: 'UTC' },
        end: { dateTime: '2026-04-24T11:00:00', timeZone: 'UTC' },
      },
    ];
    const { fetcher } = makeRouter([
      calendarsListRoute([{ id: 'cal-1', name: 'Primary' }]),
      initialDeltaRoute('cal-1'),
      {
        match: (u) =>
          u.includes('/me/calendars/cal-1/calendarView') &&
          !u.includes('/delta'),
        response: { status: 200, body: { value: events } },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const got: string[] = [];
    await provider.initialScan({
      backfill_days: 7,
      expansion_future_days: 30,
      expansion_past_days: 7,
      onEvent: async (p) => {
        got.push(p.event.summary);
        return true;
      },
    });
    expect(got).toEqual(['A', 'B']);
  });

  it('captures the delta boundary before backfill so arrivals during the scan replay', async () => {
    const store = seedStore();
    const before =
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=before';
    const after =
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=after';
    const calls: string[] = [];
    let listStarted = false;
    const fetcher: HttpFetcher = async (url) => {
      calls.push(url);
      if (url.includes('/me/calendars?') || url.endsWith('/me/calendars')) {
        return mkJson(200, { value: [{ id: 'cal-1', name: 'Primary' }] });
      }
      if (
        url.includes('/calendarView/delta')
        && !url.includes('$deltatoken')
      ) {
        return mkJson(200, {
          value: [],
          '@odata.deltaLink': listStarted ? after : before,
        });
      }
      if (url === before) {
        return mkJson(200, {
          value: [{
            id: 'arrived-during-scan',
            iCalUId: 'arrived-during-scan',
            subject: 'New arrival',
            start: { dateTime: '2026-04-23T10:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-04-23T11:00:00', timeZone: 'UTC' },
          } as GraphCalEvent],
          '@odata.deltaLink': after,
        });
      }
      if (url.includes('/calendarView') && !url.includes('/delta')) {
        listStarted = true;
        return mkJson(200, { value: [] });
      }
      return mkJson(404, { error: 'unmapped', url });
    };
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());

    await provider.initialScan({
      backfill_days: 7,
      expansion_future_days: 30,
      expansion_past_days: 7,
      onEvent: async () => true,
    });
    const emitted: CalendarSyncEvent[] = [];
    const stop = await provider.startSync(async (event) => { emitted.push(event); });

    expect(emitted.map((event) => event.source_id)).toEqual(['arrived-during-scan']);
    expect(calls.findIndex((url) => url.includes('/calendarView/delta')))
      .toBeLessThan(calls.findIndex((url) =>
        url.includes('/calendarView') && !url.includes('/delta')));
    expect(store.data.get(`graph.work.cal_delta_link.${hashId('cal-1')}`)).toBe(after);
    await stop();
  });

  it('aborts when onEvent returns false', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      calendarsListRoute([{ id: 'cal-1' }]),
      initialDeltaRoute('cal-1'),
      {
        match: (u) => u.includes('/me/calendars/cal-1/calendarView'),
        response: {
          status: 200,
          body: {
            value: [
              {
                id: 'e1',
                iCalUId: 'u1',
                subject: 'A',
                start: { dateTime: '2026-04-23T10:00:00', timeZone: 'UTC' },
                end: { dateTime: '2026-04-23T11:00:00', timeZone: 'UTC' },
              },
              {
                id: 'e2',
                iCalUId: 'u2',
                subject: 'B',
                start: { dateTime: '2026-04-24T10:00:00', timeZone: 'UTC' },
                end: { dateTime: '2026-04-24T11:00:00', timeZone: 'UTC' },
              },
            ] as GraphCalEvent[],
          },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const got: string[] = [];
    await provider.initialScan({
      backfill_days: 7,
      expansion_future_days: 30,
      expansion_past_days: 7,
      onEvent: async (p) => {
        got.push(p.event.summary);
        return false;
      },
    });
    expect(got).toEqual(['A']);
  });

  it('skips @removed / isCancelled entries during initial scan', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      calendarsListRoute([{ id: 'cal-1' }]),
      initialDeltaRoute('cal-1'),
      {
        match: (u) => u.includes('/me/calendars/cal-1/calendarView'),
        response: {
          status: 200,
          body: {
            value: [
              {
                id: 'gone',
                '@removed': { reason: 'deleted' },
              } as GraphCalEvent,
              {
                id: 'cancel',
                iCalUId: 'c',
                subject: 'Cancelled',
                isCancelled: true,
                start: { dateTime: '2026-04-23T10:00:00', timeZone: 'UTC' },
                end: { dateTime: '2026-04-23T11:00:00', timeZone: 'UTC' },
              } as GraphCalEvent,
              {
                id: 'keep',
                iCalUId: 'k',
                subject: 'Keep',
                start: { dateTime: '2026-04-23T12:00:00', timeZone: 'UTC' },
                end: { dateTime: '2026-04-23T13:00:00', timeZone: 'UTC' },
              } as GraphCalEvent,
            ],
          },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const got: string[] = [];
    await provider.initialScan({
      backfill_days: 7,
      expansion_future_days: 30,
      expansion_past_days: 7,
      onEvent: async (p) => {
        got.push(p.event.source_id);
        return true;
      },
    });
    expect(got).toEqual(['keep']);
  });

  it('follows @odata.nextLink to paginate', async () => {
    const store = seedStore();
    const page2Url =
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView?$skiptoken=xyz';
    const { fetcher } = makeRouter([
      calendarsListRoute([{ id: 'cal-1' }]),
      initialDeltaRoute('cal-1'),
      {
        match: (u) =>
          u.includes('/me/calendars/cal-1/calendarView') &&
          !u.includes('skiptoken'),
        response: {
          status: 200,
          body: {
            value: [
              {
                id: 'p1',
                iCalUId: 'p1',
                subject: 'P1',
                start: { dateTime: '2026-04-23T10:00:00', timeZone: 'UTC' },
                end: { dateTime: '2026-04-23T11:00:00', timeZone: 'UTC' },
              } as GraphCalEvent,
            ],
            '@odata.nextLink': page2Url,
          },
        },
      },
      {
        match: (u) => u === page2Url,
        response: {
          status: 200,
          body: {
            value: [
              {
                id: 'p2',
                iCalUId: 'p2',
                subject: 'P2',
                start: { dateTime: '2026-04-24T10:00:00', timeZone: 'UTC' },
                end: { dateTime: '2026-04-24T11:00:00', timeZone: 'UTC' },
              } as GraphCalEvent,
            ],
          },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const got: string[] = [];
    await provider.initialScan({
      backfill_days: 7,
      expansion_future_days: 30,
      expansion_past_days: 7,
      onEvent: async (p) => {
        got.push(p.event.source_id);
        return true;
      },
    });
    expect(got).toEqual(['p1', 'p2']);
  });

  it('refuses an off-origin nextLink before forwarding the Graph bearer', async () => {
    const store = seedStore();
    const attackerUrl = 'https://attacker.invalid/collect?cursor=calendar';
    const { fetcher, calls } = makeRouter([
      calendarsListRoute([{ id: 'cal-1' }]),
      initialDeltaRoute('cal-1'),
      {
        match: (u) => u.includes('/me/calendars/cal-1/calendarView'),
        response: {
          status: 200,
          body: { value: [], '@odata.nextLink': attackerUrl },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(provider.initialScan({
      backfill_days: 7,
      expansion_future_days: 30,
      expansion_past_days: 7,
      onEvent: async () => true,
    })).rejects.toThrow('off-origin URL');
    expect(calls.some((call) => call.url === attackerUrl)).toBe(false);
  });

  it('rejects a repeated nextLink before refetching the same page forever', async () => {
    const store = seedStore();
    const page2Url =
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView?$skiptoken=repeat';
    const { fetcher, calls } = makeRouter([
      calendarsListRoute([{ id: 'cal-1' }]),
      initialDeltaRoute('cal-1'),
      {
        match: (u) => u === page2Url,
        response: {
          status: 200,
          body: { value: [], '@odata.nextLink': page2Url },
        },
      },
      {
        match: (u) => u.includes('/me/calendars/cal-1/calendarView'),
        response: {
          status: 200,
          body: { value: [], '@odata.nextLink': page2Url },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(provider.initialScan({
      backfill_days: 7,
      expansion_future_days: 30,
      expansion_past_days: 7,
      onEvent: async () => true,
    })).rejects.toThrow('repeated a page reference');
    expect(calls.filter((call) => call.url === page2Url)).toHaveLength(1);
  });

  it('rejects a non-string nextLink instead of treating a partial list as exhausted', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      calendarsListRoute([{ id: 'cal-1' }]),
      initialDeltaRoute('cal-1'),
      {
        match: (u) => u.includes('/me/calendars/cal-1/calendarView'),
        response: {
          status: 200,
          body: { value: [], '@odata.nextLink': 0 },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(provider.initialScan({
      backfill_days: 7,
      expansion_future_days: 30,
      expansion_past_days: 7,
      onEvent: async () => true,
    })).rejects.toThrow('non-string continuation');
  });
});

// ────────────────────────────────────────────────────────────────
// startSync
// ────────────────────────────────────────────────────────────────

describe('GraphCalProvider — startSync', () => {
  it('seeds deltaLink on first tick without emitting, then uses it on the next', async () => {
    const store = seedStore();
    const seededLink =
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=seed-1';
    const { fetcher } = makeRouter([
      calendarsListRoute([{ id: 'cal-1' }]),
      {
        match: (u) =>
          u.includes('/me/calendars/cal-1/calendarView/delta') &&
          !u.includes('deltatoken'),
        response: {
          status: 200,
          body: { value: [], '@odata.deltaLink': seededLink },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const emitted: CalendarSyncEvent[] = [];
    const stop = await provider.startSync(async (e) => {
      emitted.push(e);
    });
    expect(emitted).toHaveLength(0);
    const stored = store.data.get(
      `graph.work.cal_delta_link.${hashId('cal-1')}`,
    );
    expect(stored).toBe(seededLink);
    await stop();
  });

  it('refuses an off-origin deltaLink instead of persisting a poisoned watermark', async () => {
    const store = seedStore();
    const attackerUrl = 'https://attacker.invalid/collect?cursor=calendar-delta';
    const { fetcher } = makeRouter([
      calendarsListRoute([{ id: 'cal-1' }]),
      {
        match: (u) => u.includes('/me/calendars/cal-1/calendarView/delta'),
        response: {
          status: 200,
          body: { value: [], '@odata.deltaLink': attackerUrl },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(provider.startSync(async () => undefined)).rejects.toThrow(
      'off-origin URL',
    );
    expect(store.data.has(`graph.work.cal_delta_link.${hashId('cal-1')}`)).toBe(false);
  });

  it('uses stored deltaLink and emits updated + deleted', async () => {
    const store = seedStore();
    const link = 'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=existing';
    store.data.set(`graph.work.cal_delta_link.${hashId('cal-1')}`, link);
    const nextLink =
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=fresh';
    const { fetcher } = makeRouter([
      calendarsListRoute([{ id: 'cal-1' }]),
      {
        match: (u) => u === link,
        response: {
          status: 200,
          body: {
            value: [
              {
                id: 'live',
                iCalUId: 'live',
                subject: 'Live',
                start: { dateTime: '2026-04-23T10:00:00', timeZone: 'UTC' },
                end: { dateTime: '2026-04-23T11:00:00', timeZone: 'UTC' },
              },
              {
                id: 'gone',
                '@removed': { reason: 'deleted' },
              },
            ] as GraphCalEvent[],
            '@odata.deltaLink': nextLink,
          },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const emitted: CalendarSyncEvent[] = [];
    const stop = await provider.startSync(async (e) => {
      emitted.push(e);
    });
    expect(emitted.map((e) => e.kind)).toEqual(['updated', 'deleted']);
    expect(emitted[0].source_id).toBe('live');
    expect(emitted[1].source_id).toBe('gone');
    expect(
      store.data.get(`graph.work.cal_delta_link.${hashId('cal-1')}`),
    ).toBe(nextLink);
    await stop();
  });

  it('replays replacement full state on 410 before committing the new deltaLink', async () => {
    const store = seedStore();
    const expiredLink =
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=old';
    store.data.set(
      `graph.work.cal_delta_link.${hashId('cal-1')}`,
      expiredLink,
    );
    const newLink =
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=fresh';
    let seededCalls = 0;
    const fetcher: HttpFetcher = async (url, _init) => {
      if (url.includes('/me/calendars?') || url.endsWith('/me/calendars')) {
        return mkJson(200, { value: [{ id: 'cal-1' }] });
      }
      if (url === expiredLink) {
        return mkJson(410, { error: { code: 'gone' } });
      }
      if (
        url.includes('/me/calendars/cal-1/calendarView/delta') &&
        !url.includes('deltatoken')
      ) {
        seededCalls++;
        return mkJson(200, {
          value: [{
            id: 'recovered-event',
            iCalUId: 'recovered-event',
            subject: 'Recovered event',
            start: { dateTime: '2026-04-23T10:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-04-23T11:00:00', timeZone: 'UTC' },
          } as GraphCalEvent],
          '@odata.deltaLink': newLink,
        });
      }
      return mkJson(404, { error: 'unmapped', url });
    };
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const emitted: CalendarSyncEvent[] = [];
    const stop = await provider.startSync(async (e) => {
      emitted.push(e);
    });
    expect(seededCalls).toBe(1);
    expect(emitted).toEqual([
      expect.objectContaining({ kind: 'updated', source_id: 'recovered-event' }),
    ]);
    expect(
      store.data.get(`graph.work.cal_delta_link.${hashId('cal-1')}`),
    ).toBe(newLink);
    await stop();
  });

  it('retains an expired deltaLink when the recovery replay is rejected', async () => {
    const store = seedStore();
    const tokenKey = `graph.work.cal_delta_link.${hashId('cal-1')}`;
    const expiredLink =
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=expired-retry';
    store.data.set(tokenKey, expiredLink);
    const replacement =
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=must-not-commit';
    const fetcher: HttpFetcher = async (url) => {
      if (url.includes('/me/calendars?') || url.endsWith('/me/calendars')) {
        return mkJson(200, { value: [{ id: 'cal-1' }] });
      }
      if (url === expiredLink) return mkJson(410, { error: { code: 'gone' } });
      if (url.includes('/calendarView/delta') && !url.includes('deltatoken')) {
        return mkJson(200, {
          value: [{
            id: 'not-acked',
            iCalUId: 'not-acked',
            subject: 'Retry me',
            start: { dateTime: '2026-04-23T10:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-04-23T11:00:00', timeZone: 'UTC' },
          } as GraphCalEvent],
          '@odata.deltaLink': replacement,
        });
      }
      return mkJson(404, { error: 'unmapped', url });
    };
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());

    const stop = await provider.startSync(async () => {
      throw new Error('collection unavailable');
    });
    await stop();

    expect(store.data.get(tokenKey)).toBe(expiredLink);
  });

  it('holds and replays the deltaLink after a collection callback rejects', async () => {
    const store = seedStore();
    const tokenKey = `graph.work.cal_delta_link.${hashId('cal-1')}`;
    const prior =
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=prior';
    const next =
      'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=next';
    store.data.set(tokenKey, prior);
    const { fetcher } = makeRouter([
      calendarsListRoute([{ id: 'cal-1' }]),
      {
        match: (u) => u === prior,
        response: {
          status: 200,
          body: {
            value: [{
              id: 'retry-event',
              iCalUId: 'retry-event',
              subject: 'Must replay',
              start: { dateTime: '2026-04-23T10:00:00', timeZone: 'UTC' },
              end: { dateTime: '2026-04-23T11:00:00', timeZone: 'UTC' },
            } as GraphCalEvent],
            '@odata.deltaLink': next,
          },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());

    let attempts = 0;
    const firstStop = await provider.startSync(async () => {
      attempts++;
      throw new Error('collection write failed');
    });
    await firstStop();
    expect(store.data.get(tokenKey)).toBe(prior);

    const secondStop = await provider.startSync(async () => { attempts++; });
    await secondStop();
    expect(attempts).toBe(2);
    expect(store.data.get(tokenKey)).toBe(next);
  });

  it('stop halts the poll scheduler', async () => {
    const store = seedStore();
    let scheduled = 0;
    let stopped = 0;
    const scheduler = (_cb: () => Promise<void>, _ms: number): (() => void) => {
      scheduled++;
      return () => {
        stopped++;
      };
    };
    const { fetcher } = makeRouter([
      calendarsListRoute([{ id: 'cal-1' }]),
      {
        match: (u) => u.includes('/calendarView/delta'),
        response: {
          status: 200,
          body: {
            value: [],
            '@odata.deltaLink':
              'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=seed',
          },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler,
    });
    cleanup.push(() => provider.close());
    const stop = await provider.startSync(async () => {});
    expect(scheduled).toBe(1);
    await stop();
    expect(stopped).toBe(1);
  });

  it('honors calendar_filter', async () => {
    const store = seedStore();
    const { fetcher, calls } = makeRouter([
      calendarsListRoute([
        { id: 'cal-1' },
        { id: 'cal-ignore', name: 'Holidays' },
      ]),
      {
        match: (u) => u.includes('/me/calendars/cal-1/calendarView/delta'),
        response: {
          status: 200,
          body: {
            value: [],
            '@odata.deltaLink':
              'https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=seed',
          },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig({ calendar_filter: ['cal-1'] }),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await provider.startSync(async () => {});
    // Only cal-1 got a delta call — cal-ignore was filtered out.
    const deltaCalls = calls.filter((c) => c.url.includes('calendarView/delta'));
    expect(deltaCalls).toHaveLength(1);
    expect(deltaCalls[0].url).toContain('cal-1');
  });
});

// ────────────────────────────────────────────────────────────────
// Write-back
// ────────────────────────────────────────────────────────────────

describe('GraphCalProvider — createEvent', () => {
  it('POSTs /me/calendars/{id}/events and returns a canonical payload', async () => {
    const store = seedStore();
    const { fetcher, calls } = makeRouter([
      {
        match: (u, init) =>
          u.endsWith('/me/calendars/cal-1/events') && init?.method === 'POST',
        response: {
          status: 201,
          body: {
            id: 'new-1',
            iCalUId: 'new-1@x',
            subject: 'Made it',
            start: { dateTime: '2026-04-23T15:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-04-23T16:00:00', timeZone: 'UTC' },
            createdDateTime: '2026-04-23T14:59:00Z',
            lastModifiedDateTime: '2026-04-23T14:59:00Z',
          },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const payload = await provider.createEvent('cal-1', {
      calendar_id: 'cal-1',
      summary: 'Made it',
      start_at: Date.parse('2026-04-23T15:00:00Z'),
      end_at: Date.parse('2026-04-23T16:00:00Z'),
      timezone: 'UTC',
      is_all_day: false,
      status: 'confirmed',
    });
    expect(payload.event.source_id).toBe('new-1');
    expect(payload.event.summary).toBe('Made it');
    expect(calls.find((c) => c.method === 'POST')).toBeTruthy();
  });

  it('maps 429 to quota_exceeded', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      {
        match: (u, init) =>
          u.endsWith('/me/calendars/cal-1/events') && init?.method === 'POST',
        response: { status: 429, body: '{"error":"rate"}' },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(
      provider.createEvent('cal-1', {
        calendar_id: 'cal-1',
        summary: 'X',
        start_at: 1,
        end_at: 2,
        timezone: 'UTC',
        is_all_day: false,
        status: 'confirmed',
      }),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
  });
});

describe('GraphCalProvider — updateEvent', () => {
  it('PATCHes /me/events/{id} and returns canonical payload', async () => {
    const store = seedStore();
    const { fetcher, calls } = makeRouter([
      {
        match: (u, init) =>
          u.endsWith('/me/events/evt-1') && init?.method === 'PATCH',
        response: {
          status: 200,
          body: {
            id: 'evt-1',
            iCalUId: 'u',
            subject: 'Renamed',
            start: { dateTime: '2026-04-23T15:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-04-23T16:00:00', timeZone: 'UTC' },
            createdDateTime: '2026-04-20T00:00:00Z',
            lastModifiedDateTime: '2026-04-23T12:00:00Z',
          },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const payload = await provider.updateEvent({
      calendar_id: 'cal-1',
      source_id: 'evt-1',
      patch: { summary: 'Renamed' },
    });
    expect(payload.event.summary).toBe('Renamed');
    expect(calls.find((c) => c.method === 'PATCH')).toBeTruthy();
  });

  it("rejects scope='this_and_future' with rrule_unsupported", async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(
      provider.updateEvent({
        calendar_id: 'cal-1',
        source_id: 'evt-1',
        patch: { summary: 'x' },
        scope: 'this_and_future',
      }),
    ).rejects.toMatchObject({ code: 'rrule_unsupported' });
  });
});

describe('GraphCalProvider — deleteEvent', () => {
  it('DELETEs /me/events/{id}', async () => {
    const store = seedStore();
    const { fetcher, calls } = makeRouter([
      {
        match: (u, init) =>
          u.endsWith('/me/events/evt-1') && init?.method === 'DELETE',
        response: { status: 204, body: '' },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await provider.deleteEvent({
      calendar_id: 'cal-1',
      source_id: 'evt-1',
    });
    expect(calls.find((c) => c.method === 'DELETE')).toBeTruthy();
  });

  it('surfaces 404 as event_not_found', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      {
        match: (u, init) =>
          u.endsWith('/me/events/gone') && init?.method === 'DELETE',
        response: { status: 404, body: '' },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(
      provider.deleteEvent({ calendar_id: 'cal-1', source_id: 'gone' }),
    ).rejects.toMatchObject({ code: 'event_not_found' });
  });
});

describe('GraphCalProvider — rsvpEvent', () => {
  it('POSTs /accept and then GETs the refreshed event', async () => {
    const store = seedStore();
    let acceptBody: unknown;
    const refreshed: GraphCalEvent = {
      id: 'evt-rsvp',
      iCalUId: 'u',
      subject: 'Sync',
      start: { dateTime: '2026-04-23T10:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-04-23T11:00:00', timeZone: 'UTC' },
      attendees: [
        {
          emailAddress: { address: 'self@x.com' },
          type: 'required',
          status: { response: 'accepted' },
        },
      ],
    };
    const fetcher: HttpFetcher = async (url, init) => {
      if (
        url.endsWith('/me/events/evt-rsvp/accept') &&
        init?.method === 'POST'
      ) {
        acceptBody = JSON.parse((init.body as string) ?? '{}');
        return mkJson(202, '');
      }
      if (
        url.endsWith('/me/events/evt-rsvp') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return mkJson(200, refreshed);
      }
      return mkJson(404, { error: 'unmapped', url });
    };
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const payload = await provider.rsvpEvent({
      calendar_id: 'cal-1',
      source_id: 'evt-rsvp',
      response: 'accepted',
      comment: 'Cya',
    });
    expect(payload.event.attendees?.[0].response_status).toBe('accepted');
    expect((acceptBody as { comment: string }).comment).toBe('Cya');
    expect((acceptBody as { sendResponse: boolean }).sendResponse).toBe(true);
  });

  it('POSTs /decline for response=declined', async () => {
    const store = seedStore();
    let declined = false;
    const fetcher: HttpFetcher = async (url, init) => {
      if (
        url.endsWith('/me/events/evt-rsvp/decline') &&
        init?.method === 'POST'
      ) {
        declined = true;
        return mkJson(202, '');
      }
      if (
        url.endsWith('/me/events/evt-rsvp') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return mkJson(200, {
          id: 'evt-rsvp',
          iCalUId: 'u',
          subject: 's',
          start: { dateTime: '2026-04-23T10:00:00', timeZone: 'UTC' },
          end: { dateTime: '2026-04-23T11:00:00', timeZone: 'UTC' },
        });
      }
      return mkJson(404, { error: 'unmapped', url });
    };
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await provider.rsvpEvent({
      calendar_id: 'cal-1',
      source_id: 'evt-rsvp',
      response: 'declined',
    });
    expect(declined).toBe(true);
  });

  it('POSTs /tentativelyAccept for response=tentative', async () => {
    const store = seedStore();
    let hit = false;
    const fetcher: HttpFetcher = async (url, init) => {
      if (
        url.endsWith('/me/events/evt-rsvp/tentativelyAccept') &&
        init?.method === 'POST'
      ) {
        hit = true;
        return mkJson(202, '');
      }
      if (
        url.endsWith('/me/events/evt-rsvp') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return mkJson(200, {
          id: 'evt-rsvp',
          iCalUId: 'u',
          subject: 's',
          start: { dateTime: '2026-04-23T10:00:00', timeZone: 'UTC' },
          end: { dateTime: '2026-04-23T11:00:00', timeZone: 'UTC' },
        });
      }
      return mkJson(404, { error: 'unmapped', url });
    };
    const provider = createGraphCalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await provider.rsvpEvent({
      calendar_id: 'cal-1',
      source_id: 'evt-rsvp',
      response: 'tentative',
    });
    expect(hit).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

describe('createGraphCalAdapterFactory', () => {
  it('probe returns the full cap sheet after a successful calendars.list call', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      {
        match: (u) => u.includes('/me/calendars'),
        response: { status: 200, body: { value: [{ id: 'cal-1' }] } },
      },
    ]);
    const factory = createGraphCalAdapterFactory({
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    const caps = await factory.probeCaps({
      slug: 'work',
      config: { account_slug: 'work' },
      getAccountValue: async () => null,
    });
    expect(caps).toMatchObject({
      read: 'yes',
      list_calendars: 'yes',
      create_event: 'yes',
      update_event: 'yes',
      delete_event: 'yes',
      rsvp: 'yes',
      search: 'remote',
      watch: 'poll',
      auth: 'oauth',
      recurrence: 'server',
    });
  });

  it('probe surfaces auth_expired on 401', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      {
        match: (u) => u.includes('/me/calendars'),
        response: { status: 401, body: '{"error":"auth"}' },
      },
    ]);
    const factory = createGraphCalAdapterFactory({
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    await expect(
      factory.probeCaps({
        slug: 'work',
        config: { account_slug: 'work' },
        getAccountValue: async () => null,
      }),
    ).rejects.toMatchObject({ code: 'auth_expired' });
  });

  it('rejects config missing account_slug', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([]);
    const factory = createGraphCalAdapterFactory({
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    await expect(
      factory.probeCaps({
        slug: 'work',
        config: {},
        getAccountValue: async () => null,
      }),
    ).rejects.toThrow(/account_slug/);
  });

  it('create returns a live CalendarProvider bound to the adapter context', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([]);
    const factory = createGraphCalAdapterFactory({
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    const provider = factory.create({
      slug: 'work',
      config: { account_slug: 'work' },
      getAccountValue: async () => null,
    });
    cleanup.push(() => provider.close());
    expect(provider.kind).toBe('graph');
    expect(provider.slug).toBe('work');
  });
});

// ────────────────────────────────────────────────────────────────
// Local helpers
// ────────────────────────────────────────────────────────────────

function hashId(id: string): string {
  return createHash('sha1').update(id).digest('hex').slice(0, 16);
}

function mkJson(
  status: number,
  body: unknown,
): {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
} {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

describe('GraphCalProvider — a time is sent as the wall clock of its zone', () => {
  // ⛔ Graph reads `dateTime` as a time IN `timeZone`. The UTC clock was sent
  // under every zone, so a 10:00 Los Angeles event landed at 17:00 Los Angeles
  // — invisible while every caller sent `UTC` (found 2026-10-07).
  const START = Date.parse('2026-10-17T17:00:00Z');
  const sent = async (
    call: (p: ReturnType<typeof createGraphCalProvider>) => Promise<unknown>,
  ): Promise<Record<string, { dateTime: string; timeZone: string }>> => {
    const bodies: string[] = [];
    const { fetcher } = makeRouter([
      {
        match: (u, init) => {
          const hit = (u.endsWith('/me/calendars/cal-1/events') && init?.method === 'POST')
            || (u.endsWith('/me/events/evt-1') && init?.method === 'PATCH');
          // The router's own type for a request names only its method.
          const body = (init as { body?: unknown } | undefined)?.body;
          if (hit && typeof body === 'string') bodies.push(body);
          return hit;
        },
        response: {
          status: 200,
          body: {
            id: 'evt-1', iCalUId: 'u', subject: 'x',
            start: { dateTime: '2026-10-17T17:00:00', timeZone: 'UTC' },
            end: { dateTime: '2026-10-17T18:00:00', timeZone: 'UTC' },
            createdDateTime: '2026-10-07T00:00:00Z', lastModifiedDateTime: '2026-10-07T00:00:00Z',
          },
        },
      },
    ]);
    const provider = createGraphCalProvider({
      slug: 'work', config: mkConfig(), accountStore: seedStore(), providerConfig, fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await call(provider);
    return JSON.parse(bodies[0]!) as Record<string, { dateTime: string; timeZone: string }>;
  };
  const create = (timezone: string, is_all_day = false, start_at = START) =>
    (p: ReturnType<typeof createGraphCalProvider>) => p.createEvent('cal-1', {
      calendar_id: 'cal-1', summary: 'x', start_at, end_at: start_at + 3_600_000,
      timezone, is_all_day, status: 'confirmed',
    });

  it('a timed event in a named zone', async () => {
    const body = await sent(create('America/Los_Angeles'));
    expect(body.start).toEqual({ dateTime: '2026-10-17T10:00:00', timeZone: 'America/Los_Angeles' });
    expect(body.end).toEqual({ dateTime: '2026-10-17T11:00:00', timeZone: 'America/Los_Angeles' });
  });

  it('UTC as before', async () => {
    expect((await sent(create('UTC'))).start).toEqual({ dateTime: '2026-10-17T17:00:00', timeZone: 'UTC' });
  });

  it('an all-day event keeps its date, whatever the zone', async () => {
    const midnight = Date.parse('2026-10-17T00:00:00Z');
    expect((await sent(create('America/Los_Angeles', true, midnight))).start)
      .toEqual({ dateTime: '2026-10-17T00:00:00', timeZone: 'America/Los_Angeles' });
  });

  it('a zone it cannot read is sent as the same instant in UTC', async () => {
    expect((await sent(create('Pacific Standard Time'))).start)
      .toEqual({ dateTime: '2026-10-17T17:00:00', timeZone: 'UTC' });
  });

  it('a move is sent in its zone too', async () => {
    const body = await sent((p) => p.updateEvent({
      calendar_id: 'cal-1', source_id: 'evt-1',
      patch: { start_at: START, end_at: START + 3_600_000, timezone: 'Europe/London', is_all_day: false },
    }));
    expect(body.start).toEqual({ dateTime: '2026-10-17T18:00:00', timeZone: 'Europe/London' });
  });
});
