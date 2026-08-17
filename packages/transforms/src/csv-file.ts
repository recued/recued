/** D-244 — CSV filtering over a WHOLE FILE, as pure functions.
 *
 *  🔑 WHY THIS LIVES IN `packages/` AND NOT THE KERNEL. The kernel op that owns
 *  the I/O (`core.storage.csv.filter`) reads a warehouse record and writes one
 *  back — that part is server-only, gated and audited. The PARSING is not: it is
 *  the same job `csv_parse` already does, and if the kernel reimplemented it the
 *  identical file would parse one way through the op and another through the
 *  transform. A header carrying a UTF-8 BOM matching in one place and not the
 *  other reads to an owner as "the data is wrong", and nobody would find it for
 *  months. So the parser is shared and the I/O is not.
 *
 *  ⛔ These functions take and return TEXT. They never see a `file_ref`, because
 *  dereferencing one is the Gateway-gated content boundary — a transform must
 *  not be a second, unaudited path to those bytes, and `packages/` code runs on
 *  clients that have no warehouse at all.
 *
 *  ⚠ Filtering parses to RAW ROWS (`has_header: false`) rather than to objects.
 *  Round-tripping through `Record<string,string>` would rebuild the file from
 *  object keys — losing the original column ORDER on any row whose keys were
 *  reordered, and collapsing duplicate header names onto one key. Rows in, rows
 *  out: every cell's text and every column's position survive untouched. */

import { csv_parse } from './object.js';

/** Match modes. `contains` and `equal` are substring / exact over the cell's
 *  TEXT — everything from a CSV is text, which is why `contains` works here on
 *  a numeric column while it cannot on a live typed cell. */
export type CsvMatchMode = 'contains' | 'equal';

export interface CsvFilterOptions {
  readonly text: string;
  readonly column: string;
  readonly match: string;
  readonly mode?: CsvMatchMode;
  /** Case-insensitive comparison. Default false — an exact lookup of a customer
   *  id must not quietly match a different casing. */
  readonly ignore_case?: boolean;
  readonly delimiter?: string;
  readonly quote?: string;
}

export interface CsvFilterResult {
  /** The filtered CSV, header first. Empty string when the column is absent. */
  readonly csv: string;
  /** Data rows examined (excludes the header). */
  readonly scanned: number;
  /** Data rows that matched. */
  readonly matched: number;
  /** ⛔ THE DISTINCTION THAT MATTERS. `false` means the header has no such
   *  column, which is NOT the same as "nothing matched" — and over a customer
   *  list the two answers look identical to a caller that only counts rows.
   *  Every guard downstream keys on this. */
  readonly column_found: boolean;
  /** The header as parsed, so a caller can say what the columns actually are. */
  readonly columns: readonly string[];
}

const rawRows = (o: CsvFilterOptions | CsvColumnsOptions): string[][] =>
  csv_parse({
    input: o.text,
    has_header: false,
    ...(o.delimiter !== undefined ? { delimiter: o.delimiter } : {}),
    ...(o.quote !== undefined ? { quote: o.quote } : {}),
  } as never, {} as never) as string[][];

/** Mirrors `to_csv`'s escaping — a cell containing the delimiter, a quote or a
 *  newline is quoted, and an inner quote is doubled. */
