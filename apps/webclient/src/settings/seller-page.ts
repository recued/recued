/** D-196 + D-200 - core-owned Settings -> Seller consolidator.
 *
 *  Core owns this fixed menu/UI and its durable schema. Recipes compose against
 *  core Seller operations; installed pack identity is not an offer gate.
 */

import {
  LLM_GATEWAY_PAID_ACK_VERSION,
  SELLER_CUSTOMER_CLOSE_REASONS,
  SELLER_OFFER_STATE_TRANSITIONS,
  SELLER_ORDER_BUCKETS,
  sellerOrderBucket,
  type SellerAcknowledgeLlmGatewayPaidRequest,
  type SellerAcknowledgeLlmGatewayPaidResponse,
  type SellerCustomerCloseReason,
  type SellerManualCustomerCloseRequest,
  type SellerManualCustomerCloseResponse,
  type SellerManualCustomerExtendRequest,
  type SellerManualCustomerExtendResponse,
  type SellerManualCustomerIssueRequest,
  type SellerManualCustomerIssueResponse,
  type SellerManualCustomerReissueTokenRequest,
  type SellerManualCustomerReissueTokenResponse,
  type SellerManualCustomerSwapTierRequest,
  type SellerManualCustomerSwapTierResponse,
  type SellerManualTierBulkAdjustRequest,
  type SellerManualTierBulkAdjustResponse,
  type SellerManualTierUpsertRequest,
  type SellerTierUsagePolicyRequest,
  type SellerTierUsagePolicyResponse,
  SELLER_USAGE_KINDS,
  type SellerUsageKind,
  type SellerManualTierUpsertResponse,
  type SellerCreatePassTierRequest,
  type SellerCreatePassTierResponse,
  type SellerOfferState,
  type SellerOfferStateTransitionRequest,
  type SellerOfferStateTransitionResponse,
  type SellerSettingsUpdateRequest,
  type SellerSettingsUpdateResponse,
  type SellerStripeSynchronizeRequest,
  type SellerStripeSynchronizeResponse,
  type SellerProviderTierSynchronizeRequest,
  type SellerProviderTierSynchronizeResponse,
  type SellerProviderSource,
  SELLER_DEFAULT_DOOR_ID,
  SELLER_PROVIDERS,
  isSellerProviderSource,
  sellerProviderFor,
  type SellerCustomer,
  type SellerCustomerUsageRollup,
  type SellerOverview,
  type SellerOffer,
  type SellerOverviewReadinessItem,
  type SellerListOrdersRequest,
  type SellerListOrdersResponse,
  type SellerOrder,
  type SellerOrderBucket,
  type SellerTier,
} from '@recued/contracts';
import {
  REFERENCE_PROVENANCE_STYLES,
  createReferenceElement,
  formatClientDateTime,
} from '@recued/ui-shared';

import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import { serializeShellRoute } from '../shell/route.js';
import {
  LIST_PREVIEW_STYLES,
  focusListTarget,
  mountListPreview,
  readListContinuity,
  readListScroll,
  restoreListScroll,
  updateListContinuity,
} from '../shell/list-preview-continuity.js';
import {
  SELLER_SETUP_SECTIONS,
  SELLER_SUBPAGES,
  isSellerCollectionSubpage,
  isSellerCreateSubpage,
  isSellerSubpage,
  sellerAddressSelection,
  sellerCreateAddress,
  sellerDetailAddress,
  sellerDirectoryAddress,
  sellerListAddress,
  sellerSetupAddress,
  type SellerAddress,
  type SellerCollectionSubpage,
  type SellerCreateSubpage,
  type SellerCreateVariant,
  type SellerSetupSection,
  type SellerSubpage,
  type SellerTierDetailTab,
} from './seller-navigation.js';

export {
  SELLER_SETUP_SECTIONS,
  SELLER_SUBPAGES,
  isSellerSubpage,
  sellerCreateAddress,
  sellerDetailAddress,
  sellerListAddress,
  sellerSetupAddress,
} from './seller-navigation.js';
export type {
  SellerCreateVariant,
  SellerSetupSection,
  SellerSubpage,
  SellerTierDetailTab,
} from './seller-navigation.js';

export type SellerOverviewCaller = () => Promise<SellerOverview>;
/** D-196 1d — the shared `execute` rpc caller, narrowed to what this page needs.
 *  Deliberately shaped as "run a recipe by id with config", NOT as a per-action
 *  seller method: the point is that a new owner action costs a recipe, not a new
 *  rpc on every UI. */
export type SellerRecipeRunCaller = (args: {
  recipe_id: string;
  config?: Record<string, unknown>;
}) => Promise<{ success?: boolean; errors?: readonly unknown[] }>;
export type SellerOfferStateTransitionCaller = (
  request: SellerOfferStateTransitionRequest,
) => Promise<SellerOfferStateTransitionResponse>;
export interface SellerMailInstanceOption {
  readonly slug: string;
  readonly send_capable: boolean;
  readonly account_email: string;
}
export type SellerMailListCaller = () => Promise<{
  readonly instances: ReadonlyArray<SellerMailInstanceOption>;
}>;
export type SellerSettingsUpdateCaller = (
  request: SellerSettingsUpdateRequest,
) => Promise<SellerSettingsUpdateResponse>;
export type SellerTierUsagePolicyCaller = (
  request: SellerTierUsagePolicyRequest,
) => Promise<SellerTierUsagePolicyResponse>;

export type SellerManualTierUpsertCaller = (
  request: SellerManualTierUpsertRequest,
) => Promise<SellerManualTierUpsertResponse>;
export type SellerCreatePassTierCaller = (
  request: SellerCreatePassTierRequest,
) => Promise<SellerCreatePassTierResponse>;
export type SellerManualCustomerIssueCaller = (
  request: SellerManualCustomerIssueRequest,
) => Promise<SellerManualCustomerIssueResponse>;
export type SellerManualCustomerExtendCaller = (
  request: SellerManualCustomerExtendRequest,
) => Promise<SellerManualCustomerExtendResponse>;
export type SellerManualCustomerSwapTierCaller = (
  request: SellerManualCustomerSwapTierRequest,
) => Promise<SellerManualCustomerSwapTierResponse>;
export type SellerManualCustomerCloseCaller = (
  request: SellerManualCustomerCloseRequest,
) => Promise<SellerManualCustomerCloseResponse>;
export type SellerManualCustomerReissueTokenCaller = (
  request: SellerManualCustomerReissueTokenRequest,
) => Promise<SellerManualCustomerReissueTokenResponse>;
export type SellerManualTierBulkAdjustCaller = (
  request: SellerManualTierBulkAdjustRequest,
) => Promise<SellerManualTierBulkAdjustResponse>;
export type SellerStripeSynchronizeCaller = (
  request: SellerStripeSynchronizeRequest,
) => Promise<SellerStripeSynchronizeResponse>;
/** D-196 consolidation — the ONE tier seed for every provider. */
export type SellerProviderTierSynchronizeCaller = (
  request: SellerProviderTierSynchronizeRequest,
) => Promise<SellerProviderTierSynchronizeResponse>;
export type SellerAcknowledgeLlmGatewayPaidCaller = (
  request: SellerAcknowledgeLlmGatewayPaidRequest,
) => Promise<SellerAcknowledgeLlmGatewayPaidResponse>;
export type SellerListOrdersCaller = (
  request: SellerListOrdersRequest,
) => Promise<SellerListOrdersResponse>;

export type SellerPagePhase = 'loading' | 'ready' | 'error';

const SELLER_SUBPAGE_META: Readonly<Record<
  SellerSubpage,
  { readonly label: string; readonly description: string }
>> = {
  overview: {
    label: 'Overview',
    description: 'A quick look at your offers, your customers, and how your shop is set up.',
  },
  offers: {
    label: 'Offers',
    description: 'Publish and manage the outcomes customers can buy.',
  },
  orders: {
    label: 'Orders',
    description: 'Follow each sale from payment to delivery, and sort out the ones that need you.',
  },
  tiers: {
    label: 'Tiers',
    description: 'Set up the packages people can buy, what each one allows, and the agreement behind it.',
  },
  customers: {
    label: 'Customers',
    description: 'Give people access, and look after their agreements.',
  },
  usage: {
    label: 'Usage',
    description: 'See how much each customer has used, and when.',
  },
  setup: {
    label: 'Setup',
    description: 'Your normal settings, who takes the payments, and paid AI access. Each has its own page.',
  },
};

/** The three setup screens, each its own address (`#settings/seller/setup/<section>`). */
const SELLER_SETUP_SECTION_META: Readonly<Record<
  SellerSetupSection,
  { readonly label: string; readonly description: string }
>> = {
  defaults: {
    label: 'Defaults',
    description: 'How long you give people, what emails go out, and which mailbox sends them.',
  },
  providers: {
    label: 'Providers',
    description: 'Bring your packages in from whoever takes your payments: Stripe, Paddle or Lemon Squeezy.',
  },
  gateway: {
    label: 'Paid AI access',
    description: 'The AI access customers can buy, and the one-off note they see when they pay.',
  },
};

/** The create screens (`#settings/seller/<collection>/new[/<variant>]`). */
const SELLER_CREATE_META: Readonly<Record<
  SellerCreateSubpage,
  Readonly<Record<string, { readonly label: string; readonly description: string }>>
>> = {
  tiers: {
    manual: {
      label: 'New package you run yourself',
      description: 'Add a package you look after yourself, or open one you already have.',
    },
    pass: {
      label: 'New timed pass',
      description: 'Make a pass that runs out, with its own agreement.',
    },
  },
  customers: {
    manual: {
      label: 'Give someone access',
      description: 'Put someone on a package you run yourself, and give them their one-off link.',
    },
  },
};

/** A tier record's screens beyond the record itself. */
const SELLER_TIER_TAB_META: Readonly<Record<
  SellerTierDetailTab,
  { readonly label: string; readonly description: string }
>> = {
  edit: {
    label: 'Edit',
    description: 'Change this package\'s name, agreement, limits and status.',
  },
  customers: {
    label: 'Customers',
    description: 'Change everyone on this package at the same time.',
  },
};

const SELLER_DEFAULT_PAGE_SIZE = 25;
const SELLER_MAX_PAGE_SIZE = 100;

const usageRollupId = (rollup: SellerCustomerUsageRollup): string =>
  `${rollup.contract_id}:${rollup.usage_kind}:${rollup.period_granularity}:${rollup.period_start}`;

const positiveWholeNumber = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export interface SellerPageState {
  readonly phase: SellerPagePhase;
  /** `null` is the Seller feature directory (`#settings/seller`). */
  readonly subpage: SellerSubpage | null;
  readonly selectedItemId: string | null;
  readonly page: number;
  /** The deeper levels only an address names. */
  readonly tab: SellerTierDetailTab | null;
  readonly create: SellerCreateVariant | null;
  readonly setupSection: SellerSetupSection | null;
  readonly setupProvider: SellerProviderSource | null;
  readonly overview: SellerOverview | null;
  readonly error: string | null;
}

type SellerFormMessage = {
  readonly kind: 'success' | 'error';
  readonly text: string;
};

type SellerManualCustomerLifecycleResponse =
  | SellerManualCustomerExtendResponse
  | SellerManualCustomerSwapTierResponse
  | SellerManualCustomerCloseResponse
  | SellerManualCustomerReissueTokenResponse;

export interface MountSellerPageOptions {
  host: HTMLElement;
  document?: Document;
  /** Shell-owned scrolling element used for collection return continuity. */
  scrollRoot?: HTMLElement;
  /** Navigate to a Seller address after preview. Production delegates this to
   *  the shell router; an embedded mount falls back to `location.hash`. */
  onNavigate?: (hash: string, mode: 'push' | 'replace') => void;
  /** Canonical parsed Seller address. Production passes this single typed
   * selection; the legacy initial* fields remain as narrow mount/test seams. */
  initialAddress?: SellerAddress;
  /** Initial `#settings/seller/<subpage>` selection. Unknown values fail safely
   * to the Seller directory so a stale bookmark never produces an empty view. */
  initialSubpage?: string | null;
  /** Collection item selected by
   * `#settings/seller/<subpage>/detail/<item-id>`. */
  initialItemId?: string | null;
  /** One-based list page selected by `#settings/seller/<subpage>/page/<n>`. */
  initialPage?: string | number | null;
  /** Test/layout seam. Production defaults to 25 rows per collection page. */
  pageSize?: number;
  runGetOverview: SellerOverviewCaller;
  /** D-200 Slice 6e — owner-only state controls. Narrowed hosts may omit this
   *  caller and keep outcome offers read-only. */
  runTransitionOfferState?: SellerOfferStateTransitionCaller;
  /** D-196 §4.7 — live `collection.mail.list` source for the explicit
   *  send-capable sender chooser. Optional for older paired servers. */
  runListMailInstances?: SellerMailListCaller;
  runUpdateSellerSettings?: SellerSettingsUpdateCaller;
  runUpsertManualTier?: SellerManualTierUpsertCaller;
  /** D-250 § D — set usage limits on ANY tier. Optional so an older paired
   *  server simply renders the limits read-only instead of erroring. */
  runSetTierUsagePolicy?: SellerTierUsagePolicyCaller;
  runCreatePassTier?: SellerCreatePassTierCaller;
  runIssueManualCustomer?: SellerManualCustomerIssueCaller;
  runExtendManualCustomer?: SellerManualCustomerExtendCaller;
  runSwapManualCustomerTier?: SellerManualCustomerSwapTierCaller;
  runCloseManualCustomer?: SellerManualCustomerCloseCaller;
  runReissueManualCustomerToken?: SellerManualCustomerReissueTokenCaller;
  runBulkAdjustManualTierCustomers?: SellerManualTierBulkAdjustCaller;
  /** The shipped Stripe-only seed rpc — kept as the fallback the unified form
   *  uses against a paired server that predates `runSynchronizeProviderTiers`. */
  runSynchronizeStripeEntitlements?: SellerStripeSynchronizeCaller;
  /** D-196 consolidation — the ONE tier seed for every provider. */
  runSynchronizeProviderTiers?: SellerProviderTierSynchronizeCaller;
  /** D-196 §4.9 / I-7 — records the one-time paid-`llm_gateway` route-rights
   *  acknowledgment. When unwired (older paired servers / test hosts), the
   *  acknowledgment control is hidden and the read-only ack state still renders. */
  runAcknowledgeLlmGatewayPaid?: SellerAcknowledgeLlmGatewayPaidCaller;
  /** D-207 order-is-the-lifecycle — the owner Orders view read caller. When the
   *  caller is not wired (narrowed / test hosts), the Orders section is hidden
   *  entirely; a wired caller that fails at runtime shows an error in-section. */
  runListOrders?: SellerListOrdersCaller;
  /** D-196 1d — the GENERIC recipe runner (`execute` rpc), not a per-action
   *  seller rpc. An order advances through its own operations; this view only
   *  launches one, so recovering a stranded order needed no new backend surface.
   *  Omit it and the Close action simply does not render. */
  runRecipe?: SellerRecipeRunCaller;
  /** Re-read the orders list after an action that changes one. */
  reloadOrders?: () => void;
}

export interface SellerPageMount {
  getState(): SellerPageState;
  refresh(): Promise<void>;
  whenLoaded(): Promise<void>;
  dispose(): void;
}

export const SELLER_PAGE_ATTR = 'data-recued-seller-page';
export const SELLER_PAGE_STATE_ATTR = 'data-recued-seller-page-state';
export const SELLER_PAGE_SUBPAGE_ATTR = 'data-recued-seller-subpage';
export const SELLER_DIRECTORY_ATTR = 'data-recued-seller-directory';
export const SELLER_DIRECTORY_ROW_ATTR = 'data-recued-seller-directory-row';
export const SELLER_SUBPAGE_HEADER_ATTR = 'data-recued-seller-subpage-header';
export const SELLER_BACK_ATTR = 'data-recued-seller-back';
export const SELLER_BREADCRUMB_ATTR = 'data-recued-seller-breadcrumb';
export const SELLER_BREADCRUMB_LINK_ATTR = 'data-recued-seller-breadcrumb-link';
export const SELLER_SUBNAV_ATTR = 'data-recued-seller-subnav';
export const SELLER_SUBNAV_LINK_ATTR = 'data-recued-seller-subnav-link';
export const SELLER_LIST_TOOLBAR_ATTR = 'data-recued-seller-list-toolbar';
export const SELLER_CREATE_LINK_ATTR = 'data-recued-seller-create-link';
export const SELLER_CREATE_PAGE_ATTR = 'data-recued-seller-create-page';
export const SELLER_DETAIL_TABS_ATTR = 'data-recued-seller-detail-tabs';
export const SELLER_DETAIL_TAB_ATTR = 'data-recued-seller-detail-tab';
export const SELLER_SETUP_DIRECTORY_ATTR = 'data-recued-seller-setup-directory';
export const SELLER_SETUP_ROW_ATTR = 'data-recued-seller-setup-row';
export const SELLER_SETUP_SECTION_ATTR = 'data-recued-seller-setup-section';
export const SELLER_READINESS_SETUP_LINK_ATTR = 'data-recued-seller-readiness-setup-link';
export const SELLER_COLLECTION_LIST_ATTR = 'data-recued-seller-collection-list';
export const SELLER_COLLECTION_ITEM_LINK_ATTR =
  'data-recued-seller-collection-item-link';
export const SELLER_COLLECTION_DETAIL_ATTR =
  'data-recued-seller-collection-detail';
export const SELLER_PAGER_ATTR = 'data-recued-seller-pager';
export const SELLER_PAGE_STATUS_ATTR = 'data-recued-seller-page-status';
export const SELLER_PAGE_PREVIOUS_ATTR = 'data-recued-seller-page-previous';
export const SELLER_PAGE_NEXT_ATTR = 'data-recued-seller-page-next';
export const SELLER_REFRESH_ATTR = 'data-recued-seller-refresh';
export const SELLER_SUMMARY_ATTR = 'data-recued-seller-summary';
export const SELLER_SUMMARY_LINK_ATTR = 'data-recued-seller-summary-link';
export const SELLER_READINESS_ROW_ATTR = 'data-recued-seller-readiness-row';
export const SELLER_TIER_ROW_ATTR = 'data-recued-seller-tier-row';
export const SELLER_CUSTOMER_ROW_ATTR = 'data-recued-seller-customer-row';
export const SELLER_USAGE_ROW_ATTR = 'data-recued-seller-usage-row';
export const SELLER_OFFERS_ATTR = 'data-recued-seller-offers';
export const SELLER_OFFER_ROW_ATTR = 'data-recued-seller-offer-row';
export const SELLER_ORDERS_ATTR = 'data-recued-seller-orders';
export const SELLER_ORDERS_STATUS_ATTR = 'data-recued-seller-orders-status';
export const SELLER_ORDER_BUCKET_GROUP_ATTR = 'data-recued-seller-order-bucket';
export const SELLER_ORDER_ROW_ATTR = 'data-recued-seller-order-row';
export const SELLER_ORDER_CLOSE_ACTION_ATTR = 'data-recued-seller-order-close';
/** D-196 micro-call — the swap-re-stamps-customization warning. */
export const SELLER_SWAP_RESTAMP_HINT_ATTR = 'data-recued-seller-swap-restamp-hint';

/** D-196 1d — the recipe the Close action runs. Named here rather than typed at
 *  the call site so the id the UI invokes and the id shipped in
 *  `community/recipes/` are one string. */
export const SELLER_ORDER_CLOSE_RECIPE_ID = 'close-resolved-access-order';
export const SELLER_OFFER_DEFINITION_LINK_ATTR =
  'data-recued-seller-offer-definition-link';
export const SELLER_OFFER_FULFILLMENT_LINK_ATTR =
  'data-recued-seller-offer-fulfillment-link';
export const SELLER_OFFER_STATE_ACTION_ATTR =
  'data-recued-seller-offer-state-action';
export const SELLER_OFFER_STATE_STATUS_ATTR =
  'data-recued-seller-offer-state-status';
export const SELLER_ACCESS_OFFERS_ATTR = 'data-recued-seller-access-offers';
export const SELLER_CONTRACT_LINK_ATTR = 'data-recued-seller-contract-link';
export const SELLER_SETTINGS_ATTR = 'data-recued-seller-settings';
export const SELLER_SETTINGS_FORM_ATTR = 'data-recued-seller-settings-form';
export const SELLER_SETTINGS_FORM_FIELD_ATTR =
  'data-recued-seller-settings-form-field';
export const SELLER_SETTINGS_FORM_SUBMIT_ATTR =
  'data-recued-seller-settings-form-submit';
export const SELLER_SETTINGS_FORM_STATUS_ATTR =
  'data-recued-seller-settings-form-status';
export const SELLER_MAIL_CHOOSER_STATUS_ATTR =
  'data-recued-seller-mail-chooser-status';
export const SELLER_LLM_GATEWAY_ATTR = 'data-recued-seller-llm-gateway';
export const SELLER_LLM_GATEWAY_ACK_FORM_ATTR =
  'data-recued-seller-llm-gateway-ack-form';
export const SELLER_LLM_GATEWAY_ACK_SUBMIT_ATTR =
  'data-recued-seller-llm-gateway-ack-submit';
export const SELLER_LLM_GATEWAY_ACK_STATUS_ATTR =
  'data-recued-seller-llm-gateway-ack-status';
export const SELLER_ERROR_ATTR = 'data-recued-seller-error';
/** D-250 § D — the per-tier usage-limit form. Distinct from the manual-tier
 *  form because it reaches EVERY tier, including Stripe-minted ones that
 *  `upsertManualTier` refuses. */
export const SELLER_TIER_USAGE_FORM_ATTR = 'data-recued-seller-tier-usage-form';
export const SELLER_TIER_USAGE_FIELD_ATTR = 'data-recued-seller-tier-usage-field';
export const SELLER_TIER_USAGE_SUBMIT_ATTR = 'data-recued-seller-tier-usage-submit';
export const SELLER_TIER_USAGE_STATUS_ATTR = 'data-recued-seller-tier-usage-status';

export const SELLER_TIER_FORM_ATTR = 'data-recued-seller-tier-form';
export const SELLER_TIER_FORM_FIELD_ATTR = 'data-recued-seller-tier-form-field';
export const SELLER_TIER_FORM_SUBMIT_ATTR = 'data-recued-seller-tier-form-submit';
export const SELLER_TIER_FORM_STATUS_ATTR = 'data-recued-seller-tier-form-status';
export const SELLER_PASS_TIER_FORM_ATTR = 'data-recued-seller-pass-tier-form';
export const SELLER_PASS_TIER_FORM_FIELD_ATTR =
  'data-recued-seller-pass-tier-form-field';
export const SELLER_PASS_TIER_FORM_SUBMIT_ATTR =
  'data-recued-seller-pass-tier-form-submit';
export const SELLER_PASS_TIER_FORM_STATUS_ATTR =
  'data-recued-seller-pass-tier-form-status';
export const SELLER_CUSTOMER_FORM_ATTR = 'data-recued-seller-customer-form';
export const SELLER_CUSTOMER_FORM_FIELD_ATTR = 'data-recued-seller-customer-form-field';
export const SELLER_CUSTOMER_FORM_SUBMIT_ATTR = 'data-recued-seller-customer-form-submit';
export const SELLER_CUSTOMER_FORM_STATUS_ATTR = 'data-recued-seller-customer-form-status';
export const SELLER_CUSTOMER_LIFECYCLE_FORM_ATTR =
  'data-recued-seller-customer-lifecycle-form';
export const SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR =
  'data-recued-seller-customer-lifecycle-field';
export const SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR =
  'data-recued-seller-customer-lifecycle-submit';
export const SELLER_CUSTOMER_LIFECYCLE_STATUS_ATTR =
  'data-recued-seller-customer-lifecycle-status';
export const SELLER_MESSAGE_MODAL_ATTR = 'data-recued-seller-message-modal';
export const SELLER_MESSAGE_MODAL_CONFIRM_ATTR =
  'data-recued-seller-message-modal-confirm';
export const SELLER_MESSAGE_MODAL_CANCEL_ATTR =
  'data-recued-seller-message-modal-cancel';
export const SELLER_TIER_BULK_ADJUST_FORM_ATTR =
  'data-recued-seller-tier-bulk-adjust-form';
export const SELLER_TIER_BULK_ADJUST_FIELD_ATTR =
  'data-recued-seller-tier-bulk-adjust-field';
export const SELLER_TIER_BULK_ADJUST_SUBMIT_ATTR =
  'data-recued-seller-tier-bulk-adjust-submit';
export const SELLER_TIER_BULK_ADJUST_STATUS_ATTR =
  'data-recued-seller-tier-bulk-adjust-status';
export const SELLER_PROVIDER_TIER_SYNC_FORM_ATTR = 'data-recued-seller-provider-tier-sync-form';
export const SELLER_PROVIDER_TIER_SYNC_FIELD_ATTR = 'data-recued-seller-provider-tier-sync-field';
export const SELLER_PROVIDER_TIER_SYNC_SUBMIT_ATTR = 'data-recued-seller-provider-tier-sync-submit';
export const SELLER_PROVIDER_TIER_SYNC_STATUS_ATTR = 'data-recued-seller-provider-tier-sync-status';

const clearChildren = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

