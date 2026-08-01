/** D-128 Phase 5 — Memory tab subpath barrel.
 *
 *  Surfaces the entity-detail panel + its derivation helpers. Future
 *  Memory-tab UI (e.g. timeline filters, axis-aware layout polish)
 *  lands here under the same namespace. */

export {
  renderEntityDetailPanel,
  renderTimelineSection,
  formatMetaFieldValue,
  summarizeEnrichmentValue,
  pickFreshestMetaSnapshot,
  collapseToFreshestPerTopic,
  ENTITY_DETAIL_PANEL_STYLES,
  renderRollupsSection,
  type EntityDetailPanelProps,
  type EnrichmentSummary,
} from './entity-detail-panel.js';
