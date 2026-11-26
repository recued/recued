import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { measurePageArea } from '../actions/page-capture.js';
import { waitForQuiet } from '../actions/page-scroll.js';
import { pageIdentity } from '../actions/page-tabs.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
type Mode = 'off-host' | 'off-path' | 'off-scope-element' | 'blocked-frame'
  | 'move-before-first-measure' | 'move-before-scroll' | 'foreign-identity' | 'unreadable-identity'
  | 'cancel-during-identity' | 'allowed-top' | 'allowed-frame' | 'allowed-element' | 'blocked-top' | 'owner' | 'lost-after-read';

// Real executor, identity, measurements and quiet wait. DOM geometry, Chrome
// document delivery, MutationObserver and clock are controlled adapters;
// these tests do not use a live browser, real scrolling or external requests.
const scroll = async (mode: Mode) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const cancel = { signalled: false };
  const frame = mode === 'blocked-frame' || mode === 'allowed-frame';
  const state = {
    url: mode === 'off-host' || mode === 'off-scope-element' ? 'https://outside.example.com/page'
      : mode === 'off-path' ? 'https://app.example.com/outside'
        : mode === 'blocked-frame' || mode === 'blocked-top' ? 'https://blocked.example/page'
          : mode === 'allowed-frame' ? 'https://frame.example.com/page' : 'https://app.example.com/allowed/page',
    measurements: 0, scripts: [] as string[], scrolls: [] as Array<{ x: number; y: number }>, quietDisconnects: 0,
  };
  const pattern = mode === 'blocked-frame' || mode === 'blocked-top' ? '*://*/*'
    : mode === 'allowed-frame' ? 'https://frame.example.com/*' : 'https://app.example.com/allowed/*';
  const blocked = mode === 'blocked-frame' || mode === 'blocked-top' ? ['blocked.example'] : [];
  const view: any = { innerWidth: 800, innerHeight: 600, scrollX: 5, scrollY: 120, frameElement: null,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    scrollTo(options: { left?: number; top?: number }) {
      if (options.left !== undefined) view.scrollX = options.left;
      if (options.top !== undefined) view.scrollY = options.top;
      state.scrolls.push({ x: view.scrollX, y: view.scrollY });
    } };
  view.top = frame ? {} : view;
  const doc: any = { nodeType: 9, title: 'Fixture', defaultView: view,
    querySelector: () => element, querySelectorAll: () => [] };
  const root: any = { nodeType: 1, parentNode: doc, ownerDocument: doc, isConnected: true, hasAttribute: () => mode === 'owner',
    clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 1_800,
    get scrollLeft() { return view.scrollX; }, get scrollTop() { return view.scrollY; },
    scrollTo: (options: object) => view.scrollTo(options) };
  const element: any = { nodeType: 1, parentNode: root, ownerDocument: doc, isConnected: true,
    clientWidth: 200, clientHeight: 100, scrollWidth: 200, scrollHeight: 100,
    getBoundingClientRect: () => ({ left: 50, top: 1_050 - view.scrollY, right: 250, bottom: 1_150 - view.scrollY, width: 200, height: 100 }) };
  doc.documentElement = root; doc.scrollingElement = root; doc.body = root;
  vi.stubGlobal('window', view); vi.stubGlobal('document', doc);
  vi.stubGlobal('location', { get href() { return state.url; } });
  vi.stubGlobal('Node', { ELEMENT_NODE: 1, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 });
  vi.stubGlobal('recuedScreenshotScroll', undefined);
  vi.stubGlobal('recuedElementScroll', undefined);
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() { state.quietDisconnects++; } });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    async blockedSites() { return blocked; }, async tabUrl() { return frame ? 'https://app.example.com/container' : state.url; },
    async executeInDocument(target, func, args) {
      expect(target).toEqual({ tab_id: 7, document_id: 'DOC7' });
      state.scripts.push(func.name);
      if (![pageIdentity, measurePageArea, waitForQuiet].some(known => known === func)) throw new Error(`unexpected script ${func.name}`);
      const result = await func(...args);
      if (func === pageIdentity) {
        if (mode === 'cancel-during-identity') cancel.signalled = true;
        if (mode === 'foreign-identity') return { document_id: 'OTHER', result };
        if (mode === 'unreadable-identity') return { document_id: 'DOC7', result: {} };
        if (mode === 'move-before-first-measure') state.url = 'https://app.example.com/outside';
      }
      if (func === measurePageArea) {
        state.measurements++;
        if (mode === 'move-before-scroll' && state.measurements === 1) state.url = 'https://app.example.com/outside';
        if (mode === 'lost-after-read' && state.measurements === 3) return null;
      }
      return { document_id: 'DOC7', result };
    },
  };
  const command: BridgeCommand = {
    command_id: 'scroll', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
      domain_allowlist: [pattern], domain_allowlist_signature: 'fixture' },
    action: 'scroll', target_domain_pattern: pattern,
    args: { page: '7:DOC7', to: 'next', ...(mode === 'off-scope-element' || mode === 'allowed-element' ? { selector: '#target' } : {}) },
    expects_output_keys: ['page', 'url', 'title', 'screen', 'screens'], timeout_ms: 5_000, idempotency_key: 'scroll',
  };
  const pending = buildActionExecutor(api).execute({ action: 'scroll', command, cancel });
  await vi.advanceTimersByTimeAsync(2_000);
  return { outcome: await pending, state, view };
};

describe('scroll site policy before movement', () => {
  it.each(['off-host', 'off-path', 'off-scope-element', 'blocked-frame', 'move-before-first-measure', 'move-before-scroll'] as const)(
    '%s refuses before any page or element scrolling', async mode => {
      const t = await scroll(mode);
      expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
      expect(t.outcome.outputs).toBeUndefined(); expect(t.state.scrolls).toEqual([]);
      expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]); expect(t.state.quietDisconnects).toBe(0);
    });

  it.each(['foreign-identity', 'unreadable-identity'] as const)('%s cannot authorize scrolling', async mode => {
    const t = await scroll(mode);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: mode === 'foreign-identity' ? 'selector_not_found' : 'unknown' } });
    expect(t.outcome.outputs).toBeUndefined(); expect(t.state.scrolls).toEqual([]);
    expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
  });

  it('observes cancellation during the identity preflight before scrolling', async () => {
    const t = await scroll('cancel-during-identity');
    expect(t.outcome.status).toBe('cancelled'); expect(t.outcome.outputs).toBeUndefined();
    expect(t.state.scrolls).toEqual([]); expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
  });

  it.each(['allowed-top', 'allowed-frame', 'allowed-element', 'lost-after-read'] as const)(
    'preserves the confirmed %s scroll and its output contract', async mode => {
      const t = await scroll(mode);
      const element = mode === 'allowed-element';
      expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC7', url: t.state.url, title: 'Fixture',
        screen: element ? 1 : 2, screens: element ? 1 : 4 } });
      expect(t.state.scrolls).toEqual([{ x: 5, y: element ? 550 : 525 }]);
      expect([t.view.scrollX, t.view.scrollY]).toEqual([5, element ? 550 : 525]); expect(t.state.quietDisconnects).toBe(1);
    });

  it.each(['blocked-top', 'owner'] as const)('preserves a %s refusal without scrolling', async mode => {
    const t = await scroll(mode);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
    expect(t.state.scrolls).toEqual([]); expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
    expect(t.state.quietDisconnects).toBe(0);
    if (mode === 'blocked-top') expect(t.state.scripts).toEqual([]);
  });
});
