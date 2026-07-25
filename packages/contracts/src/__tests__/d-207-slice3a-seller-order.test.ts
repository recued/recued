/** D-207 slice 3a — `core.seller.order`, the money leg.
 *
 *  These tests pin INVARIANTS, not literals typed next to what they guard. The
 *  D-207 arc has now been bitten three times by a closed vocabulary copied into a
 *  second place (`door_types` the const vs the schema; `OutputType` the union vs
 *  a `Set` vs the renderer) — in every case a subset typechecked fine and the
 *  drift shipped inert. So: derive, then assert the relationship.
 */

import { describe, it, expect } from 'vitest';
import {
  SELLER_ORDER_PHASES,
  SELLER_ORDER_EVIDENCE_PHASES,
  SELLER_ORDER_PHASE_BUCKET,
  SELLER_ORDER_PHASE_TRANSITIONS,
  SELLER_ORDER_PRE_PAYMENT_PHASES,
  SELLER_ORDER_KEY_MAX_LENGTH,
  SELLER_ORDER_CHECKOUT_IDEMPOTENCY_SUFFIX,
  SELLER_ORDER_PROVIDER_IDEMPOTENCY_KEY_MAX_LENGTH,
  isSellerOrderEvidencePhase,
  isSellerOrderTransitionOpTarget,
  isSellerOrderTransitionAllowed,
  isSellerOrderKey,
  isSellerOrderHandle,
  sellerOrderKey,
  sellerOrderKeyParts,
  sellerOrderCheckoutCorrelation,
  type SellerOrderPhase,
} from '../seller-order.js';

describe('D-207 slice 3a — F5: an evidence-backed phase is unreachable from `transition`', () => {
  // Non-vacuity: the guarded set must be real, non-empty, and a strict subset of
  // the phases. Without this, every assertion below could pass over an empty set.
  it('guards a real, non-empty, strict subset of the phase vocabulary', () => {
    expect(SELLER_ORDER_EVIDENCE_PHASES.length).toBeGreaterThan(0);
    expect(SELLER_ORDER_EVIDENCE_PHASES.length).toBeLessThan(SELLER_ORDER_PHASES.length);
    for (const phase of SELLER_ORDER_EVIDENCE_PHASES) {
      expect(SELLER_ORDER_PHASES).toContain(phase);
    }
    // The two that assert MONEY MOVED.
    expect([...SELLER_ORDER_EVIDENCE_PHASES].sort()).toEqual(['paid', 'refunded']);
  });

  it('refuses EVERY evidence phase as a `transition` target', () => {
    for (const phase of SELLER_ORDER_EVIDENCE_PHASES) {
      expect(isSellerOrderTransitionOpTarget(phase)).toBe(false);
    }
  });

  it('admits every NON-evidence phase as a `transition` target', () => {
    const admitted = SELLER_ORDER_PHASES.filter((p) => !isSellerOrderEvidencePhase(p));
    expect(admitted.length).toBeGreaterThan(0);
    for (const phase of admitted) {
      expect(isSellerOrderTransitionOpTarget(phase)).toBe(true);
    }
  });

  /** ⛔ The free-PDF hole. The lifecycle GRAPH legitimately contains
   *  `awaiting_payment -> paid` — `confirm-payment` needs that edge. A validator
   *  that checked only the graph would therefore let a recipe call
   *  `order.transition('paid')` and then fulfil, with no provider evidence at
   *  all. This is the test that says the two checks are NOT the same check. */
  it('the graph ALLOWS awaiting_payment -> paid, and `transition` still refuses it', () => {
    expect(isSellerOrderTransitionAllowed('awaiting_payment', 'paid')).toBe(true);
    expect(isSellerOrderTransitionOpTarget('paid')).toBe(false);
  });
});

