/** D-196 §6.3 — the reconciler's WIRING: does the policy's verdict actually LAND?
 *
 *  ⛔ Why this file exists alongside `d-196-seller-access-reconcile.test.ts`.
 *  That file drives `reconcileOne` + the sweep against MOCK deps, and it is
 *  green — including, before this slice, on `close({ reason: 'canceled' })`. It
 *  was green because asserting "the close seam was CALLED with X" proves nothing
 *  about whether X is a value the far side ACCEPTS. It is not: `canceled` is
 *  Stripe's spelling, `cancelled` is Recued's closed vocabulary, and the real
 *  `closeCustomer` would have thrown `unknown close reason` straight into the
 *  sweep's per-customer catch — a close lane that silently never fires, on the
 *  one action the whole task exists for.
 *
 *  So these tests mock only IO (the provider HTTP read). Everything past the
 *  decision — the seller store, the contract store, the token store, the claim
 *  store, the real `createSellerCustomerAccessLifecycle` — is REAL, and the
 *  assertions are on the OUTCOME (the customer's row, their bearer, their
 *  claims), never on a seam having been called.
 *  [[feedback_a_green_test_over_a_hollow_seam]] [[feedback_test_real_gate_not_mock_for_admission]] */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONTRACT_DEFINITION_SCOPE,
  type ContractDefinition,
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
  SELLER_STRIPE_CATALOG_SLUG,
  SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION,
  SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION_ID,
  SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION,
  SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION_ID,
  buildSellerAccessReconcileDepsIfReady,
  createSellerAccessReconcileDeps,
  parseActiveEntitlementKeys,
  parseSubscriptionCustomerId,
  parseSubscriptionTruth,
  selectReconcileConnection,
} from '../access-reconcile-deps.js';

const NOW = 1_900_100_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

let db: Database.Database;
let contractStore: ContractStore;
let inboundTokenStore: ChatInboundTokenStore;
let sellerStore: SellerStore;
let sellerClaimStore: SellerClaimStore;

/** A Stripe subscription as the pack's `subscription.read` returns it — note
 *  `current_period_end` on the ITEM, which is where Stripe actually puts it. */
const stripeSubscription = (over: {
  id?: string;
  status?: string;
  period_end_seconds?: number | string;
  items?: unknown[];
  customer?: unknown;
} = {}): unknown => ({
  result: {
    object: 'subscription',
    id: over.id ?? 'sub_1',
    status: over.status ?? 'active',
    // The entitlement read's only arg comes from HERE — the same read that
    // proved the subscription's identity, so it cannot drift from it.
    customer: 'customer' in over ? over.customer : 'cus_1',
    items: {
      object: 'list',
      data: over.items ?? [
        { id: 'si_1', current_period_end: over.period_end_seconds ?? (NOW + DAY_MS) / 1000 },
      ],
    },
  },
});

/** The customer's active entitlements as the pack's `active_entitlement.search`
 *  returns them (`result_path: 'data'`, so the gateway hands back the array). */
const stripeEntitlements = (...lookup_keys: string[]): unknown => ({
  result: lookup_keys.map((lookup_key, i) => ({ id: `ent_${i}`, lookup_key })),
});

const CONNECTION_ROW = {
  name: 'stripe-main',
  display_name: 'Stripe',
  config_json: JSON.stringify({ vendor: 'stripe' }),
  subresource_path: undefined,
};

const MANIFEST = {
  operations: {
    [SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION]: {
      operation_id: SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION_ID,
    },
    [SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION]: {
      operation_id: SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION_ID,
    },
  },
} as never;

const ALL_OPS = [
  SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION,
  SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION,
];

