import { readPreviewWorker } from './read-preview-worker.js';
import { parseXlsxSheet, parseXlsxWorkbook, xlsxColumnName, type XlsxSheetData } from './xlsx-workbook.js';
import { XlsxPreviewError, type XlsxParts } from './xlsx-model.js';

const PAGE_ROWS = 50;

export const renderXlsxPreview = async (doc: Document, host: HTMLElement, bytes: Uint8Array, signal: AbortSignal): Promise<void> => {
  const parts = await readPreviewWorker<XlsxParts>(doc, 'xlsx', bytes, signal);
  if (!parts || signal.aborted) return;
  const workbook = parseXlsxWorkbook(doc, parts);
  let selected = Math.max(0, workbook.sheets.findIndex(sheet => !sheet.hidden)), page = 0;
  let data: XlsxSheetData | undefined;
  const positions = new Map<number, { page: number; top: number; left: number }>();
  const root = doc.createElement('section'); root.className = 'xlsx-preview'; root.setAttribute('aria-label', 'Spreadsheet preview');
  const style = doc.createElement('style'); style.textContent = XLSX_PREVIEW_STYLES;
  const controls = doc.createElement('div'); controls.className = 'xlsx-preview-controls';
  const label = doc.createElement('label'); label.textContent = 'Worksheet';
  const select = doc.createElement('select'); select.setAttribute('aria-label', 'Worksheet');
  workbook.sheets.forEach((sheet, index) => {
    const option = doc.createElement('option'); option.value = String(index); option.textContent = sheet.name + (sheet.hidden ? ' (hidden)' : ''); select.append(option);
  });
  const choice = doc.createElement('span'); choice.className = 'xlsx-preview-choice'; choice.append(select);
  select.value = String(selected); label.append(choice); controls.append(label);
  const range = doc.createElement('p'); range.className = 'xlsx-preview-range'; range.setAttribute('role', 'status');
  const error = doc.createElement('p'); error.className = 'xlsx-preview-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const grid = doc.createElement('div'); grid.className = 'xlsx-preview-grid'; grid.tabIndex = 0;
  grid.setAttribute('role', 'region'); grid.setAttribute('aria-label', 'Worksheet scroll area');
  const table = doc.createElement('table'), head = doc.createElement('thead'), body = doc.createElement('tbody');
  table.append(head, body); grid.append(table);
  const navigation = doc.createElement('nav'); navigation.className = 'xlsx-preview-navigation'; navigation.setAttribute('aria-label', 'Worksheet rows');
  const button = (text: string) => { const control = doc.createElement('button'); control.type = 'button'; control.textContent = text; return control; };
  const previous = button('Previous rows'), next = button('Next rows'); navigation.append(previous, next);
  const note = doc.createElement('p'); note.className = 'xlsx-preview-note';
  root.append(style, controls, range, error, grid, navigation, note); host.append(root);

  const drawPage = () => {
    if (!data || signal.aborted) return;
    const left = grid.scrollLeft, sheet = workbook.sheets[selected]!;
    table.setAttribute('aria-label', `Worksheet: ${sheet.name}`); body.replaceChildren();
    const start = page * PAGE_ROWS, end = Math.min(start + PAGE_ROWS, data.rowCount);
    for (let index = start + 1; index <= end; index++) {
      const row = doc.createElement('tr'), number = doc.createElement('th');
      number.scope = 'row'; number.textContent = String(index); row.append(number);
      for (let column = 1; column <= data.columnCount; column++) {
        const cell = doc.createElement('td'), value = data.rows.get(index)?.get(column);
        cell.textContent = value?.text ?? '';
        if (value?.missing) { cell.className = 'xlsx-preview-missing'; cell.title = 'This formula has no saved result. Open the workbook in a spreadsheet app to calculate it.'; }
        else if (value?.formula) cell.title = 'Formula result saved with the workbook.';
        else if (value && value.raw !== value.text && value.raw) cell.title = `Stored value: ${value.raw}`;
        row.append(cell);
      }
      body.append(row);
    }
    range.textContent = data.rowCount ? `Rows ${start + 1}–${end} of ${data.rowCount} · Columns A–${xlsxColumnName(data.columnCount)}`
      : 'This worksheet has no saved cell values.';
    grid.hidden = data.rowCount === 0; navigation.hidden = data.rowCount <= PAGE_ROWS;
    previous.setAttribute('aria-disabled', String(page === 0)); next.setAttribute('aria-disabled', String(end >= data.rowCount));
    grid.scrollTop = 0; grid.scrollLeft = left;
  };
  const drawSheet = () => {
    if (signal.aborted) return;
    error.hidden = true; head.replaceChildren(); body.replaceChildren();
    note.textContent = 'Read-only cells · Simplified formatting. Charts and images are not shown.';
    try {
      data = parseXlsxSheet(doc, workbook, workbook.sheets[selected]!);
      const saved = positions.get(selected); page = saved?.page ?? 0;
      const headers = doc.createElement('tr'), corner = doc.createElement('th'); corner.setAttribute('aria-label', 'Row number'); headers.append(corner);
      for (let column = 1; column <= data.columnCount; column++) { const th = doc.createElement('th'); th.scope = 'col'; th.textContent = xlsxColumnName(column); headers.append(th); }
      head.append(headers);
      if (data.formulas) note.textContent += ' Formula results are from the saved file and may be out of date.';
      if (data.missingValues) note.textContent += ` ${data.missingValues} ${data.missingValues === 1 ? 'formula has' : 'formulas have'} no saved result.`;
      drawPage(); grid.scrollTop = saved?.top ?? 0; grid.scrollLeft = saved?.left ?? 0;
    } catch (failure) {
      data = undefined; grid.hidden = true; navigation.hidden = true; range.textContent = '';
      error.textContent = failure instanceof XlsxPreviewError ? failure.message : 'This worksheet could not be read. Download the file to open it.';
      error.hidden = false;
    }
  };
  select.addEventListener('change', () => {
    if (signal.aborted) return;
    positions.set(selected, { page, top: grid.scrollTop, left: grid.scrollLeft });
    selected = Number(select.value); drawSheet();
  }, { signal });
  previous.addEventListener('click', () => { if (!signal.aborted && data && page > 0) { page--; drawPage(); } }, { signal });
  next.addEventListener('click', () => { if (!signal.aborted && data && (page + 1) * PAGE_ROWS < data.rowCount) { page++; drawPage(); } }, { signal });
  drawSheet();
};

