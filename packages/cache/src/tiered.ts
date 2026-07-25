/** Two-tier cache composition.
 *
 *  Wraps an L1 (fast, ephemeral — typically in-memory) and an L2 (slow,
 *  persistent — typically IndexedDB) as a single `CacheStore`. The
 *  resulting store is a drop-in for `withIngredientCache` — callers
 *  don't need to know whether they're talking to one store or two.
 *
 *  Read path:
 *    get(key)
 *      → L1 hit? return
 *      → L2 hit? hydrate L1, return
 *      → miss, return null
 *
 *  Write path:
 *    set(entry) → await l1.set, await l2.set
 *      (L2 first would leave L1 cold on early returns; L1 first gives
 *       us an instant cache even if L2 write is slow.)
 *
 *  Invalidation:
 *    delete / deleteByRecipe / clear → applied to BOTH stores in parallel
 *
 *  Budget:
 *    size() and evictLRU() operate on L2, the source of truth for
 *    persistent storage. L1 carries no explicit budget — its lifetime
 *    is bounded by the host's memory pressure (in a Chrome MV3 service
 *    worker, ~30s of inactivity wipes it for free).
 *
 *  Staleness note: after evictLRU drops an entry from L2, L1 may still
 *  serve that entry on subsequent reads within the same process. This
 *  is benign for two reasons:
 *    1. The cache wrapper (`withIngredientCache` and friends) still
 *       checks `expires_at` at read time — expired entries never escape.
 *    2. L1 has a natural sw-lifecycle TTL; a stale entry survives at
 *       most until the next sw restart.
 *  Not worth adding an L1 purge-on-evict channel for a sub-30s window.
 */

import type { CacheStore } from './types.js';

/** Compose two CacheStores as L1 + L2. Typical usage:
 *
 *    const l1 = createInMemoryStore();           // fast, ephemeral
 *    const l2 = createIDBStore();                // persistent
 *    const store = tieredStore(l1, l2);
 *    // Pass `store` to withIngredientCache as the single `store` option.
 *
 *  The order (l1, l2) is load-bearing: L1 is checked first on reads and
 *  holds the hot path; L2 is authoritative for persistence.
 */
export const tieredStore = (l1: CacheStore, l2: CacheStore): CacheStore => ({
  async get(key) {
    const fromL1 = await l1.get(key);
    if (fromL1) return fromL1;
    const fromL2 = await l2.get(key);
    if (fromL2) {
      // Hydrate L1 so subsequent reads hit the fast path. We don't
      // mutate last_accessed_at here — the cache wrapper above owns
      // LRU bumping, not the storage layer.
      await l1.set(fromL2);
    }
    return fromL2;
  },

  async set(entry) {
    // L1 first so a slow L2 doesn't delay the in-memory hit path.
    // Both writes are awaited so consumers have a defined post-state.
    await l1.set(entry);
    await l2.set(entry);
  },

  async delete(key) {
    await Promise.all([l1.delete(key), l2.delete(key)]);
  },

  async deleteByRecipe(recipe_id) {
    await Promise.all([
      l1.deleteByRecipe(recipe_id),
      l2.deleteByRecipe(recipe_id),
    ]);
  },

  async deleteByPrefix(prefix) {
    // Both tiers drop their matching rows in parallel. Return the L2
    // count since it's the source of truth; L1 is a subset. Tiers that
    // don't support the operation are skipped (counts as 0) rather
    // than throwing — matches the interface's optional contract.
    const [, l2Count] = await Promise.all([
      l1.deleteByPrefix ? l1.deleteByPrefix(prefix) : Promise.resolve(0),
      l2.deleteByPrefix ? l2.deleteByPrefix(prefix) : Promise.resolve(0),
    ]);
    return l2Count;
  },

  async size() {
    // L2 is the source of truth for the storage budget. L1 is a subset
    // whose contents may lag (on sw restart, L1 is empty; L2 still has
    // everything). Returning L2's size is the correct number for
    // budget decisions.
    return l2.size();
  },

  async evictLRU(target_bytes) {
    // Evict from L2. L1 is not explicitly pruned — see the staleness
    // note in the file header. Stale L1 entries are bounded by the
    // sw lifecycle and the cache wrapper's expiry check.
    await l2.evictLRU(target_bytes);
  },

  async clear() {
    await Promise.all([l1.clear(), l2.clear()]);
  },

  async touch(key, at) {
    // Touch both tiers when available. L1 stays warm-friendly, L2
    // gets its LRU bump without spilling a full write through the
    // peer wrapper.
    await Promise.all([
      l1.touch ? l1.touch(key, at) : Promise.resolve(),
      l2.touch ? l2.touch(key, at) : Promise.resolve(),
    ]);
  },
});
