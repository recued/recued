/** D-335 slice C — the open tabs on a site a step may read, and a new tab a
 *  step opens. The extension (`boot/service-worker-entry.ts`) and the
 *  real-Chrome fixture both bind these over chrome.tabs and chrome.scripting
 *  with `chromePageTabs`.
 *
 *  Both answer pages the way `inspect` does, by handle (`<tab id>:<document
 *  id>`), so the model can inspect or act on what it found or opened. The owner
 *  client is never listed or opened, as it is never read.
 *
 *  ⛔ OPENING A PAGE IS A WRITE: the address is asked for as the owner, signed
 *  in, and an address can carry data out. Once the tab exists the request has
 *  gone, so a failure after that is uncertain, never "not opened", and the
 *  model is told to look before opening it again. */

import { BRIDGE_TABS_MAX, isPatternWithinGrantedOrigins, type BridgeErrorCode } from '@recued/contracts';
import type { ActionExecutorOutcome } from '../queue/dispatcher.js';
import { pageChallenge } from './page-challenge.js';
import { executeInChromeDocument, formatPageHandle, parsePageHandle } from './page-inspect.js';
import { pageProblem, type PageMessageRules } from './page-problems.js';
import { checkPageElement, waitCheckOutcome, type PageWaitCheck } from './page-wait.js';
import type { DocumentScripting } from './reviewed-document.js';

/** The chrome.tabs this needs. */
export interface PageTabsChrome {
  query(opts: { url?: string | string[] }): Promise<Array<{ id?: number; url?: string }>>;
  create(opts: { url: string; active?: boolean }): Promise<{ id?: number }>;
  get(tabId: number): Promise<{ id?: number; status?: string; url?: string }>;
  remove(tabId: number): Promise<void>;
  /** D-335 slice X — an address loaded in a tab, and its reload. Back is the page's own
   *  `history.back()` (`pageGoBack`): Chrome's back skips an entry nobody clicked to, as its back
   *  button does, and a batch's back means the page before. */
  update?(tabId: number, opts: { url: string }): Promise<unknown>;
  reload?(tabId: number): Promise<void>;
}

/** D-335 slice X — the page's own back, one entry, when it has one to go to. Injected, so
 *  self-contained. */
export const pageGoBack = (): { going: true } | { nowhere: true } => {
  const nav = (globalThis as typeof globalThis & { navigation?: { canGoBack?: boolean } }).navigation;
  if (nav?.canGoBack === false) return { nowhere: true };
  history.back();
  return { going: true };
};

/** D-335 slice X — how a step moves a tab: to an address, back, or a reload. */
export type PageMove = { to: 'address'; url: string } | { to: 'back' } | { to: 'reload' };

/** D-335 slice X — how long a moved tab is watched for its page to start loading: a move that
 *  starts nothing (a back with nowhere to go, an address that only changes the fragment) is
 *  answered as the tab then is. */
const MOVE_START_MS = 1_500;

export interface OpenPage {
  page: string;
  url: string;
  title: string;
}

/** A page's address and title, unless it is the owner client. Injected, so
 *  self-contained. */
export const pageIdentity = (): { url: string; title: string } | { blocked: true } =>
  document.documentElement.hasAttribute('data-recued-owner-surface')
    ? { blocked: true }
    : { url: location.href, title: document.title.length > 200 ? `${document.title.slice(0, 200)}…` : document.title };

/** What `pageIdentity` answered for one tab, or (slice R) one frame of it: its page, or why it has
 *  none. */
const identify = async (
  scripting: DocumentScripting,
  tab_id: number,
  frame_id?: number,
): Promise<OpenPage | 'owner' | 'unreadable'> => {
  let first: { documentId?: string; result: unknown } | undefined;
  try {
    [first] = await scripting.executeScript({ target: { tabId: tab_id, ...(frame_id !== undefined ? { frameIds: [frame_id] } : {}) },
      func: pageIdentity, args: [] });
  } catch {
    return 'unreadable';
  }
  const result = first?.result as { blocked?: unknown; url?: unknown; title?: unknown } | undefined;
  if (result?.blocked === true) return 'owner';
  if (typeof first?.documentId !== 'string' || typeof result?.url !== 'string' || typeof result.title !== 'string') {
    return 'unreadable';
  }
  return { page: formatPageHandle({ tab_id, document_id: first.documentId }), url: result.url, title: result.title };
};

