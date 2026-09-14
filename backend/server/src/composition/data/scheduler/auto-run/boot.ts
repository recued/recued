/** Auto-run-scheduler boot (D-115 Phase 4).
 *
 *  Constructs the reactive recipe auto-run scheduler
 *  (`createServerAutoRunScheduler`), kicks `.start()` with an attached failure
 *  reporter, registers its stop closure with `backgroundServices` under
 *  `kind: 'scheduler'`, and exposes a typed slot.
 *
 *  Prerequisites: `ctx.db` AND a non-empty `ctx.executeDeps`. Either
 *  absent → boot returns `undefined` (no slot, no service).
 *
 *  Circuit breaker: `ctx.circuitStore` is preferred. When absent, the
 *  boot falls back to `createCircuitBreakerStore(ctx.db)` — mirrors the
 *  pre-extraction inline boot AND the pre-extraction maintenance-exit
 *  rebuild (both used `circuitStoreRef ?? createCircuitBreakerStore(db)`).
 *  rebuild() applies the same fallback so a process that never
 *  pre-constructed the circuit store still rebuilds cleanly.
 *
 *  Maintenance lifecycle: `rebuild()` constructs a fresh
 *  `ServerAutoRunHandle` and fires `.start()` async. The background-
 *  services stop closure reads `handle` through closure so the next
 *  stopAll picks up the rebuilt handle. */

import {
  createCircuitBreakerStore,
  createServerAutoRunScheduler,
  type ServerAutoRunHandle,
} from '../../../../auto-run-scheduler.js';
import { emitReactiveFire } from '../../../../events/emit-sites.js';
import type { SchedulerBootContext, SchedulerSlot } from '../registry.js';

/** Canonical slot name — see CRON_SCHEDULER_NAME's doc for the
 *  single-source-of-truth pattern. */
export const AUTO_RUN_SCHEDULER_NAME = 'auto-run-scheduler';

const reportStartFailure = (error: unknown): void => {
  try {
    console.error('[auto-run] scheduler start failed', error);
  } catch {
    // Diagnostics must not turn a contained startup failure into another
    // unhandled rejection.
  }
};

const launchStart = (handle: ServerAutoRunHandle): void => {
  try {
    void handle.start().catch(reportStartFailure);
  } catch (error) {
    // ServerAutoRunHandle.start is async today, but keep the detached boot
    // boundary safe if a future implementation validates synchronously.
    reportStartFailure(error);
  }
};

export const bootAutoRunScheduler = (
  ctx: SchedulerBootContext,
): SchedulerSlot<ServerAutoRunHandle> | undefined => {
  const db = ctx.db;
  if (!db) return undefined;
  // executeDeps is required by ServerAutoRunConfig and always present
  // on SchedulerBootContext; no guard needed.
  const recipeStore = ctx.recipeStore;
  const executeDeps = ctx.executeDeps;

  let handle: ServerAutoRunHandle | undefined;
  const start = (): void => {
    handle = createServerAutoRunScheduler({
      recipeStore,
      executeDeps,
      circuitStore: ctx.circuitStore ?? createCircuitBreakerStore(db),
      // Reactive-substrate slice 1 — user arm/disarm consult + the
      // per-fire `reactive_fire` broadcast (rides the same bus the
      // cron scheduler's `schedule fired` emit uses).
      ...(ctx.autoRunSettingsStore
        ? { settingsStore: ctx.autoRunSettingsStore }
        : {}),
      ...(ctx.isVaultUnlocked ? { isVaultUnlocked: ctx.isVaultUnlocked } : {}),
      onFired: (recipe_id) =>
        emitReactiveFire(executeDeps.eventBus, recipe_id),
      // D-268 — the failure notice, read through `ctx` so a maintenance
      // rebuild keeps the seam rather than silently dropping it.
      ...(ctx.onAutomationFailure ? { onAutomationFailure: ctx.onAutomationFailure } : {}),
    });
    launchStart(handle);
  };

  start();

  ctx.registry.register({
    name: AUTO_RUN_SCHEDULER_NAME,
    kind: 'scheduler',
    stop: async () => {
      const current = handle;
      if (current) await current.stop();
    },
  });

  return {
    name: AUTO_RUN_SCHEDULER_NAME,
    getHandle: () => handle,
    rebuild: start,
  };
};
