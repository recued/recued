/** D-266 — owner-declared missed-schedule policy.
 *
 *  The cases here are the ones the decision entry MEASURED, kept as
 *  assertions so the two bounds cannot silently collapse into one:
 *  `shouldCatchUp` answers "is the next regular cycle imminent?" and
 *  `countMissedCycles` answers "how stale is this?", and they only
 *  diverge once the gap exceeds roughly one interval — which is
 *  exactly where the old behaviour was wrong and where a regression
 *  would hide. */
import { describe, it, expect } from 'vitest';
import {
  resolveMissedAction,
  buildMissedRunReport,
  countMissedCycles,
} from '../backfill.js';
import type { Schedule } from '../types.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function mkSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    schedule_id: over.schedule_id ?? 'sched-a',
    recipe_id: over.recipe_id ?? 'r1',
    publisher_id: 'recued-core',
    cron_expression: over.cron_expression ?? '0 7 * * *',
    enabled: over.enabled ?? true,
    created_at: 0,
    last_run_at: over.last_run_at ?? null,
    prev_run_at: over.prev_run_at ?? null,
    next_run_at: over.next_run_at ?? null,
    last_status: over.last_status ?? 'success',
    last_error: null,
    ...over,
  };
}

/** A daily 07:00 schedule that last ran `daysAgo` days ago, with a
 *  clean one-day cadence sample behind it. `now` is 12:00 — far enough
 *  from 07:00 that the proximity bound always passes, so every case
 *  below turns on STALENESS alone. */
function daily(daysAgo: number, over: Partial<Schedule> = {}) {
  const now = Date.UTC(2026, 3, 22, 12, 0, 0);
  const last = now - daysAgo * DAY - 5 * HOUR; // 07:00 on that day
  return {
    now,
    schedule: mkSchedule({ last_run_at: last, prev_run_at: last - DAY, ...over }),
  };
}

