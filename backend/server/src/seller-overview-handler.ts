/** D-196 + D-200 — core-owned Settings -> Seller controls and projections. */

import { randomUUID } from 'node:crypto';

import {
  AUTHORABLE_DOOR_TYPES,
  RpcError,
  clampSellerOrderListLimit,
  isLlmGatewayPaidAcknowledged,
  isSellerCustomerCloseReason,
  isSellerOfferState,
  LLM_GATEWAY_PAID_ACK_VERSION,
  type AuthorableDoorType,
  type SellerAcknowledgeLlmGatewayPaidRequest,
  type SellerAcknowledgeLlmGatewayPaidResponse,
  type SellerCreatePassTierRequest,
  type SellerCreatePassTierResponse,
  type SellerListOrdersRequest,
  type SellerListOrdersResponse,
  type SellerManualCustomerCloseRequest,
  type SellerManualCustomerCloseResponse,
  type SellerManualCustomerExtendRequest,
  type SellerManualCustomerExtendResponse,
  type HandlerSlice,
  type SellerManualCustomerIssueRequest,
  type SellerManualCustomerIssueResponse,
  type SellerManualCustomerReissueTokenRequest,
  type SellerManualCustomerReissueTokenResponse,
  type SellerManualCustomerSwapTierRequest,
  type SellerManualCustomerSwapTierResponse,
  type SellerManualTierBulkAdjustRequest,
  type SellerManualTierBulkAdjustResponse,
  type SellerManualTierUpsertRequest,
  type SellerManualTierUpsertResponse,
  type SellerOfferStateTransitionRequest,
  type SellerOfferStateTransitionResponse,
  type SellerOverview,
  type SellerOverviewLlmGateway,
  type SellerOverviewReadinessItem,
  type SellerSettingsUpdateRequest,
  type SellerSettingsUpdateResponse,
  type SellerStripeSynchronizeRequest,
  type SellerStripeSynchronizeResponse,
  type SellerProviderTierSynchronizeRequest,
  type SellerProviderTierSynchronizeResponse,
  type ServerRpcRegistry,
  SELLER_PROVIDERS,
  SELLER_USAGE_KINDS,
  type SellerProviderSpec,
  type SellerTierUsagePolicyRequest,
  type SellerTierUsagePolicyResponse,
} from '@recued/contracts';

import type { LLMConfigManager } from './llm-config.js';
import {
  SellerCustomerAccessError,
  createSellerCustomerAccessLifecycle,
} from './seller/customer-access-lifecycle.js';
import {
  SellerCustomerClaimConfigurationError,
  createSellerCustomerClaimSupport,
  deliverSellerCustomerClaimEmail,
  readSellerCustomerAfterClaimDelivery,
} from './seller/customer-claim-delivery.js';
import { mintCustomerTemplateShell } from './seller/customer-template-shell.js';
import {
  stripeEntitlementProviderFrom,
  synchronizeSellerStripeEntitlements as synchronizeStripeEntitlements,
} from './seller/stripe-entitlement-sync.js';
import {
  SellerProviderTierSynchronizationError,
  synchronizeSellerProviderTiers as synchronizeProviderTiers,
  type SellerProviderTierProvider,
} from './seller/provider-tier-sync.js';
import {
  PEER_HANDLE_CONFLICT_PREFIX,
  type ChatInboundTokenStore,
} from './storage/chat-inbound-token-store.js';
import { resolveSellerCustomerUsagePolicy } from './seller/customer-usage-policy.js';
import { createContractDefinitionStore } from './storage/contract-definition-store.js';
import { createContractGrantEntryStore } from './storage/contract-grant-entry-store.js';
import type { ContractStore } from './storage/contract-store.js';
import {
  SellerClaimStoreValidationError,
  type SellerClaimStore,
} from './storage/seller-claim-store.js';
import type { SellerOrderStore } from './storage/seller-order-store.js';
import {
  SellerStoreConflictError,
  SellerStoreValidationError,
  type SellerStore,
} from './storage/seller-store.js';
import type { WsClient } from './ws-server.js';

export type SellerOverviewMethods =
  | 'server.seller.getOverview'
  | 'server.seller.listOrders'
  | 'server.seller.transitionOfferState'
  | 'server.seller.updateSettings'
  | 'server.seller.acknowledgeLlmGatewayPaid'
  | 'server.seller.upsertManualTier'
  | 'server.seller.setTierUsagePolicy'
  | 'server.seller.createPassTier'
  | 'server.seller.issueManualCustomer'
  | 'server.seller.extendManualCustomer'
  | 'server.seller.swapManualCustomerTier'
  | 'server.seller.closeManualCustomer'
  | 'server.seller.reissueManualCustomerToken'
  | 'server.seller.bulkAdjustManualTierCustomers'
  | 'server.seller.synchronizeStripeEntitlements'
  | 'server.seller.synchronizeProviderTiers';

export interface SellerOverviewHandlerDeps {
  readonly sellerStore: SellerStore;
  /** D-207 order-is-the-lifecycle — the `core.seller.order` read store backing
   *  the owner Orders view. Absent on db-less boots keeps `listOrders`
   *  explicitly `not_configured` while every other seller control stays usable. */
  readonly sellerOrderStore?: SellerOrderStore;
  readonly contractStore?: ContractStore;
  readonly inboundTokenStore?: ChatInboundTokenStore;
  readonly sellerClaimStore?: SellerClaimStore;
  /** Authoritative Reception public base URL. Resolved lazily so lifecycle
   *  operations that do not mint a bearer remain available without exposure. */
  readonly getPublicBaseUrl?: () => string;
  readonly llmManager?: Pick<LLMConfigManager, 'getConfig'>;
  readonly mintedBy?: string;
  readonly now?: () => number;
  readonly newContractId?: () => string;
  readonly newCustomerId?: () => string;
  readonly newTierId?: () => string;
  /** D-196 consolidation — the ONE tier-seed seam for every provider in
   *  `SELLER_PROVIDERS` (the shipped Stripe-only rpc adapts over it). Absent on
   *  a boot without the gateway, which leaves every Synchronize unavailable
   *  while every manual Seller control remains usable. */
  readonly providerTierProvider?: SellerProviderTierProvider;
  /** Resolve against the live collection registry. True only for a currently
   *  registered mail instance whose provider is send-capable. */
  readonly isLiveSendCapableMailInstance?: (instanceId: string) => boolean;
  /** Canonical audited mail-send path, composed from the live collection
   *  registry. Claim delivery never reaches a provider directly. */
  readonly sendClaimMail?: (input: {
    readonly instance_id: string;
    readonly to: string;
    readonly subject: string;
    readonly body_text: string;
  }) => Promise<{
    readonly message_id: string;
    readonly sent_at: number;
  }>;
}

const SELLER_MANUAL_TIER_METHOD = 'server.seller.upsertManualTier';
const SELLER_CREATE_PASS_TIER_METHOD = 'server.seller.createPassTier';
const SELLER_SETTINGS_UPDATE_METHOD = 'server.seller.updateSettings';
const SELLER_OFFER_STATE_TRANSITION_METHOD =
  'server.seller.transitionOfferState';
