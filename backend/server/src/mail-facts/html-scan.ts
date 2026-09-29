/**
 * D-315 slice 2 — what the standards pass reads from an email's HTML (§7.1):
 * schema.org items, from JSON-LD and from microdata, and the links.
 *
 * A tolerant scanner, not an HTML parser. Mail HTML is machine-written and often
 * malformed, and nothing here renders it: it only has to find markup a sender
 * put there on purpose. The HTML is the in-memory copy the provider built at
 * ingest; none of it is stored (§4.4).
 *
 * Bounded: only the first `HTML_SCAN_MAX_CHARS` characters are scanned, in one
 * pass (`htmlTags`) that stays linear however the HTML is broken — a `<` that
 * starts no tag, a tag or quote or comment never closed, ten thousand elements
 * never closed. Every search that looks ahead remembers what it found, so no
 * later tag searches the same text again; a pattern that retried from each `<`
 * made a 2 MB email take half a minute, on every email, at every restart.
 */

/** Markup past this point is not read. Transactional markup sits near the top. */
export const HTML_SCAN_MAX_CHARS = 500_000;
/** A microdata value or a link's text is kept to this. */
const MAX_TEXT_VALUE = 1_000;

/** A schema.org item: `@type` (a bare name, `Order`), then its properties.
 *  JSON-LD and microdata both come out in this shape. */
export type SchemaNode = { readonly '@type'?: unknown; readonly [property: string]: unknown };

const bounded = (html: string): string => (html.length > HTML_SCAN_MAX_CHARS ? html.slice(0, HTML_SCAN_MAX_CHARS) : html);

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'",
};

export const decodeHtmlEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

// ────────────────────────────────────────────────────────────────
// The tags
// ────────────────────────────────────────────────────────────────

/** One tag, or a comment, in document order. */
export interface HtmlTag {
  /** Lower-case; `!--` for a comment. */
  readonly name: string;
  readonly closing: boolean;
  /** The text between the name and the `>`. */
  readonly attributes: string;
  /** Where its `<` is, and just past its `>`. */
  readonly start: number;
  readonly stop: number;
  /** A script's or style's content, which is not markup, runs to here: its end
   *  tag's `<`, or the end of the HTML. */
  readonly rawEnd?: number;
}

const RAW_TEXT = new Set(['script', 'style']);
const TAG_NAME = /\/?([a-zA-Z][\w:-]*)/y;

/** The next place `needle` occurs at or after `from`, for searches that only
 *  move forward: what one search found answers every later one that starts
 *  before it, so the scan as a whole reads the text once. */
const forwardSearch = (text: string, needle: string): ((from: number) => number) => {
  let found = -2;
  return (from) => {
    if (found !== -1 && found < from) found = text.indexOf(needle, from);
    return found;
  };
};

/** Every tag and comment in the (bounded) HTML, in one linear pass. A `<` that
 *  starts no tag is text. A quoted `>` does not end a tag; an unclosed quote
 *  is ignored. A comment or a script never closed runs to the end. */
