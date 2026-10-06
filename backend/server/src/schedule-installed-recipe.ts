/** D-193 amendment (2026-10-05) — chat's `recipe.schedule`: arm an installed
 *  recipe to run later, through the same handler the Run dialog and Automation
 *  use (`createSchedule`).
 *
 *  It replaced the D-193 `schedule-recipe` kernel STEP. The owner ruled that no
 *  recipe step may schedule another recipe ("take out core.schedule.recipe, not to
 *  be used in recipe step"), so `core.schedule.recipe` became a native grant-only
 *  op and scheduling is chat's own Tier-1 tool, granted by its contract. This is
 *  the one way that tool reaches the schedule store.
 *
 *  What it keeps from the step it replaced, deliberately:
 *    - the recipe-existence check (`recipeStore` handed to the handler), which a
 *      model needs more than a screen does: it can name a recipe that is not there;
 *    - the missing-pack refusal from the ONE factory every way in uses
 *      (`createMissingPackDepsForRecipe`), so a schedule is never armed for a
 *      recipe that could not run;
 *    - no settings: the schedule runs the recipe with its own saved settings (its
 *      main dish, made empty when it has none), never with values a model chose.
 *      An empty main dish is the defaults the recipe's webhook door was already
 *      derived from, so making one moves no door (D-209). */

import type { IngredientManifest } from '@recued/contracts';

import { createMissingPackDepsForRecipe, type InstalledPackScan } from './pack-inventory.js';
import type { RecipeStore } from './recipe-store.js';
import { createSchedule, type ScheduleHandlerDeps } from './schedule-handler.js';

export interface InstalledRecipeScheduleInput {
  readonly recipe_id: string;
  readonly publisher_id: string;
  readonly mode: 'one_shot' | 'recurring';
  /** One-shot only: when it runs, as Unix ms. */
  readonly run_at?: number;
  /** Recurring only: a five-field cron expression. */
  readonly cron_expression?: string;
  readonly dish_id?: string;
  readonly enabled?: boolean;
}

export type InstalledRecipeScheduler = (
  input: InstalledRecipeScheduleInput,
) => ReturnType<typeof createSchedule>;

export const createInstalledRecipeScheduler = (deps: {
  readonly scheduleDeps: ScheduleHandlerDeps;
  readonly recipeStore: Pick<RecipeStore, 'get'>;
  /** The installed packs and the manifest registry, for the missing-pack refusal.
   *  Absent ⇒ no refusal, exactly as on the webclient's route. */
  readonly packs?: {
    readonly scanInstalledPacks: InstalledPackScan;
    readonly getManifest: (slug: string) => IngredientManifest | null;
  };
}): InstalledRecipeScheduler => {
  const handlerDeps: ScheduleHandlerDeps = {
    ...deps.scheduleDeps,
    recipeStore: deps.recipeStore,
    ...(deps.packs !== undefined
      ? {
          missingPackDepsForRecipe: createMissingPackDepsForRecipe(
            deps.recipeStore,
            deps.packs.scanInstalledPacks,
            deps.packs.getManifest,
          ),
        }
      : {}),
  };
  return (input) => createSchedule(handlerDeps, {
    recipe_id: input.recipe_id,
    publisher_id: input.publisher_id,
    mode: input.mode,
    ...(input.run_at !== undefined ? { run_at: input.run_at } : {}),
    ...(input.cron_expression !== undefined ? { cron_expression: input.cron_expression } : {}),
    ...(input.dish_id !== undefined ? { dish_id: input.dish_id } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  });
};
