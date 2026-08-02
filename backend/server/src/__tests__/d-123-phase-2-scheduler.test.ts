/** D-123 Phase 2 — Scheduler loop tests. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOUSEKEEPING_AGGRESSIVE_IDLE_THRESHOLD_MS,
  HOUSEKEEPING_DISABLE_AFTER_FAILURES,
  type HousekeepingCursor,
  type HousekeepingStepResult,
} from '@recued/contracts';

import { createHousekeepingConfigStore } from '../housekeeping/config-store.js';
import { createHousekeepingStateStore } from '../housekeeping/state-store.js';
import {
  createHousekeepingScheduler,
  inCustomWindow,
  shouldFireCycle,
} from '../housekeeping/scheduler.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../housekeeping/registry.js';
import type { EngineBusySignal } from '../housekeeping/engine-busy-signal.js';

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-scheduler-'));
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

const stubCtx = (now: () => number): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now,
  emitAuditRow: () => undefined,
});

const completingTask = (
  id: string,
  cursor: HousekeepingCursor = { kind: 'complete' },
  duration_ms = 5,
): HousekeepingTaskInstance => ({
  meta: { id, description: id, interruptible: true, kind: 'core' },
  async step(): Promise<HousekeepingStepResult> {
    await new Promise((r) => setTimeout(r, duration_ms));
    return { status: 'complete', cursor };
  },
});

describe('inCustomWindow', () => {
  const at = (h: number) => new Date(2026, 4, 1, h, 0, 0, 0).getTime();

  it('same-day window — inside', () => {
    expect(inCustomWindow(at(3), 2, 5)).toBe(true);
  });

  it('same-day window — outside', () => {
    expect(inCustomWindow(at(7), 2, 5)).toBe(false);
  });

  it('crosses midnight — inside via late-night side', () => {
    expect(inCustomWindow(at(23), 22, 5)).toBe(true);
  });

  it('crosses midnight — inside via early-morning side', () => {
    expect(inCustomWindow(at(2), 22, 5)).toBe(true);
  });

  it('crosses midnight — outside', () => {
    expect(inCustomWindow(at(12), 22, 5)).toBe(false);
  });

  it('zero-width window is never inside', () => {
    expect(inCustomWindow(at(3), 3, 3)).toBe(false);
  });
});

describe('shouldFireCycle', () => {
  const baseBusy = stubBusy();

  it("returns false when preset is 'off'", () => {
    expect(
      shouldFireCycle({
        preset: 'off',
        cycle_interval_minutes: 0,
        last_run_at: null,
        now: NOW,
        busy: baseBusy,
      }),
    ).toBe(false);
  });

  it('returns false while engine is busy', () => {
    expect(
      shouldFireCycle({
        preset: 'balanced',
        cycle_interval_minutes: 15,
        last_run_at: null,
        now: NOW,
        busy: stubBusy({ isBusy: () => true }),
      }),
    ).toBe(false);
  });

  it('balanced fires when interval elapses past last_run_at', () => {
    expect(
      shouldFireCycle({
        preset: 'balanced',
        cycle_interval_minutes: 15,
        last_run_at: NOW - 16 * 60_000,
        now: NOW,
        busy: baseBusy,
      }),
    ).toBe(true);
  });

  it('balanced does not fire before interval elapses', () => {
    expect(
      shouldFireCycle({
        preset: 'balanced',
        cycle_interval_minutes: 15,
        last_run_at: NOW - 14 * 60_000,
        now: NOW,
        busy: baseBusy,
      }),
    ).toBe(false);
  });

  it('aggressive fires after the idle threshold elapses', () => {
    expect(
      shouldFireCycle({
        preset: 'aggressive',
        cycle_interval_minutes: 0,
        last_run_at: NOW - 60_000,
        now: NOW,
        busy: stubBusy({
          lastIdleTransitionAt: () => NOW - HOUSEKEEPING_AGGRESSIVE_IDLE_THRESHOLD_MS - 1_000,
        }),
      }),
    ).toBe(true);
  });

  it('aggressive does not fire before idle threshold', () => {
    expect(
      shouldFireCycle({
        preset: 'aggressive',
        cycle_interval_minutes: 0,
        last_run_at: NOW - 60_000,
        now: NOW,
        busy: stubBusy({
          lastIdleTransitionAt: () => NOW - 60_000,
        }),
      }),
    ).toBe(false);
  });

  it('aggressive fires on first cycle when never been busy and never run', () => {
    expect(
      shouldFireCycle({
        preset: 'aggressive',
        cycle_interval_minutes: 0,
        last_run_at: null,
        now: NOW,
        busy: stubBusy({ lastIdleTransitionAt: () => null }),
      }),
    ).toBe(true);
  });

  it('custom requires window match', () => {
    const inWindow = new Date(2026, 4, 1, 3, 0, 0, 0).getTime();
    const outOfWindow = new Date(2026, 4, 1, 12, 0, 0, 0).getTime();
    expect(
      shouldFireCycle({
        preset: 'custom',
        cycle_interval_minutes: 5,
        custom_window_start_hour: 2,
        custom_window_end_hour: 5,
        last_run_at: inWindow - 10 * 60_000,
        now: inWindow,
        busy: baseBusy,
      }),
    ).toBe(true);
    expect(
      shouldFireCycle({
        preset: 'custom',
        cycle_interval_minutes: 5,
        custom_window_start_hour: 2,
        custom_window_end_hour: 5,
        last_run_at: outOfWindow - 10 * 60_000,
        now: outOfWindow,
        busy: baseBusy,
      }),
    ).toBe(false);
  });
});

describe('createHousekeepingScheduler', () => {
  const setupBalanced = () => {
    const config = createHousekeepingConfigStore(db);
    const state = createHousekeepingStateStore(db);
    config.write({ preset: 'balanced' }, NOW);
    return { config, state };
  };

  it("start is a no-op when preset is 'off'", () => {
    const { config, state } = setupBalanced();
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

  it('runOnce executes every registered task in topo order', async () => {
    const { config, state } = setupBalanced();
    const calls: string[] = [];
    const task = (id: string, deps?: ReadonlyArray<string>): HousekeepingTaskInstance => ({
      meta: { id, description: id, interruptible: true, kind: 'core', ...(deps ? { depends_on: deps } : {}) },
      async step(): Promise<HousekeepingStepResult> {
        calls.push(id);
        return { status: 'complete', cursor: { kind: 'complete' } };
      },
    });
    let nowCounter = NOW;
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => nowCounter++),
      config,
      state,
      busy: stubBusy(),
      // Two tasks; b depends on a.
      registry: () => [task('a'), task('b', ['a'])],
    });
    const result = await sched.runOnce();
    expect(calls).toEqual(['a', 'b']);
    expect(result.tasks_complete).toBe(2);
    expect(result.tasks_errored).toBe(0);
    expect(state.get('a')?.last_status).toBe('complete');
    expect(state.get('b')?.last_status).toBe('complete');
  });

  it("runOnce honours task_id filter (Settings 'Run now')", async () => {
    const { config, state } = setupBalanced();
    const calls: string[] = [];
    const task = (id: string): HousekeepingTaskInstance => ({
      meta: { id, description: id, interruptible: true, kind: 'core' },
      async step(): Promise<HousekeepingStepResult> {
        calls.push(id);
        return { status: 'complete', cursor: { kind: 'complete' } };
      },
    });
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [task('a'), task('b')],
    });
    await sched.runOnce({ task_id: 'b' });
    expect(calls).toEqual(['b']);
  });

  it('persists yield reason and resumes cursor on next call', async () => {
    const { config, state } = setupBalanced();
    let calls = 0;
    const task: HousekeepingTaskInstance = {
      meta: { id: 'walker', description: 'walker', interruptible: true, kind: 'core' },
      async step(_ctx, cursor): Promise<HousekeepingStepResult> {
        calls += 1;
        if (calls === 1) {
          return {
            status: 'yield',
            reason: 'budget_exhausted',
            cursor: { kind: 'time', last_seen_at: NOW },
          };
        }
        return { status: 'complete', cursor: { kind: 'complete' } };
      },
    };
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [task],
    });
    const first = await sched.runOnce();
    expect(first.tasks_yielded).toBe(1);
    expect(state.get('walker')?.last_status).toBe('pending');
    expect(state.get('walker')?.last_yield_reason).toBe('budget_exhausted');
    const second = await sched.runOnce();
    expect(second.tasks_complete).toBe(1);
    expect(state.get('walker')?.last_status).toBe('complete');
  });

  it('records errors and disables task after threshold', async () => {
    const { config, state } = setupBalanced();
    const task: HousekeepingTaskInstance = {
      meta: { id: 'flaky', description: 'flaky', interruptible: true, kind: 'core' },
      async step(): Promise<HousekeepingStepResult> {
        throw new Error('boom');
      },
    };
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [task],
    });
    for (let i = 0; i < HOUSEKEEPING_DISABLE_AFTER_FAILURES; i += 1) {
      await sched.runOnce();
    }
    expect(state.get('flaky')?.consecutive_errors).toBe(HOUSEKEEPING_DISABLE_AFTER_FAILURES);
    expect(state.get('flaky')?.last_status).toBe('error');

    // Subsequent runOnce skips the disabled task.
    let stepped = false;
    const replacement: HousekeepingTaskInstance = {
      meta: { id: 'flaky', description: 'flaky', interruptible: true, kind: 'core' },
      async step(): Promise<HousekeepingStepResult> {
        stepped = true;
        return { status: 'complete', cursor: { kind: 'complete' } };
      },
    };
    const sched2 = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [replacement],
    });
    await sched2.runOnce();
    expect(stepped).toBe(false);
  });

  it('skips a task whose depends_on upstream is in error state', async () => {
    const { config, state } = setupBalanced();
    state.recordError('upstream', 'boom', NOW);
    state.recordError('upstream', 'boom', NOW);
    state.recordError('upstream', 'boom', NOW);
    let downstreamRan = false;
    const downstream: HousekeepingTaskInstance = {
      meta: {
        id: 'downstream',
        description: 'downstream',
        interruptible: true,
        kind: 'core',
        depends_on: ['upstream'],
      },
      async step(): Promise<HousekeepingStepResult> {
        downstreamRan = true;
        return { status: 'complete', cursor: { kind: 'complete' } };
      },
    };
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [downstream],
    });
    const result = await sched.runOnce();
    expect(downstreamRan).toBe(false);
    expect(result.tasks_stepped).toBe(0);
  });

  it('start arms the probe loop and stop clears it', async () => {
    const { config, state } = setupBalanced();
    const setTimer = vi.fn(() => 'token');
    const clearTimer = vi.fn();
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [],
      setTimer,
      clearTimer,
    });
    sched.start();
    expect(setTimer).toHaveBeenCalledOnce();
    await sched.stop();
    expect(clearTimer).toHaveBeenCalledWith('token');
  });

  it('serializes concurrent Run-now cycles and drains the queued work on stop', async () => {
    const { config, state } = setupBalanced();
    const releases: Array<() => void> = [];
    const calls: number[] = [];
    const task: HousekeepingTaskInstance = {
      meta: { id: 'serial', description: 'serial', interruptible: true, kind: 'core' },
      async step(): Promise<HousekeepingStepResult> {
        const call = calls.length + 1;
        calls.push(call);
        await new Promise<void>((resolve) => { releases.push(resolve); });
        return { status: 'complete', cursor: { kind: 'complete' } };
      },
    };
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [task],
    });

    const first = sched.runOnce();
    const second = sched.runOnce();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([1]);

    let stopped = false;
    const stopping = sched.stop().then(() => { stopped = true; });
    releases[0]!();
    await first;
    await Promise.resolve();
    expect(calls).toEqual([1, 2]);
    expect(stopped).toBe(false);

    releases[1]!();
    await Promise.all([first, second, stopping]);
    expect(stopped).toBe(true);
  });

  it('recovers the idle probe after a pre-task cycle failure', async () => {
    const { config, state } = setupBalanced();
    let probe: (() => void) | undefined;
    let registryCalls = 0;
    let taskCalls = 0;
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => {
        registryCalls += 1;
        if (registryCalls === 1) throw new Error('registry unavailable');
        return [{
          meta: { id: 'recovered', description: 'recovered', interruptible: true, kind: 'core' },
          async step(): Promise<HousekeepingStepResult> {
            taskCalls += 1;
            return { status: 'complete', cursor: { kind: 'complete' } };
          },
        }];
      },
      setTimer: (fn) => { probe = fn; return 'token'; },
      clearTimer: vi.fn(),
    });

    await expect(sched.runOnce()).rejects.toThrow('registry unavailable');
    sched.start();
    probe?.();
    await Promise.resolve();
    await Promise.resolve();
    await sched.stop();
    expect(taskCalls).toBe(1);
  });

  it('contains a cycle-complete observer failure', async () => {
    const { config, state } = setupBalanced();
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [completingTask('a')],
      onCycleComplete: () => { throw new Error('observer boom'); },
    });

    await expect(sched.runOnce()).resolves.toMatchObject({ tasks_complete: 1 });
    await expect(sched.stop()).resolves.toBeUndefined();
  });

  it('emits onCycleComplete after each cycle', async () => {
    const { config, state } = setupBalanced();
    const events: number[] = [];
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [completingTask('a')],
      onCycleComplete: (r) => events.push(r.tasks_complete),
    });
    await sched.runOnce();
    await sched.runOnce();
    expect(events).toEqual([1, 1]);
  });

  it('idle cycle skips tasks with idle_eligible=false; runOnce honours them', async () => {
    const { config, state } = setupBalanced();
    const calls: string[] = [];
    const idleEligible: HousekeepingTaskInstance = {
      meta: {
        id: 'deterministic',
        description: 'deterministic',
        interruptible: true,
        kind: 'enrichment',
      },
      async step(): Promise<HousekeepingStepResult> {
        calls.push('deterministic');
        return { status: 'complete', cursor: { kind: 'complete' } };
      },
    };
    const manualOnly: HousekeepingTaskInstance = {
      meta: {
        id: 'enrichment.summary',
        description: 'AI producer',
        interruptible: true,
        kind: 'enrichment',
        idle_eligible: false,
      },
      async step(): Promise<HousekeepingStepResult> {
        calls.push('enrichment.summary');
        return { status: 'complete', cursor: { kind: 'complete' } };
      },
    };
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => NOW),
      config,
      state,
      busy: stubBusy(),
      registry: () => [idleEligible, manualOnly],
    });
    // Idle cycle (no task_id) must skip the manual-only task.
    await sched.runOnce();
    expect(calls).toEqual(['deterministic']);
    // Run-Now path (task_id set) bypasses the filter.
    await sched.runOnce({ task_id: 'enrichment.summary' });
    expect(calls).toEqual(['deterministic', 'enrichment.summary']);
  });

  it('respects budget — yields without starting next task when remaining < min', async () => {
    const { config, state } = setupBalanced();
    config.write({
      preset: 'custom',
      cycle_budget_ms: 1_000,
      cycle_interval_minutes: 5,
      custom_window_start_hour: 0,
      custom_window_end_hour: 23,
    }, NOW);
    let virtualNow = NOW;
    // First task burns 800ms (virtual), leaving < 500ms before second.
    const slow: HousekeepingTaskInstance = {
      meta: { id: 'slow', description: 'slow', interruptible: true, kind: 'core' },
      async step(): Promise<HousekeepingStepResult> {
        virtualNow += 800;
        return { status: 'complete', cursor: { kind: 'complete' } };
      },
    };
    let secondRan = false;
    const second: HousekeepingTaskInstance = {
      meta: { id: 'second', description: 'second', interruptible: true, kind: 'core' },
      async step(): Promise<HousekeepingStepResult> {
        secondRan = true;
        return { status: 'complete', cursor: { kind: 'complete' } };
      },
    };
    const sched = createHousekeepingScheduler({
      ctx: stubCtx(() => virtualNow),
      config,
      state,
      busy: stubBusy(),
      registry: () => [slow, second],
    });
    const result = await sched.runOnce({ budget_ms: 1_000 });
    expect(result.tasks_stepped).toBe(1);
    expect(secondRan).toBe(false);
  });
});