export const htmlTags = (html: string): { readonly source: string; readonly tags: HtmlTag[] } => {
  const source = bounded(html);
  // Only A–Z folded: a place found in it is the same place in `source`. A
  // letter that grows when lowered (`İ` is two) moved every end tag after it,
  // and a script's end was read inside its text.
  const lowered = source.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  const nextGt = forwardSearch(source, '>');
  const nextDouble = forwardSearch(source, '"');
  const nextSingle = forwardSearch(source, "'");
  const nextCommentEnd = forwardSearch(source, '-->');
  const rawCloses = new Map<string, (from: number) => number>();
  const tags: HtmlTag[] = [];
  let p = source.indexOf('<');
  while (p >= 0) {
    if (source.startsWith('<!--', p)) {
      const end = nextCommentEnd(p + 4);
      const stop = end < 0 ? source.length : end + 3;
      tags.push({ name: '!--', closing: false, attributes: '', start: p, stop });
      p = end < 0 ? -1 : source.indexOf('<', stop);
      continue;
    }
    TAG_NAME.lastIndex = p + 1;
    const named = TAG_NAME.exec(source);
    if (named === null) {
      p = source.indexOf('<', p + 1);
      continue;
    }
    const afterName = TAG_NAME.lastIndex;
    let at = afterName;
    let gt = nextGt(at);
    while (gt >= 0) {
      const double = nextDouble(at);
      const single = nextSingle(at);
      const quote = Math.min(double < 0 ? Infinity : double, single < 0 ? Infinity : single);
      if (quote > gt) break;
      const close = source[quote] === '"' ? nextDouble(quote + 1) : nextSingle(quote + 1);
      if (close < 0) break; // never closed: the first `>` ends the tag
      at = close + 1;
      gt = nextGt(at);
    }
    if (gt < 0) break; // no `>` anywhere after: the rest is text
    const name = named[1]!.toLowerCase();
    const closing = source[p + 1] === '/';
    const tag: HtmlTag = { name, closing, attributes: source.slice(afterName, gt), start: p, stop: gt + 1 };
    if (!closing && RAW_TEXT.has(name)) {
      let search = rawCloses.get(name);
      if (search === undefined) {
        search = forwardSearch(lowered, `</${name}`);
        rawCloses.set(name, search);
      }
      const end = search(gt + 1);
      tags.push({ ...tag, rawEnd: end < 0 ? source.length : end });
      p = end; // its end tag is read next
      continue;
    }
    tags.push(tag);
    p = source.indexOf('<', gt + 1);
  }
  return { source, tags };
};

const ATTRIBUTE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const attributesOf = (text: string): Map<string, string> => {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = match[1]!.toLowerCase();
    if (!attributes.has(name)) attributes.set(name, decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
};

// ────────────────────────────────────────────────────────────────
// JSON-LD
// ────────────────────────────────────────────────────────────────

/** Markup nested deeper than this is not read: schema.org a sender writes is
 *  a few levels deep, and a walk as deep as the markup goes can run out of
 *  stack on an email built to (§9). */
export const MARKUP_MAX_DEPTH = 32;

const flattenJsonLd = (value: unknown, out: SchemaNode[], depth = 0): void => {
  if (depth > MARKUP_MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, out, depth + 1);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const node = value as Record<string, unknown>;
  if (Array.isArray(node['@graph'])) flattenJsonLd(node['@graph'], out, depth + 1);
  if (node['@type'] !== undefined) out.push(node as SchemaNode);
};

/** Every JSON-LD node in the HTML, `@graph` and arrays flattened. A block some
 *  mailer HTML-escaped is read after unescaping; a block that is not JSON is
 *  skipped. */
export const jsonLdNodes = (html: string): SchemaNode[] => {
  const out: SchemaNode[] = [];
  const { source, tags } = htmlTags(html);
  for (const tag of tags) {
    if (tag.closing || tag.name !== 'script' || tag.rawEnd === undefined) continue;
    const type = (attributesOf(tag.attributes).get('type') ?? '').trim().toLowerCase();
    if (!type.startsWith('application/ld+json')) continue;
    const raw = source.slice(tag.stop, tag.rawEnd).trim().replace(/^<!--|-->$/g, '').trim();
    if (raw.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      try {
        parsed = JSON.parse(decodeHtmlEntities(raw));
      } catch {
        continue;
      }
    }
    flattenJsonLd(parsed, out);
  }
  return out;
};

// ────────────────────────────────────────────────────────────────
// Microdata
// ────────────────────────────────────────────────────────────────

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** A start tag that closes an open element first, the way a browser does: the
 *  implied end tags machine-written mail relies on (`<li>a<li>b`, `<td>` after
 *  `<td>`). Each closes the nearest open one of `closes`, searching no further
 *  than `within`. */
const IMPLIED_END: Readonly<Record<string, { readonly closes: readonly string[]; readonly within: readonly string[] }>> = {
  li: { closes: ['li'], within: ['ul', 'ol', 'menu'] },
  dt: { closes: ['dt', 'dd'], within: ['dl'] },
  dd: { closes: ['dt', 'dd'], within: ['dl'] },
  tr: { closes: ['tr', 'td', 'th'], within: ['table', 'thead', 'tbody', 'tfoot'] },
  td: { closes: ['td', 'th'], within: ['tr', 'table'] },
  th: { closes: ['td', 'th'], within: ['tr', 'table'] },
  option: { closes: ['option'], within: ['select', 'datalist'] },
};
/** A block start tag closes an open `<p>` directly above it. */
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'footer', 'form', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);

