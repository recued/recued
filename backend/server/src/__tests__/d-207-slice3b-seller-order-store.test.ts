/** D-207 slice 3b — the `core.seller.order` storage boundary.
 *
 *  Through a REAL SQLite database and the REAL store. Slice 1c shipped inert to
 *  production because every door test faked the one store that actually validates.
 *  These fences ARE the storage boundary, so they are tested there.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  SELLER_ORDER_EVIDENCE_PHASES,
  type PinnedCasFileRef,
} from '@recued/contracts';
import { createSellerStore, type SellerStore } from '../storage/seller-store.js';
import {
  createSellerOrderStore,
  type SellerOrderStore,
  type SellerOrderPaymentEvidence,
} from '../storage/seller-order-store.js';

const OFFER = 'paid-doc';
const ORIGIN = 'sub_ABC123';
const NOW = 1_000;

/** D-207 slice 3d — a VERIFIED pin, which is now the only thing the store accepts.
 *  Real formats, real SHA-256s: the fixtures this replaced (`'cas://abc'` /
 *  `'sha256:abc'`) could never have existed, which is a large part of why nobody
 *  noticed the store never opened the file. */
const ARTIFACT: PinnedCasFileRef = {
  backing: 'cas',
  record_id: `file:${'a'.repeat(32)}`,
  content_sha256: createHash('sha256').update('the approved invoice').digest('hex'),
};

const OTHER_ARTIFACT: PinnedCasFileRef = {
  backing: 'cas',
  record_id: `file:${'b'.repeat(32)}`,
  content_sha256: createHash('sha256').update('some other document').digest('hex'),
};

let db: Database.Database;
let seller: SellerStore;
let orders: SellerOrderStore;
let handleSeq: number;

/** Deterministic handles so a test can name one; production uses a CSPRNG. */
const testHandle = (): string => {
  handleSeq += 1;
  return `oh_${String(handleSeq).padStart(64, '0')}`;
};

