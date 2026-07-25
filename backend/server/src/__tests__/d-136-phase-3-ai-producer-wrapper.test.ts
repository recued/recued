/** D-136 Phase 3 — `runAIProducer` wrapper.
 *
 *  Locks the dedup-+-trust-+-LLM-+-upsert pipeline per spec §A.3:
 *    - per-record degenerate: input_fingerprint_hash = source_record_hash
 *    - dedup-hit on second call: zero token cost, no re-upsert
 *    - dedup-miss when input_fingerprint_hash bumps (e.g. window override)
 *    - dedup-miss when producer_version_hash bumps
 *    - trust gate `'off'` short-circuits before the LLM call
 *    - validate() throws → wrapper re-throws
 *    - upsert stamps event_at from source's clock (NOT ctx.now())
 *    - upsert stamps model_id from `ctx.llmWithMeta` resolution
 *    - upsert stamps ingredient_slug + producer_version_hash +
 *      input_fingerprint_hash
 *
 *  Spec: `docs/d-136-spec.md` §A.3. */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeProducerVersionHash,
  type EnrichmentTopic,
  type IngredientManifest,
} from '@recued/contracts';

import { runAIProducer } from '../housekeeping/ai-producer-wrapper.js';
import { createEnrichmentStore } from '../storage/enrichment-store.js';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import { createTrustStore } from '../housekeeping/trust-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

const SOURCE_EVENT_AT = 1_700_000_000_000; // mail Date: header
const NOW = 1_700_500_000_000; // producer compute time (5e8 ms after source)
const TARGET_ID = 'mail_record_001';
const TOPIC: EnrichmentTopic = 'purpose'; // stable_truth + scenario + per-record AI surface
const SCOPE = 'mail' as const;
const AUTHORED_BY = 'system.housekeeping.purpose';
const SOURCE_RECORD_HASH = 'src_abc123';
const INGREDIENT_SLUG = 'ai-classify';

const baseManifest: IngredientManifest = {
  slug: 'ai-classify',
  name: 'AI Classifier',
  description: 'test',
  author: 'recued-core',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  tags: [],
  input: {},
  output: {},
};

const aiResponse = { category: 'request', confidence: 0.92, reasoning: 'asks for action' };

const buildInput = (
  ctx: HousekeepingContext,
  overrides: Partial<{
    producer_version_hash: string;
    source_record_hash: string;
    eventAt: number | null;
  }> = {},
) => ({
  ctx,
  topic: TOPIC,
  scope: SCOPE,
  target_id: TARGET_ID,
  authored_by: AUTHORED_BY,
  source_record_hash: overrides.source_record_hash ?? SOURCE_RECORD_HASH,
  inputFingerprint: {
    kind: 'per_record_source_hash' as const,
    source_record_hash: overrides.source_record_hash ?? SOURCE_RECORD_HASH,
  },
  producer_version_hash:
    overrides.producer_version_hash ??
    computeProducerVersionHash({
      producer_code_hash: 'pc1',
      model_id: 'openai:gpt-4o-mini',
      prompt_template_hash: 'pt1',
      adapter_version: '@recued/llm@1.0.0',
      consumed_ingredients_versions: [],
    }),
  ingredient_slug: INGREDIENT_SLUG,
  eventClock: { event_at: overrides.eventAt === undefined ? SOURCE_EVENT_AT : overrides.eventAt },
  manifest: baseManifest,
  llmInput: { 'llm.data': 'hi' },
  validate: (raw: unknown) => raw as typeof aiResponse,
  buildValue: (r: typeof aiResponse) => ({
    category: r.category,
    confidence: r.confidence,
    reasoning: r.reasoning,
  }),
  token_estimate: 250,
});

let dir: string;
let db: Database.Database;

