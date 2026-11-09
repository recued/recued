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

/** How much of a line's text the outline shows before cutting it. */
export const PAGE_OUTLINE_LINE_CHARS = 100;
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
/** D-335 slice Q — a heading `find` matches comes with the lines of its section after it, up to
 *  this many, for the first few headings found: a search for "See also" answers the list. */
export const PAGE_FIND_SECTION_LINES = 8;
export const PAGE_FIND_SECTIONS = 3;

export interface OutlineElement {
  kind: 'element';
  tag: string;
  attrs: Record<string, string | true>;
  children: OutlineNode[];
}
export interface OutlineText {
  kind: 'text';
  text: string;
}
export type OutlineNode = OutlineElement | OutlineText;

/** The elements the Bridge writes without a closing tag (`page-inspect.ts` `VOID`). */
const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'source', 'track', 'wbr']);
const TAG = /<(\/?)([A-Za-z][\w.:-]*)((?:\s+[\w:.-]+(?:="[^"]*")?)*)\s*\/?>/y;
const ATTRIBUTE = /\s+([\w:.-]+)(?:="([^"]*)")?/g;

/** The Bridge escapes `&`, `<` and `>` in text, and `"` as well in an attribute. */
const unescape = (text: string): string =>
  text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The Bridge's cleaned HTML as a tree. Tolerant of what the grammar never writes: a `<` that
 *  opens no tag is text, and a closing tag closes whatever it names, or nothing. */
export const parseInspectHtml = (html: string): OutlineElement => {
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
  let at = 0;
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
    const element: OutlineElement = { kind: 'element', tag, attrs, children: [] };
    top().children.push(element);
    if (!VOID.has(tag)) open.push(element);
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

/** A piece of a line: text, or something a person can act on, kept whole when a line is cut. A gap
 *  is an element that arrived empty where the page showed a space: the Bridge drops text that is
 *  only white space, a no-break space among it, and Wikipedia writes each `&nbsp;` in a `span` of
 *  its own, so "First appeared" arrives as `First<span></span>appeared`. */
type Piece =
  /** `whole`: the text in full where `text` shortens it (a picture's description). */
  | { text: string; ref?: undefined; gap?: true; whole?: string }
  /** `whole`: the label with every picture's description in full. `plain`: what the page's text
   *  shows of it (slice Q): a link's words, and nothing for a field, a button or another control. */
  | { text: string; ref: string; anchor?: string; whole?: string; plain?: string };

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
  ref: string;
  kind: string;
  names: string[];
  /** D-345 slice E — a link's address (http or https, made whole against the page), so a step that
   *  saves the file it links to can have the server fetch it first. */
  href?: string;
  /** Slice Z — how a field is found again on a later visit, for a secret kept for it: its `name`,
   *  else its `id` (`name:passwd`, `id:i0118`). Absent for one with neither. */
  field?: string;
}

export interface PageOutline {
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

  // The page's main content: its `main` (or `role="main"`), else its one `article`.
  const elements = (node: OutlineNode): OutlineElement[] => node.kind !== 'element' ? []
    : [node, ...node.children.flatMap(elements)];
  const all = elements(root);
  const articles = all.filter((element) => element.tag === 'article');
  const mainElement = all.find((element) => element.tag === 'main' || attr(element, 'role') === 'main')
    ?? (articles.length === 1 ? articles[0] : undefined);
  let inMain = mainElement === undefined;

  const out: PageOutline = { text: '', shown: [], blocks: new Map(), lines: [], hasMain: mainElement !== undefined, controls: [],
    headings: new Map() };
  const rendered: string[] = [];
  let heading: string | undefined;
  /** The line each heading's ids start, for a contents link to name: `#History` → 68. */
  const headingLines = new Map<string, number>();
  // D-335 slice U — a dialog that blocks the page (shown as a modal one, or marked aria-modal): the
  // outline's first line says it is open and where, since a model reading from the top would
  // otherwise try what is behind it. The line is kept first, so every number after it holds, and
  // written once the walk has reached the dialog. A read of one part leaves it to the whole page's.
  const modal = firstLine === 1 ? all.find((element) => element.attrs.modal !== undefined || attr(element, 'aria-modal') === 'true')
    : undefined;
  let modalAt: number | undefined;
  if (modal !== undefined) {
    rendered.push('');
    out.lines.push({ text: '', plain: '', heading: undefined, block: undefined, main: true });
  }
  const reached = (element: OutlineElement) => {
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
    let label: string;
    if (tag === 'input') {
      const type = attr(element, 'type') ?? 'text';
      const kind = FIELD_WORDS[type] ?? 'text field';
      const value = attr(element, 'value');
      const name = named ?? (kind === 'button' ? value : undefined) ?? attr(element, 'name') ?? '';
      const shown = kind !== 'button' && kind !== 'checkbox' && kind !== 'radio button' && value !== undefined ? ` = "${value}"` : '';
      label = `${kind}${name ? ` "${name}"` : ''}${shown}${flags}`;
    } else if (tag === 'select') {
      const options = element.children.filter((child): child is OutlineElement => child.kind === 'element' && child.tag === 'option');
      const chosen = options.find((option) => option.attrs.selected === true);
      // Every option: a long list is cut with its line, and its block names them all.
      const listed = options.map((option) => words(textInside(option))).join(' | ');
      label = `list${named ? ` "${named}"` : ''}${chosen ? ` = "${words(textInside(chosen))}"` : ''}${flags}: ${listed}`;
    } else if (tag === 'textarea') {
      label = `text area${named ? ` "${named}"` : ''}${own ? ` = "${own}"` : ''}${flags}`;
    } else if (attr(element, 'contenteditable') !== undefined && attr(element, 'contenteditable') !== 'false') {
      label = `text editor${named ? ` "${named}"` : ''}${own ? ` = "${own}"` : ''}${flags}`;
    } else {
      const kind = role !== undefined && role !== 'button' && role !== 'link' ? ROLE_WORDS[role] : undefined;
      const text = own || named || attr(element, 'alt') || nameInside(element)
        || (tag === 'button' ? 'button' : tag === 'a' ? 'link' : tag);
      label = `${kind ? `${kind} ` : ''}${text}${flags}`;
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
      || (attr(element, 'contenteditable') !== undefined && attr(element, 'contenteditable') !== 'false');
    const whole = own === ownWhole ? undefined : label.replace(own, () => ownWhole);
    // Slice Y — the control, its kind and every name the page gives it, for a step naming it by text.
    const kind = tag === 'input' ? FIELD_WORDS[attr(element, 'type') ?? 'text'] ?? 'text field'
      : tag === 'select' ? 'list' : tag === 'textarea' ? 'text area'
        : attr(element, 'contenteditable') !== undefined && attr(element, 'contenteditable') !== 'false' ? 'text editor'
          : role !== undefined && role !== 'button' && role !== 'link' && ROLE_WORDS[role] !== undefined ? ROLE_WORDS[role]!
            : tag === 'a' || role === 'link' ? 'link' : tag === 'button' || role === 'button' ? 'button' : tag;
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
    out.controls.push({ ref, kind, names: [...new Set(names.map((name) => words(name)))],
      ...(fieldName !== undefined && fieldName.trim() !== '' ? { field: `name:${fieldName.trim()}` }
        : id !== undefined && id.trim() !== '' ? { field: `id:${id.trim()}` } : {}),
      ...(href !== undefined ? { href } : {}) });
    pieces.push({ text: label, ref, ...(anchor !== undefined ? { anchor } : {}), ...(whole !== undefined ? { whole } : {}),
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
    const show = (piece: Piece, text = piece.text) => piece.ref === undefined ? text
      : `[${words(text)}](${piece.ref}${piece.anchor ? ` ${piece.anchor}` : ''})`;
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
  if (modal !== undefined) {
    const heading = elements(modal).find((element) => /^h[1-6]$/.test(element.tag));
    const shown = modalAt !== undefined && modalAt <= out.lines.length ? out.lines[modalAt - 1]!.plain : '';
    const label = words(attr(modal, 'aria-label') ?? (heading !== undefined ? textInside(heading) : shown));
    const named = label !== '' ? `: “${label.length > 60 ? `${label.slice(0, 60).trimEnd()}…` : label}”` : '';
    const note = modalAt !== undefined && modalAt <= out.lines.length
      ? `(A dialog is open at line ${String(modalAt)}${named}. Answer it or close it first: what is behind it cannot be used until then.)`
      : `(A dialog is open${named}. Answer it or close it first: what is behind it cannot be used until then.)`;
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
  return out;
};

/** A page's latest read, kept for `block`, `find` and `from`. */
interface PageRead {
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
  /** Outline a read of `page` and keep it; a read of the whole page replaces the last one, a read
   *  of one part adds its lines. `start` is the kept line this read's first line became: 1 for a
   *  whole page. */
  outline(page: string, read: { url: string; title: string; html: string; truncated: boolean; whole: boolean }): PageOutline & { start: number };
  /** Slice Q — a new read of the whole page set beside the kept one. The same lines keep the kept
   *  read, its numbers and blocks, and only renew its time; others replace it, and `previous` holds
   *  the lines it had, for a part to go on after the line read last. */
  refresh(page: string, read: { url: string; title: string; html: string; truncated: boolean }): { changed: boolean; previous?: OutlineLine[] };
  /** Slice Q — how long ago the Bridge read the whole page, `Infinity` once an action may have changed
   *  it, `undefined` when no read of the whole page is kept (a read of one part alone is not one). */
  age(page: string): number | undefined;
  /** Slice Q — an action on the page changed it, or may have: `find` and `from` read it again. */
  markChanged(page: string): void;
  /** Slice Y — the controls the kept read of `page` names, whether it is of the whole page or of
   *  parts (`whole`), and whether the page's read stopped before its end (`truncated`); undefined
   *  when none is kept or an action may have changed the page since. */
  controls(page: string): { controls: OutlineControl[]; whole: boolean; truncated: boolean } | undefined;
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
  find(page: string, text: string): { url: string; title: string; truncated: boolean; matches: number; lines: string } | undefined;
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
 *  each section whole, where the outline's `find` answers lines cut to {@link PAGE_FIND_LINE_CHARS}
 *  and {@link PAGE_FIND_SECTION_LINES} of a section. */
export interface PageSections {
  url: string;
  title: string;
  truncated: boolean;
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
  const keepWhole = (page: string, read: { url: string; title: string; truncated: boolean }, outline: PageOutline, next: number, firstBlock: number) => {
    reads.delete(page);
    reads.set(page, { url: read.url, title: read.title, truncated: read.truncated, lines: outline.lines, shown: outline.shown,
      blocks: outline.blocks, hasMain: outline.hasMain, next, firstBlock, readAt: now(), acted: false, used: now(), whole: true,
      controls: outline.controls, headings: outline.headings });
    sweep();
  };
  return {
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
      reads.set(page, { ...kept, lines: [...kept.lines, ...outline.lines], shown: [...kept.shown, ...outline.shown],
        blocks: new Map([...kept.blocks, ...outline.blocks]), hasMain: kept.hasMain || outline.hasMain, next, used: now(),
        controls: [...kept.controls, ...outline.controls.filter((control) => !kept.controls.some((k) => k.ref === control.ref))],
        headings: new Map([...kept.headings, ...outline.headings]) });
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
        kept.readAt = now();
        kept.acted = false;
        kept.whole = true;
        return { changed: false };
      }
      keepWhole(page, read, outline, next, firstBlock);
      // A read of one part replaced by the whole page is not a change the page made.
      return kept?.whole ? { changed: true, previous: kept.lines } : { changed: false };
    },
    age(page) {
      const read = reads.get(page);
      return read === undefined || !read.whole ? undefined : read.acted ? Infinity : now() - read.readAt;
    },
    markChanged(page) {
      const read = reads.get(page);
      if (read) read.acted = true;
    },
    controls(page) {
      const read = reads.get(page);
      return read === undefined || read.acted ? undefined : { controls: read.controls, whole: read.whole, truncated: read.truncated };
    },
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
      const budget = chars ?? (form === 'text' ? PAGE_TEXT_PART_CHARS : PAGE_OUTLINE_PART_CHARS);
      // The text leaves out a line of controls alone and, on a page that marks it, what is not
      // its main content.
      const showAt = (at: number): string | undefined => {
        if (form === 'outline') return read.shown[at];
        const line = read.lines[at]!;
        return line.plain !== '' && (line.main || !read.hasMain) ? line.plain : undefined;
      };
      const taken: string[] = [];
      let size = 0;
      let first = -1;
      let last = -1;
      let more = false;
      for (let at = Math.max(0, from - 1); at < read.lines.length; at += 1) {
        const text = showAt(at);
        if (text === undefined) continue;
        if (taken.length > 0 && size + text.length + 1 > (budget)) {
          more = true;
          break;
        }
        taken.push(text);
        size += text.length + 1;
        if (first < 0) first = at;
        last = at;
      }
      return { url: read.url, title: read.title, text: taken.join('\n'), from: first < 0 ? from : first + 1,
        to: first < 0 ? from - 1 : last + 1, total: read.lines.length, more, truncated: read.truncated, hasMain: read.hasMain };
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
      let sections = 0;
      const shown = found.slice(0, PAGE_FIND_MAX_LINES).map(({ line, number }) => {
        const body = clipLine(line, holds(line) ?? needle);
        let entry = `line ${String(number)}: ${line.heading && !body.startsWith('#') ? `${body}   (under "${line.heading}")` : body}`;
        // Slice Q — a heading comes with the start of its section, up to the next heading of its rank.
        const rank = headingRank(line.text);
        if (rank !== undefined && sections < PAGE_FIND_SECTIONS) {
          sections += 1;
          const after: string[] = [];
          for (let at = number; at < read.lines.length && after.length < PAGE_FIND_SECTION_LINES; at += 1) {
            const next = read.lines[at]!;
            const nextRank = headingRank(next.text);
            if (nextRank !== undefined && nextRank <= rank) break;
            after.push(`  line ${String(at + 1)}: ${clipLine(next)}`);
          }
          if (after.length > 0) entry += `\n${after.join('\n')}`;
        }
        return entry;
      });
      const more = found.length > shown.length ? `\n…and ${String(found.length - shown.length)} more lines` : '';
      return { url: read.url, title: read.title, truncated: read.truncated, matches: found.length, lines: shown.join('\n') + more };
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
      const inside = (at: number) => runs.some((run) => at >= run.from && at < run.to);
      const sectionAt = (at: number) => {
        const rank = headingRank(read.lines[at]!.text);
        if (rank === undefined || runs.filter((run) => run.section).length === PAGE_FIND_SECTIONS || inside(at)) return;
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
      let size = 0;
      let next: number | undefined;
      let under: string | undefined;
      fill: for (const run of kept) {
        for (let at = run.from; at < run.to; at += 1) {
          let piece = shown(at);
          if (piece === undefined) continue;
          const heading = read.lines[at]!.heading;
          if (!run.section && heading !== undefined && heading !== under) piece = `(under "${heading}") ${piece}`;
          under = heading;
          if (taken.length > 0 && size + piece.length + 1 > budget) {
            next = at + 1;
            break fill;
          }
          taken.push(piece);
          size += piece.length + 1;
        }
      }
      return { url: read.url, title: read.title, truncated: read.truncated, matches: holding, sections,
        text: taken.join('\n'), ...(next !== undefined ? { next } : {}) };
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
  return controls.filter((control) => kinds === undefined || kinds.some((kind) => control.kind === kind
    || (ROLE_KINDS[nameKey(role!)] === undefined && control.kind.includes(kind))));
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
