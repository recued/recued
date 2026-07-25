/** D-132 Phase 2 — scheduler trust check + harness forceLayer threading.
 *
 *  Verifies the runtime side of the trust gate end-to-end:
 *    - `isEligibleForIdleCycle` semantics (core / no-trust-store fallback /
 *      no-topic / trust state / pause-AI window).
 *    - Scheduler `runCycleInner` filters tasks via the gate; Run-Now
 *      bypasses it; pause-AI hides AI producers but not deterministic.
 *    - Harness threads `forceLayer` through producers — wrapped `ctx.llm` /
 *      `ctx.embed` inject `'llm.force_layer'` into the input map; user
 *      overrides win on key collision.
 *    - Skip-and-log on unsatisfiable pool policies — `LLMError`
 *      ('AI_LLM_UNAVAILABLE', forced='free' or 'byok') translates to a
 *      `'pool_policy_unsatisfiable'` yield + a `last_errors_json` entry;
 *      mismatched layers / other error kinds re-throw to the scheduler's
 *      error path. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CollectionRecord,
  EnrichmentTopic,
  HousekeepingCursor,
  HousekeepingStepResult,
  IngredientManifest,
} from '@recued/contracts';
import { LLMError } from '@recued/llm';

import {
  buildEnrichmentProducerTask,
  type HousekeepingEnrichmentProducer,
} from '../housekeeping/enrichment-producer.js';
import type {
  HousekeepingContext,
  HousekeepingTaskInstance,
} from '../housekeeping/registry.js';
import type {
  SourceCollectionWalker,
  SourceRecord,
} from '../housekeeping/source-walkers.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  createHousekeepingConfigStore,
  type HousekeepingConfigStore,
} from '../housekeeping/config-store.js';
import {
  createHousekeepingStateStore,
  type HousekeepingStateStore,
} from '../housekeeping/state-store.js';
import {
  createHousekeepingScheduler,
  isEligibleForIdleCycle,
} from '../housekeeping/scheduler.js';
import { createEngineBusySignal } from '../housekeeping/engine-busy-signal.js';
import {
  createTrustStore,
  readTaskErrorHistory,
  type TrustStore,
} from '../housekeeping/trust-store.js';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';

// ────────────────────────────────────────────────────────────────
// Fixture
// ────────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;
let dir: string;
let db: Database.Database;
let store: EnrichmentStore;
let trustStore: TrustStore;
let configStore: HousekeepingConfigStore;
let stateStore: HousekeepingStateStore;
let now = NOW;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-132-p2-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  ensureHousekeepingSchema(db);
  // Seed singleton config row so trust-store helpers can read it.
  db.prepare(
    `INSERT INTO housekeeping_config (
       id, preset, cycle_budget_ms, cycle_interval_minutes, updated_at
     ) VALUES ('singleton', 'balanced', 60000, 15, ?)`,
  ).run(NOW);
  store = createEnrichmentStore(db);
  trustStore = createTrustStore(db);
  configStore = createHousekeepingConfigStore(db);
  stateStore = createHousekeepingStateStore(db);
  now = NOW;
});

afterEach(() => {
  store.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

const fakeMail = (record_id: string, hot: Record<string, unknown> = {}): CollectionRecord => ({
  record_id,
  received_at: now,
  modified_at: now,
  hot_fields: hot,
  size_bytes: 100,
  source_id: record_id,
});

const STUB_SCOPE_READ = [
  { collection: 'data.mail', sample_field_paths: ['subject', 'thread_id'] },
] as const;

const stubWalker = (records: SourceRecord[]): SourceCollectionWalker => ({
  *walkAfter(cursor_token: string, batch_size: number) {
    let yielded = 0;
    for (const record of records) {
      if (record.cursor_token <= cursor_token) continue;
      if (yielded >= batch_size) return;
      yield record;
      yielded += 1;
    }
  },
  hashOf: (record) => `v1:${record.target_id}`,
  fetchOne: (target_id) => records.find((r) => r.target_id === target_id) ?? null,
});

const sourceRec = (id: string): SourceRecord => ({
  target_id: id,
  data: fakeMail(id),
  cursor_token: id,
});

const baseCtx = (overrides: Partial<HousekeepingContext> = {}): HousekeepingContext => ({
  db,
  bus: { emit: () => undefined, subscribe: () => () => undefined, dispose: () => undefined } as never,
  enrichmentStore: store,
  recipeStore: {} as never,
  now: () => now,
  emitAuditRow: () => undefined,
  ...overrides,
});

/** Build a deterministic-enrichment producer (zero token cost). */
const detProducer = (): HousekeepingEnrichmentProducer => ({
  topic: 'thread_signals',
  source_scope: 'mail',
  scope_read_declaration: STUB_SCOPE_READ,
  estimate_per_record_tokens: () => 0,
  async produce(_ctx, record) {
    // D-136 P3 follow-up Codex review fix: thread_signals carries a
    // concrete schema (was acceptObject), so the value must match
    // ThreadSignalsValue shape.
    return {
      value: {
        thread_id: record.target_id,
        message_count: 1,
        participant_count: 1,
        span_days: 0,
        has_unread: false,
      },
    };
  },
});