const SELLER_MANUAL_CUSTOMER_METHOD = 'server.seller.issueManualCustomer';
const SELLER_MANUAL_CUSTOMER_EXTEND_METHOD = 'server.seller.extendManualCustomer';
const SELLER_MANUAL_CUSTOMER_SWAP_TIER_METHOD = 'server.seller.swapManualCustomerTier';
const SELLER_MANUAL_CUSTOMER_CLOSE_METHOD = 'server.seller.closeManualCustomer';
const SELLER_MANUAL_CUSTOMER_REISSUE_TOKEN_METHOD =
  'server.seller.reissueManualCustomerToken';
const SELLER_MANUAL_TIER_BULK_ADJUST_METHOD =
  'server.seller.bulkAdjustManualTierCustomers';
const SELLER_STRIPE_SYNCHRONIZE_METHOD =
  'server.seller.synchronizeStripeEntitlements';
const SELLER_PROVIDER_TIERS_SYNCHRONIZE_METHOD =
  'server.seller.synchronizeProviderTiers';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const badSellerRequest = (method: SellerOverviewMethods, message: string): RpcError =>
  new RpcError(
    'bad_request',
    `${method}: ${message}`,
    400,
    method,
  );

const badManualTierRequest = (message: string): RpcError =>
  badSellerRequest(SELLER_MANUAL_TIER_METHOD, message);

const badManualCustomerRequest = (message: string): RpcError =>
  badSellerRequest(SELLER_MANUAL_CUSTOMER_METHOD, message);

const badManualCustomerLifecycleRequest = (
  method: SellerOverviewMethods,
  message: string,
): RpcError => badSellerRequest(method, message);

const sellerClaimNotConfigured = (method: SellerOverviewMethods): RpcError =>
  new RpcError(
    'not_configured',
    `${method}: one-time customer claims require the sealed claim store, a public HTTPS Reception URL, and an MCP or LLM gateway customer access type`,
    503,
    method,
  );

const requiredStringField = (
  args: Record<string, unknown>,
  field: string,
  badRequest: (message: string) => RpcError = badManualTierRequest,
): string => {
  const value = args[field];
  if (typeof value !== 'string') {
    throw badRequest(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw badRequest(`${field} must be a non-empty string`);
  }
  return trimmed;
};

const optionalStringOrNullField = (
  args: Record<string, unknown>,
  field: string,
  badRequest: (message: string) => RpcError,
): string | null | undefined => {
  const value = args[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') {
    throw badRequest(`${field} must be a string or null`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const optionalStringField = (
  args: Record<string, unknown>,
  field: string,
  badRequest: (message: string) => RpcError,
): string | undefined => {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw badRequest(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw badRequest(`${field} must be a non-empty string`);
  }
  return trimmed;
};

const optionalBooleanField = (
  args: Record<string, unknown>,
  field: 'customer_status_enabled_default' | 'active',
): boolean | undefined => {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw badManualTierRequest(`${field} must be a boolean`);
  }
  return value;
};

const optionalRequestBooleanField = (
  args: Record<string, unknown>,
  field: string,
  badRequest: (message: string) => RpcError,
): boolean | undefined => {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw badRequest(`${field} must be a boolean`);
  }
  return value;
};

const optionalNonNegativeIntegerOrNull = (
  args: Record<string, unknown>,
  field: string,
  badRequest: (message: string) => RpcError = badManualTierRequest,
): number | null | undefined => {
  const value = args[field];
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw badRequest(`${field} must be a non-negative integer or null`);
  }
  return value;
};

const optionalNonNegativeInteger = (
  args: Record<string, unknown>,
  field: string,
  badRequest: (message: string) => RpcError,
): number | undefined => {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw badRequest(`${field} must be a non-negative integer`);
  }
  return value;
};

const optionalRecordField = (
  args: Record<string, unknown>,
  field: 'usage_policy_json' | 'status_policy_json' | 'email_policy_json',
  badRequest: (message: string) => RpcError = badManualTierRequest,
): Readonly<Record<string, unknown>> | undefined => {
  const value = args[field];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw badRequest(`${field} must be a JSON object`);
  }
  return value;
};

const rejectPresentFields = (
  args: Record<string, unknown>,
  fields: ReadonlyArray<string>,
  badRequest: (message: string) => RpcError,
  reason: string,
): void => {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(args, field)) {
      throw badRequest(`${field} ${reason}`);
    }
  }
};

const optionalStringArrayField = (
  args: Record<string, unknown>,
  field: 'customer_ids',
  badRequest: (message: string) => RpcError,
): readonly string[] | undefined => {
  const value = args[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw badRequest(`${field} must be an array`);
  }
  if (value.length === 0) {
    throw badRequest(`${field} must not be empty`);
  }
  const out = value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw badRequest(`${field}[${index}] must be a string`);
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      throw badRequest(`${field}[${index}] must be a non-empty string`);
    }
    return trimmed;
  });
  if (new Set(out).size !== out.length) {
    throw badRequest(`${field} must not contain duplicates`);
  }
  return out;
};

const manualCustomerTarget = (
  args: Record<string, unknown>,
  method: SellerOverviewMethods,
) => {
  const badRequest = (message: string) =>
    badManualCustomerLifecycleRequest(method, message);
  const customer_id = optionalStringField(args, 'customer_id', badRequest);
  const door_id = optionalStringField(args, 'door_id', badRequest);
  const source_customer_id = optionalStringField(
    args,
    'source_customer_id',
    badRequest,
  );

  if (
    customer_id === undefined
    && (door_id === undefined || source_customer_id === undefined)
  ) {
    throw badRequest(
      'target requires customer_id or both door_id and source_customer_id',
    );
  }

  return {
    lifecycle_source: 'manual' as const,
    ...(customer_id !== undefined ? { customer_id } : {}),
    ...(door_id !== undefined ? { door_id } : {}),
    ...(source_customer_id !== undefined ? { source_customer_id } : {}),
  };
};

const createManualCustomerLifecycle = (
  deps: SellerOverviewHandlerDeps,
  method: SellerOverviewMethods,
) => {
  if (!deps.contractStore || !deps.inboundTokenStore) {
    throw new RpcError(
      'not_configured',
      `${method}: contract and inbound-token stores are required`,
      501,
      method,
    );
  }
  const contractStore = deps.contractStore;
  const inboundTokenStore = deps.inboundTokenStore;
  const grantEntryStore = createContractGrantEntryStore(contractStore);
  const claimSupport = createSellerCustomerClaimSupport({
    ...(deps.getPublicBaseUrl ? { getPublicBaseUrl: deps.getPublicBaseUrl } : {}),
    ...(deps.llmManager ? { llmManager: deps.llmManager } : {}),
  });
  const lifecycle = createSellerCustomerAccessLifecycle({
    sellerStore: deps.sellerStore,
    contractStore,
    grantEntryStore,
    inboundTokenStore,
    ...(deps.sellerClaimStore ? { sellerClaimStore: deps.sellerClaimStore } : {}),
    buildClaimPayload: claimSupport.buildClaimPayload,
    requireClaimOnTokenIssue: true,
    mintedBy: deps.mintedBy ?? 'server:seller:manual',
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.newContractId ? { newContractId: deps.newContractId } : {}),
    ...(deps.newCustomerId ? { newCustomerId: deps.newCustomerId } : {}),
    transaction: (fn) => contractStore.transaction(fn),
  });
  return {
    contractStore,
    lifecycle,
    toPublicClaim: claimSupport.toPublicClaim,
  };
};

