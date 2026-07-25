/** D-145 PA11 — Settings → Work Entities panel renderer.
 *
 *  Top-level container that hosts mount on Settings → Work Entities.
 *  Renders one section per kind (task / note / commitment / project)
 *  with the Source list + per-Source toggles + per-kind default
 *  Source dropdown.
 *
 *  Pure HTML — every state input arrives via `props`. The host wires
 *  `data-action` clicks to `work_entity.source.*` rpcs and patches
 *  the panel state back through.
 *
 *  Spec wireframe (D-145 § PA11 + § A.2):
 *
 *    Work Entities
 *      Sources are entity providers per kind. Each Source can be
 *      enabled / disabled and exposed to MCP independently.
 *
 *      ┌─ Tasks ──────────────────────────── 3 Sources ──┐
 *      │  Default Source: [Recued built-in ▾]            │
 *      │  ▢ Recued built-in            (Recued)  read-only│
 *      │    ☑ Enabled    ☑ MCP exposed   [default]       │
 *      │  ▢ HubSpot Tasks (conn-42)    (connection)      │
 *      │    ☑ Enabled    ☐ MCP exposed                   │
 *      │  ▢ Salesforce Tasks (conn-7)  (connection)      │
 *      │    ☐ Enabled    ☐ MCP exposed                   │
 *      └──────────────────────────────────────────────────┘
 *
 *  Spec: D-145 § PA11. */

import { WORK_ENTITY_KINDS, type WorkEntityKind } from '@recued/contracts';
import { inlineError } from '../../primitives/message.js';
import {
  renderWorkEntityKindSection,
  type WorkEntityKindSectionProps,
  WORK_ENTITIES_KIND_SECTION_STYLES,
} from './kind-section.js';
import { WORK_ENTITIES_SOURCE_ROW_STYLES } from './source-row.js';
import type { WorkEntitiesPanelState } from './state.js';

export interface WorkEntitiesPanelProps extends WorkEntitiesPanelState {}

export const renderWorkEntitiesPanel = (
  props: WorkEntitiesPanelProps,
): string => {
  if (props.loading && props.sources.length === 0) {
    return `<p class="rx-work-entities-loading">Loading Work Entity Sources…</p>`;
  }

  if (props.error) {
    return inlineError(props.error);
  }

  const sectionsHtml = WORK_ENTITY_KINDS.map((kind: WorkEntityKind) => {
    const default_source_id = props.defaults_by_kind[kind] ?? null;
    const sectionProps: WorkEntityKindSectionProps = {
      kind,
      sources: props.sources,
      default_source_id,
      pending_by_source: props.pending_by_source,
    };
    const pendingDefault = props.pending_by_default[kind];
    if (pendingDefault !== undefined) {
      sectionProps.pending_default = pendingDefault;
    }
    return renderWorkEntityKindSection(sectionProps);
  }).join('');

  return `
    <div class="rx-work-entities-panel">
      <header class="rx-work-entities-header">
        <h2>Work Entities</h2>
        <p class="rx-work-entities-summary">
          Sources are entity providers per kind. Each Source can be
          enabled / disabled and exposed to MCP independently. Disabled
          Sources stay registered (so re-enabling preserves history)
          but their rows are excluded from polymorphic
          <code>data.&lt;kind&gt;</code> reads. The per-kind default
          Source drives the create-dialog default + AI chat
          default-confirm.
        </p>
      </header>
      ${sectionsHtml}
    </div>
  `;
};

/** Self-contained CSS for the work-entities panel. Concatenated into
 *  the host's stylesheet. */
export const WORK_ENTITIES_PANEL_STYLES = `
${WORK_ENTITIES_KIND_SECTION_STYLES}
${WORK_ENTITIES_SOURCE_ROW_STYLES}
.rx-work-entities-panel {
  padding: 16px;
}
.rx-work-entities-header {
  margin-bottom: 16px;
}
.rx-work-entities-header h2 {
  margin: 0 0 4px 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--fg);
}
.rx-work-entities-summary {
  margin: 0;
  font-size: 13px;
  color: var(--fg-muted, var(--fg));
  line-height: 1.5;
}
.rx-work-entities-summary code {
  font-family: monospace;
  background: var(--surface-sunk);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.rx-work-entities-loading {
  padding: 16px;
  color: var(--fg-muted, var(--fg));
  font-size: 13px;
}
`;
