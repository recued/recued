/** D-123 Phase 2 — Housekeeping scheduler loop.
 *
 *  Per-server interval-driven scheduler. Wakes every
 *  `HOUSEKEEPING_IDLE_PROBE_MS` (60s) to evaluate the idle gate;
 *  when the gate opens, runs one cycle through the topo-sorted
 *  registry. Per-task cursors persist via `HousekeepingStateStore`.
 *  Errors increment `consecutive_errors`; 3 in a row flip the task
 *  to `last_status: 'error'` (skipped on subsequent cycles until
 *  reset, invalidated, or `HOUSEKEEPING_AUTO_RETRY_AFTER_MS`
 *  elapses).
 *
 *  Per the spec the scheduler is server-internal only — never
 *  reaches the WS rpc surface as data, never replicates. The
 *  rpc surface in P5 reads/writes the config row + per-task
 *  status row, but the scheduler instance itself stays here.
 *
 *  Spec: D-123 §2.2 + §2.3 + §2.4. */

import { isMinuteWithinWindow, localMinuteOfDay } from '@recued/contracts';
import {
  HOUSEKEEPING_AGGRESSIVE_IDLE_THRESHOLD_MS,
  HOUSEKEEPING_AUTO_RETRY_AFTER_MS,
  HOUSEKEEPING_DISABLE_AFTER_FAILURES,
  HOUSEKEEPING_IDLE_PROBE_MS,
  HOUSEKEEPING_MIN_TASK_BUDGET_MS,
  type HousekeepingCursor,
  type HousekeepingCycleResult,
  type HousekeepingPerTaskResult,
  type HousekeepingPreset,
  type TokenUsageReport,
} from '@recued/contracts';

import type { HousekeepingConfigStore } from './config-store.js';
import type { EngineBusySignal } from './engine-busy-signal.js';
import type { HousekeepingContext, HousekeepingTaskInstance } from './registry.js';
import type { HousekeepingStateStore } from './state-store.js';
import type { AiPathAvailability } from './ai-availability.js';
import { isPoolUnsatisfiable } from './pool-unsatisfiable.js';
import { isAiPaused, type TrustStore } from './trust-store.js';

// ────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────

export interface HousekeepingScheduler {
  /** Arm the probe loop. No-op when current preset is `'off'`. */
  start(): void;
  /** Clear the probe loop + await any in-flight cycle. Resolves
   *  once the DB is safe to close. */
  stop(): Promise<void>;
  /** Force one synchronous cycle. Honours config budget but
   *  bypasses the idle gate — the Settings UI's *Run now* button
   *  + tests use this entry point. Defaults to one task only when
   *  `task_id` provided; otherwise a full topo-sorted sweep. */
  runOnce(opts?: { budget_ms?: number; task_id?: string }): Promise<HousekeepingCycleResult>;
}

