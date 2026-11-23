/** D-335 slice O — `core.dom.inspect` answering an outline, and a cut line or a search from what
 *  the server kept, through the real DOM adapter. The Bridge here is a stub answering the HTML
 *  `inspectPage` writes; the outline itself is pinned by `d-335-page-outline.test.ts`, and the
 *  real Bridge in real Chrome by `browser-toolkit-browser.test.ts`. */

import { describe, expect, it, vi } from 'vitest';
import { BRIDGE_PAGE_CHANGED_MESSAGE, bridgeElementChangedMessage, parseBrowserActSteps, type BridgeResult } from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';

import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import { createBridgeDomAdapter, isFindSelector, PAGE_CHANGED_NOTE, PAGE_CHANGES_CHARS, PAGE_END_NOTE, PAGE_FIND_CUT_NOTE, PAGE_HTML_READ,
  PAGE_OUTLINE_CUT_NOTE, PAGE_OUTLINE_READ, PAGE_READ_FRESH_MS, PAGE_TEXT_END_NOTE, PAGE_UNCHANGED_NOTE, PAGE_LOADING_NOTE } from '../bridges/dom-adapter.js';
import { createPageReadStore, PAGE_OUTLINE_PART_CHARS, type PageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { BROWSER_PAGE_OBSERVATION_CHARS, type BrowserPageObservation } from '../bridges/browser-page-observation.js';
import { withPreapprovalIo, type PreapprovalIoContext } from '../preapproval-io-context.js';

const PAGE = '7:DOC1';
const retainedData = { read_ranges: expect.any(Array), data_ref: expect.stringMatching(/^data:[a-f0-9-]{36}$/), data_fields: expect.any(Array),
  data_format: 'lines', data_source_complete: true, data_scope: 'captured_page', data_hint: expect.any(Object) };
const URL_ = 'https://en.example.org/wiki/Ada';
const LONG = 'Lovelace wrote the first program for the Analytical Engine. '.repeat(3).trim();
/** Its line in the outline, cut in its middle (slice AU): its start, `…`, its end, then its block. */
const LONG_CUT = 'Lovelace wrote the first program for the Analytical Engine.…first program for the Analytical Engine.…(b1)';
const HTML = `<body><h1>Ada Lovelace</h1><p>${LONG}</p><p>See <a ref="e5" href="https://x.org/b">Babbage</a>.</p></body>`;

const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
  attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.7', idempotency_key_seen: false, status: 'ok',
    outputs } as BridgeResult });
const page = (html = HTML, truncated = false) => ok({ page: PAGE, url: URL_, title: 'Ada Lovelace - Wikipedia', html, truncated });

const harness = (answer: DispatchOutcome | ((request: DispatchRequest) => DispatchOutcome) = page(),
  store: PageReadStore = createPageReadStore()) => {
  const requests: DispatchRequest[] = [];
  const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
    requests.push(request);
    return typeof answer === 'function' ? answer(request) : answer;
  });
  const adapter = createBridgeDomAdapter({
    manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
    pageReads: store,
  });
  const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-inspect')!;
  const inspect = async (input: Record<string, unknown>) => {
    const call: ResolvedCall = { slug: 'dom-inspect', risk_tier: 'read', output: manifest.output,
      input: { target: '*://*/*', ...input }, stepMeta: { recipe_id: 'inspect-web-page', step_id: 'inspect', run_id: `run-${String(requests.length)}` } };
    return adapter(call).then((result) => ({ result: result as Record<string, unknown>, error: undefined }),
      (error: unknown) => ({ result: undefined, error: error as { code?: string; message?: string } }));
  };
  /** Any other op through the same adapter (a click, typing). */
  const run = async (slug: string, input: Record<string, unknown>) => {
    const other = KERNEL_MANIFESTS.find((m) => m.slug === slug)!;
    return adapter({ slug, risk_tier: 'write', output: other.output, input: { target: '*://*/*', ...input },
      stepMeta: { recipe_id: slug, step_id: 'act', run_id: `run-${String(requests.length)}` } });
  };
  return { inspect, run, requests, store };
};

describe('browser read continuation arguments', () => {
  it('continues an element in its own line space without widening to the full page', async () => {
    const html = '<section id="part"><h2>Selected</h2>' + Array.from({ length: 6 }, (_, i) => `<p>Region ${i}: ${'x'.repeat(40)}</p>`).join('')
      + '<p>REGION_TAIL</p></section>';
    const { inspect, run, requests, store } = harness(request => page(request.args.selector === '#part' ? html : '<main><p>OUTSIDE_ONLY</p></main>'));
    await inspect({ page: PAGE, form: 'outline' });
    const whole = store.dataSnapshot(PAGE);
    const first = (await inspect({ page: PAGE, selector: '#part', form: 'outline', chars: 100 })).result!;
    expect(first).toMatchObject({ complete: false, next_read: { page: PAGE, selector: '#part', form: 'outline', from: expect.any(Number), chars: 100 },
      next_step: { do: 'read', selector: '#part', form: 'outline' }, read_state: { scope: { kind: 'element', selector: '#part' } } });
    expect(String(first.outline)).not.toContain('OUTSIDE_ONLY');
    let part = first;
    for (let i = 0; i < 10 && part.next_read; i++) part = (await inspect(part.next_read as Record<string, unknown>)).result!;
    expect(part).toMatchObject({ complete: true });
    expect(String(part.outline)).toContain('REGION_TAIL');
    expect(String(part.outline)).toContain('End of the selected element');
    expect(store.dataSnapshot(PAGE)).toEqual(whole);
    expect(requests.slice(1).every(request => request.args.selector === '#part')).toBe(true);
    const batch = await run('dom-act', { page: PAGE, steps: [first.next_step] }) as { tabs: Array<{ reads: Array<Record<string, unknown>> }> };
    expect(batch.tabs[0]!.reads[0]).toMatchObject({ read_state: { scope: { kind: 'element', selector: '#part' } } });
    expect(String(batch.tabs[0]!.reads[0]!.outline)).not.toContain('OUTSIDE_ONLY');
  });

  it('continues a partial text section with standalone arguments and a valid batch step', async () => {
    const html = '<main><h2>Codes</h2>' + Array.from({ length: 30 }, (_, i) =>
      `<p>Entry ${i}: ${'long section content '.repeat(40)}</p>`).join('')
      + '<p>TAIL_SENTINEL</p><h2>Other section</h2><p>Done.</p></main>';
    const { inspect, run } = harness(page(html));
    const first = (await inspect({ page: PAGE, form: 'text', find: 'Codes' })).result!;
    expect(first).toMatchObject({ complete: false, truncated: false, next: expect.any(Number),
      next_read: { page: PAGE, from: first.next, find: '' },
      next_step: { do: 'read', page: PAGE, form: 'text', from: first.next } });
    expect(String(first.text)).not.toContain('TAIL_SENTINEL');
    const continued = (await inspect({ ...(first.next_read as Record<string, unknown>), form: 'text' })).result!;
    expect(continued).toMatchObject({ complete: true, truncated: false });
    expect(String(continued.text)).toContain('TAIL_SENTINEL');
    expect(continued.next_read).toBeUndefined();
    const parsed = parseBrowserActSteps([first.next_step]);
    expect(parsed.ok).toBe(true);
    const batch = await run('dom-act', { page: PAGE, steps: [first.next_step] }) as {
      tabs: Array<{ reads: Array<{ text: string; complete: boolean }> }>;
    };
    expect(batch.tabs[0]!.reads[0]).toMatchObject({ complete: true });
    expect(batch.tabs[0]!.reads[0]!.text).toContain('TAIL_SENTINEL');
  });

  it('does not claim a loading or source-cut read is complete or invent a cursor past its end', async () => {
    for (const state of [{ loading: true, truncated: false }, { truncated: true }]) {
      const { inspect } = harness(ok({ page: PAGE, url: URL_, title: 'Codes', html: '<h2>Codes</h2><p>Only captured content.</p>', ...state }));
      const result = (await inspect({ page: PAGE, form: 'text', find: 'Codes' })).result!;
      expect(result).toMatchObject({ complete: false });
      expect(result.next).toBeUndefined();
      expect(result.next_read).toBeUndefined();
      expect(result.next_step).toBeUndefined();
    }
  });

  it('marks omitted text sections incomplete even when the character budget fits', async () => {
    const html = '<main>' + Array.from({ length: 4 }, (_, i) => `<h2>Group ${i}</h2><p>Body ${i}</p>`).join('') + '</main>';
    const { inspect } = harness(page(html));
    const result = (await inspect({ page: PAGE, form: 'text', find: 'Group' })).result!;
    expect(result).toMatchObject({ sections: 3, complete: false, next_read: { page: PAGE, find: '' } });
    expect(String(result.text)).not.toContain('Body 3');
    const tail = (await inspect({ ...(result.next_read as Record<string, unknown>), form: 'text' })).result!;
    expect(String(tail.text)).toContain('Body 3');
  });
});

