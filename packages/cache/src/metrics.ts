/** Cache metrics aggregator.
 *
 *  Drop-in consumer of `onStatus` callbacks from withIngredientCache.
 *  Keeps running counters + age histograms that telemetry / audit / UI
 *  can snapshot without coupling them to the cache wrapper's internals.
 *
 *  Zero-dep, pure in-memory. Safe to call record() on a hot path —
 *  all operations are O(1).
 *
 *  Usage:
 *    const metrics = createCacheMetrics();
 *    withIngredientCache(exec, { ..., onStatus: metrics.record });
 *    ...
 *    console.log(metrics.snapshot());
 */

import type { IngredientCategory } from '@recued/contracts';

export type CacheEventStatus = 'hit' | 'hit_stale' | 'miss' | 'skipped';

export interface CacheEventContext {
  slug: string;
  key?: string;
  age_ms?: number;
  stale?: boolean;
}

export interface StatusBucket {
  hit: number;
  hit_stale: number;
  miss: number;
  skipped: number;
  /** Sum of age_ms over all hits (for avg calculation). */
  age_ms_sum: number;
  /** Count of hits that carried an age_ms (denominator for avg). */
  age_ms_n: number;
}

const emptyBucket = (): StatusBucket => ({
  hit: 0,
  hit_stale: 0,
  miss: 0,
  skipped: 0,
  age_ms_sum: 0,
  age_ms_n: 0,
});

export interface MetricsSnapshot {
  /** Total across everything. */
  total: StatusBucket;
  /** Per-category breakdown. Keys limited to known categories + unknown. */
  by_category: Record<string, StatusBucket>;
  /** Per-ingredient breakdown — useful for "which ingredient miss hurts most" analysis. */
  by_slug: Record<string, StatusBucket>;
  /** Wall-clock snapshot time. */
  snapshot_at: number;
  /** Derived hit rate (hit + hit_stale) / (hit + hit_stale + miss).
   *  Null when no cacheable activity has been observed. */
  hit_rate: number | null;
  /** Average age_ms across all hits. Null when no hits observed. */
  avg_hit_age_ms: number | null;
}

export interface CacheMetrics {
  /** Drop into withIngredientCache as onStatus. */
  record(status: CacheEventStatus, context: CacheEventContext & { category?: IngredientCategory }): void;
  /** Read a snapshot. Non-destructive — counters keep accumulating. */
  snapshot(): MetricsSnapshot;
  /** Zero all counters. Useful between recipe runs for per-run tallies. */
  reset(): void;
}

export const createCacheMetrics = (): CacheMetrics => {
  const total = emptyBucket();
  const byCategory = new Map<string, StatusBucket>();
  const bySlug = new Map<string, StatusBucket>();

  const incr = (bucket: StatusBucket, status: CacheEventStatus, age_ms?: number) => {
    bucket[status]++;
    if ((status === 'hit' || status === 'hit_stale') && typeof age_ms === 'number') {
      bucket.age_ms_sum += age_ms;
      bucket.age_ms_n++;
    }
  };

  return {
    record(status, context) {
      incr(total, status, context.age_ms);

      const cat = context.category ?? 'unknown';
      let cb = byCategory.get(cat);
      if (!cb) { cb = emptyBucket(); byCategory.set(cat, cb); }
      incr(cb, status, context.age_ms);

      let sb = bySlug.get(context.slug);
      if (!sb) { sb = emptyBucket(); bySlug.set(context.slug, sb); }
      incr(sb, status, context.age_ms);
    },

    snapshot() {
      const hits = total.hit + total.hit_stale;
      const attempts = hits + total.miss;
      return {
        total: { ...total },
        by_category: Object.fromEntries(Array.from(byCategory, ([k, v]) => [k, { ...v }])),
        by_slug: Object.fromEntries(Array.from(bySlug, ([k, v]) => [k, { ...v }])),
        snapshot_at: Date.now(),
        hit_rate: attempts > 0 ? hits / attempts : null,
        avg_hit_age_ms: total.age_ms_n > 0 ? total.age_ms_sum / total.age_ms_n : null,
      };
    },

    reset() {
      Object.assign(total, emptyBucket());
      byCategory.clear();
      bySlug.clear();
    },
  };
};
