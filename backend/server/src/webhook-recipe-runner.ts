/** D-201 Slices 5A/5B2A — production recipe runner and approval reconciler.
 *
 * The consumer store supplies a stable run id. This adapter collapses concurrent
 * in-process retries, reuses an already-succeeded durable audit anchor, and
 * re-enters a retryable failed run under the same id, and hands approval pauses
 * to durable dispatch state. Other live/ambiguous states stay fail-closed: they
 * are never converted into a second run identity.
 */

import type { AuditEntry, AuditLogStore } from '@recued/storage';
import {
  executionSourceContractId,
  type RecipeDefinition,
} from '@recued/contracts';
import { handleExecute, type ExecuteHandlerDeps } from './execute-handler.js';
import { isRunRefusedForNow } from './pause-approval.js';
import {
  WebhookRunNotRestartedError,
  type WebhookRecipeRunResult,
  type WebhookRecipeRunner,
  type WebhookRecipeRunRequest,
} from './webhook-recipe-consumer.js';
import {
  deriveResolvedRecipeCapability,
  type OpResolver,
} from './derive-recipe-capability.js';
import { closedByOwner, doorCapabilityChanged } from './mint-door-contract.js';
import { ownerLeftDoorClosed, webhookDoorState } from './webhook-door-enroll.js';
import type { DoorRecipeResolver } from './recipe-capability-wiring.js';
import type { InternalExecuteOverrides } from './types.js';
import type { WebhookConsumerStore } from './storage/webhook-consumer-store.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';
import { buildWebhookContractSnapshot } from './webhook-contract-snapshot.js';
import type { ServerPreflightResumer } from './preflight-resumer.js';
import type { HeldRunPass } from './storage/approval-restart-continuation-store.js';

export interface ExecuteWebhookRecipeRunnerDeps {
  executeDeps: ExecuteHandlerDeps;
  auditLog: Pick<AuditLogStore, 'get'>;
  /** The recipe's INSTALL config (its `is_default` dish overlay — D-179).
   *
   *  ⛔ NOT optional: `handleExecute` skips its own install-dish merge for any run
   *  carrying a `run_id` (it reads one as "a replay that brought its own config"),
   *  and this runner always carries one for idempotency. Without this dep every
   *  webhook recipe runs with an EMPTY config — `{{config.*}}`, including the
   *  connection its provider reads resolve through, silently resolves to nothing.
   *  Same shape and reason as the reception runner's `resolveConfig` (3c·1). */
  resolveConfig: (recipeId: string) => Record<string, unknown> | undefined;
  /** D-320 phase 3 (3b) — the main dish's choice of connection, passed to the run for
   *  the same reason as `resolveConfig` (`composeInstallConnectionsResolver`). */
  readonly resolveDishConnections?: (recipeId: string) => InternalExecuteOverrides['dish_connections'];
  readonly resolveDoorRecipe?: DoorRecipeResolver;
  readonly resolveOp?: OpResolver;
  /** D-209 #1 W3 — the store the door's `ContractSnapshot` resolves from. MUST be
   *  the same instance the Gateway reads its verdicts from (compose-listeners
   *  threads `execution.contractDefinitionStore`). A harness without one passes a
   *  `get: () => null` stub — every stamped door then resolves DEAD (empty
   *  allowlist, no ceiling), which denies: fail-closed, never fail-open. */
  definitionStore: Pick<ContractDefinitionStore, 'get'>;
  /** Snapshot clock (`resolved_at` + door liveness). Defaults to `Date.now`. */
  now?: () => number;
  /** D-201 Slice 10AV (10AS finding 18) — whether the owner has closed the
   *  door a run's delivery goes through now (`ownerClosedTheDoorNow`), read
   *  when Recued retired the door the run ran under, as the reconcile reads it
   *  (`refusedByItsOwner`). Absent: not read, as before 10AV. */
  closedByItsOwnerNow?: (runId: string) => boolean;
  /** D-201 Slice 10W (10V finding 1) — the owner's try again of an approved
   *  run a stop left in doubt, and the next start's re-entry of one a restart
   *  stopped during that try again, go on from where it stood
   *  (`ServerPreflightResumer.continueHeldRun`): from the step in doubt, what
   *  went through standing in. Absent, or with nothing held, the run starts
   *  from its first step, as before 10W. */
  continueHeldRun?: ServerPreflightResumer['continueHeldRun'];
  /** D-201 Slice 10AB (10AA finding 1) — a try again the process went during
   *  left a hold with no ask: the dead letter again, never a hold
   *  (`ServerPreflightResumer.settleDiedTryAgain`). */
  settleDiedTryAgain?: ServerPreflightResumer['settleDiedTryAgain'];
}