const append = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  parent: HTMLElement,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] => {
  const child = doc.createElement(tag);
  if (className !== undefined) child.className = className;
  parent.appendChild(child);
  return child;
};

const appendText = (
  doc: Document,
  parent: HTMLElement,
  tag: keyof HTMLElementTagNameMap,
  text: string,
  className?: string,
): HTMLElement => {
  const el = doc.createElement(tag);
  if (className !== undefined) el.className = className;
  el.textContent = text;
  parent.appendChild(el);
  return el;
};

const appendButton = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  onClick: () => void,
  attrs: ReadonlyArray<readonly [string, string]> = [],
): HTMLButtonElement => {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  for (const [key, value] of attrs) btn.setAttribute(key, value);
  btn.addEventListener('click', () => onClick());
  parent.appendChild(btn);
  return btn;
};

const withAccessibleName = <T extends HTMLElement>(
  element: T,
  name: string,
): T => {
  element.setAttribute('aria-label', name);
  return element;
};

const formatTimestamp = (value: number | null): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? formatClientDateTime(value, { invalidText: 'Not set' })
    : 'Not set';

const formatOptional = (value: string | null): string =>
  typeof value === 'string' && value.length > 0 ? value : 'Not set';

const formatBool = (value: boolean): string => (value ? 'On' : 'Off');

const formatDuration = (seconds: number | null): string => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'Open';
  if (seconds === 0) return '0 seconds';
  const day = 24 * 60 * 60;
  const hour = 60 * 60;
  if (seconds % day === 0) return `${seconds / day}d`;
  if (seconds % hour === 0) return `${seconds / hour}h`;
  return `${seconds}s`;
};

/** Minor units -> a localized currency string. Shared by the offer price and the
 *  order amount so the locale + fraction-digit handling lives in one place. */
const formatMinorCurrency = (amountMinor: number, currency: string): string => {
  try {
    const formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    });
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(amountMinor / (10 ** fractionDigits));
  } catch {
    return `${currency} ${amountMinor} in the smallest coins`;
  }
};

const titleCase = (value: string): string =>
  value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

/** D-250 § D — render a tier's usage policy as limits, naming the unlimited
 *  case out loud.
 *
 *  ⛔ `shortJson({})` RENDERED "None", AND THAT IS THE BUG THIS REPLACES. A
 *  Stripe-minted tier ships `usage_policy_json: {}`, an absent policy means
 *  UNLIMITED, and "None" reads far more naturally as "no access allowed" than
 *  as "no ceiling" — so the single riskiest state on the page was described by
 *  a word that suggests its opposite. */
const formatUsagePolicy = (policy: Readonly<Record<string, unknown>>): string => {
  const parts: string[] = [];
  for (const kind of SELLER_USAGE_KINDS) {
    const raw = policy[kind];
    const label = kind === 'chat_turn' ? 'Chat turns' : 'Tool calls';
    if (raw === undefined || raw === null || typeof raw !== 'object') {
      parts.push(`${label}: no limit`);
      continue;
    }
    const obj = raw as Record<string, unknown>;
    const limit = obj.period_limit;
    const per = obj.period_granularity === 'day' ? 'day' : 'month';
    const rate = obj.rate_limit_per_minute;
    const limitText = typeof limit === 'number'
      ? `${limit}/${per}`
      : 'no limit';
    parts.push(
      typeof rate === 'number'
        ? `${label}: ${limitText}, ${rate}/min`
        : `${label}: ${limitText}`,
    );
  }
  return parts.join(' · ');
};

const shortJson = (value: unknown): string => {
  if (value === null || value === undefined) return 'Not set';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const text = JSON.stringify(value);
    if (text === '{}' || text === '[]') return 'None';
    return text.length > 96 ? `${text.slice(0, 93)}...` : text;
  } catch {
    return 'Unrenderable';
  }
};

const readinessStateLabel = (
  state: SellerOverviewReadinessItem['state'],
): string => {
  switch (state) {
    case 'ready':
      return 'Ready';
    case 'needs_setup':
      return 'Needs setup';
    case 'not_wired':
      return 'Not set up';
  }
};

const appendKeyValue = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  value: string,
): void => {
  const item = append(doc, parent, 'div', 'seller-kv-item');
  appendText(doc, item, 'dt', label);
  appendText(doc, item, 'dd', value);
};

const appendTableCell = (
  doc: Document,
  parent: HTMLElement,
  text: string,
): void => {
  const td = doc.createElement('td');
  td.textContent = text;
  parent.appendChild(td);
};

type SellerTableColumn<T> =
  | {
      readonly label: string;
      readonly value: (row: T) => string;
    }
  | {
      readonly label: string;
      readonly render: (row: T, td: HTMLElement) => void;
    };

const appendTable = <T>(
  doc: Document,
  parent: HTMLElement,
  opts: {
    className: string;
    empty: string;
    rows: readonly T[];
    columns: ReadonlyArray<SellerTableColumn<T>>;
    markRow?: (row: T, tr: HTMLElement) => void;
  },
): void => {
  if (opts.rows.length === 0) {
    appendText(doc, parent, 'p', opts.empty, 'seller-empty');
    return;
  }
  const wrap = append(doc, parent, 'div', 'seller-table-wrap');
  wrap.setAttribute('data-recued-scroll-rail', '');
  const table = append(doc, wrap, 'table', opts.className);
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const column of opts.columns) {
    const th = doc.createElement('th');
    th.textContent = column.label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = doc.createElement('tbody');
  for (const row of opts.rows) {
    const tr = doc.createElement('tr');
    opts.markRow?.(row, tr);
    for (const column of opts.columns) {
      if ('render' in column) {
        const td = doc.createElement('td');
        column.render(row, td);
        tr.appendChild(td);
      } else {
        appendTableCell(doc, tr, column.value(row));
      }
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
};

const appendContractLink = (
  doc: Document,
  parent: HTMLElement,
  contractId: string,
): void => {
  const link = createReferenceElement(doc, {
    label: contractId,
    referenceId: contractId,
    href: serializeShellRoute('contracts', contractId),
    className: 'seller-contract-link',
    attributes: { [SELLER_CONTRACT_LINK_ATTR]: contractId },
  });
  parent.appendChild(link);
};

const appendContractId = (
  doc: Document,
  parent: HTMLElement,
  contractId: string,
): void => {
  const value = createReferenceElement(doc, {
    label: contractId,
    referenceId: contractId,
    className: 'seller-contract-id',
  });
  parent.appendChild(value);
};

/** `door_id` on the wire, "Category" to the owner (2026-09-03). It is the
 *  owner's namespace for tiers and their customers — nothing resolves it —
 *  so every form defaults it to {@link SELLER_DEFAULT_DOOR_ID} and keeps it
 *  behind Advanced; only a seller with two products whose tier keys clash
 *  ever changes it. */
const CATEGORY_LABEL = 'Category';
const CATEGORY_HELP = 'Keeps packages and their customers together. Leave this as it is unless you '
  + 'sell separate things whose names would clash. You cannot change it once '
  + 'a package exists.';

const appendFieldHelp = (doc: Document, wrap: HTMLElement, text: string): void => {
  const help = append(doc, wrap, 'span', 'seller-form-help');
  help.textContent = text;
};

const appendField = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  field: keyof SellerManualTierUpsertRequest,
  opts: { type?: string; value?: string; help?: string } = {},
): HTMLInputElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-field');
  appendText(doc, wrap, 'span', label);
  const input = doc.createElement('input');
  input.type = opts.type ?? 'text';
  input.value = opts.value ?? '';
  input.setAttribute(SELLER_TIER_FORM_FIELD_ATTR, String(field));
  wrap.appendChild(input);
  if (opts.help !== undefined) appendFieldHelp(doc, wrap, opts.help);
  return input;
};

const appendCheckboxField = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  field: 'customer_status_enabled_default' | 'active',
  checked: boolean,
): HTMLInputElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-check');
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute(SELLER_TIER_FORM_FIELD_ATTR, field);
  wrap.appendChild(input);
  appendText(doc, wrap, 'span', label);
  return input;
};

const appendJsonField = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  field: 'usage_policy_json',
): HTMLTextAreaElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-field seller-form-field-wide');
  appendText(doc, wrap, 'span', label);
  const textarea = doc.createElement('textarea');
  textarea.value = '{}';
  textarea.rows = 4;
  textarea.setAttribute(SELLER_TIER_FORM_FIELD_ATTR, field);
  wrap.appendChild(textarea);
  return textarea;
};

const appendSettingsField = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  field: keyof SellerSettingsUpdateRequest,
  opts: { type?: string; value?: string } = {},
): HTMLInputElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-field');
  appendText(doc, wrap, 'span', label);
  const input = doc.createElement('input');
  input.type = opts.type ?? 'text';
  input.value = opts.value ?? '';
  input.setAttribute(SELLER_SETTINGS_FORM_FIELD_ATTR, String(field));
  wrap.appendChild(input);
  return input;
};

const appendSettingsMailChooser = (
  doc: Document,
  parent: HTMLElement,
  current: string | null,
  instances: readonly SellerMailInstanceOption[] | null,
  state: {
    readonly callerAvailable: boolean;
    readonly loading: boolean;
    readonly error: string | null;
  },
): HTMLSelectElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-field');
  appendText(doc, wrap, 'span', 'Which mailbox sends');
  const select = doc.createElement('select');
  select.setAttribute(SELLER_SETTINGS_FORM_FIELD_ATTR, 'sender_mail_instance_id');

  const none = doc.createElement('option');
  none.value = '';
  none.textContent = 'No sender';
  select.appendChild(none);

  for (const instance of instances ?? []) {
    const option = doc.createElement('option');
    option.value = instance.slug;
    option.textContent = instance.account_email.length > 0
      ? `${instance.account_email} (${instance.slug})`
      : instance.slug;
    select.appendChild(option);
  }

  const currentSlug = current?.trim() ?? '';
  const currentAvailable =
    currentSlug.length === 0
    || instances?.some((instance) => instance.slug === currentSlug) === true;
  if (currentSlug.length > 0 && !currentAvailable) {
    const stale = doc.createElement('option');
    stale.value = currentSlug;
    stale.textContent = instances === null
      ? `${currentSlug} (not verified)`
      : `${currentSlug} (unavailable)`;
    // A successfully loaded list is authoritative for chooser membership. Keep
    // the persisted value visible but make it impossible to re-select.
    stale.disabled = instances !== null;
    select.appendChild(stale);
  }
  select.value = currentSlug;
  wrap.appendChild(select);

  const guidance = append(doc, wrap, 'span', 'seller-form-help');
  guidance.setAttribute(SELLER_MAIL_CHOOSER_STATUS_ATTR, '');
  if (!state.callerAvailable) {
    guidance.textContent =
      'This server cannot list your mailboxes. Keep the one you saved, or choose No sender.';
  } else if (state.loading && instances === null) {
    guidance.textContent = 'Loading the mailboxes that can send.';
  } else if (state.error !== null && instances === null) {
    guidance.textContent =
      'Recued could not load your mailboxes, so it cannot check the one you saved.';
  } else if (state.error !== null) {
    guidance.textContent =
      'Recued could not load your mailboxes. These are the ones it knew about last.';
  } else if (instances !== null && !currentAvailable) {
    guidance.textContent =
      'The mailbox you saved can no longer send. Pick another one, or No sender, before you save.';
  } else if (instances !== null && instances.length === 0) {
    guidance.textContent =
      'You have no mailbox that can send. Set one up under Mail, or choose No sender.';
  } else {
    guidance.textContent = 'Only mailboxes that can send are shown.';
  }
  return select;
};

const normalizeSellerMailInstances = (
  instances: ReadonlyArray<SellerMailInstanceOption>,
): readonly SellerMailInstanceOption[] => {
  const bySlug = new Map<string, SellerMailInstanceOption>();
  for (const instance of instances) {
    const slug = instance.slug.trim();
    if (!instance.send_capable || slug.length === 0) continue;
    bySlug.set(slug, {
      slug,
      send_capable: true,
      account_email: instance.account_email.trim(),
    });
  }
  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
};

const appendSettingsJsonField = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  field: 'status_policy_json' | 'email_policy_json',
  value: Readonly<Record<string, unknown>>,
): HTMLTextAreaElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-field seller-form-field-wide');
  appendText(doc, wrap, 'span', label);
  const textarea = doc.createElement('textarea');
  textarea.value = JSON.stringify(value, null, 2);
  textarea.rows = 4;
  textarea.setAttribute(SELLER_SETTINGS_FORM_FIELD_ATTR, field);
  wrap.appendChild(textarea);
  return textarea;
};

const appendCustomerField = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  field: keyof SellerManualCustomerIssueRequest,
  opts: { type?: string; value?: string; help?: string } = {},
): HTMLInputElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-field');
  appendText(doc, wrap, 'span', label);
  const input = doc.createElement('input');
  input.type = opts.type ?? 'text';
  input.value = opts.value ?? '';
  input.setAttribute(SELLER_CUSTOMER_FORM_FIELD_ATTR, String(field));
  wrap.appendChild(input);
  if (opts.help !== undefined) appendFieldHelp(doc, wrap, opts.help);
  return input;
};

const appendCustomerCheckboxField = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  field: 'send_claim_email',
  checked: boolean,
): HTMLInputElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-check');
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute(SELLER_CUSTOMER_FORM_FIELD_ATTR, field);
  wrap.appendChild(input);
  appendText(doc, wrap, 'span', label);
  return input;
};

const appendLifecycleField = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  field: string,
  opts: { type?: string; value?: string } = {},
): HTMLInputElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-field');
  appendText(doc, wrap, 'span', label);
  const input = doc.createElement('input');
  input.type = opts.type ?? 'text';
  input.value = opts.value ?? '';
  input.setAttribute(SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR, field);
  wrap.appendChild(input);
  return input;
};

const appendBulkAdjustField = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  field: string,
): HTMLTextAreaElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-field seller-form-field-wide');
  appendText(doc, wrap, 'span', label);
  const textarea = doc.createElement('textarea');
  textarea.value = '';
  textarea.rows = 4;
  textarea.setAttribute(SELLER_TIER_BULK_ADJUST_FIELD_ATTR, field);
  wrap.appendChild(textarea);
  return textarea;
};

const appendBulkAdjustCheckbox = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  field: string,
  checked: boolean,
): HTMLInputElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-check');
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute(SELLER_TIER_BULK_ADJUST_FIELD_ATTR, field);
  wrap.appendChild(input);
  appendText(doc, wrap, 'span', label);
  return input;
};

const appendOption = (
  doc: Document,
  parent: HTMLSelectElement,
  value: string,
  label: string,
): void => {
  const option = doc.createElement('option');
  option.value = value;
  option.textContent = label;
  parent.appendChild(option);
};

const appendLifecycleSelect = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  field: string,
  options: ReadonlyArray<readonly [string, string]>,
): HTMLSelectElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-field');
  appendText(doc, wrap, 'span', label);
  const select = doc.createElement('select');
  select.setAttribute(SELLER_CUSTOMER_LIFECYCLE_FIELD_ATTR, field);
  for (const [value, optionLabel] of options) {
    appendOption(doc, select, value, optionLabel);
  }
  select.value = options[0]?.[0] ?? '';
  wrap.appendChild(select);
  return select;
};

const appendBulkAdjustSelect = (
  doc: Document,
  parent: HTMLElement,
  label: string,
  field: string,
  options: ReadonlyArray<readonly [string, string]>,
): HTMLSelectElement => {
  const wrap = append(doc, parent, 'label', 'seller-form-field');
  appendText(doc, wrap, 'span', label);
  const select = doc.createElement('select');
  select.setAttribute(SELLER_TIER_BULK_ADJUST_FIELD_ATTR, field);
  for (const [value, optionLabel] of options) {
    appendOption(doc, select, value, optionLabel);
  }
  select.value = options[0]?.[0] ?? '';
  wrap.appendChild(select);
  return select;
};

const requiredFieldValue = (
  input: HTMLInputElement | HTMLSelectElement,
  label: string,
): string => {
  const value = input.value.trim();
  if (value.length === 0) throw new Error(`${label} is required.`);
  return value;
};

const parseUsagePolicy = (textarea: HTMLTextAreaElement): Readonly<Record<string, unknown>> => {
  const raw = textarea.value.trim();
  if (raw.length === 0) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The usage rules have to be a JSON object.');
  }
  return parsed as Record<string, unknown>;
};

const parseOptionalWholeSeconds = (input: HTMLInputElement): number | null => {
  const raw = input.value.trim();
  if (raw.length === 0) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('How long the pass lasts has to be a whole number, 0 or more.');
  }
  return value;
};

const optionalInputValue = (
  input: HTMLInputElement | HTMLSelectElement,
): string | undefined => {
  const value = input.value.trim();
  return value.length === 0 ? undefined : value;
};

const parseOptionalWholeNumber = (
  input: HTMLInputElement,
  label: string,
): number | undefined => {
  const raw = input.value.trim();
  if (raw.length === 0) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} has to be a whole number, 0 or more.`);
  }
  return value;
};

const parseRequiredWholeNumber = (
  input: HTMLInputElement,
  label: string,
): number => {
  const raw = input.value.trim();
  if (raw.length === 0) throw new Error(`${label} is required.`);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} has to be a whole number, 0 or more.`);
  }
  return value;
};

const parseJsonObjectTextarea = (
  textarea: HTMLTextAreaElement,
  label: string,
): Readonly<Record<string, unknown>> => {
  const raw = textarea.value.trim();
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} has to be JSON that Recued can read.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} has to be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
};

const parseCustomerIds = (
  textarea: HTMLTextAreaElement,
): readonly string[] => {
  const values = textarea.value
    .split(/[\n,]/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    throw new Error('You need to give at least one customer id.');
  }
  if (new Set(values).size !== values.length) {
    throw new Error('Each customer id can only appear once.');
  }
  return values;
};

const renderSummary = (
  doc: Document,
  parent: HTMLElement,
  overview: SellerOverview,
): void => {
  const section = append(doc, parent, 'section', 'seller-section');
  section.setAttribute(SELLER_SUMMARY_ATTR, '');
  appendText(doc, section, 'h4', 'How your shop is doing');
  const grid = append(doc, section, 'dl', 'seller-stat-grid');
  const stats: ReadonlyArray<readonly [string, string, SellerSubpage]> = [
    ['Things you sell', `${overview.offers?.length ?? 0}`, 'offers'],
    ['Tiers', `${overview.counts.tiers}`, 'tiers'],
    ['Packages in use', `${overview.counts.active_tiers}`, 'tiers'],
    ['Customers', `${overview.counts.customers}`, 'customers'],
    ['Active', `${overview.counts.active_customers}`, 'customers'],
    ['Grace', `${overview.counts.grace_customers}`, 'customers'],
    ['Closed', `${overview.counts.closed_customers}`, 'customers'],
  ] as const;
  for (const [label, value, destination] of stats) {
    const item = append(doc, grid, 'div', 'seller-stat');
    appendText(doc, item, 'dt', label);
    const dd = append(doc, item, 'dd');
    const link = doc.createElement('a');
    const href = sellerListAddress(destination).hash;
    link.href = href;
    link.setAttribute('href', href);
    link.setAttribute(SELLER_SUMMARY_LINK_ATTR, destination);
    link.setAttribute('aria-label', `${label}: ${value}`);
    link.textContent = value;
    dd.appendChild(link);
  }
};

// ── Orders (D-207 order-is-the-lifecycle) ──────────────────────────────────
// The owner's durable window into fulfilment. Grouped by lifecycle bucket via
// the SHARED `sellerOrderBucket` — the view never re-derives the phase→bucket
// table. `SELLER_ORDER_BUCKET_LABEL` is keyed on `SellerOrderBucket`, so a new
// bucket in contracts forces both a label here AND a place in the display order.
const SELLER_ORDER_BUCKET_LABEL: Record<SellerOrderBucket, string> = {
  active: 'Active',
  needs_owner: 'Needs you',
  timed_out: 'Timed out',
  closed: 'Closed',
};

// Display priority: what demands the owner's attention first. Derived from
// `SELLER_ORDER_BUCKETS` — priority buckets lead, then any remaining bucket — so
// a bucket added to contracts still renders instead of silently vanishing from
// the grouped view.
const SELLER_ORDER_BUCKET_PRIORITY: readonly SellerOrderBucket[] = [
  'needs_owner',
  'active',
  'timed_out',
  'closed',
];
const SELLER_ORDER_BUCKET_DISPLAY_ORDER: readonly SellerOrderBucket[] = [
  ...SELLER_ORDER_BUCKET_PRIORITY,
  ...SELLER_ORDER_BUCKETS.filter(
    (bucket) => !SELLER_ORDER_BUCKET_PRIORITY.includes(bucket),
  ),
];

const formatOrderAmount = (
  amountMinor: number | null,
  currency: string | null,
): string =>
  amountMinor === null || currency === null
    ? 'Not priced'
    : formatMinorCurrency(amountMinor, currency);

const formatOrderArtifact = (hash: string | null): string =>
  hash === null || hash.length === 0 ? 'None' : `Pinned · ${hash.slice(0, 10)}…`;

/** An access order's delivered product is a seller CUSTOMER, the way a document
 *  order's is a pinned artifact. Shown for the same reason: it is the thing the
 *  order produced. It is also the ONLY route from a stuck order to the
 *  customer-level recovery actions (reissue / "Message customer" / extend), which
 *  are all keyed on `customer_id` — so the full value rides a title for copy. */
const formatOrderCustomer = (customerId: string | null): string =>
  customerId === null || customerId.length === 0
    ? 'None'
    : customerId.length > 16 ? `${customerId.slice(0, 14)}…` : customerId;

// The visitor-facing handle is `oh_` + 64 hex — far too long for a table cell, so
// show a scannable prefix and keep the full value in a title tooltip for copy.
const formatOrderHandle = (handle: string): string =>
  handle.length > 16 ? `${handle.slice(0, 14)}…` : handle;

const formatOrderOrigin = (order: SellerOrder): string => {
  const ref = order.origin_ref.length > 24
    ? `${order.origin_ref.slice(0, 24)}…`
    : order.origin_ref;
  return `${titleCase(order.origin_kind)} · ${ref}`;
};

/** D-196 1d — is this the stranded shape the Close action recovers? Mirrors the
 *  recipe's own fences (`needs_owner` + a linked customer) so the row never
 *  offers an action that is certain to be refused.
 *
 *  ⚠ This is CONVENIENCE, not enforcement. The real fences live in
 *  `close-resolved-access-order` and run whatever the UI shows — an order with no
 *  linked customer is refused there because the access never issued, and that
 *  refusal is what protects the record, not this predicate. */
const isCloseableStrandedOrder = (order: SellerOrder): boolean =>
  order.phase === 'needs_owner'
  && order.customer_id !== null
  && order.customer_id.length > 0;

interface SellerOrdersViewState {
  readonly orders: readonly SellerOrder[] | null;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly runRecipe?: SellerRecipeRunCaller;
  readonly reloadOrders?: () => void;
  readonly linkRows?: boolean;
}

