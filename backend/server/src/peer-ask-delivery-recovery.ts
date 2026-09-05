/** Crash-safe delivery of an approved peer question.
 *
 * The outbox row is a journal, not proof that the receiver saw the question.
 * A resolved wire plan is staged before the awaiting-peer anchor, activated
 * only after that exact anchor/checkpoint pair is readable, then retried
 * at-least-once until the receiver returns an explicit durable-ask receipt or
 * refusal. The receiver deduplicates the immutable exchange_ref. */

import type { Checkpoint } from '@recued/contracts';
import { isGatedActionTerminal } from '@recued/contracts';
import { buildAuditEntry } from '@recued/storage';
import type { AuditEntry, AuditLogStore } from '@recued/storage';

import type { GatedActionStore } from './gated-action-store.js';
import type { PeerAnswerStore } from './storage/peer-answer-store.js';
import type {
  PeerAskDeliveryRefusal,
  PeerAskOutboxRow,
  PeerAskOutboxStore,
} from './storage/peer-ask-outbox-store.js';

export type PeerAskDeliveryOutcome =
  | {
      readonly kind: 'dispatched';
      readonly status_message: string;
      readonly result: Record<string, unknown>;
    }
  | {
      readonly kind: 'failed';
      readonly status_message: string;
      readonly result: Record<string, unknown>;
    }
  | {
      readonly kind: 'in_doubt';
      readonly status_message: string;
      readonly result: Record<string, unknown>;
    };

export interface PeerAskDeliveryRecoveryDeps {
  readonly outbox: PeerAskOutboxStore;
  readonly auditLog: Pick<AuditLogStore, 'get' | 'append'>;
  readonly checkpoints: {
    listByRun(run_id: string): Promise<Checkpoint[]>;
    delete(checkpoint_id: string): Promise<void>;
  };
  readonly answers?: Pick<PeerAnswerStore, 'get'>;
  readonly gatedActions?: Pick<
    GatedActionStore,
    'get' | 'finish' | 'confirmPeerHandoff'
  >;
  /** Exact transport attempt. It receives only persisted data plus the
   * authoritative anchor (for the original execution authority). */
  readonly deliver: (
    row: PeerAskOutboxRow,
    anchor: AuditEntry,
  ) => Promise<PeerAskDeliveryOutcome>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Boot-only. With the lifecycle lock held there can be no concurrent anchor
   * append, so a staged/corrupt plan with no exact anchor can be retired rather
   * than live forever. Periodic/live callers leave this false. */
  readonly retireUnanchoredStaged?: boolean;
}

export interface PeerAskDeliveryRecoveryResult {
  examined: number;
  attempted: number;
  delivered: number;
  refused: number;
  deferred: number;
  failed: number;
}

export type PeerConversationLocalEnd = 'timed_out' | 'abandoned';

export type PeerAskDeliveryRecoveryOne =
  | { kind: 'not_ready' }
  | { kind: 'deferred'; outcome: Extract<PeerAskDeliveryOutcome, { kind: 'in_doubt' }> }
  | { kind: 'delivered'; outcome: Extract<PeerAskDeliveryOutcome, { kind: 'dispatched' }> }
  | { kind: 'refused'; outcome: Extract<PeerAskDeliveryOutcome, { kind: 'failed' }> };

const inFlight = new Set<string>();

const refusalOutcome = (
  exchangeRef: string,
  refusal: PeerAskDeliveryRefusal,
): Extract<PeerAskDeliveryOutcome, { kind: 'failed' }> => ({
  kind: 'failed',
  status_message: `The peer refused the approved question: ${refusal.reason}`,
  result: {
    exchange_ref: exchangeRef,
    status: 'failed',
    refusal: refusal.refusal,
    reason: refusal.reason,
  },
});

