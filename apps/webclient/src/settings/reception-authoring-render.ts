/** D-149 § A.9 + § A.5.x — Settings → Server → Reception per-kind
 *  authoring-form renderer (the host-side framework renderer).
 *
 *  `reception-authoring.ts` is the projection layer: `build<Kind>FormModel`
 *  projects a working config (or `null`, for a fresh create) into a
 *  `<Kind>FormModel` of `Authoring*Field` descriptors, and
 *  `validate<Kind>FormConfig` wraps the contract validator. Both are
 *  substrate — nothing draws pixels. **This is the renderer: the
 *  host-side piece that turns a `<Kind>FormModel` into DOM and tags every
 *  control with the `data-*` markup a working-config container binds to.**
 *
 *  ── The `renderReceptionPage` shape ───────────────────────────────
 *  Same pattern as `reception-page-render.ts`: a pure `renderX(props)
 *  -> string` + a companion `*_STYLES` constant, every interactive
 *  element carrying a `data-*` attribute a host dispatcher reads. The
 *  difference from `reception-page-render.ts` is the absence of a
 *  `mountX`: that renderer mounted against the pre-existing
 *  `ReceptionPageShell`; the authoring forms project a *working-config*
 *  local edit state that has no container yet (the page-render handover's
 *  decision #6 names it as the next unit). So this module ships the pure
 *  renderer + the `data-*` contract a future `mountAuthoringForm` /
 *  working-config container will bind to — `renderAuthoringForm` is
 *  immediately useful (and fully testable) on its own, exactly as
 *  `renderReceptionPage` is independent of `mountReceptionPage`.
 *
 *  ── Two `data-*` channels ─────────────────────────────────────────
 *    - **Field values** — every control carries `data-field-control`
 *      (`text` / `number` / `toggle` / `select` / `multiselect`) plus a
 *      locator: a top-level field carries `data-field-key` (the
 *      `Authoring*Field.key` — a dotted path into the working config); a
 *      repeater cell carries `data-repeater-key` + `data-row-index` +
 *      `data-row-field`. A future container wires `change` / `input`
 *      events off these to mutate its working config — NOT through a
 *      `data-action` dispatcher (value edits are not discrete actions).
 *    - **Discrete actions** — `data-action` for the things that ARE
 *      discrete: repeater row add / remove, the preview / submit /
 *      cancel buttons. Typed as `AuthoringFormAction`.
 *
 *  ── Preview-then-create vs upsert ─────────────────────────────────
 *  The five link-style kinds funnel through `reception.endpoint.preview_draft`
 *  then `reception.endpoint.create` (§ A.3 preview-hash gate) — so their
 *  action bar offers BOTH "Preview as visitor" (`reception-form-preview`)
 *  and a create submit (`reception-form-submit`). The `reception_page`
 *  singleton funnels through `reception.page.upsert` — a plain config
 *  write, no preview-hash gate (see `reception-authoring.ts`) — so its
 *  action bar offers the submit only. The renderer never fires the rpc;
 *  it shapes the chrome + hands the host the `data-action`, the same
 *  separation `reception-page-render.ts` uses.
 *
 *  ── Submit gating ─────────────────────────────────────────────────
 *  When a `validation` summary is supplied AND it is invalid, the submit
 *  button renders disabled — a pure-render decision off the supplied
 *  model, no host state needed. A `null` validation (not yet validated)
 *  leaves submit enabled; the host validates on click. Preview is never
 *  gated — previewing a partially-valid draft is the trust check that
 *  surfaces what is wrong.
 *
 *  ── XSS ───────────────────────────────────────────────────────────
 *  Every server-/user-supplied string (the working-config values, the
 *  validation `detail` strings) flows through `e()` before
 *  interpolation. Field `key`s and closed-list option values come from
 *  the contract, but flow through `e()` anyway — cheap + uniform.
 *
 *  Spec: docs/d-149-spec.md § A.9 (Settings UX) + § A.5.1-A.5.6
 *  (per-kind config contracts) + § A.3 (preview-hash-gated create). */

import { e } from '@recued/ui-shared/template';
import {
  actionBar,
  badge,
  button,
  checkbox,
  emptyHint,
  inlineHint,
  panel,
  select,
} from '@recued/ui-shared/primitives';

import type { ReceptionEndpointKind } from '@recued/contracts';
// D-210 WS3 — the field-builder's type select DERIVES from this closed list.
import { INTAKE_FORM_VISITOR_FIELD_TYPES } from '@recued/contracts';

import {
  RECEPTION_KIND_COPY,
  isReceptionEndpointKindAvailable,
} from './reception.js';
import { INTAKE_FORM_FIELD_TYPE_COPY } from './reception-authoring.js';
import type {
  ApprovalLinkFormModel,
  ApprovalLinkOptionRow,
  AuthoringMultiSelectField,
  AuthoringNumberField,
  AuthoringRepeaterField,
  AuthoringSelectField,
  AuthoringTextField,
  AuthoringToggleField,
  AuthoringValidationSummary,
  DropLinkFormModel,
  IntakeFormFieldRow,
  IntakeFormFormModel,
  ReceptionLinkButtonRow,
  ReceptionPageCustomLinkRow,
  ReceptionPageFormModel,
  SchedulingLinkExplicitWindowRow,
  SchedulingLinkFormModel,
  StatusLinkFormModel,
} from './reception-authoring.js';

