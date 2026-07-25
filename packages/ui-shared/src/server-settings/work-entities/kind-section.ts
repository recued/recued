/** D-145 PA11 — Per-kind section renderer.
 *
 *  Renders one `<section>` per work-entity kind (task / note /
 *  commitment / project) under the Settings → Work Entities panel.
 *  Each section carries:
 *    - A header label ("Tasks" / "Notes" / etc.) + Source count
 *    - A "Default Source" dropdown over the registered Sources for
 *      that kind. Selecting `(none)` clears the default.
 *    - The list of registered Sources for the kind, rendered through
 *      `renderWorkEntitySourceRow`.
 *
 *  When zero Sources are registered for a kind, the section renders
 *  the empty-state copy + onboarding guidance pointing at Settings →
 *  Connections / Settings → Bundles.
 *
 *  Spec: docs/d-145-spec.md § PA11. */

import type { SourceRegistration, WorkEntityKind } from '@recued/contracts';
import { e } from '../../template.js';
import { inlineError } from '../../primitives/message.js';
import { emptyHint } from '../../primitives/empty-hint.js';
import {
  renderWorkEntitySourceRow,
  type WorkEntitySourceRowProps,
} from './source-row.js';
import type {
  WorkEntityDefaultSourcePending,
  WorkEntitySourceRowPending,
} from './state.js';

const KIND_DISPLAY_LABEL: Record<WorkEntityKind, string> = {
  task: 'Tasks',
  note: 'Notes',
  commitment: 'Commitments',
  project: 'Projects',
  booking: 'Bookings',
};

const KIND_EMPTY_HINT: Record<WorkEntityKind, string> = {
  task:
    'No task Sources registered yet. The Recued built-in Source is auto-registered on first server start; HubSpot / Salesforce add per-connection Sources after you enroll the connection in Settings → Connections.',
  note:
    'No note Sources registered yet. The Recued built-in Source is auto-registered on first server start; future adapter Sources arrive via Settings → Bundles.',
  commitment:
    'No commitment Sources registered yet. The Recued built-in Source is auto-registered on first server start; mail-extracted commitments land here once Mail Send / IMAP enrollment completes in Settings → Connections.',
  project:
    'No project Sources registered yet. The Recued built-in Source is auto-registered on first server start; future adapter Sources arrive via Settings → Bundles.',
  booking:
    'No booking Sources registered yet. Bookings are Recued-local — the built-in Source is auto-registered on first server start, and approving a reservation from your Reception inbox creates one. No external adapter syncs them.',
};

export interface WorkEntityKindSectionProps {
  kind: WorkEntityKind;
  /** Sources registered for this kind, in registration order. */
  sources: ReadonlyArray<SourceRegistration>;
  /** Per-kind default-Source id, or `null` when none pinned. */
  default_source_id: string | null;
  /** Per-Source pending-state slots — keyed by source_id. */
  pending_by_source: Readonly<Record<string, WorkEntitySourceRowPending>>;
  /** Per-kind default-Source pending-state slot. */
  pending_default?: WorkEntityDefaultSourcePending;
}

const renderDefaultSourceDropdown = (
  kind: WorkEntityKind,
  sources: ReadonlyArray<SourceRegistration>,
  default_source_id: string | null,
  pending: boolean,
): string => {
  if (sources.length === 0) return '';
  const options = sources
    .map((s) => {
      const sel = s.id === default_source_id ? ' selected' : '';
      const enabled = s.enabled ?? true;
      const enabledTag = enabled ? '' : ' (disabled)';
      return `<option value="${e(s.id)}"${sel}>${e(s.source_label)}${e(enabledTag)}</option>`;
    })
    .join('');
  const noneSelected = default_source_id === null ? ' selected' : '';
  const disabledAttr = pending ? ' disabled' : '';
  return `
    <div class="rx-work-entities-default-row">
      <label class="rx-work-entities-default-label" for="rx-work-entities-default-${e(kind)}">Default Source</label>
      <select
        id="rx-work-entities-default-${e(kind)}"
        class="rx-work-entities-default-select"
        data-action="set-default-source"
        data-kind="${e(kind)}"${disabledAttr}
      >
        <option value=""${noneSelected}>(none — pick at write time)</option>
        ${options}
      </select>
    </div>
  `;
};

export const renderWorkEntityKindSection = (
  props: WorkEntityKindSectionProps,
): string => {
  const heading = KIND_DISPLAY_LABEL[props.kind];
  const sourcesForKind = props.sources.filter(
    (s) => s.top_tier_kind === props.kind,
  );
  const sourceCount = sourcesForKind.length;
  const isEmpty = sourceCount === 0;
  const defaultPending = props.pending_default;
  const defaultDropdown = renderDefaultSourceDropdown(
    props.kind,
    sourcesForKind,
    props.default_source_id,
    defaultPending?.pending === true,
  );
  const defaultErrorBlock = defaultPending?.error
    ? inlineError(defaultPending.error)
    : '';
  const rowsHtml = isEmpty
    ? emptyHint({ message: KIND_EMPTY_HINT[props.kind] })
    : `<ul class="rx-work-entities-source-list">${sourcesForKind
        .map((s) => {
          const rowProps: WorkEntitySourceRowProps = {
            source: s,
            is_default: s.id === props.default_source_id,
          };
          const pending = props.pending_by_source[s.id];
          if (pending !== undefined) rowProps.pending = pending;
          return renderWorkEntitySourceRow(rowProps);
        })
        .join('')}</ul>`;
  return `
    <section class="rx-work-entities-kind-section" data-kind="${e(props.kind)}">
      <header class="rx-work-entities-kind-header">
        <h3 class="rx-work-entities-kind-heading">${e(heading)}</h3>
        <span class="rx-work-entities-kind-count">${sourceCount} Source${sourceCount === 1 ? '' : 's'}</span>
      </header>
      ${defaultDropdown}
      ${defaultErrorBlock}
      ${rowsHtml}
    </section>
  `;
};

export const WORK_ENTITIES_KIND_SECTION_STYLES = `
.rx-work-entities-kind-section {
  margin-bottom: 24px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-sunk);
}
.rx-work-entities-kind-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 12px;
}
.rx-work-entities-kind-heading {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
}
.rx-work-entities-kind-count {
  font-size: 12px;
  color: var(--fg-muted, var(--fg));
}
.rx-work-entities-default-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.rx-work-entities-default-label {
  font-size: 12px;
  color: var(--fg-muted, var(--fg));
}
.rx-work-entities-default-select {
  flex: 1;
  padding: 6px 8px;
  font-size: 13px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
}
.rx-work-entities-source-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
`;
