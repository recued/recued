/** D-196 Paddle + Lemon Squeezy (2026-09-03) — the housekeeping sweep reads
 *  every provider a seller sells through, not only Stripe.
 *
 *  Before this slice `listSubscriptionCustomers` listed ONE lifecycle source and
 *  `readProviderTruth` spoke ONE provider's API, so a Paddle customer's
 *  subscription could be cancelled at the provider for a month and the row
 *  would never close unless the webhook lane saw it. The wiring now carries a
 *  provider table; the policy is untouched.
 *
 *  Everything below the wiring is REAL (SQLite stores, the real lifecycle), and
 *  the only stub is the gated provider read, keyed by CATALOG so a Paddle row
 *  cannot be answered by a Stripe object. The closing test proves the verdict
 *  LANDS for a non-Stripe source through the same lifecycle the kernel ops use. */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTRACT_DEFINITION_SCOPE,
  type ContractDefinition,
  type SellerLifecycleSource,
} from '@recued/contracts';

import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
  type ChatInboundTokenStore,
} from '../../storage/chat-inbound-token-store.js';
import { createContractStore, type ContractStore } from '../../storage/contract-store.js';
import { createSellerClaimStore, type SellerClaimStore } from '../../storage/seller-claim-store.js';
import { createSellerStore, type SellerStore } from '../../storage/seller-store.js';
import { createContractGrantEntryStore } from '../../storage/contract-grant-entry-store.js';
import { createSellerCustomerAccessLifecycle } from '../customer-access-lifecycle.js';
import { runSellerAccessReconcile } from '../../housekeeping/tasks/seller-access-reconcile.js';
import {
  SELLER_LEMONSQUEEZY_CATALOG_SLUG,
  SELLER_LEMONSQUEEZY_SUBSCRIPTION_READ_OPERATION_ID,
  SELLER_PADDLE_CATALOG_SLUG,
  SELLER_PADDLE_SUBSCRIPTION_READ_OPERATION_ID,
  SELLER_RECONCILE_PROVIDERS,
  SELLER_STRIPE_CATALOG_SLUG,
  SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION_ID,
  createSellerAccessReconcileDeps,
  parseLemonSqueezyProductIds,
  parseLemonSqueezySubscriptionTruth,
  parsePaddleProductIds,
  parsePaddleSubscriptionTruth,
} from '../access-reconcile-deps.js';

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const FUTURE_ISO = '2026-10-03T12:00:00.000000Z';
const FUTURE_MS = Date.parse('2026-10-03T12:00:00.000Z');
const PAST_ISO = '2026-09-01T00:00:00.000000Z';

let db: Database.Database;
let contractStore: ContractStore;
let inboundTokenStore: ChatInboundTokenStore;
let sellerStore: SellerStore;
let sellerClaimStore: SellerClaimStore;

beforeEach(() => {
  db = new Database(':memory:');
  contractStore = createContractStore(db, { now: () => NOW });
  ensureChatInboundTokenSchema(db);
  inboundTokenStore = createChatInboundTokenStore(db);
  sellerStore = createSellerStore(db);
  sellerClaimStore = createSellerClaimStore(db);
});
afterEach(() => { db.close(); });

// ── provider fixtures, in the `{ result }` envelope the gateway hands back ──
const paddleSubscription = (over: Record<string, unknown> = {}): unknown => ({
  result: {
    id: 'sub_01h_paddle', status: 'active', customer_id: 'ctm_01h',
    custom_data: { recued_workflow_key: 'ord:x' },
    current_billing_period: { starts_at: '2026-09-03T00:00:00Z', ends_at: FUTURE_ISO },
    items: [{ status: 'active', price: { id: 'pri_1', product_id: 'pro_basic' } }],
    ...over,
  },
});
const lsSubscription = (over: Record<string, unknown> = {}): unknown => ({
  result: {
    type: 'subscriptions', id: '7001',
    attributes: { status: 'active', customer_id: 5001, order_id: 9001, product_id: 3001, renews_at: FUTURE_ISO, ends_at: null, ...over },
  },
});