const buildFailureEntry = (
  anchor: AuditEntry,
  row: PeerAskOutboxRow,
  outcome: Extract<PeerAskDeliveryOutcome, { kind: 'failed' }>,
  nowMs: number,
): AuditEntry => buildAuditEntry({
  ...anchor,
  commit_status: 'failed',
  duration_ms: Math.max(0, nowMs - anchor.started_at),
  errors: [{
    error_id: `peer-delivery-${nowMs.toString(36)}-${anchor.run_id}`,
    code: typeof outcome.result.refusal === 'string'
      ? 'CONNECTION_REFUSED'
      : 'INGREDIENT_ADAPTER_ALL_FAILED',
    message: outcome.status_message,
    severity: 'fatal',
    source: {
      recipe_id: anchor.recipe_id,
      step_id: row.gated_step_id,
      ingredient_slug: 'peer-ask',
    },
    details: { ...outcome.result },
    timestamp: new Date(nowMs).toISOString(),
    retryable: false,
  }],
  context_snapshot: undefined,
  checkpoint_id: undefined,
  ask_id: undefined,
  now: nowMs,
});

type PeerDispatchJournalDeps = Pick<
  PeerAskDeliveryRecoveryDeps,
  'outbox' | 'auditLog' | 'checkpoints'
>;

const exactCheckpoint = async (
  row: PeerAskOutboxRow,
  deps: Pick<PeerDispatchJournalDeps, 'checkpoints'>,
): Promise<Checkpoint | null> => {
  if (row.checkpoint_id === undefined) return null;
  const checkpoint = (await deps.checkpoints.listByRun(row.run_id)).find(
    (candidate) => candidate.checkpoint_id === row.checkpoint_id,
  );
  if (checkpoint === undefined
    || checkpoint.run_id !== row.run_id
    || checkpoint.gated_step_id !== row.gated_step_id) return null;
  return checkpoint;
};

const exactAwaitingAnchor = async (
  row: PeerAskOutboxRow,
  deps: Pick<PeerDispatchJournalDeps, 'auditLog' | 'checkpoints'>,
): Promise<{ anchor: AuditEntry; checkpoint: Checkpoint } | null> => {
  const anchor = await deps.auditLog.get(row.run_id);
  if (row.checkpoint_id === undefined
    || anchor?.commit_status !== 'awaiting_peer'
    || typeof anchor.checkpoint_id !== 'string'
    || anchor.checkpoint_id.length === 0
    || anchor.checkpoint_id !== row.checkpoint_id) return null;
  const checkpoint = await exactCheckpoint(row, deps);
  if (checkpoint === null) return null;
  return { anchor, checkpoint };
};

const terminalFailureMatches = (
  row: PeerAskOutboxRow,
  anchor: AuditEntry | null,
): anchor is AuditEntry => anchor?.commit_status === 'failed'
  && (anchor.errors ?? []).some((error) => {
    if (error.source?.step_id !== row.gated_step_id) return false;
    const details = error.details;
    return details !== null && typeof details === 'object' && !Array.isArray(details)
      && (details as Record<string, unknown>).exchange_ref === row.exchange_ref;
  });

const confirmDeliveredReceipt = async (
  row: PeerAskOutboxRow,
  deps: PeerAskDeliveryRecoveryDeps,
): Promise<void> => {
  if (row.action_ref === undefined || deps.gatedActions === undefined) return;
  const action = await deps.gatedActions.get(row.action_ref);
  if (action === null
    || action.run_id !== row.run_id
    || action.gated_step_id !== row.gated_step_id
    || isGatedActionTerminal(action.status)) return;
  await deps.gatedActions.confirmPeerHandoff(row.action_ref, {
    run_id: row.run_id,
    gated_step_id: row.gated_step_id,
    exchange_ref: row.exchange_ref,
    status_message: 'The approved question was handed off to the peer exchange.',
  });
};

