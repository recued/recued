/** The Bridge's field read, field write and click, written once and shared by
 *  the ordinary executor (`executor.ts`), the reviewed-document executor
 *  (`reviewed-document.ts`) and the "Watch this element" preview, so a recipe
 *  step, an owner-reviewed step and a watch all see the same thing.
 *
 *  ⛔ EVERY FUNCTION HERE IS INJECTED, SO EACH MUST BE SELF-CONTAINED. Chrome
 *  serializes an injected function's source and runs it in the page with only
 *  its arguments. A helper, constant or import from outside the function is a
 *  ReferenceError in the page, which Chrome hands back as an empty result.
 *  Declare everything inside them.
 *
 *  🔑 A WRITE BY REF (D-335) finds the element in the ref map `inspectPage`
 *  keeps in the Bridge's isolated world (`page-inspect.ts`, `recuedPageRefs`),
 *  and never falls back to the selector: a ref whose element has gone answers
 *  `stale`.
 *
 *  Each answers with exactly one key, the reviewed executor's acknowledgement
 *  shape, so a caller can tell a confirmed answer from a malformed one. */

import type { BrowserClickRefusal } from '@recued/contracts';
import type { PageInteractionWorld } from './page-inspect.js';

export type PageFieldAnswer =
  | { outputs: Record<string, unknown> }
  | { missing: true }
  | { blocked: true }
  | { protected: true }
  | { not_applied: string | BrowserClickRefusal }
  | { uncertain: true }
  | { partial_clicks: 1 | 2 }
  | { linked_download: string }
  /** The ref names no element on this page any more; nothing was done. */
  | { stale: true }
  /** D-402 slice G (§4 rule 4) — the selector names this many elements: which one is not said, so
   *  none is written to. */
  | { several: number }
  /** D-402 slice G (§4.1) — the row the step named its element by (`within`) no longer shows what it
   *  did, just before the change: nothing was done. */
  | { row_changed: string };

export interface NavigationGuard { before_url: string; after_url: string }
export const readNavigationGuard = (value: unknown): NavigationGuard | undefined | null => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !['before_url', 'after_url'].includes(key))
    || typeof raw.before_url !== 'string' || typeof raw.after_url !== 'string'
    || raw.before_url.length > 2_048 || raw.after_url.length > 2_048) return null;
  try {
    const before = new URL(raw.before_url), after = new URL(raw.after_url);
    if (!['http:', 'https:'].includes(before.protocol) || before.origin !== after.origin || before.href === after.href
      || before.hash || after.hash || before.username || before.password || after.username || after.password) return null;
    return { before_url: raw.before_url, after_url: raw.after_url };
  } catch { return null; }
};

/** What the element shows, as `{ text }`. A form field shows its value — an
 *  `<input>`'s `innerText` is always empty — so a list shows its chosen
 *  options' text, one per line, and a checkbox or radio button shows `true` or
 *  `false`. Anything else shows its `innerText`.
 *
 *  A password, hidden, sign-in code or payment card field answers `protected`:
 *  the Bridge never returns what such a field holds. `expectedUrl` is a reviewed
 *  document's address, checked in the same injection as the read. `page` is for
 *  the in-page preview; an injection never passes it. */
export const readPageField = (selector: string, expectedUrl?: string, page: Document = document): PageFieldAnswer => {
  if (page.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl !== undefined && location.href !== expectedUrl)) return { blocked: true };
  const element = page.querySelector(selector) as HTMLElement | null;
  if (!element) return { missing: true };
  const tag = element.localName;
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return { outputs: { text: element.innerText } };
  const field = element as HTMLInputElement;
  if (field.type === 'password' || field.type === 'hidden'
    || /(^|\s)(current-password|new-password|one-time-code|cc-\S+)(\s|$)/i.test(field.getAttribute('autocomplete') ?? '')) {
    return { protected: true };
  }
  if (tag === 'select') {
    return { outputs: { text: [...(element as HTMLSelectElement).selectedOptions].map(option => option.text).join('\n') } };
  }
  if (field.type === 'checkbox' || field.type === 'radio') return { outputs: { text: String(field.checked) } };
  return { outputs: { text: field.value } };
};

/** Types `value` into the element the way a person would, then confirms the
 *  element holds it. An input or textarea takes the value; a list takes the
 *  option whose value or text matches (one per line for a multiple list); a
 *  checkbox or radio button takes `true` or `false`; a rich-text editor
 *  (`contenteditable`, as most post and message composers are) gets the text
 *  as typing delivers it: a `beforeinput`, else the browser's insert command.
 *
 *  Whatever leaves the element without the value answers `not_applied` with the
 *  reason, never `filled`. This used to set `.value` on any element and report
 *  success, and on an editor `<div>` that changes nothing on the page.
 *
 *  `ref`, when given, names the element instead of `selector`.
 *
 *  D-335 slice J — with `submit`, it then sends the form the field is in, as pressing Enter there
 *  would, in this same script and so before the page can do anything about the field's focus
 *  (Wikipedia rebuilds its search form once the box has focus). The answer is then
 *  `{ submitted: true }`, or why the form was not sent. */
