/** D-119 Phase 3/4 — top-bar Attention slot.
 *
 *  The counter button that anchors the Attention popover. Phase 3
 *  shipped the counter surface; Phase 4 adds aria-expanded + aria-haspopup
 *  so the same button doubles as the popover's accessible toggle.
 *
 *  Counter rules:
 *    - Zero blocking items → render a quiet inactive button (still
 *      occupies the slot for layout stability) with no badge.
 *    - Deferred items → add a subdued saved state and accessible count,
 *      never the active treatment or red badge.
 *    - 1+ items → highlight + numeric badge. `99+` is the cap so the
 *      badge stays one glyph wide.
 *
 *  Pure module. */

import { e } from '../template.js';

export interface AttentionSlotState {
  /** Unified work that needs the owner: approval gates, connected-action
   * asks, pending Chat plans, and connection-recovery checks. */
  blockingCount: number;
  /** Deliberately deferred, non-urgent items. They remain discoverable in the
   * popover and accessible name but never light the red blocking badge. */
  quietCount?: number;
  /** A quiet item becomes `ready` when its wait ends, `checking` while its
   * deliberate read is active, `retry` after its first failure, or `diagnosis`
   * once the bounded retry loop stops. `decision` and `closure` describe the
   * explicit choices after diagnosis. These change the neutral cue and
   * accessible copy without making the item blocking. */
  quietStatus?:
    | 'saved'
    | 'ready'
    | 'checking'
    | 'retry'
    | 'diagnosis'
    | 'decision'
    | 'closure';
  /** Whether the popover anchored to this button is currently open.
   *  Toggles the trigger's aria-expanded + a `--open` modifier the
   *  stylesheet can pin (e.g. background flash while popover is up). */
  open?: boolean;
}

const formatCount = (n: number): string => {
  if (n <= 0) return '';
  if (n > 99) return '99+';
  return String(n);
};

export const renderAttentionSlot = (state: AttentionSlotState): string => {
  const n = Math.max(0, Math.floor(state.blockingCount));
  const quiet = Math.max(0, Math.floor(state.quietCount ?? 0));
  const active = n > 0;
  const saved = quiet > 0;
  const ready = saved && state.quietStatus === 'ready';
  const checking = saved && state.quietStatus === 'checking';
  const retry = saved && state.quietStatus === 'retry';
  const diagnosis = saved && state.quietStatus === 'diagnosis';
  const decision = saved && state.quietStatus === 'decision';
  const closure = saved && state.quietStatus === 'closure';
  const readyCue = ready || checking || retry || diagnosis || decision
    || closure;
  const open = state.open === true;
  const badge = active
    ? `<span class="top-bar-attention-badge" aria-hidden="true">${e(formatCount(n))}</span>`
    : '';
  const quietCopy = quiet === 0
    ? ''
    : closure
      ? `; ${quiet} saved review${quiet === 1 ? '' : 's'} need${quiet === 1 ? 's' : ''} closure`
      : decision
        ? `; ${quiet} saved review${quiet === 1 ? '' : 's'} need${quiet === 1 ? 's' : ''} a decision`
        : diagnosis
          ? `; ${quiet} saved review${quiet === 1 ? '' : 's'} need${quiet === 1 ? 's' : ''} diagnosis`
          : retry
            ? `; ${quiet} saved review${quiet === 1 ? '' : 's'} need${quiet === 1 ? 's' : ''} retry`
            : checking
              ? `; ${quiet} saved review${quiet === 1 ? ' is' : 's are'} being checked`
              : ready
                ? `; ${quiet} saved item${quiet === 1 ? '' : 's'} ready to review`
                : `; ${quiet} item${quiet === 1 ? '' : 's'} saved for later`;
  const aria = active
    ? `${n} item${n === 1 ? ' needs' : 's need'} your attention${quietCopy}`
    : `No items need your attention${quietCopy}`;
  return `
    <button type="button"
      class="top-bar-attention ${active ? 'top-bar-attention--active' : 'top-bar-attention--idle'}${saved && !active ? ' top-bar-attention--saved' : ''}${readyCue && !active ? ' top-bar-attention--ready' : ''}${checking && !active ? ' top-bar-attention--checking' : ''}${retry && !active ? ' top-bar-attention--retry' : ''}${diagnosis && !active ? ' top-bar-attention--diagnosis' : ''}${decision && !active ? ' top-bar-attention--decision' : ''}${closure && !active ? ' top-bar-attention--closure' : ''}${open ? ' top-bar-attention--open' : ''}"
      data-action="open-attention"
      aria-haspopup="dialog"
      aria-expanded="${open ? 'true' : 'false'}"
      aria-label="${e(aria)}"
      title="${e(aria)}">
      <span class="top-bar-attention-glyph top-bar-attention-bell" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" focusable="false">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path>
          <path d="M13.75 21a2 2 0 0 1-3.5 0"></path>
        </svg>
      </span>
      ${readyCue && !active
        ? '<span class="top-bar-attention-quiet-indicator" aria-hidden="true"></span>'
        : ''}
      ${badge}
    </button>
  `;
};
