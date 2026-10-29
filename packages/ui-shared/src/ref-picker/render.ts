/** Shared ref-picker — pure HTML renderers.
 *
 *  Two entry points:
 *   - `renderRefPicker` paints the whole shell (combobox wrapper + input
 *     + optional clear button + the results list). The host embeds this
 *     string wherever the picker should appear; `wire.ts` then ATTACHES
 *     to it (it does not create the shell itself).
 *   - `renderRefPickerResults` paints ONLY the `<ul>` body, so a keystroke
 *     can repaint the dropdown without touching the input element — which
 *     keeps focus + caret intact while typing.
 *
 *  Every interpolated value flows through `e` (see `template.ts`): option
 *  labels are user/recipe data and must never break out of the markup.
 */

import { e } from '../template.js';
import type { RefPickerRenderConfig, RefPickerState } from './types.js';

/** Marker the shell carries — `wire.ts` finds its subtree by it. */
export const refPickerShellAttr = (pickerId: string): string =>
  `data-ref-picker="${e(pickerId)}"`;

/** Deliberately says what was SEARCHED, not just that more exist — the user
 *  needs to know their query was answered against a subset. */
const DEFAULT_TRUNCATED = 'Recued only searched the first page. Try something more specific if you expected more.';
const DEFAULT_EMPTY = 'No matches.';
const DEFAULT_LOADING = 'Searching…';

/** Attribute names + ids `wire.ts` and the renderers share. */
export const REF_PICKER_INPUT_ATTR = 'data-ref-picker-input';
export const REF_PICKER_RESULTS_ATTR = 'data-ref-picker-results';
export const REF_PICKER_CLEAR_ATTR = 'data-ref-picker-clear';
export const REF_PICKER_OPTION_INDEX_ATTR = 'data-ref-picker-option-index';
export const REF_PICKER_VALUE_ATTR = 'data-ref-picker-value';
export const REF_PICKER_RECOVERY_ATTR = 'data-ref-picker-recovery';
export const REF_PICKER_RECOVERY_MESSAGE_ATTR = 'data-ref-picker-recovery-message';
export const REF_PICKER_RETRY_ATTR = 'data-ref-picker-retry';

const listId = (pickerId: string): string => `ref-picker-list-${pickerId}`;

/** Partial failures use the inline recovery row. With no known matches there
 * is no dropdown; retrying with known matches keeps those choices available. */
export const refPickerResultsVisible = (state: RefPickerState): boolean =>
  state.open && (state.retryableError === null || state.options.length > 0);

/** Stable per-option element id — shared with `wire.ts` so it can set the
 *  input's `aria-activedescendant` on keyboard nav. */
export const refPickerOptionDomId = (
  pickerId: string,
  index: number,
): string => `ref-picker-opt-${pickerId}-${index}`;

/** The whole shell. */
export const renderRefPicker = (
  state: RefPickerState,
  config: RefPickerRenderConfig,
): string => {
  const { pickerId } = config;
  const hidden = renderHiddenFormField(state, config);
  const expanded = refPickerResultsVisible(state) ? 'true' : 'false';
  const placeholder = config.placeholder ?? '';
  // Always present; `wire.ts` toggles its `hidden` so a commit/clear is a
  // pure attribute flip (no structural repaint of the field row).
  const clearHidden = state.selectedId === null ? ' hidden' : '';
  const clearButton = `<button type="button" class="ref-picker-clear" ${REF_PICKER_CLEAR_ATTR} aria-label="Clear selection"${clearHidden}>×</button>`;
  const activeDescendant =
    state.open && state.activeIndex >= 0
      ? ` aria-activedescendant="${e(refPickerOptionDomId(pickerId, state.activeIndex))}"`
      : '';
  const ariaLabel = config.ariaLabel ?? config.placeholder ?? 'Choose a reference';
  const busy = state.loading ? 'true' : 'false';
  return [
    `<div class="ref-picker" ${refPickerShellAttr(pickerId)}>`,
    hidden,
    `<div class="ref-picker-field">`,
    `<input class="ref-picker-input" ${REF_PICKER_INPUT_ATTR} type="text"`,
    ` value="${e(state.query)}" placeholder="${e(placeholder)}"`,
    ` autocomplete="off" spellcheck="false" role="combobox"`,
    ` aria-haspopup="listbox" aria-expanded="${expanded}" aria-busy="${busy}"`,
    ` aria-autocomplete="list" aria-controls="${e(listId(pickerId))}"`,
    ` aria-label="${e(ariaLabel)}"${activeDescendant} />`,
    clearButton,
    `</div>`,
    `<div class="ref-picker-recovery" ${REF_PICKER_RECOVERY_ATTR}${state.retryableError === null ? ' hidden' : ''}>`,
    `<span ${REF_PICKER_RECOVERY_MESSAGE_ATTR} role="status">${e(state.retryableError ?? '')}</span>`,
    `<button type="button" class="ref-picker-retry" ${REF_PICKER_RETRY_ATTR}>Try again</button>`,
    `</div>`,
    renderRefPickerResults(state, config),
    `</div>`,
  ].join('');
};

