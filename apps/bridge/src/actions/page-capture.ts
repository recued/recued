/** D-335 slice H — a picture of a page as Chrome draws it: `core.dom.screenshot`.
 *
 *  Chrome only captures the tab in front of its window (`captureVisibleTab`), and
 *  the pages the AI works in are usually background tabs. The owner's ruling
 *  (2026-11-01): bring the tab forward for the capture, then put back the tab
 *  the owner was on. A screenshot is a read and does not ask, and it pictures
 *  the page as shown, frames and fields included (owner's ruling, the same day).
 *  The owner's own Recued client is never pictured, and nor is a site on the
 *  owner's list.
 *
 *  The order matters:
 *   1. The page and the element are checked in the document first, so a refusal
 *      never switches a tab.
 *   2. The tab is brought forward, Chrome is let draw it, and the page is
 *      measured again: the element is scrolled into view here, and where it is
 *      now is what is cut out.
 *   3. Chrome is asked which tab is in front and where it is, and only that tab,
 *      on the command's site, is captured: never another one.
 *   4. The owner's tab is put back, whatever happened.
 *   5. The picture is cut to the element, scaled to at most
 *      {@link BRIDGE_SCREENSHOT_MAX_EDGE} on its longer side, and encoded as a
 *      JPEG of at most {@link BRIDGE_SCREENSHOT_MAX_BASE64} base64 characters.
 *   6. (Slice S) Whatever the screenshot scrolled, an element into view or one
 *      screen of a long page, is put back, so the page is left as it was.
 *
 *  D-335 slice S — a long page is pictured a screen at a time: `screen` 1 is
 *  its top, and each next one is Page Down further (`PAGE_SCREEN_STEP`). */

import {
  BRIDGE_SCREENSHOT_MAX_BASE64,
  BRIDGE_SCREENSHOT_MAX_EDGE,
  isPatternWithinGrantedOrigins,
  type BridgeErrorCode,
} from '@recued/contracts';

import { BLOCKED_SITE_MESSAGE, SCREENSHOTS_GRANT } from '../permissions/site-grants.js';
import type { ActionExecutorOutcome } from '../queue/dispatcher.js';
import { formatPageHandle, PAGE_CHANGED, PAGE_GONE, type PageInspectScope } from './page-inspect.js';
import { pageIdentity } from './page-tabs.js';

/** How long a screenshot over Chrome's two-a-second quota waits before its one retry. */
export const PAGE_CAPTURE_QUOTA_WAIT_MS = 1_000;

/** Where the picture is cut from, in the page's CSS pixels within its viewport. */
export interface PageArea { x: number; y: number; width: number; height: number }

export type PageMeasureAnswer =
  | { outputs: { url: string; title: string; area: PageArea; viewport: { width: number; height: number };
    /** D-335 slice S — the screen of the page, or of the element, the picture shows, of how many. */
    screen: number; screens: number;
    /** Slice S — it scrolled something, which `restorePageScroll` puts back once the picture is taken. */
    scrolled?: true } }
  | { missing: true }
  | { invalid: true }
  | { stale: true }
  | { unseen: true }
  | { blocked: true }
  | { framed: true };

/** D-335 slice R — what a screenshot of a frame's own page answers: a frame from another site is a
 *  page of its own, but Chrome pictures a whole tab, and inside the frame there is no telling where
 *  the page around it shows it. */
export const FRAME_NOT_PICTURED = 'This page is a frame inside another page and cannot be pictured on its own: '
  + 'take the screenshot of the page that shows it, which pictures the frame as shown.';

/** D-335 slice S — how far one screen is from the next: seven eighths of what shows, as Chrome's Page
 *  Down scrolls, so a line cut at the foot of one screen is whole at the head of the next. */
export const PAGE_SCREEN_STEP = 0.875;

/** The part of the viewport to picture: the element a ref or selector names, scrolled into view when
 *  it is not wholly in it, or the whole viewport. `unseen`: the element draws nothing that could be
 *  pictured.
 *
 *  D-335 slice S — `screen` (from 1, the top) pictures one screen of a long page, a screen apart by
 *  `step` of what shows: of the page itself, or of the panel it scrolls when it does not (a mail
 *  list, a chat); of an element that scrolls its content; or of an element taller than what shows.
 *  The answer says which screen it pictures of how many, the page as shown included. Whatever is
 *  scrolled for it is noted under `token` first, for `restorePageScroll` to put back. Injected, so
 *  self-contained. Slice U: a `scroll` measures with it too (`picture` false), which a frame's own
 *  page may take, since scrolling it needs no picture of the tab. */
