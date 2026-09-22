import { describe, it, expect } from 'vitest';
import { renderTableBlock } from '../table.js';

describe('renderTableBlock', () => {
  it('renders columns + rows with header sort hooks', () => {
    const html = renderTableBlock({
      columns: [
        { field: 'name', label: 'Name' },
        { field: 'amount', label: 'Amount', format: 'currency' },
      ],
      rows: [{ name: 'Acme', amount: 50_000 }],
    });
    // ⛔ D-282 B2 — this asserted `data-sort-field="name"`, an attribute nothing bound
    // and no stylesheet styled, on a surface (reception) whose CSP forbids the script
    // that would have bound it. The header is now plain; sorting lives where it can
    // reach the store.
    expect(html).not.toContain('data-sort-field');
    expect(html).not.toContain('sortable-th');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('Acme');
    expect(html).toContain('$50.0K');
  });

  it('applies per-cell format hints', () => {
    const html = renderTableBlock({
      columns: [{ field: 'rate', format: 'percent' }],
      rows: [{ rate: 0.42 }],
    });
    expect(html).toContain('42.0%');
  });

  it('escapes column labels and cell values (XSS)', () => {
    const html = renderTableBlock({
      columns: [{ field: 'x', label: '<script>' }],
      rows: [{ x: '<img onerror>' }],
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img onerror>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders action columns as read-only action descriptors', () => {
    const html = renderTableBlock({
      columns: [
        { field: 'name', label: 'Name' },
        { field: 'action', label: 'Action', type: 'action' },
      ],
      rows: [{
        name: 'Acme',
        action: { kind: 'recipe.run', label: 'Open row', recipe_id: 'reply-action' },
      }],
    });
    expect(html).toContain('Acme');
    expect(html).toContain('action-recipe-run');
    expect(html).toContain('Open row');
    expect(html).toContain('reply-action');
    expect(html).not.toContain('{&quot;kind&quot;');
  });

  it('renders multiple action-cell descriptors compactly and safely', () => {
    const html = renderTableBlock({
      columns: [{ field: 'actions', label: 'Actions', type: 'action' }],
      rows: [{
        actions: [
          { kind: 'recipe.run', label: '<Approve>', recipe_id: 'approve-reply' },
          { kind: 'url.open', label: 'Unsupported' },
        ],
      }],
    });
    expect(html).toContain('action-group');
    expect(html).toContain('&lt;Approve&gt;');
    expect(html).toContain('Unsupported action');
    expect(html).not.toContain('<Approve>');
  });

  /** ⛔⛔ D-282 B3 — THESE TWO USED TO PRODUCE THE SAME SENTENCE. "No table data" was
   *  returned both for a table that could not be DRAWN (no columns anywhere) and for one
   *  that simply had no ROWS. The first is a broken block; the second is a first-run
   *  moment in a business app, and a reader could not tell which they were looking at. */
  it('tells a block it cannot draw apart from a list that is empty', () => {
    const noColumns = renderTableBlock({ columns: [], rows: [] });
    expect(noColumns).toContain('block-error');
    expect(noColumns).toContain('no columns to draw');

    const noRows = renderTableBlock({ columns: [{ field: 'x' }], rows: [] });
    expect(noRows).toContain('block-empty');
    expect(noRows).toContain('Nothing here yet.');
    expect(noRows).not.toContain('block-error');

    expect(renderTableBlock(null)).toContain('block-error');
  });

  /** ⚠ The entity is NOT pluralised — `company` → "companys" and `person` → "persons"
   *  are wrong, and the keys belong to the pack author. "records" is the plural. */
  it('names the entity in an empty list when the block declared one', () => {
    const html = renderTableBlock(
      { columns: [], rows: [] },
      undefined,
      { entity: 'item_price', columns: [{ field: 'id', label: 'Id', kind: 'string' }] },
    );
    expect(html).toContain('No item price records yet.');
    expect(html).toContain('block-empty');
  });
});