/** The value an element with `itemprop` carries in an attribute, by element
 *  (the microdata rules); `undefined` when its value is its text. */
const attributeValue = (tag: string, attributes: Map<string, string>): string | undefined => {
  const pick = (name: string): string | undefined => attributes.get(name);
  switch (tag) {
    case 'meta': return pick('content');
    case 'a': case 'area': case 'link': return pick('href');
    case 'audio': case 'embed': case 'iframe': case 'img': case 'source': case 'track': case 'video': return pick('src');
    case 'object': return pick('data');
    case 'data': case 'meter': return pick('value');
    case 'time': return pick('datetime');
    default: return undefined;
  }
};

/** A type URL's last segment: `http://schema.org/Order` → `Order`. */
export const schemaTypeName = (type: string): string => {
  const trimmed = type.trim();
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('#'));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
};

interface MicrodataFrame {
  readonly tag: string;
  /** The item this element opens, if it has `itemscope`. */
  readonly item?: Record<string, unknown>;
  /** The item its `itemprop` values go to, found when it opened. */
  readonly parent?: Record<string, unknown>;
  readonly props: readonly string[];
  /** Set for a text-valued property: where its text starts. */
  readonly textFrom?: number;
}

/** An `itemprop` value on the item, by the item's own properties only: a
 *  sender's `constructor` or `__proto__` is a property like any, never what
 *  every object inherits (§9). */
