/** D-207 order-is-the-lifecycle — the owner Orders view read model.
 *
 *  `server.seller.listOrders` over a REAL SQLite database and the REAL order
 *  store. The handler returns a flat, most-recent-first list plus a `truncated`
 *  flag; the VIEW groups by `sellerOrderBucket(phase)`, so these tests assert the
 *  flat contract and prove the phases returned map to the expected buckets. */

import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  RpcError,
  SELLER_ORDER_LIST_MAX_LIMIT,
  sellerOrderBucket,
  type SellerOrderBucket,
  type SellerOrderPhase,
} from '@recued/contracts';

import { listSellerOrders } from '../seller-overview-handler.js';
import {
  createSellerOrderStore,
  type SellerOrderStore,
} from '../storage/seller-order-store.js';
import { createSellerStore, type SellerStore } from '../storage/seller-store.js';

const OFFER = 'paid-doc';
const UNPRICED_OFFER = 'quote-doc';
const NOW = 1_000_000;

let db: Database.Database;
let sellerStore: SellerStore;
let sellerOrderStore: SellerOrderStore;

const activeOffer = (
  offer_id: string,
  amount: number | null,
  now: number,
): void => {
  sellerStore.ensureOffer({
    offer_id,
    kind: 'document',
    display_name: `Offer ${offer_id}`,
    description: 'One reviewed PDF',
    pricing_kind: amount === null ? 'unspecified' : 'fixed',
    amount_minor: amount,
    currency: amount === null ? null : 'USD',
    checkout_url: 'https://buy.stripe.com/test_link',
    now,
  });
  sellerStore.transitionOfferState({
    offer_id,
    expected_state: 'draft',
    expected_updated_at: now,
    next_state: 'active',
    now,
  });
};

/** Open one order and optionally drive it to a target phase through the generic
 *  transition (evidence phases are unreachable here — that is by design). */
const openOrderInPhase = (
  origin_ref: string,
  now: number,
  target?: SellerOrderPhase,
): void => {
  const opened = sellerOrderStore.openOrder({
    offer_id: OFFER,
    origin_kind: 'reception_submission',
    origin_ref,
    now,
  });
  if (target !== undefined) {
    sellerOrderStore.transitionOrder({
      order_key: opened.order.order_key,
      expected_revision: opened.order.revision,
      next_phase: target,
      now,
    });
  }
};

const bucketCounts = (
  phases: readonly SellerOrderPhase[],
): Record<SellerOrderBucket, number> => {
  const counts: Record<SellerOrderBucket, number> = {
    active: 0,
    needs_owner: 0,
    timed_out: 0,
    closed: 0,
  };
  for (const phase of phases) counts[sellerOrderBucket(phase)] += 1;
  return counts;
};

beforeEach(() => {
  db = new Database(':memory:');
  sellerStore = createSellerStore(db);
  sellerOrderStore = createSellerOrderStore(db);
});

