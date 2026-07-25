import { describe, it, expect } from 'vitest';
import { renderChecklistBlock } from '../checklist.js';

describe('renderChecklistBlock', () => {
  it('renders each status with the expected class', () => {
    const html = renderChecklistBlock({
      title: 'Risk checks',
      items: [
        { label: 'Activity', status: 'ok' },
        { label: 'Close date', status: 'issue' },
        { label: 'Contact', status: 'null' },
      ],
    });
    expect(html).toContain('checklist-ok');
    expect(html).toContain('checklist-issue');
    expect(html).toContain('checklist-null');
    expect(html).toContain('Risk checks');
  });

  it('collapses long details into <details>', () => {
    const longDetail = 'x'.repeat(120);
    const html = renderChecklistBlock({
      items: [{ label: 'Long', status: 'ok', detail: longDetail }],
    });
    expect(html).toContain('<details');
    expect(html).toContain('xxx...');
  });

  it('escapes label + detail (XSS)', () => {
    const html = renderChecklistBlock({
      items: [{ label: '<script>', status: 'ok', detail: '<img onerror=x>' }],
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows SVG glyph for ok / issue statuses, nothing for null', () => {
    const html = renderChecklistBlock({
      items: [
        { label: 'A', status: 'ok' },
        { label: 'B', status: 'issue' },
        { label: 'C', status: 'null' },
      ],
    });
    expect(html).toContain('aria-label="Success"');
    expect(html).toContain('aria-label="Issue"');
  });

  it('renders item actions as read-only descriptors', () => {
    const html = renderChecklistBlock({
      items: [{
        label: 'Reply needed',
        status: 'issue',
        detail: 'Owner should respond',
        actions: [
          { kind: 'recipe.run', label: 'Draft reply', recipe_id: 'reply-action' },
          { kind: 'recipe.run', label: '<Close>', recipe_id: 'close-action' },
        ],
      }],
    });
    expect(html).toContain('Draft reply');
    expect(html).toContain('reply-action');
    expect(html).toContain('&lt;Close&gt;');
    expect(html).not.toContain('<Close>');
  });

  it('renders empty / malformed input safely', () => {
    expect(renderChecklistBlock({ items: [] })).toContain('No checklist data');
    expect(renderChecklistBlock(null)).toContain('block-error');
  });
});
