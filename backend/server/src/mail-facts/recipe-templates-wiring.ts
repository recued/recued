/**
 * D-315 §5.2 — the templates recipes bring, wired as the server wires them
 * (`compose-listeners`), in one place so the live proof runs this wiring and
 * not a copy of it:
 *   - a template setting is a dish's (D-319): each dish of a recipe holds its
 *     own, and a new dish starts from the template the install chose
 *     (`dishes.defaults`);
 *   - uninstalling a recipe — by any path: a pack removed, `recipe.delete` —
 *     removes its templates, through the recipe store's deletion hook;
 *   - a dish picking another template re-points its `template_variable`
 *     triggers — the dish rpc's own reconcile (`dish-automation.ts`).
 */

import type { DishHandlerDeps } from '../dish-handler.js';
import type { EventBus } from '../events/bus.js';
import type { RecipeStore } from '../recipe-store.js';
import type { MailFactStore } from '../storage/mail-fact-store.js';
import { switchOffUserTriggers, type TriggersRpcDeps } from '../triggers/handler.js';
import { createRecipeMailTemplates, type RecipeMailTemplates } from './recipe-templates.js';

export interface RecipeMailTemplatesWiring {
  readonly store: MailFactStore;
  readonly recipeStore: Pick<RecipeStore, 'get' | 'listStored' | 'addOnDeleted'>;
  readonly dishDeps: DishHandlerDeps;
  /** The trigger substrate: re-make the recipes' rows (true when rows
   *  changed), and switch off the owner's rows narrowed to a removed
   *  template. Absent ⇒ no triggers follow. */
  readonly triggers?: {
    readonly reconcile: () => boolean;
    readonly triggersDeps: TriggersRpcDeps;
  };
  /** After a reconcile that changed rows — the watch recompute. */
  readonly afterTriggersChanged?: () => void;
  readonly eventBus?: Pick<EventBus, 'emit'>;
}

export const wireRecipeMailTemplates = (input: RecipeMailTemplatesWiring): RecipeMailTemplates => {
  const { dishDeps, triggers } = input;
  const reconcile = (): void => {
    if (triggers?.reconcile() === true) input.afterTriggersChanged?.();
  };
  const templates = createRecipeMailTemplates({
    store: input.store,
    recipes: input.recipeStore,
    settings: {
      dishesOf: (recipe_id) => dishDeps.store.listByRecipe(recipe_id),
      // Written straight to the store: the change is one of several a template
      // change makes, and `settled` re-makes the triggers once at the end.
      set: (dish_id, variable, value) => {
        const dish = dishDeps.store.get(dish_id);
        if (dish === null) return;
        const config_overlay = { ...dish.config_overlay };
        if (value === null) delete config_overlay[variable];
        else config_overlay[variable] = value;
        dishDeps.store.set({ ...dish, config_overlay });
        input.eventBus?.emit({ kind: 'automation_rule_changed', mechanism: 'dish' });
      },
    },
    reconcileTriggers: reconcile,
    ...(triggers !== undefined
      ? { switchOffTriggers: (match) => switchOffUserTriggers(triggers.triggersDeps, match) }
      : {}),
    ...(input.eventBus !== undefined
      ? { onTemplatesChanged: () => { input.eventBus!.emit({ kind: 'mail_fact', subkind: 'templates' }); } }
      : {}),
  });
  input.recipeStore.addOnDeleted?.((recipe_id) => {
    void templates.removeFor(recipe_id).catch((error: unknown) => {
      console.warn(`[d-315] removing the templates of recipe ${JSON.stringify(recipe_id)} failed`, error);
    });
  });
  // D-319 — the switch-on form starts from the template the install chose.
  dishDeps.defaultsFor = (recipe_id) => templates.defaultsFor(recipe_id);
  return templates;
};
