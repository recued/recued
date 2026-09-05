/** D-196 consolidation (2026-09-03) — the ONE faithful harness for executing
 *  seller lanes through `executeRecipe`.
 *
 *  Five suites (the Stripe renewal, accelerator, revoke, and flag lanes, and
 *  the Paddle + Lemon Squeezy lanes) each re-implemented the kernel stubs —
 *  order open / confirm / transition / link, customer-access issue / extend /
 *  swap / close, tier list — with slightly different faithfulness. This class
 *  is the union of the strictest fences each of them carried, derived where
 *  possible from the real store's own predicates (`isSellerOrderTransitionAllowed`,
 *  `isSellerOrderTransitionOpTarget`, `sellerOrderKey`) and from the provider
 *  registry (a customer id must match the provider's own grammar). Every stub
 *  THROWS on garbage, so a recipe bug cannot pass as a hollow success.
 *
 *  Only IO is stubbed: the webhook-event read and the provider reads. A suite
 *  subclasses this and overrides `providerRead` (its fixtures, its per-op
 *  argument assertions) and, when a lane has extra side effects, `sideEffect`. */
import { expect } from 'vitest';
import {
  isSellerOrderOriginKind,
  isSellerOrderTransitionAllowed,
  isSellerOrderTransitionOpTarget,
  resolveDeep,
  sellerOrderKey,
  sellerProviderFor,
  type RecipeDefinition,
  type SellerOrder,
  type SellerProviderSource,
} from '@recued/contracts';
import { executeRecipe } from '../../execute.js';
import type { ExecutionContext, IngredientExecutor } from '../../types.js';

export interface Call { slug: string; input: Record<string, unknown> }

export interface OfferRow {
  pricing_kind: string;
  amount_minor: number | null;
  currency: string | null;
  fulfillment_recipe_id: string | null;
  state: string;
}

export interface SellerLaneHarnessOptions {
  readonly provider: SellerProviderSource;
  /** The LOWERED recipe (`lowerOpStepRecipe`). */
  readonly recipe: RecipeDefinition;
  /** What `core.webhook.event.get` returns; omit for lanes with no webhook. */
  readonly event?: Record<string, unknown>;
  readonly now: number;
  readonly doorId?: string;
  /** Overrides the registry's customer-id grammar for the close/issue fences. */
  readonly customerIdOk?: (id: unknown) => boolean;
  readonly eventRef?: string;
}

const CLOSE_REASONS = new Set(['refunded', 'dispute', 'cancelled', 'payment_failed', 'seller_manual']);

/** Stripe list ops answer `{ object: 'list', data, has_more }`; every Paddle and
 *  Lemon Squeezy op answers `{ data, … }`. A Stripe single-object read is bare. */
const STRIPE_LIST_OPS = new Set([
  'invoice_payment.search',
  'active_entitlement.search',
  'entitlement_feature.search',
  'subscription.list',
]);
export const wireEnvelope = (
  provider: SellerProviderSource,
  operation: string,
  raw: unknown,
): unknown => {
  if (provider === 'stripe') {
    return STRIPE_LIST_OPS.has(operation)
      ? { object: 'list', data: raw, has_more: false, url: `/v1/${operation.replace('.', '/')}` }
      : raw;
  }
  return { data: raw, meta: { request_id: 'req_harness' } };
};

export class SellerLaneHarness {
  readonly provider: SellerProviderSource;
  readonly now: number;
  doorId: string;
  calls: Call[] = [];
  orders = new Map<string, SellerOrder>();
  offers = new Map<string, OfferRow>();
  tiers: { entitlement_key: string; tier_id: string }[] = [];
  issuedCustomers = new Map<string, { customer_id: string }>();
  lastSteps: Record<string, unknown> = {};
  /** Generic provider reads keyed `${operation}:${first arg}`; the default
   *  `providerRead` serves them, and a subclass may ignore them entirely. */
  reads = new Map<string, unknown>();
  event: Record<string, unknown>;
  private readonly recipe: RecipeDefinition;
  private readonly customerIdOk: (id: unknown) => boolean;
  private readonly eventRef: string;
  private handleSeq = 0;

