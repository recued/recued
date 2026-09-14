/** Scheduler-slot substrate — declarative `{ name, boot }` registry for
 *  every long-running cmdServe scheduler.
 *
 *  Three call sites consume the slot bundles a boot returns:
 *
 *    1. `backgroundServices.stopAll({ kind: 'scheduler' })` — the stop
 *       closures each boot registers run from the registry. The
 *       maintenance-enter hook + fallback shutdown both flow through
 *       the same `kind: 'scheduler'` filter.
 *    2. The migration `onExitMaintenance` hook iterates every booted
 *       slot's optional `rebuild()` to bring stopped schedulers back
 *       online. Slots that omit `rebuild` (housekeeping, per D-123 P7)
 *       stay stopped until daemon restart.
 *    3. The lifecycle drain `pause_scheduler` step + executor's
 *       `getInFlightCount` closure + the auto-run-roster CLI status
 *       read live handles through the typed slots that
 *       `composeSchedulers` exposes (`cron` / `autoRun`).
 *
 *  Type heterogeneity — `SchedulerHandle` (cron) vs `ServerAutoRunHandle`
 *  (auto-run) vs `void` (housekeeping registers stop only; the scheduler
 *  itself is built by `composeHousekeepingScheduler` upstream). The
 *  generic `SchedulerSlot<H>` carries the handle type; the typed
 *  `SchedulersBundle` returned from `composeSchedulers` exposes per-name
 *  slots so call sites that need the live handle stay typed. The
 *  declarative `SCHEDULER_REGISTRY` array stays uniform (`SchedulerEntry`
 *  with an erased handle type) for iteration purposes — diagnostics +
 *  the `rebuildAll()` walk read names + `rebuild?` only. */

import type Database from 'better-sqlite3';
import type { NotificationMessage } from '@recued/notification';
import type { AutomationUnitRef } from '../../../automation-failure-reporter.js';
import type { MissedRunReport } from '@recued/scheduler';
import type { ScheduleStore } from '../../../schedule-store.js';
import type { SchedulerHandle } from '../../../scheduler.js';
import type {
  AutoRunSettingsStore,
  CircuitBreakerStore,
  ServerAutoRunHandle,
} from '../../../auto-run-scheduler.js';
import type { ExecuteHandlerDeps } from '../../../execute-handler.js';
import type { RecipeStore } from '../../../recipe-store.js';
import type { BackgroundServiceRegistry } from '../../bin/wire-background-services.js';
import { bootCronScheduler, CRON_SCHEDULER_NAME } from './cron/boot.js';
import { bootAutoRunScheduler, AUTO_RUN_SCHEDULER_NAME } from './auto-run/boot.js';
import {
  bootHousekeepingRegistration,
  HOUSEKEEPING_SCHEDULER_NAME,
} from './housekeeping/boot.js';

/** Grab-bag of late-bound refs every scheduler boot may pick from. Each
 *  per-scheduler module reads only the fields it needs; absent
 *  prerequisites (e.g., no `scheduleStore` for cron, no `db` for
 *  auto-run) return `undefined` from `boot()` so the slot is skipped. */
