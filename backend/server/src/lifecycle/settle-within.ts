/** Wait for `work` to settle, but never longer than `ms`.
 *
 *  ⛔ FOR A `stop()` / `dispose()` THAT A DRAIN STEP AWAITS. Each drain step has
 *  5 s (`DEFAULT_STEP_TIMEOUT_MS`), and a step that runs out is "aborted", which
 *  makes an update refuse to swap versions — while the process exits right after
 *  the drain anyway, so the work being waited on dies regardless. On 2026-10-26
 *  an AI app's MCP stream did that to two updates in a row. A stop therefore
 *  closes its admission, aborts its in-flight outbound work (AbortController,
 *  socket destroy, `terminate()`), and waits for local cleanup through this, with
 *  a grace well inside the step's budget (`STOP_GRACE_MS`).
 *
 *  Resolves `'settled'` when the work settled (fulfilled OR rejected — a stop
 *  that failed has still stopped waiting) and `'timed_out'` when the grace ran
 *  out first. The timer is unref'd, so it never holds the process open. */
export const settleWithin = (
  work: Promise<unknown>,
  ms: number,
): Promise<'settled' | 'timed_out'> =>
  new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve('timed_out');
    }, ms);
    timer.unref?.();
    work.then(
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve('settled');
      },
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve('settled');
      },
    );
  });

/** The grace a stop gives its in-flight work after aborting it: long enough for
 *  an aborted request or a destroyed socket to unwind, short enough that every
 *  stop a drain step runs in parallel still finishes inside the step's 5 s. */
export const STOP_GRACE_MS = 1_000;

/** The grace for a notice push already claimed when the stop came. A claimed
 *  push is never tried again — the alert stores and the mail-chat door's
 *  notices attempt each one at most once, even across restarts — so it gets
 *  the longest wait that still leaves a 5 s drain step room. A channel that
 *  answers at all finishes inside it; one still silent after it is cut by the
 *  exit after the drain, which past the step's 5 s would cut it anyway. */
export const PUSH_GRACE_MS = 3_000;

/** What `work` settles with, except that once `stop` has fired it settles no
 *  later than `ms` after, with `released`.
 *
 *  For a tick that a timer waits on inside the same drain step as the stop that
 *  ends it: `registerInterval`'s stop waits for the ticks it started, and the
 *  service's own stop runs beside it in `stop_timers`, so a tick that ended only
 *  when its work did held the step for as long as a send took. The wait ends;
 *  the work itself goes on. */
export const releasedAtStop = <T>(
  work: Promise<T>,
  stop: AbortSignal,
  released: T,
  ms: number = STOP_GRACE_MS,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const release = (): void => {
      void settleWithin(work, ms).then(() => resolve(released));
    };
    if (stop.aborted) release();
    else stop.addEventListener('abort', release, { once: true });
    work.then(
      (value) => { stop.removeEventListener('abort', release); resolve(value); },
      (error: unknown) => { stop.removeEventListener('abort', release); reject(error); },
    );
  });
