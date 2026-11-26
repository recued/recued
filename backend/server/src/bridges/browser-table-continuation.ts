import { AsyncLocalStorage } from 'node:async_hooks';
import { BRIDGE_INSPECT_MAX_CHARS, BRIDGE_TABLE_MAX_ROWS, isBridgeTableSort, type BridgeTableSort, type BrowserActStep } from '@recued/contracts';

const tableGoal = new AsyncLocalStorage<boolean>();
const wantsWholeTable = (message: string): boolean =>
  /(?:^|[.!?\n]\s*)\s*(?:please\s+)?(?:read|collect|extract|return|list|get|scan)\s+(?:(?:me|the)\s+)?(?:all\s+(?:of\s+the\s+)?|every\s+|(?:entire|full|whole|complete)\s+)(?:[\w-]+\s+){0,3}(?:rows?|tables?|grids?|ledgers?|records?)\b/i.test(message);

export const withBrowserTableGoal = <T>(message: string, execute: () => T): T =>
  tableGoal.run(wantsWholeTable(message), execute);

export const tableReadAfterScroll = (steps: readonly BrowserActStep[], index: number, page: string, url?: string) => {
  const scroll = steps[index];
  if (tableGoal.getStore() !== true || scroll?.do !== 'scroll' || scroll.screen !== undefined
    || (scroll.to !== undefined && scroll.to !== 'next' && scroll.to !== 'bottom')) return undefined;
  let next = index + 1;
  const wait = steps[next];
  if (wait?.do === 'wait') {
    if (wait.seconds === undefined || Object.keys(wait).some(key => key !== 'do' && key !== 'seconds')) return undefined;
    next++;
  }
  const table = steps[next];
  if (table?.do !== 'table' || table.page !== undefined && table.page !== page
    || table.url !== undefined && table.url !== url) return undefined;
  return { index: next, scope: table.ref ? { ref: table.ref } : table.selector ? { selector: table.selector } : {} };
};

export interface TableWindow {
  table_id: number;
  scroll_id: number;
  first: number;
  total: number;
  position: number;
  limit: number;
}
export interface WindowedTable {
  page: string;
  url: string;
  columns: string[];
  rows: string[][];
  sort?: BridgeTableSort;
  table_window: TableWindow;
}

export const readTableWindow = (output: Record<string, unknown>): WindowedTable | undefined => {
  const { page, url, columns, rows, sort, table_window, truncated, loading } = output;
  if (typeof page !== 'string' || typeof url !== 'string' || truncated !== false || loading === true
    || !Array.isArray(columns) || !columns.length || columns.some(column => typeof column !== 'string')
    || !Array.isArray(rows) || !rows.length || rows.some(row => !Array.isArray(row) || row.length !== columns.length
      || row.some(cell => typeof cell !== 'string')) || !table_window || typeof table_window !== 'object'
    || sort !== undefined && !isBridgeTableSort(sort)) return undefined;
  const window = table_window as TableWindow;
  if (![window.table_id, window.scroll_id, window.first, window.total].every(Number.isSafeInteger)
    || window.table_id < 1 || window.scroll_id < 1 || window.first < 1 || window.total > BRIDGE_TABLE_MAX_ROWS
    || window.first + rows.length - 1 > window.total || !Number.isFinite(window.position) || !Number.isFinite(window.limit)
    || window.position < 0 || window.limit < 0 || window.position > window.limit + 1) return undefined;
  return { page, url, columns, rows, ...(sort ? { sort } : {}), table_window: window };
};

export const collectTableWindows = async ({
  initial, advance, nextScroller,
}: {
  initial: WindowedTable;
  advance: (current: TableWindow, offset: number) => Promise<WindowedTable | undefined>;
  nextScroller?: (offset: number) => Promise<WindowedTable | undefined>;
}): Promise<{ rows: string[][]; complete: boolean; moves: number; reason: string }> => {
  const rows = [...initial.rows];
  let current = initial.table_window, offset = 0, moves = 0;
  const began = performance.now();
  const sameTable = (read: WindowedTable): boolean => read.page === initial.page && read.url === initial.url
    && read.table_window.table_id === initial.table_window.table_id && read.table_window.total === initial.table_window.total
    && read.sort?.header === initial.sort?.header && read.sort?.direction === initial.sort?.direction
    && JSON.stringify(read.columns) === JSON.stringify(initial.columns);
  const result = (reason: string) => ({ rows, complete: reason === 'all_rows', moves, reason });
  let chars = [...initial.columns, ...rows.flat()].reduce((size, text) => size + text.length, 0);
  for (; moves < 12 && performance.now() - began < 25_000;) {
    if (rows.length === current.total) return result('all_rows');
    while (current.position >= current.limit - 1) {
      if (!nextScroller || offset >= 3) return result('scroll_end');
      const enclosing = await nextScroller(++offset);
      if (!enclosing || !sameTable(enclosing) || enclosing.table_window.scroll_id === current.scroll_id
        || enclosing.table_window.first !== current.first
        || enclosing.rows.some((row, i) => JSON.stringify(row) !== JSON.stringify(rows[current.first - 1 + i]))) return result('scroll_end');
      current = enclosing.table_window;
    }
    const next = await advance(current, offset);
    moves++;
    if (!next || !sameTable(next) || next.table_window.scroll_id !== current.scroll_id) return result('window_unavailable');
    if (next.table_window.position <= current.position) return result('no_scroll_progress');
    if (next.table_window.first < current.first || next.table_window.first > rows.length + 1) return result('row_gap');
    const start = next.table_window.first - 1;
    const overlap = Math.min(rows.length - start, next.rows.length);
    if (next.rows.slice(0, overlap).some((row, i) => JSON.stringify(row) !== JSON.stringify(rows[start + i]))) return result('row_overlap_changed');
    const newRows = next.rows.slice(overlap);
    if (newRows.length === 0 && next.table_window.position < next.table_window.limit - 1) return result('rows_unchanged');
    for (const row of newRows) {
      chars += row.reduce((size, text) => size + text.length, 0);
      if (chars > BRIDGE_INSPECT_MAX_CHARS) return result('capture_limit');
      rows.push(row);
    }
    current = next.table_window;
  }
  return result(rows.length === current.total ? 'all_rows' : 'walk_limit');
};
