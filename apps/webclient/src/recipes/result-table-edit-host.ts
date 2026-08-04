/** DOM adapter for the shared editable result table.
 *
 * The state machine lives in `@recued/ui-shared` and the markup lives in
 * `recipe-result-panel.ts`. This tiny adapter is the remaining host-neutral
 * seam: delegated inputs are decoded once and the Save/status chrome is synced
 * without repainting the input (which would drop the owner's caret).
 */
import {
  canSubmitTableEdit,
  parseTableEditCellAddress,
  RECORD_REF_CELL_ATTR,
  RECORD_REF_CELL_ENTITY_ATTR,
  RECORD_REF_CELL_FILTER_ATTR,
  RefPicker,
  tableEditStatus,
  type OutputTableEditState,
} from '@recued/ui-shared';

import {
  RECIPES_ROUTE_ACTION_ATTR,
  RECIPES_ROUTE_RESULT_FILTER_ATTR,
  RECIPES_ROUTE_RESULT_GRID_ATTR,
  RECIPES_ROUTE_RESULT_GRID_CELL_ATTR,
  type RecipesResultFilterAction,
} from './recipe-result-panel.js';

export interface ResultTableEditCellInput {
  gridRoot: HTMLElement;
  key: string;
  rowIndex: number;
  column: string;
  value: string;
}

/** Capture the exact editable-grid Save command before a host replaces the
 * result markup. The grid key is descriptor-derived, so it survives the busy
 * and terminal repaint without relying on button copy. */
export const captureResultTableEditSubmitFocus = (
  activeElement: Element | null | undefined,
): string | null => activeElement?.getAttribute?.(RECIPES_ROUTE_ACTION_ATTR)
  === 'result-grid-submit'
  ? activeElement.getAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR)
  : null;

/** Restore a captured Save command after either result host repaints. Iterate
 * rather than interpolating the opaque grid key into a selector. */
export const restoreResultTableEditSubmitFocus = (
  root: ParentNode,
  gridKey: string | null,
): boolean => {
  if (gridKey === null) return false;
  const submit = Array.from(root.querySelectorAll(
    `[${RECIPES_ROUTE_ACTION_ATTR}="result-grid-submit"]`,
  )).find((candidate) =>
    candidate.getAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR) === gridKey) as
      | HTMLElement
      | undefined;
  if (submit === undefined) return false;
  submit.focus({ preventScroll: true });
  return true;
};

export interface ResultFilterActionFocus {
  readonly filterKey: string;
  readonly action: RecipesResultFilterAction;
}

const resultFilterAction = (
  raw: string | null,
): RecipesResultFilterAction | null => raw === 'result-filter-search'
  ? 'search'
  : raw === 'result-filter-page:next'
    ? 'next'
    : raw === 'result-filter-page:previous' ? 'previous' : null;

/** Capture Search/Previous/Next by descriptor key and semantic action. */
export const captureResultFilterActionFocus = (
  activeElement: Element | null | undefined,
): ResultFilterActionFocus | null => {
  const action = resultFilterAction(
    activeElement?.getAttribute?.(RECIPES_ROUTE_ACTION_ATTR) ?? null,
  );
  const filterKey = activeElement?.getAttribute?.(
    RECIPES_ROUTE_RESULT_FILTER_ATTR,
  ) ?? null;
  return action === null || filterKey === null ? null : { action, filterKey };
};

/** Restore the exact filter command after a repaint. At a page boundary the
 * pressed direction may disappear, so hand focus to the opposite pager (then
 * Search) instead of dropping it to the document body. */
export const restoreResultFilterActionFocus = (
  root: ParentNode,
  focused: ResultFilterActionFocus | null,
): boolean => {
  if (focused === null) return false;
  const candidates = Array.from(root.querySelectorAll(
    `[${RECIPES_ROUTE_ACTION_ATTR}]`,
  ));
  const order: RecipesResultFilterAction[] = focused.action === 'next'
    ? ['next', 'previous', 'search']
    : focused.action === 'previous'
      ? ['previous', 'next', 'search']
      : ['search'];
  for (const action of order) {
    const control = candidates.find((candidate) =>
      candidate.getAttribute(RECIPES_ROUTE_RESULT_FILTER_ATTR) === focused.filterKey
      && resultFilterAction(candidate.getAttribute(RECIPES_ROUTE_ACTION_ATTR)) === action) as
        | HTMLElement
        | undefined;
    if (control === undefined) continue;
    control.focus({ preventScroll: true });
    return true;
  }
  return false;
};

/** Decode one delegated input/change event from any host embedding the panel. */
export const readResultTableEditCellInput = (
  target: EventTarget | null,
): ResultTableEditCellInput | null => {
  const element = target as (HTMLElement & { value?: unknown }) | null;
  const address = element?.getAttribute?.(RECIPES_ROUTE_RESULT_GRID_CELL_ATTR) ?? null;
  if (element === null || address === null) return null;
  const parsed = parseTableEditCellAddress(address);
  if (parsed === null) return null;
  const gridRoot = element.closest?.(
    `[${RECIPES_ROUTE_RESULT_GRID_ATTR}]`,
  ) as HTMLElement | null | undefined;
  const key = gridRoot?.getAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR) ?? null;
  if (gridRoot === null || gridRoot === undefined || key === null) return null;
  return {
    gridRoot,
    key,
    rowIndex: parsed.index,
    column: parsed.key,
    value: String(element.value ?? ''),
  };
};

