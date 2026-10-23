/** `time-relative-watcher` over a REAL calendar (fixed 2026-10-05).
 *
 *  Four shipped recipes run on it: `meeting-prep-brief`,
 *  `time-alert-before-event`, `travel-day-prep-checklist` and
 *  `post-meeting-follow-up-extractor`. Two defects, each shown on this stack
 *  before the fix:
 *    - it read the 500 events with the LATEST start, so with more than 500
 *      upcoming occurrences a meeting due in 20 minutes never fired (400: it
 *      fired at the first check);
 *    - it had no lookback, so after install every past occurrence in the
 *      warehouse fired once, one per check.
 *  A third (2026-10-22): its ledger kept no date, so a meeting moved after
 *  its notice never got one at its new time ("a meeting that moves").
 *
 *  ⚠ The suite's other time-relative tests use a registry whose `list()`
 *  ignores the query, so no window or page can be tested there. These run the
 *  calendar stack the server composes (table, collection, registry), with a
 *  provider that never syncs. */

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CollectionRegistry } from '../collections/registry.js';
import {
  forgetTimeRelativeWatcherRecipe,
  handleTimeRelativeWatcher,
  TIME_RELATIVE_FIRST_CHECK_GRACE_MS,
  TIME_RELATIVE_MOVED_GRACE_MS,
} from '../watchers/time-relative-watcher.js';
import { createTestCalendarStack } from './helpers/calendar-stack.js';
import { createWatcherDispatcher } from '../watchers/index.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let db: Database.Database;
let close: () => void;
let registry: CollectionRegistry;
let seedEvent: (source_id: string, start_at: number, minutes?: number, calendar?: string) => void;
let seedAllDay: (source_id: string, day: number) => void;
let now: number;

beforeEach(async () => {
  now = Date.parse('2026-10-05T09:00:00Z');
  // Two calendars: the owner's `work` and `home`.
  const calendar = await createTestCalendarStack({ now: () => now, calendars: ['work', 'home'] });
  ({ db, registry, close } = calendar);
  seedEvent = (source_id, start_at, minutes = 30, slug = 'work') =>
    calendar.seed({ source_id, start_at, minutes, calendar: slug });
  seedAllDay = (source_id, day) => calendar.seed({ source_id, start_at: day, minutes: 24 * 60, is_all_day: true });
});
afterEach(() => close());

/** One check, as `meeting-prep-brief` makes it (30 minutes before each start). */
const check = (args: { recipe_id?: string; anchor_field?: string; offsets?: string[]; instance?: string } = {}) =>
  handleTimeRelativeWatcher({ db, registry, now: () => now }, {
    collection: 'data.calendar',
    anchor_field: args.anchor_field ?? 'start_at',
    offsets: args.offsets ?? ['-30m'],
    recipe_id: args.recipe_id ?? 'meeting-prep-brief',
    ...(args.instance !== undefined ? { instance: args.instance } : {}),
  });

/** The summaries (seeded as each event's id) that fire over `checks` checks. */
const firesOver = async (checks: number, args?: Parameters<typeof check>[0]): Promise<string[]> => {
  const fired: string[] = [];
  for (let i = 0; i < checks; i += 1) {
    const out = await check(args);
    if (out.should_run) fired.push(String((out.trigger_record as { hot_fields?: { summary?: string } }).hot_fields?.summary));
  }
  return fired;
};

