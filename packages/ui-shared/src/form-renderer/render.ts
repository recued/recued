/** D-145 PA5 — form renderer (HTML strings).
 *
 *  Consumes `FormDefinition` from `@recued/contracts/form-renderer`
 *  and emits HTML strings the host app injects via `innerHTML`. Each
 *  field carries `data-form-field="<name>"` + `data-form-type="<type>"`
 *  for delegated event handling. The host app reads back via
 *  `readFormValues(root, definition)` (see `read.ts`).
 *
 *  XSS posture: every interpolated string flows through `escapeHtml`.
 *  See `template.ts` for the central rule.
 *
 *  Spec: docs/d-145-spec.md § A.3.
 */

import {
  evaluateShowIf,
  type DiscriminatedUnionVariant,
  type FormDefinition,
  type FormField,
} from '@recued/contracts';
import { e } from '../template.js';
import { initialRefPickerState } from '../ref-picker/model.js';
import { renderRefPicker } from '../ref-picker/render.js';

export interface FormRenderOptions {
  /** Initial values keyed by field name. Missing keys fall back to
   *  the field's `default`. `undefined` means "use the field default
   *  (or empty)"; `null` means "explicitly empty" — passed through. */
  values?: Readonly<Record<string, unknown>>;
  /** Inline error map keyed by field name. When present, the row is
   *  rendered with the error message + `aria-invalid="true"` on the
   *  input. The renderer does not validate — callers run
   *  `validateForm` and feed the result here. */
  errors?: Readonly<Record<string, string>>;
  /** Show hidden / auto fields (UUID id columns, auto-stamped
   *  timestamps). Default `false` — auto fields stay invisible.
   *  Tests / debug surfaces opt in. */
  showHidden?: boolean;
  /** Render `ref` / `array<ref>` fields as a live name→id picker shell
   *  (a `renderRefPicker` combobox with a hidden id mirror) instead of
   *  the raw-id `<input>`. Default `false` — only hosts that ATTACH the
   *  picker after render (via `wireRefPicker`) opt in, since an unwired
   *  shell reads back only what its mirror was seeded with. The
   *  work-entity dialog (data route) is the sole consumer today. */
  refPicker?: boolean;
}

/** Render a full form definition as an HTML string. */
export const renderForm = (
  definition: FormDefinition,
  options: FormRenderOptions = {},
): string => {
  const rows = definition.fields
    .map((field) => renderField(field, options))
    .join('');
  return `<div class="form-renderer-form" data-form-kind="${e(definition.kind)}">${rows}</div>`;
};

/** Render a single field. Public so callers can compose forms with
 *  custom layout (e.g. tabs, sections) without re-implementing per-
 *  type rendering.
 *
 *  Slice 2a — `options.values` is consulted for `show_if` evaluation
 *  in two places: (a) the top-level form (values map is the whole
 *  form's state); (b) nested object / variant sub-forms (the scoped
 *  values map is the sub-form's view of state — see `renderObject`
 *  / `renderDiscriminatedUnion`). Fields whose `show_if` evaluates
 *  to `false` render with `data-form-hidden="true"` + are read back
 *  as `undefined` so a partial submission doesn't smuggle stale
 *  values for fields the user never saw. */
export const renderField = (
  field: FormField,
  options: FormRenderOptions = {},
): string => {
  const value = pickFieldValue(field, options.values);
  const error = options.errors?.[field.name];
  const showHidden = options.showHidden === true;
  const showIfHidden =
    field.show_if !== undefined
    && !evaluateShowIf(field.show_if, options.values ?? {});
  const hidden = (field.hidden && !showHidden) || showIfHidden;
  return wrapRow(field, hidden, error, () =>
    renderInput(field, value, options),
  );
};

