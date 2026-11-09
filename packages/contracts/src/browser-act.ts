/** D-335 slice J (2026-11-04) — a sequence of steps on one web page, approved once.
 *
 *  The owner: "have the bridge accept [action, action, pause_ms, action] … a login is a
 *  combination of [click username, type, click password, type, submit], and that land in one
 *  approval nicely", and "each step should allow optional success logic, or recued default has
 *  it, or both, for submit a redirection is common for non ajax post, captcha blocks login form
 *  which can be observed sooner (no page redirection for example)".
 *
 *  `core.dom.act { target, page, steps }` runs the steps in order through the Bridge's own
 *  actions, and stops at the first one that cannot be done or whose check fails, saying how far
 *  it got. Recued's checks always run: a typed value must be in its field, a step whose page
 *  then shows a CAPTCHA nobody has solved stops the sequence, and sending a form expects the
 *  page to move on within {@link BROWSER_ACT_CHECK_SECONDS} seconds. A step's `success_when` adds
 *  its own check, or replaces sending's: a form that answers where it is (a search that filters
 *  the page, a sign-in that asks for a code) names what then shows.
 *
 *  Slice K (2026-11-04) — failure, caught as it happens. The owner: "is it a good idea to have
 *  some FAILED_AT,SUCCESS_WHEN conditions so any step results maybe be caught sooner if applied?"
 *  A step's `fail_when` names what means it went wrong (an error box, a text, an address), and
 *  stops the sequence the moment it holds, while the step's checks still wait; whichever of
 *  `success_when` and `fail_when` holds first decides. And Recued stops by itself when a click or a
 *  sent form leads to an error message it recognizes (the Bridge's `pageProblem`), so a sign-in
 *  that answers "Your password is invalid!" stops then, quoting it, rather than after the wait.
 *  A click on a form's send button counts as sending the form. `expect` was renamed
 *  `success_when` in the same slice, before either was released.
 *
 *  Slice L (2026-11-04) — a field that suggests as you type. The owner: "typically human type on
 *  the input, the dropdown display matching list, then the tricky part is in some case the item
 *  has to be selected for submit (internally the website record the object with id), if none is
 *  selected, the display text is just a text string, and most likely the backend will discard
 *  it". A type step's `pick` names the suggestion to choose, by its text: the Bridge types, waits
 *  for the field's own list, clicks the one that matches and checks the field took it. Not the
 *  first suggestion: the first is often not the one meant (a picker ranks by what is recent or
 *  popular), and a wrong record looks right. None or several matching stops the sequence, listing
 *  the suggestions, so the model picks one by name. */

import { BRIDGE_SCROLL_TO, parseBridgeKey, type BridgeScrollTo } from './bridge.js';

/** What a step may check once it is done, to know it worked. At least one of the checks, and
 *  `seconds` to wait for it (default `BROWSER_ACT_CHECK_SECONDS`). */
export interface BrowserActSuccess {
  /** The tab loads a new page or its address changes (`true`), or neither (`false`). */
  readonly page_changes?: boolean;
  /** The address the tab then shows contains this. */
  readonly url_includes?: string;
  /** An element matching this CSS selector shows. */
  readonly shows?: string;
  /** No element matching this CSS selector is shown. */
  readonly gone?: string;
  /** This text shows: inside `shows` when given, else anywhere on the page. */
  readonly text?: string;
  readonly seconds?: number;
}

/** Slice K — what means a step went wrong, checked while the step waits and stopping the sequence
 *  as soon as it holds. At least one of the checks. It watches as long as the step's checks do:
 *  `success_when`'s `seconds`, else its own, else `BROWSER_ACT_CHECK_SECONDS`. */
export interface BrowserActFailure {
  /** An element matching this CSS selector shows, such as `.error`. */
  readonly shows?: string;
  /** This text shows: inside `shows` when given, else anywhere on the page. */
  readonly text?: string;
  /** The address the tab shows contains this, such as `/login`. */
  readonly url_includes?: string;
  readonly seconds?: number;
}

interface BrowserActElement {
  /** A ref from the latest inspection of the page. */
  readonly ref?: string;
  /** Or a CSS selector, read when the step runs. */
  readonly selector?: string;
  /** Slice Y — or what the element shows or is called on the page ("Search Wikipedia", "Next",
   *  "Sign in"), found when the step runs among what a person can act on, as an inspection names
   *  them; `role` ("button", "link", "field", …) narrows it. */
  readonly text?: string;
  readonly role?: string;
}

interface BrowserActChecks {
  readonly success_when?: BrowserActSuccess;
  readonly fail_when?: BrowserActFailure;
}

/** Slice AC (2026-11-06) — the part of the page an action's result shows in, read once the step is
 *  done. The owner: *"model -> read page -> understand the tree -> click+expect_content_from#someething
 *  -> bridge: click return #something.textContent or html"*. A CSS selector, which still names the
 *  part after the step loads a new page, as a ref would not: the step waits for it to show, as
 *  `success_when.shows` does, and answers its outline beside the batch's reads, so "act, then read"
 *  is one step and not a model round. */
interface BrowserActThenRead {
  readonly then_read?: string;
}

/** Slice X (2026-11-06) — the tab a step runs on. The owner: *"ideally in recued the model can batch
 *  the 3 tab jobs in one call and recued return all the results in result per tab"*, and *"a task
 *  to open wikipedia is internal basically just check if that url is already in any tabs"*. A step
 *  naming neither runs on the tab of the step before; the first step's is the call's `page`. */
interface BrowserActTab {
  /** A page handle: from List browser tabs, Open a web page, a read, or an earlier answer. */
  readonly page?: string;
  /** Or an address: the tab showing it ({@link browserAddressKey}), else a new tab opened for it. */
  readonly url?: string;
}

/** Slice Z — the kinds of secret a type step can ask for, as the ask names them. A closed list, so
 *  the words a model writes for it can never be the secret itself. A sign-in code is used once and
 *  never remembered. */