export interface SchedulerBootContext {
  /** D-269 — the server's declared IANA zone, for cron schedules that carry
   *  none. Absent ⇒ host-local, the pre-D-269 behaviour. */
  serverTimeZone?: () => string | undefined;
  /** Background-services registry the boot registers its stop closure
   *  with. Typically the module singleton. */
  readonly registry: BackgroundServiceRegistry;
  /** Open SQLite handle. Absent in dbless harnesses → auto-run skips. */
  readonly db: Database.Database | undefined;
  /** Cron schedule store. Absent → cron boot skips. */
  readonly scheduleStore: ScheduleStore | undefined;
  /** Shared execute deps. Required by both cron + auto-run. */
  readonly executeDeps: ExecuteHandlerDeps;
  /** Recipe store. Required by auto-run for roster + circuit. */
  readonly recipeStore: RecipeStore;
  /** Circuit-breaker store. Optional — auto-run falls back to
   *  `createCircuitBreakerStore(db)` when absent (mirrors the pre-
   *  extraction boot + maintenance-exit code paths). */
  readonly circuitStore: CircuitBreakerStore | undefined;
  /** Reactive-substrate slice 1 — per-recipe auto-run arm/disarm
   *  store. Optional — absent (dbless / legacy harness) every
   *  auto_run recipe rosters as enabled. The SAME instance backs the
   *  `auto_run.*` rpc deps so toggle writes and roster reads see one
   *  table. */
  readonly autoRunSettingsStore: AutoRunSettingsStore | undefined;
  /** Live vault-unlocked predicate (`app.isVaultUnlocked`). Threaded
   *  into both the cron + auto-run scheduler configs so their ticks
   *  no-op while the vault is sealed. Optional — absent (dbless / legacy
   *  harness) leaves the schedulers un-gated. */
  readonly isVaultUnlocked?: () => boolean;
  /** D-266 — per-tick hand-off of the misses waiting on an owner who
   *  chose `missed_policy: 'ask'`. Threaded into the CRON scheduler only
   *  (auto-run and housekeeping have no cron cycle to miss). Optional —
   *  absent leaves `Ask me` reaching the owner through the Automation
   *  card alone. */
  readonly onMissedRuns?: (report: MissedRunReport) => void | Promise<void>;
  /** D-268 — deliver one owner notice about a failed unattended run. Threaded
   *  into BOTH the cron and auto-run schedulers, which is why it lives on the
   *  shared boot context rather than on one boot's own options. Optional —
   *  absent leaves failures recorded on the row and reaching nobody, which is
   *  the behaviour before this seam existed.
   *
   *  ⚠ SYNCHRONOUS AND FIRE-AND-FORGET BY CONTRACT. A scheduler tick must never
   *  await an owner channel; the binding at the composition root swallows the
   *  promise. Same posture `update/owner-alert.ts` takes for boot. */
  readonly onAutomationFailure?: (
    notice: NotificationMessage,
    unit: AutomationUnitRef,
  ) => void;
}

/** Per-scheduler slot returned from `boot()`. Carries the typed handle
 *  and an optional rebuild hook the maintenance-exit pass calls. */
export interface SchedulerSlot<H> {
  /** Stable name; matches the `backgroundServices.register({ name })`
   *  string so diagnostic surfaces line up. */
  readonly name: string;
  /** Live handle accessor. Reads the per-boot `let` binding through a
   *  closure so the maintenance-exit `rebuild()` recreate is transparent
   *  to readers (e.g., `schedulerRef.pause()` still sees the fresh
   *  handle after restart). Returns `undefined` for void-handle slots
   *  (housekeeping). */
  getHandle(): H | undefined;
  /** Recreate + restart the scheduler. Called by the migration
   *  `onExitMaintenance` hook after `stopAll({ kind: 'scheduler' })`.
   *  Absent → slot is NOT rebuilt on maintenance exit (housekeeping
   *  stays stopped until daemon restart per D-123 P7). */
  rebuild?(): void;
}

/** Declarative registry entry. The handle type is erased here so the
 *  array can stay uniformly typed; per-name typed slots live on
 *  `SchedulersBundle`. Boot returns `undefined` when its prerequisites
 *  aren't satisfied — the composer iterates + skips.
 *
 *  `name` is REQUIRED to match the slot's own `slot.name` field. The
 *  composer asserts on mismatch — drift between the registry's view of
 *  the slot name and the slot itself is a programming error, not a
 *  runtime condition. */
export interface SchedulerEntry {
  readonly name: string;
  readonly boot: (ctx: SchedulerBootContext) => SchedulerSlot<unknown> | undefined;
}

/** The closed list of scheduler boots cmdServe runs. Order matters for
 *  diagnostic surfaces (`list()`) but not for stop ordering — the
 *  background-services registry walks its own reverse-registration order
 *  at stopAll time, independent of this array. */
export const SCHEDULER_REGISTRY: readonly SchedulerEntry[] = [
  {
    name: CRON_SCHEDULER_NAME,
    boot: (ctx) => bootCronScheduler(ctx),
  },
  {
    name: AUTO_RUN_SCHEDULER_NAME,
    boot: (ctx) => bootAutoRunScheduler(ctx),
  },
  {
    name: HOUSEKEEPING_SCHEDULER_NAME,
    boot: (ctx) => bootHousekeepingRegistration(ctx),
  },
];

export {
  CRON_SCHEDULER_NAME,
  AUTO_RUN_SCHEDULER_NAME,
  HOUSEKEEPING_SCHEDULER_NAME,
};

export type { SchedulerHandle, ServerAutoRunHandle };
