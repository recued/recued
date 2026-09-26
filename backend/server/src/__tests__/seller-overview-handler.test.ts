/** D-196 S2 — Settings -> Seller overview handler. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  D165_CONTRACT_SCHEMA,
  LLM_GATEWAY_PAID_ACK_VERSION,
  type ContractDefinition,
} from '@recued/contracts';

import { makeContractHandlers } from '../contract-handler.js';
import { createLLMConfigManager } from '../llm-config.js';
import {
  acknowledgeSellerLlmGatewayPaid,
  buildSellerOverview,
  bulkAdjustSellerManualTierCustomers,
  reapplySellerManualTier,
  closeSellerManualCustomer,
  createSellerPassTier,
  extendSellerManualCustomer,
  issueSellerManualCustomer,
  makeSellerOverviewHandlers,
  reissueSellerManualCustomerToken,
  swapSellerManualCustomerTier,
  transitionSellerOfferState,
  updateSellerSettings,
  upsertSellerManualTier,
} from '../seller-overview-handler.js';
import type { SellerProviderTierProvider } from '../seller/provider-tier-sync.js';
import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
  type ChatInboundTokenStore,
} from '../storage/chat-inbound-token-store.js';
import {
  createContractGrantEntryStore,
  type ContractGrantEntryStore,
} from '../storage/contract-grant-entry-store.js';
import {
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';
import {
  createSellerStore,
  type SellerStore,
} from '../storage/seller-store.js';
import {
  createSellerClaimStore,
  type SellerClaimPayload,
  type SellerClaimStore,
} from '../storage/seller-claim-store.js';
import type { WsClient } from '../ws-server.js';

const NOW = 1_900_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

let db: Database.Database;
let sellerStore: SellerStore;
let contractStore: ContractStore;
let grantEntryStore: ContractGrantEntryStore;
let inboundTokenStore: ChatInboundTokenStore;
let contractIds: string[];
let customerIds: string[];
let sellerClaimStore: SellerClaimStore;

const readinessByKey = (
  overview: ReturnType<typeof buildSellerOverview>,
) => Object.fromEntries(overview.readiness.map((item) => [item.key, item]));

const nextId = (ids: string[], label: string): string => {
  const id = ids.shift();
  if (!id) throw new Error(`test exhausted ${label} ids`);
  return id;
};

const putTemplate = (
  contract_id = 'ct_template_basic',
  overrides: Partial<ContractDefinition> = {},
): ContractDefinition => {
  const def: ContractDefinition = {
    contract_id,
    minted_at: NOW - 10_000,
    minted_by: 'owner:test',
    display_name: `Template ${contract_id}`,
    scope: { operation_ids: [`${contract_id}.op`] },
    door_types: ['mcp'],
    grant_kind: 'customer_template',
    ...overrides,
  };
  contractStore.put(CONTRACT_DEFINITION_SCOPE, [def.contract_id], def);
  return def;
};

const issueDeps = () => ({
  sellerStore,
  contractStore,
  inboundTokenStore,
  sellerClaimStore,
  getPublicBaseUrl: () => 'https://seller.example',
  mintedBy: 'seller:test',
  now: () => NOW,
  newContractId: () => nextId(contractIds, 'contract'),
  newCustomerId: () => nextId(customerIds, 'customer'),
});

const consumeClaim = (
  claim: { readonly claim_url: string },
): SellerClaimPayload => {
  const secret = new URL(claim.claim_url).searchParams.get('t');
  expect(secret).not.toBeNull();
  const consumed = sellerClaimStore.consume(secret!, NOW);
  expect(consumed.status).toBe('claimed');
  if (consumed.status !== 'claimed') {
    throw new Error(`expected claimed seller payload, received ${consumed.status}`);
  }
  return consumed.payload;
};

const mintTemplateThroughContractAuthoring = async (input: {
  readonly contract_id: string;
  readonly display_name: string;
  readonly scope: ContractDefinition['scope'];
  readonly door_types?: ContractDefinition['door_types'];
  readonly approved_actions_template?: unknown;
}): Promise<void> => {
  contractStore.seedSchema(D165_CONTRACT_SCHEMA);
  const slice = makeContractHandlers({
    store: contractStore,
    getManifest: () => null,
    listManifests: () => [],
    now: () => NOW - 10_000,
    newContractId: () => input.contract_id,
  });
  if (!slice) throw new Error('contract handlers unavailable');
  await slice.handlers['collection.contract.mintContract'](
    {
      display_name: input.display_name,
      grant_kind: 'customer_template',
      scope: input.scope,
      ...(input.door_types !== undefined ? { door_types: input.door_types } : {}),
      ...(input.approved_actions_template !== undefined
        ? { approved_actions_template: input.approved_actions_template }
        : {}),
    },
    { display_name: 'Owner test device' } as WsClient,
  );
};

beforeEach(() => {
  db = new Database(':memory:');
  contractIds = ['ct_customer_1', 'ct_customer_2', 'ct_customer_3'];
  customerIds = ['seller_customer_1', 'seller_customer_2', 'seller_customer_3'];
  contractStore = createContractStore(db, { now: () => NOW });
  grantEntryStore = createContractGrantEntryStore(contractStore);
  ensureChatInboundTokenSchema(db);
  inboundTokenStore = createChatInboundTokenStore(db);
  sellerStore = createSellerStore(db);
  sellerClaimStore = createSellerClaimStore(db);
});

describe('buildSellerOverview', () => {
  it('returns a dormant overview with manual ready and provider-dependent rows needing setup', () => {
    const overview = buildSellerOverview({ sellerStore });
    const readiness = readinessByKey(overview);

    expect(overview.settings.default_grace_hours).toBe(72);
    expect(overview.tiers).toEqual([]);
    expect(overview.customers).toEqual([]);
    expect(overview.usage_rollups).toEqual([]);
    expect(overview.offers).toEqual([]);
    expect(overview.counts).toEqual({
      tiers: 0,
      active_tiers: 0,
      customers: 0,
      active_customers: 0,
      grace_customers: 0,
      closed_customers: 0,
    });
    expect(readiness.manual_lifecycle).toMatchObject({ state: 'ready' });
    expect(readiness.stripe_provider).toMatchObject({ state: 'not_wired' });
    expect(readiness.mail_sender).toMatchObject({ state: 'needs_setup' });
    expect(readiness.llm_gateway).toMatchObject({
      state: 'needs_setup',
      href: '#settings/ai-models',
    });
    expect(overview.llm_gateway).toEqual({
      configured: false,
      config_readable: false,
      default_route: null,
      model_alias: null,
      paid_ack_at: null,
      paid_acknowledged: false,
    });
  });

  it('projects core Seller offers without creating access rows or requiring pack identity', () => {
    sellerStore.ensureOffer({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      description: 'One reviewed and delivered PDF document',
      pricing_kind: 'fixed',
      amount_minor: 12_500,
      currency: 'USD',
      fulfillment_recipe_id: 'paid-document-origin',
      created_by_recipe_id: 'paid-document-setup',
      now: NOW,
    });
    const overview = buildSellerOverview({ sellerStore });

    expect(overview.offers).toEqual([expect.objectContaining({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      state: 'draft',
      fulfillment_recipe_id: 'paid-document-origin',
    })]);
    expect(overview.offers?.[0]).not.toHaveProperty('pack_slug');
    expect(overview.offers?.[0]).not.toHaveProperty('publisher');
    expect(overview.offers?.[0]).not.toHaveProperty('version');
    expect(overview.tiers).toEqual([]);
    expect(overview.customers).toEqual([]);
    expect(overview.usage_rollups).toEqual([]);
    expect(overview.counts.tiers).toBe(0);
    expect(overview.counts.customers).toBe(0);
  });

  it('applies only owner-state transitions with optimistic conflict and terminal archive', () => {
    sellerStore.ensureOffer({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      pricing_kind: 'fixed',
      amount_minor: 12_500,
      currency: 'USD',
      now: NOW,
    });

    const activated = transitionSellerOfferState(
      { sellerStore, now: () => NOW + 1 },
      {
        offer_id: 'paid-document.outcome',
        expected_state: 'draft',
        expected_updated_at: NOW,
        next_state: 'active',
      },
    );
    const replay = transitionSellerOfferState(
      { sellerStore, now: () => NOW + 2 },
      {
        offer_id: 'paid-document.outcome',
        expected_state: 'draft',
        expected_updated_at: NOW,
        next_state: 'active',
      },
    );

    expect(activated).toMatchObject({
      result: 'updated',
      offer: { state: 'active', updated_at: NOW + 1 },
      overview: { offers: [expect.objectContaining({ state: 'active' })] },
    });
    expect(replay.result).toBe('unchanged');
    expect(replay.offer.updated_at).toBe(NOW + 1);
    expect(() => transitionSellerOfferState(
      { sellerStore, now: () => NOW + 3 },
      {
        offer_id: 'paid-document.outcome',
        expected_state: 'draft',
        expected_updated_at: NOW,
        next_state: 'archived',
      },
    )).toThrow(/server\.seller\.transitionOfferState.*expected state 'draft'/);
    expect(() => transitionSellerOfferState(
      { sellerStore, now: () => NOW + 4 },
      {
        offer_id: 'paid-document.outcome',
        expected_state: 'active',
        expected_updated_at: NOW + 1,
        next_state: 'draft',
      },
    )).toThrow(/server\.seller\.transitionOfferState.*not allowed/);
    expect(() => transitionSellerOfferState(
      { sellerStore },
      {
        offer_id: 'missing',
        expected_state: 'draft',
        expected_updated_at: NOW,
        next_state: 'active',
      },
    )).toThrow(/server\.seller\.transitionOfferState.*does not exist/);
    expect(() => transitionSellerOfferState(
      { sellerStore },
      {
        offer_id: 'paid-document.outcome',
        expected_state: 'active',
        next_state: 'paused',
      } as never,
    )).toThrow(/expected_updated_at must be a non-negative safe integer/);
    expect(() => transitionSellerOfferState(
      { sellerStore },
      {
        offer_id: 'paid-document.outcome',
        expected_state: 'active',
        expected_updated_at: NOW + 1,
        next_state: 'paused',
        state: 'archived',
      } as never,
    )).toThrow(/unknown field 'state'/);
  });

  it('projects settings, tiers, customers, rollups, and llm_gateway readiness', () => {
    sellerStore.upsertSettings({
      default_grace_hours: 48,
      sender_mail_instance_id: 'mail_primary',
      status_policy_json: { past_due: 'grace' },
      email_policy_json: { claim: true },
      now: NOW,
    });
    sellerStore.upsertTier({
      tier_id: 'tier_basic',
      door_id: 'door_llm',
      lifecycle_source: 'manual',
      entitlement_key: 'basic',
      display_name: 'Basic',
      template_contract_id: 'ct_template_basic',
      usage_policy_json: {
        chat_turn: { period_granularity: 'month', period_limit: 100 },
      },
      customer_status_enabled_default: true,
      active: true,
      now: NOW,
    });
    sellerStore.upsertCustomer({
      customer_id: 'cust_1',
      lifecycle_source: 'manual',
      source_customer_id: 'manual-1',
      door_id: 'door_llm',
      email: 'Buyer@Example.COM',
      tier_id: 'tier_basic',
      contract_id: 'ct_customer_1',
      inbound_token_id: 'tok_1',
      access_state: 'active',
      now: NOW,
    });
    sellerStore.recordUsage({
      contract_id: 'ct_customer_1',
      usage_kind: 'chat_turn',
      period_granularity: 'month',
      period_start: NOW,
      units: 7,
      now: NOW,
    });
    const llmManager = createLLMConfigManager(db);
    llmManager.setLlmGatewayDefaultRoute('slot:slot_1');
    llmManager.setLlmGatewayModelAlias('seller-primary');

    const overview = buildSellerOverview({
      sellerStore,
      llmManager,
      isLiveSendCapableMailInstance: (id) => id === 'mail_primary',
    });
    const readiness = readinessByKey(overview);

    expect(overview.settings.sender_mail_instance_id).toBe('mail_primary');
    expect(overview.tiers.map((tier) => tier.tier_id)).toEqual(['tier_basic']);
    expect(overview.customers.map((customer) => customer.email)).toEqual([
      'buyer@example.com',
    ]);
    expect(overview.usage_rollups).toEqual([
      expect.objectContaining({
        contract_id: 'ct_customer_1',
        usage_kind: 'chat_turn',
        units: 7,
      }),
    ]);
    expect(overview.counts).toEqual({
      tiers: 1,
      active_tiers: 1,
      customers: 1,
      active_customers: 1,
      grace_customers: 0,
      closed_customers: 0,
    });
    expect(readiness.mail_sender).toMatchObject({ state: 'ready' });
    expect(readiness.llm_gateway).toMatchObject({ state: 'ready' });
    expect(overview.llm_gateway).toEqual({
      configured: true,
      config_readable: true,
      default_route: 'slot:slot_1',
      model_alias: 'seller-primary',
      paid_ack_at: null,
      paid_acknowledged: false,
    });
  });

  it('deduplicates usage rollups by contract id before projecting the overview', () => {
    sellerStore.upsertTier({
      tier_id: 'tier_basic',
      door_id: 'door_llm',
      lifecycle_source: 'manual',
      entitlement_key: 'basic',
      display_name: 'Basic',
      template_contract_id: 'ct_template_basic',
      now: NOW,
    });
    for (const [customer_id, source_customer_id] of [
      ['cust_1', 'manual-1'],
      ['cust_2', 'manual-2'],
    ] as const) {
      sellerStore.upsertCustomer({
        customer_id,
        lifecycle_source: 'manual',
        source_customer_id,
        door_id: 'door_llm',
        tier_id: 'tier_basic',
        contract_id: 'ct_customer_shared',
        access_state: 'active',
        now: NOW,
      });
    }
    sellerStore.recordUsage({
      contract_id: 'ct_customer_shared',
      usage_kind: 'chat_turn',
      period_granularity: 'month',
      period_start: NOW,
      units: 3,
      now: NOW,
    });

    const overview = buildSellerOverview({ sellerStore });

    expect(overview.customers).toHaveLength(2);
    expect(overview.usage_rollups).toEqual([
      expect.objectContaining({
        contract_id: 'ct_customer_shared',
        usage_kind: 'chat_turn',
        units: 3,
      }),
    ]);
  });

  it('fails the llm_gateway row closed when live LLM config is unreadable', () => {
    const overview = buildSellerOverview({
      sellerStore,
      llmManager: {
        getConfig: () => {
          throw new Error('locked');
        },
      },
    });

    expect(readinessByKey(overview).llm_gateway).toMatchObject({
      state: 'needs_setup',
    });
    expect(overview.llm_gateway).toEqual({
      configured: false,
      config_readable: false,
      default_route: null,
      model_alias: null,
      // The paid-ack fact is a seller-settings read, independent of the
      // unreadable LLM config — it still resolves (unacknowledged fresh store).
      paid_ack_at: null,
      paid_acknowledged: false,
    });
  });
});

describe('makeSellerOverviewHandlers', () => {
  it('registers seller owner methods only when the seller store is wired', async () => {
    expect(makeSellerOverviewHandlers(undefined)).toBeUndefined();

    const slice = makeSellerOverviewHandlers({ sellerStore });
    expect(slice?.methods).toEqual([
      'server.seller.getOverview',
      'server.seller.listOrders',
      'server.seller.transitionOfferState',
      'server.seller.updateSettings',
      'server.seller.acknowledgeLlmGatewayPaid',
      'server.seller.upsertManualTier',
      // D-250 § D — the only path that can set a usage policy on a
      // Stripe-minted tier; `upsertManualTier` stamps `manual` and the store
      // refuses to move a stored tier between lifecycle sources.
      'server.seller.setTierUsagePolicy',
      'server.seller.createPassTier',
      'server.seller.issueManualCustomer',
      'server.seller.extendManualCustomer',
      'server.seller.swapManualCustomerTier',
      'server.seller.closeManualCustomer',
      'server.seller.reissueManualCustomerToken',
      'server.seller.bulkAdjustManualTierCustomers',
      'server.seller.reapplyManualTier',
      'server.seller.synchronizeStripeEntitlements',
      'server.seller.synchronizeProviderTiers',
    ]);

    const overview = await slice!.handlers['server.seller.getOverview'](
      undefined as never,
      undefined as never,
    );
    expect(overview.counts.customers).toBe(0);

    sellerStore.ensureOffer({
      offer_id: 'paid-document.outcome',
      kind: 'document',
      display_name: 'Paid document',
      pricing_kind: 'unspecified',
      now: NOW,
    });
    const transitioned = await slice!.handlers[
      'server.seller.transitionOfferState'
    ](
      {
        offer_id: 'paid-document.outcome',
        expected_state: 'draft',
        expected_updated_at: NOW,
        next_state: 'active',
      },
      undefined as never,
    );
    expect(transitioned).toMatchObject({
      result: 'updated',
      offer: { state: 'active' },
    });

    const upserted = await slice!.handlers['server.seller.upsertManualTier'](
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
      undefined as never,
    );
    expect(upserted.tier.lifecycle_source).toBe('manual');

    await expect(
      slice!.handlers['server.seller.issueManualCustomer'](
        {
          door_id: 'door_llm',
          source_customer_id: 'manual-1',
          entitlement_key: 'basic',
        },
        undefined as never,
      ),
    ).rejects.toMatchObject({
      code: 'not_configured',
      status: 501,
    });
  });

  it('routes Stripe synchronization through the owner-attributed provider seam', async () => {
    // The shipped Stripe-only rpc adapts over the ONE tier-seed seam.
    const providerTierProvider: SellerProviderTierProvider = {
      listConnections: (provider) => provider === 'stripe'
        ? [{ name: 'stripe-main', display_name: 'Stripe Main' }]
        : [],
      listRecords: vi.fn(async () => ({
        ok: true as const,
        records: [{
          id: 'feat_basic',
          lookup_key: 'basic',
          name: 'Basic',
          active: true,
          livemode: false,
        }],
      })),
    };
    const slice = makeSellerOverviewHandlers({
      sellerStore,
      contractStore,
      providerTierProvider,
      now: () => NOW,
      newContractId: () => 'ct_stripe_basic',
      newTierId: () => 'tier_stripe_basic',
    });

    const response = await slice!.handlers[
      'server.seller.synchronizeStripeEntitlements'
    ](
      { door_id: 'door-mcp', door_type: 'mcp' },
      {
        user_id: 'owner-user',
        client_token_id: 'owner-client-token',
      } as WsClient,
    );

    expect(providerTierProvider.listRecords).toHaveBeenCalledWith({
      provider: 'stripe',
      connection_name: 'stripe-main',
      execution_source: {
        channel: 'user',
        actor: 'user_self',
        user_id: 'owner-user',
        client_token_id: 'owner-client-token',
      },
    });
    expect(response).toMatchObject({
      connection_name: 'stripe-main',
      features_seen: 1,
      created_tier_ids: ['tier_stripe_basic'],
      overview: {
        counts: { tiers: 1, active_tiers: 1 },
      },
    });
    expect(readinessByKey(response.overview).stripe_provider)
      .toMatchObject({ state: 'ready' });
    expect(grantEntryStore.listForContract('ct_stripe_basic')).toEqual([]);
  });
});

describe('updateSellerSettings', () => {
  it('updates seller settings and returns a refreshed readiness overview', () => {
    const response = updateSellerSettings(
      {
        sellerStore,
        now: () => NOW,
        isLiveSendCapableMailInstance: (id) => id === 'mail_primary',
      },
      {
        default_grace_hours: 24,
        sender_mail_instance_id: ' mail_primary ',
        status_policy_json: { past_due: 'grace', cancelled: 'close_now' },
        email_policy_json: { claim: { enabled: true } },
      },
    );

    expect(response.settings).toEqual({
      default_grace_hours: 24,
      sender_mail_instance_id: 'mail_primary',
      status_policy_json: { past_due: 'grace', cancelled: 'close_now' },
      email_policy_json: { claim: { enabled: true } },
      llm_gateway_paid_ack_at: null,
      llm_gateway_paid_ack_version: null,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(response.overview.settings).toEqual(response.settings);
    expect(readinessByKey(response.overview).mail_sender).toMatchObject({
      state: 'ready',
    });

    const cleared = updateSellerSettings(
      { sellerStore, now: () => NOW + 1 },
      { sender_mail_instance_id: null },
    );
    expect(cleared.settings.sender_mail_instance_id).toBeNull();
    expect(cleared.settings.default_grace_hours).toBe(24);
    expect(readinessByKey(cleared.overview).mail_sender).toMatchObject({
      state: 'needs_setup',
    });
  });

  it('rejects malformed seller settings as method-specific bad_request', () => {
    expect(() =>
      updateSellerSettings(
        { sellerStore, now: () => NOW },
        {
          default_grace_hours: '72',
        } as never,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'bad_request',
        status: 400,
        method: 'server.seller.updateSettings',
      }),
    );
  });

  it('rejects a missing/read-only sender and marks a stale stored id not ready', () => {
    expect(() =>
      updateSellerSettings(
        {
          sellerStore,
          now: () => NOW,
          isLiveSendCapableMailInstance: () => false,
        },
        { sender_mail_instance_id: 'mail_read_only' },
      ),
    ).toThrow(/live send-capable mail instance/);

    sellerStore.upsertSettings({ sender_mail_instance_id: 'mail_stale', now: NOW });
    const overview = buildSellerOverview({
      sellerStore,
      isLiveSendCapableMailInstance: () => false,
    });
    expect(readinessByKey(overview).mail_sender).toMatchObject({
      state: 'needs_setup',
    });
  });
});

describe('acknowledgeSellerLlmGatewayPaid (D-196 §4.9 / I-7)', () => {
  it('records the acknowledgment and reflects it in the refreshed overview', () => {
    const before = buildSellerOverview({ sellerStore });
    expect(before.llm_gateway.paid_acknowledged).toBe(false);
    expect(before.llm_gateway.paid_ack_at).toBeNull();

    const response = acknowledgeSellerLlmGatewayPaid(
      { sellerStore, now: () => NOW },
      {},
    );

    expect(response.settings.llm_gateway_paid_ack_at).toBe(NOW);
    expect(response.settings.llm_gateway_paid_ack_version).toBe(LLM_GATEWAY_PAID_ACK_VERSION);
    expect(response.overview.llm_gateway.paid_acknowledged).toBe(true);
    expect(response.overview.llm_gateway.paid_ack_at).toBe(NOW);
  });

  it('accepts a matching client-supplied terms version', () => {
    const response = acknowledgeSellerLlmGatewayPaid(
      { sellerStore, now: () => NOW },
      { ack_version: LLM_GATEWAY_PAID_ACK_VERSION },
    );
    expect(response.settings.llm_gateway_paid_ack_version).toBe(LLM_GATEWAY_PAID_ACK_VERSION);
  });

  it('rejects a stale client-supplied terms version without recording anything', () => {
    expect(() =>
      acknowledgeSellerLlmGatewayPaid(
        { sellerStore, now: () => NOW },
        { ack_version: 'route-rights-v0-superseded' },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'bad_request',
        status: 400,
        method: 'server.seller.acknowledgeLlmGatewayPaid',
      }),
    );
    // Nothing was stamped — a stale page cannot silently acknowledge new terms.
    expect(sellerStore.getSettings().llm_gateway_paid_ack_at).toBeNull();
  });

  it('rejects an unknown field as method-specific bad_request', () => {
    expect(() =>
      acknowledgeSellerLlmGatewayPaid(
        { sellerStore, now: () => NOW },
        { confirmed: true } as never,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'bad_request',
        method: 'server.seller.acknowledgeLlmGatewayPaid',
      }),
    );
  });
});

describe('upsertSellerManualTier', () => {
  it('creates a manual tier, ignores spoofed provider lifecycle, and returns a refreshed overview', () => {
    const response = upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        lifecycle_source: 'stripe',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
        usage_policy_json: {
          chat_turn: { period_granularity: 'month', period_limit: 100 },
        },
        pass_duration_seconds: 2_592_000,
        customer_status_enabled_default: true,
        active: true,
      } as never,
    );

    expect(response.tier).toMatchObject({
      tier_id: 'tier_basic',
      door_id: 'door_llm',
      lifecycle_source: 'manual',
      entitlement_key: 'basic',
      display_name: 'Basic',
      template_contract_id: 'ct_template_basic',
      usage_policy_json: {
        chat_turn: { period_granularity: 'month', period_limit: 100 },
      },
      pass_duration_seconds: 2_592_000,
      customer_status_enabled_default: true,
      active: true,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(response.overview.tiers.map((tier) => tier.tier_id)).toEqual([
      'tier_basic',
    ]);
    expect(sellerStore.findTier({
      door_id: 'door_llm',
      lifecycle_source: 'manual',
      entitlement_key: 'basic',
    })?.tier_id).toBe('tier_basic');
  });

  it('rejects malformed manual tier requests as bad_request', () => {
    expect(() =>
      upsertSellerManualTier(
        { sellerStore, now: () => NOW },
        {
          tier_id: 'tier_basic',
          door_id: 'door_llm',
          entitlement_key: 'basic',
          display_name: 'Basic',
          template_contract_id: 'ct_template_basic',
          usage_policy_json: [],
        } as never,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'bad_request',
        status: 400,
      }),
    );
  });

  it('patches a manual tier without erasing omitted policy or reactivating it', () => {
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
        usage_policy_json: { chat_turn: { period_limit: 100 } },
        pass_duration_seconds: 3600,
        customer_status_enabled_default: true,
        active: false,
      },
    );

    const patched = upsertSellerManualTier(
      { sellerStore, now: () => NOW + 1 },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
      },
    );

    expect(patched.tier).toMatchObject({
      display_name: 'Basic',
      template_contract_id: 'ct_template_basic',
      usage_policy_json: { chat_turn: { period_limit: 100 } },
      pass_duration_seconds: 3600,
      customer_status_enabled_default: true,
      active: false,
      created_at: NOW,
      updated_at: NOW + 1,
    });
  });

  it('maps source-qualified tier collisions to conflict', () => {
    sellerStore.upsertTier({
      tier_id: 'tier_basic',
      door_id: 'door_llm',
      lifecycle_source: 'manual',
      entitlement_key: 'basic',
      display_name: 'Basic',
      template_contract_id: 'ct_template_basic',
      now: NOW,
    });
    sellerStore.upsertTier({
      tier_id: 'tier_pro',
      door_id: 'door_tools',
      lifecycle_source: 'manual',
      entitlement_key: 'pro',
      display_name: 'Pro',
      template_contract_id: 'ct_template_pro',
      now: NOW,
    });

    expect(() =>
      upsertSellerManualTier(
        { sellerStore, now: () => NOW + 1 },
        {
          tier_id: 'tier_pro',
          door_id: 'door_llm',
          entitlement_key: 'basic',
          display_name: 'Renamed',
          template_contract_id: 'ct_template_basic_2',
        },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'conflict',
        status: 409,
      }),
    );
  });
});

describe('createSellerPassTier (D-196 1d Phase 2)', () => {
  const passDeps = (overrides: Record<string, unknown> = {}) => ({
    sellerStore,
    contractStore,
    now: () => NOW,
    mintedBy: 'seller:test',
    newContractId: () => 'ct_pass_template',
    newTierId: () => 'tier_pass_basic',
    ...overrides,
  });

  it('mints a zero-grant customer template for the door and binds a manual pass tier to it', () => {
    const response = createSellerPassTier(passDeps(), {
      door_id: 'door_llm',
      door_type: 'llm_gateway',
      entitlement_key: 'day-pass',
      display_name: 'Day pass',
      pass_duration_seconds: 86_400,
      usage_policy_json: {
        chat_turn: { period_granularity: 'day', period_limit: 50 },
        tool_call: { period_granularity: 'day', period_limit: 200 },
      },
    });

    // The tier is `manual`, carries the three pass axes, and points at the
    // freshly-minted shell — the store defaults active/status-off.
    expect(response.tier).toMatchObject({
      tier_id: 'tier_pass_basic',
      door_id: 'door_llm',
      lifecycle_source: 'manual',
      entitlement_key: 'day-pass',
      display_name: 'Day pass',
      template_contract_id: 'ct_pass_template',
      pass_duration_seconds: 86_400,
      usage_policy_json: {
        chat_turn: { period_granularity: 'day', period_limit: 50 },
        tool_call: { period_granularity: 'day', period_limit: 200 },
      },
      active: true,
      customer_status_enabled_default: false,
      created_at: NOW,
      updated_at: NOW,
    });
    expect(response.template_contract_id).toBe('ct_pass_template');

    // The minted template is a ZERO-GRANT customer_template restricted to the
    // door type — the owner authors the grants afterward (I-1).
    expect(
      contractStore.get(CONTRACT_DEFINITION_SCOPE, ['ct_pass_template'])?.value,
    ).toEqual(
      expect.objectContaining({
        contract_id: 'ct_pass_template',
        grant_kind: 'customer_template',
        scope: { operation_ids: [] },
        door_types: ['llm_gateway'],
        minted_by: 'seller:test',
      }),
    );
    expect(grantEntryStore.listForContract('ct_pass_template')).toEqual([]);

    // The tier is source-resolvable and shows in the refreshed overview.
    expect(sellerStore.findTier({
      door_id: 'door_llm',
      lifecycle_source: 'manual',
      entitlement_key: 'day-pass',
    })?.tier_id).toBe('tier_pass_basic');
    expect(response.overview.tiers.map((tier) => tier.tier_id)).toEqual([
      'tier_pass_basic',
    ]);
  });

  it('creates a bare pass tier with no time bound or usage caps when both are omitted', () => {
    const response = createSellerPassTier(passDeps(), {
      door_id: 'door_tools',
      door_type: 'mcp',
      entitlement_key: 'trial',
      display_name: 'Trial',
    });
    expect(response.tier).toMatchObject({
      lifecycle_source: 'manual',
      pass_duration_seconds: null,
      usage_policy_json: {},
    });
  });

  it.each(['lifecycle_source', 'template_contract_id', 'tier_id'] as const)(
    'refuses a server-derived %s to hold the anti-spoof posture (bad_request)',
    (field) => {
      expect(() =>
        createSellerPassTier(passDeps(), {
          door_id: 'door_llm',
          door_type: 'llm_gateway',
          entitlement_key: 'day-pass',
          display_name: 'Day pass',
          [field]: field === 'lifecycle_source' ? 'stripe' : 'ct_spoofed',
        } as never),
      ).toThrowError(
        expect.objectContaining({ code: 'bad_request', status: 400 }),
      );
      // Nothing was minted — the refusal precedes any store write.
      expect(contractStore.get(CONTRACT_DEFINITION_SCOPE, ['ct_pass_template']))
        .toBeNull();
    },
  );

  it('rejects a non-authorable (derived) door_type as bad_request', () => {
    // `reception` is a real DoorType but NOT owner-authorable — a pass on it is
    // nonsensical, so the gate is stricter than the sync's broad `isDoorType`.
    expect(() =>
      createSellerPassTier(passDeps(), {
        door_id: 'door_llm',
        door_type: 'reception' as never,
        entitlement_key: 'day-pass',
        display_name: 'Day pass',
      }),
    ).toThrowError(expect.objectContaining({ code: 'bad_request', status: 400 }));
    expect(contractStore.get(CONTRACT_DEFINITION_SCOPE, ['ct_pass_template']))
      .toBeNull();
  });

  it('is not_configured without a contract store to mint the template', () => {
    expect(() =>
      createSellerPassTier(
        { sellerStore, now: () => NOW } as never,
        {
          door_id: 'door_llm',
          door_type: 'llm_gateway',
          entitlement_key: 'day-pass',
          display_name: 'Day pass',
        },
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'not_configured', status: 503 }),
    );
  });

  it('refuses to re-point an existing (door, entitlement) tier and mints no orphan template', () => {
    // A manual tier already exists for this (door, entitlement) with an
    // owner-authored template — re-creating must not silently replace it.
    sellerStore.upsertTier({
      tier_id: 'tier_existing',
      door_id: 'door_llm',
      lifecycle_source: 'manual',
      entitlement_key: 'day-pass',
      display_name: 'Existing',
      template_contract_id: 'ct_owner_authored',
      now: NOW,
    });

    expect(() =>
      createSellerPassTier(
        passDeps({ newContractId: () => 'ct_pass_template_2' }),
        {
          door_id: 'door_llm',
          door_type: 'llm_gateway',
          entitlement_key: 'day-pass',
          display_name: 'Day pass',
        },
      ),
    ).toThrowError(expect.objectContaining({ code: 'conflict', status: 409 }));

    // The existing tier still points at its authored template (unchanged), and
    // no shell was orphaned by the refused create (atomic).
    expect(sellerStore.findTier({
      door_id: 'door_llm',
      lifecycle_source: 'manual',
      entitlement_key: 'day-pass',
    })?.template_contract_id).toBe('ct_owner_authored');
    expect(contractStore.get(CONTRACT_DEFINITION_SCOPE, ['ct_pass_template_2']))
      .toBeNull();
  });
});

describe('issueSellerManualCustomer', () => {
  it('issues from a normally authored template, copies its grants, and returns a refreshed overview', async () => {
    await mintTemplateThroughContractAuthoring({
      contract_id: 'ct_template_basic',
      display_name: 'Basic template',
      scope: { operation_ids: ['core.mail.send'], channels: ['mcp'] },
      door_types: ['mcp'],
      approved_actions_template: { actions: [{ operation_id: 'core.mail.send' }] },
    });
    grantEntryStore.set('ct_template_basic', 'core.mail.send', true, NOW - 1);
    grantEntryStore.set('ct_template_basic', 'data.contacts', false, NOW - 1);
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );

    const response = await issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
        email: ' Buyer@Example.COM ',
        current_period_end: NOW + DAY_MS,
        source_status: 'paid',
      },
    );

    expect(response.result).toBe('created');
    expect(response.claim).toEqual({
      claim_url: expect.stringMatching(
        /^https:\/\/seller\.example\/reception\/claim\?t=recued_claim_/u,
      ),
      expires_at: NOW + 60 * 60 * 1000,
    });
    expect(response.claim_email_delivery).toBeNull();
    expect(JSON.stringify(response)).not.toContain('bearer_plaintext');
    expect(response.customer).toEqual(expect.objectContaining({
      customer_id: 'seller_customer_1',
      lifecycle_source: 'manual',
      source_customer_id: 'manual-1',
      door_id: 'door_llm',
      email: 'buyer@example.com',
      tier_id: 'tier_basic',
      contract_id: 'ct_customer_1',
      inbound_token_id: response.customer.inbound_token_id,
      mcp_token_id: response.customer.inbound_token_id,
      external_subscription_id: null,
      source_status: 'paid',
      current_period_end: NOW + DAY_MS,
      access_state: 'active',
    }));
    expect(response.overview.counts).toMatchObject({
      customers: 1,
      active_customers: 1,
    });

    const stamped = contractStore.get(CONTRACT_DEFINITION_SCOPE, ['ct_customer_1']);
    expect(stamped?.value).toEqual(expect.objectContaining({
      contract_id: 'ct_customer_1',
      minted_at: NOW,
      minted_by: 'seller:test',
      display_name: 'Basic customer manual-1',
      grant_kind: 'customer_instance',
      scope: { operation_ids: ['core.mail.send'], channels: ['mcp'] },
    }));
    expect(grantEntryStore.listForContract('ct_customer_1')).toEqual([
      { entry_key: 'core.mail.send', granted: true, set_at: NOW },
      { entry_key: 'data.contacts', granted: false, set_at: NOW },
    ]);
    const token = inboundTokenStore.getTokenById(response.customer.inbound_token_id!);
    expect(token).toEqual(expect.objectContaining({
      label: 'Basic customer token',
      peer_handle: 'seller:manual:door_llm:manual-1',
      contract_id: 'ct_customer_1',
      grants: {
        'core.mail.send': true,
        'data.contacts': false,
      },
    }));
    expect(consumeClaim(response.claim!)).toEqual({
      bearer_plaintext: expect.stringMatching(/^recued_/u),
      mcp_url: 'https://seller.example/mcp',
      llm_gateway_base_url: null,
      llm_gateway_model_alias: null,
    });
  });

  it('sends a created claim through the selected audited mail seam and durably marks it once', async () => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    sellerStore.upsertSettings({
      sender_mail_instance_id: 'mail_primary',
      now: NOW,
    });
    const isLiveSendCapableMailInstance = vi.fn(() => true);
    const sendClaimMail = vi.fn(async (_input: {
      readonly instance_id: string;
      readonly to: string;
      readonly subject: string;
      readonly body_text: string;
    }) => {
      expect(db.inTransaction).toBe(false);
      expect(sellerStore.findCustomerBySource({
        lifecycle_source: 'manual',
        source_customer_id: 'manual-1',
        door_id: 'door_llm',
      })).toEqual(expect.objectContaining({
        claim_email_marker: expect.stringMatching(/^claim:/u),
        claim_email_sent_at: null,
      }));
      extendSellerManualCustomer(issueDeps(), {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        current_period_end: NOW + DAY_MS,
        source_status: 'renewed-during-send',
      });
      return {
        message_id: 'message-claim-1',
        sent_at: NOW + 50,
      };
    });
    const deps = {
      ...issueDeps(),
      isLiveSendCapableMailInstance,
      sendClaimMail,
    };
    const request = {
      door_id: 'door_llm',
      source_customer_id: 'manual-1',
      entitlement_key: 'basic',
      email: 'buyer@example.com',
      send_claim_email: true,
    } as const;

    const response = await issueSellerManualCustomer(deps, request);

    expect(response.result).toBe('created');
    expect(response.claim_email_delivery).toEqual({
      status: 'sent',
      message_id: 'message-claim-1',
      sent_at: NOW + 50,
    });
    expect(response.customer).toEqual(expect.objectContaining({
      claim_email_marker: expect.stringMatching(/^claim:/u),
      claim_email_sent_at: NOW + 50,
      current_period_end: NOW + DAY_MS,
      source_status: 'renewed-during-send',
    }));
    expect(isLiveSendCapableMailInstance).toHaveBeenCalledWith('mail_primary');
    expect(sendClaimMail).toHaveBeenCalledTimes(1);
    const mail = sendClaimMail.mock.calls[0]![0];
    expect(mail).toMatchObject({
      instance_id: 'mail_primary',
      to: 'buyer@example.com',
      subject: 'Your Recued access is ready',
    });
    expect(mail.body_text).toContain(response.claim!.claim_url);
    expect(mail.body_text).toContain('can be used once');
    const claimed = consumeClaim(response.claim!);
    expect(mail.body_text).not.toContain(claimed.bearer_plaintext);
    expect(JSON.stringify(mail)).not.toContain('bearer_plaintext');

    const replay = await issueSellerManualCustomer(deps, request);
    expect(replay.result).toBe('extended');
    expect(replay.claim).toBeNull();
    expect(replay.claim_email_delivery).toBeNull();
    expect(sendClaimMail).toHaveBeenCalledTimes(1);
    expect(replay.customer).toEqual(expect.objectContaining({
      claim_email_marker: response.customer.claim_email_marker,
      claim_email_sent_at: NOW + 50,
    }));
  });

  it('keeps created access and the claim usable when post-commit mail delivery fails', async () => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    sellerStore.upsertSettings({
      sender_mail_instance_id: 'mail_primary',
      now: NOW,
    });
    const sendFailure = Object.assign(new Error('network may have accepted the message'), {
      code: 'MAIL_SEND_NETWORK_FAILED',
    });
    const sendClaimMail = vi.fn(async () => {
      expect(db.inTransaction).toBe(false);
      throw sendFailure;
    });
    const deps = {
      ...issueDeps(),
      isLiveSendCapableMailInstance: () => true,
      sendClaimMail,
    };
    const request = {
      door_id: 'door_llm',
      source_customer_id: 'manual-1',
      entitlement_key: 'basic',
      email: 'buyer@example.com',
      send_claim_email: true,
    } as const;

    const response = await issueSellerManualCustomer(deps, request);

    expect(response.result).toBe('created');
    expect(response.claim_email_delivery).toEqual({
      status: 'failed',
      error_code: 'MAIL_SEND_NETWORK_FAILED',
    });
    expect(response.customer).toEqual(expect.objectContaining({
      claim_email_marker: expect.stringMatching(/^claim:/u),
      claim_email_sent_at: null,
    }));
    expect(inboundTokenStore.getTokenById(response.customer.inbound_token_id!))
      .not.toBeNull();
    expect(consumeClaim(response.claim!)).toEqual(expect.objectContaining({
      bearer_plaintext: expect.stringMatching(/^recued_/u),
    }));

    const replay = await issueSellerManualCustomer(deps, request);
    expect(replay.result).toBe('extended');
    expect(replay.claim_email_delivery).toBeNull();
    expect(sendClaimMail).toHaveBeenCalledTimes(1);
  });

  it('reports sender drift after create without attempting mail or stamping a sent marker', async () => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    sellerStore.upsertSettings({
      sender_mail_instance_id: 'mail_stale',
      now: NOW,
    });
    const sendClaimMail = vi.fn(async () => ({
      message_id: 'must-not-send',
      sent_at: NOW,
    }));

    const response = await issueSellerManualCustomer(
      {
        ...issueDeps(),
        isLiveSendCapableMailInstance: () => false,
        sendClaimMail,
      },
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
        email: 'buyer@example.com',
        send_claim_email: true,
      },
    );

    expect(response.result).toBe('created');
    expect(response.claim_email_delivery).toEqual({
      status: 'failed',
      error_code: 'CLAIM_EMAIL_SENDER_NOT_CONFIGURED',
    });
    expect(response.customer).toEqual(expect.objectContaining({
      claim_email_marker: null,
      claim_email_sent_at: null,
    }));
    expect(sendClaimMail).not.toHaveBeenCalled();
    expect(response.claim).not.toBeNull();
  });

  it.each([
    ['header injection', 'buyer@example.com\r\nBcc: attacker@example.com'],
    ['recipient list injection', 'buyer@example.com,attacker@example.com'],
    ['non-mailbox text', 'not-an-address'],
  ])('refuses claim-email %s after create without exposing the claim to mail', async (
    _case,
    email,
  ) => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    sellerStore.upsertSettings({
      sender_mail_instance_id: 'mail_primary',
      now: NOW,
    });
    const sendClaimMail = vi.fn(async () => ({
      message_id: 'must-not-send',
      sent_at: NOW,
    }));

    const response = await issueSellerManualCustomer(
      {
        ...issueDeps(),
        isLiveSendCapableMailInstance: () => true,
        sendClaimMail,
      },
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
        email,
        send_claim_email: true,
      },
    );

    expect(response.result).toBe('created');
    expect(response.claim_email_delivery).toEqual({
      status: 'failed',
      error_code: 'CLAIM_EMAIL_RECIPIENT_INVALID',
    });
    expect(response.customer).toEqual(expect.objectContaining({
      claim_email_marker: null,
      claim_email_sent_at: null,
    }));
    expect(response.claim).not.toBeNull();
    expect(sendClaimMail).not.toHaveBeenCalled();
  });

  it('reports a transient post-commit settings-read failure as partial delivery failure', async () => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    sellerStore.upsertSettings({
      sender_mail_instance_id: 'mail_primary',
      now: NOW,
    });
    let settingsReads = 0;
    const flakySellerStore = new Proxy(sellerStore, {
      get(target, property, receiver) {
        if (property === 'getSettings') {
          return () => {
            settingsReads += 1;
            if (settingsReads === 1) throw new Error('transient settings read failed');
            return target.getSettings();
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const sendClaimMail = vi.fn(async () => ({
      message_id: 'must-not-send',
      sent_at: NOW,
    }));

    const response = await issueSellerManualCustomer(
      {
        ...issueDeps(),
        sellerStore: flakySellerStore,
        isLiveSendCapableMailInstance: () => true,
        sendClaimMail,
      },
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
        email: 'buyer@example.com',
        send_claim_email: true,
      },
    );

    expect(response.result).toBe('created');
    expect(response.claim_email_delivery).toEqual({
      status: 'failed',
      error_code: 'CLAIM_EMAIL_PREPARATION_FAILED',
    });
    expect(response.claim).not.toBeNull();
    expect(response.customer.claim_email_marker).toBeNull();
    expect(sendClaimMail).not.toHaveBeenCalled();
    expect(settingsReads).toBeGreaterThanOrEqual(2);
  });

  it('seals the enabled LLM gateway endpoint and configured model alias into the claim', async () => {
    putTemplate('ct_template_basic', { door_types: ['llm_gateway'] });
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    const llmManager = createLLMConfigManager(db);
    llmManager.setLlmGatewayModelAlias('buyer-model');

    const response = await issueSellerManualCustomer(
      { ...issueDeps(), llmManager },
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
      },
    );

    expect(consumeClaim(response.claim!)).toEqual({
      bearer_plaintext: expect.stringMatching(/^recued_/u),
      mcp_url: null,
      llm_gateway_base_url: 'https://seller.example/v1',
      llm_gateway_model_alias: 'buyer-model',
    });
  });

  it.each([
    ['plain HTTP', 'http://seller.example'],
    ['RFC1918 IPv4', 'https://192.168.1.20'],
    ['IPv4 loopback alias', 'https://127.0.0.2'],
    ['IPv6 unique-local', 'https://[fd00::1]'],
    ['mDNS hostname', 'https://seller.local'],
    ['embedded credentials', 'https://user:password@seller.example'],
    ['query-bearing base', 'https://seller.example?redirect=elsewhere'],
  ])('fails atomically when the claim URL uses %s', async (_case, publicBaseUrl) => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );

    await expect(issueSellerManualCustomer(
      { ...issueDeps(), getPublicBaseUrl: () => publicBaseUrl },
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
      },
    )).rejects.toMatchObject({
      code: 'not_configured',
      status: 503,
      method: 'server.seller.issueManualCustomer',
    });
    expect(sellerStore.listCustomers()).toHaveLength(0);
    expect(inboundTokenStore.listTokens()).toHaveLength(0);
    expect(contractStore.get(
      CONTRACT_DEFINITION_SCOPE,
      ['ct_customer_1'],
    )).toBeNull();
  });

  it('classifies a customer door with no claimable endpoint as unavailable, not bad input', async () => {
    putTemplate('ct_template_basic', { door_types: ['mcp_chat'] });
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_chat',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );

    await expect(issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_chat',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
      },
    )).rejects.toMatchObject({
      code: 'not_configured',
      status: 503,
      method: 'server.seller.issueManualCustomer',
    });
    expect(sellerStore.listCustomers()).toHaveLength(0);
    expect(inboundTokenStore.listTokens()).toHaveLength(0);
    expect(contractStore.get(
      CONTRACT_DEFINITION_SCOPE,
      ['ct_customer_1'],
    )).toBeNull();
  });

  it('replays issue as an extend without minting a second token', async () => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    const first = await issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
        current_period_end: NOW + DAY_MS,
      },
    );

    const replay = await issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
        current_period_end: NOW + 2 * DAY_MS,
        source_status: 'renewed',
      },
    );

    expect(replay.result).toBe('extended');
    expect(replay.claim).toBeNull();
    expect(replay.claim_email_delivery).toBeNull();
    expect(replay.customer).toEqual(expect.objectContaining({
      customer_id: first.customer.customer_id,
      contract_id: 'ct_customer_1',
      inbound_token_id: first.customer.inbound_token_id,
      current_period_end: NOW + 2 * DAY_MS,
      source_status: 'renewed',
      access_state: 'active',
    }));
    expect(inboundTokenStore.listTokens()).toHaveLength(1);
    expect(replay.overview.counts.customers).toBe(1);
  });

  it('returns not_configured when customer issue backing stores are absent', async () => {
    await expect(
      issueSellerManualCustomer(
        { sellerStore },
        {
          door_id: 'door_llm',
          source_customer_id: 'manual-1',
          entitlement_key: 'basic',
        },
      ),
    ).rejects.toMatchObject({
      code: 'not_configured',
      status: 501,
    });
  });

  it.each([
    ['token_grants', { 'core.mail.send': true }],
    ['token_label', 'attacker label'],
    ['token_expires_at', NOW + DAY_MS],
    ['token_concurrency_tier', 10],
    ['token_chat_mode', null],
    ['send_claim_email', 'yes'],
  ] as const)('rejects caller-authored issue field %s as bad_request', async (field, value) => {
    await expect(issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
        [field]: value,
      } as never,
    )).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });

  it('rejects caller-controlled local customer ids as bad_request', async () => {
    await expect(
      issueSellerManualCustomer(
        issueDeps(),
        {
          door_id: 'door_llm',
          source_customer_id: 'manual-1',
          entitlement_key: 'basic',
          customer_id: 'attacker_customer',
        } as never,
      ),
    ).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
    expect(sellerStore.listCustomers()).toHaveLength(0);
    expect(inboundTokenStore.listTokens()).toHaveLength(0);
  });
});

describe('manual customer lifecycle owner handlers', () => {
  it('extends a manual customer by customer_id without minting another token', async () => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    const issued = await issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
        email: 'buyer@example.com',
        current_period_end: NOW + DAY_MS,
      },
    );

    const extended = extendSellerManualCustomer(
      issueDeps(),
      {
        customer_id: issued.customer.customer_id,
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        email: ' Buyer+Renewed@Example.COM ',
        current_period_end: NOW + 2 * DAY_MS,
        source_status: 'renewed',
      },
    );

    expect(extended.customer).toEqual(expect.objectContaining({
      customer_id: issued.customer.customer_id,
      contract_id: 'ct_customer_1',
      inbound_token_id: issued.customer.inbound_token_id,
      email: 'buyer+renewed@example.com',
      current_period_end: NOW + 2 * DAY_MS,
      grace_until: NOW + 2 * DAY_MS + 72 * 60 * 60 * 1000,
      source_status: 'renewed',
      access_state: 'active',
    }));
    expect(inboundTokenStore.listTokens()).toHaveLength(1);
    expect(extended.overview.counts).toMatchObject({
      customers: 1,
      active_customers: 1,
    });
  });

  it('swaps a manual customer tier by source target and restamps the customer contract grants', async () => {
    putTemplate('ct_template_basic', {
      display_name: 'Basic template',
      scope: { operation_ids: ['core.basic'], channels: ['mcp'] },
    });
    putTemplate('ct_template_pro', {
      display_name: 'Pro template',
      scope: { operation_ids: ['core.pro'], channels: ['mcp'] },
    });
    grantEntryStore.set('ct_template_basic', 'core.basic', true, NOW - 1);
    grantEntryStore.set('ct_template_basic', 'core.shared', false, NOW - 1);
    grantEntryStore.set('ct_template_pro', 'core.pro', true, NOW - 1);
    grantEntryStore.set('ct_template_pro', 'core.shared', true, NOW - 1);
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_pro',
        door_id: 'door_llm',
        entitlement_key: 'pro',
        display_name: 'Pro',
        template_contract_id: 'ct_template_pro',
      },
    );
    const issued = await issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
        current_period_end: NOW + DAY_MS,
      },
    );

    const swapped = swapSellerManualCustomerTier(
      issueDeps(),
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'pro',
        current_period_end: NOW + 2 * DAY_MS,
        source_status: 'upgraded',
      },
    );

    expect(swapped.customer).toEqual(expect.objectContaining({
      customer_id: issued.customer.customer_id,
      tier_id: 'tier_pro',
      contract_id: 'ct_customer_1',
      inbound_token_id: issued.customer.inbound_token_id,
      current_period_end: NOW + 2 * DAY_MS,
      source_status: 'upgraded',
      access_state: 'active',
    }));
    expect(grantEntryStore.listForContract('ct_customer_1')).toEqual([
      { entry_key: 'core.pro', granted: true, set_at: NOW },
      { entry_key: 'core.shared', granted: true, set_at: NOW },
    ]);
    expect(inboundTokenStore.getTokenById(
      issued.customer.inbound_token_id!,
    )?.grants).toEqual({
      'core.pro': true,
      'core.shared': true,
    });
    expect(contractStore.get(CONTRACT_DEFINITION_SCOPE, ['ct_customer_1'])?.value)
      .toEqual(expect.objectContaining({
        contract_id: 'ct_customer_1',
        minted_at: NOW,
        minted_by: 'seller:test',
        display_name: 'Pro customer manual-1',
        scope: { operation_ids: ['core.pro'], channels: ['mcp'] },
      }));
  });

  it('reissues a manual customer token, ROTATING the customer contract', async () => {
    putTemplate('ct_template_basic', {
      display_name: 'Basic template',
      scope: { operation_ids: ['core.current'], channels: ['mcp'] },
    });
    grantEntryStore.set('ct_template_basic', 'core.current', true, NOW - 1);
    grantEntryStore.set('ct_template_basic', 'core.disabled', false, NOW - 1);
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    const issued = await issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
        email: 'buyer@example.com',
        current_period_end: NOW + DAY_MS,
      },
    );
    const oldTokenId = issued.customer.inbound_token_id!;
    const oldBearer = consumeClaim(issued.claim!).bearer_plaintext;

    const reissued = await reissueSellerManualCustomerToken(
      issueDeps(),
      {
        customer_id: issued.customer.customer_id,
      },
    );

    expect(reissued.customer.inbound_token_id).not.toBe(oldTokenId);
    expect(JSON.stringify(reissued)).not.toContain('bearer_plaintext');
    expect(reissued.customer).toEqual(expect.objectContaining({
      customer_id: issued.customer.customer_id,
      contract_id: 'ct_customer_2',
      tier_id: 'tier_basic',
      inbound_token_id: reissued.customer.inbound_token_id,
      mcp_token_id: reissued.customer.inbound_token_id,
      email: 'buyer@example.com',
      source_status: null,
      current_period_end: NOW + DAY_MS,
      access_state: 'active',
    }));
    expect(inboundTokenStore.verifyBearer({ bearer: oldBearer, now: NOW })).toBeNull();
    expect(inboundTokenStore.getTokenById(oldTokenId)?.revoked_at).toBe(NOW);
    expect(inboundTokenStore.getTokenById(
      reissued.customer.inbound_token_id!,
    )).toEqual(expect.objectContaining({
      label: 'Basic customer token',
      peer_handle: 'seller:manual:door_llm:manual-1',
      contract_id: 'ct_customer_2',
      grants: {
        'core.current': true,
        'core.disabled': false,
      },
    }));
    expect(inboundTokenStore.verifyBearer({
      bearer: consumeClaim(reissued.claim).bearer_plaintext,
      now: NOW,
    })?.contract_id).toBe('ct_customer_2');
    expect(reissued.overview.counts).toMatchObject({
      customers: 1,
      active_customers: 1,
    });
  });

  it('Message customer: reissue with send_claim_email re-mints AND emails the fresh link to the STORED address', async () => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    const issued = await issueSellerManualCustomer(issueDeps(), {
      door_id: 'door_llm',
      source_customer_id: 'manual-1',
      entitlement_key: 'basic',
      email: 'buyer@example.com',
    });
    const oldTokenId = issued.customer.inbound_token_id!;
    const oldBearer = consumeClaim(issued.claim!).bearer_plaintext;
    // D-297 — something the owner set for this one customer, under Contracts.
    grantEntryStore.set(issued.customer.contract_id, 'core.just_for_them', true, NOW + 1);

    sellerStore.upsertSettings({ sender_mail_instance_id: 'mail_primary', now: NOW });
    const isLiveSendCapableMailInstance = vi.fn(() => true);
    const sendClaimMail = vi.fn(async (_input: {
      readonly instance_id: string;
      readonly to: string;
      readonly subject: string;
      readonly body_text: string;
    }) => ({ message_id: 'message-reissue-1', sent_at: NOW + 70 }));
    const deps = { ...issueDeps(), isLiveSendCapableMailInstance, sendClaimMail };

    const reissued = await reissueSellerManualCustomerToken(deps, {
      customer_id: issued.customer.customer_id,
      send_claim_email: true,
    });

    // Re-minted (fresh token, prior bearer dead) AND delivered to the STORED
    // address — the owner never re-typed it.
    expect(reissued.customer.inbound_token_id).not.toBe(oldTokenId);
    expect(inboundTokenStore.verifyBearer({ bearer: oldBearer, now: NOW })).toBeNull();
    expect(reissued.claim_email_delivery).toEqual({
      status: 'sent',
      message_id: 'message-reissue-1',
      sent_at: NOW + 70,
    });
    expect(sendClaimMail).toHaveBeenCalledTimes(1);
    expect(sendClaimMail.mock.calls[0]![0]).toMatchObject({
      instance_id: 'mail_primary',
      to: 'buyer@example.com',
    });
    expect(reissued.customer.claim_email_sent_at).toBe(NOW + 70);
    // ⛔ D-297 — a fresh link is not a reset: the new agreement keeps the edit.
    expect(reissued.customer.contract_id).not.toBe(issued.customer.contract_id);
    expect(grantEntryStore.get(reissued.customer.contract_id, 'core.just_for_them')).toBe(true);
  });

  it('reissue WITHOUT send_claim_email surfaces the claim and sends nothing', async () => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    const issued = await issueSellerManualCustomer(issueDeps(), {
      door_id: 'door_llm',
      source_customer_id: 'manual-1',
      entitlement_key: 'basic',
      email: 'buyer@example.com',
    });
    const sendClaimMail = vi.fn(async () => ({ message_id: 'x', sent_at: NOW }));

    const reissued = await reissueSellerManualCustomerToken(
      { ...issueDeps(), isLiveSendCapableMailInstance: () => true, sendClaimMail },
      { customer_id: issued.customer.customer_id },
    );

    expect(reissued.claim_email_delivery).toBeNull();
    expect(sendClaimMail).not.toHaveBeenCalled();
    // The fresh claim is still surfaced for the reissue-and-copy path.
    expect(reissued.claim.claim_url).toContain('http');
  });

  it('rolls back bearer rotation and preserves the prior claim when claim URL resolution fails', async () => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    const issued = await issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
      },
    );
    const oldTokenId = issued.customer.inbound_token_id!;

    await expect(reissueSellerManualCustomerToken(
      { ...issueDeps(), getPublicBaseUrl: () => 'http://seller.example' },
      { customer_id: issued.customer.customer_id },
    )).rejects.toThrowError(expect.objectContaining({
      code: 'not_configured',
      status: 503,
      method: 'server.seller.reissueManualCustomerToken',
    }));
    expect(sellerStore.getCustomer(issued.customer.customer_id)?.inbound_token_id)
      .toBe(oldTokenId);
    expect(inboundTokenStore.getTokenById(oldTokenId)?.revoked_at).toBeNull();
    expect(inboundTokenStore.listTokens()).toHaveLength(1);
    expect(consumeClaim(issued.claim!).bearer_plaintext).toMatch(/^recued_/u);
  });

  it.each([
    ['source_status', 'attacker_status'],
    ['token_grants', { 'core.mail.send': true }],
    ['token_label', 'attacker label'],
    ['token_expires_at', NOW + DAY_MS],
    ['token_concurrency_tier', 10],
    ['token_chat_mode', null],
  ] as const)('rejects caller-authored reissue field %s as method-specific bad_request', async (field, value) => {
    await expect(reissueSellerManualCustomerToken(
      issueDeps(),
      {
        customer_id: 'seller_customer_1',
        [field]: value,
      } as never,
    )).rejects.toThrowError(
      expect.objectContaining({
        code: 'bad_request',
        status: 400,
        method: 'server.seller.reissueManualCustomerToken',
      }),
    );
  });

  it('bulk adjusts manual tier customers and returns a refreshed overview', async () => {
    putTemplate('ct_template_basic', {
      display_name: 'Basic template v1',
      scope: { operation_ids: ['core.old'], channels: ['mcp'] },
    });
    grantEntryStore.set('ct_template_basic', 'core.old', true, NOW - 1);
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    const first = await issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
        email: 'buyer@example.com',
        current_period_end: NOW + DAY_MS,
      },
    );
    const second = await issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-2',
        entitlement_key: 'basic',
      },
    );
    closeSellerManualCustomer(
      issueDeps(),
      {
        customer_id: second.customer.customer_id,
        reason: 'seller_manual',
      },
    );
    const template = contractStore.get(CONTRACT_DEFINITION_SCOPE, ['ct_template_basic']);
    expect(template).not.toBeNull();
    contractStore.put(CONTRACT_DEFINITION_SCOPE, ['ct_template_basic'], {
      ...(template!.value as ContractDefinition),
      display_name: 'Basic template v2',
      scope: { operation_ids: ['core.new'], channels: ['mcp'] },
    } satisfies ContractDefinition);
    grantEntryStore.clear('ct_template_basic', 'core.old');
    grantEntryStore.set('ct_template_basic', 'core.new', true, NOW);
    grantEntryStore.set('ct_template_basic', 'core.disabled', false, NOW);

    const adjusted = bulkAdjustSellerManualTierCustomers(
      issueDeps(),
      { tier_id: 'tier_basic' },
    );

    expect(adjusted.adjusted_customers).toEqual([
      expect.objectContaining({
        customer_id: first.customer.customer_id,
        contract_id: 'ct_customer_1',
        inbound_token_id: first.customer.inbound_token_id,
        email: 'buyer@example.com',
        access_state: 'active',
      }),
    ]);
    expect(adjusted.skipped_closed_customers).toEqual([
      expect.objectContaining({
        customer_id: second.customer.customer_id,
        access_state: 'closed',
      }),
    ]);
    expect(grantEntryStore.listForContract('ct_customer_1')).toEqual([
      { entry_key: 'core.disabled', granted: false, set_at: NOW },
      { entry_key: 'core.new', granted: true, set_at: NOW },
    ]);
    expect(inboundTokenStore.getTokenById(
      first.customer.inbound_token_id!,
    )?.grants).toEqual({
      'core.disabled': false,
      'core.new': true,
    });
    expect(contractStore.get(CONTRACT_DEFINITION_SCOPE, ['ct_customer_2'])?.value)
      .toEqual(expect.objectContaining({
        revoked_at: NOW,
        scope: { operation_ids: ['core.old'], channels: ['mcp'] },
      }));
    expect(adjusted.overview.counts).toMatchObject({
      customers: 2,
      active_customers: 1,
      closed_customers: 1,
    });
    expect(() =>
      bulkAdjustSellerManualTierCustomers(
        issueDeps(),
        {
          tier_id: 'tier_basic',
          customer_ids: [first.customer.customer_id, first.customer.customer_id],
        },
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'bad_request',
        status: 400,
        method: 'server.seller.bulkAdjustManualTierCustomers',
      }),
    );
  });

  it('D-309: re-applies a package through the rpc — preview writes nothing, applying sets, bad asks refused', async () => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
        pass_duration_seconds: 7 * 24 * 60 * 60,
      },
    );
    const byRule = await issueSellerManualCustomer(
      issueDeps(),
      { door_id: 'door_llm', source_customer_id: 'manual-1', entitlement_key: 'basic' },
    );
    const byHand = await issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_llm', source_customer_id: 'manual-2', entitlement_key: 'basic',
        current_period_end: NOW + 60 * DAY_MS,
      },
    );
    const request = {
      tier_id: 'tier_basic',
      apply: { permissions: false, length: true },
      who: 'unchanged' as const,
    };

    const preview = reapplySellerManualTier(issueDeps(), { ...request, preview: true });
    expect(preview.preview).toBe(true);
    expect(preview.customers.map((c) => [c.customer_id, c.included, c.skipped])).toEqual([
      [byRule.customer.customer_id, true, null],
      [byHand.customer.customer_id, false, 'changed_by_hand'],
    ]);

    const everyone = reapplySellerManualTier(issueDeps(), { ...request, who: 'everyone' });
    expect(everyone.preview).toBe(false);
    expect(sellerStore.getCustomer(byHand.customer.customer_id)?.current_period_end)
      .toBe(NOW + 7 * DAY_MS);
    expect(everyone.overview.counts.customers).toBe(2);

    for (const bad of [
      { ...request, apply: { permissions: true } },
      { ...request, who: 'nobody' },
      { ...request, who: 'picked' },
      { ...request, preview: 'yes' },
    ]) {
      expect(() => reapplySellerManualTier(issueDeps(), bad as never)).toThrowError(
        expect.objectContaining({
          code: 'bad_request', status: 400, method: 'server.seller.reapplyManualTier',
        }),
      );
    }
  });

  it('closes a manual customer, revokes its inbound token, and returns closed counts', async () => {
    putTemplate();
    upsertSellerManualTier(
      { sellerStore, now: () => NOW },
      {
        tier_id: 'tier_basic',
        door_id: 'door_llm',
        entitlement_key: 'basic',
        display_name: 'Basic',
        template_contract_id: 'ct_template_basic',
      },
    );
    const issued = await issueSellerManualCustomer(
      issueDeps(),
      {
        door_id: 'door_llm',
        source_customer_id: 'manual-1',
        entitlement_key: 'basic',
        current_period_end: NOW + DAY_MS,
      },
    );

    const { getPublicBaseUrl: _getPublicBaseUrl, ...closeDeps } = issueDeps();
    const closed = closeSellerManualCustomer(
      closeDeps,
      {
        customer_id: issued.customer.customer_id,
        reason: 'seller_manual',
        source_status: 'closed_by_owner',
      },
    );

    expect(closed.customer).toEqual(expect.objectContaining({
      customer_id: issued.customer.customer_id,
      contract_id: 'ct_customer_1',
      inbound_token_id: issued.customer.inbound_token_id,
      access_state: 'closed',
      source_status: 'closed_by_owner',
    }));
    expect(inboundTokenStore.getTokenById(
      issued.customer.inbound_token_id!,
    )?.revoked_at).toBe(NOW);
    expect(contractStore.get(CONTRACT_DEFINITION_SCOPE, ['ct_customer_1'])?.value)
      .toEqual(expect.objectContaining({
        revoked_at: NOW,
        revocation_reason: 'seller_manual',
      }));
    expect(closed.overview.counts).toMatchObject({
      customers: 1,
      active_customers: 0,
      closed_customers: 1,
    });
  });

  it('rejects unknown manual customer close reasons as bad_request', () => {
    expect(() =>
      closeSellerManualCustomer(
        issueDeps(),
        {
          customer_id: 'seller_customer_1',
          reason: 'chargeback',
        } as never,
      ),
    ).toThrowError(
      expect.objectContaining({
        code: 'bad_request',
        status: 400,
      }),
    );
  });
});

describe('D-196 consolidation — provider tier synchronization rpc', () => {
  const tierProvider = (): SellerProviderTierProvider => ({
    listConnections: (provider) => provider === 'paddle'
      ? [{ name: 'paddle-main', display_name: 'Paddle Main' }]
      : [{ name: 'ls-main', display_name: 'Lemon Squeezy Main' }],
    listRecords: vi.fn(async (input) => ({
      ok: true as const,
      records: input.provider === 'paddle'
        ? [{ id: 'pro_01hbasic', name: 'Basic', status: 'active' }]
        : [{ type: 'products', id: '3001', attributes: { name: 'Basic', status: 'published' } }],
    })),
  });

  it('routes a Paddle tier sync through the owner-attributed provider seam and mints product-keyed tiers', async () => {
    const providerTierProvider = tierProvider();
    const slice = makeSellerOverviewHandlers({
      sellerStore,
      contractStore,
      providerTierProvider,
      now: () => NOW,
      newContractId: () => 'ct_paddle_basic',
      newTierId: () => 'tier_paddle_basic',
    });

    const response = await slice!.handlers['server.seller.synchronizeProviderTiers'](
      { provider: 'paddle', door_id: 'door-mcp', door_type: 'mcp' },
      { user_id: 'owner-user', client_token_id: 'owner-client-token' } as WsClient,
    );

    expect(providerTierProvider.listRecords).toHaveBeenCalledWith({
      provider: 'paddle',
      connection_name: 'paddle-main',
      execution_source: {
        channel: 'user',
        actor: 'user_self',
        user_id: 'owner-user',
        client_token_id: 'owner-client-token',
      },
    });
    expect(response).toMatchObject({
      provider: 'paddle',
      connection_name: 'paddle-main',
      records_seen: 1,
      created_tier_ids: ['tier_paddle_basic'],
      overview: { counts: { tiers: 1, active_tiers: 1 } },
    });
    // The tier is keyed on the PRODUCT id under the provider's own source.
    expect(sellerStore.listTiers({ lifecycle_source: 'paddle' })).toMatchObject([
      { tier_id: 'tier_paddle_basic', entitlement_key: 'pro_01hbasic', external_entitlement_id: 'pro_01hbasic' },
    ]);
    // Readiness now reports both product providers.
    expect(response.overview.readiness.map((item) => [item.key, item.state])).toEqual(
      expect.arrayContaining([['paddle_provider', 'ready'], ['lemonsqueezy_provider', 'ready']]),
    );
  });

  it('refuses a Lemon Squeezy sync without its store id, and Paddle with one, as a bad request', async () => {
    const slice = makeSellerOverviewHandlers({
      sellerStore,
      contractStore,
      providerTierProvider: tierProvider(),
      now: () => NOW,
    });
    const client = { user_id: 'owner-user', client_token_id: 'owner-client-token' } as WsClient;
    await expect(slice!.handlers['server.seller.synchronizeProviderTiers'](
      { provider: 'lemonsqueezy', door_id: 'door-mcp', door_type: 'mcp' },
      client,
    )).rejects.toMatchObject({ code: 'bad_request', status: 400 });
    await expect(slice!.handlers['server.seller.synchronizeProviderTiers'](
      { provider: 'paddle', door_id: 'door-mcp', door_type: 'mcp', store_id: '4242' },
      client,
    )).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('is not_configured without the provider seam, and reports the providers as not wired', async () => {
    const slice = makeSellerOverviewHandlers({ sellerStore, contractStore, now: () => NOW });
    await expect(slice!.handlers['server.seller.synchronizeProviderTiers'](
      { provider: 'paddle', door_id: 'door-mcp', door_type: 'mcp' },
      { user_id: 'owner-user' } as WsClient,
    )).rejects.toMatchObject({ code: 'not_configured', status: 503 });
    const overview = await slice!.handlers['server.seller.getOverview'](undefined as never, {} as WsClient);
    expect(overview.readiness.find((item) => item.key === 'paddle_provider')?.state).toBe('not_wired');
  });
});
