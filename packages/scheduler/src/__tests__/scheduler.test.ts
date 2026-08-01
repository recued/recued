import { describe, it, expect } from 'vitest';
import { createInMemoryScheduleStore } from '../store.js';
import { createIDBScheduleStore } from '../idb-store.js';
import { describeCron, buildCronFromInterval, CRON_PRESETS } from '../types.js';
import { formatNextFire } from '../cron-interval.js';
import type { Schedule } from '../types.js';

const mkSchedule = (overrides: Partial<Schedule> = {}): Schedule => ({
  schedule_id: 'sched-1',
  recipe_id: 'deal-risk',
  publisher_id: 'recued-core',
  cron_expression: '0 8 * * *',
  enabled: true,
  created_at: 1000,
  last_run_at: null,
  next_run_at: null,
  last_status: null,
  last_error: null,
  ...overrides,
});

describe('createInMemoryScheduleStore', () => {
  it('starts empty', async () => {
    const store = createInMemoryScheduleStore();
    expect(await store.list()).toEqual([]);
  });

  it('set + get roundtrip', async () => {
    const store = createInMemoryScheduleStore();
    const s = mkSchedule();
    await store.set(s);
    expect(await store.get('sched-1')).toEqual(s);
  });

  it('list returns all schedules', async () => {
    const store = createInMemoryScheduleStore();
    await store.set(mkSchedule({ schedule_id: 'a' }));
    await store.set(mkSchedule({ schedule_id: 'b' }));
    expect(await store.list()).toHaveLength(2);
  });

  it('getByRecipe finds by recipe + publisher', async () => {
    const store = createInMemoryScheduleStore();
    await store.set(mkSchedule({ recipe_id: 'r1', publisher_id: 'p1' }));
    await store.set(mkSchedule({ schedule_id: 's2', recipe_id: 'r2', publisher_id: 'p2' }));
    const found = await store.getByRecipe('r1', 'p1');
    expect(found?.recipe_id).toBe('r1');
  });

  it('getByRecipe returns null when not found', async () => {
    const store = createInMemoryScheduleStore();
    expect(await store.getByRecipe('missing', 'x')).toBeNull();
  });

  it('delete removes schedule', async () => {
    const store = createInMemoryScheduleStore();
    await store.set(mkSchedule());
    await store.delete('sched-1');
    expect(await store.get('sched-1')).toBeNull();
  });
});

describe('createIDBScheduleStore', () => {
  /** Fake Collection backed by a Map — same interface as IDB collection. */
  const mkCollection = () => {
    const map = new Map<string, Schedule>();
    return {
      async get(key: string) { return map.get(key) ?? null; },
      async set(key: string, value: Schedule) { map.set(key, value); },
      async delete(key: string) { map.delete(key); },
      async list() { return [...map.values()]; },
    };
  };

  it('persists via collection (set + get)', async () => {
    const col = mkCollection();
    const store = createIDBScheduleStore(col);
    await store.set(mkSchedule());
    expect(await store.get('sched-1')).not.toBeNull();
    // Verify it's in the underlying collection
    expect(await col.get('sched-1')).not.toBeNull();
  });

  it('getByRecipe searches the collection', async () => {
    const store = createIDBScheduleStore(mkCollection());
    await store.set(mkSchedule({ schedule_id: 's1', recipe_id: 'r1', publisher_id: 'p1' }));
    await store.set(mkSchedule({ schedule_id: 's2', recipe_id: 'r2', publisher_id: 'p2' }));
    expect((await store.getByRecipe('r2', 'p2'))?.schedule_id).toBe('s2');
    expect(await store.getByRecipe('r3', 'p3')).toBeNull();
  });

  it('delete removes from collection', async () => {
    const col = mkCollection();
    const store = createIDBScheduleStore(col);
    await store.set(mkSchedule());
    await store.delete('sched-1');
    expect(await col.get('sched-1')).toBeNull();
  });
});

