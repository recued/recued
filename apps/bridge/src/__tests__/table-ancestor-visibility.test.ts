import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_TABLE_LIMITS, readPageTable } from '../actions/page-table.js';
import type { PageInspectScope } from '../actions/page-inspect.js';

afterEach(() => { vi.unstubAllGlobals(); });

// Controlled DOM ancestry and visibility; the real table selector, reader and
// layout run unchanged. Native DOM behavior is qualified in browser fixtures.
class FixtureElement {
  nodeType = 1;
  isConnected = true;
  parentElement: FixtureElement | null = null;
  assignedSlot: FixtureElement | null = null;
  rootHost: FixtureElement | null = null;
  cssVisible = true;
  rows: FixtureElement[] = [];
  cells: FixtureElement[] = [];
  childNodes: Array<FixtureElement | { nodeType: number; nodeValue: string }> = [];
  constructor(public localName: string, public attrs: Record<string, string> = {}, text?: string) {
    if (text !== undefined) this.childNodes.push({ nodeType: 3, nodeValue: text });
  }
  getAttribute(name: string) { return this.attrs[name] ?? null; }
  checkVisibility() { return this.cssVisible; }
  getRootNode() { return { host: this.rootHost }; }
  querySelectorAll(selector: string) {
    return selector === '[role="row"]' ? this.rows : selector.startsWith('[role="cell"]') ? this.cells : [];
  }
  closest(selector: string): FixtureElement | null {
    for (let at: FixtureElement | null = this; at; at = at.parentElement) {
      if (selector === '[role="row"]' ? at.getAttribute('role') === 'row'
        : at.localName === 'table' || ['table', 'grid', 'treegrid'].includes(at.getAttribute('role') ?? '')) return at;
    }
    return null;
  }
}

type Cell = string | { text: string; hidden: true };
const makeTable = (columns = ['Name'], values: Cell[][] = [['hidden-value']], grid = false, hiddenRowGroup = false) => {
  const table = new FixtureElement(grid ? 'div' : 'table', grid ? { role: 'grid' } : {});
  const header = new FixtureElement(grid ? 'div' : 'thead'); header.parentElement = table;
  const row = (cells: Cell[], heading: boolean, parent: FixtureElement) => {
    const out = new FixtureElement(grid ? 'div' : 'tr', grid ? { role: 'row' } : {}); out.parentElement = parent;
    out.cells = cells.map(value => {
      const cell = new FixtureElement(grid ? 'span' : heading ? 'th' : 'td', {
        ...(grid ? { role: heading ? 'columnheader' : 'gridcell' } : {}),
        ...(typeof value === 'string' ? {} : { 'aria-hidden': 'true' }),
      }, typeof value === 'string' ? value : value.text);
      cell.parentElement = out;
      return cell;
    });
    return out;
  };
  table.rows = [row(columns, true, header), ...values.map((cells, index) => {
    const group = new FixtureElement(grid ? 'div' : 'tbody', hiddenRowGroup && index === 0 ? { 'aria-hidden': 'true' } : {});
    group.parentElement = table;
    return row(cells, false, group);
  })];
  return table;
};

type Mode = 'hidden-parent' | 'hidden-first' | 'named-grid' | 'hidden-row-group' | 'shadow-host' | 'assigned-slot'
  | 'visible-aligned' | 'own-hidden' | 'css-hidden-parent';

const read = (mode: Mode) => {
  const table = mode === 'visible-aligned' ? makeTable(['First', 'Second'], [[{ text: 'secret', hidden: true }, 'public']])
    : mode === 'hidden-row-group' ? makeTable(['Name'], [['hidden-value'], ['public']], false, true)
      : makeTable(['Name'], [['hidden-value']], mode === 'named-grid');
  const tables = [table];
  let scope: PageInspectScope = {};
  if (['hidden-parent', 'hidden-first', 'named-grid'].includes(mode)) {
    table.parentElement = new FixtureElement('section', { 'aria-hidden': 'true' });
    table.attrs['aria-hidden'] = 'false'; // A descendant cannot undo an ancestor's exclusion.
    if (mode === 'hidden-first') tables.push(makeTable(['Visible'], [['public']]));
    if (mode === 'named-grid') scope = { selector: '#grid' };
  }
  if (mode === 'shadow-host') {
    table.rootHost = new FixtureElement('custom-table', { 'aria-hidden': 'true' });
    scope = { ref: 'e1' };
  }
  if (mode === 'assigned-slot') {
    const host = new FixtureElement('custom-table');
    const wrapper = new FixtureElement('section', { 'aria-hidden': 'true' }); wrapper.rootHost = host;
    const slot = new FixtureElement('slot'); slot.parentElement = wrapper;
    table.parentElement = host; table.assignedSlot = slot;
    scope = { ref: 'e1' };
  }
  if (mode === 'visible-aligned') table.parentElement = new FixtureElement('section', { 'aria-hidden': 'false' });
  if (mode === 'own-hidden') table.attrs['aria-hidden'] = 'true';
  if (mode === 'css-hidden-parent') {
    table.parentElement = new FixtureElement('section', { style: 'display:none' });
    table.cssVisible = false;
  }
  vi.stubGlobal('document', { title: 'Fixture', documentElement: { hasAttribute: () => false },
    querySelectorAll: () => tables, querySelector: () => table });
  vi.stubGlobal('location', { href: 'https://example.test/table' });
  vi.stubGlobal('Node', { ELEMENT_NODE: 1, TEXT_NODE: 3 });
  vi.stubGlobal('getComputedStyle', () => ({ display: 'table-cell' }));
  vi.stubGlobal('recuedPageRefs', { byRef: new Map([['e1', table]]) });
  return readPageTable(scope, PAGE_TABLE_LIMITS);
};

describe('table reads respect inherited ARIA visibility', () => {
  it.each(['hidden-parent', 'named-grid', 'shadow-host', 'assigned-slot'] as const)(
    'does not read a table through a %s exclusion', mode => { expect(read(mode)).toEqual({ missing: true }); });

  it('chooses the visible table after a table in an excluded container', () => {
    expect(read('hidden-first')).toMatchObject({ outputs: { columns: ['Visible'], rows: [['public']], truncated: false } });
  });

  it('omits an excluded row group without losing the visible rows', () => {
    expect(read('hidden-row-group')).toMatchObject({ outputs: { columns: ['Name'], rows: [['public']], truncated: false } });
  });

  it('preserves visible data and empty cell positions beneath an aria-hidden=false container', () => {
    expect(read('visible-aligned')).toMatchObject({ outputs: { columns: ['First', 'Second'], rows: [['', 'public']], truncated: false } });
  });

  it.each(['own-hidden', 'css-hidden-parent'] as const)('preserves the existing %s exclusion', mode => {
    expect(read(mode)).toEqual({ missing: true });
  });
});
