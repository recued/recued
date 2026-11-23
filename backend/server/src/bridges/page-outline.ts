/** D-335 slice O — a page read as an outline, made on the server from the cleaned HTML the
 *  Bridge already answers (`apps/bridge/src/actions/page-inspect.ts`), so every Bridge since
 *  0.0.3 gives it and none needs an update.
 *
 *  Why: markup, not text, is most of a read. Wikipedia's Ada Lovelace article is 70,000
 *  characters of text and 397,000 of cleaned HTML; the 40,000 the Bridge sends hold one word like
 *  "Daguerreotype" in about 90 characters of tags and attributes. A model reading that pays for
 *  every character, and the measured search task spent about 52 s of its 156 s on the round that
 *  read one such page. As an outline the same 40,000 characters are 4,000 to 10,000 (7.3× smaller
 *  over 8 sites, measured 2026-11-05), with every answer the measured tasks needed still in it.
 *
 *  The outline is one line per block of text, in page order:
 *  - a heading starts with `#`s, a list item with `- `, a table row is its cells joined by ` | `;
 *  - what a person can act on is `[its label](eN)`, its ref from the Bridge, so a click or typing
 *    still names it; a form field says what kind it is, its label and its current value;
 *  - a line's text is cut at {@link PAGE_OUTLINE_LINE_CHARS}, in its middle: its start and its end
 *    show, `…` where the rest was, and a cut line ends `…(b12)`: the server keeps the read
 *    ({@link PageReadStore}), so `block: "b12"` answers the whole line, refs and all, and `find`
 *    answers every line that holds some text, without asking the Bridge again.
 *
 *  The HTML is parsed here, not by a library: the Bridge writes a small, strict grammar (its own
 *  tags, a closed list of attributes, every text and value escaped, every element closed, even on
 *  a page it cut), and a parser for exactly that grammar needs no dependency. */

import { createHash } from 'node:crypto';
import type { BrowserControlEvidence } from '@recued/contracts';
import { browserControlScope } from './browser-control-scope.js';
import { browserDataEntries, type BrowserEntrySnapshot } from './browser-data-entries.js';
import { browserReadRanges, type BrowserReadRange } from './browser-entry-view.js';
import { browserTableHeaders } from './browser-table-headers.js';

/** How much of a line's text the outline shows before cutting it. */
export const PAGE_OUTLINE_LINE_CHARS = 100;
/** 2026-11-22 (the owner: "build the 'show the blocker' version") — how the outline's first line ends when what is on top
 *  of the page is something the page marks hidden and that is no dialog (`data-recued-cover`): an ad's full-screen layer,
 *  one with a countdown before its Close button shows. ⚠ Model-facing — see `chat-prompt-optimization-log.md`. */
export const PAGE_COVER_NOTE_TAIL = 'Nothing behind it can be read or used until it goes: close it if it shows how, or wait if '
  + 'it says when.';
/** How that first line starts, for a later answer to tell that the model was shown it. */
export const PAGE_COVER_NOTE_START = '(Something covers this page';
/** Whether a page's address shows a Google vignette ad over it (`PAGE_COVERED_BY_AD_NOTE`, dom-adapter.ts). Its cover is
 *  then named by that note, which says how to close it, and not by the outline's (2026-11-22, the owner: "do the two
 *  followups"): two notes with different advice cost turns on bench task ZV. */
export const pageCoveredByAd = (url: string): boolean => {
  try { return new URL(url).hash === '#google_vignette'; } catch { return false; }
};
/** D-335 slice AU — of a cut line, the share its start keeps; its end keeps the rest. The owner, on a
 *  quote's author cut from its line: "Cut in the middle". The end of a line is where its author, its
 *  price, its date or its last link stands, and a line cut at its end lost exactly that: task G with
 *  thinking off named the wrong authors in both runs, five of ten quotes on its first page having
 *  lost theirs. */
export const PAGE_OUTLINE_LINE_HEAD_SHARE = 0.6;
/** D-335 slice P — how much of an outline one answer shows. The server reads a whole page and
 *  keeps it; a model gets it in parts of this size, each naming the line the next starts at. */
export const PAGE_OUTLINE_PART_CHARS = 12_000;
/** How long a page's read is kept for `block` and `find` after it was last used. */
export const PAGE_READ_TTL_MS = 30 * 60_000;
/** How many pages' reads are kept at once; past it the least recently used goes first. */
export const PAGE_READ_MAX_PAGES = 64;
/** How many lines `find` answers at most, and how much of each long line around the text found. */
export const PAGE_FIND_MAX_LINES = 20;
export const PAGE_FIND_LINE_CHARS = 300;
/** D-335 slice Q — how much of a page's text one answer shows: denser than an outline, and read to
 *  the end more often. */
export const PAGE_TEXT_PART_CHARS = 16_000;
/** D-335 slice V — the largest part one answer may ask for (`chars` on `core.dom.inspect`): Ask a
 *  web page sends a part to a separate model, which can take more than a model reading a page
 *  round by round should carry in its context. */
export const PAGE_PART_MAX_CHARS = 60_000;
/** A heading search includes its whole section within one ordinary outline part. */
export const PAGE_FIND_SECTIONS = 3;

export interface OutlineElement {
  kind: 'element';
  tag: string;
  attrs: Record<string, string | true>;
  children: OutlineNode[];
  /** An empty sibling retained only for positional collection, never page evidence. */
  structuralOnly?: true;
  /** This branch's rendered children differ from its original DOM structure. */
  structuralIncomplete?: true;
}
export interface OutlineText {
  kind: 'text';
  text: string;
}
export type OutlineNode = OutlineElement | OutlineText;