describe('describeCron', () => {
  it('returns preset label for known expressions', () => {
    expect(describeCron('0 8 * * *')).toBe('Daily at 8:00 AM');
    expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes');
    expect(describeCron('0 8 * * 1-5')).toBe('Weekdays at 8:00 AM');
  });

  it('generates description for simple patterns', () => {
    expect(describeCron('0 17 * * *')).toBe('Daily at 5:00 PM');
    expect(describeCron('*/30 * * * *')).toBe('Every 30 minutes');
    expect(describeCron('0 */4 * * *')).toBe('Every 4 hours');
  });

  it('describes comma-separated hours', () => {
    // Non-preset expression with comma hours
    const result = describeCron('0 8,14 * * *');
    expect(result).toContain('8:00 AM');
    expect(result).toContain('2:00 PM');
  });

  it('describes weekday + time combos', () => {
    expect(describeCron('0 9 * * 1-5')).toBe('Weekdays at 9:00 AM');
    // Preset match returns preset label
    expect(describeCron('0 17 * * 5')).toBe('Weekly Friday 5:00 PM');
    // Non-preset weekday
    expect(describeCron('0 10 * * 3')).toBe('Wednesday at 10:00 AM');
  });

  it('describes day-of-month patterns', () => {
    expect(describeCron('0 9 1 * *')).toContain('1st of month');
    expect(describeCron('0 14 15 * *')).toContain('15th of month');
  });

  it('ordinals every day of the month, teens included', () => {
    // Was `${dom}th` for everything but the 1st, so a schedule on the 2nd read
    // "2th of month". The teens are the case a bare `n % 10` still gets wrong.
    const ord = (dom: number) => describeCron(`0 9 ${dom} * *`).split(' of month')[0];
    expect(ord(2)).toBe('2nd');
    expect(ord(3)).toBe('3rd');
    expect(ord(4)).toBe('4th');
    expect(ord(11)).toBe('11th');
    expect(ord(12)).toBe('12th');
    expect(ord(13)).toBe('13th');
    expect(ord(21)).toBe('21st');
    expect(ord(22)).toBe('22nd');
    expect(ord(23)).toBe('23rd');
    expect(ord(31)).toBe('31st');
    // Every day of a month renders as a distinct, well-formed ordinal.
    const all = Array.from({ length: 31 }, (_, i) => ord(i + 1));
    expect(new Set(all).size).toBe(31);
    for (const label of all) expect(label).toMatch(/^\d{1,2}(st|nd|rd|th)$/);
  });

  it('drops the redundant "Daily" when a day-of-month already sets the cadence', () => {
    expect(describeCron('0 14 15 * *')).toBe('15th of month at 2:00 PM');
    // …but a real day-of-week alongside one still carries meaning.
    expect(describeCron('0 9 15 * 3')).toBe('15th of month Wednesday at 9:00 AM');
  });

  it('names a non-numeric day-of-month set instead of suffixing it', () => {
    // `buildCronFromInterval('biweekly', …)` emits `1-7,15-21`, which used to
    // render as "1-7,15-21th of month".
    expect(describeCron(buildCronFromInterval('biweekly', '1', '9', '0')))
      .toBe('days 1-7,15-21 of month Monday at 9:00 AM');
  });

  it('returns raw expression for month-specific patterns', () => {
    // Non-standard month field falls through to raw
    expect(describeCron('0 8 * 3,6 *')).toBe('0 8 * 3,6 *');
  });

  it('handles PM hours', () => {
    expect(describeCron('0 13 * * *')).toBe('Daily at 1:00 PM');
    expect(describeCron('0 0 * * *')).toBe('Daily at 12:00 AM');
  });

  it('handles weekend pattern', () => {
    expect(describeCron('0 10 * * 0,6')).toContain('Weekends');
  });
});

describe('buildCronFromInterval', () => {
  it('daily at 9:00', () => {
    expect(buildCronFromInterval('daily', '', '9', '0')).toBe('0 9 * * *');
  });

  it('daily at 7:30', () => {
    expect(buildCronFromInterval('daily', '', '7', '30')).toBe('30 7 * * *');
  });

  it('weekly Monday at 9:00', () => {
    expect(buildCronFromInterval('weekly', '1', '9', '0')).toBe('0 9 * * 1');
  });

  it('weekly Friday at 5:15 PM', () => {
    expect(buildCronFromInterval('weekly', '5', '17', '15')).toBe('15 17 * * 5');
  });

  it('biweekly Wednesday at 8:00', () => {
    const cron = buildCronFromInterval('biweekly', '3', '8', '0');
    expect(cron).toBe('0 8 1-7,15-21 * 3');
  });

  it('monthly 15th at 9:00', () => {
    expect(buildCronFromInterval('monthly', '15', '9', '0')).toBe('0 9 15 * *');
  });

  it('monthly 1st at noon', () => {
    expect(buildCronFromInterval('monthly', '1', '12', '0')).toBe('0 12 1 * *');
  });

  it('round-trips through describeCron', () => {
    const cron = buildCronFromInterval('daily', '', '14', '30');
    expect(describeCron(cron)).toContain('2:30 PM');
  });
});