const assertTargetStillMatches = (
  deps: ExecuteWebhookRecipeRunnerDeps,
  input: WebhookRecipeRunRequest,
): RecipeDefinition => {
  if (input.idempotency_key !== input.run_id) {
    throw new Error('webhook recipe runner: idempotency key must equal run id');
  }
  const stored = deps.executeDeps.recipeStore.getStored(input.recipe_id);
  const recipe = deps.executeDeps.recipeStore.get(input.recipe_id);
  if (!stored
    || stored.publisher_id !== input.publisher_id
    || recipe === null) {
    throw new Error('webhook recipe runner: recipe target is no longer installed');
  }
  return recipe;
};

/** ⛔ A refusal under a door that has since been REPLACED is not a refusal of this
 *  delivery. A machine re-derive (a pack's connections, a reinstall, a dish's choice,
 *  the boot re-derive) never edits a door: it mints a new one, re-stamps the trigger
 *  rows with it and revokes the old one (`reconcileWebhookDoors`). A run in flight
 *  under the old door is refused at its next gated step, non-retryably, and the
 *  retry's claim carries the new door from the re-stamped row. An owner's revoke
 *  leaves the revoked door stamped (D-295), so its retry claims the door the attempt
 *  ran under, and stays refused. Read as an owner's denial, the retry was cancelled
 *  and the event never ran (the D-320 audit). The re-entered run still passes the
 *  checks below on the new door: live, a webhook door, granting what the recipe
 *  derives. An owner's denial (`details.denied_by`, `preflight-resumer.ts`) stays
 *  closed whatever happened to the door since: the owner said no to this delivery. */
const ranUnderAReplacedDoor = (
  deps: ExecuteWebhookRecipeRunnerDeps,
  attempt: AuditEntry,
  input: WebhookRecipeRunRequest,
): boolean => {
  if ((attempt.errors ?? []).some((error) => error.details?.['denied_by'] === 'owner')) return false;
  const ranUnder = (attempt.execution_source === undefined
    ? undefined
    : executionSourceContractId(attempt.execution_source)) ?? attempt.contract_snapshot?.contract_id;
  const claimed = input.execution_source.contract_id;
  if (ranUnder === undefined || claimed === undefined) return false;
  const door = deps.definitionStore.get(ranUnder);
  if (door === null || door.revoked_at === undefined || door.revoked_at === null) return false;
  // D-201 Slice 10AG (10AE finding 3) — the door it ran under is the one its
  // delivery names, retired by the server meanwhile (a settings change, a
  // re-derive): Recued's own replacement, not the owner's closing. An ordinary
  // retry is claimed again under the new door, so the two differ; the owner's
  // try again of a held run goes on under the door it was claimed under, and
  // a door replaced during it read as the owner's refusal: a silent cancel.
  if (ranUnder === claimed) {
    if (closedByOwner(door)) return false;
    // D-201 Slice 10AV (10AS finding 18) — Recued retired it, and the owner
    // has closed the door its delivery goes through now, the one that replaced
    // it: their refusal, as the reconcile reads it (10AP, 10AM finding 3). The
    // runner kept it as an in-doubt dead letter while the reconcile cancelled
    // the same record.
    return deps.closedByItsOwnerNow?.(attempt.run_id) !== true;
  }
  return true;
};

/** D-201 Slice 10AK (10AI finding 6) — the reconcile's reading of a held
 *  run's failure as the owner's refusal, as the runner reads a run it claimed
 *  (`ownerRefusal`): their decline, or a refusal for good by the gate (a
 *  non-retryable `RECIPE_POLICY_DENIED`: their closing of its door, an
 *  operation they switched off) under a door Recued has not retired since. A
 *  door its owner closed is theirs (`closedByOwner`); one Recued retired (a
 *  settings change, a re-derive) is not, and the run is held for a try again
 *  under the door that replaced it. Read for the answer to a held try again's
 *  ask (`heldRunReconcileOptions`). */
