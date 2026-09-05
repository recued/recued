/** D-196 consolidation (2026-09-03) — the ONE tier seed, all three providers.
 *
 *  `provider-tier-sync.ts` replaced two parallel stacks (the Stripe
 *  entitlement sync and a Paddle / Lemon Squeezy product sync). This suite
 *  drives the shared fold with each provider's row — Stripe keyed on the
 *  feature `lookup_key`, the others on the product id — and the gateway half
 *  with a stubbed `runOperation`: the look-alike op-id pin, the owner as
 *  execution source, and the two completeness proofs (Stripe's gateway walk
 *  audit; the page ceiling for the catalogs that return no page envelope).
 *  `d-196-stripe-entitlement-sync.test.ts` keeps driving the shipped Stripe
 *  rpc through its adapter, so the fold's older behaviour is pinned twice. */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SELLER_PROVIDERS, sellerProviderFor, type ExecutionSource } from '@recued/contracts';

import {
  createSellerProviderTierProvider,
  synchronizeSellerProviderTiers,
  tierSeedOperationId,
  type SellerProviderTierProvider,
} from '../seller/provider-tier-sync.js';
import { createContractStore, type ContractStore } from '../storage/contract-store.js';
import { createSellerStore, type SellerStore } from '../storage/seller-store.js';

const NOW = 1_900_000_000_000;
const OWNER: ExecutionSource = {
  channel: 'user',
  actor: 'user_self',
  user_id: 'owner',
  client_token_id: 'client-token',
};

const feature = (lookup_key: string, name: string, active = true) => ({ id: `feat_${lookup_key}`, lookup_key, name, active, livemode: false });
const paddleProduct = (id: string, name: string, status = 'active') => ({ id, name, status, tax_category: 'standard' });
const lsProduct = (id: string, name: string, status = 'published') => ({
  type: 'products', id, attributes: { store_id: 4242, name, status, price: 2900 },
});

const seam = (records: Partial<Record<string, readonly unknown[]>>): SellerProviderTierProvider => ({
  listConnections: (p) => [{ name: `${p}-main`, display_name: `${p} main` }],
  listRecords: vi.fn(async (input) => ({ ok: true as const, records: records[input.provider] ?? [] })),
});

let db: Database.Database;
let contractStore: ContractStore;
let sellerStore: SellerStore;
let contractIds: string[];
let tierIds: string[];

const sync = (
  provider: SellerProviderTierProvider,
  request: Parameters<typeof synchronizeSellerProviderTiers>[1],
) => synchronizeSellerProviderTiers(
  {
    sellerStore,
    contractStore,
    provider,
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
  contractIds = ['ct_1', 'ct_2', 'ct_3'];
  tierIds = ['tier_1', 'tier_2', 'tier_3'];
});

