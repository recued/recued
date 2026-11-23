/** D-335 slice C — the tab list and a newly opened tab, where Chrome cannot be
 *  made to misbehave on cue: a page still loading at the deadline, a tab that
 *  closes, a browser that opens a tab without saying which. What happens in
 *  real Chrome is pinned by `backend/server/src/__tests__/bridge-page-inspect-browser.test.ts`. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_TABS_MAX } from '@recued/contracts';
import { pageChallenge } from '../actions/page-challenge.js';
import { PAGE_MESSAGE_RULES, pageProblem } from '../actions/page-problems.js';
import { checkPageElement } from '../actions/page-wait.js';
import { chromePageTabs, documentState, pageGoBack, pageIdentity, type PageTabsChrome } from '../actions/page-tabs.js';
import type { DocumentScripting } from '../actions/reviewed-document.js';

const PATTERN = 'https://app.example.com/*';
const URL_OF = (tab: number) => `https://app.example.com/${tab}`;

const bind = (overrides: Partial<PageTabsChrome> = {}) => {
  const removed: number[] = [];
  const tabs: PageTabsChrome = {
    query: async () => [],
    create: async () => ({ id: 9 }),
    get: async id => ({ id, status: 'complete', url: URL_OF(id) }),
    remove: async id => { removed.push(id); },
    ...overrides,
  };
  const scripting: DocumentScripting = {
    executeScript: async ({ target }) => [{ documentId: `DOC${target.tabId}`,
      result: { url: URL_OF(target.tabId), title: `Tab ${target.tabId}` } }],
  };
  return { removed, ...chromePageTabs(tabs, scripting, async () => undefined) };
};

describe('the tab list', () => {
  it('asks for metadata immediately, preserving loading and a real document handle', async () => {
    const scripted: number[] = [];
    const tabs: PageTabsChrome = { query: async () => [1, 2, 3, 4].map(id => ({ id })),
      create: async () => ({}), get: async () => ({}), remove: async () => undefined };
    const scripting: DocumentScripting = { executeScript: async request => {
      expect(request.injectImmediately).toBe(true);
      expect(request.args).toEqual([false, true]);
      scripted.push(request.target.tabId);
      return [{ ...(request.target.tabId === 3 ? {} : { documentId: `DOC${request.target.tabId}` }),
        result: request.target.tabId === 2 ? { blocked: true } : { url: request.target.tabId === 4 ? 'https://other.example/' : URL_OF(1),
          title: 'Still loading', loading: true } }];
    } };
    expect(await chromePageTabs(tabs, scripting).listPages(PATTERN)).toEqual({ tabs: [
      { page: '1:DOC1', url: URL_OF(1), title: 'Still loading', loading: true },
    ], truncated: false });
    expect(scripted).toEqual([1, 2, 3, 4]);
  });

  it(`lists at most ${BRIDGE_TABS_MAX} tabs, and says when there were more`, async () => {
    const { listPages } = bind({ query: async () => Array.from({ length: BRIDGE_TABS_MAX + 1 }, (_, i) => ({ id: i + 1 })) });
    const listed = await listPages(PATTERN);
    expect(listed.tabs).toHaveLength(BRIDGE_TABS_MAX);
    expect(listed.truncated).toBe(true);
    expect(listed.tabs[0]).toEqual({ page: '1:DOC1', url: URL_OF(1), title: 'Tab 1' });
  });
});

describe('a newly opened tab, once the address has been asked for', () => {
  const uncertain = (message: string) => ({ status: 'error', error: { code: 'delivery_uncertain', message } });

  it('a page still loading at the deadline is uncertain, and its tab is left open', async () => {
    const { openPage, removed } = bind({ get: async id => ({ id, status: 'loading', url: '' }) });
    expect(await openPage(URL_OF(1), PATTERN, 20)).toEqual(uncertain(
      'The tab opened, but its page had not finished loading. List the tabs, or inspect it, before opening it again.'));
    expect(removed).toEqual([]);
  });

  // A new tab shows a blank page until the address commits; that is no redirect.
  it('waits through the blank page a new tab starts with', async () => {
    let looks = 0;
    const { openPage } = bind({ get: async id => (++looks < 3 ? { id, status: 'loading', url: 'about:blank' }
      : { id, status: 'complete', url: URL_OF(id) }) });
    expect(await openPage(URL_OF(9), PATTERN, 5_000)).toEqual({ status: 'ok',
      outputs: { page: '9:DOC9', url: URL_OF(9), title: 'Tab 9' } });
  });

  it('a tab that closes while loading, or that the browser does not name, is uncertain', async () => {
    expect(await bind({ get: async () => { throw new Error('No tab with id: 9'); } }).openPage(URL_OF(1), PATTERN, 5_000))
      .toEqual(uncertain('The tab closed before its page could be read.'));
    expect(await bind({ create: async () => ({}) }).openPage(URL_OF(1), PATTERN, 5_000)).toEqual(uncertain(
      'The browser may have opened the tab without saying which. List the tabs before opening it again.'));
  });

  // In real Chrome the test pages share a host the Bridge may script, so this
  // check is the only thing that closes a tab on a site it may not.
  it('a page that went on to a site the Bridge may not script has its tab closed', async () => {
    const removed: number[] = [];
    const tabs: PageTabsChrome = { query: async () => [], create: async () => ({ id: 9 }),
      get: async id => ({ id, status: 'complete', url: 'https://elsewhere.example.net/landing' }),
      remove: async id => { removed.push(id); } };
    const { openPage } = chromePageTabs(tabs,
      { executeScript: async () => { throw new Error('Cannot access contents of the page.'); } }, async () => undefined);
    expect(await openPage(URL_OF(1), PATTERN, 5_000)).toEqual({ status: 'error', error: { code: 'tab_navigation_blocked',
      message: 'The page went on to a site this step may not open, so its tab was closed.' } });
    expect(removed).toEqual([9]);
  });

  it('a rejected tab creation stays uncertain without retrying', async () => {
    const create = vi.fn(async () => { throw new Error('quota'); });
    expect(await bind({ create }).openPage(URL_OF(1), PATTERN, 5_000))
      .toMatchObject({ status: 'error', error: { code: 'delivery_uncertain' } });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

// D-335 slice G — the owner's list of sites Recued must never use.
describe('a site on the owner\'s list', () => {
  const listed = (url: string) => new URL(url).hostname.endsWith('listed.example');

  it('is left out of the tab list without its page ever being read', async () => {
    const injected: number[] = [];
    const tabs: PageTabsChrome = {
      query: async () => [{ id: 1, url: URL_OF(1) }, { id: 2, url: 'https://www.listed.example/inbox' }],
      create: async () => ({ id: 9 }), get: async id => ({ id }), remove: async () => undefined,
    };
    const scripting: DocumentScripting = {
      executeScript: async ({ target }) => {
        injected.push(target.tabId);
        return [{ documentId: `DOC${target.tabId}`, result: { url: URL_OF(target.tabId), title: `Tab ${target.tabId}` } }];
      },
    };
    const listedTabs = await chromePageTabs(tabs, scripting).listPages('*://*/*', listed);
    expect(listedTabs.tabs.map(tab => tab.page)).toEqual(['1:DOC1']);
    expect(injected).toEqual([1]);
  });

  it('a page the browser names nowhere else is still left out once it reads as a listed site', async () => {
    const { listPages } = bind({ query: async () => [{ id: 3 }] });
    expect((await listPages(PATTERN, url => url === URL_OF(3))).tabs).toEqual([]);
  });

  it('an opened page that lands on one has its tab closed, before or after it is read', async () => {
    const closed = { status: 'error', error: { code: 'tab_navigation_blocked',
      message: 'The page went on to a site the owner listed as one Recued must never use, so its tab was closed.' } };
    const early = bind({ get: async id => ({ id, status: 'complete', url: 'https://www.listed.example/landed' }) });
    expect(await early.openPage('https://app.example.com/go', '*://*/*', 5_000, listed)).toEqual(closed);
    expect(early.removed).toEqual([9]);
    // Chrome names no address; the page itself says where it is.
    const late = bind({ get: async id => ({ id, status: 'complete' }) });
    expect(await late.openPage(URL_OF(9), '*://*/*', 5_000, url => url === URL_OF(9))).toEqual(closed);
    expect(late.removed).toEqual([9]);
  });
});