describe('D-266 resolveMissedAction — the staleness bound', () => {
  it('the measured table, now counted from the CRON rather than a sampled cadence', () => {
    // Same table D-266 measured, re-derived by counting occurrences. Each
    // expectation is hand-checked against the cron, not read off the
    // function: "daily, a weekend" is Apr 18 / 19 / 20 at 07:00 = three
    // outstanding, one of which the catch-up fires ⇒ 2 beyond it.
    const at = (m: number, d: number, h: number, mi = 0) =>
      new Date(2026, m, d, h, mi, 0).getTime();
    const cases: [string, string, number, number, number][] = [
      ['hourly, 20 min late', '0 * * * *', at(3, 20, 11), at(3, 20, 11, 20), 0],
      ['daily, one day late', '0 7 * * *', at(3, 20, 7), at(3, 21, 12), 0],
      ['weekly, one day late', '0 9 * * 1', at(3, 20, 9), at(3, 28, 9), 0],
      ['daily, a weekend', '0 7 * * *', at(3, 17, 7), at(3, 20, 12), 2],
      ['daily, 30 days', '0 7 * * *', at(2, 21, 7), at(3, 20, 12), 29],
      ['weekly, 9 weeks', '0 9 * * 1', at(1, 16, 9), at(3, 20, 12), 8],
    ];
    for (const [label, cron, last, now, expected] of cases) {
      expect(
        countMissedCycles({ last_run_at: last, cron_expression: cron }, now),
        label,
      ).toBe(expected);
    }
    // ⚠ D-266's entry printed 30 for the 30-day row. 29 is the right
    // number for "cycles BEYOND the catch-up" — thirty occurrences are
    // outstanding and one of them fires. The entry's figure came from the
    // old arithmetic; every other row reproduces exactly.
  });

  it("'auto' still catches up a single missed cycle — the pre-D-266 case that was right", () => {
    const { now, schedule } = daily(1);
    expect(countMissedCycles(schedule, now)).toBe(0);
    expect(resolveMissedAction(schedule, now)).toBe('fire');
  });

  it("'auto' now SKIPS a properly stale miss, where it used to fire", () => {
    const { now, schedule } = daily(30);
    expect(countMissedCycles(schedule, now)).toBe(29);
    expect(resolveMissedAction(schedule, now)).toBe('skip');
  });

  it("'catch_up' fires however stale — the owner said always", () => {
    const { now, schedule } = daily(30, { missed_policy: 'catch_up' });
    expect(resolveMissedAction(schedule, now)).toBe('fire');
  });

  it("'skip' skips even a single fresh miss — the owner said never", () => {
    const { now, schedule } = daily(1, { missed_policy: 'skip' });
    expect(resolveMissedAction(schedule, now)).toBe('skip');
  });

  it("'ask' does NOT ask about a fresh miss — that is the anti-fatigue trigger", () => {
    const { now, schedule } = daily(1, { missed_policy: 'ask' });
    expect(resolveMissedAction(schedule, now)).toBe('fire');
  });

  it("'ask' asks once the miss is stale", () => {
    const { now, schedule } = daily(4, { missed_policy: 'ask' });
    expect(resolveMissedAction(schedule, now)).toBe('ask');
  });

  it('nothing outstanding ⇒ none, whatever the policy', () => {
    const now = Date.UTC(2026, 3, 22, 7, 30, 0); // 30 min after a 07:00 run
    for (const policy of ['auto', 'ask', 'skip', 'catch_up'] as const) {
      const schedule = mkSchedule({
        last_run_at: Date.UTC(2026, 3, 22, 7, 0, 0),
        prev_run_at: Date.UTC(2026, 3, 21, 7, 0, 0),
        missed_policy: policy,
      });
      expect(resolveMissedAction(schedule, now), policy).toBe('none');
    }
  });

  it('⛔ A SCHEDULE THAT HAS RUN ONCE IS MEASURABLE — the old fail-open is gone', () => {
    // This test used to assert the opposite: with no `prev_run_at` the
    // old measure returned 'unknown', which `resolveMissedAction` read as
    // NOT stale and fired. That fail-open existed only because the
    // measure could not tell — not because anyone decided a first outage
    // should go unasked. Counting occurrences needs one timestamp, so a
    // schedule down thirty days after a single run is now correctly
    // stale, and `'ask'` asks.
    const { now, schedule } = daily(30, { prev_run_at: null, missed_policy: 'ask' });
    expect(countMissedCycles(schedule, now)).toBe(29);
    expect(resolveMissedAction(schedule, now)).toBe('ask');
  });

  it('an unreadable cron is never called stale — nothing to count means nothing to claim', () => {
    const { now, schedule } = daily(30, { cron_expression: 'not a cron', missed_policy: 'ask' });
    expect(countMissedCycles(schedule, now)).toBe('unknown');
    // `shouldCatchUp` refuses a malformed cron first, so nothing is owed
    // at all — the staleness branch is never reached with one.
    expect(resolveMissedAction(schedule, now)).toBe('none');
  });

  it('the proximity bound still gates everything — an imminent regular cycle needs no catch-up', () => {
    // Every-5-minutes cron: the next cycle is always < BACKFILL_WINDOW_MIN away.
    const now = Date.UTC(2026, 3, 22, 12, 0, 0);
    const schedule = mkSchedule({
      cron_expression: '*/5 * * * *',
      last_run_at: now - 12 * 5 * MIN,
      prev_run_at: now - 13 * 5 * MIN,
      missed_policy: 'ask',
    });
    expect(countMissedCycles(schedule, now)).toBe(11); // stale by the count…
    expect(resolveMissedAction(schedule, now)).toBe('none'); // …but nothing is owed
  });
});