describe('CRON_PRESETS', () => {
  it('has groups for organization', () => {
    const groups = new Set(CRON_PRESETS.map((p) => p.group));
    expect(groups.size).toBeGreaterThanOrEqual(4);
    expect(groups.has('Frequent')).toBe(true);
    expect(groups.has('Daily')).toBe(true);
    expect(groups.has('Weekly')).toBe(true);
  });

  it('has at least 20 presets', () => {
    expect(CRON_PRESETS.length).toBeGreaterThanOrEqual(20);
  });

  it('all presets have valid 5-field expressions', () => {
    for (const p of CRON_PRESETS) {
      expect(p.expression.split(/\s+/)).toHaveLength(5);
      expect(p.label).toBeTruthy();
    }
  });

  it('gives every preset its own expression', () => {
    // `Last weekday 5:00 PM` shipped `0 17 * * 5`, byte-identical to
    // `Weekly Friday 5:00 PM`. Two labels for one expression is always a bug:
    // `describeCron` resolves a preset by expression and returns the FIRST
    // match, so the second label can never be displayed back to whoever chose
    // it — and here it also promised a cadence cron cannot express.
    const byExpression = new Map<string, string[]>();
    for (const p of CRON_PRESETS) {
      byExpression.set(p.expression, [...(byExpression.get(p.expression) ?? []), p.label]);
    }
    const collisions = [...byExpression].filter(([, labels]) => labels.length > 1);
    expect(collisions).toEqual([]);
  });

  it('makes every Monthly preset actually fire monthly, per the real matcher', () => {
    // The check the label alone cannot make. `0 17 * * 5` under a "Monthly"
    // label fires 52 times a year; counted here with the same `nextCronMatch`
    // the scheduler runs, not with a re-reading of the expression.
    const firesIn2026 = (expression: string): number => {
      const parts = expression.split(/\s+/);
      const end = new Date(2027, 0, 1).getTime();
      let cursor = new Date(2026, 0, 1).getTime();
      let fires = 0;
      for (;;) {
        const hit = nextCronMatch(parts, cursor);
        if (hit === null || hit >= end) return fires;
        fires++;
        cursor = hit + 60_000;
      }
    };
    for (const p of CRON_PRESETS.filter((c) => c.group === 'Monthly')) {
      expect(firesIn2026(p.expression), `${p.label} (${p.expression})`).toBe(12);
    }
    // The probe finds a known positive: the expression that used to sit in the
    // Monthly group is caught by this assertion.
    expect(firesIn2026('0 17 * * 5')).toBeGreaterThan(50);
    // 28 is chosen over 29/30/31 because only it exists in February.
    expect(firesIn2026('0 17 29 * *')).toBe(11);
    expect(firesIn2026('0 17 31 * *')).toBe(7);
  });
});

