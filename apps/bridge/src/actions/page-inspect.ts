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

/** What to read: the whole page, one element inspect marked, or one by CSS. */
export interface PageInspectScope {
  ref?: string;
  selector?: string;
}

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
  | { outputs: { url: string; title: string; html: string; truncated: boolean } }
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
 *    objects, SVG drawing data (the `<svg>` stays, empty), comments, and every
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
 *  `reread` keeps ({@link PAGE_REREAD_KEPT_GONE}); an inspection keeps none. */
export const inspectPage = (
  scope: PageInspectScope,
  limits: PageInspectLimits,
  expectedUrl?: string | null,
  keepGone = 0,
): PageInspectAnswer => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };

  // The ref map, kept in this document's isolated world for the next command.
  // D-347 follow-up 17 — and what each element with a ref showed at the read that last wrote it (`seen`),
  // with how that is taken (`print`), so a step by the ref can tell whether the page has since drawn
  // something else into it (`page-rebind.ts`).
  type Print = Record<string, string>;
  type RefMap = { next: number; byRef: Map<string, Element>; byElement: WeakMap<Element, string>;
    seen?: WeakMap<Element, Print>; print?: (element: Element) => Print };
  const world = globalThis as typeof globalThis & { recuedPageRefs?: RefMap };
  const refs: RefMap = world.recuedPageRefs ??= { next: 1, byRef: new Map(), byElement: new WeakMap() };
  // An element the page removed loses its ref, here and in the HTML to come. Slice T: a re-read the
  // server makes after an action keeps the latest of them, so a ref read before the action is still
  // found again where the page drew its element anew (slice M).
  const gone = [...refs.byRef].filter(([, element]) => !element.isConnected);
  for (const [ref, element] of gone.slice(0, Math.max(0, gone.length - keepGone))) {
    refs.byRef.delete(ref);
    refs.byElement.delete(element);
  }

  let root: Element | null;
  if (scope.ref !== undefined) {
    root = refs.byRef.get(scope.ref) ?? null;
    if (!root) return { stale: true };
  } else if (scope.selector !== undefined) {
    try {
      root = document.querySelector(scope.selector);
    } catch {
      return { invalid: true };
    }
    if (!root) return { missing: true };
  } else {
    root = document.body ?? document.documentElement;
  }

  const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'object', 'embed', 'link', 'meta', 'base', 'head']);
  const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'source', 'track', 'wbr']);
  // `value`, `checked`, `selected` and `disabled` are written from the live element below.
  // Slice U — and `aria-modal`, so the server can say a dialog that blocks the page is open.
  const KEPT = ['id', 'name', 'type', 'role', 'href', 'alt', 'title', 'placeholder', 'for', 'aria-label',
    'data-testid', 'contenteditable', 'aria-expanded', 'aria-checked', 'aria-selected', 'aria-modal'];
  const ACTIONABLE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'textbox', 'searchbox', 'combobox', 'slider',
    'spinbutton', 'treeitem']);
  const PROTECTED = /(^|\s)(current-password|new-password|one-time-code|cc-\S+)(\s|$)/i;

  const cut = (text: string) => text.length > limits.max_value_chars
    ? `${text.slice(0, limits.max_value_chars)}…` : text;
  const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attribute = (name: string, value: string) => ` ${name}="${escapeText(cut(value)).replace(/"/g, '&quot;')}"`;

  const shown = (element: Element) => element.getAttribute('aria-hidden') !== 'true'
    && (element.checkVisibility({ checkVisibilityCSS: true })
      // `display: contents` draws no box of its own, though its children are drawn. A frame's
      // element is styled by its own window.
      || (element.ownerDocument.defaultView ?? window).getComputedStyle(element).display === 'contents');
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
  /** What a person sees inside an element, in order: a component's shadow root in place of its
   *  own children, and in a slot the page's content it shows, else the slot's own. */
  const childrenOf = (element: Element): Node[] => {
    if (element.localName === 'slot') {
      const assigned = (element as HTMLSlotElement).assignedNodes({ flatten: true });
      return assigned.length > 0 ? assigned : [...element.childNodes];
    }
    return [...(shadowOf(element) ?? element).childNodes];
  };
  /** Frames from another site, numbered in the order they are met. */
  let otherSiteFrames = 0;
  const isProtected = (element: Element) => {
    const type = element.localName === 'input' ? (element as HTMLInputElement).type : '';
    return type === 'password' || type === 'hidden' || PROTECTED.test(element.getAttribute('autocomplete') ?? '');
  };
  const actionable = (element: Element) => {
    const tag = element.localName;
    if (tag === 'a') return element.hasAttribute('href');
    if (['button', 'input', 'select', 'textarea', 'summary'].includes(tag)) return true;
    // An editor's own paragraphs are part of it; only the editor takes a ref.
    if ((element as HTMLElement).isContentEditable) return !element.parentElement?.isContentEditable;
    if (ACTIONABLE_ROLES.has((element.getAttribute('role') ?? '').trim().split(/\s+/)[0]!)) return true;
    const tabindex = element.getAttribute('tabindex');
    return tabindex !== null && tabindex.trim() !== '' && Number(tabindex) >= 0;
  };
  /** D-347 follow-up 17 — what an element shows, as a step by its ref holds it to: its own words and
   *  attributes, and the row it sits in (a list item, a table row, an article) with the addresses that
   *  row's links lead to. `shows` and `in` are what a refusal quotes, never compared. */
  const ROW = 'li, tr, [role="row"], [role="listitem"], [role="option"], [role="article"], article';
  const said = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  const printOf = (element: Element): Print => {
    const form = (element as HTMLInputElement).form ?? element.closest('form');
    const row = element.parentElement?.closest(ROW) ?? null;
    // A field's text is what it holds, which typing changes.
    const text = element.matches('input, textarea, select') ? '' : said(element.textContent).slice(0, 200);
    const label = said(element.getAttribute('aria-label'));
    const title = said(element.getAttribute('title'));
    const placeholder = said(element.getAttribute('placeholder'));
    const rowText = row === null ? '' : said(row.textContent).slice(0, 300);
    return {
      tag: element.localName, type: said(element.getAttribute('type')).toLowerCase(), name: element.getAttribute('name') ?? '',
      role: said(element.getAttribute('role')).toLowerCase(), label: label.toLowerCase(), placeholder: placeholder.toLowerCase(),
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
  const refOf = (element: Element) => {
    let ref = refs.byElement.get(element);
    if (ref === undefined) {
      ref = `e${refs.next++}`;
      refs.byElement.set(element, ref);
      refs.byRef.set(ref, element);
    }
    return ref;
  };
  const openTag = (element: Element) => {
    const tag = element.localName;
    let text = `<${tag}`;
    if (actionable(element)) {
      text += ` ref="${refOf(element)}"`;
      refs.seen!.set(element, printOf(element));
    }
    for (const name of KEPT) {
      const value = element.getAttribute(name);
      if (value !== null) text += attribute(name, value);
    }
    const names = [...element.classList].filter(name => name.length >= 3 && !/[\d:[]/.test(name)).slice(0, 3);
    if (names.length > 0) text += attribute('class', names.join(' '));
    if (element.hasAttribute('disabled')) text += ' disabled';
    // Slice U — a dialog shown as a modal one: nothing behind it can be used until it closes.
    if (tag === 'dialog' && element.matches(':modal')) text += ' modal';
    if (tag === 'input') {
      const field = element as HTMLInputElement;
      if (field.type === 'checkbox' || field.type === 'radio') {
        if (field.checked) text += ' checked';
      } else if (field.type !== 'file' && !isProtected(element) && field.value !== '') {
        text += attribute('value', field.value);
      }
    }
    return `${text}>`;
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
    let open = '<iframe';
    const src = typeof element.src === 'string' ? element.src : '';
    if (/^https?:/i.test(src)) open += attribute('src', src);
    const title = element.getAttribute('title') ?? element.getAttribute('name');
    if (title) open += attribute('title', title);
    if (inner !== null) {
      if (inner.documentElement?.hasAttribute('data-recued-owner-surface')) return;
      const body = inner.body ?? inner.documentElement;
      const close = '</iframe>';
      if (!fits(`${open}>${close}`)) {
        truncated = true;
        return;
      }
      const mark = out.length;
      write(`${open}>`);
      owed += close.length;
      if (body) walk(body);
      owed -= close.length;
      if (truncated && out.length === mark + 1) {
        out.length = mark;
        length -= open.length + 1;
        return;
      }
      write(close);
      return;
    }
    otherSiteFrames += 1;
    const named = `${open}${attribute('data-recued-frame', String(otherSiteFrames))}></iframe>`;
    if (fits(named)) write(named);
    else truncated = true;
  };

  const walk = (node: Node): void => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue ?? '';
      if (raw.trim() === '') return;
      const text = escapeText(cut(preformatted > 0 ? raw : raw.replace(/\s+/g, ' ')));
      if (fits(text)) write(text);
      else truncated = true;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const tag = element.localName;
    // A slot is where a component shows the page's content: what it shows is read in its place.
    if (tag === 'slot') {
      if (shown(element)) for (const child of childrenOf(element)) walk(child);
      return;
    }
    if (SKIPPED.has(tag) || !shown(element)) return;
    if (tag === 'iframe' || tag === 'frame') {
      frame(element as HTMLIFrameElement);
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
      // A closed list draws no options, but they are what a person can choose.
      for (const option of [...(element as HTMLSelectElement).options]) {
        const label = option.text.trim();
        let piece = '<option';
        if (option.value !== label) piece += attribute('value', option.value);
        if (option.selected && !isProtected(element)) piece += ' selected';
        piece += `>${escapeText(cut(label))}</option>`;
        if (!fits(piece)) {
          truncated = true;
          break;
        }
        write(piece);
      }
    } else if (tag !== 'svg' && !VOID.has(tag)) {
      if (tag === 'pre') preformatted++;
      for (const child of childrenOf(element)) walk(child);
      if (tag === 'pre') preformatted--;
    }
    owed -= close.length;
    if (truncated && out.length === mark + 1) {
      // Nothing inside it fitted: the cut falls before the element, not
      // after an empty copy of it.
      out.length = mark;
      length -= open.length;
      return;
    }
    write(close);
  };
  walk(root);

  return { outputs: { url: location.href, title: cut(document.title), html: out.join(''), truncated } };
};

/** Exactly one key, as `inspectPage` answers. */
export type PageDescribeAnswer =
  | { outputs: { url: string; title: string; role: string; label: string; protected: boolean; stable_selector?: string } }
  | { missing: true }
  | { invalid: true }
  | { stale: true }
  | { blocked: true };

/** D-335 slice B — one element as a person would name it: what kind of thing
 *  it is (`button`, `link`, `text field`…) and its label, read from the page
 *  itself, never from what a model called it. An ask for a write shows this,
 *  and a write by ref reads it first to know its page and element are still
 *  there before anything is typed or clicked. `protected` marks a password,
 *  sign-in code or card field. Injected, so self-contained. */
export const describePageElement = (target: PageInspectScope, expectedUrl?: string | null,
  rules?: SelectorRules | null): PageDescribeAnswer => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };
  const marked = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } }).recuedPageRefs;
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

  const tag = element.localName;
  const field = element as HTMLInputElement;
  const editor = (element as HTMLElement).isContentEditable === true;
  const ROLE_WORDS: Record<string, string> = { textbox: 'text field', searchbox: 'search box', combobox: 'list',
    listbox: 'list', menuitem: 'menu item', menuitemcheckbox: 'menu item', menuitemradio: 'menu item',
    spinbutton: 'number field', treeitem: 'tree item' };
  const INPUT_WORDS: Record<string, string> = { checkbox: 'checkbox', radio: 'radio button', button: 'button',
    submit: 'button', reset: 'button', image: 'button', range: 'slider', number: 'number field',
    search: 'search box', file: 'file picker', password: 'password field' };
  const explicit = (element.getAttribute('role') ?? '').trim().split(/\s+/)[0]!;
  // D-335 slice L — a field typed into that suggests as you type is a text field to its owner; a
  // combobox that is no field is a list to choose from.
  const role = explicit === 'combobox' && (tag === 'input' || tag === 'textarea') ? 'text field'
    : explicit ? ROLE_WORDS[explicit] ?? explicit
    : tag === 'a' && element.hasAttribute('href') ? 'link'
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
  const label = words(element.getAttribute('aria-label'))
    // Slice R — a label inside the same web component, or the same frame, as the element.
    || (labelledBy ? labelledBy.split(/\s+/).map(id => words(((element.getRootNode() as Document | ShadowRoot).getElementById?.(id)
      ?? element.ownerDocument.getElementById(id))?.textContent)).join(' ').trim() : '')
    || words(labels)
    || (tag === 'input' && ['button', 'submit', 'reset'].includes(field.type) ? words(field.value) : '')
    || words(element.getAttribute('alt'))
    || words(inner)
    || words(element.getAttribute('placeholder'))
    || words(element.getAttribute('aria-placeholder'))
    || words(element.getAttribute('title'))
    || words(element.getAttribute('name'));
  const type = tag === 'input' ? field.type : '';
  const isProtected = type === 'password' || type === 'hidden'
    || /(^|\s)(current-password|new-password|one-time-code|cc-\S+)(\s|$)/i.test(element.getAttribute('autocomplete') ?? '');
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
  return { outputs: { url: location.href, title: cut(document.title), role, label: cut(label), protected: isProtected,
    ...(stable !== undefined ? { stable_selector: stable } : {}) } };
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
  shape: Record<string, 'string' | 'boolean'>,
  /** Keys an answer may hold beside the shape's, of these types. */
  optional: Record<string, 'string'> = {},
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
): ActionExecutorOutcome => pageReadOutcome(answer, document, options,
  { url: 'string', title: 'string', html: 'string', truncated: 'boolean' });

