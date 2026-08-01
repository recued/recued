/** `record_ref`, extended: a SCOPE, and a grid cell that is a picker.
 *
 *  ⛔⛔ WHY A SCOPE. `ledger-book`'s tags are one entity holding several
 *  INDEPENDENT TREES — `person -> department -> division` is one, a project
 *  tree is another — and a line may carry at most one tag from each. A picker
 *  offering every tag therefore offers, at every keystroke, choices the write
 *  will refuse. Scoping it is what puts the rule in the CONTROL instead of in a
 *  guard the owner meets after typing.
 *
 *  ⛔ WHY CELLS. A ref column in an editable grid rendered as a text box, so the
 *  owner typed `tag/alice` by hand — the raw-id field `record_ref` exists to
 *  replace, one layer down. The schema already knows the target entity; it just
 *  never reached the cell.
 *
 *  ⚠ Both are DISCOVERY UX, never authority. Narrowing what is offered does not
 *  narrow what the operation admits, and a caller ignoring the picker is gated
 *  by the op's binding exactly as before. */
import { describe, expect, it } from 'vitest';
import {
  VALUE_HINT_KEYS,
  entityFieldsFromRecordsSnapshot,
  resolveRecordColumns,
  tableColumnInputType,
  type RecordsEntitySnapshot,
} from '../index.js';

const SNAPSHOT = {
  kind: 'leg_tag',
  fields: [
    { key: 'id', slot: 'pk', kind: 'id', required: true },
    { key: 'tag_ref', slot: 'r2', kind: 'ref', required: true, references: 'tag' },
    { key: 'amount', slot: 'dec1', kind: 'decimal', required: true },
    { key: 'booked_on', slot: 'd1', kind: 'date', required: true },
  ],
} as unknown as RecordsEntitySnapshot;

describe('a ref column reaches the cell knowing its target', () => {
  const columns = resolveRecordColumns(
    'leg_tag', entityFieldsFromRecordsSnapshot(SNAPSHOT)).columns;
  const byField = new Map(columns.map(c => [c.field, c]));

  it('⛔ the ref column carries `references`', () => {
    expect(byField.get('tag_ref')?.references).toBe('tag');
  });

  it('⚠ and no other column does — a picker over nothing is worse than a box', () => {
    expect(byField.get('amount')?.references).toBeUndefined();
    expect(byField.get('booked_on')?.references).toBeUndefined();
  });

  it('⛔⛔ a ref cell is NOT a plain input — that is what makes it a picker', () => {
    expect(tableColumnInputType(byField.get('tag_ref')!)).toBeNull();
  });

  it('⛔ the guard PERMITS every other kind — it is not a blanket null', () => {
    expect(tableColumnInputType(byField.get('amount')!)).toBe('number');
    expect(tableColumnInputType(byField.get('booked_on')!)).toBe('date');
  });

  it('⚠ an authored `control: text` still wins — a ref typed raw stays raw', () => {
    // The escape hatch has to outrank the derived default, or a pack with a
    // legitimately hand-typed reference loses the ability to say so.
    expect(tableColumnInputType({ kind: 'ref', references: 'tag', control: 'text' }))
      .toBe('text');
  });

  it('⚠ a ref with NO target stays a text box', () => {
    // Nothing to search. Rendering a picker would open an empty chooser.
    expect(tableColumnInputType({ kind: 'ref' })).toBe('text');
  });
});

describe('the scope is part of the hint vocabulary', () => {
  it('⛔ `entity_filter` is fenced in — an unlisted key is refused', () => {
    // The fence and the member list read one source; a member missing from the
    // list makes the fence reject a legitimate recipe.
    expect(VALUE_HINT_KEYS).toContain('entity_filter');
    expect(VALUE_HINT_KEYS).toContain('entity');
  });
});
