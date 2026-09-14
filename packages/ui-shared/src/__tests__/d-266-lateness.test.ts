/** D-266 — how late a schedule's current occurrence is.
 *
 *  The measure reads `next_run_at`, which the server sets at every fire
 *  to the first cron match after it and touches nowhere else. That makes
 *  "late" simply a slot in the past — no interval arithmetic, and so no
 *  way to inherit the two errors interval arithmetic brings.
 */
import { describe, expect, it } from 'vitest';
import { formatLateness, scheduleLatenessMs } from '../date-time.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = new Date(2026, 3, 21, 7, 29, 0).getTime();

describe('scheduleLatenessMs', () => {
  it('a slot in the past is late by exactly that much', () => {
    const due = new Date(2026, 3, 21, 7, 0, 0).getTime();
    expect(scheduleLatenessMs(due, NOW, true)).toBe(29 * MIN);
  });

  it('a slot in the future is not late', () => {
    expect(scheduleLatenessMs(NOW + HOUR, NOW, true)).toBeNull();
  });

  it('⛔ a PAUSED schedule is never late — the owner chose the pause', () => {
    // A paused schedule keeps its `next_run_at`, so a measure that read
    // only the timestamp would blame the owner for their own decision.
    const due = new Date(2026, 3, 21, 7, 0, 0).getTime();
    expect(scheduleLatenessMs(due, NOW, false)).toBeNull();
  });

  it('says nothing when there is no slot to compare against', () => {
    expect(scheduleLatenessMs(null, NOW, true)).toBeNull();
    expect(scheduleLatenessMs(undefined, NOW, true)).toBeNull();
    expect(scheduleLatenessMs(Number.NaN, NOW, true)).toBeNull();
  });

  it('⛔ MATCHES THE CRON ON A WEEKDAY SCHEDULE, WHERE "+1 INTERVAL" DOES NOT', () => {
    // `0 8 * * 1-5` ran Friday 08:00; it is now Monday 08:29. The server
    // already resolved the next slot to MONDAY 08:00 at fire time, so
    // this reads 29 minutes. Adding one day to the last run lands on a
    // Saturday the schedule never runs on and would report ~2 days —
    // driven, 2909 minutes. Reading the server's answer avoids inventing
    // an interval that does not exist.
    const mondaySlot = new Date(2026, 3, 13, 8, 0, 0).getTime();
    const mondayNow = new Date(2026, 3, 13, 8, 29, 0).getTime();
    expect(scheduleLatenessMs(mondaySlot, mondayNow, true)).toBe(29 * MIN);

    const fridayRun = new Date(2026, 3, 10, 8, 0, 0).getTime();
    expect(mondayNow - (fridayRun + DAY)).toBe(2909 * MIN);
  });
});

describe('formatLateness', () => {
  it('is coarse on purpose — seconds never change the judgement', () => {
    expect(formatLateness(29 * MIN)).toBe('29 min late');
    expect(formatLateness(3 * HOUR + 40 * MIN)).toBe('3 h late');
    expect(formatLateness(2 * DAY + 5 * HOUR)).toBe('2 d late');
  });

  it('never rounds a real lateness down to "0 min"', () => {
    expect(formatLateness(20_000)).toBe('1 min late');
  });
});
