/** D-120 Phase 4.5 — `context.recipe.*` durability helpers.
 *
 *  Snapshot at run end / inject at run start glue for
 *  `{{context.recipe.<step_id>}}` references. Recipes that need run-
 *  to-run continuity (digest pipelines, cumulative scoring,
 *  delta-against-yesterday checklists) read prior step outputs through
 *  this namespace, typically wrapped in `coalesce` for first-run
 *  safety. Pre-D-120 the namespace existed at the parser level but
 *  resolved to undefined every run; this module provides the engine-
 *  side snapshot/inject contract that hosts wire to a per-pair store.
 *
 *  The helpers are pure over `(recipe, stores, snapshot)` —
 *  persistence is host-side. Reactive recipes
 *  (`auto_run`) snapshot at process retire boundaries only — host
 *  buffers per-tick output in memory and commits on
 *  `ProcessRetireReason`. Non-reactive (cron + manual) snapshot
 *  every run.
 *
 *  Spec: D-120.
 */

import {
  CONTEXT_RECIPE_MAX_BYTES,
  isTempFileRef,
  type ContextRecipe,
  type RecipeDefinition,
  type NamespaceStores,
} from '@recued/contracts';
import { extractContextRecipeRefs } from '@recued/recipes';
import { assignOwnSafe, hasOwnSafe, setNamespaceValue } from './store-safety.js';

/** D-185 Slice 2 — strip any `TempFileRef` from a value about to be persisted
 *  into the durable cross-run `context.recipe` snapshot. A `temp` ref is
 *  run-scoped: its file is reclaimed at run end, so a snapshot carrying one
 *  would resolve to a DEAD path on the next run (D-185 §3.4: "cross-run
 *  continuity requires `cas`; a temp ref must not outlive its run"). Dropping it
 *  here enforces that invariant BY CONSTRUCTION regardless of authoring — the
 *  next run sees the field as undefined and the recipe's `coalesce` first-run
 *  fallback handles it. Returns a fresh structure; the live `stores.step` value
 *  is never mutated. Bounded recursion (objects + arrays). */