const buildWiring = (over: {
  raw?: unknown;
  /** Entitlement-read payload. Absent ⇒ the customer holds their own tier's key
   *  (`basic`), i.e. converged — so a test that says nothing about entitlements
   *  gets no swap. */
  entitlements?: unknown;
  ok?: boolean;
  entitlementsOk?: boolean;
  connections?: (typeof CONNECTION_ROW)[];
  manifest?: unknown;
  granted?: boolean;
  /** Ops the connection grants. Default: both. */
  allowed?: string[];
} = {}) => {
  // Params are declared so `mock.calls[n]` is a typed 2-tuple rather than `[]`
  // — the gated-request assertions below read `calls[n][1]`.
  const runOperation = vi.fn(async (_deps: unknown, request: unknown) => {
    const op = (request as { operationKey?: string }).operationKey;
    if (op === SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION) {
      return over.entitlementsOk === false
        ? ({ ok: false, kind: 'error', reason: 'upstream' } as const)
        : ({ ok: true, raw: over.entitlements ?? stripeEntitlements('basic') } as const);
    }
    return over.ok === false
      ? ({ ok: false, kind: 'policy', reason: 'denied' } as const)
      : ({ ok: true, raw: over.raw ?? stripeSubscription() } as const);
  });
  const deps = createSellerAccessReconcileDeps({
    sellerStore,
    contractStore,
    inboundTokenStore,
    sellerClaimStore,
    executorConfig: {
      manifests: { get: () => (over.manifest !== undefined ? over.manifest : MANIFEST) },
    } as never,
    connectionOperationProfiles: {
      get: () => ({
        catalog_slug: SELLER_STRIPE_CATALOG_SLUG,
        allowed_operations: over.granted === false ? [] : (over.allowed ?? ALL_OPS),
      }),
    } as never,
    connectionStore: {
      get: () => CONNECTION_ROW,
      list: () => over.connections ?? [CONNECTION_ROW],
    } as never,
    now: () => NOW,
    runOperation: runOperation as never,
  });
  return { deps, runOperation };
};

/** Which ops the sweep actually dispatched, in order. */
const dispatched = (runOperation: { mock: { calls: unknown[][] } }): string[] =>
  runOperation.mock.calls.map((c) => (c[1] as { operationKey: string }).operationKey);

/** A real tier on a door, with its own live customer_template — what
 *  `stripe-entitlement-sync.ts` mints, one per provider FEATURE. */
const seedTier = (input: {
  tier_id: string;
  entitlement_key: string;
  door_id?: string;
}) => {
  // Keyed on tier_id, not entitlement_key: two DOORS may carry the same
  // entitlement_key (the store's UNIQUE is per-door), and that collision is
  // exactly what the door-narrowing test below needs to construct.
  const contract_id = `ct_template_${input.tier_id}`;
  const template: ContractDefinition = {
    contract_id,
    minted_at: NOW - 10_000,
    minted_by: 'owner:test',
    display_name: `Template ${input.entitlement_key}`,
    scope: { operation_ids: [`${contract_id}.op`] },
    door_types: ['mcp'],
    grant_kind: 'customer_template',
  };
  contractStore.put(CONTRACT_DEFINITION_SCOPE, [contract_id], template);
  return sellerStore.upsertTier({
    tier_id: input.tier_id,
    door_id: input.door_id ?? 'door_mcp',
    lifecycle_source: 'stripe',
    entitlement_key: input.entitlement_key,
    display_name: input.entitlement_key,
    template_contract_id: contract_id,
    usage_policy_json: {},
    now: NOW,
  });
};

/** Seed a real, open, subscription-backed customer through the real lifecycle.
 *  The door carries TWO tiers (`basic` + `pro`) so a swap has somewhere to go —
 *  a one-tier door could never exercise the lane. */
const seedCustomer = (over: { external_subscription_id?: string | null } = {}) => {
  seedTier({ tier_id: 'tier_basic', entitlement_key: 'basic' });
  seedTier({ tier_id: 'tier_pro', entitlement_key: 'pro' });
  const lifecycle = createSellerCustomerAccessLifecycle({
    sellerStore,
    contractStore,
    grantEntryStore: createContractGrantEntryStore(contractStore),
    inboundTokenStore,
    sellerClaimStore,
    buildClaimPayload: ({ bearer_plaintext }) => ({
      bearer_plaintext,
      mcp_url: 'https://seller.example/mcp',
      llm_gateway_base_url: null,
      llm_gateway_model_alias: null,
    }),
    mintedBy: 'seller:test',
    now: () => NOW,
    transaction: (fn) => contractStore.transaction(fn),
  });
  return lifecycle.issueCustomer({
    lifecycle_source: 'stripe',
    door_id: 'door_mcp',
    source_customer_id: 'cus_1',
    entitlement_key: 'basic',
    current_period_end: NOW + DAY_MS,
    source_status: 'active',
    external_subscription_id:
      over.external_subscription_id === undefined ? 'sub_1' : over.external_subscription_id,
  }).customer;
};

