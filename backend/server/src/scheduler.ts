/** Server-side scheduler loop.
 *
 *  Ticks once per minute, walks enabled schedules, fires any that are
 *  due via the server's recipe executor. Each instance runs its own
 *  scheduler — no cross-instance coordination. The extension aggregates
 *  schedules from each instance for display but never arbitrates firing.
 *
 *  Dedupe guard: a schedule is only fired once per cron minute (we
 *  compare `last_run_at` to the matched minute's timestamp). If the
 *  server restarts between ticks, a schedule that was about to fire
 *  will fire on the next tick after recovery — "skipped for >1 minute"
 *  is surfaced in last_status for observability.
 */

import type { Schedule } from '@recued/scheduler';
import {
  cronMatchesAt,
  nextCronMatch,
  shouldCatchUp,
  buildBackfillMetadata,
  type BackfillMetadata,
} from '@recued/scheduler';
import { handleExecute, type ExecuteHandlerDeps } from './execute-handler.js';
import type { ScheduleStore } from './schedule-store.js';
import { retireSchedule } from './schedule-retire.js';
import { emitSchedule } from './events/emit-sites.js';
import { presentAutomationFailure } from './automation-failure.js';

export interface SchedulerConfig {
  store: ScheduleStore;
  executeDeps: ExecuteHandlerDeps;
  /** Deterministic execution seam for lifecycle tests. Production uses the
   *  real execute handler. */
  execute?: typeof handleExecute;
  /** Override for tests. */
  now?: () => number;
  /** Tick frequency in ms. Default 60s. Set lower for tests. */
  tickIntervalMs?: number;
  /** Reports failures from scheduler-owned background ticks. Manual `tick()`
   *  calls still reject to their caller. The hook is guarded so diagnostics
   *  cannot turn a contained tick failure into an unhandled rejection. */
  onBackgroundError?: (message: string, error: unknown) => void;
  /** Vault-unlocked gate. When provided and `false`, a tick is a no-op
   *  (no schedule fires) — autonomous execution must not run while the
   *  vault is sealed (its recipes can't reach credentials, and the run
   *  would write cache rows the locked store can't encrypt). The
   *  `setInterval` keeps ticking, so firing self-resumes within one
   *  interval once unlocked; the coordinator also kicks an immediate
   *  catch-up tick on unlock. Absent → un-gated (legacy / tests). */
  isVaultUnlocked?: () => boolean;
}

export interface SchedulerHandle {
  start(): void;
  /** Stop the tick interval. Awaits every in-flight tick so callers can
   *  safely close the database afterward without racing a pending
   *  write. */
  stop(): Promise<void>;
  /** Stop the tick interval WITHOUT awaiting in-flight. Used by the
   *  Phase C drain orchestrator: the `pause_scheduler` step calls
   *  `pause()` synchronously, and the subsequent `await_inflight` step
   *  polls `inFlight()` until it returns false. Allows the drain
   *  pipeline's step timeouts to bound the total pause window. */
  pause(): void;
  /** True when a tick is currently in-flight. Phase C drain
   *  orchestrator reads this via `getInFlightCount`. */
  inFlight(): boolean;
  /** Run one tick synchronously. Useful for tests. Fires due schedules
   *  and returns the list of schedule_ids that fired. */
  tick(): Promise<string[]>;
}

/** Truncate a timestamp to the start of its minute. */
const startOfMinute = (ms: number): number => {
  const d = new Date(ms);
  d.setSeconds(0, 0);
  return d.getTime();
};

