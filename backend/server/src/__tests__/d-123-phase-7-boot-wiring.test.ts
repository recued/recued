/** D-123 Phase 7 — Boot wiring + audit row tests.
 *
 *  Three layers:
 *
 *    1. Audit row shape — `ctx.emitAuditRow` is called per cycle
 *       with the spec-defined shape (`action: 'housekeeping_cycle'`,
 *       `target: 'system'`, `run_mode: 'live'`, `event_at: ts`,
 *       `detail` carrying the cycle aggregate + per-task summary).
 *       Three cycle outcomes covered: all-complete, partial-yield,
 *       error-mixed.
 *
 *    2. Graceful shutdown — `scheduler.stop()` awaits any in-flight
 *       cycle so the DB is safe to close after it resolves.
 *
 *    3. Boot gating — `start()` is a no-op when preset is `'off'`
 *       (mirrors the bin.ts gate that decides whether to call
 *       `housekeeping.start()` at all).
 *
 *  Spec: D-123 §7. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HousekeepingStepResult } from '@recued/contracts';

import { createHousekeepingConfigStore } from '../housekeeping/config-store.js';
import { createHousekeepingStateStore } from '../housekeeping/state-store.js';
import { createHousekeepingScheduler } from '../housekeeping/scheduler.js';
import type {
  HousekeepingAuditRow,
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../housekeeping/registry.js';
import type { EngineBusySignal } from '../housekeeping/engine-busy-signal.js';

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-p7-boot-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const stubBusy = (overrides: Partial<EngineBusySignal> = {}): EngineBusySignal => ({
  isExecuting: () => false,
  isDraining: () => false,
  isBusy: () => false,
  lastIdleTransitionAt: () => null,
  poll: () => undefined,
  ...overrides,
});

const stubCtx = (now: () => number, emitAuditRow: (row: HousekeepingAuditRow) => void = () => {}): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now,
  emitAuditRow,
});

const completingTask = (id: string): HousekeepingTaskInstance => ({
  meta: { id, description: id, interruptible: true, kind: 'core' },
  async step(): Promise<HousekeepingStepResult> {
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});

const yieldingTask = (id: string): HousekeepingTaskInstance => ({
  meta: { id, description: id, interruptible: true, kind: 'core' },
  async step(): Promise<HousekeepingStepResult> {
    return {
      status: 'yield',
      reason: 'budget_exhausted',
      cursor: { kind: 'time', last_seen_at: NOW },
    };
  },
});

const erroringTask = (id: string): HousekeepingTaskInstance => ({
  meta: { id, description: id, interruptible: true, kind: 'core' },
  async step(): Promise<HousekeepingStepResult> {
    throw new Error(`${id} failed`);
  },
});

describe('D-123 P7 — audit row shape', () => {
  it('emits one housekeeping_cycle row per cycle with the spec shape', async () => {
    const config = createHousekeepingConfigStore(db);
    const state = createHousekeepingStateStore(db);
    config.write({ preset: 'balanced' }, NOW);
    let nowCounter = NOW;
    const audited: HousekeepingAuditRow[] = [];
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(
        () => nowCounter++,
        (row) => audited.push(row),
      ),
      config,
      state,
      busy: stubBusy(),
      registry: () => [completingTask('a'), completingTask('b')],
    });
    await sched.runOnce();

    expect(audited).toHaveLength(1);
    const row = audited[0]!;
    expect(row.action).toBe('housekeeping_cycle');
    expect(row.target).toBe('system');
    expect(row.run_mode).toBe('live');
    // Bistemporal stamping rule for system events: event_at = ts.
    expect(row.event_at).toBe(row.ts);
    const detail = row.detail as Record<string, unknown>;
    expect(detail.preset).toBe('balanced');
    expect(detail.tasks_stepped).toBe(2);
    expect(detail.tasks_complete).toBe(2);
    expect(detail.tasks_yielded).toBe(0);
    expect(detail.tasks_errored).toBe(0);
    expect(Array.isArray(detail.per_task)).toBe(true);
    expect((detail.per_task as Array<{ task_id: string; status: string }>).map((p) => p.status)).toEqual(['complete', 'complete']);
  });

  it('captures partial-yield cycles', async () => {
    const config = createHousekeepingConfigStore(db);
    const state = createHousekeepingStateStore(db);
    config.write({ preset: 'balanced' }, NOW);
    let nowCounter = NOW;
    const audited: HousekeepingAuditRow[] = [];
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(
        () => nowCounter++,
        (row) => audited.push(row),
      ),
      config,
      state,
      busy: stubBusy(),
      registry: () => [completingTask('done'), yieldingTask('partial')],
    });
    await sched.runOnce();

    expect(audited).toHaveLength(1);
    const detail = audited[0]!.detail as Record<string, unknown>;
    expect(detail.tasks_complete).toBe(1);
    expect(detail.tasks_yielded).toBe(1);
    expect(detail.tasks_errored).toBe(0);
    const per_task = detail.per_task as Array<{ task_id: string; status: string; yield_reason?: string }>;
    expect(per_task.find((p) => p.task_id === 'partial')?.status).toBe('yield');
    expect(per_task.find((p) => p.task_id === 'partial')?.yield_reason).toBe('budget_exhausted');
  });

  it('captures error-mixed cycles', async () => {
    const config = createHousekeepingConfigStore(db);
    const state = createHousekeepingStateStore(db);
    config.write({ preset: 'aggressive' }, NOW);
    let nowCounter = NOW;
    const audited: HousekeepingAuditRow[] = [];
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(
        () => nowCounter++,
        (row) => audited.push(row),
      ),
      config,
      state,
      busy: stubBusy(),
      registry: () => [completingTask('ok'), erroringTask('boom')],
    });
    await sched.runOnce();

    expect(audited).toHaveLength(1);
    const detail = audited[0]!.detail as Record<string, unknown>;
    expect(detail.preset).toBe('aggressive');
    expect(detail.tasks_complete).toBe(1);
    expect(detail.tasks_errored).toBe(1);
    expect(detail.tasks_yielded).toBe(0);
    const per_task = detail.per_task as Array<{ task_id: string; status: string }>;
    expect(per_task.find((p) => p.task_id === 'boom')?.status).toBe('error');
  });

  it('emit failure does not abort the cycle', async () => {
    const config = createHousekeepingConfigStore(db);
    const state = createHousekeepingStateStore(db);
    config.write({ preset: 'balanced' }, NOW);
    let nowCounter = NOW;
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(
        () => nowCounter++,
        () => {
          throw new Error('audit emitter failure');
        },
      ),
      config,
      state,
      busy: stubBusy(),
      registry: () => [completingTask('a')],
    });
    const result = await sched.runOnce();
    expect(result.tasks_complete).toBe(1);
  });
});

describe('D-123 P7 — graceful shutdown', () => {
  it('stop() waits for in-flight cycle to complete', async () => {
    const config = createHousekeepingConfigStore(db);
    const state = createHousekeepingStateStore(db);
    config.write({ preset: 'balanced' }, NOW);

    let releaseTask: (() => void) | undefined;
    const slowTask: HousekeepingTaskInstance = {
      meta: { id: 'slow', description: 'slow', interruptible: true, kind: 'core' },
      async step(): Promise<HousekeepingStepResult> {
        await new Promise<void>((resolve) => { releaseTask = resolve; });
        return { status: 'complete', cursor: { kind: 'complete' } };
      },
    };

    let nowCounter = NOW;
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => nowCounter++),
      config,
      state,
      busy: stubBusy(),
      registry: () => [slowTask],
    });

    const cyclePromise = sched.runOnce();
    // stop() must wait for the in-flight slowTask to complete.
    let stopResolved = false;
    const stopPromise = sched.stop().then(() => { stopResolved = true; });

    // Yield a few times — stop should still be pending because slowTask is running.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(stopResolved).toBe(false);

    // Release the in-flight task.
    releaseTask!();
    await cyclePromise;
    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  it('stop() is a no-op when no cycle is in flight', async () => {
    const config = createHousekeepingConfigStore(db);
    const state = createHousekeepingStateStore(db);
    config.write({ preset: 'balanced' }, NOW);
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [],
    });
    await expect(sched.stop()).resolves.toBeUndefined();
  });
});

describe('D-123 P7 — boot gating', () => {
  it("start() is a no-op when preset is 'off'", () => {
    const config = createHousekeepingConfigStore(db);
    const state = createHousekeepingStateStore(db);
    config.write({ preset: 'off' }, NOW);
    const setTimer = vi.fn();
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [],
      setTimer,
      clearTimer: vi.fn(),
    });
    sched.start();
    expect(setTimer).not.toHaveBeenCalled();
  });

  it("start() arms the probe loop when preset is 'balanced'", () => {
    const config = createHousekeepingConfigStore(db);
    const state = createHousekeepingStateStore(db);
    config.write({ preset: 'balanced' }, NOW);
    const setTimer = vi.fn().mockReturnValue('token');
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [],
      setTimer,
      clearTimer: vi.fn(),
    });
    sched.start();
    expect(setTimer).toHaveBeenCalledTimes(1);
  });
});