export const measurePageArea = (scope: PageInspectScope, expectedUrl?: string | null, screen?: number | null,
  token?: string | null, step = 0.875, picture = true): PageMeasureAnswer => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };
  if (picture && window !== window.top) return { framed: true };
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const title = document.title.length > 200 ? `${document.title.slice(0, 200)}…` : document.title;
  let element: Element | null = null;
  if (scope.ref != null) {
    const marked = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } }).recuedPageRefs;
    element = marked?.byRef.get(scope.ref) ?? null;
    if (!element?.isConnected) return { stale: true };
  } else if (scope.selector != null) {
    try {
      element = document.querySelector(scope.selector);
    } catch {
      return { invalid: true };
    }
    if (!element) return { missing: true };
  }

  // Slice S — what is scrolled is noted before it moves, once per screenshot (two measures share a
  // token), so it can all be put back.
  type Kept = { at: Element | Window; x: number; y: number };
  const world = globalThis as typeof globalThis & { recuedScreenshotScroll?: { token: string; kept: Kept[]; scrolled: boolean } };
  if (token != null && world.recuedScreenshotScroll?.token !== token) world.recuedScreenshotScroll = { token, kept: [], scrolled: false };
  let scrolled = false;
  const noteScroll = () => {
    // Record before the call: a failed measurement can lose its scroll receipt.
    scrolled = true;
    if (token != null && world.recuedScreenshotScroll?.token === token) world.recuedScreenshotScroll.scrolled = true;
  };
  const keep = (at: Element | Window) => {
    const record = world.recuedScreenshotScroll;
    if (token == null || record === undefined || record.token !== token || record.kept.some((kept) => kept.at === at)) return;
    const view = at as Window;
    record.kept.push(typeof view.scrollY === 'number' ? { at, x: view.scrollX, y: view.scrollY }
      : { at, x: (at as Element).scrollLeft, y: (at as Element).scrollTop });
  };
  /** Everything that could scroll to show `from`: its scrolling ancestors and each window, up through
   *  web components and frames from this site. */
  const keepAround = (from: Element) => {
    for (let node: Node | null = from; node !== null;) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const box = node as Element;
        if (box.scrollHeight > box.clientHeight || box.scrollWidth > box.clientWidth) keep(box);
      }
      const parent: Node | null = node.parentNode;
      if (parent !== null && parent.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        node = (parent as ShadowRoot).host ?? null;
      } else if (parent === null || parent.nodeType === Node.DOCUMENT_NODE) {
        const view: Window | null = node.ownerDocument?.defaultView ?? null;
        if (view) keep(view);
        node = view?.frameElement ?? null;
      } else {
        node = parent;
      }
    }
  };
  const styleOf = (box: Element) => (box.ownerDocument.defaultView ?? window).getComputedStyle(box);
  /** An element that scrolls its own content: it has more than it shows, and its overflow lets it. */
  const scrolls = (box: Element) => box.scrollHeight > box.clientHeight + 1
    && /^(auto|scroll|overlay)$/.test(styleOf(box).overflowY);
  const pace = (shown: number) => Math.max(1, Math.floor(shown * step));
  /** How many screens `height` takes, `shown` at a time. */
  const count = (height: number, shown: number) => (height <= shown + 1 ? 1 : 1 + Math.ceil((height - shown) / pace(shown)));
  /** Which screen begins at or above `offset`; the end of the content is the last screen. */
  const which = (offset: number, height: number, shown: number) =>
    (offset >= height - shown - 1 ? count(height, shown) : Math.min(count(height, shown), Math.floor(offset / pace(shown)) + 1));
  /** Where screen `n` begins. */
  const startOf = (n: number, height: number, shown: number) => Math.max(0, Math.min((n - 1) * pace(shown), height - shown));
  const to = (at: Element | Window, top: number) => {
    const now = typeof (at as Window).scrollY === 'number' ? (at as Window).scrollY : (at as Element).scrollTop;
    if (Math.abs(now - top) < 1) return;
    noteScroll();
    at.scrollTo({ top, behavior: 'instant' });
  };
  const answer = (area: PageArea, at: { screen: number; screens: number }): PageMeasureAnswer =>
    ({ outputs: { url: location.href, title, area, viewport, screen: at.screen, screens: at.screens, ...(scrolled ? { scrolled: true as const } : {}) } });

  if (element === null) {
    // The page: its own scrolling, else the panel it scrolls instead (the largest the window shows,
    // at least a third of it), looked for in web components too.
    const root = document.scrollingElement ?? document.documentElement;
    const hidden = (box: Element | null) => box !== null && /^(hidden|clip)$/.test(styleOf(box).overflowY);
    let scroller: Element | null = root.scrollHeight > root.clientHeight + 1 && !hidden(document.documentElement)
      && !hidden(document.body) ? root : null;
    if (scroller === null) {
      const shadowOf = (host: Element): ShadowRoot | null => {
        try {
          const dom = (globalThis as typeof globalThis & {
            chrome?: { dom?: { openOrClosedShadowRoot?: (host: Element) => ShadowRoot | null | undefined } } }).chrome?.dom;
          return dom?.openOrClosedShadowRoot?.(host) ?? host.shadowRoot;
        } catch {
          return host.shadowRoot;
        }
      };
      let most = (viewport.width * viewport.height) / 3;
      const roots: Array<Document | ShadowRoot> = [document];
      for (let at = 0; at < roots.length && at < 1_000; at += 1) {
        for (const box of roots[at]!.querySelectorAll('*')) {
          const shadow = shadowOf(box);
          if (shadow !== null) roots.push(shadow);
          if (box.scrollHeight <= box.clientHeight + 1 || !scrolls(box)) continue;
          const shown = box.getBoundingClientRect();
          const area = Math.max(0, Math.min(shown.right, viewport.width) - Math.max(shown.left, 0))
            * Math.max(0, Math.min(shown.bottom, viewport.height) - Math.max(shown.top, 0));
          if (area > most) {
            most = area;
            scroller = box;
          }
        }
      }
    }
    const whole = { x: 0, y: 0, ...viewport };
    if (scroller === null) return answer(whole, { screen: 1, screens: 1 });
    const page = scroller === root;
    const shown = page ? root.clientHeight : Math.min(scroller.clientHeight, viewport.height);
    const height = scroller.scrollHeight;
    const screens = count(height, shown);
    if (screen == null) return answer(whole, { screen: which(page ? window.scrollY : scroller.scrollTop, height, shown), screens });
    const n = Math.min(screen, screens);
    if (page) keep(window);
    else keepAround(scroller);
    to(page ? window : scroller, startOf(n, height, shown));
    return answer(whole, { screen: n, screens });
  }

  // D-335 slice R — an element in a frame from this site is scrolled into view in its frame, the
  // frame in its page, and pictured where the page shows it, within the frame.
  const own = element.ownerDocument.defaultView ?? window;
  let box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return { unseen: true };
  keepAround(element);
  let at = { screen: 1, screens: 1 };
  /** What scrolls the element into view: its nearest scrolling ancestor, else its window. */
  const portOf = (from: Element): Element | null => {
    for (let node: Node | null = from.parentNode; node !== null;) {
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        node = (node as ShadowRoot).host ?? null;
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return null;
      const ancestor = node as Element;
      if (ancestor === ancestor.ownerDocument.scrollingElement) return null;
      if (scrolls(ancestor)) return ancestor;
      node = ancestor.parentNode;
    }
    return null;
  };
  const port = portOf(element);
  const portShown = port === null ? own.innerHeight : Math.min(port.clientHeight, own.innerHeight);
  if (scrolls(element)) {
    // Slice S — an element that scrolls its content: its screens are its content's.
    const shown = element.clientHeight;
    at = { screen: which(element.scrollTop, element.scrollHeight, shown), screens: count(element.scrollHeight, shown) };
    if (screen != null) {
      at = { screen: Math.min(screen, at.screens), screens: at.screens };
      to(element, startOf(at.screen, element.scrollHeight, shown));
    }
    if (box.top < 0 || box.left < 0 || box.bottom > own.innerHeight || box.right > own.innerWidth) {
      noteScroll();
      element.scrollIntoView({ block: box.height > own.innerHeight ? 'start' : 'center', inline: 'nearest', behavior: 'instant' });
    }
  } else if (box.height > portShown + 1) {
    // Slice S — an element taller than what shows: its top, or the screen of it asked for.
    const screens = count(box.height, portShown);
    at = { screen: Math.min(screen ?? 1, screens), screens };
    noteScroll();
    element.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
    const offset = startOf(at.screen, box.height, portShown);
    if (offset > 0) {
      if (port === null) own.scrollBy({ top: offset, behavior: 'instant' });
      else port.scrollBy({ top: offset, behavior: 'instant' });
    }
  } else if (box.top < 0 || box.left < 0 || box.bottom > own.innerHeight || box.right > own.innerWidth) {
    noteScroll();
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  }
  for (let view: Window = own; view !== window && view.frameElement; view = view.frameElement.ownerDocument.defaultView ?? window) {
    const holder = view.frameElement;
    const shown = holder.getBoundingClientRect();
    const outer = holder.ownerDocument.defaultView ?? window;
    if (shown.top < 0 || shown.left < 0 || shown.bottom > outer.innerHeight || shown.right > outer.innerWidth) {
      noteScroll();
      holder.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }
  }
  box = element.getBoundingClientRect();
  let left = box.left;
  let top = box.top;
  let right = box.right;
  let bottom = box.bottom;
  // Slice S — only what its scrolling ancestors show of it, not what is drawn around them.
  for (let node: Node | null = element.parentNode; node !== null;) {
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      node = (node as ShadowRoot).host ?? null;
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) break;
    const ancestor = node as Element;
    if (ancestor !== ancestor.ownerDocument.scrollingElement && ancestor !== ancestor.ownerDocument.body
      && !/^visible$/.test(styleOf(ancestor).overflowY)) {
      const clip = ancestor.getBoundingClientRect();
      left = Math.max(left, clip.left + ancestor.clientLeft);
      top = Math.max(top, clip.top + ancestor.clientTop);
      right = Math.min(right, clip.left + ancestor.clientLeft + ancestor.clientWidth);
      bottom = Math.min(bottom, clip.top + ancestor.clientTop + ancestor.clientHeight);
    }
    node = ancestor.parentNode;
  }
  for (let view: Window = own; view !== window && view.frameElement; view = view.frameElement.ownerDocument.defaultView ?? window) {
    const holder = view.frameElement;
    const frameBox = holder.getBoundingClientRect();
    const dx = frameBox.left + holder.clientLeft;
    const dy = frameBox.top + holder.clientTop;
    left = Math.max(left + dx, dx);
    top = Math.max(top + dy, dy);
    right = Math.min(right + dx, dx + holder.clientWidth);
    bottom = Math.min(bottom + dy, dy + holder.clientHeight);
  }
  const x = Math.max(0, left);
  const y = Math.max(0, top);
  const width = Math.min(viewport.width, right) - x;
  const height = Math.min(viewport.height, bottom) - y;
  if (width <= 0 || height <= 0) return { unseen: true };
  return answer({ x, y, width, height }, at);
};

