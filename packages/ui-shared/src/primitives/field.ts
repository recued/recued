/** Field primitives.
 *
 *  A *form row* is the label + control pair used throughout the options
 *  page (LLM slot, Sync form, Cloud device-name, …). The built-in HTML
 *  `<input>` + `<select>` helpers keep attribute handling uniform
 *  (escaping, `data-*`, disabled) without locking callers into a
 *  specific shape — they can still hand-roll custom markup when needed.
 *
 *  All colour + focus state is scoped to `.rx-input` / `.rx-select` so
 *  nesting a field inside a flash banner or table cell doesn't inherit
 *  odd styling from an ancestor-class rule.
 */

import { e } from '../template.js';

// ────────────────────────────────────────────────────────────────
// Form row
// ────────────────────────────────────────────────────────────────

export interface FormRowProps {
  /** Visible label. */
  label: string;
  /** `for` + `id` binding so the label focuses the control. */
  htmlFor?: string;
  /** Control markup (input, select, checkbox, custom). */
  control: string;
  /** Optional hint below the control. */
  hint?: string;
  /** Inline variant — label and control sit on one row, label isn't a
   *  fixed-width column. Useful inside dense tables/menus. */
  inline?: boolean;
}

export const formRow = (props: FormRowProps): string => {
  const classes = ['rx-form-row', 'form-row'];
  if (props.inline) classes.push('rx-form-row-inline', 'form-row-inline');
  const forAttr = props.htmlFor ? ` for="${e(props.htmlFor)}"` : '';
  const hint = props.hint
    ? `<p class="rx-field-hint field-hint">${e(props.hint)}</p>`
    : '';
  return `
    <div class="${classes.join(' ')}">
      <label${forAttr}>${e(props.label)}</label>
      ${props.control}
      ${hint}
    </div>
  `;
};

// ────────────────────────────────────────────────────────────────
// Inputs
// ────────────────────────────────────────────────────────────────

export interface TextInputProps {
  id?: string;
  name?: string;
  value?: string;
  placeholder?: string;
  type?: 'text' | 'password' | 'email' | 'number' | 'url';
  autocomplete?: string;
  disabled?: boolean;
  readonly?: boolean;
  spellcheck?: boolean;
  ariaLabel?: string;
  /** Numeric-input minimum. */
  min?: number;
  /** Numeric-input maximum. */
  max?: number;
  /** Arbitrary data-* attributes. */
  data?: Record<string, string>;
  extraClass?: string;
}

export const textInput = (props: TextInputProps): string => {
  const classes = ['rx-input', props.extraClass ?? ''].filter(Boolean).join(' ');
  const attrs: string[] = [`class="${classes}"`, `type="${props.type ?? 'text'}"`];
  if (props.id) attrs.push(`id="${e(props.id)}"`);
  if (props.name) attrs.push(`name="${e(props.name)}"`);
  if (props.value !== undefined) attrs.push(`value="${e(props.value)}"`);
  if (props.placeholder) attrs.push(`placeholder="${e(props.placeholder)}"`);
  if (props.autocomplete) attrs.push(`autocomplete="${e(props.autocomplete)}"`);
  if (props.disabled) attrs.push('disabled');
  if (props.readonly) attrs.push('readonly');
  if (props.spellcheck === false) attrs.push('spellcheck="false"');
  if (props.ariaLabel) attrs.push(`aria-label="${e(props.ariaLabel)}"`);
  if (props.min !== undefined) attrs.push(`min="${props.min}"`);
  if (props.max !== undefined) attrs.push(`max="${props.max}"`);
  if (props.data) {
    for (const [k, v] of Object.entries(props.data)) {
      attrs.push(`data-${e(k)}="${e(v)}"`);
    }
  }
  return `<input ${attrs.join(' ')} />`;
};

// ────────────────────────────────────────────────────────────────
// Select
// ────────────────────────────────────────────────────────────────

export interface SelectOption {
  value: string;
  label: string;
  selected?: boolean;
  disabled?: boolean;
}

