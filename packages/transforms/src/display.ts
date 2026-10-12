import type { TransformFn, TransformContext, ChecklistItem, TableColumn, SummaryField } from './types.js';
import { csvCell as sharedCsvCell, isRef, parseCondition, type Condition } from '@recued/contracts';
import { getField } from './evaluate.js';

/** Conditions asking whether a value is there, and whether it is missing. */
const PRESENCE_TESTS: ReadonlySet<string> = new Set(['is_not_null', 'is_not_empty']);
const ABSENCE_TESTS: ReadonlySet<string> = new Set(['is_null', 'is_empty']);

/** `{{step.contact.email}}` → `['step', 'contact', 'email']`; undefined for anything
 *  but one plain reference. */
const refPath = (ref: string): string[] | undefined => {
  const match = /^\{\{([^{}\s:]+)(?::[A-Za-z_]+)?\}\}$/.exec(ref);
  return match === null ? undefined : match[1]!.split('.');
};

/** The reference whose absence leaves a checklist row unknown (`null`, shown with
 *  `detail_null`): neither fine nor a problem, because what it judges is not there.
 *  Undefined when nothing can.
 *
 *  - A comparison (`equal`, `greater`, …): its value. Compared while missing, it
 *    came out fine or a problem by accident ("Last activity  days ago", in green).
 *  - A presence or absence test on a field (`{{step.contact.result.email}}
 *    is_empty`): the record the field is on. A missing email on a contact that was
 *    read IS the answer; on a contact that was never read there is none.
 *  - On a whole value (`{{step.stale_contacts}}`, `{{config.day}}`):
 *    `is_not_empty` / `is_not_null` can only find nothing there, so missing is
 *    unknown ("No contacts linked", not "All engaged"); `is_empty` / `is_null` ask
 *    whether it is missing, so missing is the problem they look for ("No location
 *    on the event").
 *
 *  ⛔ The engine's condition evaluator returns a boolean only, so this cannot be
 *  read off `evaluate`: until 2026-10-11 the transform waited for a `null` it never
 *  got, and no shipped `detail_null` ever showed (its test stubbed `evaluate`). */
export const checklistUnknownWhenMissing = (issue: string | Condition): string | undefined => {
  const { field, operator, value } = typeof issue === 'string'
    ? parseCondition(issue)
    : { field: issue.field, operator: issue.operator as string, value: issue.value };
  if (!isRef(field)) return undefined;
  const nullValue = value === null || value === 'null';
  const presence = PRESENCE_TESTS.has(operator) || (operator === 'not_equal' && nullValue);
  const absence = ABSENCE_TESTS.has(operator) || (operator === 'equal' && nullValue);
  if (!presence && !absence) return field;
  const path = refPath(field);
  if (path === undefined) return undefined;
  if (path.length >= 3) return `{{${path.slice(0, -1).join('.')}}}`;
  return presence ? field : undefined;
};

const REFS = /\{\{[^{}]+\}\}/g;

/** A row with no condition is information: fine, or unknown when a value it shows
 *  is missing. The engine hands its `detail_ok` over unresolved for this, and the
 *  row resolves it once here. */
const statusOf = (item: ChecklistItem, ctx: TransformContext): 'ok' | 'issue' | 'null' => {
  if (item.issue === undefined || item.issue === null) {
    const shown = typeof item.detail_ok === 'string' ? item.detail_ok.match(REFS) ?? [] : [];
    return shown.some((ref) => ctx.resolve(ref) == null) ? 'null' : 'ok';
  }
  const subject = checklistUnknownWhenMissing(item.issue);
  if (subject !== undefined && ctx.resolve(subject) == null) return 'null';
  return ctx.evaluate(item.issue) ? 'issue' : 'ok';
};

export const to_checklist: TransformFn = (p, ctx) => {
  const items = p.items as ChecklistItem[];
  if (!Array.isArray(items)) return { title: p.title, items: [] };

  const evaluated = items.map(item => {
    const status = statusOf(item, ctx);
    const information = item.issue === undefined || item.issue === null;
    // Unknown shows `detail_null`, never `detail_ok`: that text reads the missing
    // value. Without one, the status says it (a renderer shows "No data").
    const detail = status === 'issue' ? item.detail_issue
      : status === 'null' ? item.detail_null
      : information && typeof item.detail_ok === 'string' ? ctx.resolve(item.detail_ok)
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
