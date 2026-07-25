import { describe, expect, it } from 'vitest';

import type { SellerOffer } from '@recued/contracts';

import {
  isPaidDocumentDirectCheckoutSellerOfferSource,
  paidDocumentDirectCheckoutSellerOfferRecipeAuthorized,
} from '../paid-document-direct-checkout-seller-source.js';

const OFFER_ID = 'research-brief.fulfilled';
const RECIPE_ID = 'research-brief-checkout';
const offer = (overrides: Partial<SellerOffer> = {}): SellerOffer => ({
  offer_id: OFFER_ID,
  kind: 'document',
  display_name: 'One research brief',
  description: 'One reviewed PDF research brief',
  pricing_kind: 'fixed',
  amount_minor: 12_500,
  currency: 'USD',
  fulfillment_recipe_id: RECIPE_ID,
  checkout_url: null,
  fulfillment_config: null,
  state: 'archived',
  created_by_recipe_id: 'registration-recipe',
  created_at: 10,
  updated_at: 11,
  ...overrides,
});

// D-207 3d·6d — the `…MatchesIntent` cases went with the deleted
// direct-checkout intent (a seam of the coordinator deleted in 3d·6c).

describe('D-200 Slice 6h.3b2 Seller association source checks', () => {
  it('accepts an exact core-shaped archived offer and recipe route', () => {
    const source = offer();
    expect(isPaidDocumentDirectCheckoutSellerOfferSource(source, OFFER_ID)).toBe(true);
    expect(paidDocumentDirectCheckoutSellerOfferRecipeAuthorized(source, RECIPE_ID))
      .toBe(true);
  });

  it.each([
    ['wrong id', offer({ offer_id: 'other-offer' })],
    ['oversized display', offer({ display_name: 'x'.repeat(161) })],
    ['untrimmed description', offer({ description: ' padded ' })],
    ['non-positive amount', offer({ amount_minor: 0 })],
    ['noncanonical currency', offer({ currency: 'usd' })],
    ['untrimmed creator', offer({ created_by_recipe_id: ' registration-recipe ' })],
    ['regressed clock', offer({ created_at: 12, updated_at: 11 })],
    ['widened row', { ...offer(), transaction_state: 'paid' }],
  ])('rejects %s as an impossible or widened core source', (_label, source) => {
    expect(isPaidDocumentDirectCheckoutSellerOfferSource(source, OFFER_ID)).toBe(false);
  });

  it('requires creator-or-fulfillment recipe authority without pack/version fallback', () => {
    const unrelated = offer({
      created_by_recipe_id: 'other-creator',
      fulfillment_recipe_id: 'other-fulfillment',
    });
    expect(paidDocumentDirectCheckoutSellerOfferRecipeAuthorized(
      unrelated,
      RECIPE_ID,
    )).toBe(false);
  });
});
