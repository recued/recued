/** D-335 slice A — the Bridge's page read for an AI: the page, or one region of
 *  it, as cleaned HTML (D-335 §3.2), with a ref on every element
 *  a person can act on. The ordinary executor (`executor.ts`) and the reviewed
 *  one (`reviewed-document.ts`) both inject `inspectPage` and read its answer
 *  with `inspectOutcome`.
 *
 *  ⛔ `inspectPage` IS INJECTED, SO IT MUST BE SELF-CONTAINED. Chrome serializes
 *  its source and runs it with only its arguments (see `page-fields.ts`).
 *
 *  🔑 A REF LIVES IN THE BRIDGE, NEVER IN THE PAGE. Every injection into one
 *  document runs in the same isolated world, whose globals the page's own
 *  scripts cannot see, so the ref map kept there lasts from one command to the
 *  next and goes with the document. The page is never written to: the HTML says
 *  `ref="e12"`, but a page could put that attribute on another element, so a
 *  ref resolves only through the map, and a ref whose element has gone fails
 *  rather than falling back to a match. */

import {
  BRIDGE_INSPECT_CEILING_CHARS,
  BRIDGE_INSPECT_MAX_CHARS,
  BRIDGE_INSPECT_MAX_VALUE_CHARS,
  BRIDGE_PAGE_CHANGED_MESSAGE,
  BRIDGE_PAGE_GONE_MESSAGE,
  isPatternWithinGrantedOrigins,
  type BridgeErrorCode,
} from '@recued/contracts';
import type { SelectorRules } from '../picker/selector-engine.js';
import type { ActionExecutorOutcome } from '../queue/dispatcher.js';
import type { DocumentScripting } from './reviewed-document.js';
import type { PageWaitCheck } from './page-wait.js';
import type { PageMessageRules } from './page-problems.js';

/** What to read: the whole page, one element inspect marked, or one by CSS. */
export interface PageInspectScope {
  ref?: string;
  selector?: string;
}

/** An interaction check shared by scripts in the same Bridge document world. */
export interface PageInteractionWorld {
  recuedInertOf?: (element: Element) => boolean;
  recuedValidation?: {
    observe(root: Node): void;
    reports: WeakMap<Element, { event: Event; url: string; message: string }>;
  };
}

type ValidationField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

export interface PageInspectLimits {
  max_chars: number;
  max_value_chars: number;
}

export const PAGE_INSPECT_LIMITS: PageInspectLimits = {
  max_chars: BRIDGE_INSPECT_MAX_CHARS,
  max_value_chars: BRIDGE_INSPECT_MAX_VALUE_CHARS,
};

/** Exactly one key, as the field functions answer (`page-fields.ts`). */
export type PageInspectAnswer =
  | { waiting: { url: string; title: string } }
  | { outputs: { url: string; title: string; html: string; truncated: boolean; loading?: boolean; selector_matches?: number; selected_index?: number;
      structure_complete?: boolean; structure_root?: string; structure_scoped?: boolean } }
  /** No element matches the selector. */
  | { missing: true }
  /** The selector is not valid CSS. */
  | { invalid: true }
  /** The ref names no element on this page any more. */
  | { stale: true }
  /** The owner client, or a reviewed document whose address changed. */
  | { blocked: true };

/** The page, or the element `scope` names, as cleaned HTML:
 *  - removed: styles, scripts, `noscript`, templates, frames, embedded
 *    objects, SVG drawing data (visible text and its groups stay), comments, and every
 *    element a person cannot see, which is also where injected text hides;
 *  - kept: a closed list of attributes, at most three readable class names,
 *    and each field's live state (its value, `checked`, `selected`) rather
 *    than its markup;
 *  - a password, hidden, sign-in code or card field keeps its element and
 *    loses its value;
 *  - every element a person can act on carries `ref="eN"`, numbered in
 *    document order the first time it is seen and kept for the page's life;
 *  - D-335 slice R: what a person sees inside a web component (its shadow root,
 *    open or closed, with the page's own content in its slots) and inside a
 *    frame from the same site (an editor's, mostly) is read in place, its refs
 *    in this document's map; a frame from another site, which no script here can
 *    read, is `<iframe data-recued-frame="N">`, for the Bridge to name as a page
 *    of its own (`settleFrames`);
 *  - at most `max_chars`, cut at an element boundary with every open element
 *    closed, answering `truncated`; one text, value or attribute at most
 *    `max_value_chars`, then an ellipsis.
 *  `expectedUrl` is a reviewed document's address, checked in the same
 *  injection as the read. Slice T: `keepGone` is how many refs of elements the page removed a
 *  `reread` keeps ({@link PAGE_REREAD_KEPT_GONE}); an inspection keeps none.
 *  `preserveStructure` is a whole-page collection read: omitted roots retain
 *  only their original tag and an internal marker, with sibling-fidelity metadata. */
