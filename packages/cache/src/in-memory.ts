import type { CacheEntry, CacheStore } from './types.js';

/** Phase B opt-in hook. When provided, the store reports every byte-
 *  count change (insert / overwrite / delete / LRU evict) as a signed
 *  delta so the server-side gate stays in sync with on-disk usage.
 *  Extension cache usage passes nothing — no behavioural change there. */
export interface InMemoryStoreOptions {
  onBytesChanged?: (delta: number) => void;
}

/** In-memory CacheStore — for tests, dev, and as a reference implementation. */
export const createInMemoryStore = (
  options: InMemoryStoreOptions = {},
): CacheStore => {
  const map = new Map<string, CacheEntry>();
  const onBytesChanged = options.onBytesChanged;

  const reportDelta = (delta: number): void => {
    if (!onBytesChanged || delta === 0) return;
    try { onBytesChanged(delta); } catch { /* consumer must not break writes */ }
  };

  return {
    async get(key) {
      return map.get(key) ?? null;
    },

    async set(entry) {
      const existing = map.get(entry.key);
      const prev = existing?.size_bytes ?? 0;
      map.set(entry.key, entry);
      reportDelta(entry.size_bytes - prev);
    },

    async delete(key) {
      const existing = map.get(key);
      if (!existing) return;
      map.delete(key);
      reportDelta(-existing.size_bytes);
    },

    async deleteByRecipe(recipe_id) {
      let freed = 0;
      for (const [key, entry] of map.entries()) {
        if (entry.recipe_id === recipe_id) {
          freed += entry.size_bytes;
          map.delete(key);
        }
      }
      reportDelta(-freed);
    },

    async deleteByPrefix(prefix) {
      let n = 0;
      let freed = 0;
      for (const [key, entry] of map.entries()) {
        if (key.startsWith(prefix)) {
          freed += entry.size_bytes;
          map.delete(key);
          n++;
        }
      }
      reportDelta(-freed);
      return n;
    },

    async size() {
      let total = 0;
      for (const entry of map.values()) total += entry.size_bytes;
      return total;
    },

    async evictLRU(target_bytes) {
      let total = 0;
      for (const entry of map.values()) total += entry.size_bytes;
      if (total <= target_bytes) return;

      // Sort by last_accessed_at ascending (oldest first)
      const sorted = [...map.values()].sort((a, b) => a.last_accessed_at - b.last_accessed_at);
      let freed = 0;
      for (const entry of sorted) {
        if (total <= target_bytes) break;
        map.delete(entry.key);
        total -= entry.size_bytes;
        freed += entry.size_bytes;
      }
      reportDelta(-freed);
    },

    async clear() {
      let freed = 0;
      for (const entry of map.values()) freed += entry.size_bytes;
      map.clear();
      reportDelta(-freed);
    },

    async touch(key, at) {
      const entry = map.get(key);
      if (!entry) return;
      entry.last_accessed_at = at.last_accessed_at;
      if (at.expires_at !== undefined) entry.expires_at = at.expires_at;
    },
  };
};
