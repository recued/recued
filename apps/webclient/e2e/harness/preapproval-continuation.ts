/** Local owner UI fixture. No real execution or provider is installed here. */
import { type PreapprovalContinuationRequest, type PreapprovalDecisionReceipt,
  type PreapprovalInspection, type PreapprovalMemberReview, type PreapprovalReview } from '@recued/contracts';

export const CONTINUATION_PARENT = 'pap_11111111-1111-4111-8111-111111111111';
export const CONTINUATION_CHILD = 'pap_33333333-3333-4333-8333-333333333333';
const PARENT_REF = 'paf_22222222-2222-4222-8222-222222222222';
const CHILD_REF = 'paf_55555555-5555-4555-8555-555555555555';
const KEY = 'recued-test-preapproval-continuation';

export const preapprovalContinuationDemoReply = (method: string, args: unknown):
{ result?: unknown; error?: { code: string; message: string } } | null => {
  const query = new URLSearchParams(location.search);
  if (!['continuation', 'continuation-uncertain'].includes(query.get('preapproval') ?? '')) return null;
  if (method === 'notification.pending_asks') return { result: { asks: [], next_cursor: null } };
  const serverZone = query.get('server_zone');
  if (method === 'server.timezone.get' && serverZone) {
    return { result: { setting: { mode: 'fixed', zone: serverZone, updated_at: 1 }, resolved_zone: serverZone, host_zone: serverZone } };
  }
  if (!method.startsWith('preapproval.')) return null;
  const now = Date.now();
  const state = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as {
    request: PreapprovalContinuationRequest | null; approved: boolean;
  } | null ?? { request: null, approved: false };
  const save = () => sessionStorage.setItem(KEY, JSON.stringify(state));
  const uncertain = query.get('preapproval') === 'continuation-uncertain';
  const member = (id: string, label: string, before: string, after: string): PreapprovalMemberReview => ({
    member_id: id, parent_member_id: null, required_child_ids: [], invocation_path: [], op_id: 'fixture.note.update',
    family: 'kernel', risk: 'write', label, detail: 'The exact remaining change.',
    arguments: { id: 'b', expected_version: 1, expected_revision: 1, set: { title: after } }, output: {},
    connection_id: null, account_id: null, resources: [], conditional: false, eligible: true, reason: null,
    resource_review: { schema_version: 1, operation: 'fixture.note.update', input_hash: 'a'.repeat(64), captured_at: now,
      resources: [{ kind: 'records', key: id, label, binding: 'namespace', version: 'row-v2',
        precondition: { kind: 'records_revision', value: 1, incarnation: 'row-incarnation' },
        before: { title: before }, after: { title: after } }] },
  });
  const completed = member('pam_44444444-4444-4444-8444-444444444444', 'Completed first row', 'First row', 'Saved first row');
  const remaining = member('pam_66666666-6666-4666-8666-666666666666', 'Update remaining row', 'Concurrent row value', 'Reviewed remaining value');
  const child = (args as { proposal_id?: string } | null)?.proposal_id === CONTINUATION_CHILD;
  const proposalId = child ? CONTINUATION_CHILD : CONTINUATION_PARENT, futureRef = child ? CHILD_REF : PARENT_REF;
  const review: PreapprovalReview = {
    proposal_id: proposalId, future_execution_ref: futureRef, revision: 1,
    status: child && !state.approved ? 'awaiting_owner' : 'approved', coverage: 'complete',
    eligible_members: child ? 1 : 2, uncovered_calls: 0,
    review_digest: 'sha256:fixture-continuation', challenge: 'fixture-owner-challenge', challenge_expires_at: now + 300_000,
    requested_through: { contract_id: 'original-contract', display_name: 'Original assistant', credential_label: 'Original credential' },
    recipe: { recipe_id: 'resource-plan', publisher_id: 'core', display_name: 'Reviewed resource changes' },
    activation: child && state.request ? state.request.activation : { kind: 'one_shot', run_at: now - 60_000, time_zone: 'UTC' },
    scheduled_for: child && state.request ? state.request.activation.run_at : now - 60_000, time_zone: state.request?.activation.time_zone ?? 'UTC',
    decision_deadline: state.request?.decision_deadline ?? now - 60_000,
    dispatch_deadline: state.request?.dispatch_deadline ?? now - 30_000,
    members: child ? [remaining] : [completed, remaining], selected_member_ids: child ? [remaining.member_id] : [completed.member_id, remaining.member_id],
    uncovered: [], interaction_notes: ['Each remaining change needs its reviewed version.'],
    ...(child ? { continuation: { proposal_id: CONTINUATION_PARENT, future_execution_ref: PARENT_REF,
      completed: [{ proposal_id: CONTINUATION_PARENT, member_id: completed.member_id, label: completed.label,
        action_ref: 'original-action', commit_id: 'original-commit', run_id: 'original-run' }] } } : {}),
  };
  const receipt: PreapprovalDecisionReceipt = {
    decision_id: 'original-decision', proposal_id: proposalId, future_execution_ref: futureRef, grant_id: 'original-grant',
    proposal_revision: 1, review_digest: review.review_digest, decision: 'approve', decided_at: now - 120_000,
    execution_status: child ? 'active' : uncertain ? 'in_doubt' : 'partial',
  };
  const inspection = (): PreapprovalInspection => {
    const { challenge: _challenge, challenge_expires_at: _expires, ...reviewed } = review;
    return { proposal_id: proposalId, future_execution_ref: futureRef, revision: 1,
      status: review.status, coverage: 'complete', eligible_members: review.eligible_members, uncovered_calls: 0,
      execution_status: child ? state.approved ? 'active' : 'prepared' : uncertain ? 'in_doubt' : 'partial',
      reviewed, status_reason: null, grant: null, decision: child && !state.approved ? null : receipt,
      members: review.members.map((item, index) => ({ member_id: item.member_id, parent_member_id: null,
        ...(!child && index === 0 && query.has('local_receipt') ? { local_receipt: {
          receipt_id: 'lmr_77777777-7777-4777-8777-777777777777', kind: 'records' as const, committed_at: now - 60_000,
        } } : {}),
        op_id: item.op_id, label: item.label, status: child ? 'available' : index === 0 ? 'succeeded' : uncertain ? 'in_doubt' : 'failed',
        action_ref: child ? null : index === 0 ? 'original-action' : 'failed-action', commit_id: child ? null : index === 0 ? 'original-commit' : 'failed-commit',
        run_id: child ? null : 'original-run', status_message: null, reconciled_outcome: null })),
      created_at: now - 120_000, updated_at: now,
      ...(!child ? { recovery: { eligible: !uncertain && !state.request,
        successor_proposal_id: state.request ? CONTINUATION_CHILD : null,
        reason: uncertain ? 'An attempt has an unknown outcome. Verified reconciliation is required before another review can continue it.' : null } } : {}),
    };
  };
  if (method === 'preapproval.get') return { result: inspection() };
  if (method === 'preapproval.list') return { result: { proposals: [inspection()], next_cursor: null } };
  if (method === 'preapproval.review') return { result: review };
  if (method === 'preapproval.continue') {
    if (uncertain) return { error: { code: 'preapproval_in_doubt', message: 'Verified reconciliation is required.' } };
    const attempts = JSON.parse(sessionStorage.getItem(KEY + '-attempts') ?? '[]') as unknown[];
    attempts.push(args); sessionStorage.setItem(KEY + '-attempts', JSON.stringify(attempts));
    state.request ??= args as PreapprovalContinuationRequest; save();
    if (query.get('continuation_reply') === 'lost' && attempts.length === 1) return {
      error: { code: 'UNAVAILABLE', message: 'Continuation response was lost. Retry or refresh to open the saved review.' },
    };
    return { result: { proposal_id: CONTINUATION_CHILD, future_execution_ref: CHILD_REF, revision: 1,
      status: 'awaiting_owner', coverage: 'complete', eligible_members: 1, uncovered_calls: 0 } };
  }
  if (method === 'preapproval.decide') { state.approved = true; save(); return { result: receipt }; }
  return { error: { code: 'preapproval_unsupported', message: 'Unsupported continuation fixture call.' } };
};