const stripTempRefs = (value: unknown, depth = 0): unknown => {
  if (depth > 16 || value === null || typeof value !== 'object') return value;
  if (isTempFileRef(value)) return undefined;
  if (Array.isArray(value)) return value.map((v) => stripTempRefs(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const stripped = stripTempRefs(v, depth + 1);
    if (stripped !== undefined) out[k] = stripped;
  }
  return out;
};

/** Per-recipe snapshot store contract — the host implements it; the
 *  engine helpers below operate against this shape. Storage is
 *  per-pair, no cloud sync (D-090 / D-097 / D-102). */
export interface ContextRecipeStore {
  /** Look up the latest snapshot for a recipe. Returns null when no
   *  snapshot has been written yet (first run, or post-manual-reset). */
  get(recipe_id: string): ContextRecipe | null;
  /** Persist `snapshot` as the latest state for `recipe_id`. Overwrites
   *  any prior snapshot — the engine only ever preserves the most
   *  recent run's outputs (no time-series history per the spec). */
  set(recipe_id: string, snapshot: ContextRecipe): void;
  /** Drop a recipe's snapshot. Called on uninstall and on the
   *  user-triggered manual reset surface in advanced settings. */
  clear(recipe_id: string): void;
}

/** Outcome of a snapshot computation. `snapshot` is what should be
 *  persisted; `truncated` lists step ids that were dropped during
 *  size-cap reduction so callers can surface a warning to the author
 *  (e.g., "step `with_staleness` output (≈12 KB) exceeds the per-
 *  recipe context.recipe budget — consider trimming before referencing
 *  it from prior runs"). */
export interface ContextRecipeSnapshotResult {
  snapshot: ContextRecipe;
  truncated: string[];
}

/** Pure: compute the snapshot the engine should persist for the run
 *  that just finished. Picks the manifest's step outputs from
 *  `stores.step`, then iteratively drops the largest entries until the
 *  serialized payload fits within `CONTEXT_RECIPE_MAX_BYTES`.
 *
 *  Manifest source is `extractContextRecipeRefs(recipe)` — the same
 *  static analysis used at install time, re-run here so the engine
 *  doesn't need to thread the install-time refs through every executor
 *  call. The static analyzer is cheap (single recipe walk) and pure,
 *  so re-extraction at run time stays correct across recipe-version
 *  upgrades automatically.
 *
 *  Steps in the manifest with no output in `stores.step` (skipped via
 *  `skip_when`, errored before completion, etc.) are simply omitted —
 *  next run sees the prior snapshot for those keys, which is the
 *  desired "fall back to last successful value" semantic. */
export const snapshotContextRecipe = (
  recipe: RecipeDefinition,
  stores: NamespaceStores,
): ContextRecipeSnapshotResult => {
  const manifest = extractContextRecipeRefs(recipe);
  if (manifest.length === 0) return { snapshot: {}, truncated: [] };

  const stepStore = (stores.step ?? {}) as Record<string, unknown>;
  const candidate: ContextRecipe = {};
  for (const stepId of manifest) {
    if (hasOwnSafe(stepStore, stepId)) {
      // D-185 Slice 2 — drop any run-scoped `temp` ref before it becomes durable
      // cross-run state (its file is gone next run; §3.4).
      setNamespaceValue(candidate, stepId, stripTempRefs(stepStore[stepId]));
    }
  }

  return trimToSize(candidate);
};

/** Pure: install a previously-saved snapshot into `stores.context.recipe`
 *  before any step runs. Resolver walks `{{context.recipe.<step_id>}}`
 *  through this object; missing entries (first run, partial snapshot)
 *  resolve to undefined and the recipe's `coalesce` wrappers fall through
 *  to first-run defaults.
 *
 *  Idempotent — caller-set `context.recipe` wins, mirroring the
 *  `context.server` injection rule. (No host pre-sets `context.recipe`
 *  today, but the rule lets future test harnesses inject synthetic
 *  snapshots without re-implementing this function.) */
export const injectContextRecipe = (
  stores: NamespaceStores,
  snapshot: ContextRecipe | null,
): void => {
  const ctx = stores.context as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(ctx, 'recipe')) return;
  const safeSnapshot: ContextRecipe = {};
  if (snapshot) assignOwnSafe(safeSnapshot, snapshot);
  ctx.recipe = safeSnapshot;
};

/** Iteratively drop the largest entries from `candidate` until the
 *  serialized size fits within `CONTEXT_RECIPE_MAX_BYTES`. Pure —
 *  produces a fresh object every step; the input is never mutated.
 *
 *  Largest-first is the right policy: a single oversize step output
 *  is the typical pathology (e.g., the recipe accidentally
 *  references a 50 KB AI prompt result), and dropping the biggest
 *  contributor recovers the most budget per drop. Smaller fields
 *  survive so the rest of the prior-run state continues to work. */
const trimToSize = (
  candidate: ContextRecipe,
): ContextRecipeSnapshotResult => {
  const truncated: string[] = [];
  const working: Record<string, unknown> = { ...candidate };

  if (measureBytes(working) <= CONTEXT_RECIPE_MAX_BYTES) {
    return { snapshot: working, truncated };
  }

  // Sort entries by serialized size descending and drop the heaviest
  // one at a time until under the cap. Re-measure after each drop —
  // serialization isn't strictly additive (commas, braces), so an
  // optimistic byte-budget pass would over-drop in pathological cases.
  const sized = Object.entries(working)
    .map(([k, v]) => ({ k, v, bytes: measureBytes({ [k]: v }) }))
    .sort((a, b) => b.bytes - a.bytes);

  for (const entry of sized) {
    if (measureBytes(working) <= CONTEXT_RECIPE_MAX_BYTES) break;
    delete working[entry.k];
    truncated.push(entry.k);
  }

  return { snapshot: working, truncated };
};

const measureBytes = (value: unknown): number => {
  const json = JSON.stringify(value ?? {});
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  return encoder ? encoder.encode(json).length : json.length;
};
