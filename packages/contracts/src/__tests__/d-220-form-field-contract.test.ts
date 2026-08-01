/** D-220 Slice A2 — `evaluateFormFieldContract`: comparing a recipe's declared
 *  field contract against ONE real form definition.
 *
 *  A1 checks a recipe against ITSELF (declaration vs its own refs). This is the
 *  half that checks it against a form, and it is the one that can refuse a
 *  wiring action — so its two axes both earn cases:
 *
 *  - **`required` decides severity, not whether we look.** A missing required
 *    field blocks (the recipe cannot work); a missing optional one is advisory
 *    (the shipped consumers wrap optional reads in `default` and degrade).
 *  - **Comparison is by runtime SHAPE, not `type` equality.** Five field types
 *    arrive as a plain string, so `text`-vs-`textarea` is not a defect and
 *    refusing it would be bureaucracy. `text`-vs-`array<text>` is a real shape
 *    surprise and does block. The shape map is derived from the per-type arms of
 *    `validateIntakeFormVisitorValues`, which is the authority on what a value
 *    actually IS at runtime.
 *
 *  ⚠ The `FORM_FIELD_VALUE_SHAPE` totality test is the load-bearing one: it is
 *  what makes adding a field type to the form substrate a compile error here
 *  rather than a silently unclassified type that stops being checked.
 */
import { describe, expect, it } from 'vitest';
import {
  FORM_FIELD_VALUE_SHAPE,
  INTAKE_FORM_VISITOR_FIELD_TYPES,
  collectWholeFormRecordRefs,
  evaluateFormFieldContract,
  type FormFieldContractFormView,
  type RecipeFormFieldRequirement,
} from '../index.js';

const need = (
  over: Partial<RecipeFormFieldRequirement> = {},
): RecipeFormFieldRequirement => ({
  name: 'item_description',
  type: 'textarea',
  required: true,
  ...over,
});

const form = (
  fields: FormFieldContractFormView['fields'],
  user_only_field_names?: ReadonlyArray<string>,
): FormFieldContractFormView =>
  user_only_field_names === undefined
    ? { fields }
    : { fields, user_only_field_names };

const FULL = form([
  { name: 'item_description', type: 'textarea', required: true },
  { name: 'contact_name', type: 'text', required: false },
]);

describe('FORM_FIELD_VALUE_SHAPE', () => {
  it('classifies every intake-form field type — a new type is a compile error, not a gap', () => {
    for (const type of INTAKE_FORM_VISITOR_FIELD_TYPES) {
      expect(FORM_FIELD_VALUE_SHAPE[type], type).toBeDefined();
    }
    expect(Object.keys(FORM_FIELD_VALUE_SHAPE).sort())
      .toEqual([...INTAKE_FORM_VISITOR_FIELD_TYPES].sort());
  });

  it('groups the five string-arriving types together', () => {
    // Mirrors validateIntakeFormVisitorValues: text / textarea / date / datetime
    // / enum all reject a non-string, so all five arrive as strings.
    for (const type of ['text', 'textarea', 'date', 'datetime', 'enum'] as const) {
      expect(FORM_FIELD_VALUE_SHAPE[type], type).toBe('string');
    }
    expect(FORM_FIELD_VALUE_SHAPE['array<text>']).toBe('array');
    expect(FORM_FIELD_VALUE_SHAPE.number).toBe('number');
    expect(FORM_FIELD_VALUE_SHAPE.boolean).toBe('boolean');
    // A `file` answer is a blob-reference id — a string on the wire, but a
    // pointer, so a recipe expecting prose from it is wrong.
    expect(FORM_FIELD_VALUE_SHAPE.file).toBe('blob_ref');
  });
});

describe('evaluateFormFieldContract — the undeclared and empty cases', () => {
  it('an ABSENT declaration is satisfied — A2 must not retroactively refuse working pairs', () => {
    const verdict = evaluateFormFieldContract(undefined, form([]));
    expect(verdict.satisfied).toBe(true);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.advisory).toEqual([]);
  });

  it('an EMPTY declaration is satisfied against any form — it claims nothing to check', () => {
    expect(evaluateFormFieldContract([], form([])).satisfied).toBe(true);
    expect(evaluateFormFieldContract([], FULL).satisfied).toBe(true);
  });
});

