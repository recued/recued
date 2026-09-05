/** D-234 § 234.4 — RESUMING A PEER HOLD.
 *
 *  🔑🔑 THERE IS NO ANSWER-INJECTION PATH HERE, AND THAT IS THE DESIGN, NOT A
 *  SHORTCUT. The answer is already recorded by the time this runs; re-instantiating
 *  the run makes the gated step RE-RUN, and `dispatchPeerAsk` finds the recorded
 *  answer and returns it instead of throwing. Idempotent-with-memory, exactly as
 *  § 234.1's admission ceiling re-runs and finds the recorded decision. So this
 *  file carries no answer, no option, no note — only "run that again".
 *
 *  ⛔ A SEPARATE ENTRY POINT FROM `PreflightResumer.resumeRun`, and deliberately
 *  so. That one's idempotency guard reads the anchor's `commit_status` expecting
 *  `awaiting_approval` and SKIPS anything else — a peer hold reaching it would be
 *  silently discarded as "an unexpected state". The two holds share the
 *  checkpoint substrate and nothing else: an approval resume is answered by the
 *  owner on this machine, a peer resume by a decision recorded from the wire.
 *
 *  ⚠ Deliberately NOT folded into that resumer by widening its guard. The guard
 *  is what makes a stale/duplicate answer a no-op, and the two holds have
 *  different staleness rules — an approval checkpoint is consumed by its answer,
 *  a peer hold is closed by its outbox row. Widening would have made one
 *  predicate serve two invariants, which is how the D-157 statuses got confused
 *  in the first place.
 */
import { buildAuditEntry } from '@recued/storage';
import type { AuditEntry, AuditLogStore } from '@recued/storage';
import {
  executionSourceHasContract,
  isEphemeralDishId,
  type Checkpoint,
  type RecipeDefinition,
  type RecipeError,
} from '@recued/contracts';
import { canonicalRecipeDefinition, hashRecipe } from '@recued/recipes';

import type { ExecuteHandlerDeps } from './execute-handler.js';
import { handleExecute } from './execute-handler.js';
import { requiredResumeBearerToolNames } from './recipe-resume-authority.js';
import type { ExecuteRequest } from './types.js';
import type { PeerAskOutboxStore } from './storage/peer-ask-outbox-store.js';

export interface PeerHoldResumeDeps {
  readonly getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  readonly auditLog: Pick<AuditLogStore, 'get' | 'append'>;
  readonly checkpoints: { listByRun(run_id: string): Promise<Checkpoint[]> };
  readonly outbox?: Pick<
    PeerAskOutboxStore,
    'getDelivery' | 'claimContinuation'
  >;
}

export type PeerHoldResumeOutcome =
  | { readonly kind: 'resumed' }
  | { readonly kind: 'skipped'; readonly reason: string };

const isOriginalPeerAnchor = (
  anchor: AuditEntry | null,
  checkpoint: Checkpoint,
): anchor is AuditEntry => anchor?.commit_status === 'awaiting_peer'
  && anchor.checkpoint_id === checkpoint.checkpoint_id;

const isContinuationClaimMarker = (
  anchor: AuditEntry | null,
  exchangeRef: string,
): anchor is AuditEntry => anchor?.commit_status === 'in_doubt'
  && (anchor.errors ?? []).some((error) => {
    const details = error.details;
    return details !== null && typeof details === 'object' && !Array.isArray(details)
      && (details as Record<string, unknown>).exchange_ref === exchangeRef
      && (details as Record<string, unknown>).claim_marker === true;
  });