const escapeCell = (cell: string, delimiter: string): string =>
  /["\r\n]/u.test(cell) || cell.includes(delimiter)
    ? `"${cell.replace(/"/gu, '""')}"`
    : cell;

const serialize = (rows: readonly string[][], delimiter: string): string =>
  rows.map((r) => r.map((c) => escapeCell(c, delimiter)).join(delimiter)).join('\n');

/** Filter a CSV's data rows on one named column, returning CSV.
 *
 *  The header is ALWAYS carried through when the column exists, even with zero
 *  matches — a downstream parse of the result then yields an empty row set from
 *  a well-formed file, rather than an empty file that cannot be told apart from
 *  a failed run. */
export const csvFilter = (o: CsvFilterOptions): CsvFilterResult => {
  const delimiter = typeof o.delimiter === 'string' && o.delimiter.length === 1 ? o.delimiter : ',';
  const rows = rawRows(o);
  const header = rows[0];
  if (header === undefined) {
    return { csv: '', scanned: 0, matched: 0, column_found: false, columns: [] };
  }
  const index = header.indexOf(o.column);
  if (index === -1) {
    return { csv: '', scanned: 0, matched: 0, column_found: false, columns: header };
  }

  const fold = (v: string): string => (o.ignore_case === true ? v.toLowerCase() : v);
  const needle = fold(o.match);
  const hit = (cell: string): boolean => {
    const value = fold(cell);
    return o.mode === 'equal' ? value === needle : value.includes(needle);
  };

  const body = rows.slice(1);
  // ⚠ A ragged row shorter than the header has no cell at `index` — that is a
  // MISS, not a crash and not a match. `csv_parse` is called with
  // `has_header: false`, so its pad/skip policy never applies here and short
  // rows arrive as-is.
  const matches = body.filter((r) => hit(r[index] ?? ''));
  return {
    csv: serialize([header, ...matches], delimiter),
    scanned: body.length,
    matched: matches.length,
    column_found: true,
    columns: header,
  };
};

export interface CsvColumnsOptions {
  readonly text: string;
  readonly delimiter?: string;
  readonly quote?: string;
}

/** The header row's column names, in order.
 *
 *  🔑 Cheap enough to run BEFORE a filter, which is how "no such column" stays
 *  distinguishable from "no such record" without reading the whole file twice
 *  at the caller. */
export const csvColumns = (o: CsvColumnsOptions): readonly string[] => rawRows(o)[0] ?? [];

// ────────────────────────────────────────────────────────────────
// Column statistics
// ────────────────────────────────────────────────────────────────

/** Per-column summary. Every field is a SCALAR — this is a value-shaped result
 *  by design, so nothing here may grow with the file. */
export interface CsvColumnStats {
  readonly name: string;
  /** Cells with a non-empty value. */
  readonly filled: number;
  /** Cells that are empty, whitespace-only, or absent on a short row. */
  readonly empty: number;
  /** Longest value's length in characters — the practical "how wide is this". */
  readonly longest: number;
  /** Distinct non-empty values. ⚠ Read with `unique_capped`. */
  readonly unique: number;
  /** ⛔ TRUE when `unique` stopped counting at the cap, so it is a FLOOR and not
   *  the answer. Without this flag a capped count reads as an exact one, and
   *  "500 distinct customers" over a 200k-row file would be a quiet lie. */
  readonly unique_capped: boolean;
  /** ⛔ True only when EVERY non-empty cell parses as a finite number. One stray
   *  "N/A" makes the column non-numeric and the stats below null — a mean over
   *  "most of" a column reads as a mean over the column, which is worse than no
   *  mean at all. */
  readonly numeric: boolean;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly sum: number | null;
}

export interface CsvStatsResult {
  /** Data rows, excluding the header. */
  readonly rows: number;
  readonly columns: readonly CsvColumnStats[];
}

/** Distinct-value ceiling per column. A Set over every value of a high-cardinality
 *  column (an id, an email) is unbounded in the file's size — the one place these
 *  "summary" stats could quietly cost as much as the data. */
export const CSV_STATS_UNIQUE_CAP = 10_000;

/** ⚠ `Number('1,240.50')` is NaN — a thousands-separated figure is NOT numeric
 *  here, and that is correct: spreadsheets export them as text, and summing only
 *  the ones that happen to parse would report a total over an arbitrary subset.
 *  (An UNQUOTED `1,240.50` is two cells anyway; the quoted form is the real case.)
 *
 *  ⚠ The empty check below is DEFENCE-IN-DEPTH and unreachable today — the only
 *  caller skips empty cells before it gets here, which a mutation proved by
 *  deleting this line and breaking nothing. Kept, with the claim corrected: an
 *  earlier comment said emptiness "is decided BEFORE parsing, never by the
 *  parse" as though this line were what enforced it. It is not; the loop is. But
 *  `Number('')` is 0, so a future second caller that forgot would silently sum
 *  phantom zeros and drag a mean down — cheap insurance against an expensive,
 *  invisible wrong answer. */
const numeric = (cell: string): number | null => {
  if (cell.trim().length === 0) return null;
  const n = Number(cell);
  return Number.isFinite(n) ? n : null;
};

export const csvStats = (o: CsvColumnsOptions): CsvStatsResult => {
  const rows = rawRows(o);
  const header = rows[0];
  if (header === undefined) return { rows: 0, columns: [] };
  const body = rows.slice(1);

  const columns = header.map((name, index): CsvColumnStats => {
    let filled = 0;
    let longest = 0;
    let allNumeric = true;
    let sum = 0;
    let min: number | null = null;
    let max: number | null = null;
    const seen = new Set<string>();
    let capped = false;

    for (const row of body) {
      const cell = row[index] ?? '';
      if (cell.trim().length === 0) continue;
      filled += 1;
      if (cell.length > longest) longest = cell.length;
      if (seen.size < CSV_STATS_UNIQUE_CAP) seen.add(cell);
      else if (!seen.has(cell)) capped = true;

      const n = numeric(cell);
      if (n === null) { allNumeric = false; continue; }
      if (allNumeric) {
        sum += n;
        min = min === null || n < min ? n : min;
        max = max === null || n > max ? n : max;
      }
    }

    const isNumeric = allNumeric && filled > 0;
    return {
      name,
      filled,
      empty: body.length - filled,
      longest,
      unique: seen.size,
      unique_capped: capped,
      numeric: isNumeric,
      min: isNumeric ? min : null,
      max: isNumeric ? max : null,
      mean: isNumeric && filled > 0 ? sum / filled : null,
      sum: isNumeric ? sum : null,
    };
  });

  return { rows: body.length, columns };
};
