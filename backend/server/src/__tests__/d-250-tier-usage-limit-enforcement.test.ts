/** D-250 § D — the subscription limit holds AT THE DOOR, and a synced tier can
 *  be limited at all.
 *
 *  ⛔ WHY THIS EXISTS. The usage gate is well covered in isolation — 19 unit
 *  tests across `customer-usage-policy` and `customer-surface-usage` — and the
 *  llm_gateway door has its own denial test ("denies seller customers at the
 *  chat_turn usage gate before provider work"). The MCP door had neither: its
 *  `tool_call` refusal existed only as unit assertions on the session, and
 *  nothing drove a call THROUGH the door to a denial. A boundary is covered
 *  only by a test that goes through it.
 *  ⇒ [[feedback_verify_composition_not_definition]]
 *
 *  ⛔⛔ AND THE SECOND HALF IS THE ONE THE AUDIT FOUND. An absent policy means
 *  UNLIMITED, `stripe-entitlement-sync` mints tiers with `usage_policy_json:
 *  {}` and `active: true`, and `upsertSellerManualTier` stamps
 *  `lifecycle_source: 'manual'` — which `upsertTier` REFUSES against a stored
 *  `stripe` tier. So the tiers that were unlimited by construction were exactly
 *  the tiers no rpc could reach. `setTierUsagePolicy` is the narrow path that
 *  reaches them, and § 2 proves it does.
 *
 *  ⚠ The default is UNCHANGED and deliberate (owner ruling): absent stays
 *  unlimited. What changed is that it is now reachable and visible, not that it
 *  is safer by default. § 1's first test pins the default so a future "safer"
 *  edit has to be a decision rather than a drift.
 */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RecipeDefinition, IngredientManifest, SellerTier } from '@recued/contracts';

import { createSellerStore, type SellerStore } from '../storage/seller-store.js';
import {
  createSellerCustomerUsageGate,
  resolveSellerCustomerUsagePolicy,
} from '../seller/customer-usage-policy.js';
import {
  createCustomerSurfaceUsagePendingCoordinator,
  createCustomerSurfaceUsageSession,
} from '../seller/customer-surface-usage.js';
import { setSellerTierUsagePolicy } from '../seller-overview-handler.js';
import { createManifestRegistry } from '../manifest-loader.js';
import { createRecipeStore } from '../recipe-store.js';
import { handleExecute, type ExecuteHandlerDeps } from '../execute-handler.js';

const DOOR = 'door_1';
const NOW = Date.UTC(2026, 7, 24, 12);

let db: Database.Database;
let store: SellerStore;

const seedTier = (
  lifecycle_source: 'manual' | 'stripe',
  usage_policy_json: Record<string, unknown>,
): SellerTier => store.upsertTier({
  tier_id: `tier_${lifecycle_source}`,
  door_id: DOOR,
  lifecycle_source,
  entitlement_key: `ent_${lifecycle_source}`,
  display_name: `${lifecycle_source} tier`,
  template_contract_id: `ctr_tpl_${lifecycle_source}`,
  usage_policy_json,
  active: true,
  now: NOW,
});

const seedCustomer = (tier: SellerTier) => store.upsertCustomer({
  customer_id: `cus_${tier.tier_id}`,
  door_id: DOOR,
  tier_id: tier.tier_id,
  lifecycle_source: tier.lifecycle_source,
  source_customer_id: `src_${tier.tier_id}`,
  contract_id: `ctr_${tier.tier_id}`,
  access_state: 'active',
  current_period_end: NOW + 86_400_000,
  now: NOW,
});

beforeEach(() => {
  db = new Database(':memory:');
  store = createSellerStore(db);
});