const renderOrders = (
  doc: Document,
  parent: HTMLElement,
  state: SellerOrdersViewState,
): void => {
  const section = append(doc, parent, 'section', 'seller-section');
  section.setAttribute(SELLER_ORDERS_ATTR, '');
  appendText(doc, section, 'h4', 'What is happening with orders');
  appendText(
    doc,
    section,
    'p',
    'Every sale, grouped by where it has got to. This is '
      + 'the record that matters: the amount, how far it has got, what was delivered, '
      + 'and anything that went wrong. You do not edit an order. When Recued can '
      + 'put something right, it runs the order again and then reloads this.',
    'seller-section-copy',
  );

  const status = append(doc, section, 'p', 'seller-form-status');
  status.setAttribute(SELLER_ORDERS_STATUS_ATTR, '');

  // A load failure that left no prior list is the only hard stop; otherwise the
  // last-known orders stay visible (best-effort, like the mail chooser).
  if (state.orders === null) {
    if (state.error !== null) {
      status.setAttribute('role', 'alert');
      status.setAttribute('data-kind', 'error');
      status.textContent = state.error;
    } else {
      status.textContent = 'Loading orders.';
    }
    return;
  }
  if (state.error !== null) {
    status.textContent = 'Recued could not load your orders. This is the list it knew about last.';
  }

  const orders = state.orders;
  const grouped = new Map<SellerOrderBucket, SellerOrder[]>();
  for (const bucket of SELLER_ORDER_BUCKETS) grouped.set(bucket, []);
  for (const order of orders) {
    grouped.get(sellerOrderBucket(order.phase))!.push(order);
  }

  // The bucket index — counts across all four, always shown so an empty bucket
  // reads as "0", not "missing".
  const strip = append(doc, section, 'dl', 'seller-stat-grid');
  for (const bucket of SELLER_ORDER_BUCKET_DISPLAY_ORDER) {
    const item = append(doc, strip, 'div', 'seller-stat');
    item.setAttribute('data-bucket', bucket);
    appendText(doc, item, 'dt', SELLER_ORDER_BUCKET_LABEL[bucket]);
    appendText(doc, item, 'dd', String(grouped.get(bucket)?.length ?? 0));
  }

  if (state.truncated) {
    appendText(
      doc,
      section,
      'p',
      `Showing ${orders.length} order${orders.length === 1 ? '' : 's'} on this page. There are more after it.`,
      'seller-table-detail',
    );
  }

  if (orders.length === 0) {
    appendText(doc, section, 'p', 'No orders yet.', 'seller-empty');
    return;
  }

  const columns: Array<SellerTableColumn<SellerOrder>> = [
    {
      label: 'Order',
      render: (order, td) => {
        const nameHost = state.linkRows === true ? doc.createElement('a') : td;
        if (state.linkRows === true) {
          const href = sellerDetailAddress('orders', order.order_key).hash;
          nameHost.setAttribute('href', href);
          nameHost.setAttribute(
            SELLER_COLLECTION_ITEM_LINK_ATTR,
            order.order_key,
          );
          nameHost.setAttribute(
            'aria-label',
            `Preview order ${order.order_key} for ${order.offer_id}; press Enter to open`,
          );
          td.appendChild(nameHost);
        }
        appendText(doc, nameHost, 'strong', order.offer_id);
        const handleEl = appendText(
          doc,
          td,
          'div',
          formatOrderHandle(order.order_handle),
          'seller-table-detail',
        );
        // Full handle on hover — the truncated cell stays scannable, the whole
        // value stays available for support/correlation copy.
        handleEl.setAttribute('title', order.order_handle);
        const originEl = appendText(
          doc,
          td,
          'div',
          formatOrderOrigin(order),
          'seller-table-detail',
        );
        // Full origin ref on hover, for the same reason as the handle: it is the
        // key the owner-attended recovery recipes take, and the cell truncates it
        // at 24 characters. Without this the value is visible but not copyable.
        originEl.setAttribute('title', order.origin_ref);
      },
    },
    { label: 'Phase', value: (order) => order.phase },
    {
      label: 'Amount',
      value: (order) => formatOrderAmount(order.amount_minor, order.currency),
    },
    { label: 'Provider', value: (order) => formatOptional(order.provider) },
    {
      label: 'Customer',
      render: (order, td) => {
        const el = appendText(doc, td, 'span', formatOrderCustomer(order.customer_id));
        if (order.customer_id !== null && order.customer_id.length > 0) {
          el.setAttribute('title', order.customer_id);
        }
      },
    },
    { label: 'Artifact', value: (order) => formatOrderArtifact(order.artifact_hash) },
    { label: 'Error', value: (order) => formatOptional(order.error_code) },
    { label: 'Updated', value: (order) => formatTimestamp(order.updated_at) },
  ];

  // ── D-196 1d — the ONE order action, and it launches a recipe ──────────────
  // The view stays read-only in the sense D-207 means: it writes nothing itself.
  // It runs `close-resolved-access-order` through the generic `execute` rpc, so
  // the order still advances through its own operation — the button only saves
  // the owner copying a handle into the Recipes route.
  const runClose = (order: SellerOrder, button: { disabled: boolean }): void => {
    if (state.runRecipe === undefined) return;
    button.disabled = true;
    status.removeAttribute('role');
    status.removeAttribute('data-kind');
    status.textContent = `Closing ${formatOrderHandle(order.order_handle)}.`;
    void Promise.resolve()
      .then(() => state.runRecipe!({
        recipe_id: SELLER_ORDER_CLOSE_RECIPE_ID,
        config: { order_handle: order.order_handle },
      }))
      .then((response) => {
        // A recipe reports refusal as a FAILED RUN, not a rejected promise — its
        // guards are errors in the result. Treating a guard-blocked close as
        // success would tell the owner an order closed when the recipe refused
        // it (no linked customer, wrong phase).
        const errors = response.errors ?? [];
        if (response.success === false || errors.length > 0) {
          throw new Error(
            'The Recipe that closes orders said no. Open it under Recipes to see why.',
          );
        }
        status.textContent = `Closed ${formatOrderHandle(order.order_handle)}.`;
        state.reloadOrders?.();
      })
      .catch((err: unknown) => {
        button.disabled = false;
        status.setAttribute('role', 'alert');
        status.setAttribute('data-kind', 'error');
        status.textContent = humanizeRpcError(err);
      });
  };

  if (state.runRecipe !== undefined && orders.some(isCloseableStrandedOrder)) {
    columns.push({
      label: 'What you can do',
      render: (order, td) => {
        if (!isCloseableStrandedOrder(order)) {
          td.textContent = '—';
          return;
        }
        const button = appendButton(
          doc,
          td,
          'Close…',
          () => {
            // The close ASSERTS the customer has their access, and Recued cannot
            // verify a link delivered by hand arrived. The recipe says so in its
            // approval prompt, but an owner-channel run may be auto-approved by
            // the policy matrix — so the attestation is put in front of the owner
            // HERE too, rather than relying on a prompt that may never render.
            appendConfirmModal(doc, section, {
              title: 'Close this order?',
              body: `Order ${formatOrderHandle(order.order_handle)} issued access to `
                + `customer ${order.customer_id ?? ''}, but its claim link was not `
                + 'delivered. Closing it says the customer HAS their access. '
                + 'You are the one saying so. Recued cannot check whether a link you sent '
                + 'by hand ever arrived. If they do not have it, message them first.',
              confirmLabel: 'Confirm & close',
              onConfirm: () => runClose(order, button),
            });
          },
          [[SELLER_ORDER_CLOSE_ACTION_ATTR, order.order_key]],
        );
      },
    });
  }

  for (const bucket of SELLER_ORDER_BUCKET_DISPLAY_ORDER) {
    const bucketOrders = grouped.get(bucket) ?? [];
    if (bucketOrders.length === 0) continue;
    const group = append(doc, section, 'div', 'seller-order-bucket');
    group.setAttribute(SELLER_ORDER_BUCKET_GROUP_ATTR, bucket);
    appendText(
      doc,
      group,
      'h5',
      `${SELLER_ORDER_BUCKET_LABEL[bucket]} (${bucketOrders.length})`,
    );
    appendTable<SellerOrder>(doc, group, {
      className: 'seller-table seller-order-table',
      empty: 'No orders.',
      rows: bucketOrders,
      markRow: (order, tr) => tr.setAttribute(SELLER_ORDER_ROW_ATTR, order.order_key),
      columns,
    });
  }
};

const formatSellerOfferPrice = (offer: SellerOffer): string =>
  offer.pricing_kind !== 'fixed'
    || offer.amount_minor === null
    || offer.currency === null
    ? 'Not specified'
    : formatMinorCurrency(offer.amount_minor, offer.currency);

const renderSellerOffers = (
  doc: Document,
  parent: HTMLElement,
  offers: readonly SellerOffer[],
  runTransitionOfferState: SellerOfferStateTransitionCaller | undefined,
  formMessage: SellerFormMessage | null,
  applyResult: (
    response: SellerOfferStateTransitionResponse,
    message: SellerFormMessage,
  ) => void,
  linkRows = false,
): void => {
  const section = append(doc, parent, 'section', 'seller-section');
  section.setAttribute(SELLER_OFFERS_ATTR, '');
  appendText(doc, section, 'h4', 'Things you sell');
  appendText(
    doc,
    section,
    'p',
    'An offer is a one-off thing you sell, like a paid document or a finished job. '
      + 'Change the price and how it is delivered in the Recipe behind it. '
      + 'What you set here is only about showing it. Pausing or putting an offer away '
      + 'does not cancel orders already going, and you also have to pause any Recipe or '
      + 'form that could start a new one.',
    'seller-section-copy',
  );
  const status = append(doc, section, 'p', 'seller-form-status');
  status.setAttribute(SELLER_OFFER_STATE_STATUS_ATTR, '');
  if (formMessage !== null) {
    status.textContent = formMessage.text;
    status.setAttribute('data-kind', formMessage.kind);
    if (formMessage.kind === 'error') status.setAttribute('role', 'alert');
  }

  let pending = false;
  const buttons: HTMLButtonElement[] = [];
  const stateLabel = (state: SellerOfferState): string => {
    switch (state) {
      case 'active': return 'active';
      case 'paused': return 'paused';
      case 'archived': return 'archived';
      case 'draft': return 'draft';
    }
  };
  const actionLabel = (
    current: SellerOfferState,
    next: SellerOfferState,
  ): string => {
    if (next === 'active') return current === 'paused' ? 'Reactivate' : 'Activate';
    if (next === 'paused') return 'Pause';
    return 'Confirm archive';
  };
  const runAction = (
    offer: SellerOffer,
    next_state: SellerOfferState,
  ): void => {
    if (runTransitionOfferState === undefined || pending) return;
    pending = true;
    for (const button of buttons) button.disabled = true;
    status.removeAttribute('role');
    status.removeAttribute('data-kind');
    status.textContent = `Updating ${offer.display_name}.`;
    void Promise.resolve()
      .then(() => runTransitionOfferState({
        offer_id: offer.offer_id,
        expected_state: offer.state,
        expected_updated_at: offer.updated_at,
        next_state,
      }))
      .then((response) => {
        const projectedOffers = (response.overview.offers ?? []).filter(
          (candidate) => candidate.offer_id === offer.offer_id,
        );
        if (
          (response.result !== 'updated' && response.result !== 'unchanged')
          || response.offer.offer_id !== offer.offer_id
          || response.offer.state !== next_state
          || response.offer.updated_at <= offer.updated_at
          || projectedOffers.length !== 1
          || projectedOffers[0]?.state !== next_state
          || projectedOffers[0]?.updated_at !== response.offer.updated_at
        ) {
          throw new Error('Recued got an answer it did not expect.');
        }
        applyResult(response, {
          kind: 'success',
          text: response.result === 'unchanged'
            ? `Offer was already ${stateLabel(next_state)}.`
            : `Offer is now ${stateLabel(next_state)}.`,
        });
      })
      .catch((err) => {
        status.setAttribute('role', 'alert');
        status.setAttribute('data-kind', 'error');
        status.textContent = humanizeRpcError(err);
      })
      .finally(() => {
        pending = false;
        for (const button of buttons) button.disabled = false;
      });
  };

  const columns: Array<SellerTableColumn<SellerOffer>> = [
    {
      label: 'Offer',
      render: (offer, td) => {
        const nameHost = linkRows ? doc.createElement('a') : td;
        if (linkRows) {
          const href = sellerDetailAddress('offers', offer.offer_id).hash;
          nameHost.setAttribute('href', href);
          nameHost.setAttribute(SELLER_COLLECTION_ITEM_LINK_ATTR, offer.offer_id);
          nameHost.setAttribute(
            'aria-label',
            `Preview offer ${offer.offer_id} (${offer.display_name}); press Enter to open`,
          );
          td.appendChild(nameHost);
        }
        appendText(doc, nameHost, 'strong', offer.display_name);
        if (offer.description.length > 0) {
          appendText(doc, td, 'div', offer.description, 'seller-table-detail');
        }
        appendText(
          doc,
          td,
          'div',
          `Offer ID: ${offer.offer_id}`,
          'seller-table-detail',
        );
      },
    },
    { label: 'Price', value: formatSellerOfferPrice },
    { label: 'State', value: (offer) => offer.state },
    {
      label: 'Definition',
      render: (offer, td) => {
        if (offer.created_by_recipe_id === null) {
          td.textContent = 'Recued did not note who made it';
          return;
        }
        const href = serializeShellRoute('recipes', offer.created_by_recipe_id);
        const link = createReferenceElement(doc, {
          label: 'Open the Recipe that made it',
          referenceId: offer.created_by_recipe_id,
          href,
          attributes: {
            [SELLER_OFFER_DEFINITION_LINK_ATTR]: offer.created_by_recipe_id,
          },
        });
        td.appendChild(link);
      },
    },
    {
      label: 'Fulfillment',
      render: (offer, td) => {
        if (offer.fulfillment_recipe_id === null) {
          td.textContent = 'Not linked';
          return;
        }
        const href = serializeShellRoute('recipes', offer.fulfillment_recipe_id);
        const link = createReferenceElement(doc, {
          label: 'Open the Recipe that delivers it',
          referenceId: offer.fulfillment_recipe_id,
          href,
          attributes: {
            [SELLER_OFFER_FULFILLMENT_LINK_ATTR]: offer.fulfillment_recipe_id,
          },
        });
        td.appendChild(link);
      },
    },
  ];
  if (runTransitionOfferState !== undefined) {
    columns.push({
      label: 'What you can do',
      render: (offer, td) => {
        const nextStates = SELLER_OFFER_STATE_TRANSITIONS[offer.state];
        if (nextStates.length === 0) {
          td.textContent = 'Put away for good';
          return;
        }
        const actions = append(doc, td, 'div', 'seller-offer-actions');
        for (const nextState of nextStates) {
          if (nextState === 'archived') {
            const details = append(doc, actions, 'details', 'seller-offer-archive');
            appendText(doc, details, 'summary', 'Archive...');
            appendText(
              doc,
              details,
              'span',
              'Once an offer is put away, you cannot bring it back.',
              'seller-table-detail',
            );
            const button = appendButton(
              doc,
              details,
              actionLabel(offer.state, nextState),
              () => runAction(offer, nextState),
              [[SELLER_OFFER_STATE_ACTION_ATTR, nextState]],
            );
            button.setAttribute(
              'aria-label',
              `Archive ${offer.display_name} permanently`,
            );
            buttons.push(button);
            continue;
          }
          const button = appendButton(
            doc,
            actions,
            actionLabel(offer.state, nextState),
            () => runAction(offer, nextState),
            [[SELLER_OFFER_STATE_ACTION_ATTR, nextState]],
          );
          button.setAttribute(
            'aria-label',
            `${actionLabel(offer.state, nextState)} ${offer.display_name}`,
          );
          buttons.push(button);
        }
      },
    });
  }

  appendTable<SellerOffer>(doc, section, {
    className: 'seller-table seller-offer-table',
    empty: 'You are not selling anything yet.',
    rows: offers,
    markRow: (offer, tr) =>
      tr.setAttribute(SELLER_OFFER_ROW_ATTR, offer.offer_id),
    columns,
  });
};

const renderAccessOffersIntro = (
  doc: Document,
  parent: HTMLElement,
): void => {
  const section = append(doc, parent, 'section', 'seller-section');
  section.setAttribute(SELLER_ACCESS_OFFERS_ATTR, '');
  appendText(doc, section, 'h4', 'Ongoing access');
  appendText(
    doc,
    section,
    'p',
    'Access that carries on, or runs out after a while, lives under Packages and Customers. '
      + 'That is separate from one-off things you sell.',
    'seller-section-copy',
  );
  const links = append(doc, section, 'div', 'seller-related-links');
  for (const [id, label] of [
    ['tiers', 'Manage packages'],
    ['customers', 'Manage customers'],
  ] as const) {
    const link = doc.createElement('a');
    const href = sellerListAddress(id).hash;
    link.href = href;
    link.setAttribute('href', href);
    link.textContent = label;
    links.appendChild(link);
  }
};

const renderReadiness = (
  doc: Document,
  parent: HTMLElement,
  overview: SellerOverview,
): void => {
  const section = append(doc, parent, 'section', 'seller-section');
  appendText(doc, section, 'h4', 'How your setup looks');
  const list = append(doc, section, 'div', 'seller-readiness-list');
  if (overview.readiness.length === 0) {
    appendText(doc, list, 'p', 'Recued has nothing to report.', 'seller-empty');
    return;
  }
  for (const item of overview.readiness) {
    const row = append(doc, list, 'div', 'seller-readiness-row');
    row.setAttribute(SELLER_READINESS_ROW_ATTR, item.key);
    row.setAttribute('data-state', item.state);
    const main = append(doc, row, 'div', 'seller-readiness-main');
    appendText(doc, main, 'strong', item.label);
    appendText(doc, main, 'span', item.detail);
    const meta = append(doc, row, 'div', 'seller-readiness-meta');
    appendText(doc, meta, 'span', readinessStateLabel(item.state), 'seller-chip');
    if (item.href !== null) {
      const link = doc.createElement('a');
      link.href = item.href;
      link.setAttribute('href', item.href);
      link.textContent = 'Configure';
      meta.appendChild(link);
    }
    // The Seller screen that acts on this row, as its own address: a provider
    // row opens the tier seed with that provider chosen.
    const setupHash = readinessSetupHash(item.key);
    if (setupHash !== null) {
      const link = doc.createElement('a');
      link.href = setupHash;
      link.setAttribute('href', setupHash);
      link.setAttribute(SELLER_READINESS_SETUP_LINK_ATTR, item.key);
      link.textContent = 'Open setup';
      meta.appendChild(link);
    }
  }
};

/** Which setup screen a readiness row belongs to, if any. */
const readinessSetupHash = (key: string): string | null => {
  const provider = SELLER_PROVIDERS.find((spec) => spec.readiness_key === key);
  if (provider !== undefined) return sellerSetupAddress('providers', provider.source).hash;
  if (key === 'mail_sender') return sellerSetupAddress('defaults').hash;
  if (key === 'llm_gateway') return sellerSetupAddress('gateway').hash;
  return null;
};

/** D-196 consolidation — ONE Initialize / Synchronize form for every provider
 *  in `SELLER_PROVIDERS`. The provider select decides which readiness row
 *  gates the button and whether the store id (Lemon Squeezy) is asked for.
 *  Stripe keeps working against an older paired server: when the unified rpc
 *  is unknown there, the form falls back to the shipped Stripe-only rpc. */
const renderProviderTierSynchronizeForm = (
  doc: Document,
  parent: HTMLElement,
  overview: SellerOverview,
  runSynchronize: SellerProviderTierSynchronizeCaller | undefined,
  runSynchronizeStripe: SellerStripeSynchronizeCaller | undefined,
  formMessage: SellerFormMessage | null,
  applyResult: (refreshed: SellerOverview, message: SellerFormMessage) => void,
  /** The provider a deep link chose (`#settings/seller/setup/providers/<provider>`). */
  initialProvider: SellerProviderSource | null = null,
): void => {
  const readinessFor = (source: SellerProviderSource) =>
    overview.readiness.find((item) => item.key === sellerProviderFor(source).readiness_key);
  const section = append(doc, parent, 'section', 'seller-section');
  section.setAttribute(SELLER_PROVIDER_TIER_SYNC_FORM_ATTR, '');
  appendText(doc, section, 'h4', 'Packages from your payment provider');
  appendText(
    doc,
    section,
    'p',
    'Bring in the packages from whoever takes your payments: Stripe, Paddle or '
      + 'Lemon Squeezy. New packages start with no '
      + 'agreement. Anything you have already given out stays as it is.',
    'seller-section-copy',
  );
  const fields = append(doc, section, 'div', 'seller-settings-form-grid');
  const providerWrap = append(doc, fields, 'label', 'seller-form-field');
  appendText(doc, providerWrap, 'span', 'Provider');
  const provider = doc.createElement('select');
  provider.setAttribute(SELLER_PROVIDER_TIER_SYNC_FIELD_ATTR, 'provider');
  for (const spec of SELLER_PROVIDERS) {
    const option = doc.createElement('option');
    option.value = spec.source;
    option.textContent = spec.label;
    if (initialProvider !== null && spec.source === initialProvider) option.selected = true;
    provider.appendChild(option);
  }
  providerWrap.appendChild(provider);
  if (initialProvider !== null) provider.value = initialProvider;
  const appendSyncInput = (
    label: string,
    field: 'connection_name' | 'door_id' | 'store_id',
    placeholder: string,
    parent: HTMLElement = fields,
    help?: string,
  ): HTMLInputElement => {
    const wrap = append(doc, parent, 'label', 'seller-form-field');
    appendText(doc, wrap, 'span', label);
    const input = doc.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.setAttribute(SELLER_PROVIDER_TIER_SYNC_FIELD_ATTR, field);
    wrap.appendChild(input);
    if (help !== undefined) appendFieldHelp(doc, wrap, help);
    return input;
  };
  const connectionName = appendSyncInput(
    'Connection name',
    'connection_name',
    'You can leave this empty if you only have one connection for them',
  );
  const storeId = appendSyncInput(
    'Lemon Squeezy store id',
    'store_id',
    'Your store number. Lemon Squeezy only',
  );
  const doorTypeWrap = append(doc, fields, 'label', 'seller-form-field');
  appendText(doc, doorTypeWrap, 'span', 'Access type');
  const doorType = doc.createElement('select');
  doorType.setAttribute(SELLER_PROVIDER_TIER_SYNC_FIELD_ATTR, 'door_type');
  for (const [value, label] of [
    ['mcp', 'MCP tools'],
    ['mcp_chat', 'MCP chat'],
    ['llm_gateway', 'AI access through your own door'],
  ] as const) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = label;
    doorType.appendChild(option);
  }
  doorTypeWrap.appendChild(doorType);
  const advanced = append(doc, section, 'details', 'seller-advanced-settings');
  appendText(doc, advanced, 'summary', 'Advanced');
  const doorId = appendSyncInput(CATEGORY_LABEL, 'door_id', '', advanced, CATEGORY_HELP);
  doorId.value = SELLER_DEFAULT_DOOR_ID;

  const footer = append(doc, section, 'div', 'seller-form-footer');
  const status = append(doc, footer, 'div', 'seller-form-status');
  status.setAttribute(SELLER_PROVIDER_TIER_SYNC_STATUS_ATTR, '');
  const selectedProvider = (): SellerProviderSource =>
    isSellerProviderSource(provider.value) ? provider.value : 'stripe';
  const selectedReady = (): boolean => readinessFor(selectedProvider())?.state === 'ready';
  /** A provider the paired server can seed at all: the unified rpc, or for
   *  Stripe the shipped alias an older server still answers. */
  const selectedServable = (): boolean =>
    runSynchronize !== undefined
    || (selectedProvider() === 'stripe' && runSynchronizeStripe !== undefined);
  const showReadiness = (): void => {
    if (formMessage !== null) return;
    status.removeAttribute('role');
    status.removeAttribute('data-kind');
    const spec = sellerProviderFor(selectedProvider());
    const readiness = readinessFor(spec.source);
    status.textContent = !selectedServable()
      ? `${spec.label} needs a newer server to bring things in.`
      : readiness?.state === 'ready'
        ? ''
        : readiness?.detail ?? `${spec.label} cannot tell you whether they are ready.`;
  };
  if (formMessage !== null) {
    status.textContent = formMessage.text;
    status.setAttribute('data-kind', formMessage.kind);
    if (formMessage.kind === 'error') status.setAttribute('role', 'alert');
  } else {
    showReadiness();
  }

  /** Run the seed, falling back to the shipped Stripe-only rpc when the
   *  unified one is unknown to an older paired server. */
  const run = async (
    payload: SellerProviderTierSynchronizeRequest,
  ): Promise<Omit<SellerProviderTierSynchronizeResponse, 'provider'>> => {
    if (runSynchronize !== undefined) {
      try {
        return await runSynchronize(payload);
      } catch (err) {
        if (
          payload.provider !== 'stripe'
          || runSynchronizeStripe === undefined
          || classifyRpcError(err).code !== 'unknown_method'
        ) {
          throw err;
        }
      }
    }
    if (payload.provider !== 'stripe' || runSynchronizeStripe === undefined) {
      throw new Error(`${sellerProviderFor(payload.provider).label} needs a newer server to bring things in.`);
    }
    const { features_seen, ...legacy } = await runSynchronizeStripe({
      ...(payload.connection_name !== undefined ? { connection_name: payload.connection_name } : {}),
      door_id: payload.door_id,
      door_type: payload.door_type,
    });
    return { ...legacy, records_seen: features_seen };
  };

  let pending = false;
  const submit = appendButton(
    doc,
    footer,
    'Bring packages in',
    () => {
      if (pending || !selectedReady() || !selectedServable()) return;
      pending = true;
      submit.disabled = true;
      status.removeAttribute('role');
      status.removeAttribute('data-kind');
      const chosen = selectedProvider();
      const spec = sellerProviderFor(chosen);
      const noun = spec.tier_identity === 'entitlement_feature' ? 'feature' : 'product';
      status.textContent = `Synchronizing ${spec.label} ${noun}s.`;
      const request = (): SellerProviderTierSynchronizeRequest => {
        const connection_name = connectionName.value.trim();
        return {
          provider: chosen,
          ...(connection_name.length > 0 ? { connection_name } : {}),
          door_id: requiredFieldValue(doorId, CATEGORY_LABEL),
          door_type: doorType.value as SellerProviderTierSynchronizeRequest['door_type'],
          ...(spec.tier_seed_requires_store_id
            ? { store_id: requiredFieldValue(storeId, 'Lemon Squeezy store id') }
            : {}),
        };
      };
      void Promise.resolve()
        .then(request)
        .then((payload) => run(payload))
        .then((response) => {
          applyResult(response.overview, {
            kind: 'success',
            text:
              `Synchronized ${response.records_seen} ${spec.label} ${noun}${response.records_seen === 1 ? '' : 's'}: `
              + `${response.created_tier_ids.length} created, `
              + `${response.recreated_template_tier_ids.length} template${response.recreated_template_tier_ids.length === 1 ? '' : 's'} recreated, `
              + `${response.reactivated_tier_ids.length} reactivated, `
              + `${response.orphaned_tier_ids.length} orphaned.`,
          });
        })
        .catch((err) => {
          status.setAttribute('role', 'alert');
          status.setAttribute('data-kind', 'error');
          status.textContent = humanizeRpcError(err);
        })
        .finally(() => {
          pending = false;
          submit.disabled = !selectedReady() || !selectedServable();
        });
    },
    [[SELLER_PROVIDER_TIER_SYNC_SUBMIT_ATTR, '']],
  );
  submit.disabled = !selectedReady() || !selectedServable();
  provider.addEventListener('change', () => {
    formMessage = null;
    showReadiness();
    submit.disabled = pending || !selectedReady() || !selectedServable();
  });
};

