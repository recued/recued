/** D-220 Slice A1 — `metadata.requires_form_fields` shape + the static
 *  cross-check.
 *
 *  What this pins, and why each half earns its own case:
 *
 *  - **The undeclared read is an ERROR.** It is the defect the slice exists to
 *    close: a recipe reads `record.values.item_description` by static path,
 *    the paired form spells it differently, the ref resolves `undefined`, a
 *    `default` transform substitutes its fallback, and the run reports
 *    `success: true` having stored nothing. Nothing else in the stack notices.
 *  - **The unread declaration is a WARN.** An author may legitimately require a
 *    field for the OWNER's benefit (it lands on the Inbox review card) without
 *    the recipe reading it. Erroring would make that unexpressible.
 *  - **`[]` is checked; ABSENT is not.** The empty array is a positive claim —
 *    "reads no named answers", the seller-opener shape — so a read under it is
 *    still an error. An absent field is the pre-D-220 undeclared recipe, and
 *    only earns an `info` nudge when it actually reads something.
 *  - **The type vocabulary is imported, not copied.** A test asserts a real
 *    `INTAKE_FORM_VISITOR_FIELD_TYPES` member passes and a plausible non-member
 *    (`string`) fails, so the two lists cannot drift into two vocabularies.
 *
 *  Spec: D-220 § Slice A.
 */
import { describe, it, expect } from 'vitest';
import {
  INTAKE_FORM_VISITOR_FIELD_TYPES,
  RECIPE_FORM_FIELDS_COUNT_MAX,
  RECIPE_FORM_FIELD_NOTE_MAX,
  collectFormValueRefs,
  validateRecipeFormFields,
  type RecipeDefinition,
} from '@recued/contracts';
import { validateRecipe } from '../validate.js';

const recipe = (over: {
  requires_form_fields?: unknown;
  steps?: unknown[];
  prefetch_steps?: unknown[];
} = {}): unknown => {
  const metadata: Record<string, unknown> = {
    name: 'Sample',
    description: 'A long enough description to skip the description_thin info nudge in these tests.',
    author: 'recued-core',
    supported_platforms: [],
    tags: ['test'],
  };
  if ('requires_form_fields' in over) {
    metadata.requires_form_fields = over.requires_form_fields;
  }
  return {
    recipe_id: 'sample-recipe',
    version: 1,
    ttl: 0,
    metadata,
    variables: {},
    prefetch_steps: over.prefetch_steps ?? [],
    steps: over.steps ?? [{ id: 'noop', transform: 'count', input: [] }],
    output: { render: [] },
  };
};

/** The canonical accepted-response reader every consumer carries. */
const READER = {
  id: 'form_response',
  op: 'core.data.form-response.get',
  args: { submission_id: '{{context.event.payload.record_id}}' },
};

const readStep = (id: string, name: string): Record<string, unknown> => ({
  id,
  transform: 'default',
  value: `{{step.form_response.record.values.${name}}}`,
  fallback: '',
});

const issue = (result: ReturnType<typeof validateRecipe>, code: string) =>
  result.issues.find((i) => i.code === code);

// ────────────────────────────────────────────────────────────────
// collectFormValueRefs — the cross-check basis
// ────────────────────────────────────────────────────────────────

