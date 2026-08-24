/** D-250 § D — housekeeping records what each TASK spent, on the cycle row it
 *  already writes.
 *
 *  ⛔ WHY IT NEEDED ITS OWN GRAIN. Recipe runs put usage on the run anchor and
 *  the gateway puts it on the seller rollup; housekeeping had neither, and its
 *  apparent backstop is not one — `housekeeping_state.tokens_consumed_today_*`
 *  is `estimate_per_record_tokens()` x pending rows, a BUDGET ESTIMATE the
 *  planner uses to decide whether to start a cycle, never a measurement. So the
 *  one execution mode built to run unattended was the one whose real cost
 *  nothing recorded.
 *
 *  🔑 THE MARKER IS SOUND HERE AND WAS REJECTED FOR RECIPE STEPS — same idea,
 *  opposite verdict, and concurrency is the whole difference. `prefetch.ts` runs
 *  prefetch steps in parallel, so "which step is in flight" has no single answer
 *  and per-step attribution would mis-bill silently; the scheduler's task loop
 *  is a plain sequential `await`. § 2 pins that: it drives two tasks that each
 *  spend, and asserts the totals did not bleed into each other.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HousekeepingStepResult, TokenUsageReport } from '@recued/contracts';

import { createHousekeepingConfigStore } from '../housekeeping/config-store.js';
import { createHousekeepingStateStore } from '../housekeeping/state-store.js';
import { createHousekeepingScheduler } from '../housekeeping/scheduler.js';
import {
  createHousekeepingTaskTokenMeter,
  type HousekeepingTaskTokenMeter,
} from '../housekeeping/task-token-meter.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../housekeeping/registry.js';
import type { EngineBusySignal } from '../housekeeping/engine-busy-signal.js';

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-250-hk-tokens-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const busy = (): EngineBusySignal => ({
  isExecuting: () => false,
  isDraining: () => false,
  isBusy: () => false,
  lastIdleTransitionAt: () => null,
  poll: () => undefined,
});

const ctx = (
  now: () => number,
  taskTokenMeter?: HousekeepingTaskTokenMeter,
): HousekeepingContext => ({
  db,
  bus: {
    emit: () => undefined,
    subscribe: () => () => undefined,
    dispose: () => undefined,
  } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now,
  emitAuditRow: () => undefined,
  ...(taskTokenMeter ? { taskTokenMeter } : {}),
});

const report = (total: number): TokenUsageReport => ({
  input_tokens: Math.round(total * 0.8),
  output_tokens: total - Math.round(total * 0.8),
  total_tokens: total,
  provider_calls: 1,
});

/** A task that "calls a provider" the way the real ones do — through the meter
 *  the llm callables record into, not by returning a number. */
