/** Vault-gated-executors coordinator — the resume half of the
 *  pause-while-locked / resume-on-unlock contract (R21.1).
 *
 *  Each autonomous executor (cron · auto-run · triggers · watches ·
 *  housekeeping) gates its OWN tick/dispatch on the live
 *  `isVaultUnlocked` predicate, so the PAUSE is automatic — a tick that
 *  fires while sealed is a no-op. This coordinator only owns the RESUME
 *  edge: on the `locked|uninitialized → unlocked` transition it kicks the
 *  executors that would otherwise stay dormant until something else
 *  happens to wake them.
 *
 *  Why a kick is needed per executor:
 *    - auto-run — its skipped tick does NOT re-arm the per-entry one-shot
 *      timers (re-arming on a past `next_run_at` would busy-loop), so the
 *      scheduler goes dormant. `tick()` fires the catch-up + re-arms every
 *      roster entry.
 *    - cron — the skipped tick advances nothing, and the next interval
 *      tick only fires schedules whose cron matches THAT minute. `tick()`
 *      gives an immediate same-minute catch-up (otherwise Smart Backfill
 *      eventually covers it, but a minute late).
 *    - watches — `recompute()` disarmed every loop while locked; `recompute()`
 *      re-derives demand + re-arms.
 *    - housekeeping — NOT kicked here: its `setInterval` probe keeps
 *      ticking and self-resumes within one probe interval (idle
 *      maintenance tolerates the ≤1-probe latency), and its live handle
 *      isn't threaded to this site (it lives in a module singleton).
 *    - triggers — NOT kicked: event-driven, naturally resumes on the next
 *      warehouse event (watch-driven triggers re-detect on the resumed
 *      poll).
 *    - answered approvals — the notification block's boot sweep may have run
 *      while a legacy/manual-unlock vault was still sealed. Re-running its
 *      idempotent recovery on unlock finishes those durable decisions instead
 *      of waiting for another (equally locked) boot.
 *
 *  Handle accessors (not the handles themselves) are injected so a
 *  maintenance-exit rebuild that swaps a scheduler handle is picked up
 *  transparently. */

import type { ServerAutoRunHandle } from './auto-run-scheduler.js';
import type { SchedulerHandle } from './scheduler.js';
import type { PollManagerHandle } from './watch/poll-manager.js';
import type { VaultStateBus } from './vault-state-bus.js';

export interface VaultGatedExecutorsDeps {
  vaultStateBus: VaultStateBus;
  /** Live auto-run handle accessor (`bundle.autoRun?.getHandle()`). */
  getAutoRunHandle: () => ServerAutoRunHandle | undefined;
  /** Live cron handle accessor (`bundle.cron?.getHandle()`). */
  getCronHandle: () => SchedulerHandle | undefined;
  /** Live watch poll-manager. Undefined on db-less boots. */
  watchManager: PollManagerHandle | undefined;
  /** Re-dispatch durable answered asks once decryption keys are available.
   * Optional on db-less / notification-less boots. */
  recoverPendingApprovals?: () => Promise<void>;
  /** Best-effort daemon log. */
  log?: (msg: string) => void;
}

export interface VaultGatedExecutorsHandle {
  /** Close unlock admission, unsubscribe, and drain admitted resume work. */
  dispose(): Promise<void>;
}

export const wireVaultGatedExecutors = (
  deps: VaultGatedExecutorsDeps,
): VaultGatedExecutorsHandle => {
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  let disposePromise: Promise<void> | undefined;

  const logInfo = (message: string): void => {
    try {
      deps.log?.(message);
    } catch {
      // Diagnostics must not interrupt the unlock fan-out.
    }
  };

  const reportResumeFailure = (label: string, error: unknown): void => {
    const message = `[vault-resume] ${label} failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    try {
      if (deps.log) deps.log(message);
      else console.warn(message);
    } catch {
      // A broken diagnostics sink must not recreate an unhandled rejection or
      // prevent sibling executors from receiving the unlock edge.
    }
  };

  const admit = (
    label: string,
    start: () => Promise<unknown> | undefined,
  ): void => {
    if (closed) return;
    let work: Promise<unknown> | undefined;
    try {
      work = start();
    } catch (error) {
      reportResumeFailure(label, error);
      return;
    }
    if (work === undefined) return;
    let tracked!: Promise<void>;
    tracked = Promise.resolve(work).then(
      () => undefined,
      (error) => reportResumeFailure(label, error),
    ).finally(() => {
      inFlight.delete(tracked);
    });
    inFlight.add(tracked);
  };

  const unsubscribe = deps.vaultStateBus.subscribe((next) => {
    if (closed || next !== 'unlocked') return;
    logInfo('vault unlocked — resuming autonomous executors');
    // auto-run: catch-up fire + re-arm every roster entry.
    admit('auto-run resume', () => deps.getAutoRunHandle()?.tick());
    // cron: immediate same-minute catch-up.
    admit('cron resume', () => deps.getCronHandle()?.tick());
    // The answer stays durable and a later unlock/boot retries on failure.
    admit('pending approval recovery', () => deps.recoverPendingApprovals?.());
    // watches: re-derive demand + re-arm the loops recompute() disarmed.
    try {
      deps.watchManager?.recompute();
    } catch (error) {
      reportResumeFailure('watch resume', error);
    }
  });

  return {
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      closed = true;
      unsubscribe();
      disposePromise = Promise.allSettled([...inFlight]).then(() => undefined);
      return disposePromise;
    },
  };
};