/** A local timeout/abandon can close the conversation before periodic delivery
 * recovery sees it. Settle the exact approved handoff first so removing the
 * journal cannot leave a live `dispatching` receipt forever. Verified receiver
 * acceptance remains `dispatched`; otherwise the handoff is honestly
 * `in_doubt` even though the recipe may separately resume/terminate. */
export const settleLocallyEndedPeerDeliveryReceipt = async (
  row: PeerAskOutboxRow,
  end: PeerConversationLocalEnd,
  gatedActions: Pick<GatedActionStore, 'get' | 'finish' | 'confirmPeerHandoff'> | undefined,
): Promise<void> => {
  if (row.action_ref === undefined || gatedActions === undefined) return;
  const action = await gatedActions.get(row.action_ref);
  if (action === null
    || action.run_id !== row.run_id
    || action.gated_step_id !== row.gated_step_id
    || action.current_checkpoint_id !== row.checkpoint_id) {
    throw new Error('peer conversation journal no longer owns its gated action receipt');
  }
  if (isGatedActionTerminal(action.status)) return;
  if (row.delivery_state === 'delivered') {
    const confirmed = await gatedActions.confirmPeerHandoff(row.action_ref, {
      run_id: row.run_id,
      gated_step_id: row.gated_step_id,
      exchange_ref: row.exchange_ref,
      status_message: 'The approved question was handed off before the peer conversation ended.',
    });
    if (confirmed === null || !isGatedActionTerminal(confirmed.status)) {
      throw new Error('verified peer handoff receipt did not settle before conversation close');
    }
    return;
  }
  const settled = await gatedActions.finish(row.action_ref, {
    status: 'in_doubt',
    status_message:
      `The peer conversation ${end === 'timed_out' ? 'timed out' : 'was abandoned'} `
      + 'before Recued could verify delivery. Inspect Logs before retrying.',
    result: {
      exchange_ref: row.exchange_ref,
      status: 'in_doubt',
      reason: end === 'timed_out'
        ? 'peer_timeout_before_verified_delivery'
        : 'peer_abandoned_before_verified_delivery',
    },
    observed: { items: 1, succeeded: 0, failed: 0 },
  });
  if (settled === null || !isGatedActionTerminal(settled.status)) {
    throw new Error('unverified peer handoff receipt did not settle before conversation close');
  }
};

const settleRefusal = async (
  row: PeerAskOutboxRow,
  anchor: AuditEntry,
  checkpoint: Checkpoint,
  outcome: Extract<PeerAskDeliveryOutcome, { kind: 'failed' }>,
  deps: PeerAskDeliveryRecoveryDeps,
): Promise<void> => {
  // The refused journal state already closed the answer route. Replace the
  // run anchor first; after this lands no continuation can resume the recipe.
  const terminal = buildFailureEntry(anchor, row, outcome, (deps.now ?? Date.now)());
  try {
    await deps.auditLog.append(terminal);
  } catch (error) {
    // A durable adapter can commit and then lose its acknowledgement. Re-read
    // before deciding the transition failed; otherwise a refused journal row
    // would become immortal beside its already-terminal anchor.
    const observed = await deps.auditLog.get(row.run_id);
    if (!terminalFailureMatches(row, observed)) throw error;
  }

  if (row.action_ref !== undefined && deps.gatedActions !== undefined) {
    const action = await deps.gatedActions.get(row.action_ref);
    if (action !== null
      && action.run_id === row.run_id
      && action.gated_step_id === row.gated_step_id
      && !isGatedActionTerminal(action.status)) {
      await deps.gatedActions.finish(row.action_ref, {
        status: 'failed',
        status_message: outcome.status_message,
        result: outcome.result,
        observed: { items: 1, succeeded: 0, failed: 1 },
      });
    }
  }

  try {
    await deps.checkpoints.delete(checkpoint.checkpoint_id);
  } finally {
    // Keep the refused journal row until both durable outcome writes above
    // succeed. A delete that commits then reports an error is harmless: the
    // terminal anchor is already authoritative and the next pass finds no row.
    deps.outbox.close(row.exchange_ref);
  }
};

