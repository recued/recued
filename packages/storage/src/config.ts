import type { Collection, ConfigEntry } from './types.js';

/** A recipe-scoped config store for user variable overrides.
 *
 *  Per D-043: only stores DELTAS (user overrides). Recipe defaults are read
 *  from the recipe JSON at execution time, not duplicated here.
 *
 *  Storage layout: keys are `${recipe_id}::${key}` per D-036 convention.
 */
export interface ConfigStore {
  set(recipe_id: string, key: string, value: unknown): Promise<void>;
  get(recipe_id: string, key: string): Promise<unknown>;
  has(recipe_id: string, key: string): Promise<boolean>;
  delete(recipe_id: string, key: string): Promise<void>;
  /** All overrides for a single recipe. Used at execution start to merge with recipe defaults. */
  listByRecipe(recipe_id: string): Promise<Record<string, unknown>>;
  /** Delete all overrides for a recipe. Used on uninstall. */
  deleteByRecipe(recipe_id: string): Promise<number>;
}

const buildKey = (recipe_id: string, key: string): string => `${recipe_id}::${key}`;

export const createConfigStore = (collection: Collection<ConfigEntry>): ConfigStore => ({
  async set(recipe_id, key, value) {
    await collection.set(buildKey(recipe_id, key), {
      recipe_id,
      key,
      value,
      set_at: Date.now(),
    });
  },

  async get(recipe_id, key) {
    const entry = await collection.get(buildKey(recipe_id, key));
    return entry ? entry.value : undefined;
  },

  async has(recipe_id, key) {
    return collection.has(buildKey(recipe_id, key));
  },

  async delete(recipe_id, key) {
    await collection.delete(buildKey(recipe_id, key));
  },

  async listByRecipe(recipe_id) {
    const entries = await collection.listByPrefix(`${recipe_id}::`);
    const result: Record<string, unknown> = {};
    for (const { value } of entries) {
      Object.defineProperty(result, value.key, {
        value: value.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  },

  async deleteByRecipe(recipe_id) {
    return collection.deleteByPrefix(`${recipe_id}::`);
  },
});