const wrapRow = (
  field: FormField,
  hidden: boolean,
  error: string | undefined,
  innerFn: () => string,
): string => {
  const inline = field.type === 'boolean';
  const labelHtml = renderLabel(field);
  const helpHtml = field.description
    ? `<p class="form-renderer-help">${e(field.description)}</p>`
    : '';
  const errorHtml = error
    ? `<p class="form-renderer-error" role="alert">${e(error)}</p>`
    : '';
  const inner = innerFn();
  const inlineAttr = inline ? ' data-form-row-inline="true"' : '';
  const hiddenAttr = hidden ? ' data-form-hidden="true"' : '';
  if (inline) {
    return `
      <div
        class="form-renderer-row"
        data-form-row="${e(field.name)}"${inlineAttr}${hiddenAttr}
      >
        ${inner}
        ${labelHtml}
        ${helpHtml}
        ${errorHtml}
      </div>
    `;
  }
  return `
    <div
      class="form-renderer-row"
      data-form-row="${e(field.name)}"${hiddenAttr}
    >
      ${labelHtml}
      ${helpHtml}
      ${inner}
      ${errorHtml}
    </div>
  `;
};

const renderLabel = (field: FormField): string => {
  const required = field.required
    ? '<span class="form-renderer-required" aria-hidden="true">*</span>'
    : '';
  const originChip =
    field.origin === 'extension'
      ? '<span class="form-renderer-origin-chip">extension</span>'
      : '';
  return `<label class="form-renderer-label" for="form-renderer-${e(field.name)}">${e(field.label)}${required}${originChip}</label>`;
};

const renderInput = (
  field: FormField,
  value: unknown,
  options: FormRenderOptions,
): string => {
  switch (field.type) {
    case 'text':
      return renderTextInput(field, value);
    case 'textarea':
      return renderTextarea(field, value);
    case 'number':
      return renderNumberInput(field, value);
    case 'boolean':
      return renderCheckbox(field, value);
    case 'date':
      return renderDateInput(field, value);
    case 'timestamp':
      return renderTimestampInput(field, value);
    case 'enum':
      return renderSelect(field, value);
    case 'ref':
      return renderRefInput(field, value, options);
    case 'uuid':
      return renderUuidInput(field, value);
    case 'array':
      return renderArray(field, value, options);
    case 'object':
      return renderObject(field, value, options);
    case 'discriminated_union':
      return renderDiscriminatedUnion(field, value, options);
  }
};

const renderTextInput = (field: FormField, value: unknown): string => {
  const display = stringValue(value);
  const max = field.max_length !== undefined ? ` maxlength="${field.max_length}"` : '';
  const pattern = field.pattern !== undefined ? ` pattern="${e(field.pattern)}"` : '';
  return `<input
    id="form-renderer-${e(field.name)}"
    class="form-renderer-input"
    type="text"
    data-form-field="${e(field.name)}"
    data-form-type="text"
    value="${e(display)}"${max}${pattern}
  />`;
};

const renderTextarea = (field: FormField, value: unknown): string => {
  const display = stringValue(value);
  const max = field.max_length !== undefined ? ` maxlength="${field.max_length}"` : '';
  return `<textarea
    id="form-renderer-${e(field.name)}"
    class="form-renderer-textarea"
    data-form-field="${e(field.name)}"
    data-form-type="textarea"${max}
  >${e(display)}</textarea>`;
};

const renderNumberInput = (field: FormField, value: unknown): string => {
  const display =
    value === undefined || value === null || value === ''
      ? ''
      : String(value);
  const min = field.min !== undefined ? ` min="${field.min}"` : '';
  const max = field.max !== undefined ? ` max="${field.max}"` : '';
  const step = field.integer === true ? ' step="1"' : '';
  return `<input
    id="form-renderer-${e(field.name)}"
    class="form-renderer-input"
    type="number"
    data-form-field="${e(field.name)}"
    data-form-type="number"
    value="${e(display)}"${min}${max}${step}
  />`;
};

