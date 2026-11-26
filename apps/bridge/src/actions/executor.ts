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
  BRIDGE_READ_QUIET_MS,
  BRIDGE_PICK_MAX_MS,
  BRIDGE_WATCH_MAX_MS,
  BRIDGE_WAIT_MAX_MS,
  BRIDGE_SCROLL_TO,
  isHorizontalScrollDirection,
  BRIDGE_FILE_MAX_BYTES,
  BRIDGE_TEXT_MAX_CHARS,
  BRIDGE_UPLOAD_MAX_FILES,
  BRIDGE_GENERATED_DOWNLOAD_KEY,
  BRIDGE_GENERATED_DOWNLOADS_KEY,
  BRIDGE_ROW_CHANGED_DETAIL,
  bridgeElementChangedMessage,
  isPatternWithinGrantedOrigins,
  isBrowserClickRefusal,
  parseBridgeKey,
  readBrowserDragTarget,
  type BridgeAction,
  type BridgeActedOn,
  type BridgeProtectedKind,
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
import { capturePage, measured, measurePageArea, PAGE_SCREEN_STEP,
  type ElementScrollPhase, type PageCaptureChrome } from './page-capture.js';
import { PAGE_SCROLL_FIRST_MS, PAGE_SCROLL_QUIET_MS, PAGE_SCROLL_SETTLE_MS, scrollTarget, waitForQuiet } from './page-scroll.js';
import { clickPageElement, fillPageField, readNavigationGuard, readPageField, submitPageForm } from './page-fields.js';
import { pageChallenge } from './page-challenge.js';
import { pressPageKey } from './page-keys.js';
import { seekPageMedia } from './page-media.js';
import { hoverPageElement } from './page-hover.js';
import { dragPageElement } from './page-drag.js';
import { attachPageFile, BLOCKED_DOWNLOAD_MESSAGE, fetchFile, fileTooLarge, NO_FILE_ADDRESS, NOT_FILE_FIELD, pageFileAddress, type AttachedFile,
  type FetchedFile, type PageFileAddress, type UploadPart } from './page-files.js';
import { pageIdentity, type PageMove, type PageReadiness } from './page-tabs.js';
import { SELECTOR_RULES } from '../picker/selector-engine.js';
import { PAGE_MESSAGE_RULES, pageProblem, type PageMessageRules } from './page-problems.js';
import { findPickOption, notePickLists, PICK_RULES, pickTook, typeWithKeys } from './page-pick.js';
import { rebindPageRef } from './page-rebind.js';
import {
  describeOutcome,
  describePageElement,
  formatPageHandle,
  frameObservationId,
  inspectOutcome,
  inspectPage,
  PAGE_CHANGED,
  PAGE_GONE,
  PAGE_REREAD_KEPT_GONE,
  parsePageHandle,
  readElementRequest,
  readInspectRequest,
  settleFrames,
  verifyFrameObservation,
  type PageFrame,
} from './page-inspect.js';
import { BRIDGE_READ_SETTLE_POLL_MS, pageSettleProbe, readSettleMs, readWaitChangeMs, type PageSettleState } from './page-settle.js';
import { PAGE_TABLE_LIMITS, readPageTable, tableOutcome, type PageTableWalk } from './page-table.js';
import { checkPageElement, PAGE_WAIT_POLL_MS, readFailCheck, readReadyCheck, readWaitRequest, waitCheckOutcome,
  type PageWaitCheck } from './page-wait.js';

/** Optional qualification/debug observer: fixed phases and elapsed time only. */
export interface BridgeScriptTiming {
  phase: 'rebind' | 'describe' | 'write' | 'read' | 'check';
  duration_ms: number;
  outcome: 'answered' | 'missing' | 'error';
}
export interface BridgeBrowserApi {
  onScriptTiming?(timing: BridgeScriptTiming): void | Promise<void>;
  executeReviewedDocument?(document: BridgeDocumentIdentity, action: BridgeAction,
    args: Record<string, unknown>): Promise<ActionExecutorOutcome>;
  /** D-335 — run `func` in ONE document: exactly `document_id` when given,
   *  which Chrome refuses once that document has gone, else the tab's top
   *  document. Answers the document Chrome ran it in, with the result
   *  (`executeInChromeDocument` in `page-inspect.ts`). */
  executeInDocument?(target: { tab_id: number; document_id?: string },
    func: (...args: any[]) => unknown, args: readonly unknown[], options?: { immediate?: boolean }): Promise<{ document_id: string; result: unknown; frame_id?: number } | null>;
  /** D-335 slice R — the frames of a tab a script of the Bridge may read, besides its top page
   *  (`listChromeFrames` in `page-inspect.ts`): an inspection names each from another site as a page. */
  listFrames?(tab_id: number): Promise<PageFrame[]>;
  /** D-335 slice C — the open tabs on a site, and a new tab (`page-tabs.ts`,
   *  `chromePageTabs`). */
  /** `blocked` says whether an address is on the owner's list (slice G): such
   *  a tab is never listed, and an opened page that lands on one is closed.
   *  Listing rejects when tab enumeration fails; individual unreadable pages are omitted. */
  listPages?(pattern: string, blocked?: (url: string) => boolean):
    Promise<{ tabs: Array<{ page: string; url: string; title: string }>; truncated: boolean }>;
  openPage?(url: string, pattern: string, waitMs: number, blocked?: (url: string) => boolean, readiness?: PageReadiness): Promise<ActionExecutorOutcome>;
  /** D-335 slice X — a tab moved to an address, back or reloaded, answered as the page it then shows,
   *  and a tab closed (`page-tabs.ts`). Cancellation stops preflight; requested actions retain
   *  their completion or uncertainty receipt. */
  movePage?(tab_id: number, move: PageMove, pattern: string, waitMs: number, blocked?: (url: string) => boolean,
    readiness?: PageReadiness, cancel?: { readonly signalled: boolean }):
    Promise<ActionExecutorOutcome>;
  closePage?(tab_id: number, cancel?: { readonly signalled: boolean }): Promise<ActionExecutorOutcome>;
  /** 2026-11-04 — the page a tab shows once a click on it has settled (`page-tabs.ts`); with
   *  `checks.challenge` (slice J), and a CAPTCHA it shows that nobody has solved; with
   *  `checks.problems` and `checks.fail` (slice K), an error message the click led to and whether
   *  the step's failure shows. Any of them, on the page clicked (`before.page`), ends the watch as
   *  soon as it shows. */
  pageAfterClick?(tab_id: number, before: { url: string; page?: string; frame_id?: number }, pattern: string,
    waits: { settleMs: number; loadMs: number }, blocked?: (url: string) => boolean,
    checks?: { challenge?: boolean; problems?: PageMessageRules; fail?: PageWaitCheck; ready?: PageWaitCheck; domReady?: boolean }):
    Promise<{ moved: boolean; page?: string; url?: string; title?: string; challenge?: string; problem?: string;
      failed?: boolean; loading?: boolean } | undefined>;
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
  // D-402 slice G (§3.1) — what a protected field takes, for the record of a job made into a recipe.
  ...(found.protected === true && typeof found.protected_kind === 'string' ? { protected_kind: found.protected_kind as BridgeProtectedKind } : {}),
});

/** Translate a shared field function's answer (`page-fields.ts`). It must be
 *  exactly one known key: anything else proves nothing, so a read fails and a
 *  write stays uncertain, since the page may have changed. `blocked` is the
 *  owner client unless the caller knows better (a write by ref, where it means
 *  the page moved after it was read). */
