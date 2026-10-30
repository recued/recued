import { csv_parse } from '@recued/transforms/object';

/** A table is built only from a complete parse within these browser budgets.
 * The original bytes and the separately bounded raw preview remain available. */
export const CSV_PREVIEW_LIMITS = {
  characters: 1024 * 1024, rows: 10_000, columns: 50, cells: 100_000, cellCharacters: 10_000,
} as const;
const PAGE_ROWS = 50;
export type CsvPreviewData =
  | { kind: 'table'; columns: readonly string[]; rows: readonly (readonly string[])[] }
  | { kind: 'raw'; reason: string };

export const isCsvPreview = (filename: string, mime: string): boolean => {
  const type = mime.toLowerCase().split(';')[0]!.trim();
  return ['text/csv', 'text/x-csv', 'text/comma-separated-values', 'application/csv'].includes(type)
    || type === 'text/plain' && /\.csv$/i.test(filename);
};

/** Consume complete MIME parameters so a semicolon inside a quoted value
 * cannot turn a filename or note into a CSV header declaration. */
const csvHeader = (mime: string): 'present' | 'absent' | 'invalid' => {
  let position = mime.indexOf(';'), header: 'present' | 'absent' | undefined;
  const parameter = /;\s*([^=;\s]+)\s*=\s*("(?:[^"\\]|\\[\s\S])*"|[^";\s]+)\s*/y;
  while (position >= 0 && position < mime.length) {
    parameter.lastIndex = position;
    const match = parameter.exec(mime);
    if (!match) return 'invalid';
    position = parameter.lastIndex;
    if (match[1]!.toLowerCase() !== 'header') continue;
    const raw = match[2]!;
    const value = (raw.startsWith('"') ? raw.slice(1, -1).replace(/\\([\s\S])/g, '$1') : raw).toLowerCase();
    if (value !== 'present' && value !== 'absent' || header !== undefined && header !== value) return 'invalid';
    header = value;
  }
  return header ?? 'present';
};

export const parseCsvPreview = (text: string, mime = 'text/csv'): CsvPreviewData => {
  if (text.length > CSV_PREVIEW_LIMITS.characters) return {
    kind: 'raw', reason: 'This CSV is too large for a table preview. Use Raw text or download the file.',
  };
  const header = csvHeader(mime);
  if (header === 'invalid') return {
    kind: 'raw', reason: 'The CSV header setting could not be read. Use Raw text or download the file.',
  };
  try {
    // Arrays preserve blank, duplicate and special header names. They never
    // become object keys, and no CSV value is converted to a number or formula.
    const parsed = csv_parse({ input: text, has_header: false, strict: true,
      max_rows: CSV_PREVIEW_LIMITS.rows + (header === 'present' ? 1 : 0), max_columns: CSV_PREVIEW_LIMITS.columns,
      max_cells: CSV_PREVIEW_LIMITS.cells + (header === 'present' ? CSV_PREVIEW_LIMITS.columns : 0),
      max_cell_chars: CSV_PREVIEW_LIMITS.cellCharacters }, {} as never) as string[][];
    const first = parsed[0] ?? [];
    const columns = header === 'present' ? first : first.map(() => ''), rows = header === 'present' ? parsed.slice(1) : parsed;
    if (rows.length * columns.length > CSV_PREVIEW_LIMITS.cells) return {
      kind: 'raw', reason: 'This CSV exceeds the table preview limits. Use Raw text or download the file.',
    };
    if (rows.some(row => row.length !== columns.length)) return {
      kind: 'raw', reason: 'The CSV rows have different numbers of columns. Use Raw text or download the file.',
    };
    return { kind: 'table', columns, rows };
  } catch (error) {
    return { kind: 'raw', reason: error instanceof Error && /limit exceeded/.test(error.message)
      ? 'This CSV exceeds the table preview limits. Use Raw text or download the file.'
      : 'This CSV could not be shown as a table. Use Raw text or download the file.' };
  }
};