describe('2026-11-04 — the page a tab shows once a click on it settles', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
  });
  afterEach(() => { vi.useRealTimers(); });
  const WAITS = { settleMs: 5, loadMs: 50 };
  /** A tab whose answers to chrome.tabs.get follow `states`, the last one repeating. A page asked
   *  whether it shows a CAPTCHA answers `captcha` (slice J) for the document `captchaOn` names; one
   *  asked for an error message or the step's failure (slice K) answers `trouble` for its document. */
  const after = (states: Array<{ status: string; url: string } | null>, documentId = 'DOC2', title = 'Results',
    captcha: { name: string; on: string } | null = null,
    trouble: { problem?: string; failed?: boolean; on: string } | null = null) => {
    let looks = 0;
    const reads: number[] = [];
    const asked: string[] = [];
    const tabs: PageTabsChrome = {
      query: async () => [], create: async () => ({ id: 9 }), remove: async () => undefined,
      get: async (id) => {
        const state = states[Math.min(looks++, states.length - 1)];
        if (state === null) throw new Error(`No tab with id: ${String(id)}`);
        return { id, ...state };
      },
    };
    const scripting: DocumentScripting = {
      executeScript: async ({ target, func }) => {
        if (func === pageChallenge) {
          const document = target.documentIds?.[0] ?? '';
          asked.push(document);
          return [{ documentId: document, result: captcha !== null && captcha.on === document ? captcha.name : null }];
        }
        if (func === pageProblem || func === checkPageElement) {
          const document = target.documentIds?.[0] ?? '';
          asked.push(`${func === pageProblem ? 'problem' : 'fail'}:${document}`);
          const here = trouble !== null && trouble.on === document;
          return [{ documentId: document, result: func === pageProblem ? (here ? trouble.problem ?? null : null)
            : { outputs: { url: URL_OF(1), title, met: here && trouble.failed === true } } }];
        }
        reads.push(target.tabId);
        const url = states[states.length - 1]?.url ?? '';
        return [{ documentId, result: url.includes('owner') ? { blocked: true } : { url, title } }];
      },
    };
    const sleep = async (ms: number) => { vi.setSystemTime(Date.now() + ms); };
    return { reads, asked, pageAfterClick: chromePageTabs(tabs, scripting, sleep).pageAfterClick };
  };

  it.each(['spa', 'pending-navigation', 'same-url', 'identity-url-mismatch', 'blocked'] as const)(
    'DOM-ready completion retains the current document only for a committed same-document route: %s', async mode => {
      const destination = mode === 'same-url' ? URL_OF(1) : URL_OF(2);
      const scripts: Array<{ immediate?: boolean; args?: readonly unknown[] }> = [];
      const tabs: PageTabsChrome = { query: async () => [], create: async () => { throw new Error('must not open'); },
        get: async () => ({ id: 1, status: 'loading', url: destination,
          ...(mode === 'pending-navigation' ? { pendingUrl: URL_OF(3) } : {}) }),
        remove: async () => { throw new Error('must not close'); } };
      const scripting: DocumentScripting = { executeScript: async request => {
        scripts.push({ immediate: request.injectImmediately, args: request.args });
        return [{ documentId: 'DOC1', result: { url: mode === 'identity-url-mismatch' ? URL_OF(1) : destination,
          title: 'Signed in', loading: true } }];
      } };
      const t = chromePageTabs(tabs, scripting, async () => undefined);
      const output = await t.pageAfterClick(1, { page: '1:DOC1', url: URL_OF(1) }, PATTERN,
        { settleMs: 0, loadMs: 0 }, mode === 'blocked' ? () => true : undefined, { domReady: true });
      expect(output).toEqual(mode === 'spa' ? { moved: true, page: '1:DOC1', url: URL_OF(2), title: 'Signed in', loading: true }
        : { moved: true });
      if (mode === 'spa') expect(scripts[0]).toEqual({ immediate: true, args: [true] });
    });

  it('a click that loads a page answers that page, by its new handle', async () => {
    const t = after([{ status: 'loading', url: URL_OF(1) }, { status: 'loading', url: URL_OF(2) },
      { status: 'complete', url: URL_OF(2) }]);
    expect(await t.pageAfterClick(1, { url: URL_OF(1) }, PATTERN, WAITS))
      .toEqual({ moved: true, page: '1:DOC2', url: URL_OF(2), title: 'Results' });
  });

  it('a click that loads nothing answers the page as it is', async () => {
    const t = after([{ status: 'complete', url: URL_OF(1) }], 'DOC1', 'Inbox');
    expect(await t.pageAfterClick(1, { url: URL_OF(1) }, PATTERN, WAITS))
      .toEqual({ moved: false, page: '1:DOC1', url: URL_OF(1), title: 'Inbox' });
  });

  it('says only that the page moved when it is still loading at the end; nothing for a tab that closed', async () => {
    expect(await after([{ status: 'loading', url: URL_OF(2) }]).pageAfterClick(1, { url: URL_OF(1) }, PATTERN, WAITS))
      .toEqual({ moved: true });
    expect(await after([null]).pageAfterClick(1, { url: URL_OF(1) }, PATTERN, WAITS)).toBeUndefined();
  });

  it('never reads a page the click took to a listed site, or off the step\'s sites', async () => {
    const listed = after([{ status: 'complete', url: 'https://app.example.com/bank' }]);
    expect(await listed.pageAfterClick(1, { url: URL_OF(1) }, PATTERN, WAITS, (url) => url.endsWith('/bank')))
      .toEqual({ moved: true });
    expect(listed.reads).toEqual([]);
    const elsewhere = after([{ status: 'complete', url: 'https://elsewhere.example.net/' }]);
    expect(await elsewhere.pageAfterClick(1, { url: URL_OF(1) }, PATTERN, WAITS)).toEqual({ moved: true });
    expect(elsewhere.reads).toEqual([]);
  });

  it('answers nothing of the owner client', async () => {
    expect(await after([{ status: 'complete', url: 'https://app.example.com/owner' }])
      .pageAfterClick(1, { url: URL_OF(1) }, PATTERN, WAITS)).toEqual({ moved: true });
  });

  it('slice J — names a CAPTCHA the page it lands on shows, only when asked', async () => {
    const states = [{ status: 'loading', url: URL_OF(1) }, { status: 'complete', url: URL_OF(2) }];
    const captcha = { name: 'hCaptcha', on: 'DOC2' };
    const asked = after(states, 'DOC2', 'Sign in', captcha);
    expect(await asked.pageAfterClick(1, { url: URL_OF(1), page: '1:DOC1' }, PATTERN, WAITS, undefined, { challenge: true }))
      .toEqual({ moved: true, page: '1:DOC2', url: URL_OF(2), title: 'Sign in', challenge: 'hCaptcha' });
    expect(asked.asked).toEqual(['DOC2']);
    const unasked = after(states, 'DOC2', 'Sign in', captcha);
    expect(await unasked.pageAfterClick(1, { url: URL_OF(1), page: '1:DOC1' }, PATTERN, WAITS))
      .toEqual({ moved: true, page: '1:DOC2', url: URL_OF(2), title: 'Sign in' });
    expect(unasked.asked).toEqual([]);
  });

  it('slice J — a CAPTCHA the clicked page comes to show ends a long watch, the page unmoved', async () => {
    const t = after([{ status: 'complete', url: URL_OF(1) }], 'DOC1', 'Sign in', { name: 'reCAPTCHA', on: 'DOC1' });
    const started = Date.now();
    expect(await t.pageAfterClick(1, { url: URL_OF(1), page: '1:DOC1' }, PATTERN, { settleMs: 8_000, loadMs: 50 },
      undefined, { challenge: true }))
      .toEqual({ moved: false, page: '1:DOC1', url: URL_OF(1), title: 'Sign in', challenge: 'reCAPTCHA' });
    // Seen at the first look, half a second in: not after the eight seconds it would watch.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(t.asked).toEqual(['DOC1']);
  });

  it('slice K — an error message the clicked page comes to show ends a long watch, quoted', async () => {
    const t = after([{ status: 'complete', url: URL_OF(1) }], 'DOC1', 'Sign in', null,
      { problem: 'Your password is invalid!', on: 'DOC1' });
    const started = Date.now();
    expect(await t.pageAfterClick(1, { url: URL_OF(1), page: '1:DOC1' }, PATTERN, { settleMs: 8_000, loadMs: 50 },
      undefined, { problems: PAGE_MESSAGE_RULES }))
      .toEqual({ moved: false, page: '1:DOC1', url: URL_OF(1), title: 'Sign in', problem: 'Your password is invalid!' });
    expect(Date.now() - started).toBe(500);
    expect(t.asked).toEqual(['problem:DOC1']);
  });

  it('slice K — the step\'s failure ends the watch too, and each check runs only when asked', async () => {
    const t = after([{ status: 'complete', url: URL_OF(1) }], 'DOC1', 'Sign in', null, { failed: true, on: 'DOC1' });
    expect(await t.pageAfterClick(1, { url: URL_OF(1), page: '1:DOC1' }, PATTERN, { settleMs: 8_000, loadMs: 50 },
      undefined, { challenge: true, fail: { selector: '.flash.error', until: 'shown' } }))
      .toEqual({ moved: false, page: '1:DOC1', url: URL_OF(1), title: 'Sign in', failed: true });
    // The CAPTCHA was asked, the failure was, and nothing asked for error messages.
    expect(t.asked).toEqual(['DOC1', 'fail:DOC1']);
  });

  it('slice K — a message that shows between the two asks: the step\'s own failure is asked once more, and both are reported', async () => {
    // A sign-in answers "Wrong password. Try again." just after the step's failure was asked: the first ask
    // finds nothing, the page's message is seen, and the failure asked again holds (it is the same words).
    // Asked once, this was reported as the message alone, the step's own `fail_when` lost (a real-Chrome
    // test that went red in sweeps now and then).
    let shown = false;
    const asked: string[] = [];
    const tabs: PageTabsChrome = { query: async () => [], create: async () => ({ id: 9 }), remove: async () => undefined,
      get: async (id) => ({ id, status: 'complete', url: URL_OF(1) }) };
    const scripting: DocumentScripting = {
      executeScript: async ({ target, func }) => {
        const document = target.documentIds?.[0] ?? 'DOC1';
        if (func === checkPageElement) {
          asked.push('fail');
          const met = shown;
          shown = true;
          return [{ documentId: document, result: { outputs: { url: URL_OF(1), title: 'Sign in', met } } }];
        }
        if (func === pageProblem) {
          asked.push('problem');
          return [{ documentId: document, result: shown ? 'Wrong password. Try again.' : null }];
        }
        return [{ documentId: 'DOC1', result: { url: URL_OF(1), title: 'Sign in' } }];
      },
    };
    const sleep = async (ms: number) => { vi.setSystemTime(Date.now() + ms); };
    const { pageAfterClick } = chromePageTabs(tabs, scripting, sleep);
    expect(await pageAfterClick(1, { url: URL_OF(1), page: '1:DOC1' }, PATTERN, { settleMs: 8_000, loadMs: 50 }, undefined,
      { fail: { selector: 'body', text: 'wrong password', until: 'shown' }, problems: PAGE_MESSAGE_RULES }))
      .toEqual({ moved: false, page: '1:DOC1', url: URL_OF(1), title: 'Sign in', failed: true, problem: 'Wrong password. Try again.' });
    expect(asked).toEqual(['fail', 'problem', 'fail']);
  });

  it('slice K — on a page the click loaded, the checks look once, there', async () => {
    const t = after([{ status: 'loading', url: URL_OF(1) }, { status: 'complete', url: URL_OF(1) }], 'DOC3', 'Sign in', null,
      { problem: 'Your password is invalid!', on: 'DOC3' });
    expect(await t.pageAfterClick(1, { url: URL_OF(1), page: '1:DOC1' }, PATTERN, WAITS, undefined,
      { problems: PAGE_MESSAGE_RULES }))
      .toEqual({ moved: true, page: '1:DOC3', url: URL_OF(1), title: 'Sign in', problem: 'Your password is invalid!' });
    expect(t.asked).toEqual(['problem:DOC3']);
  });

  it('slice J — a long watch ends as soon as the page starts moving', async () => {
    const t = after([{ status: 'complete', url: URL_OF(1) }, { status: 'complete', url: URL_OF(1) },
      { status: 'loading', url: URL_OF(1) }, { status: 'complete', url: URL_OF(3) }], 'DOC3', 'Welcome');
    const started = Date.now();
    expect(await t.pageAfterClick(1, { url: URL_OF(1), page: '1:DOC1' }, PATTERN, { settleMs: 8_000, loadMs: 2_000 },
      undefined, { challenge: true }))
      .toEqual({ moved: true, page: '1:DOC3', url: URL_OF(3), title: 'Welcome' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// D-335 slice R — a click by the handle of a frame from another site: the tab's address is the page
// around the frame, so the frame (Chrome's frame id) is what is watched and answered.
describe('D-335 slice R — a click in a frame, watched in that frame', () => {
  const WAITS = { settleMs: 5, loadMs: 50 };
  const SITES = 'https://*.example.com/*';
  const TAB = 'https://app.example.com/deals';
  const FORM = 'https://forms.example.com/f';
  /** A tab at TAB around frame 4, whose answers follow `frames`, the last repeating: its document,
   *  address and whether it has loaded, or null once Chrome has no such frame. */
  const framed = (frames: Array<{ doc: string; url: string; loaded?: boolean } | null>) => {
    let looks = 0;
    const read: string[] = [];
    const tabs: PageTabsChrome = { query: async () => [], create: async () => ({ id: 9 }), remove: async () => undefined,
      get: async id => ({ id, status: 'complete', url: TAB }) };
    const scripting: DocumentScripting = {
      executeScript: async ({ target, func }) => {
        if (target.frameIds !== undefined) {
          expect(target.frameIds).toEqual([4]);
          const state = frames[Math.min(looks, frames.length - 1)];
          if (func === documentState) looks += 1;
          if (state === null) throw new Error('No frame with id 4 in tab with id 1');
          if (func === pageIdentity) read.push(state.doc);
          return [{ documentId: state.doc, frameId: 4, result: func === documentState
            ? { url: state.url, loaded: state.loaded !== false } : { url: state.url, title: 'Form' } }];
        }
        read.push('tab');
        return [{ documentId: 'TOP2', frameId: 0, result: { url: TAB, title: 'Deals' } }];
      },
    };
    return { read, pageAfterClick: chromePageTabs(tabs, scripting, async () => undefined).pageAfterClick };
  };
  const before = { url: FORM, page: '1:F1', frame_id: 4 };

  it('a click that loads nothing there answers the frame\'s page as it is, though the tab shows another address', async () => {
    const t = framed([{ doc: 'F1', url: FORM }]);
    expect(await t.pageAfterClick(1, before, SITES, WAITS)).toEqual({ moved: false, page: '1:F1', url: FORM, title: 'Form' });
    // Without the frame, the tab's address differs from the frame's: read as a page the click loaded.
    expect(await framed([{ doc: 'F1', url: FORM }]).pageAfterClick(1, { url: FORM, page: '1:F1' }, SITES, WAITS))
      .toEqual({ moved: true, page: '1:TOP2', url: TAB, title: 'Deals' });
  });

  it('a click that loads another page in the frame answers that page, by its new handle, once it has loaded', async () => {
    const t = framed([{ doc: 'F1', url: FORM }, { doc: 'F2', url: `${FORM}?sent=1`, loaded: false },
      { doc: 'F2', url: `${FORM}?sent=1`, loaded: false }, { doc: 'F2', url: `${FORM}?sent=1` }]);
    expect(await t.pageAfterClick(1, before, SITES, WAITS))
      .toEqual({ moved: true, page: '1:F2', url: `${FORM}?sent=1`, title: 'Form' });
    expect(t.read).toEqual(['F2']);
  });

  it('a frame that has gone (the page around it loaded, or took it away) answers the tab\'s page, moved', async () => {
    const t = framed([{ doc: 'F1', url: FORM }, null]);
    expect(await t.pageAfterClick(1, before, SITES, WAITS)).toEqual({ moved: true, page: '1:TOP2', url: TAB, title: 'Deals' });
  });

  it('a frame the click took to a listed site, or off the step\'s sites, is never read', async () => {
    const listed = framed([{ doc: 'F2', url: 'https://forms.example.com/bank' }]);
    expect(await listed.pageAfterClick(1, before, SITES, WAITS, url => url.endsWith('/bank'))).toEqual({ moved: true });
    const elsewhere = framed([{ doc: 'F2', url: 'https://forms.example.net/f' }]);
    expect(await elsewhere.pageAfterClick(1, before, SITES, WAITS)).toEqual({ moved: true });
    expect([...listed.read, ...elsewhere.read]).toEqual([]);
  });
});

// D-335 slice X — a tab a batch moves (to an address, back, a reload) and closes. The tab is the
// owner's: a move that lands where the step may not read leaves it there.
describe('a tab moved and closed by a batch step', () => {
  /** A tab that answers `loading` for `loadingLooks` reads after the move, then its new address. */
  const moving = (landed: string, loadingLooks = 2, start = URL_OF(5)) => {
    const asked: string[] = [];
    let moved = false;
    let looks = 0;
    const removed: number[] = [];
    const tabs: PageTabsChrome = {
      query: async () => [],
      create: async () => ({ id: 9 }),
      get: async id => {
        if (!moved) return { id, status: 'complete', url: start };
        looks += 1;
        return looks <= loadingLooks ? { id, status: 'loading', url: start } : { id, status: 'complete', url: landed };
      },
      remove: async id => { removed.push(id); },
      update: async (id, { url }) => { asked.push(`update ${id} ${url}`); moved = true; },
      reload: async id => { asked.push(`reload ${id}`); moved = true; },
    };
    const scripting: DocumentScripting = {
      executeScript: async ({ target, func }) => {
        // Back is the page's own `history.back()`, run in the tab.
        if (func === pageGoBack) {
          asked.push(`back ${target.tabId}`);
          moved = true;
          return [{ documentId: `DOC${target.tabId}`, result: { going: true } }];
        }
        return [{ documentId: `DOC${target.tabId}${moved ? 'b' : ''}`, result: { url: moved ? landed : start, title: moved ? 'Landed' : 'Start' } }];
      },
    };
    return { asked, removed, ...chromePageTabs(tabs, scripting, async () => undefined) };
  };

  it('loads an address in the tab and answers the page it shows once loaded', async () => {
    const { movePage, asked } = moving(URL_OF(6));
    expect(await movePage(5, { to: 'address', url: URL_OF(6) }, PATTERN, 5_000)).toEqual({ status: 'ok',
      outputs: { page: '5:DOC5b', url: URL_OF(6), title: 'Landed' } });
    expect(asked).toEqual([`update 5 ${URL_OF(6)}`]);
  });

  it('goes back and reloads, waiting for the page the tab loads', async () => {
    const back = moving(URL_OF(4));
    expect(await back.movePage(5, { to: 'back' }, PATTERN, 5_000)).toMatchObject({ status: 'ok', outputs: { url: URL_OF(4) } });
    expect(back.asked).toEqual(['back 5']);
    // A reload keeps the address: what it waits for is the page loading again.
    const reload = moving(URL_OF(5), 3);
    expect(await reload.movePage(5, { to: 'reload' }, PATTERN, 5_000)).toMatchObject({ status: 'ok', outputs: { url: URL_OF(5) } });
    expect(reload.asked).toEqual(['reload 5']);
  });

  it('refuses an address that is not http or https, or off the step\'s sites, before the tab moves', async () => {
    const { movePage, asked } = moving(URL_OF(6));
    expect(await movePage(5, { to: 'address', url: 'javascript:alert(1)' }, PATTERN, 5_000)).toEqual({ status: 'error',
      error: { code: 'tab_navigation_blocked', message: 'Only an http or https address, without a user name or password, can be loaded.' } });
    expect(await movePage(5, { to: 'address', url: 'https://elsewhere.example.net/' }, PATTERN, 5_000)).toEqual({ status: 'error',
      error: { code: 'tab_navigation_blocked', message: 'The address is not on a site this step may open.' } });
    expect(asked).toEqual([]);
  });

  it('a page that went on where the step may not read is left there, open, and the answer says so', async () => {
    const { movePage, removed } = moving('https://elsewhere.example.net/landing');
    expect(await movePage(5, { to: 'address', url: URL_OF(6) }, PATTERN, 5_000)).toEqual({ status: 'error',
      error: { code: 'tab_navigation_blocked', message: 'The tab went on to a site this step may not read, so its page cannot be read.' } });
    expect(removed).toEqual([]);
    const listed = moving(URL_OF(6));
    expect(await listed.movePage(5, { to: 'address', url: URL_OF(6) }, PATTERN, 5_000, url => url === URL_OF(6))).toEqual({
      status: 'error', error: { code: 'tab_navigation_blocked', message: 'The owner listed this site as one Recued must never use.' } });
  });

  it('a back with nowhere to go says so; a page still loading at the deadline is uncertain', async () => {
    // The page's own `navigation.canGoBack` says there is none: nothing is asked of its history.
    const { movePage } = chromePageTabs({ query: async () => [], create: async () => ({ id: 9 }),
      get: async id => ({ id, status: 'complete', url: URL_OF(5) }), remove: async () => undefined },
    { executeScript: async ({ func }) => [{ documentId: 'DOC5', result: func === pageGoBack
      ? { nowhere: true } : { url: URL_OF(5), title: 'Start' } }] }, async () => undefined);
    expect(await movePage(5, { to: 'back' }, PATTERN, 5_000)).toEqual({ status: 'error',
      error: { code: 'unknown', message: 'The tab has no page to go back to.' } });
    const slow = moving(URL_OF(6), Number.POSITIVE_INFINITY);
    expect(await slow.movePage(5, { to: 'address', url: URL_OF(6) }, PATTERN, 30)).toEqual({ status: 'error',
      error: { code: 'delivery_uncertain', message: 'The tab started loading a page that had not finished in time. List the '
        + 'tabs, or inspect it, before moving it again.' } });
  });

  it('closes a tab, never the owner client\'s', async () => {
    const { closePage, removed } = moving(URL_OF(6));
    expect(await closePage(5)).toEqual({ status: 'ok', outputs: { closed: true } });
    expect(removed).toEqual([5]);
    const owner = chromePageTabs({ query: async () => [], create: async () => ({ id: 9 }), get: async id => ({ id }),
      remove: async () => { throw new Error('must not close'); } },
    { executeScript: async ({ target }) => [{ documentId: `DOC${target.tabId}`, result: { blocked: true } }] }, async () => undefined);
    expect(await owner.closePage(5)).toEqual({ status: 'error',
      error: { code: 'tab_navigation_blocked', message: 'The owner client cannot be automated.' } });
  });
});
