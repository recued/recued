/** Transport-only owner fixture. SQLite tests establish atomicity and authority. */
import type { LocalChangeSetInspection, LocalChangeSetReview, LocalChangeSetDecision,
  PreapprovalReview, PreapprovalInspection } from '@recued/contracts';

export const ATOMIC_SOURCE = 'pap_33333333-3333-4333-8333-333333333333';
export const ATOMIC_SET = 'lcs_11111111-1111-4111-8111-111111111111';
export const ATOMIC_UNDO = 'lcs_22222222-2222-4222-8222-222222222222';
export const localChangesDemoReply = (method: string, args: unknown): { result?: unknown; error?: { code: string; message: string } } | null => {
  const query = new URLSearchParams(location.search);
  if (!query.has('local_changes')) return null;
  if (!method.startsWith('local_changes.') && !['preapproval.get','preapproval.review','preapproval.list'].includes(method)) return null;
  const now = Date.now(), key = 'recued-test-local-changes';
  const review: LocalChangeSetReview = { change_set_id: ATOMIC_SET,source_proposal_id: ATOMIC_SOURCE,undo_of: null,
    title: 'Update records and meeting',requested_through: 'Original assistant',review_hash: 'sha256:' + 'a'.repeat(64),expires_at: now + 600_000,
    changes: [{ member_id: 'records_a',label: 'Update note a',resource_review: { schema_version: 1,operation: 'fixture.note.update',
      input_hash: 'b'.repeat(64),captured_at: now,resources: [{ kind: 'records',key: 'a',label: 'Note a',binding: 'namespace',version: 'row-0',
        precondition: { kind: 'records_revision',value: 0,incarnation: 'row-a' },before: { title: 'Original note' },after: { title: 'Reviewed note' } }] } },
    { member_id: 'calendar_a',label: 'Move meeting',resource_review: { schema_version: 1,operation: 'calendar-update',input_hash: 'c'.repeat(64),captured_at: now,
      resources: [{ kind: 'calendar',key: 'meeting',label: 'Meeting',binding: 'calendar',version: 'event-0',precondition: { kind: 'local_version',value: 'event-0' },
        before: { summary: 'Original meeting',location: null },after: { summary: 'Reviewed meeting',location: 'New room' } }] } }] };
  const records = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Record<string,LocalChangeSetInspection>;
  const save = () => sessionStorage.setItem(key,JSON.stringify(records));
  const source: PreapprovalReview = { proposal_id: ATOMIC_SOURCE,future_execution_ref: 'paf_fixture',revision: 1,status: 'awaiting_owner',coverage: 'complete',
    eligible_members: 2,uncovered_calls: 0,review_digest: 'sha256:' + 'd'.repeat(64),challenge: 'fixture-owner',challenge_expires_at: now + 600_000,
    requested_through: { contract_id: 'ct_assistant',display_name: 'Original assistant',credential_label: 'Paired fixture' },
    recipe: { recipe_id: 'atomic-fixture',publisher_id: 'core',display_name: review.title },
    activation: { kind: 'one_shot',run_at: now + 60_000,time_zone: 'UTC' },scheduled_for: now + 60_000,time_zone: 'UTC',
    decision_deadline: now + 600_000,dispatch_deadline: now + 900_000,
    members: review.changes.map(change => ({ member_id: change.member_id,parent_member_id: null,required_child_ids: [],invocation_path: [],
      op_id: change.resource_review.operation,family: 'kernel',risk: 'write',label: change.label,detail: 'Exact local changes.',arguments: {},output: {},
      connection_id: null,account_id: null,resources: [],conditional: false,eligible: true,reason: null,resource_review: change.resource_review })),
    selected_member_ids: review.changes.map(change => change.member_id),uncovered: [],interaction_notes: [] };
  if (method === 'preapproval.review') return { result: source };
  if (method === 'preapproval.get' || method === 'preapproval.list') {
    const { challenge: _challenge,challenge_expires_at: _expires,...retained } = source;
    const item: PreapprovalInspection = { proposal_id: ATOMIC_SOURCE,revision: 1,future_execution_ref: source.future_execution_ref,status: 'awaiting_owner',
      coverage: 'complete',eligible_members: 2,uncovered_calls: 0,execution_status: 'prepared',status_reason: null,grant: null,decision: null,
      created_at: now - 1000,updated_at: now,reviewed: retained,members: source.members.map(member => ({ member_id: member.member_id,
        parent_member_id: null,op_id: member.op_id,label: member.label,status: 'available',action_ref: null,commit_id: null,run_id: null,status_message: null,reconciled_outcome: null })) };
    return { result: method === 'preapproval.get' ? item : { proposals: [item],next_cursor: null } };
  }
  const input = args as { change_set_id?: string; decision?: LocalChangeSetDecision['decision'] };
  if (method === 'local_changes.prepare') {
    records[ATOMIC_SET] ??= { change_set_id: ATOMIC_SET,source_proposal_id: ATOMIC_SOURCE,undo_of: null,status: 'pending',created_at: now,
      decided_at: null,receipts: [],undo_available: false,undo_change_set_id: null,review };
    save(); return { result: records[ATOMIC_SET] };
  }
  if (!records[ATOMIC_SET] && query.get('local_changes') === 'direct') {
    records[ATOMIC_SET] = { change_set_id: ATOMIC_SET,source_proposal_id: ATOMIC_SOURCE,undo_of: null,status: query.get('atomic') === 'expired' ? 'expired' : 'pending',
      created_at: now,decided_at: null,receipts: [],undo_available: false,undo_change_set_id: null,review }; save();
  }
  if (method === 'local_changes.list') return { result: { items: Object.values(records),next_cursor: null } };
  const row = records[input.change_set_id ?? ''];
  if (!row) return { error: { code: 'local_changes_conflict',message: 'Unknown local change set.' } };
  if (method === 'local_changes.get') return { result: row };
  if (method === 'local_changes.prepare_undo') {
    const reverse: LocalChangeSetReview = { ...structuredClone(review),change_set_id: ATOMIC_UNDO,source_proposal_id: null,undo_of: ATOMIC_SET,
      title: 'Undo local change set',requested_through: 'You',review_hash: 'sha256:' + 'e'.repeat(64),
      changes: [...review.changes].reverse().map(change => ({ ...change,resource_review: { ...change.resource_review,
        resources: change.resource_review.resources.map(resource => ({ ...resource,before: resource.after!,after: resource.before })) } })) };
    records[ATOMIC_UNDO] ??= { change_set_id: ATOMIC_UNDO,source_proposal_id: null,undo_of: ATOMIC_SET,status: 'pending',created_at: now,
      decided_at: null,receipts: [],undo_available: false,undo_change_set_id: null,review: reverse }; save(); return { result: records[ATOMIC_UNDO] };
  }
  if (method === 'local_changes.decide') {
    const attempts = JSON.parse(sessionStorage.getItem(key + '-attempts') ?? '[]') as LocalChangeSetDecision[];
    attempts.push(args as LocalChangeSetDecision); sessionStorage.setItem(key + '-attempts',JSON.stringify(attempts));
    if (query.get('atomic') === 'not_received') return { error: { code: 'UNAVAILABLE',message: 'The decision request was not delivered.' } };
    row.status = input.decision === 'deny' ? 'denied' : query.get('atomic') === 'conflict' ? 'failed' : query.get('atomic') === 'unknown' ? 'unknown' : 'completed';
    row.decided_at = now;
    if (row.status === 'completed') {
      row.receipts = [{ member_id: 'records_a',local_receipt: { receipt_id: row.undo_of ? 'lmr_40000000-0000-4000-8000-000000000001' : 'lmr_30000000-0000-4000-8000-000000000001',kind: 'records',committed_at: now } },
        { member_id: 'calendar_a',local_receipt: { receipt_id: row.undo_of ? 'lmr_40000000-0000-4000-8000-000000000002' : 'lmr_30000000-0000-4000-8000-000000000002',kind: 'local_calendar',committed_at: now } }];
      row.undo_available = !row.undo_of;
      if (row.undo_of) { records[row.undo_of]!.undo_available = false; records[row.undo_of]!.undo_change_set_id = row.change_set_id; }
    }
    delete row.review; save();
    if (query.get('atomic') === 'conflict') return { error: { code: 'resource_conflict',message: 'A member changed after review. The entire transaction rolled back.' } };
    if (query.get('atomic') === 'lost' && attempts.length === 1) return { error: { code: 'UNAVAILABLE',message: 'The decision response was lost. Check the result.' } };
    return { result: row };
  }
  return null;
};
