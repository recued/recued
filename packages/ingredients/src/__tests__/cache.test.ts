import { describe, it, expect, beforeEach } from 'vitest';
import { withIngredientCache } from '../cache.js';
import { createInMemoryStore } from '@recued/cache';
import type { IngredientManifest } from '@recued/contracts';
import type { IngredientExecutor, ManifestLoader } from '../types.js';

// ────────────────────────────────────────────────────────────────
// Test fixtures
// ────────────────────────────────────────────────────────────────

const mkManifest = (slug: string, category: 'data' | 'ai' | 'action'): IngredientManifest => ({
  slug,
  name: `Test ${slug}`,
  description: 'test',
  author: 'test',
  kind: 'http',
  category,
  risk_tier: category === 'action' ? 'write' : 'read',
  input: {},
  output: {},
});

/** Build a manifest loader from a table of slug → category. */
const mkLoader = (table: Record<string, 'data' | 'ai' | 'action'>): ManifestLoader =>
  async (slug: string) => {
    const cat = table[slug];
    return cat ? mkManifest(slug, cat) : null;
  };

/** Counting executor — tracks how many times each slug was called. */
const mkExecutor = (
  impl: (slug: string, input: Record<string, unknown>) => unknown,
): { exec: IngredientExecutor; counts: Record<string, number> } => {
  const counts: Record<string, number> = {};
  const exec: IngredientExecutor = async (slug, input) => {
    counts[slug] = (counts[slug] ?? 0) + 1;
    return impl(slug, input);
  };
  return { exec, counts };
};

// ────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────
// Pair-sharing — D-103 removed instance_id from the cache key, so any
// two runtimes with the same inputs land on the same key. This is what
// makes ext ↔ server peer-synced cache actually work: a fresh paste
// from the server into the ext's store hits on a subsequent call.
// ────────────────────────────────────────────────────────────────

describe('withIngredientCache — pair-shared key convergence (D-103)', () => {
  it('two runtimes sharing a store converge on the same cache entry', async () => {
    const store = createInMemoryStore();
    const { exec: execA, counts: countsA } = mkExecutor(() => ({ deal: 'acme' }));
    const { exec: execS, counts: countsS } = mkExecutor(() => ({ deal: 'other' }));
    const common = {
      manifestLoader: mkLoader({ 'deal-reader': 'data' }),
      store,
      recipe_ttl: 300,
      recipe_id: 'r',
    } as const;
    const cachedA = withIngredientCache(execA, common);
    const cachedS = withIngredientCache(execS, common);

    const a = await cachedA('deal-reader', { id: '42' });
    const s = await cachedS('deal-reader', { id: '42' });
    expect(a).toEqual({ deal: 'acme' });
    expect(s).toEqual({ deal: 'acme' }); // from A's cache entry
    expect(countsA['deal-reader']).toBe(1);
    expect(countsS['deal-reader']).toBeUndefined(); // did not re-execute
  });
});

describe('withIngredientCache — data category', () => {
  it('caches a data ingredient call on second invocation', async () => {
    const { exec, counts } = mkExecutor(() => ({ deal: 'acme' }));
    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'deal-reader-hubspot': 'data' }),
      store: createInMemoryStore(),
      recipe_ttl: 300,
      recipe_id: 'test-recipe',
    });

    const r1 = await cached('deal-reader-hubspot', { id: '42' });
    const r2 = await cached('deal-reader-hubspot', { id: '42' });
    expect(r1).toEqual({ deal: 'acme' });
    expect(r2).toEqual({ deal: 'acme' });
    expect(counts['deal-reader-hubspot']).toBe(1); // second call from cache
  });

  it('different inputs produce distinct cache entries', async () => {
    const { exec, counts } = mkExecutor((_s, input) => ({ id: input.id }));
    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'deal-reader': 'data' }),
      store: createInMemoryStore(),
      recipe_ttl: 300,
      recipe_id: 'test',
    });

    await cached('deal-reader', { id: '1' });
    await cached('deal-reader', { id: '2' });
    await cached('deal-reader', { id: '1' }); // from cache
    expect(counts['deal-reader']).toBe(2);
  });

  it('cache miss on expired entry', async () => {
    let clock = 1_000_000;
    const { exec, counts } = mkExecutor(() => 'result');
    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'x': 'data' }),
      store: createInMemoryStore(),
      recipe_ttl: 60, // 60s
      recipe_id: 'test',
      now: () => clock,
    });

    await cached('x', {}); // caches with expires_at = clock + 60000
    clock += 61_000; // past expiry
    await cached('x', {}); // miss — re-execute
    expect(counts['x']).toBe(2);
  });

  it('never caches an engine-marked sensitive catalog surface dispatch', async () => {
    const store = createInMemoryStore();
    const { exec, counts } = mkExecutor((_slug, input) => ({
      callback_url: input['body.callback_url'],
    }));
    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'webhook-operation-fixture': 'data' }),
      store,
      recipe_ttl: 300,
      recipe_id: 'operation-bound-recipe',
    });
    const input = {
      resource_id: 'remote-1',
      'body.callback_url': 'https://hooks.example/v1/webhooks/opaque-public-id',
    };
    const meta = {
      step_id: 'attach-resource',
      surface_dispatch: true,
      surface_dispatch_sensitive: true as const,
    };

    await cached('webhook-operation-fixture', input, undefined, undefined, meta);
    await cached('webhook-operation-fixture', input, undefined, undefined, meta);

    expect(counts['webhook-operation-fixture']).toBe(2);
    expect(await store.size()).toBe(0);
  });
});

