import { describe, it, expect } from 'vitest';
import { escapeHtml, e } from '../escape.js';

describe('escapeHtml', () => {
  it('escapes the five HTML-special characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("it's")).toBe('it&#39;s');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('leaves non-special characters untouched', () => {
    expect(escapeHtml('hello world 123 日本語')).toBe('hello world 123 日本語');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('exposes `e` as a shorthand alias for escapeHtml', () => {
    expect(e).toBe(escapeHtml);
    expect(e('<a>')).toBe('&lt;a&gt;');
  });
});