const renderCheckbox = (field: FormField, value: unknown): string => {
  const checked = value === true;
  return `<input
    id="form-renderer-${e(field.name)}"
    class="form-renderer-input"
    type="checkbox"
    data-form-field="${e(field.name)}"
    data-form-type="boolean"
    ${checked ? 'checked' : ''}
  />`;
};

const renderDateInput = (field: FormField, value: unknown): string => {
  const display = stringValue(value);
  return `<input
    id="form-renderer-${e(field.name)}"
    class="form-renderer-input"
    type="date"
    data-form-field="${e(field.name)}"
    data-form-type="date"
    value="${e(display)}"
  />`;
};

/** Timestamp input — uses native `datetime-local` for ergonomics; the
 *  read path stamps the user's offset on retrieval (see `read.ts`).
 *  The pre-fill format is `YYYY-MM-DDTHH:MM` (sliced from a stored
 *  ISO string). The read path emits a TZ-explicit ISO string. */
const renderTimestampInput = (field: FormField, value: unknown): string => {
  const display = formatTimestampForInput(value);
  return `<input
    id="form-renderer-${e(field.name)}"
    class="form-renderer-input"
    type="datetime-local"
    data-form-field="${e(field.name)}"
    data-form-type="timestamp"
    value="${e(display)}"
  />`;
};

const renderSelect = (field: FormField, value: unknown): string => {
  const allowed = field.enum_values ?? [];
  const selected = stringValue(value);
  const placeholderOption = field.required
    ? ''
    : `<option value="" ${selected === '' ? 'selected' : ''}>—</option>`;
  const options = allowed
    .map(
      (opt) =>
        `<option value="${e(opt)}" ${opt === selected ? 'selected' : ''}>${e(opt)}</option>`,
    )
    .join('');
  return `<select
    id="form-renderer-${e(field.name)}"
    class="form-renderer-select"
    data-form-field="${e(field.name)}"
    data-form-type="enum"
  >${placeholderOption}${options}</select>`;
};

/** Only `data.contact` refs become live pickers — that's the one
 *  inventory the host (data route) knows how to search. Any other
 *  `ref_target` (none exist today) safely falls back to the raw-id
 *  input rather than a wrongly-wired contact picker. */
const CONTACT_REF_TARGET = 'data.contact';

const renderRefInput = (
  field: FormField,
  value: unknown,
  options: FormRenderOptions,
): string => {
  if (options.refPicker === true && field.ref_target === CONTACT_REF_TARGET) {
    return renderRefPicker(refPickerSeedState(value), {
      pickerId: refPickerFieldId(field.name),
      placeholder: 'Search contacts…',
      ariaLabel: field.label,
      formFieldName: field.name,
    });
  }
  const display = stringValue(value);
  const target = field.ref_target ?? '';
  return `<input
    id="form-renderer-${e(field.name)}"
    class="form-renderer-input"
    type="text"
    data-form-field="${e(field.name)}"
    data-form-type="ref"
    data-form-ref-target="${e(target)}"
    value="${e(display)}"
    autocomplete="off"
    spellcheck="false"
  />`;
};

/** Stable per-field picker id (single ref) / per-item id (array ref).
 *  The host finds shells by `[data-ref-picker]` and reads this id off
 *  the element, so it only needs to be unique within one rendered form. */
const refPickerFieldId = (name: string): string => `form-ref-${name}`;
const refPickerArrayItemId = (name: string, index: number): string =>
  `form-ref-${name}-${index}`;

/** Seed the picker's resting state from the stored id. We have only the
 *  id (an email for `data.contact`), so the label falls back to the id —
 *  the host upgrades the display to a resolved name via `wireRefPicker`'s
 *  `initialValue` when it can; an unwired shell shows the email. */
const refPickerSeedState = (value: unknown) => {
  const id = stringValue(value);
  return id === '' ? initialRefPickerState() : initialRefPickerState({ id, label: id });
};

