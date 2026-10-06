/** When a timer recipe REALLY runs (2026-10-05).
 *
 *  Owner, on "Runs every 10 minutes and weekdays at 8:00 AM": "is a wrong time
 *  use a real time in the message". A timer recipe checks every N minutes and
 *  runs only inside its `core.watch.time` window, so the line says the window,
 *  and its next run is its first check inside it. The fixtures are the shipped
 *  Today recipe's gate and defaults. */

import { describe, expect, it } from 'vitest';
import type { Dish, RecipeDefinition, ServerSchedule } from '@recued/contracts';

import { dishNextRun, dishStartsLine } from '../dish-line.js';
import { startPhrase, whatStartsIt } from '../dish-lead.js';
import {
  nextRunInTimeWindow,
  recipeTimeWindow,
  timeWindowRunsPhrase,
  timerNextRun,
} from '../time-window.js';

/** `today.json`: checked every 10 minutes, open weekdays 8-9 by default. */
const TODAY = {
  auto_run: { interval_ms: 600_000 },
  trigger_steps: [{
    id: 'morning',
    op: 'core.watch.time',
    args: { weekdays: '{{config.weekdays}}', start_hour: '{{config.start_hour}}', end_hour: '{{config.end_hour}}' },
  }],
  variables: {
    start_hour: { label: 'Window start hour (local TZ)', type: 'number', default: 8 },
    end_hour: { label: 'Window end hour (local TZ)', type: 'number', default: 9 },
    weekdays: { label: 'Active weekdays (1=Mon..7=Sun)', type: 'array', default: [1, 2, 3, 4, 5] },
  },
} as unknown as RecipeDefinition;

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('recipeTimeWindow — the gate, read with the dish\'s settings', () => {
  it('reads the recipe\'s defaults, and a dish\'s own values over them', () => {
    expect(recipeTimeWindow(TODAY)).toEqual({
      kind: 'window', window: { weekdays: [1, 2, 3, 4, 5], start_hour: 8, end_hour: 9 },
    });
    expect(recipeTimeWindow(TODAY, { start_hour: 6, weekdays: [6, 7] })).toEqual({
      kind: 'window', window: { weekdays: [6, 7], start_hour: 6, end_hour: 9 },
    });
  });

  it('reads literal values, and an empty or absent one as "any"', () => {
    const literal = { trigger_steps: [{ id: 'w', op: 'core.watch.time', args: { start_hour: 17, end_hour: 20 } }] };
    expect(recipeTimeWindow(literal as never)).toEqual({ kind: 'window', window: { start_hour: 17, end_hour: 20 } });
    expect(recipeTimeWindow(TODAY, { start_hour: null })).toMatchObject({ window: { end_hour: 9 } });
    expect(recipeTimeWindow(TODAY, { start_hour: null }).kind === 'window'
      && 'start_hour' in (recipeTimeWindow(TODAY, { start_hour: null }) as { window: object }).window).toBe(false);
  });

  it('a recipe with no time gate has none', () => {
    expect(recipeTimeWindow({ trigger_steps: [{ id: 'm', op: 'core.watch.http', args: {} }] } as never)).toEqual({ kind: 'none' });
    expect(recipeTimeWindow({})).toEqual({ kind: 'none' });
  });

  it('a value it cannot read — worked out at run time, or one the watcher refuses — is unreadable', () => {
    const dynamic = { trigger_steps: [{ id: 'w', op: 'core.watch.time', args: { start_hour: '{{step.when.hour}}' } }] };
    expect(recipeTimeWindow(dynamic as never)).toEqual({ kind: 'unreadable' });
    expect(recipeTimeWindow(TODAY, { start_hour: '8' })).toEqual({ kind: 'unreadable' });
    expect(recipeTimeWindow(TODAY, { weekdays: [9] })).toEqual({ kind: 'unreadable' });
  });
});

