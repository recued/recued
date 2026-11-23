/** D-335 slice K (2026-11-04) — an error message a click or a sent form led to, so a sequence
 *  stops as soon as the page answers "Your password is invalid!" instead of waiting out its
 *  check, and quotes it. The owner: "is it a good idea to have some FAILED_AT,SUCCESS_WHEN
 *  conditions so any step results maybe be caught sooner if applied?"
 *
 *  Before a click or a send, `describePageElement` notes each message the page shows; after
 *  it, {@link pageProblem} names one that appeared or changed since. The note lives in the
 *  Bridge's isolated world, beside the ref map, never in the page. A page the step loaded has no
 *  note, so there only a message in a form's answer counts: an alert, a flash or notice box, or
 *  a message inside a form, which is where a sign-in that failed shows its error once it has
 *  sent the form back.
 *
 *  What a message is ({@link PAGE_MESSAGE_RULES}): shown, with 3 to 300 characters of text, and
 *  either named an error (a class or id holding "error", "danger" or "invalid", as the-internet's
 *  `flash error`, Bootstrap's `alert-danger`, Amazon's `a-alert-error` and WordPress's
 *  `login_error` do), or an alert or assertive live region whose text reads as an error (Google's
 *  sign-in names its message box nothing a person can read). A field marked `aria-invalid` counts,
 *  by its error message or its name. Nothing named a success counts, so a "Signed in" flash does
 *  not stop a sequence. English words only; a page in another language is caught by its classes.
 *
 *  ⛔ INJECTED, SO SELF-CONTAINED. The prepare branch in `describePageElement` and this reader
 *  read a message the same way (`shown`, `seen`), written out in each. */

/** What counts as a message, passed into both functions as their argument, so the two never
 *  disagree about it. Patterns are the source of case-insensitive regular expressions. */
export const PAGE_MESSAGE_RULES = {
  /** Where a message may be. */
  candidates: '[role="alert"], [aria-live="assertive"], [aria-invalid="true"], [class*="error" i], [class*="danger" i], '
    + '[class*="invalid" i], [id*="error" i]',
  /** Never a message by its own text: controls, and what draws no text. A field still counts by
   *  `aria-invalid`. A label does count: jQuery Validate writes its messages as `label.error`. */
  never: 'a, button, input, select, textarea, option, script, style, template, noscript, svg',
  /** A class or id that names an error, and one that names a success. */
  errorName: 'error|danger|invalid',
  successName: 'success',
  /** Text that reads as an error, for an alert or a live region named nothing. */
  errorWords: "\\b(invalid|incorrect|wrong|error|failed|failure|not (found|valid|recogni[sz]ed|match(ed)?|allowed)|"
    + "couldn['’]?t|could not|can['’]?t|cannot|unable|denied|expired|required|try again|too many|problem)\\b",
  /** On a page a step loaded: only a message in a form's answer. */
  answerPlace: '[role="alert"], [aria-live="assertive"], form, [class*="flash" i], [class*="alert" i], '
    + '[class*="notice" i], [class*="message" i]',
  /** The most text a message has; a longer one is a region, not a message. */
  maxText: 300,
  /** The most of it a sequence quotes. */
  quote: 200,
} as const;

export type PageMessageRules = typeof PAGE_MESSAGE_RULES;

/** The error message a step led to, quoted, or null: one shown that the page did not show, or
 *  said differently, when `describePageElement` noted it; on a page with no note (one the step
 *  loaded), one in a form's answer. The first in the page's order, innermost. */
export const pageProblem = (rules: PageMessageRules): string | null => {
  if (document.documentElement.hasAttribute('data-recued-owner-surface')) return null;
  // ⛔ The same as describePageElement's prepare branch.
  const shown = (element: Element) => element.getAttribute('aria-hidden') !== 'true'
    && (element.checkVisibility({ checkVisibilityCSS: true }) || getComputedStyle(element).display === 'contents');
  const seen = (element: Element) => `${shown(element)
    ? ((element as HTMLElement).innerText ?? element.textContent ?? '').replace(/\s+/g, ' ').trim() : '∅'}`
    + `|${element.getAttribute('aria-invalid') ?? ''}`;
  const textOf = (element: Element) => ((element as HTMLElement).innerText ?? element.textContent ?? '')
    .replace(/\s+/g, ' ').trim()
    // A close button's mark at the end is no part of the message.
    .replace(/[\s×✕✖]+$/u, '');
  const notes = (globalThis as typeof globalThis & { recuedMessageNotes?: Map<Element, string> }).recuedMessageNotes;
  const errorName = new RegExp(rules.errorName, 'i');
  const successName = new RegExp(rules.successName, 'i');
  const errorWords = new RegExp(rules.errorWords, 'i');
  const letters = (text: string) => (text.match(/\p{L}/gu) ?? []).length;

  const found: Array<{ element: Element; text: string }> = [];
  for (const element of document.querySelectorAll(rules.candidates)) {
    if (!shown(element)) continue;
    // New since the note, or said differently; with no note, only in a form's answer.
    if (notes !== undefined ? notes.get(element) === seen(element) : element.closest(rules.answerPlace) === null) continue;
    const names = `${typeof element.className === 'string' ? element.className : ''} ${element.id}`;
    if (successName.test(names)) continue;
    if (element.matches(rules.never)) {
      // A field the page marked invalid: its error message, else its name.
      if (element.getAttribute('aria-invalid') !== 'true' || !element.matches('input, select, textarea')) continue;
      const ids = `${element.getAttribute('aria-errormessage') ?? ''} ${element.getAttribute('aria-describedby') ?? ''}`
        .split(/\s+/).filter((id) => id !== '');
      const said = ids.map((id) => document.getElementById(id)).filter((node) => node !== null && shown(node))
        .map((node) => textOf(node!)).filter((text) => text !== '').join(' ');
      const field = element as HTMLInputElement;
      const name = field.labels?.[0] ? textOf(field.labels[0]) : field.getAttribute('aria-label') ?? field.name ?? '';
      found.push({ element, text: said !== '' ? said : `${name !== '' ? `“${name}”` : 'A field'} is marked as not valid` });
      continue;
    }
    const text = textOf(element);
    if (letters(text) < 3 || text.length > rules.maxText) continue;
    const alert = element.getAttribute('role') === 'alert' || element.getAttribute('aria-live') === 'assertive';
    if (!errorName.test(names) && !(alert && errorWords.test(text))) continue;
    found.push({ element, text });
  }
  // Innermost: a box holding another message says less precisely what it does.
  const message = found.find((one) => !found.some((other) => other !== one && one.element.contains(other.element)));
  if (message === undefined) return null;
  return message.text.length > rules.quote ? `${message.text.slice(0, rules.quote - 1)}…` : message.text;
};