describe('D-335 slice O — an inspection answers an outline when asked, and HTML as before when not', () => {
  it('labels a loading snapshot and refreshes it for a search even when the read is recent', async () => {
    let loaded = false;
    const { inspect, requests, store } = harness(() => ok({ page: PAGE, url: URL_, title: 'Ada',
      html: loaded ? HTML + '<p>Later content</p>' : HTML, truncated: false, ...(!loaded ? { loading: true } : {}) }));
    const initial = (await inspect({ page: PAGE, form: 'outline' })).result!;
    expect(initial).toMatchObject({ loading: true, note: PAGE_LOADING_NOTE });
    expect(String(initial.outline)).toContain(PAGE_LOADING_NOTE);
    expect(store.age(PAGE)).toBe(Infinity);
    expect(store.controls(PAGE)).toBeUndefined();
    loaded = true;
    const found = (await inspect({ page: PAGE, find: 'Later', form: 'text' })).result!;
    expect(requests).toHaveLength(2);
    expect(String(found.text)).toContain('Later content');
    expect(found.loading).toBeUndefined();
    expect(store.age(PAGE)).toBeLessThan(PAGE_READ_FRESH_MS);
  });

  it('a scoped read cannot make a previously loading whole-page snapshot fresh', async () => {
    const { inspect, store } = harness(request => ok({ page: PAGE, url: URL_, title: 'Ada', html: HTML,
      truncated: false, loading: request.args.selector === undefined }));
    await inspect({ page: PAGE, form: 'outline' });
    const scoped = (await inspect({ page: PAGE, selector: '#part', form: 'outline' })).result!;
    expect(scoped).toMatchObject({ complete: true, read_state: { loading: false, scope: { kind: 'element', selector: '#part' } } });
    expect(store.age(PAGE)).toBe(Infinity);
  });

  it('reads the page through the Bridge as ever, and answers the outline in place of the HTML', async () => {
    const { inspect, requests } = harness();
    const { result } = await inspect({ page: PAGE, form: 'outline' });
    // The Bridge gets the inspect it always did, now naming how much to read (slice P): the whole
    // page, since the outline is the server's to cut down.
    expect(requests.map((r) => [r.action, r.args])).toEqual([['inspect', { page: PAGE, max_chars: 600_000, max_value_chars: 20_000 }]]);
    expect(result).toEqual({ ...retainedData, page: PAGE, url: URL_, title: 'Ada Lovelace - Wikipedia', truncated: false,
      complete: true,
      extraction_targets: { source: 'captured_dom', scope: 'page', source_complete: true, tables_complete: true, tables: [] },
      read_state: { source: 'bridge_read', scope: { kind: 'page', form: 'outline' }, loading: 'unknown', complete: true, truncated: false },
      field_evidence: expect.objectContaining({ scope: 'page', complete: true }),
      interaction_targets: expect.objectContaining({ captured_editable_fields: 0, captured_clickable_controls: 1 }),
      outline: `# Ada Lovelace\n${LONG_CUT}\nSee [link: Babbage](e5).\n${PAGE_END_NOTE}` });
  });

  it('without form, a recipe written before the outline gets the HTML it reads, as much as it always did', async () => {
    const { inspect, requests } = harness();
    expect((await inspect({ page: PAGE })).result).toEqual({ page: PAGE, url: URL_, title: 'Ada Lovelace - Wikipedia', html: HTML, truncated: false });
    expect((await inspect({ page: PAGE, form: 'html' })).result).toMatchObject({ html: HTML });
    // HTML goes to a model as it is, so it reads 40,000 characters, 2,000 of one text, as before.
    expect(requests.map((r) => r.args)).toEqual([{ page: PAGE, max_chars: 40_000, max_value_chars: 2_000 },
      { page: PAGE, max_chars: 40_000, max_value_chars: 2_000 }]);
    expect(PAGE_HTML_READ).toEqual({ max_chars: 40_000, max_value_chars: 2_000 });
  });

  // A Bridge before 0.0.8 reads 40,000 characters whatever it is asked, and says it cut the page.
  it('a page the Bridge cut says so at its end', async () => {
    const { inspect } = harness(page(HTML, true));
    const { result } = await inspect({ page: PAGE, form: 'outline' });
    expect(result).toMatchObject({ truncated: true });
    expect(String(result!.outline).split('\n').at(-1)).toBe(PAGE_OUTLINE_CUT_NOTE);
  });
});