beforeEach(() => {
  db = new Database(':memory:');
  contractStore = createContractStore(db, { now: () => NOW });
  ensureChatInboundTokenSchema(db);
  inboundTokenStore = createChatInboundTokenStore(db);
  sellerStore = createSellerStore(db);
  sellerClaimStore = createSellerClaimStore(db);
});

afterEach(() => {
  db.close();
});

describe('D-196 §6.3 wiring — the verdict must LAND, not merely be emitted', () => {
  it('🔑 a provider `canceled` actually CLOSES the customer through the real lifecycle', async () => {
    // THE test. Before this slice the policy emitted `reason: 'canceled'` — the
    // provider's spelling — which the real `cleanCloseReason` rejects and the
    // sweep's catch swallows. A mock-only test cannot see that; this one does,
    // because it asserts the ROW, not the call.
    const seeded = seedCustomer();
    expect(seeded.access_state).toBe('active');

    const { deps } = buildWiring({ raw: stripeSubscription({ status: 'canceled' }) });
    const out = await runSellerAccessReconcile(deps);

    expect(out).toMatchObject({ swept: 1, closed: 1, unreadable: 0 });
    const row = sellerStore.getCustomer(seeded.customer_id);
    expect(row?.access_state).toBe('closed');
    // The provider's raw word is recorded as evidence; the LOCAL reason is the
    // decision. Neither is reconstructed from the other.
    expect(row?.source_status).toBe('canceled');
    // A close that fully closes: the bearer is revoked too, not just the row.
    expect(
      inboundTokenStore.getTokenById(seeded.inbound_token_id!)?.revoked_at ?? null,
    ).not.toBeNull();
  });

  // ⛔ THE PAIR BELOW is why `source_status` travels verbatim rather than being
  // reverse-mapped from `reason`. Both statuses carry the SAME local reason
  // (`payment_failed`), but the seller's status policy reads the RAW provider
  // word and splits them:
  //   - `unpaid`             → GRACE_STATUSES → grace (dunning; §6.2's
  //                            "enter/refresh grace per status policy")
  //   - `incomplete_expired` → in NEITHER set → the `?? 'close_now'` default.
  //                            Correct: the first invoice never cleared, so
  //                            access never began — no paid period to grace.
  // Reconstructing the status from `payment_failed` would have sent BOTH down
  // the `unpaid` branch, handing a grace window to someone who never paid.
  // [[feedback_provenance_that_lies_is_worse_than_absent]]

  it('🔑 `unpaid` enters GRACE by the seller\'s policy — dunning, not revocation', async () => {
    const seeded = seedCustomer();
    const { deps } = buildWiring({ raw: stripeSubscription({ status: 'unpaid' }) });

    await runSellerAccessReconcile(deps);

    const row = sellerStore.getCustomer(seeded.customer_id);
    expect(row?.access_state).toBe('grace');
    expect(row?.source_status).toBe('unpaid');
    // Grace is access, not revocation: the bearer must survive it.
    expect(
      inboundTokenStore.getTokenById(seeded.inbound_token_id!)?.revoked_at ?? null,
    ).toBeNull();
  });

  it('🔑 `incomplete_expired` CLOSES — the same local reason, the opposite outcome', async () => {
    const seeded = seedCustomer();
    const { deps } = buildWiring({ raw: stripeSubscription({ status: 'incomplete_expired' }) });

    await runSellerAccessReconcile(deps);

    const row = sellerStore.getCustomer(seeded.customer_id);
    expect(row?.access_state).toBe('closed');
    expect(row?.source_status).toBe('incomplete_expired');
  });

  it('EXTENDS a live subscription to the provider period end, through the real lifecycle', async () => {
    const seeded = seedCustomer();
    expect(seeded.current_period_end).toBe(NOW + DAY_MS);

    const { deps } = buildWiring({
      raw: stripeSubscription({ period_end_seconds: (NOW + 30 * DAY_MS) / 1000 }),
    });
    const out = await runSellerAccessReconcile(deps);

    expect(out).toMatchObject({ swept: 1, extended: 1 });
    const row = sellerStore.getCustomer(seeded.customer_id);
    expect(row?.current_period_end).toBe(NOW + 30 * DAY_MS);
    expect(row?.access_state).toBe('active');
  });

  it('⛔ past_due is DUNNING — it neither closes nor loses the customer their access', async () => {
    const seeded = seedCustomer();
    const { deps } = buildWiring({ raw: stripeSubscription({ status: 'past_due' }) });

    const out = await runSellerAccessReconcile(deps);

    expect(out).toMatchObject({ swept: 1, closed: 0 });
    expect(sellerStore.getCustomer(seeded.customer_id)?.access_state).toBe('active');
  });

  it('⛔ a gateway REFUSAL is UNREADABLE, never evidence that access ended', async () => {
    const seeded = seedCustomer();
    const { deps } = buildWiring({ ok: false });

    const out = await runSellerAccessReconcile(deps);

    expect(out).toMatchObject({ swept: 1, unreadable: 1, closed: 0 });
    expect(sellerStore.getCustomer(seeded.customer_id)?.access_state).toBe('active');
  });
});

