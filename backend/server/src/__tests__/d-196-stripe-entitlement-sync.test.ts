/** D-196 S4 — Stripe Initialize/Synchronize. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ExecutionSource,
  type IngredientManifest,
} from '@recued/contracts';

import { createInMemoryConnectionOperationProfileStore } from '../connection-operation-profile.js';
import {
  STRIPE_ENTITLEMENT_CATALOG_SLUG,
  STRIPE_ENTITLEMENT_LIST_OPERATION,
  STRIPE_ENTITLEMENT_LIST_OPERATION_ID,
  createSellerStripeEntitlementProvider,
  synchronizeSellerStripeEntitlements,
  type SellerStripeEntitlementProvider,
} from '../seller/stripe-entitlement-sync.js';
import { createContractDefinitionStore } from '../storage/contract-definition-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { createConnectionStore } from '../storage/connection-store.js';
import { createSellerStore, type SellerStore } from '../storage/seller-store.js';

const NOW = 1_900_000_000_000;
const OWNER: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'owner',
  client_token_id: 'client-token',
};

const feature = (
  lookup_key: string,
  overrides: Partial<Record<'id' | 'name' | 'active' | 'livemode', unknown>> = {},
) => ({
  id: `feat_${lookup_key}`,
  lookup_key,
  name: lookup_key.replaceAll('-', ' ').replace(/^./, (value) => value.toUpperCase()),
  active: true,
  livemode: false,
  ...overrides,
});

const provider = (records: readonly unknown[]): SellerStripeEntitlementProvider => ({
  listConnections: () => [{ name: 'stripe-main', display_name: 'Stripe Main' }],
  listFeatures: vi.fn(async () => ({ ok: true as const, records })),
});

let db: Database.Database;
let contractStore: ContractStore;
let sellerStore: SellerStore;
let contractIds: string[];
let tierIds: string[];

const sync = (
  stripeProvider: SellerStripeEntitlementProvider,
  request: {
    connection_name?: string;
    door_id: string;
    door_type: 'mcp' | 'mcp_chat' | 'llm_gateway';
  } = { door_id: 'door-mcp', door_type: 'mcp' },
) => synchronizeSellerStripeEntitlements(
  {
    sellerStore,
    contractStore,
    provider: stripeProvider,
    now: () => NOW,
    newContractId: () => contractIds.shift() ?? 'ct_exhausted',
    newTierId: () => tierIds.shift() ?? 'tier_exhausted',
    mintedBy: 'owner:test',
  },
  request,
  OWNER,
);

beforeEach(() => {
  db = new Database(':memory:');
  contractStore = createContractStore(db, { now: () => NOW });
  sellerStore = createSellerStore(db);
  contractIds = ['ct_stripe_basic', 'ct_stripe_pro', 'ct_stripe_replacement'];
  tierIds = ['tier_stripe_basic', 'tier_stripe_pro', 'tier_stripe_new'];
});

describe('synchronizeSellerStripeEntitlements', () => {
  it('creates one fail-closed template/tier shell per active feature', async () => {
    const stripeProvider = provider([
      feature('pro'),
      feature('basic'),
      feature('archived', { active: false }),
    ]);

    const result = await sync(stripeProvider);

    expect(stripeProvider.listFeatures).toHaveBeenCalledWith({
      connection_name: 'stripe-main',
      execution_source: OWNER,
    });
    expect(result).toEqual({
      connection_name: 'stripe-main',
      features_seen: 2,
      created_tier_ids: ['tier_stripe_basic', 'tier_stripe_pro'],
      preserved_tier_ids: [],
      recreated_template_tier_ids: [],
      reactivated_tier_ids: [],
      orphaned_tier_ids: [],
    });

    const tiers = sellerStore.listTiers({ lifecycle_source: 'stripe' });
    expect(tiers.map((tier) => [
      tier.entitlement_key,
      tier.display_name,
      tier.external_entitlement_id,
      tier.active,
    ])).toEqual([
      ['basic', 'Basic', 'feat_basic', true],
      ['pro', 'Pro', 'feat_pro', true],
    ]);
    const definitions = createContractDefinitionStore(contractStore);
    const grants = createContractGrantEntryStore(contractStore);
    for (const tier of tiers) {
      expect(definitions.get(tier.template_contract_id)).toMatchObject({
        contract_id: tier.template_contract_id,
        minted_by: 'owner:test',
        grant_kind: 'customer_template',
        scope: { operation_ids: [] },
        door_types: ['mcp'],
      });
      expect(grants.listForContract(tier.template_contract_id)).toEqual([]);
    }
  });

  it('preserves authored authority, recreates a deleted template, and orphan-flags removals', async () => {
    await sync(provider([feature('basic'), feature('pro')]));
    const basic = sellerStore.findTier({
      door_id: 'door-mcp',
      lifecycle_source: 'stripe',
      entitlement_key: 'basic',
    })!;
    const pro = sellerStore.findTier({
      door_id: 'door-mcp',
      lifecycle_source: 'stripe',
      entitlement_key: 'pro',
    })!;
    const definitions = createContractDefinitionStore(contractStore);
    const basicTemplate = definitions.get(basic.template_contract_id)!;
    contractStore.put('contract_definition', [basic.template_contract_id], {
      ...basicTemplate,
      display_name: 'Owner-authored Basic template',
      scope: { operation_ids: ['recued-core.some-pack.read'] },
    });
    createContractGrantEntryStore(contractStore).set(
      basic.template_contract_id,
      'recued-core.some-pack.read',
      true,
      NOW,
    );
    sellerStore.upsertTier({
      tier_id: basic.tier_id,
      door_id: basic.door_id,
      lifecycle_source: 'stripe',
      entitlement_key: basic.entitlement_key,
      display_name: 'Owner Basic',
      usage_policy_json: { tool_call: { period_limit: 500 } },
      pass_duration_seconds: 86_400,
      customer_status_enabled_default: true,
      now: NOW,
    });
    expect(contractStore.delete('contract_definition', [pro.template_contract_id])).toBe(true);

    contractIds = ['ct_stripe_pro_recreated'];
    tierIds = [];
    const result = await sync(provider([
      feature('basic', { id: 'feat_basic_v2', name: 'Provider-renamed Basic' }),
      feature('pro'),
    ]));

    expect(result).toMatchObject({
      created_tier_ids: [],
      preserved_tier_ids: [basic.tier_id, pro.tier_id],
      recreated_template_tier_ids: [pro.tier_id],
      orphaned_tier_ids: [],
    });
    const basicAfter = sellerStore.getTier(basic.tier_id)!;
    expect(basicAfter).toMatchObject({
      display_name: 'Owner Basic',
      template_contract_id: basic.template_contract_id,
      external_entitlement_id: 'feat_basic_v2',
      usage_policy_json: { tool_call: { period_limit: 500 } },
      pass_duration_seconds: 86_400,
      customer_status_enabled_default: true,
    });
    expect(definitions.get(basic.template_contract_id)).toEqual({
      ...basicTemplate,
      display_name: 'Owner-authored Basic template',
      scope: { operation_ids: ['recued-core.some-pack.read'] },
    });
    expect(createContractGrantEntryStore(contractStore).get(
      basic.template_contract_id,
      'recued-core.some-pack.read',
    )).toBe(true);
    expect(sellerStore.getTier(pro.tier_id)?.template_contract_id)
      .toBe('ct_stripe_pro_recreated');

    const orphaned = await sync(provider([feature('basic')]));
    expect(orphaned.orphaned_tier_ids).toEqual([pro.tier_id]);
    expect(sellerStore.getTier(pro.tier_id)?.active).toBe(false);
    expect(definitions.get('ct_stripe_pro_recreated')).not.toBeNull();
  });

  it('reactivates a returned entitlement without changing its recreated template', async () => {
    await sync(provider([feature('basic'), feature('pro')]));
    await sync(provider([feature('basic')]));
    const pro = sellerStore.findTier({
      door_id: 'door-mcp',
      lifecycle_source: 'stripe',
      entitlement_key: 'pro',
    })!;
    const templateId = pro.template_contract_id;

    const result = await sync(provider([feature('basic'), feature('pro')]));

    expect(result.reactivated_tier_ids).toEqual([pro.tier_id]);
    expect(sellerStore.getTier(pro.tier_id)).toMatchObject({
      active: true,
      template_contract_id: templateId,
    });
  });

  it('fails before mutation on ambiguous connections or malformed provider identity', async () => {
    const ambiguous: SellerStripeEntitlementProvider = {
      listConnections: () => [
        { name: 'stripe-a', display_name: 'A' },
        { name: 'stripe-b', display_name: 'B' },
      ],
      listFeatures: vi.fn(),
    };
    await expect(sync(ambiguous)).rejects.toMatchObject({ kind: 'bad_request' });
    expect(ambiguous.listFeatures).not.toHaveBeenCalled();

    await expect(sync(provider([
      feature('basic'),
      feature('basic', { id: 'feat_duplicate' }),
    ]))).rejects.toMatchObject({ kind: 'upstream' });
    expect(sellerStore.listTiers()).toEqual([]);
    expect(createContractDefinitionStore(contractStore).list()).toEqual([]);
  });

  it('propagates a gated provider refusal without writing local shells', async () => {
    const denied: SellerStripeEntitlementProvider = {
      listConnections: () => [{ name: 'stripe-main', display_name: 'Stripe' }],
      listFeatures: vi.fn(async () => ({
        ok: false as const,
        kind: 'policy' as const,
        reason: 'operation not granted',
      })),
    };

    await expect(sync(denied)).rejects.toMatchObject({ kind: 'policy' });
    expect(sellerStore.listTiers()).toEqual([]);
    expect(createContractDefinitionStore(contractStore).list()).toEqual([]);
  });

  it('rolls back earlier feature shells when a later tier has conflicting authority', async () => {
    contractStore.put('contract_definition', ['ct_wrong_kind'], {
      contract_id: 'ct_wrong_kind',
      minted_at: NOW,
      minted_by: 'owner:test',
      display_name: 'Standing contract',
      scope: { operation_ids: ['core.some-op'] },
    });
    sellerStore.upsertTier({
      tier_id: 'tier_stripe_pro_existing',
      door_id: 'door-mcp',
      lifecycle_source: 'stripe',
      entitlement_key: 'pro',
      display_name: 'Pro',
      template_contract_id: 'ct_wrong_kind',
      active: true,
      now: NOW,
    });
    contractIds = ['ct_basic_would_be_created'];
    tierIds = ['tier_basic_would_be_created'];

    await expect(sync(provider([feature('basic'), feature('pro')])))
      .rejects.toMatchObject({ kind: 'conflict' });

    expect(sellerStore.findTier({
      door_id: 'door-mcp',
      lifecycle_source: 'stripe',
      entitlement_key: 'basic',
    })).toBeNull();
    expect(contractStore.get(
      'contract_definition',
      ['ct_basic_would_be_created'],
    )).toBeNull();
    expect(sellerStore.getTier('tier_stripe_pro_existing')?.template_contract_id)
      .toBe('ct_wrong_kind');
  });

  it('rejects a generated template id collision without overwriting its contract', async () => {
    const existing = {
      contract_id: 'ct_collision',
      minted_at: NOW - 1,
      minted_by: 'owner:test',
      display_name: 'Existing owner contract',
      scope: { operation_ids: ['core.existing'] },
    };
    contractStore.put('contract_definition', [existing.contract_id], existing);
    contractIds = [existing.contract_id];

    await expect(sync(provider([feature('basic')])))
      .rejects.toMatchObject({ kind: 'conflict' });

    expect(contractStore.get('contract_definition', [existing.contract_id])?.value)
      .toEqual(existing);
    expect(sellerStore.listTiers()).toEqual([]);
  });

  it('rejects a generated template id with dangling grant authority', async () => {
    createContractGrantEntryStore(contractStore).set(
      'ct_dangling_grant',
      'recued-core.some-pack.read',
      true,
      NOW,
    );
    contractIds = ['ct_dangling_grant'];

    await expect(sync(provider([feature('basic')])))
      .rejects.toMatchObject({ kind: 'conflict' });

    expect(contractStore.get(
      'contract_definition',
      ['ct_dangling_grant'],
    )).toBeNull();
    expect(createContractGrantEntryStore(contractStore).get(
      'ct_dangling_grant',
      'recued-core.some-pack.read',
    )).toBe(true);
    expect(sellerStore.listTiers()).toEqual([]);
  });
});

describe('createSellerStripeEntitlementProvider', () => {
  it('lists only connections granted the canonical entitlement operation', () => {
    const connections = createConnectionStore(db);
    connections.upsert({
      kind: 'api',
      name: 'stripe-not-granted',
      display_name: 'Stripe Not Granted',
      config_json: JSON.stringify({ vendor: 'stripe' }),
      auth_ciphertext: 'ciphertext',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const profiles = createInMemoryConnectionOperationProfileStore({
      'stripe-not-granted': {
        catalog_slug: STRIPE_ENTITLEMENT_CATALOG_SLUG,
        allowed_operations: [],
      },
    });
    const manifest = {
      operations: {
        [STRIPE_ENTITLEMENT_LIST_OPERATION]: {
          operation_id: STRIPE_ENTITLEMENT_LIST_OPERATION_ID,
        },
      },
    } as unknown as IngredientManifest;

    const stripeProvider = createSellerStripeEntitlementProvider({
      executorConfig: { manifests: { get: () => manifest } } as never,
      connectionOperationProfiles: profiles,
      connectionStore: connections,
    })!;

    expect(stripeProvider.listConnections()).toEqual([]);
  });

  it('pins the canonical catalog operation and requires a complete paginated walk', async () => {
    const connections = createConnectionStore(db);
    connections.upsert({
      kind: 'api',
      name: 'stripe-main',
      display_name: 'Stripe Main',
      config_json: JSON.stringify({ vendor: 'stripe' }),
      auth_ciphertext: 'ciphertext',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const profiles = createInMemoryConnectionOperationProfileStore({
      'stripe-main': {
        catalog_slug: STRIPE_ENTITLEMENT_CATALOG_SLUG,
        allowed_operations: [STRIPE_ENTITLEMENT_LIST_OPERATION],
      },
    });
    const manifest = {
      schema_version: 1,
      slug: STRIPE_ENTITLEMENT_CATALOG_SLUG,
      kind: 'connection',
      auth: { type: 'basic', connection: 'stripe' },
      operations: {
        [STRIPE_ENTITLEMENT_LIST_OPERATION]: {
          operation_id: STRIPE_ENTITLEMENT_LIST_OPERATION_ID,
          risk_tier: 'read',
          approval: 'never',
        },
      },
    } as unknown as IngredientManifest;
    const runOperation = vi.fn(async (_deps, request) => ({
      ok: true as const,
      raw: { result: { data: [feature('basic')] } },
      audit: {
        ingredient_id: STRIPE_ENTITLEMENT_CATALOG_SLUG,
        operation_id: STRIPE_ENTITLEMENT_LIST_OPERATION_ID,
        operation_group: null,
        connection_name: request.connection_name,
        risk_tier: 'read' as const,
        approval: 'never' as const,
        outcome: 'success' as const,
        pages_fetched: 2,
      },
    }));
    const stripeProvider = createSellerStripeEntitlementProvider(
      {
        executorConfig: {
          manifests: { get: () => manifest },
        } as never,
        connectionOperationProfiles: profiles,
        connectionStore: connections,
      },
      runOperation,
    )!;

    expect(stripeProvider.listConnections()).toEqual([
      { name: 'stripe-main', display_name: 'Stripe Main' },
    ]);
    const result = await stripeProvider.listFeatures({
      connection_name: 'stripe-main',
      execution_source: OWNER,
    });

    expect(result).toEqual({ ok: true, records: [feature('basic')] });
    expect(runOperation).toHaveBeenCalledWith(
      expect.objectContaining({ profiles }),
      expect.objectContaining({
        connection_name: 'stripe-main',
        catalogSlug: STRIPE_ENTITLEMENT_CATALOG_SLUG,
        operationKey: STRIPE_ENTITLEMENT_LIST_OPERATION,
        args: {},
        execution_source: OWNER,
        trigger_source: 'manual',
      }),
    );
  });

  it('rejects a successful but unproven or truncated provider walk', async () => {
    const connections = createConnectionStore(db);
    connections.upsert({
      kind: 'api',
      name: 'stripe-main',
      display_name: 'Stripe Main',
      config_json: JSON.stringify({ vendor: 'stripe' }),
      auth_ciphertext: 'ciphertext',
      enrolled_at: NOW,
      updated_at: NOW,
    });
    const profiles = createInMemoryConnectionOperationProfileStore({
      'stripe-main': {
        catalog_slug: STRIPE_ENTITLEMENT_CATALOG_SLUG,
        allowed_operations: [STRIPE_ENTITLEMENT_LIST_OPERATION],
      },
    });
    const manifest = {
      operations: {
        [STRIPE_ENTITLEMENT_LIST_OPERATION]: {
          operation_id: STRIPE_ENTITLEMENT_LIST_OPERATION_ID,
        },
      },
    } as unknown as IngredientManifest;
    const runOperation = vi.fn(async () => ({
      ok: true as const,
      raw: { result: { data: [feature('basic')] } },
      audit: {
        ingredient_id: STRIPE_ENTITLEMENT_CATALOG_SLUG,
        operation_id: STRIPE_ENTITLEMENT_LIST_OPERATION_ID,
        operation_group: null,
        connection_name: 'stripe-main',
        risk_tier: 'read' as const,
        approval: 'never' as const,
        outcome: 'success' as const,
        pages_fetched: 1,
        truncated: true,
      },
    }));
    const stripeProvider = createSellerStripeEntitlementProvider(
      {
        executorConfig: { manifests: { get: () => manifest } } as never,
        connectionOperationProfiles: profiles,
        connectionStore: connections,
      },
      runOperation,
    )!;

    await expect(stripeProvider.listFeatures({
      connection_name: 'stripe-main',
      execution_source: OWNER,
    })).resolves.toMatchObject({ ok: false, kind: 'upstream' });
  });
});
