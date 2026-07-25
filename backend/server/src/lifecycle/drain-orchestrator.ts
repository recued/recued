/** Drain orchestrator (Phase C).
 *
 *  Runs the fixed 10-step pipeline that takes a `running` server to a
 *  clean exit. Each step has its own per-step timeout; a timed-out
 *  step is recorded as aborted but the pipeline continues — every
 *  step is independently critical enough to attempt even if a prior
 *  step hung. Half-closed state is strictly worse than best-effort
 *  closed state.
 *
 *  Wiring model:
 *    - Four steps are orchestrator-internal (they touch lifecycle
 *      machinery directly): `flip_to_draining`, `stop_accepting_rpc`,
 *      `await_inflight`, `release_lock`.
 *    - Six steps are caller-wired via `DrainWiring.steps` because they
 *      depend on composition-root state (scheduler, ws-server, timers,
 *      cascade, audit log, DB). An unwired step is skipped silently —
 *      it doesn't appear in `completed_steps` or `aborted_steps`.
 *
 *  Concurrency:
 *    - `drain()` is idempotent. A second call while a drain is
 *      in-flight returns the same Promise (coalesce) — the `intent`
 *      and `reason` of the first call win; subsequent calls' values
 *      are logged but discarded.
 *    - State is always derived from the single orchestrator instance.
 *      There is no "abort a drain" — once started, it runs to
 *      completion or timeout.
 */

import {
  DRAIN_STEP_NAMES,
  type DrainIntent,
  type DrainState,
  type DrainStepName,
} from '@recued/contracts';
import type { LifecycleStateMachine } from './lifecycle-state.js';
import type { InstanceLock } from './instance-lock.js';

export type DrainLogger = (
  level: 'info' | 'warn' | 'error',
  msg: string,
  data?: Record<string, unknown>,
) => void;

/** A step function invoked by the orchestrator. Receives an
 *  `AbortSignal` that fires when the per-step timeout elapses; the
 *  step should observe it to wind down ASAP. Must never throw — catch
 *  internally and log. */
export type DrainStepFn = (signal: AbortSignal) => Promise<void>;

export interface DrainWiring {
  machine: LifecycleStateMachine;
  /** PID lock — released on the `release_lock` step. Optional so tests
   *  can run the orchestrator without a real lock. */
  lock?: InstanceLock;
  /** Live count of in-flight rpc calls + running scheduled ticks.
   *  Orchestrator polls until this hits 0 or the `await_inflight`
   *  step times out. Defaults to a stub returning 0 (nothing to
   *  wait for). */
  getInFlightCount?: () => number;
  /** Caller-wired step functions. An absent entry means the step is
   *  not applicable to this composition and is skipped silently. */
  steps?: Partial<Record<DrainStepName, DrainStepFn>>;
  /** Default drain timeout in ms (overridable per drain call). */
  defaultTimeoutMs?: number;
  /** Per-step timeout in ms. Orchestrator clamps each step's timeout
   *  to min(this, remainingDrainBudget). Defaults to 5s. */
  stepTimeoutMs?: number;
  /** Poll interval for `await_inflight` (ms). Defaults to 50. */
  inflightPollMs?: number;
  log?: DrainLogger;
  now?: () => number;
}

export interface DrainOptions {
  reason: string;
  intent: DrainIntent;
  /** Override `defaultTimeoutMs` for this call only. */
  timeoutMs?: number;
}

export interface DrainResult {
  intent: DrainIntent;
  reason: string;
  completed: DrainStepName[];
  aborted: DrainStepName[];
  /** Total wall-clock duration of the drain, from first step start
   *  to last step finish. */
  duration_ms: number;
}

