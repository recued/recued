/** `group_by` on the webclient's own table — the surface an operator looks at.
 *
 *  ⛔⛔ WHY THIS EXISTS SEPARATELY FROM THE RENDERER'S OWN TESTS. There are TWO
 *  table renderers. `packages/renderer/src/table.ts` emits `.data-table` and
 *  backs the reception (visitor) path; this panel builds its own
 *  `.recipes-result-table` because it needs live cells — the editable grid,
 *  filter paging, row actions as real buttons — which the shared renderer emits
 *  inert. Teaching only the shared one to group would have left `group_by`
 *  working on public pages and doing NOTHING on the internal boards it was
 *  added for, which is exactly backwards. Neither suite covers the other.
 *
 *  🔑 THE LOAD-BEARING ASSERTION IS `rowIndex` SURVIVAL. Grouping reorders rows
 *  for display, and `rowIndex` is the grid's cell address and the remove-button
 *  target — renumber by display position and both aim at the wrong row.
 */
import { describe, expect, it } from 'vitest';
import {
  createResultActionRegistry,
  RECIPES_ROUTE_RESULT_GRID_ROW_ATTR,
  renderRecipeResultSection,
  type RenderedOutputSection,
} from '../recipes/recipe-result-panel.js';

const REGISTRY = createResultActionRegistry([], new Map(), false, new Set(), new Map(), new Set());

const COLUMNS = [
  { field: 'code', label: 'Code' },
  { field: 'title', label: 'Title' },
  { field: 'status', label: 'Status' },
];
const ROWS = [
  { code: 'J-1', title: 'Rewire', status: 'open' },
  { code: 'J-2', title: 'Quote', status: 'quoted' },
  { code: 'J-3', title: 'Boiler', status: 'open' },
];

const render = (section: Partial<RenderedOutputSection>): string =>
  renderRecipeResultSection(
    { type: 'table', data: { columns: COLUMNS, rows: ROWS }, ...section } as RenderedOutputSection,
    REGISTRY,
    new Map(),
    'list-job-board',
    false,
  );

describe('recipe result table — group_by', () => {
  it('renders one flat table when the section declares no grouping', () => {
    const html = render({});
    expect(html).not.toContain('recipes-result-group-row');
    for (const row of ROWS) expect(html).toContain(row.code);
  });

  it('emits one group heading per distinct value, counted, in first-appearance order', () => {
    const html = render({ group_by: 'status' });
    expect((html.match(/recipes-result-group-row/g) ?? []).length).toBe(2);
    expect(html).toContain('recipes-result-group-count');
    expect(html.indexOf('open')).toBeLessThan(html.indexOf('quoted'));
    // one table, one header — a grouped list is still a list
    expect((html.match(/<table/g) ?? []).length).toBe(1);
    expect((html.match(/<thead>/g) ?? []).length).toBe(1);
  });

  it('keeps each row\'s ORIGINAL index after regrouping', () => {
    // ⛔ J-3 is authored third and displays second (it joins the `open` bucket).
    // Its row attribute must still read 2, not 1 — that index addresses the
    // grid cell and the remove button, and display order is not identity.
    const html = render({ group_by: 'status' });
    const indices = [...html.matchAll(
      new RegExp(`${RECIPES_ROUTE_RESULT_GRID_ROW_ATTR}="(\\d+)"`, 'g'),
    )].map((m) => m[1]);
    expect(indices).toEqual(['0', '2', '1']);
  });

  it('keeps a row whose grouping field is missing, in a trailing bucket', () => {
    const html = renderRecipeResultSection(
      {
        type: 'table',
        data: { columns: COLUMNS, rows: [...ROWS, { code: 'J-4', title: 'Orphan' }] },
        group_by: 'status',
      } as RenderedOutputSection,
      REGISTRY, new Map(), 'list-job-board', false,
    );
    expect(html).toContain('J-4');
    expect((html.match(/recipes-result-group-row/g) ?? []).length).toBe(3);
    expect(html.lastIndexOf('J-4')).toBeGreaterThan(html.lastIndexOf('J-2'));
  });

  it('drops the action column in display mode, rather than hiding it', () => {
    // ⛔ A UX guard and nothing more — the session is still the owner's. But it
    // must DROP the column, not cover it: a rendered-then-hidden cell is still
    // in the DOM and still keyboard-focusable.
    const withActions = [{ ...COLUMNS[0] }, { field: 'actions', label: 'Actions', type: 'action' }];
    const rows = [{ code: 'J-1', status: 'open', actions: [{ label: 'Open' }] }];
    const normal = renderRecipeResultSection(
      { type: 'table', data: { columns: withActions, rows } } as RenderedOutputSection,
      REGISTRY, new Map(), 'list-job-board', false, new Map(), false, false, false,
    );
    const display = renderRecipeResultSection(
      { type: 'table', data: { columns: withActions, rows } } as RenderedOutputSection,
      REGISTRY, new Map(), 'list-job-board', false, new Map(), false, false, true,
    );
    expect(normal).toContain('Actions');
    expect(display).not.toContain('Actions');
    expect(display).toContain('J-1'); // the row itself survives
  });

  it('escapes a group value instead of letting it reach the markup', () => {
    const html = renderRecipeResultSection(
      {
        type: 'table',
        data: { columns: COLUMNS, rows: [{ code: 'X', status: '<img src=x onerror=alert(1)>' }] },
        group_by: 'status',
      } as RenderedOutputSection,
      REGISTRY, new Map(), 'list-job-board', false,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
