/** D-124 Phase 2.1 — backfill-state lookup helper.
 *
 *  Phase 2.2 (suppression at dispatcher) will gate trigger fan-out on
 *  `isAdapterBackfillComplete(platform, slug)`. This module owns the
 *  read-side: an in-memory cache populated at dispatcher init,
 *  refreshed by instance-lifecycle rpcs, with a SQLite fallback on
 *  cache miss.
 *
 *  Per-platform rules (per spec table):
 *
 *    - `mail` / `calendar` / `file` — read the denormalized
 *      `backfill_complete` bool from `collection_instances`. Adapters
 *      flip it once at their cursor-stable-persist site; default false.
 *
 *    - `contact` — derivative. `backfill_complete` iff EVERY source
 *      adapter feeding it (`mail` + `calendar` instances) is itself
 *      backfill_complete. Vacuous-true when no upstream feeders exist
 *      (no drain to wait on).
 *
 *    - `webhook` / `service` — vacuously true. Webhook is append-only
 *      by definition (no drain window); service-collection instances
 *      aren't warehouse mirrors. The spec table omits both — the
 *      helper still answers cleanly so the caller doesn't have to
 *      special-case unknown platforms before the suppression check. */

import type { CollectionPlatform } from '@recued/contracts';
import type {
  CollectionInstanceRecord,
  CollectionInstanceStore,
} from '../collections/instance-store.js';

/** Platforms whose `backfill_complete` is meaningful — i.e. they
 *  actually drain a window of historical records on first enrollment.
 *  Webhook + service are vacuously complete (no drain). */
const DRAINING_PLATFORMS: ReadonlySet<CollectionPlatform> = new Set<
  CollectionPlatform
>(['mail', 'calendar', 'file']);

/** Source adapters that feed `data.contact`. Phase 2.1's contact
 *  derivation is the AND of every row in this set's
 *  `backfill_complete`. Vacuous-true when no mail / calendar instances
 *  are enrolled — there's no drain window for contacts to wait on. */
const CONTACT_FEEDERS: ReadonlySet<CollectionPlatform> = new Set<
  CollectionPlatform
>(['mail', 'calendar']);

export interface BackfillStateLookup {
  /** Synchronous read — cache hit returns immediately, miss falls
   *  through to a SQLite read on `instances`. Returns `true` when:
   *
   *    - the row exists with `backfill_complete = true`,
   *    - the row exists for `webhook` / `service` (vacuous-true),
   *    - the platform is `contact` and every mail / calendar instance
   *      is `backfill_complete = true` (or no mail / calendar
   *      instances exist at all).
   *
   *  Returns `false` when:
   *
   *    - the row exists for a draining platform with
   *      `backfill_complete = false`,
   *    - the platform is `contact` and at least one mail / calendar
   *      feeder is mid-drain.
   *
   *  Returns `true` for an unknown `(platform, slug)` (no row exists)
   *  on the principle that we don't suppress events for adapters we
   *  don't track — the gate is a *suppression* of known-draining
   *  adapters, not a global allow-list. Phase 2.2 callers can layer
   *  stricter checks on top if needed. */
  isComplete(platform: string, slug: string): boolean;
  /** Force a re-read of every row from SQLite. Called by
   *  instance-lifecycle rpcs (enroll / delete / resync) that mutate
   *  `collection_instances` outside the helper's view, and by tests. */
  refresh(): void;
  /** Mark a single `(platform, slug)` pair stale so the next
   *  `isComplete` call falls through to SQLite. Cheaper than a full
   *  `refresh()` for the common single-instance mutation case. Safe to
   *  call from rpc handlers after `instances.upsert` /
   *  `instances.markBackfillComplete` resolves. */
  invalidate(platform: string, slug: string): void;
}

export interface CreateBackfillStateLookupOptions {
  instances: CollectionInstanceStore;
}

const cacheKey = (platform: string, slug: string): string =>
  `${platform}:${slug}`;

export const createBackfillStateLookup = (
  opts: CreateBackfillStateLookupOptions,
): BackfillStateLookup => {
  const { instances } = opts;

  // Cache: `${platform}:${slug}` → backfill_complete bool. Populated
  // lazily — first `isComplete` call for a key reads from SQLite,
  // subsequent calls hit the cache until invalidated. `refresh()`
  // bulk-populates from a single `instances.list()` walk.
  const cache = new Map<string, boolean>();

  const readRow = (
    platform: string,
    slug: string,
  ): CollectionInstanceRecord | null => {
    return instances.get(platform as CollectionPlatform, slug);
  };

  const computeForRow = (row: CollectionInstanceRecord): boolean => {
    if (!DRAINING_PLATFORMS.has(row.platform)) {
      // webhook + service: vacuously complete. The bool on the row is
      // tracked but ignored — adapters in these classes don't drain,
      // and never call `markBackfillComplete`.
      return true;
    }
    return row.backfill_complete;
  };

  const computeContact = (): boolean => {
    // Vacuous-true when no upstream feeders exist; otherwise the AND
    // across every feeder's bool. We list per-platform rather than
    // pulling the full table so the working set stays bounded by
    // mail+calendar instance count.
    let everyFeederComplete = true;
    let anyFeederExists = false;
    for (const platform of CONTACT_FEEDERS) {
      for (const row of instances.list(platform)) {
        anyFeederExists = true;
        if (!row.backfill_complete) {
          everyFeederComplete = false;
          // Don't break — refresh() side of the call still wants
          // populated cache entries for every observed row.
          cache.set(cacheKey(row.platform, row.slug), false);
        } else {
          cache.set(cacheKey(row.platform, row.slug), true);
        }
      }
    }
    if (!anyFeederExists) return true;
    return everyFeederComplete;
  };

  return {
    isComplete(platform, slug) {
      if (platform === 'contact') {
        // Always recompute — feeder churn (a fresh mail enroll
        // mid-flight) is the common case and caching the AND would
        // require invalidation on every feeder mutation. Cheap walk.
        return computeContact();
      }
      const key = cacheKey(platform, slug);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const row = readRow(platform, slug);
      if (!row) {
        // Unknown (platform, slug) — return true so events flow
        // through. Phase 2.2's suppression gate is opt-in by row
        // presence; an event for a row we never tracked means a test
        // fixture or a non-collection-platform emit (recipe-internal
        // synthesis, fixture data). Don't suppress.
        return true;
      }
      const complete = computeForRow(row);
      cache.set(key, complete);
      return complete;
    },
    refresh() {
      cache.clear();
      for (const row of instances.list()) {
        cache.set(cacheKey(row.platform, row.slug), computeForRow(row));
      }
    },
    invalidate(platform, slug) {
      cache.delete(cacheKey(platform, slug));
    },
  };
};
