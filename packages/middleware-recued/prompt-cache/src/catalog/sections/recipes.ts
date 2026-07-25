/** D-164 P3 — recipes section assembler.
 *
 *  Surfaces the Tier 1 `recipe.run` umbrella per D-137 § A.1.1 — one
 *  entry point, per-recipe permission rides the existing per-token
 *  grants UI (D-137 § A.9). The catalog does NOT synthesize per-recipe
 *  shells (resolved per design doc § 6).
 *
 *  Section description is an extrapolation — bench has no recipes arm
 *  yet. TODO(P4-bench): tune once recipes are exercised.
 *
 *  See: D-164 § 4. */

import type {
  CatalogAssemblyInput,
  CatalogToolEntry,
  SectionAssembly,
} from '../../types.js';

/** Extrapolation per design doc § 4. Frames `recipe.run` as the
 *  single dispatch path for installed user / kernel recipes. */
export const RECIPES_SECTION_DESCRIPTION =
  'Installed user and kernel recipes runnable as one tool call via '
  + 'recipe.run. Use when the user references a saved workflow by name or '
  + 'when a saved recipe shape matches the request. Per-recipe permission '
  + 'gates run before execution.';

/** Tier 1 entries that belong in this section. */
const RECIPES_TIER1_NAMES: ReadonlySet<string> = new Set(['recipe.run']);

export const assembleRecipesSection = (
  input: CatalogAssemblyInput,
): SectionAssembly => {
  const tools: CatalogToolEntry[] = [];
  for (const entry of input.registryTools) {
    if (entry.tier !== 1) continue;
    if (!RECIPES_TIER1_NAMES.has(entry.name)) continue;
    tools.push({
      name: entry.name,
      description: entry.description,
      // D-164 § 6 — per-tool `concurrency_safe` from
      // `TIER1_CONCURRENCY_SAFE` via the registry-sourced ToolEntry.
      // `recipe.run` declares `false`: the umbrella can't infer per-
      // recipe concurrency, so sequential is the safe default. A
      // future per-recipe-manifest opt-in could flip individual
      // dispatches into the parallel path.
      concurrency_safe: entry.concurrency_safe,
    });
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return {
    section: 'recipes',
    description: RECIPES_SECTION_DESCRIPTION,
    tools,
  };
};
