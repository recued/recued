/** D-201 Slices 5A/5B2A — production recipe runner and approval reconciler.
 *
 * The consumer store supplies a stable run id. This adapter collapses concurrent
 * in-process retries, reuses an already-succeeded durable audit anchor, and
 * re-enters a retryable failed run under the same id, and hands approval pauses
 * to durable dispatch state. Other live/ambiguous states stay fail-closed: they
 * are never converted into a second run identity.
 */

import type { AuditLogStore } from '@recued/storage';
import {
  contractPermitsDoorType,
  isContractActive,
  type RecipeDefinition,
} from '@recued/contracts';
import { handleExecute, type ExecuteHandlerDeps } from './execute-handler.js';
import type {
  WebhookRecipeRunResult,
  WebhookRecipeRunner,
  WebhookRecipeRunRequest,
} from './webhook-recipe-consumer.js';
import {
  deriveResolvedRecipeCapability,
  type OpResolver,
} from './derive-recipe-capability.js';
import { doorCapabilityChanged } from './mint-door-contract.js';
import type { DoorRecipeResolver } from './recipe-capability-wiring.js';
import type { WebhookConsumerStore } from './storage/webhook-consumer-store.js';
import type { ContractDefinitionStore } from './storage/contract-definition-store.js';
import { buildWebhookContractSnapshot } from './webhook-contract-snapshot.js';

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

const runOnce = async (
  deps: ExecuteWebhookRecipeRunnerDeps,
  input: WebhookRecipeRunRequest,
): Promise<WebhookRecipeRunResult> => {
  assertTargetStillMatches(deps, input);
  const existing = await deps.auditLog.get(input.run_id);
  if (existing) {
    if (existing.trigger_source !== 'webhook') {
      throw new Error('webhook recipe runner: run id belongs to a non-webhook run');
    }
    if (existing.recipe_id !== input.recipe_id) {
      throw new Error('webhook recipe runner: run id belongs to another recipe');
    }
    if (existing.commit_status === 'succeeded') return 'completed';
    if (existing.commit_status === 'awaiting_approval') {
      return 'awaiting_approval';
    }
    // An owner denial (including approval-time authority revocation) is a
    // durable terminal refusal, not a failed execution that the outbox may
    // re-enter. This also closes the crash window between the approval core's
    // terminal audit write and the webhook store's wait-marker handoff.
    if (existing.commit_status === 'failed'
      && (existing.errors ?? []).some((error) =>
        error.code === 'RECIPE_POLICY_DENIED' && error.retryable === false)) {
      return 'terminal_non_success';
    }
    // A terminal cancellation, kill, or in-doubt result must never burn the
    // delivery outbox retry budget. This is especially important in the narrow
    // crash window after an approval decision but before the wait marker lands:
    // the durable audit result closes the original target without re-execution.
    if (existing.commit_status === 'cancelled'
      || existing.commit_status === 'killed'
      || existing.commit_status === 'in_doubt') {
      return 'terminal_non_success';
    }
    // A failed run is the one safe terminal state the internal retry loop may
    // re-enter. Fixed run/commit identities let the gateway collapse repeated
    // provider side effects; all other states need owner/reconciler handling.
    if (existing.commit_status !== 'failed') {
      throw new Error(
        `webhook recipe runner: run is not retryable (${existing.commit_status})`,
      );
    }
  }

  // Resolved fresh on every (re-)entry: a retry of a failed anchor runs with the
  // install config as it stands NOW, exactly like a fresh fire would.
  const recipe = assertTargetStillMatches(deps, input);
  const config = deps.resolveConfig(input.recipe_id);
  // Current production wiring always supplies the exact door resolver. Under that wiring,
  // an unstamped, dead, or cross-class door is a terminal non-success before execution.
  // An empty snapshot only fences ingredient calls; a pure-transform recipe could otherwise
  // report success and silently consume the event after its door was revoked.
  if (deps.resolveDoorRecipe !== undefined) {
    const contractId = input.execution_source.contract_id;
    if (contractId === undefined) return 'terminal_non_success';
    const currentDoor = deps.definitionStore.get(contractId);
    if (
      currentDoor === null
      || !isContractActive(currentDoor, (deps.now ?? Date.now)())
      || !contractPermitsDoorType(currentDoor, 'webhook')
    ) {
      return 'terminal_non_success';
    }
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
      })
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
    const derived = deriveResolvedRecipeCapability(recipe, dispatchRecipe.recipe, {
      ...(config === undefined ? {} : { config }),
      ...(resolveOp === undefined ? {} : { resolveOp }),
    });
    if (!derived.ok || doorCapabilityChanged(storedDoor, derived.capability).changed) {
      throw new Error('webhook recipe runner: door authority changed; re-save the recipe');
    }
  }
  const result = await handleExecute(deps.executeDeps, {
    recipe_id: input.recipe_id,
    context: input.context,
    ...(config === undefined ? {} : { config }),
    ...(contract_snapshot === undefined ? {} : { contract_snapshot }),
    trigger_source: 'webhook',
    execution_source: input.execution_source,
  }, { run_id: input.run_id });
  if (!result.success) {
    if (result.awaiting_approval) return 'awaiting_approval';
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
}

const APPROVAL_RECONCILIATION_BATCH_SIZE = 25;

/** Fold terminal decisions written by the shared approval resumer back into
 * webhook-owned dispatch state. The audit anchor is authoritative for run
 * outcome; the wait table is authoritative for whether this webhook target is
 * still entitled to retain its decoded-payload pin. */
export const reconcileWebhookAwaitingApprovalDispatches = async (
  consumerStore: Pick<
    WebhookConsumerStore,
    'takeAwaitingApprovalDispatches' | 'resolveAwaitingApprovalDispatch'
  >,
  auditLog: Pick<AuditLogStore, 'get'>,
): Promise<WebhookApprovalReconciliationResult> => {
  const waitingDispatches = consumerStore.takeAwaitingApprovalDispatches(
    APPROVAL_RECONCILIATION_BATCH_SIZE,
  );
  const result: WebhookApprovalReconciliationResult = {
    scanned: waitingDispatches.length,
    waiting: 0,
    succeeded: 0,
    failed: 0,
  };
  for (const dispatch of waitingDispatches) {
    const anchor = await auditLog.get(dispatch.run_id);
    const anchorMatches = anchor !== null
      && anchor.trigger_source === 'webhook'
      && anchor.recipe_id === dispatch.recipe_id;
    if (anchor !== null
      && anchorMatches
      && (anchor.commit_status === 'awaiting_approval'
        || anchor.commit_status === 'pending'
        || anchor.commit_status === 'running')) {
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
    const resolved = consumerStore.resolveAwaitingApprovalDispatch({
      dispatch_id: dispatch.dispatch_id,
      run_id: dispatch.run_id,
      outcome: succeeded ? 'succeeded' : 'failed',
    });
    if (!resolved) {
      result.waiting += 1;
      continue;
    }
    if (succeeded) result.succeeded += 1;
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
