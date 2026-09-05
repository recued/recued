/** D-196 S4 — the Stripe-only Initialize / Synchronize rpc, now an ADAPTER.
 *
 *  `server.seller.synchronizeStripeEntitlements` shipped before the second
 *  provider existed and older webclients still call it, so its request and
 *  response shapes are frozen. Everything behind it is
 *  `provider-tier-sync.ts` with `provider: 'stripe'` (consolidation,
 *  2026-09-03): one discovery seam, one fold, one error class. This module
 *  translates the shipped shape (`listFeatures` / `features_seen`) onto the
 *  generic one and nothing more.
 *
 *  ⚠ The seed now reads through the BOUNDED `seller-stripe` catalog
 *  (`entitlement_feature.search`, v3), not the 611-operation front door's
 *  `entitlements-list`: a Stripe seller upgrading must grant that read on the
 *  seller connection before the next Synchronize. */
import {
  sellerProviderFor,
  type ExecutionSource,
  type SellerStripeSynchronizeRequest,
  type SellerStripeSynchronizeResponse,
} from '@recued/contracts';

import type { ExecuteHandlerDeps } from '../execute-handler.js';
import type { RunGatedCatalogOperationFn } from '../source-mirror/fetch.js';
import type { ContractStore } from '../storage/contract-store.js';
import type { SellerStore } from '../storage/seller-store.js';

import {
  SELLER_PROVIDER_TIER_SYNC_RECIPE,
  SellerProviderTierSynchronizationError,
  createSellerProviderTierProvider,
  synchronizeSellerProviderTiers,
  tierSeedOperationId,
  type SellerProviderConnectionOption,
  type SellerProviderTierDiscoveryFailureKind,
  type SellerProviderTierDiscoveryOutcome,
  type SellerProviderTierProvider,
  type SellerProviderTierSynchronizationErrorKind,
} from './provider-tier-sync.js';

const STRIPE = sellerProviderFor('stripe');

export const STRIPE_ENTITLEMENT_CATALOG_SLUG = STRIPE.catalog_slug;
export const STRIPE_ENTITLEMENT_LIST_OPERATION = STRIPE.tier_seed_operation;
export const STRIPE_ENTITLEMENT_LIST_OPERATION_ID = tierSeedOperationId(STRIPE);

export const SELLER_STRIPE_SYNC_RECIPE = SELLER_PROVIDER_TIER_SYNC_RECIPE;

export type SellerStripeConnectionOption = SellerProviderConnectionOption;
export type SellerStripeDiscoveryFailureKind = SellerProviderTierDiscoveryFailureKind;
export type SellerStripeFeatureDiscoveryOutcome = SellerProviderTierDiscoveryOutcome;
export type SellerStripeSynchronizationErrorKind = SellerProviderTierSynchronizationErrorKind;
export const SellerStripeSynchronizationError = SellerProviderTierSynchronizationError;
export type SellerStripeSynchronizationError = SellerProviderTierSynchronizationError;

/** The shipped Stripe-only seam shape: `listFeatures` is the generic
 *  `listRecords` pinned to `provider: 'stripe'`. */
export interface SellerStripeEntitlementProvider {
  listConnections(): SellerStripeConnectionOption[];
  listFeatures(input: {
    readonly connection_name: string;
    readonly execution_source: ExecutionSource;
  }): Promise<SellerStripeFeatureDiscoveryOutcome>;
}

/** The shipped Stripe-only view of the generic seam — what the alias rpc's
 *  handler hands `synchronizeSellerStripeEntitlements`. */
export const stripeEntitlementProviderFrom = (
  seam: SellerProviderTierProvider,
): SellerStripeEntitlementProvider => ({
  listConnections: () => seam.listConnections('stripe'),
  listFeatures: (input) => seam.listRecords({ provider: 'stripe', ...input }),
});
const stripeOnly = stripeEntitlementProviderFrom;

const generic = (stripe: SellerStripeEntitlementProvider): SellerProviderTierProvider => ({
  listConnections: (provider) => (provider === 'stripe' ? stripe.listConnections() : []),
  listRecords: (input) => {
    const { provider, store_id: _unused, ...rest } = input;
    if (provider !== 'stripe') {
      return Promise.resolve({ ok: false as const, kind: 'not_configured' as const, reason: 'Stripe-only seam' });
    }
    return stripe.listFeatures(rest);
  },
});

/** Build the production Stripe seam from the already-composed execute gateway. */
export const createSellerStripeEntitlementProvider = (
  deps: Pick<
    ExecuteHandlerDeps,
    | 'executorConfig'
    | 'connectionOperationProfiles'
    | 'connectionStore'
    | 'auditLog'
    | 'contractScan'
  >,
  runOperation?: RunGatedCatalogOperationFn,
): SellerStripeEntitlementProvider | undefined => {
  const seam = createSellerProviderTierProvider(deps, runOperation);
  return seam === undefined ? undefined : stripeOnly(seam);
};

export interface SynchronizeSellerStripeEntitlementsDeps {
  readonly sellerStore: SellerStore;
  readonly contractStore: ContractStore;
  readonly provider: SellerStripeEntitlementProvider;
  readonly now?: () => number;
  readonly newTierId?: () => string;
  readonly newContractId?: () => string;
  readonly mintedBy?: string;
}

/** The shipped rpc's body: the generic sync with `provider: 'stripe'`, its
 *  `records_seen` renamed to the shipped `features_seen`. */
export const synchronizeSellerStripeEntitlements = async (
  deps: SynchronizeSellerStripeEntitlementsDeps,
  request: SellerStripeSynchronizeRequest,
  execution_source: ExecutionSource,
): Promise<Omit<SellerStripeSynchronizeResponse, 'overview'>> => {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new SellerProviderTierSynchronizationError('bad_request', 'args must be an object');
  }
  const { records_seen, ...rest } = await synchronizeSellerProviderTiers(
    {
      sellerStore: deps.sellerStore,
      contractStore: deps.contractStore,
      provider: generic(deps.provider),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.newTierId ? { newTierId: deps.newTierId } : {}),
      ...(deps.newContractId ? { newContractId: deps.newContractId } : {}),
      mintedBy: deps.mintedBy ?? 'server:seller:stripe-sync',
    },
    {
      provider: 'stripe',
      ...(request.connection_name !== undefined ? { connection_name: request.connection_name } : {}),
      door_id: request.door_id,
      door_type: request.door_type,
    },
    execution_source,
  );
  const { provider: _provider, ...shipped } = rest;
  return { ...shipped, features_seen: records_seen };
};
