/** Type-discriminated label + input primitive.
 *
 *  Covers the four value-type inputs that repeat across kitchen's
 *  variable-form and step-inspector renderers:
 *    - string  → `<input type="text">`
 *    - number  → `<input type="number">`
 *    - boolean → `<input type="checkbox">` wrapped inside the label
 *      so the full label text is a click target
 *    - enum    → `<select>` populated from `enumOptions`
 *
 *  For readonly / unsupported values (refs, nested objects, anything
 *  outside the four primitive types), pass `readonlyDisplay` to emit
 *  a disabled text input showing the serialized value.
 *
 *  Callers wrap the returned HTML with whatever `<div class="...">`
 *  their surface needs — the primitive emits `<label>` + input only.
 *  Boolean outputs a single combined `<label>` containing both the
 *  checkbox and the label text, so callers typically apply a bool-
 *  specific wrapper class outside.
 *
 *  Install-page variable rows are intentionally NOT a consumer —
 *  their interleaved help-paragraph placement (between label and
 *  input for text/number, outside the label for boolean) doesn't
 *  fit the same primitive without bloating the API.
 */

import { e } from '../template.js';

export type TypedFieldType = 'string' | 'number' | 'boolean' | 'enum';

export interface TypedFieldProps {
  /** `<label for=id>` → the `<input>`/`<select>` id. Must be unique
   *  on the page. */
  id: string;
  /** Display label. HTML-escaped. */
  label: string;
  /** Current value. Checkbox reads truthiness; select matches via
   *  `String(value)` against enumOptions; text/number stringify. */
  value: unknown;
  /** Which element shape to render. */
  type: TypedFieldType;
  /** Required when `type === 'enum'`. First option is the default
   *  selection when `value` doesn't match any entry. */
  enumOptions?: readonly string[];
  /** Applied as `data-${key}="${value}"` on the input/select/checkbox.
   *  Every value is HTML-escaped; keys are assumed safe identifier
   *  strings (no escaping). */
  data?: Record<string, string>;
  /** HTML inserted inside the label after the label text — typically
   *  a hint span (e.g. `<span class="var-type-hint">string</span>`).
   *  Caller is responsible for safely producing any HTML here; the
   *  primitive does not escape it. */
  labelSuffix?: string;
  /** When set, emit a readonly text input carrying this display text
   *  instead of a live input. Used for unsupported value shapes
   *  (refs, JSON objects, missing values). The `type` discriminator
   *  is ignored in this mode. */
  readonlyDisplay?: string;
}

export const typedField = (props: TypedFieldProps): string => {
  const { id, label, value, type, enumOptions, data, labelSuffix, readonlyDisplay } = props;
  const idEsc = e(id);
  const labelHtml = `${e(label)}${labelSuffix ? ` ${labelSuffix}` : ''}`;
  const dataAttrs = data
    ? Object.entries(data)
        .map(([k, v]) => `data-${k}="${e(v)}"`)
        .join('\n    ')
    : '';

  if (readonlyDisplay !== undefined) {
    return `
      <label for="${idEsc}">${labelHtml}</label>
      <input
        type="text"
        id="${idEsc}"
        value="${e(readonlyDisplay)}"
        readonly
        tabindex="-1"
      />
    `;
  }

  if (type === 'boolean') {
    // Checkbox lives inside the label so the full label text is a
    // click target. Caller typically wraps with a bool-specific div.
    return `
      <label for="${idEsc}">
        <input
          type="checkbox"
          id="${idEsc}"
          ${dataAttrs}
          ${value ? 'checked' : ''}
        />
        ${labelHtml}
      </label>
    `;
  }

  if (type === 'enum') {
    const options = enumOptions ?? [];
    const current = String(value ?? options[0] ?? '');
    const optionHtml = options
      .map((opt) => {
        const optStr = String(opt);
        const selected = optStr === current ? 'selected' : '';
        return `<option value="${e(optStr)}" ${selected}>${e(optStr)}</option>`;
      })
      .join('');
    return `
      <label for="${idEsc}">${labelHtml}</label>
      <select id="${idEsc}" ${dataAttrs}>
        ${optionHtml}
      </select>
    `;
  }

  // string | number → text-like input
  const inputType = type === 'number' ? 'number' : 'text';
  const displayValue = value === undefined || value === null ? '' : String(value);
  return `
    <label for="${idEsc}">${labelHtml}</label>
    <input
      type="${inputType}"
      id="${idEsc}"
      ${dataAttrs}
      value="${e(displayValue)}"
    />
  `;
};
