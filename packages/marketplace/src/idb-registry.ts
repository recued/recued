/** IndexedDB-backed InstallRegistry.
 *
 *  Built on top of the storage package's generic `createIDBCollection`.
 *  Composite keys — `${publisher_id}::${recipe_id}` — keep distinct
 *  publishers' installs of the same recipe_id separate. The collection
 *  handles persistence; this wrapper just maps the InstallRegistry
 *  interface onto collection ops.
 *
 *  Use this in production. Use `createInMemoryInstallRegistry` for
 *  tests and dev. Both implement the same interface so swapping is a
 *  one-line config change in the runtime bootstrap.
 */

import {
  createIDBCollection,
  type IDBCollection,
  type IDBCollectionOptions,
} from '@recued/storage';
import type { InstalledRecipe, InstallRegistry } from './types.js';

const key = (publisher_id: string, recipe_id: string): string =>
  `${publisher_id}::${recipe_id}`;

export interface IDBInstallRegistry extends InstallRegistry {
  /** Release the IDB connection. Optional; rarely needed in a service
   *  worker where the handle lives for the process lifetime. */
  close(): Promise<void>;
}

export const createIDBInstallRegistry = (
  options: IDBCollectionOptions = { dbName: 'recued-installs' },
): IDBInstallRegistry => {
  const collection: IDBCollection<InstalledRecipe> = createIDBCollection<InstalledRecipe>(options);

  return {
    async listInstalled() {
      return collection.list();
    },

    async getInstalled(recipe_id, publisher_id) {
      return collection.get(key(publisher_id, recipe_id));
    },

    async markInstalled(record) {
      await collection.set(key(record.publisher_id, record.recipe_id), record);
    },

    async markUninstalled(recipe_id, publisher_id) {
      await collection.delete(key(publisher_id, recipe_id));
    },

    async recordUpstreamCheck(recipe_id, publisher_id, upstream, checked_at) {
      const k = key(publisher_id, recipe_id);
      const existing = await collection.get(k);
      if (!existing) return; // no-op for unknown installs
      await collection.set(k, {
        ...existing,
        last_checked_at: checked_at,
        upstream_version: upstream.version,
        upstream_hash: upstream.hash,
      });
    },

    async size() {
      return collection.size();
    },

    async close() {
      await collection.close();
    },
  };
};
