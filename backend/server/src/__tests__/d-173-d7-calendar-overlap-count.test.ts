/** D-173 D7 — the owner-facing overlap count ("confirmed at approval").
 *
 *  Since the overlap refusal was retired (2026-07-16), the substrate no longer
 *  decides how many bookings may share an instant — capacity is a judgment only
 *  the owner can make. The machine counts; the owner decides. **That makes this
 *  count the only thing between the owner and an unnoticed double-book**, so it
 *  is tested as a safety mechanism, not a display helper.
 *
 *  The failure mode being guarded is a count that LOOKS authoritative and isn't:
 *  the owner reads "2", approves a third booking on the strength of it, and the
 *  real answer was 4. Per [[substrate_enforces_humans]] — *a check that looks
 *  like assurance but isn't is worse than none.* Each test below is one way the
 *  count could quietly lie. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CanonicalEvent } from '@recued/contracts';
import {
  createCalendarTable,
  type CalendarCollectionTable,
} from '../collections/calendar/calendar-table.js';
import { countCalendarOverlap } from '../collections/calendar/overlap-counter.js';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

/** The booking under review: 12:00–14:00. */
const WINDOW_START = NOW + 12 * HOUR;
const WINDOW_END = NOW + 14 * HOUR;

/** A real `CanonicalEvent` — no `as` cast, so a missing required field is a
 *  compile error here rather than a NOT NULL surprise at run time. */
