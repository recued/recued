import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_TABS_MAX, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { chromePageTabs, pageIdentity, type PageTabsChrome } from '../actions/page-tabs.js';
import type { DocumentScripting } from '../actions/reviewed-document.js';

afterEach(() => vi.unstubAllGlobals());
type Mode = 'query-rejected' | 'empty' | 'populated' | 'filtered-empty' | 'filtered-partial' | 'blocked' | 'truncated';
const PATTERN = 'https://app.example.com/*';
const page = (id: number) => ({ page: `${id}:DOC${id}`, url: `https://app.example.com/${id}`, title: `Tab ${id}` });

// Real executor, tab listing and identity function. DOM and Chrome APIs are
// adapters; no real browser, network requests or tab mutations occur.
const runList = async (mode: Mode) => {
  let current = 7;
  const state = { queries: 0, reads: [] as number[], creates: 0, removals: [] as number[] };
  const filtered = mode === 'filtered-empty' || mode === 'filtered-partial';
  vi.stubGlobal('document', { get title() { return `Tab ${current}`; }, readyState: 'complete', body: {}, documentElement: {
    hasAttribute: (name: string) => name === 'data-recued-owner-surface' && filtered && current === 7 } });
  vi.stubGlobal('location', { get href() {
    return filtered && current === 9 ? 'https://outside.example/landing' : `https://app.example.com/${current}`;
  } });
  const tabs: PageTabsChrome = {
    async query(options) {
      state.queries++; expect(options).toEqual({ url: PATTERN });
      if (mode === 'query-rejected') throw new Error('QUERY_FAILURE_DIAGNOSTIC_TOKEN');
      const ids = mode === 'empty' ? [] : mode === 'filtered-empty' ? [7, 8, 9] : mode === 'filtered-partial' ? [7, 8, 9, 10]
        : mode === 'truncated' ? Array.from({ length: BRIDGE_TABS_MAX + 1 }, (_, i) => i + 1) : [7];
      return ids.map(id => ({ id, url: `https://app.example.com/${id}` }));
    },
    async create() { state.creates++; return { id: 11 }; }, async remove(id) { state.removals.push(id); },
    async get() { throw new Error('No get expected'); },
  };
  const scripting: DocumentScripting = {
    async executeScript({ target, func, args }) {
      state.reads.push(target.tabId); current = target.tabId; expect(func).toBe(pageIdentity);
      if (filtered && current === 8) throw new Error('Cannot access contents of the page');
      return [{ documentId: `DOC${current}`, result: await func(...args) }];
    },
  };
  const native = chromePageTabs(tabs, scripting);
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; }, listPages: native.listPages,
    async blockedSites() { return mode === 'blocked' ? ['example.com'] : []; },
  };
  const command: BridgeCommand = {
    command_id: 'list', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: [PATTERN], domain_allowlist_signature: 'fixture' },
    action: 'list_tabs', target_domain_pattern: PATTERN, args: {},
    expects_output_keys: ['tabs', 'truncated'], timeout_ms: 10_000, idempotency_key: 'list',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'list_tabs', command, cancel: { signalled: false } });
  expect(state.queries).toBe(1); expect(state.creates).toBe(0); expect(state.removals).toEqual([]);
  return { outcome, state };
};

describe('tab enumeration failures and valid listing results', () => {
  it('returns a read error when enumeration fails, without claiming an empty list', async () => {
    const t = await runList('query-rejected');
    expect(t.state.reads).toEqual([]);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'unknown' } });
    expect(t.outcome.outputs).toBeUndefined();
  });

  it.each(['empty', 'filtered-empty', 'blocked'] as const)('preserves a successful %s list', async mode => {
    const t = await runList(mode);
    expect(t.state.reads).toEqual(mode === 'filtered-empty' ? [7, 8, 9] : []);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { tabs: [], truncated: false } });
  });

  it('preserves eligible tabs when other pages are owner, unreadable or off-scope', async () => {
    const t = await runList('filtered-partial');
    expect(t.state.reads).toEqual([7, 8, 9, 10]);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { tabs: [page(10)], truncated: false } });
  });

  it('preserves an ordinary populated list', async () => {
    const t = await runList('populated'); expect(t.state.reads).toEqual([7]);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { tabs: [page(7)], truncated: false } });
  });

  it('preserves the tab limit and truncation flag', async () => {
    const t = await runList('truncated');
    expect(t.state.reads).toEqual(Array.from({ length: BRIDGE_TABS_MAX }, (_, i) => i + 1));
    expect(t.outcome).toEqual({ status: 'ok', outputs: {
      tabs: Array.from({ length: BRIDGE_TABS_MAX }, (_, i) => page(i + 1)), truncated: true } });
  });
});
