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

export const renderTableBlock = (data: unknown, label?: string): string => {
  if (!data || typeof data !== 'object') return renderBlockError('table', 'invalid data');
  const d = data as Partial<TableData>;
  const columns = Array.isArray(d.columns) ? d.columns : [];
  const rows = Array.isArray(d.rows) ? d.rows : [];
  if (columns.length === 0 || rows.length === 0) return renderBlockEmpty('table');

  return `
    <div class="block table-block">
      ${renderBlockLabel(label)}
      <div class="table-wrap">
        <table class="data-table" data-sortable>
          <thead>
            <tr>
              ${columns
                .map((c) => `<th data-sort-field="${e(c.field)}" class="sortable-th">${e(String(c.label ?? c.field ?? ''))} <span class="sort-arrow"></span></th>`)
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
                    return `<td>${c.type === 'action'
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