const retireUnsendableStaged = async (
  row: PeerAskOutboxRow,
  deps: PeerAskDeliveryRecoveryDeps,
  reason: string,
): Promise<void> => {
  let exactAction: Awaited<ReturnType<NonNullable<typeof deps.gatedActions>['get']>> | null = null;
  if (row.action_ref !== undefined && deps.gatedActions !== undefined) {
    const action = await deps.gatedActions.get(row.action_ref);
    if (action !== null
      && action.run_id === row.run_id
      && action.gated_step_id === row.gated_step_id) exactAction = action;
  }

  const anchor = await deps.auditLog.get(row.run_id);
  // `action_ref` identifies the logical operation, but its checkpoint pointer
  // is the current continuation owner. A staged row may legitimately observe
  // either side of the bind boundary (the prior approval checkpoint or its own
  // peer checkpoint); any third pointer is a later/superseding continuation and
  // this stale row must not terminalize it.
  const exactActionOwnsStage = exactAction !== null && (
    exactAction.current_checkpoint_id === row.checkpoint_id
    || (anchor?.commit_status === 'awaiting_approval'
      && exactAction.current_checkpoint_id === anchor.checkpoint_id)
  );
  const ownsAwaitingAnchor = anchor !== null && (
    (anchor.commit_status === 'awaiting_peer'
      && anchor.checkpoint_id === row.checkpoint_id)
    // Pre-anchor power cut while replaying an answered approval: the old P1
    // anchor can still say awaiting_approval, but the exact action is already
    // dispatching and this staged row proves P2 was created. Retire the run
    // before notification replay can dispatch P1 again.
    || (anchor.commit_status === 'awaiting_approval'
      && exactActionOwnsStage
      && exactAction?.status === 'dispatching')
  );
  if (ownsAwaitingAnchor) {
    const at = (deps.now ?? Date.now)();
    const terminal = buildAuditEntry({
      ...anchor,
      commit_status: 'in_doubt',
      duration_ms: Math.max(0, at - anchor.started_at),
      errors: [{
        error_id: `peer-delivery-recovery-${at.toString(36)}-${row.run_id}`,
        code: 'INGREDIENT_ADAPTER_ALL_FAILED',
        message: 'Recued restarted before the approved peer handoff could be durably prepared. Nothing was re-sent automatically.',
        severity: 'fatal',
        source: {
          recipe_id: anchor.recipe_id,
          step_id: row.gated_step_id,
          ingredient_slug: 'peer-ask',
        },
        details: {
          exchange_ref: row.exchange_ref,
          reason,
        },
        timestamp: new Date(at).toISOString(),
        retryable: false,
      }],
      context_snapshot: undefined,
      checkpoint_id: undefined,
      ask_id: undefined,
      now: at,
    });
    try {
      await deps.auditLog.append(terminal);
    } catch (error) {
      const observed = await deps.auditLog.get(row.run_id);
      if (observed?.commit_status !== 'in_doubt') throw error;
    }
  }

  if (row.action_ref !== undefined
    && deps.gatedActions !== undefined
    && exactAction !== null
    && exactActionOwnsStage
    && !isGatedActionTerminal(exactAction.status)) {
      await deps.gatedActions.finish(row.action_ref, {
        status: 'in_doubt',
        status_message: 'The approved peer handoff could not be recovered before delivery. Inspect Logs before retrying.',
        result: {
          exchange_ref: row.exchange_ref,
          status: 'in_doubt',
          reason,
        },
        observed: { items: 1, succeeded: 0, failed: 0 },
      });
  }
  if (row.checkpoint_id !== undefined) {
    await deps.checkpoints.delete(row.checkpoint_id);
  }
  deps.outbox.close(row.exchange_ref);
};

