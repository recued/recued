/** D-145 PA11 — Source row renderer.
 *
 *  One row per registered Source under a kind section. Renders the
 *  Source label, kind tag (Recued / connection / adapter / dish),
 *  the enable / mcp_exposed toggles, and a pinned-default chip when
 *  the row is the kind's default Source.
 *
 *  Pure HTML — host wires `change` events on
 *  `data-action="set-source-enabled"` /
 *  `data-action="set-source-mcp-exposed"` against the rpc dispatcher.
 *
 *  Spec: docs/d-145-spec.md § PA11. */

import type { SourceRegistration } from '@recued/contracts';
import { e } from '../../template.js';
import { inlineError } from '../../primitives/message.js';
import type { WorkEntitySourceRowPending } from './state.js';

export interface WorkEntitySourceRowProps {
  source: SourceRegistration;
  /** True when this row's `id` is the default Source for the kind.
   *  Renders the "default" chip; clearing the default is wired
   *  separately on the kind-section header. */
  is_default: boolean;
  /** Optional pending-state slot — disables both toggles + surfaces
   *  the inline error when set. Caller passes `undefined` for rows
   *  with no pending write. */
  pending?: WorkEntitySourceRowPending;
}

const kindShortLabel = (kind: SourceRegistration['source_kind']): string => {
  switch (kind) {
    case 'builtin':
      return 'Recued';
    case 'connection':
      return 'connection';
    case 'adapter':
      return 'adapter';
    case 'dish':
      return 'dish';
  }
};

export const renderWorkEntitySourceRow = (
  props: WorkEntitySourceRowProps,
): string => {
  // D-145 PA11 — `enabled` is optional in the type so pre-PA11
  // registrations resolve to `true` (the storage layer's
  // `intToBool(row.enabled)` always returns a boolean; this branch
  // covers the contracts-layer optionality only).
  const enabled = props.source.enabled ?? true;
  const pending = props.pending?.pending === true;
  const enabledChecked = enabled ? ' checked' : '';
  const mcpChecked = props.source.mcp_exposed ? ' checked' : '';
  const writeCapableChip = props.source.write_capable
    ? `<span class="rx-source-row-chip rx-source-row-chip-write">write</span>`
    : `<span class="rx-source-row-chip rx-source-row-chip-readonly">read-only</span>`;
  const defaultChip = props.is_default
    ? `<span class="rx-source-row-chip rx-source-row-chip-default">default</span>`
    : '';
  const disabledClass = enabled ? '' : ' rx-source-row-disabled';
  const pendingAttr = pending ? ' disabled' : '';
  const errorBlock = props.pending?.error
    ? inlineError(props.pending.error)
    : '';
  return `
    <li class="rx-source-row${disabledClass}" data-source-id="${e(props.source.id)}">
      <div class="rx-source-row-head">
        <span class="rx-source-row-label">${e(props.source.source_label)}</span>
        <span class="rx-source-row-tag">(${e(kindShortLabel(props.source.source_kind))})</span>
        ${writeCapableChip}
        ${defaultChip}
      </div>
      <div class="rx-source-row-toggles">
        <label class="rx-source-row-toggle">
          <input
            type="checkbox"
            data-action="set-source-enabled"
            data-source-id="${e(props.source.id)}"${enabledChecked}${pendingAttr}
          />
          <span>Enabled</span>
        </label>
        <label class="rx-source-row-toggle">
          <input
            type="checkbox"
            data-action="set-source-mcp-exposed"
            data-source-id="${e(props.source.id)}"${mcpChecked}${pendingAttr}
          />
          <span>MCP exposed</span>
        </label>
      </div>
      ${errorBlock}
    </li>
  `;
};

export const WORK_ENTITIES_SOURCE_ROW_STYLES = `
.rx-source-row {
  list-style: none;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 8px;
  background: var(--bg);
}
.rx-source-row-disabled {
  opacity: 0.55;
}
.rx-source-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.rx-source-row-label {
  font-weight: 500;
  color: var(--fg);
}
.rx-source-row-tag {
  color: var(--fg-muted, var(--fg));
  font-size: 12px;
}
.rx-source-row-chip {
  display: inline-block;
  padding: 2px 6px;
  font-size: 10px;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
  border: 1px solid var(--border);
  background: var(--surface-sunk);
  color: var(--fg);
}
.rx-source-row-chip-write { color: var(--accent); border-color: var(--accent); }
.rx-source-row-chip-readonly { color: var(--fg-muted, var(--fg)); }
.rx-source-row-chip-default {
  background: var(--accent);
  color: var(--on-accent);
  border-color: var(--accent);
}
.rx-source-row-toggles {
  display: flex;
  gap: 16px;
  margin-top: 8px;
}
.rx-source-row-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}
.rx-source-row-toggle input[type="checkbox"]:disabled {
  cursor: not-allowed;
}
`;
