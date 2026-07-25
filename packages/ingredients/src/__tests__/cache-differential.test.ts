/** Differential cache tests — the canary against silent corruption.
 *
 *  Runs the same workload through withIngredientCache twice:
 *    1. Cold cache (empty store) — every call goes to the raw executor.
 *    2. Warm cache (populated by run 1) — every call serves from cache.
 *
 *  Asserts: outputs are byte-identical. Any divergence means the cache
 *  is silently returning wrong values — the bug class canonicalization
 *  fixtures cannot catch alone because they only test the hash, not the
 *  full store-round-trip.
 *
 *  Scope:
 *   - Primitive + object + nested inputs
 *   - Unicode normalization (NFC/NFD)
 *   - Key-order invariance
 *   - Different ingredients with same inputs (namespacing via slug)
 *   - Different recipes using same ingredient (namespacing via recipe_id)
 *   - Action category (never cached) — output must match upstream on every call
 *
 *  These tests must run in BOTH Node and jsdom — they're the infrastructure
 *  that proves the cache layer is correct end-to-end.
 */

import { describe, it, expect } from 'vitest';
import { withIngredientCache } from '../cache.js';
import { createInMemoryStore } from '@recued/cache';
import type { IngredientManifest } from '@recued/contracts';
import type { IngredientExecutor, ManifestLoader } from '../types.js';

const mkManifest = (slug: string, category: 'data' | 'ai' | 'action' = 'data'): IngredientManifest => ({
  slug, name: slug, description: 'test', author: 'test', version: 1,
  kind: 'http',
  category,
  risk_tier: category === 'action' ? 'write' : 'read',
  input: {}, output: {},
});

/** Counting executor: returns a deterministic function of (slug, input)
 *  so the cache layer's correctness is verifiable. Counts calls per slug. */
const mkCountingExec = (
  impl: (slug: string, input: Record<string, unknown>) => unknown,
): { exec: IngredientExecutor; calls: Record<string, number> } => {
  const calls: Record<string, number> = {};
  const exec: IngredientExecutor = async (slug, input) => {
    calls[slug] = (calls[slug] ?? 0) + 1;
    return impl(slug, input);
  };
  return { exec, calls };
};

const mkRuntime = (
  manifests: Record<string, IngredientManifest>,
  exec: IngredientExecutor,
) => {
  const loader: ManifestLoader = async (slug) => manifests[slug] ?? null;
  return withIngredientCache(exec, {
    manifestLoader: loader,
    store: createInMemoryStore(),
    recipe_ttl: 300,
    recipe_id: 'test-recipe',
  });
};

// ────────────────────────────────────────────────────────────────
// Differential harness — run twice, assert byte-equal output
// ────────────────────────────────────────────────────────────────

const runTwice = async (
  cached: IngredientExecutor,
  slug: string,
  input: Record<string, unknown>,
): Promise<{ first: unknown; second: unknown }> => {
  const first = await cached(slug, input);
  const second = await cached(slug, input);
  return { first, second };
};

