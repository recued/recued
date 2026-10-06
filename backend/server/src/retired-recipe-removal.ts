/** D-193 amendment (2026-10-05) — remove, at boot, a shipped recipe Recued has
 *  retired and that can never run again.
 *
 *  `recued-core/schedule-recipe` left the Personal Organizer Foundation when no
 *  recipe step could schedule another recipe any more (`core.schedule.recipe` is
 *  a grant now, with nothing a step can run). A server that installed the pack
 *  before that keeps the row: re-installing or updating a pack re-saves what its
 *  new manifest ships and never removes what it dropped. Left there, the recipe
 *  is refused at every run, yet chat's `tools.search` still offers it beside the
 *  `recipe.schedule` tool that replaced it. Owner: "yes remove the dead
 *  schedule-recipe at boot".
 *
 *  - **Only the shipped copy.** A row is removed only when it carries the
 *    first-party publisher it shipped under. A recipe the owner saved under the
 *    same id is theirs, and stays.
 *  - **Through the store's own delete.** Its hooks remove everything the recipe
 *    owns — its schedules, dishes, triggers and timer (D-304,
 *    `recipe-owned-state.ts`) — and purge its grant row (D-247 D14,
 *    `recipe-grant-seed.ts`), exactly as an uninstall does. So this runs once
 *    those hooks are registered (`compose-listeners.ts`) and before any
 *    scheduler starts.
 *  - **Every boot, not once.** The check is one read per retired recipe, and a
 *    retired recipe can come back (an archive restore), so there is no ledger
 *    row: whenever it is there, it goes. */

import type { RecipeStore } from './recipe-store.js';

/** A shipped recipe that was retired, as it was installed. */
export interface RetiredShippedRecipe {
  readonly recipe_id: string;
  /** The publisher it shipped under. A row under any other publisher is not it. */
  readonly publisher_id: string;
}

export const RETIRED_SHIPPED_RECIPES: readonly RetiredShippedRecipe[] = [
  // D-193 amendment, 2026-10-05: chat schedules with `recipe.schedule`.
  { recipe_id: 'schedule-recipe', publisher_id: 'recued-core' },
];

export interface RetiredRecipeRemovalResult {
  /** `<publisher>/<recipe_id>` of each recipe removed this boot. */
  readonly removed: readonly string[];
}

export const removeRetiredShippedRecipes = (
  store: Pick<RecipeStore, 'getStored' | 'delete'>,
  retired: readonly RetiredShippedRecipe[] = RETIRED_SHIPPED_RECIPES,
): RetiredRecipeRemovalResult => {
  const removed: string[] = [];
  // A partial store (a db-less harness) cannot say what is installed: nothing to do.
  if (typeof store.getStored !== 'function' || typeof store.delete !== 'function') return { removed };
  for (const entry of retired) {
    const stored = store.getStored(entry.recipe_id);
    if (stored === null || stored.publisher_id !== entry.publisher_id) continue;
    if (store.delete(entry.recipe_id)) removed.push(`${entry.publisher_id}/${entry.recipe_id}`);
  }
  return { removed };
};
