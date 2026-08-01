/** D-220 Slice A1 — `metadata.requires_form_fields`: a recipe's declared
 *  contract with the intake form it will be paired to.
 *
 *  ## The defect this closes
 *
 *  A recipe that consumes an accepted Reception submission reads named answers
 *  by STATIC path — `{{step.<reader>.record.values.<name>}}` — because dynamic
 *  indexing (`values.{{config.field}}`) raises `nested_template`. So the field
 *  NAMES are a hard contract between the recipe and whatever form the owner
 *  points at it, and until this slice that contract lived in a readme
 *  paragraph. Point the recipe at a form spelling the field differently and the
 *  read resolves `undefined`, a `default` transform substitutes its fallback,
 *  and the run reports `success: true` having stored nothing. There is no error
 *  to chase, because nothing is wrong from the engine's point of view — the
 *  path simply does not exist.
 *
 *  `requires_form_fields` makes the claim machine-checkable in two places:
 *
 *    1. **Authoring (this slice, static).** `validateRecipe` cross-checks the
 *       declaration against the recipe's own `record.values.<name>` refs, in
 *       BOTH directions — a declared field nothing reads, and a read field
 *       nothing declares, are each an authoring issue. That is what makes this
 *       an enforced contract rather than a second place to write a comment.
 *    2. **Wiring (Slice A2, per-form).** The pair-bind + "Automate this form"
 *       paths compare the declaration against the FROZEN form definition, and
 *       refuse where the owner is standing rather than at fire, where an
 *       anonymous visitor's submission would die silently.
 *
 *  ## Why a `required` axis
 *
 *  A missing REQUIRED field means the recipe cannot do its job; a missing
 *  OPTIONAL one means it degrades (the shipped consumers wrap optional reads in
 *  `default` with an empty fallback and carry on). Collapsing the two would
 *  force every consumer to choose between an unbindable pair and no check at
 *  all. Slice A2 refuses on a required mismatch and warns on an optional one.
 *
 *  ## Empty is meaningful, absent is not
 *
 *  `requires_form_fields: []` is a POSITIVE claim — "this recipe reads no named
 *  answers" — and it is the shape of every seller opener (`open-pass-order` and
 *  siblings read `submission_id` + `visitor.email` and nothing else). An ABSENT
 *  field is an undeclared recipe: legal, unchecked, and the pre-D-220 status
 *  quo. Only the empty array earns the cross-check that proves it reads none.
 *
 *  Spec: D-220 § Slice A. */

import {
  INTAKE_FORM_FIELD_NAME_MAX,
  INTAKE_FORM_FIELDS_COUNT_MAX,
} from './intake-form-config.js';
import {
  INTAKE_FORM_VISITOR_FIELD_TYPE_SET,
  type IntakeFormVisitorFieldType,
} from './redacted-packets.js';

// ────────────────────────────────────────────────────────────────
// Shape
// ────────────────────────────────────────────────────────────────

/** One named answer a recipe reads off an accepted submission.
 *
 *  ⚠ `type` is `IntakeFormVisitorFieldType` — the SAME union
 *  `IntakeFormConfigField.type` uses, imported rather than re-spelled, so the
 *  declaration and the thing it is compared against cannot drift into two
 *  vocabularies. Adding a field type to the form substrate widens this
 *  automatically. */
export interface RecipeFormFieldRequirement {
  /** Must match the form field's `name` EXACTLY — it is a template path
   *  segment (`record.values.<name>`), not a label. */
  readonly name: string;
  readonly type: IntakeFormVisitorFieldType;
  /** `true` ⇒ the recipe cannot function without it (Slice A2 refuses a pair
   *  whose form omits it). `false` ⇒ the recipe degrades gracefully. */
  readonly required: boolean;
  /** Optional author note surfaced beside a mismatch, so the owner reads why
   *  the field matters instead of just which name is missing. */
  readonly note?: string;
}

/** Bound on `note`. Long enough for a sentence; short enough that a mismatch
 *  message stays readable in the pair-bind refusal. */
export const RECIPE_FORM_FIELD_NOTE_MAX = 200;

/** A declaration may not exceed what a form can hold — the ceiling is the
 *  form's own field cap, so a declaration that could never be satisfied by ANY
 *  valid form is rejected at authoring rather than becoming an unbindable
 *  recipe. */
export const RECIPE_FORM_FIELDS_COUNT_MAX = INTAKE_FORM_FIELDS_COUNT_MAX;

// ────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────

