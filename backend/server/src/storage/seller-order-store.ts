/** D-207 §4.3 — the `core.seller.order` storage boundary.
 *
 *  This is where the 1,990 D-200 recipe steps die: each transition below is a
 *  typed, atomic, CAS-guarded operation in TypeScript, replacing the
 *  `compare`/`all`/`guard` chains that expressed the same logic in JSON.
 *
 *  ## The one property everything else rests on
 *
 *  ⛔ `openOrder` takes an `offer_id` — NOT an offer, and NOT a price. It reads the
 *  offer itself and snapshots the commerce terms from that row. So there is no
 *  parameter through which a caller could supply an amount, and therefore no path
 *  by which a VISITOR's value could become one. This is what replaces D-200's
 *  `isLiteralIntentStep`: not a validator that inspects a price, but the absence
 *  of any way to hand one in.
 *
 *  Snapshotting also means a later offer edit cannot retroactively change what a
 *  customer already agreed to pay.
 *
 *  ## What `confirm-payment` does and does not prove (§4.3 F5)
 *
 *  It proves, at the storage boundary, that the caller cannot:
 *    - confirm an order it never attached a session to,
 *    - confirm THIS order using some OTHER order's session (the correlation is
 *      re-derived here, never accepted from the caller),
 *    - confirm a payment for an amount other than the one the server computed
 *      (the underpay fence),
 *    - reach `paid` at all through the generic `transition` op.
 *
 *  It does NOT prove the evidence blob genuinely came from the provider — nothing
 *  at this layer could. That trust sits in the recipe's provider read, which runs
 *  with owner authority over the owner's own credential, and it is exactly where
 *  D-200 places it too. Saying so plainly is the point: a check that LOOKS like
 *  assurance but is not is worse than no check.
 */

import type Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import {
  SELLER_ORDER_HANDLE_BYTES,
  SELLER_ORDER_HANDLE_PREFIX,
  clampSellerOrderListLimit,
  isPinnedCasFileRef,
  isSellerOrderHandle,
  isSellerOrderKey,
  isSellerOrderOriginKind,
  isSellerOrderOriginRef,
  isSellerOrderPhase,
  isSellerOrderTransitionAllowed,
  isSellerOrderTransitionOpTarget,
  isWorkEntityKind,
  sellerOrderCheckoutCorrelation,
  sellerOrderKey,
  type PinnedCasFileRef,
  type SellerOrder,
  type SellerOrderCheckoutCorrelation,
  type SellerOrderOriginKind,
  type SellerOrderPhase,
  type SellerOfferPricingKind,
  type WorkEntityKind,
} from '@recued/contracts';
import {
  SELLER_ORDERS_TABLE,
  SELLER_OFFERS_TABLE,
  SellerStoreConflictError,
  SellerStoreValidationError,
  ensureSellerSchema,
  parseNullableJsonObject,
} from './seller-store.js';

/** Injectable for tests; production uses a CSPRNG. */
export type SellerOrderHandleFactory = () => string;

export const defaultSellerOrderHandleFactory: SellerOrderHandleFactory = () =>
  SELLER_ORDER_HANDLE_PREFIX + randomBytes(SELLER_ORDER_HANDLE_BYTES).toString('hex');

export interface SellerOrderOpenInput {
  /** ⛔ The offer is READ here. No amount, currency, or product crosses this
   *  boundary — the caller names WHICH offer, never WHAT it costs. */
  readonly offer_id: string;
  readonly origin_kind: SellerOrderOriginKind;
  readonly origin_ref: string;
  readonly customer_id?: string | null;
  /** D-196 §4.5 — the tier this order sells, when it sells one. Snapshotted onto
   *  the row at open and immutable after; fulfilment issues access from the
   *  ORDER's copy, never from its own configuration. The entitlement KEY, never
   *  a tier row id (the key survives a tier re-sync). Not a commerce term: it
   *  names WHICH access, and comes from the opening recipe's dish — no visitor
   *  value can reach it. */
  readonly entitlement_key?: string | null;
  readonly now: number;
}

export interface SellerOrderOpenResult {
  readonly result: 'created' | 'existing';
  readonly order: SellerOrder;
  /** F6 — handed back so the caller's provider call can carry the idempotency key
   *  WITHOUT ever composing one itself. Three separately-supplied workflow values
   *  are three values that can drift. */
  readonly correlation: SellerOrderCheckoutCorrelation;
}

export interface SellerOrderQuoteInput {
  readonly order_key: string;
  readonly expected_revision: number;
  readonly amount_minor: number;
  readonly currency: string;
  readonly now: number;
}

export interface SellerOrderAttachPaymentInput {
  readonly order_key: string;
  readonly expected_revision: number;
  readonly provider: string;
  readonly provider_session_id: string;
  readonly checkout_url?: string | null;
  readonly expires_at?: number | null;
  readonly now: number;
}

/** What the caller observed at the provider. The correlation is NOT in here: it is
 *  re-derived from the order and compared, so a caller cannot assert it. */
export interface SellerOrderPaymentEvidence {
  readonly provider: string;
  readonly provider_session_id: string;
  readonly provider_payment_id: string;
  readonly client_reference_id: string;
  readonly payment_status: string;
  readonly amount_total: number;
  readonly currency: string;
}

