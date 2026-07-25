import { describe, expect, it } from 'vitest';
import {
  PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS,
  PAID_DOCUMENT_CHECKOUT_MIN_EXPIRY_WINDOW_MS,
  PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_METADATA_KEY,
  PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
  resolvePaidDocumentDirectCheckoutClaimConfiguration,
  type PaidDocumentDirectCheckoutLegacyClaimConfiguration,
  type PaidDocumentDirectCheckoutSellerAssociationClaimConfiguration,
} from '../index.js';

const TEMPLATE_REF = `file:${'a'.repeat(32)}`;

const configuration = (
  overrides: Partial<PaidDocumentDirectCheckoutLegacyClaimConfiguration> = {},
): PaidDocumentDirectCheckoutLegacyClaimConfiguration => ({
  version: 1,
  stripe_connection_name: 'stripe-primary',
  success_url: 'https://owner.example/checkout/success',
  cancel_url: 'https://owner.example/checkout/cancel',
  expiry_window_ms: PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS,
  template_file_ref: TEMPLATE_REF,
  ...overrides,
});

const sellerAssociatedConfiguration = (
  overrides: Partial<PaidDocumentDirectCheckoutSellerAssociationClaimConfiguration> = {},
): PaidDocumentDirectCheckoutSellerAssociationClaimConfiguration => ({
  ...configuration(),
  version: PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
  seller_offer_id: 'research-brief.fulfilled',
  ...overrides,
});

const recipeWith = (value: unknown): unknown => ({
  recipe_id: 'research-brief-checkout',
  metadata: {
    name: 'Research brief checkout',
    [PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_METADATA_KEY]: value,
  },
});

describe('D-200 Slices 6g.9/6h.3b1 recipe-pinned direct-checkout configuration', () => {
  it('extracts one fresh closed locator block without commerce or Seller authority', () => {
    const source = configuration();
    const resolved = resolvePaidDocumentDirectCheckoutClaimConfiguration(recipeWith(source));

    expect(resolved).toEqual({ kind: 'configured', configuration: source });
    if (resolved.kind !== 'configured') throw new Error('expected configured result');
    expect(resolved.configuration).not.toBe(source);
    expect(resolved.configuration).not.toHaveProperty('amount_minor');
    expect(resolved.configuration).not.toHaveProperty('currency');
    expect(resolved.configuration).not.toHaveProperty('product_name');
    expect(resolved.configuration).not.toHaveProperty('seller_offer_id');
    expect(resolved.configuration).not.toHaveProperty('provider_url');
    expect(resolved.configuration).not.toHaveProperty('quantity');
    expect(resolved.configuration).not.toHaveProperty('total');

    (source as { success_url: string }).success_url = 'https://attacker.example/late';
    expect(resolved.configuration.success_url).toBe(
      'https://owner.example/checkout/success',
    );
  });

  it('keeps an absent role configuration distinct from malformed recipe data', () => {
    expect(resolvePaidDocumentDirectCheckoutClaimConfiguration({
      recipe_id: 'ordinary-recipe',
      metadata: { name: 'Ordinary recipe' },
    })).toEqual({ kind: 'missing' });
    expect(resolvePaidDocumentDirectCheckoutClaimConfiguration(null))
      .toEqual({ kind: 'invalid' });
    expect(resolvePaidDocumentDirectCheckoutClaimConfiguration({ metadata: null }))
      .toEqual({ kind: 'invalid' });
  });

  it('accepts one fresh v2 local offer association without granting Seller-row authority', () => {
    const source = sellerAssociatedConfiguration();
    const resolved = resolvePaidDocumentDirectCheckoutClaimConfiguration(recipeWith(source));

    expect(resolved).toEqual({ kind: 'configured', configuration: source });
    if (resolved.kind !== 'configured') throw new Error('expected configured result');
    expect(resolved.configuration).not.toBe(source);
    expect(resolved.configuration).toMatchObject({
      version: PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
      seller_offer_id: 'research-brief.fulfilled',
    });
    expect(resolved.configuration).not.toHaveProperty('seller_offer');
    expect(resolved.configuration).not.toHaveProperty('amount_minor');
    expect(resolved.configuration).not.toHaveProperty('state');

    (source as { seller_offer_id: string }).seller_offer_id = 'attacker.changed';
    expect('seller_offer_id' in resolved.configuration
      ? resolved.configuration.seller_offer_id
      : null).toBe('research-brief.fulfilled');
  });

  it.each([
    ['unknown version', { ...configuration(), version: 3 }],
    ['uppercase connection', configuration({ stripe_connection_name: 'Stripe-Primary' })],
    ['long connection', configuration({ stripe_connection_name: `s${'x'.repeat(48)}` })],
    ['insecure success URL', configuration({ success_url: 'http://owner.example/success' })],
    ['credentialed cancel URL', configuration({ cancel_url: 'https://user:secret@owner.example/cancel' })],
    ['short expiry', configuration({
      expiry_window_ms: PAID_DOCUMENT_CHECKOUT_MIN_EXPIRY_WINDOW_MS - 1_000,
    })],
    ['long expiry', configuration({
      expiry_window_ms: PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS + 1_000,
    })],
    ['subsecond expiry', configuration({
      expiry_window_ms: PAID_DOCUMENT_CHECKOUT_MIN_EXPIRY_WINDOW_MS + 1,
    })],
    ['noncanonical template', configuration({ template_file_ref: 'file:not-canonical' })],
    ['remote template', configuration({ template_file_ref: 'https://attacker.example/template.md' })],
    ['extra economics', { ...configuration(), amount_minor: 50_000 }],
    ['extra quantity', { ...configuration(), quantity: 2 }],
    ['extra Seller identity', { ...configuration(), seller_offer_id: 'offer-1' }],
    ['uppercase v2 Seller id', sellerAssociatedConfiguration({
      seller_offer_id: 'Research-Brief',
    })],
    ['spaced v2 Seller id', sellerAssociatedConfiguration({
      seller_offer_id: ' research-brief ',
    })],
    ['long v2 Seller id', sellerAssociatedConfiguration({
      seller_offer_id: `r${'x'.repeat(128)}`,
    })],
    ['extra v2 authority', {
      ...sellerAssociatedConfiguration(),
      seller_offer: { state: 'active' },
    }],
  ])('refuses %s', (_label, value) => {
    expect(resolvePaidDocumentDirectCheckoutClaimConfiguration(recipeWith(value)))
      .toEqual({ kind: 'invalid' });
  });

  it('refuses accessors, symbols, and non-plain configuration objects', () => {
    const accessor = configuration() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, 'success_url', {
      enumerable: true,
      get: () => 'https://attacker.example/getter',
    });
    const symbol = configuration() as unknown as Record<PropertyKey, unknown>;
    symbol[Symbol('hidden')] = true;
    const classValue = Object.assign(new class ClaimConfiguration {}, configuration());

    for (const value of [accessor, symbol, classValue]) {
      expect(resolvePaidDocumentDirectCheckoutClaimConfiguration(recipeWith(value)))
        .toEqual({ kind: 'invalid' });
    }
  });
});
