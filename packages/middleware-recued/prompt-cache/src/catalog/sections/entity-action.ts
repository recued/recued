/** D-164 P3 — entity-action section assembler.
 *
 *  Partitions Tier 2 mutation recipes — every entry surfaces under
 *  `<publisher>/<slug>` and goes through the D-157 gateway preflight
 *  before dispatch. Filters by per-`IngredientKind` toggle so disabled
 *  ingredient kinds hide every recipe that requires them.
 *
 *  Tier 2 classification placement (provisional at P3, may tune in
 *  P4 once recipe-side classification metadata is richer):
 *
 *  - `'read'`   → skipped; no section surfaces read recipes today.
 *                 The chat agent calls Tier 1 `entity.query` primitives
 *                 directly for warehouse reads; a Tier 2 read recipe
 *                 would be a custom search not yet expressed in the
 *                 6-section catalog. P4 may add a Tier-2-reads slot
 *                 or fold them into a dedicated section.
 *  - `'write'`  → entity-action.
 *  - `'unknown'`→ entity-action. Default classification for installed
 *                 recipes (per `packages/recipes/src/chat-catalog.ts`),
 *                 so this clause admits the majority of user recipes.
 *                 Safer-by-default: routing unknowns through the
 *                 gateway gives the user the approval surface a
 *                 mis-classified read-recipe author would have skipped;
 *                 a recipe with no side effects still has an
 *                 unobtrusive gateway path.
 *
 *  Section description is an extrapolation — bench has no entity-action
 *  arm yet. TODO(P4-bench): validate framing once a mutation-bench arm
 *  exists.
 *
 *  See: D-164 § 4. */

import type {
  CatalogAssemblyInput,
  CatalogToolEntry,
  SectionAssembly,
} from '../../types.js';

import { recipeKindsAllowed } from '../filter.js';

/** Extrapolation per design doc § 4 — entity-action section is
 *  bench-untested. Frames the gateway so the LLM doesn't expect
 *  instant dispatch on a mutation. Approval is per-tool risk-tier per
 *  D-157 policy (not universal), so the copy says "may require"
 *  rather than implying every dispatch blocks on approval. */
export const ENTITY_ACTION_SECTION_DESCRIPTION =
  'Mutating tools that change state — send mail, update a record, file a '
  + 'task. Dispatch goes through the gateway; depending on the tool\'s risk '
  + 'tier the user may be asked to approve before the action runs. Use only '
  + 'when the user explicitly asked to change something.';

export const assembleEntityActionSection = (
  input: CatalogAssemblyInput,
): SectionAssembly => {
  const tools: CatalogToolEntry[] = [];
  for (const entry of input.registryTools) {
    if (entry.tier !== 2) continue;
    if (entry.classification === 'read') continue;
    if (!recipeKindsAllowed(entry, input.capabilities.enabledKinds)) continue;
    tools.push({
      name: entry.name,
      description: entry.description,
      // D-164 § 6 — per-tool `concurrency_safe` from
      // `buildTier2ToolEntry` via the registry-sourced ToolEntry.
      // Tier 2 is sealed `false` for every installed recipe today
      // (classification is `'unknown'` at catalog time + no recipe-
      // manifest concurrency metadata exists yet) so this branch
      // currently emits `false` for every entry. A future per-recipe
      // opt-in (read recipes; known-safe writes against separate
      // scopes) flips individual entries into the parallel path
      // without touching this assembler.
      concurrency_safe: entry.concurrency_safe,
    });
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return {
    section: 'entity-action',
    description: ENTITY_ACTION_SECTION_DESCRIPTION,
    tools,
  };
};
