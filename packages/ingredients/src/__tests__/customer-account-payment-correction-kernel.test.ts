import { describe,expect,it,vi } from 'vitest';
import { createKernelAdapter } from '../kernel.js';
const plan = { correction_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',expected_plan_hash: 'a'.repeat(64),summary: 'Correct P1 and its exact invoice balance.' };
const call = (input: Record<string,unknown>) => ({ slug: 'customer-account-payment-correct',risk_tier: 'destructive' as const,input,output: {},stepMeta: { step_id: 'correct',run_id: 'reviewed-run',actor: 'user_self' as const } });
describe('customer account payment kernel',() => {
  it.each([{ ...plan,payment_id: 'arbitrary' },{ ...plan,amount: '1' },{ ...plan,correction_id: '' },{ ...plan,expected_plan_hash: 'unbound' },{ ...plan,summary: {} }])('refuses added or unbound authority %j',async input => {
    const dispatch = vi.fn(async () => ({ correction_id: plan.correction_id,account_payment_id: 'aaaaaaaa-aaaa-aaaa-aaaa-bbbbbbbbbbbb',account_id: 'a',already_applied: false }));
    await expect(createKernelAdapter({ customerAccountPaymentCorrect: dispatch })(call(input))).rejects.toMatchObject({ code: 'BAD_INPUT' });expect(dispatch).not.toHaveBeenCalled();
  });
  it('requires the server dispatcher',async () => { await expect(createKernelAdapter({})(call(plan))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' }); });
  it('forwards host step metadata without reading actor or run identity from payment fields',async () => {
    const dispatch = vi.fn(async () => ({ correction_id: plan.correction_id,account_payment_id: 'aaaaaaaa-aaaa-aaaa-aaaa-bbbbbbbbbbbb',account_id: 'a',already_applied: false }));
    await createKernelAdapter({ customerAccountPaymentCorrect: dispatch })(call(plan));expect(dispatch).toHaveBeenCalledWith(plan,call(plan).stepMeta);
  });
});
