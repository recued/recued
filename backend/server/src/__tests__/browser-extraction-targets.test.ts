import { describe, expect, it } from 'vitest';
import { isBrowserExtractionTargets, parseBrowserActSteps } from '@recued/contracts';
import { browserExtractionTargets } from '../bridges/browser-extraction-targets.js';
import { browserCollectHint } from '../bridges/browser-collect.js';

const url = 'https://example.com/items';
describe('observed extraction targets', () => {
  it('names native/ARIA tables using observed IDs, while excluding presentation tables and frames', () => {
    const html = '<main><table id="invoices"><tr><td>A</td></tr></table><section id="archive" role="grid" aria-label="Archive"></section>'
      + '<table role="presentation"><tr><td>Layout</td></tr></table><iframe><table id="inside-frame"></table></iframe>'
      + '<table data-recued-structural-only></table></main>';
    const targets = browserExtractionTargets(html, { url, whole: true, complete: true });
    expect(targets).toMatchObject({ source_complete: true, tables_complete: false,
      tables: [{ step: { do: 'table', selector: '#invoices' } }, { step: { do: 'table', selector: '#archive' }, label: 'Archive' }] });
    expect(parseBrowserActSteps(targets.tables.map(table => table.step))).toMatchObject({ ok: true });
    expect(isBrowserExtractionTargets(targets)).toBe(true);
  });
  it('anchors a scoped table to its observed region and never invents positional selectors', () => {
    const html = '<section><table><tr><td>A</td></tr></table><table id="second"><tr><td>B</td></tr></table></section>';
    const targets = browserExtractionTargets(html, { url, whole: false, complete: true, target: { ref: 'e12' } });
    expect(targets.tables).toEqual([{ step: { do: 'table', ref: 'e12' } }, {}]);
    const partial = browserExtractionTargets('<table></table>'.repeat(4), { url, whole: true, complete: false });
    expect(partial).toMatchObject({ source_complete: false, tables_complete: false, tables: [{ step: { do: 'table' } }, {}, {}] });
  });
  it('distinguishes repeated cards from tables and points to the existing checked collection fields', () => {
    const html = '<main>' + ['Ada', 'Grace', 'Linus'].map(name => `<article class="quote"><b class="author">${name}</b><p class="text">Visible quote</p></article>`).join('') + '</main>';
    const hint = browserCollectHint(html, url)!;
    const targets = browserExtractionTargets(html, { url, whole: true, complete: true, collection: hint });
    expect(targets).toMatchObject({ tables: [], tables_complete: true,
      collection: { items: hint.step.items, fields: Object.keys(hint.step.fields), rows_in_snapshot: 3 } });
  });
  it('does not offer ambiguous IDs or a default query that cannot match a fallback role list', () => {
    const html = '<div id="duplicate"></div><table id="first"></table><table id="duplicate"></table>'
      + '<div role="grid presentation"></div>';
    expect(browserExtractionTargets(html, { url, whole: true, complete: true }).tables)
      .toEqual([{ step: { do: 'table', selector: '#first' } }, {}, {}]);
    for (const whole of [true, false]) {
      expect(browserExtractionTargets('<section><div role="grid presentation"></div></section>',
        { url, whole, complete: true, target: { ref: 'e12' } }).tables).toEqual([{}]);
    }
  });
});
