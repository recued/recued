/** D-207 slice 3c — the reception runner opens the order, and the recipe only renders it.
 *
 *  ## What this slice actually settles
 *
 *  The owner installs a pack, customizes the form's labels, creates an offer in
 *  Seller → Offers, and points ONE recipe variable at it. That variable is the whole
 *  binding between a form and a thing to sell (§4.4: an order exists iff there is an
 *  offer). Recued does NOT verify that the form's labels agree with the offer row — it
 *  cannot be a money bug, because no op takes a price and the amount is enforced at the
 *  hosted checkout and again by the underpay fence.
 *
 *  ## Why the RUNNER opens the order and not a recipe op
 *
 *  Every `core.seller.order.*` write is `ask`-tier, and an anonymous actor is pinned to
 *  the `read` ceiling, so a recipe-dispatched `order.open` would HOLD at the D-157 gate.
 *  A held run returns no output — so the visitor would land on a thank-you page carrying
 *  no way to pay. That is the slice-1c lie, and it is what these tests keep dead.
 *
 *  Driven through a REAL SQLite seller store: slice 1c shipped INERT to production
 *  because every door test faked the one store that actually validates. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

import type { ContractDefinition, ReceptionOrderContext } from '@recued/contracts';

import { createSellerStore, type SellerStore } from '../storage/seller-store.js';
import {
  createSellerOrderStore,
  type SellerOrderStore,
} from '../storage/seller-order-store.js';
import { createReceptionRecipeRunner } from '../reception-recipe-runner.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';

const NOW = 1_000;
const OFFER = 'research-brief';
const CHECKOUT = 'https://buy.stripe.com/test_abc123';

let db: Database.Database;
let seller: SellerStore;
let orders: SellerOrderStore;

const activeOffer = (over: { checkout_url?: string | null } = {}): void => {
  seller.ensureOffer({
    offer_id: OFFER,
    kind: 'document',
    display_name: 'One research brief',
    description: 'One reviewed PDF, delivered in 48h',
    pricing_kind: 'fixed',
    amount_minor: 12_500,
    currency: 'USD',
    checkout_url: over.checkout_url === undefined ? CHECKOUT : over.checkout_url,
    now: NOW,
  });
  seller.transitionOfferState({
    offer_id: OFFER,
    expected_state: 'draft',
    expected_updated_at: NOW,
    next_state: 'active',
    now: NOW,
  });
};

const handleExecute = vi.fn();

vi.mock('../execute-handler.js', async (orig) => {
  const actual = await orig<typeof import('../execute-handler.js')>();
  return {
    ...actual,
    handleExecute: (deps: { __spy?: (...a: unknown[]) => unknown }, req: unknown, opts: unknown) =>
      (deps.__spy as (...a: unknown[]) => unknown)(deps, req, opts),
  };
});

const runner = (config: Record<string, unknown> | undefined, withSeller = true) => {
  const def = {
    contract_id: 'door_1',
    status: 'active',
    minted_at: NOW,
    door_types: ['reception'],
    scope: { operation_ids: [], ingredient_ids: [] },
  } as unknown as ContractDefinition;

  return createReceptionRecipeRunner({
    executeDeps: { __spy: handleExecute } as never,
    pairStore: {
      findByEndpoint: () => ({
        endpoint_id: 'ep1',
        binding: { recipe_id: 'sell-a-brief' },
        contract_id: 'door_1',
      }),
    } as unknown as ReceptionIntakeRecipePairStore,
    definitionStore: {
      get: (id: string) => (id === 'door_1' ? def : null),
    } as unknown as ContractDefinitionStore,
    resolveConfig: () => config,
    ...(withSeller ? { seller: { offers: seller, orders } } : {}),
    now: () => NOW,
  });
};

const submit = (config: Record<string, unknown> | undefined, withSeller = true) =>
  runner(config, withSeller).run({
    endpoint_id: 'ep1',
    submission_id: 'sub_1',
    submission: { email: 'v@example.com' },
  });

/** The `context.reception_order` the recipe was handed. */
const handedOrder = (): ReceptionOrderContext | undefined => {
  const [, req] = handleExecute.mock.calls[0] as unknown as [
    unknown,
    { context: { reception_order?: ReceptionOrderContext } },
  ];
  return req.context.reception_order;
};

beforeEach(() => {
  db = new Database(':memory:');
  seller = createSellerStore(db);
  orders = createSellerOrderStore(db);
  handleExecute.mockReset();
  handleExecute.mockResolvedValue({ success: true, output: { render: [] }, errors: [] });
});

