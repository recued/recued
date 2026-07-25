/** D-207 §4.2–4.3 — `core.seller.order`, the money leg.
 *
 *  An order is ONE purchase of ONE offer. It joins offer + customer + intake
 *  record + payment transaction + fulfilment. This is what D-200's 3,870-LOC
 *  `paid-document-fulfillment` contract already was — generalized, with the
 *  document dropped out of it.
 *
 *  ## The invariant that replaces D-200's `isLiteralIntentStep`
 *
 *  D-200 required a checkout's `product_name` / `amount_minor` to be recipe
 *  LITERALS that "cannot contain `{{`". The D-207 audit called that safety by
 *  narrowing; the deeper truth (spec §5.5a) is that the narrowness was serving
 *  the D-177 taint model — a literal has no boundary roots, so it is clean, so a
 *  standing grant can match it across submissions.
 *
 *  That property cannot survive an offer CATALOG: a price read from a
 *  `seller_offers` row reaches the checkout through a stored read (never clean —
 *  `stored-root-origin.ts` classifies everything outside contacts/annotations as
 *  `stored` ⇒ TAINTED) and through an op-step output (which refuses the taint
 *  walk outright). Literals mean one hardcoded price per recipe, i.e. no catalog.
 *
 *  ⇒ The order moves the authority OUT of the recipe. Every commerce term on this
 *  row is SERVER-COMPUTED from the owner-authored offer. A recipe cannot name a
 *  price, because no op takes one. `amount_minor` here is not "a value we trust" —
 *  it is a value the visitor was never able to supply. That is structural, not a
 *  validator, and it is why the two-step submit (§6.3) can hand back an
 *  `order_handle` and never a price.
 *
 *  ## What the anonymous channel does NOT do
 *
 *  Under the D-207 slice-3 ruling, an offer carries a PRE-CREATED hosted-checkout
 *  URL (`SellerOffer.checkout_url`), so a public reception form performs ZERO
 *  writes: it renders a link. Payment CONFIRMATION arrives on the `webhook`
 *  channel, which IS taint-trusted (`TRUSTED_EVENT_CONTEXT_CHANNELS`), with owner
 *  authority. The anonymous actor therefore never needs to move money, and the
 *  slice-1a `read` trust floor stays exactly as designed.
 */

import { isRecipeBundleSharedRowKeySegment } from './content-policy.js';
import { isPinnedCasFileRef, type PinnedCasFileRef } from './ingredient-catalog.js';
import { isSellerOfferId, type SellerOfferPricingKind } from './seller.js';
import type { WorkEntityKind } from './work-entities.js';

/** ── Phases ──────────────────────────────────────────────────────────────────
 *
 *  Generalized from `PAID_DOCUMENT_FULFILLMENT_PHASES` (§4.2). The bracketed legs
 *  are enabled by the offer's declared shape, not by a phase variant:
 *
 *    draft → [pricing] → [awaiting_payment → paid] → fulfilling → [approved]
 *          → delivering → complete
 *
 *  ⛔ Vertical outcomes do NOT enter this enum. No `no_show`, `rescheduled`, or
 *  `partially_delivered` — those belong to the fulfilment recipe or to the linked
 *  work entity. Growing the core enum per vertical is exactly the D-200 failure.
 *
 *  ⛔ This axis is MONEY + FULFILMENT ONLY. It deliberately carries no OBLIGATION
 *  or DEADLINE dimension (§4.4a): a `commitment` already has a two-axis lifecycle
 *  (`lifecycle_state` × `due_status`), split precisely because a flat state
 *  "silently expired monetary obligations the moment the deadline passed". An
 *  order that wants that lifecycle LINKS a commitment (`linked_work_entity_*`);
 *  it does not re-implement one.
 */
export const SELLER_ORDER_PHASES = [
  /** F7 — the quote/confirm leg (§6.3) needs an order to exist BEFORE payment,
   *  so the graph opens at `draft`, not at `received`. */
  'draft',
  /** `pricing_kind: 'unspecified'` — the owner prices it, then the customer pays. */
  'pricing',
  'awaiting_payment',
  /** ★ EVIDENCE-BACKED — see `SELLER_ORDER_EVIDENCE_PHASES`. */
  'paid',
  /** Generic: run `offer.fulfillment_recipe_id`. (D-200's `generating`.) */
  'fulfilling',
  /** The offer declares an owner review step. */
  'approved',
  /** D-200's `sending`. */
  'delivering',
  'complete',
  // ── side / terminal ──
  'needs_owner',
  'ambiguous',
  'failed',
  'expired',
  'cancelled',
  /** ★ EVIDENCE-BACKED. */
  'refunded',
] as const;

