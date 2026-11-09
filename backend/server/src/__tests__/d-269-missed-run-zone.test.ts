/** D-269 — the scheduler's missed-run decisions read a schedule's cron in
 *  the zone it fires in.
 *
 *  They read it host-local. Driven through `selectRecurringScheduleTick` on
 *  26.11.3's code: on a UTC host a Hong Kong `0 7 * * *` ran at 07:00 and
 *  again at 15:00 HKT as a "missed-run catch-up", every day — six runs in
 *  three days. That is every VPS whose owner is not on UTC, and a laptop
 *  whose own zone changed.
 *
 *  ⚠ Written in a zone whose offset differs from this machine's, so each
 *  case tells the schedule's zone from the host's wherever it runs. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { zoneOffsetMsAt } from '@recued/contracts';
import type { MissedRunReport } from '@recued/scheduler';
import { createScheduleStore } from '../schedule-store.js';
import { createScheduler } from '../scheduler.js';
import { answerMissed, listSchedules, missedRuns } from '../schedule-handler.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

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

let db: Database.Database;
let store: ReturnType<typeof createScheduleStore>;

beforeEach(() => {
  db = new Database(':memory:');
  store = createScheduleStore(db);
});
afterEach(() => { db.close(); });

/** A daily 07:00 that last ran at 07:00 on June 10 in `ZONE`. Without a
 *  `time_zone` the row predates D-269 and the server's declared zone applies. */
const seed = (over: Record<string, unknown> = {}) => store.set({
  schedule_id: 's1',
  recipe_id: 'morning-brief',
  publisher_id: 'recued-core',
  cron_expression: '0 7 * * *',
  enabled: true,
  created_at: 0,
  last_run_at: inZone(10, 7),
  prev_run_at: inZone(9, 7),
  next_run_at: inZone(11, 7),
  last_status: 'success',
  last_error: null,
  ...over,
} as never);

interface Fire { trigger_source?: string; backfill?: { missed_cycles: number | 'unknown' } }

const schedulerAt = (
  clock: { now: number },
  fires: Fire[],
  extra: {
    serverTimeZone?: () => string | undefined;
    onMissedRuns?: (report: MissedRunReport) => void;
  } = {},
) => createScheduler({
  store,
  executeDeps: {
    recipeStore: { get: (id: string) => ({ recipe_id: id, version: 1, steps: [] }), size: () => 1 },
    executorConfig: { manifests: { get: () => undefined, size: () => 0 }, vault: {} },
    baseVault: {}, instanceId: 'server-test-1',
  } as unknown as ExecuteHandlerDeps,
  now: () => clock.now,
  execute: (async (_d: unknown, req: Fire) => {
    fires.push({
      ...(req.trigger_source !== undefined ? { trigger_source: req.trigger_source } : {}),
      ...(req.backfill !== undefined ? { backfill: req.backfill } : {}),
    });
    return { success: true, steps: [], errors: [] };
  }) as never,
  ...extra,
});

describe('the tick, every quarter hour through the day after a 07:00 run', () => {
  // Quarter hours reach every real zone's 07:00: offsets are whole quarters.
  const walk = async (serverTimeZone?: string): Promise<Fire[]> => {
    const clock = { now: inZone(10, 7, 15) };
    const fires: Fire[] = [];
    const scheduler = schedulerAt(clock, fires,
      serverTimeZone !== undefined ? { serverTimeZone: () => serverTimeZone } : {});
    for (; clock.now <= inZone(11, 7); clock.now += 15 * MIN) await scheduler.tick();
    return fires;
  };

  it("⛔ runs once, at 07:00 in the schedule's own zone — no catch-up at the host's 07:00", async () => {
    seed({ time_zone: ZONE });
    expect(await walk()).toEqual([{ trigger_source: 'schedule' }]);
  });

  it("⛔ a row from before D-269 does the same in the server's declared zone", async () => {
    seed();
    expect(await walk(ZONE)).toEqual([{ trigger_source: 'schedule' }]);
  });
});

describe('after a 47-hour outage, ONE 07:00 was missed in the zone — any other zone saw two', () => {
  it('⛔ Decide for me catches it up instead of skipping it as stale, and the audit counts no more', async () => {
    seed();
    const fires: Fire[] = [];
    await schedulerAt({ now: inZone(12, 6) }, fires, { serverTimeZone: () => ZONE }).tick();
    expect(fires).toEqual([{ trigger_source: 'backfill', backfill: expect.objectContaining({ missed_cycles: 0 }) }]);
  });

  it("⛔ Skip it records one missed run, not two", async () => {
    seed({ missed_policy: 'skip' });
    await schedulerAt({ now: inZone(12, 6) }, [], { serverTimeZone: () => ZONE }).tick();
    expect(store.get('s1')!.last_error).toBe('Missed 1 run — skipped, waiting for the next regular cycle.');
  });
});