export const BROWSER_ACT_SECRETS = ['password', 'PIN', 'sign-in code'] as const;
export type BrowserActSecret = typeof BROWSER_ACT_SECRETS[number];
/** Slice Z — the secret kind a step's word names, case aside. */
const secretOf = (value: unknown): BrowserActSecret | undefined => typeof value === 'string'
  ? BROWSER_ACT_SECRETS.find((kind) => kind.toLowerCase() === value.trim().toLowerCase()) : undefined;

/** Slice X — where a `scroll` step goes, as Scroll a web page's `to`. */
export type BrowserActScrollTo = BridgeScrollTo;

export type BrowserActStep = BrowserActTab & (
  /** Types `value` into the element, as Type into a web page does (a list takes an option, a
   *  checkbox or radio button `true` or `false`). With `submit`, then sends its form. */
  | (BrowserActElement & BrowserActChecks & BrowserActThenRead & { readonly do: 'type'; readonly value: string; readonly secret?: undefined;
      readonly submit?: boolean;
      /** Slice L — then picks the field's suggestion with this text, as a person clicks one in the list
       *  that shows as they type. */
      readonly pick?: string })
  /** Slice Z — types the owner's secret of this kind for the field, which the model never holds:
   *  one Recued remembers for the field and its site, else what the owner gives when asked at this
   *  step. */
  | (BrowserActElement & BrowserActChecks & BrowserActThenRead & { readonly do: 'type'; readonly secret: BrowserActSecret; readonly value?: undefined;
      readonly submit?: boolean; readonly pick?: undefined })
  | (BrowserActElement & BrowserActChecks & BrowserActThenRead & { readonly do: 'click' })
  /** Slice U — presses `key` in the element, as Press a key on a web page does (Enter in a field
   *  sends its form; Escape closes a dialog; the page's own handlers hear the rest). */
  | (BrowserActElement & BrowserActChecks & BrowserActThenRead & { readonly do: 'press'; readonly key: string })
  /** Sends the form the element is in, as pressing Enter in it would. */
  | (BrowserActElement & BrowserActChecks & BrowserActThenRead & { readonly do: 'submit' })
  /** A pause of `seconds`, or with `selector`, until it shows (or with `until: 'gone'`, goes),
   *  holding `text` when given, for at most `seconds`; with a selector, `fail_when` too. Slice X:
   *  or with `url_includes`, until the tab's address contains it. */
  | { readonly do: 'wait'; readonly seconds?: number; readonly selector?: string; readonly until?: 'shown' | 'gone';
      readonly text?: string; readonly url_includes?: string; readonly fail_when?: BrowserActFailure }
  /** Slice X — the tab's page as Inspect a web page answers it (an outline), or with `form: 'text'`
   *  as Read a web page's text does: one part (`from` a line, `chars` its size), or with `find` the
   *  sections that match. Changes nothing. */
  | { readonly do: 'read'; readonly form?: 'outline' | 'text'; readonly find?: string; readonly from?: number;
      readonly chars?: number }
  /** Slice AD (2026-11-06) — a question about the tab's page, answered by a separate model from up to
   *  40,000 characters of its text, as Ask a web page answers one, `from` a line on a long page; the
   *  asks of several tabs side by side, where three Ask a web page calls ran one after another (E). */
  | { readonly do: 'ask'; readonly question: string; readonly from?: number }
  /** Slice X — scrolls the tab's page, or the panel an element names, a screen (`to`, next by
   *  default) or to one (`screen`, from 1), as Scroll a web page does. Changes nothing. */
  | (BrowserActElement & { readonly do: 'scroll'; readonly to?: BrowserActScrollTo; readonly screen?: number })
  /** Slice X (Bridge 0.0.8) — loads `address` in the tab, as following a link would. */
  | (BrowserActThenRead & { readonly do: 'go'; readonly address: string })
  /** Slice X (Bridge 0.0.8) — the tab's back button, its reload, and closing it. */
  | (BrowserActThenRead & { readonly do: 'back' })
  | (BrowserActThenRead & { readonly do: 'reload' })
  | { readonly do: 'close' }
  /** Slice X (Bridge 0.0.8) — points at the element, for a menu that opens under the pointer. */
  | (BrowserActElement & BrowserActThenRead & { readonly do: 'hover' })
  /** D-335 slice AP (2026-11-07) — saves a file the page links to among the owner's files: the link (an
   *  element by ref, selector or text, its `href` or `src`) or the file's `address`, fetched as the page
   *  would fetch it. Changes nothing on the page; answers the file's ref beside the tab's reads. */
  | (BrowserActElement & { readonly do: 'download'; readonly address?: string })
  /** D-335 slice AQ (2026-11-07) — puts one of the owner's files (`file`, its `file:` ref) into the file
   *  field the element names, as choosing it there would. Always asked about, naming the file: it leaves
   *  the owner's files for the site, which no pass stands in for. */
  | (BrowserActElement & { readonly do: 'upload'; readonly file: string })
);

/** The owner: "20 steps is fine". */
export const BROWSER_ACT_MAX_STEPS = 20;
/** The longest one wait or one check may take. */
export const BROWSER_ACT_MAX_WAIT_SECONDS = 10;
/** All the waiting and checking one sequence asks for, together. */
export const BROWSER_ACT_MAX_TOTAL_WAIT_SECONDS = 30;
/** How long a check waits when its step names no `seconds`. */
export const BROWSER_ACT_CHECK_SECONDS = 5;
/** Slice L — how long a type step with `pick` waits for its suggestion to show: a picker asks its
 *  site as you type, a short while after the last key. */
export const BROWSER_ACT_PICK_SECONDS = 5;
/** The most of a suggestion's text `pick` names. */
const MAX_PICK = 200;
/** The longest a typed value or a selector may be. */
const MAX_VALUE = 20_000;
const MAX_SELECTOR = 1_000;

