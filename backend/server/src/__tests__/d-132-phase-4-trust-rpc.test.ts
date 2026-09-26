/** D-132 Phase 4 — `housekeeping.trust.*` rpcs + config widening +
 *  promotion-suggestion hook on `task.run_now`.
 *
 *  Covers:
 *    - `config.write` widening: persists `allow_byok_background` +
 *      `pause_background_ai_until`; clears the pause window on null;
 *      rejects malformed pause values.
 *    - `trust.read` returns persisted rows; `trust.write` validates
 *      topic / state / policy and round-trips; `trust.dismiss_promotion`
 *      stamps `promotion_dismissed_at`.
 *    - The `task.run_now` handler bumps `manual_run_count` only for
 *      AI-surface enrichment producers held in `'manual'`. The first
 *      successful run that crosses `MANUAL_RUN_THRESHOLD` fires
 *      exactly one `enrichment_promotion_suggested` event; subsequent
 *      runs no-op. Errors / yields don't count. Dismissed topics
 *      don't re-fire.
 *
 *  Spec: D-132 §A.7 + §A.8. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOUSEKEEPING_DEFAULT_PRESET,
  MANUAL_RUN_THRESHOLD,
  RpcError,
  type EnrichmentTopic,
  type HousekeepingCycleResult,
  type HousekeepingEnrichmentInfo,
  type ServerEvent,
} from '@recued/contracts';

import {
  createHousekeepingConfigStore,
  type HousekeepingConfigStore,
} from '../housekeeping/config-store.js';
import {
  createHousekeepingStateStore,
  type HousekeepingStateStore,
} from '../housekeeping/state-store.js';
import {
  createTrustStore,
  type TrustStore,
} from '../housekeeping/trust-store.js';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import type { HousekeepingTaskInstance } from '../housekeeping/registry.js';
import type { EventBus } from '../events/bus.js';

import {
  handleHousekeepingConfigRead,
  handleHousekeepingConfigWrite,
  handleHousekeepingTaskRunNow,
  handleHousekeepingTrustDismissPromotion,
  handleHousekeepingTrustRead,
  handleHousekeepingTrustWrite,
  type HousekeepingRpcDeps,
} from '../housekeeping-handler.js';

const NOW = 1_700_000_000_000;
let dir: string;
let db: Database.Database;
let config: HousekeepingConfigStore;
let state: HousekeepingStateStore;
let trustStore: TrustStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-132-p4-'));
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

const aiEnrichmentTask = (
  id: string,
  topic: EnrichmentTopic,
): HousekeepingTaskInstance => ({
  meta: { id, description: `${id} — test`, interruptible: true, kind: 'enrichment' },
  topic,
  is_ai_surface: true,
  async step() {
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});

const deterministicEnrichmentTask = (
  id: string,
  topic: EnrichmentTopic,
): HousekeepingTaskInstance => ({
  meta: { id, description: `${id} — test`, interruptible: true, kind: 'enrichment' },
  topic,
  is_ai_surface: false,
  async step() {
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});

const coreTask = (id: string): HousekeepingTaskInstance => ({
  meta: { id, description: `${id} — test`, interruptible: true, kind: 'core' },
  async step() {
    return { status: 'complete', cursor: { kind: 'complete' } };
  },
});

const cycleResultFor = (
  task_id: string,
  status: 'complete' | 'error' | 'yield' = 'complete',
): HousekeepingCycleResult => ({
  preset: HOUSEKEEPING_DEFAULT_PRESET,
  duration_ms: 5,
  tasks_stepped: 1,
  tasks_complete: status === 'complete' ? 1 : 0,
  tasks_yielded: status === 'yield' ? 1 : 0,
  tasks_errored: status === 'error' ? 1 : 0,
  per_task: [{ task_id, status, duration_ms: 5 }],
});

const stubEventBus = () => {
  const emitted: Array<ServerEvent | { kind: string; [k: string]: unknown }> = [];
  return {
    bus: {
      emit: vi.fn((evt) => {
        emitted.push(evt);
        return { ...evt, cursor: emitted.length } as ServerEvent;
      }),
    } as unknown as EventBus,
    emitted,
  };
};

const buildDeps = (overrides: Partial<HousekeepingRpcDeps> = {}): HousekeepingRpcDeps => ({
  config,
  state,
  registry: () => [],
  runOnce: async (opts) => cycleResultFor(opts.task_id ?? 'unknown'),
  trustStore,
  now: () => NOW,
  ...overrides,
});

// ────────────────────────────────────────────────────────────────
// config.write widening
// ────────────────────────────────────────────────────────────────

describe('D-132 P4 — housekeeping.config.write widening', () => {
  it('persists allow_byok_background + pause_background_ai_until on the row', async () => {
    const result = await handleHousekeepingConfigWrite(buildDeps(), {
      preset: 'balanced',
      allow_byok_background: true,
      pause_background_ai_until: NOW + 60_000,
    });
    expect(result.effective.allow_byok_background).toBe(true);
    expect(result.effective.pause_background_ai_until).toBe(NOW + 60_000);

    const back = await handleHousekeepingConfigRead(buildDeps());
    expect(back.allow_byok_background).toBe(true);
    expect(back.pause_background_ai_until).toBe(NOW + 60_000);
  });

  it('passing null on pause_background_ai_until clears the pause window', async () => {
    await handleHousekeepingConfigWrite(buildDeps(), {
      preset: 'balanced',
      pause_background_ai_until: NOW + 60_000,
    });
    await handleHousekeepingConfigWrite(buildDeps(), {
      preset: 'balanced',
      pause_background_ai_until: null,
    });
    const back = await handleHousekeepingConfigRead(buildDeps());
    expect(back.pause_background_ai_until).toBeNull();
  });

  it('caller-omitted ai-control fields preserve persisted values across preset changes', async () => {
    await handleHousekeepingConfigWrite(buildDeps(), {
      preset: 'balanced',
      allow_byok_background: true,
      pause_background_ai_until: NOW + 30_000,
    });
    // A subsequent preset change without ai-control fields keeps prior values.
    await handleHousekeepingConfigWrite(buildDeps(), { preset: 'aggressive' });
    const back = await handleHousekeepingConfigRead(buildDeps());
    expect(back.preset).toBe('aggressive');
    expect(back.allow_byok_background).toBe(true);
    expect(back.pause_background_ai_until).toBe(NOW + 30_000);
  });

  it('rejects non-finite pause_background_ai_until with bad_request', async () => {
    await expect(
      handleHousekeepingConfigWrite(buildDeps(), {
        preset: 'balanced',
        pause_background_ai_until: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects negative pause_background_ai_until with bad_request', async () => {
    await expect(
      handleHousekeepingConfigWrite(buildDeps(), {
        preset: 'balanced',
        pause_background_ai_until: -1,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

// ────────────────────────────────────────────────────────────────
// trust.read / trust.write / trust.dismiss_promotion
// ────────────────────────────────────────────────────────────────

describe('D-132 P4 — housekeeping.trust.read', () => {
  it('returns an empty list on a fresh DB', async () => {
    const result = await handleHousekeepingTrustRead(buildDeps());
    expect(result.rows).toEqual([]);
  });

  it('returns persisted rows after writes', async () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto' }, NOW);
    trustStore.write('summary' as EnrichmentTopic, { pool_policy: 'free_only' }, NOW);
    const result = await handleHousekeepingTrustRead(buildDeps());
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((r) => r.topic === 'purpose')?.trust_state).toBe('auto');
    expect(result.rows.find((r) => r.topic === 'summary')?.pool_policy).toBe('free_only');
  });

  it('throws unsupported when the trust store is not wired', async () => {
    await expect(
      handleHousekeepingTrustRead(buildDeps({ trustStore: undefined })),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('D-132 P4 — housekeeping.trust.write', () => {
  it('persists trust_state + pool_policy in one call', async () => {
    const result = await handleHousekeepingTrustWrite(buildDeps(), {
      topic: 'purpose',
      trust_state: 'auto',
      pool_policy: 'byok_only',
    });
    expect(result.effective.trust_state).toBe('auto');
    expect(result.effective.pool_policy).toBe('byok_only');
  });

  it('rejects an unknown topic with bad_request', async () => {
    await expect(
      handleHousekeepingTrustWrite(buildDeps(), {
        topic: 'not-a-topic',
        trust_state: 'auto',
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects an invalid trust_state enum with bad_request', async () => {
    await expect(
      handleHousekeepingTrustWrite(buildDeps(), {
        topic: 'purpose',
        trust_state: 'turbo' as never,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects an invalid pool_policy enum with bad_request', async () => {
    await expect(
      handleHousekeepingTrustWrite(buildDeps(), {
        topic: 'purpose',
        pool_policy: 'magic' as never,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects calls with neither trust_state nor pool_policy', async () => {
    await expect(
      handleHousekeepingTrustWrite(buildDeps(), { topic: 'purpose' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('throws unsupported when the trust store is not wired', async () => {
    await expect(
      handleHousekeepingTrustWrite(buildDeps({ trustStore: undefined }), {
        topic: 'purpose',
        trust_state: 'auto',
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('D-132 P4 — housekeeping.trust.dismiss_promotion', () => {
  it('stamps promotion_dismissed_at on the row', async () => {
    const result = await handleHousekeepingTrustDismissPromotion(buildDeps(), {
      topic: 'purpose',
    });
    expect(result.effective.promotion_dismissed_at).toBe(NOW);
  });

  it('rejects unknown topics with bad_request', async () => {
    await expect(
      handleHousekeepingTrustDismissPromotion(buildDeps(), {
        topic: 'not-a-topic',
      }),
    ).rejects.toThrow(RpcError);
  });
});

// ────────────────────────────────────────────────────────────────
// task.run_now → manual_run_count + promotion-suggest hook
// ────────────────────────────────────────────────────────────────

describe('D-132 P4 — task.run_now manual_run_count + promotion fire', () => {
  it('bumps manual_run_count only for AI-surface manual producers', async () => {
    const task = aiEnrichmentTask('enrichment.purpose', 'purpose' as EnrichmentTopic);
    trustStore.write(
      'purpose' as EnrichmentTopic,
      { trust_state: 'manual' },
      NOW,
    );
    const { bus, emitted } = stubEventBus();
    const deps = buildDeps({
      registry: () => [task],
      eventBus: bus,
    });
    await handleHousekeepingTaskRunNow(deps, { task_id: task.meta.id });
    const after = trustStore.read('purpose' as EnrichmentTopic, true);
    expect(after.manual_run_count).toBe(1);
    expect(emitted).toHaveLength(0); // below threshold — no event yet
  });

  it('does not bump count for deterministic enrichment producers', async () => {
    const task = deterministicEnrichmentTask(
      'enrichment.thread_signals',
      'thread_signals' as EnrichmentTopic,
    );
    trustStore.write(
      'thread_signals' as EnrichmentTopic,
      { trust_state: 'manual' },
      NOW,
    );
    await handleHousekeepingTaskRunNow(
      buildDeps({ registry: () => [task] }),
      { task_id: task.meta.id },
    );
    const after = trustStore.read('thread_signals' as EnrichmentTopic, false);
    expect(after.manual_run_count).toBe(0);
  });

  it('does not bump count for core (non-enrichment) tasks', async () => {
    const task = coreTask('audit-compaction');
    await handleHousekeepingTaskRunNow(
      buildDeps({ registry: () => [task] }),
      { task_id: task.meta.id },
    );
    // Defensive — there's no topic-keyed row for a core task; the
    // hook should short-circuit on `task.meta.kind === 'enrichment'`
    // check before touching trust.
    expect(trustStore.list()).toEqual([]);
  });

  it('does not bump count when trust state is auto', async () => {
    const task = aiEnrichmentTask('enrichment.purpose', 'purpose' as EnrichmentTopic);
    trustStore.write(
      'purpose' as EnrichmentTopic,
      { trust_state: 'auto' },
      NOW,
    );
    await handleHousekeepingTaskRunNow(
      buildDeps({ registry: () => [task] }),
      { task_id: task.meta.id },
    );
    const after = trustStore.read('purpose' as EnrichmentTopic, true);
    expect(after.manual_run_count).toBe(0);
  });

  it('does not bump count when the run errored', async () => {
    const task = aiEnrichmentTask('enrichment.purpose', 'purpose' as EnrichmentTopic);
    trustStore.write(
      'purpose' as EnrichmentTopic,
      { trust_state: 'manual' },
      NOW,
    );
    await handleHousekeepingTaskRunNow(
      buildDeps({
        registry: () => [task],
        runOnce: async (opts) => cycleResultFor(opts.task_id ?? 'unknown', 'error'),
      }),
      { task_id: task.meta.id },
    );
    const after = trustStore.read('purpose' as EnrichmentTopic, true);
    expect(after.manual_run_count).toBe(0);
  });

  it('emits enrichment_promotion_suggested exactly once on threshold crossing', async () => {
    const task = aiEnrichmentTask('enrichment.purpose', 'purpose' as EnrichmentTopic);
    trustStore.write(
      'purpose' as EnrichmentTopic,
      { trust_state: 'manual' },
      NOW,
    );
    const { bus, emitted } = stubEventBus();
    const deps = buildDeps({
      registry: () => [task],
      eventBus: bus,
      getEnrichmentInfo: async () => ({
        token_estimate_per_record: 250,
        source_collection_count: 40,
      }) satisfies HousekeepingEnrichmentInfo,
    });

    // First N-1 runs — no event yet.
    for (let i = 0; i < MANUAL_RUN_THRESHOLD - 1; i += 1) {
      await handleHousekeepingTaskRunNow(deps, { task_id: task.meta.id });
    }
    expect(emitted).toHaveLength(0);

    // Threshold-crossing run — exactly one event.
    await handleHousekeepingTaskRunNow(deps, { task_id: task.meta.id });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      kind: 'enrichment_promotion_suggested',
      topic: 'purpose',
      manual_run_count: MANUAL_RUN_THRESHOLD,
      estimated_idle_cycle_cost_tokens: 250 * 40,
    });

    // Subsequent runs — no further events.
    await handleHousekeepingTaskRunNow(deps, { task_id: task.meta.id });
    await handleHousekeepingTaskRunNow(deps, { task_id: task.meta.id });
    expect(emitted).toHaveLength(1);
  });

  it('marks promotion_suggested_at on the row at threshold crossing', async () => {
    const task = aiEnrichmentTask('enrichment.purpose', 'purpose' as EnrichmentTopic);
    trustStore.write(
      'purpose' as EnrichmentTopic,
      { trust_state: 'manual' },
      NOW,
    );
    const { bus } = stubEventBus();
    const deps = buildDeps({ registry: () => [task], eventBus: bus });
    for (let i = 0; i < MANUAL_RUN_THRESHOLD; i += 1) {
      await handleHousekeepingTaskRunNow(deps, { task_id: task.meta.id });
    }
    const after = trustStore.read('purpose' as EnrichmentTopic, true);
    expect(after.promotion_suggested_at).toBe(NOW);
    expect(after.manual_run_count).toBe(MANUAL_RUN_THRESHOLD);
  });

  it('the crossed row is exactly what the promotion banner restores from', async () => {
    // ⛔ The pairing, not either side. The banner used to render only from the
    // `enrichment_promotion_suggested` broadcast, so it vanished on reload
    // while THIS row sat in the trust rows the panel had just fetched. It is
    // now rebuilt from these three fields, so the server has to keep producing
    // them together: suggested, not dismissed, and NOT yet accepted — nothing
    // clears `promotion_suggested_at` on acceptance, so `trust_state` is the
    // only thing that says the question has been answered.
    const task = aiEnrichmentTask('enrichment.purpose', 'purpose' as EnrichmentTopic);
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'manual' }, NOW);
    const { bus } = stubEventBus();
    const deps = buildDeps({ registry: () => [task], eventBus: bus });
    for (let i = 0; i < MANUAL_RUN_THRESHOLD; i += 1) {
      await handleHousekeepingTaskRunNow(deps, { task_id: task.meta.id });
    }

    const row = (await handleHousekeepingTrustRead(deps)).rows
      .find((r) => r.topic === 'purpose');
    expect(row).toBeDefined();
    expect(row!.promotion_suggested_at).not.toBeNull();
    expect(row!.promotion_dismissed_at).toBeNull();
    expect(row!.trust_state).toBe('manual');
  });

  it('accepting the promotion leaves promotion_suggested_at SET — trust_state is the discriminator', async () => {
    // 🔑 Pins the reason the banner's restore predicate needs a third clause.
    // If this ever starts clearing the timestamp the clause becomes dead code,
    // and whoever removes it should be told by a test rather than by a user
    // who stopped being nagged.
    const task = aiEnrichmentTask('enrichment.purpose', 'purpose' as EnrichmentTopic);
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'manual' }, NOW);
    const { bus } = stubEventBus();
    const deps = buildDeps({ registry: () => [task], eventBus: bus });
    for (let i = 0; i < MANUAL_RUN_THRESHOLD; i += 1) {
      await handleHousekeepingTaskRunNow(deps, { task_id: task.meta.id });
    }

    await handleHousekeepingTrustWrite(deps, { topic: 'purpose', trust_state: 'auto' });

    const row = trustStore.read('purpose' as EnrichmentTopic, true);
    expect(row.trust_state).toBe('auto');
    expect(row.promotion_suggested_at).not.toBeNull();
  });

  it('does not emit when the topic was previously dismissed', async () => {
    const task = aiEnrichmentTask('enrichment.purpose', 'purpose' as EnrichmentTopic);
    trustStore.write(
      'purpose' as EnrichmentTopic,
      { trust_state: 'manual' },
      NOW,
    );
    trustStore.markPromotionDismissed('purpose' as EnrichmentTopic, NOW);
    const { bus, emitted } = stubEventBus();
    const deps = buildDeps({ registry: () => [task], eventBus: bus });
    for (let i = 0; i < MANUAL_RUN_THRESHOLD + 2; i += 1) {
      await handleHousekeepingTaskRunNow(deps, { task_id: task.meta.id });
    }
    expect(emitted).toHaveLength(0);
    // Dismissed topics short-circuit BEFORE the bump — count stays at 0.
    const after = trustStore.read('purpose' as EnrichmentTopic, true);
    expect(after.manual_run_count).toBe(0);
  });

  it('emits zero estimated_idle_cycle_cost_tokens when getEnrichmentInfo is absent', async () => {
    const task = aiEnrichmentTask('enrichment.purpose', 'purpose' as EnrichmentTopic);
    trustStore.write(
      'purpose' as EnrichmentTopic,
      { trust_state: 'manual' },
      NOW,
    );
    const { bus, emitted } = stubEventBus();
    const deps = buildDeps({ registry: () => [task], eventBus: bus });
    for (let i = 0; i < MANUAL_RUN_THRESHOLD; i += 1) {
      await handleHousekeepingTaskRunNow(deps, { task_id: task.meta.id });
    }
    expect(emitted[0]).toMatchObject({
      kind: 'enrichment_promotion_suggested',
      estimated_idle_cycle_cost_tokens: 0,
    });
  });

  it('still bumps state even when eventBus is absent (best-effort emit)', async () => {
    const task = aiEnrichmentTask('enrichment.purpose', 'purpose' as EnrichmentTopic);
    trustStore.write(
      'purpose' as EnrichmentTopic,
      { trust_state: 'manual' },
      NOW,
    );
    const deps = buildDeps({ registry: () => [task] }); // no eventBus
    for (let i = 0; i < MANUAL_RUN_THRESHOLD; i += 1) {
      await handleHousekeepingTaskRunNow(deps, { task_id: task.meta.id });
    }
    const after = trustStore.read('purpose' as EnrichmentTopic, true);
    expect(after.manual_run_count).toBe(MANUAL_RUN_THRESHOLD);
    expect(after.promotion_suggested_at).toBe(NOW);
  });
});
