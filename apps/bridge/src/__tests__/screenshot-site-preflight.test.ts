import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPatternWithinGrantedOrigins, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { pageIdentity } from '../actions/page-tabs.js';
import { chromePageCapture, measurePageArea, restorePageScroll, waitForPaint, waitForPictures,
  type PageCaptureChrome } from '../actions/page-capture.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
type Mode = 'off-host' | 'off-path' | 'off-scope-element' | 'retry-off-path' | 'move-before-measure'
  | 'foreign-identity' | 'unreadable-identity' | 'cancel-during-identity'
  | 'normal' | 'allowed-element' | 'updated-allowed-retry' | 'owner' | 'blocked-top' | 'permission-denied';

// Real executor, capture adapter, identity, measurement, paint/image waits
// and scroll restoration. DOM geometry, Chrome APIs, encoding and clock are
// controlled; no live browser, actual screenshot or external request occurs.
const screenshot = async (mode: Mode) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const cancel = { signalled: false };
  const pattern = mode === 'blocked-top' ? '*://*/*' : 'https://app.example.com/allowed/*';
  const state = {
    url: mode === 'off-host' || mode === 'off-scope-element' ? 'https://outside.example.com/page'
      : mode === 'off-path' ? 'https://app.example.com/outside'
        : mode === 'blocked-top' ? 'https://blocked.example/page' : 'https://app.example.com/allowed/page',
    title: 'Target', front: 3, encodings: 0, restored: 0, scripts: [] as string[],
    captures: [] as Array<{ tab: number; url: string }>,
    scrolls: [] as Array<{ x: number; y: number; url: string; cleanup: boolean }>,
  };
  let restoring = false;
  const view: any = { innerWidth: 800, innerHeight: 600, scrollX: 5, scrollY: 120, frameElement: null,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    scrollTo(options: { left?: number; top?: number }) {
      if (options.left !== undefined) view.scrollX = options.left;
      if (options.top !== undefined) view.scrollY = options.top;
      state.scrolls.push({ x: view.scrollX, y: view.scrollY, url: state.url, cleanup: restoring });
    } };
  view.top = view;
  const doc: any = { nodeType: 9, get title() { return state.title; }, defaultView: view, images: [],
    querySelector: () => element, querySelectorAll: () => [] };
  const root: any = { nodeType: 1, parentNode: doc, ownerDocument: doc,
    hasAttribute: (name: string) => name === 'data-recued-owner-surface' && mode === 'owner',
    clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 1_800,
    get scrollLeft() { return view.scrollX; }, get scrollTop() { return view.scrollY; },
    scrollTo: (options: object) => view.scrollTo(options) };
  const element: any = { nodeType: 1, parentNode: root, ownerDocument: doc,
    clientWidth: 200, clientHeight: 100, scrollWidth: 200, scrollHeight: 100,
    getBoundingClientRect: () => ({ left: 50, top: 1_050 - view.scrollY, right: 250, bottom: 1_150 - view.scrollY, width: 200, height: 100 }),
    scrollIntoView: () => view.scrollTo({ top: 900 }) };
  doc.documentElement = root; doc.scrollingElement = root; doc.body = root;
  vi.stubGlobal('window', view); vi.stubGlobal('document', doc);
  vi.stubGlobal('location', { get href() { return state.url; } });
  vi.stubGlobal('Node', { ELEMENT_NODE: 1, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 });
  vi.stubGlobal('recuedScreenshotScroll', undefined);
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => { callback(Date.now()); return 1; });
  const execute: PageCaptureChrome['executeInDocument'] = async (target, func, args) => {
    expect(target).toEqual({ tab_id: 7, document_id: 'DOC7' }); state.scripts.push(func.name);
    if (![pageIdentity, measurePageArea, restorePageScroll, waitForPaint, waitForPictures].some(known => known === func)) {
      throw new Error(`unexpected script ${func.name}`);
    }
    let result: unknown;
    try { restoring = func === restorePageScroll; result = await func(...args); } finally { restoring = false; }
    if (func === pageIdentity) {
      if (mode === 'foreign-identity') return { document_id: 'OTHER', result };
      if (mode === 'unreadable-identity') return { document_id: 'DOC7', result: {} };
      if (mode === 'cancel-during-identity') cancel.signalled = true;
      if (mode === 'move-before-measure') state.url = 'https://app.example.com/outside';
    }
    if (func === restorePageScroll && result === true) state.restored++;
    return { document_id: 'DOC7', result };
  };
  const native = chromePageCapture({
    permissions: { async contains() { return mode !== 'permission-denied'; } },
    windows: { async get() { return { state: 'normal' }; } },
    tabs: {
      async get() { return { windowId: 1, active: state.front === 7 }; },
      async query() { return [{ id: state.front, url: state.front === 7 ? state.url : 'https://recued.example/client' }]; },
      async update(id) { state.front = id; },
      async captureVisibleTab() {
        state.captures.push({ tab: state.front, url: state.url });
        if ((mode === 'retry-off-path' || mode === 'updated-allowed-retry') && state.captures.length === 1) {
          state.url = mode === 'retry-off-path' ? 'https://app.example.com/outside' : 'https://app.example.com/allowed/updated';
          state.title = 'Updated Target'; view.scrollY = 120;
          if (mode === 'updated-allowed-retry') { view.innerWidth = 600; root.clientWidth = 600; }
          throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
        }
        return 'data:image/png;base64,FIXTURE';
      },
    },
  }, execute);
  const capture: PageCaptureChrome = { ...native, async encode(_image, area) {
    state.encodings++;
    return { image: 'FIXTURE_JPEG', mime_type: 'image/jpeg', width: area.width, height: area.height };
  } };
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    async blockedSites() { return mode === 'blocked-top' ? ['blocked.example'] : []; },
    async tabUrl() { return state.url; }, executeInDocument: execute, pageCapture: capture,
  };
  const command: BridgeCommand = {
    command_id: 'capture', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
      domain_allowlist: [pattern], domain_allowlist_signature: 'fixture' },
    action: 'screenshot_page', target_domain_pattern: pattern,
    args: { page: '7:DOC7', ...(mode === 'off-scope-element' || mode === 'allowed-element' ? { selector: '#target' } : { screen: 2 }) },
    expects_output_keys: ['page', 'url', 'title', 'image', 'mime_type', 'width', 'height', 'screen', 'screens'],
    timeout_ms: 10_000, idempotency_key: 'capture',
  };
  const pending = buildActionExecutor(api).execute({ action: 'screenshot_page', command, cancel });
  await vi.advanceTimersByTimeAsync(2_000);
  const outcome = await pending;
  const violations = state.scrolls.filter(s => !s.cleanup && !isPatternWithinGrantedOrigins(s.url, [pattern]));
  return { outcome, state, view, violations };
};