/** Slice X — the longest address a step names. */
const MAX_ADDRESS = 2_048;
/** Slice X — the longest text a `read` step's `find` looks for. */
const MAX_FIND = 200;
/** Slice X — the most characters one `read` step's part may hold, as Inspect a web page's `chars`. */
export const BROWSER_ACT_READ_MAX_CHARS = 60_000;
/** Slice X — the most screens a `scroll` step names, as Scroll a web page's `screen`. */
const MAX_SCREEN = 100;
/** Slice AC — the most characters of the part a step's `then_read` names its answer holds, as what
 *  an action changed does (slice T). */
export const BROWSER_ACT_THEN_READ_CHARS = 4_000;
/** Slice AD — the longest question an `ask` step puts. */
const MAX_QUESTION = 500;
/** Slice AD — how much of a page's text an `ask` step puts to its model, as Ask a web page does
 *  (`ASK_CHARS`, `scripts/generate-browser-toolkit.mjs`): about 10,000 tokens, which most free
 *  models take in one call. */
export const BROWSER_ACT_ASK_CHARS = 40_000;

/** Slice X — every step may name its tab. */
const TAB_KEYS = ['page', 'url'];
/** Slice Y — the ways a step names its element. */
const ELEMENT_KEYS = ['ref', 'selector', 'text', 'role'];
const STEP_KEYS: Readonly<Record<BrowserActStep['do'], readonly string[]>> = {
  type: ['do', ...ELEMENT_KEYS, 'value', 'secret', 'submit', 'pick', 'success_when', 'fail_when', 'then_read', ...TAB_KEYS],
  click: ['do', ...ELEMENT_KEYS, 'success_when', 'fail_when', 'then_read', ...TAB_KEYS],
  press: ['do', ...ELEMENT_KEYS, 'key', 'success_when', 'fail_when', 'then_read', ...TAB_KEYS],
  submit: ['do', ...ELEMENT_KEYS, 'success_when', 'fail_when', 'then_read', ...TAB_KEYS],
  wait: ['do', 'seconds', 'selector', 'until', 'text', 'url_includes', 'fail_when', ...TAB_KEYS],
  read: ['do', 'form', 'find', 'from', 'chars', ...TAB_KEYS],
  ask: ['do', 'question', 'from', ...TAB_KEYS],
  scroll: ['do', ...ELEMENT_KEYS, 'to', 'screen', ...TAB_KEYS],
  go: ['do', 'address', 'then_read', ...TAB_KEYS],
  back: ['do', 'then_read', ...TAB_KEYS],
  reload: ['do', 'then_read', ...TAB_KEYS],
  close: ['do', ...TAB_KEYS],
  hover: ['do', ...ELEMENT_KEYS, 'then_read', ...TAB_KEYS],
  download: ['do', ...ELEMENT_KEYS, 'address', ...TAB_KEYS],
  upload: ['do', ...ELEMENT_KEYS, 'file', ...TAB_KEYS],
};
/** Slice Y — the longest text a step names an element by, and its role. */
const MAX_ELEMENT_TEXT = 200;
const MAX_ROLE = 40;
/** The kinds, as an error names them. */
const KINDS_SAID = 'type, click, press, submit, wait, read, ask, scroll, go, back, reload, close, hover, download or upload';
/** The keys other browser tools name a step's kind by, read as "do" when a step has no "do" and
 *  exactly one of them holds a kind. ⛔ Measured (2026-11-04, `d-335-toolkit-measure.mjs` task C,
 *  qwen3.7-plus): in 3 of 3 runs every sequence was refused, its kind under `"type"` (3 calls),
 *  `"action"` (1) or the page's address (1), and the model then typed and clicked one approval at
 *  a time. */
const KIND_ALIASES = ['type', 'action'] as const;
const isKind = (value: unknown): value is BrowserActStep['do'] =>
  typeof value === 'string' && Object.hasOwn(STEP_KEYS, value);
const SUCCESS_KEYS = ['page_changes', 'url_includes', 'shows', 'gone', 'text', 'seconds'];
const FAILURE_KEYS = ['shows', 'text', 'url_includes', 'seconds'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Slice AE — an http or https address where a page handle goes, which a handle never is. */
const isWebAddress = (value: unknown): boolean => typeof value === 'string' && /^https?:\/\//i.test(value.trim());
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max;
const seconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= BROWSER_ACT_MAX_WAIT_SECONDS;

/** Whether a step sends a form: the Bridge's `submit` action, which an older Bridge lacks. */
export const browserActStepSubmits = (step: BrowserActStep): boolean =>
  step.do === 'submit' || (step.do === 'type' && step.submit === true);

/** Whether a step may load a new page: a click, a key, a sent form, typing that sends its form or
 *  (slice L) picks a suggestion, since a suggestion can be a link, and (slice X) going to an
 *  address, back, reloading and closing the tab. A step after it that names its element by selector
 *  is on the page it leaves, which cannot be read before then. Waiting, reading, scrolling and
 *  pointing leave the page where it is. */
export const browserActStepMayMove = (step: BrowserActStep): boolean => {
  switch (step.do) {
    // Slice AQ — choosing a file leaves the page where it is, as typing does.
    case 'wait': case 'read': case 'ask': case 'scroll': case 'hover': case 'download': case 'upload': return false;
    case 'type': return step.submit === true || step.pick !== undefined;
    default: return true;
  }
};

/** Slice X — whether a step changes something in the owner's browser, which the batch's one ask
 *  covers: typing, a click, a key, a sent form, going to an address, back, reloading or closing the
 *  tab. Reading, scrolling, waiting and pointing change nothing, so a batch of only those, on tabs
 *  already open, asks nothing ({@link browserActReadsOnly}). */
export const browserActStepWrites = (step: BrowserActStep): boolean =>
  step.do !== 'read' && step.do !== 'ask' && step.do !== 'scroll' && step.do !== 'wait' && step.do !== 'hover'
  // Slice AP — saving a file a page links to changes nothing there.
  && step.do !== 'download';

/** D-335 slice AQ — whether a batch puts one of the owner's files into a page, which is always asked
 *  about: no pass or switch stands in for a file leaving the owner's files. */
export const browserActUploads = (steps: readonly BrowserActStep[]): boolean => steps.some((step) => step.do === 'upload');

/** Slice AQ, for a gate holding the call's arguments: whether a `core.dom.act` call puts one of the
 *  owner's files into a page. No standing approval stands in for it either: a trigger's
 *  pre-approval (D-341 B1) leaves its ask standing, as a pass and the chat's switch do. Arguments
 *  that do not parse are no batch to admit. */
export const browserActCallUploads = (input: unknown): boolean => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const call = input as Record<string, unknown>;
  const parsed = parseBrowserActSteps(call.steps, { page: call.page });
  return parsed.ok && browserActUploads(parsed.steps);
};

