/** D-220 Slice A2b — `recipe.save` refuses arming a reactive
 *  `form_response.accepted` trigger onto a LIVE form that cannot feed it.
 *
 *  ## Why save, and not the reconciler
 *
 *  When this check was first imagined it was placed at
 *  `reconcileDeclarativeTriggers`, and that raised a question with no good
 *  answer: a reconciler runs at boot, with no owner present and armed state
 *  already in place, so a violation leaves only bad options — disarming a
 *  trigger that works is destructive, ignoring it is silent.
 *
 *  `recipe.save` is where the trigger is actually ARMED. The owner is present,
 *  nothing is armed yet, and a refusal costs an uncompleted save. Same placement
 *  rule the D-207 door check and the A2a bind gate already follow: refuse at the
 *  act, never at fire.
 *
 *  ## What is deliberately NOT refused
 *
 *  - **A form that does not exist yet.** Authoring the recipe before creating the
 *    form is a legitimate order; the A2c `endpoint.create` gate catches the
 *    pairing when the form arrives. Only a LIVE form can contradict a
 *    declaration.
 *  - **`all_forms` / `this_form_filtered` triggers.** An unscoped trigger applies
 *    to forms that do not exist yet, so its contract cannot be resolved at save
 *    time; a filtered one may never fire on that form. Both are left to the
 *    `preview_draft` advisory — report without deciding.
 *  - **An unwired reader.** No form set to compare against ⇒ nothing to fail
 *    closed about, and A2c still holds the other side of the ring.
 */
import { describe, expect, it } from 'vitest';
import { RpcError, type RecipeDefinition } from '@recued/contracts';
import { saveRecipeInline, type RecipeSaveHandlerDeps } from '../recipe-save-handler.js';
import type { RecipeStore } from '../recipe-store.js';

const FORM_ID = 'job-intake-v1';

const inMemoryStore = (): { store: RecipeStore; saved: string[] } => {
  const rows = new Map<string, RecipeDefinition>();
  const saved: string[] = [];
  const store = {
    get: (id: string) => rows.get(id) ?? null,
    getStored: (id: string) => (rows.has(id)
      ? { recipe_id: id, publisher_id: 'kitchen', pack_slug: null }
      : null),
    save: (recipe: RecipeDefinition) => {
      rows.set(recipe.recipe_id, recipe);
      saved.push(recipe.recipe_id);
    },
  } as unknown as RecipeStore;
  return { store, saved };
};

/** An armed reactive recipe that reads one named answer by static path. */
const armedRecipe = (input: {
  readonly requires_form_fields?: unknown;
  readonly where?: Record<string, unknown> | null;
} = {}): RecipeDefinition => ({
  recipe_id: 'open-job-from-intake',
  version: 1,
  ttl: 0,
  metadata: {
    name: 'Open a job from an intake response',
    description: 'Turns one owner-accepted Reception intake response into a job record.',
    author: 'recued-core',
    supported_platforms: [],
    tags: ['job', 'intake', 'reception'],
    ...(input.requires_form_fields === undefined
      ? {}
      : { requires_form_fields: input.requires_form_fields }),
  },
  variables: {},
  prefetch_steps: [{
    id: 'form_response',
    op: 'core.data.form-response.get',
    args: { submission_id: '{{context.event.payload.record_id}}' },
  }],
  steps: [{
    id: 'item_read',
    transform: 'default',
    value: '{{step.form_response.record.values.item_description}}',
    fallback: '',
  }],
  output: { render: [{ type: 'summary', source: 'step.item_read' }] },
  event_triggers: [{
    on: 'form_response.accepted',
    ...(input.where === null ? {} : { where: input.where ?? { form_definition_id: FORM_ID } }),
  }],
} as unknown as RecipeDefinition);

const NEEDS_ITEM = [
  { name: 'item_description', type: 'textarea', required: true },
];

/** A live form's field set, as the composed reader returns it. */
const liveForm = (fields: Array<{ name: string; type: string; required?: boolean }>) =>
  (id: string) => (id === FORM_ID ? { fields } : null);

const deps = (
  reader?: RecipeSaveHandlerDeps['formDefinitionReader'],
): { deps: RecipeSaveHandlerDeps; saved: string[] } => {
  const { store, saved } = inMemoryStore();
  return {
    deps: { store, ...(reader === undefined ? {} : { formDefinitionReader: reader }) },
    saved,
  };
};

const refusal = (fn: () => unknown): RpcError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RpcError) return e;
    throw e;
  }
  throw new Error('expected an RpcError, got a value');
};