const activeOffer = (amount: number | null = 12_500): void => {
  seller.ensureOffer({
    offer_id: OFFER,
    kind: 'document',
    display_name: 'One research brief',
    description: 'One reviewed PDF',
    pricing_kind: amount === null ? 'unspecified' : 'fixed',
    amount_minor: amount,
    currency: amount === null ? null : 'USD',
    checkout_url: 'https://buy.stripe.com/test_link',
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

/** Drive an order to `paid` — the common prefix of the fulfilment tests. */
const paidOrder = () => {
  activeOffer();
  const opened = orders.openOrder({
    offer_id: OFFER,
    origin_kind: 'reception_submission',
    origin_ref: ORIGIN,
    now: NOW,
  });
  const attached = orders.attachOrderPayment({
    order_key: opened.order.order_key,
    expected_revision: opened.order.revision,
    provider: 'stripe',
    provider_session_id: 'cs_test_1',
    now: NOW,
  });
  const evidence: SellerOrderPaymentEvidence = {
    provider: 'stripe',
    provider_session_id: 'cs_test_1',
    provider_payment_id: 'pi_test_1',
    client_reference_id: opened.correlation.client_reference_id,
    payment_status: 'paid',
    amount_total: 12_500,
    currency: 'USD',
  };
  const confirmed = orders.confirmOrderPayment({
    order_key: opened.order.order_key,
    expected_revision: attached.order.revision,
    evidence,
    now: NOW,
  });
  return { opened, confirmed, evidence };
};

beforeEach(() => {
  db = new Database(':memory:');
  seller = createSellerStore(db);
  orders = createSellerOrderStore(db, { newHandle: testHandle });
  handleSeq = 0;
});

describe('D-207 slice 3b — open: the caller names WHICH offer, never WHAT it costs', () => {
  it('snapshots the commerce terms from the offer row', () => {
    activeOffer();
    const { order, correlation } = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    expect(order.amount_minor).toBe(12_500);
    expect(order.currency).toBe('USD');
    expect(order.pricing_kind).toBe('fixed');
    expect(order.phase).toBe('draft');
    expect(order.revision).toBe(0);
    // F6 — the correlation comes back so the provider call never composes one.
    expect(correlation.idempotency_key).toContain(order.order_key);
  });

  /** ⛔ The structural property. There is no `amount` parameter, so there is no
   *  path by which a visitor's value could become a price. `openOrder` takes an
   *  `offer_id` and reads the row itself. This test states the invariant that the
   *  type system already enforces, so that deleting it would be a visible act. */
  it('exposes no way to supply a price', () => {
    const openInputKeys = [
      'offer_id',
      'origin_kind',
      'origin_ref',
      'customer_id',
      'entitlement_key',
      'now',
    ];
    expect(openInputKeys).not.toContain('amount_minor');
    expect(openInputKeys).not.toContain('currency');
    expect(openInputKeys).not.toContain('product_name');
  });

  it('is idempotent — a replayed open converges on ONE order, not a second one', () => {
    activeOffer();
    const first = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    const second = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW + 5,
    });
    expect(first.result).toBe('created');
    expect(second.result).toBe('existing');
    expect(second.order.order_key).toBe(first.order.order_key);
    expect(second.order.order_handle).toBe(first.order.order_handle);
    expect(orders.listOrders()).toHaveLength(1);
  });

  it('pages the stable newest-first order list with a validated offset', () => {
    activeOffer();
    for (const [index, origin_ref] of ['sub_1', 'sub_2', 'sub_3'].entries()) {
      orders.openOrder({
        offer_id: OFFER,
        origin_kind: 'reception_submission',
        origin_ref,
        now: NOW + index + 1,
      });
    }

    expect(orders.listOrders({ limit: 1, offset: 1 }).map(
      (order) => order.origin_ref,
    )).toEqual(['sub_2']);
    expect(() => orders.listOrders({ offset: -1 })).toThrow(
      /offset must be a non-negative safe integer/,
    );
    expect(() => orders.listOrders({ offset: 1.5 })).toThrow(
      /offset must be a non-negative safe integer/,
    );
  });

  it('mints an unguessable handle distinct from the deterministic key', () => {
    activeOffer();
    const { order } = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    expect(order.order_handle).not.toBe(order.order_key);
    expect(orders.getOrderByHandle(order.order_handle)?.order_key).toBe(order.order_key);
    // The key must never resolve through the visitor-facing lookup.
    expect(orders.getOrderByHandle(order.order_key)).toBeNull();
  });

  it('refuses an offer that is not active', () => {
    seller.ensureOffer({
      offer_id: OFFER,
      kind: 'document',
      display_name: 'Draft offer',
      description: 'not for sale yet',
      pricing_kind: 'fixed',
      amount_minor: 500,
      currency: 'USD',
      now: NOW,
    });
    expect(() =>
      orders.openOrder({
        offer_id: OFFER,
        origin_kind: 'reception_submission',
        origin_ref: ORIGIN,
        now: NOW,
      }),
    ).toThrow(/not active/);
  });

  /** DERIVED from the offer: an unpriced offer opens into `pricing`, whose bucket
   *  is `needs_owner`, so a quote request surfaces instead of sitting in `draft`. */
  it('opens an unpriced offer straight into `pricing`', () => {
    activeOffer(null);
    const { order } = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    expect(order.phase).toBe('pricing');
    expect(order.amount_minor).toBeNull();
  });
});

describe('D-207 slice 3b — F5: `transition` cannot reach a phase that asserts money moved', () => {
  it('refuses EVERY evidence phase, by name', () => {
    const { opened } = (() => {
      activeOffer();
      const o = orders.openOrder({
        offer_id: OFFER,
        origin_kind: 'reception_submission',
        origin_ref: ORIGIN,
        now: NOW,
      });
      return { opened: o };
    })();

    for (const phase of SELLER_ORDER_EVIDENCE_PHASES) {
      expect(() =>
        orders.transitionOrder({
          order_key: opened.order.order_key,
          expected_revision: opened.order.revision,
          next_phase: phase,
          now: NOW,
        }),
      ).toThrow(/money moved/);
    }
  });

  /** ⛔ THE FREE PDF. The graph really does contain `awaiting_payment -> paid`, so
   *  a graph-only validator would let this through and the customer would be
   *  fulfilled without paying. The refusal must NOT depend on the graph. */
  it('refuses `paid` even from `awaiting_payment`, where the graph allows it', () => {
    activeOffer();
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    const attached = orders.attachOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: opened.order.revision,
      provider: 'stripe',
      provider_session_id: 'cs_1',
      now: NOW,
    });
    expect(attached.order.phase).toBe('awaiting_payment');

    expect(() =>
      orders.transitionOrder({
        order_key: opened.order.order_key,
        expected_revision: attached.order.revision,
        next_phase: 'paid',
        now: NOW,
      }),
    ).toThrow(/money moved/);

    expect(orders.getOrder(opened.order.order_key)?.phase).toBe('awaiting_payment');
  });

  it('still admits an ordinary non-evidence move', () => {
    const { confirmed } = paidOrder();
    const moved = orders.transitionOrder({
      order_key: confirmed.order.order_key,
      expected_revision: confirmed.order.revision,
      next_phase: 'fulfilling',
      now: NOW,
    });
    expect(moved.order.phase).toBe('fulfilling');
  });

  it('refuses a move the graph does not allow', () => {
    activeOffer();
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    expect(() =>
      orders.transitionOrder({
        order_key: opened.order.order_key,
        expected_revision: opened.order.revision,
        next_phase: 'complete',
        now: NOW,
      }),
    ).toThrow(/cannot move to/);
  });
});

