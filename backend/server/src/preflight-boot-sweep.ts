/** D-157 server-wiring — preflight ask boot re-raise sweep (codex
 *  BLOCKER 4 fold).
 *
 *  The execute-handler's preflight raise path is best-effort once the
 *  checkpoint write succeeds: a failure inside `raisePreflightAsk`
 *  leaves the audit row with `commit_status: 'awaiting_approval'` +
 *  `checkpoint_id` set but `ask_id` undefined. Without a re-raise,
 *  paired clients see neither a card nor a card-resume on the next
 *  boot — the paused run is silently stranded behind a durable
 *  checkpoint nothing surfaces.
 *
 *  `sweepAwaitingCheckpoints` is the recovery half. At boot, after the
 *  notification block's `recoverPendingAsks()` re-delivers asks that
 *  *did* persist, this sweep walks every `Checkpoint` still in the
 *  store, and repairs either hold shape:
 *
 *  - recipe checkpoints are paired through their audit anchor, and a fresh
 *    `notification.ask` is raised for an awaiting anchor whose `ask_id` is
 *    missing;
 *  - recipe-less raw-op checkpoints have no audit anchor, so the durable ask
 *    store is the pairing authority. An already-open ask is linked to the
 *    operation receipt, while a checkpoint with no matching open ask is
 *    re-raised.
 *
 *  For recipe holds, the fresh `ask_id` is pinned back onto the audit row so
 *  subsequent boots don't double-raise — `auditLog.append` with the existing
 *  `run_id` re-writes the row via INSERT OR REPLACE, preserving every field
 *  except the freshly-set `ask_id`.
 *
 *  Idempotency. The sweep is safe to re-run: an anchor whose `ask_id`
 *  is already set is skipped. When an ask was persisted but the host
 *  crashed before pinning its display id onto the anchor, the durable
 *  unresolved-ask index finds the exact checkpoint-bound ask and the
 *  sweep repairs the anchor instead of minting another owner decision.
 *
 *  Spec: D-157 § A.3.
 */

import type { AuditEntry, AuditLogStore, CheckpointStore } from '@recued/storage';
import { buildAuditEntry } from '@recued/storage';
import type { PreflightAskContext, PreflightNotifier } from '@recued/gateway';
import { PREFLIGHT_HANDLER_KIND, raisePreflightAsk } from '@recued/gateway';
import { isReceptionOriginSource } from './reception-inbox-handler.js';
import type {
  BatchAskRecord,
  Checkpoint,
  RecipeError,
  ReceptionInboxFanoutMode,
} from '@recued/contracts';
import { isGatedActionTerminal } from '@recued/contracts';
import type { GatedActionRecord, GatedActionStore } from './gated-action-store.js';

const RAW_OP_GATED_STEP_ID = 'raw_op';
const KNOWN_PEER_DELIVERY_FAILURE_REASONS = new Set([
  'peer_outbox_unavailable',
  'peer_outbox_conflict',
  'peer_outbox_write_failed',
]);

const plainObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

/** A failed action receipt is the crash marker for the one gap between
 * settling an approved peer operation and replacing its `awaiting_peer`
 * anchor. Keep the recognizer closed: an arbitrary failed receipt must never
 * retire a live peer conversation. */
const knownPeerDeliveryFailure = (
  action: GatedActionRecord | null,
): Record<string, unknown> | undefined => {
  if (action?.status !== 'failed') return undefined;
  const result = plainObject(action.result);
  if (result?.status !== 'failed'
    || typeof result.exchange_ref !== 'string'
    || result.exchange_ref.length === 0) return undefined;
  const refusalKnown = typeof result.refusal === 'string'
    && result.refusal.length > 0;
  const reasonKnown = typeof result.reason === 'string'
    && KNOWN_PEER_DELIVERY_FAILURE_REASONS.has(result.reason);
  return refusalKnown || reasonKnown ? result : undefined;
};

