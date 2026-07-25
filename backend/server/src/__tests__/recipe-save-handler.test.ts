import { describe, expect, it, vi } from 'vitest';
import type { RecipeDefinition, WebhookConsumerBindingRecord } from '@recued/contracts';
import { RpcError } from '@recued/contracts';

import {
  makeRecipeSaveHandlers,
  handleLocalRecipeWebhookArm,
  handleLocalRecipeWebhookDisarm,
  saveRecipeInline,
  validateRecipeInline,
} from '../recipe-save-handler.js';
import { checkInlineOpSteps } from '../op-step-save-check.js';
import type { RecipeStore } from '../recipe-store.js';
import type {
  ReplaceWebhookConsumerInput,
  WebhookConsumerStore,
} from '../storage/webhook-consumer-store.js';

type Step = Record<string, unknown>;

const recipeWith = (
  recipe_id: string,
  steps: Step[],
  extra: Record<string, unknown> = {},
): RecipeDefinition => ({
  recipe_id,
  version: 1,
  ttl: 300,
  metadata: {
    name: `Name of ${recipe_id}`,
    description: 'Fixture for recipe.save handler tests.',
    author: 'recued-core',
    supported_platforms: ['test'],
    tags: ['test', 'fixture', 'transform'],
  },
  variables: {
    greeting: { type: 'string', default: '', label: 'Greeting' },
  },
  prefetch_steps: [],
  steps,
  output: { sidebar: [{ type: 'summary', source: 'step.has_greeting' }] },
  ...extra,
} as unknown as RecipeDefinition);

/** A valid, transform-only recipe (no error- OR info-severity issues — the
 *  step output is referenced in `output` + 3 tags). */
const validRecipe = (recipe_id: string): RecipeDefinition =>
  recipeWith(recipe_id, [
    {
      id: 'has_greeting',
      transform: 'compare',
      left: '{{config.greeting}}',
      operator: 'is_not_empty',
    },
  ]);

/** An invalid recipe — a step missing the required `id`. parseRecipe
 *  surfaces an error-severity issue, so this never persists. */
const invalidRecipe = (recipe_id: string): RecipeDefinition =>
  recipeWith(recipe_id, [
    { transform: 'compare', left: '{{config.greeting}}', operator: 'is_not_empty' } as Step,
  ]);

/** D-182 — a kernel-op recipe. `core.ai.classify` is a REGISTERED closed-kind
 *  kernel op: connection-less + self-contained, so it lowers + runs inline. Now
 *  ACCEPTED at save (the dispatch path resolves it standalone). */
const kernelOpRecipe = (recipe_id: string): RecipeDefinition =>
  recipeWith(recipe_id, [{ id: 'has_greeting', op: 'core.ai.classify', args: {} }]);

/** D-182 — an UNREGISTERED closed-kind kernel op (`core.ai.*` with a bogus op
 *  id). No handler backs it, so it can never lower at dispatch → still rejected
 *  at save (the precise survivor of the old blanket op-step reject). */
const unregisteredKernelOpRecipe = (recipe_id: string): RecipeDefinition =>
  recipeWith(recipe_id, [{ id: 'has_greeting', op: 'core.ai.bogus_op', args: {} }]);

/** D-182 — a bare canonical CRM op-step (the exact case the old gate named).
 *  It VALIDATES (declares its capability dependency + a `type:'connection'`
 *  variable for its slot) and now PERSISTS — the dispatch path binds the slot's
 *  connection at run. */
const canonicalOpRecipe = (recipe_id: string): RecipeDefinition =>
  recipeWith(
    recipe_id,
    [{ id: 'has_greeting', op: 'deal.search', args: {} }],
    {
      dependencies: [{ capability: 'deal', ops: ['search'] }],
      variables: { crm: { label: 'CRM', type: 'connection', connection_kind: 'api', default: '' } },
    },
  );

/** D-182 — the SAME bare canonical op but with NO `type:'connection'` variable.
 *  `opStepConnectionSlots` rejects it at dispatch ("declares no type:'connection'
 *  variable"), so the save boundary now blocks it up front. */
const slotlessCanonicalRecipe = (recipe_id: string): RecipeDefinition =>
  recipeWith(
    recipe_id,
    [{ id: 'has_greeting', op: 'deal.search', args: {} }],
    { dependencies: [{ capability: 'deal', ops: ['search'] }], variables: {} },
  );

