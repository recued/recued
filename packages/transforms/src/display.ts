import type { TransformFn, ChecklistItem, TableColumn, SummaryField } from './types.js';
import { csvCell as sharedCsvCell } from '@recued/contracts';
import { getField } from './evaluate.js';

export const to_checklist: TransformFn = (p, ctx) => {
  const items = p.items as ChecklistItem[];
  if (!Array.isArray(items)) return { title: p.title, items: [] };

  const evaluated = items.map(item => {
    const result = ctx.evaluate(item.issue);
    const status = result == null ? 'null' : result ? 'issue' : 'ok';
    const detail = status === 'issue' ? item.detail_issue
      : status === 'null' ? (item.detail_null ?? item.detail_ok)
      : item.detail_ok;
    const actions = [
      ...(item.action === undefined ? [] : [item.action]),
      ...(Array.isArray(item.actions) ? item.actions : []),
    ];
    return actions.length > 0
      ? { label: item.label, status, detail, actions }
      : { label: item.label, status, detail };
  });

  return { title: p.title, items: evaluated };
};

export const to_table: TransformFn = (p) => {
  const columns = p.columns as TableColumn[];
  const rows = p.array as unknown[];
  return {
    columns: Array.isArray(columns) ? columns : [],
    rows: Array.isArray(rows) ? rows : [],
  };
};

export const to_summary: TransformFn = (p) => {
  const fields = p.fields as SummaryField[];
  return { fields: Array.isArray(fields) ? fields : [] };
};

interface CsvColumn { field: string; label: string }

/** Resolve the column projection for `to_csv`. Explicit `columns` may be a
 *  list of field-name strings or `{ field, label? }` objects (the `to_table`
 *  shape). When omitted, columns are derived from the union of every row's
 *  top-level keys in first-seen order — so sparse rows never drop a column. */
const resolveCsvColumns = (raw: unknown, rows: readonly unknown[]): CsvColumn[] => {
  if (Array.isArray(raw)) {
    const explicit = raw
      .map((c): CsvColumn | null => {
        if (typeof c === 'string') return { field: c, label: c };
        if (c == null || typeof c !== 'object') return null;
        const col = c as { field?: unknown; label?: unknown };
        const field = col.field == null ? '' : String(col.field);
        return field.length > 0
          ? { field, label: col.label == null ? field : String(col.label) }
          : null;
      })
      .filter((c): c is CsvColumn => c !== null);
    // Explicit columns win only when at least one entry is usable; an
    // all-malformed list falls through to key derivation (as if `columns` was
    // omitted) rather than silently dropping object rows to JSON-per-line.
    if (explicit.length > 0) return explicit;
  }
  const seen = new Set<string>();
  const cols: CsvColumn[] = [];
  for (const row of rows) {
    if (row != null && typeof row === 'object' && !Array.isArray(row)) {
      for (const key of Object.keys(row as Record<string, unknown>)) {
        if (!seen.has(key)) { seen.add(key); cols.push({ field: key, label: key }); }
      }
    }
  }
  return cols;
};

/** A single cell's string form. Nullish → empty; objects/arrays → JSON so a
 *  nested value is visible rather than silently `[object Object]`. */
const csvCell = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/** RFC-4180 field escaping plus spreadsheet-formula neutralisation.
 *
 *  ⚠ NEUTRALISATION ADDED 2026-09-18 via the shared `csvCell`. These cells are
 *  RECIPE OUTPUT written to an artifact a person opens — the most
 *  externally-steerable content of the four CSV writers. Quoting alone never
 *  disarmed a formula; see `packages/contracts/src/csv.ts`.
 *  ⚠ The caller's delimiter is threaded through, and quote-if-needed is
 *  preserved: only the neutralisation is new.
 *  ⚠ ALIASED, because this file's OWN `csvCell` is a value->string RENDERER,
 *  not an escaper — the same name doing a different job, which is a third of
 *  why the four surfaces drifted apart. The separation here was already right;
 *  only the escaping half moved. */
const escapeCsvField = (cell: string, delimiter: string): string =>
  sharedCsvCell(cell, { delimiter });

/** Serialize an array of rows to a CSV string (`\n`-terminated lines, which
 *  Excel and Sheets both open). The "export structured data as an artifact"
 *  primitive: pair with a `file-write` to drop a spreadsheet-openable file.
 *  Returns '' for an empty / non-array input. Primitive rows (no resolvable
 *  columns) serialize one stringified value per line with no header. */
export const to_csv: TransformFn = (p) => {
  const rows = Array.isArray(p.array) ? (p.array as unknown[]) : [];
  const delimiter =
    typeof p.delimiter === 'string' && p.delimiter.length > 0 ? p.delimiter : ',';
  const includeHeader = p.header !== false;

  const columns = resolveCsvColumns(p.columns, rows);
  const esc = (v: unknown): string => escapeCsvField(csvCell(v), delimiter);

  if (columns.length === 0) return rows.map(esc).join('\n');

  const lines: string[] = [];
  if (includeHeader) {
    lines.push(columns.map((c) => escapeCsvField(c.label, delimiter)).join(delimiter));
  }
  for (const row of rows) {
    lines.push(columns.map((c) => esc(getField(row, c.field))).join(delimiter));
  }
  return lines.join('\n');
};
