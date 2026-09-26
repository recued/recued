/** The action-identity hash names the action that runs (integrity audit,
 *  2026-09-24).
 *
 *  Since D-306, dispatch drops a kernel manifest's placeholder nulls that the step
 *  did not supply, and the hash basis kept them. So "omitted" and "explicitly null"
 *  hashed alike and ran differently: for a seller pass, the package's length or
 *  permanent access. One approval or grant admitted both.
 *
 *  The strongest check is the last: the basis EQUALS what the real executor hands
 *  the kernel adapter, for the same step. */

import { describe, expect, it } from 'vitest';
import { resolveDeep, type IngredientManifest } from '@recued/contracts';
import { createIngredientExecutor } from '@recued/ingredients';

import { actionIdentityBasis } from '../action-identity-basis.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';

const stores = { vault: {}, config: { door: 'main' }, context: {}, meta: {}, step: {} } as never;
const resolve = (merged: Record<string, unknown>) =>
  resolveDeep(merged, stores, { deferVault: true }) as Record<string, unknown>;
const issue = KERNEL_MANIFESTS.find((m) => m.slug === 'customer-access-issue') as IngredientManifest;
const pass = {
  lifecycle_source: 'manual', door_id: '{{config.door}}', source_customer_id: 'a@example.com',
  entitlement_key: 'day', email: 'a@example.com',
};

describe('the action-identity basis', () => {
  it('⛔ an omitted input and an explicit null are different actions, and hash differently', () => {
    const omitted = actionIdentityBasis(issue, pass, resolve, { surfaceDispatch: false });
    const permanent = actionIdentityBasis(issue, { ...pass, period_end: null }, resolve, { surfaceDispatch: false });
    expect(omitted).not.toHaveProperty('period_end');
    expect(permanent).toHaveProperty('period_end', null);
    expect(JSON.stringify(omitted)).not.toBe(JSON.stringify(permanent));
    // Resolution still happens.
    expect(omitted.door_id).toBe('main');
  });

  it('is exactly what the real executor hands the kernel adapter', async () => {
    let received: Record<string, unknown> | undefined;
    const run = createIngredientExecutor({
      manifestLoader: async (slug) => (slug === issue.slug ? issue : null),
      kernelAdapter: async (call) => {
        received = call.input as Record<string, unknown>;
        return {};
      },
      adapterRegistry: {} as never,
      resolveRefs: (input) => resolveDeep(input, stores) as Record<string, unknown>,
    });
    for (const step of [pass, { ...pass, period_end: null }, { ...pass, period_end: 1_900_000_000_000 }]) {
      await run(issue.slug, step, undefined, undefined, undefined);
      expect(actionIdentityBasis(issue, step, resolve, { surfaceDispatch: false })).toEqual(received);
    }
  });

  it('a provider slot keeps its placeholders, as its dispatch and pre-approvals do', () => {
    const provider = {
      slug: 'probe-http', kind: 'http', risk_tier: 'read',
      input: { name: null, limit: null }, output: {},
    } as unknown as IngredientManifest;
    expect(actionIdentityBasis(provider, { name: 'acme' }, resolve, { surfaceDispatch: false }))
      .toEqual({ name: 'acme', limit: null });
  });
});
