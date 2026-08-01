/** The editable `table` — a repeating group ("an order and its line items").
 *
 *  ⛔ Not a new primitive. Child rows ARE a table, and `output.render` already
 *  carries inputs: D-222's `filter` collects edited values and re-invokes the
 *  recipe with a `Record<string, unknown>` config. This is that mechanism at
 *  ROW cardinality. The section already names the entity, so the row SHAPE
 *  comes from the pack and only the usage is authored.
 *
 *  Pure state + collection, like `output-filter.ts` beside it: the host owns
 *  the DOM and the dispatch, this owns what a submission contains.
 */
import type {
  OutputTableEditInvocation,
  ResolvedTableEditDescriptor,
} from '@recued/contracts';

/** One edited row. Values are STRINGS — a grid cell is typed text, and which
 *  of them is a number is the recipe's business, exactly as `csv_parse`
 *  refuses to type a cell. */
export type TableEditRow = Record<string, string>;

export interface OutputTableEditState {
  rows: TableEditRow[];
  /** The rows as first rendered. Keeping the baseline in the shared state makes
   *  `dirty` mean "different", not merely "an input event happened": typing a
   *  value back to what it was (or adding and then removing a row) returns the
   *  grid to a clean state in every host. */
  baseline: readonly TableEditRow[];
  busy: boolean;
  error: string | null;
  /** True while the live rows differ from their baseline. Lets a host warn
   *  before it discards, and refuse an untouched or stale submit. */
  dirty: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Seed the grid from whatever the section's source produced — a bare array, a
 *  Records `{ records }`, or a `to_table` `{ rows }`. Same tolerance the
 *  renderer has, so an editable grid can point at the data directly. */
export const initialTableEditState = (
  descriptor: ResolvedTableEditDescriptor,
  data: unknown,
): OutputTableEditState => {
  const raw = Array.isArray(data) ? data
    : isRecord(data) && Array.isArray(data.rows) ? data.rows
      : isRecord(data) && Array.isArray(data.records) ? data.records : [];
  const rows = raw.map((row) => projectRow(descriptor, row));
  return {
    rows,
    baseline: rows.map((row) => ({ ...row })),
    busy: false,
    error: null,
    dirty: false,
  };
};

const sameRows = (
  left: readonly TableEditRow[],
  right: readonly TableEditRow[],
): boolean => left.length === right.length && left.every((row, index) => {
  const other = right[index];
  if (other === undefined) return false;
  const keys = Object.keys(row);
  return keys.length === Object.keys(other).length
    && keys.every((key) => row[key] === other[key]);
});

/** Whether Save may dispatch. Kept beside the state transitions so a custom
 *  host cannot accidentally define "saveable" differently from the bundled
 *  result surfaces. */
export const canSubmitTableEdit = (state: OutputTableEditState): boolean =>
  state.dirty && !state.busy;

/** Compact, host-neutral status copy for the grid footer and live regions. */
export const tableEditStatus = (state: OutputTableEditState): string =>
  `${state.rows.length} ${state.rows.length === 1 ? 'row' : 'rows'} · ${
    state.busy ? 'Saving changes…' : state.dirty ? 'Unsaved changes' : 'No changes yet'}`;

/** Enter the one in-flight submit state. A scripted or custom host gets the
 *  same untouched/busy refusal as the stock Save button. */
export const beginTableEditSubmit = (
  state: OutputTableEditState,
): OutputTableEditState => canSubmitTableEdit(state)
  ? { ...state, busy: true, error: null }
  : state;

/** Restore an editable state after a failed save without losing any rows. */
export const failTableEditSubmit = (
  state: OutputTableEditState,
  error: string,
): OutputTableEditState => ({ ...state, busy: false, error });

/** True when replacing the current result would discard owner input. */
export const anyTableEditDirty = (
  states: ReadonlyMap<string, OutputTableEditState> | readonly OutputTableEditState[],
): boolean => (Array.isArray(states) ? states : [...states.values()])
  .some((state) => state.dirty);

/** The renderer's stable cell address and its inverse. Keeping the parsing here
 *  avoids every host inventing subtly different bounds for delegated input. */
export const tableEditCellAddress = (index: number, key: string): string =>
  `${String(index)}:${key}`;

export const parseTableEditCellAddress = (
  address: string,
): { index: number; key: string } | null => {
  const separator = address.indexOf(':');
  if (separator <= 0 || separator === address.length - 1) return null;
  const index = Number(address.slice(0, separator));
  const key = address.slice(separator + 1);
  return Number.isSafeInteger(index) && index >= 0 ? { index, key } : null;
};

/** Keep the columns the section SHOWS — the editable ones the owner types into,
 *  and the carried ones that ride along unchanged.
 *
 *  ⛔ Carrying is what makes a grid able to edit rows that already exist. This
 *  originally kept only the editable set, on the reasoning that a non-editable
 *  value would "ride into the submission as a value the owner never saw" — which
 *  is backwards: the whole array goes up under one key, so a hostile host can
 *  put anything in it either way. Dropping never constrained that host; it only
 *  stopped the honest one from saying WHICH ROW it was editing. A rent sheet
 *  submitted amounts with no tenancy and the month collected nothing.
 *
 *  A carried cell is not editable — no input is drawn for it and `setCell`
 *  refuses it — so the owner sees every value that is submitted on their behalf.
 */
const projectRow = (
  descriptor: ResolvedTableEditDescriptor,
  row: unknown,
): TableEditRow => {
  const source = isRecord(row) ? row : {};
  const out: TableEditRow = {};
  for (const key of [...descriptor.carry, ...descriptor.editable]) {
    const value = source[key];
    out[key] = typeof value === 'string' ? value
      : typeof value === 'number' || typeof value === 'boolean' ? String(value)
        : '';
  }
  return out;
};

export const setCell = (
  descriptor: ResolvedTableEditDescriptor,
  state: OutputTableEditState,
  index: number,
  key: string,
  value: string,
): OutputTableEditState => {
  // ⛔ A SHAPE check, not an authorization one. The key must be a column this
  // section declared — a value with no column has no provenance, and widening
  // the row here would submit a field the recipe was never shown.
  //
  // It deliberately does NOT refuse a CARRIED column. An earlier version did,
  // reasoning that a typeable identity would let a payment be re-pointed at
  // another tenant. That was the same misplaced control as the projection it
  // sat next to: the submit path admits only the unrestricted local owner
  // (`execute-handler.ts:1176`), the renderer draws no input for a carried
  // cell, and the recipe and store validate what a row names at write time. A
  // refusal here bound nothing real and blocked a host that legitimately wants
  // to set one — e.g. a picker that chooses which tenancy a new line belongs to.
  if (state.busy) return state;
  if (!descriptor.carry.includes(key) && !descriptor.editable.includes(key)) return state;
  if (index < 0 || index >= state.rows.length) return state;
  if (state.rows[index]?.[key] === value && state.error === null) return state;
  const rows = state.rows.map((row, i) => (i === index ? { ...row, [key]: value } : row));
  return { ...state, rows, dirty: !sameRows(rows, state.baseline), error: null };
};

export const addRow = (
  descriptor: ResolvedTableEditDescriptor,
  state: OutputTableEditState,
): OutputTableEditState => {
  // A `fixed` grid corrects what is there and composes nothing — so add/remove
  // are refused rather than hidden, and a host that draws the buttons anyway
  // still cannot change the row count.
  if (state.busy || descriptor.rows !== 'add_remove') return state;
  const rows = [...state.rows, projectRow(descriptor, {})];
  return {
    ...state,
    rows,
    dirty: !sameRows(rows, state.baseline),
    error: null,
  };
};

export const removeRow = (
  descriptor: ResolvedTableEditDescriptor,
  state: OutputTableEditState,
  index: number,
): OutputTableEditState => {
  if (state.busy || descriptor.rows !== 'add_remove') return state;
  if (index < 0 || index >= state.rows.length) return state;
  const rows = state.rows.filter((_, i) => i !== index);
  return {
    ...state,
    rows,
    dirty: !sameRows(rows, state.baseline),
    error: null,
  };
};

/** What the submission contains: the rows under the variable the section
 *  declared, plus the effective values of the variables it declared `hidden`.
 *
 *  ⛔ The server admits exactly those keys for this section index and refuses
 *  every other, so a host cannot widen a submission by adding to the config —
 *  the same bound `filter` has, for the same reason.
 *
 *  ⛔ The rows key is written LAST so it cannot be shadowed. A section naming
 *  its own `into` in `hidden` is refused at install, but a host is not the place
 *  to discover that: here the rows always win, so the worst a bad descriptor
 *  does is send a redundant value, never replace the owner's edits with a stale
 *  snapshot of them. */
export const outputTableEditConfig = (
  descriptor: ResolvedTableEditDescriptor,
  state: OutputTableEditState,
): Record<string, unknown> => {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(descriptor.hidden ?? {})) {
    config[key] = structuredClone(value);
  }
  config[descriptor.into] = state.rows.map((row) => ({ ...row }));
  return config;
};