describe('listSellerOrders', () => {
  it('is not_configured when no order store is wired', () => {
    let thrown: unknown;
    try {
      listSellerOrders({ sellerStore }, {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RpcError);
    expect((thrown as RpcError).code).toBe('not_configured');
    expect((thrown as RpcError).status).toBe(503);
  });

  it('returns an empty, untruncated list when there are no orders', () => {
    const result = listSellerOrders({ sellerStore, sellerOrderStore }, {});
    expect(result.orders).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('returns orders most-recent-first spanning every lifecycle bucket', () => {
    activeOffer(OFFER, 12_500, NOW);
    activeOffer(UNPRICED_OFFER, null, NOW);

    // Four fixed-price orders driven to distinct buckets, plus an unpriced order
    // that opens straight into `pricing` (needs_owner). Increasing `now` pins
    // the most-recent-first ordering.
    openOrderInPhase('sub_active', NOW + 1); // draft -> active
    openOrderInPhase('sub_closed', NOW + 2, 'cancelled'); // -> closed
    openOrderInPhase('sub_timed_out', NOW + 3, 'expired'); // -> timed_out
    openOrderInPhase('sub_failed', NOW + 4, 'failed'); // -> needs_owner
    sellerOrderStore.openOrder({
      offer_id: UNPRICED_OFFER,
      origin_kind: 'reception_submission',
      origin_ref: 'sub_pricing',
      now: NOW + 5,
    }); // -> pricing (needs_owner)

    const result = listSellerOrders({ sellerStore, sellerOrderStore }, {});

    expect(result.orders).toHaveLength(5);
    expect(result.truncated).toBe(false);
    // Most-recent-first: the last opened order leads.
    expect(result.orders[0]?.origin_ref).toBe('sub_pricing');
    expect(result.orders.map((o) => o.created_at)).toEqual(
      [...result.orders.map((o) => o.created_at)].sort((a, b) => b - a),
    );

    const counts = bucketCounts(result.orders.map((o) => o.phase));
    expect(counts).toEqual({
      active: 1,
      needs_owner: 2,
      timed_out: 1,
      closed: 1,
    });
  });

  it('flags truncation when the clamp bounds the page, and echoes back the rows', () => {
    activeOffer(OFFER, 12_500, NOW);
    openOrderInPhase('sub_1', NOW + 1);
    openOrderInPhase('sub_2', NOW + 2);
    openOrderInPhase('sub_3', NOW + 3);

    const capped = listSellerOrders(
      { sellerStore, sellerOrderStore },
      { limit: 2 },
    );
    expect(capped.orders).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    // The two most recent survive the cap.
    expect(capped.orders.map((o) => o.origin_ref)).toEqual(['sub_3', 'sub_2']);

    const full = listSellerOrders(
      { sellerStore, sellerOrderStore },
      { limit: 100 },
    );
    expect(full.orders).toHaveLength(3);
    expect(full.truncated).toBe(false);
  });

  it('does not flag truncation when exactly the page size exists', () => {
    activeOffer(OFFER, 12_500, NOW);
    openOrderInPhase('sub_1', NOW + 1);
    openOrderInPhase('sub_2', NOW + 2);

    // Exactly `limit` orders exist and none are older. A naive `length >= limit`
    // would cry truncation here; the probe proves nothing older exists.
    const result = listSellerOrders(
      { sellerStore, sellerOrderStore },
      { limit: 2 },
    );
    expect(result.orders).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });

  it('pages forward with an offset and reports whether another page exists', () => {
    activeOffer(OFFER, 12_500, NOW);
    openOrderInPhase('sub_1', NOW + 1);
    openOrderInPhase('sub_2', NOW + 2);
    openOrderInPhase('sub_3', NOW + 3);
    openOrderInPhase('sub_4', NOW + 4);

    const first = listSellerOrders(
      { sellerStore, sellerOrderStore },
      { limit: 2, offset: 0 },
    );
    expect(first.orders.map((order) => order.origin_ref)).toEqual([
      'sub_4',
      'sub_3',
    ]);
    expect(first.truncated).toBe(true);

    const second = listSellerOrders(
      { sellerStore, sellerOrderStore },
      { limit: 2, offset: 2 },
    );
    expect(second.orders.map((order) => order.origin_ref)).toEqual([
      'sub_2',
      'sub_1',
    ]);
    expect(second.truncated).toBe(false);
  });

  it('resolves one exact order for the owner detail route', () => {
    activeOffer(OFFER, 12_500, NOW);
    openOrderInPhase('sub_detail', NOW + 1);
    const order = sellerOrderStore.listOrders({ limit: 1 })[0]!;

    expect(listSellerOrders(
      { sellerStore, sellerOrderStore },
      { order_key: order.order_key, limit: 1 },
    )).toEqual({ orders: [order], truncated: false });
    expect(listSellerOrders(
      { sellerStore, sellerOrderStore },
      { order_key: 'ord:missing', limit: 1 },
    )).toEqual({ orders: [], truncated: false });
  });

  it('rejects unknown fields and malformed page or detail arguments', () => {
    const deps = { sellerStore, sellerOrderStore };
    expect(() => listSellerOrders(deps, { bogus: 1 } as never)).toThrow(RpcError);
    expect(() => listSellerOrders(deps, { limit: -1 })).toThrow(RpcError);
    expect(() => listSellerOrders(deps, { limit: 2.5 })).toThrow(RpcError);
    expect(() => listSellerOrders(deps, { offset: -1 })).toThrow(RpcError);
    expect(() => listSellerOrders(deps, { offset: 2.5 })).toThrow(RpcError);
    expect(() => listSellerOrders(deps, { offset: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow(RpcError);
    expect(() => listSellerOrders(deps, { order_key: '' })).toThrow(RpcError);
    expect(() => listSellerOrders(deps, { order_key: 7 } as never)).toThrow(RpcError);
  });

  it('clamps an over-max limit so truncated reflects the real page size', () => {
    activeOffer(OFFER, 12_500, NOW);
    openOrderInPhase('sub_1', NOW + 1);
    // A limit above the ceiling clamps down; with one order under a huge request
    // the page is not truncated.
    const result = listSellerOrders(
      { sellerStore, sellerOrderStore },
      { limit: SELLER_ORDER_LIST_MAX_LIMIT + 1_000 },
    );
    expect(result.orders).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });
});
