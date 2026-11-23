import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { pageIdentity } from '../actions/page-tabs.js';
import { chromePageCapture, measurePageArea, restorePageScroll, waitForPaint, waitForPictures,
  PAGE_CAPTURE_QUOTA_WAIT_MS, type PageArea, type PageCaptureChrome } from '../actions/page-capture.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
type Mode = 'normal' | 'quota-unchanged' | 'different-front' | 'replaced-document' | 'owner-marked'
  | 'off-pattern' | 'quota-exhausted' | 'updated-measurement';

// Real executor, capture adapter, measurement, paint, image-wait and scroll
// restoration functions. DOM, Chrome APIs, encoding and clock are controlled;
// no real browser or image capture occurs.
const runCapture = async (mode: Mode) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const initialUrl = 'https://app.example.com/allowed/page';
  const state = {
    front: 3, document: 'DOC7', url: initialUrl, title: 'Target', owner: false,
    captures: [] as Array<{ tab: number; document: string }>,
    encodings: [] as Array<{ area: PageArea; viewport: { width: number; height: number } }>,
    restoreAttempts: 0, restored: 0, events: [] as string[],
  };
  const view = {
    innerWidth: 800, innerHeight: 600, scrollX: 5, scrollY: 120, top: null as unknown as Window,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    scrollTo(options: { left?: number; top?: number }) {
      if (options.left !== undefined) view.scrollX = options.left;
      if (options.top !== undefined) view.scrollY = options.top;
    },
  };
  view.top = view as unknown as Window;
  const root = { hasAttribute: (name: string) => name === 'data-recued-owner-surface' && state.owner,
    scrollHeight: 1_800, clientHeight: 600, scrollWidth: 800, clientWidth: 800, ownerDocument: null as unknown as Document };
  const doc = { get title() { return state.title; }, documentElement: root, scrollingElement: root, body: root,
    defaultView: view, querySelectorAll: () => [], images: [] };
  root.ownerDocument = doc as unknown as Document;
  vi.stubGlobal('window', view); vi.stubGlobal('document', doc);
  vi.stubGlobal('location', { get href() { return state.url; } });
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => { callback(Date.now()); return 1; });
  vi.stubGlobal('recuedScreenshotScroll', undefined);
  const execute: PageCaptureChrome['executeInDocument'] = async (target, func, args) => {
    if (func === restorePageScroll) state.restoreAttempts++;
    if (target.tab_id !== 7 || target.document_id !== state.document) return null;
    if (![pageIdentity, measurePageArea, waitForPaint, waitForPictures, restorePageScroll].some(known => known === func)) {
      throw new Error(`Unexpected script ${func.name}`);
    }
    const result = await func(...args);
    if (func === restorePageScroll && result === true) { state.restored++; state.events.push('restore scroll'); }
    return { document_id: state.document, result };
  };
  const native = chromePageCapture({
    permissions: { async contains() { return true; } }, windows: { async get() { return { state: 'normal' }; } },
    tabs: {
      async get() { return { windowId: 1, active: state.front === 7 }; },
      async query() { return [{ id: state.front, url: state.front === 7 ? state.url : 'https://recued.example/client' }]; },
      async update(id) { state.front = id; state.events.push(`activate ${id}`); },
      async captureVisibleTab() {
        state.captures.push({ tab: state.front, document: state.front === 7 ? state.document : 'OWNER' });
        if (mode === 'quota-exhausted' || mode !== 'normal' && state.captures.length === 1) {
          if (mode === 'different-front') state.front = 3;
          if (mode === 'replaced-document') { state.document = 'DOC8'; view.scrollY = 0; }
          if (mode === 'owner-marked') state.owner = true;
          if (mode === 'off-pattern') state.url = 'https://app.example.com/outside';
          if (mode === 'updated-measurement') {
            state.url = 'https://app.example.com/allowed/updated'; state.title = 'Updated Target';
            view.innerWidth = 600; root.clientWidth = 600;
          }
          throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
        }
        return 'data:image/png;base64,FIXTURE';
      },
    },
  }, execute);
  const capture: PageCaptureChrome = { ...native, async encode(_image, area, viewport) {
    state.encodings.push({ area: { ...area }, viewport: { ...viewport } });
    return { image: 'FIXTURE_JPEG', mime_type: 'image/jpeg', width: area.width, height: area.height };
  } };
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    executeInDocument: execute, pageCapture: capture,
  };
  const command: BridgeCommand = {
    command_id: 'capture', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://app.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'screenshot_page', target_domain_pattern: 'https://app.example.com/allowed/*', args: { page: '7:DOC7', screen: 2 },
    expects_output_keys: ['page', 'url', 'title', 'image', 'mime_type', 'width', 'height', 'screen', 'screens'],
    timeout_ms: 10_000, idempotency_key: 'capture',
  };
  const pending = buildActionExecutor(api).execute({ action: 'screenshot_page', command, cancel: { signalled: false } });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(PAGE_CAPTURE_QUOTA_WAIT_MS);
  const outcome = await pending;
  expect(state.front).toBe(3); expect(state.restoreAttempts).toBe(1);
  if (mode === 'replaced-document') {
    expect(state.restored).toBe(0); expect(view.scrollY).toBe(0);
  } else {
    expect(state.restored).toBe(1); expect([view.scrollX, view.scrollY]).toEqual([5, 120]);
    expect(state.events.indexOf('restore scroll')).toBeGreaterThan(state.events.lastIndexOf('activate 3'));
  }
  return { state, outcome };
};

describe('screenshot quota retry eligibility', () => {
  it.each([
    ['different-front', 'tab_navigation_blocked'], ['replaced-document', 'selector_not_found'],
    ['owner-marked', 'tab_navigation_blocked'], ['off-pattern', 'tab_navigation_blocked'],
  ] as const)('refuses a %s retry before capturing or encoding another image', async (mode, code) => {
    const t = await runCapture(mode);
    expect(t.state.captures).toEqual([{ tab: 7, document: 'DOC7' }]);
    expect(t.state.encodings).toEqual([]);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code } });
    expect(t.outcome.outputs).toBeUndefined();
  });

  it.each(['normal', 'quota-unchanged'] as const)('preserves a valid %s capture and cleanup', async mode => {
    const t = await runCapture(mode);
    expect(t.state.captures).toEqual(Array.from({ length: mode === 'normal' ? 1 : 2 }, () => ({ tab: 7, document: 'DOC7' })));
    expect(t.state.encodings).toHaveLength(1);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC7', url: 'https://app.example.com/allowed/page',
      title: 'Target', image: 'FIXTURE_JPEG', mime_type: 'image/jpeg', width: 800, height: 600, screen: 2, screens: 4 } });
  });

  it('keeps the one-retry limit and cleanup when quota remains exhausted', async () => {
    const t = await runCapture('quota-exhausted');
    expect(t.state.captures).toHaveLength(2); expect(t.state.encodings).toEqual([]);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'unknown' } });
    expect(t.outcome.outputs).toBeUndefined();
  });

  it('uses fresh allowed-page metadata and geometry for a successful retry', async () => {
    const t = await runCapture('updated-measurement');
    expect(t.state.captures).toEqual([{ tab: 7, document: 'DOC7' }, { tab: 7, document: 'DOC7' }]);
    expect(t.state.encodings).toEqual([{ area: { x: 0, y: 0, width: 600, height: 600 }, viewport: { width: 600, height: 600 } }]);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC7', url: 'https://app.example.com/allowed/updated',
      title: 'Updated Target', image: 'FIXTURE_JPEG', mime_type: 'image/jpeg', width: 600, height: 600, screen: 2, screens: 4 } });
  });
});
