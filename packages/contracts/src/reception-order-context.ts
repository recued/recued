/** D-207 slice 3c — the order as the VISITOR's page is allowed to see it.
 *
 *  ## Why the server builds this and the recipe does not
 *
 *  Under ruling (C) the anonymous channel performs ZERO writes. `core.seller.order.open`
 *  is a `write`, and the enforced `RISK_APPROVAL_FLOOR` derives approval from risk
 *  (read → `never`, write → `ask`) with a declared value clamped UP only, so a kernel op
 *  cannot declare its way out of that. An anonymous actor
 *  is pinned to the contracted `read` ceiling (slice 1a), so a recipe-dispatched
 *  `order.open` would HOLD at the D-157 gate — and a held run returns no output, so the
 *  visitor would get a thank-you page carrying no way to pay. That is the slice-1c lie.
 *
 *  ⇒ The reception RUNNER opens the order server-side, exactly as it already writes the
 *  durable submission row, and hands the recipe this READ-ONLY projection. The recipe
 *  renders it. It never asks for it.
 *
 *  ## The fence is, again, the ABSENT FIELD
 *
 *  ⛔ There is no `order_key` on this shape, and there must never be one.
 *
 *  `order_key` is deterministic in (offer, origin) — that is what makes a replayed open
 *  converge instead of minting a second order, and it is exactly what makes it GUESSABLE
 *  (F7). This projection reaches a recipe that renders it into a public page, and its
 *  `checkout_url` carries the correlation through a stranger's browser. Meanwhile
 *  `core.seller.order.get` accepts EITHER id and is a `read`, so it ADMITS on a public
 *  door. A key on this shape would hand every visitor a guessable address for other
 *  people's orders.
 *
 *  The only id here is the CSPRNG `order_handle` — the same id §6.3a's Confirm button
 *  carries, and never a price. */

import {
  isReceptionLinkButtonUrl,
  RECEPTION_LINK_BUTTON_URL_MAX,
} from './reception-link-button.js';
import type { SellerOffer, SellerOfferPricingKind } from './seller.js';
import type { SellerOrder, SellerOrderCheckoutCorrelation } from './seller-order.js';

/** The query parameter a hosted checkout echoes back to the webhook, which is how a
 *  payment finds its way home to the order that expected it. */
export const RECEPTION_CHECKOUT_REFERENCE_PARAM = 'client_reference_id' as const;

export interface ReceptionOrderContext {
  /** The CSPRNG handle — the ONLY order id a visitor ever sees. */
  readonly order_handle: string;
  /** The owner's pre-created hosted-checkout link, stamped with this order's
   *  correlation so the provider's webhook can name the order it paid. */
  readonly checkout_url: string;
  /** Display terms, snapshotted onto the order at open — so a later offer edit cannot
   *  retroactively restate what this customer was shown. */
  readonly product_name: string;
  readonly description: string;
  readonly amount_minor: number | null;
  readonly currency: string | null;
  readonly pricing_kind: SellerOfferPricingKind;
}

/** Why an offer cannot be sold on a public form. Each is a REFUSAL the visitor is told
 *  about — never a thank-you page with no way to pay. */
export type ReceptionOrderContextRefusal =
  /** The owner never created the hosted-checkout link. Under ruling (C) that link IS the
   *  payment path: the anonymous channel cannot create one, because creating one is a
   *  write and a write holds. Nothing to render. */
  | 'offer_has_no_checkout_url'
  /** The correlated URL is not one the page would render. `isReceptionLinkButtonUrl` is
   *  the SAME predicate the renderer applies, checked here on the FINAL string — stamping
   *  the correlation lengthens it, and a URL close to the 512-char ceiling can cross it.
   *  Refusing here rather than downstream means we never mint an order whose link the page
   *  would then silently drop. */
  | 'correlated_url_unrenderable';

export type ReceptionOrderContextResult =
  | { readonly ok: true; readonly context: ReceptionOrderContext }
  | { readonly ok: false; readonly refusal: ReceptionOrderContextRefusal };

/** Stamp the owner's checkout link with this order's correlation.
 *
 *  Uses `URL` rather than string concatenation so an existing query string on the owner's
 *  link survives, and so a caller cannot smuggle a second `client_reference_id` past us —
 *  `searchParams.set` REPLACES any existing one rather than appending a duplicate the
 *  provider would then read ambiguously. */
export const receptionCheckoutUrl = (
  checkoutUrl: string,
  correlation: SellerOrderCheckoutCorrelation,
): string | null => {
  try {
    const url = new URL(checkoutUrl);
    url.searchParams.set(
      RECEPTION_CHECKOUT_REFERENCE_PARAM,
      correlation.client_reference_id,
    );
    const stamped = url.toString();
    return stamped.length > RECEPTION_LINK_BUTTON_URL_MAX ? null : stamped;
  } catch {
    return null;
  }
};

/** Build the visitor-facing projection of an opened order.
 *
 *  The commerce terms come off the ORDER, not the offer: the order snapshotted them at
 *  open, so a customer holding a rendered page is shown what they will actually be
 *  charged even if the owner edits the offer afterwards. */
export const buildReceptionOrderContext = (input: {
  readonly offer: Pick<SellerOffer, 'display_name' | 'description' | 'checkout_url'>;
  readonly order: Pick<
    SellerOrder,
    'order_handle' | 'amount_minor' | 'currency' | 'pricing_kind'
  >;
  readonly correlation: SellerOrderCheckoutCorrelation;
}): ReceptionOrderContextResult => {
  const { offer, order, correlation } = input;

  if (offer.checkout_url === null || offer.checkout_url.length === 0) {
    return { ok: false, refusal: 'offer_has_no_checkout_url' };
  }

  const checkout_url = receptionCheckoutUrl(offer.checkout_url, correlation);
  // The SAME predicate the renderer uses, applied to the FINAL string. Anything the page
  // would refuse to render, we refuse to mint a link for.
  if (checkout_url === null || !isReceptionLinkButtonUrl(checkout_url)) {
    return { ok: false, refusal: 'correlated_url_unrenderable' };
  }

  return {
    ok: true,
    context: {
      order_handle: order.order_handle,
      checkout_url,
      product_name: offer.display_name,
      description: offer.description,
      amount_minor: order.amount_minor,
      currency: order.currency,
      pricing_kind: order.pricing_kind,
    },
  };
};
