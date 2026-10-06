/** D-115 Phase 6 — time-watcher handler tests. Moved from
 *  backend/server/src/watchers/__tests__/ in Phase 6D. */

import { describe, it, expect } from 'vitest';
import { IngredientError } from '../../types.js';
import { evaluateTimeWatcher } from '../time.js';

// Helper — build a deterministic Date anchored to local TZ. Tests read
// local-TZ getDay + getHours so the anchor matches the host's TZ, which
// keeps behaviour consistent with the handler's contract ("runtime's
// local TZ"). Explicit UTC offsets aren't needed — tests only compare
// outputs against the same local-TZ reading.
const at = (year: number, month0: number, day: number, hour: number): Date =>
  new Date(year, month0, day, hour, 0, 0, 0);

describe('evaluateTimeWatcher — no constraints', () => {
  it('fires on every call when no weekdays + no hour range set', () => {
    expect(evaluateTimeWatcher({}).should_run).toBe(true);
  });
});

describe('evaluateTimeWatcher — weekday gating', () => {
  it('fires on matching weekday', () => {
    // 2026-04-20 is a Monday (getDay() = 1).
    expect(evaluateTimeWatcher({ weekdays: [1] }, at(2026, 3, 20, 10)).should_run).toBe(true);
  });
  it('does not fire on non-matching weekday', () => {
    expect(evaluateTimeWatcher({ weekdays: [1] }, at(2026, 3, 25, 10)).should_run).toBe(false);
  });
  it('empty weekdays array never matches (empty-set semantics)', () => {
    expect(evaluateTimeWatcher({ weekdays: [] }, at(2026, 3, 20, 10)).should_run).toBe(false);
  });
  // ⛔ 7 is Sunday too (ISO 8601), since the two numberings agree on 1..6. Ten
  // shipped recipes tell the owner "1=Mon..7=Sun", and two defaulted to a 7 this
  // refused, so their auto-run tripped on its first tick.
  it('7 means Sunday, the same as 0', () => {
    // 2026-04-19 is a Sunday (getDay() = 0); 2026-04-20 a Monday.
    expect(evaluateTimeWatcher({ weekdays: [7] }, at(2026, 3, 19, 10)).should_run).toBe(true);
    expect(evaluateTimeWatcher({ weekdays: [0] }, at(2026, 3, 19, 10)).should_run).toBe(true);
    expect(evaluateTimeWatcher({ weekdays: [7] }, at(2026, 3, 20, 10)).should_run).toBe(false);
  });
  it('the ISO week 1..7 is every day', () => {
    for (let date = 19; date <= 25; date += 1) {
      expect(evaluateTimeWatcher({ weekdays: [1, 2, 3, 4, 5, 6, 7] }, at(2026, 3, date, 10)).should_run).toBe(true);
    }
    // ...and without the 7, Sunday is left out.
    expect(evaluateTimeWatcher({ weekdays: [1, 2, 3, 4, 5, 6] }, at(2026, 3, 19, 10)).should_run).toBe(false);
  });
  it('multiple weekdays honoured', () => {
    // Mon + Wed + Fri.
    expect(evaluateTimeWatcher({ weekdays: [1, 3, 5] }, at(2026, 3, 22, 10)).should_run).toBe(true);
    expect(evaluateTimeWatcher({ weekdays: [1, 3, 5] }, at(2026, 3, 23, 10)).should_run).toBe(false);
  });
});

