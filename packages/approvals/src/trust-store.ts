import type { Collection } from '@recued/storage';
import {
  isPureWorkflowRecipe,
  recipeTrustStateForPureWorkflow,
  type RecipeDefinition,
  type RecipeTrustState,
} from '@recued/contracts';
import type { TrustStateStore } from './types.js';

export { isPureWorkflowRecipe, recipeTrustStateForPureWorkflow };

export const setPureWorkflowRecipeAutoTrust = async (
  store: Pick<TrustStateStore, 'set'>,
  recipe: RecipeDefinition,
  now?: () => string,
): Promise<RecipeTrustState | null> => {
  if (!isPureWorkflowRecipe(recipe)) return null;
  const state = recipeTrustStateForPureWorkflow(recipe, now);
  await store.set(state);
  return state;
};

/** Create a TrustStateStore backed by a Collection<RecipeTrustState>. */
export const createTrustStateStore = (collection: Collection<RecipeTrustState>): TrustStateStore => ({
  async get(recipe_id) {
    return collection.get(recipe_id);
  },

  async set(state) {
    await collection.set(state.recipe_id, state);
  },

  async delete(recipe_id) {
    await collection.delete(recipe_id);
  },

  async increment(recipe_id, recipe_version, tier) {
    const existing = await collection.get(recipe_id);
    const next: RecipeTrustState = existing && existing.recipe_version === recipe_version
      ? {
          ...existing,
          approval_counts: {
            ...existing.approval_counts,
            [tier]: existing.approval_counts[tier] + 1,
          },
        }
      : {
          recipe_id,
          recipe_version,
          approval_counts: { write: 0, admin: 0, [tier]: 1 } as RecipeTrustState['approval_counts'],
          trust_levels: { write: 'prompt', admin: 'prompt' },
        };
    await collection.set(recipe_id, next);
    return next;
  },

  async setAuto(recipe_id, recipe_version, tier) {
    const existing = await collection.get(recipe_id);
    const base: RecipeTrustState = existing && existing.recipe_version === recipe_version
      ? existing
      : {
          recipe_id,
          recipe_version,
          approval_counts: { write: 0, admin: 0 },
          trust_levels: { write: 'prompt', admin: 'prompt' },
        };
    const next: RecipeTrustState = {
      ...base,
      trust_levels: { ...base.trust_levels, [tier]: 'auto' },
      unlocked_at: { ...(base.unlocked_at ?? {}), [tier]: new Date().toISOString() },
    };
    await collection.set(recipe_id, next);
    return next;
  },
});