const event = (over: Partial<CanonicalEvent> & { source_id: string }): CanonicalEvent => ({
  ical_uid: `uid-${over.source_id}`,
  calendar_id: 'primary',
  summary: 'an event',
  start_at: WINDOW_START,
  end_at: WINDOW_END,
  timezone: 'UTC',
  is_all_day: false,
  status: 'confirmed',
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

let db: Database.Database;
let table: CalendarCollectionTable;

beforeEach(() => {
  db = new Database(':memory:');
  table = createCalendarTable({ db, slug: 'work' });
});
afterEach(() => {
  db.close();
});

const put = (e: CanonicalEvent) => table.upsert({ event: e, size_bytes: 0, now: NOW });

describe('D-173 D7 — the overlap predicate', () => {
  it('counts an event that STRADDLES the window (the one a start_at filter misses)', () => {
    // 11:00–15:00 fully contains the 12:00–14:00 booking. Its `start_at` is
    // OUTSIDE the window, so `list({ start_since, start_until })` — the shape
    // already on this table — would not return it. Long events are exactly the
    // collisions most worth knowing about, so this is the load-bearing case.
    put(event({ source_id: 'straddler', start_at: NOW + 11 * HOUR, end_at: NOW + 15 * HOUR }));
    expect(table.overlapCount(WINDOW_START, WINDOW_END)).toBe(1);
  });

  it('counts partial overlap at both edges', () => {
    put(event({ source_id: 'early', start_at: NOW + 11 * HOUR, end_at: NOW + 13 * HOUR }));
    put(event({ source_id: 'late', start_at: NOW + 13 * HOUR, end_at: NOW + 15 * HOUR }));
    expect(table.overlapCount(WINDOW_START, WINDOW_END)).toBe(2);
  });

  it('counts an event strictly inside the window', () => {
    put(event({ source_id: 'inner', start_at: NOW + 12.5 * HOUR, end_at: NOW + 13 * HOUR }));
    expect(table.overlapCount(WINDOW_START, WINDOW_END)).toBe(1);
  });

  it('does NOT count abutting events — the interval is half-open', () => {
    // Ends exactly at 12:00 / starts exactly at 14:00. Back-to-back
    // appointments are not a collision; counting them would cry wolf on every
    // consecutive booking and teach the owner to ignore the number.
    put(event({ source_id: 'before', start_at: NOW + 10 * HOUR, end_at: WINDOW_START }));
    put(event({ source_id: 'after', start_at: WINDOW_END, end_at: NOW + 16 * HOUR }));
    expect(table.overlapCount(WINDOW_START, WINDOW_END)).toBe(0);
  });

  it('does NOT count a cancelled event — it occupies nothing', () => {
    put(event({ source_id: 'gone', status: 'cancelled' }));
    expect(table.overlapCount(WINDOW_START, WINDOW_END)).toBe(0);
  });

  it('DOES count a tentative event — unresolved is not absent', () => {
    put(event({ source_id: 'maybe', status: 'tentative' }));
    expect(table.overlapCount(WINDOW_START, WINDOW_END)).toBe(1);
  });

  it('an empty or inverted window counts nothing rather than throwing', () => {
    put(event({ source_id: 'any' }));
    expect(table.overlapCount(WINDOW_START, WINDOW_START)).toBe(0);
    expect(table.overlapCount(WINDOW_END, WINDOW_START)).toBe(0);
  });
});

describe('D-173 D7 — the count spans every calendar, and says when it cannot', () => {
  const instances = (...slugs: string[]) => ({
    list: () => slugs.map((slug) => ({ slug, platform: 'calendar' })) as never,
  });

  it('sums across calendars — a clash in Google Calendar is still a clash', () => {
    // The owner's dentist appointment lives in gcal, not the local calendar.
    // A count that only read `local` would report 0 and the owner would book
    // over their own dentist.
    const work = createCalendarTable({ db, slug: 'work' });
    const personal = createCalendarTable({ db, slug: 'personal' });
    work.upsert({ event: event({ source_id: 'standup' }), size_bytes: 0, now: NOW });
    personal.upsert({ event: event({ source_id: 'dentist' }), size_bytes: 0, now: NOW });

    const counted = countCalendarOverlap(
      {
        instances: instances('work', 'personal'),
        getTable: (slug) => (slug === 'work' ? work : personal),
      },
      WINDOW_START,
      WINDOW_END,
    );
    expect(counted).toEqual({ count: 2, calendars_read: 2, unreadable: [] });
  });

  it('reports an unreadable calendar instead of silently undercounting', () => {
    // The failure that matters. If a calendar throws and we swallow it, the
    // owner reads a confident "1" when the truth is "1 that I could see".
    // `unreadable` is what lets the surface say so.
    const work = createCalendarTable({ db, slug: 'work' });
    work.upsert({ event: event({ source_id: 'standup' }), size_bytes: 0, now: NOW });

    const counted = countCalendarOverlap(
      {
        instances: instances('work', 'broken'),
        getTable: (slug) => {
          if (slug === 'work') return work;
          throw new Error('calendar table unavailable');
        },
      },
      WINDOW_START,
      WINDOW_END,
    );
    expect(counted).toEqual({ count: 1, calendars_read: 1, unreadable: ['broken'] });
  });

  it('an enrolled-but-unsynced calendar (no table) is unreadable, not zero', () => {
    const counted = countCalendarOverlap(
      { instances: instances('never-synced'), getTable: () => null },
      WINDOW_START,
      WINDOW_END,
    );
    expect(counted).toEqual({ count: 0, calendars_read: 0, unreadable: ['never-synced'] });
  });

  it('one broken calendar does not zero the whole count', () => {
    const work = createCalendarTable({ db, slug: 'work' });
    work.upsert({ event: event({ source_id: 'a' }), size_bytes: 0, now: NOW });
    work.upsert({ event: event({ source_id: 'b' }), size_bytes: 0, now: NOW });

    const counted = countCalendarOverlap(
      {
        instances: instances('broken', 'work'),
        getTable: (slug) => {
          if (slug === 'work') return work;
          throw new Error('nope');
        },
      },
      WINDOW_START,
      WINDOW_END,
    );
    expect(counted.count).toBe(2);
    expect(counted.unreadable).toEqual(['broken']);
  });

  it('no calendars at all reads as an honest empty, not a failure', () => {
    expect(
      countCalendarOverlap({ instances: instances(), getTable: () => null }, WINDOW_START, WINDOW_END),
    ).toEqual({ count: 0, calendars_read: 0, unreadable: [] });
  });
});
