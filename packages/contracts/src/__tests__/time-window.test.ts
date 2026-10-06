/** The `core.watch.time` window rule, shared by the server's watcher and the
 *  webclient (2026-10-05). Read on a given zone's wall clock, so a window and a
 *  cron schedule beside it mean the same 8:00. */

import { describe, expect, it } from 'vitest';

import { isWithinTimeWindow, wallClockAt } from '../time-window.js';

// Monday 2026-10-05 15:30 UTC = 08:30 in Los Angeles (PDT), 21:00 in Kolkata.
const MONDAY_1530_UTC = Date.parse('2026-10-05T15:30:00Z');

describe('wallClockAt — the day, hour and minute in a zone', () => {
  it('reads the zone it is given', () => {
    expect(wallClockAt(MONDAY_1530_UTC, 'America/Los_Angeles')).toEqual({ day: 1, hour: 8, minute: 30 });
    expect(wallClockAt(MONDAY_1530_UTC, 'UTC')).toEqual({ day: 1, hour: 15, minute: 30 });
    expect(wallClockAt(MONDAY_1530_UTC, 'Asia/Kolkata')).toEqual({ day: 1, hour: 21, minute: 0 });
    // Past midnight in Tokyo: already Tuesday.
    expect(wallClockAt(MONDAY_1530_UTC, 'Asia/Tokyo')).toEqual({ day: 2, hour: 0, minute: 30 });
  });

  it('reads midnight as hour 0, never 24', () => {
    expect(wallClockAt(Date.parse('2026-10-05T07:00:00Z'), 'America/Los_Angeles').hour).toBe(0);
  });

  it("falls back to this process's zone for none, or an unknown one", () => {
    const local = new Date(MONDAY_1530_UTC);
    const own = { day: local.getDay(), hour: local.getHours(), minute: local.getMinutes() };
    expect(wallClockAt(MONDAY_1530_UTC)).toEqual(own);
    expect(wallClockAt(MONDAY_1530_UTC, 'Not/AZone')).toEqual(own);
  });
});

describe('isWithinTimeWindow — the watcher\'s rule', () => {
  const at = (day: number, hour: number) => ({ day, hour });

  it('weekdays and a half-open hour range', () => {
    const window = { weekdays: [1, 2, 3, 4, 5], start_hour: 8, end_hour: 9 };
    expect(isWithinTimeWindow(window, at(1, 8))).toBe(true);
    expect(isWithinTimeWindow(window, at(1, 9))).toBe(false);
    expect(isWithinTimeWindow(window, at(1, 7))).toBe(false);
    expect(isWithinTimeWindow(window, at(6, 8))).toBe(false);
  });

  it('takes Sunday as 0 or 7', () => {
    expect(isWithinTimeWindow({ weekdays: [7] }, at(0, 12))).toBe(true);
    expect(isWithinTimeWindow({ weekdays: [0] }, at(0, 12))).toBe(true);
    expect(isWithinTimeWindow({ weekdays: [6] }, at(0, 12))).toBe(false);
  });

  it('wraps midnight when the start is after the end', () => {
    const night = { start_hour: 20, end_hour: 6 };
    expect(isWithinTimeWindow(night, at(3, 23))).toBe(true);
    expect(isWithinTimeWindow(night, at(3, 5))).toBe(true);
    expect(isWithinTimeWindow(night, at(3, 12))).toBe(false);
  });

  it('an empty day set or a zero-length range never holds; no bounds always does', () => {
    expect(isWithinTimeWindow({ weekdays: [] }, at(1, 8))).toBe(false);
    expect(isWithinTimeWindow({ start_hour: 8, end_hour: 8 }, at(1, 8))).toBe(false);
    expect(isWithinTimeWindow({}, at(4, 3))).toBe(true);
  });
});
