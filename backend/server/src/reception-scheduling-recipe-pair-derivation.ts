/** D-210 R-2 — exact scheduling/recipe pair derivation.
 *
 * The scheduling sibling of `reception-intake-recipe-pair-derivation.ts`, and it exists at
 * this level for the same reason: the anonymous Reception port stays free of
 * engine/recipes imports under Must Hold I-12, so the server-level boundary owns the
 * recipes-package parser and hands the port a derived binding.
 *
 * ⛔ NO seller association, and that is not an omission. The intake derivation resolves one
 * HERE because a form is (today) the one surface a recipe names an offer from; a v3 binding
 * has no `seller_offer_id` field at all (`reception-pair-binding.ts` — the scheduling
 * variant's key set is the shared base and nothing else), so there is nothing to resolve
 * and no place to put it if there were.
 */

import {
  receptionSchedulingPairBinding,
  type RecipeDefinition,
  type SchedulingLinkVisitorFieldRequirements,
} from '@recued/contracts';
import { parseRecipe } from '@recued/recipes';

import type { ReceptionSchedulingRecipePairDerivation } from './ports/reception/scheduling-recipe-pair.js';

/** Validate one cloned saved recipe through the standard parser before hashing it with the
 * endpoint's current visitor-field map. `parseRecipe` normalizes legacy output aliases in
 * place, so cloning prevents a read-only source check from mutating RecipeStore's
 * bundled/in-memory object. */
export const deriveReceptionSchedulingRecipePairBinding = (input: {
  readonly required_visitor_fields: SchedulingLinkVisitorFieldRequirements;
  readonly recipe: RecipeDefinition;
}): ReceptionSchedulingRecipePairDerivation => {
  try {
    const snapshot = structuredClone(input.recipe) as unknown;
    const parsed = parseRecipe(snapshot);
    if (!parsed.ok) return { kind: 'recipe_invalid' };
    const binding = receptionSchedulingPairBinding({
      required_visitor_fields: input.required_visitor_fields,
      recipe: parsed.recipe,
    });
    return binding === null
      ? { kind: 'pair_incompatible' }
      : { kind: 'ready', binding };
  } catch {
    return { kind: 'recipe_invalid' };
  }
};