const mapManualCustomerLifecycleError = (
  method: SellerOverviewMethods,
  error: unknown,
): never => {
  if (error instanceof RpcError) throw error;
  if (
    error instanceof SellerClaimStoreValidationError
    || error instanceof SellerCustomerClaimConfigurationError
  ) {
    throw sellerClaimNotConfigured(method);
  }
  if (
    error instanceof SellerCustomerAccessError
    || error instanceof SellerStoreValidationError
  ) {
    throw new RpcError(
      'bad_request',
      `${method}: ${error.message}`,
      400,
      method,
    );
  }
  if (
    error instanceof SellerStoreConflictError
    || (error instanceof Error && error.message.startsWith(PEER_HANDLE_CONFLICT_PREFIX))
  ) {
    throw new RpcError(
      'conflict',
      `${method}: ${error.message}`,
      409,
      method,
    );
  }
  throw error;
};

const isLlmGatewayRoute = (value: unknown): value is string =>
  value === 'pool' || value === 'slot:slot_1' || value === 'slot:slot_2';

const readLlmGateway = (
  llmManager: Pick<LLMConfigManager, 'getConfig'> | undefined,
  settings: SellerOverview['settings'],
): SellerOverviewLlmGateway => {
  // D-196 §4.9 / I-7 — the paid-gateway acknowledgment is a seller-settings fact,
  // independent of whether the Settings → LLM route is readable, so it rides on
  // every branch below.
  const paid_ack_at = settings.llm_gateway_paid_ack_at;
  const paid_acknowledged = isLlmGatewayPaidAcknowledged(settings);
  if (!llmManager) {
    return {
      configured: false,
      config_readable: false,
      default_route: null,
      model_alias: null,
      paid_ack_at,
      paid_acknowledged,
    };
  }
  try {
    const config = llmManager.getConfig() as Record<string, unknown>;
    const default_route = isLlmGatewayRoute(config.llm_gateway_default_route)
      ? config.llm_gateway_default_route
      : null;
    const rawAlias = config.llm_gateway_model_alias;
    const model_alias =
      typeof rawAlias === 'string' && rawAlias.trim().length > 0
        ? rawAlias.trim()
        : null;
    return {
      configured: default_route !== null,
      config_readable: true,
      default_route,
      model_alias,
      paid_ack_at,
      paid_acknowledged,
    };
  } catch {
    return {
      configured: false,
      config_readable: false,
      default_route: null,
      model_alias: null,
      paid_ack_at,
      paid_acknowledged,
    };
  }
};

const buildReadiness = (
  settings: SellerOverview['settings'],
  llm_gateway: SellerOverviewLlmGateway,
  senderReady: boolean,
  tierProvider: SellerProviderTierProvider | undefined,
): SellerOverviewReadinessItem[] => {
  // One readiness row per registry provider, all off the one seam: a row is
  // `not_wired` when the seam is absent, `needs_setup` until a connection of
  // that vendor is bound to its seller catalog with the tier-identity read
  // granted, `ready` after.
  const providerReadiness = (spec: SellerProviderSpec): SellerOverviewReadinessItem => {
    let count: number | null = null;
    if (tierProvider !== undefined) {
      try {
        count = tierProvider.listConnections(spec.source).length;
      } catch {
        count = 0;
      }
    }
    const identity = spec.tier_identity === 'entitlement_feature' ? 'entitlement read' : 'product read';
    return {
      key: spec.readiness_key,
      state: count === null ? 'not_wired' : count > 0 ? 'ready' : 'needs_setup',
      label: `${spec.label} provider`,
      detail: count === null
        ? `${spec.label} Initialize and Synchronize are unavailable on this server.`
        : count === 0
          ? `Install the ${spec.catalog_slug} pack, enroll a ${spec.label} API connection, and grant its ${identity} before synchronizing.`
          : `${count} ${spec.label} connection${count === 1 ? '' : 's'} ready for Initialize / Synchronize.`,
      href: count === 0 ? '#connections' : null,
    };
  };
  return [
  {
    key: 'manual_lifecycle',
    state: 'ready',
    label: 'Manual lifecycle',
    detail: 'Manual tiers and customers can be managed without a payment provider.',
    href: '#contracts',
  },
  ...SELLER_PROVIDERS.map(providerReadiness),
  {
    key: 'mail_sender',
    state: senderReady ? 'ready' : 'needs_setup',
    label: 'Claim/status sender',
    detail: senderReady
      ? 'A send-capable mail instance is selected for claim and status email.'
      : settings.sender_mail_instance_id
        ? 'The selected sender is missing, not live, or no longer send-capable. Choose another mail instance.'
        : 'Choose a send-capable mail instance before automated claim or status email.',
    href: '#connections',
  },
  {
    key: 'llm_gateway',
    state: llm_gateway.configured ? 'ready' : 'needs_setup',
    label: 'LLM gateway route',
    // The `state` tracks route SETUP only — a free door (customer service,
    // booking, internal tooling) is fully ready with a configured route and no
    // acknowledgment (I-6). The paid-access acknowledgment is surfaced here in
    // the detail and carried on `llm_gateway.paid_acknowledged`; a paid
    // (seller-customer) turn fails closed until the owner acknowledges (I-7).
    detail: llm_gateway.configured
      ? llm_gateway.paid_acknowledged
        ? `Gateway route ${llm_gateway.default_route} is configured; paid access is acknowledged.`
        : `Gateway route ${llm_gateway.default_route} is configured. Selling PAID OpenAI-compatible chat also needs the one-time route-rights acknowledgment below; free access needs none.`
      : llm_gateway.config_readable
        ? 'Configure an llm_gateway route in Settings -> AI / Models before selling OpenAI-compatible chat.'
        : 'Unlock or wire Settings -> AI / Models to inspect the llm_gateway route.',
    href: '#settings/ai-models',
  },
  ];
};

export const isSellerSenderMailInstanceReady = (
  deps: SellerOverviewHandlerDeps,
  instanceId: string | null,
): boolean => {
  if (instanceId === null || instanceId.trim().length === 0) return false;
  try {
    return deps.isLiveSendCapableMailInstance?.(instanceId) === true;
  } catch {
    return false;
  }
};

export const buildSellerOverview = (
  deps: SellerOverviewHandlerDeps,
): SellerOverview => {
  const settings = deps.sellerStore.getSettings();
  const tiers = deps.sellerStore.listTiers();
  const customers = deps.sellerStore.listCustomers();
  const offers = deps.sellerStore.listOffers();
  const contractIds = [...new Set(customers.map((customer) => customer.contract_id))];
  const usage_rollups = contractIds.flatMap((contractId) =>
    deps.sellerStore.listUsageRollups(contractId));
  const llm_gateway = readLlmGateway(deps.llmManager, settings);
  const senderReady = isSellerSenderMailInstanceReady(
    deps,
    settings.sender_mail_instance_id,
  );

  return {
    settings,
    tiers,
    customers,
    usage_rollups,
    counts: {
      tiers: tiers.length,
      active_tiers: tiers.filter((tier) => tier.active).length,
      customers: customers.length,
      active_customers: customers.filter((customer) => customer.access_state === 'active').length,
      grace_customers: customers.filter((customer) => customer.access_state === 'grace').length,
      closed_customers: customers.filter((customer) => customer.access_state === 'closed').length,
    },
    readiness: buildReadiness(
      settings,
      llm_gateway,
      senderReady,
      deps.providerTierProvider,
    ),
    llm_gateway,
    offers,
  };
};

