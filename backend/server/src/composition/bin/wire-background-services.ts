/** Background-services registry for cmdServe.
 *
 *  Holds every long-lived lifecycle service that cmdServe spins up after boot, tagged with
 *  a `ServiceKind` so the three stop pathways can target the right subset:
 *
 *    - `'timer'`     — `setInterval`-based pruners + snapshot tickers (audit / s2s_preview /
 *                      correction_events / reception rate-limiter snapshot). Always built
 *                      through `registerInterval` so the helper enforces the
 *                      `setInterval + .unref?.() + (optional) fireImmediate` pattern. The
 *                      reception snapshot's `onStop` runs one final `snapshot()` after
 *                      `clearInterval` so the SQLite row reflects in-memory state at
 *                      shutdown.
 *    - `'scheduler'` — long-running schedulers with their own start/stop lifecycle
 *                      (cron / auto-run / housekeeping). Registered via `register({...})`
 *                      with an async `stop` closure that reads its underlying `let xHandle`
 *                      binding at call time so maintenance enter → exit re-creates pick up
 *                      cleanly.
 *    - `'emitter'`   — fire-and-forget emitters. Slot is preserved for future
 *                      emitter-shaped services; no live entries today (the cloud Go
 *                      heartbeat relay retired in D-148 P10 and the server-side emitter
 *                      retired alongside it — `last_seen_at` folds into the DDNS update
 *                      side-effect per § A.14).
 *
 *  Three stop pathways consume the registry:
 *
 *    1. `migrateDeps.onEnterMaintenance` — stops schedulers only so the migration runs
 *       against a quiet DB. The maintenance exit hook re-creates the cron + auto-run
 *       handles (housekeeping stays stopped until daemon restart per D-123 P7).
 *    2. `lifecycle.drainSteps.stop_timers` — stops timers + any emitter entries at
 *       shutdown. The lifecycle separately PAUSES the cron scheduler via
 *       `drainSteps.pause_scheduler` earlier in the drain; that path stays inline because
 *       `pause()` is a different operation from `stop()`.
 *    3. Fallback `shutdown()` (no-lifecycle path) — calls `stopAll()` once across every
 *       kind so timers, schedulers, and any future emitters all detach cleanly.
 *
 *  `stopAll()` invokes stops in REVERSE registration order, closing every matched service's
 *  admission before awaiting any one drain. Per-service failures are logged and collected,
 *  never allowed to block sibling teardown, then surfaced as an AggregateError so lifecycle
 *  and maintenance cannot report a partial quieting as complete. Filtering by `kind` is
 *  optional — omit the filter for the "everything" pathway. */

export type ServiceKind = 'timer' | 'scheduler' | 'emitter';

export interface StoppableService {
  /** Stable label surfaced in stopAll() error logs + the `list()` diagnostic. */
  readonly name: string;
  /** Categorisation surfaces in `stopAll({ kind })` / `list({ kind })`. */
  readonly kind: ServiceKind;
  /** Stop hook. May be sync or async; `stopAll()` awaits each. */
  readonly stop: () => Promise<void> | void;
}

export interface IntervalServiceSpec {
  /** Stable label for diagnostics. */
  readonly name: string;
  /** Tick interval in ms. Recomputed once at registration time — pass a value rather than a
   *  getter (callers that want runtime-tuned cadences resolve their `runtimeConfig.get` at the
   *  call site). */
  readonly intervalMs: number;
  /** Body called every `intervalMs`. Async work MUST be returned rather than detached: the
   *  registry tracks every returned promise and shutdown waits for all of them before the
   *  database is closed. Sync throws and async rejections are isolated + logged so one
   *  best-effort timer cannot crash the process. Overlapping ticks remain allowed; callers
   *  that require serialization keep their own admission guard. */
  readonly tick: () => Promise<void> | void;
  /** Fire `tick()` once synchronously at registration time. Mirrors the pre-extraction
   *  "fire once immediately so a restart sweeps without waiting a full interval" pattern. */
  readonly fireImmediate?: boolean;
  /** Post-stop side effect. Runs once after `clearInterval()` in `stopAll()`. Used by the
   *  reception rate-limiter snapshot timer to emit one final on-disk snapshot at shutdown
   *  so the SQLite row reflects the latest in-memory state. Errors are caught + logged
   *  via `console.warn` (mirrors the pre-extraction inline try/catch). */
  readonly onStop?: () => void;
}