describe('D-207 slice 3a — the lifecycle graph', () => {
  it('every phase has an entry, and every target is a real phase', () => {
    for (const phase of SELLER_ORDER_PHASES) {
      const targets = SELLER_ORDER_PHASE_TRANSITIONS[phase];
      expect(targets, `no transition entry for '${phase}'`).toBeDefined();
      for (const target of targets) {
        expect(SELLER_ORDER_PHASES).toContain(target);
      }
      expect(targets).not.toContain(phase);
    }
  });

  it('every phase has a bucket', () => {
    for (const phase of SELLER_ORDER_PHASES) {
      expect(SELLER_ORDER_PHASE_BUCKET[phase]).toBeDefined();
    }
  });

  /** ⛔ Nothing at or after `paid` may reach `expired`.
   *
   *  `expired` means THE CHECKOUT EXPIRED — no money moved — and auto-expiring an
   *  unpaid checkout is correct. Auto-expiring an obligation someone is OWED is
   *  the exact bug the `commitment` substrate retired its flat state to avoid
   *  ("conflating lifecycle + deadline silently expired monetary obligations the
   *  moment the deadline passed"). This test goes red the moment someone adds
   *  `paid -> expired` to the graph. */
  it('`expired` is reachable ONLY from a pre-payment phase', () => {
    const canExpire = SELLER_ORDER_PHASES.filter((phase) =>
      SELLER_ORDER_PHASE_TRANSITIONS[phase].includes('expired'),
    );
    expect(canExpire.length).toBeGreaterThan(0);
    for (const phase of canExpire) {
      expect(
        (SELLER_ORDER_PRE_PAYMENT_PHASES as readonly SellerOrderPhase[]).includes(phase),
        `'${phase}' can reach 'expired' but is not a pre-payment phase`,
      ).toBe(true);
    }
    expect(SELLER_ORDER_PHASE_TRANSITIONS.paid).not.toContain('expired');
  });

  it('`refunded` is terminal', () => {
    expect(SELLER_ORDER_PHASE_TRANSITIONS.refunded).toEqual([]);
  });
});

