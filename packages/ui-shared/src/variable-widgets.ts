/** Recipe-variable form widgets — shared across install dialog,
 *  schedule editor, and Kitchen editor.
 *
 *  A recipe's `variables` map carries two shapes per entry:
 *    - A primitive default (`number | boolean | string | string[]`),
 *      in which case the widget type is inferred from the JS type.
 *    - A `ValueHint` object (`{ label, type, options?, help?, ... }`),
 *      which lets the author control labelling / options / help text.
 *
 *  `renderVariableWidget` normalises both shapes into a single typed
 *  render path. The output reuses the `typedField` primitive for
 *  string/number/boolean/enum, and adds two widget types the primitive
 *  doesn't cover directly:
 *    - `secret` — password input + "Store in Settings > Connections"
 *      hint when the variable is sourced from a vault-style hint.
 *    - `multi` — grid of checkboxes when the default is a `string[]`
 *      of allowable values.
 *
 *  Callers own the surrounding section styling. Each row is a
 *  `<div class="var-row">` wrapper with label/help/input inside; the
 *  caller prepends/appends any extra chrome (remove button, rename
 *  input, etc.).
 *
 *  The change-event binding is standardised: every input carries
 *  `data-var-key="{name}"` + `data-var-type="{type}"`, so a single
 *  delegated listener on the surface root can read `el.dataset.varKey`
 *  + `el.dataset.varType` and dispatch through `readWidgetValue`.
 *
 *  See `__tests__/variable-widgets.test.ts` for every widget shape
 *  + change-event path.
 */

import type { VariableDefault, ValueHint } from '@recued/contracts';
import { initialRefPickerState } from './ref-picker/model.js';
import { renderRefPicker } from './ref-picker/render.js';
import { e } from './template.js';

export type WidgetType =
  | 'text'
  | 'number'
  | 'boolean'
  | 'select'
  | 'multi'
  | 'secret'
  | 'file_ref';

export interface WidgetShape {
  key: string;
  label: string;
  type: WidgetType;
  help?: string;
  link?: string;
  options?: readonly string[];
  value: unknown;
  optional?: boolean;
}

/** Marker on a `file_ref` variable row (value = recipe variable key). Hosts
 *  with a file-inventory search caller attach the shared RefPicker here; hosts
 *  without one render a pasteable ref input instead. */
export const FILE_REF_VARIABLE_ATTR = 'data-recued-file-ref-variable';

export interface VariableWidgetRenderOptions {
  /** Render a name→file_ref combobox shell instead of the fallback text box. */
  fileRefPicker?: boolean;
  /** Unique scope when the same variable widgets coexist in nested overlays. */
  idPrefix?: string;
}

export const fileRefVariablePickerId = (
  key: string,
  idPrefix = 'variable',
): string => `${idPrefix}-file-ref-${key}`;

/** Normalise a `VariableDefault` entry to a renderable widget shape. */
export const toWidgetShape = (
  key: string,
  def: VariableDefault,
  override?: unknown,
): WidgetShape => {
  if (isValueHint(def)) {
    const type = mapHintType(def);
    const value = override !== undefined ? override : def.default;
    return {
      key,
      label: def.label,
      type,
      help: def.help,
      link: def.link,
      options: def.options,
      value,
      optional: def.optional,
    };
  }

  // Primitive default — infer widget type from JS type.
  const value = override !== undefined ? override : def;
  if (typeof def === 'boolean') {
    return { key, label: formatKey(key), type: 'boolean', value };
  }
  if (typeof def === 'number') {
    return { key, label: formatKey(key), type: 'number', value };
  }
  if (Array.isArray(def)) {
    return {
      key,
      label: formatKey(key),
      type: 'multi',
      options: def.map(String),
      value: Array.isArray(value) ? value : def,
    };
  }
  return { key, label: formatKey(key), type: 'text', value };
};

/** Render a single variable widget. Returns a `<div class="var-row">`
 *  block with label + optional help + the type-specific input. */