describe("D-266 resolveMissedAction — the owner's answer", () => {
  it("a live 'run' answer fires, outranking the standing policy", () => {
    const { now, schedule } = daily(30, { missed_policy: 'skip' });
    expect(resolveMissedAction(schedule, now)).toBe('skip');
    const answered = { ...schedule, missed_answer: { at: now - MIN, answer: 'run' as const } };
    expect(resolveMissedAction(answered, now)).toBe('fire');
  });

  it("⛔ a live 'skip' answer SETTLES it — or the same question comes back forever", () => {
    // A skip deliberately moves no timestamp (those are the cadence
    // sample), so without reading the answer the miss is still
    // outstanding on the next tick: the ask the owner just answered is
    // cancelled by answering and immediately raised again. Found by an
    // audit pass, not by a test — the suite asserted the ROW said
    // 'skipped' and never that the QUESTION was gone.
    const { now, schedule } = daily(30, { missed_policy: 'ask' });
    expect(resolveMissedAction(schedule, now)).toBe('ask');
    const answered = { ...schedule, missed_answer: { at: now - MIN, answer: 'skip' as const } };
    expect(resolveMissedAction(answered, now)).toBe('none');
  });

  it('an answer older than the last run is SPENT — self-expiry, no cleanup', () => {
    const { now, schedule } = daily(30, { missed_policy: 'ask' });
    for (const answer of ['run', 'skip'] as const) {
      const spent = {
        ...schedule,
        missed_answer: { at: schedule.last_run_at! - HOUR, answer },
      };
      expect(resolveMissedAction(spent, now), answer).toBe('ask');
    }
  });
});

describe('D-266 buildMissedRunReport', () => {
  const now = Date.UTC(2026, 3, 22, 12, 0, 0);
  const ask = (over: Partial<Schedule>) => mkSchedule({
    missed_policy: 'ask',
    last_run_at: now - 4 * DAY,
    prev_run_at: now - 5 * DAY,
    ...over,
  });

  it('lists only schedules actually waiting on an answer', () => {
    const report = buildMissedRunReport([
      ask({ schedule_id: 's1', recipe_id: 'brief' }),
      mkSchedule({ schedule_id: 's2', recipe_id: 'auto-one', last_run_at: now - 4 * DAY, prev_run_at: now - 5 * DAY }),
      ask({ schedule_id: 's3', recipe_id: 'paused', enabled: false }),
    ], now);
    expect(report.entries.map((entry) => entry.recipe_id)).toEqual(['brief']);
  });

  it('ONE entry and ONE run per recipe, even with two waiting schedules', () => {
    const report = buildMissedRunReport([
      ask({ schedule_id: 'morning', recipe_id: 'brief', last_run_at: now - 6 * DAY, prev_run_at: now - 7 * DAY }),
      ask({ schedule_id: 'evening', recipe_id: 'brief', last_run_at: now - 4 * DAY, prev_run_at: now - 5 * DAY }),
    ], now);
    expect(report.entries).toHaveLength(1);
    const [entry] = report.entries;
    expect(entry!.schedule_ids).toEqual(['evening', 'morning']);
    expect(entry!.run_schedule_id).toBe('evening'); // most recent — a brief supersedes a brief
    expect(entry!.missed_cycles).toBe(5); // the LARGEST across the pair: the outage, not the offer
  });

  it('the outage window spans the oldest waiting entry, and entries read longest-waiting first', () => {
    const report = buildMissedRunReport([
      ask({ schedule_id: 's1', recipe_id: 'recent', last_run_at: now - 3 * DAY, prev_run_at: now - 4 * DAY }),
      ask({ schedule_id: 's2', recipe_id: 'oldest', last_run_at: now - 9 * DAY, prev_run_at: now - 10 * DAY }),
    ], now);
    expect(report.entries.map((entry) => entry.recipe_id)).toEqual(['oldest', 'recent']);
    expect(report.outage_from).toBe(now - 9 * DAY);
    expect(report.outage_to).toBe(now);
  });

  it('is empty, not null, when nothing is waiting', () => {
    const report = buildMissedRunReport([mkSchedule({ last_run_at: null })], now);
    expect(report.entries).toEqual([]);
    expect(report.outage_from).toBeNull();
  });
});