describe('D-207 slice 3a — F7: two identifiers, and the key cannot alias', () => {
  it('round-trips (offer, origin) through the key', () => {
    const key = sellerOrderKey('paid-doc.v1', 'sub_ABC123');
    expect(key).not.toBeNull();
    expect(isSellerOrderKey(key)).toBe(true);
    expect(sellerOrderKeyParts(key)).toEqual(['paid-doc.v1', 'sub_ABC123']);
  });

  it('is deterministic — the same pair always yields the same key', () => {
    expect(sellerOrderKey('o1', 'sub_1')).toBe(sellerOrderKey('o1', 'sub_1'));
  });

  /** The charset guards are what make the `:`-join unambiguous. `isSellerOfferId`
   *  is /^[a-z0-9][a-z0-9._-]*$/ and `isSellerOrderOriginRef` is /^[A-Za-z0-9_-]+$/
   *  — NEITHER admits `:`. So no segment can smuggle a separator and alias another
   *  identity. (D-200 kept its workflow key as a tuple for exactly this reason.) */
  it('refuses a segment carrying the separator', () => {
    expect(sellerOrderKey('offer:evil', 'sub_1')).toBeNull();
    expect(sellerOrderKey('offer', 'sub:evil')).toBeNull();
  });

  it('distinct pairs never collide', () => {
    const a = sellerOrderKey('ab', 'c_d');
    const b = sellerOrderKey('ab_c', 'd');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('rejects an over-long key', () => {
    expect(sellerOrderKey('o', 'x'.repeat(SELLER_ORDER_KEY_MAX_LENGTH))).toBeNull();
  });

  it('a handle is a prefixed CSPRNG hex token, and a key is never one', () => {
    expect(isSellerOrderHandle('oh_' + 'a'.repeat(64))).toBe(true);
    expect(isSellerOrderHandle('oh_' + 'a'.repeat(63))).toBe(false);
    expect(isSellerOrderHandle('oh_' + 'Z'.repeat(64))).toBe(false);
    // The key is deterministic and therefore guessable — it must never pass as
    // the public handle.
    expect(isSellerOrderHandle(sellerOrderKey('o1', 'sub_1'))).toBe(false);
  });
});

describe('D-207 slice 3a — F6: one correlation source fans out to every provider field', () => {
  const HANDLE = 'oh_' + 'a'.repeat(64);

  it('fans out from the order — five fields on the key, and the VISITOR one on the handle', () => {
    const key = sellerOrderKey('paid-doc', 'sub_1');
    const correlation = sellerOrderCheckoutCorrelation({
      order_key: key,
      order_handle: HANDLE,
    });
    expect(correlation).not.toBeNull();
    expect(correlation).toEqual({
      order_key: key,
      idempotency_key: key + SELLER_ORDER_CHECKOUT_IDEMPOTENCY_SUFFIX,
      // ⛔ THE HANDLE, NOT THE KEY. Under ruling (C) the owner pre-creates the hosted
      // checkout link and the VISITOR clicks it, so this is the one correlation field
      // that rides a URL through a stranger's browser. `order_key` is deterministic and
      // therefore guessable — F7's whole reason for minting a separate CSPRNG handle —
      // and `core.seller.order.get` takes EITHER id at `read` risk, so it ADMITS on a
      // public door. Putting the key here would hand every visitor a guessable address
      // for other people's orders.
      client_reference_id: HANDLE,
      // These four ride a server→provider API call. They never touch the visitor, so
      // they stay on the key — which is what makes the idempotency fence deterministic.
      session_metadata_order_key: key,
      payment_intent_metadata_order_key: key,
      // D-196: the subscription-metadata copy is the only one that survives onto
      // renewal invoices — the renewal flow recovers the acquisition order from it.
      subscription_metadata_order_key: key,
    });
  });

  it('the visitor-facing field is never the guessable key', () => {
    const key = sellerOrderKey('paid-doc', 'sub_1');
    const correlation = sellerOrderCheckoutCorrelation({
      order_key: key,
      order_handle: HANDLE,
    });
    expect(correlation!.client_reference_id).not.toBe(key);
    expect(isSellerOrderHandle(correlation!.client_reference_id)).toBe(true);
  });

  /** Stripe is non-idempotent without an `Idempotency-Key`, so a crash between the
   *  local commit and the provider call mints a SECOND Checkout Session. The
   *  derived key must fit the provider's ceiling or the whole fence is decorative. */
  it('the derived idempotency key always fits the provider ceiling', () => {
    const longest = sellerOrderKey(
      'o'.repeat(100),
      'x'.repeat(SELLER_ORDER_KEY_MAX_LENGTH - 100 - 'ord'.length - 2),
    );
    expect(longest).not.toBeNull();
    const correlation = sellerOrderCheckoutCorrelation({
      order_key: longest,
      order_handle: HANDLE,
    });
    expect(correlation).not.toBeNull();
    expect(correlation!.idempotency_key.length).toBeLessThanOrEqual(
      SELLER_ORDER_PROVIDER_IDEMPOTENCY_KEY_MAX_LENGTH,
    );
  });

  it('refuses a malformed key or handle rather than fabricating a correlation', () => {
    const key = sellerOrderKey('paid-doc', 'sub_1');
    expect(sellerOrderCheckoutCorrelation({
      order_key: 'not-an-order-key',
      order_handle: HANDLE,
    })).toBeNull();
    expect(sellerOrderCheckoutCorrelation({
      order_key: key,
      order_handle: undefined,
    })).toBeNull();
    // ⛔ The key must not pass as the handle. Without this the re-key could be silently
    // undone by a caller handing the same value in twice.
    expect(sellerOrderCheckoutCorrelation({
      order_key: key,
      order_handle: key,
    })).toBeNull();
  });
});
