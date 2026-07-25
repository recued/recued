import { describe, it, expect } from 'vitest';
import { renderSummaryBlock } from '../summary.js';

describe('renderSummaryBlock', () => {
  it('renders rows for each field', () => {
    const html = renderSummaryBlock({
      fields: [
        { label: 'Deal', value: 'Acme' },
        { label: 'Amount', value: 50_000 },
      ],
    });
    expect(html).toContain('summary-block');
    expect(html).toContain('Deal');
    expect(html).toContain('Amount');
    expect(html).toContain('Acme');
  });

  it('escapes user-supplied label and value (XSS)', () => {
    const html = renderSummaryBlock({
      fields: [{ label: '<img onerror=alert(1)>', value: '<script>' }],
    });
    expect(html).not.toContain('<img onerror');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img onerror');
    expect(html).toContain('&lt;script&gt;');
  });

  it('applies threshold classes for numeric values', () => {
    const html = renderSummaryBlock({
      fields: [
        {
          label: 'Risk',
          value: 95,
          threshold: { warn: 60, critical: 80 },
        },
      ],
    });
    expect(html).toContain('value-critical');
  });

  it('renders empty + malformed input as safe placeholder rows', () => {
    expect(renderSummaryBlock({ fields: [] })).toContain('No summary data');
    expect(renderSummaryBlock(null)).toContain('block-error');
    expect(renderSummaryBlock('bad')).toContain('block-error');
  });
});
