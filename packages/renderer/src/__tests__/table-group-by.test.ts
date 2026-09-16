/** `table.group_by` — a grouped list is still a list.
 *
 *  ⛔ WHAT THESE PIN beyond "it renders". The whole reason this is a facet on
 *  `table` rather than a `board` member of `OUTPUT_TYPES` is that it must
 *  degrade: one header row, document order, and byte-identical output to the
 *  ungrouped table when no grouping is asked for. Each of those is asserted,
 *  because a regression in any one turns a declaration back into a layout.
 */
import { describe, expect, it } from 'vitest';
import { renderTableBlock } from '../table.js';

const columns = [{ field: 'name', label: 'Name' }, { field: 'status', label: 'Status' }];
const rows = [
  { name: 'alpha', status: 'open' },
  { name: 'beta', status: 'done' },
  { name: 'gamma', status: 'open' },
];

describe('table.group_by', () => {
  it('changes nothing when no grouping is asked for', () => {
    // The facet is additive or it is not a facet. Byte-identical, not merely
    // "still renders" — a stray wrapper or attribute here would mean every
    // existing table's markup moved for a feature it does not use.
    const plain = renderTableBlock({ columns, rows });
    const undef = renderTableBlock({ columns, rows }, undefined, undefined, undefined);
    expect(undef).toBe(plain);
    expect(plain).not.toContain('group-row');
    expect(plain).not.toContain('data-group-by');
  });

  it('buckets rows under one header row per distinct value', () => {
    const html = renderTableBlock({ columns, rows }, undefined, undefined, 'status');
    expect(html).toContain('data-group-by="status"');
    expect((html.match(/class="group-row"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-group="open"');
    expect(html).toContain('data-group="done"');
    // ONE table header, not one per group — the degraded reading is a list.
    expect((html.match(/<thead>/g) ?? []).length).toBe(1);
    expect((html.match(/<table/g) ?? []).length).toBe(1);
  });

  it('keeps first-appearance order, not alphabetical', () => {
    // `open` appears before `done` in the rows; alphabetically it would not.
    // A status vocabulary has a meaningful sequence the alphabet does not know,
    // so the only never-wrong order is the one the producing step chose.
    const html = renderTableBlock({ columns, rows }, undefined, undefined, 'status');
    expect(html.indexOf('data-group="open"')).toBeLessThan(html.indexOf('data-group="done"'));
  });

  it('counts the rows in each bucket', () => {
    const html = renderTableBlock({ columns, rows }, undefined, undefined, 'status');
    const open = html.slice(html.indexOf('data-group="open"'));
    expect(open).toContain('<span class="group-count">2</span>');
  });

  it('keeps every row, and never loses one to a missing field', () => {
    // ⛔ THE SILENT-LOSS SHAPE THIS GUARDS. Grouping by a field some rows lack
    // must not drop them: a row that vanished because a field was missing looks
    // exactly like a row that was never there. They land in a trailing bucket,
    // visibly odd, which is how an author finds out they grouped by the wrong
    // field.
    const mixed = [{ name: 'a', status: 'open' }, { name: 'b' }, { name: 'c', status: '' }];
    const html = renderTableBlock({ columns, rows: mixed }, undefined, undefined, 'status');
    for (const name of ['a', 'b', 'c']) expect(html).toContain(`>${name}<`);
    expect(html).toContain('—');
    // and the no-value bucket sorts last
    expect(html.indexOf('data-group="open"')).toBeLessThan(html.lastIndexOf('group-row'));
  });

  it('escapes a group value rather than letting it reach the markup', () => {
    const nasty = [{ name: 'x', status: '<img src=x onerror=alert(1)>' }];
    const html = renderTableBlock({ columns, rows: nasty }, undefined, undefined, 'status');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
