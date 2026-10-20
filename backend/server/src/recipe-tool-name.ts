/** A recipe as Chat names it: `<publisher>/<recipe_id>` for a Tier 2 tool, or
 *  the bare recipe id. */

import type { RecipeStore } from './recipe-store.js';

/** Codex review P2 fold (2026-05-12) — resolve publisher-qualified
 *  recipe ids. The `recipe.run` descriptor (§ A.13) tells the model to
 *  invoke recipes by `<publisher>/<slug>`, but `RecipeStore.get()` is
 *  keyed by the bare recipe_id (publisher lives in a separate
 *  `StoredRecipe.publisher_id` column). The lookup tries the literal
 *  string first (works when a recipe_id happens to contain `/`); on
 *  miss + presence of a `/`, retries with the substring after the
 *  first slash. Returns the resolved id or the original on miss
 *  (handleExecute then surfaces `recipe_not_found` verbatim). */
export const resolveRecipeId = (
  raw: string,
  recipeStore: Pick<RecipeStore, 'get'>,
): string => {
  if (recipeStore.get(raw)) return raw;
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) return raw;
  const stripped = raw.slice(slash + 1);
  return recipeStore.get(stripped) ? stripped : raw;
};

/** A recipe tool's title as the owner sees it ("Send a composed email" for
 *  `recued-core/send-composed-mail`), or undefined when no installed recipe
 *  answers to the name or its title is empty. */
export const recipeToolTitle = (
  recipeStore: Pick<RecipeStore, 'get'>,
  tool_name: string,
): string | undefined => {
  const name: unknown = recipeStore.get(resolveRecipeId(tool_name, recipeStore))?.metadata?.name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : undefined;
};