export type RecipeFormFieldsValidationCode =
  | 'requires_form_fields_not_array'
  | 'requires_form_fields_whole_object_read'
  | 'requires_form_fields_too_many'
  | 'requires_form_fields_entry_not_object'
  | 'requires_form_fields_name_invalid'
  | 'requires_form_fields_name_too_long'
  | 'requires_form_fields_name_duplicate'
  | 'requires_form_fields_type_unknown'
  | 'requires_form_fields_required_not_boolean'
  | 'requires_form_fields_note_too_long';

export interface RecipeFormFieldsValidationFailure {
  readonly code: RecipeFormFieldsValidationCode;
  readonly detail: string;
}

/** A form field name reaches a recipe as a template path segment, so it must
 *  survive `{{step.x.record.values.<name>}}` unambiguously: no dots (they would
 *  read as nesting), no braces, no whitespace. This is deliberately NARROWER
 *  than what `IntakeFormConfigField.name` permits — a form may hold a field a
 *  recipe cannot address, and the honest place to say so is here, at the recipe
 *  that would have to address it. */
const RECIPE_FORM_FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate a `metadata.requires_form_fields` value. Pure — no I/O.
 *  Returns every failure rather than the first, so an author fixes one pass. */
export const validateRecipeFormFields = (
  raw: unknown,
): ReadonlyArray<RecipeFormFieldsValidationFailure> => {
  const failures: RecipeFormFieldsValidationFailure[] = [];
  if (!Array.isArray(raw)) {
    return [{
      code: 'requires_form_fields_not_array',
      detail: 'requires_form_fields must be an array (use [] to declare that the recipe reads no named answers)',
    }];
  }
  if (raw.length > RECIPE_FORM_FIELDS_COUNT_MAX) {
    failures.push({
      code: 'requires_form_fields_too_many',
      detail: `requires_form_fields holds ${raw.length} entries; a form carries at most ${RECIPE_FORM_FIELDS_COUNT_MAX}`,
    });
  }
  const seen = new Set<string>();
  raw.forEach((entry, idx) => {
    const at = `requires_form_fields[${idx}]`;
    if (!isRecord(entry)) {
      failures.push({
        code: 'requires_form_fields_entry_not_object',
        detail: `${at} must be an object`,
      });
      return;
    }
    const name = entry.name;
    if (typeof name !== 'string' || !RECIPE_FORM_FIELD_NAME_RE.test(name)) {
      failures.push({
        code: 'requires_form_fields_name_invalid',
        detail: `${at}.name must match ${String(RECIPE_FORM_FIELD_NAME_RE)} — it is a template path segment, not a label`,
      });
    } else {
      if (name.length > INTAKE_FORM_FIELD_NAME_MAX) {
        failures.push({
          code: 'requires_form_fields_name_too_long',
          detail: `${at}.name exceeds ${INTAKE_FORM_FIELD_NAME_MAX} characters`,
        });
      }
      if (seen.has(name)) {
        failures.push({
          code: 'requires_form_fields_name_duplicate',
          detail: `${at}.name '${name}' is declared more than once`,
        });
      }
      seen.add(name);
    }
    if (
      typeof entry.type !== 'string'
      || !INTAKE_FORM_VISITOR_FIELD_TYPE_SET.has(entry.type as IntakeFormVisitorFieldType)
    ) {
      failures.push({
        code: 'requires_form_fields_type_unknown',
        detail: `${at}.type must be one of the intake-form visitor field types; got ${JSON.stringify(entry.type)}`,
      });
    }
    if (typeof entry.required !== 'boolean') {
      failures.push({
        code: 'requires_form_fields_required_not_boolean',
        detail: `${at}.required must be a boolean`,
      });
    }
    if (
      entry.note !== undefined
      && (typeof entry.note !== 'string' || entry.note.length > RECIPE_FORM_FIELD_NOTE_MAX)
    ) {
      failures.push({
        code: 'requires_form_fields_note_too_long',
        detail: `${at}.note must be a string of at most ${RECIPE_FORM_FIELD_NOTE_MAX} characters`,
      });
    }
  });
  return failures;
};

// ────────────────────────────────────────────────────────────────
// The static cross-check basis
// ────────────────────────────────────────────────────────────────

/** Matches a read of one named answer off a form-response record:
 *  `{{step.<anything>.record.values.<name>}}` and any deeper path under it
 *  (`…values.address.city`), capturing only the FIRST segment — that is the
 *  form field, and everything after it is structure inside the answer.
 *
 *  ⚠ Deliberately anchored on `.record.values.` rather than the reader step's
 *  id: a recipe may read the response in `prefetch_steps` and again in `steps`,
 *  and the id is author-chosen. What is invariant is the shape of the path. */