const mkCtx = (overrides?: {
  llmWithMetaImpl?: HousekeepingContext['llmWithMeta'];
  resolveLLMModelIdImpl?: HousekeepingContext['resolveLLMModelId'];
}) => {
  ensureHousekeepingSchema(db);
  const enrichmentStore = createEnrichmentStore(db, { now: () => NOW });
  const trustStore = createTrustStore(db);
  const llmWithMeta = vi.fn(
    overrides?.llmWithMetaImpl ??
      (async (_m: IngredientManifest, _i: Record<string, unknown>) => ({
        result: aiResponse,
        model_id: 'openai:gpt-4o-mini',
      })),
  );
  const resolveLLMModelId = overrides?.resolveLLMModelIdImpl
    ? vi.fn(overrides.resolveLLMModelIdImpl)
    : undefined;
  const ctx: HousekeepingContext = {
    db,
    bus: { emit: vi.fn() } as unknown as HousekeepingContext['bus'],
    enrichmentStore,
    recipeStore: {} as HousekeepingContext['recipeStore'],
    now: () => NOW,
    emitAuditRow: vi.fn(),
    llmWithMeta,
    ...(resolveLLMModelId ? { resolveLLMModelId } : {}),
    trustStore,
  };
  return { ctx, enrichmentStore, trustStore, llmWithMeta, resolveLLMModelId };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'd-136-wrapper-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('D-136 §A.3 — runAIProducer per-record degenerate', () => {
  it("computes input_fingerprint_hash = source_record_hash on first call (per_record_source_hash kind)", async () => {
    const { ctx, enrichmentStore, llmWithMeta } = mkCtx();
    const out = await runAIProducer(buildInput(ctx));
    expect(out.status).toBe('computed');
    expect(llmWithMeta).toHaveBeenCalledOnce();

    const rows = enrichmentStore.list({
      topic: TOPIC,
      scope: SCOPE,
      target_id: TARGET_ID,
      authored_by: AUTHORED_BY,
      limit: 5,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input_fingerprint_hash).toBe(SOURCE_RECORD_HASH);
    expect(rows[0]!.source_record_hash).toBe(SOURCE_RECORD_HASH);
  });

  it('dedup hit on second call with identical fingerprint + producer_version → zero tokens, no LLM call', async () => {
    const { ctx, llmWithMeta } = mkCtx();
    await runAIProducer(buildInput(ctx));
    expect(llmWithMeta).toHaveBeenCalledTimes(1);

    const second = await runAIProducer(buildInput(ctx));
    expect(second.status).toBe('dedup_hit');
    expect(second.rows_written).toBe(0);
    expect(second.tokens_consumed).toBe(0);
    expect(llmWithMeta).toHaveBeenCalledTimes(1); // unchanged
  });

  it('dedup miss when source_record_hash flips (input_fingerprint_hash flips with it)', async () => {
    const { ctx, llmWithMeta } = mkCtx();
    await runAIProducer(buildInput(ctx));
    expect(llmWithMeta).toHaveBeenCalledTimes(1);

    const second = await runAIProducer(
      buildInput(ctx, { source_record_hash: 'src_xyz999' }),
    );
    expect(second.status).toBe('computed');
    expect(llmWithMeta).toHaveBeenCalledTimes(2);
  });

  it('dedup miss when producer_version_hash bumps (model upgrade, prompt revision)', async () => {
    const { ctx, llmWithMeta } = mkCtx();
    await runAIProducer(buildInput(ctx));
    expect(llmWithMeta).toHaveBeenCalledTimes(1);

    const bumped = computeProducerVersionHash({
      producer_code_hash: 'pc2', // bumped
      model_id: 'openai:gpt-4o-mini',
      prompt_template_hash: 'pt1',
      adapter_version: '@recued/llm@1.0.0',
      consumed_ingredients_versions: [],
    });
    const second = await runAIProducer(
      buildInput(ctx, { producer_version_hash: bumped }),
    );
    expect(second.status).toBe('computed');
    expect(llmWithMeta).toHaveBeenCalledTimes(2);
  });
});

describe('D-136 §A.3 — runAIProducer trust gate', () => {
  it("returns 'skipped_trust' when trust_state is 'off'", async () => {
    const { ctx, trustStore, llmWithMeta } = mkCtx();
    trustStore.write(TOPIC, { trust_state: 'off' }, NOW);
    const out = await runAIProducer(buildInput(ctx));
    expect(out.status).toBe('skipped_trust');
    expect(out.rows_written).toBe(0);
    expect(out.tokens_consumed).toBe(0);
    expect(llmWithMeta).not.toHaveBeenCalled();
  });

  it("does NOT skip when trust_state is 'manual'", async () => {
    const { ctx, trustStore, llmWithMeta } = mkCtx();
    trustStore.write(TOPIC, { trust_state: 'manual' }, NOW);
    const out = await runAIProducer(buildInput(ctx));
    expect(out.status).toBe('computed');
    expect(llmWithMeta).toHaveBeenCalledOnce();
  });
});

