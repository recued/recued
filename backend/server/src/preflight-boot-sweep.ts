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
 *  store, looks up its audit anchor, and raises a fresh
 *  `notification.ask` for any awaiting anchor whose `ask_id` is
 *  missing. The fresh `ask_id` then needs to be pinned back onto the
 *  audit row so subsequent boots don't double-raise — `auditLog.append`
 *  with the existing `run_id` re-writes the row via INSERT OR REPLACE,
 *  preserving every field except the freshly-set `ask_id`.
 *
 *  Idempotency. The sweep is safe to re-run: an anchor whose `ask_id`
 *  is already set is skipped. A crash mid-sweep between
 *  `raisePreflightAsk` and the audit re-write leaves the new `ask_id`
 *  durable in the AskStore (the block persists BEFORE delivery) but
 *  not yet pinned to the anchor; on next boot the same anchor is re-
 *  raised, persisting a SECOND ask_id and pinning that one. The first
 *  ask becomes orphaned but stays durable — the block's own boot
 *  sweep continues to re-deliver it. Acceptable trade-off (rare crash
 *  window; the durable AskStore's at-least-once invariant tolerates
 *  the extra ask). A stronger guard would pin the ask_id BEFORE
 *  releasing the raise, but that requires AskStore-level reservation
 *  which is out of slice scope.
 *
 *  Spec: docs/d-157-spec.md § A.3.
 */

import type { AuditLogStore, CheckpointStore } from '@recued/storage';
import { buildAuditEntry } from '@recued/storage';
import type { PreflightAskContext, PreflightNotifier } from '@recued/gateway';
import { raisePreflightAsk } from '@recued/gateway';
import { isReceptionOriginSource } from './reception-inbox-handler.js';
import type { ReceptionInboxFanoutMode } from '@recued/contracts';

export interface PreflightBootSweepDeps {
  readonly checkpointStore: CheckpointStore;
  readonly auditLog: AuditLogStore;
  readonly notifier: PreflightNotifier;
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
  /** Anchors that were already paired with an `ask_id` — no raise
   *  needed. */
  alreadyPaired: number;
  /** Awaiting anchors successfully re-raised + pinned with a fresh
   *  `ask_id`. */
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
 *  leaves the freshly-minted ask_id orphaned (see the module doc); the
 *  next boot retries the raise and pins a new ask_id. The sweep itself
 *  never throws; callers reading `result.failed > 0` decide whether to
 *  log a warning. */
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
    terminal: 0,
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
    // D-182 §8 — a recipe-LESS raw-op door hold has no recipe-run `AuditEntry`
    // anchor: this sweep (which pairs a checkpoint with an `awaiting_approval`
    // anchor to re-raise its ask) doesn't own it. Its open ask is durable in the
    // D-158 notification block, which re-surfaces it on boot (the block's
    // `recoverPendingAsks` re-fans-out open asks), so skip it here — without an
    // explicit skip it would land in `orphaned` (harmless, but misleading).
    if (checkpoint.raw_op !== undefined) continue;
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
    if (anchor.commit_status !== 'awaiting_approval') {
      result.terminal++;
      continue;
    }
    if (anchor.ask_id !== undefined) {
      result.alreadyPaired++;
      continue;
    }
    // ⚠ KNOWN GAP, DELIBERATELY NOT BUILT — the D-177 P5a BATCH case.
    // This sweep has no batch-aware branch. Batch members are covered only
    // INCIDENTALLY: each carries some `ask_id` (live or superseded), so they
    // land in `alreadyPaired` above. If a member's ask_id pin ever failed,
    // this sweep would mint a rogue PER-HOLD ask for a batch-owned
    // checkpoint — and `checkpoint-retention.ts` would then read that ask's
    // payload, see no `batch_id`, and expire a checkpoint a live batch
    // approve was about to resume (codex BLOCKER 1's failure mode through a
    // different door).
    //
    // Not built because the fix is not cheap and the window is pathological:
    // `BatchAskStore` has no `list()` and no checkpoint→batch reverse index,
    // so neither this sweep nor retention can ask "is this checkpoint batch-
    // owned?" without new store surface. And it needs ALL of: a batch-eligible
    // hold, a failed second audit append (a local SQLite write that just
    // succeeded), a restart, the batch open + unanswered past the staleness
    // window, and the owner then approving — while batches by construction
    // aggregate near-simultaneous holds.
    //
    // BUILD IT WHEN: `BatchAskStore` gains a second consumer (the reverse
    // index stops being bespoke), or batches start living for days.
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
    };
    let freshAskId: string;
    try {
      const { ask_id } = await raisePreflightAsk(deps.notifier, {
        checkpoint,
        context,
      });
      freshAskId = ask_id;
    } catch (e) {
      console.warn(
        `[preflight-boot-sweep] re-raise failed for run ${checkpoint.run_id}: `
          + (e instanceof Error ? e.message : String(e)),
      );
      result.failed++;
      continue;
    }
    // Pin the fresh ask_id onto the anchor. `buildAuditEntry` over the
    // re-hydrated anchor preserves every field; the audit collection's
    // INSERT OR REPLACE rewrites the row in place. A throw here leaves
    // the ask orphaned (durable in the AskStore + the block's recovery
    // sweep) but unpinned — the next boot's sweep re-raises and pins.
    try {
      const entry = buildAuditEntry({
        recipe_id: anchor.recipe_id,
        recipe_hash: anchor.recipe_hash,
        commit_status: 'awaiting_approval',
        duration_ms: anchor.duration_ms,
        errors: anchor.errors,
        config_snapshot: anchor.config_snapshot,
        trigger_url: anchor.trigger_url,
        trigger_source: anchor.trigger_source,
        instance_id: anchor.instance_id,
        run_id: anchor.run_id,
        now: anchor.finished_at,
        ...(anchor.recipe_insight_id !== undefined
          ? { recipe_insight_id: anchor.recipe_insight_id }
          : {}),
        ...(anchor.backfill ? { backfill: anchor.backfill } : {}),
        ...(anchor.process_id ? { process_id: anchor.process_id } : {}),
        ...(anchor.run_mode ? { run_mode: anchor.run_mode } : {}),
        ...(anchor.execution_source
          ? { execution_source: anchor.execution_source }
          : {}),
        ...(anchor.contract_snapshot
          ? { contract_snapshot: anchor.contract_snapshot }
          : {}),
        ...(anchor.channel_session_id
          ? { channel_session_id: anchor.channel_session_id }
          : {}),
        ...(anchor.cognition_session_id
          ? { cognition_session_id: anchor.cognition_session_id }
          : {}),
        ...(anchor.correlation_id
          ? { correlation_id: anchor.correlation_id }
          : {}),
        checkpoint_id: checkpoint.checkpoint_id,
        ask_id: freshAskId,
      });
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