export const inspectPage = (
  scope: PageInspectScope,
  limits: PageInspectLimits,
  expectedUrl?: string | null,
  keepGone = 0,
  domReady = false,
  when?: PageWaitCheck | null,
  preserveStructure = false,
  scopedStructure = false,
): PageInspectAnswer => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement?.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };
  if (preserveStructure && (scope.ref !== undefined || scope.selector !== undefined)) return { invalid: true };
  if (scopedStructure && !preserveStructure) return { invalid: true };

  /** What holds an element as a person sees it: the slot showing it, its parent, else the web
   *  component whose shadow root it is in. */
  const above = (at: Element): Element | null =>
    at.assignedSlot ?? at.parentElement ?? (at.getRootNode() as ShadowRoot).host ?? null;
  /** Slice R — a web component's shadow root, open or closed: what it draws. `chrome.dom` reaches a
   *  closed one, which a page's own scripts cannot. */
  const shadowOf = (element: Element): ShadowRoot | null => {
    try {
      const dom = (globalThis as typeof globalThis & {
        chrome?: { dom?: { openOrClosedShadowRoot?: (host: Element) => ShadowRoot | null | undefined } } }).chrome?.dom;
      return dom?.openOrClosedShadowRoot?.(element) ?? element.shadowRoot;
    } catch {
      return element.shadowRoot;
    }
  };

  // 2026-11-22 — a dialog the page marks hidden (`aria-hidden="true"` on it or around it) while a person
  // sees it on top of the page. cnn.com's "Legal Terms and Privacy" sits in a `div aria-hidden="true"`,
  // in a see-through layer over the whole page: a person's click anywhere lands on it, yet a read leaving
  // out what is aria-hidden showed the page as if it were not there, with nothing to answer it by. Such a
  // dialog is read like any other: found where a click at the screen's centre, or at the centre of one of
  // its quarters, would land (into web components, as a click's own test looks, `clickPageElement`), the
  // outermost dialog marked hidden around what is there. What it marks hidden inside it stays out, and so
  // does what is around it: the wrappers on the way to it are walked through, writing nothing of their own
  // (`leadsTo`). Not in a structural read.
  // 2026-11-22 (the owner: "build the 'show the blocker' version") — and what covers the page at the
  // screen's centre that the page marks hidden, though it is no dialog: the outermost element fixed on the
  // screen around what a click there lands on, such as an ad's full-screen layer over a page whose body is
  // marked hidden (Google's vignette, a link shortener's ad). Before, the read was empty, and a countdown
  // or a Close button in it never reached the model. It is marked `data-recued-cover`, so the outline says
  // something covers the page. Not while the page has a modal dialog open that it does not hide: what it
  // hides then is what is behind that dialog, on purpose.
  const DIALOG = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const onTop = new Set<Element>();
  const leadsTo = new Set<Element>();
  const covers = new Set<Element>();
  if (!preserveStructure) {
    try {
      const marked = (element: Element) => {
        for (let at: Element | null = element; at; at = above(at)) if (at.getAttribute('aria-hidden') === 'true') return true;
        return false;
      };
      const lead = (root: Element) => { for (let at = above(root); at; at = above(at)) leadsTo.add(at); };
      const openModal = [...document.querySelectorAll(DIALOG)].some((element) => !marked(element)
        && (element.matches(':modal') || element.getAttribute('aria-modal') === 'true')
        && element.checkVisibility({ checkVisibilityCSS: true }));
      for (const [x, y] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] as const) {
        const px = innerWidth * x;
        const py = innerHeight * y;
        let hit = document.elementFromPoint(px, py);
        for (let depth = 0; hit !== null && depth < 32; depth += 1) {
          const inner = shadowOf(hit)?.elementFromPoint(px, py) ?? null;
          if (inner === null || inner === hit) break;
          hit = inner;
        }
        let dialog: Element | null = null;
        for (let at: Element | null = hit; at; at = above(at)) if (at.matches(DIALOG) && marked(at)) dialog = at;
        if (dialog !== null && !onTop.has(dialog)) {
          onTop.add(dialog);
          lead(dialog);
        }
        if (x !== 0.5 || y !== 0.5 || openModal) continue;
        let cover: Element | null = null;
        for (let at: Element | null = hit; at; at = above(at)) {
          if (marked(at) && getComputedStyle(at).position === 'fixed') cover = at;
        }
        if (cover !== null && !onTop.has(cover)) {
          onTop.add(cover);
          lead(cover);
          if (!cover.matches(DIALOG)) covers.add(cover);
        }
      }
    } catch {
      // A document that cannot say where a click lands reads as before.
      onTop.clear();
      leadsTo.clear();
      covers.clear();
    }
  }

  // A scoped root can inherit exclusion without carrying the flag itself. A dialog on top is read
  // whatever is marked on it or around it; what is marked inside it stays out.
  const ariaExcluded = (element: Element): boolean => {
    for (let at: Element | null = element; at; at = above(at)) {
      if (onTop.has(at)) return false;
      if (at.getAttribute('aria-hidden') === 'true') return true;
    }
    return false;
  };

  // The worker owns polling/deadlines. This one synchronous injection tests
  // readiness and reads the chosen region from the same document state.
  let readyRoot: Element | undefined;
  let selectorMatches: Element[] | undefined;
  if (when != null) {
    if (when.until !== 'shown' || when.selector !== scope.selector || scope.ref !== undefined) return { invalid: true };
    const normal = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
    let matches: Element[];
    try { matches = [...document.querySelectorAll(when.selector)]; } catch { return { invalid: true }; }
    selectorMatches = matches;
    const wanted = when.text == null ? '' : normal(when.text);
    readyRoot = matches.find(element => !ariaExcluded(element)
      && (element.checkVisibility({ checkVisibilityCSS: true }) || getComputedStyle(element).display === 'contents')
      && (wanted === '' || normal((element as HTMLElement).innerText ?? element.textContent ?? '').includes(wanted)));
    if (!readyRoot) return { waiting: { url: location.href, title: document.title.slice(0, 200) } };
  }
  if (!document.documentElement) return { missing: true };

  // The ref map, kept in this document's isolated world for the next command.
  // D-347 follow-up 17 — and what each element with a ref showed at the read that last wrote it (`seen`),
  // with how that is taken (`print`), so a step by the ref can tell whether the page has since drawn
  // something else into it (`page-rebind.ts`).
  type Print = Record<string, string>;
  type RefMap = { next: number; byRef: Map<string, Element>; byElement: WeakMap<Element, string>;
    seen?: WeakMap<Element, Print>; print?: (element: Element) => Print; svgLabel?: (element: Element) => string;
    labelledByName?: (element: Element) => string;
    labelChoices?: Map<string, { control: HTMLInputElement; type: string }>;
    fieldContexts?: WeakMap<Element, number>; nextFieldContext?: number };
  const world = globalThis as typeof globalThis & PageInteractionWorld & { recuedPageRefs?: RefMap };
  const refs: RefMap = world.recuedPageRefs ??= { next: 1, byRef: new Map(), byElement: new WeakMap() };
  const inertOf = world.recuedInertOf ??= (element: Element): boolean => {
    for (let at: Element | null = element; at !== null;) {
      if (at.hasAttribute('inert')) return true;
      // A modal escapes inherited inertness within its own document.
      const frame: Element | null = at.ownerDocument.defaultView?.frameElement ?? null;
      at = at.matches('dialog:modal') ? frame : above(at) ?? frame;
    }
    return element.ownerDocument.defaultView?.getComputedStyle(element).getPropertyValue('interactivity') === 'inert';
  };
  let focused = document.activeElement;
  for (let depth = 0; focused && depth < 32; depth++) {
    const inner = shadowOf(focused)?.activeElement;
    if (!inner) break;
    focused = inner;
  }
  let focusedModal: Element | null = focused;
  while (focusedModal && !focusedModal.matches('dialog:modal')) focusedModal = above(focusedModal);
  // An element the page removed loses its ref, here and in the HTML to come. Slice T: a re-read the
  // server makes after an action keeps the latest of them, so a ref read before the action is still
  // found again where the page drew its element anew (slice M).
  const gone = [...refs.byRef].filter(([, element]) => !element.isConnected);
  for (const [ref, element] of gone.slice(0, Math.max(0, gone.length - keepGone))) {
    refs.byRef.delete(ref);
    refs.byElement.delete(element);
    refs.labelChoices?.delete(ref);
  }

  let root: Element | null;
  if (scope.ref !== undefined) {
    root = refs.byRef.get(scope.ref) ?? null;
    if (!root) return { stale: true };
  } else if (scope.selector !== undefined) {
    try {
      selectorMatches ??= [...document.querySelectorAll(scope.selector)];
      root = readyRoot ?? selectorMatches[0] ?? null;
    } catch {
      return { invalid: true };
    }
    if (!root) return { missing: true };
  } else {
    root = document.body ?? document.documentElement;
  }

  const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'object', 'embed', 'link', 'meta', 'base', 'head']);
  const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'source', 'track', 'wbr', 'link', 'meta', 'base']);
  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
  const SVG_GROUPS = new Set(['svg', 'g', 'a', 'switch', 'text']);
  const SVG_TEXT_CHILDREN = new Set(['tspan', 'textPath', 'a']);
  let structureComplete = true;
  // `value`, `checked`, `selected` and `disabled` are written from the live element below.
  // Slice U — and `aria-modal`, so the server can say a dialog that blocks the page is open.
  const KEPT = ['id', 'name', 'type', 'role', 'href', 'alt', 'title', 'placeholder', 'for', 'aria-label',
    'data-testid', 'contenteditable', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-modal',
    'aria-controls', 'aria-owns', 'aria-labelledby', 'aria-activedescendant', 'aria-disabled', 'aria-current', 'aria-sort',
    'usemap', 'shape', 'coords'];
  const ACTIONABLE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'textbox', 'searchbox', 'combobox', 'slider',
    'spinbutton', 'treeitem']);
  const PROTECTED = /(^|\s)(current-password|new-password|one-time-code|cc-\S+)(\s|$)/i;

  const cut = (text: string) => text.length > limits.max_value_chars
    ? `${text.slice(0, limits.max_value_chars)}…` : text;
  const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attribute = (name: string, value: string) => ` ${name}="${escapeText(cut(value)).replace(/"/g, '&quot;')}"`;
  const resolveHref = (value: string, base?: string): URL | undefined => {
    try { return new URL(value, base); } catch { return undefined; }
  };

  const styleOf = (element: Element) => (element.ownerDocument.defaultView ?? window).getComputedStyle(element);
  // A contents wrapper has no box, but can still contain rendered text and elements.
  const showsContents = (style: CSSStyleDeclaration) =>
    style.display === 'contents' && style.visibility === 'visible' && style.contentVisibility !== 'hidden';
  const shown = (element: Element) => !ariaExcluded(element)
    && (element.checkVisibility({ checkVisibilityCSS: true }) || showsContents(styleOf(element)));
  // The DOM focus stays on the widget. Its active item is separate from
  // selection and can be in an owned or controlled popup.
  const activeFor = (owner: Element | null): Element | null => {
    if (!owner) return null;
    const root = owner.getRootNode() as Document | ShadowRoot;
    const id = owner.getAttribute('aria-activedescendant');
    const active = owner.ariaActiveDescendantElement ?? (id ? root.getElementById(id) : null);
    if (!active || active === owner || !shown(owner) || inertOf(owner) || !shown(active) || inertOf(active)) return null;
    if (owner.contains(active) || owner.ariaOwnsElements?.includes(active)) return active;
    const role = (owner.getAttribute('role') ?? '').trim().split(/\s+/, 1)[0];
    return /^(?:combobox|textbox|searchbox)$/.test(role ?? '') && owner.ariaControlsElements?.some(popup =>
      popup.contains(active) || popup.ariaOwnsElements?.includes(active)) ? active : null;
  };
  const activeItem = activeFor(focused);

  type DisplayOrder = { direction: 'top-to-bottom' | 'left-to-right'; positions: Map<Element, number> };
  const displayOrders = new WeakMap<Element, DisplayOrder | null>();
  const displayOrderOf = (parent: Element): DisplayOrder | null => {
    if (parent.childElementCount < 2 || parent.childElementCount > 24) return null;
    const saved = displayOrders.get(parent);
    if (saved !== undefined) return saved;
    displayOrders.set(parent, null);
    if (!/^(?:inline-)?(?:flex|grid)$/.test(styleOf(parent).display) || shadowOf(parent)) return null;
    const boxes = Array.from(parent.children).filter(child => !ariaExcluded(child)
      && child.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }))
      .map(child => ({ child, rect: child.getBoundingClientRect() }));
    if (boxes.length < 2 || boxes.some(({ rect }) => rect.width <= 0 || rect.height <= 0)) return null;
    // Report a sequence only when the boxes form one clear track. A second
    // axis of separation, or overlapping items, need more layout evidence.
    const orderedBy = (start: 'top' | 'left', end: 'bottom' | 'right',
      crossStart: 'top' | 'left', crossEnd: 'bottom' | 'right') => {
      const sorted = [...boxes].sort((first, second) => first.rect[start] - second.rect[start]);
      const crossMin = Math.max(...boxes.map(({ rect }) => rect[crossStart]));
      const crossMax = Math.min(...boxes.map(({ rect }) => rect[crossEnd]));
      return crossMin < crossMax && sorted.every(({ rect }, i) => i === 0 || sorted[i - 1]!.rect[end] <= rect[start] + 0.5)
        ? sorted : undefined;
    };
    const vertical = orderedBy('top', 'bottom', 'left', 'right');
    const ordered = vertical ?? orderedBy('left', 'right', 'top', 'bottom');
    if (!ordered || ordered.every((box, i) => box === boxes[i])) return null;
    const layout: DisplayOrder = { direction: vertical ? 'top-to-bottom' : 'left-to-right',
      positions: new Map(ordered.map(({ child }, i) => [child, i + 1])) };
    displayOrders.set(parent, layout);
    return layout;
  };
  const listOrdinals = new WeakMap<Element, Map<Element, number>>();
  const listInteger = (element: Element, name: string): number | undefined => {
    const digits = /^[\t\n\f\r ]*([+-]?\d+)/.exec(element.getAttribute(name) ?? '')?.[1];
    return digits === undefined ? undefined : Number(digits);
  };
  const decimalOrdinal = (item: Element): number | undefined => {
    const list = item.parentElement;
    if (list?.localName !== 'ol') return undefined;
    const cached = listOrdinals.get(list);
    if (cached !== undefined) return cached.get(item);
    const ordinals = new Map<Element, number>();
    listOrdinals.set(list, ordinals);
    const view = list.ownerDocument.defaultView ?? window;
    const customCounter = (style: CSSStyleDeclaration) =>
      /\blist-item\b/.test([style.counterReset, style.counterSet, style.counterIncrement].join(' '));
    const listStyle = view.getComputedStyle(list);
    if (listStyle.display === 'contents' || customCounter(listStyle)) return undefined;
    const children = [...list.children];
    if (children.some(child => !['li', 'script', 'style', 'template'].includes(child.localName))) return undefined;
    // Use the live list, even for a scoped read. A visibility-hidden item still counts,
    // and a display-none item has no list-item box.
    const rendered = children.filter(child => child.localName === 'li').map(child => ({ child, style: view.getComputedStyle(child) }))
      .filter(({ style }) => /\blist-item\b/.test(style.display));
    const reversed = list.hasAttribute('reversed');
    let ordinal = listInteger(list, 'start') ?? (reversed ? rendered.length : 1);
    for (const { child, style } of rendered) {
      ordinal = listInteger(child, 'value') ?? ordinal;
      if (customCounter(style) || ordinal < -2_147_483_648 || ordinal > 2_147_483_647) {
        ordinals.clear();
        break;
      }
      if (style.listStyleType === 'decimal' && style.listStyleImage === 'none'
        && view.getComputedStyle(child, '::marker').content === 'normal') ordinals.set(child, ordinal);
      ordinal += reversed ? -1 : 1;
    }
    return ordinals.get(item);
  };
  /** What a person sees inside an element, in order: a component's shadow root in place of its
   *  own children, and in a slot the page's content it shows, else the slot's own. */
  const childrenOf = (element: Element): Node[] => {
    if (element.localName === 'slot') {
      const assigned = (element as HTMLSlotElement).assignedNodes({ flatten: true });
      return assigned.length > 0 ? assigned : [...element.childNodes];
    }
    const shadow = shadowOf(element);
    if (shadow) structureComplete = false;
    return [...(shadow ?? element).childNodes];
  };
  /** An observation binds each external iframe to its actual browsing context. */
  const frameSlots = new Map<string, FrameSlot>();
  let frameObservation: string | undefined;
  const isProtected = (element: Element) => {
    const type = element.localName === 'input' ? (element as HTMLInputElement).type : '';
    return type === 'password' || type === 'hidden' || PROTECTED.test(element.getAttribute('autocomplete') ?? '');
  };
  const visibleMaps = new WeakMap<Element, boolean>();
  const mappedArea = (element: Element): boolean => {
    const map = element.closest('map[name]');
    const name = map?.getAttribute('name');
    if (!map || !name) return false;
    const cached = visibleMaps.get(map);
    if (cached !== undefined) return cached;
    const root = map.getRootNode() as Document | ShadowRoot;
    const first = root.querySelector(`map[name="${CSS.escape(name)}"]`);
    const visible = first === map && [...root.querySelectorAll<HTMLImageElement>(`img[usemap="${CSS.escape('#' + name)}"]`)]
      .some(img => img.naturalWidth > 0 && shown(img) && !inertOf(img) && img.getClientRects().length > 0);
    visibleMaps.set(map, visible);
    return visible;
  };
  const actionable = (element: Element) => {
    const tag = element.localName;
    if (element.getAttribute('draggable')?.toLowerCase() === 'true') return true;
    if (tag === 'a') return element.hasAttribute('href');
    if (tag === 'area') return element.hasAttribute('href') && mappedArea(element);
    if (['button', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
    if ((tag === 'audio' || tag === 'video') && element.hasAttribute('controls')) return true;
    // An editor's own paragraphs are part of it; only the editor takes a ref.
    if ((element as HTMLElement).isContentEditable) return !element.parentElement?.isContentEditable;
    if (ACTIONABLE_ROLES.has((element.getAttribute('role') ?? '').trim().split(/\s+/)[0]!)) return true;
    const tabindex = element.getAttribute('tabindex');
    return tabindex !== null && tabindex.trim() !== '' && Number(tabindex) >= 0;
  };
  const hiddenLabelChoice = (element: Element): HTMLInputElement | undefined => {
    if (element.localName !== 'label' || element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return undefined;
    const control = (element as HTMLLabelElement).control as HTMLInputElement | null;
    return control?.localName === 'input' && (control.type === 'radio' || control.type === 'checkbox')
      && !control.matches(':disabled, [aria-disabled="true"]') && !inertOf(control)
      && !shown(control) ? control : undefined;
  };
  /** D-347 follow-up 17 — what an element shows, as a step by its ref holds it to: its own words and
   *  attributes, and the row it sits in (a list item, a table row, an article) with the addresses that
   *  row's links lead to. `shows` and `in` are what a refusal quotes, never compared. */
  const ROW = 'li, tr, [role="row"], [role="listitem"], [role="option"], [role="article"], article';
  const said = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  const NON_LABEL_CONTENT = new Set([...SKIPPED, 'input', 'textarea', 'select', 'option', 'iframe', 'frame']);
  // Resolve explicit name and description references in their own tree. Only
  // bounded text becomes evidence for the visible control.
  const referencedText = (element: Element, relation: 'aria-labelledby' | 'aria-describedby'): string => {
    const references = element.getAttribute(relation);
    if (!references || references.length > 2_000) return '';
    const root = element.getRootNode() as Document | ShadowRoot;
    const ids = [...new Set(said(references).split(' '))];
    const max = 200;
    let name = '', count = 0;
    const append = (text: string) => {
      const room = max + 1 - name.length;
      if (room > 0) name += text.slice(0, room * 4).replace(/\s+/g, ' ').slice(0, room);
    };
    const readName = (node: Node, includeHidden: boolean): void => {
      if (count++ >= 256 || name.length > max) return;
      if (node.nodeType === Node.TEXT_NODE) { append(node.nodeValue ?? ''); return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const part = node as HTMLElement;
      if (NON_LABEL_CONTENT.has(part.localName) || part.isContentEditable || isProtected(part)
        || part.hasAttribute('data-recued-owner-surface') || !includeHidden && !shown(part)) return;
      const given = said(part.getAttribute('aria-label') ?? (part.localName === 'img' ? part.getAttribute('alt') : null));
      if (given) { append(given); return; }
      const block = !['inline', 'contents'].includes((part.ownerDocument.defaultView ?? window).getComputedStyle(part).display);
      if (block) append(' ');
      const children = part.localName === 'slot' ? (part as HTMLSlotElement).assignedNodes({ flatten: true }) : [];
      for (const child of children.length ? children : (shadowOf(part) ?? part).childNodes) {
        if (count >= 256 || name.length > max) break;
        readName(child, includeHidden);
      }
      if (block) append(' ');
    };
    for (const id of ids.slice(0, 16)) {
      if (count >= 256 || name.length > max) break;
      const source = root.getElementById?.(id);
      if (!source) continue;
      if (name) append(' ');
      readName(source, !shown(source));
    }
    const normalized = said(name);
    return normalized && (normalized.length > max || count >= 256 || ids.length > 16)
      ? normalized.slice(0, max).trimEnd() + '…' : normalized;
  };
  const labelledByName = (element: Element): string => referencedText(element, 'aria-labelledby');
  const ICON_CONTROL = 'button, a[href], summary, [role="button"], [role="link"]';
  const svgLabelOf = (element: Element): string => {
    if (!element.matches(ICON_CONTROL)
      || ['aria-label', 'aria-labelledby', 'title'].some(name => said(element.getAttribute(name)))) return '';
    if (element.localName === 'a' && element.namespaceURI === SVG_NAMESPACE) {
      return said(element.querySelector(':scope > title')?.textContent);
    }
    const icons = element.querySelectorAll('svg');
    if (!icons.length || said((element as HTMLElement).innerText)) return '';
    const labels: string[] = [];
    for (const icon of icons) {
      if (icon.namespaceURI !== SVG_NAMESPACE || icon.closest(ICON_CONTROL) !== element || ariaExcluded(icon)
        || !icon.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
      const role = said(icon.getAttribute('role')).split(' ')[0];
      if (role === 'none' || role === 'presentation') continue;
      const title = icon.querySelector(':scope > title');
      const namedBy = said(icon.getAttribute('aria-labelledby'));
      // A direct title reference has the same source as the SVG's native name.
      if (namedBy && namedBy !== title?.id) continue;
      const label = (namedBy ? '' : said(icon.getAttribute('aria-label'))) || said(title?.textContent);
      if (label) labels.push(label);
    }
    return labels.join(' ');
  };
  const printOf = (element: Element, iconLabel = svgLabelOf(element), referencedName = labelledByName(element)): Print => {
    const form = (element as HTMLInputElement).form ?? element.closest('form');
    const row = element.parentElement?.closest(ROW) ?? null;
    // A field's text is what it holds, which typing changes.
    const text = element.matches('input, textarea, select') ? '' : said(element.textContent).slice(0, 200);
    const label = referencedName || said(element.getAttribute('aria-label')) || iconLabel;
    const title = said(element.getAttribute('title'));
    const placeholder = said(element.getAttribute('placeholder'));
    const rowText = row === null ? '' : said(row.textContent).slice(0, 300);
    return {
      tag: element.localName, type: said(element.getAttribute('type')).toLowerCase(), name: element.getAttribute('name') ?? '',
      accesskey: element.getAttribute('accesskey') ?? '',
      role: said(element.getAttribute('role')).toLowerCase(), label: label.toLowerCase(), labelledBy: referencedName.toLowerCase(),
      placeholder: placeholder.toLowerCase(),
      title: title.toLowerCase(), text: text.toLowerCase(),
      value: element.matches('input[type="submit" i], input[type="button" i], input[type="reset" i]')
        ? said((element as HTMLInputElement).value).toLowerCase() : '',
      href: element.getAttribute('href') ?? '',
      form: form === null ? '' : `${form.id}|${form.getAttribute('action') ?? ''}|${said(form.getAttribute('method')).toLowerCase()}`,
      row: rowText.toLowerCase(),
      links: row === null ? '' : [...row.querySelectorAll('a[href]')].filter((link) => link !== element)
        .map((link) => link.getAttribute('href') ?? '').sort().join(' ').slice(0, 300),
      shows: (label || text || title || placeholder || element.localName).slice(0, 60),
      in: rowText.slice(0, 80),
    };
  };
  refs.seen ??= new WeakMap();
  refs.print = printOf;
  refs.svgLabel = svgLabelOf;
  refs.labelledByName = labelledByName;
  const refOf = (element: Element) => {
    let ref = refs.byElement.get(element);
    if (ref === undefined) {
      ref = `e${refs.next++}`;
      refs.byElement.set(element, ref);
      refs.byRef.set(ref, element);
    }
    return ref;
  };
  // Separate node identities keep non-actionable forms out of the public eN
  // sequence, while detecting a replaced owner even with identical attributes.
  const contextOf = (element: Element): number => {
    refs.fieldContexts ??= new WeakMap();
    const old = refs.fieldContexts.get(element);
    if (old !== undefined) return old;
    const next = refs.nextFieldContext = (refs.nextFieldContext ?? 0) + 1;
    refs.fieldContexts.set(element, next);
    return next;
  };
  const activeVideoCaption = (video: HTMLVideoElement): string => {
    const Cue = (video.ownerDocument.defaultView as (Window & typeof globalThis) | null)?.VTTCue;
    if (!Cue || video.seeking) return '';
    const time = video.currentTime;
    let text = '';
    for (const track of video.textTracks) {
      if (track.mode !== 'showing' || (track.kind !== 'captions' && track.kind !== 'subtitles')) continue;
      const active = track.activeCues;
      if (!active) continue;
      for (const cue of active) {
        if (!(cue instanceof Cue) || cue.startTime > time || cue.endTime <= time) continue;
        const readable = cue.getCueAsHTML().textContent?.trim();
        if (readable) text += (text ? '\n' : '') + readable;
        if (text.length >= limits.max_value_chars) return text;
      }
    }
    return text;
  };
  const openTag = (element: Element) => {
    const tag = element.localName;
    let text = `<${tag}`;
    if ((tag === 'input' || tag === 'textarea') && element.namespaceURI === 'http://www.w3.org/1999/xhtml'
      && element.matches(':focus') && !isProtected(element) && !inertOf(element)) {
      const field = element as HTMLInputElement | HTMLTextAreaElement;
      const { selectionStart: start, selectionEnd: end } = field;
      if (start !== null && end !== null && end > start && end - start <= limits.max_value_chars) {
        text += attribute('data-recued-selected-text', field.value.slice(start, end));
      }
    }
    if (world.recuedValidation && ['input', 'select', 'textarea'].includes(tag)) {
      world.recuedValidation.observe(element.getRootNode());
      const report = world.recuedValidation.reports.get(element);
      const field = element as ValidationField;
      if (report?.message && !report.event.defaultPrevented && report.url === element.ownerDocument.URL
        && field.matches(':focus') && !inertOf(field) && !isProtected(field)
        && field.willValidate && field.validationMessage.slice(0, 2_000) === report.message) {
        text += attribute('data-recued-validation-message', field.validationMessage);
      }
    }
    const rendered = renderedText(element);
    if (rendered !== undefined) text += attribute('data-recued-rendered-text', rendered);
    if ((tag === 'audio' || tag === 'video') && element.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      const media = element as HTMLMediaElement;
      if (media.controls) {
        text += ' controls';
        text += attribute('data-recued-media-current', `${media.currentTime}s`);
        if (Number.isFinite(media.duration)) text += attribute('data-recued-media-duration', `${media.duration}s`);
        text += attribute('data-recued-media-state', media.paused ? 'paused' : 'playing');
      }
      if (tag === 'video') {
        const caption = activeVideoCaption(element as HTMLVideoElement);
        if (caption) text += attribute('data-recued-media-caption', caption);
      }
    }
    if (element === activeItem) text += ' data-recued-keyboard-item';
    if (activeItem !== null && element === focused) text += ' data-recued-keyboard-owner';
    const layout = displayOrderOf(element);
    if (layout) text += attribute('data-recued-display-order', `${layout.direction}:${layout.positions.size}`);
    const layoutParent = element.parentElement;
    const position = layoutParent === null ? undefined : displayOrderOf(layoutParent)?.positions.get(element);
    // A bare "1" can be classified as a numeric hostname in a Chat HTML value.
    if (position !== undefined) text += attribute('data-recued-display-position', `position-${position}`);
    const role = (element.getAttribute('role') ?? '').trim().split(/\s+/)[0];
    if (tag === 'table' || ['table', 'grid', 'treegrid'].includes(role ?? '')) {
      // A cleaned capture cannot align omitted cells or flattened shadow/slot
      // structure with the native table reader. Keep header texts in that case,
      // but do not advertise them as complete column keys. Bound the extra walk.
      const pending: Element[] = [element];
      let known = true, visited = 0;
      while (pending.length) {
        const node = pending.pop()!;
        if (++visited > 1_000 || shadowOf(node) || node.localName === 'slot'
          || node.matches('th,td,[role="columnheader"],[role="rowheader"],[role="cell"],[role="gridcell"]') && !shown(node)) { known = false; break; }
        pending.push(...node.children);
      }
      text += ` data-recued-table-layout="${known ? '1' : '0'}"`;
    }
    if (['th', 'td'].includes(tag) || ['columnheader', 'rowheader', 'cell', 'gridcell'].includes(role ?? '')) {
      for (const name of ['colspan', 'rowspan', 'aria-colspan', 'aria-rowspan']) {
        const value = element.getAttribute(name);
        if (value !== null) text += attribute(name, value);
      }
    }
    if ((tag === 'a' || tag === 'area') && element.hasAttribute('download')) text += ' data-recued-download';
    if (element.getAttribute('draggable')?.toLowerCase() === 'true') text += ' draggable="true"';
    // Only the Bridge writes this marker. A transformed branch does not
    // disqualify sibling-preserving fields in an unrelated native subtree.
    // Slots are flattened into their parent; mark that parent before walking.
    if (scopedStructure && (shadowOf(element) !== null
      || [...element.children].some(child => child.localName === 'slot')
      || tag === 'select' && element.querySelector('optgroup') !== null
      || tag === 'svg' && element.childElementCount > 0 || tag === 'iframe' || tag === 'frame' || tag === 'object')) {
      text += ' data-recued-structure-incomplete';
      structureComplete = false;
    }
    const choice = hiddenLabelChoice(element);
    const checkbox = choice ?? (tag === 'input' ? element as HTMLInputElement : undefined);
    const mixed = checkbox?.type === 'checkbox' && checkbox.indeterminate;
    const canAct = choice !== undefined || actionable(element);
    if (canAct && inertOf(element)) text += ' data-recued-inert';
    else if (canAct) {
      const ref = refOf(element);
      text += ` ref="${ref}"`;
      if (choice) {
        (refs.labelChoices ??= new Map()).set(ref, { control: choice, type: choice.type });
        text += attribute('data-recued-label-choice', choice.type);
        if (choice.checked) text += ' checked';
      }
      const iconLabel = svgLabelOf(element);
      const referencedName = labelledByName(element);
      if (iconLabel) text += attribute('data-recued-svg-label', iconLabel);
      if (referencedName) text += attribute('data-recued-labelledby-name', referencedName);
      const help = referencedText(element, 'aria-describedby') || said(element.getAttribute('aria-description')).slice(0, 200);
      if (help) text += attribute('data-recued-description', help);
      refs.seen!.set(element, printOf(element, iconLabel, referencedName));
    }
    if (tag === 'summary') {
      const details = element.parentElement;
      if (details?.localName === 'details' && details.querySelector(':scope > summary') === element) {
        text += attribute('data-recued-summary-expanded', String((details as HTMLDetailsElement).open));
      }
    }
    for (const name of KEPT) {
      if (mixed && name === 'aria-checked') continue;
      const value = element.getAttribute(name);
      if (value !== null) text += attribute(name, value);
    }
    if (tag === 'time' && element.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      const datetime = (element as HTMLTimeElement).dateTime;
      // Preserve the authored value and offset. A clipped value could look like a different time.
      if (datetime && datetime.length <= limits.max_value_chars) text += attribute('datetime', datetime);
    }
    if (tag === 'ol') {
      const start = element.getAttribute('start');
      if (start !== null) text += attribute('start', start);
      if (element.hasAttribute('reversed')) text += ' reversed';
    } else if (tag === 'li') {
      const value = element.getAttribute('value');
      if (value !== null) text += attribute('value', value);
      const ordinal = decimalOrdinal(element);
      if (ordinal !== undefined) text += attribute('data-recued-list-ordinal', String(ordinal));
    }
    if (mixed) text += ' aria-checked="mixed"';
    // Keep literal hrefs for CSS. Record the browser destination only where the document or frame
    // base changes it. An empty marker means the modeled link has no usable web destination.
    const svgAnchor = tag === 'a' && element.namespaceURI === SVG_NAMESPACE;
    if ((tag === 'a' || tag === 'area') && (element.baseURI !== location.href || svgAnchor)) {
      const written = element.getAttribute('href');
      if (written !== null) {
        const nativeHref = svgAnchor ? (element as SVGAElement).href.animVal : (element as HTMLAnchorElement).href;
        const resolved = resolveHref(typeof nativeHref === 'string' ? nativeHref : written, element.baseURI);
        if (resolved?.href !== resolveHref(written, location.href)?.href) {
          text += attribute('data-recued-resolved-href', resolved && /^https?:$/.test(resolved.protocol)
            && !resolved.username && !resolved.password ? resolved.href : '');
        }
      }
    }
    if (tag === 'img' && element.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      const image = element as HTMLImageElement;
      const source = image.complete && image.naturalWidth > 0 ? resolveHref(image.currentSrc) : undefined;
      if (source && /^https?:$/.test(source.protocol) && !source.username && !source.password) {
        const path = source.origin === location.origin && !source.pathname.startsWith('//')
          ? source.pathname + source.search + source.hash : source.href;
        // Keep the selected, loaded URL whole, including any query from srcset or picture.
        if (path.length <= limits.max_value_chars) text += attribute('data-recued-current-src', path);
      }
    }
    const names = [...element.classList].filter(name => name.length >= 3 && !/[\d:[]/.test(name)).slice(0, 3);
    if (names.length > 0) text += attribute('class', names.join(' '));
    if (element.matches(':disabled')) text += ' disabled';
    if (tag === 'select' && (element as HTMLSelectElement).multiple) text += ' multiple';
    // Slice U — a dialog shown as a modal one: nothing behind it can be used until it closes.
    if (tag === 'dialog' && element.matches(':modal')) {
      text += ' modal';
      if (element === focusedModal) text += ' data-recued-focused-modal';
    }
    // 2026-11-22 — what covers the page though the page marks it hidden (`covers`): only the Bridge writes it.
    if (covers.has(element)) text += ' data-recued-cover';
    if (tag === 'meter' && element.namespaceURI === 'http://www.w3.org/1999/xhtml') {
      const meter = element as HTMLMeterElement;
      for (const key of ['value', 'min', 'max'] as const) text += attribute(key, String(meter[key]));
      if (!canAct) {
        const referencedName = labelledByName(element);
        if (referencedName) text += attribute('data-recued-labelledby-name', referencedName);
      }
    } else if (tag === 'input') {
      const field = element as HTMLInputElement;
      if (field.type === 'file' && field.multiple) text += ' multiple';
      if (field.type === 'checkbox' || field.type === 'radio') {
        if (field.checked) text += ' checked';
        // D-402 slice G — what the box sends, as the page wrote it, which tells boxes of one name apart
        // (`checkboxes[]`, `cb1` to `cb3`) for a selector that finds one alone. Never `.value`, which
        // reads "on" for a box the page gave no value.
        const sent = element.getAttribute('value');
        if (sent !== null && sent.length <= 200) text += attribute('value', sent);
      } else if (field.type !== 'file' && !isProtected(element) && field.value !== '') {
        text += attribute('value', field.value);
      }
      if (field.type === 'range') {
        // Parse the constraints through Chrome's numeric input grammar.
        const number = element.ownerDocument.createElement('input');
        number.type = 'number';
        const readNumber = (raw: string, fallback: number) => {
          number.value = raw;
          return Number.isFinite(number.valueAsNumber) ? number.valueAsNumber : fallback;
        };
        const min = readNumber(field.min, 0);
        const max = Math.max(min, readNumber(field.max, 100));
        const step = readNumber(field.step, 1);
        text += attribute('min', String(min)) + attribute('max', String(max))
          + attribute('step', field.step.toLowerCase() === 'any' ? 'any' : String(step > 0 ? step : 1));
      } else if (['number', 'date', 'datetime-local', 'time', 'month', 'week'].includes(field.type)) {
        const parser = element.ownerDocument.createElement('input');
        parser.type = field.type;
        for (const key of ['min', 'max'] as const) {
          parser.value = field[key];
          if (Number.isFinite(parser.valueAsNumber)) text += attribute(key, parser.value);
        }
        parser.type = 'number';
        parser.value = field.step;
        const step = parser.valueAsNumber;
        if (field.step.toLowerCase() === 'any') text += attribute('step', 'any');
        else if (Number.isFinite(step) && step > 0) text += attribute('step', String(step));
      }
      const list = field.list;
      if (list && !isProtected(element) && !element.matches(':disabled, [readonly]') && !ariaExcluded(list)) {
        // The list itself draws no page box. Its choices are offered by this input.
        const suggestions: string[] = [];
        let chars = 2;
        let inspected = 0;
        let incomplete = false;
        for (const option of list.options) {
          if (++inspected > limits.max_value_chars) { incomplete = true; break; }
          const value = option.value;
          if (value === '' || option.matches(':disabled, [hidden]') || ariaExcluded(option)) continue;
          const style = (option.ownerDocument.defaultView ?? window).getComputedStyle(option);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') continue;
          const label = option.label;
          if (value.length + label.length > limits.max_value_chars) { incomplete = true; continue; }
          const pair = JSON.stringify([label, value]);
          const length = pair.length + (suggestions.length ? 1 : 0);
          if (chars + length > limits.max_value_chars) { incomplete = true; break; }
          suggestions.push(pair);
          chars += length;
        }
        if (suggestions.length || incomplete) {
          text += attribute('list', list.id) + attribute('data-recued-suggestions', `[${suggestions.join(',')}]`);
          if (incomplete) text += ' data-recued-suggestions-incomplete';
        }
      }
    }
    // A loading form can remain usable while unrelated ads/text change.
    // Keep its ownership/context separately, with no entered values. The
    // server still compares the field itself and the document/URL twice.
    if (actionable(element) && (['input', 'select', 'textarea'].includes(tag) || (element as HTMLElement).isContentEditable)) {
      const form = (element as HTMLInputElement).form ?? element.closest('form');
      const ancestors: unknown[] = [];
      for (let at = element.parentElement; at; at = at.parentElement) {
        if (at.matches('form, fieldset, dialog, [role="dialog"], [aria-modal="true"]')) {
          ancestors.push([contextOf(at), at.localName, at.id, at.getAttribute('role'), at.getAttribute('aria-modal'),
            at.hasAttribute('disabled'), at.getAttribute('aria-disabled')]);
        }
      }
      const context = JSON.stringify([form ? [contextOf(form), form.id, form.action, form.method, form.enctype, form.target] : null,
        element.getAttribute('form'), element.hasAttribute('readonly'), ancestors]);
      // Never turn a cut context into positive stability evidence. A Bridge
      // without this marker keeps the previous whole-page comparison.
      if (context.length <= limits.max_value_chars) text += attribute('data-recued-field-context', context);
    }
    return `${text}>`;
  };

  /** A child whose DOM is readable in the current document world. */
  const inlineDocument = (inner: Document, tag: string, open: string) => {
    if (inner.documentElement?.hasAttribute('data-recued-owner-surface')) {
      // Keep its sibling slot without any owner-client content or identity.
      if (preserveStructure) {
        const placeholder = `<${tag} data-recued-structural-only data-recued-structure-incomplete></${tag}>`;
        if (fits(placeholder)) write(placeholder); else truncated = true;
      }
      return;
    }
    const close = `</${tag}>`;
    if (!fits(`${open}>${close}`)) { truncated = true; return; }
    const mark = out.length;
    write(`${open}>`);
    owed += close.length;
    const body = inner.body ?? inner.documentElement;
    if (body) walk(body);
    owed -= close.length;
    if (truncated && out.length === mark + 1) {
      out.length = mark;
      length -= open.length + 1;
      return;
    }
    write(close);
  };

  const objectDocument = (owner: HTMLObjectElement): Document | undefined => {
    try {
      const inner = owner.contentDocument;
      const view = inner?.defaultView;
      if (inner?.contentType === 'text/html' && view?.frameElement === owner
        && view.origin === window.origin && /^https?:/.test(inner.URL)) return inner;
    } catch { /* Only the live same-origin document is readable. */ }
    return undefined;
  };

  const out: string[] = [];
  let length = 0;
  // Closing tags still to write, so that a cut page stays well-formed.
  let owed = 0;
  let truncated = false;
  let preformatted = 0;
  const fits = (text: string) => length + text.length + owed <= limits.max_chars;
  const write = (text: string) => {
    out.push(text);
    length += text.length;
  };
  const writeText = (raw: string, keepWhitespace = false) => {
    if (raw === '' || !keepWhitespace && raw.trim() === '') return;
    const text = escapeText(cut(preformatted > 0 ? raw : raw.replace(/\s+/g, ' ')));
    if (fits(text)) write(text);
    else truncated = true;
  };

  // Chrome serializes this reader without its module scope. Keep the CSSOM string decoder local.
  const generatedText = (element: Element, pseudo: '::before' | '::after' | '::marker'): string => {
    const view = element.ownerDocument?.defaultView;
    const marker = pseudo === '::marker' ? styleOf(element) : undefined;
    if (marker && !marker.display.split(' ').includes('list-item')) return '';
    const style = view?.getComputedStyle(element, pseudo) ?? getComputedStyle(element, pseudo);
    const content = marker && style.content === 'normal' && marker.listStyleImage === 'none'
      ? marker.listStyleType : style.content;
    if (!content?.startsWith('"') || style.display === 'none' || style.visibility !== 'visible'
      || style.opacity === '0' || style.contentVisibility === 'hidden' || style.fontSize === '0px') return '';
    if (!element.checkVisibility({ checkOpacity: true })
      && (view?.getComputedStyle(element) ?? getComputedStyle(element)).display !== 'contents') return '';

    // CSSOM serializes visible strings before any accessibility alternative after "/".
    let text = '';
    let end = 0;
    for (const match of content.matchAll(/ *"((?:[^"\\]|\\.)*)"/gy)) {
      text += match[1]!.replace(/\\(?:([\da-f]{1,6}) ?|(.))/gi,
        (_, hex: string | undefined, escaped: string) => hex === undefined ? escaped : String.fromCodePoint(parseInt(hex, 16)));
      end = match.index + match[0].length;
    }
    if (end !== content.length && !content.startsWith(' / ', end)) return '';
    if (marker) return text.trim() ? text.trimEnd() + ' ' : '';
    return text && !style.display.startsWith('inline') && style.display !== 'contents' ? ' ' + text + ' ' : text;
  };

  // A text leaf can carry its rendered reading without replacing source text
  // or flattening children and their refs. Chrome handles locale and CSS casing.
  const renderedText = (element: Element): string | undefined => {
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || element.childElementCount !== 0
      || NON_LABEL_CONTENT.has(element.localName) || (element as HTMLElement).isContentEditable
      || shadowOf(element) || isProtected(element)) return undefined;
    const source = element.textContent ?? '';
    if (!source.trim() || source.length > limits.max_value_chars || styleOf(element).textTransform === 'none'
      || !element.checkVisibility({ checkVisibilityCSS: true })) return undefined;
    const rendered = (element as HTMLElement).innerText;
    if (!rendered.trim() || rendered.trim() === source.trim()) return undefined;
    const text = generatedText(element, '::marker') + generatedText(element, '::before') + (source.match(/^\s*/)?.[0] ?? '') + rendered.trim()
      + (source.match(/\s*$/)?.[0] ?? '') + generatedText(element, '::after');
    return text.length <= limits.max_value_chars ? text : undefined;
  };

  /** Slice R — a frame. One from this site (or an editor's blank one) is read in place, its
   *  document's body as the frame's content, so an editor's body takes its ref; one from another
   *  site is named and read as a page of its own; the owner's client is never read. */
  const frame = (element: HTMLIFrameElement) => {
    let inner: Document | null = null;
    try {
      inner = element.contentDocument;
    } catch {
      inner = null;
    }
    const tag = preserveStructure ? element.localName : 'iframe';
    let open = preserveStructure ? openTag(element).slice(0, -1) : '<iframe';
    const src = typeof element.src === 'string' ? element.src : '';
    if (/^https?:/i.test(src)) open += attribute('src', src);
    const title = element.getAttribute('title') ?? element.getAttribute('name');
    if (title && !preserveStructure) open += attribute('title', title);
    if (inner !== null) {
      inlineDocument(inner, tag, open);
      return;
    }
    frameObservation ??= Array.from(crypto.getRandomValues(new Uint32Array(2)), word => word.toString(16).padStart(8, '0')).join('');
    const child = element.contentWindow;
    let path: string | undefined;
    if (child !== null) {
      // WindowProxy exposes parent and indexed frame slots across origins, but no foreign DOM.
      const indices: number[] = [];
      let at = child;
      const top = at.top;
      while (at !== top && indices.length < 32) {
        const parent = at.parent;
        let index = 0;
        const length = Math.min(parent.length, 4_096);
        while (index < length && parent.frames[index] !== at) index++;
        if (index === length) break;
        indices.push(index);
        at = parent;
      }
      if (at === top && indices.length > 0) path = ['0', ...indices.reverse()].join('.');
    }
    const named = `${open} data-recued-frame="${frameObservation}:${path ?? '-'}"></${tag}>`;
    if (fits(named)) {
      write(named);
      if (path !== undefined && child !== null) {
        frameSlots.set(path, { element, child, src });
        (globalThis as FrameObservationWorld).recuedFrameObservation = { id: frameObservation, url: location.href, slots: frameSlots };
      }
    } else truncated = true;
  };

  const walk = (node: Node, svgParent?: 'group' | 'text'): void => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      if (svgParent === 'group') return;
      const raw = node.nodeValue ?? '';
      if (svgParent === 'text' || raw.trim() !== '') writeText(raw, svgParent === 'text');
      else if (node.previousSibling && node.nextSibling) {
        // Preserve the space between rendered inline siblings. Formatting
        // whitespace between blocks has no rendered area.
        const range = node.ownerDocument!.createRange();
        range.selectNodeContents(node);
        const { width, height } = range.getBoundingClientRect();
        if (width > 0 && height > 0) writeText(raw, true);
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.localName;
    const svgText = svgParent === 'text' || svgParent === 'group' && tag === 'text';
    if (svgParent !== undefined) {
      const allowed = svgParent === 'text' ? SVG_TEXT_CHILDREN : SVG_GROUPS;
      if (element.namespaceURI !== SVG_NAMESPACE || !allowed.has(tag) || ariaExcluded(element)
        || !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: svgText })) return;
      if (svgText) {
        // Chrome can report visibility for an SVG node without rendered glyphs.
        const { width, height } = element.getBoundingClientRect();
        if (width <= 0 || height <= 0) return;
      }
    }
    const object = tag === 'object' && element.namespaceURI === 'http://www.w3.org/1999/xhtml';
    const inner = object ? objectDocument(element as HTMLObjectElement) : undefined;
    const excluded = SKIPPED.has(tag) && inner === undefined || ariaExcluded(element);
    const drawn = !excluded && element.checkVisibility({ checkVisibilityCSS: true });
    const style = !excluded && !drawn ? styleOf(element) : undefined;
    const visible = drawn || style !== undefined && showsContents(style);
    // Descendants can override inherited CSS visibility. Walk only element
    // children here so hidden text and attributes never enter the observation.
    const canReveal = !object && !VOID.has(tag) && style?.visibility === 'hidden' && style.contentVisibility !== 'hidden'
      && (style.display === 'contents' || element.checkVisibility());
    if (preserveStructure && !visible && !canReveal) {
      // Internal marker, never copied from page attributes. Keep only the
      // original root tag: no hidden text, values, attributes, refs or subtree.
      const placeholder = `<${tag} data-recued-structural-only>${VOID.has(tag) ? '' : `</${tag}>`}`;
      if (fits(placeholder)) write(placeholder); else truncated = true;
      return;
    }
    // A wrapper the page marks hidden (or draws nothing of) around a dialog on top: walked through to
    // it alone, writing nothing of its own and nothing else it holds.
    if (leadsTo.has(element) && !visible) {
      for (const child of childrenOf(element)) {
        if (child.nodeType === Node.ELEMENT_NODE && (leadsTo.has(child as Element) || onTop.has(child as Element))) walk(child);
      }
      return;
    }
    // A slot is where a component shows the page's content: what it shows is read in its place.
    if (tag === 'slot') {
      structureComplete = false;
      if (visible || canReveal) for (const child of childrenOf(element)) {
        if (visible || child.nodeType === Node.ELEMENT_NODE) walk(child);
      }
      return;
    }
    if (canReveal) {
      // A structural read keeps the shell for sibling positions and marks the
      // subtree incomplete because hidden attributes and text were omitted.
      const open = preserveStructure ? `<${tag} data-recued-structure-incomplete>` : '';
      const close = preserveStructure ? `</${tag}>` : '';
      if (!fits(open + close)) { truncated = true; return; }
      structureComplete = false;
      if (open) write(open);
      owed += close.length;
      for (const child of childrenOf(element)) {
        if (child.nodeType === Node.ELEMENT_NODE) walk(child, svgParent);
      }
      owed -= close.length;
      if (close) write(close);
      return;
    }
    if (!visible) return;
    if (tag === 'iframe' || tag === 'frame') {
      structureComplete = false;
      frame(element as HTMLIFrameElement);
      return;
    }
    if (inner !== undefined) {
      structureComplete = false;
      inlineDocument(inner, tag, openTag(element).slice(0, -1));
      return;
    }
    const open = openTag(element);
    const close = VOID.has(tag) ? '' : `</${tag}>`;
    if (!fits(open + close)) {
      truncated = true;
      return;
    }
    const mark = out.length;
    write(open);
    owed += close.length;
    if (tag === 'textarea') {
      const value = isProtected(element) ? '' : escapeText(cut((element as HTMLTextAreaElement).value));
      if (fits(value)) write(value);
      else truncated = true;
    } else if (tag === 'select') {
      if (element.querySelector('optgroup')) structureComplete = false;
      // A closed list draws no options, but they are what a person can choose.
      const list = element as HTMLSelectElement;
      const view = list.ownerDocument.defaultView ?? window;
      const hidden = (option: Element): boolean => {
        const style = view.getComputedStyle(option);
        return option.hasAttribute('hidden') || option.getAttribute('aria-hidden') === 'true'
          || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse';
      };
      const groupEnd = '</optgroup>';
      let openGroup: HTMLOptGroupElement | null = null;
      const closeGroup = () => {
        if (openGroup === null) return;
        owed -= groupEnd.length;
        write(groupEnd);
        openGroup = null;
      };
      for (const option of list.options) {
        const owner = option.closest<HTMLOptGroupElement>('optgroup');
        const groupHidden = owner !== null && hidden(owner);
        const unavailable = groupHidden || hidden(option);
        if (unavailable && !preserveStructure) continue;
        const group = groupHidden ? null : owner;
        if (openGroup !== group) closeGroup();
        const begin = group !== null && group !== openGroup
          ? `<optgroup${attribute('label', group.label)}${group.disabled ? ' disabled' : ''}>` : '';
        let piece = '<option data-recued-structural-only></option>';
        if (!unavailable) {
          const label = option.text.trim();
          piece = '<option';
          if (option.value !== label) piece += attribute('value', option.value);
          if (option.disabled || owner?.disabled) piece += ' disabled';
          if (option.selected && !isProtected(element)) piece += ' selected';
          piece += `>${escapeText(cut(label))}</option>`;
        }
        if (!fits(begin + piece + (begin ? groupEnd : ''))) {
          truncated = true;
          break;
        }
        if (begin) {
          write(begin);
          owed += groupEnd.length;
          openGroup = group;
        }
        write(piece);
      }
      closeGroup();
    } else if (tag === 'svg' || svgParent !== undefined) {
      // A filtered SVG cannot prove sibling positions in structural reads.
      if (tag === 'svg' && element.childElementCount > 0) structureComplete = false;
      if (svgParent !== undefined || element.querySelector('text, a[href]') !== null) {
        for (const child of element.childNodes) walk(child, svgText ? 'text' : 'group');
      }
    } else if (!VOID.has(tag)) {
      if (tag === 'pre') preformatted++;
      writeText(generatedText(element, '::marker'));
      writeText(generatedText(element, '::before'));
      for (const child of childrenOf(element)) walk(child);
      if (!truncated) writeText(generatedText(element, '::after'));
      if (tag === 'pre') preformatted--;
    }
    owed -= close.length;
    const svgLink = svgParent !== undefined && tag === 'a' && element.hasAttribute('href');
    if ((truncated || svgParent !== undefined && !svgLink) && out.length === mark + 1) {
      // Skip empty SVG groups and elements whose content did not fit.
      out.length = mark;
      length -= open.length;
      return;
    }
    write(close);
  };
  walk(root);

  const siblings = preserveStructure ? [...(root.parentNode?.children ?? [root])] : [];
  const typed = siblings.filter(element => element.localName === root.localName);
  const rootPosition = `${siblings.indexOf(root) + 1},${siblings.length},${typed.indexOf(root) + 1},${typed.length}`;

  return { outputs: { url: location.href, title: cut(document.title), html: out.join(''), truncated,
    ...(selectorMatches ? { selector_matches: selectorMatches.length, selected_index: selectorMatches.indexOf(root) + 1 } : {}),
    ...(preserveStructure ? { structure_complete: structureComplete && !truncated, structure_root: rootPosition } : {}),
    ...(scopedStructure ? { structure_scoped: true } : {}),
    ...(domReady ? { loading: document.readyState !== 'complete' } : {}) } };
};

