import { afterEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_CLOSE_OUTPUT_KEYS, type BridgeCommand } from '@recued/contracts';
import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { chromePageTabs, pageIdentity, type PageTabsChrome } from '../actions/page-tabs.js';
import type { DocumentScripting } from '../actions/reviewed-document.js';

afterEach(() => vi.unstubAllGlobals());
type Mode = 'unreadable' | 'lost-identity' | 'remove-rejected' | 'remove-ack-lost' | 'success' | 'navigated' | 'owner';

// Real executor, tab lifecycle and identity functions. DOM, Chrome scripting
// and tab APIs are adapters; no real browser tabs are removed.
const runClose = async (mode: Mode) => {
  const protectedPage = mode === 'owner' || mode === 'unreadable';
  const url = protectedPage ? 'https://recued.example/client'
    : mode === 'navigated' ? 'https://app.example.com/next' : 'https://app.example.com/form';
  vi.stubGlobal('document', { title: protectedPage ? 'Owner' : 'Form', documentElement: {
    hasAttribute: (name: string) => name === 'data-recued-owner-surface' && protectedPage } });
  vi.stubGlobal('location', { href: url });
  let closed = false; let removals = 0; let identityRequests = 0;
  const tabs: PageTabsChrome = {
    async query() { return [{ id: 7, url }]; }, async create() { throw new Error('no tab creation expected'); },
    async get() { if (closed) throw new Error('no tab'); return { id: 7, url, status: 'complete' }; },
    async remove(id) {
      expect(id).toBe(7); removals++;
      if (mode === 'remove-rejected') throw new Error('Tabs cannot be edited right now');
      closed = true;
      if (mode === 'remove-ack-lost') throw new Error('removal acknowledgement lost');
    },
  };
  const scripting: DocumentScripting = {
    async executeScript({ func, args }) {
      expect(func).toBe(pageIdentity); identityRequests++;
      if (mode === 'unreadable') throw new Error('Cannot access contents of the page');
      const result = await func(...args);
      return mode === 'lost-identity' ? [] : [{ documentId: mode === 'navigated' ? 'DOC8' : 'DOC7', result }];
    },
  };
  const api: BridgeBrowserApi = {
    async findTabByUrlPattern() { return null; }, async executeScript() { return null; },
    async captureVisibleTab() { return null; }, async showNotification(id) { return id; },
    closePage: chromePageTabs(tabs, scripting).closePage,
  };
  const command: BridgeCommand = {
    command_id: 'close', recipe_run_id: 'run', step_id: 'step',
    ingredient: { publisher_id: 'fixture', slug: 'fixture', version: '1', surface_kind: 'authoring',
      domain_allowlist: ['*://*/*'], domain_allowlist_signature: 'fixture' },
    action: 'close_tab', target_domain_pattern: '*://*/*', args: { page: '7:DOC7' },
    expects_output_keys: [...BRIDGE_CLOSE_OUTPUT_KEYS], timeout_ms: 5_000, idempotency_key: 'close',
  };
  const outcome = await buildActionExecutor(api).execute({ action: 'close_tab', command, cancel: { signalled: false } });
  return { outcome, closed, removals, identityRequests };
};

describe('explicit tab closing lifecycle', () => {
  it.each(['unreadable', 'lost-identity'] as const)('refuses %s before requesting removal', async mode => {
    const t = await runClose(mode);
    expect(t.identityRequests).toBe(1);
    expect(t.removals).toBe(0); expect(t.closed).toBe(false);
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
    expect(t.outcome.outputs).toBeUndefined();
  });

  it.each(['remove-rejected', 'remove-ack-lost'] as const)('keeps %s uncertain without repeating removal', async mode => {
    const t = await runClose(mode);
    expect(t.identityRequests).toBe(1); expect(t.removals).toBe(1);
    expect(t.closed).toBe(mode === 'remove-ack-lost');
    expect(t.outcome).toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
    expect(t.outcome.outputs).toBeUndefined();
  });

  it.each(['success', 'navigated'] as const)('preserves an acknowledged close with %s identity', async mode => {
    const t = await runClose(mode);
    expect(t.identityRequests).toBe(1); expect(t.removals).toBe(1); expect(t.closed).toBe(true);
    expect(t.outcome).toEqual({ status: 'ok', outputs: { closed: true } });
  });

  it('preserves owner-page protection without requesting removal', async () => {
    const t = await runClose('owner');
    expect(t.identityRequests).toBe(1); expect(t.removals).toBe(0); expect(t.closed).toBe(false);
    expect(t.outcome).toEqual({ status: 'error', error: {
      code: 'tab_navigation_blocked', message: 'The owner client cannot be automated.' } });
  });
});