export const createScheduler = (config: SchedulerConfig): SchedulerHandle => {
  const now = config.now ?? (() => Date.now());
  const intervalMs = config.tickIntervalMs ?? 60_000;
  let handle: ReturnType<typeof setInterval> | null = null;
  /** Every interval-driven tick remains owned until it settles. Ticks may
   *  overlap so a slow schedule does not starve unrelated schedules; tracking
   *  only the newest promise lets a short later tick hide an older live one
   *  from shutdown. */
  const inFlightTicks = new Set<Promise<void>>();
  /** Schedule IDs currently being fired in any tick. Prevents an
   *  overlapping tick from re-firing the same schedule when its run is
   *  longer than `intervalMs` — without this, a schedule that takes
   *  2 minutes on a 1-minute tick would start firing again before the
   *  first execution finished. */
  const firingNow = new Set<string>();

  const reportBackgroundError = (message: string, error: unknown): void => {
    try {
      if (config.onBackgroundError) {
        config.onBackgroundError(message, error);
      } else {
        console.error(`[scheduler] ${message}`, error);
      }
    } catch {
      // A diagnostics hook must never promote a contained scheduler failure
      // back into the process-wide fatal `unhandledRejection` path.
    }
  };

  /** Compute the next firing timestamp for a cron expression after a
   *  given time. Returns null for malformed or never-firing crons. */
  const computeNext = (cron: string, fromMs: number): number | null => {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    return nextCronMatch(parts, fromMs + 60_000);
  };

  const isOneShot = (schedule: Schedule): boolean => schedule.mode === 'one_shot';

  const oneShotRunAt = (schedule: Schedule): number | null => {
    const runAt = schedule.run_at ?? schedule.next_run_at;
    return typeof runAt === 'number' && Number.isFinite(runAt) ? runAt : null;
  };

  /** Fire a schedule (regular tick or Smart Backfill catch-up).
   *
   *  `backfill` carries the diagnostic metadata when this fire is a
   *  catch-up — `trigger_source: 'backfill'` + missed_cycles. The
   *  handleExecute call path threads it through to the audit row so
   *  the consolidated audit UI can render the count + the prior
   *  last_run_at inline. */
  const fireSchedule = async (
    schedule: Schedule,
    fireAt: number,
    backfill?: BackfillMetadata,
  ): Promise<boolean> => {
    const oneShot = isOneShot(schedule);
    const nextRun = oneShot ? null : computeNext(schedule.cron_expression, fireAt);
    const visibleFailure = (failure: unknown): string => {
      const presented = presentAutomationFailure(failure);
      if (presented.redacted) {
        console.error(
          `[scheduler] schedule ${schedule.schedule_id} internal failure: ${presented.internalMessage}`,
        );
      }
      return presented.userMessage;
    };
    // D-215 § 5.2 — `terminalPatch` now covers only the outcomes a one-shot
    // SURVIVES: `error` (the owner needs the evidence and the re-fire
    // handle) and `skipped` (it never ran, so retiring would erase an
    // unfulfilled intent silently). Both are retained disabled and cleared
    // BY HAND — user content, same posture the eviction cascade already
    // takes for schedules. A successful one-shot retires instead (below).
    const terminalPatch = oneShot ? { enabled: false } : {};
    // D-121 Phase 6 — broadcast the fire signal once per schedule
    // tick. The execution lifecycle events (start / complete / error)
    // emit separately from execute-handler; viewers see schedule-fired
    // first, then the matching execution chain in cursor order.
    emitSchedule(config.executeDeps.eventBus, 'fired');
    // D-179 P2 — fire-time dish gate. A disabled (or vanished) standing
    // dish SKIPS the fire silently: the schedule stays armed and ticks
    // forward (`last_status: 'skipped'`), no failed-run noise. Lookup
    // is best-effort — an unwired dish store degrades to a dishless
    // dispatch via handleExecute's own resolution.
    if (schedule.dish_id !== undefined && config.executeDeps.dishStore) {
      const dish = config.executeDeps.dishStore.get(schedule.dish_id);
      if (!dish || !dish.enabled) {
        config.store.updateRun(schedule.schedule_id, {
          last_run_at: fireAt,
          next_run_at: nextRun,
          last_status: 'skipped',
          last_error: null,
          ...terminalPatch,
        });
        return true;
      }
    }
    try {
      // D-153 P2.C — pass typed `ExecutionSource` so the execute-handler's
      // policy gate evaluates this run against the
      // `(channel: 'schedule', actor: 'system')` matrix cell. Backfill
      // catch-ups still carry `trigger_source: 'backfill'` for
      // run-mode + audit attribution, but the policy gate uses
      // `'schedule'` channel uniformly (a catch-up is a delayed
      // scheduled fire, not a separate channel).
      const result = await (config.execute ?? handleExecute)(config.executeDeps, {
        recipe_id: schedule.recipe_id,
        trigger_source: backfill ? 'backfill' : 'schedule',
        execution_source: {
          channel: 'schedule',
          actor: 'system',
          cron: schedule.cron_expression,
          source_recipe: schedule.recipe_id,
          // ⛔ D-215 slice 1a — NO `contract_id` here, deliberately.
          //
          // D-209 §1.4 stamped `contract_id: OWNER_CONTRACT_ID` to reach the
          // `read` ceiling ("writes HOLD for review"). That stamp bought
          // nothing on either authority axis and broke dispatch outright:
          //
          //  - CEILING: identical either way. `resolveTrustCeiling` returns
          //    `CONTRACTED_DEFAULT_TRUST_CEILING` for a contracted source AND
          //    for a contract-free non-housekeeping `system` source — the
          //    `read` HOLD posture is reached by CHANNEL, not by contract.
          //  - GRANTS: identical. `gateGrantGoverningContractId` rejects the
          //    owner sentinel outright (`isReservedOwnerContractId` → the
          //    owner is DERIVED from provenance, never BOUND as a door id),
          //    so the stamp resolved to `undefined` — the same contract-free
          //    result as no stamp.
          //  - SNAPSHOT: the only real difference, and it is pure breakage.
          //    `executionSourceHasContract` is true for ANY `contract_id`, so
          //    `gateRecipeAgainstPolicy` THREW "requires a ContractSnapshot"
          //    on every fire; the catch below recorded `last_status: 'error'`
          //    and no scheduled recipe ran.
          //
          // A synthesized owner snapshot is NOT the fix: `allowed_tools` is a
          // closed allowlist (`admitContractToolAccess` denies anything off
          // it) with no wildcard, and there is no `contract_definition` to
          // resolve one from — the owner contract is derived, never minted.
          // `grant-governing-contract.ts` already documents the intended
          // posture: "(`(user, user_self)` HID, the system channels) →
          // `undefined` (contract-free)".
        },
        ...(backfill ? { backfill } : {}),
        // D-179 P2 — standing-dish dispatch: the dish overlay resolves
        // inside handleExecute (dish → install → defaults).
        ...(schedule.dish_id !== undefined ? { dish_id: schedule.dish_id } : {}),
      });
      // D-215 § 5.2 — a ONE-SHOT that SUCCEEDED has fulfilled its intent:
      // retire the row and dissolve the managed dish behind it. The run
      // record lives in audit, so the pending-intent row is noise, and
      // nothing else would ever clean it up (there is no reaper). This is
      // safe here specifically because `handleExecute` is AWAITED above —
      // the dish survives the whole run and only dissolves after it
      // resolves. Errors and skips deliberately do NOT retire (below).
      if (oneShot && result.success) {
        retireSchedule(
          {
            store: config.store,
            dishStore: config.executeDeps.dishStore,
            dishContextStore: config.executeDeps.dishContextStore,
          },
          schedule.schedule_id,
        );
        emitSchedule(config.executeDeps.eventBus, 'updated');
        return true;
      }
      // Runtime execution errors are carried in result.success/result.errors;
      // shape failures (bad_request / recipe_not_found) throw RpcError and
      // land in the catch block below.
      const lastError = result.success
        ? null
        : visibleFailure(
          (result.errors[0] as { message?: string } | undefined)?.message
            ?? 'execution failed',
        );
      config.store.updateRun(schedule.schedule_id, {
        last_run_at: fireAt,
        next_run_at: nextRun,
        last_status: result.success ? 'success' : 'error',
        last_error: lastError,
        ...terminalPatch,
      });
      return true;
    } catch (e) {
      config.store.updateRun(schedule.schedule_id, {
        last_run_at: fireAt,
        next_run_at: nextRun,
        last_status: 'error',
        last_error: visibleFailure(e),
        ...terminalPatch,
      });
      return true;
    }
  };

  const tick = async (): Promise<string[]> => {
    // Vault-locked gate: skip the whole tick (no fire, no clock advance)
    // while the vault is sealed. The interval keeps ticking and re-checks;
    // the coordinator kicks a catch-up tick on unlock.
    if (config.isVaultUnlocked && !config.isVaultUnlocked()) return [];

    const tickMinute = startOfMinute(now());
    const nowMs = now();
    const fired: string[] = [];

    const schedules = config.store.list();
    for (const listed of schedules) {
      // An overlapping tick may have completed this schedule since `list()`
      // produced its snapshot. Re-read immediately before the no-await
      // admission section so a stale snapshot cannot fire the same cron minute
      // after the newer tick releases `firingNow`.
      const schedule = config.store.get(listed.schedule_id);
      if (schedule === null) continue;
      if (!schedule.enabled) continue;

      if (isOneShot(schedule)) {
        if (schedule.last_run_at !== null) {
          config.store.updateRun(schedule.schedule_id, {
            enabled: false,
            next_run_at: null,
          });
          continue;
        }
        const runAt = oneShotRunAt(schedule);
        if (runAt === null) {
          config.store.updateRun(schedule.schedule_id, {
            enabled: false,
            next_run_at: null,
            last_status: 'error',
            last_error: 'one_shot schedule missing run_at',
          });
          continue;
        }
        if (runAt > nowMs) continue;
        if (firingNow.has(schedule.schedule_id)) continue;
        firingNow.add(schedule.schedule_id);
        try {
          await fireSchedule(schedule, runAt);
          fired.push(schedule.schedule_id);
        } finally {
          firingNow.delete(schedule.schedule_id);
        }
        continue;
      }

      const parts = schedule.cron_expression.trim().split(/\s+/);
      if (parts.length !== 5) continue; // malformed — skip silently

      // Overlap guard: skip any schedule whose previous execution
      // hasn't finished yet. Applies to both regular + catch-up
      // fires.
      if (firingNow.has(schedule.schedule_id)) continue;

      const matchesNow = cronMatchesAt(parts, new Date(tickMinute));

      if (matchesNow) {
        // Regular cycle path. Dedupe: if we already fired this minute,
        // skip — handles tick() called more than once per minute
        // (manual trigger, overlapping timers on clock drift). When
        // the cron matches, no Smart Backfill is ever needed: the
        // current minute is the catch-up.
        if (schedule.last_run_at !== null && startOfMinute(schedule.last_run_at) === tickMinute) continue;
        firingNow.add(schedule.schedule_id);
        try {
          await fireSchedule(schedule, tickMinute);
          fired.push(schedule.schedule_id);
        } finally {
          firingNow.delete(schedule.schedule_id);
        }
        continue;
      }

      // Smart Backfill (Phase 5): cron does NOT match this minute, but
      // the schedule may have missed cycles while the server was
      // offline. Fire one catch-up if (a) we missed at least one
      // cron-matched minute since last_run_at, and (b) the wait until
      // the next regular cycle is longer than BACKFILL_WINDOW_MIN.
      // No recipe lookup needed — backfill behaviour is system-wide,
      // not a per-recipe knob.
      if (!shouldCatchUp(schedule, nowMs)) continue;

      firingNow.add(schedule.schedule_id);
      try {
        const backfill = buildBackfillMetadata(schedule, nowMs);
        await fireSchedule(schedule, tickMinute, backfill);
        fired.push(schedule.schedule_id);
      } finally {
        firingNow.delete(schedule.schedule_id);
      }
    }

    return fired;
  };

  /** Run a tick and retain its promise so stop() can await all generations. */
  const trackedTick = async (): Promise<void> => {
    const p = (async () => { await tick(); })();
    inFlightTicks.add(p);
    try { await p; } finally {
      inFlightTicks.delete(p);
    }
  };

  /** Launch a scheduler-owned tick with a rejection handler attached in the
   *  same turn. `trackedTick` keeps shutdown ownership; this wrapper keeps a
   *  transient store/runtime failure out of the process-fatal rejection
   *  handler while preserving direct `tick()` rejection semantics. */
  const launchTrackedTick = (): void => {
    void trackedTick().catch((error) => {
      reportBackgroundError('background tick failed', error);
    });
  };

  return {
    start() {
      if (handle !== null) return;
      // Fire an immediate tick on start so any schedules due at boot
      // time don't wait a full minute.
      launchTrackedTick();
      handle = setInterval(launchTrackedTick, intervalMs);
    },
    async stop() {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
      // Snapshot after disarming the interval: no new scheduler-owned tick can
      // start, and every older generation must settle before the DB is closed.
      await Promise.allSettled([...inFlightTicks]);
    },
    pause() {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
      // Intentionally do NOT await in-flight ticks — the drain
      // pipeline's await_inflight step handles the wait under its
      // own timeout.
    },
    inFlight() {
      return inFlightTicks.size > 0;
    },
    tick,
  };
};