/** Slice X — whether a batch's steps only read, scroll, wait and point. */
export const browserActReadsOnly = (steps: readonly BrowserActStep[]): boolean =>
  !steps.some(browserActStepWrites);

/** Slice X — whether any step names its own tab, which makes the answer one entry per tab. */
export const browserActNamesTabs = (steps: readonly BrowserActStep[]): boolean =>
  steps.some((step) => step.page !== undefined || step.url !== undefined);

/** Slice X — an address as a tab showing it is matched: host without `www.` and its port, path
 *  without a trailing slash and with its escapes undone, and query; the scheme (a site that moved
 *  from http to https is the same page) and the fragment ignored. Undefined for an address that is
 *  not http or https. Two addresses with one key are the same page. */
export const browserAddressKey = (address: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let path = url.pathname.replace(/\/+$/, '');
  try {
    path = decodeURI(path);
  } catch {
    // An escape that does not decode stays as it is, on both sides.
  }
  return `${host}${url.port === '' ? '' : `:${url.port}`}${path}${url.search}`;
};

/** Slice X — whether two addresses name one page ({@link browserAddressKey}). */
export const browserAddressesMatch = (a: string, b: string): boolean => {
  const key = browserAddressKey(a);
  return key !== undefined && key === browserAddressKey(b);
};

/** Whether a step's `success_when` waits for something on the page: `shows`, `gone` or `text`. */
export const browserActWaitsForElement = (success: BrowserActSuccess | undefined): boolean =>
  success !== undefined && (success.shows !== undefined || success.gone !== undefined || success.text !== undefined);

/** Slice K — how long a step's checks run, in seconds: `success_when`'s, else `fail_when`'s, else
 *  {@link BROWSER_ACT_CHECK_SECONDS}. A wait's are its own `seconds`. */
export const browserActStepCheckSeconds = (step: BrowserActStep): number => {
  if (step.do === 'wait') return step.seconds ?? BROWSER_ACT_CHECK_SECONDS;
  if (!('success_when' in step) && !('fail_when' in step)) return BROWSER_ACT_CHECK_SECONDS;
  const checked = step as BrowserActChecks;
  return checked.success_when?.seconds ?? checked.fail_when?.seconds ?? BROWSER_ACT_CHECK_SECONDS;
};

/** How long, in seconds, a click or a sent form watches for its page to start moving, when its
 *  checks depend on that: a form sent with no `success_when` (Recued's own check, that the page
 *  moves on), a `success_when` naming `page_changes` or `url_includes`, or (slice K) a `fail_when`
 *  with nothing on the page to wait for, which watches the same time for the failure. Undefined
 *  for the Bridge's own short watch, which is enough to read the page the tab shows. A watch ends
 *  as soon as the page starts moving, a CAPTCHA shows, or the step's failure does. */
export const browserActStepWatchSeconds = (step: BrowserActStep): number | undefined => {
  if (step.do !== 'click' && step.do !== 'press' && step.do !== 'submit' && step.do !== 'type') return undefined;
  if (step.do === 'type' && step.submit !== true) return undefined;
  const success = step.success_when;
  if (success !== undefined) {
    if (success.page_changes !== undefined || success.url_includes !== undefined) return browserActStepCheckSeconds(step);
    // What shows is waited for afterwards, racing the failure; this watch only reads the page.
    if (browserActWaitsForElement(success)) return undefined;
  }
  if (step.fail_when !== undefined || browserActStepSubmits(step)) return browserActStepCheckSeconds(step);
  return undefined;
};

/** The seconds a step's own waiting and checking may take, as its sequence counts them: a wait's,
 *  a watch for the page to move on (`browserActStepWatchSeconds`), a wait for what
 *  `success_when` says shows, goes or reads, and (slice L) a wait for the suggestion `pick` names. A `fail_when` runs alongside, adding nothing. A click
 *  that turns out to send a form is watched as a send is, which this cannot know in advance and
 *  does not count. */
export const browserActStepWaitSeconds = (step: BrowserActStep): number => {
  if (step.do === 'wait') return step.seconds ?? BROWSER_ACT_CHECK_SECONDS;
  // Slice AC — the part `then_read` names is waited for once the step is done, as a check is.
  const then = 'then_read' in step && step.then_read !== undefined ? BROWSER_ACT_CHECK_SECONDS : 0;
  // Slice X — reading, scrolling, pointing and moving the tab wait only for the Bridge's answer.
  if (step.do !== 'click' && step.do !== 'press' && step.do !== 'submit' && step.do !== 'type') return then;
  const element = browserActWaitsForElement(step.success_when) ? browserActStepCheckSeconds(step) : 0;
  // Slice L — and the wait for the suggestion a pick names.
  const pick = step.do === 'type' && step.pick !== undefined ? BROWSER_ACT_PICK_SECONDS : 0;
  return (browserActStepWatchSeconds(step) ?? 0) + element + pick + then;
};

/** D-347 follow-up (2026-11-08) — the step before a `{"do":"wait","page_changes":true}`, with that
 *  wait as its check (`success_when`, with the wait's `seconds`), or undefined when it cannot take it:
 *  the wait says more than `page_changes: true` and `seconds`, names another tab, or does not follow
 *  a step that moves the page (a click, a press, a sent form, typing sent with `submit`) with no
 *  `success_when` of its own. */