export const refusedByItsOwner = (
  definitionStore: Pick<ExecuteWebhookRecipeRunnerDeps['definitionStore'], 'get'>,
  attempt: Pick<AuditEntry, 'commit_status' | 'errors' | 'execution_source' | 'contract_snapshot'>,
  /** D-201 Slice 10AP (10AM finding 3) — whether the owner has closed the door
   *  the delivery goes through now (`ownerLeftDoorClosed`), read when Recued
   *  retired the door the run ran under. */
  closedByItsOwnerNow?: () => boolean,
): boolean => {
  if (attempt.commit_status !== 'failed') return false;
  const errors = attempt.errors ?? [];
  if (errors.some((error) => error.details?.['denied_by'] === 'owner')) return true;
  if (!errors.some((error) => error.code === 'RECIPE_POLICY_DENIED' && error.retryable === false)) return false;
  const ranUnder = (attempt.execution_source === undefined
    ? undefined
    : executionSourceContractId(attempt.execution_source)) ?? attempt.contract_snapshot?.contract_id;
  if (ranUnder === undefined) return true;
  const door = definitionStore.get(ranUnder);
  if (door === null || door.revoked_at === undefined || door.revoked_at === null) return true;
  if (closedByOwner(door)) return true;
  // D-201 Slice 10AP (10AM finding 3) — Recued replaced the door the run ran
  // under (a settings change, a re-derive), and the owner closed the one that
  // replaced it: their refusal too, as a closing during any run is. Only the
  // door it ran under was read, so the run was held for a try again that its
  // owner's closing would refuse.
  return closedByItsOwnerNow?.() === true;
};

/** D-201 Slice 10AK (10AI findings 6 and 11) — what the reconcile reads of
 *  held runs, as production composes it (`compose-listeners.ts`): a run a
 *  restart kept, a held run whose resume failed, and the owner's refusal. */
/** D-201 Slice 10AV (10AS finding 18) — whether the owner has closed the door
 *  a run's delivery goes through now: one reading for the reconcile
 *  (`heldRunReconcileOptions`) and the runner (`closedByItsOwnerNow`). */
export const ownerClosedTheDoorNow = (
  consumerStore: (Pick<WebhookConsumerStore, 'doorOwnerOfRun' | 'doorContractIdForRecipe'>
    & Partial<Pick<WebhookConsumerStore, 'newestRecipeDoor' | 'doorAnswerFor'>>) | undefined,
  definitionStore: Pick<ExecuteWebhookRecipeRunnerDeps['definitionStore'], 'get'>,
) => (runId: string): boolean => {
  const owner = consumerStore?.doorOwnerOfRun(runId) ?? null;
  return consumerStore !== undefined && owner !== null && ownerLeftDoorClosed(
    { consumerStore, definitionStore },
    owner.consumer_kind,
    owner.consumer_id,
    owner.recipe_id,
    owner.publisher_id,
  );
};

export const heldRunReconcileOptions = (
  pass: Pick<HeldRunPass, 'hasKeptRun' | 'isHeldFailure'>,
  definitionStore: Pick<ExecuteWebhookRecipeRunnerDeps['definitionStore'], 'get'>,
  /** D-201 Slice 10AP — the door the delivery goes through now (finding 3),
   *  and the answers' resumes still under way (findings 5 and 18). */
  more: {
    readonly consumerStore?: Pick<WebhookConsumerStore, 'doorOwnerOfRun' | 'doorContractIdForRecipe'>
      & Partial<Pick<WebhookConsumerStore, 'newestRecipeDoor' | 'doorAnswerFor'>>;
    readonly isResuming?: (runId: string) => boolean;
  } = {},
): {
  readonly hasKeptRun: (runId: string) => boolean;
  readonly isHeldFailure: (runId: string) => boolean;
  readonly isOwnerRefusal: (anchor: AuditEntry) => boolean;
  readonly isResuming: (runId: string) => boolean;
} => ({
  hasKeptRun: (runId) => pass.hasKeptRun(runId),
  isHeldFailure: (runId) => pass.isHeldFailure(runId),
  isOwnerRefusal: (anchor) => refusedByItsOwner(definitionStore, anchor,
    () => ownerClosedTheDoorNow(more.consumerStore, definitionStore)(anchor.run_id)),
  isResuming: (runId) => more.isResuming?.(runId) === true,
});

