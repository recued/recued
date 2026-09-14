import { describe, it, expect } from 'vitest';
import {
  shouldCatchUp,
  countMissedCycles,
  countOutstandingOccurrences,
  buildBackfillMetadata,
  BACKFILL_WINDOW_MIN,
  DISPLAY_OCCURRENCE_LIMIT,
} from '../backfill.js';
import type { Schedule } from '../types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

function mkSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    schedule_id: over.schedule_id ?? 'sched-a',
    recipe_id: over.recipe_id ?? 'r1',
    publisher_id: 'recued-core',
    cron_expression: over.cron_expression ?? '*/5 * * * *',
    enabled: over.enabled ?? true,
    created_at: 0,
    last_run_at: over.last_run_at ?? null,
    prev_run_at: over.prev_run_at ?? null,
    next_run_at: over.next_run_at ?? null,
    last_status: 'success',
    last_error: null,
  };
}

describe('shouldCatchUp', () => {
  it('returns false when the schedule has never fired', () => {
    expect(shouldCatchUp(mkSchedule({ last_run_at: null }), Date.UTC(2026, 3, 22, 12, 0, 0))).toBe(false);
  });

  it('returns false when no cron-matched cycle has passed since last_run_at', () => {
    // Hourly cron, last fire 30 min ago — next expected is in 30 min.
    // No catch-up needed.
    const schedule = mkSchedule({
      cron_expression: '0 * * * *',
      last_run_at: Date.UTC(2026, 3, 22, 11, 0, 0),
    });
    expect(shouldCatchUp(schedule, Date.UTC(2026, 3, 22, 11, 30, 0))).toBe(false);
  });

  it('returns false when the next regular cycle is within the window', () => {
    // Every-30-min cron, last fired 35 min ago, next regular in 25 min.
    // 25 < BACKFILL_WINDOW_MIN (30) → wait for the next regular tick.
    const schedule = mkSchedule({
      cron_expression: '*/30 * * * *',
      last_run_at: Date.UTC(2026, 3, 22, 11, 25, 0),
    });
    expect(shouldCatchUp(schedule, Date.UTC(2026, 3, 22, 12, 0, 0))).toBe(false);
  });

  it('returns true when at least one cycle was missed AND the wait is long', () => {
    // Hourly cron, last fired 5 hours ago, next regular in ~60 min.
    // 60 > 30 → catch up.
    const schedule = mkSchedule({
      cron_expression: '0 * * * *',
      last_run_at: Date.UTC(2026, 3, 22, 7, 0, 0),
    });
    expect(shouldCatchUp(schedule, Date.UTC(2026, 3, 22, 12, 0, 1))).toBe(true);
  });

  it('skips malformed cron expressions safely', () => {
    const schedule = mkSchedule({
      cron_expression: 'not-a-cron',
      last_run_at: Date.UTC(2026, 3, 22, 11, 0, 0),
    });
    expect(shouldCatchUp(schedule, Date.UTC(2026, 3, 22, 12, 0, 0))).toBe(false);
  });
});

