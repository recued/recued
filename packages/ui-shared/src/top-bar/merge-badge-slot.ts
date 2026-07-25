/** D-138 Phase 4 — top-bar Merge-candidates badge slot.
 *
 *  Surfaces the pending contact-merge candidate count from any UI
 *  surface (sidebar / popup / webapp). Click → host opens the
 *  shared `<MergeReviewDialog>` (P2) loaded with the pending queue
 *  via `contact.merge.list({ status: 'pending' })`.
 *
 *  Placement convention mirrors the Pause-AI slot: a quiet pill
 *  that occupies the slot so layout doesn't reflow when the count
 *  flips between zero and non-zero. Hidden entirely when the queue
 *  is empty (per spec § A.9 — "Hidden when queue is empty").
 *
 *  Pure render module — no IO, no rpc. Action wiring lives in the
 *  host dispatcher; this slot just emits `data-action="contact-merge
 *  -open-review"` for the host to translate into "open the dialog
 *  with the pending queue."
 *
 *  Spec: `docs/d-138-spec.md` § A.9 Notification surfaces, § P4. */

import { e } from '../template.js';

export interface MergeBadgeSlotState {
  /** Pending merge-candidate count. The host fetches via
   *  `contact.merge.list({ status: 'pending' })` on first render +
   *  refreshes on every `merge_candidate` broadcast bus event
   *  (`subkind: 'inserted' | 'resolved'`). Zero hides the slot. */
  pendingCount: number;
  /** Optional — host plumbs the dialog open-state through the slot
   *  so the button can render with `aria-expanded` correctly when
   *  the dialog (and thus the click target's effect) is active.
   *  Defaults to false. */
  dialogOpen?: boolean;
}

const formatCount = (n: number): string => {
  if (n <= 0) return '';
  if (n > 99) return '99+';
  return String(n);
};

export const renderMergeBadgeSlot = (state: MergeBadgeSlotState): string => {
  const n = Math.max(0, Math.floor(state.pendingCount));
  if (n === 0) return '';
  const open = state.dialogOpen === true;
  const aria = `${n} merge candidate${n === 1 ? '' : 's'} pending`;
  return `
    <button type="button"
      class="top-bar-merge-badge${open ? ' top-bar-merge-badge--open' : ''}"
      data-action="contact-merge-open-review"
      aria-haspopup="dialog"
      aria-expanded="${open ? 'true' : 'false'}"
      aria-label="${e(aria)}"
      title="${e(aria)}">
      <span class="top-bar-merge-badge-glyph" aria-hidden="true">👥</span>
      <span class="top-bar-merge-badge-count" aria-hidden="true">${e(formatCount(n))}</span>
    </button>
  `;
};
