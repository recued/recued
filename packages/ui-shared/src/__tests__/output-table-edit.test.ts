/** The editable `table` — child rows as a repeating group.
 *
 *  The design that made this small: child rows ARE a table, and `output.render`
 *  already carries inputs (D-222's `filter` collects values and re-invokes).
 *  So there is no new primitive here — no `record_group` hint, no repeating
 *  fieldset, no new value channel. A section that already names an entity gains
 *  what `filter` has.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedTableEditDescriptor } from '@recued/contracts';
import {
  addRow, anyTableEditDirty, beginTableEditSubmit, canSubmitTableEdit,
  failTableEditSubmit, initialTableEditState, isResolvedTableEditDescriptor,
  outputTableEditConfig, outputTableEditInvocation, parseTableEditCellAddress,
  removeRow, setCell, tableEditCellAddress, tableEditStatus,
} from '../output-table-edit.js';

const D = (over: Partial<ResolvedTableEditDescriptor> = {}): ResolvedTableEditDescriptor => ({
  section_index: 2,
  recipe_hash: 'h1',
  into: 'lines',
  submit: 'Save lines',
  rows: 'add_remove',
  editable: ['description', 'quantity'],
  carry: [],
  hidden: {},
  ...over,
});

describe('seeding the grid', () => {
  it('accepts a bare array, a Records result, or a to_table result', () => {
    const rows = [{ description: 'Labour', quantity: 2 }];
    for (const data of [rows, { records: rows }, { rows }] as const) {
      expect(initialTableEditState(D(), data).rows, JSON.stringify(data).slice(0, 30))
        .toEqual([{ description: 'Labour', quantity: '2' }]);
    }
  });

  it('CARRIES a shown-but-not-editable column, so a row can say which row it is', () => {
    // ⛔⛔ The defect this replaces. Keeping only the editable set meant a grid
    // could not edit anything that already EXISTED: a rent sheet submitted
    // `{amount, method, reference}` with no tenancy reference, every receipt was
    // written against nothing, the store refused each one inside a `foreach` —
    // where a per-item failure never fails the run — and the month reported
    // success having collected no rent.
    const state = initialTableEditState(D({ carry: ['contract_ref'] }), [
      { contract_ref: 'rental_contract/c1', description: 'Labour', quantity: 2 },
    ]);
    expect(state.rows[0]).toEqual({
      contract_ref: 'rental_contract/c1', description: 'Labour', quantity: '2',
    });
  });

  it('drops a column the section neither shows nor makes editable', () => {
    // Still true, and now for the honest reason: the grid submits what the
    // section DECLARED. A key that is in neither set was never part of the
    // block, so passing it on would submit a value with no column behind it.
    const state = initialTableEditState(D({ carry: ['contract_ref'] }), [
      { contract_ref: 'rental_contract/c1', description: 'Labour', quantity: 2, secret_cost: '900' },
    ]);
    expect(Object.keys(state.rows[0]!)).not.toContain('secret_cost');
  });

  it('ALLOWS a host to set a carried column — the validation is recipe-side', () => {
    // ⛔ This used to refuse, on the reasoning that a typeable identity lets a
    // payment be re-pointed at another tenant. Wrong layer, twice over: the
    // submit path admits only the unrestricted local owner
    // (`execute-handler.ts:1176`), the renderer draws no input for a carried
    // cell anyway, and what a row may NAME is checked where it is written. The
    // refusal bound nothing real and blocked a legitimate host — a picker that
    // chooses which tenancy a new line belongs to.
    const d = D({ carry: ['contract_ref'] });
    const before = initialTableEditState(d, [
      { contract_ref: 'rental_contract/c1', description: 'x', quantity: '1' },
    ]);
    const after = setCell(d, before, 0, 'contract_ref', 'rental_contract/c2');
    expect(after.rows[0]!.contract_ref).toBe('rental_contract/c2');
    expect(after.dirty).toBe(true);
  });

  it('refuses a key the section declares NO column for', () => {
    // A shape rule, not an authorization one: a value with no column has no
    // provenance, and widening the row here would submit a field the recipe was
    // never shown.
    const d = D({ carry: ['contract_ref'] });
    const before = initialTableEditState(d, [{ contract_ref: 'c1', description: 'x', quantity: '1' }]);
    expect(setCell(d, before, 0, 'secret_cost', '900')).toBe(before);
  });

  it('sets a cell on a grid that started EMPTY', () => {
    // ⛔ The regression a row-shape check invites: deriving "is this a column"
    // from the existing rows makes every cell unsettable until one exists, so a
    // composing grid can never be filled in. The DESCRIPTOR is the source.
    const d = D({ rows: 'add_remove' });
    const state = addRow(d, initialTableEditState(d, []));
    expect(setCell(d, state, 0, 'quantity', '4').rows[0]!.quantity).toBe('4');
  });

  it('carries an ADDED row as blank, rather than borrowing another row identity', () => {
    // A composed row is not yet any record. Seeding its carried cells from the
    // row above would silently attach new lines to an existing parent.
    const d = D({ carry: ['contract_ref'] });
    const state = addRow(d, initialTableEditState(d, [
      { contract_ref: 'rental_contract/c1', description: 'x', quantity: '1' },
    ]));
    expect(state.rows[1]).toEqual({ contract_ref: '', description: '', quantity: '' });
  });

  it('renders every editable cell, even where the row omits it', () => {
    // A missing cell is an empty box, not a missing column — a ragged grid is
    // how a value lands in the wrong field.
    expect(initialTableEditState(D(), [{ description: 'Labour' }]).rows)
      .toEqual([{ description: 'Labour', quantity: '' }]);
  });

  it('starts clean, so a host can tell an untouched grid from an edited one', () => {
    expect(initialTableEditState(D(), []).dirty).toBe(false);
  });
});

describe('editing', () => {
  it('sets a cell and marks the grid dirty', () => {
    const before = initialTableEditState(D(), [{ description: 'Labour', quantity: '2' }]);
    const after = setCell(D(), before, 0, 'quantity', '3');
    expect(after.rows[0]!.quantity).toBe('3');
    expect(after.dirty).toBe(true);
    // …without mutating what it was handed.
    expect(before.rows[0]!.quantity).toBe('2');
  });

  it('becomes clean again when an edit is reverted to the rendered value', () => {
    const original = initialTableEditState(D(), [{ description: 'Labour', quantity: '2' }]);
    const changed = setCell(D(), original, 0, 'quantity', '3');
    const reverted = setCell(D(), changed, 0, 'quantity', '2');
    expect(changed.dirty).toBe(true);
    expect(reverted.dirty).toBe(false);
    expect(canSubmitTableEdit(reverted)).toBe(false);
  });

  it('ignores a cell write outside the grid', () => {
    const before = initialTableEditState(D(), [{ description: 'x', quantity: '1' }]);
    expect(setCell(D(), before, 5, 'quantity', '9')).toBe(before);
    expect(setCell(D(), before, -1, 'quantity', '9')).toBe(before);
  });

  it('adds and removes rows when the section composes', () => {
    let state = initialTableEditState(D(), []);
    state = addRow(D(), state);
    state = addRow(D(), state);
    expect(state.rows).toHaveLength(2);
    expect(state.rows[0]).toEqual({ description: '', quantity: '' });
    state = removeRow(D(), state, 0);
    expect(state.rows).toHaveLength(1);
  });

  it('becomes clean again when a newly added row is removed', () => {
    const original = initialTableEditState(D(), []);
    const added = addRow(D(), original);
    const reverted = removeRow(D(), added, 0);
    expect(added.dirty).toBe(true);
    expect(reverted.dirty).toBe(false);
  });

  it('REFUSES add/remove on a fixed grid, rather than hiding the buttons', () => {
    // ⛔ A `fixed` grid corrects what is there and composes nothing. Hiding the
    // control in the renderer would leave the state free to change anyway —
    // the refusal has to be where the change happens.
    const fixed = D({ rows: 'fixed' });
    const state = initialTableEditState(fixed, [{ description: 'x', quantity: '1' }]);
    expect(addRow(fixed, state)).toBe(state);
    expect(removeRow(fixed, state, 0)).toBe(state);
  });

  it('refuses cell and row mutations while a save is in flight', () => {
    const d = D();
    const dirty = addRow(d, initialTableEditState(d, []));
    const busy = beginTableEditSubmit(dirty);
    expect(setCell(d, busy, 0, 'quantity', '9')).toBe(busy);
    expect(addRow(d, busy)).toBe(busy);
    expect(removeRow(d, busy, 0)).toBe(busy);
  });

  it('shares save eligibility, status copy, dirty aggregation and failure recovery', () => {
    const clean = initialTableEditState(D(), []);
    const dirty = addRow(D(), clean);
    expect(canSubmitTableEdit(clean)).toBe(false);
    expect(canSubmitTableEdit(dirty)).toBe(true);
    expect(tableEditStatus(clean)).toBe('0 rows · No changes yet');
    expect(tableEditStatus(dirty)).toBe('1 row · Unsaved changes');
    expect(anyTableEditDirty(new Map([['clean', clean], ['dirty', dirty]]))).toBe(true);

    const busy = beginTableEditSubmit(dirty);
    expect(canSubmitTableEdit(busy)).toBe(false);
    expect(tableEditStatus(busy)).toBe('1 row · Saving changes…');
    expect(failTableEditSubmit(busy, 'Try again')).toMatchObject({
      busy: false, dirty: true, error: 'Try again',
    });
    expect(beginTableEditSubmit(clean)).toBe(clean);
  });

  it('round-trips a delegated cell address and rejects malformed indices', () => {
    expect(tableEditCellAddress(12, 'unit_price')).toBe('12:unit_price');
    expect(parseTableEditCellAddress('12:unit_price')).toEqual({
      index: 12, key: 'unit_price',
    });
    for (const address of ['', ':amount', '-1:amount', '1:', '1.5:amount', 'NaN:amount']) {
      expect(parseTableEditCellAddress(address), address).toBeNull();
    }
  });
});

describe('submitting', () => {
  it('sends exactly ONE key — the variable the section declared', () => {
    // ⛔ The server admits this key for this section index and refuses every
    // other, so a host cannot widen a submission by adding to the config. Same
    // bound `filter` has, for the same reason.
    const state = initialTableEditState(D(), [{ description: 'Labour', quantity: '2' }]);
    const config = outputTableEditConfig(D(), state);
    expect(Object.keys(config)).toEqual(['lines']);
    expect(config.lines).toEqual([{ description: 'Labour', quantity: '2' }]);
  });

  it('sends values as STRINGS, leaving typing to the recipe', () => {
    // `1,200.00` and `1.200,00` are the same amount in different places —
    // the same reason `csv_parse` refuses to type a cell.
    const state = initialTableEditState(D(), [{ description: 'x', quantity: 2 }]);
    expect((outputTableEditConfig(D(), state).lines as Array<Record<string, unknown>>)[0]!.quantity)
      .toBe('2');
  });

  it('sends the run settings the section declared HIDDEN, alongside the rows', () => {
    // ⛔ A submit is a fresh run of the whole recipe with only what the grid
    // sends. Without this every other variable falls to its DEFAULT, so the
    // recipe re-reads its data under settings the owner never chose —
    // `collect-rent` reverted a 10-tenancy limit to 200 and re-rendered rows the
    // grid had never shown.
    const d = D({ hidden: { limit: 10, mode: 'strict' } });
    const state = initialTableEditState(d, [{ description: 'Labour', quantity: '2' }]);
    const config = outputTableEditConfig(d, state);
    expect(Object.keys(config).sort()).toEqual(['limit', 'lines', 'mode']);
    expect(config.limit).toBe(10);
    expect(config.lines).toEqual([{ description: 'Labour', quantity: '2' }]);
  });

  it('never lets a hidden value SHADOW the rows', () => {
    // The install validator refuses a section naming its own `into` in
    // `hidden`, but a host is not the place to discover that. Here the rows
    // always win, so the worst a bad descriptor does is send a redundant value
    // — never replace the owner's edits with a stale snapshot of them.
    const d = D({ hidden: { lines: [{ description: 'STALE', quantity: '0' }] } });
    const state = initialTableEditState(d, [{ description: 'Labour', quantity: '2' }]);
    expect(outputTableEditConfig(d, state).lines)
      .toEqual([{ description: 'Labour', quantity: '2' }]);
  });

  it('carries the proof the config came from an installed section', () => {
    expect(outputTableEditInvocation(D())).toEqual({
      kind: 'output.table_edit', recipe_hash: 'h1', section_index: 2,
    });
  });

  it('guards the wire shape', () => {
    expect(isResolvedTableEditDescriptor(D())).toBe(true);
    // ⛔ `carry` is required even when empty. A host that read an absent one as
    // "carry nothing" would silently reproduce the submission that could not
    // name its own row — the failure this field exists to end.
    const { carry: _dropped, ...noCarry } = D();
    expect(isResolvedTableEditDescriptor(noCarry)).toBe(false);
    expect(isResolvedTableEditDescriptor({ ...D(), carry: [7] })).toBe(false);
    // Same rule for `hidden`: present even when empty. A host reading an absent
    // one as "send nothing extra" would silently reinstate the submission that
    // drops its run settings.
    const { hidden: _h, ...noHidden } = D();
    expect(isResolvedTableEditDescriptor(noHidden)).toBe(false);
    expect(isResolvedTableEditDescriptor({ ...D(), hidden: [] })).toBe(false);
    expect(isResolvedTableEditDescriptor({ ...D(), into: '' })).toBe(false);
    expect(isResolvedTableEditDescriptor({ ...D(), rows: 'sometimes' })).toBe(false);
    expect(isResolvedTableEditDescriptor({ ...D(), editable: [1] })).toBe(false);
  });
});
