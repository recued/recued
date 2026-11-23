import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromePageTabs, pageIdentity, type PageTabsChrome } from '../actions/page-tabs.js';
import { checkPageElement, readReadyCheck } from '../actions/page-wait.js';
import { pageChallenge } from '../actions/page-challenge.js';
import type { DocumentScripting } from '../actions/reviewed-document.js';

const URL_ = 'https://example.com/page';
const PATTERN = 'https://example.com/*';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());
const pause = async (ms: number) => { vi.setSystemTime(Date.now() + ms); };
const tabs = (get: PageTabsChrome['get']): PageTabsChrome => ({ query: async () => [],
  create: async () => ({ id: 7 }), get, remove: vi.fn(async () => undefined), reload: vi.fn(async () => undefined) });

describe('DOM-ready navigation', () => {
  it('requires DOMContentLoaded evidence while interactive, without requiring full resource loading', () => {
    const entry = { domContentLoadedEventEnd: 0 };
    vi.stubGlobal('document', { readyState: 'interactive', body: {}, title: 'App', documentElement: { hasAttribute: () => false } });
    vi.stubGlobal('location', { href: URL_ });
    vi.stubGlobal('performance', { getEntriesByType: () => [entry] });
    try {
      expect(pageIdentity(true)).toEqual({ not_ready: true });
      entry.domContentLoadedEventEnd = 750;
      expect(pageIdentity(true)).toEqual({ url: URL_, title: 'App', loading: true });
      expect(pageIdentity(false, true)).toEqual({ url: URL_, title: 'App', loading: true });
    } finally { vi.unstubAllGlobals(); }
  });
  it('waits through about:blank and an unready document, then answers before full loading', async () => {
    const injections: unknown[] = [];
    const api = tabs(async id => ({ id, status: 'loading', url: Date.now() < 100 ? 'about:blank' : URL_ }));
    const scripting: DocumentScripting = { executeScript: async input => {
      injections.push(input);
      return [{ documentId: 'NEW', result: Date.now() < 200 ? { not_ready: true } : { url: URL_, title: 'Ready', loading: true } }];
    } };
    const result = await chromePageTabs(api, scripting, pause).openPage(URL_, PATTERN, 1_000, undefined, { domReady: true });
    expect(result).toMatchObject({ status: 'ok', outputs: { page: '7:NEW', loading: true } });
    expect(Date.now()).toBe(200);
    expect(injections).toHaveLength(2);
    expect(injections[0]).toMatchObject({ injectImmediately: true, args: [true] });
  });

  it('keeps legacy opens waiting for full loading', async () => {
    const scripting: DocumentScripting = { executeScript: vi.fn(async () => [{ documentId: 'NEW', result: { url: URL_, title: 'Ready' } }]) };
    const api = tabs(async id => ({ id, status: Date.now() < 800 ? 'loading' : 'complete', url: URL_ }));
    expect(await chromePageTabs(api, scripting, pause).openPage(URL_, PATTERN, 1_000)).toMatchObject({ status: 'ok' });
    expect(Date.now()).toBe(800);
    expect(scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 7 }, func: pageIdentity, args: [] });
  });

  it('never accepts the outgoing document during a reload', async () => {
    const api = tabs(async id => ({ id, status: 'loading', url: URL_ }));
    const scripting: DocumentScripting = { executeScript: async () => [{ documentId: Date.now() < 200 ? 'OLD' : 'NEW',
      result: { url: URL_, title: 'Ready', loading: true } }] };
    const result = await chromePageTabs(api, scripting, pause).movePage(7, { to: 'reload' }, PATTERN, 1_000,
      undefined, { domReady: true, previousPage: '7:OLD' });
    expect(result).toMatchObject({ status: 'ok', outputs: { page: '7:NEW', loading: true } });
    expect(Date.now()).toBe(200);
  });

  it('closes an owner surface even while its assets are loading', async () => {
    const api = tabs(async id => ({ id, status: 'loading', url: URL_ }));
    const result = await chromePageTabs(api, { executeScript: async () => [{ documentId: 'OWNER', result: { blocked: true } }] }, pause)
      .openPage(URL_, PATTERN, 1_000, undefined, { domReady: true });
    expect(result).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
    expect(api.remove).toHaveBeenCalledWith(7);
  });
});

describe('predicate-driven click completion', () => {
  it('accepts existing batch selector/text lengths without narrowing their contract', () => {
    const check = { selector: '#' + 'a'.repeat(600), until: 'shown', text: 'x'.repeat(800) };
    expect(readReadyCheck(check)).toEqual(check);
    expect(readReadyCheck({ ...check, until: ['shown'] })).toBeNull();
  });
  const ready = { selector: '#results', until: 'shown' as const };
  const setup = (captcha = false) => {
    const api = tabs(async id => ({ id, status: 'complete', url: URL_ }));
    const scripting: DocumentScripting = { executeScript: async ({ func, args }) => [{ documentId: 'DOC',
      result: func === checkPageElement ? { outputs: { url: URL_, title: 'Results', met: Date.now() >= 100 } }
        : func === pageChallenge ? captcha ? 'CAPTCHA' : null : { url: URL_, title: 'Results' } }] };
    return chromePageTabs(api, scripting, pause);
  };

  it('keeps the 800 ms watch without opt-in, including when DOM readiness alone is enabled', async () => {
    await setup().pageAfterClick(7, { page: '7:DOC', url: URL_ }, PATTERN, { settleMs: 800, loadMs: 1_000 }, undefined,
      { domReady: true });
    expect(Date.now()).toBe(800);
  });

  it('stops at the explicit success predicate and checks failure signals first', async () => {
    const result = await setup().pageAfterClick(7, { page: '7:DOC', url: URL_ }, PATTERN,
      { settleMs: 800, loadMs: 1_000 }, undefined, { ready });
    expect(result).toMatchObject({ moved: false, page: '7:DOC' });
    expect(Date.now()).toBe(100);
    vi.setSystemTime(0);
    const failed = await setup(true).pageAfterClick(7, { page: '7:DOC', url: URL_ }, PATTERN,
      { settleMs: 800, loadMs: 1_000 }, undefined, { ready, challenge: true });
    expect(failed).toMatchObject({ challenge: 'CAPTCHA' });
    expect(Date.now()).toBe(0);
  });

  it('waits for a committed replacement when navigation starts before success', async () => {
    const api = tabs(async id => ({ id, status: Date.now() < 100 ? 'complete' : 'loading',
      url: Date.now() < 100 ? URL_ : URL_ + '/next' }));
    const scripting: DocumentScripting = { executeScript: async ({ func }) => [{ documentId: Date.now() < 200 ? 'DOC' : 'NEW',
      result: func === checkPageElement ? { outputs: { url: URL_, title: '', met: false } }
        : { url: Date.now() < 200 ? URL_ : URL_ + '/next', title: 'Next', loading: true } }] };
    const result = await chromePageTabs(api, scripting, pause).pageAfterClick(7, { page: '7:DOC', url: URL_ }, PATTERN,
      { settleMs: 800, loadMs: 1_000 }, undefined, { ready, domReady: true });
    expect(result).toMatchObject({ moved: true, page: '7:NEW', loading: true });
    expect(Date.now()).toBe(200);
  });
});