const connection = (name: string, vendor: string) => ({
  name, display_name: name, config_json: JSON.stringify({ vendor }), subresource_path: undefined,
});
const CONNECTIONS = {
  stripe: connection('stripe-main', 'stripe'),
  paddle: connection('paddle-main', 'paddle'),
  lemonsqueezy: connection('ls-main', 'lemonsqueezy'),
};
const MANIFESTS: Record<string, unknown> = {
  [SELLER_STRIPE_CATALOG_SLUG]: { operations: { 'subscription.read': { operation_id: SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION_ID } } },
  [SELLER_PADDLE_CATALOG_SLUG]: { operations: { 'subscription.read': { operation_id: SELLER_PADDLE_SUBSCRIPTION_READ_OPERATION_ID } } },
  [SELLER_LEMONSQUEEZY_CATALOG_SLUG]: { operations: { 'subscription.read': { operation_id: SELLER_LEMONSQUEEZY_SUBSCRIPTION_READ_OPERATION_ID } } },
};
const CATALOG_BY_CONNECTION: Record<string, string> = {
  'stripe-main': SELLER_STRIPE_CATALOG_SLUG,
  'paddle-main': SELLER_PADDLE_CATALOG_SLUG,
  'ls-main': SELLER_LEMONSQUEEZY_CATALOG_SLUG,
};

/** Wiring with a chosen set of ready connections and a per-catalog provider read. */
const buildWiring = (over: {
  ready: readonly (keyof typeof CONNECTIONS)[];
  reads?: Partial<Record<string, unknown>>;
}) => {
  const runOperation = vi.fn(async (_deps: unknown, request: unknown) => {
    const { catalogSlug, operationKey } = request as { catalogSlug: string; operationKey: string };
    const raw = over.reads?.[catalogSlug];
    if (operationKey !== 'subscription.read' || raw === undefined) {
      return { ok: false, kind: 'error', reason: `no fixture for ${catalogSlug}.${operationKey}` } as const;
    }
    return { ok: true, raw } as const;
  });
  const deps = createSellerAccessReconcileDeps({
    sellerStore, contractStore, inboundTokenStore, sellerClaimStore,
    executorConfig: { manifests: { get: (slug: string) => MANIFESTS[slug] ?? null } } as never,
    connectionOperationProfiles: {
      get: (name: string) => ({ catalog_slug: CATALOG_BY_CONNECTION[name], allowed_operations: ['subscription.read'] }),
    } as never,
    connectionStore: {
      get: (_kind: 'api', name: string) => over.ready.map((k) => CONNECTIONS[k]).find((row) => row.name === name) ?? null,
      list: () => over.ready.map((k) => CONNECTIONS[k]),
    } as never,
    now: () => NOW,
    runOperation: runOperation as never,
  });
  return { deps, runOperation };
};

const seedTier = (input: { tier_id: string; entitlement_key: string; lifecycle_source: SellerLifecycleSource }) => {
  const contract_id = `ct_template_${input.tier_id}`;
  const template: ContractDefinition = {
    contract_id, minted_at: NOW - 10_000, minted_by: 'owner:test',
    display_name: `Template ${input.entitlement_key}`,
    scope: { operation_ids: [`${contract_id}.op`] }, door_types: ['mcp'], grant_kind: 'customer_template',
  };
  contractStore.put(CONTRACT_DEFINITION_SCOPE, [contract_id], template);
  return sellerStore.upsertTier({
    tier_id: input.tier_id, door_id: 'door_mcp', lifecycle_source: input.lifecycle_source,
    entitlement_key: input.entitlement_key, display_name: input.entitlement_key,
    template_contract_id: contract_id, usage_policy_json: {}, now: NOW,
  });
};