/** D-207 order-is-the-lifecycle — the owner Orders view read model. Returns
 *  `core.seller.order` rows most-recent-first; the view groups them by
 *  `sellerOrderBucket(phase)`. Read-only: order lifecycle writes stay on the
 *  specialized order ops, never here. */
export const listSellerOrders = (
  deps: SellerOverviewHandlerDeps,
  request: SellerListOrdersRequest,
): SellerListOrdersResponse => {
  const method: SellerOverviewMethods = 'server.seller.listOrders';
  // The whole request is optional filters, so an absent/empty body is valid.
  const args: Record<string, unknown> = isRecord(request) ? request : {};
  const badRequest = (message: string) => badSellerRequest(method, message);
  const allowedFields = new Set(['limit', 'offset', 'order_key']);
  const unknownField = Object.keys(args).find((field) => !allowedFields.has(field));
  if (unknownField !== undefined) {
    throw badRequest(`unknown field '${unknownField}'`);
  }
  const limit = optionalNonNegativeInteger(args, 'limit', badRequest);
  const offset = optionalNonNegativeInteger(args, 'offset', badRequest) ?? 0;
  if (!Number.isSafeInteger(offset)) {
    throw badRequest('offset must be a non-negative safe integer');
  }
  const orderKey = optionalStringField(args, 'order_key', badRequest);
  if (!deps.sellerOrderStore) {
    throw new RpcError(
      'not_configured',
      `${method}: the seller order store is unavailable on this server`,
      503,
      method,
    );
  }
  if (orderKey !== undefined) {
    const order = deps.sellerOrderStore.getOrder(orderKey);
    return {
      orders: order === null ? [] : [order],
      truncated: false,
    };
  }
  // `clampSellerOrderListLimit` is the SAME clamp the store applies, so
  // `effectiveLimit` is the real page size. Probe ONE row past it: the store
  // never returns more than it is asked for, so comparing a full page against
  // its own size can only ever say "exactly full", never "more exist". Fetching
  // `+ 1` is what distinguishes "exactly N orders" from "N and older". (At the
  // hard ceiling the store re-clamps the probe, so truncation there degrades to
  // false — accepted, and far better than a false "older orders exist" at every
  // exact-page boundary.)
  const effectiveLimit = clampSellerOrderListLimit(limit);
  const probe = deps.sellerOrderStore.listOrders({
    limit: effectiveLimit + 1,
    offset,
  });
  const truncated = probe.length > effectiveLimit;
  const orders = truncated ? probe.slice(0, effectiveLimit) : probe;
  return { orders, truncated };
};

export const transitionSellerOfferState = (
  deps: SellerOverviewHandlerDeps,
  request: SellerOfferStateTransitionRequest,
): SellerOfferStateTransitionResponse => {
  const method = SELLER_OFFER_STATE_TRANSITION_METHOD;
  if (!isRecord(request)) {
    throw badSellerRequest(method, 'args must be an object');
  }
  const allowedFields = new Set([
    'offer_id',
    'expected_state',
    'expected_updated_at',
    'next_state',
  ]);
  const unknownField = Object.keys(request).find((field) => !allowedFields.has(field));
  if (unknownField !== undefined) {
    throw badSellerRequest(method, `unknown field '${unknownField}'`);
  }
  const badRequest = (message: string) => badSellerRequest(method, message);
  const offer_id = requiredStringField(request, 'offer_id', badRequest);
  const expected_state = request.expected_state;
  const expected_updated_at = request.expected_updated_at;
  const next_state = request.next_state;
  if (!isSellerOfferState(expected_state)) {
    throw badRequest('expected_state must be draft, active, paused, or archived');
  }
  if (!isSellerOfferState(next_state)) {
    throw badRequest('next_state must be draft, active, paused, or archived');
  }
  if (
    typeof expected_updated_at !== 'number'
    || !Number.isSafeInteger(expected_updated_at)
    || expected_updated_at < 0
  ) {
    throw badRequest('expected_updated_at must be a non-negative safe integer');
  }

  try {
    if (deps.sellerStore.getOffer(offer_id) === null) {
      throw new RpcError(
        'not_found',
        `${method}: offer_id '${offer_id}' does not exist`,
        404,
        method,
      );
    }
    const transition = deps.sellerStore.transitionOfferState({
      offer_id,
      expected_state,
      expected_updated_at,
      next_state,
      now: deps.now?.() ?? Date.now(),
    });
    return {
      ...transition,
      overview: buildSellerOverview(deps),
    };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof SellerStoreValidationError) {
      throw new RpcError(
        'bad_request',
        `${method}: ${error.message}`,
        400,
        method,
      );
    }
    if (error instanceof SellerStoreConflictError) {
      throw new RpcError(
        'conflict',
        `${method}: ${error.message}`,
        409,
        method,
      );
    }
    throw error;
  }
};

export const updateSellerSettings = (
  deps: SellerOverviewHandlerDeps,
  request: SellerSettingsUpdateRequest,
): SellerSettingsUpdateResponse => {
  const method = SELLER_SETTINGS_UPDATE_METHOD;
  if (!isRecord(request)) {
    throw badSellerRequest(method, 'args must be an object');
  }
  const badRequest = (message: string) => badSellerRequest(method, message);
  const default_grace_hours = optionalNonNegativeInteger(
    request,
    'default_grace_hours',
    badRequest,
  );
  const sender_mail_instance_id = optionalStringOrNullField(
    request,
    'sender_mail_instance_id',
    badRequest,
  );
  const status_policy_json = optionalRecordField(
    request,
    'status_policy_json',
    badRequest,
  );
  const email_policy_json = optionalRecordField(
    request,
    'email_policy_json',
    badRequest,
  );

  if (
    sender_mail_instance_id !== undefined
    && sender_mail_instance_id !== null
    && !isSellerSenderMailInstanceReady(deps, sender_mail_instance_id)
  ) {
    throw badRequest(
      `sender_mail_instance_id '${sender_mail_instance_id}' must resolve to a live send-capable mail instance`,
    );
  }

  try {
    const settings = deps.sellerStore.upsertSettings({
      ...(default_grace_hours !== undefined ? { default_grace_hours } : {}),
      ...(sender_mail_instance_id !== undefined ? { sender_mail_instance_id } : {}),
      ...(status_policy_json !== undefined ? { status_policy_json } : {}),
      ...(email_policy_json !== undefined ? { email_policy_json } : {}),
      now: deps.now?.() ?? Date.now(),
    });
    return {
      settings,
      overview: buildSellerOverview(deps),
    };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof SellerStoreValidationError) {
      throw new RpcError(
        'bad_request',
        `${method}: ${error.message}`,
        400,
        method,
      );
    }
    throw error;
  }
};

