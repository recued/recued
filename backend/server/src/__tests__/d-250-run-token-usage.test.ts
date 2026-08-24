/** D-250 § D — a run that spent tokens and a run that spent none stop being the
 *  same audit row.
 *
 *  WHY THIS EXISTS. Per-turn token usage was already durable for CHAT — the
 *  `chat_message_sent` activity row carries a full `TokenUsageReport`, and its
 *  write site says it is there for "the benchmark + future billing surface".
 *  The engine had no equivalent, so every leverage question ("runs per AI op",
 *  "tokens per op", "what does this recipe cost me") could be asked of chat and
 *  not of automation, which is where recipes actually run. The daily counter in
 *  `llm_config` is not that record: it answers a hot-path GATE question
 *  (`isOverBudget`), so it is one scalar with no run, recipe or channel
 *  attribution — and it does not see chat at all.
 *
 *  ⛔⛔ THE JOIN IS THE TEST, AND EVERYTHING ELSE HERE IS SUPPORTING. The field
 *  crosses FOUR seams that can each drop it with no type error: the adapter
 *  records under `stepMeta.run_id`, the handler claims under the run's own
 *  `run_id`, `buildAuditEntry` is an ENUMERATING COPIER (its own comment records
 *  four fields already lost exactly there), and `projectAuditSummary` is a
 *  second hand-written copier a layer up. A unit test of the sink would pass
 *  while the number reached nobody, and — worse — so would a `handleExecute`
 *  test whose stub adapter called the sink itself, since the two keys would then
 *  come from the same place instead of from opposite ends of the real run.
 *  ⇒ § 1 drives a REAL run and asserts the ANCHOR: the only shape in which
 *  "recorded under A, read under B" can fail.
 *  ⇒ [[feedback_two_suites_stubbing_the_same_boundary_cover_everything_but_the_join]]
 *
 *  ⚠ WHAT IS FAKED IS THE PROVIDER, NEVER THE WIRING. `executeLLM` is mocked to
 *  invoke the `onTokenUsage` callback it is handed — the callback IS the
 *  contract, and `packages/llm` covers that providers invoke it. Everything
 *  between that callback and the audit row is real: `emitUsage`,
 *  `tokenUsageToReport`, the sink, `stepMeta` propagation, `buildAuditEntry`.
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Checkpoint,
  Commit,
  IngredientManifest,
  RecipeDefinition,
  TokenUsageReport,
} from '@recued/contracts';
import {
  buildAuditEntry,
  createAuditLogStore,
  createCheckpointStore,
  createCommitStore,
  createInMemoryCollection,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';

import { ensureMemorySchema } from '../memory-schema.js';
import {
  handleExecutionGet,
  type ExecutionFeedRpcDeps,
} from '../execution-feed-handler.js';

import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';
import {
  createRunTokenUsageSink,
  RUN_TOKEN_USAGE_MAX_ENTRIES,
  type RunTokenUsageSink,
} from '../run-token-usage.js';

/** One provider call's worth of usage, in the LLM layer's internal shape. */
const PROVIDER_USAGE = {
  input_tokens: 120,
  output_tokens: 30,
  total_tokens: 150,
  model_id: 'test-model',
};

const llmMocks = vi.hoisted(() => ({
  executeLLM: vi.fn(
    async (
      _manifest: unknown,
      _input: unknown,
      opts: { onTokenUsage?: (u: Record<string, unknown>) => void },
    ) => {
      // ⛔ THE ONE THING THE FAKE DOES: invoke the callback the real adapter
      // handed it, exactly as a provider result would. It does NOT touch the
      // sink — if it did, this file would be asserting its own bookkeeping.
      opts.onTokenUsage?.({ ...PROVIDER_USAGE });
      return { result: 'summarised' };
    },
  ),
}));

vi.mock('@recued/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@recued/llm')>();
  return { ...actual, executeLLM: llmMocks.executeLLM };
});

// ────────────────────────────────────────────────────────────────
// 1. THE JOIN — a real run records and claims under one run_id
// ────────────────────────────────────────────────────────────────

