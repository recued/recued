/** D-234 § 234.4m — registering the deadline sweep.
 *
 *  Thin by design: the whole decision is `isPeerAskExpired`, and the whole action
 *  is record → close → resume in `sweepExpiredPeerAsks`. This file only decides
 *  WHEN, and answers two questions the sweeper itself cannot.
 *
 *  `fireImmediate` is required now that the outbox also enumerates recorded
 *  answers whose continuation was interrupted. This composer runs after live
 *  execute deps are published, so startup can safely finish those answers
 *  without waiting a minute for the first interval.
 *
 *  ⛔ NOT REENTRANT. A tick resumes runs, and a run takes as long as it takes;
 *  a second pass entering while the first is mid-resume would find rows the first
 *  pass has not closed yet and resume the same hold twice. `record` would catch
 *  the duplicate, but relying on the store to catch what an admission guard
 *  should is how the guard stops being added at all.
 */
import {
  abandonOrphanedPeerHolds,
  type PeerHoldAbandonDeps,
} from '../../peer-hold-abandoner.js';
import {
  PEER_ASK_TIMEOUT_SWEEP_INTERVAL_MS,
  sweepExpiredPeerAsks,
  type PeerAskTimeoutSweepDeps,
} from '../../peer-ask-timeout-sweeper.js';
import type { PeerAskDeliveryRecoveryResult } from '../../peer-ask-delivery-recovery.js';

export interface PeerAskTimeoutWiringDeps {
  readonly registry: {
    registerInterval: (spec: {
      name: string;
      intervalMs: number;
      tick: () => Promise<void> | void;
      fireImmediate?: boolean;
      onStop?: () => void;
    }) => () => void;
  };
  readonly sweep: Omit<PeerAskTimeoutSweepDeps, 'log'>;
  /** D-234 § 234.4n — the orphaned-hold half. Absent ⇒ only deadlines are swept,
   *  which is the honest posture on a host with no dish store. */
  readonly abandon?: Omit<PeerHoldAbandonDeps, 'log'>;
  /** Retry exact journaled sends only after answers, deadlines, and orphan
   * retirement had first claim on this tick. */
  readonly recoverDelivery?: () => Promise<PeerAskDeliveryRecoveryResult>;
  readonly intervalMs?: number;
  readonly log?: (line: string) => void;
}

export const composePeerAskTimeoutSweep = (deps: PeerAskTimeoutWiringDeps): void => {
  const log = deps.log ?? ((line: string) => { console.info(line); });
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      // ⛔ DEADLINES FIRST, ORPHANS SECOND, AND THE ORDER MATTERS FOR ONE CASE:
      // a hold that is BOTH past its deadline and owned by a deleted dish. The
      // deadline wins, which is right — it resumes the run with a readable
      // `timed_out`, and a run that has already ended is no longer an orphaned
      // hold when the second pass looks. Reversed, the same hold would be
      // abandoned unresumed and the recipe would never learn why.
      const r = await sweepExpiredPeerAsks({ ...deps.sweep, log });
      // ⚠ SILENT ON A QUIET TICK. This runs every minute for the life of the
      // server and the ordinary answer is "nothing expired"; logging that would
      // bury the one line that matters. Anything that ACTED gets a line.
      if (r.expired > 0) {
        log(
          `[peer-ask-timeout] swept ${String(r.expired)} expired of ${String(r.examined)} open`
          + ` — resumed=${String(r.resumed)} already_answered=${String(r.alreadyAnswered)}`
          + ` failed=${String(r.failed)}`,
        );
      }
      if (deps.abandon !== undefined) {
        const a = await abandonOrphanedPeerHolds({ ...deps.abandon, log });
        if (a.orphaned > 0) {
          log(
            `[peer-hold-abandon] ${String(a.abandoned)} hold(s) retired — dish gone`
            + ` · notice sent=${String(a.noticed)} failed=${String(a.noticeFailed)}`,
          );
        }
      }
      if (deps.recoverDelivery !== undefined) {
        const delivery = await deps.recoverDelivery();
        if (delivery.attempted > 0 || delivery.delivered > 0
          || delivery.refused > 0 || delivery.deferred > 0
          || delivery.failed > 0) {
          log(
            `[peer-ask-delivery] examined=${String(delivery.examined)}`
            + ` attempted=${String(delivery.attempted)}`
            + ` delivered=${String(delivery.delivered)}`
            + ` refused=${String(delivery.refused)}`
            + ` deferred=${String(delivery.deferred)}`
            + ` failed=${String(delivery.failed)}`,
          );
        }
      }
    } catch (e) {
      // The registry isolates throws already; this keeps the message specific.
      log(`[peer-ask-timeout] sweep failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inFlight = false;
    }
  };

  deps.registry.registerInterval({
    name: 'peer-ask-timeout-sweep',
    intervalMs: deps.intervalMs ?? PEER_ASK_TIMEOUT_SWEEP_INTERVAL_MS,
    tick,
    fireImmediate: true,
  });
};