/** D-335 slice S — puts back what a screenshot scrolled, as `measurePageArea` noted it under the
 *  screenshot's token: the page is left where it was. Injected, so self-contained. */
export const restorePageScroll = (token: string): boolean => {
  const world = globalThis as typeof globalThis & {
    recuedScreenshotScroll?: { token: string; kept: Array<{ at: Element | Window; x: number; y: number }>; scrolled: boolean } };
  const record = world.recuedScreenshotScroll;
  if (record === undefined || record.token !== token) return false;
  delete world.recuedScreenshotScroll;
  if (record.scrolled !== true) return false;
  for (const { at, x, y } of [...record.kept].reverse()) {
    try {
      at.scrollTo({ left: x, top: y, behavior: 'instant' });
    } catch {
      // An element or frame that has gone since.
    }
  }
  return true;
};

/** D-335 slice S — resolves once the pictures the window shows have loaded, so a screen scrolled to
 *  is pictured with them, not their empty boxes; a second at most. Answers whether any was still
 *  loading when it began. Injected, so self-contained. */
export const waitForPictures = (): Promise<boolean> => new Promise(resolve => {
  const until = Date.now() + 1_000;
  let waited = false;
  const check = () => {
    const loading = [...document.images].some((picture) => {
      if (picture.complete) return false;
      const box = picture.getBoundingClientRect();
      return box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth;
    });
    if (!loading || Date.now() >= until) {
      resolve(waited);
      return;
    }
    waited = true;
    setTimeout(check, 50);
  };
  check();
});

