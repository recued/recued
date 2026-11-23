import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeAction, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { chromePageTabs, pageGoBack, pageIdentity, type PageTabsChrome } from '../actions/page-tabs.js';
import type { DocumentScripting } from '../actions/reviewed-document.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
type Kind = 'open' | 'navigate' | 'reload' | 'back';

// Real executor, tab lifecycle, identity and history functions. DOM, Chrome
// APIs and clock are adapters; no real browser requests or navigation occur.
const runNavigation = async (kind: Kind, lost = false, preflight?: 'invalid-url' | 'no-history') => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
  const initial = 'https://app.example.com/current'; const next = 'https://app.example.com/next';
  const previous = 'https://app.example.com/previous';
  const state = { url: initial, document: 'DOC0', creates: 0, updates: 0, reloads: 0, backs: 0 };
  const effect = () => { state.document = 'DOC1'; if (lost) throw new Error('acknowledgement lost after request'); };
  vi.stubGlobal('document', { title: 'Fixture', documentElement: { hasAttribute: () => false } });
  vi.stubGlobal('location', { get href() { return state.url; } });
  vi.stubGlobal('navigation', { canGoBack: preflight !== 'no-history' });
  vi.stubGlobal('history', { back() { state.backs++; state.url = previous; state.document = 'DOC1'; } });
  const tabs: PageTabsChrome = {
    async query() { return []; }, async create() { state.creates++; state.url = next; effect(); return { id: 7 }; },
    async get() { return { id: 7, status: 'complete', url: state.url }; },
    async remove() { throw new Error('no removal expected'); },
    async update(_id, options) { state.updates++; state.url = options.url; effect(); },
    async reload() { state.reloads++; effect(); },
  };
  const scripting: DocumentScripting = {
    async executeScript({ func, args }) {
      if (![pageGoBack, pageIdentity].some(f => f === func)) throw new Error(`unexpected script ${func.name}`);
      const documentId = state.document;
      const result = await func(...args);
      if (func === pageGoBack && lost && state.backs > 0) throw new Error('back acknowledgement lost');
      return [{ documentId, result }];
    },
  };
  const native = chromePageTabs(tabs, scripting, async ms => { vi.setSystemTime(Date.now() + ms); });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    openPage: native.openPage, movePage: native.movePage,
  };
  const action: BridgeAction = kind === 'open' ? 'open_tab' : kind === 'navigate' ? 'navigate' : kind === 'reload' ? 'reload_page' : 'go_back';
  const command: BridgeCommand = {
    command_id: 'nav', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://app.example.com/*'], domain_allowlist_signature: 'fixture' },
    action, target_domain_pattern: 'https://app.example.com/*',
    args: { ...(kind !== 'open' ? { page: '7:DOC0' } : {}),
      ...(['open', 'navigate'].includes(kind) ? { url: preflight === 'invalid-url' ? 'javascript:alert(1)' : next } : {}) },
    expects_output_keys: ['page', 'url', 'title', 'loading'], timeout_ms: 10_000, idempotency_key: 'nav',
  };
  const outcome = await buildActionExecutor(api).execute({ action, command, cancel: { signalled: false } });
  return { outcome, state };
};

const operation = (kind: Kind) => kind === 'open' ? 'creates' : kind === 'navigate' ? 'updates' : kind === 'reload' ? 'reloads' : 'backs';

describe('tab creation and navigation acknowledgements', () => {
  it.each(['open', 'navigate', 'reload', 'back'] as const)('keeps a lost %s acknowledgement uncertain without replay', async kind => {
    const t = await runNavigation(kind, true);
    expect(t.state[operation(kind)]).toBe(1); expect(t.state.document).toBe('DOC1');
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
    expect(t.outcome.outputs).toBeUndefined();
  });

  it.each(['open', 'navigate', 'reload', 'back'] as const)('preserves an acknowledged %s operation', async kind => {
    const t = await runNavigation(kind);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: '7:DOC1', title: 'Fixture', url:
      kind === 'back' ? 'https://app.example.com/previous' : kind === 'reload' ? 'https://app.example.com/current' : 'https://app.example.com/next' } });
    expect(t.state[operation(kind)]).toBe(1);
  });

  it.each(['invalid-url', 'no-history'] as const)('preserves the confirmed %s refusal', async preflight => {
    const t = await runNavigation(preflight === 'invalid-url' ? 'open' : 'back', false, preflight);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: preflight === 'invalid-url' ? 'tab_navigation_blocked' : 'unknown' } });
    expect(t.state).toMatchObject({ creates: 0, updates: 0, reloads: 0, backs: 0, document: 'DOC0' });
  });
});
