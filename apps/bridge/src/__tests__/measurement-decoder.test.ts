import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { pageIdentity } from '../actions/page-tabs.js';
import { measurePageArea, restorePageScroll, waitForPaint, waitForPictures,
  type PageCaptureChrome } from '../actions/page-capture.js';

afterEach(() => { vi.unstubAllGlobals(); });
type Mode = 'null-area-first' | 'null-viewport-prepared' | 'valid' | 'invalid-shape' | 'missing';

// Real executor, identity, measurement, capture and restoration. DOM,
// document delivery, native capture and encoding are controlled adapters;
// no live browser, actual screenshot or external request is used.
const screenshot = async (mode: Mode) => {
  const url = 'https://app.example.com/page';
  const state = { front: 3, measurements: 0, restored: 0, captures: 0, encodings: 0,
    moves: [] as number[], activations: [] as number[] };
  const view: any = { innerWidth: 800, innerHeight: 600, scrollX: 5, scrollY: 120,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    scrollTo(options: { left?: number; top?: number }) {
      if (options.left !== undefined) view.scrollX = options.left;
      if (options.top !== undefined) view.scrollY = options.top;
      state.moves.push(view.scrollY);
    } };
  view.top = view;
  const root: any = { hasAttribute: () => false, clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 1_800 };
  const doc = { title: 'Fixture', documentElement: root, scrollingElement: root, body: root,
    defaultView: view, images: [], querySelector: () => null, querySelectorAll: () => [] };
  root.ownerDocument = doc;
  vi.stubGlobal('window', view); vi.stubGlobal('document', doc); vi.stubGlobal('location', { href: url });
  vi.stubGlobal('recuedScreenshotScroll', undefined);
  vi.stubGlobal('requestAnimationFrame', (callback: (time: number) => void) => { callback(Date.now()); return 1; });
  const execute: PageCaptureChrome['executeInDocument'] = async (target, func, args) => {
    expect(target).toEqual({ tab_id: 7, document_id: 'DOC7' });
    if (![pageIdentity, measurePageArea, restorePageScroll, waitForPaint, waitForPictures].some(known => known === func)) {
      throw new Error(`unexpected script ${func.name}`);
    }
    let result = await func(...args);
    if (func === measurePageArea) {
      state.measurements++;
      const outputs = (result as { outputs?: Record<string, unknown> }).outputs;
      if (mode === 'null-area-first' && state.measurements === 1) result = { outputs: { ...outputs, area: null } };
      if (mode === 'null-viewport-prepared' && state.measurements === 2) result = { outputs: { ...outputs, viewport: null } };
      if (mode === 'invalid-shape' && state.measurements === 1) {
        result = { outputs: { ...outputs, area: { x: 0, y: 0, width: 'bad', height: 600 } } };
      }
    }
    if (func === restorePageScroll && result === true) state.restored++;
    return { document_id: 'DOC7', result };
  };
  const capture: PageCaptureChrome = {
    screenshotsAllowed: async () => true,
    getTab: async () => ({ window_id: 1, active: state.front === 7 }), windowMinimized: async () => false,
    activeTab: async () => ({ tab_id: state.front, url: state.front === 7 ? url : 'https://recued.example/client' }),
    activate: async id => { state.front = id; state.activations.push(id); },
    executeInDocument: execute,
    captureVisible: async () => { state.captures++; return 'data:image/png;base64,FIXTURE'; },
    encode: async () => { state.encodings++; return { image: 'FIXTURE_JPEG', mime_type: 'image/jpeg', width: 800, height: 600 }; },
  };
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    executeInDocument: execute, pageCapture: capture,
  };
  const command: BridgeCommand = {
    command_id: 'capture', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
      domain_allowlist: ['https://app.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'screenshot_page', target_domain_pattern: 'https://app.example.com/*',
    args: { page: '7:DOC7', screen: 2, ...(mode === 'missing' ? { selector: '#absent' } : {}) },
    expects_output_keys: ['page', 'url', 'title', 'image', 'mime_type', 'width', 'height', 'screen', 'screens'],
    timeout_ms: 5_000, idempotency_key: 'capture',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'screenshot_page', command, cancel: { signalled: false } });
  return { outcome, state, view };
};

describe('malformed nested screenshot measurement values', () => {
  it.each(['null-area-first', 'null-viewport-prepared'] as const)('%s returns a structured failure and completes cleanup', async mode => {
    const t = await screenshot(mode);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'unknown', message: 'bridge: no readable answer from the page' } });
    expect(t.outcome.outputs).toBeUndefined(); expect(t.state.captures).toBe(0); expect(t.state.encodings).toBe(0);
    expect(t.state.restored).toBe(1); expect(t.state.front).toBe(3);
    expect(t.state.activations).toEqual(mode === 'null-area-first' ? [] : [7, 3]);
    expect(t.state.moves).toContain(525); expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
  });

  it('preserves valid geometry, screenshot outputs and cleanup', async () => {
    const t = await screenshot('valid');
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC7', url: 'https://app.example.com/page', title: 'Fixture',
      image: 'FIXTURE_JPEG', mime_type: 'image/jpeg', width: 800, height: 600, screen: 2, screens: 4 } });
    expect(t.state.captures).toBe(1); expect(t.state.encodings).toBe(1); expect(t.state.restored).toBe(1);
    expect(t.state.activations).toEqual([7, 3]); expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
  });

  it('preserves the structured rejection of another malformed shape', async () => {
    const t = await screenshot('invalid-shape');
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'unknown' } }); expect(t.outcome.outputs).toBeUndefined();
    expect(t.state.captures).toBe(0); expect(t.state.encodings).toBe(0); expect(t.state.restored).toBe(1);
    expect(t.state.front).toBe(3); expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
  });

  it('preserves a missing-element refusal before scrolling', async () => {
    const t = await screenshot('missing');
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'selector_not_found' } }); expect(t.outcome.outputs).toBeUndefined();
    expect(t.state.moves).toEqual([]); expect(t.state.captures).toBe(0); expect(t.state.encodings).toBe(0);
    expect(t.state.front).toBe(3); expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
  });
});