// ════════════════════════════════════════════════════════════════
// Action surface
// ════════════════════════════════════════════════════════════════

/** Every `data-action` the authoring-form renderer emits. A future
 *  `mountAuthoringForm` dispatcher is typed against this union. Value
 *  edits are NOT here — they flow through `change` / `input` events off
 *  the `data-field-*` markup, not a discrete-action dispatch. */
export const AUTHORING_FORM_ACTIONS = [
  // ── Repeater row editing ─────────────────────────────────────────
  'reception-form-add-row',
  'reception-form-remove-row',
  // ── Form chrome ──────────────────────────────────────────────────
  'reception-form-preview',
  'reception-form-submit',
  'reception-form-cancel',
] as const;

export type AuthoringFormAction = (typeof AUTHORING_FORM_ACTIONS)[number];

// ════════════════════════════════════════════════════════════════
// View — the discriminated input the renderer dispatches on
// ════════════════════════════════════════════════════════════════

/** The renderer's input: a per-kind `<Kind>FormModel` paired with its
 *  `kind` discriminant + an optional validation summary. The validation
 *  summary's `Code` type-parameter is erased to `string` — the renderer
 *  only reads `valid` + each failure's `message` / `detail`, never the
 *  closed-list code itself. */
export type AuthoringFormView =
  | {
      readonly kind: 'reception_page';
      readonly model: ReceptionPageFormModel;
      readonly validation: AuthoringValidationSummary<string> | null;
    }
  | {
      readonly kind: 'scheduling_link';
      readonly model: SchedulingLinkFormModel;
      readonly validation: AuthoringValidationSummary<string> | null;
    }
  | {
      readonly kind: 'intake_form';
      readonly model: IntakeFormFormModel;
      readonly validation: AuthoringValidationSummary<string> | null;
    }
  | {
      readonly kind: 'drop_link';
      readonly model: DropLinkFormModel;
      readonly validation: AuthoringValidationSummary<string> | null;
    }
  | {
      readonly kind: 'approval_link';
      readonly model: ApprovalLinkFormModel;
      readonly validation: AuthoringValidationSummary<string> | null;
    }
  | {
      readonly kind: 'status_link';
      readonly model: StatusLinkFormModel;
      readonly validation: AuthoringValidationSummary<string> | null;
    };

/** The five link-style kinds run preview-then-create (§ A.3); the
 *  `reception_page` singleton runs a plain `reception.page.upsert`.
 *  Drives whether the action bar offers a "Preview as visitor" button. */
const KIND_IS_LINK_STYLE: Readonly<Record<ReceptionEndpointKind, boolean>> = {
  reception_page: false,
  scheduling_link: true,
  intake_form: true,
  drop_link: true,
  approval_link: true,
  status_link: true,
};

// ════════════════════════════════════════════════════════════════
// Small shared helpers
// ════════════════════════════════════════════════════════════════

/** `data-*` attribute string from a flat record — keys emitted verbatim
 *  as `data-<key>` (callers pass already-kebab keys), values escaped.
 *  Undefined values dropped. Mirrors `reception-page-render.ts`. */
const dataAttrs = (
  data: Readonly<Record<string, string | undefined>>,
): string =>
  Object.entries(data)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `data-${k}="${e(v)}"`)
    .join(' ');

/** A field label + the `*` required marker + the help line — the chrome
 *  every top-level field row shares. */
const fieldChrome = (args: {
  label: string;
  help: string;
  required?: boolean;
}): { labelHtml: string; helpHtml: string } => ({
  labelHtml: `<span class="reception-form-label">${e(args.label)}${
    args.required ? '<span class="reception-form-req" aria-hidden="true"> *</span>' : ''
  }</span>`,
  helpHtml: `<p class="reception-form-help">${e(args.help)}</p>`,
});

// ════════════════════════════════════════════════════════════════
// Top-level field renderers — one per `Authoring*Field` control
// ════════════════════════════════════════════════════════════════

/** Single-line `<input>` / multi-line `<textarea>` — `multiline` ⇒
 *  textarea. Carries `data-field-key` + `data-field-control="text"`. */
const renderTextField = (f: AuthoringTextField): string => {
  const { labelHtml, helpHtml } = fieldChrome({
    label: f.label,
    help: f.help,
    required: f.required,
  });
  const attrs = dataAttrs({ 'field-key': f.key, 'field-control': 'text' });
  const control = f.multiline
    ? `<textarea class="reception-form-input reception-form-textarea" ${attrs} maxlength="${f.max_length}" rows="3" aria-label="${e(
        f.label,
      )}">${e(f.value)}</textarea>`
    : `<input class="reception-form-input" type="text" ${attrs} maxlength="${f.max_length}" value="${e(
        f.value,
      )}" aria-label="${e(f.label)}" />`;
  return `<div class="reception-form-field">${labelHtml}${control}${helpHtml}</div>`;
};

/** Bounded `<input type="number">` — carries `data-field-key` +
 *  `data-field-control="number"` + the `min` / `max` bounds. */
