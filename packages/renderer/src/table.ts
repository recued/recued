/** Table block — columns × rows with per-cell format hints.
 *
 *  Each column carries an optional `format` (`currency`, `percent`,
 *  `number`, `date`, `relative`); the cell value for that column runs
 *  through `formatValue(cell, column.format)`. Columns resolve cell
 *  values by `field` key on each row object; rows that aren't objects
 *  render as empty cells. Columns with `data-sort-field` enable the
 *  sidebar's JS sort binding — callers wire the actual sort. */

import { e } from './escape.js';
import { formatValue } from './format.js';
import { renderBlockEmpty, renderBlockError } from './block-error.js';
import { renderBlockLabel } from './label.js';
import { renderActionGroupInline } from './action.js';
import type { TableData } from './types.js';
import { NUMERIC_FIELD_KINDS, type ResolvedRecordColumnsDescriptor } from '@recued/contracts';

/** Find the rows in whatever the source produced.
 *
 *  An entity-derived table points `source` at the data directly, so it may be
 *  a bare array or a Records result (`{ records }`) — not the `{ columns, rows }`
 *  a `to_table` step builds. Accepting all three is what lets a recipe drop the
 *  `to_table` step entirely without the block learning a new shape. */
const tableRows = (data: unknown): unknown[] => {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, unknown>;
  if (Array.isArray(d.rows)) return d.rows;
  if (Array.isArray(d.records)) return d.records;
  return [];
};

export const renderTableBlock = (
  data: unknown,
  label?: string,
  resolvedColumns?: ResolvedRecordColumnsDescriptor,
): string => {
  if (!data || typeof data !== 'object') return renderBlockError('table', 'invalid data');
  const d = data as Partial<TableData>;
  // Entity-derived columns win when the block declared an entity; a table that
  // resolved none falls through to the authored ones rather than rendering
  // headerless, so a missing schema degrades to the old behaviour.
  const authored: TableData['columns'] = Array.isArray(d.columns) ? d.columns : [];
  const derived: TableData['columns'] | undefined =
    resolvedColumns !== undefined && resolvedColumns.columns.length > 0
      ? [
          ...resolvedColumns.columns.map((column) => ({
            field: column.field,
            label: column.label,
            // Quantities read right-aligned. From the declared KIND, never the
            // runtime value: money is a `decimal` returned as a string.
            ...(NUMERIC_FIELD_KINDS.has(column.kind) ? { numeric: true } : {}),
            ...(column.format !== undefined ? { format: column.format } : {}),
          })),
          // ⛔ An ACTION column survives an entity binding. Actions are not
          // entity fields — nothing in a schema declares "Open this row" — so
          // deriving columns would otherwise silently drop the row actions a
          // list depends on. The schema supplies the DATA columns; the author
          // still supplies the action one.
          ...authored.filter((column) => column.type === 'action'),
        ]
      : undefined;
  const columns = derived ?? authored;
  const rows = tableRows(data);
  if (columns.length === 0 || rows.length === 0) return renderBlockEmpty('table');

  return `
    <div class="block table-block">
      ${renderBlockLabel(label)}
      <div class="table-wrap">
        <table class="data-table" data-sortable>
          <thead>
            <tr>
              ${columns
                .map((c) => `<th data-sort-field="${e(c.field)}" class="sortable-th${
                  (c as { numeric?: boolean }).numeric === true ? ' is-numeric' : ''}">${e(String(c.label ?? c.field ?? ''))} <span class="sort-arrow"></span></th>`)
                .join('')}
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
              <tr>
                ${columns
                  .map((c) => {
                    const cell = row && typeof row === 'object'
                      ? (row as Record<string, unknown>)[c.field]
                      : undefined;
                    return `<td${(c as { numeric?: boolean }).numeric === true ? ' class="is-numeric"' : ''}>${c.type === 'action'
                      ? renderActionGroupInline(cell)
                      : e(formatValue(cell, c.format))}</td>`;
                  })
                  .join('')}
              </tr>
            `,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
};