const exactRefusal = (
  outcome: Extract<PeerAskDeliveryOutcome, { kind: 'failed' }>,
): PeerAskDeliveryRefusal | undefined => {
  const refusal = outcome.result.refusal;
  const reason = outcome.result.reason;
  return typeof refusal === 'string' && refusal.length > 0
    && typeof reason === 'string' && reason.length > 0
    ? { refusal, reason }
    : undefined;
};

/** Recover one journal row. Safe to race an inline attempt in this process;
 * one exchange_ref owns one in-flight attempt, while a process death clears
 * the lock and leaves the durable state retryable. */
export const recoverPeerAskDelivery = async (
  input: PeerAskOutboxRow,
  deps: PeerAskDeliveryRecoveryDeps,
): Promise<PeerAskDeliveryRecoveryOne> => {
  if (inFlight.has(input.exchange_ref)) return { kind: 'not_ready' };
  inFlight.add(input.exchange_ref);
  try {
    let row = deps.outbox.getDelivery(input.exchange_ref);
    if (row === null) return { kind: 'not_ready' };
    if (row.delivery === undefined || row.checkpoint_id === undefined) {
      if (deps.retireUnanchoredStaged === true
        && (row.delivery_state === 'staged' || row.delivery_state === 'pending')) {
        await retireUnsendableStaged(row, deps, 'peer_delivery_plan_unreadable');
      }
      return { kind: 'not_ready' };
    }

    const exact = await exactAwaitingAnchor(row, deps);
    if (exact === null) {
      const observedAnchor = await deps.auditLog.get(row.run_id);
      if (row.delivery_state === 'refused'
        && row.refusal !== undefined
        && terminalFailureMatches(row, observedAnchor)) {
        // The terminal audit append committed before its acknowledgement was
        // lost. Finish any still-live action receipt, then reclaim checkpoint
        // and journal without rewriting the already-terminal anchor.
        const outcome = refusalOutcome(row.exchange_ref, row.refusal);
        if (row.action_ref !== undefined && deps.gatedActions !== undefined) {
          const action = await deps.gatedActions.get(row.action_ref);
          if (action !== null
            && action.run_id === row.run_id
            && action.gated_step_id === row.gated_step_id
            && !isGatedActionTerminal(action.status)) {
            await deps.gatedActions.finish(row.action_ref, {
              status: 'failed',
              status_message: outcome.status_message,
              result: outcome.result,
              observed: { items: 1, succeeded: 0, failed: 1 },
            });
          }
        }
        await deps.checkpoints.delete(row.checkpoint_id);
        deps.outbox.close(row.exchange_ref);
        return { kind: 'refused', outcome };
      }
      if (deps.retireUnanchoredStaged === true && row.delivery_state === 'staged') {
        await retireUnsendableStaged(row, deps, 'peer_delivery_anchor_unwritten');
      }
      // A staged row can legitimately precede its anchor for a few synchronous
      // writes. It is neither answerable nor sendable until a later pass proves
      // the exact pair. Other states are also left intact: deleting uncertainty
      // would erase the only recovery marker.
      return { kind: 'not_ready' };
    }

    if (row.action_ref !== undefined && deps.gatedActions !== undefined) {
      const action = await deps.gatedActions.get(row.action_ref);
      if (action === null
        || action.run_id !== row.run_id
        || action.gated_step_id !== row.gated_step_id
        || action.current_checkpoint_id !== exact.checkpoint.checkpoint_id) {
        return { kind: 'not_ready' };
      }
    }

    if (row.delivery_state === 'staged') {
      try {
        deps.outbox.activate(row.exchange_ref);
      } catch {
        // Verify below; an adapter may report an error after commit.
      }
      row = deps.outbox.getDelivery(row.exchange_ref) ?? row;
      if (row.delivery_state !== 'pending') return { kind: 'not_ready' };
    }

    if (row.delivery_state === 'delivered') {
      await confirmDeliveredReceipt(row, deps);
      return {
        kind: 'delivered',
        outcome: {
          kind: 'dispatched',
          status_message: 'The approved question was handed off to the peer exchange.',
          result: {
            exchange_ref: row.exchange_ref,
            status: 'dispatched',
          },
        },
      };
    }

    if (row.delivery_state === 'refused') {
      if (row.refusal === undefined) return { kind: 'not_ready' };
      const outcome = refusalOutcome(row.exchange_ref, row.refusal);
      await settleRefusal(row, exact.anchor, exact.checkpoint, outcome, deps);
      return { kind: 'refused', outcome };
    }

    // Boot recovery runs before the post-listener deadline sweep. Activate the
    // exact staged row so that sweep can claim it, but never transmit a question
    // whose authored deadline has already elapsed.
    if (row.deadline_at !== undefined
      && row.deadline_at <= (deps.now ?? Date.now)()) {
      return { kind: 'not_ready' };
    }

    // A durable answer wins over re-delivery. The existing continuation sweep
    // will resume and close this row; delivery recovery never fabricates a
    // second ask beside an answer already received.
    if (deps.answers !== undefined && deps.answers.get(row.exchange_ref) !== null) {
      return { kind: 'not_ready' };
    }

    const outcome = await deps.deliver(row, exact.anchor);
    if (outcome.kind === 'in_doubt') return { kind: 'deferred', outcome };

    if (outcome.kind === 'dispatched') {
      try {
        deps.outbox.markDelivered(row.exchange_ref);
      } catch {
        // Verify below; commit-then-throw remains a successful transition.
      }
      const delivered = deps.outbox.getDelivery(row.exchange_ref);
      if (delivered?.delivery_state !== 'delivered') {
        return {
          kind: 'deferred',
          outcome: {
            kind: 'in_doubt',
            status_message: 'The peer accepted the question, but Recued could not persist its delivery receipt.',
            result: {
              exchange_ref: row.exchange_ref,
              status: 'in_doubt',
              reason: 'peer_delivery_receipt_unwritten',
            },
          },
        };
      }
      await confirmDeliveredReceipt(delivered, deps);
      return { kind: 'delivered', outcome };
    }

    const refusal = exactRefusal(outcome);
    if (refusal === undefined) {
      return {
        kind: 'deferred',
        outcome: {
          kind: 'in_doubt',
          status_message: 'Peer delivery failed without a verifiable refusal; the exact question remains retryable.',
          result: {
            exchange_ref: row.exchange_ref,
            status: 'in_doubt',
            reason: 'peer_refusal_unverified',
          },
        },
      };
    }

    // Check once immediately before closing the answer route. `get` +
    // first-write-wins answer insertion are synchronous on this process's
    // SQLite connection, so no local answer can interleave between this check
    // and markRefused.
    if (deps.answers !== undefined && deps.answers.get(row.exchange_ref) !== null) {
      return {
        kind: 'deferred',
        outcome: {
          kind: 'in_doubt',
          status_message: 'A peer answer arrived while delivery refusal was being settled; its continuation owns the run.',
          result: {
            exchange_ref: row.exchange_ref,
            status: 'in_doubt',
            reason: 'peer_answer_arrived_during_delivery_settlement',
          },
        },
      };
    }
    let refusalTransition: ReturnType<PeerAskOutboxStore['markRefused']> | undefined;
    try {
      refusalTransition = deps.outbox.markRefused(row.exchange_ref, refusal);
    } catch {
      // Verify below. A storage adapter may commit then lose acknowledgement.
    }
    if (refusalTransition === 'answered') {
      return {
        kind: 'deferred',
        outcome: {
          kind: 'in_doubt',
          status_message: 'A peer answer won the delivery-settlement race; its continuation owns the run.',
          result: {
            exchange_ref: row.exchange_ref,
            status: 'in_doubt',
            reason: 'peer_answer_arrived_during_delivery_settlement',
          },
        },
      };
    }
    const refused = deps.outbox.getDelivery(row.exchange_ref);
    if (refused?.delivery_state !== 'refused' || refused.refusal === undefined) {
      return {
        kind: 'deferred',
        outcome: {
          kind: 'in_doubt',
          status_message: 'The peer refused the question, but Recued could not durably close its answer route.',
          result: {
            exchange_ref: row.exchange_ref,
            status: 'in_doubt',
            reason: 'peer_refusal_closure_unverified',
            refusal: refusal.refusal,
            peer_reason: refusal.reason,
          },
        },
      };
    }
    await settleRefusal(refused, exact.anchor, exact.checkpoint, outcome, deps);
    return { kind: 'refused', outcome };
  } finally {
    inFlight.delete(input.exchange_ref);
  }
};

