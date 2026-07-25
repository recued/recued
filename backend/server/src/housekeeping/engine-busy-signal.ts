/** D-123 Phase 2 — Engine busy-signal adapter.
 *
 *  Single read-side surface that answers "is the engine busy?" for
 *  the housekeeping scheduler's idle gate. Composes existing
 *  signals — auto-run scheduler's in-flight counter + collection
 *  instance store's backfill-complete bools. No new tracking; this
 *  is glue that keeps housekeeping idle-detection in sync with the
 *  actual execution state.
 *
 *  Spec: `docs/d-123-spec.md` §2.1. */

import type { CollectionInstanceStore } from '../collections/instance-store.js';

export interface EngineBusySignal {
  /** True if any recipe is currently executing — pulled from the
   *  auto-run scheduler's `inFlight()` getter (which already tracks
   *  the per-execution counter). */
  isExecuting(): boolean;
  /** True if any warehouse adapter is still in initial-backfill
   *  drain — derived from `collection_instances.backfill_complete`
   *  across every enrolled instance whose platform has a drain
   *  window. */
  isDraining(): boolean;
  /** Composite — true iff `isExecuting() || isDraining()`. The
   *  scheduler's idle gate negates this. */
  isBusy(): boolean;
  /** Last time `isBusy()` flipped from true → false. Returns null
   *  on a server that has been busy continuously since boot or one
   *  that has never been busy. The `aggressive` preset reads this
   *  to compute idle-since. */
  lastIdleTransitionAt(): number | null;
  /** Re-evaluate `isBusy()` and update the transition tracker.
   *  The scheduler's probe loop calls this once per
   *  `HOUSEKEEPING_IDLE_PROBE_MS` tick. */
  poll(now: number): void;
}

/** Platforms whose `backfill_complete` is meaningful — same shape
 *  as `triggers/backfill-state.ts.DRAINING_PLATFORMS` (kept in sync
 *  by convention; both lists answer the same physical question). */
const DRAINING_PLATFORMS: ReadonlySet<string> = new Set([
  'mail',
  'calendar',
  'file',
]);

export interface EngineBusySignalDeps {
  /** Auto-run scheduler handle (provides `inFlight()`). Optional —
   *  servers that boot with autoRun disabled still have a busy
   *  signal anchored on backfill state. */
  autoRun?: { inFlight(): boolean };
  /** Collection instance store. */
  instances: CollectionInstanceStore;
}

export const createEngineBusySignal = (
  deps: EngineBusySignalDeps,
): EngineBusySignal => {
  let lastBusy = false;
  let lastIdleAt: number | null = null;

  const isExecuting = (): boolean =>
    deps.autoRun?.inFlight() ?? false;

  const isDraining = (): boolean => {
    for (const row of deps.instances.list()) {
      if (!DRAINING_PLATFORMS.has(row.platform)) continue;
      if (!row.backfill_complete) return true;
    }
    return false;
  };

  const isBusy = (): boolean => isExecuting() || isDraining();

  return {
    isExecuting,
    isDraining,
    isBusy,
    lastIdleTransitionAt() {
      return lastIdleAt;
    },
    poll(now) {
      const busy = isBusy();
      if (lastBusy && !busy) lastIdleAt = now;
      lastBusy = busy;
    },
  };
};