/** Resolves once the page has drawn two frames, so a tab just brought forward
 *  is captured as it now looks; half a second at most. Injected. */
export const waitForPaint = (): Promise<boolean> => new Promise(resolve => {
  const done = () => resolve(true);
  setTimeout(done, 500);
  requestAnimationFrame(() => requestAnimationFrame(done));
});

/** What a screenshot says when the owner has not turned them on. */
export const SCREENSHOTS_OFF = 'Screenshots are off: turn on “Allow screenshots” in the Browser Bridge\'s side panel in Chrome.';

/** The chrome.* this needs, behind a seam so it can be tested without Chrome. */
export interface PageCaptureChrome {
  /** Whether the owner turned on "Allow screenshots" (`SCREENSHOTS_GRANT`). */
  screenshotsAllowed(): Promise<boolean>;
  getTab(tab_id: number): Promise<{ window_id: number; active: boolean } | null>;
  /** Whether the window is drawn at all: a minimized one pictures nothing. */
  windowMinimized(window_id: number): Promise<boolean>;
  /** The tab in front of a window, and the address it shows. */
  activeTab(window_id: number): Promise<{ tab_id: number; url: string } | null>;
  activate(tab_id: number): Promise<void>;
  captureVisible(window_id: number): Promise<string>;
  executeInDocument(target: { tab_id: number; document_id?: string },
    func: (...args: any[]) => unknown, args: readonly unknown[]): Promise<{ document_id: string; result: unknown } | null>;
  /** Cut, scale and encode a captured PNG data URL (`encodeScreenshot`). */
  encode(dataUrl: string, area: PageArea, viewport: { width: number; height: number }):
    Promise<{ image: string; mime_type: 'image/jpeg'; width: number; height: number } | null>;
}

