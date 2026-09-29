/** D-124 Phase 2.1 — backfill-state lookup helper.
 *
 *  Phase 2.2 (suppression at dispatcher) gates trigger fan-out on
 *  `isComplete(platform, slug)`. This module owns the read-side, and it
 *  READS THROUGH: every call reads the instance row.
 *
 *  ⛔⛔ IT USED TO CACHE, AND THE CACHE SILENCED MAIL TRIGGERS UNTIL A RESTART.
 *  The first check of a new mailbox's drain cached `false`; the adapter then
 *  flipped the row with `markBackfillComplete`, and nothing told the cache —
 *  `invalidate` / `refresh` were written for "instance-lifecycle rpcs" and
 *  never had a caller. So every `data.mail.<slug>.*` trigger stayed
 *  suppressed until the next boot built a fresh lookup (same for calendar
 *  and file). The same staleness ran the other way: a mailbox deleted and
 *  enrolled again restarts its drain at `false`, and a cached `true` let
 *  that drain's past mail fire every trigger. The tests passed because they
 *  called `invalidate` by hand — standing in for wiring production lacked.
 *
 *  🔑 A read is ~0.9 µs (measured, `instances.get`, 2026-09-26): a
 *  5,000-message backfill with five matching triggers costs ~22 ms. There
 *  was nothing worth caching, so there is nothing to invalidate.
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
  /** Synchronous read of the instance row, every call. Returns `true` when:
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
}

export interface CreateBackfillStateLookupOptions {
  instances: CollectionInstanceStore;
}

export const createBackfillStateLookup = (
  opts: CreateBackfillStateLookupOptions,
): BackfillStateLookup => {
  const { instances } = opts;

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
    for (const platform of CONTACT_FEEDERS) {
      for (const row of instances.list(platform)) {
        if (!row.backfill_complete) return false;
      }
    }
    return true;
  };

  return {
    isComplete(platform, slug) {
      // `contact` is derived from every mail / calendar feeder.
      if (platform === 'contact') return computeContact();
      const row = instances.get(platform as CollectionPlatform, slug);
      // Unknown (platform, slug) — return true so events flow through.
      // The suppression gate is opt-in by row presence; an event for a
      // row we never tracked means a test fixture or a
      // non-collection-platform emit (recipe-internal synthesis, a
      // mail fact, fixture data). Don't suppress.
      if (!row) return true;
      return computeForRow(row);
    },
  };
};