const seedCustomer = (input: { lifecycle_source: SellerLifecycleSource; source_customer_id: string; entitlement_key: string; external_subscription_id: string }) => {
  const lifecycle = createSellerCustomerAccessLifecycle({
    sellerStore, contractStore,
    grantEntryStore: createContractGrantEntryStore(contractStore),
    inboundTokenStore, sellerClaimStore,
    buildClaimPayload: ({ bearer_plaintext }) => ({
      bearer_plaintext, mcp_url: 'https://seller.example/mcp', llm_gateway_base_url: null, llm_gateway_model_alias: null,
    }),
    mintedBy: 'seller:test', now: () => NOW,
    transaction: (fn) => contractStore.transaction(fn),
  });
  return lifecycle.issueCustomer({
    lifecycle_source: input.lifecycle_source, door_id: 'door_mcp',
    source_customer_id: input.source_customer_id, entitlement_key: input.entitlement_key,
    current_period_end: NOW + DAY_MS, source_status: 'active',
    external_subscription_id: input.external_subscription_id,
  }).customer;
};

const seedAll = () => {
  seedTier({ tier_id: 'tier_stripe_basic', entitlement_key: 'basic', lifecycle_source: 'stripe' });
  seedTier({ tier_id: 'tier_paddle_basic', entitlement_key: 'pro_basic', lifecycle_source: 'paddle' });
  seedTier({ tier_id: 'tier_paddle_team', entitlement_key: 'pro_team', lifecycle_source: 'paddle' });
  seedTier({ tier_id: 'tier_ls_basic', entitlement_key: '3001', lifecycle_source: 'lemonsqueezy' });
  seedTier({ tier_id: 'tier_ls_team', entitlement_key: '3002', lifecycle_source: 'lemonsqueezy' });
  return {
    stripe: seedCustomer({ lifecycle_source: 'stripe', source_customer_id: 'cus_1', entitlement_key: 'basic', external_subscription_id: 'sub_stripe_1' }),
    paddle: seedCustomer({ lifecycle_source: 'paddle', source_customer_id: 'ctm_01h', entitlement_key: 'pro_basic', external_subscription_id: 'sub_01h_paddle' }),
    lemonsqueezy: seedCustomer({ lifecycle_source: 'lemonsqueezy', source_customer_id: '5001', entitlement_key: '3001', external_subscription_id: '7001' }),
  };
};

describe('the provider table', () => {
  it('names one reader per provider the seller substrate knows, Stripe first', () => {
    expect(SELLER_RECONCILE_PROVIDERS.map((p) => p.source)).toEqual(['stripe', 'paddle', 'lemonsqueezy']);
    for (const provider of SELLER_RECONCILE_PROVIDERS) {
      // The look-alike pin: the op id the bounded catalog compiles to.
      expect(provider.subscription_read_operation_id)
        .toBe(`recued-core/${provider.catalog_slug}.${provider.subscription_read_operation}`);
    }
  });
});

describe('listSubscriptionCustomers — each source behind its own readiness gate', () => {
  it('lists every provider\'s rows, tagged with the source that issued the subscription id', async () => {
    const seeded = seedAll();
    const { deps } = buildWiring({ ready: ['stripe', 'paddle', 'lemonsqueezy'] });
    const listed = await deps.listSubscriptionCustomers();
    expect(listed.map((row) => [row.customer_id, row.lifecycle_source, row.external_subscription_id])).toEqual([
      [seeded.stripe.customer_id, 'stripe', 'sub_stripe_1'],
      [seeded.paddle.customer_id, 'paddle', 'sub_01h_paddle'],
      [seeded.lemonsqueezy.customer_id, 'lemonsqueezy', '7001'],
    ]);
  });

  it('a seller on Paddle alone sweeps Paddle rows only — Stripe rows are not listed, so never counted unreadable', async () => {
    const seeded = seedAll();
    const { deps } = buildWiring({ ready: ['paddle'] });
    const listed = await deps.listSubscriptionCustomers();
    expect(listed.map((row) => row.customer_id)).toEqual([seeded.paddle.customer_id]);
  });
});

