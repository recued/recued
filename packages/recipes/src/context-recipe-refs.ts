/** D-120 Phase 4.5 — `context.recipe.*` static analyzer.
 *
 *  Extracts the deduped set of step IDs the recipe reads via
 *  `{{context.recipe.<step_id>}}` references. The list is the
 *  authoritative manifest of what the engine snapshots at run end —
 *  unreferenced step outputs are not stored, keeping the per-recipe
 *  prefs payload small.
 *
 *  Captured at install time and stored alongside
 *  `recipe_insights.flattened` so the manifest survives recipe-version
 *  upgrades. The extractor is pure over the recipe shape — same JSON
 *  always produces the same list, sorted lexicographically for stable
 *  hashes / diffs.
 *
 *  Spec: D-120.
 */

import { collectRefs, type RecipeDefinition } from '@recued/contracts';

const PROTOTYPE_SENSITIVE_STEP_IDS = new Set(['__proto__', 'constructor', 'prototype']);

/** Walk every value field in the recipe's steps + output looking for
 *  `{{context.recipe.<step_id>...}}` references. Returns the unique set
 *  of root step IDs (`<step_id>` segment); nested paths under the step
 *  ID (`{{context.recipe.deal.amount}}`) collapse to the root id (`deal`)
 *  since the engine snapshots whole step outputs, not field-level slices.
 *
 *  Sorted output is intentional — deterministic order keeps consumers
 *  (recipe-insights flattened payload, diff tools, hash-keyed lookups)
 *  stable across reinvocations. */
export const extractContextRecipeRefs = (
  recipe: RecipeDefinition,
): string[] => {
  const refs = collectRefs(recipe);
  const stepIds = new Set<string>();
  for (const ref of refs) {
    if (ref.ns !== 'context') continue;
    if (!ref.path.startsWith('recipe.')) continue;
    const rest = ref.path.slice('recipe.'.length);
    if (!rest) continue;
    // `{{context.recipe}}` itself (no step id) is meaningless — skip.
    // `{{context.recipe.foo.bar}}` snapshots `foo` whole and the
    // resolver later walks `.bar` against the stored value at run start.
    const stepId = rest.split('.')[0];
    if (!stepId) continue;
    if (PROTOTYPE_SENSITIVE_STEP_IDS.has(stepId)) continue;
    stepIds.add(stepId);
  }
  return [...stepIds].sort();
};