describe('D-136 §A.3 — runAIProducer bistemporal stamping (audit §20.2 fix)', () => {
  it("stamps event_at from source's own clock, NOT ctx.now()", async () => {
    const { ctx, enrichmentStore } = mkCtx();
    await runAIProducer(buildInput(ctx));
    const rows = enrichmentStore.list({
      topic: TOPIC,
      scope: SCOPE,
      target_id: TARGET_ID,
      authored_by: AUTHORED_BY,
      limit: 1,
    });
    expect(rows[0]!.event_at).toBe(SOURCE_EVENT_AT);
    expect(rows[0]!.event_at).not.toBe(NOW); // explicit anti-regression for audit §20.2
  });

  it("falls back to ctx.now() when eventClock.event_at is null (defensible default)", async () => {
    const { ctx, enrichmentStore } = mkCtx();
    await runAIProducer(buildInput(ctx, { eventAt: null }));
    const rows = enrichmentStore.list({
      topic: TOPIC,
      scope: SCOPE,
      target_id: TARGET_ID,
      authored_by: AUTHORED_BY,
      limit: 1,
    });
    expect(rows[0]!.event_at).toBe(NOW);
  });

  it('stamps as_of and last_evaluated_at from ctx.now() (producer compute time)', async () => {
    const { ctx, enrichmentStore } = mkCtx();
    await runAIProducer(buildInput(ctx));
    const rows = enrichmentStore.list({
      topic: TOPIC,
      scope: SCOPE,
      target_id: TARGET_ID,
      authored_by: AUTHORED_BY,
      limit: 1,
    });
    expect(rows[0]!.as_of).toBe(NOW);
    expect(rows[0]!.last_evaluated_at).toBe(NOW);
  });
});

describe('D-136 §A.3 — runAIProducer model_id capture', () => {
  it('stamps model_id from ctx.llmWithMeta() return value', async () => {
    const { ctx, enrichmentStore } = mkCtx({
      llmWithMetaImpl: async () => ({
        result: aiResponse,
        model_id: 'anthropic:claude-haiku-4-5',
      }),
    });
    await runAIProducer(buildInput(ctx));
    const rows = enrichmentStore.list({
      topic: TOPIC,
      scope: SCOPE,
      target_id: TARGET_ID,
      authored_by: AUTHORED_BY,
      limit: 1,
    });
    expect(rows[0]!.model_id).toBe('anthropic:claude-haiku-4-5');
    expect(rows[0]!.ingredient_slug).toBe(INGREDIENT_SLUG); // distinct from model_id
  });

  it('returns the resolved model_id on the computed outcome', async () => {
    const { ctx } = mkCtx({
      llmWithMetaImpl: async () => ({
        result: aiResponse,
        model_id: 'openai:gpt-4o-mini',
      }),
    });
    const out = await runAIProducer(buildInput(ctx));
    expect(out.status).toBe('computed');
    if (out.status === 'computed') {
      expect(out.model_id).toBe('openai:gpt-4o-mini');
      expect(out.tokens_consumed).toBe(250);
    }
  });
});

