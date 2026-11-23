/** D-157 server-wiring — `PreflightResumer` implementation.
 *
 *  The `@recued/gateway` preflight leaf (D-157 P1 slice 4) defines a
 *  `PreflightResumer` interface with two callbacks:
 *
 *    - `resumeRun(checkpoint, context)` — re-instantiate a fresh
 *      execution from the consumed checkpoint, continuing PAST the
 *      gate (D-157 § A.2 step 5 / I-6).
 *    - `denyRun(checkpoint, context)` — record a `RECIPE_POLICY_DENIED`
 *      audit row pinned to the paused anchor's `run_id`, transitioning
 *      the run-anchor from `'awaiting_approval'` to `'failed'` (§ A.3).
 *
 *  The gateway leaf can't reach `recued-server`'s recipe store, audit
 *  log, or `handleExecute` — those live behind the public-boundary rule
 *  (`packages/` MUST NOT import `backend/`). This module is the host
 *  side of the seam: it composes the leaf's interface against the
 *  server-resident concrete dependencies.
 *
 *  Idempotency. The notification block's `on_answer` is at-least-once;
 *  if a crash interrupts the resume / deny path between
 *  `resumer.<call>(...)` and the `CheckpointStore.delete` that consumes
 *  the checkpoint, the boot sweep re-dispatches the same answer
 *  (D-158 N.3). Both callbacks defend against double-execution by
 *  inspecting the paused anchor's `commit_status` at entry:
 *
 *    - `'succeeded'` / `'failed'` (terminal)  → never re-dispatch. An exact
 *      host-stamped owner-denial row may first repair its operation receipt;
 *      every other terminal result is a no-op before checkpoint consumption.
 *    - `'awaiting_approval'` with a DIFFERENT `checkpoint_id` than the
 *      one this answer is for → no-op return (a later resume already
 *      wrote a newer awaiting state; the older checkpoint is stale).
 *    - `'awaiting_approval'` with the matching checkpoint id          → proceed.
 *
 *  Transient failures (`executeDeps` unavailable, `handleExecute`
 *  throws, deny audit-append throws) re-throw so the notification
 *  block leaves the ask `'answered'` and the next boot's sweep
 *  retries. The guard above makes a successful retry idempotent.
 *
 *  Spec: D-157 § A.2 / A.3 / I-6 / TR-5; the gateway-side
 *  contract is `packages/gateway/src/preflight-reconciliation.ts`.
 */

import { randomUUID } from 'node:crypto';
import { browserTrials } from './bridges/browser-trials.js';
import {
  canonicalRecipeDefinition,
  COMPENSATION_RECIPE_ID_PREFIX,
  hashRecipe,
} from '@recued/recipes';
import type {
  ChatDispatchResult,
  Checkpoint,
  RecipeDefinition,
  RecipeError,
  WebhookDeadLetterView,
} from '@recued/contracts';
import {
  executionSourceHasContract,
  RpcError,
  isGatedActionTerminal,
  isEphemeralDishId,
  readTriggerPreapprovalOffer,
  readKindGrantOffer,
  RUN_QUESTION_EACH_STEP,
  type RunQuestionAnswer,
} from '@recued/contracts';
import type { PreflightAskContext, PreflightResumer } from '@recued/gateway';
import {
  buildAuditEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import {
  handleExecute,
  RESTART_APPROVED_NOT_KEPT_UNHELD_MESSAGE,
  restartApprovedReturnedNotKeptMessage,
  RESTART_LATER_STEP_AFTER_LOOP_IN_DOUBT_MESSAGE,
  RESTART_LATER_STEP_AFTER_SKIP_IN_DOUBT_MESSAGE,
  restartHandoffUnprovenMessage,
  settleApprovedStepFromKeptValue,
} from './execute-handler.js';
import { observeResumedChatToolCall } from './chat-tool-call-context.js';
import { captureQualityDelegationSignal } from './quality-delegation-signal-capture.js';
import {
  denyRawOp,
  resumeRawOp,
  type RawOpResumeOutcome,
} from './raw-op-dispatch.js';
import { recordWriteRuleAnswer } from './write-rules.js';
import { recordChainAnswer, recordChainOutcome } from './chain-evidence.js';
import { recordBrowserPassAnswer } from './browser-passes.js';
import { projectRunResultForAgent } from './run-result-agent-projection.js';
import { finishResumedRun } from './resumed-run-finishers.js';
import { MCP_ACTION_NEXT_GATE_STATUS_MESSAGE, type McpActionStore } from './mcp-action-store.js';
import {
  gatedActionHandoffFromResult,
  type GatedActionRecord,
  type GatedActionStore,
} from './gated-action-store.js';
import { requiredResumeBearerToolNames } from './recipe-resume-authority.js';
import type { QualityDelegationSignalStore } from './storage/quality-delegation-signal-store.js';
import type {
  ApprovedRunFailure,
  ApprovedRunRestartStop,
  ExecuteRequest,
  ExecuteResponse,
} from './types.js';
import { carriedFromPausedRun } from './execution/paused-run-carry.js';
import { cleanupRunScratch } from './execution/run-scratch.js';
import { isRunRefusedForNow } from './pause-approval.js';
import { endRunPreapprovals } from './run-question.js';
import type {
  ApprovalRestartContinuation,
  ApprovalRestartContinuationStore,
  ApprovalRestartHeldRun,
} from './storage/approval-restart-continuation-store.js';

/** D-201 Slice 10N — thrown so the owner's answer to this approval stays
 *  answered and its checkpoint stays: the server's own stop ended the run, or
 *  the server was stopping when the answer came, and the next start resumes it
 *  without asking again (the answer handler deletes a checkpoint only after a
 *  resume returns; the start-up recovery replays an answered ask). */
export class ApprovedRunStoppedByRestartError extends Error {
  constructor(readonly run_id: string) {
    super(`[preflight-resumer] the server stopped while approved run ${run_id} was resuming; `
      + 'the next start finishes it');
    this.name = 'ApprovedRunStoppedByRestartError';
  }
}

const RESTART_IN_DOUBT = 'The server restarted while the approved operation was running, so Recued cannot tell '
  + 'whether it went through. Check before trying it again.';
const RESTART_CONTINUATION_IN_DOUBT = 'The approved operation ran before the server restarted, but the rest '
  + 'of the run could not be finished. Check before trying it again.';
const RESTART_NOT_KEPT = 'The server restarted during the approved run, and Recued could not keep it for the '
  + 'next start. Check before trying it again.';
/** D-201 Slice 10R — the approved step returned; a later one was under way. */
const RESTART_LATER_STEP_IN_DOUBT = 'The approved operation went through, but the server restarted while a later '
  + 'step was running, so Recued cannot tell whether that step went through. Check before trying it again.';
/** D-201 Slice 10W (10V findings 5 and 15) — what a kept run had sent, named:
 *  the approved step, and each later step that finished before the stop. 10R's
 *  messages named the approved step alone, or said "the rest did not run" of
 *  later steps that had, and an owner who ran the recipe again repeated them. */
const keptStepsWent = (
  gatedStepId: string,
  kept: ApprovalRestartContinuation,
  /** D-201 Slice 10BH — the approved step is a kept loop, whose items may
   *  have failed: named as its receipt says them. */
  loop: boolean,
  /** As a sentence of what had already happened ("had already gone through"). */
  had: boolean,
): string => {
  const later = (kept.later ?? []).filter((step) => !step.skipped).map((step) => `'${step.step_id}'`);
  // D-201 Slice 10BU (10BS finding 3) — the steps after it "ran": a later loop
  // all of whose items failed finished too, and was said to have gone through.
  const after = `the steps after it that had finished (${later.join(', ')}) ${had ? 'had run' : 'ran'}`;
  // D-201 Slice 10BZ (10BX finding 5) — skipped at the answer, as its receipt
  // reads (cancelled): the summaries said it ran for each of its items, or
  // went through.
  if (kept.approved_skipped === true) {
    const skipped = `The approved step '${gatedStepId}' ${had ? 'had been skipped' : 'was skipped'}`;
    return later.length === 0 ? skipped : `${skipped}, and ${after}`;
  }
  // D-201 Slice 10BN (10BM finding 4) — a kept loop ran for each of its items,
  // as the stop's and the start's records say: it said the loop went through,
  // of one some or all of whose items failed.
  if (loop) {
    const ran = `The approved step '${gatedStepId}' ${had ? 'had already run' : 'ran'} for each of its items, `
      + 'as its receipt says';
    return later.length === 0 ? `${ran},` : `${ran}, and ${after}`;
  }
  const approved = `The approved step '${gatedStepId}' ${had ? 'had already gone through' : 'went through'}`;
  return later.length === 0 ? approved : `${approved}, and ${after}`;
};

/** D-201 Slice 10R (10Q finding 17) — kept after its approved step went through,
 *  then refused at the next start because the recipe changed meanwhile.
 *  D-201 Slice 10W (10V finding 5) — naming what had gone through. */
const restartKeptRecipeChanged = (gatedStepId: string, kept: ApprovalRestartContinuation, loop = false): string =>
  `${keptStepsWent(gatedStepId, kept, loop, false)} before the server restarted, but the recipe changed `
  + 'before the rest of the run could finish, so the steps it had not reached did not run. Check before '
  + 'running it again.';

/** D-201 Slice 10AP (10AM finding 19) — a paused record, ended: what only a
 *  pause holds goes (its checkpoint and ask, the context it paused with, the
 *  connections it had), as `appendInDoubtAnchorUnlessSuperseded` drops them.
 *  Spread whole, a held run's ended record kept them. */
const endedRecord = (
  paused: AuditEntry,
  commitStatus: AuditEntry['commit_status'],
  finishedAt: number,
): AuditEntry => {
  const ended: AuditEntry = {
    ...paused,
    commit_status: commitStatus,
    finished_at: finishedAt,
    duration_ms: Math.max(0, finishedAt - paused.started_at),
  };
  delete ended.checkpoint_id;
  delete ended.ask_id;
  delete ended.context_snapshot;
  delete ended.connection_revisions;
  return ended;
};

/** D-201 Slice 10AP (10AM finding 19) — the engine's word for a pause it could
 *  not write, which a held run is not: it goes on from where it is held. */
const SCRATCH_CLAUSE = ' — run cannot be resumed; re-run from scratch';

/** D-201 Slice 10AP (10AM finding 19) — a held run's errors, worded as the
 *  held run it is: `undefined` when none says to run it from scratch. */
const heldWording = (
  errors: AuditEntry['errors'],
  stepId: string,
  /** D-201 Slice 10BH (10BF finding 1) — held at an approved step Recued cannot
   *  keep, after the run went past it: asked for again, the steps after it run
   *  again too. It said the try again goes on from that step. */
  asksAgainPast = false,
): AuditEntry['errors'] | undefined => {
  if (errors === undefined || !errors.some((error) => error.message.endsWith(SCRATCH_CLAUSE))) return undefined;
  const held = asksAgainPast
    ? `the run is held: trying it again asks you for '${stepId}' again, and the steps after it that ran run again too`
    : `the run is held: trying it again goes on from '${stepId}'`;
  return errors.map((error) => (error.message.endsWith(SCRATCH_CLAUSE)
    ? { ...error, message: `${error.message.slice(0, -SCRATCH_CLAUSE.length)} — ${held}` }
    : error));
};

/** D-201 Slice 10BH (10BF finding 1) — whether the row now held asks for its
 *  approved step again with the steps after it that ran, as Settings reads it:
 *  a run went past it, and Recued could not keep it. Such a row names the step
 *  the record is held from: the step it was held at before, held again. */
const heldAsksAgainPast = (
  continuations: ApprovalRestartContinuationStore | undefined,
  checkpointId: string,
): boolean => {
  try {
    const held = continuations?.get(checkpointId)?.held;
    return held !== undefined && !held.approved_returned && held.later_run_again === true;
  } catch {
    return false;
  }
};

/** D-201 Slice 10AK (10AI finding 14) — a try again that failed, its own
 *  record unwritten: the paused record it put back, ended as failed.
 *  D-201 Slice 10AP (10AM finding 19) — worded as the held run it is, held to
 *  go on from `stepId`. It said "re-run from scratch" of a run held to go on. */
const failedHeldRecord = (
  paused: AuditEntry,
  runId: string,
  stepId: string,
  errors: AuditEntry['errors'],
  /** D-201 Slice 10BH (10BF finding 1) — `heldWording`'s. */
  asksAgainPast = false,
): AuditEntry => {
  const finishedAt = Date.now();
  return {
    ...endedRecord(paused, 'failed', finishedAt),
    errors: errors !== undefined && errors.length > 0
      ? heldWording(errors, stepId, asksAgainPast) ?? errors
      : [{
          error_id: `held-run-failed-${finishedAt.toString(36)}-${runId}`,
          code: 'CHECKPOINT_WRITE_FAILED',
          message: `Trying the run again failed at '${stepId}', and its record could not be written. `
            + `The run is held: trying it again goes on from '${stepId}'. Check before trying it again.`,
          severity: 'fatal',
          source: { recipe_id: paused.recipe_id, step_id: stepId, ingredient_slug: null },
          details: { reason: 'held_run_record_unwritten' },
          timestamp: new Date(finishedAt).toISOString(),
          retryable: false,
        }],
  };
};

/** D-201 Slice 10W — the record of a held run whose try again ended unknown.
 *  D-201 Slice 10AV — `held_run_kept_ahead`: it stays held from the step it
 *  last wrote ahead (`onStepUnderWay`). The answer to its ask whose hold could
 *  not be written has its own record (`unwrittenHoldRecord`). */
const inDoubtRecord = (
  paused: AuditEntry,
  runId: string,
  cause: unknown,
  reason: 'held_run_not_kept' | 'held_run_died' | 'held_run_kept_ahead' = 'held_run_not_kept',
  stepId?: string,
  /** D-201 Slice 10BC (10AY finding 9) — the row that stands lags. */
  laterRunAgain = false,
): AuditEntry => {
  const finishedAt = Date.now();
  return {
    ...endedRecord(paused, 'in_doubt', finishedAt),
    errors: [{
      error_id: `held-run-in-doubt-${finishedAt.toString(36)}-${runId}`,
      code: 'ACTION_DELIVERY_UNCERTAIN',
      message: (reason === 'held_run_died'
        ? 'The server stopped while the run was tried again, so Recued cannot tell how far it got or what it sent. '
        : reason === 'held_run_kept_ahead'
          ? `Recued could not keep how the try again ended, so it cannot tell whether '${stepId}' went through. `
            + `It stays held from there: trying it again goes on from '${stepId}', with what ran before it kept`
            + `${laterRunAgain ? ', and the steps after it that ran run again too' : ''}. `
          : 'Trying the run again stopped before it could be kept, so Recued cannot tell what it sent. ')
        + 'Check before trying it again.',
      severity: 'fatal',
      source: { recipe_id: paused.recipe_id, step_id: stepId ?? null, ingredient_slug: null },
      details: { reason, cause: cause instanceof Error ? cause.message : String(cause) },
      timestamp: new Date(finishedAt).toISOString(),
      retryable: false,
    }],
  };
};

/** D-201 Slice 10AP (10AM findings 5 and 18) — the record of the answer to a
 *  held run's ask whose hold could not be written: `held_run_hold_unwritten`,
 *  the run past its approved step and failing later; `held_run_mark_unwritten`,
 *  the asked step itself failing. D-201 Slice 10AV — it says what the row that
 *  stands does (findings 7 and 19), names the approved step as the approved
 *  one and the failed step as the failed one (finding 16: it named the failed
 *  step as the approved one), and keeps the run's own errors after it (it lost
 *  why the step failed). */
const unwrittenHoldRecord = (
  paused: AuditEntry,
  checkpoint: Checkpoint,
  cause: unknown,
  reason: 'held_run_hold_unwritten' | 'held_run_mark_unwritten',
  failedStep: string,
  standing: ApprovalRestartHeldRun | undefined,
  own: AuditEntry['errors'],
): AuditEntry => {
  const finishedAt = Date.now();
  const approved = checkpoint.gated_step_id ?? failedStep;
  // D-201 Slice 10BC (10AY finding 9) — a row a later write could not replace.
  const lags = standing?.later_run_again === true ? ', and the steps after it that ran run again too' : '';
  const stays = standing !== undefined && standing.approved_returned
    ? `It stays held from '${standing.step_in_doubt}': trying it again goes on from it, with what ran before it kept`
      + lags
    : reason === 'held_run_hold_unwritten'
      // Every write refused: the row stands at the ask, as it was moved there.
      ? `It stays held at '${standing?.step_in_doubt ?? approved}': trying it again asks you for that step again, `
        + 'and the steps after it that ran run again'
      : `It stays held there: trying it again asks you for that step again${lags}`;
  return {
    ...endedRecord(paused, 'in_doubt', finishedAt),
    errors: [{
      error_id: `held-run-in-doubt-${finishedAt.toString(36)}-${checkpoint.run_id}`,
      code: 'ACTION_DELIVERY_UNCERTAIN',
      message: (reason === 'held_run_hold_unwritten'
        ? `The run went past its approved step '${approved}' and then failed at '${failedStep}', and Recued could `
          + 'not keep that, so it cannot tell what it sent. '
        : `Its approved step '${approved}' failed, and Recued could not mark the run held from it. `)
        + `${stays}. Check before trying it again.`,
      severity: 'fatal',
      source: { recipe_id: paused.recipe_id, step_id: standing?.step_in_doubt ?? approved, ingredient_slug: null },
      details: { reason, cause: cause instanceof Error ? cause.message : String(cause) },
      timestamp: new Date(finishedAt).toISOString(),
      retryable: false,
    }, ...(own ?? [])],
  };
};

/** D-201 Slice 10AV (10AS finding 14) — a record whose write a fault refused
 *  once is written again: left as the handler wrote it (`failed`), the
 *  reconcile cancelled the delivery. A fault that lasts throws, as before. */
const appendRetrying = async (
  auditLog: Pick<AuditLogStore, 'append'>,
  entry: AuditEntry,
  tries = 3,
): Promise<void> => {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      await auditLog.append(entry);
      return;
    } catch (error) {
      last = error;
    }
  }
  throw last;
};

/** D-201 Slice 10W — a webhook run whose approved run a stop left in doubt is
 *  kept for the owner's try again from its dead letter (`held`); one of any
 *  other trigger has no try again to keep it for. */
const isWebhookRun = (anchor: AuditEntry): boolean => anchor.trigger_source === 'webhook';

/** D-201 Slice 10AV (10AS finding 9) — a receipt the start froze in doubt: it
 *  was dispatching when the process went (`reconcileInterruptedGatedActionsAtBoot`). */
const frozenAtTheStart = (action: { readonly status: string; readonly result?: unknown }): boolean =>
  action.status === 'in_doubt'
  && typeof action.result === 'object' && action.result !== null
  && (action.result as { reason?: unknown }).reason === 'server_restarted_while_dispatching';

/** D-201 Slice 10BO (10BM finding 8) — a receipt frozen in doubt rather than
 *  settled from what the step returned: by the start (`frozenAtTheStart`), or
 *  by the run's own fallback when its handler threw after the rows it wrote
 *  ahead and the settle from them was refused (`settleInterruptedGatedAction`).
 *  Neither says anything of a step its row says came back. */
const frozenInDoubt = (action: { readonly status: string; readonly result?: unknown }): boolean =>
  frozenAtTheStart(action)
  || (action.status === 'in_doubt'
    && typeof action.result === 'object' && action.result !== null
    && (action.result as { reason?: unknown }).reason === 'approved_recipe_dispatch_interrupted');

/** D-201 Slice 10AV (10AS finding 9) — at the start, before receipts still
 *  dispatching are frozen in doubt: one whose run wrote, before a later step,
 *  that its approved step had come back (`onStepUnderWay`) is settled from the
 *  value it kept, as a stop that found the step returned settles it. Frozen, it
 *  said the approved operation may not have gone through, beside a held run
 *  that goes on past it. How many were settled. */
export const settleReturnedApprovedDispatchesAtBoot = async (
  store: GatedActionStore,
  continuations: Pick<ApprovalRestartContinuationStore, 'get' | 'put'>,
): Promise<number> => {
  let settled = 0;
  for (const action of await store.list()) {
    if (action.status !== 'dispatching' || action.origin === 'preapproval_member'
      || action.current_checkpoint_id === undefined) continue;
    const outcome = await settleFromHeldRow(store, continuations, action, action.current_checkpoint_id);
    if (outcome.kind === 'went_through') settled += 1;
    if (outcome.kind === 'fault') {
      console.warn(
        `[preflight-resumer] approved step receipt ${action.action_ref} not settled from its held row: `
          + (outcome.error instanceof Error ? outcome.error.message : String(outcome.error)),
      );
    }
  }
  return settled;
};

/** D-201 Slice 10BI (10BF finding 5) — an approved step's receipt settled in
 *  doubt for a hand-off it could not check, as the live stop reads it. */
const receiptHandoffUnproven = (
  receipt: Pick<GatedActionRecord, 'status' | 'settlement_mode'> | null | undefined,
): boolean => receipt?.status === 'in_doubt' && receipt.settlement_mode === 'durable_handoff';

/** D-201 Slice 10BV (10BS finding 6) — whether the try again reads this receipt
 *  as a hand-off it cannot check, and so asks for the approved step again
 *  (`heldAsItsReceiptReads`): a row written ahead of its receipt, settled for
 *  such a hand-off, and not frozen. The records read it too, so they say what
 *  the try again does: beside a receipt frozen in doubt they said it asks for
 *  the step again, while the try again trusts the row and goes on. */
const tryAgainReadsHandoff = (
  held: Pick<ApprovalRestartHeldRun, 'receipt_unsettled'>,
  receipt: Pick<GatedActionRecord, 'status' | 'settlement_mode' | 'result'> | null | undefined,
): boolean => held.receipt_unsettled === true
  && receipt !== null && receipt !== undefined
  && isGatedActionTerminal(receipt.status)
  && !frozenInDoubt(receipt)
  && receiptHandoffUnproven(receipt);

/** D-201 Slice 10CA (10BX finding 12) — a hand-off's receipt frozen in doubt
 *  before Recued could check the hand-off: the try again trusts the row, which
 *  says the step came back, and goes on past it. The record said the step went
 *  through, as of a plain one. */
const receiptHandoffFrozen = (
  receipt: Pick<GatedActionRecord, 'status' | 'settlement_mode' | 'result'> | null | undefined,
): boolean => receipt !== null && receipt !== undefined && frozenInDoubt(receipt) && receiptHandoffUnproven(receipt);

/** D-201 Slice 10BC (10AY finding 11) — whether an approved step's receipt reads
 *  as gone through, as the live stop reads it (`settleRestartStop`). */
const receiptWentThrough = (status: string | undefined, approvedForeach = false, approvedSkipped = false): boolean =>
  status === 'succeeded' || status === 'dispatched'
  // D-201 Slice 10BH — a kept loop's items, some or all failed, are as known.
  || (approvedForeach && (status === 'partial' || status === 'failed'))
  // D-201 Slice 10BJ (10BF finding 9) — a skipped step's, cancelled, as the
  // live stop reads it.
  || (approvedSkipped && status === 'cancelled');

/** D-201 Slice 10BC (10AY finding 11) — a held row past its approved step whose
 *  receipt does not read as gone through (a hand-off it cannot prove): held at
 *  the approved step instead, as the live stop holds such a run, the steps after
 *  it that ran to run again too. The row said the step went through beside a
 *  receipt in doubt, and its try again went on past it. The held run as now
 *  kept; undefined when it could not be written. */
export const holdAtApprovedStep = (
  continuations: Pick<ApprovalRestartContinuationStore, 'put'>,
  row: ApprovalRestartContinuation,
  /** D-201 Slice 10BI (10BF finding 5) — its receipt reads a hand-off it cannot
   *  check (`receiptHandoffUnproven`), so its words say that. */
  handoffUnproven = false,
): ApprovalRestartHeldRun | undefined => {
  if (row.held === undefined) return undefined;
  const held: ApprovalRestartHeldRun = {
    checkpoint: row.held.checkpoint,
    anchor: row.held.anchor,
    approved_returned: false,
    step_in_doubt: row.gated_step_id,
    ...(row.held.progress_unknown === true ? { progress_unknown: true as const } : {}),
    later_run_again: true,
    ...(handoffUnproven ? { handoff_unproven: true as const } : {}),
  };
  // D-201 Slice 10BJ (10BF finding 8) — tried again, as the start's settle is:
  // refused once, the row past the step stood, trusted.
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      continuations.put({
        checkpoint_id: row.checkpoint_id,
        run_id: row.run_id,
        gated_step_id: row.gated_step_id,
        value: undefined,
        later: [],
        held,
        ...(row.held_before !== undefined ? { held_before: row.held_before } : {}),
      });
      return held;
    } catch (error) {
      last = error;
    }
  }
  console.warn(
    `[preflight-resumer] run ${row.run_id} not held at its approved step: `
      + (last instanceof Error ? last.message : String(last)),
  );
  return undefined;
};

