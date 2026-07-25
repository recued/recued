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
  if (node.disabled === true) return false;
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
  return out;
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
  if (node !== null && typeof node.focus === 'function') node.focus();
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
    const focusables = collectFocusable(container as unknown as TrapNode);
    const active = docEvents.activeElement ?? null;
    const preventDefault = (event as { preventDefault?: () => void })
      .preventDefault;
    if (focusables.length === 0) {
      // Nothing tabbable → keep focus on the dialog surface itself.
      preventDefault?.call(event);
      focusNode(container as unknown as TrapNode);
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const inTrap =
      active === (container as unknown as TrapNode) || focusables.includes(active as TrapNode);
    if (!inTrap) {
      // Focus escaped (or a re-render detached it) → pull it back in.
      preventDefault?.call(event);
      focusNode((event as KeyboardEvent).shiftKey ? last : first);
      return;
    }
    if ((event as KeyboardEvent).shiftKey) {
      if (active === first || active === (container as unknown as TrapNode)) {
        preventDefault?.call(event);
        focusNode(last);
      }
    } else if (active === last) {
      preventDefault?.call(event);
      focusNode(first);
    }
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
