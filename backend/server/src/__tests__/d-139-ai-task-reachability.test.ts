/** D-139 slice 4 — the two AI topics are REACHABLE by the owner.
 *
 *  ## The failure this closes
 *
 *  `engagement_sentiment_trend` and `next_best_action` default to
 *  `trust_state: 'manual'` (D-132: AI surfaces stay off until the owner opts
 *  in). Promotion to `'auto'` requires `manual_run_count >=
 *  MANUAL_RUN_THRESHOLD`, which ONLY a successful Run-Now increments. And
 *  Run-Now requires a REGISTERED task — `housekeeping.task.run_now` refuses
 *  an unregistered id outright, and Settings → Housekeeping renders its
 *  inline Run-policy control per registered task, so there was no row to
 *  flip either.
 *
 *  ⛔ With no producer registered, that is a closed loop: the safety default
 *  is one the owner cannot reach by ANY route, which does not ship a feature
 *  safely off — it ships it permanently off. This suite drives the loop.
 *
 *  ## Why it drives the REAL tasks
 *
 *  `d-132-phase-4-trust-rpc.test.ts` already covers the bump mechanism using
 *  a synthetic `aiEnrichmentTask(...)`. That proves the mechanism and proves
 *  nothing about these two topics — a synthetic task is registered by
 *  construction, which is exactly the property that was missing. So this
 *  suite takes `RECORD_AI_TASKS` (the actual instances the bin registers)
 *  and pushes them through the real handler. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOUSEKEEPING_DEFAULT_PRESET,
  MANUAL_RUN_THRESHOLD,
  type EnrichmentTopic,
  type HousekeepingCycleResult,
} from '@recued/contracts';

import type { EventBus } from '../events/bus.js';
import {
  handleHousekeepingTaskRunNow,
  type HousekeepingRpcDeps,
} from '../housekeeping-handler.js';
import {
  createHousekeepingConfigStore,
  type HousekeepingConfigStore,
} from '../housekeeping/config-store.js';
import {
  createHousekeepingStateStore,
  type HousekeepingStateStore,
} from '../housekeeping/state-store.js';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import { createTrustStore, type TrustStore } from '../housekeeping/trust-store.js';
import { RECORD_AI_TASKS } from '../housekeeping/engagement-aggregates/record-ai-tasks.js';
import { RECORD_AGGREGATE_TASKS } from '../housekeeping/engagement-aggregates/record-aggregate-tasks.js';
import { STANDALONE_TASKS } from '../housekeeping/registration.js';

const NOW = 1_700_000_000_000;

let dir: string;
let db: Database.Database;
let config: HousekeepingConfigStore;
let state: HousekeepingStateStore;
let trustStore: TrustStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd139-ai-reach-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  ensureHousekeepingSchema(db);
  config = createHousekeepingConfigStore(db);
  state = createHousekeepingStateStore(db);
  trustStore = createTrustStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const cycleResultFor = (task_id: string): HousekeepingCycleResult => ({
  preset: HOUSEKEEPING_DEFAULT_PRESET,
  duration_ms: 5,
  tasks_stepped: 1,
  tasks_complete: 1,
  tasks_yielded: 0,
  tasks_errored: 0,
  per_task: [{ task_id, status: 'complete', duration_ms: 5 }],
});

const stubEventBus = () => {
  const emitted: Array<{ kind: string; [k: string]: unknown }> = [];
  return {
    bus: { emit: vi.fn((evt) => { emitted.push(evt); return evt; }) } as unknown as EventBus,
    emitted,
  };
};

/** Deps whose registry is the REAL AI task set — no synthetic stand-ins. */
const buildDeps = (overrides: Partial<HousekeepingRpcDeps> = {}): HousekeepingRpcDeps => ({
  config,
  state,
  registry: () => [...RECORD_AI_TASKS],
  runOnce: async (opts) => cycleResultFor(opts.task_id ?? 'unknown'),
  trustStore,
  now: () => NOW,
  ...overrides,
});

