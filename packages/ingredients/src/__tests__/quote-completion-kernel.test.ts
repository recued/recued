import { describe,expect,it,vi } from 'vitest';
import { createKernelAdapter } from '../kernel.js';
const plan = { completion_id: 'a1fecd4e-42ce-42a2-b7e7-731ce51a01b2',expected_plan_hash: 'a'.repeat(64),summary: 'Close exactly the described delivery.' };
const call = (input: Record<string,unknown>) => ({ slug: 'quote-completion-review',risk_tier: 'write' as const,input,output: {} });
describe('completion review kernel input',() => {
  it.each([{ ...plan,task_id: 'arbitrary' },{ ...plan,action: 'close' },{ ...plan,completion_id: '' },{ ...plan,expected_plan_hash: 'unbound' },{ ...plan,summary: {} }])('refuses unbound authority %j',async input => {
    const dispatch = vi.fn(async () => ({ completion_id: plan.completion_id,task_id: 'T1',action: 'close' as const,already_reviewed: false }));
    await expect(createKernelAdapter({ quoteCompletionReview: dispatch })(call(input))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('requires the production dispatcher',async () => {
    await expect(createKernelAdapter({})(call(plan))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});