describe('D-220 A2b — recipe.save gates the arming act', () => {
  it('⛔ refuses when the live form omits a REQUIRED declared answer, and saves nothing', () => {
    const env = deps(liveForm([
      { name: 'what_they_brought', type: 'textarea', required: true },
    ]));
    const error = refusal(() => saveRecipeInline(
      env.deps,
      armedRecipe({ requires_form_fields: NEEDS_ITEM }),
    ));
    expect(error.code).toBe('form_contract_unsatisfied');
    expect(error.status).toBe(409);
    expect(error.message).toContain('item_description');
    expect(error.message).toContain(FORM_ID);
    expect(env.saved).toEqual([]);
  });

  it('PERMITS when the live form carries the declared answer', () => {
    const env = deps(liveForm([
      { name: 'item_description', type: 'textarea', required: true },
    ]));
    expect(() => saveRecipeInline(
      env.deps,
      armedRecipe({ requires_form_fields: NEEDS_ITEM }),
    )).not.toThrow();
    expect(env.saved).toEqual(['open-job-from-intake']);
  });

  it('PERMITS when the named form does not exist yet — authoring before creating is legitimate', () => {
    // The reader returns null for every id: the form has not been made. A2c
    // gates the pairing when it arrives.
    const env = deps(() => null);
    expect(() => saveRecipeInline(
      env.deps,
      armedRecipe({ requires_form_fields: NEEDS_ITEM }),
    )).not.toThrow();
    expect(env.saved).toEqual(['open-job-from-intake']);
  });

  it('⛔ REFUSES an UNSCOPED trigger that declares required answers', () => {
    // ⚠ INVERTED by the second adversarial pass (Codex 3.3). This previously
    // PERMITTED the combination, reasoning that the contract "cannot be resolved
    // against a form that may not exist" — true, but it answers the wrong
    // question. Not evaluating the contract is right; PERMITTING the combination
    // is not, because nothing else could ever close it: the save gate had no
    // concrete form id, and the create gate deliberately keeps `all_forms`
    // ADVISORY so one recipe cannot veto every future form on the server. The
    // result was a complete pairing-gate bypass — the recipe armed and every
    // accepted response fired it with the declared answer absent.
    //
    // The combination itself is the defect: an unscoped trigger plus required
    // answers asserts that EVERY form on this server collects them, including
    // ones not created yet, which no owner can guarantee. Save is the only place
    // the author is present, and the fix is concrete — name the form.
    const env = deps(liveForm([{ name: 'unrelated', type: 'text', required: false }]));
    const error = refusal(() => saveRecipeInline(
      env.deps,
      armedRecipe({ requires_form_fields: NEEDS_ITEM, where: null }),
    ));
    expect(error?.code).toBe('form_contract_unsatisfied');
    expect(error?.message).toContain('names no form');
    expect(env.saved).toEqual([]);
  });

  it('PERMITS an unscoped trigger that declares NOTHING — the permitting case', () => {
    // The refusal is about the DECLARATION, not the trigger shape. An unscoped
    // `form_response` trigger with no `requires_form_fields` is ordinary and must
    // stay saveable, or the check becomes a ban on unscoped triggers.
    const env = deps(liveForm([{ name: 'unrelated', type: 'text', required: false }]));
    expect(() => saveRecipeInline(
      env.deps,
      armedRecipe({ where: null }),
    )).not.toThrow();
    expect(env.saved).toEqual(['open-job-from-intake']);
  });

  it('⛔ REFUSES a FILTERED trigger — an extra filter narrows, it does not exempt', () => {
    // ⚠ This case was inverted until adversarial review (Codex, 2026-07-29). An
    // accepted-response event carries BOTH `endpoint_id` and
    // `form_definition_id`, compiled into exact equality filters, so a trigger
    // naming this form plus an endpoint fires with CERTAINTY on that endpoint —
    // "may never fire" was wrong. The contract has to hold for the responses the
    // filter DOES match.
    const env = deps(liveForm([{ name: 'unrelated', type: 'text', required: false }]));
    const error = refusal(() => saveRecipeInline(
      env.deps,
      armedRecipe({
        requires_form_fields: NEEDS_ITEM,
        where: { form_definition_id: FORM_ID, endpoint_id: 'ep-elsewhere' },
      }),
    ));
    expect(error.code).toBe('form_contract_unsatisfied');
    expect(env.saved).toEqual([]);
  });

  it('PERMITS a filtered trigger whose form DOES carry the answers', () => {
    // The permitting case: filtered is not a blanket refusal.
    const env = deps(liveForm([
      { name: 'item_description', type: 'textarea', required: true },
    ]));
    expect(() => saveRecipeInline(
      env.deps,
      armedRecipe({
        requires_form_fields: NEEDS_ITEM,
        where: { form_definition_id: FORM_ID, endpoint_id: 'ep-1' },
      }),
    )).not.toThrow();
    expect(env.saved).toEqual(['open-job-from-intake']);
  });

  it('PERMITS an UNDECLARED recipe — the pre-D-220 shape stays saveable', () => {
    const env = deps(liveForm([{ name: 'unrelated', type: 'text', required: false }]));
    expect(() => saveRecipeInline(env.deps, armedRecipe())).not.toThrow();
    expect(env.saved).toEqual(['open-job-from-intake']);
  });

  it('PERMITS when only an OPTIONAL declared answer is missing', () => {
    const env = deps(liveForm([
      { name: 'item_description', type: 'textarea', required: true },
    ]));
    expect(() => saveRecipeInline(env.deps, armedRecipe({
      requires_form_fields: [
        ...NEEDS_ITEM,
        { name: 'contact_name', type: 'text', required: false },
      ],
    }))).not.toThrow();
  });

  it('PERMITS with no reader wired — there is no form set to compare against', () => {
    const env = deps(undefined);
    expect(() => saveRecipeInline(
      env.deps,
      armedRecipe({ requires_form_fields: NEEDS_ITEM }),
    )).not.toThrow();
    expect(env.saved).toEqual(['open-job-from-intake']);
  });

  it('⛔ FAILS CLOSED and saves nothing when the form reader throws', () => {
    // ⚠ Inverted after adversarial review (Codex, 2026-07-29). Swallowing the
    // error reasoned that the create gate covered this pairing — false for an
    // ALREADY-LIVE form, which never sees another create act. A transient
    // registry failure was therefore the one window for arming a contradictory
    // trigger. A retryable refusal costs a click; a silently armed trigger costs
    // every submission after it.
    const env = deps(() => { throw new Error('registry unavailable'); });
    const error = refusal(() => saveRecipeInline(
      env.deps,
      armedRecipe({ requires_form_fields: NEEDS_ITEM }),
    ));
    expect(error.code).toBe('form_contract_unverified');
    expect(error.status).toBe(503);
    expect(env.saved).toEqual([]);
  });

  it('an UNDECLARED recipe still saves through a throwing reader — nothing to verify', () => {
    // The permitting case: the fail-closed path must only fire where there is a
    // declaration whose truth depends on the read.
    const env = deps(() => { throw new Error('registry unavailable'); });
    expect(() => saveRecipeInline(env.deps, armedRecipe())).not.toThrow();
    expect(env.saved).toEqual(['open-job-from-intake']);
  });

  it('ignores a recipe with no form-response trigger at all', () => {
    // ⚠ `on` is a closed vocabulary — `message.received` is the valid non-form
    // member. (`mail.received` is rejected by the trigger validator outright,
    // which is how this fixture first failed.)
    const recipe = armedRecipe({ requires_form_fields: NEEDS_ITEM });
    (recipe as unknown as { event_triggers: unknown[] }).event_triggers = [
      { on: 'message.received' },
    ];
    const env = deps(liveForm([{ name: 'unrelated', type: 'text', required: false }]));
    expect(() => saveRecipeInline(env.deps, recipe)).not.toThrow();
  });

  it('refuses on a shape mismatch, not only an absent field', () => {
    const env = deps(liveForm([
      { name: 'item_description', type: 'array<text>', required: true },
    ]));
    const error = refusal(() => saveRecipeInline(
      env.deps,
      armedRecipe({ requires_form_fields: NEEDS_ITEM }),
    ));
    expect(error.code).toBe('form_contract_unsatisfied');
  });

  it('checks EVERY armed trigger, not just the first', () => {
    const recipe = armedRecipe({ requires_form_fields: NEEDS_ITEM });
    (recipe as unknown as { event_triggers: unknown[] }).event_triggers = [
      { on: 'form_response.accepted', where: { form_definition_id: 'some-other-form' } },
      { on: 'form_response.accepted', where: { form_definition_id: FORM_ID } },
    ];
    const env = deps(liveForm([
      { name: 'what_they_brought', type: 'textarea', required: true },
    ]));
    // The FIRST trigger names a form the reader does not know (null ⇒ skip); the
    // second is the breaking one. A loop that returned after the first trigger
    // would let this through.
    expect(refusal(() => saveRecipeInline(env.deps, recipe)).code)
      .toBe('form_contract_unsatisfied');
  });
});