const renderSettings = (
  doc: Document,
  parent: HTMLElement,
  overview: SellerOverview,
): void => {
  const section = append(doc, parent, 'section', 'seller-section');
  section.setAttribute(SELLER_SETTINGS_ATTR, '');
  appendText(doc, section, 'h4', 'Your normal settings');
  const dl = append(doc, section, 'dl', 'seller-kv-grid');
  appendKeyValue(
    doc,
    dl,
    'How long you give people',
    `${overview.settings.default_grace_hours}h`,
  );
  appendKeyValue(
    doc,
    dl,
    'Which mailbox sends',
    formatOptional(overview.settings.sender_mail_instance_id),
  );
};

const renderSettingsForm = (
  doc: Document,
  parent: HTMLElement,
  overview: SellerOverview,
  mailInstances: readonly SellerMailInstanceOption[] | null,
  mailListState: {
    readonly callerAvailable: boolean;
    readonly loading: boolean;
    readonly error: string | null;
  },
  runUpdateSellerSettings: SellerSettingsUpdateCaller,
  formMessage: SellerFormMessage | null,
  applyResult: (
    response: SellerSettingsUpdateResponse,
    message: SellerFormMessage,
  ) => void,
): void => {
  const section = append(doc, parent, 'section', 'seller-section');
  section.setAttribute(SELLER_SETTINGS_FORM_ATTR, '');
  appendText(doc, section, 'h4', 'Change these');
  const fields = append(doc, section, 'div', 'seller-settings-form-grid');
  const defaultGrace = appendSettingsField(
    doc,
    fields,
    'How long you give people hours',
    'default_grace_hours',
    {
      type: 'number',
      value: `${overview.settings.default_grace_hours}`,
    },
  );
  const senderMail = appendSettingsMailChooser(
    doc,
    fields,
    overview.settings.sender_mail_instance_id,
    mailInstances,
    mailListState,
  );
  const advanced = append(doc, section, 'details', 'seller-advanced-settings');
  appendText(doc, advanced, 'summary', 'Advanced policy JSON');
  appendText(
    doc,
    advanced,
    'p',
    'These are for advanced changes to how things run and what emails go out. '
      + 'Leave them alone unless something you use needs particular values.',
    'seller-form-intro',
  );
  const advancedFields = append(
    doc,
    advanced,
    'div',
    'seller-settings-form-grid',
  );
  const statusPolicy = appendSettingsJsonField(
    doc,
    advancedFields,
    'Status policy JSON',
    'status_policy_json',
    overview.settings.status_policy_json,
  );
  const emailPolicy = appendSettingsJsonField(
    doc,
    advancedFields,
    'Email policy JSON',
    'email_policy_json',
    overview.settings.email_policy_json,
  );
  const footer = append(doc, section, 'div', 'seller-form-footer');
  const status = append(doc, footer, 'div', 'seller-form-status');
  status.setAttribute(SELLER_SETTINGS_FORM_STATUS_ATTR, '');
  if (formMessage !== null) {
    status.textContent = formMessage.text;
    status.setAttribute('data-kind', formMessage.kind);
    if (formMessage.kind === 'error') status.setAttribute('role', 'alert');
  }

  let pending = false;
  const submit = appendButton(
    doc,
    footer,
    'Save settings',
    () => {
      if (pending) return;
      pending = true;
      submit.disabled = true;
      status.removeAttribute('role');
      status.removeAttribute('data-kind');
      status.textContent = 'Saving settings.';
      const request = (): SellerSettingsUpdateRequest => {
        const sender_mail_instance_id = senderMail.value.trim() || null;
        if (sender_mail_instance_id !== null) {
          if (mailInstances !== null) {
            if (!mailInstances.some((instance) =>
              instance.slug === sender_mail_instance_id)) {
              throw new Error(
                'That mailbox cannot send. Pick an account that can, or No sender.',
              );
            }
          } else if (
            sender_mail_instance_id
            !== (overview.settings.sender_mail_instance_id?.trim() || null)
          ) {
            throw new Error(
              'Recued cannot see your mailboxes right now. Keep the one you saved, or choose No sender.',
            );
          }
        }
        return {
          default_grace_hours: parseRequiredWholeNumber(
            defaultGrace,
            'How long you give people hours',
          ),
          sender_mail_instance_id,
          status_policy_json: parseJsonObjectTextarea(statusPolicy, 'Status policy'),
          email_policy_json: parseJsonObjectTextarea(emailPolicy, 'Email policy'),
        };
      };
      void Promise.resolve()
        .then(request)
        .then((payload) => runUpdateSellerSettings(payload))
        .then((response) => {
          applyResult(response, { kind: 'success', text: 'Settings saved.' });
        })
        .catch((err) => {
          status.setAttribute('role', 'alert');
          status.setAttribute('data-kind', 'error');
          status.textContent = humanizeRpcError(err);
        })
        .finally(() => {
          pending = false;
          submit.disabled = false;
        });
    },
    [[SELLER_SETTINGS_FORM_SUBMIT_ATTR, '']],
  );
};

const renderLlmGateway = (
  doc: Document,
  parent: HTMLElement,
  overview: SellerOverview,
): void => {
  const section = append(doc, parent, 'section', 'seller-section');
  section.setAttribute(SELLER_LLM_GATEWAY_ATTR, '');
  appendText(doc, section, 'h4', 'Paid AI access');
  const dl = append(doc, section, 'dl', 'seller-kv-grid');
  appendKeyValue(
    doc,
    dl,
    'Route',
    overview.llm_gateway.configured
      ? formatOptional(overview.llm_gateway.default_route)
      : 'Not set up',
  );
  appendKeyValue(
    doc,
    dl,
    'What customers call the AI',
    formatOptional(overview.llm_gateway.model_alias),
  );
  appendKeyValue(
    doc,
    dl,
    'Configuration',
    overview.llm_gateway.config_readable ? 'Available' : 'Unavailable',
  );
  // D-196 §4.9 / I-7 — the paid route-rights acknowledgment state. Read-only
  // here; the acknowledgment CONTROL is `renderLlmGatewayAckForm`, shown only
  // when a paid door still needs it.
  appendKeyValue(
    doc,
    dl,
    'Paid access',
    overview.llm_gateway.paid_acknowledged
      ? `Acknowledged (${formatTimestamp(overview.llm_gateway.paid_ack_at)})`
      : 'You have not agreed yet',
  );
};

/** D-196 §4.9 / I-7 — the one-time paid-gateway route-rights acknowledgment
 *  control. The owner confirms, at the monetization boundary, that they hold the
 *  rights to serve paying customers on every route they use — the free pool
 *  included. A paid (seller-customer) `llm_gateway` turn fails closed until this
 *  is recorded; free access needs none (I-6). Shown only when the gateway route
 *  is configured and not yet acknowledged. */
const renderLlmGatewayAckForm = (
  doc: Document,
  parent: HTMLElement,
  runAcknowledge: SellerAcknowledgeLlmGatewayPaidCaller,
  formMessage: SellerFormMessage | null,
  applyResult: (
    response: SellerAcknowledgeLlmGatewayPaidResponse,
    message: SellerFormMessage,
  ) => void,
): void => {
  const section = append(doc, parent, 'section', 'seller-section');
  section.setAttribute(SELLER_LLM_GATEWAY_ACK_FORM_ATTR, '');
  appendText(doc, section, 'h4', 'Agree to sell AI access');
  appendText(
    doc,
    section,
    'p',
    'Before you sell AI access, check that your own agreements let every '
      + 'AI you have set up serve paying customers. That includes the free '
      + 'ones. Recued cannot work this out for you. Free help, '
      + 'booking and your own use do not need this.',
    'seller-section-copy',
  );

  const footer = append(doc, section, 'div', 'seller-form-footer');
  const status = append(doc, footer, 'div', 'seller-form-status');
  status.setAttribute(SELLER_LLM_GATEWAY_ACK_STATUS_ATTR, '');
  if (formMessage !== null) {
    status.textContent = formMessage.text;
    status.setAttribute('data-kind', formMessage.kind);
    if (formMessage.kind === 'error') status.setAttribute('role', 'alert');
  } else {
    status.textContent =
      'A paying customer cannot use Chat until you agree to this.';
  }

  let pending = false;
  const submit = appendButton(
    doc,
    footer,
    'I agree. Turn on paid access',
    () => {
      if (pending) return;
      pending = true;
      submit.disabled = true;
      status.removeAttribute('role');
      status.removeAttribute('data-kind');
      status.textContent = 'Saving…';
      void Promise.resolve()
        .then(() => runAcknowledge({ ack_version: LLM_GATEWAY_PAID_ACK_VERSION }))
        .then((response) => {
          applyResult(response, {
            kind: 'success',
            text: 'Saved. Paid access is on.',
          });
        })
        .catch((err) => {
          status.setAttribute('role', 'alert');
          status.setAttribute('data-kind', 'error');
          status.textContent = humanizeRpcError(err);
        })
        .finally(() => {
          pending = false;
          submit.disabled = false;
        });
    },
    [[SELLER_LLM_GATEWAY_ACK_SUBMIT_ATTR, '']],
  );
};

const renderTiers = (
  doc: Document,
  parent: HTMLElement,
  tiers: readonly SellerTier[],
  linkRows = false,
): void => {
  const section = append(doc, parent, 'section', 'seller-section');
  appendText(doc, section, 'h4', 'Packages');
  appendText(
    doc,
    section,
    'p',
    'Each package has an agreement behind it. Change that agreement under '
      + 'Contracts, and new customers get the new one.',
    'seller-section-copy',
  );
  appendTable<SellerTier>(doc, section, {
    className: 'seller-table seller-tier-table',
    empty: 'No packages yet.',
    rows: tiers,
    markRow: (tier, tr) => tr.setAttribute(SELLER_TIER_ROW_ATTR, tier.tier_id),
    columns: [
      {
        label: 'Tier',
        render: (tier, td) => {
          const nameHost = linkRows ? doc.createElement('a') : td;
          if (linkRows) {
            const href = sellerDetailAddress('tiers', tier.tier_id).hash;
            nameHost.setAttribute('href', href);
            nameHost.setAttribute(SELLER_COLLECTION_ITEM_LINK_ATTR, tier.tier_id);
            nameHost.setAttribute(
              'aria-label',
              `Preview tier ${tier.tier_id} (${tier.display_name}); press Enter to open`,
            );
            td.appendChild(nameHost);
          }
          appendText(doc, nameHost, 'strong', tier.display_name);
          appendText(doc, td, 'div', tier.tier_id, 'seller-table-detail');
        },
      },
      { label: 'Source', value: (tier) => titleCase(tier.lifecycle_source) },
      { label: CATEGORY_LABEL, value: (tier) => tier.door_id },
      { label: 'Entitlement', value: (tier) => tier.entitlement_key },
      {
        label: 'Template',
        render: (tier, td) => {
          appendContractLink(doc, td, tier.template_contract_id);
        },
      },
      { label: 'Active', value: (tier) => formatBool(tier.active) },
      {
        label: 'Status updates',
        value: (tier) => formatBool(tier.customer_status_enabled_default),
      },
      {
        label: 'Pass',
        value: (tier) => formatDuration(tier.pass_duration_seconds),
      },
      {
        // D-250 § D — limits, not raw JSON, and "no limit" said out loud.
        label: 'How much they may use',
        value: (tier) => formatUsagePolicy(tier.usage_policy_json),
      },
    ],
  });
};


/** D-250 § D — set usage limits on ONE tier, whatever minted it.
 *
 *  ⛔ WHY IT IS NOT THE MANUAL-TIER FORM. That form posts `upsertManualTier`,
 *  which stamps `lifecycle_source: 'manual'`, and the store refuses when a
 *  stored tier's source differs — so it conflicts on every Stripe-synced tier.
 *  Those are exactly the tiers minted with an empty policy, i.e. unlimited, so
 *  the tiers that most needed a limit were the ones no form could reach.
 *
 *  ⛔ STRUCTURED FIELDS, NOT THE RAW JSON TEXTAREA the manual form uses. An
 *  absent kind is UNLIMITED, so a free-text policy makes the unsafe state the
 *  easiest thing to type — and the placeholder says "No limit" rather than
 *  leaving an empty box to interpret.
 *
 *  ⚠ Blank means no limit, deliberately and visibly: there is no way to express
 *  "unlimited" other than clearing the field, and the label says so. */
const renderTierUsagePolicyForm = (
  doc: Document,
  parent: HTMLElement,
  tier: SellerTier,
  runSetTierUsagePolicy: SellerTierUsagePolicyCaller,
  formMessage: SellerFormMessage | null,
  applyResult: (
    response: SellerTierUsagePolicyResponse,
    message: SellerFormMessage,
  ) => void,
): void => {
  const section = append(
    doc,
    parent,
    'details',
    'seller-section seller-action-disclosure',
  );
  // This form is the whole screen behind its own address (2026-09-03), so it
  // opens expanded; a collapsed disclosure on a screen named for the form hid it.
  section.open = true;
  section.setAttribute(SELLER_TIER_USAGE_FORM_ATTR, tier.tier_id);
  appendText(doc, section, 'summary', 'How much they may use');
  appendText(
    doc,
    section,
    'p',
    'Leave a box empty for no limit. Recued checks before every use, and '
      + 'turns a customer away once they have used up their share. What it cost '
      + 'is written down either way, so even a package with no limit shows its spending.',
    'seller-form-intro',
  );

  const inputs = new Map<string, HTMLInputElement>();
  const fieldFor = (
    host: HTMLElement,
    kind: SellerUsageKind,
    name: 'period_limit' | 'rate_limit_per_minute',
    label: string,
    value: unknown,
  ): void => {
    const wrap = append(doc, host, 'label', 'seller-form-field');
    appendText(doc, wrap, 'span', label);
    const input = doc.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.placeholder = 'No limit';
    input.value = typeof value === 'number' ? String(value) : '';
    input.setAttribute(SELLER_TIER_USAGE_FIELD_ATTR, `${kind}.${name}`);
    wrap.appendChild(input);
    inputs.set(`${kind}.${name}`, input);
  };

  const granularities = new Map<SellerUsageKind, HTMLSelectElement>();
  for (const kind of SELLER_USAGE_KINDS) {
    const raw = tier.usage_policy_json[kind];
    const obj = raw !== null && typeof raw === 'object'
      ? raw as Record<string, unknown>
      : {};
    const group = append(doc, section, 'div', 'seller-tier-form-grid');
    appendText(
      doc,
      group,
      'h4',
      kind === 'chat_turn' ? 'Chat turns' : 'Tool calls',
        );
    fieldFor(group, kind, 'period_limit', 'How much they get', obj.period_limit);
    const periodWrap = append(doc, group, 'label', 'seller-form-field');
    appendText(doc, periodWrap, 'span', 'Period');
    const period = doc.createElement('select');
    for (const option of ['month', 'day']) {
      const el = doc.createElement('option');
      el.value = option;
      el.textContent = option === 'month' ? 'Per month' : 'Per day';
      if (obj.period_granularity === option) el.selected = true;
      period.appendChild(el);
    }
    period.setAttribute(SELLER_TIER_USAGE_FIELD_ATTR, `${kind}.period_granularity`);
    periodWrap.appendChild(period);
    granularities.set(kind, period);
    fieldFor(group, kind, 'rate_limit_per_minute', 'Most per minute', obj.rate_limit_per_minute);
  }

  const footer = append(doc, section, 'div', 'seller-form-footer');
  const status = append(doc, footer, 'div', 'seller-form-status');
  status.setAttribute(SELLER_TIER_USAGE_STATUS_ATTR, '');
  if (formMessage !== null) {
    status.textContent = formMessage.text;
    status.setAttribute('data-kind', formMessage.kind);
    if (formMessage.kind === 'error') status.setAttribute('role', 'alert');
  }

  let pending = false;
  const submit = appendButton(
    doc,
    footer,
    'Save limits',
    () => {
      if (pending) return;
      pending = true;
      submit.disabled = true;
      status.removeAttribute('role');
      status.removeAttribute('data-kind');
      status.textContent = 'Saving limits.';
      const build = (): SellerTierUsagePolicyRequest => {
        const policy: Record<string, unknown> = {};
        for (const kind of SELLER_USAGE_KINDS) {
          const limit = inputs.get(`${kind}.period_limit`)?.value.trim() ?? '';
          const rate = inputs.get(`${kind}.rate_limit_per_minute`)?.value.trim() ?? '';
          // ⚠ BOTH BLANK ⇒ THE KIND IS OMITTED ENTIRELY, which is what
          // "unlimited" IS on the server. Writing `{period_limit: null}` would
          // mean the same thing but leave a shape implying someone configured
          // it; omission keeps "never set" and "cleared" identical, because to
          // the gate they are.
          if (limit === '' && rate === '') continue;
          const entry: Record<string, unknown> = {
            period_granularity: granularities.get(kind)?.value === 'day'
              ? 'day'
              : 'month',
          };
          if (limit !== '') entry.period_limit = Number(limit);
          if (rate !== '') entry.rate_limit_per_minute = Number(rate);
          policy[kind] = entry;
        }
        return { tier_id: tier.tier_id, usage_policy_json: policy };
      };
      void Promise.resolve()
        .then(build)
        .then((payload) => runSetTierUsagePolicy(payload))
        .then((response) => {
          applyResult(response, { kind: 'success', text: 'How much they may use saved.' });
        })
        .catch((err) => {
          status.setAttribute('role', 'alert');
          status.setAttribute('data-kind', 'error');
          status.textContent = humanizeRpcError(err);
        })
        .finally(() => {
          pending = false;
          submit.disabled = false;
        });
    },
    [[SELLER_TIER_USAGE_SUBMIT_ATTR, tier.tier_id]],
  );
};

const renderManualTierBulkAdjustForm = (
  doc: Document,
  parent: HTMLElement,
  overview: SellerOverview,
  runBulkAdjustManualTierCustomers: SellerManualTierBulkAdjustCaller,
  formMessage: SellerFormMessage | null,
  applyResult: (
    response: SellerManualTierBulkAdjustResponse,
    message: SellerFormMessage,
  ) => void,
  initialTierId?: string,
): void => {
  const manualTiers = overview.tiers.filter((tier) =>
    tier.lifecycle_source === 'manual');
  if (manualTiers.length === 0) return;

  const section = append(
    doc,
    parent,
    'details',
    'seller-section seller-action-disclosure',
  );
  // This form is the whole screen behind its own address (2026-09-03), so it
  // opens expanded; a collapsed disclosure on a screen named for the form hid it.
  section.open = true;
  section.setAttribute(SELLER_TIER_BULK_ADJUST_FORM_ATTR, '');
  appendText(doc, section, 'summary', 'Give everyone the new package');
  appendText(
    doc,
    section,
    'p',
    'Re-issue these customers from the package’s agreement. This wipes any '
      + 'changes you made for one person. Closed customers are always left alone.',
    'seller-form-intro',
  );
  const fields = append(doc, section, 'div', 'seller-tier-bulk-adjust-grid');
  const tierId = appendBulkAdjustSelect(
    doc,
    fields,
    'Tier',
    'tier_id',
    manualTiers.map((tier) => [
      tier.tier_id,
      `${tier.display_name} (${tier.tier_id})`,
    ] as const),
  );
  if (
    initialTierId !== undefined
    && manualTiers.some((tier) => tier.tier_id === initialTierId)
  ) {
    tierId.value = initialTierId;
  }
  const customerIds = appendBulkAdjustField(
    doc,
    fields,
    'Customer IDs',
    'customer_ids',
  );
  const checks = append(doc, section, 'div', 'seller-form-checks');
  const allOpenCustomers = appendBulkAdjustCheckbox(
    doc,
    checks,
    'Everyone still active',
    'all_open_customers',
    true,
  );
  customerIds.disabled = allOpenCustomers.checked;
  allOpenCustomers.addEventListener('change', () => {
    customerIds.disabled = allOpenCustomers.checked;
  });

  const footer = append(doc, section, 'div', 'seller-form-footer');
  const status = append(doc, footer, 'div', 'seller-form-status');
  status.setAttribute(SELLER_TIER_BULK_ADJUST_STATUS_ATTR, '');
  if (formMessage !== null) {
    status.textContent = formMessage.text;
    status.setAttribute('data-kind', formMessage.kind);
    if (formMessage.kind === 'error') status.setAttribute('role', 'alert');
  }

  let pending = false;
  const submit = appendButton(
    doc,
    footer,
    'Re-issue them',
    () => {
      if (pending) return;
      pending = true;
      submit.disabled = true;
      status.removeAttribute('role');
      status.removeAttribute('data-kind');
      status.textContent = 'Re-issuing…';
      const request = (): SellerManualTierBulkAdjustRequest => ({
        tier_id: requiredFieldValue(tierId, 'Tier'),
        ...(!allOpenCustomers.checked
          ? { customer_ids: parseCustomerIds(customerIds) }
          : {}),
      });
      void Promise.resolve()
        .then(request)
        .then((payload) => runBulkAdjustManualTierCustomers(payload))
        .then((response) => {
          applyResult(response, {
            kind: 'success',
            text: `Done. ${
              response.adjusted_customers.length
            } adjusted, ${response.skipped_closed_customers.length} skipped.`,
          });
        })
        .catch((err) => {
          status.setAttribute('role', 'alert');
          status.setAttribute('data-kind', 'error');
          status.textContent = humanizeRpcError(err);
        })
        .finally(() => {
          pending = false;
          submit.disabled = false;
        });
    },
    [[SELLER_TIER_BULK_ADJUST_SUBMIT_ATTR, '']],
  );
};

const renderCreatePassTierForm = (
  doc: Document,
  parent: HTMLElement,
  runCreatePassTier: SellerCreatePassTierCaller,
  formMessage: SellerFormMessage | null,
  createdTemplateContractId: string | null,
  applyResult: (
    response: SellerCreatePassTierResponse,
    message: SellerFormMessage,
  ) => void,
): void => {
  const section = append(
    doc,
    parent,
    'details',
    'seller-section seller-action-disclosure',
  );
  // This form is the whole screen behind its own address (2026-09-03), so it
  // opens expanded; a collapsed disclosure on a screen named for the form hid it.
  section.open = true;
  section.setAttribute(SELLER_PASS_TIER_FORM_ATTR, '');
  appendText(doc, section, 'summary', 'Make a timed pass');
  appendText(
    doc,
    section,
    'p',
    'Makes an empty agreement for the kind of access you pick, and ties a new pass '
      + 'to it in one go. Set three things: how long it lasts, how many '
      + 'AI turns it allows, and how many tool uses. Once it is '
      + 'made, open the agreement under Contracts to say which tools and which things '
      + 'the pass allows.',
  ).className = 'seller-form-intro';
  const fields = append(doc, section, 'div', 'seller-tier-form-grid');
  const appendPassField = (
    label: string,
    field: 'door_id' | 'entitlement_key' | 'display_name' | 'pass_duration_seconds',
    type = 'text',
    parent: HTMLElement = fields,
    help?: string,
  ): HTMLInputElement => {
    const wrap = append(doc, parent, 'label', 'seller-form-field');
    appendText(doc, wrap, 'span', label);
    const input = doc.createElement('input');
    input.type = type;
    input.setAttribute(SELLER_PASS_TIER_FORM_FIELD_ATTR, field);
    wrap.appendChild(input);
    if (help !== undefined) appendFieldHelp(doc, wrap, help);
    return input;
  };
  const doorTypeWrap = append(doc, fields, 'label', 'seller-form-field');
  appendText(doc, doorTypeWrap, 'span', 'Access type');
  const doorType = doc.createElement('select');
  doorType.setAttribute(SELLER_PASS_TIER_FORM_FIELD_ATTR, 'door_type');
  for (const [value, label] of [
    ['mcp', 'MCP tools'],
    ['mcp_chat', 'MCP chat'],
    ['llm_gateway', 'AI access through your own door'],
  ] as const) {
    const option = doc.createElement('option');
    option.value = value;
    option.textContent = label;
    doorType.appendChild(option);
  }
  doorTypeWrap.appendChild(doorType);
  const entitlementKey = appendPassField('The package’s key', 'entitlement_key');
  const displayName = appendPassField('Display name', 'display_name');
  const passDuration = appendPassField(
    'How long the pass lasts, in seconds',
    'pass_duration_seconds',
    'number',
  );
  const advanced = append(doc, section, 'details', 'seller-advanced-settings');
  appendText(doc, advanced, 'summary', 'Advanced');
  const doorId = appendPassField(CATEGORY_LABEL, 'door_id', 'text', advanced, CATEGORY_HELP);
  doorId.value = SELLER_DEFAULT_DOOR_ID;
  const usagePolicyWrap = append(
    doc,
    advanced,
    'label',
    'seller-form-field seller-form-field-wide',
  );
  appendText(doc, usagePolicyWrap, 'span', 'Usage policy JSON');
  const usagePolicy = doc.createElement('textarea');
  usagePolicy.value = '{}';
  usagePolicy.rows = 4;
  usagePolicy.setAttribute(SELLER_PASS_TIER_FORM_FIELD_ATTR, 'usage_policy_json');
  usagePolicyWrap.appendChild(usagePolicy);

  const footer = append(doc, section, 'div', 'seller-form-footer');
  const status = append(doc, footer, 'div', 'seller-form-status');
  status.setAttribute(SELLER_PASS_TIER_FORM_STATUS_ATTR, '');
  if (formMessage !== null) {
    status.textContent = formMessage.text;
    status.setAttribute('data-kind', formMessage.kind);
    if (formMessage.kind === 'error') status.setAttribute('role', 'alert');
  }
  if (createdTemplateContractId !== null) {
    const hint = append(doc, footer, 'div', 'seller-form-hint');
    appendText(doc, hint, 'span', 'Say what it allows: ');
    appendContractLink(doc, hint, createdTemplateContractId);
  }

  let pending = false;
  const submit = appendButton(
    doc,
    footer,
    'Make the pass',
    () => {
      if (pending) return;
      pending = true;
      submit.disabled = true;
      status.removeAttribute('role');
      status.removeAttribute('data-kind');
      status.textContent = 'Making it…';
      const request = (): SellerCreatePassTierRequest => ({
        door_id: requiredFieldValue(doorId, CATEGORY_LABEL),
        door_type: doorType.value as SellerCreatePassTierRequest['door_type'],
        entitlement_key: requiredFieldValue(entitlementKey, 'The package’s key'),
        display_name: requiredFieldValue(displayName, 'Display name'),
        pass_duration_seconds: parseOptionalWholeSeconds(passDuration),
        usage_policy_json: parseUsagePolicy(usagePolicy),
      });
      void Promise.resolve()
        .then(request)
        .then((payload) => runCreatePassTier(payload))
        .then((response) => {
          applyResult(response, {
            kind: 'success',
            text:
              `Pass tier "${response.tier.display_name}" created. `
              + 'Open its template in Contracts to author the pass allows.',
          });
        })
        .catch((err) => {
          status.setAttribute('role', 'alert');
          status.setAttribute('data-kind', 'error');
          status.textContent = humanizeRpcError(err);
        })
        .finally(() => {
          pending = false;
          submit.disabled = false;
        });
    },
    [[SELLER_PASS_TIER_FORM_SUBMIT_ATTR, '']],
  );
};

