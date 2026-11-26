/** D-335 slice AA — a read takes the page's address in place of its handle: the open tab showing
 *  it, the first listed, matched as a batch step's `url` is. A read never opens a tab, and a typing
 *  or a click never takes an address. Through the real DOM adapter, the Bridge a stub answering
 *  the tab list and the read; the toolkit's words for it are pinned by `browser-toolkit-pack.test.ts`. */

import { describe, expect, it, vi } from 'vitest';
import type { BridgeResult } from '@recued/contracts';
import type { ResolvedCall } from '@recued/ingredients';

import type { BridgeDispatcher, DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';
import { ADDRESS_NOT_REVIEWABLE_MESSAGE, createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import { withPreapprovalIo, type PreapprovalIoContext } from '../preapproval-io-context.js';

const ADA = { page: '7:DOC1', url: 'https://en.wikipedia.org/wiki/Ada_Lovelace', title: 'Ada Lovelace - Wikipedia' };
const HN = { page: '9:DOC2', url: 'https://news.ycombinator.com/', title: 'Hacker News' };
const ADA_AGAIN = { page: '11:DOC3', url: 'https://en.wikipedia.org/wiki/Ada_Lovelace#Work', title: 'Ada Lovelace - Wikipedia' };

const ok = (outputs: Record<string, unknown>): DispatchOutcome => ({ kind: 'completed', bridge_client_token_id: 'bridge-1',
  attempts: 1, result: { command_id: 'c', duration_ms: 3, bridge_version: '0.0.7', idempotency_key_seen: false, status: 'ok',
    outputs } as BridgeResult });

const harness = (open: Array<typeof ADA> = [HN, ADA, ADA_AGAIN]) => {
  const requests: DispatchRequest[] = [];
  const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
    requests.push(request);
    if (request.action === 'list_tabs') return ok({ tabs: open, truncated: false });
    const tab = open.find((t) => t.page === request.args.page) ?? { page: String(request.args.page), url: '', title: '' };
    if (request.action === 'wait_for_element') return ok({ ...tab, found: true, waited_ms: 5 });
    return ok({ ...tab, html: '<body><h1>Ada Lovelace</h1><p>See <a ref="e5">Babbage</a>.</p></body>', truncated: false });
  });
  const adapter = createBridgeDomAdapter({
    manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
    getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
    pageReads: createPageReadStore(),
  });
  const run = async (slug: string, input: Record<string, unknown>, risk_tier: 'read' | 'write' = 'read') => {
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === slug)!;
    const call: ResolvedCall = { slug, risk_tier, output: manifest.output, input: { target: '*://*/*', ...input },
      stepMeta: { recipe_id: slug, step_id: 'read', run_id: `run-${String(requests.length)}` } };
    return adapter(call).then((result) => ({ result: result as Record<string, unknown>, error: undefined }),
      (error: unknown) => ({ result: undefined, error: error as { code?: string; message?: string } }));
  };
  return { run, requests };
};