describe('evaluateFormFieldContract — a satisfied contract', () => {
  it('passes when every declared field is present, visitor-visible, and shaped right', () => {
    const verdict = evaluateFormFieldContract(
      [need(), need({ name: 'contact_name', type: 'text', required: false })],
      FULL,
    );
    expect(verdict.satisfied).toBe(true);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.advisory).toEqual([]);
  });

  it('accepts a different type in the SAME runtime shape — text vs textarea is not a defect', () => {
    for (const formType of ['text', 'textarea', 'date', 'datetime', 'enum'] as const) {
      const verdict = evaluateFormFieldContract(
        [need({ type: 'text' })],
        form([{ name: 'item_description', type: formType, required: true }]),
      );
      expect(verdict.satisfied, formType).toBe(true);
      expect(verdict.advisory, formType).toEqual([]);
    }
  });

  it('ignores an unknown form field type rather than inventing a mismatch', () => {
    // A form carrying a type this build does not know is a forward-compat
    // situation, not a contract breach — refusing would make an older client
    // unable to bind a newer form.
    const verdict = evaluateFormFieldContract(
      [need()],
      form([{ name: 'item_description', type: 'rich_text_v2', required: true }]),
    );
    expect(verdict.satisfied).toBe(true);
  });
});

describe('evaluateFormFieldContract — blocking mismatches (required declarations)', () => {
  it('⛔ field_absent — the read would resolve undefined on every submission', () => {
    const verdict = evaluateFormFieldContract([need()], form([
      { name: 'what_they_brought', type: 'textarea', required: true },
    ]));
    expect(verdict.satisfied).toBe(false);
    expect(verdict.blocking).toHaveLength(1);
    expect(verdict.blocking[0]!.code).toBe('field_absent');
    expect(verdict.blocking[0]!.field_name).toBe('item_description');
    expect(verdict.blocking[0]!.declared_required).toBe(true);
  });

  it('⛔ field_owner_only — the form has the name, but only the owner can fill it', () => {
    // ⚠ The substrate REFUSES a name in both `fields` and `user_only_field_names`
    // (they are disjoint by construction), so this is the only legal shape for an
    // owner-only field: absent from `fields`, present in the owner-only list. A
    // presence-first implementation reported `field_absent` here — true, but it
    // pointed the owner at the wrong remedy.
    const verdict = evaluateFormFieldContract(
      [need()],
      form([{ name: 'contact_name', type: 'text', required: false }], ['item_description']),
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.blocking[0]!.code).toBe('field_owner_only');
    // The remedy is to move the field, not to add one — the message must say so.
    expect(verdict.blocking[0]!.detail).toContain('visitor-visible');
  });

  it('⛔ field_shape_mismatch — an array answer where the recipe expects a string', () => {
    const verdict = evaluateFormFieldContract(
      [need({ type: 'text' })],
      form([{ name: 'item_description', type: 'array<text>', required: true }]),
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.blocking[0]!.code).toBe('field_shape_mismatch');
    expect(verdict.blocking[0]!.detail).toContain('string');
    expect(verdict.blocking[0]!.detail).toContain('array');
  });

  it('⛔ field_optional_in_form — the recipe needs it every time, the form lets it be blank', () => {
    const verdict = evaluateFormFieldContract(
      [need()],
      form([{ name: 'item_description', type: 'textarea', required: false }]),
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.blocking[0]!.code).toBe('field_optional_in_form');
  });

  it('treats a form field with no `required` key as not required', () => {
    const verdict = evaluateFormFieldContract(
      [need()],
      form([{ name: 'item_description', type: 'textarea' }]),
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.blocking[0]!.code).toBe('field_optional_in_form');
  });

  it('carries the author note into the mismatch so the owner reads WHY it matters', () => {
    const verdict = evaluateFormFieldContract(
      [need({ note: 'the board cannot say what the job is without it' })],
      form([]),
    );
    expect(verdict.blocking[0]!.detail).toContain('the board cannot say what the job is');
  });

  it('reports every mismatch, not just the first', () => {
    const verdict = evaluateFormFieldContract(
      [need(), need({ name: 'contact_name', type: 'text' })],
      form([]),
    );
    expect(verdict.blocking.map((m) => m.field_name).sort())
      .toEqual(['contact_name', 'item_description']);
  });
});

