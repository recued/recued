import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { pageIdentity } from '../actions/page-tabs.js';
import { chromePageCapture, measurePageArea, restorePageScroll, waitForPaint, waitForPictures,
  PAGE_CAPTURE_QUOTA_WAIT_MS, type PageCaptureChrome } from '../actions/page-capture.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
type Mode = 'cancel-during-permission' | 'cancel-before-activation' | 'cancel-during-preparation'
  | 'cancel-before-capture' | 'cancel-before-retry' | 'cancel-during-retry-wait'
  | 'normal' | 'quota-unchanged' | 'cancel-after-capture';

// Real executor, capture adapter, measurement, paint, picture wait and scroll
// restoration. DOM, Chrome APIs, encoding and clock are controlled; no actual
// browser or screenshot capture occurs.
const runCapture = async (mode: Mode) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const cancel = { signalled: false };
  const url = 'https://app.example.com/page';
  const state = {
    front: 3, targetActivated: false, measurements: 0, encodings: 0, restoreAttempts: 0, restored: 0,
    events: [] as string[], captures: [] as Array<{ tab: number; cancelled: boolean }>,
    operations: [] as Array<{ kind: string; cancelled: boolean; cleanup: boolean }>,
  };
  const record = (kind: string, cleanup = false) => state.operations.push({ kind, cancelled: cancel.signalled, cleanup });
  const view = {
    innerWidth: 800, innerHeight: 600, scrollX: 5, scrollY: 120, top: null as unknown as Window,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    scrollTo(options: { left?: number; top?: number }) {
      if (options.left !== undefined) view.scrollX = options.left;
      if (options.top !== undefined) view.scrollY = options.top;
    },
  };
  view.top = view as unknown as Window;
  const root = { hasAttribute: () => false, scrollHeight: 1_800, clientHeight: 600,
    scrollWidth: 800, clientWidth: 800, ownerDocument: null as unknown as Document };
  const doc = { title: 'Target', documentElement: root, scrollingElement: root, body: root,
    defaultView: view, querySelectorAll: () => [], images: [] };
  root.ownerDocument = doc as unknown as Document;
  vi.stubGlobal('window', view); vi.stubGlobal('document', doc); vi.stubGlobal('location', { href: url });
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => { callback(Date.now()); return 1; });
  vi.stubGlobal('recuedScreenshotScroll', undefined);
  const execute: PageCaptureChrome['executeInDocument'] = async (target, func, args) => {
    record('script', func === restorePageScroll);
    if (func === restorePageScroll) state.restoreAttempts++;
    if (target.tab_id !== 7 || target.document_id !== 'DOC7') return null;
    if (![pageIdentity, measurePageArea, waitForPaint, waitForPictures, restorePageScroll].some(known => known === func)) {
      throw new Error(`Unexpected script ${func.name}`);
    }
    const result = await func(...args);
    if (func === measurePageArea) {
      state.measurements++;
      if (mode === 'cancel-before-activation' && !state.targetActivated
        || mode === 'cancel-during-preparation' && state.targetActivated) cancel.signalled = true;
    }
    if (func === restorePageScroll && result === true) { state.restored++; state.events.push('restore scroll'); }
    return { document_id: 'DOC7', result };
  };
  const native = chromePageCapture({
    permissions: { async contains() {
      record('permission');
      if (mode === 'cancel-during-permission') cancel.signalled = true;
      return true;
    } },
    windows: { async get() { record('window'); return { state: 'normal' }; } },
    tabs: {
      async get() { record('get'); return { windowId: 1, active: state.front === 7 }; },
      async query() {
        record('front');
        const result = [{ id: state.front, url: state.front === 7 ? url : 'https://recued.example/client' }];
        if (mode === 'cancel-before-capture' && state.front === 7) cancel.signalled = true;
        return result;
      },
      async update(id) {
        record('activate', id === 3); state.front = id;
        if (id === 7) state.targetActivated = true;
        state.events.push(`activate ${id}`);
      },
      async captureVisibleTab() {
        record('capture'); state.captures.push({ tab: state.front, cancelled: cancel.signalled });
        if (['quota-unchanged', 'cancel-before-retry', 'cancel-during-retry-wait'].includes(mode) && state.captures.length === 1) {
          if (mode === 'cancel-before-retry') cancel.signalled = true;
          if (mode === 'cancel-during-retry-wait') setTimeout(() => { cancel.signalled = true; }, PAGE_CAPTURE_QUOTA_WAIT_MS / 2);
          throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
        }
        if (mode === 'cancel-after-capture') cancel.signalled = true;
        return 'data:image/png;base64,FIXTURE';
      },
    },
  }, execute);
  const capture: PageCaptureChrome = { ...native, async encode() {
    state.encodings++;
    return { image: 'FIXTURE_JPEG', mime_type: 'image/jpeg', width: 800, height: 600 };
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
    action: 'screenshot_page', target_domain_pattern: 'https://app.example.com/*', args: { page: '7:DOC7', screen: 2 },
    expects_output_keys: ['page', 'url', 'title', 'image', 'mime_type', 'width', 'height', 'screen', 'screens'],
    timeout_ms: 10_000, idempotency_key: 'capture',
  };
  const pending = buildActionExecutor(api).execute({ action: 'screenshot_page', command, cancel });
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(PAGE_CAPTURE_QUOTA_WAIT_MS);
  const outcome = await pending;
  expect(state.front).toBe(3); expect([view.scrollX, view.scrollY]).toEqual([5, 120]);
  expect(state.restoreAttempts).toBe(state.measurements > 0 ? 1 : 0);
  expect(state.restored).toBe(state.measurements > 0 ? 1 : 0);
  if (state.targetActivated) {
    expect(state.events.indexOf('restore scroll')).toBeGreaterThan(state.events.lastIndexOf('activate 3'));
  }
  expect(state.operations.filter(operation => operation.cancelled && !operation.cleanup)).toEqual([]);
  return { state, outcome, cancelled: cancel.signalled };
};

describe('cooperative screenshot cancellation', () => {
  it.each(['cancel-during-permission', 'cancel-before-activation', 'cancel-during-preparation',
    'cancel-before-capture', 'cancel-before-retry', 'cancel-during-retry-wait'] as const)(
    '%s stops new browser work while allowing cleanup', async mode => {
      const t = await runCapture(mode);
      expect(t.cancelled).toBe(true);
      expect(t.state.captures).toHaveLength(mode === 'cancel-before-retry' || mode === 'cancel-during-retry-wait' ? 1 : 0);
      expect(t.state.encodings).toBe(0);
      if (mode === 'cancel-during-permission' || mode === 'cancel-before-activation') expect(t.state.targetActivated).toBe(false);
      expect(t.outcome).toMatchObject({ status: 'cancelled' });
      expect(t.outcome.outputs).toBeUndefined();
    });

  it.each(['normal', 'quota-unchanged', 'cancel-after-capture'] as const)(
    'preserves a confirmed %s receipt and cleanup', async mode => {
      const t = await runCapture(mode);
      expect(t.state.captures).toEqual(Array.from({ length: mode === 'quota-unchanged' ? 2 : 1 }, () => ({ tab: 7, cancelled: false })));
      expect(t.state.encodings).toBe(1); expect(t.cancelled).toBe(mode === 'cancel-after-capture');
      expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC7', url: 'https://app.example.com/page', title: 'Target',
        image: 'FIXTURE_JPEG', mime_type: 'image/jpeg', width: 800, height: 600, screen: 2, screens: 4 } });
    });
});