describe('D-196 §6.3 s2c — the swap lane, through the real lifecycle', () => {
  it('🔑 an entitlement move actually SWAPS the tier, and re-stamps the contract', async () => {
    const seeded = seedCustomer();
    expect(seeded.tier_id).toBe('tier_basic');

    // Provider says: this customer now holds `pro`, not `basic`.
    const { deps, runOperation } = buildWiring({ entitlements: stripeEntitlements('pro') });
    const out = await runSellerAccessReconcile(deps);

    expect(out).toMatchObject({ swept: 1, swapped: 1, closed: 0 });
    const row = sellerStore.getCustomer(seeded.customer_id);
    expect(row?.tier_id).toBe('tier_pro');
    expect(row?.access_state).toBe('active');
    // The swap is not a label change: the customer's contract is re-stamped from
    // the NEW tier's template, which is what actually moves their authority.
    expect(dispatched(runOperation)).toEqual([
      SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION,
      SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION,
    ]);
  });

  it('🔑 the DOOR NARROWING is load-bearing: another door selling the same tier name must not blind the swap', async () => {
    // The entitlement read is CUSTOMER-scoped, so it answers for every door that
    // Stripe customer is on — and two doors may legitimately carry the SAME
    // `entitlement_key` (the store's UNIQUE is per-door). Without narrowing to
    // the customer's own door, this seller's second door makes `pro` look
    // AMBIGUOUS (two candidate tiers) and a real, unambiguous swap is silently
    // missed. Narrowed, it is exactly one candidate.
    const seeded = seedCustomer();
    seedTier({ tier_id: 'tier_other_pro', entitlement_key: 'pro', door_id: 'door_other' });

    const { deps } = buildWiring({ entitlements: stripeEntitlements('pro') });
    const out = await runSellerAccessReconcile(deps);

    expect(out).toMatchObject({ swept: 1, swapped: 1 });
    const row = sellerStore.getCustomer(seeded.customer_id);
    expect(row?.tier_id).toBe('tier_pro');
    // ...and never the other door's tier.
    expect(row?.door_id).toBe('door_mcp');
  });

  it('🔑 the entitlement read is scoped to the customer id from the SAME subscription read', async () => {
    seedCustomer();
    const { deps, runOperation } = buildWiring({ entitlements: stripeEntitlements('pro') });

    await runSellerAccessReconcile(deps);

    const entitlementCall = runOperation.mock.calls
      .map((c) => c[1] as { operationKey: string; args: unknown; trigger_source?: string; execution_source?: unknown })
      .find((r) => r.operationKey === SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION)!;
    expect(entitlementCall.args).toEqual({ 'query.customer': 'cus_1' });
    // The second read carries the same no-authority posture as the first.
    expect(entitlementCall.execution_source).toBeUndefined();
    expect(entitlementCall.trigger_source).toBe('housekeeping');
  });

  it('their key still active ⇒ CONVERGED: no swap, and the count is irrelevant', async () => {
    const seeded = seedCustomer();
    // They hold their own key plus others (another product's feature, another
    // door). Membership — not a count — is what answers this.
    const { deps } = buildWiring({
      entitlements: stripeEntitlements('basic', 'pro', 'unrelated_feature'),
    });

    expect(await runSellerAccessReconcile(deps)).toMatchObject({ swept: 1, swapped: 0 });
    expect(sellerStore.getCustomer(seeded.customer_id)?.tier_id).toBe('tier_basic');
  });

  it('⛔ their key VANISHING alone does NOT swap or close — a detached feature is not a plan change', async () => {
    const seeded = seedCustomer();
    const { deps } = buildWiring({ entitlements: stripeEntitlements() });

    const out = await runSellerAccessReconcile(deps);

    expect(out).toMatchObject({ swept: 1, swapped: 0, closed: 0 });
    expect(sellerStore.getCustomer(seeded.customer_id)?.tier_id).toBe('tier_basic');
    expect(sellerStore.getCustomer(seeded.customer_id)?.access_state).toBe('active');
  });

  it('⛔ an ENDED subscription costs NO entitlement read — nothing to converge for a closing customer', async () => {
    seedCustomer();
    const { deps, runOperation } = buildWiring({ raw: stripeSubscription({ status: 'canceled' }) });

    await runSellerAccessReconcile(deps);

    expect(dispatched(runOperation)).toEqual([SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION]);
  });

  it('⛔ an UNREADABLE entitlement list keeps the status truth and leaves the tier alone', async () => {
    const seeded = seedCustomer();
    const { deps } = buildWiring({
      entitlementsOk: false,
      raw: stripeSubscription({ period_end_seconds: (NOW + 30 * DAY_MS) / 1000 }),
    });

    // The extend it DID prove still lands; only the swap goes quiet.
    const out = await runSellerAccessReconcile(deps);
    expect(out).toMatchObject({ swept: 1, extended: 1, swapped: 0 });
    expect(sellerStore.getCustomer(seeded.customer_id)?.tier_id).toBe('tier_basic');
  });

  it('🔑 the swap lane DEGRADES ALONE — an ungranted entitlement read must not kill the sweep', async () => {
    const seeded = seedCustomer();
    // A seller who granted only `subscription.read`: extend/close must keep
    // working. Hoisting this into `readyConnections()` would have swept nothing.
    const { deps, runOperation } = buildWiring({
      allowed: [SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION],
      entitlements: stripeEntitlements('pro'),
      raw: stripeSubscription({ period_end_seconds: (NOW + 30 * DAY_MS) / 1000 }),
    });

    const out = await runSellerAccessReconcile(deps);

    expect(out).toMatchObject({ swept: 1, extended: 1, swapped: 0 });
    expect(dispatched(runOperation)).toEqual([SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION]);
    expect(sellerStore.getCustomer(seeded.customer_id)?.current_period_end).toBe(NOW + 30 * DAY_MS);
  });

  it('⛔ a LOOK-ALIKE entitlement op is not the entitlement op — the swap lane stays shut', async () => {
    seedCustomer();
    const { deps, runOperation } = buildWiring({
      entitlements: stripeEntitlements('pro'),
      manifest: {
        operations: {
          [SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION]: {
            operation_id: SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION_ID,
          },
          [SELLER_STRIPE_ENTITLEMENT_SEARCH_OPERATION]: {
            operation_id: 'someone-else/seller-stripe.active_entitlement.search',
          },
        },
      },
    });

    expect(await runSellerAccessReconcile(deps)).toMatchObject({ swept: 1, swapped: 0 });
    expect(dispatched(runOperation)).toEqual([SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION]);
  });

  it('⛔ a subscription without a readable customer id cannot reach the entitlement read', async () => {
    seedCustomer();
    const { deps, runOperation } = buildWiring({
      raw: stripeSubscription({ customer: { id: 'cus_1' } }),
      entitlements: stripeEntitlements('pro'),
    });

    expect(await runSellerAccessReconcile(deps)).toMatchObject({ swept: 1, swapped: 0 });
    expect(dispatched(runOperation)).toEqual([SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION]);
  });
});

