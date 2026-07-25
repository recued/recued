/** Step-cache seed parser — determines per-step caching eligibility and
 *  dependency schema at recipe-compile time.
 *
 *  Produces a `StepSeed` per step that the step-cache uses at execute
 *  time to compute cache keys without re-walking step JSON:
 *
 *    seed = {
 *      kind:       'transform' | 'ingredient' | 'guard' | 'unknown'
 *      cacheable:  boolean        // false for non-deterministic / side-effect steps
 *      sourceHash: string         // sha256 of canonical(step spec) — stable across runs
 *      refs:       RefPath[]      // every {{ns.path}} in the step, first-occurrence order
 *    }
 *
 *  At execute time, the step-cache resolves each `ref` against the live
 *  stores, canonical-hashes the resolved-values object, combines with
 *  `sourceHash` into a single cache key, and does one store lookup.
 *
 *  Cacheability (non-deterministic / side-effect gating):
 *    - transforms  → cacheable IFF name is on the pure allowlist
 *                    (time-dependent ones like is_past/date_diff are off)
 *    - ingredients → cacheable ONLY when the caller provides a manifest
 *                    lookup that reports read + non-action. The seed
 *                    parser is synchronous; async policy derivation
 *                    happens at wrap time (see `buildCachedStepRunner`
 *                    in execute.ts) — the parser just flags ingredient
 *                    steps as "candidate" and the cache wrapper makes
 *                    the final decision.
 *    - guards      → always cacheable (pure condition eval)
 *    - other/unknown → never cacheable
 */

import type { RecipeStep } from '@recued/contracts';
import { collectRefs, stepType } from '@recued/contracts';
import { canonicalHash, canonicalize } from '@recued/cache';

/** A single `{{ns.path}}` dependency — the execute-time resolver will
 *  walk `ns` + `path` in the live NamespaceStores to read the current
 *  value. Stored as parts to avoid re-parsing each lookup. */
export interface RefPath {
  ns: string;
  path: string;
}

/** Mirrors `StepType` from `@recued/contracts`. `'unknown'` covers
 *  condition blocks + any future step shape the engine doesn't yet
 *  recognize; those are always non-cacheable. */
export type StepKind = 'transform' | 'ingredient' | 'guard' | 'unknown';

export interface StepSeed {
  /** Stable step id (from step.id) — used for cross-recipe lookup keys
   *  when chaining across steps that share ids (rare but possible). */
  id: string;
  kind: StepKind;
  /** When false, the step is non-deterministic or has side effects and
   *  must never hit / write the step cache. Transforms are checked
   *  against the pure allowlist. Ingredients are a "candidate" — the
   *  cache wrapper gates them through `derivePolicy(manifest)` at
   *  execute time since the manifest isn't available synchronously. */
  cacheable: boolean;
  /** Only meaningful when kind === 'ingredient'. Distinguishes "cache
   *  is disabled up front" (e.g. transform on the deny list) from
   *  "cache depends on the manifest policy, decide later". */
  ingredientCandidate: boolean;
  /** SHA-256 of the canonical step spec. Part of the cache key. */
  sourceHash: string;
  /** Every `{{ns.path}}` ref the step reads, first-occurrence order. */
  refs: RefPath[];
}

/** Transforms whose output is a pure function of their resolved inputs.
 *  Anything NOT on this list is classified as non-deterministic — it's
 *  correctness-first (false negatives are fine; false positives break
 *  cache coherence). Time-dependent transforms are deliberately off:
 *  `is_past`, `is_future`, `date_diff` (with a `now` sentinel), `date_period`
 *  all read `Date.now()` implicitly. Callers that want those cached with a
 *  per-hour bucket can include a time bucket in the recipe's context
 *  before executeRecipe runs. */
const PURE_TRANSFORMS: ReadonlySet<string> = new Set([
  // Collection
  'filter', 'sort', 'map', 'reduce', 'unique', 'flatten', 'slice',
  'group_by', 'to_list', 'partition',
  // Object
  'merge', 'prefix_keys', 'pick', 'omit', 'rename', 'set',
  // String
  'lowercase', 'uppercase', 'trim', 'split', 'concat', 'replace', 'template',
  'truncate',
  // Numeric
  'round', 'clamp', 'to_number', 'math', 'weighted_score',
  // Date — pure subset (format / add / parse do NOT read Date.now)
  'date_format', 'date_add', 'date_parse',
  // Logic
  'compare', 'coalesce', 'switch', 'all', 'any', 'count', 'default',
  'not', 'ternary', 'pluralize',
  // Privacy
  'hash_replace', 'hash_restore', 'redact',
  // Display
  'to_checklist', 'to_table', 'to_summary', 'to_csv',
  // Boolean
  'starts_with', 'ends_with',
  // Tier 2
  'find', 'pluck', 'sum', 'min_by', 'max_by', 'percent', 'join',
]);