/** Exactly one key, as `inspectPage` answers. */
export type PageDescribeAnswer =
  | { outputs: { url: string; title: string; role: string; label: string; protected: boolean; stable_selector?: string;
    prepared_sends?: boolean; prepared_unsent?: string } }
  | { missing: true }
  | { invalid: true }
  | { stale: true }
  | { inert: true }
  | { blocked: true };

/** D-335 slice B — one element as a person would name it: what kind of thing
 *  it is (`button`, `link`, `text field`…) and its label, read from the page
 *  itself, never from what a model called it. An ask for a write shows this,
 *  and a write by ref reads it first to know its page and element are still
 *  there before anything is typed or clicked. `protected` marks a password,
 *  sign-in code or card field. Injected, so self-contained. */
export const describePageElement = (target: PageInspectScope, expectedUrl?: string | null,
  rules?: SelectorRules | null, messages?: PageMessageRules | null): PageDescribeAnswer => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };
  const world = globalThis as typeof globalThis & PageInteractionWorld & {
    recuedPageRefs?: { byRef: Map<string, Element>; svgLabel?: (element: Element) => string; labelledByName?: (element: Element) => string;
      labelChoices?: Map<string, { control: HTMLInputElement; type: string }> };
  };
  const marked = world.recuedPageRefs;
  let element: Element | null;
  if (target.ref !== undefined) {
    element = marked?.byRef.get(target.ref) ?? null;
    if (!element?.isConnected) return { stale: true };
  } else {
    try {
      element = document.querySelector(target.selector ?? '');
    } catch {
      return { invalid: true };
    }
    if (!element) return { missing: true };
  }

  // A standalone selector can arrive before any page capture installed the check.
  const inertOf = world.recuedInertOf ??= (node: Element): boolean => {
    for (let at: Element | null = node; at !== null;) {
      if (at.hasAttribute('inert')) return true;
      const frame: Element | null = at.ownerDocument.defaultView?.frameElement ?? null;
      at = at.matches('dialog:modal') ? frame : at.assignedSlot ?? at.parentElement ?? (at.getRootNode() as ShadowRoot).host ?? frame;
    }
    return node.ownerDocument.defaultView?.getComputedStyle(node).getPropertyValue('interactivity') === 'inert';
  };
  if (inertOf(element)) return { inert: true };
  if (!world.recuedValidation) {
    const roots = new WeakSet<Node>();
    const reports = new WeakMap<Element, { event: Event; url: string; message: string }>();
    const observe = (root: Node) => {
      if (roots.has(root)) return;
      roots.add(root);
      root.addEventListener('invalid', event => {
        const field = event.target as ValidationField | null;
        if (!event.isTrusted || !field?.willValidate || !['input', 'select', 'textarea'].includes(field.localName)) return;
        if (field.type === 'password' || field.type === 'hidden'
          || /(^|\s)(current-password|new-password|one-time-code|cc-\S+)(\s|$)/i.test(field.getAttribute('autocomplete') ?? '')) return;
        // Keep the actual report of this field and action in this isolated world.
        reports.set(field, { event, url: field.ownerDocument.URL, message: field.validationMessage.slice(0, 2_000) });
      }, true);
      const clear = (event: Event) => reports.delete(event.target as Element);
      root.addEventListener('input', clear, true);
      root.addEventListener('focusout', clear, true);
    };
    world.recuedValidation = { observe, reports };
    for (const seen of marked?.byRef.values() ?? []) if (seen.isConnected) observe(seen.getRootNode());
  }
  world.recuedValidation.observe(document);
  world.recuedValidation.observe(element.getRootNode());
  const tag = element.localName;
  const field = element as HTMLInputElement;
  const editor = (element as HTMLElement).isContentEditable === true;
  const ROLE_WORDS: Record<string, string> = { textbox: 'text field', searchbox: 'search box', combobox: 'list',
    listbox: 'list', menuitem: 'menu item', menuitemcheckbox: 'menu item', menuitemradio: 'menu item',
    spinbutton: 'number field', treeitem: 'tree item' };
  const INPUT_WORDS: Record<string, string> = { checkbox: 'checkbox', radio: 'radio button', button: 'button',
    submit: 'button', reset: 'button', image: 'button', range: 'slider', number: 'number field',
    search: 'search box', file: 'file picker', password: 'password field' };
  const choice = target.ref === undefined ? undefined : marked?.labelChoices?.get(target.ref);
  const explicit = (element.getAttribute('role') ?? '').trim().split(/\s+/)[0]!;
  // D-335 slice L — a field typed into that suggests as you type is a text field to its owner; a
  // combobox that is no field is a list to choose from.
  const role = choice ? INPUT_WORDS[choice.type]!
    : explicit === 'combobox' && (tag === 'input' || tag === 'textarea') ? 'text field'
    : explicit ? ROLE_WORDS[explicit] ?? explicit
    : (tag === 'a' || tag === 'area') && element.hasAttribute('href') ? 'link'
      : tag === 'button' || tag === 'summary' ? 'button'
        : tag === 'select' ? 'list'
          : tag === 'textarea' ? 'text field'
            : tag === 'input' ? INPUT_WORDS[field.type] ?? 'text field'
              : editor ? 'text editor'
                : tag;

  const words = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  const labelledBy = element.getAttribute('aria-labelledby');
  const labels = 'labels' in element && field.labels ? [...field.labels].map(label => words(label.textContent)).join(' ') : '';
  // An editor's text is what it holds, not what it is called.
  const inner = tag === 'input' || tag === 'select' || tag === 'textarea' || editor ? '' : (element as HTMLElement).innerText;
  const label = (marked?.labelledByName ? marked.labelledByName(element) : undefined)
    || words(element.getAttribute('aria-label'))
    // Slice R — a label inside the same web component, or the same frame, as the element.
    || (!marked?.labelledByName && labelledBy ? labelledBy.split(/\s+/).map(id => words(((element.getRootNode() as Document | ShadowRoot).getElementById?.(id)
      ?? element.ownerDocument.getElementById(id))?.textContent)).join(' ').trim() : '')
    || words(labels)
    || (tag === 'input' && ['button', 'submit', 'reset'].includes(field.type) ? words(field.value) : '')
    || words(element.getAttribute('alt'))
    || words(inner)
    || marked?.svgLabel?.(element)
    || words(element.getAttribute('placeholder'))
    || words(element.getAttribute('aria-placeholder'))
    || words(element.getAttribute('title'))
    || words(element.getAttribute('name'));
  const type = tag === 'input' ? field.type : '';
  const isProtected = type === 'password' || type === 'hidden'
    || /(^|\s)(current-password|new-password|one-time-code|cc-\S+)(\s|$)/i.test(element.getAttribute('autocomplete') ?? '');
  // D-402 slice G (§3.1) — which kind of secret a protected field takes, as the page says it: a sign-in
  // code (`one-time-code`), a card (`cc-*`), else a password. None for a hidden field, which takes none.
  const autocomplete = element.getAttribute('autocomplete') ?? '';
  const protectedKind = !isProtected || type === 'hidden' ? undefined
    : /(^|\s)one-time-code(\s|$)/i.test(autocomplete) ? 'sign-in code'
      : /(^|\s)cc-\S+(\s|$)/i.test(autocomplete) ? 'card' : 'password';
  const cut = (text: string) => text.length > 200 ? `${text.slice(0, 200)}…` : text;
  // D-335 slice W — what finds the element again another day, by the picker's rules
  // (`selector-engine.ts`, passed in as `rules`): its own id or attribute when that alone matches
  // it, else a path up its parents. Only for the page's own document: a selector reaches nothing
  // inside a web component or a frame. None when nothing matches this element alone.
  let stable: string | undefined;
  if (rules != null && element.getRootNode() === document) {
    const generated = rules.generated.map(([source, flags]) => new RegExp(source, flags));
    const looksGenerated = (value: string) => generated.some((pattern) => pattern.test(value));
    const usable = (value: string) => value.length > 0 && value.length <= rules.max_value_chars && !/[\n\r\t]/.test(value)
      && !value.includes('{{');
    const quoted = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const own = (node: Element): string | null => {
      const id = node.id;
      if (id !== '' && !looksGenerated(id) && !id.includes('{{')) {
        if (/^-?[A-Za-z_][\w-]*$/.test(id)) return `#${id}`;
        if (usable(id)) return `${node.localName}[id="${quoted(id)}"]`;
      }
      for (const name of rules.precedence) {
        const value = node.getAttribute(name);
        if (value === null || !usable(value)) continue;
        if (rules.identifier_like.includes(name) && looksGenerated(value)) continue;
        return `${node.localName}[${name}="${quoted(value)}"]`;
      }
      return null;
    };
    const place = (node: Element) => {
      let n = 1;
      for (let sibling = node.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
        if (sibling.localName === node.localName) n += 1;
      }
      return `${node.localName}:nth-of-type(${String(n)})`;
    };
    const only = (selector: string) => {
      try {
        const all = document.querySelectorAll(selector);
        return all.length === 1 && all[0] === element;
      } catch {
        return false;
      }
    };
    const lead = own(element);
    if (lead !== null && only(lead)) {
      stable = lead;
    } else {
      const parts = [lead ?? place(element)];
      let node = element.parentElement;
      for (let depth = 0; ; depth += 1) {
        const path = parts.join(' > ');
        if (only(path)) {
          stable = path;
          break;
        }
        if (node === null || depth >= rules.max_depth) break;
        parts.unshift(own(node) ?? place(node));
        node = node.parentElement;
      }
    }
  }
  // Ordinary actions can prepare their error baseline and form-send facts in
  // the same injection that described this exact element. No page code runs.
  let preparation: { prepared_sends: boolean; prepared_unsent?: string } | undefined;
  if (messages != null) {
    // Keep message visibility identical to pageProblem's post-action read.
    const shown = (item: Element) => item.getAttribute('aria-hidden') !== 'true'
      && (item.checkVisibility({ checkVisibilityCSS: true }) || getComputedStyle(item).display === 'contents');
    const seen = (item: Element) => `${shown(item)
      ? ((item as HTMLElement).innerText ?? item.textContent ?? '').replace(/\s+/g, ' ').trim() : '∅'}`
      + `|${item.getAttribute('aria-invalid') ?? ''}`;
    const notes = new Map<Element, string>();
    for (const item of document.querySelectorAll(messages.candidates)) notes.set(item, seen(item));
    (globalThis as typeof globalThis & { recuedMessageNotes?: Map<Element, string> }).recuedMessageNotes = notes;
    const form = (element as HTMLButtonElement).form ?? element.closest('form');
    const sends = element.isConnected && form !== null
      && element.matches('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]')
      && !element.matches(':disabled');
    preparation = { prepared_sends: sends };
    // :invalid reads native validity without firing the page's invalid handler.
    if (sends && form !== null && !form.noValidate && !element.hasAttribute('formnovalidate')) {
      const invalid = [...form.elements].find(item => item.matches(':invalid')) as HTMLInputElement | undefined;
      if (invalid !== undefined) {
        const name = invalid.getAttribute('aria-label') || invalid.getAttribute('name') || invalid.id || 'a field';
        preparation = { prepared_sends: false,
          prepared_unsent: `The form was not sent: ${name}: ${invalid.validationMessage || 'is not valid'}` };
      }
    }
  }
  return { outputs: { url: location.href, title: cut(document.title), role, label: cut(label), protected: isProtected,
    ...(protectedKind !== undefined ? { protected_kind: protectedKind } : {}),
    ...(stable !== undefined ? { stable_selector: stable } : {}), ...preparation } };
};

