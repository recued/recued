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
}

interface BrowserActChecks {
  readonly success_when?: BrowserActSuccess;
  readonly fail_when?: BrowserActFailure;
}

export type BrowserActStep =
  /** Types `value` into the element, as Type into a web page does (a list takes an option, a
   *  checkbox or radio button `true` or `false`). With `submit`, then sends its form. */
  | (BrowserActElement & BrowserActChecks & { readonly do: 'type'; readonly value: string; readonly submit?: boolean;
      /** Slice L — then picks the field's suggestion with this text, as a person clicks one in the list
       *  that shows as they type. */
      readonly pick?: string })
  | (BrowserActElement & BrowserActChecks & { readonly do: 'click' })
  /** Sends the form the element is in, as pressing Enter in it would. */
  | (BrowserActElement & BrowserActChecks & { readonly do: 'submit' })
  /** A pause of `seconds`, or with `selector`, until it shows (or with `until: 'gone'`, goes),
   *  holding `text` when given, for at most `seconds`; with a selector, `fail_when` too. */
  | { readonly do: 'wait'; readonly seconds?: number; readonly selector?: string; readonly until?: 'shown' | 'gone';
      readonly text?: string; readonly fail_when?: BrowserActFailure };

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

const STEP_KEYS: Readonly<Record<BrowserActStep['do'], readonly string[]>> = {
  type: ['do', 'ref', 'selector', 'value', 'submit', 'pick', 'success_when', 'fail_when'],
  click: ['do', 'ref', 'selector', 'success_when', 'fail_when'],
  submit: ['do', 'ref', 'selector', 'success_when', 'fail_when'],
  wait: ['do', 'seconds', 'selector', 'until', 'text', 'fail_when'],
};
/** The keys other browser tools name a step's kind by, read as "do" when a step has no "do" and
 *  exactly one of them holds a kind. ⛔ Measured (2026-11-04, `d-335-toolkit-measure.mjs` task C,
 *  qwen3.7-plus): in 3 of 3 runs every sequence was refused, its kind under `"type"` (3 calls),
 *  `"action"` (1) or the page's address (1), and the model then typed and clicked one approval at
 *  a time. */
const KIND_ALIASES = ['type', 'action'] as const;
const isKind = (value: unknown): value is BrowserActStep['do'] =>
  value === 'type' || value === 'click' || value === 'submit' || value === 'wait';
