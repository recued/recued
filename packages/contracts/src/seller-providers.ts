/** D-196 — the ONE seller provider registry (consolidation, 2026-09-03).
 *
 *  Before this file the same three providers were listed four times: a
 *  product-sync list here in contracts, a reconcile table and a product-sync
 *  table in the server, and a table inside the recipe generator — plus the
 *  readiness keys, the Settings form's select, and the corpus ratchets each
 *  naming the providers again by hand. Every one of those now derives from
 *  this table, and a fourth provider is one row here plus its catalog, its
 *  webhook profile, and its recipes.
 *
 *  What a row carries is exactly what differs per provider and is not itself
 *  a policy: which vendor's connections qualify, which bounded catalog the
 *  seller lanes read through, which webhook profile its packs bind, what a
 *  TIER is keyed on, how its ids are shaped, and the provider's own words for
 *  the live subscription statuses. The policy (`reconcileOne`, the status
 *  policy, the order store's evidence checks) stays provider-neutral. */
import type { SellerOverviewReadinessKey, SellerProviderSource } from './seller.js';
import type { WebhookProfileId } from './webhook-profiles.js';

/** What a tier's `entitlement_key` names at the provider. Stripe has an
 *  entitlement FEATURE layer (`lookup_key`s); Paddle and Lemon Squeezy do
 *  not, and the durable identity a subscription carries is its PRODUCT. */
export type SellerProviderTierIdentity = 'entitlement_feature' | 'product';

export interface SellerProviderSpec {
  readonly source: SellerProviderSource;
  /** `resolveConnectionVendor` word for connections that qualify. */
  readonly vendor: string;
  /** Owner-facing name. */
  readonly label: string;
  /** The bounded seller catalog (`community/packs/<slug>.json`). */
  readonly catalog_slug: string;
  /** The webhook profile the provider's event packs bind. */
  readonly webhook_profile_id: WebhookProfileId;
  /** The Settings → Seller readiness row that gates the tier seed. */
  readonly readiness_key: SellerOverviewReadinessKey;
  readonly tier_identity: SellerProviderTierIdentity;
  /** The catalog operation the owner-clicked tier seed reads. */
  readonly tier_seed_operation: string;
  /** Lemon Squeezy's product list is store-scoped. */
  readonly tier_seed_requires_store_id: boolean;
  /** Regex sources — kept as strings so the registry stays JSON-shaped and
   *  a recipe generator can carry the same grammar. */
  readonly customer_id_pattern: string;
  readonly subscription_id_pattern: string;
  /** Provider spellings of the canonical live statuses
   *  (`ACCESS_LIVE_STATUSES`): canonical → provider word. Lemon Squeezy says
   *  `on_trial` where the others say `trialing`. */
  readonly live_status_aliases: Readonly<Record<string, string>>;
  /** Suffix of the provider's recipe ids (`swap-tier-on-subscription-change`
   *  + suffix). Stripe's lanes predate the suffix convention. */
  readonly recipe_suffix: string;
}

export const SELLER_PROVIDERS = [
  {
    source: 'stripe',
    vendor: 'stripe',
    label: 'Stripe',
    catalog_slug: 'seller-stripe',
    webhook_profile_id: 'stripe.event.v1',
    readiness_key: 'stripe_provider',
    tier_identity: 'entitlement_feature',
    tier_seed_operation: 'entitlement_feature.search',
    tier_seed_requires_store_id: false,
    customer_id_pattern: '^cus_[A-Za-z0-9]+$',
    subscription_id_pattern: '^sub_[A-Za-z0-9]+$',
    live_status_aliases: {},
    recipe_suffix: '',
  },
  {
    source: 'paddle',
    vendor: 'paddle',
    label: 'Paddle',
    catalog_slug: 'seller-paddle',
    webhook_profile_id: 'paddle.notification.v1',
    readiness_key: 'paddle_provider',
    tier_identity: 'product',
    tier_seed_operation: 'product.search',
    tier_seed_requires_store_id: false,
    customer_id_pattern: '^ctm_[a-z0-9]+$',
    subscription_id_pattern: '^sub_[a-z0-9]+$',
    live_status_aliases: {},
    recipe_suffix: '-paddle',
  },
  {
    source: 'lemonsqueezy',
    vendor: 'lemonsqueezy',
    label: 'Lemon Squeezy',
    catalog_slug: 'seller-lemonsqueezy',
    webhook_profile_id: 'lemonsqueezy.webhook.v1',
    readiness_key: 'lemonsqueezy_provider',
    tier_identity: 'product',
    tier_seed_operation: 'product.search',
    tier_seed_requires_store_id: true,
    customer_id_pattern: '^[0-9]+$',
    subscription_id_pattern: '^[0-9]+$',
    live_status_aliases: { trialing: 'on_trial' },
    recipe_suffix: '-lemonsqueezy',
  },
] as const satisfies readonly SellerProviderSpec[];

export const SELLER_PROVIDER_SOURCES = SELLER_PROVIDERS.map(
  (provider) => provider.source,
) as readonly SellerProviderSource[];

export const isSellerProviderSource = (value: unknown): value is SellerProviderSource =>
  typeof value === 'string'
  && (SELLER_PROVIDER_SOURCES as readonly string[]).includes(value);

export const sellerProviderFor = (source: SellerProviderSource): SellerProviderSpec =>
  SELLER_PROVIDERS.find((provider) => provider.source === source)!;

/** Provider word → canonical live status, folded over every provider. The
 *  reconciler's liveness predicate and the corpus ratchets consume this so a
 *  provider's spelling is declared once, in its registry row. */
export const SELLER_PROVIDER_LIVE_STATUS_ALIASES: Readonly<Record<string, string>> =
  Object.freeze(
    Object.fromEntries(
      SELLER_PROVIDERS.flatMap((provider) =>
        Object.entries(provider.live_status_aliases).map(
          ([canonical, word]) => [word, canonical] as const,
        )),
    ),
  );
