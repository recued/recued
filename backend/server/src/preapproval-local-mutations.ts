import type { LocalMutationReceiptSummary } from '@recued/contracts';
import type { PreparedFutureExecution, PreparedInvocation } from './preapproval-model.js';
import { preapprovalHash } from './preapproval-invocations.js';
import type { LocalMutationReceiptBinding } from './storage/local-mutation-receipts.js';

export const preapprovalLocalMutationKind = (member: PreparedInvocation): LocalMutationReceiptSummary['kind'] | null => {
  const resources = member.resource_review?.resources;
  if (member.family !== 'kernel' || !resources?.length) return null;
  if (resources.every(resource => resource.kind === 'records')) return 'records';
  return resources.length === 1 && resources[0]!.kind === 'calendar'
    && resources[0]!.precondition.kind === 'local_version'
    && ['calendar-update', 'calendar-delete'].includes(member.ingredient_slug) ? 'local_calendar' : null;
};

/** Stable across worker recovery, never across a different attempt, source,
 * sealed plan or restored realm. Worker/fence ownership is checked at write. */
export const preapprovalLocalMutationBinding = (plan: PreparedFutureExecution, member: PreparedInvocation,
  execution: { future_ref: string; root_run_id: string | null; snapshot_hash: string; lineage: string },
  row: { grant_id: string; member_id: string; attempt_id: string | null; idempotency_key: string | null;
    action_ref: string | null; commit_id: string | null; actual_run_id: string | null; parent_attempt_id: string | null }):
LocalMutationReceiptBinding | null => {
  const kind = preapprovalLocalMutationKind(member);
  if (!kind || !execution.root_run_id || !row.attempt_id || !row.idempotency_key || !row.action_ref
    || !row.commit_id || !row.actual_run_id || row.member_id !== member.member_id) return null;
  return { owner: 'preapproval_member', owner_ref: row.action_ref, attempt_id: row.attempt_id,
    operation: member.op_id, kind, review_hash: preapprovalHash(member.resource_review),
    identity_hash: preapprovalHash({ execution: { future_ref: execution.future_ref, root_run_id: execution.root_run_id,
      snapshot_hash: execution.snapshot_hash, lineage: execution.lineage },
      attempt: { grant_id: row.grant_id, member_id: row.member_id, attempt_id: row.attempt_id, idempotency_key: row.idempotency_key,
        action_ref: row.action_ref, commit_id: row.commit_id, run_id: row.actual_run_id, parent_attempt_id: row.parent_attempt_id },
      source: plan.origin, effect_hash: member.effect_hash }),
  };
};
