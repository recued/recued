/** The selectable `table` — pick rows, then act on the set (D-282 B6).
 *
 *  Pure state + collection, like `output-table-edit.ts` beside it: the host
 *  owns the DOM and the dispatch, this owns what a submission contains.
 *
 *  ⛔⛔ THE SAME MECHANISM AS THE EDITABLE GRID, AT A DIFFERENT CARDINALITY OF
 *  VALUE. `edit` submits an array of OBJECTS — what each row should become.
 *  `select` submits an array of STRINGS — which rows the owner picked. Both go
 *  up under one declared variable, through one bounded invocation, to a fresh
 *  run of the same recipe. Nothing here is a new kind of input.
 *
 *  🔑 AND ONE DELIBERATE DIFFERENCE: A SELECTION IS NOT "DIRTY". The grid's
 *  whole discard discipline — `baseline`, `dirty`, `anyTableEditDirty`, the
 *  "throw away your unsaved changes?" confirm every host asks before it
 *  replaces a result — exists because typed text is work that cannot be
 *  recovered. Ticking three checkboxes is not; re-ticking them costs three
 *  clicks. So this module has no baseline and no dirty flag, and hosts must
 *  NOT gate navigation on a live selection. Copying that discipline across by
 *  analogy would put a modal in front of every click that leaves a list.
 */
import type {
  OutputTableSelectInvocation,
  ResolvedTableSelectDescriptor,
} from '@recued/contracts';

export interface OutputTableSelectState {
  /** The ids the owner has ticked, in the row order they were rendered in. */
  selected: readonly string[];
  /** Every id this table CAN submit, in row order. The "select all" universe,
   *  and what tells a host whether the header checkbox is fully, partly or not
   *  at all set. */
  selectable: readonly string[];
  busy: boolean;
  error: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read one row's id, or null when it has none.
 *
 *  ⛔ NULL IS A REAL ANSWER AND MUST STAY ONE. A row whose id field is absent,
 *  empty, or not a scalar cannot be acted on — submitting `""` for it would
 *  hand the recipe a blank the `foreach` then writes against nothing, and the
 *  run reports success having skipped it. Those rows render with no checkbox
 *  rather than with one that quietly does less than it looks like. */
const rowId = (descriptor: ResolvedTableSelectDescriptor, row: unknown): string | null => {
  if (!isRecord(row)) return null;
  const raw = row[descriptor.id_field];
  const value = typeof raw === 'string' ? raw
    : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw)
      : '';
  return value.trim().length === 0 ? null : value;
};

/** Seed from whatever the section's source produced — a bare array, a Records
 *  `{ records }`, or a `to_table` `{ rows }`. Same tolerance as the grid's, so
 *  a selectable table can point at the data directly. */
export const initialTableSelectState = (
  descriptor: ResolvedTableSelectDescriptor,
  data: unknown,
): OutputTableSelectState => {
  const raw = Array.isArray(data) ? data
    : isRecord(data) && Array.isArray(data.rows) ? data.rows
      : isRecord(data) && Array.isArray(data.records) ? data.records : [];
  // An unresolved identity means the host could not say which field IS the row
  // — nothing is selectable, and the renderer says why instead of drawing
  // controls that would submit the wrong thing.
  const ids = descriptor.unresolved !== undefined
    ? []
    : raw.map((row) => rowId(descriptor, row)).filter((id): id is string => id !== null);
  // ⚠ DEDUPED. One record shown twice (a join that fanned out) is still one
  // record, and submitting its id twice would make a `foreach` act on it twice
  // — which for "archive" is harmless and for "charge" is not.
  return {
    selected: [],
    selectable: [...new Set(ids)],
    busy: false,
    error: null,
  };
};

/** Which id a row contributes, for a host binding a checkbox to a rendered
 *  row. Exported so no host re-derives the tolerance above. */
export const tableSelectRowId = (
  descriptor: ResolvedTableSelectDescriptor,
  row: unknown,
): string | null => (descriptor.unresolved !== undefined ? null : rowId(descriptor, row));

export const isTableRowSelected = (
  state: OutputTableSelectState,
  id: string,
): boolean => state.selected.includes(id);

/** Tick or untick one row. An id this table cannot submit is ignored rather
 *  than added — the selectable set is the authority, not the DOM. */
