/** D-196 request-local direct-MCP + mcp_chat usage sessions. */

import { describe, expect, it, vi } from 'vitest';
import type {
  SellerCustomer,
  SellerCustomerUsageRollup,
  SellerTier,
  SellerUsageKind,
} from '@recued/contracts';

import { createSellerCustomerUsageGate } from '../customer-usage-policy.js';
import {
  createCustomerSurfaceUsagePendingCoordinator,
  createCustomerSurfaceUsageSession,
  runMeteredMcpChatTurn,
} from '../customer-surface-usage.js';

const NOW = Date.UTC(2026, 6, 10, 12);

const CUSTOMER: SellerCustomer = {
  customer_id: 'cust-1',
  lifecycle_source: 'manual',
  source_customer_id: 'manual:cust-1',
  door_id: 'door-1',
  email: 'buyer@example.com',
  tier_id: 'tier-1',
  contract_id: 'contract-1',
  inbound_token_id: 'token-1',
  mcp_token_id: 'token-1',
  external_subscription_id: null,
  source_status: 'active',
  current_period_end: null,
  grace_until: null,
  access_state: 'active',
  claim_email_sent_at: null,
  claim_email_marker: null,
  status_email_sent_at: null,
  status_email_marker: null,
  created_at: NOW,
  updated_at: NOW,
};

const tier = (usage_policy_json: SellerTier['usage_policy_json']): SellerTier => ({
  tier_id: 'tier-1',
  door_id: 'door-1',
  lifecycle_source: 'manual',
  entitlement_key: 'pro',
  display_name: 'Pro',
  template_contract_id: 'template-1',
  external_entitlement_id: null,
  usage_policy_json,
  pass_duration_seconds: null,
  customer_status_enabled_default: false,
  active: true,
  created_at: NOW,
  updated_at: NOW,
});

const harness = (
  customerTier: SellerTier,
  now: () => number = () => NOW,
) => {
  const rollups = new Map<SellerUsageKind, SellerCustomerUsageRollup>();
  const recordUsage = vi.fn((input: {
    contract_id: string;
    usage_kind: SellerUsageKind;
    period_granularity: 'day' | 'month';
    period_start: number;
    units: number;
    now: number;
  }) => {
    const prior = rollups.get(input.usage_kind);
    const row: SellerCustomerUsageRollup = {
      contract_id: input.contract_id,
      usage_kind: input.usage_kind,
      period_granularity: input.period_granularity,
      period_start: input.period_start,
      units: (prior?.units ?? 0) + input.units,
      created_at: prior?.created_at ?? input.now,
      updated_at: input.now,
    };
    rollups.set(input.usage_kind, row);
    return row;
  });
  const gate = createSellerCustomerUsageGate({
    now,
    sellerStore: {
      getUsageRollup: ({ usage_kind }) => rollups.get(usage_kind) ?? null,
      recordUsage,
      // D-250 § D — the store's measurement half. Throws rather than silently
      // succeeding: this is a MONEY boundary, and a test that starts exercising
      // the token path must say so instead of passing blind.
      recordTokenUsage: vi.fn(() => { throw new Error('recordTokenUsage not stubbed'); }) as never,
    },
  });
  const pendingCoordinator = createCustomerSurfaceUsagePendingCoordinator();
  const session = () => createCustomerSurfaceUsageSession({
    gate,
    customer: CUSTOMER,
    tier: customerTier,
    now,
    pendingCoordinator,
  });
  return { gate, recordUsage, rollups, session };
};