describe('D-196 §6.3 wiring — the swept set', () => {
  it('⛔ never sweeps a one-time pass (no subscription id) — expiry does that work', async () => {
    seedCustomer({ external_subscription_id: null });
    const { deps, runOperation } = buildWiring();

    expect(await runSellerAccessReconcile(deps)).toMatchObject({ swept: 0 });
    expect(runOperation).not.toHaveBeenCalled();
  });

  it('⛔ never sweeps a CLOSED customer — every lifecycle call refuses one', async () => {
    const seeded = seedCustomer();
    const { deps } = buildWiring({ raw: stripeSubscription({ status: 'canceled' }) });
    await runSellerAccessReconcile(deps);
    expect(sellerStore.getCustomer(seeded.customer_id)?.access_state).toBe('closed');

    // Second cycle: the now-closed customer is out of the set, so the sweep
    // costs zero provider reads rather than one throw per cycle, forever.
    const second = buildWiring({ raw: stripeSubscription({ status: 'canceled' }) });
    expect(await runSellerAccessReconcile(second.deps)).toMatchObject({ swept: 0 });
    expect(second.runOperation).not.toHaveBeenCalled();
  });

  it('⛔ sweeps NOTHING when the Stripe connection is ambiguous — it must not guess an account', async () => {
    seedCustomer();
    const { deps, runOperation } = buildWiring({
      connections: [CONNECTION_ROW, { ...CONNECTION_ROW, name: 'stripe-other' }],
    });

    // A housekeeping cycle has nobody to ask which account is the seller's, and
    // reading a subscription id against the WRONG Stripe account is not a
    // harmless 404 — it is convergence on a stranger's truth.
    expect(await runSellerAccessReconcile(deps)).toMatchObject({ swept: 0 });
    expect(runOperation).not.toHaveBeenCalled();
  });

  it('⛔ sweeps NOTHING when no catalog is installed, or the read is not granted', async () => {
    seedCustomer();
    expect(await runSellerAccessReconcile(buildWiring({ manifest: null }).deps))
      .toMatchObject({ swept: 0 });
    expect(await runSellerAccessReconcile(buildWiring({ granted: false }).deps))
      .toMatchObject({ swept: 0 });
  });

  it('⛔ rejects a LOOK-ALIKE catalog installed under the same slug', async () => {
    seedCustomer();
    const { deps, runOperation } = buildWiring({
      manifest: {
        operations: {
          [SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION]: {
            operation_id: 'someone-else/seller-stripe.subscription.read',
          },
        },
      },
    });

    expect(await runSellerAccessReconcile(deps)).toMatchObject({ swept: 0 });
    expect(runOperation).not.toHaveBeenCalled();
  });
});