interface CsvPreviewOptions {
  doc: Document;
  body: HTMLElement;
  filename: string;
  mime_type: string;
  text: string;
  raw: { text: string; truncated: boolean };
  signal: AbortSignal;
  isCurrent(): boolean;
  status(text: string): void;
}

/** Shared by the modal and inline file viewer. All state belongs to this
 * one preview; changing format or page performs no file read or write. */
export const mountCsvPreview = (options: CsvPreviewOptions): void => {
  const { doc, raw } = options;
  const data = parseCsvPreview(options.text, options.mime_type);
  let mode: 'table' | 'raw' = data.kind === 'table' ? 'table' : 'raw', page = 0;
  let tableScroll = { top: 0, left: 0 };
  const current = () => !options.signal.aborted && options.isCurrent();
  const root = doc.createElement('div'); root.className = 'csv-preview';
  const style = doc.createElement('style'); style.textContent = CSV_PREVIEW_STYLES;
  const formats = doc.createElement('div'); formats.className = 'csv-preview-formats';
  formats.setAttribute('role', 'group'); formats.setAttribute('aria-label', 'CSV preview format');
  const button = (label: string): HTMLButtonElement => {
    const control = doc.createElement('button'); control.type = 'button'; control.textContent = label; return control;
  };
  const tableButton = button('Table'), rawButton = button('Raw text');
  tableButton.disabled = data.kind !== 'table'; formats.append(tableButton, rawButton);
  const tablePanel = doc.createElement('div'); tablePanel.className = 'csv-preview-panel';
  const range = doc.createElement('p'); range.className = 'csv-preview-range'; range.setAttribute('role', 'status');
  const grid = doc.createElement('div'); grid.className = 'csv-preview-grid'; grid.tabIndex = 0;
  grid.setAttribute('role', 'region'); grid.setAttribute('aria-label', 'CSV table scroll area');
  const table = doc.createElement('table'); table.setAttribute('aria-label', `CSV data: ${options.filename}`);
  const head = doc.createElement('thead'), body = doc.createElement('tbody');
  table.append(head, body); grid.append(table);
  const navigation = doc.createElement('nav'); navigation.className = 'csv-preview-navigation';
  navigation.setAttribute('aria-label', 'CSV rows');
  const previous = button('Previous rows'), next = button('Next rows'); navigation.append(previous, next);
  tablePanel.append(range, grid, navigation);
  const pre = doc.createElement('pre'); pre.setAttribute('aria-label', 'File text'); pre.textContent = raw.text;
  root.append(style, formats, tablePanel, pre); options.body.append(root);

  if (data.kind === 'table' && data.columns.length) {
    const row = doc.createElement('tr');
    const number = doc.createElement('th'); number.scope = 'col'; number.textContent = '#'; number.setAttribute('aria-label', 'Row number'); row.append(number);
    data.columns.forEach((name, index) => {
      const cell = doc.createElement('th'); cell.scope = 'col'; cell.textContent = name.trim() ? name : `Column ${index + 1}`; row.append(cell);
    });
    head.append(row);
  }
  const drawPage = (): void => {
    if (data.kind !== 'table') return;
    const left = grid.scrollLeft;
    body.replaceChildren();
    const start = page * PAGE_ROWS, end = Math.min(start + PAGE_ROWS, data.rows.length);
    data.rows.slice(start, end).forEach((values, index) => {
      const row = doc.createElement('tr');
      const number = doc.createElement('th'); number.scope = 'row'; number.textContent = String(start + index + 1); row.append(number);
      for (const value of values) { const cell = doc.createElement('td'); cell.textContent = value; row.append(cell); }
      body.append(row);
    });
    range.textContent = !data.columns.length ? 'This CSV file is empty.'
      : `${data.rows.length ? `Rows ${(start + 1).toLocaleString()}–${end.toLocaleString()} of ${data.rows.length.toLocaleString()}` : 'No data rows'} · ${data.columns.length} ${data.columns.length === 1 ? 'column' : 'columns'}`;
    grid.hidden = data.columns.length === 0;
    navigation.hidden = data.rows.length <= PAGE_ROWS;
    previous.setAttribute('aria-disabled', String(page === 0));
    next.setAttribute('aria-disabled', String(end >= data.rows.length));
    grid.scrollTop = 0; grid.scrollLeft = left;
  };
  const showMode = (selected: 'table' | 'raw'): void => {
    if (!current() || selected === 'table' && data.kind !== 'table') return;
    const returningToTable = mode === 'raw' && selected === 'table';
    if (mode === 'table' && selected === 'raw') tableScroll = { top: grid.scrollTop, left: grid.scrollLeft };
    mode = selected;
    tableButton.setAttribute('aria-pressed', String(mode === 'table'));
    rawButton.setAttribute('aria-pressed', String(mode === 'raw'));
    tablePanel.hidden = mode !== 'table'; pre.hidden = mode !== 'raw';
    if (returningToTable) { grid.scrollTop = tableScroll.top; grid.scrollLeft = tableScroll.left; }
    options.status(mode === 'table' ? '' : [data.kind === 'raw' ? data.reason : '', raw.truncated
      ? 'Showing the first 100,000 characters. Download the file to read the rest.' : ''].filter(Boolean).join(' '));
  };
  tableButton.addEventListener('click', () => showMode('table'), { signal: options.signal });
  rawButton.addEventListener('click', () => showMode('raw'), { signal: options.signal });
  previous.addEventListener('click', () => { if (current() && mode === 'table' && page > 0) { page--; drawPage(); } }, { signal: options.signal });
  next.addEventListener('click', () => {
    if (current() && mode === 'table' && data.kind === 'table' && (page + 1) * PAGE_ROWS < data.rows.length) { page++; drawPage(); }
  }, { signal: options.signal });
  drawPage(); showMode(mode);
};

