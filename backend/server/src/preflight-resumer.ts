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
import {
  canonicalRecipeDefinition,
  COMPENSATION_RECIPE_ID_PREFIX,
  hashRecipe,
} from '@recued/recipes';
import type { Checkpoint, RecipeDefinition, RecipeError } from '@recued/contracts';
import {
  executionSourceHasContract,
  isGatedActionTerminal,
  isEphemeralDishId,
} from '@recued/contracts';
import type { PreflightAskContext, PreflightResumer } from '@recued/gateway';
import {
  buildAuditEntry,
  type AuditEntry,
  type AuditLogStore,
} from '@recued/storage';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { handleExecute } from './execute-handler.js';
import { observeResumedChatToolCall } from './chat-tool-call-context.js';
import { captureQualityDelegationSignal } from './quality-delegation-signal-capture.js';
import {
  denyRawOp,
  resumeRawOp,
  type RawOpResumeOutcome,
} from './raw-op-dispatch.js';
import { projectRunResultForAgent } from './run-result-agent-projection.js';
import type { McpActionStore } from './mcp-action-store.js';
import {
  gatedActionHandoffFromResult,
  type GatedActionRecord,
  type GatedActionStore,
} from './gated-action-store.js';
import { requiredResumeBearerToolNames } from './recipe-resume-authority.js';
import type { QualityDelegationSignalStore } from './storage/quality-delegation-signal-store.js';
import type { ExecuteRequest, ExecuteResponse } from './types.js';

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
  | { kind: 'superseded'; action: GatedActionRecord };

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
): Promise<GatedActionRecord> => {
  if (isGatedActionTerminal(action.status)) return action;
  const input = {
    status: 'in_doubt' as const,
    status_message:
      'Recued could not prove the final outcome of this approved operation. Inspect Logs before retrying.',
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
): Promise<void> => {
  await updateMcpAction(store, checkpoint.run_id, async (actions) => {
    if (response.awaiting_approval === true) {
      const anchor = await auditLog.get(checkpoint.run_id);
      await actions.markAwaiting(
        checkpoint.run_id,
        anchor?.commit_status === 'awaiting_approval'
          ? anchor.checkpoint_id
          : undefined,
        'The resumed action reached another owner-approval gate.',
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
export const createPreflightResumer = (
  deps: CreatePreflightResumerDeps,
): PreflightResumer => {
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
        resume_from: {
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
        },
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
    });
    await deps.auditLog.append(entry);
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
        message:
          'The approved operation may have run, but Recued could not prove the complete resumed run outcome.',
        severity: 'fatal',
        source: {
          recipe_id: current.recipe_id,
          step_id: checkpoint.gated_step_id ?? null,
          ingredient_slug: checkpoint.preflight_context?.tool_slug ?? null,
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

  const reconcileClaimedRecipeResume = async (
    store: GatedActionStore,
    action: GatedActionRecord,
    checkpoint: Checkpoint,
    cause: unknown,
  ): Promise<void> => {
    const current = await store.get(action.action_ref);
    if (current === null) {
      throw new Error(
        `[preflight-resumer] claimed gated action disappeared for run_id=${checkpoint.run_id}`,
      );
    }
    if (current.status === 'dispatching'
      && await deps.preserveClaimedDispatch?.(current)) return;
    await settleInterruptedGatedAction(store, current, checkpoint, cause);
    await appendInDoubtAnchorUnlessSuperseded(checkpoint, cause);
  };

  return {
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
        try {
          const outcome = await resumeRawOp(executeDeps, checkpoint, {
            ...(context.session_grant !== undefined
              ? { session_grant: context.session_grant }
              : {}),
          });
          // The concurrent winner still owns the result. A skipped duplicate
          // must not close its saved call while the provider is still running.
          if (outcome.kind === 'skipped' && outcome.reason === 'resume_already_in_flight') return;
          await settleRawMcpAction(actionStoreFor(executeDeps), checkpoint, outcome);
          await settleRawGatedAction(
            gatedActionStoreFor(executeDeps),
            rawGatedAction.kind === 'dispatch' ? rawGatedAction.action : undefined,
            checkpoint,
            outcome,
          );
          try {
            deps.onRunSettled?.({
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
      const { request, internal } = buildResumeInputs(
        checkpoint,
        resumeAnchor,
        context.session_grant,
        context.batch_claim,
        requireFreshApproval,
      );
      if ((checkpoint.preapproval_execution_ref || checkpoint.preapproval_candidate_ref) && !executeDeps.preapprovalRuntime) {
        throw new Error('The reviewed execution runtime must be ready before resuming this checkpoint.');
      }
      const reviewed = await executeDeps.preapprovalRuntime?.resume(checkpoint);
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
      const dispatchClaim = await claimRecipeDispatch(gatedStore, checkpoint);
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
        await appendInDoubtAnchorUnlessSuperseded(
          checkpoint,
          `receipt already terminal with status '${dispatchClaim.action.status}'`,
        );
        return;
      }
      if (dispatchClaim.kind === 'claimed') {
        internal.gated_action_ref = dispatchClaim.action.action_ref;
      }
      // Dispatch through the normal handler with the internal
      // overrides. Once a receipt-backed dispatch claim wins, a throw no longer
      // retries the effect: receipt + run audit converge conservatively to
      // in_doubt before the answered checkpoint retires. Legacy checkpoints
      // without a receipt retain the old retry behavior.
      let response: ExecuteResponse;
      try {
        response = await handleExecute(executeDeps, request, internal);
      } catch (error) {
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
        await reconcileClaimedRecipeResume(
          gatedStore!,
          dispatchClaim.action,
          checkpoint,
          error,
        );
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
      // If the resumed run paused again (a second gate downstream),
      // the host has already written a fresh `'awaiting_approval'` row
      // + minted its own checkpoint. Nothing more to do — the new
      // anchor and checkpoint are the resume-of-resume target.
      await settleRecipeMcpAction(
        actionStoreFor(executeDeps),
        deps.auditLog,
        checkpoint,
        response,
      );
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
          deps.onRunSettled?.({
            execution_source: settledSource,
            run_id: checkpoint.run_id,
            tool_name: checkpoint.recipe_id ?? 'recipe.run',
            result: response,
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
          deps.onRunSettled?.({
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
      const runtime = deps.getExecuteDeps()?.preapprovalRuntime;
      if ((checkpoint.preapproval_execution_ref || checkpoint.preapproval_candidate_ref) && !runtime) throw new Error('Pre-approval runtime is unavailable.');
      runtime?.cancelCheckpoint(checkpoint);
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
        message:
          `User denied preflight approval for `
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
        details: {},
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
          status_message: 'The owner denied the pending action.',
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
          deps.onRunSettled?.({
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
};