export type SellerOrderPhase = (typeof SELLER_ORDER_PHASES)[number];

export const isSellerOrderPhase = (value: unknown): value is SellerOrderPhase =>
  typeof value === 'string'
  && (SELLER_ORDER_PHASES as readonly string[]).includes(value);

/** ⛔ F5 — the phases a recipe must NEVER be able to author.
 *
 *  `paid` and `refunded` assert that MONEY MOVED. A graph-only validator would
 *  let a recipe call `order.transition('paid')` — the lifecycle graph legitimately
 *  contains `awaiting_payment → paid` — and then fulfil: a free PDF, a free
 *  subscription. So these two are writable ONLY by their specialized op
 *  (`order.confirm-payment` / `order.confirm-refund`), each of which re-reads
 *  provider source truth and enforces the provider correlation AT THE STORAGE
 *  BOUNDARY, never in the caller.
 *
 *  ⚠ The `transition` op's admissible target set is DERIVED from this const
 *  (`isSellerOrderTransitionOpTarget`) — never re-typed as a second literal list.
 *  A hand-written allowlist that fell out of step with this one would silently
 *  re-open the free-PDF hole. */
export const SELLER_ORDER_EVIDENCE_PHASES = ['paid', 'refunded'] as const;

export type SellerOrderEvidencePhase = (typeof SELLER_ORDER_EVIDENCE_PHASES)[number];

export const isSellerOrderEvidencePhase = (
  value: unknown,
): value is SellerOrderEvidencePhase =>
  typeof value === 'string'
  && (SELLER_ORDER_EVIDENCE_PHASES as readonly string[]).includes(value);

/** The phases `core.seller.order.transition` may target — DERIVED, never listed.
 *  Everything except the evidence-backed pair. */
export const isSellerOrderTransitionOpTarget = (
  value: unknown,
): value is SellerOrderPhase =>
  isSellerOrderPhase(value) && !isSellerOrderEvidencePhase(value);

/** ── Buckets ─────────────────────────────────────────────────────────────────
 *  The derived owner-facing lifecycle index, carried over from D-200 unchanged. */
export const SELLER_ORDER_BUCKETS = [
  'active',
  'needs_owner',
  'timed_out',
  'closed',
] as const;

export type SellerOrderBucket = (typeof SELLER_ORDER_BUCKETS)[number];

export const SELLER_ORDER_PHASE_BUCKET = {
  draft: 'active',
  /** An unpriced quote request is waiting on the OWNER, not on the customer. */
  pricing: 'needs_owner',
  awaiting_payment: 'active',
  paid: 'active',
  fulfilling: 'active',
  approved: 'active',
  delivering: 'active',
  complete: 'closed',
  needs_owner: 'needs_owner',
  ambiguous: 'needs_owner',
  failed: 'needs_owner',
  expired: 'timed_out',
  cancelled: 'closed',
  refunded: 'closed',
} as const satisfies Readonly<Record<SellerOrderPhase, SellerOrderBucket>>;

export const sellerOrderBucket = (phase: SellerOrderPhase): SellerOrderBucket =>
  SELLER_ORDER_PHASE_BUCKET[phase];

/** ── The lifecycle graph ─────────────────────────────────────────────────────
 *
 *  ⚠ `expired` means THE CHECKOUT EXPIRED — the customer never paid, and no money
 *  ever moved. It is reachable ONLY from the pre-payment phases, and that is a
 *  load-bearing property, not an accident: auto-expiring an UNPAID checkout is
 *  correct, while auto-expiring an obligation someone is OWED is the exact bug the
 *  `commitment` substrate retired its flat state to avoid. Nothing at or after
 *  `paid` may reach `expired` — a paid order that goes wrong is `needs_owner`,
 *  `failed`, or `refunded`. Pinned by test. */
export const SELLER_ORDER_PRE_PAYMENT_PHASES = [
  'draft',
  'pricing',
  'awaiting_payment',
] as const satisfies readonly SellerOrderPhase[];

export const SELLER_ORDER_PHASE_TRANSITIONS: Readonly<
  Record<SellerOrderPhase, readonly SellerOrderPhase[]>
