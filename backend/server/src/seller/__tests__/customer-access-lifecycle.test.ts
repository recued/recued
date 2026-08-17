/** D-196 Seller Economy - customer access lifecycle core tests. */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  type ContractDefinition,
} from '@recued/contracts';

import { createContractGrantEntryStore, type ContractGrantEntryStore } from '../../storage/contract-grant-entry-store.js';
import { createContractStore, type ContractStore } from '../../storage/contract-store.js';
import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
  type ChatInboundTokenStore,
} from '../../storage/chat-inbound-token-store.js';
import {
  SellerStoreConflictError,
  createSellerStore,
  type SellerStore,
} from '../../storage/seller-store.js';
import {
  createSellerClaimStore,
  type SellerClaimStore,
} from '../../storage/seller-claim-store.js';
import {
  SellerCustomerAccessError,
  createSellerCustomerAccessLifecycle,
  type SellerCustomerAccessLifecycle,
} from '../customer-access-lifecycle.js';

const NOW = 1_900_100_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GRACE_MS = 72 * 60 * 60 * 1000;

let db: Database.Database;
let contractStore: ContractStore;
let grantEntryStore: ContractGrantEntryStore;
let inboundTokenStore: ChatInboundTokenStore;
let sellerStore: SellerStore;
let sellerClaimStore: SellerClaimStore;
let lifecycle: SellerCustomerAccessLifecycle;
let now: number;
let contractIds: string[];
let customerIds: string[];

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

const upsertTier = (
  overrides: Partial<Parameters<SellerStore['upsertTier']>[0]> = {},
) =>
  sellerStore.upsertTier({
    tier_id: 'tier_basic',
    door_id: 'door_mcp',
    lifecycle_source: 'stripe',
    entitlement_key: 'basic',
    display_name: 'Basic',
    template_contract_id: 'ct_template_basic',
    usage_policy_json: { tool_call: { period_limit: 1000 } },
    now,
    ...overrides,
  });

const issueBasic = (
  overrides: Partial<Parameters<SellerCustomerAccessLifecycle['issueCustomer']>[0]> = {},
) =>
  lifecycle.issueCustomer({
    lifecycle_source: 'stripe',
    door_id: 'door_mcp',
    source_customer_id: 'cus_1',
    entitlement_key: 'basic',
    current_period_end: NOW + DAY_MS,
    source_status: 'active',
    ...overrides,
  });

const customerDefinition = (contract_id: string): ContractDefinition => {
  const row = contractStore.get(CONTRACT_DEFINITION_SCOPE, [contract_id]);
  expect(row).not.toBeNull();
  return row!.value as ContractDefinition;
};

beforeEach(() => {
  db = new Database(':memory:');
  now = NOW;
  contractIds = ['ct_customer_1', 'ct_customer_2', 'ct_customer_3'];
  customerIds = ['seller_customer_1', 'seller_customer_2', 'seller_customer_3'];
  contractStore = createContractStore(db, { now: () => now });
  grantEntryStore = createContractGrantEntryStore(contractStore);
  ensureChatInboundTokenSchema(db);
  inboundTokenStore = createChatInboundTokenStore(db);
  sellerStore = createSellerStore(db);
  sellerClaimStore = createSellerClaimStore(db);
  lifecycle = createSellerCustomerAccessLifecycle({
    sellerStore,
    contractStore,
    grantEntryStore,
    inboundTokenStore,
    sellerClaimStore,
    buildClaimPayload: ({ bearer_plaintext }) => ({
      bearer_plaintext,
      mcp_url: 'https://seller.example/mcp',
      llm_gateway_base_url: null,
      llm_gateway_model_alias: null,
    }),
    requireClaimOnTokenIssue: true,
    mintedBy: 'seller:test',
    now: () => now,
    newContractId: () => nextId(contractIds, 'contract'),
    newCustomerId: () => nextId(customerIds, 'customer'),
    transaction: (fn) => contractStore.transaction(fn),
  });
});

afterEach(() => {
  db.close();
});

