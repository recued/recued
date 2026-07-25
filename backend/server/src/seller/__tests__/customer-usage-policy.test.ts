/** D-196 Seller Economy - customer usage policy tests. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SellerCustomer,
  SellerCustomerUsageRollup,
  SellerTier,
} from '@recued/contracts';

import {
  createSellerCustomerUsageGate,
  type SellerCustomerUsageStore,
} from '../customer-usage-policy.js';

const NOW = Date.UTC(2026, 6, 9, 12, 0, 0);

const customer = (
  overrides: Partial<SellerCustomer> = {},
): SellerCustomer => ({
  customer_id: 'cust_1',
  lifecycle_source: 'stripe',
  source_customer_id: 'cus_1',
  door_id: 'door_mcp',
  email: 'buyer@example.com',
  tier_id: 'tier_basic',
  contract_id: 'ct_customer_1',
  inbound_token_id: 'tok_1',
  mcp_token_id: 'tok_1',
  external_subscription_id: 'sub_1',
  source_status: 'active',
  current_period_end: NOW + 86_400_000,
  grace_until: NOW + 2 * 86_400_000,
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
  tier_id: 'tier_basic',
  door_id: 'door_mcp',
  lifecycle_source: 'stripe',
  entitlement_key: 'basic',
  display_name: 'Basic',
  template_contract_id: 'ct_template_basic',
  external_entitlement_id: null,
  usage_policy_json,
  pass_duration_seconds: null,
  customer_status_enabled_default: false,
  active: true,
  created_at: NOW,
  updated_at: NOW,
});

const rollup = (
  units: number,
  period_start = Date.UTC(2026, 6, 1),
): SellerCustomerUsageRollup => ({
  contract_id: 'ct_customer_1',
  usage_kind: 'tool_call',
  period_granularity: 'month',
  period_start,
  units,
  created_at: NOW,
  updated_at: NOW,
});

let currentRollup: SellerCustomerUsageRollup | null;
let store: SellerCustomerUsageStore;

beforeEach(() => {
  currentRollup = null;
  store = {
    getUsageRollup: vi.fn(() => currentRollup),
    recordUsage: vi.fn((input) => {
      const next = {
        contract_id: input.contract_id,
        usage_kind: input.usage_kind,
        period_granularity: input.period_granularity,
        period_start: input.period_start,
        units: (currentRollup?.units ?? 0) + input.units,
        created_at: currentRollup?.created_at ?? input.now,
        updated_at: input.now,
      } satisfies SellerCustomerUsageRollup;
      currentRollup = next;
      return next;
    }),
  };
});

describe('createSellerCustomerUsageGate', () => {
  it('admits and records tool calls against the default calendar-month rollup', () => {
    const gate = createSellerCustomerUsageGate({ sellerStore: store, now: () => NOW });

    const admitted = gate.admit({
      customer: customer(),
      tier: tier({ tool_call: { period_limit: 10 } }),
      usage_kind: 'tool_call',
      units: 2,
    });

    expect(admitted).toMatchObject({
      admitted: true,
      period_granularity: 'month',
      period_start: Date.UTC(2026, 6, 1),
      period_limit: 10,
      used: 0,
      remaining: 8,
    });

    const recorded = gate.record({
      customer: customer(),
      tier: tier({ tool_call: { period_limit: 10 } }),
      usage_kind: 'tool_call',
      units: 2,
    });

    expect(recorded.rollup.units).toBe(2);
    expect(store.recordUsage).toHaveBeenCalledWith({
      contract_id: 'ct_customer_1',
      usage_kind: 'tool_call',
      period_granularity: 'month',
      period_start: Date.UTC(2026, 6, 1),
      units: 2,
      now: NOW,
    });
  });

  it('denies before dispatch when the period limit would be exceeded', () => {
    currentRollup = rollup(9);
    const gate = createSellerCustomerUsageGate({ sellerStore: store, now: () => NOW });

    const denied = gate.admit({
      customer: customer(),
      tier: tier({ tool_call: { period_limit: 10 } }),
      usage_kind: 'tool_call',
      units: 2,
    });

    expect(denied).toMatchObject({
      admitted: false,
      reason: 'period_limit_exceeded',
      used: 9,
      remaining: 1,
    });
    expect(store.recordUsage).not.toHaveBeenCalled();
  });

  it('supports day rollups for tiers that choose daily periods', () => {
    const gate = createSellerCustomerUsageGate({ sellerStore: store, now: () => NOW });

    gate.record({
      customer: customer(),
      tier: tier({ tool_call: { period_granularity: 'day', period_limit: 3 } }),
      usage_kind: 'tool_call',
    });

    expect(store.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      period_granularity: 'day',
      period_start: Date.UTC(2026, 6, 9),
    }));
  });

  it('fails closed on malformed configured policy fields', () => {
    const gate = createSellerCustomerUsageGate({ sellerStore: store, now: () => NOW });

    const denied = gate.admit({
      customer: customer(),
      tier: tier({ tool_call: { period_limit: 'a lot' } }),
      usage_kind: 'tool_call',
    });

    expect(denied).toMatchObject({
      admitted: false,
      reason: 'policy_invalid',
    });
  });

  it('enforces the optional per-minute customer rate bucket', () => {
    let now = NOW;
    const gate = createSellerCustomerUsageGate({ sellerStore: store, now: () => now });
    const input = {
      customer: customer(),
      tier: tier({ tool_call: { rate_limit_per_min: 2 } }),
      usage_kind: 'tool_call' as const,
    };

    const reserved = gate.reserveRate(input);
    expect(reserved.admission.admitted).toBe(true);
    expect(reserved.reservation).not.toBeNull();
    expect(gate.admit(input).admitted).toBe(true);

    const denied = gate.admit(input);
    expect(denied).toMatchObject({
      admitted: false,
      reason: 'rate_limit_exceeded',
    });

    gate.releaseRate(reserved.reservation!, now);
    expect(gate.admit(input).admitted).toBe(true);

    now += 30_000;
    expect(gate.admit(input).admitted).toBe(true);
  });

  it('does not double-credit elapsed refill when a reservation is released', () => {
    let now = NOW;
    const gate = createSellerCustomerUsageGate({ sellerStore: store, now: () => now });
    const input = {
      customer: customer(),
      tier: tier({ tool_call: { rate_limit_per_min: 2 } }),
      usage_kind: 'tool_call' as const,
    };

    const reserved = gate.reserveRate({ ...input, units: 2 });
    expect(reserved.admission.admitted).toBe(true);
    expect(reserved.reservation).not.toBeNull();

    now += 30_000;
    expect(gate.admit(input).admitted).toBe(true);
    gate.releaseRate(reserved.reservation!, now);

    expect(gate.admit(input).admitted).toBe(true);
    expect(gate.admit(input).admitted).toBe(false);
  });

  it('returns the full attributable capacity when a reservation had bucket headroom', () => {
    let now = NOW;
    const gate = createSellerCustomerUsageGate({ sellerStore: store, now: () => now });
    const input = {
      customer: customer(),
      tier: tier({ tool_call: { rate_limit_per_min: 10 } }),
      usage_kind: 'tool_call' as const,
    };

    expect(gate.admit({ ...input, units: 5 }).admitted).toBe(true);
    const reserved = gate.reserveRate({ ...input, units: 2 });
    expect(reserved.admission.admitted).toBe(true);
    expect(reserved.reservation).not.toBeNull();

    now += 12_000;
    gate.releaseRate(reserved.reservation!, now);

    for (let i = 0; i < 7; i += 1) {
      expect(gate.admit(input).admitted).toBe(true);
    }
    expect(gate.admit(input).admitted).toBe(false);
  });
});