> = {
  /** `draft → fulfilling` is the FREE leg (`pricing_kind: 'free'`): an offer whose
   *  order has no payment leg at all.
   *
   *  `draft → paid` is the RENEWAL leg (D-196): a `provider_invoice`-keyed order
   *  is born from a payment that already settled — the provider collected before
   *  Recued ever knew the period existed — so it never passes through
   *  `awaiting_payment` (there is no checkout to await). The edge is reachable
   *  ONLY through `confirmOrderRenewalPayment`: the generic `transition` op
   *  refuses every evidence phase before consulting this graph, and the
   *  session-shaped `confirmOrderPayment` requires an attached provider session,
   *  which `attachOrderPayment` can only bind by moving the order to
   *  `awaiting_payment` first — so no session-confirm can ever fire from
   *  `draft`. */
  draft: ['pricing', 'awaiting_payment', 'paid', 'fulfilling', 'cancelled', 'expired', 'failed'],
  pricing: ['awaiting_payment', 'needs_owner', 'cancelled', 'expired', 'failed'],
  awaiting_payment: ['paid', 'expired', 'cancelled', 'failed'],
  paid: ['fulfilling', 'refunded', 'needs_owner', 'failed'],
  /** `fulfilling → cancelled` is the owner cancelling a paid order they will not
   *  fulfil (D-200's regenerate/reject `cancel` on an awaiting-review artifact).
   *  It moves NO money — the customer is owed a refund, which is the separate
   *  evidence-backed `cancelled → refunded` edge below, never a side effect of
   *  cancelling. Without this edge a fulfilling order could only be cancelled by
   *  first routing it through `needs_owner`, which the fulfilment recipes do not.
   *
   *  `fulfilling → complete` is the ACCESS leg (D-196): a fulfilment whose
   *  product is standing access (`customer-access.issue`) has no artifact to
   *  approve and nothing to deliver — issuing IS completing. Routing it through
   *  `approved`/`delivering` would be two transitions asserting review and
   *  delivery legs that do not exist. Document fulfilments keep their honest
   *  three-step path; nothing forces them through this edge. */
  fulfilling: ['approved', 'delivering', 'complete', 'needs_owner', 'cancelled', 'ambiguous', 'failed'],
  approved: ['delivering', 'needs_owner', 'failed'],
  delivering: ['complete', 'ambiguous', 'needs_owner', 'failed'],
  complete: ['refunded'],
  needs_owner: [
    'fulfilling',
    'approved',
    'delivering',
    'complete',
    'refunded',
    'cancelled',
    'failed',
  ],
  ambiguous: ['delivering', 'complete', 'needs_owner', 'failed'],
  /** Recoverable: a failed fulfilment can be retried or handed to the owner. */
  failed: ['fulfilling', 'needs_owner', 'cancelled'],
  expired: ['cancelled'],
  /** A cancelled order that was already paid may still be refunded. */
  cancelled: ['refunded'],
  refunded: [],
};

export const isSellerOrderTransitionAllowed = (
  from: SellerOrderPhase,
  to: SellerOrderPhase,
): boolean => SELLER_ORDER_PHASE_TRANSITIONS[from].includes(to);

/** ── Identity (F7) — TWO identifiers, not one ────────────────────────────────
 *
 *  `order.open` cannot be both deterministic (for idempotency) and unguessable
 *  (for the §6.3a confirm handle): deterministic IS guessable. So it mints both.
 */

/** Deterministic, and the idempotency + provider-correlation anchor.
 *
 *  ⛔ It is GUESSABLE by construction, so it must NEVER reach a VISITOR — not in a
 *  rendered page, not in a URL, not in a form field. (It does legitimately reach
 *  the PROVIDER, as `client_reference_id`: that is the whole point of the
 *  correlation, and it is how the webhook leg finds its way back to this order.)
 *  The visitor-facing id is `order_handle`, and the distinction is exactly why
 *  F7 mints two: a deterministic id cannot also be an unguessable one. */
export const SELLER_ORDER_KEY_PREFIX = 'ord' as const;

/** Stripe's documented ceiling for an `Idempotency-Key`. */
export const SELLER_ORDER_PROVIDER_IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export const SELLER_ORDER_CHECKOUT_IDEMPOTENCY_SUFFIX =
  ':checkout-session-create' as const;