describe('time-relative-watcher on an ALL-DAY event (2026-10-07)', () => {
  // An all-day event is stored as days (`calendar-days.ts`): 24 Dec 2026 is its
  // UTC midnight, which in Los Angeles is 23 Dec, 16:00. "A day before" it was
  // reached at 22 Dec, 16:00 there; it is 23 Dec, 00:00 — 08:00 UTC in winter.
  const allDayCheck = (at: number, timeZone?: string) => {
    now = at;
    return handleTimeRelativeWatcher({ db, registry, now: () => now, ...(timeZone ? { timeZone: () => timeZone } : {}) }, {
      collection: 'data.calendar', anchor_field: 'start_at', offsets: ['-1d'], recipe_id: 'time-alert-before-event',
    });
  };

  it("fires a day before the local midnight it starts at, where the owner is", async () => {
    seedAllDay('holiday', Date.UTC(2026, 11, 24));
    expect((await allDayCheck(Date.parse('2026-12-23T04:00:00Z'), 'America/Los_Angeles')).should_run).toBe(false);
    const fired = await allDayCheck(Date.parse('2026-12-23T08:30:00Z'), 'America/Los_Angeles');
    expect(fired.should_run).toBe(true);
    expect(fired.anchor_at).toBe(Date.parse('2026-12-24T08:00:00Z'));
  });

  it("the watcher dispatcher hands it the server's zone — the one a cron schedule reads", async () => {
    seedAllDay('holiday', Date.UTC(2026, 11, 24));
    now = Date.parse('2026-12-23T08:30:00Z');
    const watch = createWatcherDispatcher({
      db, collectionRegistry: registry, now: () => now, serverTimeZone: () => 'America/Los_Angeles',
    });
    const fired = await watch({
      slug: 'time-relative-watcher',
      args: { collection: 'data.calendar', anchor_field: 'start_at', offsets: ['-1d'], recipe_id: 'time-alert-before-event' },
    }) as { should_run: boolean; anchor_at: number | null };
    expect(fired.should_run).toBe(true);
    expect(fired.anchor_at).toBe(Date.parse('2026-12-24T08:00:00Z'));
  });

  it('reads the day in UTC when no zone is known — where the day already is', async () => {
    seedAllDay('holiday', Date.UTC(2026, 11, 24));
    const fired = await allDayCheck(Date.parse('2026-12-23T00:30:00Z'));
    expect(fired.should_run).toBe(true);
    expect(fired.anchor_at).toBe(Date.UTC(2026, 11, 24));
  });

  it('moved to another day, it gets its "day before" again', async () => {
    seedAllDay('holiday', Date.UTC(2026, 11, 24));
    expect((await allDayCheck(Date.parse('2026-12-23T08:30:00Z'), 'America/Los_Angeles')).should_run).toBe(true);
    seedAllDay('holiday', Date.UTC(2026, 11, 26));
    const again = await allDayCheck(Date.parse('2026-12-25T08:30:00Z'), 'America/Los_Angeles');
    expect(again.should_run).toBe(true);
    expect(again.anchor_at).toBe(Date.parse('2026-12-26T08:00:00Z'));
  });

  it('⛔ a new zone for the owner repeats no fire: the ledger keeps the day as the event stores it', async () => {
    seedAllDay('holiday', Date.UTC(2026, 11, 24));
    expect((await allDayCheck(Date.parse('2026-12-23T08:30:00Z'), 'America/Los_Angeles')).should_run).toBe(true);
    // In Honolulu its day before begins at 10:00 UTC: after that fire, and within the hour.
    expect((await allDayCheck(Date.parse('2026-12-23T10:30:00Z'), 'Pacific/Honolulu')).should_run).toBe(false);
  });
});

