import { describe,expect,it } from 'vitest';
import { admitByOpRisk,standingClosureAdmits,type ExecutionSource,type ContractSnapshot } from '../index.js';
const source: ExecutionSource = { channel: 'chat',actor: 'user_self',chat_session_id: 's',user_id: 'owner' };
describe('customer payment correction owner review',() => {
  it.each(['read','write','admin'] as const)('requires a fresh decision at ceiling %s despite owner approval=never',ceiling => {
    for (const slug of ['customer-account-payment-correct','core-customer-account-payment-correct','customer-account-payment-apply','core-customer-account-payment-apply','customer-refund-correct','core-customer-refund-correct','customer-refund-apply','core-customer-refund-apply','customer-payment-correct','core-customer-payment-correct','customer-invoice-credit','core-customer-invoice-credit','customer-invoice-credit-correct','core-customer-invoice-credit-correct']) {
      expect(admitByOpRisk({ slug,risk_tier: 'destructive',ceiling,source,owner_override: { approval: 'never' } }))
        .toMatchObject({ verdict: 'ask',authorization_provenance: { lift_reason: 'review_customer_payment' } });
    }
  });
  it.each([
    { slug:'customer-account-payment-correct',operation:'core.work-entity.customer-account-payment.correct' },
    { slug:'customer-account-payment-apply',operation:'core.work-entity.customer-account-payment.apply' },
    { slug:'customer-refund-correct',operation:'core.work-entity.customer-refund.correct' },
    { slug:'customer-refund-apply',operation:'core.work-entity.customer-refund.apply' },
    { slug:'customer-payment-correct',operation:'core.work-entity.customer-payment.correct' },
    { slug:'customer-invoice-credit',operation:'core.work-entity.customer-invoice.credit' },
    { slug:'customer-invoice-credit-correct',operation:'core.work-entity.customer-invoice.credit.correct' },
  ])('cannot use a standing closure as the owner decision for $operation',({ slug,operation }) => {
    const closure: ContractSnapshot = { contract_id: 'door',contract_version: 'v1',allowed_tools: [slug],approval_required: [],scope_restrictions: [],resolved_at: 1,
      max_risk_without_approval: 'admin',standing_closure_operation_ids: [operation] };
    const contracted: ExecutionSource = { channel: 'chat',actor: 'contracted_user',chat_session_id: 's',user_id: 'owner',contract_id: 'door' };
    expect(standingClosureAdmits(closure,contracted,operation,'write',undefined)).toBe(true);
    expect(standingClosureAdmits(closure,contracted,operation,'write','review_customer_payment')).toBe(false);
    expect(standingClosureAdmits(closure,contracted,operation,'destructive','review_customer_payment')).toBe(false);
  });
});
