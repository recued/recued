/** D-262 § B4 — an unconfigured transcription source YIELDS; it does not error.
 *
 *  ⛔⛔ THE BUG THIS PINS SHIPS THE FEATURE PERMANENTLY OFF. The scheduler
 *  auto-disables a task after `HOUSEKEEPING_DISABLE_AFTER_FAILURES` consecutive
 *  errors — permanently, requiring a manual re-enable. Moving transcription
 *  onto a dedicated slot introduced a NEW error code for "no slot configured",
 *  and a server that has not set one up yet raises it on every idle cycle. So
 *  without this classification the `transcript` producer would switch itself
 *  off within three cycles, and an owner who configured the slot on day four
 *  would find the feature dead with nothing explaining why.
 *
 *  ⚠ Unconfigured is a state to WAIT ON, not a failure to punish — the same
 *  reasoning `AI_LLM_UNAVAILABLE` already carried for an unsatisfiable pool.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HOUSEKEEPING_DISABLE_AFTER_FAILURES } from '@recued/contracts';
import { LLMError } from '@recued/llm';
import { createHousekeepingConfigStore } from '../housekeeping/config-store.js';
import { createHousekeepingStateStore } from '../housekeeping/state-store.js';
import { createHousekeepingScheduler } from '../housekeeping/scheduler.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../housekeeping/registry.js';
import type { EngineBusySignal } from '../housekeeping/engine-busy-signal.js';

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-262-yield-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const stubBusy = (): EngineBusySignal => ({
  isExecuting: () => false,
  isDraining: () => false,
  isBusy: () => false,
  lastIdleTransitionAt: () => null,
  poll: () => undefined,
});

const stubCtx = (): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: {} as never,
  recipeStore: {} as never,
  now: () => NOW,
  emitAuditRow: () => undefined,
});

const throwingTask = (error: unknown): HousekeepingTaskInstance => ({
  meta: { id: 'transcript', description: 'transcript', interruptible: true, kind: 'core' },
  async step(): Promise<never> { throw error; },
});

const driveCycles = async (error: unknown) => {
  const config = createHousekeepingConfigStore(db);
  const state = createHousekeepingStateStore(db);
  config.write({ preset: 'balanced' }, NOW);
  const sched = createHousekeepingScheduler({
    ctx: stubCtx(),
    config,
    state,
    busy: stubBusy(),
    registry: () => [throwingTask(error)],
  });
  for (let i = 0; i < HOUSEKEEPING_DISABLE_AFTER_FAILURES; i += 1) {
    await sched.runOnce();
  }
  return state.get('transcript');
};

describe('D-262 § B4 — no transcription source is a yield, not an error', () => {
  it('⛔ does NOT accrue errors toward the permanent auto-disable', async () => {
    const row = await driveCycles(
      new LLMError('AI_NO_TRANSCRIPTION_SOURCE', 'No transcription source is configured.', {}),
    );
    expect(row?.consecutive_errors).toBe(0);
    expect(row?.last_status).toBe('pending');
    expect(row?.last_yield_reason).toBe('pool_policy_unsatisfiable');
  });

  it('still auto-disables on a GENUINE failure, so the widening did not swallow real errors', async () => {
    // ⚠ The counterpart assertion. A classifier that yields on everything would
    // pass the test above and quietly remove the three-strike protection that
    // exists to stop a broken producer burning every idle cycle forever.
    const row = await driveCycles(new Error('boom'));
    expect(row?.consecutive_errors).toBe(HOUSEKEEPING_DISABLE_AFTER_FAILURES);
    expect(row?.last_status).toBe('error');
  });

  it('keeps yielding for the pool case it already covered', async () => {
    const row = await driveCycles(
      new LLMError('AI_LLM_UNAVAILABLE', 'no candidates', { forceLayer: 'free' }),
    );
    expect(row?.consecutive_errors).toBe(0);
    expect(row?.last_yield_reason).toBe('pool_policy_unsatisfiable');
  });
});
