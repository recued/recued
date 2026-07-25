/** D-196 Seller Economy - customer admission tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { McpInboundTokenRecord } from '@recued/contracts';

import { createSellerStore, type SellerStore } from '../../storage/seller-store.js';
import {
  evaluateSellerCustomerAccessAdmission,
} from '../customer-access-admission.js';

const NOW = 1_900_200_000_000;
const HOUR_MS = 60 * 60 * 1000;

let db: Database.Database;
let sellerStore: SellerStore;

const token = (
  overrides: Partial<Pick<McpInboundTokenRecord, 'token_id' | 'contract_id'>> = {},
): Pick<McpInboundTokenRecord, 'token_id' | 'contract_id'> => ({
  token_id: 'tok_customer_1',
  contract_id: 'ct_customer_1',
  ...overrides,
});

const upsertTier = (
  overrides: Partial<Parameters<SellerStore['upsertTier']>[0]> = {},
) =>
  sellerStore.upsertTier({
    tier_id: 'tier_basic',
    door_id: 'door_mcp',
    lifecycle_source: 'stripe',
    entitlement_key: 'basic',
    display_name: 'Basic',
    template_contract_id: 'ct_template_basic',
    usage_policy_json: { tool_call: { period_limit: 1000 } },
    now: NOW,
    ...overrides,
  });

const upsertCustomer = (
  overrides: Partial<Parameters<SellerStore['upsertCustomer']>[0]> = {},
) =>
  sellerStore.upsertCustomer({
    customer_id: 'seller_customer_1',
    lifecycle_source: 'stripe',
    source_customer_id: 'cus_1',
    door_id: 'door_mcp',
    tier_id: 'tier_basic',
    contract_id: 'ct_customer_1',
    inbound_token_id: 'tok_customer_1',
    mcp_token_id: 'tok_customer_1',
    source_status: 'active',
    current_period_end: NOW + HOUR_MS,
    grace_until: NOW + 4 * HOUR_MS,
    access_state: 'active',
    now: NOW,
    ...overrides,
  });

const admit = (
  overrides: Partial<Pick<McpInboundTokenRecord, 'token_id' | 'contract_id'>> = {},
  now = NOW,
  contractKind?: 'standing' | 'customer_instance' | null,
) =>
  evaluateSellerCustomerAccessAdmission({
    sellerStore,
    token: token(overrides),
    now,
    ...(contractKind !== undefined ? { contractKind } : {}),
  });

beforeEach(() => {
  db = new Database(':memory:');
  sellerStore = createSellerStore(db);
});

afterEach(() => {
  db.close();
});

describe('seller customer access admission', () => {
  it('does not apply to ordinary inbound tokens with no seller customer row', () => {
    expect(admit({ contract_id: undefined })).toEqual({ applies: false });
    expect(admit({ contract_id: 'ct_external_door' }, NOW, 'standing'))
      .toEqual({ applies: false });
  });

  it('uses authoritative standing kind instead of inferring Seller admission from a stale row', () => {
    upsertTier();
    upsertCustomer();

    expect(admit({}, NOW, 'standing')).toEqual({ applies: false });
  });

  it('denies a customer instance when the Seller store or exact customer row is missing', () => {
    expect(evaluateSellerCustomerAccessAdmission({
      token: token(),
      now: NOW,
      contractKind: 'customer_instance',
    })).toEqual({
      applies: true,
      admitted: false,
      reason: 'customer_missing',
    });
    expect(admit({}, NOW, 'customer_instance')).toEqual({
      applies: true,
      admitted: false,
      reason: 'customer_missing',
    });
  });

  it('denies an unresolved authoritative contract kind instead of falling back to row discovery', () => {
    upsertTier();
    upsertCustomer();

    expect(admit({}, NOW, null)).toEqual({
      applies: true,
      admitted: false,
      reason: 'contract_kind_unresolved',
    });
  });

  it('admits an active seller customer matched by bound contract and token id', () => {
    upsertTier();
    upsertCustomer();

    expect(admit({}, NOW, 'customer_instance')).toEqual(expect.objectContaining({
      applies: true,
      admitted: true,
      effective_state: 'active',
      customer: expect.objectContaining({ customer_id: 'seller_customer_1' }),
      tier: expect.objectContaining({ tier_id: 'tier_basic' }),
    }));
  });

  it('fails closed when the contract matches a seller customer but the token id does not', () => {
    upsertTier();
    upsertCustomer({ inbound_token_id: 'tok_other', mcp_token_id: 'tok_other' });

    expect(admit({}, NOW, 'customer_instance')).toEqual(expect.objectContaining({
      applies: true,
      admitted: false,
      reason: 'token_mismatch',
      customer: expect.objectContaining({ customer_id: 'seller_customer_1' }),
    }));
  });

  it('fails closed when multiple Seller rows claim one customer-instance contract', () => {
    upsertTier();
    upsertCustomer();
    upsertCustomer({
      customer_id: 'seller_customer_2',
      source_customer_id: 'cus_2',
    });

    expect(admit({}, NOW, 'customer_instance')).toEqual({
      applies: true,
      admitted: false,
      reason: 'customer_ambiguous',
    });
  });

  it('denies closed customers and inactive tiers', () => {
    upsertTier({ active: false });
    upsertCustomer();
    expect(admit()).toEqual(expect.objectContaining({
      applies: true,
      admitted: false,
      reason: 'tier_inactive',
    }));

    upsertTier({ active: true, now: NOW + 1 });
    upsertCustomer({ access_state: 'closed', now: NOW + 2 });
    expect(admit()).toEqual(expect.objectContaining({
      applies: true,
      admitted: false,
      reason: 'access_closed',
    }));
  });

  it('admits an expired active period through grace and denies after grace', () => {
    upsertTier();
    upsertCustomer({
      current_period_end: NOW - HOUR_MS,
      grace_until: NOW + HOUR_MS,
    });

    expect(admit()).toEqual(expect.objectContaining({
      admitted: true,
      effective_state: 'grace',
    }));
    expect(admit({}, NOW + HOUR_MS)).toEqual(expect.objectContaining({
      admitted: false,
      reason: 'period_expired',
    }));
  });

  it('applies default and seller-overridden source status policy', () => {
    upsertTier();
    upsertCustomer({ source_status: 'refunded' });
    expect(admit()).toEqual(expect.objectContaining({
      admitted: false,
      reason: 'source_status_closed',
    }));

    sellerStore.upsertSettings({
      status_policy_json: { refunded: 'keep_active', 'stripe:past_due': 'close_now' },
      now: NOW + 1,
    });
    expect(admit()).toEqual(expect.objectContaining({
      admitted: true,
      effective_state: 'active',
    }));

    upsertCustomer({ source_status: 'past_due', now: NOW + 2 });
    expect(admit()).toEqual(expect.objectContaining({
      admitted: false,
      reason: 'source_status_closed',
    }));
  });

  it('denies a non-manual customer with no finite period even under keep-active policy', () => {
    upsertTier();
    upsertCustomer({ current_period_end: null, grace_until: null });
    sellerStore.upsertSettings({
      status_policy_json: { active: 'keep_active' },
      now: NOW + 1,
    });

    expect(admit({}, NOW, 'customer_instance')).toEqual(expect.objectContaining({
      applies: true,
      admitted: false,
      reason: 'period_deadline_missing',
      customer: expect.objectContaining({ customer_id: 'seller_customer_1' }),
    }));
  });

  it('treats manual open-ended customers as open or closed unless policy is explicit', () => {
    upsertTier({
      tier_id: 'tier_manual',
      lifecycle_source: 'manual',
      entitlement_key: 'manual-basic',
    });
    upsertCustomer({
      lifecycle_source: 'manual',
      tier_id: 'tier_manual',
      source_status: 'cancelled',
      current_period_end: null,
      grace_until: null,
    });
    expect(admit()).toEqual(expect.objectContaining({
      admitted: true,
      effective_state: 'active',
    }));

    sellerStore.upsertSettings({
      status_policy_json: { cancelled: 'close_now' },
      now: NOW + 1,
    });
    expect(admit()).toEqual(expect.objectContaining({
      admitted: false,
      reason: 'source_status_closed',
    }));
  });
});
