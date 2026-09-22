/** D-145 PA5 — per-type validators + composite form validation.
 *
 *  Built-in validators per `FormFieldType`. Each validator returns
 *  `null` if the value passes, or a human-readable error message
 *  otherwise. Hooks (`ValidationHooks`) carry substrate-external
 *  checks the pure validators can't perform — the prototype is
 *  `ref_exists`, which requires a DB query.
 *
 *  PA5 ships the synchronous slice: shape + range + closed-list
 *  membership. Async ref-existence is layered on by the host app
 *  through `ValidationHooks.ref_exists`.
 *
 *  Spec: D-145 § A.3.1 (per-type validation hooks).
 */

import type {
  DiscriminatedUnionVariant,
  FieldValidationError,
  FieldValidator,
  FormDefinition,
  FormField,
  ShowIfCondition,
  ValidationHooks,
} from './types.js';
import { testDeclaredPattern } from '../declared-pattern.js';

// ────────────────────────────────────────────────────────────────
// Built-in per-type validators
// ────────────────────────────────────────────────────────────────

const checkTextish = (field: FormField, value: unknown): string | null => {
  if (value === null || value === undefined) {
    return field.required ? 'Required' : null;
  }
  if (typeof value !== 'string') return 'Must be a string';
  if (field.required && value.trim() === '') return 'Required';
  if (
    field.max_length !== undefined &&
    [...value].length > field.max_length
  ) {
    return `Must be ≤ ${field.max_length} characters`;
  }
  if (field.pattern !== undefined && value !== '') {
    // ⛔ This runs a PACK-declared pattern against a value the visitor typed, on
    //   a thread nothing can interrupt. `testDeclaredPattern` keeps the throwing
    //   semantics this `catch` depends on. See `../declared-pattern.ts`.
    let matched: boolean;
    try {
      matched = testDeclaredPattern(field.pattern, value);
    } catch {
      return 'Invalid pattern in field definition';
    }
    if (!matched) return 'Must match the required format';
  }
  return null;
};

const validateText: FieldValidator = checkTextish;

const validateTextarea: FieldValidator = checkTextish;

const validateNumber: FieldValidator = (field, value) => {
  if (value === null || value === undefined) {
    return field.required ? 'Required' : null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'Must be a finite number';
  }
  if (field.integer === true && !Number.isInteger(value)) {
    return 'Must be a whole number';
  }
  if (field.min !== undefined && value < field.min) {
    return `Must be ≥ ${field.min}`;
  }
  if (field.max !== undefined && value > field.max) {
    return `Must be ≤ ${field.max}`;
  }
  return null;
};

const validateBoolean: FieldValidator = (field, value) => {
  if (value === null || value === undefined) {
    return field.required ? 'Required' : null;
  }
  if (typeof value !== 'boolean') return 'Must be true or false';
  return null;
};

const validateDate: FieldValidator = (field, value) => {
  if (value === null || value === undefined || value === '') {
    return field.required ? 'Required' : null;
  }
  if (typeof value !== 'string') return 'Must be a date string (YYYY-MM-DD)';
  // ISO 8601 calendar date; explicit gate rather than relying on Date
  // to avoid `2024-13-45` parsing into something silly.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return 'Must be a date string (YYYY-MM-DD)';
  const [, yStr, moStr, dStr] = m;
  const y = Number(yStr);
  const mo = Number(moStr);
  const d = Number(dStr);
  if (mo < 1 || mo > 12) return 'Month must be 01–12';
  if (d < 1 || d > 31) return 'Day must be 01–31';
  // Day-in-month gate (handles Feb + leap years).
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > dim) return `Day must be ≤ ${dim} for that month`;
  return null;
};

const TIMESTAMP_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
const NAIVE_TIMESTAMP_REGEX =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