export interface SellerOrderConfirmPaymentInput {
  readonly order_key: string;
  readonly expected_revision: number;
  readonly evidence: SellerOrderPaymentEvidence;
  readonly now: number;
}

/** D-196 renewal — what the caller observed at the provider for one PAID renewal
 *  invoice. The correlation is NOT in here as an assertion: the invoice named
 *  must BE the one this order is keyed on (`origin_ref`), and the acquisition
 *  order named must exist in THIS store with the same offer and the same
 *  entitlement snapshot — both re-derived and compared, never taken on faith.
 *
 *  ⛔ There is deliberately NO `client_reference_id` here. No provider object
 *  ever carries a renewal order's handle (Stripe mints renewal invoices
 *  autonomously; the only surviving correlation is the subscription metadata,
 *  which names the ACQUISITION order). Reusing the session-shaped evidence
 *  would force the caller to feed the order's own correlation back to us —
 *  a fence that compares a local value to itself, which LOOKS like assurance
 *  and is not. The honest renewal correlation is the two checks above. */
export interface SellerOrderRenewalPaymentEvidence {
  readonly provider: string;
  /** The provider invoice this payment settled. Must equal the order's
   *  `origin_ref` — a `provider_invoice`-keyed order can be confirmed only by
   *  ITS invoice, so evidence from another period cannot cross-confirm. */
  readonly provider_invoice_id: string;
  readonly provider_payment_id: string;
  /** The order key recovered from the PROVIDER-READ subscription metadata
   *  (`recued_workflow_key`, planted at checkout create). The store re-derives
   *  the acquisition row from it: it must exist, sell the same offer, and
   *  carry the same `entitlement_key` snapshot as this renewal order. */
  readonly acquisition_order_key: string;
  readonly payment_status: string;
  readonly amount_paid: number;
  readonly currency: string;
}

export interface SellerOrderConfirmRenewalPaymentInput {
  readonly order_key: string;
  readonly expected_revision: number;
  readonly evidence: SellerOrderRenewalPaymentEvidence;
  readonly now: number;
}

export interface SellerOrderRefundEvidence {
  readonly provider: string;
  readonly provider_payment_id: string;
  readonly refund_status: string;
  readonly amount_refunded: number;
  readonly currency: string;
}

export interface SellerOrderConfirmRefundInput {
  readonly order_key: string;
  readonly expected_revision: number;
  readonly evidence: SellerOrderRefundEvidence;
  readonly now: number;
}

export interface SellerOrderTransitionInput {
  readonly order_key: string;
  readonly expected_revision: number;
  readonly next_phase: SellerOrderPhase;
  readonly error_code?: string | null;
  readonly now: number;
}

export interface SellerOrderAttachArtifactInput {
  readonly order_key: string;
  readonly expected_revision: number;
  /** ⛔ A VERIFIED pin, never a caller's assertion. The ONLY thing that produces
   *  one is `verifySellerOrderArtifactPin`, which re-reads the bytes through the
   *  `data.file` boundary and refuses a hash that does not match source truth.
   *
   *  The two loose strings this replaced could not carry that guarantee: a
   *  `data.file` record id does NOT determine its bytes (it can be repointed —
   *  see `PinnedCasFileRef`), so a `(ref, hash)` pair taken on the caller's word
   *  proved only that the caller was self-consistent. Taking the carrier here,
   *  rather than checking at the one op that happens to call us today, is what
   *  makes this a fence instead of a door: the sweepers and the delivery leg
   *  cannot reach the row without producing one. */
  readonly artifact: PinnedCasFileRef;
  readonly now: number;
}

export interface SellerOrderLinkWorkEntityInput {
  readonly order_key: string;
  readonly expected_revision: number;
  readonly work_entity_kind: WorkEntityKind;
  readonly work_entity_id: string;
  readonly now: number;
}

/** D-207 §4.5 — the order → seller-customer link. See
 *  {@link SellerOrderStore.linkOrderCustomer}. */
export interface SellerOrderLinkCustomerInput {
  readonly order_key: string;
  readonly expected_revision: number;
  readonly customer_id: string;
  readonly now: number;
}

