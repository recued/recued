/** Shared modal focus management — a Tab focus-trap (a11y).
 *
 * One utility across every `aria-modal` dialog (the Run modal, the recipes
 * Automation modal, the chat Create overlay). On wire it moves focus into the
 * dialog (the panel, so a screen reader announces it); while open it keeps
 * Tab / Shift+Tab cycling WITHIN the dialog (wrapping last→first / first→last)
 * and pulls focus back in if it escapes; on `release()` it restores focus to
 * whatever was focused before the dialog opened.
 *
 * The keydown listener attaches to the DOCUMENT (so it catches Tab regardless
 * of where focus sits) and the container is re-acquired on every Tab via
 * `getContainer`, so a host that RE-RENDERS the dialog's DOM (an innerHTML
 * repaint that recreates the element) stays trapped — pass `() => el` for a
 * stable element, or `() => root.querySelector(...)` for a repainted one.
 *
 * Focusable detection is a manual tree walk over `children` (not a CSS
 * `querySelectorAll`), so it works against both the real DOM and the codebase's
 * minimal fake-document test harnesses.
 *
 * Pure module (DOM only). */

/** The minimal element shape the trap reads — satisfied by real `HTMLElement`s
 *  and the fake-document test elements alike. */
interface TrapNode {
  readonly tagName?: string;
  readonly disabled?: boolean;
  readonly checked?: boolean;
  readonly form?: unknown;
  getClientRects?(): { length: number };
  scrollIntoView?(options: ScrollIntoViewOptions): void;
  readonly children?: Iterable<TrapNode> | ArrayLike<TrapNode>;
  getAttribute?(name: string): string | null;
  focus?(): void;
}

export interface WireFocusTrapOptions {
  /** Re-acquire the dialog container — called on wire AND on every Tab, so a
   *  host that recreates the dialog element on re-render stays trapped. Return
   *  `null` when the dialog is gone (the trap then no-ops until released). */
  getContainer: () => HTMLElement | null;
  /** Document the keydown listener attaches to. Defaults to
   *  `globalThis.document`; throws if neither is available. */
  document?: Document;
  /** Move focus into the dialog on wire (the panel, else the first focusable,
   *  else the container). Default `true`. Set `false` when the host already
   *  focuses in itself. */
  initialFocus?: boolean;
  /** Restore focus to the pre-wire `activeElement` on release. Default `true`. */
  restoreFocus?: boolean;
}

export interface FocusTrapHandle {
  /** Move focus into the dialog (the panel, else the first focusable, else the
   *  container). Called automatically on wire unless `initialFocus: false`;
   *  a host that PORTALS the container AFTER wiring (focusing a detached node
   *  is a no-op) wires with `initialFocus: false` then calls this once mounted.
   *  A no-op after release. */
  focusInitial(): void;
  /** Detach the keydown listener + restore focus (when `restoreFocus`).
   *  Idempotent. */
  release(): void;
}

const FOCUSABLE_TAGS = new Set([
  'A',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'SUMMARY',
]);

const tag = (node: TrapNode): string =>
  typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';

const attr = (node: TrapNode, name: string): string | null =>
  typeof node.getAttribute === 'function' ? node.getAttribute(name) : null;

/** Whether `node` can receive keyboard focus in the Tab order: a non-disabled
 *  link-with-href / form control / `<summary>` / explicitly-tabbable element.
 *  A negative or non-numeric `tabindex` (`-1` / `-2` / `bogus`) removes it. */
const isFocusable = (node: TrapNode): boolean => {
  if (node.disabled === true || attr(node, 'hidden') !== null || attr(node, 'inert') !== null || attr(node, 'aria-hidden') === 'true') return false;
  if (node.getClientRects && node.getClientRects().length === 0) return false;
  const element = node as HTMLElement;
  const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
  if (style?.visibility === 'hidden' || style?.visibility === 'collapse') return false;
  const tabindex = attr(node, 'tabindex');
  if (tabindex !== null) {
    const order = Number.parseInt(tabindex, 10);
    if (Number.isNaN(order) || order < 0) return false;
  }
  const t = tag(node);
  if (t === 'A') return attr(node, 'href') !== null;
  if (FOCUSABLE_TAGS.has(t)) return true;
  // A non-native element is tabbable only with an explicit (validated >= 0)
  // tabindex.
  return tabindex !== null;
};

/** Whether `node` is the dialog surface — the preferred initial-focus target so
 *  a screen reader announces the dialog (not its first control). */
const isDialogPanel = (node: TrapNode): boolean =>
  attr(node, 'role') === 'dialog' || attr(node, 'tabindex') === '-1';

