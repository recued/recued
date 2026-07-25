/** D-119 Phase 3 — top-bar shell entry point. */

export { renderTopBar, type TopBarState } from './top-bar.js';
export {
  renderTopBarSearchInput,
  type SearchInputState,
} from './search-input.js';
export {
  renderAttentionSlot,
  type AttentionSlotState,
} from './attention-slot.js';
export {
  renderAttentionPopover,
  type AttentionPopoverState,
  type AttentionTab,
  type InformationalNotification,
} from './attention-popover.js';
export { renderAvatar, type AvatarState } from './avatar.js';
export {
  renderDevicesDropdown,
  renderDevicesDropdownTrigger,
  renderDevicesDropdownPopover,
  type Device,
  type DevicesDropdownState,
} from './devices-dropdown.js';
export {
  computeOnlineIndicator,
  renderOnlineDot,
  ONLINE_INDICATOR_THRESHOLDS_MS,
  type OnlineIndicator,
} from './online-indicator.js';
export {
  renderPauseAiSlot,
  resolvePauseUntilMs,
  PAUSE_AI_DURATION_KEYS,
  type PauseAiDurationKey,
  type PauseAiSlotState,
} from './pause-ai-slot.js';
export {
  renderMergeBadgeSlot,
  type MergeBadgeSlotState,
} from './merge-badge-slot.js';