const failure = (code: BridgeErrorCode, message: string): ActionExecutorOutcome =>
  ({ status: 'error', error: { code, message } });

const cancelled = (): ActionExecutorOutcome => ({ status: 'cancelled',
  error: { code: 'unknown', message: 'bridge: cooperative cancel observed mid-execution' } });

export const measured = (answer: unknown):
  | { url: string; title: string; area: PageArea; viewport: { width: number; height: number };
    screen?: number; screens?: number; scrolled: boolean }
  | { error: ActionExecutorOutcome } => {
  const unproven = { error: failure('unknown', 'bridge: no readable answer from the page') };
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== 1) return unproven;
  const reply = answer as Record<string, unknown>;
  if (reply.blocked === true) return { error: failure('tab_navigation_blocked', 'The owner client cannot be pictured.') };
  if (reply.framed === true) return { error: failure('tab_navigation_blocked', FRAME_NOT_PICTURED) };
  if (reply.missing === true) return { error: failure('selector_not_found', 'No element on the page matches the selector.') };
  if (reply.invalid === true) return { error: failure('selector_not_found', 'The selector is not valid CSS.') };
  if (reply.stale === true) return { error: failure('selector_not_found', PAGE_CHANGED) };
  if (reply.unseen === true) return { error: failure('selector_not_found', 'The element is not shown on the page, so it cannot be pictured.') };
  const outputs = reply.outputs as Record<string, unknown> | undefined;
  const area = outputs?.area;
  const viewport = outputs?.viewport;
  const numbers = (value: unknown, keys: string[]) => value !== null && typeof value === 'object' && !Array.isArray(value)
    && keys.every(key => {
      const field = (value as Record<string, unknown>)[key];
      return typeof field === 'number' && Number.isFinite(field);
    });
  if (!outputs || typeof outputs.url !== 'string' || typeof outputs.title !== 'string'
    || !numbers(area, ['x', 'y', 'width', 'height']) || !numbers(viewport, ['width', 'height'])) return unproven;
  // Slice S — which screen, of how many: both, or neither.
  const counted = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;
  const screens = counted(outputs.screen) && counted(outputs.screens) && outputs.screen <= outputs.screens
    ? { screen: outputs.screen, screens: outputs.screens } : {};
  return {
    url: outputs.url,
    title: outputs.title,
    area: area as unknown as PageArea,
    viewport: viewport as unknown as { width: number; height: number },
    ...screens,
    scrolled: outputs.scrolled === true,
  };
};

