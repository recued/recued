/** D-145 PA5 — form renderer substrate, contract-side types.
 *
 *  Substrate exists at `packages/ui-shared/form-renderer/` (rendering)
 *  + `packages/contracts/src/form-renderer/` (types, generators,
 *  validators — pure logic). The two halves form one substrate; this
 *  file lives in contracts so server-side validation, recipe-install
 *  preflights, and the future D-149 reception intake-form gate can
 *  validate without dragging a DOM dependency in.
 *
 *  The form-renderer is shared substrate across (per § A.3.2):
 *    1. Recipe config UI (PA5 ships substrate; recipe-config migration
 *       is post-PA5 follow-up).
 *    2. Top_tier_kind create / edit forms (task / note / commitment /
 *       project — wired in PA6).
 *    3. Email compose surface (mail_message canonical schema — PA7).
 *    4. Calendar event create.
 *    5. AI chat about-to-create confirmations.
 *    6. Future top_tier_kind UIs.
 *    7. D-149 Public Reception intake_form endpoint kind.
 *    8. Slice 2 — D-145 § B.11.7 Standing Instructions edit form
 *       (drives the Slice 2a substrate widening below).
 *
 *  The typed-input registry — initial PA5 set plus the Slice 2a
 *  composition primitives:
 *    text / textarea / number / boolean / date / timestamp / enum /
 *    ref / array / uuid / object / discriminated_union.
 *
 *  Spec: D-145 § A.3. */

import type { CanonicalFieldType } from '../canonical-schemas/index.js';

/** Slice 2a composition primitives — used by the form-renderer's
 *  variant + nested-object paths. Kept separate from `CanonicalFieldType`
 *  so storage-backed canonical schemas stay flat (the four work
 *  entities + mail_message are all top-level records, never nested
 *  trees); the form-renderer supports both flat canonical entities AND
 *  the richer nested shapes Standing Instructions / Conflicts queue /
 *  Corrections / D-149 application-variant forms author. */
export type FormCompositionFieldType = 'object' | 'discriminated_union';

/** Closed list of typed inputs. Superset of `CanonicalFieldType` —
 *  every canonical type renders, plus the two Slice 2a composition
 *  primitives. `formFromCanonicalSchema` is unaffected because the
 *  canonical→form mapping only emits canonical types; the new types
 *  are reachable only through hand-authored `FormDefinition`s. */
export type FormFieldType = CanonicalFieldType | FormCompositionFieldType;

/** Closed list constant for iteration / runtime gates. The two
 *  composition entries trail the canonical set so existing snapshot
 *  tests / printable order keep a stable prefix. */
export const FORM_FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'boolean',
  'date',
  'timestamp',
  'enum',
  'ref',
  'array',
  'uuid',
  'object',
  'discriminated_union',
] as const satisfies readonly FormFieldType[];

export const isFormFieldType = (s: unknown): s is FormFieldType =>
  typeof s === 'string' &&
  (FORM_FIELD_TYPES as readonly string[]).includes(s);

/** Where a field originated. Canonical fields come from a Recued
 *  schema (PA1); extension fields ride alongside via an attached
 *  Source extension blob (HubSpot tasks, etc.). The renderer can use
 *  this to group / collapse / annotate non-canonical inputs. */
export type FormFieldOrigin = 'canonical' | 'extension';

/** A single variant inside a `discriminated_union` field — one entry
 *  per closed-list `kind` value. The user picks the variant via the
 *  rendered `<select>`; the variant's `fields` describe the per-kind
 *  sub-form. Variants are flat field lists; recursive shapes (e.g. SI
 *  conditions with `all`/`any` combinators containing more conditions)
 *  are expressed by giving the recursive variant a field whose type is
 *  `discriminated_union` again — the schema author "ties the knot"
 *  via TypeScript mutual recursion or programmatic tree construction.
 *
 *  Slice 2a § A.3.1 — composition primitive. */
export interface DiscriminatedUnionVariant {
  /** Discriminator value. Closed list — appears verbatim in the
   *  rendered `<select>`'s `<option value>`. The read path emits this
   *  as the discriminant field's value (default field name is `kind`;
   *  override via the parent `FormField.discriminant_field`). */
  kind: string;
  /** Human-readable picker label. Renderer escapes before insertion. */
  label: string;
  /** Per-variant sub-form. May be empty (some variants — e.g. SI's
   *  `require_approval` action — carry only the discriminant). */
  fields: readonly FormField[];
}

