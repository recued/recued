/** D-196 seller substrate vocabulary. */

import { describe, expect, it } from 'vitest';

import {
  INSTALL_SCOPE_WHO,
  SELLER_ACCESS_STATES,
  SELLER_CUSTOMER_CLOSE_REASONS,
  SELLER_LIFECYCLE_SOURCES,
  SELLER_OFFER_KINDS,
  SELLER_OFFER_ID_MAX_LENGTH,
  SELLER_OFFER_PRICING_KINDS,
  SELLER_OFFER_STATE_TRANSITIONS,
  SELLER_OFFER_STATES,
  SELLER_USAGE_KINDS,
  SELLER_USAGE_PERIOD_GRANULARITIES,
  isInstallGrantSelection,
  isSellerAccessState,
  isSellerCustomerCloseReason,
  isSellerLifecycleSource,
  isSellerOfferId,
  isSellerOfferKind,
  isSellerOfferPricingKind,
  isSellerOfferState,
  isSellerOfferStateTransitionAllowed,
  isSellerUsageKind,
  isSellerUsagePeriodGranularity,
} from '@recued/contracts';

describe('D-196 seller substrate vocabulary', () => {
  it('pins lifecycle sources, access states, usage kinds, and period granularities', () => {
    expect(SELLER_LIFECYCLE_SOURCES).toEqual(['manual', 'stripe', 'paddle', 'lemonsqueezy']);
    expect(SELLER_ACCESS_STATES).toEqual(['active', 'grace', 'closed']);
    expect(SELLER_CUSTOMER_CLOSE_REASONS).toEqual([
      'cancelled',
      'payment_failed',
      'refunded',
      'dispute',
      'seller_manual',
    ]);
    expect(SELLER_USAGE_KINDS).toEqual(['tool_call', 'chat_turn']);
    expect(SELLER_USAGE_PERIOD_GRANULARITIES).toEqual(['day', 'month']);
    expect(SELLER_OFFER_KINDS).toEqual([
      'document',
      'service',
      'event',
      'reservation',
      'physical',
      'access',
    ]);
    expect(SELLER_OFFER_PRICING_KINDS).toEqual(['fixed', 'unspecified', 'free', 'recurring']);
    expect(SELLER_OFFER_STATES).toEqual(['draft', 'active', 'paused', 'archived']);
  });

  it('guards the closed vocabularies', () => {
    expect(isSellerLifecycleSource('manual')).toBe(true);
    expect(isSellerLifecycleSource('provider_x')).toBe(false);
    expect(isSellerAccessState('grace')).toBe(true);
    expect(isSellerAccessState('past_due')).toBe(false);
    expect(isSellerCustomerCloseReason('refunded')).toBe(true);
    expect(isSellerCustomerCloseReason('paused')).toBe(false);
    expect(isSellerUsageKind('tool_call')).toBe(true);
    expect(isSellerUsageKind('tokens')).toBe(false);
    expect(isSellerUsagePeriodGranularity('month')).toBe(true);
    expect(isSellerUsagePeriodGranularity('week')).toBe(false);
    expect(isSellerOfferKind('document')).toBe(true);
    expect(isSellerOfferKind('reservation')).toBe(true);
    // D-207 §4.1 retired `one_time_outcome`; the converger remaps stored rows to
    // `document`, and the vocabulary no longer admits the old value.
    expect(isSellerOfferKind('one_time_outcome')).toBe(false);
    expect(isSellerOfferKind('pack')).toBe(false);
    expect(isSellerOfferId('research-brief.fulfilled')).toBe(true);
    expect(isSellerOfferId('Research-Brief')).toBe(false);
    expect(isSellerOfferId(' research-brief ')).toBe(false);
    expect(isSellerOfferId(`r${'x'.repeat(SELLER_OFFER_ID_MAX_LENGTH)}`)).toBe(false);
    expect(isSellerOfferPricingKind('fixed')).toBe(true);
    expect(isSellerOfferPricingKind('free')).toBe(true);
    expect(isSellerOfferPricingKind('recurring')).toBe(true);
    expect(isSellerOfferPricingKind('subscription')).toBe(false);
    expect(isSellerOfferState('draft')).toBe(true);
    expect(isSellerOfferState('published')).toBe(false);
  });

  it('pins the owner-only offer lifecycle and terminal archive', () => {
    expect(SELLER_OFFER_STATE_TRANSITIONS).toEqual({
      draft: ['active', 'archived'],
      active: ['paused', 'archived'],
      paused: ['active', 'archived'],
      archived: [],
    });
    expect(isSellerOfferStateTransitionAllowed('draft', 'active')).toBe(true);
    expect(isSellerOfferStateTransitionAllowed('draft', 'paused')).toBe(false);
    expect(isSellerOfferStateTransitionAllowed('active', 'draft')).toBe(false);
    expect(isSellerOfferStateTransitionAllowed('paused', 'active')).toBe(true);
    expect(isSellerOfferStateTransitionAllowed('archived', 'active')).toBe(false);
  });

  it('accepts the seller install audience split', () => {
    expect(INSTALL_SCOPE_WHO).toEqual([
      'owner',
      'all_customers',
      'all_other_contracts',
      'all_contracts',
    ]);
    expect(isInstallGrantSelection({
      access: 'read',
      scope: 'all_customers',
    })).toBe(true);
    expect(isInstallGrantSelection({
      access: 'read',
      scope: 'all_other_contracts',
    })).toBe(true);
    expect(isInstallGrantSelection({
      access: 'read',
      scope: 'customers',
    })).toBe(false);
    expect(isInstallGrantSelection({
      access: 'write',
      audience: {
        owner: true,
        all_customers: false,
        all_other_contracts: true,
        customer_tier_ids: ['tier-pro'],
        contract_ids: ['ct-partner'],
      },
    })).toBe(true);
    expect(isInstallGrantSelection({
      access: 'read',
      scope: 'owner',
      audience: { owner: true, all_customers: false, all_other_contracts: false },
    })).toBe(false);
    expect(isInstallGrantSelection({
      access: 'read',
      audience: { owner: true, all_customers: false, all_other_contracts: false, contract_ids: [''] },
    })).toBe(false);
  });
});