const renderNumberField = (f: AuthoringNumberField): string => {
  const { labelHtml, helpHtml } = fieldChrome({ label: f.label, help: f.help });
  const attrs = dataAttrs({ 'field-key': f.key, 'field-control': 'number' });
  const control = `<input class="reception-form-input reception-form-number" type="number" ${attrs} min="${f.min}" max="${f.max}" value="${f.value}" aria-label="${e(
    f.label,
  )}" />`;
  return `<div class="reception-form-field">${labelHtml}${control}${helpHtml}</div>`;
};

/** Boolean `<input type="checkbox">` — carries `data-field-key` +
 *  `data-field-control="toggle"`. */
const renderToggleField = (f: AuthoringToggleField): string => {
  const control = checkbox({
    label: f.label,
    checked: f.value,
    data: { 'field-key': f.key, 'field-control': 'toggle' },
  });
  return `<div class="reception-form-field reception-form-field--toggle">${control}<p class="reception-form-help">${e(
    f.help,
  )}</p></div>`;
};

/** Single-select from a closed list — carries `data-field-key` +
 *  `data-field-control="select"`. Option `help` rides each `<option>` as
 *  its `title`. */
const renderSelectField = (f: AuthoringSelectField<string | number>): string => {
  const { labelHtml, helpHtml } = fieldChrome({ label: f.label, help: f.help });
  const control = select({
    ariaLabel: f.label,
    extraClass: 'reception-form-select',
    data: { 'field-key': f.key, 'field-control': 'select' },
    options: f.options.map((o) => ({
      value: String(o.value),
      label: o.label,
      selected: String(o.value) === String(f.value),
    })),
  });
  return `<div class="reception-form-field">${labelHtml}${control}${helpHtml}</div>`;
};

/** Multi-select from a closed list — a checkbox per option, each
 *  carrying `data-field-key` + `data-field-control="multiselect"` +
 *  `data-option-value`. The min / max selected bounds surface as a hint. */
const renderMultiSelectField = (
  f: AuthoringMultiSelectField<string | number>,
): string => {
  const { labelHtml } = fieldChrome({ label: f.label, help: f.help });
  const selected = new Set(f.value.map((v) => String(v)));
  const boxes = f.options
    .map((o) =>
      checkbox({
        label: o.label,
        checked: selected.has(String(o.value)),
        data: {
          'field-key': f.key,
          'field-control': 'multiselect',
          'option-value': String(o.value),
        },
      }),
    )
    .join('');
  const bound =
    f.min_selected > 0
      ? `Pick ${f.min_selected}–${f.max_selected}.`
      : `Pick up to ${f.max_selected}.`;
  return `<div class="reception-form-field reception-form-field--multiselect">
    ${labelHtml}
    <p class="reception-form-help">${e(f.help)} ${e(bound)}</p>
    <div class="reception-form-checkgroup">${boxes}</div>
  </div>`;
};

// ════════════════════════════════════════════════════════════════
// Repeater field renderer + cell helpers
// ════════════════════════════════════════════════════════════════

/** A repeater cell `<input type="text">` — carries the repeater-cell
 *  locator (`data-repeater-key` + `data-row-index` + `data-row-field`)
 *  plus `data-field-control="text"`. */
const repeaterTextCell = (args: {
  repeaterKey: string;
  rowIndex: number;
  rowField: string;
  label: string;
  value: string;
  maxLength?: number;
}): string => {
  const attrs = dataAttrs({
    'repeater-key': args.repeaterKey,
    'row-index': String(args.rowIndex),
    'row-field': args.rowField,
    'field-control': 'text',
  });
  const max = args.maxLength !== undefined ? ` maxlength="${args.maxLength}"` : '';
  return `<label class="reception-form-cell"><span class="reception-form-cell-label">${e(
    args.label,
  )}</span><input class="reception-form-input" type="text" ${attrs}${max} value="${e(
    args.value,
  )}" aria-label="${e(args.label)}" /></label>`;
};

/** A repeater cell `<input type="number">`. */
const repeaterNumberCell = (args: {
  repeaterKey: string;
  rowIndex: number;
  rowField: string;
  label: string;
  value: number;
  min: number;
  max: number;
}): string => {
  const attrs = dataAttrs({
    'repeater-key': args.repeaterKey,
    'row-index': String(args.rowIndex),
    'row-field': args.rowField,
    'field-control': 'number',
  });
  return `<label class="reception-form-cell"><span class="reception-form-cell-label">${e(
    args.label,
  )}</span><input class="reception-form-input reception-form-number" type="number" ${attrs} min="${args.min}" max="${args.max}" value="${args.value}" aria-label="${e(
    args.label,
  )}" /></label>`;
};

/** A repeater cell `<select>`. */
const repeaterSelectCell = (args: {
  repeaterKey: string;
  rowIndex: number;
  rowField: string;
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}): string => {
  const control = select({
    ariaLabel: args.label,
    extraClass: 'reception-form-select',
    data: {
      'repeater-key': args.repeaterKey,
      'row-index': String(args.rowIndex),
      'row-field': args.rowField,
      'field-control': 'select',
    },
    options: args.options.map((o) => ({
      value: o.value,
      label: o.label,
      selected: o.value === args.value,
    })),
  });
  return `<label class="reception-form-cell"><span class="reception-form-cell-label">${e(
    args.label,
  )}</span>${control}</label>`;
};

