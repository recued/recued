import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { pageIdentity } from '../actions/page-tabs.js';
import { measurePageArea, restorePageScroll, waitForPaint, waitForPictures,
  type PageCaptureChrome } from '../actions/page-capture.js';

afterEach(() => { vi.unstubAllGlobals(); });
type Mode = 'clipped' | 'measurement-throws' | 'lost-reply' | 'scroll-call-throws'
  | 'normal' | 'untouched' | 'replaced-document' | 'other-token' | 'owner' | 'permission-denied';
const savedScroll = () => (globalThis as typeof globalThis & { recuedScreenshotScroll?: { token: string } }).recuedScreenshotScroll;

// Real executor, capture, measurement, paint/image waits and restoration.
// DOM geometry, Chrome APIs, delivery and encoding are controlled adapters;
// no live browser, screenshot or external request is used.
const screenshot = async (mode: Mode) => {
  const url = 'https://app.example.com/page';
  const state = { document: 'DOC7', front: 3, bridgeScrolls: 0, elementReads: 0, scripts: 0,
    captures: 0, encodings: 0, restored: 0, events: [] as string[] };
  const view: any = { innerWidth: 800, innerHeight: 600, scrollX: 5, scrollY: 120, frameElement: null,
    getComputedStyle: (at: unknown) => ({ overflowY: at === clip ? 'clip' : 'visible' }),
    scrollTo(options: { left?: number; top?: number }) {
      if (options.left !== undefined) view.scrollX = options.left;
      if (options.top !== undefined) view.scrollY = options.top;
    } };
  view.top = view;
  const doc: any = { nodeType: 9, title: 'Target', defaultView: view, images: [],
    querySelector: () => element, querySelectorAll: () => [] };
  const root: any = { nodeType: 1, ownerDocument: doc, parentNode: doc, hasAttribute: () => mode === 'owner',
    clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 2_000,
    get scrollLeft() { return view.scrollX; }, get scrollTop() { return view.scrollY; },
    scrollTo: (options: { left?: number; top?: number }) => view.scrollTo(options) };
  const box = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height });
  const clip: any = { nodeType: 1, ownerDocument: doc, parentNode: root, clientLeft: 0, clientTop: 0, clientWidth: 400,
    clientHeight: mode === 'clipped' ? 0 : 300, scrollWidth: 400, scrollHeight: 500, scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => box(20, (mode === 'untouched' ? 200 : 1_000) - view.scrollY, 400, mode === 'clipped' ? 0 : 300),
    scrollTo(options: { left?: number; top?: number }) {
      if (options.left !== undefined) clip.scrollLeft = options.left;
      if (options.top !== undefined) clip.scrollTop = options.top;
    } };
  const element: any = { nodeType: 1, ownerDocument: doc, parentNode: clip,
    clientWidth: 200, clientHeight: 100, scrollWidth: 200, scrollHeight: 100,
    getBoundingClientRect() {
      state.elementReads++;
      if (mode === 'measurement-throws' && state.elementReads > 1) throw new Error('controlled post-scroll layout failure');
      return box(50, (mode === 'untouched' ? 250 : 1_050) - view.scrollY, 200, 100);
    },
    scrollIntoView() {
      state.bridgeScrolls++;
      view.scrollTo({ top: 900 });
      if (mode === 'scroll-call-throws') throw new Error('controlled scroll acknowledgement failure');
    } };
  doc.documentElement = root; doc.scrollingElement = root; doc.body = root;
  vi.stubGlobal('window', view); vi.stubGlobal('document', doc); vi.stubGlobal('location', { href: url });
  vi.stubGlobal('Node', { ELEMENT_NODE: 1, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 });
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => { callback(Date.now()); return 1; });
  vi.stubGlobal('recuedScreenshotScroll', undefined);
  let otherRecord: ReturnType<typeof savedScroll>;
  const execute: PageCaptureChrome['executeInDocument'] = async (target, func, args) => {
    expect(target).toEqual({ tab_id: 7, document_id: 'DOC7' });
    state.scripts++;
    if (target.document_id !== state.document) return null;
    if (![pageIdentity, measurePageArea, restorePageScroll, waitForPaint, waitForPictures].some(known => known === func)) {
      throw new Error(`unexpected script ${func.name}`);
    }
    const result = await func(...args);
    if (func === measurePageArea) {
      if (mode === 'replaced-document') {
        state.document = 'DOC8'; view.scrollY = 0;
        vi.stubGlobal('recuedScreenshotScroll', undefined);
        return { document_id: 'DOC8', result };
      }
      if (mode === 'other-token') {
        view.scrollY = 120;
        measurePageArea({ selector: '#target' }, null, null, 'OTHER_REQUEST');
        otherRecord = savedScroll();
        return null;
      }
      if (mode === 'lost-reply') return null;
    }
    if (func === restorePageScroll && result === true) { state.restored++; state.events.push('restore scroll'); }
    return { document_id: state.document, result };
  };
  const capture: PageCaptureChrome = {
    screenshotsAllowed: async () => mode !== 'permission-denied',
    getTab: async () => ({ window_id: 1, active: state.front === 7 }), windowMinimized: async () => false,
    activeTab: async () => ({ tab_id: state.front, url: state.front === 7 ? url : 'https://recued.example/client' }),
    activate: async id => { state.front = id; state.events.push(`activate ${id}`); },
    captureVisible: async () => { state.captures++; return 'data:image/png;base64,FIXTURE'; },
    executeInDocument: execute,
    encode: async () => {
      state.encodings++;
      // The owner scrolls after the confirmed capture; the screenshot did not.
      if (mode === 'untouched') view.scrollY = 250;
      return { image: 'FIXTURE_JPEG', mime_type: 'image/jpeg', width: 200, height: 100 };
    },
  };
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    executeInDocument: execute, pageCapture: capture,
  };
  const command: BridgeCommand = {
    command_id: 'cleanup', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
      domain_allowlist: ['https://app.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'screenshot_page', target_domain_pattern: 'https://app.example.com/*', args: { page: '7:DOC7', selector: '#target' },
    expects_output_keys: ['page', 'url', 'title', 'image', 'mime_type', 'width', 'height'], timeout_ms: 5_000, idempotency_key: 'cleanup',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'screenshot_page', command, cancel: { signalled: false } });
  return { outcome, state, view, saved: savedScroll(), otherRecord };
};

