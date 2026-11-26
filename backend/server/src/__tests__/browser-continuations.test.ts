import { expect, it, vi } from 'vitest';
import { createBrowserContinuations } from '../bridges/browser-continuations.js';
import { createBridgeDomAdapter } from '../bridges/dom-adapter.js';
import { createPageReadStore } from '../bridges/page-outline.js';
import { KERNEL_MANIFESTS } from '../kernel-manifests.js';
import type { DispatchOutcome, DispatchRequest } from '../bridges/dispatcher.js';

it('follows only one proven tab within its caller, bridge and expiration boundaries', () => {
  let now = 0;
  const cache = createBrowserContinuations(() => now);
  const initial = { page: 'bridge:A:7:ROOT', url: 'https://example.org/app/' };
  cache.observe('owner/turn1', initial);
  cache.observe('owner/turn1', { page: 'bridge:A:7:LOGIN', url: 'https://example.org/login' });
  expect(cache.resolve('owner/turn1', initial.url)).toEqual({ page: 'bridge:A:7:LOGIN', url: 'https://example.org/login', moved: true });
  expect(cache.resolve('other/turn1', initial.url)).toBeUndefined();
  expect(cache.resolve('owner/turn2', initial.url)).toBeUndefined();
  expect(cache.resolve('owner/turn1', initial.url, 'B')).toBeUndefined();
  cache.observe('owner/turn1', { ...initial, page: 'bridge:B:9:ROOT' });
  expect(() => cache.resolve('owner/turn1', initial.url)).toThrow('more than one');
  expect(cache.resolve('owner/turn1', initial.url, 'A')?.page).toBe('bridge:A:7:LOGIN');
  now = 10 * 60_000;
  expect(cache.resolve('owner/turn1', initial.url, 'A')).toBeUndefined();
});

it('keeps uncertain actions blocked until an actual read, even after metadata arrives', () => {
  const cache = createBrowserContinuations(), page = 'bridge:A:7:ROOT', url = 'https://example.org/app/';
  cache.observe('owner', { page, url }); cache.uncertain('owner', page);
  cache.observe('owner', { page, url, title: 'Metadata' });
  expect(() => cache.resolve('owner', url)).toThrow('uncertain');
  cache.observe('owner', { page, url }, undefined, true);
  expect(cache.resolve('owner', url)?.page).toBe(page);
});

it('looks up a requested route afresh after the same document changes fragments', () => {
  const cache = createBrowserContinuations(), page = 'bridge:A:7:ROOT';
  const overview = 'https://example.org/app/#/overview';
  const detail = 'https://example.org/app/#/detail';
  cache.observe('owner', { page, url: overview });
  expect(cache.resolve('owner', detail)).toBeUndefined();
  cache.observe('owner', { page, url: detail });
  expect(cache.resolve('owner', overview)).toBeUndefined();
  expect(cache.resolve('owner', detail)).toEqual({ page, url: detail, moved: false });
});

it('continues a read on the navigated document and rejects URL/ref batches before an earlier fill', async () => {
  const url = 'https://example.org/app/';
  const dispatch = vi.fn(async (request: DispatchRequest): Promise<DispatchOutcome> => ({
    kind: 'completed', bridge_client_token_id: 'A', attempts: 1,
    result: { command_id: 'c', duration_ms: 1, bridge_version: '0.0.12', idempotency_key_seen: false, status: 'ok',
      outputs: { page: String(request.args.page), url: request.args.page === '7:ROOT' ? url : 'https://example.org/login',
        title: 'App', html: '<main><input ref="e2" id="email"><button ref="e3">Login</button></main>', truncated: false, loading: false } },
  }));
  const adapter = createBridgeDomAdapter({ manifests: { get: slug => KERNEL_MANIFESTS.find(m => m.slug === slug) ?? null },
    pageReads: createPageReadStore(), getDispatcher: () => ({ dispatch, cancel: vi.fn(), canResolve: () => true }) });
  const read = (page: string) => adapter({ slug: 'dom-inspect', risk_tier: 'read', input: { target: '*://*/*', page, form: 'outline' }, output: {} });
  await read('7:ROOT'); await read('7:LOGIN');
  dispatch.mockClear();
  await adapter({ slug: 'dom-act', risk_tier: 'read', input: { target: '*://*/*', page: url, steps: [{ do: 'read' }] }, output: {} });
  expect(dispatch.mock.calls.every(([request]) => request.args.page === '7:LOGIN')).toBe(true);
  expect(dispatch.mock.calls.some(([request]) => ['list_tabs', 'open_tab'].includes(request.action))).toBe(false);
  dispatch.mockClear();
  await expect(adapter({ slug: 'dom-act', risk_tier: 'write', input: { target: '*://*/*', page: url,
    steps: [{ do: 'type', selector: '#email', value: 'owner@example.org' }, { do: 'click', ref: 'e3' }] }, output: {} }))
    .rejects.toMatchObject({ code: 'DOM_SELECTOR_MISSING', details: { executed: false } });
  // One diagnostic view is allowed; none of the planned fill/click steps ran.
  expect(dispatch.mock.calls.map(([request]) => ({ action: request.action, page: request.args.page })))
    .toEqual([{ action: 'reread', page: '7:LOGIN' }]);
});