/** The elements the Bridge writes without a closing tag (`page-inspect.ts` `VOID`). */
const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'source', 'track', 'wbr', 'link', 'meta', 'base']);
const TAG = /<(\/?)([A-Za-z][\w.:-]*)((?:\s+[\w:.-]+(?:="[^"]*")?)*)\s*\/?>/y;
const ATTRIBUTE = /\s+([\w:.-]+)(?:="([^"]*)")?/g;

/** The Bridge escapes `&`, `<` and `>` in text, and `"` as well in an attribute. */
const unescape = (text: string): string =>
  text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The Bridge's cleaned HTML as a tree. Tolerant of what the grammar never writes: a `<` that
 *  opens no tag is text, and a closing tag closes whatever it names, or nothing. */
export const parseInspectHtml = (html: string, preserveStructure = false): OutlineElement => {
  const root: OutlineElement = { kind: 'element', tag: '#root', attrs: {}, children: [] };
  const open: OutlineElement[] = [root];
  const top = () => open[open.length - 1]!;
  const text = (raw: string) => {
    if (raw === '') return;
    const children = top().children;
    const last = children[children.length - 1];
    if (last?.kind === 'text') last.text += unescape(raw);
    else children.push({ kind: 'text', text: unescape(raw) });
  };
  let at = 0, hasStructural = false;
  while (at < html.length) {
    const lt = html.indexOf('<', at);
    if (lt === -1) {
      text(html.slice(at));
      break;
    }
    text(html.slice(at, lt));
    TAG.lastIndex = lt;
    const match = TAG.exec(html);
    if (!match) {
      text('<');
      at = lt + 1;
      continue;
    }
    at = TAG.lastIndex;
    const [, closing, name, attributes] = match;
    const tag = name!.toLowerCase();
    if (closing === '/') {
      let index = open.length - 1;
      while (index > 0 && open[index]!.tag !== tag) index -= 1;
      if (index > 0) open.length = index;
      continue;
    }
    const attrs: Record<string, string | true> = {};
    for (const [, key, value] of attributes!.matchAll(ATTRIBUTE)) attrs[key!.toLowerCase()] = value === undefined ? true : unescape(value);
    if (Object.hasOwn(attrs, 'data-recued-structural-only')) hasStructural = true;
    const incomplete = Object.hasOwn(attrs, 'data-recued-structure-incomplete');
    delete attrs['data-recued-structure-incomplete'];
    const element: OutlineElement = { kind: 'element', tag, attrs, children: [],
      ...(preserveStructure && incomplete ? { structuralIncomplete: true } : {}) };
    top().children.push(element);
    if (!VOID.has(tag)) open.push(element);
  }
  // Parse closing tags normally first, so dropping a placeholder cannot close
  // its same-tag parent or expose anything inside a malformed placeholder.
  const pending = hasStructural ? [root] : [];
  while (pending.length) {
    const parent = pending.pop()!;
    parent.children = parent.children.filter(child => {
      if (child.kind !== 'element') return true;
      if (Object.hasOwn(child.attrs, 'data-recued-structural-only')) {
        child.attrs = {}; child.children = []; child.structuralOnly = true;
        return preserveStructure;
      }
      pending.push(child); return true;
    });
  }
  return root;
};

/** The elements that start a line of their own. Anything else (a `span`, a custom element) is
 *  see-through: its text joins the line around it, and the blocks inside it are lines of their
 *  own. */
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center', 'dd', 'details',
  'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hgroup', 'hr', 'iframe', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']);
const CELL = new Set(['td', 'th']);
const LIST = new Set(['ul', 'ol', 'menu']);
const FIELD_WORDS: Record<string, string> = { checkbox: 'checkbox', radio: 'radio button', button: 'button',
  submit: 'button', reset: 'button', image: 'button', range: 'slider', number: 'number field', search: 'search box',
  file: 'file picker', password: 'password field', email: 'email field', tel: 'phone field', url: 'address field',
  date: 'date field', time: 'time field', 'datetime-local': 'date field', month: 'month field', week: 'week field',
  color: 'color picker' };
const ROLE_WORDS: Record<string, string> = { textbox: 'text field', searchbox: 'search box', combobox: 'list',
  checkbox: 'checkbox', radio: 'radio button', switch: 'switch', slider: 'slider', spinbutton: 'number field',
  tab: 'tab', menuitem: 'menu item', menuitemcheckbox: 'menu item', menuitemradio: 'menu item', option: 'option' };
/** The elements whose own id a line names. */
const FIELD_TAGS = new Set(['input', 'select', 'textarea', 'button']);
/** How much of a picture's description a line shows. */
const IMAGE_ALT_CHARS = 40;

const squash = (text: string) => text.replace(/\s+/g, ' ');
const attr = (element: OutlineElement, name: string): string | undefined => {
  const value = element.attrs[name];
  return typeof value === 'string' && value.trim() !== '' ? squash(value).trim() : undefined;
};

/** 2026-11-21 (D-402, task P) — the kind of card an element is, as `within.card` names it and the Bridge's
 *  `closest()` finds it: its tag with its test id, else with its readable classes (at most three, as a read
 *  keeps them). Undefined for an element with neither, or a name the Act contract does not take. */
export const cardKindOf = (element: OutlineElement): string | undefined => {
  if (!/^[a-z][a-z0-9-]{0,20}$/u.test(element.tag)) return undefined;
  const testid = attr(element, 'data-testid');
  if (testid !== undefined && /^[\w:.-]{1,100}$/u.test(testid)) return `${element.tag}[data-testid="${testid}"]`;
  const classes = (attr(element, 'class') ?? '').split(/\s+/u)
    .filter((name) => /^[A-Za-z][\w-]{1,40}$/u.test(name) && !/\d{4,}|^(ember|react|ng-|__|:r|mui|css-|sc-|jsx-)/iu.test(name)).slice(0, 3);
  return classes.length > 0 ? `${element.tag}.${classes.join('.')}` : undefined;
};
/** Whether an element is of a card kind, as `closest()` matches it: the tag, and the test id, or every class. */
export const isOfCardKind = (element: OutlineElement, kind: string): boolean => {
  const parsed = /^([a-z][a-z0-9-]*)(?:\[data-testid="([^"]+)"\]|((?:\.[\w-]+)+))$/u.exec(kind);
  if (parsed === null || element.tag !== parsed[1]) return false;
  if (parsed[2] !== undefined) return attr(element, 'data-testid') === parsed[2];
  const has = new Set((attr(element, 'class') ?? '').split(/\s+/u));
  return parsed[3]!.slice(1).split('.').every((name) => has.has(name));
};

/** A piece of a line: text, or something a person can act on, kept whole when a line is cut. A gap
 *  is an element that arrived empty where the page showed a space: the Bridge drops text that is
 *  only white space, a no-break space among it, and Wikipedia writes each `&nbsp;` in a `span` of
 *  its own, so "First appeared" arrives as `First<span></span>appeared`. */
type Piece =
  /** `whole`: the text in full where `text` shortens it (a picture's description). */
  | { text: string; ref?: undefined; gap?: true; whole?: string }
  /** `whole`: the label with every picture's description in full. `plain`: what the page's text
   *  shows of it (slice Q): a link's words, and nothing for a field, a button or another control. */
  | { text: string; ref: string; anchor?: string; whole?: string; plain?: string;
      /** Display annotations do not consume the page-content clipping budget. */
      typeLabel?: string };

/** Each gap as the space it held ("b. 1894", "1881 – 1953"), but none at a line's edge, after an
 *  opening bracket or before a closing mark ("Did you know..."). A link shows as `[label](eN)`. */
const closeGaps = (pieces: Piece[]): Piece[] => pieces.map((piece, i) => {
  if (piece.ref !== undefined || piece.gap !== true) return piece;
  let before = i - 1;
  while (before >= 0 && pieces[before]!.ref === undefined && pieces[before]!.text === '') before -= 1;
  let after = i + 1;
  while (after < pieces.length && pieces[after]!.ref === undefined && pieces[after]!.text === '') after += 1;
  const prev = pieces[before];
  const next = pieces[after];
  const end = prev === undefined ? '' : prev.ref !== undefined ? ')' : prev.text;
  const start = next === undefined ? '' : next.ref !== undefined ? '[' : next.text;
  const spaced = end !== '' && start !== '' && !/[\s([{]$/u.test(end) && !/^[\s.,;:!?)\]}…]/u.test(start);
  return { text: spaced ? ' ' : '' };
});

/** Texts that sat side by side, joined as a page shows them: "[", "1" and "]" as "[1]". The Bridge
 *  drops text that is only white space, so two words that arrive touching get a space back. */
const joinTexts = (texts: string[]): string => texts.reduce((all, next) =>
  all + (/\w$/.test(all) && /^\w/.test(next) ? ' ' : '') + next, '');
/** Every text inside an element, in order, for a label. */
const textInside = (node: OutlineNode): string => node.kind === 'text' ? node.text
  : node.tag === 'img' ? (attr(node, 'alt') ?? '') : joinTexts(node.children.map(textInside));
const words = (text: string) => squash(text).trim();
/** What an element with no text inside it is called by something inside it, such as Hacker
 *  News's vote arrow, a `div` titled "upvote" inside a link. */
const nameInside = (node: OutlineNode): string | undefined => {
  if (node.kind !== 'element') return undefined;
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    const name = attr(child, 'aria-label') ?? attr(child, 'title') ?? attr(child, 'alt') ?? nameInside(child);
    if (name !== undefined) return name;
  }
  return undefined;
};
/** The blocks that make a table cell more than a line of text. A `div`, `center` or `span` around
 *  a link does not. */
const STRUCTURE = new Set(['article', 'blockquote', 'dl', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'nav', 'ol',
  'p', 'pre', 'section', 'table', 'ul']);

/** One line of a read: in full, as the page's text shows it, and where it sits. */
export interface OutlineLine {
  /** The line in full, refs and pictures' descriptions whole: what `find` and `block` read. */
  text: string;
  /** The line as the page's text (slice Q): links as their words, no fields or buttons, never cut.
   *  Empty for a line of controls alone. */
  plain: string;
  heading: string | undefined;
  block: string | undefined;
  /** Inside the page's main content (its `main`, or its one `article`), or the page has none. */
  main: boolean;
}

/** D-335 slice Y — one thing a person can act on, as the outline names it: its ref, its kind
 *  (`button`, `link`, `text field`, `search box`, `list`, …) and every name the page gives it (its
 *  own words, its label, `aria-label`, placeholder, title, a picture's description, a button's
 *  value), for a step that names an element by its text. */
export interface OutlineControl {
  /** D-402 slice G (§4.1) — what the row it sits in shows (the nearest list item, table row or row by
   *  its role above it, as the Bridge's own check finds it), for a step naming the item it acts in. */
  item?: string;
  /** 2026-11-21 (D-402, task P) — for a control no row holds, what each card above it shows, by the kind of
   *  card (`cardKindOf`, of a kind the page shows more than once): the nearest of each kind, as the Bridge's
   *  `closest()` finds it, for a step naming the card it acts in (`within.card`). */
  cards?: Readonly<Record<string, string>>;
  ref: string;
  kind: string;
  names: string[];
  tag?: string;
  type?: string;
  label?: string;
  /** Observed semantic landmark, used only to order recovery choices. */
  landmark?: 'dialog' | 'main' | 'navigation';
  /** Readable background control, excluded from name lookup while a modal is open. */
  blocked?: true;
  /** D-345 slice E — a link's address (http or https, made whole against the page), so a step that
   *  saves the file it links to can have the server fetch it first. */
  href?: string;
  /** Slice Z — how a field is found again on a later visit, for a secret kept for it: its `name`,
   *  else its `id` (`name:passwd`, `id:i0118`). Absent for one with neither. */
  field?: string;
  /** Internal loading-field comparison, derived from the observed field and
   * Bridge form context. Never authorizes a click/submission or leaves the store. */
  field_identity?: string;
}

export interface PageOutline {
  entries?: BrowserEntrySnapshot;
  /** The outline: one line per block, cut lines ending `…(bN)`. */
  text: string;
  /** The same lines one by one, as the outline shows them: what an answer's part is made of. */
  shown: string[];
  /** Each cut line in full, by its block number. */
  blocks: Map<string, string>;
  /** Every line, in page order, with the heading it sits under: the same lines as `shown`, by index. */
  lines: OutlineLine[];
  /** Whether the page marks its main content, so the text leaves the rest out. */
  hasMain: boolean;
  /** Slice Y — every control the outline names, in page order. */
  controls: OutlineControl[];
  /** Slice AL — each id a heading carries (on it, or on a part of it), by the line it starts: what a
   *  `find` of `#Work` reads the section of, as the contents name it `(e13 #Work, line 104)`. */
  headings: Map<string, number>;
}

/** The roles of a control: text a person types into or a choice they make, not words of the page. */
const CONTROL_ROLES = new Set(['button', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'textbox', 'searchbox',
  'combobox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab']);

/** The outline of a read. `nextBlock` numbers the cut lines, so a page read again never reuses a
 *  number that named another line. `firstLine` is the number the first line gets among the page's
 *  kept lines, for a contents link to name the line its section starts at. */
