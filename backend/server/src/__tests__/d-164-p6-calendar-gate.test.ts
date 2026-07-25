/** D-164 P6 — backend calendar next-meeting lookup wiring.
 *
 *  Exercises `createPromptCacheGateDeps`' calendar half end-to-end through
 *  the real public surface (contact lookup → family composer → probe →
 *  calendar lookup → timezone-aware formatter), with fake ContactStore +
 *  CollectionRegistry. Pins the lookup's "soonest FUTURE attendee event"
 *  selection, cancelled-skip, case-insensitive attendee match, and the two
 *  formatter behaviours a Codex review hardened: all-day dates formatted in
 *  UTC (no zone-shift) and timed events converted into the event timezone. */

import { describe, expect, it } from 'vitest';

import { CALENDAR_NEXT_MEETING_TEMPLATE } from '@recued/middleware-prompt-cache';
import type { CanonicalEvent } from '@recued/contracts';

import { createPromptCacheGateDeps } from '../chat-prompt-cache-gate.js';
import type { CalendarCollection } from '../collections/calendar/calendar-collection.js';
import type { Collection } from '../collections/types.js';
import type { CollectionRegistry } from '../collections/registry.js';
import type { ContactStore } from '../storage/contact-store.js';

const DAY_MS = 86_400_000;

const NAME_SLOT = {
  kind: 'entity.name',
  value: 'Pat Lee',
  raw: 'Pat Lee',
  position: 25,
} as const;

const contactStore = (rows: ReadonlyArray<{ email: string; name?: string }>): ContactStore =>
  ({ list: () => rows, addressSet: (email: string) => [email] }) as unknown as ContactStore;

/** Pat Lee resolves to pat@x.com — the email the lookup matches attendees on. */
const PAT_STORE = contactStore([{ email: 'pat@x.com', name: 'Pat Lee' }]);

const event = (over: Partial<CanonicalEvent>): CanonicalEvent =>
  ({
    source_id: 's',
    ical_uid: 'u',
    calendar_id: 'primary',
    calendar_name: 'Primary',
    summary: 'Quarterly business review',
    description: '',
    location: 'Zoom',
    start_at: 0,
    end_at: 0,
    timezone: 'America/New_York',
    is_all_day: false,
    organizer: { email: 'me@x.com', display_name: 'Me' },
    attendees: [
      { email: 'pat@x.com', display_name: 'Pat Lee', response_status: 'accepted' },
    ],
    status: 'confirmed',
    created_at: 0,
    updated_at: 0,
    ...over,
  }) as CanonicalEvent;

/** `count` non-Pat filler events starting at `startBase`, 1s apart — used
 *  to build a FULL scan page (== the lookup's 500 cap) with no attendee
 *  match, exercising the fail-closed-on-inconclusive-scan path. */
const filler = (count: number, startBase: number): CanonicalEvent[] =>
  Array.from({ length: count }, (_, i) =>
    event({
      source_id: `filler-${i}`,
      summary: 'Filler',
      start_at: startBase + i * 1_000,
      attendees: [{ email: 'other@x.com', display_name: 'Other', response_status: 'accepted' }],
    }),
  );

/** A fake calendar collection whose `table.listSnapshots` honours the
 *  table's real contract: filter to `start_at >= start_since`, order by
 *  `start_at` ascending, slice to `limit`. This is what makes the lookup's
 *  "first attendee match = soonest future" logic meaningful. */
const fakeCalendar = (events: ReadonlyArray<CanonicalEvent>): Collection =>
  ({
    platform: 'calendar',
    slug: 'cal',
    table: {
      listSnapshots: (q: { start_since?: number; limit?: number }) =>
        events
          .filter((e) => e.start_at >= (q.start_since ?? 0))
          .slice()
          .sort((a, b) => a.start_at - b.start_at)
          .slice(0, q.limit ?? 1000)
          .map((e) => ({ event: e })),
    },
  }) as unknown as CalendarCollection as Collection;