const validateTimestamp: FieldValidator = (field, value) => {
  if (value === null || value === undefined || value === '') {
    return field.required ? 'Required' : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0
      ? null
      : 'Must be a non-negative epoch milliseconds value';
  }
  if (typeof value !== 'string') {
    return 'Must be an ISO 8601 timestamp or epoch milliseconds';
  }
  // Parse components explicitly. Date.parse silently rolls 2024-02-30
  // forward to 2024-03-01 — we reject impossible calendar dates here
  // by walking the components and gating month / day-in-month / hour
  // / minute / second ourselves.
  const m = TIMESTAMP_REGEX.exec(value);
  if (!m) {
    if (NAIVE_TIMESTAMP_REGEX.test(value)) {
      return 'Timestamp must include a timezone (Z or ±HH:MM)';
    }
    return 'Must be an ISO 8601 timestamp';
  }
  const [, yStr, moStr, dStr, hStr, miStr, sStr] = m;
  const y = Number(yStr);
  const mo = Number(moStr);
  const d = Number(dStr);
  const h = Number(hStr);
  const mi = Number(miStr);
  const s = sStr !== undefined ? Number(sStr) : 0;
  if (mo < 1 || mo > 12) return 'Month must be 01–12';
  // Day-in-month gate (handles Feb + leap years).
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d < 1 || d > dim) {
    return `Day must be ≤ ${dim} for that month`;
  }
  if (h > 23) return 'Hour must be 00–23';
  if (mi > 59) return 'Minute must be 00–59';
  if (s > 60) return 'Second must be 00–60'; // 60 → leap second
  return null;
};

const validateEnum: FieldValidator = (field, value) => {
  if (value === null || value === undefined || value === '') {
    return field.required ? 'Required' : null;
  }
  const allowed = field.enum_values ?? [];
  if (allowed.length === 0) return null; // open enum — accept anything
  if (typeof value !== 'string') {
    return `Must be one of ${allowed.join(', ')}`;
  }
  if (!allowed.includes(value)) {
    return `Must be one of ${allowed.join(', ')}`;
  }
  return null;
};

const validateRef: FieldValidator = (field, value) => {
  if (value === null || value === undefined || value === '') {
    return field.required ? 'Required' : null;
  }
  if (typeof value !== 'string') return 'Must be an entity id';
  if (value.trim() === '') return field.required ? 'Required' : null;
  return null;
};

const validateUuid: FieldValidator = (field, value) => {
  if (value === null || value === undefined || value === '') {
    return field.required ? 'Required' : null;
  }
  if (typeof value !== 'string') return 'Must be a uuid string';
  // Permissive shape: 32-hex with optional dashes. Substrate validates
  // structure; identity-correctness lives at storage write.
  const trimmed = value.trim();
  if (!/^[0-9a-f-]{32,36}$/i.test(trimmed)) {
    return 'Must be a uuid string';
  }
  return null;
};

const validateArray: FieldValidator = (field, value, hooks) => {
  if (value === null || value === undefined) {
    return field.required ? 'Required' : null;
  }
  if (!Array.isArray(value)) return 'Must be a list';
  if (field.required && value.length === 0) return 'Required';
  if (!field.item_type) return null; // unconstrained array — accept
  const itemField: FormField = {
    name: `${field.name}[]`,
    type: field.item_type,
    label: field.label,
    required: true,
    hidden: false,
    enum_values: field.item_enum_values,
    ref_target: field.ref_target,
    // Slice 2a — forward nested composition slots when the item type
    // is `object` / `discriminated_union`. Without these the inner
    // validator can't reach the sub-form definition. The
    // discriminant_field flows the OUTER field's override (defaults
    // to `'kind'`) so an array<discriminated_union> declared with
    // `discriminant_field: 'op'` validates with the same discriminant
    // key the renderer + reader use.
    ...(field.item_object_fields !== undefined
      ? { object_fields: field.item_object_fields }
      : {}),
    ...(field.item_variants !== undefined
      ? { variants: field.item_variants }
      : {}),
    ...(field.discriminant_field !== undefined
      ? { discriminant_field: field.discriminant_field }
      : {}),
    origin: field.origin,
  };
  for (let i = 0; i < value.length; i += 1) {
    // PB10 hook propagation — forward `hooks` so a nested array of
    // refs (`array<ref>` inside an object inside an array of objects)
    // fires `hooks.ref_exists` per item. The legacy top-level
    // `array<ref>` hook dispatch in `validateField` still runs for
    // top-level array<ref> fields — this propagation makes the same
    // check fire at every depth of composition.
    const err = validateField(itemField, value[i], hooks);
    if (err) return `Item ${i + 1}: ${err}`;
  }
  return null;
};