export const fillPageField = async (selector: string, value = '', expectedUrl?: string, ref?: string | null,
  submit?: boolean | null, rowTexts?: string[] | null, rowCard?: string | null, delivery?: 'paste' | null): Promise<PageFieldAnswer> => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };
  const marked = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } }).recuedPageRefs;
  // D-402 slice G (§4 rule 4) — a selector that names several fields types into none of them. Counted as a
  // read shows them, which leaves out what is aria-hidden or not drawn (`page-inspect.ts`): a selector
  // worked out from a read names one of those; of several in the page, the one it shows is the one meant.
  let bySelector: Element | null = null;
  if (ref == null) {
    const all = [...document.querySelectorAll(selector)];
    const shown = all.filter((one) => one.closest('[aria-hidden="true"]') === null && one.checkVisibility({ checkVisibilityCSS: true }));
    if (shown.length > 1 || (shown.length === 0 && all.length > 1)) return { several: shown.length > 1 ? shown.length : all.length };
    bySelector = shown[0] ?? all[0] ?? null;
  }
  const found = ref == null ? bySelector : marked?.byRef.get(ref) ?? null;
  if (ref != null && !found?.isConnected) return { stale: true };
  const element = found as HTMLElement | null;
  if (!element) return { missing: true };
  const inertOf = (globalThis as PageInteractionWorld).recuedInertOf
    ?? ((node: Element) => node.closest('[inert], dialog:modal')?.hasAttribute('inert') === true);
  if (inertOf(element)) return { not_applied: 'This field is in an inactive (inert) part of the page.' };
  if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') {
    return { not_applied: 'This field is disabled.' };
  }
  // Filling is a write too: an old ref must not reach behind an open dialog.
  // Composed ancestry includes fields in a dialog's shadow roots.
  const within = (parent: Element, child: Element): boolean => {
    for (let at: Element | null = child; at;) {
      if (at === parent) return true;
      const root = at.getRootNode();
      at = at.parentElement ?? (root as ShadowRoot).host ?? null;
    }
    return false;
  };
  const modalBlocks = () => [...document.querySelectorAll('dialog:modal, [aria-modal="true"]')]
    .some(modal => modal.checkVisibility({ checkVisibilityCSS: true }) && !within(modal, element));
  if (modalBlocks()) {
    return { not_applied: 'An open dialog blocks this field. Use the control inside the active dialog.' };
  }
  // D-402 slice G (§4.1) — a field named by the row it sits in: that row still shows every text the
  // step named it by, just before anything is typed. (The same list of rows as the read's own.)
  if (rowTexts != null && rowTexts.length > 0) {
    const fold = (text: string): string => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    // 2026-11-21 (D-402, task P) — or the card it sits in, the nearest of the kind the step names (`card_rows`).
    //   A kind that is no selector finds no card.
    let row: Element | null | undefined = null;
    try {
      row = element.parentElement?.closest(rowCard != null ? rowCard
        : 'li, tr, [role="row"], [role="listitem"], [role="option"], [role="article"], article');
    } catch { row = null; }
    const shown = row ? fold((row as HTMLElement).innerText ?? row.textContent ?? '') : '';
    const gone = rowTexts.filter((text) => !shown.includes(fold(text)));
    if (row == null || gone.length > 0) {
      return { row_changed: `the ${rowCard != null ? 'card' : 'row'} it sits in no longer shows ${gone.map((text) => `“${text}”`).join(' and ') || 'what it did'}, so nothing was typed` };
    }
  }
  // ⛔ The same sending as `submitPageForm`'s, written out again: an injected function can use
  // nothing declared outside it.
  const send = (from: Element): PageFieldAnswer => {
    const SEND_BUTTON = 'button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]';
    const form = from instanceof HTMLFormElement ? from : (from as HTMLInputElement).form ?? from.closest('form');
    if (!form) return { not_applied: 'It is in no form, so there is nothing to send.' };
    if (!form.noValidate && !form.checkValidity()) {
      const invalid = form.querySelector(':invalid') as HTMLInputElement | null;
      const named = invalid?.getAttribute('aria-label') || invalid?.getAttribute('name') || invalid?.id || 'a field';
      return { not_applied: `The form was not sent: ${named}: ${invalid?.validationMessage || 'is not valid'}` };
    }
    const button = from.matches(SEND_BUTTON) ? from as HTMLElement
      : [...form.elements].find((item) => item.matches(SEND_BUTTON)) as HTMLElement | undefined;
    if (button?.matches(':disabled')) return { not_applied: 'Its send button is disabled, so it was not sent.' };
    if (button && inertOf(button)) return { not_applied: 'Its send button is in an inactive (inert) part of the page.' };
    if (button) button.click();
    else if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.submit();
    return { outputs: { submitted: true } };
  };
  const filled = { outputs: { filled: true } };
  const done = (from: Element = element): PageFieldAnswer => (submit === true ? send(from) : filled);
  const tag = element.localName;
  const field = element as HTMLInputElement;

  if (delivery === 'paste') {
    const protectedField = () => field.type === 'password' || field.type === 'hidden'
      || /(^|\s)(current-password|new-password|one-time-code|cc-\S+)(\s|$)/i.test(element.getAttribute('autocomplete') ?? '');
    if (submit || protectedField()) {
      return { not_applied: 'Use the separate field or form action for protected entry or form submission.' };
    }
    const doc = element.ownerDocument;
    const view = doc.defaultView as (Window & typeof globalThis) | null;
    const startUrl = doc.URL;
    const eligible = () => element.isConnected && element.ownerDocument === doc && doc.defaultView === view
      && doc.URL === startUrl && (expectedUrl == null || location.href === expectedUrl)
      && !document.documentElement.hasAttribute('data-recued-owner-surface')
      && !protectedField()
      && !element.matches(':disabled, [aria-disabled="true"], [aria-readonly="true"]')
      && !((tag === 'input' || tag === 'textarea') && field.readOnly)
      && element.closest('[aria-hidden="true"]') === null && element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
      && !inertOf(element) && !modalBlocks();
    const hasFocus = () => (element.getRootNode() as Document | ShadowRoot).activeElement === element;
    if (!view || typeof element.focus !== 'function' || !eligible()) {
      return { not_applied: 'The paste target is unavailable for editing.' };
    }
    if (!hasFocus()) element.focus();
    if (!hasFocus() || !eligible()) {
      return { not_applied: 'The paste target changed before receiving the text.' };
    }
    const transfer = new view.DataTransfer();
    transfer.setData('text/plain', value);
    const delivered = { outputs: { pasted: true } };
    const released = element.dispatchEvent(new view.ClipboardEvent('paste',
      { clipboardData: transfer, bubbles: true, cancelable: true, composed: true }));
    // A handler can consume the paste itself. The result acknowledges delivery
    // to the page. Read application state to establish what the handler did.
    if (!released) return delivered;
    const textField = tag === 'textarea' || tag === 'input' && /^(?:text|search|url|tel|email|number)$/.test(field.type);
    // A scratch ClipboardEvent has no browser default. Use the target's own
    // editing engine for plain text, preserving its caret and undo semantics.
    if (!(textField || element.isContentEditable) || !eligible() || !hasFocus()) return { uncertain: true };
    if (element.isContentEditable) {
      const selected = view.getSelection();
      if (!selected) return { uncertain: true };
      if (!element.contains(selected.anchorNode) || !element.contains(selected.focusNode)) {
        const range = doc.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selected.removeAllRanges();
        selected.addRange(range);
      }
    }
    const edit = { inputType: 'insertFromPaste', data: textField ? value : null, dataTransfer: textField ? null : transfer,
      bubbles: true, composed: true, cancelable: true };
    if (!element.dispatchEvent(new view.InputEvent('beforeinput', edit))) return delivered;
    return eligible() && hasFocus() && doc.execCommand('insertText', false, value) ? delivered : { uncertain: true };
  }

  if (tag === 'select') {
    const list = element as HTMLSelectElement;
    const options = [...list.options];
    const wanted = list.multiple ? value.split('\n').filter(line => line.trim() !== '') : [value];
    const chosen: HTMLOptionElement[] = [];
    for (const line of wanted) {
      const byValue = options.filter(option => option.value === line);
      const matches = byValue.length ? byValue : options.filter(option => option.text.trim() === line.trim());
      if (matches.length !== 1) return { not_applied: matches.length ? 'Several options match; use a unique option value.' : 'No option in the list matches the value.' };
      const option = matches[0]!;
      const group = option.closest<HTMLOptGroupElement>('optgroup');
      if (option.disabled || group?.disabled
        || [option, ...(group ? [group] : [])].some(node =>
          node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true'
          || getComputedStyle(node).display === 'none' || ['hidden', 'collapse'].includes(getComputedStyle(node).visibility))) {
        return { not_applied: 'That option is hidden or disabled.' };
      }
      chosen.push(option);
    }
    if (options.every(option => option.selected === chosen.includes(option))) return done();
    for (const option of options) option.selected = chosen.includes(option);
    list.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    list.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    if (!list.isConnected) return { uncertain: true };
    if (!options.every(option => option.selected === chosen.includes(option))) {
      return { not_applied: 'The page did not keep the requested selected options. Inspect the list before trying again.' };
    }
    return done();
  }

  if (tag === 'input' && (field.type === 'checkbox' || field.type === 'radio')) {
    const wanted = value.trim().toLowerCase();
    if (wanted !== 'true' && wanted !== 'false') return { not_applied: 'A checkbox or radio button takes true or false.' };
    if (field.type === 'radio' && wanted === 'false' && field.checked) {
      return { not_applied: 'Select another radio button in this group with true; an already selected radio cannot be cleared by clicking it.' };
    }
    if (field.indeterminate) return { not_applied: 'This checkbox has a mixed state. Inspect its choices and use a click followed by a read.' };
    // A click is how a person ticks it, so the page's own handlers run.
    if (field.checked !== (wanted === 'true')) field.click();
    await new Promise(resolve => setTimeout(resolve, 0));
    if (!field.isConnected) return { uncertain: true };
    return field.checked === (wanted === 'true') ? done() : { not_applied: 'The page did not change the checkbox or radio button.' };
  }

  if (tag === 'input' || tag === 'textarea') {
    if (field.type === 'file') return { not_applied: 'A file field cannot be typed into.' };
    // ⛔ THROUGH THE ELEMENT'S OWN VALUE SETTER, NOT `field.value = value`. React,
    // and frameworks built the same way, keep a copy of the field's last value on
    // the element itself and drop an input event whose value matches that copy. A
    // plain assignment updates the copy first, so the page showed the text while
    // the app's state never changed, a form sent what it held before, and this
    // reported `filled` (2026-11-01). The prototype's setter leaves the copy alone.
    // Slice R — a field in a frame from this site is of its frame's window: its own setter.
    const view = element.ownerDocument.defaultView as (Window & typeof globalThis) | null;
    const Input = view?.InputEvent ?? InputEvent;
    const own = Object.getOwnPropertyDescriptor(
      tag === 'textarea' ? (view?.HTMLTextAreaElement ?? HTMLTextAreaElement).prototype
        : (view?.HTMLInputElement ?? HTMLInputElement).prototype, 'value')?.set;
    // A person clicks into a field before typing.
    field.focus();
    if (!field.isConnected) return { uncertain: true };
    if (inertOf(field)) return { not_applied: 'This field is in an inactive (inert) part of the page.' };
    const before = field.value;
    const textSelection = field.selectionStart !== null;
    const clearing = textSelection && value === '';
    const edit = { bubbles: true, composed: true, inputType: clearing ? 'deleteContentBackward' : 'insertText',
      data: clearing ? null : value };
    let handled = false;
    if (textSelection) {
      if (field.readOnly) return { not_applied: 'This field is read-only.' };
      field.setSelectionRange(0, field.value.length);
      // A mask or editor can own the replacement by canceling the default edit.
      handled = !field.dispatchEvent(new Input('beforeinput', { ...edit, cancelable: true }));
    }
    if (!field.isConnected) return { uncertain: true };
    if (!handled) {
      if (field.matches(':disabled') || inertOf(field) || textSelection && field.readOnly) {
        return { not_applied: 'The field stopped accepting edits.' };
      }
      if (own) own.call(field, value);
      else field.value = value;
      field.dispatchEvent(new Input('input', edit));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    // A framework commits after the input event, so read back once it has.
    await new Promise(resolve => setTimeout(resolve, 0));
    // The default edit may already have been copied into a rebuilt form by its input listener.
    // A canceled edit that removed its field leaves no value we can verify here.
    if (handled && !field.isConnected) return { uncertain: true };
    // A number or date field empties text it cannot parse.
    if (value.trim() !== '' && field.value === '') return { not_applied: 'The field emptied the value. Check its format.' };
    if (before !== value && field.value === before) {
      return { not_applied: handled ? 'The page declined the edit and kept the previous value.'
        : 'The page put back what the field held, so the value did not go in.' };
    }
    return done();
  }

  if (element.isContentEditable) {
    // Editor frameworks keep their own model and ignore or undo a direct DOM
    // write, so the text goes in the two ways typing reaches them. First a
    // `beforeinput`, which an editor that applies input itself (Lexical, Slate)
    // cancels. Only if none did, the browser's insert command, which edits the
    // page for editors that read the change back from it (Quill, ProseMirror).
    // ⛔ The insert command alone is not enough: Chrome fires no `beforeinput`
    // for it, so the first kind saw nothing while the page showed the text.
    element.focus();
    // Slice R — an editor in a frame from this site (most rich-text editors' frames) is selected
    // and typed into in its own document.
    const page = element.ownerDocument;
    const range = page.createRange();
    range.selectNodeContents(element);
    const selection = (page.defaultView ?? window).getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const handled = !element.dispatchEvent(new InputEvent('beforeinput', {
      inputType: value === '' ? 'deleteContentBackward' : 'insertText', data: value === '' ? null : value,
      targetRanges: [new StaticRange(range)], bubbles: true, cancelable: true, composed: true }));
    if (!handled) page.execCommand(value === '' ? 'delete' : 'insertText', false, value);
    // A framework commits after the input event, so read back once it has, and
    // through the selector, since it may have replaced the element. A ref
    // names that one element, so it is read back while it is still on the page.
    const shown = (text: string) => text.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
    for (const wait of [0, 50, 250]) {
      await new Promise(resolve => setTimeout(resolve, wait));
      const current = ref == null ? document.querySelector(selector) as HTMLElement | null
        : element.isConnected ? element : null;
      if (current && shown(current.innerText) === shown(value)) return done(current);
    }
    return { not_applied: 'The editor did not take the text.' };
  }

  return { not_applied: 'The element is not a field or an editor.' };
};