/** `kind:'ai'` + no `output.vector` → the non-kernel `'ai'` adapter
 *  (`createLLMAdapter`), chat branch.
 *
 *  ⚠ NEITHER `recued` NOR `core-*`, and both exclusions are load-bearing.
 *  Kernel routing keys off `author === 'recued'` (that adapter has no AI
 *  handler), and `manifest-loader`'s §5 anti-shadow guard makes `register()` a
 *  SILENT NO-OP for any `core-*` slug — a first draft of this file used
 *  `core-ai-summarize` and the step failed `INGREDIENT_NOT_FOUND` inside a
 *  `foreach`, where continue-on-error reported the run `succeeded`. It was
 *  `run_yield.items_failed` that gave it away. */
const AI_SLUG = 'testpub-ai-summarize';

const aiManifest = (): IngredientManifest => ({
  slug: AI_SLUG,
  name: 'AI summarize',
  description: 'Summarises one row.',
  author: 'testpub',
  kind: 'ai',
  category: 'ai',
  risk_tier: 'read',
  version: 1,
  input: {},
  output: { result: 'summary' },
} as unknown as IngredientManifest);

const httpManifest = (): IngredientManifest => ({
  slug: 'no-ai-http',
  name: 'No-AI probe',
  description: 'Posts one row.',
  author: 'test',
  kind: 'http',
  category: 'action',
  risk_tier: 'write',
  version: 1,
  input: { method: 'POST', url: 'https://example.test/ok' },
  output: { ok: 'ok' },
} as unknown as IngredientManifest);

const aiRecipe = (): RecipeDefinition => ({
  recipe_id: 'token-usage-ai',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Token usage', description: 'Summarises each row.',
    author: 'test', supported_platforms: ['test'], tags: ['test'],
  },
  variables: { rows: { label: 'Rows', type: 'array', default: [] } },
  prefetch_steps: [],
  steps: [{
    id: 'summarise_one',
    ingredient: AI_SLUG,
    input: { 'llm.data': 'hello' },
  }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

/** The same AI ingredient under a `foreach` — N provider calls in one run. */
const aiForeachRecipe = (): RecipeDefinition => ({
  recipe_id: 'token-usage-ai-each',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Token usage each', description: 'Summarises each row.',
    author: 'test', supported_platforms: ['test'], tags: ['test'],
  },
  variables: { rows: { label: 'Rows', type: 'array', default: [] } },
  prefetch_steps: [],
  steps: [{
    id: 'summarise_each',
    ingredient: AI_SLUG,
    input: { 'llm.data': '{{item.id}}' },
    foreach: '{{config.rows}}',
  }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

const noAiRecipe = (): RecipeDefinition => ({
  recipe_id: 'token-usage-none',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'No AI', description: 'Writes one row.',
    author: 'test', supported_platforms: ['test'], tags: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'write', ingredient: 'no-ai-http', input: {} }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

/** Drive a REAL run and return the anchor it wrote. The sink is the production
 *  default the config builds — nothing here pre-seeds it, so the only way
 *  `total_usage` lands is the adapter→sink→handler round trip. */
const runReal = async (
  recipe: RecipeDefinition,
  config: Record<string, unknown>,
): Promise<AuditEntry | undefined> => {
  const registry = createManifestRegistry('/nonexistent');
  registry.register(aiManifest());
  registry.register(httpManifest());
  const recipeStore = createRecipeStore('/nonexistent');
  recipeStore.register(recipe);
  const log = createAuditLogStore(
    createInMemoryCollection<AuditEntry>(),
    createInMemoryCollection(),
  );
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ ok: true }),
    text: async () => JSON.stringify({ ok: true }),
  })) as unknown as typeof fetch;
  try {
    await handleExecute({
      recipeStore,
      executorConfig: {
        manifests: registry,
        // Any truthy config: the adapter refuses with AI_LLM_UNAVAILABLE when
        // none is resolvable, and `executeLLM` (mocked) never reads it.
        llmConfig: { slot_1: { provider: 'openai-compatible', model: 'test-model' } },
        runTokenUsage: createRunTokenUsageSink(),
      },
      baseVault: {},
      instanceId: 'token-usage-test',
      auditLog: log,
    } as unknown as ExecuteHandlerDeps, {
      recipe_id: recipe.recipe_id,
      trigger_source: 'manual',
      config,
    } as never);
  } finally {
    globalThis.fetch = original;
  }
  return (await log.listRecent(10))[0];
};

