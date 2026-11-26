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
 *   - Enter in a form field uses the form's default submitter or its native implicit submission
 *     rule; on a button or a link it activates it; in a text area or an editor it starts a new line.
 *   - Space activates a button, a checkbox, a radio button or a switch, and types a space in a field.
 *   - Escape clears a filled search field or cancels the open dialog.
 *   - Tab and Shift+Tab move the focus to the next or the previous control, within an open dialog.
 *   - Backspace and Delete delete in a field or an editor.
 *   - Home and End move a text field's caret, with Shift to extend the selection.
 *   - Home, End, arrows and page keys move a native slider.
 *   - A number field steps with its writing mode's up and down keys.
 *   - Arrow keys move focus and selection within a native radio group.
 *  Native editors use document editing history for Control+Z or Meta+Z. Other modifier
 *  shortcuts are left to the page's handlers.
 *
 *  ⛔ INJECTED, SO SELF-CONTAINED: only types are imported. */

import type { BridgeKeyPress } from '@recued/contracts';
import type { PageFieldAnswer } from './page-fields.js';
import type { PageInteractionWorld } from './page-inspect.js';

export const pressPageKey = (selector: string, expectedUrl?: string | null, ref?: string | null,
  press?: BridgeKeyPress | null): PageFieldAnswer => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };
  if (press == null) return { not_applied: 'No key was named, so none was pressed.' };
  const marked = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } }).recuedPageRefs;
  const inertOf = (globalThis as PageInteractionWorld).recuedInertOf
    ?? ((node: Element) => node.closest('[inert], dialog:modal')?.hasAttribute('inert') === true);
  const dom = (globalThis as typeof globalThis & {
    chrome?: { dom?: { openOrClosedShadowRoot?: (host: Element) => ShadowRoot | null | undefined } } }).chrome?.dom;
  const shadowOf = (node: Element): ShadowRoot | null => {
    try { return node.shadowRoot ?? dom?.openOrClosedShadowRoot?.(node) ?? null; }
    catch { return null; }
  };
  const deepFocus = (doc: Document): Element | null => {
    let active = doc.activeElement;
    for (let depth = 0; active && depth < 32; depth++) {
      const inner: Element | null | undefined = shadowOf(active)?.activeElement;
      if (!inner) break;
      active = inner;
    }
    return active;
  };
  const enclosingModal = (node: Element | null): HTMLDialogElement | undefined => {
    for (let at = node; at; at = at.assignedSlot ?? at.parentElement ?? (at.getRootNode() as ShadowRoot).host ?? null) {
      if (at.matches('dialog:modal')) return at as HTMLDialogElement;
    }
  };
  // D-402 slice G (§4 rule 4) — a selector that names several elements presses no key in any of them. Counted as a
  // read shows them, which leaves out what is aria-hidden or not drawn (`page-inspect.ts`): a selector
  // worked out from a read names one of those; of several in the page, the one it shows is the one meant.
  let bySelector: Element | null = null;
  if (ref == null && selector === ':focus') bySelector = deepFocus(document);
  else if (ref == null) {
    const all = [...document.querySelectorAll(selector)];
    const shown = all.filter((one) => one.closest('[aria-hidden="true"]') === null && one.checkVisibility({ checkVisibilityCSS: true }));
    if (shown.length > 1 || (shown.length === 0 && all.length > 1)) return { several: shown.length > 1 ? shown.length : all.length };
    bySelector = shown[0] ?? all[0] ?? null;
  }
  const found = ref == null ? bySelector : marked?.byRef.get(ref) ?? null;
  if (ref != null && !found?.isConnected) return { stale: true };
  if (!found) return { missing: true };
  const element = found as HTMLElement;
  if (element.matches(':disabled')) return { not_applied: 'It is disabled, so no key was pressed in it.' };
  if (inertOf(element)) return { not_applied: 'It is in an inactive (inert) part of the page, so no key was pressed in it.' };
  // A field in a frame from this site, or in a web component, takes the key in its own window.
  const doc = element.ownerDocument;
  const beforeUrl = doc.URL;
  const win = (doc.defaultView ?? window) as Window & typeof globalThis;
  const active = selector === ':focus' && ref == null ? element : deepFocus(doc);
  let modal = enclosingModal(active);
  if (!modal && (press.key === 'Escape' || press.key === 'Tab')) {
    const open = doc.querySelectorAll<HTMLDialogElement>('dialog:modal');
    if (open.length > 1) return { not_applied: 'The active dialog has no focused control.' };
    modal = open[0] ?? enclosingModal(element);
  }
  if (modal && enclosingModal(element) !== modal) return { not_applied: 'Use a control in the active dialog.' };
  if (active !== element && typeof element.focus === 'function') element.focus();
  if (!element.isConnected || inertOf(element)) return { not_applied: 'The control changed before the key was pressed.' };
  const init: KeyboardEventInit = { key: press.key, code: press.code, keyCode: press.keyCode, which: press.keyCode,
    ctrlKey: press.ctrlKey, metaKey: press.metaKey, altKey: press.altKey, shiftKey: press.shiftKey,
    bubbles: true, cancelable: true, composed: true, view: win };
  let allowed = element.dispatchEvent(new win.KeyboardEvent('keydown', init));
  // A key that writes a character, or Enter, also sends `keypress`, which older pages listen for.
  if (allowed && (press.key.length === 1 || press.key === 'Enter') && !press.ctrlKey && !press.metaKey) {
    const keypressAllowed = element.dispatchEvent(new win.KeyboardEvent('keypress',
      { ...init, charCode: press.key === 'Enter' ? 13 : press.key.charCodeAt(0) }));
    if (press.key === 'Enter') allowed = keypressAllowed;
  }

  const tag = element.localName;
  const type = tag === 'input' ? (element as HTMLInputElement).type : '';
  const role = (element.getAttribute('role') ?? '').toLowerCase();
  const TOGGLES = ['checkbox', 'radio', 'switch'];
  const field = tag === 'input' && !['button', 'submit', 'reset', 'image', 'checkbox', 'radio', 'file', 'color', 'range'].includes(type);
  const writable = field || tag === 'textarea' || element.isContentEditable;
  const nativeLink = (tag === 'a' || tag === 'area') && element.hasAttribute('href');
  const linkScrolls = role === 'link' || nativeLink && role === '';
  const activates = tag === 'button' || tag === 'summary' || nativeLink
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
  const scrollLink = () => {
    if (!element.isConnected || inertOf(element) || deepFocus(doc) !== element) return;
    const direction = press.shiftKey ? -1 : 1;
    const root = doc.scrollingElement;
    const byPage = (scroller: Element) => scroller.scrollBy({ top: direction * Math.max(1, Math.floor(scroller.clientHeight * 0.9)),
      behavior: 'instant' });
    for (let at: Element | null = element; at !== null && at !== root;) {
      if (modal && enclosingModal(at) !== modal) return;
      const style = win.getComputedStyle(at);
      const range = at.scrollHeight - at.clientHeight;
      if (range > 0 && /^(auto|scroll|overlay)$/.test(style.overflowY)) {
        if (direction < 0 ? at.scrollTop > 0 : at.scrollTop < range - 1) {
          byPage(at);
          return;
        }
        if (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none') return;
      }
      at = at.assignedSlot ?? at.parentElement ?? (at.getRootNode() as ShadowRoot).host ?? null;
    }
    if (!modal && root) byPage(root);
  };
  const moveRange = (input: HTMLInputElement, key: string) => {
    if (!input.isConnected || input.matches(':disabled')) return;
    const before = input.value;
    const { appearance, direction, writingMode } = win.getComputedStyle(input);
    const legacyVertical = writingMode === 'horizontal-tb' && appearance === 'slider-vertical';
    const vertical = legacyVertical || writingMode !== 'horizontal-tb';
    const rtl = legacyVertical || direction === 'rtl';
    const sideways = writingMode === 'sideways-lr';
    // Chromium increases toward inline-end and the line-over edge.
    const inlineEnd = vertical ? (rtl !== sideways ? 'ArrowUp' : 'ArrowDown') : (rtl ? 'ArrowLeft' : 'ArrowRight');
    const lineOver = vertical ? (sideways ? 'ArrowLeft' : 'ArrowRight') : 'ArrowUp';
    const increase = key === inlineEnd || key === lineOver || key === 'PageUp';
    const anyStep = input.step.toLowerCase() === 'any';
    if (key.startsWith('Arrow') && !anyStep) {
      input.stepUp(increase ? 1 : -1);
    } else {
      const number = doc.createElement('input');
      number.type = 'number';
      const readNumber = (raw: string, fallback: number) => {
        number.value = raw;
        return Number.isFinite(number.valueAsNumber) ? number.valueAsNumber : fallback;
      };
      const min = readNumber(input.min, 0);
      const max = Math.max(min, readNumber(input.max, 100));
      if (key === 'Home' || key === 'End') {
        input.valueAsNumber = key === 'Home' ? min : max;
      } else {
        const configuredStep = readNumber(input.step, 1);
        const step = anyStep ? max / 100 - min / 100 : configuredStep > 0 ? configuredStep : 1;
        const delta = key.startsWith('Page') ? Math.max(max / 10 - min / 10, step) : step;
        const value = input.valueAsNumber + (increase ? delta : -delta);
        // The browser applies the range's actual clamping and step base.
        input.valueAsNumber = Math.max(min, Math.min(max, value));
      }
    }
    if (input.value !== before) {
      input.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
  };
  const moveNumber = (input: HTMLInputElement, key: string) => {
    const usable = () => input.isConnected && input.ownerDocument === doc && doc.URL === beforeUrl
      && (expectedUrl == null || location.href === expectedUrl) && deepFocus(doc) === input
      && !doc.documentElement.hasAttribute('data-recued-owner-surface')
      && (modal === undefined || enclosingModal(input) === modal)
      && input.type === 'number' && !input.readOnly && !inertOf(input)
      && !input.matches(':disabled, [aria-disabled="true"], [aria-readonly="true"]');
    if (!usable()) return;
    const { writingMode } = win.getComputedStyle(input);
    const up = writingMode.endsWith('-rl') ? 'ArrowRight' : writingMode.endsWith('-lr') ? 'ArrowLeft' : 'ArrowUp';
    const down = up === 'ArrowRight' ? 'ArrowLeft' : up === 'ArrowLeft' ? 'ArrowRight' : 'ArrowDown';
    if (key !== up && key !== down) return;
    const direction = key === up ? 1 : -1;
    const before = input.value;
    const constraints = ['min', 'max', 'step', 'value'] as const;
    const authored = constraints.map(name => input.getAttribute(name));
    const number = doc.createElement('input');
    number.type = 'number';
    const bound = (value: string, fallback: number) => {
      number.value = value;
      return Number.isNaN(number.valueAsNumber) ? fallback : number.valueAsNumber;
    };
    const min = bound(input.min, -Infinity);
    const max = bound(input.max, Infinity);
    const anyStep = input.step.toLowerCase() === 'any';
    const offset = (base: string, count: number) => {
      number.step = anyStep ? '1' : input.step;
      number.defaultValue = base;
      number.value = base;
      number.stepUp(count);
      return number.value;
    };
    // The spinner starts an empty field at zero or one step from a bound.
    // Do that arithmetic on a detached control to preserve decimal precision.
    let start = before || '0';
    if (!before) {
      if (Number.isFinite(min)) {
        const nearMin = offset(input.min, -direction);
        if (Number(nearMin) > Number(start)) start = nearMin;
      }
      if (Number.isFinite(max)) {
        const nearMax = offset(input.max, -direction);
        if (Number(nearMax) < Number(start)) start = nearMax;
      }
    }
    const current = Number(start);
    const configure = () => {
      number.min = input.min;
      number.max = input.max;
      number.step = anyStep ? '1' : input.step;
      number.defaultValue = input.defaultValue;
    };
    let next = start;
    if (direction > 0 && current < min) next = String(min);
    else if (direction < 0 && current > max) next = String(max);
    else if (direction > 0 ? current < max : current > min) {
      if (anyStep) {
        // The spinner uses a unit step for "any", while the DOM step methods
        // reject it. Carry the fractional part as the detached step base.
        const candidate = offset(start, direction);
        if (Number(candidate) > max) {
          configure();
          number.value = String(max);
          if (number.validity.stepMismatch) number.stepDown();
          if (number.valueAsNumber >= current) next = number.value;
        } else if (Number(candidate) >= min) {
          next = candidate;
        }
      } else {
        configure();
        number.value = start;
        number.stepUp(direction);
        next = number.value;
      }
    }
    if (next === before || next === '') return;
    if (!input.dispatchEvent(new win.InputEvent('beforeinput', {
      inputType: 'insertText', data: next, bubbles: true, composed: true, cancelable: true,
    })) || !usable() || input.value !== before || constraints.some((name, i) => input.getAttribute(name) !== authored[i])) return;
    input.value = next;
    if (input.value !== before) {
      input.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
      input.dispatchEvent(new win.Event('change', { bubbles: true }));
    }
  };
  const moveRadio = (input: HTMLInputElement, key: string): Element | null => {
    const { name, form } = input;
    if (name === '' || deepFocus(doc) !== input) return null;
    const root = input.getRootNode() as Document | ShadowRoot;
    const groupMember = (radio: HTMLInputElement) => radio.isConnected && radio.type === 'radio'
      && radio.name === name && radio.form === form && radio.getRootNode() === root;
    const available = (radio: HTMLInputElement) => groupMember(radio) && !radio.matches(':disabled')
      && !inertOf(radio) && (modal === undefined || enclosingModal(radio) === modal)
      && radio.checkVisibility({ checkVisibilityCSS: true });
    // Arrow navigation wraps in tree order and can focus radios with tabindex="-1".
    const group = [...root.querySelectorAll<HTMLInputElement>('input[type="radio" i]')].filter(available);
    const from = group.indexOf(input);
    if (from === -1 || group.length <= 1) return null;
    const rtl = win.getComputedStyle(input).direction === 'rtl';
    const reverse = key === 'ArrowUp' || key === (rtl ? 'ArrowRight' : 'ArrowLeft');
    const next = group[(from + (reverse ? -1 : 1) + group.length) % group.length]!;
    next.focus();
    // A focus handler can replace, disable or move a choice before activation.
    if (deepFocus(doc) === next && groupMember(input) && available(next)) next.click();
    return deepFocus(doc);
  };
  let sent = false;
  let focusMoved: Element | null = null;
  const plain = !press.ctrlKey && !press.metaKey && !press.altKey;
  const undo = press.key.toLowerCase() === 'z' && press.ctrlKey !== press.metaKey && !press.shiftKey && !press.altKey;
  const edit = tag === 'input' || tag === 'textarea' ? element as HTMLInputElement | HTMLTextAreaElement : undefined;
  const focusedEditor = () => element.isConnected && element.ownerDocument === doc && doc.URL === beforeUrl
    && (expectedUrl == null || location.href === expectedUrl) && deepFocus(doc) === element
    && !doc.documentElement.hasAttribute('data-recued-owner-surface')
    && (modal === undefined || enclosingModal(element) === modal)
    && !inertOf(element) && !element.matches(':disabled, [aria-disabled="true"], [aria-readonly="true"]')
    && !edit?.readOnly;
  if (allowed && undo && (tag === 'textarea' || /^(?:text|search|url|tel|email|number)$/.test(type) || element.isContentEditable)) {
    // A canceled shortcut belongs to the page. The browser undo stack
    // belongs to this document, as it does for a physical keyboard.
    if (focusedEditor() && doc.queryCommandEnabled('undo')
      && element.dispatchEvent(new win.InputEvent('beforeinput', {
        inputType: 'historyUndo', bubbles: true, composed: true, cancelable: true,
      })) && focusedEditor()) {
      doc.execCommand('undo');
      focusMoved = deepFocus(doc);
    }
  }
  if (allowed && plain) {
    if (type === 'range' && /^(?:Home|End|Arrow(?:Up|Down|Left|Right)|Page(?:Up|Down))$/.test(press.key)) {
      moveRange(element as HTMLInputElement, press.key);
    } else if (type === 'number' && /^Arrow(?:Up|Down|Left|Right)$/.test(press.key)) {
      moveNumber(element as HTMLInputElement, press.key);
    } else if (type === 'radio' && /^Arrow(?:Up|Down|Left|Right)$/.test(press.key)) {
      focusMoved = moveRadio(element as HTMLInputElement, press.key);
    } else if (edit && (press.key === 'Home' || press.key === 'End') && edit.selectionStart !== null) {
      if (focusedEditor()) {
        // Chromium's selection engine keeps the anchor and handles wrapped lines
        // and bidi text. On macOS Home and End use the document boundary.
        const boundary = win.navigator.platform.startsWith('Mac') ? 'documentboundary' : 'lineboundary';
        doc.getSelection()?.modify(press.shiftKey ? 'extend' : 'move', press.key === 'Home' ? 'backward' : 'forward', boundary);
      }
    } else if (press.key === 'Enter' && element.isConnected && !element.matches(':disabled') && !inertOf(element)) {
      const blocksImplicitSubmit = (control: Element) => control.localName === 'input'
        && /^(?:text|search|tel|url|email|password|date|month|week|time|datetime-local|number)$/.test((control as HTMLInputElement).type);
      const form = blocksImplicitSubmit(element) ? (element as HTMLInputElement).form : null;
      if (form !== null) {
        // Use tree order and each control's live form owner. form.elements skips image submitters.
        const root = form.getRootNode() as Document | ShadowRoot;
        const controls = [...root.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')]
          .filter(control => control.form === form);
        const button = controls.find(control => control.type === 'submit' || control.type === 'image');
        if (button !== undefined) {
          if (!button.matches(':disabled') && !inertOf(button)) {
            button.click();
            sent = true;
          }
        } else if (controls.filter(blocksImplicitSubmit).length <= 1) {
          // When there is no submit button, multiple blocking fields leave the form open.
          win.HTMLFormElement.prototype.requestSubmit.call(form);
          sent = true;
        }
      } else if (tag === 'textarea' || element.isContentEditable) {
        if (!doc.execCommand(tag === 'textarea' ? 'insertText' : 'insertParagraph', false, '\n')) write('\n');
      } else if (activates && !toggle) {
        if (typeof element.click === 'function') element.click();
        else element.dispatchEvent(new win.MouseEvent('click', { ...init, button: 0 }));
      }
    } else if (press.key === ' ') {
      if (linkScrolls && !writable) scrollLink();
      else if (activates && typeof element.click === 'function') element.click();
      else if (writable) write(' ');
    } else if (press.key === 'Escape') {
      const search = type === 'search' ? element as HTMLInputElement : undefined;
      if (search?.value && !search.readOnly && !search.matches(':disabled, [aria-disabled="true"], [aria-readonly="true"]')) {
        const sameControl = () => search.isConnected && search.ownerDocument === doc && search.type === 'search'
          && doc.URL === beforeUrl && (expectedUrl == null || location.href === expectedUrl)
          && !doc.documentElement.hasAttribute('data-recued-owner-surface');
        if (sameControl() && deepFocus(doc) === search && !inertOf(search)
          && (modal === undefined || enclosingModal(search) === modal)) {
          const value = search.value;
          const pending = new win.AbortController();
          // A native search clear commits its change when the field blurs.
          search.addEventListener('change', () => pending.abort(), { capture: true, signal: pending.signal });
          search.addEventListener('blur', () => {
            pending.abort();
            if (sameControl() && search.value !== value) search.dispatchEvent(new win.Event('change', { bubbles: true }));
          }, { capture: true, signal: pending.signal });
          search.value = '';
          search.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
          if (sameControl()) search.dispatchEvent(new win.Event('search', { bubbles: true }));
        }
      } else {
        const dialog = modal ?? (element.closest('dialog[open]') as HTMLDialogElement | null);
        if (dialog?.open && dialog.getAttribute('closedby')?.toLowerCase() !== 'none') {
          if (typeof dialog.requestClose === 'function') dialog.requestClose();
          else if (dialog.dispatchEvent(new win.Event('cancel', { cancelable: true }))) dialog.close();
        }
      }
    } else if (press.key === 'Tab') {
      const from = deepFocus(doc) ?? element;
      const within = enclosingModal(from) ?? modal;
      const controls = 'a[href], area[href], button, input, select, textarea, summary, iframe, '
        + '[tabindex], [contenteditable]:not([contenteditable="false"])';
      type Control = HTMLElement | SVGElement;
      type Stop = { control: Control; order: number; focusable: boolean; nested?: Iterable<Element> };
      // Positive tabindex reorders siblings in the same focus scope. Expand a
      // shadow host or slot at its position, after sorting the enclosing scope.
      const orderedStops = (children: Iterable<Element>): Control[] => {
        const pending = [...children].reverse();
        const stops: Stop[] = [];
        while (pending.length) {
          const node = pending.pop()!;
          if (node.hasAttribute('inert')) continue;
          const control = node as Control;
          const root = shadowOf(node);
          const slot = node instanceof win.HTMLSlotElement ? node : undefined;
          const assigned = slot?.assignedNodes();
          const nested = root?.children ?? (assigned?.length
            ? assigned.filter((child): child is Element => child.nodeType === Node.ELEMENT_NODE) : slot?.children);
          if (nested !== undefined && control.tabIndex < 0 && /^\s*-\d/.test(node.getAttribute('tabindex') ?? '')) continue;
          const focusable = control.tabIndex >= 0 && !root?.delegatesFocus && control.matches(controls)
            && !control.matches(':disabled, input[type="hidden"]') && !inertOf(control)
            && (within === undefined || enclosingModal(control) === within)
            && control.checkVisibility({ checkVisibilityCSS: true });
          if (nested !== undefined || focusable) {
            stops.push({ control, order: control.tabIndex > 0 ? control.tabIndex : Infinity, focusable, nested });
          }
          if (nested === undefined) {
            for (let child = node.lastElementChild; child; child = child.previousElementSibling) pending.push(child);
          }
        }
        stops.sort((a, b) => a.order - b.order);
        return stops.flatMap(({ control, focusable, nested }) =>
          (focusable ? [control] : []).concat(nested === undefined ? [] : orderedStops(nested)));
      };
      const reachable = orderedStops((within ?? doc).children);
      const namedRadio = (node: Element): HTMLInputElement | undefined => {
        if (node.localName !== 'input') return undefined;
        const input = node as HTMLInputElement;
        return input.type === 'radio' && input.name !== '' ? input : undefined;
      };
      // Form ownership is scoped to a tree. Unowned radios share a group only
      // within their own document or shadow root.
      const radioOwner = (input: HTMLInputElement): Node => input.form ?? input.getRootNode();
      const checkedGroups = new Map<Node, Set<string>>();
      for (const control of reachable) {
        const radio = namedRadio(control);
        if (!radio?.checked) continue;
        const owner = radioOwner(radio);
        const names = checkedGroups.get(owner) ?? new Set<string>();
        names.add(radio.name);
        checkedGroups.set(owner, names);
      }
      const fromRadio = namedRadio(from);
      const fromOwner = fromRadio && radioOwner(fromRadio);
      const at = reachable.findIndex(control => control === from);
      const direction = press.shiftKey ? -1 : 1;
      const start = at === -1 && press.shiftKey ? 0 : at;
      let next: Control | undefined;
      for (let distance = 1; distance <= reachable.length; distance++) {
        const candidate = reachable[(start + direction * distance + reachable.length) % reachable.length]!;
        if (candidate === from) continue;
        const radio = namedRadio(candidate);
        if (radio && !radio.checked) {
          const owner = radioOwner(radio);
          if (checkedGroups.get(owner)?.has(radio.name) || owner === fromOwner && radio.name === fromRadio?.name) continue;
        }
        next = candidate;
        break;
      }
      if (next !== undefined && doc.URL === beforeUrl
        && (expectedUrl == null || location.href === expectedUrl)
        && !doc.documentElement.hasAttribute('data-recued-owner-surface')) {
        next.focus();
        focusMoved = deepFocus(doc);
      }
    } else if (press.key === 'Backspace' || press.key === 'Delete') {
      if (writable) doc.execCommand(press.key === 'Backspace' ? 'delete' : 'forwardDelete');
    }
  }
  // The key comes up where the focus now is.
  (focusMoved ?? element).dispatchEvent(new win.KeyboardEvent('keyup', init));
  return { outputs: { pressed: press.name, ...(sent ? { sent: true } : {}) } };
};
