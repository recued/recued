import { describe, expect, it } from 'vitest';
import type { IntakeFormConfig } from '../intake-form-config.js';
import type { RecipeDefinition } from '../recipe.js';
import { PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS } from '../paid-document-direct-checkout-config.js';
import { PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION } from '../paid-document-direct-checkout-config.js';
import { paidDocumentDirectCheckoutSellerAssociation } from '../paid-document-direct-checkout.js';
import {
  RECEPTION_SCHEDULING_PAIR_REVISION_PREFIX,
  RECEPTION_SCHEDULING_PAIR_VERSION,
  isReceptionFormPairBinding,
  isReceptionPairBinding,
  isReceptionPairRevision,
  isReceptionSchedulingPairBinding,
  receptionPairBinding,
  receptionPairBindingEquals,
  receptionSchedulingPairBinding,
  type ReceptionPairBindingInput,
  type ReceptionSchedulingPairBindingInput,
} from '../reception-pair-binding.js';
import type { SchedulingLinkVisitorFieldRequirements } from '../redacted-packets.js';

const formConfig = (): IntakeFormConfig => ({
  display_name: 'Commission one research brief',
  form_definition: {
    form_definition_id: 'research-brief-v1',
    fields: [
      { name: 'product', type: 'text', label: 'Product', required: true },
      { name: 'amount_minor', type: 'number', label: 'Price', required: true },
      { name: 'currency', type: 'enum', label: 'Currency', required: true,
        values: ['usd', 'eur'] },
      { name: 'brief', type: 'textarea', label: 'Brief', required: true },
    ],
  },
  submission_processing_rule: {
    // D-210 A.8 slice 2b step 3 — a D-200 pair mints no destination entity: the
    // response row IS the paid deliverable. That used to be spelled as an
    // ABSENT target_kind; absent is no longer a value, so it is spelled
    // explicitly now. `reception-pair-binding` requires exactly this.
    target_kind: 'form_response',
    fields_to_include_in_target: [],
    fields_to_attach_as_metadata: [],
  },
  anti_spam: {
    honeypot_fields: [],
    rate_limit_per_ip: 5,
    require_proof_of_work: false,
    require_captcha: false,
  },
  required_visitor_fields: { email: 'required' },
});