/** D-335 slice J — sends the form the element is in, as pressing Enter in it would: its default
 *  button (the first that sends it) is clicked, so the page's own handlers run, or, when the
 *  element is a send button, that one; a form with none is submitted with its handlers and
 *  checks. A form the browser would not send (a required field empty, a value in the wrong
 *  format) is not sent, and the answer names the field. `ref`, when given, names the element
 *  instead of `selector`. Answers `{ submitted: true }` once it is sent; what the page does next
 *  is the page's. */
export const submitPageForm = (selector: string, expectedUrl?: string, ref?: string | null): PageFieldAnswer => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };
  const marked = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } }).recuedPageRefs;
  // D-402 slice G (§4 rule 4) — a selector that names several elements sends no form. Counted as a
  // read shows them, which leaves out what is aria-hidden or not drawn (`page-inspect.ts`): a selector
  // worked out from a read names one of those; of several in the page, the one it shows is the one meant.
  let bySelector: Element | null = null;
  if (ref == null) {
    const all = [...document.querySelectorAll(selector)];
    const shown = all.filter((one) => one.closest('[aria-hidden="true"]') === null && one.checkVisibility({ checkVisibilityCSS: true }));
    if (shown.length > 1 || (shown.length === 0 && all.length > 1)) return { several: shown.length > 1 ? shown.length : all.length };
    bySelector = shown[0] ?? all[0] ?? null;
  }
  const found = ref == null ? bySelector : marked?.byRef.get(ref) ?? null;
  if (ref != null && !found?.isConnected) return { stale: true };
  if (!found) return { missing: true };
  const inertOf = (globalThis as PageInteractionWorld).recuedInertOf
    ?? ((node: Element) => node.closest('[inert], dialog:modal')?.hasAttribute('inert') === true);
  if (inertOf(found)) return { not_applied: 'The form target is in an inactive (inert) part of the page.' };
  const SEND_BUTTON = 'button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]';
  const form = found instanceof HTMLFormElement ? found : (found as HTMLInputElement).form ?? found.closest('form');
  if (!form) return { not_applied: 'It is in no form, so there is nothing to send.' };
  if (!form.noValidate && !form.checkValidity()) {
    const invalid = form.querySelector(':invalid') as HTMLInputElement | null;
    const named = invalid?.getAttribute('aria-label') || invalid?.getAttribute('name') || invalid?.id || 'a field';
    return { not_applied: `The form was not sent: ${named}: ${invalid?.validationMessage || 'is not valid'}` };
  }
  const button = found.matches(SEND_BUTTON) ? found as HTMLElement
    : [...form.elements].find((item) => item.matches(SEND_BUTTON)) as HTMLElement | undefined;
  if (button?.matches(':disabled')) return { not_applied: 'Its send button is disabled, so it was not sent.' };
  if (button && inertOf(button)) return { not_applied: 'Its send button is in an inactive (inert) part of the page.' };
  if (button) button.click();
  else if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else form.submit();
  return { outputs: { submitted: true } };
};

