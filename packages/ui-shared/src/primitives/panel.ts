/** Panel primitive.
 *
 *  A padded, bordered card grouping related content inside a section.
 *  Existing call sites it replaces:
 *    neutral  — `.signout-flow`, `.signout-cleared-note`, `.inst-this`
 *    warn     — `.login-gate` (amber border, neutral bg)
 *    danger   — `.clear-data-warning` (red border + red-tinted bg)
 *    info     — (new tone, accent border) for future informational
 *               callouts
 *
 *  Self-scoped styles — panels can nest (panel inside a panel inside a
 *  section) without cascade surprises. Caller passes an optional title
 *  and the body HTML.
 */

import { e } from '../template.js';

export type PanelTone = 'neutral' | 'warn' | 'danger' | 'info';

export interface PanelProps {
  tone?: PanelTone;
  /** Optional heading rendered above the body. */
  title?: string;
  /** Body HTML (callers assemble freely). */
  body: string;
  /** Compact padding variant for tighter nested panels. */
  compact?: boolean;
  /** Extra class tokens (kept for legacy layout classes like
   *  `.signout-flow` that still drive outer margins). */
  extraClass?: string;
  /** Optional `role` — e.g. `status`, `alert`. */
  role?: string;
}

export const panel = (props: PanelProps): string => {
  const tone = props.tone ?? 'neutral';
  const classes = ['rx-panel', `rx-panel-${tone}`];
  if (props.compact) classes.push('rx-panel-compact');
  if (props.extraClass) classes.push(props.extraClass);
  const roleAttr = props.role ? ` role="${e(props.role)}"` : '';
  const title = props.title
    ? `<h3 class="rx-panel-title">${e(props.title)}</h3>`
    : '';
  return `
    <div class="${classes.join(' ')}"${roleAttr}>
      ${title}
      ${props.body}
    </div>
  `;
};

export const PANEL_STYLES = `
.rx-panel {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  font-size: 13px;
  line-height: 1.5;
}
.rx-panel-compact { padding: 8px 12px; border-radius: 4px; font-size: 12px; }
.rx-panel-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.rx-panel > *:last-child { margin-bottom: 0; }

.rx-panel-neutral { /* inherits .rx-panel defaults */ }

.rx-panel-warn {
  border-color: var(--border-strong);
}

.rx-panel-danger {
  border-color: var(--danger);
  background: var(--danger-weak);
}
.rx-panel-danger .rx-panel-title { color: var(--danger); }

.rx-panel-info {
  border-color: var(--accent);
  background: var(--accent-weak);
}
.rx-panel-info .rx-panel-title { color: var(--accent); }
`;
