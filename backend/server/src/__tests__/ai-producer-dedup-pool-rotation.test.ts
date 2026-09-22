/** Free-pool round-robin rotation × the `runAIProducer` dedup probe.
 *
 *  🏁 REGRESSION GUARD FOR A FIXED DEFECT. The dedup condition in
 *  `ai-producer-wrapper.ts` (§1) used to require the stored row's
 *  `model_id` to equal what `resolveLLMModelId` said the NEXT call
 *  WOULD pick:
 *
 *      (probedModelId === '' || r.model_id === probedModelId)
 *
 *  ⛔ THAT COULD NEVER HOLD ON A MULTI-ENTRY FREE POOL. The probe
 *  routes through `matchLLM`, whose default strategy is
 *  `'round_robin'`, selecting `group[cursor % group.length]`
 *  (`match.ts`, `pickFromGroup`). The real executor ADVANCES that
 *  cursor after every successful call (`executor.ts` —
 *  `deps.quota.advanceCursor(cursorKey)`, keyed `free:<tier>` for
 *  pool wins); the probe only READS it (`preflight.ts`:
 *  "currentCursor reads; no advanceCursor"). So with >= 2 tied
 *  candidates the probe named a different model every cycle, the
 *  dedup key never matched again, and EVERY idle cycle recomputed
 *  EVERY row of every `auto` AI topic — with no housekeeping spend
 *  cap to absorb it (`task-token-meter.ts`: "⚠ NO CAP AND NO
 *  PERSISTENCE, deliberately"; the apparent backstop is a planner
 *  ESTIMATE).
 *
 *  Measured before the fix, on one unchanged record: a 1-entry pool
 *  cost 1 call / 250 tokens over 5 cycles; a 2-entry pool cost 5
 *  calls / 1250 tokens. The clause is now gone and `model_id` is
 *  provenance only — see the comment at the dedup site for why a
 *  pool switch is an ECONOMIC decision, not a quality signal.
 *
 *  🔑 THE ROTATION ITSELF IS STILL LIVE in the resolver, and the
 *  first describe below proves it. That is the point of keeping this
 *  file: the hazard did not go away, it merely stopped being
 *  consulted. Anything that re-introduces "what would we pick now"
 *  into a cache key brings the whole failure back.
 *
 *  🔑 `pickFromGroup` short-circuits on `group.length === 1`, so a
 *  single-entry pool was always immune. That asymmetry is the CONTROL
 *  ARM: it proves this harness can observe a dedup hit at all, so a
 *  green guard arm cannot be a harness that dedups everything.
 *
 *  ⚠ WHY THE ORIGINAL DEFECT SURVIVED THE SUITE.
 *   - `d-145-pa9-6-runai-producer-cache.test.ts` never set
 *     `resolveLLMModelId`, so `probedModelId === ''` and only the
 *     legacy arm of the condition ever ran.
 *   - `d-136-phase-3-ai-producer-wrapper.test.ts` wired a `vi.fn()`
 *     STUB, which returns a fixed string and therefore cannot
 *     rotate.
 *  Neither exercised the real resolver, which is the only thing that
 *  rotates.
 *
 *  🔑 `ctx.resolveLLMModelId` NO LONGER EXISTS. The clause was its only
 *  consumer, so D-275 deleted the ctx field, the
 *  `HousekeepingResolveModelId` type, the `wire-llm-substrate`
 *  callable and the force-layer pass-through with it. The `@recued/llm`
 *  `resolveLLMModelId` helper survives as a pure router dry-run and is
 *  what `probe` below calls directly — production no longer does.
 *
 *  🔑 WHAT IS REAL HERE vs SIMULATED.
 *  Real: `runAIProducer`, `resolveLLMModelId`, `matchLLM`,
 *  `buildAvailability`, `createQuotaTracker`, the enrichment store,
 *  the trust store, SQLite. Simulated: the HTTP call only — the fake
 *  `llmWithMeta` reproduces the two executor effects this test
 *  depends on (stamp the model the resolver picked, then advance the
 *  cursor under `free:<tier>`). `match.test.ts` simulates the same
 *  advance and labels it "executor normally does this post-success".
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  computeProducerVersionHash,
  type EnrichmentTopic,
  type IngredientManifest,
  type WebChatTab,
} from '@recued/contracts';
import {
  createQuotaTracker,
  resolveLLMModelId,
  type FreePoolEntry,
  type LLMConfig,
} from '@recued/llm';

import { runAIProducer } from '../housekeeping/ai-producer-wrapper.js';
import { createEnrichmentStore } from '../storage/enrichment-store.js';
import { ensureHousekeepingSchema } from '../housekeeping/schema.js';
import { createTrustStore } from '../housekeeping/trust-store.js';
import type { HousekeepingContext } from '../housekeeping/registry.js';

// ────────────────────────────────────────────────────────────────
// Fixtures (shape mirrors d-145-pa9-6 / d-136-phase-3)
// ────────────────────────────────────────────────────────────────

const SOURCE_EVENT_AT = 1_700_000_000_000;
const NOW = 1_700_500_000_000;
const TOPIC: EnrichmentTopic = 'purpose'; // permissive ai-classify topic
const SCOPE = 'mail' as const;
const AUTHORED_BY = 'system.housekeeping.purpose';
const INGREDIENT_SLUG = 'ai-classify';
const TOKENS_PER_CALL = 250;

/** Mirrors the executor's own key derivation for a pool win:
 *  `free:${match.resolved_hint}`. The precondition test below fails
 *  loudly and by name if this ever stops matching. */
