/** Status / badge primitives.
 *
 *  `statusDot` — a small coloured disc used to signal connection
 *  health (sync, cloud heartbeat, endpoint, schedule). Rendered inline
 *  so it can sit next to a label without disturbing line height.
 *
 *  `badge` — a pill-shaped tag used for instance-kind labels, health
 *  chips, and "optional" connection markers.
 *
 *  Both render with self-scoped classes (`.rx-dot*` / `.rx-badge*`)
 *  that carry their own colours — works anywhere a caller drops them.
 */

import { e } from '../template.js';

// ────────────────────────────────────────────────────────────────
// Status dot
// ────────────────────────────────────────────────────────────────

export type StatusTone =
  | 'ok'          // green — healthy / online
  | 'idle'        // amber — reachable but inactive
  | 'off'         // red — offline / unhealthy
  | 'online'      // alias of ok
  | 'offline'     // alias of off
  | 'active'      // green — endpoint reachable and credentialed
  | 'configured'  // amber — endpoint configured but no key
  | 'none';       // neutral — endpoint not set

/** Inline coloured disc. Caller is responsible for surrounding text. */
export const statusDot = (tone: StatusTone): string =>
  `<span class="rx-dot rx-dot-${tone}"></span>`;

// ────────────────────────────────────────────────────────────────
// Badge
// ────────────────────────────────────────────────────────────────

export type BadgeTone =
  | 'neutral'
  | 'ok'
  | 'idle'
  | 'off'
  | 'accent';

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  /** Uppercase + letter-spacing treatment for type-labels. */
  uppercase?: boolean;
  /** Native `title` tooltip attribute. */
  title?: string;
  /** Render label as raw HTML (e.g. when it contains an icon entity). */
  htmlLabel?: boolean;
  /** Extra class tokens appended after the primitive classes. Use this
   *  to preserve legacy page-level classes (e.g. `vault-badge`,
   *  `sched-badge-ok`) so the existing kitchen.html / sidebar.html
   *  stylesheet continues to paint the pill. */
  extraClass?: string;
}

export const badge = (props: BadgeProps): string => {
  const tone = props.tone ?? 'neutral';
  const classes = ['rx-badge', `rx-badge-${tone}`];
  if (props.uppercase) classes.push('rx-badge-upper');
  if (props.extraClass) classes.push(props.extraClass);
  const attrs: string[] = [`class="${classes.join(' ')}"`];
  if (props.title) attrs.push(`title="${e(props.title)}"`);
  const body = props.htmlLabel ? props.label : e(props.label);
  return `<span ${attrs.join(' ')}>${body}</span>`;
};

// ────────────────────────────────────────────────────────────────
// Styles — self-contained, no ancestor coupling
// ────────────────────────────────────────────────────────────────

export const STATUS_STYLES = `
.rx-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
  background: var(--border);
}
.rx-dot-ok,      .rx-dot-online,  .rx-dot-active     { background: var(--fg); }
.rx-dot-idle,    .rx-dot-configured                  { background: var(--fg-muted); }
.rx-dot-off,     .rx-dot-offline                     { background: var(--danger); }
.rx-dot-none                                         { background: var(--border); }

.rx-badge {
  display: inline-block;
  font-size: 10px;
  padding: 1px 8px;
  border-radius: 10px;
  font-weight: 600;
  line-height: 1.6;
  background: var(--surface-sunk);
  color: var(--fg-muted);
  border: 1px solid transparent;
}
.rx-badge-upper {
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.rx-badge-neutral { background: var(--surface-sunk); color: var(--fg-muted); }
.rx-badge-ok      { background: var(--surface-sunk); color: var(--fg); }
.rx-badge-idle    { background: var(--surface-sunk); color: var(--fg-muted); }
.rx-badge-off     { background: var(--danger-weak); color: var(--danger); }
.rx-badge-accent  { background: var(--accent-weak); color: var(--accent); }
`;