describe('D-335 slice O — block and find answer from what was kept, without the Bridge', () => {
  it('a block answers its line in full; a missing block reports its absence without another read', async () => {
    const { inspect, requests } = harness();
    await inspect({ page: PAGE, form: 'outline' });
    expect((await inspect({ page: PAGE, block: 'b1' })).result).toEqual({ page: PAGE, url: URL_,
      title: 'Ada Lovelace - Wikipedia', block: 'b1', text: LONG,
      read_state: { source: 'kept_snapshot', scope: { kind: 'block', form: 'outline', block: 'b1' }, loading: 'unknown', complete: 'unknown', truncated: 'unknown' } });
    const missing = await inspect({ page: PAGE, block: 'b9' });
    expect(missing.error?.code).toBe('DOM_SELECTOR_NOT_FOUND');
    expect(missing.error?.message).toBe('core.dom.inspect: no retained block b9 exists for this page.');
    expect(requests).toHaveLength(1);
  });

  it('find answers every line holding the text from the kept read; with none kept, it reads the whole page once first', async () => {
    const { inspect, requests } = harness();
    const first = await inspect({ page: PAGE, find: 'babbage' });
    expect(first.result).toEqual({ ...retainedData, page: PAGE, url: URL_, title: 'Ada Lovelace - Wikipedia', find: 'babbage', matches: 1,
      read_state: { source: 'kept_snapshot', scope: { kind: 'search', form: 'outline', find: 'babbage' }, loading: 'unknown', complete: true, truncated: false },
      lines: 'line 3: See [link: Babbage](e5).   (under "Ada Lovelace")', truncated: false, complete: true });
    expect(requests.map((r) => [r.action, r.args])).toEqual([['inspect', { page: PAGE, ...PAGE_OUTLINE_READ }]]);
    const again = await inspect({ page: PAGE, find: 'Analytical' });
    expect(again.result).toMatchObject({ matches: 1 });
    expect(requests).toHaveLength(1);
  });

  it('a read of one part is kept, but find reads the whole page before it searches', async () => {
    const { inspect, requests } = harness();
    await inspect({ page: PAGE, selector: '#content', form: 'outline' });
    await inspect({ page: PAGE, find: 'Babbage' });
    expect(requests.map((r) => r.args)).toEqual([{ page: PAGE, selector: '#content', ...PAGE_OUTLINE_READ }, { page: PAGE, ...PAGE_OUTLINE_READ }]);
  });

  it('in a run reviewed before it starts, find needs a page already inspected: it sends nothing it did not prepare', async () => {
    const { inspect, requests } = harness();
    const refused = await withPreapprovalIo({} as PreapprovalIoContext, () => inspect({ page: PAGE, find: 'Babbage' }));
    expect(refused.error?.code).toBe('ROLE_RESTRICTION');
    expect(requests).toEqual([]);
  });

  it('refuses what cannot be answered, before anything is sent', async () => {
    const { inspect, requests } = harness();
    const messages = await Promise.all([
      inspect({ page: PAGE, block: 'b1', find: 'x' }),
      inspect({ page: PAGE, find: 'x', from: 3 }),
      inspect({ page: PAGE, block: 'b1', ref: 'e5' }),
      inspect({ page: PAGE, from: '4', selector: 'main' }),
      inspect({ block: 'b1' }),
      inspect({ from: 3 }),
      inspect({ page: PAGE, from: 'next' }),
      inspect({ page: PAGE, from: -2 }),
      inspect({ page: PAGE, form: 'markdown' }),
    ]).then((all) => all.map(({ error }) => error?.message));
    expect(messages).toEqual([
      expect.stringContaining('To continue, clear find and block and pass from alone'),
      expect.stringContaining('To continue, clear find and block and pass from alone'),
      'core.dom.inspect: give ref or selector, without block or find; from continues within that element',
      'core.dom.inspect: from within an element needs form outline or text',
      'core.dom.inspect: a block needs the page it reads: pass the page handle the outline answered',
      'core.dom.inspect: from needs the page it reads: pass the page handle the outline answered',
      "core.dom.inspect: 'from' is a line number, such as 213",
      "core.dom.inspect: 'from' is a line number, such as 213",
      "core.dom.inspect: 'form' is outline, text or html",
    ]);
    expect(requests).toEqual([]);
  });
});

describe('D-335 slice P — the whole page, answered in parts, read on from the line each part names', () => {
  const ROWS = 3_000;
  const LONG_PAGE = `<body><main>${Array.from({ length: ROWS }, (_, i) => `<p>Paragraph ${String(i + 1)} of the long page.</p>`).join('')}</main></body>`;

  it('answers the first part with where the next starts; from reads on without the Bridge; the last part ends the page', async () => {
    const { inspect, requests } = harness(page(LONG_PAGE));
    const first = (await inspect({ page: PAGE, form: 'outline' })).result!;
    const outline = String(first.outline);
    expect(outline.length).toBeLessThanOrEqual(PAGE_OUTLINE_PART_CHARS + 200);
    const next = first.next as number;
    expect(outline.split('\n').at(-1)).toBe(`(Lines 1 to ${String(next - 1)} of ${String(ROWS)}. Read on with from ${String(next)}, or look for a text with find.)`);
    const second = (await inspect({ page: PAGE, from: next })).result!;
    expect(String(second.outline).startsWith(`Paragraph ${String(next)} of the long page.`)).toBe(true);
    expect(second).toMatchObject({ page: PAGE, url: URL_, truncated: false, next: expect.any(Number) });
    // A recipe's 0, or text holding a number, reads the same way.
    expect((await inspect({ page: PAGE, from: String(next) })).result).toEqual(second);
    const last = (await inspect({ page: PAGE, from: ROWS })).result!;
    expect(last).toEqual({ ...retainedData, page: PAGE, url: URL_, title: 'Ada Lovelace - Wikipedia',
      read_state: { source: 'kept_snapshot', scope: { kind: 'page_part', form: 'outline', from: ROWS }, loading: 'unknown', complete: true, truncated: false },
      outline: `Paragraph ${String(ROWS)} of the long page.\n${PAGE_END_NOTE}`, truncated: false, complete: true });
    const past = await inspect({ page: PAGE, from: ROWS + 1 });
    expect(past.error?.message).toBe(`core.dom.inspect: the outline of this page has ${String(ROWS)} lines, so from ${String(ROWS + 1)} is past its end`);
    expect(requests).toHaveLength(1);
  });

  it('find searches the whole page and names each line, so from can read on there', async () => {
    const { inspect, requests } = harness(page(LONG_PAGE));
    const found = (await inspect({ page: PAGE, find: 'Paragraph 2999 ' })).result!;
    expect(found).toMatchObject({ matches: 1, lines: 'line 2999: Paragraph 2999 of the long page.' });
    expect(String((await inspect({ page: PAGE, from: 2999 })).result!.outline).startsWith('Paragraph 2999 of')).toBe(true);
    expect(requests.map((r) => r.args)).toEqual([{ page: PAGE, ...PAGE_OUTLINE_READ }]);
  });

  it('with nothing kept, from reads the whole page once first; a run reviewed before it starts needs an inspection first', async () => {
    const { inspect, requests } = harness(page(LONG_PAGE));
    const refused = await withPreapprovalIo({} as PreapprovalIoContext, () => inspect({ page: PAGE, from: 5 }));
    expect(refused.error?.code).toBe('ROLE_RESTRICTION');
    expect(requests).toEqual([]);
    expect(String((await inspect({ page: PAGE, from: 5 })).result!.outline).startsWith('Paragraph 5 of')).toBe(true);
    expect(requests.map((r) => r.args)).toEqual([{ page: PAGE, ...PAGE_OUTLINE_READ }]);
  });

  // Live, 2026-11-05, Bridge 0.0.7 on this server: find saw only the contents entry of a section
  // past the cut, and the model tried from 250 and from 200 on an outline of 81 lines.
  it('on a page the Bridge cut, find and a from past the end say the read stopped there, and how to read on', async () => {
    const { inspect } = harness(page(HTML, true));
    const found = (await inspect({ page: PAGE, find: 'babbage' })).result!;
    expect(String(found.lines).split('\n')).toEqual(['line 3: See [link: Babbage](e5).   (under "Ada Lovelace")', PAGE_FIND_CUT_NOTE]);
    expect((await inspect({ page: PAGE, find: 'See also' })).result).toMatchObject({ matches: 0, lines: PAGE_FIND_CUT_NOTE });
    const past = await inspect({ page: PAGE, from: 9 });
    expect(past.error?.message).toBe('core.dom.inspect: the outline of this page has 3 lines, so from 9 is past its end. The Browser Bridge '
      + 'read no further: Read a later part with Read part of a web page by a CSS selector, such as section:has(#History) for the section a '
      + 'contents link #History names.');
    expect(PAGE_FIND_CUT_NOTE).toContain('section:has(#History)');
  });

  it('a cut page says so after its last part, not before', async () => {
    const { inspect } = harness(page(LONG_PAGE, true));
    const first = (await inspect({ page: PAGE, form: 'outline' })).result!;
    expect(String(first.outline)).not.toContain(PAGE_OUTLINE_CUT_NOTE);
    const last = (await inspect({ page: PAGE, from: ROWS })).result!;
    expect(String(last.outline).split('\n').at(-1)).toBe(PAGE_OUTLINE_CUT_NOTE);
    expect(last.truncated).toBe(true);
  });
});

