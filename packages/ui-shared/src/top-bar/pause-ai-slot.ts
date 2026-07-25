/** D-132 Phase 6 — Top-bar Pause-AI control.
 *
 *  Single-click emergency switch for background AI work — pauses
 *  every AI-surface housekeeping producer (idle cycles + reactive AI
 *  cascades) for a chosen duration, then auto-resumes. The control is
 *  reachable in 1 click from any sidebar surface; deliberately mirrors
 *  the placement convention of the auto-run circuit-breaker pause.
 *
 *  Two visual states:
 *    - Idle (no pause active)        — quiet "Pause AI" button. Click
 *                                      opens the duration picker.
 *    - Paused (pause window active)  — pill showing "Paused (resumes
 *                                      in 23m)" plus a "Resume now"
 *                                      button. Auto-clears when the
 *                                      pause window expires.
 *
 *  Duration picker fixed presets: 1h / 4h / 24h / Until I resume.
 *  No free-form input — typo-driven 9999-hour pauses are the failure
 *  mode worth avoiding (per `docs/d-132-spec.md` open question §4).
 *
 *  Wire surface — every click emits `data-action="..."` for the host
 *  dispatcher; the host calls `housekeeping.config.write` with
 *  `pause_background_ai_until` set to either:
 *    - `now + PAUSE_DURATIONS_MS[picked]` for the timed presets, or
 *    - `PAUSE_UNTIL_RESUME_TIMESTAMP` for "Until I resume", or
 *    - `null` for "Resume now".
 *
 *  Spec: `docs/d-132-spec.md` §A.9. */

import {
  PAUSE_DURATIONS_MS,
  PAUSE_UNTIL_RESUME_TIMESTAMP,
} from '@recued/contracts';
import { e } from '../template.js';

/** Concrete options surfaced in the duration picker. The closed list
 *  keeps the host's data-duration parser exhaustive. */
export type PauseAiDurationKey = '1h' | '4h' | '24h' | 'until_resume';

export const PAUSE_AI_DURATION_KEYS: ReadonlyArray<PauseAiDurationKey> = [
  '1h',
  '4h',
  '24h',
  'until_resume',
];

const DURATION_LABELS: Record<PauseAiDurationKey, string> = {
  '1h': 'Pause for 1h',
  '4h': 'Pause for 4h',
  '24h': 'Pause for 24h',
  'until_resume': 'Until I resume',
};

export interface PauseAiSlotState {
  /** Active pause window expiry timestamp (epoch ms), or `null` when
   *  no pause is active. The host reads this from
   *  `housekeeping_config.pause_background_ai_until` after every
   *  `housekeeping.config.read` + every `housekeeping.config.write`
   *  ack. Equal to `PAUSE_UNTIL_RESUME_TIMESTAMP` for the indefinite
   *  preset; the slot collapses that to "Until you resume" copy. */
  pausedUntil: number | null;
  /** True iff the duration picker dropdown is open. */
  pickerOpen: boolean;
  /** True while a `housekeeping.config.write` rpc that flips the
   *  pause field is in flight. Disables every action button. */
  writing: boolean;
  /** "now" for the live remaining-time render. The host passes
   *  `Date.now()` on every render tick (a 60s interval is enough —
   *  the slot only shows minute-precision). */
  now: number;
}

const formatRemaining = (untilMs: number, now: number): string => {
  const diff = Math.max(0, untilMs - now);
  if (diff < 60_000) {
    const seconds = Math.max(0, Math.floor(diff / 1000));
    return `${seconds}s`;
  }
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMin = minutes % 60;
    return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
};

const isIndefinitePause = (untilMs: number | null): boolean =>
  untilMs === PAUSE_UNTIL_RESUME_TIMESTAMP;

const isActivePause = (untilMs: number | null, now: number): boolean => {
  if (untilMs === null) return false;
  if (isIndefinitePause(untilMs)) return true;
  return now < untilMs;
};

const renderIdleButton = (state: PauseAiSlotState): string => {
  const open = state.pickerOpen;
  return `
    <button type="button"
      class="top-bar-pause-ai top-bar-pause-ai--idle${open ? ' top-bar-pause-ai--open' : ''}"
      data-action="housekeeping-pause-ai-toggle"
      aria-haspopup="menu"
      aria-expanded="${open ? 'true' : 'false'}"
      aria-label="Pause background AI"
      title="Pause background AI"
      ${state.writing ? 'disabled aria-busy="true"' : ''}>
      <span class="top-bar-pause-ai-glyph" aria-hidden="true">⏸</span>
      <span class="top-bar-pause-ai-label">Pause AI</span>
    </button>
  `;
};

const renderActivePill = (state: PauseAiSlotState): string => {
  const indefinite = isIndefinitePause(state.pausedUntil);
  const remaining = indefinite
    ? 'until you resume'
    : `resumes in ${formatRemaining(state.pausedUntil!, state.now)}`;
  return `
    <div class="top-bar-pause-ai top-bar-pause-ai--paused"
         role="status"
         aria-live="polite"
         data-paused-until="${e(String(state.pausedUntil))}">
      <span class="top-bar-pause-ai-glyph" aria-hidden="true">⏸</span>
      <span class="top-bar-pause-ai-status">Paused (${e(remaining)})</span>
      <button type="button"
        class="top-bar-pause-ai-resume"
        data-action="housekeeping-pause-ai-resume"
        aria-label="Resume background AI now"
        title="Resume background AI now"
        ${state.writing ? 'disabled aria-busy="true"' : ''}>
        Resume now
      </button>
    </div>
  `;
};

const renderPickerMenu = (state: PauseAiSlotState): string => {
  if (!state.pickerOpen) return '';
  return `
    <div class="top-bar-pause-ai-picker" role="menu" aria-label="Pause duration">
      ${PAUSE_AI_DURATION_KEYS.map((key) => `
        <button type="button"
          class="top-bar-pause-ai-picker-option"
          role="menuitem"
          data-action="housekeeping-pause-ai-pick"
          data-duration="${e(key)}"
          ${state.writing ? 'disabled aria-busy="true"' : ''}>
          ${e(DURATION_LABELS[key])}
        </button>
      `).join('')}
    </div>
  `;
};

export const renderPauseAiSlot = (state: PauseAiSlotState): string => {
  const active = isActivePause(state.pausedUntil, state.now);
  return `
    <div class="top-bar-pause-ai-anchor" data-active="${active ? 'true' : 'false'}">
      ${active ? renderActivePill(state) : renderIdleButton(state)}
      ${active ? '' : renderPickerMenu(state)}
    </div>
  `;
};

/** Resolve the `pause_background_ai_until` epoch ms the host should
 *  send to `housekeeping.config.write` for a given duration pick.
 *  Pure helper — no IO. The host owns `Date.now()` so this stays
 *  testable without freezing time. */
export const resolvePauseUntilMs = (
  duration: PauseAiDurationKey,
  now: number,
): number => {
  if (duration === 'until_resume') return PAUSE_UNTIL_RESUME_TIMESTAMP;
  const delta = PAUSE_DURATIONS_MS[duration];
  return now + delta;
};
