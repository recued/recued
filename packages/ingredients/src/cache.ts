/** Manifest-aware cache wrapper for ingredient executors.
 *
 *  Uses the canonical cache-key scheme (v1:{slug}@{version}:{hash} — D-103
 *  dropped the leading instance_id so ext + server computing the same
 *  semantic result land on the same key) and the policy module from
 *  @recued/cache. Cache decisions are derived from the ingredient
 *  manifest's category + risk_tier rather than guessed from slug.
 *
 *  Policy (derivePolicy, @recued/cache):
 *    - Action category: NEVER cache (side effects).
 *    - Non-read risk tiers (write/admin/destructive): NEVER cache.
 *    - Read + data/ai: cache with max(recipe_ttl, MIN_TTL[category]) floor.
 *
 *  Step-level freshness (stepOptions.cache):
 *    - `fresh`: bypass cache. Always re-fetch. Neither reads nor writes.
 *    - `acceptable` (default): use cache if within TTL. Standard behavior.
 *    - `any`: serve stale entries regardless of TTL. Enables progressive
 *      render — the UI paints cached-fast, then a separate pass refreshes.
 *
 *  If the manifest can't be loaded, the upstream executor runs uncached —
 *  its own error path gives a clearer diagnosis than returning a stale entry.
 */

import { cacheKey, estimateSize, derivePolicy, type CacheStore } from '@recued/cache';
import type { IngredientExecutor, ManifestLoader } from './types.js';

export type CacheStatus = 'hit' | 'hit_stale' | 'miss' | 'skipped';

export interface CacheStatusContext {
  slug: string;
  /** Cache key when computed; absent for skipped/disabled. */
  key?: string;
  /** Age of the served entry in ms. Present on hit + hit_stale. */
  age_ms?: number;
  /** True when the entry was served past its TTL (freshness='any'). */
  stale?: boolean;
}

export interface IngredientCacheOptions {
  /** Manifest lookup — the wrapper needs the category + risk_tier and can't
   *  guess them from slug alone. Failures fall through to the raw executor. */
  manifestLoader: ManifestLoader;
  /** Pluggable store. Use createInMemoryStore() for tests. */
  store: CacheStore;
  /** The current recipe's ttl in seconds. The policy applies the MIN_TTL
   *  floor for the manifest's category on top. */
  recipe_ttl: number;
  /** Current recipe id — used to tag entries for per-recipe eviction on
   *  uninstall. */
  recipe_id: string;
  /** Optional storage budget. When set, evictLRU runs after each write. */
  max_bytes?: number;
  /** Clock function — tests override to control expiry. Defaults to Date.now. */
  now?: () => number;
  /** Resolve value references in input before computing the cache key.
   *  When provided, `{{context.url}}` etc. are resolved so different
   *  runtime contexts produce different cache keys. */
  resolveRefs?: (obj: Record<string, unknown>) => Record<string, unknown>;
  /** Observability callback for audit/telemetry. Fired on every call with
   *  the cache decision and, on hits, the age of the served entry. */
  onStatus?: (status: CacheStatus, context: CacheStatusContext) => void;
}

export const withIngredientCache = (
  rawExecutor: IngredientExecutor,
  options: IngredientCacheOptions,
): IngredientExecutor => {
  const now = options.now ?? (() => Date.now());
  const emit = (status: CacheStatus, ctx: CacheStatusContext) =>
    options.onStatus?.(status, ctx);

  return async (slug, input, stepOutput, stepOptions, stepMeta) => {
    // D-201 — this read is authorized by engine-only recipe/run metadata and
    // a live payload pin, neither of which is part of the authored input (or
    // the canonical cache key). Caching by `event_ref` would therefore let a
    // later run — including a different recipe — receive decoded payload
    // bytes without re-entering the consumer-binding gate. Keep the payload
    // out of L1/peer caches entirely; the engine separately disables L2 for
    // the owner-default-only backing op.
    if (slug === 'webhook-event-get') {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }
    // D-201 Slice 6B3 — operation-bound surface dispatches contain a callback
    // injected after recipe admission. A catalog wrapper is top-level read/data
    // even when its selected op mutates, so category-derived L1 policy alone
    // would cache the raw provider request/result. The engine-only sensitive
    // marker makes these calls unconditional pass-throughs.
    if (stepMeta?.surface_dispatch === true
      && stepMeta.surface_dispatch_sensitive === true) {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }
    // ⛔ A WRITE IS NEVER SERVED FROM THE CACHE. A catalog wrapper is read/data at
    // the top whatever operation it runs, so the policy below would cache a
    // write too — and the commit gateway, outside this cache, records a hit as
    // done: two identical writes within the TTL reached the provider ONCE. The
    // dispatch carries the operation's own tier; anything but `read` passes.
    if (stepMeta?.surface_dispatch === true
      && stepMeta.surface_risk_tier !== undefined
      && stepMeta.surface_risk_tier !== 'read') {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }

    const freshness = stepOptions?.cache ?? 'acceptable';

    // 'fresh' bypasses cache entirely — no read, no write.
    if (freshness === 'fresh') {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }

    let manifest;
    try {
      manifest = await options.manifestLoader(slug);
    } catch {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }
    if (!manifest) {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }

    const policy = derivePolicy(manifest.category, manifest.risk_tier, options.recipe_ttl);
    if (!policy.enabled) {
      emit('skipped', { slug });
      return rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);
    }

    // Merge manifest defaults + step input for the cache key — must match
    // what the dispatch layer sends to the adapter, otherwise different
    // manifest defaults produce the same key from identical step inputs.
    const mergedForKey = { ...(manifest.input ?? {}), ...input };
    const resolvedForKey = options.resolveRefs
      ? options.resolveRefs(mergedForKey)
      : mergedForKey;

    const manifest_version = String(manifest.version ?? 0);
    const key = await cacheKey({
      ingredient_slug: slug,
      manifest_version,
      inputs: resolvedForKey,
    });

    const cached = await options.store.get(key);
    const currentTime = now();

    if (cached) {
      const age_ms = currentTime - cached.created_at;
      const fresh = cached.expires_at > currentTime;

      // Fresh hit on any freshness mode except 'fresh' (handled above).
      if (fresh) {
        await options.store.set({ ...cached, last_accessed_at: currentTime });
        emit('hit', { slug, key, age_ms, stale: false });
        return cached.value;
      }

      // Expired entry — serve only under 'any' freshness.
      if (freshness === 'any') {
        await options.store.set({ ...cached, last_accessed_at: currentTime });
        emit('hit_stale', { slug, key, age_ms, stale: true });
        return cached.value;
      }

      // 'acceptable' + expired → fall through to miss path.
    }

    emit('miss', { slug, key });
    const value = await rawExecutor(slug, input, stepOutput, stepOptions, stepMeta);

    await options.store.set({
      key,
      value,
      expires_at: currentTime + policy.ttl_seconds * 1000,
      recipe_id: options.recipe_id,
      ingredient_slug: slug,
      size_bytes: estimateSize(value),
      created_at: currentTime,
      last_accessed_at: currentTime,
      category: manifest.category,
      risk_tier: manifest.risk_tier,
    });

    if (options.max_bytes !== undefined) {
      await options.store.evictLRU(options.max_bytes);
    }

    return value;
  };
};