describe('screenshot cleanup after an unconfirmed first measurement', () => {
  it.each(['clipped', 'measurement-throws', 'lost-reply', 'scroll-call-throws'] as const)(
    '%s restores the scroll without capturing or switching tabs', async mode => {
      const t = await screenshot(mode);
      expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'selector_not_found' } });
      expect(t.outcome.outputs).toBeUndefined();
      expect(t.state.bridgeScrolls).toBe(1);
      expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
      expect(t.state.restored).toBe(1); expect(t.saved).toBeUndefined();
      expect(t.state.captures).toBe(0); expect(t.state.encodings).toBe(0); expect(t.state.front).toBe(3);
    });

  it('preserves a valid screenshot and restores scroll after the foreground tab', async () => {
    const t = await screenshot('normal');
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC7', url: 'https://app.example.com/page', title: 'Target',
      image: 'FIXTURE_JPEG', mime_type: 'image/jpeg', width: 200, height: 100 } });
    expect(t.state.captures).toBe(1); expect(t.state.encodings).toBe(1); expect(t.state.front).toBe(3);
    expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]); expect(t.saved).toBeUndefined();
    expect(t.state.events.indexOf('restore scroll')).toBeGreaterThan(t.state.events.lastIndexOf('activate 3'));
  });

  it('leaves unrelated scrolling alone when the screenshot did not scroll', async () => {
    const t = await screenshot('untouched');
    expect(t.outcome.status).toBe('ok'); expect(t.state.bridgeScrolls).toBe(0);
    expect(t.view.scrollY).toBe(250); expect(t.state.restored).toBe(0);
  });

  it('never restores the replacement document', async () => {
    const t = await screenshot('replaced-document');
    expect(t.outcome.status).toBe('error'); expect(t.state.document).toBe('DOC8');
    expect(t.view.scrollY).toBe(0); expect(t.state.restored).toBe(0); expect(t.state.captures).toBe(0);
  });

  it('leaves another request\'s saved scroll state untouched', async () => {
    const t = await screenshot('other-token');
    expect(t.outcome.status).toBe('error'); expect(t.otherRecord?.token).toBe('OTHER_REQUEST');
    expect(t.saved).toBe(t.otherRecord); expect(t.view.scrollY).toBe(900);
    expect(t.state.restored).toBe(0); expect(t.state.captures).toBe(0);
  });

  it.each(['owner', 'permission-denied'] as const)('preserves a %s refusal without moving or picturing the page', async mode => {
    const t = await screenshot(mode);
    expect(t.outcome.status).toBe('error'); expect(t.outcome.outputs).toBeUndefined();
    expect(t.state.bridgeScrolls).toBe(0); expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
    expect(t.state.restored).toBe(0); expect(t.state.captures).toBe(0); expect(t.state.front).toBe(3);
    if (mode === 'permission-denied') expect(t.state.scripts).toBe(0);
  });
});
