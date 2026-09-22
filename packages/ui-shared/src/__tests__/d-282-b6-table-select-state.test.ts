/** D-282 B6 — the selectable table's shared state.
 *
 *  Pure, and therefore the right place to pin the rules every host must share:
 *  what can be selected, what a submission contains, and what a failure keeps. */
import { describe, expect, it } from 'vitest';
import type { ResolvedTableSelectDescriptor } from '@recued/contracts';

import {
  beginTableSelectSubmit,
  canSubmitTableSelect,
  failTableSelectSubmit,
  initialTableSelectState,
  isResolvedTableSelectDescriptor,
  isTableRowSelected,
  outputTableSelectConfig,
  outputTableSelectInvocation,
  setAllTableSelection,
  tableSelectAllState,
  tableSelectRowId,
  tableSelectStatus,
  toggleTableSelection,
} from '../output-table-select.js';

const descriptor = (
  over: Partial<ResolvedTableSelectDescriptor> = {},
): ResolvedTableSelectDescriptor => ({
  section_index: 2,
  recipe_hash: 'stored-hash',
  into: 'picked',
  submit: 'Accept selected',
  id_field: 'id',
  hidden: {},
  ...over,
});

const rows = [
  { id: 'doc_1', label: 'Passport' },
  { id: 'doc_2', label: 'Payslip' },
];

describe('what can be selected', () => {
  it('takes the ids off the rows, tolerating every shape a source produces', () => {
    for (const data of [rows, { rows }, { records: rows }]) {
      expect(initialTableSelectState(descriptor(), data).selectable)
        .toEqual(['doc_1', 'doc_2']);
    }
  });

  /** ⛔ A ROW WITH NO ID IS NOT SELECTABLE. Submitting `""` for it hands the
   *  receiving `foreach` a blank it writes against nothing — and a per-item
   *  refusal inside a foreach never fails the run, so the owner would be told
   *  it worked. */
  it('drops rows whose id field is absent, blank, or not a scalar', () => {
    const state = initialTableSelectState(descriptor(), [
      { id: 'doc_1' },
      { id: '   ' },
      { label: 'no id at all' },
      { id: { nested: true } },
    ]);
    expect(state.selectable).toEqual(['doc_1']);
    expect(tableSelectRowId(descriptor(), { label: 'no id at all' })).toBeNull();
  });

  /** ⚠ One record shown twice — a join that fanned out — is still one record.
   *  Submitting its id twice makes a `foreach` act on it twice, which for
   *  "archive" is harmless and for "charge" is not. */
  it('dedupes a repeated id', () => {
    expect(initialTableSelectState(descriptor(), [
      { id: 'doc_1' }, { id: 'doc_1' }, { id: 'doc_2' },
    ]).selectable).toEqual(['doc_1', 'doc_2']);
  });

  /** ⛔ An unresolved identity makes NOTHING selectable, rather than falling
   *  back to some other column. */
  it('selects nothing when the identity could not be resolved', () => {
    const state = initialTableSelectState(
      descriptor({ id_field: '', unresolved: 'no_identity' }),
      rows,
    );
    expect(state.selectable).toEqual([]);
    expect(tableSelectStatus(state)).toBe('Nothing here can be selected');
  });
});