describe('D-335 slice Q — the page as text; a page that changed; an action on it', () => {
  const ARTICLE = `<body><nav><a ref="e1" href="https://x.org/">Home</a></nav><main><h1>Ada Lovelace</h1><p>${LONG}</p>`
    + '<p><img alt="Augusta Ada King, Countess of Lovelace, daguerrotype portrait circa 1843"> Daguerreotype</p>'
    + '<form><input ref="e2" aria-label="Search"></form></main></body>';

  it('form text reads the whole page and answers its main content as text, paragraphs and descriptions whole', async () => {
    const { inspect, requests } = harness(page(ARTICLE));
    const { result } = await inspect({ page: PAGE, form: 'text' });
    expect(requests.map((r) => r.args)).toEqual([{ page: PAGE, ...PAGE_OUTLINE_READ }]);
    expect(result).toEqual({ ...retainedData, page: PAGE, url: URL_, title: 'Ada Lovelace - Wikipedia', truncated: false, complete: true,
      extraction_targets: { source: 'captured_dom', scope: 'page', source_complete: true, tables_complete: true, tables: [] },
      read_state: { source: 'bridge_read', scope: { kind: 'page_text', form: 'text' }, loading: 'unknown', complete: true, truncated: false },
      field_evidence: expect.objectContaining({ scope: 'main', complete: true }),
      interaction_targets: expect.objectContaining({ captured_editable_fields: 1, captured_clickable_controls: 1 }),
      text: `# Ada Lovelace\n${LONG}\n[image: Augusta Ada King, Countess of Lovelace, daguerrotype portrait circa 1843] Daguerreotype\n`
        + PAGE_TEXT_END_NOTE });
  });

  it('a long text comes in parts, and from reads on in the text, on the outline\'s line numbers', async () => {
    const ROWS = 400;
    const paragraph = (i: number) => `Paragraph ${String(i)}: ${'a sentence of the long article. '.repeat(6)}`.trim();
    const { inspect, requests } = harness(page(`<body>${Array.from({ length: ROWS }, (_, i) => `<p>${paragraph(i + 1)}</p>`).join('')}</body>`));
    const first = (await inspect({ page: PAGE, form: 'text' })).result!;
    const next = first.next as number;
    expect(String(first.text).split('\n').at(-1)).toBe(`(Lines 1 to ${String(next - 1)} of ${String(ROWS)}. Read on with from ${String(next)}.)`);
    const second = (await inspect({ page: PAGE, form: 'text', from: next })).result!;
    expect(String(second.text).startsWith(`${paragraph(next)}\n`)).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('find and from answer from the kept read while it is fresh; a round later the page is read again, the same lines keeping their numbers', async () => {
    let now = 0;
    const { inspect, requests } = harness(page(HTML), createPageReadStore({ now: () => now }));
    await inspect({ page: PAGE, form: 'outline' });
    now = PAGE_READ_FRESH_MS - 1;
    await inspect({ page: PAGE, find: 'Babbage' });
    expect(requests).toHaveLength(1);
    now = PAGE_READ_FRESH_MS + 1;
    const again = (await inspect({ page: PAGE, find: 'Babbage' })).result!;
    expect(requests.map((r) => r.args)).toEqual([{ page: PAGE, ...PAGE_OUTLINE_READ }, { page: PAGE, ...PAGE_OUTLINE_READ }]);
    // Unchanged: no note, and the block the first read named still answers.
    expect(again.lines).toBe('line 3: See [link: Babbage](e5).   (under "Ada Lovelace")');
    expect((await inspect({ page: PAGE, block: 'b1' })).result).toMatchObject({ text: LONG });
  });

  it('a page that changed says so, and from goes on after the line read last, wherever it is now', async () => {
    let now = 0;
    const rows = (count: number) => Array.from({ length: count }, (_, i) => `<p>Row ${String(i + 1)}.</p>`).join('');
    let html = `<body>${rows(10)}</body>`;
    const { inspect, requests } = harness(() => page(html), createPageReadStore({ now: () => now }));
    await inspect({ page: PAGE, form: 'outline' });
    // Three rows come in at the top, as a feed's do, while the model reads.
    html = `<body><p>New A.</p><p>New B.</p><p>New C.</p>${rows(10)}</body>`;
    now = PAGE_READ_FRESH_MS + 1;
    const lines = String((await inspect({ page: PAGE, from: 6 })).result!.outline).split('\n');
    expect(lines.slice(0, 2)).toEqual([`${PAGE_CHANGED_NOTE.slice(0, -1)} This part goes on after the line read last, now line 8.)`, 'Row 6.']);
    expect(requests).toHaveLength(2);
    // A change that moved nothing before it says the page changed, and goes on where asked.
    html = `<body><p>New A.</p><p>New B.</p><p>New C.</p>${rows(10)}<p>Row 11.</p></body>`;
    now = 2 * PAGE_READ_FRESH_MS + 2;
    expect(String((await inspect({ page: PAGE, from: 9 })).result!.outline).split('\n').slice(0, 2)).toEqual([PAGE_CHANGED_NOTE, 'Row 6.']);
  });

  it('an action on the page ends the kept read at once; slice T reads it again for the action\'s answer', async () => {
    let html = HTML;
    const { inspect, run, requests } = harness((request) => request.action === 'click'
      ? ok({ clicked: true, page: PAGE, url: URL_, title: 'Ada Lovelace - Wikipedia' }) : page(html));
    await inspect({ page: PAGE, form: 'outline' });
    html = HTML.replace('Babbage', 'Charles Babbage');
    await run('dom-click', { page: PAGE, ref: 'e5' });
    // The read after the click is kept: a search answers from it, with nothing more sent.
    const found = (await inspect({ page: PAGE, find: 'Charles' })).result!;
    expect(String(found.lines).split('\n')).toEqual(['line 3: See [link: Charles Babbage](e5).   (under "Ada Lovelace")']);
    expect(requests.map((r) => r.action)).toEqual(['inspect', 'click', 'reread']);
  });

  it('in a run reviewed before it starts, an old read is answered from as it is: nothing it did not prepare is sent', async () => {
    let now = 0;
    const { inspect, requests } = harness(page(HTML), createPageReadStore({ now: () => now }));
    await inspect({ page: PAGE, form: 'outline' });
    now = PAGE_READ_FRESH_MS * 10;
    const found = await withPreapprovalIo({} as PreapprovalIoContext, () => inspect({ page: PAGE, find: 'Babbage' }));
    expect(found.result).toMatchObject({ matches: 1 });
    expect(requests).toHaveLength(1);
  });

  it('a block from a read the page has had since says the page changed', async () => {
    let now = 0;
    let html = HTML;
    const { inspect } = harness(() => page(html), createPageReadStore({ now: () => now }));
    await inspect({ page: PAGE, form: 'outline' });
    html = HTML.replace('<h1>', '<p>New.</p><h1>');
    now = PAGE_READ_FRESH_MS + 1;
    await inspect({ page: PAGE, find: 'x' });
    expect((await inspect({ page: PAGE, block: 'b1' })).error?.message).toBe('core.dom.inspect: b1 belongs to an earlier page observation and is no longer current.');
  });

  it('searches made together on a page that needs reading again wait for one read', async () => {
    let now = 0;
    const { inspect, requests } = harness(page(HTML), createPageReadStore({ now: () => now }));
    await inspect({ page: PAGE, form: 'outline' });
    now = PAGE_READ_FRESH_MS + 1;
    await Promise.all([inspect({ page: PAGE, find: 'Babbage' }), inspect({ page: PAGE, find: 'Lovelace' }), inspect({ page: PAGE, from: 2 })]);
    expect(requests).toHaveLength(2);
  });
});

// D-335 slice T — an action answers what it changed on the page, so a model need not spend a round
// inspecting the page again to see it.
describe('D-335 slice T — an action answers what changed on the page', () => {
  const clickAnswer = (handle = PAGE) => ok({ clicked: true, page: handle, url: URL_, title: 'Ada Lovelace - Wikipedia' });
  const failed = (): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1', attempts: 1,
    result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.7', idempotency_key_seen: false, status: 'error',
      error: { code: 'selector_not_found', message: 'The page has gone.' } } as BridgeResult });
  const changesOf = (answer: unknown) => String((answer as Record<string, unknown>).changes).split('\n');

  it('the new lines with their numbers and refs, what went, and the read kept for find and from', async () => {
    let html = HTML;
    const { inspect, run, requests } = harness((request) => request.action === 'click' ? clickAnswer() : page(html));
    await inspect({ page: PAGE, form: 'outline' });
    // A dialog opens in place of the link.
    html = HTML.replace('<p>See <a ref="e5" href="https://x.org/b">Babbage</a>.</p>',
      '<div role="dialog"><p>Delete this deal?</p><button ref="e9">Delete</button></div>');
    const clicked = await run('dom-click', { page: PAGE, ref: 'e5' }) as Record<string, unknown>;
    expect(changesOf(clicked)).toEqual([
      '(What changed on the page, numbered as it is now: 2 new lines, 1 line gone.)', 'line 3: Delete this deal?', 'line 4: [button: Delete](e9)',
      'gone: See [link: Babbage](e5).']);
    expect(clicked.page_observation).toMatchObject({ state: 'changed', page: PAGE, loading: false, source_truncated: false,
      changes: { added: [{ line: 3, text: 'Delete this deal?' }, { line: 4, text: '[button: Delete](e9)' }],
        removed: [{ text: 'See [link: Babbage](e5).' }], added_total: 2, removed_total: 1, complete: true } });
    // The whole page was read, as an outline reads it, after the click.
    expect(requests.at(-1)).toMatchObject({ action: 'reread', args: { page: PAGE, ...PAGE_OUTLINE_READ } });
    expect((await inspect({ page: PAGE, find: 'Delete' })).result).toMatchObject({ matches: 2 });
    expect(requests).toHaveLength(3);
  });

  it('nothing changed says so', async () => {
    const { inspect, run } = harness((request) => request.action === 'click' ? clickAnswer() : page());
    await inspect({ page: PAGE, form: 'outline' });
    const clicked = await run('dom-click', { page: PAGE, ref: 'e5' }) as Record<string, unknown>;
    expect(changesOf(clicked)).toEqual([PAGE_UNCHANGED_NOTE]);
    expect(clicked.page_observation).toMatchObject({ state: 'unchanged', loading: false });
  });

  it('a page the click loaded, or one never read, answers its first lines', async () => {
    const { run, requests } = harness((request) => request.action === 'click' ? clickAnswer('7:DOC2') : page());
    expect(changesOf(await run('dom-click', { page: PAGE, ref: 'e5' }))).toEqual(['(The page now, as Inspect a web page answers it: lines 1 to 3 of 3.)',
      '# Ada Lovelace', `${LONG_CUT}`, 'See [link: Babbage](e5).', PAGE_END_NOTE]);
    // The page read is the one the click answered.
    expect(requests.at(-1)).toMatchObject({ action: 'reread', args: { page: '7:DOC2', ...PAGE_OUTLINE_READ } });
  });

  it('adds exact fields from the destination read without another browser command or carrying the old page fields', async () => {
    let moved = false;
    const { inspect, run, requests } = harness(request => {
      if (request.action === 'click') { moved = true; return clickAnswer('7:DOC2'); }
      return moved ? ok({ page: '7:DOC2', url: 'https://example.org/portrait', title: 'Portrait', truncated: false,
        html: '<main><figure><img alt="Alternative description"><figcaption>Daguerreotype of Lovelace (c. 1843)</figcaption></figure></main>' })
        : page('<main><h1>Old page heading</h1><a ref="e5">Portrait</a></main>');
    });
    await inspect({ page: PAGE, form: 'outline' });
    const clicked = await run('dom-click', { page: PAGE, ref: 'e5' }) as { page_observation: BrowserPageObservation };
    expect(clicked.page_observation).toMatchObject({ state: 'snapshot', page: '7:DOC2', loading: false,
      range: { from: 1 }, field_evidence: { scope: 'main', complete: true } });
    expect(clicked.page_observation.field_evidence!.items.find(item => item.tag === 'img')!.fields).toEqual({
      alt: { value: 'Alternative description', source: 'alt' },
      caption: { value: 'Daguerreotype of Lovelace (c. 1843)', source: 'figcaption.textContent' },
    });
    expect(JSON.stringify(clicked.page_observation)).not.toContain('Old page heading');
    expect(requests.map(r => r.action)).toEqual(['inspect', 'click', 'reread']);
  });

  it('keeps loading and cut-source observations distinct from a complete settled field view', async () => {
    for (const loading of [true, false]) {
      const { run } = harness(request => request.action === 'click' ? clickAnswer()
        : ok({ page: PAGE, url: URL_, title: 'Partial', html: HTML, truncated: true, loading }));
      const clicked = await run('dom-click', { page: PAGE, ref: 'e5' }) as { page_observation: BrowserPageObservation };
      expect(clicked.page_observation).toMatchObject({ loading, source_truncated: true });
      if (loading) expect(clicked.page_observation.field_evidence).toBeUndefined();
      else expect(clicked.page_observation.field_evidence).toMatchObject({ complete: false, incomplete: ['page_truncated'] });
    }
  });

  it('a long change is cut, saying where to read on, and from reads on there from what was kept', async () => {
    let html = HTML;
    const { inspect, run, requests } = harness((request) => request.action === 'click' ? clickAnswer() : page(html));
    await inspect({ page: PAGE, form: 'outline' });
    const rows = Array.from({ length: 300 }, (_, i) => `<p>Row ${String(i + 1)} of a long list the click brought in.</p>`).join('');
    // The rows come in and the link goes: once the new lines are cut, the line that went is not listed after them.
    html = HTML.replace('<p>See <a ref="e5" href="https://x.org/b">Babbage</a>.</p>', '').replace('</body>', `${rows}</body>`);
    const answer = await run('dom-click', { page: PAGE, ref: 'e5' }) as { changes: string; page_observation: BrowserPageObservation };
    const changes = answer.changes;
    expect(JSON.stringify(answer.page_observation).length).toBeLessThanOrEqual(BROWSER_PAGE_OBSERVATION_CHARS);
    expect(answer.page_observation.changes).toMatchObject({ added_total: 300, removed_total: 1, complete: false,
      next_line: expect.any(Number) });
    const lines = changes.split('\n');
    expect(lines.slice(0, 2)).toEqual(['(What changed on the page, numbered as it is now: 300 new lines, 1 line gone.)',
      'line 3: Row 1 of a long list the click brought in.']);
    expect(lines.filter((line) => line.startsWith('gone:'))).toEqual([]);
    expect(changes.length).toBeLessThanOrEqual(PAGE_CHANGES_CHARS + 120);
    const next = /^\(…and \d+ more new lines: read them with Inspect a web page, from (\d+)\.\)$/.exec(lines.at(-1)!);
    expect(next, lines.at(-1)).not.toBeNull();
    const at = Number(next![1]);
    expect(lines.at(-2)).toBe(`line ${String(at - 1)}: Row ${String(at - 3)} of a long list the click brought in.`);
    const sent = requests.length;
    expect(String((await inspect({ page: PAGE, from: at })).result!.outline).split('\n')[0])
      .toBe(`Row ${String(at - 2)} of a long list the click brought in.`);
    expect(requests).toHaveLength(sent);
  });

  it('a line the page now shows twice is one new line: a text counts as often as it occurs', async () => {
    let html = HTML.replace('</body>', '<p>Posted just now.</p></body>');
    const { inspect, run } = harness((request) => request.action === 'click' ? clickAnswer() : page(html));
    await inspect({ page: PAGE, form: 'outline' });
    html = HTML.replace('</body>', '<p>Posted just now.</p><p>Posted just now.</p></body>');
    expect(changesOf(await run('dom-click', { page: PAGE, ref: 'e5' }))).toEqual([
      '(What changed on the page, numbered as it is now: 1 new line.)', 'line 5: Posted just now.']);
  });

  it('once the new lines are cut, no line that went is listed after them, though there is room for it', async () => {
    let html = HTML.replace('</body>', '<p>OK</p></body>');
    const { inspect, run } = harness((request) => request.action === 'click' ? clickAnswer() : page(html));
    await inspect({ page: PAGE, form: 'outline' });
    const rows = Array.from({ length: 100 }, (_, i) => `<p>Row ${String(i + 1)}: ${'a long line the click brought in, '.repeat(2)}</p>`).join('');
    html = HTML.replace('</body>', `${rows}</body>`);
    const lines = changesOf(await run('dom-click', { page: PAGE, ref: 'e5' }));
    expect(lines[0]).toBe('(What changed on the page, numbered as it is now: 100 new lines, 1 line gone.)');
    // The room left after the last new line that fits is more than "gone: OK" takes.
    expect(PAGE_CHANGES_CHARS - lines.slice(0, -1).join('\n').length).toBeGreaterThan('\ngone: OK'.length);
    expect(lines.filter((line) => line.startsWith('gone:'))).toEqual([]);
    expect(lines.at(-1)).toMatch(/^\(…and \d+ more new lines: read them with Inspect a web page, from \d+\.\)$/);
  });

  it('typing and a wait answer it too', async () => {
    const editable = HTML.replace('<a ref="e5" href="https://x.org/b">Babbage</a>', '<input ref="e5" aria-label="Search">');
    let html = editable;
    const { inspect, run } = harness((request) => request.action === 'fill' ? ok({ filled: true })
      : request.action === 'wait_for_element' ? ok({ page: PAGE, url: URL_, title: 'Ada Lovelace - Wikipedia', found: true, waited_ms: 5 })
        : page(html));
    await inspect({ page: PAGE, form: 'outline' });
    html = editable.replace('</body>', '<p>Saved.</p></body>');
    expect(changesOf(await run('dom-write', { page: PAGE, ref: 'e5', value: 'x' }))).toEqual([
      '(What changed on the page, numbered as it is now: 1 new line.)', 'line 4: Saved.']);
    html = editable.replace('</body>', '<p>Saved.</p><p>Synced.</p></body>');
    expect(changesOf(await run('dom-wait', { page: PAGE, selector: '#x' }))).toEqual([
      '(What changed on the page, numbered as it is now: 1 new line.)', 'line 5: Synced.']);
  });

  it('a Bridge before 0.0.8, which does not run reread, answers the action as before, and the next find reads the page', async () => {
    let html = HTML;
    const { inspect, run, requests } = harness((request) => request.action === 'click' ? clickAnswer()
      : request.action === 'reread' ? { kind: 'capacity_gap', capacity_gap: { kind: 'bridge_online' }, reason: 'bridge_update_required', attempts: 0 }
        : page(html));
    await inspect({ page: PAGE, form: 'outline' });
    html = HTML.replace('Babbage', 'Charles Babbage');
    const clicked = await run('dom-click', { page: PAGE, ref: 'e5' });
    expect(clicked).not.toHaveProperty('changes');
    expect(clicked).toHaveProperty('page_observation', { state: 'unavailable', requested_page: PAGE, reason: 'read_failed' });
    const found = (await inspect({ page: PAGE, find: 'Charles' })).result!;
    expect(String(found.lines).split('\n')[0]).toBe(PAGE_CHANGED_NOTE);
    expect(requests.map((r) => r.action)).toEqual(['inspect', 'click', 'reread', 'inspect']);
  });

  it('in a run reviewed before it starts, the answer is the action\'s alone: it sends no read it did not prepare', async () => {
    const { run, requests } = harness((request) => request.action === 'click' ? clickAnswer() : page());
    const reviewed = { prepareDomCommand: async () => ({}) } as unknown as PreapprovalIoContext;
    const clicked = await withPreapprovalIo(reviewed, () => run('dom-click', { page: PAGE, ref: 'e5' }));
    expect(clicked).not.toHaveProperty('changes');
    expect(requests.map((r) => r.action)).toEqual(['click']);
  });

  it('a page that cannot be read after the action leaves its answer as it was, and the next find reads it again', async () => {
    let html = HTML;
    let reads = 0;
    const { inspect, run, requests } = harness((request) => {
      if (request.action === 'click') return clickAnswer();
      reads += 1;
      return reads === 2 ? failed() : page(html);
    });
    await inspect({ page: PAGE, form: 'outline' });
    html = HTML.replace('Babbage', 'Charles Babbage');
    expect(await run('dom-click', { page: PAGE, ref: 'e5' })).not.toHaveProperty('changes');
    const found = (await inspect({ page: PAGE, find: 'Charles' })).result!;
    expect(String(found.lines).split('\n')).toEqual([PAGE_CHANGED_NOTE, 'line 3: See [link: Charles Babbage](e5).   (under "Ada Lovelace")']);
    expect(requests.map((r) => r.action)).toEqual(['inspect', 'click', 'reread', 'inspect']);
  });

  // D-347 follow-up 17 (2026-11-08) — a click refused because the page changed what its ref names since it was
  // read (its element gone, or showing something else): the page is read again, and what changed comes with the
  // refusal, so the model can act on the page as it is without a round to inspect it.
  const refusedWith = (message: string): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
    attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.8', idempotency_key_seen: false,
      status: 'error', error: { code: 'selector_not_found', message } } as BridgeResult });
  const clickRefused = async (answer: DispatchOutcome) => {
    let html = HTML;
    const { inspect, run, requests } = harness((request) => request.action === 'click' ? answer : page(html));
    await inspect({ page: PAGE, form: 'outline' });
    html = HTML.replace('Babbage</a>', 'Charles Babbage</a>');
    const error = await run('dom-click', { page: PAGE, ref: 'e5' }).then(() => undefined,
      (thrown: unknown) => thrown as { code?: string; message?: string; details?: { page_observation?: BrowserPageObservation } });
    return { error, actions: requests.map((r) => r.action) };
  };

  it('a click refused because the page changed what its ref names comes with what changed, read again', async () => {
    for (const message of [BRIDGE_PAGE_CHANGED_MESSAGE, bridgeElementChangedMessage('e5', '“Charles Babbage”', '“Babbage”')]) {
      const { error, actions } = await clickRefused(refusedWith(message));
      expect(error?.code).toBe('DOM_SELECTOR_NOT_FOUND');
      expect(String(error?.message).split('\n')).toEqual([message,
        '(What changed on the page, numbered as it is now: 1 new line, 1 line gone.)', 'line 3: See [link: Charles Babbage](e5).',
        'gone: See [link: Babbage](e5).']);
      expect(actions).toEqual(['inspect', 'click', 'reread']);
      expect(error?.details?.page_observation).toMatchObject({ state: 'changed', page: PAGE });
      expect(JSON.stringify(error?.details?.page_observation?.field_evidence)).toContain('Charles Babbage');
    }
  });

  it('any other refusal comes as it was, and nothing is read for it', async () => {
    const { error, actions } = await clickRefused(failed());
    expect(error?.message).toBe('The page has gone.');
    expect(actions).toEqual(['inspect', 'click']);
  });
});