// ────────────────────────────────────────────────────────────────
// 1. THE DEFAULT — absent means unlimited, on purpose
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — an absent policy is UNLIMITED, deliberately', () => {
  it('⚠ THE SHIPPED DEFAULT, PINNED — a Stripe-minted `{}` tier has no ceiling', () => {
    // Owner ruling: unlimited stays the default; the fix is reachability and
    // visibility, not a safer default. This test exists so that if someone
    // later decides otherwise, it is a decision with a failing test in front of
    // them rather than a silent behaviour change under a paying customer.
    const tier = seedTier('stripe', {});
    for (const kind of ['tool_call', 'chat_turn'] as const) {
      const parsed = resolveSellerCustomerUsagePolicy(tier, kind);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.policy.period_limit).toBeNull();
        expect(parsed.policy.rate_limit_per_minute).toBeNull();
      }
    }
  });

  it('⛔ A MALFORMED policy fails CLOSED — the opposite direction from absent', () => {
    // The asymmetry is the reason `setTierUsagePolicy` validates before it
    // writes: a typo here denies every call from a paying customer.
    const tier = seedTier('manual', { tool_call: 'not-an-object' });
    expect(resolveSellerCustomerUsagePolicy(tier, 'tool_call').ok).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// 2. REACHABILITY — a synced tier can be limited at all
// ────────────────────────────────────────────────────────────────

describe('D-250 § D — setTierUsagePolicy reaches a Stripe-minted tier', () => {
  const deps = () => ({ sellerStore: store, now: () => NOW }) as never;

  it('⛔⛔ THE GAP THE AUDIT FOUND — manual upsert CANNOT touch a stripe tier', () => {
    const tier = seedTier('stripe', {});
    // `upsertSellerManualTier` stamps `manual`; the store refuses to move a
    // stored tier between sources. This is correct — and it is why a separate
    // path had to exist.
    expect(() => store.upsertTier({
      tier_id: tier.tier_id,
      door_id: DOOR,
      lifecycle_source: 'manual',
      entitlement_key: tier.entitlement_key,
      now: NOW,
    })).toThrow();
  });

  it('sets a limit on a stripe tier and leaves its identity alone', () => {
    const tier = seedTier('stripe', {});
    const response = setSellerTierUsagePolicy(deps(), {
      tier_id: tier.tier_id,
      usage_policy_json: {
        tool_call: { period_granularity: 'day', period_limit: 2 },
      },
    });
    expect(response.tier.usage_policy_json).toEqual({
      tool_call: { period_granularity: 'day', period_limit: 2 },
    });
    // ⛔ Identity is owned by the sync and must not be reachable from a policy
    // edit — otherwise the next re-sync and the local edit fight.
    expect(response.tier.lifecycle_source).toBe('stripe');
    expect(response.tier.entitlement_key).toBe(tier.entitlement_key);
    expect(response.tier.template_contract_id).toBe(tier.template_contract_id);
    expect(response.tier.door_id).toBe(DOOR);
  });

  it('⛔ REFUSES A MALFORMED POLICY rather than locking out a paying customer', () => {
    const tier = seedTier('stripe', {});
    expect(() => setSellerTierUsagePolicy(deps(), {
      tier_id: tier.tier_id,
      usage_policy_json: { chat_turn: 'nope' },
    })).toThrow();
    // And the stored policy is untouched — a rejected write must not half-apply.
    expect(store.getTier(tier.tier_id)?.usage_policy_json).toEqual({});
  });

  it('⚠ validates EVERY kind, not just the one being set', () => {
    // A good `chat_turn` beside a broken `tool_call` would otherwise take the
    // door down for tool calls only, which is the hardest version to notice.
    const tier = seedTier('stripe', {});
    expect(() => setSellerTierUsagePolicy(deps(), {
      tier_id: tier.tier_id,
      usage_policy_json: {
        chat_turn: { period_limit: 10 },
        tool_call: { period_limit: 'lots' },
      },
    })).toThrow();
  });

  it('clearing back to {} restores unlimited', () => {
    const tier = seedTier('stripe', {});
    setSellerTierUsagePolicy(deps(), {
      tier_id: tier.tier_id,
      usage_policy_json: { tool_call: { period_limit: 1 } },
    });
    const cleared = setSellerTierUsagePolicy(deps(), {
      tier_id: tier.tier_id,
      usage_policy_json: {},
    });
    const parsed = resolveSellerCustomerUsagePolicy(cleared.tier, 'tool_call');
    expect(parsed.ok && parsed.policy.period_limit).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// 3. THE DOOR — a limit set here refuses a real dispatch
// ────────────────────────────────────────────────────────────────

const SLUG = 'limit-probe-http';

const manifest = (): IngredientManifest => ({
  slug: SLUG,
  name: 'Limit probe',
  description: 'Posts one row.',
  author: 'test',
  kind: 'http',
  category: 'action',
  risk_tier: 'write',
  version: 1,
  input: { method: 'POST', url: 'https://example.test/ok' },
  output: { ok: 'ok' },
} as unknown as IngredientManifest);

const recipe = (): RecipeDefinition => ({
  recipe_id: 'limit-probe',
  version: 1,
  ttl: 60,
  metadata: {
    name: 'Limit probe', description: 'Writes one row.',
    author: 'test', supported_platforms: ['test'], tags: ['test'],
  },
  variables: {},
  prefetch_steps: [],
  steps: [{ id: 'write', ingredient: SLUG, input: {} }],
  output: { sidebar: [] },
} as unknown as RecipeDefinition);

describe('D-250 § D — the limit refuses a real MCP-surface dispatch', () => {
  it('⛔⛔ THROUGH THE DOOR: call 1 and 2 run, call 3 is refused', async () => {
    const tier = seedTier('stripe', {});
    const customer = seedCustomer(tier);
    // The owner sets a limit of 2/day on the synced tier — the whole point of
    // the new path.
    const limited = setSellerTierUsagePolicy(
      { sellerStore: store, now: () => NOW } as never,
      {
        tier_id: tier.tier_id,
        usage_policy_json: {
          tool_call: { period_granularity: 'day', period_limit: 2 },
        },
      },
    ).tier;

    const gate = createSellerCustomerUsageGate({
      sellerStore: store,
      now: () => NOW,
    });
    const pendingCoordinator = createCustomerSurfaceUsagePendingCoordinator();

    const registry = createManifestRegistry('/nonexistent');
    registry.register(manifest());
    const recipeStore = createRecipeStore('/nonexistent');
    recipeStore.register(recipe());

    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ ok: true }),
      text: async () => JSON.stringify({ ok: true }),
    })) as unknown as typeof fetch;

    const outcomes: string[] = [];
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // One session per surface call, sharing the coordinator — the shape
        // `wire-mcp-http-transport` builds per request.
        const customerUsage = createCustomerSurfaceUsageSession({
          gate,
          customer,
          tier: limited,
          now: () => NOW,
          pendingCoordinator,
        });
        const admission = customerUsage.reserveOnce('mcp:tool_call', {
          tool_name: 'limit-probe',
          usage_kind: 'tool_call',
          units: 1,
        });
        if (!admission.admitted) {
          outcomes.push('denied');
          continue;
        }
        await handleExecute({
          recipeStore,
          executorConfig: { manifests: registry },
          baseVault: {},
          instanceId: 'limit-test',
          customerUsage,
        } as unknown as ExecuteHandlerDeps, {
          recipe_id: 'limit-probe',
          trigger_source: 'manual',
          config: {},
        } as never);
        customerUsage.commit();
        outcomes.push('ran');
      }
    } finally {
      globalThis.fetch = original;
    }

    // ⛔ The whole selling point in one assertion: the third call does not run.
    expect(outcomes).toEqual(['ran', 'ran', 'denied']);
    // And the durable rollup agrees — two units, not three.
    expect(store.getUsageRollup({
      contract_id: customer.contract_id,
      usage_kind: 'tool_call',
      period_granularity: 'day',
      period_start: Date.UTC(2026, 7, 24),
    })?.units).toBe(2);
  });

  it('⚠ an UNLIMITED tier runs all three — the default, driven', async () => {
    // The mirror of the test above, so "denied" is proven to come from the
    // limit rather than from anything else in the harness.
    const tier = seedTier('stripe', {});
    const customer = seedCustomer(tier);
    const gate = createSellerCustomerUsageGate({ sellerStore: store, now: () => NOW });
    const pendingCoordinator = createCustomerSurfaceUsagePendingCoordinator();
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const session = createCustomerSurfaceUsageSession({
        gate, customer, tier, now: () => NOW, pendingCoordinator,
      });
      const admission = session.reserveOnce('mcp:tool_call', {
        tool_name: 'limit-probe',
        usage_kind: 'tool_call',
        units: 1,
      });
      outcomes.push(admission.admitted ? 'ran' : 'denied');
      if (admission.admitted) session.commit();
    }
    expect(outcomes).toEqual(['ran', 'ran', 'ran']);
  });
});
