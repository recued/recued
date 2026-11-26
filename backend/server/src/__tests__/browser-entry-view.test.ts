import { describe, expect, it, vi } from 'vitest';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore, parseInspectHtml } from '../bridges/page-outline.js';
import { browserDataEntries } from '../bridges/browser-data-entries.js';
import { browserEntryView, BROWSER_ENTRY_VIEW_CHARS } from '../bridges/browser-entry-view.js';
import { createBrowserDataStore } from '../bridges/browser-data-store.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import type { BridgeDispatcher } from '../bridges/dispatcher.js';

const PAGE = '1:ENTRIES', url = 'https://example.test/glossary';
const html = '<nav><ul><li>Navigation private</li></ul></nav><main><h2 id="alpha">AlphaSection</h2><h3>Shared</h3>'
  + '<dl><dt><code>99</code> Zulu <span>.</span><span>name</span></dt><dd>Explanation, not an entry</dd>'
  + '<dt>2 Alpha (annotation)</dt></dl><h2 id="beta">BetaSection</h2><h3>Shared</h3><dl><dt>3 Beta</dt></dl>'
  + '<h2 id="gamma">GammaSection</h2><dl><dt>4 Gamma</dt></dl><form><ul><li>Form private</li></ul>'
  + '<input type="password" value="SECRET"></form><ul><li data-recued-structural-only>Hidden private</li></ul></main>';