/** D-196 §4.9 / I-7 — record the one-time paid-`llm_gateway` route-rights
 *  acknowledgment (the monetization-boundary confirmation). Owner-only, like
 *  every seller control. The server stamps the timestamp + current terms
 *  version; a paid (seller-customer) `llm_gateway` turn fails closed until this
 *  is on record, while free/standing turns and `/v1/models` discovery are never
 *  gated. This is a dedicated op, not a `updateSettings` field: acknowledging is
 *  a deliberate act, and a routine grace/sender/policy edit must never toggle
 *  it. */
export const acknowledgeSellerLlmGatewayPaid = (
  deps: SellerOverviewHandlerDeps,
  request: SellerAcknowledgeLlmGatewayPaidRequest,
): SellerAcknowledgeLlmGatewayPaidResponse => {
  const method: SellerOverviewMethods = 'server.seller.acknowledgeLlmGatewayPaid';
  // An absent/empty body is valid — the owner confirms the server's current terms.
  const args: Record<string, unknown> = isRecord(request) ? request : {};
  const badRequest = (message: string) => badSellerRequest(method, message);
  const unknownField = Object.keys(args).find((field) => field !== 'ack_version');
  if (unknownField !== undefined) {
    throw badRequest(`unknown field '${unknownField}'`);
  }
  // Optional version guard: when the client names the terms it displayed, they
  // must match the server's current terms, so a stale page can never silently
  // record an acknowledgment of terms the owner never saw.
  const rawVersion = args.ack_version;
  if (rawVersion !== undefined) {
    if (typeof rawVersion !== 'string') {
      throw badRequest('ack_version must be a string');
    }
    if (rawVersion !== LLM_GATEWAY_PAID_ACK_VERSION) {
      throw badRequest(
        `ack_version '${rawVersion}' does not match the current terms `
          + `'${LLM_GATEWAY_PAID_ACK_VERSION}'; reload Settings -> Seller to review `
          + 'the current acknowledgment before confirming',
      );
    }
  }
  try {
    const settings = deps.sellerStore.acknowledgeLlmGatewayPaid({
      now: deps.now?.() ?? Date.now(),
    });
    return {
      settings,
      overview: buildSellerOverview(deps),
    };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof SellerStoreValidationError) {
      throw new RpcError('bad_request', `${method}: ${error.message}`, 400, method);
    }
    throw error;
  }
};

/** D-250 § D — set a tier's usage policy, whatever minted it.
 *
 *  ⛔⛔ VALIDATED BEFORE IT IS WRITTEN, AND THAT IS THE POINT OF THE HANDLER.
 *  `resolveSellerCustomerUsagePolicy` fails CLOSED on a malformed policy —
 *  `policy_invalid` denies every call — so an unparseable policy written here
 *  would lock out a PAYING customer, silently, until someone noticed. Absence
 *  is unlimited and malformed is denied, which means a typo is the expensive
 *  direction; the write refuses rather than shipping that.
 *
 *  ⚠ It validates EVERY usage kind, not the ones the request happens to name: a
 *  policy object carrying a broken `tool_call` alongside a good `chat_turn`
 *  would otherwise pass and take the door down for tool calls only. */
export const setSellerTierUsagePolicy = (
  deps: SellerOverviewHandlerDeps,
  request: SellerTierUsagePolicyRequest,
): SellerTierUsagePolicyResponse => {
  const method: SellerOverviewMethods = 'server.seller.setTierUsagePolicy';
  if (!isRecord(request)) {
    throw badSellerRequest(method, 'args must be an object');
  }
  const tier_id = requiredStringField(request, 'tier_id');
  const usage_policy_json = optionalRecordField(request, 'usage_policy_json');
  if (usage_policy_json === undefined) {
    throw badSellerRequest(method, 'usage_policy_json must be an object');
  }

  const existing = deps.sellerStore.getTier(tier_id);
  if (!existing) {
    throw badSellerRequest(method, `unknown tier_id: ${tier_id}`);
  }
  for (const usage_kind of SELLER_USAGE_KINDS) {
    const parsed = resolveSellerCustomerUsagePolicy(
      { ...existing, usage_policy_json },
      usage_kind,
    );
    if (!parsed.ok) {
      throw badSellerRequest(method, parsed.message);
    }
  }

  try {
    const tier = deps.sellerStore.setTierUsagePolicy({
      tier_id,
      usage_policy_json,
      now: deps.now?.() ?? Date.now(),
    });
    return { tier, overview: buildSellerOverview(deps) };
  } catch (error) {
    if (error instanceof SellerStoreValidationError) {
      throw new RpcError('bad_request', `${method}: ${error.message}`, 400, method);
    }
    throw error;
  }
};

export const upsertSellerManualTier = (
  deps: SellerOverviewHandlerDeps,
  request: SellerManualTierUpsertRequest,
): SellerManualTierUpsertResponse => {
  if (!isRecord(request)) {
    throw badManualTierRequest('args must be an object');
  }

  const usage_policy_json = optionalRecordField(request, 'usage_policy_json');
  const pass_duration_seconds = optionalNonNegativeIntegerOrNull(
    request,
    'pass_duration_seconds',
  );
  const customer_status_enabled_default = optionalBooleanField(
    request,
    'customer_status_enabled_default',
  );
  const active = optionalBooleanField(request, 'active');
  const display_name = optionalStringField(
    request,
    'display_name',
    badManualTierRequest,
  );
  const template_contract_id = optionalStringField(
    request,
    'template_contract_id',
    badManualTierRequest,
  );

  try {
    const tier = deps.sellerStore.upsertTier({
      tier_id: requiredStringField(request, 'tier_id'),
      door_id: requiredStringField(request, 'door_id'),
      lifecycle_source: 'manual',
      entitlement_key: requiredStringField(request, 'entitlement_key'),
      ...(display_name !== undefined ? { display_name } : {}),
      ...(template_contract_id !== undefined ? { template_contract_id } : {}),
      ...(usage_policy_json !== undefined ? { usage_policy_json } : {}),
      ...(pass_duration_seconds !== undefined ? { pass_duration_seconds } : {}),
      ...(customer_status_enabled_default !== undefined
        ? { customer_status_enabled_default }
        : {}),
      ...(active !== undefined ? { active } : {}),
      now: deps.now?.() ?? Date.now(),
    });
    return {
      tier,
      overview: buildSellerOverview(deps),
    };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof SellerStoreValidationError) {
      throw new RpcError(
        'bad_request',
        `${SELLER_MANUAL_TIER_METHOD}: ${error.message}`,
        400,
        SELLER_MANUAL_TIER_METHOD,
      );
    }
    if (error instanceof SellerStoreConflictError) {
      throw new RpcError(
        'conflict',
        `${SELLER_MANUAL_TIER_METHOD}: ${error.message}`,
        409,
        SELLER_MANUAL_TIER_METHOD,
      );
    }
    throw error;
  }
};