const settleClaimedContinuationInDoubt = async (
  original: AuditEntry,
  checkpoint: Checkpoint,
  exchangeRef: string,
  cause: unknown,
  deps: PeerHoldResumeDeps,
): Promise<AuditEntry> => {
  const current = await deps.auditLog.get(checkpoint.run_id);
  if (current !== null && !isOriginalPeerAnchor(current, checkpoint)) return current;
  const at = Date.now();
  const error: RecipeError = {
    error_id: `peer-answer-continuation-${at.toString(36)}-${checkpoint.run_id}`,
    code: 'INGREDIENT_ADAPTER_ALL_FAILED',
    message:
      'The peer answer continuation was interrupted after its durable dispatch claim. '
      + 'Recued will not replay post-answer effects automatically.',
    severity: 'fatal',
    source: {
      recipe_id: original.recipe_id,
      step_id: checkpoint.gated_step_id ?? null,
      ingredient_slug: 'peer-ask',
    },
    details: {
      exchange_ref: exchangeRef,
      reason: 'peer_answer_continuation_interrupted',
      claim_marker: true,
      cause: cause instanceof Error ? cause.message : String(cause),
    },
    timestamp: new Date(at).toISOString(),
    retryable: false,
  };
  const terminal = buildAuditEntry({
    ...original,
    commit_status: 'in_doubt',
    duration_ms: Math.max(0, at - original.started_at),
    errors: [error],
    context_snapshot: undefined,
    checkpoint_id: undefined,
    ask_id: undefined,
    now: at,
  });
  try {
    await deps.auditLog.append(terminal);
  } catch (appendError) {
    const observed = await deps.auditLog.get(checkpoint.run_id);
    if (observed === null || isOriginalPeerAnchor(observed, checkpoint)) {
      throw appendError;
    }
  }
  const observed = await deps.auditLog.get(checkpoint.run_id);
  if (observed === null || isOriginalPeerAnchor(observed, checkpoint)) {
    throw new Error('peer answer continuation audit outcome could not be verified');
  }
  return observed;
};

const appendPeerContinuationFailure = async (
  original: AuditEntry,
  checkpoint: Checkpoint,
  error: RecipeError,
  deps: PeerHoldResumeDeps,
): Promise<void> => {
  const at = Date.now();
  const terminal = buildAuditEntry({
    ...original,
    commit_status: 'failed',
    duration_ms: Math.max(0, at - original.started_at),
    errors: [error],
    context_snapshot: undefined,
    checkpoint_id: undefined,
    ask_id: undefined,
    now: at,
  });
  try {
    await deps.auditLog.append(terminal);
  } catch (appendError) {
    const observed = await deps.auditLog.get(checkpoint.run_id);
    if (observed === null || isOriginalPeerAnchor(observed, checkpoint)) {
      throw appendError;
    }
  }
  const observed = await deps.auditLog.get(checkpoint.run_id);
  if (observed === null || isOriginalPeerAnchor(observed, checkpoint)) {
    throw new Error('peer answer continuation failure outcome could not be verified');
  }
};