const renderUuidInput = (field: FormField, value: unknown): string => {
  const display = stringValue(value);
  return `<input
    id="form-renderer-${e(field.name)}"
    type="hidden"
    data-form-field="${e(field.name)}"
    data-form-type="uuid"
    value="${e(display)}"
  />`;
};

const renderArray = (
  field: FormField,
  value: unknown,
  options: FormRenderOptions,
): string => {
  const items = Array.isArray(value) ? value : [];
  const itemType = field.item_type;
  const refTarget = field.ref_target ?? '';
  const itemEnumValues = field.item_enum_values;
  const itemRows = items
    .map((item, index) =>
      renderArrayItem(
        field,
        itemType,
        refTarget,
        itemEnumValues,
        item,
        index,
        options,
      ),
    )
    .join('');
  const empty =
    items.length === 0
      ? `<div class="form-renderer-array-empty">No entries.</div>`
      : '';
  return `<div
    class="form-renderer-array"
    data-form-field="${e(field.name)}"
    data-form-type="array"
    data-form-item-type="${e(itemType ?? 'text')}"${refTarget ? ` data-form-ref-target="${e(refTarget)}"` : ''}
  >
    ${itemRows}
    ${empty}
    <button
      type="button"
      class="form-renderer-array-add"
      data-form-array-add="${e(field.name)}"
    >Add</button>
  </div>`;
};

const renderArrayItem = (
  field: FormField,
  itemType: FormField['type'] | undefined,
  refTarget: string,
  itemEnumValues: readonly string[] | undefined,
  value: unknown,
  index: number,
  options: FormRenderOptions,
): string => {
  // Slice 2a — nested-content items render via the composite paths
  // (`renderObject` / `renderDiscriminatedUnion`) so the same `data-
  // form-object-scope` / `data-form-union-scope` discipline applies
  // inside arrays. Each item carries the array context via
  // `data-form-array-item="<field>"` + `data-form-array-index="<n>"`
  // on the wrapper; the inner sub-form is keyed by the array index
  // so the read path can reassemble by index.
  if (itemType === 'object') {
    const subFields = field.item_object_fields ?? [];
    const subValues = isRecord(value) ? value : {};
    const subHtml = renderFieldGroup(subFields, subValues, options);
    return `<div
      class="form-renderer-array-item form-renderer-array-item-composite"
      data-form-array-item="${e(field.name)}"
      data-form-array-index="${index}"
      data-form-type="object"
    >
      <div class="form-renderer-object-scope" data-form-object-scope="${e(field.name)}">${subHtml}</div>
      <button
        type="button"
        class="form-renderer-array-remove"
        data-form-array-remove="${e(field.name)}"
        data-form-array-index="${index}"
      >Remove</button>
    </div>`;
  }
  if (itemType === 'discriminated_union') {
    const variants = field.item_variants ?? [];
    const discriminantKey = field.discriminant_field ?? 'kind';
    const subValues = isRecord(value) ? value : {};
    // PB10 follow-on — `lazy_variants` on the array field applies to
    // every item's union body, so deep array<discriminated_union>
    // trees (e.g. SI's combinator inner conditions) emit O(items)
    // active bodies instead of O(items × variants × subtree). The
    // mount layer's union-select change-listener re-paints when the
    // user picks a new kind in any item, swapping its body in.
    const unionHtml = renderUnionBody(
      field.name,
      variants,
      discriminantKey,
      subValues,
      options,
      field.lazy_variants === true,
    );
    return `<div
      class="form-renderer-array-item form-renderer-array-item-composite"
      data-form-array-item="${e(field.name)}"
      data-form-array-index="${index}"
      data-form-type="discriminated_union"
    >
      ${unionHtml}
      <button
        type="button"
        class="form-renderer-array-remove"
        data-form-array-remove="${e(field.name)}"
        data-form-array-index="${index}"
      >Remove</button>
    </div>`;
  }
  const display = stringValue(value);
  let inputHtml = '';
  if (itemType === 'enum') {
    const allowed = itemEnumValues ?? [];
    const selected = display;
    const options = allowed
      .map(
        (opt) =>
          `<option value="${e(opt)}" ${opt === selected ? 'selected' : ''}>${e(opt)}</option>`,
      )
      .join('');
    inputHtml = `<select
      class="form-renderer-select"
      data-form-array-item="${e(field.name)}"
      data-form-array-index="${index}"
      data-form-type="enum"
    >${options}</select>`;
  } else if (itemType === 'ref') {
    inputHtml = options.refPicker === true && refTarget === CONTACT_REF_TARGET
      ? renderRefPicker(refPickerSeedState(value), {
          pickerId: refPickerArrayItemId(field.name, index),
          placeholder: 'Search contacts…',
          ariaLabel: field.label,
          arrayMirror: { field: field.name, index },
        })
      : `<input
      class="form-renderer-input"
      type="text"
      data-form-array-item="${e(field.name)}"
      data-form-array-index="${index}"
      data-form-type="ref"
      data-form-ref-target="${e(refTarget)}"
      value="${e(display)}"
      autocomplete="off"
      spellcheck="false"
    />`;
  } else if (itemType === 'number') {
    inputHtml = `<input
      class="form-renderer-input"
      type="number"
      data-form-array-item="${e(field.name)}"
      data-form-array-index="${index}"
      data-form-type="number"
      value="${e(display)}"
    />`;
  } else {
    inputHtml = `<input
      class="form-renderer-input"
      type="text"
      data-form-array-item="${e(field.name)}"
      data-form-array-index="${index}"
      data-form-type="${e(itemType ?? 'text')}"
      value="${e(display)}"
    />`;
  }
  return `<div class="form-renderer-array-item">
    ${inputHtml}
    <button
      type="button"
      class="form-renderer-array-remove"
      data-form-array-remove="${e(field.name)}"
      data-form-array-index="${index}"
    >Remove</button>
  </div>`;
};

