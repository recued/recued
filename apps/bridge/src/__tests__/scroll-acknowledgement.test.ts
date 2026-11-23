import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { pageIdentity } from '../actions/page-tabs.js';
import { measurePageArea } from '../actions/page-capture.js';
import { waitForQuiet } from '../actions/page-scroll.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
type Mode = 'lost-move' | 'malformed-move' | 'null-area-move' | 'foreign-move' | 'throw-after-scroll' | 'lost-element-preparation'
  | 'lost-initial-read' | 'malformed-initial-read' | 'missing-element' | 'invalid-selector' | 'normal' | 'lost-final-read';

// Real executor, identity, measurements and quiet wait; DOM geometry,
// document delivery, observer and clock are controlled adapters. No live
// browser, real scrolling or external requests are used.
const scroll = async (mode: Mode) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const url = 'https://app.example.com/page';
  const state = { measurements: 0, quietDisconnects: 0, scripts: [] as string[], scrolls: [] as Array<{ x: number; y: number }> };
  const view: any = { innerWidth: 800, innerHeight: 600, scrollX: 5, scrollY: 120, frameElement: null,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    scrollTo(options: { left?: number; top?: number }) {
      if (options.left !== undefined) view.scrollX = options.left;
      if (options.top !== undefined) view.scrollY = options.top;
      state.scrolls.push({ x: view.scrollX, y: view.scrollY });
      if (mode === 'throw-after-scroll') throw new Error('controlled scroll-call failure after movement');
    } };
  view.top = view;
  const doc: any = { nodeType: 9, title: 'Fixture', defaultView: view,
    querySelector: () => {
      if (mode === 'invalid-selector') throw new SyntaxError('controlled invalid selector');
      return mode === 'missing-element' ? null : element;
    }, querySelectorAll: () => [] };
  const root: any = { nodeType: 1, parentNode: doc, ownerDocument: doc, hasAttribute: () => false,
    clientWidth: 800, clientHeight: 600, scrollWidth: 800, scrollHeight: 1_800,
    get scrollLeft() { return view.scrollX; }, get scrollTop() { return view.scrollY; },
    scrollTo: (options: object) => view.scrollTo(options) };
  const element: any = { nodeType: 1, parentNode: root, ownerDocument: doc,
    clientWidth: 200, clientHeight: 100, scrollWidth: 200, scrollHeight: 100,
    getBoundingClientRect: () => ({ left: 50, top: 1_050 - view.scrollY, right: 250, bottom: 1_150 - view.scrollY, width: 200, height: 100 }),
    scrollIntoView: () => view.scrollTo({ top: 900 }) };
  doc.documentElement = root; doc.scrollingElement = root; doc.body = root;
  vi.stubGlobal('window', view); vi.stubGlobal('document', doc); vi.stubGlobal('location', { href: url });
  vi.stubGlobal('Node', { ELEMENT_NODE: 1, DOCUMENT_NODE: 9, DOCUMENT_FRAGMENT_NODE: 11 });
  vi.stubGlobal('recuedScreenshotScroll', undefined);
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() { state.quietDisconnects++; } });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    async executeInDocument(target, func, args) {
      expect(target).toEqual({ tab_id: 7, document_id: 'DOC7' }); state.scripts.push(func.name);
      if (![pageIdentity, measurePageArea, waitForQuiet].some(known => known === func)) throw new Error(`unexpected script ${func.name}`);
      const result = await func(...args);
      if (func === measurePageArea) {
        state.measurements++;
        if (mode === 'lost-move' && state.measurements === 2 || mode === 'lost-initial-read' && state.measurements === 1
          || mode === 'lost-element-preparation' && state.measurements === 1 || mode === 'lost-final-read' && state.measurements === 3) return null;
        if (mode === 'foreign-move' && state.measurements === 2) return { document_id: 'OTHER', result };
        if (mode === 'malformed-move' && state.measurements === 2
          || mode === 'malformed-initial-read' && state.measurements === 1) return { document_id: 'DOC7', result: {} };
        if (mode === 'null-area-move' && state.measurements === 2) {
          return { document_id: 'DOC7', result: { outputs: { url, title: 'Fixture', area: null, viewport: { width: 800, height: 600 } } } };
        }
      }
      return { document_id: 'DOC7', result };
    },
  };
  const command: BridgeCommand = {
    command_id: 'scroll', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
      domain_allowlist: ['https://app.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'scroll', target_domain_pattern: 'https://app.example.com/*',
    args: { page: '7:DOC7', to: 'next', ...(['lost-element-preparation', 'missing-element', 'invalid-selector'].includes(mode) ? { selector: '#target' } : {}) },
    expects_output_keys: ['page', 'url', 'title', 'screen', 'screens'], timeout_ms: 5_000, idempotency_key: 'scroll',
  };
  // Capture a rejected executor promise immediately so a decoder failure is
  // reported by the owning test after the fake clock advances.
  const pending = buildActionExecutor(api).execute({ action: 'scroll', command, cancel: { signalled: false } })
    .then(outcome => ({ outcome }), thrown => ({ thrown }));
  await vi.advanceTimersByTimeAsync(2_000);
  const settled = await pending;
  if ('thrown' in settled) throw settled.thrown;
  return { outcome: settled.outcome, state, view };
};

describe('scroll acknowledgement after possible movement', () => {
  it.each(['lost-move', 'malformed-move', 'null-area-move', 'foreign-move', 'throw-after-scroll', 'lost-element-preparation'] as const)(
    '%s reports uncertainty without accepting outputs or scrolling again', async mode => {
      const t = await scroll(mode);
      expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain',
        message: 'The browser could not confirm the command outcome. Check the page before retrying.' } });
      expect(t.outcome.outputs).toBeUndefined();
      const y = mode === 'lost-element-preparation' ? 900 : 525;
      expect(t.state.scrolls).toEqual([{ x: 5, y }]); expect([t.view.scrollX, t.view.scrollY]).toEqual([5, y]);
      expect(t.state.quietDisconnects).toBe(0);
    });

  it.each(['lost-initial-read', 'malformed-initial-read', 'missing-element', 'invalid-selector'] as const)(
    'preserves a %s failure with no movement', async mode => {
      const t = await scroll(mode);
      expect(t.outcome).toMatchObject({ status: 'error', error: { code: mode === 'malformed-initial-read' ? 'unknown' : 'selector_not_found' } });
      expect(t.outcome.outputs).toBeUndefined(); expect(t.state.scrolls).toEqual([]);
      expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]); expect(t.state.quietDisconnects).toBe(0);
    });

  it.each(['normal', 'lost-final-read'] as const)('preserves a confirmed %s scroll', async mode => {
    const t = await scroll(mode);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC7', url: 'https://app.example.com/page', title: 'Fixture', screen: 2, screens: 4 } });
    expect(t.state.scrolls).toEqual([{ x: 5, y: 525 }]); expect(t.state.quietDisconnects).toBe(1);
  });
});
