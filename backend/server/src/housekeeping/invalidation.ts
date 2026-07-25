/** D-123 Phase 6 — Cascade-engine invalidation notifier.
 *
 *  `createHousekeepingInvalidator` returns a function that the
 *  enrichment cascade engine (`storage/enrichment-cascade.ts`) calls
 *  after every cascade event. The notifier:
 *
 *    1. Walks the registered task list.
 *    2. Calls `task.onInvalidate?.(ctx, hint)` on each task that
 *       opts into invalidation.
 *    3. Flips `last_status: 'complete'` → `'pending'` for those
 *       tasks via `state.markPendingForInvalidation` so the next
 *       idle cycle re-steps them.
 *
 *  Tasks without `onInvalidate` are unaffected (audit-compaction,
 *  link-discovery, cache-eviction-beyond-ttl). Tasks in
 *  `last_status: 'error'` or `'in_progress'` are unaffected — those
 *  states have their own lifecycle (auto-retry window / scheduler
 *  in-flight). The notifier never throws — exceptions raised by a
 *  task's `onInvalidate` are swallowed so cascade-engine consumers
 *  (record delete, recipe upgrade) aren't aborted by an unrelated
 *  housekeeping bug.
 *
 *  Spec: `docs/d-123-spec.md` §6.1. */

import type {
  HousekeepingContext,
  HousekeepingInvalidateHint,
  HousekeepingTaskInstance,
} from './registry.js';
import type { HousekeepingStateStore } from './state-store.js';

export interface HousekeepingInvalidatorDeps {
  /** Returns the current registered task list. Pass
   *  `listHousekeepingTasks` from the singleton registry, or
   *  `registry.list` from a test-isolated registry. */
  registry: () => ReadonlyArray<HousekeepingTaskInstance>;
  /** State store handle — the notifier flips `last_status` here. */
  state: HousekeepingStateStore;
  /** Late-binding context provider. Called once per notifier
   *  invocation; lets bin.ts compose `db` / `bus` / `enrichmentStore`
   *  / etc. without forcing a circular dependency between cascade
   *  construction and warehouse-bus construction. */
  context: () => HousekeepingContext;
}

export type HousekeepingInvalidator = (hint: HousekeepingInvalidateHint) => void;

export const createHousekeepingInvalidator = (
  deps: HousekeepingInvalidatorDeps,
): HousekeepingInvalidator => {
  return (hint) => {
    const tasks = deps.registry();
    if (tasks.length === 0) return;
    let ctx: HousekeepingContext | undefined;
    for (const task of tasks) {
      if (typeof task.onInvalidate !== 'function') continue;
      // Defer context construction until the first opted-in task —
      // a registry without any onInvalidate-implementing tasks
      // shouldn't pay for the context build at all.
      if (ctx === undefined) ctx = deps.context();
      try {
        task.onInvalidate(ctx, hint);
      } catch {
        // Best-effort. The cascade hot path must not abort because
        // a task's invalidation handler threw.
      }
      deps.state.markPendingForInvalidation(task.meta.id);
    }
  };
};
