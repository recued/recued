/** UI-only fixture. Server tests separately prove authenticated decisions,
 * same-DB claims, HTTP execution and lifecycle behavior. */
import { PREAPPROVAL_LIMITS, PREAPPROVAL_PROTOCOL_VERSION } from '@recued/contracts';
import type { MailDraft, PreapprovalCapabilities, PreapprovalDecisionReceipt, PreapprovalInspection, PreapprovalMemberReview, PreapprovalReview } from '@recued/contracts';

const KEY = 'recued-test-preapproval';
export const preapprovalDemoReply = (method: string, args: unknown): {
  result?: unknown; error?: { code: string; message: string };
} | null => {
  const query = new URLSearchParams(location.search);
  // Automation reads capabilities even when this scenario has no owner-review
  // fixture. Answer with an empty set so its rule lists can finish loading.
  if (method === 'preapproval.capabilities') {
    const enabled = query.has('preapproval');
    return { result: {
      protocol_version: PREAPPROVAL_PROTOCOL_VERSION,
      activation_kinds: enabled
        ? ['one_shot', 'next_schedule', 'next_auto_run', 'next_trigger']
        : [],
      bindings: enabled
        ? [{ family: 'kernel', identity_version: 1 }, { family: 'http', identity_version: 1 }]
        : [],
      child_calls: enabled ? ['mail_attachments'] : [],
      decision_channels: enabled ? ['webclient'] : [],
      limits: { ...PREAPPROVAL_LIMITS },
    } satisfies PreapprovalCapabilities };
  }
  if (!query.has('preapproval')) return null;
  if (query.has('mail_drafts') && method === 'collection.mail.list') return { result: { instances: [{ slug: 'work', adapter_type: 'imap',
    send_capable: true, account_email: 'owner@example.test' }] } };
  const drafts = JSON.parse(sessionStorage.getItem(`${KEY}-drafts`) ?? '[]') as MailDraft[];
  const draftKeys = JSON.parse(sessionStorage.getItem(`${KEY}-draft-keys`) ?? '{}') as Record<string, string>;
  const input = (args ?? {}) as Record<string, unknown>;
  if (method.startsWith('mail.drafts.')) {
    const row = drafts.find(draft => draft.draft_id === input.draft_id);
    if (method === 'mail.drafts.list') return { result: { drafts: drafts.map(({ content, ...draft }) => ({ ...draft,
      subject: content.subject, sender_mail_instance: content.sender_mail_instance })), next_cursor: null } };
    if (method === 'mail.drafts.get') return row ? { result: row } : { error: { code: 'mail_draft_not_found', message: 'Draft missing' } };
    if (method === 'mail.drafts.delete' && row) drafts.splice(drafts.indexOf(row), 1);
    if (method === 'mail.drafts.update' && row) { row.content = input.content as MailDraft['content']; row.revision++; }
    let created: MailDraft | undefined;
    if (method === 'mail.drafts.create') {
      const key = input.idempotency_key as string;
      created = drafts.find(draft => draft.draft_id === draftKeys[key]);
      if (!created) {
        created = { draft_id: `mad_${crypto.randomUUID()}`, incarnation: 'browser-draft', revision: 1,
          origin_contract_id: null, content: input.content as MailDraft['content'], created_at: Date.now(), updated_at: Date.now() };
        drafts.push(created); draftKeys[key] = created.draft_id;
      }
      sessionStorage.setItem(`${KEY}-draft-keys`, JSON.stringify(draftKeys));
    }
    sessionStorage.setItem(`${KEY}-drafts`, JSON.stringify(drafts));
    if (query.get('draft_reply') === 'lost' && (method === 'mail.drafts.create' || method === 'mail.drafts.update')
      && !sessionStorage.getItem(`${KEY}-draft-reply-lost`)) {
      sessionStorage.setItem(`${KEY}-draft-reply-lost`, '1'); return { error: { code: 'UNAVAILABLE', message: 'Draft response was lost. Retry saving.' } };
    }
    return { result: method === 'mail.drafts.delete' ? { deleted: true } : row ?? created };
  }
  if (!method.startsWith('preapproval.') && method !== 'notification.pending_asks'
    && !(method === 'auto_run.list' && query.has('run_palette'))
    && !(query.has('preapproval_automation') && (method === 'schedules.list' || method === 'triggers.list'))) return null;
  const now = Date.now();
  const makeMember = (
    id: string, label: string, op: string,
    risk: PreapprovalMemberReview['risk'], input: PreapprovalMemberReview['arguments'],
  ): PreapprovalMemberReview => ({
    member_id: id, parent_member_id: null, required_child_ids: [], invocation_path: [], op_id: op,
    family: 'kernel', risk, label, detail: 'The exact saved version.', arguments: input, output: {},
    connection_id: 'account-alex', account_id: 'sender@example.test', resources: [], conditional: false, eligible: true, reason: null,
  });
  const send = makeMember('pam_send', 'Send reviewed email', 'core.mail.send', 'write', {
    to: ['alex@example.test'], subject: 'Quarterly report', body: 'Reviewed <img src=x onerror=alert(1)> content',
  });
  const read = makeMember('pam_read', 'report.pdf', 'core.storage.data-file-read', 'read', { file_ref: 'file:report-version-1', version: 1 });
  send.required_child_ids = [read.member_id]; read.parent_member_id = send.member_id;
  const http = makeMember('pam_http', 'Record delivery', 'test/crm.record', 'write', { status: 'scheduled', method: 'POST' }); http.family = 'http';
  const initial: PreapprovalReview = { proposal_id: 'pap_browser', future_execution_ref: 'paf_browser', revision: 1,
    status: 'awaiting_owner', coverage: 'complete', eligible_members: 3, uncovered_calls: 0,
    review_digest: 'sha256:browser', challenge: 'owner-browser-challenge', challenge_expires_at: now + 300_000,
    requested_through: { contract_id: 'ct_assistant', display_name: 'Scheduling assistant', credential_label: 'Office MCP client' },
    recipe: { recipe_id: 'reviewed-mail', publisher_id: 'core', display_name: 'Send the quarterly report' },
    activation: { kind: 'one_shot', run_at: now + 600_000, time_zone: 'UTC' }, scheduled_for: now + 600_000, time_zone: 'UTC',
    decision_deadline: now + 300_000, dispatch_deadline: now + 900_000, members: [send, read, http],
    selected_member_ids: [send.member_id, read.member_id, http.member_id], uncovered: [], interaction_notes: [] };
  const state = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as {
    review: PreapprovalReview; decision: PreapprovalDecisionReceipt | null; revoked: boolean;
  } | null ?? { review: initial, decision: null, revoked: false };
  const save = () => sessionStorage.setItem(KEY, JSON.stringify(state));
  const review = state.review;
  if (method === 'schedules.list' || method === 'triggers.list') {
    const expectedKind = method === 'schedules.list' ? 'next_schedule' : 'next_trigger';
    const common = { recipe_id: 'autorun-live-1', publisher_id: 'recued-core', enabled: !!state.decision && !state.revoked,
      created_at: now - 1_000, lifecycle_revision: 7, last_error: null,
      ...(state.decision && review.activation.kind === expectedKind ? { preapproval: { proposal_id: review.proposal_id,
        future_execution_ref: review.future_execution_ref, execution_status: state.revoked ? 'cancelled' : 'active' } } : {}),
    };
    return method === 'schedules.list' ? { result: { schedules: [{ ...common, schedule_id: 'browser-schedule',
      cron_expression: '0 9 * * 1', last_run_at: null, last_status: null, next_run_at: now + 7 * 86_400_000 }] } }
      : { result: { triggers: [{ ...common, trigger_id: 'browser-trigger', pattern: 'data.mail.work.message.created', last_fired_at: null }] } };
  }
  if (method === 'auto_run.list') return { result: { entries: [{
    // D-319 — a timer is one dish's.
    recipe_id: 'autorun-live-1', publisher_id: 'recued-core', dish_id: 'dsh_autorun-live-1', dish_name: '',
    recipe_name: 'Watch pipeline', interval_ms: 60_000,
    dynamic: false, enabled: state.decision?.decision === 'approve' && !state.revoked, auto_disabled: false,
    consecutive_failures: 0, last_failure_at: null, last_failure_reason: null, next_run_at: null,
    last_started_at: null, last_finished_at: null, config_overlay: {}, variables: {}, lifecycle_revision: 7,
    ...(state.decision && review.activation.kind === 'next_auto_run' ? { preapproval: {
      proposal_id: review.proposal_id, future_execution_ref: review.future_execution_ref,
      execution_status: state.revoked ? 'cancelled' : 'active',
    } } : {}),
  }] } };
  const inspect = (): PreapprovalInspection => {
    const { challenge: _challenge, challenge_expires_at: _expires, ...reviewed } = review;
    const result: PreapprovalInspection = { proposal_id: review.proposal_id, future_execution_ref: review.future_execution_ref, revision: review.revision,
      status: review.status, coverage: review.coverage, eligible_members: review.eligible_members, uncovered_calls: review.uncovered_calls,
      execution_status: state.revoked ? 'cancelled' : state.decision?.decision === 'approve' ? 'active' : 'prepared',
      status_reason: null, reviewed, grant: state.decision?.decision === 'approve'
        ? { grant_id: 'pag_browser', revision: state.revoked ? 2 : 1, status: state.revoked ? 'revoked' : 'active' } : null,
      decision: state.decision, members: review.members.filter(member => review.selected_member_ids.includes(member.member_id)).map(member => ({
        member_id: member.member_id, parent_member_id: member.parent_member_id, op_id: member.op_id, label: member.label,
        status: state.revoked ? 'cancelled' : 'available', action_ref: null, commit_id: null, status_message: null, reconciled_outcome: null,
      })), created_at: now - 10_000, updated_at: now };
    if (query.has('preapproval_retired')) {
      delete result.reviewed;
      result.status = 'expired'; result.execution_status = 'expired'; result.grant = null; result.decision = null;
      result.retired_review = { at: now - 1000, recipe_name: review.recipe.display_name };
      result.members = result.members.map(member => ({ ...member, status: 'expired' }));
    }
    return result;
  };
  save();
  if (method === 'notification.pending_asks') return { result: { asks: state.decision || query.has('preapproval_retired') ? [] : [{
    ask_id: 'ask_browser', title: 'Review future execution', text: 'Read the saved email, attachment and HTTP call before scheduling.',
    options: [], owner_review: { kind: 'preapproval', proposal_id: review.proposal_id }, created_at: now - 10_000,
  }] } };
  if (method === 'preapproval.get') return { result: inspect() };
  if (method === 'preapproval.list') return { result: { proposals: [inspect()], next_cursor: null } };
  if (method === 'preapproval.review') return { result: review };
  if (method === 'preapproval.prepare') {
    const request = input as unknown as import('@recued/contracts').PreparePreapproval;
    const attempts = JSON.parse(sessionStorage.getItem(`${KEY}-prepare-attempts`) ?? '[]') as unknown[];
    attempts.push(request); sessionStorage.setItem(`${KEY}-prepare-attempts`, JSON.stringify(attempts));
    review.activation = request.activation;
    review.scheduled_for = request.activation.kind === 'one_shot' ? request.activation.run_at
      : request.activation.kind === 'next_schedule' ? now + 7 * 86_400_000 : null;
    review.decision_deadline = request.decision_deadline; review.dispatch_deadline = request.dispatch_deadline;
    if (request.subject.kind === 'recipe') {
      review.recipe.recipe_id = request.subject.recipe_id; review.recipe.publisher_id = request.subject.publisher_id;
    } else {
      const draft = drafts.find(row => request.subject.kind === 'mail_draft' && row.draft_id === request.subject.draft_id)!;
      review.members = [{ ...send, arguments: draft.content, required_child_ids: [] }];
      review.selected_member_ids = [send.member_id]; review.eligible_members = 1;
      review.recipe = { recipe_id: 'send-composed-mail', publisher_id: 'recued-core', display_name: 'Send a composed email' };
      review.requested_through = { display_name: 'You', contract_id: null, credential_label: 'Owner browser' };
    }
    save();
    if (query.get('preapproval_prepare_reply') === 'lost' && attempts.length === 1) return {
      error: { code: 'UNAVAILABLE', message: 'Preparation response was lost. Retry opening this review.' },
    };
    return { result: review };
  }
  if (method === 'preapproval.select') {
    const selected = input.member_ids as string[];
    review.selected_member_ids = selected.includes(send.member_id) ? [...selected, read.member_id] : selected;
    review.eligible_members = review.selected_member_ids.length;
    review.uncovered_calls = review.members.length - review.eligible_members;
    review.coverage = review.uncovered_calls ? 'partial' : 'complete'; review.revision++;
    review.challenge = `owner-browser-${review.revision}`; save(); return { result: review };
  }
  if (method === 'preapproval.decide') {
    if (input.expected_revision !== review.revision || input.challenge !== review.challenge) return {
      error: { code: 'preapproval_stale', message: 'The review changed. Refresh it before deciding.' },
    };
    const decision = input.decision as 'approve' | 'deny' | 'cancel';
    review.status = decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : 'cancelled';
    state.decision = { decision_id: 'pad_browser', proposal_id: review.proposal_id, future_execution_ref: review.future_execution_ref,
      grant_id: decision === 'approve' ? 'pag_browser' : null, proposal_revision: review.revision,
      review_digest: review.review_digest, decision, decided_at: now, execution_status: decision === 'approve' ? 'active' : 'cancelled' };
    save();
    if (query.get('preapproval_reply') === 'lost') return { error: { code: 'UNAVAILABLE', message: 'Decision response was lost. Refresh to check its status.' } };
    return { result: state.decision };
  }
  if (method === 'preapproval.revoke') { state.revoked = true; save(); return { result: inspect() }; }
  return { error: { code: 'preapproval_unsupported', message: 'This browser fixture does not implement that method.' } };
};
