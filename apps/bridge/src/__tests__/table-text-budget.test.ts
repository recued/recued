import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_TABLE_LIMITS, readPageTable, type PageTableLimits } from '../actions/page-table.js';

afterEach(() => { vi.unstubAllGlobals(); });

interface FixtureNode {
  nodeType: number;
  localName?: string;
  nodeValue?: string;
  childNodes?: FixtureNode[];
  type?: string;
  value?: string;
}

const text = (value: string): FixtureNode => ({ nodeType: 3, nodeValue: value });
const element = (localName: string, attrs: Record<string, string> = {}, childNodes: FixtureNode[] = []) => ({
  nodeType: 1, localName, childNodes,
  parentElement: null,
  getRootNode: () => ({ host: null }),
  getAttribute: (name: string) => attrs[name] ?? null,
  checkVisibility: () => !('hidden' in attrs),
});

type Cell = string | { text?: string; attrs?: Record<string, string>; children?: FixtureNode[] };

// The real reader and layout run against a small HTML table/visibility adapter.
// Native DOM behavior is also qualified separately with local browser fixtures.
const table = (headers: Cell[][], rows: Cell[][], limits: PageTableLimits = PAGE_TABLE_LIMITS) => {
  const row = (cells: Cell[], header: boolean) => ({
    ...element('tr'), parentElement: element(header ? 'thead' : 'tbody'),
    cells: cells.map(cell => typeof cell === 'string' ? element(header ? 'th' : 'td', {}, [text(cell)])
      : element(header ? 'th' : 'td', cell.attrs, cell.children ?? [text(cell.text ?? '')])),
  });
  const fixture = { ...element('table'), rows: [...headers.map(cells => row(cells, true)), ...rows.map(cells => row(cells, false))] };
  vi.stubGlobal('document', {
    title: 'Fixture', documentElement: { hasAttribute: () => false }, querySelectorAll: () => [fixture],
  });
  vi.stubGlobal('location', { href: 'https://example.test/table' });
  vi.stubGlobal('Node', { ELEMENT_NODE: 1, TEXT_NODE: 3 });
  vi.stubGlobal('getComputedStyle', () => ({ display: 'table-cell' }));
  const answer = readPageTable({}, limits);
  if (!('outputs' in answer)) throw new Error('fixture returned no table');
  return answer.outputs;
};

const bounded = (out: ReturnType<typeof table>, max = PAGE_TABLE_LIMITS.max_chars) => {
  const chars = [...out.columns, ...out.rows.flat()].reduce((sum, value) => sum + value.length, 0);
  expect(chars).toBeLessThanOrEqual(max);
  expect(out.rows.every(row => row.length === out.columns.length)).toBe(true);
};

describe('table column labels and cells share one text budget', () => {
  it('bounds header-heavy output and marks omitted columns and rows', () => {
    const labels = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(2, '0')}${'H'.repeat(998)}`);
    const out = table([labels], [Array(50).fill('x')]);
    bounded(out);
    expect(out.truncated).toBe(true);
    expect(out.columns).toEqual(labels.slice(0, 40));
    expect(out.rows).toEqual([]);
  });

  it('reserves header text before accepting whole body rows', () => {
    const labels = Array(20).fill('H'.repeat(1000));
    const first = Array(20).fill('a'.repeat(750));
    const second = Array(20).fill('b'.repeat(750));
    const out = table([labels], [first, second]);
    bounded(out);
    expect(out.truncated).toBe(true);
    expect(out.columns).toEqual(labels);
    expect(out.rows).toEqual([first]);
  });

  it('counts generated column names against a body that already fills the budget', () => {
    const out = table([], [Array(20).fill('x'.repeat(2000))]);
    bounded(out);
    expect(out.truncated).toBe(true);
    expect(out.columns).toEqual(Array.from({ length: 20 }, (_, i) => `column ${i + 1}`));
    expect(out.rows).toEqual([]);
  });

  it('counts multi-row header separators as returned text', () => {
    const limits = { ...PAGE_TABLE_LIMITS, max_chars: 15 };
    const out = table([['AA', 'CC'], ['BB', 'DD']], [['x', 'y']], limits);
    bounded(out, limits.max_chars);
    expect(out).toMatchObject({ columns: ['AA / BB', 'CC / DD'], rows: [], truncated: true });
  });

  it('returns no rows when not even the first complete column label fits', () => {
    const limits = { ...PAGE_TABLE_LIMITS, max_chars: 5 };
    const out = table([['0123456789']], [['x']], limits);
    bounded(out, limits.max_chars);
    expect(out).toMatchObject({ columns: [], rows: [], truncated: true });
  });

  it('keeps retained columns and body cells aligned when the label prefix is cut', () => {
    const limits = { ...PAGE_TABLE_LIMITS, max_chars: 8 };
    const out = table([['AA', 'BBBB', 'CCCC']], [['x', 'y', 'z']], limits);
    bounded(out, limits.max_chars);
    expect(out).toMatchObject({ columns: ['AA', 'BBBB'], rows: [['x', 'y']], truncated: true });
  });

  it('preserves an ordinary table whose labels and cells exactly fill the budget', () => {
    const out = table([['Deal', 'Amount']], [['Acme', '$1,200']], { ...PAGE_TABLE_LIMITS, max_chars: 20 });
    bounded(out, 20);
    expect(out).toEqual({ url: 'https://example.test/table', title: 'Fixture',
      columns: ['Deal', 'Amount'], rows: [['Acme', '$1,200']], truncated: false });
  });

  it('preserves multi-row headers, colspan and rowspan alignment within the budget', () => {
    const out = table([[{ text: 'Group', attrs: { colspan: '2' } }], ['Name', 'Value']],
      [[{ text: 'Acme', attrs: { rowspan: '2' } }, 'one'], ['two']]);
    bounded(out);
    expect(out).toMatchObject({ columns: ['Group / Name', 'Group / Value'],
      rows: [['Acme', 'one'], ['Acme', 'two']], truncated: false });
  });

  it('keeps hidden text and protected field values out of the returned cells', () => {
    const out = table([['Visible']], [[{ children: [text('public '),
      element('span', { hidden: '' }, [text('hidden secret')]),
      element('span', { 'aria-hidden': 'true' }, [text('aria secret')]),
      { ...element('input'), type: 'password', value: 'password secret' },
      { ...element('input', { autocomplete: 'one-time-code' }), type: 'text', value: 'code secret' },
      text('tail')] }]]);
    bounded(out);
    expect(out).toMatchObject({ columns: ['Visible'], rows: [['public tail']], truncated: false });
  });

  it('preserves the existing row limit and truncation flag', () => {
    const out = table([['Name']], [['First'], ['Second']], { ...PAGE_TABLE_LIMITS, max_rows: 1 });
    bounded(out);
    expect(out).toMatchObject({ columns: ['Name'], rows: [['First']], truncated: true });
  });

  it('preserves generated column names for an ordinary headerless table', () => {
    const out = table([], [['one', 'two'], ['three', 'four']]);
    bounded(out);
    expect(out).toMatchObject({ columns: ['column 1', 'column 2'], rows: [['one', 'two'], ['three', 'four']], truncated: false });
  });
});