describe('D-250 § D — the wiring: a real run stamps what it spent', () => {
  beforeEach(() => { llmMocks.executeLLM.mockClear(); });

  it('⛔⛔ THE JOIN — one AI call, and the anchor carries its tokens', async () => {
    const entry = await runReal(aiRecipe(), { rows: [{ id: 'a' }] });
    expect(entry).toBeDefined();
    expect(entry?.commit_status).toBe('succeeded');
    // The adapter recorded under `stepMeta.run_id`; the handler claimed under
    // the run's `run_id`. Nothing in this test supplied either — if they were
    // ever different keys, this is undefined and every metric reads empty.
    expect(entry?.total_usage).toBeDefined();
    expect(entry?.total_usage?.total_tokens).toBe(150);
    expect(entry?.total_usage?.input_tokens).toBe(120);
    expect(entry?.total_usage?.output_tokens).toBe(30);
  });

  it('a SINGLE call is annotated `provider_calls: 1`, not left absent', async () => {
    // The aggregator's single-report path normalises this; a consumer plotting
    // tokens-per-call cannot tell "one call" from "unannotated" otherwise.
    const entry = await runReal(aiRecipe(), { rows: [{ id: 'a' }] });
    expect(entry?.total_usage?.provider_calls).toBe(1);
  });

  it('⛔ THREE CALLS IN ONE RUN AGGREGATE — a foreach is not one call', async () => {
    // The failure this rules out is per-item work reported as a single call,
    // which would make `runs per AI op` flatter the busiest recipes most.
    const entry = await runReal(aiForeachRecipe(), {
      rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    });
    expect(llmMocks.executeLLM).toHaveBeenCalledTimes(3);
    expect(entry?.total_usage?.provider_calls).toBe(3);
    expect(entry?.total_usage?.total_tokens).toBe(450);
    // And the yield agrees about the item count — the pair is what makes
    // "one provider call per item" visible at all.
    expect(entry?.run_yield?.items_total).toBe(3);
  });

  it('⛔ A RUN WITH NO AI CALL LEAVES IT ABSENT — never a fabricated zero', async () => {
    // Absent is the common case and it means "spent nothing". A row of zeros
    // would be indistinguishable from a real measurement of zero, and would
    // cost bytes on the majority of rows in a log that evicts oldest-first.
    const entry = await runReal(noAiRecipe(), {});
    expect(entry).toBeDefined();
    expect(entry?.commit_status).toBe('succeeded');
    expect(entry?.total_usage).toBeUndefined();
    // ⚠ The yield is still present-and-populated on the same row: the two
    // fields take OPPOSITE emit rules, and this is the row that proves it.
    expect(entry?.run_yield).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 2. THE COPIER — the seam that has silently swallowed four fields
// ────────────────────────────────────────────────────────────────

const USAGE: TokenUsageReport = {
  input_tokens: 10, output_tokens: 5, total_tokens: 15, provider_calls: 1,
};

const anchor = (run_id: string, patch: Partial<AuditEntry> = {}): AuditEntry =>
  buildAuditEntry({
    run_id,
    recipe_id: 'recipe-a',
    recipe_hash: 'hash-a',
    now: 1_000_010,
    duration_ms: 10,
    commit_status: 'succeeded',
    config_snapshot: {},
    errors: [],
    trigger_url: null,
    trigger_source: 'manual',
    instance_id: 'srv-test',
    ...(patch.total_usage !== undefined ? { total_usage: patch.total_usage } : {}),
  });

describe('D-250 § D — buildAuditEntry retains the usage', () => {
  it('⛔ THE ENUMERATING COPIER KEEPS IT — the trap that lost `exchange_ref`', () => {
    expect(anchor('r1', { total_usage: USAGE }).total_usage).toEqual(USAGE);
  });

  it('a genuinely ZERO-token report still survives the copier', () => {
    // A provider CAN return zeros (a cached completion, a refusal). The guard is
    // presence-checked, so this is retained rather than falsy-guarded away —
    // "called and cost nothing" is a different fact from "never called".
    const zero: TokenUsageReport = {
      input_tokens: 0, output_tokens: 0, total_tokens: 0, provider_calls: 1,
    };
    expect(anchor('r2', { total_usage: zero }).total_usage).toBeDefined();
    expect(anchor('r2', { total_usage: zero }).total_usage?.provider_calls).toBe(1);
  });

  it('a row written WITHOUT usage stays absent', () => {
    expect(anchor('r3').total_usage).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 3. THE PROJECTION — the SECOND hand-written copier, a layer up
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — the usage reaches execution.get', () => {
  let db: Database.Database;
  let feedDeps: ExecutionFeedRpcDeps;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS audit_entries (key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    ensureMemorySchema(db);
    feedDeps = {
      db,
      auditLog: createAuditLogStore(
        createInMemoryCollection<AuditEntry>(),
        createInMemoryCollection(),
      ),
      checkpointStore: createCheckpointStore(createInMemoryCollection<Checkpoint>()),
      commitStore: createCommitStore(createInMemoryCollection<Commit>()),
      serverInstanceId: 'srv-test',
    } as unknown as ExecutionFeedRpcDeps;
  });

  it('⛔ THE SECOND COPIER KEEPS IT — an expensive run and a free one differ here too', async () => {
    const log = (feedDeps as unknown as { auditLog: AuditLogStore }).auditLog;
    await log.append(anchor('spent', { total_usage: USAGE }));
    await log.append(anchor('free'));

    const spent = await handleExecutionGet(feedDeps, { run_id: 'spent' });
    const free = await handleExecutionGet(feedDeps, { run_id: 'free' });

    // Both succeeded — `status` never distinguished them, which is the point.
    expect(spent.run.audit.status).toBe('succeeded');
    expect(free.run.audit.status).toBe('succeeded');
    expect(spent.run.audit.total_usage?.total_tokens).toBe(15);
    // ⚠ Absent, NOT zero: this run called no provider. A zero here would be a
    // measurement that never happened.
    expect(free.run.audit.total_usage).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// 4. THE SINK — its own rules, which the join above cannot exercise
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — the run-scoped sink', () => {
  let sink: RunTokenUsageSink;
  beforeEach(() => { sink = createRunTokenUsageSink(); });

  it('take REMOVES the entry — a second read is undefined, not a double count', () => {
    sink.record('run-1', USAGE);
    expect(sink.take('run-1')?.total_tokens).toBe(15);
    expect(sink.take('run-1')).toBeUndefined();
    expect(sink.size()).toBe(0);
  });

  it('two runs never mix — the whole point of keying on run_id', () => {
    sink.record('run-a', USAGE);
    sink.record('run-b', { ...USAGE, total_tokens: 999 });
    expect(sink.take('run-a')?.total_tokens).toBe(15);
    expect(sink.take('run-b')?.total_tokens).toBe(999);
  });

  it('⛔ A CALL WITH NO run_id IS DROPPED, never bucketed under a placeholder', () => {
    // A shared bucket would attribute one run's spend to another — worse than
    // not counting it, because the wrong number looks like a right one.
    sink.record('', USAGE);
    expect(sink.size()).toBe(0);
  });

  it('the cap evicts the OLDEST and never throws', () => {
    for (let i = 0; i < RUN_TOKEN_USAGE_MAX_ENTRIES + 5; i += 1) {
      sink.record(`run-${i}`, USAGE);
    }
    expect(sink.size()).toBe(RUN_TOKEN_USAGE_MAX_ENTRIES);
    expect(sink.take('run-0')).toBeUndefined();
    expect(sink.take(`run-${RUN_TOKEN_USAGE_MAX_ENTRIES + 4}`)).toBeDefined();
  });

  it('⚠ recording REFRESHES recency — a long spending run outlives a quiet one', () => {
    const small = createRunTokenUsageSink(2);
    small.record('old', USAGE);
    small.record('new', USAGE);
    small.record('old', USAGE);   // touched again ⇒ now the newer of the two
    small.record('newest', USAGE);
    expect(small.take('old')).toBeDefined();
    expect(small.take('new')).toBeUndefined();
  });
});
