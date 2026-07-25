/** Broadcast policy — decides which cache entries flow over the peer
 *  WS channel as `cache.put` events.
 *
 *  Rules:
 *    - Data, AI, and step-output categories broadcast. L2 step-cache
 *      entries broadcast too — the previous "transforms never broadcast"
 *      rule assumed each runtime executed independently, but with the
 *      warehouse model the server continuously pre-computes pipelines
 *      over inbound email/files/calendar and the extension should
 *      consume those results at lightning speed. A 1 KB transform
 *      output across the WS beats re-running a chain of ingredients
 *      that may include ai-extract downstream. See the engine's L2
 *      step cache for the content-addressable keys that make
 *      bidirectional sharing safe.
 *    - Entries above max_broadcast_bytes skip broadcast; peer pulls via
 *      cache.get on demand instead, to avoid WS storms on large payloads.
 *    - Entries from write/admin/destructive ingredients NEVER broadcast
 *      (they shouldn't be cached in the first place; belt-and-suspenders).
 *    - Entries without category info are treated as unclassified and
 *      skipped (safe default — legacy entries don't cross the wire).
 *    - L2 (`step`) entries additionally honour `prefs.cache.sync_l2`:
 *      when the extension has toggled it off (roaming / metered data),
 *      step entries skip the wire. `data` and `ai` still flow — the
 *      pref is deliberately narrow so recipe correctness survives.
 */

import type { CacheEntry } from './types.js';
import { getPref, type InstancePrefs } from '@recued/contracts';

export interface BroadcastPolicy {
  /** Eligible categories. Default: ['data', 'ai', 'step']. */
  categories: ReadonlySet<string>;
  /** Max serialized size. Above this → peer.cache.get on demand. Default 64KB. */
  maxBytes: number;
}

export const DEFAULT_BROADCAST_POLICY: BroadcastPolicy = {
  // `data` / `ai` = L1 ingredient cache entries.
  // `step` = L2 step-cache entries (chained transform outputs + wrapped
  //          ingredient chains). The warehouse pattern — server
  //          pre-computes pipelines on inbound data, extension
  //          consumes — makes `step` entries highly worth syncing.
  categories: new Set(['data', 'ai', 'step']),
  maxBytes: 64 * 1024,
};

export const isBroadcastEligible = (
  entry: CacheEntry,
  policy: BroadcastPolicy = DEFAULT_BROADCAST_POLICY,
  prefs?: Partial<InstancePrefs>,
): boolean => {
  // Non-read risk tiers must never be broadcast. Belt-and-suspenders —
  // these also shouldn't be cached to begin with (derivePolicy skips them).
  if (entry.risk_tier && entry.risk_tier !== 'read') return false;

  // Unknown category → skip. Legacy entries pre-phase-5 lack this field.
  if (!entry.category) return false;

  if (!policy.categories.has(entry.category)) return false;

  // L2 step cache honours the per-pair roaming toggle. `data`/`ai`
  // remain unconditional — they carry core recipe outputs, and the
  // user opts out of L2 specifically when metered.
  if (entry.category === 'step' && !getPref(prefs, 'cache.sync_l2')) {
    return false;
  }

  // Size filter: payload too large for broadcast — peer will fetch on demand.
  if (entry.size_bytes > policy.maxBytes) return false;

  return true;
};
