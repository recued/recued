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

import {
  CIRCUIT_BREAKER_THRESHOLD,
  deriveRunYield,
  runYieldIsTotalRefusal,
} from '@recued/contracts';
import { cronZoneFor } from '@recued/contracts';
import type { Schedule } from '@recued/scheduler';
import {
  cronMatchesAt,
  nextCronMatch,
  countMissedCycles,
  resolveMissedAction,
  buildMissedRunReport,
  buildBackfillMetadata,
  type BackfillMetadata,
  type MissedRunReport,
} from '@recued/scheduler';
import { handleExecute, type ExecuteHandlerDeps } from './execute-handler.js';
import type { ScheduleStore } from './schedule-store.js';
import { retireSchedule } from './schedule-retire.js';
import { emitSchedule } from './events/emit-sites.js';
import { buildPackOpResolution, missingPackDependencies } from './pack-inventory.js';
import { presentAutomationFailure } from './automation-failure.js';
import type { NotificationMessage } from '@recued/notification';
import {
  decideAutomationFailure,
  type AutomationUnitRef,
} from './automation-failure-reporter.js';

export interface SchedulerConfig {
  store: ScheduleStore;
  executeDeps: ExecuteHandlerDeps;
  /** D-269 — the server's declared IANA zone, for schedules that carry none.
   *
   *  ⛔ WITHOUT IT A CRON FIRES IN THE HOST'S ZONE. `cronMatchesAt` used to read
   *  `Date#getHours()`, so `0 9 * * *` meant 9am wherever the process ran — a
   *  Hong Kong owner on a Virginia VPS got their 07:00 brief at 19:00.
   *
   *  ⚠ A THUNK, read per tick: under `follows_host` the answer is the host
   *  clock, and the scheduler outlives any single reading of it. Absent ⇒
   *  host-local, which is the pre-D-269 behaviour. */
  serverTimeZone?: () => string | undefined;
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
  /** D-266 — called once per tick with the freshly recomputed set of
   *  misses waiting on an owner who chose `missed_policy: 'ask'`.
   *
   *  The scheduler stays ignorant of asks: it hands over a REPORT and the
   *  implementation decides whether to raise, leave, or cancel. Absent ⇒
   *  `Ask me` schedules simply wait for the Automation card, which is the
   *  behaviour before this seam existed.
   *
   *  ⚠ CALLED ON EVERY TICK, INCLUDING WITH AN EMPTY REPORT. The empty
   *  call is not a no-op to the consumer — it is how an ask raised for
   *  misses that have since resolved THEMSELVES (the next regular cycle
   *  fired) gets cancelled. Skipping the call when there is nothing to
   *  report would strand exactly those asks. */
  onMissedRuns?: (report: MissedRunReport) => void | Promise<void>;
  /** D-268 — called with a notice whenever a failed fire earns one (the first
   *  failure of an episode, and the disarm). Absent ⇒ failures are recorded on
   *  the row exactly as before and nothing reaches the owner.
   *
   *  🔑 THE SAME POSTURE AS `onMissedRuns` ABOVE, FOR THE SAME REASON: the
   *  scheduler hands over a REPORT and stays ignorant of the notification block.
   *  A slow or dead owner channel must not be able to delay a tick, so the
   *  consumer owns delivery and this returns void.
   *
   *  ⚠ The DISARM is not delegated — the scheduler owns the store, so it writes
   *  `enabled: false` itself. Only the telling is handed out. */
  onAutomationFailure?: (notice: NotificationMessage, unit: AutomationUnitRef) => void;
  /** D-268 — how many consecutive failures disarm a schedule whose failure
   *  class earns the wait. Injectable for tests; production passes
   *  `CIRCUIT_BREAKER_THRESHOLD`. */
  failureThreshold?: number;
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
  /** Per-tick memo of the installed-pack resolution (the fire-time pack gate).
   *  Rebuilt on every tick — an install or uninstall between ticks must be seen,
   *  and a memo that outlived the tick would gate on a stale inventory. */
  let packResolutionMemo: ReturnType<typeof buildPackOpResolution> | null = null;
  const packResolutionForTick = (): ReturnType<typeof buildPackOpResolution> => {
    packResolutionMemo ??= buildPackOpResolution(
      () => config.executeDeps.contractScan!('installed_pack', []),
      (slug) => config.executeDeps.executorConfig.manifests.get(slug),
    );
    return packResolutionMemo;
  };

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
  const computeNext = (
    cron: string,
    fromMs: number,
    schedule: Pick<Schedule, 'time_zone'>,
  ): number | null => {
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const declared = config.serverTimeZone?.();
    // ⚠ `cronZoneFor` names the default in ONE place. Four sites resolve a
    // schedule's zone, and if any of them defaulted differently the schedule
    // would fire at one hour and be counted missed at another.
    // ⛔ Empty-safe: `cronZoneFor(row, '')` would yield `''`, and `Intl` throws
    // a RangeError on `timeZone: ''` — a tick would die rather than fall back.
    const resolved = declared !== undefined && declared.length > 0
      ? cronZoneFor(schedule, declared)
      : schedule.time_zone;
    const zone = typeof resolved === 'string' && resolved.length > 0 ? resolved : undefined;
    return nextCronMatch(parts, fromMs + 60_000, undefined, zone);
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
    const nextRun = oneShot ? null : computeNext(schedule.cron_expression, fireAt, schedule);
    const visibleFailure = (failure: unknown): string => {
      const presented = presentAutomationFailure(failure);
      if (presented.redacted) {
        console.error(
          `[scheduler] schedule ${schedule.schedule_id} internal failure: ${presented.internalMessage}`,
        );
      }
      return presented.userMessage;
    };
    // D-268 — the failure patch a failed fire adds to its `updateRun`, plus the
    // one notice it may owe. Both failure sites below (the result path and the
    // catch) go through this, so the episode counter and the disarm cannot
    // disagree about the same run.
    //
    // ⛔ NEVER CALLED FOR A HOLD OR A SKIP. `awaiting_approval` reports
    // `success: false` with an EMPTY `errors` array, and the long note further
    // down records what treating that as an error already cost once: a one-shot
    // was set `enabled: false` while its ask sat unanswered. A `skipped` status
    // is the D-266 missed-run path and the dish gate, neither of which failed.
    const failurePatch = (
      reason: string,
      code: string | undefined,
      total_refusal: boolean,
    ): { consecutive_failures: number; enabled?: false } => {
      const unit: AutomationUnitRef = {
        kind: 'schedule',
        id: schedule.schedule_id,
        recipe_id: schedule.recipe_id,
      };
      const report = decideAutomationFailure({
        unit,
        code,
        total_refusal,
        reason,
        prior_consecutive_failures: schedule.consecutive_failures ?? 0,
        threshold: config.failureThreshold ?? CIRCUIT_BREAKER_THRESHOLD,
      });
      // A `conditional` code is the recipe deciding not to act and being right
      // to. It leaves the counter alone — it is not an episode and never was.
      if (report.not_a_failure) return { consecutive_failures: schedule.consecutive_failures ?? 0 };
      if (report.notice) {
        try {
          config.onAutomationFailure?.(report.notice, unit);
        } catch (err) {
          // Telling the owner is best-effort by construction; a broken consumer
          // must not turn a recorded failure into a failed tick.
          config.onBackgroundError?.('[scheduler] automation failure notice', err);
        }
      }
      return {
        consecutive_failures: report.consecutive_failures,
        ...(report.disarm ? { enabled: false as const } : {}),
      };
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
    // D-179 P2 / D-319 — fire-time dish gate. A dish switched off (or gone)
    // SKIPS the fire silently: the schedule ticks forward (`last_status:
    // 'skipped'`), no failed-run noise. The dish switch also writes the
    // schedule's own `enabled`, so this is the backstop. Lookup is
    // best-effort — an unwired dish store degrades to a dishless dispatch
    // via handleExecute's own resolution.
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
    // Fire-time PACK gate. A recipe whose declared pack is no longer installed
    // cannot lower: `lowerSequentialStep` throws `CanonicalOpResolutionError`
    // for "a two-tier id that resolves to nothing" BEFORE step 1. Dispatching
    // anyway turns an uninstall into a cron that fails every firing, forever —
    // and nobody is watching a schedule at 03:00, so a loud error there is
    // functionally silent.
    //
    // ⚠ SKIPPED, NOT ERROR, AND STILL ARMED. Nothing was attempted, so this is
    // not a failed run; and runnability is recoverable BY DESIGN — "uninstalling
    // a provider NEVER deletes a recipe, it only MOVES the recipe's
    // runnability". Reinstalling the pack must bring the schedule back on its
    // own, which retiring or disabling it here would prevent.
    //
    // ⚠ But NOT silent either. `last_error` names the missing packs, because the
    // dish gate's silent skip is right for a state the user chose and wrong for
    // one they did not: an uninstall elsewhere is exactly the case where the
    // owner does not know this schedule stopped.
    if (config.executeDeps.contractScan !== undefined) {
      const recipe = config.executeDeps.recipeStore.get(schedule.recipe_id);
      if (recipe !== null) {
        // ⚠ Resolved through a per-TICK memo, not per fire. `buildPackOpResolution`
        // scans the whole installed_pack inventory and resolves a manifest per
        // ingredient id; doing that once per firing schedule would repeat the
        // same scan N times in a minute for N due schedules, to reach the same
        // answer. The inventory cannot change mid-tick, so one scan is enough —
        // the runnability read hoists it for the same reason.
        const missing = missingPackDependencies(recipe, packResolutionForTick());
        if (missing.length > 0) {
          config.store.updateRun(schedule.schedule_id, {
            last_run_at: fireAt,
            next_run_at: nextRun,
            last_status: 'skipped',
            last_error: `pack not installed: ${missing.join(', ')} — reinstall to resume this schedule`,
            ...terminalPatch,
          });
          return true;
        }
      }
    }
    try {
      config.store.noteQualifyingOccurrence?.(schedule.schedule_id, `due:${fireAt}`);
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
        // D-179 P2 / D-319 — the schedule fires as its dish, with its
        // settings (resolved inside handleExecute).
        ...(schedule.dish_id !== undefined ? { dish_id: schedule.dish_id } : {}),
      });
      // D-215 § 5.2 — a ONE-SHOT that SUCCEEDED has fulfilled its intent:
      // retire the row. The run record lives in audit, so the pending-intent
      // row is noise, and nothing else would ever clean it up (there is no
      // reaper). Its dish stays (D-319: a schedule owns no dish). Errors and
      // skips deliberately do NOT retire (below).
      if (oneShot && result.success) {
        retireSchedule({ store: config.store }, schedule.schedule_id);
        emitSchedule(config.executeDeps.eventBus, 'updated');
        return true;
      }
      // ⛔⛔ A DURABLE PAUSE IS NOT AN ERROR, AND CALLING IT ONE DISABLED THE
      // SCHEDULE. The engine reports a preflight hold as `success: false` with
      // an EMPTY `errors` array, so deciding on `!success` alone recorded
      // `last_status: 'error'` with the generic "execution failed" — and for a
      // ONE-SHOT, `terminalPatch` then set `enabled: false`. The owner would
      // answer the ask, the run would resume and complete, and the schedule
      // would sit permanently marked as a failed run that never happened: the
      // resume path does not come back through here to correct it.
      //
      // ⚠ REUSING `'skipped'` RATHER THAN MINTING A STATUS, DELIBERATELY.
      // `last_status` is a WIRE type (`rpc/server-registry.ts`), read by a
      // webclient that is versioned separately from a self-hosted server, so a
      // new member is a compatibility decision and not one to take in passing.
      // `'skipped'` already means "did not conclude, stays armed, no
      // failed-run noise", which preserves the two properties that matter here.
      // A dedicated `awaiting_approval` status would say it better and is worth
      // doing WITH the wire change, not around it.
      const heldForAnswer = result.awaiting_approval === true
        || result.awaiting_peer === true;
      // Runtime execution errors are carried in result.success/result.errors;
      // shape failures (bad_request / recipe_not_found) throw RpcError and
      // land in the catch block below.
      const lastError = result.success || heldForAnswer
        ? null
        : visibleFailure(
          (result.errors[0] as { message?: string } | undefined)?.message
            ?? 'execution failed',
        );
      // D-268 — a run can report `success: true` and still have produced
      // nothing: a `foreach` is continue-on-error by design, so a step whose
      // every item was refused leaves the run green. `runYieldIsTotalRefusal`
      // is D-237's predicate for exactly that, and until now its only consumers
      // were the D-214 case compiler — nothing notified and nothing stopped.
      // ⛔ It must not rewrite the status: the run DID complete, and D-237's own
      // rule is that what is false is the inference that it produced anything.
      const totalRefusal = result.success
        && runYieldIsTotalRefusal(deriveRunYield(result.steps));
      const failed = !result.success && !heldForAnswer;
      const failurePart = failed || totalRefusal
        ? failurePatch(
          lastError ?? 'This run attempted items and every one was refused.',
          failed
            ? (result.errors[0] as { code?: string } | undefined)?.code
            : undefined,
          totalRefusal && !failed,
        )
        : { consecutive_failures: 0 };
      config.store.updateRun(schedule.schedule_id, {
        last_run_at: fireAt,
        next_run_at: nextRun,
        last_status: result.success ? 'success' : heldForAnswer ? 'skipped' : 'error',
        last_error: lastError,
        // ⛔ A HOLD LEAVES THE COUNTER ALONE. `heldForAnswer` is neither a
        // failure nor a success — resetting it would launder an ongoing episode
        // every time an approval came up mid-outage.
        ...(heldForAnswer ? {} : failurePart),
        // A held one-shot must stay ENABLED: it has not run yet, and disabling
        // it here is what made the approval unanswerable in practice.
        ...(heldForAnswer ? {} : terminalPatch),
      });
      return true;
    } catch (e) {
      const reason = visibleFailure(e);
      // A throw here is a shape failure (`bad_request` / `recipe_not_found`) or
      // an RpcError — it carries a `code` when it is one of ours and nothing
      // when it is a raw Error, which classifies as unclassified and stops at
      // the first failure. That is the fail-closed direction on purpose.
      const code = (e as { code?: unknown } | null)?.code;
      config.store.updateRun(schedule.schedule_id, {
        last_run_at: fireAt,
        next_run_at: nextRun,
        last_status: 'error',
        last_error: reason,
        ...failurePatch(reason, typeof code === 'string' ? code : undefined, false),
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

    // Drop the previous tick's inventory memo — an install or uninstall since
    // then must be visible to this tick's pack gate.
    packResolutionMemo = null;

    const tickMinute = startOfMinute(now());
    const nowMs = now();
    const fired: string[] = [];
    if (config.executeDeps.preapprovalDriver) {
      fired.push(...await config.executeDeps.preapprovalDriver.tickSchedules(nowMs));
    }

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
        if (config.store.wasPreapprovalOccurrenceConsumed?.(schedule.schedule_id, `due:${runAt}`)) continue;
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
        if (config.store.wasPreapprovalOccurrenceConsumed?.(schedule.schedule_id, `due:${tickMinute}`)) continue;
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

      // Smart Backfill (Phase 5) + D-266: cron does NOT match this
      // minute, but the schedule may have missed cycles while the
      // server was off. `resolveMissedAction` is the ONE place the
      // owner's `missed_policy` meets the two measures that already
      // ship — next-occurrence proximity (`shouldCatchUp`) and
      // staleness (`countMissedCycles`). No recipe lookup: the policy
      // rides the SCHEDULE, because the owner who wrote it is the one
      // who knows whether a late run is worth having.
      const missedAction = resolveMissedAction(schedule, nowMs);
      if (missedAction === 'none') continue;

      // D-266 `Ask me` — decide NOTHING. The row is left exactly as it
      // is so the miss stays outstanding and keeps appearing in
      // `buildMissedRunReport` until the owner answers; that report is
      // recomputed from these rows, never stored, so there is no ask
      // to expire and nothing here to keep in step with it.
      if (missedAction === 'ask') continue;

      // D-266 `Skip it`, and the stale half of `Decide for me`.
      //
      // ⛔ DO NOT WRITE `last_run_at` HERE — IT WOULD CLAIM A RUN THAT
      // NEVER HAPPENED. Every missed-cycle count is measured forward
      // from `last_run_at`, so stamping a skip erases the evidence of
      // the outage in one write: the card shows nothing, the audit row
      // shows a run, and the schedule reads as current. Leaving the
      // timestamps alone costs nothing — the next regular cron match
      // fires normally and advances them honestly.
      //
      // ⚠ The ORIGINAL reason recorded here was narrower and is now
      // obsolete: that the roll into `prev_run_at` would poison an
      // observed-cadence sample. Counting cron occurrences does not
      // sample anything, but the rule survives its own rationale.
      if (missedAction === 'skip') {
        if (schedule.last_status !== 'skipped') {
          const missed = countMissedCycles(schedule, nowMs);
          config.store.updateRun(schedule.schedule_id, {
            last_status: 'skipped',
            last_error: missed === 'unknown'
              ? 'Missed run skipped — waiting for the next regular cycle.'
              : `Missed ${missed + 1} run${missed === 0 ? '' : 's'} — skipped, `
                + 'waiting for the next regular cycle.',
          });
        }
        continue;
      }

      firingNow.add(schedule.schedule_id);
      try {
        const backfill = buildBackfillMetadata(schedule, nowMs);
        await fireSchedule(schedule, tickMinute, backfill);
        fired.push(schedule.schedule_id);
      } finally {
        firingNow.delete(schedule.schedule_id);
      }
    }

    // D-266 — hand over what is still waiting on the owner, re-derived
    // from the store AFTER the loop so the report reflects everything
    // this tick just wrote (a catch-up that fired, a stale miss recorded
    // skipped). Best-effort: a notification failure must never fail the
    // tick that fires schedules.
    if (config.onMissedRuns) {
      try {
        await config.onMissedRuns(buildMissedRunReport(config.store.list(), nowMs));
      } catch (error) {
        reportBackgroundError('missed-run projection failed', error);
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