const FORM_VALUE_REF_RE =
  /\{\{\s*step\.[A-Za-z0-9_]+\.record\.values\.([A-Za-z_][A-Za-z0-9_]*)/g;

/** Every form field name the recipe JSON actually reads, in first-seen order.
 *
 *  Operates on the SERIALIZED recipe rather than walking step shapes, because a
 *  ref can appear anywhere a value can: a step arg, a nested object in a
 *  `shared.write` payload, a `to_summary` field, a condition string, an inline
 *  mail body. A structural walk would need to know every one of those places
 *  and would silently miss the next one someone invents.
 *
 *  ⚠ Consequence, accepted: a field name appearing inside recipe PROSE
 *  (a `readme`, a variable `help`) in exactly this template shape would count
 *  as a read. That is the safe direction — it over-reports reads, so the
 *  cross-check nags rather than lets an undeclared read through. */
/** Matches a WHOLE-OBJECT read of the submitted answers — `…record.values` with
 *  no field after it, or `…record` itself. The resolver preserves objects on a
 *  pure ref, and `json_stringify` accepts anything, so one of these plus a
 *  serialize step carries EVERY visitor field into a task body, a mail, or a
 *  shared row while naming none of them.
 *
 *  ⚠ Found by adversarial review (Codex, 2026-07-29): the named-field scanner
 *  below sees nothing in that recipe, so a `requires_form_fields: []` declaration
 *  — a POSITIVE claim to read no named answers — validated as accurate while the
 *  recipe consumed the lot. A declaration cannot enumerate what a whole-object
 *  read takes, so the two are incompatible by construction rather than by degree.
 *
 *  The negative lookahead is what makes this disjoint from a named read:
 *  `values.item_description` must NOT match here, only bare `values` / `record`. */
// ⛔ `[a-z_]+`, not `[a-z]+`: the hint vocabulary is FORMAT_HINTS *plus*
// ESCAPE_HINTS, and the escape hints carry underscores (`soql_string`,
// `soql_like`). With `[a-z]+` the regex missed
// `{{step.form_response.record.values:soql_string}}` entirely — `parseRef`
// strips the hint at runtime and a pure ref preserves the whole object, so
// every visitor field flowed onward past a `requires_form_fields: []` claim.
const FORM_WHOLE_OBJECT_REF_RE =
  /\{\{\s*step\.[A-Za-z0-9_]+\.record(?:\.values)?\s*(?::[a-z_]+)?\s*\}\}/g;

/** Every whole-object read of the submitted answers, verbatim, in first-seen
 *  order. Non-empty ⇒ the recipe reads answers it cannot enumerate. */
export const collectWholeFormRecordRefs = (recipe: unknown): ReadonlyArray<string> => {
  let serialized: string;
  try {
    serialized = JSON.stringify(recipe) ?? '';
  } catch {
    return [];
  }
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of serialized.matchAll(FORM_WHOLE_OBJECT_REF_RE)) {
    const ref = match[0];
    if (ref === undefined || seen.has(ref)) continue;
    seen.add(ref);
    found.push(ref);
  }
  return found;
};

export const collectFormValueRefs = (recipe: unknown): ReadonlyArray<string> => {
  let serialized: string;
  try {
    serialized = JSON.stringify(recipe) ?? '';
  } catch {
    return [];
  }
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of serialized.matchAll(FORM_VALUE_REF_RE)) {
    const name = match[1];
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    found.push(name);
  }
  return found;
};

// ────────────────────────────────────────────────────────────────
// D-220 Slice A2 — comparing the declaration against a real form
// ────────────────────────────────────────────────────────────────

/** The runtime shape a submitted answer actually arrives as.
 *
 *  ⚠ DERIVED FROM THE VALIDATOR, not invented here: the per-type arms of
 *  `validateIntakeFormVisitorValues` (`intake-form-config.ts`) are the authority
 *  on what a field's value IS at runtime, and this classifies each `type` by the
 *  arm that accepts it. Five field types accept a plain string (`text`,
 *  `textarea`, `date`, `datetime`, `enum`), so a recipe expecting one of them
 *  and paired to a form declaring another is NOT broken — the value it reads is
 *  a string either way. That is why this comparison is by SHAPE and not by
 *  `type` equality: refusing `text`-vs-`textarea` would be bureaucracy, while
 *  refusing `text`-vs-`array<text>` catches a real shape surprise.
 *
 *  The map is TOTAL over `IntakeFormVisitorFieldType`, so adding a field type to
 *  the form substrate is a COMPILE ERROR here rather than a silent omission that
 *  would classify the new type as "no shape" and quietly stop checking it. */
export const FORM_FIELD_VALUE_SHAPE: Readonly<
  Record<IntakeFormVisitorFieldType, 'string' | 'number' | 'boolean' | 'array' | 'blob_ref'>