describe('timeWindowRunsPhrase — the real time, in words', () => {
  it('a check more often than the window is wide runs every check inside it', () => {
    expect(timeWindowRunsPhrase(10 * MIN, { weekdays: [1, 2, 3, 4, 5], start_hour: 8, end_hour: 9 }))
      .toBe('runs every 10 minutes from 8:00 to 9:00 AM on weekdays');
    // The shape most shipped recipes have: hourly, 8-10 on weekdays — twice a morning.
    expect(timeWindowRunsPhrase(HOUR, { weekdays: [1, 2, 3, 4, 5], start_hour: 8, end_hour: 10 }))
      .toBe('runs every hour from 8:00 to 10:00 AM on weekdays');
  });

  it('a check as long as the window runs once in it, and a longer one at most once', () => {
    expect(timeWindowRunsPhrase(HOUR, { weekdays: [1], start_hour: 8, end_hour: 9 }))
      .toBe('runs once between 8:00 and 9:00 AM on Mondays');
    expect(timeWindowRunsPhrase(2 * HOUR, { start_hour: 8, end_hour: 9 }))
      .toBe('runs at most once between 8:00 and 9:00 AM');
  });

  it('says the hours across noon and midnight, and overnight', () => {
    expect(timeWindowRunsPhrase(15 * MIN, { start_hour: 8, end_hour: 18 })).toBe('runs every 15 minutes from 8:00 AM to 6:00 PM');
    expect(timeWindowRunsPhrase(15 * MIN, { start_hour: 17, end_hour: 24 })).toBe('runs every 15 minutes from 5:00 PM to midnight');
    expect(timeWindowRunsPhrase(HOUR, { start_hour: 20, end_hour: 6 })).toBe('runs every hour from 8:00 PM to 6:00 AM');
    expect(timeWindowRunsPhrase(HOUR, { start_hour: 0, end_hour: 6 })).toBe('runs every hour from midnight to 6:00 AM');
  });

  it('names the days: weekends, a list, or none for every day', () => {
    expect(timeWindowRunsPhrase(10 * MIN, { weekdays: [6, 0] })).toBe('runs every 10 minutes on weekends');
    expect(timeWindowRunsPhrase(10 * MIN, { weekdays: [4, 1, 7] })).toBe('runs every 10 minutes on Mondays, Thursdays and Sundays');
    expect(timeWindowRunsPhrase(10 * MIN, { weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe('runs every 10 minutes');
    expect(timeWindowRunsPhrase(86_400_000, { weekdays: [1, 2, 3, 4, 5] })).toBe('runs once a day on weekdays');
  });

  it('a window that never opens says so', () => {
    expect(timeWindowRunsPhrase(10 * MIN, { weekdays: [] })).toBe('never runs: its time window is empty');
    expect(timeWindowRunsPhrase(10 * MIN, { start_hour: 8, end_hour: 8 })).toBe('never runs: its time window is empty');
  });
});

describe('the lines that say it', () => {
  const weekdaysAtEight = { schedule_id: 's1', mode: 'recurring', cron_expression: '0 8 * * 1-5', enabled: true } as unknown as ServerSchedule;

  it('the owner\'s case: the timer\'s window, then the schedule chat added', () => {
    expect(dishStartsLine(TODAY, [weekdaysAtEight]))
      .toBe('Runs every 10 minutes from 8:00 to 9:00 AM on weekdays, and weekdays at 8:00 AM');
    expect(dishStartsLine(TODAY, [])).toBe('Runs every 10 minutes from 8:00 to 9:00 AM on weekdays');
  });

  it('a dish\'s own settings move its window', () => {
    expect(dishStartsLine(TODAY, [], { start_hour: 7, end_hour: 8 })).toBe('Runs every 10 minutes from 7:00 to 8:00 AM on weekdays');
    expect(whatStartsIt(TODAY)).toBe('It runs every 10 minutes from 8:00 to 9:00 AM on weekdays.');
  });

  it('a timer with no window still says its interval; one it cannot read says it checks', () => {
    expect(startPhrase({ auto_run: { interval_ms: 900_000 } })).toBe('runs every 15 minutes');
    expect(startPhrase(TODAY, { start_hour: 'soon' })).toBe('checks every 10 minutes and runs within its set hours');
  });
});

describe('the next REAL run: the first check inside the window', () => {
  const LA = 'America/Los_Angeles';
  const window = { weekdays: [1, 2, 3, 4, 5], start_hour: 8, end_hour: 9 };

  it('a check before the window opens runs at the first check inside it', () => {
    // Monday 04:02 PDT, every 10 minutes ⇒ 08:02 PDT, not 04:02.
    expect(nextRunInTimeWindow(Date.parse('2026-10-05T04:02:00-07:00'), 10 * MIN, window, LA))
      .toBe(Date.parse('2026-10-05T08:02:00-07:00'));
  });

  it('a check inside the window is the next run', () => {
    const inside = Date.parse('2026-10-05T08:32:00-07:00');
    expect(nextRunInTimeWindow(inside, 10 * MIN, window, LA)).toBe(inside);
  });

  it('after Friday\'s window, the next run is Monday\'s first check', () => {
    expect(nextRunInTimeWindow(Date.parse('2026-10-09T09:12:00-07:00'), 10 * MIN, window, LA))
      .toBe(Date.parse('2026-10-12T08:02:00-07:00'));
  });

  it('skips closed hours without jumping past the opening in a half-hour zone', () => {
    // Kolkata is UTC+5:30, so its hours do not start on the hour in UTC.
    expect(nextRunInTimeWindow(Date.parse('2026-10-05T07:55:00+05:30'), 10 * MIN, { start_hour: 8, end_hour: 9 }, 'Asia/Kolkata'))
      .toBe(Date.parse('2026-10-05T08:05:00+05:30'));
  });

  it('a window that never opens has no next run', () => {
    expect(nextRunInTimeWindow(Date.parse('2026-10-05T04:00:00Z'), 10 * MIN, { weekdays: [] }, LA)).toBeNull();
    // Every 24 hours at 03:00 never lands in 8-9.
    expect(nextRunInTimeWindow(Date.parse('2026-10-05T03:00:00-07:00'), 24 * HOUR, window, LA)).toBeNull();
  });

  it('the dish\'s next run reads its timer\'s window; without the recipe, the next check', () => {
    const dish = { dish_id: 'd1', enabled: true, config_overlay: {} } as unknown as Dish;
    const timer = {
      dish_id: 'd1', enabled: true, auto_disabled: false, interval_ms: 10 * MIN,
      next_run_at: Date.parse('2026-10-05T04:02:00-07:00'),
    } as never;
    const rows = { triggers: [], schedules: [], timer };
    expect(dishNextRun(dish, rows, { recipe: TODAY, timeZone: LA })).toBe(Date.parse('2026-10-05T08:02:00-07:00'));
    expect(dishNextRun(dish, rows)).toBe(Date.parse('2026-10-05T04:02:00-07:00'));
    expect(timerNextRun({ next_run_at: null, interval_ms: 10 * MIN }, TODAY)).toBeNull();
  });
});