const registry = (...collections: Collection[]): CollectionRegistry =>
  ({ list: () => collections }) as unknown as CollectionRegistry;

const probeCalendar = async (
  getRegistry: () => CollectionRegistry | undefined,
  store: ContactStore | undefined = PAT_STORE,
  locale?: string,
) => {
  const deps = createPromptCacheGateDeps(() => store, getRegistry);
  return await deps.probeData({
    template: CALENDAR_NEXT_MEETING_TEMPLATE,
    slots: [NAME_SLOT],
    ...(locale === undefined ? {} : { locale }),
  });
};

describe('D-164 P6 backend calendar next-meeting lookup', () => {
  it('returns the SOONEST future meeting with the contact', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({ source_id: 'far', summary: 'Roadmap planning sync', start_at: now + 60 * DAY_MS }),
          event({ source_id: 'near', summary: 'Quarterly business review', start_at: now + 30 * DAY_MS }),
        ]),
      ),
    );
    expect(out?.data).toMatchObject({ name: 'Pat Lee', summary: 'Quarterly business review' });
  });

  it('excludes PAST events (start_since: now)', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({ source_id: 'past', summary: 'Old standup', start_at: now - 10 * DAY_MS }),
          event({ source_id: 'future', summary: 'Upcoming review', start_at: now + 5 * DAY_MS }),
        ]),
      ),
    );
    expect(out?.data.summary).toBe('Upcoming review');
  });

  it('skips a cancelled earlier event in favour of the next confirmed one', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({ source_id: 'cx', summary: 'Cancelled sync', start_at: now + 2 * DAY_MS, status: 'cancelled' }),
          event({ source_id: 'ok', summary: 'Confirmed review', start_at: now + 9 * DAY_MS }),
        ]),
      ),
    );
    expect(out?.data.summary).toBe('Confirmed review');
  });

  it('matches the attendee email case-insensitively', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({
            summary: 'Caps review',
            start_at: now + 3 * DAY_MS,
            attendees: [{ email: 'PAT@X.COM', display_name: 'Pat Lee', response_status: 'accepted' }],
          }),
        ]),
      ),
    );
    expect(out?.data.summary).toBe('Caps review');
  });

  it('picks the global soonest across multiple calendar collections', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([event({ source_id: 'a', summary: 'Work cal', start_at: now + 40 * DAY_MS })]),
        fakeCalendar([event({ source_id: 'b', summary: 'Personal cal', start_at: now + 12 * DAY_MS })]),
      ),
    );
    expect(out?.data.summary).toBe('Personal cal');
  });

  it('ignores an event the contact DECLINED in favour of a later accepted one', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({
            source_id: 'declined',
            summary: 'Declined sync',
            start_at: now + 2 * DAY_MS,
            attendees: [{ email: 'pat@x.com', display_name: 'Pat Lee', response_status: 'declined' }],
          }),
          event({
            source_id: 'accepted',
            summary: 'Accepted review',
            start_at: now + 8 * DAY_MS,
            attendees: [{ email: 'pat@x.com', display_name: 'Pat Lee', response_status: 'accepted' }],
          }),
        ]),
      ),
    );
    expect(out?.data.summary).toBe('Accepted review');
  });

  it('skips a meeting the OWNER (self attendee) declined in favour of a later one', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({
            source_id: 'self-declined',
            summary: 'Owner declined',
            start_at: now + 2 * DAY_MS,
            attendees: [
              { email: 'pat@x.com', display_name: 'Pat Lee', response_status: 'accepted' },
              { email: 'me@x.com', display_name: 'Me', response_status: 'declined', is_self: true },
            ],
          }),
          event({
            source_id: 'self-accepted',
            summary: 'Owner attending',
            start_at: now + 9 * DAY_MS,
            attendees: [
              { email: 'pat@x.com', display_name: 'Pat Lee', response_status: 'accepted' },
              { email: 'me@x.com', display_name: 'Me', response_status: 'accepted', is_self: true },
            ],
          }),
        ]),
      ),
    );
    expect(out?.data.summary).toBe('Owner attending');
  });

  it('fails closed when a FULL unmatched scan page could hide an earlier meeting', async () => {
    const now = Date.now();
    // Calendar A: a full page (== scan cap) of non-Pat fillers; its horizon
    // sits BEFORE calendar B's Pat match, so an earlier hidden Pat meeting in
    // A can't be ruled out → the lookup must fail closed.
    const calA = fakeCalendar(filler(500, now + 1_000));
    const calB = fakeCalendar([event({ summary: 'Later match', start_at: now + 1_000_000 })]);
    expect(await probeCalendar(() => registry(calA, calB))).toBeNull();
  });

  it('does NOT fail closed when the full unmatched page is entirely AFTER the chosen meeting', async () => {
    const now = Date.now();
    // Calendar A's full filler page starts well after B's match, so nothing
    // hidden in A can be earlier than B → the answer is conclusive.
    const calA = fakeCalendar(filler(500, now + 1_000_000));
    const calB = fakeCalendar([event({ summary: 'Early match', start_at: now + 5_000 })]);
    const out = await probeCalendar(() => registry(calA, calB));
    expect(out?.data.summary).toBe('Early match');
  });

  it('passes through (null) when no future event lists the contact as attendee', async () => {
    const now = Date.now();
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({
            summary: 'Someone else',
            start_at: now + 4 * DAY_MS,
            attendees: [{ email: 'bob@x.com', display_name: 'Bob', response_status: 'accepted' }],
          }),
        ]),
      ),
    );
    expect(out).toBeNull();
  });

  it('passes through (null) when the registry is unavailable', async () => {
    expect(await probeCalendar(() => undefined)).toBeNull();
  });

  it('passes through (null) when the contact cannot be resolved', async () => {
    const now = Date.now();
    const out = await probeCalendar(
      () => registry(fakeCalendar([event({ start_at: now + 5 * DAY_MS })])),
      contactStore([]), // no contact named Pat Lee
    );
    expect(out).toBeNull();
  });

  // ── Formatter (the Codex-hardened timezone behaviour) ─────────────
  // Far-future fixed dates so the events stay in the future regardless of
  // when the suite runs, and the formatted tokens are deterministic.

  it('formats an all-day event in UTC — no zone-shift back a day', async () => {
    // Jan 1 2099 00:00 UTC. Formatting in a west-of-UTC zone would render
    // Dec 31 2098; the UTC formatter keeps the calendar date.
    const allDayUtcMidnight = Date.UTC(2099, 0, 1, 0, 0, 0);
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({
            summary: 'All-day offsite',
            start_at: allDayUtcMidnight,
            is_all_day: true,
            timezone: 'America/Los_Angeles',
          }),
        ]),
      ),
    );
    expect(out?.data.when).toContain('January 1, 2099');
    expect(out?.data.when).not.toContain('December 31');
  });

  it('formats a timed event in the event timezone (instant converted, not shown as UTC)', async () => {
    // Jul 8 2099 13:00 UTC → 9:00 AM in America/New_York (EDT, UTC-4).
    const timedUtc = Date.UTC(2099, 6, 8, 13, 0, 0);
    const out = await probeCalendar(() =>
      registry(
        fakeCalendar([
          event({
            summary: 'Timed review',
            start_at: timedUtc,
            is_all_day: false,
            timezone: 'America/New_York',
          }),
        ]),
      ),
    );
    // 9:00 (NY) proves the instant was zone-converted (UTC would read 1:00 PM).
    expect(out?.data.when).toContain('9:00');
    expect(out?.data.when).toContain('July 8, 2099');
  });

  it('formats the factual date in the response locale', async () => {
    const timedUtc = Date.UTC(2099, 6, 8, 13, 0, 0);
    const out = await probeCalendar(
      () => registry(fakeCalendar([event({ start_at: timedUtc })])),
      PAT_STORE,
      'es',
    );
    expect(out?.data.when).toContain('julio');
    expect(out?.data.when).not.toContain('July');
  });
});