/** Bounded so the DERIVED provider idempotency key still fits its ceiling.
 *  `sellerOrderCheckoutCorrelation` re-checks the real bound anyway — this is the
 *  cheap guard, that is the honest one. */
export const SELLER_ORDER_KEY_MAX_LENGTH = 200;

/** What an order may be keyed against. The order's idempotency anchor is the
 *  thing that CAUSED it, so the caller supplies a reference to that thing rather
 *  than a reception submission id specifically — §4.5 routes a D-196 tier
 *  subscription through this same lifecycle, and it has no submission.
 *
 *  `provider_invoice` is the D-196 renewal shape: one order per billing period
 *  (owner ruling 1), keyed on the provider invoice that caused it (ruling 2 —
 *  keying a renewal on the customer collides every period, and the invoice id
 *  is immutable and unique, so `openOrder`'s idempotency turns a redelivered
 *  `invoice.paid` into free replay safety). The kind names the SAME thing the
 *  ref points at — a submission-kind order carrying an invoice ref is the
 *  conflation the D-196 piece-5 fixture fix exists to forbid — and it is what
 *  `confirmOrderRenewalPayment` discriminates on: only an invoice-keyed order
 *  can be confirmed by invoice evidence. */
export const SELLER_ORDER_ORIGIN_KINDS = [
  'reception_submission',
  'seller_customer',
  'provider_invoice',
  'manual',
] as const;

export type SellerOrderOriginKind = (typeof SELLER_ORDER_ORIGIN_KINDS)[number];

export const isSellerOrderOriginKind = (
  value: unknown,
): value is SellerOrderOriginKind =>
  typeof value === 'string'
  && (SELLER_ORDER_ORIGIN_KINDS as readonly string[]).includes(value);

/** `/^[A-Za-z0-9_-]+$/` — note it admits neither `:` nor `.`, which is what makes
 *  the `:`-joined order key unambiguous (below). */
export const isSellerOrderOriginRef = (value: unknown): value is string =>
  isRecipeBundleSharedRowKeySegment(value);

/** A deterministic tuple, kept as a TUPLE rather than a delimiter-concatenated
 *  string so that neither segment can alias another identity by containing a
 *  chosen separator. (D-200's `PaidDocumentFulfillmentWorkflowKey` earned this
 *  comment; the reasoning is unchanged.) The string form below is a
 *  SERIALIZATION of it, and it is safe only because `isSellerOfferId` and
 *  `isSellerOrderOriginRef` both exclude `:`. */
export type SellerOrderKeyParts = readonly [offerId: string, originRef: string];

export const isSellerOrderKey = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  if (value.length > SELLER_ORDER_KEY_MAX_LENGTH) return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  return parts[0] === SELLER_ORDER_KEY_PREFIX
    && isSellerOfferId(parts[1])
    && isSellerOrderOriginRef(parts[2]);
};

export const sellerOrderKey = (
  offerId: unknown,
  originRef: unknown,
): string | null => {
  if (!isSellerOfferId(offerId)) return null;
  if (!isSellerOrderOriginRef(originRef)) return null;
  const key = [SELLER_ORDER_KEY_PREFIX, offerId, originRef].join(':');
  return key.length <= SELLER_ORDER_KEY_MAX_LENGTH ? key : null;
};

export const sellerOrderKeyParts = (
  orderKey: unknown,
): SellerOrderKeyParts | null => {
  if (!isSellerOrderKey(orderKey)) return null;
  const parts = orderKey.split(':');
  return [parts[1] as string, parts[2] as string];
};

/** The random, unguessable public token. The ONLY order id a visitor's confirm
 *  leg carries (§6.3a), and the only one that may appear in a rendered page or a
 *  URL. Minted server-side from a CSPRNG — never derived from `order_key`, which
 *  is deterministic and therefore guessable. */
export const SELLER_ORDER_HANDLE_PREFIX = 'oh_' as const;

/** 32 random bytes, hex-encoded. */
export const SELLER_ORDER_HANDLE_BYTES = 32;

const SELLER_ORDER_HANDLE_PATTERN = new RegExp(
  '^'
    + SELLER_ORDER_HANDLE_PREFIX
    + '[a-f0-9]{'
    + String(SELLER_ORDER_HANDLE_BYTES * 2)
    + '}$',
);

export const isSellerOrderHandle = (value: unknown): value is string =>
  typeof value === 'string' && SELLER_ORDER_HANDLE_PATTERN.test(value);

