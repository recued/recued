import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { pageIdentity } from '../actions/page-tabs.js';
import { measurePageArea } from '../actions/page-capture.js';
import { waitForQuiet } from '../actions/page-scroll.js';
import { rebindPageRef } from '../actions/page-rebind.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
type Mode = 'cancel-during-rebind' | 'cancel-after-first-measure' | 'cancel-after-scroll' | 'cancel-during-settlement'
  | 'normal' | 'cancel-during-final-read' | 'cancel-entry' | 'cancel-during-identity';

// Real executor, identity, measurement and observer-based quiet wait. DOM,
// Chrome document delivery, reference acknowledgement and clock are adapters;
// no live browser, real scrolling or external requests occur. These exercise
// executor receipts; the dispatcher separately masks cancelled replies.
const scroll = async (mode: Mode) => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const url = 'https://app.example.com/page';
  const cancel = { signalled: mode === 'cancel-entry' };
  const state = { measurements: 0, quietDisconnects: 0,
    operations: [] as Array<{ script: string; cancelled: boolean }>,
    scrolls: [] as Array<{ x: number; y: number; cancelled: boolean }> };
  const view: any = { innerWidth: 800, innerHeight: 600, scrollX: 5, scrollY: 120, frameElement: null,
    getComputedStyle: () => ({ overflowY: 'visible' }),
    scrollTo(options: { left?: number; top?: number }) {
      if (options.left !== undefined) view.scrollX = options.left;
      if (options.top !== undefined) view.scrollY = options.top;
      state.scrolls.push({ x: view.scrollX, y: view.scrollY, cancelled: cancel.signalled });
    } };
  view.top = view;
  const root: any = { hasAttribute: () => false, scrollHeight: 1_800, clientHeight: 600, scrollWidth: 800, clientWidth: 800 };
  const doc = { title: 'Fixture', documentElement: root, scrollingElement: root, body: root,
    defaultView: view, querySelectorAll: () => [] };
  root.ownerDocument = doc;
  vi.stubGlobal('window', view); vi.stubGlobal('document', doc); vi.stubGlobal('location', { href: url });
  vi.stubGlobal('recuedScreenshotScroll', undefined);
  vi.stubGlobal('MutationObserver', class {
    observe() { if (mode === 'cancel-during-settlement') cancel.signalled = true; }
    disconnect() { state.quietDisconnects++; }
  });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    async executeInDocument(target, func, args) {
      expect(target).toEqual({ tab_id: 7, document_id: 'DOC7' });
      state.operations.push({ script: func.name, cancelled: cancel.signalled });
      if (func === rebindPageRef) {
        expect(mode).toBe('cancel-during-rebind');
        cancel.signalled = true;
        return { document_id: 'DOC7', result: { kept: true } };
      }
      if (![pageIdentity, measurePageArea, waitForQuiet].some(known => known === func)) throw new Error(`unexpected script ${func.name}`);
      const result = await func(...args);
      if (func === pageIdentity && mode === 'cancel-during-identity') cancel.signalled = true;
      if (func === measurePageArea) {
        state.measurements++;
        if (mode === 'cancel-after-first-measure' && state.measurements === 1
          || mode === 'cancel-after-scroll' && state.measurements === 2
          || mode === 'cancel-during-final-read' && state.measurements === 3) cancel.signalled = true;
      }
      return { document_id: 'DOC7', result };
    },
  };
  const command: BridgeCommand = {
    command_id: 'scroll', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'reading',
      domain_allowlist: ['https://app.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'scroll', target_domain_pattern: 'https://app.example.com/*',
    args: { page: '7:DOC7', to: 'next', ...(mode === 'cancel-during-rebind' ? { ref: 'e1' } : {}) },
    expects_output_keys: ['page', 'url', 'title', 'screen', 'screens'], timeout_ms: 5_000, idempotency_key: 'scroll',
  };
  const pending = buildActionExecutor(api).execute({ action: 'scroll', command, cancel });
  await vi.advanceTimersByTimeAsync(2_000);
  return { outcome: await pending, cancelled: cancel.signalled, state, view,
    afterCancel: state.operations.filter(operation => operation.cancelled) };
};

const confirmed = { status: 'ok', outputs: { page: '7:DOC7', url: 'https://app.example.com/page', title: 'Fixture', screen: 2, screens: 4 } };

describe('cancellation between scroll measurements', () => {
  it.each(['cancel-during-rebind', 'cancel-after-first-measure'] as const)('%s stops before new browser work or scrolling', async mode => {
    const t = await scroll(mode);
    expect(t.cancelled).toBe(true); expect(t.outcome.status).toBe('cancelled'); expect(t.outcome.outputs).toBeUndefined();
    expect(t.afterCancel).toEqual([]); expect(t.state.scrolls).toEqual([]);
    expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]); expect(t.state.quietDisconnects).toBe(0);
  });

  it.each(['cancel-after-scroll', 'cancel-during-settlement'] as const)('%s preserves the confirmed scroll without starting later work', async mode => {
    const t = await scroll(mode);
    expect(t.cancelled).toBe(true); expect(t.outcome).toEqual(confirmed); expect(t.afterCancel).toEqual([]);
    expect(t.state.scrolls).toEqual([{ x: 5, y: 525, cancelled: false }]);
    expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 525]);
    // An observer already running when cancelled still cleans itself up.
    expect(t.state.quietDisconnects).toBe(mode === 'cancel-during-settlement' ? 1 : 0);
  });

  it.each(['normal', 'cancel-during-final-read'] as const)('preserves a %s completion', async mode => {
    const t = await scroll(mode);
    expect(t.cancelled).toBe(mode === 'cancel-during-final-read'); expect(t.outcome).toEqual(confirmed);
    expect(t.afterCancel).toEqual([]); expect(t.state.scrolls).toEqual([{ x: 5, y: 525, cancelled: false }]);
    expect(t.state.quietDisconnects).toBe(1);
  });

  it.each(['cancel-entry', 'cancel-during-identity'] as const)('preserves %s before scrolling', async mode => {
    const t = await scroll(mode);
    expect(t.cancelled).toBe(true); expect(t.outcome.status).toBe('cancelled'); expect(t.outcome.outputs).toBeUndefined();
    expect(t.afterCancel).toEqual([]); expect(t.state.scrolls).toEqual([]);
    expect([t.view.scrollX, t.view.scrollY]).toEqual([5, 120]);
  });
});