  constructor(options: SellerLaneHarnessOptions) {
    this.provider = options.provider;
    this.recipe = options.recipe;
    this.event = options.event ?? {};
    this.now = options.now;
    this.doorId = options.doorId ?? 'door_main';
    const grammar = new RegExp(sellerProviderFor(options.provider).customer_id_pattern);
    this.customerIdOk = options.customerIdOk
      ?? ((id) => typeof id === 'string' && grammar.test(id));
    this.eventRef = options.eventRef ?? 'whe_lane_1';
  }

  callsFor(slug: string): Call[] {
    return this.calls.filter((c) => c.slug === slug);
  }

  /** Calls to this provider's lowered catalog ingredient, narrowed to one op. */
  providerCallsFor(operation: string): Call[] {
    return this.callsFor(`seller-${this.provider}`).filter((c) => c.input.operation === operation);
  }

  /** Alias for the Stripe-era suites. */
  stripeCallsFor(operation: string): Call[] {
    return this.providerCallsFor(operation);
  }

  read(operation: string, id: string, value: unknown): this {
    this.reads.set(`${operation}:${id}`, value);
    return this;
  }

  /** One provider read. The default serves `reads`; a subclass overrides to
   *  bring its own fixtures and per-op argument assertions. Return the RAW
   *  result payload (the harness wraps it as `{ result }`). */
  protected providerRead(operation: string, args: Record<string, unknown>): unknown {
    const first = Object.values(args)[0];
    const key = `${operation}:${Array.isArray(first) ? String(first[0]) : String(first)}`;
    if (!this.reads.has(key)) throw new Error(`unexpected provider read ${key} (args ${JSON.stringify(args)})`);
    return structuredClone(this.reads.get(key));
  }

  /** Extra side effects a lane may carry (a notification send). Return
   *  `undefined` to say "not mine", which the harness reports as unexpected. */
  protected sideEffect(_slug: string, _resolved: Record<string, unknown>): unknown {
    return undefined;
  }

  private target(input: Record<string, unknown>, slug: string): void {
    if (input.lifecycle_source !== this.provider) throw new Error(`${slug}: lifecycle_source must be ${this.provider}`);
    if (typeof input.door_id !== 'string' || input.door_id.length === 0) throw new Error(`${slug}: door_id is required`);
    if (!this.customerIdOk(input.source_customer_id)) {
      throw new Error(`${slug}: source_customer_id must be a provider customer id (${String(input.source_customer_id)})`);
    }
  }

  private periodEnd(input: Record<string, unknown>, slug: string, required: boolean): void {
    if (input.period_end === undefined) {
      if (required) throw new Error(`${slug}: period_end must be a future epoch-ms timestamp`);
      return;
    }
    if (typeof input.period_end !== 'number' || !Number.isInteger(input.period_end) || input.period_end <= this.now) {
      throw new Error(`${slug}: period_end must be a future epoch-ms integer (${String(input.period_end)})`);
    }
  }

  private withOrder(slug: string, resolved: Record<string, unknown>, fn: (order: SellerOrder) => SellerOrder | null): { result: string; order: SellerOrder } {
    const order = this.orders.get(String(resolved.order_key));
    if (!order) throw new Error(`${slug}: unknown order ${String(resolved.order_key)}`);
    const next = fn(order);
    if (next === null) return { result: 'unchanged', order: structuredClone(order) };
    const stamped = { ...next, updated_at: this.now };
    this.orders.set(stamped.order_key, stamped);
    return { result: 'updated', order: structuredClone(stamped) };
  }

