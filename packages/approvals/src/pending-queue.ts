import type { Collection } from '@recued/storage';
import type { PendingAction } from '@recued/contracts';
import type { PendingQueue } from './types.js';

/** Create a PendingQueue backed by a Collection<PendingAction>. */
export const createPendingQueue = (collection: Collection<PendingAction>): PendingQueue => ({
  async add(action) {
    await collection.set(action.pending_id, action);
  },

  async list() {
    return collection.list();
  },

  async remove(pending_id) {
    await collection.delete(pending_id);
  },

  async removeByRecipe(recipe_id) {
    let count = 0;
    const all = await collection.list();
    for (const action of all) {
      if (action.recipe_id === recipe_id) {
        await collection.delete(action.pending_id);
        count++;
      }
    }
    return count;
  },
});