/** D-182 — a Tier-P pack op the recipe does NOT cover in `depends_on`. Persists
 *  with a non-blocking `op_warnings` advisory (the pack resolves at dispatch iff
 *  installed; `depends_on` is authoring-time hygiene, not a runtime gate). */
const tierPUncoveredRecipe = (recipe_id: string): RecipeDefinition =>
  recipeWith(recipe_id, [{ id: 'has_greeting', op: 'acme.widgets.gadget.read', args: {} }]);

/** D-182 — the same Tier-P op, but `depends_on` declares its pack → no warning. */
const tierPCoveredRecipe = (recipe_id: string): RecipeDefinition =>
  recipeWith(
    recipe_id,
    [{ id: 'has_greeting', op: 'acme.widgets.gadget.read', args: {} }],
    { depends_on: ['acme.widgets'] },
  );

/** Minimal in-memory RecipeStore — only the surface `recipe.save` /
 *  `recipe.validate` touch (`save` + `get`). */
const inMemoryStore = (): {
  store: RecipeStore;
  saveCalls: Array<{ recipe_id: string; publisher_id: string; source: string }>;
} => {
  const rows = new Map<string, RecipeDefinition>();
  const publishers = new Map<string, string>();
  const saveCalls: Array<{ recipe_id: string; publisher_id: string; source: string }> = [];
  const store = {
    get: (recipe_id: string) => rows.get(recipe_id) ?? null,
    getStored: (recipe_id: string) => rows.has(recipe_id)
      ? { recipe_id, publisher_id: publishers.get(recipe_id) ?? 'kitchen', pack_slug: null }
      : null,
    save: (recipe: RecipeDefinition, publisher_id: string, source: string) => {
      rows.set(recipe.recipe_id, recipe);
      publishers.set(recipe.recipe_id, publisher_id);
      saveCalls.push({ recipe_id: recipe.recipe_id, publisher_id, source });
    },
  } as unknown as RecipeStore;
  return { store, saveCalls };
};

const webhookRecipe = (recipe_id: string): RecipeDefinition => {
  const recipe = validRecipe(recipe_id);
  recipe.webhook_requirements = [{
    binding: 'generic_delivery',
    profile_ids: ['generic.static-header-token.v1'],
    required_event_types: ['delivery'],
    registration_modes: ['manual'],
    environment_policy: 'any',
    decoded_payload_access: 'metadata_only',
    source_truth_policy: 'delivery_payload_allowed',
  }];
  recipe.webhook_triggers = [{ binding: 'generic_delivery', event_types: ['delivery'] }];
  return recipe;
};

const webhookConsumer = (): {
  store: WebhookConsumerStore;
  replace: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
} => {
  let rows: WebhookConsumerBindingRecord[] = [];
  const replace = vi.fn((input: ReplaceWebhookConsumerInput) => {
    rows = input.selections.map((selection, index) => ({
      binding_id: `whb_${index}`,
      consumer_kind: input.consumer_kind,
      consumer_id: input.consumer_id,
      logical_binding: selection.binding,
      ingress_id: selection.ingress_id,
      required_profile_id: input.requirements[index]!.profile_ids[0]!,
      decoded_payload_access: input.requirements[index]!.decoded_payload_access,
      source_truth_policy: input.requirements[index]!.source_truth_policy,
      enabled: input.enabled ?? true,
      created_at: 1,
      updated_at: 1,
    }));
    return {
      consumer_kind: input.consumer_kind,
      consumer_id: input.consumer_id,
      bindings: [],
      triggers: [],
    };
  });
  const finalize = vi.fn();
  const restore = vi.fn();
  const setEnabled = vi.fn((_kind: string, _id: string, enabled: boolean) => {
    rows = rows.map((row) => ({ ...row, enabled }));
  });
  const store = {
    replaceConsumer: replace,
    finalizeConsumerReplacement: finalize,
    removeConsumer: vi.fn((consumer_kind: string, consumer_id: string) => {
      rows = [];
      return { consumer_kind, consumer_id, bindings: [], triggers: [] };
    }),
    restoreConsumer: restore,
    setConsumerEnabled: setEnabled,
    isConsumerEnabled: () => rows.length > 0 && rows.every((row) => row.enabled),
    listBindings: () => rows,
  } as unknown as WebhookConsumerStore;
  return { store, replace, finalize, restore, setEnabled };
};