// D-335 slice V — `chars` sizes one part, for Ask a web page, which sends it to a model of its own.
describe('D-335 slice V — a part of the size a caller asks for', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `<p>Row ${String(i + 1)} of a long page, with some words in it.</p>`).join('');
  const LONG_PAGE = `<body>${rows(3_000)}</body>`;

  it('a first part and a part from a line hold up to chars, where the text form holds 16,000', async () => {
    const { inspect } = harness(page(LONG_PAGE));
    const standard = (await inspect({ page: PAGE, form: 'text' })).result!;
    const sized = (await inspect({ page: PAGE, form: 'text', chars: 40_000 })).result!;
    expect(String(standard.text).length).toBeLessThanOrEqual(16_000 + 200);
    expect(String(sized.text).length).toBeGreaterThan(36_000);
    expect(String(sized.text).length).toBeLessThanOrEqual(40_000 + 200);
    expect(Number(sized.next)).toBeGreaterThan(Number(standard.next));
    const on = (await inspect({ page: PAGE, form: 'text', from: Number(sized.next), chars: 40_000 })).result!;
    expect(String(on.text).split('\n')[0]).toBe(`Row ${String(sized.next)} of a long page, with some words in it.`);
    expect(String(on.text).length).toBeGreaterThan(36_000);
  });

  it.each([
    [{ form: 'text', chars: 60_001 }, "'chars' is how many characters one part holds, at most 60000"],
    [{ form: 'text', chars: -5 }, "'chars' is how many characters one part holds"],
    [{ chars: 1_000 }, "'chars' sizes a part of the outline or the text"],
    [{ form: 'html', chars: 1_000 }, "'chars' sizes a part of the outline or the text"],
    [{ form: 'outline', find: 'Row', chars: 1_000 }, "'chars' sizes a part of the outline or the text"],
  ])('refuses chars it cannot use, before the Bridge is asked (%#)', async (input, message) => {
    const { inspect, requests } = harness(page(LONG_PAGE));
    const { error } = await inspect({ page: PAGE, ...input });
    expect(error?.code).toBe('DOM_SELECTOR_MISSING');
    expect(error?.message).toContain(message);
    expect(requests).toHaveLength(0);
  });
});

