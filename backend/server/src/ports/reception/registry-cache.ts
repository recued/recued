/** D-149 P3 § A.3 — In-memory registry cache with 60s staleness ceiling.
 *
 *  Per § Must Hold I-5: revocation propagates within 60s globally.
 *  The reception listener consults this cache on every request; on hit
 *  it skips the SQL roundtrip + token-HMAC fetch + verify. On miss
 *  (or stale), the listener reads from the registry SQL store + writes
 *  the row into the cache. The bus emits a `reception.endpoint_changed`
 *  event on every mutation (`create / enable / disable / revoke /
 *  extend / rotate_token`); the cache invalidates the affected entry
 *  on the event. This ratchets the worst-case staleness to ≤60s even
 *  under cache-only reads.
 *
 *  Two layers:
 *
 *    1. **TTL-bounded LRU** — every entry carries an `inserted_at`
 *       stamp; the listener calls `get(endpoint_id, now)` and the
 *       cache returns `null` for stale entries (forcing a SQL read).
 *       LRU bound keeps the cache from growing unboundedly under
 *       endpoint churn (e.g., a bot scraping every public_locator).
 *
 *    2. **Bus-driven invalidation** — `invalidate(endpoint_id)` runs
 *       on `reception.endpoint_changed` events from the bus. Hooks
 *       into `EventBus.subscribe` or the rpc-handler's per-mutation
 *       broadcast emit (whichever wires first at boot).
 *
 *  The cache is intentionally narrow: it holds the `EndpointSummary`
 *  shape + the `bearer_secret_hmac` Buffer needed for verify. Storing
 *  the HMAC in the cache lets the verify path avoid re-reading the
 *  row on every request — the HMAC stays in memory throughout the
 *  endpoint's lifetime, and rotation propagates via the same
 *  invalidation path.
 *
 *  Spec: D-149 § A.3 + § Must Hold I-5. */

import type { EndpointSummary } from '@recued/contracts';

/** Default LRU capacity. Sized to comfortably hold every reception
 *  endpoint a single-user server might host without exceeding ~16 KB
 *  of resident memory at full fill. Bus-driven invalidation handles
 *  correctness; the LRU exists only to bound RSS. */
export const REGISTRY_CACHE_DEFAULT_CAPACITY = 1024;

/** Per Must Hold I-5 — 60s staleness ceiling. The listener calls
 *  `get(endpoint_id, now)` which compares `inserted_at` to `now`;
 *  entries older than the ceiling return null even on hit. */
export const REGISTRY_CACHE_STALENESS_MS = 60 * 1000;

export interface CachedEndpoint {
  readonly summary: EndpointSummary;
  /** The `bearer_secret_hmac` Buffer. Cached so the verify path stays
   *  zero-SQL on cache hit. */
  readonly bearer_secret_hmac: Buffer;
  /** Unix-ms; cache entry was inserted (read from SQL) at this time. */
  readonly inserted_at: number;
}

export interface ReceptionRegistryCache {
  /** Lookup. Returns the cached entry on hit + staleness check; null on
   *  miss / stale. Hit promotes the entry to MRU. */
  get(endpoint_id: string, now: number): CachedEndpoint | null;
  /** Insert / refresh. The new entry becomes MRU; eviction trims the
   *  LRU tail if over capacity. */
  put(input: {
    endpoint_id: string;
    summary: EndpointSummary;
    bearer_secret_hmac: Buffer;
    now: number;
  }): void;
  /** Invalidate a single entry. Fires on bus events. */
  invalidate(endpoint_id: string): void;
  /** Flush the entire cache (operator failsafe). */
  flush(): void;
  /** Diagnostic — current cache size. */
  size(): number;
}

export const createReceptionRegistryCache = (opts?: {
  capacity?: number;
}): ReceptionRegistryCache => {
  const capacity = Math.max(1, opts?.capacity ?? REGISTRY_CACHE_DEFAULT_CAPACITY);
  // Map iteration is insertion-ordered. Delete + re-insert promotes
  // an entry to MRU (mirrors the standard JS-native LRU pattern).
  const entries = new Map<string, CachedEndpoint>();

  const promote = (endpoint_id: string, value: CachedEndpoint): void => {
    entries.delete(endpoint_id);
    entries.set(endpoint_id, value);
  };

  const evictTail = (): void => {
    while (entries.size > capacity) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      entries.delete(oldestKey);
    }
  };

  return {
    get(endpoint_id, now) {
      const value = entries.get(endpoint_id);
      if (!value) return null;
      if (now - value.inserted_at >= REGISTRY_CACHE_STALENESS_MS) {
        entries.delete(endpoint_id);
        return null;
      }
      promote(endpoint_id, value);
      return value;
    },

    put({ endpoint_id, summary, bearer_secret_hmac, now }) {
      const value: CachedEndpoint = {
        summary,
        bearer_secret_hmac,
        inserted_at: now,
      };
      promote(endpoint_id, value);
      evictTail();
    },

    invalidate(endpoint_id) {
      entries.delete(endpoint_id);
    },

    flush() {
      entries.clear();
    },

    size() {
      return entries.size;
    },
  };
};