const foldPageChangesWait = (wait: Record<string, unknown>, previous: BrowserActStep | undefined): BrowserActStep | undefined => {
  if (wait.page_changes !== true || previous === undefined) return undefined;
  if (Object.keys(wait).some((key) => !['do', 'page_changes', 'seconds', ...TAB_KEYS].includes(key))) return undefined;
  if (wait.seconds !== undefined && !seconds(wait.seconds)) return undefined;
  if (previous.do !== 'click' && previous.do !== 'press' && previous.do !== 'submit' && previous.do !== 'type') return undefined;
  if ((previous.do === 'type' && previous.submit !== true) || previous.success_when !== undefined) return undefined;
  const sameTab = (key: 'page' | 'url') => wait[key] === undefined
    || (typeof wait[key] === 'string' && (wait[key] as string).trim() === previous[key]);
  if (!sameTab('page') || !sameTab('url')) return undefined;
  return { ...previous, success_when: { page_changes: true, ...(wait.seconds !== undefined ? { seconds: wait.seconds as number } : {}) } };
};

/** The steps of a `core.dom.act` call, checked, or why they cannot run, naming the step as the
 *  model counts them (from 1). Strict: a key no step takes is refused rather than ignored, since
 *  an ignored `submit`, `success_when` or `fail_when` would read as done. A step's kind may come
 *  as `"type"` or `"action"` instead of `"do"` ({@link KIND_ALIASES}); it is returned as `do`. A wait
 *  for `page_changes` right after the step that moves the page is that step's check
 *  ({@link foldPageChangesWait}), so the steps returned can be one fewer than the model wrote.
 *  Slice X: any step may name its tab (`page` or `url`), and the steps that read, scroll, point
 *  and move the tab join the ones that act. */
