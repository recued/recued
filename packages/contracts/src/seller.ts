/** D-196 Seller Economy — shared seller substrate row shapes.
 *
 *  Customer contracts remain ordinary `contract_definition` rows. These shapes
 *  describe the adjacent seller tables that pair a source-qualified customer to
 *  a tier, customer contract, inbound token, lifecycle state, and usage rollups.
 */

import type { AuthorableDoorType, DoorType } from './contract-definition.js';
import type { ConvergentWriteResult } from './convergent-write.js';

/** Core-owned Seller offer vocabulary. Authors may compose recipes against
 * these rows, but cannot add offer kinds, database columns, operations, or UI
 * surfaces. Pack/publisher/version are intentionally absent: distribution
 * provenance is not Seller identity or authority.
 *
 * D-207 §4.1 — `kind` is DISPLAY METADATA only. The engine reads solely
 * `pricing_kind` and `fulfillment_recipe_id` to decide how an order runs; the
 * kind labels the catalog entry for a human. The single pre-D-207 value
 * `one_time_outcome` is superseded by `document` and remapped on the stored
 * `seller_offers` rows by the `ensureSellerSchema` converger. */
export const SELLER_OFFER_KINDS = [
  'document',
  'service',
  'event',
  'reservation',
  'physical',
  'access',
] as const;
export type SellerOfferKind = (typeof SELLER_OFFER_KINDS)[number];
export const SELLER_OFFER_ID_MAX_LENGTH = 128;

/** Stable local Seller identity shared by core storage and recipe-owned
 * association descriptors. This proves syntax only, never row existence or
 * recipe authority. */
export const isSellerOfferId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= SELLER_OFFER_ID_MAX_LENGTH
  && value.trim() === value
  && /^[a-z0-9][a-z0-9._-]*$/.test(value);

/** D-207 §4.1 widens the pricing vocabulary. `fixed` (a set price) and
 * `unspecified` (the quote-request flow — owner prices it, then the customer
 * pays) already carry their full amount/currency shape at the storage layer;
 * `free` and `recurring` are the new members. Their amount/currency
 * consistency rules are declared by `SELLER_OFFER_PRICING_REQUIRES_AMOUNT`
 * below (D-207 §4.4a): `free` has no payment leg, `recurring` is a fixed-shaped
 * price billed on a cycle. */
export const SELLER_OFFER_PRICING_KINDS = [
  'fixed',
  'unspecified',
  'free',
  'recurring',
] as const;
export type SellerOfferPricingKind = (typeof SELLER_OFFER_PRICING_KINDS)[number];

export const SELLER_OFFER_STATES = ['draft', 'active', 'paused', 'archived'] as const;
export type SellerOfferState = (typeof SELLER_OFFER_STATES)[number];

export const isSellerOfferKind = (value: unknown): value is SellerOfferKind =>
  typeof value === 'string' && (SELLER_OFFER_KINDS as readonly string[]).includes(value);

export const isSellerOfferPricingKind = (
  value: unknown,
): value is SellerOfferPricingKind =>
  typeof value === 'string'
  && (SELLER_OFFER_PRICING_KINDS as readonly string[]).includes(value);

/** Whether an offer's `pricing_kind` carries a concrete up-front price.
 *
 *  `fixed` and `recurring` are PRICED — a positive `amount_minor` plus a
 *  `currency` (recurring is a fixed-shaped price billed on a cycle). `unspecified`
 *  (the owner prices it later) and `free` (no payment leg at all) are UNPRICED —
 *  both `amount_minor` and `currency` are null.
 *
 *  ⛔ This is the ONE source of truth for that partition. The `seller_offers`
 *  amount/currency storage CHECK and `ensureOffer`'s runtime validation both
 *  DERIVE from it, so a newly-added `pricing_kind` cannot land with the SQL fence
 *  and the application check disagreeing. The `satisfies Record` makes the map
 *  exhaustive: adding a member to `SELLER_OFFER_PRICING_KINDS` is a compile error
 *  until its amount rule is stated here. */
export const SELLER_OFFER_PRICING_REQUIRES_AMOUNT = {
  fixed: true,
  recurring: true,
  unspecified: false,
  free: false,
} as const satisfies Readonly<Record<SellerOfferPricingKind, boolean>>;

export const sellerOfferPricingRequiresAmount = (
  pricing_kind: SellerOfferPricingKind,
): boolean => SELLER_OFFER_PRICING_REQUIRES_AMOUNT[pricing_kind];

