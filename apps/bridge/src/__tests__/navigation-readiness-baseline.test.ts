import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeAction, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { chromePageTabs, pageGoBack, pageIdentity, type PageTabsChrome } from '../actions/page-tabs.js';
import type { DocumentScripting } from '../actions/reviewed-document.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
type Kind = 'navigate' | 'reload' | 'back';
type Mode = 'older-handle' | 'never-commits' | 'current-handle' | 'legacy' | 'fragment' | 'deferred';

// Real executor, tab lifecycle, identity and history functions. DOM, Chrome
// APIs, document commits and clock are controlled; no real navigation occurs.
const runMove = async (kind: Kind, mode: Mode) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
  const initial = 'https://app.example.com/current';
  const destination = mode === 'fragment' ? `${initial}#section` : kind === 'navigate' ? 'https://app.example.com/next'
    : kind === 'back' ? 'https://app.example.com/previous' : initial;
  const state = { requested: false, requests: [] as Kind[] };
  const committed = () => state.requested && mode !== 'never-commits' && mode !== 'fragment' && Date.now() >= 200;
  const documentId = () => committed() ? 'DOC9' : 'DOC8';
  const url = () => state.requested && (committed() || mode === 'fragment') ? destination : initial;
  const loading = () => state.requested && (mode === 'never-commits' || Date.now() < 800);
  vi.stubGlobal('document', {
    get title() { return committed() ? 'Replacement' : 'Initial'; },
    get readyState() { return committed() && loading() ? 'interactive' : 'complete'; },
    body: {}, documentElement: { hasAttribute: () => false },
  });
  vi.stubGlobal('location', { get href() { return url(); } });
  vi.stubGlobal('performance', { getEntriesByType: () => [{ domContentLoadedEventEnd:
    committed() && (mode !== 'deferred' || Date.now() >= 500) ? 200 : 0 }] });
  vi.stubGlobal('navigation', { canGoBack: true });
  const request = (operation: Kind) => { state.requested = true; state.requests.push(operation); };
  vi.stubGlobal('history', { back() { request('back'); } });
  const tabs: PageTabsChrome = {
    async query() { return []; }, async create() { throw new Error('No creation expected'); },
    async remove() { throw new Error('No removal expected'); },
    async get() { return { id: 7, status: loading() ? 'loading' : 'complete', url: url() }; },
    async update() { request('navigate'); }, async reload() { request('reload'); },
  };
  const scripting: DocumentScripting = {
    async executeScript({ func, args }) {
      if (func !== pageIdentity && func !== pageGoBack) throw new Error(`Unexpected script ${func.name}`);
      const id = documentId();
      return [{ documentId: id, result: await func(...args) }];
    },
  };
  const native = chromePageTabs(tabs, scripting, async ms => { vi.setSystemTime(Date.now() + ms); });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; }, movePage: native.movePage,
  };
  const action: BridgeAction = kind === 'navigate' ? 'navigate' : kind === 'reload' ? 'reload_page' : 'go_back';
  const command: BridgeCommand = {
    command_id: 'ready', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://app.example.com/*'], domain_allowlist_signature: 'fixture' },
    action, target_domain_pattern: 'https://app.example.com/*',
    args: { page: mode === 'current-handle' ? '7:DOC8' : '7:DOC0', ...(mode !== 'legacy' ? { dom_ready: true } : {}),
      ...(kind === 'navigate' ? { url: destination } : {}) },
    expects_output_keys: ['page', 'url', 'title', 'loading'], timeout_ms: 10_000, idempotency_key: 'ready',
  };
  const outcome = await buildActionExecutor(api).execute({ action, command, cancel: { signalled: false } });
  expect(state.requests).toEqual([kind]);
  return { outcome, at: Date.now(), committed: committed(), loading: loading(), destination };
};

describe('DOM-ready navigation uses its verified departure document', () => {
  it('waits for deferred scripts in the committed document without waiting for full resource loading', async () => {
    const t = await runMove('reload', 'deferred');
    expect(t.committed).toBe(true); expect(t.loading).toBe(true);
    expect(t.at).toBeGreaterThanOrEqual(500); expect(t.at).toBeLessThan(800);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC9', url: t.destination, title: 'Replacement', loading: true } });
  });
  it.each(['navigate', 'reload', 'back'] as const)('waits for committed %s replacement with an earlier handle', async kind => {
    const t = await runMove(kind, 'older-handle');
    expect(t.committed).toBe(true); expect(t.loading).toBe(true);
    expect(t.at).toBeGreaterThanOrEqual(200); expect(t.at).toBeLessThan(800);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC9', url: t.destination, title: 'Replacement', loading: true } });
  });

  it('keeps a loading reload uncertain at its deadline when no replacement commits', async () => {
    const t = await runMove('reload', 'never-commits');
    expect(t.committed).toBe(false); expect(t.loading).toBe(true); expect(t.at).toBeGreaterThanOrEqual(5_000);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
    expect(t.outcome.outputs).toBeUndefined();
  });

  it.each(['navigate', 'reload', 'back'] as const)('preserves early committed %s readiness with a current handle', async kind => {
    const t = await runMove(kind, 'current-handle');
    expect(t.committed).toBe(true); expect(t.loading).toBe(true);
    expect(t.at).toBeGreaterThanOrEqual(200); expect(t.at).toBeLessThan(800);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC9', url: t.destination, title: 'Replacement', loading: true } });
  });

  it('preserves legacy full-load waiting with an earlier handle', async () => {
    const t = await runMove('reload', 'legacy');
    expect(t.at).toBeGreaterThanOrEqual(800); expect(t.loading).toBe(false);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC9', url: t.destination, title: 'Replacement' } });
  });

  it('preserves a genuine fragment move in the same document', async () => {
    const t = await runMove('navigate', 'fragment');
    expect(t.committed).toBe(false); expect(t.loading).toBe(true); expect(t.at).toBeLessThan(800);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC8', url: t.destination, title: 'Initial' } });
  });
});