describe('time-relative-watcher on a calendar', () => {
  it('⛔ fires for a meeting due soon even with more than 500 occurrences further ahead', async () => {
    for (let i = 0; i < 600; i += 1) seedEvent(`later-${i}`, now + 2 * DAY + i * HOUR);
    seedEvent('standup', now + 20 * MINUTE);
    expect(await firesOver(1)).toEqual(['standup']);
  });

  it('⛔ installed on a calendar with a past, fires for none of it', async () => {
    for (let day = 1; day <= 20; day += 1) seedEvent(`past-${day}`, now - day * DAY);
    seedEvent('standup', now + 20 * MINUTE);
    expect(await firesOver(25)).toEqual(['standup']);
  });

  it('a boundary that crossed shortly before the first check still fires; an older one does not', async () => {
    seedEvent('starting-in-10-minutes', now + 10 * MINUTE); // its 30-minutes-before was 20 minutes ago
    seedEvent('started-2-hours-ago', now - 2 * HOUR);
    expect(TIME_RELATIVE_FIRST_CHECK_GRACE_MS).toBe(HOUR);
    expect(await firesOver(3)).toEqual(['starting-in-10-minutes']);
  });

  it('after it starts watching, a gap is caught up, in order', async () => {
    await check(); // the first check sets where the watch starts
    seedEvent('first', now + HOUR); // its boundary: 30 minutes from now
    seedEvent('second', now + HOUR + 30 * MINUTE); // an hour from now
    now += 3 * HOUR; // the server was down
    expect(await firesOver(3)).toEqual(['first', 'second']);
  });

  it('fires a boundary once it crosses, and only once', async () => {
    seedEvent('review', now + 50 * MINUTE);
    expect(await firesOver(3)).toEqual([]);
    now += 25 * MINUTE;
    expect(await firesOver(3)).toEqual(['review']);
  });

  it('reads the end of a meeting too (a follow-up 15 minutes after it ends)', async () => {
    seedEvent('call', now - 20 * MINUTE, 10); // ended 10 minutes ago
    seedEvent('long-ago', now - 3 * DAY, 60);
    const args = { recipe_id: 'post-meeting-follow-up-extractor', anchor_field: 'end_at', offsets: ['+15m'] };
    expect(await firesOver(2, args)).toEqual([]);
    now += 5 * MINUTE;
    expect(await firesOver(2, args)).toEqual(['call']);
  });

  it('each recipe has its own start point and record', async () => {
    seedEvent('standup', now + 20 * MINUTE);
    expect(await firesOver(1)).toEqual(['standup']);
    expect(await firesOver(1, { recipe_id: 'time-alert-before-event' })).toEqual(['standup']);
  });

  it('uninstall forgets the start point, so a reinstall does not replay what passed meanwhile', async () => {
    await check(); // installed: the watch starts now
    seedEvent('while-away', now + 2 * DAY);
    forgetTimeRelativeWatcherRecipe(db, 'meeting-prep-brief'); // uninstalled
    now += 5 * DAY; // reinstalled five days later
    seedEvent('next', now + 20 * MINUTE);
    expect(await firesOver(3)).toEqual(['next']);
  });

  it('⛔ an event that began before the watch and is still on does not fire for its start', async () => {
    // The read is an overlap window, so a three-day conference running now is in it.
    seedEvent('conference', now - 2 * DAY, 3 * 24 * 60);
    seedEvent('standup', now + 20 * MINUTE);
    expect(await firesOver(3)).toEqual(['standup']);
  });
});

/** 2026-10-22: the ledger kept no date, so a boundary that had fired never
 *  fired again for its record, wherever the record's date went. */
describe('a meeting that moves', () => {
  it('⛔ moved later after its notice, it gets one at its new time, once', async () => {
    seedEvent('review', now + 20 * MINUTE); // 09:20: its boundary crossed 10 minutes ago
    expect(await firesOver(2)).toEqual(['review']);
    seedEvent('review', now + 6 * HOUR); // moved to 15:00
    expect(await firesOver(2)).toEqual([]);
    now += 5 * HOUR + 30 * MINUTE; // 14:30
    const out = await check();
    expect(out.should_run).toBe(true);
    expect(out.anchor_at).toBe(now + 30 * MINUTE);
    expect(await firesOver(2)).toEqual([]);
  });

  it('moved earlier after its notice, it does not get a second one', async () => {
    seedEvent('review', now + 30 * MINUTE); // 09:30: announced at 09:00
    expect(await firesOver(1)).toEqual(['review']);
    now += 5 * MINUTE;
    seedEvent('review', now + 10 * MINUTE); // moved to 09:15, a boundary before that notice
    expect(await firesOver(2)).toEqual([]);
  });

  it('a meeting moved to start soon still gets its notice; an edit to one that is over does not', async () => {
    seedEvent('soon', now + 20 * MINUTE);
    seedEvent('over', now + 25 * MINUTE);
    expect(await firesOver(2)).toEqual(['soon', 'over']);
    now += 6 * HOUR; // 15:00
    seedEvent('soon', now + 10 * MINUTE); // its new boundary crossed 20 minutes ago
    seedEvent('over', now - 2 * HOUR); // corrected to 13:00: its new boundary crossed 2½ hours ago
    expect(TIME_RELATIVE_MOVED_GRACE_MS).toBe(HOUR);
    expect(await firesOver(3)).toEqual(['soon']);
  });

  it('a ledger from before dates were kept gains the column, and its fires still count', async () => {
    // The ledger as it was until 2026-10-22.
    db.exec(`CREATE TABLE time_relative_watcher_state (
      recipe_id TEXT NOT NULL, slug TEXT NOT NULL, record_id TEXT NOT NULL,
      offset_label TEXT NOT NULL, fired_at INTEGER NOT NULL,
      PRIMARY KEY (recipe_id, slug, record_id, offset_label))`);
    seedEvent('review', now + 20 * MINUTE);
    expect(await firesOver(1)).toEqual(['review']);
    // A fire recorded then, or by an older server, has no date.
    db.prepare('UPDATE time_relative_watcher_state SET stored_anchor = NULL').run();
    seedEvent('review', now + 6 * HOUR);
    now += 5 * HOUR + 30 * MINUTE;
    expect(await firesOver(2)).toEqual([]);
  });
});