const recoveredPeerDeliveryFailureEntry = (
  anchor: AuditEntry,
  checkpoint: Checkpoint,
  action: GatedActionRecord,
  details: Record<string, unknown>,
  nowMs: number,
) => {
  const refused = typeof details.refusal === 'string'
    && details.refusal.length > 0;
  const error: RecipeError = {
    error_id: `peer-delivery-recovery-${nowMs.toString(36)}-${anchor.run_id}`,
    code: refused ? 'CONNECTION_REFUSED' : 'INGREDIENT_ADAPTER_ALL_FAILED',
    message: action.status_message,
    severity: 'fatal',
    source: {
      recipe_id: anchor.recipe_id,
      step_id: checkpoint.gated_step_id ?? null,
      ingredient_slug: action.ingredient_slug ?? 'peer-ask',
    },
    details: { ...details },
    timestamp: new Date(nowMs).toISOString(),
    retryable: false,
  };
  return buildAuditEntry({
    ...anchor,
    commit_status: 'failed',
    duration_ms: Math.max(0, nowMs - anchor.started_at),
    errors: [error],
    context_snapshot: undefined,
    checkpoint_id: undefined,
    ask_id: undefined,
    now: nowMs,
  });
};

/** Re-pin the display ask for an already-durable awaiting anchor without
 * changing the historical run shape. `buildAuditEntry` is intentionally used
 * instead of a spread so the repaired row goes through the same normalization
 * as the original append. */
const awaitingEntryWithAsk = (
  anchor: AuditEntry,
  checkpoint: Checkpoint,
  askId: string,
): AuditEntry => buildAuditEntry({
  // `buildAuditEntry` is an enumerating copier. Feed it the whole existing
  // host-authored row so every authority, targeting, exchange, dish, and
  // idempotency field it knows about survives this pointer-only repair.
  ...anchor,
  commit_status: 'awaiting_approval',
  errors: anchor.errors ?? [],
  now: anchor.finished_at,
  checkpoint_id: checkpoint.checkpoint_id,
  ask_id: askId,
});

interface UnresolvedPreflightAsk {
  readonly ask_id: string;
  readonly handler_kind: string;
  readonly handler_payload: Record<string, unknown>;
}

export interface PreflightBootSweepDeps {
  readonly canPublishReviewedCheckpoint?: (checkpoint: Checkpoint) => boolean;
  readonly checkpointStore: CheckpointStore;
  readonly auditLog: AuditLogStore;
  readonly notifier: PreflightNotifier;
  readonly gatedActionStore?: GatedActionStore;
  /** Read the notification block's durable unresolved asks (`open` plus
   *  `answered`-but-unhandled). This is the duplicate-safe recovery index for
   *  raw holds (which have no audit anchor) and for recipe holds whose anchor
   *  lost the current render pointer after the ask committed. Production
   *  composition always supplies it; receipt-backed recovery fails closed when
   *  it is absent or unreadable instead of minting a potentially duplicate
   *  owner decision. */
  readonly listUnresolvedAsks?: () => Promise<ReadonlyArray<UnresolvedPreflightAsk>>;
  /** Narrow batch-membership read. A receipt grouped under a still-live batch
   * must never be re-raised as a standalone decision merely because its run
   * anchor lost the display ask pointer. */
  readonly getBatch?: (
    batch_id: string,
  ) => Promise<Pick<BatchAskRecord,
    'state' | 'current_ask_id' | 'members' | 'answer_option'> | null>;
  /** Group-atomic repair for an open batch whose current-version ask may not
   * have survived the row/receipt/notification crash window. */
  readonly reconcileOpenBatch?: (
    selector: string | { readonly checkpoint_id: string },
  ) => Promise<{ kind: 'reconciled'; ask_id: string; raised: boolean } | { kind: 'not_open' }>;
  /** D-210 Phase C — the owner's inbox device-fanout mode (a thunk; the
   *  setting is editable and this dep is composed at boot).
   *
   *  ⛔ WITHOUT THIS THE SWEEP UNDOES NOTIFY MODE. The sweep's whole job
   *  is "awaiting + no `ask_id` ⇒ raise", and a notify-mode hold is
   *  DELIBERATELY ask-less — so on the next boot every one of them would
   *  be re-raised as an actionable card, silently converting the owner's
   *  passive setting back to the loud one. The mode is read fresh here
   *  rather than stamped on the anchor at raise time on purpose: it is a
   *  strictly-global preference, so "what does the owner want NOW"
   *  is the right question, and flipping notify → approval correctly
   *  re-raises asks for holds taken while it was off.
   *
   *  Absent ⇒ every ask-less anchor is re-raised, byte-identical to
   *  pre-Phase-C. */
  readonly resolveInboxFanoutMode?: () => ReceptionInboxFanoutMode;
}