describe('validateRecipeInline', () => {
  it('returns { ok: true, issues: [] } for a valid recipe (no throw)', () => {
    const result = validateRecipeInline(validRecipe('valid-recipe'));
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('returns { ok: false, issues: [error…] } for an invalid recipe (no throw)', () => {
    const result = validateRecipeInline(invalidRecipe('invalid-recipe'));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.severity === 'error')).toBe(true);
    // Every issue carries the wire shape.
    for (const issue of result.issues) {
      expect(typeof issue.message).toBe('string');
      expect(typeof issue.severity).toBe('string');
    }
  });

  it('D-182 — { ok: true } for a registered kernel-op recipe', () => {
    const result = validateRecipeInline(kernelOpRecipe('kernel-validate'));
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.severity === 'error')).toBe(false);
  });

  it('D-182 — { ok: false } with an error issue for an unregistered kernel op', () => {
    const result = validateRecipeInline(unregisteredKernelOpRecipe('bogus-validate'));
    expect(result.ok).toBe(false);
    expect(
      result.issues.some(
        (i) => i.severity === 'error' && i.message.includes('registered kernel operation'),
      ),
    ).toBe(true);
  });

  it('D-182 — { ok: true } with a warn issue for an uncovered Tier-P op', () => {
    const result = validateRecipeInline(tierPUncoveredRecipe('tierp-validate'));
    expect(result.ok).toBe(true); // warnings are non-blocking
    expect(
      result.issues.some(
        (i) => i.severity === 'warn' && i.message.includes('acme.widgets'),
      ),
    ).toBe(true);
  });
});