/** ── Provider correlation (F6) ───────────────────────────────────────────────
 *
 *  ⛔ Provider idempotency is NOT the local CAS. A crash between the local commit
 *  and the provider call re-runs on retry and mints a SECOND Checkout Session —
 *  Stripe is non-idempotent without an `Idempotency-Key`. D-200 already solved
 *  this, and the thinning must not collapse the crash-safety along with the 1,990
 *  steps: some of them were earning their keep.
 *
 *  ONE correlation source fans out to EVERY provider field. Callers never supply
 *  the five independently — three separately-passed workflow values are three
 *  values that can drift. */
export interface SellerOrderCheckoutCorrelation {
  readonly order_key: string;
  readonly idempotency_key: string;
  /** ⛔ THE ONLY CORRELATION FIELD THAT TOUCHES THE VISITOR — so it is the HANDLE,
   *  never the key.
   *
   *  The other four ride a server→provider API call and are never seen by anyone else.
   *  This one is different: under D-207 ruling (C) the owner pre-creates the hosted
   *  checkout link and the VISITOR clicks it, so the correlation has to travel on the
   *  URL (`?client_reference_id=…`) — through their browser, their history, their
   *  referrer. `order_key` is DETERMINISTIC and therefore guessable, which is the whole
   *  reason F7 minted a separate CSPRNG `order_handle` and said the key never leaves the
   *  server. Putting the key here would have handed every visitor a guessable address
   *  for other people's orders — and `core.seller.order.get` accepts EITHER id and is a
   *  `read`, so it ADMITS on a public door.
   *
   *  Re-deriving still works identically: the store holds both ids on the order row. */
  readonly client_reference_id: string;
  readonly session_metadata_order_key: string;
  readonly payment_intent_metadata_order_key: string;
  /** D-196 §4.5 — `body.subscription_data[metadata][recued_workflow_key]` on a
   *  subscription-mode Checkout Session. The ONLY correlation that survives onto
   *  later renewal invoices (Session metadata dies with the Session; PaymentIntent
   *  metadata never exists in subscription mode), so the renewal flow recovers the
   *  acquisition order — and its `entitlement_key` — from THIS field alone. */
  readonly subscription_metadata_order_key: string;
}

/** Takes the ORDER, not a bare key — `client_reference_id` needs the handle, and a
 *  signature that accepts only the key could not produce an honest correlation. */
export const sellerOrderCheckoutCorrelation = (
  order: { readonly order_key: unknown; readonly order_handle: unknown },
): SellerOrderCheckoutCorrelation | null => {
  const orderKey = order?.order_key;
  const orderHandle = order?.order_handle;
  if (!isSellerOrderKey(orderKey) || !isSellerOrderHandle(orderHandle)) return null;
  const idempotencyKey = orderKey + SELLER_ORDER_CHECKOUT_IDEMPOTENCY_SUFFIX;
  if (idempotencyKey.length > SELLER_ORDER_PROVIDER_IDEMPOTENCY_KEY_MAX_LENGTH) {
    return null;
  }
  return {
    order_key: orderKey,
    idempotency_key: idempotencyKey,
    client_reference_id: orderHandle,
    session_metadata_order_key: orderKey,
    payment_intent_metadata_order_key: orderKey,
    subscription_metadata_order_key: orderKey,
  };
};

/** ── The row ─────────────────────────────────────────────────────────────────
 *
 *  ⚠ There is deliberately NO `customer_email` column. D-200's
 *  `PaidDocumentFulfillmentDirectCheckoutSourceState` is a closed source LOCATOR
 *  that "contains no visitor bytes: the synchronous boundary must re-read the
 *  immutable encrypted Reception row … and only then resolve visitor.email."
 *  Denormalizing the address here would give the visitor's PII a second home
 *  outside that encrypted row. The order points at its ORIGIN; the origin owns
 *  the visitor bytes. A D-196 customer's address already lives on
 *  `seller_customers`, reachable via `customer_id`. */
export interface SellerOrder {
  /** PK. Deterministic — see F7. Internal; never rendered, never in a URL. */
  readonly order_key: string;
  /** The public handle. Unique. The only id a visitor ever sees. */
  readonly order_handle: string;

  readonly offer_id: string;
  readonly origin_kind: SellerOrderOriginKind;
  readonly origin_ref: string;

  readonly phase: SellerOrderPhase;