// ────────────────────────────────────────────────────────────────
// Slice 2a — composition primitives
// ────────────────────────────────────────────────────────────────

/** Render a `type: 'object'` field as a nested scope containing each
 *  sub-field. The wrapper carries `data-form-object-scope="<name>"`
 *  so the read path walks parent→child rather than flat
 *  `data-form-field` (which would collide on duplicate sub-field
 *  names across sibling objects). */
const renderObject = (
  field: FormField,
  value: unknown,
  options: FormRenderOptions,
): string => {
  const subFields = field.object_fields ?? [];
  const subValues = isRecord(value) ? value : {};
  const inner = renderFieldGroup(subFields, subValues, options);
  return `<div
    class="form-renderer-object"
    data-form-field="${e(field.name)}"
    data-form-type="object"
  >
    <div class="form-renderer-object-scope" data-form-object-scope="${e(field.name)}">${inner}</div>
  </div>`;
};

/** Render a `type: 'discriminated_union'` field: a kind picker
 *  followed by every variant's sub-form. Only the active variant
 *  carries `data-form-variant-active="true"`; the host CSS hides the
 *  rest (see `styles.ts`). The active variant is derived from the
 *  current value's discriminant key (defaults to `kind`); when the
 *  current value has no kind, the first variant is active.
 *
 *  PB10 follow-on — when `field.lazy_variants === true`, only the
 *  active variant body is emitted; inactive variant bodies stay out
 *  of the DOM until the user picks them via the kind select (the
 *  mount layer re-paints on union-select change). */
const renderDiscriminatedUnion = (
  field: FormField,
  value: unknown,
  options: FormRenderOptions,
): string => {
  const variants = field.variants ?? [];
  const discriminantKey = field.discriminant_field ?? 'kind';
  const subValues = isRecord(value) ? value : {};
  const inner = renderUnionBody(
    field.name,
    variants,
    discriminantKey,
    subValues,
    options,
    field.lazy_variants === true,
  );
  return `<div
    class="form-renderer-union"
    data-form-field="${e(field.name)}"
    data-form-type="discriminated_union"
    data-form-discriminant-field="${e(discriminantKey)}"${field.lazy_variants === true ? ' data-form-lazy-variants="true"' : ''}
  >
    ${inner}
  </div>`;
};