describe('time-relative-watcher on another collection', () => {
  /** A mailbox is read once per check, not windowed, so the start point is
   *  what keeps its past out. */
  it('⛔ does not fire for mail that arrived before the watch began', async () => {
    const mail = {
      platform: 'mail', slug: 'work',
      list: () => [
        { record_id: 'old', hot_fields: { received_at: now - 3 * DAY, subject: 'old' } },
        { record_id: 'new', hot_fields: { received_at: now - 5 * MINUTE, subject: 'new' } },
      ],
    };
    const mailbox = { list: () => [mail], get: () => mail } as unknown as CollectionRegistry;
    const fired: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const out = await handleTimeRelativeWatcher({ db, registry: mailbox, now: () => now }, {
        collection: 'data.mail', anchor_field: 'received_at', offsets: ['+1m'], recipe_id: 'follow-up-nudge',
      });
      if (out.should_run) fired.push(String(out.trigger_record_id));
    }
    expect(fired).toEqual(['new']);
  });
});

/** `instance` and `trigger_instance` (2026-10-05). Three shipped recipes
 *  watched every calendar but read the meeting's details from the one their
 *  setting named (default `primary`): a meeting elsewhere got no attendees,
 *  and a name no calendar has failed every run. */
describe('one calendar, or every calendar', () => {
  it('a fire names the calendar its meeting is in', async () => {
    seedEvent('dentist', now + 20 * MINUTE, 30, 'home');
    const out = await check();
    expect(out.should_run).toBe(true);
    expect(out.trigger_instance).toBe('home');
  });

  it('watches only the calendar `instance` names', async () => {
    seedEvent('standup', now + 20 * MINUTE, 30, 'work');
    seedEvent('dentist', now + 25 * MINUTE, 30, 'home');
    expect(await firesOver(3, { instance: 'work' })).toEqual(['standup']);
  });

  it('a name no calendar has fires nothing, and does not fail the run', async () => {
    seedEvent('standup', now + 20 * MINUTE);
    const out = await check({ instance: 'primary' });
    expect(out.should_run).toBe(false);
  });

  it('⛔ switching the watched calendar does not replay the newly watched one\'s past', async () => {
    await check({ instance: 'work' }); // watching work from now
    seedEvent('missed', now + DAY, 30, 'home'); // passes while only work is watched
    now += 3 * DAY;
    seedEvent('soon', now + 20 * MINUTE, 30, 'home');
    expect(await firesOver(3, { instance: 'home' })).toEqual(['soon']);
  });

  it('⛔ refuses an instance that is not text', async () => {
    await expect(handleTimeRelativeWatcher({ db, registry, now: () => now }, {
      collection: 'data.calendar', anchor_field: 'start_at', offsets: ['-30m'], recipe_id: 'r', instance: 7 as never,
    })).rejects.toThrow(/instance must be text/);
  });
});
