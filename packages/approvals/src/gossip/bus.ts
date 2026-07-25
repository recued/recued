/** D-113 — Executor ↔ gossip bridge.
 *
 *  The gossip data plane lives in the heartbeat loop: every ~1-5s it
 *  merges inbound contributions, picks effective resolutions for
 *  newly-matched pairs, and sweeps TTLs. The executor, on the other
 *  hand, is a linear sequence of awaits — when a write/admin/destructive
 *  step runs, the wrapper pauses and needs a single resolution record
 *  back before it can resume.
 *
 *  `ApprovalBus` is the translator between those two worlds. The
 *  executor calls `request(pending)` and awaits; the composition root
 *  wires `publishResolution` to fire whenever `mergeRemote.newly_resolved`
 *  surfaces a matched pair. The bus itself is pure pub-sub with no
 *  knowledge of encryption, heartbeats, or gossip state — the caller
 *  decides how to propagate the pending outbound (typically: push into
 *  local gossip state + schedule a burst heartbeat).
 *
 *  Ownership boundary:
 *    executor  ←→  bus  ←→  gossip loop  ←→  heartbeat  ←→  peers
 *
 *  The bus owns nothing except the waiter map. First-publish wins —
 *  subsequent calls for the same approval_id are no-ops, matching the
 *  data plane's deterministic tiebreaker. */

import type {
  ApprovalPendingRecord,
  ApprovalResolutionRecord,
} from '@recued/contracts';

export interface ApprovalBus {
  /** Initiator side: register a waiter for this approval_id and invoke
   *  the composition root's pending hook so the record rides the next
   *  heartbeat round outbound. Returns a promise that resolves with the
   *  first resolution record published for this approval_id. */
  request(pending: ApprovalPendingRecord): Promise<ApprovalResolutionRecord>;

  /** Gossip-loop side: publish a resolution. Fires any registered
   *  waiter for this approval_id and clears the subscription.
   *  Idempotent — duplicate publishes for the same approval_id after
   *  the first are no-ops, so the loop can fan out newly_resolved each
   *  round without tracking what it already sent. */
  publishResolution(
    approval_id: string,
    resolution: ApprovalResolutionRecord,
  ): void;

  /** Engine-shutdown side: dispose every pending waiter by firing an
   *  `executor_killed` resolution record so each await cascades a
   *  cancellation. Called when the engine is torn down mid-recipe. */
  disposeAll(reason: string): void;

  /** Surface a specific approval's cancellation as an executor-kind
   *  resolution — used when the recipe itself is cancelled or a
   *  dependency cascade decides to abort a pending step. The bus
   *  delivers the record to the waiter; caller is responsible for
   *  also mirroring it into gossip state so peers converge. */
  cancel(
    approval_id: string,
    kind: 'executor_cancelled' | 'executor_cascade' | 'executor_killed',
    reason: string,
  ): void;
}

export interface ApprovalBusDeps {
  /** This instance's stable id — stamped onto any executor-kind
   *  resolution the bus emits locally (timeouts, cancels). */
  self: { instance_id: string };
  /** Composition-root hook: push the pending into local gossip state +
   *  schedule a burst heartbeat so peers see it on the next round.
   *  Called synchronously during `request`. Omit in tests that only
   *  exercise the waiter map. */
  onPendingPublished?: (pending: ApprovalPendingRecord) => void;
  /** Clock override — tests pin `now` for deterministic `resolved_at`
   *  values on executor-emitted records. Defaults to `Date.now`. */
  now?: () => number;
}

export const createApprovalBus = (deps: ApprovalBusDeps): ApprovalBus => {
  const waiters = new Map<string, (record: ApprovalResolutionRecord) => void>();
  const now = deps.now ?? (() => Date.now());

  return {
    request(pending) {
      return new Promise((resolve) => {
        waiters.set(pending.approval_id, resolve);
        deps.onPendingPublished?.(pending);
      });
    },

    publishResolution(approval_id, resolution) {
      const waiter = waiters.get(approval_id);
      if (!waiter) return;
      waiters.delete(approval_id);
      waiter(resolution);
    },

    disposeAll(reason) {
      const at = now();
      for (const [approval_id, waiter] of waiters) {
        waiter({
          approval_id,
          created_by_instance: deps.self.instance_id,
          kind: 'executor_killed',
          resolved_at: at,
          executor_reason: reason,
        });
      }
      waiters.clear();
    },

    cancel(approval_id, kind, reason) {
      const waiter = waiters.get(approval_id);
      if (!waiter) return;
      waiters.delete(approval_id);
      waiter({
        approval_id,
        created_by_instance: deps.self.instance_id,
        kind,
        resolved_at: now(),
        executor_reason: reason,
      });
    },
  };
};
