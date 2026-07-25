/** Flash banner primitive.
 *
 *  Ephemeral one-line feedback (saved, error, merge-freeze warning).
 *  Three tones — `ok`, `error`, `warn` — each with a distinct colour
 *  drawn from the global palette. Safe to nest inside a section: the
 *  CSS uses self-scoped selectors only.
 */

import { e } from '../template.js';

export type FlashTone = 'ok' | 'error' | 'warn';

export interface FlashProps {
  tone: FlashTone;
  /** Plain-text message. Use `htmlMessage` if you need markup. */
  message?: string;
  /** Raw HTML message (callers must escape untrusted substrings). */
  htmlMessage?: string;
  /** Optional prefix emitted before the message in bold (e.g. "Error"). */
  label?: string;
}

export const flash = (props: FlashProps): string => {
  const body = props.htmlMessage ?? (props.message ? e(props.message) : '');
  const label = props.label ? `<strong>${e(props.label)}</strong> ` : '';
  // Keep legacy `.flash .flash-ok|-error` classes so the existing page
  // stylesheet still picks them up; add `.rx-flash*` to make the
  // primitive self-contained for hosts that only ship our stylesheet.
  const legacy = props.tone === 'warn' ? 'flash flash-warn' : `flash flash-${props.tone}`;
  return `<div class="rx-flash rx-flash-${props.tone} ${legacy}">${label}${body}</div>`;
};

export const flashOk = (message: string): string => flash({ tone: 'ok', message });
export const flashError = (message: string, label = 'Error'): string =>
  flash({ tone: 'error', message, label });
export const flashWarn = (message: string): string => flash({ tone: 'warn', message });

export const FLASH_STYLES = `
.rx-flash {
  padding: 10px 14px;
  border-radius: 6px;
  margin-bottom: 18px;
  font-size: 13px;
  line-height: 1.4;
  border: 1px solid transparent;
}
.rx-flash-ok {
  background: var(--surface-sunk);
  color: var(--fg);
  border-color: var(--border);
}
.rx-flash-error {
  background: var(--danger-weak);
  color: var(--danger);
  border-color: var(--danger);
}
.rx-flash-warn {
  background: var(--surface-sunk);
  color: var(--fg);
  border-color: var(--border-strong);
}
`;
