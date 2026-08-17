/** D-196 S5 — GATED Stripe test-mode E2E: the "prove it end to end before going
 *  live" dry-run (spec §10 S5 + §8). Drives a REAL Stripe test-mode subscription
 *  through a REAL test clock — issue → extend → (reissue) → fail → close — and
 *  asserts the §6.3 reconciler converges the local seller access lifecycle
 *  against provider truth at every step.
 *
 *  ── HOW IT RUNS ──────────────────────────────────────────────────────────────
 *  By DEFAULT it runs against an in-process MOCK Stripe test-clock server
 *  (`./mock-stripe-testclock.ts`) — no credentials, no network, executes in CI.
 *  The mock speaks the exact slice of the Stripe REST API this test drives and
 *  models the billing transitions the reconciler converges against (renew on a
 *  good card, past_due on the failing card, canceled on delete).
 *
 *  For a HIGHER-FIDELITY check against the real Stripe test-mode API, opt in:
 *
 *    RECUED_STRIPE_TEST_INTEGRATION=1 \
 *    STRIPE_TEST_SECRET_KEY=sk_test_... \
 *    scripts/vitest.sh run \
 *      backend/server/src/seller/__tests__/d-196-s5-stripe-testclock.integration.test.ts
 *
 *  Both modes exercise the SAME test; only the base URL + key differ. Use a Stripe
 *  TEST key (`sk_test_...`) on a throwaway/test account; the real run deletes its
 *  test clock at the end (which cascades the customer + subscription).
 *
 *  ── WHAT IS REAL vs STUBBED ──────────────────────────────────────────────────
 *  Real: a Stripe-shaped API (the in-process mock by default, real Stripe test-mode
 *  when opted in) driven through a real test clock, and everything past the
 *  provider read — the seller store, contract store, token
 *  store, claim store, the real `createSellerCustomerAccessLifecycle`, and the
 *  real `runSellerAccessReconcile` sweep. Assertions are on the OUTCOME (the
 *  customer row, its bearer, its period), never on a seam having been called
 *  [[feedback_a_green_test_over_a_hollow_seam]].
 *  Stubbed: only the catalog GATEWAY's generic HTTP/auth/response-shaping layer.
 *  The reconciler's `runOperation` seam (its explicit test seam) is supplied here
 *  as a REAL Stripe reader that returns the pack's `{ ok, raw: { result } }`
 *  shape — so the reconciler reads live subscription STATUS + PERIOD from Stripe,
 *  exactly as production does, without standing up the manifest/connection wiring.
 *
 *  Entitlement (swap) reads are deliberately NOT granted: the arc under test is
 *  status + period (extend/close), which needs no entitlement; `resolveProviderTierId`
 *  degrades to "no swap" when the read is ungranted (access-reconcile-deps.ts).
 */

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONTRACT_DEFINITION_SCOPE, type ContractDefinition } from '@recued/contracts';

import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
  type ChatInboundTokenStore,
} from '../../storage/chat-inbound-token-store.js';
import { createContractStore, type ContractStore } from '../../storage/contract-store.js';
import { createContractGrantEntryStore } from '../../storage/contract-grant-entry-store.js';
import { createSellerClaimStore, type SellerClaimStore } from '../../storage/seller-claim-store.js';
import { createSellerStore, type SellerStore } from '../../storage/seller-store.js';
import {
  createSellerCustomerAccessLifecycle,
  type SellerCustomerAccessLifecycle,
} from '../customer-access-lifecycle.js';
import {
  runSellerAccessReconcile,
  type SellerAccessReconcileDeps,
} from '../../housekeeping/tasks/seller-access-reconcile.js';
import {
  SELLER_STRIPE_CATALOG_SLUG,
  SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION,
  SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION_ID,
  createSellerAccessReconcileDeps,
} from '../access-reconcile-deps.js';
import {
  MOCK_FAILING_PAYMENT_METHOD,
  startMockStripeServer,
  type MockStripeServer,
} from './mock-stripe-testclock.js';