/** Why a ref no longer reads: its element has gone from a page still open. In
 *  contracts since 2026-11-04, so a server holding a write can tell it apart
 *  (`isBridgeTargetGone`). */
export const PAGE_CHANGED = BRIDGE_PAGE_CHANGED_MESSAGE;
/** Why a page handle no longer reads: Chrome no longer has its document.
 *  Inspecting the same handle again can only fail again, so the AI is sent to
 *  the tabs for the page's current one (D-335 slice D). */
export const PAGE_GONE = BRIDGE_PAGE_GONE_MESSAGE;

/** A page handle names one Chrome document: `<tab id>:<document id>`. */
export const formatPageHandle = (document: { tab_id: number; document_id: string }): string =>
  `${document.tab_id}:${document.document_id}`;

export const parsePageHandle = (handle: unknown): { tab_id: number; document_id: string } | null => {
  if (typeof handle !== 'string') return null;
  const match = /^(\d{1,10}):([\w-]{1,128})$/.exec(handle);
  if (!match) return null;
  const tab_id = Number(match[1]);
  return Number.isSafeInteger(tab_id) ? { tab_id, document_id: match[2]! } : null;
};

/** D-335 slice T — how many refs of elements the page removed a `reread` keeps: refs are numbered
 *  as first seen, and the oldest go first. */