/** D-196 1d Phase 2 — mint a zero-grant `customer_template` shell for the door
 *  and bind a fresh manual pass tier to it in one atomic call. This removes the
 *  `upsertManualTier` friction of hand-authoring a template and pasting its id
 *  first, while holding the same anti-spoof posture: the lifecycle source is
 *  stamped `manual` server-side, and a caller-supplied `template_contract_id` /
 *  `tier_id` is refused (both are server-derived). The owner authors the
 *  template's grants (which tools/data the pass permits) in #contracts
 *  afterward — I-1 (a UI RPC never authors grants, only mints the empty shell
 *  the human fills) intact. Refuses when a manual tier already exists for the
 *  (door, entitlement) pair rather than silently re-pointing its template
 *  (which would drop the owner's authored grants); that edit path is
 *  `upsertManualTier`. The mint + tier bind run inside one contract-store
 *  transaction so a `upsertTier` failure never leaves an orphaned shell. */
export const createSellerPassTier = (
  deps: SellerOverviewHandlerDeps,
  request: SellerCreatePassTierRequest,
): SellerCreatePassTierResponse => {
  const method = SELLER_CREATE_PASS_TIER_METHOD;
  if (!isRecord(request)) {
    throw badSellerRequest(method, 'args must be an object');
  }
  const contractStore = deps.contractStore;
  if (!contractStore) {
    throw new RpcError(
      'not_configured',
      `${method}: pass-tier creation requires the contract store to mint the customer template`,
      503,
      method,
    );
  }
  const badRequest = (message: string): RpcError => badSellerRequest(method, message);
  rejectPresentFields(
    request as Record<string, unknown>,
    ['lifecycle_source', 'template_contract_id', 'tier_id'],
    badRequest,
    'is server-derived (the source is stamped `manual`, the template is freshly '
      + 'minted, and the tier id is generated) and must not be supplied',
  );

  const args = request as Record<string, unknown>;
  const door_id = requiredStringField(args, 'door_id', badRequest);
  const rawDoorType = args['door_type'];
  // Only the owner-authorable customer doors — a pass on a derived door
  // (`reception` / `webhook`) is nonsensical, so this is deliberately stricter
  // than the Stripe sync's broad `isDoorType` acceptance.
  if (
    typeof rawDoorType !== 'string'
    || !(AUTHORABLE_DOOR_TYPES as readonly string[]).includes(rawDoorType)
  ) {
    throw badRequest('door_type must be one of mcp, mcp_chat, llm_gateway');
  }
  const door_type = rawDoorType as AuthorableDoorType;
  const entitlement_key = requiredStringField(args, 'entitlement_key', badRequest);
  const display_name = requiredStringField(args, 'display_name', badRequest);
  const pass_duration_seconds = optionalNonNegativeIntegerOrNull(
    args,
    'pass_duration_seconds',
    badRequest,
  );
  const usage_policy_json = optionalRecordField(args, 'usage_policy_json', badRequest);

  const definitionStore = createContractDefinitionStore(contractStore, {
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.newContractId ? { newId: deps.newContractId } : {}),
  });
  const now = deps.now?.() ?? Date.now();
  const tier_id = deps.newTierId?.() ?? `seller_tier_${randomUUID()}`;

  try {
    let outcome:
      | {
          readonly tier: SellerCreatePassTierResponse['tier'];
          readonly template_contract_id: string;
        }
      | undefined;
    contractStore.transaction(() => {
      const existing = deps.sellerStore.findTier({
        door_id,
        lifecycle_source: 'manual',
        entitlement_key,
      });
      if (existing) {
        throw new SellerStoreConflictError(
          `a manual tier already exists for door '${door_id}' entitlement `
            + `'${entitlement_key}' (tier ${existing.tier_id}); edit it through `
            + 'upsertManualTier or pick a new entitlement key',
        );
      }
      const template = mintCustomerTemplateShell(definitionStore, {
        minted_by: deps.mintedBy ?? 'server:seller:pass-tier',
        display_name: `${display_name} customer template`,
        door_type,
      });
      const tier = deps.sellerStore.upsertTier({
        tier_id,
        door_id,
        lifecycle_source: 'manual',
        entitlement_key,
        display_name,
        template_contract_id: template.contract_id,
        ...(usage_policy_json !== undefined ? { usage_policy_json } : {}),
        ...(pass_duration_seconds !== undefined ? { pass_duration_seconds } : {}),
        now,
      });
      outcome = { tier, template_contract_id: template.contract_id };
    });
    if (!outcome) {
      throw new RpcError(
        'internal',
        `${method}: pass-tier creation did not complete`,
        500,
        method,
      );
    }
    return {
      tier: outcome.tier,
      template_contract_id: outcome.template_contract_id,
      overview: buildSellerOverview(deps),
    };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof SellerStoreValidationError) {
      throw new RpcError('bad_request', `${method}: ${error.message}`, 400, method);
    }
    if (error instanceof SellerStoreConflictError) {
      throw new RpcError('conflict', `${method}: ${error.message}`, 409, method);
    }
    throw error;
  }
};

export const issueSellerManualCustomer = async (
  deps: SellerOverviewHandlerDeps,
  request: SellerManualCustomerIssueRequest,
): Promise<SellerManualCustomerIssueResponse> => {
  const lifecycleDeps = createManualCustomerLifecycle(
    deps,
    SELLER_MANUAL_CUSTOMER_METHOD,
  );
  if (!deps.sellerClaimStore) {
    throw sellerClaimNotConfigured(SELLER_MANUAL_CUSTOMER_METHOD);
  }
  if (!isRecord(request)) {
    throw badManualCustomerRequest('args must be an object');
  }
  if (Object.prototype.hasOwnProperty.call(request, 'customer_id')) {
    throw badManualCustomerRequest(
      'customer_id is server-generated and must not be supplied on issue',
    );
  }
  rejectPresentFields(
    request,
    [
      'token_grants',
      'token_label',
      'token_expires_at',
      'token_concurrency_tier',
      'token_chat_mode',
    ],
    badManualCustomerRequest,
    'is server-derived from the selected tier template and must not be supplied',
  );

  const door_id = requiredStringField(
    request,
    'door_id',
    badManualCustomerRequest,
  );
  const source_customer_id = requiredStringField(
    request,
    'source_customer_id',
    badManualCustomerRequest,
  );
  const entitlement_key = requiredStringField(
    request,
    'entitlement_key',
    badManualCustomerRequest,
  );
  const email = optionalStringOrNullField(request, 'email', badManualCustomerRequest);
  const send_claim_email = optionalRequestBooleanField(
    request,
    'send_claim_email',
    badManualCustomerRequest,
  ) ?? false;
  const current_period_end = optionalNonNegativeIntegerOrNull(
    request,
    'current_period_end',
    badManualCustomerRequest,
  );
  const source_status = optionalStringOrNullField(
    request,
    'source_status',
    badManualCustomerRequest,
  );
  let result: ReturnType<typeof lifecycleDeps.lifecycle.issueCustomer>;
  try {
    result = lifecycleDeps.lifecycle.issueCustomer({
      lifecycle_source: 'manual',
      door_id,
      source_customer_id,
      entitlement_key,
      ...(email !== undefined ? { email } : {}),
      ...(current_period_end !== undefined ? { current_period_end } : {}),
      ...(source_status !== undefined ? { source_status } : {}),
    });
  } catch (error) {
    return mapManualCustomerLifecycleError(SELLER_MANUAL_CUSTOMER_METHOD, error);
  }
  const claim = result.issued_claim === null
    ? null
    : lifecycleDeps.toPublicClaim(result.issued_claim);
  const claim_email_delivery =
    send_claim_email
    && result.result === 'created'
    && result.issued_claim !== null
    && claim !== null
      ? await deliverSellerCustomerClaimEmail({
          deps,
          customer_id: result.customer.customer_id,
          email: result.customer.email,
          issued_claim: result.issued_claim,
          public_claim: claim,
        })
      : null;
  return {
    result: result.result,
    customer: readSellerCustomerAfterClaimDelivery(
      deps.sellerStore,
      result.customer,
    ),
    claim,
    claim_email_delivery,
    overview: buildSellerOverview(deps),
  };
};