describe('D-139 slice 4 — the AI tasks are registered and shaped for the trust gate', () => {
  it('both are in STANDALONE_TASKS — the array the bin registers', () => {
    const registered = new Set(STANDALONE_TASKS.map((t) => t.meta.id));
    for (const task of RECORD_AI_TASKS) {
      expect(registered.has(task.meta.id), `${task.meta.id} not registered`).toBe(true);
    }
    expect(RECORD_AI_TASKS).toHaveLength(2);
  });

  it('both declare is_ai_surface + a token estimate', () => {
    for (const task of RECORD_AI_TASKS) {
      // `is_ai_surface` gates three things: the scheduler's `'auto'` demand,
      // the Pause-AI window, and whether a Run-Now counts toward promotion.
      expect(task.is_ai_surface, task.meta.id).toBe(true);
      // Without this the walk-cap planner substitutes a placeholder that
      // mis-budgets the pool gate in both directions.
      expect(task.token_estimate_per_record, task.meta.id).toBeGreaterThan(0);
      expect(task.meta.id).toBe(`enrichment.${task.topic}`);
    }
  });

  it('the DETERMINISTIC record tasks are NOT marked AI — they must not honour Pause-AI', () => {
    // Guards the pairing rather than each flag alone: if a future edit copies
    // the AI shell for a deterministic topic, that topic would start
    // demanding promotion it never needed.
    for (const task of RECORD_AGGREGATE_TASKS) {
      expect(task.is_ai_surface, task.meta.id).toBe(false);
    }
  });
});

describe('D-139 slice 4 — Run-Now now reaches these topics, and counts', () => {
  it('an unregistered task id is REFUSED — the state these topics were in', () => {
    // The before-picture, asserted rather than described: with no task
    // registered, this is the error the owner would have hit, and it is why
    // `manual_run_count` could never move.
    const deps = buildDeps({ registry: () => [] });
    return expect(
      handleHousekeepingTaskRunNow(deps, { task_id: 'enrichment.next_best_action' }),
    ).rejects.toThrow(/not registered/);
  });

  for (const task of RECORD_AI_TASKS) {
    it(`${task.topic}: a successful Run-Now bumps manual_run_count`, async () => {
      const topic = task.topic as EnrichmentTopic;
      trustStore.write(topic, { trust_state: 'manual' }, NOW);
      const { bus, emitted } = stubEventBus();

      await handleHousekeepingTaskRunNow(buildDeps({ eventBus: bus }), { task_id: task.meta.id });

      expect(trustStore.read(topic, true).manual_run_count).toBe(1);
      // One run is not a promotion — the banner waits for the threshold.
      expect(emitted.filter((e) => e.kind === 'enrichment_promotion_suggested')).toHaveLength(0);
    });

    it(`${task.topic}: reaching MANUAL_RUN_THRESHOLD fires the promotion suggestion`, async () => {
      const topic = task.topic as EnrichmentTopic;
      trustStore.write(topic, { trust_state: 'manual' }, NOW);
      const { bus, emitted } = stubEventBus();
      const deps = buildDeps({ eventBus: bus });

      for (let i = 0; i < MANUAL_RUN_THRESHOLD; i += 1) {
        await handleHousekeepingTaskRunNow(deps, { task_id: task.meta.id });
      }

      expect(trustStore.read(topic, true).manual_run_count).toBe(MANUAL_RUN_THRESHOLD);
      const fired = emitted.filter((e) => e.kind === 'enrichment_promotion_suggested');
      expect(fired, 'promotion never suggested — the owner is never offered the flip').toHaveLength(1);
      expect(fired[0]).toMatchObject({ topic, manual_run_count: MANUAL_RUN_THRESHOLD });
    });
  }

  it('registration does NOT turn them on — trust stays manual until the owner acts', () => {
    // ⛔ The other half of reachable. Making a token-spending producer
    // runnable must not make it running: the whole D-132 posture is that the
    // owner opts in. A regression here would spend money on idle cycles
    // nobody asked for, and would look like a feature working.
    for (const task of RECORD_AI_TASKS) {
      const effective = trustStore.read(task.topic as EnrichmentTopic, true);
      expect(effective.trust_state, task.meta.id).toBe('manual');
    }
  });
});
