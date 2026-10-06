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
} from '../watchers/time-relative-watcher.js';
import { createTestCalendarStack } from './helpers/calendar-stack.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let db: Database.Database;
let close: () => void;
let registry: CollectionRegistry;
let seedEvent: (source_id: string, start_at: number, minutes?: number, calendar?: string) => void;
let now: number;

beforeEach(async () => {
  now = Date.parse('2026-10-05T09:00:00Z');
  // Two calendars: the owner's `work` and `home`.
  const calendar = await createTestCalendarStack({ now: () => now, calendars: ['work', 'home'] });
  ({ db, registry, close } = calendar);
  seedEvent = (source_id, start_at, minutes = 30, slug = 'work') =>
    calendar.seed({ source_id, start_at, minutes, calendar: slug });
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