export interface SellerOrderListQuery {
  readonly offer_id?: string;
  readonly phase?: SellerOrderPhase;
  readonly origin_kind?: SellerOrderOriginKind;
  readonly origin_ref?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SellerOrderMutationResult {
  readonly result: 'updated' | 'unchanged';
  readonly order: SellerOrder;
}

export interface SellerOrderStore {
  openOrder(input: SellerOrderOpenInput): SellerOrderOpenResult;
  getOrder(order_key: string): SellerOrder | null;
  /** The visitor's confirm leg (§6.3a) carries ONLY the handle. */
  getOrderByHandle(order_handle: string): SellerOrder | null;
  listOrders(query?: SellerOrderListQuery): SellerOrder[];
  /** D-309 — when a customer's PAID orders for one package were paid, first and
   *  last; null when there are none. The key is the order's own snapshot of what
   *  it sold, so a customer since moved to another package has none for it. */
  paidOrderSpan(input: {
    readonly customer_id: string;
    readonly entitlement_key: string;
  }): { readonly first_paid_at: number; readonly last_paid_at: number } | null;
  quoteOrder(input: SellerOrderQuoteInput): SellerOrderMutationResult;
  attachOrderPayment(input: SellerOrderAttachPaymentInput): SellerOrderMutationResult;
  confirmOrderPayment(input: SellerOrderConfirmPaymentInput): SellerOrderMutationResult;
  /** D-196 renewal — the ONLY way a `provider_invoice`-keyed order reaches
   *  `paid`. The session-shaped {@link confirmOrderPayment} cannot serve it
   *  honestly: its correlation fence compares a provider-read
   *  `client_reference_id` against the order's handle, and no provider object
   *  ever carries a RENEWAL order's handle. This op's correlation is structural
   *  instead — the evidence invoice must be the order's own `origin_ref`, and
   *  the acquisition order recovered from provider-read subscription metadata
   *  must exist here with the same offer and entitlement snapshot. */
  confirmOrderRenewalPayment(
    input: SellerOrderConfirmRenewalPaymentInput,
  ): SellerOrderMutationResult;
  confirmOrderRefund(input: SellerOrderConfirmRefundInput): SellerOrderMutationResult;
  transitionOrder(input: SellerOrderTransitionInput): SellerOrderMutationResult;
  attachOrderArtifact(input: SellerOrderAttachArtifactInput): SellerOrderMutationResult;
  linkOrderWorkEntity(input: SellerOrderLinkWorkEntityInput): SellerOrderMutationResult;
  /** D-207 §4.5 — bind a paid order to the seller customer its fulfilment
   *  issued. One-way and idempotent, exactly like {@link linkOrderWorkEntity}:
   *  re-linking the SAME customer is a no-op (so a replayed fulfilment cannot
   *  fail), re-pointing at a DIFFERENT one conflicts (an order records one
   *  customer's money; silently re-pointing it would launder that fact).
   *
   *  The reference is navigational and deliberately NOT validated against
   *  `seller_customers` — same posture as the work-entity link, and the two
   *  stores stay uncoupled. */
  linkOrderCustomer(input: SellerOrderLinkCustomerInput): SellerOrderMutationResult;
  correlationFor(order_key: string): SellerOrderCheckoutCorrelation;
}

interface OrderRow {
  order_key: string;
  order_handle: string;
  offer_id: string;
  origin_kind: string;
  origin_ref: string;
  phase: string;
  pricing_kind: string;
  amount_minor: number | null;
  currency: string | null;
  fulfillment_recipe_id: string | null;
  customer_id: string | null;
  entitlement_key: string | null;
  fulfillment_config: string | null;
  provider: string | null;
  provider_session_id: string | null;
  provider_payment_id: string | null;
  checkout_url: string | null;
  artifact_ref: string | null;
  artifact_hash: string | null;
  linked_work_entity_kind: string | null;
  linked_work_entity_id: string | null;
  error_code: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
  paid_at: number | null;
  expires_at: number | null;
}

const orderFromRow = (row: OrderRow): SellerOrder => ({
  order_key: row.order_key,
  order_handle: row.order_handle,
  offer_id: row.offer_id,
  origin_kind: row.origin_kind as SellerOrderOriginKind,
  origin_ref: row.origin_ref,
  phase: row.phase as SellerOrderPhase,
  pricing_kind: row.pricing_kind as SellerOfferPricingKind,
  amount_minor: row.amount_minor,
  currency: row.currency,
  fulfillment_recipe_id: row.fulfillment_recipe_id,
  customer_id: row.customer_id,
  entitlement_key: row.entitlement_key,
  fulfillment_config: parseNullableJsonObject(row.fulfillment_config),
  provider: row.provider,
  provider_session_id: row.provider_session_id,
  provider_payment_id: row.provider_payment_id,
  checkout_url: row.checkout_url,
  artifact_ref: row.artifact_ref,
  artifact_hash: row.artifact_hash,
  linked_work_entity_kind: row.linked_work_entity_kind as WorkEntityKind | null,
  linked_work_entity_id: row.linked_work_entity_id,
  error_code: row.error_code,
  revision: row.revision,
  created_at: row.created_at,
  updated_at: row.updated_at,
  paid_at: row.paid_at,
  expires_at: row.expires_at,
});

const requireWholeNumber = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value)) {
    throw new SellerStoreValidationError(`${field} must be a whole number`);
  }
  return value as number;
};

const requireBoundedString = (value: unknown, field: string, max: number): string => {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > max
    || value.trim() !== value
  ) {
    throw new SellerStoreValidationError(
      `${field} must be a trimmed string of 1..${String(max)} characters`,
    );
  }
  return value;
};

/** A three-letter ISO-4217-shaped code. Compared case-insensitively against the
 *  provider so 'USD' and 'usd' cannot be read as two currencies. */
const normalizeCurrency = (value: unknown, field: string): string => {
  const raw = requireBoundedString(value, field, 8);
  return raw.toUpperCase();
};

const requireOrderKey = (value: unknown): string => {
  if (!isSellerOrderKey(value)) {
    throw new SellerStoreValidationError('order_key is malformed');
  }
  return value;
};