  /** Snapshotted from the offer at `order.open` so a later offer edit cannot
   *  retroactively change what a customer agreed to pay. */
  readonly pricing_kind: SellerOfferPricingKind;
  /** ⛔ SERVER-COMPUTED, from the owner-authored offer or from `order.quote`.
   *  No op accepts an amount from a caller, so no visitor value can reach it. */
  readonly amount_minor: number | null;
  readonly currency: string | null;
  readonly fulfillment_recipe_id: string | null;

  readonly customer_id: string | null;

  /** D-196 §4.5 — the tier this order SELLS, when it sells one. Snapshotted at
   *  `order.open` from the OPENING recipe (whose dish names the tier) and
   *  immutable after — no mutator touches it. Fulfilment must issue access from
   *  THIS field, never from its own dish, or a mis-set dish could issue a tier
   *  the order never sold.
   *
   *  The KEY, not a `tier_id`: `customer-access.issue` takes an entitlement key
   *  and resolves the template server-side, and the key survives a tier re-sync
   *  (tiers re-attach by `(door, lifecycle_source, entitlement_key)` while row
   *  ids do not). Null for orders that sell no standing access (a document, a
   *  quote). */
  readonly entitlement_key: string | null;

  /** D-196 1d — the offer's non-secret `fulfillment_config` (pointers the
   *  fulfillment recipe reads), snapshotted verbatim from the offer at
   *  `order.open` and immutable after — same immutability guarantee as
   *  `entitlement_key`, so a later offer edit cannot change what this order
   *  fulfils. Null for offers that carry no config. */
  readonly fulfillment_config: Readonly<Record<string, unknown>> | null;

  readonly provider: string | null;
  readonly provider_session_id: string | null;
  readonly provider_payment_id: string | null;
  readonly checkout_url: string | null;

  readonly artifact_ref: string | null;
  readonly artifact_hash: string | null;

  /** §4.4a — the OPTIONAL link to the obligation leg. Which rows a flow produces
   *  (commitment-only / order-only / both-linked) is a RECIPE decision; core
   *  provides the primitives and this link, and privileges none of the three. */
  readonly linked_work_entity_kind: WorkEntityKind | null;
  readonly linked_work_entity_id: string | null;

  readonly error_code: string | null;

  /** Optimistic-concurrency token. Every transition is CAS-guarded on it. */
  readonly revision: number;

  readonly created_at: number;
  readonly updated_at: number;
  readonly paid_at: number | null;
  /** When the pinned checkout expires. Pre-payment only — see the graph note. */
  readonly expires_at: number | null;
}

/** ── Owner list surface (D-207 order-is-the-lifecycle) ───────────────────────
 *
 *  The owner's persistent window into fulfilment. Orders are read most-recent-
 *  first and GROUPED at the view by `sellerOrderBucket(phase)` — the buckets are
 *  the index, so the view never re-derives its own phase→bucket table.
 *
 *  The clamp lives HERE, once, so the store's `listOrders` and the owner rpc that
 *  reports `truncated` cannot disagree about the effective page size (a second
 *  copy would let the two drift and report a wrong `truncated`).
 */
export const SELLER_ORDER_LIST_DEFAULT_LIMIT = 100;
export const SELLER_ORDER_LIST_MAX_LIMIT = 500;

/** Clamp a requested list limit to `[1, SELLER_ORDER_LIST_MAX_LIMIT]`, defaulting
 *  an absent limit to `SELLER_ORDER_LIST_DEFAULT_LIMIT`. */
export const clampSellerOrderListLimit = (limit: number | undefined): number =>
  Math.min(
    Math.max(limit ?? SELLER_ORDER_LIST_DEFAULT_LIMIT, 1),
    SELLER_ORDER_LIST_MAX_LIMIT,
  );

export interface SellerListOrdersRequest {
  /** Server-clamped to `[1, SELLER_ORDER_LIST_MAX_LIMIT]`; absent defaults to
   *  `SELLER_ORDER_LIST_DEFAULT_LIMIT`. */
  readonly limit?: number;
  /** Zero-based safe-integer row offset for owner-list pagination. */
  readonly offset?: number;
  /** Exact owner detail lookup. When present, offset is ignored and at most one
   * order is returned. */
  readonly order_key?: string;
}