export const outlinePage = (html: string,
  options: { lineChars?: number; nextBlock?: () => string; url?: string; firstLine?: number } = {}): PageOutline => {
  const lineChars = options.lineChars ?? PAGE_OUTLINE_LINE_CHARS;
  const firstLine = options.firstLine ?? 1;
  let counter = 0;
  const nextBlock = options.nextBlock ?? (() => `b${String(++counter)}`);
  const root = parseInspectHtml(html);
  const page = (() => {
    try {
      const url = new URL(options.url ?? '');
      url.hash = '';
      return url.href;
    } catch {
      return undefined;
    }
  })();
  /** `#id` for a link to a part of this same page, else nothing. */
  const sectionOf = (href: string | undefined): string | undefined => {
    if (href === undefined) return undefined;
    if (/^#[^\s#]+$/.test(href)) return href;
    try {
      const url = new URL(href);
      const fragment = url.hash;
      url.hash = '';
      return page !== undefined && url.href === page && /^#[^\s#]+$/.test(fragment) ? fragment : undefined;
    } catch {
      return undefined;
    }
  };

  // A field is named by the label that points at it: `<label for="x">` and the field's `id`.
  const labelFor = new Map<string, string>();
  const fieldIds = new Set<string>();
  // Slice Y — a field inside a label with no `for` is named by the label's own words, as a person
  // reads them beside it (`<label>Email <input></label>`): for a step naming it by its text.
  const labelAround = new WeakMap<OutlineElement, string>();
  const labelWords = (node: OutlineNode): string => node.kind === 'text' ? node.text
    : FIELD_TAGS.has(node.tag) ? '' : joinTexts(node.children.map(labelWords));
  const fieldIn = (node: OutlineNode): OutlineElement | undefined => node.kind !== 'element' ? undefined
    : node.tag === 'input' || node.tag === 'select' || node.tag === 'textarea' ? node
      : node.children.map(fieldIn).find((found) => found !== undefined);
  const index = (node: OutlineNode) => {
    if (node.kind !== 'element') return;
    const id = attr(node, 'id');
    if (node.tag === 'label' && attr(node, 'for')) labelFor.set(attr(node, 'for')!, words(textInside(node)));
    if (node.tag === 'label' && !attr(node, 'for')) {
      const field = fieldIn(node);
      const around = words(labelWords(node));
      if (field !== undefined && around !== '') labelAround.set(field, around);
    }
    if (id && (node.tag === 'input' || node.tag === 'select' || node.tag === 'textarea')) fieldIds.add(id);
    node.children.forEach(index);
  };
  index(root);

  // D-402 slice G (§4.1) — the row each element sits in: the nearest list item, table row, article or
  // row by its role above it (`li, tr, [role="row"], [role="listitem"], [role="option"],
  // [role="article"], article`, the Bridge's own list, `page-fields.ts`), and what that row shows.
  const rowAbove = new WeakMap<OutlineElement, OutlineElement>();
  const rowsOf = (node: OutlineNode, row: OutlineElement | undefined): void => {
    if (node.kind !== 'element') return;
    if (row !== undefined) rowAbove.set(node, row);
    const isRow = ['li', 'tr', 'article'].includes(node.tag) || ['row', 'listitem', 'option', 'article'].includes(attr(node, 'role') ?? '');
    for (const child of node.children) rowsOf(child, isRow ? node : row);
  };
  rowsOf(root, undefined);
  const rowShows = new WeakMap<OutlineElement, string>();
  const itemOf = (element: OutlineElement): string | undefined => {
    const row = rowAbove.get(element);
    if (row === undefined) return undefined;
    let shows = rowShows.get(row);
    if (shows === undefined) { shows = words(textInside(row)).slice(0, 500); rowShows.set(row, shows); }
    return shows === '' ? undefined : shows;
  };

  // The page's main content: its `main` (or `role="main"`), else its one `article`.
  const elements = (node: OutlineNode): OutlineElement[] => node.kind !== 'element' ? []
    : [node, ...node.children.flatMap(elements)];
  const all = elements(root);
  // 2026-11-21 (D-402, task P) — the cards a control no row holds sits in: for each kind of card above it that
  // the page shows more than once, the nearest element of that kind (as `closest()` finds it) and what it shows.
  const parentOf = new WeakMap<OutlineElement, OutlineElement>();
  for (const element of all) for (const child of element.children) if (child.kind === 'element') parentOf.set(child, element);
  // Each kind counted among the elements that carry its test id or its first class, indexed once, as a long
  // page has thousands of elements and an outline is made for every read.
  let carrying: Map<string, OutlineElement[]> | undefined;
  const kindCounts = new Map<string, number>();
  const kindCount = (kind: string): number => {
    let count = kindCounts.get(kind);
    if (count !== undefined) return count;
    if (carrying === undefined) {
      carrying = new Map();
      for (const element of all) {
        const keys = [...(attr(element, 'class') ?? '').split(/\s+/u).filter(Boolean).map((name) => `.${name}`),
          ...(attr(element, 'data-testid') !== undefined ? [`[${attr(element, 'data-testid')!}]`] : [])];
        for (const key of keys) { const list = carrying.get(key) ?? []; list.push(element); carrying.set(key, list); }
      }
    }
    const testid = /\[data-testid="([^"]+)"\]$/u.exec(kind)?.[1];
    const key = testid !== undefined ? `[${testid}]` : `.${kind.split('.')[1] ?? ''}`;
    count = (carrying.get(key) ?? []).filter((element) => isOfCardKind(element, kind)).length;
    kindCounts.set(kind, count);
    return count;
  };
  const cardsOf = (element: OutlineElement): Record<string, string> | undefined => {
    if (rowAbove.get(element) !== undefined) return undefined;
    const above: OutlineElement[] = [];
    for (let up = parentOf.get(element); up !== undefined; up = parentOf.get(up)) above.push(up);
    const cards: Record<string, string> = {};
    for (const kind of new Set(above.map(cardKindOf).filter((one): one is string => one !== undefined))) {
      if (kindCount(kind) < 2) continue;
      const card = above.find((up) => isOfCardKind(up, kind))!;
      let shows = rowShows.get(card);
      if (shows === undefined) { shows = words(textInside(card)).slice(0, 500); rowShows.set(card, shows); }
      if (shows !== '') cards[kind] = shows;
    }
    return Object.keys(cards).length > 0 ? cards : undefined;
  };
  const controlScope = browserControlScope(root);
  const articles = all.filter((element) => element.tag === 'article');
  const mainElement = all.find((element) => element.tag === 'main' || attr(element, 'role') === 'main')
    ?? (articles.length === 1 ? articles[0] : undefined);
  const landmarks = new WeakMap<OutlineElement, NonNullable<OutlineControl['landmark']>>();
  for (const node of controlScope.nodes) {
    const parent = controlScope.parents.get(node);
    const inherited = parent ? landmarks.get(parent) : undefined;
    const role = attr(node, 'role')?.split(/\s+/)[0];
    const landmark = node === controlScope.modal || inherited === 'dialog' ? 'dialog'
      : ['nav', 'header', 'footer', 'aside'].includes(node.tag)
        || ['navigation', 'banner', 'contentinfo', 'complementary'].includes(role ?? '') ? 'navigation'
        : node === mainElement ? 'main' : inherited;
    if (landmark) landmarks.set(node, landmark);
  }
  let inMain = mainElement === undefined;

  const out: PageOutline = { text: '', shown: [], blocks: new Map(), lines: [], hasMain: mainElement !== undefined, controls: [],
    headings: new Map() };
  const rendered: string[] = [];
  let tableSummaries = 0;
  let heading: string | undefined;
  /** The line each heading's ids start, for a contents link to name: `#History` → 68. */
  const headingLines = new Map<string, number>();
  // D-335 slice U — a dialog that blocks the page (shown as a modal one, or marked aria-modal): the
  // outline's first line says it is open and where, since a model reading from the top would
  // otherwise try what is behind it. The line is kept first, so every number after it holds, and
  // written once the walk has reached the dialog. A read of one part leaves it to the whole page's.
  // 2026-11-22 — or what the Bridge found covering the page though the page marks it hidden (`data-recued-cover`).
  const modal = firstLine === 1 ? controlScope.modal ?? all.find((element) => element.attrs.modal !== undefined || attr(element, 'aria-modal') === 'true'
    || Object.hasOwn(element.attrs, 'data-recued-cover'))
    : undefined;
  // Under Google's vignette ad, its own note names the cover (`pageCoveredByAd`): no line for it here.
  const noted = modal !== undefined && !(Object.hasOwn(modal.attrs, 'data-recued-cover') && pageCoveredByAd(options.url ?? ''));
  let modalAt: number | undefined;
  if (noted) {
    rendered.push('');
    out.lines.push({ text: '', plain: '', heading: undefined, block: undefined, main: true });
  }
  const sourceLines = new WeakMap<OutlineElement, number>();
  const reached = (element: OutlineElement) => {
    if (!sourceLines.has(element)) sourceLines.set(element, firstLine + out.lines.length);
    if (element === modal && modalAt === undefined) modalAt = firstLine + out.lines.length;
  };

  /** One thing a person can act on, as `[label](eN)`; the refs inside it follow it. */
  const actionable = (element: OutlineElement, pieces: Piece[]) => {
    const ref = attr(element, 'ref')!;
    const tag = element.tag;
    const role = attr(element, 'role')?.split(/\s+/)[0];
    const checked = element.attrs.checked === true || attr(element, 'aria-checked') === 'true';
    const flags = `${checked ? ' checked' : ''}${element.attrs.disabled === true ? ' disabled' : ''}`;
    const named = attr(element, 'aria-label') ?? (attr(element, 'id') ? labelFor.get(attr(element, 'id')!) : undefined)
      ?? attr(element, 'placeholder') ?? attr(element, 'title');
    const gapped: Piece[] = [];
    for (const child of element.children) inline(child, gapped, true);
    const inner = closeGaps(gapped);
    const own = words(joinTexts(inner.filter((piece) => piece.ref === undefined).map((piece) => piece.text)));
    // The same with each picture's description whole, for the line in full and the page's text.
    const ownWhole = words(joinTexts(inner.filter((piece) => piece.ref === undefined).map((piece) => piece.whole ?? piece.text)));
    // Put the interaction kind beside the label the model selects. Keep the
    // same raw names below for lookup and the same plain text for page reads.
    const kind = tag === 'input' ? FIELD_WORDS[(attr(element, 'type') ?? 'text').toLowerCase()] ?? 'text field'
      : tag === 'select' ? 'list' : tag === 'textarea' ? 'text area'
        : Object.hasOwn(element.attrs, 'contenteditable') && attr(element, 'contenteditable') !== 'false' ? 'text editor'
          : role !== undefined && role !== 'button' && role !== 'link' && ROLE_WORDS[role] !== undefined ? ROLE_WORDS[role]!
            : tag === 'a' || role === 'link' ? 'link' : tag === 'button' || role === 'button' ? 'button' : tag;
    let label: string;
    const literal = (key: string): string | undefined => typeof element.attrs[key] === 'string' ? element.attrs[key]
      : element.attrs[key] === true ? '' : undefined;
    const attributes = [['type', tag === 'input' || tag === 'button' ? literal('type') : undefined],
      ['role', literal('role')], ['contenteditable', literal('contenteditable')]] as const;
    const typeLabel = (tag === 'a' && literal('role') === undefined && literal('contenteditable') === undefined ? 'link' : tag)
      + attributes.filter(([, value]) => value !== undefined).map(([key, value]) => ` ${key}=${JSON.stringify(value)}`).join('')
      + (tag === 'select' && Object.hasOwn(element.attrs, 'multiple') ? ' multiple' : '');
    if (tag === 'input') {
      const type = (attr(element, 'type') ?? 'text').toLowerCase();
      const kind = FIELD_WORDS[type] ?? 'text field';
      const value = attr(element, 'value');
      const name = named ?? (kind === 'button' ? value : undefined) ?? attr(element, 'name') ?? '';
      // A fallback name equal to the copyable #id adds no identity. Keep human
      // labels and every lookup name, and never invent a missing type attribute.
      const displayName = named === undefined && kind !== 'button' && name === attr(element, 'id') && /^[A-Za-z][\w-]*$/.test(name) ? '' : name;
      const shown = kind !== 'button' && kind !== 'checkbox' && kind !== 'radio button' && value !== undefined ? `${displayName ? ' = ' : ''}${JSON.stringify(value)}` : '';
      label = `${displayName}${shown}${flags}`.trim();
    } else if (tag === 'select') {
      const options = element.children.flatMap(child => child.kind !== 'element' ? [] : child.tag === 'option' ? [child]
        : child.tag === 'optgroup' ? child.children.filter((part): part is OutlineElement => part.kind === 'element' && part.tag === 'option') : []);
      const chosen = options.filter(option => option.attrs.selected === true).map(option => words(textInside(option)));
      // Every option: a long list is cut with its line, and its block names them all.
      const listed = options.map((option) => words(textInside(option))).join(' | ');
      const selection = chosen.length ? ` = ${JSON.stringify(Object.hasOwn(element.attrs, 'multiple') ? chosen : chosen[0])}` : '';
      label = `${named ?? ''}${selection}${flags}`.trim();
      if (listed) label += `${label ? ': ' : ''}${listed}`;
    } else if (tag === 'textarea') {
      label = `${named ?? ''}${own ? `${named ? ' = ' : ''}${JSON.stringify(own)}` : ''}${flags}`.trim();
    } else if (literal('contenteditable') !== undefined && literal('contenteditable') !== 'false') {
      label = `${named ?? ''}${own ? `${named ? ' = ' : ''}${JSON.stringify(own)}` : ''}${flags}`.trim();
    } else {
      const text = own || named || attr(element, 'alt') || nameInside(element)
        || (kind === 'button' || kind === 'link' ? '' : tag);
      label = named && own && named !== own ? `${named}: ${own}` : text;
      label += flags;
    }
    // A link to a part of this same page (a contents list) names that part's id, which Read part
    // of a web page takes as a selector; the Bridge writes links as it reads them, so absolute. A
    // field or a button names its own id, which a step can use once a page it loaded has no refs
    // yet. Other links' ids are mostly generated (`up_45789`, `cite_ref-1`) and stay out.
    const id = attr(element, 'id');
    const anchor = tag === 'a' ? sectionOf(attr(element, 'href'))
      : FIELD_TAGS.has(tag) && id !== undefined && /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : undefined;
    // In the page's text a link is its words; a field, a button or another control is not text.
    const control = FIELD_TAGS.has(tag) || (role !== undefined && CONTROL_ROLES.has(role))
      || (Object.hasOwn(element.attrs, 'contenteditable') && attr(element, 'contenteditable') !== 'false');
    const whole = own === ownWhole ? undefined : label.replace(own, () => ownWhole);
    // Slice Y — the control, its kind and every name the page gives it, for a step naming it by text.
    // Every name the outline shows it by (a field's `name` when it has no other) and the words of a
    // label around it, which the outline shows as a line of their own.
    // What a list, a text area or an editor holds (its options, its text) is no name of it.
    const holds = tag === 'select' || tag === 'textarea' || kind === 'text editor';
    const names = [attr(element, 'aria-label'), id !== undefined ? labelFor.get(id) : undefined, labelAround.get(element),
      attr(element, 'placeholder'), attr(element, 'title'), holds ? undefined : own, holds ? undefined : ownWhole,
      attr(element, 'alt'), holds ? undefined : nameInside(element),
      tag === 'input' && (FIELD_WORDS[attr(element, 'type') ?? 'text'] === 'button') ? attr(element, 'value') : undefined,
      FIELD_TAGS.has(tag) && tag !== 'button' ? attr(element, 'name') : undefined]
      .filter((name): name is string => name !== undefined && name.trim() !== '');
    const fieldName = attr(element, 'name');
    // D-345 slice E — the link's address, made whole against the page (the Bridge writes it as the page
    // does, `/files/report.pdf`). A long one the Bridge cut (`…`) names no file.
    const written = tag === 'a' ? attr(element, 'href') : undefined;
    const href = (() => {
      if (written === undefined || written.endsWith('…')) return undefined;
      try {
        const address = new URL(written, options.url);
        return address.protocol === 'http:' || address.protocol === 'https:' ? address.href : undefined;
      } catch {
        return undefined;
      }
    })();
    const landmark = controlScope.modal && controlScope.allowed.has(element) ? 'dialog' : landmarks.get(element);
    const fieldContext = attr(element, 'data-recued-field-context');
    const fieldIdentity = fieldContext !== undefined && fieldContext.length <= 4_000 && !fieldContext.endsWith('…')
      ? createHash('sha256').update(JSON.stringify([element, fieldContext, landmark, controlScope.allowed.has(element)])).digest('hex') : undefined;
    const item = itemOf(element);
    const cards = item === undefined ? cardsOf(element) : undefined;
    out.controls.push({ ref, kind, names: [...new Set(names.map((name) => words(name)))], tag,
      ...(item !== undefined ? { item } : {}),
      ...(cards !== undefined ? { cards } : {}),
      ...(['input', 'button'].includes(tag) && attr(element, 'type') ? { type: attr(element, 'type')!.toLowerCase() } : {}),
      ...(['a', 'button'].includes(tag) ? { label: words(named ?? ownWhole).slice(0, 160) } : {}),
      ...(fieldIdentity ? { field_identity: fieldIdentity } : {}),
      ...(landmark ? { landmark } : {}),
      ...(!controlScope.allowed.has(element) ? { blocked: true as const } : {}),
      ...(fieldName !== undefined && fieldName.trim() !== '' ? { field: `name:${fieldName.trim()}` }
        : id !== undefined && id.trim() !== '' ? { field: `id:${id.trim()}` } : {}),
      ...(href !== undefined ? { href } : {}) });
    pieces.push({ text: label, ref, typeLabel,
      ...(anchor !== undefined ? { anchor } : {}), ...(whole !== undefined ? { whole } : {}),
      plain: control ? '' : ownWhole || named || attr(element, 'alt') || nameInside(element) || '' });
    // What can be acted on inside it (a link in a card that is itself a button) follows it.
    for (const piece of inner) if (piece.ref !== undefined) pieces.push(piece);
  };

  /** The inline content of a node, into `pieces`. Inside something a person acts on, blocks are
   *  part of its label; elsewhere a block is the caller's to start a line for. */
  const inline = (node: OutlineNode, pieces: Piece[], inLabel = false): void => {
    if (node.kind === 'text') {
      pieces.push({ text: node.text });
      return;
    }
    reached(node);
    if (attr(node, 'ref') !== undefined) {
      actionable(node, pieces);
      return;
    }
    if (node.tag === 'img') {
      // A picture's description can be a sentence; a line shows its start, so the text beside it
      // (its caption) is not what the cut takes.
      const alt = attr(node, 'alt');
      // The line in full and the page's text keep the description whole (slice Q).
      if (alt) {
        pieces.push(alt.length > IMAGE_ALT_CHARS ? { text: `[image: ${alt.slice(0, IMAGE_ALT_CHARS).trimEnd()}…]`, whole: `[image: ${alt}]` }
          : { text: `[image: ${alt}]` });
      }
      return;
    }
    if (node.tag === 'br') {
      pieces.push({ text: ' ' });
      return;
    }
    // A label that names a field already says so on the field.
    if (node.tag === 'label' && attr(node, 'for') && fieldIds.has(attr(node, 'for')!)) return;
    if (!inLabel && BLOCK.has(node.tag)) return;
    if (node.children.length === 0) {
      // `wbr` and the other void elements hold no space.
      if (!VOID.has(node.tag)) pieces.push({ text: '', gap: true });
      return;
    }
    for (const child of node.children) inline(child, pieces, inLabel);
  };

  /** Write one line: its pieces, cut at `lineChars` of text, the whole line kept when cut. */
  const line = (prefix: string, gapped: Piece[], preformatted = false) => {
    const pieces = closeGaps(gapped);
    const show = (piece: Piece, text = piece.text) => {
      if (piece.ref === undefined) return text;
      const name = words(text);
      const label = piece.typeLabel ? `${piece.typeLabel}${name ? `: ${name}` : ''}` : name;
      return `[${label}](${piece.ref}${piece.anchor ? ` ${piece.anchor}` : ''})`;
    };
    // The Bridge drops text that is only white space, so a link arrives touching the word or link
    // beside it: it gets the space the page shows, but not after "(" or before ")" or ",".
    const join = (shown: Array<{ text: string; ref: boolean }>) => shown.reduce((all, next, i) => {
      const touching = i > 0 && (next.ref || shown[i - 1]!.ref) && /[\w)\]…]$/.test(all) && /^[\w[]/.test(next.text);
      return all + (touching ? ' ' : '') + next.text;
    }, '');
    const joined = join(pieces.map((piece) => ({ text: show(piece), ref: piece.ref !== undefined })));
    // In full: each picture's description whole (slice Q).
    const joinedWhole = join(pieces.map((piece) => ({ text: show(piece, piece.whole ?? piece.text), ref: piece.ref !== undefined })));
    // As the page's text: a link's words, no controls, never cut.
    const joinedPlain = join(pieces.map((piece) => ({ text: piece.ref === undefined ? piece.whole ?? piece.text : piece.plain ?? '',
      ref: piece.ref !== undefined })));
    // Preformatted text keeps its line breaks when read in full, and is one line in the outline.
    const flat = words(joined);
    const flatWhole = words(joinedWhole);
    const full = preformatted ? joinedWhole.replace(/^\s*\n|\n\s*$/g, '') : flatWhole;
    const plainText = preformatted ? joinedPlain.replace(/^\s*\n|\n\s*$/g, '') : words(joinedPlain);
    const visible = words(pieces.map((piece) => piece.text).join(''));
    if (visible === '' && !pieces.some((piece) => piece.ref !== undefined)) return;
    let shown = flat;
    let block: string | undefined;
    // A line the cut shortens, or whose pictures' descriptions it shortened, has its block.
    if (visible.length <= lineChars && flatWhole !== flat) {
      // D-335 slice T — only a picture's description was shortened: the mark is at its end, so the
      // text beside it (a caption) reads as whole, as it is. At the line's end it sent a model to
      // read the caption's line again (live, 2026-11-05: every run of a search for one).
      const named = nextBlock();
      block = named;
      out.blocks.set(named, full);
      const first = pieces.findIndex((piece) => piece.whole !== undefined);
      shown = words(join(pieces.map((piece, i) => ({ text: i === first ? show(piece).replace('…]', `…(${named})]`) : show(piece),
        ref: piece.ref !== undefined }))));
    } else if (visible.length > lineChars) {
      // Slice AU — its start and its end, `…` between: the pieces are spans of the line's text, the
      // start keeps the first `head` characters of it and the end the last `lineChars - head`.
      const texts = pieces.map((piece) => (piece.ref === undefined ? squash(piece.text) : words(piece.text)));
      const total = texts.reduce((sum, text) => sum + text.length, 0);
      const head = Math.round(lineChars * PAGE_OUTLINE_LINE_HEAD_SHARE);
      const tailFrom = total - (lineChars - head);
      const shownAs = (piece: Piece, text: string) => ({ text: piece.ref === undefined ? text : show({ ...piece, text }),
        ref: piece.ref !== undefined });
      const start: Array<{ text: string; ref: boolean }> = [];
      const end: Array<{ text: string; ref: boolean }> = [];
      // A piece holding the whole cut, such as a list naming its options, is one piece: its start
      // and its end, `…` between, never two links with one ref.
      let spanned = false;
      let at = 0;
      pieces.forEach((piece, i) => {
        const text = texts[i]!;
        const from = at;
        at += text.length;
        if (from < head && at > tailFrom) {
          start.push(shownAs(piece, `${text.slice(0, head - from).trimEnd()}…${text.slice(tailFrom - from).trimStart()}`));
          spanned = true;
        } else if (from < head) {
          start.push(shownAs(piece, at <= head ? text : `${text.slice(0, head - from).trimEnd()}…`));
        } else if (at > tailFrom) {
          end.push(shownAs(piece, from >= tailFrom ? text : `…${text.slice(tailFrom - from).trimStart()}`));
        }
      });
      block = nextBlock();
      out.blocks.set(block, full);
      // One `…` where the middle was: a cut inside a text says so once, and a link cut inside its
      // label already says so there. Joined as pieces, so a link keeps the space beside its words.
      const last = start.at(-1);
      const first = end[0];
      const cutInLink = (last?.ref === true && /…\]\(/.test(last.text)) || (first?.ref === true && /^\[…/.test(first.text));
      if (!spanned && !cutInLink) {
        if (last !== undefined && !last.ref) last.text = last.text.replace(/…$/, '');
        if (first !== undefined && !first.ref) first.text = first.text.replace(/^…/, '');
      }
      const parts = spanned || cutInLink ? [...start, ...end] : [...start, { text: '…', ref: false }, ...end];
      shown = `${words(join(parts))}…(${block})`;
    }
    rendered.push(`${prefix}${shown}`);
    out.lines.push({ text: `${prefix}${flatWhole}`, plain: plainText === '' ? '' : `${prefix}${plainText}`, heading, block, main: inMain });
  };

  /** A table row with nothing but text and things to act on in its cells is one line. */
  const flatRow = (row: OutlineElement): OutlineElement[] | undefined => {
    const cells = row.children.filter((child): child is OutlineElement => child.kind === 'element' && CELL.has(child.tag));
    // A `div` in a cell is no reason to break the row: Wikipedia's infobox writes a name as
    // `<div style="display:inline">`, and Hacker News puts its vote arrow in a `center`. The Bridge
    // sends no styles, so only real structure (a list, a paragraph, a table) breaks a row.
    const structured = (node: OutlineNode): boolean => node.kind === 'element' && attr(node, 'ref') === undefined
      && (STRUCTURE.has(node.tag) || node.children.some(structured));
    return cells.length > 0 && !cells.some((cell) => cell.children.some(structured)) ? cells : undefined;
  };
  /** Something a person can act on that holds blocks with more than two lines' worth of text is a
   *  region of the page (GitHub focuses most of a repository's page), not a label: its own line,
   *  and its content outlined under it. A card holding a title and a line of text stays one link. */
  const region = (element: OutlineElement): boolean => !['input', 'select', 'textarea', 'button'].includes(element.tag)
    // An editor is a field, however much it holds (slice R: an editor's frame's body, mostly).
    && (attr(element, 'contenteditable') === undefined || attr(element, 'contenteditable') === 'false')
    && hasBlock(element) && words(textInside(element)).length > 2 * lineChars;

  /** The lines of a container: its own text between its blocks, then each block, in order. */
  const container = (element: OutlineElement, prefix: string, listDepth: number) => {
    reached(element);
    const entersMain = element === mainElement;
    if (entersMain) inMain = true;
    let pieces: Piece[] = [];
    const flush = () => {
      line(prefix, pieces, element.tag === 'pre');
      pieces = [];
    };
    for (const child of element.children) {
      if (child.kind === 'element' && attr(child, 'ref') !== undefined && region(child)) {
        // A region a person can act on (focus, mostly): its own line, then its content.
        flush();
        const name = attr(child, 'aria-label') ?? attr(child, 'title');
        line(prefix, [{ text: name ?? 'region', ref: attr(child, 'ref')! }]);
        container(child, prefix, listDepth);
      } else if (child.kind === 'element' && attr(child, 'ref') === undefined && BLOCK.has(child.tag)) {
        flush();
        blockLines(child, listDepth);
      } else if (child.kind === 'element' && attr(child, 'ref') === undefined && !BLOCK.has(child.tag)
        && child.tag !== 'img' && child.tag !== 'br' && hasBlock(child)) {
        // A see-through wrapper holding blocks: its own text joins this line, its blocks are lines.
        flush();
        container(child, prefix, listDepth);
      } else {
        inline(child, pieces);
      }
    }
    flush();
    if (entersMain) inMain = false;
  };
  const hasBlock = (node: OutlineNode): boolean => node.kind === 'element'
    && node.children.some((child) => child.kind === 'element' && attr(child, 'ref') === undefined
      && (BLOCK.has(child.tag) || hasBlock(child)));

  /** A line written whole, never cut: what the server says about the page, not the page's text. */
  const noteLine = (text: string) => {
    rendered.push(text);
    out.lines.push({ text, plain: text, heading, block: undefined, main: inMain });
  };
  /** Slice R — a frame from another site, which the Bridge names as a page of its own (`page`), or
   *  could not read (`unread`); a frame from this site has its content in place. */
  const frameNote = (element: OutlineElement): string => {
    const title = attr(element, 'title');
    let site: string | undefined;
    try {
      site = new URL(attr(element, 'src') ?? '').host || undefined;
    } catch {
      site = undefined;
    }
    const named = `${title ? ` "${title.length > 60 ? `${title.slice(0, 60).trimEnd()}…` : title}"` : ''}${site ? ` from ${site}` : ''}`;
    const page = attr(element, 'page');
    return page !== undefined
      ? `(Frame${named}: its content is a page of its own, ${page}; inspect that page to read it or act in it.)`
      : `(Frame${named}: the Browser Bridge cannot read it.)`;
  };

  const blockLines = (element: OutlineElement, listDepth: number) => {
    reached(element);
    const tag = element.tag;
    if (tag === 'iframe') {
      if (attr(element, 'page') !== undefined || element.attrs.unread !== undefined) noteLine(frameNote(element));
      else container(element, '', listDepth);
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      const pieces: Piece[] = [];
      for (const child of element.children) inline(child, pieces, true);
      heading = words(closeGaps(pieces).map((piece) => piece.text).join(''));
      const before = out.lines.length;
      line(`${'#'.repeat(Number(tag[1]))} `, pieces);
      // Its ids (on it, or on a part of it, as older wikis write them) name its line.
      if (out.lines.length > before) {
        for (const named of elements(element)) {
          const id = attr(named, 'id');
          if (id !== undefined && !headingLines.has(id)) headingLines.set(id, firstLine + before);
        }
      }
      return;
    }
    if ((tag === 'table' || ['table', 'grid', 'treegrid'].includes(attr(element, 'role') ?? '')) && tableSummaries < 3) {
      const summary = browserTableHeaders(element, false);
      const headers = summary.columns ?? summary.headers;
      if (headers?.length) { line('', [{ text: `[table ${summary.columns ? 'columns' : 'header cells'}] ${headers.join(' | ')}` }]); tableSummaries++; }
    }
    if (tag === 'tr') {
      const cells = flatRow(element);
      if (cells) {
        const pieces: Piece[] = [];
        cells.forEach((cell, i) => {
          if (i > 0) pieces.push({ text: ' | ' });
          for (const child of cell.children) inline(child, pieces, true);
        });
        line('| ', pieces);
        return;
      }
    }
    if (LIST.has(tag)) {
      container(element, '', listDepth + 1);
      return;
    }
    if (tag === 'li') {
      container(element, `${'  '.repeat(Math.max(0, Math.min(listDepth, 4) - 1))}- `, listDepth);
      return;
    }
    if (tag === 'hr') return;
    container(element, tag === 'blockquote' ? '> ' : '', listDepth);
  };

  container(root, '', 0);
  if (noted && modal !== undefined) {
    const heading = elements(modal).find((element) => /^h[1-6]$/.test(element.tag));
    const shown = modalAt !== undefined && modalAt <= out.lines.length ? out.lines[modalAt - 1]!.plain : '';
    const label = words(attr(modal, 'aria-label') ?? (heading !== undefined ? textInside(heading) : shown));
    const named = label !== '' ? `: “${label.length > 60 ? `${label.slice(0, 60).trimEnd()}…` : label}”` : '';
    const at = modalAt !== undefined && modalAt <= out.lines.length ? ` at line ${String(modalAt)}` : '';
    const note = Object.hasOwn(modal.attrs, 'data-recued-cover') ? `${PAGE_COVER_NOTE_START}${at}${named}. ${PAGE_COVER_NOTE_TAIL})`
      : `(A dialog is open${at}${named}. Answer it or close it first: what is behind it cannot be used until then.)`;
    rendered[0] = note;
    out.lines[0] = { ...out.lines[0]!, text: note, plain: note };
  }
  // Slice Q — a link to a heading on this page names the line its section starts at, so a contents
  // list is a map: `[Work](e13 #Work, line 240)`, read on there with `from`. Not the heading's own
  // link to itself.
  const toSections = (text: string, at: number) => text.replace(/\((e\d+) #([^\s)]+)\)/g, (match, ref: string, id: string) => {
    const target = headingLines.get(id);
    return target === undefined || target === at ? match : `(${ref} #${id}, line ${String(target)})`;
  });
  if (headingLines.size > 0) {
    out.lines.forEach((entry, i) => {
      const at = firstLine + i;
      rendered[i] = toSections(rendered[i]!, at);
      entry.text = toSections(entry.text, at);
      if (entry.block !== undefined) out.blocks.set(entry.block, toSections(out.blocks.get(entry.block)!, at));
    });
  }
  out.shown = rendered;
  out.text = rendered.join('\n');
  out.headings = headingLines;
  out.entries = browserDataEntries(mainElement ?? root, node => sourceLines.get(node));
  return out;
};

