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
  /** Unsubscribe from the state bus (shutdown). */
  dispose(): void;
}

export const wireVaultGatedExecutors = (
  deps: VaultGatedExecutorsDeps,
): VaultGatedExecutorsHandle => {
  const unsubscribe = deps.vaultStateBus.subscribe((next) => {
    if (next !== 'unlocked') return;
    deps.log?.('vault unlocked — resuming autonomous executors');
    // auto-run: catch-up fire + re-arm every roster entry.
    void deps
      .getAutoRunHandle()
      ?.tick()
      .catch(() => {
        // A resume-kick failure is logged-and-forgotten; the next natural
        // tick (or a later transition) retries. Never throw out of the
        // bus callback — it runs inside KeyManager.transition().
      });
    // cron: immediate same-minute catch-up.
    void deps
      .getCronHandle()
      ?.tick()
      .catch(() => {});
    void deps.recoverPendingApprovals?.().catch(() => {
      // The answer stays durable and a later unlock/boot retries. Never throw
      // out of KeyManager.transition().
    });
    // watches: re-derive demand + re-arm the loops recompute() disarmed.
    deps.watchManager?.recompute();
  });

  return { dispose: unsubscribe };
};