describe('D-136 §A.3 — runAIProducer cross-model dedup invalidation (Codex item 2)', () => {
  it('dedup miss when resolveLLMModelId probe returns a different model than the existing row', async () => {
    // First cycle: resolves to free-pool Groq
    const groqProbe = vi.fn(async () => 'groq:llama-3.1-70b-versatile');
    const { ctx: ctxGroq, llmWithMeta: llmGroq } = mkCtx({
      llmWithMetaImpl: async () => ({
        result: aiResponse,
        model_id: 'groq:llama-3.1-70b-versatile',
      }),
      resolveLLMModelIdImpl: groqProbe as unknown as HousekeepingContext['resolveLLMModelId'],
    });
    const first = await runAIProducer(buildInput(ctxGroq));
    expect(first.status).toBe('computed');
    expect(llmGroq).toHaveBeenCalledTimes(1);

    // Second cycle on the SAME db: probe now resolves to BYOK Anthropic.
    // Existing row's model_id is groq:..., probe says anthropic:... →
    // dedup miss → recompute fires.
    const anthropicProbe = vi.fn(async () => 'anthropic:claude-haiku-4-5');
    const llmAnthropic = vi.fn(async () => ({
      result: aiResponse,
      model_id: 'anthropic:claude-haiku-4-5',
    }));
    const ctxAnthropic: HousekeepingContext = {
      ...ctxGroq,
      llmWithMeta: llmAnthropic,
      resolveLLMModelId:
        anthropicProbe as unknown as HousekeepingContext['resolveLLMModelId'],
    };
    const second = await runAIProducer(buildInput(ctxAnthropic));
    expect(second.status).toBe('computed');
    expect(llmAnthropic).toHaveBeenCalledTimes(1);
    expect(anthropicProbe).toHaveBeenCalledOnce();
  });

  it('dedup HIT when probe returns the same model as existing row (steady-state cycle)', async () => {
    const stableProbe = vi.fn(async () => 'openai:gpt-4o-mini');
    const { ctx, llmWithMeta } = mkCtx({
      llmWithMetaImpl: async () => ({ result: aiResponse, model_id: 'openai:gpt-4o-mini' }),
      resolveLLMModelIdImpl: stableProbe as unknown as HousekeepingContext['resolveLLMModelId'],
    });
    await runAIProducer(buildInput(ctx));
    expect(llmWithMeta).toHaveBeenCalledTimes(1);

    const second = await runAIProducer(buildInput(ctx));
    expect(second.status).toBe('dedup_hit');
    // No new LLM call — steady state holds because probe's answer matches the row.
    expect(llmWithMeta).toHaveBeenCalledTimes(1);
  });

  it("falls through to legacy dedup (no model match) when ctx.resolveLLMModelId is unwired", async () => {
    // Without the probe, dedup stays on (input_fingerprint, producer_version)
    // — same model assumption holds. Tests that pre-D-136 ctx instances
    // keep working unchanged.
    const { ctx, llmWithMeta } = mkCtx();
    await runAIProducer(buildInput(ctx));
    const second = await runAIProducer(buildInput(ctx));
    expect(second.status).toBe('dedup_hit');
    expect(llmWithMeta).toHaveBeenCalledTimes(1);
  });

  it("falls through to legacy dedup when probe returns empty string (no AI path resolved)", async () => {
    // Probe returns '' when no path resolves — wrapper falls back to
    // legacy 2-field match so the call still fires (executeLLM throws
    // AI_LLM_UNAVAILABLE downstream; that's the actual unavailability
    // signal, not the probe's empty string).
    const emptyProbe = vi.fn(async () => '');
    const { ctx, llmWithMeta } = mkCtx({
      resolveLLMModelIdImpl: emptyProbe as unknown as HousekeepingContext['resolveLLMModelId'],
    });
    await runAIProducer(buildInput(ctx));
    const second = await runAIProducer(buildInput(ctx));
    expect(second.status).toBe('dedup_hit'); // legacy 2-field match still hits
    expect(llmWithMeta).toHaveBeenCalledTimes(1);
  });
});

describe('D-136 §A.3 — runAIProducer error propagation', () => {
  it('throws when ctx.llmWithMeta is unwired', async () => {
    const { ctx } = mkCtx();
    const ctxNoLlm: HousekeepingContext = { ...ctx, llmWithMeta: undefined };
    await expect(
      runAIProducer({ ...buildInput(ctx), ctx: ctxNoLlm } as any),
    ).rejects.toThrow(/runAIProducer_misconfigured/);
  });

  it('re-throws validation failures from validate()', async () => {
    const { ctx } = mkCtx();
    const validate = vi.fn(() => {
      throw new Error('purpose_output_invalid: bad shape');
    });
    await expect(
      runAIProducer({ ...buildInput(ctx), validate } as any),
    ).rejects.toThrow(/purpose_output_invalid/);
  });
});