const spendingTask = (
  id: string,
  meter: HousekeepingTaskTokenMeter,
  spends: readonly number[],
): HousekeepingTaskInstance => ({
  meta: { id, description: id, interruptible: true, kind: 'core' },
  async step(): Promise<HousekeepingStepResult> {
    for (const total of spends) meter.record(report(total));
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});

const quietTask = (id: string): HousekeepingTaskInstance => ({
  meta: { id, description: id, interruptible: true, kind: 'core' },
  async step(): Promise<HousekeepingStepResult> {
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});

const run = async (
  meter: HousekeepingTaskTokenMeter | undefined,
  tasks: readonly HousekeepingTaskInstance[],
) => {
  const config = createHousekeepingConfigStore(db);
  const state = createHousekeepingStateStore(db);
  config.write({ preset: 'balanced' }, NOW);
  let clock = NOW;
  const sched = createHousekeepingScheduler({
    ctx: ctx(() => clock++, meter),
    config,
    state,
    busy: busy(),
    registry: () => [...tasks],
  });
  return sched.runOnce();
};

// ────────────────────────────────────────────────────────────────
// 1. THE RECORD
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — the cycle row carries per-task spend', () => {
  it('⛔⛔ A SPENDING TASK REPORTS ITS TOKENS on the cycle result', async () => {
    const meter = createHousekeepingTaskTokenMeter();
    const result = await run(meter, [spendingTask('summarize', meter, [150])]);
    const row = result.per_task.find((t) => t.task_id === 'summarize');
    expect(row?.tokens?.total_tokens).toBe(150);
    expect(row?.tokens?.provider_calls).toBe(1);
  });

  it('several calls inside one task AGGREGATE, with the call count', async () => {
    const meter = createHousekeepingTaskTokenMeter();
    const result = await run(meter, [spendingTask('enrich', meter, [100, 250, 50])]);
    const row = result.per_task.find((t) => t.task_id === 'enrich');
    expect(row?.tokens?.total_tokens).toBe(400);
    expect(row?.tokens?.provider_calls).toBe(3);
  });

  it('⛔ A TASK THAT SPENT NOTHING IS ABSENT, NOT ZERO', async () => {
    // Most housekeeping tasks are deterministic and spend nothing at all —
    // stamping a zero on every one of them would cost bytes on a log that
    // evicts oldest-first, and would make "no AI ran" indistinguishable from
    // "AI ran and cost nothing".
    const meter = createHousekeepingTaskTokenMeter();
    const result = await run(meter, [quietTask('prune')]);
    const row = result.per_task.find((t) => t.task_id === 'prune');
    expect(row).toBeDefined();
    expect(row?.tokens).toBeUndefined();
  });

  it('an AI-less boot wires no meter and the cycle still runs', async () => {
    // `taskTokenMeter` is optional on the ctx: a db-less or AI-less boot has no
    // llm callables at all, and must not fail a cycle over telemetry.
    const result = await run(undefined, [quietTask('prune')]);
    expect(result.tasks_complete).toBe(1);
    expect(result.per_task[0]?.tokens).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 2. ATTRIBUTION — the property the sequential loop buys
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — spend lands on the task that spent it', () => {
  it('⛔⛔ TWO SPENDING TASKS DO NOT BLEED INTO EACH OTHER', async () => {
    const meter = createHousekeepingTaskTokenMeter();
    const result = await run(meter, [
      spendingTask('first', meter, [100]),
      spendingTask('second', meter, [900]),
    ]);
    expect(
      result.per_task.find((t) => t.task_id === 'first')?.tokens?.total_tokens,
    ).toBe(100);
    expect(
      result.per_task.find((t) => t.task_id === 'second')?.tokens?.total_tokens,
    ).toBe(900);
  });

  it('a quiet task between two spenders stays absent', async () => {
    const meter = createHousekeepingTaskTokenMeter();
    const result = await run(meter, [
      spendingTask('a', meter, [10]),
      quietTask('b'),
      spendingTask('c', meter, [20]),
    ]);
    expect(result.per_task.find((t) => t.task_id === 'b')?.tokens).toBeUndefined();
    expect(result.per_task.find((t) => t.task_id === 'c')?.tokens?.total_tokens).toBe(20);
  });
});

// ────────────────────────────────────────────────────────────────
// 3. THE METER'S OWN RULES
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — the task token meter', () => {
  it('⛔ A CALL WITH NO WINDOW OPEN IS DROPPED', () => {
    // It belongs to no task, and attributing it to whichever task ran last
    // would be a confident wrong number.
    const meter = createHousekeepingTaskTokenMeter();
    meter.record(report(500));
    meter.begin('t');
    expect(meter.take('t')).toBeUndefined();
  });

  it('⛔ TAKE CHECKS THE ID — a drifted begin/take pair yields nothing', () => {
    const meter = createHousekeepingTaskTokenMeter();
    meter.begin('a');
    meter.record(report(50));
    // Asking for a different task must NOT hand over `a`'s spend.
    expect(meter.take('b')).toBeUndefined();
    // And the window is gone, so a later take cannot resurrect it either.
    expect(meter.take('a')).toBeUndefined();
  });

  it('an unclosed window is discarded by the next begin, never carried forward', () => {
    // The previous task threw between begin and take. Its tokens are real but
    // the row that would have carried them was never written; billing the NEXT
    // task for them is worse than losing them.
    const meter = createHousekeepingTaskTokenMeter();
    meter.begin('threw');
    meter.record(report(999));
    meter.begin('next');
    meter.record(report(1));
    expect(meter.take('next')?.total_tokens).toBe(1);
  });

  it('take is one-shot', () => {
    const meter = createHousekeepingTaskTokenMeter();
    meter.begin('t');
    meter.record(report(7));
    expect(meter.take('t')?.total_tokens).toBe(7);
    expect(meter.take('t')).toBeUndefined();
  });
});
