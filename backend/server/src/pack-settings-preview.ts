/** D-303 — the saved settings a pack update stops using, named before the owner
 *  presses Update.
 *
 *  An update that drops a variable no longer refuses the runs of an owner who saved
 *  it: the recipe store records the name, and the run drops its value
 *  (`RecipeStore.retiredVariables`). The value stays stored, but it no longer
 *  applies. That is a change in what the owner's automation does, so the update
 *  dialog says so, as it does for an automation it switches off (D-296) and a form it
 *  stops (D-299).
 *
 *  Only a setting the owner actually SAVED is named: one they never touched changes
 *  nothing. Saved means in any dish of the recipe (the install config included, and
 *  the managed dishes behind schedules, triggers and auto-run) or in a group one of
 *  those dishes belongs to. */

import {
  droppedVariables,
  type RecipeDefinition,
  type VariableDefault,
} from '@recued/contracts';

import type { DishGroupStore } from './dish-group-store.js';
import type { DishStore } from './dish-store.js';

/** Where the owner's settings are saved. */
export interface SavedSettingsReader {
  readonly dishes: Pick<DishStore, 'listByRecipe'>;
  readonly groups?: Pick<DishGroupStore, 'get'>;
}

/** One saved setting an update stops using. */
export interface SettingNoLongerUsed {
  readonly recipe_id: string;
  /** The recipe's name, as the owner knows it. */
  readonly recipe: string;
  /** The setting's label in the version the owner saved it under. */
  readonly setting: string;
}

const labelOf = (name: string, def: VariableDefault | undefined): string => {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return name;
  const label = (def as { label?: unknown }).label;
  return typeof label === 'string' && label.trim() !== '' ? label : name;
};

/** Every saved setting that `after` no longer declares, per recipe. `before` null (a
 *  fresh install) drops nothing. */
export const settingsNoLongerUsed = (
  recipes: ReadonlyArray<{
    readonly recipe_id: string;
    readonly before: RecipeDefinition | null;
    readonly after: RecipeDefinition;
  }>,
  saved: SavedSettingsReader,
): SettingNoLongerUsed[] => {
  const out: SettingNoLongerUsed[] = [];
  for (const { recipe_id, before, after } of recipes) {
    const dropped = droppedVariables(before, after);
    if (dropped.length === 0) continue;
    const savedKeys = new Set<string>();
    for (const dish of saved.dishes.listByRecipe(recipe_id)) {
      for (const key of Object.keys(dish.config_overlay)) savedKeys.add(key);
      if (dish.group_id === undefined) continue;
      for (const key of Object.keys(saved.groups?.get(dish.group_id)?.config_overlay ?? {})) savedKeys.add(key);
    }
    const name = typeof after.metadata?.name === 'string' && after.metadata.name.trim() !== ''
      ? after.metadata.name : recipe_id;
    for (const variable of dropped) {
      if (!savedKeys.has(variable)) continue;
      out.push({ recipe_id, recipe: name, setting: labelOf(variable, before?.variables?.[variable]) });
    }
  }
  return out;
};