/** Re-instantiate a run held on a peer answer, past its gate. */
export const resumePeerHold = async (
  target: { run_id: string; gated_step_id: string; exchange_ref?: string },
  deps: PeerHoldResumeDeps,
): Promise<PeerHoldResumeOutcome> => {
  const executeDeps = deps.getExecuteDeps();
  if (executeDeps === undefined) {
    // Transient (bootstrap). THROW rather than skip: the answer is durable, and
    // the caller's retry — or the next boot — should try again.
    throw new Error(
      `[peer-hold-resumer] executeDeps not yet published — run_id=${target.run_id}`,
    );
  }
  const journal = deps.outbox !== undefined && target.exchange_ref !== undefined
    ? deps.outbox.getDelivery(target.exchange_ref)
    : null;
  // A checkpoint-bearing row is a new durable journal even when corruption
  // made its plan unreadable. Legacy rows predate checkpoint_id entirely.
  const durableJournal = journal !== null
    && (journal.delivery !== undefined || journal.checkpoint_id !== undefined);
  if (durableJournal
    && (journal.run_id !== target.run_id
      || journal.gated_step_id !== target.gated_step_id)) {
    throw new Error('peer answer continuation disagrees with its durable delivery journal');
  }
  const anchor = await deps.auditLog.get(target.run_id);
  if (anchor === null) {
    if (durableJournal) {
      throw new Error('peer answer continuation has no verifiable run anchor');
    }
    return { kind: 'skipped', reason: `anchor run_id=${target.run_id} not found` };
  }
  // ⛔ A PEER HOLD, EXACTLY. `awaiting_approval` is held too, but it belongs to
  // a DIFFERENT continuation. In particular, a successful peer resume may reach
  // a later local approval gate before an at-least-once peer-answer retry arrives;
  // admitting that state here would re-run the already-answered peer operation.
  if (anchor.commit_status !== 'awaiting_peer') {
    if (durableJournal) {
      // Any terminal or later held anchor under the same run id supersedes the
      // exact peer hold. Reporting resumed lets the caller reclaim its outbox
      // row without executing post-answer effects again.
      return { kind: 'resumed' };
    }
    return {
      kind: 'skipped',
      reason: `anchor run_id=${target.run_id} is '${anchor.commit_status}', not awaiting_peer`,
    };
  }
  if (anchor.checkpoint_id === undefined) {
    if (durableJournal) {
      throw new Error(
        `awaiting_peer anchor run_id=${target.run_id} has no checkpoint_id`,
      );
    }
    return {
      kind: 'skipped',
      reason: `awaiting_peer anchor run_id=${target.run_id} has no checkpoint_id`,
    };
  }
  const checkpoints = await deps.checkpoints.listByRun(target.run_id);
  // ⛔ THE ANCHOR POINTER IS THE CHECKPOINT AUTHORITY. `listByRun()[0]` is
  // merely newest-by-clock and can be a later approval pause or same-timestamp
  // residue. Resuming it with the peer target would combine one checkpoint's
  // state with another step's authority. Bind both durable identities.
  const checkpoint = checkpoints.find(
    (candidate) => candidate.checkpoint_id === anchor.checkpoint_id,
  );
  if (checkpoint === undefined) {
    if (durableJournal) {
      throw new Error(
        `checkpoint_id=${anchor.checkpoint_id} not found for run_id=${target.run_id}`,
      );
    }
    return {
      kind: 'skipped',
      reason: `checkpoint_id=${anchor.checkpoint_id} not found for run_id=${target.run_id}`,
    };
  }
  if (checkpoint.gated_step_id !== target.gated_step_id) {
    if (durableJournal) {
      throw new Error(
        `checkpoint_id=${checkpoint.checkpoint_id} belongs to gated_step_id=`
          + `'${checkpoint.gated_step_id ?? ''}', not '${target.gated_step_id}'`,
      );
    }
    return {
      kind: 'skipped',
      reason: `checkpoint_id=${checkpoint.checkpoint_id} belongs to gated_step_id=`
        + `'${checkpoint.gated_step_id ?? ''}', not '${target.gated_step_id}'`,
    };
  }

  let continuationClaimed = false;
  let continuationClaimMarker: AuditEntry | undefined;
  if (deps.outbox !== undefined && target.exchange_ref !== undefined) {
    // Rows created before delivery journalling retain the legacy retry path.
    // Every new row must bind the exact exchange/run/step/checkpoint before its
    // answer continuation can claim execution. The checkpoint marker, not a
    // still-readable delivery payload, distinguishes that durable generation:
    // corruption must fail closed rather than silently drop the no-replay
    // fence for an already-delivered question.
    if (durableJournal) {
      if (journal === null) {
        throw new Error('peer answer continuation lost its durable delivery journal');
      }
      if (journal.run_id !== target.run_id
        || journal.gated_step_id !== target.gated_step_id
        || journal.checkpoint_id !== checkpoint.checkpoint_id) {
        throw new Error('peer answer continuation disagrees with its durable delivery journal');
      }
      const claim = deps.outbox.claimContinuation(
        target.exchange_ref,
        checkpoint.checkpoint_id,
      );
      if (claim === 'not_open') {
        throw new Error('peer answer continuation could not claim its durable journal');
      }
      if (claim === 'already_claimed') {
        const observed = await deps.auditLog.get(target.run_id);
        if (isOriginalPeerAnchor(observed, checkpoint)) {
          await settleClaimedContinuationInDoubt(
            anchor,
            checkpoint,
            target.exchange_ref,
            'a prior process stopped after claiming continuation dispatch',
            deps,
          );
          return {
            kind: 'skipped',
            reason: 'claimed peer answer continuation was reconciled in_doubt without replay',
          };
        }
        if (observed === null) {
          throw new Error('claimed peer answer continuation has no verifiable run anchor');
        }
        // A terminal or later awaiting anchor proves the prior continuation got
        // far enough to supersede this peer hold. The caller may now close the
        // outbox row without executing any effect again.
        return { kind: 'resumed' };
      }
      continuationClaimed = true;
      const marker = await settleClaimedContinuationInDoubt(
        anchor,
        checkpoint,
        target.exchange_ref,
        'continuation dispatch claimed before post-answer effects',
        deps,
      );
      if (!isContinuationClaimMarker(marker, target.exchange_ref)) {
        // A concurrent process already superseded the peer hold after our
        // claim. That durable anchor owns the outcome; never execute beside it.
        return { kind: 'resumed' };
      }
      continuationClaimMarker = marker;
    }
  }

  const resumeRecipe = checkpoint.recipe_snapshot !== undefined
    ? checkpoint.recipe_snapshot as unknown as RecipeDefinition
    : executeDeps.recipeStore.get(checkpoint.recipe_id!);
  const observedRecipeHash = resumeRecipe === null || resumeRecipe === undefined
    ? undefined
    : hashRecipe(resumeRecipe);
  // ⚠ `recipe_source_hash` IS A CANONICAL-FORM HASH; `anchor.recipe_hash` IS
  // NOT. They are different fields with different producers, so they get
  // different bases here rather than one shared variable — canonicalizing the
  // anchor comparison too would silently change a basis nothing asked me to.
  const observedSourceHash = resumeRecipe === null || resumeRecipe === undefined
    ? undefined
    : hashRecipe(canonicalRecipeDefinition(resumeRecipe));
  const sourceHashDrifted = checkpoint.recipe_source_hash !== undefined
    && observedSourceHash !== checkpoint.recipe_source_hash;
  const inlineSnapshotDrifted = checkpoint.recipe_snapshot !== undefined
    && observedRecipeHash !== anchor.recipe_hash;
  if (observedRecipeHash === undefined || sourceHashDrifted || inlineSnapshotDrifted) {
    const at = Date.now();
    const error: RecipeError = {
      error_id: `peer-resume-integrity-${at.toString(36)}-${checkpoint.run_id}`,
      code: 'RECIPE_VALIDATION_FAILED',
      message:
        observedRecipeHash === undefined
          ? 'The recipe saved for this peer-answer continuation is no longer available.'
          : 'The recipe saved for this peer-answer continuation no longer matches the paused run.',
      severity: 'fatal',
      source: {
        recipe_id: anchor.recipe_id,
        step_id: checkpoint.gated_step_id ?? null,
        ingredient_slug: 'peer-ask',
      },
      details: {
        reason: 'peer_checkpoint_recipe_drift',
        ...(checkpoint.recipe_source_hash !== undefined
          ? { expected_source_hash: checkpoint.recipe_source_hash }
          : {}),
        ...(observedRecipeHash !== undefined
          ? { observed_source_hash: observedRecipeHash }
          : {}),
      },
      timestamp: new Date(at).toISOString(),
      retryable: false,
    };
    await appendPeerContinuationFailure(anchor, checkpoint, error, deps);
    return { kind: 'resumed' };
  }

  // A recorded question/answer is durable evidence, never live authority for
  // the remaining recipe. Re-read bearer/contract/Seller/route authority at
  // answer time under the same resolver used by owner-approval continuation.
  let resumeAnchor = anchor;
  const persistedSource = anchor.execution_source;
  const requiresFreshBearer = persistedSource?.channel === 'mcp'
    || (persistedSource?.channel === 'chat'
      && persistedSource.actor === 'contracted_user');
  if (persistedSource !== undefined && requiresFreshBearer) {
    let authority: ReturnType<
      NonNullable<ExecuteHandlerDeps['approvalResumeAuthority']>['resolve']
    >;
    if (executeDeps.approvalResumeAuthority === undefined) {
      authority = {
        admitted: false,
        reason: 'authority_resolution_failed',
        detail: 'peer-answer resume authority resolver is unavailable',
      };
    } else {
      try {
        const requiredBearerToolNames = requiredResumeBearerToolNames(
          checkpoint,
          anchor,
          executeDeps,
        );
        authority = executeDeps.approvalResumeAuthority.resolve({
          execution_source: persistedSource,
          ...(requiredBearerToolNames !== undefined
            ? { required_bearer_tool_names: requiredBearerToolNames }
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
    if (authority.admitted
      && executionSourceHasContract(authority.execution_source)
      && authority.contract_snapshot === undefined) {
      authority = {
        admitted: false,
        reason: 'authority_resolution_failed',
        detail: 'fresh authority returned no contract snapshot',
      };
    }
    if (!authority.admitted) {
      const at = Date.now();
      const error: RecipeError = {
        error_id: `peer-resume-authority-${at.toString(36)}-${checkpoint.run_id}`,
        code: 'RECIPE_POLICY_DENIED',
        message:
          `Peer-answer resume denied because live authority changed `
          + `(${authority.reason}: ${authority.detail}).`,
        severity: 'fatal',
        source: {
          recipe_id: anchor.recipe_id,
          step_id: checkpoint.gated_step_id ?? null,
          ingredient_slug: 'peer-ask',
        },
        details: { authority_reason: authority.reason },
        timestamp: new Date(at).toISOString(),
        retryable: false,
      };
      await appendPeerContinuationFailure(anchor, checkpoint, error, deps);
      return { kind: 'resumed' };
    }
    resumeAnchor = { ...anchor, execution_source: authority.execution_source };
    if (authority.contract_snapshot !== undefined) {
      resumeAnchor.contract_snapshot = authority.contract_snapshot;
    } else {
      delete resumeAnchor.contract_snapshot;
    }
  }

  // ⚠ THE RUN-SHAPE COMES OFF THE PAUSED ANCHOR, not off this call. The resumed
  // gated step must resolve `{{config.*}}` / `{{context.*}}` against the values
  // the ORIGINAL run saw — anything else re-dispatches a different question than
  // the one the peer answered. Mirrors `PreflightResumer.buildResumeInputs`.
  const request: ExecuteRequest = {
    ...(checkpoint.recipe_snapshot !== undefined
      ? { recipe: checkpoint.recipe_snapshot }
      : { recipe_id: checkpoint.recipe_id! }),
    // ⚠ `?? {}` ON BOTH, and the first cut had neither. `config_snapshot` is
    // documented as required-and-never-stripped, and it is still NULL on a real
    // anchor here — a spread of null throws `Cannot convert undefined or null to
    // object`, which surfaced as "recorded but resume failed" with the answer
    // already durable. A snapshot-shaped field being absent in practice is the
    // ordinary case, not the exceptional one; the resume must degrade to "no
    // config" rather than strand a run whose answer already came home.
    config: { ...(resumeAnchor.config_snapshot ?? {}) },
    ...(resumeAnchor.context_snapshot != null
      && Object.keys(resumeAnchor.context_snapshot).length > 0
      ? { context: { ...resumeAnchor.context_snapshot } }
      : {}),
    ...(resumeAnchor.trigger_source != null
      ? { trigger_source: resumeAnchor.trigger_source }
      : {}),
    ...(resumeAnchor.instance_id != null
      ? { instance_id: resumeAnchor.instance_id }
      : {}),
    ...(resumeAnchor.execution_source != null
      ? { execution_source: resumeAnchor.execution_source }
      : {}),
    ...(resumeAnchor.contract_snapshot != null
      ? { contract_snapshot: resumeAnchor.contract_snapshot }
      : {}),
    ...(resumeAnchor.process_id != null
      ? { process_id: resumeAnchor.process_id }
      : {}),
    ...(resumeAnchor.dish_id != null && !isEphemeralDishId(resumeAnchor.dish_id)
      ? { dish_id: resumeAnchor.dish_id }
      : {}),
  } as ExecuteRequest;

  try {
    await handleExecute(
      executeDeps,
      request,
      {
        // Same run identity, so the resumed execution lands on the SAME anchor
        // rather than minting a second run for one conversation.
        run_id: target.run_id,
        // ⛔⛔ `step_state` IS NOT OPTIONAL, and omitting it does not degrade — it
        // THROWS. `handleExecute` seeds the resumed run's `step.*` from it through
        // `assignOwnSafe`, which calls `Object.entries` on whatever it is given, so
        // an absent snapshot is a `TypeError` several frames below and surfaces as
        // "recorded but resume failed" with the answer already durable. It is also
        // the reason a resume is a resume at all: without the prior steps' outputs
        // the re-run would re-execute the whole recipe rather than continue it.
        ...(checkpoint.predecessor_commit_id !== undefined
          ? { predecessor_commit_id: checkpoint.predecessor_commit_id }
          : {}),
        ...(typeof resumeAnchor.granted_by_recipe === 'string'
          && resumeAnchor.granted_by_recipe.length > 0
          ? { granted_by_recipe: resumeAnchor.granted_by_recipe }
          : {}),
        ...(typeof resumeAnchor.exchange_ref === 'string'
          && resumeAnchor.exchange_ref.length > 0
          ? { exchange_ref: resumeAnchor.exchange_ref }
          : {}),
        resume_from: {
          gated_step_id: target.gated_step_id,
          step_state: checkpoint.step_state,
          ...(checkpoint.foreach_progress !== undefined
            ? { foreach_progress: checkpoint.foreach_progress }
            : {}),
          ...(checkpoint.preflight_context?.egress_bound !== undefined
            ? { egress_bound: checkpoint.preflight_context.egress_bound }
            : {}),
          ...(checkpoint.approved_target !== undefined
            ? { approved_target: checkpoint.approved_target }
            : {}),
          ...(checkpoint.arg_overrides !== undefined
            ? { arg_overrides: checkpoint.arg_overrides }
            : {}),
          ...(checkpoint.pii_ledgers !== undefined
            ? { pii_ledgers: checkpoint.pii_ledgers }
            : {}),
        },
      } as never,
    );
  } catch (error) {
    if (!continuationClaimed || target.exchange_ref === undefined) throw error;
    await settleClaimedContinuationInDoubt(
      anchor,
      checkpoint,
      target.exchange_ref,
      error,
      deps,
    );
    return {
      kind: 'skipped',
      reason: 'peer answer continuation failed after claim and was reconciled in_doubt',
    };
  }
  if (continuationClaimed && target.exchange_ref !== undefined) {
    const observed = await deps.auditLog.get(target.run_id);
    if (observed === null || isOriginalPeerAnchor(observed, checkpoint)) {
      await settleClaimedContinuationInDoubt(
        anchor,
        checkpoint,
        target.exchange_ref,
        'resumed handler returned without a durable superseding run anchor',
        deps,
      );
      return {
        kind: 'skipped',
        reason: 'peer answer continuation lacked a verified audit outcome and was reconciled in_doubt',
      };
    }
    if (continuationClaimMarker !== undefined
      && isContinuationClaimMarker(observed, target.exchange_ref)) {
      return {
        kind: 'skipped',
        reason: 'peer answer continuation retained its durable in_doubt claim marker',
      };
    }
  }
  return { kind: 'resumed' };
};
