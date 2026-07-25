/** D-200 payment-profile residue.
 *
 * D-207 3d·6d split: the general reception pair binding — the shape every
 * paired public form binds through — moved to `reception-pair-binding.ts`.
 * What stays behind here is the D-200 fulfillment workflow identity, kept
 * under the legacy module name while the paid-document pack still ships:
 * the marketplace install coordinates on the bundle key, and the
 * review-admission check derives the retired phase machine's historical
 * `data.shared` state-row key from it.
 *
 * Deleted in the same split, each with zero live consumers: the sanitized
 * bundle key, the recipe-profile issue codes (their producer — the recipes
 * package profile validator — died in 3d·6), the bounded-mapper recipe
 * context, and the direct-checkout intent (both were seams of the provider
 * coordinator deleted in 3d·6c).
 */

import {
  PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
  resolvePaidDocumentDirectCheckoutClaimConfiguration,
} from './paid-document-direct-checkout-config.js';
import type { RecipeDefinition } from './recipe.js';
import { isRecipeBundleSharedRowKeySegment } from './content-policy.js';
import { isTaskIdempotencyKey } from './work-entities.js';

/** D-200 low-level workflow identity (folded from the retired
 * paid-document-fulfillment-identity leaf when the phase machine was deleted —
 * D-207 3d·6). The bundle key doubles as the pack install-coordination key. */
export const PAID_DOCUMENT_FULFILLMENT_BUNDLE_KEY =
  'recued-core/paid-document-fulfillment' as const;

export const PAID_DOCUMENT_CHECKOUT_CREATE_IDEMPOTENCY_SUFFIX =
  ':checkout-session-create' as const;

/** One direct submission must fit both the task/workflow correlation key and
 * the provider idempotency key derived from it. This is the exact shared guard
 * used before either contract accepts the identifier. */
export const isPaidDocumentFulfillmentSubmissionId = (
  value: unknown,
): value is string => {
  if (!isRecipeBundleSharedRowKeySegment(value)) return false;
  const workflowKey = `${PAID_DOCUMENT_FULFILLMENT_BUNDLE_KEY}:${value}`;
  return isTaskIdempotencyKey(workflowKey)
    && `${workflowKey}${PAID_DOCUMENT_CHECKOUT_CREATE_IDEMPOTENCY_SUFFIX}`.length
      <= 255;
};

/** The seller-offer association a D-200 claim-configured recipe carries, or
 * `null` when the recipe has no configured association. This is the ONE spot
 * that knows the D-200 deployment block is where a recipe names its offer;
 * the general `receptionPairBinding` builder takes the resolved id as input
 * and owns only the binding shape. */
export const paidDocumentDirectCheckoutSellerAssociation = (
  recipe: RecipeDefinition,
): string | null => {
  const claim = resolvePaidDocumentDirectCheckoutClaimConfiguration(recipe);
  return claim.kind === 'configured'
    && claim.configuration.version
      === PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION
    ? claim.configuration.seller_offer_id
    : null;
};