/** The whole `<ul>` results element — used in the initial shell render. */
export const renderRefPickerResults = (
  state: RefPickerState,
  config: RefPickerRenderConfig,
): string => {
  const { pickerId } = config;
  const visible = refPickerResultsVisible(state);
  const hiddenAttr = visible ? '' : ' hidden';
  const body = visible ? renderRefPickerResultRows(state, config) : '';
  return [
    `<ul class="ref-picker-results" ${REF_PICKER_RESULTS_ATTR}`,
    ` id="${e(listId(pickerId))}" role="listbox" aria-busy="${state.loading ? 'true' : 'false'}"${hiddenAttr}>`,
    body,
    `</ul>`,
  ].join('');
};

/** Just the `<li>` rows that go INSIDE the `<ul>` — the surgical-repaint
 *  unit. `wire.ts` sets `resultsEl.innerHTML` to this on every keystroke,
 *  so the input element (and its focus + caret) is never recreated. */
export const renderRefPickerResultRows = (
  state: RefPickerState,
  config: RefPickerRenderConfig,
): string => {
  if (state.loading && state.retryableError === null) {
    return statusRow(config.loadingText ?? DEFAULT_LOADING);
  }
  if (state.error !== null) {
    return statusRow(state.error, ' ref-picker-status--error', 'alert');
  }
  // ⛔ The truncation note rides the EMPTY branch too — that is the case it
  // exists for. "No matches" over a capped read is the reading that misleads.
  const truncatedRow = state.truncated && state.retryableError === null
    ? statusRow(config.truncatedText ?? DEFAULT_TRUNCATED, ' ref-picker-status--truncated')
    : '';
  if (state.options.length === 0) {
    return (state.retryableError === null ? statusRow(config.emptyText ?? DEFAULT_EMPTY) : '')
      + truncatedRow;
  }
  return state.options
    .map((option, index) => {
      const active = index === state.activeIndex;
      const activeClass = active ? ' ref-picker-option--active' : '';
      const selected = option.id === state.selectedId;
      const selectedClass = selected ? ' ref-picker-option--selected' : '';
      const sublabel =
        option.sublabel !== undefined && option.sublabel !== ''
          ? `<span class="ref-picker-option-sub">${e(option.sublabel)}</span>`
          : '';
      return [
        `<li class="ref-picker-option${activeClass}${selectedClass}" role="option"`,
        ` id="${e(refPickerOptionDomId(config.pickerId, index))}"`,
        ` aria-selected="${selected ? 'true' : 'false'}"`,
        ` ${REF_PICKER_OPTION_INDEX_ATTR}="${index}">`,
        `<span class="ref-picker-option-label">${e(option.label)}</span>`,
        sublabel,
        `</li>`,
      ].join('');
    })
    .join('') + truncatedRow;
};

/** A listbox may contain options (or presentational wrappers), not arbitrary
 * disabled list items. Keep status copy announced without pretending it is a
 * selectable result. */
const statusRow = (
  text: string,
  className = '',
  role: 'status' | 'alert' = 'status',
): string =>
  `<li class="ref-picker-status${className}" role="presentation">`
  + `<span role="${role}">${e(text)}</span></li>`;

/** The hidden mirror — present only when the picker backs a form-renderer
 *  `ref` field, so `readFormValues` reads the committed id back unchanged
 *  (see `form-renderer/read.ts`). Two shapes:
 *   - `formFieldName` → `data-form-field` mirror (single `ref` field).
 *   - `arrayMirror`   → `data-form-array-item` + `data-form-array-index`
 *                       mirror (an `array<ref>` item — the array reader
 *                       walks these per index). */
const renderHiddenFormField = (
  state: RefPickerState,
  config: RefPickerRenderConfig,
): string => {
  const value = e(state.selectedId ?? '');
  if (config.formFieldName !== undefined) {
    return [
      `<input type="hidden" data-form-field="${e(config.formFieldName)}"`,
      ` data-form-type="ref" ${REF_PICKER_VALUE_ATTR}`,
      ` value="${value}" />`,
    ].join('');
  }
  if (config.arrayMirror !== undefined) {
    const { field, index } = config.arrayMirror;
    return [
      `<input type="hidden" data-form-array-item="${e(field)}"`,
      ` data-form-array-index="${e(String(index))}"`,
      ` data-form-type="ref" ${REF_PICKER_VALUE_ATTR}`,
      ` value="${value}" />`,
    ].join('');
  }
  return '';
};