describe('D-196 §6.3 wiring — the gated read carries no housekeeping authority', () => {
  it('⛔ passes NO execution_source — that is the one input that arms `housekeeping → admin`', async () => {
    seedCustomer();
    const { deps, runOperation } = buildWiring();

    await runSellerAccessReconcile(deps);

    const request = runOperation.mock.calls[0]![1] as Record<string, unknown>;
    // `resolveTrustCeiling` maps `channel: 'housekeeping'` to the `admin`
    // ceiling (write + admin run silent). Absent source ⇒ the LOW `read`
    // ceiling, which is all this read needs. D-209 #2 owns arming that branch
    // deliberately; a reconciler must not summon it as a side effect.
    expect(request.execution_source).toBeUndefined();
    // ...while the audit still carries the honest origin: `trigger_source` is a
    // free label that feeds no ceiling, so it costs no authority to be truthful.
    expect(request.trigger_source).toBe('housekeeping');
    expect(request.catalogSlug).toBe(SELLER_STRIPE_CATALOG_SLUG);
    expect(request.args).toEqual({ subscription_id: 'sub_1' });
  });
});

describe('parseSubscriptionTruth — an unverified shape must never close a payer', () => {
  it('reads current_period_end off the ITEM (where Stripe puts it), in ms', () => {
    expect(parseSubscriptionTruth(stripeSubscription({ period_end_seconds: 1_700 }), 'sub_1'))
      .toEqual({ status: 'active', current_period_end_ms: 1_700_000 });
  });

  it('tolerates the pack\'s `unsafe_integers: string` — a numeric field can arrive as a string', () => {
    expect(
      parseSubscriptionTruth(stripeSubscription({ period_end_seconds: '1700' }), 'sub_1')
        ?.current_period_end_ms,
    ).toBe(1_700_000);
  });

  it('⛔ a response for a DIFFERENT subscription is UNREADABLE, not truth', () => {
    expect(parseSubscriptionTruth(stripeSubscription({ id: 'sub_other' }), 'sub_1')).toBeNull();
  });

  it('⛔ a non-subscription / malformed / statusless object is UNREADABLE', () => {
    expect(parseSubscriptionTruth({ result: { object: 'invoice', id: 'sub_1' } }, 'sub_1')).toBeNull();
    expect(parseSubscriptionTruth({ result: { object: 'subscription', id: 'sub_1' } }, 'sub_1')).toBeNull();
    expect(parseSubscriptionTruth(null, 'sub_1')).toBeNull();
    expect(parseSubscriptionTruth('nope', 'sub_1')).toBeNull();
  });

  it('a 0- or 2-item subscription keeps its STATUS but has NO period — the status can still close it', () => {
    // With 2+ items no single period governs, so the period is unknown rather
    // than "the first one's". Status survives, so an ended multi-item
    // subscription still closes; only `extend` goes quiet.
    for (const items of [[], [{ current_period_end: 1_700 }, { current_period_end: 9_900 }]]) {
      const truth = parseSubscriptionTruth(stripeSubscription({ items, status: 'canceled' }), 'sub_1');
      expect(truth).toEqual({ status: 'canceled' });
    }
  });

  it('⛔ a non-finite / absent period is UNKNOWN, never 0 or NaN', () => {
    // A NaN would survive `>` as `false` and read as "already converged".
    for (const bad of [undefined, null, 'later', Number.NaN, 0, -5]) {
      expect(
        parseSubscriptionTruth(
          stripeSubscription({ items: [{ current_period_end: bad }] }),
          'sub_1',
        )?.current_period_end_ms,
      ).toBeUndefined();
    }
  });

  it('⛔ NEVER populates tier_id — no provider-price to local-tier mapping exists (v1 swap is inert)', () => {
    // The swap lane's inertness, pinned. If a future revision starts populating
    // provider tier identity, this red is the prompt to settle the vocabulary
    // question first (task module header, note 1) rather than to delete the pin.
    const truth = parseSubscriptionTruth(stripeSubscription(), 'sub_1');
    expect(truth).not.toBeNull();
    expect(truth!.tier_id).toBeUndefined();
  });
});

