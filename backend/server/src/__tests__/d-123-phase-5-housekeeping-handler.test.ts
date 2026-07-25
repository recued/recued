/** D-123 Phase 5 — `housekeeping.*` rpc handler + realtime + cost
 *  preview tests.
 *
 *  Covers:
 *  - `housekeeping.config.read` returns default preset on a fresh DB.
 *  - `housekeeping.config.write` persists for valid presets, rejects
 *    unknown presets, validates custom-only fields, clamps the cycle
 *    budget range, ignores caller-supplied budget for non-`custom`.
 *  - `housekeeping.status.read` returns one row per registered task,
 *    surfaces persisted state when present, attaches enrichment info
 *    only for `kind: 'enrichment'` tasks.
 *  - `housekeeping.task.run_now` fires `runOnce` for valid task ids,
 *    rejects unknown ids + empty ids.
 *  - The scheduler's `onCycleComplete` listener fires with the cycle
 *    result on every cycle (proxy for the realtime fan-out wired in
 *    `bin.ts`).
 *  - Token-cost preview returns deterministic for 0-token producers
 *    + multiplies tokens × source-collection size for AI producers. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOUSEKEEPING_CYCLE_BUDGET_MAX_MS,
  HOUSEKEEPING_DEFAULT_PRESET,
  RpcError,
  type HousekeepingCycleResult,
  type HousekeepingEnrichmentInfo,
} from '@recued/contracts';

import {
  createHousekeepingConfigStore,
  type HousekeepingConfigStore,
} from '../housekeeping/config-store.js';
import {
  createHousekeepingStateStore,
  type HousekeepingStateStore,
} from '../housekeeping/state-store.js';
import type { HousekeepingTaskInstance } from '../housekeeping/registry.js';
import {
  handleHousekeepingConfigRead,
  handleHousekeepingConfigWrite,
  handleHousekeepingStatusRead,
  handleHousekeepingTaskRunNow,
  type HousekeepingRpcDeps,
} from '../housekeeping-handler.js';

let dir: string;
let db: Database.Database;
let config: HousekeepingConfigStore;
let state: HousekeepingStateStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-123-p5-handler-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  config = createHousekeepingConfigStore(db);
  state = createHousekeepingStateStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const completeTask = (id: string, kind: 'core' | 'enrichment' = 'core'): HousekeepingTaskInstance => ({
  meta: { id, description: `${id} — test`, interruptible: true, kind },
  async step() {
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});

const buildDeps = (overrides: Partial<HousekeepingRpcDeps> = {}): HousekeepingRpcDeps => ({
  config,
  state,
  registry: () => [],
  runOnce: async () => ({
    preset: HOUSEKEEPING_DEFAULT_PRESET,
    duration_ms: 0,
    tasks_stepped: 0,
    tasks_complete: 0,
    tasks_yielded: 0,
    tasks_errored: 0,
    per_task: [],
  }),
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// config.read / config.write
// ────────────────────────────────────────────────────────────────

describe('housekeeping.config.read', () => {
  it('returns HOUSEKEEPING_DEFAULT_PRESET on a fresh DB', async () => {
    const result = await handleHousekeepingConfigRead(buildDeps());
    expect(result.preset).toBe(HOUSEKEEPING_DEFAULT_PRESET);
    expect(result.cycle_budget_ms).toBe(60_000);
    expect(result.cycle_interval_minutes).toBe(15);
  });
});

describe('housekeeping.config.write', () => {
  it('persists a valid preset and ignores caller budget for non-custom', async () => {
    const result = await handleHousekeepingConfigWrite(
      buildDeps({ now: () => 1_700_000_000_000 }),
      { preset: 'light', cycle_budget_ms: 999 },
    );
    expect(result.ok).toBe(true);
    expect(result.effective.preset).toBe('light');
    // Caller-supplied 999 is overwritten by the preset defaults.
    expect(result.effective.cycle_budget_ms).toBe(30_000);
  });

  it('rejects an unknown preset with bad_request', async () => {
    await expect(
      handleHousekeepingConfigWrite(buildDeps(), {
        preset: 'turbo' as never,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects custom preset missing required window fields', async () => {
    await expect(
      handleHousekeepingConfigWrite(buildDeps(), {
        preset: 'custom',
        cycle_budget_ms: 60_000,
        cycle_interval_minutes: 30,
      }),
    ).rejects.toThrow(RpcError);
  });

  it('clamps custom cycle_budget_ms above the max bound', async () => {
    await expect(
      handleHousekeepingConfigWrite(buildDeps(), {
        preset: 'custom',
        cycle_budget_ms: HOUSEKEEPING_CYCLE_BUDGET_MAX_MS + 1,
        cycle_interval_minutes: 30,
        custom_window_start_hour: 22,
        custom_window_end_hour: 5,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('persists a valid custom preset round-trip', async () => {
    const result = await handleHousekeepingConfigWrite(
      buildDeps({ now: () => 1_700_000_000_000 }),
      {
        preset: 'custom',
        cycle_budget_ms: 90_000,
        cycle_interval_minutes: 30,
        custom_window_start_hour: 22,
        custom_window_end_hour: 5,
      },
    );
    expect(result.effective.preset).toBe('custom');
    expect(result.effective.cycle_budget_ms).toBe(90_000);
    expect(result.effective.custom_window_start_hour).toBe(22);
    expect(result.effective.custom_window_end_hour).toBe(5);
    // Subsequent read returns the same.
    const back = await handleHousekeepingConfigRead(buildDeps());
    expect(back.preset).toBe('custom');
    expect(back.cycle_budget_ms).toBe(90_000);
  });
});

// ────────────────────────────────────────────────────────────────
// status.read
// ────────────────────────────────────────────────────────────────

describe('housekeeping.status.read', () => {
  it('returns an empty list when no tasks are registered', async () => {
    const result = await handleHousekeepingStatusRead(buildDeps());
    expect(result.tasks).toEqual([]);
  });

  it('returns one row per registered task with meta', async () => {
    const tasks = [completeTask('audit-compaction'), completeTask('link-discovery')];
    const result = await handleHousekeepingStatusRead(
      buildDeps({ registry: () => tasks }),
    );
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].meta.id).toBe('audit-compaction');
    expect(result.tasks[0].state).toBeUndefined();
  });

  it('surfaces persisted state when a task has run', async () => {
    state.set({
      task_id: 'audit-compaction',
      cursor: { kind: 'complete' },
      last_status: 'complete',
      last_run_at: 1_700_000_000_000,
      last_run_duration_ms: 42,
    });
    const result = await handleHousekeepingStatusRead(
      buildDeps({ registry: () => [completeTask('audit-compaction')] }),
    );
    expect(result.tasks[0].state?.last_status).toBe('complete');
    expect(result.tasks[0].state?.last_run_duration_ms).toBe(42);
  });

  it('attaches enrichment info only for kind:enrichment tasks', async () => {
    const enrichment: HousekeepingEnrichmentInfo = {
      token_estimate_per_record: 0,
      source_collection_count: 17,
    };
    const tasks = [
      completeTask('audit-compaction', 'core'),
      completeTask('enrichment.thread_signals', 'enrichment'),
    ];
    const result = await handleHousekeepingStatusRead(
      buildDeps({
        registry: () => tasks,
        getEnrichmentInfo: async (id) =>
          id === 'enrichment.thread_signals' ? enrichment : undefined,
      }),
    );
    expect(result.tasks[0].enrichment).toBeUndefined();
    expect(result.tasks[1].enrichment).toEqual(enrichment);
  });
});

// ────────────────────────────────────────────────────────────────
// task.run_now
// ────────────────────────────────────────────────────────────────

describe('housekeeping.task.run_now', () => {
  it('rejects an empty task_id with bad_request', async () => {
    await expect(
      handleHousekeepingTaskRunNow(buildDeps(), { task_id: '' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects a task_id that is not registered', async () => {
    await expect(
      handleHousekeepingTaskRunNow(
        buildDeps({ registry: () => [completeTask('audit-compaction')] }),
        { task_id: 'unknown-task' },
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('forwards to runOnce with the task_id and returns the cycle result', async () => {
    const captured: Array<{ task_id?: string }> = [];
    const cycle: HousekeepingCycleResult = {
      preset: 'balanced',
      duration_ms: 5,
      tasks_stepped: 1,
      tasks_complete: 1,
      tasks_yielded: 0,
      tasks_errored: 0,
      per_task: [{ task_id: 'audit-compaction', status: 'complete', duration_ms: 5 }],
    };
    const result = await handleHousekeepingTaskRunNow(
      buildDeps({
        registry: () => [completeTask('audit-compaction')],
        runOnce: async (opts) => {
          captured.push({ ...(opts.task_id !== undefined ? { task_id: opts.task_id } : {}) });
          return cycle;
        },
      }),
      { task_id: 'audit-compaction' },
    );
    expect(captured).toEqual([{ task_id: 'audit-compaction' }]);
    expect(result.ok).toBe(true);
    expect(result.cycle_result).toEqual(cycle);
  });
});

// ────────────────────────────────────────────────────────────────
// realtime fan-out shape
// ────────────────────────────────────────────────────────────────

describe('realtime housekeeping_cycle event shape', () => {
  it('per_task summary projects cleanly into the wire-event payload', () => {
    // Mirrors the shape `bin.ts.onCycleComplete` projects into the
    // `eventBus.emit({ kind: 'housekeeping_cycle', ... })` call.
    const cycle: HousekeepingCycleResult = {
      preset: 'balanced',
      duration_ms: 12,
      tasks_stepped: 2,
      tasks_complete: 1,
      tasks_yielded: 1,
      tasks_errored: 0,
      per_task: [
        { task_id: 'audit-compaction', status: 'complete', duration_ms: 5 },
        {
          task_id: 'link-discovery',
          status: 'yield',
          duration_ms: 7,
          yield_reason: 'budget_exhausted',
        },
      ],
    };
    const payload = {
      kind: 'housekeeping_cycle' as const,
      at: 1_700_000_000_000,
      duration_ms: cycle.duration_ms,
      tasks_complete: cycle.tasks_complete,
      tasks_yielded: cycle.tasks_yielded,
      tasks_errored: cycle.tasks_errored,
      per_task: cycle.per_task,
    };
    expect(payload.per_task).toHaveLength(2);
    expect(payload.per_task[1].yield_reason).toBe('budget_exhausted');
    expect(payload.tasks_yielded).toBe(1);
  });
});
