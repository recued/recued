/** D-148 § A.3 — DOM action executor.
 *
 *  The bridge's content scripts execute the closed-list `BridgeAction`
 *  set against the active tab matching the ingredient's domain
 *  pattern. The dispatcher (queue/dispatcher.ts) verifies the
 *  authority + intersection BEFORE the executor runs; the executor
 *  itself is just a thin wrapper around the chrome.scripting +
 *  chrome.tabs APIs.
 *
 *  Pure module: chrome.* lives behind the injected `BridgeBrowserApi`
 *  shim. Tests pass an in-memory shim that records calls + returns
 *  scripted outcomes.
 */

import {
  BRIDGE_ACTED_ON_KEY,
  BRIDGE_WAIT_DEFAULT_MS,
  BRIDGE_CLICK_LOAD_MAX_MS,
  BRIDGE_CLICK_SETTLE_MS,
  BRIDGE_CLICK_WAIT_MS,
  BRIDGE_PICK_MAX_MS,
  BRIDGE_WATCH_MAX_MS,
  BRIDGE_WAIT_MAX_MS,
  BRIDGE_SCROLL_TO,
  BRIDGE_FILE_MAX_BYTES,
  bridgeElementChangedMessage,
  isPatternWithinGrantedOrigins,
  parseBridgeKey,
  type BridgeAction,
  type BridgeActedOn,
  type BridgeScrollTo,
  type BridgeCommand,
  type BridgeDocumentIdentity,
  type BridgeErrorCode,
} from '@recued/contracts';
import type {
  ActionExecutorOutcome,
  ActionExecutorRequest,
  BridgeActionExecutor,
} from '../queue/dispatcher.js';
import {
  BLOCKED_SITE_MESSAGE,
  BLOCKED_SITES_UNREADABLE_MESSAGE,
  isOnBlockedSite,
} from '../permissions/site-grants.js';
import { capturePage, measured, measurePageArea, PAGE_SCREEN_STEP, type PageCaptureChrome } from './page-capture.js';
import { PAGE_SCROLL_FIRST_MS, PAGE_SCROLL_QUIET_MS, PAGE_SCROLL_SETTLE_MS, scrollTarget, waitForQuiet } from './page-scroll.js';
import { clickPageElement, fillPageField, readPageField, submitPageForm } from './page-fields.js';
import { pageChallenge } from './page-challenge.js';
import { pressPageKey } from './page-keys.js';
import { hoverPageElement } from './page-hover.js';
import { attachPageFile, fetchFile, fileTooLarge, NO_FILE_ADDRESS, NOT_FILE_FIELD, pageFileAddress, type AttachedFile,
  type FetchedFile, type PageFileAddress } from './page-files.js';
import type { PageMove } from './page-tabs.js';
import { SELECTOR_RULES } from '../picker/selector-engine.js';
import { PAGE_MESSAGE_RULES, pageProblem, prepareStepChecks, type PageMessageRules } from './page-problems.js';
import { findPickOption, notePickLists, PICK_RULES, pickTook, typeWithKeys } from './page-pick.js';
import { rebindPageRef } from './page-rebind.js';
import {
  describeOutcome,
  describePageElement,
  formatPageHandle,
  inspectOutcome,
  inspectPage,
  PAGE_CHANGED,
  PAGE_GONE,
  PAGE_REREAD_KEPT_GONE,
  parsePageHandle,
  readElementRequest,
  readInspectRequest,
  settleFrames,
  type PageFrame,
} from './page-inspect.js';
import { PAGE_TABLE_LIMITS, readPageTable, tableOutcome } from './page-table.js';
import { checkPageElement, PAGE_WAIT_POLL_MS, readFailCheck, readWaitRequest, waitCheckOutcome,
  type PageWaitCheck } from './page-wait.js';

export interface BridgeBrowserApi {
  executeReviewedDocument?(document: BridgeDocumentIdentity, action: BridgeAction,
    args: Record<string, unknown>): Promise<ActionExecutorOutcome>;
  /** D-335 — run `func` in ONE document: exactly `document_id` when given,
   *  which Chrome refuses once that document has gone, else the tab's top
   *  document. Answers the document Chrome ran it in, with the result
   *  (`executeInChromeDocument` in `page-inspect.ts`). */
  executeInDocument?(target: { tab_id: number; document_id?: string },
    func: (...args: any[]) => unknown, args: readonly unknown[]): Promise<{ document_id: string; result: unknown; frame_id?: number } | null>;
  /** D-335 slice R — the frames of a tab a script of the Bridge may read, besides its top page
   *  (`listChromeFrames` in `page-inspect.ts`): an inspection names each from another site as a page. */
  listFrames?(tab_id: number): Promise<PageFrame[]>;
  /** D-335 slice C — the open tabs on a site, and a new tab (`page-tabs.ts`,
   *  `chromePageTabs`). */
  /** `blocked` says whether an address is on the owner's list (slice G): such
   *  a tab is never listed, and an opened page that lands on one is closed. */
  listPages?(pattern: string, blocked?: (url: string) => boolean):
    Promise<{ tabs: Array<{ page: string; url: string; title: string }>; truncated: boolean }>;
  openPage?(url: string, pattern: string, waitMs: number, blocked?: (url: string) => boolean): Promise<ActionExecutorOutcome>;
  /** D-335 slice X — a tab moved to an address, back or reloaded, answered as the page it then shows,
   *  and a tab closed (`page-tabs.ts`). */
  movePage?(tab_id: number, move: PageMove, pattern: string, waitMs: number, blocked?: (url: string) => boolean):
    Promise<ActionExecutorOutcome>;
  closePage?(tab_id: number): Promise<ActionExecutorOutcome>;
  /** 2026-11-04 — the page a tab shows once a click on it has settled (`page-tabs.ts`); with
   *  `checks.challenge` (slice J), and a CAPTCHA it shows that nobody has solved; with
   *  `checks.problems` and `checks.fail` (slice K), an error message the click led to and whether
   *  the step's failure shows. Any of them, on the page clicked (`before.page`), ends the watch as
   *  soon as it shows. */
  pageAfterClick?(tab_id: number, before: { url: string; page?: string; frame_id?: number }, pattern: string,
    waits: { settleMs: number; loadMs: number }, blocked?: (url: string) => boolean,
    checks?: { challenge?: boolean; problems?: PageMessageRules; fail?: PageWaitCheck }):
    Promise<{ moved: boolean; page?: string; url?: string; title?: string; challenge?: string; problem?: string;
      failed?: boolean } | undefined>;
  /** D-335 slice G — the owner's list of sites Recued must never use
   *  (`site-grants.ts`). Every command refuses a page on one before anything
   *  is read or done there; a list that cannot be read refuses every page.
   *  Absent: no list. */
  blockedSites?(): Promise<readonly string[]>;
  /** D-335 slice G — the address a tab shows now; null once the tab has gone.
   *  How a page named by its handle is checked against the owner's list
   *  before it is read. */
  tabUrl?(tab_id: number): Promise<string | null>;
  /** D-335 slice H — what `screenshot_page` pictures a page with
   *  (`chromePageCapture`). Absent: this browser takes no screenshots. */
  pageCapture?: PageCaptureChrome;
  /** Find the first tab whose URL matches the supplied pattern.
   *  Returns the tab id + url + window id (the latter gated to
   *  scope screenshot capture to the matched tab's window — see
   *  Codex P1 #2 fold). */
  findTabByUrlPattern(pattern: string): Promise<{
    tab_id: number;
    url: string;
    window_id: number;
  } | null>;
  /** Execute a function on the matched tab; returns the function's
   *  serialized return. The result is `unknown` because chrome's
   *  `chrome.scripting.executeScript` serializes across the worker
   *  boundary and the runtime cannot guarantee the input function's
   *  return type at the boundary — callers narrow at use site. */
  executeScript(
    tab_id: number,
    fn: (selector: string, value?: string) => unknown,
    args: { selector: string; value?: string },
  ): Promise<unknown>;
  /** Capture a screenshot of the MATCHED tab (the one `findTabByUrlPattern`
   *  resolved for the command's domain pattern). The shim MUST bring that tab
   *  to the front + re-confirm it is the active tab AND still satisfies
   *  `url_pattern` before capturing — `captureVisibleTab` grabs whatever tab is
   *  ACTIVE in the window, so without this a screenshot would leak a DIFFERENT
   *  foregrounded tab's pixels (even another granted domain's), escaping the
   *  command's domain grant (D-169 bridge security hunt, F1). Returns null when
   *  the matched tab can't be confirmed (fail-closed). */
  captureVisibleTab(args: {
    tab_id: number;
    window_id: number;
    url_pattern: string;
  }): Promise<string | null>;
  /** Send an OS notification via chrome.notifications. */
  showNotification(notification_id: string, options: {
    title: string;
    message: string;
    iconUrl: string;
  }): Promise<string>;
}