type CaptureRequest = { page: { tab_id: number; document_id: string }; scope: PageInspectScope; pattern: string;
  blocked: (url: string) => boolean; screen?: number; screens?: boolean; cancel?: { readonly signalled: boolean } };

/** One `screenshot_page`, on the document `page` names. `pattern` is the grant
 *  the command runs under; `blocked` is the owner's list.
 *
 *  D-335 slice S — `screen` pictures that screen of the page (or of the element), counted from 1 at
 *  its top; with `screens` the answer says which screen it pictured, of how many (a server from
 *  before slice S asks for neither, and refuses a key it did not ask for). Whatever the screenshot
 *  scrolled is put back once it is taken, after the owner's tab, so the page is left as it was. */
export const capturePage = async (chrome: PageCaptureChrome, request: CaptureRequest): Promise<ActionExecutorOutcome> => {
  if (request.cancel?.signalled) return cancelled();
  // Before anything: a screenshot the owner has not allowed moves no tab.
  const allowed = await chrome.screenshotsAllowed().catch(() => false);
  if (request.cancel?.signalled) return cancelled();
  if (!allowed) return failure('capacity_gap_permission_missing', SCREENSHOTS_OFF);
  // What this screenshot scrolls is noted in the page under its own token.
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const moved = { scrolled: false };
  try {
    return await capture(chrome, request, token, moved);
  } finally {
    // The first measurement can scroll and then refuse or lose its reply.
    // Its in-page record decides whether this request has scroll work to undo.
    if (moved.scrolled || request.scope.ref !== undefined || request.scope.selector !== undefined || request.screen !== undefined) {
      await chrome.executeInDocument(request.page, restorePageScroll, [token]).catch(() => null);
    }
  }
};