/** A repeater cell `<input type="checkbox">`. */
const repeaterToggleCell = (args: {
  repeaterKey: string;
  rowIndex: number;
  rowField: string;
  label: string;
  checked: boolean;
}): string =>
  `<div class="reception-form-cell">${checkbox({
    label: args.label,
    checked: args.checked,
    data: {
      'repeater-key': args.repeaterKey,
      'row-index': String(args.rowIndex),
      'row-field': args.rowField,
      'field-control': 'toggle',
    },
  })}</div>`;

/** A variable-length repeater. `renderCells` projects ONE row's value
 *  cells (the per-kind caller owns the row shape — the row types are
 *  heterogeneous); this wraps each row with its `data-row-index` locator
 *  + a Remove button (shown once above `min_rows`), and emits the Add
 *  button (until `max_rows`). */
const renderRepeaterField = <Row>(
  f: AuthoringRepeaterField<Row>,
  renderCells: (row: Row, index: number) => string,
): string => {
  const { labelHtml, helpHtml } = fieldChrome({ label: f.label, help: f.help });
  const canRemove = f.rows.length > f.min_rows;
  const rowsHtml =
    f.rows.length > 0
      ? f.rows
          .map(
            (row, i) => `
        <div class="reception-form-repeater-row" ${dataAttrs({
          'repeater-key': f.key,
          'row-index': String(i),
        })}>
          <div class="reception-form-repeater-cells">${renderCells(row, i)}</div>
          ${
            canRemove
              ? button({
                  label: 'Remove',
                  size: 'xs',
                  variant: 'danger-text',
                  action: 'reception-form-remove-row',
                  ariaLabel: `Remove ${f.label} row ${i + 1}`,
                  data: { 'repeater-key': f.key, 'row-index': String(i) },
                })
              : ''
          }
        </div>`,
          )
          .join('')
      : emptyHint({ message: 'None yet.' });
  const addControl =
    f.rows.length < f.max_rows
      ? button({
          label: 'Add',
          size: 'xs',
          action: 'reception-form-add-row',
          ariaLabel: `Add ${f.label} row`,
          data: { 'repeater-key': f.key },
        })
      : inlineHint(`Maximum of ${f.max_rows} reached.`);
  return `<div class="reception-form-field reception-form-repeater" ${dataAttrs({
    'repeater-key': f.key,
  })}>
    ${labelHtml}
    ${helpHtml}
    <div class="reception-form-repeater-rows">${rowsHtml}</div>
    ${addControl}
  </div>`;
};

// ════════════════════════════════════════════════════════════════
// Form section grouping + header / footer chrome
// ════════════════════════════════════════════════════════════════

/** One titled group of fields within a kind's form. */
const formSection = (title: string, fields: ReadonlyArray<string>): string =>
  `<section class="reception-form-section">
    <h4 class="reception-form-section-title">${e(title)}</h4>
    ${fields.join('')}
  </section>`;

/** The form header — heading + the per-kind description copy. */
const renderFormHeader = (kind: ReceptionEndpointKind, isNew: boolean): string => {
  const copy = RECEPTION_KIND_COPY[kind];
  const heading = isNew ? copy.create_label : `Edit ${copy.singular}`;
  return `<header class="reception-form-header">
    <h3 class="reception-form-title">${e(heading)}</h3>
    <p class="reception-form-desc">${e(copy.description)}</p>
  </header>`;
};

/** The validation summary panel — surfaced only when a `validation`
 *  summary is supplied AND it carries failures. Resolved-copy `message`
 *  + the contract `detail` per failure. */
const renderValidationSummary = (
  validation: AuthoringValidationSummary<string> | null,
): string => {
  if (validation === null || validation.valid) return '';
  return panel({
    tone: 'danger',
    title: `Fix ${validation.failures.length} ${
      validation.failures.length === 1 ? 'problem' : 'problems'
    } before saving`,
    role: 'alert',
    body: `<ul class="reception-form-errors">${validation.failures
      .map(
        (fail) =>
          `<li class="reception-form-error"><span class="reception-form-error-msg">${e(
            fail.message,
          )}</span> <span class="reception-form-error-detail">${e(
            fail.detail,
          )}</span></li>`,
      )
      .join('')}</ul>`,
  });
};

/** The bottom action bar. Link-style kinds offer "Preview as visitor"
 *  (`reception-form-preview`, never gated — previewing a partial draft is
 *  the trust check) + a create submit; the `reception_page` singleton
 *  offers the upsert submit only. Submit is disabled when a `validation`
 *  summary is supplied and invalid. */
const renderFormActions = (
  kind: ReceptionEndpointKind,
  isNew: boolean,
  validation: AuthoringValidationSummary<string> | null,
): string => {
  const submitDisabled = validation !== null && !validation.valid;
  const submitLabel =
    kind === 'reception_page'
      ? isNew
        ? 'Set up Reception page'
        : 'Save Reception page'
      : isNew
        ? 'Create'
        : 'Save changes';
  const children: string[] = [];
  if (KIND_IS_LINK_STYLE[kind] && isReceptionEndpointKindAvailable(kind)) {
    children.push(
      button({
        label: 'Preview as visitor',
        size: 'sm',
        action: 'reception-form-preview',
      }),
    );
  }
  children.push(
    button({
      label: submitLabel,
      size: 'sm',
      variant: 'primary',
      action: 'reception-form-submit',
      disabled: submitDisabled,
    }),
    button({ label: 'Cancel', size: 'sm', action: 'reception-form-cancel' }),
  );
  return actionBar({ gap: 8, bordered: true, children });
};