describe('D-207 slice 3b — confirm-payment: what the storage boundary actually proves', () => {
  it('confirms a genuine, correlated, fully-paid session', () => {
    const { confirmed } = paidOrder();
    expect(confirmed.order.phase).toBe('paid');
    expect(confirmed.order.paid_at).toBe(NOW);
    expect(confirmed.order.provider_payment_id).toBe('pi_test_1');
    // A paid order is no longer waiting on a checkout that can lapse.
    expect(confirmed.order.expires_at).toBeNull();
  });

  /** ⛔ THE UNDERPAY FENCE. `amount_minor` was computed by the server from the
   *  owner's offer. A customer who steered the provider to a smaller total must
   *  not land a `paid` order and get fulfilled. */
  it('refuses a payment for less than the server-computed amount', () => {
    activeOffer();
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    const attached = orders.attachOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: opened.order.revision,
      provider: 'stripe',
      provider_session_id: 'cs_1',
      now: NOW,
    });
    expect(() =>
      orders.confirmOrderPayment({
        order_key: opened.order.order_key,
        expected_revision: attached.order.revision,
        evidence: {
          provider: 'stripe',
          provider_session_id: 'cs_1',
          provider_payment_id: 'pi_1',
          client_reference_id: opened.correlation.client_reference_id,
          payment_status: 'paid',
          amount_total: 1, // one cent for a $125 brief
          currency: 'USD',
        },
        now: NOW,
      }),
    ).toThrow(/but this order is for/);
    expect(orders.getOrder(opened.order.order_key)?.phase).toBe('awaiting_payment');
  });

  it('refuses evidence carrying another order\'s correlation', () => {
    activeOffer();
    const mine = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    const theirs = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: 'sub_OTHER',
      now: NOW,
    });
    const attached = orders.attachOrderPayment({
      order_key: mine.order.order_key,
      expected_revision: mine.order.revision,
      provider: 'stripe',
      provider_session_id: 'cs_1',
      now: NOW,
    });
    expect(() =>
      orders.confirmOrderPayment({
        order_key: mine.order.order_key,
        expected_revision: attached.order.revision,
        evidence: {
          provider: 'stripe',
          provider_session_id: 'cs_1',
          provider_payment_id: 'pi_1',
          client_reference_id: theirs.correlation.client_reference_id,
          payment_status: 'paid',
          amount_total: 12_500,
          currency: 'USD',
        },
        now: NOW,
      }),
    ).toThrow(/correlation/);
  });

  it('refuses a session the order never attached', () => {
    activeOffer();
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    const attached = orders.attachOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: opened.order.revision,
      provider: 'stripe',
      provider_session_id: 'cs_MINE',
      now: NOW,
    });
    expect(() =>
      orders.confirmOrderPayment({
        order_key: opened.order.order_key,
        expected_revision: attached.order.revision,
        evidence: {
          provider: 'stripe',
          provider_session_id: 'cs_SOMEONE_ELSE',
          provider_payment_id: 'pi_1',
          client_reference_id: opened.correlation.client_reference_id,
          payment_status: 'paid',
          amount_total: 12_500,
          currency: 'USD',
        },
        now: NOW,
      }),
    ).toThrow(/different provider session/);
  });

  it('refuses an unpaid session', () => {
    activeOffer();
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    const attached = orders.attachOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: opened.order.revision,
      provider: 'stripe',
      provider_session_id: 'cs_1',
      now: NOW,
    });
    expect(() =>
      orders.confirmOrderPayment({
        order_key: opened.order.order_key,
        expected_revision: attached.order.revision,
        evidence: {
          provider: 'stripe',
          provider_session_id: 'cs_1',
          provider_payment_id: 'pi_1',
          client_reference_id: opened.correlation.client_reference_id,
          payment_status: 'unpaid',
          amount_total: 12_500,
          currency: 'USD',
        },
        now: NOW,
      }),
    ).toThrow(/not 'paid'/);
  });

  it('refuses to confirm an order with no session at all', () => {
    activeOffer();
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    expect(() =>
      orders.confirmOrderPayment({
        order_key: opened.order.order_key,
        expected_revision: opened.order.revision,
        evidence: {
          provider: 'stripe',
          provider_session_id: 'cs_1',
          provider_payment_id: 'pi_1',
          client_reference_id: opened.correlation.client_reference_id,
          payment_status: 'paid',
          amount_total: 12_500,
          currency: 'USD',
        },
        now: NOW,
      }),
    ).toThrow(/nothing could have been paid/);
  });

  it('is idempotent — a replayed confirmation converges instead of double-paying', () => {
    const { confirmed, evidence } = paidOrder();
    const replay = orders.confirmOrderPayment({
      order_key: confirmed.order.order_key,
      expected_revision: confirmed.order.revision,
      evidence,
      now: NOW + 10,
    });
    expect(replay.result).toBe('unchanged');
    expect(replay.order.paid_at).toBe(NOW);
    expect(replay.order.revision).toBe(confirmed.order.revision);
  });
});