export const outputTableEditInvocation = (
  descriptor: ResolvedTableEditDescriptor,
): OutputTableEditInvocation => ({
  kind: 'output.table_edit',
  recipe_hash: descriptor.recipe_hash,
  section_index: descriptor.section_index,
});

/** Wire-shape guard, beside the producer so the two cannot drift. */
export const isResolvedTableEditDescriptor = (
  value: unknown,
): value is ResolvedTableEditDescriptor => {
  if (!isRecord(value)) return false;
  return typeof value.into === 'string' && value.into !== ''
    && typeof value.submit === 'string'
    && typeof value.recipe_hash === 'string'
    && Number.isInteger(value.section_index)
    && (value.rows === 'fixed' || value.rows === 'add_remove')
    && Array.isArray(value.editable)
    && value.editable.every((entry) => typeof entry === 'string')
    // `carry` is REQUIRED on the wire even when empty: a host that treated an
    // absent one as "carry nothing" would silently reproduce the submission
    // that could not name its own row.
    && Array.isArray(value.carry)
    && value.carry.every((entry) => typeof entry === 'string')
    // Present even when empty, same as `carry`: an absent one read as "carry
    // nothing" would silently reinstate the submission that drops its run
    // settings, which is the failure this field exists to end.
    && isRecord(value.hidden);
};
