/** D-119 Phase 3/4 — top-bar Attention slot.
 *
 *  The counter button that anchors the Attention popover. Phase 3
 *  shipped the counter surface; Phase 4 adds aria-expanded + aria-haspopup
 *  so the same button doubles as the popover's accessible toggle.
 *
 *  Counter rules:
 *    - Zero blocking items → render a quiet inactive button (still
 *      occupies the slot for layout stability) with no badge.
 *    - 1+ items → highlight + numeric badge. `99+` is the cap so the
 *      badge stays one glyph wide.
 *
 *  Pure module. */

import { e } from '../template.js';

export interface AttentionSlotState {
  /** Approvals + circuit-trip count. Driven by the sidebar from
   *  `pendingApprovals.size + autoDisabledSummaries.length` — the
   *  same two surfaces the spec mandates as "blocking work". */
  blockingCount: number;
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
  const active = n > 0;
  const open = state.open === true;
  const badge = active
    ? `<span class="top-bar-attention-badge" aria-hidden="true">${e(formatCount(n))}</span>`
    : '';
  const aria = active
    ? `${n} item${n === 1 ? '' : 's'} need attention`
    : 'No items need attention';
  return `
    <button type="button"
      class="top-bar-attention ${active ? 'top-bar-attention--active' : 'top-bar-attention--idle'}${open ? ' top-bar-attention--open' : ''}"
      data-action="open-attention"
      aria-haspopup="dialog"
      aria-expanded="${open ? 'true' : 'false'}"
      aria-label="${e(aria)}"
      title="${e(aria)}">
      <span class="top-bar-attention-glyph" aria-hidden="true">⚠</span>
      ${badge}
    </button>
  `;
};
