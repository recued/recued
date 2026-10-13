import type Database from 'better-sqlite3';
import { RpcError, type ApprovalWorkflowContinueInput } from '@recued/contracts';
import { createApprovalWorkflowService, type ApprovalWorkflowService, type ApprovalWorkflowServiceDeps } from './approval-workflow-service.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { handleExecute } from './execute-handler.js';
import { createWorkEntityStore } from './storage/work-entity-store.js';
import { createPublicEndpointRegistryStore } from './storage/public-endpoint-registry-store.js';
import { createReceptionApprovalIntentStore } from './storage/reception-approval-store.js';
import { composeInstallConfigResolver, composeInstallConnectionsResolver } from './recipe-capability-wiring.js';
import type { ReceptionApprovalEffect } from './ports/reception/processors/approval-link-processor.js';
import type { FireReceptionWorkflow } from './ports/reception/reception-drain.js';

interface ApprovalWorkflowOptions {
  now?: () => number;
  resolved?: ApprovalWorkflowServiceDeps['resolved'];
}

/** Both the authoring/drain and approved kernel leg use the same snapshot rules. */
export const composeApprovalWorkflowService = (db: Database.Database, execute: ExecuteHandlerDeps,
  options: ApprovalWorkflowOptions = {}) => {
  const configOf = composeInstallConfigResolver(execute.dishStore);
  const connectionsOf = composeInstallConnectionsResolver(execute.dishStore);
  return createApprovalWorkflowService({ db, work: createWorkEntityStore(db), recipes: execute.recipeStore,
    endpoints: createPublicEndpointRegistryStore(db), intents: createReceptionApprovalIntentStore(db),
    now: options.now ?? Date.now, ...(options.resolved ? { resolved: options.resolved } : {}),
    recipeSnapshot: (id) => {
      const recipe = execute.recipeStore.get(id);
      if (!recipe) throw new RpcError('approval_workflow_invalid', 'The selected recipe is no longer installed.', 409);
      return { recipe, config: configOf(id) ?? {}, connections: { ...connectionsOf(id)?.choices } };
    },
    runRecipe: async (snapshot, runId) => {
      // The child has its own engine run and operation gates. It receives only
      // owner-saved settings; the visitor cannot supply config, credentials or grants.
      const previous = await execute.auditLog?.get(runId);
      if (previous) throw new RpcError('approval_workflow_invalid', 'This recipe run already exists. Review it in Runs.', 409);
      const result = await handleExecute(execute, { recipe: snapshot.recipe, config: snapshot.config,
        connections: snapshot.connections, trigger_source: 'reactive',
        execution_source: { channel: 'reactive', actor: 'system', event_kind: 'reception.approval.accepted',
          source_recipe: 'reception-approval-workflow' } }, { run_id: runId });
      if (!result.success && !result.awaiting_approval) {
        throw new RpcError('approval_workflow_failed', 'The approved recipe could not start. Review its run in Runs.', 409);
      }
    },
  });
};

/** Late binding lets the approved kernel leg use the live executor after boot. */
export const composeApprovalWorkflowContinuation = (db: Database.Database,
  getExecute: () => ExecuteHandlerDeps | undefined, options: ApprovalWorkflowOptions = {}) =>
  async (input: ApprovalWorkflowContinueInput) => {
    const execute = getExecute();
    if (!execute) throw new RpcError('not_configured', 'Workflow approval execution is unavailable.', 503);
    return composeApprovalWorkflowService(db, execute, options).continue(input);
  };

/** Customer acceptance hands off to the held workflow; it never runs the target. */
export const composeApprovalWorkflowResponse = (getService: () => ApprovalWorkflowService,
  fire: FireReceptionWorkflow | undefined) => async (effect: ReceptionApprovalEffect) => {
  const continuation = getService().recordResponse(effect);
  if (continuation === undefined || continuation !== null && !fire) return { dispatched: false };
  if (continuation === null) return { dispatched: true };
  return fire!({ kind: 'approval_workflow', payload: { ...continuation },
    source_ref: effect.intent_id, endpoint_id: effect.endpoint_id });
};