// D-335 slice AH — Read the text of a web page takes `find`: the section it names, whole, in place of
// a part of the page, so a section far down a long article is read in one call.
describe('D-335 slice AH — the text of one section', () => {
  it('outline heading reads retain returned form values past eight lines without another Bridge read', async () => {
    const html = '<main><h2>Submitted Values</h2>' + '<p>Other field</p>'.repeat(10)
      + '<p>checkboxes</p><ul><li>cb1</li><li>cb2</li></ul><p>radioval</p><p>rd3</p>'
      + '<h2>Editable form</h2><input ref="e9" value="different"></main>';
    const { inspect, requests } = harness(page(html));
    await inspect({ page: PAGE, form: 'outline' });
    const { result } = await inspect({ page: PAGE, find: 'Submitted Values' });
    expect(result).toMatchObject({ complete: true, truncated: false });
    for (const value of ['cb1', 'cb2', 'rd3']) expect(result!.lines).toContain(value);
    expect(result!.lines).not.toContain('Editable form');
    expect(requests).toHaveLength(1);
  });

  it('a bounded heading read exposes incompleteness and its next line through the adapter', async () => {
    const { inspect } = harness(page('<h2>Results</h2>'
      + Array.from({ length: 600 }, (_, i) => `<p>Result ${i}: ${'x'.repeat(40)}</p>`).join('')));
    const { result } = await inspect({ page: PAGE, find: 'Results' });
    expect(result).toMatchObject({ complete: false, truncated: false, next: expect.any(Number) });
    expect(result!.lines).toContain(`read on with from ${result!.next}`);
  });
  it('find with the text form answers the section under the heading it names, not the page from its top', async () => {
    const SECTIONS = '<body><main><h1>Ada Lovelace</h1><h2>Early life</h2><p>She was born in London in 1815.</p>'
      + '<h2>Work</h2><p>Her notes on Menabrea\'s paper hold the first published program, in Note G.</p>'
      + '<h2>Legacy</h2><p>Ada Lovelace Day is held each October.</p></main></body>';
    const { inspect } = harness(page(SECTIONS));
    const { result } = await inspect({ page: PAGE, form: 'text', find: 'Work' });
    const said = JSON.stringify(result);
    expect(said).toContain('Note G');
    expect(said).not.toContain('born in London');
    expect(said).not.toContain('held each October');
  });
});

