/** D-196 S5 — an in-process mock of the slice of the Stripe test-mode API that the
 *  seller E2Es drive (`d-196-s5-stripe-testclock.integration.test.ts` for the
 *  subscription arc, `d-196-1d-pass-checkout.integration.test.ts` for the one-time
 *  pass arc).
 *
 *  It is a small faithful state machine, NOT a general Stripe emulator: it models
 *  only the endpoints + billing behavior the E2Es exercise, so the SAME test runs
 *  against it by default (no credentials, executes in CI) and against real Stripe
 *  when the integration env is set. The fidelity that matters:
 *   - a test clock advance past a subscription's period end RENEWS it: on a good
 *     card the period rolls forward and status stays `active`; on the failing card
 *     the status goes `past_due` and the period does NOT advance (dunning);
 *   - deleting a subscription makes it `canceled`;
 *   - a Checkout Session is CREATED FROM THE CALLER'S OWN REQUEST — the id, the
 *     collected total, the currency, the correlation fields and the metadata are
 *     all derived from the form body the caller actually sent, never from a fixture
 *     (see `/v1/checkout/sessions` below for why that is the point).
 *  These are exactly the transitions the §6.3 reconciler and the pass recipes'
 *  provider fences converge against, so the E2Es assert real convergence over a
 *  Stripe-shaped surface.
 *
 *  ⚠ Test-only. For the SUBSCRIPTION arc, a real Stripe run (opt-in) is the
 *  higher-fidelity check; this mock proves the reconciler/store/lifecycle wiring
 *  and the scenario end to end. The PASS arc has no real-Stripe counterpart: a
 *  hosted Checkout Session can only be paid through Stripe's hosted page, never
 *  through the API, so `settleCheckoutSession` (below) is a mock-only affordance
 *  and that leg of the pass E2E is unavailable against live Stripe by design. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The shared Stripe test PaymentMethod that FAILS at charge time. Any other pm id
 *  (e.g. `pm_card_visa`) succeeds. Matching Stripe's documented test PMs keeps the
 *  E2E's setup identical across the mock and the real API. */
export const MOCK_FAILING_PAYMENT_METHOD = 'pm_card_chargeCustomerFail';

/** One billing period, in seconds. A calendar month on real Stripe; a fixed 30
 *  days here — the E2E only advances relative to the period end it reads back, so
 *  the exact length never matters, only that renew rolls it strictly forward. */
const PERIOD_SECONDS = 30 * 24 * 60 * 60;

/** One request the mock received, decoded. Exposed because some properties are
 *  only observable on the REQUEST: Stripe defaults `mode` to `payment`, so a
 *  session coming back in payment mode proves nothing about whether the caller's
 *  binding actually sent it. Asserting on the sent form closes that gap. */
export interface MockStripeRequest {
  readonly method: string;
  readonly path: string;
  readonly form: Record<string, string>;
}

export interface MockStripeServer {
  readonly baseUrl: string;
  close(): Promise<void>;
  /** Every request received, in order. */
  requests(): MockStripeRequest[];
  /** Complete a hosted Checkout Session the way a buyer would on Stripe's page:
   *  settle the PaymentIntent, mark the session `complete`/`paid`, and record the
   *  email the buyer supplied (defaulting to the `customer_email` the session was
   *  created with, which is what Stripe prefills).
   *
   *  ⚠ MOCK-ONLY BY NECESSITY, not by shortcut. Stripe exposes no API that pays a
   *  hosted Checkout Session — it settles only through the hosted page — so this
   *  leg simply has no live-Stripe counterpart to defer to. It is deliberately a
   *  method on the server handle rather than an HTTP route, so nothing here can be
   *  mistaken for a Stripe endpoint the product could ever call.
   *
   *  Throws on an unknown session, so a typo'd id fails the test instead of
   *  silently leaving the session unpaid and reading as "the recipe refused it". */
  settleCheckoutSession(sessionId: string, opts?: { readonly email?: string }): void;
}