const SUCCESS_KEYS = ['page_changes', 'url_includes', 'shows', 'gone', 'text', 'seconds'];
const FAILURE_KEYS = ['shows', 'text', 'url_includes', 'seconds'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max;
const seconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= BROWSER_ACT_MAX_WAIT_SECONDS;

/** Whether a step sends a form: the Bridge's `submit` action, which an older Bridge lacks. */
export const browserActStepSubmits = (step: BrowserActStep): boolean =>
  step.do === 'submit' || (step.do === 'type' && step.submit === true);

/** Whether a step may load a new page: anything but typing, and typing that sends its form or
 *  (slice L) picks a suggestion, since a suggestion can be a link. A step after it that names its
 *  element by selector is on the page it leaves, which cannot be read before then. */
export const browserActStepMayMove = (step: BrowserActStep): boolean =>
  step.do !== 'wait' && (step.do !== 'type' || step.submit === true || step.pick !== undefined);

/** Whether a step's `success_when` waits for something on the page: `shows`, `gone` or `text`. */
export const browserActWaitsForElement = (success: BrowserActSuccess | undefined): boolean =>
  success !== undefined && (success.shows !== undefined || success.gone !== undefined || success.text !== undefined);

/** Slice K — how long a step's checks run, in seconds: `success_when`'s, else `fail_when`'s, else
 *  {@link BROWSER_ACT_CHECK_SECONDS}. A wait's are its own `seconds`. */
export const browserActStepCheckSeconds = (step: BrowserActStep): number => {
  if (step.do === 'wait') return step.seconds ?? BROWSER_ACT_CHECK_SECONDS;
  return step.success_when?.seconds ?? step.fail_when?.seconds ?? BROWSER_ACT_CHECK_SECONDS;
};

/** How long, in seconds, a click or a sent form watches for its page to start moving, when its
 *  checks depend on that: a form sent with no `success_when` (Recued's own check, that the page
 *  moves on), a `success_when` naming `page_changes` or `url_includes`, or (slice K) a `fail_when`
 *  with nothing on the page to wait for, which watches the same time for the failure. Undefined
 *  for the Bridge's own short watch, which is enough to read the page the tab shows. A watch ends
 *  as soon as the page starts moving, a CAPTCHA shows, or the step's failure does. */
export const browserActStepWatchSeconds = (step: BrowserActStep): number | undefined => {
  if (step.do === 'wait' || (step.do === 'type' && step.submit !== true)) return undefined;
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
  const element = browserActWaitsForElement(step.success_when) ? browserActStepCheckSeconds(step) : 0;
  // Slice L — and the wait for the suggestion a pick names.
  const pick = step.do === 'type' && step.pick !== undefined ? BROWSER_ACT_PICK_SECONDS : 0;
  return (browserActStepWatchSeconds(step) ?? 0) + element + pick;
};

/** The steps of a `core.dom.act` call, checked, or why they cannot run, naming the step as the
 *  model counts them (from 1). Strict: a key no step takes is refused rather than ignored, since
 *  an ignored `submit`, `success_when` or `fail_when` would read as done. A step's kind may come
 *  as `"type"` or `"action"` instead of `"do"` ({@link KIND_ALIASES}); it is returned as `do`. */
export const parseBrowserActSteps = (
  raw: unknown,
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
      return fail(`${at} has no "do", which says what it does: type, click, submit or wait, such as {"do":"click","ref":"e7"}`);
    }
    if (!isKind(kind)) {
      return fail(`${at}: "do" is type, click, submit or wait${typeof kind === 'string' ? `, not "${kind.slice(0, 40)}"` : ''}`);
    }
    const value: Record<string, unknown> = aliased.length === 0 ? item
      : { ...Object.fromEntries(Object.entries(item).filter(([key]) => key !== aliased[0])), do: kind };
    const stray = Object.keys(value).filter((key) => !STEP_KEYS[kind].includes(key));
    if (stray.length > 0) return fail(`${at}: a ${kind} step takes ${STEP_KEYS[kind].join(', ')}, not ${stray.join(', ')}`);

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

    if (kind === 'wait') {
      if (value.seconds !== undefined && !seconds(value.seconds)) {
        return fail(`${at}: seconds is a number above 0, at most ${BROWSER_ACT_MAX_WAIT_SECONDS}`);
      }
      if (value.selector === undefined) {
        if (value.until !== undefined || value.text !== undefined) return fail(`${at}: until and text need a selector`);
        if (value.seconds === undefined) return fail(`${at}: a wait takes seconds, or a selector to wait for`);
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
      const step = {
        do: 'wait' as const,
        ...(value.seconds !== undefined ? { seconds: value.seconds as number } : {}),
        ...(value.selector !== undefined ? { selector: value.selector as string } : {}),
        ...(value.until !== undefined ? { until: value.until as 'shown' | 'gone' } : {}),
        ...(value.text !== undefined ? { text: value.text as string } : {}),
        ...(failWhen !== undefined ? { fail_when: failWhen } : {}),
      };
      waiting += browserActStepWaitSeconds(step);
      steps.push(step);
      continue;
    }

    const hasRef = value.ref !== undefined;
    const hasSelector = value.selector !== undefined;
    if (hasRef === hasSelector) return fail(`${at}: name the element by ref or by selector, one of the two`);
    if (hasRef && !text(value.ref, 64)) return fail(`${at}: ref is a ref from the latest inspection, such as e12`);
    if (hasSelector && !text(value.selector, MAX_SELECTOR)) return fail(`${at}: selector is a CSS selector`);
    const element = hasRef ? { ref: value.ref as string } : { selector: value.selector as string };

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

    let step: BrowserActStep;
    if (kind === 'type') {
      if (typeof value.value !== 'string' || value.value.length > MAX_VALUE) return fail(`${at}: value is the text to type`);
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
        if (value.value.trim() === '') return fail(`${at}: pick needs something typed, which shows the suggestions`);
      }
      step = { do: 'type', ...element, value: value.value, ...(value.submit === true ? { submit: true } : {}),
        ...(value.pick !== undefined ? { pick: value.pick as string } : {}), ...checks };
    } else {
      step = { do: kind, ...element, ...checks };
    }
    waiting += browserActStepWaitSeconds(step);
    steps.push(step);
  }
  if (waiting > BROWSER_ACT_MAX_TOTAL_WAIT_SECONDS) {
    return fail(`the waits and checks add up to ${waiting} seconds, and a sequence may wait at most ${BROWSER_ACT_MAX_TOTAL_WAIT_SECONDS}`);
  }
  if (!steps.some((step) => step.do !== 'wait')) return fail('a sequence needs a step that types, clicks or submits');
  return { ok: true, steps };
};
