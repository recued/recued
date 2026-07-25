/** D-196 §4.5 ingress piece 2 — `toPublicSellerTier`, the I-1 fence.
 *
 *  The recipe-facing tier is a PROJECTION. What must never cross:
 *  `template_contract_id` (the private authority pointer — the op family takes
 *  an entitlement key and the server resolves the template, so no recipe can
 *  name tools/scopes), `usage_policy_json` (owner policy), and `tier_id` (the
 *  KEY is the recipe-facing identity; row ids die on a re-sync).
 */

import { describe, it, expect } from 'vitest';
import { toPublicSellerTier, type SellerTier } from '../index.js';

const FULL_TIER: SellerTier = {
  tier_id: 'tier_01',
  door_id: 'door_main',
  lifecycle_source: 'stripe',
  entitlement_key: 'pro',
  display_name: 'Pro',
  template_contract_id: 'contract_template_pro',
  external_entitlement_id: 'feat_pro_123',
  usage_policy_json: { chat_turn: { month: 500 } },
  pass_duration_seconds: 2_592_000,
  customer_status_enabled_default: true,
  active: true,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_100_000,
};

describe('D-196 — toPublicSellerTier', () => {
  /** ⛔ THE PIN. The projection is an explicit pick, so this key set is exact —
   *  not a subset check, which would stay green while a new private column
   *  leaked. A field added to `SellerTier` stays server-side until someone
   *  deliberately lists it in the projection AND here. */
  it('returns EXACTLY the six ratified public fields', () => {
    expect(Object.keys(toPublicSellerTier(FULL_TIER)).sort()).toEqual([
      'active',
      'display_name',
      'entitlement_key',
      'external_entitlement_id',
      'lifecycle_source',
      'pass_duration_seconds',
    ]);
  });

  it('carries the public values through unchanged', () => {
    expect(toPublicSellerTier(FULL_TIER)).toEqual({
      entitlement_key: 'pro',
      display_name: 'Pro',
      lifecycle_source: 'stripe',
      external_entitlement_id: 'feat_pro_123',
      pass_duration_seconds: 2_592_000,
      active: true,
    });
  });

  it('never carries the private authority pointer or the row id', () => {
    const projected = toPublicSellerTier(FULL_TIER) as unknown as Record<string, unknown>;
    expect(projected.template_contract_id).toBeUndefined();
    expect(projected.tier_id).toBeUndefined();
    expect(projected.usage_policy_json).toBeUndefined();
    expect(projected.door_id).toBeUndefined();
  });
});
