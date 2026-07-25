/** Scheduler-substrate composer. Iterates the declarative
 *  `SCHEDULER_REGISTRY` once per cmdServe boot, collects the booted
 *  slots into a typed bundle, and returns:
 *
 *    - `cron` / `autoRun` — typed accessors for the slots that own a
 *      live handle. Each is `undefined` when the underlying boot
 *      returned `undefined` (prerequisites missing — cron skips when no
 *      `scheduleStore`, auto-run skips when no `db`). The housekeeping
 *      slot is NOT exposed here: `composeHousekeepingScheduler` owns
 *      the housekeeping handle through the `housekeepingScheduler-
 *      Registry` singleton, and the slot's boot is registration-only
 *      (no handle to read). Adding a `housekeeping` field to the bundle
 *      would advertise a `getHandle()` that always returns undefined —
 *      a footgun the type system can't ward off, so the slot stays
 *      internal to the iteration.
 *    - `rebuildAll()` — iterates every booted slot with a `rebuild`
 *      hook and invokes it. The migration `onExitMaintenance` hook
 *      calls this after `stopAll({ kind: 'scheduler' })`. Housekeeping's
 *      slot omits `rebuild` so the walk skips it (D-123 P7 — stays
 *      stopped until daemon restart). Per-slot try/catch isolates one
 *      slot's failure from the rest — pre-extraction the inline boots
 *      lived in independent `if` blocks, so a cron rebuild error did
 *      NOT block auto-run rebuild. The wrap preserves that resilience.
 *    - `list()` — registration-order names of every booted slot, for
 *      diagnostics.
 *
 *  Why the typed bundle on top of the declarative registry: handle
 *  types differ across slots (`SchedulerHandle` / `ServerAutoRunHandle`
 *  / void). The registry array stays uniformly `SchedulerEntry` so
 *  iteration + the diagnostic walk read names + `rebuild?` only; the
 *  bundle exposes per-name typed slots for callers that need the live
 *  handle (`schedulerRef.pause()`, `autoRunHandle.inFlight()` etc.).
 *
 *  Adding a new scheduler that owns a typed handle: declare a per-
 *  scheduler boot module under `composition/data/scheduler/<name>/
 *  boot.ts` that exports a `<NAME>_SCHEDULER_NAME` constant, append the
 *  entry to `SCHEDULER_REGISTRY`, and add an optional named accessor to
 *  `SchedulersBundle`. No edits to the iteration loop. */

import type { SchedulerHandle } from '../../scheduler.js';
import type { ServerAutoRunHandle } from '../../auto-run-scheduler.js';
import {
  SCHEDULER_REGISTRY,
  CRON_SCHEDULER_NAME,
  AUTO_RUN_SCHEDULER_NAME,
  type SchedulerBootContext,
  type SchedulerSlot,
} from '../data/scheduler/registry.js';

export interface SchedulersBundle {
  /** Cron scheduler slot. `undefined` when `ctx.scheduleStore` was
   *  missing at boot. */
  readonly cron: SchedulerSlot<SchedulerHandle> | undefined;
  /** Auto-run scheduler slot. `undefined` when `ctx.db` was missing
   *  at boot. */
  readonly autoRun: SchedulerSlot<ServerAutoRunHandle> | undefined;
  /** Names of every booted slot in registration order. Includes the
   *  housekeeping registration entry. Mirrors
   *  `backgroundServices.list({ kind: 'scheduler' })` modulo the
   *  registration order vs. registry-array order distinction. */
  list(): readonly string[];
  /** Re-creates + restarts every booted slot that exposed a `rebuild`
   *  hook. Used by the migration maintenance-exit pass after a
   *  `stopAll({ kind: 'scheduler' })`. Housekeeping skips (no rebuild).
   *  Per-slot failures are caught + logged via `console.warn` so one
   *  broken rebuild can't strand the rest (mirrors the wire-background-
   *  services `stopAll` per-iteration safety net). */
  rebuildAll(): void;
}

export const composeSchedulers = (ctx: SchedulerBootContext): SchedulersBundle => {
  const slots: SchedulerSlot<unknown>[] = [];
  const byName = new Map<string, SchedulerSlot<unknown>>();

  for (const entry of SCHEDULER_REGISTRY) {
    const slot = entry.boot(ctx);
    if (!slot) continue;
    // Drift guard: each per-scheduler module exports a NAME constant
    // used by both `entry.name` (here in the registry array) and
    // `slot.name` (returned by `boot()`). A typo or partial rename
    // would silently leave the lookup-by-name surface pointing at an
    // unrelated slot. The composer is the single iteration point that
    // sees both — assert on mismatch so the failure surfaces at boot,
    // not later via a silently-undefined typed accessor.
    if (entry.name !== slot.name) {
      throw new Error(
        `[composeSchedulers] entry/slot name mismatch: entry.name=${entry.name} slot.name=${slot.name}`,
      );
    }
    slots.push(slot);
    byName.set(slot.name, slot);
  }

  const lookup = <H>(name: string): SchedulerSlot<H> | undefined => {
    const slot = byName.get(name);
    return slot as SchedulerSlot<H> | undefined;
  };

  return {
    cron: lookup<SchedulerHandle>(CRON_SCHEDULER_NAME),
    autoRun: lookup<ServerAutoRunHandle>(AUTO_RUN_SCHEDULER_NAME),
    list: () => slots.map((s) => s.name),
    rebuildAll: () => {
      for (const slot of slots) {
        if (!slot.rebuild) continue;
        try {
          slot.rebuild();
        } catch (err) {
          // Per-slot isolation: one slot's rebuild failure must not
          // block subsequent slots' rebuilds. Mirrors the per-service
          // try/catch in `wire-background-services.ts::stopAll`.
          console.warn(`[scheduler-rebuild] ${slot.name} rebuild failed`, err);
        }
      }
    },
  };
};

export type { SchedulerBootContext, SchedulerSlot };