const renderManualTierForm = (
  doc: Document,
  parent: HTMLElement,
  tiers: readonly SellerTier[],
  runUpsertManualTier: SellerManualTierUpsertCaller,
  formMessage: SellerFormMessage | null,
  applyResult: (
    response: SellerManualTierUpsertResponse,
    message: SellerFormMessage,
  ) => void,
  initialTierId?: string,
): void => {
  const section = append(
    doc,
    parent,
    'details',
    'seller-section seller-action-disclosure',
  );
  // This form is the whole screen behind its own address (2026-09-03), so it
  // opens expanded; a collapsed disclosure on a screen named for the form hid it.
  section.open = true;
  section.setAttribute(SELLER_TIER_FORM_ATTR, '');
  appendText(doc, section, 'summary', 'About this package');
  appendText(
    doc,
    section,
    'p',
    initialTierId === undefined
      ? 'Pick an id for a new package that will never change, or type an existing '
        + 'one to open it. You cannot change the kind or the key afterwards.'
      : 'Once a package exists you cannot change what kind it is, or its key. You can change the name, template, '
        + 'how long it lasts, the limits, or the status. Then save.',
    'seller-form-intro',
  );
  const fields = append(doc, section, 'div', 'seller-tier-form-grid');
  const tierId = appendField(doc, fields, 'Package id', 'tier_id');
  const entitlementKey = appendField(
    doc,
    fields,
    'The package’s key',
    'entitlement_key',
  );
  const displayName = appendField(doc, fields, 'Display name', 'display_name');
  const templateContractId = appendField(
    doc,
    fields,
    'The agreement behind it',
    'template_contract_id',
  );
  const passDuration = appendField(
    doc,
    fields,
    'How long the pass lasts, in seconds',
    'pass_duration_seconds',
    { type: 'number' },
  );
  const advanced = append(doc, section, 'details', 'seller-advanced-settings');
  appendText(doc, advanced, 'summary', 'Advanced');
  const doorId = appendField(doc, advanced, CATEGORY_LABEL, 'door_id', {
    value: SELLER_DEFAULT_DOOR_ID,
    help: CATEGORY_HELP,
  });
  const usagePolicy = appendJsonField(
    doc,
    advanced,
    'Usage policy JSON',
    'usage_policy_json',
  );
  const checks = append(doc, section, 'div', 'seller-form-checks');
  const customerStatusEnabled = appendCheckboxField(
    doc,
    checks,
    'Tell customers when things change',
    'customer_status_enabled_default',
    false,
  );
  const active = appendCheckboxField(doc, checks, 'Active', 'active', true);
  const populateExistingTier = (): void => {
    const existing = tiers.find((tier) =>
      tier.lifecycle_source === 'manual'
      && tier.tier_id === tierId.value.trim());
    if (existing === undefined) {
      doorId.disabled = false;
      entitlementKey.disabled = false;
      return;
    }
    doorId.value = existing.door_id;
    doorId.disabled = true;
    entitlementKey.value = existing.entitlement_key;
    entitlementKey.disabled = true;
    displayName.value = existing.display_name;
    templateContractId.value = existing.template_contract_id;
    passDuration.value = existing.pass_duration_seconds === null
      ? ''
      : String(existing.pass_duration_seconds);
    usagePolicy.value = JSON.stringify(existing.usage_policy_json, null, 2);
    customerStatusEnabled.checked = existing.customer_status_enabled_default;
    active.checked = existing.active;
  };
  tierId.addEventListener('input', populateExistingTier);
  tierId.addEventListener('change', populateExistingTier);
  if (initialTierId !== undefined) {
    tierId.value = initialTierId;
    populateExistingTier();
  }
  const footer = append(doc, section, 'div', 'seller-form-footer');
  const status = append(doc, footer, 'div', 'seller-form-status');
  status.setAttribute(SELLER_TIER_FORM_STATUS_ATTR, '');
  if (formMessage !== null) {
    status.textContent = formMessage.text;
    status.setAttribute('data-kind', formMessage.kind);
    if (formMessage.kind === 'error') status.setAttribute('role', 'alert');
  }
  let pending = false;
  const submit = appendButton(
    doc,
    footer,
    'Save the package',
    () => {
      if (pending) return;
      pending = true;
      submit.disabled = true;
      status.removeAttribute('role');
      status.removeAttribute('data-kind');
      status.textContent = 'Saving…';
      const request = (): SellerManualTierUpsertRequest => ({
        tier_id: requiredFieldValue(tierId, 'Package id'),
        door_id: requiredFieldValue(doorId, CATEGORY_LABEL),
        entitlement_key: requiredFieldValue(entitlementKey, 'The package’s key'),
        display_name: requiredFieldValue(displayName, 'Display name'),
        template_contract_id: requiredFieldValue(
          templateContractId,
          'The agreement behind it',
        ),
        usage_policy_json: parseUsagePolicy(usagePolicy),
        pass_duration_seconds: parseOptionalWholeSeconds(passDuration),
        customer_status_enabled_default: customerStatusEnabled.checked,
        active: active.checked,
      });
      void Promise.resolve()
        .then(request)
        .then((payload) => runUpsertManualTier(payload))
        .then((response) => {
          applyResult(response, { kind: 'success', text: 'Saved.' });
        })
        .catch((err) => {
          status.setAttribute('role', 'alert');
          status.setAttribute('data-kind', 'error');
          status.textContent = humanizeRpcError(err);
        })
        .finally(() => {
          pending = false;
          submit.disabled = false;
        });
    },
    [[SELLER_TIER_FORM_SUBMIT_ATTR, '']],
  );
};

const renderManualCustomerForm = (
  doc: Document,
  parent: HTMLElement,
  tiers: readonly SellerTier[],
  claimEmailReady: boolean,
  runIssueManualCustomer: SellerManualCustomerIssueCaller,
  formMessage: SellerFormMessage | null,
  applyResult: (
    response: SellerManualCustomerIssueResponse,
    message: SellerFormMessage,
  ) => void,
): void => {
  const manualTiers = tiers.filter((tier) =>
    tier.lifecycle_source === 'manual' && tier.active);
  const defaultTier = manualTiers[0];
  if (defaultTier === undefined) return;

  const section = append(
    doc,
    parent,
    'details',
    'seller-section seller-action-disclosure',
  );
  // This form is the whole screen behind its own address (2026-09-03), so it
  // opens expanded; a collapsed disclosure on a screen named for the form hid it.
  section.open = true;
  section.setAttribute(SELLER_CUSTOMER_FORM_ATTR, '');
  appendText(doc, section, 'summary', 'Give someone access');
  appendText(
    doc,
    section,
    'p',
    'Set someone up on a package you run yourself. Keep the one-off '
      + 'link until they have used it.',
    'seller-form-intro',
  );
  const fields = append(doc, section, 'div', 'seller-customer-form-grid');
  // The owner picks a tier; the category and entitlement key the rpc wants
  // follow from it and stay editable behind Advanced for a tier not listed.
  const categories = new Set(manualTiers.map((tier) => tier.door_id));
  const tierWrap = append(doc, fields, 'label', 'seller-form-field');
  appendText(doc, tierWrap, 'span', 'Tier');
  const tierSelect = doc.createElement('select');
  tierSelect.setAttribute(SELLER_CUSTOMER_FORM_FIELD_ATTR, 'tier');
  for (const tier of manualTiers) {
    const option = doc.createElement('option');
    option.value = tier.tier_id;
    option.textContent = `${tier.display_name} · ${tier.entitlement_key}`
      + (categories.size > 1 ? ` · ${tier.door_id}` : '');
    tierSelect.appendChild(option);
  }
  tierWrap.appendChild(tierSelect);
  const sourceCustomerId = appendCustomerField(
    doc,
    fields,
    'Source customer ID',
    'source_customer_id',
  );
  const email = appendCustomerField(doc, fields, 'Email', 'email', { type: 'email' });
  const sendClaimEmail = appendCustomerCheckboxField(
    doc,
    fields,
    claimEmailReady
      ? 'Email them the one-off link'
      : 'Email them the one-off link. Set up a mailbox first',
    'send_claim_email',
    false,
  );
  sendClaimEmail.disabled = !claimEmailReady;
  const currentPeriodEnd = appendCustomerField(
    doc,
    fields,
    'When it ends',
    'current_period_end',
    { type: 'number' },
  );
  const sourceStatus = appendCustomerField(
    doc,
    fields,
    'Source status',
    'source_status',
  );
  const advanced = append(doc, section, 'details', 'seller-advanced-settings');
  appendText(doc, advanced, 'summary', 'Advanced');
  const doorId = appendCustomerField(doc, advanced, CATEGORY_LABEL, 'door_id', {
    value: defaultTier.door_id,
    help: 'Filled in from the package you picked. Only change these to use a package that is not listed.',
  });
  const entitlementKey = appendCustomerField(
    doc,
    advanced,
    'The package’s key',
    'entitlement_key',
    { value: defaultTier.entitlement_key },
  );
  tierSelect.addEventListener('change', () => {
    const chosen = manualTiers.find((tier) => tier.tier_id === tierSelect.value);
    if (chosen === undefined) return;
    doorId.value = chosen.door_id;
    entitlementKey.value = chosen.entitlement_key;
  });
  const footer = append(doc, section, 'div', 'seller-form-footer');
  const status = append(doc, footer, 'div', 'seller-form-status');
  status.setAttribute(SELLER_CUSTOMER_FORM_STATUS_ATTR, '');
  if (formMessage !== null) {
    status.textContent = formMessage.text;
    status.setAttribute('data-kind', formMessage.kind);
    if (formMessage.kind === 'error') status.setAttribute('role', 'alert');
  }
  let pending = false;
  const submit = appendButton(
    doc,
    footer,
    'Give someone access',
    () => {
      if (pending) return;
      pending = true;
      submit.disabled = true;
      status.removeAttribute('role');
      status.removeAttribute('data-kind');
      status.textContent = 'Setting them up…';
      const request = (): SellerManualCustomerIssueRequest => {
        const payload: SellerManualCustomerIssueRequest = {
          door_id: requiredFieldValue(doorId, CATEGORY_LABEL),
          entitlement_key: requiredFieldValue(entitlementKey, 'The package’s key'),
          source_customer_id: requiredFieldValue(
            sourceCustomerId,
            'Source customer ID',
          ),
        };
        const emailValue = optionalInputValue(email);
        if (sendClaimEmail.checked && emailValue === undefined) {
          throw new Error('You need an email address to send them the link.');
        }
        const sourceStatusValue = optionalInputValue(sourceStatus);
        const periodEnd = parseOptionalWholeNumber(
          currentPeriodEnd,
          'When it ends',
        );
        return {
          ...payload,
          ...(emailValue !== undefined ? { email: emailValue } : {}),
          ...(sendClaimEmail.checked ? { send_claim_email: true } : {}),
          ...(periodEnd !== undefined ? { current_period_end: periodEnd } : {}),
          ...(sourceStatusValue !== undefined ? { source_status: sourceStatusValue } : {}),
        };
      };
      void Promise.resolve()
        .then(request)
        .then((payload) => runIssueManualCustomer(payload))
        .then((response) => {
          const claimText = response.claim
            ? ` Their one-off link: ${response.claim.claim_url}`
            : '';
          const deliveryText = response.claim_email_delivery?.status === 'sent'
            ? ' The email is on its way.'
            : response.claim_email_delivery?.status === 'failed'
              ? ` Recued could not send the email (${response.claim_email_delivery.error_code}); deliver the link manually.`
              : '';
          applyResult(response, {
            kind: response.claim_email_delivery?.status === 'failed' ? 'error' : 'success',
            text: response.result === 'created'
              ? `They are set up.${deliveryText}${claimText}`
              : 'Their access now lasts longer.',
          });
        })
        .catch((err) => {
          status.setAttribute('role', 'alert');
          status.setAttribute('data-kind', 'error');
          status.textContent = humanizeRpcError(err);
        })
        .finally(() => {
          pending = false;
          submit.disabled = false;
        });
    },
    [[SELLER_CUSTOMER_FORM_SUBMIT_ATTR, '']],
  );
};

const SELLER_MESSAGE_MODAL_STYLE_MARKER = 'data-recued-seller-message-modal-styles';
let sellerConfirmModalSequence = 0;
const SELLER_MESSAGE_MODAL_STYLES = `
[${SELLER_MESSAGE_MODAL_ATTR}] {
  position: fixed;
  inset: 0;
  z-index: 160;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(24, 33, 36, .32);
}
[${SELLER_MESSAGE_MODAL_ATTR}] .seller-modal {
  width: min(420px, 100%);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 24px 48px rgba(24, 33, 36, .18);
  padding: 16px 18px;
}
[${SELLER_MESSAGE_MODAL_ATTR}] .seller-modal h4 { margin: 0 0 8px; font-size: 15px; }
[${SELLER_MESSAGE_MODAL_ATTR}] .seller-modal-body {
  margin: 0 0 16px;
  font-size: 13px;
  color: var(--fg-muted, #555);
}
[${SELLER_MESSAGE_MODAL_ATTR}] .seller-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
`;

/** D-196 — a small in-app confirm modal for the "Message customer" action. A
 *  fixed-position backdrop appended to `parent` (overlays without a body portal
 *  via injected styles); Cancel or Confirm removes it. There is no editable
 *  draft — the owner confirms a fixed action (send a fresh access link), they do
 *  not compose a message. */
