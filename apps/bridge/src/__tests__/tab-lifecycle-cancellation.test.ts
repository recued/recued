import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeAction, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { chromePageTabs, pageGoBack, pageIdentity, type PageTabsChrome } from '../actions/page-tabs.js';
import type { DocumentScripting } from '../actions/reviewed-document.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
type Kind = 'close' | 'navigate' | 'reload' | 'back';
type Mode = 'cancel-identity' | 'cancel-tab-read' | 'cancel-after-request' | 'cancel-lost-ack';

// Real executor, tab lifecycle, identity and history functions. DOM, Chrome
// APIs and clock are controlled; no real tabs are navigated or removed.
const runTab = async (kind: Kind, mode: Mode) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
  const cancel = { signalled: false };
  const state = { open: true, url: 'https://app.example.com/current', document: 'DOC8', gets: 0, identityChecks: 0,
    actions: [] as Array<{ kind: Kind; tab: number; cancelled: boolean }> };
  const initial = { open: state.open, url: state.url, document: state.document };
  const effect = (action: Kind, tab = 7) => {
    state.actions.push({ kind: action, tab, cancelled: cancel.signalled }); state.document = 'DOC9';
    cancel.signalled = true;
  };
  const acknowledge = () => { if (mode === 'cancel-lost-ack') throw new Error('Request acknowledgement lost'); };
  vi.stubGlobal('document', { title: 'Fixture', documentElement: { hasAttribute: () => false } });
  vi.stubGlobal('location', { get href() { return state.url; } });
  vi.stubGlobal('navigation', { canGoBack: true });
  vi.stubGlobal('history', { back() { effect('back'); state.url = 'https://app.example.com/previous'; } });
  const tabs: PageTabsChrome = {
    async query() { return []; }, async create() { throw new Error('No creation expected'); },
    async get() {
      state.gets++;
      if (!state.open) throw new Error('Tab closed');
      if (mode === 'cancel-tab-read' && state.actions.length === 0) cancel.signalled = true;
      return { id: 7, url: state.url, status: 'complete' };
    },
    async remove(id) { effect('close', id); state.open = false; acknowledge(); },
    async update(id, options) { effect('navigate', id); state.url = options.url; acknowledge(); },
    async reload(id) { effect('reload', id); acknowledge(); },
  };
  const scripting: DocumentScripting = {
    async executeScript({ target, func, args }) {
      if (func !== pageIdentity && func !== pageGoBack) throw new Error(`Unexpected script ${func.name}`);
      expect(target.tabId).toBe(7);
      if (func === pageIdentity) state.identityChecks++;
      const documentId = state.document;
      const result = await func(...args);
      if (func === pageIdentity && state.actions.length === 0 && mode === 'cancel-identity') cancel.signalled = true;
      if (func === pageGoBack) acknowledge();
      return [{ documentId, result }];
    },
  };
  const native = chromePageTabs(tabs, scripting, async ms => { vi.setSystemTime(Date.now() + ms); });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    movePage: native.movePage, closePage: native.closePage,
  };
  const action: BridgeAction = kind === 'close' ? 'close_tab' : kind === 'navigate' ? 'navigate' : kind === 'reload' ? 'reload_page' : 'go_back';
  const command: BridgeCommand = {
    command_id: 'tab', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://app.example.com/*'], domain_allowlist_signature: 'fixture' },
    action, target_domain_pattern: 'https://app.example.com/*',
    args: { page: '7:DOC0', ...(kind === 'navigate' ? { url: 'https://app.example.com/next' } : {}) },
    expects_output_keys: kind === 'close' ? ['closed'] : ['page', 'url', 'title', 'loading'],
    timeout_ms: 10_000, idempotency_key: 'tab',
  };
  const outcome = await buildActionExecutor(api).execute({ action, command, cancel });
  return { outcome, state, initial, cancelled: cancel.signalled };
};

describe('existing-tab lifecycle cancellation', () => {
  it.each(['close', 'navigate', 'reload', 'back'] as const)('cancellation during identity preflight prevents %s', async kind => {
    const t = await runTab(kind, 'cancel-identity');
    expect(t.cancelled).toBe(true); expect(t.state.identityChecks).toBe(1); expect(t.state.actions).toEqual([]);
    expect({ open: t.state.open, url: t.state.url, document: t.state.document }).toEqual(t.initial);
    expect(t.outcome).toMatchObject({ status: 'cancelled' }); expect(t.outcome.outputs).toBeUndefined();
  });

  it('cancellation while reading the tab stops further navigation preflight', async () => {
    const t = await runTab('navigate', 'cancel-tab-read');
    expect(t.cancelled).toBe(true); expect(t.state.gets).toBe(1); expect(t.state.identityChecks).toBe(0);
    expect(t.state.actions).toEqual([]);
    expect({ open: t.state.open, url: t.state.url, document: t.state.document }).toEqual(t.initial);
    expect(t.outcome).toMatchObject({ status: 'cancelled' }); expect(t.outcome.outputs).toBeUndefined();
  });

  it.each(['close', 'navigate', 'reload', 'back'] as const)('preserves a confirmed %s receipt after cancellation', async kind => {
    const t = await runTab(kind, 'cancel-after-request');
    expect(t.cancelled).toBe(true); expect(t.state.actions).toEqual([{ kind, tab: 7, cancelled: false }]);
    expect(t.outcome).toEqual(kind === 'close' ? { status: 'ok', outputs: { closed: true } } : { status: 'ok', outputs: {
      page: '7:DOC9', title: 'Fixture', url: kind === 'navigate' ? 'https://app.example.com/next' : kind === 'back'
        ? 'https://app.example.com/previous' : 'https://app.example.com/current' } });
    if (kind === 'close') expect(t.state.open).toBe(false);
  });

  it.each(['close', 'navigate'] as const)('preserves uncertainty after a cancelled %s request loses its acknowledgement', async kind => {
    const t = await runTab(kind, 'cancel-lost-ack');
    expect(t.cancelled).toBe(true); expect(t.state.actions).toEqual([{ kind, tab: 7, cancelled: false }]);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
    expect(t.outcome.outputs).toBeUndefined();
  });
});