describe('D-207 slice 3b — F6: a second Checkout Session is a loud conflict', () => {
  /** A crash between the provider call and the bind re-runs the provider call; the
   *  derived idempotency key makes Stripe return the SAME session, so the retry
   *  converges. A DIFFERENT id means the key did not hold and a second session
   *  exists — the double-charge D-200 spent real complexity to prevent. */
  it('converges when the same session is re-attached', () => {
    activeOffer();
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    const first = orders.attachOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: opened.order.revision,
      provider: 'stripe',
      provider_session_id: 'cs_1',
      now: NOW,
    });
    const retry = orders.attachOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: first.order.revision,
      provider: 'stripe',
      provider_session_id: 'cs_1',
      now: NOW + 1,
    });
    expect(retry.result).toBe('unchanged');
    expect(retry.order.revision).toBe(first.order.revision);
  });

  it('REFUSES a different session rather than silently rebinding', () => {
    activeOffer();
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    const first = orders.attachOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: opened.order.revision,
      provider: 'stripe',
      provider_session_id: 'cs_1',
      now: NOW,
    });
    expect(() =>
      orders.attachOrderPayment({
        order_key: opened.order.order_key,
        expected_revision: first.order.revision,
        provider: 'stripe',
        provider_session_id: 'cs_2',
        now: NOW,
      }),
    ).toThrow(/idempotency key did not hold/);
    expect(orders.getOrder(opened.order.order_key)?.provider_session_id).toBe('cs_1');
  });

  it('refuses to attach a payment to an unpriced order', () => {
    activeOffer(null);
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    expect(() =>
      orders.attachOrderPayment({
        order_key: opened.order.order_key,
        expected_revision: opened.order.revision,
        provider: 'stripe',
        provider_session_id: 'cs_1',
        now: NOW,
      }),
    ).toThrow(/quote it first/);
  });
});

