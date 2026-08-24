/** D-196 Seller Economy - customer.status resolver tests. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SellerCustomer,
  SellerCustomerUsageRollup,
  SellerTier,
} from '@recued/contracts';

import {
  createSellerCustomerStatusResolver,
} from '../customer-status.js';
import type { SellerCustomerUsageStore } from '../customer-usage-policy.js';

const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);

const customer = (
  overrides: Partial<SellerCustomer> = {},
): SellerCustomer => ({
  customer_id: 'seller_customer_1',
  lifecycle_source: 'stripe',
  source_customer_id: 'cus_1',
  door_id: 'door_mcp',
  email: 'buyer@example.com',
  tier_id: 'tier_pro',
  contract_id: 'ct_customer_1',
  inbound_token_id: 'inbound_1',
  mcp_token_id: 'inbound_1',
  external_subscription_id: 'sub_1',
  source_status: 'active',
  current_period_end: NOW + 30 * 86_400_000,
  grace_until: NOW + 33 * 86_400_000,
  access_state: 'active',
  claim_email_sent_at: null,
  claim_email_marker: null,
  status_email_sent_at: null,
  status_email_marker: null,
  created_at: NOW,
  updated_at: NOW,
  ...overrides,
});

const tier = (
  usage_policy_json: SellerTier['usage_policy_json'] = {},
): SellerTier => ({
  tier_id: 'tier_pro',
  door_id: 'door_mcp',
  lifecycle_source: 'stripe',
  entitlement_key: 'pro',
  display_name: 'Pro',
  template_contract_id: 'ct_template_pro',
  external_entitlement_id: 'ent_pro',
  usage_policy_json,
  pass_duration_seconds: null,
  customer_status_enabled_default: true,
  active: true,
  created_at: NOW,
  updated_at: NOW,
});

const rollup = (
  usage_kind: 'tool_call' | 'chat_turn',
  units: number,
  period_granularity: 'day' | 'month',
  period_start: number,
): SellerCustomerUsageRollup => ({
  contract_id: 'ct_customer_1',
  usage_kind,
  period_granularity,
  period_start,
  units,
  created_at: NOW,
  updated_at: NOW,
});

let rollups: SellerCustomerUsageRollup[];
let store: SellerCustomerUsageStore;

beforeEach(() => {
  rollups = [];
  store = {
    getUsageRollup: vi.fn((input) =>
      rollups.find(
        (row) =>
          row.contract_id === input.contract_id
          && row.usage_kind === input.usage_kind
          && row.period_granularity === input.period_granularity
          && row.period_start === input.period_start,
      ) ?? null),
    // D-250 § D — the store's measurement half. This double stands in at a
    // MONEY boundary, so it throws rather than silently succeeding: a test that
    // starts exercising the token path has to say so instead of passing blind.
    recordTokenUsage: vi.fn(() => { throw new Error('recordTokenUsage not stubbed'); }) as never,
    recordUsage: vi.fn(() => {
      throw new Error('recordUsage should not be called by customer.status');
    }),
  };
});

describe('createSellerCustomerStatusResolver', () => {
  it('returns source-aware status and per-kind usage from the caller contract rollups', () => {
    rollups = [
      rollup('tool_call', 42, 'month', Date.UTC(2026, 6, 1)),
      rollup('chat_turn', 3, 'month', Date.UTC(2026, 6, 1)),
    ];
    const resolver = createSellerCustomerStatusResolver({
      sellerStore: store,
      now: () => NOW,
    });

    const view = resolver.getStatus({
      customer: customer(),
      tier: tier({
        tool_call: { period_limit: 1_000_000, rate_limit_per_min: 60 },
        chat_turn: { period_limit: 1_000, rate_limit_per_min: 10 },
      }),
    });

    expect(view).toMatchObject({
      usage: {
        period_start: Date.UTC(2026, 6, 1),
        period_granularity: 'month',
        tool_call: {
          consumed: 42,
          period_limit: 1_000_000,
          rate_limit_per_min: 60,
        },
        chat_turn: {
          consumed: 3,
          period_limit: 1_000,
          rate_limit_per_min: 10,
        },
      },
      status: {
        lifecycle_source: 'stripe',
        tier: 'pro',
        tier_id: 'tier_pro',
        source_status: 'active',
        access_state: 'active',
        current_period_end: NOW + 30 * 86_400_000,
        grace_until: NOW + 33 * 86_400_000,
      },
    });
  });

  it('reads each usage kind from its configured period and defaults missing rollups to zero', () => {
    rollups = [
      rollup('tool_call', 5, 'day', Date.UTC(2026, 6, 9)),
    ];
    const resolver = createSellerCustomerStatusResolver({
      sellerStore: store,
      now: () => NOW,
    });

    const view = resolver.getStatus({
      customer: customer({ lifecycle_source: 'manual', current_period_end: null, grace_until: null }),
      tier: tier({
        tool_call: { period_granularity: 'day', period_limit: 10 },
        chat_turn: { period_limit: null },
      }),
    });

    expect(view.usage.tool_call).toMatchObject({
      consumed: 5,
      period_start: Date.UTC(2026, 6, 9),
      period_granularity: 'day',
    });
    expect(view.usage.chat_turn).toMatchObject({
      consumed: 0,
      period_start: Date.UTC(2026, 6, 1),
      period_granularity: 'month',
      period_limit: null,
    });
    expect(view.status.lifecycle_source).toBe('manual');
    expect(view.status.current_period_end).toBeNull();
    expect(view.status.grace_until).toBeNull();
  });

  it('fails closed when the configured usage policy is malformed', () => {
    const resolver = createSellerCustomerStatusResolver({
      sellerStore: store,
      now: () => NOW,
    });

    expect(() =>
      resolver.getStatus({
        customer: customer(),
        tier: tier({ tool_call: { period_limit: 'many' } }),
      }),
    ).toThrow(/period_limit/);
  });
});
