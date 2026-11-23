import { describe, expect, it } from 'vitest';
import { renderNoteMarkdown } from '../work-entity-page/note-markdown.js';

describe('Note Markdown rendering', () => {
  it('outlines parsed headings, including duplicates and setext, without treating code as headings', () => {
    const source = '# **Plan** & café\n\n## Next\n\n- One\n  - Two\n\n> Keep `verbatim`\n\n```html\n# Not a heading\n<img src=x>\n```\n\n## Next\n\nFinal *step*\n---\n';
    const result = renderNoteMarkdown(source);
    expect(result.headings.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 1, text: 'Plan & café' }, { level: 2, text: 'Next' },
      { level: 2, text: 'Next' }, { level: 2, text: 'Final step' },
    ]);
    expect(new Set(result.headings.map(heading => heading.id)).size).toBe(4);
    expect(renderNoteMarkdown('Some added prose.\n\n' + source).headings).toEqual(result.headings);
    expect(result.html).toContain('<strong>Plan</strong>');
    expect(result.html).toContain('<li>Two</li>');
    expect(result.html).toContain('<blockquote>');
    expect(result.html).toContain('<code>verbatim</code>');
    expect(result.html).toContain('# Not a heading\n&lt;img src=x&gt;');
  });

  it('keeps source HTML literal, blocks unsafe and route-changing links, and never embeds images', () => {
    const source = '<iframe src="https://example.com" onload="alert(1)"></iframe>\n\n'
      + '# <img src=x onerror=alert(1)> & title\n\n'
      + '[script](javascript:alert%281%29) [encoded](java&#x73;cript:alert%281%29) '
      + '[data](data:text/html,evil) [file](file:///etc/passwd) [route](#data/task) [relative](/settings)\n\n'
      + '[Website](https://example.com/?a=1&b=2 "A & B") [Email](mailto:owner@example.com)\n\n'
      + '![Remote image](https://example.com/tracker.png)';
    const { html, headings } = renderNoteMarkdown(source);
    expect(html).not.toMatch(/<(?:iframe|img|script|object|svg)\b/i);
    expect(html).toContain('&lt;iframe');
    expect(headings[0]?.text).toBe('<img src=x onerror=alert(1)> & title');
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(html).toContain('title="A &amp; B"');
    expect(html).toContain('href="mailto:owner@example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Remote image');
    expect(html).not.toContain('tracker.png');
  });
});