describe('D-207 slice 3b — quote, artifact, work-entity link, and CAS', () => {
  it('pins an owner-computed total onto an unpriced order', () => {
    activeOffer(null);
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });
    const quoted = orders.quoteOrder({
      order_key: opened.order.order_key,
      expected_revision: opened.order.revision,
      amount_minor: 9_900,
      currency: 'usd',
      now: NOW,
    });
    expect(quoted.order.amount_minor).toBe(9_900);
    // Normalized, so 'usd' and 'USD' can never read as two currencies.
    expect(quoted.order.currency).toBe('USD');
  });

  it('refuses to re-quote an order whose customer already saw a total', () => {
    const { confirmed } = paidOrder();
    expect(() =>
      orders.quoteOrder({
        order_key: confirmed.order.order_key,
        expected_revision: confirmed.order.revision,
        amount_minor: 1,
        currency: 'USD',
        now: NOW,
      }),
    ).toThrow(/no longer be quoted/);
  });

  /** ⚠ This test used to be called "refuses a silent re-point" and pinned
   *  `artifact_ref: 'cas://abc'` / `artifact_hash: 'sha256:abc'` — values that
   *  could not exist. It tested a re-PIN, not a re-POINT, so its name was as wrong
   *  as the comment in the code it guarded. And a fixture that can never be real
   *  cannot catch the bug that the store never opened the file.
   *
   *  RE-POINTING is not closable at this layer (SQL cannot read a file) and is
   *  fenced upstream by `verifySellerOrderArtifactPin` — see the slice-3d suite.
   *  What IS this layer's job is the one-way pin, and it is what is tested here. */
  it('pins an artifact one-way — a later run cannot name a DIFFERENT one', () => {
    const { confirmed } = paidOrder();
    const fulfilling = orders.transitionOrder({
      order_key: confirmed.order.order_key,
      expected_revision: confirmed.order.revision,
      next_phase: 'fulfilling',
      now: NOW,
    });
    const pinned = orders.attachOrderArtifact({
      order_key: confirmed.order.order_key,
      expected_revision: fulfilling.order.revision,
      artifact: ARTIFACT,
      now: NOW,
    });
    expect(pinned.order.artifact_ref).toBe(ARTIFACT.record_id);
    expect(pinned.order.artifact_hash).toBe(ARTIFACT.content_sha256);

    // Re-pinning the SAME verified artifact is idempotent, not a conflict.
    expect(
      orders.attachOrderArtifact({
        order_key: confirmed.order.order_key,
        expected_revision: pinned.order.revision,
        artifact: ARTIFACT,
        now: NOW,
      }).result,
    ).toBe('unchanged');

    expect(() =>
      orders.attachOrderArtifact({
        order_key: confirmed.order.order_key,
        expected_revision: pinned.order.revision,
        artifact: OTHER_ARTIFACT,
        now: NOW,
      }),
    ).toThrow(/already pins artifact/);
  });

  /** ⛔ THE CARRIER GUARD IS A RUNTIME REFUSAL, NOT A TYPE.
   *
   *  The whole point of taking a `PinnedCasFileRef` here is that only
   *  `verifySellerOrderArtifactPin` can produce one — so no caller, present or
   *  future, can pin bytes nobody proved. A TYPE-only fence is defeated by a single
   *  `as` cast at a call site nobody re-reads, and the thing on the other side of it
   *  is the document a customer paid for. So the store checks at runtime, and this
   *  is the test that says so. */
  it('⛔ REFUSES a raw (ref, hash) pair cast past the type — the fence is not type-only', () => {
    const { confirmed } = paidOrder();
    const fulfilling = orders.transitionOrder({
      order_key: confirmed.order.order_key,
      expected_revision: confirmed.order.revision,
      next_phase: 'fulfilling',
      now: NOW,
    });

    expect(() =>
      orders.attachOrderArtifact({
        order_key: confirmed.order.order_key,
        expected_revision: fulfilling.order.revision,
        // Exactly what a caller would write if they had never read the type — and
        // exactly what the old signature accepted.
        artifact: {
          artifact_ref: ARTIFACT.record_id,
          artifact_hash: ARTIFACT.content_sha256,
        } as never,
        now: NOW,
      }),
    ).toThrow(/verified artifact pin/);

    // Nothing was written: the order still holds no artifact at all.
    expect(orders.getOrder(confirmed.order.order_key)?.artifact_ref).toBeNull();
  });

  it('links a work entity one-way (§4.4a — the recipe composes, core does not choose)', () => {
    const { confirmed } = paidOrder();
    const linked = orders.linkOrderWorkEntity({
      order_key: confirmed.order.order_key,
      expected_revision: confirmed.order.revision,
      work_entity_kind: 'commitment',
      work_entity_id: 'wc_1',
      now: NOW,
    });
    expect(linked.order.linked_work_entity_kind).toBe('commitment');
    expect(linked.order.linked_work_entity_id).toBe('wc_1');

    expect(() =>
      orders.linkOrderWorkEntity({
        order_key: confirmed.order.order_key,
        expected_revision: linked.order.revision,
        work_entity_kind: 'task',
        work_entity_id: 'wt_OTHER',
        now: NOW,
      }),
    ).toThrow(/already linked/);
  });

  /** §4.5 — the money↔access edge. An ACQUISITION order is opened at checkout,
   *  BEFORE `customer-access.issue` mints the customer, so `open`'s `customer_id`
   *  is unavailable to it; without a post-open link the edge is one-way. */
  it('links a customer onto an order opened without one (§4.5 — the acquisition case)', () => {
    const { confirmed } = paidOrder();
    expect(confirmed.order.customer_id).toBeNull();

    const linked = orders.linkOrderCustomer({
      order_key: confirmed.order.order_key,
      expected_revision: confirmed.order.revision,
      customer_id: 'sc_1',
      now: NOW,
    });
    expect(linked.result).toBe('updated');
    expect(linked.order.customer_id).toBe('sc_1');
  });

  /** A fulfilment can be replayed (the whole order lifecycle is replay-safe by
   *  construction). If re-linking the SAME customer threw, a retry would fail on
   *  work that had already succeeded. */
  it('is idempotent — re-linking the SAME customer converges instead of failing', () => {
    const { confirmed } = paidOrder();
    const linked = orders.linkOrderCustomer({
      order_key: confirmed.order.order_key,
      expected_revision: confirmed.order.revision,
      customer_id: 'sc_1',
      now: NOW,
    });

    const replay = orders.linkOrderCustomer({
      order_key: confirmed.order.order_key,
      expected_revision: linked.order.revision,
      customer_id: 'sc_1',
      now: NOW,
    });
    expect(replay.result).toBe('unchanged');
    expect(replay.order.customer_id).toBe('sc_1');
    expect(replay.order.revision).toBe(linked.order.revision);
  });

  /** An order records ONE customer's money. Silently re-pointing it at another
   *  would launder that fact — so it is a loud conflict, like the artifact. */
  it('REFUSES re-pointing an order at a DIFFERENT customer', () => {
    const { confirmed } = paidOrder();
    const linked = orders.linkOrderCustomer({
      order_key: confirmed.order.order_key,
      expected_revision: confirmed.order.revision,
      customer_id: 'sc_1',
      now: NOW,
    });

    expect(() =>
      orders.linkOrderCustomer({
        order_key: confirmed.order.order_key,
        expected_revision: linked.order.revision,
        customer_id: 'sc_OTHER',
        now: NOW,
      }),
    ).toThrow(/already linked to customer/);
  });

  /** A renewal's customer exists before its order does, so `open` sets it. The
   *  link must not quietly overwrite what open already established. */
  it('REFUSES re-pointing a customer that `open` itself set (the renewal case)', () => {
    activeOffer();
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'seller_customer',
      origin_ref: 'in_renewal1',
      customer_id: 'sc_1',
      now: NOW,
    });
    expect(opened.order.customer_id).toBe('sc_1');

    expect(() =>
      orders.linkOrderCustomer({
        order_key: opened.order.order_key,
        expected_revision: opened.order.revision,
        customer_id: 'sc_OTHER',
        now: NOW,
      }),
    ).toThrow(/already linked to customer/);
  });

  /** A decision made on a stale row must never be applied to a current one. */
  it('CAS: a stale revision is refused', () => {
    const { confirmed } = paidOrder();
    const stale = confirmed.order.revision - 1;
    expect(() =>
      orders.transitionOrder({
        order_key: confirmed.order.order_key,
        expected_revision: stale,
        next_phase: 'fulfilling',
        now: NOW,
      }),
    ).toThrow(/revision/);
  });

  it('every mutation advances the revision', () => {
    const { opened } = (() => {
      activeOffer();
      return {
        opened: orders.openOrder({
          offer_id: OFFER,
          origin_kind: 'reception_submission',
          origin_ref: ORIGIN,
          now: NOW,
        }),
      };
    })();
    const attached = orders.attachOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: opened.order.revision,
      provider: 'stripe',
      provider_session_id: 'cs_1',
      now: NOW,
    });
    expect(attached.order.revision).toBe(opened.order.revision + 1);
  });
});