describe('screenshot site checks before scroll-capable measurements', () => {
  it.each(['off-host', 'off-path', 'off-scope-element', 'retry-off-path', 'move-before-measure'] as const)(
    '%s refuses without an out-of-scope scroll or a new image', async mode => {
      const t = await screenshot(mode);
      expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
      expect(t.outcome.outputs).toBeUndefined(); expect(t.violations).toEqual([]);
      expect(t.state.captures).toHaveLength(mode === 'retry-off-path' ? 1 : 0); expect(t.state.encodings).toBe(0);
      expect(t.state.front).toBe(3); expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
    });

  it.each(['foreign-identity', 'unreadable-identity', 'cancel-during-identity'] as const)('%s cannot start measurement scrolling', async mode => {
    const t = await screenshot(mode);
    if (mode === 'cancel-during-identity') expect(t.outcome.status).toBe('cancelled');
    else expect(t.outcome).toMatchObject({ status: 'error', error: { code: mode === 'foreign-identity' ? 'selector_not_found' : 'unknown' } });
    expect(t.outcome.outputs).toBeUndefined(); expect(t.state.scrolls).toEqual([]);
    expect(t.state.captures).toEqual([]); expect(t.state.encodings).toBe(0); expect(t.state.front).toBe(3);
  });

  it.each(['normal', 'allowed-element', 'updated-allowed-retry'] as const)('preserves a valid %s capture, metadata and cleanup', async mode => {
    const t = await screenshot(mode);
    const element = mode === 'allowed-element'; const updated = mode === 'updated-allowed-retry';
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC7',
      url: updated ? 'https://app.example.com/allowed/updated' : 'https://app.example.com/allowed/page',
      title: updated ? 'Updated Target' : 'Target', image: 'FIXTURE_JPEG', mime_type: 'image/jpeg',
      width: element ? 200 : updated ? 600 : 800, height: element ? 100 : 600, screen: element ? 1 : 2, screens: element ? 1 : 4 } });
    expect(t.violations).toEqual([]); expect(t.state.captures).toHaveLength(updated ? 2 : 1); expect(t.state.encodings).toBe(1);
    expect(t.state.restored).toBe(1); expect(t.state.front).toBe(3); expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
  });

  it.each(['owner', 'blocked-top', 'permission-denied'] as const)('preserves a %s refusal without movement or capture', async mode => {
    const t = await screenshot(mode);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: mode === 'permission-denied' ? 'capacity_gap_permission_missing' : 'tab_navigation_blocked' } });
    expect(t.state.scrolls).toEqual([]); expect(t.state.captures).toEqual([]); expect(t.state.encodings).toBe(0);
    expect(t.state.front).toBe(3); expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
    if (mode !== 'owner') expect(t.state.scripts).toEqual([]);
  });
});
