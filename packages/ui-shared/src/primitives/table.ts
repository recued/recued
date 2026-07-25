/** Table primitive.
 *
 *  Two surfaces:
 *
 *    1. `.rx-table` CSS class — the shared skeleton (muted header row,
 *       hairline row borders, last-row border removal, small font).
 *       Complex tables (e.g. the schedule tables with per-row state
 *       classes and custom action cells) can opt in with just the
 *       class and keep their bespoke markup — the primitive stays out
 *       of their way.
 *
 *    2. `dataTable({ columns, rows })` helper — a minimal render
 *       function for the simple read-only case (endpoints-style). Each
 *       column declares a renderer that maps a row to a cell string;
 *       the caller owns escaping for anything custom, plain strings
 *       are escaped by the helper.
 *
 *  Both reuse the same `.rx-table` styling, so a `dataTable` and a
 *  hand-written schedule table line up visually side-by-side.
 */

import { e } from '../template.js';

export interface TableColumn<T> {
  /** Column header label. Escaped. */
  header: string;
  /** Cell renderer. Return a plain string (auto-escaped) or pre-built
   *  HTML (see `html`). */
  cell: (row: T) => string;
  /** Treat `cell`'s return value as raw HTML. Defaults to false
   *  (auto-escape). */
  html?: boolean;
  /** Optional per-column class applied to `<td>` + `<th>`. */
  cellClass?: string;
  /** Align cell text. */
  align?: 'left' | 'right' | 'center';
}

export interface DataTableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  /** Optional caption text rendered above the table. */
  caption?: string;
  /** Extra class tokens appended after `.rx-table`. */
  extraClass?: string;
  /** Placeholder when `rows` is empty. Default: skip rendering. */
  emptyMessage?: string;
}

const alignClass = (align?: 'left' | 'right' | 'center'): string => {
  if (align === 'right') return 'rx-td-right';
  if (align === 'center') return 'rx-td-center';
  return '';
};

export const dataTable = <T>(props: DataTableProps<T>): string => {
  const tableClass = ['rx-table', props.extraClass ?? ''].filter(Boolean).join(' ');

  if (props.rows.length === 0 && props.emptyMessage) {
    return `<p class="rx-table-empty">${e(props.emptyMessage)}</p>`;
  }

  const caption = props.caption
    ? `<caption class="rx-table-caption">${e(props.caption)}</caption>`
    : '';

  const headRow = props.columns.map((c) => {
    const cls = [c.cellClass ?? '', alignClass(c.align)].filter(Boolean).join(' ');
    return `<th${cls ? ` class="${cls}"` : ''}>${e(c.header)}</th>`;
  }).join('');

  const bodyRows = props.rows.map((row) => {
    const cells = props.columns.map((c) => {
      const raw = c.cell(row);
      const value = c.html ? raw : e(raw);
      const cls = [c.cellClass ?? '', alignClass(c.align)].filter(Boolean).join(' ');
      return `<td${cls ? ` class="${cls}"` : ''}>${value}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  return `
    <table class="${tableClass}">
      ${caption}
      <thead><tr>${headRow}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  `;
};

export const TABLE_STYLES = `
.rx-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  color: var(--fg);
}
.rx-table caption,
.rx-table-caption {
  caption-side: top;
  text-align: left;
  font-size: 11px;
  color: var(--fg-muted);
  padding: 0 0 6px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.rx-table thead th {
  text-align: left;
  font-size: 10px;
  font-weight: 500;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.3px;
  padding: 4px 8px 4px 0;
  border-bottom: 1px solid var(--border);
}
.rx-table tbody td {
  padding: 6px 8px 6px 0;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}
.rx-table tbody tr:last-child td { border-bottom: none; }
.rx-td-right  { text-align: right; }
.rx-td-center { text-align: center; }
.rx-table-empty {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
  font-style: italic;
}
`;