const childList = (node: TrapNode): TrapNode[] => {
  const kids = node.children;
  if (kids === undefined || kids === null) return [];
  return Array.from(kids as ArrayLike<TrapNode>);
};

const walk = (root: TrapNode, visit: (node: TrapNode) => void): void => {
  for (const child of childList(root)) {
    if (attr(child, 'hidden') !== null || attr(child, 'inert') !== null) continue;
    visit(child);
    // A collapsed <details> keeps ONLY its <summary> in the tab order; its
    // content is still in the DOM tree but unreachable, so visit the summary
    // and don't descend into the rest.
    if (tag(child) === 'DETAILS' && attr(child, 'open') === null) {
      for (const grandchild of childList(child)) {
        if (tag(grandchild) === 'SUMMARY') visit(grandchild);
      }
      continue;
    }
    walk(child, visit);
  }
};

const collectFocusable = (root: TrapNode): TrapNode[] => {
  const out: TrapNode[] = [];
  walk(root, (node) => {
    if (isFocusable(node)) out.push(node);
  });
  // A radio group has one Tab stop; arrow keys remain native within it.
  return out.filter(node => {
    const name = attr(node, 'name');
    if (tag(node) !== 'INPUT' || attr(node, 'type') !== 'radio' || !name) return true;
    const group = out.filter(other => tag(other) === 'INPUT' && attr(other, 'type') === 'radio'
      && attr(other, 'name') === name && other.form === node.form);
    return node === (group.find(other => other.checked === true) ?? group[0]);
  }).sort((a, b) => {
    const order = (node: TrapNode) => { const n = Number(attr(node, 'tabindex')); return n > 0 ? n : Infinity; };
    return order(a) - order(b);
  });
};

/** The element to focus on open: the container itself if it's the dialog
 *  surface, else the first descendant dialog surface, else the first focusable,
 *  else the container. */
const initialFocusTarget = (container: TrapNode): TrapNode => {
  if (isDialogPanel(container)) return container;
  let dialog: TrapNode | null = null;
  walk(container, (node) => {
    if (dialog === null && isDialogPanel(node)) dialog = node;
  });
  if (dialog !== null) return dialog;
  return collectFocusable(container)[0] ?? container;
};

const focusNode = (node: TrapNode | null): void => {
  if (node !== null && typeof node.focus === 'function') {
    node.focus();
    node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
};

/** Traverse the currently rendered dialog, including Safari-skipped buttons. */
export const focusNextInDialog = (container: HTMLElement, active: Element | null, backwards = false): void => {
  const focusables = collectFocusable(container as unknown as TrapNode);
  if (!focusables.length) { focusNode(container); return; }
  const index = focusables.indexOf(active as unknown as TrapNode);
  const next = index < 0 ? (backwards ? focusables.length - 1 : 0)
    : (index + (backwards ? -1 : 1) + focusables.length) % focusables.length;
  focusNode(focusables[next]!);
};

export const wireFocusTrap = (
  opts: WireFocusTrapOptions,
): FocusTrapHandle => {
  const doc =
    opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'wireFocusTrap: no document available — pass `opts.document` for non-browser environments',
    );
  }
  const docEvents = doc as unknown as {
    activeElement?: TrapNode | null;
    addEventListener?: (type: string, fn: (ev: Event) => void) => void;
    removeEventListener?: (type: string, fn: (ev: Event) => void) => void;
  };

  // Capture the opener BEFORE moving focus in, so release can restore it.
  const previousFocus: TrapNode | null = docEvents.activeElement ?? null;

  const onKeydown = (event: Event): void => {
    if ((event as KeyboardEvent).key !== 'Tab') return;
    const container = opts.getContainer();
    if (container === null) return; // dialog gone → leave focus alone
    if ((event as KeyboardEvent).isComposing) return;
    event.preventDefault?.();
    focusNextInDialog(container, doc.activeElement, (event as KeyboardEvent).shiftKey);
  };

  let released = false;
  const focusInitial = (): void => {
    if (released) return;
    const container = opts.getContainer();
    if (container !== null) {
      focusNode(initialFocusTarget(container as unknown as TrapNode));
    }
  };

  if (opts.initialFocus !== false) focusInitial();

  docEvents.addEventListener?.('keydown', onKeydown);

  return {
    focusInitial,
    release: () => {
      if (released) return;
      released = true;
      docEvents.removeEventListener?.('keydown', onKeydown);
      if (opts.restoreFocus !== false) focusNode(previousFocus);
    },
  };
};