const CURSOR_KEY = 'free:fast';

const noTabs = async (): Promise<Set<WebChatTab>> => new Set();

const manifest: IngredientManifest = {
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

/** `fast` so the resolved hint is `fast` and the cursor key is
 *  `free:fast`; `supports_json` because `ai-classify` implies
 *  `output_format: 'json'` via legacy `deriveRequires`. */
const LLM_INPUT: Record<string, unknown> = {
  'llm.data': 'shared body',
  'llm.model_hint': 'fast',
};

const poolEntry = (id: string, model: string): FreePoolEntry => ({
  id,
  type: 'api' as const,
  provider: 'openai-compatible' as const,
  model,
  api_key: 'k',
  speed: 'fast' as const,
  supports_json: true,
  enabled: true,
});

/** `n` tied free-pool candidates — identical on every ranking axis, so
 *  they land in one group and the coordination strategy is what breaks
 *  the tie. Only `model` differs, which is what `resolveLLMModelId`
 *  returns (`${provider}:${model}`). */
const mkConfig = (n: number): LLMConfig => ({
  free_pool: Array.from({ length: n }, (_, i) => poolEntry(`pool_${i + 1}`, `model-${i + 1}`)),
  free_pool_strategy: 'round_robin',
});

let dir: string;
let db: Database.Database;

const mkCtx = (config: LLMConfig) => {
  ensureHousekeepingSchema(db);
  const enrichmentStore = createEnrichmentStore(db, { now: () => NOW });
  const trustStore = createTrustStore(db);
  const quota = createQuotaTracker();

  // The REAL resolver, over the REAL quota tracker. This is the whole
  // point — a stub here cannot rotate.
  const probe = (m: IngredientManifest, i: Record<string, unknown>): Promise<string> =>
    resolveLLMModelId(m, i, { config, quota, tabProbe: noTabs });

  // Faithful stand-in for the real executor: stamp the model the
  // resolver picked, then advance the round-robin cursor. Those are
  // the only two executor effects this test depends on. `probe` here
  // is the library helper, called directly — it is no longer reachable
  // from a `HousekeepingContext`.
  const llmWithMeta = vi.fn(async (m: IngredientManifest, i: Record<string, unknown>) => {
    const model_id = await probe(m, i);
    quota.advanceCursor(CURSOR_KEY);
    return { result: aiResponse, model_id };
  });

  const ctx: HousekeepingContext = {
    db,
    bus: { emit: vi.fn() } as unknown as HousekeepingContext['bus'],
    enrichmentStore,
    recipeStore: {} as HousekeepingContext['recipeStore'],
    now: () => NOW,
    emitAuditRow: vi.fn(),
    llmWithMeta,
    trustStore,
  };
  return { ctx, quota, probe, llmWithMeta, enrichmentStore };
};

/** One unchanged record, re-presented every cycle — the steady state a
 *  housekeeping idle cycle sees when nothing about the mail changed. */
const buildInput = (ctx: HousekeepingContext) => {
  const target_id = 'mail_record_001';
  const source_record_hash = `src_${target_id}`;
  return {
    ctx,
    topic: TOPIC,
    scope: SCOPE,
    target_id,
    authored_by: AUTHORED_BY,
    source_record_hash,
    inputFingerprint: {
      kind: 'per_record_source_hash' as const,
      source_record_hash,
    },
    // 🔑 `model_id: ''` MIRRORS PRODUCTION, AND THE EMPTY STRING IS THE
    // POINT. 21 of 22 shipped producers compose their version hash this
    // way (`summary.ts`: "`model_id` is captured per-call via
    // `ctx.llmWithMeta` and stamped on the row") — the model is
    // provenance, never part of the dedup key. A non-empty constant
    // here would still hold steady across cycles and the guard would
    // still pass, but it would stop matching how producers actually
    // compose the hash, and the next reader could not tell which
    // property the arms depend on.
    //
    // ⚠ `embedding.ts` is the ONE deliberate exception: it folds the
    // resolved model in so cross-model vectors partition (audit §20.2).
    // That one SHOULD invalidate on a model change — vectors from
    // different models are not comparable — and it reads the dedicated
    // `embeddings_slot`, not the chat slots or the pool.
    producer_version_hash: computeProducerVersionHash({
      producer_code_hash: 'pc1',
      model_id: '',
      prompt_template_hash: 'pt1',
      adapter_version: '@recued/llm@1.0.0',
      consumed_ingredients_versions: [],
    }),
    ingredient_slug: INGREDIENT_SLUG,
    eventClock: { event_at: SOURCE_EVENT_AT },
    manifest,
    llmInput: LLM_INPUT,
    validate: (raw: unknown) => raw as typeof aiResponse,
    buildValue: (r: typeof aiResponse) => ({
      category: r.category,
      confidence: r.confidence,
      reasoning: r.reasoning,
    }),
    token_estimate: TOKENS_PER_CALL,
  };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dedup-pool-rotation-'));
  db = new Database(join(dir, 'test.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────
// 0. Preconditions — a failure in EITHER makes the arms below
//    uninterpretable, so each names its own cause.
// ────────────────────────────────────────────────────────────────

describe('the rotation hazard is still live in the resolver', () => {
  it('two tied entries: one cursor advance changes the resolved model', async () => {
    const { quota, probe } = mkCtx(mkConfig(2));

    const first = await probe(manifest, LLM_INPUT);
    expect(
      first,
      'resolver returned "" — it threw internally and took its catch path, so the dedup '
        + 'condition falls back to the legacy `probedModelId === ""` arm and the arms below '
        + 'would prove nothing about rotation',
    ).not.toBe('');

    quota.advanceCursor(CURSOR_KEY);
    const second = await probe(manifest, LLM_INPUT);

    expect(
      second,
      `probe did not rotate (${first} -> ${second}). Either CURSOR_KEY '${CURSOR_KEY}' no `
        + 'longer matches the executor\'s `free:<tier>` derivation, or the two entries did not '
        + 'tie into a single candidate group. If rotation has genuinely stopped, the guard arms '
        + 'below are vacuous — they would pass against the ORIGINAL buggy condition too',
    ).not.toBe(first);
  });

  it('single entry: the cursor is never consulted, so the probe is stable', async () => {
    const { quota, probe } = mkCtx(mkConfig(1));
    const first = await probe(manifest, LLM_INPUT);
    expect(first).not.toBe('');
    quota.advanceCursor(CURSOR_KEY);
    expect(await probe(manifest, LLM_INPUT)).toBe(first);
  });
});

// ────────────────────────────────────────────────────────────────
// 1. Control arm — proves the harness CAN see a dedup hit.
// ────────────────────────────────────────────────────────────────

describe('control — single-entry pool dedups across cycles', () => {
  it('two cycles over an unchanged record → exactly one model call', async () => {
    const { ctx, llmWithMeta } = mkCtx(mkConfig(1));

    const cycle1 = await runAIProducer(buildInput(ctx));
    expect(cycle1.status).toBe('computed');

    const cycle2 = await runAIProducer(buildInput(ctx));
    expect(
      cycle2.status,
      'the control arm did not dedup — this harness cannot observe a dedup hit at all, so the '
        + 'hypothesis arm below is not evidence of anything',
    ).toBe('dedup_hit');

    expect(llmWithMeta).toHaveBeenCalledTimes(1);
    expect(cycle2.tokens_consumed).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. Hypothesis arm — same record, same everything, one more tied
//    pool entry. The ONLY difference from the control is pool size.
// ────────────────────────────────────────────────────────────────

describe('guard — a rotating pool no longer forces recompute', () => {
  it('two cycles over an unchanged record → still exactly one model call', async () => {
    const { ctx, llmWithMeta, enrichmentStore } = mkCtx(mkConfig(2));

    const cycle1 = await runAIProducer(buildInput(ctx));
    expect(cycle1.status).toBe('computed');

    const cycle2 = await runAIProducer(buildInput(ctx));

    // Pre-fix this was `computed` + a second call, because the probe
    // named `…:model-2` while the row held `…:model-1`.
    expect(cycle2.status).toBe('dedup_hit');
    expect(llmWithMeta).toHaveBeenCalledTimes(1);
    expect(cycle2.tokens_consumed).toBe(0);

    // Provenance stays pinned to whatever actually computed the value
    // — it no longer chases the rotation.
    const rows = enrichmentStore.list({
      topic: TOPIC,
      scope: SCOPE,
      target_id: 'mail_record_001',
      authored_by: AUTHORED_BY,
      limit: 1,
    });
    expect(rows[0]?.model_id).toBe('openai-compatible:model-1');
  });

  it('steady state over 5 cycles → 1 call, 250 tokens (was 5 / 1250)', async () => {
    const { ctx, llmWithMeta } = mkCtx(mkConfig(2));

    let spent = 0;
    for (let i = 0; i < 5; i += 1) {
      const out = await runAIProducer(buildInput(ctx));
      spent += out.tokens_consumed;
    }

    // Steady-state cost of one unchanged record under an idle cycle,
    // now identical to the single-entry control arm.
    expect(llmWithMeta).toHaveBeenCalledTimes(1);
    expect(spent).toBe(TOKENS_PER_CALL);
  });


  it('two entries resolving to the SAME model id dedup too — this was the one '
    + 'rotating case that already worked, and still does', async () => {
    // Pre-fix this arm was the discriminator: same group size and same
    // rotation as the failing arm, with only the resolved
    // `provider:model` string held constant, which isolated the cause
    // to the probed id rather than to pool size. Post-fix it is a
    // plain non-regression check on the case that never broke.
    const config: LLMConfig = {
      free_pool: [poolEntry('pool_1', 'same-model'), poolEntry('pool_2', 'same-model')],
      free_pool_strategy: 'round_robin',
    };
    // First, confirm rotation still HAPPENS here — it is just
    // invisible in the resolved id. Its own tracker, so this check
    // does not advance the cursor the producer run below reads.
    const rotationCheck = mkCtx(config);
    const before = await rotationCheck.probe(manifest, LLM_INPUT);
    rotationCheck.quota.advanceCursor(CURSOR_KEY);
    expect(await rotationCheck.probe(manifest, LLM_INPUT)).toBe(before);

    const { ctx, llmWithMeta } = mkCtx(config);
    await runAIProducer(buildInput(ctx));
    const cycle2 = await runAIProducer(buildInput(ctx));

    expect(cycle2.status).toBe('dedup_hit');
    expect(llmWithMeta).toHaveBeenCalledTimes(1);
  });

  it('a 3-entry pool behaves the same — group size is not a factor', async () => {
    const { ctx, llmWithMeta } = mkCtx(mkConfig(3));
    for (let i = 0; i < 3; i += 1) await runAIProducer(buildInput(ctx));
    expect(llmWithMeta).toHaveBeenCalledTimes(1);
  });
});
