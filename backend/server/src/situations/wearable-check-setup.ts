/** D-339 slice 20 (D-339 §6; 2026-11-19, the owner: "do the smaller setup items") — a Wearable's
 *  sync check, set up by itself.
 *
 *  Until now the owner set it up by hand (the guide's section 9: enrol "Check a wearable is syncing" as the
 *  Wearable's writer, copy the binding id, switch the check on with the Wearable and that id, choose its source,
 *  and give it a daily schedule). Now, once a Wearable belongs to a Body (added under it, or moved under it):
 *  - `check-wearable-sync` is enrolled as its writer, for every condition it has (`not_syncing`), at the installed
 *    version;
 *  - a dish of it is switched on with the Wearable and that binding;
 *  - the dish gets a schedule each day at noon in the owner's zone: a device that stops sends nothing that could
 *    start a run, so only a schedule can notice it.
 *  Which source the device feeds is the Wearable's own setting (`settings.source`, Apple Health unless the owner
 *  says otherwise), which the check reads first. "Set up the sync check" on the Wearable's page does the same for
 *  one whose check is not ready. It changes nothing twice: the binding's id is the Wearable's, the recipe's and its
 *  version's; the dish is the one set to this Wearable, else one of the check's set to none, else a new one; the
 *  schedule is the dish's own. With the check not installed, or the Wearable under no Body, it does nothing.
 *
 *  D-339 slice 22 (2026-11-19, the owner: "yes take on the two follow-ups") — a Wearable that leaves its Body, for
 *  none or for a parent that is not one, would have its check fail each day with "belongs to no Body". `pause`
 *  switches the check's dishes for it off, which switches their schedules and triggers off too
 *  (`dish-automation.ts`; the schedule is also written here, for a composition without that wiring). Moved under a
 *  Body again, `ensure` switches them back on. */
import { BODY_CLASS_ID, WEARABLE_CHECK_RECIPE_ID, WEARABLE_CLASS_ID, type Asset } from '@recued/contracts';
import type { RecipeStore } from '../recipe-store.js';
import { createDish, updateDish, type DishHandlerDeps } from '../dish-handler.js';
import { createSchedule, updateSchedule, type ScheduleHandlerDeps } from '../schedule-handler.js';

/** Each day at noon, in the owner's zone. */
export const WEARABLE_CHECK_CRON = '0 12 * * *';

export interface WearableCheckSetup {
  binding_id: string;
  dish_id: string;
  schedule_id: string;
  /** What happened to the dish: made, set to this Wearable and binding, or already so. */
  dish: 'created' | 'set' | 'kept';
  /** What happened to its daily schedule: made, switched back on, or already so. */
  schedule: 'created' | 'enabled' | 'kept';
}

export interface WearableCheckSetupDeps {
  recipes: Pick<RecipeStore, 'getStored' | 'get'>;
  dishes: DishHandlerDeps;
  schedules: ScheduleHandlerDeps;
  /** The Yours service's own enrolment, as `binding.save` does it: the installed version, these fields. */
  enrol(asset_id: string, recipe_id: string, fields: readonly string[]): { id: string };
  /** The asset with this id, or undefined. */
  assetOf(id: string): Asset | undefined;
}

export interface WearableCheckPaused {
  /** The check's dishes for this Wearable switched off now. */
  dish_ids: string[];
}

export const createWearableCheckSetup = (deps: WearableCheckSetupDeps) => ({
  /** Undefined for anything but a Wearable under a Body, and when the check is not installed. */
  ensure(wearable: Asset): WearableCheckSetup | undefined {
    if (wearable.class_id !== WEARABLE_CLASS_ID || !wearable.belongs_to) return undefined;
    if (deps.assetOf(wearable.belongs_to)?.class_id !== BODY_CLASS_ID) return undefined;
    const row = deps.recipes.getStored(WEARABLE_CHECK_RECIPE_ID);
    if (!row) return undefined;
    const fields = Object.keys(wearable.observations).map(name => `observations.${name}`);
    const binding_id = deps.enrol(wearable.id, WEARABLE_CHECK_RECIPE_ID, fields).id;
    const dishes = deps.dishes.store.listByRecipe(WEARABLE_CHECK_RECIPE_ID);
    const assetOfDish = (dish: { config_overlay: Record<string, unknown> }) => dish.config_overlay?.asset_id;
    const found = dishes.find(dish => assetOfDish(dish) === wearable.id)
      ?? dishes.find(dish => assetOfDish(dish) === undefined || assetOfDish(dish) === null || assetOfDish(dish) === '');
    let dish_id: string; let dish: WearableCheckSetup['dish'] = 'kept';
    if (!found) {
      dish_id = createDish(deps.dishes, { recipe_id: WEARABLE_CHECK_RECIPE_ID, publisher_id: row.publisher_id, name: wearable.name,
        config_overlay: { asset_id: wearable.id, binding_id }, enabled: true }).dish.dish_id;
      dish = 'created';
    } else {
      dish_id = found.dish_id;
      if (assetOfDish(found) !== wearable.id || found.config_overlay.binding_id !== binding_id || !found.enabled) {
        updateDish(deps.dishes, found.dish_id, { config_overlay: { ...found.config_overlay, asset_id: wearable.id, binding_id }, enabled: true,
          ...(assetOfDish(found) === wearable.id || found.name ? {} : { name: wearable.name }) });
        dish = 'set';
      }
    }
    const existing = deps.schedules.store.listByRecipe(WEARABLE_CHECK_RECIPE_ID).find(entry => entry.dish_id === dish_id);
    let schedule_id: string; let schedule: WearableCheckSetup['schedule'] = 'kept';
    if (!existing) {
      schedule_id = createSchedule({ ...deps.schedules, recipeStore: deps.recipes }, { recipe_id: WEARABLE_CHECK_RECIPE_ID,
        publisher_id: row.publisher_id, dish_id, mode: 'recurring', cron_expression: WEARABLE_CHECK_CRON, enabled: true }).schedule.schedule_id;
      schedule = 'created';
    } else {
      schedule_id = existing.schedule_id;
      if (!existing.enabled) { updateSchedule(deps.schedules, existing.schedule_id, { enabled: true }); schedule = 'enabled'; }
    }
    return { binding_id, dish_id, schedule_id, dish, schedule };
  },
  /** Undefined for anything but a Wearable under no Body, and when none of its check's dishes is switched on. */
  pause(wearable: Asset): WearableCheckPaused | undefined {
    if (wearable.class_id !== WEARABLE_CLASS_ID) return undefined;
    if (wearable.belongs_to && deps.assetOf(wearable.belongs_to)?.class_id === BODY_CLASS_ID) return undefined;
    const dishes = deps.dishes.store.listByRecipe(WEARABLE_CHECK_RECIPE_ID).filter(dish => dish.config_overlay?.asset_id === wearable.id && dish.enabled);
    if (!dishes.length) return undefined;
    const schedules = deps.schedules.store.listByRecipe(WEARABLE_CHECK_RECIPE_ID);
    for (const dish of dishes) {
      updateDish(deps.dishes, dish.dish_id, { enabled: false });
      for (const entry of schedules) if (entry.dish_id === dish.dish_id && entry.enabled) updateSchedule(deps.schedules, entry.schedule_id, { enabled: false });
    }
    return { dish_ids: dishes.map(dish => dish.dish_id) };
  },
});

export type WearableCheckSetupService = ReturnType<typeof createWearableCheckSetup>;