// ── Backend selection: the in-process mock by default (always runs), real Stripe
// test-mode when opted in. Only the base URL + key differ; the scenario is shared.
const USE_REAL_STRIPE =
  process.env.RECUED_STRIPE_TEST_INTEGRATION === '1'
  && (process.env.STRIPE_TEST_SECRET_KEY ?? '').startsWith('sk_test_');
const STRIPE_KEY = USE_REAL_STRIPE ? (process.env.STRIPE_TEST_SECRET_KEY as string) : 'sk_test_mock';
const REAL_STRIPE_BASE = 'https://api.stripe.com/v1';

// ── A tiny Stripe REST client (form-encoded, bracketed nesting) ─────────────────
// Points at the mock or real Stripe; set once the backend is chosen in beforeAll.
let stripeBaseUrl = REAL_STRIPE_BASE;
let mockServer: MockStripeServer | null = null;

const encodeStripeForm = (obj: Record<string, unknown>): string => {
  const params = new URLSearchParams();
  const add = (key: string, val: unknown): void => {
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) {
      val.forEach((v, i) => add(`${key}[${i}]`, v));
    } else if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) add(`${key}[${k}]`, v);
    } else {
      params.append(key, String(val));
    }
  };
  for (const [k, v] of Object.entries(obj)) add(k, v);
  return params.toString();
};