describe('saveRecipeInline', () => {
  it('persists a valid recipe and returns the save envelope', () => {
    const { store, saveCalls } = inMemoryStore();
    const recipe = validRecipe('persist-me');

    const result = saveRecipeInline({ store }, recipe);

    expect(result).toMatchObject({
      saved: true,
      recipe_id: 'persist-me',
      version: 1,
      name: 'Name of persist-me',
    });
    // The store round-trips the saved recipe.
    expect(store.get('persist-me')).toBe(recipe);
    // Persisted with the default publisher + `inline` source.
    expect(saveCalls).toEqual([
      { recipe_id: 'persist-me', publisher_id: 'kitchen', source: 'inline' },
    ]);
  });

  it('honors an explicit publisher_id', () => {
    const { store, saveCalls } = inMemoryStore();
    saveRecipeInline({ store }, validRecipe('with-publisher'), 'recued-core');
    expect(saveCalls[0]).toMatchObject({ publisher_id: 'recued-core', source: 'inline' });
  });

  it('throws RpcError (bad_request / 400) for an invalid recipe and never persists', () => {
    const { store, saveCalls } = inMemoryStore();
    let thrown: unknown;
    try {
      saveRecipeInline({ store }, invalidRecipe('bad-recipe'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RpcError);
    expect((thrown as RpcError).code).toBe('bad_request');
    expect((thrown as RpcError).status).toBe(400);
    expect(saveCalls).toEqual([]);
    expect(store.get('bad-recipe')).toBeNull();
  });

  it('D-201 validates but does not persist a standalone webhook recipe without an owner ingress selection', () => {
    const { store, saveCalls } = inMemoryStore();
    const recipe = webhookRecipe('webhook-local');

    expect(validateRecipeInline(recipe).ok).toBe(true);
    expect(() => saveRecipeInline({ store }, recipe)).toThrow(/owner-selected ingress binding/);
    expect(saveCalls).toEqual([]);
    expect(store.get('webhook-local')).toBeNull();
  });

  it('D-201 leaves an ordinary recipe outside the webhook authority transaction', () => {
    const recipeStore = inMemoryStore();
    const consumer = webhookConsumer();

    expect(saveRecipeInline({
      store: recipeStore.store,
      webhookConsumerStore: consumer.store,
    }, validRecipe('ordinary-local'))).toMatchObject({ saved: true });
    expect(consumer.replace).not.toHaveBeenCalled();
    expect(consumer.finalize).not.toHaveBeenCalled();
  });

  it('D-201 saves exact local bindings disarmed, then arms and disarms explicitly', () => {
    const recipeStore = inMemoryStore();
    const consumer = webhookConsumer();
    const deps = { store: recipeStore.store, webhookConsumerStore: consumer.store };
    const recipe = webhookRecipe('webhook-local-bound');

    const saved = saveRecipeInline(deps, recipe, undefined, [{
      binding: 'generic_delivery',
      ingress_id: 'whi_owner_selected',
    }]);
    expect(saved.webhook).toEqual({
      declared: true,
      configured: true,
      armed: false,
      bindings: [{ binding: 'generic_delivery', ingress_id: 'whi_owner_selected' }],
    });
    expect(consumer.replace).toHaveBeenCalledWith(expect.objectContaining({
      consumer_kind: 'local_recipe',
      consumer_id: recipe.recipe_id,
      enabled: false,
    }));
    expect(consumer.finalize).toHaveBeenCalledTimes(1);

    expect(handleLocalRecipeWebhookArm(deps, {
      recipe_id: recipe.recipe_id,
    }).webhook.armed).toBe(true);
    expect(consumer.setEnabled).toHaveBeenLastCalledWith(
      'local_recipe',
      recipe.recipe_id,
      true,
    );
    expect(handleLocalRecipeWebhookDisarm(deps, {
      recipe_id: recipe.recipe_id,
    }).webhook.armed).toBe(false);
  });

  it('D-201 refuses to arm a requirement-only local binding with no trigger', () => {
    const recipeStore = inMemoryStore();
    const consumer = webhookConsumer();
    const deps = { store: recipeStore.store, webhookConsumerStore: consumer.store };
    const recipe = webhookRecipe('webhook-local-requirement-only');
    recipe.webhook_triggers = [];
    saveRecipeInline(deps, recipe, undefined, [{
      binding: 'generic_delivery',
      ingress_id: 'whi_owner_selected',
    }]);

    expect(() => handleLocalRecipeWebhookArm(deps, {
      recipe_id: recipe.recipe_id,
    })).toThrow(/no webhook trigger declarations/);
    expect(consumer.setEnabled).not.toHaveBeenCalled();
  });

  it('D-201 requires a new id before Kitchen shadows a pack-owned webhook recipe', () => {
    const recipeStore = inMemoryStore();
    const consumer = webhookConsumer();
    const existing = webhookRecipe('pack-owned-webhook');
    recipeStore.store.save(existing, 'pack-publisher', 'pair-sync');
    vi.spyOn(recipeStore.store, 'getStored').mockReturnValue({
      recipe_id: existing.recipe_id,
      pack_slug: 'webhook-pack',
    } as never);

    expect(() => saveRecipeInline(
      { store: recipeStore.store, webhookConsumerStore: consumer.store },
      existing,
      undefined,
      [{ binding: 'generic_delivery', ingress_id: 'whi_owner_selected' }],
    )).toThrow(/change recipe_id to fork/);
    expect(consumer.replace).not.toHaveBeenCalled();
  });

  it('D-201 restores prior webhook authority when recipe persistence fails', () => {
    const recipeStore = inMemoryStore();
    const consumer = webhookConsumer();
    vi.spyOn(recipeStore.store, 'save').mockImplementation(() => {
      throw new Error('recipe database unavailable');
    });

    expect(() => saveRecipeInline(
      { store: recipeStore.store, webhookConsumerStore: consumer.store },
      webhookRecipe('webhook-rollback'),
      undefined,
      [{ binding: 'generic_delivery', ingress_id: 'whi_owner_selected' }],
    )).toThrow('recipe database unavailable');
    expect(consumer.restore).toHaveBeenCalledTimes(1);
    expect(consumer.finalize).not.toHaveBeenCalled();
  });

  it('D-182 — persists a kernel-op recipe (now accepted, runnable at dispatch)', () => {
    const { store, saveCalls } = inMemoryStore();
    const result = saveRecipeInline({ store }, kernelOpRecipe('kernel-op-recipe'));
    expect(result).toMatchObject({ saved: true, recipe_id: 'kernel-op-recipe' });
    expect(result.op_warnings).toBeUndefined();
    expect(saveCalls).toEqual([
      { recipe_id: 'kernel-op-recipe', publisher_id: 'kitchen', source: 'inline' },
    ]);
  });

  it('D-182 — persists a bare canonical CRM op-step recipe (no longer rejected)', () => {
    const { store, saveCalls } = inMemoryStore();
    const result = saveRecipeInline({ store }, canonicalOpRecipe('canonical-op-recipe'));
    expect(result).toMatchObject({ saved: true, recipe_id: 'canonical-op-recipe' });
    expect(saveCalls).toHaveLength(1);
  });

  it('D-182 — throws RpcError for a canonical op-step with NO type:connection variable', () => {
    const { store, saveCalls } = inMemoryStore();
    let thrown: unknown;
    try {
      saveRecipeInline({ store }, slotlessCanonicalRecipe('slotless-op'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RpcError);
    expect((thrown as RpcError).code).toBe('bad_request');
    expect((thrown as RpcError).message).toContain("type:'connection' variable");
    expect(saveCalls).toEqual([]);
  });

  it('D-182 — throws RpcError for an UNREGISTERED closed-kind kernel op', () => {
    const { store, saveCalls } = inMemoryStore();
    let thrown: unknown;
    try {
      saveRecipeInline({ store }, unregisteredKernelOpRecipe('bogus-kernel-op'));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RpcError);
    expect((thrown as RpcError).code).toBe('bad_request');
    expect((thrown as RpcError).status).toBe(400);
    expect((thrown as RpcError).message).toContain('registered kernel operation');
    expect(saveCalls).toEqual([]);
    expect(store.get('bogus-kernel-op')).toBeNull();
  });

  it('D-182 — persists a Tier-P op recipe with an op_warnings note when depends_on is uncovered', () => {
    const { store, saveCalls } = inMemoryStore();
    const result = saveRecipeInline({ store }, tierPUncoveredRecipe('tierp-uncovered'));
    expect(result).toMatchObject({ saved: true, recipe_id: 'tierp-uncovered' });
    expect(result.op_warnings).toBeDefined();
    expect(result.op_warnings?.some((w) => w.includes('acme.widgets'))).toBe(true);
    expect(saveCalls).toHaveLength(1);
  });

  it('D-182 — persists a Tier-P op recipe with NO warning when depends_on covers it', () => {
    const { store } = inMemoryStore();
    const result = saveRecipeInline({ store }, tierPCoveredRecipe('tierp-covered'));
    expect(result).toMatchObject({ saved: true, recipe_id: 'tierp-covered' });
    expect(result.op_warnings).toBeUndefined();
  });
});

describe('makeRecipeSaveHandlers', () => {
  it('returns undefined when deps are absent', () => {
    expect(makeRecipeSaveHandlers(undefined)).toBeUndefined();
  });

  it('exposes recipe.save + recipe.validate handlers', async () => {
    const { store } = inMemoryStore();
    const slice = makeRecipeSaveHandlers({ store });
    expect(slice).toBeDefined();
    expect(slice?.methods).toEqual([
      'recipe.save',
      'recipe.validate',
      'recipe.webhook.status',
      'recipe.webhook.arm',
      'recipe.webhook.disarm',
    ]);

    const saved = await slice!.handlers['recipe.save'](
      { recipe: validRecipe('via-slice') },
      undefined as never,
    );
    expect(saved).toMatchObject({ saved: true, recipe_id: 'via-slice' });
    expect(store.get('via-slice')).not.toBeNull();

    const validated = await slice!.handlers['recipe.validate'](
      { recipe: validRecipe('check-only') },
      undefined as never,
    );
    expect(validated).toEqual({ ok: true, issues: [] });
    // recipe.validate did NOT persist.
    expect(store.get('check-only')).toBeNull();
  });
});

// ── checkInlineOpSteps (D-182) — the shared op-step save validator ──────────
// Direct unit tests over the helper both seams call: it errors on a
// definitively-unrunnable op-step and warns on an uncovered Tier-P depends_on.
// Tested in isolation (no parseRecipe scaffolding) so cases like a trigger-step
// op or a prefetch op are reachable without a full reactive recipe.
describe('checkInlineOpSteps', () => {
  /** Minimal recipe carrying only the fields checkInlineOpSteps reads. */
  const r = (over: Partial<RecipeDefinition>): RecipeDefinition =>
    ({ steps: [], prefetch_steps: [], variables: {}, ...over } as unknown as RecipeDefinition);
  const opStep = (op: string, extra: Record<string, unknown> = {}) =>
    ({ id: 'x', op, args: {}, ...extra });
  // `connection_kind` is an unlisted ValueHint field the structural validator
  // accepts by design (see value-hint.ts CONTRACT_GAP) — cast like the server
  // op-step tests do.
  const connVars = {
    c: { label: 'C', type: 'connection', connection_kind: 'api', default: '' },
  } as unknown as RecipeDefinition['variables'];

  it('clean for a registered closed-kind kernel op (no slot needed)', () => {
    const out = checkInlineOpSteps(r({ steps: [opStep('core.ai.classify')] }));
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it('errors on an unregistered closed-kind kernel op', () => {
    const out = checkInlineOpSteps(r({ steps: [opStep('core.ai.bogus_op')] }));
    expect(out.errors.some((e) => e.includes('registered kernel operation'))).toBe(true);
  });

  it('errors on an unknown kernel domain', () => {
    const out = checkInlineOpSteps(r({ steps: [opStep('core.nope.thing')] }));
    expect(out.errors.some((e) => e.includes('unknown kernel domain'))).toBe(true);
  });

  it('errors on a mis-conventioned canonical op (bad family)', () => {
    const out = checkInlineOpSteps(
      r({ steps: [opStep('core.crm.bogus.read')], variables: connVars }),
    );
    expect(out.errors.some((e) => e.includes('mis-conventioned'))).toBe(true);
  });

  it('errors on a canonical-convention op with a non-canonical verb', () => {
    // acct canonical ops are read-only — `create` is not a canonical acct verb.
    const out = checkInlineOpSteps(
      r({ steps: [opStep('core.acct.invoice.create')], variables: connVars }),
    );
    expect(out.errors.some((e) => e.includes('not a canonical acct verb'))).toBe(true);
  });

  it('clean for a valid canonical-convention op WITH a connection variable', () => {
    const out = checkInlineOpSteps(
      r({ steps: [opStep('core.crm.deal.read')], variables: connVars }),
    );
    expect(out.errors).toEqual([]);
  });

  it('errors on a slotless bare-canonical op (zero connection variables)', () => {
    const out = checkInlineOpSteps(r({ steps: [opStep('deal.search')], variables: {} }));
    expect(out.errors.some((e) => e.includes("type:'connection' variable"))).toBe(true);
  });

  it('clean for a bare-canonical op WITH a connection variable', () => {
    const out = checkInlineOpSteps(r({ steps: [opStep('deal.search')], variables: connVars }));
    expect(out.errors).toEqual([]);
  });

  it('does NOT require a connection var for a kernel-only recipe', () => {
    const out = checkInlineOpSteps(r({ steps: [opStep('core.ai.classify')], variables: {} }));
    expect(out.errors).toEqual([]);
  });

  it('walks trigger_steps — catches an unregistered core.watch.* op', () => {
    const out = checkInlineOpSteps(
      r({ steps: [], trigger_steps: [opStep('core.watch.bogus')] } as Partial<RecipeDefinition>),
    );
    expect(out.errors.some((e) => e.includes('registered kernel operation'))).toBe(true);
  });

  it('walks prefetch_steps — catches an unregistered kernel op there too', () => {
    const out = checkInlineOpSteps(r({ prefetch_steps: [opStep('core.ai.bogus_op')] as unknown as RecipeDefinition['prefetch_steps'] }));
    expect(out.errors.some((e) => e.includes('registered kernel operation'))).toBe(true);
  });

  it('warns (not errors) on an uncovered Tier-P op; clean when depends_on covers it', () => {
    const uncovered = checkInlineOpSteps(r({ steps: [opStep('acme.widgets.gadget.read')] }));
    expect(uncovered.errors).toEqual([]);
    expect(uncovered.warnings.some((w) => w.includes('acme.widgets'))).toBe(true);

    const covered = checkInlineOpSteps(
      r({ steps: [opStep('acme.widgets.gadget.read')], depends_on: ['acme.widgets'] }),
    );
    expect(covered.warnings).toEqual([]);
  });
});
