/** D-145 PA6 — Source dropdown renderer.
 *
 *  Pure HTML — host wires `change` events on `data-action="select-source"`.
 *  The renderer surfaces every option, marks the selected one, and
 *  surfaces small affordance chips (read-only / write / mcp) so the
 *  user knows what each Source can do without opening Settings.
 *
 *  Spec: D-145 § A.2.2 (resolver behavior — `data.<kind>.*`
 *  polymorphic / scoped) + § Phase PA6 (Source dropdown component).
 */

import {
  SOURCE_DROPDOWN_ALL_VALUE,
  selectedSourceIdToDropdownId,
  type SourceDropdownOption,
} from '@recued/contracts';
import { e } from '../template.js';

export interface SourceDropdownProps {
  /** Dropdown options as built by `buildSourceDropdownOptions`. The
   *  All-Sources sentinel must appear first; the renderer doesn't
   *  re-validate ordering. */
  options: readonly SourceDropdownOption[];
  /** Page-state's `selected_source_id` — `null` resolves to the
   *  All-Sources sentinel. */
  selected_source_id: string | null;
  /** When true, the host has explicitly disabled the dropdown (e.g.,
   *  during a kind switch transient). */
  disabled?: boolean;
}

/** Render the Source dropdown as a `<select>`. */
export const renderSourceDropdown = (props: SourceDropdownProps): string => {
  const selectedId = selectedSourceIdToDropdownId(props.selected_source_id);
  // Codex P2 fold — guard against the empty-options case (host
  // mounts before the Source list resolves). Without this, a
  // `<select>` with zero `<option>` rows renders as a tiny empty
  // box. Render a disabled placeholder so the affordance is
  // visible + read by screen readers.
  const isEmpty = props.options.length === 0;
  const optionsHtml = isEmpty
    ? '<option value="" disabled selected>Loading Sources…</option>'
    : props.options
        .map((opt) => renderOption(opt, opt.id === selectedId))
        .join('');
  // Auto-disable when zero options are supplied (Loading… state).
  // Caller's explicit `disabled: true` still wins. Sources with
  // only the All-Sources sentinel stay enabled — the dropdown is
  // still functional (users can confirm "All Sources" is the
  // current scope) even if no concrete Source is registered yet.
  const effectiveDisabled = props.disabled === true || isEmpty;
  const disabledAttr = effectiveDisabled ? ' disabled' : '';
  return `
    <div class="work-entity-source-dropdown">
      <label class="work-entity-source-dropdown-label" for="work-entity-source-select">Source</label>
      <select
        id="work-entity-source-select"
        class="work-entity-source-dropdown-select"
        data-action="select-source"
        aria-label="Source"${disabledAttr}
      >${optionsHtml}</select>
    </div>
  `;
};

const renderOption = (
  opt: SourceDropdownOption,
  selected: boolean,
): string => {
  const selAttr = selected ? ' selected' : '';
  const sentinel = opt.id === SOURCE_DROPDOWN_ALL_VALUE;
  // Render a small inline tag for the Source kind so power users can
  // tell "Recued built-in" from "HubSpot conn-42 / task" at a glance.
  // Stays terse to keep the dropdown line short on narrow widths.
  const kindTag = sentinel ? '' : ` (${kindShortLabel(opt.source_kind)})`;
  return `<option value="${e(opt.id)}" data-source-kind="${e(opt.source_kind)}"${selAttr}>${e(opt.label)}${e(kindTag)}</option>`;
};

const kindShortLabel = (
  kind: SourceDropdownOption['source_kind'],
): string => {
  switch (kind) {
    case 'builtin':
      return 'Recued';
    case 'connection':
      return 'connection';
    case 'adapter':
      return 'adapter';
    case 'dish':
      return 'dish';
    case 'sentinel':
      return 'all';
  }
};

/** Render Source affordance chips for a single Source — used by the
 *  page header next to the active dropdown selection so the user
 *  sees write-capability at a glance without clicking
 *  through to Settings.  Returns empty string for the All-Sources
 *  sentinel (the chips don't apply at the union level — they're
 *  per-Source affordances). */
export const renderSourceAffordanceChips = (
  option: SourceDropdownOption | undefined,
): string => {
  if (option === undefined) return '';
  if (option.source_kind === 'sentinel') return '';
  const chips: string[] = [];
  chips.push(
    option.write_capable
      ? `<span class="work-entity-source-chip work-entity-source-chip-write">write</span>`
      : `<span class="work-entity-source-chip work-entity-source-chip-readonly">read-only</span>`,
  );
  return `<span class="work-entity-source-chips">${chips.join('')}</span>`;
};
