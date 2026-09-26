/** D-303 (amended) — a recipe's retired variables live exactly as long as something
 *  they describe: the recipe itself, or settings the owner saved for it.
 *
 *  The retired list (`RecipeStore.retiredVariables`) tells a run which saved values
 *  to drop rather than refuse. A list kept once nothing is left would be an orphan.
 *
 *  D-304: uninstalling a recipe removes its settings and its list together
 *  (`recipe-owned-state.ts`), so an uninstall leaves nothing for this to find. What
 *  is left is a list from a pack deleted before D-304, when settings outlived their
 *  recipe. The boot sweep (`compose-rpc-context`) forgets such a list once its last
 *  saved setting is gone too. It never deletes the settings themselves.
 *
 *  "The recipe is gone" means `get` finds nothing: a foundation recipe whose stored
 *  row was removed still runs from the bundle, so its list still applies. */

import type { DishStore } from './dish-store.js';
import type { RecipeStore } from './recipe-store.js';

export interface ForgetRetiredDeps {
  readonly recipeStore: Pick<RecipeStore, 'get' | 'retiredVariables' | 'retiredRecipeIds' | 'forgetRetiredVariables'>;
  readonly dishes: Pick<DishStore, 'listByRecipe'>;
}

/** Forget the retired list of every recipe in `recipeIds` (default: every recipe that
 *  has one) that is gone and has no saved settings left. Returns the ids forgotten. */
export const forgetUnusedRetirements = (
  deps: ForgetRetiredDeps,
  recipeIds?: readonly string[],
): string[] => {
  const forgotten: string[] = [];
  for (const recipe_id of recipeIds ?? deps.recipeStore.retiredRecipeIds?.() ?? []) {
    if ((deps.recipeStore.retiredVariables?.(recipe_id) ?? []).length === 0) continue;
    if (deps.recipeStore.get(recipe_id) !== null) continue;
    if (deps.dishes.listByRecipe(recipe_id).length > 0) continue;
    deps.recipeStore.forgetRetiredVariables?.(recipe_id);
    forgotten.push(recipe_id);
  }
  return forgotten;
};
