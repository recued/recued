/** D-319 amendment (owner, 2026-10-11): "scheduled runs should require the
 *  necessary fields for any recipes to run properly, that should apply to all
 *  recipes." The arming half: a schedule, a trigger or the auto-run timer is not
 *  armed for a dish whose settings leave empty one its recipe needs, and a dish
 *  that starts on its own is not switched on, or its settings saved, that way.
 *  The run half is in `execute-handler.ts`, for what was armed before this or
 *  changed after (a recipe update that added a setting).
 *
 *  ⛔ Before, nothing on the server checked a dish's settings: the dish form
 *  did, and the run dialog's Schedule tab, the Automation timer dialog, a
 *  dish's switch and chat's `recipe.schedule` all went around it.
 *
 *  What a run on its own needs is `missingUnattendedSettings` (`@recued/recipes`),
 *  the one reader the screens share. The settings checked are the ones such a run
 *  takes: its dish's, over its group's (`mergeRecipeConfigLayers`). */

import { RpcError, startsOnItsOwn, type Dish, type RecipeDefinition } from '@recued/contracts';
import { describeMissingUnattended, missingUnattendedSettings, type NeededSetting } from '@recued/recipes';

import { mergeRecipeConfigLayers } from './recipe-effective-config.js';

type DishSettings = Pick<Dish, 'dish_id' | 'recipe_id' | 'name' | 'config_overlay' | 'group_id' | 'enabled' | 'connections'>;

export interface UnattendedSettingsGate {
  /** Before arming a schedule, a trigger or the timer of a dish: the dish named,
   *  else the recipe's main dish, else (none yet) the settings it will be made
   *  with. */
  assertStart(input: {
    readonly recipe_id: string;
    readonly dish_id?: string | null;
    readonly config_overlay?: Record<string, unknown> | null;
  }): void;
  /** Before a dish is made on, switched on, or has its settings saved while on:
   *  only one that starts on its own — its recipe has a timer or a trigger, or
   *  the dish has a schedule or trigger of its own. */
  assertDish(dish: DishSettings): void;
}

export interface UnattendedSettingsGateDeps {
  readonly recipeOf: (recipe_id: string) => RecipeDefinition | null;
  readonly dishOf: (dish_id: string) => Dish | null;
  readonly mainDishOf: (recipe_id: string) => Dish | null;
  readonly groupOverlayOf?: (group_id: string) => Record<string, unknown> | undefined;
  /** How many schedules and triggers the dish has of its own. */
  readonly ownRowsOf?: (dish_id: string) => number;
  /** Why such a run, with these settings and the dish's choice of connection, would
   *  be refused for a connection before its first step (`unattendedConnectionProblem`,
   *  the run's own rules); `null` when it would not. Absent ⇒ connections unchecked. */
  readonly connectionProblemOf?: (input: {
    readonly recipe: RecipeDefinition;
    readonly config: Record<string, unknown>;
    readonly dish: { readonly connections?: Readonly<Record<string, string>>; readonly label: string } | null;
  }) => { readonly reason: string; readonly variable?: string } | null;
}

const settingsOf = (deps: UnattendedSettingsGateDeps, dish: DishSettings): Record<string, unknown> =>
  mergeRecipeConfigLayers({
    bound_dish: {
      config_overlay: dish.config_overlay,
      group_overlay: dish.group_id !== undefined ? deps.groupOverlayOf?.(dish.group_id) ?? {} : {},
    },
  });

const nameOf = (recipe: RecipeDefinition): string => recipe.metadata?.name?.trim() || recipe.recipe_id;
const dishLabel = (dish: DishSettings): string => (dish.name !== '' ? dish.name : dish.dish_id);
const fill = (missing: readonly NeededSetting[]): string => (missing.length === 1 ? 'it' : 'them');

const refuse = (missing: readonly NeededSetting[], message: string, dish_id?: string): never => {
  throw new RpcError('dish_settings_missing', message, 409, undefined, {
    missing: missing.map((setting) => setting.key),
    ...(dish_id !== undefined ? { dish_id } : {}),
  });
};

/** A connection such a run could not settle: the setting it would have to ask about
 *  and where the owner chooses one, or the run's own reason. */
const refuseConnection = (
  deps: UnattendedSettingsGateDeps,
  recipe: RecipeDefinition,
  config: Record<string, unknown>,
  dish: DishSettings | null,
): void => {
  const problem = deps.connectionProblemOf?.({
    recipe,
    config,
    dish: dish !== null ? { ...(dish.connections !== undefined ? { connections: dish.connections } : {}), label: dishLabel(dish) } : null,
  });
  if (problem === null || problem === undefined) return;
  const where = dish !== null ? `the settings of "${dishLabel(dish)}"` : 'its settings';
  throw new RpcError(
    'dish_connection_missing',
    problem.variable !== undefined
      ? `"${nameOf(recipe)}" cannot run on its own: it needs a connection for '${problem.variable}', and nobody is `
        + `there to ask which then. Choose one in ${where}, or a default on its pack's Access tab.`
      : `"${nameOf(recipe)}" cannot run on its own: ${problem.reason}`,
    409,
    undefined,
    { ...(problem.variable !== undefined ? { variable: problem.variable } : {}), ...(dish !== null ? { dish_id: dish.dish_id } : {}) },
  );
};

export const createUnattendedSettingsGate = (deps: UnattendedSettingsGateDeps): UnattendedSettingsGate => ({
  assertStart: ({ recipe_id, dish_id, config_overlay }) => {
    const recipe = deps.recipeOf(recipe_id);
    // A recipe the server cannot read is the run's to refuse, not the arming's.
    if (recipe === null) return;
    const dish = dish_id ? deps.dishOf(dish_id) : deps.mainDishOf(recipe_id);
    const settings = dish ? settingsOf(deps, dish) : (config_overlay ?? {});
    const missing = missingUnattendedSettings(recipe, settings);
    if (missing.length === 0) {
      refuseConnection(deps, recipe, settings, dish ?? null);
      return;
    }
    refuse(
      missing,
      `"${nameOf(recipe)}" cannot run on its own until ${describeMissingUnattended(missing)} `
        + `${missing.length === 1 ? 'is' : 'are'} filled in. Fill ${fill(missing)} in `
        + `${dish ? `the settings of "${dishLabel(dish)}"` : 'its settings'} first.`,
      dish?.dish_id,
    );
  },
  assertDish: (dish) => {
    if (!dish.enabled) return;
    const recipe = deps.recipeOf(dish.recipe_id);
    if (recipe === null) return;
    if (!startsOnItsOwn(recipe) && (deps.ownRowsOf?.(dish.dish_id) ?? 0) === 0) return;
    const settings = settingsOf(deps, dish);
    const missing = missingUnattendedSettings(recipe, settings);
    if (missing.length === 0) {
      refuseConnection(deps, recipe, settings, dish);
      return;
    }
    refuse(
      missing,
      `"${nameOf(recipe)}" runs on its own, so "${dishLabel(dish)}" cannot be on with `
        + `${describeMissingUnattended(missing)} empty. Fill ${fill(missing)} in first.`,
      dish.dish_id,
    );
  },
});