// ────────────────────────────────────────────────────────────────
// Slice 2a — composition primitives
// ────────────────────────────────────────────────────────────────
//
// PB10 follow-on (2026-05-28) — hook propagation lifted. The composite
// validators below thread `hooks` through their internal `validateField`
// recursion, so `ref` fields nested inside objects / variants / array
// items fire `hooks.ref_exists` the same way top-level `ref` fields do.
// This unblocks Conflicts queue (§ B.15.8) / Corrections (§ B.14) /
// D-149 application-variant forms that declare nested ref fields.
// Scalar validators still ignore `hooks` — pure-shape work needs no
// substrate-external checks; the registry's `FieldValidator` type
// admits the optional `hooks` arg by widening (`FieldValidator` carries
// `hooks?: ValidationHooks` since PB10), and the legacy 2-arg arrow
// declarations stay assignable.

/** Validate a `type: 'object'` value as a record of sub-field values.
 *  Recurses into `object_fields` against the value's keys; missing
 *  sub-fields drop through to each sub-field's `required` gate. */
const validateObject: FieldValidator = (field, value, hooks) => {
  if (value === null || value === undefined) {
    return field.required ? 'Required' : null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'Must be an object';
  }
  const subFields = field.object_fields ?? [];
  const subValues = value as Record<string, unknown>;
  for (const sub of subFields) {
    if (sub.show_if !== undefined && !evaluateShowIf(sub.show_if, subValues)) {
      continue;
    }
    const err = validateField(sub, subValues[sub.name], hooks);
    if (err) return `${sub.label}: ${err}`;
  }
  return null;
};

/** Validate a `type: 'discriminated_union'` value. The shape is
 *  `{ [discriminant_field]: kind, ...variant_fields }`. Reads the
 *  discriminant first; looks up the matching variant; recurses into
 *  the variant's fields. An unknown / missing discriminant value is
 *  reported as a closed-list violation.
 *
 *  An empty `variants` declaration is treated as a substrate
 *  configuration error rather than "accept any object" — the prior
 *  silent-accept path opened a defense-in-depth gap where a buggy
 *  / partially-migrated form definition would smuggle arbitrary
 *  uncontracted objects past validation. */
const validateDiscriminatedUnion: FieldValidator = (field, value, hooks) => {
  if (value === null || value === undefined) {
    return field.required ? 'Required' : null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return 'Must be an object';
  }
  const variants = field.variants ?? [];
  if (variants.length === 0) {
    return 'No variants declared (form schema misconfigured)';
  }
  const discriminantKey = field.discriminant_field ?? 'kind';
  const subValues = value as Record<string, unknown>;
  const kind = subValues[discriminantKey];
  if (typeof kind !== 'string' || kind.length === 0) {
    return `Required: ${discriminantKey}`;
  }
  const match = variants.find((v) => v.kind === kind);
  if (!match) {
    return `Must be one of ${variants.map((v) => v.kind).join(', ')}`;
  }
  for (const sub of match.fields) {
    if (sub.show_if !== undefined && !evaluateShowIf(sub.show_if, subValues)) {
      continue;
    }
    const err = validateField(sub, subValues[sub.name], hooks);
    if (err) return `${sub.label}: ${err}`;
  }
  return null;
};

/** Evaluate a `ShowIfCondition` against a values scope. Used by both
 *  validators (skip hidden fields) + renderer/read (paint with
 *  `data-form-hidden="true"`; read returns `undefined`). The four
 *  comparator clauses are ALL applied — combining them narrows the
 *  visibility window. Missing comparator clauses default to `true`. */
export const evaluateShowIf = (
  cond: ShowIfCondition,
  values: Readonly<Record<string, unknown>>,
): boolean => {
  const observed = values[cond.field];
  if (cond.equals !== undefined && !sameValue(observed, cond.equals)) {
    return false;
  }
  if (cond.not_equals !== undefined && sameValue(observed, cond.not_equals)) {
    return false;
  }
  if (cond.in !== undefined && !cond.in.some((v) => sameValue(observed, v))) {
    return false;
  }
  if (cond.not_in !== undefined && cond.not_in.some((v) => sameValue(observed, v))) {
    return false;
  }
  return true;
};

