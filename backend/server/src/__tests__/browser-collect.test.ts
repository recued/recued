import { describe, expect, it, vi } from 'vitest';
import { parseBrowserActSteps, parseBrowserCollectSpec, type BrowserCollectSpec } from '@recued/contracts';
import { BROWSER_COLLECT_READY_WAIT_MS, collectBrowserPages, type BrowserCollectPage } from '../bridges/browser-collect.js';
import type { ResolvedCall } from '@recued/ingredients';
import type { BridgeResult } from '@recued/contracts';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import type { DispatchRequest } from '../bridges/dispatcher.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { withRunAbortContext } from '../execution/run-abort-context.js';

const row = (name: string, tags = 'news') => `<article class="item"><span class="name">${name}</span><a href="/${name}">Link</a><span class="tag">${tags}</span></article>`;
const page = (n: number, html: string): BrowserCollectPage => ({ page: `7:DOC${n}`, url: `https://example.com/list/${n}`,
  title: `Page ${n}`, html: `<main>${html}</main>`, truncated: false });
const next = (n: number) => `<a href="/list/${n}">Next →</a>`;
const spec = (change: Record<string, unknown> = {}): BrowserCollectSpec => {
  const parsed = parseBrowserCollectSpec({ items: 'article.item', fields: { name: '.name', tags: { selector: '.tag', many: true } },
    next: { text: 'Next' }, max_pages: 5, ...change });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.spec;
};
const run = (pages: BrowserCollectPage[], change: Record<string, unknown> = {}, maxChars?: number) => {
  const read = vi.fn(async (n: number) => pages[n - 1]!);
  const navigate = vi.fn(async (_address: string, n: number) => pages[n]!);
  return { read, navigate, result: collectBrowserPages({ spec: spec(change), read, navigate, assertActive() {}, maxChars }) };
};

