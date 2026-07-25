/** D-119 Phase 3 — online indicator threshold helper.
 *
 *  Maps a device's last-heartbeat timestamp to one of three coarse
 *  states the Devices Dropdown surfaces as a coloured dot:
 *
 *    🟢 green  — heartbeat within the last 90 s
 *    🟡 amber  — heartbeat within the last 5 min
 *    ⚪ gray   — older than 5 min (or unknown)
 *
 *  Thresholds match observed reconnect timing (per spec): Pro
 *  heartbeat ticks every 3 s, server is always-connected, and the
 *  ext WS reconnects in seconds — so a device that hasn't shown up
 *  in 90 s is meaningfully out, and 5 min covers the recovery
 *  window before we treat the device as offline.
 *
 *  Pure module — no DOM, no globals beyond Date.now(). */

import { e } from '../template.js';

/** Coarse online state used by the dropdown. */
export type OnlineIndicator = 'green' | 'amber' | 'gray';

/** Threshold tuple, ms. Exported so tests + future tuning live in one place. */
export const ONLINE_INDICATOR_THRESHOLDS_MS = Object.freeze({
  green: 90_000,
  amber: 300_000,
});

/** Map (lastSeenMs, nowMs) → OnlineIndicator.
 *
 *  - `lastSeenMs == null` → `gray` (we have no signal at all).
 *  - Future-dated heartbeats (clock skew between devices) collapse to
 *    `green` rather than `gray` — clamping at 0 avoids a "stale" render
 *    on a device that's actively pinging from the future.
 */
export const computeOnlineIndicator = (
  lastSeenMs: number | null | undefined,
  nowMs: number = Date.now(),
): OnlineIndicator => {
  if (lastSeenMs == null) return 'gray';
  const ageMs = Math.max(0, nowMs - lastSeenMs);
  if (ageMs < ONLINE_INDICATOR_THRESHOLDS_MS.green) return 'green';
  if (ageMs < ONLINE_INDICATOR_THRESHOLDS_MS.amber) return 'amber';
  return 'gray';
};

/** Glyph used by the dropdown. Matches the spec's emoji legend so the
 *  rendered dropdown reads identically to the spec wireframe. */
const DOT_GLYPH: Record<OnlineIndicator, string> = {
  green: '🟢',
  amber: '🟡',
  gray: '⚪',
};

/** Human-readable aria label per state. */
const ARIA_LABEL: Record<OnlineIndicator, string> = {
  green: 'online',
  amber: 'recently seen',
  gray: 'offline',
};

/** Render the coloured dot inline. The class `device-dot--<state>` is
 *  what the page stylesheet themes; the emoji glyph is a fallback so
 *  the indicator still reads correctly when no stylesheet has loaded
 *  (popup test environment, options page, …). */
export const renderOnlineDot = (indicator: OnlineIndicator): string => {
  const aria = ARIA_LABEL[indicator];
  return (
    `<span class="device-dot device-dot--${indicator}"` +
    ` aria-label="${e(aria)}" title="${e(aria)}">` +
    `${DOT_GLYPH[indicator]}` +
    `</span>`
  );
};
