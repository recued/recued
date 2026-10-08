/** Table block — columns × rows with per-cell format hints.
 *
 *  Each column carries an optional `format` (`currency`, `percent`,
 *  `number`, `date`, `relative`); the cell value for that column runs
 *  through `formatValue(cell, column.format)`. Columns resolve cell
 *  values by `field` — a path into each row (`value.score`,
 *  `attendees.0.email`; `table-field.ts`); rows that aren't objects render as
 *  empty cells.
 *
 *  ⛔⛔ D-282 B2 — EVERY HEADER USED TO CARRY `data-sort-field`, `class="sortable-th"`
 *  and an empty `<span class="sort-arrow">`, above a `<table data-sortable>`. The header
 *  said *"callers wire the actual sort"*. **No caller ever did**: nothing in `apps/` or
 *  `packages/` bound the attribute, and no stylesheet anywhere defined `.sortable-th`,
 *  `.sort-arrow` or `[data-sortable]`. Dead since it was written.
 *
 *  ⚠ AND IT COULD NEVER HAVE WORKED HERE. This renderer serves non-browser channels and
 *  the D-149 reception surface, whose CSP is `script-src 'none'` — the same reason a Copy
 *  button is refused there. An affordance that cannot be honoured on the surface drawing
 *  it is the failure this file's own `RenderContext.interactive` note describes.
 *
 *  🔑 Sorting belongs where it can reach the STORE: a `sort` carrier on the owner
 *  panel's `filter`, ordered by the records store's own rule. See
 *  internal design notes. */

import { e } from './escape.js';
import { formatValue } from './format.js';
import { renderBlockError, renderEmptyCollection } from './block-error.js';
import { renderBlockLabel } from './label.js';
import { renderActionGroupInline } from './action.js';
import { tableFieldValue } from './table-field.js';
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

/** Bucket rows by one field's value, preserving FIRST-APPEARANCE order.
 *
 *  ⛔ Not alphabetical, and not a declared order. A status vocabulary has a
 *  meaningful sequence (open before done) that the alphabet does not know, and
 *  v1 declares no column ordering — so the only ordering available that is
 *  never WRONG is the one the producing step already chose. An author who wants
 *  a specific sequence sorts the rows in the step, which they can already do.
 *
 *  ⚠ Rows whose group value is absent, null or empty land in one trailing
 *  bucket rendered as "—". They are NOT dropped: a row that vanished because a
 *  field was missing is the silent-loss shape, and a visible odd-looking bucket
 *  is how an author discovers they grouped by the wrong field. */
const groupRows = (
  rows: unknown[],
  field: string,
): Array<{ key: string; label: string; rows: unknown[] }> => {
  const buckets = new Map<string, { key: string; label: string; rows: unknown[] }>();
  const UNGROUPED = '\u0000ungrouped';
  for (const row of rows) {
    const raw = tableFieldValue(row, field);
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    const key = empty ? UNGROUPED : String(raw);
    const existing = buckets.get(key);
    if (existing) existing.rows.push(row);
    else buckets.set(key, { key, label: empty ? '—' : String(raw), rows: [row] });
  }
  // The no-value bucket sorts last wherever it first appeared; every other
  // bucket keeps the order the step produced.
  const out = [...buckets.values()].filter((b) => b.key !== UNGROUPED);
  const ungrouped = buckets.get(UNGROUPED);
  if (ungrouped) out.push(ungrouped);
  return out;
};

export const renderTableBlock = (
  data: unknown,
  label?: string,
  resolvedColumns?: ResolvedRecordColumnsDescriptor,
  groupBy?: string,
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
  // ⛔ TWO DIFFERENT SITUATIONS, TWO DIFFERENT SENTENCES. No COLUMNS is a block that
  // cannot be drawn — the author declared none and the entity resolved none. No ROWS is
  // a list that is empty, which for a business app is a first-run moment. Both used to
  // read "No table data."
  if (columns.length === 0) {
    return renderBlockError('table', 'no columns to draw — the block declared none and'
      + ' no entity schema supplied any');
  }
  if (rows.length === 0) return renderEmptyCollection(resolvedColumns?.entity);

  const renderRow = (row: unknown): string => `
              <tr>
                ${columns
                  .map((c) => {
                    const cell = tableFieldValue(row, c.field);
                    return `<td${(c as { numeric?: boolean }).numeric === true ? ' class="is-numeric"' : ''}>${c.type === 'action'
                      ? renderActionGroupInline(cell)
                      : e(formatValue(cell, c.format))}</td>`;
                  })
                  .join('')}
              </tr>
            `;

  // ⛔ ONE TABLE, WITH GROUP HEADER ROWS — not a table per group, and not
  // columns. A grouped list is still a list: it keeps one header row, stays
  // readable by a screen reader in document order, and degrades to the ungrouped
  // rendering when nothing matches. Laying the groups out side by side is a
  // stylesheet's job on top of this markup, never a second renderer.
  const body = groupBy === undefined
    ? rows.map(renderRow).join('')
    : groupRows(rows, groupBy)
      .map((group) => `
              <tr class="group-row" data-group="${e(group.key)}">
                <th scope="rowgroup" colspan="${columns.length}">${e(group.label)} <span class="group-count">${group.rows.length}</span></th>
              </tr>
              ${group.rows.map(renderRow).join('')}
            `)
      .join('');

  return `
    <div class="block table-block"${groupBy === undefined ? '' : ` data-group-by="${e(groupBy)}"`}>
      ${renderBlockLabel(label)}
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              ${columns
                .map((c) => `<th${
                  (c as { numeric?: boolean }).numeric === true ? ' class="is-numeric"' : ''}>${e(String(c.label ?? c.field ?? ''))}</th>`)
                .join('')}
            </tr>
          </thead>
          <tbody>
            ${body}
          </tbody>
        </table>
      </div>
    </div>
  `;
};
