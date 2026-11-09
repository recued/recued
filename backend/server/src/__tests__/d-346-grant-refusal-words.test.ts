/** D-346 follow-up (2026-11-08) — an action switched off for its caller, refused at the per-call
 *  check inside a recipe run, says who turns it on and where. It said "operation '…' is not
 *  granted to this dispatch's governing contract (revoked)", for one never granted too. */
import { describe, expect, it } from 'vitest';

import type { ExecutionSource, IngredientManifest } from '@recued/contracts';

import { createSingleOperationAdmission } from '../single-operation-admission.js';

const manifest = {
  slug: 'crm-wrapper',
  name: 'CRM',
  description: '',
  author: 'pub',
  kind: 'connection',
  category: 'action',
  risk_tier: 'read',
  input: {},
  output: {},
} as unknown as IngredientManifest;

const refusalFor = (source: ExecutionSource) => createSingleOperationAdmission({
  source,
  // A contract's call carries its snapshot; the tool is on its list, so only the op grant refuses.
  ...((source as { contract_id?: string }).contract_id !== undefined
    ? { contract_snapshot: {
        contract_id: (source as { contract_id: string }).contract_id,
        contract_version: '1',
        allowed_tools: [manifest.slug],
        approval_required: [],
        scope_restrictions: [],
        resolved_at: 0,
      } as never }
    : {}),
  manifest: (slug) => (slug === manifest.slug ? manifest : undefined),
  opAdmissionGate: { isOpGranted: () => false, isFrozenByPause: () => false } as never,
  granted_recipe_steps: false,
  recipeCoversOp: () => false,
})(manifest.slug, {});

describe('an action switched off for its caller, at the per-call check', () => {
  it('the owner’s own run reads their row on the Contracts page', () => {
    expect(refusalFor({ channel: 'chat', actor: 'user_self' } as ExecutionSource)).toMatchObject({
      verdict: 'deny',
      code: 'op_not_granted',
      detail: expect.stringMatching(/ is turned off for you, so it did not run\. To use it, turn it on under Self \(you\) → Ops on the Contracts page\.$/),
    });
  });

  it('any other contract’s run reads only that it is not available', () => {
    const decision = refusalFor({ channel: 'mcp', actor: 'contracted_user', contract_id: 'ct_app_1' } as ExecutionSource);
    expect(decision).toMatchObject({ verdict: 'deny', code: 'op_not_granted' });
    expect((decision as { detail: string }).detail).toMatch(/ is not available for this contract\.$/);
    expect((decision as { detail: string }).detail).not.toContain('revoked');
  });
});