describe('synchronizeSellerProviderTiers — one fold, three identities', () => {
  it('Stripe: one tier per ACTIVE entitlement feature, keyed on lookup_key, sorted', async () => {
    const p = seam({ stripe: [feature('pro', 'Pro'), feature('basic', 'Basic'), feature('archived', 'Old', false)] });
    const result = await sync(p, { provider: 'stripe', door_id: 'door-mcp', door_type: 'mcp' });
    expect(p.listRecords).toHaveBeenCalledWith({ provider: 'stripe', connection_name: 'stripe-main', execution_source: OWNER });
    expect(result).toEqual({
      provider: 'stripe', connection_name: 'stripe-main', records_seen: 2,
      created_tier_ids: ['tier_1', 'tier_2'], preserved_tier_ids: [], recreated_template_tier_ids: [], reactivated_tier_ids: [], orphaned_tier_ids: [],
    });
    expect(sellerStore.listTiers({ lifecycle_source: 'stripe' }).map((t) => [t.entitlement_key, t.display_name, t.external_entitlement_id]))
      .toEqual([['basic', 'Basic', 'feat_basic'], ['pro', 'Pro', 'feat_pro']]);
    // A feature with malformed flags is a shape we cannot vouch for, not one to skip.
    await expect(sync(seam({ stripe: [{ id: 'feat_x', lookup_key: 'x', name: 'X', active: 'yes', livemode: false }] }), { provider: 'stripe', door_id: 'door-mcp', door_type: 'mcp' }))
      .rejects.toMatchObject({ kind: 'upstream' });
  });

  it('Paddle: one tier per ACTIVE product keyed on the product id; archived skipped', async () => {
    const p = seam({ paddle: [paddleProduct('pro_02team', 'Team'), paddleProduct('pro_01basic', 'Basic'), paddleProduct('pro_03old', 'Old', 'archived')] });
    const result = await sync(p, { provider: 'paddle', door_id: 'door-mcp', door_type: 'mcp' });
    expect(result).toMatchObject({ provider: 'paddle', records_seen: 2, created_tier_ids: ['tier_1', 'tier_2'] });
    expect(sellerStore.listTiers({ lifecycle_source: 'paddle' }).map((t) => [t.tier_id, t.entitlement_key, t.display_name, t.external_entitlement_id]))
      .toEqual([['tier_1', 'pro_01basic', 'Basic', 'pro_01basic'], ['tier_2', 'pro_02team', 'Team', 'pro_02team']]);
    expect(sellerStore.listTiers({ lifecycle_source: 'stripe' })).toEqual([]);
  });

  it('Lemon Squeezy: needs the store id, keys tiers on the numeric product id, skips drafts', async () => {
    const p = seam({ lemonsqueezy: [lsProduct('3002', 'Team'), lsProduct('3001', 'Basic'), lsProduct('3003', 'Draft', 'draft')] });
    await expect(sync(p, { provider: 'lemonsqueezy', door_id: 'door-mcp', door_type: 'mcp' })).rejects.toMatchObject({ kind: 'bad_request' });
    const result = await sync(p, { provider: 'lemonsqueezy', door_id: 'door-mcp', door_type: 'mcp', store_id: '4242' });
    expect(p.listRecords).toHaveBeenCalledWith({ provider: 'lemonsqueezy', connection_name: 'lemonsqueezy-main', store_id: '4242', execution_source: OWNER });
    expect(result).toMatchObject({ provider: 'lemonsqueezy', records_seen: 2, created_tier_ids: ['tier_1', 'tier_2'] });
    expect(sellerStore.listTiers({ lifecycle_source: 'lemonsqueezy' }).map((t) => t.entitlement_key)).toEqual(['3001', '3002']);
    // A store id is not a Stripe or Paddle concept.
    await expect(sync(p, { provider: 'paddle', door_id: 'door-mcp', door_type: 'mcp', store_id: '4242' })).rejects.toMatchObject({ kind: 'bad_request' });
  });

  it('re-running preserves, orphan-flags a vanished identity, and reactivates it when it returns — per provider, never across', async () => {
    const both = seam({ paddle: [paddleProduct('pro_01basic', 'Basic'), paddleProduct('pro_02team', 'Team')], stripe: [feature('basic', 'Basic')] });
    await sync(both, { provider: 'paddle', door_id: 'door-mcp', door_type: 'mcp' });
    await sync(both, { provider: 'stripe', door_id: 'door-mcp', door_type: 'mcp' });

    const onlyBasic = seam({ paddle: [paddleProduct('pro_01basic', 'Basic')] });
    const second = await sync(onlyBasic, { provider: 'paddle', door_id: 'door-mcp', door_type: 'mcp' });
    expect(second).toMatchObject({ preserved_tier_ids: ['tier_1'], orphaned_tier_ids: ['tier_2'], created_tier_ids: [] });
    expect(sellerStore.getTier('tier_2')?.active).toBe(false);
    // The Stripe tier on the same door is another provider's and is untouched.
    expect(sellerStore.getTier('tier_3')?.active).toBe(true);

    const third = await sync(both, { provider: 'paddle', door_id: 'door-mcp', door_type: 'mcp' });
    expect(third).toMatchObject({ preserved_tier_ids: ['tier_1', 'tier_2'], reactivated_tier_ids: ['tier_2'], orphaned_tier_ids: [] });
  });

  it('refuses an unknown provider, a malformed identity, and a duplicate', async () => {
    await expect(sync(seam({}), { provider: 'manual' as never, door_id: 'door-mcp', door_type: 'mcp' })).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(sync(seam({ paddle: [{ id: 'not_a_product', name: 'x', status: 'active' }] }), { provider: 'paddle', door_id: 'door-mcp', door_type: 'mcp' })).rejects.toMatchObject({ kind: 'upstream' });
    await expect(sync(seam({ paddle: [paddleProduct('pro_01', 'A'), paddleProduct('pro_01', 'B')] }), { provider: 'paddle', door_id: 'door-mcp', door_type: 'mcp' })).rejects.toMatchObject({ kind: 'upstream' });
    await expect(sync(seam({ stripe: [feature('a', 'A'), feature('a', 'B')] }), { provider: 'stripe', door_id: 'door-mcp', door_type: 'mcp' })).rejects.toMatchObject({ kind: 'upstream' });
  });
});