describe('evaluateFormFieldContract — advisory mismatches (optional declarations)', () => {
  it('an optional field missing is ADVISORY — the pair still binds', () => {
    const verdict = evaluateFormFieldContract(
      [need(), need({ name: 'contact_name', type: 'text', required: false })],
      form([{ name: 'item_description', type: 'textarea', required: true }]),
    );
    // ⛔ THE severity split: this must NOT block, or a recipe could not express
    // "nice to have" and every optional read would make a pair unbindable.
    expect(verdict.satisfied).toBe(true);
    expect(verdict.blocking).toEqual([]);
    expect(verdict.advisory).toHaveLength(1);
    expect(verdict.advisory[0]!.code).toBe('field_absent');
    expect(verdict.advisory[0]!.declared_required).toBe(false);
  });

  it('an optional field never reports field_optional_in_form — there is nothing to warn about', () => {
    const verdict = evaluateFormFieldContract(
      [need({ name: 'contact_name', type: 'text', required: false })],
      form([{ name: 'contact_name', type: 'text', required: false }]),
    );
    expect(verdict.satisfied).toBe(true);
    expect(verdict.advisory).toEqual([]);
  });

  it('an optional field with a wrong SHAPE is still only advisory', () => {
    const verdict = evaluateFormFieldContract(
      [need({ name: 'contact_name', type: 'text', required: false })],
      form([{ name: 'contact_name', type: 'number', required: false }]),
    );
    expect(verdict.satisfied).toBe(true);
    expect(verdict.advisory[0]!.code).toBe('field_shape_mismatch');
  });

  it('mixes blocking and advisory in one verdict without losing either', () => {
    const verdict = evaluateFormFieldContract(
      [need(), need({ name: 'contact_name', type: 'text', required: false })],
      form([]),
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.blocking.map((m) => m.field_name)).toEqual(['item_description']);
    expect(verdict.advisory.map((m) => m.field_name)).toEqual(['contact_name']);
  });
});

describe('evaluateFormFieldContract — hostile / degenerate input', () => {
  it('survives a form with no fields array and a malformed field entry', () => {
    const verdict = evaluateFormFieldContract(
      [need()],
      { fields: undefined as unknown as FormFieldContractFormView['fields'] },
    );
    expect(verdict.satisfied).toBe(false);
    expect(verdict.blocking[0]!.code).toBe('field_absent');

    const malformed = evaluateFormFieldContract([need()], form([
      { name: undefined as unknown as string, type: 'textarea', required: true },
      { name: 'item_description', type: 'textarea', required: true },
    ]));
    expect(malformed.satisfied).toBe(true);
  });
});

describe('whole-object detection covers the full hint vocabulary', () => {
  // ⛔⛔ The hint class is FORMAT_HINTS *plus* ESCAPE_HINTS, and the escape hints
  // carry underscores. A `[a-z]+` hint class missed `:soql_string` entirely, so
  // a recipe could claim `requires_form_fields: []` and still hand every visitor
  // answer onward — `parseRef` strips the hint and a pure ref preserves the
  // whole object.
  const recipeWith = (ref: string): unknown => ({
    recipe_id: 'r',
    steps: [{ id: 'out', transform: 'json_stringify', input: ref }],
  });

  for (const hint of ['', ':json', ':soql_string', ':soql_like', ':number']) {
    it(`detects a whole \`values\` read with hint '${hint || '(none)'}'`, () => {
      const found = collectWholeFormRecordRefs(
        recipeWith(`{{step.form_response.record.values${hint}}}`),
      );
      expect(found, hint).toHaveLength(1);
    });

    it(`detects a whole \`record\` read with hint '${hint || '(none)'}'`, () => {
      const found = collectWholeFormRecordRefs(
        recipeWith(`{{step.form_response.record${hint}}}`),
      );
      expect(found, hint).toHaveLength(1);
    });
  }

  it('still does not fire on a NAMED field read, which is the permitted case', () => {
    // Without this the widened class could be a blanket detector, which would
    // refuse every legitimate recipe rather than the whole-object ones.
    expect(
      collectWholeFormRecordRefs(recipeWith('{{step.form_response.record.values.item}}')),
    ).toEqual([]);
    expect(
      collectWholeFormRecordRefs(recipeWith('{{step.form_response.record.values.item:soql_string}}')),
    ).toEqual([]);
  });
});
