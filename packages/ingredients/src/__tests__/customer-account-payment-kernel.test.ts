import { describe,expect,it,vi } from 'vitest';
import { createKernelAdapter } from '../kernel.js';
const plan = { account_payment_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',expected_plan_hash: 'a'.repeat(64),summary: 'Correct P1 and its exact invoice balance.' };
const call = (input: Record<string,unknown>) => ({ slug: 'customer-account-payment-apply',risk_tier: 'destructive' as const,input,output: {},stepMeta: { step_id: 'correct',run_id: 'reviewed-run',actor: 'user_self' as const } });
describe('customer account payment kernel',() => {
  it.each([{ ...plan,payment_id: 'arbitrary' },{ ...plan,amount: '1' },{ ...plan,account_payment_id: '' },{ ...plan,expected_plan_hash: 'unbound' },{ ...plan,summary: {} }])('refuses added or unbound authority %j',async input => {
    const dispatch = vi.fn(async () => ({ account_payment_id: plan.account_payment_id,account_id: 'a',already_applied: false }));
    await expect(createKernelAdapter({ customerAccountPaymentApply: dispatch })(call(input))).rejects.toMatchObject({ code: 'BAD_INPUT' });expect(dispatch).not.toHaveBeenCalled();
  });
  it('requires the server dispatcher',async () => { await expect(createKernelAdapter({})(call(plan))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' }); });
  it('forwards host step metadata without reading actor or run identity from payment fields',async () => {
    const dispatch = vi.fn(async () => ({ account_payment_id: plan.account_payment_id,account_id: 'a',already_applied: false }));
    await createKernelAdapter({ customerAccountPaymentApply: dispatch })(call(plan));expect(dispatch).toHaveBeenCalledWith(plan,call(plan).stepMeta);
  });
});