const CSV_PREVIEW_STYLES = `
.csv-preview { min-width:0; max-width:100%; display:grid; gap:10px; }
.csv-preview [hidden] { display:none !important; }
.csv-preview-formats, .csv-preview-navigation { display:flex; flex-wrap:wrap; gap:8px; }
.csv-preview button { min-height:38px; padding:7px 12px; border:1px solid var(--border,#c8cdd4); border-radius:6px;
  color:var(--fg,#222); background:var(--surface,#fff); font:inherit; cursor:pointer; }
.csv-preview button[aria-pressed="true"] { border-color:var(--accent,#187c91); background:var(--surface-sunk,#edf5f7); font-weight:600; }
.csv-preview button:disabled, .csv-preview button[aria-disabled="true"] { opacity:.55; cursor:default; }
.csv-preview :is(button,.csv-preview-grid):focus-visible { outline:2px solid var(--accent,#187c91); outline-offset:2px; }
.csv-preview-panel { min-width:0; display:grid; gap:8px; }
.csv-preview .csv-preview-range { margin:0; font-size:13px; color:var(--fg-muted,#596170); }
.csv-preview-grid { min-width:0; max-width:100%; max-height:38vh; overflow:auto; border:1px solid var(--border,#c8cdd4); border-radius:6px; }
.csv-preview table { min-width:100%; border-collapse:separate; border-spacing:0; font-size:13px; text-align:left; }
.csv-preview th, .csv-preview td { box-sizing:border-box; min-width:100px; max-width:320px; padding:9px 12px;
  border-bottom:1px solid var(--border,#d9dee5); vertical-align:top; white-space:pre-wrap; overflow-wrap:anywhere; }
.csv-preview thead th { position:sticky; top:0; z-index:1; background:var(--surface-sunk,#f0f3f6); font-weight:600; }
.csv-preview th:first-child { min-width:42px; width:42px; color:var(--fg-muted,#596170); font-variant-numeric:tabular-nums; }
.csv-preview tbody th { font-weight:400; }
.csv-preview tbody tr:last-child :is(th,td) { border-bottom:0; }
.csv-preview > pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font:13px/1.5 ui-monospace,monospace; }
@media(max-width:600px) { .csv-preview button { min-height:44px; } }
`;