describe('evaluateTimeWatcher — hour window', () => {
  it('fires inside [start, end) business window', () => {
    const args = { start_hour: 9, end_hour: 17 };
    expect(evaluateTimeWatcher(args, at(2026, 3, 20, 9)).should_run).toBe(true);
    expect(evaluateTimeWatcher(args, at(2026, 3, 20, 16)).should_run).toBe(true);
  });
  it('excludes end hour (half-open)', () => {
    expect(evaluateTimeWatcher({ start_hour: 9, end_hour: 17 }, at(2026, 3, 20, 17)).should_run).toBe(false);
  });
  it('excludes before-start hour', () => {
    expect(evaluateTimeWatcher({ start_hour: 9, end_hour: 17 }, at(2026, 3, 20, 8)).should_run).toBe(false);
  });
  it('start_hour alone ⇒ "from start onward" each day', () => {
    expect(evaluateTimeWatcher({ start_hour: 9 }, at(2026, 3, 20, 8)).should_run).toBe(false);
    expect(evaluateTimeWatcher({ start_hour: 9 }, at(2026, 3, 20, 9)).should_run).toBe(true);
    expect(evaluateTimeWatcher({ start_hour: 9 }, at(2026, 3, 20, 23)).should_run).toBe(true);
  });
  it('end_hour alone ⇒ "until end" each day', () => {
    expect(evaluateTimeWatcher({ end_hour: 9 }, at(2026, 3, 20, 0)).should_run).toBe(true);
    expect(evaluateTimeWatcher({ end_hour: 9 }, at(2026, 3, 20, 8)).should_run).toBe(true);
    expect(evaluateTimeWatcher({ end_hour: 9 }, at(2026, 3, 20, 9)).should_run).toBe(false);
  });
  it('start == end ⇒ zero-length window never matches', () => {
    expect(evaluateTimeWatcher({ start_hour: 9, end_hour: 9 }, at(2026, 3, 20, 9)).should_run).toBe(false);
  });
  it('overnight window wraps midnight', () => {
    // Night-shift: 20→8.
    const args = { start_hour: 20, end_hour: 8 };
    expect(evaluateTimeWatcher(args, at(2026, 3, 20, 22)).should_run).toBe(true);
    expect(evaluateTimeWatcher(args, at(2026, 3, 21, 0)).should_run).toBe(true);
    expect(evaluateTimeWatcher(args, at(2026, 3, 21, 7)).should_run).toBe(true);
    expect(evaluateTimeWatcher(args, at(2026, 3, 21, 8)).should_run).toBe(false);
    expect(evaluateTimeWatcher(args, at(2026, 3, 21, 19)).should_run).toBe(false);
  });
});

describe('evaluateTimeWatcher — weekdays AND hour window', () => {
  it('requires both to match', () => {
    const args = { weekdays: [1, 2, 3, 4, 5], start_hour: 9, end_hour: 17 };
    // Mon 10am.
    expect(evaluateTimeWatcher(args, at(2026, 3, 20, 10)).should_run).toBe(true);
    // Sat 10am.
    expect(evaluateTimeWatcher(args, at(2026, 3, 25, 10)).should_run).toBe(false);
    // Mon 8am.
    expect(evaluateTimeWatcher(args, at(2026, 3, 20, 8)).should_run).toBe(false);
  });
});

describe('evaluateTimeWatcher — validation', () => {
  it('rejects weekdays not an array', () => {
    expect(() => evaluateTimeWatcher({ weekdays: 'mon' as unknown as number[] }))
      .toThrow(IngredientError);
  });
  it('rejects weekday out of [0,7]', () => {
    expect(() => evaluateTimeWatcher({ weekdays: [8] })).toThrow(/weekday must be/);
    expect(() => evaluateTimeWatcher({ weekdays: [-1] })).toThrow(/weekday must be/);
  });
  it('rejects non-integer weekday', () => {
    expect(() => evaluateTimeWatcher({ weekdays: [1.5] })).toThrow(IngredientError);
  });
  it('rejects start_hour out of [0,23]', () => {
    expect(() => evaluateTimeWatcher({ start_hour: 24 })).toThrow(/start_hour/);
    expect(() => evaluateTimeWatcher({ start_hour: -1 })).toThrow(IngredientError);
  });
  it('accepts end_hour === 24', () => {
    expect(evaluateTimeWatcher({ end_hour: 24 }, at(2026, 3, 20, 23)).should_run).toBe(true);
  });
  it('rejects end_hour > 24', () => {
    expect(() => evaluateTimeWatcher({ end_hour: 25 })).toThrow(/end_hour/);
  });
});

describe('evaluateTimeWatcher — read on the server\'s clock (D-269, 2026-10-05)', () => {
  // Monday 2026-10-05 15:30 UTC = 08:30 in Los Angeles.
  const instant = new Date(Date.parse('2026-10-05T15:30:00Z'));
  const morning = { weekdays: [1, 2, 3, 4, 5], start_hour: 8, end_hour: 9 };

  it('opens the window at the zone\'s 8:00, not the process\'s', () => {
    // ⛔ The defect this pins: on a server in UTC for an owner in Pacific time,
    // an "8-9 AM" window opened at 8 AM UTC — 1 AM for the owner — while the
    // cron schedules beside it already ran on the declared zone.
    expect(evaluateTimeWatcher(morning, instant, 'America/Los_Angeles').should_run).toBe(true);
    expect(evaluateTimeWatcher(morning, instant, 'UTC').should_run).toBe(false);
  });

  it('reads the day in the zone too', () => {
    // Already Tuesday 00:30 in Tokyo.
    expect(evaluateTimeWatcher({ weekdays: [2] }, instant, 'Asia/Tokyo').should_run).toBe(true);
    expect(evaluateTimeWatcher({ weekdays: [1] }, instant, 'Asia/Tokyo').should_run).toBe(false);
  });
});
