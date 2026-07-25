/** The `json` block — raw step-result detail.
 *
 *  The kind exists because `output.render` is the ONLY channel by which a run's
 *  data reaches any reader: `ExecuteResponse.steps[]` carries no values, so a
 *  step result absent from `render` is unreachable by every consumer, human and
 *  model alike. Two properties carry that weight and are tested here:
 *
 *  1. **FAITHFULNESS** — it shows what the step produced, whole. The specific
 *     trap it exists to avoid is `copyable`'s `.content` lift (below).
 *  2. **IT NEVER THROWS** — a block that throws takes the panel down with it,
 *     including the curated summary that rendered fine.
 */

import { describe, it, expect } from 'vitest';
import { OUTPUT_TYPES } from '@recued/contracts';

import { renderJsonBlock } from '../json.js';
import { renderCopyableBlock } from '../copyable.js';
import { renderSection } from '../index.js';

describe('the contract admits `json`', () => {
  it('is in the closed vocabulary', () => {
    expect(OUTPUT_TYPES).toContain('json');
  });

  it('dispatches through renderSection, carrying the authored label', () => {
    const html = renderSection({
      kind: 'json',
      data: { stock: 4 },
      label: 'Previous Inventory',
    });
    expect(html).not.toContain('unsupported section type');
    expect(html).toContain('Previous Inventory');
    expect(html).toContain('&quot;stock&quot;: 4');
  });
});

describe('renderJsonBlock — faithfulness', () => {
  it('pretty-prints an object at two-space indent', () => {
    const html = renderJsonBlock({ stock: 4, sku: 'A-1' });
    expect(html).toContain('&quot;stock&quot;: 4');
    expect(html).toContain('&quot;sku&quot;: &quot;A-1&quot;');
    // Two-space indent survives into the <pre>, which is the whole point of a
    // raw view — a one-line JSON.stringify is not readable detail.
    expect(html).toContain('\n  &quot;stock&quot;');
  });

  it('shows the WHOLE payload when it carries a .content field — where copyable drops the rest', () => {
    // The concrete reason this kind is not `copyable`. A Contentful entry (and
    // a Freshdesk ticket, and anything else with a `content` field) hits
    // copyable's lift and renders as that ONE field, silently discarding `sys`
    // and `fields`. For a block whose job is "here is the data", that is a
    // wrong answer delivered quietly.
    const entry = { sys: { id: 'e1' }, content: 'body text', fields: { title: 'T' } };

    const asJson = renderJsonBlock(entry);
    expect(asJson).toContain('&quot;sys&quot;');
    expect(asJson).toContain('&quot;fields&quot;');
    expect(asJson).toContain('body text');

    const asCopyable = renderCopyableBlock(entry);
    expect(asCopyable).toContain('body text');
    expect(asCopyable).not.toContain('sys');
  });

  it('renders arrays', () => {
    expect(renderJsonBlock([{ id: 1 }, { id: 2 }])).toContain('&quot;id&quot;: 2');
  });
});

describe('renderJsonBlock — never throws', () => {
  it('degrades a circular structure to a readable row', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    expect(() => renderJsonBlock(circular)).not.toThrow();
    expect(renderJsonBlock(circular)).toContain('not serialisable');
  });

  it('degrades a BigInt to a readable row', () => {
    expect(() => renderJsonBlock({ n: 1n })).not.toThrow();
    expect(renderJsonBlock({ n: 1n })).toContain('not serialisable');
  });

  it('renders null / undefined as an empty placeholder', () => {
    expect(renderJsonBlock(null)).toContain('No json data');
    expect(renderJsonBlock(undefined)).toContain('No json data');
  });

  it('renders an unserialisable-but-not-throwing payload as empty, not an error', () => {
    // `JSON.stringify` returns undefined (rather than throwing) for a bare
    // function — nothing to show, but nothing went wrong either.
    expect(renderJsonBlock(() => 'x')).toContain('No json data');
  });
});

describe('renderJsonBlock — escaping', () => {
  it('escapes a payload that tries to break out of the <pre> (XSS)', () => {
    const html = renderJsonBlock({ note: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes hostile KEYS, not just values', () => {
    const html = renderJsonBlock({ '<img src=x onerror=alert(1)>': 'v' });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes a hostile label', () => {
    const html = renderJsonBlock({ a: 1 }, '<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderJsonBlock — disclosure', () => {
  it('collapses behind native <details>, titled by the label', () => {
    const html = renderJsonBlock({ a: 1 }, 'Updated Inventory');
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('Updated Inventory');
  });

  it('falls back to a generic title when the section authored no label', () => {
    expect(renderJsonBlock({ a: 1 })).toContain('>Data</summary>');
    expect(renderJsonBlock({ a: 1 }, '')).toContain('>Data</summary>');
  });

  it('uses NO script — a reception page serves under `script-src none`', () => {
    // Native disclosure is the reason this renderer needs no RenderContext: a
    // scripted expander would be DEAD on a reception surface, not merely
    // unstyled. Same HTML on every surface.
    const html = renderJsonBlock({ a: 1 }, 'Detail');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('data-action');
  });
});