/** D-201 Slice 10BC (10AY finding 11) — an approved step's receipt still
 *  dispatching, settled from the held row its run wrote ahead, read as the live
 *  stop reads it: gone through, the row standing; or not (a hand-off it cannot
 *  prove), the run held at the approved step. A fault is tried again, as the
 *  record's write is: one left the receipt to be frozen in doubt beside a row
 *  that says the step went through. `none`: no held row past this step. */
const settleFromHeldRow = async (
  store: GatedActionStore,
  continuations: Pick<ApprovalRestartContinuationStore, 'get' | 'put'>,
  action: Pick<GatedActionRecord, 'action_ref' | 'run_id' | 'gated_step_id'>,
  checkpointId: string,
  tries = 3,
): Promise<
  | { readonly kind: 'none' }
  | { readonly kind: 'went_through' }
  | { readonly kind: 'held_at_approved'; readonly held: ApprovalRestartHeldRun | undefined }
  | { readonly kind: 'fault'; readonly error: unknown }
> => {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const row = continuations.get(checkpointId);
      if (row === null || row.held === undefined || !row.held.approved_returned
        || row.run_id !== action.run_id || row.gated_step_id !== action.gated_step_id) return { kind: 'none' };
      if (await settleApprovedStepFromKeptValue(
        store, action.action_ref, row.gated_step_id, row.value, row.held.approved_foreach === true,
        row.held.approved_skipped === true,
      )) {
        return { kind: 'went_through' };
      }
      return {
        kind: 'held_at_approved',
        // Its words only: a receipt it cannot read leaves the hold as it is.
        held: holdAtApprovedStep(continuations, row,
          receiptHandoffUnproven(await store.get(action.action_ref).catch(() => null))),
      };
    } catch (error) {
      last = error;
    }
  }
  return { kind: 'fault', error: last };
};

/** D-201 Slice 10BJ (10BF finding 8) — the held run a try again goes on from,
 *  as the approved step's receipt reads: a row that says the step came back,
 *  beside a settled receipt that does not read as gone through (a hand-off it
 *  cannot check, whose hold at that step the start could not write), is held
 *  at the step now, as the start would have held it, so the try again asks for
 *  it again. It replayed the step as gone through. A receipt the start froze
 *  in doubt, or one it cannot read, leaves the row as it is: the step came back.
 *
 *  D-201 Slice 10BO (10BM findings 2 and 8) — only as 10BJ meant it: a row
 *  written ahead by the run that ran the approved step (`receipt_unsettled`),
 *  whose receipt a stop or the start settled after it, and only a receipt that
 *  reads a hand-off it cannot check, which they hold at the step. It read any
 *  receipt not gone through: after a later step's failure on the answer's road
 *  past such a hand-off (a row written once the receipt was settled), the try
 *  again asked for the hand-off again and ran it and each step after it again,
 *  while Settings and the guide said only the failed step could run twice.
 *  Nor a receipt the run's own fallback froze, as the start's freeze is not. */
const heldAsItsReceiptReads = async (
  continuations: Pick<ApprovalRestartContinuationStore, 'put'>,
  store: GatedActionStore | undefined,
  row: ApprovalRestartContinuation,
): Promise<ApprovalRestartHeldRun> => {
  const held = row.held!;
  if (!held.approved_returned || held.receipt_unsettled !== true || store === undefined) return held;
  const receipt = await store.getByCheckpoint(row.checkpoint_id).catch(() => null);
  if (!tryAgainReadsHandoff(held, receipt)) return held;
  // Not written, held so for this try all the same: never replayed as gone through.
  return holdAtApprovedStep(continuations, row, true) ?? {
    checkpoint: held.checkpoint,
    anchor: held.anchor,
    approved_returned: false,
    step_in_doubt: row.gated_step_id,
    ...(held.progress_unknown === true ? { progress_unknown: true as const } : {}),
    later_run_again: true,
    handoff_unproven: true,
  };
};

/** D-201 Slice 10R (10Q finding 2) — a run kept for the next start keeps its
 *  temp files and its "Yes, this time" pre-approvals (`handleExecute` leaves
 *  them, as for a pause). When the keep fails they go now, as at any run's end. */
export const releaseUnkeptRun = (executeDeps: Pick<ExecuteHandlerDeps, 'triggerPreapprovals'>, runId: string): void => {
  cleanupRunScratch(runId);
  endRunPreapprovals(executeDeps.triggerPreapprovals, runId);
};

/** What this implementation needs from the surrounding server. The
 *  three dependencies are wired by `bin.ts` after `executeDeps` exists. */
/** D-137 — a run reached a terminal outcome, LATER than the turn that asked
 *  for it. The chat orchestrator uses this to write the result half of the
 *  paired tool rows; anything else may ignore it.
 *
 *  ⚠ `execution_source` is the ORIGINATING one, recovered from the paused
 *  anchor — not the approver's. A row written under the approver would land in
 *  the wrong corpus, and for a door that is a cross-tenant write. */
export interface PreflightRunSettled {
  readonly execution_source: unknown;
  readonly run_id: string;
  readonly tool_name: string;
  readonly result: unknown;
  readonly ts: number;
  /** Host-observed uncertainty cannot be rendered as a proven failure. */
  readonly state?: 'succeeded' | 'failed' | 'interrupted';
}

export interface CreatePreflightResumerDeps {
  /** D-137 — see {@link PreflightRunSettled}. Optional: absent means late
   *  results simply are not recallable, which is the behaviour before this. */
  readonly onRunSettled?: (settled: PreflightRunSettled) => void;
  /** Lazy accessor for `executeDeps`. The resumer is constructed
   *  BEFORE `executeDeps` is built (because the notification block,
   *  which threads as `executeDeps.preflightNotifier`, takes the
   *  resumer's handler at registration time). A thunk breaks the
   *  cycle — the resumer doesn't dereference until an answer actually
   *  arrives, well after bootstrap. */
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  /** Read the paused run's audit row by `run_id` so the resume can
   *  recover `execution_source` + `contract_snapshot` + the original
   *  `trigger_source` / `config_snapshot`. Also gates the idempotency
   *  guard — a row in terminal state means the run already completed
   *  on a prior attempt; the resumer no-ops. */
  auditLog: AuditLogStore;
  /** Storage is available before executeDeps is late-bound, so denial can
   * settle a continuation even during boot recovery. */
  mcpActionStore?: McpActionStore;
  /** Operation-scoped owner receipt; deliberately independent of the MCP
   * invocation-level continuation above. */
  gatedActionStore?: GatedActionStore;
  /** Exact durable ownership check for dispatches transferred to a replayable
   * substrate (currently the peer-delivery journal). */
  preserveClaimedDispatch?: (
    record: GatedActionRecord,
  ) => boolean | Promise<boolean>;
  /** D-202 Slice 1b — the durable quality VERDICT store. When wired, a resolved
   *  QUALITY-relevant ask (`Checkpoint.quality_relevant`) records one
   *  `QualityDelegationSignal` (approve → `quality_good`, deny → `quality_bad`)
   *  for the reject-driven learner. Best-effort + never load-bearing for the
   *  resume/deny — absent (dbless harness / no contract store) ⇒ no signal is
   *  recorded and the approve/deny path is byte-identical to pre-1b. */
  qualityDelegationSignalStore?: QualityDelegationSignalStore;
}

/** Async-action persistence must never change whether an approved effect runs.
 * A failed continuation receipt is observable degradation, not dispatch
 * authority, so every write is best-effort and loudly logged. */
const updateMcpAction = async (
  store: McpActionStore | undefined,
  runId: string,
  operation: (store: McpActionStore) => Promise<unknown>,
): Promise<void> => {
  if (store === undefined) return;
  try {
    await operation(store);
  } catch (error) {
    console.warn(
      `[preflight-resumer] MCP action update failed for run_id=${runId}: `
        + (error instanceof Error ? error.message : String(error)),
    );
  }
};

/** Denial is the one terminal receipt transition that can safely remain
 * load-bearing for answer handling: no provider effect ran, so retaining the
 * answered ask + checkpoint for retry cannot duplicate work. Verify the
 * postcondition as well as the returned promise because a storage adapter may
 * report an error after committing. */
const settleDeniedGatedAction = async (
  store: GatedActionStore | undefined,
  checkpoint: Checkpoint,
  input: { status_message: string; result: unknown },
): Promise<void> => {
  if (store === undefined) return;
  const action = await store.getByCheckpoint(checkpoint.checkpoint_id);
  // Additive compatibility: a legacy hold created before receipt support has
  // no row to settle. Its audit/checkpoint behavior remains unchanged.
  if (action === null) return;
  let settled;
  try {
    settled = await store.finish(action.action_ref, {
      status: 'denied',
      status_message: input.status_message,
      result: input.result,
      observed: { items: 1, succeeded: 0, failed: 0 },
    });
  } catch (error) {
    try {
      settled = await store.get(action.action_ref);
    } catch {
      throw error;
    }
    if (settled?.status !== 'denied') throw error;
  }
  if (settled === null) {
    throw new Error(
      `[preflight-resumer] denial receipt disappeared for run_id=${checkpoint.run_id}`,
    );
  }
  if (settled.status === 'denied') return;
  // A different terminal result already won its immutable CAS. Never rewrite
  // it as a denial; the conflict is observable but not retryable.
  if (isGatedActionTerminal(settled.status)) {
    console.warn(
      `[preflight-resumer] denial receipt conflict for run_id=${checkpoint.run_id}: `
        + `receipt is already terminal with status='${settled.status}'`,
    );
    return;
  }
  throw new Error(
    `[preflight-resumer] denial receipt did not reach terminal status for run_id=${checkpoint.run_id}`,
  );
};

/** Validation and live-authority failures happen before an approved effect is
 * dispatched, but their run anchor is written before the owner receipt. Keep
 * the checkpoint retryable until this exact terminal receipt is verifiably
 * durable; a write may commit and then lose its acknowledgement. */
const settleFailedGatedAction = async (
  store: GatedActionStore | undefined,
  checkpoint: Checkpoint,
  input: { status_message: string; result: unknown },
): Promise<void> => {
  if (store === undefined) return;
  const action = await store.getByCheckpoint(checkpoint.checkpoint_id);
  if (action === null) {
    if (checkpoint.preflight_context?.gated_action_settlement_mode !== undefined) {
      throw new Error(
        `[preflight-resumer] receipt-backed checkpoint has no valid gated action for run_id=${checkpoint.run_id}`,
      );
    }
    return;
  }
  let settled;
  try {
    settled = await store.finish(action.action_ref, {
      status: 'failed',
      status_message: input.status_message,
      result: input.result,
      observed: { items: 1, succeeded: 0, failed: 1 },
    });
  } catch (error) {
    try {
      settled = await store.get(action.action_ref);
    } catch {
      throw error;
    }
    if (settled?.status !== 'failed') throw error;
  }
  if (settled === null) {
    throw new Error(
      `[preflight-resumer] failed receipt disappeared for run_id=${checkpoint.run_id}`,
    );
  }
  if (settled.status === 'failed') return;
  if (isGatedActionTerminal(settled.status)) {
    console.warn(
      `[preflight-resumer] failed receipt conflict for run_id=${checkpoint.run_id}: `
        + `receipt is already terminal with status='${settled.status}'`,
    );
    return;
  }
  throw new Error(
    `[preflight-resumer] failed receipt did not reach terminal status for run_id=${checkpoint.run_id}`,
  );
};

type RecipeDispatchClaim =
  | { kind: 'legacy_without_receipt' }
  | { kind: 'claimed'; action: GatedActionRecord }
  | { kind: 'already_terminal'; action: GatedActionRecord }
  | { kind: 'already_dispatching'; action: GatedActionRecord }
  | { kind: 'superseded'; action: GatedActionRecord }
  /** D-201 Slice 10N — the server's own stop ended this approved run after its
   *  step returned (its receipt is settled): the run is finished from there,
   *  with the step's value standing in for it. Nothing is claimed. */
  | { kind: 'continuation'; continuation: ApprovalRestartContinuation };

/** D-201 Slice 10N — the receipt statuses a returned step settles to. */
const CONTINUABLE_RECEIPT_STATUSES: ReadonlySet<GatedActionRecord['status']> = new Set([
  'succeeded', 'dispatched', 'cancelled',
]);

/** D-201 Slice 10BH — a receipt a kept value can go on from: also a kept loop's
 *  whose items some or all failed, settled so from the value a stop kept. Only
 *  a loop's checkpoint (a gate raised in a loop carries its progress): a single
 *  step's receipt read failed is not one it went through. */
const continuableReceipt = (status: GatedActionRecord['status'], checkpoint: Checkpoint): boolean =>
  CONTINUABLE_RECEIPT_STATUSES.has(status)
  || ((status === 'partial' || status === 'failed') && checkpoint.foreach_progress !== undefined);

/** The value a restart kept for this answered checkpoint, when it is this
 *  run's and its receipt was settled from the step: anything else is dropped,
 *  and the answer resumes as any other (a settled receipt then reads in doubt). */
const restartContinuationFor = async (
  continuations: ApprovalRestartContinuationStore | undefined,
  store: GatedActionStore | undefined,
  checkpoint: Checkpoint,
): Promise<ApprovalRestartContinuation | undefined> => {
  if (continuations === undefined) return undefined;
  const row = continuations.get(checkpoint.checkpoint_id);
  if (row === null) return undefined;
  // D-201 Slice 10W — nothing to replay: an unsent row waits on its receipt
  // (`reawaitUnsentReceipt`), and a held row on the owner's try again.
  if (row.unsent === true || row.held !== undefined) return undefined;
  const receipt = store === undefined ? null : await store.getByCheckpoint(checkpoint.checkpoint_id);
  if (row.run_id !== checkpoint.run_id
    || row.gated_step_id !== checkpoint.gated_step_id
    // D-201 Slice 10R — a row from before 10R kept the approved step alone:
    // what ran after it is unknown, and replaying it would send that again.
    || row.later === undefined
    || checkpoint.run_question !== undefined
    || receipt === null
    || !continuableReceipt(receipt.status, checkpoint)) {
    continuations.delete(checkpoint.checkpoint_id);
    return undefined;
  }
  return row;
};

/** D-201 Slice 10W (10V finding 3) — keep what the server's own stop left, from
 *  the run's own report: synchronous, so it lands before the handler records
 *  the run `killed` or `in_doubt`. Returns the row now in place.
 *    - `unsent`: the approved step never started. Its receipt goes back to
 *      waiting at the next start (`reawaitUnsentReceipt`), for this answer.
 *    - `returned`: the approved step and the later steps that finished, to
 *      stand in for them at the next start (10R), with the paused record.
 *    - `held`: a webhook run left in doubt, for the owner's try again from its
 *      dead letter (10V finding 1): what went through, the step in doubt, and
 *      copies of the checkpoint and paused record, which the answer's end
 *      deletes. A run of any other trigger has no try again: nothing is kept.
 *  A continuation run stopped before anything more ran keeps its row. */
const keepStopNow = (
  continuations: ApprovalRestartContinuationStore,
  checkpoint: Checkpoint,
  paused: AuditEntry,
  claim: RecipeDispatchClaim['kind'],
  outcome: ApprovedRunRestartStop,
  /** D-201 Slice 10AG — the held run this answer's resume belongs to, kept
   *  with the row (`held_before`) for the next start's finish. */
  heldBefore?: ApprovalRestartHeldRun,
  /** D-201 Slice 10BO (10BM finding 2) — a row written ahead, before a step,
   *  rather than the stop's own. */
  writtenAhead = false,
): 'unsent' | 'returned' | 'held' | 'none' => {
  const base = {
    checkpoint_id: checkpoint.checkpoint_id,
    run_id: checkpoint.run_id,
    gated_step_id: checkpoint.gated_step_id!,
  };
  if (outcome.kind === 'unsent') {
    if (claim !== 'claimed') return 'returned';
    continuations.put({
      ...base,
      value: undefined,
      later: [],
      unsent: true,
      paused_anchor: paused,
      ...(heldBefore !== undefined ? { held_before: heldBefore } : {}),
    });
    return 'unsent';
  }
  if (outcome.kind === 'returned') {
    continuations.put({
      ...base,
      value: outcome.value,
      later: outcome.later,
      ...(outcome.pii_ledgers !== undefined ? { pii_ledgers: outcome.pii_ledgers } : {}),
      paused_anchor: paused,
      ...(heldBefore !== undefined ? { held_before: heldBefore } : {}),
      // D-201 Slice 10BO (10BM finding 7) — so the next start replays it as
      // skipped. Dropped, it replayed the step as one that ran.
      ...(outcome.approved_skipped === true ? { approved_skipped: true as const } : {}),
    });
    return 'returned';
  }
  if (!isWebhookRun(paused)) return 'none';
  const returned = outcome.step_id !== undefined;
  continuations.put({
    ...base,
    value: returned ? outcome.value : undefined,
    later: returned ? outcome.later ?? [] : [],
    ...(returned && outcome.pii_ledgers !== undefined ? { pii_ledgers: outcome.pii_ledgers } : {}),
    held: {
      checkpoint,
      anchor: paused,
      approved_returned: returned,
      step_in_doubt: outcome.step_id ?? checkpoint.gated_step_id!,
      // D-201 Slice 10AP (10AM finding 4) — the held run this resume went on
      // with, stopped again: what a death left unknown still is. Only a later
      // ask bounds it (`moveHeldToAsk`), and its row then carries none.
      ...(heldBefore?.progress_unknown === true ? { progress_unknown: true as const } : {}),
      // D-201 Slice 10BC (10AY findings 2 and 9) — past an approved step Recued
      // cannot keep, or carried as a death's unknown progress is.
      ...(outcome.later_run_again === true || heldBefore?.later_run_again === true
        ? { later_run_again: true as const }
        : {}),
      // D-201 Slice 10BH — a kept loop, for the start's receipt.
      ...(returned && outcome.approved_foreach === true ? { approved_foreach: true as const } : {}),
      // D-201 Slice 10BJ (10BF finding 9) — skipped, for the start's receipt.
      ...(returned && outcome.approved_skipped === true ? { approved_skipped: true as const } : {}),
      // D-201 Slice 10BI (10BF finding 5) — a hand-off it cannot check.
      ...(!returned && outcome.handoff_unproven === true ? { handoff_unproven: true as const } : {}),
      // D-201 Slice 10BO (10BM finding 2) — written ahead by the run that ran
      // the approved step: its receipt is settled after this row.
      ...(returned && writtenAhead && claim === 'claimed' ? { receipt_unsettled: true as const } : {}),
    },
  });
  return 'held';
};

/** D-201 Slice 10BC (10AY finding 9) — a row written ahead was refused: the row
 *  that stands, from an earlier step, is marked so the try again runs again the
 *  steps after it that went through, and Settings says so. It said only that
 *  step could run twice, and two notices that went through were sent again.
 *  Only a flag is written, never the values again, so a step value that cannot
 *  be stored, which refused the row, does not refuse the mark. Not marked when
 *  the row that stands is this step's (nothing past it ran), or a fault refuses
 *  the mark too (logged). */
const markStandingRowLags = (
  continuations: Pick<ApprovalRestartContinuationStore, 'get' | 'markLaterRunAgain'>,
  checkpointId: string,
  runId: string,
  step: string,
  /** D-201 Slice 10BH (10BF finding 3) — the refused row went past the step it
   *  names (an approved step Recued cannot keep): a row that stands there is
   *  behind it too. Skipped for that, a refused row past such a step was never
   *  marked, and Settings said only that step could run twice. */
  refusedWentPast = false,
): void => {
  try {
    const standing = continuations.get(checkpointId)?.held;
    if (standing === undefined || (standing.step_in_doubt === step && !refusedWentPast)) return;
    continuations.markLaterRunAgain(checkpointId);
  } catch (error) {
    console.warn(
      `[preflight-resumer] run ${runId}: the row that stands could not be marked behind: `
        + (error instanceof Error ? error.message : String(error)),
    );
  }
};

/** D-201 Slice 10W (10V finding 3) — kept before the approved step started:
 *  its receipt, still claimed if the process went before the keep finished,
 *  goes back to waiting on this answer, which then claims it as any. */
const reawaitUnsentReceipt = async (
  executeDeps: ExecuteHandlerDeps,
  store: GatedActionStore | undefined,
  checkpoint: Checkpoint,
): Promise<void> => {
  const continuations = executeDeps.approvalRestartContinuations;
  const row = continuations?.get(checkpoint.checkpoint_id) ?? null;
  if (row === null || row.unsent !== true || row.run_id !== checkpoint.run_id) return;
  const receipt = store === undefined ? null : await store.getByCheckpoint(checkpoint.checkpoint_id);
  if (receipt !== null && receipt.status === 'dispatching'
    && receipt.current_checkpoint_id === checkpoint.checkpoint_id) {
    await store!.markAwaiting(
      receipt.action_ref,
      checkpoint.checkpoint_id,
      'The server restarted before the approved operation was sent. The next start sends it, without asking again.',
    );
  }
  // D-201 Slice 10AG — the answer to a held try again's ask: held again as it
  // was, so this replay of the answer is held as its resume was. A held row
  // at an ask keeps no value: the steps before it stand in from its checkpoint.
  if (row.held_before !== undefined) {
    continuations!.put({
      checkpoint_id: row.checkpoint_id,
      run_id: row.run_id,
      gated_step_id: row.gated_step_id,
      value: undefined,
      later: [],
      held: row.held_before,
    });
    return;
  }
  continuations!.delete(checkpoint.checkpoint_id);
};

/** A receipt-backed recipe checkpoint may cross the provider boundary only
 * after winning its durable attempt token. Absence remains compatible with
 * checkpoints minted before gated-action receipts existed; a subject row with
 * a different checkpoint is evidence of supersession, not legacy absence. */
const claimRecipeDispatch = async (
  store: GatedActionStore | undefined,
  checkpoint: Checkpoint,
): Promise<RecipeDispatchClaim> => {
  if (store === undefined) return { kind: 'legacy_without_receipt' };
  let action = await store.getByCheckpoint(checkpoint.checkpoint_id);
  if (action === null && checkpoint.gated_step_id !== undefined) {
    action = await store.getBySubject(checkpoint.run_id, checkpoint.gated_step_id);
  }
  if (action === null) {
    if (checkpoint.preflight_context?.gated_action_settlement_mode !== undefined) {
      throw new Error(
        `[preflight-resumer] receipt-backed checkpoint has no valid gated action for run_id=${checkpoint.run_id}`,
      );
    }
    return { kind: 'legacy_without_receipt' };
  }
  if (action.current_checkpoint_id !== checkpoint.checkpoint_id) {
    return { kind: 'superseded', action };
  }
  const claimed = await store.claimDispatch(action.action_ref, {
    checkpoint_id: checkpoint.checkpoint_id,
    attempt_id: randomUUID(),
  });
  if (claimed.kind === 'claimed') return { kind: 'claimed', action: claimed.record };
  if (claimed.record === null) {
    throw new Error(
      `[preflight-resumer] gated action disappeared while claiming dispatch for run_id=${checkpoint.run_id}`,
    );
  }
  if (isGatedActionTerminal(claimed.record.status)) {
    return { kind: 'already_terminal', action: claimed.record };
  }
  if (claimed.record.status === 'dispatching') {
    return { kind: 'already_dispatching', action: claimed.record };
  }
  return { kind: 'superseded', action: claimed.record };
};

/** Conservatively close a claimed recipe operation after the host lost the
 * ability to prove its outcome. A different terminal winner remains immutable.
 * Readback verification handles adapters that throw after committing. */
const settleInterruptedGatedAction = async (
  store: GatedActionStore,
  action: GatedActionRecord,
  checkpoint: Checkpoint,
  cause: unknown,
  /** D-201 Slice 10CA (10BX finding 9) — said in place of "could not prove the
   *  final outcome" where nothing was sent. */
  statusMessage?: string,
): Promise<GatedActionRecord> => {
  if (isGatedActionTerminal(action.status)) return action;
  const input = {
    status: 'in_doubt' as const,
    status_message: statusMessage
      ?? 'Recued could not prove the final outcome of this approved operation. Inspect Logs before retrying.',
    result: {
      reason: 'approved_recipe_dispatch_interrupted',
      checkpoint_id: checkpoint.checkpoint_id,
      error: cause instanceof Error ? cause.message : String(cause),
    },
    observed: { items: 1, succeeded: 0, failed: 0 },
  };
  let settled;
  try {
    settled = await store.finish(action.action_ref, input);
  } catch (error) {
    try {
      settled = await store.get(action.action_ref);
    } catch {
      throw error;
    }
    if (settled === null || !isGatedActionTerminal(settled.status)) throw error;
  }
  if (settled === null || !isGatedActionTerminal(settled.status)) {
    throw new Error(
      `[preflight-resumer] interrupted gated action did not settle for run_id=${checkpoint.run_id}`,
    );
  }
  return settled;
};