export const extendSellerManualCustomer = (
  deps: SellerOverviewHandlerDeps,
  request: SellerManualCustomerExtendRequest,
): SellerManualCustomerExtendResponse => {
  const method = SELLER_MANUAL_CUSTOMER_EXTEND_METHOD;
  const { lifecycle } = createManualCustomerLifecycle(deps, method);
  if (!isRecord(request)) {
    throw badManualCustomerLifecycleRequest(method, 'args must be an object');
  }
  const badRequest = (message: string) =>
    badManualCustomerLifecycleRequest(method, message);
  const target = manualCustomerTarget(request, method);
  const email = optionalStringOrNullField(request, 'email', badRequest);
  const current_period_end = optionalNonNegativeIntegerOrNull(
    request,
    'current_period_end',
    badRequest,
  );
  const source_status = optionalStringOrNullField(
    request,
    'source_status',
    badRequest,
  );

  try {
    return {
      customer: lifecycle.extendCustomer({
        ...target,
        ...(email !== undefined ? { email } : {}),
        ...(current_period_end !== undefined ? { current_period_end } : {}),
        ...(source_status !== undefined ? { source_status } : {}),
      }),
      overview: buildSellerOverview(deps),
    };
  } catch (error) {
    return mapManualCustomerLifecycleError(method, error);
  }
};

export const swapSellerManualCustomerTier = (
  deps: SellerOverviewHandlerDeps,
  request: SellerManualCustomerSwapTierRequest,
): SellerManualCustomerSwapTierResponse => {
  const method = SELLER_MANUAL_CUSTOMER_SWAP_TIER_METHOD;
  const { lifecycle } = createManualCustomerLifecycle(deps, method);
  if (!isRecord(request)) {
    throw badManualCustomerLifecycleRequest(method, 'args must be an object');
  }
  const badRequest = (message: string) =>
    badManualCustomerLifecycleRequest(method, message);
  const target = manualCustomerTarget(request, method);
  const entitlement_key = requiredStringField(
    request,
    'entitlement_key',
    badRequest,
  );
  const current_period_end = optionalNonNegativeIntegerOrNull(
    request,
    'current_period_end',
    badRequest,
  );
  const source_status = optionalStringOrNullField(
    request,
    'source_status',
    badRequest,
  );

  try {
    return {
      customer: lifecycle.swapCustomerTier({
        ...target,
        entitlement_key,
        ...(current_period_end !== undefined ? { current_period_end } : {}),
        ...(source_status !== undefined ? { source_status } : {}),
      }),
      overview: buildSellerOverview(deps),
    };
  } catch (error) {
    return mapManualCustomerLifecycleError(method, error);
  }
};

export const closeSellerManualCustomer = (
  deps: SellerOverviewHandlerDeps,
  request: SellerManualCustomerCloseRequest,
): SellerManualCustomerCloseResponse => {
  const method = SELLER_MANUAL_CUSTOMER_CLOSE_METHOD;
  const { lifecycle } = createManualCustomerLifecycle(deps, method);
  if (!isRecord(request)) {
    throw badManualCustomerLifecycleRequest(method, 'args must be an object');
  }
  const badRequest = (message: string) =>
    badManualCustomerLifecycleRequest(method, message);
  const target = manualCustomerTarget(request, method);
  const reason = requiredStringField(request, 'reason', badRequest);
  if (!isSellerCustomerCloseReason(reason)) {
    throw badRequest('reason must be a valid seller customer close reason');
  }
  const source_status = optionalStringOrNullField(
    request,
    'source_status',
    badRequest,
  );

  try {
    return {
      customer: lifecycle.closeCustomer({
        ...target,
        reason,
        ...(source_status !== undefined ? { source_status } : {}),
      }),
      overview: buildSellerOverview(deps),
    };
  } catch (error) {
    return mapManualCustomerLifecycleError(method, error);
  }
};

export const reissueSellerManualCustomerToken = async (
  deps: SellerOverviewHandlerDeps,
  request: SellerManualCustomerReissueTokenRequest,
): Promise<SellerManualCustomerReissueTokenResponse> => {
  const method = SELLER_MANUAL_CUSTOMER_REISSUE_TOKEN_METHOD;
  const { lifecycle, toPublicClaim } = createManualCustomerLifecycle(deps, method);
  if (!deps.sellerClaimStore) throw sellerClaimNotConfigured(method);
  if (!isRecord(request)) {
    throw badManualCustomerLifecycleRequest(method, 'args must be an object');
  }
  const badRequest = (message: string) =>
    badManualCustomerLifecycleRequest(method, message);
  rejectPresentFields(
    request,
    [
      'source_status',
      'token_grants',
      'token_label',
      'token_expires_at',
      'token_concurrency_tier',
      'token_chat_mode',
    ],
    badRequest,
    'is not accepted by bearer-only reissue',
  );
  // D-196 — the "Message customer" path: re-mint AND email the fresh claim link
  // to the customer's stored email via the seller's sender. Delivery is best-
  // effort — a failure never rolls back the reissue or the returned claim.
  const send_claim_email = optionalRequestBooleanField(
    request,
    'send_claim_email',
    badRequest,
  );
  const target = manualCustomerTarget(request, method);

  try {
    const result = lifecycle.reissueCustomerToken({
      ...target,
    });
    if (result.issued_claim === null) {
      throw new Error('seller claim invariant violated after customer token reissue');
    }
    const claim = toPublicClaim(result.issued_claim);
    const claim_email_delivery = send_claim_email
      ? await deliverSellerCustomerClaimEmail({
          deps,
          customer_id: result.customer.customer_id,
          email: result.customer.email,
          issued_claim: result.issued_claim,
          public_claim: claim,
        })
      : null;
    return {
      customer:
        claim_email_delivery === null
          ? result.customer
          : readSellerCustomerAfterClaimDelivery(deps.sellerStore, result.customer),
      claim,
      claim_email_delivery,
      overview: buildSellerOverview(deps),
    };
  } catch (error) {
    return mapManualCustomerLifecycleError(method, error);
  }
};

export const bulkAdjustSellerManualTierCustomers = (
  deps: SellerOverviewHandlerDeps,
  request: SellerManualTierBulkAdjustRequest,
): SellerManualTierBulkAdjustResponse => {
  const method = SELLER_MANUAL_TIER_BULK_ADJUST_METHOD;
  const { lifecycle } = createManualCustomerLifecycle(deps, method);
  if (!isRecord(request)) {
    throw badManualCustomerLifecycleRequest(method, 'args must be an object');
  }
  const badRequest = (message: string) =>
    badManualCustomerLifecycleRequest(method, message);
  const tier_id = requiredStringField(request, 'tier_id', badRequest);
  const customer_ids = optionalStringArrayField(
    request,
    'customer_ids',
    badRequest,
  );

  try {
    return {
      ...lifecycle.bulkAdjustTierCustomers({
        lifecycle_source: 'manual',
        tier_id,
        ...(customer_ids !== undefined ? { customer_ids } : {}),
      }),
      overview: buildSellerOverview(deps),
    };
  } catch (error) {
    return mapManualCustomerLifecycleError(method, error);
  }
};