describe('readProviderTruth — the read goes through the catalog that issued the id', () => {
  it('Paddle: reads through seller-paddle, carries status + period, and resolves the swap axis from the same read', async () => {
    const seeded = seedAll();
    const { deps, runOperation } = buildWiring({
      ready: ['stripe', 'paddle', 'lemonsqueezy'],
      reads: { [SELLER_PADDLE_CATALOG_SLUG]: paddleSubscription({ items: [{ status: 'active', price: { id: 'pri_2', product_id: 'pro_team' } }] }) },
    });
    const [local] = (await deps.listSubscriptionCustomers()).filter((row) => row.customer_id === seeded.paddle.customer_id);
    const truth = await deps.readProviderTruth(local!);
    expect(truth).toEqual({ status: 'active', current_period_end_ms: FUTURE_MS, tier_id: 'tier_paddle_team' });
    // ONE call, to the Paddle catalog, for the Paddle id — no entitlement read.
    expect(runOperation).toHaveBeenCalledTimes(1);
    expect(runOperation.mock.calls[0]![1]).toMatchObject({
      catalogSlug: SELLER_PADDLE_CATALOG_SLUG, operationKey: 'subscription.read',
      args: { subscription_id: 'sub_01h_paddle' }, connection_name: 'paddle-main',
    });
  });

  it('Lemon Squeezy: a cancelled subscription reports ends_at as its period; past ends_at reads as expired', async () => {
    const seeded = seedAll();
    const stillPaid = buildWiring({
      ready: ['lemonsqueezy'],
      reads: { [SELLER_LEMONSQUEEZY_CATALOG_SLUG]: lsSubscription({ status: 'cancelled', ends_at: FUTURE_ISO }) },
    });
    const [local] = await stillPaid.deps.listSubscriptionCustomers();
    expect(local?.customer_id).toBe(seeded.lemonsqueezy.customer_id);
    expect(await stillPaid.deps.readProviderTruth(local!)).toEqual({ status: 'cancelled', current_period_end_ms: FUTURE_MS });

    const lapsed = buildWiring({
      ready: ['lemonsqueezy'],
      reads: { [SELLER_LEMONSQUEEZY_CATALOG_SLUG]: lsSubscription({ status: 'cancelled', ends_at: PAST_ISO }) },
    });
    expect(await lapsed.deps.readProviderTruth(local!)).toEqual({ status: 'expired' });
  });

  it('Lemon Squeezy: the swap axis is the numeric product id, matched as a string', async () => {
    const seeded = seedAll();
    const { deps } = buildWiring({
      ready: ['lemonsqueezy'],
      reads: { [SELLER_LEMONSQUEEZY_CATALOG_SLUG]: lsSubscription({ product_id: 3002 }) },
    });
    const [local] = await deps.listSubscriptionCustomers();
    expect(local?.customer_id).toBe(seeded.lemonsqueezy.customer_id);
    expect(await deps.readProviderTruth(local!)).toEqual({ status: 'active', current_period_end_ms: FUTURE_MS, tier_id: 'tier_ls_team' });
  });

  it('a row whose provider read answers with another provider\'s shape is UNREADABLE, never converged', async () => {
    seedAll();
    const { deps } = buildWiring({
      ready: ['paddle'],
      // A Stripe-shaped object handed back for a Paddle id: wrong id, no Paddle fields.
      reads: { [SELLER_PADDLE_CATALOG_SLUG]: { result: { object: 'subscription', id: 'sub_stripe_1', status: 'canceled' } } },
    });
    const [local] = await deps.listSubscriptionCustomers();
    expect(await deps.readProviderTruth(local!)).toBeNull();
  });
});