describe('D-207 slice 3c — an order exists iff there is an offer (§4.4)', () => {
  it('a recipe naming an offer gets an order — opened by the SERVER, not by a recipe op', async () => {
    activeOffer();
    const out = await submit({ seller_offer_id: OFFER });

    expect(out.kind).toBe('completed');

    const order = handedOrder()!;
    expect(order.product_name).toBe('One research brief');
    expect(order.amount_minor).toBe(12_500);
    expect(order.currency).toBe('USD');

    // The order is REALLY in the store — this is not a projection the runner invented.
    const rows = orders.listOrders({ origin_ref: 'sub_1' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.offer_id).toBe(OFFER);
    expect(rows[0]!.origin_kind).toBe('reception_submission');
  });

  it('a plain intake recipe names no offer — no order, and the context is untouched', async () => {
    activeOffer();
    const out = await submit({ some_other_var: 'x' });

    expect(out.kind).toBe('completed');
    expect(handedOrder()).toBeUndefined();
    expect(orders.listOrders({})).toHaveLength(0);

    // A non-selling door sees EXACTLY what it saw before slice 3c.
    const [, req] = handleExecute.mock.calls[0] as unknown as [unknown, { context: unknown }];
    expect(req.context).toEqual({ reception_submission: { email: 'v@example.com' } });
  });
});

describe('D-207 slice 3c — F7: the recipe is handed the HANDLE, never the KEY', () => {
  it('the checkout link carries the CSPRNG handle as its client reference', async () => {
    activeOffer();
    await submit({ seller_offer_id: OFFER });

    const order = handedOrder()!;
    const row = orders.listOrders({ origin_ref: 'sub_1' })[0]!;

    const url = new URL(order.checkout_url);
    expect(url.searchParams.get('client_reference_id')).toBe(row.order_handle);
    expect(order.order_handle).toBe(row.order_handle);
  });

  it('NOTHING the recipe receives carries the guessable order_key', async () => {
    activeOffer();
    await submit({ seller_offer_id: OFFER });

    const order = handedOrder()!;
    const row = orders.listOrders({ origin_ref: 'sub_1' })[0]!;

    // ⛔ The fence is the ABSENT FIELD. `order_key` is deterministic in (offer, origin) —
    // that is what makes a re-drive converge, and exactly what makes it GUESSABLE. This
    // projection is rendered into a public page and its URL travels through a stranger's
    // browser. `core.seller.order.get` takes EITHER id at `read` risk, so it ADMITS on a
    // public door: a key here would hand every visitor an address for other people's
    // orders. Serialize the WHOLE thing and prove the key appears nowhere in it.
    expect(row.order_key.length).toBeGreaterThan(0); // non-vacuity: there IS a key to leak
    expect(JSON.stringify(order)).not.toContain(row.order_key);
  });
});

describe('D-207 slice 3c — a re-drive must not mint a second order', () => {
  it('the same submission converges on one order and one checkout link', async () => {
    activeOffer();

    await submit({ seller_offer_id: OFFER });
    const first = handedOrder()!;

    handleExecute.mockClear();
    await submit({ seller_offer_id: OFFER });
    const second = handedOrder()!;

    // One purchase, one order. A rotated handle would orphan the payment of a visitor
    // already holding the first link.
    expect(orders.listOrders({})).toHaveLength(1);
    expect(second.order_handle).toBe(first.order_handle);
    expect(second.checkout_url).toBe(first.checkout_url);
  });
});

/** ⛔ Every one of these REFUSES rather than falling through to plain intake. The owner
 *  built a form to sell something; a visitor who filled it in came to buy. Thanking them
 *  and never asking for money is the exact bug this slice exists to keep dead. */
describe('D-207 slice 3c — a form that cannot sell REFUSES; it never says thank-you', () => {
  it('an offer with no hosted-checkout link', async () => {
    activeOffer({ checkout_url: null });
    const out = await submit({ seller_offer_id: OFFER });

    expect(out.kind).toBe('failed');
    expect(handleExecute).not.toHaveBeenCalled();
  });

  it('an offer that does not exist', async () => {
    const out = await submit({ seller_offer_id: 'no-such-offer' });
    expect(out.kind).toBe('failed');
    expect(handleExecute).not.toHaveBeenCalled();
  });

  it('an offer that is not active — a draft or withdrawn offer cannot be sold', async () => {
    seller.ensureOffer({
      offer_id: OFFER,
      kind: 'document',
      display_name: 'One research brief',
      description: 'Not launched yet',
      pricing_kind: 'fixed',
      amount_minor: 12_500,
      currency: 'USD',
      checkout_url: CHECKOUT,
      now: NOW,
    }); // left in `draft`
    const out = await submit({ seller_offer_id: OFFER });

    expect(out.kind).toBe('failed');
    expect(orders.listOrders({})).toHaveLength(0);
  });

  it('a server with no seller substrate at all', async () => {
    const out = await submit({ seller_offer_id: OFFER }, false);
    expect(out.kind).toBe('failed');
    expect(handleExecute).not.toHaveBeenCalled();
  });
});