describe('the s2c parsers', () => {
  it('parseSubscriptionCustomerId takes the `cus_` id, and refuses anything else', () => {
    expect(parseSubscriptionCustomerId(stripeSubscription())).toBe('cus_1');
    // The pack expands nothing, so an object here means the shape is not what we
    // think it is — guessing an id out of it is how a wrong customer gets read.
    expect(parseSubscriptionCustomerId(stripeSubscription({ customer: { id: 'cus_1' } })))
      .toBeUndefined();
    expect(parseSubscriptionCustomerId(stripeSubscription({ customer: 'acct_1' }))).toBeUndefined();
    expect(parseSubscriptionCustomerId(stripeSubscription({ customer: null }))).toBeUndefined();
    expect(parseSubscriptionCustomerId(null)).toBeUndefined();
  });

  it('parseActiveEntitlementKeys plucks lookup_key — the same field the recipe reads', () => {
    expect(parseActiveEntitlementKeys(stripeEntitlements('basic', 'pro'))).toEqual(['basic', 'pro']);
    expect(parseActiveEntitlementKeys(stripeEntitlements())).toEqual([]);
    // Tolerate the un-unwrapped list envelope as well as the unwrapped array.
    expect(parseActiveEntitlementKeys({ result: { data: [{ lookup_key: 'pro' }] } })).toEqual(['pro']);
    // ⛔ A row without a usable key contributes NOTHING rather than a hole —
    // an `undefined` in the key list would silently match nothing forever.
    expect(parseActiveEntitlementKeys({ result: [{ id: 'ent_1' }, { lookup_key: '' }, { lookup_key: 'pro' }] }))
      .toEqual(['pro']);
    expect(parseActiveEntitlementKeys(null)).toEqual([]);
  });
});