/** Strict equality with NaN-safe semantics (mirrors `Object.is` for
 *  scalars; non-strict deep equality is intentionally out of scope —
 *  show_if drives off scalar comparisons against closed-list values). */
const sameValue = (a: unknown, b: unknown): boolean => Object.is(a, b);

/** Exported for callers that need the variant lookup without
 *  duplicating the discriminant resolution logic (renderer + reader
 *  both need it). Returns the matching variant or `null` for unknown
 *  / missing discriminants. */
export const resolveDiscriminatedVariant = (
  field: FormField,
  values: Readonly<Record<string, unknown>>,
): DiscriminatedUnionVariant | null => {
  const variants = field.variants ?? [];
  if (variants.length === 0) return null;
  const discriminantKey = field.discriminant_field ?? 'kind';
  const kind = values[discriminantKey];
  if (typeof kind !== 'string') return null;
  return variants.find((v) => v.kind === kind) ?? null;
};

/** Built-in validator registry — keyed on `FormFieldType`. The
 *  `validateField` entry point dispatches through this map. */
export const BUILTIN_VALIDATORS: Readonly<
  Record<FormField['type'], FieldValidator>
> = {
  text: validateText,
  textarea: validateTextarea,
  number: validateNumber,
  boolean: validateBoolean,
  date: validateDate,
  timestamp: validateTimestamp,
  enum: validateEnum,
  ref: validateRef,
  uuid: validateUuid,
  array: validateArray,
  object: validateObject,
  discriminated_union: validateDiscriminatedUnion,
};

// ────────────────────────────────────────────────────────────────
// Composite entry points
// ────────────────────────────────────────────────────────────────

/** Validate a single field. Auto fields (`hidden: true`) are skipped
 *  — storage owns the value. Hooks (`ref_exists` etc.) ride after the
 *  pure validator passes; scalar built-in validators stay hook-free so
 *  the registry surface is testable in isolation. Composite validators
 *  (`object` / `discriminated_union` / `array`) receive `hooks` at
 *  dispatch time so their internal `validateField` recursion threads
 *  the hook into every nested field (PB10 follow-on). The top-level
 *  `ref` hook dispatch below remains the single source-of-truth call
 *  site for `hooks.ref_exists`; composite recursion just reaches it
 *  at every depth. The legacy `array<ref>` dispatch retired in PB10
 *  because `validateArray` now hook-recurses per item, hitting the
 *  same `ref` dispatch via the recursion — double-application avoided. */
export const validateField = (
  field: FormField,
  value: unknown,
  hooks?: ValidationHooks,
): string | null => {
  if (field.hidden) return null;
  const baseValidator = BUILTIN_VALIDATORS[field.type];
  const baseErr = baseValidator(field, value, hooks);
  if (baseErr) return baseErr;
  if (
    field.type === 'ref' &&
    hooks?.ref_exists &&
    field.ref_target &&
    value !== null &&
    value !== undefined &&
    value !== ''
  ) {
    if (!hooks.ref_exists(field.ref_target, value)) {
      return 'Entity not found';
    }
  }
  return null;
};

/** Validate every field in a form. Returns the (possibly empty) error
 *  list keyed by field name. Auto fields are skipped. Slice 2a — also
 *  skips fields whose `show_if` evaluates to false against the values
 *  scope (so a partial submission doesn't fail on a Required field the
 *  user never saw). */
export const validateForm = (
  definition: FormDefinition,
  values: Record<string, unknown>,
  hooks?: ValidationHooks,
): FieldValidationError[] => {
  const errors: FieldValidationError[] = [];
  for (const field of definition.fields) {
    if (field.hidden) continue;
    if (field.show_if !== undefined && !evaluateShowIf(field.show_if, values)) {
      continue;
    }
    const err = validateField(field, values[field.name], hooks);
    if (err) errors.push({ field: field.name, message: err });
  }
  return errors;
};
