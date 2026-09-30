/** D-319 — the guided spreadsheet import's "remember these columns" keeps
 *  them as the recipe's MAIN dish's settings: the dish a run that names none
 *  takes its settings from. With no dish, remembering makes one, OFF: saved,
 *  not switched on (remembering must not start the recipe's triggers). With
 *  nothing to remember and no dish, nothing is made.
 *
 *  Replaces `recipe_config.get` / `.set`, which D-319 retired: the recipe
 *  page and Pack Use both open the import, so both build it from here. */

import type { Dish } from '@recued/contracts';

export interface MainDishSettingsCallers {
  readonly list: () => Promise<{ readonly dishes: readonly Dish[] }>;
  readonly update: (args: {
    dish_id: string;
    config_overlay: Record<string, unknown>;
  }) => Promise<unknown>;
  readonly create: (args: {
    recipe_id: string;
    publisher_id: string;
    config_overlay: Record<string, unknown>;
    enabled: boolean;
  }) => Promise<unknown>;
}

export interface MainDishSettings {
  readonly get: (args: { recipe_id: string }) => Promise<{ config_overlay: Record<string, unknown> }>;
  readonly set: (args: {
    recipe_id: string;
    publisher_id?: string;
    config_overlay: Record<string, unknown>;
  }) => Promise<{ config_overlay: Record<string, unknown> }>;
}

export const mainDishSettings = (callers: MainDishSettingsCallers): MainDishSettings => {
  const mainOf = async (recipe_id: string): Promise<Dish | undefined> =>
    (await callers.list()).dishes.find((dish) => dish.recipe_id === recipe_id && dish.is_default);
  return {
    get: async ({ recipe_id }) => ({ config_overlay: { ...((await mainOf(recipe_id))?.config_overlay ?? {}) } }),
    set: async ({ recipe_id, publisher_id, config_overlay }) => {
      const main = await mainOf(recipe_id);
      if (main !== undefined) {
        await callers.update({ dish_id: main.dish_id, config_overlay });
      } else if (Object.keys(config_overlay).length > 0 && publisher_id !== undefined) {
        await callers.create({ recipe_id, publisher_id, config_overlay, enabled: false });
      }
      return { config_overlay };
    },
  };
};