/** Shared body builder for top-level and in-array discriminated_union
 *  rendering. Emits the discriminant `<select>` + one variant body
 *  per declared variant, with the active variant flagged. When the
 *  observed discriminant value doesn't match any declared variant,
 *  the wrapper carries `data-form-union-unknown-kind="<observed>"`
 *  so the host can surface a warning chip; the variant-select
 *  prepends an "Unrecognized kind — pick one" placeholder option
 *  with the original value preserved as its `value` attribute. This
 *  way a Save / Read won't silently rewrite an unknown kind to the
 *  first declared variant — the user must pick one explicitly.
 *
 *  PB10 follow-on — `lazyVariants` switches the body emission from
 *  "all variants in DOM, CSS hides inactive ones" to "only active
 *  variant body in DOM". Used by `discriminated_union` /
 *  `array<discriminated_union>` fields that declare `lazy_variants:
 *  true` to bound HTML for unbounded-recursion union trees. The
 *  mount layer fires a re-paint on union-select change so the new
 *  variant body renders; the read path still queries the active
 *  body via `[data-form-union-scope][data-form-union-variant=<kind>]`,
 *  matches it when the body is present, and falls back to
 *  `{ [discriminantKey]: kind }` when the body is absent (which
 *  in the lazy mode can only happen mid-flight before the mount
 *  layer's re-paint — but the change-listener fires synchronously
 *  on every kind switch so any subsequent `readFormValues` sees
 *  the new body). */
const renderUnionBody = (
  fieldName: string,
  variants: ReadonlyArray<DiscriminatedUnionVariant>,
  discriminantKey: string,
  values: Readonly<Record<string, unknown>>,
  options: FormRenderOptions,
  lazyVariants: boolean,
): string => {
  if (variants.length === 0) {
    return `<div class="form-renderer-union-empty">No variants declared.</div>`;
  }
  const observed = values[discriminantKey];
  const observedKind = typeof observed === 'string' ? observed : '';
  const match = variants.find((v) => v.kind === observedKind);
  const unknownKind = observedKind !== '' && match === undefined ? observedKind : null;
  // Active kind defaults to first declared variant for cold-start
  // forms (no observed value). For unknown observed kinds, the
  // notice below + the `unknown_kind` placeholder option block the
  // silent-rewrite path: the user must pick a declared variant
  // before the read path emits anything.
  const activeKind = match?.kind ?? variants[0]!.kind;
  const noticeHtml = unknownKind !== null
    ? `<div
        class="form-renderer-union-unknown"
        data-form-union-unknown-kind="${e(unknownKind)}"
        role="alert"
      >Unrecognized kind <code>${e(unknownKind)}</code> — pick a declared variant.</div>`
    : '';
  const selectHtml = renderUnionSelect(
    fieldName,
    variants,
    discriminantKey,
    activeKind,
    unknownKind,
  );
  // Lazy mode emits the active variant body only. Inactive variants
  // still appear as <option> entries in the select; their bodies
  // materialize on the mount layer's union-select re-paint. Eager
  // mode (the registry default) keeps all bodies in DOM so the read
  // path can switch on the discriminant without a re-render.
  const bodies = lazyVariants
    ? renderUnionVariantBody(
        fieldName,
        variants.find((v) => v.kind === activeKind) ?? variants[0]!,
        values,
        options,
        true,
      )
    : variants
        .map((v) => renderUnionVariantBody(fieldName, v, values, options, v.kind === activeKind))
        .join('');
  return `${noticeHtml}${selectHtml}${bodies}`;
};