// ════════════════════════════════════════════════════════════════
// Per-kind repeater row renderers
// ════════════════════════════════════════════════════════════════

/** § A.5.1 — legacy `reception_page.custom_links` row: label + URL. */
const renderCustomLinkCells = (
  key: string,
  row: ReceptionPageCustomLinkRow,
  index: number,
): string =>
  repeaterTextCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'label',
    label: 'Link label',
    value: row.label,
  }) +
  repeaterTextCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'url',
    label: 'Link URL',
    value: row.url,
  });

/** D-196 S3 — reusable link_button row. */
const renderLinkButtonCells = (
  key: string,
  row: ReceptionLinkButtonRow,
  index: number,
): string =>
  repeaterTextCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'label',
    label: 'Button label',
    value: row.label,
  }) +
  repeaterTextCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'url',
    label: 'HTTPS destination',
    value: row.url,
  }) +
  repeaterTextCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'description',
    label: 'Description (optional)',
    value: row.description,
  });

/** § A.5.2 — `scheduling_link.explicit_windows` row: day of week +
 *  start / end minute-of-day. */
const DAY_OF_WEEK_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
];

const renderExplicitWindowCells = (
  key: string,
  row: SchedulingLinkExplicitWindowRow,
  index: number,
): string =>
  repeaterSelectCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'day_of_week',
    label: 'Day',
    value: String(row.day_of_week),
    options: DAY_OF_WEEK_OPTIONS,
  }) +
  repeaterNumberCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'start_minute',
    label: 'Start (minute of day)',
    value: row.start_minute,
    min: 0,
    max: 1440,
  }) +
  repeaterNumberCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'end_minute',
    label: 'End (minute of day)',
    value: row.end_minute,
    min: 0,
    max: 1440,
  });

/** § A.5.3 — `intake_form.form_definition.fields` row: name, type,
 *  label, required, enum values. The renderer does not constrain the
 *  `type` select to the contract's closed list itself — it reflects
 *  whatever the working-config row holds; the contract validator gates
 *  an unknown type with `field_type_unknown`. */
/** The field-builder's type select.
 *
 *  ⛔ DERIVED, never re-listed. This was a hand-maintained copy typed as
 *  `{value: string; label: string}[]` — loose enough that the typechecker had
 *  nothing to compare it against, so when D-210 WS3 added `datetime` to the
 *  contract vocabulary this list silently stayed a SUBSET. A browser verify
 *  caught it: a `datetime` field rendered as "Short text" (no option matched,
 *  so the select fell back to its first), and touching anything else in that
 *  row would have written `text` back — silently downgrading the field and
 *  breaking whatever calendar mapping named it.
 *
 *  Deriving from the contract's closed list makes the next addition automatic,
 *  and `INTAKE_FORM_FIELD_TYPE_COPY` is `Record<IntakeFormVisitorFieldType, …>`
 *  so a missing label is a compile error rather than a wrong-looking select. */
const INTAKE_FIELD_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> =
  INTAKE_FORM_VISITOR_FIELD_TYPES.map((value) => ({
    value,
    label: INTAKE_FORM_FIELD_TYPE_COPY[value].label,
  }));

const renderIntakeFieldCells = (
  key: string,
  row: IntakeFormFieldRow,
  index: number,
): string =>
  repeaterTextCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'name',
    label: 'Field name',
    value: row.name,
  }) +
  repeaterTextCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'label',
    label: 'Field label',
    value: row.label,
  }) +
  repeaterSelectCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'type',
    label: 'Field type',
    value: String(row.type),
    options: INTAKE_FIELD_TYPE_OPTIONS,
  }) +
  repeaterToggleCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'required',
    label: 'Required',
    checked: row.required,
  }) +
  repeaterTextCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'values',
    label: 'Choice values (comma-separated — Choice type only)',
    value: row.values.join(', '),
  });

/** § A.5.5 — `approval_link.options` row: id, label, description. */
const renderApprovalOptionCells = (
  key: string,
  row: ApprovalLinkOptionRow,
  index: number,
): string =>
  repeaterTextCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'id',
    label: 'Option id',
    value: row.id,
  }) +
  repeaterTextCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'label',
    label: 'Option label',
    value: row.label,
  }) +
  repeaterTextCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'description',
    label: 'Option description',
    value: row.description,
  });

/** A plain string-row repeater (the email-domain allowlists, the
 *  approval-link counterparty aliases + private notes) — one text cell. */
const renderStringRowCells = (
  key: string,
  cellLabel: string,
  row: string,
  index: number,
): string =>
  repeaterTextCell({
    repeaterKey: key,
    rowIndex: index,
    rowField: 'value',
    label: cellLabel,
    value: row,
  });

// ════════════════════════════════════════════════════════════════
// Per-kind form bodies
// ════════════════════════════════════════════════════════════════