export const PAGE_REREAD_KEPT_GONE = 200;

/** An inspect command's arguments, or why they cannot be run. A ref is only
 *  meaningful in the document it came from, so it needs that page's handle.
 *
 *  D-335 slice P — the server names how much to read: `max_chars` in all and
 *  `max_value_chars` of one text or value, each a whole number. It keeps the
 *  read it outlines and gives a model only part of it, so it can ask for a
 *  whole page; a command naming neither reads 40,000 and 2,000, the sizes a
 *  server from before passes to a model as they are. Past
 *  {@link BRIDGE_INSPECT_CEILING_CHARS}, an answer would not fit one message to
 *  the server, so a size above it reads that much and is cut there. */
export const readInspectRequest = (args: Record<string, unknown>):
  | { scope: PageInspectScope; page?: { tab_id: number; document_id: string }; limits: PageInspectLimits }
  | { error: string } => {
  const { page, ref, selector, max_chars, max_value_chars } = args;
  if (args.preserve_structure !== undefined && typeof args.preserve_structure !== 'boolean'
    || args.preserve_structure === true && (ref !== undefined || selector !== undefined)) {
    return { error: 'preserve_structure is a boolean for a whole-page read.' };
  }
  if (args.structure_scoped !== undefined && typeof args.structure_scoped !== 'boolean'
    || args.structure_scoped === true && args.preserve_structure !== true) {
    return { error: 'structure_scoped is a boolean for a sibling-preserving read.' };
  }
  const handle = page === undefined ? undefined : parsePageHandle(page);
  if (handle === null) return { error: 'The page handle is not one an inspect answered.' };
  if (ref !== undefined && (typeof ref !== 'string' || !/^e[1-9]\d{0,8}$/.test(ref))) {
    return { error: 'A ref looks like e12.' };
  }
  if (selector !== undefined && (typeof selector !== 'string' || selector.trim() === '')) {
    return { error: 'The selector is empty.' };
  }
  if (ref !== undefined && selector !== undefined) return { error: 'Give a ref or a selector, not both.' };
  if (ref !== undefined && handle === undefined) return { error: 'A ref needs the page it came from.' };
  const size = (value: unknown, otherwise: number): number | undefined => value === undefined ? otherwise
    : Number.isSafeInteger(value) && (value as number) >= 1 ? Math.min(value as number, BRIDGE_INSPECT_CEILING_CHARS) : undefined;
  const limits = { max_chars: size(max_chars, PAGE_INSPECT_LIMITS.max_chars),
    max_value_chars: size(max_value_chars, PAGE_INSPECT_LIMITS.max_value_chars) };
  if (limits.max_chars === undefined || limits.max_value_chars === undefined) {
    return { error: 'max_chars and max_value_chars are whole numbers of characters.' };
  }
  return {
    scope: { ...(ref !== undefined ? { ref: ref as string } : {}), ...(selector !== undefined ? { selector: selector as string } : {}) },
    ...(handle !== undefined ? { page: handle } : {}),
    limits: { max_chars: limits.max_chars, max_value_chars: limits.max_value_chars },
  };
};

