/** D-266 — missed-schedule policy, end to end through the store, the
 *  scheduler tick and the two rpc handlers.
 *
 *  The properties worth defending here are the ones a unit test of
 *  `resolveMissedAction` cannot see, because they are about what the
 *  tick WRITES:
 *
 *   1. **A skip must not stamp `last_run_at`.** `updateRun` rolls the
 *      prior `last_run_at` into `prev_run_at` whenever the patch
 *      carries one, and those two timestamps ARE the cadence sample
 *      the staleness bound reads. Recording a skip as if it were a run
 *      would teach a daily schedule that its interval is the length of
 *      the outage — and the bound would go blind exactly where it
 *      matters most.
 *   2. **`Ask me` must write NOTHING.** The card is recomputed from
 *      these rows; any write that resolves the miss would make the
 *      question disappear without anyone answering it.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveMissedAction } from '@recued/scheduler';
import { createScheduleStore } from '../schedule-store.js';
import { createScheduler } from '../scheduler.js';
import {
  createSchedule, updateSchedule, missedRuns, answerMissed, listSchedules,
  type ScheduleHandlerDeps,
} from '../schedule-handler.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';

const DAY = 24 * 60 * 60 * 1000;
/** Wed 2026-04-15 12:00:37 local — five hours past a 07:00 daily cron,
 *  so the next-occurrence-proximity bound always passes and every case
 *  below turns on the owner's policy alone.
 *
 *  ⚠ THE :37 IS LOAD-BEARING. A catch-up stamps `last_run_at` with
 *  the TICK MINUTE, so a `now` sitting exactly on a minute boundary
 *  makes the grant and the fire compare EQUAL and hides a live
 *  double-fire: a grant taken mid-minute outlived the fire it
 *  authorised. An on-the-minute clock passed this suite while the bug
 *  was in. */
const NOW = new Date(2026, 3, 15, 12, 0, 37).getTime();
const at = (daysAgo: number) => new Date(2026, 3, 15 - daysAgo, 7, 0, 0).getTime();

let db: Database.Database;
let store: ReturnType<typeof createScheduleStore>;

const seed = (over: Record<string, unknown>) => store.set({
  schedule_id: 's1',
  recipe_id: 'morning-brief',
  publisher_id: 'recued-core',
  cron_expression: '0 7 * * *',
  enabled: true,
  created_at: 0,
  last_run_at: at(30),
  prev_run_at: at(31),
  next_run_at: null,
  last_status: 'success',
  last_error: null,
  ...over,
} as never);

beforeEach(() => {
  db = new Database(':memory:');
  store = createScheduleStore(db);
});
afterEach(() => { db.close(); });

const mkExecuteDeps = (fired: string[]): ExecuteHandlerDeps => ({
  recipeStore: { get: (id: string) => ({ recipe_id: id, version: 1, steps: [] }), size: () => 1 },
  executorConfig: { manifests: { get: () => undefined, size: () => 0 }, vault: {} },
  baseVault: {},
  instanceId: 'server-test-1',
  ...{ fired },
} as unknown as ExecuteHandlerDeps);

const schedulerWith = (fired: string[]) => createScheduler({
  store,
  executeDeps: mkExecuteDeps(fired),
  now: () => NOW,
  execute: (async (_d: unknown, req: { recipe_id: string }) => {
    fired.push(req.recipe_id);
    return { success: true, steps: [], errors: [] };
  }) as never,
});

const handlerDeps = (): ScheduleHandlerDeps => ({
  store,
  instanceId: 'server-test-1',
  now: () => NOW,
  recipeStore: {
    get: (id: string) => (id === 'morning-brief'
      ? { recipe_id: id, version: 1, ttl: 0, steps: [], variables: {}, metadata: { name: 'Morning brief' } }
      : null),
  },
} as unknown as ScheduleHandlerDeps);

describe('D-266 — the scheduler tick', () => {
  it("'catch_up' fires a stale miss that 'auto' would now skip", async () => {
    const fired: string[] = [];
    seed({ missed_policy: 'catch_up' });
    await schedulerWith(fired).tick();
    expect(fired).toEqual(['morning-brief']);
  });

  it("'auto' skips a 30-day-stale miss and SAYS SO, without stamping the timestamps", async () => {
    const fired: string[] = [];
    seed({}); // absent policy ⇒ 'auto'
    await schedulerWith(fired).tick();

    expect(fired).toEqual([]);
    const after = store.get('s1')!;
    expect(after.last_status).toBe('skipped');
    expect(after.last_error).toMatch(/skipped/i);
    expect(after.last_error).toMatch(/30/); // the count is the record of the outage
    // ⛔ THE PROPERTY: the cadence sample is untouched. Stamping the skip
    // would make prev→last read as a 30-day interval.
    expect(after.last_run_at).toBe(at(30));
    expect(after.prev_run_at).toBe(at(31));
    // Still armed — the next regular cycle runs normally.
    expect(after.enabled).toBe(true);
  });

  it("'auto' still catches up a SINGLE missed cycle — the case the old rule got right", async () => {
    const fired: string[] = [];
    seed({ last_run_at: at(1), prev_run_at: at(2) });
    await schedulerWith(fired).tick();
    expect(fired).toEqual(['morning-brief']);
  });

  it("'ask' leaves the row completely untouched — no answer, no resolution", async () => {
    const fired: string[] = [];
    seed({ missed_policy: 'ask' });
    const before = store.get('s1')!;
    await schedulerWith(fired).tick();

    expect(fired).toEqual([]);
    expect(store.get('s1')).toEqual(before);
  });

  it("'skip' does not rewrite the row on every subsequent tick", async () => {
    const fired: string[] = [];
    seed({ missed_policy: 'skip' });
    await schedulerWith(fired).tick();
    const afterFirst = store.get('s1')!;
    await schedulerWith(fired).tick();
    expect(store.get('s1')).toEqual(afterFirst);
  });
});