export const toggleTableSelection = (
  state: OutputTableSelectState,
  id: string,
  selected?: boolean,
): OutputTableSelectState => {
  if (state.busy) return state;
  if (!state.selectable.includes(id)) return state;
  const want = selected ?? !state.selected.includes(id);
  if (want === state.selected.includes(id)) return state;
  // Kept in the selectable order, not in click order: the submission then
  // reads in the order the owner saw, which is what makes a receipt legible.
  const next = want
    ? state.selectable.filter((entry) => entry === id || state.selected.includes(entry))
    : state.selected.filter((entry) => entry !== id);
  return { ...state, selected: next, error: null };
};

/** The header control. `true` selects everything this table can submit. */
export const setAllTableSelection = (
  state: OutputTableSelectState,
  selected: boolean,
): OutputTableSelectState => {
  if (state.busy) return state;
  return { ...state, selected: selected ? [...state.selectable] : [], error: null };
};

/** Tri-state for the header checkbox. */
export const tableSelectAllState = (
  state: OutputTableSelectState,
): 'none' | 'some' | 'all' => {
  if (state.selected.length === 0) return 'none';
  return state.selected.length >= state.selectable.length ? 'all' : 'some';
};

/** Whether the action may dispatch. Kept beside the transitions so a custom
 *  host cannot define "actionable" differently from the bundled surfaces. */
export const canSubmitTableSelect = (state: OutputTableSelectState): boolean =>
  state.selected.length > 0 && !state.busy;

/** Compact, host-neutral status copy. Says the COUNT, because the count is the
 *  thing an owner checks before pressing a button that acts on all of them. */
export const tableSelectStatus = (state: OutputTableSelectState): string => {
  if (state.busy) return `Working on ${state.selected.length}…`;
  if (state.selected.length === 0) {
    return state.selectable.length === 0
      ? 'Nothing here can be selected'
      : 'Select rows to act on';
  }
  return `${state.selected.length} of ${state.selectable.length} selected`;
};

export const beginTableSelectSubmit = (
  state: OutputTableSelectState,
): OutputTableSelectState => (canSubmitTableSelect(state)
  ? { ...state, busy: true, error: null }
  : state);

/** Restore after a failed action WITHOUT losing the selection — the owner
 *  should be able to read the error and press again, not re-tick five rows. */
export const failTableSelectSubmit = (
  state: OutputTableSelectState,
  error: string,
): OutputTableSelectState => ({ ...state, busy: false, error });

/** What the submission contains: the chosen ids under the variable the section
 *  declared, plus the effective values of the variables it declared `hidden`.
 *
 *  ⛔ The server admits exactly those keys for this section index and refuses
 *  every other — the same bound `filter` and `table_edit` have.
 *
 *  ⛔ The ids key is written LAST so it cannot be shadowed, for the reason its
 *  sibling gives: a section naming its own `into` in `hidden` is refused at
 *  install, but a host is not the place to discover that. */
export const outputTableSelectConfig = (
  descriptor: ResolvedTableSelectDescriptor,
  state: OutputTableSelectState,
): Record<string, unknown> => {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(descriptor.hidden ?? {})) {
    config[key] = structuredClone(value);
  }
  config[descriptor.into] = [...state.selected];
  return config;
};

export const outputTableSelectInvocation = (
  descriptor: ResolvedTableSelectDescriptor,
): OutputTableSelectInvocation => ({
  kind: 'output.table_select',
  recipe_hash: descriptor.recipe_hash,
  section_index: descriptor.section_index,
});

/** Wire-shape guard, beside the producer so the two cannot drift. */
export const isResolvedTableSelectDescriptor = (
  value: unknown,
): value is ResolvedTableSelectDescriptor => {
  if (!isRecord(value)) return false;
  return typeof value.into === 'string' && value.into !== ''
    && typeof value.submit === 'string'
    && typeof value.recipe_hash === 'string'
    && Number.isInteger(value.section_index)
    // Present even when empty — an EMPTY one is how `unresolved` reports that
    // the identity could not be found, and a host that treated the field as
    // optional would fall back to some other column and submit the wrong set.
    && typeof value.id_field === 'string'
    && isRecord(value.hidden);
};