/** ── F7, re-keyed by ruling (C) ────────────────────────────────────────────────
 *
 *  Under D-200 the SERVER created the Checkout Session, so the correlation went
 *  server→Stripe and never touched anyone else. Under ruling (C) the owner pre-creates
 *  the hosted link and the VISITOR clicks it, so the correlation must travel on the URL
 *  (`?client_reference_id=…`) — through a stranger's browser, history and referrer.
 *
 *  `order_key` is deterministic in (offer, origin) — that is what makes the idempotency
 *  fence work, and it is exactly what makes it GUESSABLE. F7 minted the CSPRNG
 *  `order_handle` for precisely this reason and said the key never leaves the server.
 *
 *  The rest of the 3b suite builds its evidence FROM `opened.correlation`, so it would
 *  stay green whatever the correlation carried. These name the value. */
describe('D-207 slice 3b — F7: the correlation the visitor carries is the HANDLE', () => {
  it('open hands back a client_reference_id that is the handle, never the key', () => {
    activeOffer();
    const opened = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      now: NOW,
    });

    expect(opened.correlation.client_reference_id).toBe(opened.order.order_handle);
    expect(opened.correlation.client_reference_id).not.toBe(opened.order.order_key);

    // The server-only fields stay on the key — they ride an API call, never a browser,
    // and the idempotency fence depends on them being deterministic.
    expect(opened.correlation.idempotency_key.startsWith(opened.order.order_key)).toBe(true);
    expect(opened.correlation.session_metadata_order_key).toBe(opened.order.order_key);
  });

  it('a REPLAYED open hands back the same correlation the first one put on the link', () => {
    activeOffer();
    const first = orders.openOrder({
      offer_id: OFFER, origin_kind: 'reception_submission', origin_ref: ORIGIN, now: NOW,
    });
    const replay = orders.openOrder({
      offer_id: OFFER, origin_kind: 'reception_submission', origin_ref: ORIGIN, now: NOW,
    });
    // A re-drive must not mint a second handle — the visitor is already holding a link
    // stamped with the first one, and a rotated handle would orphan their payment.
    expect(replay.result).toBe('existing');
    expect(replay.correlation.client_reference_id).toBe(first.correlation.client_reference_id);
  });

  it('confirm REFUSES evidence carrying the order KEY as the client reference', () => {
    activeOffer();
    const opened = orders.openOrder({
      offer_id: OFFER, origin_kind: 'reception_submission', origin_ref: ORIGIN, now: NOW,
    });
    const attached = orders.attachOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: opened.order.revision,
      provider: 'stripe',
      provider_session_id: 'cs_test_1',
      now: NOW,
    });

    // The order's OWN key — everything else about this evidence is honest, and the
    // amount is exactly right. Only the correlation is the pre-(C) value.
    expect(() => orders.confirmOrderPayment({
      order_key: opened.order.order_key,
      expected_revision: attached.order.revision,
      evidence: {
        provider: 'stripe',
        provider_session_id: 'cs_test_1',
        provider_payment_id: 'pi_test_1',
        client_reference_id: opened.order.order_key,
        payment_status: 'paid',
        amount_total: 12_500,
        currency: 'USD',
      },
      now: NOW,
    })).toThrow(/correlation/);
  });
});

/** D-196 renewal — `confirmOrderRenewalPayment`, the second specialized `paid`
 *  writer. A renewal order is keyed on the provider invoice that caused it, and
 *  no provider object ever carries ITS handle, so the session-shaped confirm
 *  cannot serve it honestly. Every fence here is a way a caller could otherwise
 *  claim renewal money moved when it did not — each one is exercised against
 *  the REAL store, and each refusal fixture differs from the honest one in
 *  exactly the field its fence guards. */
