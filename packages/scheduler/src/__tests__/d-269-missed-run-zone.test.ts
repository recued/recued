/** D-269 — the missed-run measures read a schedule's cron in the zone the
 *  tick matches it in.
 *
 *  They read it host-local. On a UTC host a Hong Kong `0 7 * * *` then ran at
 *  07:00 HKT and again at 15:00 HKT as a "missed-run catch-up", every day:
 *  07:00 UTC looked like a cycle the 07:00 HKT run had not covered.
 *
 *  ⚠ Every case is written in a zone whose offset differs from this
 *  machine's, so it can tell "read in the schedule's zone" from "read
 *  host-local" wherever it runs. */
import { describe, expect, it } from 'vitest';
import { zoneOffsetMsAt } from '@recued/contracts';
import {
  buildBackfillMetadata,
  buildMissedRunReport,
  countMissedCycles,
  countOutstandingOccurrences,
  resolveMissedAction,
  scheduleCronZone,
  shouldCatchUp,
} from '../backfill.js';
import type { Schedule } from '../types.js';

const MIN = 60_000;
const JUNE = Date.UTC(2026, 5, 10);
const hostOffset = (ms: number): number => -new Date(ms).getTimezoneOffset() * MIN;
const ZONE = zoneOffsetMsAt(JUNE, 'Asia/Hong_Kong') !== hostOffset(JUNE)
  ? 'Asia/Hong_Kong'
  : 'America/New_York';

/** A wall-clock time in June 2026 in `ZONE`, as Unix ms (no DST change near). */
const inZone = (day: number, hour: number, minute = 0): number => {
  const naive = Date.UTC(2026, 5, day, hour, minute);
  return naive - zoneOffsetMsAt(naive, ZONE);
};

/** A daily 07:00 that last ran at 07:00 on June 10 in `ZONE`. */
const daily = (over: Partial<Schedule> = {}): Schedule => ({
  schedule_id: 's1',
  recipe_id: 'morning-brief',
  publisher_id: 'recued-core',
  cron_expression: '0 7 * * *',
  enabled: true,
  created_at: 0,
  last_run_at: inZone(10, 7),
  prev_run_at: inZone(9, 7),
  next_run_at: null,
  last_status: 'success',
  last_error: null,
  ...over,
});

describe('scheduleCronZone — the one rule', () => {
  it("takes the schedule's own zone, then the server's declared zone, then host-local", () => {
    expect(scheduleCronZone({ time_zone: 'Asia/Tokyo' }, 'Europe/Paris')).toBe('Asia/Tokyo');
    expect(scheduleCronZone({}, 'Europe/Paris')).toBe('Europe/Paris');
    expect(scheduleCronZone({}, undefined)).toBeUndefined();
  });

  it('⚠ passes over an empty string rather than handing it to Intl, which throws on it', () => {
    expect(scheduleCronZone({ time_zone: '' }, 'Europe/Paris')).toBe('Europe/Paris');
    expect(scheduleCronZone({ time_zone: '' }, '')).toBeUndefined();
  });
});

describe("shouldCatchUp reads the cron in the schedule's zone", () => {
  // Every minute between a 07:00 run and the next 07:00 in the zone. Nothing
  // is owed in that span; read host-local, the host's own 07:00 fell inside
  // it and a catch-up was owed from then on.
  const owedBeforeNextRun = (schedule: Schedule, serverTimeZone?: string): number => {
    let owed = 0;
    for (let t = inZone(10, 7, 1); t < inZone(11, 7); t += MIN) {
      if (shouldCatchUp(schedule, t, serverTimeZone)) owed += 1;
    }
    return owed;
  };

  it('⛔ a schedule carrying its own zone owes nothing before its next 07:00', () => {
    expect(owedBeforeNextRun(daily({ time_zone: ZONE }))).toBe(0);
  });

  it("⛔ a row from before D-269 reads the server's declared zone", () => {
    expect(owedBeforeNextRun(daily(), ZONE)).toBe(0);
  });

  it('still owes a catch-up once a 07:00 in the zone has gone by unrun', () => {
    expect(shouldCatchUp(daily({ time_zone: ZONE }), inZone(11, 9))).toBe(true);
  });
});

describe('after a 47-hour outage, ONE 07:00 was missed in the zone — any other zone saw two', () => {
  const now = inZone(12, 6);

  it('countOutstandingOccurrences counts where its zone says', () => {
    expect(countOutstandingOccurrences('0 7 * * *', inZone(10, 7), now, 10, ZONE).count).toBe(1);
  });

  it('⛔ Decide for me catches it up instead of skipping it as stale', () => {
    expect(resolveMissedAction(daily({ time_zone: ZONE }), now)).toBe('fire');
    expect(resolveMissedAction(daily(), now, ZONE)).toBe('fire');
  });

  it('⛔ Ask me treats it as a fresh miss, not a question, so the wake card stays empty', () => {
    const asking = daily({ missed_policy: 'ask' });
    expect(resolveMissedAction(asking, now, ZONE)).toBe('fire');
    expect(buildMissedRunReport([asking], now, ZONE).entries).toEqual([]);
  });

  it('⛔ the audit row counts nothing beyond the catch-up', () => {
    expect(countMissedCycles(daily(), now, ZONE)).toBe(0);
    expect(buildBackfillMetadata(daily(), now, ZONE).missed_cycles).toBe(0);
  });
});

describe("the wake card's count reads the zone too", () => {
  it('⛔ 71 hours out: two 07:00s missed in the zone, so one beyond the catch-up', () => {
    const asking = daily({ missed_policy: 'ask' });
    const report = buildMissedRunReport([asking], inZone(13, 6), ZONE);
    expect(report.entries.map((e) => e.missed_cycles)).toEqual([1]);
  });
});
