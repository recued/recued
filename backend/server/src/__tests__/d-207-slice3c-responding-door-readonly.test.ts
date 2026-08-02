/** D-207 slice 3c — a door that OWES the visitor a synchronous response cannot write.
 *
 *  ## The bug this closes, stated plainly
 *
 *  An anonymous actor is pinned to the contracted `read` trust ceiling (slice 1a), so ANY
 *  write-tier op in a paired recipe resolves to `ask` and HOLDS the run at the D-157 gate.
 *  A held run returns NO OUTPUT. So on a door that was going to hand the visitor something
 *  back, one write means: submission accepted → run holds → no `output.render` → bare
 *  thank-you page → they never get the thing they came for.
 *
 *  On a SELLING door that thing is a way to pay. That is the exact lie D-207 exists to
 *  kill, in its third coat — and it is not an intermittent failure. It happens on EVERY
 *  submission, so the form is broken 100% of the time.
 *
 *  ## What must NOT change
 *
 *  A PLAIN intake door — no offer, no rendered response — keeps writing. There a hold is
 *  exactly right: the owner approves it in the D-173 Inbox, and "we got your submission"
 *  stays TRUE because nothing was owed in return. That is slice 1's lead-capture
 *  acceptance, and a fence that broke it would have traded one lie for a worse narrowing. */

import { describe, expect, it } from 'vitest';

import type { ContractDefinition, RecipeDefinition } from '@recued/contracts';

