import { describe,expect,it,vi } from 'vitest';
import { createKernelAdapter } from '../kernel.js';
const plan = { credit_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',expected_plan_hash: 'a'.repeat(64),summary: 'Issue a credit and reduce the unpaid balance.' };
const call = (input: Record<string,unknown>) => ({ slug: 'customer-invoice-credit',risk_tier: 'destructive' as const,input,output: {},stepMeta: { step_id: 'credit',run_id: 'reviewed-run',actor: 'user_self' as const } });
describe('customer invoice credit kernel',() => {
  it.each([{ ...plan,payment_id: 'arbitrary' },{ ...plan,amount: '1' },{ ...plan,credit_id: '' },{ ...plan,expected_plan_hash: 'unbound' },{ ...plan,summary: {} }])('refuses added or unbound authority %j',async input => {
    const dispatch = vi.fn(async () => ({ credit_id: plan.credit_id,signoff_id: 's',invoice_id: 'i',already_applied: false }));
    await expect(createKernelAdapter({ customerInvoiceCredit: dispatch })(call(input))).rejects.toMatchObject({ code: 'BAD_INPUT' });expect(dispatch).not.toHaveBeenCalled();
  });
  it('requires the server dispatcher',async () => { await expect(createKernelAdapter({})(call(plan))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' }); });
  it('forwards host step metadata without reading actor or run identity from credit fields',async () => {
    const dispatch = vi.fn(async () => ({ credit_id: plan.credit_id,signoff_id: 's',invoice_id: 'i',already_applied: false }));
    await createKernelAdapter({ customerInvoiceCredit: dispatch })(call(plan));expect(dispatch).toHaveBeenCalledWith(plan,call(plan).stepMeta);
  });
});
