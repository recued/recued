import { MIN_TTL } from '@recued/contracts';
import type { WithCacheOptions } from './types.js';
import { computeCacheKey, estimateSize } from './key.js';

type IngredientExecutor = (slug: string, input: Record<string, unknown>) => Promise<unknown>;

/** Wrap an IngredientExecutor with caching. Returns a new executor with the same shape.
 *
 *  Cache TTL = max(recipe_ttl, MIN_TTL[category]). Cache is bypassed when TTL = 0.
 *  Cache key = SHA-256(slug + sorted JSON of input).
 *  On set: optionally evicts LRU entries to stay under max_bytes.
 */
export const withCache = (
  executor: IngredientExecutor,
  options: WithCacheOptions,
): IngredientExecutor => async (slug, input) => {
  const ttl = Math.max(options.recipe_ttl, MIN_TTL[options.category]);

  // TTL=0 means caller explicitly disabled caching for this category
  if (ttl <= 0) return executor(slug, input);

  const key = await computeCacheKey(slug, input);
  const cached = await options.store.get(key);

  if (cached && cached.expires_at > Date.now()) {
    // Cache hit — bump LRU timestamp
    await options.store.set({ ...cached, last_accessed_at: Date.now() });
    return cached.value;
  }

  // Cache miss or expired — call upstream
  const value = await executor(slug, input);

  const now = Date.now();
  await options.store.set({
    key,
    value,
    expires_at: now + ttl * 1000,
    recipe_id: options.recipe_id,
    ingredient_slug: slug,
    size_bytes: estimateSize(value),
    created_at: now,
    last_accessed_at: now,
  });

  // Evict LRU if over budget
  if (options.max_bytes) await options.store.evictLRU(options.max_bytes);

  return value;
};