import { bindReceptionDoor } from '../reception-door-bind.js';
import type { ContractDefinitionStore } from '../storage/contract-definition-store.js';
import type { ContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import type { ReceptionIntakeRecipePairStore } from '../storage/reception-intake-recipe-pair-store.js';

const NOW = () => 1_000;

/** A block in `output.render` is what makes a door RESPONDING. Derived by the engine's own
 *  `recipeOutputSections`, never declared — a declared flag could disagree with what the
 *  recipe actually does, and that disagreement is the class of bug this arc keeps finding. */
const RENDERS = { render: [{ type: 'text', source: '{{step.x}}' }] };

const harness = (opts?: {
  config?: Record<string, unknown>;
  opRisk?: Record<string, string>;
}) => {
  const defs = new Map<string, ContractDefinition>();
  const pairs = new Map<string, { contract_id: string | null }>([['ep1', { contract_id: null }]]);
  let n = 0;
  return {
    definitionStore: {
      mint: (i: Record<string, unknown>) => {
        const d = { contract_id: `c${++n}`, status: 'active', minted_at: NOW(), ...i } as unknown as ContractDefinition;
        defs.set(d.contract_id, d);
        return d;
      },
      get: (id: string) => defs.get(id) ?? null,
      revoke: (id: string) => defs.get(id) ?? null,
    } as unknown as ContractDefinitionStore,
    grantEntryStore: { set: () => {} } as unknown as ContractGrantEntryStore,
    pairStore: {
      findByEndpoint: (e: string) => (pairs.has(e) ? { contract_id: pairs.get(e)!.contract_id } : null),
      setContractId: (i: { endpoint_id: string; contract_id: string | null }) => {
        pairs.set(i.endpoint_id, { contract_id: i.contract_id });
        return true;
      },
    } as unknown as ReceptionIntakeRecipePairStore,
    now: NOW,
    resolveConfig: () => opts?.config ?? {},
    // Pack-catalog risks only; the bind falls back to the kernel registry itself.
    ...(opts?.opRisk
      ? {
          resolveOpRisk: (op: string) => opts.opRisk![op],
          resolveOpKinds: () => new Map(
            Object.keys(opts.opRisk!).map((op) => [op, 'http']),
          ),
        }
      : {}),
  };
};

const bind = (
  h: Parameters<typeof bindReceptionDoor>[1],
  recipe: Record<string, unknown>,
) =>
  bindReceptionDoor(
    {
      endpointId: 'ep1',
      recipeId: 'r1',
      recipe: recipe as unknown as RecipeDefinition,
      mintedBy: 'owner',
      confirmed: true,
    },
    h,
  );

describe('D-207 slice 3c — the recipe ruling B is actually about', () => {
  /** ⛔ THE ONE THAT MATTERS. `start-paid-document-fulfillment` is the only D-200 recipe
   *  that is BOTH form-sourced AND dispatches a checkout-create — it is the sole thing the
   *  `isLegacyDirectCheckout` guard was protecting from a door.
   *
   *  Delete that guard with this recipe still bindable and it gets a door, its
   *  checkout-create HOLDS, and the visitor is thanked without ever being asked to pay:
   *  the guard deleted and the hole it plugged re-opened in the same commit. This test is
   *  what makes the deletion safe. */
  /** The op closure of `start-paid-document-fulfillment`, transcribed from the recipe as it
   *  stood at the commit that deleted it (16 distinct dispatch targets across
   *  `prefetch_steps` + `steps`; the 362 steps collapse to these).
   *
   *  ⚠ Deliberately a TRANSCRIPTION and not a file read. The recipe is gone — deleting it is
   *  half of what this fence authorizes — so a test that loaded it would have to keep the
   *  artifact alive to prove the artifact can be removed. What must survive is the SHAPE:
   *  any recipe that sells and writes is refused, and this is what that shape looked like in
   *  the one that mattered. */
  const PAID_DOCUMENT_FULFILLMENT_STEPS = [
    { id: 'form', op: 'core.data.form-response.get' },
    { id: 'state', op: 'core.storage.shared.read' },
    { id: 'template', op: 'core.storage.data-file-read' },
    { id: 'offer_get', op: 'core.seller.offer.get' },
    { id: 'offer_ensure', op: 'core.seller.offer.ensure' },
    { id: 'offer_attach', op: 'core.seller.offer.attach-fulfillment' },
    { id: 'task', op: 'core.work-entity.task.create' },
    { id: 'offer_link', op: 'core.seller.offer.link-task' },
    { id: 'cas', op: 'core.storage.shared.compare-and-set' },
    { id: 'task_update', op: 'core.work-entity.task.update' },
    { id: 'memory', op: 'core.memory.link.create' },
    { id: 'write', op: 'core.storage.shared.write' },
    { id: 'delete', op: 'core.storage.shared.delete' },
    { id: 'checkout_create', op: 'recued-core.stripe.checkout.session.create', connection: '{{config.stripe}}' },
    { id: 'checkout_read', op: 'recued-core.stripe.checkout.session.read', connection: '{{config.stripe}}' },
    { id: 'mail', op: 'core.mail.send' },
  ];

  it('REFUSES the paid-document-fulfillment shape — the recipe the legacy guard existed for', () => {
    // Fully configured, deliberately. The recipe pinned its connection as `{{config.stripe}}`,
    // so an UNconfigured harness would refuse it at `dynamic_connection` — a static-analysis
    // refusal that would mask the thing under test and evaporate the moment an owner
    // configured it properly. Give it everything it needs, so the ONLY reason left to refuse
    // it is the one that matters.
    const h = harness({
      config: { stripe: 'stripe-live', seller_offer_id: 'research-brief' },
      opRisk: { 'recued-core.stripe.checkout.session.create': 'write' },
    });
    const out = bind(h, { steps: PAID_DOCUMENT_FULFILLMENT_STEPS });

    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') throw new Error('unreachable');
    expect(out.refusal.reason).toBe('write_on_responding_door');
    expect(out.refusal).toMatchObject({ responds: 'sells' });
  });

  it('and refuses it for the CHECKOUT-CREATE even with every other write removed', () => {
    // Non-vacuity for the test above: it must not be passing merely because the recipe
    // happens to contain `core.mail.send`. The checkout-create ALONE — the op the guard
    // actually existed to keep off a public door — is enough.
    const h = harness({
      config: { stripe: 'stripe-live', seller_offer_id: 'research-brief' },
      opRisk: { 'recued-core.stripe.checkout.session.create': 'write' },
    });
    const out = bind(h, {
      steps: [
        { id: 'offer_get', op: 'core.seller.offer.get' },
        { id: 'checkout_create', op: 'recued-core.stripe.checkout.session.create', connection: '{{config.stripe}}' },
      ],
    });

    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') throw new Error('unreachable');
    expect(out.refusal).toMatchObject({
      reason: 'write_on_responding_door',
      op: 'recued-core.stripe.checkout.session.create',
      step_id: 'checkout_create',
      risk: 'write',
    });
  });
});

describe('D-207 slice 3c — a responding door is READ-ONLY', () => {
  it('a SELLING recipe that writes is refused', () => {
    const h = harness({ config: { seller_offer_id: 'off_1' } });
    const out = bind(h, {
      steps: [
        { id: 'read', op: 'core.seller.offer.get' },
        { id: 'save', op: 'core.work-entity.task.create' },
      ],
    });

    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') throw new Error('unreachable');
    expect(out.refusal).toMatchObject({
      reason: 'write_on_responding_door',
      step_id: 'save',
      op: 'core.work-entity.task.create',
      responds: 'sells',
    });
  });

  it('a RENDERING recipe that writes is refused — "save the lead AND show the quote"', () => {
    const h = harness();
    const out = bind(h, {
      output: RENDERS,
      steps: [
        { id: 'save', op: 'core.work-entity.task.create' },
      ],
    });

    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') throw new Error('unreachable');
    expect(out.refusal).toMatchObject({ reason: 'write_on_responding_door', responds: 'renders' });
  });

  it('a responding recipe that only READS is bound', () => {
    const h = harness({ config: { seller_offer_id: 'off_1' } });
    const out = bind(h, {
      output: RENDERS,
      steps: [{ id: 'read', op: 'core.seller.offer.get' }],
    });
    expect(out.kind).toBe('bound');
  });

  it('a resolved canonical CRM read remains bindable while its concrete account is pinned', () => {
    const h = {
      ...harness({ config: { crm: 'hubspot-live' } }),
      resolveDoorRecipe: () => ({
        ok: true as const,
        recipe: {
          output: RENDERS,
          steps: [{
            id: 'read',
            ingredient: 'hubspot-catalog',
            connection: '{{config.crm}}',
            input: { operation: 'deal.search', args: {} },
          }],
        } as unknown as RecipeDefinition,
      }),
      resolveOp: (slug: string, operation: string) =>
        slug === 'hubspot-catalog' && operation === 'deal.search'
          ? ['recued-core.hubspot.deal.search']
          : [],
      resolveOpRisk: (op: string) =>
        op === 'recued-core.hubspot.deal.search' ? 'read' : undefined,
      resolveIngredientKind: (slug: string) =>
        slug === 'hubspot-catalog' ? 'http' : undefined,
    };
    const out = bind(h, {
      output: RENDERS,
      steps: [{ id: 'read', op: 'core.crm.deal.search' }],
    });

    expect(out.kind).toBe('bound');
    if (out.kind === 'bound') {
      expect(out.capability.operation_ids).toEqual([
        'core.crm.deal.search',
        'recued-core.hubspot.deal.search',
      ]);
      expect(out.capability.connection_names).toEqual(['hubspot-live']);
    }
  });

  it('a resolved canonical CRM write is still refused from the authored grant axis', () => {
    const h = {
      ...harness({ config: { crm: 'hubspot-live' } }),
      resolveDoorRecipe: () => ({
        ok: true as const,
        recipe: {
          output: RENDERS,
          steps: [{
            id: 'create',
            ingredient: 'hubspot-catalog',
            connection: '{{config.crm}}',
            input: { operation: 'deal.create', args: {} },
          }],
        } as unknown as RecipeDefinition,
      }),
      resolveOp: (slug: string, operation: string) =>
        slug === 'hubspot-catalog' && operation === 'deal.create'
          ? ['recued-core.hubspot.deal.create']
          : [],
      resolveOpRisk: (op: string) =>
        op === 'recued-core.hubspot.deal.create' ? 'write' : undefined,
      resolveIngredientKind: (slug: string) =>
        slug === 'hubspot-catalog' ? 'http' : undefined,
    };
    const out = bind(h, {
      output: RENDERS,
      steps: [{ id: 'create', op: 'core.crm.deal.create' }],
    });

    expect(out).toMatchObject({
      kind: 'refused',
      refusal: {
        reason: 'write_on_responding_door',
        op: 'core.crm.deal.create',
        risk: 'write',
      },
    });
  });

  it('a responding recipe with NO ops at all is bound — the (C) shape', () => {
    // Under ruling (C) the runner injects the order and the recipe just renders it, so the
    // canonical selling recipe dispatches nothing whatsoever. An empty closure must not be
    // mistaken for a wildcard here (that fence is `door_types: ['reception']`, slice 1b).
    const h = harness({ config: { seller_offer_id: 'off_1' } });
    const out = bind(h, {
      output: { render: [{ type: 'link_button', source: '{{context.reception_order}}' }] },
      steps: [{ id: 'msg', transform: 'template' }],
    });
    expect(out.kind).toBe('bound');
  });
});

describe('D-207 slice 3c — a PLAIN intake door is untouched (slice 1 must keep working)', () => {
  it('lead capture still WRITES — it renders nothing and sells nothing, so a hold is honest', () => {
    // No offer, no render. The write holds, the owner approves it in the Inbox, and
    // "thank you, we got your submission" stays TRUE because nothing was owed in return.
    // A fence that refused this would have traded one lie for a worse narrowing.
    const h = harness();
    const out = bind(h, {
      steps: [
        { id: 'save', op: 'core.work-entity.task.create' },
        { id: 'notify', op: 'core.mail.send' },
      ],
    });
    expect(out.kind).toBe('bound');
  });
});

describe('D-207 slice 3c — fail-closed on an op it cannot classify', () => {
  it('an UNRESOLVABLE op on a responding door is refused, not waved through', () => {
    // No `resolveOpRisk`, and the op is not in the kernel registry — so its risk is
    // genuinely unknown. A fence that admits what it cannot classify is decoration: we
    // cannot prove this op will not hold.
    const h = harness({ config: { seller_offer_id: 'off_1' } });
    const out = bind(h, {
      steps: [{ id: 'x', op: 'some-publisher.somepack.mystery.op' }],
    });

    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') throw new Error('unreachable');
    expect(out.refusal).toMatchObject({
      reason: 'write_on_responding_door',
      op: 'some-publisher.somepack.mystery.op',
      risk: undefined,
    });
  });

  it('a pack op RESOLVED as read is admitted — the resolver is consulted, not ignored', () => {
    // Non-vacuity for the test above: the refusal there must come from the risk being
    // UNKNOWN, not from every pack op being refused on principle.
    const h = harness({
      config: { seller_offer_id: 'off_1' },
      opRisk: { 'some-publisher.somepack.mystery.op': 'read' },
    });
    const out = bind(h, {
      steps: [{ id: 'x', op: 'some-publisher.somepack.mystery.op' }],
    });
    expect(out.kind).toBe('bound');
  });

  it('destructive is refused too — the rule is "not read", never "is write"', () => {
    const h = harness({
      config: { seller_offer_id: 'off_1' },
      opRisk: { 'recued-core.stripe.payment.refund': 'destructive' },
    });
    const out = bind(h, {
      steps: [{ id: 'refund', op: 'recued-core.stripe.payment.refund' }],
    });

    expect(out.kind).toBe('refused');
    if (out.kind !== 'refused') throw new Error('unreachable');
    expect(out.refusal).toMatchObject({ risk: 'destructive' });
  });
});