const addProperty = (item: Record<string, unknown>, name: string, value: unknown): void => {
  const existing = Object.prototype.hasOwnProperty.call(item, name) ? item[name] : undefined;
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  Object.defineProperty(item, name, {
    value: existing === undefined ? value : [existing, value],
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

/** Microdata items (`itemscope` / `itemtype` / `itemprop`), in JSON-LD's shape.
 *  Unclosed elements are closed by the nearest matching end tag or the end of
 *  the HTML, the way a browser would close most of them. Each tag costs what
 *  it closes: an end tag nothing opened is known by a count, not a search, and
 *  the item a property belongs to is kept on a stack of its own. */
export const microdataNodes = (html: string): SchemaNode[] => {
  const { source, tags } = htmlTags(html);
  if (!/\bitemscope\b/i.test(source)) return [];
  const roots: SchemaNode[] = [];
  const stack: MicrodataFrame[] = [];
  const items: Record<string, unknown>[] = [];
  const open = new Map<string, number>();
  const text: string[] = [];

  const push = (frame: MicrodataFrame): void => {
    stack.push(frame);
    open.set(frame.tag, (open.get(frame.tag) ?? 0) + 1);
    if (frame.item !== undefined) items.push(frame.item);
  };
  const pop = (): void => {
    const frame = stack.pop()!;
    open.set(frame.tag, open.get(frame.tag)! - 1);
    if (frame.item !== undefined) items.pop();
    if (frame.textFrom === undefined || frame.parent === undefined) return;
    // At most MAX_TEXT_VALUE of it: a value is a name or a price, not a page.
    let value = '';
    for (let i = frame.textFrom; i < text.length && value.length < MAX_TEXT_VALUE; i += 1) value += text[i];
    value = collapse(value).slice(0, MAX_TEXT_VALUE);
    for (const name of frame.props) addProperty(frame.parent, name, value);
  };
  const isOpen = (names: readonly string[]): boolean => names.some((name) => (open.get(name) ?? 0) > 0);

  let cursor = 0;
  for (const tag of tags) {
    if (tag.start > cursor) text.push(decodeHtmlEntities(source.slice(cursor, tag.start)));
    // A script's or style's content is not text; JSON-LD is read separately.
    cursor = tag.rawEnd ?? tag.stop;
    if (tag.name === '!--' || RAW_TEXT.has(tag.name)) continue;
    if (tag.closing) {
      if (!isOpen([tag.name])) continue; // an end tag nothing opened
      while (stack[stack.length - 1]!.tag !== tag.name) pop();
      pop();
      continue;
    }
    // By its own entries only: a tag a sender named `constructor` is no rule.
    const implied = Object.prototype.hasOwnProperty.call(IMPLIED_END, tag.name) ? IMPLIED_END[tag.name] : undefined;
    if (implied !== undefined && isOpen(implied.closes)) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        const above = stack[i]!.tag;
        if (implied.within.includes(above)) break;
        if (implied.closes.includes(above)) {
          while (stack.length > i) pop();
          break;
        }
      }
    }
    if (BLOCK.has(tag.name) && stack[stack.length - 1]?.tag === 'p') pop();
    const attributes = attributesOf(tag.attributes);
    const props = (attributes.get('itemprop') ?? '').split(/\s+/).filter((name) => name.length > 0);
    const hasScope = attributes.has('itemscope');
    const parent = props.length > 0 ? items[items.length - 1] : undefined;
    let item: Record<string, unknown> | undefined;
    if (hasScope) {
      const type = (attributes.get('itemtype') ?? '').split(/\s+/).find((t) => t.length > 0);
      item = type !== undefined ? { '@type': schemaTypeName(type) } : {};
      if (parent !== undefined) for (const name of props) addProperty(parent, name, item);
      else roots.push(item as SchemaNode);
    }
    const selfClosing = VOID.has(tag.name) || /\/\s*$/.test(tag.attributes);
    let textFrom: number | undefined;
    if (!hasScope && parent !== undefined) {
      const value = attributeValue(tag.name, attributes);
      if (value !== undefined) for (const name of props) addProperty(parent, name, value);
      else if (!selfClosing) textFrom = text.length;
    }
    if (!selfClosing) {
      push({
        tag: tag.name,
        ...(item !== undefined ? { item } : {}),
        ...(parent !== undefined ? { parent } : {}),
        props,
        ...(textFrom !== undefined ? { textFrom } : {}),
      });
    }
  }
  if (cursor < source.length) text.push(decodeHtmlEntities(source.slice(cursor)));
  while (stack.length > 0) pop();
  return roots;
};

// ────────────────────────────────────────────────────────────────
// Links
// ────────────────────────────────────────────────────────────────

/** Every `<a href>`: its target and its text. An anchor opened inside another
 *  closes it, as a browser does; one never closed is dropped. */
export const htmlLinks = (html: string): { readonly href: string; readonly text: string }[] => {
  const { source, tags } = htmlTags(html);
  const links: { href: string; text: string }[] = [];
  let open: { href: string; from: number } | undefined;
  const finish = (to: number): void => {
    if (open === undefined) return;
    const inner = source.slice(open.from, Math.min(to, open.from + MAX_TEXT_VALUE * 4));
    links.push({ href: open.href, text: collapse(decodeHtmlEntities(inner.replace(/<[^>]*>/g, ' '))).slice(0, MAX_TEXT_VALUE) });
    open = undefined;
  };
  for (const tag of tags) {
    if (tag.name !== 'a') continue;
    if (tag.closing) {
      finish(tag.start);
      continue;
    }
    finish(tag.start);
    const href = attributesOf(tag.attributes).get('href');
    if (href !== undefined && href.length > 0) open = { href: href.trim(), from: tag.stop };
  }
  return links;
};