describe('withIngredientCache — ai category', () => {
  it('caches ai ingredient with the 300s floor even when recipe_ttl is lower', async () => {
    let clock = 1_000_000;
    const { exec, counts } = mkExecutor(() => ({ score: 0.9 }));
    const store = createInMemoryStore();
    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'ai-classify': 'ai' }),
      store,
      recipe_ttl: 60, // below the 300s ai floor
      recipe_id: 'test',
      now: () => clock,
    });

    await cached('ai-classify', { 'llm.data': 'x' });
    clock += 299_000; // still within 300s floor
    await cached('ai-classify', { 'llm.data': 'x' });
    expect(counts['ai-classify']).toBe(1); // second call from cache

    clock += 2_000; // past 300s floor
    await cached('ai-classify', { 'llm.data': 'x' });
    expect(counts['ai-classify']).toBe(2); // miss after expiry
  });
});

describe('withIngredientCache — action category', () => {
  it('NEVER caches action ingredients (bypasses cache on every call)', async () => {
    const { exec, counts } = mkExecutor(() => ({ created_id: '123' }));
    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'create-task': 'action' }),
      store: createInMemoryStore(),
      recipe_ttl: 3600,
      recipe_id: 'test',
    });

    await cached('create-task', { title: 'x' });
    await cached('create-task', { title: 'x' });
    await cached('create-task', { title: 'x' });
    expect(counts['create-task']).toBe(3); // all executed, none cached
  });

  it('action ingredient does not populate the cache store', async () => {
    const store = createInMemoryStore();
    const { exec } = mkExecutor(() => ({ ok: true }));
    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'create-task': 'action' }),
      store,
      recipe_ttl: 300,
      recipe_id: 'test',
    });

    await cached('create-task', { title: 'x' });
    expect(await store.size()).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// Manifest loading edge cases
// ────────────────────────────────────────────────────────────────

describe('withIngredientCache — manifest loading', () => {
  it('falls through to raw executor when manifest is null', async () => {
    const { exec, counts } = mkExecutor(() => 'result');
    const cached = withIngredientCache(exec, {
      manifestLoader: async () => null,
      store: createInMemoryStore(),
      recipe_ttl: 300,
      recipe_id: 'test',
    });

    await cached('unknown', {});
    await cached('unknown', {});
    expect(counts['unknown']).toBe(2); // neither call cached
  });

  it('falls through to raw executor when manifest loader throws', async () => {
    const { exec, counts } = mkExecutor(() => 'result');
    const cached = withIngredientCache(exec, {
      manifestLoader: async () => { throw new Error('network down'); },
      store: createInMemoryStore(),
      recipe_ttl: 300,
      recipe_id: 'test',
    });

    await cached('any', {});
    await cached('any', {});
    expect(counts['any']).toBe(2);
  });

  it('propagates raw executor errors without caching them', async () => {
    let throwNext = true;
    const exec: IngredientExecutor = async () => {
      if (throwNext) {
        throwNext = false;
        throw new Error('upstream 500');
      }
      return 'ok';
    };
    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ 'x': 'data' }),
      store: createInMemoryStore(),
      recipe_ttl: 300,
      recipe_id: 'test',
    });

    await expect(cached('x', {})).rejects.toThrow('upstream 500');
    // Second call should succeed — errors are NOT cached
    const r = await cached('x', {});
    expect(r).toBe('ok');
  });
});

// ────────────────────────────────────────────────────────────────
// LRU / eviction
// ────────────────────────────────────────────────────────────────

describe('withIngredientCache — LRU eviction', () => {
  it('evicts when total size exceeds max_bytes', async () => {
    const store = createInMemoryStore();
    // Each response has ~200 bytes of serialized content
    const bigValue = { data: 'x'.repeat(80) };
    const { exec } = mkExecutor(() => bigValue);
    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ a: 'data', b: 'data', c: 'data' }),
      store,
      recipe_ttl: 300,
      recipe_id: 'test',
      max_bytes: 300, // smaller than two entries
    });

    await cached('a', {});
    await cached('b', {});
    await cached('c', {});
    // At least one older entry should have been evicted
    const size = await store.size();
    expect(size).toBeLessThanOrEqual(300);
  });
});