/** Declarative conditional-visibility gate. Evaluated against the
 *  current values map at render time + at read time; a field whose
 *  `show_if` evaluates to `false` renders with `data-form-hidden="true"`
 *  + is read back as `undefined` (so partial submissions don't smuggle
 *  stale values for fields the user never saw).
 *
 *  The gate keys off a SIBLING field by name — same-level or
 *  parent-level resolution is left to the consumer (the renderer
 *  walks values local to the current scope). Cross-form gates are
 *  out of scope; complex conditions compose via multiple sibling
 *  fields rather than nested gates.
 *
 *  Slice 2a § A.3.1 — composition primitive. */
export interface ShowIfCondition {
  /** Sibling field whose value drives visibility. Resolved against
   *  the current scope's values map (the parent `object_fields` for
   *  fields inside an object, the parent `variants[].fields` for
   *  fields inside a discriminated_union variant, or the top-level
   *  form for top-level fields). */
  field: string;
  /** Visibility is `true` when the sibling's value `=== equals`. */
  equals?: unknown;
  /** Visibility is `true` when the sibling's value `!== not_equals`. */
  not_equals?: unknown;
  /** Visibility is `true` when the sibling's value is in `in`. */
  in?: readonly unknown[];
  /** Visibility is `true` when the sibling's value is NOT in `not_in`. */
  not_in?: readonly unknown[];
}

/** A single form field — everything the renderer needs to draw one
 *  input. Slice 2a widens the shape with optional composition fields
 *  (`object_fields`, `variants`, `discriminant_field`, `show_if`, +
 *  matching `item_*` slots for nested-content arrays). Existing flat
 *  canonical-schema → form mapping is unchanged — the new fields are
 *  all optional. */
export interface FormField {
  name: string;
  type: FormFieldType;
  label: string;
  /** Inverse of `CanonicalField.nullable`. Auto-populated fields are
   *  forced to `false` because storage owns the value. */
  required: boolean;
  /** Auto-populated fields aren't user-editable. The renderer hides
   *  them by default; tests / debug surfaces may opt in. */
  hidden: boolean;
  enum_values?: readonly string[];
  /** Cardinality discriminator for `type: 'array'`. */
  item_type?: FormFieldType;
  /** Closed list for nested enum-of-* array items. */
  item_enum_values?: readonly string[];
  /** Sub-form for `type: 'array'` with `item_type: 'object'`. Slice 2a. */
  item_object_fields?: readonly FormField[];
  /** Variant list for `type: 'array'` with `item_type: 'discriminated_union'`.
   *  Slice 2a. */
  item_variants?: readonly DiscriminatedUnionVariant[];
  /** Sub-form for `type: 'object'`. Slice 2a — every object field
   *  declares its own nested fields here. */
  object_fields?: readonly FormField[];
  /** Variant list for `type: 'discriminated_union'`. Slice 2a. */
  variants?: readonly DiscriminatedUnionVariant[];
  /** Name of the discriminator field within a `discriminated_union`'s
   *  read-out shape. Defaults to `'kind'`. The renderer auto-renders
   *  the discriminant as a `<select>` keyed on this name + the read
   *  path emits `{ [discriminant_field]: variant.kind, ...variant_fields }`.
   *  Slice 2a. */
  discriminant_field?: string;
  /** PB10 follow-on (2026-05-28) — lazy-expansion variant body
   *  affordance. When true on a `type: 'discriminated_union'` field OR
   *  a `type: 'array'` field with `item_type: 'discriminated_union'`,
   *  the renderer emits ONLY the active variant body. Inactive variants
   *  still appear as `<option>` entries in the kind `<select>`, but
   *  their bodies stay out of the DOM until the user picks them via
   *  the select (mount layer re-paints on union-select change). Default
   *  false — eager rendering (all bodies in DOM, CSS hides inactive
   *  ones) stays the registry's baseline. Lazy mode unblocks unbounded
   *  recursive union trees (e.g. SI conditions where `all` / `any` /
   *  `not` combinators reference the same depth-N variant list — eager
   *  rendering blows up as O(7^N) HTML; lazy emits only the active path
   *  for O(N) HTML). */
  lazy_variants?: boolean;
  /** Target of a `type: 'ref'` field — e.g. `data.contact`,
   *  `data.task`. The host app resolves typeahead via a registered
   *  `RefLookupAdapter` (PA5 ships the contract; PA6 wires Source
   *  resolvers).  */
  ref_target?: string;
  /** Inclusive upper bound for `text` (other types ignore). */
  max_length?: number;
  /** Regex pattern for `type: 'text'` or `type: 'textarea'`. Surface
   *  is `RegExp.source` (no flags); validators run `new RegExp(pattern)`
   *  at check time. § A.3.1 — text: length, pattern. */
  pattern?: string;
  /** Inclusive lower bound for `type: 'number'`. § A.3.1 — number:
   *  min/max/integer. */
  min?: number;
  /** Inclusive upper bound for `type: 'number'`. */
  max?: number;
  /** When true, `type: 'number'` must be integer. */
  integer?: boolean;
  /** Default value, expressed as the typed-input's resolved JS shape.
   *  `undefined` means no default — the field renders empty. */
  default?: unknown;
  /** Conditional visibility gate. When evaluation returns `false`,
   *  the field is rendered hidden + read back as `undefined`. Slice 2a. */
  show_if?: ShowIfCondition;
  /** Free-form description. Renderer escapes before insertion. */
  description?: string;
  /** Provenance tag. Extensions may render with a chip / tooltip. */
  origin: FormFieldOrigin;
}

