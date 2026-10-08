/** CalDAV reads a time in its own zone and edits the server's file in place
 *  (2026-10-07).
 *
 *  ⛔ Before: `DTSTART;TZID=America/Los_Angeles:20261017T100000` was stored as
 *  10:00 UTC (03:00 in Los Angeles), and every write rebuilt the event from
 *  what Recued reads — so a rename moved the event on the owner's own calendar
 *  by the zone's offset and dropped its zone, reminders, deleted dates and
 *  changed occurrences; editing or deleting one occurrence (the default scope)
 *  edited or deleted the whole series; and a resource deleted on the server
 *  never left the warehouse (its deletion was keyed on a hash no row had).
 *
 *  Writes run against a stateful fake server, so each test reads the file the
 *  server would hold afterwards. */

import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import type { HttpFetcher } from '../../mail/oauth.js';
import {
  createCalDavProvider,
  expandCalDavObject,
  parseVEvent,
  readCalDavObject,
  type CalDavEtagStore,
  type CalDavProviderConfig,
} from '../caldav-provider.js';
import type { CalendarSyncEvent, ProviderEventPayload } from '../provider.js';

// ────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────

const crlf = (lines: readonly string[]): string => `${lines.join('\r\n')}\r\n`;

const LA_TZ = [
  'BEGIN:VTIMEZONE',
  'TZID:America/Los_Angeles',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0800',
  'TZOFFSETTO:-0700',
  'DTSTART:20070311T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'TZNAME:PDT',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0700',
  'TZOFFSETTO:-0800',
  'DTSTART:20071104T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'TZNAME:PST',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/** Outlook's own name for the zone, which no IANA table knows. */
const PACIFIC_WINDOWS = [
  'BEGIN:VTIMEZONE',
  'TZID:Pacific Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:-0700',
  'TZOFFSETTO:-0800',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:-0800',
  'TZOFFSETTO:-0700',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
];

const calendar = (...body: string[]): string =>
  crlf(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//macOS 15.0//EN', ...LA_TZ, ...body, 'END:VCALENDAR']);

const ALARM = ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT15M', 'END:VALARM'];

/** Saturday 17 Oct 2026, 10:00 in Los Angeles (PDT): 17:00 UTC. */
const DENTIST = calendar(
  'BEGIN:VEVENT',
  'UID:dentist-1',
  'DTSTAMP:20261001T000000Z',
  'DTSTART;TZID=America/Los_Angeles:20261017T100000',
  'DTEND;TZID=America/Los_Angeles:20261017T110000',
  'SUMMARY:Dentist',
  'DESCRIPTION:Bring the referral letter from Dr. Okafor and the insurance c',
  ' ard.',
  'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
  ...ALARM,
  'END:VEVENT',
);

/** Weekly from Saturday 17 Oct 2026 at 10:00 Los Angeles time, across the
 *  1 November change of clocks. */
const standup = (...extra: string[]): string => calendar(
  'BEGIN:VEVENT',
  'UID:standup-1',
  'DTSTAMP:20261001T000000Z',
  'DTSTART;TZID=America/Los_Angeles:20261017T100000',
  'DTEND;TZID=America/Los_Angeles:20261017T103000',
  'RRULE:FREQ=WEEKLY;COUNT=6',
  'SUMMARY:Standup',
  'SEQUENCE:2',
  ...extra,
  ...ALARM,
  'END:VEVENT',
);

const iso = (s: string): number => Date.parse(s);
/** A wall clock as the series' occurrence key: its digits read as UTC. */
const wall = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi);

const WINDOW = { windowStart: iso('2026-10-01T00:00:00Z'), windowEnd: iso('2027-01-31T00:00:00Z') };

// ────────────────────────────────────────────────────────────────
// Fake server
// ────────────────────────────────────────────────────────────────

const CAL_HREF = '/calendars/alice/work/';
const CAL_ID = createHash('sha1').update(CAL_HREF).digest('hex').slice(0, 24);

const homeXml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>${CAL_HREF}</href>
    <propstat><prop><displayname>Work</displayname><resourcetype><collection/><c:calendar/></resourcetype></prop></propstat>
  </response>
</multistatus>`;

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const mkText = (status: number, body: string): Awaited<ReturnType<HttpFetcher>> => ({
  status,
  ok: status >= 200 && status < 300,
  async json() {
    return JSON.parse(body) as unknown;
  },
  async text() {
    return body;
  },
});

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
}

/** A CalDAV server holding files by path: REPORT lists them all (with their
 *  data when asked), PUT stores, DELETE removes, each write a new ETag. */
const makeServer = (files: Record<string, string>) => {
  const store = new Map<string, { body: string; etag: string }>();
  let version = 0;
  const put = (path: string, body: string): void => {
    version += 1;
    store.set(path, { body, etag: `"v${version}"` });
  };
  for (const [name, body] of Object.entries(files)) put(`${CAL_HREF}${name}`, body);
  const calls: Call[] = [];
  const fetcher: HttpFetcher = async (url, init) => {
    const method = init?.method ?? 'GET';
    const path = new URL(url).pathname;
    calls.push({ method, path, headers: (init?.headers ?? {}) as Record<string, string> });
    if (method === 'PROPFIND') return mkText(207, homeXml);
    if (method === 'REPORT') {
      const withData = (init?.body ?? '').includes('calendar-data');
      const rows = [...store].map(([href, f]) =>
        `<response><href>${href}</href><propstat><prop><getetag>${f.etag}</getetag>${withData ? `<c:calendar-data>${xmlEscape(f.body)}</c:calendar-data>` : ''}</prop></propstat></response>`,
      ).join('');
      return mkText(207, `<?xml version="1.0"?><multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</multistatus>`);
    }
    if (method === 'GET') {
      const f = store.get(path);
      return f ? mkText(200, f.body) : mkText(404, '');
    }
    if (method === 'PUT') {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['If-None-Match'] === '*' && store.has(path)) return mkText(412, '');
      put(path, init?.body ?? '');
      return mkText(201, '');
    }
    if (method === 'DELETE') {
      if (!store.delete(path)) return mkText(404, '');
      return mkText(204, '');
    }
    return mkText(405, '');
  };
  const file = (name: string): string | undefined => store.get(`${CAL_HREF}${name}`)?.body;
  const etagOf = (name: string): string | undefined => store.get(`${CAL_HREF}${name}`)?.etag;
  return { fetcher, calls, file, etagOf, store, writes: () => calls.filter((c) => c.method === 'PUT' || c.method === 'DELETE') };
};

const makeEtagStore = (): CalDavEtagStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
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
    async list(prefix) {
      return [...data].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
    },
  };
};

const etagKeyFor = (slug: string, name: string): string =>
  `caldav.${slug}.etag.${CAL_ID}.${createHash('sha1').update(`${CAL_HREF}${name}`).digest('hex').slice(0, 16)}`;

const mkConfig = (o: Partial<CalDavProviderConfig> = {}): CalDavProviderConfig => ({
  server_url: 'https://caldav.example.com',
  username: 'alice',
  password: 'secret',
  calendar_home_url: 'https://caldav.example.com/calendars/alice/',
  expansion_future_days: 90,
  expansion_past_days: 30,
  poll_seconds: 60,
  ...o,
});

/** 15 Oct 2026: the standup's first occurrence is two days ahead. */
const NOW = iso('2026-10-15T12:00:00Z');

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

const mkProvider = (
  server: ReturnType<typeof makeServer>,
  opts: { etagStore?: CalDavEtagStore; timeZone?: string; config?: Partial<CalDavProviderConfig> } = {},
) => {
  const provider = createCalDavProvider({
    slug: 'personal',
    config: mkConfig(opts.config),
    fetcher: server.fetcher,
    etagStore: opts.etagStore ?? makeEtagStore(),
    scheduler: () => () => undefined,
    now: () => NOW,
    timeZone: () => opts.timeZone ?? 'America/Los_Angeles',
  });
  cleanup.push(() => provider.close());
  return provider;
};

const occurrencesOf = (body: string) => {
  const object = readCalDavObject(body, { timeZone: 'America/Los_Angeles' });
  expect(object).not.toBeNull();
  return expandCalDavObject(object!, WINDOW).occurrences;
};

const laTime = (at: number): string =>
  new Date(at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// ────────────────────────────────────────────────────────────────
// Reading
// ────────────────────────────────────────────────────────────────

describe('CalDAV — a time is read in its own zone', () => {
  it("reads Apple's 10:00 Los Angeles as 17:00 UTC, not 10:00 UTC", () => {
    const parsed = parseVEvent(DENTIST)!;
    expect(new Date(parsed.dtstart).toISOString()).toBe('2026-10-17T17:00:00.000Z');
    expect(new Date(parsed.dtend).toISOString()).toBe('2026-10-17T18:00:00.000Z');
    expect(parsed.timezone).toBe('America/Los_Angeles');
    // The reminder's DESCRIPTION is the reminder's; the old reader let it
    // replace the event's.
    expect(parsed.description).toBe('Bring the referral letter from Dr. Okafor and the insurance card.');
  });

  it("reads Outlook's Windows zone name by the file's own rules", () => {
    const ics = crlf([
      'BEGIN:VCALENDAR', 'VERSION:2.0', ...PACIFIC_WINDOWS,
      'BEGIN:VEVENT', 'UID:outlook-1',
      'DTSTART;TZID=Pacific Standard Time:20261110T140000',
      'DTEND;TZID=Pacific Standard Time:20261110T150000',
      'SUMMARY:Review', 'END:VEVENT', 'END:VCALENDAR',
    ]);
    const parsed = parseVEvent(ics)!;
    expect(new Date(parsed.dtstart).toISOString()).toBe('2026-11-10T22:00:00.000Z');
    expect(parsed.timezone).toBe('Pacific Standard Time');
  });

  it('reads an IANA zone the file gives no rules for by its name', () => {
    const ics = crlf([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:berlin-1',
      'DTSTART;TZID=Europe/Berlin:20260715T090000', 'DTEND;TZID=Europe/Berlin:20260715T100000',
      'SUMMARY:Call', 'END:VEVENT', 'END:VCALENDAR',
    ]);
    expect(new Date(parseVEvent(ics)!.dtstart).toISOString()).toBe('2026-07-15T07:00:00.000Z');
  });

  it("reads a floating time in the calendar's zone, else the owner's", () => {
    const floating = (header: string[]): string => crlf([
      'BEGIN:VCALENDAR', 'VERSION:2.0', ...header, 'BEGIN:VEVENT', 'UID:float-1',
      'DTSTART:20261017T100000', 'DTEND:20261017T110000', 'SUMMARY:Gym', 'END:VEVENT', 'END:VCALENDAR',
    ]);
    const owners = parseVEvent(floating([]), { timeZone: 'America/New_York' })!;
    expect(new Date(owners.dtstart).toISOString()).toBe('2026-10-17T14:00:00.000Z');
    expect(owners.timezone).toBe('America/New_York');
    const calendars = parseVEvent(floating(['X-WR-TIMEZONE:Europe/London']), { timeZone: 'America/New_York' })!;
    expect(new Date(calendars.dtstart).toISOString()).toBe('2026-10-17T09:00:00.000Z');
  });

  it("reads a zone nothing knows in the owner's zone, keeping the TZID it came with", () => {
    const warnings: string[] = [];
    const ics = crlf([
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:odd-1',
      'DTSTART;TZID=Eastern Time (custom):20261017T100000', 'DTEND;TZID=Eastern Time (custom):20261017T110000',
      'SUMMARY:Odd', 'END:VEVENT', 'END:VCALENDAR',
    ]);
    const parsed = parseVEvent(ics, { timeZone: 'America/Los_Angeles', warn: (m) => warnings.push(m) })!;
    expect(new Date(parsed.dtstart).toISOString()).toBe('2026-10-17T17:00:00.000Z');
    expect(parsed.timezone).toBe('Eastern Time (custom)');
    expect(warnings.join(' ')).toContain('Eastern Time (custom)');
  });

  it('reads DURATION, every EXDATE on a line, and a quoted SENT-BY', () => {
    const parsed = parseVEvent(calendar(
      'BEGIN:VEVENT', 'UID:dur-1',
      'DTSTART;TZID=America/Los_Angeles:20261017T100000', 'DURATION:PT1H30M',
      'RRULE:FREQ=WEEKLY',
      'EXDATE;TZID=America/Los_Angeles:20261024T100000,20261031T100000',
      'ORGANIZER;CN="Doe, Jane";SENT-BY="mailto:assistant@x.com":mailto:jane@x.com',
      'SUMMARY:Class', 'END:VEVENT',
    ))!;
    expect(parsed.dtend - parsed.dtstart).toBe(90 * 60_000);
    expect(parsed.exdates.map((t) => new Date(t).toISOString())).toEqual(['2026-10-24T17:00:00.000Z', '2026-10-31T17:00:00.000Z']);
    expect(parsed.organizer).toEqual({ email: 'jane@x.com', displayName: 'Doe, Jane' });
  });

  it("takes an event's own UID, not its alert's: Apple writes a UID in every VALARM", () => {
    const parsed = parseVEvent(calendar(
      'BEGIN:VEVENT', 'UID:event-uid', 'DTSTART;TZID=America/Los_Angeles:20261017T100000',
      'DTEND;TZID=America/Los_Angeles:20261017T110000', 'SUMMARY:Dentist',
      'BEGIN:VALARM', 'X-WR-ALARMUID:5E0B2B43-ALARM', 'UID:5E0B2B43-ALARM', 'TRIGGER:-PT15M', 'ACTION:AUDIO', 'END:VALARM',
      'END:VEVENT',
    ))!;
    expect(parsed.uid).toBe('event-uid');
  });

  it('takes the series from a file whose first VEVENT is an override', () => {
    const object = readCalDavObject(calendar(
      'BEGIN:VEVENT', 'UID:s-1', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261024T100000',
      'DTSTART;TZID=America/Los_Angeles:20261024T120000', 'DTEND;TZID=America/Los_Angeles:20261024T123000',
      'SUMMARY:Moved', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:s-1', 'DTSTART;TZID=America/Los_Angeles:20261017T100000',
      'DTEND;TZID=America/Los_Angeles:20261017T103000', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Series', 'END:VEVENT',
    ))!;
    expect(object.master?.summary).toBe('Series');
    expect(object.overrides.map((o) => o.summary)).toEqual(['Moved']);
  });
});

describe('CalDAV — a series is counted on its own clock', () => {
  it('keeps a weekly 10:00 at 10:00 across the change of clocks', () => {
    const occurrences = occurrencesOf(standup());
    expect(occurrences.map((o) => new Date(o.start).toISOString())).toEqual([
      '2026-10-17T17:00:00.000Z',
      '2026-10-24T17:00:00.000Z',
      '2026-10-31T17:00:00.000Z',
      '2026-11-07T18:00:00.000Z',
      '2026-11-14T18:00:00.000Z',
      '2026-11-21T18:00:00.000Z',
    ]);
    expect(occurrences.every((o) => laTime(o.start).endsWith('10:00'))).toBe(true);
  });

  it('counts a late-evening Monday by its own day: BYDAY reads the local clock', () => {
    const occurrences = occurrencesOf(calendar(
      'BEGIN:VEVENT', 'UID:late-1',
      'DTSTART;TZID=America/Los_Angeles:20261019T220000', 'DTEND;TZID=America/Los_Angeles:20261019T230000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3', 'SUMMARY:Late call', 'END:VEVENT',
    ));
    expect(occurrences.map((o) => laTime(o.start))).toEqual([
      'Mon, Oct 19, 22:00',
      'Mon, Oct 26, 22:00',
      'Mon, Nov 2, 22:00',
    ]);
  });

  it('leaves out an EXDATE written in UTC as well as one written in the zone', () => {
    const occurrences = occurrencesOf(standup(
      'EXDATE:20261024T170000Z',
      'EXDATE;TZID=America/Los_Angeles:20261107T100000',
    ));
    expect(occurrences.map((o) => laTime(o.start).slice(0, 12))).toEqual([
      'Sat, Oct 17,', 'Sat, Oct 31,', 'Sat, Nov 14,', 'Sat, Nov 21,',
    ]);
  });

  it('puts an override in the slot it replaces, keyed by that slot', () => {
    const occurrences = occurrencesOf(standup().replace('END:VCALENDAR', [
      'BEGIN:VEVENT', 'UID:standup-1', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261024T100000',
      'DTSTART;TZID=America/Los_Angeles:20261024T120000', 'DTEND;TZID=America/Los_Angeles:20261024T123000',
      'SUMMARY:Standup (moved to noon)', 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n')));
    const moved = occurrences.find((o) => o.key === wall(2026, 10, 24, 10))!;
    expect(moved.event.summary).toBe('Standup (moved to noon)');
    expect(laTime(moved.start)).toBe('Sat, Oct 24, 12:00');
    expect(occurrences).toHaveLength(6);
  });
});

// ────────────────────────────────────────────────────────────────
// Sync
// ────────────────────────────────────────────────────────────────

describe('CalDAV — sync', () => {
  it("names each occurrence by its wall clock: the ids rows already had, at corrected times", async () => {
    const server = makeServer({ 'standup-1.ics': standup() });
    const provider = mkProvider(server);
    const payloads: ProviderEventPayload[] = [];
    await provider.initialScan({
      backfill_days: 30, expansion_future_days: 90, expansion_past_days: 30,
      onEvent: async (p) => {
        payloads.push(p);
        return true;
      },
    });
    expect(payloads.map((p) => p.event.source_id)).toEqual([
      `${CAL_ID}:standup-1`,
      // The number the old reader wrote here: the wall clock read as UTC.
      `${CAL_ID}:standup-1:${wall(2026, 10, 24, 10)}`,
      `${CAL_ID}:standup-1:${wall(2026, 10, 31, 10)}`,
      `${CAL_ID}:standup-1:${wall(2026, 11, 7, 10)}`,
      `${CAL_ID}:standup-1:${wall(2026, 11, 14, 10)}`,
      `${CAL_ID}:standup-1:${wall(2026, 11, 21, 10)}`,
    ]);
    expect(new Date(payloads[3]!.event.start_at).toISOString()).toBe('2026-11-07T18:00:00.000Z');
    expect(payloads.every((p) => p.event.timezone === 'America/Los_Angeles')).toBe(true);
  });

  it('reads a resource stored before the fix once more, as a correction that wakes no trigger, then skips it', async () => {
    const server = makeServer({ 'dentist-1.ics': DENTIST });
    const etagStore = makeEtagStore();
    // What the old adapter left: the bare ETag, the same one the server has.
    etagStore.data.set(etagKeyFor('personal', 'dentist-1.ics'), server.etagOf('dentist-1.ics')!);
    const first: CalendarSyncEvent[] = [];
    const stop = await mkProvider(server, { etagStore }).startSync(async (e) => {
      first.push(e);
    });
    await stop();
    expect(first.map((e) => e.kind)).toEqual(['updated', 'series']);
    expect(first[0]!.payload!.correction).toBe(true);
    expect(new Date(first[0]!.payload!.event.start_at).toISOString()).toBe('2026-10-17T17:00:00.000Z');
    expect(JSON.parse(etagStore.data.get(etagKeyFor('personal', 'dentist-1.ics'))!)).toEqual({
      v: 2, etag: server.etagOf('dentist-1.ics'), uid: 'dentist-1',
    });

    const second: CalendarSyncEvent[] = [];
    const stop2 = await mkProvider(server, { etagStore }).startSync(async (e) => {
      second.push(e);
    });
    await stop2();
    expect(second).toEqual([]);
  });

  it('a resource changed on the server since is read as a change, not a correction', async () => {
    const server = makeServer({ 'dentist-1.ics': DENTIST });
    const etagStore = makeEtagStore();
    etagStore.data.set(etagKeyFor('personal', 'dentist-1.ics'), '"an-older-etag"');
    const events: CalendarSyncEvent[] = [];
    const stop = await mkProvider(server, { etagStore }).startSync(async (e) => {
      events.push(e);
    });
    await stop();
    expect(events[0]!.payload!.correction).toBeUndefined();
  });

  it("hands on the rows a resource makes in the window, and a gone resource's with none kept", async () => {
    const server = makeServer({ 'standup-1.ics': standup('EXDATE;TZID=America/Los_Angeles:20261031T100000') });
    const etagStore = makeEtagStore();
    const events: CalendarSyncEvent[] = [];
    const stop = await mkProvider(server, { etagStore }).startSync(async (e) => {
      events.push(e);
    });
    await stop();
    const series = events.find((e) => e.kind === 'series')!;
    expect(series.source_id).toBe(`${CAL_ID}:standup-1`);
    expect(series.series).toEqual({
      calendar_id: CAL_ID,
      ical_uid: 'standup-1',
      window: { start: NOW - 30 * 86_400_000, end: NOW + 90 * 86_400_000 },
      keep: events.filter((e) => e.kind === 'updated').map((e) => e.source_id),
    });
    expect(series.series!.keep).not.toContain(`${CAL_ID}:standup-1:${wall(2026, 10, 31, 10)}`);

    server.store.clear();
    const gone: CalendarSyncEvent[] = [];
    const stop2 = await mkProvider(server, { etagStore }).startSync(async (e) => {
      gone.push(e);
    });
    await stop2();
    expect(gone).toEqual([{
      kind: 'series',
      source_id: `${CAL_ID}:standup-1`,
      series: { calendar_id: CAL_ID, ical_uid: 'standup-1', window: { start: NOW - 30 * 86_400_000, end: NOW + 90 * 86_400_000 }, keep: [] },
    }]);
    expect(etagStore.data.size).toBe(0);
  });

  it('a gone resource stored before the fix names no UID: its key goes, and nothing else', async () => {
    const server = makeServer({});
    const etagStore = makeEtagStore();
    etagStore.data.set(etagKeyFor('personal', 'old.ics'), '"e-old"');
    const events: CalendarSyncEvent[] = [];
    const stop = await mkProvider(server, { etagStore }).startSync(async (e) => {
      events.push(e);
    });
    await stop();
    expect(events).toEqual([]);
    expect(etagStore.data.size).toBe(0);
  });

  it("a scan that read every resource hands on every row they make; an aborted one hands on none", async () => {
    const server = makeServer({ 'dentist-1.ics': DENTIST, 'standup-1.ics': standup() });
    const calendars: unknown[] = [];
    await mkProvider(server).initialScan({
      backfill_days: 30, expansion_future_days: 90, expansion_past_days: 30,
      onEvent: async () => true,
      onCalendar: async (c) => {
        calendars.push(c);
      },
    });
    expect(calendars).toEqual([{
      calendar_id: CAL_ID,
      window: { start: NOW - 30 * 86_400_000, end: NOW + 90 * 86_400_000 },
      keep: expect.arrayContaining([`${CAL_ID}:dentist-1`, `${CAL_ID}:standup-1`, `${CAL_ID}:standup-1:${wall(2026, 11, 21, 10)}`]),
    }]);
    expect((calendars[0] as { keep: string[] }).keep).toHaveLength(7);

    const aborted: unknown[] = [];
    let seen = 0;
    await mkProvider(server).initialScan({
      backfill_days: 30, expansion_future_days: 90, expansion_past_days: 30,
      onEvent: async () => (seen += 1) < 2,
      onCalendar: async (c) => {
        aborted.push(c);
      },
    });
    expect(aborted).toEqual([]);
  });

  it('a scan window narrower than the expansion bounds the calendar reconcile', async () => {
    const server = makeServer({ 'dentist-1.ics': DENTIST });
    const calendars: Array<{ window: { start: number; end: number } }> = [];
    await mkProvider(server).initialScan({
      backfill_days: 7, expansion_future_days: 60, expansion_past_days: 30,
      onEvent: async () => true,
      onCalendar: async (c) => {
        calendars.push(c);
      },
    });
    expect(calendars[0]!.window).toEqual({ start: NOW - 7 * 86_400_000, end: NOW + 60 * 86_400_000 });
  });

  it("the initial scan hands each resource's rows to onSeries", async () => {
    const server = makeServer({ 'dentist-1.ics': DENTIST });
    const seen: unknown[] = [];
    await mkProvider(server).initialScan({
      backfill_days: 30, expansion_future_days: 90, expansion_past_days: 30,
      onEvent: async () => true,
      onSeries: async (s) => {
        seen.push(s);
      },
    });
    expect(seen).toEqual([{
      calendar_id: CAL_ID, ical_uid: 'dentist-1',
      window: { start: NOW - 30 * 86_400_000, end: NOW + 90 * 86_400_000 },
      keep: [`${CAL_ID}:dentist-1`],
    }]);
  });
});

// ────────────────────────────────────────────────────────────────
// Writes
// ────────────────────────────────────────────────────────────────

const unchangedLines = (before: string, after: string, edited: readonly string[]): string[] =>
  before.split('\r\n').filter((l) => l.length > 0 && !edited.some((p) => l.startsWith(p)) && !after.split('\r\n').includes(l));

describe('CalDAV — a write edits the file in place', () => {
  it("a rename keeps the zone, the time, the reminder and the rest of the file", async () => {
    const server = makeServer({ 'dentist-1.ics': DENTIST });
    const payload = await mkProvider(server).updateEvent({
      calendar_id: CAL_HREF,
      source_id: `${CAL_ID}:dentist-1`,
      patch: { summary: 'Dentist — Dr. Okafor' },
    });
    const after = server.file('dentist-1.ics')!;
    expect(after).toContain('SUMMARY:Dentist — Dr. Okafor\r\n');
    // Every other line is as the server sent it: the zone's rules, the
    // zoned times, the folded description, the reminder, Apple's own.
    expect(unchangedLines(DENTIST, after, ['SUMMARY:', 'DTSTAMP:'])).toEqual([]);
    expect(after).toContain('DTSTART;TZID=America/Los_Angeles:20261017T100000\r\n');
    expect(after).toContain('DTSTAMP:20261015T120000Z\r\n');
    // A new name is no change of time: other apps need not take a new copy.
    expect(after).not.toContain('SEQUENCE');
    expect(new Date(payload.event.start_at).toISOString()).toBe('2026-10-17T17:00:00.000Z');
    expect(payload.event.summary).toBe('Dentist — Dr. Okafor');
  });

  it("a reschedule writes the new time on the event's own clock", async () => {
    const server = makeServer({ 'dentist-1.ics': DENTIST });
    // What the dispatcher sends for the Reschedule button: the instants, the
    // event's own zone filled in.
    const payload = await mkProvider(server).updateEvent({
      calendar_id: CAL_HREF,
      source_id: `${CAL_ID}:dentist-1`,
      patch: { start_at: iso('2026-10-17T18:00:00Z'), end_at: iso('2026-10-17T19:00:00Z'), timezone: 'America/Los_Angeles', is_all_day: false },
    });
    const after = server.file('dentist-1.ics')!;
    expect(after).toContain('DTSTART;TZID=America/Los_Angeles:20261017T110000\r\n');
    expect(after).toContain('DTEND;TZID=America/Los_Angeles:20261017T120000\r\n');
    expect(after).toContain('SEQUENCE:1\r\n');
    expect(after).toContain('BEGIN:VTIMEZONE');
    expect(after).toContain('TRIGGER:-PT15M');
    expect(new Date(payload.event.start_at).toISOString()).toBe('2026-10-17T18:00:00.000Z');
  });

  it('editing one occurrence writes its override and leaves the series', async () => {
    const server = makeServer({ 'standup-1.ics': standup('EXDATE;TZID=America/Los_Angeles:20261114T100000') });
    const id = `${CAL_ID}:standup-1:${wall(2026, 11, 7, 10)}`;
    const payload = await mkProvider(server).updateEvent({
      calendar_id: CAL_HREF,
      source_id: id,
      patch: { summary: 'Standup (late)', start_at: iso('2026-11-07T19:00:00Z'), end_at: iso('2026-11-07T19:30:00Z'), timezone: 'America/Los_Angeles', is_all_day: false },
    });
    const after = server.file('standup-1.ics')!;
    const object = readCalDavObject(after, { timeZone: 'America/Los_Angeles' })!;
    // The series is as it was: its rule, its start, its deleted date.
    expect(object.master!.summary).toBe('Standup');
    expect(object.master!.rrule).toBe('FREQ=WEEKLY;COUNT=6');
    expect(after).toContain('EXDATE;TZID=America/Los_Angeles:20261114T100000\r\n');
    expect(after.match(/DTSTART;TZID=America\/Los_Angeles:20261017T100000/g)).toHaveLength(1);
    // The occurrence has its own copy, its reminder with it.
    expect(object.overrides).toHaveLength(1);
    expect(after).toContain('RECURRENCE-ID;TZID=America/Los_Angeles:20261107T100000\r\n');
    expect(after).toContain('DTSTART;TZID=America/Los_Angeles:20261107T110000\r\n');
    expect(after.match(/BEGIN:VALARM/g)).toHaveLength(2);
    const occurrences = expandCalDavObject(object, WINDOW).occurrences;
    expect(occurrences.map((o) => `${laTime(o.start)} ${o.event.summary}`)).toEqual([
      'Sat, Oct 17, 10:00 Standup',
      'Sat, Oct 24, 10:00 Standup',
      'Sat, Oct 31, 10:00 Standup',
      'Sat, Nov 7, 11:00 Standup (late)',
      'Sat, Nov 21, 10:00 Standup',
    ]);
    expect(payload.event.source_id).toBe(id);
    expect(new Date(payload.event.start_at).toISOString()).toBe('2026-11-07T19:00:00.000Z');
  });

  it('editing an occurrence that has an override edits that override', async () => {
    const server = makeServer({ 'standup-1.ics': standup() });
    const provider = mkProvider(server);
    const id = `${CAL_ID}:standup-1:${wall(2026, 10, 24, 10)}`;
    await provider.updateEvent({ calendar_id: CAL_HREF, source_id: id, patch: { summary: 'First edit' } });
    await provider.updateEvent({ calendar_id: CAL_HREF, source_id: id, patch: { location: 'Room 4' } });
    const after = server.file('standup-1.ics')!;
    expect(after.match(/RECURRENCE-ID/g)).toHaveLength(1);
    const override = readCalDavObject(after)!.overrides[0]!;
    expect(override.summary).toBe('First edit');
    expect(override.location).toBe('Room 4');
  });

  it('the first occurrence of a series is one occurrence too', async () => {
    const server = makeServer({ 'standup-1.ics': standup() });
    await mkProvider(server).updateEvent({ calendar_id: CAL_HREF, source_id: `${CAL_ID}:standup-1`, patch: { summary: 'Kick-off' } });
    const object = readCalDavObject(server.file('standup-1.ics')!)!;
    expect(object.master!.summary).toBe('Standup');
    expect(object.overrides.map((o) => o.summary)).toEqual(['Kick-off']);
  });

  it('deleting one occurrence adds its EXDATE and drops its override; the series stays', async () => {
    const server = makeServer({ 'standup-1.ics': standup() });
    const provider = mkProvider(server);
    const id = `${CAL_ID}:standup-1:${wall(2026, 10, 31, 10)}`;
    await provider.updateEvent({ calendar_id: CAL_HREF, source_id: id, patch: { summary: 'About to go' } });
    await provider.deleteEvent({ calendar_id: CAL_HREF, source_id: id });
    expect(server.calls.filter((c) => c.method === 'DELETE')).toEqual([]);
    const after = server.file('standup-1.ics')!;
    expect(after).toContain('EXDATE;TZID=America/Los_Angeles:20261031T100000\r\n');
    expect(after).not.toContain('RECURRENCE-ID');
    expect(after).toContain('SEQUENCE:3\r\n');
    expect(occurrencesOf(after)).toHaveLength(5);
  });

  it('deleting a single event deletes its file', async () => {
    const server = makeServer({ 'dentist-1.ics': DENTIST });
    await mkProvider(server).deleteEvent({ calendar_id: CAL_HREF, source_id: `${CAL_ID}:dentist-1` });
    expect(server.file('dentist-1.ics')).toBeUndefined();
  });

  it('a series edit named from a later occurrence moves the whole series as far, its exceptions with it', async () => {
    const server = makeServer({
      'standup-1.ics': standup('EXDATE;TZID=America/Los_Angeles:20261031T100000').replace('END:VCALENDAR', [
        'BEGIN:VEVENT', 'UID:standup-1', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261024T100000',
        'DTSTART;TZID=America/Los_Angeles:20261024T120000', 'DTEND;TZID=America/Los_Angeles:20261024T123000',
        'SUMMARY:Standup (noon)', 'END:VEVENT', 'END:VCALENDAR',
      ].join('\r\n')),
    });
    // Move the whole series an hour later, from the 7 November occurrence (PST).
    const payload = await mkProvider(server).updateEvent({
      calendar_id: CAL_HREF,
      source_id: `${CAL_ID}:standup-1:${wall(2026, 11, 7, 10)}`,
      patch: { start_at: iso('2026-11-07T19:00:00Z'), end_at: iso('2026-11-07T19:30:00Z'), timezone: 'America/Los_Angeles', is_all_day: false },
      scope: 'series',
    });
    const after = server.file('standup-1.ics')!;
    expect(after).toContain('DTSTART;TZID=America/Los_Angeles:20261017T110000\r\n');
    expect(after).toContain('EXDATE;TZID=America/Los_Angeles:20261031T110000\r\n');
    expect(after).toContain('RECURRENCE-ID;TZID=America/Los_Angeles:20261024T110000\r\n');
    expect(occurrencesOf(after).map((o) => laTime(o.start))).toEqual([
      'Sat, Oct 17, 11:00',
      'Sat, Oct 24, 12:00',
      'Sat, Nov 7, 11:00',
      'Sat, Nov 14, 11:00',
      'Sat, Nov 21, 11:00',
    ]);
    expect(payload.event.source_id).toBe(`${CAL_ID}:standup-1:${wall(2026, 11, 7, 11)}`);
  });

  it('a series moved to another day against its BYDAY rule is refused, and nothing is written', async () => {
    const server = makeServer({
      'standup-1.ics': standup().replace('RRULE:FREQ=WEEKLY;COUNT=6', 'RRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=6'),
    });
    await expect(mkProvider(server).updateEvent({
      calendar_id: CAL_HREF,
      source_id: `${CAL_ID}:standup-1:${wall(2026, 10, 24, 10)}`,
      patch: { start_at: iso('2026-10-25T17:00:00Z'), end_at: iso('2026-10-25T17:30:00Z'), timezone: 'America/Los_Angeles', is_all_day: false },
      scope: 'series',
    })).rejects.toMatchObject({ code: 'rrule_unsupported' });
    expect(server.writes()).toEqual([]);
  });

  it('this and following keeps the zone, the reminder and the later deleted dates in the new series', async () => {
    const server = makeServer({
      'standup-1.ics': standup(
        'EXDATE;TZID=America/Los_Angeles:20261024T100000',
        'EXDATE;TZID=America/Los_Angeles:20261114T100000',
      ).replace('END:VCALENDAR', [
        'BEGIN:VEVENT', 'UID:standup-1', 'RECURRENCE-ID;TZID=America/Los_Angeles:20261121T100000',
        'DTSTART;TZID=America/Los_Angeles:20261121T120000', 'DTEND;TZID=America/Los_Angeles:20261121T123000',
        'SUMMARY:Standup (noon)', 'END:VEVENT', 'END:VCALENDAR',
      ].join('\r\n')),
    });
    const payload = await mkProvider(server).updateEvent({
      calendar_id: CAL_HREF,
      source_id: `${CAL_ID}:standup-1:${wall(2026, 11, 7, 10)}`,
      patch: { summary: 'Standup v2' },
      scope: 'this_and_future',
    });
    // The series ends before 7 November 10:00 PST (18:00 UTC).
    const before = server.file('standup-1.ics')!;
    expect(before).toContain('RRULE:FREQ=WEEKLY;UNTIL=20261107T175959Z\r\n');
    expect(before).not.toContain('RECURRENCE-ID');
    expect(occurrencesOf(before).map((o) => laTime(o.start))).toEqual(['Sat, Oct 17, 10:00', 'Sat, Oct 31, 10:00']);
    // The rest is a new series on the same clock.
    const newName = [...server.store.keys()].find((k) => !k.endsWith('standup-1.ics'))!.slice(CAL_HREF.length);
    const after = server.file(newName)!;
    expect(after).toContain('BEGIN:VTIMEZONE');
    expect(after).toContain('DTSTART;TZID=America/Los_Angeles:20261107T100000\r\n');
    expect(after).toContain('EXDATE;TZID=America/Los_Angeles:20261114T100000\r\n');
    expect(after).not.toContain('20261024T100000');
    expect(after).toContain('TRIGGER:-PT15M');
    expect(after).toContain('RRULE:FREQ=WEEKLY;COUNT=3\r\n');
    expect(occurrencesOf(after).map((o) => `${laTime(o.start)} ${o.event.summary}`)).toEqual([
      'Sat, Nov 7, 10:00 Standup v2',
      'Sat, Nov 21, 10:00 Standup v2',
    ]);
    expect(new Date(payload.event.start_at).toISOString()).toBe('2026-11-07T18:00:00.000Z');
  });

  it('an all-day series counts days, and deletes an occurrence as a day', async () => {
    const server = makeServer({
      'bins-1.ics': calendar(
        'BEGIN:VEVENT', 'UID:bins-1', 'DTSTART;VALUE=DATE:20261019', 'DTEND;VALUE=DATE:20261020',
        'RRULE:FREQ=WEEKLY;COUNT=4', 'EXDATE;VALUE=DATE:20261026', 'SUMMARY:Bins out', 'END:VEVENT',
      ),
    });
    expect(occurrencesOf(server.file('bins-1.ics')!).map((o) => new Date(o.start).toISOString().slice(0, 10)))
      .toEqual(['2026-10-19', '2026-11-02', '2026-11-09']);
    await mkProvider(server).deleteEvent({ calendar_id: CAL_HREF, source_id: `${CAL_ID}:bins-1:${Date.UTC(2026, 10, 2)}` });
    const after = server.file('bins-1.ics')!;
    expect(after).toContain('EXDATE;VALUE=DATE:20261102\r\n');
    expect(occurrencesOf(after).map((o) => new Date(o.start).toISOString().slice(0, 10))).toEqual(['2026-10-19', '2026-11-09']);
  });

  it('a floating event stays floating when moved: its new time is written on the clock it is read on', async () => {
    const server = makeServer({
      'gym-1.ics': crlf([
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:gym-1',
        'DTSTART:20261017T070000', 'DTEND:20261017T080000', 'SUMMARY:Gym', 'END:VEVENT', 'END:VCALENDAR',
      ]),
    });
    const provider = mkProvider(server, { timeZone: 'America/New_York' });
    // 07:00 in New York (EDT) is 11:00 UTC; the owner moves it an hour later.
    await provider.updateEvent({
      calendar_id: CAL_HREF,
      source_id: `${CAL_ID}:gym-1`,
      patch: { start_at: iso('2026-10-17T12:00:00Z'), end_at: iso('2026-10-17T13:00:00Z'), timezone: 'America/New_York', is_all_day: false },
    });
    const after = server.file('gym-1.ics')!;
    expect(after).toContain('DTSTART:20261017T080000\r\n');
    expect(after).toContain('DTEND:20261017T090000\r\n');
    expect(after).not.toContain('VTIMEZONE');
  });

  it('a UTC event stays UTC when moved', async () => {
    const server = makeServer({
      'utc-1.ics': crlf([
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:utc-1',
        'DTSTART:20261017T150000Z', 'DTEND:20261017T160000Z', 'SUMMARY:Sync', 'END:VEVENT', 'END:VCALENDAR',
      ]),
    });
    await mkProvider(server).updateEvent({
      calendar_id: CAL_HREF,
      source_id: `${CAL_ID}:utc-1`,
      patch: { start_at: iso('2026-10-17T16:00:00Z'), end_at: iso('2026-10-17T17:00:00Z'), timezone: 'UTC', is_all_day: false },
    });
    expect(server.file('utc-1.ics')!).toContain('DTSTART:20261017T160000Z\r\n');
  });

  it('an event moved to another zone gets that zone\'s rules in its file', async () => {
    const server = makeServer({ 'dentist-1.ics': DENTIST });
    await mkProvider(server).updateEvent({
      calendar_id: CAL_HREF,
      source_id: `${CAL_ID}:dentist-1`,
      patch: { start_at: iso('2026-10-17T08:00:00Z'), end_at: iso('2026-10-17T09:00:00Z'), timezone: 'Europe/Berlin', is_all_day: false },
    });
    const after = server.file('dentist-1.ics')!;
    expect(after).toContain('TZID:Europe/Berlin\r\n');
    expect(after).toContain('DTSTART;TZID=Europe/Berlin:20261017T100000\r\n');
    // The rules go before the event, inside the calendar.
    expect(after.indexOf('TZID:Europe/Berlin')).toBeLessThan(after.indexOf('BEGIN:VEVENT'));
    expect(new Date(parseVEvent(after)!.dtstart).toISOString()).toBe('2026-10-17T08:00:00.000Z');
  });

  it("a new event is written in its zone, with the zone's rules", async () => {
    const server = makeServer({});
    const payload = await mkProvider(server).createEvent(CAL_HREF, {
      calendar_id: CAL_HREF,
      summary: 'Dental check-up',
      start_at: iso('2026-10-17T17:00:00Z'),
      end_at: iso('2026-10-17T18:00:00Z'),
      timezone: 'America/Los_Angeles',
      is_all_day: false,
      status: 'confirmed',
      ical_uid: 'invite-1@example.com',
    });
    const body = server.file('invite-1@example.com.ics')!;
    expect(body).toContain('TZID:America/Los_Angeles\r\n');
    expect(body).toContain('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\n');
    expect(body).toContain('DTSTART;TZID=America/Los_Angeles:20261017T100000\r\n');
    expect(payload.event.timezone).toBe('America/Los_Angeles');
    expect(new Date(payload.event.start_at).toISOString()).toBe('2026-10-17T17:00:00.000Z');
  });

  it('a new all-day event is written as days', async () => {
    const server = makeServer({});
    await mkProvider(server).createEvent(CAL_HREF, {
      calendar_id: CAL_HREF,
      summary: 'Holiday',
      start_at: Date.UTC(2026, 11, 24),
      end_at: Date.UTC(2026, 11, 26),
      timezone: 'America/Los_Angeles',
      is_all_day: true,
      status: 'confirmed',
      ical_uid: 'holiday-1',
    });
    const body = server.file('holiday-1.ics')!;
    expect(body).toContain('DTSTART;VALUE=DATE:20261224\r\n');
    expect(body).toContain('DTEND;VALUE=DATE:20261226\r\n');
    expect(body).not.toContain('VTIMEZONE');
  });

  it('an answer to an invite changes only the answer', async () => {
    const invite = calendar(
      'BEGIN:VEVENT', 'UID:invite-2', 'DTSTART;TZID=America/Los_Angeles:20261020T090000',
      'DTEND;TZID=America/Los_Angeles:20261020T100000', 'SUMMARY:Planning',
      'ORGANIZER;CN=Jane:mailto:jane@x.com',
      'ATTENDEE;CN=Jane;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:jane@x.com',
      'ATTENDEE;CN=Me;ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:me@x.com',
      'END:VEVENT',
    );
    const server = makeServer({ 'invite-2.ics': invite });
    const payload = await mkProvider(server, { config: { scheduling_outbox_url: 'https://caldav.example.com/calendars/alice/outbox/' } }).rsvpEvent({
      calendar_id: CAL_HREF,
      source_id: `${CAL_ID}:invite-2`,
      response: 'accepted',
      self_email: 'me@x.com',
    });
    const written = server.file('invite-2.ics')!;
    // The edited line is longer than 75 octets, so it is written folded.
    expect(written).toContain('PARTSTAT=ACCEPTED:mailto:me@x\r\n .com\r\n');
    const after = written.replace(/\r\n[ \t]/g, '');
    expect(after).toContain('ATTENDEE;CN=Me;ROLE=REQ-PARTICIPANT;RSVP=TRUE;PARTSTAT=ACCEPTED:mailto:me@x.com\r\n');
    expect(after).toContain('ATTENDEE;CN=Jane;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:jane@x.com\r\n');
    expect(after).toContain('DTSTART;TZID=America/Los_Angeles:20261020T090000\r\n');
    expect(after).not.toContain('SEQUENCE');
    expect(payload.event.attendees?.find((a) => a.email === 'me@x.com')?.response_status).toBe('accepted');
  });
});
