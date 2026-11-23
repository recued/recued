export interface SpreadsheetCell { row: number; column: number; text: string }
export interface SpreadsheetCellRef { sheet: number; row: number; column: number }
export interface SpreadsheetSheetData {
  rowCount: number;
  columnCount: number;
  cells: Iterable<SpreadsheetCell>;
}
export interface SpreadsheetSearchState {
  query: string;
  phase: 'idle' | 'searching' | 'done' | 'stopped';
  searched: number;
  total: number;
  limited: boolean;
  issues: readonly { sheet: number; message: string }[];
  matches: readonly SpreadsheetCellRef[];
  active: number;
}

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/ς/gu, 'σ').replace(/\s+/gu, ' ');

/** A1 references address the preview's row numbers, including sparse blank
 * cells. Accept absolute references, but never ranges, formulas or sheet paths. */
export const parseSpreadsheetAddress = (value: string): { row: number; column: number } | undefined => {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/i.exec(value.trim());
  if (!match) return;
  const column = [...match[1]!.toUpperCase()].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0);
  const row = Number(match[2]);
  if (column <= 16384 && row <= 1_048_576) return { row, column };
};

/** Search saved, displayed values once per cell. Coordinates are retained;
 * entire parsed worksheets and copies of their values are not cached here. */
export const createSpreadsheetSearch = (opts: {
  total: number;
  read(sheet: number): SpreadsheetSheetData | Promise<SpreadsheetSheetData>;
  changed(state: SpreadsheetSearchState): void;
  selected(cell: SpreadsheetCellRef): void;
  yieldControl?: () => Promise<void>;
  limits?: { cells?: number; characters?: number; matches?: number };
}) => {
  const limits = { cells: 100_000, characters: 2_000_000, matches: 2000, ...opts.limits };
  const idle = (query: string): SpreadsheetSearchState => ({ query, phase: 'idle', searched: 0,
    total: opts.total, limited: false, issues: [], matches: [], active: -1 });
  let state = idle(''), generation = 0, disposed = false;
  const publish = () => { if (!disposed) opts.changed(state); };
  const pause = () => opts.yieldControl?.() ?? new Promise<void>(resolve => setTimeout(resolve, 0));
  const setQuery = (query: string) => { generation++; state = idle(query.slice(0, 512)); publish(); };
  const start = async () => {
    const needle = normalize(state.query).trim();
    if (disposed || !needle) return;
    const own = ++generation;
    state = { ...idle(state.query), phase: 'searching' }; publish();
    let cells = 0, characters = 0;
    scan: for (let sheet = 0; sheet < opts.total; sheet++) {
      if (disposed || own !== generation) return;
      try {
        const data = await opts.read(sheet);
        if (disposed || own !== generation) return;
        for (const cell of data.cells) {
          if (disposed || own !== generation) return;
          if (cells >= limits.cells || characters + cell.text.length > limits.characters) {
            state = { ...state, limited: true }; break scan;
          }
          cells++; characters += cell.text.length;
          if (normalize(cell.text).includes(needle)) {
            if (state.matches.length >= limits.matches) { state = { ...state, limited: true }; break scan; }
            state = { ...state, matches: [...state.matches, { sheet, row: cell.row, column: cell.column }] };
          }
          if (cells % 250 === 0) {
            publish(); await pause();
            if (disposed || own !== generation) return;
          }
        }
        state = { ...state, searched: sheet + 1 };
      } catch (failure) {
        if (disposed || own !== generation) return;
        state = { ...state, searched: sheet + 1, issues: [...state.issues,
          { sheet, message: failure instanceof Error ? failure.message : 'This worksheet could not be read.' }] };
      }
      publish(); await pause();
    }
    if (disposed || own !== generation) return;
    state = { ...state, phase: 'done' }; publish();
  };
  const select = (index: number) => {
    if (disposed || !state.matches.length) return;
    const active = (index + state.matches.length) % state.matches.length;
    state = { ...state, active }; publish(); opts.selected(state.matches[active]!);
  };
  return {
    state: () => state, setQuery, start, select,
    clearSelection() { if (!disposed && state.active >= 0) { state = { ...state, active: -1 }; publish(); } },
    next: () => select(state.active + 1),
    previous: () => select(state.active < 0 ? state.matches.length - 1 : state.active - 1),
    stop() { generation++; if (state.phase === 'searching') { state = { ...state, phase: 'stopped' }; publish(); } },
    dispose() { disposed = true; generation++; },
  };
};