/** `describePageElement`'s answer from one document (see `pageReadOutcome`). */
export const describeOutcome = (
  answer: unknown,
  document: { tab_id: number; document_id: string },
  options: { pattern?: string; blockedMessage: string },
): ActionExecutorOutcome => pageReadOutcome(answer, document, options,
  { url: 'string', title: 'string', role: 'string', label: 'string', protected: 'boolean' },
  // Slice W — when the executor asked for it.
  { stable_selector: 'string' });

/** The `executeInDocument` of `BridgeBrowserApi` over chrome.scripting, which
 *  the extension and the real-Chrome fixture both use. Chrome refuses a
 *  `document_id` that has gone; without one it runs in the tab's top document.
 *  `frame_id` is 0 for a tab's top document (slice R). */
export const executeInChromeDocument = (scripting: DocumentScripting) => async (
  target: { tab_id: number; document_id?: string },
  func: (...args: any[]) => unknown,
  args: readonly unknown[],
): Promise<{ document_id: string; result: unknown; frame_id?: number } | null> => {
  const results = await scripting.executeScript({
    target: { tabId: target.tab_id, ...(target.document_id !== undefined ? { documentIds: [target.document_id] } : {}) },
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

/** D-335 slice R — a frame of a tab that a script of the Bridge may read: its document and address,
 *  and whether the tab's page holds it directly. */
export interface PageFrame {
  frame_id: number;
  document_id: string;
  url: string;
  /** In the tab's top page itself, not in a frame of a frame. */
  in_top: boolean;
}

/** Each frame's own answer to `listChromeFrames`: its address and where it is, nothing it holds,
 *  since a frame on a site the owner listed answers too. Injected, so self-contained. */
export const describePageFrame = (): { url: string; in_top: boolean; owner: boolean } => ({
  url: location.href,
  in_top: window.parent === window.top,
  owner: document.documentElement?.hasAttribute('data-recued-owner-surface') === true,
});

/** D-335 slice R — the frames of a tab the Bridge may read, besides its top page: Chrome asks every
 *  frame it has a site permission for and leaves out the rest, and the owner's client is never one.
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
    return typeof entry.frameId === 'number' && entry.frameId !== 0 && typeof entry.documentId === 'string'
      && answer && typeof answer.url === 'string' && answer.owner !== true
      ? [{ frame_id: entry.frameId, document_id: entry.documentId, url: answer.url, in_top: answer.in_top === true }] : [];
  });
};

/** D-335 slice R — the frames from another site an inspection named (`<iframe data-recued-frame="N">`),
 *  each given the page handle of the frame it shows, or marked one the Bridge cannot read. A frame
 *  is the first of the tab's top page's own frames, not taken yet, at the same address, else on the
 *  same site; one on a site the owner blocked, or that matches none (no permission for its site,
 *  or a frame whose own frames are not listed), is `unread`. `frames` is null where frames are not
 *  looked for: a document that is itself a frame, or a run reviewed before it starts. */
export const settleFrames = (html: string, tab_id: number, frames: readonly PageFrame[] | null,
  blocked: (url: string) => boolean): string => {
  const NAMED = /<iframe((?: [\w-]+="[^"]*")*) data-recued-frame="\d+"><\/iframe>/g;
  if (!html.includes('data-recued-frame="')) return html;
  const unescape = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const origin = (url: string) => {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  };
  const open = (frames ?? []).filter((frame) => frame.in_top && !blocked(frame.url));
  const taken = new Set<PageFrame>();
  const pick = (src: string, same: (frame: PageFrame) => boolean) => {
    const frame = open.find((candidate) => !taken.has(candidate) && same(candidate));
    if (frame !== undefined) taken.add(frame);
    return frame;
  };
  const named = [...html.matchAll(NAMED)].map((match) => {
    const src = unescape(/ src="([^"]*)"/.exec(match[1]!)?.[1] ?? '');
    return { attributes: match[1]!, src };
  });
  // Exact addresses first, so one frame on a site does not take another's place.
  const chosen = named.map(({ src }) => (src === '' ? undefined : pick(src, (frame) => frame.url === src)));
  named.forEach(({ src }, i) => {
    if (chosen[i] === undefined && src !== '') chosen[i] = pick(src, (frame) => origin(frame.url) === origin(src));
  });
  let at = 0;
  return html.replace(NAMED, (_match, attributes: string) => {
    const frame = chosen[at];
    at += 1;
    return frame === undefined ? `<iframe${attributes} unread=""></iframe>`
      : `<iframe${attributes} page="${String(tab_id)}:${frame.document_id}"></iframe>`;
  });
};