const settleRawMcpAction = async (
  store: McpActionStore | undefined,
  checkpoint: Checkpoint,
  outcome: RawOpResumeOutcome,
): Promise<void> => {
  await updateMcpAction(store, checkpoint.run_id, async (actions) => {
    switch (outcome.kind) {
      case 'completed':
        await actions.finish(checkpoint.run_id, {
          status: 'completed',
          status_message: 'The approved operation completed.',
          result: outcome.result,
        });
        return;
      case 'failed':
        await actions.finish(checkpoint.run_id, {
          status: 'failed',
          status_message: outcome.message,
          result: {
            status: 'failed',
            code: outcome.code,
            message: outcome.message,
          },
        });
        return;
      case 'in_doubt':
        await actions.finish(checkpoint.run_id, {
          status: 'in_doubt',
          status_message: outcome.message,
          result: {
            status: 'in_doubt',
            code: outcome.code,
            message: outcome.message,
          },
        });
        return;
      case 'skipped':
        // A concurrent winner owns settlement. A consumed checkpoint with no
        // terminal receipt means a prior process may have crossed the provider
        // boundary and crashed before recording the outcome: never call it safe
        // to retry.
        if (outcome.reason === 'resume_already_in_flight') return;
        await actions.finish(checkpoint.run_id, {
          status: 'in_doubt',
          status_message:
            'The approval checkpoint was already consumed, but no final result was retained. Inspect Recued Logs before retrying.',
          result: {
            status: 'in_doubt',
            code: outcome.reason,
            message:
              'The approval checkpoint was already consumed, but the final provider outcome is unavailable.',
          },
        });
    }
  });
};

type RawGatedActionStart =
  | { kind: 'legacy_without_receipt' }
  | { kind: 'dispatch'; action: GatedActionRecord }
  | { kind: 'already_dispatching'; action: GatedActionRecord }
  | { kind: 'already_terminal'; action: GatedActionRecord };

const markRawGatedActionDispatching = async (
  store: GatedActionStore | undefined,
  checkpoint: Checkpoint,
): Promise<RawGatedActionStart> => {
  if (store === undefined) return { kind: 'legacy_without_receipt' };
  const action = await store.getByCheckpoint(checkpoint.checkpoint_id);
  if (action === null) {
    if (checkpoint.preflight_context?.gated_action_settlement_mode !== undefined) {
      throw new Error(
        `[preflight-resumer] receipt-backed raw checkpoint has no valid gated action for run_id=${checkpoint.run_id}`,
      );
    }
    return { kind: 'legacy_without_receipt' };
  }
  if (isGatedActionTerminal(action.status)) return { kind: 'already_terminal', action };
  if (action.status === 'dispatching') {
    return { kind: 'already_dispatching', action };
  }
  const claim = await store.claimDispatch(action.action_ref, {
    checkpoint_id: checkpoint.checkpoint_id,
    attempt_id: randomUUID(),
    status_message: 'Approved; claiming the held raw operation for dispatch.',
  });
  const marked = claim.record;
  if (marked === null) {
    throw new Error(
      `[preflight-resumer] raw gated action disappeared before dispatch for run_id=${checkpoint.run_id}`,
    );
  }
  if (isGatedActionTerminal(marked.status)) return { kind: 'already_terminal', action: marked };
  if (claim.kind !== 'claimed' && marked.status === 'dispatching') {
    return { kind: 'already_dispatching', action: marked };
  }
  if (marked.status !== 'dispatching'
    || marked.current_checkpoint_id !== checkpoint.checkpoint_id) {
    throw new Error(
      `[preflight-resumer] raw gated action did not enter dispatching for run_id=${checkpoint.run_id}`,
    );
  }
  return { kind: 'dispatch', action: marked };
};

const settleRawGatedAction = async (
  store: GatedActionStore | undefined,
  action: GatedActionRecord | undefined,
  checkpoint: Checkpoint,
  outcome: RawOpResumeOutcome,
): Promise<void> => {
  if (store === undefined || action === undefined) return;
  if (outcome.kind === 'skipped' && outcome.reason === 'resume_already_in_flight') return;
  const input = await (async () => {
    switch (outcome.kind) {
      case 'completed': {
        const current = await store.get(action.action_ref);
        const settlementMode = current?.settlement_mode
          ?? checkpoint.preflight_context?.gated_action_settlement_mode
          ?? 'returned_result';
        const handoff = gatedActionHandoffFromResult(
          outcome.result,
          action.action_ref,
          settlementMode,
        );
        return settlementMode === 'durable_handoff' && handoff === undefined
          ? {
              status: 'in_doubt' as const,
              status_message: 'The approved asynchronous operation returned without a verifiable durable handoff.',
              result: outcome.result,
              observed: { items: 1, succeeded: 0, failed: 0 },
            }
          : handoff === undefined
            ? {
                status: 'succeeded' as const,
                status_message: 'The approved operation completed.',
                result: outcome.result,
                observed: { items: 1, succeeded: 1, failed: 0 },
              }
            : {
                status: 'dispatched' as const,
                status_message: 'The approved operation was handed off for asynchronous execution.',
                result: outcome.result,
                observed: { items: 1, succeeded: 0, failed: 0, dispatched: 1 },
                handoff,
              };
      }
      case 'failed':
        return {
          status: 'failed' as const,
          status_message: outcome.message,
          result: { code: outcome.code, message: outcome.message },
          observed: { items: 1, succeeded: 0, failed: 1 },
        };
      case 'in_doubt':
        return {
          status: 'in_doubt' as const,
          status_message: outcome.message,
          result: { code: outcome.code, message: outcome.message },
          observed: { items: 1, succeeded: 0, failed: 0 },
        };
      case 'skipped':
        return {
          status: 'in_doubt' as const,
          status_message: 'The checkpoint was consumed but the provider outcome is unavailable.',
          result: { code: outcome.reason },
          observed: { items: 1, succeeded: 0, failed: 0 },
        };
    }
  })();
  let settled;
  try {
    settled = await store.finish(action.action_ref, input);
  } catch (error) {
    try {
      settled = await store.get(action.action_ref);
    } catch {
      throw error;
    }
    if (settled === null || !isGatedActionTerminal(settled.status)) throw error;
  }
  if (settled === null || !isGatedActionTerminal(settled.status)) {
    throw new Error(
      `[preflight-resumer] raw gated action did not settle for run_id=${checkpoint.run_id}`,
    );
  }
};

const settleRecipeMcpAction = async (
  store: McpActionStore | undefined,
  auditLog: AuditLogStore,
  checkpoint: Checkpoint,
  response: ExecuteResponse,
  /** The dispatching tool's own result for this run (`resumed-run-finishers`),
   *  delivered in place of the run's projected response. */
  finished?: ChatDispatchResult,
): Promise<void> => {
  await updateMcpAction(store, checkpoint.run_id, async (actions) => {
    if (response.awaiting_approval === true) {
      const anchor = await auditLog.get(checkpoint.run_id);
      await actions.markAwaiting(
        checkpoint.run_id,
        anchor?.commit_status === 'awaiting_approval'
          ? anchor.checkpoint_id
          : undefined,
        MCP_ACTION_NEXT_GATE_STATUS_MESSAGE,
      );
      return;
    }
    const projected = projectRunResultForAgent(response);
    if (response.run_terminated !== undefined) {
      await actions.finish(checkpoint.run_id, {
        status: 'cancelled',
        status_message: 'The owner cancelled the resumed action.',
        result: projected,
      });
      return;
    }
    if (finished !== undefined) {
      const completed = finished.ok && finished.run_failed === undefined;
      await actions.finish(checkpoint.run_id, {
        status: completed ? 'completed' : 'failed',
        status_message: completed
          ? 'The approved action completed.'
          : 'The approved action resumed but did not complete successfully.',
        result: finished.ok
          ? finished.result
          : { status: 'failed', code: finished.reason, ...(finished.detail !== undefined ? { message: finished.detail } : {}) },
      });
      return;
    }
    await actions.finish(checkpoint.run_id, {
      status: response.success ? 'completed' : 'failed',
      status_message: response.success
        ? 'The approved action completed.'
        : 'The approved action resumed but did not complete successfully.',
      result: projected,
    });
  });
};

/** Internal: a terminal `commit_status` value means the run finished.
 *  The resumer / deny path treats this as the idempotency signal — a
 *  retry from a stale checkpoint walks away without re-running the
 *  gated side-effect. */
const TERMINAL_RUN_ANCHOR_STATUSES = new Set<AuditEntry['commit_status']>([
  'succeeded',
  'failed',
  'cancelled',
  'killed',
  'in_doubt',
]);

/** Decision encoded by the at-entry idempotency guard. */
type IdempotencyDecision =
  | { kind: 'proceed'; anchor: AuditEntry }
  | { kind: 'skip'; reason: string; anchor?: AuditEntry };

/** Host-stamped marker for a denial written by this callback. A generic
 * `RECIPE_POLICY_DENIED` can also come from a fresh-policy recheck after an
 * approval; only the exact preflight-deny error for this gated step proves that
 * a retry should repair the receipt as `denied`. */
const recordedOwnerDenial = (
  anchor: AuditEntry,
  checkpoint: Checkpoint,
): RecipeError | undefined => anchor.commit_status === 'failed'
  ? anchor.errors?.find((error) =>
      error.code === 'RECIPE_POLICY_DENIED'
        && error.error_id.startsWith('preflight-deny-')
        && error.source?.step_id === checkpoint.gated_step_id)
  : undefined;

/** Only these exact host-authored failures are safe for a terminal-anchor
 * retry to project into the operation receipt. Other failed run anchors may
 * describe a different step or a post-dispatch outcome. */
const recordedApprovalResumeFailure = (
  anchor: AuditEntry,
  checkpoint: Checkpoint,
): RecipeError | undefined => anchor.commit_status === 'failed'
  ? anchor.errors?.find((error) => {
      if (error.source?.step_id !== checkpoint.gated_step_id) return false;
      if (error.error_id.startsWith('checkpoint-integrity-')) {
        return error.code === 'RECIPE_VALIDATION_FAILED'
          && error.details?.reason === 'checkpoint_integrity_failed';
      }
      if (error.error_id.startsWith('checkpoint-provenance-')) {
        return error.code === 'RECIPE_VALIDATION_FAILED'
          && error.details?.reason === 'checkpoint_provenance_failed';
      }
      return error.error_id.startsWith('approval-resume-authority-')
        && error.code === 'RECIPE_POLICY_DENIED'
        && typeof error.details?.authority_reason === 'string';
    })
  : undefined;

/** D-173 N.5 §4 — one changed arg's old→new pair. `old` is the gated
 *  step's authored/prefilled value (or `undefined` for an override that
 *  ADDS a key absent from the authored args); `new` is the override the
 *  admin applied at approve time. */
export interface ArgEditDiff {
  key: string;
  old: unknown;
  new: unknown;
}

/** D-173 N.5 §4 — compute the changed-key diff between a gated step's
 *  authored/prefilled args and the inbox `arg_overrides` the admin applied
 *  at approve time. One entry per override key (overrides are an allowlist
 *  by construction — `reception.inbox.approve` validated them against the
 *  operation's `ArgEditSchema` (N.6) before they reached the checkpoint),
 *  carrying the authored `old` value (or `undefined` when the override adds
 *  a key) and the override `new` value. Prototype-sensitive override keys
 *  are skipped — they never reach the merge either (defense in depth).
 *  Pure + deterministic; the resume path emits it as the "approved with
 *  edits" audit breadcrumb.
 *
 *  N.6 reveal note: a sealed-PII edited value's reveal-on-record gating is
 *  driven by the `ArgEditField.privacy` facet, which `reception.inbox.
 *  approve` owns (Round 2). This helper records the raw old/new pair for
 *  the ephemeral resume breadcrumb; the DURABLE D-120 release-row diff
 *  field + its PII-reveal gating land with the rpc (the release-row carrier
 *  is a contracts type outside this lane's fence). */
export const computeArgEditsDiff = (
  authoredArgs: Record<string, unknown> | undefined,
  argOverrides: Record<string, unknown>,
): ArgEditDiff[] => {
  const proto = new Set(['__proto__', 'constructor', 'prototype']);
  const authored = authoredArgs ?? {};
  const diff: ArgEditDiff[] = [];
  for (const [key, value] of Object.entries(argOverrides)) {
    if (proto.has(key)) continue;
    diff.push({
      key,
      old: Object.prototype.hasOwnProperty.call(authored, key)
        ? authored[key]
        : undefined,
      new: value,
    });
  }
  return diff;
};

/** Build a `PreflightResumer` over `recued-server`'s `handleExecute` +
 *  `AuditLogStore`. */
/** D-341 slices B2 and B3 — "Always allow for this webhook / schedule / trigger / form / scheduled
 *  prompt": grant what the hold offered, before the held write goes on. The approval stands whatever
 *  happens to the grant: one refused (the recipe, the prompt or a door changed since the ask) leaves
 *  a plain approve. */
const grantAnsweredTriggerPreapproval = async (
  executeDeps: Pick<ExecuteHandlerDeps, 'triggerPreapprovalGranter'>,
  checkpoint: Checkpoint,
  context: PreflightAskContext,
): Promise<void> => {
  if (context.trigger_preapproval_answer !== true || context.trigger_preapproval_decision_version !== 1) return;
  const offer = readTriggerPreapprovalOffer(checkpoint.preflight_context?.trigger_preapproval);
  if (offer === undefined || executeDeps.triggerPreapprovalGranter === undefined) return;
  try {
    await executeDeps.triggerPreapprovalGranter.grantOffer(offer, {
      run_id: checkpoint.run_id, checkpoint_id: checkpoint.checkpoint_id,
    });
  } catch (error) {
    console.warn(
      `[preflight-resumer] the pre-approval the owner chose was not granted: `
        + `${error instanceof Error ? error.message : String(error)} (run_id=${checkpoint.run_id})`,
    );
  }
};

/** D-177 N.15 — "Allow in this chat": grant the kind grant the hold offered, before
 *  the held write goes on. The approval stands whatever happens to the grant: one refused leaves a
 *  plain approve. */
const grantAnsweredKindGrant = (
  executeDeps: Pick<ExecuteHandlerDeps, 'sessionGrantResolver'>,
  checkpoint: Checkpoint,
  context: PreflightAskContext,
): void => {
  if (context.kind_grant_answer !== true || context.kind_grant_decision_version !== 1) return;
  const offer = readKindGrantOffer(checkpoint.preflight_context?.kind_grant);
  if (offer === undefined || executeDeps.sessionGrantResolver === undefined) return;
  // `mintKind` never throws, and one approval mints one grant however often the answer is told.
  if (!checkpoint.run_id || !checkpoint.checkpoint_id) return;
  executeDeps.sessionGrantResolver.mintKind(offer,
    JSON.stringify(['preflight', checkpoint.run_id, checkpoint.checkpoint_id]), { version: 1 });
};

/** D-201 Slice 10W — how the owner's try again of a held run ended. `none`:
 *  nothing held (a run from before 10W, or one the recipe changed under), so
 *  the caller runs it as before. */
export type HeldRunOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'awaiting_approval' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'in_doubt'; readonly step_id: string }
  /** D-201 Slice 10AB (10AA finding 2) — failed, not stopped, and held again
   *  from the step it failed at (or as it stood, when nothing ran): its next
   *  try again goes on from there. Its record says why it failed. */
  | { readonly kind: 'held_failed'; readonly step_id: string }
  /** Ended without being held: the owner's Stop. */
  | { readonly kind: 'failed' };

/** D-201 Slice 10AB (10AA finding 4) — whether what a held run kept is this
 *  version's: the recipe has not changed since its stop. When it has, the kept
 *  values cannot stand in for its steps, so the try again runs the recipe from
 *  its first step, and its dead letter says so (`recipe_changed`). */
export const heldRunRecipeIsCurrent = (
  executeDeps: Pick<ExecuteHandlerDeps, 'recipeStore'>,
  held: Pick<ApprovalRestartHeldRun, 'checkpoint' | 'anchor'>,
): boolean => {
  const { checkpoint } = held;
  if (checkpoint.recipe_snapshot !== undefined) {
    return hashRecipe(checkpoint.recipe_snapshot as unknown as RecipeDefinition) === held.anchor.recipe_hash;
  }
  if (checkpoint.recipe_source_hash === undefined) return true;
  const recipe = executeDeps.recipeStore.get(checkpoint.recipe_id!);
  return recipe !== null && hashRecipe(canonicalRecipeDefinition(recipe)) === checkpoint.recipe_source_hash;
};

/** D-201 Slices 10W and 10AB — what a held run's dead letter says its try
 *  again does (`WebhookDeadLetterView.step_in_doubt`); null when nothing is
 *  held, so the try again runs the recipe from its first step. */
export const heldDeadLetterStep = (
  executeDeps: Pick<ExecuteHandlerDeps, 'recipeStore' | 'approvalRestartContinuations'>,
  runId: string,
): NonNullable<WebhookDeadLetterView['held_try_again']> | null => {
  const held = executeDeps.approvalRestartContinuations?.getHeldForRun(runId)?.held;
  if (held === undefined) return null;
  if (!heldRunRecipeIsCurrent(executeDeps, held)) {
    return { step_id: held.checkpoint.gated_step_id ?? held.step_in_doubt, recipe_changed: true };
  }
  return {
    step_id: held.step_in_doubt,
    ...(held.approved_returned ? {} : { asks_again: true as const }),
    ...(held.progress_unknown === true ? { progress_unknown: true as const } : {}),
    ...(held.failed === true ? { failed: true as const } : {}),
    // D-201 Slice 10BC (10AY findings 2 and 9).
    ...(held.later_run_again === true ? { later_run_again: true as const } : {}),
    // D-201 Slice 10BI (10BF finding 5).
    ...(held.handoff_unproven === true ? { handoff_unproven: true as const } : {}),
  };
};

/** D-201 Slice 10AG (10AE finding 2) — a held try again paused at an ask: the
 *  held row moves to it, the steps before it standing in from its checkpoint,
 *  so the resume its answer makes holds a later failure again, and a failure
 *  at the asked step is the dead letter whose try again asks for it again.
 *  The row was dropped: the answer's resume failed as any run, and the
 *  delivery was cancelled. False when there is no ask to move it to. */
const moveHeldToAsk = async (
  auditLog: Pick<AuditLogStore, 'get'>,
  executeDeps: Pick<ExecuteHandlerDeps, 'checkpointStore' | 'approvalRestartContinuations'>,
  fromCheckpointId: string,
  runId: string,
): Promise<boolean> => {
  const continuations = executeDeps.approvalRestartContinuations;
  if (continuations === undefined || executeDeps.checkpointStore === undefined) return false;
  const anchor = await auditLog.get(runId);
  if (anchor === null || anchor.commit_status !== 'awaiting_approval' || anchor.checkpoint_id === undefined) return false;
  const asked = await executeDeps.checkpointStore.get(anchor.checkpoint_id);
  if (asked === null || asked.run_id !== runId || asked.gated_step_id === undefined) return false;
  const from = continuations.get(fromCheckpointId)?.held;
  // D-201 Slice 10AK (10AI finding 15) — in one write: a fault leaves the row
  // where it was, for the answer to the ask to move (`moveHeldRowHere`).
  continuations.move(fromCheckpointId, {
    checkpoint_id: asked.checkpoint_id,
    run_id: runId,
    gated_step_id: asked.gated_step_id,
    value: undefined,
    later: [],
    held: {
      checkpoint: asked,
      anchor,
      approved_returned: false,
      step_in_doubt: asked.gated_step_id,
      // D-201 Slice 10AK (10AI finding 13) — the ask for the step in doubt
      // itself, nothing past it run yet: what a death left unknown still is.
      // At a later ask the steps before it ran again here, and a process gone
      // before would have stopped at that ask too.
      ...(from?.progress_unknown === true && from.approved_returned === false
        && from.step_in_doubt === asked.gated_step_id
        ? { progress_unknown: true as const }
        : {}),
      // D-201 Slice 10BC (10AY findings 2 and 9) — as a death's unknown
      // progress is: bounded by a later ask, which the run could not go past.
      ...(from?.later_run_again === true && from.approved_returned === false
        && from.step_in_doubt === asked.gated_step_id
        ? { later_run_again: true as const }
        : {}),
      // D-201 Slice 10BI (10BF finding 5) — `handoff_unproven` is not carried:
      // the step asked for again runs anew, so a doubt about this run is no
      // longer that hand-off's.
    },
  });
  return true;
};

/** D-201 Slice 10AK (10AI finding 15) — a held run's row left at an earlier
 *  ask moves to the one being answered, the run's current ask: in one write
 *  (`ApprovalRestartContinuationStore.move`), the steps before it standing in
 *  from its checkpoint, as `moveHeldToAsk` would have left it. Not moved, the
 *  answer runs as one not held, as before 10AK. */
const moveHeldRowHere = (
  executeDeps: Pick<ExecuteHandlerDeps, 'approvalRestartContinuations'>,
  checkpoint: Checkpoint,
  anchor: AuditEntry,
): void => {
  const continuations = executeDeps.approvalRestartContinuations;
  if (continuations === undefined || checkpoint.gated_step_id === undefined) return;
  try {
    if (continuations.get(checkpoint.checkpoint_id) !== null) return;
    const elsewhere = continuations.getHeldForRun(checkpoint.run_id);
    if (elsewhere?.held === undefined || elsewhere.checkpoint_id === checkpoint.checkpoint_id) return;
    continuations.move(elsewhere.checkpoint_id, {
      checkpoint_id: checkpoint.checkpoint_id,
      run_id: checkpoint.run_id,
      gated_step_id: checkpoint.gated_step_id,
      value: undefined,
      later: [],
      held: {
        checkpoint,
        anchor,
        approved_returned: false,
        step_in_doubt: checkpoint.gated_step_id,
        // As `moveHeldToAsk` keeps it: at the ask for the step in doubt only.
        ...(elsewhere.held.progress_unknown === true && elsewhere.held.approved_returned === false
          && elsewhere.held.step_in_doubt === checkpoint.gated_step_id
          ? { progress_unknown: true as const }
          : {}),
        ...(elsewhere.held.later_run_again === true && elsewhere.held.approved_returned === false
          && elsewhere.held.step_in_doubt === checkpoint.gated_step_id
          ? { later_run_again: true as const }
          : {}),
      },
    });
  } catch {
    // Not moved now: the row stays where it was.
  }
};

/** D-201 Slice 10W — the server's resumer: the gateway's two callbacks, and the
 *  owner's try again of an approved webhook run a stop left in doubt. */
export interface ServerPreflightResumer extends PreflightResumer {
  /** Go on from the step in doubt, everything that went through standing in
   *  (10V finding 1; the owner's call, 2026-11-19: never refused, and only the
   *  step in doubt can run twice). Also what the next start does with one a
   *  restart stopped during its try again. `door` is the delivery's door as it
   *  stands now, which the run goes on under. */
  continueHeldRun(runId: string, door: {
    readonly execution_source: AuditEntry['execution_source'];
    readonly contract_snapshot?: AuditEntry['contract_snapshot'];
  }): Promise<HeldRunOutcome>;
  /** D-201 Slice 10AB (10AA finding 1) — a try again the process went during
   *  (a crash, or a drain whose wait ran out) left the held run's paused record
   *  as its latest, naming the checkpoint the first answer used: a hold with no
   *  ask. Settles it as in doubt, how far the try again got unknown, held still
   *  for the owner's next try again. True when `record` was one. */
  settleDiedTryAgain(runId: string, record: AuditEntry): Promise<boolean>;
  /** D-201 Slice 10AP (10AM findings 5 and 18) — whether an answer's resume of
   *  this run is still under way: its run may have written its record, while
   *  the resume has yet to write what it keeps (a hold, a move, an in-doubt
   *  record). The webhook reconcile leaves such a run waiting, so it never
   *  reads the run's own record as the end. */
  isResumingRun(runId: string): boolean;
}

