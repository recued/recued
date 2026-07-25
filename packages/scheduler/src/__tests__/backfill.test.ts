import { describe, it, expect } from 'vitest';
import {
  shouldCatchUp,
  countMissedCycles,
  buildBackfillMetadata,
  BACKFILL_WINDOW_MIN,
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

describe('countMissedCycles', () => {
  it('returns "unknown" when prev_run_at is null (first catch-up after creation)', () => {
    expect(
      countMissedCycles({ last_run_at: 1000, prev_run_at: null }, 5000),
    ).toBe('unknown');
  });

  it('returns "unknown" when last_run_at is null', () => {
    expect(
      countMissedCycles({ last_run_at: null, prev_run_at: 0 }, 5000),
    ).toBe('unknown');
  });

  it('computes count from observed interval (5-min cron, 47 missed)', () => {
    const interval = 5 * MIN;
    const last = Date.UTC(2026, 3, 22, 8, 0, 0);
    const prev = last - interval;
    const now = last + 48 * interval;
    expect(countMissedCycles({ last_run_at: last, prev_run_at: prev }, now)).toBe(47);
  });

  it('handles long outages on hourly schedules (5 missed)', () => {
    const last = Date.UTC(2026, 3, 22, 7, 0, 0);
    const prev = last - HOUR;
    const now = last + 6 * HOUR;
    expect(countMissedCycles({ last_run_at: last, prev_run_at: prev }, now)).toBe(5);
  });

  it('returns 0 when no full extra cycle has elapsed', () => {
    // Cycle interval 5 min, gap to now is only 4 min.
    const last = 10_000;
    const prev = last - 5 * MIN;
    const now = last + 4 * MIN;
    expect(countMissedCycles({ last_run_at: last, prev_run_at: prev }, now)).toBe(0);
  });

  it('returns "unknown" for non-positive observed intervals', () => {
    // Defensive: clock skew or backfill rewrite that leaves prev > last.
    expect(
      countMissedCycles({ last_run_at: 1000, prev_run_at: 5000 }, 9000),
    ).toBe('unknown');
  });
});

describe('buildBackfillMetadata', () => {
  it('packs missed_cycles + last_run_at_before for the audit row', () => {
    const last = Date.UTC(2026, 3, 22, 7, 0, 0);
    const prev = last - HOUR;
    const now = last + 6 * HOUR;
    const meta = buildBackfillMetadata({ last_run_at: last, prev_run_at: prev }, now);
    expect(meta).toEqual({
      missed_cycles: 5,
      last_run_at_before: last,
    });
  });

  it('reports "unknown" when prev is missing but still records last_run_at_before', () => {
    const last = 10_000;
    const meta = buildBackfillMetadata({ last_run_at: last, prev_run_at: null }, 50_000);
    expect(meta).toEqual({
      missed_cycles: 'unknown',
      last_run_at_before: last,
    });
  });
});

describe('BACKFILL_WINDOW_MIN', () => {
  it('is 30 minutes — the system-wide default', () => {
    expect(BACKFILL_WINDOW_MIN).toBe(30);
  });
});
