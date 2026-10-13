import { describe, expect, it } from 'vitest';
import { admitByOpRisk, standingClosureAdmits, isOwnerDefaultOnlyEntry,
  resolveQualityGateDecision,
  type ExecutionSource, type ContractSnapshot } from '../index.js';
import { APPROVAL_WORKFLOW_OP } from '../approval-workflow.js';
import { validateApprovalLinkConfig, type ApprovalLinkConfig } from '../approval-link-config.js';

const config: ApprovalLinkConfig = { display_name: 'Repair desk', action_kind: 'approve_wording',
  prompt: 'Accept the work?', context_raw: { summary: 'Review the completed repair.' },
  visitor_field_constraints: { name: 'optional', email: 'optional' }, expiry_days: 7,
  on_action: { on_approve_action: 'mark_resolved', target_kind: 'task', target_id: 'T1' } };

describe('reusable approval authority', () => {
  it.each(['review_commitment', 'review_quote_signoff', 'review_approval_workflow'] as const)(
    'audit: quality delegation keeps %s as authorization review', lift_reason => {
      for (const qualityDelegationMatches of [false, true]) {
        expect(resolveQualityGateDecision({ authorization_provenance: { pre_lift_approval: 'never', lift_reason },
          qualityDelegationMatches, switches: { all_paused: false, quality_paused: false } }))
          .toMatchObject({ verdict: 'review', reason: 'authorization_ask' });
      }
    });
  it.each(['task', 'commitment', 'recipe'] as const)('accepts an explicit %s binding', kind => {
    expect(validateApprovalLinkConfig({ ...config, on_action: { target_id: 'target', target_kind: kind,
      on_approve_action: kind === 'recipe' ? 'fire_recipe' : 'mark_resolved' } })).toEqual([]);
  });
  it('refuses guessing a target kind or treating a free-text answer as approval', () => {
    expect(validateApprovalLinkConfig({ ...config, on_action: { target_id: 'target', on_approve_action: 'mark_resolved' } })
      .map(f => f.code)).toContain('on_approve_action_unsupported');
    expect(validateApprovalLinkConfig({ ...config, action_kind: 'answer_question' })
      .map(f => f.code)).toContain('on_approve_action_unsupported');
    expect(validateApprovalLinkConfig({ ...config, on_action: { ...config.on_action, on_approve_action: 'fire_recipe' } })
      .map(f => f.code)).toContain('on_approve_action_unsupported');
  });
  it.each<ExecutionSource>([
    { channel: 'reactive', actor: 'system', event_kind: 'composition.reception_approval_workflow', source_recipe: 'reception-approval-workflow' },
    { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'owner-client' },
    { channel: 'chat', actor: 'contracted_user', chat_session_id: 'session', user_id: 'owner', contract_id: 'door' },
  ])('holds even with an admin ceiling and never-ask override for $actor', source => {
    const result = admitByOpRisk({ slug: 'approval-workflow-continue', risk_tier: 'write', ceiling: 'admin', source,
      owner_override: { approval: 'never' } });
    expect(result).toMatchObject({ verdict: 'ask', authorization_provenance: { lift_reason: 'review_approval_workflow' } });
  });
  it('a standing door grant cannot stand in for owner review', () => {
    const source: ExecutionSource = { channel: 'chat', actor: 'contracted_user', chat_session_id: 's', user_id: 'u', contract_id: 'door' };
    const snapshot: ContractSnapshot = { contract_id: 'door', contract_version: 'v1', allowed_tools: ['approval-workflow-continue'],
      approval_required: [], scope_restrictions: [], resolved_at: 1, max_risk_without_approval: 'admin',
      standing_closure_operation_ids: [APPROVAL_WORKFLOW_OP] };
    expect(standingClosureAdmits(snapshot, source, APPROVAL_WORKFLOW_OP, 'write', 'review_approval_workflow')).toBe(false);
    expect(isOwnerDefaultOnlyEntry(APPROVAL_WORKFLOW_OP)).toBe(true);
  });
});
