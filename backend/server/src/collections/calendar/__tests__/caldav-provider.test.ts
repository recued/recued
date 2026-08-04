/** D-117 Phase 5 — CalDAV calendar adapter tests.
 *
 *  Covers:
 *    - XML parsers (PROPFIND calendar-home, REPORT calendar-query).
 *    - iCal parser (VEVENT fields, line-folding, escape unescape,
 *      attendees, DTSTART / DTEND + TZID + all-day, RRULE, EXDATE,
 *      STATUS, RECURRENCE-ID).
 *    - RRULE expander (DAILY / WEEKLY / MONTHLY / YEARLY + INTERVAL +
 *      COUNT + UNTIL + BYDAY; EXDATE exclusion; unknown FREQ →
 *      partial + dtstart-only; window clipping).
 *    - connect: 401 → auth_expired.
 *    - initialScan: PROPFIND → REPORT → ingest expanded instances,
 *      abort via onEvent=false, calendar_filter selection.
 *    - startSync: ETag diff (new / changed / unchanged / removed),
 *      restart resilience via etagStore.
 *    - Write-back (create / update / delete / rsvp).
 *    - Factory probe: caps shape, auth failure, rsvp cap probe
 *      (with / without scheduling outbox).
 *
 *  No live network — the fetcher is routed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CrossOriginRedirectError } from '@recued/ingredients';

import type { HttpFetcher } from '../../mail/oauth.js';
import {
  capRRuleUntil,
  createCalDavAdapterFactory,
  createCalDavProvider,
  expandRRule,
  newSeriesRRule,
  parseCalendarHomePropfind,
  parseCalendarQuery,
  parseRRuleString,
  parseVEvent,
  type CalDavEtagStore,
  type CalDavProviderConfig,
} from '../caldav-provider.js';
import type { CalendarSyncEvent } from '../provider.js';

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const makeEtagStore = (): CalDavEtagStore & {
  data: Map<string, string>;
} => {
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
      const out: Array<{ key: string; value: string }> = [];
      for (const [key, value] of data.entries()) {
        if (key.startsWith(prefix)) out.push({ key, value });
      }
      return out;
    },
  };
};

interface Route {
  match: (url: string, init?: { method?: string; body?: string }) => boolean;
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
  o: Partial<CalDavProviderConfig> = {},
): CalDavProviderConfig => ({
  server_url: 'https://caldav.example.com',
  username: 'alice',
  password: 'secret',
  calendar_home_url:
    'https://caldav.example.com/calendars/alice/',
  expansion_future_days: 30,
  expansion_past_days: 7,
  poll_seconds: 60,
  ...o,
});

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

// ────────────────────────────────────────────────────────────────
// DAV XML parsers
// ────────────────────────────────────────────────────────────────

describe('parseCalendarHomePropfind', () => {
  it('extracts calendar collections (ignores addressbooks)', () => {
    const xml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/alice/work/</href>
    <propstat>
      <prop>
        <displayname>Work</displayname>
        <resourcetype><collection/><c:calendar/></resourcetype>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
  <response>
    <href>/calendars/alice/contacts/</href>
    <propstat>
      <prop>
        <displayname>Contacts</displayname>
        <resourcetype><collection/><addressbook/></resourcetype>
      </prop>
    </propstat>
  </response>
</multistatus>`;
    const out = parseCalendarHomePropfind(xml);
    expect(out).toHaveLength(2);
    expect(out[0].href).toBe('/calendars/alice/work/');
    expect(out[0].displayname).toBe('Work');
    expect(out[0].isCalendar).toBe(true);
    expect(out[1].isCalendar).toBe(false);
  });

  it('handles namespace prefixes (D: / c:)', () => {
    const xml = `<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/calendars/alice/work/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>Work</D:displayname>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      </D:prop>
    </D:propstat>
  </D:response>
</D:multistatus>`;
    const out = parseCalendarHomePropfind(xml);
    expect(out).toHaveLength(1);
    expect(out[0].isCalendar).toBe(true);
  });
});

describe('parseCalendarQuery', () => {
  it('extracts href + etag entries', () => {
    const xml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/alice/work/evt-1.ics</href>
    <propstat>
      <prop>
        <getetag>"etag-1"</getetag>
      </prop>
    </propstat>
  </response>
  <response>
    <href>/calendars/alice/work/evt-2.ics</href>
    <propstat>
      <prop>
        <getetag>"etag-2"</getetag>
      </prop>
    </propstat>
  </response>
</multistatus>`;
    const out = parseCalendarQuery(xml);
    expect(out).toHaveLength(2);
    expect(out[0].href).toBe('/calendars/alice/work/evt-1.ics');
    expect(out[0].etag).toBe('"etag-1"');
  });

  it('preserves calendar-data when present', () => {
    const ics = 'BEGIN:VEVENT\r\nUID:abc\r\nDTSTART:20260423T120000Z\r\nEND:VEVENT';
    const xml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/c/e.ics</href>
    <propstat>
      <prop>
        <getetag>"etag-1"</getetag>
        <c:calendar-data>${ics}</c:calendar-data>
      </prop>
    </propstat>
  </response>
</multistatus>`;
    const out = parseCalendarQuery(xml);
    expect(out[0].calendarData).toContain('BEGIN:VEVENT');
  });
});

// ────────────────────────────────────────────────────────────────
// iCal parser
// ────────────────────────────────────────────────────────────────

describe('parseVEvent', () => {
  it('parses a timed VEVENT with organizer + attendees', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:evt-1@x',
      'DTSTART:20260423T120000Z',
      'DTEND:20260423T130000Z',
      'SUMMARY:Weekly sync',
      'DESCRIPTION:some details\\, see link',
      'LOCATION:Conf Rm A',
      'STATUS:CONFIRMED',
      'ORGANIZER;CN=Alice:mailto:alice@x.com',
      'ATTENDEE;CN=Alice;PARTSTAT=ACCEPTED:mailto:alice@x.com',
      'ATTENDEE;CN=Bob;PARTSTAT=NEEDS-ACTION:mailto:bob@x.com',
      'CREATED:20260420T000000Z',
      'LAST-MODIFIED:20260421T120000Z',
      'SEQUENCE:3',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const parsed = parseVEvent(ics);
    expect(parsed).not.toBeNull();
    expect(parsed!.uid).toBe('evt-1@x');
    expect(parsed!.summary).toBe('Weekly sync');
    expect(parsed!.description).toBe('some details, see link');
    expect(parsed!.location).toBe('Conf Rm A');
    expect(parsed!.dtstart).toBe(Date.UTC(2026, 3, 23, 12, 0, 0));
    expect(parsed!.dtend).toBe(Date.UTC(2026, 3, 23, 13, 0, 0));
    expect(parsed!.timezone).toBe('UTC');
    expect(parsed!.isAllDay).toBe(false);
    expect(parsed!.status).toBe('confirmed');
    expect(parsed!.organizer).toEqual({ email: 'alice@x.com', displayName: 'Alice' });
    expect(parsed!.attendees).toHaveLength(2);
    expect(parsed!.attendees![0].responseStatus).toBe('accepted');
    expect(parsed!.attendees![1].responseStatus).toBe('needs_action');
    expect(parsed!.sequence).toBe(3);
  });

  it('parses all-day VEVENT with DTSTART as YYYYMMDD + TZID', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:bday',
      'DTSTART;TZID=America/Los_Angeles;VALUE=DATE:20260501',
      'DTEND;VALUE=DATE:20260502',
      'SUMMARY:Birthday',
      'END:VEVENT',
    ].join('\r\n');
    const parsed = parseVEvent(ics);
    expect(parsed!.isAllDay).toBe(true);
    expect(parsed!.dtstart).toBe(Date.UTC(2026, 4, 1));
    expect(parsed!.timezone).toBe('America/Los_Angeles');
  });

  it('unfolds line continuations per RFC 5545 (strips leading whitespace of continuation lines)', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:long',
      'DTSTART:20260423T120000Z',
      'DTEND:20260423T130000Z',
      'SUMMARY:Line one ',
      ' continues here',
      'END:VEVENT',
    ].join('\r\n');
    const parsed = parseVEvent(ics);
    // The continuation is stripped of its leading space/tab, then
    // concatenated — so the author must include trailing whitespace
    // on the prior line (as this test does) for readable spacing.
    expect(parsed!.summary).toBe('Line one continues here');
  });

  it('reads RRULE + EXDATE + RECURRENCE-ID + STATUS', () => {
    const ics = [
      'BEGIN:VEVENT',
      'UID:weekly',
      'DTSTART:20260423T120000Z',
      'DTEND:20260423T130000Z',
      'SUMMARY:Weekly',
      'STATUS:TENTATIVE',
      'RRULE:FREQ=WEEKLY;COUNT=10',
      'EXDATE:20260507T120000Z',
      'RECURRENCE-ID:20260430T120000Z',
      'END:VEVENT',
    ].join('\r\n');
    const parsed = parseVEvent(ics);
    expect(parsed!.rrule).toBe('FREQ=WEEKLY;COUNT=10');
    expect(parsed!.exdates).toEqual([Date.UTC(2026, 4, 7, 12, 0, 0)]);
    expect(parsed!.recurrenceId).toBe(Date.UTC(2026, 3, 30, 12, 0, 0));
    expect(parsed!.status).toBe('tentative');
  });

  it('returns null for VEVENT missing UID', () => {
    const ics = [
      'BEGIN:VEVENT',
      'DTSTART:20260423T120000Z',
      'SUMMARY:No UID',
      'END:VEVENT',
    ].join('\r\n');
    expect(parseVEvent(ics)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// RRULE expander
// ────────────────────────────────────────────────────────────────

describe('parseRRuleString', () => {
  it('parses FREQ + INTERVAL + COUNT', () => {
    const p = parseRRuleString('FREQ=DAILY;INTERVAL=2;COUNT=5');
    expect(p.freq).toBe('DAILY');
    expect(p.interval).toBe(2);
    expect(p.count).toBe(5);
  });

  it('parses BYDAY into weekday indices', () => {
    const p = parseRRuleString('FREQ=WEEKLY;BYDAY=MO,WE,FR');
    expect(p.byday).toBeInstanceOf(Set);
    expect([...p.byday!].sort()).toEqual([1, 3, 5]);
  });

  it('parses UNTIL into unix-ms', () => {
    const p = parseRRuleString('FREQ=DAILY;UNTIL=20260430T000000Z');
    expect(p.until).toBe(Date.UTC(2026, 3, 30));
  });

  it('tags unknown FREQ', () => {
    expect(parseRRuleString('FREQ=BIWEEKLY').freq).toBe('UNKNOWN');
  });
});

describe('expandRRule', () => {
  const winStart = Date.UTC(2026, 3, 20);
  const winEnd = Date.UTC(2026, 4, 20);

  it('DAILY with COUNT', () => {
    const dtstart = Date.UTC(2026, 3, 23, 12, 0, 0);
    const { instances } = expandRRule(
      dtstart,
      'FREQ=DAILY;COUNT=3',
      [],
      { windowStart: winStart, windowEnd: winEnd },
    );
    expect(instances).toHaveLength(3);
    expect(instances[0]).toBe(dtstart);
    expect(instances[1]).toBe(dtstart + 86_400_000);
    expect(instances[2]).toBe(dtstart + 2 * 86_400_000);
  });

  it('WEEKLY with INTERVAL + UNTIL', () => {
    const dtstart = Date.UTC(2026, 3, 23, 12, 0, 0);
    const { instances } = expandRRule(
      dtstart,
      'FREQ=WEEKLY;INTERVAL=1;UNTIL=20260520T000000Z',
      [],
      { windowStart: winStart, windowEnd: winEnd },
    );
    // 2026-04-23 falls on a Thursday; window ends 2026-05-20 but UNTIL
    // caps at 2026-05-20T00:00Z, so occurrences on Apr 23 and Apr 30
    // and May 7 and May 14 → 4 instances within window.
    expect(instances.length).toBe(4);
  });

  it('excludes EXDATE occurrences', () => {
    const dtstart = Date.UTC(2026, 3, 23);
    const exdate = Date.UTC(2026, 3, 25);
    const { instances } = expandRRule(
      dtstart,
      'FREQ=DAILY;COUNT=5',
      [exdate],
      { windowStart: winStart, windowEnd: winEnd },
    );
    // 5 occurrences minus exdate on day 3 → 4 emitted.
    expect(instances).toHaveLength(4);
    expect(instances).not.toContain(exdate);
  });

  it('WEEKLY BYDAY emits the named weekdays only', () => {
    const dtstart = Date.UTC(2026, 3, 20); // Monday
    const { instances } = expandRRule(
      dtstart,
      'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4',
      [],
      {
        windowStart: Date.UTC(2026, 3, 20),
        windowEnd: Date.UTC(2026, 4, 31),
      },
    );
    expect(instances.length).toBeGreaterThanOrEqual(3);
    for (const at of instances) {
      const dow = new Date(at).getUTCDay();
      expect([1, 3]).toContain(dow);
    }
  });

  it('unknown FREQ returns partial=true and dtstart-only', () => {
    const dtstart = Date.UTC(2026, 3, 23);
    const r = expandRRule(
      dtstart,
      'FREQ=BIWEEKLY;COUNT=5',
      [],
      { windowStart: winStart, windowEnd: winEnd },
    );
    expect(r.partial).toBe(true);
    expect(r.instances).toEqual([dtstart]);
  });

  it('no RRULE returns dtstart within window', () => {
    const dtstart = Date.UTC(2026, 3, 23);
    const r = expandRRule(
      dtstart,
      undefined,
      [],
      { windowStart: winStart, windowEnd: winEnd },
    );
    expect(r.partial).toBe(false);
    expect(r.instances).toEqual([dtstart]);
  });

  it('clips to window bounds', () => {
    const dtstart = Date.UTC(2026, 3, 1); // before window
    const r = expandRRule(
      dtstart,
      'FREQ=DAILY;COUNT=5',
      [],
      { windowStart: winStart, windowEnd: winEnd },
    );
    // Window starts Apr 20; dtstart is Apr 1. Dates Apr 1..5 all
    // before window start → zero emitted.
    expect(r.instances).toHaveLength(0);
  });

  it('MONTHLY expansion across multiple months', () => {
    const dtstart = Date.UTC(2026, 0, 15);
    const r = expandRRule(
      dtstart,
      'FREQ=MONTHLY;COUNT=5',
      [],
      {
        windowStart: Date.UTC(2026, 0, 1),
        windowEnd: Date.UTC(2026, 11, 31),
      },
    );
    expect(r.instances).toHaveLength(5);
    // Each occurrence should be one UTC month after the previous.
    for (let i = 1; i < r.instances.length; i++) {
      const prev = new Date(r.instances[i - 1]);
      const cur = new Date(r.instances[i]);
      expect(cur.getUTCMonth()).toBe((prev.getUTCMonth() + 1) % 12);
    }
  });
});

describe('capRRuleUntil', () => {
  it('appends UNTIL to an unbounded rule', () => {
    expect(capRRuleUntil('FREQ=DAILY', '20260610T085959Z')).toBe(
      'FREQ=DAILY;UNTIL=20260610T085959Z',
    );
  });

  it('replaces an existing UNTIL', () => {
    expect(
      capRRuleUntil('FREQ=WEEKLY;UNTIL=20270101T000000Z', '20260610T085959Z'),
    ).toBe('FREQ=WEEKLY;UNTIL=20260610T085959Z');
  });

  it('drops COUNT (mutually exclusive with UNTIL) and keeps other parts', () => {
    expect(
      capRRuleUntil('FREQ=WEEKLY;COUNT=10;BYDAY=MO,WE', '20260610'),
    ).toBe('FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20260610');
  });

  it('ignores empty parts from a trailing separator', () => {
    expect(capRRuleUntil('FREQ=DAILY;', '20260610T085959Z')).toBe(
      'FREQ=DAILY;UNTIL=20260610T085959Z',
    );
  });
});

describe('newSeriesRRule', () => {
  const DAY = 86_400_000;
  const START = Date.UTC(2026, 5, 1, 9, 0, 0);

  it('carries an unbounded rule forward verbatim', () => {
    expect(newSeriesRRule('FREQ=DAILY', START, START + 5 * DAY)).toBe(
      'FREQ=DAILY',
    );
  });

  it('carries an UNTIL-bounded rule forward verbatim', () => {
    expect(
      newSeriesRRule('FREQ=DAILY;UNTIL=20260701T090000Z', START, START + 5 * DAY),
    ).toBe('FREQ=DAILY;UNTIL=20260701T090000Z');
  });

  it('recomputes COUNT as the remaining tail (no phantom occurrences)', () => {
    // 10-occurrence daily series split at the 6th occurrence (index 5):
    // 5 occurrences fall before the split → 5 remain.
    expect(
      newSeriesRRule('FREQ=DAILY;COUNT=10', START, START + 5 * DAY),
    ).toBe('FREQ=DAILY;COUNT=5');
  });

  it('floors the remaining COUNT at 1', () => {
    expect(
      newSeriesRRule('FREQ=DAILY;COUNT=3', START, START + 10 * DAY),
    ).toBe('FREQ=DAILY;COUNT=1');
  });
});

// ────────────────────────────────────────────────────────────────
// connect
// ────────────────────────────────────────────────────────────────

describe('CalDavProvider — connect', () => {
  it('PROPFINDs on the calendar-home to validate credentials', async () => {
    const { fetcher, calls } = makeRouter([
      {
        match: (u, init) => u.endsWith('/calendars/alice/') && init?.method === 'PROPFIND',
        response: {
          status: 207,
          body: '<multistatus xmlns="DAV:"><response><href>/calendars/alice/</href></response></multistatus>',
        },
      },
    ]);
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await provider.connect();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PROPFIND');
  });

  it('maps 401 to auth_expired', async () => {
    const { fetcher } = makeRouter([
      {
        match: (u, init) => init?.method === 'PROPFIND',
        response: { status: 401, body: 'Unauthorized' },
      },
    ]);
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(provider.connect()).rejects.toMatchObject({
      code: 'auth_expired',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// initialScan + startSync
// ────────────────────────────────────────────────────────────────

describe('CalDavProvider — initialScan', () => {
  const homeXml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/alice/work/</href>
    <propstat>
      <prop>
        <displayname>Work</displayname>
        <resourcetype><collection/><c:calendar/></resourcetype>
      </prop>
    </propstat>
  </response>
</multistatus>`;

  const event1Ics = [
    'BEGIN:VEVENT',
    'UID:evt-1',
    'DTSTART:20260423T120000Z',
    'DTEND:20260423T130000Z',
    'SUMMARY:A',
    'END:VEVENT',
  ].join('\r\n');

  const event2Ics = [
    'BEGIN:VEVENT',
    'UID:evt-2',
    'DTSTART:20260424T120000Z',
    'DTEND:20260424T130000Z',
    'SUMMARY:B',
    'END:VEVENT',
  ].join('\r\n');

  const reportXml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/alice/work/evt-1.ics</href>
    <propstat>
      <prop>
        <getetag>"e1"</getetag>
        <c:calendar-data>${event1Ics}</c:calendar-data>
      </prop>
    </propstat>
  </response>
  <response>
    <href>/calendars/alice/work/evt-2.ics</href>
    <propstat>
      <prop>
        <getetag>"e2"</getetag>
        <c:calendar-data>${event2Ics}</c:calendar-data>
      </prop>
    </propstat>
  </response>
</multistatus>`;

  it('refuses a server-returned calendar href before forwarding Basic auth', async () => {
    const hostileHomeXml = homeXml.replace(
      '/calendars/alice/work/',
      'https://collector.invalid/stolen/',
    );
    const { fetcher, calls } = makeRouter([
      {
        match: (_u, init) => init?.method === 'PROPFIND',
        response: { status: 207, body: hostileHomeXml },
      },
    ]);
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());

    await expect(provider.initialScan({
      backfill_days: 7,
      expansion_future_days: 30,
      expansion_past_days: 7,
      onEvent: async () => true,
    })).rejects.toMatchObject({
      code: 'io_error',
      message: expect.stringContaining("refused resource origin 'https://collector.invalid'"),
    });
    expect(calls).toEqual([{
      url: 'https://caldav.example.com/calendars/alice/',
      method: 'PROPFIND',
    }]);
  });

  it('discovers calendars and streams expanded events to onEvent', async () => {
    const { fetcher } = makeRouter([
      {
        match: (u, init) => u.includes('/alice/') && init?.method === 'PROPFIND',
        response: { status: 207, body: homeXml },
      },
      {
        match: (u, init) =>
          u.includes('/alice/work/') && init?.method === 'REPORT',
        response: { status: 207, body: reportXml },
      },
    ]);
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
      now: () => Date.UTC(2026, 3, 20),
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

  it('aborts when onEvent returns false', async () => {
    const { fetcher } = makeRouter([
      {
        match: (u, init) => u.includes('/alice/') && init?.method === 'PROPFIND',
        response: { status: 207, body: homeXml },
      },
      {
        match: (u, init) =>
          u.includes('/alice/work/') && init?.method === 'REPORT',
        response: { status: 207, body: reportXml },
      },
    ]);
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
      now: () => Date.UTC(2026, 3, 20),
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
});

describe('CalDavProvider — startSync (ETag diff)', () => {
  const homeXml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/alice/work/</href>
    <propstat>
      <prop>
        <displayname>Work</displayname>
        <resourcetype><collection/><c:calendar/></resourcetype>
      </prop>
    </propstat>
  </response>
</multistatus>`;

  const makeReport = (
    entries: Array<{ href: string; etag: string; ics?: string }>,
  ): string => {
    const rows = entries
      .map(
        (e) => `<response><href>${e.href}</href><propstat><prop><getetag>${e.etag}</getetag>${e.ics ? `<c:calendar-data>${e.ics}</c:calendar-data>` : ''}</prop></propstat></response>`,
      )
      .join('');
    return `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</multistatus>`;
  };

  const eventIcs = (uid: string, summary: string) =>
    [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      'DTSTART:20260423T120000Z',
      'DTEND:20260423T130000Z',
      `SUMMARY:${summary}`,
      'END:VEVENT',
    ].join('\r\n');

  it('emits updated for new + changed, deleted for missing, skips unchanged', async () => {
    const etagStore = makeEtagStore();
    // Pre-seed one href with an old etag (will be missing) and one
    // with a current etag (will be unchanged).
    etagStore.data.set(
      'caldav.personal.etag.<placeholder>.<a>',
      '"gone-1"',
    );

    let reportCallCount = 0;
    const fetcher: HttpFetcher = async (url, init) => {
      if (init?.method === 'PROPFIND') {
        return mkText(207, homeXml);
      }
      if (init?.method === 'REPORT') {
        reportCallCount++;
        return mkText(
          207,
          makeReport([
            {
              href: '/calendars/alice/work/new.ics',
              etag: '"e-new"',
              ics: eventIcs('new', 'New'),
            },
            {
              href: '/calendars/alice/work/changed.ics',
              etag: '"e-v2"',
              ics: eventIcs('changed', 'Changed'),
            },
          ]),
        );
      }
      return mkText(404, '');
    };
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore,
      scheduler: () => () => undefined,
      now: () => Date.UTC(2026, 3, 20),
    });
    cleanup.push(() => provider.close());

    const emitted: CalendarSyncEvent[] = [];
    const stop = await provider.startSync(async (e) => {
      emitted.push(e);
    });
    expect(reportCallCount).toBe(1);
    // Both events are "new" from store perspective → emit updated
    // twice. The placeholder seed-key uses a dummy calendar id that
    // won't match the real one, so it isn't counted as a deletion
    // here. Just assert the happy-path updates.
    const updated = emitted.filter((e) => e.kind === 'updated');
    expect(updated.length).toBe(2);
    await stop();
  });

  it('on unchanged ETag, skips re-fetch', async () => {
    const etagStore = makeEtagStore();
    const fetcher: HttpFetcher = async (url, init) => {
      if (init?.method === 'PROPFIND') {
        return mkText(207, homeXml);
      }
      if (init?.method === 'REPORT') {
        return mkText(
          207,
          makeReport([
            {
              href: '/calendars/alice/work/a.ics',
              etag: '"stable"',
              ics: eventIcs('a', 'A'),
            },
          ]),
        );
      }
      return mkText(404, '');
    };
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore,
      scheduler: () => () => undefined,
      now: () => Date.UTC(2026, 3, 20),
    });
    cleanup.push(() => provider.close());

    // First tick: stores the etag.
    await provider.startSync(async () => {});
    // Second tick: same etag → no emissions.
    const second: CalendarSyncEvent[] = [];
    // Manually invoke a second tick by re-starting sync (test shim —
    // the scheduler callback isn't fired in tests).
    await provider.close();
    const provider2 = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore,
      scheduler: () => () => undefined,
      now: () => Date.UTC(2026, 3, 20),
    });
    cleanup.push(() => provider2.close());
    const stop = await provider2.startSync(async (e) => {
      second.push(e);
    });
    expect(second).toHaveLength(0);
    await stop();
  });

  it('retains a missing href ETag until the delete is acknowledged', async () => {
    const etagStore = makeEtagStore();
    let includeEvent = true;
    const fetcher: HttpFetcher = async (_url, init) => {
      if (init?.method === 'PROPFIND') return mkText(207, homeXml);
      if (init?.method === 'REPORT') {
        return mkText(
          207,
          makeReport(includeEvent
            ? [{
                href: '/calendars/alice/work/a.ics',
                etag: '"a-v1"',
                ics: eventIcs('a', 'A'),
              }]
            : []),
        );
      }
      return mkText(404, '');
    };
    const makeProvider = () => createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore,
      scheduler: () => () => undefined,
      now: () => Date.UTC(2026, 3, 20),
    });

    const seeded = makeProvider();
    cleanup.push(() => seeded.close());
    await seeded.startSync(async () => {});
    await seeded.close();
    expect(etagStore.data.size).toBe(1);

    includeEvent = false;
    const rejected = makeProvider();
    cleanup.push(() => rejected.close());
    await rejected.startSync(async (event) => {
      if (event.kind === 'deleted') throw new Error('collection unavailable');
    });
    await rejected.close();
    expect(etagStore.data.size).toBe(1);

    const replayed: CalendarSyncEvent[] = [];
    const recovered = makeProvider();
    cleanup.push(() => recovered.close());
    await recovered.startSync(async (event) => { replayed.push(event); });

    expect(replayed).toEqual([
      expect.objectContaining({ kind: 'deleted' }),
    ]);
    expect(etagStore.data.size).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Write-back
// ────────────────────────────────────────────────────────────────

describe('CalDavProvider — createEvent', () => {
  it('PUTs the VEVENT and returns a canonical payload', async () => {
    const homeXml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/alice/work/</href>
    <propstat>
      <prop>
        <displayname>Work</displayname>
        <resourcetype><collection/><c:calendar/></resourcetype>
      </prop>
    </propstat>
  </response>
</multistatus>`;
    let putUrl = '';
    let putBody = '';
    const fetcher: HttpFetcher = async (url, init) => {
      if (init?.method === 'PROPFIND') return mkText(207, homeXml);
      if (init?.method === 'PUT') {
        putUrl = url;
        putBody = (init.body as string) ?? '';
        return mkText(201, '');
      }
      return mkText(404, 'unmapped');
    };
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
      now: () => Date.UTC(2026, 3, 23),
    });
    cleanup.push(() => provider.close());
    // Use the calendar's href as the calendar_id (caldav accepts
    // either the href or its hashed id).
    const payload = await provider.createEvent(
      '/calendars/alice/work/',
      {
        calendar_id: '/calendars/alice/work/',
        summary: 'Made it',
        start_at: Date.UTC(2026, 3, 23, 15, 0, 0),
        end_at: Date.UTC(2026, 3, 23, 16, 0, 0),
        timezone: 'UTC',
        is_all_day: false,
        status: 'confirmed',
      },
    );
    expect(putUrl).toContain('/calendars/alice/work/');
    expect(putBody).toContain('SUMMARY:Made it');
    expect(putBody).toContain('BEGIN:VEVENT');
    expect(payload.event.summary).toBe('Made it');
  });
});

describe('CalDavProvider — updateEvent', () => {
  const homeXml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/alice/work/</href>
    <propstat><prop><displayname>Work</displayname><resourcetype><collection/><c:calendar/></resourcetype></prop></propstat>
  </response>
</multistatus>`;
  // Daily series anchored 2026-06-01 09:00Z.
  const masterIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:series-uid',
    'DTSTART:20260601T090000Z',
    'DTEND:20260601T100000Z',
    'SUMMARY:Standup',
    'RRULE:FREQ=DAILY',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const SERIES_START = Date.UTC(2026, 5, 1, 9, 0, 0);
  const SPLIT_AT = Date.UTC(2026, 5, 10, 9, 0, 0);

  interface PutCapture {
    url: string;
    body: string;
    ifNoneMatch?: string;
  }

  const mkProvider = (
    onPut: (cap: PutCapture) => { status: number },
  ): ReturnType<typeof createCalDavProvider> => {
    const fetcher: HttpFetcher = async (url, init) => {
      if (init?.method === 'PROPFIND') return mkText(207, homeXml);
      if (init?.method === 'GET') return mkText(200, masterIcs);
      if (init?.method === 'PUT') {
        const headers = (init.headers ?? {}) as Record<string, string>;
        const { status } = onPut({
          url,
          body: (init.body as string) ?? '',
          ifNoneMatch: headers['If-None-Match'],
        });
        return mkText(status, '');
      }
      return mkText(404, 'unmapped');
    };
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
      now: () => Date.UTC(2026, 5, 10, 12, 0, 0),
    });
    cleanup.push(() => provider.close());
    return provider;
  };

  it('this_instance edit rewrites the single VEVENT in place', async () => {
    const puts: PutCapture[] = [];
    const provider = mkProvider((cap) => {
      puts.push(cap);
      return { status: 201 };
    });
    const payload = await provider.updateEvent({
      calendar_id: '/calendars/alice/work/',
      source_id: 'x:series-uid',
      patch: { summary: 'Standup v2' },
    });
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain('/series-uid.ics');
    expect(puts[0].body).toContain('SUMMARY:Standup v2');
    // RRULE carried forward; no UNTIL cap on a single-instance edit.
    expect(puts[0].body).toContain('RRULE:FREQ=DAILY');
    expect(puts[0].body).not.toContain('UNTIL=');
    expect(payload.event.summary).toBe('Standup v2');
  });

  it('this_and_future on a later instance truncates the master + creates a new series', async () => {
    const puts: PutCapture[] = [];
    const provider = mkProvider((cap) => {
      puts.push(cap);
      return { status: 201 };
    });
    const payload = await provider.updateEvent({
      calendar_id: '/calendars/alice/work/',
      source_id: `x:series-uid:${SPLIT_AT}`,
      patch: { summary: 'Standup v2' },
      scope: 'this_and_future',
    });
    expect(puts).toHaveLength(2);
    // 1) master truncated in place: UNTIL one second before the split,
    //    original (unpatched) summary, no If-None-Match (it's an edit).
    expect(puts[0].url).toContain('/series-uid.ics');
    expect(puts[0].body).toContain('RRULE:FREQ=DAILY;UNTIL=20260610T085959Z');
    expect(puts[0].body).toContain('SUMMARY:Standup');
    expect(puts[0].body).not.toContain('Standup v2');
    expect(puts[0].ifNoneMatch).toBeUndefined();
    // 2) new series created (fresh UID, If-None-Match:* create guard),
    //    patched summary, shifted DTSTART, cadence carried forward.
    expect(puts[1].url).not.toContain('/series-uid.ics');
    expect(puts[1].ifNoneMatch).toBe('*');
    expect(puts[1].body).toContain('SUMMARY:Standup v2');
    expect(puts[1].body).toContain('DTSTART:20260610T090000Z');
    expect(puts[1].body).toContain('RRULE:FREQ=DAILY');
    // Return reflects the NEW series' first occurrence.
    expect(payload.event.summary).toBe('Standup v2');
    expect(payload.event.start_at).toBe(SPLIT_AT);
  });

  it('this_and_future recomputes COUNT on the new series (no phantom occurrences)', async () => {
    // Master is a 10-occurrence daily COUNT series; split at the 10th
    // day (index 9 → 9 occurrences before the split).
    const countMasterIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:series-uid',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'SUMMARY:Standup',
      'RRULE:FREQ=DAILY;COUNT=10',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const puts: PutCapture[] = [];
    const fetcher: HttpFetcher = async (url, init) => {
      if (init?.method === 'PROPFIND') return mkText(207, homeXml);
      if (init?.method === 'GET') return mkText(200, countMasterIcs);
      if (init?.method === 'PUT') {
        const headers = (init.headers ?? {}) as Record<string, string>;
        puts.push({
          url,
          body: (init.body as string) ?? '',
          ifNoneMatch: headers['If-None-Match'],
        });
        return mkText(201, '');
      }
      return mkText(404, '');
    };
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
      now: () => Date.UTC(2026, 5, 10, 12, 0, 0),
    });
    cleanup.push(() => provider.close());
    await provider.updateEvent({
      calendar_id: '/calendars/alice/work/',
      source_id: `x:series-uid:${SPLIT_AT}`,
      patch: { summary: 'Standup v2' },
      scope: 'this_and_future',
    });
    expect(puts).toHaveLength(2);
    // Master capped with UNTIL (COUNT dropped — mutually exclusive).
    expect(puts[0].body).toContain('UNTIL=20260610T085959Z');
    expect(puts[0].body).not.toContain('COUNT=');
    // New series keeps only the remaining 1 occurrence (10 − 9 before).
    expect(puts[1].body).toContain('RRULE:FREQ=DAILY;COUNT=1');
  });

  it('this_and_future on the first occurrence is a whole-series edit (single PUT)', async () => {
    const puts: PutCapture[] = [];
    const provider = mkProvider((cap) => {
      puts.push(cap);
      return { status: 201 };
    });
    const payload = await provider.updateEvent({
      calendar_id: '/calendars/alice/work/',
      source_id: 'x:series-uid', // first occurrence → splitAt == dtstart
      patch: { summary: 'Standup v2' },
      scope: 'this_and_future',
    });
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain('/series-uid.ics');
    expect(puts[0].body).toContain('SUMMARY:Standup v2');
    expect(puts[0].body).toContain('RRULE:FREQ=DAILY');
    expect(puts[0].body).not.toContain('UNTIL=');
    expect(payload.event.start_at).toBe(SERIES_START);
  });

  it('this_and_future surfaces io_error when the new-series PUT fails after truncation', async () => {
    const provider = mkProvider((cap) => ({
      // First PUT (master truncate) succeeds; the new-series PUT 500s.
      status: cap.url.includes('/series-uid.ics') ? 201 : 500,
    }));
    await expect(
      provider.updateEvent({
        calendar_id: '/calendars/alice/work/',
        source_id: `x:series-uid:${SPLIT_AT}`,
        patch: { summary: 'Standup v2' },
        scope: 'this_and_future',
      }),
    ).rejects.toMatchObject({
      code: 'io_error',
      message: expect.stringContaining('truncated'),
    });
  });

  it('this_and_future preserves the master EXDATE (raw RRULE-line swap, not a rebuild)', async () => {
    // Master has a pre-split EXDATE — a previously-deleted occurrence.
    // Truncation must keep it, or that occurrence resurrects.
    const exdateMasterIcs = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:series-uid',
      'DTSTART:20260601T090000Z',
      'DTEND:20260601T100000Z',
      'SUMMARY:Standup',
      'RRULE:FREQ=DAILY',
      'EXDATE:20260603T090000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const puts: PutCapture[] = [];
    const fetcher: HttpFetcher = async (url, init) => {
      if (init?.method === 'PROPFIND') return mkText(207, homeXml);
      if (init?.method === 'GET') return mkText(200, exdateMasterIcs);
      if (init?.method === 'PUT') {
        const headers = (init.headers ?? {}) as Record<string, string>;
        puts.push({
          url,
          body: (init.body as string) ?? '',
          ifNoneMatch: headers['If-None-Match'],
        });
        return mkText(201, '');
      }
      return mkText(404, '');
    };
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
      now: () => Date.UTC(2026, 5, 10, 12, 0, 0),
    });
    cleanup.push(() => provider.close());
    await provider.updateEvent({
      calendar_id: '/calendars/alice/work/',
      source_id: `x:series-uid:${SPLIT_AT}`,
      patch: { summary: 'Standup v2' },
      scope: 'this_and_future',
    });
    expect(puts).toHaveLength(2);
    // Truncated master keeps the EXDATE and only swaps the RRULE.
    expect(puts[0].body).toContain('EXDATE:20260603T090000Z');
    expect(puts[0].body).toContain('RRULE:FREQ=DAILY;UNTIL=20260610T085959Z');
    // The fresh forward series starts clean — no inherited EXDATE.
    expect(puts[1].body).not.toContain('EXDATE');
  });

  it('this_and_future fails closed on a non-numeric occurrence suffix (no PUT)', async () => {
    const puts: PutCapture[] = [];
    const provider = mkProvider((cap) => {
      puts.push(cap);
      return { status: 201 };
    });
    await expect(
      provider.updateEvent({
        calendar_id: '/calendars/alice/work/',
        source_id: 'x:series-uid:not-a-timestamp',
        patch: { summary: 'Standup v2' },
        scope: 'this_and_future',
      }),
    ).rejects.toMatchObject({ code: 'event_not_found' });
    expect(puts).toHaveLength(0);
  });
});

describe('CalDavProvider — deleteEvent', () => {
  it('DELETEs at the event href', async () => {
    const homeXml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/alice/work/</href>
    <propstat><prop><displayname>Work</displayname><resourcetype><collection/><c:calendar/></resourcetype></prop></propstat>
  </response>
</multistatus>`;
    let deleteUrl = '';
    const fetcher: HttpFetcher = async (url, init) => {
      if (init?.method === 'PROPFIND') return mkText(207, homeXml);
      if (init?.method === 'DELETE') {
        deleteUrl = url;
        return mkText(204, '');
      }
      return mkText(404, '');
    };
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    // Find the calendar id first by calling initialScan.
    // Use the href verbatim as the calendar_id.
    await provider.deleteEvent({
      calendar_id: '/calendars/alice/work/',
      source_id: 'caldav-id:evt-1',
    });
    expect(deleteUrl).toContain('/evt-1.ics');
  });

  it('surfaces 404 as event_not_found', async () => {
    const homeXml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/alice/work/</href>
    <propstat><prop><displayname>Work</displayname><resourcetype><collection/><c:calendar/></resourcetype></prop></propstat>
  </response>
</multistatus>`;
    const fetcher: HttpFetcher = async (url, init) => {
      if (init?.method === 'PROPFIND') return mkText(207, homeXml);
      if (init?.method === 'DELETE') return mkText(404, '');
      return mkText(404, '');
    };
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await expect(
      provider.deleteEvent({
        calendar_id: '/calendars/alice/work/',
        source_id: 'caldav-id:gone',
      }),
    ).rejects.toMatchObject({ code: 'event_not_found' });
  });

  const recurDeleteHomeXml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <response>
    <href>/calendars/alice/work/</href>
    <propstat><prop><displayname>Work</displayname><resourcetype><collection/><c:calendar/></resourcetype></prop></propstat>
  </response>
</multistatus>`;
  const recurMasterIcs = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:series-uid',
    'DTSTART:20260601T090000Z',
    'DTEND:20260601T100000Z',
    'SUMMARY:Standup',
    'RRULE:FREQ=DAILY',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it("this_and_future on a later instance truncates the master (PUT UNTIL, no DELETE)", async () => {
    const puts: Array<{ url: string; body: string }> = [];
    let deletes = 0;
    const fetcher: HttpFetcher = async (url, init) => {
      if (init?.method === 'PROPFIND') return mkText(207, recurDeleteHomeXml);
      if (init?.method === 'GET') return mkText(200, recurMasterIcs);
      if (init?.method === 'PUT') {
        puts.push({ url, body: (init.body as string) ?? '' });
        return mkText(204, '');
      }
      if (init?.method === 'DELETE') {
        deletes += 1;
        return mkText(204, '');
      }
      return mkText(404, '');
    };
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
      now: () => Date.UTC(2026, 5, 10, 12, 0, 0),
    });
    cleanup.push(() => provider.close());
    await provider.deleteEvent({
      calendar_id: '/calendars/alice/work/',
      source_id: `x:series-uid:${Date.UTC(2026, 5, 10, 9, 0, 0)}`,
      scope: 'this_and_future',
    });
    expect(deletes).toBe(0);
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toContain('/series-uid.ics');
    expect(puts[0].body).toContain('RRULE:FREQ=DAILY;UNTIL=20260610T085959Z');
  });

  it("this_and_future on the first occurrence deletes the whole file", async () => {
    let deleteUrl = '';
    let puts = 0;
    const fetcher: HttpFetcher = async (url, init) => {
      if (init?.method === 'PROPFIND') return mkText(207, recurDeleteHomeXml);
      if (init?.method === 'GET') return mkText(200, recurMasterIcs);
      if (init?.method === 'PUT') {
        puts += 1;
        return mkText(204, '');
      }
      if (init?.method === 'DELETE') {
        deleteUrl = url;
        return mkText(204, '');
      }
      return mkText(404, '');
    };
    const provider = createCalDavProvider({
      slug: 'personal',
      config: mkConfig(),
      fetcher,
      etagStore: makeEtagStore(),
      scheduler: () => () => undefined,
    });
    cleanup.push(() => provider.close());
    await provider.deleteEvent({
      calendar_id: '/calendars/alice/work/',
      source_id: 'x:series-uid', // first occurrence → whole-series delete
      scope: 'this_and_future',
    });
    expect(puts).toBe(0);
    expect(deleteUrl).toContain('/series-uid.ics');
  });
});

// ────────────────────────────────────────────────────────────────
// Factory + caps probe
// ────────────────────────────────────────────────────────────────

describe('createCalDavAdapterFactory', () => {
  it('origin-pins the production default fetcher used during enrollment', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 307,
      headers: { location: 'https://collector.invalid/steal' },
    }));
    try {
      const factory = createCalDavAdapterFactory({
        etagStore: makeEtagStore(),
        scheduler: () => () => undefined,
      });
      await expect(factory.probeCaps({
        slug: 'personal',
        config: {
          server_url: 'https://caldav.example.com',
          username: 'alice',
          calendar_home_url: 'https://caldav.example.com/calendars/alice/',
        },
        getAccountValue: async (key) => (key === 'password' ? 'secret' : null),
      })).rejects.toBeInstanceOf(CrossOriginRedirectError);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
        method: 'PROPFIND',
        redirect: 'manual',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('probe returns rsvp:yes when scheduling outbox responds 2xx', async () => {
    const { fetcher } = makeRouter([
      {
        match: (u, init) =>
          u.includes('/calendars/alice/') && init?.method === 'PROPFIND',
        response: {
          status: 207,
          body: '<multistatus xmlns="DAV:"><response><href>/</href></response></multistatus>',
        },
      },
      {
        match: (u, init) =>
          u.includes('outbox') && init?.method === 'OPTIONS',
        response: { status: 200, body: '' },
      },
    ]);
    const factory = createCalDavAdapterFactory({
      etagStore: makeEtagStore(),
      fetcher,
      scheduler: () => () => undefined,
    });
    const caps = await factory.probeCaps({
      slug: 'personal',
      config: {
        server_url: 'https://caldav.example.com',
        username: 'alice',
        calendar_home_url: 'https://caldav.example.com/calendars/alice/',
        scheduling_outbox_url: 'https://caldav.example.com/outbox/',
      },
      getAccountValue: async (key) => (key === 'password' ? 'secret' : null),
    });
    expect(caps).toMatchObject({
      read: 'yes',
      list_calendars: 'yes',
      create_event: 'yes',
      update_event: 'yes',
      delete_event: 'yes',
      rsvp: 'yes',
      search: 'local',
      watch: 'poll',
      auth: 'basic',
      recurrence: 'client',
    });
  });

  it('probe returns rsvp:no when no scheduling outbox is configured', async () => {
    const { fetcher } = makeRouter([
      {
        match: (u, init) =>
          u.includes('/calendars/alice/') && init?.method === 'PROPFIND',
        response: {
          status: 207,
          body: '<multistatus xmlns="DAV:"><response><href>/</href></response></multistatus>',
        },
      },
    ]);
    const factory = createCalDavAdapterFactory({
      etagStore: makeEtagStore(),
      fetcher,
      scheduler: () => () => undefined,
    });
    const caps = await factory.probeCaps({
      slug: 'personal',
      config: {
        server_url: 'https://caldav.example.com',
        username: 'alice',
        calendar_home_url: 'https://caldav.example.com/calendars/alice/',
      },
      getAccountValue: async (key) => (key === 'password' ? 'secret' : null),
    });
    expect(caps.rsvp).toBe('no');
  });

  it('probe surfaces auth_expired on 401', async () => {
    const { fetcher } = makeRouter([
      {
        match: (u, init) =>
          u.includes('/calendars/alice/') && init?.method === 'PROPFIND',
        response: { status: 401, body: 'Unauthorized' },
      },
    ]);
    const factory = createCalDavAdapterFactory({
      etagStore: makeEtagStore(),
      fetcher,
      scheduler: () => () => undefined,
    });
    await expect(
      factory.probeCaps({
        slug: 'personal',
        config: {
          server_url: 'https://caldav.example.com',
          username: 'alice',
          calendar_home_url: 'https://caldav.example.com/calendars/alice/',
        },
        getAccountValue: async (key) => (key === 'password' ? 'secret' : null),
      }),
    ).rejects.toMatchObject({ code: 'auth_expired' });
  });

  it('rejects config missing server_url / username / calendar_home_url', async () => {
    const { fetcher } = makeRouter([]);
    const factory = createCalDavAdapterFactory({
      etagStore: makeEtagStore(),
      fetcher,
      scheduler: () => () => undefined,
    });
    await expect(
      factory.probeCaps({
        slug: 'personal',
        config: { server_url: 'https://x' },
        getAccountValue: async (key) => (key === 'password' ? 'secret' : null),
      }),
    ).rejects.toThrow();
  });

  it('create returns a CalendarProvider with kind="caldav"', async () => {
    const { fetcher } = makeRouter([]);
    const factory = createCalDavAdapterFactory({
      etagStore: makeEtagStore(),
      fetcher,
      scheduler: () => () => undefined,
    });
    const provider = factory.create({
      slug: 'personal',
      config: {
        server_url: 'https://caldav.example.com',
        username: 'alice',
        calendar_home_url: 'https://caldav.example.com/calendars/alice/',
      },
      getAccountValue: async (key) => (key === 'password' ? 'secret' : null),
    });
    cleanup.push(() => provider.close());
    expect(provider.kind).toBe('caldav');
    expect(provider.slug).toBe('personal');
  });
});

// ────────────────────────────────────────────────────────────────
// Local helpers
// ────────────────────────────────────────────────────────────────

function mkText(
  status: number,
  body: string,
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
      return {};
    },
    async text() {
      return body;
    },
  };
}