const errorOutcome = (
  code: BridgeErrorCode,
  message: string,
  detail?: string,
): ActionExecutorOutcome => ({
  status: 'error',
  error: { code, message, detail },
});

const tabUnavailable = (pattern: string): ActionExecutorOutcome =>
  errorOutcome(
    'capacity_gap_tab_unavailable',
    `bridge: no open tab matches ${pattern}`,
    pattern,
  );

const selectorMissing = (selector: string): ActionExecutorOutcome =>
  errorOutcome('selector_not_found', `bridge: selector ${selector} not present in DOM`, selector);

const uncertain = (): ActionExecutorOutcome => errorOutcome('delivery_uncertain',
  'The browser could not confirm the command outcome. Check the page before retrying.');

/** D-335 slice L — how a `pick` waits. It looks for its suggestion this often; types again a key at
 *  a time when no list has shown this long after the typing; takes suggestions that have stayed the
 *  same this long as the answer (a picker that has finished asking its site); and checks this long
 *  after its click that the field took it. With no `pick_ms`, it waits this long for its suggestion. */
const PICK_POLL_MS = 200;
const PICK_KEYS_AFTER_MS = 1_000;
const PICK_STEADY_MS = 1_200;
const PICK_CHECK_MS = 1_500;
const PICK_DEFAULT_MS = 5_000;

/** D-335 slice W — the element about to be acted on, as the describe probe read it, for a server
 *  that keeps the turn's steps: its page, how an ask names it, and what finds it again. */
const actedOn = (found: Record<string, unknown>): BridgeActedOn => ({
  url: String(found.url), title: String(found.title), role: String(found.role), label: String(found.label),
  protected: found.protected === true,
  ...(typeof found.stable_selector === 'string' ? { selector: found.stable_selector } : {}),
});

/** Translate a shared field function's answer (`page-fields.ts`). It must be
 *  exactly one known key: anything else proves nothing, so a read fails and a
 *  write stays uncertain, since the page may have changed. `blocked` is the
 *  owner client unless the caller knows better (a write by ref, where it means
 *  the page moved after it was read). */
const fieldOutcome = (
  answer: unknown,
  selector: string,
  action: 'read_dom' | 'fill' | 'click' | 'submit' | 'press',
  blocked = errorOutcome('tab_navigation_blocked', 'The owner client cannot be automated.'),
): ActionExecutorOutcome => {
  const write = action !== 'read_dom';
  const unproven = write ? uncertain() : errorOutcome('unknown', `bridge: no readable answer for ${selector}`, selector);
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== 1) return unproven;
  const reply = answer as { blocked?: unknown; missing?: unknown; stale?: unknown; protected?: unknown;
    not_applied?: unknown; outputs?: unknown };
  if (reply.blocked === true) return blocked;
  if (reply.missing === true) return selectorMissing(selector);
  // A ref whose element has gone: nothing was typed or clicked.
  if (reply.stale === true) return errorOutcome('selector_not_found', PAGE_CHANGED, selector);
  if (!write && reply.protected === true) {
    return errorOutcome('field_protected',
      'The Browser Bridge does not read password, hidden, sign-in code or payment card fields.', selector);
  }
  // A write that did not happen, and why: confirmed, not uncertain. A click is
  // refused on an element that is disabled or that something else covers.
  if (write && typeof reply.not_applied === 'string') return errorOutcome('value_not_applied', reply.not_applied, selector);
  const outputs = reply.outputs;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return unproven;
  const only = outputs as Record<string, unknown>;
  const keys = Object.keys(only);
  // Slice U — a key pressed, and whether Enter sent the form it was pressed in.
  if (action === 'press') {
    return typeof only.pressed === 'string' && keys.every((key) => key === 'pressed' || (key === 'sent' && only.sent === true))
      ? { status: 'ok', outputs: only } : unproven;
  }
  if (keys.length !== 1) return unproven;
  const proven = action === 'read_dom' ? typeof only.text === 'string'
    : action === 'fill' ? only.filled === true
      : action === 'submit' ? only.submitted === true : only.clicked === true;
  return proven ? { status: 'ok', outputs: only } : unproven;
};

/** `executeInDocument`, with a refused injection read as no answer. */
/** D-335 slice R — the frame a document is, when a handle named a frame of its tab's page: what a
 *  click there is watched in (`pageAfterClick`). */
const frameOf = (ran: { frame_id?: number }): { frame_id?: number } =>
  ran.frame_id !== undefined && ran.frame_id > 0 ? { frame_id: ran.frame_id } : {};

const runInDocument = async (
  api: BridgeBrowserApi,
  target: { tab_id: number; document_id?: string },
  func: (...args: any[]) => unknown,
  args: readonly unknown[],
): Promise<{ document_id: string; result: unknown; frame_id?: number } | null> => {
  try {
    return await api.executeInDocument!(target, func, args);
  } catch {
    return null;
  }
};

/** D-335 slice M — before a step by ref: a ref whose element the page rebuilt names the same
 *  control again, when the page shows exactly one (`page-rebind.ts`). Whatever it answers, the
 *  step then reads the ref as it always has, so a ref still gone refuses as before.
 *  D-347 follow-up 17 — before a step that acts (`act`), an element still on the page that shows
 *  something else than the page's last read did, with no other showing that, refuses the step: the
 *  answer, saying what it shows now and showed then. */
const rebindRef = async (
  api: BridgeBrowserApi,
  target: { tab_id: number; document_id?: string },
  ref: string | undefined,
  act = false,
): Promise<ActionExecutorOutcome | undefined> => {
  if (ref === undefined) return undefined;
  const ran = await runInDocument(api, target, rebindPageRef, [ref, act]);
  const changed = (ran?.result as { changed?: { now?: unknown; was?: unknown } } | null | undefined)?.changed;
  return changed === undefined ? undefined
    : errorOutcome('selector_not_found', bridgeElementChangedMessage(ref, String(changed.now), String(changed.was)));
};

/** D-335 slice X (2026-11-06) — a script that reads or acts on an element by ref, run once more
 *  when the page rebuilt that element after {@link rebindRef} found it there. The page's own tasks
 *  run between the Bridge's scripts: a search page that rebuilds its form a moment after its box
 *  takes focus (Wikipedia's does) had a press sent right after the typing find the box at the
 *  rebind, then gone at the press, which refused "The page changed since it was inspected": 20 runs
 *  in 216 on a page rebuilding its box 4 to 26 ms after focus, with every core busy, and none in
 *  216 since. Each such script answers `stale` before it touches anything, so it runs again once
 *  the ref names the rebuilt control. Once: a page that rebuilt it again by then refuses as
 *  before. */
const byRef = async (
  api: BridgeBrowserApi,
  target: { tab_id: number; document_id?: string },
  ref: string | undefined,
  run: () => Promise<{ document_id: string; result: unknown; frame_id?: number } | null>,
): Promise<{ document_id: string; result: unknown; frame_id?: number } | null> => {
  const ran = await run();
  if (ref === undefined || (ran?.result as { stale?: unknown } | null)?.stale !== true) return ran;
  await rebindRef(api, target, ref);
  return run();
};

