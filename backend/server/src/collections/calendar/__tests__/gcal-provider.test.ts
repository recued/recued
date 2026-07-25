/** D-117 Phase 3 — Google Calendar adapter tests.
 *
 *  Covers:
 *    - Canonical mapping for timed + all-day + cancelled events,
 *      recurrence + conference URL + reminders + attendees.
 *    - connect: cached access token vs token-refresh path.
 *    - initialScan: timeMin/timeMax window, streaming onEvent, abort,
 *      pagination, sync-token persistence, cancelled skipping.
 *    - startSync: sync-token use, 410 expiration → full rescan,
 *      'deleted' event emission, new cursor persisted.
 *    - Write-back (create / update / delete / rsvp): verified-success,
 *      scope handling, self-attendee detection, error-code mapping.
 *    - Factory probe: full caps sheet on 2xx, auth error on 401.
 *
 *  No live network — a routing fetcher returns canned responses per URL.
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { CalendarAdapterError } from '@recued/contracts';
import type { HttpFetcher, OAuthAccountStore, OAuthProviderConfig } from '../../mail/oauth.js';
import {
  canonicalizeGcalEvent,
  createGcalAdapterFactory,
  createGcalProvider,
  type GcalEvent,
  type GcalProviderConfig,
} from '../gcal-provider.js';
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
  tokenUrl: 'https://oauth2.googleapis.com/token',
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

const mkConfig = (o: Partial<GcalProviderConfig> = {}): GcalProviderConfig => ({
  account_slug: 'work',
  expansion_future_days: 30,
  expansion_past_days: 7,
  poll_seconds: 60,
  ...o,
});

const seedStore = () =>
  makeStore({
    'gcal.work.access_token': 'at-seed',
    'gcal.work.expires_at': String(Date.now() + 3600_000),
    'gcal.work.refresh_token': 'rt-seed',
  });

const calendarListRoute = (entries: Array<{ id: string; summary?: string }>): Route => ({
  match: (u) => u.includes('/users/me/calendarList'),
  response: { status: 200, body: { items: entries } },
});

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

// ────────────────────────────────────────────────────────────────
// canonicalizeGcalEvent
// ────────────────────────────────────────────────────────────────

describe('canonicalizeGcalEvent', () => {
  it('maps a timed event with organizer + attendees + recurrence', () => {
    const ev: GcalEvent = {
      id: 'evt-1_20260423T120000Z',
      iCalUID: 'uid-1@example.com',
      status: 'confirmed',
      summary: 'Weekly sync',
      description: 'body',
      location: 'Conf Rm A',
      start: { dateTime: '2026-04-23T12:00:00Z', timeZone: 'America/New_York' },
      end: { dateTime: '2026-04-23T13:00:00Z', timeZone: 'America/New_York' },
      organizer: { email: 'alice@x.com', displayName: 'Alice' },
      attendees: [
        { email: 'alice@x.com', self: true, responseStatus: 'accepted' },
        { email: 'bob@x.com', displayName: 'Bob', responseStatus: 'needsAction' },
      ],
      recurrence: ['RRULE:FREQ=WEEKLY'],
      recurringEventId: 'evt-1',
      hangoutLink: 'https://meet.google.com/xyz',
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 10 },
          { method: 'email', minutes: 60 },
        ],
      },
      created: '2026-04-20T00:00:00Z',
      updated: '2026-04-21T12:00:00Z',
    };
    const c = canonicalizeGcalEvent(ev, 'alice@x.com', 'Work');
    expect(c.source_id).toBe('evt-1_20260423T120000Z');
    expect(c.ical_uid).toBe('uid-1@example.com');
    expect(c.calendar_id).toBe('alice@x.com');
    expect(c.calendar_name).toBe('Work');
    expect(c.summary).toBe('Weekly sync');
    expect(c.start_at).toBe(Date.parse('2026-04-23T12:00:00Z'));
    expect(c.end_at).toBe(Date.parse('2026-04-23T13:00:00Z'));
    expect(c.timezone).toBe('America/New_York');
    expect(c.is_all_day).toBe(false);
    expect(c.organizer).toEqual({ email: 'alice@x.com', display_name: 'Alice' });
    expect(c.attendees).toHaveLength(2);
    expect(c.attendees?.[0]).toEqual({
      email: 'alice@x.com',
      is_self: true,
      response_status: 'accepted',
    });
    expect(c.attendees?.[1].response_status).toBe('needs_action');
    expect(c.recurrence_rule).toBe('RRULE:FREQ=WEEKLY');
    expect(c.recurring_event_id).toBe('evt-1');
    expect(c.conference_url).toBe('https://meet.google.com/xyz');
    expect(c.reminders).toEqual([
      { method: 'popup', minutes: 10 },
      { method: 'email', minutes: 60 },
    ]);
    expect(c.status).toBe('confirmed');
    expect(c.created_at).toBe(Date.parse('2026-04-20T00:00:00Z'));
    expect(c.updated_at).toBe(Date.parse('2026-04-21T12:00:00Z'));
  });

  it('maps an all-day event as midnight UTC with is_all_day=true', () => {
    const ev: GcalEvent = {
      id: 'birthday-1',
      iCalUID: 'bday@x.com',
      status: 'confirmed',
      summary: "Alice's birthday",
      start: { date: '2026-05-01', timeZone: 'America/Los_Angeles' },
      end: { date: '2026-05-02' },
      created: '2026-04-01T00:00:00Z',
      updated: '2026-04-01T00:00:00Z',
    };
    const c = canonicalizeGcalEvent(ev, 'primary');
    expect(c.is_all_day).toBe(true);
    expect(c.start_at).toBe(Date.parse('2026-05-01T00:00:00Z'));
    expect(c.end_at).toBe(Date.parse('2026-05-02T00:00:00Z'));
    expect(c.timezone).toBe('America/Los_Angeles');
  });

  it('preserves cancelled status', () => {
    const ev: GcalEvent = {
      id: 'evt-cancelled',
      iCalUID: 'uid-c@x',
      status: 'cancelled',
      start: { dateTime: '2026-04-23T12:00:00Z' },
      end: { dateTime: '2026-04-23T13:00:00Z' },
      created: '2026-04-01T00:00:00Z',
      updated: '2026-04-20T00:00:00Z',
    };
    const c = canonicalizeGcalEvent(ev, 'primary');
    expect(c.status).toBe('cancelled');
  });

  it('falls back to event.id when iCalUID is missing', () => {
    const ev: GcalEvent = {
      id: 'evt-noical',
      status: 'confirmed',
      start: { dateTime: '2026-04-23T12:00:00Z' },
      end: { dateTime: '2026-04-23T13:00:00Z' },
    };
    const c = canonicalizeGcalEvent(ev, 'primary');
    expect(c.ical_uid).toBe('evt-noical');
  });

  it('prefers hangoutLink over conferenceData entry points', () => {
    const ev: GcalEvent = {
      id: 'evt',
      iCalUID: 'u',
      status: 'confirmed',
      start: { dateTime: '2026-04-23T12:00:00Z' },
      end: { dateTime: '2026-04-23T13:00:00Z' },
      hangoutLink: 'https://meet.google.com/abc',
      conferenceData: {
        entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.us/j/x' }],
      },
    };
    const c = canonicalizeGcalEvent(ev, 'primary');
    expect(c.conference_url).toBe('https://meet.google.com/abc');
  });

  it('falls back to conferenceData entry point when hangoutLink missing', () => {
    const ev: GcalEvent = {
      id: 'evt',
      iCalUID: 'u',
      status: 'confirmed',
      start: { dateTime: '2026-04-23T12:00:00Z' },
      end: { dateTime: '2026-04-23T13:00:00Z' },
      conferenceData: {
        entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.us/j/x' }],
      },
    };
    const c = canonicalizeGcalEvent(ev, 'primary');
    expect(c.conference_url).toBe('https://zoom.us/j/x');
  });

  it('drops attendees missing email and rewrites needsAction → needs_action', () => {
    const ev: GcalEvent = {
      id: 'evt',
      iCalUID: 'u',
      status: 'confirmed',
      start: { dateTime: '2026-04-23T12:00:00Z' },
      end: { dateTime: '2026-04-23T13:00:00Z' },
      attendees: [
        { email: 'a@x', responseStatus: 'needsAction' },
        { email: undefined, displayName: 'Group' },
      ],
    };
    const c = canonicalizeGcalEvent(ev, 'primary');
    expect(c.attendees).toHaveLength(1);
    expect(c.attendees?.[0].response_status).toBe('needs_action');
  });
});

// ────────────────────────────────────────────────────────────────
// connect
// ────────────────────────────────────────────────────────────────

describe('GcalProvider — connect', () => {
  it('uses cached access token when still valid', async () => {
    const store = seedStore();
    const { fetcher, calls } = makeRouter([]);
    const provider = createGcalProvider({
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
    const store = makeStore({ 'gcal.work.refresh_token': 'rt-only' });
    const { fetcher, calls } = makeRouter([
      {
        match: (u) => u === 'https://oauth2.googleapis.com/token',
        response: {
          status: 200,
          body: { access_token: 'fresh', expires_in: 3600 },
        },
      },
    ]);
    const provider = createGcalProvider({
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
    expect(store.data.get('gcal.work.access_token')).toBe('fresh');
  });
});

// ────────────────────────────────────────────────────────────────
// initialScan
// ────────────────────────────────────────────────────────────────

describe('GcalProvider — initialScan', () => {
  it('streams expanded instances across the expansion window and saves syncToken', async () => {
    const store = seedStore();
    const events: GcalEvent[] = [
      {
        id: 'e1',
        iCalUID: 'u1',
        status: 'confirmed',
        summary: 'A',
        start: { dateTime: '2026-04-23T10:00:00Z' },
        end: { dateTime: '2026-04-23T11:00:00Z' },
        created: '2026-04-20T00:00:00Z',
        updated: '2026-04-20T00:00:00Z',
      },
      {
        id: 'e2',
        iCalUID: 'u2',
        status: 'confirmed',
        summary: 'B',
        start: { dateTime: '2026-04-24T10:00:00Z' },
        end: { dateTime: '2026-04-24T11:00:00Z' },
        created: '2026-04-20T00:00:00Z',
        updated: '2026-04-20T00:00:00Z',
      },
    ];
    const { fetcher } = makeRouter([
      calendarListRoute([{ id: 'primary', summary: 'Primary' }]),
      {
        match: (u) =>
          u.includes('/calendars/primary/events') &&
          u.includes('singleEvents=true'),
        response: {
          status: 200,
          body: { items: events, nextSyncToken: 'tok-1' },
        },
      },
    ]);
    const provider = createGcalProvider({
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
    // Sync token persisted under the calendar-id-scoped key
    const tokens = Array.from(store.data.entries()).filter(([k]) =>
      k.startsWith('gcal.work.sync_token.'),
    );
    expect(tokens.length).toBe(1);
    expect(tokens[0][1]).toBe('tok-1');
  });

  it('aborts when onEvent returns false and does not persist syncToken', async () => {
    const store = seedStore();
    const events: GcalEvent[] = [
      {
        id: 'e1',
        iCalUID: 'u1',
        status: 'confirmed',
        summary: 'A',
        start: { dateTime: '2026-04-23T10:00:00Z' },
        end: { dateTime: '2026-04-23T11:00:00Z' },
      },
      {
        id: 'e2',
        iCalUID: 'u2',
        status: 'confirmed',
        summary: 'B',
        start: { dateTime: '2026-04-24T10:00:00Z' },
        end: { dateTime: '2026-04-24T11:00:00Z' },
      },
    ];
    const { fetcher } = makeRouter([
      calendarListRoute([{ id: 'primary' }]),
      {
        match: (u) => u.includes('/calendars/primary/events'),
        response: {
          status: 200,
          body: { items: events, nextSyncToken: 'tok-x' },
        },
      },
    ]);
    const provider = createGcalProvider({
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
    const tokens = Array.from(store.data.entries()).filter(([k]) =>
      k.startsWith('gcal.work.sync_token.'),
    );
    expect(tokens).toHaveLength(0);
  });

  it('skips cancelled events during initial scan', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      calendarListRoute([{ id: 'primary' }]),
      {
        match: (u) => u.includes('/calendars/primary/events'),
        response: {
          status: 200,
          body: {
            items: [
              {
                id: 'cancel',
                iCalUID: 'c',
                status: 'cancelled',
                start: { dateTime: '2026-04-23T10:00:00Z' },
                end: { dateTime: '2026-04-23T11:00:00Z' },
              } as GcalEvent,
              {
                id: 'keep',
                iCalUID: 'k',
                status: 'confirmed',
                summary: 'Keep',
                start: { dateTime: '2026-04-23T12:00:00Z' },
                end: { dateTime: '2026-04-23T13:00:00Z' },
              } as GcalEvent,
            ],
            nextSyncToken: 'tok',
          },
        },
      },
    ]);
    const provider = createGcalProvider({
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

  it('honors calendar_filter to limit the calendars scanned', async () => {
    const store = seedStore();
    const { fetcher, calls } = makeRouter([
      calendarListRoute([
        { id: 'primary' },
        { id: 'holidays@group.v.calendar.google.com', summary: 'Holidays' },
      ]),
      {
        match: (u) => u.includes('/calendars/primary/events'),
        response: {
          status: 200,
          body: {
            items: [
              {
                id: 'p',
                iCalUID: 'p',
                status: 'confirmed',
                summary: 'P',
                start: { dateTime: '2026-04-23T10:00:00Z' },
                end: { dateTime: '2026-04-23T11:00:00Z' },
              },
            ],
            nextSyncToken: 't',
          },
        },
      },
    ]);
    const provider = createGcalProvider({
      slug: 'work',
      config: mkConfig({ calendar_filter: ['primary'] }),
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
    expect(got).toEqual(['p']);
    // Only one events.list call — holidays calendar skipped.
    const eventCalls = calls.filter((c) => c.url.includes('/events'));
    expect(eventCalls).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// startSync
// ────────────────────────────────────────────────────────────────

describe('GcalProvider — startSync', () => {
  it('uses the stored syncToken and emits updated + deleted events', async () => {
    const store = seedStore();
    store.data.set(
      `gcal.work.sync_token.${hashId('primary')}`,
      'tok-prev',
    );
    const { fetcher, calls } = makeRouter([
      calendarListRoute([{ id: 'primary' }]),
      {
        match: (u) =>
          u.includes('/calendars/primary/events') && u.includes('syncToken=tok-prev'),
        response: {
          status: 200,
          body: {
            items: [
              {
                id: 'live',
                iCalUID: 'live',
                status: 'confirmed',
                summary: 'Live',
                start: { dateTime: '2026-04-23T10:00:00Z' },
                end: { dateTime: '2026-04-23T11:00:00Z' },
              },
              {
                id: 'gone',
                iCalUID: 'gone',
                status: 'cancelled',
                start: {},
                end: {},
              },
            ],
            nextSyncToken: 'tok-next',
          },
        },
      },
    ]);
    const provider = createGcalProvider({
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
    expect(store.data.get(`gcal.work.sync_token.${hashId('primary')}`)).toBe(
      'tok-next',
    );
    expect(calls.filter((c) => c.url.includes('/events'))).toHaveLength(1);
    await stop();
  });

  it('clears the cached token and re-scans when gcal returns 410', async () => {
    const store = seedStore();
    store.data.set(
      `gcal.work.sync_token.${hashId('primary')}`,
      'tok-old',
    );
    let callCount = 0;
    const fetcher: HttpFetcher = async (url, _init) => {
      if (url.includes('/users/me/calendarList')) {
        return {
          status: 200,
          ok: true,
          async json() {
            return { items: [{ id: 'primary' }] };
          },
          async text() {
            return '{}';
          },
        };
      }
      if (url.includes('/calendars/primary/events')) {
        callCount++;
        if (callCount === 1) {
          return {
            status: 410,
            ok: false,
            async json() {
              return { error: { code: 410 } };
            },
            async text() {
              return '{"error":{"code":410,"message":"Sync token is no longer valid, a full sync is required."}}';
            },
          };
        }
        return {
          status: 200,
          ok: true,
          async json() {
            return {
              items: [
                {
                  id: 'post-reset',
                  iCalUID: 'p',
                  status: 'confirmed',
                  summary: 'Post reset',
                  start: { dateTime: '2026-04-23T10:00:00Z' },
                  end: { dateTime: '2026-04-23T11:00:00Z' },
                },
              ],
              nextSyncToken: 'tok-fresh',
            };
          },
          async text() {
            return '{}';
          },
        };
      }
      return {
        status: 404,
        ok: false,
        async json() {
          return {};
        },
        async text() {
          return '';
        },
      };
    };
    const provider = createGcalProvider({
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
    expect(emitted).toHaveLength(1);
    expect(emitted[0].source_id).toBe('post-reset');
    expect(store.data.get(`gcal.work.sync_token.${hashId('primary')}`)).toBe(
      'tok-fresh',
    );
    await stop();
  });

  it('stop function halts the poll scheduler', async () => {
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
      calendarListRoute([{ id: 'primary' }]),
      {
        match: (u) => u.includes('/calendars/primary/events'),
        response: { status: 200, body: { items: [], nextSyncToken: 't' } },
      },
    ]);
    const provider = createGcalProvider({
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
});

// ────────────────────────────────────────────────────────────────
// Write-back
// ────────────────────────────────────────────────────────────────

describe('GcalProvider — createEvent', () => {
  it('POSTs events.insert and returns a canonical payload', async () => {
    const store = seedStore();
    const { fetcher, calls } = makeRouter([
      {
        match: (u, init) =>
          u.includes('/calendars/primary/events') && init?.method === 'POST',
        response: {
          status: 200,
          body: {
            id: 'new-1',
            iCalUID: 'new-1@x',
            status: 'confirmed',
            summary: 'Made it',
            start: { dateTime: '2026-04-23T15:00:00Z' },
            end: { dateTime: '2026-04-23T16:00:00Z' },
            created: '2026-04-23T14:59:00Z',
            updated: '2026-04-23T14:59:00Z',
          },
        },
      },
    ]);
    const provider = createGcalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const payload = await provider.createEvent('primary', {
      calendar_id: 'primary',
      summary: 'Made it',
      start_at: Date.parse('2026-04-23T15:00:00Z'),
      end_at: Date.parse('2026-04-23T16:00:00Z'),
      timezone: 'UTC',
      is_all_day: false,
      status: 'confirmed',
    });
    expect(payload.event.source_id).toBe('new-1');
    expect(payload.event.summary).toBe('Made it');
    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall).toBeTruthy();
  });

  it('maps 404 to event_not_found', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      {
        match: (u, init) =>
          u.includes('/calendars/missing/events') && init?.method === 'POST',
        response: { status: 404, body: '{"error":"not found"}' },
      },
    ]);
    const provider = createGcalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(
      provider.createEvent('missing', {
        calendar_id: 'missing',
        summary: 'X',
        start_at: 1,
        end_at: 2,
        timezone: 'UTC',
        is_all_day: false,
        status: 'confirmed',
      }),
    ).rejects.toMatchObject({
      name: 'CalendarAdapterError',
      code: 'event_not_found',
    });
  });

  it('maps 429 to quota_exceeded', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      {
        match: (u, init) =>
          u.includes('/calendars/primary/events') && init?.method === 'POST',
        response: { status: 429, body: '{"error":"rate"}' },
      },
    ]);
    const provider = createGcalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(
      provider.createEvent('primary', {
        calendar_id: 'primary',
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

describe('GcalProvider — updateEvent', () => {
  it('PATCHes the event and returns canonical payload', async () => {
    const store = seedStore();
    const { fetcher, calls } = makeRouter([
      {
        match: (u, init) =>
          u.includes('/calendars/primary/events/evt-1') &&
          init?.method === 'PATCH',
        response: {
          status: 200,
          body: {
            id: 'evt-1',
            iCalUID: 'u',
            status: 'confirmed',
            summary: 'Renamed',
            start: { dateTime: '2026-04-23T15:00:00Z' },
            end: { dateTime: '2026-04-23T16:00:00Z' },
            created: '2026-04-20T00:00:00Z',
            updated: '2026-04-23T12:00:00Z',
          },
        },
      },
    ]);
    const provider = createGcalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const payload = await provider.updateEvent({
      calendar_id: 'primary',
      source_id: 'evt-1',
      patch: { summary: 'Renamed' },
    });
    expect(payload.event.summary).toBe('Renamed');
    expect(calls.find((c) => c.method === 'PATCH')).toBeTruthy();
  });

  it('strips instance suffix when scope is series', async () => {
    const store = seedStore();
    const { fetcher, calls } = makeRouter([
      {
        match: (u, init) =>
          u.endsWith('/events/series-parent') && init?.method === 'PATCH',
        response: {
          status: 200,
          body: {
            id: 'series-parent',
            iCalUID: 'u',
            status: 'confirmed',
            start: { dateTime: '2026-04-23T15:00:00Z' },
            end: { dateTime: '2026-04-23T16:00:00Z' },
          },
        },
      },
    ]);
    const provider = createGcalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await provider.updateEvent({
      calendar_id: 'primary',
      source_id: 'series-parent_20260423T150000Z',
      patch: { summary: 'Whole series rename' },
      scope: 'series',
    });
    expect(
      calls.some(
        (c) =>
          c.method === 'PATCH' && c.url.endsWith('/events/series-parent'),
      ),
    ).toBe(true);
  });

  it("rejects scope='this_and_future' with rrule_unsupported", async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([]);
    const provider = createGcalProvider({
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
        calendar_id: 'primary',
        source_id: 'evt_1',
        patch: { summary: 'x' },
        scope: 'this_and_future',
      }),
    ).rejects.toMatchObject({ code: 'rrule_unsupported' });
  });
});

describe('GcalProvider — deleteEvent', () => {
  it('DELETEs the event', async () => {
    const store = seedStore();
    const { fetcher, calls } = makeRouter([
      {
        match: (u, init) =>
          u.includes('/calendars/primary/events/evt-1') &&
          init?.method === 'DELETE',
        response: { status: 204, body: '' },
      },
    ]);
    const provider = createGcalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await provider.deleteEvent({
      calendar_id: 'primary',
      source_id: 'evt-1',
    });
    expect(calls.find((c) => c.method === 'DELETE')).toBeTruthy();
  });

  it('surfaces 404 as event_not_found', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      {
        match: (u, init) =>
          u.includes('/calendars/primary/events/gone') &&
          init?.method === 'DELETE',
        response: { status: 404, body: '' },
      },
    ]);
    const provider = createGcalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(
      provider.deleteEvent({
        calendar_id: 'primary',
        source_id: 'gone',
      }),
    ).rejects.toMatchObject({ code: 'event_not_found' });
  });
});

describe('GcalProvider — rsvpEvent', () => {
  const seed: GcalEvent = {
    id: 'evt-rsvp',
    iCalUID: 'u',
    status: 'confirmed',
    summary: 'Sync',
    start: { dateTime: '2026-04-23T10:00:00Z' },
    end: { dateTime: '2026-04-23T11:00:00Z' },
    attendees: [
      { email: 'alice@x.com', self: true, responseStatus: 'needsAction' },
      { email: 'bob@x.com', responseStatus: 'accepted' },
    ],
  };

  it('PATCHes the self attendee with the mapped response', async () => {
    const store = seedStore();
    let patchBody: unknown;
    const fetcher: HttpFetcher = async (url, init) => {
      if (url.includes('/users/me/calendarList')) {
        return mkJson(200, { items: [{ id: 'primary' }] });
      }
      if (
        url.endsWith('/events/evt-rsvp') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return mkJson(200, seed);
      }
      if (
        url.endsWith('/events/evt-rsvp') &&
        init?.method === 'PATCH'
      ) {
        patchBody = JSON.parse(init?.body as string);
        return mkJson(200, {
          ...seed,
          attendees: [
            { ...seed.attendees![0], responseStatus: 'accepted' },
            seed.attendees![1],
          ],
        });
      }
      return mkJson(404, { error: 'unmapped', url });
    };
    const provider = createGcalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const payload = await provider.rsvpEvent({
      calendar_id: 'primary',
      source_id: 'evt-rsvp',
      response: 'accepted',
    });
    expect(payload.event.attendees?.[0].response_status).toBe('accepted');
    expect((patchBody as { attendees: Array<{ responseStatus: string }> }).attendees[0].responseStatus)
      .toBe('accepted');
  });

  it('throws attendee_not_self when the signed-in user is not in the list', async () => {
    const store = seedStore();
    const withoutSelf: GcalEvent = {
      ...seed,
      attendees: [{ email: 'bob@x.com', responseStatus: 'accepted' }],
    };
    const fetcher: HttpFetcher = async (url, init) => {
      if (url.includes('/users/me/calendarList')) {
        return mkJson(200, { items: [{ id: 'primary' }] });
      }
      if (
        url.endsWith('/events/evt-rsvp') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return mkJson(200, withoutSelf);
      }
      return mkJson(404, { error: 'unmapped', url });
    };
    const provider = createGcalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(
      provider.rsvpEvent({
        calendar_id: 'primary',
        source_id: 'evt-rsvp',
        response: 'accepted',
      }),
    ).rejects.toMatchObject({ code: 'attendee_not_self' });
  });

  it('falls back to self_email matching when no self flag is set', async () => {
    const store = seedStore();
    const noSelfFlag: GcalEvent = {
      ...seed,
      attendees: [
        { email: 'Alice@X.com', responseStatus: 'needsAction' },
        { email: 'bob@x.com', responseStatus: 'accepted' },
      ],
    };
    const fetcher: HttpFetcher = async (url, init) => {
      if (url.includes('/users/me/calendarList')) {
        return mkJson(200, { items: [{ id: 'primary' }] });
      }
      if (
        url.endsWith('/events/evt-rsvp') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return mkJson(200, noSelfFlag);
      }
      if (
        url.endsWith('/events/evt-rsvp') &&
        init?.method === 'PATCH'
      ) {
        return mkJson(200, {
          ...noSelfFlag,
          attendees: [
            { ...noSelfFlag.attendees![0], responseStatus: 'tentative' },
            noSelfFlag.attendees![1],
          ],
        });
      }
      return mkJson(404, { error: 'unmapped', url });
    };
    const provider = createGcalProvider({
      slug: 'work',
      config: mkConfig(),
      accountStore: store,
      providerConfig,
      fetcher,
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    const payload = await provider.rsvpEvent({
      calendar_id: 'primary',
      source_id: 'evt-rsvp',
      response: 'tentative',
      self_email: 'alice@x.com',
    });
    expect(payload.event.attendees?.[0].response_status).toBe('tentative');
  });
});

// ────────────────────────────────────────────────────────────────
// Factory
// ────────────────────────────────────────────────────────────────

describe('createGcalAdapterFactory', () => {
  it('probe returns the full cap sheet after a successful calendarList call', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      calendarListRoute([{ id: 'primary' }]),
    ]);
    const factory = createGcalAdapterFactory({
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
        match: (u) => u.includes('/users/me/calendarList'),
        response: { status: 401, body: '{"error":"auth"}' },
      },
    ]);
    const factory = createGcalAdapterFactory({
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

  it('probe surfaces an actionable hint on 403 when the Calendar API is disabled', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      {
        match: (u) => u.includes('/users/me/calendarList'),
        response: {
          status: 403,
          body:
            '{"error":{"code":403,"message":"Google Calendar API has not been used in project 123 before or it is disabled.","errors":[{"reason":"accessNotConfigured"}]}}',
        },
      },
    ]);
    const factory = createGcalAdapterFactory({
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
    ).rejects.toThrow(/Google Calendar API is not enabled/);
  });

  it('probe surfaces a scope hint on 403 insufficient authentication scopes', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([
      {
        match: (u) => u.includes('/users/me/calendarList'),
        response: {
          status: 403,
          body:
            '{"error":{"code":403,"message":"Request had insufficient authentication scopes.","status":"PERMISSION_DENIED"}}',
        },
      },
    ]);
    const factory = createGcalAdapterFactory({
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
    ).rejects.toThrow(/did not grant calendar access/);
  });

  it('rejects config missing account_slug', async () => {
    const store = seedStore();
    const { fetcher } = makeRouter([]);
    const factory = createGcalAdapterFactory({
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
    const factory = createGcalAdapterFactory({
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
    expect(provider.kind).toBe('gcal');
    expect(provider.slug).toBe('work');
  });
});

// ────────────────────────────────────────────────────────────────
// Local helpers
// ────────────────────────────────────────────────────────────────

function hashId(id: string): string {
  // Mirror calendarIdKeySuffix in gcal-provider.ts: sha1 truncated to 16
  // hex chars. Kept local so tests don't import the private helper.
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

// Keep CalendarAdapterError referenced so the error-class import doesn't
// drop on ts-prune cleanups — `toMatchObject({ code })` above runs against
// the same shape.
void CalendarAdapterError;