describe('the parsers refuse what they cannot vouch for', () => {
  it('Paddle', () => {
    expect(parsePaddleSubscriptionTruth(paddleSubscription(), 'sub_01h_paddle')).toEqual({ status: 'active', current_period_end_ms: FUTURE_MS });
    expect(parsePaddleSubscriptionTruth(paddleSubscription({ id: 'sub_other' }), 'sub_01h_paddle')).toBeNull();
    expect(parsePaddleSubscriptionTruth(paddleSubscription({ status: '' }), 'sub_01h_paddle')).toBeNull();
    expect(parsePaddleSubscriptionTruth(paddleSubscription(), 'txn_not_a_subscription')).toBeNull();
    // Paused subscriptions carry no billing period: status still travels.
    expect(parsePaddleSubscriptionTruth(paddleSubscription({ status: 'paused', current_billing_period: null }), 'sub_01h_paddle')).toEqual({ status: 'paused' });
    expect(parsePaddleSubscriptionTruth(paddleSubscription({ current_billing_period: { ends_at: 'not a date' } }), 'sub_01h_paddle')).toEqual({ status: 'active' });
    expect(parsePaddleProductIds(paddleSubscription({ items: [
      { status: 'inactive', price: { product_id: 'pro_old' } },
      { status: 'trialing', price: { product_id: 'pro_trial' } },
      { status: 'active', price: { product_id: 'pro_basic' } },
    ] }))).toEqual(['pro_trial', 'pro_basic']);
  });

  it('Lemon Squeezy', () => {
    expect(parseLemonSqueezySubscriptionTruth(lsSubscription(), '7001', NOW)).toEqual({ status: 'active', current_period_end_ms: FUTURE_MS });
    expect(parseLemonSqueezySubscriptionTruth(lsSubscription(), '7002', NOW)).toBeNull();
    expect(parseLemonSqueezySubscriptionTruth({ result: { type: 'orders', id: '7001', attributes: { status: 'paid' } } }, '7001', NOW)).toBeNull();
    expect(parseLemonSqueezySubscriptionTruth(lsSubscription({ status: 'on_trial' }), '7001', NOW)).toEqual({ status: 'on_trial', current_period_end_ms: FUTURE_MS });
    expect(parseLemonSqueezyProductIds(lsSubscription({ product_id: 3002 }))).toEqual(['3002']);
    expect(parseLemonSqueezyProductIds(lsSubscription({ product_id: 'garbage' }))).toEqual([]);
  });
});

describe('the verdict LANDS for a non-Stripe source', () => {
  it('🔑 a Paddle `canceled` closes the customer through the real lifecycle; a Lemon Squeezy `expired` too', async () => {
    const seeded = seedAll();
    const { deps } = buildWiring({
      ready: ['paddle', 'lemonsqueezy'],
      reads: {
        [SELLER_PADDLE_CATALOG_SLUG]: paddleSubscription({ status: 'canceled', current_billing_period: null }),
        [SELLER_LEMONSQUEEZY_CATALOG_SLUG]: lsSubscription({ status: 'cancelled', ends_at: PAST_ISO }),
      },
    });
    const out = await runSellerAccessReconcile(deps);
    expect(out).toMatchObject({ swept: 2, closed: 2, unreadable: 0 });
    for (const [customer, status] of [[seeded.paddle, 'canceled'], [seeded.lemonsqueezy, 'expired']] as const) {
      const row = sellerStore.getCustomer(customer.customer_id);
      expect(row?.access_state).toBe('closed');
      expect(row?.source_status).toBe(status);
      expect(inboundTokenStore.getTokenById(customer.inbound_token_id!)?.revoked_at ?? null).not.toBeNull();
    }
    // The Stripe row was never listed (no ready Stripe connection) and is untouched.
    expect(sellerStore.getCustomer(seeded.stripe.customer_id)?.access_state).toBe('active');
  });

  it('a Paddle plan change swaps the tier; a longer Paddle period extends', async () => {
    const seeded = seedAll();
    const swapped = buildWiring({
      ready: ['paddle'],
      reads: { [SELLER_PADDLE_CATALOG_SLUG]: paddleSubscription({ items: [{ status: 'active', price: { product_id: 'pro_team' } }] }) },
    });
    expect(await runSellerAccessReconcile(swapped.deps)).toMatchObject({ swept: 1, swapped: 1 });
    expect(sellerStore.getCustomer(seeded.paddle.customer_id)?.tier_id).toBe('tier_paddle_team');

    // Same plan as the row now holds, so the only verdict left is the longer period.
    const extended = buildWiring({
      ready: ['paddle'],
      reads: { [SELLER_PADDLE_CATALOG_SLUG]: paddleSubscription({ items: [{ status: 'active', price: { product_id: 'pro_team' } }] }) },
    });
    expect(await runSellerAccessReconcile(extended.deps)).toMatchObject({ swept: 1, extended: 1 });
    expect(sellerStore.getCustomer(seeded.paddle.customer_id)?.current_period_end).toBe(FUTURE_MS);
  });
});