describe('createSellerProviderTierProvider — the gateway half', () => {
  const row = (name: string, vendor: string) => ({ name, display_name: name, config_json: JSON.stringify({ vendor }), subresource_path: undefined });
  const ROWS = [row('stripe-main', 'stripe'), row('paddle-main', 'paddle'), row('ls-main', 'lemonsqueezy')];
  const catalogOf = (name: string): string => sellerProviderFor(name.startsWith('stripe') ? 'stripe' : name.startsWith('paddle') ? 'paddle' : 'lemonsqueezy').catalog_slug;

  const build = (over: { records?: unknown[]; ok?: boolean; audit?: Record<string, unknown> | null; pinMismatch?: boolean } = {}) => {
    const runOperation = vi.fn(async (_deps: unknown, _request: unknown) => over.ok === false
      ? ({ ok: false, kind: 'policy', reason: 'denied' } as const)
      : ({
          ok: true,
          raw: { result: { data: over.records ?? [feature('basic', 'Basic')] } },
          ...(over.audit === null ? {} : { audit: { pages_fetched: 1, truncated: false, ...over.audit } }),
        } as const));
    const created = createSellerProviderTierProvider({
      executorConfig: {
        manifests: { get: (slug: string) => {
          const spec = SELLER_PROVIDERS.find((s) => s.catalog_slug === slug);
          if (!spec) return null;
          return { operations: { [spec.tier_seed_operation]: { operation_id: over.pinMismatch ? 'recued-core/look-alike.op' : tierSeedOperationId(spec) } } };
        } },
      } as never,
      connectionOperationProfiles: {
        get: (name: string) => ({ catalog_slug: catalogOf(name), allowed_operations: [sellerProviderFor(name.startsWith('stripe') ? 'stripe' : name.startsWith('paddle') ? 'paddle' : 'lemonsqueezy').tier_seed_operation] }),
      } as never,
      connectionStore: {
        get: (_kind: 'api', name: string) => ROWS.find((r) => r.name === name) ?? null,
        list: () => ROWS,
      } as never,
    } as never, runOperation as never);
    if (!created) throw new Error('provider seam unavailable');
    return { seam: created, runOperation };
  };

  it('lists only connections of the provider\'s vendor bound to its seller catalog with the seed read granted', () => {
    const { seam: s } = build();
    expect(s.listConnections('stripe')).toEqual([{ name: 'stripe-main', display_name: 'stripe-main' }]);
    expect(s.listConnections('paddle')).toEqual([{ name: 'paddle-main', display_name: 'paddle-main' }]);
    expect(s.listConnections('lemonsqueezy')).toEqual([{ name: 'ls-main', display_name: 'ls-main' }]);
    // A look-alike catalog compiling to another op id is not the authority.
    expect(build({ pinMismatch: true }).seam.listConnections('stripe')).toEqual([]);
  });

  it('reads through the provider\'s own seller catalog with the owner as execution source', async () => {
    const { seam: s, runOperation } = build();
    await s.listRecords({ provider: 'stripe', connection_name: 'stripe-main', execution_source: OWNER });
    expect(runOperation.mock.calls[0]![1]).toMatchObject({
      catalogSlug: 'seller-stripe', operationKey: 'entitlement_feature.search', args: {}, execution_source: OWNER, trigger_source: 'manual',
    });
    await s.listRecords({ provider: 'paddle', connection_name: 'paddle-main', execution_source: OWNER });
    expect(runOperation.mock.calls[1]![1]).toMatchObject({
      catalogSlug: 'seller-paddle', operationKey: 'product.search', args: { 'query.status': 'active', 'query.per_page': 200 },
    });
    await s.listRecords({ provider: 'lemonsqueezy', connection_name: 'ls-main', store_id: '4242', execution_source: OWNER });
    expect(runOperation.mock.calls[2]![1]).toMatchObject({
      catalogSlug: 'seller-lemonsqueezy', args: { 'query.filter[store_id]': '4242', 'query.page[size]': 100 },
    });
  });

  it('proves completeness per provider: Stripe by the gateway walk audit, the others by the page ceiling', async () => {
    const walked = build({ audit: { pages_fetched: 2 } });
    expect(await walked.seam.listRecords({ provider: 'stripe', connection_name: 'stripe-main', execution_source: OWNER }))
      .toEqual({ ok: true, records: [feature('basic', 'Basic')] });
    const unproven = build({ audit: null });
    expect(await unproven.seam.listRecords({ provider: 'stripe', connection_name: 'stripe-main', execution_source: OWNER }))
      .toMatchObject({ ok: false, kind: 'upstream' });
    const truncated = build({ audit: { pages_fetched: 1, truncated: true } });
    expect(await truncated.seam.listRecords({ provider: 'stripe', connection_name: 'stripe-main', execution_source: OWNER }))
      .toMatchObject({ ok: false, kind: 'upstream' });

    const atCeiling = build({ records: Array.from({ length: 200 }, (_, i) => paddleProduct(`pro_${i}`, `P${i}`)) });
    expect(await atCeiling.seam.listRecords({ provider: 'paddle', connection_name: 'paddle-main', execution_source: OWNER }))
      .toMatchObject({ ok: false, kind: 'upstream' });
    const underCeiling = build({ records: [paddleProduct('pro_1', 'P1')] });
    expect(await underCeiling.seam.listRecords({ provider: 'paddle', connection_name: 'paddle-main', execution_source: OWNER }))
      .toEqual({ ok: true, records: [paddleProduct('pro_1', 'P1')] });
  });

  it('maps a gateway policy refusal and a wrong-vendor connection to their kinds', async () => {
    expect(await build({ ok: false }).seam.listRecords({ provider: 'paddle', connection_name: 'paddle-main', execution_source: OWNER }))
      .toMatchObject({ ok: false, kind: 'policy' });
    expect(await build().seam.listRecords({ provider: 'paddle', connection_name: 'ls-main', execution_source: OWNER }))
      .toMatchObject({ ok: false, kind: 'not_configured' });
  });
});