const XLSX_PREVIEW_STYLES = `
.xlsx-preview { display:grid; gap:12px; min-width:0; max-width:100%; }
.xlsx-preview [hidden] { display:none !important; }
.xlsx-preview-controls,.xlsx-preview-navigation { display:flex; flex-wrap:wrap; gap:8px; }
.xlsx-preview label { display:grid; gap:6px; min-width:0; width:min(280px,100%); max-width:100%; font-size:13px; font-weight:600; }
.xlsx-preview select,.xlsx-preview button { min-height:40px; max-width:100%; padding:8px 12px; border:1px solid var(--border,#c8cdd4);
  border-radius:6px; background:var(--surface,#fff); color:var(--fg,#222); font:inherit; }
.xlsx-preview-choice { display:block; position:relative; min-width:0; }
.xlsx-preview-choice::after { content:''; position:absolute; right:15px; top:46%; width:6px; height:6px;
  border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:translateY(-50%) rotate(45deg); pointer-events:none; }
.xlsx-preview select { appearance:none; -webkit-appearance:none; display:block; box-sizing:border-box; width:100%; height:40px; padding-right:36px; }
.xlsx-preview button { cursor:pointer; }
.xlsx-preview button[aria-disabled="true"] { opacity:.55; cursor:default; }
.xlsx-preview :is(select,button,.xlsx-preview-grid):focus-visible { outline:2px solid var(--accent,#187c91); outline-offset:2px; }
.xlsx-preview-range,.xlsx-preview-note { margin:0; font-size:13px; color:var(--fg-muted,#596170); }
.xlsx-preview-error { margin:0; color:var(--danger,#b91c1c); }
.xlsx-preview-grid { min-width:0; max-width:100%; max-height:38vh; overflow:auto; border:1px solid var(--border,#c8cdd4); border-radius:6px; }
.xlsx-preview table { border-collapse:separate; border-spacing:0; min-width:100%; text-align:left; font-size:13px; }
.xlsx-preview :is(th,td) { min-width:100px; max-width:320px; padding:8px 12px; border-bottom:1px solid var(--border,#d9dee5);
  border-right:1px solid var(--border,#d9dee5); white-space:pre-wrap; overflow-wrap:anywhere; vertical-align:top; }
.xlsx-preview thead th { position:sticky; top:0; z-index:2; background:var(--surface-sunk,#f0f3f6); font-weight:600; }
.xlsx-preview th:first-child { position:sticky; left:0; min-width:42px; width:42px; background:var(--surface-sunk,#f0f3f6); font-variant-numeric:tabular-nums; }
.xlsx-preview thead th:first-child { z-index:3; }.xlsx-preview tbody th { font-weight:400; }
.xlsx-preview .xlsx-preview-missing { color:var(--fg-muted,#596170); font-style:italic; }
@media(max-width:600px) { .xlsx-preview :is(button,select) { min-height:44px; } }
`;
