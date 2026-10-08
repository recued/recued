/** A table column's `field` is a path into the row (2026-10-07). */

import { describe, expect, it } from 'vitest';

import { renderTableBlock } from '../table.js';
import { tableFieldValue } from '../table-field.js';

describe('tableFieldValue', () => {
  it('reads a top-level key, a nested path and an array index', () => {
    const row = { target_id: 'ada@x.com', value: { pressure_score: 7, signals: ['quiet', 'overdue'] }, attendees: [{ email: 'b@x.com' }] };
    expect(tableFieldValue(row, 'target_id')).toBe('ada@x.com');
    expect(tableFieldValue(row, 'value.pressure_score')).toBe(7);
    expect(tableFieldValue(row, 'value.signals.1')).toBe('overdue');
    expect(tableFieldValue(row, 'attendees.0.email')).toBe('b@x.com');
  });

  it('matches a key that itself contains dots whole, at any depth, before splitting it', () => {
    expect(tableFieldValue({ 'hs.lead_status': 'open', hs: { lead_status: 'other' } }, 'hs.lead_status')).toBe('open');
    expect(tableFieldValue({ properties: { 'Account.Name': 'Acme' } }, 'properties.Account.Name')).toBe('Acme');
    // A dotted key whose branch ends falls back to the shorter split.
    expect(tableFieldValue({ 'a.b': { c: 1 }, a: { b: { d: 2 } } }, 'a.b.d')).toBe(2);
    // HiBob writes slashes inside a key; they are just characters.
    expect(tableFieldValue({ fields: { '/attendanceEntry/id': { value: 42 } } }, 'fields./attendanceEntry/id.value')).toBe(42);
  });

  it("is undefined for a missing path, a non-object, and anything not the row's own", () => {
    expect(tableFieldValue({ value: { score: 1 } }, 'value.missing')).toBeUndefined();
    expect(tableFieldValue({ value: 3 }, 'value.score')).toBeUndefined();
    expect(tableFieldValue('a row that is text', 'length')).toBeUndefined();
    expect(tableFieldValue(null, 'x')).toBeUndefined();
    expect(tableFieldValue({ x: 1 }, '')).toBeUndefined();
    expect(tableFieldValue({ x: { y: 1 } }, 'x..y')).toBeUndefined();
    expect(tableFieldValue({}, 'toString')).toBeUndefined();
    expect(tableFieldValue({ a: {} }, 'a.constructor.name')).toBeUndefined();
    expect(tableFieldValue({ a: {} }, '__proto__')).toBeUndefined();
    expect(tableFieldValue(JSON.parse('{"__proto__":{"polluted":1}}'), '__proto__.polluted')).toBeUndefined();
  });
});

describe('the table block reads each column as a path', () => {
  // The open-loop table `end-of-day-shutdown-review` ships, with its own rows.
  const openLoops = {
    columns: [
      { field: 'target_id', label: 'Contact' },
      { field: 'value.pressure_score', label: 'Pressure' },
      { field: 'value.open_count', label: 'Open items' },
    ],
    rows: [{ target_id: 'ada@x.com', value: { pressure_score: 7, open_count: 3 } }],
  };

  it('shows the value inside the row, where it drew "—"', () => {
    const html = renderTableBlock(openLoops).replace(/\s+/g, ' ');
    expect(html).toContain('<td>ada@x.com</td><td>7</td><td>3</td>');
    expect(html).not.toContain('<td>—</td>');
  });

  it('groups by a path too', () => {
    const html = renderTableBlock({
      columns: [{ field: 'code', label: 'Code' }],
      rows: [{ code: 'J-1', status: { name: 'open' } }, { code: 'J-2', status: { name: 'quoted' } }],
    }, undefined, undefined, 'status.name');
    expect((html.match(/class="group-row"/g) ?? []).length).toBe(2);
    expect(html).toContain('data-group="open"');
    expect(html).toContain('data-group="quoted"');
  });
});
