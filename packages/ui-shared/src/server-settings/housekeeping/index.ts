/** D-123 Phase 5 — Settings → Server → Housekeeping panel barrel.
 *
 *  Public surface for the housekeeping UI. Hosts (extension sidebar
 *  + webapp) import the panel renderer + state shapes from this barrel
 *  and wire `data-action` clicks to the four `housekeeping.*` rpcs.
 *
 *  D-132 P5 adds the detail-drawer component + its scope-read /
 *  recent-runs / trust-radio props.
 *
 *  Spec: `docs/d-123-spec.md` §5.2 + `docs/d-132-spec.md` §A.7. */

export {
  renderHousekeepingPanel,
  type HousekeepingPanelProps,
} from './housekeeping-panel.js';
export {
  renderHousekeepingPresetPicker,
  type HousekeepingPresetPickerProps,
} from './preset-picker.js';
export {
  renderHousekeepingCustomWindowFields,
  type HousekeepingCustomWindowFieldsProps,
} from './custom-window-fields.js';
export {
  renderHousekeepingTaskStatusTable,
  type HousekeepingTaskStatusTableProps,
} from './task-status-table.js';
export {
  renderHousekeepingEnrichmentProducerSection,
  type HousekeepingEnrichmentProducerSectionProps,
} from './enrichment-producer-section.js';
export {
  renderHousekeepingRunNowConfirmDialog,
  type HousekeepingRunNowConfirmDialogProps,
} from './run-now-confirm-dialog.js';
export {
  renderHousekeepingDetailDrawer,
  topicFromTaskId,
  type HousekeepingDetailDrawerProps,
} from './detail-drawer.js';
export {
  renderHousekeepingPromotionBanner,
  type HousekeepingPromotionBannerProps,
} from './promotion-banner.js';
export {
  renderHousekeepingDriftBanner,
  type HousekeepingDriftBannerProps,
} from './drift-banner.js';
export {
  renderHousekeepingProducerFilterBar,
  filterProducers,
  producerOneLiner,
  HOUSEKEEPING_PRODUCER_COST_FILTERS,
  HOUSEKEEPING_PRODUCER_SEARCH_ACTION,
  HOUSEKEEPING_PRODUCER_COST_ACTION,
  type HousekeepingProducerCostFilter,
  type HousekeepingProducerFilterBarProps,
} from './producer-filter-bar.js';
export {
  computeHousekeepingCostPreview,
  type HousekeepingCostPreview,
  type HousekeepingCostPreviewInput,
} from './cost-preview.js';
export {
  renderHousekeepingTopicResetModal,
  type HousekeepingTopicResetModalProps,
} from './topic-reset-modal.js';
export {
  formatCacheHitRate,
  formatCacheRelativeTime,
  renderHousekeepingLlmResultCacheCard,
  type HousekeepingLlmResultCacheCardProps,
} from './llm-result-cache-card.js';
export {
  initialHousekeepingCacheCardState,
  initialHousekeepingPanelState,
  initialHousekeepingRunNowDialogState,
  initialHousekeepingResetModalState,
  type HousekeepingCacheCardState,
  type HousekeepingCacheTopicStats,
  type HousekeepingPanelState,
  type HousekeepingRunNowDialogState,
  type HousekeepingResetModalState,
  type HousekeepingResetModalPhase,
  type HousekeepingCustomDraft,
  type HousekeepingDrawerRunEntry,
  type HousekeepingDrawerScopeRead,
  type HousekeepingPromotionSuggestion,
} from './state.js';
