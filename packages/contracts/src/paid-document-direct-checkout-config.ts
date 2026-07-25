/** D-200 Slices 6g.9/6h.3b1 — recipe-pinned configuration for a new direct claim.
 *
 * Product, amount, currency, and submitted-field meaning stay in the bounded
 * mapper. V1 carries only owner-selected local deployment locators. V2 may
 * additionally name one local Seller outcome offer for later navigation-only
 * association. Because the block lives in the exact saved recipe snapshot,
 * the pair revision and rendered nonce pin it without inventing a mutable dish
 * or a third pair registry. The id proves no Seller row or transaction truth.
 */

import { isSellerOfferId } from './seller.js';

export const PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_METADATA_KEY =
  'paid_document_direct_checkout' as const;
export const PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_VERSION = 1 as const;
export const PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION =
  2 as const;

/** Stripe Checkout accepts an explicit expiry 30 minutes through 24 hours
 * after Session creation. The durable workflow stores this whole-second
 * relative window and derives absolute provider time only at its later attempt
 * fence. */
export const PAID_DOCUMENT_CHECKOUT_MIN_EXPIRY_WINDOW_MS = 30 * 60 * 1_000;
export const PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Closed owner-copy placeholder rendered deterministically into the
 * checkout-link mail body. AI never writes customer communications. */
export const PAID_DOCUMENT_CHECKOUT_URL_PLACEHOLDER =
  '[[checkout_url]]' as const;

/** Bounded local Markdown template admitted into document generation. The
 * durable record, CAS metadata, loaded bytes, and post-read record must all
 * agree before a claim is born (see the template-source reader). */
export const PAID_DOCUMENT_TEMPLATE_MAX_BYTES = 1_024 * 1_024;
export const PAID_DOCUMENT_AI_DRAFT_KEY = 'ai.draft' as const;
export const PAID_DOCUMENT_AI_DRAFT_MAX_CHARS = 16 * 1_024;

/** Immutable source pin for the owner's local Markdown template. */
export interface PaidDocumentFulfillmentTemplateState {
  file_ref: string;
  content_sha256: string;
  format: 'markdown';
}

interface PaidDocumentDirectCheckoutClaimConfigurationBase {
  readonly stripe_connection_name: string;
  readonly success_url: string;
  readonly cancel_url: string;
  readonly expiry_window_ms: number;
  /** Canonical local durable Markdown record. The coordinator source-reads
   * and hashes its bytes before the workflow claim is born. */
  readonly template_file_ref: string;
}

export interface PaidDocumentDirectCheckoutLegacyClaimConfiguration
  extends PaidDocumentDirectCheckoutClaimConfigurationBase {
  readonly version: typeof PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_VERSION;
}

export interface PaidDocumentDirectCheckoutSellerAssociationClaimConfiguration
  extends PaidDocumentDirectCheckoutClaimConfigurationBase {
  readonly version:
    typeof PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION;
  /** Author-chosen local association only. Pair-specific economics remain the
   * mapper's burden and later code must source-check the Seller row exactly. */
  readonly seller_offer_id: string;
}

export type PaidDocumentDirectCheckoutClaimConfiguration =
  | PaidDocumentDirectCheckoutLegacyClaimConfiguration
  | PaidDocumentDirectCheckoutSellerAssociationClaimConfiguration;

export type PaidDocumentDirectCheckoutClaimConfigurationResolution =
  | {
      readonly kind: 'configured';
      readonly configuration: PaidDocumentDirectCheckoutClaimConfiguration;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' };

const CONFIGURATION_KEYS = [
  'version',
  'stripe_connection_name',
  'success_url',
  'cancel_url',
  'expiry_window_ms',
  'template_file_ref',
] as const;

const SELLER_ASSOCIATION_CONFIGURATION_KEYS = [
  ...CONFIGURATION_KEYS,
  'seller_offer_id',
] as const;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
};