// D-335 slice AJ — a text `find` answers each section under a heading that holds it, whole: a model
// asking about one section (Ask a web page) or reading it (Read the text) gets all of it, where the
// outline's find answers its first lines, each cut short.
describe('D-335 slice AJ — the sections a text find names, whole', () => {
  const PARAGRAPH = (n: number) => `Paragraph ${String(n)} of her work: ${'she wrote of the engine and what it could do. '.repeat(8).trim()}`;
  const ARTICLE = '<body><main><h1>Ada Lovelace</h1><h2>Early life</h2><p>She was born in London in 1815.</p>'
    + `<h2>Work</h2>${Array.from({ length: 12 }, (_, i) => `<p>${PARAGRAPH(i + 1)}</p>`).join('')}`
    + '<h3>First computer program</h3><p>Her notes on Menabrea\'s paper hold the first published program, in Note G.</p>'
    + '<h2>Legacy</h2><p>Ada Lovelace Day is held each October.</p></main></body>';

  it('answers the section from its heading to the next of its rank, every paragraph whole, its subsections in it', async () => {
    const { inspect } = harness(page(ARTICLE));
    const { result } = await inspect({ page: PAGE, form: 'text', find: 'Work' });
    expect(result).toMatchObject({ page: PAGE, find: 'Work', sections: 1, truncated: false });
    const text = String(result!.text);
    expect(text.split('\n')[0]).toBe('## Work');
    // Twelve paragraphs of 380 characters: the outline's find shows 8 lines, each cut at 300.
    expect(PARAGRAPH(12).length).toBeGreaterThan(300);
    for (let n = 1; n <= 12; n += 1) expect(text).toContain(PARAGRAPH(n));
    expect(text).toContain('### First computer program');
    expect(text).toContain('in Note G.');
    expect(text).not.toContain('born in London');
    expect(text).not.toContain('held each October');
    expect(result).not.toHaveProperty('next');
    // The outline's find is as it was: lines, with the heading's first ones.
    const lines = (await inspect({ page: PAGE, form: 'outline', find: 'Work' })).result!;
    expect(lines).toHaveProperty('lines');
    expect(lines).not.toHaveProperty('text');
  });

  it('holds up to chars, and a section cut short says the line to read on from', async () => {
    const { inspect } = harness(page(ARTICLE));
    const { result } = await inspect({ page: PAGE, form: 'text', find: 'Work', chars: 1_000 });
    const next = Number(result!.next);
    expect(next).toBeGreaterThan(0);
    expect(String(result!.text)).toContain(PARAGRAPH(2));
    expect(String(result!.text)).not.toContain(PARAGRAPH(3));
    expect(String(result!.text).split('\n').at(-1)).toBe(`(It goes on: read on with from ${String(next)}.)`);
    const on = (await inspect({ page: PAGE, form: 'text', from: next })).result!;
    expect(String(on.text).split('\n')[0]).toBe(PARAGRAPH(3));
  });

  it('with no heading holding the text, answers each paragraph that does, whole, under its heading', async () => {
    const { inspect } = harness(page(ARTICLE));
    const { result } = await inspect({ page: PAGE, form: 'text', find: 'menabrea' });
    expect(result).toMatchObject({ sections: 0, matches: 1,
      text: '(under "First computer program") Her notes on Menabrea\'s paper hold the first published program, in Note G.' });
  });

  it('says when no line of the page holds it', async () => {
    const { inspect } = harness(page(ARTICLE));
    const { result } = await inspect({ page: PAGE, form: 'text', find: 'Byron' });
    expect(result).toMatchObject({ matches: 0, sections: 0, text: '(No line of the page holds “Byron”.)' });
  });

  it('takes chars with a text find, and still refuses it with the outline\'s', async () => {
    const { inspect } = harness(page(ARTICLE));
    expect((await inspect({ page: PAGE, form: 'text', find: 'Legacy', chars: 2_000 })).result).toMatchObject({ sections: 1,
      text: '## Legacy\nAda Lovelace Day is held each October.' });
    const { error } = await inspect({ page: PAGE, form: 'outline', find: 'Legacy', chars: 2_000 });
    expect(error?.message).toContain('nor with find on the outline');
  });
});

