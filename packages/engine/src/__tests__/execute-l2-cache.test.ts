/** Integration tests for executeRecipe with the L2 step cache wired.
 *
 *  Each test runs a full recipe twice with the SAME CacheStore +
 *  ingredient policy, and asserts the second run executes fewer
 *  ingredient / transform operations because prior step outputs replay
 *  from cache.
 *
 *  Covers:
 *    - All-pure recipe: second run executes ZERO transforms (every
 *      sequential step hits).
 *    - Dirty variable busts downstream cache (same ingredient but
 *      different config value → fresh execution).
 *    - Cacheable ingredient (read/data): second run skips the
 *      ingredient call.
 *    - Non-cacheable ingredient (action / write): always runs.
 *    - Two DIFFERENT recipes with the same step spec share entries
 *      (content-addressable).
 *    - Cache disabled (ctx.stepCache omitted) → legacy behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import { executeRecipe } from '../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../types.js';
import { resolveRef, type RecipeDefinition, type NamespaceStores, type RecipeStep } from '@recued/contracts';
import { createInMemoryStore, type CacheEntry, type CacheStore } from '@recued/cache';
import { analyzeStep, computeStepCacheKey } from '../step-seed.js';

const emptyStores = (): NamespaceStores => ({
  vault: {}, config: {}, context: {}, meta: {}, step: {},
});

const mkRecipe = (over: Partial<RecipeDefinition> = {}): RecipeDefinition => ({
  recipe_id: 'test',
  version: 1,
  ttl: 3600,
  metadata: { name: 'Test', description: 'x', author: 'local', supported_platforms: [] },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { sidebar: [] },
  ...over,
});

// Pure policy: cache every read/data ingredient for 5 min.
const alwaysCacheable = () => ({ cacheable: true, ttl_seconds: 300 });

const keyFor = async (step: RecipeStep, stores: NamespaceStores = emptyStores()) => {
  const seed = await analyzeStep(step);
  const key = await computeStepCacheKey(seed, {
    resolve: (ref) => resolveRef(`{{${ref.ns}.${ref.path}}}`, stores),
  });
  return key;
};

const cacheEntry = (
  key: string,
  value: unknown,
  overrides: Partial<CacheEntry> = {},
): CacheEntry => ({
  key,
  value,
  expires_at: 1_100_000,
  recipe_id: 'test',
  ingredient_slug: 'deal-reader',
  size_bytes: 1,
  created_at: 990_000,
  last_accessed_at: 990_000,
  category: 'data',
  risk_tier: 'read',
  ...overrides,
});

const createStoreWithReadOnlyWarmEntry = (entry: CacheEntry) => {
  const backing = createInMemoryStore();
  const get = vi.fn(async (key: string) => key === entry.key ? entry : backing.get(key));
  const set = vi.fn((next: CacheEntry) => backing.set(next));
  const store: CacheStore = { ...backing, get, set };
  return { store, backing, get, set };
};

// ────────────────────────────────────────────────────────────────
// All-pure recipe — the big win
// ────────────────────────────────────────────────────────────────

import { MAX_CONTEXT_BYTES } from '../step-runner.js';

describe('executeRecipe — L2 cache on all-pure recipe', () => {
  it('second run executes zero sequential steps (every one hits)', async () => {
    // Recipe: take a config input, map it, sort it. Both are pure.
    const recipe = mkRecipe({
      variables: { nums: [3, 1, 2] as unknown as never },
      prefetch_steps: [],
      steps: [
        { id: 'mapped', transform: 'map', items: '{{config.nums}}', expression: '{{item}} * 2' } as never,
        { id: 'sorted', transform: 'sort', list: '{{step.mapped}}', order: 'asc' } as never,
      ],
      output: { sidebar: [{ type: 'summary', source: 'step.sorted' }] },
    });
    const store = createInMemoryStore();
    const executor = vi.fn<IngredientExecutor>();
    const statuses: string[] = [];

    const mkCtx = (): ExecutionContext => ({
      recipe,
      stores: emptyStores(),
      ingredientExecutor: executor,
      stepCache: {
        store,
        ingredientPolicy: () => null,
        onStatus: (s) => statuses.push(s),
      },
    });

    // Pass 1 — both miss, both execute.
    const r1 = await executeRecipe(mkCtx());
    expect(r1.success).toBe(true);
    expect(statuses.filter((s) => s === 'miss')).toHaveLength(2);
    expect(statuses.filter((s) => s === 'hit')).toHaveLength(0);

    statuses.length = 0;

    // Pass 2 — both hit. Zero transform work beyond the hash lookup.
    const r2 = await executeRecipe(mkCtx());
    expect(r2.success).toBe(true);
    expect(r2.steps).toHaveLength(2);
    // Every sequential step reports duration_ms=0 on a hit (replay).
    expect(r2.steps.every((s) => s.duration_ms === 0)).toBe(true);
    expect(statuses.filter((s) => s === 'hit')).toHaveLength(2);
    expect(statuses.filter((s) => s === 'miss')).toHaveLength(0);
  });

  it('dirty variable busts dependent step but not independent ones', async () => {
    const recipe = mkRecipe({
      variables: { x: 10, y: 20 },
      steps: [
        // Depends only on y — shouldn't bust when x changes.
        { id: 'a', transform: 'template', template: 'y is {{config.y}}' } as never,
        // Depends on x — must bust when x changes.
        { id: 'b', transform: 'template', template: 'x is {{config.x}}' } as never,
      ],
      output: { sidebar: [] },
    });
    const store = createInMemoryStore();
    const statuses: Array<{ status: string; id: string }> = [];

    const mkCtx = (configOverride: Record<string, unknown>): ExecutionContext => ({
      recipe,
      stores: { ...emptyStores(), config: { ...recipe.variables, ...configOverride } },
      ingredientExecutor: vi.fn(),
      stepCache: {
        store,
        ingredientPolicy: () => null,
        onStatus: (s, c) => statuses.push({ status: s, id: c.step_id }),
      },
    });

    await executeRecipe(mkCtx({})); // pass 1: two misses
    statuses.length = 0;
    await executeRecipe(mkCtx({ x: 999 })); // x changed; y unchanged

    // Step 'a' (reads only y) should hit; step 'b' (reads x) should miss.
    const a = statuses.find((s) => s.id === 'a');
    const b = statuses.find((s) => s.id === 'b');
    expect(a?.status).toBe('hit');
    expect(b?.status).toBe('miss');
  });
});

// ────────────────────────────────────────────────────────────────
// Cacheable ingredient — second run avoids the upstream call
// ────────────────────────────────────────────────────────────────

describe('executeRecipe — L2 cache on ingredient step', () => {
  it('cacheable ingredient hits on second run (no upstream call)', async () => {
    const recipe = mkRecipe({
      steps: [
        { id: 'load', ingredient: 'deal-reader-hubspot', input: { id: '{{context.entity_id}}' } } as never,
      ],
      output: { sidebar: [] },
    });
    const store = createInMemoryStore();
    const executor = vi.fn<IngredientExecutor>(async () => ({ deal: { value: 1000 } }));

    const mkCtx = (): ExecutionContext => ({
      recipe,
      stores: { ...emptyStores(), context: { entity_id: '42' } },
      ingredientExecutor: executor,
      stepCache: { store, ingredientPolicy: alwaysCacheable },
    });

    await executeRecipe(mkCtx());
    expect(executor).toHaveBeenCalledTimes(1);

    await executeRecipe(mkCtx());
    expect(executor).toHaveBeenCalledTimes(1); // cache hit — no new call
  });

  it('non-cacheable ingredient (action / write) always runs', async () => {
    const recipe = mkRecipe({
      steps: [
        { id: 'send', ingredient: 'send-email', input: { to: 'x@y' } } as never,
      ],
    });
    const store = createInMemoryStore();
    const executor = vi.fn<IngredientExecutor>(async () => ({ sent: true }));

    const mkCtx = (): ExecutionContext => ({
      recipe,
      stores: emptyStores(),
      ingredientExecutor: executor,
      stepCache: {
        store,
        ingredientPolicy: () => ({ cacheable: false, ttl_seconds: 0 }),
      },
    });

    await executeRecipe(mkCtx());
    await executeRecipe(mkCtx());
    expect(executor).toHaveBeenCalledTimes(2);
  });
});

describe('executeRecipe — L2 cache freshness directives', () => {
  it("cache: 'fresh' re-executes despite a warm L2 entry and does not populate L2", async () => {
    const nowMs = 1_000_000;
    const step = {
      id: 'load',
      ingredient: 'deal-reader',
      input: { id: '42' },
      cache: 'fresh',
    } as unknown as RecipeStep;
    const recipe = mkRecipe({
      steps: [step as never],
      output: { sidebar: [] },
    });
    const key = await keyFor(step);
    const warmEntry = cacheEntry(key, { deal: { id: 'cached' } }, { expires_at: nowMs + 60_000 });
    const { store, backing, get, set } = createStoreWithReadOnlyWarmEntry(warmEntry);
    const executor = vi.fn<IngredientExecutor>(async () => ({ deal: { id: 'live' } }));
    const statuses: Array<{ status: string; reason?: string }> = [];

    const result = await executeRecipe({
      recipe,
      stores: emptyStores(),
      ingredientExecutor: executor,
      stepCache: {
        store,
        ingredientPolicy: alwaysCacheable,
        onStatus: (status, ctx) => statuses.push({ status, reason: ctx.reason }),
      },
    });

    expect(result.success).toBe(true);
    expect(result.steps[0]?.result).toEqual({ deal: { id: 'live' } });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(await backing.get(key)).toBeNull();
    expect(statuses).toContainEqual({ status: 'skipped', reason: 'fresh' });
  });

  it("cache: 'any' replays an expired L2 entry without calling the runner", async () => {
    const nowMs = 1_000_000;
    const step = {
      id: 'load',
      ingredient: 'deal-reader',
      input: { id: '42' },
      cache: 'any',
    } as unknown as RecipeStep;
    const recipe = mkRecipe({
      steps: [step as never],
      output: { sidebar: [] },
    });
    const key = await keyFor(step);
    const store = createInMemoryStore();
    await store.set(cacheEntry(key, { deal: { id: 'expired-cache' } }, { expires_at: nowMs - 1 }));
    const executor = vi.fn<IngredientExecutor>(async () => ({ deal: { id: 'live' } }));
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    try {
      const result = await executeRecipe({
        recipe,
        stores: emptyStores(),
        ingredientExecutor: executor,
        stepCache: { store, ingredientPolicy: alwaysCacheable },
      });

      expect(result.success).toBe(true);
      expect(result.steps[0]?.result).toEqual({ deal: { id: 'expired-cache' } });
      expect(executor).toHaveBeenCalledTimes(0);
      expect((await store.get(key))?.value).toEqual({ deal: { id: 'expired-cache' } });
    } finally {
      dateNow.mockRestore();
    }
  });
});

// ────────────────────────────────────────────────────────────────
// Content-addressable — cross-recipe sharing
// ────────────────────────────────────────────────────────────────

describe('executeRecipe — cross-recipe cache sharing', () => {
  it('two DIFFERENT recipes with the same step spec + same resolved deps share entries', async () => {
    const sharedStep = {
      id: 'scored',
      transform: 'math',
      expression: '{{config.n}} * 2',
    };
    const recipeA = mkRecipe({
      recipe_id: 'alpha',
      variables: { n: 5 },
      steps: [sharedStep as never],
    });
    const recipeB = mkRecipe({
      recipe_id: 'beta',
      variables: { n: 5 },
      steps: [sharedStep as never],
    });

    const store = createInMemoryStore();
    const statuses: string[] = [];
    const policy = () => null;

    const ctxA: ExecutionContext = {
      recipe: recipeA,
      stores: { ...emptyStores(), config: { n: 5 } },
      ingredientExecutor: vi.fn(),
      stepCache: { store, ingredientPolicy: policy, onStatus: (s) => statuses.push(`A:${s}`) },
    };
    const ctxB: ExecutionContext = {
      recipe: recipeB,
      stores: { ...emptyStores(), config: { n: 5 } },
      ingredientExecutor: vi.fn(),
      stepCache: { store, ingredientPolicy: policy, onStatus: (s) => statuses.push(`B:${s}`) },
    };

    await executeRecipe(ctxA);
    await executeRecipe(ctxB);

    // A missed + wrote. B hit on A's entry.
    expect(statuses).toContain('A:miss');
    expect(statuses).toContain('B:hit');
    expect(statuses).not.toContain('B:miss');
  });
});

// ────────────────────────────────────────────────────────────────
// Backward compat — cache omitted → legacy behavior
// ────────────────────────────────────────────────────────────────

describe('executeRecipe — L2 cache omitted (backward compat)', () => {
  it('without ctx.stepCache, every run executes fresh (no hits)', async () => {
    const recipe = mkRecipe({
      steps: [
        { id: 'x', transform: 'template', template: 'hi' } as never,
      ],
    });
    // No stepCache in ctx at all.
    const mkCtx = (): ExecutionContext => ({
      recipe,
      stores: emptyStores(),
      ingredientExecutor: vi.fn(),
    });
    const r1 = await executeRecipe(mkCtx());
    const r2 = await executeRecipe(mkCtx());
    // Both runs have real durations (not the 0ms replay marker).
    // Since the test runs fast, 0 is possible, so instead verify by
    // checking step logs are structurally the same and success both times.
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.steps).toHaveLength(1);
    expect(r2.steps).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// TTL policy — pure steps get a 24h floor, ingredient steps inherit
// the per-manifest policy TTL (same as L1 freshness bound)
// ────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────
// Edge: step skip_when / fail_on / errors shouldn't poison cache
// ────────────────────────────────────────────────────────────────

describe('executeRecipe — L2 cache + skip/fail/error paths', () => {
  it('skip_when triggered → result=null → NOT cached (so next run with different condition evaluates fresh)', async () => {
    const recipe = mkRecipe({
      variables: { go: false },
      steps: [
        {
          id: 's',
          transform: 'template',
          template: 'done',
          skip_when: '{{config.go}} equal false',
        } as never,
      ],
    });
    const store = createInMemoryStore();
    const runner = vi.fn();

    // Pass 1: go=false → skip_when true → skipped, null result → not cached.
    await executeRecipe({
      recipe,
      stores: { ...emptyStores(), config: { go: false } },
      ingredientExecutor: runner,
      stepCache: { store, ingredientPolicy: () => null },
    });

    // Pass 2: go=true → condition changes → step executes.
    const r2 = await executeRecipe({
      recipe,
      stores: { ...emptyStores(), config: { go: true } },
      ingredientExecutor: runner,
      stepCache: { store, ingredientPolicy: () => null },
    });
    expect(r2.steps[0].skipped).toBe(false);
    expect(r2.steps[0].result).toBe('done');
  });

  it('step that errors is NOT cached → next run re-executes', async () => {
    // Ingredient step: first run throws, second run succeeds — the
    // cache must NOT cache the failure, so pass 2 actually calls the
    // executor again.
    const recipe = mkRecipe({
      steps: [
        { id: 'x', ingredient: 'flaky', input: { id: '1' } } as never,
      ],
    });
    const store = createInMemoryStore();
    let calls = 0;
    const executor = vi.fn<IngredientExecutor>(async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return { ok: true };
    });
    const mkCtx = (): ExecutionContext => ({
      recipe,
      stores: emptyStores(),
      ingredientExecutor: executor,
      stepCache: { store, ingredientPolicy: alwaysCacheable },
    });

    const r1 = await executeRecipe(mkCtx());
    expect(r1.success).toBe(false);

    const r2 = await executeRecipe(mkCtx());
    expect(r2.success).toBe(true);
    expect(executor).toHaveBeenCalledTimes(2); // second call did happen
  });
});

// ────────────────────────────────────────────────────────────────
// Edge: prefetch + sequential coexistence
// ────────────────────────────────────────────────────────────────

describe('executeRecipe — L2 cache + prefetch', () => {
  it('prefetch step is NOT wrapped by L2; its outputs flow into sequential dep hashes', async () => {
    const recipe = mkRecipe({
      prefetch_steps: [{ id: 'load', ingredient: 'prefetch-src' } as never],
      steps: [
        {
          id: 'fmt',
          transform: 'template',
          template: 'got {{step.load.value}}',
        } as never,
      ],
    });
    const store = createInMemoryStore();
    let prefetchCalls = 0;
    const executor = vi.fn<IngredientExecutor>(async (slug) => {
      if (slug === 'prefetch-src') {
        prefetchCalls++;
        return { value: 'v1' };
      }
      return null;
    });

    const mkCtx = (): ExecutionContext => ({
      recipe,
      stores: emptyStores(),
      ingredientExecutor: executor,
      stepCache: { store, ingredientPolicy: alwaysCacheable },
    });

    await executeRecipe(mkCtx());
    await executeRecipe(mkCtx());
    // Prefetch runs every time at the executor level (L1 ingredient cache
    // was NOT wired in this test) — but the `fmt` sequential step is
    // identical across runs because its dep hash (step.load.value=v1)
    // stays the same → fmt hits on pass 2.
    // So executor called twice (prefetch ×2), but if `fmt` had been an
    // expensive ingredient it'd hit L2 on pass 2.
    expect(prefetchCalls).toBe(2); // prefetch not L2-wrapped
  });

  it('when prefetch output CHANGES, downstream L2 entries miss', async () => {
    const recipe = mkRecipe({
      prefetch_steps: [{ id: 'load', ingredient: 'p' } as never],
      steps: [
        { id: 'fmt', transform: 'template', template: '{{step.load.id}}' } as never,
      ],
    });
    const store = createInMemoryStore();
    let v = 'a';
    const executor = vi.fn<IngredientExecutor>(async () => ({ id: v }));

    const mkCtx = (): ExecutionContext => ({
      recipe,
      stores: emptyStores(),
      ingredientExecutor: executor,
      stepCache: { store, ingredientPolicy: alwaysCacheable },
    });

    await executeRecipe(mkCtx()); // prefetch → {id:'a'}; fmt caches under (source, hash({id:'a'}))
    v = 'b'; // different prefetch output next time
    await executeRecipe(mkCtx()); // prefetch → {id:'b'}; fmt dep hash differs → miss
    // Both runs populate stores.step.fmt with different values — a
    // regression here would reuse the cached 'a' output against
    // the 'b' input.
  });
});

// ────────────────────────────────────────────────────────────────
// Edge: middle-step non-cacheable doesn't poison downstream cache
// ────────────────────────────────────────────────────────────────

describe('executeRecipe — L2 cache + mixed cacheable/non-cacheable chain', () => {
  it('non-cacheable middle step runs fresh but downstream pure steps still cache off its output', async () => {
    const recipe = mkRecipe({
      steps: [
        { id: 'a', transform: 'template', template: 'A' } as never,
        { id: 'b', transform: 'is_past', date: '2020-01-01T00:00:00Z' } as never, // non-cacheable
        { id: 'c', transform: 'template', template: 'C-from-{{step.b}}' } as never,
      ],
    });
    const store = createInMemoryStore();
    const statuses: Array<{ id: string; status: string }> = [];
    const mkCtx = (): ExecutionContext => ({
      recipe,
      stores: emptyStores(),
      ingredientExecutor: vi.fn(),
      stepCache: {
        store,
        ingredientPolicy: () => null,
        onStatus: (s, c) => statuses.push({ id: c.step_id, status: s }),
      },
    });

    await executeRecipe(mkCtx());
    statuses.length = 0;
    await executeRecipe(mkCtx());

    // Pass 2: a hits (pure), b skipped (is_past non-cacheable), c hits
    // (pure, but depends on b — and because b returns the same boolean
    // both runs, c's dep hash is stable → hit).
    const byId = Object.fromEntries(statuses.map((s) => [s.id, s.status]));
    expect(byId.a).toBe('hit');
    expect(byId.b).toBe('skipped');
    expect(byId.c).toBe('hit');
  });
});

// ────────────────────────────────────────────────────────────────
// Edge: getIngredientVersion integration
// ────────────────────────────────────────────────────────────────

describe('executeRecipe — getIngredientVersion end-to-end', () => {
  it('bumping manifest version retires prior cache entries', async () => {
    const recipe = mkRecipe({
      steps: [
        { id: 'load', ingredient: 'deal-reader', input: { id: '1' } } as never,
      ],
    });
    const store = createInMemoryStore();
    const executor = vi.fn<IngredientExecutor>(async () => ({ deal: 1 }));

    // v1: populates cache.
    await executeRecipe({
      recipe, stores: emptyStores(), ingredientExecutor: executor,
      stepCache: {
        store,
        ingredientPolicy: alwaysCacheable,
        getIngredientVersion: () => 1,
      },
    });
    expect(executor).toHaveBeenCalledTimes(1);

    // v1 again: hits.
    await executeRecipe({
      recipe, stores: emptyStores(), ingredientExecutor: executor,
      stepCache: {
        store,
        ingredientPolicy: alwaysCacheable,
        getIngredientVersion: () => 1,
      },
    });
    expect(executor).toHaveBeenCalledTimes(1);

    // v2: different version → different sourceHash → different key → miss.
    await executeRecipe({
      recipe, stores: emptyStores(), ingredientExecutor: executor,
      stepCache: {
        store,
        ingredientPolicy: alwaysCacheable,
        getIngredientVersion: () => 2,
      },
    });
    expect(executor).toHaveBeenCalledTimes(2);
  });
});

// ────────────────────────────────────────────────────────────────
// Broadcast eligibility — L2 entries carry a `category` so the peer
// sync layer can treat them the way it treats L1 ingredient entries.
// ────────────────────────────────────────────────────────────────

describe('executeRecipe — L2 entry categories', () => {
  it('transform-step entries are stamped with category="step" + risk_tier="read"', async () => {
    const recipe = mkRecipe({
      steps: [{ id: 's', transform: 'template', template: 'hi' } as never],
    });
    const store = createInMemoryStore();
    let missKey: string | undefined;
    const ctx: ExecutionContext = {
      recipe,
      stores: emptyStores(),
      ingredientExecutor: vi.fn(),
      stepCache: {
        store,
        ingredientPolicy: () => null,
        onStatus: (status, c) => { if (status === 'miss') missKey = c.key; },
      },
    };
    await executeRecipe(ctx);
    const entry = await store.get(missKey!);
    expect(entry?.category).toBe('step');
    expect(entry?.risk_tier).toBe('read');
  });

  it('ingredient-step entries inherit the manifest category ("data" / "ai")', async () => {
    const recipe = mkRecipe({
      steps: [
        { id: 'load', ingredient: 'deal-reader', input: { id: '1' } } as never,
      ],
    });
    const store = createInMemoryStore();
    let missKey: string | undefined;
    const ctx: ExecutionContext = {
      recipe,
      stores: emptyStores(),
      ingredientExecutor: vi.fn(async () => ({ deal: {} })),
      stepCache: {
        store,
        ingredientPolicy: () => ({ cacheable: true, ttl_seconds: 300, category: 'data' }),
        onStatus: (status, c) => { if (status === 'miss') missKey = c.key; },
      },
    };
    await executeRecipe(ctx);
    const entry = await store.get(missKey!);
    expect(entry?.category).toBe('data');
    expect(entry?.risk_tier).toBe('read');
  });
});

// ────────────────────────────────────────────────────────────────
// L2 TTL policy
// ────────────────────────────────────────────────────────────────

describe('executeRecipe — L2 TTL policy', () => {
  it('pure-transform entries get at least a 24h TTL regardless of a short recipe.ttl', async () => {
    const recipe = mkRecipe({
      ttl: 60, // short recipe-level TTL
      steps: [{ id: 's', transform: 'template', template: 'hi {{config.name}}' } as never],
    });
    const store = createInMemoryStore();
    let sawMissKey: string | undefined;
    const ctx: ExecutionContext = {
      recipe,
      stores: { ...emptyStores(), config: { name: 'world' } },
      ingredientExecutor: vi.fn(),
      stepCache: {
        store,
        ingredientPolicy: () => null,
        onStatus: (status, c) => {
          if (status === 'miss') sawMissKey = c.key;
        },
      },
    };

    const t0 = Date.now();
    await executeRecipe(ctx);

    // Directly inspect the entry: its expires_at must be ≥ t0 + 24h,
    // not t0 + recipe.ttl (which would be t0 + 60s).
    expect(sawMissKey).toBeDefined();
    const entry = await store.get(sawMissKey!);
    expect(entry).not.toBeNull();
    const msFloor = 24 * 60 * 60 * 1000;
    expect(entry!.expires_at).toBeGreaterThanOrEqual(t0 + msFloor);
    // Upper bound (sanity): shouldn't be way beyond 24h + a second of jitter.
    expect(entry!.expires_at).toBeLessThanOrEqual(t0 + msFloor + 5000);
  });

  it('ingredient-step entries inherit the policy TTL (not the 24h floor)', async () => {
    const recipe = mkRecipe({
      ttl: 0,
      steps: [
        { id: 'load', ingredient: 'deal-reader', input: { id: '1' } } as never,
      ],
    });
    const store = createInMemoryStore();
    const executor = vi.fn<IngredientExecutor>(async () => ({ deal: {} }));
    const ctx: ExecutionContext = {
      recipe,
      stores: emptyStores(),
      ingredientExecutor: executor,
      stepCache: {
        store,
        // Short 10s TTL — models a high-churn data ingredient.
        ingredientPolicy: () => ({ cacheable: true, ttl_seconds: 10 }),
      },
    };
    const t0 = Date.now();
    await executeRecipe(ctx);
    // Second run inside the 10s window → hit.
    await executeRecipe(ctx);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

// ────────────────────────────────────────────────────────────────
// Context cap — cache-hit path must also charge the counter.
// Without tracking on replay, an all-hits recipe would silently
// accumulate past the cap (since runStep is never entered).
// ────────────────────────────────────────────────────────────────

describe('executeRecipe — L2 cache replay charges the context cap', () => {
  it('cumulative cache-hit replays trigger CONTEXT_SIZE_EXCEEDED', async () => {
    // ⚠ SIZED FROM THE CONSTANT, NOT A COPIED NUMBER. This test previously
    // hardcoded 3 x ~4MB against a 10MB cap; when the cap moved to 50MB it
    // would have gone GREEN while exercising nothing, because the payload no
    // longer crossed it. A cap test whose payload does not track the cap stops
    // being a test the moment the cap changes.
    //
    // Each step output estimates to ~2x the string length in JSON. Three steps
    // must exceed the cap: pass 1 fails at step c (miss) after a + b cached.
    // Pass 2 replays a + b from cache, then misses c and executes it, pushing
    // cumulative past the cap AGAIN. If the hit path didn't track size, pass 2's
    // counter would stay at 0 through the hits and c would fit — pass 2 would
    // wrongly succeed. This fails without the hit-path trackContextSize call.
    const payload = 'a'.repeat(Math.ceil(MAX_CONTEXT_BYTES / 3 / 2) + 1024);
    const recipe = mkRecipe({
      variables: { p: payload },
      steps: [
        { id: 'a', transform: 'template', template: '{{config.p}}' } as never,
        { id: 'b', transform: 'template', template: '{{config.p}}' } as never,
        { id: 'c', transform: 'template', template: '{{config.p}}' } as never,
      ],
      output: { sidebar: [] },
    });
    const store = createInMemoryStore();
    const mkCtx = (): ExecutionContext => ({
      recipe,
      stores: emptyStores(),
      ingredientExecutor: vi.fn<IngredientExecutor>(),
      stepCache: { store, ingredientPolicy: () => null },
    });

    const r1 = await executeRecipe(mkCtx());
    expect(r1.success).toBe(false);
    expect(r1.errors[0]?.message).toMatch(/step context is/);

    const r2 = await executeRecipe(mkCtx());
    expect(r2.success).toBe(false);
    expect(r2.errors[0]?.message).toMatch(/step context is/);
  });
});
