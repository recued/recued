import { describe, it, expect } from 'vitest';
import { renderTextBlock } from '../text.js';

describe('renderTextBlock', () => {
  it('renders a plain string', () => {
    expect(renderTextBlock('hello world')).toContain('hello world');
  });

  it('serialises non-strings via JSON.stringify (then HTML-escapes)', () => {
    // JSON's quotes become &quot; once the value goes through escapeHtml.
    expect(renderTextBlock({ a: 1 })).toContain('{&quot;a&quot;:1}');
    expect(renderTextBlock([1, 2])).toContain('[1,2]');
  });

  it('escapes user-supplied text (XSS)', () => {
    const html = renderTextBlock('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders null / undefined as an empty placeholder', () => {
    expect(renderTextBlock(null)).toContain('No text data');
  });
});
