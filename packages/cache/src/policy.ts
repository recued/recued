/** Category + risk-tier aware cache policy derivation.
 *
 *  Pure functions — no I/O, no state. Takes manifest + recipe fields,
 *  returns a decision struct the cache wrapper applies.
 *
 *  Rules (per project_cache_architecture.md):
 *    - Action category: NEVER cache. Writes have side effects; a cache
 *      hit would skip the side effect.
 *    - Non-read risk tiers (write/admin/destructive): NEVER cache. Even
 *      if the ingredient is categorized 'data', a destructive read is
 *      not a thing we should memoize.
 *    - A page in the browser (`kind: 'dom'`): NEVER cache, read or not
 *      (D-335). The page changes without the read's input changing: after a
 *      click the same page handle has other HTML, and an inspection's refs
 *      are the ones its own read handed out, so a replay shows the page as it
 *      was.
 *    - Read + data/ai: cache with max(recipe_ttl, MIN_TTL[category]) floor.
 *    - Stream on write: broadcast expensive outputs to the paired peer.
 *      Currently applies to data and ai; transforms are not broadcast.
 *    - Peer query on miss: only for AI (slow enough that 50ms peer
 *      round-trip is noise); data calls are often fast enough that the
 *      round-trip isn't worth it.
 *    - Max broadcast size: payloads above this go peer-query-only, not
 *      broadcast, to avoid WS storms.
 */

import type { IngredientCategory, IngredientKind, RiskTier } from '@recued/contracts';
import { MIN_TTL } from '@recued/contracts';

export interface CachePolicy {
  /** If false, bypass cache entirely. Neither read nor write. */
  enabled: boolean;
  /** Seconds until a cached entry expires. 0 when disabled. */
  ttl_seconds: number;
  /** Broadcast new entries to paired peer via cache.put on write. */
  stream_on_write: boolean;
  /** Peer-query via cache.get on local miss before computing. */
  peer_query_on_miss: boolean;
  /** Payloads above this size skip broadcast (peer fetches on demand). */
  max_broadcast_bytes: number;
}

const DISABLED: CachePolicy = {
  enabled: false,
  ttl_seconds: 0,
  stream_on_write: false,
  peer_query_on_miss: false,
  max_broadcast_bytes: 0,
};

const MAX_BROADCAST_BYTES = 64 * 1024;

export const derivePolicy = (
  category: IngredientCategory,
  risk_tier: RiskTier,
  recipe_ttl: number,
  /** The manifest's `kind`. Optional so a caller that has none decides as before. */
  kind?: IngredientKind,
): CachePolicy => {
  if (kind === 'dom') return DISABLED;
  if (category === 'action') return DISABLED;
  if (risk_tier !== 'read') return DISABLED;

  const ttl = Math.max(recipe_ttl, MIN_TTL[category]);
  if (ttl <= 0) return DISABLED;

  return {
    enabled: true,
    ttl_seconds: ttl,
    stream_on_write: true,
    peer_query_on_miss: category === 'ai',
    max_broadcast_bytes: MAX_BROADCAST_BYTES,
  };
};