export const renderVariableWidget = (
  w: WidgetShape,
  options: VariableWidgetRenderOptions = {},
): string => {
  const id = `${options.idPrefix ?? 'var'}-${w.key}`;
  const help = w.help
    ? `<p class="var-help">${e(w.help)}${
        w.link
          ? ` <a href="${e(w.link)}" target="_blank" rel="noopener">Learn more</a>`
          : ''
      }</p>`
    : '';

  if (w.type === 'boolean') {
    const checked = w.value === true || w.value === 'true';
    return `
      <div class="var-row var-row-inline">
        <label for="${e(id)}">
          <input
            id="${e(id)}"
            type="checkbox"
            data-var-key="${e(w.key)}"
            data-var-type="boolean"
            ${checked ? 'checked' : ''}
          />
          ${e(w.label)}
          ${w.optional ? '<span class="var-optional">optional</span>' : ''}
        </label>
        ${help}
      </div>
    `;
  }

  if (w.type === 'select') {
    const options = w.options ?? [];
    const selected = String(w.value ?? options[0] ?? '');
    return `
      <div class="var-row">
        <label for="${e(id)}">${e(w.label)}${
      w.optional ? ' <span class="var-optional">optional</span>' : ''
    }</label>
        ${help}
        <select
          id="${e(id)}"
          data-var-key="${e(w.key)}"
          data-var-type="select"
        >
          ${options
            .map(
              (opt) =>
                `<option value="${e(opt)}" ${opt === selected ? 'selected' : ''}>${e(opt)}</option>`,
            )
            .join('')}
        </select>
      </div>
    `;
  }

  if (w.type === 'multi') {
    const options = w.options ?? [];
    const current = new Set(
      (Array.isArray(w.value) ? w.value : []).map(String),
    );
    return `
      <div class="var-row var-row-multi">
        <div class="var-multi-label">${e(w.label)}${
      w.optional ? ' <span class="var-optional">optional</span>' : ''
    }</div>
        ${help}
        <div class="var-multi-grid" data-var-key="${e(w.key)}" data-var-type="multi">
          ${options
            .map((opt) => {
              const optId = `${id}-${opt}`;
              const on = current.has(opt);
              return `
                <label for="${e(optId)}" class="var-multi-opt">
                  <input
                    id="${e(optId)}"
                    type="checkbox"
                    data-var-key="${e(w.key)}"
                    data-var-type="multi"
                    data-option="${e(opt)}"
                    ${on ? 'checked' : ''}
                  />
                  <span>${e(opt)}</span>
                </label>
              `;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  if (w.type === 'secret') {
    const display = w.value === undefined || w.value === null ? '' : String(w.value);
    return `
      <div class="var-row">
        <label for="${e(id)}">${e(w.label)}${
      w.optional ? ' <span class="var-optional">optional</span>' : ''
    }</label>
        ${help}
        <input
          id="${e(id)}"
          type="password"
          data-var-key="${e(w.key)}"
          data-var-type="secret"
          value="${e(display)}"
          autocomplete="off"
          spellcheck="false"
        />
      </div>
    `;
  }

  if (w.type === 'file_ref' && options.fileRefPicker === true) {
    const selected = typeof w.value === 'string' && w.value.length > 0
      ? { id: w.value, label: w.value }
      : null;
    const pickerId = fileRefVariablePickerId(w.key, options.idPrefix);
    return `
      <div class="var-row" ${FILE_REF_VARIABLE_ATTR}="${e(w.key)}">
        <div class="var-multi-label">${e(w.label)}${
      w.optional ? ' <span class="var-optional">optional</span>' : ''
    }</div>
        ${help}
        ${renderRefPicker(initialRefPickerState(selected), {
          pickerId,
          placeholder: 'Search files',
          ariaLabel: `Choose ${w.label}`,
          emptyText: 'No matching files.',
        })}
        <input type="hidden" data-var-key="${e(w.key)}" data-var-type="file_ref"
          value="${e(selected?.id ?? '')}" />
      </div>
    `;
  }

  // text | number | file_ref fallback (paste a durable ref when the host has
  // no inventory-search caller).
  const inputType = w.type === 'number' ? 'number' : 'text';
  const display = w.value === undefined || w.value === null ? '' : String(w.value);
  return `
    <div class="var-row">
      <label for="${e(id)}">${e(w.label)}${
    w.optional ? ' <span class="var-optional">optional</span>' : ''
  }</label>
      ${help}
      <input
        id="${e(id)}"
        type="${inputType}"
        data-var-key="${e(w.key)}"
        data-var-type="${w.type}"
        value="${e(display)}"
        ${w.type === 'file_ref' ? 'placeholder="file:…" spellcheck="false"' : ''}
      />
    </div>
  `;
};

/** Read a widget's current value back from the DOM. Accepts any
 *  element carrying `data-var-key` + `data-var-type` — callers
 *  typically receive it via a delegated `input`/`change` listener.
 *
 *  For `multi`, pass the container element (`.var-multi-grid`) or
 *  any of its inner checkboxes — the reader walks up/down to find
 *  all option checkboxes and returns the selected subset.
 */
export const readWidgetValue = (el: Element): unknown => {
  const type = (el as HTMLElement).dataset.varType;
  const key = (el as HTMLElement).dataset.varKey;
  if (!type || !key) return undefined;

  if (type === 'boolean') {
    return (el as HTMLInputElement).checked;
  }
  if (type === 'number') {
    const raw = (el as HTMLInputElement).value;
    if (raw === '') return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  if (type === 'multi') {
    // Find the container, then every option checkbox inside.
    const container =
      (el as HTMLElement).matches('.var-multi-grid')
        ? (el as HTMLElement)
        : (el as HTMLElement).closest('.var-multi-grid');
    if (!container) return [];
    const boxes = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-option]'),
    );
    return boxes.filter((b) => b.checked).map((b) => b.dataset.option!);
  }
  // text | number(fallthrough handled above) | select | secret
  return (el as HTMLInputElement | HTMLSelectElement).value;
};

/** Pure validator — returns an error message if the current value
 *  violates the widget's constraints, or null when it's acceptable.
 *  Only flags structural mismatches (required-but-empty, enum
 *  not-in-options). Install-dialog callers already soften
 *  "required" into a non-blocker; they just display the message. */
export const validateWidgetValue = (
  w: WidgetShape,
  value: unknown,
): string | null => {
  if (w.optional) return null;

  if (w.type === 'text' || w.type === 'secret' || w.type === 'file_ref') {
    if (typeof value !== 'string' || value.trim() === '') return 'Required';
    return null;
  }
  if (w.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Must be a number';
    return null;
  }
  if (w.type === 'boolean') {
    return null; // always valid
  }
  if (w.type === 'select') {
    const options = w.options ?? [];
    if (options.length === 0) return null;
    if (typeof value !== 'string' || !options.includes(value)) {
      return `Must be one of ${options.join(', ')}`;
    }
    return null;
  }
  if (w.type === 'multi') {
    if (!Array.isArray(value) || value.length === 0) return 'Choose at least one';
    return null;
  }
  return null;
};

// ────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────

const isValueHint = (v: VariableDefault): v is ValueHint =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && 'label' in v;

const mapHintType = (hint: ValueHint): WidgetType => {
  switch (hint.type) {
    case 'secret':
      return 'secret';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'enum':
      return 'select';
    case 'file_ref':
      return 'file_ref';
    case 'url':
    case 'text':
    default:
      return 'text';
  }
};

const formatKey = (k: string): string =>
  k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