export interface PreflightBootSweepResult {
  /** Total `Checkpoint` rows the sweep walked. */
  inspected: number;
  /** Recipe anchors or raw-op checkpoints already paired with a durable open
   *  ask — no raise needed. */
  alreadyPaired: number;
  /** Awaiting holds successfully re-raised. Recipe asks are also pinned to
   *  their audit anchor; raw-op asks are linked to their action receipt. */
  raised: number;
  /** D-210 Phase C — awaiting, ask-less, and left that way because the
   *  owner's fanout mode is `'notify'` for this reception hold. NOT a
   *  failure: the item is waiting in the inbox, which is where notify
   *  mode says decisions are made. Counted separately so a sweep that
   *  raised nothing is still legible. */
  leftPassive: number;
  /** Awaiting anchors the sweep failed to re-raise (the raise call
   *  threw OR the audit re-write threw). They stay durable on disk
   *  and the next boot retries. */
  failed: number;
  /** Orphaned checkpoints: no audit row exists for the checkpoint's
   *  `run_id`. The run was pruned by retention — the sweep cannot
   *  re-raise without an anchor to update. The caller logs + leaves
   *  the checkpoint for the D-157 N.8 retention sweep
   *  (`checkpoint-retention.ts`) to garbage-collect past its grace. */
  orphaned: number;
  /** Held recipe checkpoints superseded by a newer anchor checkpoint for the
   * same run. They are left for retention and never used to renew a receipt or
   * resume a stale step. */
  superseded: number;
  /** D-234 § 234.4 — checkpoints held for a PEER'S answer. Skipped like a
   *  terminal row (this sweep re-raises PREFLIGHT asks, and a peer hold has no
   *  local ask to re-raise — its answer arrives over the wire), but counted
   *  apart from `terminal` because it is NOT terminal: the run is live and
   *  waiting, and telemetry that folds the two makes an accumulating backlog of
   *  peer holds read as an accumulating backlog of dead rows. */
  heldForPeer: number;
  /** Peer holds whose approved operation had already landed a recognized
   *  terminal delivery-failure receipt before the process lost the matching
   *  audit replacement. The sweep repairs the anchor before retiring the
   *  checkpoint, so an answered approval replay cannot leave an immortal
   *  conversation whose answer route is already proven closed. */
  repairedPeerFailures: number;
  /** Checkpoints whose audit row is in a terminal state. The run
   *  completed on a prior attempt (or the checkpoint was never
   *  successfully consumed). Counted but not re-raised; the D-157 N.8
   *  retention sweep garbage-collects these past its grace. */
  terminal: number;
}

/** Walk every `Checkpoint` and re-raise the `notification.ask` for any
 *  whose audit anchor is `'awaiting_approval'` with no `ask_id`.
 *
 *  Best-effort per checkpoint — a per-row failure is recorded in the
 *  result and the sweep continues. A failure during the audit re-write
 *  leaves the freshly-minted ask_id recoverable through the durable ask
 *  index; the next boot pins that same ask rather than creating another.
 *  The sweep itself never throws; callers reading `result.failed > 0`
 *  decide whether to log a warning. */
