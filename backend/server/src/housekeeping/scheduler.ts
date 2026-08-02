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
} from '@recued/contracts';

import type { HousekeepingConfigStore } from './config-store.js';
import type { EngineBusySignal } from './engine-busy-signal.js';
import type { HousekeepingContext, HousekeepingTaskInstance } from './registry.js';
import type { HousekeepingStateStore } from './state-store.js';
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

/** True when local-time hour falls inside `[start_hour, end_hour)`,
 *  honouring midnight crossings (e.g. start=22, end=5 → window
 *  spans 22:00 → 23:59 + 00:00 → 04:59). */
export const inCustomWindow = (
  now_ms: number,
  start_hour: number,
  end_hour: number,
): boolean => {
  const local = new Date(now_ms);
  const hour = local.getHours();
  if (start_hour === end_hour) return false;
  if (start_hour < end_hour) return hour >= start_hour && hour < end_hour;
  return hour >= start_hour || hour < end_hour;
};

interface GateInputs {
  preset: HousekeepingPreset;
  cycle_interval_minutes: number;
  custom_window_start_hour?: number;
  custom_window_end_hour?: number;
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
    if (!inCustomWindow(now, custom_window_start_hour, custom_window_end_hour)) {
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
 *    - Core (deterministic) tasks always run when idle. The trust
 *      gate is for enrichment producers; deterministic maintenance
 *      (audit-compaction, link-discovery, …) is unaffected.
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
  ctx: { ctx: HousekeepingContext; trustStore?: TrustStore; now: number },
): boolean => {
  if (task.meta.kind !== 'enrichment') return true;

  if (!ctx.trustStore) {
    return task.meta.idle_eligible !== false;
  }

  if (!task.topic) return false;

  const isAiSurface = task.is_ai_surface ?? false;
  const trust = ctx.trustStore.read(task.topic, isAiSurface);
  if (trust.trust_state !== 'auto') return false;

  if (isAiSurface && isAiPaused(ctx.ctx.db, ctx.now)) return false;
  return true;
};

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
  let lastCycleAt: number | null = null;

  const runTaskStep = async (
    task: HousekeepingTaskInstance,
    budget_ms: number,
  ): Promise<HousekeepingPerTaskResult> => {
    const id = task.meta.id;
    const start = opts.ctx.now();
    const persisted = opts.state.get(id);
    const cursor = persisted?.cursor ?? initialCursor();

    try {
      const result = await task.step(opts.ctx, cursor, budget_ms);
      const finish = opts.ctx.now();
      const duration_ms = finish - start;
      const status = result.status;

      opts.state.set({
        task_id: id,
        cursor: result.cursor,
        last_status: status === 'complete' ? 'complete' : 'pending',
        last_run_at: finish,
        last_run_duration_ms: duration_ms,
        ...(result.status === 'yield' ? { last_yield_reason: result.reason } : {}),
        consecutive_errors: 0,
      });
      return {
        task_id: id,
        status,
        duration_ms,
        ...(result.status === 'yield' ? { yield_reason: result.reason } : {}),
      };
    } catch (e) {
      const finish = opts.ctx.now();
      const duration_ms = finish - start;
      const message = e instanceof Error ? e.message : String(e);
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
    const tasks = only_task_id
      ? ordered.filter((t) => t.meta.id === only_task_id)
      : ordered.filter((t) =>
          isEligibleForIdleCycle(t, {
            ctx: opts.ctx,
            ...(opts.trustStore !== undefined ? { trustStore: opts.trustStore } : {}),
            now: cycle_start,
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

      const result = await runTaskStep(task, remaining);
      per_task.push(result);
    }

    const cycle_finish = opts.ctx.now();
    lastCycleAt = cycle_finish;

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