describe('buildSellerAccessReconcileDepsIfReady — the s2b registration gate', () => {
  // The build guard is what decides whether the reconciler REGISTERS at boot.
  // s1/s2a/s2c all shipped inert; this is the seam that ends that — so its
  // fail-closed behaviour (any missing half ⇒ undefined ⇒ no task) is the whole
  // point, and every branch is pinned.
  const gateway = () => ({
    executorConfig: { manifests: { get: () => MANIFEST } } as never,
    connectionOperationProfiles: { get: () => undefined } as never,
    connectionStore: { get: () => undefined, list: () => [] } as never,
  });
  const seller = () => ({ sellerStore, contractStore, inboundTokenStore, sellerClaimStore });

  it('all present ⇒ a live deps object (the reconciler will register)', () => {
    expect(
      buildSellerAccessReconcileDepsIfReady({ gateway: gateway(), seller: seller() }),
    ).not.toBeUndefined();
  });

  it('⛔ EACH missing seller store ⇒ undefined (no half-wired reconciler)', () => {
    for (const drop of ['sellerStore', 'contractStore', 'inboundTokenStore', 'sellerClaimStore'] as const) {
      expect(
        buildSellerAccessReconcileDepsIfReady({
          gateway: gateway(),
          seller: { ...seller(), [drop]: undefined },
        }),
      ).toBeUndefined();
    }
  });

  it('⛔ the claim store is REQUIRED — a close must fully close (revoke the claim)', () => {
    // Typed optional on the lifecycle, but omitting it leaves a closed
    // customer's claim link redeemable. The gate refuses rather than register a
    // reconciler that half-closes. [[feedback_complete_the_fence_dont_predict_the_default]]
    expect(
      buildSellerAccessReconcileDepsIfReady({
        gateway: gateway(),
        seller: { ...seller(), sellerClaimStore: undefined },
      }),
    ).toBeUndefined();
  });

  it('⛔ a missing profiles OR connection store ⇒ undefined — there is no gated read without BOTH', () => {
    // Only `executorConfig` is required on ExecuteHandlerDeps; the reader
    // dereferences the profiles AND the connection store, so a missing one is
    // "no gated read at all", not "degrade a lane". Registering anyway would
    // count every customer unreadable, forever.
    expect(
      buildSellerAccessReconcileDepsIfReady({
        gateway: { ...gateway(), connectionOperationProfiles: undefined },
        seller: seller(),
      }),
    ).toBeUndefined();
    expect(
      buildSellerAccessReconcileDepsIfReady({
        gateway: { ...gateway(), connectionStore: undefined },
        seller: seller(),
      }),
    ).toBeUndefined();
  });
});

describe('selectReconcileConnection — ambiguity yields nothing', () => {
  it('takes the single ready connection, and refuses to guess at 0 or 2+', () => {
    expect(selectReconcileConnection([{ name: 'a' }])).toBe('a');
    expect(selectReconcileConnection([])).toBeNull();
    expect(selectReconcileConnection([{ name: 'a' }, { name: 'b' }])).toBeNull();
  });
});