/** A page's latest read, kept for `block`, `find` and `from`. */
interface PageRead {
  entries?: BrowserEntrySnapshot;
  control_evidence?: BrowserControlEvidence;
  identity?: string;
  url: string;
  title: string;
  truncated: boolean;
  lines: OutlineLine[];
  shown: string[];
  blocks: Map<string, string>;
  hasMain: boolean;
  /** Numbers for cut lines, never reused on this page. */
  next: number;
  /** The first block number of the latest read of the whole page: a lower one named a line of a
   *  read since replaced. */
  firstBlock: number;
  /** When the Bridge read it (slice Q). */
  readAt: number;
  /** An action on the page may have changed it since (slice Q). */
  acted: boolean;
  loading?: boolean;
  /** Positive document readiness evidence, independent of action eligibility. */
  reportedLoading?: boolean;
  used: number;
  whole: boolean;
  /** Slice Y — the controls it names. */
  controls: OutlineControl[];
  /** Slice AL — the line each heading id starts. */
  headings: Map<string, number>;
}

/** The two forms a kept read is answered in: the outline, or the page's text (slice Q). */
export type PageForm = 'outline' | 'text';

/** D-335 slice P — a run of a kept read's lines, as the outline shows them, or as the page's text. */
export interface OutlinePart {
  control_evidence?: BrowserControlEvidence;
  url: string;
  title: string;
  text: string;
  /** The first and the last line it holds, counted from 1 over the kept lines, and how many
   *  those are. A part from past the end holds none: `to` is then `from - 1`. */
  from: number;
  to: number;
  total: number;
  /** Whether lines of this form come after it. */
  more: boolean;
  truncated: boolean;
  /** The page marks its main content: the text shows only that. */
  hasMain: boolean;
}