const renderReceptionPageBody = (m: ReceptionPageFormModel): string =>
  [
    formSection('Contact card', [
      renderTextField(m.display_name),
      renderTextField(m.tagline),
      renderTextField(m.tz_label),
      renderTextField(m.avatar_url),
      renderTextField(m.response_time_estimate),
      renderMultiSelectField(m.preferred_contact_methods),
    ]),
    formSection(
      'Page sections',
      m.sections_enabled.map((t) => renderToggleField(t)),
    ),
    formSection(
      'Linked endpoints',
      m.linked_endpoints.map((t) => renderTextField(t)),
    ),
    formSection('Custom links', [
      renderRepeaterField(m.custom_links, (row, i) =>
        renderCustomLinkCells(m.custom_links.key, row, i),
      ),
    ]),
    formSection('Link buttons', [
      renderRepeaterField(m.link_buttons, (row, i) =>
        renderLinkButtonCells(m.link_buttons.key, row, i),
      ),
    ]),
    formSection('Footer', [renderToggleField(m.trust_footer_enabled)]),
    // D-210 Phase C — its own section, deliberately NOT under a
    // page-appearance heading: this setting is about the owner's devices,
    // not about anything a visitor sees.
    formSection('Inbox notifications', [renderSelectField(m.inbox_fanout_mode)]),
  ].join('');

const renderSchedulingLinkBody = (m: SchedulingLinkFormModel): string =>
  [
    formSection('Basics', [
      renderTextField(m.display_name),
      renderTextField(m.instructions),
      renderTextField(m.success_message),
      renderMultiSelectField(m.duration_options_minutes),
    ]),
    formSection('Availability', [
      renderTextField(m.tz),
      renderRepeaterField(m.explicit_windows, (row, i) =>
        renderExplicitWindowCells(m.explicit_windows.key, row, i),
      ),
    ]),
    formSection(
      'Visitor fields',
      m.required_visitor_fields.map((s) => renderSelectField(s)),
    ),
    formSection('Booking rules', [
      renderNumberField(m.min_advance_notice_hours),
      renderNumberField(m.max_lead_time_days),
      renderNumberField(m.max_bookings_per_day),
    ]),
    formSection('On booking', [
      renderToggleField(m.create_calendar_event),
      renderToggleField(m.create_commitment_entity),
    ]),
  ].join('');

const renderIntakeFormBody = (m: IntakeFormFormModel): string => {
  // D-210 A.8 slice 2b step 3 — was `value === ''` (the retired log-only
  // sentinel). The controls it hides are the entity-projection knobs, and those
  // are ignored for `form_response` for the same reason they were ignored for
  // "no destination": the answers ARE the record, so there is no projection to
  // configure. Re-pointed rather than deleted.
  const answersAreTheRecord = m.target_kind.value === 'form_response';
  const answersAreTheRecordHint = `<p class="reception-form-help">
    Every submitted answer and the frozen form definition are kept as the response record itself.
    Nothing else is created — you work the responses directly.
  </p>`;
  return [
    formSection('Basics', [
      renderTextField(m.display_name),
      renderTextField(m.instructions),
      renderTextField(m.success_message),
      renderTextField(m.submit_button_label),
      renderTextField(m.template_ref),
      renderTextField(m.form_definition_id),
    ]),
    formSection('Form fields', [
      renderRepeaterField(m.fields, (row, i) =>
        renderIntakeFieldCells(m.fields.key, row, i),
      ),
    ]),
    formSection('Submission processing', [
      renderSelectField(m.target_kind),
      ...(answersAreTheRecord ? [answersAreTheRecordHint] : []),
      // D-210 WS3 — the calendar mapping. An intake's fields are role-agnostic,
      // so without these controls a `calendar` destination could be selected
      // and never configured. Only the end control matching the chosen mode is
      // shown: the contract allows exactly one end-spec, and rendering all
      // three would invite the config error the validator then refuses.
      // Keyed on field PRESENCE, not on the target value: the model builder
      // omits these entirely for any other destination (so `seedWorkingConfig`
      // cannot bleed a calendar mapping into a note form), which makes the
      // model — not a second copy of the rule here — the authority on what
      // exists. The typechecker enforces it.
      ...(m.calendar_start_field !== undefined
        && m.calendar_end_mode !== undefined
        && m.calendar_end_field !== undefined
        && m.calendar_duration_field !== undefined
        && m.calendar_default_duration_minutes !== undefined
        && m.calendar_timezone !== undefined
        ? [
            renderSelectField(m.calendar_start_field),
            renderSelectField(m.calendar_end_mode),
            ...(m.calendar_end_mode.value === 'end_field'
              ? [renderSelectField(m.calendar_end_field)]
              : m.calendar_end_mode.value === 'duration_field'
                ? [renderSelectField(m.calendar_duration_field)]
                : [renderNumberField(m.calendar_default_duration_minutes)]),
            renderTextField(m.calendar_timezone),
          ]
        : []),
      // D-210 WS3 — the contact mapping's one authorable slot. The email is
      // absent by design (the sealed visitor address keys the contact), and
      // saying so beats leaving the owner to wonder where it went.
      ...(m.contact_name_field !== undefined
        ? [
            renderSelectField(m.contact_name_field),
            `<p class="reception-form-help">
    The contact is matched on the visitor’s email address, which the form already collects and keeps
    sealed — there is nothing to map for it.
  </p>`,
          ]
        : []),
      ...(answersAreTheRecord
        ? []
        : [
            renderMultiSelectField(m.fields_to_include_in_target),
            renderMultiSelectField(m.fields_to_attach_as_metadata),
          ]),
    ]),
    formSection('Anti-spam', [
      renderMultiSelectField(m.honeypot_fields),
      renderNumberField(m.rate_limit_per_ip),
      renderToggleField(m.require_proof_of_work),
      renderToggleField(m.require_captcha),
      renderRepeaterField(m.known_domain_allowlist, (row, i) =>
        renderStringRowCells(
          m.known_domain_allowlist.key,
          'Allowed email domain',
          row,
          i,
        ),
      ),
      renderSelectField(m.visitor_email_requirement),
    ]),
  ].join('');
};

