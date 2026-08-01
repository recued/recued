/** A `table` whose columns come from the entity schema.
 *
 *  The point is that a pack names its fields ONCE. Before this the same list
 *  was written into a `to_table` step, again into `record_fields`, and again
 *  into `to_csv` — parallel copies of one entity's shape, drifting apart.
 */
import { describe, expect, it } from 'vitest';
import type { ResolvedRecordColumnsDescriptor } from '@recued/contracts';
import { renderTableBlock } from '../table.js';

const UNIT: ResolvedRecordColumnsDescriptor = {
  entity: 'unit',
  columns: [
    { field: 'label', label: 'Label', kind: 'string' },
    { field: 'active', label: 'Active', kind: 'boolean' },
  ],
};

const rows = [{ label: 'Flat 1', active: true }, { label: 'Flat 2', active: false }];

describe('entity-derived table columns', () => {
  it('draws the resolved columns, with their schema labels', () => {
    const html = renderTableBlock({ rows }, undefined, UNIT);
    expect(html).toContain('>Label ');
    expect(html).toContain('>Active ');
    expect(html).toContain('Flat 1');
    expect(html).toContain('Flat 2');
  });

  it('takes rows from a bare array or a Records result, not just { rows }', () => {
    // ⛔ The reason a derived table can drop its `to_table` step entirely: with
    // columns resolved host-side, `source` can point straight at the data. A
    // block that only understood `{ columns, rows }` would force the step back.
    for (const data of [rows, { records: rows }, { rows }] as const) {
      const html = renderTableBlock(data, undefined, UNIT);
      expect(html, JSON.stringify(data).slice(0, 40)).toContain('Flat 1');
      expect(html).toContain('Flat 2');
    }
  });

  it('KEEPS an authored action column beside the derived ones', () => {
    // ⛔ Nothing in an entity schema declares "Open this row", so deriving
    // columns must not drop the row actions a list depends on. The schema
    // supplies the data columns; the author still supplies the action one.
    const html = renderTableBlock({
      columns: [
        { field: 'label', label: 'HAND-WRITTEN', type: 'text' },
        { field: 'actions', label: 'Do', type: 'action' },
      ],
      rows: rows.map((row) => ({
        ...row,
        actions: [{ kind: 'recipe.run', label: 'Open', recipe_id: 'show-unit' }],
      })),
    }, undefined, UNIT);

    // the derived label wins over the hand-written one for a data column…
    expect(html).toContain('>Label ');
    expect(html).not.toContain('HAND-WRITTEN');
    // …and the action column is still there, rendered as an action.
    expect(html).toContain('>Do ');
    expect(html).toContain('action-recipe-run');
    expect(html).toContain('Open');
  });

  it('falls back to the authored columns when nothing resolved', () => {
    // `unresolved: 'no_schema'` — the pack is not installed, or the entity is
    // not in its schema. Degrading to the authored table beats a headerless
    // one: the block still shows the data it was given.
    const html = renderTableBlock(
      { columns: [{ field: 'label', label: 'Authored' }], rows },
      undefined,
      { entity: 'unit', columns: [], unresolved: 'no_schema' },
    );
    expect(html).toContain('>Authored ');
    expect(html).toContain('Flat 1');
  });

  it('is unchanged for a table that named no entity', () => {
    const html = renderTableBlock({ columns: [{ field: 'label', label: 'Authored' }], rows });
    expect(html).toContain('>Authored ');
    expect(html).not.toContain('>Label ');
  });
});

describe('quantities read right-aligned', () => {
  const MONEY: ResolvedRecordColumnsDescriptor = {
    entity: 'receipt',
    columns: [
      { field: 'tenant', label: 'Tenant', kind: 'string' },
      { field: 'amount', label: 'Amount', kind: 'decimal' },
      { field: 'nights', label: 'Nights', kind: 'number' },
      { field: 'received_at', label: 'Received', kind: 'datetime', format: 'date' },
      { field: 'settled', label: 'Settled', kind: 'boolean' },
    ],
  };
  const html = renderTableBlock(
    { rows: [{ tenant: 'Ada', amount: '1200.0000', nights: 3, received_at: '2026-02-01', settled: true }] },
    undefined, MONEY,
  );

  it('marks the number and decimal columns, header and cell', () => {
    // ⛔ From the declared KIND, never the runtime value. Money in a Records
    // pack is a `decimal` slot returned as the STRING "1200.0000" — a
    // `typeof value === 'number'` test left-aligns every amount in a ledger.
    expect(html).toMatch(/<th[^>]*class="[^"]*is-numeric[^"]*"[^>]*>Amount/);
    expect(html).toMatch(/<td class="is-numeric">1200\.0000<\/td>/);
    expect(html).toContain('<td class="is-numeric">3</td>');
  });

  it('leaves text, dates and booleans alone', () => {
    // A date is ordered but reads as a label — right-aligning it separates the
    // column from its heading for no gain.
    expect(html).toContain('<td>Ada</td>');
    expect(html).not.toMatch(/<td class="is-numeric">2026/);
    expect(html).not.toMatch(/<td class="is-numeric">(true|Yes)/);
  });

  it('marks nothing on a hand-written table, which declares no kinds', () => {
    const plain = renderTableBlock({
      columns: [{ field: 'amount', label: 'Amount' }], rows: [{ amount: '12.00' }],
    });
    expect(plain).not.toContain('is-numeric');
  });
});