export interface SellerListOrdersResponse {
  /** Most-recent-first (`created_at` DESC). The view groups these by
   *  `sellerOrderBucket(phase)`; the wire stays a flat list so the single
   *  phase→bucket source of truth is the shared `sellerOrderBucket`. */
  readonly orders: readonly SellerOrder[];
  /** True when more orders exist after this page. */
  readonly truncated: boolean;
}

/** ── The artifact pin ────────────────────────────────────────────────────────
 *
 *  ⛔ A `data.file` record id does NOT determine its bytes. The substrate says so
 *  in its own words — `PinnedCasFileRef` (`ingredient-catalog.ts`) exists for
 *  "workflows that have already committed an exact content hash and must ensure
 *  the cli receives those same bytes EVEN WHEN THE MUTABLE `data.file` RECORD ID
 *  IS CONCURRENTLY REPOINTED".
 *
 *  So a pin of `(artifact_ref, artifact_hash)` taken on the caller's word proves
 *  only that the CALLER is self-consistent. It does not prove the bytes behind the
 *  ref are the bytes that were reviewed — which is the entire question when the
 *  artifact is the thing a customer paid for. D-200's `artifact.approve` re-read
 *  and re-hashed the durable PDF through the `data.file` boundary for exactly this
 *  reason; the thinning must not drop it.
 *
 *  ⚠ The caller-supplied hash is NOT a value to distrust and strip — it is the
 *  owner's ASSERTION OF WHICH BYTES THEY REVIEWED, and it is the consent anchor.
 *  Deriving the hash from whatever the file currently holds would pin bytes nobody
 *  approved. The fix is to CHECK the assertion against source truth, not remove it.
 *
 *  ⇒ Only a verified pin may reach the store, and this is the only thing that
 *  produces one. The reader is injected, so there is ONE implementation of the
 *  check and every consumer — the `attach-artifact` op, the order sweepers, the
 *  delivery leg — is fenced by the same code rather than by its own copy. */
export type SellerOrderArtifactPinRefusal =
  | 'malformed_ref'
  | 'malformed_hash'
  | 'unreadable'
  | 'hash_mismatch';

export type SellerOrderArtifactPinResult =
  | { readonly ok: true; readonly pin: PinnedCasFileRef }
  | {
    readonly ok: false;
    readonly reason: SellerOrderArtifactPinRefusal;
    readonly detail: string;
  };

/** Reads the CAS bytes behind a `data.file` record id and returns their verified
 *  content hash. Backed by `dataFileRead` — the server file handler, which reads
 *  the CAS bytes and verifies `blob_hash`. */
export type SellerOrderCasFileReader = (input: {
  record_id: string;
}) => Promise<{ readonly blob_hash: string }>;

export const verifySellerOrderArtifactPin = async (
  claim: { readonly artifact_ref: unknown; readonly artifact_hash: unknown },
  readCasFile: SellerOrderCasFileReader,
): Promise<SellerOrderArtifactPinResult> => {
  const candidate = {
    backing: 'cas' as const,
    record_id: claim.artifact_ref,
    content_sha256: claim.artifact_hash,
  };
  // `isPinnedCasFileRef` owns BOTH formats — the `file:<32hex>` record id and the
  // lowercase SHA-256 — so neither is re-typed here beside the thing it guards.
  if (!isPinnedCasFileRef(candidate)) {
    return typeof claim.artifact_ref === 'string'
        && /^file:[0-9a-f]{32}$/.test(claim.artifact_ref)
      ? {
        ok: false,
        reason: 'malformed_hash',
        detail: 'artifact_hash must be a lowercase SHA-256',
      }
      : {
        ok: false,
        reason: 'malformed_ref',
        detail: 'artifact_ref must be a data.file CAS record id',
      };
  }

  let actual: { readonly blob_hash: string };
  try {
    actual = await readCasFile({ record_id: candidate.record_id });
  } catch (error) {
    // ⛔ An unreadable artifact NEVER pins. Failing open here would let a deleted
    // or unreachable record pin as "approved" and be delivered later.
    return {
      ok: false,
      reason: 'unreadable',
      detail: `artifact '${candidate.record_id}' could not be read: ${String(error)}`,
    };
  }

  if (actual.blob_hash !== candidate.content_sha256) {
    return {
      ok: false,
      reason: 'hash_mismatch',
      detail:
        `artifact '${candidate.record_id}' holds '${actual.blob_hash}', `
        + `not the asserted '${candidate.content_sha256}'`,
    };
  }

  return { ok: true, pin: candidate };
};
