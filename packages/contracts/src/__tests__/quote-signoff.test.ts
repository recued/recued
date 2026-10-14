import { describe, expect, it } from 'vitest';
import { admitByOpRisk, standingClosureAdmits, type ContractSnapshot, type ExecutionSource } from '../index.js';
import { APPROVAL_LINK_AUTHORABLE_ON_APPROVE_ACTIONS, validateApprovalLinkConfig, type ApprovalLinkConfig } from '../approval-link-config.js';

const config: ApprovalLinkConfig = { display_name: 'Studio', action_kind: 'approve_wording', prompt: 'Accept the quote?',
  context_raw: { summary: 'Exact offered terms.' }, visitor_field_constraints: { name: 'optional', email: 'optional' },
  expiry_days: 7, on_action: { target_id: 'signoff', on_approve_action: 'quote_signoff' } };

describe('customer sign-off approval contract', () => {
  it('binds completion to a bounded delivery with explicit approval decisions',() => {
    const completion: ApprovalLinkConfig = { ...config,on_action: { target_id: 'completion',on_approve_action: 'quote_completion' },context_raw: { summary: 's'.repeat(8000) } };
    expect(validateApprovalLinkConfig(completion)).toEqual([]);
    expect(validateApprovalLinkConfig({ ...completion,action_kind: 'answer_question' }).map(f => f.code)).toContain('on_action_invalid');
    expect(APPROVAL_LINK_AUTHORABLE_ON_APPROVE_ACTIONS).not.toContain('quote_completion');
    for (const ceiling of ['read','admin'] as const) {
      const decision = admitByOpRisk({ slug: 'quote-completion-review',risk_tier: 'write',ceiling,source: { channel: 'user',actor: 'user_self',user_id: 'owner',client_token_id: 'owner-client' },owner_override: { approval: 'never' } });
      expect(decision).toMatchObject({ verdict: 'ask',authorization_provenance: { lift_reason: 'review_quote_signoff' } });
    }
  });
  it('shows the full bounded scope without widening generic approval forms', () => {
    expect(validateApprovalLinkConfig({ ...config, context_raw: { summary: 's'.repeat(8000) } })).toEqual([]);
    expect(validateApprovalLinkConfig({ ...config, context_raw: { summary: 's'.repeat(8001) } }).map((f) => f.code)).toContain('context_summary_too_long');
    expect(validateApprovalLinkConfig({ ...config, on_action: { ...config.on_action, on_approve_action: 'create_commitment' },
      context_raw: { summary: 's'.repeat(801) } }).map((f) => f.code)).toContain('context_summary_too_long');
    expect(APPROVAL_LINK_AUTHORABLE_ON_APPROVE_ACTIONS).toEqual(['create_commitment', 'mark_resolved', 'fire_recipe']);
  });
  it('only accepts an explicit accept or reject decision', () => {
    expect(validateApprovalLinkConfig({ ...config, action_kind: 'answer_question' }).map((f) => f.code)).toContain('on_action_invalid');
  });
  it.each<ExecutionSource>([
    { channel: 'reactive', actor: 'system', event_kind: 'composition.reception_quote_signoff', source_recipe: 'reception-quote-signoff-release' },
    { channel: 'user', actor: 'user_self', user_id: 'owner', client_token_id: 'owner-client' },
    { channel: 'chat', actor: 'contracted_user', chat_session_id: 'session', user_id: 'owner', contract_id: 'door' },
  ])('requires owner review even at an admin ceiling for $actor', (source) => {
    for (const ceiling of ['read', 'admin'] as const) {
      for (const approval of ['never', 'ask'] as const) {
        const decision = admitByOpRisk({ slug: 'quote-signoff-release', risk_tier: 'write', ceiling, source,
          owner_override: { approval } });
        expect(decision).toMatchObject({ verdict: 'ask', authorization_provenance: { lift_reason: 'review_quote_signoff' } });
      }
    }
  });
  it('a standing door closure cannot replace review of the customer-accepted release', () => {
    const source: ExecutionSource = { channel: 'chat', actor: 'contracted_user', chat_session_id: 's', user_id: 'u', contract_id: 'door' };
    const snapshot: ContractSnapshot = { contract_id: 'door', contract_version: 'v1',
      allowed_tools: ['quote-signoff-release'], approval_required: [], scope_restrictions: [], resolved_at: 1,
      max_risk_without_approval: 'admin', standing_closure_operation_ids: ['core.work-entity.quote-signoff.release'] };
    expect(standingClosureAdmits(snapshot, source, 'core.work-entity.quote-signoff.release', 'write', 'review_quote_signoff')).toBe(false);
  });
});
