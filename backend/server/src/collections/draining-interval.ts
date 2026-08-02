/** A serial provider poll loop whose stop hook drains the active pass.
 *
 * Collection providers own their timers rather than using cmdServe's
 * background-service registry. Clearing a timer only prevents the next pass;
 * it does not cancel a promise already inside provider I/O or a warehouse
 * callback. This helper makes the provider stop contract honest: at most one
 * pass runs at a time, and stop resolves only after that pass settles. */

export type ProviderPollStop = () => Promise<void> | void;

export type ProviderPollScheduler = (
  tick: () => Promise<void>,
  intervalMs: number,
) => ProviderPollStop;

export interface StartDrainingIntervalOptions {
  readonly tick: () => Promise<void>;
  readonly intervalMs: number;
  readonly onError?: (error: unknown) => void;
  /** Start one pass during registration instead of waiting a full cadence. */
  readonly fireImmediate?: boolean;
}

export const startDrainingInterval = (
  options: StartDrainingIntervalOptions,
): (() => Promise<void>) => {
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;

  const reportError = (error: unknown): void => {
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
      work = Promise.resolve(options.tick());
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
    const active = inFlight;
    stopPromise = active ? active.then(() => undefined) : Promise.resolve();
    return stopPromise;
  };
};
