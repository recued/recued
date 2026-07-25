/** D-145 PA11 — Settings → Work Entities barrel.
 *
 *  Spec: docs/d-145-spec.md § PA11. */

export {
  renderWorkEntitiesPanel,
  WORK_ENTITIES_PANEL_STYLES,
  type WorkEntitiesPanelProps,
} from './panel.js';
export {
  renderWorkEntityKindSection,
  WORK_ENTITIES_KIND_SECTION_STYLES,
  type WorkEntityKindSectionProps,
} from './kind-section.js';
export {
  renderWorkEntitySourceRow,
  WORK_ENTITIES_SOURCE_ROW_STYLES,
  type WorkEntitySourceRowProps,
} from './source-row.js';
export {
  EMPTY_WORK_ENTITIES_PANEL_STATE,
  type WorkEntitiesPanelState,
  type WorkEntitySourceRowPending,
  type WorkEntityDefaultSourcePending,
} from './state.js';