/** A form definition — what the renderer consumes. `kind` is the
 *  identifier (typically a `WorkEntityKind` like `task`, but the form
 *  renderer is generic and accepts any string). */
export interface FormDefinition {
  kind: string;
  fields: readonly FormField[];
}

/** A field-level validation error. Multiple errors per submit are
 *  surfaced as an array; the renderer paints them inline. */
export interface FieldValidationError {
  field: string;
  message: string;
}

/** Per-type validator. Returns `null` if the value passes; else an
 *  error message. Built-in validators are pluggable per-type via
 *  `validateField(field, value, hooks?)`; callers may pass
 *  `ref_exists` / `enum_extra` hooks for substrate-external checks.
 *
 *  PB10 hook propagation — scalar validators ignore `hooks` (their
 *  pure-shape work doesn't need substrate-external checks), but
 *  composite validators (`validateObject`, `validateDiscriminatedUnion`,
 *  `validateArray`) thread `hooks` through their internal
 *  `validateField` recursion so nested `ref` fields and nested
 *  `array<ref>` fields fire `hooks.ref_exists` the same way top-level
 *  fields do. */
export type FieldValidator = (
  field: FormField,
  value: unknown,
  hooks?: ValidationHooks,
) => string | null;

/** Validation hooks — substrate-external checks the validator can't
 *  perform (e.g. `ref_exists` requires a DB lookup). All hooks are
 *  optional; missing hook = skip the check (the validator only
 *  enforces what it can). */
export interface ValidationHooks {
  /** Verify a `ref` value points at an entity that exists + is
   *  accessible. Sync because pure validators run pre-render; async
   *  ref-existence checks happen in a separate pass keyed off this
   *  hook's positive result.  */
  ref_exists?: (target: string, id: unknown) => boolean;
}

/** A Source extension schema — the union of canonical + extension
 *  fields for non-Recued Sources (HubSpot task extras, etc.).
 *
 *  Constraint: extension fields whose name collides with a canonical
 *  field are dropped silently. Canonical wins on collision so Recued
 *  semantics stay consistent across Sources; extensions can only
 *  ADD fields, never override. */
export interface SourceExtensionField {
  name: string;
  type: FormFieldType;
  nullable?: boolean;
  enum_values?: readonly string[];
  item_type?: FormFieldType;
  item_enum_values?: readonly string[];
  ref_target?: string;
  max_length?: number;
  /** Regex pattern for `type: 'text'` or `type: 'textarea'`. */
  pattern?: string;
  /** Inclusive lower bound for `type: 'number'`. */
  min?: number;
  /** Inclusive upper bound for `type: 'number'`. */
  max?: number;
  /** When true, `type: 'number'` must be integer. */
  integer?: boolean;
  default?: unknown;
  description?: string;
  /** Display label override; falls back to humanized `name`. */
  label?: string;
}

export interface SourceExtensionSchema {
  fields: readonly SourceExtensionField[];
}
