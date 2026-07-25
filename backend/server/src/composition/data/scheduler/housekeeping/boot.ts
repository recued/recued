/** Housekeeping scheduler — bg-services registration only.
 *
 *  Unlike cron + auto-run, the housekeeping scheduler itself is built
 *  upstream by `composeHousekeepingScheduler` (`wire-housekeeping-
 *  substrate.ts`) and published into the shared
 *  `housekeepingSchedulerRegistry` singleton. This boot's job is the
 *  smaller piece: register a `kind: 'scheduler'` stop closure with
 *  `backgroundServices` so the maintenance-enter + fallback shutdown
 *  pathways stop the housekeeping cycle uniformly with cron + auto-run.
 *
 *  No prerequisites — the registration is always safe. The stop closure
 *  calls `housekeepingSchedulerRegistry.stop()`, which is idempotent
 *  (no-op when no scheduler has been published yet, mirrors the pre-
 *  extraction inline register). Boots that construct the scheduler
 *  late (after vendor substrate compose) still hit the same registry
 *  instance.
 *
 *  No `rebuild` — per D-123 P7 the housekeeping scheduler does NOT
 *  resume after maintenance exit; the operator restarts the daemon. The
 *  composer's `rebuildAll()` walk skips slots without `rebuild`. */

import { housekeepingSchedulerRegistry } from '../../../bin/housekeeping-scheduler-instance.js';
import type { SchedulerBootContext, SchedulerSlot } from '../registry.js';

/** Canonical slot name — see CRON_SCHEDULER_NAME's doc for the
 *  single-source-of-truth pattern. */
export const HOUSEKEEPING_SCHEDULER_NAME = 'housekeeping-scheduler';

export const bootHousekeepingRegistration = (
  ctx: SchedulerBootContext,
): SchedulerSlot<void> => {
  ctx.registry.register({
    name: HOUSEKEEPING_SCHEDULER_NAME,
    kind: 'scheduler',
    stop: async () => {
      await housekeepingSchedulerRegistry.stop();
    },
  });

  return {
    name: HOUSEKEEPING_SCHEDULER_NAME,
    getHandle: () => undefined,
  };
};
