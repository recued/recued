/** Tests for the step-seed parser + cache-key composer.
 *
 *  Pure utilities — no execution, no cache store, no live stores.
 *  Focus on: transform allowlist correctness, ref extraction
 *  completeness (pure refs + interpolated + nested), stable hashing
 *  across recipes, and content-addressable key collisions for
 *  identical step specs.
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeStep,
  analyzeSteps,
  computeStepCacheKey,
  canonicalStepSpec,
  type StepSeed,
  type DepResolver,
} from '../step-seed.js';
import type { RecipeStep } from '@recued/contracts';

const constResolver = (values: Record<string, unknown>): DepResolver => ({
  resolve: (ref) => values[`${ref.ns}.${ref.path}`],
});

// ────────────────────────────────────────────────────────────────
// analyzeStep — kind + cacheability
// ────────────────────────────────────────────────────────────────

describe('analyzeStep — transform classification', () => {
  it('pure transforms are cacheable', async () => {
    const seed = await analyzeStep({
      id: 's1', transform: 'filter', conditions: [], mode: 'all',
    } as unknown as RecipeStep);
    expect(seed.kind).toBe('transform');
    expect(seed.cacheable).toBe(true);
  });

  it('prefix_keys is cacheable and includes source + prefix dependencies', async () => {
    const seed = await analyzeStep({
      id: 'prefix',
      transform: 'prefix_keys',
      source: '{{step.response.values}}',
      prefix: '{{config.response_prefix}}',
    } as unknown as RecipeStep);

    expect(seed.kind).toBe('transform');
    expect(seed.cacheable).toBe(true);
    expect(seed.refs.map((ref) => `${ref.ns}.${ref.path}`)).toEqual([
      'step.response.values',
      'config.response_prefix',
    ]);
  });

  it('unknown transforms are NOT cacheable (correctness-first default)', async () => {
    const seed = await analyzeStep({
      id: 's1', transform: 'some_future_transform',
    } as unknown as RecipeStep);
    expect(seed.cacheable).toBe(false);
  });

  it('time-dependent transforms (is_past / is_future / date_diff / date_period) are NOT cacheable', async () => {
    for (const name of ['is_past', 'is_future', 'date_diff', 'date_period']) {
      const seed = await analyzeStep({
        id: 's', transform: name,
      } as unknown as RecipeStep);
      expect(seed.cacheable, `${name} should not be cacheable`).toBe(false);
    }
  });
});

describe('analyzeStep — ingredient + guard', () => {
  it('ingredient steps are candidates (policy decides at execute time)', async () => {
    const seed = await analyzeStep({
      id: 'load', ingredient: 'deal-reader-hubspot', input: { id: '{{context.entity_id}}' },
    } as unknown as RecipeStep);
    expect(seed.kind).toBe('ingredient');
    expect(seed.cacheable).toBe(false);
    expect(seed.ingredientCandidate).toBe(true);
  });

  it('guard steps are always cacheable', async () => {
    const seed = await analyzeStep({
      id: 'g', guard: '{{step.x}} is_null',
    } as unknown as RecipeStep);
    expect(seed.kind).toBe('guard');
    expect(seed.cacheable).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────
// Ref extraction
// ────────────────────────────────────────────────────────────────

describe('analyzeStep — ref collection', () => {
  it('pulls refs from pure string params', async () => {
    const seed = await analyzeStep({
      id: 's', transform: 'filter', field: '{{step.load.deals}}', mode: 'all',
    } as unknown as RecipeStep);
    const paths = seed.refs.map((r) => `${r.ns}.${r.path}`);
    expect(paths).toContain('step.load.deals');
  });

  it('pulls refs from interpolated strings', async () => {
    const seed = await analyzeStep({
      id: 's', transform: 'template', template: 'hello {{config.name}} from {{context.tab_url}}',
    } as unknown as RecipeStep);
    const paths = seed.refs.map((r) => `${r.ns}.${r.path}`);
    expect(paths).toContain('config.name');
    expect(paths).toContain('context.tab_url');
  });

  it('dedupes refs across fields but preserves first-occurrence order', async () => {
    const seed = await analyzeStep({
      id: 's', transform: 'template',
      template: '{{config.a}} {{config.b}} {{config.a}}',
      fallback: '{{config.b}} only',
    } as unknown as RecipeStep);
    const paths = seed.refs.map((r) => `${r.ns}.${r.path}`);
    expect(paths).toEqual(['config.a', 'config.b']);
  });

  it('strips format hints when collecting (same underlying dep)', async () => {
    const seed = await analyzeStep({
      id: 's', transform: 'template', template: '{{config.x:currency}} and {{config.x}}',
    } as unknown as RecipeStep);
    const paths = seed.refs.map((r) => `${r.ns}.${r.path}`);
    expect(paths).toEqual(['config.x']);
  });

  it('ignores unknown namespaces (e.g. "foo.bar")', async () => {
    const seed = await analyzeStep({
      id: 's', transform: 'template', template: '{{foo.bar}} {{config.x}}',
    } as unknown as RecipeStep);
    const paths = seed.refs.map((r) => `${r.ns}.${r.path}`);
    expect(paths).toEqual(['config.x']);
  });

  it('walks nested objects + arrays', async () => {
    const seed = await analyzeStep({
      id: 's',
      transform: 'filter',
      field: '{{step.a}}',
      conditions: [
        { field: '{{step.b}}', operator: 'equal', value: '{{config.c}}' },
      ],
    } as unknown as RecipeStep);
    const paths = seed.refs.map((r) => `${r.ns}.${r.path}`);
    expect(paths.sort()).toEqual(['config.c', 'step.a', 'step.b'].sort());
  });
});

// ────────────────────────────────────────────────────────────────
// sourceHash stability
// ────────────────────────────────────────────────────────────────

describe('analyzeStep — sourceHash', () => {
  it('two steps with the same spec produce the same sourceHash (cross-recipe reuse)', async () => {
    const step1 = { id: 'a', transform: 'filter', field: '{{step.x}}' } as unknown as RecipeStep;
    const step2 = { id: 'a', transform: 'filter', field: '{{step.x}}' } as unknown as RecipeStep;
    const [s1, s2] = await Promise.all([analyzeStep(step1), analyzeStep(step2)]);
    expect(s1.sourceHash).toBe(s2.sourceHash);
  });

  it('different step specs produce different sourceHashes', async () => {
    const s1 = await analyzeStep({ id: 'a', transform: 'filter', field: '{{step.x}}' } as unknown as RecipeStep);
    const s2 = await analyzeStep({ id: 'a', transform: 'filter', field: '{{step.y}}' } as unknown as RecipeStep);
    expect(s1.sourceHash).not.toBe(s2.sourceHash);
  });

  it('key order in the spec does NOT matter — canonical ordering stabilises hash', async () => {
    const s1 = await analyzeStep({
      id: 's', transform: 'filter', field: '{{step.x}}', mode: 'all',
    } as unknown as RecipeStep);
    const s2 = await analyzeStep({
      mode: 'all', transform: 'filter', id: 's', field: '{{step.x}}',
    } as unknown as RecipeStep);
    expect(s1.sourceHash).toBe(s2.sourceHash);
  });
});

describe('analyzeStep — ingredient manifest version', () => {
  it('different manifest versions produce different sourceHashes (retires stale entries)', async () => {
    const step = { id: 'load', ingredient: 'deal-reader-hubspot', input: { id: '42' } } as unknown as RecipeStep;
    const v1 = await analyzeStep(step, { getIngredientVersion: () => 1 });
    const v2 = await analyzeStep(step, { getIngredientVersion: () => 2 });
    expect(v1.sourceHash).not.toBe(v2.sourceHash);
  });

  it('same version produces the same sourceHash (content-addressable stable under no-op upgrades)', async () => {
    const step = { id: 'load', ingredient: 'deal-reader-hubspot' } as unknown as RecipeStep;
    const a = await analyzeStep(step, { getIngredientVersion: () => 3 });
    const b = await analyzeStep(step, { getIngredientVersion: () => 3 });
    expect(a.sourceHash).toBe(b.sourceHash);
  });

  it('transforms ignore getIngredientVersion — their sourceHash is version-independent', async () => {
    const step = { id: 's', transform: 'filter', field: '{{step.x}}' } as unknown as RecipeStep;
    const a = await analyzeStep(step, { getIngredientVersion: () => 1 });
    const b = await analyzeStep(step, { getIngredientVersion: () => 999 });
    expect(a.sourceHash).toBe(b.sourceHash);
  });

  it('version resolver returning null → hash matches the no-resolver case', async () => {
    const step = { id: 'load', ingredient: 'x' } as unknown as RecipeStep;
    const withNull = await analyzeStep(step, { getIngredientVersion: () => null });
    const noResolver = await analyzeStep(step);
    expect(withNull.sourceHash).toBe(noResolver.sourceHash);
  });
});

describe('analyzeStep — edge step kinds', () => {
  it('step with no `id` still analyzes — seed.id is empty string', async () => {
    const seed = await analyzeStep({
      transform: 'filter', field: '{{step.x}}',
    } as unknown as RecipeStep);
    expect(seed.id).toBe('');
    // Without an id the seed can still be computed; the cache wrapper
    // bypasses via its seedById lookup (empty-string key likely not
    // registered) — correctness preserved.
    expect(seed.cacheable).toBe(true);
  });

  it('step with no recognized kind classifies as "unknown", non-cacheable', async () => {
    const seed = await analyzeStep({
      id: 'c', condition: '{{x}} equal y', then: [], else: [],
    } as unknown as RecipeStep);
    // `stepType` returns 'unknown' for condition blocks; the cache
    // wrapper bypasses anything that isn't cacheable or an ingredient
    // candidate.
    expect(seed.kind).toBe('unknown');
    expect(seed.cacheable).toBe(false);
    expect(seed.ingredientCandidate).toBe(false);
  });

  it('ingredient step with no slug on the spec is still an ingredient candidate', async () => {
    const seed = await analyzeStep({
      id: 's', ingredient: '',
    } as unknown as RecipeStep);
    expect(seed.kind).toBe('ingredient');
    expect(seed.ingredientCandidate).toBe(true);
    // Runtime wrapper will hit the 'no-manifest' bypass because the
    // policy resolver can't do anything with an empty slug.
  });

  it('step with zero refs has an empty refs array (not undefined)', async () => {
    const seed = await analyzeStep({
      id: 's', transform: 'template', template: 'static',
    } as unknown as RecipeStep);
    expect(seed.refs).toEqual([]);
  });
});

describe('computeStepCacheKey — boundary inputs', () => {
  it('empty refs still produces a stable key (two calls → same hash)', async () => {
    const seed = {
      id: 's', kind: 'transform' as const, cacheable: true, ingredientCandidate: false,
      sourceHash: 'deadbeef',
      refs: [],
    };
    const r = { resolve: () => undefined };
    const k1 = await computeStepCacheKey(seed, r);
    const k2 = await computeStepCacheKey(seed, r);
    expect(k1).toBe(k2);
  });

  it('resolver returning undefined for a ref canonicalizes as an absent key → same hash as no refs', async () => {
    // Worth documenting: canonicalize drops undefined values, so
    // `{}` and `{config.missing: undefined}` produce identical hashes.
    // That's desirable for correctness — a never-set config var and a
    // ref to an unset path are behaviorally equivalent at execution
    // time (both resolve to undefined and cause the same downstream
    // behavior). A regression here would create keys that incorrectly
    // differ between clean and dirty states.
    const seedNoRefs = {
      id: 's', kind: 'transform' as const, cacheable: true, ingredientCandidate: false,
      sourceHash: 'X', refs: [],
    };
    const seedWithUndef = {
      ...seedNoRefs,
      refs: [{ ns: 'config', path: 'missing' }],
    };
    const r = { resolve: () => undefined };
    const k1 = await computeStepCacheKey(seedNoRefs, r);
    const k2 = await computeStepCacheKey(seedWithUndef, r);
    expect(k1).toBe(k2);
  });

  it('refs with different RESOLVED VALUES produce different keys even when sourceHash is the same', async () => {
    const seed = {
      id: 's', kind: 'transform' as const, cacheable: true, ingredientCandidate: false,
      sourceHash: 'X', refs: [{ ns: 'config', path: 'x' }],
    };
    const k1 = await computeStepCacheKey(seed, { resolve: () => 1 });
    const k2 = await computeStepCacheKey(seed, { resolve: () => 2 });
    const k3 = await computeStepCacheKey(seed, { resolve: () => null });
    expect(new Set([k1, k2, k3]).size).toBe(3);
  });
});

describe('analyzeSteps (batch)', () => {
  it('empty steps array returns empty seeds array', async () => {
    expect(await analyzeSteps([])).toEqual([]);
  });

  it('forwards `getIngredientVersion` to every step', async () => {
    const versions: string[] = [];
    await analyzeSteps(
      [
        { id: 'a', ingredient: 'x' } as unknown as RecipeStep,
        { id: 'b', ingredient: 'y' } as unknown as RecipeStep,
      ],
      { getIngredientVersion: (slug) => { versions.push(slug); return 1; } },
    );
    expect(versions.sort()).toEqual(['x', 'y']);
  });

  it('returns one seed per input step, in order', async () => {
    const seeds = await analyzeSteps([
      { id: 'a', transform: 'filter' } as unknown as RecipeStep,
      { id: 'b', transform: 'sort' } as unknown as RecipeStep,
      { id: 'c', ingredient: 'x' } as unknown as RecipeStep,
    ]);
    expect(seeds.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(seeds.map((s) => s.kind)).toEqual(['transform', 'transform', 'ingredient']);
  });
});

// ────────────────────────────────────────────────────────────────
// computeStepCacheKey — content-addressable
// ────────────────────────────────────────────────────────────────

describe('computeStepCacheKey', () => {
  it('same sourceHash + same resolved deps → same key', async () => {
    const seed: StepSeed = {
      id: 's', kind: 'transform', cacheable: true, ingredientCandidate: false,
      sourceHash: 'abc123',
      refs: [{ ns: 'config', path: 'threshold' }, { ns: 'context', path: 'url' }],
    };
    const r1 = constResolver({ 'config.threshold': 10, 'context.url': 'https://a' });
    const r2 = constResolver({ 'config.threshold': 10, 'context.url': 'https://a' });
    const k1 = await computeStepCacheKey(seed, r1);
    const k2 = await computeStepCacheKey(seed, r2);
    expect(k1).toBe(k2);
    expect(k1.startsWith('v1:step:abc123:')).toBe(true);
  });

  it('same source, different dep values → different key', async () => {
    const seed: StepSeed = {
      id: 's', kind: 'transform', cacheable: true, ingredientCandidate: false,
      sourceHash: 'abc123',
      refs: [{ ns: 'config', path: 'threshold' }],
    };
    const k1 = await computeStepCacheKey(seed, constResolver({ 'config.threshold': 10 }));
    const k2 = await computeStepCacheKey(seed, constResolver({ 'config.threshold': 20 }));
    expect(k1).not.toBe(k2);
  });

  it('cross-recipe reuse: two steps with same spec + same inputs share a key', async () => {
    // Recipe A's step `score` and Recipe B's step `rate` both hash to
    // the same cache key if their source specs are identical AND their
    // resolved deps match. Id doesn't participate — content-addressable.
    const specA = { id: 'score', transform: 'weighted_score', weights: { a: 1, b: 2 } };
    const specB = { id: 'rate', transform: 'weighted_score', weights: { a: 1, b: 2 } };
    const seedA = await analyzeStep(specA as unknown as RecipeStep);
    const seedB = await analyzeStep(specB as unknown as RecipeStep);
    // Step id DOES participate in the hash today (it's part of the
    // canonical spec). Different ids → different sourceHash. That's
    // intentional for the first revision — two steps with different
    // ids are distinguishable and a simple rename invalidates cache
    // without polluting it. Relax later if cross-recipe reuse demands.
    expect(seedA.sourceHash).not.toBe(seedB.sourceHash);

    // BUT: when two steps have the SAME id AND the same spec (e.g. a
    // recipe that imports a shared snippet), they share the key.
    const specC = { id: 'score', transform: 'weighted_score', weights: { a: 1, b: 2 } };
    const seedC = await analyzeStep(specC as unknown as RecipeStep);
    expect(seedA.sourceHash).toBe(seedC.sourceHash);

    const r = constResolver({});
    const kA = await computeStepCacheKey(seedA, r);
    const kC = await computeStepCacheKey(seedC, r);
    expect(kA).toBe(kC);
  });
});

describe('canonicalStepSpec (debug helper)', () => {
  it('returns stable canonical JSON for a step', () => {
    const a = canonicalStepSpec({ id: 's', transform: 'filter', mode: 'all' } as unknown as RecipeStep);
    const b = canonicalStepSpec({ mode: 'all', id: 's', transform: 'filter' } as unknown as RecipeStep);
    expect(a).toBe(b);
  });
});