/** Update only the grid chrome after a keystroke. Replacing `innerHTML` here
 * would replace the focused control and reset its caret/selection. */
export const syncResultTableEditChrome = (
  gridRoot: HTMLElement,
  state: OutputTableEditState,
): void => {
  const submit = gridRoot.querySelector?.(
    `[${RECIPES_ROUTE_ACTION_ATTR}="result-grid-submit"]`,
  ) as HTMLButtonElement | null | undefined;
  if (submit !== null && submit !== undefined) {
    const enabled = canSubmitTableEdit(state);
    // A Save that owns a live request must remain focusable across the host's
    // repaint. The dispatch seam already rejects clean/busy submissions, so
    // ARIA can express the unavailable state without a native `disabled`
    // button forcing focus to <body>. A clean grid stays out of sequential
    // keyboard order until the first real edit.
    submit.disabled = false;
    if (enabled) {
      submit.tabIndex = 0;
      submit.removeAttribute('aria-disabled');
      submit.removeAttribute('aria-busy');
      submit.removeAttribute('tabindex');
    } else {
      submit.setAttribute('aria-disabled', 'true');
      if (state.busy) {
        submit.tabIndex = 0;
        submit.setAttribute('aria-busy', 'true');
        submit.removeAttribute('tabindex');
      } else {
        submit.removeAttribute('aria-busy');
        submit.tabIndex = -1;
      }
    }
  }
  const status = gridRoot.querySelector?.(
    '.recipes-result-grid-status',
  ) as HTMLElement | null | undefined;
  if (status !== null && status !== undefined) {
    status.dataset.dirty = String(state.dirty);
    const nextStatus = tableEditStatus(state);
    // Avoid re-announcing identical live-region copy on every keystroke.
    if (status.textContent !== nextStatus) status.textContent = nextStatus;
  }
};

export type ResultTableEditRecordSearch = (
  entity: string,
  scope: Readonly<Record<string, string>>,
) => RefPicker.RefPickerSearchCaller;

export interface WireResultTableEditRefPickersOptions {
  search: ResultTableEditRecordSearch;
  valueAt(gridKey: string, rowIndex: number, column: string): string;
  onChange(
    gridKey: string,
    gridRoot: HTMLElement,
    rowIndex: number,
    column: string,
    value: string,
  ): void;
}

const parseScope = (raw: string | null): Readonly<Record<string, string>> => {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.some(([, value]) => typeof value !== 'string')) return {};
    return Object.fromEntries(entries) as Record<string, string>;
  } catch {
    return {};
  }
};

/** Upgrade every ref-valued editable cell under a freshly rendered result.
 * Returns owned handles so the host can destroy pending searches before its
 * next wholesale repaint. Absent search wiring intentionally leaves the
 * renderer's pasteable text fallback in place. */
export const wireResultTableEditRefPickers = (
  root: ParentNode,
  options: WireResultTableEditRefPickersOptions,
): RefPicker.RefPickerHandle[] => {
  const cells = (root as ParentNode & {
    querySelectorAll?: (selector: string) => Iterable<Element>;
  }).querySelectorAll?.(`[${RECORD_REF_CELL_ATTR}]`);
  if (cells === undefined) return [];
  const handles: RefPicker.RefPickerHandle[] = [];
  for (const rawCell of cells) {
    const cell = rawCell as HTMLElement;
    const address = cell.getAttribute(RECORD_REF_CELL_ATTR);
    const entity = cell.getAttribute(RECORD_REF_CELL_ENTITY_ATTR);
    const parsed = address === null ? null : parseTableEditCellAddress(address);
    const gridRoot = cell.closest(
      `[${RECIPES_ROUTE_RESULT_GRID_ATTR}]`,
    ) as HTMLElement | null;
    const gridKey = gridRoot?.getAttribute(RECIPES_ROUTE_RESULT_GRID_ATTR) ?? null;
    const shell = cell.querySelector('[data-ref-picker]');
    const pickerId = shell?.getAttribute('data-ref-picker') ?? null;
    if (
      parsed === null
      || entity === null
      || entity === ''
      || gridRoot === null
      || gridKey === null
      || pickerId === null
    ) continue;
    const scope = parseScope(cell.getAttribute(RECORD_REF_CELL_FILTER_ATTR));
    const value = options.valueAt(gridKey, parsed.index, parsed.key);
    const displayValue = value.startsWith(`${entity}/`)
      ? value.slice(entity.length + 1)
      : value;
    handles.push(RefPicker.wireRefPicker(cell, {
      search: options.search(entity, scope),
      config: {
        pickerId,
        placeholder: `Search ${entity.replace(/_/g, ' ')}`,
        ariaLabel: `Choose ${entity.replace(/_/g, ' ')}`,
        emptyText: 'No matching records.',
      },
      minChars: 0,
      initialValue: value === '' ? null : { id: value, label: displayValue },
      onChange: (selection) => {
        const selectedId = selection?.id ?? '';
        // Records search returns the owner-local id (for example `alice`),
        // while a ref-valued table cell carries the canonical reference
        // (`tag/alice`). Keep that storage contract inside the shared adapter
        // so every embedding host persists the same value.
        const canonicalRef = selectedId === '' || selectedId.startsWith(`${entity}/`)
          ? selectedId
          : `${entity}/${selectedId}`;
        options.onChange(
          gridKey,
          gridRoot,
          parsed.index,
          parsed.key,
          canonicalRef,
        );
      },
    }));
  }
  return handles;
};