const appendConfirmModal = (
  doc: Document,
  parent: HTMLElement,
  opts: {
    readonly title: string;
    readonly body: string;
    readonly confirmLabel: string;
    readonly onConfirm: () => void;
  },
): void => {
  // Inject the overlay styles once (real browser only — the fake test DOM has no
  // head; the modal still renders + is drivable there, just unstyled).
  const head = doc.head as HTMLHeadElement | undefined;
  if (
    head !== undefined
    && typeof head.querySelector === 'function'
    && head.querySelector(`style[${SELLER_MESSAGE_MODAL_STYLE_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(SELLER_MESSAGE_MODAL_STYLE_MARKER, '');
    style.textContent = SELLER_MESSAGE_MODAL_STYLES;
    head.appendChild(style);
  }
  const previouslyFocused = (doc as Document & {
    readonly activeElement?: Element | null;
  }).activeElement;
  const focusIfSupported = (element: unknown): void => {
    const focus = (element as { focus?: unknown } | null)?.focus;
    if (typeof focus === 'function') focus.call(element);
  };
  const backdrop = append(doc, parent, 'div', 'seller-modal-backdrop');
  backdrop.setAttribute(SELLER_MESSAGE_MODAL_ATTR, '');
  const dialog = append(doc, backdrop, 'div', 'seller-modal');
  const modalId = ++sellerConfirmModalSequence;
  const titleId = `recued-seller-confirm-title-${modalId}`;
  const bodyId = `recued-seller-confirm-body-${modalId}`;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.setAttribute('aria-describedby', bodyId);
  dialog.tabIndex = -1;
  const title = appendText(doc, dialog, 'h4', opts.title);
  title.setAttribute('id', titleId);
  const body = appendText(doc, dialog, 'p', opts.body);
  body.setAttribute('id', bodyId);
  body.className = 'seller-modal-body';
  const footer = append(doc, dialog, 'div', 'seller-modal-footer');
  let closed = false;
  let cancelButton: HTMLButtonElement;
  let confirmButton: HTMLButtonElement;
  const close = (): void => {
    if (closed) return;
    closed = true;
    dialog.removeEventListener('keydown', onKeyDown);
    backdrop.remove();
    focusIfSupported(previouslyFocused);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const activeElement = (doc as Document & {
      readonly activeElement?: Element | null;
    }).activeElement;
    if (event.shiftKey && (activeElement === cancelButton || activeElement === dialog)) {
      event.preventDefault();
      confirmButton.focus();
    } else if (!event.shiftKey && activeElement === confirmButton) {
      event.preventDefault();
      cancelButton.focus();
    }
  };
  cancelButton = appendButton(
    doc,
    footer,
    'Cancel',
    close,
    [[SELLER_MESSAGE_MODAL_CANCEL_ATTR, '']],
  );
  confirmButton = appendButton(
    doc,
    footer,
    opts.confirmLabel,
    () => {
      close();
      opts.onConfirm();
    },
    [[SELLER_MESSAGE_MODAL_CONFIRM_ATTR, '']],
  );
  dialog.addEventListener('keydown', onKeyDown);
  focusIfSupported(cancelButton);
};

const renderManualCustomerLifecycleControls = (
  doc: Document,
  parent: HTMLElement,
  overview: SellerOverview,
  callers: {
    readonly runExtendManualCustomer?: SellerManualCustomerExtendCaller;
    readonly runSwapManualCustomerTier?: SellerManualCustomerSwapTierCaller;
    readonly runCloseManualCustomer?: SellerManualCustomerCloseCaller;
    readonly runReissueManualCustomerToken?: SellerManualCustomerReissueTokenCaller;
  },
  formMessage: SellerFormMessage | null,
  applyResult: (
    response: SellerManualCustomerLifecycleResponse,
    message: SellerFormMessage,
  ) => void,
): void => {
  const manualCustomers = overview.customers.filter((customer) =>
    customer.lifecycle_source === 'manual');
  const openManualCustomers = manualCustomers.filter((customer) =>
    customer.access_state !== 'closed');
  if (manualCustomers.length === 0) return;
  if (
    callers.runExtendManualCustomer === undefined
    && callers.runSwapManualCustomerTier === undefined
    && callers.runCloseManualCustomer === undefined
    && callers.runReissueManualCustomerToken === undefined
  ) {
    return;
  }

  const activeManualTiers = overview.tiers.filter((tier) =>
    tier.lifecycle_source === 'manual' && tier.active);
  const customerOptions = manualCustomers.map((customer) => [
    customer.customer_id,
    `${customer.source_customer_id} (${customer.door_id})`,
  ] as const);
  const openCustomerOptions = openManualCustomers.map((customer) => [
    customer.customer_id,
    `${customer.source_customer_id} (${customer.door_id})`,
  ] as const);
  const tierOptionsForCustomer = (
    customer_id: string,
  ): ReadonlyArray<readonly [string, string]> => {
    const customer = openManualCustomers.find((row) => row.customer_id === customer_id);
    if (customer === undefined) return [];
    return activeManualTiers
      .filter((tier) => tier.door_id === customer.door_id)
      .map((tier) => [
        tier.entitlement_key,
        `${tier.display_name} (${tier.entitlement_key})`,
      ] as const);
  };
  const swapCustomerOptions = openManualCustomers
    .filter((customer) => tierOptionsForCustomer(customer.customer_id).length > 0)
    .map((customer) => [
      customer.customer_id,
      `${customer.source_customer_id} (${customer.door_id})`,
    ] as const);
  const canExtend = callers.runExtendManualCustomer !== undefined
    && openCustomerOptions.length > 0;
  const canSwap = callers.runSwapManualCustomerTier !== undefined
    && swapCustomerOptions.length > 0;
  const canClose = callers.runCloseManualCustomer !== undefined;
  const canReissue = callers.runReissueManualCustomerToken !== undefined
    && openCustomerOptions.length > 0;
  // "Message customer" rides the reissue caller (re-mint + email); it needs a
  // send-capable mail sender to actually deliver.
  const canMessage = canReissue;
  const claimEmailReady = overview.readiness.some(
    (item) => item.key === 'mail_sender' && item.state === 'ready',
  );
  if (!canExtend && !canSwap && !canClose && !canReissue) return;

  const section = append(doc, parent, 'section', 'seller-section');
  section.setAttribute(SELLER_CUSTOMER_LIFECYCLE_FORM_ATTR, '');
  appendText(doc, section, 'h4', 'Look after someone’s access');
  appendText(
    doc,
    section,
    'p',
    'Pick what to do for one of your customers. Their agreements '
      + 'live here. The package agreements are changed under Contracts.',
    'seller-form-intro',
  );
  const status = append(doc, section, 'div', 'seller-form-status');
  status.setAttribute(SELLER_CUSTOMER_LIFECYCLE_STATUS_ATTR, '');
  if (formMessage !== null) {
    status.textContent = formMessage.text;
    status.setAttribute('data-kind', formMessage.kind);
    if (formMessage.kind === 'error') status.setAttribute('role', 'alert');
  }

  const buttons: HTMLButtonElement[] = [];
  let pending = false;
  const setPending = (value: boolean): void => {
    pending = value;
    for (const button of buttons) button.disabled = value;
  };
  const runAction = <TResponse extends SellerManualCustomerLifecycleResponse>(
    workingText: string,
    successText: string | ((response: TResponse) => string),
    makeRequest: () => Promise<TResponse> | TResponse,
  ): void => {
    if (pending) return;
    setPending(true);
    status.removeAttribute('role');
    status.removeAttribute('data-kind');
    status.textContent = workingText;
    void Promise.resolve()
      .then(makeRequest)
      .then((response) => {
        const text = typeof successText === 'function'
          ? successText(response)
          : successText;
        applyResult(response, { kind: 'success', text });
      })
      .catch((err) => {
        status.setAttribute('role', 'alert');
        status.setAttribute('data-kind', 'error');
        status.textContent = humanizeRpcError(err);
      })
      .finally(() => {
        setPending(false);
      });
  };

  if (canExtend) {
    const action = append(doc, section, 'details', 'seller-lifecycle-action');
    appendText(doc, action, 'summary', 'Extend');
    const fields = append(doc, action, 'div', 'seller-customer-lifecycle-grid');
    const customerId = withAccessibleName(appendLifecycleSelect(
      doc,
      fields,
      'Customer',
      'extend.customer_id',
      openCustomerOptions,
    ), 'Who to give longer');
    const email = withAccessibleName(appendLifecycleField(
      doc,
      fields,
      'Email',
      'extend.email',
      { type: 'email' },
    ), 'Extension email');
    const currentPeriodEnd = withAccessibleName(appendLifecycleField(
      doc,
      fields,
      'When it ends',
      'extend.current_period_end',
      { type: 'number' },
    ), 'New end time');
    const sourceStatus = withAccessibleName(appendLifecycleField(
      doc,
      fields,
      'Source status',
      'extend.source_status',
    ), 'Extension source status');
    const footer = append(doc, action, 'div', 'seller-form-footer');
    const button = appendButton(
      doc,
      footer,
      'Extend',
      () => runAction(
        'Giving them longer…',
        'Their access now lasts longer.',
        () => {
          const emailValue = optionalInputValue(email);
          const periodEnd = parseOptionalWholeNumber(
            currentPeriodEnd,
            'When it ends',
          );
          const sourceStatusValue = optionalInputValue(sourceStatus);
          return callers.runExtendManualCustomer!({
            customer_id: requiredFieldValue(customerId, 'Customer'),
            ...(emailValue !== undefined ? { email: emailValue } : {}),
            ...(periodEnd !== undefined ? { current_period_end: periodEnd } : {}),
            ...(sourceStatusValue !== undefined
              ? { source_status: sourceStatusValue }
              : {}),
          });
        },
      ),
      [[SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'extend']],
    );
    buttons.push(button);
  }

  if (canSwap) {
    const action = append(doc, section, 'details', 'seller-lifecycle-action');
    appendText(doc, action, 'summary', 'Move to another package');
    // D-196 micro-call — a swap RE-STAMPS the customer's contract from the new
    // tier's template (`restampCustomerFromTierTemplate`, whose sole caller is
    // `swapCustomerTier`), which resets any per-customer grant edits made in
    // #contracts. That is correct on a tier move — the customer is on a different
    // plan now — but it is silent, and the edits are not recoverable from this
    // screen. Extend does NOT re-stamp; only swap does. Say so before the click.
    appendText(
      doc,
      action,
      'p',
      'Moving them re-issues their agreement from the new package. '
        + 'Anything you changed just for them, under Contracts, goes back to the '
        + 'package’s own wording. Only moving does this. Giving them longer does not.',
      'seller-table-detail',
    ).setAttribute(SELLER_SWAP_RESTAMP_HINT_ATTR, '');
    const fields = append(doc, action, 'div', 'seller-customer-lifecycle-grid');
    const customerId = withAccessibleName(appendLifecycleSelect(
      doc,
      fields,
      'Customer',
      'swap.customer_id',
      swapCustomerOptions,
    ), 'Who to move');
    const entitlementKey = withAccessibleName(appendLifecycleSelect(
      doc,
      fields,
      'Entitlement',
      'swap.entitlement_key',
      tierOptionsForCustomer(customerId.value),
    ), 'Swap what it unlocks');
    customerId.addEventListener('change', () => {
      clearChildren(entitlementKey);
      for (const [value, label] of tierOptionsForCustomer(customerId.value)) {
        appendOption(doc, entitlementKey, value, label);
      }
      entitlementKey.value = entitlementKey.children[0]
        ? (entitlementKey.children[0] as HTMLOptionElement).value
        : '';
    });
    const currentPeriodEnd = withAccessibleName(appendLifecycleField(
      doc,
      fields,
      'When it ends',
      'swap.current_period_end',
      { type: 'number' },
    ), 'New end time');
    const sourceStatus = withAccessibleName(appendLifecycleField(
      doc,
      fields,
      'Source status',
      'swap.source_status',
    ), 'Swap source status');
    const footer = append(doc, action, 'div', 'seller-form-footer');
    const button = appendButton(
      doc,
      footer,
      'Move to another package',
      () => runAction(
        'Moving them…',
        'They are on the new package.',
        () => {
          const periodEnd = parseOptionalWholeNumber(
            currentPeriodEnd,
            'When it ends',
          );
          const sourceStatusValue = optionalInputValue(sourceStatus);
          return callers.runSwapManualCustomerTier!({
            customer_id: requiredFieldValue(customerId, 'Customer'),
            entitlement_key: requiredFieldValue(entitlementKey, 'Entitlement'),
            ...(periodEnd !== undefined ? { current_period_end: periodEnd } : {}),
            ...(sourceStatusValue !== undefined
              ? { source_status: sourceStatusValue }
              : {}),
          });
        },
      ),
      [[SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'swap']],
    );
    buttons.push(button);
  }

  if (canClose) {
    const action = append(doc, section, 'details', 'seller-lifecycle-action');
    appendText(doc, action, 'summary', 'Close');
    const fields = append(doc, action, 'div', 'seller-customer-lifecycle-grid');
    const customerId = withAccessibleName(appendLifecycleSelect(
      doc,
      fields,
      'Customer',
      'close.customer_id',
      customerOptions,
    ), 'Customer to close');
    const reason = withAccessibleName(appendLifecycleSelect(
      doc,
      fields,
      'Reason',
      'close.reason',
      SELLER_CUSTOMER_CLOSE_REASONS.map((value) => [
        value,
        titleCase(value),
      ] as const),
    ), 'Close reason');
    reason.value = 'seller_manual';
    const sourceStatus = withAccessibleName(appendLifecycleField(
      doc,
      fields,
      'Source status',
      'close.source_status',
    ), 'Close source status');
    const footer = append(doc, action, 'div', 'seller-form-footer');
    const button = appendButton(
      doc,
      footer,
      'Close',
      () => runAction(
        'Closing customer.',
        'Customer closed.',
        () => {
          const sourceStatusValue = optionalInputValue(sourceStatus);
          return callers.runCloseManualCustomer!({
            customer_id: requiredFieldValue(customerId, 'Customer'),
            reason: requiredFieldValue(
              reason,
              'Reason',
            ) as SellerCustomerCloseReason,
            ...(sourceStatusValue !== undefined
              ? { source_status: sourceStatusValue }
              : {}),
          });
        },
      ),
      [[SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'close']],
    );
    buttons.push(button);
  }

  if (canReissue) {
    const action = append(doc, section, 'details', 'seller-lifecycle-action');
    appendText(doc, action, 'summary', 'Reissue token');
    const fields = append(doc, action, 'div', 'seller-customer-lifecycle-grid');
    const customerId = withAccessibleName(appendLifecycleSelect(
      doc,
      fields,
      'Customer',
      'reissue.customer_id',
      openCustomerOptions,
    ), 'Customer to reissue');
    const footer = append(doc, action, 'div', 'seller-form-footer');
    const button = appendButton(
      doc,
      footer,
      'Reissue token',
      () => runAction(
        'Reissuing token.',
        (response) => {
          return `Customer token reissued. Their one-off link: ${response.claim.claim_url}`;
        },
        () => callers.runReissueManualCustomerToken!({
          customer_id: requiredFieldValue(customerId, 'Customer'),
        }),
      ),
      [[SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'reissue']],
    );
    buttons.push(button);
  }

  if (canMessage) {
    const action = append(doc, section, 'details', 'seller-lifecycle-action');
    appendText(doc, action, 'summary', 'Message customer');
    appendText(
      doc,
      action,
      'p',
      'Email the customer a fresh one-time access link from your seller mail '
        + 'sender — no leaving Recued and no retyping their address.',
    ).className = 'seller-form-intro';
    const fields = append(doc, action, 'div', 'seller-customer-lifecycle-grid');
    const customerId = withAccessibleName(appendLifecycleSelect(
      doc,
      fields,
      'Customer',
      'message.customer_id',
      openCustomerOptions,
    ), 'Customer to message');
    const footer = append(doc, action, 'div', 'seller-form-footer');
    if (!claimEmailReady) {
      appendText(
        doc,
        footer,
        'div',
        'Set up a mailbox that can send, in Seller settings, before you message a customer.',
      ).className = 'seller-form-hint';
    }
    const button = appendButton(
      doc,
      footer,
      'Message customer',
      () => {
        if (pending) return;
        const id = requiredFieldValue(customerId, 'Customer');
        const customer = openManualCustomers.find((row) => row.customer_id === id);
        const email = customer?.email ?? null;
        if (email === null || email.length === 0) {
          status.setAttribute('role', 'alert');
          status.setAttribute('data-kind', 'error');
          status.textContent =
            'This customer has no email on file. Set one before messaging.';
          return;
        }
        appendConfirmModal(doc, parent, {
          title: 'Message customer',
          body:
            `Email a fresh one-time access link to ${email} from your seller `
            + 'sender. This replaces any earlier link that has not been claimed yet.',
          confirmLabel: 'Confirm & send',
          onConfirm: () =>
            runAction(
              'Emailing the access link.',
              (response) =>
                response.claim_email_delivery?.status === 'sent'
                  ? `Access link emailed to ${email}.`
                  : `Reissued, but the email did not send (${
                      response.claim_email_delivery?.status === 'failed'
                        ? response.claim_email_delivery.error_code
                        : 'unknown'
                    }). Copy the link: ${response.claim.claim_url}`,
              () =>
                callers.runReissueManualCustomerToken!({
                  customer_id: id,
                  send_claim_email: true,
                }),
            ),
        });
      },
      [[SELLER_CUSTOMER_LIFECYCLE_SUBMIT_ATTR, 'message']],
    );
    if (claimEmailReady) {
      buttons.push(button);
    } else {
      button.disabled = true;
    }
  }
};

const renderCustomers = (
  doc: Document,
  parent: HTMLElement,
  customers: readonly SellerCustomer[],
  linkRows = false,
): void => {
  const section = append(doc, parent, 'section', 'seller-section');
  appendText(doc, section, 'h4', 'Customer records');
  appendText(
    doc,
    section,
    'p',
    'Current customer access, delivery status, and the contract issued from their tier.',
    'seller-section-copy',
  );
  appendTable<SellerCustomer>(doc, section, {
    className: 'seller-table seller-customer-table',
    empty: 'No customers yet.',
    rows: customers,
    markRow: (customer, tr) =>
      tr.setAttribute(SELLER_CUSTOMER_ROW_ATTR, customer.customer_id),
    columns: [
      {
        label: 'Customer',
        render: (customer, td) => {
          const nameHost = linkRows ? doc.createElement('a') : td;
          if (linkRows) {
            const href = sellerDetailAddress('customers', customer.customer_id).hash;
            nameHost.setAttribute('href', href);
            nameHost.setAttribute(
              SELLER_COLLECTION_ITEM_LINK_ATTR,
              customer.customer_id,
            );
            nameHost.setAttribute(
              'aria-label',
              `Preview customer ${customer.customer_id} (${customer.source_customer_id}); press Enter to open`,
            );
            td.appendChild(nameHost);
          }
          const name = appendText(
            doc,
            nameHost,
            'strong',
            customer.source_customer_id,
          );
          name.setAttribute('title', customer.customer_id);
          appendText(
            doc,
            td,
            'div',
            formatOptional(customer.email),
            'seller-table-detail',
          );
          appendText(
            doc,
            td,
            'div',
            titleCase(customer.lifecycle_source),
            'seller-table-detail',
          );
        },
      },
      {
        label: 'Tier',
        render: (customer, td) => {
          appendText(doc, td, 'span', customer.tier_id);
          appendText(
            doc,
            td,
            'div',
            customer.door_id,
            'seller-table-detail',
          );
        },
      },
      { label: 'Access', value: (customer) => titleCase(customer.access_state) },
      {
        label: 'Status',
        value: (customer) => formatOptional(customer.source_status),
      },
      {
        label: 'Period end',
        value: (customer) => formatTimestamp(customer.current_period_end),
      },
      {
        label: 'Grace until',
        value: (customer) => formatTimestamp(customer.grace_until),
      },
      {
        label: 'Contract',
        render: (customer, td) => {
          // Customer-instance lifecycle belongs entirely to Seller. Only tier
          // templates deep-link to Contracts for grant authoring; linking a
          // stamped customer instance into the generic contract editor implied
          // it could be connected or revoked there, neither of which is true.
          appendContractId(doc, td, customer.contract_id);
        },
      },
      {
        label: 'Credentials',
        render: (customer, td) => {
          const tokens = [
            customer.inbound_token_id ? `in:${customer.inbound_token_id}` : null,
            customer.mcp_token_id ? `mcp:${customer.mcp_token_id}` : null,
          ]
            .filter((value): value is string => value !== null)
            .join(' / ');
          const value = appendText(
            doc,
            td,
            'span',
            tokens.length > 0 ? 'Issued' : 'Not issued',
          );
          if (tokens.length > 0) value.setAttribute('title', tokens);
        },
      },
    ],
  });
};

const renderUsage = (
  doc: Document,
  parent: HTMLElement,
  rollups: readonly SellerCustomerUsageRollup[],
  linkRows = false,
): void => {
  const section = append(doc, parent, 'section', 'seller-section');
  appendText(doc, section, 'h4', 'Usage records');
  appendText(
    doc,
    section,
    'p',
    'Metered units recorded against each customer contract and billing period.',
    'seller-section-copy',
  );
  appendTable<SellerCustomerUsageRollup>(doc, section, {
    className: 'seller-table seller-usage-table',
    empty: 'No usage rollups yet.',
    rows: rollups,
    markRow: (rollup, tr) =>
      tr.setAttribute(
        SELLER_USAGE_ROW_ATTR,
        `${rollup.contract_id}:${rollup.usage_kind}:${rollup.period_start}`,
      ),
    columns: [
      {
        label: 'Contract',
        render: (rollup, td) => {
          if (!linkRows) {
            td.textContent = rollup.contract_id;
            return;
          }
          const itemId = usageRollupId(rollup);
          const link = doc.createElement('a');
          link.setAttribute('href', sellerDetailAddress('usage', itemId).hash);
          link.setAttribute(SELLER_COLLECTION_ITEM_LINK_ATTR, itemId);
          link.setAttribute(
            'aria-label',
            `Preview ${titleCase(rollup.usage_kind)} usage for ${rollup.contract_id} `
              + `(${rollup.period_granularity} ${rollup.period_start}); press Enter to open`,
          );
          link.textContent = rollup.contract_id;
          td.appendChild(link);
        },
      },
      { label: 'Kind', value: (rollup) => titleCase(rollup.usage_kind) },
      {
        label: 'Period',
        value: (rollup) =>
          `${titleCase(rollup.period_granularity)} ${formatTimestamp(rollup.period_start)}`,
      },
      { label: 'Units', value: (rollup) => `${rollup.units}` },
    ],
  });
};

/** One anchor per "new" screen a list offers. Only the screens the paired
 *  server can serve are shown: a link to a form whose rpc is unwired would
 *  land on an "unavailable" notice. */
const renderListToolbar = (
  doc: Document,
  parent: HTMLElement,
  links: ReadonlyArray<{ readonly key: string; readonly label: string; readonly hash: string }>,
): void => {
  if (links.length === 0) return;
  const toolbar = append(doc, parent, 'nav', 'seller-list-toolbar');
  toolbar.setAttribute(SELLER_LIST_TOOLBAR_ATTR, '');
  toolbar.setAttribute('aria-label', 'Create');
  for (const entry of links) {
    const link = doc.createElement('a');
    link.setAttribute('href', entry.hash);
    link.setAttribute(SELLER_CREATE_LINK_ATTR, entry.key);
    link.textContent = entry.label;
    toolbar.appendChild(link);
  }
};

/** A record's screens as a tab strip of REAL addresses: each tab is a hash,
 *  so Back, reload, and a pasted link all keep the tab. */
const renderDetailTabs = (
  doc: Document,
  parent: HTMLElement,
  tabs: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly hash: string;
    readonly current: boolean;
  }>,
): void => {
  const strip = append(doc, parent, 'nav', 'seller-detail-tabs');
  strip.setAttribute(SELLER_DETAIL_TABS_ATTR, '');
  strip.setAttribute('aria-label', 'Record screens');
  for (const tab of tabs) {
    const link = doc.createElement('a');
    link.setAttribute('href', tab.hash);
    link.setAttribute(SELLER_DETAIL_TAB_ATTR, tab.key);
    if (tab.current) link.setAttribute('aria-current', 'page');
    link.textContent = tab.label;
    strip.appendChild(link);
  }
};

const readyCount = (overview: SellerOverview, keys: readonly string[]): number =>
  overview.readiness.filter((item) => keys.includes(item.key) && item.state === 'ready').length;

/** The setup directory: three screens, each with its live state, each its own
 *  address. What was one long scroll is now one choice. */
const renderSetupDirectory = (
  doc: Document,
  parent: HTMLElement,
  overview: SellerOverview,
): void => {
  const section = append(doc, parent, 'section', 'seller-directory');
  section.setAttribute(SELLER_SETUP_DIRECTORY_ATTR, '');
  appendText(doc, section, 'h4', 'Setup areas');
  appendText(
    doc,
    section,
    'p',
    'Each area is its own screen. The state beside it is read from the server right now.',
    'seller-section-copy',
  );
  const providerKeys = SELLER_PROVIDERS.map((spec) => spec.readiness_key as string);
  const providersReady = readyCount(overview, providerKeys);
  const senderReady = readyCount(overview, ['mail_sender']) === 1;
  const meta: Readonly<Record<SellerSetupSection, { readonly text: string; readonly state: string }>> = {
    defaults: {
      text: `${overview.settings.default_grace_hours}h grace · sender ${senderReady ? 'ready' : 'not chosen'}`,
      state: senderReady ? 'ready' : 'needs_setup',
    },
    providers: {
      text: `${providersReady} of ${SELLER_PROVIDERS.length} providers ready`,
      state: providersReady > 0 ? 'ready' : 'needs_setup',
    },
    gateway: {
      text: !overview.llm_gateway.configured
        ? 'No route set up'
        : overview.llm_gateway.paid_acknowledged
          ? 'Set up, and you have said yes'
          : 'Set up · you have not said yes to paid access',
      state: overview.llm_gateway.configured
        ? overview.llm_gateway.paid_acknowledged ? 'ready' : 'needs_setup'
        : 'not_wired',
    },
  };
  const list = append(doc, section, 'ul', 'seller-directory-list');
  for (const setupSection of SELLER_SETUP_SECTIONS) {
    const item = append(doc, list, 'li');
    const link = doc.createElement('a');
    link.setAttribute('href', sellerSetupAddress(setupSection).hash);
    link.setAttribute(SELLER_SETUP_ROW_ATTR, setupSection);
    link.setAttribute('data-state', meta[setupSection].state);
    const copy = append(doc, link, 'span', 'seller-directory-copy');
    appendText(doc, copy, 'strong', SELLER_SETUP_SECTION_META[setupSection].label);
    appendText(doc, copy, 'span', SELLER_SETUP_SECTION_META[setupSection].description);
    appendText(doc, link, 'span', meta[setupSection].text, 'seller-directory-meta');
    item.appendChild(link);
  }
};

const sellerDirectoryMeta = (
  overview: SellerOverview,
  subpage: SellerSubpage,
): string => {
  switch (subpage) {
    case 'overview':
      return `${overview.readiness.length} setup check${overview.readiness.length === 1 ? '' : 's'}`;
    case 'offers':
      return `${overview.offers?.length ?? 0} offer${(overview.offers?.length ?? 0) === 1 ? '' : 's'}`;
    case 'orders':
      return 'Paged purchase history';
    case 'tiers':
      return `${overview.counts.active_tiers} active of ${overview.counts.tiers}`;
    case 'customers':
      return `${overview.counts.active_customers} active of ${overview.counts.customers}`;
    case 'usage':
      return `${overview.usage_rollups.length} usage record${overview.usage_rollups.length === 1 ? '' : 's'}`;
    case 'setup': {
      const needsSetup = overview.readiness.filter(
        (item) => item.state !== 'ready',
      ).length;
      return needsSetup === 0
        ? 'Ready'
        : `${needsSetup} item${needsSetup === 1 ? '' : 's'} need attention`;
    }
  }
};

const renderSellerDirectory = (
  doc: Document,
  parent: HTMLElement,
  overview: SellerOverview,
): void => {
  const section = append(doc, parent, 'section', 'seller-directory');
  section.setAttribute(SELLER_DIRECTORY_ATTR, '');
  appendText(doc, section, 'h3', 'Seller tools');
  appendText(
    doc,
    section,
    'p',
    'Choose one area to review or manage. Each collection opens as a paged list '
      + 'and each row has its own focused detail view.',
    'seller-section-copy',
  );
  const list = append(doc, section, 'ul', 'seller-directory-list');
  for (const subpage of SELLER_SUBPAGES) {
    const item = append(doc, list, 'li');
    const link = doc.createElement('a');
    link.setAttribute('href', sellerListAddress(subpage).hash);
    link.setAttribute(SELLER_DIRECTORY_ROW_ATTR, subpage);
    const copy = append(doc, link, 'span', 'seller-directory-copy');
    appendText(doc, copy, 'strong', SELLER_SUBPAGE_META[subpage].label);
    appendText(doc, copy, 'span', SELLER_SUBPAGE_META[subpage].description);
    appendText(
      doc,
      link,
      'span',
      sellerDirectoryMeta(overview, subpage),
      'seller-directory-meta',
    );
    item.appendChild(link);
  }
};

interface SellerPagerOptions {
  readonly subpage: SellerCollectionSubpage;
  readonly page: number;
  readonly pageSize: number;
  readonly count: number;
  readonly total: number | null;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

const renderSellerPager = (
  doc: Document,
  parent: HTMLElement,
  opts: SellerPagerOptions,
): void => {
  const pager = append(doc, parent, 'nav', 'seller-pager');
  pager.setAttribute(SELLER_PAGER_ATTR, opts.subpage);
  pager.setAttribute('aria-label', `${SELLER_SUBPAGE_META[opts.subpage].label} pages`);
  const status = append(doc, pager, 'span', 'seller-page-status');
  status.setAttribute(SELLER_PAGE_STATUS_ATTR, '');
  if (opts.total === 0) {
    status.textContent = 'No items';
  } else if (opts.total === null) {
    status.textContent = opts.count === 0
      ? `Page ${opts.page} is empty`
      : `Page ${opts.page} · ${opts.count} item${opts.count === 1 ? '' : 's'}`;
  } else {
    const start = opts.count === 0 ? 0 : (opts.page - 1) * opts.pageSize + 1;
    const end = opts.count === 0 ? 0 : Math.min(start + opts.count - 1, opts.total);
    status.textContent = `Showing ${start}–${end} of ${opts.total}`;
  }

  const appendPageLink = (
    label: string,
    attr: string,
    targetPage: number,
    enabled: boolean,
  ): void => {
    const link = doc.createElement('a');
    link.setAttribute(attr, '');
    link.textContent = label;
    if (enabled) {
      link.setAttribute('href', sellerListAddress(opts.subpage, targetPage).hash);
    } else {
      link.setAttribute('aria-disabled', 'true');
    }
    pager.appendChild(link);
  };
  appendPageLink('Previous', SELLER_PAGE_PREVIOUS_ATTR, opts.page - 1, opts.hasPrevious);
  appendPageLink('Next', SELLER_PAGE_NEXT_ATTR, opts.page + 1, opts.hasNext);
};

export const mountSellerPage = (
  opts: MountSellerPageOptions,
): SellerPageMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountSellerPage: no document available - pass `opts.document` for non-browser environments',
    );
  }

  let disposed = false;
  let generation = 0;
  const addressedSelection = sellerAddressSelection(opts.initialAddress);
  const subpage: SellerSubpage | null = opts.initialAddress !== undefined
    ? addressedSelection.subpage
    : isSellerSubpage(opts.initialSubpage)
      ? opts.initialSubpage
      : null;
  const initialItemId = opts.initialAddress !== undefined
    ? addressedSelection.itemId
    : opts.initialItemId;
  const selectedItemId = isSellerCollectionSubpage(subpage)
    && typeof initialItemId === 'string'
    && initialItemId.trim().length > 0
    ? initialItemId.trim()
    : null;
  // The deeper levels only an address can name: a tier's detail tab, a create
  // screen, a setup section (with the provider a deep link chose).
  const detailTab: SellerTierDetailTab | null = subpage === 'tiers' && selectedItemId !== null
    ? addressedSelection.tab
    : null;
  const createVariant: SellerCreateVariant | null = selectedItemId === null
    && isSellerCreateSubpage(subpage)
    ? addressedSelection.create
    : null;
  const setupSection: SellerSetupSection | null = subpage === 'setup'
    ? addressedSelection.setupSection
    : null;
  const setupProvider: SellerProviderSource | null = setupSection === 'providers'
    ? addressedSelection.setupProvider
    : null;
  /** A paged list is on screen: not a record, not a create screen. */
  const isListView = isSellerCollectionSubpage(subpage)
    && selectedItemId === null
    && createVariant === null;
  const continuityKey = isSellerCollectionSubpage(subpage) && createVariant === null
    ? `seller:${subpage}`
    : null;
  const rememberedList = continuityKey === null
    ? null
    : readListContinuity(doc, continuityKey);
  const scrollRoot = opts.scrollRoot ?? opts.host;
  const pageSize = Math.min(
    positiveWholeNumber(opts.pageSize, SELLER_DEFAULT_PAGE_SIZE),
    SELLER_MAX_PAGE_SIZE,
  );
  let page = selectedItemId === null
    ? opts.initialAddress !== undefined
      ? addressedSelection.page
      : opts.initialPage === undefined || opts.initialPage === null
        ? positiveWholeNumber(rememberedList?.page, 1)
        : positiveWholeNumber(opts.initialPage, 1)
    : rememberedList?.page ?? 1;
  let pendingListRestore = isListView && rememberedList !== null;
  let phase: SellerPagePhase = 'loading';
  let overview: SellerOverview | null = null;
  let error: string | null = null;
  let mailInstances: readonly SellerMailInstanceOption[] | null = null;
  let mailListLoading = setupSection === 'defaults'
    && opts.runListMailInstances !== undefined;
  let mailListError: string | null = null;
  let orders: readonly SellerOrder[] | null = null;
  let ordersTruncated = false;
  let ordersError: string | null = null;
  let tierSyncFormMessage: SellerFormMessage | null = null;
  let offerStateFormMessage: SellerFormMessage | null = null;
  let settingsFormMessage: SellerFormMessage | null = null;
  let tierFormMessage: SellerFormMessage | null = null;
  // D-250 § D — its own message slot: a usage-limit save and a tier save are
  // separate forms on the same page, and sharing one status line would make a
  // limits error read as if the tier edit above it had failed.
  let tierUsageFormMessage: SellerFormMessage | null = null;
  let passTierFormMessage: SellerFormMessage | null = null;
  let passTierCreatedTemplateId: string | null = null;
  // The record a create screen just made: shown beneath the form with a link
  // to its own screen, so "what did I just create" needs no trip to the list.
  let createdTierId: string | null = null;
  let issuedCustomerId: string | null = null;
  let tierBulkAdjustFormMessage: SellerFormMessage | null = null;
  let customerFormMessage: SellerFormMessage | null = null;
  let customerLifecycleFormMessage: SellerFormMessage | null = null;
  let llmGatewayAckFormMessage: SellerFormMessage | null = null;
  let pendingLoad: Promise<void> = Promise.resolve();

  const wrapper = doc.createElement('div');
  wrapper.setAttribute(SELLER_PAGE_ATTR, '');
  wrapper.setAttribute(SELLER_PAGE_STATE_ATTR, phase);
  wrapper.setAttribute(SELLER_PAGE_SUBPAGE_ATTR, subpage ?? 'directory');
  wrapper.className = 'seller-page';
  const dynamicHost = doc.createElement('div');
  dynamicHost.className = 'seller-page-content';
  wrapper.appendChild(dynamicHost);
  opts.host.appendChild(wrapper);

  const navigate = (hash: string, mode: 'push' | 'replace'): void => {
    if (opts.onNavigate !== undefined) {
      opts.onNavigate(hash, mode);
      return;
    }
    try {
      if (doc.defaultView?.location !== undefined) {
        doc.defaultView.location.hash = hash;
      }
    } catch {
      // Sandboxed/narrowed mounts may expose no navigation authority.
    }
  };

  const rememberCollection = (itemId?: string): void => {
    if (continuityKey === null) return;
    updateListContinuity(doc, continuityKey, {
      page,
      ...(itemId === undefined ? {} : { focusedId: itemId }),
      scroll: readListScroll(scrollRoot),
    });
  };

  const preview = mountListPreview({
    host: wrapper,
    document: doc,
    scrollRoot,
    onOpen: (itemId) => {
      if (!isSellerCollectionSubpage(subpage)) return;
      rememberCollection(itemId);
      navigate(sellerDetailAddress(subpage, itemId).hash, 'push');
    },
  });

  const renderUnavailable = (title: string, detail: string): void => {
    const section = append(doc, dynamicHost, 'section', 'seller-section');
    appendText(doc, section, 'h4', title);
    appendText(doc, section, 'p', detail, 'seller-empty');
  };

  const localPage = <T,>(items: readonly T[]): {
    readonly rows: readonly T[];
    readonly total: number;
  } => {
    const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
    page = Math.min(page, pageCount);
    const start = (page - 1) * pageSize;
    return {
      rows: items.slice(start, start + pageSize),
      total: items.length,
    };
  };

  const appendCollectionHost = (
    collection: SellerCollectionSubpage,
    detailId: string | null,
  ): HTMLElement => {
    const host = append(
      doc,
      dynamicHost,
      'div',
      detailId === null ? 'seller-collection-list' : 'seller-collection-detail',
    );
    host.setAttribute(
      detailId === null
        ? SELLER_COLLECTION_LIST_ATTR
        : SELLER_COLLECTION_DETAIL_ATTR,
      detailId ?? collection,
    );
    return host;
  };

  const renderMissingItem = (
    collection: SellerCollectionSubpage,
    itemId: string,
  ): void => {
    const detail = appendCollectionHost(collection, itemId);
    appendText(doc, detail, 'h4', 'Item not found');
    appendText(
      doc,
      detail,
      'p',
      `No ${SELLER_SUBPAGE_META[collection].label.toLowerCase()} item matches “${itemId}”.`,
      'seller-empty',
    );
  };

  interface SellerCrumb { readonly key: string; readonly label: string; readonly hash: string }

  /** The record's own name for the breadcrumb, once the overview is here. */
  const itemLabel = (): string => {
    if (selectedItemId === null || !isSellerCollectionSubpage(subpage) || overview === null) {
      return selectedItemId ?? '';
    }
    switch (subpage) {
      case 'tiers':
        return overview.tiers.find((row) => row.tier_id === selectedItemId)?.display_name
          ?? selectedItemId;
      case 'customers': {
        const customer = overview.customers.find((row) => row.customer_id === selectedItemId);
        return customer?.email ?? customer?.source_customer_id ?? selectedItemId;
      }
      case 'offers':
        return overview.offers?.find((row) => row.offer_id === selectedItemId)?.display_name
          ?? selectedItemId;
      case 'orders':
      case 'usage':
        return selectedItemId;
    }
  };

  /** Every level above the current screen, each a real address. The last entry
   *  is the screen itself; the one before it is what Back means here. */
  const breadcrumbTrail = (): readonly SellerCrumb[] => {
    const trail: SellerCrumb[] = [
      { key: 'seller', label: 'Seller', hash: sellerDirectoryAddress().hash },
    ];
    if (subpage === null) return trail;
    trail.push({
      key: `section:${subpage}`,
      label: SELLER_SUBPAGE_META[subpage].label,
      hash: sellerListAddress(subpage, page).hash,
    });
    if (setupSection !== null) {
      trail.push({
        key: `setup:${setupSection}`,
        label: SELLER_SETUP_SECTION_META[setupSection].label,
        hash: sellerSetupAddress(setupSection).hash,
      });
      if (setupProvider !== null) {
        trail.push({
          key: `provider:${setupProvider}`,
          label: sellerProviderFor(setupProvider).label,
          hash: sellerSetupAddress('providers', setupProvider).hash,
        });
      }
    } else if (createVariant !== null && isSellerCreateSubpage(subpage)) {
      trail.push({
        key: `create:${createVariant}`,
        label: SELLER_CREATE_META[subpage][createVariant]?.label ?? 'New',
        hash: sellerCreateAddress(subpage, createVariant).hash,
      });
    } else if (selectedItemId !== null && isSellerCollectionSubpage(subpage)) {
      trail.push({
        key: `detail:${selectedItemId}`,
        label: itemLabel(),
        hash: sellerDetailAddress(subpage, selectedItemId).hash,
      });
      if (detailTab !== null) {
        trail.push({
          key: `tab:${detailTab}`,
          label: SELLER_TIER_TAB_META[detailTab].label,
          hash: sellerDetailAddress('tiers', selectedItemId, detailTab).hash,
        });
      }
    }
    return trail;
  };

  const screenDescription = (): string => {
    if (subpage === null) return 'Review seller activity or choose one area to manage.';
    if (setupSection !== null) return SELLER_SETUP_SECTION_META[setupSection].description;
    if (createVariant !== null && isSellerCreateSubpage(subpage)) {
      return SELLER_CREATE_META[subpage][createVariant]?.description
        ?? SELLER_SUBPAGE_META[subpage].description;
    }
    if (detailTab !== null) return SELLER_TIER_TAB_META[detailTab].description;
    return SELLER_SUBPAGE_META[subpage].description;
  };

  const renderJustCreatedTier = (host: HTMLElement): void => {
    if (createdTierId === null || overview === null) return;
    const created = overview.tiers.find((row) => row.tier_id === createdTierId);
    if (created === undefined) return;
    appendText(doc, host, 'h4', 'Just created');
    renderTiers(doc, host, [created], true);
  };

  const appendCreateHost = (
    collection: SellerCreateSubpage,
    variant: SellerCreateVariant,
  ): HTMLElement => {
    const host = append(doc, dynamicHost, 'section', 'seller-create');
    host.setAttribute(SELLER_CREATE_PAGE_ATTR, `${collection}:${variant}`);
    return host;
  };

  const render = (): void => {
    wrapper.setAttribute(SELLER_PAGE_STATE_ATTR, phase);
    clearChildren(dynamicHost);

    const header = append(doc, dynamicHost, 'header', 'seller-subpage-header');
    header.setAttribute(SELLER_SUBPAGE_HEADER_ATTR, subpage ?? 'directory');
    const heading = append(doc, header, 'div', 'seller-subpage-heading');
    const trail = breadcrumbTrail();
    const current = trail[trail.length - 1]!;
    if (subpage !== null) {
      // Back is the nearest ancestor; the trail is every ancestor. Both are
      // real addresses, so history and a pasted link agree with the screen.
      const parent = trail[trail.length - 2]!;
      const back = doc.createElement('a');
      back.setAttribute(SELLER_BACK_ATTR, '');
      back.setAttribute('href', parent.hash);
      back.textContent = `← Back to ${parent.label}`;
      heading.appendChild(back);
      const crumbs = append(doc, heading, 'nav', 'seller-breadcrumb');
      crumbs.setAttribute(SELLER_BREADCRUMB_ATTR, '');
      crumbs.setAttribute('aria-label', 'Seller location');
      const crumbList = append(doc, crumbs, 'ol');
      trail.forEach((crumb, index) => {
        const item = append(doc, crumbList, 'li');
        if (index === trail.length - 1) {
          appendText(doc, item, 'span', crumb.label).setAttribute('aria-current', 'page');
          return;
        }
        const link = doc.createElement('a');
        link.setAttribute('href', crumb.hash);
        link.setAttribute(SELLER_BREADCRUMB_LINK_ATTR, crumb.key);
        link.textContent = crumb.label;
        item.appendChild(link);
      });
      appendText(doc, heading, 'h3', current.label);
    }
    appendText(doc, heading, 'p', screenDescription(), 'seller-subpage-description');
    const toolbar = append(doc, header, 'div', 'seller-toolbar');
    const refreshButton = appendButton(
      doc,
      toolbar,
      'Refresh',
      () => {
        void refresh();
      },
      [[SELLER_REFRESH_ATTR, '']],
    );
    refreshButton.disabled = phase === 'loading';
    // The section strip: every Seller area is one click away from every
    // screen, the current one marked, no trip through the directory needed.
    if (subpage !== null) {
      const subnav = append(doc, header, 'nav', 'seller-subnav');
      subnav.setAttribute(SELLER_SUBNAV_ATTR, '');
      subnav.setAttribute('aria-label', 'Seller sections');
      for (const section of SELLER_SUBPAGES) {
        const link = doc.createElement('a');
        link.setAttribute('href', sellerListAddress(section).hash);
        link.setAttribute(SELLER_SUBNAV_LINK_ATTR, section);
        if (section === subpage) link.setAttribute('aria-current', 'page');
        link.textContent = SELLER_SUBPAGE_META[section].label;
        subnav.appendChild(link);
      }
    }
    if (phase === 'loading') {
      appendText(
        doc,
        dynamicHost,
        'p',
        subpage === null
          ? 'Loading Seller.'
          : `Loading ${SELLER_SUBPAGE_META[subpage].label.toLowerCase()}.`,
        'seller-empty',
      );
      return;
    }

    if (phase === 'error') {
      const alert = append(doc, dynamicHost, 'div', 'seller-error');
      alert.setAttribute(SELLER_ERROR_ATTR, '');
      alert.setAttribute('role', 'alert');
      alert.textContent = error ?? 'Seller overview failed to load.';
      return;
    }

    if (overview === null) return;
    if (subpage === null) {
      renderSellerDirectory(doc, dynamicHost, overview);
      return;
    }
    switch (subpage) {
      case 'overview':
        renderSummary(doc, dynamicHost, overview);
        renderReadiness(doc, dynamicHost, overview);
        break;

      case 'offers':
      {
        const offers = overview.offers ?? [];
        const applyOfferResult = (
          response: SellerOfferStateTransitionResponse,
          message: SellerFormMessage,
        ): void => {
          if (disposed) return;
          offerStateFormMessage = message;
          overview = response.overview;
          phase = 'ready';
          error = null;
          render();
        };
        if (selectedItemId !== null) {
          const offer = offers.find((row) => row.offer_id === selectedItemId);
          if (offer === undefined) {
            renderMissingItem('offers', selectedItemId);
            break;
          }
          const detail = appendCollectionHost('offers', selectedItemId);
          renderSellerOffers(
            doc,
            detail,
            [offer],
            opts.runTransitionOfferState,
            offerStateFormMessage,
            applyOfferResult,
          );
          break;
        }
        const paged = localPage(offers);
        const list = appendCollectionHost('offers', null);
        renderSellerOffers(
          doc,
          list,
          paged.rows,
          undefined,
          null,
          applyOfferResult,
          true,
        );
        renderSellerPager(doc, list, {
          subpage: 'offers',
          page,
          pageSize,
          count: paged.rows.length,
          total: paged.total,
          hasPrevious: page > 1,
          hasNext: page * pageSize < paged.total,
        });
        renderAccessOffersIntro(doc, list);
        break;
      }

      case 'orders':
        if (opts.runListOrders === undefined) {
          renderUnavailable(
            'Recued cannot show orders',
            'This paired server does not expose the Seller orders list. Update the server to use this page.',
          );
          break;
        }
        if (selectedItemId !== null) {
          const order = orders?.find((row) => row.order_key === selectedItemId);
          if (order === undefined) {
            renderMissingItem('orders', selectedItemId);
            break;
          }
          const detail = appendCollectionHost('orders', selectedItemId);
          renderOrders(doc, detail, {
            ...(opts.runRecipe !== undefined ? { runRecipe: opts.runRecipe } : {}),
            ...(opts.reloadOrders !== undefined
              ? { reloadOrders: opts.reloadOrders }
              : {}),
            orders: [order],
            truncated: false,
            error: ordersError,
          });
          break;
        }
        {
          const list = appendCollectionHost('orders', null);
          renderOrders(doc, list, {
            orders,
            truncated: ordersTruncated,
            error: ordersError,
            linkRows: true,
          });
          if (orders !== null) {
            renderSellerPager(doc, list, {
              subpage: 'orders',
              page,
              pageSize,
              count: orders.length,
              total: null,
              hasPrevious: page > 1,
              hasNext: ordersTruncated,
            });
          }
        }
        break;

      case 'tiers':
      {
        const applyTierResult = (
          response: SellerManualTierUpsertResponse,
          message: SellerFormMessage,
        ): void => {
          if (disposed) return;
          tierFormMessage = message;
          overview = response.overview;
          phase = 'ready';
          error = null;
          render();
        };
        const applyTierUsageResult = (
          response: SellerTierUsagePolicyResponse,
          message: SellerFormMessage,
        ): void => {
          if (disposed) return;
          tierUsageFormMessage = message;
          overview = response.overview;
          phase = 'ready';
          error = null;
          render();
        };
        const applyBulkResult = (
          response: SellerManualTierBulkAdjustResponse,
          message: SellerFormMessage,
        ): void => {
          if (disposed) return;
          tierBulkAdjustFormMessage = message;
          overview = response.overview;
          phase = 'ready';
          error = null;
          render();
        };
        if (createVariant !== null) {
          // Its own screen: `#settings/seller/tiers/new` / `…/new/pass`.
          const create = appendCreateHost('tiers', createVariant);
          if (createVariant === 'pass') {
            if (opts.runCreatePassTier === undefined) {
              renderUnavailable(
                'Recued cannot show pass tiers',
                'This paired server does not expose pass-tier creation. Update the server to use this screen.',
              );
              break;
            }
            renderCreatePassTierForm(
              doc,
              create,
              opts.runCreatePassTier,
              passTierFormMessage,
              passTierCreatedTemplateId,
              (response, message) => {
                if (disposed) return;
                passTierFormMessage = message;
                passTierCreatedTemplateId = response.template_contract_id;
                createdTierId = response.tier.tier_id;
                overview = response.overview;
                phase = 'ready';
                error = null;
                render();
              },
            );
            renderJustCreatedTier(create);
            break;
          }
          if (opts.runUpsertManualTier === undefined) {
            renderUnavailable(
              'Recued cannot show manual tiers',
              'This paired server does not expose manual tier writes. Update the server to use this screen.',
            );
            break;
          }
          renderManualTierForm(
            doc,
            create,
            overview.tiers,
            opts.runUpsertManualTier,
            tierFormMessage,
            (response, message) => {
              createdTierId = response.tier.tier_id;
              applyTierResult(response, message);
            },
          );
          renderJustCreatedTier(create);
          break;
        }
        if (selectedItemId !== null) {
          const tier = overview.tiers.find(
            (row) => row.tier_id === selectedItemId,
          );
          if (tier === undefined) {
            renderMissingItem('tiers', selectedItemId);
            break;
          }
          const detail = appendCollectionHost('tiers', selectedItemId);
          // Three screens behind three addresses: the record with its usage
          // limits, the metadata edit, and the bulk customer adjustment. The
          // manual-only screens are offered only for a manual tier with the
          // rpc wired; a Stripe / Paddle / Lemon Squeezy tier has one screen.
          const manualEditable = tier.lifecycle_source === 'manual';
          renderDetailTabs(doc, detail, [
            {
              key: 'record',
              label: 'Record',
              hash: sellerDetailAddress('tiers', tier.tier_id).hash,
              current: detailTab === null,
            },
            ...(manualEditable && opts.runUpsertManualTier !== undefined
              ? [{
                  key: 'edit',
                  label: SELLER_TIER_TAB_META.edit.label,
                  hash: sellerDetailAddress('tiers', tier.tier_id, 'edit').hash,
                  current: detailTab === 'edit',
                }]
              : []),
            ...(manualEditable && opts.runBulkAdjustManualTierCustomers !== undefined
              ? [{
                  key: 'customers',
                  label: SELLER_TIER_TAB_META.customers.label,
                  hash: sellerDetailAddress('tiers', tier.tier_id, 'customers').hash,
                  current: detailTab === 'customers',
                }]
              : []),
          ]);
          if (detailTab === 'edit') {
            if (!manualEditable || opts.runUpsertManualTier === undefined) {
              renderUnavailable(
                'You cannot edit this now',
                manualEditable
                  ? 'This paired server does not expose manual tier writes.'
                  : 'A provider-synchronized tier is edited at the provider; only its usage limits are set here.',
              );
              break;
            }
            renderManualTierForm(
              doc,
              detail,
              overview.tiers,
              opts.runUpsertManualTier,
              tierFormMessage,
              applyTierResult,
              tier.tier_id,
            );
            break;
          }
          if (detailTab === 'customers') {
            if (!manualEditable || opts.runBulkAdjustManualTierCustomers === undefined) {
              renderUnavailable(
                'You cannot change them all at once now',
                manualEditable
                  ? 'This paired server does not expose the bulk adjustment.'
                  : 'A provider-synchronized tier moves its customers through the provider\'s own events.',
              );
              break;
            }
            renderManualTierBulkAdjustForm(
              doc,
              detail,
              overview,
              opts.runBulkAdjustManualTierCustomers,
              tierBulkAdjustFormMessage,
              applyBulkResult,
              tier.tier_id,
            );
            break;
          }
          renderTiers(doc, detail, [tier]);
          // D-250 § D — ⛔ NOT GATED ON `lifecycle_source`, unlike the two tabs
          // above. A Stripe-synced tier is minted with an empty policy, i.e.
          // UNLIMITED, and the manual-tier form cannot touch it — so gating this
          // one the same way would leave exactly the unlimited tiers unreachable.
          if (opts.runSetTierUsagePolicy !== undefined) {
            renderTierUsagePolicyForm(
              doc,
              detail,
              tier,
              opts.runSetTierUsagePolicy,
              tierUsageFormMessage,
              applyTierUsageResult,
            );
          }
          break;
        }

        const paged = localPage(overview.tiers);
        const list = appendCollectionHost('tiers', null);
        renderListToolbar(doc, list, [
          ...(opts.runUpsertManualTier !== undefined
            ? [{ key: 'tiers:manual', label: 'New package you run yourself', hash: sellerCreateAddress('tiers', 'manual').hash }]
            : []),
          ...(opts.runCreatePassTier !== undefined
            ? [{ key: 'tiers:pass', label: 'New timed pass', hash: sellerCreateAddress('tiers', 'pass').hash }]
            : []),
        ]);
        renderTiers(doc, list, paged.rows, true);
        renderSellerPager(doc, list, {
          subpage: 'tiers',
          page,
          pageSize,
          count: paged.rows.length,
          total: paged.total,
          hasPrevious: page > 1,
          hasNext: page * pageSize < paged.total,
        });
        break;
      }

      case 'customers':
      {
        const applyLifecycleResult = (
          response: SellerManualCustomerLifecycleResponse,
          message: SellerFormMessage,
        ): void => {
          if (disposed) return;
          customerLifecycleFormMessage = message;
          overview = response.overview;
          phase = 'ready';
          error = null;
          render();
        };
        if (createVariant !== null) {
          // Its own screen: `#settings/seller/customers/new`.
          const create = appendCreateHost('customers', createVariant);
          if (opts.runIssueManualCustomer === undefined) {
            renderUnavailable(
              'You cannot give one out now',
              'This paired server does not expose manual customer issue. Update the server to use this screen.',
            );
            break;
          }
          renderManualCustomerForm(
            doc,
            create,
            overview.tiers,
            overview.readiness.some(
              (item) => item.key === 'mail_sender' && item.state === 'ready',
            ),
            opts.runIssueManualCustomer,
            customerFormMessage,
            (response, message) => {
              if (disposed) return;
              customerFormMessage = message;
              issuedCustomerId = response.customer.customer_id;
              overview = response.overview;
              phase = 'ready';
              error = null;
              render();
            },
          );
          if (issuedCustomerId !== null) {
            const issued = overview.customers.find((row) => row.customer_id === issuedCustomerId);
            if (issued !== undefined) {
              appendText(doc, create, 'h4', 'Just issued');
              renderCustomers(doc, create, [issued], true);
            }
          }
          break;
        }
        if (selectedItemId !== null) {
          const customer = overview.customers.find(
            (row) => row.customer_id === selectedItemId,
          );
          if (customer === undefined) {
            renderMissingItem('customers', selectedItemId);
            break;
          }
          const detail = appendCollectionHost('customers', selectedItemId);
          renderCustomers(doc, detail, [customer]);
          renderManualCustomerLifecycleControls(
            doc,
            detail,
            { ...overview, customers: [customer] },
            {
              ...(opts.runExtendManualCustomer !== undefined
                ? { runExtendManualCustomer: opts.runExtendManualCustomer }
                : {}),
              ...(opts.runSwapManualCustomerTier !== undefined
                ? { runSwapManualCustomerTier: opts.runSwapManualCustomerTier }
                : {}),
              ...(opts.runCloseManualCustomer !== undefined
                ? { runCloseManualCustomer: opts.runCloseManualCustomer }
                : {}),
              ...(opts.runReissueManualCustomerToken !== undefined
                ? { runReissueManualCustomerToken: opts.runReissueManualCustomerToken }
                : {}),
            },
            customerLifecycleFormMessage,
            applyLifecycleResult,
          );
          break;
        }

        const paged = localPage(overview.customers);
        const list = appendCollectionHost('customers', null);
        renderListToolbar(doc, list, opts.runIssueManualCustomer !== undefined
          ? [{ key: 'customers:manual', label: 'Give someone access', hash: sellerCreateAddress('customers', 'manual').hash }]
          : []);
        renderCustomers(doc, list, paged.rows, true);
        renderSellerPager(doc, list, {
          subpage: 'customers',
          page,
          pageSize,
          count: paged.rows.length,
          total: paged.total,
          hasPrevious: page > 1,
          hasNext: page * pageSize < paged.total,
        });
        break;
      }

      case 'usage':
      {
        if (selectedItemId !== null) {
          const rollup = overview.usage_rollups.find(
            (row) => usageRollupId(row) === selectedItemId,
          );
          if (rollup === undefined) {
            renderMissingItem('usage', selectedItemId);
            break;
          }
          const detail = appendCollectionHost('usage', selectedItemId);
          renderUsage(doc, detail, [rollup]);
          break;
        }
        const paged = localPage(overview.usage_rollups);
        const list = appendCollectionHost('usage', null);
        renderUsage(doc, list, paged.rows, true);
        renderSellerPager(doc, list, {
          subpage: 'usage',
          page,
          pageSize,
          count: paged.rows.length,
          total: paged.total,
          hasPrevious: page > 1,
          hasNext: page * pageSize < paged.total,
        });
        break;
      }

      case 'setup':
        // Three screens behind three addresses; the bare `setup` is their
        // directory, not one long scroll.
        if (setupSection === null) {
          renderSetupDirectory(doc, dynamicHost, overview);
          break;
        }
        {
          const section = append(doc, dynamicHost, 'div', 'seller-setup-section');
          section.setAttribute(SELLER_SETUP_SECTION_ATTR, setupSection);
          switch (setupSection) {
            case 'defaults':
              renderSettings(doc, section, overview);
              if (opts.runUpdateSellerSettings !== undefined) {
                renderSettingsForm(
                  doc,
                  section,
                  overview,
                  mailInstances,
                  {
                    callerAvailable: opts.runListMailInstances !== undefined,
                    loading: mailListLoading,
                    error: mailListError,
                  },
                  opts.runUpdateSellerSettings,
                  settingsFormMessage,
                  (response, message) => {
                    if (disposed) return;
                    settingsFormMessage = message;
                    overview = response.overview;
                    phase = 'ready';
                    error = null;
                    render();
                  },
                );
              }
              break;
            case 'providers':
              if (
                opts.runSynchronizeProviderTiers === undefined
                && opts.runSynchronizeStripeEntitlements === undefined
              ) {
                renderUnavailable(
                  'Recued cannot show packages from your payment service',
                  'This paired server does not expose the provider tier seed. Update the server to use this screen.',
                );
                break;
              }
              renderProviderTierSynchronizeForm(
                doc,
                section,
                overview,
                opts.runSynchronizeProviderTiers,
                opts.runSynchronizeStripeEntitlements,
                tierSyncFormMessage,
                (refreshed, message) => {
                  if (disposed) return;
                  tierSyncFormMessage = message;
                  overview = refreshed;
                  phase = 'ready';
                  error = null;
                  render();
                },
                setupProvider,
              );
              break;
            case 'gateway':
              renderLlmGateway(doc, section, overview);
              // Surface the acknowledgment only at the monetization boundary: a
              // configured route that has not yet been acknowledged.
              if (
                opts.runAcknowledgeLlmGatewayPaid !== undefined
                && overview.llm_gateway.configured
                && !overview.llm_gateway.paid_acknowledged
              ) {
                renderLlmGatewayAckForm(
                  doc,
                  section,
                  opts.runAcknowledgeLlmGatewayPaid,
                  llmGatewayAckFormMessage,
                  (response, message) => {
                    if (disposed) return;
                    llmGatewayAckFormMessage = message;
                    overview = response.overview;
                    phase = 'ready';
                    error = null;
                    render();
                  },
                );
              }
              break;
          }
        }
        break;
    }
    if (
      pendingListRestore
      && phase === 'ready'
      && isListView
    ) {
      pendingListRestore = false;
      const rememberedId = rememberedList?.focusedId;
      const links = Array.from(dynamicHost.querySelectorAll?.(
        `[${SELLER_COLLECTION_ITEM_LINK_ATTR}]`,
      ) ?? []) as HTMLElement[];
      const target = rememberedId === undefined
        ? null
        : links.find((link) =>
            link.getAttribute(SELLER_COLLECTION_ITEM_LINK_ATTR) === rememberedId,
          ) ?? null;
      restoreListScroll(scrollRoot, rememberedList?.scroll);
      focusListTarget(
        target
          ?? (dynamicHost.querySelector?.(`[${SELLER_BACK_ATTR}]`) as HTMLElement | null)
          ?? (dynamicHost.querySelector?.('button, a[href]') as HTMLElement | null),
      );
    }
  };

  const previewCollectionItem = (link: HTMLElement): void => {
    if (!isSellerCollectionSubpage(subpage)) return;
    const itemId = link.getAttribute(SELLER_COLLECTION_ITEM_LINK_ATTR);
    if (itemId === null) return;
    rememberCollection(itemId);
    const label = SELLER_SUBPAGE_META[subpage].label;
    const title = link.textContent?.trim() || itemId;
    preview.open({
      id: itemId,
      eyebrow: `${label} preview`,
      title,
      summary: `Review this ${label.toLocaleLowerCase()} item before you open everything about it, and where it came from.`,
      facts: [
        { label: 'Collection', value: label },
        { label: 'Record', value: itemId },
        { label: 'List page', value: String(page) },
      ],
      primaryLabel: 'Open full record',
    }, link);
  };

  const collectionLinkFrom = (target: EventTarget | null): HTMLElement | null => {
    const element = target as HTMLElement | null;
    if (element === null || typeof element.closest !== 'function') return null;
    return element.closest(
      `[${SELLER_COLLECTION_ITEM_LINK_ATTR}]`,
    ) as HTMLElement | null;
  };

  const onCollectionClick = (event: Event): void => {
    const mouse = event as MouseEvent;
    if (
      (typeof mouse.button === 'number' && mouse.button !== 0)
      || mouse.metaKey
      || mouse.ctrlKey
      || mouse.shiftKey
      || mouse.altKey
    ) return;
    const link = collectionLinkFrom(event.target);
    if (link === null) return;
    event.preventDefault();
    previewCollectionItem(link);
  };

  const onCollectionKeyDown = (event: Event): void => {
    const link = collectionLinkFrom(event.target);
    if (link === null || link !== event.target) return;
    const itemId = link.getAttribute(SELLER_COLLECTION_ITEM_LINK_ATTR);
    if (itemId === null || !isSellerCollectionSubpage(subpage)) return;
    const key = (event as KeyboardEvent).key;
    if (key === ' ') {
      (event as KeyboardEvent).preventDefault();
      previewCollectionItem(link);
    } else if (key === 'Enter') {
      (event as KeyboardEvent).preventDefault();
      rememberCollection(itemId);
      navigate(sellerDetailAddress(subpage, itemId).hash, 'push');
    }
  };

  wrapper.addEventListener('click', onCollectionClick);
  wrapper.addEventListener('keydown', onCollectionKeyDown);

  const refresh = async (): Promise<void> => {
    const ownGeneration = ++generation;
    phase = 'loading';
    error = null;
    tierSyncFormMessage = null;
    settingsFormMessage = null;
    offerStateFormMessage = null;
    tierFormMessage = null;
    passTierFormMessage = null;
    passTierCreatedTemplateId = null;
    createdTierId = null;
    issuedCustomerId = null;
    tierBulkAdjustFormMessage = null;
    customerFormMessage = null;
    customerLifecycleFormMessage = null;
    llmGatewayAckFormMessage = null;
    mailListLoading = setupSection === 'defaults'
      && opts.runListMailInstances !== undefined;
    mailListError = null;
    ordersError = null;
    render();
    const overviewLoad = Promise.resolve().then(() => opts.runGetOverview()).then(
      (next) => {
        if (disposed || ownGeneration !== generation) return;
        overview = next;
        error = null;
      },
      (err) => {
        if (disposed || ownGeneration !== generation) return;
        error = humanizeRpcError(err);
      },
    );
    const mailLoad = setupSection !== 'defaults' || opts.runListMailInstances === undefined
      ? Promise.resolve()
      : Promise.resolve()
          .then(() => opts.runListMailInstances!())
          .then(
            ({ instances }) => {
              if (disposed || ownGeneration !== generation) return;
              mailInstances = normalizeSellerMailInstances(instances);
              mailListLoading = false;
              mailListError = null;
            },
            (err) => {
              if (disposed || ownGeneration !== generation) return;
              // Best-effort + last-known-good: a transient list failure must not
              // erase previously verified send-capable options.
              mailListLoading = false;
              mailListError = humanizeRpcError(err);
            },
          );
    const ordersLoad = subpage !== 'orders' || opts.runListOrders === undefined
      ? Promise.resolve()
      : Promise.resolve()
          .then(() => opts.runListOrders!(
            selectedItemId === null
              ? { limit: pageSize, offset: (page - 1) * pageSize }
              : { order_key: selectedItemId, limit: 1 },
          ))
          .then(
            (response) => {
              if (disposed || ownGeneration !== generation) return;
              orders = response.orders;
              ordersTruncated = response.truncated;
              ordersError = null;
            },
            (err) => {
              if (disposed || ownGeneration !== generation) return;
              // Best-effort + last-known-good: a transient orders failure must
              // not gate the whole page, and must not erase a prior good list.
              ordersError = humanizeRpcError(err);
            },
          );
    const load = Promise.all([overviewLoad, mailLoad, ordersLoad]).then(() => {
      if (disposed || ownGeneration !== generation) return;
      phase = error === null ? 'ready' : 'error';
      render();
    });
    pendingLoad = load;
    await load;
  };

  pendingLoad = refresh();

  return {
    getState: () => ({
      phase,
      subpage,
      selectedItemId,
      page,
      tab: detailTab,
      create: createVariant,
      setupSection,
      setupProvider,
      overview,
      error,
    }),
    refresh,
    whenLoaded: () => pendingLoad,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      wrapper.removeEventListener('click', onCollectionClick);
      wrapper.removeEventListener('keydown', onCollectionKeyDown);
      preview.dispose();
      wrapper.remove();
    },
  };
};