const renderDropLinkBody = (m: DropLinkFormModel): string =>
  [
    formSection('Basics', [
      renderTextField(m.display_name),
      renderTextField(m.instructions),
      renderTextField(m.success_message),
      renderTextField(m.submit_button_label),
      renderTextField(m.template_ref),
      renderSelectField(m.link_kind),
    ]),
    formSection('Upload limits', [
      renderNumberField(m.size_cap_bytes),
      renderMultiSelectField(m.allowed_mime_types),
      renderNumberField(m.expiry_days),
      renderNumberField(m.max_uploads_per_endpoint_per_day),
    ]),
    formSection(
      'Visitor fields',
      m.required_visitor_fields.map((s) => renderSelectField(s)),
    ),
    formSection('On upload', [
      renderToggleField(m.create_data_file_entity),
      renderToggleField(m.auto_attach_to_contact),
      renderTextField(m.auto_attach_to_project_id),
      renderRepeaterField(m.known_domain_allowlist, (row, i) =>
        renderStringRowCells(
          m.known_domain_allowlist.key,
          'Allowed email domain',
          row,
          i,
        ),
      ),
    ]),
  ].join('');

const renderApprovalLinkBody = (m: ApprovalLinkFormModel): string => {
  // The `options` repeater is meaningful only for the two action kinds
  // that need a choice list (`pick_time` / `confirm_attendance`); the
  // model surfaces `action_kind_requires_options` precisely so the
  // renderer hides the repeater for the rest (see `reception-authoring.ts`
  // `APPROVAL_LINK_ACTION_KIND_COPY`).
  const optionsSection = m.action_kind_requires_options
    ? formSection('Options', [
        renderRepeaterField(m.options, (row, i) =>
          renderApprovalOptionCells(m.options.key, row, i),
        ),
      ])
    : '';
  return [
    formSection('Basics', [
      renderTextField(m.display_name),
      renderSelectField(m.action_kind),
      renderTextField(m.prompt),
      renderTextField(m.context_summary),
    ]),
    formSection('Private context (stripped at the packet boundary)', [
      renderRepeaterField(m.counterparty_aliases, (row, i) =>
        renderStringRowCells(
          m.counterparty_aliases.key,
          'Counterparty alias',
          row,
          i,
        ),
      ),
      renderRepeaterField(m.private_notes, (row, i) =>
        renderStringRowCells(m.private_notes.key, 'Private note', row, i),
      ),
    ]),
    optionsSection,
    formSection('Visitor fields', [
      renderSelectField(m.visitor_name_constraint),
      renderSelectField(m.visitor_email_constraint),
      renderTextField(m.require_email_match),
    ]),
    formSection('Action', [
      renderNumberField(m.expiry_days),
      renderTextField(m.target_id),
      renderSelectField(m.on_approve_action),
    ]),
    formSection('Confirmation', [
      renderTextField(m.success_message),
      renderTextField(m.submit_button_label),
      renderTextField(m.template_ref),
    ]),
  ].join('');
};

const renderStatusLinkBody = (m: StatusLinkFormModel): string =>
  [
    formSection('Basics', [
      renderTextField(m.display_name),
      renderTextField(m.caption),
      renderSelectField(m.projection_kind),
    ]),
    formSection('Source entity', [
      renderSelectField(m.source_ref_kind),
      renderTextField(m.source_ref_id),
      renderMultiSelectField(m.fields_visible_override),
    ]),
    formSection('Refresh', [
      renderToggleField(m.auto_refresh_enabled),
      renderNumberField(m.refresh_interval_seconds),
    ]),
    formSection('Display', [
      renderToggleField(m.comments_enabled),
      renderToggleField(m.shows_update_history),
      renderNumberField(m.expiry_days),
      renderTextField(m.template_ref),
    ]),
  ].join('');

// ════════════════════════════════════════════════════════════════
// Top-level renderer
// ════════════════════════════════════════════════════════════════

/** Resolve the per-kind body + the `is_new` flag from the view. The
 *  switch is exhaustive over the six `ReceptionEndpointKind`s — tsc
 *  enforces it through the discriminated `AuthoringFormView`. */
