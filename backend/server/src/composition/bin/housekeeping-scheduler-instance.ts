/** Module-level singleton for the housekeeping scheduler ref + per-task
 *  enrichment-producer map.
 *
 *  Three writers / consumers share these handles across the cmdServe
 *  boot timeline:
 *
 *    - `composeHousekeepingRpcDeps` (early, line ~3271 of bin.ts) reads
 *      the producer map for `housekeeping.status.read` →
 *      `getEnrichmentInfo`, and the scheduler ref via getter for
 *      `housekeeping.task.run_now` (late-bound — the ref is undefined
 *      at composer-call time, populated below).
 *    - `contactMergeDeps.runScanNow` (rpc inline closure) reads the
 *      scheduler ref via getter to drive the contact-merge full-scan
 *      loop.
 *    - `composeHousekeepingScheduler` (late, line ~4400 of bin.ts)
 *      populates the producer map (one entry per registered
 *      enrichment task) and writes the scheduler ref.
 *    - `backgroundServices.register({kind: 'scheduler'})` reads the
 *      ref at stop time to drive the maintenance-enter / fallback-
 *      shutdown stop pathways.
 *
 *  Why a singleton instead of `let` bindings in bin.ts:
 *    - The scheduler ref + producer map were two of the few remaining
 *      module-top `let` / `const` housekeeping bindings in bin.ts.
 *      Lifting them out lets the rpc-deps + contact-merge wires read
 *      the same registry the scheduler composer writes to, without
 *      threading getters through bin.ts.
 *    - cmdServe runs once per process, so the singleton identity
 *      matches the cmdServe-scoped registration pattern.
 *
 *  Testing note: tests that want isolation construct their own
 *  registry via `createHousekeepingSchedulerRegistry()`. Production
 *  code uses the exported `housekeepingSchedulerRegistry` singleton for
 *  set / get / stop interop. */

import type {
  HousekeepingEnrichmentProducer,
  HousekeepingScheduler,
  SourceCollectionWalker,
} from '../../housekeeping/index.js';

/** Per-task entry in the enrichment-producer map. The map is keyed by
 *  `enrichment.<topic>` (the `task_id` shape `buildEnrichmentProducerTask`
 *  emits). `<unknown>` erases the producer's source-scope generic —
 *  readers only touch `TData`-independent fields
 *  (`estimate_per_record_tokens`, `source_scope`, `ai_surface`). */
export interface EnrichmentProducerEntry {
  producer: HousekeepingEnrichmentProducer<unknown>;
  walker: SourceCollectionWalker<unknown>;
}

export interface HousekeepingSchedulerRegistry {
  /** Publish the constructed scheduler. Called once per cmdServe by
   *  the scheduler composer. */
  setScheduler(scheduler: HousekeepingScheduler): void;
  /** Late-bound read for rpc handlers fired post-boot. Returns
   *  `undefined` during the boot window between the rpc-deps composer
   *  call and the scheduler composer call. */
  getScheduler(): HousekeepingScheduler | undefined;
  /** The producer map, shared by reference. The scheduler composer
   *  clears + populates it during construction; the rpc-deps composer's
   *  `getEnrichmentInfo` reads from the same instance. */
  producers(): Map<string, EnrichmentProducerEntry>;
  /** Best-effort stop. Idempotent — a no-op when no scheduler has been
   *  registered yet, and clears the internal ref so subsequent
   *  `getScheduler()` calls return undefined (prevents rpc handlers
   *  from dispatching into a stopped scheduler post-maintenance-enter). */
  stop(): Promise<void>;
}

export const createHousekeepingSchedulerRegistry = (): HousekeepingSchedulerRegistry => {
  let scheduler: HousekeepingScheduler | undefined;
  const enrichmentProducers = new Map<string, EnrichmentProducerEntry>();
  return {
    setScheduler(next) {
      scheduler = next;
    },
    getScheduler() {
      return scheduler;
    },
    producers() {
      return enrichmentProducers;
    },
    async stop() {
      const current = scheduler;
      if (!current) return;
      scheduler = undefined;
      await current.stop();
    },
  };
};

export const housekeepingSchedulerRegistry: HousekeepingSchedulerRegistry =
  createHousekeepingSchedulerRegistry();