export interface PageReadStore {
  /** Full cleaned, visible source lines, independently of response paging. */
  dataSnapshot(page: string): { url: string; title: string; truncated: boolean; loading: boolean;
    lines: Array<{ line: number; text: string; heading: string; level: number }>; entries?: BrowserEntrySnapshot } | undefined;
  /** A fresh element view has its own line space and data capture. Register its refs/blocks
   *  without appending region lines to, or renewing, an existing whole-page capture. */
  region(page: string, read: { url: string; title: string; html: string; truncated: boolean; loading?: boolean;
    control_evidence?: BrowserControlEvidence }, options: { from?: number; form: PageForm; chars?: number }):
    { part: OutlinePart; snapshot: PageReadSnapshot };
  /** Outline a read of `page` and keep it; a read of the whole page replaces the last one, a read
   *  of one part adds its lines. `start` is the kept line this read's first line became: 1 for a
   *  whole page. */
  outline(page: string, read: { url: string; title: string; html: string; truncated: boolean; whole: boolean; loading?: boolean; control_evidence?: BrowserControlEvidence }): PageOutline & { start: number };
  /** Slice Q — a new read of the whole page set beside the kept one. The same lines keep the kept
   *  read, its numbers and blocks, and only renew its time; others replace it, and `previous` holds
   *  the lines it had, for a part to go on after the line read last. */
  refresh(page: string, read: { url: string; title: string; html: string; truncated: boolean; loading?: boolean; control_evidence?: BrowserControlEvidence }): { changed: boolean; previous?: OutlineLine[] };
  /** Slice Q — how long ago the Bridge read the whole page, `Infinity` once an action may have changed
   *  it, `undefined` when no read of the whole page is kept (a read of one part alone is not one). */
  age(page: string): number | undefined;
  /** Slice Q — an action on the page changed it, or may have: `find` and `from` read it again. */
  markChanged(page: string): void;
  markLoading(page: string, loading: boolean): void;
  loading(page: string): boolean;
  loadingEvidence(page: string): boolean | undefined;
  /** Slice Y — the controls the kept read of `page` names, whether it is of the whole page or of
   *  parts (`whole`), and whether the page's read stopped before its end (`truncated`); undefined
   *  when none is kept or an action may have changed the page since. */
  controls(page: string): { controls: OutlineControl[]; whole: boolean; truncated: boolean } | undefined;
  /** Comparison only: a loading snapshot must not directly authorize an action. */
  pendingControls(page: string): { controls: OutlineControl[]; whole: boolean; truncated: boolean; url: string } | undefined;
  readIdentity(page: string): string | undefined;
  /** Slice Z — the control a ref names in the kept read of `page`, even after an action on the page:
   *  a ref names one element for as long as its page lasts. */
  controlOf(page: string, ref: string): OutlineControl | undefined;
  /** D-347 follow-up — where the control `ref` names sits among the kept read's controls of its kind
   *  called as it is (its first name), from 0, and how many there are, even after an action on the
   *  page: the place a ref found again on the next page takes ({@link findControl}). */
  positionOf(page: string, ref: string): ControlPosition | undefined;
  /** Slice Q — the number of the kept line that reads exactly `text`, the nearest to line `near`:
   *  where a line read before a change is now. */
  locate(page: string, text: string, near: number): number | undefined;
  /** A cut line in full, from the page's kept read; `replaced` when it named a line of a read the
   *  page has had since. */
  block(page: string, block: string): { url: string; title: string; text: string } | 'replaced' | undefined;
  /** The kept lines from line `from` on, in the outline or as the page's text, as many as a part
   *  holds (or `chars`) and at least one. `undefined` when nothing of the page is kept. */
  part(page: string, from: number, form?: PageForm, chars?: number): OutlinePart | undefined;
  /** Slice T — what changed between `previous` (the lines a read kept before) and the kept read:
   *  each line now there that was not, with its number and as the outline shows it, and each that
   *  went, in order. Lines are matched by their whole text, refs included, so a control the page
   *  drew anew is a line that changed. `undefined` when nothing of the page is kept. */
  changes(page: string, previous: readonly OutlineLine[]): PageChanges | undefined;
  /** Every kept line of the page that holds `text`, ignoring case, each after its line number; a
   *  heading with the lines of its section after it. `undefined` when no read of the whole page is
   *  kept. */
  find(page: string, text: string): { url: string; title: string; truncated: boolean; matches: number; lines: string;
    read_ranges: BrowserReadRange[]; complete: boolean; next?: number } | undefined;
  /** Slice AJ — the page's text under the headings that hold `text`, ignoring case: each section
   *  whole, from its heading to the next heading of its rank or above, its subsections in it, for
   *  the first {@link PAGE_FIND_SECTIONS} such headings, up to `chars` characters (a part of the text
   *  when none). With no heading holding it, every paragraph that does, whole. `undefined` when no
   *  read of the whole page is kept.
   *  Slice AL — `text` may name several, separated by `|`, each read so; and `#id`, an id a heading
   *  carries, names that heading's section alone. */
  sections(page: string, text: string, chars?: number): PageSections | undefined;
  /** Slice AL — the line a heading carrying `id` starts in the kept read of `page`, if one does. */
  headingLine(page: string, id: string): number | undefined;
}