export interface DrainOrchestrator {
  /** Live drain state. Observers (heartbeat emitter, getLifecycleState
   *  rpc) read this. Stable reference — the orchestrator mutates the
   *  same object across the drain. */
  readonly state: DrainState;
  /** Begin (or join) a drain. See file docstring for idempotency. */
  drain(opts: DrainOptions): Promise<DrainResult>;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_STEP_TIMEOUT_MS = 5_000;
const DEFAULT_INFLIGHT_POLL_MS = 50;

const noopLog: DrainLogger = () => { /* silence */ };

export const createDrainOrchestrator = (
  wiring: DrainWiring,
): DrainOrchestrator => {
  const log = wiring.log ?? noopLog;
  const now = wiring.now ?? (() => Date.now());
  const defaultTimeoutMs =
    wiring.defaultTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const stepTimeoutMs =
    wiring.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const inflightPollMs =
    wiring.inflightPollMs ?? DEFAULT_INFLIGHT_POLL_MS;
  const getInFlightCount = wiring.getInFlightCount ?? (() => 0);

  // Mutable state — the orchestrator exposes a stable reference to
  // this object so heartbeat reads see live progress.
  const state: DrainState = {
    active: false,
    completed_steps: [],
    aborted_steps: [],
  };

  let inFlight: Promise<DrainResult> | null = null;

  const orchestratorStep = (name: DrainStepName): DrainStepFn | undefined => {
    switch (name) {
      case 'flip_to_draining':
        return async () => {
          // Idempotent — state machine enforces running → draining.
          // If already draining (shouldn't happen — caller guarded),
          // the transition is a no-op.
          if (wiring.machine.state === 'running') {
            wiring.machine.transition('draining');
          }
        };

      case 'stop_accepting_rpc':
        // Pure signaling step. The ws-server dispatcher gate reads
        // `machine.state` directly — no separate flag needed. This
        // step exists as a pipeline anchor point for the audit log.
        return async () => {
          /* nothing to do — gate is already closed by the state flip */
        };

      case 'await_inflight':
        return async (signal) => {
          // Poll until in-flight reaches 0 or the signal fires.
          if (getInFlightCount() === 0) return;
          await new Promise<void>((resolve) => {
            const tick = () => {
              if (signal.aborted) {
                cleanup();
                resolve();
                return;
              }
              if (getInFlightCount() === 0) {
                cleanup();
                resolve();
                return;
              }
            };
            const timer = setInterval(tick, inflightPollMs);
            const cleanup = () => {
              clearInterval(timer);
              signal.removeEventListener('abort', onAbort);
            };
            const onAbort = () => { cleanup(); resolve(); };
            signal.addEventListener('abort', onAbort);
          });
        };

      case 'release_lock':
        return async () => {
          wiring.lock?.release();
        };

      default:
        return undefined;
    }
  };

  const effectiveStep = (name: DrainStepName): DrainStepFn | undefined =>
    orchestratorStep(name) ?? wiring.steps?.[name];

  const runStep = async (
    name: DrainStepName,
    fn: DrainStepFn,
    remainingMs: number,
  ): Promise<'completed' | 'aborted'> => {
    const budget = Math.max(50, Math.min(stepTimeoutMs, remainingMs));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;

    const timeout = new Promise<'aborted'>((resolve) => {
      timer = setTimeout(() => {
        aborted = true;
        controller.abort();
        resolve('aborted');
      }, budget);
    });

    try {
      const work: Promise<'completed'> = fn(controller.signal)
        .then(() => 'completed' as const)
        .catch((err) => {
          log('warn', `drain step ${name} threw`, { err: errShape(err) });
          return 'completed' as const;   // never rethrow from a step
        });
      const outcome = await Promise.race([work, timeout]);
      if (outcome === 'aborted') {
        log('warn', `drain step ${name} timed out after ${budget}ms`);
      }
      return aborted ? 'aborted' : outcome;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const execute = async (opts: DrainOptions): Promise<DrainResult> => {
    // Initialise observable state.
    const startedAt = now();
    state.active = true;
    state.started_at = startedAt;
    state.reason = opts.reason;
    state.intent = opts.intent;
    state.current_step = undefined;
    state.completed_steps.length = 0;
    state.aborted_steps.length = 0;

    const totalBudget = opts.timeoutMs ?? defaultTimeoutMs;
    const deadline = startedAt + totalBudget;

    log('info', 'drain started', {
      intent: opts.intent,
      reason: opts.reason,
      timeoutMs: totalBudget,
    });

    for (const name of DRAIN_STEP_NAMES) {
      const fn = effectiveStep(name);
      if (!fn) continue;            // unwired step — skip silently
      state.current_step = name;
      const remainingMs = Math.max(50, deadline - now());
      const outcome = await runStep(name, fn, remainingMs);
      if (outcome === 'completed') {
        state.completed_steps.push(name);
      } else {
        state.aborted_steps.push(name);
      }
    }

    const finishedAt = now();
    state.active = false;
    state.current_step = undefined;

    const result: DrainResult = {
      intent: opts.intent,
      reason: opts.reason,
      completed: [...state.completed_steps],
      aborted: [...state.aborted_steps],
      duration_ms: finishedAt - startedAt,
    };

    log('info', 'drain complete', {
      completed: result.completed.length,
      aborted: result.aborted.length,
      duration_ms: result.duration_ms,
    });

    return result;
  };

  return {
    state,
    drain(opts) {
      if (inFlight) {
        log('info', 'drain coalesced — already in-flight', {
          existing_intent: state.intent,
          new_intent: opts.intent,
          new_reason: opts.reason,
        });
        return inFlight;
      }
      inFlight = execute(opts).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
};

const errShape = (err: unknown): unknown => {
  if (err instanceof Error) {
    return { name: err.name, message: err.message };
  }
  return err;
};