const renderUnionSelect = (
  fieldName: string,
  variants: ReadonlyArray<DiscriminatedUnionVariant>,
  discriminantKey: string,
  activeKind: string,
  unknownKind: string | null,
): string => {
  // Prepend an unknown-kind placeholder option when the observed
  // discriminant value doesn't match any declared variant. The
  // placeholder is `selected` so the read path emits the original
  // (unrecognized) kind verbatim — no silent rewrite — until the
  // user picks a declared variant. The reader treats this value as
  // null (no matching variant → null record) so saving without
  // picking surfaces a validation error rather than corruption.
  const placeholderHtml = unknownKind !== null
    ? `<option value="${e(unknownKind)}" selected disabled>${e(unknownKind)} (unknown)</option>`
    : '';
  const options = variants
    .map(
      (v) =>
        `<option value="${e(v.kind)}" ${
          unknownKind === null && v.kind === activeKind ? 'selected' : ''
        }>${e(v.label)}</option>`,
    )
    .join('');
  return `<select
    class="form-renderer-select form-renderer-union-select"
    data-form-union-select="${e(fieldName)}"
    data-form-discriminant-field="${e(discriminantKey)}"
    data-form-type="enum"
  >${placeholderHtml}${options}</select>`;
};

const renderUnionVariantBody = (
  fieldName: string,
  variant: DiscriminatedUnionVariant,
  values: Readonly<Record<string, unknown>>,
  options: FormRenderOptions,
  active: boolean,
): string => {
  const inner = renderFieldGroup(variant.fields, values, options);
  return `<div
    class="form-renderer-union-variant"
    data-form-union-scope="${e(fieldName)}"
    data-form-union-variant="${e(variant.kind)}"
    data-form-variant-active="${active ? 'true' : 'false'}"
  >${inner}</div>`;
};

/** Render a group of sub-fields against a scoped values map. Used by
 *  `renderObject` + `renderUnionVariantBody` + array-of-(object|union)
 *  paths. Honors `show_if` against the *scoped* values map, so a
 *  sub-field's gate keys off its same-scope siblings — exactly the
 *  semantics SI's `comparator_tz` (gated by `field === 'now'` choice
 *  inside the same time_window variant) needs.
 *
 *  Drops `options.errors` when descending so a top-level field with
 *  the same name as a nested sub-field doesn't cross-paint the error
 *  on the nested input. `validateForm` keys errors flat at the outer
 *  field name; nested errors today route through the outer composite
 *  row's error chip via the sub.label-prefixed string from
 *  `validateObject` / `validateDiscriminatedUnion`. Future per-path
 *  error keying (Slice 2b+) re-introduces a scoped errors view. */
const renderFieldGroup = (
  fields: ReadonlyArray<FormField>,
  values: Readonly<Record<string, unknown>>,
  options: FormRenderOptions,
): string => {
  const { errors: _droppedErrors, ...nestedOptions } = options;
  const scopedOptions: FormRenderOptions = { ...nestedOptions, values };
  return fields.map((f) => renderField(f, scopedOptions)).join('');
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// ────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────

const pickFieldValue = (
  field: FormField,
  values: Readonly<Record<string, unknown>> | undefined,
): unknown => {
  if (values && field.name in values) return values[field.name];
  return field.default;
};

const stringValue = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  return String(v);
};

/** Truncate / reshape a stored timestamp value into the
 *  `YYYY-MM-DDTHH:MM` form a `datetime-local` input expects. */
const formatTimestampForInput = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return '';
    const date = new Date(v);
    return formatDateForInput(date);
  }
  if (typeof v !== 'string') return '';
  // Trim a Z / offset suffix; strip seconds / ms.
  const stripped = v.replace(/[zZ]$/, '').replace(/[+-]\d{2}:?\d{2}$/, '');
  // Match `YYYY-MM-DDTHH:MM(:SS(.fff)?)?`
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?$/.exec(
    stripped,
  );
  if (!m) return '';
  return `${m[1]}T${m[2]}`;
};

const formatDateForInput = (d: Date): string => {
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
