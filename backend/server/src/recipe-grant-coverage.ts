/** One op vocabulary for the live gate and D-261's frozen program. Required
 * byte-read children do not acquire a recipe grant merely by being reviewed. */
import { kernelOpForBackingSlug, type IngredientManifest, type RecipeDefinition } from '@recued/contracts';
import { deriveRecipeCapability } from './derive-recipe-capability.js';
import type { RecipeCoverage } from './policy-gate.js';

export const deriveGrantedRecipeCoverage = (
  recipe: RecipeDefinition, config: Record<string, unknown> | undefined,
  manifest: (slug: string) => IngredientManifest | null | undefined,
): RecipeCoverage | undefined => {
  const derived = deriveRecipeCapability(recipe, {
    ...(config !== undefined ? { config } : {}),
    resolveOp: (slug, operation) => [manifest(slug)?.operations?.[operation]?.operation_id ?? operation],
  });
  return derived.ok ? { recipe_id: recipe.recipe_id, operation_ids: new Set([
    ...derived.capability.operation_ids,
    ...derived.capability.ingredient_ids.map(slug => kernelOpForBackingSlug(slug))
      .filter((op): op is string => op !== undefined),
  ]) } : undefined;
};
