import { describe, it, expect } from 'vitest';
import { renderCopyableBlock } from '../copyable.js';

describe('renderCopyableBlock', () => {
  it('renders text with a Copy button by default', () => {
    const html = renderCopyableBlock('Draft email body');
    expect(html).toContain('Draft email body');
    expect(html).toContain('data-action="copy"');
    expect(html).toContain('>Copy</button>');
  });

  it('lifts .content out of object payloads', () => {
    const html = renderCopyableBlock({ content: 'From an object' });
    expect(html).toContain('From an object');
  });

  it('renders label when provided', () => {
    const html = renderCopyableBlock('abc', 'Subject');
    expect(html).toContain('copyable-label');
    expect(html).toContain('Subject');
  });

  it('strips the Copy button when context.interactive is false', () => {
    const html = renderCopyableBlock('abc', undefined, { interactive: false });
    expect(html).not.toContain('<button');
    expect(html).toContain('abc');
  });

  it('escapes user-supplied content inside <pre> (XSS)', () => {
    const html = renderCopyableBlock('<script>alert(1)</script>');
    // The <pre> that renders the payload must contain only escaped entities —
    // no raw tag survives to execute.
    const pre = html.match(/<pre>([^<]*)<\/pre>/);
    expect(pre?.[1]).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain(
      'data-value="&lt;script&gt;alert(1)&lt;/script&gt;"',
    );
  });

  it('double-escapes entity-looking source so DOM parsing preserves clipboard text', () => {
    const html = renderCopyableBlock('Use &quot;literal&quot; &amp; retain');

    expect(html).toContain(
      'data-value="Use &amp;quot;literal&amp;quot; &amp;amp; retain"',
    );
  });

  it('renders null / undefined as an empty placeholder', () => {
    expect(renderCopyableBlock(null)).toContain('No copyable data');
  });
});