  async run(config: Record<string, unknown> = {}): Promise<Awaited<ReturnType<typeof executeRecipe>>> {
    const stores: ExecutionContext['stores'] = {
      vault: {},
      config: { door_id: this.doorId, [this.provider]: `${this.provider}-primary`, ...config },
      context: { webhook: { event_ref: this.eventRef, source_truth_policy: 'provider_readback_required' } },
      meta: {},
      step: {},
    };
    const ingredientExecutor: IngredientExecutor = async (slug, input) => {
      const resolved = resolveDeep(input, stores) as Record<string, unknown>;
      this.calls.push({ slug, input: resolved });

      if (slug === 'webhook-event-get') return structuredClone(this.event);

      if (slug === `seller-${this.provider}`) {
        const operation = String(resolved.operation);
        const raw = this.providerRead(operation, resolved.args as Record<string, unknown>);
        // ⛔ An op-step's `result` is the provider's WHOLE response body — the
        // engine does not unwrap the catalog's `result_path` for a plain op-step.
        // A fixture is authored as the bare entity (that is what a test wants
        // to state); the harness puts it back in the envelope the wire carries,
        // so a lane that reads `result.id` where the provider sends
        // `result.data.id` fails HERE and not in production. Found by the
        // semi-live Paddle drive (2026-09-04) after 21 recipes shipped that way.
        return { result: wireEnvelope(this.provider, operation, raw) };
      }

      if (slug === 'seller-order-get') {
        const row = typeof resolved.order_handle === 'string' && resolved.order_handle !== ''
          ? [...this.orders.values()].find((o) => o.order_handle === resolved.order_handle)
          : this.orders.get(String(resolved.order_key));
        return { order: row === undefined ? null : structuredClone(row) };
      }

      if (slug === 'seller-order-open') {
        // FAITHFUL to `openOrder`: deterministic key, idempotent replay, loud
        // entitlement drift, commerce terms from the OFFER row — never the caller.
        if (!isSellerOrderOriginKind(resolved.origin_kind)) throw new Error('origin_kind is not a known origin');
        const key = sellerOrderKey(String(resolved.offer_id), String(resolved.origin_ref));
        if (key === null) throw new Error('offer_id and origin_ref do not form a valid order key');
        const entitlement = resolved.entitlement_key == null ? null : String(resolved.entitlement_key);
        const existing = this.orders.get(key);
        if (existing !== undefined) {
          if (entitlement !== null && entitlement !== existing.entitlement_key) {
            throw new Error(`order '${key}' sells entitlement '${String(existing.entitlement_key)}'; refusing to reopen it as '${entitlement}'`);
          }
          return { result: 'existing', order: structuredClone(existing), correlation: { order_key: key } };
        }
        const offer = this.offers.get(String(resolved.offer_id));
        if (offer === undefined) throw new Error(`offer '${String(resolved.offer_id)}' does not exist`);
        if (offer.state !== 'active') throw new Error(`offer is '${offer.state}', not active`);
        this.handleSeq += 1;
        const row: SellerOrder = {
          order_key: key,
          order_handle: `oh_${String(this.handleSeq).padStart(64, '0')}`,
          offer_id: String(resolved.offer_id),
          origin_kind: resolved.origin_kind,
          origin_ref: String(resolved.origin_ref),
          phase: 'draft',
          pricing_kind: offer.pricing_kind as SellerOrder['pricing_kind'],
          amount_minor: offer.amount_minor,
          currency: offer.currency,
          fulfillment_recipe_id: offer.fulfillment_recipe_id,
          customer_id: null,
          entitlement_key: entitlement,
          provider: null,
          provider_session_id: null,
          provider_payment_id: null,
          checkout_url: null,
          fulfillment_config: null,
          artifact_ref: null,
          artifact_hash: null,
          linked_work_entity_kind: null,
          linked_work_entity_id: null,
          error_code: null,
          revision: 0,
          created_at: this.now,
          updated_at: this.now,
          paid_at: null,
          expires_at: null,
        };
        this.orders.set(key, row);
        return { result: 'created', order: structuredClone(row), correlation: { order_key: key } };
      }

      if (slug === 'seller-order-confirm-payment') {
        // FAITHFUL to `confirmOrderPayment`: the session-keyed acquisition leg.
        return this.withOrder(slug, resolved, (order) => {
          const ev = resolved.evidence as Record<string, unknown>;
          if (order.phase === 'paid') return null;
          if (order.revision !== resolved.expected_revision) throw new Error('confirm CAS conflict');
          if (order.phase !== 'awaiting_payment') throw new Error(`an order in '${order.phase}' is not awaiting payment`);
          if (ev.provider_session_id !== order.provider_session_id) throw new Error('the evidence names a different provider session than this order attached');
          if (ev.client_reference_id !== order.order_handle) throw new Error("the evidence does not carry this order's provider correlation");
          if (ev.payment_status !== 'paid') throw new Error(`the provider reports '${String(ev.payment_status)}', not 'paid'`);
          if (ev.amount_total !== order.amount_minor || String(ev.currency).toUpperCase() !== order.currency) {
            throw new Error('the underpay fence: collected total does not match this order');
          }
          const paymentId = ev.provider_payment_id;
          if (typeof paymentId !== 'string' || paymentId.length === 0 || paymentId.length > 256) throw new Error('evidence.provider_payment_id must be a bounded string');
          return { ...order, phase: 'paid', provider: String(ev.provider), provider_payment_id: paymentId, paid_at: this.now, revision: order.revision + 1 };
        });
      }

      if (slug === 'seller-order-confirm-renewal-payment') {
        // FAITHFUL to `confirmOrderRenewalPayment`: each throw is a way a caller
        // could otherwise claim renewal money moved when it did not.
        return this.withOrder(slug, resolved, (row) => {
          const evidence = resolved.evidence as Record<string, unknown>;
          if (row.phase === 'paid') return null;
          if (row.revision !== resolved.expected_revision) throw new Error('confirm CAS conflict');
          if (row.origin_kind !== 'provider_invoice') throw new Error(`order '${row.order_key}' is keyed on a '${row.origin_kind}' origin, not a provider invoice`);
          if (evidence.provider_invoice_id !== row.origin_ref) throw new Error('the evidence names a different provider invoice than this order is keyed on');
          const anchor = this.orders.get(String(evidence.acquisition_order_key));
          if (anchor === undefined) throw new Error(`acquisition order '${String(evidence.acquisition_order_key)}' does not exist`);
          if (anchor.order_key === row.order_key) throw new Error('an order cannot anchor its own renewal evidence');
          if (anchor.offer_id !== row.offer_id) throw new Error(`acquisition order sells offer '${anchor.offer_id}', but this renewal is for '${row.offer_id}'`);
          if (anchor.entitlement_key !== row.entitlement_key) throw new Error('acquisition entitlement snapshot drifted from this renewal');
          if (evidence.payment_status !== 'paid') throw new Error(`the provider reports '${String(evidence.payment_status)}', not 'paid'`);
          if (evidence.amount_paid !== row.amount_minor || String(evidence.currency).toUpperCase() !== row.currency) {
            throw new Error('the underpay fence: collected total does not match this order');
          }
          if (!isSellerOrderTransitionAllowed(row.phase, 'paid')) throw new Error(`an order in '${row.phase}' cannot move to 'paid'`);
          const paymentId = evidence.provider_payment_id;
          if (typeof paymentId !== 'string' || paymentId.length === 0 || paymentId.length > 256) throw new Error('evidence.provider_payment_id must be a bounded string');
          return { ...row, phase: 'paid', paid_at: this.now, provider: String(evidence.provider), provider_payment_id: paymentId, expires_at: null, revision: row.revision + 1 };
        });
      }

      if (slug === 'seller-order-transition') {
        return this.withOrder(slug, resolved, (row) => {
          if (row.revision !== resolved.expected_revision) {
            throw new Error(`transition CAS conflict: expected ${String(resolved.expected_revision)} got ${row.revision}`);
          }
          const next_phase = String(resolved.next_phase);
          // FAITHFUL fences, DERIVED from the real store's own predicates — never
          // a re-typed literal edge list.
          if (!isSellerOrderTransitionOpTarget(next_phase)) {
            throw new Error(`'${next_phase}' asserts that money moved, so it is writable only by its source-truth operation`);
          }
          if (row.phase !== next_phase && !isSellerOrderTransitionAllowed(row.phase, next_phase)) {
            throw new Error(`an order in '${row.phase}' cannot move to '${next_phase}'`);
          }
          return { ...row, phase: next_phase as SellerOrder['phase'], revision: row.revision + 1 };
        });
      }

      if (slug === 'seller-order-link-customer') {
        return this.withOrder(slug, resolved, (row) => {
          if (row.revision !== resolved.expected_revision) throw new Error('link CAS conflict');
          const customer_id = String(resolved.customer_id);
          if (row.customer_id !== null && row.customer_id !== customer_id) throw new Error(`order is already linked to customer '${row.customer_id}'`);
          return { ...row, customer_id, revision: row.customer_id === customer_id ? row.revision : row.revision + 1 };
        });
      }

      if (slug === 'customer-access-issue') {
        // FAITHFUL: refuses an empty tier and a past period end; create-OR-extend
        // keyed on (lifecycle_source, door, source_customer_id).
        this.target(resolved, slug);
        const key = resolved.entitlement_key;
        if (typeof key !== 'string' || key.length === 0) throw new Error('entitlement_key must be a nonempty string');
        this.periodEnd(resolved, slug, true);
        const sourceCustomer = String(resolved.source_customer_id);
        const existing = this.issuedCustomers.get(sourceCustomer);
        if (existing !== undefined) return { result: 'extended', customer: structuredClone(existing) };
        const customer = { customer_id: 'sc_test_1' };
        this.issuedCustomers.set(sourceCustomer, customer);
        return { result: 'created', customer: structuredClone(customer) };
      }
      if (slug === 'customer-access-extend') {
        this.target(resolved, slug);
        this.periodEnd(resolved, slug, false);
        return { result: 'extended', customer: { customer_id: 'sc_test_1' } };
      }
      if (slug === 'customer-access-swap-tier') {
        this.target(resolved, slug);
        if (typeof resolved.entitlement_key !== 'string' || resolved.entitlement_key.length === 0) throw new Error('swap-tier: entitlement_key required');
        return { result: 'swapped', customer: { customer_id: 'sc_test_1' } };
      }
      if (slug === 'customer-access-close') {
        // FAITHFUL to the kernel `customer-access-close` contract: a supported
        // seller close reason, a full target, and the provider's status verbatim.
        this.target(resolved, slug);
        if (!CLOSE_REASONS.has(String(resolved.reason))) throw new Error(`customer-access-close: unsupported reason ${String(resolved.reason)}`);
        if (resolved.source_status !== undefined && (typeof resolved.source_status !== 'string' || resolved.source_status.length === 0)) {
          throw new Error("customer-access-close: source_status must be the provider's word");
        }
        return { result: 'closed', state: 'ended' };
      }
      if (slug === 'seller-tier-list') {
        if (resolved.lifecycle_source !== this.provider || resolved.door_id !== this.doorId) throw new Error('tier-list: wrong door or source');
        return { tiers: structuredClone(this.tiers) };
      }

      const extra = this.sideEffect(slug, resolved);
      if (extra !== undefined) return extra;
      throw new Error(`unexpected side effect: ${slug} ${JSON.stringify(resolved)}`);
    };

    const ctx: ExecutionContext = { recipe: this.recipe, stores, ingredientExecutor };
    const result = await executeRecipe(ctx);
    this.lastSteps = stores.step as Record<string, unknown>;
    return result;
  }
}

/** Assert a run finished with no engine errors. */
export const expectGreen = (result: Awaited<ReturnType<typeof executeRecipe>>): void => {
  expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
  expect(result.success).toBe(true);
};
