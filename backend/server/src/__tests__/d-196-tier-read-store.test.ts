/** D-196 §4.5 ingress piece 2 — the store half of the tier read: the new
 *  `listTiers` door filter, through a REAL SQLite database and the REAL store.
 *  (The projection fence is pinned in contracts; the wiring that applies it is
 *  pinned in the executor-config composition suite.)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSellerStore, type SellerStore } from '../storage/seller-store.js';

const NOW = 1_000;

let db: Database.Database;
let seller: SellerStore;

const tier = (input: {
  tier_id: string;
  door_id: string;
  entitlement_key: string;
  active?: boolean;
}): void => {
  seller.upsertTier({
    tier_id: input.tier_id,
    door_id: input.door_id,
    lifecycle_source: 'stripe',
    entitlement_key: input.entitlement_key,
    display_name: input.entitlement_key,
    template_contract_id: `ct_${input.tier_id}`,
    active: input.active ?? true,
    now: NOW,
  });
};

beforeEach(() => {
  db = new Database(':memory:');
  seller = createSellerStore(db);
});

describe('D-196 — listTiers door filter', () => {
  it('returns only the named door, composable with the active filter', () => {
    tier({ tier_id: 't_main_pro', door_id: 'door_main', entitlement_key: 'pro' });
    tier({
      tier_id: 't_main_old',
      door_id: 'door_main',
      entitlement_key: 'legacy',
      active: false,
    });
    tier({ tier_id: 't_side_pro', door_id: 'door_side', entitlement_key: 'pro' });

    const main = seller.listTiers({ door_id: 'door_main' });
    expect(main.map((row) => row.tier_id).sort()).toEqual(['t_main_old', 't_main_pro']);

    const mainActive = seller.listTiers({ door_id: 'door_main', active: true });
    expect(mainActive.map((row) => row.tier_id)).toEqual(['t_main_pro']);

    // No filter keeps the pre-D-196 behavior: every tier, both doors.
    expect(seller.listTiers()).toHaveLength(3);
  });

  it('findTier resolves the same triple the tier ops dispatch', () => {
    tier({ tier_id: 't_main_pro', door_id: 'door_main', entitlement_key: 'pro' });

    const found = seller.findTier({
      door_id: 'door_main',
      lifecycle_source: 'stripe',
      entitlement_key: 'pro',
    });
    expect(found?.tier_id).toBe('t_main_pro');
    expect(
      seller.findTier({
        door_id: 'door_side',
        lifecycle_source: 'stripe',
        entitlement_key: 'pro',
      }),
    ).toBeNull();
  });
});
