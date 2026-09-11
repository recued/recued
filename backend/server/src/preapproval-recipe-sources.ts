/** Saved recipe/config inputs for the shared pure inventory walker. Reads the
 * same rows and config precedence as handleExecute, with durable dependency
 * pins. No executor, provider request or attachment byte read occurs here. */
import type Database from 'better-sqlite3';
import { RpcError } from '@recued/contracts';
import type { RecipeStore } from './recipe-store.js';
import { dishPreapprovalMaterial, type DishStore } from './dish-store.js';
import type { DishGroupStore } from './dish-group-store.js';
import type { ScheduleStore } from './schedule-store.js';
import type { AutoRunSettingsStore } from './auto-run-scheduler.js';
import type { EventTriggersStore } from './triggers/store.js';
import type { PreapprovalDependency, PreapprovalTargetBinding } from './preapproval-model.js';
import type { PreapprovalRecipeSource } from './preapproval-prepare.js';
import { preapprovalHash } from './preapproval-invocations.js';
import { synchronizePreapprovalIdentity } from './storage/preapproval-lifecycle.js';

export interface PreapprovalRecipeSourceDeps {
  db: Database.Database; recipes: RecipeStore; dishes: DishStore; groups: DishGroupStore;
  schedules: ScheduleStore; autoRun: AutoRunSettingsStore; triggers: EventTriggersStore;
}

export const createPreapprovalRecipeSources = (deps: PreapprovalRecipeSourceDeps, root: {
  recipe_id: string; publisher_id: string; target: PreapprovalTargetBinding;
}) => {
  const pin = (kind: string, key: string, value: unknown): PreapprovalDependency => {
    const identity = synchronizePreapprovalIdentity(deps.db, kind, key, value);
    if (!identity) throw new RpcError('preapproval_stale', 'A saved recipe dependency disappeared.', 409);
    const { incarnation, revision, content_hash } = identity;
    return { kind, key, incarnation, revision, content_hash, until_phase: 'terminal' };
  };
  return (recipeId: string, publisherId: string): PreapprovalRecipeSource | null => deps.db.transaction(() => {
    const stored = deps.recipes.getStored(recipeId);
    const recipe = deps.recipes.get(recipeId);
    if (!stored || !recipe || stored.publisher_id !== publisherId) return null;
    // A process-local overlay is not a persisted deferred program. It cannot
    // later disappear on restart and silently reveal a different recipe.
    if (preapprovalHash(JSON.parse(stored.recipe_json)) !== preapprovalHash(recipe)) return null;
    const dependencies = [pin('recipe', recipeId, { publisher_id: publisherId, definition: recipe })];
    const source: PreapprovalRecipeSource = { definition: structuredClone(recipe), publisher_id: publisherId, dependencies };
    const target = root.target;
    const boundId = recipeId !== root.recipe_id || publisherId !== root.publisher_id ? null
      : target.kind === 'next_schedule' ? deps.schedules.get(target.key)?.dish_id
      : target.kind === 'next_auto_run' ? deps.autoRun.getDishId(target.key)
      : target.kind === 'next_trigger' ? deps.triggers.get(target.key)?.dish_id : null;
    if (boundId) {
      const dish = deps.dishes.get(boundId);
      if (!dish || !dish.enabled || dish.recipe_id !== recipeId || dish.publisher_id !== publisherId) return null;
      dependencies.push(pin('dish', boundId, dishPreapprovalMaterial(dish)));
      const group = dish.group_id ? deps.groups.get(dish.group_id) : null;
      if (dish.group_id && !group) return null;
      if (group) dependencies.push(pin('dish_group', group.group_id, { config_overlay: group.config_overlay }));
      source.bound_dish = { config_overlay: structuredClone(dish.config_overlay),
        ...(group ? { group_overlay: structuredClone(group.config_overlay) } : {}) };
    } else {
      const install = deps.dishes.getDefault(recipeId);
      if (install && install.publisher_id !== publisherId) return null;
      // The absent default is a selector too: creating one after review must
      // not change this execution's material without invalidating the review.
      dependencies.push(pin('recipe_default_dish', recipeId, { dish_id: install?.dish_id ?? null }));
      if (install) {
        dependencies.push(pin('dish', install.dish_id, dishPreapprovalMaterial(install)));
        source.install_config = structuredClone(install.config_overlay);
      }
    }
    return source;
  }).immediate();
};