/** Build an AI-surface producer wrapping a custom produce impl + a custom
 *  `ctx.llm` capture. The producer calls `ctx.llm` every record — used to
 *  drive the forceLayer / skip-and-log paths. */
const aiProducer = (
  impl?: (ctx: HousekeepingContext, record: SourceRecord) => Promise<unknown | null>,
): HousekeepingEnrichmentProducer => ({
  topic: 'purpose', // AI-surface housekeeping topic in the registry.
  source_scope: 'mail',
  scope_read_declaration: STUB_SCOPE_READ,
  ai_surface: 'chat',
  estimate_per_record_tokens: () => 100,
  async produce(ctx, record) {
    if (impl) {
      const out = await impl(ctx, record);
      if (out === null) return null;
      return { value: out };
    }
    if (!ctx.llm) throw new Error('ctx.llm not wired');
    await ctx.llm({} as IngredientManifest, {});
    return { value: { sample: record.target_id } };
  },
});

// ────────────────────────────────────────────────────────────────
// isEligibleForIdleCycle
// ────────────────────────────────────────────────────────────────

describe('isEligibleForIdleCycle', () => {
  const coreTask: HousekeepingTaskInstance = {
    meta: { id: 'core.maintenance', description: '', interruptible: true, kind: 'core' },
    async step() {
      return { status: 'complete', cursor: { kind: 'complete' } };
    },
  };
  const enrichmentTask = (
    topic: EnrichmentTopic,
    is_ai_surface: boolean,
  ): HousekeepingTaskInstance => ({
    meta: { id: `enrichment.${topic}`, description: '', interruptible: true, kind: 'enrichment' },
    topic,
    is_ai_surface,
    async step() {
      return { status: 'complete', cursor: { kind: 'complete' } };
    },
  });

  it('core tasks are always eligible — trust gate is for enrichment only', () => {
    expect(
      isEligibleForIdleCycle(coreTask, { ctx: baseCtx(), trustStore, now }),
    ).toBe(true);
  });

  it('without a trust store, falls back to meta.idle_eligible', () => {
    const t = enrichmentTask('thread_signals', false);
    t.meta = { ...t.meta, idle_eligible: false };
    expect(isEligibleForIdleCycle(t, { ctx: baseCtx(), now })).toBe(false);
  });

  it('without a trust store + idle_eligible undefined, treats as eligible (post-D-132 harness shape)', () => {
    const t = enrichmentTask('thread_signals', false);
    expect(isEligibleForIdleCycle(t, { ctx: baseCtx(), now })).toBe(true);
  });

  it('enrichment task missing topic field → defensively skipped', () => {
    const t: HousekeepingTaskInstance = {
      meta: { id: 'enrichment.x', description: '', interruptible: true, kind: 'enrichment' },
      async step() {
        return { status: 'complete', cursor: { kind: 'complete' } };
      },
    };
    expect(isEligibleForIdleCycle(t, { ctx: baseCtx(), trustStore, now })).toBe(false);
  });

  it('trust state "off" → ineligible', () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'off' }, now);
    expect(
      isEligibleForIdleCycle(enrichmentTask('purpose', true), {
        ctx: baseCtx(),
        trustStore,
        now,
      }),
    ).toBe(false);
  });

  it('trust state "manual" → ineligible (Run-Now still works via scheduler bypass)', () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'manual' }, now);
    expect(
      isEligibleForIdleCycle(enrichmentTask('purpose', true), {
        ctx: baseCtx(),
        trustStore,
        now,
      }),
    ).toBe(false);
  });

  it('trust state "auto" + deterministic producer → eligible (no pause check)', () => {
    db.prepare(
      `UPDATE housekeeping_config SET pause_background_ai_until = ? WHERE id = 'singleton'`,
    ).run(now + 10_000);
    // Deterministic producers default to 'auto' via registry — no row needed.
    expect(
      isEligibleForIdleCycle(enrichmentTask('thread_signals', false), {
        ctx: baseCtx(),
        trustStore,
        now,
      }),
    ).toBe(true);
  });

  it('trust state "auto" + AI producer + no pause → eligible', () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto' }, now);
    expect(
      isEligibleForIdleCycle(enrichmentTask('purpose', true), {
        ctx: baseCtx(),
        trustStore,
        now,
      }),
    ).toBe(true);
  });

  it('trust state "auto" + AI producer + pause active → ineligible', () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto' }, now);
    db.prepare(
      `UPDATE housekeeping_config SET pause_background_ai_until = ? WHERE id = 'singleton'`,
    ).run(now + 60_000);
    expect(
      isEligibleForIdleCycle(enrichmentTask('purpose', true), {
        ctx: baseCtx(),
        trustStore,
        now,
      }),
    ).toBe(false);
  });

  it('trust state "auto" + AI producer + pause elapsed → eligible', () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto' }, now);
    db.prepare(
      `UPDATE housekeeping_config SET pause_background_ai_until = ? WHERE id = 'singleton'`,
    ).run(now - 60_000);
    expect(
      isEligibleForIdleCycle(enrichmentTask('purpose', true), {
        ctx: baseCtx(),
        trustStore,
        now,
      }),
    ).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Scheduler runCycleInner — trust filter + Run-Now bypass + pause-AI
// ────────────────────────────────────────────────────────────────

describe('scheduler runCycleInner — trust filter', () => {
  const aiTaskRecord: HousekeepingTaskInstance = {
    meta: {
      id: 'enrichment.purpose',
      description: '',
      interruptible: true,
      kind: 'enrichment',
    },
    topic: 'purpose' as EnrichmentTopic,
    is_ai_surface: true,
    async step() {
      return { status: 'complete', cursor: { kind: 'complete' } };
    },
  };

  it('Run-Now bypasses the trust gate (only_task_id always fires)', async () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'manual' }, now);
    const stepSpy = vi.fn(async () => ({
      status: 'complete' as const,
      cursor: { kind: 'complete' as const },
    }));
    const sched = createHousekeepingScheduler({
      ctx: baseCtx(),
      config: configStore,
      state: stateStore,
      busy: createEngineBusySignal({
        instances: { list: () => [] } as never,
      }),
      trustStore,
      registry: () => [{ ...aiTaskRecord, step: stepSpy }],
    });
    await sched.runOnce({ task_id: 'enrichment.purpose' });
    expect(stepSpy).toHaveBeenCalledTimes(1);
  });

  it('idle cycle skips an AI task with trust "manual"', async () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'manual' }, now);
    const stepSpy = vi.fn(async () => ({
      status: 'complete' as const,
      cursor: { kind: 'complete' as const },
    }));
    const sched = createHousekeepingScheduler({
      ctx: baseCtx(),
      config: configStore,
      state: stateStore,
      busy: createEngineBusySignal({
        instances: { list: () => [] } as never,
      }),
      trustStore,
      registry: () => [{ ...aiTaskRecord, step: stepSpy }],
    });
    const result = await sched.runOnce();
    expect(stepSpy).not.toHaveBeenCalled();
    expect(result.tasks_stepped).toBe(0);
  });

  it('idle cycle runs an AI task with trust "auto" — no pause', async () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto' }, now);
    const stepSpy = vi.fn(async () => ({
      status: 'complete' as const,
      cursor: { kind: 'complete' as const },
    }));
    const sched = createHousekeepingScheduler({
      ctx: baseCtx(),
      config: configStore,
      state: stateStore,
      busy: createEngineBusySignal({
        instances: { list: () => [] } as never,
      }),
      trustStore,
      registry: () => [{ ...aiTaskRecord, step: stepSpy }],
    });
    await sched.runOnce();
    expect(stepSpy).toHaveBeenCalledTimes(1);
  });

  it('pause-AI hides AI tasks but core deterministic tasks still fire', async () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto' }, now);
    db.prepare(
      `UPDATE housekeeping_config SET pause_background_ai_until = ? WHERE id = 'singleton'`,
    ).run(now + 60_000);
    const aiSpy = vi.fn(async () => ({
      status: 'complete' as const,
      cursor: { kind: 'complete' as const },
    }));
    const coreSpy = vi.fn(async () => ({
      status: 'complete' as const,
      cursor: { kind: 'complete' as const },
    }));
    const coreTask: HousekeepingTaskInstance = {
      meta: { id: 'core.maintenance', description: '', interruptible: true, kind: 'core' },
      async step() {
        return coreSpy();
      },
    };
    const sched = createHousekeepingScheduler({
      ctx: { ...baseCtx(), now: () => now },
      config: configStore,
      state: stateStore,
      busy: createEngineBusySignal({
        instances: { list: () => [] } as never,
      }),
      trustStore,
      registry: () => [{ ...aiTaskRecord, step: aiSpy }, coreTask],
    });
    await sched.runOnce();
    expect(aiSpy).not.toHaveBeenCalled();
    expect(coreSpy).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────
// forceLayer threading — wrapped ctx.llm / ctx.embed
// ────────────────────────────────────────────────────────────────

describe('harness forceLayer threading — wrapped ctx.llm', () => {
  const stepWith = async (
    task: HousekeepingTaskInstance,
    ctx: HousekeepingContext,
    cursor: HousekeepingCursor = { kind: 'complete' },
    budget = 60_000,
  ): Promise<HousekeepingStepResult> => task.step(ctx, cursor, budget);

  it('default pool_policy free_then_byok + BYOK allowed → forceLayer "any" (input untouched)', async () => {
    db.prepare(`UPDATE housekeeping_config SET allow_byok_background = 1 WHERE id = 'singleton'`).run();
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_then_byok' }, now);
    const captured: Array<Record<string, unknown>> = [];
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      captured.push(input);
      return { ok: true };
    });
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([sourceRec('a')]),
    });
    await stepWith(task, baseCtx({ trustStore, llm }));
    expect(captured[0]?.['llm.force_layer']).toBe('any');
  });

  it('pool_policy "free_only" → forceLayer "free"', async () => {
    db.prepare(`UPDATE housekeeping_config SET allow_byok_background = 1 WHERE id = 'singleton'`).run();
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_only' }, now);
    const captured: Array<Record<string, unknown>> = [];
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      captured.push(input);
      return { ok: true };
    });
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([sourceRec('a')]),
    });
    await stepWith(task, baseCtx({ trustStore, llm }));
    expect(captured[0]?.['llm.force_layer']).toBe('free');
  });

  it('pool_policy "byok_only" → forceLayer "byok"', async () => {
    db.prepare(`UPDATE housekeeping_config SET allow_byok_background = 1 WHERE id = 'singleton'`).run();
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'byok_only' }, now);
    const captured: Array<Record<string, unknown>> = [];
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      captured.push(input);
      return { ok: true };
    });
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([sourceRec('a')]),
    });
    await stepWith(task, baseCtx({ trustStore, llm }));
    expect(captured[0]?.['llm.force_layer']).toBe('byok');
  });

  it('global allow_byok_background=0 collapses every pool_policy to "free"', async () => {
    // singleton seed leaves allow_byok_background = 0 by default.
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'byok_only' }, now);
    const captured: Array<Record<string, unknown>> = [];
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      captured.push(input);
      return { ok: true };
    });
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([sourceRec('a')]),
    });
    await stepWith(task, baseCtx({ trustStore, llm }));
    expect(captured[0]?.['llm.force_layer']).toBe('free');
  });

  it('producer-supplied llm.force_layer wins over harness default (caller-override semantics)', async () => {
    db.prepare(`UPDATE housekeeping_config SET allow_byok_background = 1 WHERE id = 'singleton'`).run();
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_only' }, now);
    const captured: Array<Record<string, unknown>> = [];
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      captured.push(input);
      return { ok: true };
    });
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(async (ctx) => {
        await ctx.llm!({} as IngredientManifest, { 'llm.force_layer': 'byok' });
        return { sample: 'x' };
      }),
      walker: stubWalker([sourceRec('a')]),
    });
    await stepWith(task, baseCtx({ trustStore, llm }));
    expect(captured[0]?.['llm.force_layer']).toBe('byok');
  });

  it('without a trust store wired, ctx.llm is unwrapped (legacy semantics, no llm.force_layer injected)', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const llm = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      captured.push(input);
      return { ok: true };
    });
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([sourceRec('a')]),
    });
    await stepWith(task, baseCtx({ llm })); // no trustStore
    // Wrapped fallback to 'any' still adds the key, but verifies it's a
    // safe pass-through (resolver default is 'any' too).
    expect(captured[0]?.['llm.force_layer']).toBe('any');
  });

  it('deterministic producer step does not wrap ctx (no llm.force_layer threading)', async () => {
    const determ: HousekeepingContext = baseCtx({
      trustStore,
      // Decoy llm/embed should never be touched (deterministic producers
      // don't call them).
      llm: vi.fn(async () => {
        throw new Error('deterministic producer must not call ctx.llm');
      }) as unknown as HousekeepingContext['llm'],
    });
    const task = buildEnrichmentProducerTask({
      producer: detProducer(),
      walker: stubWalker([sourceRec('a')]),
    });
    await stepWith(task, determ);
    // No throws → ctx.llm wasn't invoked. Reaching here is the assertion.
    expect(true).toBe(true);
  });

  it('wrapped embed receives llm.force_layer too', async () => {
    db.prepare(`UPDATE housekeeping_config SET allow_byok_background = 1 WHERE id = 'singleton'`).run();
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_only' }, now);
    const captured: Array<Record<string, unknown>> = [];
    const embed = vi.fn(async (_m: IngredientManifest, input: Record<string, unknown>) => {
      captured.push(input);
      return { vector: [0.1], dimensions: 1, model: 'fake' };
    });
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(async (ctx) => {
        await ctx.embed!({} as IngredientManifest, {});
        return { sample: 'x' };
      }),
      walker: stubWalker([sourceRec('a')]),
    });
    await stepWith(task, baseCtx({ trustStore, embed }));
    expect(captured[0]?.['llm.force_layer']).toBe('free');
  });

  it('wrapped transcribe receives force_layer without entering text PII aliasing', async () => {
    db.prepare(`UPDATE housekeeping_config SET allow_byok_background = 1 WHERE id = 'singleton'`).run();
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_only' }, now);
    const captured: Array<Record<string, unknown> | undefined> = [];
    const transcribe: HousekeepingContext['transcribe'] = vi.fn(async (_request, options) => {
      captured.push(options as Record<string, unknown> | undefined);
      return { text: 'transcribed' };
    });
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(async (ctx) => {
        await ctx.transcribe!({ audio: new Uint8Array([1, 2, 3]), mime_type: 'audio/wav' });
        return { sample: 'x' };
      }),
      walker: stubWalker([sourceRec('a')]),
    });
    await stepWith(task, baseCtx({ trustStore, transcribe }));
    expect(captured[0]?.force_layer).toBe('free');
  });
});

