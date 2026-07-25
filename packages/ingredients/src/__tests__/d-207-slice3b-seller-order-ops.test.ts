/** D-207 slice 3b — the `core.seller.order` kernel op surface.
 *
 *  The REAL fences live at the storage boundary (`seller-order-store.ts`), because
 *  this dispatch layer is only one of the store's possible callers and a check
 *  that guards a single door is not a fence. What is tested here is what only this
 *  layer can carry: the CLOSED INPUT KEY SET, which is where "a recipe cannot name
 *  a price" stops being a convention and becomes a type error.
 */

import { describe, expect, it, vi } from 'vitest';
import { SELLER_ORDER_EVIDENCE_PHASES } from '@recued/contracts';
import { createKernelAdapter } from '../kernel.js';

const mkCall = (slug: string, input: Record<string, unknown>) => ({
  slug,
  risk_tier: 'read' as const,
  input,
  output: {},
  manifest_version: 1,
});

const openDispatcher = () =>
  vi.fn(async () => ({
    result: 'created' as const,
    order: {} as never,
    correlation: {} as never,
  }));

const mutationDispatcher = () =>
  vi.fn(async () => ({ result: 'updated' as const, order: {} as never }));

describe('D-207 slice 3b — `open` names WHICH offer, never WHAT it costs', () => {
  /** ⛔ THE FENCE. D-200 required the checkout's commerce terms to be recipe
   *  LITERALS, and enforced it with `isLiteralIntentStep` — a validator that
   *  inspected a price. D-207 removes the price PARAMETER instead. A recipe cannot
   *  supply an amount because there is nowhere to put one, so neither can a visitor
   *  whose value that recipe might be carrying. */
  it.each([
    ['amount_minor', 999],
    ['currency', 'USD'],
    ['product_name', 'A cheap thing'],
    ['price', 1],
    ['total', 1],
  ])('refuses a caller-supplied commerce term: %s', async (field, value) => {
    const sellerOrderOpen = openDispatcher();
    const adapter = createKernelAdapter({ sellerOrderOpen });

    await expect(
      adapter(
        mkCall('seller-order-open', {
          offer_id: 'paid-doc',
          origin_kind: 'reception_submission',
          origin_ref: 'sub_1',
          [field]: value,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    // Never dispatched — refused before the store could ever see it.
    expect(sellerOrderOpen).not.toHaveBeenCalled();
  });

  it('opens with an offer id and an origin, and nothing else', async () => {
    const sellerOrderOpen = openDispatcher();
    const adapter = createKernelAdapter({ sellerOrderOpen });

    await adapter(
      mkCall('seller-order-open', {
        offer_id: 'paid-doc',
        origin_kind: 'reception_submission',
        origin_ref: 'sub_1',
      }),
    );
    expect(sellerOrderOpen).toHaveBeenCalledWith({
      offer_id: 'paid-doc',
      origin_kind: 'reception_submission',
      origin_ref: 'sub_1',
      customer_id: null,
      entitlement_key: null,
    });
  });

  /** D-196 §4.5 — the entitlement key names WHICH access the order sells, not
   *  what it costs, so it passes the closed key set the commerce terms cannot. */
  it('carries an entitlement_key through to the store', async () => {
    const sellerOrderOpen = openDispatcher();
    const adapter = createKernelAdapter({ sellerOrderOpen });

    await adapter(
      mkCall('seller-order-open', {
        offer_id: 'pro-tier-sub',
        origin_kind: 'seller_customer',
        origin_ref: 'in_00001',
        entitlement_key: 'pro',
      }),
    );
    expect(sellerOrderOpen).toHaveBeenCalledWith({
      offer_id: 'pro-tier-sub',
      origin_kind: 'seller_customer',
      origin_ref: 'in_00001',
      customer_id: null,
      entitlement_key: 'pro',
    });
  });

  it('refuses an unknown origin kind', async () => {
    const sellerOrderOpen = openDispatcher();
    const adapter = createKernelAdapter({ sellerOrderOpen });

    await expect(
      adapter(
        mkCall('seller-order-open', {
          offer_id: 'paid-doc',
          origin_kind: 'something_else',
          origin_ref: 'sub_1',
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sellerOrderOpen).not.toHaveBeenCalled();
  });
});

describe('D-207 slice 3b — F5 at the dispatch layer', () => {
  /** The storage boundary refuses these too, and that is the fence that matters.
   *  This one exists so the failure is a clear BAD_INPUT naming the right operation
   *  instead of a store error surfacing through a recipe. */
  it('refuses EVERY evidence phase as a transition target', async () => {
    const sellerOrderTransition = mutationDispatcher();
    const adapter = createKernelAdapter({ sellerOrderTransition });

    for (const phase of SELLER_ORDER_EVIDENCE_PHASES) {
      await expect(
        adapter(
          mkCall('seller-order-transition', {
            order_key: 'ord:paid-doc:sub_1',
            expected_revision: 0,
            next_phase: phase,
          }),
        ),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    }
    expect(sellerOrderTransition).not.toHaveBeenCalled();
  });

  it('admits an ordinary non-evidence move', async () => {
    const sellerOrderTransition = mutationDispatcher();
    const adapter = createKernelAdapter({ sellerOrderTransition });

    await adapter(
      mkCall('seller-order-transition', {
        order_key: 'ord:paid-doc:sub_1',
        expected_revision: 3,
        next_phase: 'fulfilling',
      }),
    );
    expect(sellerOrderTransition).toHaveBeenCalledWith({
      order_key: 'ord:paid-doc:sub_1',
      expected_revision: 3,
      next_phase: 'fulfilling',
      error_code: null,
    });
  });
});

describe('D-207 slice 3b — dispatch hygiene', () => {
  it('surfaces SERVER_NOT_REACHABLE when the seller substrate is absent', async () => {
    const adapter = createKernelAdapter({});
    await expect(
      adapter(
        mkCall('seller-order-open', {
          offer_id: 'paid-doc',
          origin_kind: 'reception_submission',
          origin_ref: 'sub_1',
        }),
      ),
    ).rejects.toMatchObject({ code: 'SERVER_NOT_REACHABLE' });
  });

  it('`get` requires exactly one of order_key or order_handle', async () => {
    const sellerOrderGet = vi.fn(async () => ({ order: null }));
    const adapter = createKernelAdapter({ sellerOrderGet });

    await expect(
      adapter(mkCall('seller-order-get', {})),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(
      adapter(
        mkCall('seller-order-get', {
          order_key: 'ord:paid-doc:sub_1',
          order_handle: `oh_${'a'.repeat(64)}`,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sellerOrderGet).not.toHaveBeenCalled();

    await adapter(mkCall('seller-order-get', { order_handle: `oh_${'a'.repeat(64)}` }));
    expect(sellerOrderGet).toHaveBeenCalledWith({
      order_key: undefined,
      order_handle: `oh_${'a'.repeat(64)}`,
    });
  });

  /** `expected_revision` is the CAS token. A float would be quietly coerced by
   *  SQLite into something that silently never matches. */
  it('refuses a non-integer CAS token', async () => {
    const sellerOrderTransition = mutationDispatcher();
    const adapter = createKernelAdapter({ sellerOrderTransition });

    await expect(
      adapter(
        mkCall('seller-order-transition', {
          order_key: 'ord:paid-doc:sub_1',
          expected_revision: 1.5,
          next_phase: 'fulfilling',
        }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(sellerOrderTransition).not.toHaveBeenCalled();
  });

  it('forwards payment evidence unmodified — only the store may judge it', async () => {
    const sellerOrderConfirmPayment = mutationDispatcher();
    const adapter = createKernelAdapter({ sellerOrderConfirmPayment });
    const evidence = {
      provider: 'stripe',
      provider_session_id: 'cs_1',
      provider_payment_id: 'pi_1',
      client_reference_id: 'ord:paid-doc:sub_1',
      payment_status: 'paid',
      amount_total: 12_500,
      currency: 'USD',
    };

    await adapter(
      mkCall('seller-order-confirm-payment', {
        order_key: 'ord:paid-doc:sub_1',
        expected_revision: 1,
        evidence,
      }),
    );
    expect(sellerOrderConfirmPayment).toHaveBeenCalledWith({
      order_key: 'ord:paid-doc:sub_1',
      expected_revision: 1,
      evidence,
    });
  });
});