export const SELLER_PAGE_STYLES = `
${REFERENCE_PROVENANCE_STYLES}
${LIST_PREVIEW_STYLES}
[${SELLER_PAGE_ATTR}] {
  display: grid;
  min-width: 0;
}
[${SELLER_PAGE_ATTR}] .seller-page-content {
  display: grid;
  gap: 16px;
  min-width: 0;
}
[${SELLER_PAGE_ATTR}] [${SELLER_DIRECTORY_ATTR}] {
  display: grid;
  gap: 10px;
  min-width: 0;
}
[${SELLER_PAGE_ATTR}] [${SELLER_DIRECTORY_ATTR}] > h3,
[${SELLER_PAGE_ATTR}] [${SELLER_DIRECTORY_ATTR}] > p {
  margin: 0;
}
[${SELLER_PAGE_ATTR}] .seller-directory-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
[${SELLER_PAGE_ATTR}] .seller-directory-list a {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--fg);
  padding: 12px;
  text-decoration: none;
}
[${SELLER_PAGE_ATTR}] .seller-directory-list a:hover {
  border-color: var(--border-strong);
  background: var(--surface-hover, var(--bg));
}
[${SELLER_PAGE_ATTR}] .seller-directory-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}
[${SELLER_PAGE_ATTR}] .seller-directory-copy span,
[${SELLER_PAGE_ATTR}] .seller-directory-meta {
  color: var(--fg-muted);
  font-size: 12px;
  line-height: 1.4;
}
[${SELLER_PAGE_ATTR}] .seller-directory-meta {
  text-align: right;
}
[${SELLER_PAGE_ATTR}] .seller-breadcrumb ol {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  color: var(--fg-muted);
}
[${SELLER_PAGE_ATTR}] .seller-breadcrumb li + li::before {
  content: '›';
  margin-right: 4px;
}
[${SELLER_PAGE_ATTR}] .seller-breadcrumb a {
  color: var(--accent);
  text-decoration: none;
}
[${SELLER_PAGE_ATTR}] .seller-breadcrumb a:hover {
  text-decoration: underline;
}
[${SELLER_PAGE_ATTR}] .seller-breadcrumb [aria-current='page'] {
  color: var(--fg);
  font-weight: 600;
}
[${SELLER_PAGE_ATTR}] .seller-subnav,
[${SELLER_PAGE_ATTR}] .seller-detail-tabs,
[${SELLER_PAGE_ATTR}] .seller-list-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
[${SELLER_PAGE_ATTR}] .seller-subnav a,
[${SELLER_PAGE_ATTR}] .seller-detail-tabs a,
[${SELLER_PAGE_ATTR}] .seller-list-toolbar a {
  min-height: var(--wc-control-h);
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--fg);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}
[${SELLER_PAGE_ATTR}] .seller-subnav a:hover,
[${SELLER_PAGE_ATTR}] .seller-detail-tabs a:hover,
[${SELLER_PAGE_ATTR}] .seller-list-toolbar a:hover {
  border-color: var(--border-strong);
  background: var(--surface-hover, var(--bg));
}
[${SELLER_PAGE_ATTR}] .seller-subnav a[aria-current='page'],
[${SELLER_PAGE_ATTR}] .seller-detail-tabs a[aria-current='page'] {
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--accent);
}
[${SELLER_PAGE_ATTR}] .seller-subnav a:focus-visible,
[${SELLER_PAGE_ATTR}] .seller-detail-tabs a:focus-visible,
[${SELLER_PAGE_ATTR}] .seller-list-toolbar a:focus-visible,
[${SELLER_PAGE_ATTR}] .seller-breadcrumb a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${SELLER_PAGE_ATTR}] .seller-list-toolbar a::before {
  content: '+';
  margin-right: 6px;
  font-weight: 700;
}
[${SELLER_PAGE_ATTR}] .seller-setup-section,
[${SELLER_PAGE_ATTR}] .seller-create {
  display: grid;
  gap: 16px;
}
[${SELLER_PAGE_ATTR}] .seller-directory-list a[data-state='needs_setup'] .seller-directory-meta {
  color: var(--warning, var(--fg));
}
[${SELLER_PAGE_ATTR}] [${SELLER_BACK_ATTR}] {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  width: fit-content;
  padding: 4px;
  border-radius: 6px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}
[${SELLER_PAGE_ATTR}] [${SELLER_BACK_ATTR}]:hover {
  background: var(--accent-weak);
  text-decoration: underline;
}
[${SELLER_PAGE_ATTR}] [${SELLER_BACK_ATTR}]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${SELLER_PAGE_ATTR}] [${SELLER_COLLECTION_LIST_ATTR}],
[${SELLER_PAGE_ATTR}] [${SELLER_COLLECTION_DETAIL_ATTR}] {
  display: grid;
  gap: 16px;
  min-width: 0;
}
[${SELLER_PAGE_ATTR}] [${SELLER_COLLECTION_ITEM_LINK_ATTR}] {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  padding: 4px 2px;
  border-radius: 5px;
  color: var(--accent);
  font-weight: 600;
  text-decoration: none;
}
[${SELLER_PAGE_ATTR}] [${SELLER_COLLECTION_ITEM_LINK_ATTR}]:hover {
  background: var(--accent-weak);
  text-decoration: underline;
}
[${SELLER_PAGE_ATTR}] [${SELLER_PAGER_ATTR}] {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
[${SELLER_PAGE_ATTR}] [${SELLER_PAGE_STATUS_ATTR}] {
  margin-right: auto;
  color: var(--fg-muted);
  font-size: 12px;
}
[${SELLER_PAGE_ATTR}] [${SELLER_PAGE_PREVIOUS_ATTR}],
[${SELLER_PAGE_ATTR}] [${SELLER_PAGE_NEXT_ATTR}] {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  color: var(--fg);
  font-size: 12px;
  font-weight: 600;
  min-width: 72px;
  padding: 6px 9px;
  text-align: center;
  text-decoration: none;
}
[${SELLER_PAGE_ATTR}] [${SELLER_PAGE_PREVIOUS_ATTR}][aria-disabled="true"],
[${SELLER_PAGE_ATTR}] [${SELLER_PAGE_NEXT_ATTR}][aria-disabled="true"] {
  color: var(--fg-muted);
  opacity: 0.6;
}
[${SELLER_PAGE_ATTR}] .seller-subpage-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 16px;
  align-items: start;
}
[${SELLER_PAGE_ATTR}] .seller-subpage-heading {
  display: grid;
  gap: 4px;
  min-width: 0;
}
[${SELLER_PAGE_ATTR}] .seller-subpage-heading h3,
[${SELLER_PAGE_ATTR}] .seller-subpage-description {
  margin: 0;
}
[${SELLER_PAGE_ATTR}] .seller-subpage-heading h3 {
  font-size: 17px;
}
[${SELLER_PAGE_ATTR}] .seller-subpage-description,
[${SELLER_PAGE_ATTR}] .seller-section-copy,
[${SELLER_PAGE_ATTR}] .seller-form-intro,
[${SELLER_PAGE_ATTR}] .seller-table-detail {
  color: var(--fg-muted);
  line-height: 1.45;
}
[${SELLER_PAGE_ATTR}] .seller-toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}
[${SELLER_PAGE_ATTR}] .seller-toolbar button,
[${SELLER_PAGE_ATTR}] .seller-form-footer button,
[${SELLER_PAGE_ATTR}] .seller-offer-actions button,
[${SELLER_PAGE_ATTR}] .seller-readiness-meta a {
  appearance: none;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  min-height: 36px;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
  cursor: pointer;
}
[${SELLER_PAGE_ATTR}] .seller-toolbar button:disabled,
[${SELLER_PAGE_ATTR}] .seller-form-footer button:disabled,
[${SELLER_PAGE_ATTR}] .seller-offer-actions button:disabled {
  opacity: 0.62;
  cursor: default;
}
[${SELLER_PAGE_ATTR}] .seller-section {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
[${SELLER_PAGE_ATTR}] .seller-section > h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[${SELLER_PAGE_ATTR}] .seller-action-disclosure > summary {
  box-sizing: border-box;
  min-height: 36px;
  padding: 8px 4px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  list-style-position: outside;
}
[${SELLER_PAGE_ATTR}] .seller-action-disclosure[open] > summary {
  margin-bottom: 2px;
}
[${SELLER_PAGE_ATTR}] .seller-lifecycle-action {
  display: grid;
  gap: 8px;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 9px 10px;
  background: var(--surface);
}
[${SELLER_PAGE_ATTR}] .seller-lifecycle-action > summary {
  box-sizing: border-box;
  min-height: 36px;
  padding: 8px 4px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--fg);
  font-size: 13px;
  font-weight: 600;
}
[${SELLER_PAGE_ATTR}] .seller-order-bucket {
  display: grid;
  gap: 6px;
  min-width: 0;
}
[${SELLER_PAGE_ATTR}] .seller-order-bucket h5 {
  margin: 6px 0 0;
  color: var(--fg);
  font-size: 13px;
  font-weight: 600;
}
[${SELLER_PAGE_ATTR}] .seller-stat[data-bucket="needs_owner"] dd {
  color: var(--warning, #8a5a00);
}
[${SELLER_PAGE_ATTR}] .seller-stat[data-bucket="timed_out"] dd {
  color: var(--fg-muted);
}
[${SELLER_PAGE_ATTR}] .seller-offer-actions {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 8px;
}
[${SELLER_PAGE_ATTR}] .seller-related-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
[${SELLER_PAGE_ATTR}] .seller-related-links a {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  padding: 4px;
  border-radius: 5px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  text-decoration: none;
}
[${SELLER_PAGE_ATTR}] .seller-related-links a:hover {
  background: var(--accent-weak);
  text-decoration: underline;
}
[${SELLER_PAGE_ATTR}] .seller-offer-task-links {
  display: grid;
  gap: 4px;
}
[${SELLER_PAGE_ATTR}] .seller-offer-archive {
  display: grid;
  gap: 6px;
}
[${SELLER_PAGE_ATTR}] .seller-offer-archive summary {
  box-sizing: border-box;
  min-height: 36px;
  padding: 8px 4px;
  border-radius: 6px;
  color: var(--danger);
  cursor: pointer;
  font-weight: 600;
}
[${SELLER_PAGE_ATTR}] .seller-stat-grid,
[${SELLER_PAGE_ATTR}] .seller-kv-grid {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(138px, 1fr));
  gap: 8px;
}
[${SELLER_PAGE_ATTR}] .seller-stat,
[${SELLER_PAGE_ATTR}] .seller-kv-item {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  padding: 9px 10px;
}
[${SELLER_PAGE_ATTR}] dt {
  margin: 0 0 4px;
  color: var(--fg-muted);
  font-size: 12px;
}
[${SELLER_PAGE_ATTR}] dd {
  margin: 0;
  color: var(--fg);
  font-weight: 600;
  overflow-wrap: anywhere;
}
[${SELLER_PAGE_ATTR}] .seller-stat dd {
  font-size: 18px;
  line-height: 1.2;
}
[${SELLER_PAGE_ATTR}] .seller-stat dd a {
  color: inherit;
  text-decoration: none;
}
[${SELLER_PAGE_ATTR}] .seller-stat dd a:hover {
  color: var(--accent);
  text-decoration: underline;
}
[${SELLER_PAGE_ATTR}] .seller-readiness-list {
  display: grid;
  gap: 8px;
}
[${SELLER_PAGE_ATTR}] .seller-readiness-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  background: var(--surface);
}
[${SELLER_PAGE_ATTR}] .seller-readiness-main {
  display: grid;
  gap: 3px;
  min-width: 0;
}
[${SELLER_PAGE_ATTR}] .seller-readiness-main span {
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
[${SELLER_PAGE_ATTR}] .seller-readiness-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}
[${SELLER_PAGE_ATTR}] .seller-chip {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
[${SELLER_PAGE_ATTR}] [data-state="ready"] .seller-chip {
  color: var(--success, #147a3d);
}
[${SELLER_PAGE_ATTR}] [data-state="needs_setup"] .seller-chip {
  color: var(--warning, #8a5a00);
}
[${SELLER_PAGE_ATTR}] [data-state="not_wired"] .seller-chip {
  color: var(--fg-muted);
}
[${SELLER_PAGE_ATTR}] .seller-settings-form-grid,
[${SELLER_PAGE_ATTR}] .seller-tier-form-grid,
[${SELLER_PAGE_ATTR}] .seller-tier-bulk-adjust-grid,
[${SELLER_PAGE_ATTR}] .seller-customer-form-grid,
[${SELLER_PAGE_ATTR}] .seller-customer-lifecycle-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  min-width: 0;
}
[${SELLER_PAGE_ATTR}] .seller-form-field {
  display: grid;
  gap: 5px;
  min-width: 0;
  color: var(--fg-muted);
  font-size: 12px;
  font-weight: 600;
}
[${SELLER_PAGE_ATTR}] .seller-form-field-wide {
  grid-column: 1 / -1;
}
[${SELLER_PAGE_ATTR}] .seller-form-field input,
[${SELLER_PAGE_ATTR}] .seller-form-field select,
[${SELLER_PAGE_ATTR}] .seller-form-field textarea {
  min-height: 38px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font: inherit;
  font-size: 13px;
  padding: 7px 8px;
}
[${SELLER_PAGE_ATTR}] .seller-form-field textarea {
  resize: vertical;
}
[${SELLER_PAGE_ATTR}] .seller-form-checks,
[${SELLER_PAGE_ATTR}] .seller-form-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}
[${SELLER_PAGE_ATTR}] .seller-advanced-settings {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 9px 10px;
  background: var(--surface);
}
[${SELLER_PAGE_ATTR}] .seller-advanced-settings summary {
  box-sizing: border-box;
  min-height: 36px;
  padding: 8px 4px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
[${SELLER_PAGE_ATTR}] .seller-advanced-settings[open] summary {
  margin-bottom: 10px;
}
[${SELLER_PAGE_ATTR}] .seller-form-check {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 2px;
  color: var(--fg);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
[${SELLER_PAGE_ATTR}] .seller-form-check input {
  width: 16px;
  height: 16px;
  margin: 0;
  accent-color: var(--accent);
  cursor: inherit;
}
[${SELLER_PAGE_ATTR}] .seller-form-status {
  min-height: 18px;
  color: var(--fg-muted);
  overflow-wrap: anywhere;
}
[${SELLER_PAGE_ATTR}] .seller-form-status[role="alert"] {
  color: var(--danger);
  font-weight: 600;
}
[${SELLER_PAGE_ATTR}] .seller-form-status[data-kind="success"] {
  color: var(--success, #147a3d);
  font-weight: 600;
}
[${SELLER_PAGE_ATTR}] .seller-contract-link {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  padding: 4px 2px;
  border-radius: 5px;
  color: var(--accent);
  font-weight: 600;
  text-decoration: none;
}
[${SELLER_PAGE_ATTR}] .seller-contract-link:hover {
  background: var(--accent-weak);
  text-decoration: underline;
}
[${SELLER_PAGE_ATTR}] .seller-paid-workflow-table a {
  box-sizing: border-box;
  min-height: 36px;
  display: inline-flex;
  align-items: center;
  padding: 4px 2px;
  border-radius: 5px;
  color: var(--accent);
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
[${SELLER_PAGE_ATTR}] .seller-paid-workflow-table a:hover {
  background: var(--accent-weak);
  text-decoration: underline;
}
[${SELLER_PAGE_ATTR}] .seller-action-disclosure > summary:focus-visible,
[${SELLER_PAGE_ATTR}] .seller-lifecycle-action > summary:focus-visible,
[${SELLER_PAGE_ATTR}] .seller-offer-archive summary:focus-visible,
[${SELLER_PAGE_ATTR}] .seller-advanced-settings summary:focus-visible,
[${SELLER_PAGE_ATTR}] [${SELLER_COLLECTION_ITEM_LINK_ATTR}]:focus-visible,
[${SELLER_PAGE_ATTR}] .seller-related-links a:focus-visible,
[${SELLER_PAGE_ATTR}] .seller-contract-link:focus-visible,
[${SELLER_PAGE_ATTR}] .seller-paid-workflow-table a:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${SELLER_PAGE_ATTR}] .seller-table-wrap {
  overflow-x: auto;
}
[${SELLER_PAGE_ATTR}] table {
  width: 100%;
  min-width: 720px;
  border-collapse: collapse;
  font-size: 12px;
}
[${SELLER_PAGE_ATTR}] th,
[${SELLER_PAGE_ATTR}] td {
  padding: 7px 8px;
  border-bottom: 1px solid var(--border);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
[${SELLER_PAGE_ATTR}] th {
  color: var(--fg-muted);
  font-weight: 600;
}
[${SELLER_PAGE_ATTR}] .seller-empty {
  margin: 0;
  color: var(--fg-muted);
}
[${SELLER_PAGE_ATTR}] .seller-error {
  border-left: 3px solid var(--danger);
  background: var(--surface);
  padding: 10px 12px;
  color: var(--fg);
  font-weight: 600;
}
@media (max-width: 720px) {
  [${SELLER_PAGE_ATTR}] .seller-directory-list a {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  [${SELLER_PAGE_ATTR}] .seller-directory-meta {
    text-align: left;
  }
  [${SELLER_PAGE_ATTR}] .seller-subpage-header {
    grid-template-columns: 1fr;
  }
  [${SELLER_PAGE_ATTR}] .seller-toolbar {
    justify-content: flex-start;
  }
  [${SELLER_PAGE_ATTR}] .seller-readiness-row {
    grid-template-columns: 1fr;
  }
  [${SELLER_PAGE_ATTR}] .seller-readiness-meta {
    justify-content: flex-start;
  }
}
`;