describe('D-266 — the rpc surface', () => {
  it('round-trips the policy through create, and rejects one outside the list', () => {
    const deps = handlerDeps();
    const { schedule } = createSchedule(deps, {
      recipe_id: 'morning-brief', cron_expression: '0 7 * * *', missed_policy: 'ask',
    });
    expect(schedule.missed_policy).toBe('ask');
    expect(store.get(schedule.schedule_id)!.missed_policy).toBe('ask');

    // ⛔ Rejects rather than falling back to the default: a policy is the
    // owner saying "do not decide this for me", so quietly substituting
    // 'auto' would answer the one question they asked us not to answer.
    expect(() => createSchedule(deps, {
      recipe_id: 'morning-brief', cron_expression: '0 7 * * *', missed_policy: 'adaptive',
    })).toThrow(/missed_policy/);
  });

  it('changes the policy in place, leaving the rest of the schedule alone', () => {
    const deps = handlerDeps();
    seed({ missed_policy: 'auto' });
    const { schedule } = updateSchedule(deps, 's1', { missed_policy: 'ask' });
    expect(schedule.missed_policy).toBe('ask');
    expect(schedule.cron_expression).toBe('0 7 * * *');
    expect(schedule.last_run_at).toBe(at(30));
  });

  it('reports only what is waiting, named, with the outage window', () => {
    seed({ missed_policy: 'ask' });
    const report = missedRuns(handlerDeps());
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      recipe_id: 'morning-brief',
      recipe_name: 'Morning brief',
      schedule_ids: ['s1'],
      missed_cycles: 29,
    });
    expect(report.outage_from).toBe(at(30));
    expect(report.outage_to).toBe(NOW);
  });

  it("'run' grants one catch-up that the NEXT TICK fires through the backfill path", async () => {
    seed({ missed_policy: 'ask' });
    const result = answerMissed(handlerDeps(), { answer: 'run' });
    expect(result).toEqual({ ran: ['s1'], skipped: [] });
    // Floored to the tick minute, which is what the fire will stamp.
    expect(store.get('s1')!.missed_answer)
      .toEqual({ at: NOW - (NOW % 60_000), answer: 'run' });

    const fired: string[] = [];
    await schedulerWith(fired).tick();
    expect(fired).toEqual(['morning-brief']);

    // 🔑 The grant is now SPENT by construction: the fire moved
    // last_run_at past it, so nothing has to clean it up.
    const after = store.get('s1')!;
    expect(after.missed_answer!.at).toBeLessThanOrEqual(after.last_run_at!);
    expect(missedRuns(handlerDeps()).entries).toEqual([]);
  });

  it("⛔ 'skip' CLEARS THE CARD — not just the row's status", async () => {
    seed({ missed_policy: 'ask' });
    expect(answerMissed(handlerDeps(), { answer: 'skip' })).toEqual({ ran: [], skipped: ['s1'] });

    const fired: string[] = [];
    await schedulerWith(fired).tick();
    expect(fired).toEqual([]);
    expect(store.get('s1')!.last_status).toBe('skipped');

    // ⛔ THE ASSERTION THIS TEST WAS MISSING, AND AN AUDIT FOUND THE BUG
    // IT WOULD HAVE CAUGHT. Checking `last_status` proves the row shows a
    // skip; it says nothing about whether the QUESTION is gone. It was
    // not: a skip moves no timestamp (those are the cadence sample), so
    // the miss stayed outstanding, and the ask the owner had just
    // answered was raised again on the very next tick. Forever.
    expect(missedRuns(handlerDeps()).entries).toEqual([]);

    // …and the timestamps are still honest.
    expect(store.get('s1')!.last_run_at).toBe(at(30));
    expect(store.get('s1')!.prev_run_at).toBe(at(31));
  });

  it("⛔ 'run' clears the card for the SIBLINGS it superseded too", async () => {
    seed({ schedule_id: 'morning', missed_policy: 'ask', last_run_at: at(6), prev_run_at: at(7) });
    seed({ schedule_id: 'evening', missed_policy: 'ask', last_run_at: at(4), prev_run_at: at(5) });
    answerMissed(handlerDeps(), { answer: 'run' });

    // The superseded sibling is answered too — otherwise the recipe keeps
    // appearing on the card through a schedule the owner already settled.
    expect(missedRuns(handlerDeps()).entries).toEqual([]);
    expect(store.get('morning')!.missed_answer!.answer).toBe('skip');
    expect(store.get('evening')!.missed_answer!.answer).toBe('run');
  });

  it('an answered miss stops being answered once the schedule runs again', () => {
    seed({ missed_policy: 'ask' });
    answerMissed(handlerDeps(), { answer: 'skip' });
    expect(missedRuns(handlerDeps()).entries).toEqual([]);

    // Two ordinary runs later the schedule is back on a clean daily
    // cadence and the answer is long past `last_run_at`…
    store.updateRun('s1', { last_run_at: NOW + DAY });
    store.updateRun('s1', { last_run_at: NOW + 2 * DAY });
    // …so a fresh outage asks again rather than staying settled forever.
    const later = NOW + 40 * DAY;
    expect(missedRuns({ ...handlerDeps(), now: () => later }).entries).toHaveLength(1);
  });

  it('⛔ THE OUTAGE-SPANNING SAMPLE NO LONGER FOOLS THE MEASURE', () => {
    // This test used to PIN the opposite as a known limit, and it is kept
    // pointing at the same scenario so the regression has a home.
    //
    // The old measure sampled the cadence from `prev_run_at →
    // last_run_at`, and after a real outage that pair SPANS the outage —
    // nothing ran in between. A daily schedule down thirty days and then
    // run once recorded a ~month-wide "interval", so the NEXT judgement
    // read a 34-day gap as under one cycle and called it fresh: a run the
    // owner asked to be consulted about fired silently.
    seed({ missed_policy: 'ask' });
    store.updateRun('s1', { last_run_at: NOW }); // the first run back
    const after = store.get('s1')!;

    // The poisoned pair is still on the row — it is a record of two run
    // times, and nothing reads it as a cadence any more.
    expect(after.last_run_at! - after.prev_run_at!).toBeGreaterThan(29 * DAY);

    // Counting cron occurrences does not care what happened before
    // `last_run_at`, so a 34-day gap is 33 missed daily runs and stale.
    const later = NOW + 34 * DAY;
    expect(missedRuns({ ...handlerDeps(), now: () => later }).entries).toHaveLength(1);
    expect(resolveMissedAction(store.get('s1')!, later)).toBe('ask');
  });

  it('answers ONE run per recipe when two of its schedules are waiting', async () => {
    seed({ schedule_id: 'morning', missed_policy: 'ask', last_run_at: at(6), prev_run_at: at(7) });
    seed({ schedule_id: 'evening', missed_policy: 'ask', last_run_at: at(4), prev_run_at: at(5) });

    const report = missedRuns(handlerDeps());
    expect(report.entries).toHaveLength(1); // one LINE, not two

    const result = answerMissed(handlerDeps(), { answer: 'run' });
    expect(result.ran).toEqual(['evening']); // the most recent — a brief supersedes a brief
    expect(result.skipped).toEqual(['morning']);

    const fired: string[] = [];
    await schedulerWith(fired).tick();
    expect(fired).toEqual(['morning-brief']); // ONE run, not two
  });

  it('ignores ids naming nothing outstanding rather than rejecting them', () => {
    seed({ missed_policy: 'ask' });
    expect(answerMissed(handlerDeps(), { answer: 'skip', recipe_ids: ['gone'] }))
      .toEqual({ ran: [], skipped: [] });
    expect(missedRuns(handlerDeps()).entries).toHaveLength(1); // still waiting
  });

  it('rejects an answer that is neither run nor skip', () => {
    expect(() => answerMissed(handlerDeps(), { answer: 'maybe' })).toThrow(/run/);
  });
});