const capture = async (chrome: PageCaptureChrome, request: CaptureRequest, token: string, moved: { scrolled: boolean }):
  Promise<ActionExecutorOutcome> => {
  const { page, scope, pattern } = request;
  const measure = async () => {
    if (request.cancel?.signalled) return { error: cancelled() };
    // A measurement can scroll before it answers. Check the document's current
    // URL first, and bind just this measurement to it so retries can refresh it.
    let identified: { document_id: string; result: unknown } | null;
    try { identified = await chrome.executeInDocument(page, pageIdentity, []); } catch { identified = null; }
    if (request.cancel?.signalled) return { error: cancelled() };
    if (!identified || identified.document_id !== page.document_id) return { error: failure('selector_not_found', PAGE_GONE) };
    const identity = identified.result && typeof identified.result === 'object' && !Array.isArray(identified.result)
      ? identified.result as Record<string, unknown> : null;
    const keys = identity === null ? [] : Object.keys(identity);
    if (identity && keys.length === 1 && identity.blocked === true) {
      return { error: failure('tab_navigation_blocked', 'The owner client cannot be pictured.') };
    }
    if (!identity || keys.length !== 2 || !keys.every(key => key === 'url' || key === 'title')
      || typeof identity.url !== 'string' || typeof identity.title !== 'string') {
      return { error: failure('unknown', 'bridge: no readable answer from the page') };
    }
    if (!isPatternWithinGrantedOrigins(identity.url, [pattern])) {
      return { error: failure('tab_navigation_blocked', 'The page is no longer on a site this step may read.') };
    }
    if (request.blocked(identity.url)) return { error: failure('tab_navigation_blocked', BLOCKED_SITE_MESSAGE) };
    let ran: { document_id: string; result: unknown } | null;
    try {
      ran = await chrome.executeInDocument(page, measurePageArea, [scope, identity.url, request.screen ?? null, token, PAGE_SCREEN_STEP]);
    } catch {
      ran = null;
    }
    if (!ran || ran.document_id !== page.document_id) return { error: failure('selector_not_found', PAGE_GONE) };
    const read = measured(ran.result);
    if ('error' in read) return read.error.error?.code === 'tab_navigation_blocked'
      && (ran.result as { blocked?: unknown } | null)?.blocked === true
      ? { error: failure('tab_navigation_blocked', 'The page moved or cannot be pictured, so it was not captured.') } : read;
    if (read.scrolled) moved.scrolled = true;
    if (!isPatternWithinGrantedOrigins(read.url, [pattern])) {
      return { error: failure('tab_navigation_blocked', 'The page is no longer on a site this step may read.') };
    }
    if (request.blocked(read.url)) return { error: failure('tab_navigation_blocked', BLOCKED_SITE_MESSAGE) };
    return read;
  };

  // 1. Refuse before any tab moves.
  const before = await measure();
  // Keep the measure's scroll receipt so cleanup can undo it after cancellation.
  if (request.cancel?.signalled) return cancelled();
  if ('error' in before) return before.error;
  const tab = await chrome.getTab(page.tab_id);
  if (request.cancel?.signalled) return cancelled();
  if (!tab) return failure('selector_not_found', PAGE_GONE);
  const minimized = await chrome.windowMinimized(tab.window_id);
  if (request.cancel?.signalled) return cancelled();
  if (minimized) {
    return failure('capacity_gap_tab_unavailable',
      'Chrome\'s window with this page is minimized, so it cannot be pictured: restore the window and try again.');
  }

  // 2–4. Bring it forward, picture it, and put the owner's tab back.
  const owners = tab.active ? null : await chrome.activeTab(tab.window_id);
  if (request.cancel?.signalled) return cancelled();
  // Every capture attempt needs current document, geometry and foreground proof.
  const prepare = async (): Promise<Awaited<ReturnType<typeof measure>>> => {
    if (request.cancel?.signalled) return { error: cancelled() };
    await chrome.executeInDocument(page, waitForPaint, []).catch(() => null);
    if (request.cancel?.signalled) return { error: cancelled() };
    const now = await measure();
    if (request.cancel?.signalled) return { error: cancelled() };
    if ('error' in now) return now;
    let at = now;
    // An element scrolled into view, or a screen scrolled to, needs the frame that shows it; and
    // (slice S) the pictures it brought into view, measured again once they have loaded.
    if (scope.ref !== undefined || scope.selector !== undefined || request.screen !== undefined) {
      await chrome.executeInDocument(page, waitForPaint, []).catch(() => null);
      if (request.cancel?.signalled) return { error: cancelled() };
    }
    if (moved.scrolled) {
      const loaded = await chrome.executeInDocument(page, waitForPictures, []).catch(() => null);
      if (request.cancel?.signalled) return { error: cancelled() };
      if (loaded?.result === true) {
        const again = await measure();
        if (request.cancel?.signalled) return { error: cancelled() };
        if ('error' in again) return again;
        at = again;
      }
    }
    const front = await chrome.activeTab(tab.window_id);
    if (request.cancel?.signalled) return { error: cancelled() };
    if (front?.tab_id !== page.tab_id || !isPatternWithinGrantedOrigins(front.url, [pattern]) || request.blocked(front.url)) {
      return { error: failure('tab_navigation_blocked', 'The page could not be brought to the front, so it was not pictured.') };
    }
    return at;
  };
  let shot: string;
  let at: Exclude<Awaited<ReturnType<typeof measure>>, { error: ActionExecutorOutcome }>;
  try {
    if (!tab.active) await chrome.activate(page.tab_id);
    const first = await prepare();
    if ('error' in first) return first.error;
    if (request.cancel?.signalled) return cancelled();
    at = first;
    // Chrome takes at most two screenshots a second: one over it waits a second
    // and is tried once more.
    const quota = (error: unknown) => /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(error instanceof Error ? error.message : String(error));
    try {
      try {
        shot = await chrome.captureVisible(tab.window_id);
      } catch (error) {
        if (!quota(error)) throw error;
        if (request.cancel?.signalled) return cancelled();
        await new Promise(resolve => setTimeout(resolve, PAGE_CAPTURE_QUOTA_WAIT_MS));
        if (request.cancel?.signalled) return cancelled();
        const retry = await prepare();
        if ('error' in retry) return retry.error;
        if (request.cancel?.signalled) return cancelled();
        at = retry;
        shot = await chrome.captureVisible(tab.window_id);
      }
    } catch (error) {
      return failure('unknown', quota(error)
        ? 'Chrome takes at most two screenshots a second: try again.'
        : `Chrome could not picture the page: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    if (owners && owners.tab_id !== page.tab_id) await chrome.activate(owners.tab_id).catch(() => undefined);
  }

  // 5. Encode the confirmed read even if cancellation arrived during capture.
  const encoded = await chrome.encode(shot, at.area, at.viewport).catch(() => null);
  if (!encoded) return failure('unknown', 'bridge: the picture could not be encoded');
  return {
    status: 'ok',
    outputs: { page: formatPageHandle(page), url: at.url, title: at.title, ...encoded,
      ...(request.screens === true && at.screen !== undefined ? { screen: at.screen, screens: at.screens } : {}) },
  };
};

/** Cut the area out of a captured PNG data URL, scale it to at most `maxEdge`
 *  on its longer side, and encode it as a JPEG of at most `maxBase64`
 *  characters, lowering the quality and then the size until it fits. The
 *  viewport-to-pixel scale is read from the capture itself, not from
 *  `devicePixelRatio`, so a zoomed page is cut where it is drawn. */
export const encodeScreenshot = async (
  dataUrl: string,
  area: PageArea,
  viewport: { width: number; height: number },
  limits: { maxEdge: number; maxBase64: number } = { maxEdge: BRIDGE_SCREENSHOT_MAX_EDGE, maxBase64: BRIDGE_SCREENSHOT_MAX_BASE64 },
): Promise<{ image: string; mime_type: 'image/jpeg'; width: number; height: number }> => {
  // Decoded here, not with `fetch`: each request the package makes is one more the Chrome Web
  // Store's privacy answers must name.
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const png = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) png[i] = binary.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([png], { type: 'image/png' }));
  try {
    const scale = viewport.width > 0 ? bitmap.width / viewport.width : 1;
    const sx = Math.max(0, Math.floor(area.x * scale));
    const sy = Math.max(0, Math.floor(area.y * scale));
    const sw = Math.max(1, Math.min(bitmap.width - sx, Math.ceil(area.width * scale)));
    const sh = Math.max(1, Math.min(bitmap.height - sy, Math.ceil(area.height * scale)));
    let fit = Math.min(1, limits.maxEdge / Math.max(sw, sh));
    for (let attempt = 0; attempt < 8; attempt++) {
      const width = Math.max(1, Math.round(sw * fit));
      const height = Math.max(1, Math.round(sh * fit));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
      for (const quality of [0.85, 0.7, 0.55]) {
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const image = btoa(binary);
        if (image.length <= limits.maxBase64) return { image, mime_type: 'image/jpeg', width, height };
      }
      fit *= 0.75;
    }
    throw new Error('the picture does not fit');
  } finally {
    bitmap.close();
  }
};

/** The `PageCaptureChrome` over the real chrome.* APIs, as the extension and the
 *  real-Chrome fixture bind it. */
export const chromePageCapture = (
  chromeApi: {
    tabs: {
      get(tabId: number): Promise<{ windowId: number; active: boolean }>;
      query(query: { active: boolean; windowId: number }): Promise<Array<{ id?: number; url?: string }>>;
      update(tabId: number, props: { active: boolean }): Promise<unknown>;
      captureVisibleTab(windowId: number, options: { format: 'png' }): Promise<string>;
    };
    windows: { get(windowId: number): Promise<{ state?: string }> };
    permissions?: { contains(permissions: { origins: string[] }): Promise<boolean> };
  },
  executeInDocument: PageCaptureChrome['executeInDocument'],
): PageCaptureChrome => ({
  screenshotsAllowed: async () => chromeApi.permissions?.contains({ origins: [SCREENSHOTS_GRANT] }) ?? false,
  getTab: async tab_id => {
    try {
      const tab = await chromeApi.tabs.get(tab_id);
      return { window_id: tab.windowId, active: tab.active };
    } catch {
      return null;
    }
  },
  windowMinimized: async window_id => {
    try {
      return (await chromeApi.windows.get(window_id)).state === 'minimized';
    } catch {
      return false;
    }
  },
  activeTab: async window_id => {
    const tab = (await chromeApi.tabs.query({ active: true, windowId: window_id }))[0];
    return tab?.id === undefined ? null : { tab_id: tab.id, url: tab.url ?? '' };
  },
  activate: async tab_id => { await chromeApi.tabs.update(tab_id, { active: true }); },
  captureVisible: window_id => chromeApi.tabs.captureVisibleTab(window_id, { format: 'png' }),
  executeInDocument,
  encode: (dataUrl, area, viewport) => encodeScreenshot(dataUrl, area, viewport),
});