describe('collectFormValueRefs', () => {
  it('finds a read regardless of which step id or phase carries it', () => {
    const value = recipe({
      prefetch_steps: [READER, readStep('a', 'alpha')],
      steps: [readStep('b', 'beta')],
    });
    expect(collectFormValueRefs(value)).toEqual(['alpha', 'beta']);
  });

  it('captures only the first path segment — deeper structure is inside the answer', () => {
    expect(
      collectFormValueRefs({ x: '{{step.fr.record.values.address.city}}' }),
    ).toEqual(['address']);
  });

  it('finds refs anywhere a value can live, not just in step args', () => {
    // A structural walk over known step shapes would miss every one of these.
    const value = {
      steps: [
        {
          id: 'write',
          op: 'core.storage.shared.write',
          args: { key: 'k', value: { nested: { deep: '{{step.fr.record.values.buried}}' } } },
        },
        { id: 'gate', transform: 'compare', left: '{{step.fr.record.values.gated}}', operator: 'is_not_empty' },
        { id: 'mail', op: 'core.mail.send', args: { body: 'hi {{step.fr.record.values.inline}} there' } },
      ],
    };
    expect([...collectFormValueRefs(value)].sort()).toEqual(['buried', 'gated', 'inline']);
  });

  it('de-duplicates a field read many times', () => {
    expect(
      collectFormValueRefs({
        a: '{{step.fr.record.values.same}}',
        b: '{{step.fr.record.values.same}}',
      }),
    ).toEqual(['same']);
  });

  it('does not mistake a visitor field or a bare record read for a named answer', () => {
    expect(
      collectFormValueRefs({
        a: '{{step.fr.record.visitor.email}}',
        b: '{{step.fr.record.submission_id}}',
        c: '{{step.fr.record}}',
      }),
    ).toEqual([]);
  });

  it('returns empty rather than throwing on an unserializable recipe', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(collectFormValueRefs(cyclic)).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// validateRecipeFormFields — shape
// ────────────────────────────────────────────────────────────────

describe('validateRecipeFormFields', () => {
  const ok = { name: 'item_description', type: 'textarea', required: true };

  it('accepts a well-formed declaration and an empty one', () => {
    expect(validateRecipeFormFields([ok])).toEqual([]);
    expect(validateRecipeFormFields([])).toEqual([]);
  });

  it('rejects a non-array', () => {
    for (const bad of [undefined, null, {}, 'item_description', 3]) {
      expect(validateRecipeFormFields(bad).map((f) => f.code))
        .toEqual(['requires_form_fields_not_array']);
    }
  });

  it('accepts every real intake-form field type and rejects a plausible non-member', () => {
    // Guards against the declaration and the form definition drifting into two
    // vocabularies — the union is imported, and this proves the import is live.
    for (const type of INTAKE_FORM_VISITOR_FIELD_TYPES) {
      expect(validateRecipeFormFields([{ ...ok, type }]), type).toEqual([]);
    }
    for (const bad of ['string', 'str', 'text ', 'TEXT', 'select']) {
      expect(validateRecipeFormFields([{ ...ok, type: bad }]).map((f) => f.code), bad)
        .toContain('requires_form_fields_type_unknown');
    }
  });

  it('rejects a name that would not survive a template path', () => {
    for (const bad of ['item.description', 'item description', '1item', 'item-description', '', '{{x}}']) {
      expect(validateRecipeFormFields([{ ...ok, name: bad }]).map((f) => f.code), bad)
        .toContain('requires_form_fields_name_invalid');
    }
  });

  it('rejects a duplicate name, a non-boolean required, and an over-long note', () => {
    expect(validateRecipeFormFields([ok, ok]).map((f) => f.code))
      .toContain('requires_form_fields_name_duplicate');
    expect(validateRecipeFormFields([{ ...ok, required: 'yes' }]).map((f) => f.code))
      .toContain('requires_form_fields_required_not_boolean');
    expect(
      validateRecipeFormFields([{ ...ok, note: 'x'.repeat(RECIPE_FORM_FIELD_NOTE_MAX + 1) }])
        .map((f) => f.code),
    ).toContain('requires_form_fields_note_too_long');
    // The permitting case for the same bound.
    expect(validateRecipeFormFields([{ ...ok, note: 'x'.repeat(RECIPE_FORM_FIELD_NOTE_MAX) }]))
      .toEqual([]);
  });

  it('refuses a declaration no valid form could satisfy', () => {
    const tooMany = Array.from({ length: RECIPE_FORM_FIELDS_COUNT_MAX + 1 }, (_, i) => ({
      ...ok,
      name: `f${i}`,
    }));
    expect(validateRecipeFormFields(tooMany).map((f) => f.code))
      .toContain('requires_form_fields_too_many');
    // The permitting case: exactly the form's own field cap is fine.
    expect(validateRecipeFormFields(tooMany.slice(0, RECIPE_FORM_FIELDS_COUNT_MAX))).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// The cross-check, through validateRecipe
// ────────────────────────────────────────────────────────────────

describe('validateRecipe — requires_form_fields cross-check', () => {
  it('a declared + read field is clean', () => {
    const result = validateRecipe(recipe({
      requires_form_fields: [{ name: 'item_description', type: 'textarea', required: true }],
      prefetch_steps: [READER],
      steps: [readStep('item_read', 'item_description')],
    }) as RecipeDefinition);
    expect(result.issues.filter((i) => i.code.startsWith('requires_form_fields'))).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('⛔ an UNDECLARED read is an error — this is the silent failure the slice closes', () => {
    const result = validateRecipe(recipe({
      requires_form_fields: [{ name: 'item_description', type: 'textarea', required: true }],
      prefetch_steps: [READER],
      steps: [readStep('item_read', 'item_description'), readStep('who_read', 'contact_name')],
    }) as RecipeDefinition);
    const found = issue(result, 'requires_form_fields_undeclared');
    expect(found).toBeDefined();
    expect(found!.severity).toBe('error');
    expect(found!.message).toContain('contact_name');
    expect(result.valid).toBe(false);
  });

  it('an unread declaration warns but does not block', () => {
    const result = validateRecipe(recipe({
      requires_form_fields: [
        { name: 'item_description', type: 'textarea', required: true },
        { name: 'owner_only_note', type: 'text', required: false },
      ],
      prefetch_steps: [READER],
      steps: [readStep('item_read', 'item_description')],
    }) as RecipeDefinition);
    const found = issue(result, 'requires_form_fields_unread');
    expect(found).toBeDefined();
    expect(found!.severity).toBe('warn');
    expect(found!.message).toContain('owner_only_note');
    expect(result.valid).toBe(true);
  });

  it('[] is a CHECKED claim — the seller-opener shape stays clean, but a read under it errors', () => {
    // The seller shape: reads submission_id + visitor.email and nothing else.
    const seller = validateRecipe(recipe({
      requires_form_fields: [],
      prefetch_steps: [READER],
      steps: [{
        id: 'email',
        transform: 'default',
        value: '{{step.form_response.record.visitor.email}}',
        fallback: '',
      }],
    }) as RecipeDefinition);
    expect(seller.issues.filter((i) => i.code.startsWith('requires_form_fields'))).toEqual([]);
    expect(seller.valid).toBe(true);

    const lying = validateRecipe(recipe({
      requires_form_fields: [],
      prefetch_steps: [READER],
      steps: [readStep('item_read', 'item_description')],
    }) as RecipeDefinition);
    expect(issue(lying, 'requires_form_fields_undeclared')?.severity).toBe('error');
    expect(lying.valid).toBe(false);
  });

  it('an ABSENT declaration is unchecked, and nudges only when it reads something', () => {
    const readsNothing = validateRecipe(recipe() as RecipeDefinition);
    expect(issue(readsNothing, 'requires_form_fields_absent')).toBeUndefined();

    const reads = validateRecipe(recipe({
      prefetch_steps: [READER],
      steps: [readStep('item_read', 'item_description')],
    }) as RecipeDefinition);
    const nudge = issue(reads, 'requires_form_fields_absent');
    expect(nudge).toBeDefined();
    expect(nudge!.severity).toBe('info');
    expect(nudge!.message).toContain('item_description');
    // An info never blocks — every pre-D-220 recipe in the corpus stays valid.
    expect(reads.valid).toBe(true);
  });

  it('a malformed declaration surfaces its shape code as an error on the recipe', () => {
    const result = validateRecipe(recipe({
      requires_form_fields: [{ name: 'item.description', type: 'nope', required: 'yes' }],
    }) as RecipeDefinition);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain('requires_form_fields_name_invalid');
    expect(codes).toContain('requires_form_fields_type_unknown');
    expect(codes).toContain('requires_form_fields_required_not_boolean');
    expect(result.valid).toBe(false);
  });

  it('a non-array declaration does not also emit a spurious undeclared-read error', () => {
    // The shape failure is the finding; re-reporting every read on top of it
    // would bury the one line the author needs.
    const result = validateRecipe(recipe({
      requires_form_fields: { item_description: 'textarea' },
      prefetch_steps: [READER],
      steps: [readStep('item_read', 'item_description')],
    }) as RecipeDefinition);
    expect(issue(result, 'requires_form_fields_not_array')).toBeDefined();
    expect(issue(result, 'requires_form_fields_undeclared')).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────
// The whole-object bypass (Codex finding 3.1)
// ────────────────────────────────────────────────────────────────

describe('validateRecipe — whole-object reads cannot hide behind a declaration', () => {
  /** The bypass as reported: take the entire answers object, serialize it, and
   *  publish the serialization. The named-field scanner sees nothing. */
  const wholeObjectRecipe = (declare: { requires_form_fields?: unknown } | null) => recipe({
    ...(declare === null ? {} : { requires_form_fields: declare.requires_form_fields }),
    prefetch_steps: [READER],
    steps: [
      { id: 'everything', transform: 'json_stringify', input: '{{step.form_response.record.values}}' },
      { id: 'publish', transform: 'default', value: '{{step.everything}}', fallback: '' },
    ],
  });

  it('⛔ a [] declaration beside a whole-values read is an ERROR, not an accurate claim', () => {
    const result = validateRecipe(wholeObjectRecipe({ requires_form_fields: [] }) as RecipeDefinition);
    const found = issue(result, 'requires_form_fields_whole_object_read');
    expect(found).toBeDefined();
    expect(found!.severity).toBe('error');
    expect(found!.message).toContain('record.values');
    expect(result.valid).toBe(false);
  });

  it('⛔ a NAMED declaration beside a whole-values read is also an error', () => {
    const result = validateRecipe(wholeObjectRecipe({
      requires_form_fields: [{ name: 'item_description', type: 'textarea', required: true }],
    }) as RecipeDefinition);
    expect(issue(result, 'requires_form_fields_whole_object_read')?.severity).toBe('error');
  });

  it('⛔ catches a whole-RECORD read too, not just whole-values', () => {
    const result = validateRecipe(recipe({
      requires_form_fields: [],
      prefetch_steps: [READER],
      steps: [{ id: 'blob', transform: 'json_stringify', input: '{{step.form_response.record}}' }],
    }) as RecipeDefinition);
    expect(issue(result, 'requires_form_fields_whole_object_read')?.severity).toBe('error');
  });

  it('warns when a whole read is UNDECLARED — no gate can check it', () => {
    const result = validateRecipe(wholeObjectRecipe(null) as RecipeDefinition);
    const found = issue(result, 'requires_form_fields_absent');
    expect(found?.severity).toBe('warn');
    expect(found!.message).toContain('WHOLE');
  });

  it('does NOT fire on a named read — the two patterns must stay disjoint', () => {
    // The permitting case. A scanner that matched `values.item_description` as a
    // whole read would refuse every correct recipe, including the shipped ones.
    const result = validateRecipe(recipe({
      requires_form_fields: [{ name: 'item_description', type: 'textarea', required: true }],
      prefetch_steps: [READER],
      steps: [readStep('item_read', 'item_description')],
    }) as RecipeDefinition);
    expect(issue(result, 'requires_form_fields_whole_object_read')).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it('does not fire on a visitor-field or submission-id read', () => {
    const result = validateRecipe(recipe({
      requires_form_fields: [],
      prefetch_steps: [READER],
      steps: [
        { id: 'email', transform: 'default', value: '{{step.form_response.record.visitor.email}}', fallback: '' },
        { id: 'sid', transform: 'default', value: '{{step.form_response.record.submission_id}}', fallback: '' },
      ],
    }) as RecipeDefinition);
    expect(issue(result, 'requires_form_fields_whole_object_read')).toBeUndefined();
    expect(result.valid).toBe(true);
  });
});
