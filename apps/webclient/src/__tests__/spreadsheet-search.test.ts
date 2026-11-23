import { describe, expect, it, vi } from 'vitest';
import { createSpreadsheetSearch, parseSpreadsheetAddress, type SpreadsheetCell, type SpreadsheetSheetData } from '../files/spreadsheet-search.js';

const sheet = (...cells: SpreadsheetCell[]): SpreadsheetSheetData => ({ rowCount: 240, columnCount: 30, cells });
const defaults = { changed: () => {}, selected: () => {}, yieldControl: async () => {} };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe('spreadsheet cell addresses', () => {
  it('accepts absolute and lowercase A1 addresses and rejects ranges, formulas and out-of-range references', () => {
    expect(parseSpreadsheetAddress(' $aa$240 ')).toEqual({ row: 240, column: 27 });
    expect(parseSpreadsheetAddress('XFD1048576')).toEqual({ row: 1_048_576, column: 16384 });
    for (const invalid of ['A0', '0A', '=A1', 'A1:B2', 'Sheet!A1', 'R1C1', 'A1.5', 'XFE1', 'A1048577', '']) {
      expect(parseSpreadsheetAddress(invalid)).toBeUndefined();
    }
  });
});

describe('spreadsheet value search', () => {
  it('matches literal displayed values, normalizes Unicode and counts a repeated word once per cell', async () => {
    const search = createSpreadsheetSearch({ ...defaults, total: 1, read: () => sheet(
      { row: 240, column: 27, text: '😀 Cafe\u0301\nﬁle café file' }, { row: 1, column: 2, text: '<img.*>' },
    ) });
    search.setQuery('CAFÉ file'); await search.start();
    expect(search.state().matches).toEqual([{ sheet: 0, row: 240, column: 27 }]);
    search.setQuery('<img.*>'); await search.start();
    expect(search.state().matches).toEqual([{ sheet: 0, row: 1, column: 2 }]);
  });

  it('searches all worksheets and wraps selection in both directions without renumbering sparse cells', async () => {
    const selected = vi.fn();
    const search = createSpreadsheetSearch({ ...defaults, selected, total: 3, read: index => index === 1 ? sheet()
      : sheet({ row: index ? 2 : 240, column: index ? 1 : 21, text: 'target' }) });
    search.setQuery('target'); await search.start();
    expect(search.state()).toMatchObject({ phase: 'done', searched: 3, limited: false });
    expect(search.state().matches).toEqual([{ sheet: 0, row: 240, column: 21 }, { sheet: 2, row: 2, column: 1 }]);
    search.previous(); expect(selected.mock.lastCall?.[0]).toEqual({ sheet: 2, row: 2, column: 1 });
    search.next(); expect(search.state().active).toBe(0);
    search.previous(); expect(search.state().active).toBe(1);
    search.clearSelection(); expect(search.state().active).toBe(-1);
    search.next(); expect(selected.mock.lastCall?.[0]).toEqual({ sheet: 0, row: 240, column: 21 });
  });

  it('ignores an old read when a query changes away and back before it resolves', async () => {
    const old = deferred<SpreadsheetSheetData>(); let first = true;
    const search = createSpreadsheetSearch({ ...defaults, total: 1, read: () => {
      if (first) { first = false; return old.promise; }
      return sheet({ row: 2, column: 1, text: 'alpha' });
    } });
    search.setQuery('alpha'); const pending = search.start();
    search.setQuery('beta'); search.setQuery('alpha');
    old.resolve(sheet({ row: 1, column: 1, text: 'alpha' })); await pending;
    expect(search.state()).toMatchObject({ phase: 'idle', matches: [] });
    await search.start(); expect(search.state().matches).toEqual([{ sheet: 0, row: 2, column: 1 }]);
  });

  it('can stop in the middle of a worksheet without publishing later cells', async () => {
    const gate = deferred<void>(), reached = deferred<void>();
    const search = createSpreadsheetSearch({ ...defaults, total: 1,
      read: () => sheet(...Array.from({ length: 500 }, (_, row) => ({ row: row + 1, column: 1, text: 'target' }))),
      yieldControl: () => { reached.resolve(); return gate.promise; },
    });
    search.setQuery('target'); const pending = search.start(); await reached.promise;
    search.stop(); gate.resolve(); await pending;
    expect(search.state()).toMatchObject({ phase: 'stopped', searched: 0 });
    expect(search.state().matches).toHaveLength(250);
  });

  it('publishes nothing when a read finishes after the preview has closed', async () => {
    const read = deferred<SpreadsheetSheetData>(), changed = vi.fn();
    const search = createSpreadsheetSearch({ ...defaults, total: 1, changed, read: () => read.promise });
    search.setQuery('target'); const pending = search.start(); search.dispose(); changed.mockClear();
    read.resolve(sheet({ row: 1, column: 1, text: 'target' })); await pending;
    expect(changed).not.toHaveBeenCalled();
  });

  it('retains good matches and reports worksheets that could not be searched', async () => {
    const search = createSpreadsheetSearch({ ...defaults, total: 3, read: index => {
      if (index === 1) throw new Error('Preview limits exceeded');
      return sheet({ row: 1, column: 1, text: 'target' });
    } });
    search.setQuery('target'); await search.start();
    expect(search.state()).toMatchObject({ phase: 'done', searched: 3, issues: [{ sheet: 1, message: 'Preview limits exceeded' }] });
    expect(search.state().matches.map(cell => cell.sheet)).toEqual([0, 2]);
  });

  it('reports partial results when a cell, character or matching-cell budget is exceeded', async () => {
    for (const limits of [{ cells: 1 }, { characters: 6 }, { matches: 1 }]) {
      const search = createSpreadsheetSearch({ ...defaults, total: 1, limits,
        read: () => sheet({ row: 1, column: 1, text: 'target' }, { row: 2, column: 1, text: 'target' }) });
      search.setQuery('target'); await search.start();
      expect(search.state()).toMatchObject({ phase: 'done', limited: true });
      expect(search.state().matches).toEqual([{ sheet: 0, row: 1, column: 1 }]);
    }
  });

  it('does not report partial coverage when all cells exactly fit the budgets', async () => {
    const search = createSpreadsheetSearch({ ...defaults, total: 1, limits: { cells: 1, characters: 6, matches: 1 },
      read: () => sheet({ row: 1, column: 1, text: 'target' }) });
    search.setQuery('target'); await search.start();
    expect(search.state()).toMatchObject({ phase: 'done', searched: 1, limited: false });
    expect(search.state().matches).toHaveLength(1);
  });
});