describe('D-335 slice AA — a read names its page by address', () => {
  it('an address reads the open tab showing it, the first listed: the tabs once, then the read on its handle', async () => {
    const { run, requests } = harness();
    const { result, error } = await run('dom-inspect', { page: 'https://en.wikipedia.org/wiki/Ada_Lovelace', form: 'outline' });
    expect(error).toBeUndefined();
    expect(requests.map((r) => [r.action, r.args.page])).toEqual([['list_tabs', undefined], ['inspect', ADA.page]]);
    // The answer names the tab it read, so the model can go on by its handle.
    expect(result).toMatchObject({ page: ADA.page, url: ADA.url, title: ADA.title });
    expect(String(result!.outline)).toContain('[link: Babbage](e5)');
  });

  it('matched as a batch step\'s url: www and a trailing slash aside', async () => {
    const { run, requests } = harness([HN]);
    await run('dom-inspect', { page: 'https://www.news.ycombinator.com/', form: 'outline' });
    expect(requests.at(-1)).toMatchObject({ action: 'inspect', args: { page: HN.page } });
  });

  it('a fragment names a view: a tab showing the page without it is not that view (v40)', async () => {
    // The v40 Bridge integration (11-26) matches tabs by destination, fragment kept (`browserDestinationsMatch`):
    // a fragment may select a different view in the same document, and reading the wrong view answers wrongly.
    const { run, requests } = harness([HN]);
    const { error } = await run('dom-inspect', { page: 'https://www.news.ycombinator.com#top', form: 'outline' });
    expect(error?.code).toBe('DOM_PAGE_NOT_MATCHING');
    expect(requests.map((r) => r.action)).toEqual(['list_tabs']);
  });

  it('a wait names its page by address too, and waits on that tab', async () => {
    const { run, requests } = harness();
    const { result } = await run('dom-wait', { page: 'https://news.ycombinator.com/', selector: '.titleline' });
    // Then the page is read again for what changed (slice T), on the same tab.
    expect(requests.map((r) => [r.action, r.args.page])).toEqual([['list_tabs', undefined], ['wait_for_element', HN.page],
      ['reread', HN.page]]);
    expect(result).toMatchObject({ found: true, page: HN.page });
  });

  it('no tab shows it: the read opens none, says so and names the recipe that does', async () => {
    const { run, requests } = harness([HN]);
    const { error } = await run('dom-inspect', { page: 'https://en.wikipedia.org/wiki/Ada_Lovelace', form: 'text' });
    expect(error?.code).toBe('DOM_PAGE_NOT_MATCHING');
    // Opening a page asks nothing since 2026-11-23, so the correction no longer says it does.
    expect(error?.message).toBe('No open tab shows https://en.wikipedia.org/wiki/Ada_Lovelace, and a read opens none: open it with '
      + 'Open a web page, then read it by its address or the handle that answers');
    expect(requests.map((r) => r.action)).toEqual(['list_tabs']);
  });

  it('a handle reads as before, with no listing', async () => {
    const { run, requests } = harness();
    await run('dom-inspect', { page: ADA.page, form: 'outline' });
    expect(requests.map((r) => r.action)).toEqual(['inspect']);
  });

  it('a typing or a click is refused an address before any Bridge is asked, saying how to get the handle', async () => {
    const { run, requests } = harness();
    const click = await run('dom-click', { page: 'https://news.ycombinator.com/', text: 'login' }, 'write');
    expect(click.error?.code).toBe('DOM_SELECTOR_MISSING');
    expect(click.error?.message).toBe("core.dom.click: 'page' is the handle a read answered, not an address: typing and clicks act "
      + 'only on the page their element was read from. Read the page by its address first, then pass the handle it answers');
    const typed = await run('dom-write', { page: 'https://news.ycombinator.com/', ref: 'e3', value: 'hello' }, 'write');
    expect(typed.error?.message).toMatch(/^core\.dom\.write: 'page' is the handle a read answered, not an address/);
    expect(requests).toEqual([]);
  });

  it('in a run reviewed before it starts, an address is refused: which tab shows it is known only when it runs', async () => {
    const { run, requests } = harness();
    const refused = await withPreapprovalIo({} as PreapprovalIoContext,
      () => run('dom-inspect', { page: 'https://news.ycombinator.com/', form: 'outline' }));
    expect(refused.error).toMatchObject({ code: 'ROLE_RESTRICTION', message: ADDRESS_NOT_REVIEWABLE_MESSAGE });
    expect(requests).toEqual([]);
  });
});

describe('D-335 slice AG — two reads run side by side that open one page', () => {
  it('open it once: the second opening of an address while the first opens answers the tab the first opened', async () => {
    const opened = { page: '21:NEW1', url: 'https://example.org/report', title: 'Report' };
    const requests: DispatchRequest[] = [];
    const dispatch = vi.fn<BridgeDispatcher['dispatch']>(async (request) => {
      requests.push(request);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return ok(opened);
    });
    const adapter = createBridgeDomAdapter({
      manifests: { get: (slug) => KERNEL_MANIFESTS.find((manifest) => manifest.slug === slug) ?? null },
      getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: vi.fn(() => false) }),
      pageReads: createPageReadStore(),
    });
    const manifest = KERNEL_MANIFESTS.find((m) => m.slug === 'dom-open')!;
    const open = (run_id: string) => adapter({ slug: 'dom-open', risk_tier: 'write', output: manifest.output,
      input: { target: '*://*/*', address: 'https://example.org/report' }, stepMeta: { recipe_id: 'r', step_id: 'opened', run_id } });
    const [first, second] = await Promise.all([open('run-a'), open('run-b')]);
    expect(requests.filter((r) => r.action === 'open_tab')).toHaveLength(1);
    expect(second).toEqual(first);
    // Once it has opened, a later opening is its own.
    await open('run-c');
    expect(requests.filter((r) => r.action === 'open_tab')).toHaveLength(2);
  });
});
