import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { chromePageTabs, pageIdentity, type PageTabsChrome } from '../actions/page-tabs.js';
import type { DocumentScripting } from '../actions/reviewed-document.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
type Mode = 'off-scope' | 'owner-dom-ready' | 'normal';
type Failure = 'none' | 'rejected' | 'ack-lost';

// Real executor, tab lifecycle and identity function. DOM, Chrome APIs and
// clock are adapters; no real browser requests or tab removal occur.
const runOpen = async (mode: Mode, failure: Failure) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
  const requested = 'https://app.example.com/open';
  const landed = mode === 'off-scope' ? 'https://outside.example/landing'
    : mode === 'owner-dom-ready' ? 'https://app.example.com/client' : requested;
  const openTabs = new Set([7]);
  const removals: number[] = [];
  let created = 0;
  vi.stubGlobal('document', { title: 'Fixture', readyState: 'complete', body: {}, documentElement: {
    hasAttribute: (name: string) => name === 'data-recued-owner-surface' && mode === 'owner-dom-ready' } });
  vi.stubGlobal('location', { href: landed });
  const tabs: PageTabsChrome = {
    async query() { return [...openTabs].map(id => ({ id, url: id === 7 ? 'https://recued.example/client' : landed })); },
    async create() { created++; openTabs.add(9); return { id: 9 }; },
    async get(id) {
      if (!openTabs.has(id)) throw new Error('Tab closed');
      return { id, status: mode === 'owner-dom-ready' ? 'loading' : 'complete',
        url: id === 7 ? 'https://recued.example/client' : landed };
    },
    async remove(id) {
      removals.push(id);
      if (failure === 'rejected') throw new Error('Removal request rejected');
      openTabs.delete(id);
      if (failure === 'ack-lost') throw new Error('Removal acknowledgement lost');
    },
  };
  const scripting: DocumentScripting = {
    async executeScript({ target, func, args }) {
      expect(target.tabId).toBe(9); expect(func).toBe(pageIdentity);
      return [{ documentId: 'DOC9', result: await func(...args) }];
    },
  };
  const native = chromePageTabs(tabs, scripting, async ms => { vi.setSystemTime(Date.now() + ms); });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; }, openPage: native.openPage,
  };
  const command: BridgeCommand = {
    command_id: 'open', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://app.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'open_tab', target_domain_pattern: 'https://app.example.com/*',
    args: { url: requested, ...(mode === 'owner-dom-ready' ? { dom_ready: true } : {}) },
    expects_output_keys: ['page', 'url', 'title', 'loading'], timeout_ms: 10_000, idempotency_key: 'open',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'open_tab', command, cancel: { signalled: false } });
  return { outcome, created, removals, openTabs: [...openTabs].sort() };
};

describe('automatic cleanup of a newly opened tab', () => {
  for (const mode of ['off-scope', 'owner-dom-ready'] as const) {
    it.each(['rejected', 'ack-lost'] as const)(`keeps ${mode} cleanup with %s uncertain without retrying`, async failure => {
      const t = await runOpen(mode, failure);
      expect(t.created).toBe(1); expect(t.removals).toEqual([9]);
      expect(t.openTabs).toEqual(failure === 'rejected' ? [7, 9] : [7]);
      expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
      expect(t.outcome.outputs).toBeUndefined();
    });

    it(`preserves confirmed ${mode} cleanup of only the newly created tab`, async () => {
      const t = await runOpen(mode, 'none');
      expect(t.created).toBe(1); expect(t.removals).toEqual([9]); expect(t.openTabs).toEqual([7]);
      expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
      expect(t.outcome.outputs).toBeUndefined();
    });
  }

  it('preserves an ordinary open without cleanup', async () => {
    const t = await runOpen('normal', 'none');
    expect(t.created).toBe(1); expect(t.removals).toEqual([]); expect(t.openTabs).toEqual([7, 9]);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '9:DOC9', title: 'Fixture', url: 'https://app.example.com/open' } });
  });
});
