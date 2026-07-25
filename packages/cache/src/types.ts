/** Cache package types — runtime concerns (store contract, eviction,
 *  executor wrapping) only. The wire shape `CacheEntry` itself lives
 *  in `@recued/contracts` so the rpc layer can reference it without
 *  pulling in this package, and is re-exported here for historical
 *  import paths (`@recued/cache` consumers never had to know the
 *  shape moved).
 */

import type { IngredientCategory, CacheEntry } from '@recued/contracts';

export type { CacheEntry } from '@recued/contracts';

/** Storage backend for cache entries. Implementations: in-memory, IndexedDB, etc. */
export interface CacheStore {
  get(key: string): Promise<CacheEntry | null>;
  set(entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  /** Remove all entries for a given recipe (used on uninstall). */
  deleteByRecipe(recipe_id: string): Promise<void>;
  /** Remove all entries whose key starts with the given prefix.
   *  Surfaces the local prefix-delete primitive for internal callers
   *  (uninstall flows, admin tooling). D-103 removed the cross-peer
   *  cache.invalidate rpc, so this is a local-only op.
   *
   *  Optional for backward compat with external stores; stores that
   *  omit it behave as no-op when called (correct but lets stale rows
   *  linger until TTL). All in-tree stores — in-memory, IDB, tiered,
   *  peer-wrapper, SQLite — implement it natively. */
  deleteByPrefix?(prefix: string): Promise<number>;
  /** Total size of all entries in bytes. */
  size(): Promise<number>;
  /** Evict least-recently-used entries until total size is under target. */
  evictLRU(target_bytes: number): Promise<void>;
  /** Clear everything. */
  clear(): Promise<void>;
  /** Bump `last_accessed_at` (and optionally `expires_at`) without
   *  re-serializing the value or triggering peer broadcast. Used on
   *  cache hits to maintain LRU order + sliding TTL without shipping
   *  the entry across the sync channel every time a popular key is
   *  read.
   *
   *  Optional on the interface — stores that don't implement it fall
   *  back to a full `set()` round-trip (correct, just noisier on the
   *  wire). Both in-memory, IDB, and peer-wrapper stores in this
   *  package implement it natively. */
  touch?(
    key: string,
    at: { last_accessed_at: number; expires_at?: number },
  ): Promise<void>;
}

/** Options for wrapping an ingredient executor with caching. */
export interface WithCacheOptions {
  store: CacheStore;
  category: IngredientCategory;
  recipe_ttl: number;           // recipe.ttl in seconds
  recipe_id: string;
  /** Optional storage budget. When set, evictLRU is called after each set. */
  max_bytes?: number;
}