describe('seller customer access lifecycle', () => {
  it('generates local customer ids and rejects caller-controlled ids before side effects', () => {
    putTemplate();
    upsertTier();

    expect(() =>
      issueBasic({ customer_id: 'attacker_customer' } as never),
    ).toThrow(/customer_id is server-generated/);
    expect(sellerStore.listCustomers()).toHaveLength(0);
    expect(inboundTokenStore.listTokens()).toHaveLength(0);
    expect(() =>
      issueBasic({ token_grants: { attacker: true } } as never),
    ).toThrow(/derives token_grants server-side/);
    expect(sellerStore.listCustomers()).toHaveLength(0);
    expect(inboundTokenStore.listTokens()).toHaveLength(0);

    const issued = issueBasic();
    expect(issued.customer.customer_id).toBe('seller_customer_1');
    expect(() =>
      issueBasic({ customer_id: 'attacker_customer' } as never),
    ).toThrow(/customer_id is server-generated/);
    expect(sellerStore.listCustomers()).toHaveLength(1);
    expect(inboundTokenStore.listTokens()).toHaveLength(1);
  });

  it('rejects a generated customer id collision before side effects without a transaction', () => {
    putTemplate();
    upsertTier();
    const first = issueBasic();
    const collisionLifecycle = createSellerCustomerAccessLifecycle({
      sellerStore,
      contractStore,
      grantEntryStore,
      inboundTokenStore,
      mintedBy: 'seller:test',
      now: () => now,
      newContractId: () => 'ct_customer_collision_attempt',
      newCustomerId: () => first.customer.customer_id,
    });

    expect(() =>
      collisionLifecycle.issueCustomer({
        lifecycle_source: 'stripe',
        door_id: 'door_mcp',
        source_customer_id: 'cus_collision_attempt',
        entitlement_key: 'basic',
        current_period_end: NOW + DAY_MS,
      }),
    ).toThrow(SellerStoreConflictError);
    expect(contractStore.get(
      CONTRACT_DEFINITION_SCOPE,
      ['ct_customer_collision_attempt'],
    )).toBeNull();
    expect(inboundTokenStore.listTokens()).toHaveLength(1);
    expect(sellerStore.listCustomers()).toHaveLength(1);
  });

  it('rejects a generated contract id collision before overwriting another customer', () => {
    putTemplate();
    upsertTier();
    const first = issueBasic();
    const firstContract = customerDefinition(first.customer.contract_id);
    const collisionLifecycle = createSellerCustomerAccessLifecycle({
      sellerStore,
      contractStore,
      grantEntryStore,
      inboundTokenStore,
      mintedBy: 'seller:test',
      now: () => now,
      newContractId: () => first.customer.contract_id,
      newCustomerId: () => 'seller_customer_2',
      transaction: (fn) => contractStore.transaction(fn),
    });

    expect(() =>
      collisionLifecycle.issueCustomer({
        lifecycle_source: 'stripe',
        door_id: 'door_mcp',
        source_customer_id: 'cus_contract_collision',
        entitlement_key: 'basic',
        current_period_end: NOW + DAY_MS,
      }),
    ).toThrow(SellerStoreConflictError);
    expect(customerDefinition(first.customer.contract_id)).toEqual(firstContract);
    expect(inboundTokenStore.listTokens()).toHaveLength(1);
    expect(sellerStore.listCustomers()).toHaveLength(1);
  });

  it('issues a customer by stamping template grants into a bound customer contract', () => {
    putTemplate('ct_template_basic', {
      display_name: 'Basic template',
      scope: { operation_ids: ['core.mail.send'], channels: ['mcp'] },
      approved_actions_template: { actions: [{ operation_id: 'core.mail.send' }] },
    });
    grantEntryStore.set('ct_template_basic', 'core.mail.send', true, NOW - 1, 'pack_a');
    grantEntryStore.set('ct_template_basic', 'data.contacts', false, NOW - 1, 'pack_a');
    upsertTier();

    const result = issueBasic({
      email: ' Buyer@Example.COM ',
      external_subscription_id: 'sub_1',
    });

    expect(result.result).toBe('created');
    expect(result.issued_token).not.toBeNull();
    expect(result.issued_claim).toEqual(expect.objectContaining({
      claim_id: expect.stringMatching(/^seller_claim_/u),
      claim_secret: expect.stringMatching(/^recued_claim_/u),
    }));
    expect(result.customer).toEqual(expect.objectContaining({
      customer_id: 'seller_customer_1',
      lifecycle_source: 'stripe',
      source_customer_id: 'cus_1',
      door_id: 'door_mcp',
      email: 'buyer@example.com',
      tier_id: 'tier_basic',
      contract_id: 'ct_customer_1',
      inbound_token_id: result.issued_token!.record.token_id,
      mcp_token_id: result.issued_token!.record.token_id,
      external_subscription_id: 'sub_1',
      source_status: 'active',
      current_period_end: NOW + DAY_MS,
      grace_until: NOW + DAY_MS + DEFAULT_GRACE_MS,
      access_state: 'active',
    }));

    const stamped = customerDefinition('ct_customer_1');
    expect(stamped).toEqual(expect.objectContaining({
      contract_id: 'ct_customer_1',
      minted_at: NOW,
      minted_by: 'seller:test',
      display_name: 'Basic customer cus_1',
      scope: { operation_ids: ['core.mail.send'], channels: ['mcp'] },
      door_types: ['mcp'],
      grant_kind: 'customer_instance',
      approved_actions_template: { actions: [{ operation_id: 'core.mail.send' }] },
    }));
    expect(stamped.revoked_at).toBeUndefined();
    expect(grantEntryStore.listForContract('ct_customer_1')).toEqual([
      { entry_key: 'core.mail.send', granted: true, set_at: NOW },
      { entry_key: 'data.contacts', granted: false, set_at: NOW },
    ]);

    const token = inboundTokenStore.getTokenById(result.issued_token!.record.token_id);
    expect(token).toEqual(expect.objectContaining({
      contract_id: 'ct_customer_1',
      peer_handle: 'seller:stripe:door_mcp:cus_1',
      revoked_at: null,
      concurrency_tier: 3,
      chat_mode: null,
    }));
    expect(token?.grants['core.mail.send']).toBe(true);
    expect(token?.grants['data.contacts']).toBe(false);
    expect(inboundTokenStore.verifyBearer({
      bearer: result.issued_token!.bearer_plaintext,
      now,
    })?.contract_id).toBe('ct_customer_1');
  });

  it('rolls back the customer contract, token, and row when claim issuance fails', () => {
    putTemplate();
    upsertTier();
    const failingLifecycle = createSellerCustomerAccessLifecycle({
      sellerStore,
      contractStore,
      grantEntryStore,
      inboundTokenStore,
      sellerClaimStore: {
        ...sellerClaimStore,
        issue: () => {
          throw new Error('claim store unavailable');
        },
      },
      buildClaimPayload: ({ bearer_plaintext }) => ({
        bearer_plaintext,
        mcp_url: 'https://seller.example/mcp',
        llm_gateway_base_url: null,
        llm_gateway_model_alias: null,
      }),
      requireClaimOnTokenIssue: true,
      mintedBy: 'seller:test',
      now: () => now,
      newContractId: () => 'ct_customer_claim_failure',
      newCustomerId: () => 'seller_customer_claim_failure',
      transaction: (fn) => contractStore.transaction(fn),
    });

    expect(() => failingLifecycle.issueCustomer({
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_claim_failure',
      entitlement_key: 'basic',
      current_period_end: NOW + DAY_MS,
    })).toThrow('claim store unavailable');
    expect(contractStore.get(
      CONTRACT_DEFINITION_SCOPE,
      ['ct_customer_claim_failure'],
    )).toBeNull();
    expect(inboundTokenStore.listTokens()).toHaveLength(0);
    expect(sellerStore.listCustomers()).toHaveLength(0);
  });

  it('rolls back when a claim store violates its non-null issue contract', () => {
    putTemplate();
    upsertTier();
    const invalidClaimLifecycle = createSellerCustomerAccessLifecycle({
      sellerStore,
      contractStore,
      grantEntryStore,
      inboundTokenStore,
      sellerClaimStore: {
        ...sellerClaimStore,
        issue: () => null as never,
      },
      buildClaimPayload: ({ bearer_plaintext }) => ({
        bearer_plaintext,
        mcp_url: 'https://seller.example/mcp',
        llm_gateway_base_url: null,
        llm_gateway_model_alias: null,
      }),
      requireClaimOnTokenIssue: true,
      mintedBy: 'seller:test',
      now: () => now,
      newContractId: () => 'ct_customer_null_claim',
      newCustomerId: () => 'seller_customer_null_claim',
      transaction: (fn) => contractStore.transaction(fn),
    });

    expect(() => invalidClaimLifecycle.issueCustomer({
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_null_claim',
      entitlement_key: 'basic',
      current_period_end: NOW + DAY_MS,
    })).toThrow(/one-time customer claim delivery is not configured/u);
    expect(contractStore.get(
      CONTRACT_DEFINITION_SCOPE,
      ['ct_customer_null_claim'],
    )).toBeNull();
    expect(inboundTokenStore.listTokens()).toHaveLength(0);
    expect(sellerStore.listCustomers()).toHaveLength(0);
  });

  it('replayed issue with the same tier extends without minting another customer token', () => {
    putTemplate();
    upsertTier();
    const first = issueBasic();
    const tokenId = first.issued_token!.record.token_id;
    const retiredTemplate = customerDefinition('ct_template_basic');
    contractStore.put(CONTRACT_DEFINITION_SCOPE, ['ct_template_basic'], {
      ...retiredTemplate,
      revoked_at: NOW + 1000,
      revocation_reason: 'template_retired',
    } satisfies ContractDefinition);
    upsertTier({ active: false, now: NOW + 2000 });

    now = NOW + 5000;
    const replay = issueBasic({
      current_period_end: NOW + 2 * DAY_MS,
      source_status: 'renewed',
    });

    expect(replay.result).toBe('extended');
    expect(replay.issued_claim).toBeNull();
    expect(replay.issued_token).toBeNull();
    expect(replay.customer).toEqual(expect.objectContaining({
      customer_id: first.customer.customer_id,
      contract_id: 'ct_customer_1',
      inbound_token_id: tokenId,
      current_period_end: NOW + 2 * DAY_MS,
      grace_until: NOW + 2 * DAY_MS + DEFAULT_GRACE_MS,
      source_status: 'renewed',
      access_state: 'active',
    }));
    expect(inboundTokenStore.listTokens()).toHaveLength(1);
    expect(contractStore.get(CONTRACT_DEFINITION_SCOPE, ['ct_customer_2'])).toBeNull();

    now = NOW + 10_000;
    const stale = lifecycle.extendCustomer({
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
      current_period_end: NOW + DAY_MS,
      source_status: 'stale_webhook',
    });
    expect(stale.current_period_end).toBe(NOW + 2 * DAY_MS);
    expect(stale.grace_until).toBe(NOW + 2 * DAY_MS + DEFAULT_GRACE_MS);
    expect(stale.source_status).toBe('stale_webhook');

    now = NOW + 15_000;
    const byCustomerId = lifecycle.extendCustomer({
      customer_id: first.customer.customer_id,
      current_period_end: NOW + 3 * DAY_MS,
      source_status: 'id_targeted',
    });
    expect(byCustomerId.current_period_end).toBe(NOW + 3 * DAY_MS);
    expect(byCustomerId.source_status).toBe('id_targeted');
    expect(() =>
      lifecycle.extendCustomer({
        customer_id: first.customer.customer_id,
        door_id: 'other_door',
        current_period_end: NOW + 4 * DAY_MS,
      }),
    ).toThrow(/does not match door_id/);
  });

  it('refuses issue when an existing source-qualified customer would change tiers', () => {
    putTemplate();
    putTemplate('ct_template_pro');
    upsertTier();
    upsertTier({
      tier_id: 'tier_pro',
      entitlement_key: 'pro',
      display_name: 'Pro',
      template_contract_id: 'ct_template_pro',
    });
    issueBasic();

    expect(() =>
      issueBasic({ entitlement_key: 'pro' }),
    ).toThrow(SellerCustomerAccessError);
  });

  it('swaps tier by restamping the same customer contract while preserving the token', () => {
    putTemplate('ct_template_basic', {
      scope: { operation_ids: ['core.basic'] },
      door_types: ['mcp'],
    });
    grantEntryStore.set('ct_template_basic', 'core.basic', true, NOW);
    putTemplate('ct_template_pro', {
      scope: { operation_ids: ['core.pro'] },
      door_types: ['mcp_chat'],
    });
    grantEntryStore.set('ct_template_pro', 'core.pro', true, NOW);
    upsertTier();
    upsertTier({
      tier_id: 'tier_pro',
      entitlement_key: 'pro',
      display_name: 'Pro',
      template_contract_id: 'ct_template_pro',
    });
    const issued = issueBasic();
    const tokenId = issued.issued_token!.record.token_id;
    const secondDoorToken = inboundTokenStore.issueToken({
      value: {
        label: 'Second bound token',
        peer_handle: 'seller:stripe:door_mcp:cus_1:second',
        grants: { 'core.stale': true },
        concurrency_tier: 3,
        chat_mode: null,
        contract_id: issued.customer.contract_id,
      },
      now,
    });
    sellerStore.upsertCustomer({
      customer_id: issued.customer.customer_id,
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
      tier_id: 'tier_basic',
      contract_id: issued.customer.contract_id,
      inbound_token_id: tokenId,
      mcp_token_id: secondDoorToken.record.token_id,
      access_state: 'active',
      now,
    });

    now = NOW + 20_000;
    const swapped = lifecycle.swapCustomerTier({
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
      entitlement_key: 'pro',
      current_period_end: NOW + 3 * DAY_MS,
      source_status: 'upgraded',
    });

    expect(swapped).toEqual(expect.objectContaining({
      tier_id: 'tier_pro',
      contract_id: 'ct_customer_1',
      inbound_token_id: tokenId,
      current_period_end: NOW + 3 * DAY_MS,
      grace_until: NOW + 3 * DAY_MS + DEFAULT_GRACE_MS,
      source_status: 'upgraded',
    }));
    expect(customerDefinition('ct_customer_1')).toEqual(expect.objectContaining({
      minted_at: NOW,
      minted_by: 'seller:test',
      display_name: 'Pro customer cus_1',
      scope: { operation_ids: ['core.pro'] },
      door_types: ['mcp_chat'],
      grant_kind: 'customer_instance',
    }));
    expect(grantEntryStore.listForContract('ct_customer_1')).toEqual([
      { entry_key: 'core.pro', granted: true, set_at: NOW + 20_000 },
    ]);
    expect(inboundTokenStore.getTokenById(tokenId)?.contract_id).toBe('ct_customer_1');
    expect(inboundTokenStore.getTokenById(tokenId)?.grants).toEqual({
      'core.pro': true,
    });
    expect(inboundTokenStore.getTokenById(secondDoorToken.record.token_id)?.grants)
      .toEqual({ 'core.pro': true });
  });

  it('refuses to swap over a revoked customer contract', () => {
    putTemplate('ct_template_basic', {
      scope: { operation_ids: ['core.basic'] },
    });
    grantEntryStore.set('ct_template_basic', 'core.basic', true, NOW);
    putTemplate('ct_template_pro', {
      scope: { operation_ids: ['core.pro'] },
    });
    grantEntryStore.set('ct_template_pro', 'core.pro', true, NOW);
    upsertTier();
    upsertTier({
      tier_id: 'tier_pro',
      entitlement_key: 'pro',
      display_name: 'Pro',
      template_contract_id: 'ct_template_pro',
    });
    const issued = issueBasic();
    const tokenId = issued.issued_token!.record.token_id;
    contractStore.put(CONTRACT_DEFINITION_SCOPE, [issued.customer.contract_id], {
      ...customerDefinition(issued.customer.contract_id),
      revoked_at: NOW + 1,
      revocation_reason: 'owner revoked',
    } satisfies ContractDefinition);

    expect(() => lifecycle.swapCustomerTier({
      customer_id: issued.customer.customer_id,
      entitlement_key: 'pro',
    })).toThrow(/is not active/);
    expect(sellerStore.getCustomer(issued.customer.customer_id)?.tier_id).toBe('tier_basic');
    expect(customerDefinition(issued.customer.contract_id)).toEqual(
      expect.objectContaining({
        revoked_at: NOW + 1,
        revocation_reason: 'owner revoked',
        scope: { operation_ids: ['core.basic'] },
      }),
    );
    expect(inboundTokenStore.getTokenById(tokenId)?.grants).toEqual({
      'core.basic': true,
    });
  });

  it('a swap to the tier already held is a no-op, keeping grace and per-customer grants', () => {
    putTemplate('ct_template_basic', {
      scope: { operation_ids: ['core.basic'] },
    });
    grantEntryStore.set('ct_template_basic', 'core.basic', true, NOW);
    upsertTier();
    const issued = issueBasic();

    // The two things a redundant re-stamp destroys, both set up here and
    // asserted intact below: an owner's per-customer grant edit (D-166
    // `contract.grant.write` is grant_kind-agnostic, so it reaches a customer
    // instance), and a grace period a payment-failure close had opened.
    grantEntryStore.set(issued.customer.contract_id, 'core.custom', true, NOW + 1_000);
    sellerStore.upsertCustomer({
      customer_id: issued.customer.customer_id,
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
      tier_id: 'tier_basic',
      contract_id: issued.customer.contract_id,
      source_status: 'past_due',
      grace_until: NOW + 2 * DAY_MS,
      access_state: 'grace',
      now: NOW + 1_000,
    });

    now = NOW + 20_000;
    const swapped = lifecycle.swapCustomerTier({
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
      entitlement_key: 'basic',
      // A caller reporting live provider state. The op must not let it
      // overwrite the grace the seller's status policy just opened.
      source_status: 'active',
    });

    expect(swapped).toEqual(expect.objectContaining({
      tier_id: 'tier_basic',
      access_state: 'grace',
      grace_until: NOW + 2 * DAY_MS,
      source_status: 'past_due',
    }));
    // ...and that is the stored row, not just a return value.
    expect(sellerStore.getCustomer(issued.customer.customer_id)).toEqual(
      expect.objectContaining({
        tier_id: 'tier_basic',
        access_state: 'grace',
        grace_until: NOW + 2 * DAY_MS,
        source_status: 'past_due',
      }),
    );
    // A re-stamp CLEARS the contract's entries before copying the template's,
    // so the owner's edit is the sharpest witness that none ran.
    expect(grantEntryStore.listForContract(issued.customer.contract_id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entry_key: 'core.custom', granted: true }),
      ]),
    );
  });

  it('keeps the swap guards armed on a same-tier swap', () => {
    putTemplate('ct_template_basic', {
      scope: { operation_ids: ['core.basic'] },
    });
    grantEntryStore.set('ct_template_basic', 'core.basic', true, NOW);
    upsertTier();
    const issued = issueBasic();

    // A tier that is not on this door is still refused, same-key or not.
    expect(() => lifecycle.swapCustomerTier({
      customer_id: issued.customer.customer_id,
      entitlement_key: 'not_a_tier_here',
    })).toThrow(SellerCustomerAccessError);

    lifecycle.closeCustomer({
      customer_id: issued.customer.customer_id,
      reason: 'seller_manual',
    });

    // And a closed customer is still refused — the no-op returns early only
    // AFTER the fences, never instead of them.
    expect(() => lifecycle.swapCustomerTier({
      customer_id: issued.customer.customer_id,
      entitlement_key: 'basic',
    })).toThrow(/cannot modify closed customer/);
  });

  /** ⛔⛔ ROTATION MINTS A FRESH CONTRACT — it used to reuse the customer's.
   *  Reuse made contract:token 1:many, which left per-token `revoked_at` as the
   *  only way to kill the OLD bearer without killing the contract the NEW one
   *  needs. 1:1 is what lets revocation live on the contract alone. */
  it('reissues a fresh customer token against a ROTATED customer contract', () => {
    putTemplate('ct_template_basic', {
      scope: { operation_ids: ['core.current'] },
      door_types: ['mcp'],
    });
    grantEntryStore.set('ct_template_basic', 'core.current', true, NOW);
    grantEntryStore.set('ct_template_basic', 'core.disabled', false, NOW);
    upsertTier();
    const issued = issueBasic({
      email: 'buyer@example.com',
    });
    const oldTokenId = issued.issued_token!.record.token_id;
    const oldBearer = issued.issued_token!.bearer_plaintext;
    const oldClaimSecret = issued.issued_claim!.claim_secret;
    inboundTokenStore.updateTokenGrants({
      token_id: oldTokenId,
      grants: { 'legacy.token.only': true },
      now,
    });
    expect(inboundTokenStore.getTokenById(oldTokenId)?.grants).toEqual({
      'legacy.token.only': true,
    });
    sellerStore.upsertCustomer({
      customer_id: issued.customer.customer_id,
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
      tier_id: 'tier_basic',
      contract_id: 'ct_customer_1',
      source_status: 'past_due',
      claim_email_sent_at: NOW + 1,
      claim_email_marker: 'claim:old-token',
      access_state: 'grace',
      now: NOW + 1,
    });

    now = NOW + 25_000;
    const reissued = lifecycle.reissueCustomerToken({
      customer_id: issued.customer.customer_id,
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
    });

    expect(reissued.issued_token.record.token_id).not.toBe(oldTokenId);
    expect(reissued.issued_claim).not.toBeNull();
    expect(sellerClaimStore.consume(oldClaimSecret, now)).toEqual({ status: 'revoked' });
    expect(reissued.customer).toEqual(expect.objectContaining({
      customer_id: issued.customer.customer_id,
      lifecycle_source: 'stripe',
      source_customer_id: 'cus_1',
      door_id: 'door_mcp',
      email: 'buyer@example.com',
      tier_id: 'tier_basic',
      inbound_token_id: reissued.issued_token.record.token_id,
      mcp_token_id: reissued.issued_token.record.token_id,
      source_status: 'past_due',
      current_period_end: NOW + DAY_MS,
      grace_until: NOW + DAY_MS + DEFAULT_GRACE_MS,
      claim_email_sent_at: null,
      claim_email_marker: null,
      access_state: 'grace',
    }));
    // ⛔ The customer's contract MOVED, and the old one is dead. That — not a
    // per-token stamp — is what kills the old bearer now.
    expect(reissued.customer.contract_id).not.toBe('ct_customer_1');
    expect(customerDefinition('ct_customer_1').revoked_at).toBeTruthy();
    // …and the old token still points at that dead contract, which is how the
    // transport denies it (`boundContractActive` collapses the allowlist).
    expect(inboundTokenStore.getTokenById(oldTokenId)?.contract_id).toBe('ct_customer_1');
    // ⛔ AND it is still revoked per token — required by the partial unique
    // index `(peer_handle) WHERE revoked_at IS NULL`, which is what enforces
    // "one active token per peer". Without it the replacement cannot be issued.
    expect(inboundTokenStore.getTokenById(oldTokenId)?.revoked_at).toBe(NOW + 25_000);
    expect(inboundTokenStore.verifyBearer({ bearer: oldBearer, now })).toBeNull();

    const newToken = inboundTokenStore.getTokenById(reissued.issued_token.record.token_id);
    expect(newToken).toEqual(expect.objectContaining({
      // ⛔ The ROTATED contract — the replacement never shares the retired one.
      contract_id: reissued.customer.contract_id,
      label: 'Basic customer token',
      peer_handle: 'seller:stripe:door_mcp:cus_1',
      revoked_at: null,
      grants: {
        'core.current': true,
        'core.disabled': false,
      },
    }));
    expect(inboundTokenStore.verifyBearer({
      bearer: reissued.issued_token.bearer_plaintext,
      now,
    })?.contract_id).toBe(reissued.customer.contract_id);
    expect(sellerClaimStore.consume(
      reissued.issued_claim!.claim_secret,
      now,
    )).toEqual({
      status: 'claimed',
      payload: {
        bearer_plaintext: reissued.issued_token.bearer_plaintext,
        mcp_url: 'https://seller.example/mcp',
        llm_gateway_base_url: null,
        llm_gateway_model_alias: null,
      },
    });
    expect(grantEntryStore.listForContract('ct_customer_1')).toEqual([
      { entry_key: 'core.current', granted: true, set_at: NOW },
      { entry_key: 'core.disabled', granted: false, set_at: NOW },
    ]);
    expect(() => lifecycle.reissueCustomerToken({
      customer_id: issued.customer.customer_id,
      token_grants: { attacker: true },
    } as never)).toThrow(/derives token_grants server-side/);
    expect(() => lifecycle.reissueCustomerToken({
      customer_id: issued.customer.customer_id,
      source_status: 'attacker_status',
    } as never)).toThrow(/bearer rotation only/);
  });

  it('bulk adjusts open tier customers from the current template without reopening closed customers', () => {
    putTemplate('ct_template_basic', {
      display_name: 'Basic template v1',
      scope: { operation_ids: ['core.old'] },
      door_types: ['mcp'],
    });
    grantEntryStore.set('ct_template_basic', 'core.old', true, NOW);
    upsertTier();
    const first = issueBasic({
      email: 'buyer@example.com',
      source_status: 'paid',
      current_period_end: NOW + DAY_MS,
    });
    const second = issueBasic({
      source_customer_id: 'cus_2',
      current_period_end: NOW + 2 * DAY_MS,
    });
    const firstTokenId = first.issued_token!.record.token_id;
    const secondTokenId = second.issued_token!.record.token_id;
    sellerStore.upsertCustomer({
      customer_id: first.customer.customer_id,
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
      tier_id: 'tier_basic',
      contract_id: 'ct_customer_1',
      source_status: 'past_due',
      access_state: 'grace',
      now: NOW + 1,
    });

    now = NOW + 5_000;
    lifecycle.closeCustomer({
      customer_id: second.customer.customer_id,
      lifecycle_source: 'stripe',
      reason: 'seller_manual',
      source_status: 'closed_by_owner',
    });

    contractStore.put(CONTRACT_DEFINITION_SCOPE, ['ct_template_basic'], {
      ...customerDefinition('ct_template_basic'),
      display_name: 'Basic template v2',
      scope: { operation_ids: ['core.new'] },
      door_types: ['mcp_chat'],
    } satisfies ContractDefinition);
    grantEntryStore.clear('ct_template_basic', 'core.old');
    grantEntryStore.set('ct_template_basic', 'core.new', true, NOW + 10_000);
    grantEntryStore.set('ct_template_basic', 'core.disabled', false, NOW + 10_000);

    now = NOW + 20_000;
    const adjusted = lifecycle.bulkAdjustTierCustomers({
      lifecycle_source: 'stripe',
      tier_id: 'tier_basic',
    });

    expect(adjusted.tier.tier_id).toBe('tier_basic');
    expect(adjusted.adjusted_customers).toEqual([
      expect.objectContaining({
        customer_id: first.customer.customer_id,
        tier_id: 'tier_basic',
        contract_id: 'ct_customer_1',
        inbound_token_id: firstTokenId,
        email: 'buyer@example.com',
        source_status: 'past_due',
        current_period_end: NOW + DAY_MS,
        access_state: 'grace',
        updated_at: NOW + 20_000,
      }),
    ]);
    expect(adjusted.skipped_closed_customers).toEqual([
      expect.objectContaining({
        customer_id: second.customer.customer_id,
        access_state: 'closed',
      }),
    ]);
    expect(customerDefinition('ct_customer_1')).toEqual(expect.objectContaining({
      contract_id: 'ct_customer_1',
      minted_at: NOW,
      minted_by: 'seller:test',
      display_name: 'Basic customer cus_1',
      scope: { operation_ids: ['core.new'] },
      door_types: ['mcp_chat'],
      grant_kind: 'customer_instance',
    }));
    expect(grantEntryStore.listForContract('ct_customer_1')).toEqual([
      { entry_key: 'core.disabled', granted: false, set_at: NOW + 20_000 },
      { entry_key: 'core.new', granted: true, set_at: NOW + 20_000 },
    ]);
    expect(inboundTokenStore.getTokenById(firstTokenId)?.grants).toEqual({
      'core.disabled': false,
      'core.new': true,
    });
    expect(customerDefinition('ct_customer_2')).toEqual(expect.objectContaining({
      revoked_at: NOW + 5_000,
      revocation_reason: 'seller_manual',
      scope: { operation_ids: ['core.old'] },
    }));
    expect(inboundTokenStore.getTokenById(secondTokenId)).toEqual(
      expect.objectContaining({
        revoked_at: NOW + 5_000,
        grants: { 'core.old': true },
      }),
    );
    expect(() =>
      lifecycle.bulkAdjustTierCustomers({
        lifecycle_source: 'stripe',
        tier_id: 'tier_basic',
        customer_ids: [],
      }),
    ).toThrow(/customer_ids must not be empty/);
  });

  it('bulk adjusts only the selected customers on a tier', () => {
    putTemplate('ct_template_basic', {
      display_name: 'Basic template v1',
      scope: { operation_ids: ['core.old'] },
      door_types: ['mcp'],
    });
    grantEntryStore.set('ct_template_basic', 'core.old', true, NOW);
    upsertTier();
    const first = issueBasic();
    const second = issueBasic({
      source_customer_id: 'cus_2',
      current_period_end: NOW + 2 * DAY_MS,
    });
    const firstTokenId = first.issued_token!.record.token_id;
    const secondTokenId = second.issued_token!.record.token_id;

    contractStore.put(CONTRACT_DEFINITION_SCOPE, ['ct_template_basic'], {
      ...customerDefinition('ct_template_basic'),
      display_name: 'Basic template v2',
      scope: { operation_ids: ['core.new'] },
      door_types: ['mcp_chat'],
    } satisfies ContractDefinition);
    grantEntryStore.clear('ct_template_basic', 'core.old');
    grantEntryStore.set('ct_template_basic', 'core.new', true, NOW + 10_000);

    now = NOW + 20_000;
    const adjusted = lifecycle.bulkAdjustTierCustomers({
      lifecycle_source: 'stripe',
      tier_id: 'tier_basic',
      customer_ids: [first.customer.customer_id],
    });

    expect(
      adjusted.adjusted_customers.map((customer) => customer.customer_id),
    ).toEqual([first.customer.customer_id]);
    expect(adjusted.skipped_closed_customers).toEqual([]);
    expect(customerDefinition('ct_customer_1')).toEqual(expect.objectContaining({
      scope: { operation_ids: ['core.new'] },
      door_types: ['mcp_chat'],
    }));
    expect(grantEntryStore.listForContract('ct_customer_1')).toEqual([
      { entry_key: 'core.new', granted: true, set_at: NOW + 20_000 },
    ]);
    expect(inboundTokenStore.getTokenById(firstTokenId)?.grants).toEqual({
      'core.new': true,
    });
    expect(customerDefinition('ct_customer_2')).toEqual(expect.objectContaining({
      scope: { operation_ids: ['core.old'] },
      door_types: ['mcp'],
    }));
    expect(grantEntryStore.listForContract('ct_customer_2')).toEqual([
      { entry_key: 'core.old', granted: true, set_at: NOW },
    ]);
    expect(inboundTokenStore.getTokenById(secondTokenId)?.grants).toEqual({
      'core.old': true,
    });
  });

  it('closes a customer by revoking every recorded token and the customer instance contract', () => {
    putTemplate();
    putTemplate('ct_template_pro');
    upsertTier();
    upsertTier({
      tier_id: 'tier_pro',
      entitlement_key: 'pro',
      display_name: 'Pro',
      template_contract_id: 'ct_template_pro',
    });
    const issued = issueBasic();
    const tokenId = issued.issued_token!.record.token_id;
    const bearer = issued.issued_token!.bearer_plaintext;
    const claimSecret = issued.issued_claim!.claim_secret;
    const secondDoorToken = inboundTokenStore.issueToken({
      value: {
        label: 'Second bound token',
        peer_handle: 'seller:stripe:door_mcp:cus_1:second',
        grants: { 'core.second': true },
        concurrency_tier: 3,
        chat_mode: null,
        contract_id: issued.customer.contract_id,
      },
      now,
    });
    sellerStore.upsertCustomer({
      customer_id: issued.customer.customer_id,
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
      tier_id: 'tier_basic',
      contract_id: issued.customer.contract_id,
      inbound_token_id: tokenId,
      mcp_token_id: secondDoorToken.record.token_id,
      access_state: 'active',
      now,
    });

    expect(() =>
      lifecycle.closeCustomer({
        lifecycle_source: 'stripe',
        door_id: 'door_mcp',
        source_customer_id: 'cus_1',
        reason: 'paused' as never,
      }),
    ).toThrow(/unknown close reason/);

    now = NOW + 30_000;
    const closed = lifecycle.closeCustomer({
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
      reason: 'cancelled',
      source_status: 'canceled',
    });

    expect(closed.access_state).toBe('closed');
    expect(closed.source_status).toBe('canceled');
    expect(inboundTokenStore.verifyBearer({ bearer, now })).toBeNull();
    expect(inboundTokenStore.verifyBearer({
      bearer: secondDoorToken.bearer_plaintext,
      now,
    })).toBeNull();
    expect(inboundTokenStore.getTokenById(tokenId)).toEqual(expect.objectContaining({
      revoked_at: NOW + 30_000,
      contract_id: 'ct_customer_1',
    }));
    expect(inboundTokenStore.getTokenById(secondDoorToken.record.token_id)).toEqual(
      expect.objectContaining({
        revoked_at: NOW + 30_000,
        contract_id: 'ct_customer_1',
      }),
    );
    expect(sellerClaimStore.consume(claimSecret, now)).toEqual({ status: 'revoked' });
    expect(customerDefinition('ct_customer_1')).toEqual(expect.objectContaining({
      revoked_at: NOW + 30_000,
      revocation_reason: 'cancelled',
    }));

    now = NOW + 40_000;
    lifecycle.closeCustomer({
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
      reason: 'seller_manual',
    });
    expect(inboundTokenStore.getTokenById(tokenId)?.revoked_at).toBe(NOW + 30_000);
    expect(inboundTokenStore.getTokenById(secondDoorToken.record.token_id)?.revoked_at)
      .toBe(NOW + 30_000);
    expect(customerDefinition('ct_customer_1').revoked_at).toBe(NOW + 30_000);

    expect(() =>
      issueBasic({ current_period_end: NOW + 4 * DAY_MS }),
    ).toThrow(/cannot modify closed customer/);
    expect(() =>
      lifecycle.extendCustomer({
        lifecycle_source: 'stripe',
        door_id: 'door_mcp',
        source_customer_id: 'cus_1',
        current_period_end: NOW + 4 * DAY_MS,
      }),
    ).toThrow(/cannot modify closed customer/);
    expect(() =>
      lifecycle.swapCustomerTier({
        lifecycle_source: 'stripe',
        door_id: 'door_mcp',
        source_customer_id: 'cus_1',
        entitlement_key: 'pro',
      }),
    ).toThrow(/cannot modify closed customer/);
    expect(() =>
      lifecycle.reissueCustomerToken({
        lifecycle_source: 'stripe',
        door_id: 'door_mcp',
        source_customer_id: 'cus_1',
      }),
    ).toThrow(/cannot modify closed customer/);
    expect(sellerStore.findCustomerBySource({
      lifecycle_source: 'stripe',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
    })?.access_state).toBe('closed');
  });

  it('applies grace and keep_active policy before any token or contract deactivation', () => {
    putTemplate();
    upsertTier();
    const issued = issueBasic();
    const tokenId = issued.issued_token!.record.token_id;

    now = NOW + 30_000;
    const grace = lifecycle.closeCustomer({
      customer_id: issued.customer.customer_id,
      reason: 'payment_failed',
    });
    expect(grace.access_state).toBe('grace');
    expect(grace.source_status).toBe('payment_failed');
    expect(grace.grace_until).toBe(NOW + DAY_MS + DEFAULT_GRACE_MS);
    expect(inboundTokenStore.getTokenById(tokenId)?.revoked_at).toBeNull();
    expect(customerDefinition(issued.customer.contract_id).revoked_at).toBeUndefined();

    sellerStore.upsertSettings({
      status_policy_json: { cancelled: 'keep_active' },
      now: now + 1,
    });
    const kept = lifecycle.closeCustomer({
      customer_id: issued.customer.customer_id,
      reason: 'cancelled',
      source_status: 'cancelled',
    });
    expect(kept.access_state).toBe('active');
    expect(kept.grace_until).toBeNull();
    expect(inboundTokenStore.getTokenById(tokenId)?.revoked_at).toBeNull();
    expect(customerDefinition(issued.customer.contract_id).revoked_at).toBeUndefined();
  });

  it('lets an explicit close_now override deactivate a normally graceful status', () => {
    putTemplate();
    upsertTier();
    const issued = issueBasic();
    sellerStore.upsertSettings({
      status_policy_json: { 'stripe:past_due': 'close_now' },
      now,
    });

    const closed = lifecycle.closeCustomer({
      customer_id: issued.customer.customer_id,
      reason: 'payment_failed',
      source_status: 'past_due',
    });
    expect(closed.access_state).toBe('closed');
    expect(inboundTokenStore.getTokenById(issued.issued_token!.record.token_id)?.revoked_at)
      .toBe(NOW);
    expect(customerDefinition(issued.customer.contract_id).revoked_at).toBe(NOW);
  });

  it('never resurrects an already closed customer through a later keep_active policy', () => {
    putTemplate();
    upsertTier();
    const issued = issueBasic();
    const closed = lifecycle.closeCustomer({
      customer_id: issued.customer.customer_id,
      reason: 'cancelled',
    });
    sellerStore.upsertSettings({
      status_policy_json: { cancelled: 'keep_active' },
      now: NOW + 1,
    });

    const repeated = lifecycle.closeCustomer({
      customer_id: closed.customer_id,
      reason: 'cancelled',
    });
    expect(repeated.access_state).toBe('closed');
    expect(inboundTokenStore.getTokenById(issued.issued_token!.record.token_id)?.revoked_at)
      .toBe(NOW);
    expect(customerDefinition(issued.customer.contract_id).revoked_at).toBe(NOW);
  });

  it('never injects customer.status from the tier default during issue', () => {
    putTemplate('ct_template_basic', {
      scope: { operation_ids: ['core.business.read'] },
    });
    grantEntryStore.set('ct_template_basic', 'core.business.read', true, NOW);
    upsertTier({ customer_status_enabled_default: true });

    const issued = issueBasic();
    expect(customerDefinition(issued.customer.contract_id).scope.operation_ids).toEqual([
      'core.business.read',
    ]);
    expect(grantEntryStore.get(issued.customer.contract_id, 'core.customer.status'))
      .toBeUndefined();
    expect(issued.issued_token!.record.grants['core.customer.status']).toBeUndefined();
  });

  it('refuses missing or non-customer templates before issuing tokens', () => {
    upsertTier({ template_contract_id: 'ct_missing' });
    expect(() => issueBasic()).toThrow(/template_contract_id 'ct_missing' was not found/);
    expect(inboundTokenStore.listTokens()).toHaveLength(0);

    putTemplate('ct_wrong_kind', { grant_kind: 'standing' });
    upsertTier({
      tier_id: 'tier_wrong',
      entitlement_key: 'wrong',
      template_contract_id: 'ct_wrong_kind',
    });
    expect(() =>
      issueBasic({ entitlement_key: 'wrong' }),
    ).toThrow(/must be a customer_template/);
    expect(inboundTokenStore.listTokens()).toHaveLength(0);
  });

  it.each(['stripe', 'future_provider'] as const)(
    'rejects open-ended %s issue without minting customer state',
    (lifecycle_source) => {
      putTemplate();
      upsertTier({ lifecycle_source });

      expect(() =>
        issueBasic({ lifecycle_source, current_period_end: null }),
      ).toThrow(/current_period_end must be finite for non-manual/);
      expect(() =>
        issueBasic({ lifecycle_source, current_period_end: undefined }),
      ).toThrow(/current_period_end must be finite for non-manual/);
      expect(sellerStore.listCustomers()).toHaveLength(0);
      expect(inboundTokenStore.listTokens()).toHaveLength(0);
      expect(contractStore.get(CONTRACT_DEFINITION_SCOPE, ['ct_customer_1'])).toBeNull();
    },
  );

  it('derives a provider period from tier duration and rejects clearing it', () => {
    putTemplate();
    upsertTier({ pass_duration_seconds: 3600 });

    const issued = issueBasic({ current_period_end: undefined });
    expect(issued.customer.current_period_end).toBe(NOW + 3600 * 1000);
    expect(issued.customer.grace_until).toBe(NOW + 3600 * 1000 + DEFAULT_GRACE_MS);

    expect(() =>
      lifecycle.extendCustomer({
        lifecycle_source: 'stripe',
        door_id: 'door_mcp',
        source_customer_id: 'cus_1',
        current_period_end: null,
      }),
    ).toThrow(/current_period_end must be finite for non-manual/);
    expect(() =>
      issueBasic({ current_period_end: null }),
    ).toThrow(/current_period_end must be finite for non-manual/);
    expect(sellerStore.getCustomer(issued.customer.customer_id)).toEqual(issued.customer);
  });

  it('allows manual customers to issue and extend explicitly open-ended periods', () => {
    putTemplate();
    upsertTier({ lifecycle_source: 'manual' });

    const issued = issueBasic({
      lifecycle_source: 'manual',
      current_period_end: null,
      source_status: 'manual_open',
    });
    expect(issued.customer.current_period_end).toBeNull();
    expect(issued.customer.grace_until).toBeNull();

    const finite = lifecycle.extendCustomer({
      lifecycle_source: 'manual',
      door_id: 'door_mcp',
      source_customer_id: 'cus_1',
      current_period_end: NOW + 2 * DAY_MS,
    });
    expect(finite.current_period_end).toBe(NOW + 2 * DAY_MS);
    const reopened = lifecycle.extendCustomer({
      customer_id: issued.customer.customer_id,
      current_period_end: null,
    });
    expect(reopened.current_period_end).toBeNull();
    expect(reopened.grace_until).toBeNull();
    expect(reopened.access_state).toBe('active');
  });
});