const error = (code: BridgeErrorCode, message: string): ActionExecutorOutcome => ({ status: 'error', error: { code, message } });

/** D-335 slice R — a frame's address, and whether its page has loaded. Injected, so self-contained. */
export const documentState = (): { url: string; loaded: boolean } =>
  ({ url: location.href, loaded: document.readyState === 'complete' });

/** D-335 slice K — what a step's watch looks for besides the page moving: an unsolved CAPTCHA, the
 *  step's own failure (`fail_when` on the page), and an error message the step led to. */
export interface StepChecks {
  challenge?: boolean;
  problems?: PageMessageRules;
  fail?: PageWaitCheck;
}

/** What a page shows that ends a step's watch. */
export interface StepTrouble {
  challenge?: string;
  failed?: true;
  problem?: string;
}

/** D-335 slice K — what the document a handle names shows of `checks`: each one asked, empty when
 *  none shows or the page cannot be asked (no answer is no reason to stop). */
export const troubleOn = async (scripting: DocumentScripting, handle: string, checks: StepChecks): Promise<StepTrouble> => {
  const document = parsePageHandle(handle);
  if (document === null) return {};
  const run = executeInChromeDocument(scripting);
  const ask = async (func: (...args: any[]) => unknown, args: readonly unknown[]): Promise<unknown> => {
    try {
      const ran = await run(document, func, args);
      return ran !== null && ran.document_id === document.document_id ? ran.result : undefined;
    } catch {
      return undefined;
    }
  };
  const found: StepTrouble = {};
  if (checks.challenge === true) {
    const challenge = await ask(pageChallenge, []);
    if (typeof challenge === 'string') found.challenge = challenge;
  }
  if (checks.fail !== undefined) {
    const read = waitCheckOutcome(await ask(checkPageElement, [checks.fail]));
    if (!('error' in read) && read.met) found.failed = true;
  }
  if (checks.problems !== undefined) {
    const problem = await ask(pageProblem, [checks.problems]);
    if (typeof problem === 'string') found.problem = problem;
  }
  return found;
};

/** D-335 slice J — how often a click's watch asks its page for a CAPTCHA (slice K: for any of its
 *  checks). */
const CHECK_POLL_MS = 500;

/** An opened page that went on to a site the owner listed (slice G). */
const LANDED_ON_LISTED_SITE =
  'The page went on to a site the owner listed as one Recued must never use, so its tab was closed.';