/** D-335 slice AJ — what a text `find` answers: the page's text under the headings that hold it,
 *  each section whole. The outline's `find` preserves actionable refs and uses its own part budget. */
export interface PageSections {
  read_ranges: BrowserReadRange[];
  url: string;
  title: string;
  truncated: boolean;
  complete: boolean;
  /** How many of the page's lines hold the text, headings or not. */
  matches: number;
  /** How many sections whose heading holds it are answered: 0 when no heading does, and the
   *  paragraphs that hold it are answered instead. */
  sections: number;
  text: string;
  /** The line to read on from with `from`, when they went on past the size asked. */
  next?: number;
}

/** D-335 slice T — what an action changed on a page: the lines new since its last read (as the
 *  outline shows them, with their numbers) and the lines that went. */
export interface PageChanges {
  url: string;
  title: string;
  added: Array<{ number: number; shown: string }>;
  gone: string[];
}

export type PageReadSnapshot = NonNullable<ReturnType<PageReadStore['dataSnapshot']>>;

const dataSnapshotOf = (read: Pick<PageRead, 'url' | 'title' | 'truncated' | 'loading' | 'entries' | 'lines' | 'blocks'>): PageReadSnapshot => ({
  url: read.url, title: read.title, truncated: read.truncated, loading: read.loading === true,
  ...(read.entries ? { entries: structuredClone(read.entries) } : {}),
  lines: read.lines.map((line, index) => ({ line: index + 1,
    text: line.plain || (line.block ? read.blocks.get(line.block) : undefined) || line.text,
    heading: line.heading ?? '', level: headingRank(line.text) ?? 0 })),
});

const outlinePart = (read: Pick<PageRead, 'url' | 'title' | 'shown' | 'lines' | 'hasMain' | 'truncated' | 'acted' | 'loading' | 'control_evidence'>,
  from: number, form: PageForm, chars?: number): OutlinePart => {
  const budget = chars ?? (form === 'text' ? PAGE_TEXT_PART_CHARS : PAGE_OUTLINE_PART_CHARS);
  const taken: string[] = [];
  let size = 0, first = -1, last = -1, more = false;
  for (let at = Math.max(0, from - 1); at < read.lines.length; at += 1) {
    const line = read.lines[at]!;
    const text = form === 'outline' ? read.shown[at] : line.plain !== '' && (line.main || !read.hasMain) ? line.plain : undefined;
    if (text === undefined) continue;
    if (taken.length > 0 && size + text.length + 1 > budget) { more = true; break; }
    taken.push(text); size += text.length + 1;
    if (first < 0) first = at;
    last = at;
  }
  return { url: read.url, title: read.title, text: taken.join('\n'), from: first < 0 ? from : first + 1,
    to: first < 0 ? from - 1 : last + 1, total: read.lines.length, more, truncated: read.truncated, hasMain: read.hasMain,
    ...(!read.acted && !read.loading && read.control_evidence ? { control_evidence: read.control_evidence } : {}) };
};