describe('createCustomerSurfaceUsageSession', () => {
  it('commits the outer +1 and D-162 N-1 reservations as N tool units', () => {
    const h = harness(tier({ tool_call: { period_limit: 10 } }));
    const usage = h.session();

    expect(usage.reserve({ tool_name: 'recued_runRecipe', usage_kind: 'tool_call', units: 1 }))
      .toEqual({ admitted: true });
    expect(usage.reserve({ tool_name: 'batch.call:ai-classify', usage_kind: 'tool_call', units: 3 }))
      .toEqual({ admitted: true });
    usage.commit();

    expect(h.rollups.get('tool_call')?.units).toBe(4);
    expect(h.recordUsage.mock.calls.map(([input]) => input.units)).toEqual([4]);
  });

  it('reserves a named logical base unit only once', () => {
    const h = harness(tier({ tool_call: { period_limit: 10 } }));
    const usage = h.session();
    const base = { tool_name: 'recued_runRecipe', usage_kind: 'tool_call', units: 1 } as const;

    expect(usage.reserveOnce('direct-mcp-base', base)).toEqual({ admitted: true });
    expect(usage.reserveOnce('direct-mcp-base', base)).toEqual({ admitted: true });
    usage.commit();

    expect(h.rollups.get('tool_call')?.units).toBe(1);
  });

  it('accounts for a valid empty customer batch as N=0 without blocking a later real dispatch', () => {
    const h = harness(tier({ tool_call: { period_limit: 10 } }));
    const usage = h.session();

    expect(usage.markZeroUnitReservation('direct-mcp-base'))
      .toEqual({ admitted: true });
    expect(usage.hasReservationKey('direct-mcp-base')).toBe(true);
    expect(usage.reserveOnce('direct-mcp-base', {
      tool_name: 'later-real-dispatch',
      usage_kind: 'tool_call',
      units: 1,
    })).toEqual({ admitted: true });
    usage.commit();

    expect(h.rollups.get('tool_call')?.units).toBe(1);
  });

  it('commits zero units when an empty customer batch is the only dispatch', () => {
    const h = harness(tier({ tool_call: { period_limit: 10 } }));
    const usage = h.session();

    expect(usage.markZeroUnitReservation('direct-mcp-base'))
      .toEqual({ admitted: true });
    usage.commit();

    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it('accounts for pending base units when the D-162 extra-unit check runs', () => {
    const h = harness(tier({ tool_call: { period_limit: 2 } }));
    const usage = h.session();

    expect(usage.reserve({ tool_name: 'recued_runRecipe', usage_kind: 'tool_call', units: 1 }))
      .toEqual({ admitted: true });
    expect(usage.reserve({ tool_name: 'batch.call:ai-classify', usage_kind: 'tool_call', units: 2 }))
      .toMatchObject({ admitted: false });
    usage.release();

    expect(h.recordUsage).not.toHaveBeenCalled();
    const retry = h.session();
    expect(retry.reserve({ tool_name: 'retry', usage_kind: 'tool_call', units: 2 }))
      .toEqual({ admitted: true });
  });

  it('makes an N-unit denial sticky and cannot partially commit the admitted prefix', () => {
    const h = harness(tier({ tool_call: { period_limit: 2 } }));
    const usage = h.session();

    expect(usage.reserve({ tool_name: 'base', usage_kind: 'tool_call', units: 1 }))
      .toEqual({ admitted: true });
    const denied = usage.reserve({
      tool_name: 'batch.call:ai-classify',
      usage_kind: 'tool_call',
      units: 2,
    });
    expect(denied).toMatchObject({ admitted: false });
    expect(usage.reserve({ tool_name: 'later', usage_kind: 'tool_call', units: 1 }))
      .toEqual(denied);
    expect(usage.reserveOnce('later-once', {
      tool_name: 'later-once',
      usage_kind: 'tool_call',
      units: 1,
    })).toEqual(denied);

    usage.commit();
    expect(h.recordUsage).not.toHaveBeenCalled();

    const retry = h.session();
    expect(retry.reserve({ tool_name: 'retry', usage_kind: 'tool_call', units: 2 }))
      .toEqual({ admitted: true });
  });

  it('denies a concurrent request against another request pending in the same period', () => {
    const h = harness(tier({ tool_call: { period_limit: 1 } }));
    const first = h.session();
    const concurrent = h.session();

    expect(first.reserve({ tool_name: 'first', usage_kind: 'tool_call', units: 1 }))
      .toEqual({ admitted: true });
    expect(concurrent.reserve({ tool_name: 'concurrent', usage_kind: 'tool_call', units: 1 }))
      .toMatchObject({ admitted: false });
    first.release();

    const retry = h.session();
    expect(retry.reserve({ tool_name: 'retry', usage_kind: 'tool_call', units: 1 }))
      .toEqual({ admitted: true });
  });

  it('pins base + D-162 extra units to one period across a UTC day boundary', () => {
    let clock = Date.UTC(2026, 6, 10, 23, 59, 59, 999);
    const h = harness(
      tier({ tool_call: { period_granularity: 'day', period_limit: 5 } }),
      () => clock,
    );
    const usage = h.session();

    expect(usage.reserve({ tool_name: 'recued_runRecipe', usage_kind: 'tool_call', units: 1 }))
      .toEqual({ admitted: true });
    clock = Date.UTC(2026, 6, 11, 0, 0, 0, 1);
    expect(usage.reserve({ tool_name: 'batch.call:ai-classify', usage_kind: 'tool_call', units: 3 }))
      .toEqual({ admitted: true });
    usage.commit();

    const periods = h.recordUsage.mock.calls.map(([entry]) => entry.period_start);
    expect(new Set(periods)).toEqual(new Set([Date.UTC(2026, 6, 10)]));
  });

  it('returns reserved rate capacity when the enclosing direct call fails', () => {
    const h = harness(tier({ tool_call: { rate_limit_per_min: 2 } }));
    const failed = h.session();
    expect(failed.reserve({ tool_name: 'failed', usage_kind: 'tool_call', units: 2 }))
      .toEqual({ admitted: true });
    failed.release();

    const retry = h.session();
    expect(retry.reserve({ tool_name: 'retry', usage_kind: 'tool_call', units: 2 }))
      .toEqual({ admitted: true });
  });
});

describe('runMeteredMcpChatTurn', () => {
  it('records one chat_turn only for an accepted completion', async () => {
    const h = harness(tier({ chat_turn: { period_limit: 3 } }));
    const run = vi.fn(async () => ({ answer: 'done' }));

    await expect(runMeteredMcpChatTurn({
      usage: h.session(),
      runAcceptedCompletion: run,
    })).resolves.toEqual({ admitted: true, value: { answer: 'done' } });

    expect(run).toHaveBeenCalledTimes(1);
    expect(h.rollups.get('chat_turn')?.units).toBe(1);
  });

  it('does not run or record when chat_turn admission is denied', async () => {
    const h = harness(tier({ chat_turn: { period_limit: 0 } }));
    const run = vi.fn(async () => 'must not run');

    const result = await runMeteredMcpChatTurn({
      usage: h.session(),
      runAcceptedCompletion: run,
    });

    expect(result).toMatchObject({ admitted: false });
    expect(run).not.toHaveBeenCalled();
    expect(h.recordUsage).not.toHaveBeenCalled();
  });

  it('releases chat_turn capacity when the accepted-completion callback fails', async () => {
    const h = harness(tier({ chat_turn: { rate_limit_per_min: 1 } }));

    await expect(runMeteredMcpChatTurn({
      usage: h.session(),
      runAcceptedCompletion: async () => {
        throw new Error('turn failed');
      },
    })).rejects.toThrow('turn failed');
    expect(h.recordUsage).not.toHaveBeenCalled();

    await expect(runMeteredMcpChatTurn({
      usage: h.session(),
      runAcceptedCompletion: async () => 'retry accepted',
    })).resolves.toEqual({ admitted: true, value: 'retry accepted' });
  });
});