/** Clicks the element the way a person would, and answers once the click is
 *  sent: what the page does with it (navigate, open a menu, send) is the page's.
 *  `ref`, when given, names the element instead of `selector`.
 *
 *  ⛔ A CLICK IS THE WHOLE GESTURE, NOT `element.click()`. That sends one `click`
 *  and nothing before it, so a menu, list or button that answers the press (a
 *  `pointerdown` or `mousedown`, as many app widgets do) never opened, a field
 *  was not focused, and nothing hovered (2026-11-01). So, as a person:
 *   - an element that is disabled is not clicked, and the answer says so;
 *   - it is scrolled into view and pressed at the centre or a hit-tested exposed point;
 *   - what is on top there is what a person's click would land on. A fully covered
 *     target or blocking dialog refuses with the cover named. A part of the target
 *     (the icon in a button) takes the click, as a person's would;
 *   - the pointer arrives, presses and lets go, with the mouse events a browser
 *     sends for it, focus moves to what was pressed, and the click comes last.
 *  The events are still the page's own (`isTrusted: false`): a page that
 *  checks for a real person, or a browser feature that needs one (a pop-up
 *  window, the clipboard), still refuses. An element that draws nothing cannot
 *  be pointed at, so it gets the click alone, as before.
 *
 *  D-347 follow-up 18 (2026-11-08) — what covers it can be on its way out: the banner that shows in turn
 *  over the one the step names, a notice that new mail has come, a list's loading veil. So while
 *  something covers it, the click waits for that to go, up to `waitMs`, looking every tenth of a second,
 *  as a person waits for the banner they want to come round; then it clicks, or answers what still covers
 *  it. A dialog over it is answered or closed first, so it is refused at once, as before. An element the
 *  page takes away meanwhile is `stale`, for the executor to find again (`page-rebind.ts`). */
