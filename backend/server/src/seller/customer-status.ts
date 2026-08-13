/** D-196 Seller Economy - self-scoped customer.status view.
 *
 *  The MCP status tool is intentionally a read-only projection over the caller's
 *  already-resolved seller customer row and tier. It accepts no customer id from
 *  the agent, so it cannot be used to enumerate other customers.
 */

import {
  SELLER_USAGE_KINDS,
  totalRecord,
  type SellerCustomer,
  type SellerTier,
  type SellerUsageKind,
  type SellerUsagePeriodGranularity,
} from '@recued/contracts';

import type { SellerCustomerUsageStore } from './customer-usage-policy.js';
import {
  resolveSellerCustomerUsagePolicy,
} from './customer-usage-policy.js';

export interface SellerCustomerStatusInput {
  readonly customer: SellerCustomer;
  readonly tier: SellerTier;
  readonly now?: number;
}

export interface SellerCustomerStatusUsageKindView {
  readonly consumed: number;
  readonly period_limit: number | null;
  readonly rate_limit_per_min: number | null;
  readonly period_start: number;
  readonly period_granularity: SellerUsagePeriodGranularity;
}

export interface SellerCustomerStatusView {
  readonly usage: {
    readonly period_start: number;
    readonly period_granularity: SellerUsagePeriodGranularity;
  } & Record<SellerUsageKind, SellerCustomerStatusUsageKindView>;
  readonly status: {
    readonly lifecycle_source: SellerCustomer['lifecycle_source'];
    readonly tier: string;
    readonly tier_id: string;
    readonly source_status: SellerCustomer['source_status'];
    readonly access_state: SellerCustomer['access_state'];
    readonly current_period_end: number | null;
    readonly grace_until: number | null;
  };
}

export interface SellerCustomerStatusResolver {
  getStatus(input: SellerCustomerStatusInput): SellerCustomerStatusView;
}

export interface SellerCustomerStatusResolverDeps {
  readonly sellerStore: SellerCustomerUsageStore;
  readonly now?: () => number;
}

const periodStart = (
  now: number,
  granularity: SellerUsagePeriodGranularity,
): number => {
  const date = new Date(now);
  if (granularity === 'day') {
    return Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
    );
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

export const createSellerCustomerStatusResolver = (
  deps: SellerCustomerStatusResolverDeps,
): SellerCustomerStatusResolver => {
  const now = deps.now ?? (() => Date.now());

  return {
    getStatus(input) {
      const timestamp = input.now ?? now();
      const usageViews = totalRecord(SELLER_USAGE_KINDS, (usageKind): SellerCustomerStatusUsageKindView => {
        const resolved = resolveSellerCustomerUsagePolicy(input.tier, usageKind);
        if (!resolved.ok) {
          throw new Error(`cannot read customer.status: ${resolved.message}`);
        }
        const start = periodStart(timestamp, resolved.policy.period_granularity);
        const rollup = deps.sellerStore.getUsageRollup({
          contract_id: input.customer.contract_id,
          usage_kind: usageKind,
          period_granularity: resolved.policy.period_granularity,
          period_start: start,
        });
        return {
          consumed: rollup?.units ?? 0,
          period_limit: resolved.policy.period_limit,
          rate_limit_per_min: resolved.policy.rate_limit_per_minute,
          period_start: start,
          period_granularity: resolved.policy.period_granularity,
        };
      });

      return {
        usage: {
          period_start: usageViews.tool_call.period_start,
          period_granularity: usageViews.tool_call.period_granularity,
          ...usageViews,
        },
        status: {
          lifecycle_source: input.customer.lifecycle_source,
          tier: input.tier.entitlement_key,
          tier_id: input.tier.tier_id,
          source_status: input.customer.source_status,
          access_state: input.customer.access_state,
          current_period_end: input.customer.current_period_end,
          grace_until: input.customer.grace_until,
        },
      };
    },
  };
};

