import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { chromePageTabs, pageGoBack, pageIdentity, type PageTabsChrome } from '../actions/page-tabs.js';
import type { DocumentScripting } from '../actions/reviewed-document.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
type Mode = 'empty-results' | 'missing-result' | 'malformed-result' | 'contradictory-result'
  | 'wrong-document' | 'unbound-no-history' | 'acknowledged' | 'no-history' | 'same-url' | 'newer-document';

// Real executor, tab lifecycle, identity and history functions. DOM, Chrome
// APIs, receipt transport and clock are adapters; no real browser navigation occurs.
const runBack = async (mode: Mode) => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0);
  const state = { url: 'https://app.example.com/current', document: mode === 'newer-document' ? 'DOC8' : 'DOC0',
    scriptRequests: 0, backRequests: 0 };
  vi.stubGlobal('document', { title: 'Fixture', documentElement: { hasAttribute: () => false } });
  vi.stubGlobal('location', { get href() { return state.url; } });
  vi.stubGlobal('navigation', { canGoBack: !['no-history', 'unbound-no-history'].includes(mode) });
  vi.stubGlobal('history', { back() {
    state.backRequests++;
    if (mode !== 'same-url') { state.url = 'https://app.example.com/previous'; state.document = 'DOC9'; }
  } });
  const tabs: PageTabsChrome = {
    async query() { return []; }, async create() { throw new Error('No creation expected'); },
    async remove() { throw new Error('No removal expected'); },
    async get() { return { id: 7, status: 'complete', url: state.url }; },
  };
  const scripting: DocumentScripting = {
    async executeScript({ func, args }) {
      const documentId = state.document;
      if (func === pageIdentity) return [{ documentId, result: await func(...args) }];
      if (func !== pageGoBack) throw new Error(`Unexpected script ${func.name}`);
      state.scriptRequests++;
      if (mode === 'empty-results') return [];
      const result = await func(...args);
      if (mode === 'missing-result') return [{ documentId, result: undefined }];
      if (mode === 'malformed-result') return [{ documentId, result: { going: 'true' } }];
      if (mode === 'contradictory-result') return [{ documentId, result: { going: true, nowhere: true } }];
      if (mode === 'wrong-document') return [{ documentId: 'UNRELATED', result }];
      if (mode === 'unbound-no-history') return [{ result }];
      return [{ documentId, result }];
    },
  };
  const native = chromePageTabs(tabs, scripting, async ms => { vi.setSystemTime(Date.now() + ms); });
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; }, movePage: native.movePage,
  };
  const command: BridgeCommand = {
    command_id: 'back', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['https://app.example.com/*'], domain_allowlist_signature: 'fixture' },
    action: 'go_back', target_domain_pattern: 'https://app.example.com/*', args: { page: '7:DOC0' },
    expects_output_keys: ['page', 'url', 'title', 'loading'], timeout_ms: 10_000, idempotency_key: 'back',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'go_back', command, cancel: { signalled: false } });
  return { outcome, state };
};

describe('Back acknowledgements', () => {
  it.each(['empty-results', 'missing-result', 'malformed-result', 'contradictory-result',
    'wrong-document', 'unbound-no-history'] as const)('keeps %s uncertain without replaying Back', async mode => {
    const t = await runBack(mode);
    expect(t.state.scriptRequests).toBe(1);
    expect(t.state.backRequests).toBe(mode === 'empty-results' || mode === 'unbound-no-history' ? 0 : 1);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
    expect(t.outcome.outputs).toBeUndefined();
  });

  it.each(['acknowledged', 'same-url', 'newer-document'] as const)('preserves valid %s Back', async mode => {
    const t = await runBack(mode);
    expect(t.state).toMatchObject({ scriptRequests: 1, backRequests: 1 });
    expect(t.outcome).toEqual({ status: 'ok', outputs: { page: mode === 'same-url' ? '7:DOC0' : '7:DOC9', title: 'Fixture',
      url: mode === 'same-url' ? 'https://app.example.com/current' : 'https://app.example.com/previous' } });
  });

  it('preserves a verified no-history refusal without asking history to move', async () => {
    const t = await runBack('no-history');
    expect(t.state).toMatchObject({ scriptRequests: 1, backRequests: 0, document: 'DOC0' });
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'unknown',
      message: 'The tab has no page to go back to.' } });
    expect(t.outcome.outputs).toBeUndefined();
  });
});
