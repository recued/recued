import type { Collection } from './types.js';

/** In-memory Collection implementation. Reference impl for tests and dev.
 *  Production swaps in IndexedDB-backed Collection (Phase 2 work).
 */
export const createInMemoryCollection = <V>(): Collection<V> => {
  const map = new Map<string, V>();

  return {
    async get(key) {
      return map.has(key) ? (map.get(key) as V) : null;
    },

    async set(key, value) {
      map.set(key, value);
    },

    async delete(key) {
      map.delete(key);
    },

    async has(key) {
      return map.has(key);
    },

    async list() {
      return [...map.values()];
    },

    async listKeys() {
      return [...map.keys()];
    },

    async listByPrefix(prefix) {
      const results: Array<{ key: string; value: V }> = [];
      for (const [key, value] of map.entries()) {
        if (key.startsWith(prefix)) results.push({ key, value });
      }
      return results;
    },

    async deleteByPrefix(prefix) {
      let count = 0;
      for (const key of [...map.keys()]) {
        if (key.startsWith(prefix)) {
          map.delete(key);
          count++;
        }
      }
      return count;
    },

    async clear() {
      map.clear();
    },

    async size() {
      return map.size;
    },
  };
};