const fieldOutcome = (
  answer: unknown,
  selector: string,
  action: 'read_dom' | 'fill' | 'click' | 'submit' | 'press' | 'drag' | 'seek_media',
  blocked = errorOutcome('tab_navigation_blocked', 'The owner client cannot be automated.'),
  capturesDownload = false,
  pastes = false,
): ActionExecutorOutcome => {
  const write = action !== 'read_dom';
  const unproven = write ? uncertain() : errorOutcome('unknown', `bridge: no readable answer for ${selector}`, selector);
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== 1) return unproven;
  const reply = answer as { blocked?: unknown; missing?: unknown; stale?: unknown; protected?: unknown;
    not_applied?: unknown; uncertain?: unknown; outputs?: unknown; several?: unknown; row_changed?: unknown; partial_clicks?: unknown };
  if (reply.blocked === true) return blocked;
  if (reply.missing === true) return selectorMissing(selector);
  // D-402 slice G (§4 rule 4) — a selector that names several elements: which one is not said, so none
  // was written to.
  if (write && typeof reply.several === 'number') {
    if (action === 'seek_media') return errorOutcome('selector_not_found',
      `“${selector}” names ${reply.several} elements. Name one media element to seek within it.`, selector);
    return errorOutcome('selector_not_found', `“${selector}” names ${String(reply.several)} elements on the page, so nothing was `
      + `${action === 'fill' ? (pastes ? 'pasted' : 'typed') : action === 'press' ? 'pressed' : action === 'submit' ? 'sent' : 'clicked'}: name one of them`, selector);
  }
  // D-402 slice G (§4.1) — the row the step named its element by no longer shows what it did: refused
  // before anything was typed or clicked, which the detail tells the server.
  if (write && typeof reply.row_changed === 'string') return errorOutcome('selector_not_found', reply.row_changed, BRIDGE_ROW_CHANGED_DETAIL);
  // A ref whose element has gone: nothing was typed or clicked.
  if (reply.stale === true) return errorOutcome('selector_not_found', PAGE_CHANGED, selector);
  if (action === 'click' && (reply.partial_clicks === 1 || reply.partial_clicks === 2)) {
    const clicked = reply.partial_clicks === 1 ? 'one click' : 'two clicks';
    return errorOutcome('delivery_uncertain',
      `The target changed after ${clicked} and the double-click gesture stopped. Inspect the page before retrying.`, selector);
  }
  if (write && reply.uncertain === true) return errorOutcome('delivery_uncertain',
    pastes ? 'The page may have received the paste. Inspect its state before repeating it.'
      : action === 'seek_media' ? 'The browser did not confirm the seek. Inspect the media position before retrying.'
      : 'The page or navigation link changed during pointer interaction. Inspect the page before repeating the action.', selector);
  if (!write && reply.protected === true) {
    return errorOutcome('field_protected',
      'The Browser Bridge does not read password, hidden, sign-in code or payment card fields.', selector);
  }
  // A write that did not happen, and why: confirmed, not uncertain. A click is
  // refused on an element that is disabled or that something else covers.
  if (write && typeof reply.not_applied === 'string') return errorOutcome('value_not_applied', reply.not_applied, selector);
  if (action === 'click' && isBrowserClickRefusal(reply.not_applied)) return { status: 'error', error: {
    code: 'value_not_applied', message: reply.not_applied.message, detail: selector, obstruction: reply.not_applied.obstruction } };
  const outputs = reply.outputs;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)) return unproven;
  const only = outputs as Record<string, unknown>;
  const keys = Object.keys(only);
  // Slice U — a key pressed, and whether Enter sent the form it was pressed in.
  if (action === 'press') {
    return typeof only.pressed === 'string' && keys.every((key) => key === 'pressed' || (key === 'sent' && only.sent === true))
      ? { status: 'ok', outputs: only } : unproven;
  }
  if (action === 'seek_media') {
    return keys.length === 2 && typeof only.seeked_to === 'number' && Number.isFinite(only.seeked_to) && typeof only.paused === 'boolean'
      ? { status: 'ok', outputs: only } : unproven;
  }
  if (action === 'click' && capturesDownload) {
    return only.clicked === true && keys.every(key => key === 'clicked'
      || key === BRIDGE_GENERATED_DOWNLOAD_KEY || key === BRIDGE_GENERATED_DOWNLOADS_KEY)
      ? { status: 'ok', outputs: only } : unproven;
  }
  if (keys.length !== 1) return unproven;
  const proven = action === 'read_dom' ? typeof only.text === 'string'
    : action === 'fill' ? (pastes ? only.pasted : only.filled) === true
      : action === 'submit' ? only.submitted === true : action === 'drag' ? only.dropped === true : only.clicked === true;
  return proven ? { status: 'ok', outputs: only } : unproven;
};

/** Only a complete upload answer proves success or that no write happened.
 *  Validate before reference recovery, which may retry a confirmed stale refusal. */
const isUploadAnswer = (answer: unknown, count?: number, delivery?: 'drop'): answer is AttachedFile => {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
  const receipt = answer as Record<string, unknown>;
  const keys = Object.keys(receipt);
  if (keys.length === 1) {
    const key = keys[0]!;
    return ['blocked', 'missing', 'stale', 'uncertain'].includes(key) ? receipt[key] === true
      : ['not_file_field', 'not_applied'].includes(key) && typeof receipt[key] === 'string';
  }
  const delivered = delivery === 'drop' ? 'dropped' : 'attached';
  const names = receipt[delivered];
  return keys.length === 3 && keys.every(key => [delivered, 'url', 'title'].includes(key))
    && (count === undefined ? typeof names === 'string' && names !== ''
      : Array.isArray(names) && names.length === count && names.every(name => typeof name === 'string' && name !== ''))
    && typeof receipt.url === 'string' && typeof receipt.title === 'string';
};

const readUploadParts = (value: unknown): UploadPart[] | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.length > BRIDGE_UPLOAD_MAX_FILES) return undefined;
  const files: UploadPart[] = [];
  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
    const { filename, mime_type, data } = item as Record<string, unknown>;
    if (typeof filename !== 'string' || filename === '' || typeof mime_type !== 'string' || typeof data !== 'string'
      || data.length > Math.ceil(BRIDGE_FILE_MAX_BYTES / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return undefined;
    total += data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (total > BRIDGE_FILE_MAX_BYTES) return undefined;
    files.push({ filename, mime_type, data });
  }
  return files;
};

/** Only a complete target can authorize a fetch or a cross-origin retry. */
const isPageFileAddress = (answer: unknown): answer is PageFileAddress => {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
  const receipt = answer as Record<string, unknown>;
  const keys = Object.keys(receipt);
  if (keys.length === 1) return ['blocked', 'missing', 'stale', 'no_address'].includes(keys[0]!) && receipt[keys[0]!] === true;
  if (keys.length !== 4 || !keys.every(key => ['address', 'cross_origin', 'url', 'title'].includes(key))
    || typeof receipt.address !== 'string' || typeof receipt.url !== 'string' || typeof receipt.title !== 'string'
    || typeof receipt.cross_origin !== 'boolean') return false;
  try {
    const address = new URL(receipt.address);
    const page = new URL(receipt.url);
    // The locator returns URL.href and location.href. Keeping their canonical
    // forms prevents policy checks and page-relative fetch from disagreeing.
    return ['http:', 'https:'].includes(address.protocol) && ['http:', 'https:'].includes(page.protocol)
      && address.href === receipt.address && page.href === receipt.url
      && receipt.cross_origin === (address.origin !== page.origin);
  } catch { return false; }
};

/** A download acknowledges one outcome. Accepted bytes must agree with the
 *  file's size and stay inside this command's budget. */
