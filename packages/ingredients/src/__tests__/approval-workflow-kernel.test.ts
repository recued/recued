import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_WORKFLOW_INGREDIENT } from '@recued/contracts';
import { createKernelAdapter } from '../kernel.js';

const binding = { endpoint_id: 'endpoint-1', intent_id: 'intent-1', expected_plan_hash: 'a'.repeat(64), summary: 'Complete the accepted repair.' };
const call = (input: Record<string, unknown>) => ({ slug: APPROVAL_WORKFLOW_INGREDIENT, risk_tier: 'write' as const, input, output: {} });

describe('bound workflow kernel input', () => {
  it.each([
    { ...binding, config: { title: 'visitor settings' } },
    { ...binding, connections: { calendar: 'another-account' } },
    { ...binding, target_id: 'another-task' },
    { ...binding, expected_plan_hash: 'unbound' },
    { ...binding, endpoint_id: '' },
    { ...binding, intent_id: ' '.repeat(4) },
    { ...binding, summary: {} },
  ])('refuses injected or malformed authority before dispatch: %j', async input => {
    const approvalWorkflowContinue = vi.fn(async () => ({ target_kind: 'task' as const, target_id: 'T1', already_continued: false }));
    await expect(createKernelAdapter({ approvalWorkflowContinue })(call(input))).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(approvalWorkflowContinue).not.toHaveBeenCalled();
  });
  it('fails closed if workflow continuation is not wired', async () => {
    await expect(createKernelAdapter({})(call(binding))).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});