/** A run the owner refused, or their door did, under a door still its own. */
const ownerRefusal = (
  deps: ExecuteWebhookRecipeRunnerDeps,
  attempt: AuditEntry,
  input: WebhookRecipeRunRequest,
): boolean => attempt.commit_status === 'failed'
  && (attempt.errors ?? []).some((error) => error.code === 'RECIPE_POLICY_DENIED' && error.retryable === false)
  && !ranUnderAReplacedDoor(deps, attempt, input);

/** The same run record: nothing replaced it in between. */
const sameRunRecord = (a: AuditEntry | null, b: AuditEntry | null): boolean =>
  a === null || b === null
    ? a === b
    : a.commit_status === b.commit_status
      && a.started_at === b.started_at
      && a.finished_at === b.finished_at;

/** D-201 Slice 10J — under the restart's mark, a failure before a new run
 * record replaced the one present at the start says so
 * (`WebhookRunNotRestartedError`), and the worker keeps the mark: a failure
 * before the run starts again (the target changed, the door must be re-saved,
 * the anchor could not be read) never turns the restart into the owner's Stop.
 * A refusal to start (restarting, paused) goes back unchanged: it is handed
 * back with its attempt, mark and all. */
const runOnce = async (
  deps: ExecuteWebhookRecipeRunnerDeps,
  input: WebhookRecipeRunRequest,
): Promise<WebhookRecipeRunResult> => {
  if (input.resume_interrupted_run !== true && input.rerun_in_doubt !== true) {
    return runAttempt(deps, input);
  }
  let before: AuditEntry | null;
  try {
    before = await deps.auditLog.get(input.run_id);
  } catch (error) {
    throw new WebhookRunNotRestartedError(error);
  }
  try {
    return await runAttempt(deps, input, before);
  } catch (error) {
    if (isRunRefusedForNow(error)) throw error;
    let after: AuditEntry | null = before;
    try {
      after = await deps.auditLog.get(input.run_id);
    } catch {
      // Unknown: the mark stays (a restart read as a Stop is the worse error).
    }
    if (sameRunRecord(before, after)) throw new WebhookRunNotRestartedError(error);
    throw error;
  }
};