describe('ticking', () => {
  const base = () => initialTableSelectState(descriptor(), rows);

  it('toggles one row and reports it', () => {
    const one = toggleTableSelection(base(), 'doc_2');
    expect(one.selected).toEqual(['doc_2']);
    expect(isTableRowSelected(one, 'doc_2')).toBe(true);
    expect(toggleTableSelection(one, 'doc_2').selected).toEqual([]);
  });

  /** ⚠ In the order the owner SAW, not the order they clicked — a receipt that
   *  lists rows in click order reads as a different set than the screen. */
  it('keeps the selection in row order however it was built', () => {
    const state = toggleTableSelection(toggleTableSelection(base(), 'doc_2'), 'doc_1');
    expect(state.selected).toEqual(['doc_1', 'doc_2']);
  });

  it('ignores an id the table cannot submit', () => {
    const state = base();
    expect(toggleTableSelection(state, 'doc_9')).toBe(state);
  });

  it('drives the header control through its three states', () => {
    let state = base();
    expect(tableSelectAllState(state)).toBe('none');
    state = toggleTableSelection(state, 'doc_1');
    expect(tableSelectAllState(state)).toBe('some');
    state = setAllTableSelection(state, true);
    expect(tableSelectAllState(state)).toBe('all');
    expect(state.selected).toEqual(['doc_1', 'doc_2']);
    expect(setAllTableSelection(state, false).selected).toEqual([]);
  });

  it('refuses every mutation while a submission is in flight', () => {
    const busy = beginTableSelectSubmit(toggleTableSelection(base(), 'doc_1'));
    expect(busy.busy).toBe(true);
    expect(toggleTableSelection(busy, 'doc_2')).toBe(busy);
    expect(setAllTableSelection(busy, true)).toBe(busy);
  });
});

describe('what a submission contains', () => {
  it('sends the ids under the declared variable, plus the hidden carriers', () => {
    const d = descriptor({ hidden: { limit: 50, stage: 'proposed' } });
    const state = setAllTableSelection(initialTableSelectState(d, rows), true);
    expect(outputTableSelectConfig(d, state)).toEqual({
      limit: 50,
      stage: 'proposed',
      picked: ['doc_1', 'doc_2'],
    });
    expect(outputTableSelectInvocation(d)).toEqual({
      kind: 'output.table_select',
      recipe_hash: 'stored-hash',
      section_index: 2,
    });
  });

  /** ⛔ The ids key is written LAST so a bad descriptor cannot shadow it. A
   *  section naming its own `into` in `hidden` is refused at install, but a
   *  host is not the place to discover that — here the ids always win. */
  it('cannot be shadowed by a hidden carrier of the same name', () => {
    const d = descriptor({ hidden: { picked: ['stale'] } });
    const state = toggleTableSelection(initialTableSelectState(d, rows), 'doc_1');
    expect(outputTableSelectConfig(d, state)).toEqual({ picked: ['doc_1'] });
  });

  it('refuses to dispatch an empty selection', () => {
    const state = initialTableSelectState(descriptor(), rows);
    expect(canSubmitTableSelect(state)).toBe(false);
    expect(beginTableSelectSubmit(state)).toBe(state);
    expect(canSubmitTableSelect(toggleTableSelection(state, 'doc_1'))).toBe(true);
  });

  /** ⛔ A failure KEEPS the selection. Read the reason, press again — not
   *  re-tick five rows to find out whether the second attempt behaves
   *  differently. */
  it('keeps the selection when the action fails', () => {
    const picked = toggleTableSelection(initialTableSelectState(descriptor(), rows), 'doc_2');
    const failed = failTableSelectSubmit(beginTableSelectSubmit(picked), 'the server said no');
    expect(failed.selected).toEqual(['doc_2']);
    expect(failed.busy).toBe(false);
    expect(failed.error).toBe('the server said no');
  });

  it('counts what is picked, because the count is what gets acted on', () => {
    const state = toggleTableSelection(initialTableSelectState(descriptor(), rows), 'doc_1');
    expect(tableSelectStatus(state)).toBe('1 of 2 selected');
    expect(tableSelectStatus(beginTableSelectSubmit(state))).toBe('Working on 1…');
  });
});

describe('the wire guard', () => {
  it('accepts the shape the engine emits', () => {
    expect(isResolvedTableSelectDescriptor(descriptor())).toBe(true);
  });

  /** ⛔ `id_field` and `hidden` are REQUIRED on the wire even when empty. A
   *  host treating either as optional would fall back to some other column, or
   *  drop the run settings the owner was looking at. */
  it.each([
    ['no id_field', { id_field: undefined }],
    ['no hidden', { hidden: undefined }],
    ['no into', { into: '' }],
    ['a non-integer section index', { section_index: 1.5 }],
  ])('refuses a descriptor with %s', (_name, over) => {
    expect(isResolvedTableSelectDescriptor({ ...descriptor(), ...over })).toBe(false);
  });
});