export const isSellerOfferState = (value: unknown): value is SellerOfferState =>
  typeof value === 'string' && (SELLER_OFFER_STATES as readonly string[]).includes(value);

/** Owner-only lifecycle graph. Recipe-authored Seller operations cannot call
 * this surface. Archive is terminal; pause means an offer was previously
 * active, so draft -> paused is intentionally absent. */
export const SELLER_OFFER_STATE_TRANSITIONS: Readonly<
  Record<SellerOfferState, readonly SellerOfferState[]>
> = {
  draft: ['active', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [],
};

export const isSellerOfferStateTransitionAllowed = (
  from: SellerOfferState,
  to: SellerOfferState,
): boolean => SELLER_OFFER_STATE_TRANSITIONS[from].includes(to);

/** One core Seller row. `created_by_recipe_id` and
 * `fulfillment_recipe_id` are optional provenance/navigation references only.
 * Creator provenance authorizes the fixed one-way fulfillment attachment;
 * creator or fulfillment provenance may authorize navigation-only task links.
 * Neither reference grants general update or transaction authority or is
 * qualified by a publisher or pack version. */
export interface SellerOffer {
  readonly offer_id: string;
  readonly kind: SellerOfferKind;
  readonly display_name: string;
  readonly description: string;
  readonly pricing_kind: SellerOfferPricingKind;
  readonly amount_minor: number | null;
  readonly currency: string | null;
  readonly fulfillment_recipe_id: string | null;
  /** D-196 1d — a NON-SECRET generic config map the fulfillment recipe reads to
   *  know WHAT to fulfil: pointers like `{ entitlement_key, template_key, url }`.
   *  Snapshotted onto the ORDER at `order.open` (like `entitlement_key`) so a
   *  later offer edit cannot change what a customer already bought.
   *
   *  ⛔ Values are POINTERS that resolve to human-authored authority server-side
   *  (I-1: a recipe may never name grants; `entitlement_key` here resolves a
   *  human-authored tier/template). And NON-SECRET only: the offer row is read by
   *  the fulfillment recipe (and any model in the loop), so anything a fulfillment
   *  must use-but-not-reveal (a real credential) goes by vault/connection
   *  reference resolved at point of use, never plaintext here. */
  readonly fulfillment_config: Readonly<Record<string, unknown>> | null;
  /** D-207 §5.5a — an owner-created, provider-hosted checkout URL (a Stripe
   *  Payment Link, a Mollie hosted checkout, …). It is what lets a PUBLIC
   *  reception form sell without performing a single write.
   *
   *  A visitor's submit runs as `actor: 'anonymous'`, which slice 1a pins to a
   *  contracted `read` trust ceiling; a Checkout-Session CREATE is a `write`, so
   *  it resolves to `ask` and HOLDS at the D-157 gate — and no `open` session
   *  grant can ever relax it, because the taint walk is structurally unreachable
   *  for reception (an op-step output refuses the walk; `context.reception_submission`
   *  is not on the closed origin table; `seller_offers` is not in the clean-stored
   *  grammar). A held checkout means a thank-you page and a customer who was never
   *  asked to pay — the D-207 slice-1c lie, reborn.
   *
   *  ⇒ The owner creates the checkout link ONCE, in advance, on their own channel.
   *  The public page RENDERS it (a `link_button`). Zero anonymous writes, and
   *  payment CONFIRMATION still arrives on the `webhook` channel, which IS
   *  taint-trusted and carries owner authority. */
  readonly checkout_url: string | null;
  readonly state: SellerOfferState;
  readonly created_by_recipe_id: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface SellerOfferEnsureResult {
  readonly result: 'created' | 'existing';
  readonly offer: SellerOffer;
}

/** One-way provenance/navigation attachment. Core accepts only the executing
 * creator recipe as the target; recipes cannot redirect an offer to another
 * recipe or replace an existing link. */
export interface SellerOfferFulfillmentAttachResult {
  readonly result: 'updated' | 'unchanged';
  readonly offer: SellerOffer;
}

export interface SellerOfferStateTransitionRequest {
  readonly offer_id: string;
  /** Semantic guard from the owner-visible row. */
  readonly expected_state: SellerOfferState;
  /** Exact optimistic row token. Paired with state so active -> paused ->
   * active cannot make a stale destructive request current again. */
  readonly expected_updated_at: number;
  readonly next_state: SellerOfferState;
}

export interface SellerOfferStateTransitionResult {
  readonly result: 'updated' | 'unchanged';
  readonly offer: SellerOffer;
}

/** Who drives a customer's access lifecycle. `manual` is the seller by hand;
 *  each provider member is a payment provider whose webhooks + read-backs
 *  issue, extend, swap and close access through the `core.seller.*` ops.
 *
 *  ⛔ WIDENING THIS LIST IS NOT ENOUGH ON ITS OWN. `seller_tiers` and
 *  `seller_customers` carry a `CHECK (lifecycle_source IN (…))` compiled from
 *  this const at CREATE time and frozen in every existing database — SQLite
 *  cannot ALTER a CHECK. `ensureSellerSchema` converges both tables onto the
 *  current list (a widening rebuild), which is what makes a new member REAL
 *  on a live server rather than a fresh-DB-only truth. Add the member here,
 *  and the converger admits it everywhere; retire one by moving it to
 *  `SELLER_RETIRED_LIFECYCLE_SOURCES`, and the converger narrows the CHECK
 *  (refusing, intact, a database that still holds a row under that source).
 *  Every provider member also has a row in `SELLER_PROVIDERS`
 *  (`seller-providers.ts`) — that registry is where its catalog, webhook
 *  profile, and tier identity live. */
export const SELLER_LIFECYCLE_SOURCES = [
  'manual',
  'stripe',
  'paddle',
  'lemonsqueezy',
] as const;

/** Members the vocabulary once carried. `future_provider` was the placeholder
 *  that proved the seam before a real second provider existed; the third
 *  provider retired it (2026-09-03). Listed so the schema converger can
 *  recognise a CHECK compiled under an older list and narrow it. */
export const SELLER_RETIRED_LIFECYCLE_SOURCES = ['future_provider'] as const;

export type SellerLifecycleSource = (typeof SELLER_LIFECYCLE_SOURCES)[number];
/** A lifecycle source backed by a payment provider — everything but `manual`. */
export type SellerProviderSource = Exclude<SellerLifecycleSource, 'manual'>;

export const isSellerLifecycleSource = (
  value: unknown,
): value is SellerLifecycleSource =>
  typeof value === 'string'
  && (SELLER_LIFECYCLE_SOURCES as readonly string[]).includes(value);

export const SELLER_ACCESS_STATES = ['active', 'grace', 'closed'] as const;

export type SellerAccessState = (typeof SELLER_ACCESS_STATES)[number];

export const isSellerAccessState = (value: unknown): value is SellerAccessState =>
  typeof value === 'string'
  && (SELLER_ACCESS_STATES as readonly string[]).includes(value);

export const SELLER_CUSTOMER_CLOSE_REASONS = [
  'cancelled',
  'payment_failed',
  'refunded',
  'dispute',
  'seller_manual',
] as const;

export type SellerCustomerCloseReason = (typeof SELLER_CUSTOMER_CLOSE_REASONS)[number];

export const isSellerCustomerCloseReason = (
  value: unknown,
): value is SellerCustomerCloseReason =>
  typeof value === 'string'
  && (SELLER_CUSTOMER_CLOSE_REASONS as readonly string[]).includes(value);

export const SELLER_USAGE_KINDS = ['tool_call', 'chat_turn'] as const;

export type SellerUsageKind = (typeof SELLER_USAGE_KINDS)[number];

export const isSellerUsageKind = (value: unknown): value is SellerUsageKind =>
  typeof value === 'string'
  && (SELLER_USAGE_KINDS as readonly string[]).includes(value);

export const SELLER_USAGE_PERIOD_GRANULARITIES = ['day', 'month'] as const;

export type SellerUsagePeriodGranularity =
  (typeof SELLER_USAGE_PERIOD_GRANULARITIES)[number];

export const isSellerUsagePeriodGranularity = (
  value: unknown,
): value is SellerUsagePeriodGranularity =>
  typeof value === 'string'
  && (SELLER_USAGE_PERIOD_GRANULARITIES as readonly string[]).includes(value);

export interface SellerSettings {
  readonly default_grace_hours: number;
  readonly sender_mail_instance_id: string | null;
  readonly status_policy_json: Readonly<Record<string, unknown>>;
  readonly email_policy_json: Readonly<Record<string, unknown>>;
  /** D-196 §4.9 / I-7 — the one-time route-rights acknowledgment the owner
   *  records at the MONETIZATION BOUNDARY, before a PAID (seller-customer)
   *  `llm_gateway` turn may run. `_at` is the timestamp of the most recent
   *  acknowledgment; `_version` is the terms version acknowledged, so a future
   *  material change to what the owner is committing to re-prompts rather than
   *  riding a stale ack. Both null until acknowledged. A free/standing
   *  `llm_gateway` door (customer service, booking, internal tooling, the
   *  owner's own use) never needs this — I-6 keeps it silent. */
  readonly llm_gateway_paid_ack_at: number | null;
  readonly llm_gateway_paid_ack_version: string | null;
  readonly created_at: number | null;
  readonly updated_at: number | null;
}

/** D-196 §4.9 / I-7 — the current route-rights acknowledgment terms version.
 *  The gateway is a SPECIALIST application on a model, not a scope-less relay;
 *  when the owner monetizes it they confirm they hold the rights to serve
 *  paying customers on every route they use, the free pool included. Bump this
 *  ONLY on a material change to what the owner is committing to: a bump
 *  re-prompts every seller because a stored ack for an older version no longer
 *  satisfies `isLlmGatewayPaidAcknowledged`. */
export const LLM_GATEWAY_PAID_ACK_VERSION = 'route-rights-v1';

/** True iff the owner has recorded the CURRENT-version route-rights
 *  acknowledgment. This is the SINGLE source of truth for the paid-`llm_gateway`
 *  gate: the substrate enforces only *is a current acknowledgment on record*,
 *  never the rights judgment itself — a route's license status (local,
 *  license-free, a permissive free tier, a paid plan, the owner's own
 *  arrangement) is not machine-visible, so it stays the owner's call (I-7,
 *  [[feedback_substrate_enforces_humans_judge]]). */
export const isLlmGatewayPaidAcknowledged = (
  settings: Pick<
    SellerSettings,
    'llm_gateway_paid_ack_at' | 'llm_gateway_paid_ack_version'
  >,
): boolean =>
  settings.llm_gateway_paid_ack_at !== null
  && settings.llm_gateway_paid_ack_version === LLM_GATEWAY_PAID_ACK_VERSION;

/** The `door_id` every seller row carries when the owner does not choose one.
 *
 *  A door id is the OWNER'S NAMESPACE, not a reference: nothing at runtime
 *  looks a door up by it (verified 2026-09-03 — the handlers take it as a
 *  string, the store column is plain TEXT, and the only gate a customer token
 *  passes is the template's `door_types`). It partitions tier identity
 *  `(door_id, lifecycle_source, entitlement_key)` and customer identity
 *  `(lifecycle_source, source_customer_id, door_id)` so one server can sell
 *  two products whose tier keys clash. The webclient presents it as
 *  "Category", defaults it to this value, and keeps it behind Advanced; the
 *  provider packs ship the same default on their `door_id` variable. Keep the
 *  two in step — a pack answering a different category than the tiers were
 *  created under never finds its tier. */
export const SELLER_DEFAULT_DOOR_ID = 'main';

export interface SellerTier {
  readonly tier_id: string;
  /** Owner namespace — see {@link SELLER_DEFAULT_DOOR_ID}. */
  readonly door_id: string;
  readonly lifecycle_source: SellerLifecycleSource;
  readonly entitlement_key: string;
  readonly display_name: string;
  readonly template_contract_id: string;
  readonly external_entitlement_id: string | null;
  readonly usage_policy_json: Readonly<Record<string, unknown>>;
  readonly pass_duration_seconds: number | null;
  readonly customer_status_enabled_default: boolean;
  readonly active: boolean;
  readonly created_at: number;
  readonly updated_at: number;
}

/** D-196 §4.5 — the RECIPE-FACING projection of a tier, returned by
 *  `core.seller.tier.get` / `.list`. The full `SellerTier` row never crosses
 *  the recipe boundary.
 *
 *  ⛔ I-1: `template_contract_id` is the private authority pointer. The op
 *  family takes an entitlement KEY and the server resolves the template at
 *  issue time, so no recipe can read or name the tools and scopes a tier
 *  grants. `usage_policy_json` (owner policy) stays server-side with it.
 *
 *  `tier_id` is also withheld, deliberately: the recipe-facing tier identity
 *  is the entitlement KEY — `customer-access.issue` takes the key,
 *  `order.entitlement_key` snapshots the key, and the key survives a tier
 *  re-sync (rows re-attach by `(door_id, lifecycle_source, entitlement_key)`)
 *  while row ids do not. A recipe holding a row id would break on the first
 *  re-seed. */
export interface SellerTierPublic {
  readonly entitlement_key: string;
  readonly display_name: string;
  readonly lifecycle_source: SellerLifecycleSource;
  readonly external_entitlement_id: string | null;
  readonly pass_duration_seconds: number | null;
  readonly active: boolean;
}

/** The ONE projection. An explicit PICK, never a spread-minus: a field later
 *  added to `SellerTier` stays server-side until someone deliberately lists it
 *  here — new columns fail CLOSED at this boundary. */
export const toPublicSellerTier = (tier: SellerTier): SellerTierPublic => ({
  entitlement_key: tier.entitlement_key,
  display_name: tier.display_name,
  lifecycle_source: tier.lifecycle_source,
  external_entitlement_id: tier.external_entitlement_id,
  pass_duration_seconds: tier.pass_duration_seconds,
  active: tier.active,
});

export interface SellerCustomer {
  readonly customer_id: string;
  readonly lifecycle_source: SellerLifecycleSource;
  readonly source_customer_id: string;
  readonly door_id: string;
  /** Optional customer email. Never part of identity; retained for claim-link
   *  delivery, enrichment, and watcher workflows when a source provides it. */
  readonly email: string | null;
  readonly tier_id: string;
  readonly contract_id: string;
  readonly inbound_token_id: string | null;
  readonly mcp_token_id: string | null;
  readonly external_subscription_id: string | null;
  readonly source_status: string | null;
  readonly current_period_end: number | null;
  readonly grace_until: number | null;
  readonly access_state: SellerAccessState;
  readonly claim_email_sent_at: number | null;
  readonly claim_email_marker: string | null;
  readonly status_email_sent_at: number | null;
  readonly status_email_marker: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

/** D-250 § D — set a tier's usage policy, whatever minted the tier.
 *
 *  ⛔ THE ONLY WAY TO LIMIT A SYNCED TIER. `SellerManualTierUpsertRequest` pins
 *  `lifecycle_source: 'manual'`, and the store's tier upsert refuses when a
 *  stored tier's source differs — so before this, a Stripe-minted tier could
 *  not have a limit set on it through any path, and an absent policy means
 *  UNLIMITED. This request touches the policy and nothing else; identity stays
 *  owned by whatever minted the tier. */
export interface SellerTierUsagePolicyRequest {
  readonly tier_id: string;
  /** Per-kind policy, the same shape `usage_policy_json` already holds:
   *  `{ chat_turn: { period_granularity, period_limit, rate_limit_per_minute } }`.
   *  ⚠ An omitted kind is UNLIMITED — that is the shipped default and this
   *  request does not change it. Pass `{}` to clear all limits deliberately. */
  readonly usage_policy_json: Readonly<Record<string, unknown>>;
}

export interface SellerTierUsagePolicyResponse {
  readonly tier: SellerTier;
  /** Fresh overview, the same convention every seller mutation follows so the
   *  owner surface re-renders from one response instead of a second round-trip. */
  readonly overview: SellerOverview;
}

export interface SellerCustomerUsageRollup {
  readonly contract_id: string;
  readonly usage_kind: SellerUsageKind;
  readonly period_granularity: SellerUsagePeriodGranularity;
  readonly period_start: number;
  /** METERED work — reserved before the call, and what a plan's `period_limit`
   *  and `rate_limit_per_minute` are enforced against. */
  readonly units: number;
  /** D-250 § D — MEASURED provider cost of the metered work above.
   *
   *  ⛔ NOT A METER, AND A PLAN CANNOT LIMIT IT. Tokens are knowable only after
   *  a call returns, so they can never gate that call; `units` is the only
   *  enforceable dimension. These exist so the seller — who pays the inference
   *  bill — can see what a plan priced in turns actually COSTS, which was
   *  previously captured at the gateway and discarded.
   *
   *  ⚠ ABSENT means never measured (a row predating the columns, or a period
   *  whose work reported no usage). It never means zero, and a reader must not
   *  sum it as zero. */
  readonly tokens_input?: number;
  readonly tokens_output?: number;
  readonly tokens_total?: number;
  readonly provider_calls?: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export type SellerOverviewReadinessKey =
  | 'manual_lifecycle'
  | 'stripe_provider'
  // D-196 Paddle + Lemon Squeezy (2026-09-03) — one readiness row per
  // product-synchronizing provider; a client that predates them renders
  // the row from its label/detail like any other.
  | 'paddle_provider'
  | 'lemonsqueezy_provider'
  | 'mail_sender'
  | 'llm_gateway';

export type SellerOverviewReadinessState = 'ready' | 'needs_setup' | 'not_wired';

export interface SellerOverviewReadinessItem {
  readonly key: SellerOverviewReadinessKey;
  readonly state: SellerOverviewReadinessState;
  readonly label: string;
  readonly detail: string;
  /** In-app hash link hint. Frontends may normalize or ignore it. */
  readonly href: string | null;
}

export interface SellerOverviewCounts {
  readonly tiers: number;
  readonly active_tiers: number;
  readonly customers: number;
  readonly active_customers: number;
  readonly grace_customers: number;
  readonly closed_customers: number;
}

export interface SellerOverviewLlmGateway {
  /** True only when Settings -> LLM exposes a valid llm_gateway route. */
  readonly configured: boolean;
  /** False when the LLM config manager is absent or locked/unreadable. */
  readonly config_readable: boolean;
  readonly default_route: string | null;
  readonly model_alias: string | null;
  /** D-196 §4.9 / I-7 — timestamp of the most recent paid-gateway route-rights
   *  acknowledgment, or null if the owner has never acknowledged. */
  readonly paid_ack_at: number | null;
  /** True iff a CURRENT-version acknowledgment is on record. When false, a paid
   *  (seller-customer) `llm_gateway` chat turn fails closed until the owner
   *  acknowledges; free/standing turns and `/v1/models` discovery are
   *  unaffected. */
  readonly paid_acknowledged: boolean;
}

export interface SellerOverview {
  readonly settings: SellerSettings;
  readonly tiers: readonly SellerTier[];
  readonly customers: readonly SellerCustomer[];
  readonly usage_rollups: readonly SellerCustomerUsageRollup[];
  readonly counts: SellerOverviewCounts;
  readonly readiness: readonly SellerOverviewReadinessItem[];
  readonly llm_gateway: SellerOverviewLlmGateway;
  /** Core-owned offers. Optional for compatibility with older paired servers. */
  readonly offers?: readonly SellerOffer[];
}

export interface SellerOfferStateTransitionResponse
  extends SellerOfferStateTransitionResult {
  readonly overview: SellerOverview;
}

export interface SellerSettingsUpdateRequest {
  readonly default_grace_hours?: number;
  readonly sender_mail_instance_id?: string | null;
  readonly status_policy_json?: Readonly<Record<string, unknown>>;
  readonly email_policy_json?: Readonly<Record<string, unknown>>;
}

export interface SellerSettingsUpdateResponse {
  readonly settings: SellerSettings;
  readonly overview: SellerOverview;
}

/** D-196 §4.9 / I-7 — record the one-time paid-`llm_gateway` route-rights
 *  acknowledgment (the arm-time confirmation at the monetization boundary). The
 *  server stamps the timestamp and the current terms version. */
export interface SellerAcknowledgeLlmGatewayPaidRequest {
  /** The terms version the owner is confirming, as the client rendered it.
   *  Optional; when present it MUST equal the server's current
   *  `LLM_GATEWAY_PAID_ACK_VERSION`, so a stale client can never silently record
   *  an acknowledgment of terms it never displayed. Omit to accept the server's
   *  current terms. */
  readonly ack_version?: string;
}

export interface SellerAcknowledgeLlmGatewayPaidResponse {
  readonly settings: SellerSettings;
  readonly overview: SellerOverview;
}

export interface SellerManualTierUpsertRequest {
  readonly tier_id: string;
  readonly door_id: string;
  readonly entitlement_key: string;
  /** Required on create; omitted on update preserves the stored value. */
  readonly display_name?: string;
  /** Required on create; omitted on update preserves the stored value. */
  readonly template_contract_id?: string;
  readonly usage_policy_json?: Readonly<Record<string, unknown>>;
  readonly pass_duration_seconds?: number | null;
  readonly customer_status_enabled_default?: boolean;
  readonly active?: boolean;
}

export interface SellerManualTierUpsertResponse {
  readonly tier: SellerTier;
  readonly overview: SellerOverview;
}

/** D-196 1d Phase 2 — owner-authored one-time "pass" tier creation. Mints a
 *  zero-grant `customer_template` shell for the door AND binds a fresh tier to
 *  it in one call, removing the "hand-author a template first, then paste its
 *  contract id" friction that `upsertManualTier` requires. The tier carries the
 *  pass's three axes: `time` (`pass_duration_seconds`), `llm_limit` +
 *  `tool_limit` (`usage_policy_json.chat_turn` / `.tool_call`). The owner then
 *  authors the template's grants (which tools/data the pass permits) in
 *  #contracts — I-1 (a recipe/UI RPC never authors grants, only mints the empty
 *  shell the human fills) intact.
 *
 *  Like {@link SellerManualTierUpsertRequest} this NEVER accepts a lifecycle
 *  source or a `template_contract_id`: the server stamps `manual` (so provider
 *  sync jobs cannot be spoofed through this local UI RPC) and supplies the
 *  freshly-minted shell id itself. */
export interface SellerCreatePassTierRequest {
  readonly door_id: string;
  /** The level-1 door type the minted template is restricted to. Only the
   *  owner-authorable customer doors (`mcp` / `mcp_chat` / `llm_gateway`) — a
   *  pass on a derived door (`reception` / `webhook`) is nonsensical. */
  readonly door_type: AuthorableDoorType;
  readonly entitlement_key: string;
  readonly display_name: string;
  /** Pass lifetime in seconds — the `time` axis. Omit/null for no time bound
   *  (`issue` then stamps no expiry from the tier). */
  readonly pass_duration_seconds?: number | null;
  /** The `llm_limit` (`chat_turn`) + `tool_limit` (`tool_call`) axes, as the
   *  usage-policy JSON the admission layer reads. Omit for no usage caps. */
  readonly usage_policy_json?: Readonly<Record<string, unknown>>;
}

export interface SellerCreatePassTierResponse {
  /** The newly-created manual pass tier. */
  readonly tier: SellerTier;
  /** The freshly-minted zero-grant customer template — the deep-link target the
   *  owner opens in #contracts to author the pass's grants. */
  readonly template_contract_id: string;
  readonly overview: SellerOverview;
}

export interface SellerManualCustomerIssueRequest {
  readonly door_id: string;
  readonly source_customer_id: string;
  readonly entitlement_key: string;
  readonly email?: string | null;
  /** Manual delivery choice. Omitted/false leaves the short-lived claim link
   *  visible to the seller for out-of-band delivery. */
  readonly send_claim_email?: boolean;
  readonly current_period_end?: number | null;
  readonly source_status?: string | null;
}

/** Short-lived, single-use delivery capability for a customer bearer. The
 * long-lived bearer itself must never cross the seller RPC boundary. */
export interface SellerCustomerClaim {
  readonly claim_url: string;
  readonly expires_at: number;
}

/** Post-commit outcome for an explicitly requested claim email. A delivery
 * failure never implies that customer access or the returned claim rolled back. */
export type SellerCustomerClaimEmailDelivery =
  | {
      readonly status: 'sent';
      readonly message_id: string;
      readonly sent_at: number;
    }
  | {
      readonly status: 'failed';
      readonly error_code: string;
    };

/** The convergent-write outcome — see {@link ConvergentWriteResult}. */
export type SellerCustomerIssueOutcome = ConvergentWriteResult;

export interface SellerManualCustomerIssueResponse {
  readonly result: SellerCustomerIssueOutcome;
  readonly customer: SellerCustomer;
  /** Present only when `result === 'created'`. */
  readonly claim: SellerCustomerClaim | null;
  /** Non-null only when email delivery was requested for a newly created
   *  customer. Replayed `extended` issues never send mail. */
  readonly claim_email_delivery: SellerCustomerClaimEmailDelivery | null;
  readonly overview: SellerOverview;
}

export interface SellerManualCustomerTargetRequest {
  readonly customer_id?: string;
  readonly door_id?: string;
  readonly source_customer_id?: string;
}

export interface SellerManualCustomerExtendRequest extends SellerManualCustomerTargetRequest {
  readonly email?: string | null;
  readonly current_period_end?: number | null;
  readonly source_status?: string | null;
}

export interface SellerManualCustomerExtendResponse {
  readonly customer: SellerCustomer;
  readonly overview: SellerOverview;
}

export interface SellerManualCustomerSwapTierRequest extends SellerManualCustomerTargetRequest {
  readonly entitlement_key: string;
  readonly current_period_end?: number | null;
  readonly source_status?: string | null;
}

export interface SellerManualCustomerSwapTierResponse {
  readonly customer: SellerCustomer;
  readonly overview: SellerOverview;
}

export interface SellerManualCustomerCloseRequest extends SellerManualCustomerTargetRequest {
  readonly reason: SellerCustomerCloseReason;
  readonly source_status?: string | null;
}

export interface SellerManualCustomerCloseResponse {
  readonly customer: SellerCustomer;
  readonly overview: SellerOverview;
}

/** Security rotation only: the target is the entire request. The replacement
 * bearer preserves the customer contract, stamped grants, and token posture. */
export interface SellerManualCustomerReissueTokenRequest
  extends SellerManualCustomerTargetRequest {
  /** D-196 — when true, re-mint AND email the fresh one-time claim link to the
   *  customer's stored email via the seller's configured sender (the "Message
   *  customer" action). Omitted/false returns the claim for out-of-band delivery
   *  (the reissue-and-copy path). A delivery failure never rolls back the reissue
   *  or the returned claim. */
  readonly send_claim_email?: boolean;
}

export interface SellerManualCustomerReissueTokenResponse {
  readonly customer: SellerCustomer;
  readonly claim: SellerCustomerClaim;
  /** Post-commit outcome for an explicitly requested claim email. Null when
   *  `send_claim_email` was not set; a delivery failure never implies the reissue
   *  or the returned claim rolled back. */
  readonly claim_email_delivery?: SellerCustomerClaimEmailDelivery | null;
  readonly overview: SellerOverview;
}

export interface SellerManualTierBulkAdjustRequest {
  readonly tier_id: string;
  readonly customer_ids?: readonly string[];
}

export interface SellerManualTierBulkAdjustResponse {
  readonly tier: SellerTier;
  readonly adjusted_customers: readonly SellerCustomer[];
  readonly skipped_closed_customers: readonly SellerCustomer[];
  readonly overview: SellerOverview;
}

/** Owner-clicked Stripe entitlement bootstrap. `connection_name` may be omitted
 * only when exactly one synchronization-ready Stripe API connection exists;
 * the server never guesses between multiple ready provider accounts. */
export interface SellerStripeSynchronizeRequest {
  readonly connection_name?: string;
  readonly door_id: string;
  readonly door_type: DoorType;
}

/** D-196 consolidation (2026-09-03) — the ONE owner-clicked tier seed for
 *  every provider in `SELLER_PROVIDERS`. Reads the provider's tier identities
 *  (Stripe: entitlement features; Paddle / Lemon Squeezy: products) through
 *  its bounded seller catalog and folds them into tiers keyed on that
 *  identity. Same posture for every provider: `connection_name` may be
 *  omitted only when exactly one synchronization-ready connection of that
 *  provider exists; `store_id` is required where the registry says the seed is
 *  store-scoped (Lemon Squeezy) and refused elsewhere. The older
 *  `SellerStripeSynchronizeRequest` rpc stays as a Stripe-only alias of this. */
export interface SellerProviderTierSynchronizeRequest {
  readonly provider: SellerProviderSource;
  readonly connection_name?: string;
  readonly door_id: string;
  readonly door_type: DoorType;
  readonly store_id?: string;
}

/** Incremental classification: existing template authority is never
 *  rewritten, ids classify only tier/template lifecycle effects. */
export interface SellerProviderTierSynchronizeResponse {
  readonly provider: SellerProviderSource;
  readonly connection_name: string;
  /** Tier identities the provider reported (active features / products). */
  readonly records_seen: number;
  readonly created_tier_ids: readonly string[];
  readonly preserved_tier_ids: readonly string[];
  readonly recreated_template_tier_ids: readonly string[];
  readonly reactivated_tier_ids: readonly string[];
  readonly orphaned_tier_ids: readonly string[];
  readonly overview: SellerOverview;
}

/** Incremental synchronization result. Existing template authority is never
 * rewritten: IDs classify only tier/template lifecycle effects. */
export interface SellerStripeSynchronizeResponse {
  readonly connection_name: string;
  readonly features_seen: number;
  readonly created_tier_ids: readonly string[];
  readonly preserved_tier_ids: readonly string[];
  readonly recreated_template_tier_ids: readonly string[];
  readonly reactivated_tier_ids: readonly string[];
  readonly orphaned_tier_ids: readonly string[];
  readonly overview: SellerOverview;
}