const runAttempt = async (
  deps: ExecuteWebhookRecipeRunnerDeps,
  input: WebhookRecipeRunRequest,
  read?: AuditEntry | null,
): Promise<WebhookRecipeRunResult> => {
  assertTargetStillMatches(deps, input);
  const existing = read !== undefined ? read : await deps.auditLog.get(input.run_id);
  let goesOn = false;
  if (existing) {
    if (existing.trigger_source !== 'webhook') {
      throw new Error('webhook recipe runner: run id belongs to a non-webhook run');
    }
    if (existing.recipe_id !== input.recipe_id) {
      throw new Error('webhook recipe runner: run id belongs to another recipe');
    }
    if (existing.commit_status === 'succeeded') return 'completed';
    if (existing.commit_status === 'awaiting_approval') {
      // D-201 Slice 10AB (10AA finding 1) — the paused record a try again put
      // back, left by a process that went during it: no ask stands under it.
      // Parked as a hold, the delivery waited for good.
      if (deps.settleDiedTryAgain !== undefined && await deps.settleDiedTryAgain(input.run_id, existing)) {
        return 'in_doubt';
      }
      return 'awaiting_approval';
    }
    // An owner denial (including approval-time authority revocation) is a
    // durable terminal refusal, not a failed execution that the outbox may
    // re-enter. This also closes the crash window between the approval core's
    // terminal audit write and the webhook store's wait-marker handoff. A
    // refusal under a door that has since been replaced is neither, and re-enters.
    if (ownerRefusal(deps, existing, input)) return 'terminal_non_success';
    // D-201 Slice 10E — a run the server's own stop ended is recorded `killed`
    // too. Its target carries the restart's mark, and it runs again here on
    // its run id, as a failed run does: the same fixed run and commit
    // identities collapse whatever it already sent. Before, a restart that
    // stopped a webhook run past its 3-second grace closed the target as if
    // the owner had pressed Stop: no retry, no dead letter, no log.
    const stoppedByRestart = (existing.commit_status === 'killed'
      && input.resume_interrupted_run === true)
      // D-201 Slice 10N — an approved run whose outcome was in doubt, which
      // the owner, having looked, tried again from its dead letter: it runs
      // again, and its hold asks the owner afresh, under a receipt of its own.
      // Only the owner's try again does this: the restart's mark never does.
      || (existing.commit_status === 'in_doubt' && input.rerun_in_doubt === true)
      // D-201 Slice 10AB (10AA finding 2) — a try again that failed at a later
      // step is held from it, and the owner's next try again goes on from there.
      || (existing.commit_status === 'failed' && input.rerun_in_doubt === true);
    // A terminal cancellation, kill, or in-doubt result must never burn the
    // delivery outbox retry budget. This is especially important in the narrow
    // crash window after an approval decision but before the wait marker lands:
    // the durable audit result closes the original target without re-execution.
    if (!stoppedByRestart
      && (existing.commit_status === 'cancelled'
        || existing.commit_status === 'killed'
        || existing.commit_status === 'in_doubt')) {
      return 'terminal_non_success';
    }
    // A failed run is the one safe terminal state the internal retry loop may
    // re-enter. Fixed run/commit identities let the gateway collapse repeated
    // provider side effects; all other states need owner/reconciler handling.
    if (!stoppedByRestart && existing.commit_status !== 'failed') {
      throw new Error(
        `webhook recipe runner: run is not retryable (${existing.commit_status})`,
      );
    }
    goesOn = stoppedByRestart;
  }

  // Resolved fresh on every (re-)entry: a retry of a failed anchor runs with the
  // install config as it stands NOW, exactly like a fresh fire would.
  const recipe = assertTargetStillMatches(deps, input);
  const config = deps.resolveConfig(input.recipe_id);
  const dishConnections = deps.resolveDishConnections?.(input.recipe_id);
  // Current production wiring always supplies the exact door resolver. Under that wiring,
  // an unstamped, dead, or cross-class door runs nothing. An empty snapshot only fences
  // ingredient calls; a pure-transform recipe could otherwise report success and silently
  // consume the event after its door was revoked.
  // D-201 Slice 10U (10Q finding 9) — and says which, so the worker keeps the delivery
  // for the owner. As a terminal non-success it was cancelled with no record: every row
  // a crash re-homed onto a trigger whose door the save never made, and every delivery
  // to a pack whose mint failed.
  if (deps.resolveDoorRecipe !== undefined) {
    const door = webhookDoorState(
      deps.definitionStore,
      input.execution_source.contract_id,
      (deps.now ?? Date.now)(),
    );
    if (door !== 'live') return door === 'missing' ? 'door_missing' : 'door_closed';
  }
  // D-209 #1 W3 — a stamped door dispatches under its ContractSnapshot: the door's
  // tool allowlist + authored `admin` ceiling (two-sided enrollment IS the standing
  // approval, §1.4). NOT optional when the source carries a contract_id — a
  // contract-bearing source with no snapshot THROWS at the policy/preflight gates.
  // Re-resolved fresh per (re-)entry like the config, so revoking the door between
  // retries kills the retry too. A door-less source (unstamped trigger row) skips
  // the build and floors to `PUBLIC_CONTRACT_ID` at the gate (denies).
  const contract_snapshot = input.execution_source.contract_id !== undefined
    ? buildWebhookContractSnapshot(input.execution_source, {
        definitionStore: deps.definitionStore,
        now: deps.now ?? Date.now,
      // ⛔ `'recipe'` — this runner dispatches an ARBITRARY user recipe, so
      // D-209's authored ceiling is not admissible on it (its rule requires a
      // machine delivering to a DETERMINISTIC path). The door keeps its minted
      // `admin`; this dispatch simply does not borrow it, and falls to the LOW
      // ceiling every other unattended trigger already sits on.
      }, 'recipe')
    : undefined;
  if (
    input.execution_source.contract_id !== undefined
    && deps.resolveDoorRecipe !== undefined
  ) {
    const dispatchRecipe = deps.resolveDoorRecipe(recipe, config ?? {});
    const storedDoor = deps.definitionStore.get(input.execution_source.contract_id);
    if (!dispatchRecipe.ok) {
      throw new Error('webhook recipe runner: door binding changed; re-save the recipe');
    }
    const resolveOp = dispatchRecipe.resolveOp ?? deps.resolveOp;
    // D-320 phase 3 (3b) — the config the run will resolve connections against,
    // each slot's empty setting filled as the run fills it (`settleDoorConnections`).
    const doorConfig = 'config' in dispatchRecipe && dispatchRecipe.config !== undefined
      ? dispatchRecipe.config
      : config;
    const derived = deriveResolvedRecipeCapability(recipe, dispatchRecipe.recipe, {
      ...(doorConfig === undefined ? {} : { config: doorConfig }),
      ...(resolveOp === undefined ? {} : { resolveOp }),
    });
    if (!derived.ok || doorCapabilityChanged(storedDoor, derived.capability).changed) {
      throw new Error('webhook recipe runner: door authority changed; re-save the recipe');
    }
  }
  // D-201 Slice 10W (10V finding 1) — a run held where it stood goes on from
  // there: from the step in doubt, everything that went through standing in.
  // Before 10W the try again started from the first step, and a close the
  // owner had approved ran again, and every notice before the one in doubt.
  if (goesOn && deps.continueHeldRun !== undefined) {
    const held = await deps.continueHeldRun(input.run_id, {
      execution_source: input.execution_source,
      ...(contract_snapshot === undefined ? {} : { contract_snapshot }),
    });
    if (held.kind === 'completed' || held.kind === 'awaiting_approval'
      || held.kind === 'interrupted' || held.kind === 'in_doubt') {
      return held.kind;
    }
    // D-201 Slice 10AB (10AA finding 2) — failed at a later step, and held
    // from it: the owner's dead letter again, whose try again goes on from
    // that step. A refusal the owner's door made stays one, as for any run.
    if (held.kind === 'held_failed') {
      const failed = await deps.auditLog.get(input.run_id);
      if (failed !== null && ownerRefusal(deps, failed, input)) return 'terminal_non_success';
      return 'in_doubt';
    }
    if (held.kind === 'failed') throw new Error('webhook recipe runner: recipe execution failed');
  }
  const result = await handleExecute(deps.executeDeps, {
    recipe_id: input.recipe_id,
    context: input.context,
    ...(config === undefined ? {} : { config }),
    ...(contract_snapshot === undefined ? {} : { contract_snapshot }),
    trigger_source: 'webhook',
    execution_source: input.execution_source,
  }, {
    run_id: input.run_id,
    ...(dishConnections === undefined ? {} : { dish_connections: dishConnections }),
  });
  if (!result.success) {
    if (result.awaiting_approval) return 'awaiting_approval';
    // D-201 Slice 10E — stopped while the server is stopping: the restart's
    // drain ended it (`preapproval-execution.ts` reads it the same way).
    if (result.run_terminated === 'killed' && deps.executeDeps.isDraining?.() === true) {
      return 'interrupted';
    }
    throw new Error(
      'webhook recipe runner: recipe execution failed',
    );
  }
  return 'completed';
};