const fixture = (body = html, extra = {}) => {
  const store = createPageReadStore();
  const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async () => ({ kind: 'completed', bridge_client_token_id: 'fixture', attempts: 1,
    result: { command_id: 'c', status: 'ok', duration_ms: 1, bridge_version: '0.0.10', idempotency_key_seen: false,
      outputs: { page: PAGE, url, title: 'Glossary', html: body, truncated: false, ...extra } } }));
  const adapter = createBridgeDomAdapter({ pageReads: store, data: createBrowserDataStore(),
    manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
  const read = (input = {}) => adapter({ slug: 'dom-inspect', input: { target: '*://*/*', page: PAGE, form: 'outline', ...input }, risk_tier: 'read', output: {} }) as Promise<Record<string, any>>;
  return { read, store, dispatch, adapter };
};
const texts = (view: Record<string, any>): string[] => view.groups.flatMap((group: Record<string, any>) => group.entries.map((row: Record<string, any>) => row.text));

describe('actual entries in ordinary browser read responses', () => {
  it('returns exact entry records with heading ancestry, before prose, without a data operation or extra Bridge read', async () => {
    const h = fixture();
    const out = await h.read();
    expect(out.entry_view).toMatchObject({ scope: 'displayed_lines', complete: true, source_complete: true,
      groups: [{ kind: 'definition_term', section: 'AlphaSection', heading_path: ['AlphaSection', 'Shared'],
        entries: [{ text: '99 Zulu .name' }, { text: '2 Alpha (annotation)' }] },
      { section: 'BetaSection', heading_path: ['BetaSection', 'Shared'], entries: [{ text: '3 Beta' }] },
      { section: 'GammaSection', entries: [{ text: '4 Gamma' }] }] });
    expect(texts(out.entry_view)).toEqual(['99 Zulu .name', '2 Alpha (annotation)', '3 Beta', '4 Gamma']);
    expect(JSON.stringify(out.entry_view)).not.toMatch(/private|SECRET|Explanation/);
    expect(out.entry_view.groups.some((g: object) => Object.hasOwn(g, 'count'))).toBe(false);
    expect(JSON.stringify(out).indexOf('entry_view')).toBeLessThan(JSON.stringify(out).indexOf('outline'));
    expect(h.dispatch.mock.calls.map(([request]) => request.action)).toEqual(['inspect']);
    const batch = await h.adapter({ slug: 'dom-act', input: { target: '*://*/*', page: PAGE, steps: [{ do: 'read' }] }, risk_tier: 'read', output: {} }) as Record<string, any>;
    expect(texts(batch.tabs[0].reads[0].entry_view)).toEqual(texts(out.entry_view));
  });

  it('restricts records to actual search/pagination ranges, including disjoint sections and heading ids', async () => {
    const h = fixture(); await h.read();
    const found = await h.read({ find: 'AlphaSection | GammaSection' });
    expect(texts(found.entry_view)).toEqual(['99 Zulu .name', '2 Alpha (annotation)', '4 Gamma']);
    expect(found.entry_view.groups.map((group: Record<string, any>) => group.section)).toEqual(['AlphaSection', 'GammaSection']);
    const section = await h.read({ form: 'text', find: '#beta' });
    expect(texts(section.entry_view)).toEqual(['3 Beta']);
    const from = h.store.headingLine(PAGE, '#beta')!;
    const later = await h.read({ from });
    expect(texts(later.entry_view)).toEqual(['3 Beta', '4 Gamma']);
    expect(later.entry_view.groups.flatMap((g: Record<string, any>) => g.entries).every((r: { line: number }) => r.line >= from)).toBe(true);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('keeps view/source completeness separate and discloses view limits without cutting records', async () => {
    for (const flags of [{ loading: true }, { truncated: true }]) {
      const out = await fixture(html, flags).read();
      expect(out.entry_view).toMatchObject({ complete: false, source_complete: false, incomplete: ['source_incomplete'] });
    }
    const out = await fixture('<main><h2>Long entries</h2><dl>' + Array.from({ length: 30 }, (_, i) => `<dt>Entry ${i} ${'x'.repeat(900)}</dt>`).join('') + '</dl></main>').read();
    expect(JSON.stringify(out.entry_view).length).toBeLessThanOrEqual(BROWSER_ENTRY_VIEW_CHARS);
    expect(out.entry_view).toMatchObject({ complete: false, incomplete: ['view_limit'] });
    expect(texts(out.entry_view).every(text => /^Entry \d+ x{900}$/.test(text))).toBe(true);
    const noLines = browserDataEntries(parseInspectHtml('<dl><dt>Unmapped</dt></dl>'));
    expect(browserEntryView(noLines, [{ from: 1, to: 10 }], true)).toBeUndefined();
  });

  it('keeps distinct ARIA entries sharing one outline line, including equal labels', async () => {
    const out = await fixture('<main><h2>Options</h2><div role="list"><span role="listitem">Same</span>'
      + '<span role="listitem">Same</span><span role="listitem">Other</span></div></main>').read();
    expect(texts(out.entry_view)).toEqual(['Same', 'Same', 'Other']);
    expect(new Set(out.entry_view.groups[0].entries.map((row: { line: number }) => row.line)).size).toBe(1);
    expect(out.entry_view.groups[0].entries.map((row: { position: number }) => row.position)).toEqual([1, 2, 3]);
  });

  it('presents rendered ranks together while preserving document positions and retained rows', async () => {
    const h = fixture('<main><ul data-recued-display-order="top-to-bottom:3">'
      + '<li data-recued-display-position="position-3">Alley</li><li data-recued-display-position="position-1">Bay</li>'
      + '<li data-recued-display-position="position-2">Depot</li></ul></main>');
    const out = await h.read();
    expect(out.entry_view.groups[0].entries).toMatchObject([
      { text: 'Bay', position: 2, displayed_position: 1, display_direction: 'top-to-bottom' },
      { text: 'Depot', position: 3, displayed_position: 2 },
      { text: 'Alley', position: 1, displayed_position: 3 },
    ]);
    expect(h.store.dataSnapshot(PAGE)?.entries?.rows.map(row => row.text)).toEqual(['Alley', 'Bay', 'Depot']);
  });

  it('refreshes semantic boundaries even when rendered text has not changed', async () => {
    const h = fixture('<main><dl><dt>Alpha</dt><dt>Beta</dt></dl></main>');
    await h.read();
    expect(h.store.refresh(PAGE, { url, title: 'Glossary', truncated: false,
      html: '<main><dl><dd>Alpha</dd><dt>Beta</dt></dl></main>' }).changed).toBe(false);
    const snapshot = h.store.dataSnapshot(PAGE)!;
    expect(snapshot.entries?.rows.map(row => row.text)).toEqual(['Beta']);
    expect(texts(browserEntryView(snapshot.entries!, [{ from: 1, to: 2 }], true)!)).toEqual(['Beta']);
  });
});