describe('the wake card reads the zone', () => {
  it("⛔ the tick's report: 71 hours out, two 07:00s missed in the zone, one beyond the catch-up", async () => {
    seed({ missed_policy: 'ask' });
    const seen: MissedRunReport[] = [];
    await schedulerAt({ now: inZone(13, 6) }, [], {
      serverTimeZone: () => ZONE,
      onMissedRuns: (report) => { seen.push(report); },
    }).tick();
    expect(seen.at(-1)!.entries.map((e) => e.missed_cycles)).toEqual([1]);
  });

  it('⛔ schedules.missed counts the same', () => {
    seed({ missed_policy: 'ask' });
    const report = missedRuns({ store, now: () => inZone(13, 6), serverTimeZone: () => ZONE });
    expect(report.entries.map((e) => e.missed_cycles)).toEqual([1]);
  });

  it("⛔ answering 'run' grants nothing when the only miss is a fresh one", () => {
    seed({ missed_policy: 'ask' });
    const answered = answerMissed(
      { store, now: () => inZone(12, 6), serverTimeZone: () => ZONE },
      { answer: 'run' },
    );
    expect(answered.ran).toEqual([]);
  });

  it('⛔ the schedule list shows the same count', () => {
    seed();
    const deps = { store, now: () => inZone(12, 6), serverTimeZone: () => ZONE };
    const [row] = listSchedules(deps as never, {}).schedules;
    expect(row!.missed_cycles).toBe(0);
  });
});

/** ⛔ Three ways one cron minute ran twice, all through the tick's `===` dedupe:
 *  a DST fall-back repeating a local hour (`30 1 * * *` matched both 01:30s), a
 *  clock set back repeating minutes that already ran, and an overlapping tick
 *  coming back for a minute a catch-up had already covered. */
describe('the tick does not run a minute again', () => {
  const NY = 'America/New_York';
  const at = (iso: string): number => Date.parse(iso);

  it('⛔ a daily 01:30 runs once on the day New York plays 01:00–01:59 twice — no repeat, no catch-up of it', async () => {
    store.set({
      schedule_id: 's1', recipe_id: 'morning-brief', publisher_id: 'recued-core', cron_expression: '30 1 * * *',
      time_zone: NY, enabled: true, created_at: 0, last_run_at: at('2026-10-31T05:30:00Z'),
      prev_run_at: null, next_run_at: at('2026-11-01T05:30:00Z'), last_status: 'success', last_error: null,
    } as never);
    const clock = { now: 0 };
    const fires: Fire[] = [];
    const scheduler = schedulerAt(clock, fires);
    // Every minute around both 01:30s, then half-hourly, where a catch-up of the
    // repeat would show. (Each tick scans across the transition day, whose offset
    // cannot be cached, so a minute-by-minute walk of seven hours is slow.)
    const ticks = [
      ...[28, 29, 30, 31, 32].map((m) => at(`2026-11-01T05:${m}:00Z`)),
      ...[28, 29, 30, 31, 32].map((m) => at(`2026-11-01T06:${m}:00Z`)),
      ...Array.from({ length: 11 }, (_, i) => at('2026-11-01T07:00:00Z') + i * 30 * MIN),
    ];
    for (const t of ticks) { clock.now = t; await scheduler.tick(); }
    expect(fires).toEqual([{ trigger_source: 'schedule' }]);
    expect(store.get('s1')!.next_run_at).toBe(at('2026-11-02T06:30:00Z'));
  });

  it('⛔ minutes a clock set back repeats do not run again; the next new one does', async () => {
    store.set({
      schedule_id: 's1', recipe_id: 'morning-brief', publisher_id: 'recued-core', cron_expression: '0 * * * *',
      time_zone: 'UTC', enabled: true, created_at: 0, last_run_at: at('2026-06-10T10:00:00Z'),
      prev_run_at: null, next_run_at: at('2026-06-10T11:00:00Z'), last_status: 'success', last_error: null,
    } as never);
    const clock = { now: at('2026-06-10T09:00:00Z') };   // set back past two runs
    const fires: Fire[] = [];
    const scheduler = schedulerAt(clock, fires);
    await scheduler.tick();                               // 09:00 again
    clock.now = at('2026-06-10T10:00:00Z');
    await scheduler.tick();                               // 10:00 again
    expect(fires).toEqual([]);
    clock.now = at('2026-06-10T11:00:00Z');
    await scheduler.tick();
    expect(fires).toEqual([{ trigger_source: 'schedule' }]);
  });
});
