/** Aggregated primitive CSS.
 *
 *  Every primitive module exports a `*_STYLES` constant with its own
 *  self-scoped rules (no `.parent .child` ancestor chains). The
 *  `PRIMITIVE_STYLES` string below concatenates them in a deterministic
 *  order so a host page can inject the whole primitive layer with one
 *  `<style>` tag — or a consumer can cherry-pick a single module's
 *  constant if it only wants, say, the button primitive.
 *
 *  The palette at the top keeps legacy aliases used by older primitive
 *  call sites pointed at the D-174 canonical shell tokens. It does not
 *  introduce separate ok/warn hues.
 */

import { BUTTON_STYLES } from './button.js';
import { SECTION_STYLES } from './section.js';
import { FLASH_STYLES } from './flash.js';
import { FIELD_STYLES } from './field.js';
import { STATUS_STYLES } from './status.js';
import { CODE_STYLES } from './code.js';
import { TABLE_STYLES } from './table.js';
import { ACTION_BAR_STYLES } from './action-bar.js';
import { MESSAGE_STYLES } from './message.js';
import { PANEL_STYLES } from './panel.js';
import { EMPTY_HINT_STYLES } from './empty-hint.js';

const PALETTE_FALLBACKS = `
:root {
  --bg-soft: var(--surface-sunk);
  --accent-soft: var(--accent-weak);
  --accent-dim: var(--accent);
  --fail: var(--danger);
  --fail-soft: var(--danger-weak);
  --ok: var(--fg);
  --ok-soft: var(--surface-sunk);
  --warn: var(--fg);
  --warn-soft: var(--surface-sunk);
  --bg-code: var(--surface-sunk);
  --fg-dim: var(--fg-muted);
  --panel-bg: var(--surface);
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --mono: var(--font-mono);
  --rx-bg: var(--surface);
  --rx-fg: var(--fg);
  --rx-muted: var(--fg-muted);
  --rx-divider: var(--border);
  --rx-input-bg: var(--surface);
  --rx-hover-bg: var(--surface-sunk);
  --rx-chip-bg: var(--surface-sunk);
  --rx-accent: var(--accent);
  --rx-accent-soft: var(--accent-weak);
  --rx-warning-fg: var(--fg);
  --rx-warning-bg: var(--surface-sunk);
  --rx-error-fg: var(--danger);
  --rx-error-bg: var(--danger-weak);
  --rx-error-border: var(--danger);
  --color-border: var(--border);
  --color-warning: var(--danger);
  --color-text-secondary: var(--fg-muted);
  --color-input-bg: var(--surface);
  --color-chip-bg: var(--surface-sunk);
  --color-chip-fg: inherit;
  --color-object-bg: transparent;
  --color-union-variant-bg: transparent;
}
`;

export const PRIMITIVE_STYLES = [
  PALETTE_FALLBACKS,
  BUTTON_STYLES,
  SECTION_STYLES,
  FLASH_STYLES,
  FIELD_STYLES,
  STATUS_STYLES,
  CODE_STYLES,
  TABLE_STYLES,
  ACTION_BAR_STYLES,
  MESSAGE_STYLES,
  PANEL_STYLES,
  EMPTY_HINT_STYLES,
].join('\n');