describe('formatNextFire', () => {
  // Use local-time constructors so the cron matcher (which uses local
  // getters) matches what we pass in.
  it('returns "Today at TIME" when next fire is later today', () => {
    const now = new Date(2026, 3, 14, 8, 0, 0).getTime();
    expect(formatNextFire('0 17 * * *', now)).toBe('Today at 5:00 PM');
  });

  it('returns "Tomorrow at TIME" when next fire is the next day', () => {
    // 18:00 now, cron fires 9:00 daily → tomorrow 9am
    const now = new Date(2026, 3, 14, 18, 0, 0).getTime();
    expect(formatNextFire('0 9 * * *', now)).toBe('Tomorrow at 9:00 AM');
  });

  it('returns weekday name when 2-6 days away', () => {
    // Monday 10am, cron Friday 5pm → "Friday at 5:00 PM"
    const now = new Date(2026, 3, 13, 10, 0, 0).getTime();
    expect(formatNextFire('0 17 * * 5', now)).toBe('Friday at 5:00 PM');
  });

  it('returns "Mmm DD at TIME" when 7+ days away', () => {
    // 2026-04-01 noon, cron = 1st of month 9am → next is May 1
    const now = new Date(2026, 3, 1, 12, 0, 0).getTime();
    expect(formatNextFire('0 9 1 * *', now)).toBe('May 1 at 9:00 AM');
  });

  it('formats noon and midnight correctly', () => {
    const now = new Date(2026, 3, 14, 8, 0, 0).getTime();
    expect(formatNextFire('0 12 * * *', now)).toBe('Today at 12:00 PM');
    expect(formatNextFire('0 0 * * *', now)).toBe('Tomorrow at 12:00 AM');
  });

  it('pads minutes to two digits', () => {
    const now = new Date(2026, 3, 14, 8, 0, 0).getTime();
    expect(formatNextFire('5 9 * * *', now)).toBe('Today at 9:05 AM');
  });

  it('returns null for malformed cron', () => {
    expect(formatNextFire('bad cron', Date.now())).toBeNull();
    expect(formatNextFire('0 9 * *', Date.now())).toBeNull();
  });

  it('returns null for never-firing cron (Feb 30)', () => {
    expect(formatNextFire('0 9 30 2 *', Date.now())).toBeNull();
  });

  it('defaults `now` to Date.now() when omitted', () => {
    // ⚠ **The comment here used to read "5-minute cron is guaranteed to fire in
    // the current calendar day", and that is FALSE.** Between 23:55 and
    // midnight the next `*/5` fire is 00:00 TOMORROW, so this test red for
    // roughly five minutes a day and passed the other 1435 — caught at exactly
    // 00:00 local during a session wrap-up, which is the only way a window that
    // narrow gets found.
    //
    // 🔑 The subject of this test is that the DEFAULT clock is consulted at
    // all — not which calendar day the fire lands on. Injecting a fixed `now`
    // would defeat it (that is the parameter it exists to leave out), so the
    // assertion accepts either day and keeps pinning the shape.
    const r = formatNextFire('*/5 * * * *');
    expect(r).not.toBeNull();
    expect(r).toMatch(/^(Today|Tomorrow) at \d{1,2}:\d{2} (AM|PM)$/);
  });
});

// ────────────────────────────────────────────────────────────────
// cronIntervalMs + validateCronInterval + cronMatchesAt
// ────────────────────────────────────────────────────────────────

import {
  cronIntervalMs, validateCronInterval, cronMatchesAt, nextCronMatch,
  MIN_CRON_INTERVAL_MS,
} from '../cron-interval.js';

describe('cronIntervalMs', () => {
  it('computes 5-minute interval for */5 * * * *', () => {
    expect(cronIntervalMs('*/5 * * * *')).toBe(5 * 60_000);
  });

  it('computes 1-hour interval for hourly cron', () => {
    expect(cronIntervalMs('0 * * * *')).toBe(60 * 60_000);
  });

  it('computes daily interval for 0 9 * * *', () => {
    expect(cronIntervalMs('0 9 * * *')).toBe(24 * 60 * 60_000);
  });

  it('returns Infinity for expressions with wrong field count', () => {
    expect(cronIntervalMs('0 9 * *')).toBe(Infinity);
    expect(cronIntervalMs('0 9 * * * *')).toBe(Infinity);
  });

  it('returns Infinity for never-firing expressions (Feb 30)', () => {
    expect(cronIntervalMs('0 9 30 2 *')).toBe(Infinity);
  });

  it('returns Infinity when no second firing occurs within the search window', () => {
    // Fires once a year on Jan 1 → interval search starts from 2026-01-01,
    // matches immediately, then needs to wait 365 days for the next firing.
    // Search window is 366 days, so it still finds it.
    expect(cronIntervalMs('0 0 1 1 *')).toBe(365 * 24 * 60 * 60_000);
  });
});