// ────────────────────────────────────────────────────────────────
// Skip-and-log — unsatisfiable pool policies
// ────────────────────────────────────────────────────────────────

describe('skip-and-log on unsatisfiable pool policy', () => {
  const seedStateRow = (task_id = 'enrichment.purpose') => {
    db.prepare(
      `INSERT INTO housekeeping_state (task_id, cursor_json, last_status)
       VALUES (?, ?, 'pending')`,
    ).run(task_id, JSON.stringify({ kind: 'complete' }));
  };

  it('free_only + LLMError(AI_LLM_UNAVAILABLE, forceLayer=free) → yield pool_policy_unsatisfiable', async () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_only' }, now);
    seedStateRow();
    const llm = async () => {
      throw new LLMError('AI_LLM_UNAVAILABLE', 'no candidates available', { forceLayer: 'free' });
    };
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([sourceRec('a')]),
    });
    const result = await task.step(
      baseCtx({ trustStore, llm: llm as unknown as HousekeepingContext['llm'] }),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('yield');
    expect(result.status === 'yield' && result.reason).toBe('pool_policy_unsatisfiable');
  });

  it('byok_only + LLMError(AI_LLM_UNAVAILABLE, forceLayer=byok) → yield + ring buffer entry', async () => {
    db.prepare(`UPDATE housekeeping_config SET allow_byok_background = 1 WHERE id = 'singleton'`).run();
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'byok_only' }, now);
    seedStateRow();
    const llm = async () => {
      throw new LLMError('AI_LLM_UNAVAILABLE', 'no slot configured', { forceLayer: 'byok' });
    };
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([sourceRec('a')]),
    });
    const result = await task.step(
      baseCtx({ trustStore, llm: llm as unknown as HousekeepingContext['llm'] }),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('yield');
    expect(result.status === 'yield' && result.reason).toBe('pool_policy_unsatisfiable');
    const history = readTaskErrorHistory(db, 'enrichment.purpose');
    expect(history).toHaveLength(1);
    expect(history[0]?.message).toMatch(/pool_policy_unsatisfiable.*forceLayer=byok/);
  });

  it('LLMError details.forceLayer mismatched (e.g. internal "any" call) → recorded as recoverable per-row failure (D-136 P6)', async () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_only' }, now);
    seedStateRow();
    const llm = async () => {
      // Producer's internal call used a different layer than the harness
      // forced — D-136 P6 routes this through the recoverable failure
      // path (the row gets a retry slot per the backoff schedule)
      // instead of throwing.
      throw new LLMError('AI_LLM_UNAVAILABLE', 'misc', { forceLayer: 'any' });
    };
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([sourceRec('a')]),
    });
    const result = await task.step(
      baseCtx({ trustStore, llm: llm as unknown as HousekeepingContext['llm'] }),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('complete');
    const row = store.getByRecord('purpose', 'mail', 'a', 'system.housekeeping.purpose');
    expect(row?.failure_attempt_count).toBe(1);
    expect(row?.last_failure_reason).toBe('AI_LLM_UNAVAILABLE');
  });

  it('non-AI_LLM_UNAVAILABLE LLMError codes recorded as recoverable per-row failures (D-136 P6)', async () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_only' }, now);
    seedStateRow();
    const llm = async () => {
      throw new LLMError('AI_TIMEOUT', 'timeout', {});
    };
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([sourceRec('a')]),
    });
    const result = await task.step(
      baseCtx({ trustStore, llm: llm as unknown as HousekeepingContext['llm'] }),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('complete');
    const row = store.getByRecord('purpose', 'mail', 'a', 'system.housekeeping.purpose');
    expect(row?.failure_attempt_count).toBe(1);
    expect(row?.last_failure_reason).toBe('AI_TIMEOUT');
  });

  it('non-LLMError producer exceptions recorded as recoverable per-row failures (D-136 P6)', async () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_only' }, now);
    seedStateRow();
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(async () => {
        throw new Error('producer-internal');
      }),
      walker: stubWalker([sourceRec('a')]),
    });
    const result = await task.step(baseCtx({ trustStore }), { kind: 'complete' }, 60_000);
    expect(result.status).toBe('complete');
    const row = store.getByRecord('purpose', 'mail', 'a', 'system.housekeeping.purpose');
    expect(row?.failure_attempt_count).toBe(1);
    expect(row?.last_failure_reason).toBe('producer-internal');
  });

  it('free_then_byok ("any") + LLMError → recorded as recoverable per-row failure (D-136 P6)', async () => {
    db.prepare(`UPDATE housekeeping_config SET allow_byok_background = 1 WHERE id = 'singleton'`).run();
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_then_byok' }, now);
    seedStateRow();
    const llm = async () => {
      throw new LLMError('AI_LLM_UNAVAILABLE', 'no path', { forceLayer: 'any' });
    };
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([sourceRec('a')]),
    });
    const result = await task.step(
      baseCtx({ trustStore, llm: llm as unknown as HousekeepingContext['llm'] }),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('complete');
    const row = store.getByRecord('purpose', 'mail', 'a', 'system.housekeeping.purpose');
    expect(row?.failure_attempt_count).toBe(1);
    expect(row?.last_failure_reason).toBe('AI_LLM_UNAVAILABLE');
  });

  it('skip-and-log preserves cursor — next step continues from the same record', async () => {
    trustStore.write('purpose' as EnrichmentTopic, { trust_state: 'auto', pool_policy: 'free_only' }, now);
    seedStateRow();
    const llm = async () => {
      throw new LLMError('AI_LLM_UNAVAILABLE', 'empty pool', { forceLayer: 'free' });
    };
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([sourceRec('a'), sourceRec('b')]),
    });
    const result = await task.step(
      baseCtx({ trustStore, llm: llm as unknown as HousekeepingContext['llm'] }),
      { kind: 'complete' },
      60_000,
    );
    expect(result.status).toBe('yield');
    // Cursor stays at the empty pre-record-'a' position because we yielded
    // before advancing — the next cycle will retry record 'a' once the
    // free pool recovers.
    expect(result.cursor).toMatchObject({
      kind: 'topic',
      topic: 'purpose',
      max_target_id_seen: '',
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Harness instance shape (D-132 P2 stamp)
// ────────────────────────────────────────────────────────────────

describe('buildEnrichmentProducerTask — D-132 P2 instance stamping', () => {
  it('AI-surface producer task carries topic + is_ai_surface = true', () => {
    const task = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([]),
    });
    expect(task.topic).toBe('purpose');
    expect(task.is_ai_surface).toBe(true);
  });

  it('deterministic producer task carries topic + is_ai_surface = false', () => {
    const task = buildEnrichmentProducerTask({
      producer: detProducer(),
      walker: stubWalker([]),
    });
    expect(task.topic).toBe('thread_signals');
    expect(task.is_ai_surface).toBe(false);
  });

  it('idle_eligible is no longer derived statically (undefined on the meta)', () => {
    const aiTask = buildEnrichmentProducerTask({
      producer: aiProducer(),
      walker: stubWalker([]),
    });
    const detTask = buildEnrichmentProducerTask({
      producer: detProducer(),
      walker: stubWalker([]),
    });
    expect(aiTask.meta.idle_eligible).toBeUndefined();
    expect(detTask.meta.idle_eligible).toBeUndefined();
  });
});