describe('browser collection over fresh cleaned pages', () => {
  it('returns an executable one-click recovery for an observed same-address Next without following it', async () => {
    const { result, navigate, read } = run([page(1, row('Ada') + '<a href="#page2" aria-label="Next page">Next →</a>')], { next: { text: 'Next page' } });
    const out = await result;
    expect(out).toMatchObject({ count: 1, complete: false, stop_reason: 'repeated_page', coverage: { complete: false },
      pagination_recovery: { reason: 'same_page_address', control: { tag: 'a', label: 'Next page', href: '#page2', submission_possible: false },
        steps: [{ do: 'click', page: '7:DOC1', text: 'Next page', role: 'link' }, { do: 'read' }] } });
    expect(parseBrowserActSteps(out.pagination_recovery!.steps)).toMatchObject({ ok: true });
    expect(read).toHaveBeenCalledTimes(1); expect(navigate).not.toHaveBeenCalled();
    const bounded = await run([page(1, row('Ada') + next(1))], { max_pages: 1 }).result;
    expect(bounded.pagination_recovery?.steps).toBeUndefined();
    const tiny = await run([page(1, row('Ada') + next(1))], {}, 512).result;
    expect(JSON.stringify(tiny).length).toBeLessThanOrEqual(512);
  });

  it('withholds action suggestions for form submissions, ambiguous controls and loading snapshots', async () => {
    for (const html of ['<form method="post"><button>Next</button></form>', '<input type="submit" value="Next" aria-label="Next">']) {
      const out = await run([page(1, row('Ada') + html)], { next: { selector: html.includes('<input') ? 'input' : 'button' } }).result;
      expect(out.pagination_recovery).toMatchObject({ control: { submission_possible: true }, read_step: { do: 'read', page: '7:DOC1' } });
      expect(out.pagination_recovery).not.toHaveProperty('steps');
    }
    expect((await run([page(1, row('Ada') + next(1) + next(1))]).result).pagination_recovery).toBeUndefined();
    const loading = await run([{ ...page(1, row('Ada') + next(1)), loading: true }]).result;
    expect(loading.pagination_recovery).not.toHaveProperty('steps');
    const button = await run([page(1, row('Ada') + '<button type="button">Next</button>')]).result;
    expect(button.pagination_recovery?.steps).toBeDefined();
  });

  it('distinguishes missing required lists from optional filtered coverage within a page bound', async () => {
    const noTags = '<article class="item"><span class="name">No tags</span></article>';
    const pages = [page(1, row('Ada') + noTags + next(2)), page(2, row('Grace') + next(3))];
    const required = await run(pages, { max_pages: 2 }).result;
    expect(required).toMatchObject({ complete: false, count: 1, scanned: 2, stop_reason: 'missing_field:tags',
      coverage: { page_limit: 2, pages_processed: 0, items_processed: 1, complete: false,
        stopped_at: { page: 1, item: 2, field: 'tags' } } });
    expect(required.note).toContain('required even with many:true');
    expect(required.field_failure).toMatchObject({ field: 'tags', required: true, many: true, matches: 0, empty_values: 0,
      page: 1, item: 2, restart_url: 'https://example.com/list/1', read_step: { do: 'read', page: '7:DOC1', form: 'outline' } });
    expect(parseBrowserActSteps([required.field_failure!.read_step])).toMatchObject({ ok: true });
    const input = { max_pages: 2, fields: { name: '.name', tags: { selector: '.tag', many: true, required: false } },
      where: { field: 'tags', equals: 'news' } };
    const optional = await run(pages, input).result;
    expect(optional).toMatchObject({ complete: false, stop_reason: 'max_pages', count: 2, scanned: 3,
      coverage: { page_limit: 2, pages_processed: 2, items_processed: 3, loading_pages: 0, complete: true } });
    expect(optional.records.map(record => record.values.name)).toEqual(['Ada', 'Grace']);
    expect(optional.field_failure).toBeUndefined();
    const loading = await run([pages[0]!, { ...pages[1]!, loading: true }], input).result;
    expect(loading.coverage).toMatchObject({ pages_processed: 2, items_processed: 3, loading_pages: 1, complete: false });
  });

  it('keeps available records but never claims a loading page without a next link is exhausted', async () => {
    const pending = run([{ ...page(1, row('Ada')), loading: true }]);
    expect(await pending.result).toMatchObject({ complete: false, stop_reason: 'page_loading', count: 1,
      records: [{ values: { name: 'Ada' } }] });
    expect(pending.navigate).not.toHaveBeenCalled();
  });

  // 2026-11-21 (D-402, benchmark task I, live) — a page read while it still loads, showing no Next link, is read again once the
  // page is ready, so a list with no Next link is known to be whole: Travel's one page was called partial in 14 of 57 runs.
  it('waits for a loading page with no Next link to be ready, and reads it again before saying whether it has one', async () => {
    const reads = [{ ...page(1, row('Ada')), loading: true }, page(1, row('Ada') + row('Grace'))];
    const read = vi.fn(async () => reads.shift()!);
    const ready = vi.fn(async (ms: number) => ms > 0 && ms <= BROWSER_COLLECT_READY_WAIT_MS);
    const out = await collectBrowserPages({ spec: spec(), read, navigate: vi.fn(), ready, assertActive() {} });
    expect(out).toMatchObject({ complete: true, stop_reason: 'next_not_found', count: 2, coverage: { loading_pages: 0, complete: true } });
    expect([read.mock.calls.length, ready.mock.calls.length]).toEqual([2, 1]);
    // A page still loading after the wait is partial, as before.
    const still = await collectBrowserPages({ spec: spec(), read: vi.fn(async () => ({ ...page(1, row('Ada')), loading: true })),
      navigate: vi.fn(), ready: vi.fn(async () => false), assertActive() {} });
    expect(still).toMatchObject({ complete: false, stop_reason: 'page_loading', count: 1 });
    // A loading page that shows its Next link is not waited for.
    const paged = [{ ...page(1, row('Ada') + next(2)), loading: true }, page(2, row('Grace'))];
    const notNeeded = vi.fn(async () => true);
    const turned = await collectBrowserPages({ spec: spec(), read: vi.fn(async (n: number) => paged[n - 1]!),
      navigate: vi.fn(async (_address: string, n: number) => paged[n]!),
      ready: notNeeded, assertActive() {} });
    expect(turned).toMatchObject({ count: 2, stop_reason: 'next_not_found' });
    expect(notNeeded).not.toHaveBeenCalled();
  });

  // 2026-11-21 (task M, live) — a collect of a page's own links (no Next) on a page its ads kept loading: the wait took the
  // collect's whole time and its links were lost, so M's page loop had none to turn.
  it('never waits on a collect that follows no Next, and a wait takes at most half the time, keeping the read it has', async () => {
    const ready = vi.fn(async () => true);
    const links = await collectBrowserPages({ spec: spec({ next: undefined, max_pages: 1 }), navigate: vi.fn(), ready, assertActive() {},
      read: vi.fn(async () => ({ ...page(1, row('Ada')), loading: true })) });
    expect(links).toMatchObject({ stop_reason: 'page_loading', count: 1 });
    expect(ready).not.toHaveBeenCalled();
    let clock = 0;
    const waited: number[] = [];
    const halved = await collectBrowserPages({ spec: spec({ max_seconds: 10 }), now: () => clock, navigate: vi.fn(), assertActive() {},
      read: vi.fn(async () => ({ ...page(1, row('Ada')), loading: true })),
      ready: vi.fn(async (ms: number) => { waited.push(ms); clock += ms; return false; }) });
    expect(waited).toEqual([5_000]);
    expect(halved).toMatchObject({ stop_reason: 'page_loading', count: 1 });
  });

  it('says which bounds it read at their maxima', async () => {
    const out = await run([page(1, row('Ada'))], { max_pages: 50, max_items: 1000 }).result;
    expect(out.bounds).toEqual({ asked: { max_pages: 50, max_items: 1000 }, read_at_most: { max_pages: 20, max_items: 500 },
      note: 'A collection reads at most 20 pages, 500 items and 120 seconds; this one asked for more, so it read up to those.' });
    expect((await run([page(1, row('Ada'))]).result).bounds).toBeUndefined();
  });

  it('follows three pages, filters, deduplicates and retains every source without a model call', async () => {
    const { result, navigate, read } = run([page(1, row('Ada') + row('Skip', 'other') + next(2)),
      page(2, row('Ada') + row('Grace') + next(3)), page(3, row('Linus'))], { where: { field: 'tags', equals: 'news' } });
    const collected = await result;
    expect(collected).toMatchObject({ complete: true, stop_reason: 'next_not_found', count: 3, scanned: 5, duplicates: 1 });
    expect(collected.records.map(r => r.values.name)).toEqual(['Ada', 'Grace', 'Linus']);
    expect(collected.records[0]!.sources).toEqual([{ page: 1, item: 1 }, { page: 2, item: 1 }]);
    expect(read).toHaveBeenCalledTimes(3);
    expect(navigate.mock.calls.map(c => c[0])).toEqual(['https://example.com/list/2', 'https://example.com/list/3']);
  });

  it('evaluates scoped child selectors, attributes and optional fields', async () => {
    const { result } = run([page(1, row('Ada'))], { max_pages: 1, fields: {
      name: '.name', link: { selector: ':scope > a', attribute: 'href' }, optional: { selector: '.missing', required: false },
    } });
    expect((await result).records[0]!.values).toEqual({ name: 'Ada', link: '/Ada', optional: null });
  });

  it('returns partial results at page/item bounds, counting filtered and duplicate source items', async () => {
    const pages = [page(1, row('Ada') + row('Ada') + next(2)), page(2, row('Grace'))];
    const bounded = run(pages, { max_pages: 1 });
    expect(await bounded.result).toMatchObject({ complete: false, count: 1, scanned: 2, stop_reason: 'max_pages', next_url: pages[1]!.url });
    expect(bounded.navigate).not.toHaveBeenCalled();
    const filtered = run(pages, { max_items: 1, where: { field: 'name', equals: 'Nobody' } });
    expect(await filtered.result).toMatchObject({ complete: false, count: 0, scanned: 1, stop_reason: 'max_items' });
    expect(filtered.navigate).not.toHaveBeenCalled();
  });

  it('stops on changed layouts, ambiguous fields, truncated input and conflicting keys', async () => {
    for (const [html, reason] of [
      ['<article class="item"><b>Different layout</b></article>', 'missing_field:name'],
      [row('Ada').replace('</article>', '<span class="name">Other</span></article>'), 'ambiguous_field:name'],
      [row('Ada', 'different'), 'conflicting_duplicate'],
      [row('x'.repeat(2_001)), 'field_truncated:name'],
    ]) {
      const { result, navigate } = run([page(1, row('Ada') + next(2)), page(2, html!)], { dedupe_by: ['name'] });
      expect(await result).toMatchObject({ complete: false, count: 1, stop_reason: reason });
      expect(navigate).toHaveBeenCalledTimes(1);
    }
    expect(await run([{ ...page(1, row('Ada')), truncated: true }]).result)
      .toMatchObject({ complete: false, count: 0, stop_reason: 'page_truncated' });
  });

  it('never follows ambiguous, cross-site, invalid, repeated or button next controls', async () => {
    for (const [links, reason] of [
      [next(2) + next(3), 'ambiguous_next'], ['<a href="https://other.example/x">Next</a>', 'different_site'],
      ['<a href="javascript:alert(1)">Next</a>', 'invalid_next_address'], [next(1), 'repeated_page'],
      ['<button>Next</button>', 'next_not_a_link'],
    ]) {
      const { result, navigate } = run([page(1, row('Ada') + links)]);
      expect(await result).toMatchObject({ complete: false, count: 1, stop_reason: reason });
      expect(navigate).not.toHaveBeenCalled();
    }
    expect(await run([page(1, row('Ada') + '<li class="disabled">' + next(2) + '</li>')]).result)
      .toMatchObject({ complete: true, count: 1 });
  });

  it('returns partial data on redirects and enforces the output bound', async () => {
    const redirect = run([page(1, row('Ada') + next(2)), { ...page(2, row('Grace')), url: 'https://example.com/login' }]);
    expect(await redirect.result).toMatchObject({ complete: false, count: 1, stop_reason: 'unexpected_page' });
    const bounded = await run([page(1, Array.from({ length: 100 }, (_, n) => row(`Name${n}`)).join(''))], {}, 1_000).result;
    expect(bounded).toMatchObject({ complete: false, stop_reason: 'output_limit' });
    expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(1_000);
  });

  it('honors the deadline and propagates cancellation or revoked authority before navigation', async () => {
    let clock = 0;
    const navigate = vi.fn();
    const read = vi.fn(async () => { clock = 61_000; return page(1, row('Ada') + next(2)); });
    expect(await collectBrowserPages({ spec: spec(), read, navigate, assertActive() {}, now: () => clock }))
      .toMatchObject({ complete: false, stop_reason: 'max_seconds' });
    expect(navigate).not.toHaveBeenCalled();
    let revoked = false;
    await expect(collectBrowserPages({ spec: spec(), navigate, read: async () => { revoked = true; return page(1, row('Ada') + next(2)); },
      assertActive() { if (revoked) throw new Error('revoked'); } })).rejects.toThrow('revoked');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('positional collection over preserved siblings', () => {
  const html = '<body><main><table><tbody><tr data-recued-structural-only></tr>'
    + '<tr id="r2"><td data-recued-structural-only></td><th>Label</th><script data-recued-structural-only></script>'
    + '<td>Ada</td><td data-recued-structural-only></td><td>CA</td></tr>'
    + '<tr id="r3"><td data-recued-structural-only></td><th>Label</th><script data-recued-structural-only></script>'
    + '<td>Grace</td><td data-recued-structural-only></td><td>NY</td></tr></tbody></table></main></body>';
  const structural = { ...page(1, ''), html, structure_complete: true, structure_root: '2,2,1,1' };
  const change = { items: 'body:nth-child(2) tr:nth-child(n+2)', max_pages: 1, next: undefined, fields: {
    name: 'td:nth-child(4)', same: 'td:nth-of-type(2)', state: 'td:nth-last-child(1)',
    row: { selector: ':scope:nth-child(2)', attribute: 'id', required: false },
    visible: ':scope', missing: { selector: 'td:first-child', required: false },
  } };
  it('counts hidden roots, omitted scripts and element types without exposing placeholders', async () => {
    const result = await run([structural], change).result;
    expect(result).toMatchObject({ complete: true, count: 2, scanned: 2 });
    expect(result.records.map(record => record.values)).toEqual([
      { name: 'Ada', same: 'Ada', state: 'CA', row: 'r2', visible: 'Label Ada CA', missing: null },
      { name: 'Grace', same: 'Grace', state: 'NY', row: null, visible: 'Label Grace NY', missing: null },
    ]);
    expect((await run([structural], { ...change, items: 'tr:nth-child(odd)',
      fields: { name: 'td:nth-last-of-type(3)' } }).result).records.map(record => record.values.name)).toEqual(['Grace']);
  });

  it('stops before extracting or navigating when original sibling fidelity is absent', async () => {
    for (const metadata of [{ structure_complete: undefined }, { structure_complete: false },
      { structure_root: undefined }, { structure_root: '2,1,1,1' }, { structure_root: '1,1,1,NaN' }]) {
      const t = run([{ ...structural, ...metadata }], change);
      expect(await t.result).toMatchObject({ count: 0, complete: false, stop_reason: 'structural_snapshot_required' });
      expect(t.navigate).not.toHaveBeenCalled();
    }
  });

  const scoped = { ...structural, structure_complete: false, structure_scoped: true,
    html: structural.html.replace('<main>', '<iframe data-recued-structure-incomplete></iframe><main>') };
  const scopedFields = { ...change, items: 'tr' };
  it('extracts positional fields from faithful items beside an unrelated transformed branch', async () => {
    const out = await run([scoped], scopedFields).result;
    expect(out).toMatchObject({ count: 2, complete: true });
    expect(out.records.map(r => r.values.name)).toEqual(['Ada', 'Grace']);
    expect(out.records.map(r => r.values.row)).toEqual(['r2', null]);
  });

  it('rejects incomplete item, containing and nested branches even for optional fields', async () => {
    for (const html of [scoped.html.replace('<main>', '<main data-recued-structure-incomplete>'),
      scoped.html.replace('<tr id="r2">', '<tr id="r2" data-recued-structure-incomplete>'),
      scoped.html.replace('<td>Ada</td>', '<td><iframe data-recued-structure-incomplete></iframe>Ada</td>')]) {
      const t = run([{ ...scoped, html }], { ...scopedFields, fields: { name: { selector: 'td:nth-child(4)', required: false } } });
      expect(await t.result).toMatchObject({ count: 0, complete: false, stop_reason: 'structural_snapshot_required' });
      expect(t.navigate).not.toHaveBeenCalled();
    }
  });

  it('keeps whole-page and legacy guards when scope cannot establish the requested positions', async () => {
    for (const [snapshot, query] of [
      [{ ...scoped, structure_scoped: undefined }, scopedFields],
      [{ ...scoped, structure_complete: undefined }, scopedFields],
      [{ ...scoped, html: structural.html }, scopedFields],
      [{ ...scoped, structure_root: '0,1,1,1' }, scopedFields],
      [scoped, change],
      [scoped, { ...scopedFields, next: { selector: 'a:last-child' } }],
    ] as const) {
      expect(await run([snapshot], query).result).toMatchObject({ count: 0, complete: false, stop_reason: 'structural_snapshot_required' });
    }
    expect(await run([{ ...scoped, truncated: true }], scopedFields).result)
      .toMatchObject({ count: 0, complete: false, stop_reason: 'page_truncated' });
  });

  it('returns specific structural causes and ordinary read recovery without inventing loading', async () => {
    const fields = { ...scopedFields, fields: { name: 'td:nth-child(4)' } };
    for (const [snapshot, query, cause, required_for] of [
      [{ ...scoped, structure_complete: undefined }, fields, 'missing_structure_evidence', 'field_positions'],
      [{ ...scoped, structure_scoped: undefined }, fields, 'missing_scope_evidence', 'field_positions'],
      [scoped, change, 'whole_page_required', 'item_positions'],
      [{ ...scoped, structure_root: '0,0,0,0' }, fields, 'invalid_root_evidence', 'field_positions'],
      [{ ...scoped, html: scoped.html.replace('<main>', '<main data-recued-structure-incomplete>') }, fields, 'target_subtree_incomplete', 'field_positions'],
    ] as const) {
      const t = run([snapshot], query);
      expect(await t.result).toMatchObject({ count: 0, complete: false, stop_reason: 'structural_snapshot_required',
        structural_failure: { cause, required_for, loading: 'unknown', read_step: { do: 'read', page: structural.page } } });
      expect(t.navigate).not.toHaveBeenCalled();
    }
    const ready = await run([{ ...scoped, structure_scoped: undefined, loading: false }], fields).result;
    expect(ready.structural_failure?.loading).toBe(false);
    const small = await run([{ ...scoped, structure_scoped: undefined }], fields, 512).result;
    expect(JSON.stringify(small).length).toBeLessThanOrEqual(512);
  });
});

describe('collection through the existing browser batch dispatcher', () => {
  const batch = (afterRead?: () => void, positional = false, scoped = false) => {
    const requests: DispatchRequest[] = [];
    let current = 1;
    const adapter = createBridgeDomAdapter({
      manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ cancel: vi.fn(), canResolve: vi.fn(() => true), dispatch: async request => {
        requests.push(request);
        if (request.action === 'navigate') current++;
        else if (request.action !== 'reread') throw new Error(`Unexpected ${request.action}`);
        const outputs = page(current, row(`Name${current}`) + (current < 3 ? next(current + 1) : ''));
        if (scoped) outputs.html = `<body><iframe data-recued-structure-incomplete></iframe>${outputs.html}</body>`;
        if (request.action === 'reread') afterRead?.();
        return { kind: 'completed' as const, bridge_client_token_id: 'bridge', attempts: 1,
          result: { command_id: 'command', duration_ms: 1, bridge_version: '0.0.8', idempotency_key_seen: false,
            status: 'ok', outputs: { ...outputs, ...(positional ? { structure_complete: !scoped, structure_root: '1,1,1,1',
              ...(scoped ? { structure_scoped: true } : {}) } : {}) } } as BridgeResult };
      } }),
    });
    const call: ResolvedCall = { slug: 'dom-act', risk_tier: 'write', output: {}, input: { target: '*://*/*', page: '7:DOC1',
      steps: [{ do: 'collect', ...spec(positional ? { max_pages: 1, ...(scoped ? { fields: { name: 'span:nth-child(1)' } }
        : { items: 'article:nth-child(1)' }) } : {}) }] }, stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id: 'collect-run' } };
    return { requests, run: () => adapter(call) };
  };

  it('uses only 0.0.8 reread/navigation commands with distinct keys per iteration and bounded model output', async () => {
    const t = batch();
    const result = await t.run() as { tabs: Array<{ reads: Array<{ collection: { count: number; complete: boolean } }> }> };
    expect(result.tabs[0]!.reads[0]!.collection).toMatchObject({ count: 3, complete: true });
    expect(t.requests.map(r => r.action)).toEqual(['reread', 'navigate', 'reread', 'navigate', 'reread']);
    expect(new Set(t.requests.map(r => r.idempotency_key)).size).toBe(5);
    expect(t.requests.filter(r => r.action === 'reread').map(r => r.step_id))
      .toEqual(['act#collect1.page1', 'act#collect1.page2', 'act#collect1.page3']);
    expect(t.requests.every(r => r.timeout_ms! > 0 && r.timeout_ms! <= 60_000)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('<article');
  });

  it('requests structural reads only for positional selectors and consumes their metadata', async () => {
    const t = batch(undefined, true);
    const result = await t.run() as { tabs: Array<{ reads: Array<{ collection: { count: number } }> }> };
    expect(result.tabs[0]!.reads[0]!.collection.count).toBe(1);
    expect(t.requests[0]!.args.preserve_structure).toBe(true);
    expect(t.requests.map(request => request.action)).toEqual(['reread']);
  });

  it('carries scoped Bridge metadata through the adapter without weakening the legacy flag', async () => {
    const t = batch(undefined, true, true);
    expect(await t.run()).toMatchObject({ tabs: [{ reads: [{ collection: { count: 1, complete: false,
      stop_reason: 'max_pages', records: [{ values: { name: 'Name1' } }] } }] }] });
    expect(t.requests[0]!.args.preserve_structure).toBe(true);
    expect(t.requests.map(request => request.action)).toEqual(['reread']);
  });

  // 2026-11-21 (D-402, benchmark task I, live) — the adapter gives the collect its readiness wait: a page read while it still
  // loads, with no Next link, is read again once the Bridge says it is ready, and comes back whole.
  // ⚠ The double answers a key it has seen from its cache, as the Bridge does (`idempotency_key_seen`). A double that read
  //   afresh on every request passed this while, live, every poll after the first got the first poll's "still loading"
  //   back, and the read after the wait got the collect's first read back: the page was never seen ready.
  const replaying = () => {
    const requests: DispatchRequest[] = [];
    const answered = new Map<string, BridgeResult>();
    let reads = 0;
    const adapter = createBridgeDomAdapter({
      manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
      getDispatcher: () => ({ cancel: vi.fn(), canResolve: vi.fn(() => true), dispatch: async request => {
        requests.push(request);
        const prior = answered.get(request.idempotency_key);
        if (prior !== undefined) {
          return { kind: 'completed' as const, bridge_client_token_id: 'bridge', attempts: 1, result: { ...prior, idempotency_key_seen: true } };
        }
        if (request.action !== 'reread' && request.action !== 'inspect') throw new Error(`Unexpected ${request.action}`);
        reads += 1;
        // The collect's read, and the first of the readiness reads, see the page still loading.
        const result = { command_id: `command${reads}`, duration_ms: 1, bridge_version: '0.0.14', idempotency_key_seen: false,
          status: 'ok', outputs: { ...page(1, row('Ada')), loading: reads <= 2 } } as BridgeResult;
        answered.set(request.idempotency_key, result);
        return { kind: 'completed' as const, bridge_client_token_id: 'bridge', attempts: 1, result };
      } }),
    });
    return { requests, run: (steps: unknown[]) => adapter({ slug: 'dom-act', risk_tier: 'write', output: {},
      input: { target: '*://*/*', page: '7:DOC1', steps }, stepMeta: { recipe_id: 'act-on-web-page', step_id: 'act', run_id: 'collect-ready' } }) };
  };

  it('reads a loading page with no Next link again once it is ready, through the adapter', async () => {
    const t = replaying();
    const result = await t.run([{ do: 'collect', ...spec({ max_seconds: 4 }) }]) as {
      tabs: Array<{ reads: Array<{ collection: Record<string, unknown> }> }> };
    expect(result.tabs[0]!.reads[0]!.collection).toMatchObject({ complete: true, stop_reason: 'next_not_found', count: 1 });
    expect(new Set(t.requests.map(r => r.idempotency_key)).size).toBe(t.requests.length);
  });

  // The bounds note reaches the batch's answer: a collect asked for 50 pages and 1,000 items in every run of task I.
  it('says, through the adapter, which bounds a collect read at their maxima', async () => {
    const t = replaying();
    const result = await t.run([{ do: 'collect', items: 'article.item', fields: { name: '.name' }, next: { text: 'Next' },
      max_pages: 50, max_items: 1000 }]) as { tabs: Array<{ reads: Array<{ collection: Record<string, unknown> }> }> };
    expect(result.tabs[0]!.reads[0]!.collection).toMatchObject({ bounds: { asked: { max_pages: 50, max_items: 1000 },
      read_at_most: { max_pages: 20, max_items: 500 }, note: expect.stringContaining('this one asked for more') } });
  });

  it('sees a loading page become ready in a wait for readiness, through the adapter', async () => {
    const t = replaying();
    const result = await t.run([{ do: 'wait', until: 'ready', seconds: 4 }, { do: 'read', form: 'outline' }]);
    expect(JSON.stringify(result)).toContain('observed document readiness');
    expect(new Set(t.requests.map(r => r.idempotency_key)).size).toBe(t.requests.length);
  });

  it('sends no navigation after the run is cancelled during a read', async () => {
    const abort = new AbortController();
    const t = batch(() => abort.abort(new Error('owner stopped')));
    await expect(withRunAbortContext({ run_id: 'collect-run', signal: abort.signal }, t.run)).rejects.toThrow();
    expect(t.requests.map(r => r.action)).toEqual(['reread']);
  });
});
