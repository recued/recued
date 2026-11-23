import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeAction, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { chromePageTabs, pageGoBack, pageIdentity, type PageTabsChrome } from '../actions/page-tabs.js';
import type { DocumentScripting } from '../actions/reviewed-document.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
type Kind = 'navigate' | 'reload' | 'back';
type Mode = 'owner' | 'unreadable' | 'lost-identity' | 'newer-document';

// Real executor, tab lifecycle, identity and history functions. DOM, Chrome
// APIs and clock are adapters; no real browser requests or navigation occur.
const runMove = async (kind: Kind, mode: Mode) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
  const state = {
    owner: mode === 'owner', url: `https://app.example.com/${mode === 'owner' ? 'client' : 'current'}`,
    document: mode === 'newer-document' ? 'DOC8' : 'DOC0', updates: 0, reloads: 0, backs: 0,
  };
  const initial = { ...state };
  const requested = () => state.updates + state.reloads + state.backs > 0;
  vi.stubGlobal('document', {
    get title() { return state.owner ? 'Owner' : 'Ordinary'; },
    documentElement: { hasAttribute: (name: string) => name === 'data-recued-owner-surface' && state.owner },
  });
  vi.stubGlobal('location', { get href() { return state.url; } });
  vi.stubGlobal('navigation', { canGoBack: true });
  vi.stubGlobal('history', { back() {
    state.backs++; state.url = 'https://app.example.com/previous'; state.document = 'DOC9'; state.owner = false;
  } });
  const tabs: PageTabsChrome = {
    async query() { return []; }, async create() { throw new Error('No creation expected'); },
    async get() { return { id: 7, status: 'complete', url: state.url }; },
    async remove() { throw new Error('No removal expected'); },
    async update(_id, options) {
      state.updates++; state.url = options.url; state.document = 'DOC9'; state.owner = false;
    },
    async reload() { state.reloads++; state.document = 'DOC9'; },
  };
  const scripting: DocumentScripting = {
    async executeScript({ func, args }) {
      if (func !== pageIdentity && func !== pageGoBack) throw new Error(`Unexpected script ${func.name}`);
      if (func === pageIdentity && !requested()) {
        if (mode === 'unreadable') throw new Error('Cannot access contents of the page');
        if (mode === 'lost-identity') return [];
      }
      const documentId = state.document;
      return [{ documentId, result: await func(...args) }];
    },
  };
  const native = chromePageTabs(tabs, scripting, async ms => { vi.setSystemTime(Date.now() + ms); });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; }, movePage: native.movePage,
  };
  const action: BridgeAction = kind === 'navigate' ? 'navigate' : kind === 'reload' ? 'reload_page' : 'go_back';
  const command: BridgeCommand = {
    command_id: 'move', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://app.example.com/*'], domain_allowlist_signature: 'fixture' },
    action, target_domain_pattern: 'https://app.example.com/*',
    args: { page: '7:DOC0', ...(kind === 'navigate' ? { url: 'https://app.example.com/next' } : {}) },
    expects_output_keys: ['page', 'url', 'title', 'loading'], timeout_ms: 10_000, idempotency_key: 'move',
  };
  const outcome = await buildActionExecutor(api).execute({ action, command, cancel: { signalled: false } });
  return { outcome, initial, state };
};

describe('tab navigation eligibility before a request', () => {
  for (const mode of ['owner', 'unreadable', 'lost-identity'] as const) {
    it.each(['navigate', 'reload', 'back'] as const)(`refuses %s on a ${mode} page without moving it`, async kind => {
      const t = await runMove(kind, mode);
      expect(t.state).toEqual(t.initial);
      expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
      expect(t.outcome.outputs).toBeUndefined();
    });
  }

  it.each(['navigate', 'reload', 'back'] as const)('preserves %s when an ordinary tab has a newer document', async kind => {
    const t = await runMove(kind, 'newer-document');
    expect(t.state).toMatchObject({ updates: kind === 'navigate' ? 1 : 0,
      reloads: kind === 'reload' ? 1 : 0, backs: kind === 'back' ? 1 : 0, document: 'DOC9' });
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC9', title: 'Ordinary', url:
      kind === 'navigate' ? 'https://app.example.com/next' : kind === 'back'
        ? 'https://app.example.com/previous' : 'https://app.example.com/current' } });
  });
});
