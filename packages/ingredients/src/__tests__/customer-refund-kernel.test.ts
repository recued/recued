import { describe,expect,it,vi } from 'vitest';
import { createKernelAdapter } from '../kernel.js';
const plan = { action_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',expected_plan_hash: 'a'.repeat(64),summary: 'Issue a credit and reduce the unpaid balance.' };
const call = (input: Record<string,unknown>) => ({ slug: 'customer-refund-apply',risk_tier: 'destructive' as const,input,output: {},stepMeta: { step_id: 'credit',run_id: 'reviewed-run',actor: 'user_self' as const } });
describe('customer refund kernel',() => {
  it.each([{ ...plan,payment_id: 'arbitrary' },{ ...plan,amount: '1' },{ ...plan,action_id: '' },{ ...plan,expected_plan_hash: 'unbound' },{ ...plan,summary: {} }])('refuses added or unbound authority %j',async input => {
    const dispatch = vi.fn(async () => ({ action_id: plan.action_id,signoff_id: 's',kind: 'credit' as const,already_applied: false }));
    await expect(createKernelAdapter({ customerRefundApply: dispatch })(call(input))).rejects.toMatchObject({ code: 'BAD_INPUT' });expect(dispatch).not.toHaveBeenCalled();
  });
  it('requires the server dispatcher',async () => { await expect(createKernelAdapter({})(call(plan))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' }); });
  it('forwards host step metadata without reading actor or run identity from credit fields',async () => {
    const dispatch = vi.fn(async () => ({ action_id: plan.action_id,signoff_id: 's',kind: 'credit' as const,already_applied: false }));
    await createKernelAdapter({ customerRefundApply: dispatch })(call(plan));expect(dispatch).toHaveBeenCalledWith(plan,call(plan).stepMeta);
  });
});