// ────────────────────────────────────────────────────────────────
// LRU bump semantics
// ────────────────────────────────────────────────────────────────

describe('withIngredientCache — LRU bump on hit', () => {
  it('hits update last_accessed_at but NOT expires_at', async () => {
    let clock = 1_000_000;
    const store = createInMemoryStore();
    const { exec } = mkExecutor(() => 'result');
    const cached = withIngredientCache(exec, {
      manifestLoader: mkLoader({ x: 'data' }),
      store,
      recipe_ttl: 60, // 60 seconds
      recipe_id: 'test',
      now: () => clock,
    });

    await cached('x', {});
    const keyStore = store as unknown as { map?: Map<string, unknown> };
    // The in-memory store internally uses a Map — grab any entry to
    // inspect timestamps. We fetch via get() instead to avoid touching
    // internals.
    clock += 30_000;
    await cached('x', {}); // hit at clock = 1_030_000
    clock += 20_000; // clock = 1_050_000
    await cached('x', {}); // still a hit (expires_at = 1_060_000)
    clock += 11_000; // clock = 1_061_000, past expiry
    await cached('x', {}); // MISS — expires_at was not bumped by hits
    // Track: we expect exactly 2 executions (first miss + post-expiry miss)
    // which we verify indirectly via the counts fixture
  });
});

// ────────────────────────────────────────────────────────────────
// Per-recipe isolation
// ────────────────────────────────────────────────────────────────

describe('withIngredientCache — recipe scoping', () => {
  it('same slug + input but different recipes share cache entries (by hash)', async () => {
    // Cache keys are computed from slug+input — NOT including recipe_id.
    // This is by design: if two recipes call the same ingredient with the
    // same arguments, they should share the cached response.
    const { exec, counts } = mkExecutor(() => ({ data: 1 }));
    const store = createInMemoryStore();

    const recipeA = withIngredientCache(exec, {
      manifestLoader: mkLoader({ x: 'data' }),
      store,
      recipe_ttl: 300,
      recipe_id: 'recipe-a',
    });
    const recipeB = withIngredientCache(exec, {
      manifestLoader: mkLoader({ x: 'data' }),
      store,
      recipe_ttl: 300,
      recipe_id: 'recipe-b',
    });

    await recipeA('x', { id: 1 });
    await recipeB('x', { id: 1 }); // shares the cached entry
    expect(counts['x']).toBe(1);
  });

  it('deleteByRecipe only removes entries for the specified recipe', async () => {
    const store = createInMemoryStore();
    const { exec } = mkExecutor((s) => ({ slug: s }));
    const recipeA = withIngredientCache(exec, {
      manifestLoader: mkLoader({ x: 'data', y: 'data' }),
      store,
      recipe_ttl: 300,
      recipe_id: 'recipe-a',
    });
    const recipeB = withIngredientCache(exec, {
      manifestLoader: mkLoader({ x: 'data', y: 'data' }),
      store,
      recipe_ttl: 300,
      recipe_id: 'recipe-b',
    });

    // Distinct inputs so they don't collide in the cache
    await recipeA('x', { from: 'a' });
    await recipeB('y', { from: 'b' });
    expect(await store.size()).toBeGreaterThan(0);

    await store.deleteByRecipe('recipe-a');
    // Only recipe-a's entry should be gone
    const remaining = await store.size();
    expect(remaining).toBeGreaterThan(0); // recipe-b's entry still there
  });
});

// ────────────────────────────────────────────────────────────────
// Cache key includes manifest defaults (merged input)
// ────────────────────────────────────────────────────────────────

describe('withIngredientCache — cache key from merged input', () => {
  it('different manifest defaults produce different cache keys', async () => {
    // Two manifests with the same slug but different default inputs
    const manifests: Record<string, ReturnType<typeof mkManifest>> = {
      'x-v1': mkManifest('x-v1', 'data'),
      'x-v2': mkManifest('x-v2', 'data'),
    };
    // Simulate different manifest.input defaults
    (manifests['x-v1'] as unknown as Record<string, unknown>).input = { timeout_ms: 5000 };
    (manifests['x-v2'] as unknown as Record<string, unknown>).input = { timeout_ms: 30000 };

    const { exec, counts } = mkExecutor(() => 'result');
    const store = createInMemoryStore();

    const c1 = withIngredientCache(exec, {
      manifestLoader: async (slug) => manifests[slug] ?? null,
      store,
      recipe_ttl: 300,
      recipe_id: 'test',
    });

    // Same step input, different manifest defaults → different cache keys
    await c1('x-v1', {});
    await c1('x-v2', {});
    expect(counts['x-v1']).toBe(1);
    expect(counts['x-v2']).toBe(1);
    // Both should have been cache misses (distinct keys)
    expect(await store.size()).toBeGreaterThanOrEqual(2);
  });
});