interface Product { id: string; object: 'product'; name: string }
interface Price {
  id: string;
  object: 'price';
  product: string;
  unit_amount: number | null;
  currency: string | null;
  recurring: { interval: string } | null;
}
interface TestClock {
  id: string;
  object: 'test_helpers.test_clock';
  status: 'ready';
  frozen_time: number;
}
interface Customer {
  id: string;
  object: 'customer';
  name: string | null;
  test_clock: string | null;
  invoice_settings: { default_payment_method: string | null };
}
interface SubscriptionItem {
  id: string;
  object: 'subscription_item';
  price: string;
  current_period_end: number;
}
interface Subscription {
  id: string;
  object: 'subscription';
  status: 'active' | 'trialing' | 'past_due' | 'unpaid' | 'canceled';
  customer: string;
  default_payment_method: string | null;
  items: { object: 'list'; data: SubscriptionItem[] };
}
interface PaymentIntent {
  id: string;
  object: 'payment_intent';
  status: 'requires_payment_method' | 'succeeded';
  amount: number;
  currency: string;
  customer: string | null;
  metadata: Record<string, string>;
}
interface CheckoutSession {
  id: string;
  object: 'checkout.session';
  mode: string;
  /** `open` until the buyer completes the hosted page, then `complete`. */
  status: 'open' | 'complete' | 'expired';
  /** `unpaid` until the charge settles, then `paid`. */
  payment_status: 'unpaid' | 'paid';
  url: string | null;
  client_reference_id: string | null;
  /** A guest `mode: payment` session has NO customer id — the collected email is
   *  the only identity it carries. That is exactly why the pass fulfilment keys
   *  its customer on `customer_details.email`. */
  customer: string | null;
  customer_details: { email: string | null };
  amount_total: number | null;
  currency: string | null;
  expires_at: number | null;
  metadata: Record<string, string>;
  payment_intent: string | null;
  subscription: string | null;
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export const startMockStripeServer = async (): Promise<MockStripeServer> => {
  let seq = 0;
  const mint = (prefix: string): string => `${prefix}_${(++seq).toString(36)}${Date.now().toString(36)}`;

  const products = new Map<string, Product>();
  const prices = new Map<string, Price>();
  const clocks = new Map<string, TestClock>();
  const customers = new Map<string, Customer>();
  const subscriptions = new Map<string, Subscription>();
  const sessions = new Map<string, CheckoutSession>();
  const paymentIntents = new Map<string, PaymentIntent>();
  /** Idempotency-Key → the session it minted. Stripe replays the ORIGINAL object
   *  for a repeated key rather than creating a second one; the pass opener leans on
   *  exactly that when a run retries after the session already exists. */
  const sessionsByIdempotencyKey = new Map<string, string>();
  const received: MockStripeRequest[] = [];

  /** The effective default PM for a subscription's renewals: the sub's own, else
   *  the customer's invoice-settings default (what Stripe falls back to). */
  const effectivePaymentMethod = (sub: Subscription): string | null => {
    if (sub.default_payment_method !== null) return sub.default_payment_method;
    return customers.get(sub.customer)?.invoice_settings.default_payment_method ?? null;
  };

  /** Advance every subscription bound to `clockId` up to `frozenTime`. This is the
   *  billing engine: while a renewal is due, charge the effective PM — succeed
   *  (roll the period forward, stay active) or fail (go past_due, leave the period,
   *  stop until a future retry we do not model). */
  const runBilling = (clockId: string, frozenTime: number): void => {
    for (const sub of subscriptions.values()) {
      const customer = customers.get(sub.customer);
      if (!customer || customer.test_clock !== clockId) continue;
      if (sub.status === 'canceled' || sub.status === 'unpaid') continue;
      const item = sub.items.data[0];
      if (!item) continue;
      let guard = 0;
      while (frozenTime >= item.current_period_end && guard++ < 240) {
        if (effectivePaymentMethod(sub) === MOCK_FAILING_PAYMENT_METHOD) {
          sub.status = 'past_due';
          break;
        }
        item.current_period_end += PERIOD_SECONDS;
        sub.status = 'active';
      }
    }
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(payload);
  };
  const stripeError = (res: ServerResponse, status: number, message: string): void =>
    json(res, status, { error: { type: 'invalid_request_error', message } });

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://mock');
        const path = url.pathname;
        const seg = path.split('/').filter((s) => s.length > 0); // e.g. ['v1','subscriptions','sub_1']
        const body = method === 'GET' ? '' : await readBody(req);
        const form = new URLSearchParams(body);
        received.push({ method, path, form: Object.fromEntries(form.entries()) });

        // ── /v1/products ──────────────────────────────────────────────────────
        if (method === 'POST' && path === '/v1/products') {
          const product: Product = { id: mint('prod'), object: 'product', name: form.get('name') ?? '' };
          products.set(product.id, product);
          return json(res, 200, product);
        }

        // ── /v1/prices ────────────────────────────────────────────────────────
        if (method === 'POST' && path === '/v1/prices') {
          const interval = form.get('recurring[interval]');
          const price: Price = {
            id: mint('price'),
            object: 'price',
            product: form.get('product') ?? '',
            unit_amount: form.has('unit_amount') ? Number(form.get('unit_amount')) : null,
            currency: form.get('currency'),
            recurring: interval !== null ? { interval } : null,
          };
          prices.set(price.id, price);
          return json(res, 200, price);
        }

        // ── /v1/test_helpers/test_clocks[...] ─────────────────────────────────
        if (path === '/v1/test_helpers/test_clocks' && method === 'POST') {
          const clock: TestClock = {
            id: mint('clock'),
            object: 'test_helpers.test_clock',
            status: 'ready',
            frozen_time: Number(form.get('frozen_time') ?? '0'),
          };
          clocks.set(clock.id, clock);
          return json(res, 200, clock);
        }
        if (seg[1] === 'test_helpers' && seg[2] === 'test_clocks' && seg[3] !== undefined) {
          const clock = clocks.get(seg[3]);
          if (seg[4] === 'advance' && method === 'POST') {
            if (!clock) return stripeError(res, 404, 'No such test clock');
            clock.frozen_time = Number(form.get('frozen_time') ?? String(clock.frozen_time));
            runBilling(clock.id, clock.frozen_time); // advance settles synchronously
            return json(res, 200, clock);
          }
          if (seg[4] === undefined && method === 'GET') {
            if (!clock) return stripeError(res, 404, 'No such test clock');
            return json(res, 200, clock);
          }
          if (seg[4] === undefined && method === 'DELETE') {
            clocks.delete(seg[3]);
            return json(res, 200, { id: seg[3], object: 'test_helpers.test_clock', deleted: true });
          }
        }

        // ── /v1/customers[...] ────────────────────────────────────────────────
        if (path === '/v1/customers' && method === 'POST') {
          const customer: Customer = {
            id: mint('cus'),
            object: 'customer',
            name: form.get('name'),
            test_clock: form.get('test_clock'),
            invoice_settings: { default_payment_method: null },
          };
          customers.set(customer.id, customer);
          return json(res, 200, customer);
        }
        if (seg[1] === 'customers' && seg[2] !== undefined && seg[3] === undefined && method === 'POST') {
          const customer = customers.get(seg[2]);
          if (!customer) return stripeError(res, 404, 'No such customer');
          const dpm = form.get('invoice_settings[default_payment_method]');
          if (dpm !== null) customer.invoice_settings.default_payment_method = dpm;
          return json(res, 200, customer);
        }

        // ── /v1/payment_methods/{pm}/attach ──────────────────────────────────
        if (seg[1] === 'payment_methods' && seg[3] === 'attach' && method === 'POST') {
          // The mock treats pm ids as opaque bearer strings (their success/failure
          // is decided at charge time by id), so attach only needs to acknowledge.
          return json(res, 200, {
            id: seg[2],
            object: 'payment_method',
            customer: form.get('customer'),
          });
        }

        // ── /v1/checkout/sessions[...] ────────────────────────────────────────
        // THE fidelity point of this route: the session is BUILT FROM THE REQUEST.
        // The id, collected total, currency, correlation ids and metadata are all
        // read out of the form body the caller actually sent. A fixture-shaped stub
        // returns a session that agrees with the recipe by construction; this one
        // agrees only if the recipe genuinely sent those fields, so the opener's
        // provider-result fences (amount / currency / client_reference_id /
        // metadata.recued_workflow_key) test a real round trip instead of a
        // hand-authored echo.
        if (path === '/v1/checkout/sessions' && method === 'POST') {
          const idempotencyKey = req.headers['idempotency-key'];
          const priorId = typeof idempotencyKey === 'string'
            ? sessionsByIdempotencyKey.get(idempotencyKey)
            : undefined;
          if (priorId !== undefined) {
            const prior = sessions.get(priorId);
            if (prior) return json(res, 200, prior);
          }

          const mode = form.get('mode') ?? 'payment';
          const email = form.get('customer_email');
          const unitAmount = form.get('line_items[0][price_data][unit_amount]');
          const currency = form.get('line_items[0][price_data][currency]');
          const expiresAt = form.get('expires_at');

          // Metadata arrives as bracketed form keys (`metadata[k]=v`); collect the
          // whole map rather than the one key the recipes happen to send today.
          const metadata: Record<string, string> = {};
          for (const [key, value] of form.entries()) {
            const match = /^metadata\[(.+)\]$/.exec(key);
            if (match?.[1] !== undefined) metadata[match[1]] = value;
          }

          const session: CheckoutSession = {
            id: mint('cs'),
            object: 'checkout.session',
            mode,
            status: 'open',
            payment_status: 'unpaid',
            url: null, // filled below — the hosted URL embeds the session id
            client_reference_id: form.get('client_reference_id'),
            // A `mode: payment` session is a GUEST checkout: no customer id. Stripe
            // still prefills the collected email from `customer_email`.
            customer: null,
            customer_details: { email },
            amount_total: unitAmount !== null ? Number(unitAmount) : null,
            currency,
            expires_at: expiresAt !== null ? Number(expiresAt) : null,
            metadata,
            payment_intent: null, // minted below for mode:payment
            subscription: null,
          };
          session.url = `https://checkout.stripe.test/c/pay/${session.id}`;

          // For `mode: payment` Stripe mints the PaymentIntent WITH the session, so
          // it is readable (and unsettled) before the buyer ever pays. The pass
          // fulfilment never reads it, but modelling it keeps the `payment.read` op
          // and the paid-order confirmers honest against this same mock.
          if (mode === 'payment') {
            const piMetadata: Record<string, string> = {};
            for (const [key, value] of form.entries()) {
              const match = /^payment_intent_data\[metadata\]\[(.+)\]$/.exec(key);
              if (match?.[1] !== undefined) piMetadata[match[1]] = value;
            }
            const intent: PaymentIntent = {
              id: mint('pi'),
              object: 'payment_intent',
              status: 'requires_payment_method',
              amount: session.amount_total ?? 0,
              currency: session.currency ?? 'usd',
              customer: null,
              metadata: piMetadata,
            };
            paymentIntents.set(intent.id, intent);
            session.payment_intent = intent.id;
          }

          sessions.set(session.id, session);
          if (typeof idempotencyKey === 'string') {
            sessionsByIdempotencyKey.set(idempotencyKey, session.id);
          }
          return json(res, 200, session);
        }
        if (seg[1] === 'checkout' && seg[2] === 'sessions' && seg[3] !== undefined
          && seg[4] === undefined && method === 'GET') {
          const session = sessions.get(seg[3]);
          if (!session) return stripeError(res, 404, 'No such checkout.session');
          return json(res, 200, session);
        }

        // ── /v1/payment_intents/{pi} ──────────────────────────────────────────
        if (seg[1] === 'payment_intents' && seg[2] !== undefined && seg[3] === undefined
          && method === 'GET') {
          const intent = paymentIntents.get(seg[2]);
          if (!intent) return stripeError(res, 404, 'No such payment_intent');
          return json(res, 200, intent);
        }

        // ── /v1/subscriptions[...] ────────────────────────────────────────────
        if (path === '/v1/subscriptions' && method === 'POST') {
          const customerId = form.get('customer') ?? '';
          const customer = customers.get(customerId);
          if (!customer) return stripeError(res, 404, 'No such customer');
          const clock = customer.test_clock !== null ? clocks.get(customer.test_clock) : undefined;
          const frozen = clock?.frozen_time ?? Math.floor(Date.now() / 1000);
          const defaultPm = form.get('default_payment_method');
          const sub: Subscription = {
            id: mint('sub'),
            object: 'subscription',
            // First-invoice outcome: the failing card leaves it past_due; a good
            // card (the E2E's setup) makes it active.
            status:
              (defaultPm ?? customer.invoice_settings.default_payment_method) === MOCK_FAILING_PAYMENT_METHOD
                ? 'past_due'
                : 'active',
            customer: customerId,
            default_payment_method: defaultPm,
            items: {
              object: 'list',
              data: [
                {
                  id: mint('si'),
                  object: 'subscription_item',
                  price: form.get('items[0][price]') ?? '',
                  current_period_end: frozen + PERIOD_SECONDS,
                },
              ],
            },
          };
          subscriptions.set(sub.id, sub);
          return json(res, 200, sub);
        }
        if (seg[1] === 'subscriptions' && seg[2] !== undefined && seg[3] === undefined) {
          const sub = subscriptions.get(seg[2]);
          if (!sub) return stripeError(res, 404, 'No such subscription');
          if (method === 'GET') return json(res, 200, sub);
          if (method === 'DELETE') {
            sub.status = 'canceled';
            return json(res, 200, sub);
          }
        }

        return stripeError(res, 404, `mock stripe: unrouted ${method} ${path}`);
      } catch (e) {
        stripeError(res, 500, e instanceof Error ? e.message : String(e));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    requests: () => received.map((r) => ({ ...r, form: { ...r.form } })),
    settleCheckoutSession: (sessionId, opts) => {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error(`mock stripe: cannot settle unknown checkout session '${sessionId}'`);
      }
      const email = opts?.email ?? session.customer_details.email;
      if (email === null) {
        throw new Error(
          `mock stripe: session '${sessionId}' collected no email — a real hosted `
            + 'checkout always collects one, so settling without it would model a '
            + 'session Stripe cannot produce',
        );
      }
      session.status = 'complete';
      session.payment_status = 'paid';
      session.customer_details = { email };
      if (session.payment_intent !== null) {
        const intent = paymentIntents.get(session.payment_intent);
        if (intent) intent.status = 'succeeded';
      }
    },
  };
};