> = {
  text: 'string',
  textarea: 'string',
  date: 'string',
  datetime: 'string',
  enum: 'string',
  number: 'number',
  boolean: 'boolean',
  'array<text>': 'array',
  // A `file` answer arrives as a blob reference id — a string on the wire, but
  // semantically a pointer into a drop_link companion, so a recipe expecting
  // prose from it is wrong even though `typeof` agrees.
  file: 'blob_ref',
} as const;

export type FormFieldContractMismatchCode =
  /** The form collects no field of that name. The declared read would resolve
   *  `undefined` on every submission. */
  | 'field_absent'
  /** The form has the name but its answers arrive in a different runtime shape. */
  | 'field_shape_mismatch'
  /** The form has it, but only the OWNER can fill it (`user_only_field_names`),
   *  so a visitor submission never carries it — indistinguishable from absent
   *  from the recipe's point of view, and worth its own code so the owner is
   *  told to move the field rather than add it. */
  | 'field_owner_only'
  /** The recipe needs it but the form does not make it required, so a visitor
   *  may leave it blank. Only ever reported for a `required` declaration. */
  | 'field_optional_in_form';

export interface FormFieldContractMismatch {
  readonly code: FormFieldContractMismatchCode;
  readonly field_name: string;
  /** Mirrors the declaration's `required` — the caller's severity axis: a
   *  required field's mismatch blocks, an optional one's warns. */
  readonly declared_required: boolean;
  readonly detail: string;
}

export interface FormFieldContractVerdict {
  /** True iff no mismatch carries `declared_required: true`. A caller that
   *  refuses a wiring action gates on exactly this. */
  readonly satisfied: boolean;
  /** Mismatches on `required: true` declarations — the blocking set. */
  readonly blocking: ReadonlyArray<FormFieldContractMismatch>;
  /** Mismatches on `required: false` declarations — report, never block. */
  readonly advisory: ReadonlyArray<FormFieldContractMismatch>;
}

/** The minimum form shape this comparison needs. Structural rather than
 *  importing `IntakeFormConfig` so the webclient can call it with a frozen
 *  `definition_snapshot` (which is a `Record<string, unknown>` at that layer)
 *  without a cast through the full config type. */
export interface FormFieldContractFormView {
  readonly fields: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly required?: boolean;
  }>;
  /** `IntakeFormConfigFormDefinition.user_only_field_names` — fields the owner
   *  fills after the fact, which a visitor submission never carries. */
  readonly user_only_field_names?: ReadonlyArray<string>;
}

const SATISFIED: FormFieldContractVerdict = Object.freeze({
  satisfied: true,
  blocking: Object.freeze([]),
  advisory: Object.freeze([]),
});

/** Compare a recipe's declared field contract against one form definition.
 *  Pure — no I/O, no throwing.
 *
 *  ⚠ An ABSENT declaration (`undefined`) returns SATISFIED, not a complaint: an
 *  undeclared recipe is the pre-D-220 status quo and A2 must not retroactively
 *  refuse every pair that already works. `[]` also returns satisfied — it claims
 *  nothing to check. The authoring-time validator is what pushes authors toward
 *  declaring; this function only enforces what was declared. */