export const sweepAwaitingCheckpoints = async (
  deps: PreflightBootSweepDeps,
): Promise<PreflightBootSweepResult> => {
  const result: PreflightBootSweepResult = {
    inspected: 0,
    alreadyPaired: 0,
    raised: 0,
    leftPassive: 0,
    failed: 0,
    orphaned: 0,
    superseded: 0,
    heldForPeer: 0,
    repairedPeerFailures: 0,
    terminal: 0,
  };

  /** Establish a decision-group link and verify the postcondition even when a
   * storage adapter reports an error after committing its write. New asks are
   * never exposed unless this check succeeds. */
  const requireReceiptLink = async (
    action: GatedActionRecord,
    approvalRef: string,
    currentAskId: string | null | undefined,
  ): Promise<GatedActionRecord> => {
    if (deps.gatedActionStore === undefined) return action;
    let linked: GatedActionRecord | null;
    try {
      linked = await deps.gatedActionStore.linkApproval(
        action.action_ref,
        approvalRef,
        currentAskId,
      );
    } catch (error) {
      try {
        linked = await deps.gatedActionStore.get(action.action_ref);
      } catch {
        throw error;
      }
      const desiredAskId = currentAskId === null ? undefined : currentAskId;
      if (linked === null
        || isGatedActionTerminal(linked.status)
        || linked.approval_ref !== approvalRef
        || (currentAskId !== undefined
          && linked.current_ask_id !== desiredAskId)) throw error;
    }
    const desiredAskId = currentAskId === null ? undefined : currentAskId;
    if (linked === null
      || isGatedActionTerminal(linked.status)
      || linked.approval_ref !== approvalRef
      || (currentAskId !== undefined
        && linked.current_ask_id !== desiredAskId)) {
      throw new Error('gated receipt did not retain the required approval link');
    }
    return linked;
  };

  let checkpoints;
  try {
    checkpoints = await deps.checkpointStore.list();
  } catch (e) {
    console.warn(
      '[preflight-boot-sweep] checkpoint list failed; skipping re-raise pass: '
        + (e instanceof Error ? e.message : String(e)),
    );
    return result;
  }

  for (const checkpoint of checkpoints) {
    result.inspected++;
    if (checkpoint.preapproval_nested_wait || (checkpoint.preapproval_execution_ref
      && !deps.canPublishReviewedCheckpoint?.(checkpoint))) continue;
    // D-182 §8 — a recipe-LESS raw-op hold has no recipe-run `AuditEntry`, so
    // recover it against the notification block's durable ask rows. This
    // closes both crash windows around the original hold sequence:
    //
    //   checkpoint -> receipt -> ask -> receipt/ask link
    //
    // A surviving unresolved ask wins and is merely linked; an `answered` ask
    // remains authority while its handler is retryable. Only an actually
    // missing ask is re-raised. On a list failure we leave the checkpoint
    // durable and retry next boot rather than risk creating a second decision.
    if (checkpoint.raw_op !== undefined) {
      const raw = checkpoint.raw_op;
      let action: GatedActionRecord | null = null;
      if (deps.gatedActionStore !== undefined) {
        try {
          action = await deps.gatedActionStore.getByCheckpoint(
            checkpoint.checkpoint_id,
          );
          action ??= await deps.gatedActionStore.createHeld({
            run_id: checkpoint.run_id,
            gated_step_id: RAW_OP_GATED_STEP_ID,
            checkpoint_id: checkpoint.checkpoint_id,
            ingredient_slug: raw.catalog_slug,
            operation_id: raw.operation,
            ...(raw.connection_name !== ''
              ? { connection_name: raw.connection_name }
              : {}),
            ...(checkpoint.preflight_context?.egress_bound !== undefined
              ? { approved_bound: checkpoint.preflight_context.egress_bound }
              : {}),
            ...(checkpoint.preflight_context?.gated_action_settlement_mode !== undefined
              ? {
                  settlement_mode:
                    checkpoint.preflight_context.gated_action_settlement_mode,
                }
              : {}),
          });
        } catch (error) {
          console.warn(
            `[preflight-boot-sweep] raw-op receipt recovery failed for checkpoint ${checkpoint.checkpoint_id}: `
              + (error instanceof Error ? error.message : String(error)),
          );
        }
        if (action === null) {
          // Once receipt support is wired, the durable operation identity is a
          // prerequisite for exposing a fresh decision. The checkpoint stays
          // retryable; a later boot can create and pair the receipt first.
          result.failed++;
          continue;
        }
        if (isGatedActionTerminal(action.status)) {
          result.terminal++;
          continue;
        }
      }

      let unresolvedAsks: ReadonlyArray<UnresolvedPreflightAsk>;
      try {
        if (deps.listUnresolvedAsks === undefined) {
          throw new Error('durable unresolved-ask reader is not wired');
        }
        unresolvedAsks = await deps.listUnresolvedAsks();
      } catch (error) {
        console.warn(
          `[preflight-boot-sweep] raw-op ask lookup failed for checkpoint ${checkpoint.checkpoint_id}; leaving it for the next boot: `
            + (error instanceof Error ? error.message : String(error)),
        );
        result.failed++;
        continue;
      }

      const existingAsk = unresolvedAsks.find(
        (ask) => ask.handler_kind === PREFLIGHT_HANDLER_KIND
          && ask.handler_payload.checkpoint_id === checkpoint.checkpoint_id,
      );
      if (existingAsk !== undefined) {
        if (action !== null) {
          try {
            await requireReceiptLink(
              action,
              action.approval_ref,
              existingAsk.ask_id,
            );
          } catch (error) {
            console.warn(
              `[preflight-boot-sweep] raw-op receipt pairing failed for checkpoint ${checkpoint.checkpoint_id}: `
                + (error instanceof Error ? error.message : String(error)),
            );
            result.failed++;
            continue;
          }
        }
        result.alreadyPaired++;
        continue;
      }

      const context: PreflightAskContext = {
        raw_op: { op_id: raw.op_id },
        tool_slug: raw.operation,
        ...(raw.connection_name !== ''
          ? { connection_name: raw.connection_name }
          : {}),
        risk_tier: raw.risk_tier,
        ...(checkpoint.preflight_context ?? {}),
      };
      try {
        if (action !== null) {
          action = await requireReceiptLink(action, action.action_ref, null);
        }
        const { ask_id } = await raisePreflightAsk(deps.notifier, {
          checkpoint,
          context,
        });
        if (action !== null) {
          try {
            await deps.gatedActionStore?.linkApproval(
              action.action_ref,
              action.approval_ref,
              ask_id,
            );
          } catch {
            /* the ask remains durable/actionable; retry receipt linkage at boot */
          }
        }
        result.raised++;
      } catch (error) {
        console.warn(
          `[preflight-boot-sweep] raw-op re-raise failed for checkpoint ${checkpoint.checkpoint_id}: `
            + (error instanceof Error ? error.message : String(error)),
        );
        result.failed++;
      }
      continue;
    }
    let anchor;
    try {
      anchor = await deps.auditLog.get(checkpoint.run_id);
    } catch (e) {
      console.warn(
        `[preflight-boot-sweep] auditLog.get(${checkpoint.run_id}) failed: `
          + (e instanceof Error ? e.message : String(e)),
      );
      result.failed++;
      continue;
    }
    if (anchor === null) {
      result.orphaned++;
      continue;
    }
    if ((anchor.commit_status === 'awaiting_approval'
        || anchor.commit_status === 'awaiting_peer')
      && anchor.checkpoint_id !== checkpoint.checkpoint_id) {
      // A run can hold more than once over its lifetime. Only the checkpoint
      // named by the current awaiting anchor may renew a receipt, re-raise an
      // ask, or participate in peer recovery; older rows are retention work.
      result.superseded++;
      continue;
    }
    // D-234 § 234.4 — a peer hold is skipped for the same reason a terminal row
    // is (nothing here to re-raise) but is NOT the same fact, so it is counted
    // apart. ⚠ Ordering matters: this must precede the terminal branch, or the
    // held run is silently absorbed into it.
    if (anchor.commit_status === 'awaiting_peer') {
      if (deps.gatedActionStore !== undefined
        && checkpoint.gated_step_id !== undefined) {
        let action: GatedActionRecord | null;
        try {
          action = await deps.gatedActionStore.getBySubject(
            checkpoint.run_id,
            checkpoint.gated_step_id,
          );
        } catch (error) {
          console.warn(
            `[preflight-boot-sweep] peer receipt lookup failed for run ${checkpoint.run_id}; leaving the hold for the next boot: `
              + (error instanceof Error ? error.message : String(error)),
          );
          result.failed++;
          continue;
        }
        const failure = knownPeerDeliveryFailure(action);
        if (failure !== undefined && action !== null) {
          try {
            await deps.auditLog.append(recoveredPeerDeliveryFailureEntry(
              anchor,
              checkpoint,
              action,
              failure,
              Date.now(),
            ));
            result.repairedPeerFailures++;
          } catch (error) {
            console.warn(
              `[preflight-boot-sweep] peer failure anchor repair failed for run ${checkpoint.run_id}; leaving the checkpoint for the next boot: `
                + (error instanceof Error ? error.message : String(error)),
            );
            result.failed++;
            continue;
          }
          try {
            await deps.checkpointStore.delete(checkpoint.checkpoint_id);
          } catch (error) {
            // The terminal anchor already prevents any resume. Retention can
            // reclaim the stale checkpoint; report the incomplete cleanup.
            console.warn(
              `[preflight-boot-sweep] repaired peer failure checkpoint cleanup failed for ${checkpoint.checkpoint_id}: `
                + (error instanceof Error ? error.message : String(error)),
            );
            result.failed++;
          }
          continue;
        }
      }
      result.heldForPeer++;
      continue;
    }
    if (anchor.commit_status !== 'awaiting_approval') {
      result.terminal++;
      continue;
    }
    // The anchor may have landed immediately before a crash, before the
    // operation receipt was created. Rebuild it from checkpoint metadata; no
    // held args are copied. This runs before the paired/passive branches so
    // every still-live hold gets a receipt regardless of how it is surfaced.
    let action: GatedActionRecord | null = null;
    if (deps.gatedActionStore !== undefined) {
      try {
        action = await deps.gatedActionStore.getByCheckpoint(
          checkpoint.checkpoint_id,
        );
        action ??= await deps.gatedActionStore.createHeld({
          run_id: checkpoint.run_id,
          ...(checkpoint.recipe_id !== undefined
            ? { recipe_id: checkpoint.recipe_id }
            : {}),
          gated_step_id: checkpoint.gated_step_id!,
          checkpoint_id: checkpoint.checkpoint_id,
          ...(checkpoint.gated_action_predecessor_ref !== undefined
            ? {
                predecessor_action_ref:
                  checkpoint.gated_action_predecessor_ref,
              }
            : {}),
          ...(checkpoint.approved_target?.ingredient_slug !== undefined
            ? { ingredient_slug: checkpoint.approved_target.ingredient_slug }
            : {}),
          ...(checkpoint.approved_target?.operation_id !== undefined
            ? { operation_id: checkpoint.approved_target.operation_id }
            : {}),
          ...(checkpoint.approved_target?.connection_name !== undefined
            ? { connection_name: checkpoint.approved_target.connection_name }
            : {}),
          ...(checkpoint.preflight_context?.egress_bound !== undefined
            ? { approved_bound: checkpoint.preflight_context.egress_bound }
            : {}),
          ...(checkpoint.preflight_context?.gated_action_settlement_mode !== undefined
            ? {
                settlement_mode:
                  checkpoint.preflight_context.gated_action_settlement_mode,
              }
            : {}),
        });
      } catch (error) {
        console.warn(
          `[preflight-boot-sweep] receipt recovery failed for run ${checkpoint.run_id}: `
            + (error instanceof Error ? error.message : String(error)),
        );
        result.failed++;
        continue;
      }
    }
    if (action !== null && isGatedActionTerminal(action.status)) {
      result.terminal++;
      continue;
    }

    // Membership is durable on the batch row before receipt grouping begins.
    // Discover it by checkpoint first: after a fresh create/JOIN crash the
    // newest member's receipt may still be standalone, and checkpoint listing
    // order must not decide whether it gets a duplicate per-member ask.
    if (deps.reconcileOpenBatch !== undefined) {
      try {
        const repaired = await deps.reconcileOpenBatch({
          checkpoint_id: checkpoint.checkpoint_id,
        });
        if (repaired.kind === 'reconciled') {
          result.alreadyPaired++;
          continue;
        }
      } catch (error) {
        console.warn(
          `[preflight-boot-sweep] batch membership recovery failed for checkpoint ${checkpoint.checkpoint_id}: `
            + (error instanceof Error ? error.message : String(error)),
        );
        result.failed++;
        continue;
      }
    }

    // A batch id is the durable decision identity; ask_id is merely its latest
    // render. Preserve a live/answered decision group even if the run anchor
    // lost that render pointer. Only an orphaned or abandoned group may return
    // to standalone, and that reset must verify before a new ask is exposed.
    if (action !== null && action.approval_ref !== action.action_ref) {
      let batch: Awaited<ReturnType<NonNullable<PreflightBootSweepDeps['getBatch']>>>;
      try {
        if (deps.getBatch === undefined) {
          throw new Error('batch membership reader is not wired');
        }
        batch = await deps.getBatch(action.approval_ref);
      } catch (error) {
        console.warn(
          `[preflight-boot-sweep] batch receipt lookup failed for action ${action.action_ref}: `
            + (error instanceof Error ? error.message : String(error)),
        );
        result.failed++;
        continue;
      }
      const ownsAction = batch?.members.some((member) =>
        member.action_ref === action!.action_ref
          || member.checkpoint_id === checkpoint.checkpoint_id) ?? false;
      const liveBatch = batch?.state === 'open' || batch?.state === 'closing';
      const answeredBatch = batch?.state === 'answered'
        && batch.answer_option !== undefined;
      if (ownsAction && (liveBatch || answeredBatch)) {
        if (batch?.state === 'open') {
          try {
            if (deps.reconcileOpenBatch === undefined) {
              throw new Error('open-batch reconciler is not wired');
            }
            const repaired = await deps.reconcileOpenBatch(action.approval_ref);
            if (repaired.kind !== 'reconciled') {
              throw new Error('batch left open state during reconciliation');
            }
          } catch (error) {
            console.warn(
              `[preflight-boot-sweep] live batch receipt repair failed for action ${action.action_ref}: `
                + (error instanceof Error ? error.message : String(error)),
            );
            result.failed++;
            continue;
          }
        } else if (batch?.state === 'closing') {
          // The notification block replay runs before this sweep. A still-
          // closing row owns an answered durable decision whose handler remains
          // retryable; never split it back into per-member asks here.
          try {
            action = await requireReceiptLink(
              action,
              action.approval_ref,
              batch.current_ask_id.length > 0
                ? batch.current_ask_id
                : undefined,
            );
          } catch (error) {
            console.warn(
              `[preflight-boot-sweep] closing batch receipt repair failed for action ${action.action_ref}: `
                + (error instanceof Error ? error.message : String(error)),
            );
            result.failed++;
            continue;
          }
        }
        result.alreadyPaired++;
        continue;
      }
      try {
        action = await requireReceiptLink(action, action.action_ref, null);
      } catch (error) {
        console.warn(
          `[preflight-boot-sweep] orphaned batch receipt reset failed for action ${action.action_ref}: `
            + (error instanceof Error ? error.message : String(error)),
        );
        result.failed++;
        continue;
      }
    }
    if (anchor.ask_id !== undefined) {
      if (action !== null) {
        try {
          await deps.gatedActionStore?.linkApproval(
            action.action_ref,
            action.approval_ref,
            anchor.ask_id,
          );
        } catch { /* next sweep or batch re-render can repair display linkage */ }
      }
      result.alreadyPaired++;
      continue;
    }
    // The ask store commits before delivery and before the host can pin the
    // render id onto this anchor. A crash (or an adapter that reports an error
    // after committing) therefore leaves an ask-less anchor beside a perfectly
    // live ask. Join on the handler's durable checkpoint capability before
    // considering a fresh render. `answered` is included: an answer whose
    // handler is retrying remains the one authoritative owner decision.
    let existingAsk: UnresolvedPreflightAsk | undefined;
    if (deps.listUnresolvedAsks !== undefined || action !== null) {
      try {
        if (deps.listUnresolvedAsks === undefined) {
          throw new Error('durable unresolved-ask reader is not wired');
        }
        const unresolvedAsks = await deps.listUnresolvedAsks();
        existingAsk = unresolvedAsks.find(
          (ask) => ask.handler_kind === PREFLIGHT_HANDLER_KIND
            && ask.handler_payload.checkpoint_id === checkpoint.checkpoint_id,
        );
      } catch (error) {
        console.warn(
          `[preflight-boot-sweep] recipe ask lookup failed for checkpoint ${checkpoint.checkpoint_id}; leaving it for the next boot: `
            + (error instanceof Error ? error.message : String(error)),
        );
        result.failed++;
        continue;
      }
    }
    if (existingAsk !== undefined) {
      try {
        if (action !== null) {
          action = await requireReceiptLink(
            action,
            action.approval_ref,
            existingAsk.ask_id,
          );
        }
        await deps.auditLog.append(awaitingEntryWithAsk(
          anchor,
          checkpoint,
          existingAsk.ask_id,
        ));
      } catch (error) {
        console.warn(
          `[preflight-boot-sweep] surviving ask repair failed for checkpoint ${checkpoint.checkpoint_id}: `
            + (error instanceof Error ? error.message : String(error)),
        );
        result.failed++;
        continue;
      }
      result.alreadyPaired++;
      continue;
    }
    // D-210 Phase C — a notify-mode reception hold is ask-less BY DESIGN.
    // Re-raising it here would hand the owner the actionable card they
    // turned off. Same scope fence as the raise site: reception-origin
    // only, so an ask-less MCP / chat hold (a raise that genuinely failed)
    // is still unstranded.
    if (
      deps.resolveInboxFanoutMode !== undefined
      && isReceptionOriginSource(anchor.execution_source)
      && deps.resolveInboxFanoutMode() === 'notify'
    ) {
      result.leftPassive++;
      continue;
    }
    // Awaiting + no ask_id — raise. The context is rebuilt from the
    // anchor's persisted fields (preflight-resumer.ts persists them on
    // the original raise). The structured `tool_slug` / `risk_tier` /
    // `reason` trio is not carried on the audit row today, so the
    // re-raised ask falls back to the bare "boundary-crossing call"
    // wording. A follow-on slice could persist them via the commit
    // sidecar; for now the basic re-raise is enough to unstrand the
    // run.
    const context: PreflightAskContext = {
      recipe_id: checkpoint.recipe_id,
      gated_step_id: checkpoint.gated_step_id,
      ...(checkpoint.preflight_context ?? {}),
    };
    let freshAskId: string;
    try {
      if (action !== null) {
        action = await requireReceiptLink(action, action.action_ref, null);
      }
      const { ask_id } = await raisePreflightAsk(deps.notifier, {
        checkpoint,
        context,
      });
      freshAskId = ask_id;
      if (action !== null) {
        try {
          await deps.gatedActionStore?.linkApproval(
            action.action_ref,
            action.approval_ref,
            freshAskId,
          );
        } catch { /* receipt linkage is best-effort; the ask remains actionable */ }
      }
    } catch (e) {
      console.warn(
        `[preflight-boot-sweep] re-raise failed for run ${checkpoint.run_id}: `
          + (e instanceof Error ? e.message : String(e)),
      );
      result.failed++;
      continue;
    }
    // Pin the fresh ask_id onto the anchor. A throw here leaves the ask
    // durable but unpinned; the next boot finds it through the unresolved-ask
    // index above and repairs this same pointer without minting a duplicate.
    try {
      const entry = awaitingEntryWithAsk(anchor, checkpoint, freshAskId);
      await deps.auditLog.append(entry);
      result.raised++;
    } catch (e) {
      console.warn(
        `[preflight-boot-sweep] failed to pin ask_id=${freshAskId} onto run ${checkpoint.run_id}: `
          + (e instanceof Error ? e.message : String(e)),
      );
      // Don't bump `raised` — the raise succeeded but the anchor
      // wasn't updated; the next boot will see the same condition and
      // re-try. Increment `failed` so the caller logs the partial-
      // success state.
      result.failed++;
    }
  }

  return result;
};