// D-335 slice AL — the owner: "maybe the find can reference the css selector … so searching for
// keyword maybe partial but a whole section of the css selector is full picture, alternatively
// multiple keywords and return each text paragraph containing any of the keyword, or both".
describe('D-335 slice AL — find by several texts, a heading\'s #id, or an element\'s selector', () => {
  const ARTICLE = '<body><main><h1>Ada Lovelace</h1><h2 id="Early_work">Early work</h2><p>She studied under De Morgan.</p>'
    + '<h2 id="Work">Work</h2><p>Her work with Babbage began in 1833.</p>'
    + '<h3 id="First_computer_program">First computer program</h3><p>Her notes on Menabrea\'s paper hold Note G.</p>'
    + '<h2 id="Legacy">Legacy</h2><p>Ada Lovelace Day is held each October.</p></main></body>';
  const INFOBOX = '<body><table class="infobox"><tr><td>Born 10 December 1815, London</td></tr></table></body>';

  it('tells an element\'s CSS selector from a text', () => {
    for (const selector of ['.infobox', 'table.wikitable', 'section:has(#Work)', 'div > p', '#Work', '[data-section="work"]']) {
      expect(isFindSelector(selector), selector).toBe(true);
    }
    for (const text of ['Work', 'Early life', 'a calculus of the nervous system', 'Note: see below', 'Menabrea | Note G', 'table']) {
      expect(isFindSelector(text), text).toBe(false);
    }
  });

  it('several texts: the section a heading holding one starts, whole, and each paragraph holding another, in page order', async () => {
    const { inspect } = harness(page(ARTICLE));
    const { result } = await inspect({ page: PAGE, form: 'text', find: 'Legacy | menabrea' });
    expect(result).toMatchObject({ sections: 1, matches: 2,
      text: '(under "First computer program") Her notes on Menabrea\'s paper hold Note G.\n## Legacy\nAda Lovelace Day is held each October.' });
  });

  it('a heading\'s #id reads its section alone, where its text also matched another heading', async () => {
    const { inspect } = harness(page(ARTICLE));
    const byText = String((await inspect({ page: PAGE, form: 'text', find: 'Work' })).result!.text);
    expect(byText).toContain('She studied under De Morgan.');
    const { result } = await inspect({ page: PAGE, form: 'text', find: '#Work' });
    expect(result).toMatchObject({ sections: 1, text: '## Work\nHer work with Babbage began in 1833.\n### First computer program\n'
      + 'Her notes on Menabrea\'s paper hold Note G.' });
    // A paragraph inside a section asked for is read once, with it.
    const both = String((await inspect({ page: PAGE, form: 'text', find: 'Menabrea | #Work' })).result!.text);
    expect(both.split('Note G.').length - 1).toBe(1);
  });

  it('another CSS selector reads that element through the Bridge, whole, as text', async () => {
    const { inspect, requests } = harness((request) => page(request.args.selector === 'table.infobox' ? INFOBOX : ARTICLE));
    const { result } = await inspect({ page: PAGE, form: 'text', find: 'table.infobox' });
    expect(requests.map((r) => r.args.selector)).toEqual(['table.infobox']);
    expect(result).toMatchObject({ page: PAGE, find: 'table.infobox' });
    expect(String(result!.text)).toContain('Born 10 December 1815, London');
    expect(String(result!.text)).not.toContain('Babbage');
  });

  it('an #id no heading carries reads the element that carries it', async () => {
    const { inspect, requests } = harness((request) => page(request.args.selector === '#pricing'
      ? '<body><div id="pricing"><p>Team: 12 dollars a month.</p></div></body>' : ARTICLE));
    const { result } = await inspect({ page: PAGE, form: 'text', find: '#pricing' });
    expect(requests.map((r) => r.args.selector)).toEqual([undefined, '#pricing']);
    expect(String(result!.text)).toContain('Team: 12 dollars a month.');
  });

  it('the outline\'s find takes several texts too, answering lines', async () => {
    const { inspect } = harness(page(ARTICLE));
    const lines = String((await inspect({ page: PAGE, form: 'outline', find: 'De Morgan | Note G' })).result!.lines);
    expect(lines).toContain('She studied under De Morgan.');
    expect(lines).toContain('Note G.');
  });
});