const stripeSyncExecutionSource = (client: WsClient) => ({
  channel: 'user' as const,
  actor: 'user_self' as const,
  user_id: client.user_id?.trim() || 'self',
  client_token_id:
    client.client_token_id?.trim()
    || client.token_instance_id?.trim()
    || client.instance_id?.trim()
    || 'paired-seller-ui',
});

export const synchronizeSellerStripeEntitlements = async (
  deps: SellerOverviewHandlerDeps,
  request: SellerStripeSynchronizeRequest,
  client: WsClient,
): Promise<SellerStripeSynchronizeResponse> => {
  const method = SELLER_STRIPE_SYNCHRONIZE_METHOD;
  if (!deps.contractStore || !deps.providerTierProvider) {
    throw new RpcError(
      'not_configured',
      `${method}: Stripe synchronization requires the contract store, installed Stripe catalog, and catalog gateway`,
      503,
      method,
    );
  }

  try {
    const result = await synchronizeStripeEntitlements(
      {
        sellerStore: deps.sellerStore,
        contractStore: deps.contractStore,
        provider: stripeEntitlementProviderFrom(deps.providerTierProvider),
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.newTierId ? { newTierId: deps.newTierId } : {}),
        ...(deps.newContractId ? { newContractId: deps.newContractId } : {}),
        mintedBy: deps.mintedBy ?? 'server:seller:stripe-sync',
      },
      request,
      stripeSyncExecutionSource(client),
    );
    return { ...result, overview: buildSellerOverview(deps) };
  } catch (error) {
    if (!(error instanceof SellerProviderTierSynchronizationError)) throw error;
    const status = error.kind === 'bad_request'
      ? 400
      : error.kind === 'policy'
        ? 403
        : error.kind === 'conflict'
          ? 409
          : error.kind === 'upstream'
            ? 502
            : 503;
    const code = error.kind === 'policy'
      ? 'forbidden'
      : error.kind === 'upstream'
        ? 'provider_error'
        : error.kind;
    throw new RpcError(code, `${method}: ${error.message}`, status, method);
  }
};

/** D-196 consolidation — the ONE owner-clicked tier seed for every provider.
 *  Same error mapping as the Stripe alias above; a different METHOD so an
 *  older server rejects it outright rather than minting Stripe tiers for a
 *  Paddle request. */
export const synchronizeSellerProviderTiers = async (
  deps: SellerOverviewHandlerDeps,
  request: SellerProviderTierSynchronizeRequest,
  client: WsClient,
): Promise<SellerProviderTierSynchronizeResponse> => {
  const method = SELLER_PROVIDER_TIERS_SYNCHRONIZE_METHOD;
  if (!deps.contractStore || !deps.providerTierProvider) {
    throw new RpcError(
      'not_configured',
      `${method}: tier synchronization requires the contract store, an installed seller catalog, and the catalog gateway`,
      503,
      method,
    );
  }
  try {
    const result = await synchronizeProviderTiers(
      {
        sellerStore: deps.sellerStore,
        contractStore: deps.contractStore,
        provider: deps.providerTierProvider,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.newTierId ? { newTierId: deps.newTierId } : {}),
        ...(deps.newContractId ? { newContractId: deps.newContractId } : {}),
        mintedBy: deps.mintedBy ?? 'server:seller:provider-tier-sync',
      },
      request,
      stripeSyncExecutionSource(client),
    );
    return { ...result, overview: buildSellerOverview(deps) };
  } catch (error) {
    if (!(error instanceof SellerProviderTierSynchronizationError)) throw error;
    const status = error.kind === 'bad_request'
      ? 400
      : error.kind === 'policy'
        ? 403
        : error.kind === 'conflict'
          ? 409
          : error.kind === 'upstream'
            ? 502
            : 503;
    const code = error.kind === 'policy'
      ? 'forbidden'
      : error.kind === 'upstream'
        ? 'provider_error'
        : error.kind;
    throw new RpcError(code, `${method}: ${error.message}`, status, method);
  }
};

export const makeSellerOverviewHandlers = (
  deps: SellerOverviewHandlerDeps | undefined,
): HandlerSlice<ServerRpcRegistry, SellerOverviewMethods, WsClient> | undefined => {
  if (!deps) return undefined;
  return {
    methods: [
      'server.seller.getOverview',
      'server.seller.listOrders',
      'server.seller.transitionOfferState',
      'server.seller.updateSettings',
      'server.seller.acknowledgeLlmGatewayPaid',
      'server.seller.upsertManualTier',
      'server.seller.setTierUsagePolicy',
      'server.seller.createPassTier',
      'server.seller.issueManualCustomer',
      'server.seller.extendManualCustomer',
      'server.seller.swapManualCustomerTier',
      'server.seller.closeManualCustomer',
      'server.seller.reissueManualCustomerToken',
      'server.seller.bulkAdjustManualTierCustomers',
      'server.seller.synchronizeStripeEntitlements',
      'server.seller.synchronizeProviderTiers',
    ],
    handlers: {
      'server.seller.getOverview': async () => buildSellerOverview(deps),
      'server.seller.listOrders': async (request) =>
        listSellerOrders(deps, request),
      'server.seller.transitionOfferState': async (request) =>
        transitionSellerOfferState(deps, request),
      'server.seller.updateSettings': async (request) =>
        updateSellerSettings(deps, request),
      'server.seller.acknowledgeLlmGatewayPaid': async (request) =>
        acknowledgeSellerLlmGatewayPaid(deps, request),
      'server.seller.upsertManualTier': async (request) =>
        upsertSellerManualTier(deps, request),
      'server.seller.setTierUsagePolicy': async (request) =>
        setSellerTierUsagePolicy(deps, request),
      'server.seller.createPassTier': async (request) =>
        createSellerPassTier(deps, request),
      'server.seller.issueManualCustomer': async (request) =>
        issueSellerManualCustomer(deps, request),
      'server.seller.extendManualCustomer': async (request) =>
        extendSellerManualCustomer(deps, request),
      'server.seller.swapManualCustomerTier': async (request) =>
        swapSellerManualCustomerTier(deps, request),
      'server.seller.closeManualCustomer': async (request) =>
        closeSellerManualCustomer(deps, request),
      'server.seller.reissueManualCustomerToken': async (request) =>
        reissueSellerManualCustomerToken(deps, request),
      'server.seller.bulkAdjustManualTierCustomers': async (request) =>
        bulkAdjustSellerManualTierCustomers(deps, request),
      'server.seller.synchronizeStripeEntitlements': async (request, client) =>
        synchronizeSellerStripeEntitlements(deps, request, client),
      'server.seller.synchronizeProviderTiers': async (request, client) =>
        synchronizeSellerProviderTiers(deps, request, client),
    },
  };
};