export interface SelectProps {
  id?: string;
  name?: string;
  options: SelectOption[];
  disabled?: boolean;
  ariaLabel?: string;
  data?: Record<string, string>;
  extraClass?: string;
}

export const select = (props: SelectProps): string => {
  const classes = ['rx-select', props.extraClass ?? ''].filter(Boolean).join(' ');
  const attrs: string[] = [`class="${classes}"`];
  if (props.id) attrs.push(`id="${e(props.id)}"`);
  if (props.name) attrs.push(`name="${e(props.name)}"`);
  if (props.disabled) attrs.push('disabled');
  if (props.ariaLabel) attrs.push(`aria-label="${e(props.ariaLabel)}"`);
  if (props.data) {
    for (const [k, v] of Object.entries(props.data)) {
      attrs.push(`data-${e(k)}="${e(v)}"`);
    }
  }
  const opts = props.options.map((o) => {
    const oAttrs: string[] = [`value="${e(o.value)}"`];
    if (o.selected) oAttrs.push('selected');
    if (o.disabled) oAttrs.push('disabled');
    return `<option ${oAttrs.join(' ')}>${e(o.label)}</option>`;
  }).join('');
  return `<select ${attrs.join(' ')}>${opts}</select>`;
};

// ────────────────────────────────────────────────────────────────
// Checkbox
// ────────────────────────────────────────────────────────────────

export interface CheckboxProps {
  id?: string;
  name?: string;
  checked?: boolean;
  disabled?: boolean;
  /** Label shown to the right of the box. */
  label: string;
  data?: Record<string, string>;
}

export const checkbox = (props: CheckboxProps): string => {
  const attrs: string[] = ['class="rx-checkbox"', 'type="checkbox"'];
  if (props.id) attrs.push(`id="${e(props.id)}"`);
  if (props.name) attrs.push(`name="${e(props.name)}"`);
  if (props.checked) attrs.push('checked');
  if (props.disabled) attrs.push('disabled');
  if (props.data) {
    for (const [k, v] of Object.entries(props.data)) {
      attrs.push(`data-${e(k)}="${e(v)}"`);
    }
  }
  const forAttr = props.id ? ` for="${e(props.id)}"` : '';
  return `
    <label class="rx-checkbox-row"${forAttr}>
      <input ${attrs.join(' ')} />
      <span>${e(props.label)}</span>
    </label>
  `;
};

// ────────────────────────────────────────────────────────────────
// Field hint (standalone — useful outside a form row)
// ────────────────────────────────────────────────────────────────

export const fieldHint = (text: string): string =>
  `<p class="rx-field-hint field-hint">${e(text)}</p>`;

// ────────────────────────────────────────────────────────────────
// Styles — self-contained, no ancestor coupling
// ────────────────────────────────────────────────────────────────

export const FIELD_STYLES = `
.rx-form-row {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}
.rx-form-row:last-of-type { margin-bottom: 0; }
.rx-form-row > label {
  font-size: 13px;
  color: var(--fg-dim, var(--fg-muted));
  font-weight: 500;
}
.rx-form-row-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  grid-template-columns: none;
}

.rx-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 4px;
  font-size: 13px;
  font-family: inherit;
  background: var(--bg);
  color: var(--fg);
}
.rx-input:focus { outline: none; border-color: var(--accent); }
.rx-input:disabled { opacity: 0.6; cursor: not-allowed; }

.rx-select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 4px;
  font-size: 13px;
  font-family: inherit;
  background: var(--bg);
  color: var(--fg);
}
.rx-select:focus { outline: none; border-color: var(--accent); }
.rx-select:disabled { opacity: 0.6; cursor: not-allowed; }

.rx-checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--fg);
  cursor: pointer;
}
.rx-checkbox { accent-color: var(--accent); }

.rx-field-hint {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--fg-muted);
  line-height: 1.4;
  grid-column: 1 / -1;
}
`;