/** A command on one element (`describe`, and `fill` or `click` by page):
 *  inspect's arguments, naming the element by a ref or a selector. */
export const readElementRequest = (args: Record<string, unknown>):
  | { scope: PageInspectScope; page?: { tab_id: number; document_id: string }; limits: PageInspectLimits }
  | { error: string } => {
  const request = readInspectRequest(args);
  if ('error' in request) return request;
  if (request.scope.ref === undefined && request.scope.selector === undefined) {
    return { error: 'Name the element: a ref or a selector.' };
  }
  return request;
};

/** Translate a page read's answer from one document. It must be exactly one
 *  known key, and its outputs exactly what the function writes, of the types
 *  it writes: anything else proves nothing. On the ordinary path `pattern` is
 *  the grant the command ran under, and a document that has moved off it since
 *  the tab was found is not answered. */
const pageReadOutcome = (
  answer: unknown,
  document: { tab_id: number; document_id: string },
  options: { pattern?: string; blockedMessage: string },
  shape: Record<string, 'string' | 'boolean' | 'number'>,
  /** Keys an answer may hold beside the shape's, of these types. */
  optional: Record<string, 'string' | 'boolean' | 'number'> = {},
): ActionExecutorOutcome => {
  const error = (code: BridgeErrorCode, message: string): ActionExecutorOutcome =>
    ({ status: 'error', error: { code, message } });
  const unproven = error('unknown', 'bridge: no readable answer from the page');
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.keys(answer).length !== 1) return unproven;
  const reply = answer as Record<string, unknown>;
  if (reply.blocked === true) return error('tab_navigation_blocked', options.blockedMessage);
  if (reply.missing === true) return error('selector_not_found', 'No element on the page matches the selector.');
  if (reply.invalid === true) return error('selector_not_found', 'The selector is not valid CSS.');
  if (reply.stale === true) return error('selector_not_found', PAGE_CHANGED);
  if (reply.inert === true) return error('selector_not_found', 'The element is in an inactive (inert) part of the page.');
  const outputs = reply.outputs as Record<string, unknown> | undefined;
  if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs)
    || Object.keys(outputs).filter((key) => !(key in optional)).sort().join() !== Object.keys(shape).sort().join()
    || Object.entries(shape).some(([key, type]) => typeof outputs[key] !== type)
    || Object.entries(optional).some(([key, type]) => key in outputs && typeof outputs[key] !== type)) return unproven;
  if (options.pattern !== undefined && !isPatternWithinGrantedOrigins(outputs.url as string, [options.pattern])) {
    return error('tab_navigation_blocked', 'The page is no longer on a site this step may read.');
  }
  return { status: 'ok', outputs: { page: formatPageHandle(document), ...outputs } };
};