export interface CreateHousekeepingSchedulerOptions {
  /** D-269 — the server's declared IANA zone, for the `custom` preset's
   *  window. Absent ⇒ host-local, the pre-D-269 behaviour. */
  serverTimeZone?: () => string | undefined;
  ctx: HousekeepingContext;
  config: HousekeepingConfigStore;
  state: HousekeepingStateStore;
  busy: EngineBusySignal;
  /** Topo-sorted task registry. Read on each cycle so installs /
   *  uninstalls take effect on the next probe tick. */
  registry: () => ReadonlyArray<HousekeepingTaskInstance>;
  /** D-132 P2 — per-topic trust + pool-policy store. Drives the idle-
   *  cycle eligibility filter (replaces the static
   *  `meta.idle_eligible !== false` derivation D-123 shipped with).
   *  Optional so the scheduler still functions without D-132 wiring;
   *  when absent, the legacy `meta.idle_eligible` filter is used and
   *  the trust gate is short-circuited. Production wires it via
   *  `bin.ts`. */
  trustStore?: TrustStore;
  /** D-262 follow-on — "is any AI path usable right now", consulted ONCE per
   *  idle cycle and only when an AI-surface task is in the running.
   *
   *  ⛔⛔ WITHOUT IT AN AI PRODUCER WALKS EVERY ROW TO LEARN WHAT ONE PROBE
   *  KNOWS. `AI_LLM_UNAVAILABLE` at an unforced layer is a RECOVERABLE PER-ROW
   *  failure by D-136 P6 — right for a transient miss, wrong as the way to
   *  discover the owner has no key: the row's attempt count climbs and at five
   *  it is `permanently_failed` with no auto-retry, so fixing the key does not
   *  revive it.
   *
   *  ⚠ The reachable case is narrow and worth stating, because the obvious one
   *  is NOT reachable: an AI topic can never be idle-eligible out of the box —
   *  `isEligibleForIdleCycle` demands `trust_state: 'auto'` and
   *  `assertEnrichmentTrustDefaults` THROWS at boot if an AI-surface topic
   *  declares that as its default (measured 2026-09-07: 0 of 12 do). So this
   *  guards the owner who promoted a topic to auto — which follows successful
   *  manual runs — and whose key was later rotated, revoked or emptied.
   *
   *  ⚠ MUST read the same config the EXECUTOR does, or the gate disagrees with
   *  itself: admitting work the executor cannot serve, or refusing work it
   *  could. Both now resolve live (`resolveLlmConfig`). Optional so a scheduler
   *  wired without it behaves exactly as before. */
  probeAiPath?: () => Promise<AiPathAvailability>;
  /** D-138 P3 — listener fired at the START of each cycle (probe-tick
   *  + Run-Now both route through). Used by the contact-merge cycle
   *  observer to begin its buffer window — A.10 plausibility
   *  correlates link removes + adds inside one cycle. Best-effort:
   *  exceptions are swallowed so a misbehaving listener can't fail a
   *  cycle. */
  onCycleStart?: () => void;
  /** Listener fired after each cycle completes. Used by P5 to fan
   *  the `housekeeping_cycle` realtime event out to paired clients,
   *  and by D-138 P3 to flush the contact-merge cycle observer +
   *  fire any A.10 prompts that the cycle window made plausible. */
  onCycleComplete?: (result: HousekeepingCycleResult) => void;
  /** Test seam — replaces `setInterval` with a deterministic timer
   *  driver. Returns a token consumed by `clearTimer`. */
  setTimer?: (fn: () => void, delay_ms: number) => unknown;
  clearTimer?: (token: unknown) => void;
  /** Vault-unlocked gate. When provided and `false`, the idle probe is a
   *  no-op — autonomous maintenance must not run while the vault is
   *  sealed. The `setInterval` probe keeps ticking and re-checks, so
   *  cycles self-resume within one probe interval once unlocked. The
   *  explicit `runOnce` (Settings → Run now) is NOT gated — a user's
   *  deliberate action; vault-needing tasks self-fail at the connection
   *  adapter, vault-free tasks (drift / dedup) still run. Absent →
   *  un-gated (legacy / tests). */
  isVaultUnlocked?: () => boolean;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** True when the owner's local hour falls inside `[start_hour, end_hour)`,
 *  honouring midnight crossings (e.g. start=22, end=5 → 22:00 → 04:59).
 *
 *  ⛔⛔ D-269 — `timeZone` ABSENT MEANS THE HOST'S CLOCK, WHICH IS WHAT THIS
 *  ALWAYS DID AND WHY IT WAS WRONG. The owner sets *"do background work between
 *  22:00 and 05:00"* in Settings → Housekeeping, and nothing in the contract
 *  ever said whose 22:00 — so it was the datacenter's on a VPS. Milder than the
 *  cron defect (it delays work rather than misfiring it) but the same silent
 *  assumption, and the same fix: the zone the OWNER declared for this server.
 *
 *  ⚠ AND THE CROSS-MIDNIGHT RULE IS NO LONGER RE-IMPLEMENTED HERE. This file and
 *  quiet hours independently arrived at the same predicate — including the
 *  `start === end → false` choice, on the same reasoning that reading an empty
 *  window as "all day" lets one mis-set field silence everything. Independent
 *  convergence is reassuring about the rule and a warning about the
 *  duplication: **the next person to fix one would not have known about the
 *  other.** It now calls the one in contracts. */
export const inCustomWindow = (
  now_ms: number,
  start_hour: number,
  end_hour: number,
  timeZone?: string,
): boolean => {
  const minute = timeZone === undefined
    ? new Date(now_ms).getHours() * 60 + new Date(now_ms).getMinutes()
    : localMinuteOfDay(now_ms, timeZone);
  // ⚠ Hours in, minutes compared — the shared predicate speaks minutes because
  // quiet hours needs them. Converting here keeps the housekeeping setting's
  // own vocabulary (whole hours) while sharing the rule.
  return isMinuteWithinWindow(minute, start_hour * 60, end_hour * 60);
};

interface GateInputs {
  preset: HousekeepingPreset;
  cycle_interval_minutes: number;
  custom_window_start_hour?: number;
  custom_window_end_hour?: number;
  /** D-269 — the zone the custom window's hours are read in. Absent ⇒
   *  host-local, the pre-D-269 behaviour. */
  time_zone?: string;
  last_run_at: number | null;
  now: number;
  busy: EngineBusySignal;
}

/** True iff the scheduler should fire a cycle now. Returns false
 *  when preset === 'off' (caller should also short-circuit
 *  before constructing the scheduler in that case, but defence in
 *  depth is cheap). */
export const shouldFireCycle = ({
  preset,
  cycle_interval_minutes,
  custom_window_start_hour,
  custom_window_end_hour,
  last_run_at,
  now,
  busy,
  time_zone,
}: GateInputs): boolean => {
  if (preset === 'off') return false;
  if (busy.isBusy()) return false;

  if (preset === 'aggressive') {
    const transition = busy.lastIdleTransitionAt();
    if (transition === null) return last_run_at === null;
    return now - transition >= HOUSEKEEPING_AGGRESSIVE_IDLE_THRESHOLD_MS;
  }

  if (preset === 'custom') {
    if (custom_window_start_hour === undefined || custom_window_end_hour === undefined) {
      return false;
    }
    if (!inCustomWindow(
      now, custom_window_start_hour, custom_window_end_hour, time_zone,
    )) {
      return false;
    }
  }

  if (last_run_at === null) return true;
  const interval_ms = cycle_interval_minutes * 60_000;
  return now - last_run_at >= interval_ms;
};

/** A task is currently disabled iff its consecutive_errors has hit
 *  the threshold AND the auto-retry window hasn't elapsed yet. */
const isTaskDisabled = (
  state: ReturnType<HousekeepingStateStore['get']>,
  now: number,
): boolean => {
  if (!state || state.last_status !== 'error') return false;
  if (state.consecutive_errors < HOUSEKEEPING_DISABLE_AFTER_FAILURES) return false;
  const last = state.last_run_at;
  if (last == null) return true;
  return now - last < HOUSEKEEPING_AUTO_RETRY_AFTER_MS;
};

/** D-132 P2 — runtime eligibility check for an idle cycle. Replaces
 *  the static `meta.idle_eligible !== false` filter D-123 used.
 *
 *  Semantics, in order of precedence:
 *    - Core tasks run when idle UNLESS they opt out with
 *      `meta.idle_eligible: false`. The trust gate is for enrichment
 *      producers; deterministic maintenance (audit-compaction,
 *      link-discovery, …) is unaffected because it never opts out.
 *      ⛔ THE OPT-OUT USED TO BE IGNORED HERE. This branch returned a
 *      bare `true`, so `meta.idle_eligible: false` — whose own contract
 *      says *"the scheduler's idle-cycle path skips this task; it can
 *      only fire via the Run now rpc"* — did nothing on a core task. It
 *      was latent (no core task set it) right up until one wanted to:
 *      `memory-embed-backlog` spends embedding tokens and must never
 *      fire without the owner asking. A core task that costs money is
 *      exactly the case the field was written for, and the gate that
 *      replaced the old static filter dropped it on the floor.
 *    - Without a trust store wired (older harness wiring + tests not
 *      threading P2 substrate), fall back to `meta.idle_eligible`. The
 *      enrichment-producer harness now stamps `idle_eligible:
 *      undefined`, so this fallback also runs producers as eligible.
 *      Production always wires a trust store via `bin.ts`.
 *    - Enrichment task without a stamped topic is structurally invalid
 *      (post-D-132-P2 harness output). Skip it defensively.
 *    - Trust state `'auto'` runs; `'off'` / `'manual'` skip.
 *    - AI-surface producers honour the global pause-AI window —
 *      `pause_background_ai_until > now` blocks the fire. Deterministic
 *      producers ignore the pause window (they have no AI cost). */
export const isEligibleForIdleCycle = (
  task: HousekeepingTaskInstance,
  ctx: {
    ctx: HousekeepingContext;
    trustStore?: TrustStore;
    now: number;
    /** Probed once per cycle by the caller, never per task — the config cannot
     *  change mid-cycle and one probe answers for every AI producer. */
    aiPath?: AiPathAvailability;
  },
): boolean => {
  if (task.meta.kind !== 'enrichment') return task.meta.idle_eligible !== false;

  if (!ctx.trustStore) {
    return task.meta.idle_eligible !== false;
  }

  if (!task.topic) return false;

  const isAiSurface = task.is_ai_surface ?? false;
  const trust = ctx.trustStore.read(task.topic, isAiSurface);
  if (trust.trust_state !== 'auto') return false;

  if (isAiSurface && isAiPaused(ctx.ctx.db, ctx.now)) return false;

  // ⛔ D-262 follow-on — no usable AI path means SKIP, not "walk the rows and
  // find out". Both reasons skip, and they are deliberately not collapsed:
  // `quota_exhausted` clears itself at the daily boundary, while
  // `no_byok_no_freepool` needs the owner. The distinction is what the
  // Housekeeping status surface renders, and it is why this takes the probe's
  // result rather than a boolean.
  if (isAiSurface && ctx.aiPath !== undefined && !ctx.aiPath.available) return false;
  return true;
};

/** Is this a "no LLM source matched the required pool" failure?
 *
 *  ⚠ Matched on the `LLMError` CODE, never on the message. `AI_LLM_UNAVAILABLE`
 *  is raised by the match resolver when the requirements — including a forced
 *  `free` / `byok` layer — cannot be met by any configured source. It means the
 *  substrate is unavailable, not that the task is broken.
 *
 *  ⚠ Structural check rather than `instanceof LLMError`: the error crosses a
 *  package boundary (`@recued/llm`), and an `instanceof` that silently stops
 *  matching after a bundling change would restore the auto-disable bug with
 *  nothing failing. */
/** ⇒ `isPoolUnsatisfiable` now lives in `./pool-unsatisfiable.js`, SHARED with
 *  the enrichment producer. It was a private copy here, and widening only this
 *  end left the producer's per-record catch punishing every row for the same
 *  condition — see that module's header for what that cost. */

const initialCursor = (): HousekeepingCursor => ({ kind: 'complete' });

// ────────────────────────────────────────────────────────────────
// Scheduler factory
// ────────────────────────────────────────────────────────────────

export const createHousekeepingScheduler = (
  opts: CreateHousekeepingSchedulerOptions,
): HousekeepingScheduler => {
  const setTimer = opts.setTimer ?? ((fn, delay_ms) => {
    const t = setInterval(fn, delay_ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  });
  const clearTimer = opts.clearTimer ?? ((t) => clearInterval(t as NodeJS.Timeout));

  let timerToken: unknown = null;
  let cycleTail: Promise<void> = Promise.resolve();
  let queuedCycles = 0;
  // R13 T1-Q1 — seeded from the persisted clock so a restart honours
  // cycle_interval_minutes instead of reading as "never cycled" and
  // firing on the first idle probe.
  let lastCycleAt: number | null = opts.state.getCycleClock();

  const runTaskStep = async (
    task: HousekeepingTaskInstance,
    budget_ms: number,
  ): Promise<HousekeepingPerTaskResult> => {
    const id = task.meta.id;
    const start = opts.ctx.now();
    const persisted = opts.state.get(id);
    const cursor = persisted?.cursor ?? initialCursor();

    // D-250 § D — open this task's token window HERE rather than around the call
    // in the cycle loop, so every exit path (complete / yield / pool-unsatisfiable
    // / error) can record what it spent alongside its duration. ⛔ A task that
    // THREW still burned the tokens; billing them to nobody would understate the
    // cost of exactly the tasks worth investigating.
    const meter = opts.ctx.taskTokenMeter;
    meter?.begin(id);
    // ⛔ TAKE ONCE AND CARRY THE REPORT — never reconstruct one. The state row
    // wants a scalar and the audit row wants the full breakdown; deriving the
    // scalar from the report keeps them the same measurement, where rebuilding a
    // report around the scalar would stamp `input_tokens: 0` on the audit row and
    // call it data.
    const takeTokens = (): TokenUsageReport | undefined => meter?.take(id);

    try {
      const result = await task.step(opts.ctx, cursor, budget_ms);
      const finish = opts.ctx.now();
      const duration_ms = finish - start;
      const status = result.status;
      const tokens = takeTokens();

      opts.state.set({
        task_id: id,
        cursor: result.cursor,
        last_status: status === 'complete' ? 'complete' : 'pending',
        last_run_at: finish,
        last_run_duration_ms: duration_ms,
        ...(tokens !== undefined ? { last_run_tokens: tokens.total_tokens } : {}),
        ...(result.status === 'yield' ? { last_yield_reason: result.reason } : {}),
        consecutive_errors: 0,
      });
      return {
        task_id: id,
        status,
        duration_ms,
        ...(tokens !== undefined ? { tokens } : {}),
        ...(result.status === 'yield' ? { yield_reason: result.reason } : {}),
        ...(result.governor ? { governor: result.governor } : {}),
      };
    } catch (e) {
      const finish = opts.ctx.now();
      const duration_ms = finish - start;
      const message = e instanceof Error ? e.message : String(e);

      // ⛔ AN UNSATISFIABLE POOL IS A YIELD, NOT A FAILURE — and this is the
      // chokepoint where that has to be decided, because it is where
      // `consecutive_errors` is incremented.
      //
      // `enrichment-producer.ts` already gets this right for producers riding
      // its PER-RECORD harness: it catches `AI_LLM_UNAVAILABLE`, turns it into
      // a soft yield, and its comment states why — "so the task isn't credited
      // with a `consecutive_errors` bump (which would auto-disable after 3
      // failures)".
      //
      // OWN-WALK AI producers do not ride that harness. `ai-producer-wrapper.ts`
      // lists them — `lifecycle_stage_inferred*`, `topic_cluster`, `company`,
      // `role` — and its contract says it THROWS when "LLM call propagates its
      // own `LLMError`". Nothing between there and here translated it, so the
      // protection existed on exactly one of the two producer paths.
      //
      // The consequence is not cosmetic: a server whose pool policy cannot be
      // satisfied (`free_only` with an empty free pool, or BYOK disallowed for
      // background work) auto-DISABLES those producers after three idle cycles,
      // permanently, while the equivalent per-record producers yield and stay
      // enabled. The owner would have to notice and re-enable by hand.
      //
      // Found by the long-horizon harness, which drove a real idle cycle and
      // reported two producers ERRORED where ten others gated off cleanly:
      //   ⛔ ERRORED enrichment.lifecycle_stage_inferred
      //      No LLM source matches requirements (speed: fast, json, forceLayer: free)
      //
      // ⚠ THE CODE IS THE DISCRIMINATOR, never the message text. `LLMError`
      // carries `AI_LLM_UNAVAILABLE` for exactly this condition; matching on the
      // rendered string would break the moment the message is reworded, and
      // would catch unrelated errors that happen to mention a model.
      if (isPoolUnsatisfiable(e)) {
        opts.state.set({
          task_id: id,
          cursor,                      // unchanged — the step made no progress
          last_status: 'pending',
          last_run_at: finish,
          last_run_duration_ms: duration_ms,
          // ⚠ `pool_policy_unsatisfiable` ALREADY EXISTS in
          // `HousekeepingYieldReason`, which is the strongest evidence this was
          // an oversight rather than a design choice: the contract has a member
          // for exactly this condition and one of the two producer paths never
          // emitted it.
          last_yield_reason: 'pool_policy_unsatisfiable',
          consecutive_errors: 0,
        });
        return {
          task_id: id,
          status: 'yield',
          duration_ms,
          yield_reason: 'pool_policy_unsatisfiable',
        };
      }

      opts.state.recordError(id, message, finish);
      return { task_id: id, status: 'error', duration_ms };
    }
  };

  const runCycleInner = async (
    budget_ms: number,
    only_task_id?: string,
  ): Promise<HousekeepingCycleResult> => {
    const config = opts.config.read();
    const cycle_start = opts.ctx.now();
    if (opts.onCycleStart) {
      try { opts.onCycleStart(); } catch { /* best-effort */ }
    }
    const ordered = opts.registry();
    // Run-Now path (only_task_id set) bypasses the idle-eligibility
    // filter — the user has explicitly confirmed the task fire,
    // including AI spend if the producer is non-deterministic. Idle
    // cycles run `isEligibleForIdleCycle` (D-132 P2) which resolves
    // per-topic trust state + global pause-AI window so AI calls only
    // happen on user-trusted producers.
    // D-262 follow-on — one AI-path probe per cycle, and only when it can
    // change the answer: never on the Run-Now path (the owner has explicitly
    // confirmed the spend), and never when no AI-surface task is registered.
    //
    // ⛔ FAILS OPEN. A probe that throws must not silently disable every AI
    // producer — that would be a safety default the owner cannot see, reach or
    // explain, which is a worse failure than the per-row one this prevents.
    // Undefined means "unknown", and the gate treats unknown as permitted.
    let aiPath: AiPathAvailability | undefined;
    if (
      only_task_id === undefined
      && opts.probeAiPath !== undefined
      && ordered.some((t) => t.is_ai_surface === true)
    ) {
      try {
        aiPath = await opts.probeAiPath();
      } catch {
        aiPath = undefined;
      }
    }
    const tasks = only_task_id
      ? ordered.filter((t) => t.meta.id === only_task_id)
      : ordered.filter((t) =>
          isEligibleForIdleCycle(t, {
            ctx: opts.ctx,
            ...(opts.trustStore !== undefined ? { trustStore: opts.trustStore } : {}),
            now: cycle_start,
            ...(aiPath !== undefined ? { aiPath } : {}),
          }),
        );

    const per_task: HousekeepingPerTaskResult[] = [];
    for (const task of tasks) {
      const elapsed = opts.ctx.now() - cycle_start;
      const remaining = budget_ms - elapsed;
      if (remaining < HOUSEKEEPING_MIN_TASK_BUDGET_MS) break;

      const persisted = opts.state.get(task.meta.id);
      if (isTaskDisabled(persisted, opts.ctx.now())) continue;

      // Honour depends_on — skip until upstream completes in this
      // run (or had been completed in a prior cycle).
      const deps = task.meta.depends_on ?? [];
      const upstreamComplete = deps.every((dep) => {
        const local = per_task.find((p) => p.task_id === dep);
        if (local) return local.status === 'complete';
        const stored = opts.state.get(dep);
        return stored?.last_status === 'complete';
      });
      if (!upstreamComplete) continue;

      // D-250 § D — the token window now opens INSIDE `runTaskStep`, so every
      // exit path (including the error and pool-unsatisfiable ones) records what
      // it spent. The result already carries `tokens` when there was any.
      const result = await runTaskStep(task, remaining);
      per_task.push(result);
    }

    const cycle_finish = opts.ctx.now();
    lastCycleAt = cycle_finish;
    // R13 T1-Q1 — persist the cycle clock. Best-effort: a failed clock
    // write must not fail the cycle it describes; the cost of a lost
    // write is one early cycle after the next restart, not corruption.
    try { opts.state.setCycleClock(cycle_finish); } catch { /* best-effort */ }

    const cycle: HousekeepingCycleResult = {
      preset: config.preset,
      duration_ms: cycle_finish - cycle_start,
      tasks_stepped: per_task.length,
      tasks_complete: per_task.filter((p) => p.status === 'complete').length,
      tasks_yielded: per_task.filter((p) => p.status === 'yield').length,
      tasks_errored: per_task.filter((p) => p.status === 'error').length,
      per_task,
    };

    // D-123 P7 — per-cycle audit row. `event_at = ts` for system-
    // emitted events per the D-120 P7.5 bistemporal stamping rule
    // (no underlying real-world event time); `run_mode: 'live'`
    // reflects active maintenance, not catch-up. Best-effort —
    // emission errors don't fail the cycle.
    try {
      opts.ctx.emitAuditRow({
        ts: cycle_finish,
        event_at: cycle_finish,
        action: 'housekeeping_cycle',
        target: 'system',
        run_mode: 'live',
        detail: {
          preset: cycle.preset,
          duration_ms: cycle.duration_ms,
          tasks_stepped: cycle.tasks_stepped,
          tasks_complete: cycle.tasks_complete,
          tasks_yielded: cycle.tasks_yielded,
          tasks_errored: cycle.tasks_errored,
          per_task: cycle.per_task,
        },
      });
    } catch { /* best-effort */ }

    if (opts.onCycleComplete) {
      try { opts.onCycleComplete(cycle); } catch { /* best-effort */ }
    }
    return cycle;
  };

  const enqueueCycle = (
    budgetMs: number,
    onlyTaskId?: string,
  ): Promise<HousekeepingCycleResult> => {
    queuedCycles += 1;
    const result = cycleTail.then(() => runCycleInner(budgetMs, onlyTaskId));
    const tracked = result.finally(() => { queuedCycles -= 1; });
    // Keep the queue live after a failed cycle while preserving that rejection
    // for the caller that requested the individual pass.
    cycleTail = tracked.then(() => undefined, () => undefined);
    return tracked;
  };

  const probeTick = (): void => {
    if (queuedCycles > 0) return;
    try {
      // Vault-locked gate: skip autonomous idle cycles while sealed. The
      // probe interval keeps ticking and re-checks, so cycles self-resume
      // within one probe once unlocked. `runOnce` deliberately bypasses
      // this — it's a user's explicit Run-now.
      if (opts.isVaultUnlocked && !opts.isVaultUnlocked()) return;
      const config = opts.config.read();
      const now = opts.ctx.now();
      opts.busy.poll(now);
      const fire = shouldFireCycle({
        preset: config.preset,
        cycle_interval_minutes: config.cycle_interval_minutes,
        ...(config.custom_window_start_hour !== undefined
          ? { custom_window_start_hour: config.custom_window_start_hour }
          : {}),
        ...(config.custom_window_end_hour !== undefined
          ? { custom_window_end_hour: config.custom_window_end_hour }
          : {}),
        last_run_at: lastCycleAt,
        now,
        busy: opts.busy,
        // D-269 — the owner's declared zone, so "between 22:00 and 05:00" means
        // their 22:00 and not the datacenter's. Read PER TICK: under
        // `follows_host` the answer is the host clock.
        ...((): { time_zone?: string } => {
          const tz = opts.serverTimeZone?.();
          return tz !== undefined && tz.length > 0 ? { time_zone: tz } : {};
        })(),
      });
      if (!fire) return;
      void enqueueCycle(config.cycle_budget_ms).catch((err) => {
        console.warn('[housekeeping] idle cycle failed', err);
      });
    } catch (err) {
      // A malformed live config or busy-signal implementation must not escape
      // the interval callback as an uncaught exception.
      console.warn('[housekeeping] idle probe failed', err);
    }
  };

  return {
    start() {
      if (timerToken !== null) return;
      const config = opts.config.read();
      if (config.preset === 'off') return;
      timerToken = setTimer(probeTick, HOUSEKEEPING_IDLE_PROBE_MS);
    },
    async stop() {
      if (timerToken !== null) {
        clearTimer(timerToken);
        timerToken = null;
      }
      const admittedCycles = cycleTail;
      await admittedCycles;
    },
    async runOnce(callerOpts) {
      const config = opts.config.read();
      const budget = callerOpts?.budget_ms ?? config.cycle_budget_ms;
      return enqueueCycle(budget, callerOpts?.task_id);
    },
  };
};