const stripe = async (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  form?: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const qs = method === 'GET' && form ? `?${encodeStripeForm(form)}` : '';
  const res = await fetch(`${stripeBaseUrl}${path}${qs}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_KEY}`,
      ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(method !== 'GET' && form ? { body: encodeStripeForm(form) } : {}),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`Stripe ${method} ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── Shapes we read out of Stripe JSON ──────────────────────────────────────────
interface SubscriptionItem {
  readonly current_period_end?: number;
}
const subscriptionPeriodEndSeconds = (sub: Record<string, unknown>): number => {
  const items = (sub.items as { data?: SubscriptionItem[] } | undefined)?.data ?? [];
  const fromItem = items[0]?.current_period_end;
  // API versions before 2025-03 carry the period on the subscription itself; the
  // pack (and this reader) expect it on the item, so fall back and normalize.
  const fromSub = typeof sub.current_period_end === 'number' ? sub.current_period_end : undefined;
  const end = fromItem ?? fromSub;
  if (typeof end !== 'number') {
    throw new Error(`Stripe subscription ${String(sub.id)} has no current_period_end`);
  }
  return end;
};

describe('D-196 S5 — Stripe test-clock E2E (issue → extend → reissue → fail → close)', () => {
  const NOW_S = Math.floor(Date.now() / 1000);
  const DEFAULT_GRACE_MS = 72 * 60 * 60 * 1000;

  let productId: string;
  let priceId: string;
  let clockId: string;
  let stripeCustomerId: string;
  let subscriptionId: string;

  let db: Database.Database;
  let contractStore: ContractStore;
  let inboundTokenStore: ChatInboundTokenStore;
  let sellerStore: SellerStore;
  let sellerClaimStore: SellerClaimStore;
  let lifecycle: SellerCustomerAccessLifecycle;
  let reconcileDeps: SellerAccessReconcileDeps;

  // Local ids assigned during the issue phase and reused across phases.
  let localCustomerId: string;
  let issuedTokenId: string;

  /** The reconciler's `runOperation` seam, wired to REAL Stripe. It only needs the
   *  subscription read (the entitlement/swap read is not granted, below), and it
   *  returns the pack's `{ ok, raw: { result } }` shape so `parseSubscriptionTruth`
   *  reads live status + item-level period exactly as it does in production. */
  const stripeRunOperation = async (
    _gatewayDeps: unknown,
    request: { operationKey?: string; args?: Record<string, unknown> },
  ): Promise<{ ok: true; raw: unknown } | { ok: false; kind: string; reason: string }> => {
    if (request.operationKey !== SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION) {
      return { ok: false, kind: 'error', reason: `unexpected op ${String(request.operationKey)}` };
    }
    const subId = String(request.args?.subscription_id ?? '');
    const sub = await stripe('GET', `/subscriptions/${subId}`);
    // Normalize the period onto the item so the parser finds it regardless of the
    // account's default API version (see `subscriptionPeriodEndSeconds`).
    const periodEnd = subscriptionPeriodEndSeconds(sub);
    const items = (sub.items as { data?: SubscriptionItem[] } | undefined)?.data ?? [];
    const normalizedItems = items.length > 0
      ? items.map((item, i) => (i === 0 ? { ...item, current_period_end: periodEnd } : item))
      : [{ current_period_end: periodEnd }];
    return {
      ok: true,
      raw: { result: { ...sub, items: { object: 'list', data: normalizedItems } } },
    };
  };

  const buildReconcileDeps = (): SellerAccessReconcileDeps => {
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
      },
    };
    return createSellerAccessReconcileDeps({
      sellerStore,
      contractStore,
      inboundTokenStore,
      sellerClaimStore,
      executorConfig: { manifests: { get: () => MANIFEST } } as never,
      connectionOperationProfiles: {
        // Only the subscription read is granted — extend/close need no entitlement,
        // and the swap lane degrades to "no swap" without it.
        get: () => ({
          catalog_slug: SELLER_STRIPE_CATALOG_SLUG,
          allowed_operations: [SELLER_STRIPE_SUBSCRIPTION_READ_OPERATION],
        }),
      } as never,
      connectionStore: {
        get: () => CONNECTION_ROW,
        list: () => [CONNECTION_ROW],
      } as never,
      now: () => Date.now(),
      runOperation: stripeRunOperation as never,
    });
  };

  /** Advance the test clock and wait for it to settle (advance is asynchronous). */
  const advanceClockTo = async (frozenTimeSeconds: number): Promise<void> => {
    await stripe('POST', `/test_helpers/test_clocks/${clockId}/advance`, {
      frozen_time: frozenTimeSeconds,
    });
    for (let i = 0; i < 90; i++) {
      const clock = await stripe('GET', `/test_helpers/test_clocks/${clockId}`);
      if (clock.status === 'ready') return;
      if (clock.status === 'internal_failure') {
        throw new Error('Stripe test clock advance failed');
      }
      await sleep(2000);
    }
    throw new Error('Stripe test clock did not become ready within the timeout');
  };

  const readSubscription = async (): Promise<Record<string, unknown>> =>
    stripe('GET', `/subscriptions/${subscriptionId}`);

  const attachDefaultPaymentMethod = async (paymentMethodId: string): Promise<void> => {
    await stripe('POST', `/payment_methods/${paymentMethodId}/attach`, {
      customer: stripeCustomerId,
    });
    await stripe('POST', `/customers/${stripeCustomerId}`, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });
  };

  beforeAll(async () => {
    // Choose the backend: the in-process mock (default) or real Stripe (opt-in).
    if (USE_REAL_STRIPE) {
      stripeBaseUrl = REAL_STRIPE_BASE;
    } else {
      mockServer = await startMockStripeServer();
      stripeBaseUrl = mockServer.baseUrl;
    }

    // 1. A product + a recurring monthly price.
    productId = String((await stripe('POST', '/products', { name: 'D-196 S5 access' })).id);
    priceId = String(
      (
        await stripe('POST', '/prices', {
          product: productId,
          unit_amount: 1500,
          currency: 'usd',
          recurring: { interval: 'month' },
        })
      ).id,
    );

    // 2. A test clock frozen at "now", and a customer bound to it.
    clockId = String(
      (await stripe('POST', '/test_helpers/test_clocks', { frozen_time: NOW_S })).id,
    );
    stripeCustomerId = String(
      (await stripe('POST', '/customers', { test_clock: clockId, name: 'S5 buyer' })).id,
    );

    // 3. A succeeding test card as the default, then a subscription (→ active).
    await attachDefaultPaymentMethod('pm_card_visa');
    const sub = await stripe('POST', '/subscriptions', {
      customer: stripeCustomerId,
      items: [{ price: priceId }],
    });
    subscriptionId = String(sub.id);

    // 4. Real local stores + the real lifecycle + the reconciler over real Stripe.
    db = new Database(':memory:');
    contractStore = createContractStore(db, { now: () => Date.now() });
    ensureChatInboundTokenSchema(db);
    inboundTokenStore = createChatInboundTokenStore(db);
    sellerStore = createSellerStore(db);
    sellerClaimStore = createSellerClaimStore(db);
    lifecycle = createSellerCustomerAccessLifecycle({
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
      mintedBy: 'seller:s5',
      now: () => Date.now(),
      transaction: (fn) => contractStore.transaction(fn),
    });

    // A tier bound to a real template contract (what `stripe-entitlement-sync`
    // mints per feature). One tier is enough for the status/period arc.
    const templateContractId = 'ct_template_s5_basic';
    const template: ContractDefinition = {
      contract_id: templateContractId,
      minted_at: Date.now() - 10_000,
      minted_by: 'owner:s5',
      display_name: 'Template basic',
      scope: { operation_ids: [`${templateContractId}.op`] },
      door_types: ['mcp'],
      grant_kind: 'customer_template',
    };
    contractStore.put(CONTRACT_DEFINITION_SCOPE, [templateContractId], template);
    sellerStore.upsertTier({
      tier_id: 'tier_s5_basic',
      door_id: 'door_s5',
      lifecycle_source: 'stripe',
      entitlement_key: 'basic',
      display_name: 'Basic',
      template_contract_id: templateContractId,
      usage_policy_json: {},
      now: Date.now(),
    });

    reconcileDeps = buildReconcileDeps();
  }, 180_000);

  afterAll(async () => {
    // Deleting the test clock cascades its customer + subscription. Best-effort.
    if (clockId) {
      try {
        await stripe('DELETE', `/test_helpers/test_clocks/${clockId}`);
      } catch {
        // A cleanup failure must not mask a test failure.
      }
    }
    db?.close();
    if (mockServer) await mockServer.close();
  });

  it('phase 1 — issue: a paid subscription mints an active local customer bound to the sub', async () => {
    const sub = await readSubscription();
    expect(sub.status).toBe('active');
    const periodEndMs = subscriptionPeriodEndSeconds(sub) * 1000;

    const issued = lifecycle.issueCustomer({
      lifecycle_source: 'stripe',
      door_id: 'door_s5',
      source_customer_id: stripeCustomerId,
      entitlement_key: 'basic',
      current_period_end: periodEndMs,
      source_status: 'active',
      external_subscription_id: subscriptionId,
    });
    localCustomerId = issued.customer.customer_id;
    issuedTokenId = issued.customer.inbound_token_id!;

    expect(issued.customer.access_state).toBe('active');
    expect(issued.customer.current_period_end).toBe(periodEndMs);
    expect(issued.customer.external_subscription_id).toBe(subscriptionId);
    expect(issuedTokenId).toBeTruthy();
    // Grace window is stamped ahead of the paid period end.
    expect(issued.customer.grace_until).toBe(periodEndMs + DEFAULT_GRACE_MS);
  }, 60_000);

  it('phase 2 — reissue: rotates the bearer AND the contract, preserving access', async () => {
    const before = sellerStore.getCustomer(localCustomerId)!;
    const reissued = lifecycle.reissueCustomerToken({ customer_id: localCustomerId });

    // A new bearer id, the same bound contract, access untouched.
    expect(reissued.customer.inbound_token_id).not.toBe(issuedTokenId);
    // ⛔ The contract ROTATES with the bearer. It used to be reused, which made
    // contract:token 1:many; a fresh contract per rotation is what keeps
    // revocation exact. The retired one is revoked, and access is unbroken.
    expect(reissued.customer.contract_id).not.toBe(before.contract_id);
    expect(reissued.customer.access_state).toBe('active');
    // The old bearer is revoked; rotation is a real security replace.
    expect(inboundTokenStore.getTokenById(issuedTokenId)?.revoked_at ?? null).not.toBeNull();

    issuedTokenId = reissued.customer.inbound_token_id!;
  }, 60_000);

  it('phase 3 — extend: advancing the clock renews the sub; the reconciler rolls the period forward', async () => {
    const before = sellerStore.getCustomer(localCustomerId)!;
    const priorEndMs = before.current_period_end!;

    // Advance just past the current period end → Stripe bills the renewal on the
    // succeeding card → the subscription rolls into its next period, still active.
    await advanceClockTo(Math.floor(priorEndMs / 1000) + 3600);
    const renewed = await readSubscription();
    expect(['active', 'trialing']).toContain(renewed.status);
    const newEndMs = subscriptionPeriodEndSeconds(renewed) * 1000;
    expect(newEndMs).toBeGreaterThan(priorEndMs);

    const out = await runSellerAccessReconcile(reconcileDeps);
    expect(out.unreadable).toBe(0);
    expect(out.extended).toBe(1);

    const row = sellerStore.getCustomer(localCustomerId)!;
    expect(row.access_state).toBe('active');
    expect(row.current_period_end).toBe(newEndMs);
    // Extend rolls the period only — the bearer is untouched.
    expect(row.inbound_token_id).toBe(issuedTokenId);
    expect(inboundTokenStore.getTokenById(issuedTokenId)?.revoked_at ?? null).toBeNull();
  }, 180_000);

  it('phase 4 — fail: a failed renewal (past_due) does NOT close — dunning is grace, not revocation', async () => {
    const before = sellerStore.getCustomer(localCustomerId)!;

    // Swap to a card that FAILS at charge time, then advance past the period end
    // → the renewal invoice fails → the subscription enters `past_due`.
    await attachDefaultPaymentMethod(MOCK_FAILING_PAYMENT_METHOD);
    await advanceClockTo(Math.floor(before.current_period_end! / 1000) + 3600);
    const failed = await readSubscription();
    // The expected deterministic immediate state is `past_due` (retries pending),
    // which the reconciler treats as LIVE — it must not cut off a customer whose
    // next retry may succeed (seller-access-reconcile.ts ACCESS_LIVE_STATUSES).
    expect(['past_due', 'active', 'unpaid']).toContain(failed.status);

    const out = await runSellerAccessReconcile(reconcileDeps);
    expect(out.unreadable).toBe(0);

    const row = sellerStore.getCustomer(localCustomerId)!;
    if (failed.status === 'unpaid') {
      // If the account's dunning reached `unpaid`, the seller's status policy
      // enters GRACE — access continues, the bearer survives.
      expect(out.closed).toBe(1);
      expect(row.access_state).toBe('grace');
      expect(inboundTokenStore.getTokenById(issuedTokenId)?.revoked_at ?? null).toBeNull();
    } else {
      // The common `past_due` path: no close, access stays live.
      expect(out.closed).toBe(0);
      expect(row.access_state).toBe('active');
      expect(inboundTokenStore.getTokenById(issuedTokenId)?.revoked_at ?? null).toBeNull();
    }
  }, 180_000);

  it('phase 5 — close: a canceled subscription closes the customer and revokes the bearer', async () => {
    // Cancel immediately → status `canceled`, the reconciler's terminal lane.
    const canceled = await stripe('DELETE', `/subscriptions/${subscriptionId}`);
    expect(canceled.status).toBe('canceled');

    const out = await runSellerAccessReconcile(reconcileDeps);
    expect(out.unreadable).toBe(0);
    expect(out.closed).toBe(1);

    const row = sellerStore.getCustomer(localCustomerId)!;
    expect(row.access_state).toBe('closed');
    // The provider's raw word is recorded as evidence; the local reason is derived.
    expect(row.source_status).toBe('canceled');
    // A full close revokes the bearer, not just the row.
    expect(inboundTokenStore.getTokenById(issuedTokenId)?.revoked_at ?? null).not.toBeNull();

    // A closed customer drops out of the reconciler's sweep set entirely.
    const after = await runSellerAccessReconcile(reconcileDeps);
    expect(after.swept).toBe(0);
  }, 180_000);
});
