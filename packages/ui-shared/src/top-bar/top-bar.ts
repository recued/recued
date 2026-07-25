/** D-119 Phase 3 — top-bar shell.
 *
 *  Composes the four slots from the spec:
 *
 *      [Search] [⚠ Attention] [👤 Avatar] [▼ Devices]
 *
 *  Each slot is a pure render function in its own file; this module
 *  only wires them into the layout and exposes a single `renderTopBar`
 *  callers (sidebar today, popup later) can drop into their template.
 *
 *  Phase 3 deliberately stops at the *shell*: the slots render and
 *  their `data-action` strings reach the dispatcher, but the popovers /
 *  routes / scope switches they trigger are filled in by Phases 4–7.
 *
 *  Pure module. */

import {
  renderTopBarSearchInput,
  type SearchInputState,
} from './search-input.js';
import {
  renderAttentionSlot,
  type AttentionSlotState,
} from './attention-slot.js';
import {
  renderAttentionPopover,
  type AttentionPopoverState,
} from './attention-popover.js';
import { renderAvatar, type AvatarState } from './avatar.js';
import {
  renderDevicesDropdown,
  type DevicesDropdownState,
} from './devices-dropdown.js';
import {
  renderPauseAiSlot,
  type PauseAiSlotState,
} from './pause-ai-slot.js';
import {
  renderMergeBadgeSlot,
  type MergeBadgeSlotState,
} from './merge-badge-slot.js';

export interface TopBarState {
  search: SearchInputState;
  attention: AttentionSlotState;
  /** Phase 4: full popover state. Counter slot only needs `blockingCount`
   *  + `open`; the popover needs the actionable rows (`approvals`,
   *  `circuitTrips`, `informational`) plus the active tab + the
   *  reset-in-flight set. Kept separate from `attention` so the slot's
   *  shape stays small. */
  attentionPopover: AttentionPopoverState;
  avatar: AvatarState;
  devices: DevicesDropdownState;
  /** D-132 P6 — top-bar Pause-AI emergency switch. Optional so the
   *  webapp + sidebar shells that haven't yet wired the slot keep
   *  rendering — when omitted the slot is suppressed entirely. */
  pauseAi?: PauseAiSlotState;
  /** D-138 P4 — top-bar Merge-candidates badge. Optional so shells
   *  that haven't wired the slot keep rendering; the slot itself
   *  hides entirely when `pendingCount` is zero so layout stays
   *  stable across the empty/non-empty transition. */
  mergeBadge?: MergeBadgeSlotState;
}

export const renderTopBar = (state: TopBarState): string => `
  <header class="sidebar-top-bar" role="banner">
    ${renderTopBarSearchInput(state.search)}
    <div class="top-bar-right">
      ${state.pauseAi ? renderPauseAiSlot(state.pauseAi) : ''}
      ${state.mergeBadge ? renderMergeBadgeSlot(state.mergeBadge) : ''}
      <div class="top-bar-attention-anchor">
        ${renderAttentionSlot(state.attention)}
        ${renderAttentionPopover(state.attentionPopover)}
      </div>
      ${renderAvatar(state.avatar)}
      ${renderDevicesDropdown(state.devices)}
    </div>
  </header>
`;