export const recoverPeerAskDeliveries = async (
  deps: PeerAskDeliveryRecoveryDeps,
): Promise<PeerAskDeliveryRecoveryResult> => {
  const result: PeerAskDeliveryRecoveryResult = {
    examined: 0,
    attempted: 0,
    delivered: 0,
    refused: 0,
    deferred: 0,
    failed: 0,
  };
  const log = deps.log ?? ((line: string) => { console.info(line); });
  for (const row of deps.outbox.listDeliveries()) {
    result.examined += 1;
    try {
      const recovered = await recoverPeerAskDelivery(row, deps);
      if (recovered.kind === 'not_ready') continue;
      if ((row.delivery_state === 'pending' || row.delivery_state === 'staged')
        && (recovered.kind === 'delivered' || recovered.kind === 'refused'
          || recovered.kind === 'deferred')) result.attempted += 1;
      if (recovered.kind === 'delivered') result.delivered += 1;
      if (recovered.kind === 'refused') result.refused += 1;
      if (recovered.kind === 'deferred') result.deferred += 1;
    } catch (error) {
      result.failed += 1;
      log(
        `[peer-ask-delivery] ${row.exchange_ref.slice(0, 12)}… recovery failed: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return result;
};

/** Exact predicate used by generic dispatching->in_doubt boot recovery. A
 * journal exempts only the action/checkpoint it names. Activated states also
 * require their awaiting-peer anchor; staged is preserved only as a fail-safe
 * when the earlier boot retirement pass itself could not converge. */
export const journalOwnsInterruptedPeerDispatch = async (
  action: {
    action_ref: string;
    run_id: string;
    gated_step_id: string;
    current_checkpoint_id: string;
  },
  deps: PeerDispatchJournalDeps,
): Promise<boolean> => {
  const matches = deps.outbox.listDeliveries().filter((candidate) =>
    candidate.action_ref === action.action_ref
      && candidate.run_id === action.run_id
      && candidate.gated_step_id === action.gated_step_id
      && candidate.exchange_ref.length > 0
      && candidate.checkpoint_id === action.current_checkpoint_id);
  if (matches.length !== 1) return false;
  const row = matches[0]!;
  if (row.delivery === undefined) return false;
  const checkpoint = await exactCheckpoint(row, deps);
  if (checkpoint === null) return false;
  // `staged` is the one valid pre-anchor state. Boot recovery runs before the
  // generic sweep and normally retires it; preserving it here if that repair
  // itself failed prevents answered P1 replay from dispatching around the
  // durable P2 marker. It is still neither sendable nor answerable.
  if (row.delivery_state === 'staged') return true;
  const exact = await exactAwaitingAnchor(row, deps);
  return exact !== null;
};

/** Same subject proof used by the approval resumer after it observes an
 * already-dispatching receipt. Kept as a named alias so composition can make
 * the two reconciliation call sites visibly share one authority rule. */
export const journalOwnsClaimedPeerDispatch = journalOwnsInterruptedPeerDispatch;
