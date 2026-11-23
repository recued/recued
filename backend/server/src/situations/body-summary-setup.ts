/** D-339 slice 19 (D-339 §3.6, §6; 2026-11-19, the owner: "do the automatic summary setup") — a
 *  Body's summary, set up by itself.
 *
 *  Until now the owner set it up by hand (the guide's section 2: enrol the summary as the Body's writer, copy the
 *  binding id, switch the summary on, paste that id and the Body's id into its settings). A Body just added had
 *  none, so nothing reached it from Records: a weight typed in Ask with the numbers stayed there, and the form
 *  asked for it again. Now:
 *  - **Adding a Body** enrols `summarize-body-signals` as its writer, for every reading and condition the Body
 *    has, at the installed version, and switches on a dish of it set to the Body and that binding.
 *  - **"Set up the summary"** on a Body's page does the same for a Body added before, and for one whose summary
 *    was enrolled for an older version of the recipe (its binding names that version, so the new one may not
 *    write) — the owner's own act, as enrolling it by hand was.
 *  It changes nothing twice: the binding's id is the Body's, the recipe's and its version's (`binding.save`); the
 *  dish is the one set to this Body, else one of the recipe's set to no Body, else a new one named after the Body.
 *  With the summary not installed it does nothing. */
import { BODY_CLASS_ID, BODY_SUMMARY_RECIPE_ID as BODY_SUMMARY_RECIPE, type Asset } from '@recued/contracts';
import type { RecipeStore } from '../recipe-store.js';
import { createDish, updateDish, type DishHandlerDeps } from '../dish-handler.js';

export interface BodySummarySetup {
  binding_id: string;
  dish_id: string;
  /** What happened to the dish: made, set to this Body and binding, or already so. */
  dish: 'created' | 'set' | 'kept';
}

export interface BodySummarySetupDeps {
  recipes: Pick<RecipeStore, 'getStored'>;
  dishes: DishHandlerDeps;
  /** The Yours service's own enrolment, as `binding.save` does it: the installed version, these fields. */
  enrol(asset_id: string, recipe_id: string, fields: readonly string[]): { id: string };
}

/** Every reading and condition the Body has: the summary's write is refused whole for a field its binding lacks. */
export const bodySummaryFields = (asset: Pick<Asset, 'readings' | 'observations'>): string[] => [
  ...Object.keys(asset.readings).map(name => `readings.${name}`),
  ...Object.keys(asset.observations).map(name => `observations.${name}`),
];

export const createBodySummarySetup = (deps: BodySummarySetupDeps) => ({
  /** Undefined for anything but a Body, and when the summary is not installed. */
  ensure(asset: Asset): BodySummarySetup | undefined {
    if (asset.class_id !== BODY_CLASS_ID || !deps.recipes.getStored(BODY_SUMMARY_RECIPE)) return undefined;
    const binding_id = deps.enrol(asset.id, BODY_SUMMARY_RECIPE, bodySummaryFields(asset)).id;
    const dishes = deps.dishes.store.listByRecipe(BODY_SUMMARY_RECIPE);
    const bodyOf = (dish: { config_overlay: Record<string, unknown> }) => dish.config_overlay?.asset_id;
    const dish = dishes.find(row => bodyOf(row) === asset.id) ?? dishes.find(row => bodyOf(row) === undefined || bodyOf(row) === null || bodyOf(row) === '');
    if (!dish) {
      const created = createDish(deps.dishes, { recipe_id: BODY_SUMMARY_RECIPE, name: asset.name,
        config_overlay: { asset_id: asset.id, binding_id }, enabled: true }).dish;
      return { binding_id, dish_id: created.dish_id, dish: 'created' };
    }
    if (bodyOf(dish) === asset.id && dish.config_overlay.binding_id === binding_id && dish.enabled) return { binding_id, dish_id: dish.dish_id, dish: 'kept' };
    updateDish(deps.dishes, dish.dish_id, { config_overlay: { ...dish.config_overlay, asset_id: asset.id, binding_id }, enabled: true,
      ...(bodyOf(dish) === asset.id || dish.name ? {} : { name: asset.name }) });
    return { binding_id, dish_id: dish.dish_id, dish: 'set' };
  },
});

export type BodySummarySetupService = ReturnType<typeof createBodySummarySetup>;
