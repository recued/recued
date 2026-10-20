/** A continuation is a new owner review of an exact subset of the saved
 * program. No engine/provider invocation, replayed result or AI rewriting. */
import { RpcError, isRecordsExecutionBinding, parsePreapprovalJson,
  type PreapprovalMemberOutcome, type PreapprovalJson } from '@recued/contracts';
import { preapprovalHash } from './preapproval-invocations.js';
import type { PreparedFutureExecution } from './preapproval-model.js';
import type { PreapprovalRecipeSource } from './preapproval-prepare.js';
import type { ServerExecutorConfig } from './server-executor.js';
import type { RecordsStore } from './records/store.js';
import { supportsPreapprovalMailProof } from './preapproval-mail-attempt.js';

export const continuationShapeReason = (plan: PreparedFutureExecution, selected: readonly string[]): string | null => {
  const root = plan.recipe_snapshots[0];
  if (plan.request.subject.kind !== 'recipe' || plan.recipe_snapshots.length !== 1 || !root
    || plan.uncovered.length !== 0 || selected.length !== plan.members.length
    || plan.members.some(member => !selected.includes(member.member_id))) {
    return 'Continuation requires a fully reviewed resource plan. Uncovered or unselected calls need a separate review.';
  }
  if (root.definition.prefetch_steps?.length || root.definition.trigger_steps?.length
    || root.definition.steps.length !== plan.members.length
    || plan.members.some((member, index) => {
      const step = root.definition.steps[index];
      const path = member.invocation_path;
      return !step || !('ingredient' in step) || (!member.resource_review
          && !(member.ingredient_slug === 'mail-send' && supportsPreapprovalMailProof(member.input)))
        || member.parent_member_id !== null || member.required_child_ids.length !== 0
        || path.length !== 2 || path[1]?.kind !== 'step' || path[1].phase !== 'sequential' || path[1].step_id !== step.id
        || member.review.conditional || step.foreach != null || step.skip_when != null || step.fail_on != null
        || step.stop_when != null || step.optional === true
        || (Array.isArray(step.pii_fields) && step.pii_fields.length > 0);
    })) return 'Continuation currently supports sequential Calendar, Records and plain mail changes without loops, branches, optional steps or required child calls.';
  return null;
};

export const effectiveContinuationOutcome = (member: PreapprovalMemberOutcome): 'succeeded' | 'failed' | 'unfinished' | 'uncertain' =>
  member.status === 'succeeded' || member.reconciled_outcome === 'succeeded' ? 'succeeded'
    : member.status === 'in_doubt' ? member.reconciled_outcome === 'failed' ? 'failed' : 'uncertain'
    : member.status === 'dispatching' ? 'uncertain'
    : member.status === 'failed' ? 'failed' : 'unfinished';

export const projectContinuationSource = (source: PreapprovalRecipeSource,
  continuation: NonNullable<PreparedFutureExecution['continuation']>): PreapprovalRecipeSource => {
  if (preapprovalHash(source.definition) !== continuation.source_definition_hash) {
    throw new RpcError('preapproval_stale', 'The original recipe changed. Prepare a new full review.', 409);
  }
  const definition = { ...structuredClone(source.definition), prefetch_steps: [],
    steps: continuation.steps.map(item => structuredClone(item.step)), output: { sidebar: [] } };
  delete definition.trigger_steps;
  delete definition.auto_run;
  return {
    publisher_id: source.publisher_id,
    // Settings and arguments are frozen from the original execution. A new
    // default dish must not replace them while preparing the successor.
    dependencies: source.dependencies.filter(pin => pin.kind === 'recipe'),
    definition,
  };
};

export const buildPreapprovalContinuation = (source: {
  plan: PreparedFutureExecution; outcomes: PreapprovalMemberOutcome[]; snapshot_hash: string;
  outcomes_hash: string; future_execution_ref: string;
}, proposalId: string, deps: { executor: ServerExecutorConfig; records?: RecordsStore }):
NonNullable<PreparedFutureExecution['continuation']> => {
  const parent = source.plan;
  const continuation: NonNullable<PreparedFutureExecution['continuation']> = {
    proposal_id: proposalId, future_execution_ref: source.future_execution_ref,
    snapshot_hash: source.snapshot_hash, outcomes_hash: source.outcomes_hash,
    source_definition_hash: parent.continuation?.source_definition_hash ?? parent.recipe.definition_hash,
    completed: [...structuredClone(parent.continuation?.completed ?? []), ...source.outcomes
      .filter(member => effectiveContinuationOutcome(member) === 'succeeded').map(member => ({
        proposal_id: proposalId, member_id: member.member_id, label: member.label,
        action_ref: member.action_ref!, commit_id: member.commit_id, run_id: member.run_id ?? null,
      }))],
    steps: [],
  };
  for (let index = 0; index < parent.members.length; index++) {
    const member = parent.members[index]!;
    const outcome = source.outcomes.find(item => item.member_id === member.member_id)!;
    if (effectiveContinuationOutcome(outcome) === 'succeeded') continue;
    const original = parent.recipe_snapshots[0]!.definition.steps[index]!;
    const manifest = deps.executor.manifests.get(member.ingredient_slug);
    if (!manifest || preapprovalHash(manifest) !== member.definition_hash) {
      throw new RpcError('preapproval_stale', 'An original operation definition changed. Prepare a new full review.', 409);
    }
    const review = member.resource_review;
    let input: Record<string, PreapprovalJson>;
    if (member.ingredient_slug === 'mail-send' && supportsPreapprovalMailProof(member.input)) {
      input = structuredClone(member.input);
    } else if (review && review.resources.every(resource => resource.kind === 'records')) {
      const raw = 'input' in original ? original.input : undefined;
      const key = raw && typeof raw === 'object' && !Array.isArray(raw) && 'operation' in raw ? raw.operation : undefined;
      const binding = typeof key === 'string' ? manifest.surfaces?.records?.executes?.[key] : undefined;
      if (!isRecordsExecutionBinding(binding) || !deps.records || typeof key !== 'string'
        || manifest.operations?.[key]?.operation_id !== member.op_id) {
        throw new RpcError('preapproval_unsupported', 'The original Records mutation is unavailable.', 409);
      }
      input = { operation: key, args: parsePreapprovalJson(deps.records.rebaseMutation(binding, member.input, review.resources)) };
    } else {
      if (!review || !['calendar-update', 'calendar-delete'].includes(member.ingredient_slug)) {
        throw new RpcError('preapproval_unsupported', 'This resource mutation cannot be continued.', 409);
      }
      const fresh = deps.executor.resourceReview?.capture(member.ingredient_slug, member.input);
      if (!fresh || fresh.resources.length !== 1 || fresh.resources[0]!.binding !== review.resources[0]!.binding
        || fresh.resources[0]!.key !== review.resources[0]!.key) {
        throw new RpcError('preapproval_stale', 'The original Calendar account or target changed. Prepare a new full review.', 409);
      }
      input = structuredClone(member.input);
    }
    continuation.steps.push({ original_member_id: member.member_id, step: {
      id: original.id, ingredient: member.ingredient_slug, input, output: structuredClone(member.output),
    } });
  }
  return continuation;
};