export interface StopAllFilter {
  /** Restrict the operation to services of this kind. Absent → applies to every kind. */
  readonly kind?: ServiceKind;
}

export interface BackgroundServiceRegistry {
  /** Register a service that already exposes a stop hook. Pushes onto the registry in
   *  registration order; `stopAll()` walks in reverse. */
  register(service: StoppableService): void;
  /** Build + register an unref'd `setInterval`-based service (`kind: 'timer'`). Returns
   *  the stop closure for callers that want a local handle (e.g., to support a future
   *  per-service stop pathway). */
  registerInterval(spec: IntervalServiceSpec): () => Promise<void> | void;
  /** Stop every registered service matching the optional filter. Stop hooks are invoked in
   *  reverse registration order before any one hook is awaited. Every sibling is attempted;
   *  failures are logged and then surfaced as an AggregateError after all drains settle. */
  stopAll(filter?: StopAllFilter): Promise<void>;
  /** Names of registered services matching the optional filter, in registration order. */
  list(filter?: StopAllFilter): readonly string[];
}

export const createBackgroundServiceRegistry = (): BackgroundServiceRegistry => {
  const services: StoppableService[] = [];

  const register = (service: StoppableService): void => {
    services.push(service);
  };

  const registerInterval = (
    spec: IntervalServiceSpec,
  ): (() => Promise<void> | void) => {
    const inFlight = new Set<Promise<void>>();
    let stopped = false;
    let stopPromise: Promise<void> | undefined;

    const warn = (err: unknown): void => {
      console.warn(`[background-service] ${spec.name} tick failed`, err);
    };
    const runTick = (): void => {
      if (stopped) return;
      let outcome: Promise<void> | void;
      try {
        outcome = spec.tick();
      } catch (err) {
        warn(err);
        return;
      }
      if (!outcome) return;

      let tracked: Promise<void>;
      tracked = Promise.resolve(outcome)
        .catch(warn)
        .finally(() => {
          inFlight.delete(tracked);
        });
      inFlight.add(tracked);
    };

    const timer = setInterval(runTick, spec.intervalMs);
    // `.unref?.()` so the timer doesn't hold the event loop open at shutdown. The optional
    // chaining covers timer-shim edge cases (some test runners stub `setInterval` without
    // the `.unref` method).
    timer.unref?.();
    const finishStop = (): void => {
      if (spec.onStop) {
        try {
          spec.onStop();
        } catch (err) {
          console.warn(`[background-service] ${spec.name} onStop failed`, err);
        }
      }
    };
    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      if (stopped) return Promise.resolve();
      stopped = true;
      clearInterval(timer);
      const active = [...inFlight];
      if (active.length === 0) {
        // Preserve the historical synchronous onStop behaviour when there is
        // no async tick to drain (the returned resolved promise is still
        // awaitable by lifecycle callers).
        finishStop();
        stopPromise = Promise.resolve();
      } else {
        stopPromise = Promise.allSettled(active).then(finishStop);
      }
      return stopPromise;
    };
    services.push({ name: spec.name, kind: 'timer', stop });
    if (spec.fireImmediate) {
      runTick();
    }
    return stop;
  };

  const matches = (svc: StoppableService, filter?: StopAllFilter): boolean =>
    !filter?.kind || svc.kind === filter.kind;

  const stopAll = async (filter?: StopAllFilter): Promise<void> => {
    const matched = services.filter((svc) => matches(svc, filter)).reverse();
    const stops = matched.map((svc) => {
      try {
        return Promise.resolve(svc.stop()).catch((err) => {
          console.warn(`[background-service] ${svc.name} stop failed`, err);
          throw err;
        });
      } catch (err) {
        console.warn(`[background-service] ${svc.name} stop failed`, err);
        return Promise.reject(err);
      }
    });
    const results = await Promise.allSettled(stops);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        'one or more background services failed to stop',
      );
    }
  };

  const list = (filter?: StopAllFilter): readonly string[] =>
    services.filter((svc) => matches(svc, filter)).map((s) => s.name);

  return { register, registerInterval, stopAll, list };
};
