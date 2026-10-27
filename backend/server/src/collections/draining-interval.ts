/** A serial provider poll loop whose stop hook drains the active pass.
 *
 * Collection providers own their timers rather than using cmdServe's
 * background-service registry. Clearing a timer only prevents the next pass;
 * it does not cancel a promise already inside provider I/O or a warehouse
 * callback. This helper makes the provider stop contract honest: at most one
 * pass runs at a time, and stop closes admission, aborts the active pass
 * through the `AbortSignal` each pass is given, and resolves once that pass
 * settles — or after `STOP_GRACE_MS`, whichever comes first.
 *
 * Why stop does not wait longer: a pass is many sequential HTTP calls of up to
 * 30 s each, and the drain step that stops it has 5 s; the process exits right
 * after the drain anyway. Giving up the wait is safe because every provider
 * pass checks the signal before it moves its cursor (`stop-signal.ts`), so a
 * pass still unwinding past the grace can no longer record anything as read —
 * the next start replays its range. */

import { settleWithin, STOP_GRACE_MS } from '../lifecycle/settle-within.js';
import { CollectionStoppedError } from './stop-signal.js';

export type ProviderPollStop = () => Promise<void> | void;

/** One pass of a provider's poll loop. `signal` aborts when the loop stops; it
 *  is optional because test schedulers call the pass bare, and a provider then
 *  falls back to its own connection's signal. */
export type ProviderPollTick = (signal?: AbortSignal) => Promise<void>;

export type ProviderPollScheduler = (
  tick: ProviderPollTick,
  intervalMs: number,
) => ProviderPollStop;

export interface StartDrainingIntervalOptions {
  readonly tick: (signal: AbortSignal) => Promise<void>;
  readonly intervalMs: number;
  readonly onError?: (error: unknown) => void;
  /** Start one pass during registration instead of waiting a full cadence. */
  readonly fireImmediate?: boolean;
  /** How long stop waits for the aborted pass. Defaults to `STOP_GRACE_MS`. */
  readonly stopGraceMs?: number;
}

export const startDrainingInterval = (
  options: StartDrainingIntervalOptions,
): (() => Promise<void>) => {
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;
  // One controller for the loop's life: every pass gets its signal, and stop
  // aborts it, so whichever pass is running when the loop stops sees it.
  const controller = new AbortController();

  const reportError = (error: unknown): void => {
    // A pass that unwinds because stop aborted it has not failed.
    if (controller.signal.aborted) return;
    try {
      options.onError?.(error);
    } catch {
      // A diagnostics hook must not turn a contained poll failure into an
      // unhandled rejection.
    }
  };

  const runTick = (): void => {
    if (stopped || inFlight) return;
    let work: Promise<void>;
    try {
      work = Promise.resolve(options.tick(controller.signal));
    } catch (error) {
      reportError(error);
      return;
    }

    let tracked: Promise<void>;
    tracked = work
      .catch(reportError)
      .finally(() => {
        if (inFlight === tracked) inFlight = null;
      });
    inFlight = tracked;
  };

  const timer = setInterval(runTick, options.intervalMs);
  timer.unref?.();
  if (options.fireImmediate) runTick();

  return (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopped = true;
    clearInterval(timer);
    controller.abort(new CollectionStoppedError('the provider poll loop was stopped'));
    const active = inFlight;
    stopPromise = active
      ? settleWithin(active, options.stopGraceMs ?? STOP_GRACE_MS).then(() => undefined)
      : Promise.resolve();
    return stopPromise;
  };
};