describe('D-266 — the forensic surface on `schedules.list`', () => {
  it('⛔ carries `prev_run_at`, which was riding the spread undeclared', () => {
    seed({});
    const [row] = listSchedules(handlerDeps(), {}).schedules;
    // Accepted onto the wire by the row spread long before any client
    // could rely on it. Declared now that a surface reads it.
    expect(row!.prev_run_at).toBe(at(31));
    expect(row!.last_run_at).toBe(at(30));
  });

  it('counts the missed runs for a schedule that is BEHIND', () => {
    seed({ next_run_at: at(29) }); // due 29 days ago
    const [row] = listSchedules(handlerDeps(), {}).schedules;
    expect(row!.missed_cycles).toBe(29);
  });

  it('⛔ OMITS the count for a schedule that is NOT behind — the scan stays off a hot read', () => {
    // `countMissedCycles` walks the window a minute at a time, so running
    // it per schedule per list is a real cost on a read the UI makes
    // constantly. Absent means "not behind", never "unknown".
    seed({ next_run_at: NOW + DAY });
    const [row] = listSchedules(handlerDeps(), {}).schedules;
    expect(row!.missed_cycles).toBeUndefined();
  });

  it('omits it for a PAUSED schedule, however old its slot', () => {
    seed({ enabled: false, next_run_at: at(29) });
    const [row] = listSchedules(handlerDeps(), {}).schedules;
    expect(row!.missed_cycles).toBeUndefined();
  });
});
