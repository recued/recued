/** In-memory InstallRegistry implementation.
 *
 *  Used by tests and any consumer that doesn't need persistence (e.g.,
 *  a preview mode in Kitchen). The extension's service worker plugs a
 *  real IndexedDB-backed implementation into the same interface.
 *
 *  Registry entries are keyed by `${publisher_id}::${recipe_id}` —
 *  distinct publishers can publish recipes with the same recipe_id
 *  (forks), and the registry treats them as independent entries.
 */

import type { InstalledRecipe, InstallRegistry } from './types.js';

const compositeKey = (recipe_id: string, publisher_id: string): string =>
  `${publisher_id}::${recipe_id}`;

/** Build a fresh in-memory InstallRegistry. Each call returns an
 *  independent instance — useful for test isolation. */
export const createInMemoryInstallRegistry = (): InstallRegistry => {
  const entries = new Map<string, InstalledRecipe>();

  return {
    async listInstalled() {
      return [...entries.values()];
    },

    async getInstalled(recipe_id, publisher_id) {
      return entries.get(compositeKey(recipe_id, publisher_id)) ?? null;
    },

    async markInstalled(record) {
      entries.set(compositeKey(record.recipe_id, record.publisher_id), record);
    },

    async markUninstalled(recipe_id, publisher_id) {
      entries.delete(compositeKey(recipe_id, publisher_id));
    },

    async recordUpstreamCheck(recipe_id, publisher_id, upstream, checked_at) {
      const key = compositeKey(recipe_id, publisher_id);
      const existing = entries.get(key);
      if (!existing) return; // no-op for unknown installs
      entries.set(key, {
        ...existing,
        last_checked_at: checked_at,
        upstream_version: upstream.version,
        upstream_hash: upstream.hash,
      });
    },

    async size() {
      return entries.size;
    },
  };
};
