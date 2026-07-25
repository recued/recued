/** Phase G (D-109) — server status pill render helper.
 *
 *  Pure HTML string builder consumed by both the popup and sidebar
 *  headers. Severity logic lives in `@recued/contracts`'s
 *  `computePillState` — this module only renders. */

import {
  computePillState,
  formatPillUptime,
  type PillState,
  type ServerHeartbeatSnapshot,
} from '@recued/contracts';

/** Map a pill dot color to a CSS class the page style sheet owns.
 *  Keeps the render output minimal (no inline styles). */
const DOT_CLASS: Record<PillState['dot'], string> = {
  gray: 'server-pill--gray',
  red: 'server-pill--red',
  orange: 'server-pill--orange',
  amber: 'server-pill--amber',
  green: 'server-pill--green',
};

export interface ServerPillOptions {
  /** Whether the pill should be clickable. When `false` the HTML
   *  renders as a `<span>` rather than `<button>` — useful for the
   *  popup's read-only summary views. */
  clickable?: boolean;
}

/** Build the pill label text: `Server · <state>` where state is one
 *  of `running` (`<uptime>`), `paused`, `busy`, `attention`, `offline`. */
const formatLabel = (state: PillState): string => {
  if (state.label === 'running') {
    const uptime = formatPillUptime(state.uptime_s);
    return `Server · ${uptime}`;
  }
  return `Server · ${state.label}`;
};

/** Render the pill as an HTML string. Caller inserts into a host
 *  element (popup / sidebar header) via innerHTML. Escaping is handled
 *  by the fixed content set — labels come from a known enum. */
export const renderServerPill = (
  snapshot: ServerHeartbeatSnapshot | null,
  options: ServerPillOptions = {},
  now: number = Date.now(),
): string => {
  if (!snapshot || snapshot.server_id === null) {
    // Hidden when no server is paired — caller keeps the slot blank.
    return '';
  }
  const state = computePillState(snapshot, now);
  // D-188 — the master-pause state renders a neutral PAUSE glyph (drawn +
  // token-colored by CSS) under its own `--paused` modifier, instead of a
  // severity dot, so it reads as a deliberate user state, not an error.
  const isPausedGlyph = state.glyph === 'pause';
  const className = isPausedGlyph
    ? 'server-pill server-pill--paused'
    : `server-pill ${DOT_CLASS[state.dot]}`;
  const indicator = isPausedGlyph
    ? '<span class="server-pill__glyph" aria-hidden="true"></span>'
    : '<span class="server-pill__dot" aria-hidden="true"></span>';
  const tag = options.clickable === false ? 'span' : 'button';
  const clickableAttrs =
    options.clickable === false
      ? ''
      : ' data-action="server-pill-click" type="button"';
  return (
    `<${tag} class="${className}" aria-label="${state.aria}"${clickableAttrs}>` +
    indicator +
    `<span class="server-pill__label">${formatLabel(state)}</span>` +
    `</${tag}>`
  );
};

/** Re-export the severity helper so callers don't need two imports. */
export { computePillState };