describe('countMissedCycles — cron occurrences, not an observed cadence', () => {
  it('returns "unknown" when the schedule has never run', () => {
    expect(countMissedCycles({ last_run_at: null, cron_expression: '0 * * * *' }, 5000))
      .toBe('unknown');
  });

  it('returns "unknown" when the cron cannot be read', () => {
    expect(countMissedCycles({ last_run_at: 1000, cron_expression: 'not a cron' }, 5000))
      .toBe('unknown');
  });

  it('⛔ counts from the FIRST run — no `prev_run_at` sample is needed any more', () => {
    // The old measure reported 'unknown' for the whole of a schedule's
    // first catch-up, because it had only one timestamp to divide with.
    const last = Date.UTC(2026, 3, 22, 7, 0, 0);
    expect(countMissedCycles(
      { last_run_at: last, cron_expression: '0 * * * *' },
      last + 6 * HOUR,
    )).toBe(5);
  });

  it('counts hourly occurrences over a long gap', () => {
    const last = Date.UTC(2026, 3, 22, 7, 0, 0);
    // 07:00 last ran; 08:00…13:00 are outstanding at 13:00 ⇒ 6 occurrences,
    // one of which the catch-up fires ⇒ 5 beyond it.
    expect(countMissedCycles(
      { last_run_at: last, cron_expression: '0 * * * *' },
      last + 6 * HOUR,
    )).toBe(5);
  });

  it('returns 0 when only the one catch-up occurrence is outstanding', () => {
    const last = Date.UTC(2026, 3, 22, 7, 0, 0);
    expect(countMissedCycles(
      { last_run_at: last, cron_expression: '0 * * * *' },
      last + 90 * MIN,
    )).toBe(0);
  });

  it('⛔ WEEKDAY CRON OVER A WEEKEND — the case every arithmetic shortcut gets wrong', () => {
    // Fri 08:00 ran; Sat and Sun are NOT cron matches. By Monday 09:00
    // exactly ONE occurrence (Monday's) is outstanding ⇒ 0 beyond the
    // catch-up. Dividing by a minimum interval would score two.
    const friday = new Date(2026, 3, 10, 8, 0, 0).getTime();
    const monday = new Date(2026, 3, 13, 9, 0, 0).getTime();
    expect(countMissedCycles({ last_run_at: friday, cron_expression: '0 8 * * 1-5' }, monday))
      .toBe(0);

    // …and a fortnight down scores the weekdays that really passed.
    const later = new Date(2026, 3, 24, 9, 0, 0).getTime();
    expect(countMissedCycles({ last_run_at: friday, cron_expression: '0 8 * * 1-5' }, later))
      .toBe(9);
  });

  it('⛔ IS IMMUNE TO THE OUTAGE-SPANNING SAMPLE THAT BROKE THE OLD MEASURE', () => {
    // A daily schedule down 30 days, then one ordinary run. The old
    // measure divided by `prev → last` = 31 days and read a later 34-day
    // gap as under one cycle — "fresh". Counting occurrences does not
    // care what happened before `last_run_at` at all.
    const backAt = new Date(2026, 3, 15, 7, 0, 0).getTime();
    const thirtyFourDaysLater = new Date(2026, 4, 19, 12, 0, 0).getTime();
    expect(countMissedCycles(
      { last_run_at: backAt, cron_expression: '0 7 * * *' },
      thirtyFourDaysLater,
    )).toBe(33);
  });
});

describe('countOutstandingOccurrences', () => {
  it('stops at the limit and says so, so a caller can render "N+"', () => {
    const last = Date.UTC(2026, 3, 1, 0, 0, 0);
    const now = last + 40 * HOUR;
    expect(countOutstandingOccurrences('0 * * * *', last, now, 2))
      .toEqual({ count: 2, capped: true });
    expect(countOutstandingOccurrences('0 * * * *', last, now, 500))
      .toEqual({ count: 40, capped: false });
  });

  it('counts nothing for a malformed cron rather than guessing', () => {
    expect(countOutstandingOccurrences('nope', 0, 10 ** 12, 5))
      .toEqual({ count: 0, capped: false });
  });

  it('⚠ the decision only ever asks for 2 — the scan cost tracks the WINDOW', () => {
    // A daily cron down a year is ~525k minute-steps if counted in full
    // (~135 ms, measured). Stopping at 2 walks two days.
    const last = Date.UTC(2025, 3, 22, 7, 0, 0);
    const now = Date.UTC(2026, 3, 22, 7, 0, 0);
    const started = Date.now();
    expect(countOutstandingOccurrences('0 7 * * *', last, now, 2))
      .toEqual({ count: 2, capped: true });
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe('buildBackfillMetadata', () => {
  it('packs missed_cycles + last_run_at_before for the audit row', () => {
    const last = Date.UTC(2026, 3, 22, 7, 0, 0);
    const meta = buildBackfillMetadata(
      { last_run_at: last, cron_expression: '0 * * * *' },
      last + 6 * HOUR,
    );
    expect(meta).toEqual({ missed_cycles: 5, last_run_at_before: last });
  });

  it('⛔ the AUDIT count is exact where the CARD count is capped — different cadences of use', () => {
    // The card recomputes every tick until the owner answers, so it stops
    // at 99. This runs ONCE, on the catch-up fire, so it can scan the
    // whole window: an hourly schedule down nine days is 216 occurrences,
    // and the audit row says so rather than "98".
    const last = Date.UTC(2026, 3, 1, 0, 0, 0);
    const now = last + 9 * 24 * HOUR;
    expect(countOutstandingOccurrences('0 * * * *', last, now, DISPLAY_OCCURRENCE_LIMIT))
      .toEqual({ count: 99, capped: true });
    expect(buildBackfillMetadata({ last_run_at: last, cron_expression: '0 * * * *' }, now))
      .toEqual({ missed_cycles: 215, last_run_at_before: last });
  });

  it('reports "unknown" on an unreadable cron but still records last_run_at_before', () => {
    const last = 10_000;
    const meta = buildBackfillMetadata({ last_run_at: last, cron_expression: 'x' }, 50_000);
    expect(meta).toEqual({ missed_cycles: 'unknown', last_run_at_before: last });
  });
});

describe('BACKFILL_WINDOW_MIN', () => {
  it('is 30 minutes — the system-wide default', () => {
    expect(BACKFILL_WINDOW_MIN).toBe(30);
  });
});