export const parseBrowserActSteps = (
  raw: unknown,
  /** Slice AE — the call's own `page`, given by every caller that knows it, so they all read the
   *  first step's tab the same way: with no handle there, a first `go` that names no tab is on the
   *  tab showing its address, and a `page` that is an address names the first step's tab as `url`
   *  would. Left out, neither applies. */
  call?: { readonly page?: unknown },
): { readonly ok: true; readonly steps: readonly BrowserActStep[] } | { readonly ok: false; readonly error: string } => {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!Array.isArray(raw) || raw.length === 0) return fail('steps must be a list of at least one step');
  if (raw.length > BROWSER_ACT_MAX_STEPS) return fail(`at most ${BROWSER_ACT_MAX_STEPS} steps, and this has ${raw.length}`);
  const steps: BrowserActStep[] = [];
  let waiting = 0;
  for (const [index, item] of raw.entries()) {
    const at = `step ${index + 1}`;
    if (!isRecord(item)) return fail(`${at} is not an object`);
    // What the step does: "do", else the one alias that holds a kind. Two that do are refused,
    // since either could be meant.
    const aliased = item.do === undefined ? KIND_ALIASES.filter((key) => isKind(item[key])) : [];
    if (aliased.length > 1) {
      return fail(`${at} says what it does twice, in ${aliased.map((key) => `"${key}"`).join(' and ')}: say it once, in "do"`);
    }
    const kind = aliased.length === 1 ? item[aliased[0]!] : item.do;
    if (kind === undefined) {
      return fail(`${at} has no "do", which says what it does: ${KINDS_SAID}, such as {"do":"click","ref":"e7"}`);
    }
    if (!isKind(kind)) {
      return fail(`${at}: "do" is ${KINDS_SAID}${typeof kind === 'string' ? `, not "${kind.slice(0, 40)}"` : ''}`);
    }
    const value: Record<string, unknown> = aliased.length === 0 ? item
      : { ...Object.fromEntries(Object.entries(item).filter(([key]) => key !== aliased[0])), do: kind };
    // D-347 follow-up (2026-11-08) — a wait for the page to move on, written after the step that moves
    //   it: `{"do":"wait","page_changes":true}`. `page_changes` is that step's check (`success_when`),
    //   and the model wrote it as a wait in 2 of 24 runs of the head to head with browser-use (tasks C
    //   and G), each refused at the cost of a round. It becomes that check: nothing is ignored, the step
    //   watches for the page to move on and fails if it does not. Anywhere else it is refused, saying
    //   where it goes.
    if (kind === 'wait' && value.page_changes !== undefined) {
      const before = steps[steps.length - 1];
      const folded = foldPageChangesWait(value, before);
      if (folded === undefined || before === undefined) {
        return fail(`${at}: page_changes is checked on the step that moves the page, not on a wait: give that click, `
          + 'press or sent form "success_when":{"page_changes":true}');
      }
      waiting += browserActStepWaitSeconds(folded) - browserActStepWaitSeconds(before);
      steps[steps.length - 1] = folded;
      continue;
    }
    const stray = Object.keys(value).filter((key) => !STEP_KEYS[kind].includes(key));
    if (stray.length > 0) return fail(`${at}: a ${kind} step takes ${STEP_KEYS[kind].join(', ')}, not ${stray.join(', ')}`);

    // Slice X — the tab the step runs on: a handle, or the address of the page it shows. Slice AE: a
    // `page` that is an http or https address names it as `url` does, since a handle never is one;
    // the model wrote the address there in both runs of E's task A that asked by batch.
    if (value.page !== undefined && value.url !== undefined) return fail(`${at}: name its tab by page or by url, not both`);
    const pageAddress = isWebAddress(value.page) ? (value.page as string).trim() : undefined;
    // Slice AE — and the first step, naming no tab, on the tab the call's `page` names by address, or
    // (a `go` with no call `page`) the tab showing the address it goes to.
    const firstAddress = index > 0 || call === undefined || value.page !== undefined || value.url !== undefined ? undefined
      : isWebAddress(call.page) ? (call.page as string).trim()
        : kind === 'go' && !text(call.page, 128) && typeof value.address === 'string'
          && browserAddressKey(value.address.trim()) !== undefined ? value.address.trim() : undefined;
    const url = pageAddress ?? firstAddress ?? value.url;
    if (value.page !== undefined && pageAddress === undefined && !text(value.page, 128)) {
      return fail(`${at}: page is a page handle, such as one List browser tabs answered`);
    }
    if (url !== undefined && (!text(url, MAX_ADDRESS) || browserAddressKey(url) === undefined)) {
      return fail(`${at}: url is the http or https address of the page the step runs on`);
    }
    const tab: BrowserActTab = value.page !== undefined && pageAddress === undefined ? { page: value.page as string }
      : url !== undefined ? { url: (url as string).trim() } : {};

    // Slice K — what means the step went wrong.
    let failWhen: BrowserActFailure | undefined;
    if (value.fail_when !== undefined) {
      const raw = value.fail_when;
      if (!isRecord(raw)) return fail(`${at}: fail_when is an object`);
      const strayFailure = Object.keys(raw).filter((key) => !FAILURE_KEYS.includes(key));
      if (strayFailure.length > 0) {
        return fail(`${at}: fail_when takes ${FAILURE_KEYS.join(', ')}, not ${strayFailure.join(', ')}`);
      }
      for (const key of ['shows', 'text', 'url_includes'] as const) {
        if (raw[key] !== undefined && !text(raw[key], MAX_SELECTOR)) return fail(`${at}: fail_when.${key} is text`);
      }
      if (raw.seconds !== undefined && !seconds(raw.seconds)) {
        return fail(`${at}: fail_when.seconds is a number above 0, at most ${BROWSER_ACT_MAX_WAIT_SECONDS}`);
      }
      if (raw.shows === undefined && raw.text === undefined && raw.url_includes === undefined) {
        return fail(`${at}: fail_when names a check: shows, text or url_includes`);
      }
      failWhen = raw as BrowserActFailure;
    }
    // Slice AC — the part of the page to read once the step is done (`STEP_KEYS` says which steps).
    if (value.then_read !== undefined && !text(value.then_read, MAX_SELECTOR)) {
      return fail(`${at}: then_read is a CSS selector for the part of the page to read once the step is done, such as #results`);
    }
    const thenRead = value.then_read !== undefined ? { then_read: (value.then_read as string).trim() } : {};

    if (kind === 'wait') {
      if (value.seconds !== undefined && !seconds(value.seconds)) {
        return fail(`${at}: seconds is a number above 0, at most ${BROWSER_ACT_MAX_WAIT_SECONDS}`);
      }
      if (value.url_includes !== undefined) {
        // Slice X — until the tab's address contains it.
        if (!text(value.url_includes, MAX_SELECTOR)) return fail(`${at}: url_includes is part of an address, such as /orders/`);
        if (value.selector !== undefined) return fail(`${at}: a wait waits for a selector or for url_includes, not both`);
      }
      if (value.selector === undefined) {
        if (value.until !== undefined || value.text !== undefined) return fail(`${at}: until and text need a selector`);
        if (value.seconds === undefined && value.url_includes === undefined) {
          return fail(`${at}: a wait takes seconds, a selector to wait for, or url_includes`);
        }
        if (failWhen !== undefined) return fail(`${at}: fail_when needs something to wait for: give the wait a selector`);
      } else if (!text(value.selector, MAX_SELECTOR)) {
        return fail(`${at}: selector is a CSS selector`);
      }
      if (value.until !== undefined && value.until !== 'shown' && value.until !== 'gone') {
        return fail(`${at}: until is shown or gone`);
      }
      if (value.text !== undefined && !text(value.text, MAX_SELECTOR)) return fail(`${at}: text is the text to wait for`);
      // A wait's fail_when watches as long as the wait itself.
      if (failWhen?.seconds !== undefined) {
        return fail(`${at}: a wait's fail_when watches as long as the wait: give the wait its seconds`);
      }
      const step: BrowserActStep = {
        ...tab,
        do: 'wait' as const,
        ...(value.seconds !== undefined ? { seconds: value.seconds as number } : {}),
        ...(value.selector !== undefined ? { selector: value.selector as string } : {}),
        ...(value.until !== undefined ? { until: value.until as 'shown' | 'gone' } : {}),
        ...(value.text !== undefined ? { text: value.text as string } : {}),
        ...(value.url_includes !== undefined ? { url_includes: value.url_includes as string } : {}),
        ...(failWhen !== undefined ? { fail_when: failWhen } : {}),
      };
      waiting += browserActStepWaitSeconds(step);
      steps.push(step);
      continue;
    }

    if (kind === 'read') {
      // Slice X — the page, as Inspect a web page or Read a web page's text answers it.
      if (value.form !== undefined && value.form !== 'outline' && value.form !== 'text') {
        return fail(`${at}: form is outline (the default) or text`);
      }
      if (value.find !== undefined && !text(value.find, MAX_FIND)) return fail(`${at}: find is the text of the section to find`);
      if (value.from !== undefined && !(typeof value.from === 'number' && Number.isSafeInteger(value.from) && value.from > 0)) {
        return fail(`${at}: from is a line number, such as 213`);
      }
      if (value.chars !== undefined && !(typeof value.chars === 'number' && Number.isSafeInteger(value.chars)
        && value.chars > 0 && value.chars <= BROWSER_ACT_READ_MAX_CHARS)) {
        return fail(`${at}: chars is how many characters the part holds, at most ${BROWSER_ACT_READ_MAX_CHARS}`);
      }
      if (value.find !== undefined && value.from !== undefined) return fail(`${at}: give one of find and from`);
      if (value.find !== undefined && value.chars !== undefined) {
        return fail(`${at}: chars sizes a part of the page, and find answers its sections: give one of the two`);
      }
      steps.push({
        ...tab,
        do: 'read',
        ...(value.form !== undefined ? { form: value.form as 'outline' | 'text' } : {}),
        ...(value.find !== undefined ? { find: value.find as string } : {}),
        ...(value.from !== undefined ? { from: value.from as number } : {}),
        ...(value.chars !== undefined ? { chars: value.chars as number } : {}),
      });
      continue;
    }

    if (kind === 'ask') {
      // Slice AD — a question about the page, as Ask a web page puts one.
      if (!text(value.question, MAX_QUESTION)) {
        return fail(`${at}: question is what to find out from the page, in a sentence of at most ${MAX_QUESTION} characters`);
      }
      if (value.from !== undefined && !(typeof value.from === 'number' && Number.isSafeInteger(value.from) && value.from > 0)) {
        return fail(`${at}: from is a line number to ask on from, such as 413`);
      }
      steps.push({ ...tab, do: 'ask', question: (value.question as string).trim(),
        ...(value.from !== undefined ? { from: value.from as number } : {}) });
      continue;
    }

    if (kind === 'go') {
      // Slice X — an address loaded in the tab, as following a link would.
      let address: URL | undefined;
      try {
        address = typeof value.address === 'string' && value.address.length <= MAX_ADDRESS ? new URL(value.address.trim()) : undefined;
      } catch {
        address = undefined;
      }
      if (address === undefined || (address.protocol !== 'http:' && address.protocol !== 'https:')
        || address.username !== '' || address.password !== '') {
        return fail(`${at}: address is the http or https address to load in the tab`);
      }
      const step: BrowserActStep = { ...tab, do: 'go', address: (value.address as string).trim(), ...thenRead };
      waiting += browserActStepWaitSeconds(step);
      steps.push(step);
      continue;
    }

    if (kind === 'download' && value.address !== undefined) {
      // Slice AP — the file's address, or (below) the link to it.
      if (value.ref !== undefined || value.selector !== undefined || value.text !== undefined || value.role !== undefined) {
        return fail(`${at}: name the link by ref, by selector or by text, or give the file's address, one of them`);
      }
      let address: URL | undefined;
      try {
        address = typeof value.address === 'string' && value.address.length <= MAX_ADDRESS ? new URL(value.address.trim()) : undefined;
      } catch {
        address = undefined;
      }
      if (address === undefined || (address.protocol !== 'http:' && address.protocol !== 'https:')
        || address.username !== '' || address.password !== '') {
        return fail(`${at}: address is the http or https address of the file to save`);
      }
      steps.push({ ...tab, do: 'download', address: (value.address as string).trim() });
      continue;
    }

    if (kind === 'back' || kind === 'reload' || kind === 'close') {
      const step: BrowserActStep = kind === 'close' ? { ...tab, do: kind } : { ...tab, do: kind, ...thenRead };
      waiting += browserActStepWaitSeconds(step);
      steps.push(step);
      continue;
    }

    // An element: a ref, a selector or (slice Y) its text. A scroll may name one (a panel) or none
    // (the page). Slice AE: a key pressed naming none is pressed in the field the step before typed
    // into, on the same tab, when that typing left the page where it was (E's search: "Enter").
    const before = steps[steps.length - 1];
    const typedBefore = kind === 'press' && value.ref === undefined && value.selector === undefined && value.text === undefined
      && before?.do === 'type' && before.submit !== true && before.pick === undefined
      && tab.page === undefined && tab.url === undefined ? before : undefined;
    const hasRef = value.ref !== undefined || typedBefore?.ref !== undefined;
    const hasSelector = value.selector !== undefined || typedBefore?.selector !== undefined;
    const hasText = value.text !== undefined || typedBefore?.text !== undefined;
    const naming = [hasRef, hasSelector, hasText].filter(Boolean).length;
    if (kind === 'download' && naming !== 1) {
      return fail(`${at}: name the link by ref, by selector or by text, or give the file's address, one of them`);
    }
    if (naming > 1 || (naming === 0 && kind !== 'scroll')) {
      return fail(`${at}: name the element by ref, by selector or by text, one of them`
        + (kind === 'press' ? ' (a key with none is pressed in the field the step before typed into)' : ''));
    }
    const elementOf = typedBefore ?? value;
    if (hasRef && !text(elementOf.ref, 64)) return fail(`${at}: ref is a ref from the latest inspection, such as e12`);
    if (hasSelector && !text(elementOf.selector, MAX_SELECTOR)) return fail(`${at}: selector is a CSS selector`);
    if (hasText && !text(elementOf.text, MAX_ELEMENT_TEXT)) {
      return fail(`${at}: text is what the element shows or is called on the page, such as "Sign in"`);
    }
    if (elementOf.role !== undefined && (!hasText || !text(elementOf.role, MAX_ROLE))) {
      return fail(`${at}: role narrows an element named by text, such as "button", "link" or "field"`);
    }
    const element = hasRef ? { ref: elementOf.ref as string } : hasSelector ? { selector: elementOf.selector as string }
      : hasText ? { text: (elementOf.text as string).trim(), ...(elementOf.role !== undefined ? { role: (elementOf.role as string).trim() } : {}) }
        : {};

    if (kind === 'scroll') {
      // Slice X — a screen at a time, as Scroll a web page does.
      if (value.to !== undefined && !(BRIDGE_SCROLL_TO as readonly unknown[]).includes(value.to)) {
        return fail(`${at}: to is next (the default), previous, top or bottom`);
      }
      if (value.screen !== undefined && !(typeof value.screen === 'number' && Number.isSafeInteger(value.screen)
        && value.screen > 0 && value.screen <= MAX_SCREEN)) {
        return fail(`${at}: screen is a screen's number, from 1`);
      }
      if (value.to !== undefined && value.screen !== undefined) return fail(`${at}: give one of to and screen`);
      steps.push({
        ...tab,
        do: 'scroll',
        ...element,
        ...(value.to !== undefined ? { to: value.to as BrowserActScrollTo } : {}),
        ...(value.screen !== undefined ? { screen: value.screen as number } : {}),
      });
      continue;
    }
    if (kind === 'hover') {
      const step: BrowserActStep = { ...tab, do: 'hover', ...element, ...thenRead };
      waiting += browserActStepWaitSeconds(step);
      steps.push(step);
      continue;
    }
    if (kind === 'download') {
      steps.push({ ...tab, do: 'download', ...element });
      continue;
    }
    if (kind === 'upload') {
      // Slice AQ — one of the owner's files, by the ref a download, file.search or an attachment answered.
      if (typeof value.file !== 'string' || !/^file:[0-9a-f]{32}$/.test(value.file.trim())) {
        return fail(`${at}: file is the file: ref of one of the user's files, such as a download or file.search answered`);
      }
      steps.push({ ...tab, do: 'upload', ...element, file: value.file.trim() });
      continue;
    }

    let successWhen: BrowserActSuccess | undefined;
    if (value.success_when !== undefined) {
      const raw = value.success_when;
      if (!isRecord(raw)) return fail(`${at}: success_when is an object`);
      const straySuccess = Object.keys(raw).filter((key) => !SUCCESS_KEYS.includes(key));
      if (straySuccess.length > 0) {
        return fail(`${at}: success_when takes ${SUCCESS_KEYS.join(', ')}, not ${straySuccess.join(', ')}`);
      }
      if (raw.page_changes !== undefined && typeof raw.page_changes !== 'boolean') {
        return fail(`${at}: success_when.page_changes is true or false`);
      }
      for (const key of ['url_includes', 'shows', 'gone', 'text'] as const) {
        if (raw[key] !== undefined && !text(raw[key], MAX_SELECTOR)) return fail(`${at}: success_when.${key} is text`);
      }
      if (raw.seconds !== undefined && !seconds(raw.seconds)) {
        return fail(`${at}: success_when.seconds is a number above 0, at most ${BROWSER_ACT_MAX_WAIT_SECONDS}`);
      }
      if (raw.shows !== undefined && raw.gone !== undefined) {
        return fail(`${at}: success_when takes one of shows and gone, not both`);
      }
      if (raw.page_changes === undefined && raw.url_includes === undefined && raw.shows === undefined
        && raw.gone === undefined && raw.text === undefined) {
        return fail(`${at}: success_when names a check: page_changes, url_includes, shows, gone or text`);
      }
      successWhen = raw as BrowserActSuccess;
    }
    const checks = { ...(successWhen !== undefined ? { success_when: successWhen } : {}),
      ...(failWhen !== undefined ? { fail_when: failWhen } : {}) };
    const named = element as { ref: string } | { selector: string } | { text: string; role?: string };

    let step: BrowserActStep;
    if (kind === 'type') {
      // Slice Z — or what the secret is, which Recued types when the step runs.
      const secret = value.secret === undefined ? undefined : secretOf(value.secret);
      if (value.secret !== undefined) {
        if (value.value !== undefined) return fail(`${at}: give value, the text to type, or secret, what kind of secret it is, not both`);
        if (secret === undefined) {
          return fail(`${at}: secret is the kind of secret the field takes: ${BROWSER_ACT_SECRETS.map((kind) => `"${kind}"`).join(', ')}; `
            + 'never the secret itself');
        }
        if (value.pick !== undefined) return fail(`${at}: a secret is typed, never picked from suggestions`);
      } else if (typeof value.value !== 'string' || value.value.length > MAX_VALUE) {
        return fail(`${at}: value is the text to type`);
      }
      if (value.submit !== undefined && typeof value.submit !== 'boolean') return fail(`${at}: submit is true or false`);
      // Typing alone leaves the page where it is, so nothing would watch it move.
      if (value.submit !== true && (successWhen?.page_changes !== undefined || successWhen?.url_includes !== undefined)) {
        return fail(`${at}: typing leaves the page where it is: check page_changes or url_includes on the step that `
          + 'sends the form (submit: true), or on a click');
      }
      // Nor does anything wait while a failure shows, unless success_when waits for something.
      if (value.submit !== true && failWhen !== undefined && !browserActWaitsForElement(successWhen)) {
        return fail(`${at}: typing alone waits for nothing, so its fail_when would never be checked: put it on the step `
          + 'that sends the form (submit: true), or on a click');
      }
      // Slice L — the suggestion to pick, by its text. Something typed shows the suggestions.
      if (value.pick !== undefined) {
        if (!text(value.pick, MAX_PICK)) return fail(`${at}: pick is the text of the suggestion to choose`);
        if ((value.value as string).trim() === '') return fail(`${at}: pick needs something typed, which shows the suggestions`);
      }
      step = secret !== undefined
        ? { ...tab, do: 'type', ...named, secret, ...(value.submit === true ? { submit: true } : {}), ...checks, ...thenRead }
        : { ...tab, do: 'type', ...named, value: value.value as string, ...(value.submit === true ? { submit: true } : {}),
          ...(value.pick !== undefined ? { pick: value.pick as string } : {}), ...checks, ...thenRead };
    } else if (kind === 'press') {
      // Slice U — a key, as Press a key on a web page reads it.
      const key = parseBridgeKey(value.key);
      if (key === null) {
        return fail(`${at}: key is a key to press, such as Enter, Escape, Tab, ArrowDown, a letter or a digit, `
          + 'after any of Control, Meta, Alt and Shift joined with + (Control+Enter)');
      }
      step = { ...tab, do: 'press', ...named, key: key.name, ...checks, ...thenRead };
    } else {
      step = { ...tab, do: kind as 'click' | 'submit', ...named, ...checks, ...thenRead };
    }
    waiting += browserActStepWaitSeconds(step);
    steps.push(step);
  }
  if (waiting > BROWSER_ACT_MAX_TOTAL_WAIT_SECONDS) {
    return fail(`the waits and checks add up to ${waiting} seconds, and a sequence may wait at most ${BROWSER_ACT_MAX_TOTAL_WAIT_SECONDS}`);
  }
  if (!steps.some((step) => step.do !== 'wait')) return fail('a sequence needs a step that does more than wait');
  return { ok: true, steps };
};
