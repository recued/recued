/** D-196 §4.5 ingress piece 2 — the `core.seller.tier` kernel op surface.
 *
 *  The projection fence (no `template_contract_id`, no row ids in the RESULT)
 *  lives in `toPublicSellerTier`, pinned by its contracts test. What only this
 *  layer can carry is the CLOSED INPUT KEY SET: the family is addressed by the
 *  entitlement KEY, and a `tier_id` refused here is a recipe that never learns
 *  to hold an identity that dies on the first re-sync.
 */

import { describe, expect, it, vi } from 'vitest';
import { createKernelAdapter } from '../kernel.js';

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

const PUBLIC_TIER = {
  entitlement_key: 'pro',
  display_name: 'Pro',
  lifecycle_source: 'stripe' as const,
  external_entitlement_id: 'feat_pro_123',
  pass_duration_seconds: null,
  active: true,
};

describe('D-196 — `tier.get` is addressed by the key, never a row id', () => {
  it('dispatches the full triple', async () => {
    const sellerTierGet = vi.fn(async () => ({ tier: PUBLIC_TIER }));
    const adapter = createKernelAdapter({ sellerTierGet });

    await adapter(
      mkCall('seller-tier-get', {
        lifecycle_source: 'stripe',
        door_id: 'door_main',
        entitlement_key: 'pro',
      }),
    );
    expect(sellerTierGet).toHaveBeenCalledWith({
      lifecycle_source: 'stripe',
      door_id: 'door_main',
      entitlement_key: 'pro',
    });
  });

  it.each([
    ['tier_id', 'tier_01'],
    ['template_contract_id', 'contract_template_pro'],
  ])('refuses the identity a recipe must never hold: %s', async (field, value) => {
    const sellerTierGet = vi.fn(async () => ({ tier: null }));
    const adapter = createKernelAdapter({ sellerTierGet });

    await expect(
      adapter(
        mkCall('seller-tier-get', {
          lifecycle_source: 'stripe',
          door_id: 'door_main',
          entitlement_key: 'pro',
          [field]: value,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sellerTierGet).not.toHaveBeenCalled();
  });

  it('refuses an unknown lifecycle_source', async () => {
    const sellerTierGet = vi.fn(async () => ({ tier: null }));
    const adapter = createKernelAdapter({ sellerTierGet });

    await expect(
      adapter(
        mkCall('seller-tier-get', {
          lifecycle_source: 'paypal',
          door_id: 'door_main',
          entitlement_key: 'pro',
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sellerTierGet).not.toHaveBeenCalled();
  });

  it('surfaces SERVER_NOT_REACHABLE when the seller substrate is absent', async () => {
    const adapter = createKernelAdapter({});
    await expect(
      adapter(
        mkCall('seller-tier-get', {
          lifecycle_source: 'stripe',
          door_id: 'door_main',
          entitlement_key: 'pro',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });
});

describe('D-196 — `tier.list` filters', () => {
  it('passes only the filters the caller supplied', async () => {
    const sellerTierList = vi.fn(async () => ({ tiers: [PUBLIC_TIER] }));
    const adapter = createKernelAdapter({ sellerTierList });

    await adapter(mkCall('seller-tier-list', {}));
    expect(sellerTierList).toHaveBeenLastCalledWith({});

    await adapter(
      mkCall('seller-tier-list', {
        door_id: 'door_main',
        lifecycle_source: 'stripe',
        active: true,
      }),
    );
    expect(sellerTierList).toHaveBeenLastCalledWith({
      door_id: 'door_main',
      lifecycle_source: 'stripe',
      active: true,
    });
  });

  /** The manifest's `""` defaults arrive for untouched optional fields — they
   *  must read as ABSENT, not as filters. */
  it('treats manifest empty-string defaults as absent filters', async () => {
    const sellerTierList = vi.fn(async () => ({ tiers: [] }));
    const adapter = createKernelAdapter({ sellerTierList });

    await adapter(
      mkCall('seller-tier-list', { door_id: '', lifecycle_source: '', active: '' }),
    );
    expect(sellerTierList).toHaveBeenCalledWith({});
  });

  it('refuses a non-boolean active filter', async () => {
    const sellerTierList = vi.fn(async () => ({ tiers: [] }));
    const adapter = createKernelAdapter({ sellerTierList });

    await expect(
      adapter(mkCall('seller-tier-list', { active: 'yes' })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sellerTierList).not.toHaveBeenCalled();
  });

  it('refuses an unknown filter field', async () => {
    const sellerTierList = vi.fn(async () => ({ tiers: [] }));
    const adapter = createKernelAdapter({ sellerTierList });

    await expect(
      adapter(mkCall('seller-tier-list', { template_contract_id: 'x' })),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sellerTierList).not.toHaveBeenCalled();
  });
});