export const evaluateFormFieldContract = (
  declared: ReadonlyArray<RecipeFormFieldRequirement> | undefined,
  form: FormFieldContractFormView,
): FormFieldContractVerdict => {
  if (declared === undefined || declared.length === 0) return SATISFIED;

  const byName = new Map<string, FormFieldContractFormView['fields'][number]>();
  for (const field of form.fields ?? []) {
    if (typeof field?.name === 'string') byName.set(field.name, field);
  }
  const ownerOnly = new Set(form.user_only_field_names ?? []);

  const blocking: FormFieldContractMismatch[] = [];
  const advisory: FormFieldContractMismatch[] = [];
  const record = (m: FormFieldContractMismatch): void => {
    (m.declared_required ? blocking : advisory).push(m);
  };

  for (const want of declared) {
    const suffix = want.note === undefined ? '' : ` (${want.note})`;
    // ⚠ OWNER-ONLY IS TESTED FIRST, and the order is load-bearing. The form
    // substrate REFUSES a name that appears in both `fields` and
    // `user_only_field_names` (`user_only_field_name_is_visitor_field`), so the
    // two sets are disjoint by construction: an owner-only field is ABSENT from
    // `fields`. Checking presence first therefore made this branch unreachable
    // dead code and reported `field_absent` — true, but the wrong REMEDY. The
    // owner must move the field to the visitor side, not add a second one.
    if (ownerOnly.has(want.name)) {
      record({
        code: 'field_owner_only',
        field_name: want.name,
        declared_required: want.required,
        detail: `'${want.name}' is an owner-only field, so a visitor submission never carries it — make it visitor-visible${suffix}`,
      });
      continue;
    }
    const have = byName.get(want.name);
    if (have === undefined) {
      record({
        code: 'field_absent',
        field_name: want.name,
        declared_required: want.required,
        detail: `the form collects no field named '${want.name}', so the recipe would read nothing${suffix}`,
      });
      continue;
    }
    const wantShape = FORM_FIELD_VALUE_SHAPE[want.type];
    const haveShape = (FORM_FIELD_VALUE_SHAPE as Record<string, string | undefined>)[have.type];
    if (haveShape !== undefined && haveShape !== wantShape) {
      record({
        code: 'field_shape_mismatch',
        field_name: want.name,
        declared_required: want.required,
        detail: `the recipe expects '${want.name}' to arrive as a ${wantShape} (${want.type}) but the form declares ${have.type}, which arrives as a ${haveShape}${suffix}`,
      });
      continue;
    }
    if (want.required && have.required !== true) {
      record({
        code: 'field_optional_in_form',
        field_name: want.name,
        declared_required: true,
        detail: `the recipe needs '${want.name}' on every submission but the form does not require it, so a visitor may leave it blank${suffix}`,
      });
    }
  }

  return {
    satisfied: blocking.length === 0,
    blocking,
    advisory,
  };
};

// ────────────────────────────────────────────────────────────────
// D-220 Slice A2c — which recipes are armed on one form definition
// ────────────────────────────────────────────────────────────────

/** How tightly an armed `form_response.accepted` trigger is scoped to one
 *  form definition. Vocabulary deliberately matches
 *  `FormResponseAutomationScope` in
 *  `apps/webclient/src/kitchen/recipe-editor/form-response-automation-discovery.ts`
 *  so the two never drift into different words for the same three cases. */
export type FormResponseTriggerFormScope =
  /** `where` names exactly this form definition and nothing else — the trigger
   *  fires on EVERY accepted response to this form. */
  | 'this_form'
  /** Names this form definition PLUS a narrower filter (an endpoint, a specific
   *  response), so it may or may not fire for a given submission. */
  | 'this_form_filtered'
  /** No `where` at all — fires on every form's accepted responses. */
  | 'all_forms';

const FORM_RESPONSE_ON = 'form_response.accepted';

/** Scope one trigger against one form definition, or `null` when the trigger
 *  is not a form-response trigger / targets a different form.
 *
 *  Pure and defensive: stored / imported recipe JSON is a runtime boundary, so a
 *  `where` that is `null`, an array, or carries a non-string value is treated as
 *  NOT MATCHING rather than trusted — a trigger that could never fire must not
 *  be reported as armed. (Mirrors the guard the webclient discovery path already
 *  applies via `validateRecipeEventTriggerEntry`.) */
export const formResponseTriggerFormScope = (
  trigger: unknown,
  form_definition_id: string,
): FormResponseTriggerFormScope | null => {
  if (!isRecord(trigger) || trigger.on !== FORM_RESPONSE_ON) return null;
  const where = trigger.where;
  if (where === undefined) return 'all_forms';
  if (!isRecord(where)) return null;
  const keys = Object.keys(where);
  if (keys.length === 0) return 'all_forms';
  if (where.form_definition_id !== form_definition_id) return null;
  return keys.length === 1 ? 'this_form' : 'this_form_filtered';
};

/** The tightest scope any of a recipe's triggers has against this form, or
 *  `null` when none is armed on it. `this_form` wins over `this_form_filtered`
 *  wins over `all_forms` — the caller's severity axis, because only an
 *  exactly-form-scoped trigger is CERTAIN to fire on this form's submissions. */
export const recipeFormResponseScope = (
  recipe: unknown,
  form_definition_id: string,
): FormResponseTriggerFormScope | null => {
  if (!isRecord(recipe)) return null;
  const triggers = recipe.event_triggers;
  if (!Array.isArray(triggers)) return null;
  let best: FormResponseTriggerFormScope | null = null;
  const rank: Readonly<Record<FormResponseTriggerFormScope, number>> = {
    all_forms: 1,
    this_form_filtered: 2,
    this_form: 3,
  };
  for (const trigger of triggers) {
    const scope = formResponseTriggerFormScope(trigger, form_definition_id);
    if (scope === null) continue;
    if (best === null || rank[scope] > rank[best]) best = scope;
    if (best === 'this_form') break;
  }
  return best;
};