const recipe = (): RecipeDefinition => ({
  recipe_id: 'research-brief-checkout',
  version: 3,
  ttl: 300,
  metadata: {
    name: 'Research brief checkout',
    description: 'Validates one research-brief intake into one checkout item.',
    author: 'local-author',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
});

describe('reception pair binding (D-207 3d·6d split of the D-200 pair contracts)', () => {
  it('content-addresses the exact valid form/recipe pair without Seller identity', () => {
    const binding = receptionPairBinding({
      form_config: formConfig(),
      recipe: recipe(),
      seller_offer_id: null,
    });

    // ⛔ The digest is pinned so a REFACTOR cannot move a persisted
    // `pair_revision` byte — every stored pair on a live server would
    // re-derive as `stale`.
    //
    // ⚠ IT HAS MOVED TWICE, BOTH TIMES DELIBERATELY, and a deliberate change to
    // the form-config vocabulary is the only reason it may ever move. The digest
    // is `sha256(canonicalJSON({version, form_config, recipe}))` — the WHOLE
    // form config — so any field entering or leaving that shape moves it. The
    // hashing is byte-for-byte unchanged each time; its INPUT changed.
    //
    //   1. D-210 WS2 dropped `form_response` from the `target_kind` vocabulary.
    //   2. D-210 Phase C retired `auto_accept`, `triggered_recipe_id` and
    //      `notification_target` (owner rulings, 2026-07-18), so this fixture's
    //      config lost three more fields.
    //
    //   3. D-210 A.8 slice 2b step 3 made `target_kind` REQUIRED and retired the
    //      absent spelling, so this fixture GAINED `target_kind: 'form_response'`.
    //
    // ⚠ NOTE THE REVERSAL IN (3). The paragraph below used to say a config
    // "still carrying `target_kind: 'form_response'`" was unreachable — true
    // under WS2, which had dropped the value. It is now the exact opposite: a
    // config LACKING it fails `validateIntakeFormConfig` (`target_kind_missing`)
    // and is refused by the pair binding, which requires that value specifically
    // (a D-200 pair mints no entity — the response row IS the paid deliverable).
    //
    // Each superseded value is not merely different, it is UNREACHABLE: a config
    // carrying the wrong shape for its era fails validation outright, so it
    // derives no binding at all. Any D-200 pair stored before this step
    // therefore re-derives `stale` — accepted under the pre-launch
    // no-migration rule, but it is a real consequence, not a test-fixture
    // detail.
    expect(binding).toEqual({
      version: 1,
      form_definition_id: 'research-brief-v1',
      recipe_id: 'research-brief-checkout',
      recipe_version: 3,
      pair_revision:
        'd200-pair-v1-914dd46df8a7545b2628919ed065b57a1febc458399092c23024dd916f89a4bc',
    });
    expect(isReceptionPairBinding(binding)).toBe(true);
    expect(isReceptionPairRevision(binding?.pair_revision)).toBe(true);
    expect(binding).not.toHaveProperty('pack');
    expect(binding).not.toHaveProperty('publisher');
    expect(binding).not.toHaveProperty('seller_offer_id');
  });

  it('is object-key-order stable and changes with either exact snapshot', () => {
    const config = formConfig();
    const reorderedConfig: IntakeFormConfig = {
      required_visitor_fields: config.required_visitor_fields,
      anti_spam: config.anti_spam,
      submission_processing_rule: config.submission_processing_rule,
      form_definition: {
        fields: config.form_definition.fields,
        form_definition_id: config.form_definition.form_definition_id,
      },
      display_name: config.display_name,
    };
    const first = receptionPairBinding({
      form_config: config,
      recipe: recipe(),
      seller_offer_id: null,
    })!;
    const reordered = receptionPairBinding({
      form_config: reorderedConfig,
      recipe: { ...recipe(), metadata: { ...recipe().metadata } },
      seller_offer_id: null,
    })!;
    const changedForm = receptionPairBinding({
      form_config: {
        ...config,
        form_definition: {
          ...config.form_definition,
          fields: config.form_definition.fields.map((field) =>
            field.name === 'brief' ? { ...field, label: 'Project brief' } : field),
        },
      },
      recipe: recipe(),
      seller_offer_id: null,
    })!;
    const changedRecipe = receptionPairBinding({
      form_config: config,
      recipe: { ...recipe(), ttl: 301 },
      seller_offer_id: null,
    })!;

    expect(reordered.pair_revision).toBe(first.pair_revision);
    expect(changedForm.pair_revision).not.toBe(first.pair_revision);
    expect(changedRecipe.pair_revision).not.toBe(first.pair_revision);
  });

  it('pins owner-local deployment configuration inside the exact recipe pair revision', () => {
    const configuredRecipe = recipe();
    configuredRecipe.metadata.paid_document_direct_checkout = {
      version: 1,
      stripe_connection_name: 'stripe-primary',
      success_url: 'https://owner.example/checkout/success',
      cancel_url: 'https://owner.example/checkout/cancel',
      expiry_window_ms: PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS,
      template_file_ref: `file:${'a'.repeat(32)}`,
    };
    const first = receptionPairBinding({
      form_config: formConfig(),
      recipe: configuredRecipe,
      seller_offer_id: null,
    })!;
    const changedRecipe = structuredClone(configuredRecipe);
    changedRecipe.metadata.paid_document_direct_checkout = {
      ...changedRecipe.metadata.paid_document_direct_checkout!,
      success_url: 'https://owner.example/checkout/changed-success',
    };
    const changed = receptionPairBinding({
      form_config: formConfig(),
      recipe: changedRecipe,
      seller_offer_id: null,
    })!;

    expect(changed.pair_revision).not.toBe(first.pair_revision);
    expect(first).not.toHaveProperty('checkout_configuration');
    expect(first).not.toHaveProperty('seller_offer_id');
  });

  it('derives one v2 Seller association from the resolved offer id', () => {
    const configuredRecipe = recipe();
    configuredRecipe.metadata.paid_document_direct_checkout = {
      version: PAID_DOCUMENT_DIRECT_CHECKOUT_SELLER_ASSOCIATION_CONFIGURATION_VERSION,
      stripe_connection_name: 'stripe-primary',
      success_url: 'https://owner.example/checkout/success',
      cancel_url: 'https://owner.example/checkout/cancel',
      expiry_window_ms: PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS,
      template_file_ref: `file:${'a'.repeat(32)}`,
      seller_offer_id: 'research-brief.fulfilled',
    };
    // The association resolver is the payment module's; the builder only
    // receives the resolved id — the split's seam, exercised end-to-end here.
    const association = paidDocumentDirectCheckoutSellerAssociation(configuredRecipe);
    expect(association).toBe('research-brief.fulfilled');
    const binding = receptionPairBinding({
      form_config: formConfig(),
      recipe: configuredRecipe,
      seller_offer_id: association,
    });

    expect(binding).toMatchObject({
      version: 2,
      form_definition_id: 'research-brief-v1',
      recipe_id: 'research-brief-checkout',
      recipe_version: 3,
      seller_offer_id: 'research-brief.fulfilled',
    });
    expect(binding?.pair_revision).toMatch(/^d200-pair-v2-[a-f0-9]{64}$/);
    expect(isReceptionPairBinding(binding)).toBe(true);
    expect(isReceptionPairRevision(binding?.pair_revision)).toBe(true);
    expect(binding).not.toHaveProperty('seller_offer');
    expect(binding).not.toHaveProperty('pack_slug');
    expect(binding).not.toHaveProperty('publisher');
    if (binding === null) throw new Error('expected v2 binding');

    const changedRecipe = structuredClone(configuredRecipe);
    const changedConfiguration = changedRecipe.metadata.paid_document_direct_checkout;
    if (changedConfiguration?.version !== 2) throw new Error('expected v2 configuration');
    changedRecipe.metadata.paid_document_direct_checkout = {
      ...changedConfiguration,
      seller_offer_id: 'research-brief.replacement',
    };
    const changed = receptionPairBinding({
      form_config: formConfig(),
      recipe: changedRecipe,
      seller_offer_id: paidDocumentDirectCheckoutSellerAssociation(changedRecipe),
    });
    expect(changed?.pair_revision).not.toBe(binding.pair_revision);
    expect(receptionPairBindingEquals(binding, changed!)).toBe(false);
  });

  it('resolves no association from a v1 or absent deployment block', () => {
    expect(paidDocumentDirectCheckoutSellerAssociation(recipe())).toBeNull();
    const v1Recipe = recipe();
    v1Recipe.metadata.paid_document_direct_checkout = {
      version: 1,
      stripe_connection_name: 'stripe-primary',
      success_url: 'https://owner.example/checkout/success',
      cancel_url: 'https://owner.example/checkout/cancel',
      expiry_window_ms: PAID_DOCUMENT_CHECKOUT_MAX_EXPIRY_WINDOW_MS,
      template_file_ref: `file:${'a'.repeat(32)}`,
    };
    expect(paidDocumentDirectCheckoutSellerAssociation(v1Recipe)).toBeNull();
  });

  it('requires later form-response promotion, a required email, and JSON-clean snapshots', () => {
    const config = formConfig();
    expect(receptionPairBinding({
      form_config: {
        ...config,
        submission_processing_rule: {
          ...config.submission_processing_rule,
          target_kind: 'task',
        },
      },
      recipe: recipe(),
      seller_offer_id: null,
    })).toBeNull();
    expect(receptionPairBinding({
      form_config: {
        ...config,
        required_visitor_fields: { email: 'optional' },
      },
      recipe: recipe(),
      seller_offer_id: null,
    })).toBeNull();
    expect(receptionPairBinding({
      form_config: config,
      recipe: {
        ...recipe(),
        variables: { invalid: undefined },
      } as unknown as RecipeDefinition,
      seller_offer_id: null,
    })).toBeNull();
    expect(receptionPairBinding({
      form_config: config,
      recipe: { ...recipe(), recipe_id: 'Invalid Recipe' },
      seller_offer_id: null,
    })).toBeNull();
  });

  it('fails closed on malformed builder inputs and ambiguous snapshot bytes', () => {
    const cyclicRecipe = recipe() as unknown as Record<string, unknown>;
    cyclicRecipe.cycle = cyclicRecipe;
    const sparseRecipe = recipe();
    sparseRecipe.steps = new Array(1) as RecipeDefinition['steps'];
    const symbolRecipe = recipe();
    (symbolRecipe as unknown as Record<symbol, unknown>)[Symbol('hidden')] = true;

    for (const invalid of [
      null,
      {},
      { form_config: formConfig() },
      // The association axis is REQUIRED input — a caller that has not
      // decided it does not get a binding.
      { form_config: formConfig(), recipe: recipe() },
      {
        form_config: formConfig(),
        recipe: recipe(),
        seller_offer_id: null,
        extra_key: true,
      },
      {
        form_config: formConfig(),
        recipe: recipe(),
        seller_offer_id: '   not a seller offer id   ',
      },
      { form_config: formConfig(), recipe: cyclicRecipe, seller_offer_id: null },
      { form_config: formConfig(), recipe: sparseRecipe, seller_offer_id: null },
      { form_config: formConfig(), recipe: symbolRecipe, seller_offer_id: null },
      {
        form_config: formConfig(),
        recipe: { ...recipe(), ttl: Infinity },
        seller_offer_id: null,
      },
    ]) {
      const call = () => receptionPairBinding(
        invalid as unknown as ReceptionPairBindingInput,
      );
      expect(call).not.toThrow();
      expect(call()).toBeNull();
    }
  });

  it('compares the association byte, not merely the revision shape', () => {
    const plain = receptionPairBinding({
      form_config: formConfig(),
      recipe: recipe(),
      seller_offer_id: null,
    })!;
    expect(receptionPairBindingEquals(plain, { ...plain })).toBe(true);
    expect(receptionPairBindingEquals(
      plain,
      { ...plain, recipe_version: plain.recipe_version + 1 },
    )).toBe(false);
    expect(isReceptionPairBinding({ ...plain, version: 2 })).toBe(false);
  });

  it('keeps every exported runtime guard fail-closed on hostile property access', () => {
    const pairInput = new Proxy({
      form_config: formConfig(),
      recipe: recipe(),
      seller_offer_id: null,
    }, {
      get: () => {
        throw new Error('hostile pair read');
      },
    });
    const binding = receptionPairBinding({
      form_config: formConfig(),
      recipe: recipe(),
      seller_offer_id: null,
    })!;
    const hostileBinding = new Proxy(binding, {
      get: () => {
        throw new Error('hostile binding read');
      },
    });

    expect(() => receptionPairBinding(pairInput)).not.toThrow();
    expect(receptionPairBinding(pairInput)).toBeNull();
    expect(() => isReceptionPairBinding(hostileBinding)).not.toThrow();
    expect(isReceptionPairBinding(hostileBinding)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────
// D-210 R-2 — the scheduling pair (v3)
// ────────────────────────────────────────────────────────────────

const visitorFields = (): SchedulingLinkVisitorFieldRequirements => ({
  name: 'required',
  email: 'required',
  topic: 'optional',
  phone: 'optional',
  notes: 'optional',
});

const schedulingRecipe = (): RecipeDefinition => ({
  recipe_id: 'booking-router',
  version: 2,
  ttl: 300,
  metadata: {
    name: 'Booking router',
    description: 'Routes one approved booking to the owner-chosen destination.',
    author: 'local-author',
    supported_platforms: [],
  },
  variables: {},
  prefetch_steps: [],
  steps: [],
  output: { render: [] },
});

describe('reception scheduling pair binding (D-210 R-2)', () => {
  it('content-addresses the visitor-field map and the exact recipe, carrying no form id', () => {
    const binding = receptionSchedulingPairBinding({
      required_visitor_fields: visitorFields(),
      recipe: schedulingRecipe(),
    });

    expect(binding).not.toBeNull();
    expect(binding!.version).toBe(RECEPTION_SCHEDULING_PAIR_VERSION);
    expect(binding!.recipe_id).toBe('booking-router');
    expect(binding!.recipe_version).toBe(2);
    expect(binding!.pair_revision.startsWith(
      RECEPTION_SCHEDULING_PAIR_REVISION_PREFIX,
    )).toBe(true);
    // The whole point of the variant: no form id to invent.
    expect('form_definition_id' in binding!).toBe(false);
    expect(isReceptionSchedulingPairBinding(binding)).toBe(true);
    expect(isReceptionPairBinding(binding)).toBe(true);
    // ⛔ A scheduling binding must NEVER satisfy the form guard — that guard is
    // what keeps v3 out of the form submission / nonce / admission paths.
    expect(isReceptionFormPairBinding(binding)).toBe(false);
  });

  it('is key-order stable and re-derives the same revision from equal snapshots', () => {
    const a = receptionSchedulingPairBinding({
      required_visitor_fields: visitorFields(),
      recipe: schedulingRecipe(),
    })!;
    const reordered: SchedulingLinkVisitorFieldRequirements = {
      notes: 'optional',
      phone: 'optional',
      topic: 'optional',
      email: 'required',
      name: 'required',
    };
    const b = receptionSchedulingPairBinding({
      required_visitor_fields: reordered,
      recipe: schedulingRecipe(),
    })!;
    expect(b.pair_revision).toBe(a.pair_revision);
    expect(receptionPairBindingEquals(a, b)).toBe(true);
  });

  it('changes the revision when a visitor field or the recipe drifts', () => {
    const base = receptionSchedulingPairBinding({
      required_visitor_fields: visitorFields(),
      recipe: schedulingRecipe(),
    })!;

    // The drift the digest EXISTS to catch: a recipe reading the phone silently
    // gets null once the field is omitted.
    const phoneOmitted = receptionSchedulingPairBinding({
      required_visitor_fields: { ...visitorFields(), phone: 'omit' },
      recipe: schedulingRecipe(),
    })!;
    expect(phoneOmitted.pair_revision).not.toBe(base.pair_revision);
    expect(receptionPairBindingEquals(base, phoneOmitted)).toBe(false);

    const recipeEdited = receptionSchedulingPairBinding({
      required_visitor_fields: visitorFields(),
      recipe: { ...schedulingRecipe(), ttl: 600 },
    })!;
    expect(recipeEdited.pair_revision).not.toBe(base.pair_revision);

    const versionBumped = receptionSchedulingPairBinding({
      required_visitor_fields: visitorFields(),
      recipe: { ...schedulingRecipe(), version: 3 },
    })!;
    expect(versionBumped.pair_revision).not.toBe(base.pair_revision);
  });

  it('refuses a visitor-field map the endpoint validator would itself refuse', () => {
    const refuses = (
      required_visitor_fields: unknown,
    ): void => expect(receptionSchedulingPairBinding({
      required_visitor_fields: required_visitor_fields as SchedulingLinkVisitorFieldRequirements,
      recipe: schedulingRecipe(),
    })).toBeNull();

    // Per-field allowed sets — `name` is always required, `phone` may not be.
    refuses({ ...visitorFields(), name: 'optional' });
    refuses({ ...visitorFields(), phone: 'required' });
    refuses({ ...visitorFields(), email: 'omit' });
    // Closed shape — a missing field and an unknown one are both refusals.
    refuses({ name: 'required', email: 'required', topic: 'optional', phone: 'optional' });
    refuses({ ...visitorFields(), nickname: 'optional' });
    refuses({ ...visitorFields(), topic: 'sometimes' });
    refuses(null);
    refuses([]);
  });

  it('refuses a recipe snapshot that is not JSON-clean or not identifiable', () => {
    const refuses = (recipeValue: unknown): void => expect(
      receptionSchedulingPairBinding({
        required_visitor_fields: visitorFields(),
        recipe: recipeValue as RecipeDefinition,
      }),
    ).toBeNull();

    refuses({ ...schedulingRecipe(), recipe_id: 'Booking_Router' });
    refuses({ ...schedulingRecipe(), version: 0 });
    refuses({ ...schedulingRecipe(), version: 1.5 });
    refuses({ ...schedulingRecipe(), ttl: Number.POSITIVE_INFINITY });
    refuses({ ...schedulingRecipe(), ttl: undefined });
    refuses(null);

    const cyclic: Record<string, unknown> = { ...schedulingRecipe() };
    cyclic.self = cyclic;
    refuses(cyclic);
  });

  it('rejects an unknown input key rather than ignoring it', () => {
    expect(receptionSchedulingPairBinding({
      required_visitor_fields: visitorFields(),
      recipe: schedulingRecipe(),
      seller_offer_id: null,
    } as unknown as ReceptionSchedulingPairBindingInput)).toBeNull();
  });

  it('holds the three variants apart at every guard and comparison', () => {
    const scheduling = receptionSchedulingPairBinding({
      required_visitor_fields: visitorFields(),
      recipe: schedulingRecipe(),
    })!;
    const form = receptionPairBinding({
      form_config: formConfig(),
      recipe: recipe(),
      seller_offer_id: null,
    })!;

    expect(isReceptionSchedulingPairBinding(form)).toBe(false);
    expect(isReceptionFormPairBinding(scheduling)).toBe(false);
    expect(isReceptionPairRevision(scheduling.pair_revision)).toBe(true);

    // A v3 carrying a form id is evidence of a minter that thinks scheduling has
    // a form — refuse it, never tolerate it as a near-miss.
    expect(isReceptionSchedulingPairBinding({
      ...scheduling,
      form_definition_id: 'research-brief-v1',
    })).toBe(false);
    // A v1 revision string relabelled v3 (and vice versa) is not a v3.
    expect(isReceptionSchedulingPairBinding({
      ...scheduling,
      pair_revision: form.pair_revision,
    })).toBe(false);
    expect(isReceptionSchedulingPairBinding({ ...scheduling, version: 1 })).toBe(false);

    // Cross-variant comparison must be false even when the shared fields agree.
    const formLike = {
      ...form,
      recipe_id: scheduling.recipe_id,
      recipe_version: scheduling.recipe_version,
      pair_revision: scheduling.pair_revision,
    };
    expect(receptionPairBindingEquals(scheduling, formLike)).toBe(false);
    expect(receptionPairBindingEquals(formLike, scheduling)).toBe(false);
  });

  it('keeps the scheduling guard + deriver fail-closed on hostile property access', () => {
    const hostileInput = new Proxy({
      required_visitor_fields: visitorFields(),
      recipe: schedulingRecipe(),
    }, {
      get: () => {
        throw new Error('hostile scheduling pair read');
      },
    });
    const binding = receptionSchedulingPairBinding({
      required_visitor_fields: visitorFields(),
      recipe: schedulingRecipe(),
    })!;
    const hostileBinding = new Proxy(binding, {
      get: () => {
        throw new Error('hostile scheduling binding read');
      },
    });

    expect(() => receptionSchedulingPairBinding(hostileInput)).not.toThrow();
    expect(receptionSchedulingPairBinding(hostileInput)).toBeNull();
    expect(() => isReceptionSchedulingPairBinding(hostileBinding)).not.toThrow();
    expect(isReceptionSchedulingPairBinding(hostileBinding)).toBe(false);
  });
});