export const createSellerOrderStore = (
  db: Database.Database,
  opts: { readonly newHandle?: SellerOrderHandleFactory } = {},
): SellerOrderStore => {
  ensureSellerSchema(db);
  const newHandle = opts.newHandle ?? defaultSellerOrderHandleFactory;

  const getOrderStmt = db.prepare(
    `SELECT * FROM ${SELLER_ORDERS_TABLE} WHERE order_key = ?`,
  );
  const getOrderByHandleStmt = db.prepare(
    `SELECT * FROM ${SELLER_ORDERS_TABLE} WHERE order_handle = ?`,
  );
  const paidOrderSpanStmt = db.prepare(`
    SELECT MIN(paid_at) AS first_paid_at, MAX(paid_at) AS last_paid_at
      FROM ${SELLER_ORDERS_TABLE}
     WHERE customer_id = ? AND entitlement_key = ? AND paid_at IS NOT NULL
  `);
  const getOfferStmt = db.prepare(
    `SELECT * FROM ${SELLER_OFFERS_TABLE} WHERE offer_id = ?`,
  );
  const insertOrderStmt = db.prepare(`
    INSERT INTO ${SELLER_ORDERS_TABLE}
      (order_key, order_handle, offer_id, origin_kind, origin_ref, phase,
       pricing_kind, amount_minor, currency, fulfillment_recipe_id, customer_id,
       entitlement_key, fulfillment_config, revision, created_at, updated_at)
    VALUES
      (@order_key, @order_handle, @offer_id, @origin_kind, @origin_ref, @phase,
       @pricing_kind, @amount_minor, @currency, @fulfillment_recipe_id, @customer_id,
       @entitlement_key, @fulfillment_config, 0, @now, @now)
  `);

  const readOrder = (order_key: string): SellerOrder | null => {
    const row = getOrderStmt.get(order_key) as OrderRow | undefined;
    return row === undefined ? null : orderFromRow(row);
  };

  /** Every mutator lands here. It re-reads under the CAS guard, so a decision made
   *  on a stale row can never be applied to a current one. */
  const mutate = (
    order_key: string,
    expected_revision: number,
    now: number,
    apply: (order: SellerOrder) => Record<string, unknown> | null,
  ): SellerOrderMutationResult => {
    const key = requireOrderKey(order_key);
    requireWholeNumber(expected_revision, 'expected_revision');
    requireWholeNumber(now, 'now');

    return db.transaction((): SellerOrderMutationResult => {
      const order = readOrder(key);
      if (order === null) {
        throw new SellerStoreValidationError(`order '${key}' does not exist`);
      }
      if (order.revision !== expected_revision) {
        throw new SellerStoreConflictError(
          `order '${key}' revision is ${String(order.revision)}, not ${String(expected_revision)}`,
        );
      }
      const patch = apply(order);
      // A no-op is an honest outcome, not a failure: a replayed op must converge.
      if (patch === null) return { result: 'unchanged', order };

      const columns = Object.keys(patch);
      const assignments = columns.map((column) => `${column} = @${column}`).join(', ');
      db.prepare(
        `UPDATE ${SELLER_ORDERS_TABLE}
            SET ${assignments}, revision = revision + 1, updated_at = @now
          WHERE order_key = @order_key AND revision = @expected_revision`,
      ).run({ ...patch, order_key: key, expected_revision, now });

      return { result: 'updated', order: readOrder(key)! };
    })();
  };

  /** The ONE place a correlation is built. It takes the ORDER because
   *  `client_reference_id` is the CSPRNG `order_handle` — the only correlation field that
   *  travels through the visitor's browser — and the deterministic `order_key` must never
   *  leave the server (F7). Both ids live on the row, so nothing here is guessed. */
  const correlationOf = (order: {
    readonly order_key: string;
    readonly order_handle: string;
  }): SellerOrderCheckoutCorrelation => {
    const correlation = sellerOrderCheckoutCorrelation(order);
    if (correlation === null) {
      throw new SellerStoreValidationError(
        `order '${order.order_key}' cannot carry a provider correlation`,
      );
    }
    return correlation;
  };

  return {
    correlationFor(order_key) {
      const key = requireOrderKey(order_key);
      // Reads the row rather than deriving from the key alone: the handle is not a
      // function of the key (that is the point of it), so an honest correlation cannot be
      // synthesized for an order that does not exist.
      const order = readOrder(key);
      if (order === null) {
        throw new SellerStoreValidationError(`order '${key}' does not exist`);
      }
      return correlationOf(order);
    },

    openOrder(input) {
      if (!isSellerOrderOriginKind(input.origin_kind)) {
        throw new SellerStoreValidationError('origin_kind is not a known origin');
      }
      if (!isSellerOrderOriginRef(input.origin_ref)) {
        throw new SellerStoreValidationError('origin_ref is malformed');
      }
      const now = requireWholeNumber(input.now, 'now');
      const entitlement_key =
        input.entitlement_key === undefined || input.entitlement_key === null
          ? null
          : requireBoundedString(input.entitlement_key, 'entitlement_key', 256);
      const key = sellerOrderKey(input.offer_id, input.origin_ref);
      if (key === null) {
        throw new SellerStoreValidationError(
          'offer_id and origin_ref do not form a valid order key',
        );
      }
      return db.transaction((): SellerOrderOpenResult => {
        // Idempotent by construction (F7): the key is deterministic in
        // (offer, origin), so a replayed open converges on the same row rather
        // than minting a second order for one purchase. The correlation comes off the
        // EXISTING row, so a replay hands back the same `client_reference_id` the first
        // open put on the checkout link.
        const existing = readOrder(key);
        if (existing !== null) {
          // ⛔ An open that names a DIFFERENT entitlement than the row snapshotted
          // is not a replay — it is two flows colliding on one order key, the
          // silent-dedup hazard the invoice-keyed origin_ref exists to prevent.
          // Fulfilment issues whatever the SNAPSHOT says, so the divergence must
          // surface loudly here, never converge quietly. (An absent key converges:
          // readers and generic replayers do not re-assert what the order sells.)
          if (entitlement_key !== null && entitlement_key !== existing.entitlement_key) {
            throw new SellerStoreConflictError(
              `order '${key}' sells entitlement `
                + `'${String(existing.entitlement_key)}'; refusing to reopen it as `
                + `'${entitlement_key}'`,
            );
          }
          return { result: 'existing', order: existing, correlation: correlationOf(existing) };
        }

        // ⛔ The commerce terms come from the OFFER ROW, never from the caller.
        const offer = getOfferStmt.get(input.offer_id) as
          | {
              pricing_kind: string;
              amount_minor: number | null;
              currency: string | null;
              fulfillment_recipe_id: string | null;
              fulfillment_config: string | null;
              state: string;
            }
          | undefined;
        if (offer === undefined) {
          throw new SellerStoreValidationError(
            `offer '${input.offer_id}' does not exist`,
          );
        }
        if (offer.state !== 'active') {
          throw new SellerStoreValidationError(
            `offer '${input.offer_id}' is '${offer.state}', not active — it cannot be sold`,
          );
        }

        // DERIVED from the offer, not declared by the caller: an unpriced offer
        // opens straight into `pricing`, whose bucket is `needs_owner`, so a quote
        // request surfaces to the owner instead of silently sitting in `draft`.
        const phase: SellerOrderPhase =
          offer.pricing_kind === 'unspecified' ? 'pricing' : 'draft';

        const order_handle = newHandle();
        // Derived BEFORE the insert: a correlation this order could not carry (an
        // idempotency key over its ceiling) must fail without leaving a row behind.
        const correlation = correlationOf({ order_key: key, order_handle });

        insertOrderStmt.run({
          order_key: key,
          order_handle,
          offer_id: input.offer_id,
          origin_kind: input.origin_kind,
          origin_ref: input.origin_ref,
          phase,
          pricing_kind: offer.pricing_kind,
          amount_minor: offer.amount_minor,
          currency: offer.currency,
          fulfillment_recipe_id: offer.fulfillment_recipe_id,
          customer_id: input.customer_id ?? null,
          entitlement_key,
          // Verbatim copy of the offer's config string (already validated at
          // offer.ensure); immutable on the order after open, like entitlement_key.
          fulfillment_config: offer.fulfillment_config,
          now,
        });
        return { result: 'created', order: readOrder(key)!, correlation };
      })();
    },

    getOrder(order_key) {
      return isSellerOrderKey(order_key) ? readOrder(order_key) : null;
    },

    getOrderByHandle(order_handle) {
      if (!isSellerOrderHandle(order_handle)) return null;
      const row = getOrderByHandleStmt.get(order_handle) as OrderRow | undefined;
      return row === undefined ? null : orderFromRow(row);
    },

    paidOrderSpan(input) {
      const row = paidOrderSpanStmt.get(input.customer_id, input.entitlement_key) as
        { first_paid_at: number | null; last_paid_at: number | null };
      return row.first_paid_at === null || row.last_paid_at === null
        ? null
        : { first_paid_at: row.first_paid_at, last_paid_at: row.last_paid_at };
    },
    listOrders(query = {}) {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (query.offer_id !== undefined) {
        clauses.push('offer_id = @offer_id');
        params.offer_id = query.offer_id;
      }
      if (query.phase !== undefined) {
        clauses.push('phase = @phase');
        params.phase = query.phase;
      }
      if (query.origin_kind !== undefined) {
        clauses.push('origin_kind = @origin_kind');
        params.origin_kind = query.origin_kind;
      }
      if (query.origin_ref !== undefined) {
        clauses.push('origin_ref = @origin_ref');
        params.origin_ref = query.origin_ref;
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      // ⛔ The clamp lives in `@recued/contracts` so the owner rpc's `truncated`
      // flag and this page size cannot drift apart.
      const limit = clampSellerOrderListLimit(query.limit);
      const offset = query.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new SellerStoreValidationError(
          'order list offset must be a non-negative safe integer',
        );
      }
      const rows = db
        .prepare(
          `SELECT * FROM ${SELLER_ORDERS_TABLE} ${where}
            ORDER BY created_at DESC, order_key ASC
            LIMIT @limit OFFSET @offset`,
        )
        .all({ ...params, limit, offset }) as OrderRow[];
      return rows.map(orderFromRow);
    },

    quoteOrder(input) {
      const amount_minor = requireWholeNumber(input.amount_minor, 'amount_minor');
      if (amount_minor <= 0) {
        throw new SellerStoreValidationError('amount_minor must be positive');
      }
      const currency = normalizeCurrency(input.currency, 'currency');

      return mutate(input.order_key, input.expected_revision, input.now, (order) => {
        // A quote pins money onto an order that has not been paid for. Anything
        // past `awaiting_payment` has a customer who already saw a total.
        if (order.phase !== 'draft' && order.phase !== 'pricing') {
          throw new SellerStoreValidationError(
            `an order in '${order.phase}' can no longer be quoted`,
          );
        }
        if (order.amount_minor === amount_minor && order.currency === currency) {
          return null;
        }
        return { amount_minor, currency };
      });
    },

    attachOrderPayment(input) {
      const provider = requireBoundedString(input.provider, 'provider', 64);
      const provider_session_id = requireBoundedString(
        input.provider_session_id,
        'provider_session_id',
        256,
      );
      const checkout_url = input.checkout_url ?? null;
      const expires_at =
        input.expires_at === undefined || input.expires_at === null
          ? null
          : requireWholeNumber(input.expires_at, 'expires_at');

      return mutate(input.order_key, input.expected_revision, input.now, (order) => {
        if (order.amount_minor === null || order.currency === null) {
          throw new SellerStoreValidationError(
            'an unpriced order cannot take a payment — quote it first',
          );
        }
        // ⛔ F6. A crash between the provider call and this bind re-runs the
        // provider call, and the derived idempotency key makes Stripe return the
        // SAME session — so a retry lands here with the SAME id and converges. A
        // DIFFERENT id means the idempotency key did NOT hold and a second
        // Checkout Session exists. That is exactly the double-charge D-200 spent
        // real complexity to prevent, so it is a loud conflict, never a silent
        // overwrite.
        if (order.provider_session_id !== null) {
          if (order.provider_session_id === provider_session_id) return null;
          throw new SellerStoreConflictError(
            `order '${order.order_key}' already has provider session `
              + `'${order.provider_session_id}'; refusing to rebind to `
              + `'${provider_session_id}' (a second session means the idempotency `
              + 'key did not hold)',
          );
        }
        if (!isSellerOrderTransitionAllowed(order.phase, 'awaiting_payment')) {
          throw new SellerStoreValidationError(
            `an order in '${order.phase}' cannot move to 'awaiting_payment'`,
          );
        }
        return {
          phase: 'awaiting_payment',
          provider,
          provider_session_id,
          checkout_url,
          expires_at,
        };
      });
    },

    confirmOrderPayment(input) {
      const evidence = input.evidence;

      return mutate(input.order_key, input.expected_revision, input.now, (order) => {
        if (order.phase === 'paid') return null;

        // ⛔ F5. Reaching `paid` requires ALL of the following, checked HERE and
        // not in the caller. Each one closes a distinct way a caller could
        // otherwise claim money moved when it did not.
        if (order.provider_session_id === null) {
          throw new SellerStoreValidationError(
            'no provider session is attached — nothing could have been paid',
          );
        }
        if (evidence.provider_session_id !== order.provider_session_id) {
          throw new SellerStoreValidationError(
            'the evidence names a different provider session than this order attached',
          );
        }
        // The correlation is RE-DERIVED from the ORDER ROW, never accepted from the
        // caller — so a caller cannot confirm THIS order using another order's session.
        // Re-keying it onto the CSPRNG handle only strengthens this: the value the
        // evidence must carry is no longer one an attacker could compute.
        const correlation = correlationOf(order);
        if (evidence.client_reference_id !== correlation.client_reference_id) {
          throw new SellerStoreValidationError(
            'the evidence does not carry this order\'s provider correlation',
          );
        }
        if (evidence.payment_status !== 'paid') {
          throw new SellerStoreValidationError(
            `the provider reports '${evidence.payment_status}', not 'paid'`,
          );
        }
        // ⛔ The underpay fence. `amount_minor` was computed by the server from
        // the owner's offer; the provider must have collected exactly that. Without
        // this, a customer who steered the provider to a smaller total would still
        // land a `paid` order and be fulfilled.
        if (
          evidence.amount_total !== order.amount_minor
          || normalizeCurrency(evidence.currency, 'evidence.currency') !== order.currency
        ) {
          throw new SellerStoreValidationError(
            `the provider collected ${String(evidence.amount_total)} `
              + `${String(evidence.currency)}, but this order is for `
              + `${String(order.amount_minor)} ${String(order.currency)}`,
          );
        }
        if (!isSellerOrderTransitionAllowed(order.phase, 'paid')) {
          throw new SellerStoreValidationError(
            `an order in '${order.phase}' cannot move to 'paid'`,
          );
        }
        return {
          phase: 'paid',
          paid_at: input.now,
          provider_payment_id: requireBoundedString(
            evidence.provider_payment_id,
            'evidence.provider_payment_id',
            256,
          ),
          // A paid order is no longer waiting on a checkout that can lapse.
          expires_at: null,
        };
      });
    },

    confirmOrderRenewalPayment(input) {
      const evidence = input.evidence;

      return mutate(input.order_key, input.expected_revision, input.now, (order) => {
        if (order.phase === 'paid') return null;

        // ⛔ F5, renewal shape. Reaching `paid` requires ALL of the following,
        // checked HERE and not in the caller. Each closes a distinct way a
        // caller could otherwise claim renewal money moved when it did not.
        //
        // The shape discriminator: only an order KEYED ON a provider invoice can
        // be confirmed by invoice evidence. A session-keyed acquisition order
        // must go through `confirmOrderPayment`, whose session correlation it
        // can actually satisfy — the two confirm paths stay disjoint by
        // construction.
        if (order.origin_kind !== 'provider_invoice') {
          throw new SellerStoreValidationError(
            `order '${order.order_key}' is keyed on a '${order.origin_kind}' `
              + 'origin, not a provider invoice — renewal evidence cannot confirm it',
          );
        }
        // The correlation is RE-DERIVED from the ORDER ROW, never accepted from
        // the caller: the invoice named by the evidence must be the very invoice
        // this order is keyed on, so one period's payment cannot confirm another
        // period's order.
        const invoiceId = requireBoundedString(
          evidence.provider_invoice_id,
          'evidence.provider_invoice_id',
          256,
        );
        if (invoiceId !== order.origin_ref) {
          throw new SellerStoreValidationError(
            'the evidence names a different provider invoice than this order is keyed on',
          );
        }
        // The acquisition anchor. The caller recovered this key from the
        // PROVIDER-READ subscription metadata (planted at checkout create); what
        // is checked here is everything this store can check for itself: the
        // named order exists, it is not this order vouching for itself, it sells
        // the SAME offer, and it snapshotted the SAME entitlement. A renewal
        // that drifted onto another offer or another tier surfaces loudly here,
        // never as quietly extended access.
        if (!isSellerOrderKey(evidence.acquisition_order_key)) {
          throw new SellerStoreValidationError(
            'evidence.acquisition_order_key is not an order key',
          );
        }
        const acquisition = readOrder(evidence.acquisition_order_key);
        if (acquisition === null) {
          throw new SellerStoreValidationError(
            `acquisition order '${evidence.acquisition_order_key}' does not exist`,
          );
        }
        if (acquisition.order_key === order.order_key) {
          throw new SellerStoreValidationError(
            'an order cannot anchor its own renewal evidence',
          );
        }
        if (acquisition.offer_id !== order.offer_id) {
          throw new SellerStoreValidationError(
            `acquisition order '${acquisition.order_key}' sells offer `
              + `'${acquisition.offer_id}', but this renewal is for '${order.offer_id}'`,
          );
        }
        if (acquisition.entitlement_key !== order.entitlement_key) {
          throw new SellerStoreValidationError(
            `acquisition order '${acquisition.order_key}' snapshotted entitlement `
              + `'${String(acquisition.entitlement_key)}', but this renewal snapshotted `
              + `'${String(order.entitlement_key)}'`,
          );
        }
        if (evidence.payment_status !== 'paid') {
          throw new SellerStoreValidationError(
            `the provider reports '${evidence.payment_status}', not 'paid'`,
          );
        }
        // ⛔ The underpay fence, unchanged in meaning from the session confirm:
        // `amount_minor` was computed by the server from the owner's offer; the
        // provider must have collected exactly that for this period.
        if (
          evidence.amount_paid !== order.amount_minor
          || normalizeCurrency(evidence.currency, 'evidence.currency') !== order.currency
        ) {
          throw new SellerStoreValidationError(
            `the provider collected ${String(evidence.amount_paid)} `
              + `${String(evidence.currency)}, but this order is for `
              + `${String(order.amount_minor)} ${String(order.currency)}`,
          );
        }
        if (!isSellerOrderTransitionAllowed(order.phase, 'paid')) {
          throw new SellerStoreValidationError(
            `an order in '${order.phase}' cannot move to 'paid'`,
          );
        }
        return {
          phase: 'paid',
          paid_at: input.now,
          // No attach leg ran (there was never a checkout to attach), so the
          // provider identity is recorded here, alongside the payment it proved.
          provider: requireBoundedString(evidence.provider, 'evidence.provider', 64),
          provider_payment_id: requireBoundedString(
            evidence.provider_payment_id,
            'evidence.provider_payment_id',
            256,
          ),
          expires_at: null,
        };
      });
    },

    confirmOrderRefund(input) {
      const evidence = input.evidence;

      return mutate(input.order_key, input.expected_revision, input.now, (order) => {
        if (order.phase === 'refunded') return null;

        if (order.provider_payment_id === null) {
          throw new SellerStoreValidationError(
            'no provider payment is recorded — nothing could have been refunded',
          );
        }
        if (evidence.provider_payment_id !== order.provider_payment_id) {
          throw new SellerStoreValidationError(
            'the evidence names a different provider payment than this order recorded',
          );
        }
        if (evidence.refund_status !== 'succeeded') {
          throw new SellerStoreValidationError(
            `the provider reports refund '${evidence.refund_status}', not 'succeeded'`,
          );
        }
        if (!isSellerOrderTransitionAllowed(order.phase, 'refunded')) {
          throw new SellerStoreValidationError(
            `an order in '${order.phase}' cannot move to 'refunded'`,
          );
        }
        return { phase: 'refunded' };
      });
    },

    transitionOrder(input) {
      if (!isSellerOrderPhase(input.next_phase)) {
        throw new SellerStoreValidationError(
          `'${String(input.next_phase)}' is not an order phase`,
        );
      }
      // ⛔⛔ F5 — THE FREE-PDF FENCE, and the reason this check is not the graph
      // check below it.
      //
      // The lifecycle graph legitimately contains `awaiting_payment -> paid`:
      // `confirmOrderPayment` needs that edge. So a validator that consulted only
      // the graph would happily let a recipe call `transition('paid')` and then
      // fulfil — a free document, a free subscription — with no provider evidence
      // anywhere. The evidence-backed phases are therefore refused HERE, before
      // the graph is ever consulted, and the admissible set is DERIVED from the
      // evidence const rather than re-typed beside it.
      if (!isSellerOrderTransitionOpTarget(input.next_phase)) {
        throw new SellerStoreValidationError(
          `'${input.next_phase}' asserts that money moved, so it is writable only `
            + 'by its source-truth operation, never by a generic transition',
        );
      }
      const error_code =
        input.error_code === undefined || input.error_code === null
          ? null
          : requireBoundedString(input.error_code, 'error_code', 256);

      return mutate(input.order_key, input.expected_revision, input.now, (order) => {
        if (order.phase === input.next_phase) return null;
        if (!isSellerOrderTransitionAllowed(order.phase, input.next_phase)) {
          throw new SellerStoreValidationError(
            `an order in '${order.phase}' cannot move to '${input.next_phase}'`,
          );
        }
        return { phase: input.next_phase, error_code };
      });
    },

    attachOrderArtifact(input) {
      // ⛔ The type says `PinnedCasFileRef`; this says so at RUNTIME. A type-only
      // fence is defeated by one `as` cast at a call site nobody re-reads, and the
      // thing on the other side of it is the bytes a customer paid for.
      if (!isPinnedCasFileRef(input.artifact)) {
        throw new SellerStoreValidationError(
          'attachOrderArtifact requires a verified artifact pin — '
            + 'produce one with verifySellerOrderArtifactPin',
        );
      }
      const artifact_ref = input.artifact.record_id;
      const artifact_hash = input.artifact.content_sha256;

      return mutate(input.order_key, input.expected_revision, input.now, (order) => {
        // Two DIFFERENT hazards, and the old code only ever closed the first:
        //
        //  1. RE-PINNING — a later run names a different artifact. Closed here:
        //     the pin is one-way.
        //  2. RE-POINTING — the ref stays, the BYTES BEHIND IT CHANGE. NOT
        //     closable here (this layer cannot read a file), and it is the one
        //     that matters: it swaps the delivered bytes out from under an order
        //     that has already been approved, leaving the pin looking untouched.
        //     Closed by `verifySellerOrderArtifactPin`, upstream — which is why
        //     this method takes a carrier only that function can produce.
        //
        // The comment this replaced claimed to stop (2) while implementing (1).
        if (order.artifact_ref !== null) {
          if (
            order.artifact_ref === artifact_ref
            && order.artifact_hash === artifact_hash
          ) {
            return null;
          }
          throw new SellerStoreConflictError(
            `order '${order.order_key}' already pins artifact '${order.artifact_ref}'`,
          );
        }
        return { artifact_ref, artifact_hash };
      });
    },

    linkOrderWorkEntity(input) {
      if (!isWorkEntityKind(input.work_entity_kind)) {
        throw new SellerStoreValidationError(
          `'${String(input.work_entity_kind)}' is not a work-entity kind`,
        );
      }
      const work_entity_id = requireBoundedString(
        input.work_entity_id,
        'work_entity_id',
        256,
      );

      return mutate(input.order_key, input.expected_revision, input.now, (order) => {
        // §4.4a — which rows a flow produces (commitment-only / order-only /
        // both-linked) is a RECIPE decision. Core provides the link and privileges
        // none of the three. One-way, for the same reason as the artifact.
        if (order.linked_work_entity_id !== null) {
          if (
            order.linked_work_entity_kind === input.work_entity_kind
            && order.linked_work_entity_id === work_entity_id
          ) {
            return null;
          }
          throw new SellerStoreConflictError(
            `order '${order.order_key}' is already linked to `
              + `${String(order.linked_work_entity_kind)} '${String(order.linked_work_entity_id)}'`,
          );
        }
        return {
          linked_work_entity_kind: input.work_entity_kind,
          linked_work_entity_id: work_entity_id,
        };
      });
    },

    linkOrderCustomer(input) {
      const customer_id = requireBoundedString(input.customer_id, 'customer_id', 256);

      return mutate(input.order_key, input.expected_revision, input.now, (order) => {
        // §4.5 — one-way, for the same reason as the artifact + the work-entity
        // link. `order.open` can set `customer_id` up front (a renewal, whose
        // customer already exists); an ACQUISITION order is opened before the
        // customer does, so this closes the edge afterwards. Re-linking the same
        // customer is a no-op so a replayed fulfilment cannot fail.
        if (order.customer_id !== null) {
          if (order.customer_id === customer_id) return null;
          throw new SellerStoreConflictError(
            `order '${order.order_key}' is already linked to customer `
              + `'${String(order.customer_id)}'`,
          );
        }
        return { customer_id };
      });
    },
  };
};
