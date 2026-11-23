import { describe, expect, it, vi } from 'vitest';
import { parseBrowserCollectSpec, type BridgeResult } from '@recued/contracts';
import { browserCollectHint, collectBrowserPages } from '../bridges/browser-collect.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { createPageReadStore } from '../bridges/page-outline.js';

const url = 'https://example.com/list/1';
const row = (name: string, tag: string) => `<div class="entry"><span class="name">${name}</span>`
  + `<div class="labels"><a class="tag">${tag}</a><a class="tag">shared</a></div></div>`;
const rows = row('Ada', 'love') + row('Grace', 'news') + row('Linus', 'love');
const html = `<main>${rows}<a href="/list/2">Next →</a></main>`;

describe('a collector hint grounded in the cleaned page', () => {
  it('provides a valid conservative step whose fields collect the actual rows', async () => {
    const hint = browserCollectHint(html, url)!;
    expect(hint).toMatchObject({ rows_in_snapshot: 3, step: { do: 'collect', items: 'div.entry', max_pages: 1 } });
    expect(hint.step.fields).toEqual({ name: { selector: 'span.name' }, tags: { selector: 'a.tag', many: true, required: false } });
    // The core parser takes the spec alone; `do` belongs to its batch step.
    const { do: _do, ...spec } = hint.step;
    const accepted = parseBrowserCollectSpec({ ...spec, where: { field: 'tags', equals: 'love' } });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error(accepted.error);
    const result = await collectBrowserPages({ spec: accepted.spec,
      read: async () => ({ page: '7:DOC1', url, title: 'Rows', html, truncated: false }),
      navigate: vi.fn(), assertActive() {} });
    expect(result.records.map(r => r.values.name)).toEqual(['Ada', 'Linus']);
    expect(result).toMatchObject({ complete: false, stop_reason: 'max_pages', count: 2 });
  });

  it('allows an empty list on later rows while retaining a required identity field', async () => {
    const { do: _do, ...suggested } = browserCollectHint(html, url)!.step;
    const parsed = parseBrowserCollectSpec({ ...suggested, max_pages: 2, where: { field: 'tags', equals: 'love' } });
    if (!parsed.ok) throw new Error(parsed.error);
    const later = '<main>' + row('Nora', 'love')
      + '<div class="entry"><span class="name">Untagged</span></div>'
      + '<div class="entry"><span class="name">Also untagged</span></div></main>';
    const result = await collectBrowserPages({ spec: parsed.spec,
      read: async n => ({ page: `7:DOC${n}`, url: n === 1 ? url : 'https://example.com/list/2',
        title: 'Rows', html: n === 1 ? html : later, truncated: false }),
      navigate: async () => ({ page: '7:DOC2', url: 'https://example.com/list/2' }), assertActive() {} });
    expect(result).toMatchObject({ complete: true, count: 3, scanned: 6 });
    expect(result.records.map(r => r.values.name)).toEqual(['Ada', 'Linus', 'Nora']);
  });

  it('offers full title attributes for one-page repeated cards instead of inventing full text from an abbreviated label', async () => {
    const cards = '<main>' + ['North', 'West', 'East'].map((name, i) => `<article class="card">`
      + `<h3><a title="A complete title for ${name}">${name} ...</a></h3><p class="price">£${i + 20}.00</p></article>`).join('') + '</main>';
    const hint = browserCollectHint(cards, url)!;
    expect(hint.step.next).toBeUndefined();
    expect(hint.step.fields.title_attribute).toEqual({ selector: 'a[title]', attribute: 'title' });
    const { do: _do, ...raw } = hint.step;
    const spec = parseBrowserCollectSpec(raw);
    if (!spec.ok) throw new Error(spec.error);
    const navigate = vi.fn();
    const collected = await collectBrowserPages({ spec: spec.spec,
      read: async () => ({ page: '7:DOC1', url, title: 'Cards', html: cards, truncated: false }), navigate, assertActive() {} });
    expect(collected).toMatchObject({ complete: true, stop_reason: 'single_page', count: 3 });
    expect(collected.records.map(r => r.values.title_attribute)).toEqual(['A complete title for North', 'A complete title for West', 'A complete title for East']);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not guess across ambiguous pagination, other sites, menus or inconsistent fields', () => {
    for (const changed of [
      html.replace('</main>', '<a href="/list/3">Next</a></main>'),
      html.replace('/list/2', 'https://other.example/list/2'),
      `<nav>${rows}</nav><a href="/list/2">Next</a>`,
      html.replace('<span class="name">Grace</span>', '<b>Grace</b>'),
      html.replace('href="/list/2"', 'href="/list/1"'),
    ]) expect(browserCollectHint(changed, url)).toBeUndefined();
  });

  it('declines oversized pages and keeps long values out of the suggested fields', () => {
    expect(browserCollectHint(html + '<i></i>'.repeat(5_001), url)).toBeUndefined();
    const hint = browserCollectHint(html.replace('Ada', 'x'.repeat(2_001)), url);
    expect(hint).toBeUndefined();
  });

  it('keeps grounded hints on loading captures without claiming full coverage, never on cut or scoped reads', async () => {
    let conditions: Record<string, unknown> = {};
    const adapter = createBridgeDomAdapter({ pageReads: createPageReadStore(),
      manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ cancel: vi.fn(), canResolve: vi.fn(() => true), dispatch: async () => ({
        kind: 'completed', bridge_client_token_id: 'bridge', attempts: 1,
        result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.8', idempotency_key_seen: false, status: 'ok',
          outputs: { page: '7:DOC1', url, title: 'Rows', html, truncated: false, ...conditions } } as BridgeResult,
      }) }),
    });
    const read = (extra: Record<string, unknown> = {}) => adapter({ slug: 'dom-inspect', risk_tier: 'read', output: {},
      input: { target: '*://*/*', page: '7:DOC1', form: 'outline', ...extra } });
    expect(await read()).toHaveProperty('collection_hint.rows_in_snapshot', 3);
    conditions = { loading: true };
    const loading = await read();
    expect(loading).toHaveProperty('collection_hint.rows_in_snapshot', 3);
    expect(loading).toMatchObject({ loading: true, read_state: { complete: false },
      extraction_targets: { source_complete: false } });
    conditions = { truncated: true }; expect(await read()).not.toHaveProperty('collection_hint');
    conditions = {}; expect(await read({ selector: '#region' })).not.toHaveProperty('collection_hint');
  });
});