/** A line as `find` shows it: a long one around the text, or from its start. */
const clipLine = (line: OutlineLine, needle?: string): string => {
  const body = line.text;
  if (body.length <= PAGE_FIND_LINE_CHARS) return body;
  const at = needle === undefined ? 0 : Math.max(0, body.toLowerCase().indexOf(needle) - Math.floor(PAGE_FIND_LINE_CHARS / 3));
  return `${at > 0 ? '…' : ''}${body.slice(at, at + PAGE_FIND_LINE_CHARS)}…${line.block ? `(${line.block})` : ''}`;
};
const headingRank = (text: string): number | undefined => /^(#{1,6}) /.exec(text)?.[1]!.length;
/** Slice AL — the texts a `find` names: several separated by `|`, each without case. */
const findNeedles = (text: string): string[] => text.split('|').map((piece) => piece.trim().toLowerCase())
  .filter((piece) => piece !== '');

export const createPageReadStore = (options: { now?: () => number; ttlMs?: number; maxPages?: number } = {}): PageReadStore => {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? PAGE_READ_TTL_MS;
  const maxPages = options.maxPages ?? PAGE_READ_MAX_PAGES;
  // Insertion order is use order: a Map iterates the least recently used first.
  const reads = new Map<string, PageRead>();
  const sweep = () => {
    for (const [page, read] of reads) {
      if (read.used > now() - ttlMs && reads.size <= maxPages) break;
      reads.delete(page);
    }
  };
  const touch = (page: string): PageRead | undefined => {
    sweep();
    const read = reads.get(page);
    if (!read) return undefined;
    read.used = now();
    reads.delete(page);
    reads.set(page, read);
    return read;
  };
  const identityOf = (read: { url: string; html: string; truncated: boolean }) =>
    createHash('sha256').update(JSON.stringify([read.url, read.truncated, read.html])).digest('hex');
  const keepWhole = (page: string, read: { url: string; title: string; html: string; truncated: boolean; loading?: boolean; control_evidence?: BrowserControlEvidence }, outline: PageOutline, next: number, firstBlock: number) => {
    reads.delete(page);
    reads.set(page, { identity: identityOf(read), url: read.url, title: read.title, truncated: read.truncated, lines: outline.lines, shown: outline.shown,
      blocks: outline.blocks, hasMain: outline.hasMain, next, firstBlock, readAt: now(), acted: false, used: now(), whole: true,
      controls: outline.controls, headings: outline.headings, control_evidence: read.control_evidence, entries: outline.entries,
      reportedLoading: read.loading });
    sweep();
  };
  return {
    dataSnapshot(page) {
      const read = touch(page);
      if (!read?.whole) return undefined;
      return dataSnapshotOf(read);
    },
    region(page, read, options) {
      const kept = touch(page);
      let next = kept?.next ?? 0;
      const firstBlock = next + 1;
      const outline = outlinePage(read.html, { nextBlock: () => `b${String(++next)}`, url: read.url });
      if (!kept) {
        keepWhole(page, read, outline, next, firstBlock);
        reads.get(page)!.whole = false;
      } else {
        kept.next = next;
        for (const [block, text] of outline.blocks) kept.blocks.set(block, text);
        const controls = new Map(kept.controls.map(control => [control.ref, control]));
        for (const control of outline.controls) controls.set(control.ref, control);
        kept.controls = [...controls.values()];
        // A region never establishes that the rest of a loading/changed page settled.
        if (read.loading === true) kept.loading = true;
      }
      const local = { ...outline, ...read, loading: read.loading === true, acted: false };
      return { part: outlinePart(local, options.from ?? 1, options.form, options.chars), snapshot: dataSnapshotOf(local) };
    },
    outline(page, read) {
      const kept = touch(page);
      let next = kept?.next ?? 0;
      const firstBlock = next + 1;
      const adds = !read.whole && kept !== undefined;
      const outline = outlinePage(read.html, { nextBlock: () => `b${String(++next)}`, url: read.url,
        firstLine: adds ? kept.lines.length + 1 : 1 });
      if (!adds) {
        keepWhole(page, read, outline, next, firstBlock);
        if (!read.whole) reads.get(page)!.whole = false;
        return { ...outline, start: 1 };
      }
      reads.delete(page);
      reads.set(page, { ...kept, identity: undefined, lines: [...kept.lines, ...outline.lines], shown: [...kept.shown, ...outline.shown],
        blocks: new Map([...kept.blocks, ...outline.blocks]), hasMain: kept.hasMain || outline.hasMain, next, used: now(),
        controls: [...kept.controls, ...outline.controls.filter((control) => !kept.controls.some((k) => k.ref === control.ref))],
        headings: new Map([...kept.headings, ...outline.headings]), control_evidence: read.control_evidence });
      sweep();
      return { ...outline, start: kept.lines.length + 1 };
    },
    refresh(page, read) {
      const kept = touch(page);
      let next = kept?.next ?? 0;
      const firstBlock = next + 1;
      const outline = outlinePage(read.html, { nextBlock: () => `b${String(++next)}`, url: read.url });
      const same = kept !== undefined && kept.truncated === read.truncated && kept.lines.length === outline.lines.length
        && kept.lines.every((line, i) => line.text === outline.lines[i]!.text);
      if (same) {
        kept.identity = identityOf(read);
        kept.controls = outline.controls;
        // Semantic entry boundaries can change without changing visible text.
        kept.entries = outline.entries;
        kept.control_evidence = read.control_evidence;
        kept.readAt = now();
        kept.acted = false;
        kept.loading = false;
        kept.reportedLoading = read.loading;
        kept.whole = true;
        return { changed: false };
      }
      keepWhole(page, read, outline, next, firstBlock);
      // A read of one part replaced by the whole page is not a change the page made.
      return kept?.whole ? { changed: true, previous: kept.lines } : { changed: false };
    },
    age(page) {
      const read = reads.get(page);
      return read === undefined || !read.whole ? undefined : read.acted || read.loading ? Infinity : now() - read.readAt;
    },
    markChanged(page) {
      const read = reads.get(page);
      if (read) read.acted = true;
    },
    markLoading(page, loading) { const read = reads.get(page); if (read) read.loading = loading; },
    loading(page) { return reads.get(page)?.loading === true; },
    loadingEvidence(page) { return reads.get(page)?.reportedLoading; },
    controls(page) {
      const read = reads.get(page);
      return read === undefined || read.acted || read.loading ? undefined : { controls: read.controls, whole: read.whole, truncated: read.truncated };
    },
    pendingControls(page) {
      const read = reads.get(page);
      return !read || read.acted || !read.loading ? undefined
        : { controls: read.controls, whole: read.whole, truncated: read.truncated, url: read.url };
    },
    readIdentity(page) { const read = reads.get(page); return read?.whole && !read.acted ? read.identity : undefined; },
    controlOf(page, ref) {
      return reads.get(page)?.controls.find((control) => control.ref === ref);
    },
    positionOf(page, ref) {
      const controls = reads.get(page)?.controls ?? [];
      const control = controls.find((each) => each.ref === ref);
      if (control?.names[0] === undefined) return undefined;
      const same = namedExactly(ofRole(controls, control.kind), control.names[0]);
      return { at: same.indexOf(control), of: same.length };
    },
    locate(page, text, near) {
      const read = reads.get(page);
      let best: number | undefined;
      read?.lines.forEach((line, at) => {
        if (line.text === text && (best === undefined || Math.abs(at + 1 - near) < Math.abs(best - near))) best = at + 1;
      });
      return best;
    },
    block(page, block) {
      const read = touch(page);
      if (!read) return undefined;
      const text = read.blocks.get(block);
      if (text !== undefined) return { url: read.url, title: read.title, text };
      return Number(/^b(\d+)$/.exec(block)?.[1] ?? NaN) < read.firstBlock ? 'replaced' : undefined;
    },
    part(page, from, form = 'outline', chars) {
      const read = touch(page);
      if (!read) return undefined;
      return outlinePart(read, from, form, chars);
    },
    changes(page, previous) {
      const read = touch(page);
      if (!read) return undefined;
      const count = (lines: readonly OutlineLine[]) => {
        const counted = new Map<string, number>();
        for (const line of lines) counted.set(line.text, (counted.get(line.text) ?? 0) + 1);
        return counted;
      };
      // The same text as often as before is the same line; one more is new, one fewer went.
      const before = count(previous);
      const added: PageChanges['added'] = [];
      read.lines.forEach((line, at) => {
        const left = before.get(line.text) ?? 0;
        if (left > 0) before.set(line.text, left - 1);
        else added.push({ number: at + 1, shown: read.shown[at]! });
      });
      const now = count(read.lines);
      const gone = previous.filter((line) => {
        const left = now.get(line.text) ?? 0;
        if (left === 0) return true;
        now.set(line.text, left - 1);
        return false;
      }).map((line) => line.text);
      return { url: read.url, title: read.title, added, gone };
    },
    find(page, text) {
      const read = touch(page);
      if (!read?.whole) return undefined;
      // Slice AL — several texts, separated by `|`: a line holding any of them.
      const needles = findNeedles(text);
      const holds = (line: OutlineLine) => needles.find((needle) => line.text.toLowerCase().includes(needle));
      const needle = needles[0] ?? text.toLowerCase();
      // Each line with its number, which `from` reads on at.
      const found = read.lines.flatMap((line, at) => holds(line) !== undefined ? [{ line, number: at + 1 }] : []);
      const shown: string[] = [];
      const included = new Set<number>();
      let sections = 0, size = 0;
      let next: number | undefined;
      const omit = (number: number) => { next = Math.min(next ?? number, number); };
      const append = (at: number, section: boolean, nested = false): boolean => {
        if (included.has(at)) return true;
        const line = read.lines[at]!;
        const body = section ? line.text : clipLine(line, holds(line) ?? needle);
        const entry = `${nested ? '  ' : ''}line ${String(at + 1)}: `
          + (!section && line.heading && !body.startsWith('#') ? `${body}   (under "${line.heading}")` : body);
        if (size + entry.length + (shown.length ? 1 : 0) > PAGE_OUTLINE_PART_CHARS) {
          // A very long line keeps its existing block handle instead of cutting refs.
          if (shown.length === 0) {
            shown.push(`line ${String(at + 1)}: ${clipLine(line, holds(line) ?? needle)}`);
            included.add(at);
          }
          omit(at + 1);
          return false;
        }
        shown.push(entry); included.add(at); size += entry.length + (shown.length > 1 ? 1 : 0);
        if (body !== line.text) omit(at + 1);
        return true;
      };
      for (const { line, number } of found.slice(0, PAGE_FIND_MAX_LINES)) {
        if (included.has(number - 1)) continue;
        const rank = headingRank(line.text);
        if (!append(number - 1, rank !== undefined)) break;
        if (rank === undefined) continue;
        if (sections === PAGE_FIND_SECTIONS) { omit(number); continue; }
        sections += 1;
        let cut = false;
        for (let at = number; at < read.lines.length; at += 1) {
          const nextRank = headingRank(read.lines[at]!.text);
          if (nextRank !== undefined && nextRank <= rank) break;
          if (!append(at, true, true)) { cut = true; break; }
        }
        if (cut) break;
      }
      const missing = found.filter(({ number }) => !included.has(number - 1));
      if (missing.length) omit(missing[0]!.number);
      const more = missing.length ? `\n…and ${String(missing.length)} more lines` : '';
      return { url: read.url, title: read.title, truncated: read.truncated, matches: found.length,
        read_ranges: browserReadRanges([...included].map(at => at + 1)),
        lines: shown.join('\n') + more, complete: next === undefined && !read.truncated && !read.loading,
        ...(next !== undefined ? { next } : {}) };
    },
    sections(page, text, chars) {
      const read = touch(page);
      if (!read?.whole) return undefined;
      const budget = chars ?? PAGE_TEXT_PART_CHARS;
      // As the text shows a line (`part`): no line of controls alone, and on a page that marks its
      // main content, only that.
      const shown = (at: number): string | undefined => {
        const line = read.lines[at]!;
        return line.plain !== '' && (line.main || !read.hasMain) ? line.plain : undefined;
      };
      // A section runs from its heading to the next heading of its rank or above; a heading inside one
      // already taken is part of it.
      const runs: Array<{ from: number; to: number; section: boolean }> = [];
      const omitted = new Set<number>();
      const inside = (at: number) => runs.some((run) => at >= run.from && at < run.to);
      const sectionAt = (at: number) => {
        const rank = headingRank(read.lines[at]!.text);
        if (rank === undefined || inside(at)) return;
        if (runs.filter((run) => run.section).length === PAGE_FIND_SECTIONS) { omitted.add(at); return; }
        let to = at + 1;
        for (; to < read.lines.length; to += 1) {
          const next = headingRank(read.lines[to]!.text);
          if (next !== undefined && next <= rank) break;
        }
        runs.push({ from: at, to, section: true });
      };
      // Slice AL — each text read on its own: a `#id` a heading carries, that heading's section; a
      // text a heading holds, those sections; any other, each paragraph holding it.
      let holding = 0;
      for (const needle of findNeedles(text)) {
        const id = /^#([^\s#.[\]:>]+)$/.exec(needle)?.[1];
        const line = id === undefined ? undefined : [...read.headings].find(([named]) => named.toLowerCase() === id)?.[1];
        if (line !== undefined) {
          holding += 1;
          sectionAt(line - 1);
          continue;
        }
        const lines = read.lines.flatMap((entry, at) => (entry.text.toLowerCase().includes(needle) ? [at] : []));
        holding += lines.length;
        const headings = lines.filter((at) => headingRank(read.lines[at]!.text) !== undefined);
        if (headings.length > 0) for (const at of headings) sectionAt(at);
        else for (const at of lines) if (!inside(at)) runs.push({ from: at, to: at + 1, section: false });
      }
      // In page order, each once: a paragraph or a subsection inside a section taken is read with it.
      runs.sort((a, b) => a.from - b.from || b.to - a.to);
      const kept: typeof runs = [];
      for (const run of runs) if (kept.length === 0 || run.from >= kept.at(-1)!.to) kept.push(run);
      const sections = kept.filter((run) => run.section).length;
      const taken: string[] = [];
      const included: number[] = [];
      let size = 0;
      let next: number | undefined = [...omitted].filter(at => !kept.some(run => at >= run.from && at < run.to))
        .map(at => at + 1).sort((a, b) => a - b)[0];
      let under: string | undefined;
      fill: for (const run of kept) {
        for (let at = run.from; at < run.to; at += 1) {
          let piece = shown(at);
          if (piece === undefined) continue;
          const heading = read.lines[at]!.heading;
          if (!run.section && heading !== undefined && heading !== under) piece = `(under "${heading}") ${piece}`;
          under = heading;
          if (taken.length > 0 && size + piece.length + 1 > budget) {
            next = Math.min(next ?? at + 1, at + 1);
            break fill;
          }
          taken.push(piece);
          included.push(at + 1);
          size += piece.length + 1;
        }
      }
      return { url: read.url, title: read.title, truncated: read.truncated, matches: holding, sections,
        read_ranges: browserReadRanges(included),
        text: taken.join('\n'), complete: next === undefined && !read.truncated && !read.loading,
        ...(next !== undefined ? { next } : {}) };
    },
    headingLine(page, id) {
      const wanted = id.replace(/^#/, '').toLowerCase();
      return [...(reads.get(page)?.headings ?? [])].find(([named]) => named.toLowerCase() === wanted)?.[1];
    },
  };
};

/** The process's store: what the DOM adapter keeps between a read and its `block` or `find`. In
 *  memory only, like the screenshots (`browser-images.ts`): a read is a page as the owner sees it. */
export const pageReads = createPageReadStore();

/** D-335 slice Y — what a step's `role` may name, and the kinds of control each covers. A role it
 *  does not list names the kinds that contain it. */
const ROLE_KINDS: Record<string, readonly string[]> = {
  field: ['text field', 'search box', 'email field', 'phone field', 'address field', 'password field', 'number field',
    'date field', 'time field', 'month field', 'week field', 'text area', 'text editor'],
  button: ['button'], link: ['link'], checkbox: ['checkbox'], radio: ['radio button'], 'radio button': ['radio button'],
  list: ['list'], tab: ['tab'], 'menu item': ['menu item'], option: ['option'], switch: ['switch'], slider: ['slider'],
};
/** The most candidates a step's refusal names. */
const CONTROLS_SAID = 6;

/** D-335 slice Y — how a step's text and a control's name are compared: case, spacing, quotes
 *  around it and a colon or a star after it (a label's `Email *`) ignored. */
const nameKey = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()
  .replace(/^["“”'‘’]+/, '').replace(/["“”'‘’:*\s]+$/, '');

export type ControlMatch = { ref: string; control: OutlineControl } | { several: OutlineControl[] } | { none: OutlineControl[] };
/** D-347 follow-up — a control's place among those of its kind called as it is: `at` of `of`, from 0. */
export type ControlPosition = { readonly at: number; readonly of: number };

/** The controls of the kinds `role` names, every one with no role, in page order. */
const ofRole = (controls: readonly OutlineControl[], role?: string): OutlineControl[] => {
  const kinds = role === undefined ? undefined : ROLE_KINDS[nameKey(role)] ?? [nameKey(role)];
  return controls.filter((control) => !control.blocked && (kinds === undefined || kinds.some((kind) => control.kind === kind
    || (ROLE_KINDS[nameKey(role!)] === undefined && control.kind.includes(kind)))));
};
/** Those of `pool` one of whose names is `text` ({@link nameKey}), in page order. */
const namedExactly = (pool: readonly OutlineControl[], text: string): OutlineControl[] =>
  pool.filter((control) => control.names.some((name) => nameKey(name) === nameKey(text)));
/** Of links that all lead to one address, not to a part of a page (`#…`, which a script may handle for
 *  each link its own way), the first: following any of them is the same. Else none. */
const sameAddress = (controls: readonly OutlineControl[]): OutlineControl | undefined => (controls.every((control) =>
  control.kind === 'link' && control.href !== undefined && !control.href.includes('#') && control.href === controls[0]!.href)
  ? controls[0] : undefined);

/** D-335 slice Y — the control a step names by its text, among a page's: one whose name is the
 *  text before one whose name holds it as whole words, narrowed to `role` when given. Several left
 *  at the best level are `several`; none is `none`, with the controls that share a word with it.
 *  D-347 follow-up (2026-11-08) — of several called exactly that, a ref found again on a new page
 *  (`position`, its place on the page it was read on) takes the one in that place when this page has
 *  as many; and of several at either level, links that all lead to one address are one action (a
 *  pager's "Next" above a list and below it), so the first is taken. Else they are `several`, as before. */
export const findControl = (controls: readonly OutlineControl[], text: string, role?: string,
  position?: ControlPosition): ControlMatch => {
  const wanted = nameKey(text);
  const pool = ofRole(controls, role);
  const exact = namedExactly(pool, text);
  if (exact.length === 1) return { ref: exact[0]!.ref, control: exact[0]! };
  if (exact.length > 1) {
    const one = position !== undefined && position.of === exact.length ? exact[position.at] : sameAddress(exact);
    return one !== undefined ? { ref: one.ref, control: one } : { several: exact };
  }
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const within = new RegExp(`(^|\\W)${escaped}($|\\W)`);
  const partial = wanted === '' ? [] : pool.filter((control) => control.names.some((name) => within.test(nameKey(name))));
  if (partial.length === 1) return { ref: partial[0]!.ref, control: partial[0]! };
  if (partial.length > 1) {
    const one = sameAddress(partial);
    return one !== undefined ? { ref: one.ref, control: one } : { several: partial };
  }
  const wordsOf = (value: string) => new Set(nameKey(value).split(/\W+/).filter((word) => word.length > 2));
  const asked = wordsOf(text);
  return { none: pool.filter((control) => control.names.some((name) => [...wordsOf(name)].some((word) => asked.has(word)))) };
};

/** D-335 slice Y — controls as a refusal names them: `the button “Search” (e5)`. */
export const controlsSaid = (controls: readonly OutlineControl[]): string => controls.slice(0, CONTROLS_SAID)
  .map((control) => `the ${control.kind} “${control.names[0] ?? ''}” (${control.ref})`).join(', ')
  + (controls.length > CONTROLS_SAID ? `, and ${String(controls.length - CONTROLS_SAID)} more` : '');
