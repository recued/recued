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
 *  `stopAll()` walks in REVERSE registration order so a service registered after its
 *  dependency stops before that dependency. Per-service failures are caught + logged via
 *  `console.warn` so a broken stop can't block the rest. Filtering by `kind` is optional —
 *  omit the filter for the "everything" pathway. */

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
  /** Body called every `intervalMs`. Errors should be swallowed by the closure itself —
   *  a tick that throws WILL bubble to `setInterval`'s default error handler and be
   *  unhandled. Mirroring the pre-extraction pattern, every existing tick wraps its work in a
   *  try/catch. */
  readonly tick: () => void;
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
  registerInterval(spec: IntervalServiceSpec): () => void;
  /** Stop every registered service matching the optional filter, in reverse registration
   *  order. Best-effort — per-service failures are caught + logged via `console.warn` so
   *  one broken stop can't block the rest. Returns once every awaited stop has resolved. */
  stopAll(filter?: StopAllFilter): Promise<void>;
  /** Names of registered services matching the optional filter, in registration order. */
  list(filter?: StopAllFilter): readonly string[];
}

export const createBackgroundServiceRegistry = (): BackgroundServiceRegistry => {
  const services: StoppableService[] = [];

  const register = (service: StoppableService): void => {
    services.push(service);
  };

  const registerInterval = (spec: IntervalServiceSpec): (() => void) => {
    const timer = setInterval(spec.tick, spec.intervalMs);
    // `.unref?.()` so the timer doesn't hold the event loop open at shutdown. The optional
    // chaining covers timer-shim edge cases (some test runners stub `setInterval` without
    // the `.unref` method).
    timer.unref?.();
    const stop = (): void => {
      clearInterval(timer);
      if (spec.onStop) {
        try {
          spec.onStop();
        } catch (err) {
          console.warn(`[background-service] ${spec.name} onStop failed`, err);
        }
      }
    };
    services.push({ name: spec.name, kind: 'timer', stop });
    if (spec.fireImmediate) {
      spec.tick();
    }
    return stop;
  };

  const matches = (svc: StoppableService, filter?: StopAllFilter): boolean =>
    !filter?.kind || svc.kind === filter.kind;

  const stopAll = async (filter?: StopAllFilter): Promise<void> => {
    // Reverse-order stop so a service registered after its dependency stops before its
    // dependency. Mirrors the dispose-stack convention used elsewhere in the codebase.
    for (let i = services.length - 1; i >= 0; i--) {
      const svc = services[i]!;
      if (!matches(svc, filter)) continue;
      try {
        await svc.stop();
      } catch (err) {
        console.warn(`[background-service] ${svc.name} stop failed`, err);
      }
    }
  };

  const list = (filter?: StopAllFilter): readonly string[] =>
    services.filter((svc) => matches(svc, filter)).map((s) => s.name);

  return { register, registerInterval, stopAll, list };
};
