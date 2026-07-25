/** Inline message primitive.
 *
 *  One-line feedback that lives *inside* a panel or form row —
 *  distinct from the full-width `flash` banner primitive. Think:
 *  "invalid input", "over budget", "connection failed", "saved" —
 *  small text next to the control that caused it.
 *
 *  Four tones match the existing feature-specific classes they
 *  replace:
 *    error  — `.sync-error`, `.server-auth-error`, `.cloud-error`
 *    warn   — `.token-warning`
 *    ok     — inline success hint (e.g. "exported ✓")
 *    hint   — `.signout-skip-hint`, neutral muted tip
 *
 *  Self-scoped styles (`.rx-msg*`) with colours drawn from the shared
 *  palette so nesting in a form row or inside a flash never disturbs
 *  their look.
 */

import { e } from '../template.js';

export type MessageTone = 'error' | 'warn' | 'ok' | 'hint';

export interface InlineMessageProps {
  tone: MessageTone;
  message?: string;
  /** Raw HTML body (caller escapes untrusted substrings). */
  htmlMessage?: string;
  /** Emit `role="alert"` so assistive tech picks it up. Defaults to
   *  true for `error`/`warn`, false otherwise. */
  alert?: boolean;
}

export const inlineMessage = (props: InlineMessageProps): string => {
  const body = props.htmlMessage ?? (props.message ? e(props.message) : '');
  if (!body) return '';
  const alert = props.alert ?? (props.tone === 'error' || props.tone === 'warn');
  const roleAttr = alert ? ' role="alert"' : '';
  return `<p class="rx-msg rx-msg-${props.tone}"${roleAttr}>${body}</p>`;
};

export const inlineError = (message: string): string =>
  inlineMessage({ tone: 'error', message });
export const inlineWarn = (message: string): string =>
  inlineMessage({ tone: 'warn', message });
export const inlineOk = (message: string): string =>
  inlineMessage({ tone: 'ok', message });
export const inlineHint = (message: string): string =>
  inlineMessage({ tone: 'hint', message });

export const MESSAGE_STYLES = `
.rx-msg {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.4;
}
.rx-msg-error { color: var(--danger); }
.rx-msg-warn  { color: var(--fg); }
.rx-msg-ok    { color: var(--fg); }
.rx-msg-hint  { color: var(--fg-muted); }
`;
