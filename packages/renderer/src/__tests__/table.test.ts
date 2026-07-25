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
    expect(html).toContain('data-sort-field="name"');
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

  it('renders missing columns/rows/bad-shape input as safe placeholders', () => {
    expect(renderTableBlock({ columns: [], rows: [] })).toContain('No table data');
    expect(renderTableBlock({ columns: [{ field: 'x' }], rows: [] })).toContain('No table data');
    expect(renderTableBlock(null)).toContain('block-error');
  });
});