describe('validateCronInterval', () => {
  it('accepts intervals at or above the floor', () => {
    const r = validateCronInterval('*/5 * * * *');
    expect(r).toEqual({ valid: true, intervalMs: 5 * 60_000 });
  });

  it('rejects intervals shorter than the floor', () => {
    const r = validateCronInterval('*/2 * * * *');
    expect(r.valid).toBe(false);
    expect(r.intervalMs).toBe(2 * 60_000);
    expect(r.error).toContain('Interval too short');
    expect(r.error).toContain('2 minutes');
    expect(r.error).toContain('5 minutes');
  });

  it('uses singular "minute" when interval is exactly 1', () => {
    const r = validateCronInterval('* * * * *'); // every minute
    expect(r.error).toContain('1 minute '); // note: space after, not "1 minutes"
  });

  it('rejects malformed expressions with a parse error', () => {
    const r = validateCronInterval('not a cron');
    expect(r).toEqual({
      valid: false,
      intervalMs: 0,
      error: expect.stringContaining('Invalid cron expression'),
    });
  });

  it('rejects never-firing expressions', () => {
    const r = validateCronInterval('0 9 30 2 *');
    expect(r.valid).toBe(false);
    expect(r.intervalMs).toBe(Infinity);
    expect(r.error).toBe('Cron expression never fires');
  });

  it('honors a custom floor override', () => {
    // Self-hoster lowers the floor to 1 minute — every-minute cron now valid.
    const r = validateCronInterval('* * * * *', 60_000);
    expect(r).toEqual({ valid: true, intervalMs: 60_000 });
  });

  it('MIN_CRON_INTERVAL_MS is 5 minutes', () => {
    expect(MIN_CRON_INTERVAL_MS).toBe(5 * 60_000);
  });
});

describe('cronMatchesAt', () => {
  it('returns true when every field matches', () => {
    const d = new Date(2026, 3, 14, 9, 30, 0); // Apr 14, 09:30, Tuesday
    expect(cronMatchesAt(['30', '9', '14', '4', '2'], d)).toBe(true);
  });

  it('returns false when any field misses', () => {
    const d = new Date(2026, 3, 14, 9, 30, 0);
    expect(cronMatchesAt(['30', '9', '14', '4', '3'], d)).toBe(false);
  });

  it('matches wildcards (*) in every position', () => {
    const d = new Date(2026, 3, 14, 9, 30, 0);
    expect(cronMatchesAt(['*', '*', '*', '*', '*'], d)).toBe(true);
  });

  it('matches step fields (*/N)', () => {
    const d = new Date(2026, 3, 14, 0, 15, 0); // minute 15
    expect(cronMatchesAt(['*/5', '*', '*', '*', '*'], d)).toBe(true);
    expect(cronMatchesAt(['*/7', '*', '*', '*', '*'], d)).toBe(false);
  });

  it('rejects zero-step fields as never-matching (step must be > 0)', () => {
    const d = new Date(2026, 3, 14, 0, 0, 0);
    expect(cronMatchesAt(['*/0', '*', '*', '*', '*'], d)).toBe(false);
  });

  it('matches range fields (lo-hi)', () => {
    const d = new Date(2026, 3, 14, 9, 30, 0); // hour 9
    expect(cronMatchesAt(['*', '8-17', '*', '*', '*'], d)).toBe(true);
    // Hour 6 is outside the 8-17 range.
    const early = new Date(2026, 3, 14, 6, 30, 0);
    expect(cronMatchesAt(['*', '8-17', '*', '*', '*'], early)).toBe(false);
  });

  it('matches comma-separated values', () => {
    const d = new Date(2026, 3, 14, 14, 0, 0); // hour 14
    expect(cronMatchesAt(['0', '8,14,20', '*', '*', '*'], d)).toBe(true);
    const other = new Date(2026, 3, 14, 15, 0, 0);
    expect(cronMatchesAt(['0', '8,14,20', '*', '*', '*'], other)).toBe(false);
  });
});

describe('nextCronMatch', () => {
  it('returns null when no match within maxMinutes window', () => {
    // "Feb 30" never matches — nextCronMatch exhausts its window.
    expect(nextCronMatch(['0', '9', '30', '2', '*'], Date.UTC(2026, 0, 1))).toBeNull();
  });

  it('aligns to the start of the current minute', () => {
    // Start at 08:59:45 on Apr 14, 2026 — next match of "*/5 * * * *"
    // should be 09:00:00 (aligned to minute start).
    const start = new Date(2026, 3, 14, 8, 59, 45).getTime();
    const match = nextCronMatch(['*/5', '*', '*', '*', '*'], start);
    expect(match).not.toBeNull();
    const d = new Date(match!);
    expect(d.getSeconds()).toBe(0);
  });
});