export interface WebhookApprovalReconciliationResult {
  scanned: number;
  waiting: number;
  succeeded: number;
  failed: number;
  /** D-201 Slice 10J — approved runs the server's stop ended: dead letters. */
  interrupted: number;
  /** D-201 Slice 10N — approved runs whose outcome is in doubt: dead letters
   *  for the owner's review, never a silent cancel (10L finding 4). */
  in_doubt: number;
}

const APPROVAL_RECONCILIATION_BATCH_SIZE = 25;

/** Fold terminal decisions written by the shared approval resumer back into
 * webhook-owned dispatch state. The audit anchor is authoritative for run
 * outcome; the wait table is authoritative for whether this webhook target is
 * still entitled to retain its decoded-payload pin. */
export const reconcileWebhookAwaitingApprovalDispatches = async (
  consumerStore: Pick<
    WebhookConsumerStore,
    'takeAwaitingApprovalDispatches' | 'resolveAwaitingApprovalDispatch' | 'clearHeldRestartMark'
  >,
  auditLog: Pick<AuditLogStore, 'get'>,
  options: {
    /** D-201 Slice 10AB (10AA finding 6) — a run a restart kept for the next
     *  start, which the start's replay of its answer finishes
     *  (`HeldRunPass.hasKeptRun`). */
    readonly hasKeptRun?: (runId: string) => boolean;
    /** D-201 Slice 10AG (10AE finding 2) — a run held for the owner's try
     *  again, its resume having failed (`HeldRunPass.isHeldFailure`). D-201
     *  Slice 10AK (10AI finding 11) — only one marked failed: an ask that
     *  expired, or a resume refused before it ran, ends as any run does. */
    readonly isHeldFailure?: (runId: string) => boolean;
    /** D-201 Slice 10AK (10AI finding 6) — the owner's refusal of that run
     *  (`refusedByItsOwner`): it ends as any run they refuse. */
    readonly isOwnerRefusal?: (anchor: AuditEntry) => boolean;
    /** D-201 Slice 10AP (10AM findings 5 and 18) — an answer's resume of the
     *  run still under way (`ServerPreflightResumer.isResumingRun`): it
     *  waits, for the resume writes what it keeps after the run's record. */
    readonly isResuming?: (runId: string) => boolean;
  } = {},
): Promise<WebhookApprovalReconciliationResult> => {
  const waitingDispatches = consumerStore.takeAwaitingApprovalDispatches(
    APPROVAL_RECONCILIATION_BATCH_SIZE,
  );
  const result: WebhookApprovalReconciliationResult = {
    scanned: waitingDispatches.length,
    waiting: 0,
    succeeded: 0,
    failed: 0,
    interrupted: 0,
    in_doubt: 0,
  };
  for (const dispatch of waitingDispatches) {
    // D-201 Slice 10AP (10AM findings 5 and 18) — read after its resume is
    // done: before, a hold the resume was still writing read as none, and the
    // delivery was cancelled.
    if (options.isResuming?.(dispatch.run_id) === true) {
      result.waiting += 1;
      continue;
    }
    const anchor = await auditLog.get(dispatch.run_id);
    const anchorMatches = anchor !== null
      && anchor.trigger_source === 'webhook'
      && anchor.recipe_id === dispatch.recipe_id;
    if (anchor !== null
      && anchorMatches
      && (anchor.commit_status === 'awaiting_approval'
        || anchor.commit_status === 'pending'
        || anchor.commit_status === 'running')) {
      // D-201 Slice 10J — waiting on the owner again: a new record replaced
      // the one the restart's mark was for (the run reached another hold
      // before the drain's stop), so the mark goes.
      if (dispatch.restart_interrupted && anchor.commit_status === 'awaiting_approval') {
        consumerStore.clearHeldRestartMark({
          dispatch_id: dispatch.dispatch_id,
          run_id: dispatch.run_id,
        });
      }
      result.waiting += 1;
      continue;
    }
    // A wait marker is written only after the awaiting audit anchor is durable,
    // and audit retention exempts that anchor. Missing or mismatched authority
    // is therefore orphan/corruption residue: cancel and release the payload pin
    // instead of retaining decoded data forever.
    const succeeded = anchor !== null
      && anchorMatches
      && anchor.commit_status === 'succeeded';
    // D-201 Slice 10J — the owner approved it and the server's own stop ended
    // its run (the drain marked the hold while the run resumed): `killed` is
    // the restart's, not the owner's Stop. A dead letter, never a silent cancel.
    const killed = !succeeded
      && anchor !== null
      && anchorMatches
      && anchor.commit_status === 'killed';
    // D-201 Slice 10AB (10AA finding 6) — kept for the next start, whose
    // replay of the answer finishes it (the outbox reconciles before that
    // replay at boot): it waits for that. A dead letter here stayed open after
    // the run finished, saying the recipe would run from its first step.
    // D-201 Slice 10AG (10AE finding 12) — whether or not the restart's mark
    // stands, and the mark goes: only a restart keeps a run, and one during
    // the replay keeps or marks it again. Kept, the mark made the owner's Stop
    // of that replay read as the restart's: a dead letter whose try again ran
    // the recipe from its first step.
    if (killed && options.hasKeptRun?.(dispatch.run_id) === true) {
      if (dispatch.restart_interrupted) {
        consumerStore.clearHeldRestartMark({
          dispatch_id: dispatch.dispatch_id,
          run_id: dispatch.run_id,
        });
      }
      result.waiting += 1;
      continue;
    }
    const interrupted = killed && dispatch.restart_interrupted;
    // D-201 Slice 10N (10L finding 4) — the approved run's outcome is in doubt:
    // a restart or a crash while its operation ran (the next start's recovery
    // of the answer writes `in_doubt`), or the operation's own uncertain
    // answer. The owner reviews it: it was a silent cancel that released the pin.
    const inDoubt = !succeeded
      && anchor !== null
      && anchorMatches
      && (anchor.commit_status === 'in_doubt'
        // D-201 Slice 10AG (10AE finding 2) — the answer to an ask the owner's
        // try again paused at, its run failing after it: held again for the
        // owner's next try again. A run the owner declined ends as any does.
        // D-201 Slice 10AK (10AI finding 6) — and so does one their door
        // refused, closed or with an operation switched off, which was held as
        // a dead letter whose try again ran on past their refusal. D-201 Slice
        // 10AK (10AI finding 11) — and an ask that expired, the owner never
        // answering: even with its row left at an earlier ask, whose try
        // again's failure marked it, when the move to this one did not land.
        || (anchor.commit_status === 'failed'
          && options.isHeldFailure?.(dispatch.run_id) === true
          && !(anchor.errors ?? []).some((error) => error.details?.['denied_by'] === 'owner'
            || error.code === 'RECIPE_APPROVAL_TIMEOUT')
          && options.isOwnerRefusal?.(anchor) !== true));
    const resolved = consumerStore.resolveAwaitingApprovalDispatch({
      dispatch_id: dispatch.dispatch_id,
      run_id: dispatch.run_id,
      outcome: succeeded ? 'succeeded' : interrupted ? 'interrupted' : inDoubt ? 'in_doubt' : 'failed',
    });
    if (!resolved) {
      result.waiting += 1;
      continue;
    }
    if (succeeded) result.succeeded += 1;
    else if (interrupted) result.interrupted += 1;
    else if (inDoubt) result.in_doubt += 1;
    else result.failed += 1;
  }
  return result;
};

