/** Cache wire type — the canonical `CacheEntry` shape shared across
 *  every transport that carries cached ingredient results.
 *
 *  Lives in contracts rather than `@recued/cache` because the rpc
 *  layer (`packages/contracts/src/rpc/`) needs to reference it
 *  directly, and contracts cannot depend on cache. `@recued/cache`
 *  imports from here and re-exports for convenience — consumers that
 *  already depend on cache see no API change.
 *
 *  Storage + executor concerns (`CacheStore`, `WithCacheOptions`,
 *  eviction, peer broadcast policy) stay inside `@recued/cache` since
 *  they're runtime implementation details. This file is intentionally
 *  types-only.
 */

import type { IngredientCategory, RiskTier } from './ingredient.js';

/** A single cached ingredient response. */
export interface CacheEntry {
  /** Canonical cache key (see packages/cache/src/canonical/cache-key.ts). */
  key: string;
  /** The cached response. Wire shape is deliberately `unknown` — the
   *  structural contract is the canonical key, not the payload. */
  value: unknown;
  /** Epoch ms when the entry becomes stale. */
  expires_at: number;
  recipe_id: string;
  ingredient_slug: string;
  size_bytes: number;
  created_at: number;
  last_accessed_at: number;
  /** Category at the time of write. Drives broadcast-policy eligibility.
   *  Most entries inherit their ingredient manifest's `IngredientCategory`
   *  (`data` / `ai` / `action`). L2 step-cache entries for pure
   *  transform / guard outputs use the synthetic `'step'` tag — also
   *  broadcast-eligible under DEFAULT_BROADCAST_POLICY. Optional for
   *  backward compat with entries written before this field existed. */
  category?: IngredientCategory | 'step';
  /** Risk tier at the time of write. Also used for broadcast policy;
   *  non-read tiers should never be cached in the first place, but
   *  carrying it prevents accidental peer exposure. */
  risk_tier?: RiskTier;
}