/** Prepare a step for sourceHash by folding in out-of-band fields the
 *  caller supplied — currently just `ingredient_version`. Kept as a
 *  stable chokepoint so the hash contract evolves in ONE place if we
 *  later need to add or strip fields.
 *
 *  `ingredientVersion`: when present, it's spliced into the hashed
 *  object under a reserved `__ingredient_version` key. This prevents
 *  stale cache hits after a manifest version bump (same slug, same
 *  step spec, but the ingredient's behavior changed). The pseudo-key
 *  never appears in the user-visible spec — it only shapes the hash. */
const normalizeStepForHash = (
  step: Record<string, unknown>,
  ingredientVersion?: string | number | null,
): unknown => {
  if (ingredientVersion != null && step.ingredient) {
    return { ...step, __ingredient_version: ingredientVersion };
  }
  return step;
};

export interface AnalyzeStepOptions {
  /** Resolve an ingredient slug to its current manifest version. When
   *  provided, the version is folded into the step's sourceHash so a
   *  manifest bump (v1 → v2 with the same slug) produces a different
   *  cache key and retires stale entries without explicit invalidation.
   *
   *  Returns null / undefined when the slug is unknown — the seed
   *  falls back to hashing without a version, and the manifest-unknown
   *  path in the cache wrapper takes over at execute time. */
  getIngredientVersion?: (slug: string) => string | number | null | undefined;
}

/** Analyze one step and produce its seed. Runs at recipe-compile time
 *  (once per recipe install) — the result can be cached alongside the
 *  recipe's installed_hash and re-used on every execute. */
export const analyzeStep = async (
  step: RecipeStep,
  opts: AnalyzeStepOptions = {},
): Promise<StepSeed> => {
  const raw = step as Record<string, unknown>;
  const kind = stepType(raw) as StepKind;
  const id = (raw.id as string) ?? '';

  const refs = collectRefs(step);

  // Only fold in the manifest version for ingredient steps — transforms
  // and guards don't reference manifests.
  const ingredientVersion = kind === 'ingredient' && typeof raw.ingredient === 'string'
    ? opts.getIngredientVersion?.(raw.ingredient) ?? null
    : null;
  const sourceHash = await canonicalHash(normalizeStepForHash(raw, ingredientVersion));

  let cacheable = false;
  let ingredientCandidate = false;
  if (kind === 'transform') {
    const name = raw.transform as string;
    cacheable = PURE_TRANSFORMS.has(name);
  } else if (kind === 'guard') {
    cacheable = true;
  } else if (kind === 'ingredient') {
    // Policy gating happens at execute time (manifest-dependent). Flag
    // as a candidate so the wrapper knows to probe derivePolicy.
    cacheable = false;
    ingredientCandidate = true;
  }
  // 'unknown' (condition / future types) → cacheable: false

  return { id, kind, cacheable, ingredientCandidate, sourceHash, refs };
};

/** Analyze every step in a recipe. Seeds align to the input order
 *  (`seeds[i]` describes `steps[i]`). */
export const analyzeSteps = async (
  steps: RecipeStep[],
  opts: AnalyzeStepOptions = {},
): Promise<StepSeed[]> =>
  Promise.all(steps.map((s) => analyzeStep(s, opts)));

// ────────────────────────────────────────────────────────────────
// Cache-key composition
// ────────────────────────────────────────────────────────────────

/** Resolve every ref in a seed against the live stores and produce a
 *  canonical object of the resolved values. `step` namespace lookups
 *  walk upstream step outputs that have already been written.
 *
 *  Separated from the store walk so tests can feed synthetic values
 *  without threading full NamespaceStores. */
export interface DepResolver {
  resolve(ref: RefPath): unknown;
}

/** Build the step cache key: `sha256(sourceHash + sha256(canonical(deps)))`.
 *  Content-addressable — two steps across different recipes with the
 *  SAME spec AND the same resolved dependency values produce the same
 *  key. That's what makes the cache universal. */
export const computeStepCacheKey = async (
  seed: StepSeed,
  resolver: DepResolver,
): Promise<string> => {
  // Order-preserve per `seed.refs`; duplicates were already removed by
  // collectRefs. Use the ref's `ns.path` as the object key so the
  // canonical hash is stable regardless of insertion order.
  const depValues: Record<string, unknown> = {};
  for (const ref of seed.refs) {
    depValues[`${ref.ns}.${ref.path}`] = resolver.resolve(ref);
  }
  const depsHash = await canonicalHash(depValues);
  // Prefix with a version tag so future key-format changes don't
  // silently collide with old entries. Stores will show orphan old-
  // format entries after an upgrade; LRU evicts them naturally.
  return `v1:step:${seed.sourceHash}:${depsHash}`;
};

/** Sanity helper for tests and the execute.ts integration: canonicalize
 *  a step without hashing, so callers can log the exact JSON that went
 *  into sourceHash when debugging a cache miss. Accepts the same
 *  ingredient-version hint as `analyzeStep` so the stringified form
 *  matches what the hasher actually sees. */
export const canonicalStepSpec = (
  step: RecipeStep,
  ingredientVersion?: string | number | null,
): string =>
  canonicalize(normalizeStepForHash(step as Record<string, unknown>, ingredientVersion));