const hasOnlyOwnDataKeys = (
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> => {
  try {
    if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
    const names = Object.getOwnPropertyNames(value).sort();
    const sortedExpected = [...expected].sort();
    return names.length === sortedExpected.length
      && names.every((name, index) => {
        if (name !== sortedExpected[index]) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        return descriptor !== undefined
          && descriptor.enumerable
          && Object.prototype.hasOwnProperty.call(descriptor, 'value');
      });
  } catch {
    return false;
  }
};

const ownDataValue = (
  value: Record<string, unknown>,
  key: string,
): { readonly found: boolean; readonly value?: unknown } | null => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return { found: false };
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return null;
    }
    return { found: true, value: descriptor.value };
  } catch {
    return null;
  }
};

const isConnectionName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,47}$/.test(value);

const isPinnedHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > 2_048
    || !value.startsWith('https://')) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname.length > 0
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
};

const isCanonicalLocalFileRef = (value: unknown): value is string =>
  typeof value === 'string' && /^file:[0-9a-f]{32}$/.test(value);

const normalizeConfiguration = (
  value: unknown,
): PaidDocumentDirectCheckoutClaimConfiguration | null => {
  if (!isPlainRecord(value)) return null;
  const legacy = value.version === PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_VERSION;
  const sellerAssociated = value.version
    === PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION;
  if ((!legacy && !sellerAssociated)
    || !hasOnlyOwnDataKeys(
      value,
      sellerAssociated ? SELLER_ASSOCIATION_CONFIGURATION_KEYS : CONFIGURATION_KEYS,
    )
    || !isConnectionName(value.stripe_connection_name)
    || !isPinnedHttpsUrl(value.success_url)
    || !isPinnedHttpsUrl(value.cancel_url)
    || !Number.isSafeInteger(value.expiry_window_ms)
    || (value.expiry_window_ms as number) < PAID_DOCUMENT_CHECKOUT_MIN_EXPIRY_WINDOW_MS
    || (value.expiry_window_ms as number) > PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS
    || (value.expiry_window_ms as number) % 1_000 !== 0
    || !isCanonicalLocalFileRef(value.template_file_ref)
    || (sellerAssociated && !isSellerOfferId(value.seller_offer_id))) {
    return null;
  }
  const common = {
    stripe_connection_name: value.stripe_connection_name,
    success_url: value.success_url,
    cancel_url: value.cancel_url,
    expiry_window_ms: value.expiry_window_ms as number,
    template_file_ref: value.template_file_ref,
  };
  return sellerAssociated
    ? {
        version: PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
        ...common,
        seller_offer_id: value.seller_offer_id as string,
      }
    : {
        version: PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_VERSION,
        ...common,
      };
};

/** Resolve only the dedicated metadata block from one recipe-shaped value.
 * Missing is distinct from malformed for role-readiness/internal callers; the
 * standard recipe parser separately rejects a present malformed recognized
 * block. The returned object is a fresh primitive-only snapshot, so caller
 * mutation cannot rewrite it across a later await. */
export const resolvePaidDocumentDirectCheckoutClaimConfiguration = (
  recipe: unknown,
): PaidDocumentDirectCheckoutClaimConfigurationResolution => {
  try {
    if (!isPlainRecord(recipe)) return { kind: 'invalid' };
    const metadataProperty = ownDataValue(recipe, 'metadata');
    if (metadataProperty === null
      || !metadataProperty.found
      || !isPlainRecord(metadataProperty.value)) {
      return { kind: 'invalid' };
    }
    const configurationProperty = ownDataValue(
      metadataProperty.value,
      PAID_DOCUMENT_DIRECT_CHECKOUT_CONFIGURATION_METADATA_KEY,
    );
    if (configurationProperty === null) return { kind: 'invalid' };
    if (!configurationProperty.found) return { kind: 'missing' };
    const configuration = normalizeConfiguration(configurationProperty.value);
    return configuration === null
      ? { kind: 'invalid' }
      : { kind: 'configured', configuration };
  } catch {
    return { kind: 'invalid' };
  }
};