export const clickPageElement = async (selector: string, expectedUrl?: string, ref?: string | null,
  waitMs?: number | null, expectedHref?: string | null, rowTexts?: string[] | null, rowCard?: string | null,
  downloadMaxBytes?: number | null, downloadWaitMs?: number | null, downloadMaxFiles?: number | null,
  clickCount?: 2 | null): Promise<PageFieldAnswer> => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };
  const marked = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element>;
    byElement?: WeakMap<Element, string>;
    labelChoices?: Map<string, { control: HTMLInputElement; type: string }>;
    seen?: WeakMap<Element, Record<string, string>>; print?: (element: Element) => Record<string, string> } }).recuedPageRefs;
  // D-402 slice G (§4 rule 4) — a selector that names several elements clicks none of them. Counted as a
  // read shows them, which leaves out what is aria-hidden or not drawn (`page-inspect.ts`): a selector
  // worked out from a read names one of those; of several in the page, the one it shows is the one meant.
  let bySelector: Element | null = null;
  if (ref == null) {
    const all = [...document.querySelectorAll(selector)];
    const shown = all.filter((one) => one.closest('[aria-hidden="true"]') === null && one.checkVisibility({ checkVisibilityCSS: true }));
    if (shown.length > 1 || (shown.length === 0 && all.length > 1)) return { several: shown.length > 1 ? shown.length : all.length };
    bySelector = shown[0] ?? all[0] ?? null;
  }
  const found = ref == null ? bySelector : marked?.byRef.get(ref) ?? null;
  if (ref != null && !found?.isConnected) return { stale: true };
  if (!found) return { missing: true };
  const target = found as HTMLElement;
  const svgLink = target.localName === 'a' && target.namespaceURI === 'http://www.w3.org/2000/svg'
    && target.hasAttribute('href');
  const inertOf = (globalThis as PageInteractionWorld).recuedInertOf
    ?? ((node: Element) => node.closest('[inert], dialog:modal')?.hasAttribute('inert') === true);
  if (inertOf(target)) return { not_applied: 'This control is in an inactive (inert) part of the page.' };
  // D-402 slice G (§4.1) — an element named by the row it sits in (`within`): the row still shows every
  // text the step named it by. Checked just before the press, after any wait for what covered it (a
  // list redrawn under a notice shows another item in the same row): a row that no longer does is
  // answered, and nothing is clicked. (The same list of rows as the read's own.)
  const rowChanged = (): string | undefined => {
    if (rowTexts == null || rowTexts.length === 0) return undefined;
    const fold = (text: string): string => text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    // 2026-11-21 (D-402, task P) — or the card it sits in, the nearest of the kind the step names (`card_rows`).
    //   A kind that is no selector finds no card.
    let row: Element | null | undefined = null;
    try {
      row = target.parentElement?.closest(rowCard != null ? rowCard
        : 'li, tr, [role="row"], [role="listitem"], [role="option"], [role="article"], article');
    } catch { row = null; }
    const shown = row ? fold((row as HTMLElement).innerText ?? row.textContent ?? '') : '';
    const gone = rowTexts.filter((text) => !shown.includes(fold(text)));
    return row == null || gone.length > 0
      ? `the ${rowCard != null ? 'card' : 'row'} it sits in no longer shows ${gone.map((text) => `“${text}”`).join(' and ') || 'what it did'}, so nothing was clicked` : undefined;
  };
  const remembered = expectedHref != null ? marked?.seen?.get(target) : undefined;
  const fingerprint = remembered === undefined ? undefined : JSON.stringify(remembered);
  const choice = ref == null ? undefined : marked?.labelChoices?.get(ref);
  const linkHref = (): string | undefined => {
    if (!svgLink) return (target as HTMLAnchorElement).href;
    const anchor = found as SVGAElement;
    if (!anchor.hasAttribute('href')) return undefined;
    try { return new URL(anchor.href.animVal, anchor.baseURI).href; } catch { return undefined; }
  };
  const guarded = (): boolean => {
    if (inertOf(target)) return false;
    // A label can be retargeted after the read. Activate only the choice it represented.
    if (choice && (!target.isConnected || (target as HTMLLabelElement).control !== choice.control
      || choice.control.type !== choice.type || choice.control.matches(':disabled, [aria-disabled="true"]')
      || inertOf(choice.control))) return false;
    return expectedHref == null || (location.href === expectedUrl && target.isConnected && target.ownerDocument === document
      && fingerprint !== undefined && marked?.print !== undefined && JSON.stringify(marked.print(target)) === fingerprint
      && (target.localName === 'a' || target.localName === 'area') && linkHref() === expectedHref
      && !target.closest('form') && !target.hasAttribute('download') && !target.hasAttribute('onclick')
      && !target.hasAttribute('onmousedown') && !target.hasAttribute('onpointerdown')
      && ['', '_self'].includes(target.getAttribute('target') ?? ''));
  };
  if (!guarded()) return { stale: true };
  if (target.matches(':disabled')) return { not_applied: 'It is disabled, so it was not clicked.' };
  // D-335 slice R — an element in a frame from this site is measured and pressed in its frame's
  // window, and one in a web component through the component's shadow root: what is on top at a
  // point is looked for down through components, and "inside" crosses their boundaries.
  const doc = target.ownerDocument;
  const win = (doc.defaultView ?? window) as Window & typeof globalThis;
  const doubleClick = clickCount === 2;
  const navigation = (win as Window & { navigation?: EventTarget }).navigation;
  if (downloadWaitMs != null && (!navigation || downloadMaxBytes == null)) {
    return { not_applied: 'The browser cannot capture a generated download from this page, so it was not clicked.' };
  }
  type GestureRefusal = { uncertain: true } | { partial_clicks: 1 | 2 };
  const clickWithDownload = async (dispatch: () => void | Promise<GestureRefusal | undefined>): Promise<PageFieldAnswer> => {
    if (!navigation || downloadMaxBytes == null) {
      const result = dispatch();
      return (result && await result) ?? { outputs: { clicked: true } };
    }
    type DownloadEvent = Event & { downloadRequest?: string | null; destination?: { url: string };
      signal?: AbortSignal; sourceElement?: Element | null };
    type DownloadReceipt = { filename: string; mime_type: string; size: number; data: string }
      | { failure: 'unreadable' | 'too_large' | 'total_too_large' };
    const downloads: Array<{ event: DownloadEvent; pending: Promise<DownloadReceipt> }> = [];
    const limit = downloadMaxFiles ?? 1;
    let overflow = false;
    let linkedDownload: string | undefined;
    let dispatching = false;
    let remaining = downloadMaxBytes;
    const unreadable = { failure: 'unreadable' } as const;
    const startUrl = doc.URL;
    const until = downloadWaitMs == null ? undefined : performance.now() + downloadWaitMs;
    const controller = until === undefined ? undefined : new AbortController();
    const link = controller && !doubleClick ? target.closest('a[download][href], area[download][href]') : null;
    const interrupted = () => doc.defaultView !== win || doc.URL !== startUrl || document.documentElement.hasAttribute('data-recued-owner-surface');
    const interrupt = (event: Event) => { if (event.isTrusted) controller?.abort(); };
    const read = async (address: string, filename: string): Promise<DownloadReceipt> => {
      try {
        // Start the fetch before returning to the page, which may immediately revoke the Blob URL.
        const timeout = AbortSignal.timeout(2_500);
        const signal = controller ? AbortSignal.any([controller.signal, timeout]) : timeout;
        const response = await win.fetch(address, { signal });
        const length = response.headers.get('content-length');
        const size = length === null ? NaN : Number(length);
        if (!response.ok || !Number.isSafeInteger(size) || size < 0 || size > remaining) {
          const failure = size > downloadMaxBytes ? 'too_large' : size > remaining ? 'total_too_large' : 'unreadable';
          await response.body?.cancel().catch(() => undefined);
          return { failure };
        }
        // Reserve the bytes before awaiting the body so concurrent reads share the limit.
        remaining -= size;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== size) return unreadable;
        let binary = '';
        for (let start = 0; start < bytes.length; start += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
        }
        const mime_type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim() || 'application/octet-stream';
        return { filename, mime_type, size, data: btoa(binary) };
      } catch {
        return unreadable;
      }
    };
    const observe = (event: DownloadEvent) => {
      const address = event.destination?.url;
      if (!event.isTrusted || event.defaultPrevented) return;
      if (until !== undefined && (performance.now() > until || controller!.signal.aborted || interrupted())) return;
      if (controller && address && address !== startUrl && event.downloadRequest == null) controller.abort();
      if (typeof event.downloadRequest !== 'string' || !address) return;
      const url = new URL(address);
      if (url.origin === 'null' || url.origin !== win.location.origin) return;
      if (url.protocol !== 'blob:') {
        // The link's native default confirms the click selected a file. Use
        // the bounded linked-file fetch once in place of the OS download.
        if (dispatching && link && event.sourceElement === link && event.cancelable && downloads.length === 0
          && (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
          && (link as HTMLAnchorElement).href === url.href) {
          event.preventDefault();
          if (event.defaultPrevented) linkedDownload = url.href;
        }
        return;
      }
      if (downloads.length >= limit) { overflow = true; return; }
      const filename = event.downloadRequest.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 255) || 'download';
      downloads.push({ event, pending: read(url.href, filename) });
    };
    // Listen on this document only. An explicit wait also permits a delayed signal from it.
    navigation.addEventListener('navigate', observe);
    const inputEvents = ['pointerdown', 'keydown', 'click', 'pagehide'];
    if (controller) {
      for (const type of inputEvents) win.addEventListener(type, interrupt, { capture: true, signal: controller.signal });
    }
    try {
      dispatching = true;
      const gesture = dispatch();
      dispatching = false;
      if (gesture) {
        const refusal = await gesture;
        if (refusal) return refusal;
      }
      if (linkedDownload !== undefined) return { linked_download: linkedDownload };
      if (!controller) navigation.removeEventListener('navigate', observe);
      if (controller && until !== undefined && !controller.signal.aborted && !interrupted()) {
        // Keep observing through the authorized window for the rest of this export.
        await new Promise<void>(resolve => {
          const done = () => {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, Math.max(0, until - performance.now()));
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
      if (controller?.signal.aborted || until !== undefined && interrupted()) {
        return { outputs: { clicked: true, generated_download: { failure: 'interrupted' } } };
      }
      if (overflow) {
        return { outputs: { clicked: true, generated_download: { failure: limit === 1 ? 'multiple' : 'too_many' } } };
      }
      if (downloads.length === 0) {
        return { outputs: { clicked: true, ...(until === undefined ? {} : { generated_download: { failure: 'timed_out' } }) } };
      }
      const receipts = await Promise.all(downloads.map(({ pending }) => pending));
      if (controller?.signal.aborted || until !== undefined && interrupted()) {
        return { outputs: { clicked: true, generated_download: { failure: 'interrupted' } } };
      }
      // A later download supersedes the earlier Navigation API event in Chrome
      // even when both files transfer. Keep checking actual cancellation and the last signal.
      if (downloads.some(({ event }) => event.defaultPrevented) || downloads.at(-1)?.event.signal?.aborted) {
        return { outputs: { clicked: true, generated_download: unreadable } };
      }
      const failure = receipts.find(receipt => 'failure' in receipt);
      return { outputs: { clicked: true, ...(failure || receipts.length === 1
        ? { generated_download: failure ?? receipts[0]! } : { generated_downloads: receipts }) } };
    } finally {
      navigation.removeEventListener('navigate', observe);
      controller?.abort();
    }
  };
  // An area is a native link with no layout box of its own. Focus must land
  // on the area before activation, which requires a live rendered image map.
  if (target.localName === 'area') {
    if (doubleClick) return { not_applied: 'This image map area does not support a pointer double-click.' };
    if (!target.hasAttribute('href')) return { not_applied: 'The image map area has no link.' };
    target.focus();
    if (!target.isConnected || expectedUrl != null && location.href !== expectedUrl || !guarded()) return { uncertain: true };
    if (!target.matches(':focus')) return { not_applied: 'The image map area is not available for activation.' };
    const moved = rowChanged();
    if (moved !== undefined) return { row_changed: moved };
    return clickWithDownload(() => target.click());
  }
  const shadowOf = (element: Element): ShadowRoot | null => {
    try {
      const dom = (globalThis as typeof globalThis & {
        chrome?: { dom?: { openOrClosedShadowRoot?: (host: Element) => ShadowRoot | null | undefined } } }).chrome?.dom;
      return dom?.openOrClosedShadowRoot?.(element) ?? element.shadowRoot;
    } catch {
      return element.shadowRoot;
    }
  };
  const within = (outer: Node, inner: Node | null): boolean => {
    for (let node: Node | null = inner; node !== null; node = node.parentNode ?? (node as ShadowRoot).host ?? null) {
      if (node === outer) return true;
    }
    return false;
  };
  const topAt = (scope: Document, px: number, py: number): Element | null => {
    let found = scope.elementFromPoint(px, py);
    for (let depth = 0; found !== null && depth < 32; depth += 1) {
      const inner = shadowOf(found)?.elementFromPoint(px, py) ?? null;
      if (inner === null || inner === found) break;
      found = inner;
    }
    return found;
  };
  const DIALOG = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const covered = (cover: Element, waited = 0): PageFieldAnswer => {
    const shown = cover.closest(DIALOG) ?? cover;
    const words = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
    const observedName = words(shown.getAttribute('aria-label')) || words(shown.getAttribute('title'))
      || words((shown as HTMLElement).innerText);
    const name = observedName.slice(0, 80);
    const message = `Something else on the page covers it${name ? ` (“${name}”)` : ''}`
      + `${waited > 0 ? `, and still did after ${String(Math.round(waited / 1000))} s` : ''}, so it was not clicked. `
      + 'Close or answer that first.';
    const element = (node: Element): { tag: string; ref?: string } => {
      const tag = /^[a-z][a-z0-9._:-]{0,63}$/.test(node.localName) ? node.localName : 'unknown';
      const known = node === target && ref != null ? ref : marked?.byElement?.get(node);
      return { tag, ...(known && /^e[1-9]\d{0,8}$/.test(known) ? { ref: known } : {}) };
    };
    const role = words(shown.getAttribute('role'));
    return { not_applied: { message, obstruction: { operation: 'click', executed: false,
      reason: 'target_occluded', source: 'hit_test', target: element(target),
      blocker: { ...element(shown), ...(name ? { label: name } : {}),
        ...(observedName.length > name.length ? { label_truncated: true } : {}), ...(role && role.length <= 48 ? { role } : {}) },
      waited_ms: Math.max(0, Date.now() - begun) } } };
  };

  let box = target.getBoundingClientRect();
  if (!svgLink && (box.width <= 0 || box.height <= 0)) {
    if (doubleClick) return { not_applied: 'This target has no visible box for a double-click.' };
    if (!guarded()) return { stale: true };
    const moved = rowChanged();
    if (moved !== undefined) return { row_changed: moved };
    // An SVG element has no click(); the event is what a person's click sends.
    return clickWithDownload(() => {
      if (typeof target.click === 'function') target.click();
      else target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }));
    });
  }
  const covering = (over: Element | null): over is Element => over !== null && !within(target, over) && !within(over, target);
  const hitAt = (bounds: DOMRect) => {
    const x = Math.min(Math.max(bounds.left + bounds.width / 2, 0), win.innerWidth - 1);
    const y = Math.min(Math.max(bounds.top + bounds.height / 2, 0), win.innerHeight - 1);
    return { x, y, hit: topAt(doc, x, y) };
  };
  const hitLink = (bounds: DOMRect) => {
    const center = hitAt(bounds);
    if (!svgLink || within(target, center.hit)) return center;
    // The anchor's bounding center can sit in an unpainted gap between its shapes.
    const shapes = target.querySelectorAll('path, rect, circle, ellipse, line, polygon, polyline, text, image, use, foreignObject');
    for (const shape of [...shapes].slice(0, 32)) {
      const shapeBox = shape.getBoundingClientRect();
      const spot = hitAt(shapeBox);
      if (within(target, spot.hit)) return spot;
    }
    return center;
  };
  const coveringFrame = (x: number, y: number): Element | undefined => {
    for (let view: Window = win; view !== window && view.frameElement; view = view.frameElement.ownerDocument.defaultView ?? window) {
      const holder = view.frameElement;
      const shown = holder.getBoundingClientRect();
      x += shown.left + holder.clientLeft;
      y += shown.top + holder.clientTop;
      const over = topAt(holder.ownerDocument, x, y);
      if (over && over !== holder && !within(holder, over)) return over;
    }
  };
  type HitPoint = { x: number; y: number; hit: Element | null; alternate?: true };
  const blockingDialog = (cover: Element): boolean => {
    const dialog = cover.closest(DIALOG);
    return dialog !== null && !within(dialog, target);
  };
  const exposedPoint = (): HitPoint | undefined => {
    const rects = target.getClientRects();
    for (let index = 0; index < Math.min(rects.length, 8); index += 1) {
      const rect = rects[index]!;
      const left = Math.max(0, rect.left), right = Math.min(win.innerWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(win.innerHeight, rect.bottom);
      if (right <= left || bottom <= top) continue;
      const dx = Math.min(4, (right - left) / 4), dy = Math.min(4, (bottom - top) / 4);
      // Probe inside the rendered fragments. A bounding rectangle alone does not establish a hit.
      for (const x of [left + dx, right - dx, (left + right) / 2]) {
        for (const y of [(top + bottom) / 2, top + dy, bottom - dy]) {
          const hit = topAt(doc, x, y);
          if (within(target, hit) && !coveringFrame(x, y)) return { x, y, hit, alternate: true };
        }
      }
    }
  };
  /** Where a person's press on it would land now, and what is on top there; or what covers it. */
  const aim = (): HitPoint | { cover: Element } => {
    box = target.getBoundingClientRect();
    if (box.top < 0 || box.left < 0 || box.bottom > win.innerHeight || box.right > win.innerWidth) {
      target.scrollIntoView({ block: 'center', inline: 'center' });
      box = target.getBoundingClientRect();
    }
    // The frames it is in, from this site, shown in their pages too.
    for (let view: Window = win; view !== window && view.frameElement; view = view.frameElement.ownerDocument.defaultView ?? window) {
      const holder = view.frameElement;
      const shown = holder.getBoundingClientRect();
      const outer = holder.ownerDocument.defaultView ?? window;
      if (shown.top < 0 || shown.left < 0 || shown.bottom > outer.innerHeight || shown.right > outer.innerWidth) {
        holder.scrollIntoView({ block: 'center', inline: 'center' });
      }
    }
    box = target.getBoundingClientRect();
    let { x, y, hit } = hitLink(box);
    if (covering(hit)) {
      // D-347 follow-up (2026-11-08) — what covers an element at an edge of the window (a banner kept
      // there, an advertisement anchored to the bottom) is often off it once the element is in the
      // middle: an upload button under an "Advertisement" was refused three times in one head-to-head
      // run, each refusal a model round. So it is scrolled to the middle at once and looked at again,
      // once; a dialog over the whole page still covers it there.
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      box = target.getBoundingClientRect();
      ({ x, y, hit } = hitLink(box));
    }
    // Nothing in the pages around its frames is over the frame where it is pressed.
    const cover = covering(hit) ? hit : coveringFrame(x, y);
    if (cover === undefined) return { x, y, hit };
    return (blockingDialog(cover) ? undefined : exposedPoint()) ?? { cover };
  };
  // D-347 follow-up 18 — covered by something other than a dialog it is not in: waited for, up to `waitMs`.
  const begun = Date.now();
  const until = begun + Math.max(0, Number(waitMs ?? 0) || 0);
  let spot = aim();
  while ('cover' in spot && Date.now() < until) {
    if (blockingDialog(spot.cover)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!target.isConnected) return { stale: true };
    if (target.matches(':disabled')) return { not_applied: 'It is disabled, so it was not clicked.' };
    spot = aim();
  }
  if ('cover' in spot) return covered(spot.cover, Date.now() - begun >= 1_000 ? Date.now() - begun : 0);
  if (svgLink && !within(target, spot.hit)) return { not_applied: 'No visible part of this SVG link could be clicked.' };
  if (doubleClick && !within(target, spot.hit)) return { not_applied: 'No visible part of this target could be double-clicked.' };
  if (!guarded()) return { stale: true };
  const moved = rowChanged();
  if (moved !== undefined) return { row_changed: moved };
  const { x, y, hit } = spot;
  const receiver = hit && within(target, hit) ? hit : target;
  const hitsReceiver = () => receiver.isConnected && within(target, receiver) && !target.matches(':disabled')
    && topAt(doc, x, y) === receiver && !coveringFrame(x, y);
  const at = { composed: true, view: win, clientX: x, clientY: y, screenX: win.screenX + x,
    screenY: win.screenY + y, button: 0 };
  const pointer = (type: string, buttons: number, bubbles = true) => receiver.dispatchEvent(new PointerEvent(type,
    { ...at, bubbles, cancelable: bubbles, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  const mouse = (type: string, buttons: number, detail: number, bubbles = true) => receiver.dispatchEvent(new MouseEvent(type,
    { ...at, bubbles, cancelable: bubbles, buttons, detail }));
  const pressAndRelease = (detail: 1 | 2) => {
    // As in Chromium, cancelling pointerdown suppresses compatibility mouse
    // down/up events while still allowing the click.
    const pressed = pointer('pointerdown', 1);
    const mouseDown = pressed && mouse('mousedown', 1, detail);
    if (mouseDown) {
      const focusable = receiver.closest('a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], '
        + '[contenteditable]:not([contenteditable="false"])');
      if (focusable !== null && typeof (focusable as HTMLElement).focus === 'function' && !focusable.matches(':disabled')) {
        (focusable as HTMLElement).focus({ preventScroll: true });
      } else if (doc.activeElement !== null && typeof (doc.activeElement as HTMLElement).blur === 'function') {
        (doc.activeElement as HTMLElement).blur();
      }
    }
    pointer('pointerup', 0);
    if (pressed) mouse('mouseup', 0, detail);
  };
  const gesture = () => {
    const startUrl = doc.URL;
    const startPageUrl = location.href;
    const meaning = marked?.print ? JSON.stringify(marked.print(target)) : undefined;
    let navigating = false;
    const onNavigate = (event: Event & { downloadRequest?: string | null }) => {
      if (event.isTrusted && !event.defaultPrevented && event.downloadRequest == null) navigating = true;
    };
    const current = () => !navigating && doc.defaultView === win && doc.URL === startUrl && location.href === startPageUrl
      && !document.documentElement.hasAttribute('data-recued-owner-surface')
      && !target.matches('[aria-disabled="true"]') && guarded() && rowChanged() === undefined && hitsReceiver()
      && (meaning === undefined || JSON.stringify(marked?.print?.(target)) === meaning);
    return clickWithDownload(async () => {
      navigation?.addEventListener('navigate', onNavigate);
      try {
        if (!current()) return { uncertain: true };
        pressAndRelease(1);
        if (!current()) return { uncertain: true };
        mouse('click', 0, 1);
        // Let click handlers settle their DOM changes before the second press.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (!current()) return { partial_clicks: 1 };
        pressAndRelease(2);
        if (!current()) return { partial_clicks: 1 };
        mouse('click', 0, 2);
        if (!current()) return { partial_clicks: 2 };
        mouse('dblclick', 0, 2);
        return undefined;
      } finally {
        navigation?.removeEventListener('navigate', onNavigate);
      }
    });
  };
  pointer('pointerover', 0);
  pointer('pointerenter', 0, false);
  mouse('mouseover', 0, 0);
  mouse('mouseenter', 0, 0, false);
  pointer('pointermove', 0);
  mouse('mousemove', 0, 0);
  if (!guarded() || spot.alternate && (!hitsReceiver() || rowChanged() !== undefined)) return { uncertain: true };
  if (doubleClick) return gesture();
  pressAndRelease(1);
  if (!guarded() || spot.alternate && (!hitsReceiver() || rowChanged() !== undefined)) return { uncertain: true };
  // The click, whose default action follows a link, submits a form or ticks a box.
  return clickWithDownload(() => {
    mouse('click', 0, 1);
  });
};
