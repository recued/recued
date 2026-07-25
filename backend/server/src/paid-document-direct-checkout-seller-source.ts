/** D-200 Slice 6h.3b2 — fail-closed source checks for the optional direct-v4
 * core Seller association. Seller owns row storage and vocabulary; the paired
 * recipe remains the authority for transaction-specific terms. */

import {
  isSellerOfferId,
  isSellerOfferState,
  type SellerOffer,
} from '@recued/contracts';

/** ⚠ An EXACT key-set match (`hasOnlyDataKeys`), so this list must track
 *  `SellerOffer` field-for-field: a row carrying one key this list omits is
 *  refused outright. D-207 slice 3a added `checkout_url` and every offer read
 *  from the store therefore stopped validating here — the fence did its job, but
 *  it only did it because a test happened to construct the full row.
 *
 *  This is a closed vocabulary hand-copied next to the type it guards, which is
 *  the same drift class as `door_types` (const vs schema) and `OutputType` (union
 *  vs Set vs renderer). It is not worth deriving now only because D-207 slice 3d
 *  deletes this entire file along with the rest of the D-200 vertical. */
const SELLER_OFFER_SOURCE_KEYS = [
  'offer_id',
  'kind',
  'display_name',
  'description',
  'pricing_kind',
  'amount_minor',
  'currency',
  'fulfillment_recipe_id',
  'checkout_url',
  // D-196 1d — a real offer now carries a (nullable) fulfillment_config. This
  // closed key list must track SellerOffer's keys exactly (hasOnlyDataKeys is
  // an equal-length match), or the validator rejects every offer that has one.
  'fulfillment_config',
  'state',
  'created_by_recipe_id',
  'created_at',
  'updated_at',
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

const hasOnlyDataKeys = (
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> => {
  try {
    if (!isPlainRecord(value)) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) return false;
    const actual = (keys as string[]).sort();
    const expected = [...expectedKeys].sort();
    return actual.length === expected.length
      && actual.every((key, index) => {
        if (key !== expected[index]) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined
          && descriptor.enumerable
          && Object.prototype.hasOwnProperty.call(descriptor, 'value');
      });
  } catch {
    return false;
  }
};

const isStoredRecipeLocator = (value: unknown): value is string | null =>
  value === null
  || (typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && value.trim() === value);

/** Validate the complete immutable definition/provenance row that direct-v4
 * may consume. This deliberately does not inspect Seller lifecycle state for
 * execution eligibility; it only proves the state value belongs to core. */
export const isPaidDocumentDirectCheckoutSellerOfferSource = (
  value: unknown,
  expectedOfferId: string,
): value is SellerOffer => {
  try {
    if (!isSellerOfferId(expectedOfferId)
      || !hasOnlyDataKeys(value, SELLER_OFFER_SOURCE_KEYS)
      || value.offer_id !== expectedOfferId
      || value.kind !== 'document'
      || typeof value.display_name !== 'string'
      || value.display_name.length === 0
      || value.display_name.length > 160
      || value.display_name.trim() !== value.display_name
      || typeof value.description !== 'string'
      || value.description.length > 2_000
      || value.description.trim() !== value.description
      || value.pricing_kind !== 'fixed'
      || !Number.isSafeInteger(value.amount_minor)
      || (value.amount_minor as number) <= 0
      || typeof value.currency !== 'string'
      || !/^[A-Z]{3}$/.test(value.currency)
      || !isStoredRecipeLocator(value.fulfillment_recipe_id)
      // D-196 1d — non-secret config: null (absent) or a plain JSON object.
      || (value.fulfillment_config !== null && !isPlainRecord(value.fulfillment_config))
      || !isSellerOfferState(value.state)
      || !isStoredRecipeLocator(value.created_by_recipe_id)
      || !Number.isSafeInteger(value.created_at)
      || (value.created_at as number) < 0
      || !Number.isSafeInteger(value.updated_at)
      || (value.updated_at as number) < (value.created_at as number)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

/** Core task-link authority is recipe-id based by design. Pack, publisher,
 * version, and Seller publication state are not alternate authority fields.
 *
 * D-207 3d·6d — `paidDocumentDirectCheckoutSellerOfferMatchesIntent` was
 * deleted here: it typed on the direct-checkout intent, a seam of the
 * provider coordinator deleted in 3d·6c, and had no production caller. */
export const paidDocumentDirectCheckoutSellerOfferRecipeAuthorized = (
  offer: SellerOffer,
  recipeId: string,
): boolean => recipeId.length > 0
  && recipeId.length <= 256
  && recipeId.trim() === recipeId
  && (offer.created_by_recipe_id === recipeId
    || offer.fulfillment_recipe_id === recipeId);