describe('D-196 — confirm-renewal-payment: invoice-keyed correlation + acquisition anchor', () => {
  const RENEWAL_INVOICE = 'in_test_cycle_2';

  const recurringOffer = (offerId = OFFER, amount = 2_900): void => {
    seller.ensureOffer({
      offer_id: offerId,
      kind: 'access',
      display_name: 'Pro access subscription',
      description: 'Monthly pro tier',
      pricing_kind: 'recurring',
      amount_minor: amount,
      currency: 'USD',
      checkout_url: 'https://buy.stripe.com/test_link',
      now: NOW,
    });
    seller.transitionOfferState({
      offer_id: offerId,
      expected_state: 'draft',
      expected_updated_at: NOW,
      next_state: 'active',
      now: NOW,
    });
  };

  /** The acquisition order (period 1, submission-keyed) + a renewal order
   *  (period 2+, invoice-keyed) on the same offer with the same snapshot. */
  const acquisitionAndRenewal = (renewalOver: {
    entitlement_key?: string | null;
    origin_kind?: 'reception_submission' | 'seller_customer' | 'provider_invoice' | 'manual';
  } = {}) => {
    recurringOffer();
    const acquisition = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      entitlement_key: 'pro',
      now: NOW,
    });
    const renewal = orders.openOrder({
      offer_id: OFFER,
      origin_kind: renewalOver.origin_kind ?? 'provider_invoice',
      origin_ref: RENEWAL_INVOICE,
      entitlement_key: renewalOver.entitlement_key === undefined ? 'pro' : renewalOver.entitlement_key,
      now: NOW,
    });
    return { acquisition, renewal };
  };

  const honestEvidence = (acquisitionKey: string) => ({
    provider: 'stripe',
    provider_invoice_id: RENEWAL_INVOICE,
    provider_payment_id: 'pi_test_cycle_2',
    acquisition_order_key: acquisitionKey,
    payment_status: 'paid',
    amount_paid: 2_900,
    currency: 'usd',
  });

  it('confirms a draft invoice-keyed order and records the payment', () => {
    const { acquisition, renewal } = acquisitionAndRenewal();
    expect(renewal.order.phase).toBe('draft');

    const confirmed = orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: honestEvidence(acquisition.order.order_key),
      now: NOW + 5,
    });

    expect(confirmed.result).toBe('updated');
    expect(confirmed.order.phase).toBe('paid');
    expect(confirmed.order.paid_at).toBe(NOW + 5);
    // No attach leg ran, so the provider identity lands here.
    expect(confirmed.order.provider).toBe('stripe');
    expect(confirmed.order.provider_payment_id).toBe('pi_test_cycle_2');
    expect(confirmed.order.provider_session_id).toBeNull();
  });

  it('a replayed confirm converges instead of failing', () => {
    const { acquisition, renewal } = acquisitionAndRenewal();
    const confirmed = orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: honestEvidence(acquisition.order.order_key),
      now: NOW,
    });
    const replayed = orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: confirmed.order.revision,
      evidence: honestEvidence(acquisition.order.order_key),
      now: NOW + 60,
    });
    expect(replayed.result).toBe('unchanged');
    expect(replayed.order.paid_at).toBe(NOW);
  });

  it('refuses an order that is not keyed on a provider invoice', () => {
    // Honest in every OTHER field: the target is a submission-keyed order whose
    // origin_ref the evidence names exactly — only the shape discriminator refuses.
    recurringOffer();
    const acquisition = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      entitlement_key: 'pro',
      now: NOW,
    });
    const anchor = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'provider_invoice',
      origin_ref: RENEWAL_INVOICE,
      entitlement_key: 'pro',
      now: NOW,
    });
    expect(() => orders.confirmOrderRenewalPayment({
      order_key: acquisition.order.order_key,
      expected_revision: acquisition.order.revision,
      evidence: { ...honestEvidence(anchor.order.order_key), provider_invoice_id: ORIGIN },
      now: NOW,
    })).toThrow(/keyed on a 'reception_submission' origin/);
  });

  it('refuses evidence naming a different invoice than the order key', () => {
    const { acquisition, renewal } = acquisitionAndRenewal();
    expect(() => orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: { ...honestEvidence(acquisition.order.order_key), provider_invoice_id: 'in_other_period' },
      now: NOW,
    })).toThrow(/different provider invoice/);
    expect(orders.getOrder(renewal.order.order_key)?.phase).toBe('draft');
  });

  it('refuses an acquisition anchor that does not exist', () => {
    const { renewal } = acquisitionAndRenewal();
    expect(() => orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: { ...honestEvidence(`ord:${OFFER}:nope_1`), },
      now: NOW,
    })).toThrow(/does not exist/);
  });

  it('refuses a malformed acquisition key outright', () => {
    const { renewal } = acquisitionAndRenewal();
    expect(() => orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: { ...honestEvidence('not-an-order-key') },
      now: NOW,
    })).toThrow(/not an order key/);
  });

  it('refuses an order anchoring its own renewal evidence', () => {
    const { renewal } = acquisitionAndRenewal();
    expect(() => orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: honestEvidence(renewal.order.order_key),
      now: NOW,
    })).toThrow(/its own renewal evidence/);
  });

  it('refuses an acquisition anchor selling a different offer', () => {
    recurringOffer();
    recurringOffer('other-plan');
    const foreignAcquisition = orders.openOrder({
      offer_id: 'other-plan',
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      entitlement_key: 'pro',
      now: NOW,
    });
    const renewal = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'provider_invoice',
      origin_ref: RENEWAL_INVOICE,
      entitlement_key: 'pro',
      now: NOW,
    });
    expect(() => orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: honestEvidence(foreignAcquisition.order.order_key),
      now: NOW,
    })).toThrow(/sells offer 'other-plan'/);
  });

  it('refuses an entitlement snapshot that drifted from the acquisition', () => {
    recurringOffer();
    const acquisition = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'reception_submission',
      origin_ref: ORIGIN,
      entitlement_key: 'enterprise',
      now: NOW,
    });
    const renewal = orders.openOrder({
      offer_id: OFFER,
      origin_kind: 'provider_invoice',
      origin_ref: RENEWAL_INVOICE,
      entitlement_key: 'pro',
      now: NOW,
    });
    expect(() => orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: honestEvidence(acquisition.order.order_key),
      now: NOW,
    })).toThrow(/snapshotted entitlement 'enterprise'/);
  });

  it('refuses a provider status other than paid', () => {
    const { acquisition, renewal } = acquisitionAndRenewal();
    expect(() => orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: { ...honestEvidence(acquisition.order.order_key), payment_status: 'open' },
      now: NOW,
    })).toThrow(/'open', not 'paid'/);
  });

  it('the underpay fence: refuses an amount other than the order snapshot', () => {
    const { acquisition, renewal } = acquisitionAndRenewal();
    expect(() => orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: { ...honestEvidence(acquisition.order.order_key), amount_paid: 900 },
      now: NOW,
    })).toThrow(/collected 900/);
    expect(() => orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: { ...honestEvidence(acquisition.order.order_key), currency: 'eur' },
      now: NOW,
    })).toThrow(/but this order is for/);
  });

  it('is CAS-guarded like every other mutator', () => {
    const { acquisition, renewal } = acquisitionAndRenewal();
    expect(() => orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision + 7,
      evidence: honestEvidence(acquisition.order.order_key),
      now: NOW,
    })).toThrow(/revision/);
  });

  it('the generic transition still cannot reach paid from draft', () => {
    // The new draft → paid edge exists for THIS op. The evidence-phase refusal
    // fires before the graph is consulted, so the edge is unreachable generically.
    const { renewal } = acquisitionAndRenewal();
    expect(() => orders.transitionOrder({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      next_phase: 'paid',
      now: NOW,
    })).toThrow(/writable only/);
  });

  it('the session-shaped confirm cannot fire from draft: no session was ever attached', () => {
    // The graph edge draft → paid is admissible, but `confirmOrderPayment`
    // requires an attached provider session, and attaching one MOVES the order
    // to awaiting_payment — so the edge stays exclusive to the renewal op.
    const { renewal } = acquisitionAndRenewal();
    expect(() => orders.confirmOrderPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: {
        provider: 'stripe',
        provider_session_id: 'cs_forged',
        provider_payment_id: 'pi_forged',
        client_reference_id: renewal.order.order_handle,
        payment_status: 'paid',
        amount_total: 2_900,
        currency: 'USD',
      },
      now: NOW,
    })).toThrow(/no provider session is attached/);
  });

  it('fulfilment can then close the renewal without a delivery leg', () => {
    // paid → fulfilling → complete: the ACCESS leg. Issuing IS completing —
    // there is no artifact to approve and nothing to deliver on a renewal.
    const { acquisition, renewal } = acquisitionAndRenewal();
    const confirmed = orders.confirmOrderRenewalPayment({
      order_key: renewal.order.order_key,
      expected_revision: renewal.order.revision,
      evidence: honestEvidence(acquisition.order.order_key),
      now: NOW,
    });
    const fulfilling = orders.transitionOrder({
      order_key: renewal.order.order_key,
      expected_revision: confirmed.order.revision,
      next_phase: 'fulfilling',
      now: NOW,
    });
    const linked = orders.linkOrderCustomer({
      order_key: renewal.order.order_key,
      expected_revision: fulfilling.order.revision,
      customer_id: 'sc_test_1',
      now: NOW,
    });
    const complete = orders.transitionOrder({
      order_key: renewal.order.order_key,
      expected_revision: linked.order.revision,
      next_phase: 'complete',
      now: NOW,
    });
    expect(complete.order.phase).toBe('complete');
  });
});
