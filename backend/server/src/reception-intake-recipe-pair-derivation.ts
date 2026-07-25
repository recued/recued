/** Exact form/recipe pair derivation. This server-level boundary owns
 * the recipes-package parser so the anonymous Reception port remains free of
 * engine/recipes imports under Must Hold I-12. */

import {
  paidDocumentDirectCheckoutSellerAssociation,
  receptionPairBinding,
  type IntakeFormConfig,
  type RecipeDefinition,
} from '@recued/contracts';
import { parseRecipe } from '@recued/recipes';

import type { ReceptionIntakeRecipePairDerivation } from './ports/reception/intake-recipe-pair.js';

/** Validate one cloned saved recipe through the standard parser before
 * hashing it with the current form. `parseRecipe` normalizes legacy output
 * aliases in place, so cloning prevents a read-only source check from mutating
 * RecipeStore's bundled/in-memory object.
 *
 * The seller association is resolved HERE, not inside the binding builder:
 * the general binding owns only the pair SHAPE, while the D-200 claim
 * configuration is (today) the one vocabulary a recipe uses to name an
 * offer-associated pair. */
export const deriveReceptionIntakeRecipePairBinding = (input: {
  readonly form_config: IntakeFormConfig;
  readonly recipe: RecipeDefinition;
}): ReceptionIntakeRecipePairDerivation => {
  try {
    const snapshot = structuredClone(input.recipe) as unknown;
    const parsed = parseRecipe(snapshot);
    if (!parsed.ok) return { kind: 'recipe_invalid' };
    const binding = receptionPairBinding({
      form_config: input.form_config,
      recipe: parsed.recipe,
      seller_offer_id: paidDocumentDirectCheckoutSellerAssociation(parsed.recipe),
    });
    return binding === null
      ? { kind: 'pair_incompatible' }
      : { kind: 'ready', binding };
  } catch {
    return { kind: 'recipe_invalid' };
  }
};
