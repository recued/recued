/** Button primitive.
 *
 *  One function, every variant the options page needs. Returns a string
 *  of HTML, ready to drop into any nested host (section, form, table
 *  cell, flash banner) without the styling breaking — the companion
 *  CSS below uses only self-scoped `.rx-btn*` selectors and reads
 *  colours from the global CSS custom properties defined in the page
 *  shell (`--accent`, `--fail`, `--fg`, …).
 *
 *  The renderers that currently emit `class="btn btn-primary"` keep
 *  working: we kept those legacy classes on each variant for backward
 *  compatibility. New call sites should prefer the exported helper.
 */

import { e } from '../template.js';

export type ButtonVariant =
  | 'primary'     // solid accent background
  | 'secondary'   // neutral outlined (default)
  | 'danger'      // outlined red (destructive)
  | 'danger-text' // transparent + red text (inline destructive)
  | 'link'        // anchor-like text
  | 'oauth';      // provider button with icon + full width

export type ButtonSize = 'xs' | 'sm' | 'md';

export interface ButtonProps {
  label: string;
  /** Visual variant. Defaults to `secondary`. */
  variant?: ButtonVariant;
  /** Size. Defaults to `md`. */
  size?: ButtonSize;
  /** Maps to `data-action` for event delegation. */
  action?: string;
  /** Arbitrary extra data-* attributes (keys become `data-<k>`). */
  data?: Record<string, string>;
  /** HTML `type`. Defaults to `button` to avoid accidental submits. */
  type?: 'button' | 'submit' | 'reset';
  /** Optional id. */
  id?: string;
  /** Disabled state. */
  disabled?: boolean;
  /** Accessible disabled state. Unlike native `disabled`, this deliberately
   *  keeps the control in the focus order; the owning handler must still fence
   *  activation. Useful while an already-started action is busy. */
  ariaDisabled?: boolean;
  /** Announces an asynchronous action still in progress. */
  ariaBusy?: boolean;
  /** Extra class tokens appended after the primitive classes. */
  extraClass?: string;
  /** Set to true to render label as raw HTML (e.g., when it contains
   *  icons). Caller is responsible for escaping. */
  htmlLabel?: boolean;
  /** Native `title` tooltip attribute. */
  title?: string;
  /** Accessible name — for buttons whose visible label is ambiguous on
   *  its own (e.g. a repeater "Remove" that must announce which row). */
  ariaLabel?: string;
}

const legacyClasses = (variant: ButtonVariant, size: ButtonSize): string => {
  // Legacy classes kept so the existing options.html stylesheet still
  // applies — primitives are additive, not a hard cutover.
  const legacy: string[] = ['btn'];
  if (size === 'xs') legacy.push('btn-xs');
  if (size === 'sm') legacy.push('btn-sm');
  switch (variant) {
    case 'primary':     legacy.push('btn-primary'); break;
    case 'secondary':   legacy.push('btn-secondary'); break;
    case 'danger':      legacy.push('btn-danger'); break;
    case 'danger-text': legacy.push('btn-danger-text'); break;
    case 'link':        legacy.push('btn-link'); break;
    case 'oauth':       legacy.push('btn-oauth'); break;
  }
  return legacy.join(' ');
};

export const button = (props: ButtonProps): string => {
  const variant = props.variant ?? 'secondary';
  const size = props.size ?? 'md';
  const classes = [
    'rx-btn',
    `rx-btn-${variant}`,
    `rx-btn-${size}`,
    legacyClasses(variant, size),
    props.extraClass ?? '',
  ].filter(Boolean).join(' ');

  const attrs: string[] = [`class="${classes}"`, `type="${props.type ?? 'button'}"`];
  if (props.id) attrs.push(`id="${e(props.id)}"`);
  if (props.action) attrs.push(`data-action="${e(props.action)}"`);
  if (props.disabled) attrs.push('disabled');
  if (props.ariaDisabled) attrs.push('aria-disabled="true"');
  if (props.ariaBusy) attrs.push('aria-busy="true"');
  if (props.title) attrs.push(`title="${e(props.title)}"`);
  if (props.ariaLabel) attrs.push(`aria-label="${e(props.ariaLabel)}"`);
  if (props.data) {
    for (const [k, v] of Object.entries(props.data)) {
      attrs.push(`data-${e(k)}="${e(v)}"`);
    }
  }

  const body = props.htmlLabel ? props.label : e(props.label);
  return `<button ${attrs.join(' ')}>${body}</button>`;
};

/** Self-contained CSS for the button primitive. No ancestor selectors —
 *  every rule targets `.rx-btn*` directly so a button inside a table
 *  cell, flash banner, or flex row looks identical. */
export const BUTTON_STYLES = `
.rx-btn {
  padding: 8px 16px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  font-family: inherit;
  background: var(--bg);
  color: var(--fg);
  line-height: 1.2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.rx-btn:hover:not(:disabled):not([aria-disabled="true"]) { background: var(--surface-sunk); }
.rx-btn:disabled, .rx-btn[aria-disabled="true"] { cursor: not-allowed; opacity: 0.5; }

.rx-btn-xs { padding: 4px 10px; font-size: 11px; }
.rx-btn-sm { padding: 6px 12px; font-size: 12px; }
.rx-btn-md { /* default sizing already on .rx-btn */ }

.rx-btn-primary {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
}
.rx-btn-primary:hover:not(:disabled):not([aria-disabled="true"]) {
  background: var(--accent-dim, var(--accent));
  color: var(--on-accent);
}

.rx-btn-secondary { /* inherits .rx-btn defaults */ }

.rx-btn-danger {
  color: var(--danger);
  border-color: var(--danger);
  background: var(--surface);
}
.rx-btn-danger:hover:not(:disabled):not([aria-disabled="true"]) { background: var(--danger-weak); }

/* "text" means text: quiet at rest (no border), so a repeated inline
 * destructive action (per-row Remove / Revoke) doesn't shout N times per
 * page. The border and wash return on hover to confirm the target.
 * Promoted from identical scoped overrides in both kitchen editors. */
.rx-btn-danger-text {
  color: var(--danger);
  border-color: transparent;
  background: transparent;
}
.rx-btn-danger-text:hover:not(:disabled):not([aria-disabled="true"]) {
  background: var(--danger-weak);
  border-color: var(--danger);
}

.rx-btn-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
  text-decoration: underline;
  line-height: inherit;
  height: auto;
}
.rx-btn-link:hover:not(:disabled):not([aria-disabled="true"]) { opacity: 0.8; background: none; }

.rx-btn-oauth {
  width: 100%;
  padding: 10px 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
}
.rx-btn-oauth:hover:not(:disabled):not([aria-disabled="true"]) {
  background: var(--surface-sunk);
  border-color: var(--border-strong, var(--border));
}
`;