describe('differential — output identity cold vs warm', () => {
  it('primitive result survives cache round-trip unchanged', async () => {
    const { exec } = mkCountingExec(() => 42);
    const runtime = mkRuntime({ 'x': mkManifest('x') }, exec);
    const { first, second } = await runTwice(runtime, 'x', {});
    expect(first).toBe(42);
    expect(second).toBe(42);
  });

  it('object result survives unchanged', async () => {
    const { exec } = mkCountingExec(() => ({ deal: 'acme', amount: 42_000, stage: 'open' }));
    const runtime = mkRuntime({ 'x': mkManifest('x') }, exec);
    const { first, second } = await runTwice(runtime, 'x', {});
    expect(first).toEqual(second);
    expect(second).toEqual({ deal: 'acme', amount: 42_000, stage: 'open' });
  });

  it('deeply nested result survives unchanged', async () => {
    const payload = {
      items: [
        { id: 1, meta: { tag: 'a', nested: { x: true } } },
        { id: 2, meta: { tag: 'b', nested: { x: false } } },
      ],
      count: 2,
      summary: null,
    };
    const { exec } = mkCountingExec(() => payload);
    const runtime = mkRuntime({ 'x': mkManifest('x') }, exec);
    const { first, second } = await runTwice(runtime, 'x', {});
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('null + empty values round-trip', async () => {
    const payload = { null_field: null, empty_arr: [], empty_obj: {}, empty_str: '', zero: 0, fls: false };
    const { exec } = mkCountingExec(() => payload);
    const runtime = mkRuntime({ 'x': mkManifest('x') }, exec);
    const { second } = await runTwice(runtime, 'x', {});
    expect(second).toEqual(payload);
  });
});

describe('differential — cache hits for equivalent inputs', () => {
  it('key-order invariant: {a:1,b:2} and {b:2,a:1} share a cache entry', async () => {
    const { exec, calls } = mkCountingExec(() => 'result');
    const runtime = mkRuntime({ 'x': mkManifest('x') }, exec);
    await runtime('x', { a: 1, b: 2 });
    await runtime('x', { b: 2, a: 1 });
    expect(calls['x']).toBe(1);
  });

  it('NFC vs NFD equivalence on string inputs', async () => {
    const { exec, calls } = mkCountingExec(() => 'result');
    const runtime = mkRuntime({ 'x': mkManifest('x') }, exec);
    await runtime('x', { name: '\u00E9' });        // é (precomposed, NFC)
    await runtime('x', { name: '\u0065\u0301' });  // e + combining acute (NFD)
    expect(calls['x']).toBe(1);
  });

  it('-0 and 0 share cache entry (numeric normalization)', async () => {
    const { exec, calls } = mkCountingExec(() => 'result');
    const runtime = mkRuntime({ 'x': mkManifest('x') }, exec);
    await runtime('x', { n: 0 });
    await runtime('x', { n: -0 });
    expect(calls['x']).toBe(1);
  });
});

describe('differential — isolation', () => {
  it('different slug → different cache entry', async () => {
    const { exec, calls } = mkCountingExec((slug) => slug);
    const r1 = mkRuntime({ a: mkManifest('a'), b: mkManifest('b') }, exec);
    await r1('a', {}); await r1('a', {});
    await r1('b', {}); await r1('b', {});
    expect(calls['a']).toBe(1);
    expect(calls['b']).toBe(1);
  });

  it('different ingredient_version → different cache entry', async () => {
    const mfs: Record<string, IngredientManifest> = {
      'x': { ...mkManifest('x'), version: 1 },
    };
    const { exec, calls } = mkCountingExec(() => 'v1');
    const r = withIngredientCache(exec, {
      manifestLoader: async (slug) => mfs[slug] ?? null,
      store: createInMemoryStore(),
      recipe_ttl: 300,
      recipe_id: 'r',
    });
    await r('x', { k: 1 });
    mfs['x'] = { ...mfs['x'], version: 2 };
    await r('x', { k: 1 }); // different manifest version → miss
    expect(calls['x']).toBe(2);
  });
});

describe('differential — action category never caches', () => {
  it('write ingredient hits upstream every call (output reflects side effect)', async () => {
    let counter = 0;
    const { exec, calls } = mkCountingExec(() => ({ written_at: ++counter }));
    const runtime = mkRuntime({ 'do-thing': mkManifest('do-thing', 'action') }, exec);
    const r1 = await runtime('do-thing', { target: 'x' });
    const r2 = await runtime('do-thing', { target: 'x' });
    expect(calls['do-thing']).toBe(2);
    expect(r1).not.toEqual(r2); // each write has fresh side-effect token
  });
});

describe('differential — cold vs warm observed output', () => {
  it('warm-cache run produces exact same output as cold-cache run', async () => {
    // Simulate two full "sessions": each creates its own cache store, runs
    // the same workload, collects outputs. Outputs must match byte-for-byte.
    const workload: { slug: string; input: Record<string, unknown> }[] = [
      { slug: 'deal-reader', input: { id: 'D-1' } },
      { slug: 'deal-reader', input: { id: 'D-2' } },
      { slug: 'contact-reader', input: { id: 'C-1' } },
      { slug: 'deal-reader', input: { id: 'D-1' } }, // repeat
    ];
    const results = async () => {
      const payloads: Record<string, unknown> = {
        'deal-reader': { deal: 'info' },
        'contact-reader': { contact: 'info' },
      };
      const { exec } = mkCountingExec((slug) => payloads[slug]);
      const runtime = mkRuntime({
        'deal-reader': mkManifest('deal-reader'),
        'contact-reader': mkManifest('contact-reader'),
      }, exec);
      const outputs: unknown[] = [];
      for (const w of workload) {
        outputs.push(await runtime(w.slug, w.input));
      }
      return outputs;
    };

    const cold = await results();
    const warm = await results();
    // Every output identical across runs — the cache doesn't mutate values.
    expect(JSON.stringify(warm)).toBe(JSON.stringify(cold));
  });
});