const renderFormBody = (view: AuthoringFormView): { body: string; isNew: boolean } => {
  switch (view.kind) {
    case 'reception_page':
      return { body: renderReceptionPageBody(view.model), isNew: view.model.is_new };
    case 'scheduling_link':
      return { body: renderSchedulingLinkBody(view.model), isNew: view.model.is_new };
    case 'intake_form':
      return { body: renderIntakeFormBody(view.model), isNew: view.model.is_new };
    case 'drop_link':
      return { body: renderDropLinkBody(view.model), isNew: view.model.is_new };
    case 'approval_link':
      return { body: renderApprovalLinkBody(view.model), isNew: view.model.is_new };
    case 'status_link':
      return { body: renderStatusLinkBody(view.model), isNew: view.model.is_new };
  }
};

/** Render a per-kind Reception authoring form from its `<Kind>FormModel`.
 *  Pure — no I/O, no container reference. Every control carries the
 *  `data-field-*` / `data-repeater-*` markup a working-config container
 *  binds value edits to; every discrete button carries a typed
 *  `data-action`. */
export const renderAuthoringForm = (view: AuthoringFormView): string => {
  const { body, isNew } = renderFormBody(view);
  return `
    <div class="reception-form" ${dataAttrs({ kind: view.kind })}>
      ${renderFormHeader(view.kind, isNew)}
      ${renderValidationSummary(view.validation)}
      <div class="reception-form-body">${body}</div>
      ${renderFormActions(view.kind, isNew, view.validation)}
    </div>
  `;
};

// ════════════════════════════════════════════════════════════════
// Styles — self-contained `.reception-form-*` selectors, colours from
// the shared CSS custom properties (same convention as every primitive
// + `RECEPTION_PAGE_STYLES`).
// ════════════════════════════════════════════════════════════════

export const RECEPTION_AUTHORING_STYLES = `
.reception-form {
  display: flex;
  flex-direction: column;
  gap: 22px;
  padding: clamp(20px, 3vw, 28px);
  /* R19 Slice 2 — an OPAQUE card surface. Pre-R19 the form carried no
     background, so on the modal overlay backdrop it rendered transparent
     and unusable (the "can't enable" bug). A bordered card on the page
     background reads as a real form whether routed full-page (the new
     default) or, residually, in the modal slot — same surface convention
     as the templates browser. */
  max-width: 760px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow: 0 1px 2px rgba(24, 24, 27, 0.04), 0 18px 46px rgba(24, 24, 27, 0.05);
}
.reception-form .rx-btn {
  min-height: 36px;
  border-radius: 8px;
  font-weight: 650;
}
.reception-form-header {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}
.reception-form-title {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin: 0;
}
.reception-form-desc {
  max-width: 62ch;
  font-size: 13px;
  line-height: 1.55;
  color: var(--fg-muted);
  margin: 0;
}
.reception-form-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.reception-form-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface-sunk);
}
.reception-form-section-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.075em;
  color: var(--fg-muted);
  margin: 0;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.reception-form-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.reception-form-field--toggle {
  gap: 2px;
}
.reception-form-label {
  font-size: 13px;
  font-weight: 650;
  color: var(--fg);
}
.reception-form-req {
  color: var(--fail);
}
.reception-form-help {
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.4;
  margin: 0;
}
.reception-form-input,
.reception-form-textarea,
.reception-form-select {
  width: 100%;
  min-height: 44px;
  padding: 10px 11px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 9px;
  font-size: 13px;
  font-family: inherit;
  background: var(--surface);
  color: var(--fg);
  transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
}
.reception-form-input:focus,
.reception-form-textarea:focus,
.reception-form-select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-weak);
}
.reception-form-textarea {
  resize: vertical;
  min-height: 96px;
}
.reception-form-number {
  width: 160px;
}
.reception-form-checkgroup {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}
.reception-form-repeater {
  border: 1px dashed var(--border-strong, var(--border));
  border-radius: 10px;
  padding: 13px;
  background: var(--surface);
}
.reception-form-repeater-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0;
}
.reception-form-repeater-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 11px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-sunk);
}
.reception-form-repeater-cells {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  flex: 1;
}
.reception-form-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 140px;
}
.reception-form-cell-label {
  font-size: 11px;
  color: var(--fg-muted);
}
.reception-form-errors {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.reception-form-error {
  font-size: 12px;
}
.reception-form-error-msg {
  color: var(--fg);
}
.reception-form-error-detail {
  color: var(--fg-muted);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
}
.reception-form > .rx-action-bar {
  margin-top: 0;
  padding-top: 18px;
}
/* R19 Slice 2 — the routed full-page authoring section chrome
   (reception-authoring-section.ts): a back-link header above the form
   card. The wrapper also carries .reception-page, whose flex-column gap
   spaces the header from the form. */
.reception-authoring-section-head {
  display: flex;
  align-items: center;
}
.reception-authoring-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 34px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 650;
  color: var(--fg-muted);
  text-decoration: none;
}
.reception-authoring-back:hover {
  color: var(--fg);
  background: var(--surface-sunk);
}
.reception-authoring-back:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
@media (max-width: 640px) {
  .reception-form { padding: 18px 14px; border-radius: 12px; }
  .reception-form-title { font-size: 20px; }
  .reception-form-section { padding: 13px; }
  .reception-form-number { width: 100%; }
  .reception-form-repeater-row { align-items: stretch; flex-direction: column; }
  .reception-form > .rx-action-bar .rx-btn { flex: 1 1 auto; }
}
`;
