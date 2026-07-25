/** D-196 §4.5 ingress piece 1 — `order.entitlement_key`.
 *
 *  The tier an order SELLS is a fact of the ORDER, snapshotted at open from the
 *  opening recipe and immutable after. Fulfilment issues access from this
 *  snapshot — never from its own dish — so a mis-set dish cannot issue a tier
 *  the order never sold (the two-sources-of-truth correction in the ingress
 *  handover §5).
 *
 *  Through a REAL SQLite database and the REAL store, per the slice-1c lesson:
 *  the schema IS the gate, so it is tested through the gate.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createSellerStore,
  ensureSellerSchema,
  SELLER_ORDERS_TABLE,
  type SellerStore,
} from '../storage/seller-store.js';
import {
  createSellerOrderStore,
  type SellerOrderStore,
} from '../storage/seller-order-store.js';

const OFFER = 'pro-tier-sub';
const NOW = 1_000;

let db: Database.Database;
let seller: SellerStore;
let orders: SellerOrderStore;
let handleSeq: number;

const testHandle = (): string => {
  handleSeq += 1;
  return `oh_${String(handleSeq).padStart(64, '0')}`;
};

const activeOffer = (): void => {
  seller.ensureOffer({
    offer_id: OFFER,
    kind: 'document',
    display_name: 'Pro tier',
    description: 'Monthly pro access',
    pricing_kind: 'fixed',
    amount_minor: 990,
    currency: 'USD',
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

beforeEach(() => {
  db = new Database(':memory:');
  seller = createSellerStore(db);
  orders = createSellerOrderStore(db, { newHandle: testHandle });
  handleSeq = 0;
});

describe('D-196 — the `entitlement_key` column', () => {
  it('exists on a fresh schema', () => {
    const columns = (
      db.prepare(`PRAGMA table_info(${SELLER_ORDERS_TABLE})`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toContain('entitlement_key');
  });

  it('is added to an orders table that predates it', () => {
    db.exec(`ALTER TABLE ${SELLER_ORDERS_TABLE} DROP COLUMN entitlement_key`);
    ensureSellerSchema(db);
    const columns = (
      db.prepare(`PRAGMA table_info(${SELLER_ORDERS_TABLE})`).all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toContain('entitlement_key');
  });
});

describe('D-196 — snapshot at open', () => {
  it('snapshots the supplied key onto the row', () => {
    activeOffer();
    const { order } = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'seller_customer',
      origin_ref: 'in_00001',
      entitlement_key: 'pro',
      now: NOW,
    });
    expect(order.entitlement_key).toBe('pro');
  });

  it('defaults to null for an order that sells no standing access', () => {
    activeOffer();
    const { order } = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: 'sub_1',
      now: NOW,
    });
    expect(order.entitlement_key).toBeNull();
  });

  it('survives the payment leg untouched — no mutator can move it', () => {
    activeOffer();
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'seller_customer',
      origin_ref: 'in_00001',
      entitlement_key: 'pro',
      now: NOW,
    });
    const attached = orders.attachOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: opened.order.revision,
      provider: 'stripe',
      provider_session_id: 'cs_test_1',
      now: NOW,
    });
    const confirmed = orders.confirmOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: attached.order.revision,
      evidence: {
        provider: 'stripe',
        provider_session_id: 'cs_test_1',
        provider_payment_id: 'pi_test_1',
        client_reference_id: opened.correlation.client_reference_id,
        payment_status: 'paid',
        amount_total: 990,
        currency: 'USD',
      },
      now: NOW,
    });
    expect(confirmed.order.phase).toBe('paid');
    expect(confirmed.order.entitlement_key).toBe('pro');
  });
});

describe('D-196 — the replay fence', () => {
  it('converges a replay that names the SAME entitlement', () => {
    activeOffer();
    const first = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'seller_customer',
      origin_ref: 'in_00001',
      entitlement_key: 'pro',
      now: NOW,
    });
    const replay = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'seller_customer',
      origin_ref: 'in_00001',
      entitlement_key: 'pro',
      now: NOW + 5,
    });
    expect(replay.result).toBe('existing');
    expect(replay.order.order_key).toBe(first.order.order_key);
  });

  it('converges a replay that does not re-assert what the order sells', () => {
    activeOffer();
    orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'seller_customer',
      origin_ref: 'in_00001',
      entitlement_key: 'pro',
      now: NOW,
    });
    const replay = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'seller_customer',
      origin_ref: 'in_00001',
      now: NOW + 5,
    });
    expect(replay.result).toBe('existing');
    expect(replay.order.entitlement_key).toBe('pro');
  });

  /** ⛔ Two flows colliding on one order key must surface LOUDLY. The silent
   *  dedup this refuses is exactly the hazard the owner's invoice-keyed
   *  `origin_ref` ruling exists to prevent: a second open absorbed as "a replay
   *  of the first" while believing it sold something else. */
  it('refuses to reopen an order under a DIFFERENT entitlement', () => {
    activeOffer();
    orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'seller_customer',
      origin_ref: 'in_00001',
      entitlement_key: 'pro',
      now: NOW,
    });
    expect(() =>
      orders.openOrder({
        offer_id: OFFER,
        origin_kind: 'seller_customer',
        origin_ref: 'in_00001',
        entitlement_key: 'team',
        now: NOW + 5,
      }),
    ).toThrow(/sells entitlement 'pro'/);
  });

  it('refuses to claim an entitlement for an order opened without one', () => {
    activeOffer();
    orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: 'sub_1',
      now: NOW,
    });
    expect(() =>
      orders.openOrder({
        offer_id: OFFER,
        origin_kind: 'reception_submission',
        origin_ref: 'sub_1',
        entitlement_key: 'pro',
        now: NOW + 5,
      }),
    ).toThrow(/sells entitlement 'null'/);
  });
});

// D-196 1d — the offer's non-secret fulfillment_config, snapshotted at open.
describe('D-196 1d — fulfillment_config snapshot at open', () => {
  const activePassOffer = (): void => {
    seller.ensureOffer({
      offer_id: OFFER,
      kind: 'access',
      display_name: 'Day pass',
      description: 'A one-day access pass',
      pricing_kind: 'fixed',
      amount_minor: 500,
      currency: 'USD',
      fulfillment_config: { entitlement_key: 'day-pass', url: 'https://x.example' },
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

  it('snapshots the offer config onto the row and survives the payment leg', () => {
    activePassOffer();
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: 'sub_1',
      entitlement_key: 'day-pass',
      now: NOW,
    });
    expect(opened.order.fulfillment_config).toEqual({
      entitlement_key: 'day-pass',
      url: 'https://x.example',
    });

    const attached = orders.attachOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: opened.order.revision,
      provider: 'stripe',
      provider_session_id: 'cs_pass_1',
      now: NOW,
    });
    const confirmed = orders.confirmOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: attached.order.revision,
      evidence: {
        provider: 'stripe',
        provider_session_id: 'cs_pass_1',
        provider_payment_id: 'pi_pass_1',
        client_reference_id: opened.correlation.client_reference_id,
        payment_status: 'paid',
        amount_total: 500,
        currency: 'USD',
      },
      now: NOW,
    });
    // Immutable through the mutation — no mutator touches it.
    expect(confirmed.order.fulfillment_config).toEqual({
      entitlement_key: 'day-pass',
      url: 'https://x.example',
    });
  });

  it('defaults to null when the offer carries no config', () => {
    activeOffer();
    const { order } = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: 'sub_1',
      now: NOW,
    });
    expect(order.fulfillment_config).toBeNull();
  });
});
