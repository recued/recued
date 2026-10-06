/** D-304 — a recipe's own state goes with it when it is uninstalled.
 *
 *  The owner's model: a pack owns its recipes, and each recipe owns its settings. The
 *  pack reaches those settings only by uninstalling its recipes. So when a recipe is
 *  uninstalled (its pack deleted, a Records pack removing it, an update dropping it,
 *  or `recipe.delete`), what belongs to the recipe goes with it:
 *
 *    - its schedules, and the automations the owner set up on it (owner-made event
 *      triggers and each dish's auto-run timer — D-319). The triggers it DECLARED are
 *      the reconciler's, which removes them on the same deletion;
 *    - its auto-run failure trip. That is run health, not something the owner set up,
 *      so the Delete confirmation does not count it. Left behind, it tripped the
 *      reinstalled recipe before it ever ran (found driving a live server, 2026-09-24);
 *    - its watchers' state (cursors, firing ledgers), also uncounted run state;
 *    - every saved setting: its dishes (D-319 — the main one, formerly the install
 *      config, and every other), with their prior-run continuity;
 *    - its retired-name list (D-303), which described those settings.
 *
 *  What does NOT belong to the recipe stays: connections and their credentials
 *  (shared across recipes and packs), and a settings group (it can serve other
 *  recipes; only this recipe's dishes leave it).
 *
 *  Before this, the recipe went and all of that stayed. A schedule for a deleted
 *  recipe failed with "recipe not found" at every firing, and nothing would ever
 *  clear it. A recipe whose PROVIDER pack is removed is untouched: it is still
 *  installed and only cannot run for now (`scheduler.ts`).
 *
 *  Run from the recipe store's deletion hook (`RecipeStore.addOnDeleted`), so every
 *  uninstall path gets it from one seam. The composition registers it in
 *  `compose-listeners.ts`. */

import type { AutoRunSettingsStore, CircuitBreakerStore } from './auto-run-scheduler.js';
import type { DishContextStore } from './dish-context-store.js';
import type { DishStore } from './dish-store.js';
import type { RecipeStore } from './recipe-store.js';
import type { ScheduleStore } from './schedule-store.js';
import type { EventTriggersStore } from './triggers/store.js';

/** The stores a recipe's own state lives in. Each is optional: a server without one
 *  has nothing of that kind to remove. */
export interface RecipeOwnedStateDeps {
  readonly recipes?: Pick<RecipeStore, 'forgetRetiredVariables'> & Partial<Pick<RecipeStore, 'getBundled'>>;
  readonly dishes?: Pick<DishStore, 'listByRecipe' | 'delete'>;
  readonly dishContext?: Pick<DishContextStore, 'clear'>;
  readonly schedules?: Pick<ScheduleStore, 'listByRecipe' | 'delete'>;
  /** D-319 — each dish's auto-run timer. */
  readonly autoRun?: Pick<AutoRunSettingsStore, 'list' | 'forgetRecipe'>;
  readonly triggers?: Pick<EventTriggersStore, 'list' | 'remove'>;
  /** The auto-run failure trips (one per dish's timer). The live roster holds them
   *  in memory too, so the caller also rebuilds the roster when the recipe was on it. */
  readonly autoRunCircuit?: Pick<CircuitBreakerStore, 'clearRecipe'>;
  /** Its watchers' state (2026-10-05): the calendar watcher's cursor and record of
   *  returned events, the time-relative watcher's firing ledger and start point,
   *  the page watcher's memory of the page (`once_per_change`).
   *  Left behind, a reinstall resumed from them: a time-relative watch fired every
   *  boundary since the FIRST install, a calendar cursor every change since. Run
   *  state, like the failure trip, so the Delete confirmation does not count it. */
  readonly watcherState?: { clear(recipe_id: string): void };
}

/** What a recipe's uninstall removes (or would remove). */
export interface RecipeOwnedState {
  readonly schedules: number;
  /** Owner-made event triggers, plus each dish's auto-run timer. */
  readonly automations: number;
  /** Saved settings: dishes of every kind. */
  readonly settings: number;
}

/** ⛔ A recipe the server BUNDLES is not uninstalled by removing its stored row:
 *  `get` still resolves the bundled copy, so it stays listed and runnable, and its
 *  settings are still the owner's. `recipe.delete` refuses such a delete for this
 *  reason, and `retired-settings.ts` defines "gone" the same way.
 *
 *  Integrity audit, 2026-09-24: uninstalling `personal-organizer-foundation`
 *  removed the owner's settings, schedules and triggers for its ten recipes, which
 *  stayed available from the bundle. So neither the removal nor the preview
 *  touches one. */
const stillInstalled = (recipe_id: string, deps: RecipeOwnedStateDeps): boolean =>
  deps.recipes?.getBundled?.(recipe_id) != null;

const NOTHING: RecipeOwnedState = { schedules: 0, automations: 0, settings: 0 };

const ownerMadeTriggers = (recipe_id: string, deps: RecipeOwnedStateDeps) =>
  (deps.triggers?.list() ?? []).filter((trigger) => trigger.recipe_id === recipe_id && trigger.origin !== 'recipe');

/** Remove everything that belongs to an uninstalled recipe. The automations first,
 *  since each points at settings removed after it. */
export const removeRecipeOwnedState = (recipe_id: string, deps: RecipeOwnedStateDeps): RecipeOwnedState => {
  if (stillInstalled(recipe_id, deps)) return NOTHING;
  const schedules = deps.schedules?.listByRecipe(recipe_id) ?? [];
  for (const schedule of schedules) deps.schedules!.delete(schedule.schedule_id);
  const triggers = ownerMadeTriggers(recipe_id, deps);
  for (const trigger of triggers) deps.triggers!.remove(trigger.trigger_id);
  const timers = deps.autoRun?.forgetRecipe?.(recipe_id) ?? 0;
  deps.autoRunCircuit?.clearRecipe?.(recipe_id);
  deps.watcherState?.clear(recipe_id);
  const dishes = deps.dishes?.listByRecipe(recipe_id) ?? [];
  for (const dish of dishes) {
    deps.dishes!.delete(dish.dish_id);
    deps.dishContext?.clear(dish.dish_id);
  }
  deps.recipes?.forgetRetiredVariables?.(recipe_id);
  return { schedules: schedules.length, automations: triggers.length + timers, settings: dishes.length };
};

/** What `removeRecipeOwnedState` would remove, read-only: the Delete confirmation's
 *  "also removes …". Each dish's auto-run timer counts: a timer exists only when the
 *  owner switched its dish on (D-319). */
export const recipeOwnedStateOf = (recipe_id: string, deps: RecipeOwnedStateDeps): RecipeOwnedState => {
  if (stillInstalled(recipe_id, deps)) return NOTHING;
  const timers = (deps.autoRun?.list() ?? []).filter((timer) => timer.recipe_id === recipe_id).length;
  return {
    schedules: deps.schedules?.listByRecipe(recipe_id).length ?? 0,
    automations: ownerMadeTriggers(recipe_id, deps).length + timers,
    settings: deps.dishes?.listByRecipe(recipe_id).length ?? 0,
  };
};