/** `inspectPage`'s answer from one document (see `pageReadOutcome`). */
export const inspectOutcome = (
  answer: unknown,
  document: { tab_id: number; document_id: string },
  options: { pattern?: string; blockedMessage: string },
): ActionExecutorOutcome => {
  const outcome = pageReadOutcome(answer, document, options,
    { url: 'string', title: 'string', html: 'string', truncated: 'boolean' },
    { loading: 'boolean', structure_complete: 'boolean', structure_root: 'string', structure_scoped: 'boolean', selector_matches: 'number', selected_index: 'number' });
  if (outcome.status === 'ok' && outcome.outputs && (outcome.outputs.selector_matches !== undefined || outcome.outputs.selected_index !== undefined)
    && (!Number.isSafeInteger(outcome.outputs.selector_matches) || Number(outcome.outputs.selector_matches) < 1
      || !Number.isSafeInteger(outcome.outputs.selected_index) || Number(outcome.outputs.selected_index) < 1
      || Number(outcome.outputs.selected_index) > Number(outcome.outputs.selector_matches))) return { status: 'error', error: { code: 'unknown', message: 'bridge: invalid selector selection evidence' } };
  return outcome;
};

/** `describePageElement`'s answer from one document (see `pageReadOutcome`). */
export const describeOutcome = (
  answer: unknown,
  document: { tab_id: number; document_id: string },
  options: { pattern?: string; blockedMessage: string },
): ActionExecutorOutcome => pageReadOutcome(answer, document, options,
  { url: 'string', title: 'string', role: 'string', label: 'string', protected: 'boolean' },
  // Slice W — when the executor asked for it.
  { stable_selector: 'string', prepared_sends: 'boolean', prepared_unsent: 'string', protected_kind: 'string' });