/** Bind `listPages` and `openPage` over chrome. */
export const chromePageTabs = (tabs: PageTabsChrome, scripting: DocumentScripting, sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms))) => ({

  /** The open tabs on `pattern`, at most `BRIDGE_TABS_MAX`, read from the
   *  pages themselves, each still on `pattern` when read. A tab that cannot be
   *  read (closed, restricted) or is the owner client is left out, and so is
   *  one on a site the owner listed (`blocked`, slice G): that one is never
   *  read at all. */
  async listPages(pattern: string, blocked: (url: string) => boolean = () => false):
    Promise<{ tabs: OpenPage[]; truncated: boolean }> {
    let open: Array<{ id?: number; url?: string }>;
    try {
      open = await tabs.query({ url: pattern });
    } catch {
      return { tabs: [], truncated: false };
    }
    const pages: OpenPage[] = [];
    for (const tab of open) {
      if (!Number.isSafeInteger(tab.id)) continue;
      if (typeof tab.url === 'string' && blocked(tab.url)) continue;
      if (pages.length === BRIDGE_TABS_MAX) return { tabs: pages, truncated: true };
      const page = await identify(scripting, tab.id!);
      if (typeof page === 'object' && isPatternWithinGrantedOrigins(page.url, [pattern]) && !blocked(page.url)) pages.push(page);
    }
    return { tabs: pages, truncated: false };
  },

  /** Opens `url` in a new background tab, so it never takes the owner's focus
   *  or replaces a tab they have open, waits up to `waitMs` for it to load,
   *  and answers its page. Only an `http:` or `https:` address on `pattern`;
   *  a page that ends up anywhere else (a redirect), or on a site the owner
   *  listed (`blocked`, slice G), has its tab closed. */
  async openPage(url: string, pattern: string, waitMs: number, blocked: (url: string) => boolean = () => false):
    Promise<ActionExecutorOutcome> {
    let address: URL;
    try {
      address = new URL(url);
    } catch {
      return error('tab_navigation_blocked', 'The address is not a web address.');
    }
    if ((address.protocol !== 'http:' && address.protocol !== 'https:') || address.username || address.password) {
      return error('tab_navigation_blocked', 'Only an http or https address, without a user name or password, can be opened.');
    }
    if (!isPatternWithinGrantedOrigins(address.href, [pattern])) {
      return error('tab_navigation_blocked', 'The address is not on a site this step may open.');
    }
    let tab_id: number | undefined;
    try {
      tab_id = (await tabs.create({ url: address.href, active: false })).id;
    } catch {
      return error('unknown', 'bridge: the browser did not open the tab');
    }
    // From here the address has been asked for.
    const uncertain = (message: string) => error('delivery_uncertain', message);
    if (!Number.isSafeInteger(tab_id)) {
      return uncertain('The browser may have opened the tab without saying which. List the tabs before opening it again.');
    }
    const deadline = Date.now() + waitMs;
    let landed: string | undefined;
    let loaded = false;
    for (;;) {
      const tab = await tabs.get(tab_id!).catch(() => null);
      if (!tab) return uncertain('The tab closed before its page could be read.');
      landed = tab.url;
      if (tab.status === 'complete') {
        loaded = true;
        break;
      }
      if (Date.now() >= deadline) break;
      await sleep(100);
    }
    const close = async (message: string) => {
      await tabs.remove(tab_id!).catch(() => undefined);
      return error('tab_navigation_blocked', message);
    };
    // A redirect to a site the step may not read: chrome.tabs still names the
    // address the tab landed on, though the page cannot be scripted there. (A
    // tab that has not committed a page yet names `about:blank` or nothing.)
    if (landed !== undefined && /^https?:/i.test(landed) && !isPatternWithinGrantedOrigins(landed, [pattern])) {
      return close('The page went on to a site this step may not open, so its tab was closed.');
    }
    if (landed !== undefined && /^https?:/i.test(landed) && blocked(landed)) return close(LANDED_ON_LISTED_SITE);
    // Still loading: its first document is a blank one, which says nothing yet.
    if (!loaded) {
      return uncertain('The tab opened, but its page had not finished loading. List the tabs, or inspect it, before opening it again.');
    }
    const page = await identify(scripting, tab_id!);
    if (page === 'owner') return close('The owner client cannot be automated, so its tab was closed.');
    if (page === 'unreadable') {
      return uncertain('The tab opened, but its page could not be read yet. List the tabs, or inspect it, before opening it again.');
    }
    if (!isPatternWithinGrantedOrigins(page.url, [pattern])) {
      return close('The page went on to a site this step may not open, so its tab was closed.');
    }
    if (blocked(page.url)) return close(LANDED_ON_LISTED_SITE);
    return { status: 'ok', outputs: { ...page } };
  },

  /** The page a tab shows once a click on it has settled (2026-11-04), so the model need not list
   *  the tabs to find a page the click loaded. Watches the tab for `settleMs` for a page to start
   *  loading or the address to change; when one does, waits up to `loadMs` for it to finish. Then
   *  answers the page as `listPages` does: the same handle when the click loaded nothing, a new
   *  one when it loaded a page. `moved` (slice J) says whether a page started loading or the
   *  address changed, which a sent form is checked by: alone when that page cannot be answered
   *  (still loading at the end, the owner client, off `pattern`, or on a site the owner listed,
   *  which is not read at all). Undefined when the tab has closed or cannot be read. With
   *  `checks.challenge` (slice J), the answer also names a CAPTCHA that page shows and nobody has
   *  solved (`page-challenge.ts`); with `checks.fail` and `checks.problems` (slice K), whether the
   *  step's failure shows and an error message the click led to (`page-problems.ts`). While it
   *  watches, any of them on the page it was clicked on (`before.page`) ends the watch: a sign-in
   *  form that answers with a CAPTCHA or "Your password is invalid!" does not move on, and the
   *  owner learns it then, not once the watch is over. The caller passes on only the keys its
   *  server asked for.
   *
   *  Slice R — a click in a frame from another site, whose handle names the frame (`frame_id`),
   *  is watched in that frame, since the tab's address is the page around it: the answer is the
   *  frame's page, the same handle when the click loaded nothing there. Chrome keeps a frame's id
   *  while the frame loads another page and drops it once the frame has gone, and then (the page
   *  around it loaded, or took the frame away) the answer is the tab's page, moved. */
  async pageAfterClick(tab_id: number, before: { url: string; page?: string; frame_id?: number }, pattern: string,
    waits: { settleMs: number; loadMs: number }, blocked: (url: string) => boolean = () => false,
    checks: StepChecks = {}):
    Promise<({ moved: boolean } & Partial<OpenPage> & StepTrouble) | undefined> {
    const frame_id = typeof before.frame_id === 'number' && before.frame_id > 0 ? before.frame_id : undefined;
    const clicked = before.page === undefined ? null : parsePageHandle(before.page);
    const inFrame = async (): Promise<{ document_id: string; url: string; loaded: boolean } | null> => {
      try {
        const [first] = await scripting.executeScript({ target: { tabId: tab_id, frameIds: [frame_id!] },
          func: documentState, args: [], injectImmediately: true });
        const state = first?.result as { url?: unknown; loaded?: unknown } | null | undefined;
        return typeof first?.documentId === 'string' && typeof state?.url === 'string'
          ? { document_id: first.documentId, url: state.url, loaded: state.loaded === true } : null;
      } catch {
        return null;
      }
    };
    /** The frame shows another page than the one clicked in, or has gone. */
    const frameMoved = (frame: { document_id: string; url: string } | null) =>
      frame === null || frame.document_id !== clicked?.document_id || frame.url !== before.url;
    const settleBy = Date.now() + waits.settleMs;
    const watching = checks.challenge === true || checks.fail !== undefined || checks.problems !== undefined;
    let started = false;
    let trouble: StepTrouble = {};
    let askedAt = Date.now();
    for (;;) {
      const tab = await tabs.get(tab_id).catch(() => null);
      if (!tab) return undefined;
      if (frame_id === undefined
        ? tab.status === 'loading' || (typeof tab.url === 'string' && tab.url !== before.url)
        : frameMoved(await inFrame())) {
        started = true;
        break;
      }
      if (Date.now() >= settleBy) break;
      if (watching && before.page !== undefined && Date.now() - askedAt >= CHECK_POLL_MS) {
        trouble = await troubleOn(scripting, before.page, checks);
        askedAt = Date.now();
        if (Object.keys(trouble).length > 0) break;
      }
      await sleep(100);
    }
    if (started) {
      const loadBy = Date.now() + waits.loadMs;
      for (;;) {
        const tab = await tabs.get(tab_id).catch(() => null);
        if (!tab) return undefined;
        const frame = frame_id === undefined ? null : await inFrame();
        // A frame whose page has loaded; else, as a frame that has gone, the tab once it has.
        if (frame !== null ? frame.loaded : tab.status === 'complete') break;
        if (Date.now() >= loadBy) return { moved: true };
        await sleep(100);
      }
    }
    // Where the page is, from Chrome, before anything in it is read: the frame clicked in, or the tab.
    const frame = frame_id === undefined ? null : await inFrame();
    let moved: { moved: boolean };
    let page: OpenPage | 'owner' | 'unreadable';
    if (frame !== null) {
      moved = { moved: frameMoved(frame) };
      if (blocked(frame.url) || !isPatternWithinGrantedOrigins(frame.url, [pattern])) return moved;
      page = await identify(scripting, tab_id, frame_id);
    } else {
      moved = { moved: started || frame_id !== undefined };
      const now = await tabs.get(tab_id).catch(() => null);
      if (!now) return undefined;
      if (typeof now.url === 'string' && /^https?:/i.test(now.url)
        && (blocked(now.url) || !isPatternWithinGrantedOrigins(now.url, [pattern]))) return moved;
      page = await identify(scripting, tab_id);
    }
    if (typeof page !== 'object' || blocked(page.url) || !isPatternWithinGrantedOrigins(page.url, [pattern])) return moved;
    if (!watching) return { ...moved, ...page };
    // What the watch saw, else the page as it is now: on a page the click loaded, its first look.
    const found = Object.keys(trouble).length > 0 ? trouble : await troubleOn(scripting, page.page, checks);
    return { ...moved, ...page, ...found };
  },

  /** D-335 slice X (2026-11-06) — moves the tab `tab_id` names: to an address, as following a link
   *  would (only an `http:` or `https:` one on `pattern`, without a user name or password), back,
   *  or reloaded; then answers the page it shows once loaded, as `openPage` does. The tab is the
   *  owner's, so it is never closed here: a page that went on where the step may not read (off
   *  `pattern`, on a site the owner listed, the owner client) is left there, and the answer says
   *  so. Once the move is asked for, a failure is uncertain, never "not moved". */
  async movePage(tab_id: number, move: PageMove, pattern: string, waitMs: number,
    blocked: (url: string) => boolean = () => false): Promise<ActionExecutorOutcome> {
    if (move.to === 'address') {
      let address: URL;
      try {
        address = new URL(move.url);
      } catch {
        return error('tab_navigation_blocked', 'The address is not a web address.');
      }
      if ((address.protocol !== 'http:' && address.protocol !== 'https:') || address.username || address.password) {
        return error('tab_navigation_blocked', 'Only an http or https address, without a user name or password, can be loaded.');
      }
      if (!isPatternWithinGrantedOrigins(address.href, [pattern])) {
        return error('tab_navigation_blocked', 'The address is not on a site this step may open.');
      }
      if (blocked(address.href)) return error('tab_navigation_blocked', 'The owner listed this site as one Recued must never use.');
    }
    const start = await tabs.get(tab_id).catch(() => null);
    if (!start) return error('selector_not_found', 'The tab has closed.');
    if ((move.to === 'address' && tabs.update === undefined) || (move.to === 'reload' && tabs.reload === undefined)) {
      return error('unknown', 'bridge: this browser cannot move a tab');
    }
    try {
      if (move.to === 'address') await tabs.update!(tab_id, { url: move.url });
      else if (move.to === 'reload') await tabs.reload!(tab_id);
      else {
        const [ran] = await scripting.executeScript({ target: { tabId: tab_id }, func: pageGoBack, args: [] });
        if ((ran?.result as { nowhere?: unknown } | undefined)?.nowhere === true) {
          return error('unknown', 'The tab has no page to go back to.');
        }
      }
    } catch {
      return move.to === 'back' ? error('unknown', 'The tab\'s page could not be asked to go back.')
        : error('unknown', 'bridge: the browser did not move the tab');
    }
    // From here the tab may be moving.
    const uncertain = (message: string) => error('delivery_uncertain', message);
    const deadline = Date.now() + waitMs;
    const startBy = Date.now() + MOVE_START_MS;
    let started = false;
    let landed: string | undefined;
    for (;;) {
      const tab = await tabs.get(tab_id).catch(() => null);
      if (!tab) return uncertain('The tab closed while its page loaded.');
      landed = tab.url;
      if (tab.status === 'loading' || tab.url !== start.url) started = true;
      if (started && tab.status === 'complete') break;
      if (!started && Date.now() >= startBy) break;
      if (Date.now() >= deadline) {
        return uncertain('The tab started loading a page that had not finished in time. List the tabs, or inspect it, '
          + 'before moving it again.');
      }
      await sleep(100);
    }
    const away = (where: string) => error('tab_navigation_blocked', `The tab went on to ${where}, so its page cannot be read.`);
    if (landed !== undefined && /^https?:/i.test(landed)) {
      if (!isPatternWithinGrantedOrigins(landed, [pattern])) return away('a site this step may not read');
      if (blocked(landed)) return away('a site the owner listed as one Recued must never use');
    }
    // A page Chrome restores from its back-forward cache says it has loaded a moment before a script
    // can run in it: read again until it can, within the move's own time.
    let page = await identify(scripting, tab_id);
    while (page === 'unreadable' && Date.now() < deadline) {
      await sleep(100);
      page = await identify(scripting, tab_id);
    }
    if (page === 'owner') return away('the owner client');
    if (page === 'unreadable') return uncertain('The tab moved, but its page could not be read yet. List the tabs, or inspect it.');
    if (!isPatternWithinGrantedOrigins(page.url, [pattern])) return away('a site this step may not read');
    if (blocked(page.url)) return away('a site the owner listed as one Recued must never use');
    return { status: 'ok', outputs: { ...page } };
  },

  /** D-335 slice X — closes the tab `tab_id` names, never the owner client's. */
  async closePage(tab_id: number): Promise<ActionExecutorOutcome> {
    const page = await identify(scripting, tab_id);
    if (page === 'owner') return error('tab_navigation_blocked', 'The owner client cannot be automated.');
    try {
      await tabs.remove(tab_id);
    } catch {
      return error('selector_not_found', 'The tab had already closed.');
    }
    return { status: 'ok', outputs: { closed: true } };
  },
});
