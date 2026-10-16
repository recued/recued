import { describe,expect,it,vi } from 'vitest';
import { createKernelAdapter } from '../kernel.js';
const plan = { correction_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',expected_plan_hash: 'a'.repeat(64),summary: 'Correct P1 and its exact invoice balance.' };
const call = (input: Record<string,unknown>) => ({ slug: 'customer-payment-correct',risk_tier: 'destructive' as const,input,output: {},stepMeta: { step_id: 'correct',run_id: 'reviewed-run',actor: 'user_self' as const } });
describe('customer payment correction kernel',() => {
  it.each([{ ...plan,payment_id: 'arbitrary' },{ ...plan,amount: '1' },{ ...plan,correction_id: '' },{ ...plan,expected_plan_hash: 'unbound' },{ ...plan,summary: {} }])('refuses added or unbound authority %j',async input => {
    const dispatch = vi.fn(async () => ({ correction_id: plan.correction_id,signoff_id: 's',payment_id: 'p',invoice_id: 'i',action: 'correct' as const,already_applied: false }));
    await expect(createKernelAdapter({ customerPaymentCorrect: dispatch })(call(input))).rejects.toMatchObject({ code: 'BAD_INPUT' });expect(dispatch).not.toHaveBeenCalled();
  });
  it('requires the server dispatcher',async () => { await expect(createKernelAdapter({})(call(plan))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' }); });
  it('forwards host step metadata without reading actor or run identity from payment fields',async () => {
    const dispatch = vi.fn(async () => ({ correction_id: plan.correction_id,signoff_id: 's',payment_id: 'p',invoice_id: 'i',action: 'correct' as const,already_applied: false }));
    await createKernelAdapter({ customerPaymentCorrect: dispatch })(call(plan));expect(dispatch).toHaveBeenCalledWith(plan,call(plan).stepMeta);
  });
});
