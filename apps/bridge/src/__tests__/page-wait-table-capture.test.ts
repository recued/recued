/** D-335 slice H — waiting, a table and a picture, as the executor runs them.
 *
 *  What each injected function does on a real page is pinned in real Chrome
 *  (`browser-toolkit-browser.test.ts`). These pin the executor's side: each
 *  needs a page handle, a wait is the service worker's loop and ends inside the
 *  command's budget, and a screenshot refuses before any tab moves and always
 *  puts the owner's tab back. */

import { describe, expect, it } from 'vitest';
import type { BridgeAction, BridgeCommand } from '@recued/contracts';

import { buildActionExecutor, type BridgeBrowserApi } from '../actions/executor.js';
import { capturePage, measurePageArea, PAGE_SCREEN_STEP, restorePageScroll, waitForPaint, waitForPictures,
  type PageCaptureChrome } from '../actions/page-capture.js';
import { scrollTarget, waitForQuiet } from '../actions/page-scroll.js';
import { PAGE_TABLE_LIMITS, readPageTable } from '../actions/page-table.js';
import { checkPageElement, readWaitRequest } from '../actions/page-wait.js';
import { pageProblem } from '../actions/page-problems.js';

const SITE = '*://app.example.com/*';
const PAGE_GONE = 'The page has reloaded, gone to another address or closed since it was read: '
  + 'list the tabs for its current page handle, then inspect it.';

const command = (action: BridgeAction, args: Record<string, unknown>, expects: readonly string[], timeout_ms = 30_000): BridgeCommand => ({
  command_id: 'cmd-1', recipe_run_id: 'run-1', step_id: 'step-1',
  ingredient: { publisher_id: 'recued', slug: 'dom-wait', version: '1', surface_kind: 'reading',
    domain_allowlist: [SITE], domain_allowlist_signature: 'PUB' },
  action, target_domain_pattern: SITE, args, expects_output_keys: [...expects], timeout_ms, idempotency_key: 'idem-1',
});

const browser = (overrides: Partial<BridgeBrowserApi>): BridgeBrowserApi => ({
  findTabByUrlPattern: async () => { throw new Error('a page handle must not select a tab'); },
  executeScript: async () => { throw new Error('a page handle runs in its document'); },
  captureVisibleTab: async () => { throw new Error('the older screenshot must not run'); },
  showNotification: async id => id,
  blockedSites: async () => [],
  tabUrl: async () => 'https://app.example.com/deals',
  ...overrides,
});

const run = (api: BridgeBrowserApi, cmd: BridgeCommand) =>
  buildActionExecutor(api).execute({ action: cmd.action, cancel: { signalled: false }, command: cmd });

const WAIT_KEYS = ['page', 'url', 'title', 'found', 'waited_ms'];
const TABLE_KEYS = ['page', 'url', 'title', 'columns', 'rows', 'truncated'];
const SHOT_KEYS = ['page', 'url', 'title', 'image', 'mime_type', 'width', 'height'];

describe('each needs the page handle, and runs nothing without it', () => {
  it.each([
    ['wait_for_element', { selector: '#saved' }, WAIT_KEYS],
    ['read_table', {}, TABLE_KEYS],
    ['screenshot_page', {}, SHOT_KEYS],
  ] as const)('%s with no page', async (action, args, keys) => {
    const out = await run(browser({ executeInDocument: async () => { throw new Error('nothing may be read'); } }),
      command(action, args, keys));
    expect(out).toEqual({ status: 'error', error: { code: 'unknown',
      message: 'bridge: this needs the page handle that listing the tabs or opening a page answered' } });
  });

  it('a page on the owner\'s list is refused before its document is touched', async () => {
    const out = await run(browser({
      blockedSites: async () => ['app.example.com'],
      executeInDocument: async () => { throw new Error('nothing may be read'); },
    }), command('read_table', { page: '7:DOC7' }, TABLE_KEYS));
    expect(out).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
  });
});

