/** D-117 Phase 8 — calendar-watcher handler + cursor-store tests.
 *
 *  Isolated against the per-instance warehouse table (no provider /
 *  adapter / dispatcher in scope). Exercises:
 *
 *    - starting_soon happy path + window bounds
 *    - starting_soon default "confirmed + tentative" status filter
 *    - starting_soon respects calendar_id + explicit status filter
 *    - changed_since with explicit `since`
 *    - changed_since reading the stored cursor
 *    - changed_since first tick primes the cursor to `now`
 *    - changed_since advances cursor to max modified_at on non-empty emit
 *    - changed_since advances cursor to `now` on empty emit
 *    - cursor-store round trips a value per recipe
 *    - unknown kind rejected with a typed RpcError
 *    - missing collection emits a no-fire envelope (not a throw)
 *    - items carry ISO 8601 + IANA tz + parsed `prior`
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RpcError, type CanonicalEvent } from '@recued/contracts';

import {
  createCalendarTable,
  type CalendarCollectionTable,
} from '../calendar-table.js';
import type { CalendarCollection } from '../calendar-collection.js';
import {
  createCalendarWatcherCursorStore,
  type CalendarWatcherCursorStore,
} from '../watcher-cursor-store.js';
import {
  formatIsoWithOffset,
  handleCalendarWatcher,
  type CalendarWatcherDeps,
  type CalendarWatcherOutput,
} from '../calendar-watcher.js';

let db: Database.Database;
let table: CalendarCollectionTable;
let cursors: CalendarWatcherCursorStore;
let now: number;

const SLUG = 'work';

const baseEvent = (overrides: Partial<CanonicalEvent> = {}): CanonicalEvent => ({
  source_id: 'evt-1',
  ical_uid: 'uid-1@example',
  calendar_id: 'primary',
  summary: 'Standup',
  description: 'Weekly sync',
  location: 'Room 4',
  start_at: 1_700_000_000_000,
  end_at: 1_700_001_800_000,
  timezone: 'America/New_York',
  is_all_day: false,
  status: 'confirmed',
  attendees: [
    { email: 'me@example.com', is_self: true, response_status: 'accepted' },
    { email: 'other@example.com', response_status: 'needs_action' },
  ],
  created_at: 1_699_000_000_000,
  updated_at: 1_700_000_000_000,
  ...overrides,
});

const seed = (event: CanonicalEvent): void => {
  table.upsert({
    event,
    size_bytes: Buffer.byteLength(event.description ?? '', 'utf8'),
    body_inline: event.description,
  });
};

const reseed = (event: CanonicalEvent, updated_at: number): void => {
  // Bump `updated_at` so the prior_payload rotates — the watcher's
  // `changed_since` path keys off `modified_at` which mirrors
  // `updated_at`, and `item.prior` is the previous record_payload.
  table.upsert({
    event: { ...event, updated_at },
    size_bytes: Buffer.byteLength(event.description ?? '', 'utf8'),
    body_inline: event.description,
  });
};

const mkCollection = (): CalendarCollection =>
  ({
    platform: 'calendar',
    slug: SLUG,
    table,
  } as unknown as CalendarCollection);

const deps = (withCollection: boolean): CalendarWatcherDeps => ({
  getCollection: (slug) =>
    withCollection && slug === SLUG ? mkCollection() : undefined,
  cursors,
  now: () => now,
});

beforeEach(() => {
  db = new Database(':memory:');
  table = createCalendarTable({ db, slug: SLUG });
  cursors = createCalendarWatcherCursorStore(db);
  now = 1_700_000_000_000;
});

afterEach(() => db.close());

describe('createCalendarWatcherCursorStore', () => {
  it('round-trips a cursor value per recipe', () => {
    expect(cursors.get('r1')).toBeNull();
    cursors.set('r1', 1234);
    cursors.set('r2', 5678);
    expect(cursors.get('r1')).toBe(1234);
    expect(cursors.get('r2')).toBe(5678);
  });

  it('overwrites on repeat set + supports clear', () => {
    cursors.set('r1', 100);
    cursors.set('r1', 200);
    expect(cursors.get('r1')).toBe(200);
    cursors.clear('r1');
    expect(cursors.get('r1')).toBeNull();
  });

  it('stores rows under the calendar.watcher.* prefix', () => {
    cursors.set('r1', 999);
    const row = db
      .prepare('SELECT key FROM calendar_watcher_cursors WHERE last_seen_at = 999')
      .get() as { key: string };
    expect(row.key).toBe('calendar.watcher.r1');
  });
});

describe('formatIsoWithOffset', () => {
  it('renders an America/New_York event with a -04:00 offset in summer', () => {
    // 2026-07-01T16:00:00Z → 12:00 in NY DST
    const ms = new Date('2026-07-01T16:00:00Z').getTime();
    expect(formatIsoWithOffset(ms, 'America/New_York')).toBe(
      '2026-07-01T12:00:00-04:00',
    );
  });

  it('renders a UTC event with a Z offset', () => {
    const ms = new Date('2026-04-23T15:00:00Z').getTime();
    expect(formatIsoWithOffset(ms, 'UTC')).toBe('2026-04-23T15:00:00Z');
  });

  it('falls back to UTC for unknown timezones instead of throwing', () => {
    const ms = new Date('2026-04-23T15:00:00Z').getTime();
    expect(formatIsoWithOffset(ms, 'Not/A_Real_Zone')).toBe(
      '2026-04-23T15:00:00Z',
    );
  });
});

describe('handleCalendarWatcher — starting_soon', () => {
  it('fires when an event starts inside the window', async () => {
    seed(baseEvent({ start_at: now + 5 * 60_000 })); // 5 min away
    seed(baseEvent({ source_id: 'evt-2', ical_uid: 'uid-2@example', start_at: now + 45 * 60_000 })); // 45 min
    const res = (await handleCalendarWatcher(deps(true), {
      slug: SLUG,
      kind: 'starting_soon',
      minutes_ahead: 15,
    })) as CalendarWatcherOutput;
    expect(res.should_run).toBe(true);
    expect(res.items.map((i) => i.source_id)).toEqual(['evt-1']);
    expect(res.last_seen_at).toBe(now);
  });

  it('skips cancelled events by default, keeps them when status=cancelled', async () => {
    seed(baseEvent({ start_at: now + 5 * 60_000, status: 'cancelled' }));
    const res = (await handleCalendarWatcher(deps(true), {
      slug: SLUG,
      kind: 'starting_soon',
      minutes_ahead: 15,
    })) as CalendarWatcherOutput;
    expect(res.should_run).toBe(false);
    expect(res.items).toEqual([]);

    const res2 = (await handleCalendarWatcher(deps(true), {
      slug: SLUG,
      kind: 'starting_soon',
      minutes_ahead: 15,
      status: 'cancelled',
    })) as CalendarWatcherOutput;
    expect(res2.should_run).toBe(true);
    expect(res2.items.map((i) => i.status)).toEqual(['cancelled']);
  });

  it('filters by calendar_id when supplied', async () => {
    seed(baseEvent({ start_at: now + 5 * 60_000, calendar_id: 'primary' }));
    seed(baseEvent({
      source_id: 'evt-2', ical_uid: 'uid-2',
      start_at: now + 5 * 60_000, calendar_id: 'holidays',
    }));
    const res = (await handleCalendarWatcher(deps(true), {
      slug: SLUG,
      kind: 'starting_soon',
      minutes_ahead: 15,
      calendar_id: 'holidays',
    })) as CalendarWatcherOutput;
    expect(res.items.map((i) => i.calendar_id)).toEqual(['holidays']);
  });

  it('uses the default 15-minute window when minutes_ahead is omitted', async () => {
    seed(baseEvent({ start_at: now + 10 * 60_000 }));
    seed(baseEvent({
      source_id: 'evt-2', ical_uid: 'uid-2',
      start_at: now + 20 * 60_000,
    }));
    const res = (await handleCalendarWatcher(deps(true), {
      slug: SLUG,
      kind: 'starting_soon',
    })) as CalendarWatcherOutput;
    expect(res.items.map((i) => i.source_id)).toEqual(['evt-1']);
  });

  it('emits ISO 8601 / IANA timezone / unix-ms triad on each item', async () => {
    seed(baseEvent({ start_at: now + 5 * 60_000 }));
    const res = (await handleCalendarWatcher(deps(true), {
      slug: SLUG,
      kind: 'starting_soon',
      minutes_ahead: 15,
    })) as CalendarWatcherOutput;
    const item = res.items[0];
    expect(item.start_at).toBe(now + 5 * 60_000);
    expect(item.timezone).toBe('America/New_York');
    expect(item.start_iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{2}:\d{2}$/);
    expect(item.prior).toBeNull(); // first-ever insert
  });
});

describe('handleCalendarWatcher — changed_since', () => {
  it('with explicit `since` emits every row modified strictly after', async () => {
    // Two events, one modified before cutoff, one after
    seed(baseEvent({ source_id: 'a', ical_uid: 'u-a', updated_at: 500 }));
    seed(baseEvent({ source_id: 'b', ical_uid: 'u-b', updated_at: 1500 }));
    const res = (await handleCalendarWatcher(deps(true), {
      slug: SLUG,
      kind: 'changed_since',
      since: 1000,
    })) as CalendarWatcherOutput;
    expect(res.items.map((i) => i.source_id)).toEqual(['b']);
    expect(res.should_run).toBe(true);
    // last_seen_at advances to the max modified_at seen (=1500)
    expect(res.last_seen_at).toBe(1500);
  });

  it('falls back to the stored cursor when `since` is omitted', async () => {
    cursors.set('r1', 1000);
    seed(baseEvent({ source_id: 'b', ical_uid: 'u-b', updated_at: 1500 }));
    const res = (await handleCalendarWatcher(deps(true), {
      slug: SLUG,
      kind: 'changed_since',
      recipe_id: 'r1',
    })) as CalendarWatcherOutput;
    expect(res.items.map((i) => i.source_id)).toEqual(['b']);
    // cursor advanced
    expect(cursors.get('r1')).toBe(1500);
  });

  it('first tick with no cursor primes the cursor to `now` and emits nothing', async () => {
    seed(baseEvent({ source_id: 'a', ical_uid: 'u-a', updated_at: 500 }));
    const res = (await handleCalendarWatcher(deps(true), {
      slug: SLUG,
      kind: 'changed_since',
      recipe_id: 'first-ever',
    })) as CalendarWatcherOutput;
    expect(res.items).toEqual([]);
    expect(res.should_run).toBe(false);
    expect(cursors.get('first-ever')).toBe(now);
  });

  it('advances the cursor to `now` on an empty, non-first tick', async () => {
    cursors.set('r1', 100);
    // No events — cursor should still move forward.
    const res = (await handleCalendarWatcher(deps(true), {
      slug: SLUG,
      kind: 'changed_since',
      recipe_id: 'r1',
    })) as CalendarWatcherOutput;
    expect(res.items).toEqual([]);
    expect(cursors.get('r1')).toBe(now);
    expect(res.last_seen_at).toBe(now);
  });

  it('carries the row\'s `prior_payload` onto items', async () => {
    const original = baseEvent({ source_id: 'evt-1', ical_uid: 'u-1' });
    seed(original); // first insert → prior = null
    // Edit the event — modified_at rotates, prior_payload keeps the
    // pre-edit copy.
    const edited = { ...original, summary: 'Renamed', updated_at: 2000 };
    reseed(edited, 2000);
    const res = (await handleCalendarWatcher(deps(true), {
      slug: SLUG,
      kind: 'changed_since',
      since: 1000,
    })) as CalendarWatcherOutput;
    expect(res.items).toHaveLength(1);
    expect(res.items[0].summary).toBe('Renamed');
    expect(res.items[0].prior?.summary).toBe('Standup');
  });
});

describe('handleCalendarWatcher — edge cases', () => {
  it('rejects unknown kind with a typed RpcError', async () => {
    await expect(
      handleCalendarWatcher(deps(true), {
        slug: SLUG,
        kind: 'unknown',
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('rejects missing slug with a typed RpcError', async () => {
    await expect(
      handleCalendarWatcher(deps(true), {
        kind: 'starting_soon',
      }),
    ).rejects.toBeInstanceOf(RpcError);
  });

  it('emits a no-fire envelope when the collection is not live', async () => {
    seed(baseEvent({ start_at: now + 5 * 60_000 }));
    const res = (await handleCalendarWatcher(deps(false), {
      slug: SLUG,
      kind: 'starting_soon',
      minutes_ahead: 15,
    })) as CalendarWatcherOutput;
    // No throw — scheduler treats this as a skipped tick rather than
    // a circuit-breaker-worthy failure.
    expect(res.should_run).toBe(false);
    expect(res.items).toEqual([]);
    expect(res.last_seen_at).toBe(now);
  });
});