const cancelled = (): ActionExecutorOutcome => ({
  status: 'cancelled',
  error: {
    code: 'unknown',
    message: 'bridge: cooperative cancel observed mid-execution',
  },
});

/** Codex P3 #7 fold — empty `expects_output_keys` means the action
 *  is *not allowed* to return any outputs (per the BridgeCommand
 *  contract at packages/contracts/src/bridge.ts:114). The previous
 *  guard treated empty as "allow all" which let an executor leak
 *  arbitrary keys past the validator. Output-producing actions
 *  must be bound to an explicit closed list at recipe time. */
const validateOutputKeys = (
  outputs: Record<string, unknown>,
  expected: string[],
): boolean => {
  if (expected.length === 0) {
    return Object.keys(outputs).length === 0;
  }
  for (const key of Object.keys(outputs)) {
    if (!expected.includes(key)) return false;
  }
  return true;
};

const stringArg = (args: Record<string, unknown>, name: string): string | null => {
  const v = args[name];
  if (typeof v !== 'string') return null;
  return v;
};

/** D-148 § A.3 — execute one BridgeAction against the browser.
 *  Pure dispatcher; chrome.* sits behind the injected `api` shim. */
export const buildActionExecutor = (api: BridgeBrowserApi): BridgeActionExecutor => {
  /** D-335 slice G — the owner's list, or undefined when it cannot be read. */
  const readBlocked = async (): Promise<readonly string[] | undefined> => {
    if (!api.blockedSites) return [];
    try {
      return await api.blockedSites();
    } catch {
      return undefined;
    }
  };
  const unreadableList = (): ActionExecutorOutcome => errorOutcome('tab_navigation_blocked', BLOCKED_SITES_UNREADABLE_MESSAGE);
  /** A page at `url` the owner's list rules out, or null. An unreadable list
   *  rules out every page: it cannot tell a listed site from any other. */
  const siteRefusal = (url: string, blocked: readonly string[] | undefined): ActionExecutorOutcome | null =>
    blocked === undefined ? unreadableList()
      : isOnBlockedSite(url, blocked) ? errorOutcome('tab_navigation_blocked', BLOCKED_SITE_MESSAGE) : null;
  /** The same, for the page a handle names: its tab's address, read before
   *  anything is. With no list, nothing is asked of Chrome. A tab that has gone
   *  is the page gone. */
  const pageRefusal = async (tab_id: number, blocked: readonly string[] | undefined): Promise<ActionExecutorOutcome | null> => {
    if (blocked === undefined) return unreadableList();
    if (blocked.length === 0) return null;
    if (!api.tabUrl) return unreadableList();
    const url = await api.tabUrl(tab_id).catch(() => null);
    return url === null ? errorOutcome('selector_not_found', PAGE_GONE) : siteRefusal(url, blocked);
  };

  const executeOne = async (
    action: BridgeAction,
    command: BridgeCommand,
    cancel: { signalled: boolean },
  ): Promise<ActionExecutorOutcome> => {
    if (cancel.signalled) return cancelled();
    // D-335 slice G — read once per command; a notification acts on no page.
    const blocked = action === 'os_notification' ? [] : await readBlocked();
    if (command.reviewed_document) {
      if (!api.executeReviewedDocument) return errorOutcome('tab_navigation_blocked', 'This bridge cannot bind reviewed documents.');
      // The reviewed executor acts only while the document is at this address.
      const refused = siteRefusal(command.reviewed_document.url, blocked);
      if (refused) return refused;
      return api.executeReviewedDocument(command.reviewed_document, action, command.args);
    }
    if (action === 'os_notification') {
      const title = stringArg(command.args, 'title') ?? 'Recued';
      const body = stringArg(command.args, 'body') ?? '';
      const icon = stringArg(command.args, 'icon_url') ?? '';
      const out_id = await api.showNotification(command.command_id, {
        title,
        message: body,
        iconUrl: icon,
      });
      return { status: 'ok', outputs: { notification_id: out_id } };
    }

    // D-335 slice C — the open tabs on the command's site, and a new tab there.
    if (action === 'list_tabs') {
      if (!api.listPages) return errorOutcome('unknown', 'bridge: this browser cannot list tabs');
      if (blocked === undefined) return unreadableList();
      return { status: 'ok', outputs: await api.listPages(command.target_domain_pattern, url => isOnBlockedSite(url, blocked)) };
    }
    if (action === 'open_tab') {
      const url = stringArg(command.args, 'url');
      if (url === null) return errorOutcome('unknown', 'bridge: open_tab requires a url argument');
      if (!api.openPage) return errorOutcome('unknown', 'bridge: this browser cannot open tabs');
      if (blocked === undefined) return unreadableList();
      // Before any tab exists: a listed site is never asked for.
      const refused = siteRefusal(url, blocked);
      if (refused) return refused;
      // Wait for the page within the command's own budget, leaving time to answer.
      return api.openPage(url, command.target_domain_pattern,
        Math.max(1_000, Math.min(20_000, command.timeout_ms - 5_000)), landed => isOnBlockedSite(landed, blocked));
    }

    // D-335 slice X — a tab's own navigation, and closing it, by its page handle: the tab is the
    // one the handle names, whatever page it shows now.
    if (action === 'navigate' || action === 'go_back' || action === 'reload_page' || action === 'close_tab') {
      const handle = parsePageHandle(command.args.page);
      if (!handle) return errorOutcome('unknown', 'bridge: this needs the page handle that listing the tabs or opening a page answered');
      const refused = await pageRefusal(handle.tab_id, blocked);
      if (refused) return refused;
      if (cancel.signalled) return cancelled();
      if (action === 'close_tab') {
        if (!api.closePage) return errorOutcome('unknown', 'bridge: this browser cannot close tabs');
        return api.closePage(handle.tab_id);
      }
      if (!api.movePage) return errorOutcome('unknown', 'bridge: this browser cannot move tabs');
      const listed = (url: string) => isOnBlockedSite(url, blocked ?? []);
      // Wait for the page within the command's own budget, leaving time to answer.
      const waitMs = Math.max(1_000, Math.min(20_000, command.timeout_ms - 5_000));
      if (action === 'navigate') {
        const url = stringArg(command.args, 'url');
        if (url === null) return errorOutcome('unknown', 'bridge: navigate requires a url argument');
        // Before the tab moves: a listed site is never asked for.
        const listedThere = siteRefusal(url, blocked);
        if (listedThere) return listedThere;
        return api.movePage(handle.tab_id, { to: 'address', url }, command.target_domain_pattern, waitMs, listed);
      }
      return api.movePage(handle.tab_id, { to: action === 'go_back' ? 'back' : 'reload' }, command.target_domain_pattern,
        waitMs, listed);
    }
    // D-335 slice X — pointing at an element, for a menu that opens under the pointer: read as a write
    // by ref is (the element first, then the pointer, at the address just read), and changing nothing.
    if (action === 'hover') {
      const request = readElementRequest(command.args);
      if ('error' in request) return errorOutcome('unknown', `bridge: ${request.error}`);
      if (!request.page) return errorOutcome('unknown', 'bridge: hover needs the page the element is on');
      if (!api.executeInDocument) return errorOutcome('unknown', 'bridge: this browser cannot act on a page by ref');
      const document = request.page;
      const refused = await pageRefusal(document.tab_id, blocked);
      if (refused) return refused;
      const changed = await rebindRef(api, document, request.scope.ref, true);
      if (changed) return changed;
      const probe = await byRef(api, document, request.scope.ref,
        () => runInDocument(api, document, describePageElement, [request.scope, null, null]));
      if (!probe || probe.document_id !== document.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const found = describeOutcome(probe.result, document,
        { pattern: command.target_domain_pattern, blockedMessage: 'The owner client cannot be automated.' });
      if (found.status !== 'ok') return found;
      const listedHere = siteRefusal(String(found.outputs!.url), blocked);
      if (listedHere) return listedHere;
      if (cancel.signalled) return cancelled();
      const url = found.outputs!.url as string;
      const ran = await byRef(api, document, request.scope.ref, () => runInDocument(api, document, hoverPageElement,
        [request.scope.selector ?? '', url, request.scope.ref ?? null]));
      if (!ran || ran.document_id !== document.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const answer = ran.result as { hovered?: unknown; blocked?: unknown; missing?: unknown; stale?: unknown } | null;
      if (answer?.stale === true) return errorOutcome('selector_not_found', PAGE_CHANGED);
      if (answer?.missing === true) return selectorMissing(request.scope.ref ?? request.scope.selector!);
      if (answer?.hovered !== true) return errorOutcome('tab_navigation_blocked', 'The page moved before the pointer reached it.');
      return { status: 'ok', outputs: { hovered: true, page: formatPageHandle(document), url, title: found.outputs!.title } };
    }

    // D-335 slice AP — a file the page links to (the link a ref or a selector names, or an address),
    // fetched as the page fetches it, its cookies with it; from another site the page may not fetch
    // from, as the Bridge fetches it. The page stays as it is.
    if (action === 'download_file') {
      const handle = parsePageHandle(command.args.page);
      if (!handle) return errorOutcome('unknown', 'bridge: this needs the page handle that listing the tabs or opening a page answered');
      if (!api.executeInDocument) return errorOutcome('unknown', 'bridge: this browser cannot read pages by handle');
      const ref = typeof command.args.ref === 'string' ? command.args.ref : null;
      const selector = typeof command.args.selector === 'string' ? command.args.selector : null;
      const address = typeof command.args.address === 'string' ? command.args.address : null;
      if ((ref === null && selector === null) === (address === null)) {
        return errorOutcome('unknown', 'bridge: download_file takes the link by ref or selector, or the file\'s address');
      }
      const most = typeof command.args.max_bytes === 'number' && command.args.max_bytes > 0
        ? Math.min(command.args.max_bytes, BRIDGE_FILE_MAX_BYTES) : BRIDGE_FILE_MAX_BYTES;
      const refused = await pageRefusal(handle.tab_id, blocked);
      if (refused) return refused;
      if (cancel.signalled) return cancelled();
      const changed = ref === null ? undefined : await rebindRef(api, handle, ref, true);
      if (changed) return changed;
      const located = await byRef(api, handle, ref ?? undefined,
        () => runInDocument(api, handle, pageFileAddress, [selector, ref, address]));
      if (!located || located.document_id !== handle.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const where = located.result as PageFileAddress | null;
      if (where === null || 'blocked' in where) return errorOutcome('tab_navigation_blocked', 'The owner client cannot be automated.');
      if ('stale' in where) return errorOutcome('selector_not_found', PAGE_CHANGED);
      if ('missing' in where) return selectorMissing(ref ?? selector!);
      if ('no_address' in where) return errorOutcome('selector_not_found', NO_FILE_ADDRESS);
      if (!isPatternWithinGrantedOrigins(where.url, [command.target_domain_pattern])) {
        return errorOutcome('tab_navigation_blocked', 'The page is no longer on a site this step may read.');
      }
      // Neither the page nor the file's own site may be one the owner listed.
      const listedHere = siteRefusal(where.url, blocked) ?? siteRefusal(where.address, blocked);
      if (listedHere) return listedHere;
      if (cancel.signalled) return cancelled();
      const inPage = await runInDocument(api, handle, fetchFile, [where.address, most]);
      let got = inPage?.result as FetchedFile | null | undefined;
      if (got === null || got === undefined || ('failed' in got && where.cross_origin)) got = await fetchFile(where.address, most);
      if ('too_large' in got) return errorOutcome('unknown', fileTooLarge(got.too_large, got.at_least === true, most));
      if ('failed' in got) return errorOutcome('unknown', `The file at ${where.address} could not be fetched: ${got.failed}.`);
      return { status: 'ok', outputs: { page: formatPageHandle(handle), url: where.url, title: where.title,
        address: got.address, filename: got.filename, mime_type: got.mime_type, size: got.size, data: got.data } };
    }

    // D-335 slice AQ — one of the owner's files into the file field a ref or a selector names, as choosing
    // it there would; read as a write by ref is (the element and its site first, then the file), and
    // never on a site the owner listed. The server asked the owner first, naming the file.
    if (action === 'upload_file') {
      const request = readElementRequest(command.args);
      if ('error' in request) return errorOutcome('unknown', `bridge: ${request.error}`);
      if (!request.page) return errorOutcome('unknown', 'bridge: upload_file needs the page the field is on');
      if (!api.executeInDocument) return errorOutcome('unknown', 'bridge: this browser cannot act on a page by ref');
      const { filename, mime_type, data } = command.args;
      if (typeof filename !== 'string' || filename === '' || typeof mime_type !== 'string' || typeof data !== 'string'
        || data.length > Math.ceil(BRIDGE_FILE_MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        return errorOutcome('unknown', 'bridge: upload_file takes a filename, a mime_type and the file in base64');
      }
      const document = request.page;
      const refused = await pageRefusal(document.tab_id, blocked);
      if (refused) return refused;
      const changed = await rebindRef(api, document, request.scope.ref, true);
      if (changed) return changed;
      const probe = await byRef(api, document, request.scope.ref,
        () => runInDocument(api, document, describePageElement, [request.scope, null, null]));
      if (!probe || probe.document_id !== document.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const found = describeOutcome(probe.result, document,
        { pattern: command.target_domain_pattern, blockedMessage: 'The owner client cannot be automated.' });
      if (found.status !== 'ok') return found;
      const listedHere = siteRefusal(String(found.outputs!.url), blocked);
      if (listedHere) return listedHere;
      if (cancel.signalled) return cancelled();
      const ran = await byRef(api, document, request.scope.ref, () => runInDocument(api, document, attachPageFile,
        [request.scope.selector ?? null, request.scope.ref ?? null, filename, mime_type, data]));
      if (!ran || ran.document_id !== document.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const answer = ran.result as AttachedFile | null;
      if (answer === null || 'blocked' in answer) return errorOutcome('tab_navigation_blocked', 'The owner client cannot be automated.');
      if ('stale' in answer) return errorOutcome('selector_not_found', PAGE_CHANGED);
      if ('missing' in answer) return selectorMissing(request.scope.ref ?? request.scope.selector!);
      if ('not_file_field' in answer) return errorOutcome('selector_not_found', NOT_FILE_FIELD);
      return { status: 'ok', outputs: { attached: answer.attached, page: formatPageHandle(document), url: answer.url,
        title: answer.title } };
    }

    // D-335 — inspect and describe read one document: the one a page handle
    // names, else the matched tab's. The answer carries that document's handle.
    // D-335 slice T — `reread` is an inspection that keeps the refs of elements the page removed.
    if (action === 'inspect' || action === 'describe' || action === 'reread') {
      const inspects = action !== 'describe';
      const request = inspects ? readInspectRequest(command.args) : readElementRequest(command.args);
      if ('error' in request) return errorOutcome('unknown', `bridge: ${request.error}`);
      if (!api.executeInDocument) return errorOutcome('unknown', 'bridge: this browser cannot inspect pages');
      let tab_id = request.page?.tab_id;
      if (tab_id === undefined) {
        const found = await api.findTabByUrlPattern(command.target_domain_pattern);
        if (!found) return tabUnavailable(command.target_domain_pattern);
        const refused = siteRefusal(found.url, blocked);
        if (refused) return refused;
        tab_id = found.tab_id;
      } else {
        const refused = await pageRefusal(tab_id, blocked);
        if (refused) return refused;
      }
      if (cancel.signalled) return cancelled();
      if (request.page) await rebindRef(api, { tab_id, document_id: request.page.document_id }, request.scope.ref);
      const read = { tab_id, ...(request.page ? { document_id: request.page.document_id } : {}) };
      const ran = await byRef(api, read, request.page ? request.scope.ref : undefined, () => runInDocument(api, read,
        inspects ? inspectPage : describePageElement,
        action === 'reread' ? [request.scope, request.limits, null, PAGE_REREAD_KEPT_GONE]
          : inspects ? [request.scope, request.limits] : [request.scope]));
      // A page handle names a document Chrome no longer has: it navigated,
      // reloaded or closed.
      if (request.page && (!ran || ran.document_id !== request.page.document_id)) {
        return errorOutcome('selector_not_found', PAGE_GONE);
      }
      if (!ran) return errorOutcome('unknown', 'bridge: the browser did not let the Bridge read the page');
      // D-335 slice R — the frames from another site the read named: each the page it shows, read
      // in the tab's top page, where its own frames are listed.
      const answer = ran.result as { outputs?: { html?: unknown } } | null;
      if (inspects && typeof answer?.outputs?.html === 'string' && answer.outputs.html.includes('data-recued-frame="')) {
        const frames = ran.frame_id === 0 && api.listFrames ? await api.listFrames(tab_id).catch(() => null) : null;
        answer.outputs.html = settleFrames(answer.outputs.html, tab_id, frames,
          url => blocked === undefined || isOnBlockedSite(url, blocked));
      }
      const outcome = (inspects ? inspectOutcome : describeOutcome)(ran.result,
        { tab_id, document_id: ran.document_id },
        { pattern: command.target_domain_pattern, blockedMessage: 'The owner client cannot be automated.' });
      // Slice R — a handle can name a frame, whose site is its own: the address the document read
      // decides too, and on a listed site nothing it read is answered.
      return outcome.status === 'ok' ? siteRefusal(String(outcome.outputs!.url), blocked) ?? outcome : outcome;
    }

    // D-335 slice B — typing or clicking in the document a page handle names,
    // on the element a ref or a selector names there. Bound to that document:
    // once it has gone, nothing is typed or clicked.
    // D-335 slice J — `submit` sends the form an element is in, typing `value` into it first
    // when the command carries one; it is only ever named by page.
    // D-335 slice U — `press` presses a key in the element, likewise named only by page.
    if ((action === 'fill' || action === 'click' || action === 'submit' || action === 'press')
      && (action === 'submit' || action === 'press' || command.args.page !== undefined || command.args.ref !== undefined)) {
      const request = readElementRequest(command.args);
      if ('error' in request) return errorOutcome('unknown', `bridge: ${request.error}`);
      const value = stringArg(command.args, 'value');
      const press = action === 'press' ? parseBridgeKey(command.args.key) : null;
      if (action === 'press' && press === null) {
        return errorOutcome('unknown', 'bridge: key is not one the Bridge presses: a named key such as Enter or Escape, a letter, a digit, '
          + 'or one of those after Control, Meta, Alt or Shift and a +');
      }
      if (!request.page || (action === 'fill' && value === null)) {
        return errorOutcome('unknown', `bridge: ${action === 'fill' && value === null ? 'fill action requires value argument'
          : 'a write by ref needs the page it came from'}`);
      }
      if (!api.executeInDocument) return errorOutcome('unknown', 'bridge: this browser cannot act on a page by ref');
      const document = request.page;
      const refused = await pageRefusal(document.tab_id, blocked);
      if (refused) return refused;
      const named = request.scope.ref ?? request.scope.selector!;
      const changed = await rebindRef(api, document, request.scope.ref, true);
      if (changed) return changed;
      // First the element, read without touching it. A page or an element that
      // has gone is a confirmed failure here: nothing has been typed or clicked.
      // Slice W — and, for a server that keeps the turn's steps, what finds it again another day,
      // worked out before it is acted on, since a click can take it away.
      const keeps = command.expects_output_keys.includes(BRIDGE_ACTED_ON_KEY);
      const probe = await byRef(api, document, request.scope.ref,
        () => runInDocument(api, document, describePageElement, [request.scope, null, keeps ? SELECTOR_RULES : null]));
      if (!probe || probe.document_id !== document.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const found = describeOutcome(probe.result, document,
        { pattern: command.target_domain_pattern, blockedMessage: 'The owner client cannot be automated.' });
      if (found.status !== 'ok') return found;
      const stable = keeps ? { acted_on: actedOn(found.outputs!) } : {};
      // Slice R — a handle can name a frame, whose site is its own: nothing is typed or clicked in a
      // document on a listed site.
      const listedHere = siteRefusal(String(found.outputs!.url), blocked);
      if (listedHere) return listedHere;
      if (cancel.signalled) return cancelled();
      // Then the write, at the address just read, so a move in between refuses
      // it. ⚠ A refused write is uncertain, not failed: a click that navigates
      // can take the injection's answer with it.
      const url = found.outputs!.url as string;
      // Chrome passes arguments as JSON: an undefined ref would arrive as null.
      const ref = request.scope.ref === undefined ? [] : [request.scope.ref];
      const selector = request.scope.selector ?? '';
      // Slice K — before a click or a send, what the page says now, so an error message it leads to
      // is told from one already there; and whether a click sends a form, so it is watched as a
      // sent form is. Asked only by a server that wants either.
      const problems = (action === 'click' || action === 'submit' || action === 'press') && command.expects_output_keys.includes('problem');
      const sendWatch = action === 'click' && typeof command.args.send_watch_ms === 'number'
        && Number.isFinite(command.args.send_watch_ms)
        ? Math.max(0, Math.min(BRIDGE_WATCH_MAX_MS, command.args.send_watch_ms)) : undefined;
      const fail = action === 'fill' ? undefined : readFailCheck(command.args.fail);
      if (fail === null) return errorOutcome('unknown', 'bridge: fail is { selector, text } naming what means the step failed');
      let sends = false;
      /** A send button on a form the browser will not send, and why: the click sends nothing. */
      let unsent: string | undefined;
      if (problems || sendWatch !== undefined) {
        const prepared = await runInDocument(api, document, prepareStepChecks,
          [selector, request.scope.ref ?? null, PAGE_MESSAGE_RULES]);
        const said = prepared !== null && prepared.document_id === document.document_id
          ? prepared.result as { sends?: unknown; unsent?: unknown } | null : null;
        sends = said?.sends === true;
        unsent = action === 'click' && typeof said?.unsent === 'string' ? said.unsent : undefined;
      }
      const typesFirst = action === 'submit' && value !== null;
      // D-347 follow-up 18 — a click waits for what covers its element to go (`clickPageElement`), out of the
      // command's budget: what is left of it after the wait is the watch's below.
      const begun = Date.now();
      const clickWait = Math.max(0, Math.min(BRIDGE_CLICK_WAIT_MS, command.timeout_ms - 15_000));
      const ran = await byRef(api, document, request.scope.ref, () => action === 'click'
        ? runInDocument(api, document, clickPageElement, [selector, url, request.scope.ref ?? null, clickWait])
        : action === 'press'
          ? runInDocument(api, document, pressPageKey, [selector, url, request.scope.ref ?? null, press])
        : action === 'submit' && !typesFirst
          ? runInDocument(api, document, submitPageForm, [selector, url, request.scope.ref ?? null])
          // Typing, and typing then sending in the same script (slice J).
          : runInDocument(api, document, fillPageField,
            typesFirst ? [selector, value, url, request.scope.ref ?? null, true] : [selector, value, url, ...ref]));
      if (!ran || ran.document_id !== document.document_id) return uncertain();
      const answered = fieldOutcome(ran.result, named, action, errorOutcome('selector_not_found', PAGE_CHANGED));
      const done = answered.status === 'ok'
        ? { ...answered, outputs: { ...(typesFirst ? { filled: true } : {}), ...answered.outputs, ...stable } } : answered;
      if (done.status !== 'ok' || cancel.signalled) return done;
      const challenge = command.expects_output_keys.includes('challenge');
      // Slice J — typing leaves the page where it was: whether it now shows a CAPTCHA nobody has
      // solved, asked of the same document. No answer is no reason to stop.
      if (action === 'fill') {
        if (!challenge) return done;
        const asked = await runInDocument(api, document, pageChallenge, []);
        return asked !== null && asked.document_id === document.document_id && typeof asked.result === 'string'
          ? { ...done, outputs: { ...done.outputs, challenge: asked.result } } : done;
      }
      // Slice K — a click on a form's send button sent the form, or the browser would not send it.
      const sent = { ...(action === 'click' && sends && command.expects_output_keys.includes('sent') ? { sent: true } : {}),
        ...(unsent !== undefined && problems ? { problem: unsent } : {}) };
      // 2026-11-04 — a click, and a form sent (slice J), also answer the page their tab shows
      // once it settles, when the server asked for it: a new handle when they loaded a new page.
      // Nothing more is clicked.
      if (!api.pageAfterClick || !command.expects_output_keys.includes('page')) {
        return { ...done, outputs: { ...done.outputs, ...sent } };
      }
      const list = blocked ?? [];
      // Slice J — a sign-in form may move on only once its site has answered: the server asks
      // for a longer watch when its check depends on it, and (slice K) for a click that turns out
      // to send a form. All of it inside the command's budget.
      const budget = Math.max(0, command.timeout_ms - (Date.now() - begun) - 3_000);
      const watch = typeof command.args.watch_ms === 'number' && Number.isFinite(command.args.watch_ms)
        ? Math.max(0, Math.min(BRIDGE_WATCH_MAX_MS, command.args.watch_ms)) : BRIDGE_CLICK_SETTLE_MS;
      const settleMs = Math.min(sends && sendWatch !== undefined ? Math.max(watch, sendWatch) : watch, budget);
      const after = await api.pageAfterClick(document.tab_id, { url, page: formatPageHandle(document), ...frameOf(probe) },
        command.target_domain_pattern, {
          settleMs,
          loadMs: Math.max(0, Math.min(BRIDGE_CLICK_LOAD_MAX_MS, budget - settleMs)),
        }, (address) => isOnBlockedSite(address, list), {
          challenge,
          ...(problems ? { problems: PAGE_MESSAGE_RULES } : {}),
          ...(fail !== undefined && command.expects_output_keys.includes('failed') ? { fail } : {}),
        });
      if (after === undefined) return { ...done, outputs: { ...done.outputs, ...sent } };
      // Only what the server asked for: an older one refuses a key it does not know. Why the form
      // was not sent says more than anything the watch saw.
      const wanted = Object.fromEntries(Object.entries(after).filter(([key]) => command.expects_output_keys.includes(key)));
      return { ...done, outputs: { ...done.outputs, ...wanted, ...sent } };
    }

    // D-335 slice L — types into a field that suggests as you type, then picks the suggestion whose
    // text is `args.pick` (`page-pick.ts`). Nothing is clicked unless exactly one matches, and the
    // answer says whether the field took it.
    if (action === 'pick') {
      const begun = Date.now();
      const request = readElementRequest(command.args);
      if ('error' in request) return errorOutcome('unknown', `bridge: ${request.error}`);
      const value = stringArg(command.args, 'value');
      const want = stringArg(command.args, 'pick');
      if (!request.page || value === null || value.trim() === '' || want === null || want.trim() === '') {
        return errorOutcome('unknown', 'bridge: pick needs the page, the field, the text to type and the suggestion to pick');
      }
      if (!api.executeInDocument) return errorOutcome('unknown', 'bridge: this browser cannot act on a page by ref');
      const document = request.page;
      const refused = await pageRefusal(document.tab_id, blocked);
      if (refused) return refused;
      const named = request.scope.ref ?? request.scope.selector!;
      const changed = await rebindRef(api, document, request.scope.ref, true);
      if (changed) return changed;
      // The field, read without touching it, as before any write by ref; and (slice W) what finds it
      // again, for a server that keeps the turn's steps.
      const keeps = command.expects_output_keys.includes(BRIDGE_ACTED_ON_KEY);
      const probe = await byRef(api, document, request.scope.ref,
        () => runInDocument(api, document, describePageElement, [request.scope, null, keeps ? SELECTOR_RULES : null]));
      if (!probe || probe.document_id !== document.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const found = describeOutcome(probe.result, document,
        { pattern: command.target_domain_pattern, blockedMessage: 'The owner client cannot be automated.' });
      if (found.status !== 'ok') return found;
      // Slice R — as any write: not in a document on a listed site, a frame's included.
      const listedHere = siteRefusal(String(found.outputs!.url), blocked);
      if (listedHere) return listedHere;
      if (cancel.signalled) return cancelled();
      const url = found.outputs!.url as string;
      const ref = request.scope.ref ?? null;
      const selector = request.scope.selector ?? '';
      // What shows near the field before the typing; then the typing, as `fill` types.
      await runInDocument(api, document, notePickLists, [selector, ref, PICK_RULES]);
      const typing = await byRef(api, document, ref ?? undefined,
        () => runInDocument(api, document, fillPageField, [selector, value, url, ...(ref === null ? [] : [ref])]));
      if (!typing || typing.document_id !== document.document_id) return uncertain();
      const typed = fieldOutcome(typing.result, named, 'fill', errorOutcome('selector_not_found', PAGE_CHANGED));
      if (typed.status !== 'ok') return typed;

      // Then the suggestion, as soon as it shows, until what shows stays the same or the time runs out.
      const most = Math.max(0, Math.min(BRIDGE_PICK_MAX_MS, command.timeout_ms - 8_000));
      const waitMs = typeof command.args.pick_ms === 'number' && Number.isFinite(command.args.pick_ms)
        ? Math.max(0, Math.min(most, command.args.pick_ms)) : Math.min(PICK_DEFAULT_MS, most);
      const started = Date.now();
      let seen: { none?: string[]; several?: string[]; no_list?: true } = { no_list: true };
      let seenKey = '';
      let steadySince = started;
      let keyed = false;
      let chosen: { found: string; label: string; url: string } | undefined;
      for (;;) {
        if (cancel.signalled) return cancelled();
        const looked = await runInDocument(api, document, findPickOption, [selector, ref, want, PICK_RULES]);
        if (!looked || looked.document_id !== document.document_id) {
          return errorOutcome('value_not_applied', `The page moved on once “${value}” was typed, before a suggestion was picked.`);
        }
        const answer = (looked.result ?? {}) as Record<string, unknown>;
        if (answer.blocked === true) return errorOutcome('tab_navigation_blocked', 'The owner client cannot be automated.');
        if (answer.gone === true) {
          return errorOutcome('value_not_applied', 'The field went from the page once it was typed into, so nothing was picked.');
        }
        if (typeof answer.found === 'string' && typeof answer.label === 'string' && typeof answer.url === 'string') {
          chosen = { found: answer.found, label: answer.label, url: answer.url };
          break;
        }
        const now = Date.now();
        const key = JSON.stringify(answer);
        if (key !== seenKey) {
          seenKey = key;
          steadySince = now;
          seen = answer as typeof seen;
        }
        // A picker that searches on keys heard none from the typing: type it again, a key at a time.
        if (seen.no_list === true && !keyed && now - started >= PICK_KEYS_AFTER_MS) {
          keyed = true;
          await runInDocument(api, document, typeWithKeys, [selector, ref, value]);
          continue;
        }
        if (seen.no_list !== true && now - steadySince >= PICK_STEADY_MS) break;
        if (now - started >= waitMs) break;
        await new Promise(resolve => setTimeout(resolve, PICK_POLL_MS));
      }
      if (chosen === undefined) {
        const listed = (labels: readonly string[]) => labels.map(label => `“${label}”`).join('; ');
        return errorOutcome('value_not_applied', seen.several !== undefined
          ? `Several of its suggestions match “${want}”: ${listed(seen.several)}. Pick one of them by its whole text.`
          : seen.none !== undefined
            ? `None of its suggestions is “${want}”. They were: ${listed(seen.none)}. Pick one of them by its text.`
            : `No suggestions showed within ${Math.round(waitMs / 1000)} seconds of typing “${value}”, so nothing was `
              + 'picked. The text is in the field.');
      }

      // The click on it, as a person's, by the ref it was given.
      if (cancel.signalled) return cancelled();
      const pressing = await runInDocument(api, document, clickPageElement, ['', chosen.url, chosen.found]);
      if (!pressing || pressing.document_id !== document.document_id) return uncertain();
      const pressed = fieldOutcome(pressing.result, chosen.label, 'click',
        errorOutcome('selector_not_found', `The suggestion “${chosen.label}” went from the page before it could be clicked.`));
      if (pressed.status !== 'ok') return pressed;
      const outputs: Record<string, unknown> = { filled: true, picked: chosen.label,
        ...(keeps ? { acted_on: actedOn(found.outputs!) } : {}) };
      // A suggestion can be a link: the page the tab shows once the click settles, as a click answers.
      let moved = false;
      if (api.pageAfterClick && command.expects_output_keys.includes('page')) {
        const list = blocked ?? [];
        const left = Math.max(0, command.timeout_ms - (Date.now() - begun) - 3_000);
        const settleMs = Math.min(BRIDGE_CLICK_SETTLE_MS, left);
        const after = await api.pageAfterClick(document.tab_id, { url: chosen.url, page: formatPageHandle(document),
          ...frameOf(probe) },
          command.target_domain_pattern, { settleMs, loadMs: Math.max(0, Math.min(BRIDGE_CLICK_LOAD_MAX_MS, left - settleMs)) },
          (address) => isOnBlockedSite(address, list), { challenge: command.expects_output_keys.includes('challenge') });
        if (after !== undefined) {
          moved = after.moved;
          for (const [key, item] of Object.entries(after)) if (command.expects_output_keys.includes(key)) outputs[key] = item;
        }
      }
      // Whether the field took it: a page that moved on did something with it.
      if (!moved) {
        const until = Date.now() + PICK_CHECK_MS;
        let took: Record<string, unknown> | undefined;
        for (;;) {
          const checking = await runInDocument(api, document, pickTook, [selector, ref, value, want, PICK_RULES]);
          if (!checking || checking.document_id !== document.document_id) {
            took = undefined;
            break;
          }
          took = (checking.result ?? {}) as Record<string, unknown>;
          if (took.took !== undefined || took.unknown === true || Date.now() >= until) break;
          await new Promise(resolve => setTimeout(resolve, PICK_POLL_MS));
        }
        if (took !== undefined && took.took === undefined && took.unknown !== true) {
          return errorOutcome('value_not_applied', took.open === true
            ? `“${chosen.label}” was clicked, but its list is still open and nothing shows it was picked.`
            : `“${chosen.label}” was clicked, but the field does not show it, so it may not have been picked.`);
        }
      }
      return { status: 'ok', outputs };
    }

    // D-335 slice H — waiting, a table and a picture, each in the document a
    // page handle names. All three need the handle: on a site pattern alone
    // they would act on whichever tab matched it, the fault of the older
    // `wait_for_selector`, `extract_table` and `screenshot` below.
    if (action === 'wait_for_element' || action === 'read_table' || action === 'screenshot_page' || action === 'scroll') {
      const handle = parsePageHandle(command.args.page);
      if (!handle) {
        return errorOutcome('unknown', 'bridge: this needs the page handle that listing the tabs or opening a page answered');
      }
      if (!api.executeInDocument) return errorOutcome('unknown', 'bridge: this browser cannot read pages by handle');
      const refused = await pageRefusal(handle.tab_id, blocked);
      if (refused) return refused;
      if (cancel.signalled) return cancelled();

      if (action === 'wait_for_element') {
        // The wait ends inside the command's own budget, leaving time to answer.
        const most = Math.max(0, Math.min(BRIDGE_WAIT_MAX_MS, command.timeout_ms - 2_000));
        const request = readWaitRequest(command.args, most, Math.min(BRIDGE_WAIT_DEFAULT_MS, most));
        if ('error' in request) return errorOutcome('unknown', `bridge: ${request.error}`);
        // Slice K — the step's failure (`fail`), and an error message the step led to
        // (`problems`), are watched for alongside, and either ends the wait as soon as it shows.
        const fail = readFailCheck(command.args.fail);
        if (fail === null) return errorOutcome('unknown', 'bridge: fail is { selector, text } naming what means the step failed');
        const problems = command.args.problems === true;
        const started = Date.now();
        for (;;) {
          if (cancel.signalled) return cancelled();
          const ran = await runInDocument(api, handle, checkPageElement, [request.check]);
          if (!ran || ran.document_id !== handle.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
          const read = waitCheckOutcome(ran.result);
          if ('error' in read) return read.error;
          if (!isPatternWithinGrantedOrigins(read.url, [command.target_domain_pattern])) {
            return errorOutcome('tab_navigation_blocked', 'The page is no longer on a site this step may read.');
          }
          // Slice R — a frame's handle: its own site decides.
          const listedHere = siteRefusal(read.url, blocked);
          if (listedHere) return listedHere;
          const waited = Date.now() - started;
          const answer = (outcome: Record<string, unknown>): ActionExecutorOutcome => ({ status: 'ok',
            outputs: { page: formatPageHandle(handle), url: read.url, title: read.title, waited_ms: waited, ...outcome } });
          // The step's own failure wins over what it waits for, as the server decides it.
          if (fail !== undefined) {
            const failing = await runInDocument(api, handle, checkPageElement, [fail]);
            const failed = failing && failing.document_id === handle.document_id ? waitCheckOutcome(failing.result) : undefined;
            if (failed !== undefined && !('error' in failed) && failed.met) return answer({ found: false, failed: true });
          }
          if (read.met) return answer({ found: true });
          // An error message the page now shows, which Recued recognizes: only while nothing the
          // step waits for has shown.
          if (problems) {
            const said = await runInDocument(api, handle, pageProblem, [PAGE_MESSAGE_RULES]);
            if (said !== null && said.document_id === handle.document_id && typeof said.result === 'string') {
              return answer({ found: false, problem: said.result });
            }
          }
          if (waited >= request.timeout_ms) return answer({ found: false });
          await new Promise(resolve => setTimeout(resolve, Math.min(PAGE_WAIT_POLL_MS, request.timeout_ms - waited)));
        }
      }

      const request = readInspectRequest(command.args);
      if ('error' in request) return errorOutcome('unknown', `bridge: ${request.error}`);
      await rebindRef(api, handle, request.scope.ref);
      // D-335 slice U — a screen at a time, left there; then a moment for what that brought in.
      if (action === 'scroll') {
        const to = command.args.to;
        const screen = command.args.screen;
        if (to !== undefined && !(BRIDGE_SCROLL_TO as readonly unknown[]).includes(to)) {
          return errorOutcome('unknown', `bridge: to is ${BRIDGE_SCROLL_TO.join(', ')}`);
        }
        if (screen !== undefined && (!Number.isSafeInteger(screen) || (screen as number) < 1)) {
          return errorOutcome('unknown', 'bridge: screen is a whole number from 1, the top of the page');
        }
        const measure = async (at: number | null) => {
          const ran = await byRef(api, handle, request.scope.ref,
            () => runInDocument(api, handle, measurePageArea, [request.scope, null, at, null, PAGE_SCREEN_STEP, false]));
          if (!ran || ran.document_id !== handle.document_id) return { error: errorOutcome('selector_not_found', PAGE_GONE) };
          return measured(ran.result);
        };
        const now = await measure(null);
        if ('error' in now) return now.error;
        const moved = await measure(scrollTarget({ screen: now.screen ?? 1, screens: now.screens ?? 1 },
          to as BridgeScrollTo | undefined, screen as number | undefined));
        if ('error' in moved) return moved.error;
        await runInDocument(api, handle, waitForQuiet, [PAGE_SCROLL_QUIET_MS, PAGE_SCROLL_SETTLE_MS, PAGE_SCROLL_FIRST_MS]);
        // As it is now: a feed that loaded more has more screens.
        const after = await measure(null);
        const read = 'error' in after ? moved : after;
        if (!isPatternWithinGrantedOrigins(read.url, [command.target_domain_pattern])) {
          return errorOutcome('tab_navigation_blocked', 'The page is no longer on a site this step may read.');
        }
        const listedHere = siteRefusal(read.url, blocked);
        if (listedHere) return listedHere;
        return { status: 'ok', outputs: { page: formatPageHandle(handle), url: read.url, title: read.title,
          screen: read.screen ?? 1, screens: read.screens ?? 1 } };
      }
      if (action === 'read_table') {
        const ran = await byRef(api, handle, request.scope.ref,
          () => runInDocument(api, handle, readPageTable, [request.scope, PAGE_TABLE_LIMITS]));
        if (!ran || ran.document_id !== handle.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
        const table = tableOutcome(ran.result, handle, { pattern: command.target_domain_pattern });
        // Slice R — a frame's handle: its own site decides, and nothing read on a listed one is answered.
        return table.status === 'ok' ? siteRefusal(String(table.outputs!.url), blocked) ?? table : table;
      }
      if (!api.pageCapture) return errorOutcome('unknown', 'bridge: this browser cannot take screenshots');
      // D-335 slice S — one screen of a long page (or element), counted from 1 at its top.
      const screen = command.args.screen;
      if (screen !== undefined && (!Number.isSafeInteger(screen) || (screen as number) < 1)) {
        return errorOutcome('unknown', 'bridge: screen is a whole number from 1, the top of the page');
      }
      const list = blocked ?? [];
      return capturePage(api.pageCapture, { page: handle, scope: request.scope, pattern: command.target_domain_pattern,
        blocked: url => isOnBlockedSite(url, list), ...(screen !== undefined ? { screen: screen as number } : {}),
        screens: command.expects_output_keys.includes('screens') });
    }

    const tab = await api.findTabByUrlPattern(command.target_domain_pattern);
    if (!tab) return tabUnavailable(command.target_domain_pattern);
    const refused = siteRefusal(tab.url, blocked);
    if (refused) return refused;
    if (cancel.signalled) return cancelled();

    // ⛔⛔ THE CAPTURE PATH HAS NO INJECTED FUNCTION, SO IT HAD NO GUARD.
    // D-261 F32 stopped ordinary DOM actions from driving the owner's client by
    // checking `data-recued-owner-surface` INSIDE each injected function —
    // read_dom, click, fill, extract_table. `captureVisibleTab` reads pixels
    // instead of running script, so it inherited nothing, and a recipe holding
    // DOM capability with a `target_domain_pattern` matching the webclient could
    // photograph a pending review: the message body, the attachments, the
    // approval buttons. Reading is the whole point of a screenshot, so "it only
    // reads" is not mitigation here — it is the attack.
    //
    // The probe is a separate injection, so it cannot be atomic with the
    // capture; `captureVisibleTab` re-confirms the domain pattern on its own,
    // and the realistic case is a recipe simply aimed at the owner's origin,
    // which this catches.
    //
    // ⚠ THE THREE OUTCOMES, AND WHY THEY DIFFER. `true` is the owner surface —
    // refuse. A THROW means the injection was refused, so we cannot prove
    // anything; refuse, at almost no cost, because a page too restricted to
    // inject into is generally too restricted to capture anyway. Any OTHER
    // resolved value is a shim anomaly, not an attack: the probe runs in an
    // isolated world, so a hostile page cannot reach in and force our function
    // to return a non-boolean. Treating that as "not the owner" costs no safety
    // against the actual threat and keeps ordinary captures working.
    const capturesOwnerSurface = async (tab_id: number): Promise<boolean> => {
      try {
        return await api.executeScript(
          tab_id,
          () => document.documentElement.hasAttribute('data-recued-owner-surface'),
          { selector: '' },
        ) === true;
      } catch {
        return true;
      }
    };

    if (action === 'screenshot') {
      if (await capturesOwnerSurface(tab.tab_id)) {
        return errorOutcome('tab_navigation_blocked', 'The owner client cannot be captured.');
      }
      // D-169 bridge security hunt, F1 — confine the capture to the MATCHED
      // tab. `captureVisibleTab` grabs whatever tab is ACTIVE in the window, so
      // the shim activates the matched tab (`tab.tab_id`) and re-confirms the
      // now-active tab still satisfies the command's domain pattern before
      // capturing; a null return (matched tab gone / no longer matches / not
      // foregrounded) fails closed rather than leaking another tab's pixels.
      const data_url = await api.captureVisibleTab({
        tab_id: tab.tab_id,
        window_id: tab.window_id,
        url_pattern: command.target_domain_pattern,
      });
      if (!data_url) {
        return errorOutcome('tab_navigation_blocked', 'bridge: screenshot capture blocked');
      }
      return { status: 'ok', outputs: { data_url } };
    }

    const selector = stringArg(command.args, 'selector');
    if (!selector) {
      return errorOutcome('unknown', 'bridge: action requires selector argument');
    }

    // read_dom and fill run the shared field functions, which carry the owner
    // fence themselves and answer `blocked` rather than throwing.
    if (action === 'read_dom') {
      return fieldOutcome(await api.executeScript(tab.tab_id, readPageField, { selector }), selector, 'read_dom');
    }

    if (action === 'wait_for_selector') {
      const present = (await api.executeScript(
        tab.tab_id,
        (sel) => {
          // The same fence the mutating actions carry. Presence is a weaker
          // read than `read_dom`, but it still answers questions about the
          // owner's client — "is a review pending", "is that dialog open".
          if (document.documentElement.hasAttribute('data-recued-owner-surface')) {
            throw new Error('The owner client cannot be automated.');
          }
          return Boolean(document.querySelector(sel));
        },
        { selector },
      )) as boolean;
      if (!present) return selectorMissing(selector);
      return { status: 'ok', outputs: { present: true } };
    }

    // click and fill run the shared functions too (`page-fields.ts`), which
    // answer `blocked` for the owner client rather than throwing.
    if (action === 'click') {
      return fieldOutcome(await api.executeScript(tab.tab_id, clickPageElement, { selector }), selector, 'click');
    }

    if (action === 'fill') {
      const value = stringArg(command.args, 'value');
      if (value === null) {
        return errorOutcome('unknown', 'bridge: fill action requires value argument');
      }
      return fieldOutcome(await api.executeScript(tab.tab_id, fillPageField, { selector, value }), selector, 'fill');
    }

    if (action === 'extract_table') {
      const rows = (await api.executeScript(
        tab.tab_id,
        (sel) => {
          if (document.documentElement.hasAttribute('data-recued-owner-surface')) throw new Error('The owner client cannot be automated.');
          const table = document.querySelector(sel) as HTMLTableElement | null;
          if (!table) return null;
          const headers: string[] = [];
          const head_row = table.querySelector('tr');
          if (head_row) {
            head_row.querySelectorAll('th, td').forEach((cell) => {
              headers.push((cell.textContent ?? '').trim());
            });
          }
          const out: Array<Record<string, string>> = [];
          const body_rows = table.querySelectorAll('tbody tr');
          body_rows.forEach((row) => {
            const cells = row.querySelectorAll('td');
            const r: Record<string, string> = {};
            cells.forEach((c, i) => {
              r[headers[i] ?? `col_${i}`] = (c.textContent ?? '').trim();
            });
            out.push(r);
          });
          return out;
        },
        { selector },
      )) as Array<Record<string, string>> | null;
      if (rows === null) return selectorMissing(selector);
      return { status: 'ok', outputs: { rows } };
    }

    return errorOutcome('unknown', `bridge: unsupported action: ${action}`);
  };

  return {
    async execute(req: ActionExecutorRequest) {
      const outcome = await executeOne(req.action, req.command, req.cancel);
      if (outcome.status === 'ok' && outcome.outputs) {
        if (!validateOutputKeys(outcome.outputs, req.command.expects_output_keys)) {
          return errorOutcome(
            'unknown',
            'bridge: executor returned unexpected output keys',
            req.command.expects_output_keys.join(','),
          );
        }
      }
      return outcome;
    },
  };
};