/** Stable, secret-free identity for one exact run request. A run id is the
 * primary durable key, but a concurrent caller must not be allowed to reuse it
 * for a different recipe or webhook event and inherit the first call's result. */
const requestIdentity = (input: WebhookRecipeRunRequest): string => JSON.stringify([
  input.idempotency_key,
  input.recipe_id,
  input.publisher_id,
  input.context.webhook.kind,
  input.context.webhook.binding,
  input.context.webhook.event_ref,
  input.context.webhook.delivery_ref,
  input.context.webhook.event_id,
  input.context.webhook.ingress_id,
  input.context.webhook.profile_id,
  input.context.webhook.transport_assurance,
  input.context.webhook.source_truth_policy,
  input.context.webhook.provider_event_id,
  input.context.webhook.provider_resource_id,
  input.context.webhook.provider_event_type,
  input.context.webhook.provider_occurred_at,
  input.context.webhook.received_at,
  input.context.webhook.duplicate,
  input.execution_source.channel,
  input.execution_source.actor,
  input.execution_source.vendor,
  input.execution_source.webhook_secret_id,
  // D-209 #1 W3 — the door is part of the request identity: a concurrent caller
  // must not reuse a run id minted under one door for a dispatch under another
  // (or under none) and inherit the first call's result.
  input.execution_source.contract_id ?? null,
]);

export const createExecuteWebhookRecipeRunner = (
  deps: ExecuteWebhookRecipeRunnerDeps,
): WebhookRecipeRunner => {
  const inFlight = new Map<string, {
    identity: string;
    promise: Promise<WebhookRecipeRunResult>;
  }>();
  return {
    run(input) {
      const identity = requestIdentity(input);
      const current = inFlight.get(input.run_id);
      if (current) {
        if (current.identity !== identity) {
          return Promise.reject(
            new Error('webhook recipe runner: concurrent run id collision'),
          );
        }
        return current.promise;
      }
      const pending = runOnce(deps, input).finally(() => {
        if (inFlight.get(input.run_id)?.promise === pending) {
          inFlight.delete(input.run_id);
        }
      });
      inFlight.set(input.run_id, { identity, promise: pending });
      return pending;
    },
  };
};
