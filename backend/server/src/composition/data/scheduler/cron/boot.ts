/** Cron-scheduler boot. Constructs the per-pair cron scheduler
 *  (`createScheduler`), starts it, registers its stop closure with the
 *  shared `backgroundServices` registry under `kind: 'scheduler'`, and
 *  exposes a typed slot the caller reads via `getHandle()`.
 *
 *  Prerequisites: `ctx.scheduleStore` must exist. Dbless harnesses leave
 *  it undefined and the boot returns `undefined` — no slot is produced,
 *  no service is registered.
 *
 *  Maintenance lifecycle: `rebuild()` constructs a fresh `SchedulerHandle`
 *  and starts it. The migration `onExitMaintenance` hook calls every
 *  slot's `rebuild()` after `stopAll({ kind: 'scheduler' })`. The
 *  background-services stop closure reads the live `handle` binding at
 *  call time so the next stopAll picks up the rebuilt handle without
 *  the registry needing a re-register. */

import { createScheduler, type SchedulerHandle } from '../../../../scheduler.js';
import type { SchedulerBootContext, SchedulerSlot } from '../registry.js';

/** Canonical slot name. Single source of truth — every other layer
 *  (slot.name, registry.register name, registry array entry name,
 *  composeSchedulers' typed-slot lookup) imports this constant rather
 *  than hardcoding the string. Renames touch one place. */
export const CRON_SCHEDULER_NAME = 'cron-scheduler';

export const bootCronScheduler = (
  ctx: SchedulerBootContext,
): SchedulerSlot<SchedulerHandle> | undefined => {
  if (!ctx.scheduleStore) return undefined;
  const scheduleStore = ctx.scheduleStore;
  const executeDeps = ctx.executeDeps;

  let handle: SchedulerHandle | undefined;
  const start = (): void => {
    handle = createScheduler({
      store: scheduleStore,
      executeDeps,
      // D-269 — the declared server zone, so `0 9 * * *` means 9am to the
      // OWNER rather than 9am wherever this process happens to run. Read per
      // tick, because under `follows_host` it is the host clock and the
      // scheduler outlives any single reading.
      ...(ctx.serverTimeZone ? { serverTimeZone: ctx.serverTimeZone } : {}),
      ...(ctx.isVaultUnlocked ? { isVaultUnlocked: ctx.isVaultUnlocked } : {}),
      // D-266 — the missed-run ask. Cron only: auto-run and housekeeping
      // have no cron cycle to miss, so there is nothing for them to ask
      // about. `rebuild()` re-reads it through `ctx`, so a maintenance
      // swap keeps the seam.
      ...(ctx.onMissedRuns ? { onMissedRuns: ctx.onMissedRuns } : {}),
      // D-268 — the failure notice. Same `ctx` re-read as the line above, so a
      // maintenance rebuild keeps the seam rather than silently dropping it.
      ...(ctx.onAutomationFailure ? { onAutomationFailure: ctx.onAutomationFailure } : {}),
    });
    handle.start();
  };

  start();

  ctx.registry.register({
    name: CRON_SCHEDULER_NAME,
    kind: 'scheduler',
    stop: async () => {
      // Reads `handle` through closure so a rebuild() swap is
      // transparent — the next stopAll picks up the fresh handle.
      const current = handle;
      if (current) await current.stop();
    },
  });

  return {
    name: CRON_SCHEDULER_NAME,
    getHandle: () => handle,
    rebuild: start,
  };
};