const isFetchedFileAnswer = (answer: unknown, most: number): answer is FetchedFile => {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
  const receipt = answer as Record<string, unknown>;
  const keys = Object.keys(receipt);
  if (keys.length === 1 && keys[0] === 'blocked' && receipt.blocked === true) return true;
  if (keys.length === 1 && keys[0] === 'failed' && typeof receipt.failed === 'string') return true;
  if ((keys.length === 1 || keys.length === 2 && receipt.at_least === true)
    && keys.every(key => key === 'too_large' || key === 'at_least')
    && typeof receipt.too_large === 'number' && Number.isFinite(receipt.too_large) && receipt.too_large > most) return true;
  const { address, filename, mime_type, size, data } = receipt;
  if (keys.length !== 5 || !keys.every(key => ['address', 'filename', 'mime_type', 'size', 'data'].includes(key))
    || typeof address !== 'string' || typeof filename !== 'string' || filename === ''
    || typeof mime_type !== 'string' || mime_type === '' || typeof size !== 'number'
    || !Number.isSafeInteger(size) || size < 0 || size > most || typeof data !== 'string'
    || data.length > Math.ceil(most / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
  try {
    if (!['http:', 'https:'].includes(new URL(address).protocol)) return false;
  } catch { return false; }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return data.length / 4 * 3 - padding === size;
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
  options?: { immediate?: boolean },
): Promise<{ document_id: string; result: unknown; frame_id?: number } | null> => {
  const begun = api.onScriptTiming ? performance.now() : 0;
  let outcome: BridgeScriptTiming['outcome'] = 'error';
  try {
    const result = await api.executeInDocument!(target, func, args, ...(options ? [options] : []));
    outcome = result === null ? 'missing' : 'answered';
    return result;
  } catch {
    return null;
  } finally {
    if (api.onScriptTiming) {
      const phase: BridgeScriptTiming['phase'] = func === rebindPageRef ? 'rebind'
        : func === describePageElement ? 'describe'
          : [clickPageElement, fillPageField, submitPageForm, pressPageKey, seekPageMedia, attachPageFile, hoverPageElement, dragPageElement].some(write => write === func) ? 'write'
            : [inspectPage, readPageField, readPageTable].some(read => read === func) ? 'read' : 'check';
      try {
        const pending = api.onScriptTiming({ phase, duration_ms: Math.max(0, performance.now() - begun), outcome });
        if (pending) void pending.catch(() => {});
      } catch { /* Diagnostics cannot fail a browser action. */ }
    }
  }
};

/** The identity guard returns one known outcome; a changed target names both states. */
const isRebindAnswer = (answer: unknown): answer is ReturnType<typeof rebindPageRef> => {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
  const receipt = answer as Record<string, unknown>;
  const keys = Object.keys(receipt);
  if (keys.length !== 1) return false;
  const key = keys[0]!;
  if (['kept', 'rebound', 'stale', 'missing'].includes(key)) return receipt[key] === true;
  const changed = receipt.changed;
  if (key !== 'changed' || !changed || typeof changed !== 'object' || Array.isArray(changed)) return false;
  const detail = changed as Record<string, unknown>;
  const names = Object.keys(detail);
  return names.length === 2 && names.every(name => name === 'now' || name === 'was')
    && typeof detail.now === 'string' && typeof detail.was === 'string';
};

/** D-335 slice M — before a step by ref: a ref whose element the page rebuilt names the same
 *  control again, when the page shows exactly one (`page-rebind.ts`). An action requires a valid
 *  acknowledgement that the ref was kept or rebound; ordinary reads remain best effort.
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
  // A guard that found no document, or another one, is the page-gone case every other step here answers: the
  // caller lists the tabs for the page's current handle, since inspecting this one can only fail again. It answered
  // "could not verify… Inspect the page" after a reload (2026-11-19), and the D-335 browser test of a write after a
  // reload went red. Either way no action runs without a verified acknowledgement.
  if (!ran || ran.document_id !== target.document_id) {
    return act ? errorOutcome('selector_not_found', PAGE_GONE) : undefined;
  }
  if (!isRebindAnswer(ran.result)) {
    return act ? errorOutcome('selector_not_found',
      'The browser could not verify that this is still the inspected element. Inspect the page before trying again.', ref) : undefined;
  }
  const answer = ran.result;
  if ('changed' in answer) {
    return errorOutcome('selector_not_found', bridgeElementChangedMessage(ref, answer.changed.now, answer.changed.was));
  }
  return act && ('stale' in answer || 'missing' in answer) ? errorOutcome('selector_not_found', PAGE_CHANGED) : undefined;
};

class CancelledReferenceRetry extends Error {}
class RefusedReferenceRetry extends Error {
  constructor(readonly outcome: ActionExecutorOutcome) { super(); }
}

/** D-335 slice X (2026-11-06) — a script that reads or acts on an element by ref, run once more
 *  when the page rebuilt that element after {@link rebindRef} found it there. The page's own tasks
 *  run between the Bridge's scripts: a search page that rebuilds its form a moment after its box
 *  takes focus (Wikipedia's does) had a press sent right after the typing find the box at the
 *  rebind, then gone at the press, which refused "The page changed since it was inspected": 20 runs
 *  in 216 on a page rebuilding its box 4 to 26 ms after focus, with every core busy, and none in
 *  216 since. Each such script answers `stale` before it touches anything, so it runs again once
 *  the ref names the rebuilt control. Once: a page that rebuilt it again by then refuses as
 *  before. A retry keeps the initial rebind's action guard, including when the
 *  script is a preparatory read: a changed-content refusal stops the action. */
const byRef = async (
  api: BridgeBrowserApi,
  target: { tab_id: number; document_id?: string },
  ref: string | undefined,
  act: boolean,
  cancel: { signalled: boolean },
  run: () => Promise<{ document_id: string; result: unknown; frame_id?: number } | null>,
): Promise<{ document_id: string; result: unknown; frame_id?: number } | null> => {
  const ran = await run();
  const answer = ran?.result;
  // Only the requested document's lone stale refusal proves this attempt did
  // not act. A mixed reply or another document cannot authorize a retry.
  if (ref === undefined || ran?.document_id !== target.document_id || !answer
    || typeof answer !== 'object' || Array.isArray(answer)) return ran;
  const keys = Object.keys(answer);
  if (keys.length !== 1 || keys[0] !== 'stale' || (answer as { stale?: unknown }).stale !== true) return ran;
  // A real completion above remains authoritative even if cancellation arrived
  // while it was running.
  if (cancel.signalled) throw new CancelledReferenceRetry();
  const changed = await rebindRef(api, target, ref, act);
  if (cancel.signalled) throw new CancelledReferenceRetry();
  if (changed) throw new RefusedReferenceRetry(changed);
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
    const started = Date.now();
    const navigationGuard = readNavigationGuard(command.args.navigation_guard);
    if (navigationGuard === null || navigationGuard && (action !== 'click'
      || !parsePageHandle(command.args.page) || typeof command.args.ref !== 'string')) {
      return errorOutcome('unknown', 'bridge: a navigation_guard needs a click by page and ref with before_url and after_url');
    }
    const clickCount = command.args.click_count;
    if (clickCount !== undefined && (clickCount !== 2 || action !== 'click' || navigationGuard
      || !command.reviewed_document && !parsePageHandle(command.args.page))) {
      return errorOutcome('unknown', 'bridge: a double-click needs a document-bound click');
    }
    const pastes = action === 'fill' && command.args.delivery === 'paste';
    if ((action === 'fill' || action === 'submit' || action === 'pick') && command.args.delivery !== undefined
      && (!pastes || command.reviewed_document || !parsePageHandle(command.args.page)
        || typeof command.args.value !== 'string' || command.args.value.length === 0 || command.args.value.length > BRIDGE_TEXT_MAX_CHARS
        || !command.expects_output_keys.includes('pasted'))) {
      return errorOutcome('unknown', 'bridge: paste needs nonempty text within the size limit and a document-bound target');
    }
    const downloadWait = command.args.download_wait_ms;
    const capturesDownload = action === 'click' && command.expects_output_keys.includes(BRIDGE_GENERATED_DOWNLOAD_KEY);
    const capturesDownloadSet = capturesDownload && command.expects_output_keys.includes(BRIDGE_GENERATED_DOWNLOADS_KEY);
    if (downloadWait !== undefined && (!capturesDownload || !parsePageHandle(command.args.page)
      || typeof downloadWait !== 'number' || !Number.isFinite(downloadWait) || downloadWait <= 0
      || downloadWait > BRIDGE_WATCH_MAX_MS || navigationGuard || command.reviewed_document)) {
      return errorOutcome('unknown', 'bridge: a download wait needs a document-bound click with download capture enabled');
    }
    // D-335 slice G — read once per command; a notification acts on no page.
    const blocked = action === 'os_notification' ? [] : await readBlocked();
    // Cancellation can arrive while the policy is being read, before any page action starts.
    if (cancel.signalled) return cancelled();
    if (command.reviewed_document) {
      if (!api.executeReviewedDocument) return errorOutcome('tab_navigation_blocked', 'This bridge cannot bind reviewed documents.');
      // The reviewed executor acts only while the document is at this address.
      const refused = siteRefusal(command.reviewed_document.url, blocked);
      if (refused) return refused;
      const reviewed = await api.executeReviewedDocument(command.reviewed_document, action, command.args);
      // D-402 slice G — a protected field's kind only when asked, as on the ordinary path.
      if (action === 'describe' && reviewed.status === 'ok' && reviewed.outputs && !command.expects_output_keys.includes('protected_kind')) {
        delete reviewed.outputs.protected_kind;
      }
      return reviewed;
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
      try {
        return { status: 'ok', outputs: await api.listPages(command.target_domain_pattern, url => isOnBlockedSite(url, blocked)) };
      } catch {
        return errorOutcome('unknown', 'The Browser Bridge could not list the tabs. Try listing them again.');
      }
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
        Math.max(1_000, Math.min(20_000, command.timeout_ms - 5_000)), landed => isOnBlockedSite(landed, blocked),
        ...(command.args.dom_ready === true ? [{ domReady: true }] : []));
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
        return api.closePage(handle.tab_id, cancel);
      }
      if (!api.movePage) return errorOutcome('unknown', 'bridge: this browser cannot move tabs');
      const listed = (url: string) => isOnBlockedSite(url, blocked ?? []);
      // Wait for the page within the command's own budget, leaving time to answer.
      const waitMs = Math.max(1_000, Math.min(20_000, command.timeout_ms - 5_000));
      const readiness = command.args.dom_ready === true ? { domReady: true, previousPage: String(command.args.page) } : undefined;
      if (action === 'navigate') {
        const url = stringArg(command.args, 'url');
        if (url === null) return errorOutcome('unknown', 'bridge: navigate requires a url argument');
        // Before the tab moves: a listed site is never asked for.
        const listedThere = siteRefusal(url, blocked);
        if (listedThere) return listedThere;
        return api.movePage(handle.tab_id, { to: 'address', url }, command.target_domain_pattern, waitMs, listed,
          readiness, cancel);
      }
      return api.movePage(handle.tab_id, { to: action === 'go_back' ? 'back' : 'reload' }, command.target_domain_pattern,
        waitMs, listed, readiness, cancel);
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
      const probe = await byRef(api, document, request.scope.ref, true, cancel,
        () => runInDocument(api, document, describePageElement, [request.scope, null, null]));
      if (!probe || probe.document_id !== document.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const found = describeOutcome(probe.result, document,
        { pattern: command.target_domain_pattern, blockedMessage: 'The owner client cannot be automated.' });
      if (found.status !== 'ok') return found;
      const listedHere = siteRefusal(String(found.outputs!.url), blocked);
      if (listedHere) return listedHere;
      if (cancel.signalled) return cancelled();
      const url = found.outputs!.url as string;
      const ran = await byRef(api, document, request.scope.ref, true, cancel, () => runInDocument(api, document, hoverPageElement,
        [request.scope.selector ?? '', url, request.scope.ref ?? null]));
      if (!ran || ran.document_id !== document.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const answer = ran.result as { hovered?: unknown; blocked?: unknown; missing?: unknown; stale?: unknown } | null;
      if (answer?.stale === true) return errorOutcome('selector_not_found', PAGE_CHANGED);
      if (answer?.missing === true) return selectorMissing(request.scope.ref ?? request.scope.selector!);
      if (answer?.hovered !== true) return errorOutcome('tab_navigation_blocked', 'The page moved before the pointer reached it.');
      return { status: 'ok', outputs: { hovered: true, page: formatPageHandle(document), url, title: found.outputs!.title } };
    }

    if (action === 'drag') {
      const request = readElementRequest(command.args);
      const destination = readBrowserDragTarget(command.args.drop);
      if ('error' in request || !request.page || !destination) return errorOutcome('unknown', 'bridge: drag needs a page, source and drop target');
      const start = readBrowserDragTarget(request.scope.ref !== undefined ? { ref: request.scope.ref } : { selector: request.scope.selector });
      if (!start || !api.executeInDocument) return errorOutcome('unknown', 'bridge: drag needs a document-bound source');
      const document = request.page;
      const refused = await pageRefusal(document.tab_id, blocked);
      if (refused) return refused;
      const current = await runInDocument(api, document, pageIdentity, []);
      if (!current || current.document_id !== document.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const identity = current.result as ReturnType<typeof pageIdentity> | null;
      if (!identity || !('url' in identity) || !isPatternWithinGrantedOrigins(identity.url, [command.target_domain_pattern])) {
        return errorOutcome('tab_navigation_blocked', 'The page is no longer on a site this step may use.');
      }
      const listedHere = siteRefusal(identity.url, blocked);
      if (listedHere) return listedHere;
      for (const endpoint of [start, destination]) {
        const changed = await rebindRef(api, document, endpoint.ref, true);
        if (changed) return changed;
      }
      if (cancel.signalled) return cancelled();
      const begun = Date.now();
      const ran = await runInDocument(api, document, dragPageElement, [start, destination, identity.url]);
      if (!ran || ran.document_id !== document.document_id) return uncertain();
      const done = fieldOutcome(ran.result, start.ref ?? start.selector, 'drag');
      if (done.status !== 'ok') return done;
      const before = { page: formatPageHandle(document), url: identity.url, title: identity.title };
      if (!api.pageAfterClick || cancel.signalled) return { status: 'ok', outputs: { dropped: true, ...before } };
      const budget = Math.max(0, command.timeout_ms - (Date.now() - begun) - 3_000);
      const settleMs = Math.min(BRIDGE_CLICK_SETTLE_MS, budget);
      const after = await api.pageAfterClick(document.tab_id, { ...before, ...frameOf(current) }, command.target_domain_pattern,
        { settleMs, loadMs: Math.min(BRIDGE_CLICK_LOAD_MAX_MS, budget - settleMs) },
        address => isOnBlockedSite(address, blocked ?? []));
      const page = Object.fromEntries(Object.entries(after ?? before).filter(([key]) => command.expects_output_keys.includes(key)));
      return { status: 'ok', outputs: { dropped: true, ...page } };
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
      const located = await byRef(api, handle, ref ?? undefined, true, cancel,
        () => runInDocument(api, handle, pageFileAddress, [selector, ref, address]));
      if (!located || located.document_id !== handle.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const where = located.result;
      if (!isPageFileAddress(where)) return errorOutcome('unknown',
        'The browser returned an incomplete or inconsistent download target, so no file was fetched.');
      if ('blocked' in where) return errorOutcome('tab_navigation_blocked', 'The owner client cannot be automated.');
      if ('stale' in where) return errorOutcome('selector_not_found', PAGE_CHANGED);
      if ('missing' in where) return selectorMissing(ref ?? selector!);
      if ('no_address' in where) return errorOutcome('selector_not_found', NO_FILE_ADDRESS);
      const expectedUrl = typeof command.args.expected_url === 'string' ? command.args.expected_url : undefined;
      if (expectedUrl !== undefined && where.url !== expectedUrl) {
        return errorOutcome('selector_not_found', PAGE_CHANGED);
      }
      if (!isPatternWithinGrantedOrigins(where.url, [command.target_domain_pattern])) {
        return errorOutcome('tab_navigation_blocked', 'The page is no longer on a site this step may read.');
      }
      // Neither the page nor the file's own site may be one the owner listed.
      const listedHere = siteRefusal(where.url, blocked) ?? siteRefusal(where.address, blocked);
      if (listedHere) return listedHere;
      if (cancel.signalled) return cancelled();
      const sites = blocked ?? [];
      const inPage = await runInDocument(api, handle, fetchFile, [where.address, most, sites,
        ...(expectedUrl !== undefined ? [null, expectedUrl] : [])]);
      if (inPage && inPage.document_id !== handle.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const invalidFile = () => errorOutcome('unknown',
        'The browser returned an incomplete or inconsistent file result, so no file was accepted.');
      let got = inPage?.result as FetchedFile | null | undefined;
      if (got !== null && got !== undefined && !isFetchedFileAnswer(got, most)) return invalidFile();
      // A download intercepted during a click belongs to this live document.
      if (expectedUrl !== undefined && got == null) return invalidFile();
      if (got == null || ('failed' in got && where.cross_origin && expectedUrl === undefined)) {
        // A fallback starts a new request; a confirmed page result remains authoritative.
        if (cancel.signalled) return cancelled();
        const controller = new AbortController();
        // The shared cancellation flag has no event hook. Observe it only while
        // this worker request is active, including waits for headers and body.
        const observeCancellation = () => { if (cancel.signalled) controller.abort(); };
        const watch = setInterval(observeCancellation, 50);
        try {
          observeCancellation();
          got = await fetchFile(where.address, most, sites, controller.signal);
        } finally {
          clearInterval(watch);
        }
        if (!isFetchedFileAnswer(got, most)) return invalidFile();
        if (controller.signal.aborted && 'failed' in got) return cancelled();
      }
      if ('blocked' in got || ('address' in got && isOnBlockedSite(got.address, sites))) {
        return errorOutcome('tab_navigation_blocked', BLOCKED_DOWNLOAD_MESSAGE);
      }
      if ('too_large' in got) return errorOutcome('unknown', fileTooLarge(got.too_large, got.at_least === true, most));
      if ('failed' in got) return errorOutcome('unknown', `The file at ${where.address} could not be fetched: ${got.failed}.`);
      return { status: 'ok', outputs: { page: formatPageHandle(handle), url: where.url, title: where.title,
        address: got.address, filename: got.filename, mime_type: got.mime_type, size: got.size, data: got.data } };
    }

    // D-335 slice AQ — one of the owner's files into the file field a ref or a selector names, as choosing
    // it there would; read as a write by ref is (the element and its site first, then the file), and
    // never on a site the owner listed. The server asked the owner first, naming the file.
    if (action === 'upload_file' || action === 'upload_files') {
      const delivery = command.args.delivery;
      if (delivery !== undefined && delivery !== 'drop') return errorOutcome('unknown', 'bridge: unsupported file delivery');
      const request = readElementRequest(command.args);
      if ('error' in request) return errorOutcome('unknown', `bridge: ${request.error}`);
      if (!request.page) return errorOutcome('unknown', 'bridge: upload_file needs the page the field is on');
      if (!api.executeInDocument) return errorOutcome('unknown', 'bridge: this browser cannot act on a page by ref');
      const multiple = action === 'upload_files';
      const files = readUploadParts(multiple ? command.args.files : [command.args]);
      if (!files) {
        return errorOutcome('unknown', multiple ? 'bridge: upload_files needs a bounded list of filenames, MIME types and valid base64'
          : 'bridge: upload_file takes a filename, a mime_type and the file in base64');
      }
      const document = request.page;
      const refused = await pageRefusal(document.tab_id, blocked);
      if (refused) return refused;
      const changed = await rebindRef(api, document, request.scope.ref, true);
      if (changed) return changed;
      const probe = await byRef(api, document, request.scope.ref, true, cancel,
        () => runInDocument(api, document, describePageElement, [request.scope, null, null]));
      if (!probe || probe.document_id !== document.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const found = describeOutcome(probe.result, document,
        { pattern: command.target_domain_pattern, blockedMessage: 'The owner client cannot be automated.' });
      if (found.status !== 'ok') return found;
      const listedHere = siteRefusal(String(found.outputs!.url), blocked);
      if (listedHere) return listedHere;
      if (cancel.signalled) return cancelled();
      const url = found.outputs!.url as string;
      const first = files[0]!;
      const ran = await byRef(api, document, request.scope.ref, true, cancel, async () => {
        const reply = await runInDocument(api, document, attachPageFile,
          [request.scope.selector ?? null, request.scope.ref ?? null,
            ...(multiple ? [files, '', ''] : [first.filename, first.mime_type, first.data]), url,
            ...(delivery === 'drop' ? [delivery] : [])]);
        return reply?.document_id === document.document_id && isUploadAnswer(reply.result, multiple ? files.length : undefined, delivery)
          ? reply : null;
      });
      if (!ran) return uncertain();
      const answer = ran.result as AttachedFile;
      if ('blocked' in answer) return errorOutcome('tab_navigation_blocked', 'The page moved or cannot be automated, so no file was attached.');
      if ('stale' in answer) return errorOutcome('selector_not_found', PAGE_CHANGED);
      if ('missing' in answer) return selectorMissing(request.scope.ref ?? request.scope.selector!);
      if ('not_file_field' in answer) return errorOutcome('selector_not_found', NOT_FILE_FIELD);
      if ('not_applied' in answer) return errorOutcome('value_not_applied', answer.not_applied);
      if ('uncertain' in answer) return uncertain();
      return { status: 'ok', outputs: { ...('dropped' in answer ? { dropped: answer.dropped } : { attached: answer.attached }),
        page: formatPageHandle(document), url: answer.url,
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
      // 2026-11-20 — a read asked to settle first waits for the document named by its handle to stop changing
      //   (`page-settle.ts`), inside the command's budget, and answers whether it had. A document that has gone is
      //   the read's own to report.
      let settled: boolean | undefined;
      let changed: boolean | undefined;
      const still = (state: Partial<PageSettleState> | null): boolean => state !== null && typeof state.quiet_ms === 'number'
        && state.quiet_ms >= BRIDGE_READ_QUIET_MS && state.busy === false && state.animating !== true;
      // 2026-11-20 (the owner: "go ahead", a wait at the Bridge) — a plain wait of seconds, sent as a read that waits for a
      //   change (`wait_change_ms`): until the page has changed since the read that left the last mark (a document this
      //   watch had not seen counts as changed), and then holds still, with no spinner started since that read. The read
      //   below then leaves the mark the next wait counts from.
      const changeFor = inspects && request.page ? readWaitChangeMs(command.args.wait_change_ms) : undefined;
      const settleFor = inspects && request.page && changeFor === undefined ? readSettleMs(command.args.settle_ms) : undefined;
      if (changeFor !== undefined && request.page) {
        const budget = Math.max(0, Math.min(changeFor, command.timeout_ms - 2_000));
        const from = Date.now();
        let since: number | undefined;
        changed = false;
        settled = false;
        for (;;) {
          if (cancel.signalled) return cancelled();
          const probe = await runInDocument(api, read, pageSettleProbe, [false], { immediate: true });
          if (!probe || probe.document_id !== request.page.document_id) break;
          const state = probe.result as Partial<PageSettleState> | null;
          if (state !== null && typeof state.changes === 'number') {
            since ??= state.fresh === true ? -1 : typeof state.marked === 'number' ? state.marked : state.changes;
            if (state.changes > since) changed = true;
            if (changed && still(state) && state.spinning !== true) { settled = true; break; }
          }
          const spent = Date.now() - from;
          if (spent >= budget) break;
          await new Promise((resolve) => setTimeout(resolve, Math.min(BRIDGE_READ_SETTLE_POLL_MS, budget - spent)));
        }
        await runInDocument(api, read, pageSettleProbe, [true], { immediate: true });
      }
      if (settleFor !== undefined && request.page) {
        const budget = Math.max(0, Math.min(settleFor, command.timeout_ms - 2_000));
        const from = Date.now();
        for (;;) {
          if (cancel.signalled) return cancelled();
          // Each look leaves the mark: the last, just before the read, is what a later wait counts a change from.
          const probe = await runInDocument(api, read, pageSettleProbe, [true], { immediate: true });
          if (!probe || probe.document_id !== request.page.document_id) break;
          if (still(probe.result as Partial<PageSettleState> | null)) {
            settled = true;
            break;
          }
          const spent = Date.now() - from;
          if (spent >= budget) { settled = false; break; }
          await new Promise((resolve) => setTimeout(resolve, Math.min(BRIDGE_READ_SETTLE_POLL_MS, budget - spent)));
        }
      }
      const ran = await byRef(api, read, request.page ? request.scope.ref : undefined, false, cancel, () => runInDocument(api, read,
        inspects ? inspectPage : describePageElement,
        inspects && command.args.preserve_structure === true
          ? [request.scope, request.limits, null, action === 'reread' ? PAGE_REREAD_KEPT_GONE : 0, command.args.dom_ready === true, null, true,
            command.args.structure_scoped === true]
          : action === 'reread' ? [request.scope, request.limits, null, PAGE_REREAD_KEPT_GONE, ...(command.args.dom_ready === true ? [true] : [])]
          : inspects ? command.args.dom_ready === true ? [request.scope, request.limits, null, 0, true] : [request.scope, request.limits] : [request.scope],
        ...(command.args.dom_ready === true ? [{ immediate: true }] : [])));
      // A page handle names a document Chrome no longer has: it navigated,
      // reloaded or closed.
      if (request.page && (!ran || ran.document_id !== request.page.document_id)) {
        return errorOutcome('selector_not_found', PAGE_GONE);
      }
      if (!ran) return errorOutcome('unknown', 'bridge: the browser did not let the Bridge read the page');
      // Bind observed iframe elements to live Chrome documents in the inspected document's branch.
      const answer = ran.result as { outputs?: { html?: unknown; url?: unknown } } | null;
      if (inspects && typeof answer?.outputs?.html === 'string' && answer.outputs.html.includes('data-recued-frame="')) {
        const id = frameObservationId(answer.outputs.html);
        const url = answer.outputs.url;
        const frames = id && typeof url === 'string' && api.listFrames && blocked !== undefined && !cancel.signalled
          ? await api.listFrames(tab_id).catch(() => null) : null;
        const verified = frames && id && !cancel.signalled
          ? await runInDocument(api, { tab_id, document_id: ran.document_id }, verifyFrameObservation, [id], { immediate: true })
          : null;
        const paths = verified?.document_id === ran.document_id && Array.isArray(verified.result)
          && verified.result.every(path => typeof path === 'string') ? verified.result as string[] : [];
        answer.outputs.html = settleFrames(answer.outputs.html, tab_id, frames,
          address => blocked === undefined || isOnBlockedSite(address, blocked),
          id && typeof url === 'string' ? { id, document_id: ran.document_id, url, paths } : undefined);
      }
      const outcome = (inspects ? inspectOutcome : describeOutcome)(ran.result,
        { tab_id, document_id: ran.document_id },
        { pattern: command.target_domain_pattern, blockedMessage: 'The owner client cannot be automated.' });
      // New selection evidence is opt-in at the command boundary, so this
      // Bridge can still answer an older server's closed output contract.
      if (inspects && outcome.status === 'ok' && outcome.outputs) {
        for (const key of ['selector_matches', 'selected_index']) {
          if (!command.expects_output_keys.includes(key)) delete outcome.outputs[key];
        }
        if (settled !== undefined && command.expects_output_keys.includes('settled')) outcome.outputs.settled = settled;
        if (changed !== undefined && command.expects_output_keys.includes('changed')) outcome.outputs.changed = changed;
      }
      // D-402 slice G — and a protected field's kind (which `acted_on` carries): a describe answers it
      // only when asked, or every server's describe of a password field would fail on its keys.
      if (!inspects && outcome.status === 'ok' && outcome.outputs && !command.expects_output_keys.includes('protected_kind')) {
        delete outcome.outputs.protected_kind;
      }
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
    if (action === 'seek_media' || action === 'submit' || action === 'press' || (
      (action === 'fill' || action === 'click') && (command.args.page !== undefined || command.args.ref !== undefined))) {
      const request = readElementRequest(command.args);
      if ('error' in request) return errorOutcome('unknown', `bridge: ${request.error}`);
      const value = stringArg(command.args, 'value');
      const atSeconds = command.args.at_seconds;
      if (action === 'seek_media' && (typeof atSeconds !== 'number' || !Number.isFinite(atSeconds) || atSeconds < 0)) {
        return errorOutcome('value_not_applied', 'Seek needs a finite, nonnegative media timestamp.');
      }
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
      const changed = navigationGuard ? undefined : await rebindRef(api, document, request.scope.ref, true);
      if (changed) return changed;
      // First the element, read without touching it. A page or an element that
      // has gone is a confirmed failure here: nothing has been typed or clicked.
      // Slice W — and, for a server that keeps the turn's steps, what finds it again another day,
      // worked out before it is acted on, since a click can take it away.
      if (navigationGuard && !request.scope.ref) {
        return errorOutcome('unknown', 'bridge: a navigation_guard needs a click by page and ref with before_url and after_url');
      }
      const fail = action === 'fill' ? undefined : readFailCheck(command.args.fail);
      if (fail === null) return errorOutcome('unknown', 'bridge: fail is { selector, text } naming what means the step failed');
      const readyCheck = readReadyCheck(command.args.ready_check);
      if (readyCheck === null) return errorOutcome('unknown', 'bridge: ready_check needs selector, until and optional text');
      const problems = (action === 'click' || action === 'submit' || action === 'press') && command.expects_output_keys.includes('problem');
      const sendWatch = action === 'click' && typeof command.args.send_watch_ms === 'number'
        && Number.isFinite(command.args.send_watch_ms)
        ? Math.max(0, Math.min(BRIDGE_WATCH_MAX_MS, command.args.send_watch_ms)) : undefined;
      const prepare = problems || sendWatch !== undefined;
      const combined = prepare && readyCheck === undefined;
      const keeps = command.expects_output_keys.includes(BRIDGE_ACTED_ON_KEY);
      const probe = await byRef(api, document, navigationGuard ? undefined : request.scope.ref, true, cancel,
        () => runInDocument(api, document, describePageElement, [request.scope, null, keeps ? SELECTOR_RULES : null,
          ...(combined ? [PAGE_MESSAGE_RULES] : [])]));
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
      if (navigationGuard && url !== navigationGuard.before_url) return errorOutcome('selector_not_found', PAGE_CHANGED);
      // Chrome passes arguments as JSON: an undefined ref would arrive as null.
      const ref = request.scope.ref === undefined ? [] : [request.scope.ref];
      // D-402 slice G (§4.1) — the texts the row around the element showed, checked again just before
      // the click or the typing (`row_checks`).
      const rowTexts = Array.isArray(command.args.within) && command.args.within.length > 0
        && command.args.within.every((text: unknown) => typeof text === 'string') ? command.args.within as string[] : null;
      // 2026-11-21 (D-402, task P) — for an item no list item, table row or row by its role holds, the kind of
      // card it is (`within_card`, `card_rows`), which the row is found by.
      const rowCard = rowTexts !== null && typeof command.args.within_card === 'string' ? command.args.within_card : null;
      const selector = request.scope.selector ?? '';
      if (action === 'seek_media') {
        const ran = await byRef(api, document, request.scope.ref, true, cancel,
          () => runInDocument(api, document, seekPageMedia, [selector, atSeconds, url, request.scope.ref ?? null]));
        if (!ran || ran.document_id !== document.document_id) return uncertain();
        const done = fieldOutcome(ran.result, named, action, errorOutcome('selector_not_found', PAGE_CHANGED));
        return done.status === 'ok' ? { ...done, outputs: { ...done.outputs, ...stable } } : done;
      }
      // Slice K — before a click or a send, what the page says now, so an error message it leads to
      // is told from one already there; and whether a click sends a form, so it is watched as a
      // sent form is. Asked only by a server that wants either.
      let readyAfter: PageWaitCheck | undefined;
      if (readyCheck && action !== 'fill') {
        const probe = await runInDocument(api, document, checkPageElement, [readyCheck]);
        const read = probe?.document_id === document.document_id ? waitCheckOutcome(probe.result) : undefined;
        // A pre-existing success condition cannot shorten the navigation watch.
        if (read && !('error' in read) && read.url === url && !read.met) readyAfter = readyCheck;
      }
      // An explicit readiness probe keeps the old ordering: its read runs
      // before the error baseline is captured. Ordinary commands fuse both.
      let preparation = found.outputs!;
      if (prepare && !combined) {
        const prepared = await byRef(api, document, navigationGuard ? undefined : request.scope.ref, true, cancel,
          () => runInDocument(api, document, describePageElement, [request.scope, url, null, PAGE_MESSAGE_RULES]));
        if (!prepared || prepared.document_id !== document.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
        const read = describeOutcome(prepared.result, document,
          { pattern: command.target_domain_pattern, blockedMessage: 'The owner client cannot be automated.' });
        if (read.status !== 'ok') return read;
        preparation = read.outputs!;
      }
      if (prepare && (typeof preparation.prepared_sends !== 'boolean'
        || preparation.prepared_unsent !== undefined && preparation.prepared_sends !== false)) {
        return errorOutcome('unknown', 'bridge: the action preparation returned no consistent form-send facts');
      }
      const sends = preparation.prepared_sends === true;
      /** A send button on a form the browser will not send, and why: the click sends nothing. */
      const unsent = action === 'click' && typeof preparation.prepared_unsent === 'string'
        ? preparation.prepared_unsent : undefined;
      const typesFirst = action === 'submit' && value !== null;
      // D-347 follow-up 18 — a click waits for what covers its element to go (`clickPageElement`), out of the
      // command's budget: what is left of it after the wait is the watch's below.
      const begun = typeof downloadWait === 'number' ? started : Date.now();
      const clickBudget = command.timeout_ms - (Date.now() - begun) - (typeof downloadWait === 'number' ? downloadWait : 0);
      if (typeof downloadWait === 'number' && clickBudget < 6_000) {
        return errorOutcome('unknown', 'The command ran out of time for the requested download wait before clicking.');
      }
      const clickWait = Math.max(0, Math.min(BRIDGE_CLICK_WAIT_MS, clickBudget - 15_000));
      if (cancel.signalled) return cancelled();
      const ran = await byRef(api, document, navigationGuard ? undefined : request.scope.ref, true, cancel, () => action === 'click'
        ? runInDocument(api, document, clickPageElement, [selector, url, request.scope.ref ?? null, clickWait,
          ...(clickCount === 2 ? [null, rowTexts, rowCard, capturesDownload ? BRIDGE_FILE_MAX_BYTES : null,
            downloadWait ?? null, capturesDownloadSet ? BRIDGE_UPLOAD_MAX_FILES : null, clickCount]
            : capturesDownload ? [navigationGuard?.after_url ?? null, rowTexts, rowCard, BRIDGE_FILE_MAX_BYTES,
            ...(downloadWait !== undefined || capturesDownloadSet ? [downloadWait ?? null] : []),
            ...(capturesDownloadSet ? [BRIDGE_UPLOAD_MAX_FILES] : [])]
            : [...(navigationGuard ? [navigationGuard.after_url] : rowTexts !== null ? [null] : []),
              ...(rowTexts !== null ? [rowTexts, rowCard] : [])])])
        : action === 'press'
          ? runInDocument(api, document, pressPageKey, [selector, url, request.scope.ref ?? null, press])
        : action === 'submit' && !typesFirst
          ? runInDocument(api, document, submitPageForm, [selector, url, request.scope.ref ?? null])
          // Typing, and typing then sending in the same script (slice J).
          : runInDocument(api, document, fillPageField,
            pastes ? [selector, value, url, request.scope.ref ?? null, null, rowTexts, rowCard, 'paste']
              : typesFirst ? [selector, value, url, request.scope.ref ?? null, true, ...(rowTexts !== null ? [rowTexts, rowCard] : [])]
              : rowTexts !== null ? [selector, value, url, request.scope.ref ?? null, null, rowTexts, rowCard] : [selector, value, url, ...ref]));
      if (!ran || ran.document_id !== document.document_id) return uncertain();
      let answer = ran.result;
      if (answer && typeof answer === 'object' && Object.hasOwn(answer, 'linked_download')) {
        const linked = (answer as { linked_download?: unknown }).linked_download;
        if (action !== 'click' || downloadWait === undefined || Object.keys(answer).length !== 1
          || typeof linked !== 'string') return uncertain();
        let address: URL;
        try {
          address = new URL(linked);
          if (!/^https?:$/.test(address.protocol) || address.username || address.password
            || address.origin !== new URL(url).origin) return uncertain();
        } catch { return uncertain(); }
        const saved = await executeOne('download_file', { ...command, action: 'download_file',
          args: { page: formatPageHandle(document), address: address.href, expected_url: url, max_bytes: BRIDGE_FILE_MAX_BYTES } }, cancel);
        const file = saved.outputs;
        answer = { outputs: { clicked: true, generated_download: saved.status === 'ok' && file
          ? { filename: file.filename, mime_type: file.mime_type, size: file.size, data: file.data }
          : { failure: cancel.signalled ? 'interrupted' : 'unreadable' } } };
      }
      const answered = fieldOutcome(answer, named, action, errorOutcome('selector_not_found', PAGE_CHANGED), capturesDownload, pastes);
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
          ...(command.args.dom_ready === true ? { domReady: true } : {}),
          ...(readyAfter !== undefined ? { ready: readyAfter } : {}),
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
      const probe = await byRef(api, document, request.scope.ref, true, cancel,
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
      const selector = request.scope.selector ?? '';
      // What shows near the field before the typing; then the typing, as `fill` types.
      // The note pins selector-based commands to a ref as well, so recovery can
      // only follow the same field or a uniquely matching replacement.
      const noting = await byRef(api, document, request.scope.ref, true, cancel,
        () => runInDocument(api, document, notePickLists, [selector, request.scope.ref ?? null, PICK_RULES]));
      if (cancel.signalled) return cancelled();
      if (!noting || noting.document_id !== document.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
      const note = noting.result && typeof noting.result === 'object' && !Array.isArray(noting.result)
        ? noting.result as ReturnType<typeof notePickLists> : null;
      if (note && 'blocked' in note) return errorOutcome('tab_navigation_blocked', 'The owner client cannot be automated.');
      if (note && 'stale' in note) return errorOutcome('selector_not_found', PAGE_CHANGED);
      if (note && 'missing' in note) return selectorMissing(named);
      if (note && 'several' in note) return fieldOutcome(note, named, 'fill', errorOutcome('selector_not_found', PAGE_CHANGED));
      if (!note || !('noted' in note) || note.noted !== true || typeof note.ref !== 'string'
        || !/^e[1-9]\d{0,8}$/.test(note.ref) || request.scope.ref !== undefined && note.ref !== request.scope.ref) {
        return errorOutcome('unknown', 'The field could not be bound for picking, so nothing was typed.');
      }
      const ref = note.ref;
      const typing = await byRef(api, document, ref, true, cancel,
        () => runInDocument(api, document, fillPageField, [selector, value, url, ref]));
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
        const looked = await byRef(api, document, ref, true, cancel,
          () => runInDocument(api, document, findPickOption, [selector, ref, want, PICK_RULES]));
        if (!looked || looked.document_id !== document.document_id) {
          return errorOutcome('value_not_applied', `The page moved on once “${value}” was typed, before a suggestion was picked.`);
        }
        const answer = (looked.result ?? {}) as Record<string, unknown>;
        if (answer.blocked === true) return errorOutcome('tab_navigation_blocked', 'The owner client cannot be automated.');
        if (answer.gone === true || answer.stale === true) {
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
          if (cancel.signalled) return cancelled();
          keyed = true;
          const again = await byRef(api, document, ref, true, cancel,
            () => runInDocument(api, document, typeWithKeys, [selector, ref, value, url]));
          if (!again || again.document_id !== document.document_id) return uncertain();
          const retried = again.result && typeof again.result === 'object' && !Array.isArray(again.result)
            ? again.result as ReturnType<typeof typeWithKeys> : null;
          if (retried && 'blocked' in retried && retried.blocked === true) {
            return errorOutcome('tab_navigation_blocked', 'The page moved or cannot be automated, so nothing was typed again.');
          }
          if (retried && ('gone' in retried || 'stale' in retried)) {
            return errorOutcome('value_not_applied', 'The field went from the page once it was typed into, so nothing was picked.');
          }
          if (retried && 'not_applied' in retried && typeof retried.not_applied === 'string') return errorOutcome('value_not_applied', retried.not_applied);
          if (!retried || !('typed' in retried) || retried.typed !== true) return uncertain();
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
      // A SPA can keep this document while changing its address after typing.
      if (!isPatternWithinGrantedOrigins(chosen.url, [command.target_domain_pattern])) {
        return errorOutcome('tab_navigation_blocked', 'The page is no longer at an address this step may use, so no suggestion was clicked.');
      }
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
          (address) => isOnBlockedSite(address, list), { challenge: command.expects_output_keys.includes('challenge'),
            ...(command.args.dom_ready === true ? { domReady: true } : {}) });
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
        const capture = command.args.capture_read;
        let captureRequest: ReturnType<typeof readInspectRequest> | undefined;
        let captureUrl: string | undefined;
        if (capture !== undefined) {
          if (!capture || typeof capture !== 'object' || Array.isArray(capture) || request.check.until !== 'shown' || fail || problems
            || Object.keys(capture).some(key => !['max_chars', 'max_value_chars', 'expected_url'].includes(key))) {
            return errorOutcome('unknown', 'bridge: capture_read needs a simple shown-element wait and bounded read limits');
          }
          const settings = capture as Record<string, unknown>;
          if (settings.expected_url !== undefined && typeof settings.expected_url !== 'string') return errorOutcome('unknown', 'bridge: expected_url must be text');
          captureUrl = typeof settings.expected_url === 'string' ? settings.expected_url : undefined;
          captureRequest = readInspectRequest({ selector: request.check.selector, max_chars: settings.max_chars, max_value_chars: settings.max_value_chars });
          if ('error' in captureRequest) return errorOutcome('unknown', `bridge: ${captureRequest.error}`);
        }
        const started = Date.now();
        for (;;) {
          if (cancel.signalled) return cancelled();
          const capturing = captureRequest && !('error' in captureRequest) ? captureRequest : undefined;
          const ran = capturing
            ? await runInDocument(api, handle, inspectPage, [capturing.scope, capturing.limits, captureUrl ?? null, 0, true, request.check], { immediate: true })
            : await runInDocument(api, handle, checkPageElement, [request.check]);
          if (!ran || ran.document_id !== handle.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
          let captured: Record<string, unknown> | undefined;
          let read: ReturnType<typeof waitCheckOutcome>;
          if (capturing) {
            if (cancel.signalled) return cancelled();
            const pending = ran.result && typeof ran.result === 'object' && !Array.isArray(ran.result)
              ? (ran.result as { waiting?: unknown }).waiting : undefined;
            if (pending && typeof pending === 'object' && typeof (pending as { url?: unknown }).url === 'string'
              && typeof (pending as { title?: unknown }).title === 'string') {
              const waiting = pending as { url: string; title: string };
              read = { ...waiting, met: false };
              captureUrl ??= waiting.url;
            } else {
              const inspected = inspectOutcome(ran.result, handle, { pattern: command.target_domain_pattern,
                blockedMessage: 'The document or address changed while waiting for the region.' });
              if (inspected.status !== 'ok') return inspected;
              captured = inspected.outputs!;
              // Cross-origin frame placeholders stay explicitly unreadable in
              // this region; no new document is followed by the fused read.
              if (typeof captured.html === 'string') captured = { ...captured,
                html: settleFrames(captured.html, handle.tab_id, null, () => true) };
              read = { url: String(captured.url), title: String(captured.title), met: true };
            }
          } else read = waitCheckOutcome(ran.result);
          if ('error' in read) return read.error;
          if (capturing && captureUrl !== undefined && read.url !== captureUrl) return errorOutcome('selector_not_found', PAGE_CHANGED);
          if (!isPatternWithinGrantedOrigins(read.url, [command.target_domain_pattern])) {
            return errorOutcome('tab_navigation_blocked', 'The page is no longer on a site this step may read.');
          }
          // Slice R — a frame's handle: its own site decides.
          const listedHere = siteRefusal(read.url, blocked);
          if (listedHere) return listedHere;
          const waited = Date.now() - started;
          const answer = (outcome: Record<string, unknown>): ActionExecutorOutcome => ({ status: 'ok',
            outputs: { page: formatPageHandle(handle), url: read.url, title: read.title, waited_ms: waited,
              ...(read.match_counts && command.expects_output_keys.includes('match_counts') ? { match_counts: read.match_counts } : {}), ...outcome } });
          if (capturing && request.timeout_ms > 0 && waited > request.timeout_ms) return answer({ found: false });
          // The step's own failure wins over what it waits for, as the server decides it.
          if (fail !== undefined) {
            const failing = await runInDocument(api, handle, checkPageElement, [fail]);
            if (!failing || failing.document_id !== handle.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
            const failed = waitCheckOutcome(failing.result);
            if ('error' in failed) return failed.error;
            if (failed.met) return answer({ found: false, failed: true });
          }
          if (read.met) return answer({ found: true, ...captured });
          // An error message the page now shows, which Recued recognizes: only while nothing the
          // step waits for has shown.
          if (problems) {
            const said = await runInDocument(api, handle, pageProblem, [PAGE_MESSAGE_RULES]);
            if (said !== null && said.document_id === handle.document_id && typeof said.result === 'string') {
              // The step's own failure, asked before the message: what shows between the two asks is seen
              // by the second alone. Asked once more, so a message that is also the step's `fail_when`
              // reports the step's own failure, with the page's words (`troubleOn` does the same).
              if (fail !== undefined) {
                const again = await runInDocument(api, handle, checkPageElement, [fail]);
                if (!again || again.document_id !== handle.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
                const failed = waitCheckOutcome(again.result);
                if ('error' in failed) return failed.error;
                if (failed.met) return answer({ found: false, failed: true, problem: said.result });
              }
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
      let tableWalk: PageTableWalk | undefined;
      if (command.args.table_walk !== undefined && (action === 'scroll' || action === 'read_table')) {
        const plan = command.args.table_walk as Partial<PageTableWalk> | null;
        const scope = plan?.scroll_scope;
        const move = plan?.advance;
        if (!scope || typeof scope !== 'object' || Array.isArray(scope)
          || Object.keys(scope).some(key => key !== 'ref' && key !== 'selector')
          || !Number.isInteger(plan?.enclosing) || plan!.enclosing! < 0 || plan!.enclosing! > 3
          || (action === 'scroll'
            ? !move || !Number.isSafeInteger(move.table_id) || !Number.isSafeInteger(move.scroll_id)
              || !Number.isFinite(move.position) || move.position < 0
            : move !== undefined)) return errorOutcome('unknown', 'bridge: invalid table continuation');
        const scroll = readInspectRequest({ page: command.args.page, ...scope });
        if ('error' in scroll) return errorOutcome('unknown', `bridge: ${scroll.error}`);
        await rebindRef(api, handle, scroll.scope.ref);
        tableWalk = { enclosing: plan!.enclosing!, scroll_scope: scroll.scope, ...(move ? { advance: move } : {}) };
      }
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
        const direction = screen === undefined && isHorizontalScrollDirection(to) ? to : undefined;
        if (direction !== undefined && tableWalk) return errorOutcome('unknown', 'bridge: table continuation scrolls vertically');
        // Even the first element measurement can scroll. Check this document's
        // own address first, including when its handle names a frame.
        if (cancel.signalled) return cancelled();
        const identified = await runInDocument(api, handle, pageIdentity, []);
        if (cancel.signalled) return cancelled();
        if (!identified || identified.document_id !== handle.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
        const page = identified.result && typeof identified.result === 'object' && !Array.isArray(identified.result)
          ? identified.result as Record<string, unknown> : null;
        const keys = page === null ? [] : Object.keys(page);
        if (page && keys.length === 1 && page.blocked === true) {
          return errorOutcome('tab_navigation_blocked', 'The owner client cannot be automated.');
        }
        if (!page || keys.length !== 2 || !keys.every(key => key === 'url' || key === 'title')
          || typeof page.url !== 'string' || typeof page.title !== 'string') {
          return errorOutcome('unknown', 'No verified page address was returned, so nothing was scrolled.');
        }
        const url = page.url;
        if (!isPatternWithinGrantedOrigins(url, [command.target_domain_pattern])) {
          return errorOutcome('tab_navigation_blocked', 'The page is no longer on a site this step may read.');
        }
        const listedBefore = siteRefusal(url, blocked);
        if (listedBefore) return listedBefore;
        if (tableWalk) {
          if (cancel.signalled) return cancelled();
          const windowOptions = { pattern: command.target_domain_pattern, window: true, sort: command.expects_output_keys.includes('sort') };
          const movement = await runInDocument(api, handle, readPageTable, [request.scope, PAGE_TABLE_LIMITS, url, tableWalk]);
          if (!movement || movement.document_id !== handle.document_id) return uncertain();
          const movedWindow = tableOutcome(movement.result, handle, windowOptions);
          if (movedWindow.status !== 'ok' || cancel.signalled) return movedWindow;
          await runInDocument(api, handle, waitForQuiet, [PAGE_SCROLL_QUIET_MS, PAGE_SCROLL_SETTLE_MS, PAGE_SCROLL_FIRST_MS]);
          if (cancel.signalled) return movedWindow;
          const observed = await runInDocument(api, handle, readPageTable, [request.scope, PAGE_TABLE_LIMITS, url,
            { scroll_scope: tableWalk.scroll_scope, enclosing: tableWalk.enclosing }]);
          if (!observed || observed.document_id !== handle.document_id) return uncertain();
          const captured = tableOutcome(observed.result, handle, windowOptions);
          return captured.status === 'ok' ? siteRefusal(String(captured.outputs!.url), blocked) ?? captured : captured;
        }
        const scoped = request.scope.ref !== undefined || request.scope.selector !== undefined;
        const measure = async (at: number | null, phase: ElementScrollPhase) => {
          // Preparing a scoped scroll can reveal the anchor before any screen
          // movement. Its final measurement is passive.
          const mayScroll = phase === 'move' || (scoped && phase === 'focus');
          const unreadable = () => ({ error: mayScroll ? uncertain()
            : errorOutcome('unknown', 'bridge: no readable answer from the page') });
          const args = [request.scope, url, at, null, PAGE_SCREEN_STEP, false,
            ...(scoped || direction !== undefined ? [{ command_id: command.command_id, phase,
              ...(direction === undefined ? {} : { direction }) }] : [])];
          const run = () => runInDocument(api, handle, measurePageArea, args);
          const ran = phase === 'focus' ? await byRef(api, handle, request.scope.ref, false, cancel, run) : await run();
          if (!ran || ran.document_id !== handle.document_id) {
            return { error: mayScroll ? uncertain() : errorOutcome('selector_not_found', PAGE_GONE) };
          }
          let read: ReturnType<typeof measured>;
          try { read = measured(ran.result); } catch { return unreadable(); }
          if ('error' in read && read.error.error?.code === 'unknown') return unreadable();
          return 'error' in read && read.error.error?.code === 'tab_navigation_blocked'
            ? { error: errorOutcome('tab_navigation_blocked', 'The page moved or cannot be automated, so no further scrolling was attempted.') } : read;
        };
        const now = await measure(null, 'focus');
        if ('error' in now) return now.error;
        if (cancel.signalled) return cancelled();
        const target = direction === undefined ? scrollTarget({ screen: now.screen ?? 1, screens: now.screens ?? 1 },
          to as BridgeScrollTo | undefined, screen as number | undefined) : null;
        const moved = await measure(target, 'move');
        if ('error' in moved) return moved.error;
        // A confirmed scroll remains authoritative; cancellation stops new work.
        let read = moved;
        if (!cancel.signalled) {
          await runInDocument(api, handle, waitForQuiet, [PAGE_SCROLL_QUIET_MS, PAGE_SCROLL_SETTLE_MS, PAGE_SCROLL_FIRST_MS]);
          if (!cancel.signalled) {
            // As it is now: a feed that loaded more has more screens.
            const after = await measure(null, 'observe');
            if (!('error' in after)) read = after;
          }
        }
        if (!isPatternWithinGrantedOrigins(read.url, [command.target_domain_pattern])) {
          return errorOutcome('tab_navigation_blocked', 'The page is no longer on a site this step may read.');
        }
        const listedHere = siteRefusal(read.url, blocked);
        if (listedHere) return listedHere;
        return { status: 'ok', outputs: { page: formatPageHandle(handle), url: read.url, title: read.title,
          screen: read.screen ?? 1, screens: read.screens ?? 1 } };
      }
      if (action === 'read_table') {
        const args = tableWalk ? [request.scope, PAGE_TABLE_LIMITS, null, tableWalk] : [request.scope, PAGE_TABLE_LIMITS];
        const ran = await byRef(api, handle, request.scope.ref, false, cancel,
          () => runInDocument(api, handle, readPageTable, args));
        if (!ran || ran.document_id !== handle.document_id) return errorOutcome('selector_not_found', PAGE_GONE);
        const table = tableOutcome(ran.result, handle, { pattern: command.target_domain_pattern, window: tableWalk !== undefined,
          sort: command.expects_output_keys.includes('sort') });
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
        screens: command.expects_output_keys.includes('screens'), cancel });
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
      const outcome = await executeOne(req.action, req.command, req.cancel).catch((error: unknown) => {
        if (error instanceof CancelledReferenceRetry) return cancelled();
        if (error instanceof RefusedReferenceRetry) return error.outcome;
        throw error;
      });
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
