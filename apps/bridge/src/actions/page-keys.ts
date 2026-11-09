/** D-335 slice U (2026-11-05) — a key pressed in a page, as a person's would land.
 *
 *  browser-use presses keys; the toolkit could only type text and click, so a chat box that sends
 *  on Enter, a dialog that closes on Escape, a menu driven by the arrows and a site's own shortcuts
 *  were out of reach. A key is pressed in the element a ref or a selector names, focused first as a
 *  person clicks into a field before pressing a key there.
 *
 *  A script's key events reach the page's own handlers, which is how most apps act on a key, but a
 *  browser does nothing of its own for them (`isTrusted: false`). So once the page has let `keydown`
 *  through, what the browser would do is done here:
 *   - Enter in a field of a form sends the form, as pressing it would: its default button is clicked,
 *     else the form is sent with its own checks (slice J's `submit` does the same); on a button or a
 *     link it activates it; in a text area or an editor it starts a new line.
 *   - Space activates a button, a checkbox, a radio button or a switch, and types a space in a field.
 *   - Escape closes the dialog that is open, as the browser's own `cancel` does.
 *   - Tab and Shift+Tab move the focus to the next or the previous control, within an open dialog.
 *   - Backspace and Delete delete in a field or an editor.
 *  A key held with Control, Meta or Alt is a shortcut: the page's handlers alone decide.
 *
 *  ⛔ INJECTED, SO SELF-CONTAINED: only types are imported. */

import type { BridgeKeyPress } from '@recued/contracts';
import type { PageFieldAnswer } from './page-fields.js';

export const pressPageKey = (selector: string, expectedUrl?: string | null, ref?: string | null,
  press?: BridgeKeyPress | null): PageFieldAnswer => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };
  if (press == null) return { not_applied: 'No key was named, so none was pressed.' };
  const marked = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } }).recuedPageRefs;
  const found = ref == null ? document.querySelector(selector) : marked?.byRef.get(ref) ?? null;
  if (ref != null && !found?.isConnected) return { stale: true };
  if (!found) return { missing: true };
  const element = found as HTMLElement;
  if (element.matches(':disabled')) return { not_applied: 'It is disabled, so no key was pressed in it.' };
  // A field in a frame from this site, or in a web component, takes the key in its own window.
  const doc = element.ownerDocument;
  const win = (doc.defaultView ?? window) as Window & typeof globalThis;
  if (doc.activeElement !== element && typeof element.focus === 'function') element.focus();
  const init: KeyboardEventInit = { key: press.key, code: press.code, keyCode: press.keyCode, which: press.keyCode,
    ctrlKey: press.ctrlKey, metaKey: press.metaKey, altKey: press.altKey, shiftKey: press.shiftKey,
    bubbles: true, cancelable: true, composed: true, view: win };
  const allowed = element.dispatchEvent(new win.KeyboardEvent('keydown', init));
  // A key that writes a character, or Enter, also sends `keypress`, which older pages listen for.
  if (allowed && (press.key.length === 1 || press.key === 'Enter') && !press.ctrlKey && !press.metaKey) {
    element.dispatchEvent(new win.KeyboardEvent('keypress', { ...init, charCode: press.key === 'Enter' ? 13 : press.key.charCodeAt(0) }));
  }

  const tag = element.localName;
  const type = tag === 'input' ? (element as HTMLInputElement).type : '';
  const role = (element.getAttribute('role') ?? '').toLowerCase();
  const TOGGLES = ['checkbox', 'radio', 'switch'];
  const field = tag === 'input' && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'color', 'range'].includes(type);
  const writable = field || tag === 'textarea' || element.isContentEditable;
  const activates = tag === 'button' || tag === 'summary' || (tag === 'a' && element.hasAttribute('href'))
    || (tag === 'input' && ['button', 'submit', 'reset', 'image', 'checkbox', 'radio'].includes(type))
    || ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', ...TOGGLES].includes(role);
  const toggle = TOGGLES.includes(type) || TOGGLES.includes(role);
  const write = (text: string) => {
    // Through the field's own document, so the page hears an input as it does from typing.
    if (!doc.execCommand('insertText', false, text) && field) {
      const input = element as HTMLInputElement;
      input.setRangeText(text, input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, 'end');
      input.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    }
  };
  let sent = false;
  let focusMoved: Element | null = null;
  const plain = !press.ctrlKey && !press.metaKey && !press.altKey;
  if (allowed && plain) {
    if (press.key === 'Enter') {
      const form = field ? (element as HTMLInputElement).form : null;
      if (form !== null) {
        // Implicit submission: the default button, else the form itself, with its own checks.
        const button = [...form.elements].find((control) => control.matches(
          'button:not([type]), button[type="submit" i], input[type="submit" i], input[type="image" i]')) as HTMLElement | undefined;
        if (button !== undefined) {
          if (!button.matches(':disabled')) {
            button.click();
            sent = true;
          }
        } else {
          form.requestSubmit();
          sent = true;
        }
      } else if (tag === 'textarea' || element.isContentEditable) {
        if (!doc.execCommand(tag === 'textarea' ? 'insertText' : 'insertParagraph', false, '\n')) write('\n');
      } else if (activates && !toggle) {
        element.click();
      }
    } else if (press.key === ' ') {
      if (activates) element.click();
      else if (writable) write(' ');
    } else if (press.key === 'Escape') {
      const dialog = doc.querySelector('dialog:modal') ?? element.closest('dialog[open]');
      if (dialog !== null && dialog.dispatchEvent(new win.Event('cancel', { cancelable: true }))) (dialog as HTMLDialogElement).close();
    } else if (press.key === 'Tab') {
      // The controls a person reaches with Tab, in order, within an open dialog if there is one.
      const within = doc.querySelector('dialog:modal') ?? doc;
      const reachable = [...within.querySelectorAll<HTMLElement>('a[href], area[href], button, input, select, textarea, summary, iframe, '
        + '[tabindex], [contenteditable]:not([contenteditable="false"])')]
        .filter((control) => control.tabIndex >= 0 && !control.matches(':disabled') && control.getAttribute('type') !== 'hidden'
          && control.checkVisibility({ checkVisibilityCSS: true }));
      const at = reachable.indexOf(element);
      const next = reachable[(at + (press.shiftKey ? -1 : 1) + reachable.length) % reachable.length];
      if (next !== undefined && next !== element) {
        next.focus();
        focusMoved = next;
      }
    } else if (press.key === 'Backspace' || press.key === 'Delete') {
      if (writable) doc.execCommand(press.key === 'Backspace' ? 'delete' : 'forwardDelete');
    }
  }
  // The key comes up where the focus now is.
  (focusMoved ?? element).dispatchEvent(new win.KeyboardEvent('keyup', init));
  return { outputs: { pressed: press.name, ...(sent ? { sent: true } : {}) } };
};
