import { createSpreadsheetSearch, parseSpreadsheetAddress, type SpreadsheetCellRef, type SpreadsheetSearchState, type SpreadsheetSheetData } from './spreadsheet-search.js';
import { xlsxColumnName } from './xlsx-workbook.js';

export const spreadsheetAddress = (row: number, column: number) => `${xlsxColumnName(column)}${row}`;

/** One find/jump interaction owner shared by paged CSV and XLSX tables. */
export const mountSpreadsheetFinder = (opts: {
  doc: Document; root: HTMLElement; table: HTMLTableElement; grid: HTMLElement; signal: AbortSignal;
  csv?: boolean;
  sheets: readonly string[];
  currentSheet(): number;
  read(sheet: number): SpreadsheetSheetData | Promise<SpreadsheetSheetData>;
  open(cell: SpreadsheetCellRef): void;
}) => {
  const { doc, signal, grid, table } = opts;
  const element = doc.createElement('section'); element.className = 'spreadsheet-finder'; element.setAttribute('aria-label', 'Find and go to cell');
  const style = doc.createElement('style'); style.textContent = STYLES;
  const findBar = doc.createElement('div'); findBar.className = 'spreadsheet-find-controls';
  const findLabel = doc.createElement('label'); findLabel.textContent = opts.csv ? 'Find in CSV' : 'Find in workbook';
  const input = doc.createElement('input'); input.type = 'search'; input.maxLength = 512; input.autocomplete = 'off';
  input.setAttribute('aria-label', findLabel.textContent); findLabel.append(input); findBar.append(findLabel);
  const button = (parent: HTMLElement, label: string, action: () => void) => {
    const item = doc.createElement('button'); item.type = 'button'; item.textContent = label;
    item.addEventListener('click', action, { signal }); parent.append(item); return item;
  };
  const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('data-spreadsheet-find-status', '');
  const jumpBar = doc.createElement('div'); jumpBar.className = 'spreadsheet-jump-controls';
  const jumpLabel = doc.createElement('label'); jumpLabel.textContent = 'Cell';
  const address = doc.createElement('input'); address.type = 'text'; address.maxLength = 16; address.placeholder = 'D240'; address.autocomplete = 'off';
  address.setAttribute('aria-label', 'Cell address'); address.setAttribute('autocapitalize', 'characters'); address.spellcheck = false;
  jumpLabel.append(address); jumpBar.append(jumpLabel);
  const jumpStatus = doc.createElement('p'); jumpStatus.setAttribute('role', 'status'); jumpStatus.setAttribute('data-spreadsheet-jump-status', ''); jumpStatus.hidden = true;
  const error = doc.createElement('p'); error.setAttribute('role', 'alert'); error.hidden = true;
  let target: SpreadsheetCellRef | undefined, navigation = 0, jumpGeneration = 0;
  let automatic: { owner: Element | null; navigation: number } | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const manualNavigation = () => {
    navigation++; jumpGeneration++; automatic = undefined; error.hidden = true; jumpStatus.hidden = true; address.removeAttribute('aria-invalid');
  };
  const paint = () => {
    const currentSheet = opts.currentSheet();
    const matches = new Set(search.state().matches.filter(cell => cell.sheet === currentSheet).map(cell => spreadsheetAddress(cell.row, cell.column)));
    const active = target?.sheet === currentSheet ? spreadsheetAddress(target.row, target.column) : undefined;
    for (const cell of table.querySelectorAll<HTMLElement>('[data-spreadsheet-cell]')) {
      cell.toggleAttribute('data-spreadsheet-find-match', matches.has(cell.getAttribute('data-spreadsheet-cell')!));
      cell.toggleAttribute('data-spreadsheet-active-cell', cell.getAttribute('data-spreadsheet-cell') === active);
    }
  };
  const open = (cell: SpreadsheetCellRef) => {
    target = cell; address.value = spreadsheetAddress(cell.row, cell.column); error.hidden = true; address.removeAttribute('aria-invalid');
    opts.open(cell); paint();
    const own = navigation;
    // Let the input's paint finish before scrolling; WebKit can otherwise
    // reveal the caret again and undo a scroll to a newly selected result.
    doc.defaultView?.requestAnimationFrame(() => setTimeout(() => {
      if (signal.aborted || target !== cell || own !== navigation || opts.currentSheet() !== cell.sheet || !grid.isConnected) return;
      const node = table.querySelector<HTMLElement>(`[data-spreadsheet-cell="${spreadsheetAddress(cell.row, cell.column)}"]`);
      if (!node) return;
      const rect = node.getBoundingClientRect(), bounds = grid.getBoundingClientRect();
      const header = table.tHead?.getBoundingClientRect().height ?? 0;
      const rowHeader = table.tBodies[0]?.querySelector('th')?.getBoundingClientRect().width ?? 0;
      grid.scrollTop += rect.top - bounds.top - header - Math.max(0, (grid.clientHeight - header - rect.height) / 2);
      grid.scrollLeft += rect.left - bounds.left - rowHeader - Math.max(0, (grid.clientWidth - rowHeader - rect.width) / 2);
      grid.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, 0));
  };
  const run = (intent = { owner: doc.activeElement, navigation }) => { clearTimeout(timer); automatic = intent; void search.start(); };
  button(findBar, 'Find', run);
  const previous = button(findBar, 'Previous match', () => { manualNavigation(); search.previous(); });
  const next = button(findBar, 'Next match', () => { manualNavigation(); search.next(); });
  const stop = button(findBar, 'Stop search', () => { manualNavigation(); clearTimeout(timer); search.stop(); input.focus({ preventScroll: true }); });
  const update = (state: SpreadsheetSearchState) => {
    previous.disabled = next.disabled = state.matches.length === 0; stop.hidden = state.phase !== 'searching';
    const count = state.matches.length, selected = state.matches[state.active];
    const summary = selected ? `Cell ${state.active + 1} of ${count} · ${opts.sheets[selected.sheet]} · ${spreadsheetAddress(selected.row, selected.column)}`
      : `${count} matching ${count === 1 ? 'cell' : 'cells'}`;
    const issues = state.issues.length ? ` Unsearched worksheets: ${state.issues.slice(0, 3).map(issue => `${opts.sheets[issue.sheet]} (${issue.message})`).join('; ')}${state.issues.length > 3 ? `; and ${state.issues.length - 3} more` : ''}.` : '';
    status.textContent = state.phase === 'idle' ? opts.csv ? 'Searches all data rows. Cell addresses exclude the header.' : 'Searches saved cell values across all worksheets.'
      : state.phase === 'searching' ? `Searching ${opts.csv ? 'CSV rows' : `worksheet ${Math.min(state.searched + 1, state.total)} of ${state.total}`}… ${count} matching cells so far.`
      : (state.phase === 'stopped' ? `Search stopped. ${count} matching ${count === 1 ? 'cell' : 'cells'} found so far.` : count ? summary : state.limited || state.issues.length ? 'No matches in the searched cells.' : 'No matching cells.')
        + (state.limited ? ' Search limits reached; some cells were not searched. Download the file to search the rest.' : '') + issues;
    paint();
    if (state.phase === 'done' && automatic && count) {
      const intent = automatic; automatic = undefined;
      if (intent.owner === doc.activeElement && intent.navigation === navigation) search.select(0);
    }
  };
  const search = createSpreadsheetSearch({ total: opts.sheets.length, read: opts.read, changed: update,
    selected: cell => { jumpGeneration++; open(cell); } });
  const jump = async () => {
    manualNavigation(); clearTimeout(timer); const own = jumpGeneration, sheet = opts.currentSheet();
    const cell = parseSpreadsheetAddress(address.value);
    const fail = (message: string) => { address.setAttribute('aria-invalid', 'true'); error.textContent = message; error.hidden = false; jumpStatus.hidden = true; };
    if (!cell) { fail('Enter a cell address such as D240.'); return; }
    try {
      const data = await opts.read(sheet);
      if (signal.aborted || own !== jumpGeneration || sheet !== opts.currentSheet()) return;
      if (!data.rowCount || !data.columnCount) { fail('This worksheet has no cells to jump to.'); return; }
      if (cell.row > data.rowCount || cell.column > data.columnCount) {
        fail(`Choose a cell within A1:${spreadsheetAddress(data.rowCount, data.columnCount)}.`); return;
      }
      search.clearSelection(); open({ ...cell, sheet });
      jumpStatus.textContent = `${opts.sheets[sheet]} · ${spreadsheetAddress(cell.row, cell.column)}`; jumpStatus.hidden = false;
    } catch (failure) {
      if (!signal.aborted && own === jumpGeneration) fail(failure instanceof Error ? failure.message : 'This worksheet could not be read.');
    }
  };
  button(jumpBar, 'Go to cell', () => { void jump(); });
  address.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void jump(); } }, { signal });
  input.addEventListener('input', () => {
    clearTimeout(timer); manualNavigation(); target = undefined; jumpStatus.hidden = true; search.setQuery(input.value);
    // Capture the typing owner now. A later page/sheet change must also retire
    // automatic navigation from a search whose debounce has not fired yet.
    const intent = { owner: doc.activeElement, navigation };
    if (input.value.trim()) timer = setTimeout(() => run(intent), 180);
  }, { signal });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (search.state().matches.length) { manualNavigation(); event.shiftKey ? search.previous() : search.next(); } else run();
    } else if (event.key === 'Escape' && input.value) {
      event.preventDefault(); event.stopPropagation(); clearTimeout(timer); manualNavigation(); target = undefined; input.value = ''; search.setQuery('');
    }
  }, { signal });
  const keyboardOwner = opts.root.closest('[data-file-preview]') ?? opts.root;
  keyboardOwner.addEventListener('keydown', event => {
    if (event instanceof KeyboardEvent && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f'
      && !element.closest('[hidden],[aria-hidden="true"]')) {
      event.preventDefault(); input.focus(); input.select();
    }
  }, { signal });
  signal.addEventListener('abort', () => { clearTimeout(timer); search.dispose(); jumpGeneration++; }, { once: true });
  element.append(style, findBar, status, jumpBar, error, jumpStatus);
  update(search.state());
  return { element, paint, manualNavigation };
};