/** The `executeInDocument` of `BridgeBrowserApi` over chrome.scripting, which
 *  the extension and the real-Chrome fixture both use. Chrome refuses a
 *  `document_id` that has gone; without one it runs in the tab's top document.
 *  `frame_id` is 0 for a tab's top document (slice R). */
export const executeInChromeDocument = (scripting: DocumentScripting) => async (
  target: { tab_id: number; document_id?: string },
  func: (...args: any[]) => unknown,
  args: readonly unknown[],
  options?: { immediate?: boolean },
): Promise<{ document_id: string; result: unknown; frame_id?: number } | null> => {
  const results = await scripting.executeScript({
    target: { tabId: target.tab_id, ...(target.document_id !== undefined ? { documentIds: [target.document_id] } : {}) },
    ...(options?.immediate ? { injectImmediately: true } : {}),
    func,
    args,
  });
  const first = results[0];
  return first && typeof first.documentId === 'string'
    ? { document_id: first.documentId, result: first.result, ...(typeof first.frameId === 'number' ? { frame_id: first.frameId } : {}) }
    : null;
};

/** D-335 slice R — how long a tab's frames are waited for. A frame still loading answers as soon as
 *  it can; past this, the frames from another site are named as ones the Bridge cannot read. */
export const PAGE_FRAMES_WAIT_MS = 2_000;

type FrameSlot = { element: HTMLIFrameElement; child: Window; src: string };
type FrameObservationWorld = typeof globalThis & {
  recuedFrameObservation?: { id: string; url: string; slots: Map<string, FrameSlot> };
};

/** Recheck the original iframe elements after collecting the document IDs. Injected in the
 * same document that inspected them. A removed, moved or retargeted iframe stays unread. */
export const verifyFrameObservation = (id: string): string[] => {
  const seen = (globalThis as FrameObservationWorld).recuedFrameObservation;
  if (seen?.id !== id || seen.url !== location.href || document.documentElement.hasAttribute('data-recued-owner-surface')) return [];
  const verified: string[] = [];
  for (const [path, { element, child, src }] of seen.slots) {
    if (!element.isConnected || element.src !== src || element.contentWindow !== child) continue;
    let at: Window | null | undefined = window.top;
    for (const index of path.split('.').slice(1)) at = at?.frames[Number(index)];
    if (at === child) verified.push(path);
  }
  return verified;
};

/** The live address and Chrome-issued identity at a slot in this tab's frame tree. */
export interface PageFrame {
  frame_id: number;
  document_id: string;
  url: string;
  path: string;
}

/** Each frame's own answer to `listChromeFrames`: its address and where it is, nothing it holds,
 *  since a frame on a site the owner listed answers too. Injected, so self-contained. */
export const describePageFrame = (): { url: string; path?: string; owner: boolean } => {
  const indices: number[] = [];
  let at: Window = window;
  const top = window.top;
  while (at !== top && indices.length < 32) {
    const parent = at.parent;
    let index = 0;
    const length = Math.min(parent.length, 4_096);
    while (index < length && parent.frames[index] !== at) index++;
    if (index === length) break;
    indices.push(index);
    at = parent;
  }
  return { url: location.href, ...(at === top ? { path: ['0', ...indices.reverse()].join('.') } : {}),
    owner: document.documentElement?.hasAttribute('data-recued-owner-surface') === true };
};

/** Chrome asks every frame it has a site permission for and leaves out the rest.
 *  Include the top document so the inspected document's ancestry can be checked.
 *  Rejects past {@link PAGE_FRAMES_WAIT_MS}. */
export const listChromeFrames = (scripting: DocumentScripting) => async (tab_id: number): Promise<PageFrame[]> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const results = await Promise.race([
    scripting.executeScript({ target: { tabId: tab_id, allFrames: true }, func: describePageFrame, args: [],
      injectImmediately: true }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('the frames did not answer in time')), PAGE_FRAMES_WAIT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  return results.flatMap((entry) => {
    const answer = entry.result as ReturnType<typeof describePageFrame> | undefined;
    return typeof entry.frameId === 'number' && typeof entry.documentId === 'string'
      && answer && typeof answer.url === 'string' && typeof answer.path === 'string' && /^0(?:\.\d+){0,32}$/.test(answer.path)
      && (entry.frameId === 0) === (answer.path === '0') && answer.owner === false
      ? [{ frame_id: entry.frameId, document_id: entry.documentId, url: answer.url, path: answer.path }] : [];
  });
};

export const frameObservationId = (html: string): string | undefined =>
  / data-recued-frame="([a-f0-9]{16}):/.exec(html)?.[1];

/** Assign only documents in the verified iframe slots beneath the inspected document. Ambiguous
 *  slots and ungranted or blocked ancestors cannot name a page. Reviewed reads pass no listing. */
export const settleFrames = (html: string, tab_id: number, frames: readonly PageFrame[] | null,
  blocked: (url: string) => boolean,
  observation?: { id: string; document_id: string; url: string; paths: readonly string[] },
): string => {
  const NAMED = /<(iframe|frame)((?: [\w-]+="[^"]*")*) data-recued-frame="([a-f0-9]+):([\d.]+|-)"><\/\1>/g;
  if (!html.includes('data-recued-frame="')) return html;
  const unescape = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const address = (url: string) => {
    try {
      const parsed = new URL(url);
      return ['https:', 'http:'].includes(parsed.protocol) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };
  const byPath = new Map<string, PageFrame | undefined>();
  for (const frame of frames ?? []) byPath.set(frame.path, byPath.has(frame.path) ? undefined : frame);
  const source = observation && (frames ?? []).find(frame => frame.document_id === observation.document_id && frame.url === observation.url);
  const verified = new Set(observation?.paths);
  return html.replace(NAMED, (_match, tag: string, attributes: string, id: string, path: string) => {
    const unread = `<${tag}${attributes} unread=""></${tag}>`;
    if (id !== observation?.id || !source || byPath.get(source.path) !== source
      || !path.startsWith(source.path + '.') || !verified.has(path)) return unread;
    const frame = byPath.get(path);
    const src = address(unescape(/ src="([^"]*)"/.exec(attributes)?.[1] ?? ''));
    if (!frame || !src || address(frame.url)?.origin !== src.origin || blocked(src.href)) return unread;
    let branch = '';
    for (const part of path.split('.')) {
      branch = branch === '' ? part : branch + '.' + part;
      const ancestor = byPath.get(branch);
      if (!ancestor || blocked(ancestor.url)) return unread;
    }
    return `<${tag}${attributes} page="${formatPageHandle({ tab_id, document_id: frame.document_id })}"></${tag}>`;
  });
};