export const createPreflightResumer = (
  deps: CreatePreflightResumerDeps,
): ServerPreflightResumer => {
  // D-348 — a run settled: how each call of it the owner approved ended, for the request's chain,
  // then whoever else listens (`onRunSettled`).
  const runSettled = (settled: PreflightRunSettled): void => {
    recordChainOutcome(deps.getExecuteDeps(), settled);
    deps.onRunSettled?.(settled);
  };
  const actionStoreFor = (executeDeps?: ExecuteHandlerDeps): McpActionStore | undefined =>
    executeDeps?.mcpActionStore ?? deps.mcpActionStore;
  const gatedActionStoreFor = (
    executeDeps?: ExecuteHandlerDeps,
  ): GatedActionStore | undefined =>
    executeDeps?.gatedActionStore ?? deps.gatedActionStore;
  /** At-entry idempotency check. Returns `proceed` only when the
   *  paused anchor is still `'awaiting_approval'` AND the audit row's
   *  `checkpoint_id` matches the one the leaf handed us. Every other
   *  state means a previous attempt of this same answer already won —
   *  we skip and let the caller consume the (now-stale) checkpoint.
   *
   *  Throws ONLY on transient I/O failure of `auditLog.get` — the leaf
   *  re-throws, and the next boot's sweep retries. A `null` row (the
   *  paused anchor was pruned by retention or never written) is a
   *  silent skip — the run is genuinely gone, no resume is possible. */
  const decide = async (
    checkpoint: Checkpoint,
  ): Promise<IdempotencyDecision> => {
    const anchor = await deps.auditLog.get(checkpoint.run_id);
    if (anchor === null) {
      return {
        kind: 'skip',
        reason: `paused anchor run_id=${checkpoint.run_id} not found — run was pruned or never persisted`,
      };
    }
    // D-201 Slice 10W (10V finding 3) — the server's own stop kept this run: its
    // row was written first, from the run's own report, and the process went
    // (a kill, or a drain wait that ran out) before the paused record was put
    // back over the `killed` one. It is the answer's to finish, under the
    // paused record the row kept. 10R read the `killed` record as the end, and
    // its try again sent again what had gone through.
    if (anchor.commit_status === 'killed') {
      const executeDeps = deps.getExecuteDeps();
      if (executeDeps === undefined) {
        throw new Error(
          `[preflight-resumer] executeDeps not yet published — run_id=${checkpoint.run_id} may have been kept for this answer (transient; next boot will retry)`,
        );
      }
      const kept = executeDeps.approvalRestartContinuations?.get(checkpoint.checkpoint_id) ?? null;
      if (kept !== null && kept.held === undefined && kept.paused_anchor !== undefined
        && kept.run_id === checkpoint.run_id && kept.gated_step_id === checkpoint.gated_step_id) {
        await deps.auditLog.append(kept.paused_anchor);
        return { kind: 'proceed', anchor: kept.paused_anchor };
      }
    }
    if (TERMINAL_RUN_ANCHOR_STATUSES.has(anchor.commit_status)) {
      return {
        kind: 'skip',
        anchor,
        reason:
          `paused anchor run_id=${checkpoint.run_id} is already terminal `
            + `(commit_status='${anchor.commit_status}') — answer is a retry of a completed run`,
      };
    }
    // D-234 § 234.4 — ⇒ THE LITERAL IS CORRECT AND FAIL-CLOSED. The branch above
    // has already refused anything that is not `awaiting_approval` as "already
    // terminal". A peer-held anchor cannot legitimately reach here — this path is
    // driven by an APPROVAL answer, and a peer hold raises no local ask for one
    // to name — and if it ever did, refusing to resume is the right direction.
    // ⚠ Only the REASON would be wrong ("already terminal" of a live hold), which
    // is a diagnosis bug, not a safety one; widening it belongs in the slice that
    // introduces the peer answer's own resume path.
    if (anchor.commit_status === 'awaiting_approval') {
      // A re-pause on a downstream gate would have rewritten the anchor
      // with a fresh `checkpoint_id`. If the row's `checkpoint_id` no
      // longer matches the one this answer is bound to, the answer is
      // for a stale checkpoint — let the leaf consume it without re-
      // dispatching.
      if (
        anchor.checkpoint_id !== undefined
        && anchor.checkpoint_id !== checkpoint.checkpoint_id
      ) {
        return {
          kind: 'skip',
          reason:
            `paused anchor run_id=${checkpoint.run_id} points at checkpoint `
              + `'${anchor.checkpoint_id}', not the one this answer is for `
              + `('${checkpoint.checkpoint_id}') — stale checkpoint, newer awaiting state takes precedence`,
        };
      }
      return { kind: 'proceed', anchor };
    }
    // Some other non-terminal value (e.g., a future RunAnchorStatus
    // value not in the terminal set). Conservative: skip rather than
    // re-dispatch into an unrecognised state.
    return {
      kind: 'skip',
      reason:
        `paused anchor run_id=${checkpoint.run_id} carries unexpected commit_status='${anchor.commit_status}'`,
    };
  };

  /** Build the `ExecuteRequest` that re-instantiates the paused run.
   *  Pulls the run-shape (config / trigger_source / instance_id /
   *  execution_source / contract_snapshot) off the paused audit row.
   *  `internal.run_id` + `internal.resume_from` live on the second
   *  parameter to `handleExecute` so the resume inherits both the
   *  seeded `step.*` and the original run-anchor identity. */
  const buildResumeInputs = (
    checkpoint: Checkpoint,
    anchor: AuditEntry,
    sessionGrant?: {
      ttl_ms: number;
      max_uses: number;
      risk_tier: string;
      // D-177 P5b — 'open' selects the provenance-pinned mint (N.11);
      // threaded opaquely, the Gateway validates the mode.
      grant_mode?: string;
    },
    batchClaim?: { contract_id: string; member_id: string },
    /** The stored recipe was edited while this approval was pending, so the
     *  prior approval must not be honoured. Withholding `approved_target` makes
     *  the catalog gate treat the resume as unapproved and re-ask with the
     *  CURRENT identity — see the guard in `resumeRun` for why that beats
     *  refusing the resume outright. */
    requireFreshApproval?: boolean,
    /** D-402 slice F3 — the owner's answer to the question before the run, for a run held before step 1. */
    runQuestionAnswer?: RunQuestionAnswer,
  ): { request: ExecuteRequest; internal: NonNullable<Parameters<typeof handleExecute>[2]> } => {
    const request: ExecuteRequest = {
      // R2 step 6 — an inline run (R2 transient dispatch / derived saga
      // compensation) carries its RESOLVED recipe on the checkpoint; its
      // `recipe_id` resolves to nothing in the store. Integrity is
      // verified by the caller (`resumeRun` hash check against the
      // paused anchor) BEFORE this builder runs. Store-resident runs
      // resume by id exactly as before.
      // D-182 §8 — a raw-op checkpoint is routed to `resumeRawOp` before this
      // builder runs, so a checkpoint reaching here is recipe-bound and the
      // `isCheckpoint` guard guarantees `recipe_id` / `gated_step_id` (the `!`s
      // below assert that recipe-bound invariant).
      ...(checkpoint.recipe_snapshot !== undefined
        ? { recipe: checkpoint.recipe_snapshot }
        : { recipe_id: checkpoint.recipe_id! }),
      // D-157 BLOCKER 3 fold — `config_snapshot` now captures the
      // effective merged config the original run resolved
      // `{{config.*}}` against (recipe defaults + user overrides).
      // The resumer feeds it straight back so the resumed gated step
      // dispatches against the same values the gate evaluated.
      config: { ...anchor.config_snapshot },
      ...(anchor.connection_revisions ? { connection_revisions: { ...anchor.connection_revisions } } : {}),
      // Targeting guard follow-on (design § 8 / codex HIGH fold) — replay
      // the paused run's caller context (persisted on awaiting anchors
      // only). Context is run-scoped input frozen at dispatch: a gated
      // step resolving `{{context.entity_id}}` / `{{context.event...}}`
      // re-dispatches against the approved values instead of undefined.
      // Pre-fold anchors carry no snapshot — resume proceeds without
      // context exactly as before (the execute guard skips resumes).
      ...(anchor.context_snapshot !== undefined
        && Object.keys(anchor.context_snapshot).length > 0
        ? { context: { ...anchor.context_snapshot } }
        : {}),
      ...(anchor.trigger_source != null
        ? { trigger_source: anchor.trigger_source }
        : {}),
      ...(anchor.instance_id != null ? { instance_id: anchor.instance_id } : {}),
      ...(anchor.execution_source != null
        ? { execution_source: anchor.execution_source }
        : {}),
      ...(anchor.contract_snapshot != null
        ? { contract_snapshot: anchor.contract_snapshot }
        : {}),
      ...(anchor.process_id != null ? { process_id: anchor.process_id } : {}),
      // D-179 P1 — preserve standing-dish attribution + continuity across
      // the pause. The handler binds the dish WITHOUT re-merging its
      // overlay on resume (`internal.run_id` set), so the dispatch still
      // replays the anchor's approved `config_snapshot` verbatim.
      // Ephemeral ids are NOT replayed — the resumed run derives a fresh
      // one from the (same) run_id, which yields the identical value.
      ...(anchor.dish_id != null && !isEphemeralDishId(anchor.dish_id)
        ? { dish_id: anchor.dish_id }
        : {}),
    };
    return {
      request,
      internal: {
        run_id: checkpoint.run_id,
        // R2 step 6 — a paused saga compensation run re-instantiates with
        // its compensating link intact, so the dispatched commit still
        // stamps `predecessor_commit_id` (the checkpoint is the durable
        // carrier across the pause).
        ...(checkpoint.predecessor_commit_id !== undefined
          ? { predecessor_commit_id: checkpoint.predecessor_commit_id }
          : {}),
        ...(checkpoint.entry_tool_name !== undefined ? { entry_tool_name: checkpoint.entry_tool_name } : {}),
        // D-402 slice C — a trial stays a trial past each approval: what comes after it asks too, and it
        // reports to the same recorder, which joins the parts into the trial's saved test (§8.3).
        ...(checkpoint.trial === true ? { trial: true as const } : {}),
        ...(checkpoint.trial === true && browserTrials.recorderOf(checkpoint.run_id) !== undefined
          ? { regression_capture: browserTrials.recorderOf(checkpoint.run_id)! } : {}),
        // D-232 § 20.19 — carry the run's grant coverage across the pause. The
        // resumed run re-derives coverage from its OWN recipe name, and for a
        // host-dispatched carrier (`run-ingredient`) that derivation is
        // structurally empty — so without this the resume re-enters uncovered
        // and its step dies `tool_not_in_contract` AFTER the owner approved it.
        // Anchor-sourced, and the anchor was written by the host: the value
        // never originates from caller input. The resume authority above has
        // already re-verified that this exact grant is still held.
        ...(typeof anchor.granted_by_recipe === 'string'
          && anchor.granted_by_recipe.length > 0
          ? { granted_by_recipe: anchor.granted_by_recipe }
          : {}),
        // ⛔⛔ D-232 § 20.9 — CARRY THE EXCHANGE REF ACROSS THE PAUSE, FOR THE
        // SAME REASON AS THE LINE ABOVE AND WITH THE SAME FAILURE SHAPE: the
        // loss happens AFTER the owner approved.
        //
        // A fire's carrier learns its ref ONLY from `internal.exchange_ref` —
        // `requestExchangeRef`'s other source is `config.exchange_ref`, and a
        // carrier's config is `{ ingredient_slug, input }` with the ref nested
        // inside `input.args`, so case 2 never matches for it. The fire passes
        // the ref on the FIRST dispatch; a `write`-risk send is floored to `ask`
        // and pauses there; and the resume re-entered without it. The resumed
        // run reuses the same `run_id`, so the row is rewritten — with no ref.
        //
        // 🔑 THE CONSEQUENCE IS THE ONE THIS WHOLE FEATURE EXISTS TO PREVENT:
        // the crossing becomes unfindable. § 23 derives delivery status from the
        // runs filed under a ref, so an approved-and-delivered answer reads
        // `awaiting` forever, and § 24's sweep — which counts carrier attempts
        // from that same trail — cannot see that anything was ever sent. An
        // owner who approved the send is told nothing happened.
        //
        // ⚠ Anchor-sourced, like `granted_by_recipe`: the host wrote this row,
        // so the value never originates from caller input, and re-filing under
        // the SAME ref is what makes the resume an attempt rather than a new
        // exchange.
        ...(typeof anchor.exchange_ref === 'string' && anchor.exchange_ref.length > 0
          ? { exchange_ref: anchor.exchange_ref }
          : {}),
        // D-402 slice F3 — a run held before step 1 to ask the question starts afresh under its
        // run_id, the owner's answer with it: the engine never ran, and a resume of its first step
        // would let that step's call past its own ask.
        ...(checkpoint.run_question !== undefined ? { run_question: runQuestionAnswer ?? RUN_QUESTION_EACH_STEP } : { resume_from: {
          ...(checkpoint.resource_review ? { resource_review: checkpoint.resource_review } : {}),
          gated_step_id: checkpoint.gated_step_id!,
          ...(checkpoint.execution_phase ? { execution_phase: checkpoint.execution_phase } : {}),
          ...(checkpoint.trigger_state ? { trigger_state: checkpoint.trigger_state } : {}),
          ...(checkpoint.prefetch_completed ? { prefetch_completed: checkpoint.prefetch_completed } : {}),
          step_state: checkpoint.step_state,
          ...(checkpoint.foreach_progress !== undefined
            ? { foreach_progress: checkpoint.foreach_progress }
            : {}),
          ...(checkpoint.preflight_context?.egress_bound !== undefined
            ? { egress_bound: checkpoint.preflight_context.egress_bound }
            : {}),
          // D-165 follow-on (op-identity binding) — feed the approved
          // identity back so the catalog gate re-verifies the resumed call
          // still targets it (a `{{config.*}}` connection that changed while
          // paused re-asks instead of silently dispatching against the drift).
          ...(checkpoint.approved_target !== undefined && requireFreshApproval !== true
            ? { approved_target: checkpoint.approved_target }
            : {}),
          // D-173 N.5 — feed the consumed checkpoint's editable-args
          // overrides back so the engine merges them over the gated step's
          // authored args on resume (gated step only). THIS is the boundary
          // origin (N.5 MUST): `arg_overrides` flows ONLY from the consumed
          // `checkpoint` object — written by the admin-only
          // `reception.inbox.approve` rpc before it triggered this resume —
          // never from any caller / channel / context input. Absent on a
          // plain binary-gate checkpoint ⇒ the resumed run is byte-identical
          // to D-157's binary approve/deny path.
          ...(checkpoint.arg_overrides !== undefined
            ? { arg_overrides: checkpoint.arg_overrides }
            : {}),
          // D-177 P3 — the `allow_session` answer's mint instruction. THIS
          // is the boundary origin: it flows ONLY from the answer-time
          // `PreflightAskContext` (the durable handler read it back off the
          // ask payload the raise site authored, and forwarded it exactly
          // when the recorded answer was `allow_session`) — never from any
          // caller / channel / context input. Absent on approve/deny ⇒ the
          // resume is byte-identical to the plain binary path.
          ...(sessionGrant !== undefined ? { session_grant: sessionGrant } : {}),
          ...(sessionGrant !== undefined ? { session_grant_decision: {
            version: 1 as const,
            approval_ref: JSON.stringify(['preflight', checkpoint.run_id, checkpoint.checkpoint_id]),
          } } : {}),
          // D-177 P5a — the batched approve's member-claim instruction.
          // Same boundary origin discipline: flows ONLY from the batch
          // answer flow's resume context (`batch-approval.ts` is the sole
          // writer), never from caller / channel / context input. Absent
          // ⇒ byte-identical to the plain path.
          ...(batchClaim !== undefined ? { batch_claim: batchClaim } : {}),
          // § 7 follow-on (pii-ledger-in-checkpoint) — feed the paused run's
          // serialized pii ledgers back so the engine hydrates its run store
          // and post-gate `pii-restore` steps return REAL values instead of
          // passing aliases through (the s7 codex HIGH). Absent on legacy
          // checkpoints / runs that never aliased ⇒ a plain fresh store,
          // byte-identical to the prior resume path.
          ...(checkpoint.pii_ledgers !== undefined
            ? { pii_ledgers: checkpoint.pii_ledgers }
            : {}),
        } }),
      },
    };
  };

  /** Replace an awaiting run anchor with one terminal failure. Used by both a
   * human deny and an approve whose live authority disappeared before act time.
   * Keeping the write in one helper preserves the existing insert-or-replace
   * idempotency boundary and prevents a consumed checkpoint from leaving a
   * dangling `awaiting_approval` row. */
  const appendFailedAnchor = async (input: {
    checkpoint: Checkpoint;
    anchor: AuditEntry;
    recipe_hash: string;
    error: RecipeError;
  }): Promise<void> => {
    const { checkpoint, anchor } = input;
    const finishedAt = Date.now();
    const entry = buildAuditEntry({
      recipe_id: anchor.recipe_id,
      recipe_hash: input.recipe_hash,
      commit_status: 'failed',
      duration_ms: Math.max(0, finishedAt - anchor.started_at),
      // Use the same clock sample as duration_ms. Sampling again inside
      // buildAuditEntry can cross a millisecond boundary and shift the
      // replacement row's started_at, breaking paused-run continuity.
      now: finishedAt,
      errors: [input.error],
      config_snapshot: { ...anchor.config_snapshot },
      trigger_url: anchor.trigger_url ?? null,
      trigger_source: anchor.trigger_source ?? null,
      instance_id: anchor.instance_id ?? null,
      run_id: checkpoint.run_id,
      // This record replaces the paused one: keep what links the run and what
      // it did before it paused.
      ...carriedFromPausedRun(anchor),
    });
    await deps.auditLog.append(entry);
    // D-402 slice C (§8.3) — a trial ends here, at its hold: its saved test hears that nothing runs on.
    if (checkpoint.trial === true) browserTrials.endedAtHold(checkpoint.run_id);
  };

  const runAnchorClosedOrSuperseded = (
    anchor: AuditEntry,
    checkpoint: Checkpoint,
  ): boolean => TERMINAL_RUN_ANCHOR_STATUSES.has(anchor.commit_status)
    || anchor.commit_status === 'awaiting_peer'
    || (anchor.commit_status === 'awaiting_approval'
      && anchor.checkpoint_id !== undefined
      && anchor.checkpoint_id !== checkpoint.checkpoint_id);

  /** Close only the still-current approval anchor. A later owner/peer gate is
   * durable continuation state and must survive failure while the original
   * answer is being retired. */
  const appendInDoubtAnchorUnlessSuperseded = async (
    checkpoint: Checkpoint,
    cause: unknown,
    /** D-201 Slice 10R — what is known, when it is more than "may have run". */
    message?: string,
    /** D-201 Slice 10AV — the step in doubt, when a later one than the approved
     *  step (a held row written ahead names it). */
    stepId?: string,
  ): Promise<void> => {
    const current = await deps.auditLog.get(checkpoint.run_id);
    if (current === null) {
      throw new Error(
        `[preflight-resumer] run anchor disappeared during interruption recovery for run_id=${checkpoint.run_id}`,
      );
    }
    if (runAnchorClosedOrSuperseded(current, checkpoint)) return;
    if (current.commit_status !== 'awaiting_approval') {
      throw new Error(
        `[preflight-resumer] cannot reconcile unexpected run state '${current.commit_status}' for run_id=${checkpoint.run_id}`,
      );
    }
    const finishedAt = Date.now();
    const terminal: AuditEntry = {
      ...current,
      commit_status: 'in_doubt',
      finished_at: finishedAt,
      duration_ms: Math.max(0, finishedAt - current.started_at),
      errors: [{
        error_id: `approval-resume-interrupted-${finishedAt.toString(36)}-${checkpoint.run_id}`,
        code: 'ACTION_DELIVERY_UNCERTAIN',
        message: message
          ?? 'The approved operation may have run, but Recued could not prove the complete resumed run outcome.',
        severity: 'fatal',
        source: {
          recipe_id: current.recipe_id,
          step_id: stepId ?? checkpoint.gated_step_id ?? null,
          ingredient_slug: stepId === undefined ? checkpoint.preflight_context?.tool_slug ?? null : null,
        },
        details: {
          reason: 'approved_recipe_dispatch_interrupted',
          error: cause instanceof Error ? cause.message : String(cause),
        },
        timestamp: new Date(finishedAt).toISOString(),
        retryable: false,
      }],
    };
    delete terminal.checkpoint_id;
    delete terminal.ask_id;
    delete terminal.context_snapshot;
    delete terminal.connection_revisions;
    try {
      await deps.auditLog.append(terminal);
    } catch (error) {
      const observed = await deps.auditLog.get(checkpoint.run_id);
      if (observed !== null && runAnchorClosedOrSuperseded(observed, checkpoint)) return;
      throw error;
    }
    const observed = await deps.auditLog.get(checkpoint.run_id);
    if (observed === null || !runAnchorClosedOrSuperseded(observed, checkpoint)) {
      throw new Error(
        `[preflight-resumer] interrupted run audit did not settle for run_id=${checkpoint.run_id}`,
      );
    }
  };

  /** D-201 Slice 10AV (10AS finding 9) — the run a death stopped, in doubt as
   *  the held row it left says: the approved step went through and a later one
   *  was under way, or the approved step itself was. It said the approved
   *  operation may have run, naming it, when a later step was the one.
   *
   *  D-201 Slice 10BC — and as the row says the rest. `later_run_again` (10AY
   *  findings 2 and 9): the steps after the one it names that ran run again
   *  too. `not_kept` (finding 10): a restart, not a death, whose own row was
   *  refused; the record named the approved step as maybe run, while the row
   *  and Settings named the step it stands at. `receipt_in_doubt` (finding
   *  11): the approved step's receipt reads in doubt beside a row that says it
   *  went through, Recued having failed to settle it. */
  const appendInDoubtFromHeldRow = async (
    checkpoint: Checkpoint,
    held: ApprovalRestartHeldRun,
    cause: unknown,
    how: {
      readonly not_kept?: true;
      readonly receipt_in_doubt?: true;
      /** D-201 Slice 10BJ (10BF finding 8) — settled in doubt for a hand-off
       *  it cannot check, beside a row its hold could not replace. */
      readonly receipt_handoff_unproven?: true;
      /** D-201 Slice 10CA (10BX finding 12) — a hand-off's receipt frozen
       *  before Recued could check the hand-off (`receiptHandoffFrozen`). */
      readonly receipt_handoff_frozen?: true;
      /** D-201 Slice 10CA (10BX findings 9 and 10) — with `not_kept`: the stop
       *  came before the approved step started (`unsent`), or after its receipt
       *  read as gone through (`went_through`). */
      readonly unsent?: true;
      readonly went_through?: true;
      readonly threw?: true;
    } = {},
  ): Promise<void> => {
    const approved = checkpoint.gated_step_id;
    // D-201 Slice 10BJ (10BF finding 10) — `threw`: the handler threw after
    // the rows it wrote ahead; no server stopped.
    const stopped = how.threw === true
      ? 'the run ended on an error'
      : how.not_kept === true ? 'the server restarted' : 'the server stopped';
    if (!held.approved_returned) {
      // D-201 Slice 10CA (10BX findings 9 and 10) — this answer's own row was
      // refused, so the row held before it stands, as said: an unsent stop sent
      // nothing, and one past an approved step that went through names it so.
      // They said the outcome could not be proven, and gave the reason for a
      // step a restart cannot keep.
      if (how.not_kept === true && how.unsent === true) {
        await appendInDoubtAnchorUnlessSuperseded(
          checkpoint,
          cause,
          `The server restarted before the approved operation '${approved}' started, and Recued could not keep your `
            + 'answer for the next start, so nothing was sent. The run stays held as it was: trying it again asks you '
            + 'for it again.',
        );
        return;
      }
      if (how.not_kept === true && how.went_through === true) {
        await appendInDoubtAnchorUnlessSuperseded(
          checkpoint,
          cause,
          `The approved operation '${approved}' went through before the server restarted, but Recued could not keep `
            + 'where that stopped the run, so it stays held as it was: trying it again asks you for it again, and runs '
            + 'again each step after it that ran. Check before trying it again.',
        );
        return;
      }
      if (held.later_run_again !== true) {
        await appendInDoubtAnchorUnlessSuperseded(checkpoint, cause);
        return;
      }
      // D-201 Slice 10BI (10BF finding 5) — a hand-off it cannot check (the
      // start holds one so, `holdAtApprovedStep`): what the run did is kept,
      // only the hand-off is unproven. It said Recued could not keep what the
      // operation did.
      if (held.handoff_unproven === true) {
        await appendInDoubtAnchorUnlessSuperseded(
          checkpoint,
          cause,
          `The approved operation '${approved}' returned before ${stopped}, but Recued cannot prove it went through: `
            + 'it handed its work on, and returned no hand-off Recued can check. Trying it again asks you for it '
            + 'again, and the steps after it that ran run again too. Check before trying it again.',
        );
        return;
      }
      await appendInDoubtAnchorUnlessSuperseded(
        checkpoint,
        cause,
        `The run went past the approved operation '${approved}' before ${stopped}, but Recued cannot keep what `
          + 'that operation did, so it cannot tell whether it went through. Trying it again asks you for it again, '
          + 'and the steps after it that ran run again too. Check before trying it again.',
      );
      return;
    }
    const step = held.step_in_doubt;
    const where = held.later_run_again === true
      ? `${stopped} after the run went past '${step}', and Recued could not keep how far it got, so it cannot tell `
        + `what went through from '${step}' on. Trying it again goes on from '${step}', with what ran before it `
        + 'kept, and the steps after it that ran run again too.'
      : how.not_kept === true
        ? `${stopped} and Recued could not keep where that stopped the run, so it cannot tell whether '${step}' `
          + `went through. Trying it again goes on from '${step}', with what ran before it kept.`
        : `${stopped} while '${step}' was running, so Recued cannot tell whether that step went through.`;
    // D-201 Slice 10BH — a kept loop's items may have failed: it ran, as its
    // receipt says, rather than went through.
    const cameBack = how.receipt_handoff_unproven === true || how.receipt_handoff_frozen === true
      ? `The approved operation '${approved}' returned,`
      // D-201 Slice 10BZ (10BX finding 5) — skipped, as its receipt reads: it
      // said the step went through.
      : held.approved_skipped === true
        ? `The approved operation '${approved}' was skipped,`
        : held.approved_foreach === true
          ? `The approved operation '${approved}' ran for each of its items, as its receipt says,`
          : `The approved operation '${approved}' went through,`;
    await appendInDoubtAnchorUnlessSuperseded(
      checkpoint,
      cause,
      `${cameBack} but ${where}`
        // D-201 Slice 10BJ (10BF finding 8) — as it was settled: it said the
        // receipt could not be settled of one settled in doubt for a hand-off.
        + (how.receipt_in_doubt === true
          ? how.receipt_handoff_unproven === true
            // The try again reads that receipt and asks for the step again
            // (`heldAsItsReceiptReads`).
            ? ' Its receipt reads in doubt: it handed its work on and returned no hand-off Recued can check, so trying '
              + 'it again asks you for it again, and the steps after it that ran run again too.'
            // D-201 Slice 10CA (10BX finding 12) — frozen before its hand-off
            // was checked: the try again goes on past it, as the row says.
            : how.receipt_handoff_frozen === true
              ? ' Its receipt reads in doubt, frozen before Recued could check its hand-off, so trying it again goes on '
                + 'past it, as it came back.'
              : ` Its receipt reads in doubt: Recued could not settle it from what '${approved}' returned.`
          : '')
        + ' Check before trying it again.',
      step,
    );
  };

  const reconcileClaimedRecipeResume = async (
    store: GatedActionStore,
    action: GatedActionRecord,
    checkpoint: Checkpoint,
    cause: unknown,
    /** D-201 Slice 10BC (10AY findings 10 and 11) — the record as a held row
     *  that stands says it, in place of "may have run". */
    fromHeldRow?: {
      readonly held: ApprovalRestartHeldRun;
      readonly not_kept?: true;
      readonly threw?: true;
      /** D-201 Slice 10CA (10BX finding 9) — stopped before the approved step started. */
      readonly unsent?: true;
    },
  ): Promise<void> => {
    const current = await store.get(action.action_ref);
    if (current === null) {
      throw new Error(
        `[preflight-resumer] claimed gated action disappeared for run_id=${checkpoint.run_id}`,
      );
    }
    if (current.status === 'dispatching'
      && await deps.preserveClaimedDispatch?.(current)) return;
    await settleInterruptedGatedAction(store, current, checkpoint, cause, fromHeldRow?.unsent === true
      // D-201 Slice 10CA (10BX finding 9) — nothing was sent: it said the
      // outcome could not be proven.
      ? 'The server restarted before the approved operation was sent, and Recued could not hand its approval back '
        + 'for the next start. Nothing was sent.'
      : undefined);
    if (fromHeldRow === undefined) {
      await appendInDoubtAnchorUnlessSuperseded(checkpoint, cause);
      return;
    }
    const settled = await store.get(action.action_ref);
    const wentThrough = receiptWentThrough(settled?.status, fromHeldRow.held.approved_foreach === true,
      fromHeldRow.held.approved_skipped === true);
    await appendInDoubtFromHeldRow(checkpoint, fromHeldRow.held, cause, {
      ...(fromHeldRow.not_kept === true ? { not_kept: true as const } : {}),
      ...(fromHeldRow.threw === true ? { threw: true as const } : {}),
      ...(fromHeldRow.unsent === true ? { unsent: true as const } : {}),
      // D-201 Slice 10CA (10BX finding 10) — past the approved step, as its
      // receipt reads.
      ...(!fromHeldRow.held.approved_returned && wentThrough ? { went_through: true as const } : {}),
      ...(fromHeldRow.held.approved_returned && !wentThrough
        ? {
          receipt_in_doubt: true as const,
          // D-201 Slice 10BV (10BS finding 6) — as the try again reads it.
          ...(tryAgainReadsHandoff(fromHeldRow.held, settled) ? { receipt_handoff_unproven: true as const } : {}),
          ...(receiptHandoffFrozen(settled) ? { receipt_handoff_frozen: true as const } : {}),
        }
        : {}),
    });
  };

  /** D-201 Slices 10BC and 10BJ (10AY finding 11, 10BF finding 10) — a claimed
   *  answer's run ended with no terminal outcome of its own, the row it wrote
   *  ahead standing: read as the live stop reads it. Its receipt settled from
   *  the row when the approved step came back (a hand-off it cannot check held
   *  at that step instead), and the record says what the row says, never "may
   *  have run" of the approved step beside a row that names another. */
  const recordFromStandingRow = async (
    gatedStore: GatedActionStore,
    continuations: ApprovalRestartContinuationStore,
    action: GatedActionRecord,
    checkpoint: Checkpoint,
    standing: ApprovalRestartHeldRun,
    cause: unknown,
    how: { readonly threw?: true } = {},
  ): Promise<void> => {
    let held = standing;
    if (standing.approved_returned) {
      const settledHere = await settleFromHeldRow(gatedStore, continuations, action, checkpoint.checkpoint_id);
      if (settledHere.kind === 'went_through') {
        await appendInDoubtFromHeldRow(checkpoint, standing, cause, how);
        return;
      }
      if (settledHere.kind === 'held_at_approved' && settledHere.held !== undefined) held = settledHere.held;
    }
    await reconcileClaimedRecipeResume(gatedStore, action, checkpoint, cause, { held, ...how });
  };

  /** D-201 Slice 10N — the run waits on the owner's answer again, as it did
   *  before this resume: its paused record is put back over the one the stop
   *  wrote, so the next start's replay of the answer resumes it. */
  const restoreAwaitingRun = async (
    executeDeps: ExecuteHandlerDeps,
    checkpoint: Checkpoint,
    paused: AuditEntry,
  ): Promise<void> => {
    await deps.auditLog.append(paused);
    await updateMcpAction(
      actionStoreFor(executeDeps),
      checkpoint.run_id,
      (actions) => actions.markAwaiting(
        checkpoint.run_id,
        checkpoint.checkpoint_id,
        'The server restarted. The approved action finishes at the next start.',
      ),
    );
  };

  /** D-201 Slice 10R (10Q finding 3) — each resume's hold on the in-flight
   *  registry's count, taken where the resume resolves its execute deps (never
   *  earlier: a resume of a run that already ended must not touch them, as when
   *  the vault is locked) and released when it ends. Keyed by the checkpoint
   *  object its caller passed; each caller loads its own. */
  const resumeHolds = new WeakMap<Checkpoint, { release?: () => void }>();
  /** D-201 Slice 10AP — answers' resumes under way, by run (`isResumingRun`). */
  const resuming = new Map<string, number>();
  const holdWhileResuming = (checkpoint: Checkpoint, executeDeps: ExecuteHandlerDeps): void => {
    const scope = resumeHolds.get(checkpoint);
    if (scope === undefined || scope.release !== undefined) return;
    scope.release = executeDeps.inFlightRegistry?.holdUntilSettled();
  };
  const resumer: PreflightResumer = {
    async resumeRun(
      checkpoint: Checkpoint,
      context: PreflightAskContext,
    ): Promise<void> {
      // D-182 §8 — a recipe-LESS raw-op door hold resumes through its own path:
      // there is no run anchor to `decide()` against, and the held op is
      // re-dispatched directly (not via `executeRecipe`). The gated receipt CAS
      // is won here before `resumeRawOp` performs op re-resolve + admission +
      // dispatch + grant mint. An absent `executeDeps` is transient (bootstrap) — throw
      // so the leaf leaves the ask answered for the next boot's retry (the claim
      // is inside `resumeRawOp`, after this point, so no double-act).
      if (checkpoint.raw_op !== undefined) {
        const executeDeps = deps.getExecuteDeps();
        if (!executeDeps) {
          throw new Error(
            `[preflight-resumer] resumeRun (raw_op): executeDeps not yet published — `
              + `run_id=${checkpoint.run_id} (transient; next boot will retry)`,
          );
        }
        holdWhileResuming(checkpoint, executeDeps);
        // D-201 Slice 10N — not started while the server stops; resumed at the next start.
        if (executeDeps.isDraining?.() === true) {
          throw new ApprovedRunStoppedByRestartError(checkpoint.run_id);
        }
        await updateMcpAction(
          actionStoreFor(executeDeps),
          checkpoint.run_id,
          (actions) => actions.markRunning(checkpoint.run_id),
        );
        const rawGatedAction = await markRawGatedActionDispatching(
          gatedActionStoreFor(executeDeps),
          checkpoint,
        );
        if (rawGatedAction.kind === 'already_terminal'
          || rawGatedAction.kind === 'already_dispatching') return;
        const chatCall = observeResumedChatToolCall(executeDeps.db,
          checkpoint.raw_op.execution_source, checkpoint.run_id);
        // D-341 slice B3 — a scheduled prompt's held write answered "Always allow for this scheduled
        // prompt": the grant goes before the write, as on the recipe path.
        await grantAnsweredTriggerPreapproval(executeDeps, checkpoint, context);
        // D-177 N.15 — and "Allow in this chat", likewise.
        grantAnsweredKindGrant(executeDeps, checkpoint, context);
        try {
          const outcome = await resumeRawOp(executeDeps, checkpoint, {
            ...(context.session_grant !== undefined
              ? { session_grant: context.session_grant }
              : {}),
          });
          // The concurrent winner still owns the result. A skipped duplicate
          // must not close its saved call while the provider is still running.
          if (outcome.kind === 'skipped' && outcome.reason === 'resume_already_in_flight') return;
          // D-329 §3.4 — the owner said yes to a held Tier-1 write: its rule key learns it
          // (once per run, however often the answer is told).
          recordWriteRuleAnswer(executeDeps, checkpoint, 'approved');
          // D-348 — and a request's chain learns it, before the run settles below.
          await recordChainAnswer(executeDeps, checkpoint, 'approved');
          await settleRawMcpAction(actionStoreFor(executeDeps), checkpoint, outcome);
          await settleRawGatedAction(
            gatedActionStoreFor(executeDeps),
            rawGatedAction.kind === 'dispatch' ? rawGatedAction.action : undefined,
            checkpoint,
            outcome,
          );
          try {
            runSettled({
              execution_source: checkpoint.raw_op.execution_source,
              run_id: checkpoint.run_id, tool_name: checkpoint.raw_op.op_id,
              result: { success: outcome.kind === 'completed', ...outcome },
              ...(outcome.kind === 'in_doubt' || outcome.kind === 'skipped'
                ? { state: 'interrupted' } : {}),
              ts: Date.now(),
            });
          } catch { /* The operation is already settled; preserve its outcome. */ }
        } finally { chatCall?.interrupt(); }
        return;
      }
      const decision = await decide(checkpoint);
      if (decision.kind === 'skip') {
        if (decision.anchor !== undefined) {
          const priorFailure = recordedApprovalResumeFailure(
            decision.anchor,
            checkpoint,
          );
          if (priorFailure !== undefined) {
            await settleFailedGatedAction(
              gatedActionStoreFor(deps.getExecuteDeps()),
              checkpoint,
              {
                status_message: priorFailure.message,
                result: { code: priorFailure.code, message: priorFailure.message },
              },
            );
          }
        }
        // No-op return — codex BLOCKER 1 fold makes this the
        // idempotency boundary. The leaf consumes the checkpoint and
        // the at-least-once retry cycle terminates.
        console.warn(`[preflight-resumer] resumeRun skipped: ${decision.reason}`);
        return;
      }
      // D-202 Slice 1b — record the owner's APPROVE as a `quality_good` verdict
      // for the reject-driven learner (only when this was a quality-relevant ask,
      // gated inside the helper). Placed at the proceed boundary so it captures
      // the owner's content verdict independent of the downstream resume outcome
      // (a later authz re-check denial is an authorization concern, §12.1). The
      // `decide()` proceed guard means a boot-sweep retry of a completed run
      // skips above (no re-capture); a retry of a still-awaiting run re-captures
      // idempotently (deterministic `signal_id`). Best-effort — never throws.
      if (deps.qualityDelegationSignalStore !== undefined) {
        captureQualityDelegationSignal(
          { signalStore: deps.qualityDelegationSignalStore },
          {
            checkpoint,
            anchor: decision.anchor,
            outcome: 'approve',
            at: context.approved_at ?? Date.now(),
          },
        );
      }
      const executeDeps = deps.getExecuteDeps();
      if (!executeDeps) {
        // Transient: the host hasn't finished bootstrapping. THROW so
        // the leaf does NOT consume the checkpoint — the next boot's
        // sweep retries (codex BLOCKER 2 fold).
        throw new Error(
          `[preflight-resumer] resumeRun: executeDeps not yet published — run_id=${checkpoint.run_id} (transient; next boot will retry)`,
        );
      }
      holdWhileResuming(checkpoint, executeDeps);
      // D-201 Slice 10N (10L finding 3) — an answer that comes while the server
      // stops does not start a run the stop would end: it stays answered, and
      // the next start resumes it without asking again.
      if (executeDeps.isDraining?.() === true) {
        throw new ApprovedRunStoppedByRestartError(checkpoint.run_id);
      }
      // D-201 Slice 10AK (10AI finding 15) — the held run's row left at an
      // earlier ask: its move there could not be written, or the process went
      // before it. This answer is the run's current ask (`decide`), so the row
      // moves here first, as this ask's own would stand, before anything reads
      // it: the run going on, or a refusal before it runs, which ends it as any
      // run's would (finding 11). It ran as a run not held, and its dead
      // letter's try again went on from the old row, sending what this run had
      // sent. Only to a checkpoint with no row: one there is this run's own,
      // kept by a restart.
      moveHeldRowHere(executeDeps, checkpoint, decision.anchor);
      // D-335 slice F — the owner said yes to a held browser write: a site answer mints the
      // pass its hold offered, and the key learns the approval (once per run, however often
      // the answer is told).
      recordBrowserPassAnswer(executeDeps, checkpoint, 'approved', {
        ...(context.browser_pass_kind !== undefined ? { pass: context.browser_pass_kind } : {}),
        ...(context.browser_pass_decision_version === 1 ? { decision_version: 1 } : {}),
      });
      // D-348 — a request's chain learns the answer, before the run proceeds and settles.
      await recordChainAnswer(executeDeps, checkpoint, 'approved');
      await grantAnsweredTriggerPreapproval(executeDeps, checkpoint, context);
      grantAnsweredKindGrant(executeDeps, checkpoint, context);
      await updateMcpAction(
        actionStoreFor(executeDeps),
        checkpoint.run_id,
        (actions) => actions.markRunning(checkpoint.run_id),
      );
      // Bind the approval to the exact recipe body that raised it. Inline runs
      // carry the executable pre-engine snapshot and verify it against the
      // anchor. Stored runs carry the original source-definition hash and
      // compare it with the recipe store NOW, before the dispatch claim: an
      // edit/removal cannot inherit an old decision merely by retaining the
      // same step, ingredient, operation, and connection identifiers.
      let integrityFailure:
        | { message: string; diagnostic: string }
        | undefined;
      let requireFreshApproval = false;
      if (checkpoint.recipe_snapshot !== undefined) {
        const snapshotHash = hashRecipe(
          checkpoint.recipe_snapshot as unknown as RecipeDefinition,
        );
        if (snapshotHash !== decision.anchor.recipe_hash) {
          integrityFailure = {
            message: 'The saved resume checkpoint no longer matches the approved recipe.',
            diagnostic:
              `checkpoint recipe_snapshot hash '${snapshotHash}' does not match the paused `
              + `anchor's recipe_hash '${decision.anchor.recipe_hash}' — tampered/corrupt checkpoint`,
          };
        }
      } else if (checkpoint.recipe_source_hash !== undefined) {
        const currentRecipe = executeDeps.recipeStore.get(checkpoint.recipe_id!);
        // ⛔ CANONICAL ON BOTH SIDES OR NEITHER. The writer hashes the
        // canonical definition, so this must too — and it cannot simply assume
        // the store's copy is already normalized. `parseRecipe` normalizes in
        // place, but only for recipes that went THROUGH it; a recipe registered
        // directly still carries the legacy `output.sidebar` spelling here, and
        // hashing that raw would reproduce the original defect with the sides
        // reversed — refusing a resume because the STORE had not been parsed yet.
        const currentHash = currentRecipe === null
          ? null
          : hashRecipe(canonicalRecipeDefinition(currentRecipe));
        if (currentHash !== checkpoint.recipe_source_hash) {
          // ⛔ THIS GUARD REFUSES ONLY WITHIN ITS OWN STATED SCOPE — an edit
          // that inherits a decision "merely by RETAINING the same step,
          // ingredient, operation, and connection identifiers" (the comment
          // above). Implemented as a blanket refusal it also swallowed the case
          // where those identifiers DID change, which is D-165's entire subject
          // and was already answered, better, one layer down: the catalog gate
          // re-resolves (ingredient_slug, operation_id, connection_name), and on
          // a mismatch "or an absent target" re-raises with the CURRENT identity,
          // minting a fresh checkpoint + ask (fail closed). Withholding
          // `approved_target` is that documented path, so drift re-asks — the
          // owner reviews the new action — instead of dead-ending on "re-run the
          // recipe". `617fc33fb` added this guard and never ran either suite it
          // broke; D-165's re-ask is the incumbent behaviour, not a casualty.
          //
          // 🔑 DEMONSTRABLE DRIFT ONLY, AND FAIL CLOSED OTHERWISE. Deferring is
          // earned by an authored identity field that provably MOVED; anything
          // unresolvable here (a `{{config.*}}` connection, an absent approved
          // target, a missing step) still refuses, because this layer cannot
          // resolve templates and must not guess. The operation literal is left
          // out on purpose: comparing an authored key against a fully-qualified
          // `operation_id` is not a like-for-like comparison, and getting it
          // wrong would open the guard rather than close it.
          const gatedStep = (currentRecipe?.steps as
            | readonly Record<string, unknown>[]
            | undefined)?.find((step) => step.id === checkpoint.gated_step_id);
          const approved = checkpoint.approved_target;
          const movedField = (authored: unknown, approvedValue: string | undefined): boolean =>
            typeof authored === 'string'
            && !authored.includes('{{')
            && approvedValue !== undefined
            && authored !== approvedValue;
          const identityDrifted = gatedStep !== undefined && approved !== undefined
            && (movedField(gatedStep.ingredient, approved.ingredient_slug)
              || movedField(gatedStep.connection, approved.connection_name));
          if (identityDrifted) {
            requireFreshApproval = true;
            console.warn(
              `[preflight-resumer] recipe re-authored to a different target while its approval `
                + `was pending — re-asking with the current identity (run_id=${checkpoint.run_id})`,
            );
          } else {
            integrityFailure = {
              message:
                'The installed recipe changed while this approval was pending. Re-run it and review the new action.',
              diagnostic:
                `stored recipe source hash '${currentHash ?? '<missing>'}' does not match the `
                + `approved source hash '${checkpoint.recipe_source_hash}'`,
            };
          }
        }
      }
      if (integrityFailure !== undefined) {
        // D-201 Slice 10R (10Q finding 17) — a restart kept this run after its
        // approved step went through. "Re-run it" would invite sending that
        // again: the run reads in doubt, saying what went through and what
        // did not run, and what the restart kept goes.
        const keptAfterApproval = executeDeps.approvalRestartContinuations?.get(checkpoint.checkpoint_id) ?? null;
        if (keptAfterApproval !== null && keptAfterApproval.unsent !== true && keptAfterApproval.held === undefined) {
          // D-201 Slice 10BH — a gate raised in a loop carries its progress.
          const changed = restartKeptRecipeChanged(checkpoint.gated_step_id!, keptAfterApproval,
            checkpoint.foreach_progress !== undefined);
          releaseUnkeptRun(executeDeps, checkpoint.run_id);
          await appendInDoubtAnchorUnlessSuperseded(checkpoint, integrityFailure.diagnostic, changed);
          await updateMcpAction(
            actionStoreFor(executeDeps),
            checkpoint.run_id,
            (actions) => actions.finish(checkpoint.run_id, {
              status: 'in_doubt',
              status_message: changed,
              result: { status: 'in_doubt', message: changed },
            }),
          );
          // After the record says what went through: a throw before it leaves
          // the row for the next start to say it again.
          executeDeps.approvalRestartContinuations!.delete(checkpoint.checkpoint_id);
          return;
        }
        const integrityError: RecipeError = {
          error_id:
            `checkpoint-integrity-${Date.now().toString(36)}-`
            + checkpoint.run_id,
          code: 'RECIPE_VALIDATION_FAILED',
          message: integrityFailure.message,
          severity: 'fatal',
          source: {
            recipe_id: decision.anchor.recipe_id,
            step_id: checkpoint.gated_step_id ?? null,
            ingredient_slug: context.tool_slug ?? null,
          },
          details: { reason: 'checkpoint_integrity_failed' },
          timestamp: new Date().toISOString(),
          retryable: false,
        };
        console.warn(
          `[preflight-resumer] resumeRun refused: ${integrityFailure.diagnostic} `
            + `(run_id=${checkpoint.run_id}); re-run the recipe`,
        );
        await appendFailedAnchor({
          checkpoint,
          anchor: decision.anchor,
          recipe_hash: decision.anchor.recipe_hash,
          error: integrityError,
        });
        await updateMcpAction(
          actionStoreFor(executeDeps),
          checkpoint.run_id,
          (actions) => actions.finish(checkpoint.run_id, {
            status: 'failed',
            status_message: 'The saved resume checkpoint failed its integrity check.',
            result: {
              status: 'failed',
              code: 'checkpoint_integrity_failed',
              message: integrityError.message,
            },
          }),
        );
        await settleFailedGatedAction(
          gatedActionStoreFor(executeDeps),
          checkpoint,
          {
            status_message: integrityError.message,
            result: { code: 'checkpoint_integrity_failed', message: integrityError.message },
          },
        );
        return;
      }
      // R2 step 6 (codex HIGH fold) — predecessor provenance integrity.
      // `predecessor_commit_id` is NOT independently trusted off the
      // checkpoint row: a saga compensation recipe's id is
      // `saga-undo-<predecessor_commit_id>` BY CONSTRUCTION
      // (`deriveCompensation`), and that recipe_id sits INSIDE the
      // hash-verified `recipe_snapshot` above — so the snapshot is the
      // tamper-evident carrier and the checkpoint field must agree with
      // it. Any checkpoint carrying a predecessor that (a) has no
      // snapshot, (b) whose snapshot recipe_id is not a compensation id,
      // or (c) disagrees with the id-embedded commit ref was edited on
      // disk to forge compensation provenance — refuse the resume.
      if (checkpoint.predecessor_commit_id !== undefined) {
        const snapshotRecipeId = (
          checkpoint.recipe_snapshot as { recipe_id?: unknown } | undefined
        )?.recipe_id;
        const expectedPredecessor =
          typeof snapshotRecipeId === 'string'
          && snapshotRecipeId.startsWith(COMPENSATION_RECIPE_ID_PREFIX)
            ? snapshotRecipeId.slice(COMPENSATION_RECIPE_ID_PREFIX.length)
            : undefined;
        if (
          expectedPredecessor === undefined
          || checkpoint.predecessor_commit_id !== expectedPredecessor
        ) {
          const provenanceError: RecipeError = {
            error_id:
              `checkpoint-provenance-${Date.now().toString(36)}-`
              + checkpoint.run_id,
            code: 'RECIPE_VALIDATION_FAILED',
            message:
              'The saved compensation provenance no longer matches the approved action.',
            severity: 'fatal',
            source: {
              recipe_id: decision.anchor.recipe_id,
              step_id: checkpoint.gated_step_id ?? null,
              ingredient_slug: context.tool_slug ?? null,
            },
            details: { reason: 'checkpoint_provenance_failed' },
            timestamp: new Date().toISOString(),
            retryable: false,
          };
          console.warn(
            `[preflight-resumer] resumeRun refused: checkpoint predecessor_commit_id `
              + `'${checkpoint.predecessor_commit_id}' is not bound by the hash-verified `
              + `recipe_snapshot (expected '${expectedPredecessor ?? '<none>'}' from the `
              + `compensation recipe id) — forged/corrupt compensation provenance `
              + `(run_id=${checkpoint.run_id}); re-run the recipe`,
          );
          await appendFailedAnchor({
            checkpoint,
            anchor: decision.anchor,
            recipe_hash: decision.anchor.recipe_hash,
            error: provenanceError,
          });
          await updateMcpAction(
            actionStoreFor(executeDeps),
            checkpoint.run_id,
            (actions) => actions.finish(checkpoint.run_id, {
              status: 'failed',
              status_message: 'The saved compensation checkpoint failed its integrity check.',
              result: {
                status: 'failed',
                code: 'checkpoint_provenance_failed',
                message: provenanceError.message,
              },
            }),
          );
          await settleFailedGatedAction(
            gatedActionStoreFor(executeDeps),
            checkpoint,
            {
              status_message: provenanceError.message,
              result: { code: 'checkpoint_provenance_failed', message: provenanceError.message },
            },
          );
          return;
        }
      }
      // D-173 N.5 §4 — when this is an approve-with-edits resume, record
      // the "approved with edits" + changed-key diff (old→new) audit
      // breadcrumb. Attributable to the same admin approve action that
      // authored the edits (N.5 §3 soundness). The "old" side is the gated
      // step's authored/prefilled `input` (the projection-prefilled value
      // before the edit); the "new" side is the override. The DURABLE
      // D-120 release-row diff field lands with `reception.inbox.approve`
      // (Round 2) — its carrier (`GatewayCallAudit` / `AuditEntry`) is a
      // contracts type outside this lane's fence — so this lane emits the
      // ephemeral structured breadcrumb and computes the diff via the
      // exported `computeArgEditsDiff` the rpc will reuse.
      if (checkpoint.arg_overrides !== undefined) {
        // Recipe-bound by construction here (raw-op routed above).
        const recipe = executeDeps.recipeStore.get(checkpoint.recipe_id!);
        const gatedStep = recipe?.steps?.find(
          (s) => (s as { id?: string }).id === checkpoint.gated_step_id,
        ) as { input?: unknown } | undefined;
        const authoredArgs =
          gatedStep?.input
          && typeof gatedStep.input === 'object'
          && !Array.isArray(gatedStep.input)
            ? (gatedStep.input as Record<string, unknown>)
            : undefined;
        const diff = computeArgEditsDiff(authoredArgs, checkpoint.arg_overrides);
        console.info(
          `[preflight-resumer] approved-with-edits run_id=${checkpoint.run_id} `
            + `step='${checkpoint.gated_step_id}' edits=`
            + JSON.stringify(diff),
        );
      }

      // D-196 R2 — the awaiting anchor is evidence of what the user approved,
      // never authority for the later effect. Re-read the bearer and rebuild
      // Seller/contract/grant/route/read-fence authority immediately before
      // `handleExecute`. A denial terminalizes the anchor without invoking the
      // engine, so no pre-gate step or external effect can run and the consumed
      // checkpoint cannot leave a dangling awaiting row.
      let resumeAnchor = decision.anchor;
      const persistedSource = decision.anchor.execution_source;
      const requiresFreshBearer =
        persistedSource?.channel === 'mcp'
        || (
          persistedSource?.channel === 'chat'
          && persistedSource.actor === 'contracted_user'
        );
      if (persistedSource !== undefined && requiresFreshBearer) {
        let authority: ReturnType<
          NonNullable<ExecuteHandlerDeps['approvalResumeAuthority']>['resolve']
        >;
        if (executeDeps.approvalResumeAuthority === undefined) {
          authority = {
            admitted: false,
            reason: 'authority_resolution_failed',
            detail: 'approval-resume authority resolver is unavailable',
          };
        } else {
          try {
            const requiredBearerToolNames = requiredResumeBearerToolNames(
              checkpoint,
              decision.anchor,
              executeDeps,
            );
            authority = executeDeps.approvalResumeAuthority.resolve({
              execution_source: persistedSource,
              ...(requiredBearerToolNames !== undefined
                ? {
                    required_bearer_tool_names: requiredBearerToolNames,
                  }
                : {}),
            });
          } catch (error) {
            authority = {
              admitted: false,
              reason: 'authority_resolution_failed',
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        }
        if (
          authority.admitted
          && executionSourceHasContract(authority.execution_source)
          && authority.contract_snapshot === undefined
        ) {
          authority = {
            admitted: false,
            reason: 'authority_resolution_failed',
            detail: 'fresh authority returned no contract snapshot',
          };
        }
        if (authority.admitted && authority.contract_snapshot !== undefined) {
          const scopeKey = (spheres: readonly ('personal' | 'professional')[] | undefined): string => spheres === undefined ? 'all' : JSON.stringify([...new Set(spheres)].sort());
          if (scopeKey(decision.anchor.contract_snapshot?.read_spheres) !== scopeKey(authority.contract_snapshot.read_spheres)) {
            authority = { admitted: false, reason: 'contract_read_scope_changed',
              detail: 'The contract read spheres changed while the run was waiting. Start a fresh run so earlier data is read under the current scope' };
          }
        }
        if (!authority.admitted) {
          const authorityError: RecipeError = {
            error_id:
              `approval-resume-authority-${Date.now().toString(36)}-`
              + checkpoint.run_id,
            code: 'RECIPE_POLICY_DENIED',
            message:
              `Approval resume denied because live authority changed `
              + `(${authority.reason}: ${authority.detail}).`,
            severity: 'fatal',
            source: {
              recipe_id: decision.anchor.recipe_id,
              step_id: checkpoint.gated_step_id!,
              ingredient_slug: context.tool_slug ?? null,
            },
            details: { authority_reason: authority.reason },
            timestamp: new Date().toISOString(),
            retryable: false,
          };
          await appendFailedAnchor({
            checkpoint,
            anchor: decision.anchor,
            recipe_hash: decision.anchor.recipe_hash,
            error: authorityError,
          });
          console.warn(
            `[preflight-resumer] resumeRun denied by fresh authority: `
              + `${authority.reason}: ${authority.detail} `
              + `(run_id=${checkpoint.run_id})`,
          );
          await updateMcpAction(
            actionStoreFor(executeDeps),
            checkpoint.run_id,
            (actions) => actions.finish(checkpoint.run_id, {
              status: 'failed',
              status_message: authorityError.message,
              result: {
                status: 'failed',
                code: authorityError.code,
                message: authorityError.message,
              },
            }),
          );
          await settleFailedGatedAction(
            gatedActionStoreFor(executeDeps),
            checkpoint,
            {
              status_message: authorityError.message,
              result: { code: authorityError.code, message: authorityError.message },
            },
          );
          return;
        }
        resumeAnchor = { ...decision.anchor };
        resumeAnchor.execution_source = authority.execution_source;
        if (authority.contract_snapshot !== undefined) {
          resumeAnchor.contract_snapshot = authority.contract_snapshot;
        } else {
          delete resumeAnchor.contract_snapshot;
        }
      }
      // D-320 audit — a webhook run resumes under the door that governs its delivery
      // now, when a re-derive replaced the one it started under: the owner's approval
      // is not undone by a change of door (`webhook-resume-door.ts`). The approved step
      // still runs only if that door grants it; an owner's revoke leaves no successor.
      if (persistedSource?.channel === 'webhook') {
        const successor = executeDeps.webhookResumeDoor?.successor(checkpoint.run_id, persistedSource);
        if (successor !== undefined) {
          resumeAnchor = {
            ...resumeAnchor,
            execution_source: successor.execution_source,
            contract_snapshot: successor.contract_snapshot,
          };
        }
      }
      const { request, internal } = buildResumeInputs(
        checkpoint,
        resumeAnchor,
        context.session_grant_decision_version === 1 ? context.session_grant : undefined,
        context.batch_claim,
        requireFreshApproval,
        context.run_question_answer,
      );
      if ((checkpoint.preapproval_execution_ref || checkpoint.preapproval_candidate_ref) && !executeDeps.preapprovalRuntime) {
        throw new Error('The reviewed execution runtime must be ready before resuming this checkpoint.');
      }
      // D-201 Slice 10AZ (10AW finding 1) — `null` is "not reviewed", as
      // `undefined` is where no runtime is wired: the production runtime answers
      // `null` for a checkpoint with no pre-approval (`resumeRun`). Every restart
      // keep below tests `reviewed === undefined`, so on the production server,
      // which always wires the runtime, none of them ran: a restart's stop kept
      // nothing, and a death after an approved write had its try again ask for
      // that write again. The tests that proved them wired no runtime.
      const reviewed = (await executeDeps.preapprovalRuntime?.resume(checkpoint)) ?? undefined;
      if (reviewed) {
        if (reviewed.kind === 'candidate') internal.preapproval_candidate = reviewed.handle;
        else internal.preapproval_run = reviewed.handle;
        request.config = reviewed.config;
        request.execution_source = reviewed.plan.origin.source;
        request.contract_snapshot = executeDeps.preapprovalRuntime!.resolveOrigin(reviewed.handle).contract_snapshot;
      } else if (checkpoint.execution_phase === 'trigger' && request.trigger_source === 'auto_run') {
        if (checkpoint.auto_run_qualification && !executeDeps.preapprovalDriver) throw new Error('The automatic qualification driver is unavailable.');
        if (executeDeps.preapprovalDriver) Object.assign(internal, executeDeps.preapprovalDriver.resumeAutoRunQualification(checkpoint));
      }
      const gatedStore = gatedActionStoreFor(executeDeps);
      // D-201 Slice 10W — what this run keeps if the server's own stop ends it,
      // written from the run's own report BEFORE its record (10V finding 3).
      const restart: {
        stop?: ApprovedRunRestartStop;
        kept?: 'unsent' | 'returned' | 'held' | 'none';
        keepError?: unknown;
      } = {};
      /** D-201 Slice 10AV — the last row written ahead (`onStepUnderWay`): the
       *  step it names, and whether the approved step had come back. */
      let ahead: { readonly approved_returned: boolean; readonly step: string } | undefined;
      // A step re-authored meanwhile asks afresh (`requireFreshApproval`): a
      // value it returned before cannot stand in for the step as it is now.
      if (requireFreshApproval
        && executeDeps.approvalRestartContinuations?.get(checkpoint.checkpoint_id)?.held === undefined) {
        executeDeps.approvalRestartContinuations?.delete(checkpoint.checkpoint_id);
      }
      // D-201 Slice 10W (10V finding 3) — kept before the approved step started:
      // its receipt goes back to waiting on this answer, then is claimed as any.
      await reawaitUnsentReceipt(executeDeps, gatedStore, checkpoint);
      const continuation = requireFreshApproval
        ? undefined
        : await restartContinuationFor(executeDeps.approvalRestartContinuations, gatedStore, checkpoint);
      const dispatchClaim: RecipeDispatchClaim = continuation !== undefined
        ? { kind: 'continuation', continuation }
        : await claimRecipeDispatch(gatedStore, checkpoint);
      if (dispatchClaim.kind === 'superseded') {
        if (reviewed) await executeDeps.preapprovalRuntime!.finish(reviewed.handle, 'failed');
        console.warn(
          `[preflight-resumer] resumeRun skipped: gated action now points at checkpoint `
            + `'${dispatchClaim.action.current_checkpoint_id}', not '${checkpoint.checkpoint_id}' `
            + `(run_id=${checkpoint.run_id})`,
        );
        return;
      }
      if (dispatchClaim.kind === 'already_dispatching') {
        if (reviewed) await executeDeps.preapprovalRuntime!.finish(reviewed.handle, 'in_doubt');
        // D-201 Slice 10W — a process that went without a drain (a crash) had
        // claimed it: how far it got is unknown. Kept for the owner's try again,
        // which asks for the approved step afresh, the steps before it standing
        // in; the steps after it run again.
        // D-201 Slice 10AV (10AS finding 9) — unless the run wrote where it was
        // before each step (`onStepUnderWay`): that row stands, the approved
        // step's receipt settled from it when it had come back, and the record
        // names the step it names. Replaced here, a death after the approved
        // write had its try again ask for that write again.
        const standing = executeDeps.approvalRestartContinuations?.get(checkpoint.checkpoint_id)?.held;
        if (standing !== undefined && reviewed === undefined) {
          // D-201 Slice 10BC (10AY finding 11) — read as the live stop reads it:
          // a hand-off its receipt cannot prove holds the run at the approved
          // step; a fault, tried again, that still refuses leaves the receipt in
          // doubt (settled below), and the record says so beside the row.
          await recordFromStandingRow(gatedStore!, executeDeps.approvalRestartContinuations!, dispatchClaim.action,
            checkpoint, standing, 'a prior durable dispatch claim has no retained terminal outcome');
          return;
        }
        if (reviewed === undefined && isWebhookRun(decision.anchor)) {
          try {
            executeDeps.approvalRestartContinuations?.put({
              checkpoint_id: checkpoint.checkpoint_id,
              run_id: checkpoint.run_id,
              gated_step_id: checkpoint.gated_step_id!,
              value: undefined,
              later: [],
              held: {
                checkpoint,
                anchor: decision.anchor,
                approved_returned: false,
                step_in_doubt: checkpoint.gated_step_id!,
                progress_unknown: true,
              },
            });
          } catch (error) {
            console.warn(`[preflight-resumer] run ${checkpoint.run_id} not kept for its try again: ${String(error)}`);
          }
        }
        await reconcileClaimedRecipeResume(
          gatedStore!,
          dispatchClaim.action,
          checkpoint,
          'a prior durable dispatch claim has no retained terminal outcome',
        );
        return;
      }
      if (dispatchClaim.kind === 'already_terminal') {
        if (reviewed) await executeDeps.preapprovalRuntime!.finish(reviewed.handle, 'failed');
        const cause = `receipt already terminal with status '${dispatchClaim.action.status}'`;
        // D-201 Slice 10AV (10AS finding 9) — the start after a death froze the
        // receipt still dispatching (`reconcileInterruptedGatedActionsAtBoot`)
        // before this replay, so 10W's keep for a claimed dispatch was never
        // reached: nothing was held, and the try again ran the recipe from its
        // first step. Kept here as there, unless the run wrote where it was, the
        // row first, before the record.
        const continuationsHere = executeDeps.approvalRestartContinuations;
        let standing = continuationsHere?.get(checkpoint.checkpoint_id)?.held;
        if (standing === undefined && continuationsHere !== undefined && reviewed === undefined
          && isWebhookRun(decision.anchor) && frozenAtTheStart(dispatchClaim.action)) {
          const held: ApprovalRestartHeldRun = {
            checkpoint,
            anchor: decision.anchor,
            approved_returned: false,
            step_in_doubt: checkpoint.gated_step_id!,
            progress_unknown: true,
          };
          try {
            continuationsHere.put({
              checkpoint_id: checkpoint.checkpoint_id,
              run_id: checkpoint.run_id,
              gated_step_id: checkpoint.gated_step_id!,
              value: undefined,
              later: [],
              held,
            });
            standing = held;
          } catch (error) {
            console.warn(`[preflight-resumer] run ${checkpoint.run_id} not kept for its try again: ${String(error)}`);
          }
        }
        if (standing !== undefined && reviewed === undefined) {
          // D-201 Slice 10BC (10AY finding 11) — a row past the approved step
          // beside a receipt that does not read as gone through, read as the
          // live stop reads it. Settled otherwise (a hand-off it cannot prove):
          // held at the approved step. Frozen in doubt (the start's settle kept
          // failing, or never ran): the row stands, the step having come back,
          // and the record says the receipt reads in doubt. It said the step
          // went through and nothing else.
          let held = standing;
          let receiptInDoubt = false;
          if (standing.approved_returned
            && !receiptWentThrough(dispatchClaim.action.status, standing.approved_foreach === true,
              standing.approved_skipped === true)) {
            // D-201 Slice 10CA (10BX finding 11) — frozen by the start or by
            // the run's own fallback alike (`frozenInDoubt`), as the try again
            // reads it: a receipt the fallback froze was held at the approved
            // step here, asked for again, and run again with every later step.
            if (!frozenInDoubt(dispatchClaim.action)) {
              try {
                const row = continuationsHere?.get(checkpoint.checkpoint_id) ?? null;
                if (row !== null) {
                  held = holdAtApprovedStep(continuationsHere!, row, receiptHandoffUnproven(dispatchClaim.action))
                    ?? standing;
                }
              } catch {
                // Held as it stands; the record says the receipt reads in doubt.
              }
            }
            receiptInDoubt = held.approved_returned;
          }
          await appendInDoubtFromHeldRow(checkpoint, held, cause, receiptInDoubt
            ? {
              receipt_in_doubt: true as const,
              // D-201 Slice 10BV (10BS finding 6) — as the try again reads it.
              ...(tryAgainReadsHandoff(held, dispatchClaim.action) ? { receipt_handoff_unproven: true as const } : {}),
              ...(receiptHandoffFrozen(dispatchClaim.action) ? { receipt_handoff_frozen: true as const } : {}),
            }
            : {});
        } else {
          await appendInDoubtAnchorUnlessSuperseded(checkpoint, cause);
        }
        // D-201 Slice 10W (10V finding 4) — the run ends here without running:
        // a kept row the next start dropped (one from before 10R, a receipt not
        // settled from the step) or an approved step re-pointed while kept. Its
        // temp files and "Yes, this time" pre-approvals go, as at any run's end.
        // D-201 Slice 10AB (10AA finding 12) — unless it is held for the
        // owner's try again (its process went before its record said so).
        if (executeDeps.approvalRestartContinuations?.get(checkpoint.checkpoint_id)?.held === undefined) {
          releaseUnkeptRun(executeDeps, checkpoint.run_id);
        }
        return;
      }
      if (dispatchClaim.kind === 'claimed') {
        internal.gated_action_ref = dispatchClaim.action.action_ref;
      }
      // D-201 Slice 10N — finishing what a restart stopped after the approved
      // step returned: its value stands in for the step, which is not sent again.
      // D-201 Slice 10R (10Q finding 1) — and so does each later step that had
      // finished, so the run goes on from the first that had not; it continues
      // the alias ledgers it had then, which those values may carry.
      if (dispatchClaim.kind === 'continuation' && internal.resume_from !== undefined) {
        const kept = dispatchClaim.continuation;
        internal.resume_from = {
          ...internal.resume_from,
          // D-201 Slice 10BO (10BM finding 7) — a skipped step replays as one.
          replayed_result: { value: kept.value, ...(kept.approved_skipped === true ? { skipped: true as const } : {}) },
          replayed_steps: kept.later ?? [],
          ...(kept.pii_ledgers !== undefined ? { pii_ledgers: kept.pii_ledgers } : {}),
        };
      }
      // D-201 Slice 10N — the run reports the server's own stop, and what the
      // owner approved survives it (the owner's call, 2026-11-19). Not for a
      // reviewed run (its own hand-back), a run question or a trial.
      // D-201 Slice 10R — nor only the first time: the run that finishes a kept
      // one reports a second stop, which keeps what it did as well.
      // D-201 Slice 10AG (10AE finding 2) — the answer to an ask a held try
      // again paused at: still the owner's held run. So is the next start's
      // finish of it, when a restart stopped that answer's resume
      // (`held_before`).
      const heldRowHere = dispatchClaim.kind === 'claimed'
        ? executeDeps.approvalRestartContinuations?.get(checkpoint.checkpoint_id) ?? null
        : null;
      const heldBefore = heldRowHere?.held
        ?? (dispatchClaim.kind === 'continuation' ? dispatchClaim.continuation.held_before : undefined);
      const heldHere = heldBefore !== undefined && executeDeps.approvalRestartContinuations !== undefined;
      if ((dispatchClaim.kind === 'claimed' || dispatchClaim.kind === 'continuation') && reviewed === undefined
        && checkpoint.run_question === undefined && checkpoint.trial !== true
        && executeDeps.approvalRestartContinuations !== undefined) {
        const continuations = executeDeps.approvalRestartContinuations;
        internal.onStoppedByRestart = (outcome) => {
          restart.stop = outcome;
          // D-201 Slice 10W (10V finding 3) — the row first: this runs before
          // the run's record says `killed`, so no kill and no drain wait that
          // runs out can leave that record without it.
          // D-201 Slice 10BP (10BM finding 9) — tried three times, as the
          // start's hold at the approved step is: refused once, the row it wrote
          // ahead stood while the record said the try again asks again.
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              restart.kept = keepStopNow(continuations, checkpoint, decision.anchor, dispatchClaim.kind, outcome, heldBefore);
              restart.keepError = undefined;
              break;
            } catch (error) {
              restart.keepError = error;
            }
          }
          // D-201 Slice 10BP (10BM findings 9 and 10) — refused at every try,
          // the row that stands is one this run wrote ahead, or the one held
          // before this answer: marked where the stop went past the step it
          // names, as a refused row ahead marks it, so Settings says the steps
          // after it run again.
          const standing = ahead !== undefined || heldRowHere?.held !== undefined;
          if (restart.keepError !== undefined && standing && outcome.kind === 'in_doubt') {
            markStandingRowLags(continuations, checkpoint.checkpoint_id, checkpoint.run_id,
              outcome.step_id ?? checkpoint.gated_step_id!, outcome.later_run_again === true);
          }
          // D-201 Slice 10AB (10AA finding 12) — held for the owner's try
          // again: the run keeps its temp files and pre-approvals for it.
          // D-201 Slice 10AV (10AS finding 7) — so it is when the stop's own row
          // failed and the one it wrote ahead stands. D-201 Slice 10BP (10BM
          // finding 10) — or the one held before this answer, when this answer
          // wrote none: its record said nothing held the run.
          return restart.kept === 'held' || (restart.keepError !== undefined && standing);
        };
        // D-201 Slice 10AV (10AS findings 7 and 9) — the row first, before each
        // step from the approved one on: what a death there leaves, as a stop
        // there would keep it. A death never reported a stop, so the next start
        // found the approved step's receipt dispatching and kept the run at the
        // asked step: its try again asked for the approved write again and ran
        // it twice, though a later step was the one under way.
        if (isWebhookRun(decision.anchor)) {
          internal.onStepUnderWay = (outcome) => {
            try {
              if (keepStopNow(continuations, checkpoint, decision.anchor, dispatchClaim.kind, outcome, heldBefore, true) === 'held') {
                ahead = {
                  approved_returned: outcome.step_id !== undefined,
                  step: outcome.step_id ?? checkpoint.gated_step_id!,
                };
              }
            } catch (error) {
              console.warn(
                `[preflight-resumer] run ${checkpoint.run_id}: where it is could not be kept: `
                  + (error instanceof Error ? error.message : String(error)),
              );
              // D-201 Slice 10BC (10AY finding 9) — the row that stands lags.
              markStandingRowLags(continuations, checkpoint.checkpoint_id, checkpoint.run_id,
                outcome.step_id ?? checkpoint.gated_step_id!, outcome.later_run_again === true);
            }
          };
        }
      }
      // D-201 Slice 10AG (10AE finding 2) — a failure after the held run's
      // approved step is held again from the step that failed, as the try
      // again's own is, so its delivery is the dead letter again
      // (`HeldRunPass.isHeldFailure`). It failed as any run: the delivery was
      // cancelled, and finishing it meant running the recipe again, its
      // approved steps too.
      let heldAgain = false;
      /** D-201 Slice 10AP (10AM findings 5, 17 and 18) — the hold the report
       *  asked for, its write failed: written again once the run ends, and
       *  never replaced by a hold at the asked step after a later failure. */
      let unwrittenHold: {
        readonly asked: boolean;
        readonly step: string;
        readonly write: () => void;
        readonly cause: unknown;
      } | undefined;
      /** D-201 Slice 10AG (10AE finding 10) — held as it stood before this
       *  resume, marked failed: its try again asks for that step again. */
      const holdAsItStood = (): boolean => {
        // D-201 Slice 10BH (10BF finding 1) — with the mark this run's own rows
        // wrote ahead: it went past an approved step Recued cannot keep before
        // it failed. Held as it stood before, the mark went, and Settings said
        // only that step could run twice while the steps after it ran again.
        let lags = false;
        try {
          lags = executeDeps.approvalRestartContinuations!.get(checkpoint.checkpoint_id)?.held?.later_run_again === true;
        } catch {
          // Held as it stood before.
        }
        executeDeps.approvalRestartContinuations!.put({
          checkpoint_id: checkpoint.checkpoint_id,
          run_id: checkpoint.run_id,
          gated_step_id: checkpoint.gated_step_id!,
          value: heldRowHere?.value,
          later: heldRowHere?.later ?? [],
          ...(heldRowHere?.pii_ledgers !== undefined ? { pii_ledgers: heldRowHere.pii_ledgers } : {}),
          held: { ...heldBefore!, failed: true, ...(lags ? { later_run_again: true as const } : {}) },
        });
        return true;
      };
      /** D-201 Slice 10AV (10AS finding 17) — the step the run is held from
       *  after a failure, for its record's words. */
      let heldFromStep: string | undefined;
      if (heldHere) {
        const continuations = executeDeps.approvalRestartContinuations!;
        internal.onFailedAfterApproval = (failure) => {
          const asked = failure.unasked === true;
          heldFromStep = asked ? heldBefore!.step_in_doubt : failure.step_id ?? checkpoint.gated_step_id!;
          const write = asked
            ? (): void => { holdAsItStood(); }
            : (): void => continuations.put({
              checkpoint_id: checkpoint.checkpoint_id,
              run_id: checkpoint.run_id,
              gated_step_id: checkpoint.gated_step_id!,
              value: failure.value,
              later: failure.later,
              ...(failure.pii_ledgers !== undefined ? { pii_ledgers: failure.pii_ledgers } : {}),
              held: {
                checkpoint,
                anchor: decision.anchor,
                approved_returned: true,
                step_in_doubt: failure.step_id ?? checkpoint.gated_step_id!,
                failed: true,
                // D-201 Slice 10AP (10AM finding 4) — a later failure bounds
                // nothing a death left unknown; a later ask does, at its move.
                ...(heldBefore!.progress_unknown === true ? { progress_unknown: true as const } : {}),
                // D-201 Slice 10BC (10AY findings 2 and 9) — nor what could not be kept.
                ...(heldBefore!.later_run_again === true ? { later_run_again: true as const } : {}),
                // D-201 Slice 10BH — past a kept loop, as the rows ahead said it.
                ...(failure.approved_foreach === true ? { approved_foreach: true as const } : {}),
                // D-201 Slice 10BJ (10BF finding 9) — past a skipped step.
                ...(failure.approved_skipped === true ? { approved_skipped: true as const } : {}),
              },
            });
          try {
            write();
            heldAgain = true;
          } catch (error) {
            // D-201 Slice 10AP (10AM findings 5 and 17) — not thrown to the
            // handler, which released the run's temp files and "Yes, this
            // time" pre-approvals and left the run to a hold at the asked
            // step: kept for now, and written again once the run ends.
            unwrittenHold = {
              asked,
              step: asked ? heldBefore!.step_in_doubt : failure.step_id ?? checkpoint.gated_step_id!,
              write,
              cause: error,
            };
          }
          return true;
        };
      }
      // D-201 Slices 10N and 10R — keep a run the server's own stop ended, for
      // the next start: before the approved step, its receipt waits on this
      // answer again (a continuation's row stands as it was); after it, the
      // value of the step and of every later step that finished is kept to
      // stand in for them. Throws when it cannot be kept.
      const keepForNextStart = async (
        known: Extract<ApprovedRunRestartStop, { kind: 'unsent' | 'returned' }>,
      ): Promise<void> => {
        // D-201 Slice 10W — written at the stop's report (`keepStopNow`).
        if (restart.keepError !== undefined) throw restart.keepError;
        if (restart.kept === undefined) throw new Error('the stop was not kept');
        if (known.kind === 'unsent') {
          if (dispatchClaim.kind !== 'claimed') return;
          const handedBack = await gatedStore!.markAwaiting(
            dispatchClaim.action.action_ref,
            checkpoint.checkpoint_id,
            'The server restarted before the approved operation was sent. The next start sends it, without asking again.',
          );
          if (handedBack?.status !== 'awaiting_approval'
            || handedBack.current_checkpoint_id !== checkpoint.checkpoint_id) {
            throw new Error('the approval receipt could not be handed back');
          }
          return;
        }
      };
      // Dispatch through the normal handler with the internal
      // overrides. Once a receipt-backed dispatch claim wins, a throw no longer
      // retries the effect: receipt + run audit converge conservatively to
      // in_doubt before the answered checkpoint retires. Legacy checkpoints
      // without a receipt retain the old retry behavior.
      let response: ExecuteResponse;
      try {
        response = await handleExecute(executeDeps, request, internal);
      } catch (error) {
        // The handler checks page account revisions before starting the engine.
        // This refusal proves no resumed effect ran, even after a durable claim.
        if (error instanceof RpcError && error.code === 'connection_changed') {
          const failure: RecipeError = {
            error_id: `page-account-changed-${checkpoint.run_id}`,
            code: 'RECIPE_POLICY_DENIED', message: error.message, severity: 'fatal',
            source: { recipe_id: resumeAnchor.recipe_id, step_id: checkpoint.gated_step_id ?? null, ingredient_slug: null },
            details: { reason: 'connection_changed' }, timestamp: new Date().toISOString(), retryable: false,
          };
          if (dispatchClaim.kind === 'continuation') executeDeps.approvalRestartContinuations?.delete(checkpoint.checkpoint_id);
          await appendFailedAnchor({ checkpoint, anchor: resumeAnchor, recipe_hash: resumeAnchor.recipe_hash, error: failure });
          if (reviewed) await executeDeps.preapprovalRuntime!.finish(reviewed.handle, 'failed');
          await settleFailedGatedAction(gatedStore, checkpoint, { status_message: failure.message,
            result: { code: failure.code, message: failure.message } });
          await updateMcpAction(actionStoreFor(executeDeps), checkpoint.run_id,
            actions => actions.finish(checkpoint.run_id, { status: 'failed', status_message: failure.message,
              result: { code: failure.code, message: failure.message } }));
          return;
        }
        if (dispatchClaim.kind === 'continuation') {
          // D-201 Slice 10R — a run that finishes a kept one and throws leaves
          // what it did after the replayed steps unknown: kept as it was, the
          // row would run that again (10N kept it during a drain). In doubt, as
          // a claimed run that throws is.
          executeDeps.approvalRestartContinuations?.delete(checkpoint.checkpoint_id);
          releaseUnkeptRun(executeDeps, checkpoint.run_id);
          await appendInDoubtAnchorUnlessSuperseded(checkpoint, error);
          await updateMcpAction(
            actionStoreFor(executeDeps),
            checkpoint.run_id,
            (actions) => actions.finish(checkpoint.run_id, {
              status: 'in_doubt',
              status_message: RESTART_CONTINUATION_IN_DOUBT,
              result: { status: 'in_doubt', message: String(error) },
            }),
          );
          return;
        }
        if (dispatchClaim.kind === 'legacy_without_receipt') {
          // Additive compatibility only: old checkpoints have no durable claim,
          // so retain their established retry behavior.
          await updateMcpAction(
            actionStoreFor(executeDeps),
            checkpoint.run_id,
            (actions) => actions.markAwaiting(
              checkpoint.run_id,
              checkpoint.checkpoint_id,
              'Resume was interrupted before a terminal result; Recued will retry from the durable checkpoint.',
            ),
          );
          throw error;
        }
        // D-201 Slice 10BJ (10BF finding 10) — the run wrote where it was ahead:
        // that row stands, held for the owner's try again, and is read as the
        // start reads it. The record named the approved step as maybe run, while
        // the row and Settings named a later one, and the receipt was frozen in
        // doubt beside a row that says the step came back.
        let standingHere: ApprovalRestartHeldRun | undefined;
        if (ahead !== undefined) {
          try {
            standingHere = executeDeps.approvalRestartContinuations?.get(checkpoint.checkpoint_id)?.held;
          } catch {
            // Recorded as before.
          }
        }
        if (standingHere !== undefined) {
          await recordFromStandingRow(gatedStore!, executeDeps.approvalRestartContinuations!, dispatchClaim.action,
            checkpoint, standingHere, error, { threw: true });
        } else {
          await reconcileClaimedRecipeResume(
            gatedStore!,
            dispatchClaim.action,
            checkpoint,
            error,
          );
        }
        await updateMcpAction(
          actionStoreFor(executeDeps),
          checkpoint.run_id,
          (actions) => actions.finish(checkpoint.run_id, {
            status: 'in_doubt',
            status_message:
              'The approved operation was interrupted after dispatch began. Inspect Logs before retrying.',
            result: { status: 'in_doubt', message: String(error) },
          }),
        );
        return;
      }
      // D-201 Slice 10N — the server's own stop ended the approved run before
      // or after its step, and nothing it approves is in doubt: the answer is
      // kept, and the next start finishes the run without asking again. Before
      // the step, the receipt goes back to waiting on this answer; after it,
      // the step's value is kept to stand in for it.
      const stop = restart.stop;
      if (stop !== undefined && stop.kind !== 'in_doubt'
        && (dispatchClaim.kind === 'claimed' || dispatchClaim.kind === 'continuation')) {
        try {
          await keepForNextStart(stop);
        } catch (error) {
          // Cannot be kept for the next start: what is known is recorded, its
          // temp files and pre-approvals go as at any run's end, and the owner
          // reviews it. D-201 Slice 10AV (10AS finding 7) — unless the run wrote
          // where it was ahead: that row stands, held for the owner's try again,
          // with them. Deleted, the try again ran the recipe from its first step.
          // D-201 Slice 10BV (10BS finding 9) — or the row held before this
          // answer stands, as for a stop in doubt (10BP): its resources went,
          // and its record said the outcome could not be proven, while Settings
          // held it and the try again asked for the step again.
          // D-201 Slice 10BC (10AY finding 10) — the row written ahead stands:
          // the record says what it says, naming the step it stands at. It
          // named the approved step as maybe run, while the row and Settings
          // named the step in doubt.
          // D-201 Slice 10CA (10BX finding 8) — read as it stands now, not as it
          // was before the run: an unsent stop's own row replaced the one held
          // before this answer, and the run's resources were kept for a row no
          // longer there, which nothing then released. Nothing was sent, so
          // that row is put back, and the run stands held as it was.
          let standing: ApprovalRestartHeldRun | undefined;
          let unread = false;
          try {
            standing = executeDeps.approvalRestartContinuations?.get(checkpoint.checkpoint_id)?.held;
          } catch {
            unread = true;
          }
          if (standing === undefined && !unread && stop.kind === 'unsent' && heldRowHere?.held !== undefined) {
            try {
              executeDeps.approvalRestartContinuations!.put({ ...heldRowHere, later: heldRowHere.later ?? [] });
              standing = heldRowHere.held;
            } catch {
              // Nothing holds the run: what it kept goes.
            }
          }
          const rowStands = ahead !== undefined || standing !== undefined
            || (unread && heldRowHere?.held !== undefined);
          if (!rowStands) releaseUnkeptRun(executeDeps, checkpoint.run_id);
          if (dispatchClaim.kind === 'claimed') {
            await deps.auditLog.append(decision.anchor);
            await reconcileClaimedRecipeResume(gatedStore!, dispatchClaim.action, checkpoint, error,
              standing !== undefined
                ? { held: standing, not_kept: true, ...(stop.kind === 'unsent' ? { unsent: true as const } : {}) }
                : undefined);
          } else {
            if (ahead === undefined) executeDeps.approvalRestartContinuations?.delete(checkpoint.checkpoint_id);
            await deps.auditLog.append(decision.anchor);
            if (standing !== undefined) {
              await appendInDoubtFromHeldRow(checkpoint, standing, error, { not_kept: true });
            } else {
              await appendInDoubtAnchorUnlessSuperseded(checkpoint, error);
            }
          }
          await updateMcpAction(
            actionStoreFor(executeDeps),
            checkpoint.run_id,
            (actions) => actions.finish(checkpoint.run_id, {
              status: 'in_doubt',
              status_message: RESTART_NOT_KEPT,
              result: { status: 'in_doubt', message: String(error) },
            }),
          );
          return;
        }
        await restoreAwaitingRun(executeDeps, checkpoint, decision.anchor);
        throw new ApprovedRunStoppedByRestartError(checkpoint.run_id);
      }
      // D-201 Slice 10AG — but a held run's finish: what it keeps is decided
      // below (a failure's held row would go here).
      if (dispatchClaim.kind === 'continuation' && restart.kept !== 'held' && !heldHere
        // D-201 Slice 10AV (10AS finding 7) — a stop whose own row failed: the
        // one written ahead stands, held.
        && !(restart.keepError !== undefined && ahead !== undefined)) {
        // D-201 Slice 10R — it finished, or ended some other way: the owner's
        // Stop, a failure, or a later step in doubt. Nothing is kept: a stop by
        // the server itself was kept above, from this run's own report.
        // D-201 Slice 10W — save a webhook run's in-doubt stop, held for the
        // owner's try again in its place.
        executeDeps.approvalRestartContinuations?.delete(checkpoint.checkpoint_id);
      }
      // D-201 Slice 10AG (10AE finding 2) — the held try again's answer ended.
      // Finished, or the owner's Stop: nothing is held. Paused again: the held
      // row moves to that ask. Failed where the report above read nothing (a
      // run refused before its approved step): held as it stood, marked failed,
      // its try again asking for that step again. A stop by the server itself
      // was kept above.
      // D-201 Slice 10AP (10AM findings 5, 17 and 18) — a hold the report asked
      // for whose write failed is written again here. Still unwritten, the run
      // reads in doubt, so its delivery stays the owner's dead letter, never a
      // cancel: held where it stood when its asked step failed, its temp files
      // and pre-approvals with it; past the approved step, held no longer, for
      // the row at the asked step would have it asked for and sent again. 10AK
      // held that row, marked failed, after the report's write failed, as
      // though the approved step had failed.
      if (heldHere && stop === undefined && unwrittenHold !== undefined) {
        const unwritten = unwrittenHold;
        const continuations = executeDeps.approvalRestartContinuations!;
        let cause: unknown = unwritten.cause;
        try {
          unwritten.write();
          cause = undefined;
        } catch (error) {
          cause = error;
        }
        if (cause !== undefined) {
          // D-201 Slice 10AV (10AS findings 7 and 19) — never deleted, and its
          // temp files and pre-approvals stay with it: the row that stands goes
          // on from closer than the first step. It is the last one the run wrote
          // ahead (`onStepUnderWay`), past the approved step when that came
          // back, or the one at the asked step. Deleted, the try again ran the
          // recipe from its first step, asking for and sending every earlier
          // step again; and a fault that refused the delete too left a row whose
          // temp files and "Yes, this time" were gone.
          const standing = continuations.get(checkpoint.checkpoint_id)?.held;
          // D-201 Slice 10AV (10AS finding 16) — with the run's own errors: the
          // record replaced the handler's, and lost why the step failed.
          let own: AuditEntry['errors'] = [];
          try {
            const written = await deps.auditLog.get(checkpoint.run_id);
            if (written !== null && written.commit_status === 'failed') own = written.errors ?? [];
          } catch {
            // The record says what is known without them.
          }
          // D-201 Slice 10AV (10AS finding 14) — tried again: a fault that
          // refused this write once left the handler's `failed`, and the
          // reconcile cancelled the delivery.
          await appendRetrying(deps.auditLog, unwrittenHoldRecord(
            decision.anchor,
            checkpoint,
            cause,
            unwritten.asked ? 'held_run_mark_unwritten' : 'held_run_hold_unwritten',
            unwritten.step,
            standing,
            own,
          ));
        }
      } else if (heldHere && stop === undefined) {
        const continuations = executeDeps.approvalRestartContinuations!;
        try {
          if (response.success || response.run_terminated !== undefined) {
            continuations.delete(checkpoint.checkpoint_id);
          } else if (response.awaiting_approval !== undefined) {
            if (!await moveHeldToAsk(deps.auditLog, executeDeps, checkpoint.checkpoint_id, checkpoint.run_id)) {
              continuations.delete(checkpoint.checkpoint_id);
            }
          } else if (!heldAgain) {
            holdAsItStood();
          }
        } catch {
          // The held row stands as it was, for the next pass to read.
        }
      }
      // D-201 Slice 10AV (10AS finding 9) — what a first resume wrote ahead was
      // for a death: ended any other way, nothing is held (a failure ends as
      // any run's, a later ask is its own), so it goes. A stop's own row stands.
      if (dispatchClaim.kind === 'claimed' && !heldHere && ahead !== undefined && restart.stop === undefined) {
        try {
          executeDeps.approvalRestartContinuations?.delete(checkpoint.checkpoint_id);
        } catch {
          // Swept once its delivery is closed (`sweepHeldApprovalRuns`).
        }
      }
      // D-201 Slice 10AV (10AS finding 17) — a held run's failure worded as the
      // held run it is, on this road too: a later ask it could not write said
      // to re-run it from scratch, while its dead letter goes on from where it
      // is held. Only the try again's road reworded it.
      if (heldHere && stop === undefined && heldFromStep !== undefined && !response.success
        && response.awaiting_approval === undefined && response.run_terminated === undefined) {
        try {
          const now = await deps.auditLog.get(checkpoint.run_id);
          // D-201 Slice 10BH (10BF finding 1) — as the row now held says it.
          const worded = now !== null && now.commit_status === 'failed'
            ? heldWording(now.errors, heldFromStep,
              heldAsksAgainPast(executeDeps.approvalRestartContinuations, checkpoint.checkpoint_id))
            : undefined;
          if (worded !== undefined) await deps.auditLog.append({ ...now!, errors: worded });
        } catch {
          // Its record stands as the handler wrote it.
        }
      }
      if (dispatchClaim.kind === 'claimed') {
        // `handleExecute` owns the exact per-operation result. This postcondition
        // only closes a torn receipt/audit split; it never substitutes the whole
        // recipe response for the operation result.
        await reconcileClaimedRecipeResume(
          gatedStore!,
          dispatchClaim.action,
          checkpoint,
          'resumed handler returned without a durable terminal receipt and run anchor',
        );
      }
      // ⛔ A TOOL THAT HELD ITS OWN RUN FINISHES IT. `document.read`'s reader
      // run returns the file's bytes, which only the reader's checks turn into a
      // result; delivered raw, an approval handed them to the caller unchecked.
      // Both deliveries below carry the tool's result instead, and the reader's
      // run with no finisher left delivers none of its output.
      const finished = await finishResumedRun(checkpoint, request.config, response);
      // If the resumed run paused again (a second gate downstream),
      // the host has already written a fresh `'awaiting_approval'` row
      // + minted its own checkpoint. Nothing more to do — the new
      // anchor and checkpoint are the resume-of-resume target.
      if (stop?.kind === 'in_doubt') {
        // D-201 Slice 10N — not the owner's cancel: a restart, mid-operation.
        // D-201 Slice 10R — the approved one's, or a later step's.
        // D-201 Slice 10BH — past a kept loop, whose items may have failed.
        // D-201 Slice 10BI (10BF findings 4 and 5) — a caller's action is a run
        // nothing holds for a try again: as its record says, never "while it
        // was running" of an approved step the run went past, nor a promise
        // that a try again asks again.
        const inDoubt = stop.step_id === undefined
          ? stop.handoff_unproven === true
            ? restartHandoffUnprovenMessage(false, stop.later_run_again === true)
            : stop.later_run_again === true ? RESTART_APPROVED_NOT_KEPT_UNHELD_MESSAGE
            // D-201 Slice 10BP (the 10BM audit's note) — it came back.
            : stop.returned_not_kept === true ? restartApprovedReturnedNotKeptMessage('unheld') : RESTART_IN_DOUBT
          // D-201 Slice 10BZ (10BX finding 5) — skipped, as its receipt reads.
          : stop.approved_skipped === true ? RESTART_LATER_STEP_AFTER_SKIP_IN_DOUBT_MESSAGE
          : stop.approved_foreach === true ? RESTART_LATER_STEP_AFTER_LOOP_IN_DOUBT_MESSAGE : RESTART_LATER_STEP_IN_DOUBT;
        await updateMcpAction(
          actionStoreFor(executeDeps),
          checkpoint.run_id,
          (actions) => actions.finish(checkpoint.run_id, {
            status: 'in_doubt',
            status_message: inDoubt,
            result: { status: 'in_doubt', message: inDoubt },
          }),
        );
      } else {
        await settleRecipeMcpAction(
          actionStoreFor(executeDeps),
          deps.auditLog,
          checkpoint,
          response,
          finished?.result,
        );
      }
      // ⛔⛔ THE RESULT HALF OF A TWO-EVENT TOOL CALL, AND THIS IS THE ONLY
      //   PLACE THAT CAN WRITE IT. The chat turn that dispatched this run ended
      //   long ago; it recorded the ASK ("I asked" at T1) and could not record
      //   the answer, because there was none yet. This is T2 — the moment the
      //   run actually settles — and everything the row needs is in hand: the
      //   pair key (`checkpoint.run_id`), the recipe that ran, the outcome, and
      //   the ORIGINATING execution source, which the resumer recovers off the
      //   paused audit anchor precisely so a resume runs under the authority
      //   that asked rather than the one that approved.
      //
      // ⚠ BEST-EFFORT, and after `settleRecipeMcpAction`. The run has already
      //   completed and its outcome is already durable; a recall row is
      //   searchability, not the record. Failing the resume over one would
      //   trade a completed run for an index entry.
      try {
        const settledSource = resumeAnchor?.execution_source;
        if (settledSource !== undefined) {
          runSettled({
            execution_source: settledSource,
            run_id: checkpoint.run_id,
            tool_name: finished?.tool_name ?? checkpoint.recipe_id ?? 'recipe.run',
            result: finished?.result ?? response,
            // A tool result carries no `success`; judged as the inline call is.
            ...(finished !== undefined
              ? { state: finished.result.ok && finished.result.run_failed === undefined ? 'succeeded' as const : 'failed' as const }
              : {}),
            ts: Date.now(),
          });
        }
      } catch {
        // See above: never fail a settled run over its recall row.
      }
    },

    async denyRun(
      checkpoint: Checkpoint,
      context: PreflightAskContext,
    ): Promise<void> {
      // D-182 §8 — a recipe-LESS raw-op door hold has no run anchor to transition
      // to `'failed'`; the op never dispatched, so the deny is a logged no-op
      // (the answer handler's trailing `delete` consumes the checkpoint).
      if (checkpoint.raw_op !== undefined) {
        await denyRawOp(checkpoint);
        // D-329 §3.4 — a refusal holds back its key's suggestion for the window.
        recordWriteRuleAnswer(deps.getExecuteDeps(), checkpoint, 'refused');
        // D-348 — a refusal spoils its request's occasion.
        await recordChainAnswer(deps.getExecuteDeps(), checkpoint, 'refused');
        const actionStore = actionStoreFor(deps.getExecuteDeps());
        await updateMcpAction(actionStore, checkpoint.run_id, (actions) =>
          actions.finish(checkpoint.run_id, {
            status: 'denied',
            status_message: 'The owner denied the pending operation.',
            result: {
              status: 'denied',
              denied: true,
              message: 'The owner denied the pending operation; no provider call was dispatched.',
            },
          }));
        await settleDeniedGatedAction(
          gatedActionStoreFor(deps.getExecuteDeps()),
          checkpoint,
          {
            status_message: 'The owner denied the pending operation.',
            result: { denied: true },
          },
        );
        try {
          runSettled({
            execution_source: checkpoint.raw_op.execution_source,
            run_id: checkpoint.run_id, tool_name: checkpoint.raw_op.op_id,
            result: { success: false, denied: true,
              message: 'The owner denied the pending operation; no provider call was dispatched.' },
            ts: Date.now(),
          });
        } catch { /* The denial is durable even if its chat projection fails. */ }
        return;
      }
      const decision = await decide(checkpoint);
      if (decision.kind === 'skip') {
        const priorDenial = decision.anchor === undefined
          ? undefined
          : recordedOwnerDenial(decision.anchor, checkpoint);
        if (priorDenial !== undefined) {
          const runtime = deps.getExecuteDeps()?.preapprovalRuntime;
          if ((checkpoint.preapproval_execution_ref || checkpoint.preapproval_candidate_ref) && !runtime) throw new Error('Pre-approval runtime is unavailable.');
          runtime?.cancelCheckpoint(checkpoint);
          // The audit transition won on a prior attempt but its receipt did
          // not. Repair it before the answer handler consumes the checkpoint.
          await settleDeniedGatedAction(
            gatedActionStoreFor(deps.getExecuteDeps()),
            checkpoint,
            {
              status_message: 'The owner denied the pending action.',
              result: { denied: true, message: priorDenial.message },
            },
          );
          await updateMcpAction(actionStoreFor(deps.getExecuteDeps()), checkpoint.run_id, (actions) =>
            actions.finish(checkpoint.run_id, {
              status: 'denied',
              status_message: 'The owner denied the pending action.',
              result: {
                status: 'denied',
                denied: true,
                message: priorDenial.message,
              },
            }));
        }
        console.warn(`[preflight-resumer] denyRun skipped: ${decision.reason}`);
        return;
      }
      const anchor = decision.anchor;
      // D-201 Slice 10R (10Q finding 16) — a restart kept this run after its
      // approved step went through (a hold that never asked has no answer for
      // the next start to replay, so it can be refused afterwards). The refusal
      // ends the rest of the run, and the record must not say nothing ran.
      const continuations = deps.getExecuteDeps()?.approvalRestartContinuations;
      const kept = continuations?.get(checkpoint.checkpoint_id) ?? null;
      // D-201 Slice 10W — an unsent row ran nothing, and a held row is the
      // owner's try again's, never an answer's.
      const wentThrough = kept !== null && kept.unsent !== true && kept.held === undefined;
      const runtime = deps.getExecuteDeps()?.preapprovalRuntime;
      if ((checkpoint.preapproval_execution_ref || checkpoint.preapproval_candidate_ref) && !runtime) throw new Error('Pre-approval runtime is unavailable.');
      runtime?.cancelCheckpoint(checkpoint);
      // D-335 slice F — a refusal holds back its key's suggestion for the window.
      recordBrowserPassAnswer(deps.getExecuteDeps(), checkpoint, 'refused');
      // D-348 — a refusal spoils its request's occasion.
      await recordChainAnswer(deps.getExecuteDeps(), checkpoint, 'refused');
      // D-202 Slice 1b — record the owner's DENY as a `quality_bad` verdict for
      // the reject-driven learner (only when this was a quality-relevant ask,
      // gated inside the helper). A reject knocks the (recipe, op)'s quality
      // confidence down; the offer re-earns only on fresh approves after it
      // (§6/§8). Deterministic `signal_id` keeps a boot-sweep retry idempotent;
      // best-effort — never throws. `at` = the resolve clock (the deny context
      // carries no answer time, unlike approve's `approved_at`). A boot-sweep
      // re-dispatch of a deny that crashed before its failed-anchor append
      // could re-stamp `at` to the (later) retry clock — but that is FAIL-SAFE:
      // a later `lastRejectAt` can only EXCLUDE approves before it (§8 — a
      // reject never earns an offer), so a drifted deny `at` can only delay a
      // suggestion, never wrongly produce one.
      if (deps.qualityDelegationSignalStore !== undefined) {
        captureQualityDelegationSignal(
          { signalStore: deps.qualityDelegationSignalStore },
          {
            checkpoint,
            anchor,
            outcome: 'reject',
            at: Date.now(),
          },
        );
      }
      // Re-derive the recipe-hash off the recipe store so the deny row
      // honestly records what the user denied (matches the audit
      // contract: `recipe_hash` is the recipe-shape under which the
      // call was attempted). Falls back to the paused anchor's hash if
      // the recipe is no longer installed — the resume couldn't have
      // succeeded either way; the deny row carries the historical
      // hash, which is the right value for a denied retroactive
      // review.
      // Recipe-bound by construction here (raw-op routed above); the anchor's
      // `recipe_id` is the required-string authority for the deny row.
      const recipe = deps.getExecuteDeps()?.recipeStore.get(anchor.recipe_id);
      const recipe_hash = recipe
        ? hashRecipe(recipe as RecipeDefinition)
        : anchor.recipe_hash;

      const denyError: RecipeError = {
        error_id: `preflight-deny-${Date.now().toString(36)}-${checkpoint.run_id}`,
        code: 'RECIPE_POLICY_DENIED',
        // D-201 Slice 10W (10V finding 15) — naming each step that had gone
        // through: 10R named the approved one alone, though a create after it
        // had been sent too.
        message: wentThrough
          ? `The owner declined the rest of this run. ${
            keptStepsWent(checkpoint.gated_step_id!, kept!, checkpoint.foreach_progress !== undefined, true)} `
            + 'before the server restarted; the steps it had not reached did not run.'
          // D-201 Slice 10AB (10AA finding 13) — asked for again after a
          // restart caught it running: declining does not undo that run.
          : checkpoint.asked_again_in_doubt === true
          ? `The owner declined '${checkpoint.gated_step_id}' when asked for it again. Its earlier run was in doubt: `
            + 'the server restarted while it ran, so Recued cannot tell whether it went through then, and declining '
            + 'does not undo it. The steps after it did not run.'
          : `User denied preflight approval for `
            + (context.tool_slug !== undefined
              ? `'${context.tool_slug}'`
              : 'a boundary-crossing call')
            + (context.risk_tier !== undefined
              ? ` (risk_tier='${context.risk_tier}')`
              : '')
            + ` at step '${checkpoint.gated_step_id}'.`,
        severity: 'fatal',
        source: {
          recipe_id: anchor.recipe_id,
          step_id: checkpoint.gated_step_id!,
          ingredient_slug: context.tool_slug ?? null,
        },
        // Who said no, readable without parsing the message: a webhook delivery
        // refused under a door since replaced runs again (`webhook-recipe-runner.ts`),
        // and must not when the owner denied it.
        details: {
          denied_by: 'owner',
          checkpoint_id: checkpoint.checkpoint_id,
          ...(checkpoint.asked_again_in_doubt === true ? { asked_again_in_doubt: true } : {}),
        },
        timestamp: new Date().toISOString(),
        retryable: false,
      };

      // The deny row keys on the same `run_id` as the paused anchor —
      // SQLite's `INSERT OR REPLACE` flips the row from
      // `'awaiting_approval'` to `'failed'` in one write. The original
      // anchor's `commit_status` is retired in place. Duration is the
      // elapsed time between the original run's start and the answer
      // arriving — `buildAuditEntry` computes `started_at = finished_at
      // - duration_ms`, so feeding that delta reproduces the original
      // `started_at` exactly. A throw propagates out — codex BLOCKER
      // 2 fold: the leaf leaves the ask `'answered'`, next boot
      // retries; the at-entry guard makes that retry idempotent (the
      // already-failed row triggers the terminal-status skip path).
      await appendFailedAnchor({
        checkpoint,
        anchor,
        recipe_hash,
        error: denyError,
      });
      // D-201 Slice 10W (10V finding 15) — the kept row goes only once the
      // refusal is written: dropped first, a throw between left the next
      // start's replay of this answer to say that nothing had run.
      if (kept !== null && kept.held === undefined) continuations!.delete(checkpoint.checkpoint_id);
      // D-201 Slice 10W (10V finding 4) — the refusal ends the run: its temp
      // files and "Yes, this time" pre-approvals go, as at any run's end. A run
      // kept for the next start, or held for an answer, kept them.
      const denyingDeps = deps.getExecuteDeps();
      if (denyingDeps !== undefined) releaseUnkeptRun(denyingDeps, checkpoint.run_id);
      const actionStore = actionStoreFor(deps.getExecuteDeps());
      await updateMcpAction(actionStore, checkpoint.run_id, (actions) =>
        actions.finish(checkpoint.run_id, {
          status: 'denied',
          status_message: 'The owner denied the pending action.',
          result: {
            status: 'denied',
            denied: true,
            message: denyError.message,
          },
        }));
      await settleDeniedGatedAction(
        gatedActionStoreFor(deps.getExecuteDeps()),
        checkpoint,
        {
          status_message: checkpoint.asked_again_in_doubt === true
            ? 'The owner denied the pending action. Its earlier run was in doubt, and the denial does not undo it.'
            : 'The owner denied the pending action.',
          result: { denied: true, message: denyError.message },
        },
      );
      // ⛔⛔ A DENIAL IS TERMINAL AND MUST CLOSE THE PAIR. Only `resumeRun` was
      //   hooked at first, so a run the owner REJECTED kept nothing but its
      //   dispatch row — and recall would report "I asked to email Pat"
      //   indefinitely, which reads as STILL PENDING. The model could tell the
      //   owner something is awaiting their approval that they declined weeks
      //   ago: a stale answer, not a missing one, which is the worse failure.
      //
      // ⚠ Same source rule as the approve path: the ORIGINATING
      //   `execution_source` off the paused anchor, never the denier's.
      try {
        const deniedSource = anchor.execution_source;
        if (deniedSource !== undefined) {
          runSettled({
            execution_source: deniedSource,
            run_id: checkpoint.run_id,
            tool_name: anchor.recipe_id,
            result: { denied: true, message: denyError.message },
            ts: Date.now(),
          });
        }
      } catch {
        // The denial is already durable; a recall row is searchability.
      }
    },
  };
  /** D-201 Slice 10W — the owner's try again of a held run (`ServerPreflightResumer`). */
  const continueHeldRun: ServerPreflightResumer['continueHeldRun'] = async (runId, door) => {
    const executeDeps = deps.getExecuteDeps();
    if (!executeDeps) {
      throw new RpcError('draining', `continueHeldRun: executeDeps not yet published — run_id=${runId}`, 503);
    }
    const continuations = executeDeps.approvalRestartContinuations;
    const row = continuations?.getHeldForRun(runId) ?? null;
    if (continuations === undefined || row === null || row.held === undefined) return { kind: 'none' };
    const held = await heldAsItsReceiptReads(continuations, gatedActionStoreFor(executeDeps), row);
    const { checkpoint } = held;
    const dropHeld = (): void => {
      continuations.delete(row.checkpoint_id);
    };
    // The recipe changed since: the kept values are another version's, and
    // cannot stand in for this one's steps. It runs from its first step, as
    // its dead letter says (D-201 Slice 10AB, 10AA finding 4: it promised the
    // step in doubt).
    if (!heldRunRecipeIsCurrent(executeDeps, held)) {
      console.warn(`[preflight-resumer] held run ${runId}: the recipe changed since; it runs from its first step`);
      dropHeld();
      return { kind: 'none' };
    }
    if (executeDeps.isDraining?.() === true) {
      throw new RpcError('draining', 'continueHeldRun: the server is stopping; the next start continues it', 503);
    }
    const release = executeDeps.inFlightRegistry?.holdUntilSettled();
    try {
      // The run goes on under its own identity, from its paused record, under
      // the delivery's door as it stands now.
      const paused: AuditEntry = {
        ...held.anchor,
        execution_source: door.execution_source,
        ...(door.contract_snapshot !== undefined ? { contract_snapshot: door.contract_snapshot } : {}),
      };
      if (door.contract_snapshot === undefined) delete (paused as { contract_snapshot?: unknown }).contract_snapshot;
      await deps.auditLog.append(paused);
      // The approved step: replayed when it came back. When not, it asks afresh
      // under a receipt of its own (10N), the steps before it standing in: its
      // approved target is withheld (`requireFreshApproval`), and every gate
      // admits a resumed step only on that target, never on its position.
      const { request, internal } = buildResumeInputs(checkpoint, paused, undefined, undefined, !held.approved_returned);
      if (held.approved_returned && internal.resume_from !== undefined) {
        internal.resume_from = {
          ...internal.resume_from,
          // D-201 Slice 10BU (10BS finding 2) — skipped, as the next start's
          // road sends it: a loop was replayed as one that ran.
          replayed_result: { value: row.value, ...(held.approved_skipped === true ? { skipped: true as const } : {}) },
          replayed_steps: row.later ?? [],
          ...(row.pii_ledgers !== undefined ? { pii_ledgers: row.pii_ledgers } : {}),
        };
      }
      // D-201 Slice 10AB (10AA finding 13) — its ask for that step again says
      // the earlier run was in doubt, so a refusal does too.
      if (!held.approved_returned) internal.asked_again_in_doubt = true;
      const restart: { stop?: ApprovedRunRestartStop; failure?: ApprovedRunFailure; keepError?: unknown } = {};
      /** Held again, with what this run did too; the row first, as any kept
       *  run's, before the run's record. */
      const holdAgain = (next: {
        readonly value: unknown;
        readonly later: ApprovedRunFailure['later'];
        readonly pii_ledgers?: ApprovedRunFailure['pii_ledgers'];
        readonly approved_returned: boolean;
        readonly step_in_doubt: string;
        readonly failed?: true;
        /** D-201 Slice 10AK (10AI finding 13) — held as it stood after a death. */
        readonly progress_unknown?: true;
        /** D-201 Slice 10BC (10AY findings 2 and 9) — carried as that is. */
        readonly later_run_again?: true;
        /** D-201 Slice 10BH — a kept loop. */
        readonly approved_foreach?: true;
        /** D-201 Slice 10BI (10BF finding 5) — carried as that is. */
        readonly handoff_unproven?: true;
      }): void => {
        try {
          continuations.put({
            checkpoint_id: row.checkpoint_id,
            run_id: row.run_id,
            gated_step_id: row.gated_step_id,
            value: next.value,
            later: next.later,
            ...(next.pii_ledgers !== undefined ? { pii_ledgers: next.pii_ledgers } : {}),
            held: {
              checkpoint,
              anchor: held.anchor,
              approved_returned: next.approved_returned,
              step_in_doubt: next.step_in_doubt,
              ...(next.failed === true ? { failed: true as const } : {}),
              ...(next.progress_unknown === true ? { progress_unknown: true as const } : {}),
              ...(next.later_run_again === true ? { later_run_again: true as const } : {}),
              // D-201 Slice 10BH — past the loop it replayed, kept: every hold
              // past it says so. Dropped, a receipt its items settled
              // `partial` read as not gone through, and the loop was asked
              // for again.
              ...(next.approved_foreach === true || (next.approved_returned && held.approved_foreach === true)
                ? { approved_foreach: true as const }
                : {}),
              // D-201 Slice 10BJ (10BF finding 9) — past the skipped step it replayed.
              ...(next.approved_returned && held.approved_skipped === true ? { approved_skipped: true as const } : {}),
              ...(!next.approved_returned && next.handoff_unproven === true ? { handoff_unproven: true as const } : {}),
            },
          });
        } catch (error) {
          restart.keepError = error;
        }
      };
      // D-201 Slice 10AB (10AA finding 5) — whether or not the approved step
      // came back: a try again that asks for it again, stopped before it
      // asked, is the next start's to finish (10N read that as `interrupted`;
      // with no report the kill read as failed, and the delivery was cancelled).
      // The run is held either way, so it keeps its temp files and "Yes, this
      // time" pre-approvals (10AA finding 12).
      internal.onStoppedByRestart = (outcome) => {
        restart.stop = outcome;
        // D-201 Slice 10AP (10AM finding 4) — stopped again: what a death left
        // unknown still is. D-201 Slice 10BC (10AY findings 2 and 9) — and what
        // could not be kept still runs again.
        const unknown = {
          ...(held.progress_unknown === true ? { progress_unknown: true as const } : {}),
          ...(held.later_run_again === true
            || (outcome.kind === 'in_doubt' && outcome.later_run_again === true)
            ? { later_run_again: true as const }
            : {}),
        };
        if (outcome.kind === 'returned' || (outcome.kind === 'in_doubt' && outcome.step_id !== undefined)) {
          holdAgain({
            value: outcome.value,
            later: outcome.later ?? [],
            ...(outcome.pii_ledgers !== undefined ? { pii_ledgers: outcome.pii_ledgers } : {}),
            approved_returned: true,
            step_in_doubt: outcome.kind === 'in_doubt' ? outcome.step_id! : held.step_in_doubt,
            ...unknown,
            ...(outcome.kind === 'in_doubt' && outcome.approved_foreach === true ? { approved_foreach: true as const } : {}),
          });
        } else if (outcome.kind === 'in_doubt') {
          // The approved step itself, caught running: asked for again.
          holdAgain({
            value: undefined, later: [], approved_returned: false, step_in_doubt: checkpoint.gated_step_id!, ...unknown,
          });
        }
        // `unsent`: nothing ran, and the row stands as it was.
        return true;
      };
      // D-201 Slice 10AV (10AS findings 7 and 9) — the row first, before each
      // step from the approved one on, as on the answer's road: a death during
      // the try again leaves where it was (`settleDiedTryAgain` keeps it), and
      // a run that throws, or a stop whose own row fails, is held from there.
      // Its own put: a failure here is no failed keep of a stop.
      let ahead: string | undefined;
      internal.onStepUnderWay = (outcome) => {
        const unknown = {
          ...(held.progress_unknown === true ? { progress_unknown: true as const } : {}),
          // D-201 Slice 10BC (10AY findings 2 and 9).
          ...(held.later_run_again === true || outcome.later_run_again === true
            ? { later_run_again: true as const }
            : {}),
        };
        const returned = outcome.step_id !== undefined;
        try {
          continuations.put({
            checkpoint_id: row.checkpoint_id,
            run_id: row.run_id,
            gated_step_id: row.gated_step_id,
            value: returned ? outcome.value : undefined,
            later: returned ? outcome.later ?? [] : [],
            ...(returned && outcome.pii_ledgers !== undefined ? { pii_ledgers: outcome.pii_ledgers } : {}),
            held: {
              checkpoint,
              anchor: held.anchor,
              approved_returned: returned,
              step_in_doubt: outcome.step_id ?? checkpoint.gated_step_id!,
              ...unknown,
              ...(returned && outcome.approved_foreach === true ? { approved_foreach: true as const } : {}),
              // D-201 Slice 10BJ (10BF finding 9) — the step it replayed, as the
              // row it replayed says: a replay reads as not skipped.
              ...(returned && (outcome.approved_skipped === true || held.approved_skipped === true)
                ? { approved_skipped: true as const }
                : {}),
            },
          });
          ahead = outcome.step_id ?? checkpoint.gated_step_id!;
        } catch (error) {
          console.warn(
            `[preflight-resumer] held run ${runId}: where it is could not be kept: `
              + (error instanceof Error ? error.message : String(error)),
          );
          // D-201 Slice 10BC (10AY finding 9) — the row that stands lags.
          // D-201 Slice 10BP (10BM finding 5) — past an approved step Recued
          // cannot keep, as on the answer's road: a try again the owner's
          // settings let run that step unasked went past it.
          markStandingRowLags(continuations, row.checkpoint_id, runId, outcome.step_id ?? checkpoint.gated_step_id!,
            outcome.later_run_again === true);
        }
      };
      // D-201 Slice 10AB (10AA finding 2) — failed at a later step, not
      // stopped: held again from that step, what went through standing in. It
      // was dropped, and the delivery's retry ran the recipe from its first
      // step, the approved step again.
      internal.onFailedAfterApproval = (failure) => {
        restart.failure = failure;
        // D-201 Slice 10AG (10AE finding 10) — its ask for the approved step
        // again could not be written: held as it stood, marked failed, and its
        // temp files and pre-approvals kept for the next try (they went).
        if (failure.unasked === true) {
          // D-201 Slice 10BP (10BM finding 5) — with the mark this try again's
          // own rows wrote, as the answer's road holds it (`holdAsItStood`): one
          // the owner's settings let run the approved step without asking ran it
          // and went past it before it failed. Held as it stood before, the mark
          // went, and Settings said only that step could run twice.
          let lags = held.later_run_again === true;
          try {
            lags ||= continuations.get(row.checkpoint_id)?.held?.later_run_again === true;
          } catch {
            // Held as it stood before.
          }
          holdAgain({
            value: row.value,
            later: row.later ?? [],
            ...(row.pii_ledgers !== undefined ? { pii_ledgers: row.pii_ledgers } : {}),
            approved_returned: held.approved_returned,
            step_in_doubt: held.step_in_doubt,
            failed: true,
            // D-201 Slice 10AK (10AI finding 13) — as it stood: a death's unknown
            // progress too. Dropped, Settings said only that step could run twice.
            ...(held.progress_unknown === true ? { progress_unknown: true as const } : {}),
            ...(lags ? { later_run_again: true as const } : {}),
            ...(held.handoff_unproven === true ? { handoff_unproven: true as const } : {}),
          });
          return true;
        }
        holdAgain({
          value: failure.value,
          later: failure.later,
          ...(failure.pii_ledgers !== undefined ? { pii_ledgers: failure.pii_ledgers } : {}),
          approved_returned: true,
          step_in_doubt: failure.step_id ?? held.step_in_doubt,
          failed: true,
          // D-201 Slice 10AP (10AM finding 4) — failed at or after the step in
          // doubt: what a death left unknown still is. It was dropped, and
          // Settings said only that step could run twice.
          ...(held.progress_unknown === true ? { progress_unknown: true as const } : {}),
          ...(held.later_run_again === true ? { later_run_again: true as const } : {}),
        });
        return true;
      };
      let response: ExecuteResponse;
      try {
        response = await handleExecute(executeDeps, request, internal);
      } catch (error) {
        // Refused before it started (the server stopping, or paused): it stays
        // held for the next try.
        if (isRunRefusedForNow(error)) throw error;
        // What ran after the replayed steps is unknown: in doubt, and no longer
        // held, as a continuation that throws is (10R). D-201 Slice 10AV — the
        // handler throws only before its first step (the registry, a changed
        // connection); after it, it records its own faults, so no row was
        // written ahead here.
        dropHeld();
        releaseUnkeptRun(executeDeps, runId);
        await deps.auditLog.append(inDoubtRecord(paused, runId, error));
        return { kind: 'in_doubt', step_id: held.step_in_doubt };
      }
      if (restart.keepError !== undefined) {
        // D-201 Slice 10AV (10AS finding 7) — the stop's own row failed, the
        // one it wrote ahead stands: held from there.
        if (ahead !== undefined) {
          let lags = false;
          try {
            lags = continuations.get(row.checkpoint_id)?.held?.later_run_again === true;
          } catch {
            // Worded as the row it wrote.
          }
          await deps.auditLog.append(
            inDoubtRecord(paused, runId, restart.keepError, 'held_run_kept_ahead', ahead, lags),
          );
          return { kind: 'in_doubt', step_id: ahead };
        }
        // Not kept: what this run did is unknown to the held row. In doubt,
        // and its next try runs as before 10W.
        dropHeld();
        releaseUnkeptRun(executeDeps, runId);
        await deps.auditLog.append(inDoubtRecord(paused, runId, restart.keepError));
        return { kind: 'in_doubt', step_id: held.step_in_doubt };
      }
      const stop = restart.stop;
      if (stop?.kind === 'in_doubt') {
        return { kind: 'in_doubt', step_id: stop.step_id ?? checkpoint.gated_step_id! };
      }
      if (stop !== undefined) return { kind: 'interrupted' };
      if (response.success) {
        dropHeld();
        return { kind: 'completed' };
      }
      // A new hold, for the owner's answer: still the owner's held run, its
      // held row moved to that ask (D-201 Slice 10AG, 10AE finding 2).
      if (response.awaiting_approval) {
        let moved = false;
        let unwritten = false;
        try {
          moved = await moveHeldToAsk(deps.auditLog, executeDeps, row.checkpoint_id, runId);
        } catch {
          // D-201 Slice 10AK (10AI finding 15) — the move could not be written:
          // the row stays where it was, and the answer to the ask moves it there
          // first (`moveHeldRowHere`). Dropped, a later failure was cancelled.
          unwritten = true;
        }
        if (!moved && !unwritten) dropHeld();
        return { kind: 'awaiting_approval' };
      }
      // The owner's Stop ended it: as any run they stop.
      if (response.run_terminated !== undefined) {
        dropHeld();
        return { kind: 'failed' };
      }
      // D-201 Slice 10AK (10AI finding 14) — a failure whose own record could
      // not be written (an ask's awaiting record): the paused record put back
      // above stands, and the next try again read it as one the process went
      // during (`settleDiedTryAgain`, a false `held_run_died`). Written here.
      const heldFrom = restart.failure?.step_id ?? held.step_in_doubt;
      // D-201 Slice 10BH (10BF finding 1) — as the row now held says it.
      const asksAgainPast = heldAsksAgainPast(continuations, row.checkpoint_id);
      try {
        const now = await deps.auditLog.get(runId);
        if (now !== null && now.commit_status === paused.commit_status
          && now.started_at === paused.started_at && now.finished_at === paused.finished_at
          && now.checkpoint_id === paused.checkpoint_id) {
          await deps.auditLog.append(
            failedHeldRecord(paused, runId, heldFrom, response.errors as AuditEntry['errors'], asksAgainPast),
          );
        } else if (now !== null && now.commit_status === 'failed') {
          // D-201 Slice 10AP (10AM finding 19) — its own record, worded as the
          // held run it is: an ask it could not write said to run it from scratch.
          const worded = heldWording(now.errors, heldFrom, asksAgainPast);
          if (worded !== undefined) await deps.auditLog.append({ ...now, errors: worded });
        }
      } catch {
        // The paused record stands, as before 10AK.
      }
      return { kind: 'held_failed', step_id: restart.failure?.step_id ?? held.step_in_doubt };
    } finally {
      release?.();
    }
  };

  const settleDiedTryAgain: ServerPreflightResumer['settleDiedTryAgain'] = async (runId, record) => {
    const executeDeps = deps.getExecuteDeps();
    if (!executeDeps) {
      throw new RpcError('draining', `settleDiedTryAgain: executeDeps not yet published — run_id=${runId}`, 503);
    }
    const continuations = executeDeps.approvalRestartContinuations;
    const row = continuations?.getHeldForRun(runId) ?? null;
    if (continuations === undefined || row === null || row.held === undefined) return false;
    const held = row.held;
    if (record.commit_status !== 'awaiting_approval'
      || record.checkpoint_id === undefined
      || record.checkpoint_id !== held.checkpoint.checkpoint_id) {
      return false;
    }
    // An ask still standing under that checkpoint is a hold, not a try again.
    if (executeDeps.checkpointStore !== undefined
      && await executeDeps.checkpointStore.get(held.checkpoint.checkpoint_id) !== null) {
      return false;
    }
    // How far the try again got is unknown: the step in doubt, and the steps
    // after it, may have run. Held still, so the owner's next try again goes
    // on from it, what went through before the try again standing in.
    try {
      continuations.put({
        checkpoint_id: row.checkpoint_id,
        run_id: row.run_id,
        gated_step_id: row.gated_step_id,
        value: row.value,
        later: row.later ?? [],
        ...(row.pii_ledgers !== undefined ? { pii_ledgers: row.pii_ledgers } : {}),
        held: {
          checkpoint: held.checkpoint,
          anchor: held.anchor,
          approved_returned: held.approved_returned,
          step_in_doubt: held.step_in_doubt,
          progress_unknown: true,
          ...(held.later_run_again === true ? { later_run_again: true as const } : {}),
          // D-201 Slice 10BH — still past a kept loop.
          ...(held.approved_returned && held.approved_foreach === true ? { approved_foreach: true as const } : {}),
          // D-201 Slice 10BJ (10BF finding 9) — and past a skipped step.
          ...(held.approved_returned && held.approved_skipped === true ? { approved_skipped: true as const } : {}),
          // D-201 Slice 10BV (the 10BS audit's note) — and still written ahead
          // of its receipt: rewritten without it, the next try replayed a
          // hand-off it cannot check as gone through.
          ...(held.approved_returned && held.receipt_unsettled === true ? { receipt_unsettled: true as const } : {}),
        },
      });
    } catch {
      // Not kept: its next try runs as before 10W.
      continuations.delete(row.checkpoint_id);
      releaseUnkeptRun(executeDeps, runId);
    }
    await deps.auditLog.append(inDoubtRecord(record, runId,
      'the server stopped during the owner\'s try again', 'held_run_died'));
    return true;
  };

  return {
    ...resumer,
    continueHeldRun,
    settleDiedTryAgain,
    async resumeRun(checkpoint, context) {
      // D-201 Slice 10R (10Q finding 3) — what a resume writes after its run
      // ends (the receipt, the paused record put back, what a restart keeps,
      // the caller's action) must land before the drain flushes the audit log
      // and closes the database. The run itself leaves the in-flight registry
      // the moment the drain abandons it, so the resume holds the registry's
      // count (`holdWhileResuming`) until it is done: the drain's
      // `await_inflight` waits for it.
      const scope: { release?: () => void } = {};
      resumeHolds.set(checkpoint, scope);
      resuming.set(checkpoint.run_id, (resuming.get(checkpoint.run_id) ?? 0) + 1);
      try {
        await resumer.resumeRun(checkpoint, context);
      } finally {
        resumeHolds.delete(checkpoint);
        const left = (resuming.get(checkpoint.run_id) ?? 1) - 1;
        if (left > 0) resuming.set(checkpoint.run_id, left);
        else resuming.delete(checkpoint.run_id);
        scope.release?.();
      }
    },
    isResumingRun: (runId) => resuming.has(runId),
  };
};