const STYLES = `
.spreadsheet-finder { display:grid; gap:8px; min-width:0; }
.spreadsheet-finder [hidden] { display:none !important; }
.spreadsheet-find-controls,.spreadsheet-jump-controls { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.spreadsheet-finder label { display:flex; flex:1 1 220px; gap:8px; align-items:center; width:auto; font:inherit; white-space:nowrap; }
.spreadsheet-finder .spreadsheet-jump-controls label { flex:0 1 210px; }
.spreadsheet-finder input { box-sizing:border-box; width:100%; min-width:0; min-height:44px; padding:8px; border:1px solid var(--border,#c8cdd4); border-radius:6px;
  color:var(--fg,#222); background:var(--surface,#fff); font:inherit; }
.spreadsheet-finder button { min-height:44px; }
.spreadsheet-finder p { margin:0; font-size:13px; color:var(--fg-muted,#596170); }
.spreadsheet-finder [role=alert] { color:var(--danger,#b91c1c); }
.spreadsheet-finder :is(input,button):focus-visible { outline:2px solid var(--accent,#187c91); outline-offset:2px; }
:is(.xlsx-preview,.csv-preview) [data-spreadsheet-find-match] { background:color-mix(in srgb,var(--accent,#187c91) 15%,var(--surface,#fff)); }
:is(.xlsx-preview,.csv-preview) [data-spreadsheet-active-cell] { background:color-mix(in srgb,var(--accent,#187c91) 25%,var(--surface,#fff)); outline:2px solid var(--accent,#187c91); outline-offset:-2px; }
`;