describe('wait_for_element — the service worker keeps the clock', () => {
  const met = (yes: boolean, url = 'https://app.example.com/deals') => ({ outputs: { url, title: 'Deals', met: yes } });

  it('checks the document again until the element shows, and says how long it waited', async () => {
    const seen: unknown[] = [];
    let calls = 0;
    const out = await run(browser({
      executeInDocument: async (target, func, args) => {
        seen.push({ target, func, check: args[0] });
        calls++;
        return { document_id: 'DOC7', result: met(calls >= 3) };
      },
    }), command('wait_for_element', { page: '7:DOC7', selector: '#saved', text: 'Saved' }, WAIT_KEYS));
    expect(out).toMatchObject({ status: 'ok', outputs: { page: '7:DOC7', url: 'https://app.example.com/deals',
      title: 'Deals', found: true } });
    expect(calls).toBe(3);
    expect(seen[0]).toEqual({ target: { tab_id: 7, document_id: 'DOC7' }, func: checkPageElement,
      check: { selector: '#saved', until: 'shown', text: 'Saved' } });
    expect((out.outputs as { waited_ms: number }).waited_ms).toBeGreaterThanOrEqual(2 * 150);
  });

  it('not found in time is an answer, found: false — not an error', async () => {
    const started = Date.now();
    const out = await run(browser({ executeInDocument: async () => ({ document_id: 'DOC7', result: met(false) }) }),
      command('wait_for_element', { page: '7:DOC7', selector: '#saved', timeout_ms: 450 }, WAIT_KEYS));
    expect(out).toMatchObject({ status: 'ok', outputs: { found: false } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(440);
    expect((out.outputs as { waited_ms: number }).waited_ms).toBeGreaterThanOrEqual(440);
  });

  it('ends inside the command\'s own budget, however long it was asked to wait', () => {
    // The executor passes the budget less two seconds as the most.
    expect(readWaitRequest({ selector: '#x', timeout_ms: 60_000 }, 1_000, 1_000)).toMatchObject({ timeout_ms: 1_000 });
    expect(readWaitRequest({ selector: '#x' }, 30_000, 10_000)).toMatchObject({ timeout_ms: 10_000 });
    expect(readWaitRequest({ selector: '#x', until: 'gone' }, 30_000, 10_000))
      .toMatchObject({ check: { selector: '#x', until: 'gone' } });
    expect(readWaitRequest({ selector: '' }, 30_000, 10_000)).toEqual({ error: 'Name what to wait for: a CSS selector.' });
    expect(readWaitRequest({ selector: '#x', until: 'soon' }, 30_000, 10_000)).toEqual({ error: 'Wait until it is shown or gone.' });
  });

  it('a page that reloads or goes away mid-wait is the page gone', async () => {
    let calls = 0;
    const out = await run(browser({
      executeInDocument: async () => (++calls < 2 ? { document_id: 'DOC7', result: met(false) } : { document_id: 'DOC8', result: met(true) }),
    }), command('wait_for_element', { page: '7:DOC7', selector: '#saved' }, WAIT_KEYS));
    expect(out).toEqual({ status: 'error', error: { code: 'selector_not_found', message: PAGE_GONE } });
  });

  it('a page that moved off the site the step may use is not waited on', async () => {
    const out = await run(browser({ executeInDocument: async () => ({ document_id: 'DOC7', result: met(true, 'https://elsewhere.test/') }) }),
      command('wait_for_element', { page: '7:DOC7', selector: '#saved' }, WAIT_KEYS));
    expect(out).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
  });

  it.each([
    [{ invalid: true }, 'selector_not_found'], [{ blocked: true }, 'tab_navigation_blocked'],
    [{ outputs: { url: 'https://app.example.com/', title: 'T', met: 'yes' } }, 'unknown'], [null, 'unknown'],
  ])('a check answering %j fails %s', async (answer, code) => {
    const out = await run(browser({ executeInDocument: async () => ({ document_id: 'DOC7', result: answer }) }),
      command('wait_for_element', { page: '7:DOC7', selector: '#saved' }, WAIT_KEYS));
    expect(out).toMatchObject({ status: 'error', error: { code } });
  });
});

describe('D-335 slice K — a wait races the step\'s failure and an error message', () => {
  const met = (yes: boolean) => ({ outputs: { url: 'https://app.example.com/login', title: 'Sign in', met: yes } });
  /** A page whose answers to each check are scripted by poll: what is waited for, the step's
   *  failure (`.error`), and an error message (`pageProblem`). */
  const page = (script: { shows?: (poll: number) => boolean; fails?: (poll: number) => boolean;
    problem?: (poll: number) => string | null }) => {
    let poll = 0;
    const asked: string[] = [];
    const api = browser({
      executeInDocument: async (_target, func, args) => {
        if (func === checkPageElement) {
          const check = args[0] as { selector: string };
          if (check.selector === '#welcome') {
            poll++;
            asked.push('shows');
            return { document_id: 'DOC7', result: met(script.shows?.(poll) ?? false) };
          }
          asked.push('fails');
          return { document_id: 'DOC7', result: met(script.fails?.(poll) ?? false) };
        }
        if (func === pageProblem) {
          asked.push('problem');
          return { document_id: 'DOC7', result: script.problem?.(poll) ?? null };
        }
        throw new Error(`unexpected ${func.name}`);
      },
    });
    return { asked, api };
  };
  const wait = (extra: Record<string, unknown>) => command('wait_for_element',
    { page: '7:DOC7', selector: '#welcome', timeout_ms: 2_000, ...extra }, [...WAIT_KEYS, 'failed', 'problem']);

  it('ends failed as soon as the step\'s failure shows', async () => {
    const t = page({ fails: (poll) => poll >= 2 });
    const out = await run(t.api, wait({ fail: { selector: '.error', text: 'invalid' } }));
    expect(out).toMatchObject({ status: 'ok', outputs: { found: false, failed: true, url: 'https://app.example.com/login' } });
    expect(t.asked).toEqual(['shows', 'fails', 'shows', 'fails']);
  });

  it('the failure wins a poll where both hold; what it waits for wins over an error message', async () => {
    const both = await run(page({ shows: () => true, fails: () => true }).api, wait({ fail: { selector: '.error' } }));
    expect(both).toMatchObject({ outputs: { found: false, failed: true } });
    const shown = await run(page({ shows: () => true, problem: () => 'Your password is invalid!' }).api, wait({ problems: true }));
    expect(shown).toMatchObject({ outputs: { found: true } });
    expect((shown as { outputs: Record<string, unknown> }).outputs).not.toHaveProperty('problem');
  });

  it('ends at an error message the step led to, quoting it', async () => {
    const t = page({ problem: (poll) => (poll >= 3 ? 'Your password is invalid!' : null) });
    const out = await run(t.api, wait({ problems: true }));
    expect(out).toMatchObject({ status: 'ok', outputs: { found: false, problem: 'Your password is invalid!' } });
    expect(t.asked.filter((one) => one === 'problem')).toHaveLength(3);
  });

  it('asks for neither unless the command names them, and answers the keys it always did', async () => {
    const t = page({ shows: (poll) => poll >= 2 });
    const out = await run(t.api, command('wait_for_element', { page: '7:DOC7', selector: '#welcome' }, WAIT_KEYS));
    expect(t.asked).toEqual(['shows', 'shows']);
    expect(Object.keys((out as { outputs: Record<string, unknown> }).outputs).sort()).toEqual([...WAIT_KEYS].sort());
  });

  it('refuses a failure it cannot read before it reads the page', async () => {
    const t = page({});
    const out = await run(t.api, wait({ fail: { selector: '' } }));
    expect(out).toEqual({ status: 'error', error: { code: 'unknown',
      message: 'bridge: fail is { selector, text } naming what means the step failed' } });
    expect(t.asked).toEqual([]);
  });
});

describe('read_table — one document, and only a well-formed answer', () => {
  const table = { url: 'https://app.example.com/deals', title: 'Deals', columns: ['Deal', 'Amount'],
    rows: [['Acme', '$1,200']], truncated: false };

  it('runs the table reader with its bounds in the document the handle names', async () => {
    const seen: unknown[] = [];
    const out = await run(browser({
      executeInDocument: async (target, func, args) => { seen.push({ target, func, args }); return { document_id: 'DOC7', result: { outputs: table } }; },
    }), command('read_table', { page: '7:DOC7', selector: '#deals' }, TABLE_KEYS));
    expect(out).toEqual({ status: 'ok', outputs: { page: '7:DOC7', ...table } });
    expect(seen).toEqual([{ target: { tab_id: 7, document_id: 'DOC7' }, func: readPageTable,
      args: [{ selector: '#deals' }, PAGE_TABLE_LIMITS] }]);
  });

  it.each([
    [{ missing: true }, 'No table on the page matches.'],
    [{ stale: true }, 'The page changed since it was inspected: inspect it again.'],
  ])('%j is explained', async (answer, message) => {
    const out = await run(browser({ executeInDocument: async () => ({ document_id: 'DOC7', result: answer }) }),
      command('read_table', { page: '7:DOC7' }, TABLE_KEYS));
    expect(out).toEqual({ status: 'error', error: { code: 'selector_not_found', message } });
  });

  it.each([
    { outputs: { ...table, rows: [['Acme', 1200]] } }, { outputs: { ...table, extra: true } },
    { outputs: { ...table, columns: 'Deal' } }, { outputs: table, missing: true }, 'rows',
  ])('treats a malformed answer as no answer (%j)', async answer => {
    const out = await run(browser({ executeInDocument: async () => ({ document_id: 'DOC7', result: answer }) }),
      command('read_table', { page: '7:DOC7' }, TABLE_KEYS));
    expect(out).toMatchObject({ status: 'error', error: { code: 'unknown' } });
  });

  it('a document Chrome no longer has is the page gone', async () => {
    const out = await run(browser({ executeInDocument: async () => null }), command('read_table', { page: '7:DOC7' }, TABLE_KEYS));
    expect(out).toEqual({ status: 'error', error: { code: 'selector_not_found', message: PAGE_GONE } });
  });
});

describe('screenshot_page — refuse before any tab moves, and always put the owner\'s tab back', () => {
  const area = { x: 0, y: 0, width: 800, height: 600 };
  const viewport = { width: 800, height: 600 };
  const fake = (overrides: Partial<PageCaptureChrome> = {}, front: { tab_id: number; url: string } = { tab_id: 3, url: 'https://news.test/' }) => {
    const calls: string[] = [];
    let inFront = front;
    const chrome: PageCaptureChrome = {
      screenshotsAllowed: async () => true,
      getTab: async () => ({ window_id: 1, active: false }),
      windowMinimized: async () => false,
      activeTab: async () => inFront,
      activate: async tab_id => {
        calls.push(`activate ${tab_id}`);
        inFront = { tab_id, url: tab_id === 7 ? 'https://app.example.com/deals' : 'https://news.test/' };
      },
      captureVisible: async () => { calls.push('capture'); return 'data:image/png;base64,PNG'; },
      executeInDocument: async (_target, func) => {
        if (func === waitForPaint) return { document_id: 'DOC7', result: true };
        calls.push('measure');
        return { document_id: 'DOC7', result: { outputs: { url: 'https://app.example.com/deals', title: 'Deals', area, viewport } } };
      },
      encode: async () => ({ image: 'JPEG', mime_type: 'image/jpeg', width: 800, height: 600 }),
      ...overrides,
    };
    return { chrome, calls };
  };
  const shoot = (chrome: PageCaptureChrome, scope = {}) =>
    capturePage(chrome, { page: { tab_id: 7, document_id: 'DOC7' }, scope, pattern: SITE, blocked: () => false });

  it('brings a background tab forward, pictures it, and puts the owner\'s tab back', async () => {
    const { chrome, calls } = fake();
    expect(await shoot(chrome)).toEqual({ status: 'ok', outputs: { page: '7:DOC7', url: 'https://app.example.com/deals',
      title: 'Deals', image: 'JPEG', mime_type: 'image/jpeg', width: 800, height: 600 } });
    expect(calls).toEqual(['measure', 'activate 7', 'measure', 'capture', 'activate 3']);
  });

  it('a tab already in front is pictured where it is: no tab moves', async () => {
    const { chrome, calls } = fake({ getTab: async () => ({ window_id: 1, active: true }) }, { tab_id: 7, url: 'https://app.example.com/deals' });
    expect(await shoot(chrome)).toMatchObject({ status: 'ok' });
    expect(calls).toEqual(['measure', 'measure', 'capture']);
  });

  it('puts the owner\'s tab back when Chrome refuses the capture', async () => {
    const { chrome, calls } = fake({ captureVisible: async () => { throw new Error('Either the \'<all_urls>\' or \'activeTab\' permission is required.'); } });
    expect(await shoot(chrome)).toEqual({ status: 'error', error: { code: 'unknown',
      message: 'Chrome could not picture the page: Either the \'<all_urls>\' or \'activeTab\' permission is required.' } });
    expect(calls.at(-1)).toBe('activate 3');
  });

  it('over Chrome\'s two-a-second quota, waits and tries once more', async () => {
    let tries = 0;
    const quota = () => new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
    const once = fake({ captureVisible: async () => { if (++tries === 1) throw quota(); return 'data:image/png;base64,PNG'; } });
    expect(await shoot(once.chrome)).toMatchObject({ status: 'ok' });
    expect(tries).toBe(2);
    const always = fake({ captureVisible: async () => { throw quota(); } });
    expect(await shoot(always.chrome)).toEqual({ status: 'error', error: { code: 'unknown',
      message: 'Chrome takes at most two screenshots a second: try again.' } });
    expect(always.calls.at(-1)).toBe('activate 3');
  });

  it('a page that changed after the tab came forward is not pictured, and the owner\'s tab comes back', async () => {
    let measures = 0;
    const { chrome, calls } = fake({
      executeInDocument: async (_target, func) => {
        if (func === waitForPaint) return { document_id: 'DOC7', result: true };
        return ++measures === 1
          ? { document_id: 'DOC7', result: { outputs: { url: 'https://app.example.com/deals', title: 'Deals', area, viewport } } }
          : { document_id: 'DOC9', result: { outputs: { url: 'https://app.example.com/deals', title: 'Deals', area, viewport } } };
      },
    });
    expect(await shoot(chrome)).toEqual({ status: 'error', error: { code: 'selector_not_found', message: PAGE_GONE } });
    expect(calls).toEqual(['activate 7', 'activate 3']);
  });

  it.each([
    ['the owner client', { blocked: true }, 'tab_navigation_blocked'],
    ['a missing element', { missing: true }, 'selector_not_found'],
    ['an element that draws nothing', { unseen: true }, 'selector_not_found'],
    ['a ref the page dropped', { stale: true }, 'selector_not_found'],
    // Slice R — a frame from another site, named as a page of its own.
    ['a frame\'s own page', { framed: true }, 'tab_navigation_blocked'],
  ])('%s is refused before any tab moves', async (_label, answer, code) => {
    const { chrome, calls } = fake({ executeInDocument: async () => ({ document_id: 'DOC7', result: answer }) });
    expect(await shoot(chrome, { ref: 'e4' })).toMatchObject({ status: 'error', error: { code } });
    expect(calls).toEqual([]);
  });

  it('a site on the owner\'s list is refused before any tab moves', async () => {
    const { chrome, calls } = fake();
    const out = await capturePage(chrome, { page: { tab_id: 7, document_id: 'DOC7' }, scope: {}, pattern: SITE, blocked: () => true });
    expect(out).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
    expect(calls).toEqual(['measure']);
  });

  it('screenshots the owner has not allowed are refused before anything is read or any tab moves', async () => {
    const { chrome, calls } = fake({ screenshotsAllowed: async () => false });
    expect(await shoot(chrome)).toEqual({ status: 'error', error: { code: 'capacity_gap_permission_missing',
      message: 'Screenshots are off: turn on “Allow screenshots” in the Browser Bridge\'s side panel in Chrome.' } });
    expect(calls).toEqual([]);
  });

  it('a minimized window is refused before any tab moves', async () => {
    const { chrome, calls } = fake({ windowMinimized: async () => true });
    expect(await shoot(chrome)).toMatchObject({ status: 'error', error: { code: 'capacity_gap_tab_unavailable' } });
    expect(calls).toEqual(['measure']);
  });

  it('another tab still in front after asking is never pictured', async () => {
    const { chrome, calls } = fake({ activate: async tab_id => { calls.push(`activate ${tab_id}`); } });
    expect(await shoot(chrome)).toMatchObject({ status: 'error', error: { code: 'tab_navigation_blocked' } });
    expect(calls).not.toContain('capture');
    expect(calls.at(-1)).toBe('activate 3');
  });

  it('the executor hands a handle\'s page to the capture, with the step\'s site and the owner\'s list', async () => {
    const { chrome } = fake();
    const out = await run(browser({ executeInDocument: async () => null, pageCapture: chrome }),
      command('screenshot_page', { page: '7:DOC7' }, SHOT_KEYS));
    expect(out).toMatchObject({ status: 'ok', outputs: { page: '7:DOC7', image: 'JPEG' } });
  });

  it('the measuring function is the one injected into the page', async () => {
    const funcs: unknown[] = [];
    const { chrome } = fake({ executeInDocument: async (_target, func) => { funcs.push(func); return null; } });
    await shoot(chrome);
    expect(funcs).toEqual([measurePageArea]);
  });
});

// D-335 slice S — one screen of a long page at a time, and the page left scrolled where it was.
describe('screenshot_page — a screen of a long page, and the page put back where it was', () => {
  const area = { x: 0, y: 0, width: 800, height: 600 };
  const viewport = { width: 800, height: 600 };
  /** A page whose measure scrolls to the screen asked for (`scrolled`) and says which of 7; pictures
   *  still loading the first time they are waited for, when `loading`. */
  const page = (options: { scrolled?: boolean; loading?: boolean; minimized?: boolean } = {}) => {
    const calls: string[] = [];
    const measured: unknown[][] = [];
    const restored: unknown[][] = [];
    let front = 3;
    const chrome: PageCaptureChrome = {
      screenshotsAllowed: async () => true,
      getTab: async () => ({ window_id: 1, active: false }),
      windowMinimized: async () => options.minimized === true,
      activeTab: async () => ({ tab_id: front, url: 'https://app.example.com/deals' }),
      activate: async tab_id => {
        calls.push(`activate ${tab_id}`);
        front = tab_id;
      },
      captureVisible: async () => { calls.push('capture'); return 'data:image/png;base64,PNG'; },
      executeInDocument: async (_target, func, args) => {
        if (func === waitForPaint) return { document_id: 'DOC7', result: true };
        if (func === waitForPictures) {
          calls.push('pictures');
          return { document_id: 'DOC7', result: options.loading === true && !calls.includes('measure 3') };
        }
        if (func === restorePageScroll) {
          calls.push('restore');
          restored.push([...args]);
          return { document_id: 'DOC7', result: true };
        }
        measured.push([...args]);
        calls.push(`measure ${measured.length}`);
        const screen = typeof args[2] === 'number' ? Math.min(args[2], 7) : 2;
        return { document_id: 'DOC7', result: { outputs: { url: 'https://app.example.com/deals', title: 'Deals', area, viewport,
          screen, screens: 7, ...(options.scrolled === false ? {} : { scrolled: true }) } } };
      },
      encode: async () => ({ image: 'JPEG', mime_type: 'image/jpeg', width: 800, height: 600 }),
    };
    return { chrome, calls, measured, restored };
  };
  const shoot = (chrome: PageCaptureChrome, more: { screen?: number; screens?: boolean } = {}) =>
    capturePage(chrome, { page: { tab_id: 7, document_id: 'DOC7' }, scope: {}, pattern: SITE, blocked: () => false, ...more });

  it('asks the page for the screen, answers which of how many, and puts the scroll back once the owner\'s tab is', async () => {
    const t = page();
    expect(await shoot(t.chrome, { screen: 3, screens: true })).toEqual({ status: 'ok', outputs: { page: '7:DOC7',
      url: 'https://app.example.com/deals', title: 'Deals', image: 'JPEG', mime_type: 'image/jpeg', width: 800, height: 600,
      screen: 3, screens: 7 } });
    // Both measures ask for screen 3 under one token, with Page Down's step.
    expect(t.measured.map(args => args.slice(2))).toEqual([[3, expect.any(String), PAGE_SCREEN_STEP],
      [3, t.measured[0]![3], PAGE_SCREEN_STEP]]);
    expect(t.calls).toEqual(['measure 1', 'activate 7', 'measure 2', 'pictures', 'capture', 'activate 3', 'restore']);
    expect(t.restored).toEqual([[t.measured[0]![3]]]);
  });

  it('measures again once the pictures it scrolled to have loaded', async () => {
    const t = page({ loading: true });
    await shoot(t.chrome, { screen: 2, screens: true });
    expect(t.calls).toEqual(['measure 1', 'activate 7', 'measure 2', 'pictures', 'measure 3', 'capture', 'activate 3', 'restore']);
  });

  it('a server from before asks for no screens and gets none; the page as shown is not put back, since nothing moved', async () => {
    const t = page({ scrolled: false });
    expect(await shoot(t.chrome)).toEqual({ status: 'ok', outputs: { page: '7:DOC7', url: 'https://app.example.com/deals',
      title: 'Deals', image: 'JPEG', mime_type: 'image/jpeg', width: 800, height: 600 } });
    expect(t.measured.map(args => args[2])).toEqual([null, null]);
    expect(t.calls).toEqual(['measure 1', 'activate 7', 'measure 2', 'capture', 'activate 3']);
  });

  it('a screenshot refused after it scrolled still puts the page back', async () => {
    const t = page({ minimized: true });
    expect(await shoot(t.chrome, { screen: 4, screens: true })).toMatchObject({ status: 'error',
      error: { code: 'capacity_gap_tab_unavailable' } });
    expect(t.calls).toEqual(['measure 1', 'restore']);
  });

  it('the executor passes the screen, and the screens only to a server that asks; a screen that is not one is refused', async () => {
    const seen: Array<{ screen?: unknown; screens: boolean }> = [];
    const t = page();
    const pageCapture: PageCaptureChrome = { ...t.chrome, executeInDocument: async (target, func, args) => {
      if (func === measurePageArea) seen.push({ screen: args[2], screens: false });
      return t.chrome.executeInDocument(target, func, args);
    } };
    const api = browser({ executeInDocument: async () => null, pageCapture });
    expect(await run(api, command('screenshot_page', { page: '7:DOC7', screen: 2 }, [...SHOT_KEYS, 'screen', 'screens'])))
      .toMatchObject({ status: 'ok', outputs: { screen: 2, screens: 7 } });
    const older = await run(api, command('screenshot_page', { page: '7:DOC7' }, SHOT_KEYS));
    expect(older).toMatchObject({ status: 'ok' });
    expect(older.outputs).not.toHaveProperty('screens');
    expect(seen.map(s => s.screen)).toEqual([2, 2, null, null]);
    for (const screen of [0, -1, 1.5, 'next']) {
      expect(await run(api, command('screenshot_page', { page: '7:DOC7', screen }, [...SHOT_KEYS, 'screen', 'screens'])))
        .toEqual({ status: 'error', error: { code: 'unknown', message: 'bridge: screen is a whole number from 1, the top of the page' } });
    }
  });
});

// D-335 slice U — a page scrolled a screen at a time, and left there.
describe('scroll — a screen at a time, from where the page is, and left there', () => {
  it('goes one screen on or back, to an end, or to the screen named, within the page', () => {
    const now = { screen: 3, screens: 7 };
    expect([scrollTarget(now, undefined), scrollTarget(now, 'next'), scrollTarget(now, 'previous'), scrollTarget(now, 'top'),
      scrollTarget(now, 'bottom'), scrollTarget(now, 'next', 6)]).toEqual([4, 4, 2, 1, 7, 6]);
    expect([scrollTarget({ screen: 7, screens: 7 }, 'next'), scrollTarget({ screen: 1, screens: 7 }, 'previous')]).toEqual([7, 1]);
  });

  it('measures where the page is, scrolls to the screen, gives the page a moment, and answers it as it is then', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const answers = [{ screen: 2, screens: 5 }, { screen: 3, screens: 5 }, { screen: 3, screens: 6 }];
    const api = browser({ executeInDocument: async (_target, func, args) => {
      calls.push([func.name, [...args]]);
      if (func === waitForQuiet) return { document_id: 'DOC7', result: true };
      const at = answers.shift()!;
      return { document_id: 'DOC7', result: { outputs: { url: 'https://app.example.com/deals', title: 'Deals',
        area: { x: 0, y: 0, width: 800, height: 600 }, viewport: { width: 800, height: 600 }, ...at } } };
    } });
    expect(await run(api, command('scroll', { page: '7:DOC7', to: 'next' }, ['page', 'url', 'title', 'screen', 'screens'])))
      .toEqual({ status: 'ok', outputs: { page: '7:DOC7', url: 'https://app.example.com/deals', title: 'Deals', screen: 3, screens: 6 } });
    expect(calls.map(([name, args]) => name === 'measurePageArea' ? `measure ${String(args[2])}` : name))
      .toEqual(['measure null', 'measure 3', 'waitForQuiet', 'measure null']);
    // A scroll measures as a frame's own page may: no picture is taken.
    expect(calls.find(([name]) => name === 'measurePageArea')![1].slice(4)).toEqual([PAGE_SCREEN_STEP, false]);
  });

  it('refuses a direction or a screen it cannot go to before the page is touched', async () => {
    const touched: string[] = [];
    const api = browser({ executeInDocument: async (_target, func) => { touched.push(func.name); return null; } });
    expect(await run(api, command('scroll', { page: '7:DOC7', to: 'sideways' }, ['page']))).toMatchObject({ status: 'error',
      error: { message: 'bridge: to is next, previous, top, bottom' } });
    expect(await run(api, command('scroll', { page: '7:DOC7', screen: 0 }, ['page']))).toMatchObject({ status: 'error',
      error: { message: 'bridge: screen is a whole number from 1, the top of the page' } });
    expect(touched.filter((name) => name !== 'rebindPageRef')).toEqual([]);
  });
});
