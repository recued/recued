/** D-402 slice B2 — a selector for an element of a read, worked out on the server from the cleaned
 *  HTML the Bridge answered, and checked to match that one element there (§4, rule 3).
 *
 *  An element the AI named by ref, with no selector the Bridge recorded for it (a read, a scroll, a
 *  download, an older Bridge), keeps a name a later run can find: what its site is least likely to
 *  change first. An id that looks written by hand, a test id, a field's name, its accessible label, a
 *  placeholder, a title, a picture's description, a link's address, its readable class names; failing
 *  those alone, the same inside an ancestor a selector finds alone. Never its place among its
 *  siblings: a list that changes moves it (rule 10). None found answers undefined, and the compiler
 *  names the element by what it shows. (2026-11-20: but an answer's value in the item at the place
 *  the request names, "the second quote", is read by that place: `findValueInRead`'s `places`.)
 *
 *  The cleaned HTML is the Bridge's own strict grammar (`parseInspectHtml`), a closed list of
 *  attributes and at most three readable class names, so every selector here names only what the
 *  live page also carries. It leaves out hidden elements, so a selector unique here can match a hidden
 *  one too on a later run; slice G's Bridge refuses a write by a selector that matches several. */

import { cardKindOf, isOfCardKind, parseInspectHtml, type OutlineElement } from './page-outline.js';

interface Node { el: OutlineElement; parent: Node | undefined }
/** One element's part of a selector: its tag, id, classes and attributes. */
interface Compound { tag?: string; id?: string; classes?: string[]; attrs?: Array<[string, string]> }

const walk = (root: OutlineElement): Node[] => {
  const out: Node[] = [];
  const visit = (el: OutlineElement, parent: Node | undefined): void => {
    for (const child of el.children) {
      if (child.kind !== 'element') continue;
      const node = { el: child, parent };
      out.push(node);
      visit(child, node);
    }
  };
  visit(root, undefined);
  return out;
};

const attr = (el: OutlineElement, name: string): string | undefined => {
  const value = el.attrs[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};
/** An id or class a person wrote, not one a framework counted out. */
const STABLE_ID = /^[A-Za-z][\w-]{0,63}$/u;
const generated = (name: string): boolean => /\d{4,}|^(ember|react|ng-|__|:r|mui|css-|sc-|jsx-)/iu.test(name);
const classesOf = (el: OutlineElement): string[] => (attr(el, 'class') ?? '').split(/\s+/u)
  .filter((name) => /^[A-Za-z][\w-]{2,40}$/u.test(name) && !generated(name));

const matches = (el: OutlineElement, c: Compound): boolean => {
  if (c.tag !== undefined && el.tag !== c.tag) return false;
  if (c.id !== undefined && attr(el, 'id') !== c.id) return false;
  if (c.classes !== undefined) {
    const has = new Set((attr(el, 'class') ?? '').split(/\s+/u));
    if (!c.classes.every((name) => has.has(name))) return false;
  }
  return (c.attrs ?? []).every(([name, value]) => attr(el, name) === value);
};
const quote = (value: string): string => `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
const render = (c: Compound): string => (c.id !== undefined ? `#${c.id}`
  : `${c.tag ?? ''}${(c.classes ?? []).map((name) => `.${name}`).join('')}${(c.attrs ?? []).map(([name, value]) => `[${name}=${quote(value)}]`).join('')}`);

/** What a selector names: an element acted on (`target`), the very one the job meant; or one an answer
 *  was read from (`answer`), whose value changes from day to day, so not by what tends to carry that
 *  value (a link's address, a title, a label, a description). */
type Mode = 'target' | 'answer';

/** The parts that could name an element, most lasting first. */
const candidates = (el: OutlineElement, mode: Mode = 'target'): Compound[] => {
  const out: Compound[] = [];
  const id = attr(el, 'id');
  if (id !== undefined && STABLE_ID.test(id) && !generated(id)) out.push({ id });
  const testid = attr(el, 'data-testid');
  if (testid !== undefined) out.push({ attrs: [['data-testid', testid]] });
  for (const name of mode === 'target' ? ['name', 'aria-label', 'placeholder', 'title', 'alt'] : ['name']) {
    const value = attr(el, name);
    if (value !== undefined && value.length <= 200) out.push({ tag: el.tag, attrs: [[name, value]] });
  }
  // D-402 slice G — boxes of one name told apart by what each sends (Bridge 0.0.13 keeps a checkbox's or
  // a radio button's `value`): `input[name="checkboxes[]"][value="cb1"]`.
  const sends = attr(el, 'value');
  const box = el.tag === 'input' && ['checkbox', 'radio'].includes((attr(el, 'type') ?? '').toLowerCase());
  if (mode === 'target' && box && sends !== undefined && sends.length <= 200) {
    const name = attr(el, 'name');
    out.push({ tag: 'input', attrs: name !== undefined && name.length <= 200 ? [['name', name], ['value', sends]] : [['value', sends]] });
  }
  const href = attr(el, 'href');
  if (mode === 'target' && el.tag === 'a' && href !== undefined && href.length <= 200 && !href.startsWith('javascript:')) {
    out.push({ tag: 'a', attrs: [['href', href]] });
  }
  const classes = classesOf(el);
  for (const name of classes) out.push({ tag: el.tag, classes: [name] });
  if (classes.length > 1) out.push({ tag: el.tag, classes });
  const role = attr(el, 'role');
  if (role !== undefined) out.push({ tag: el.tag, attrs: [['role', role]] });
  const type = attr(el, 'type');
  if (type !== undefined) out.push({ tag: el.tag, attrs: [['type', type]] });
  out.push({ tag: el.tag });
  return out;
};

/** How many elements a chain of parts matches: the last part's element, inside the ones before. */
const count = (nodes: readonly Node[], chain: readonly Compound[], stopAt = 2): number => {
  let found = 0;
  for (const node of nodes) {
    if (!matches(node.el, chain[chain.length - 1]!)) continue;
    let index = chain.length - 2;
    for (let up = node.parent; up !== undefined && index >= 0; up = up.parent) if (matches(up.el, chain[index]!)) index -= 1;
    if (index < 0 && (found += 1) >= stopAt) return found;
  }
  return found;
};

/** A selector that matches `target` and nothing else in the read, or undefined. */
const selectorFor = (nodes: readonly Node[], target: Node, mode: Mode = 'target'): string | undefined => {
  const own = candidates(target.el, mode);
  const unique = (chain: Compound[]) => count(nodes, chain) === 1 && count([target], chain.slice(-1)) === 1;
  for (const c of own) if (unique([c])) return render(c);
  let depth = 0;
  for (let up = target.parent; up !== undefined && depth < 8; up = up.parent, depth += 1) {
    const anchors = candidates(up.el).filter((c) => c.id !== undefined || c.attrs !== undefined || c.classes !== undefined);
    // An ancestor a selector finds alone: `<it> <part>` then matches only the parts inside it.
    const anchor = anchors.find((c) => count(nodes, [c]) === 1);
    if (anchor === undefined) continue;
    const inside = nodes.filter((node) => {
      for (let p = node.parent; p !== undefined; p = p.parent) if (p === up) return true;
      return false;
    });
    for (const c of own) {
      const found = inside.filter((node) => matches(node.el, c));
      if (found.length === 1 && found[0] === target) return `${render(anchor)} ${render(c)}`;
    }
  }
  return undefined;
};

/** The selector for the element a read gave this ref, or undefined. */
export const selectorForRef = (html: string, ref: string): string | undefined => {
  if (!html.includes(`ref="${ref}"`)) return undefined;
  const nodes = walk(parseInspectHtml(html));
  const target = nodes.find((node) => node.el.attrs.ref === ref);
  return target === undefined ? undefined : selectorFor(nodes, target);
};

/** What an element shows: its text, its parts' text, spaces collapsed. */
export const elementText = (el: OutlineElement): string => {
  const parts: string[] = [];
  const visit = (node: OutlineElement): void => {
    for (const child of node.children) {
      if (child.kind === 'text') parts.push(child.text);
      else visit(child);
    }
  };
  visit(el);
  return parts.join(' ').replace(/\s+/gu, ' ').trim();
};

/** The text of the element a read gave this ref, or undefined. */
export const textForRef = (html: string, ref: string): string | undefined => {
  if (!html.includes(`ref="${ref}"`)) return undefined;
  const target = walk(parseInspectHtml(html)).find((node) => node.el.attrs.ref === ref);
  if (target === undefined) return undefined;
  const shown = elementText(target.el) || attr(target.el, 'aria-label') || attr(target.el, 'title') || attr(target.el, 'alt');
  return shown === undefined || shown === '' ? undefined : shown.slice(0, 200);
};

/** Set aside case, spacing and quotes, as a value is compared with what a page shows. */
const plain = (value: string): string => value.normalize('NFKC').toLowerCase()
  .replace(/["'`‘’“”«»]/gu, '').replace(/\s+/gu, ' ').trim();
/** A value with its spacing taken out, for matching a page that draws a space by an element. */
const squashed = (value: string): string => plain(value).replace(/\s+/gu, '');

/** D-402 slice B2b — where a read shows a value (§4, rule 7): an element a selector finds alone, read
 *  as text; or, for a value in a row of a table or in a definition, the row's label, read with `find`,
 *  since the label stays when the value changes. */
export interface ValueInRead {
  selector?: string;
  /** The selector matches several elements alike, of which the value's was the first: it reads the
   *  first one on another day too (a top story, the newest message). */
  first?: true;
  /** 2026-11-20 — the place among items alike that the request named ("the second quote"), which the
   *  selector reads by (`div.quote:nth-of-type(2) small.author`). */
  place?: number;
  find?: string;
  /** What the element showed. */
  text: string;
}

/** A selector for `target` by the place `k` (from 2) its item holds among the items alike beside it:
 *  the nearest of it and its ancestors that is the k-th child of its tag, every child of that tag a
 *  child of one class, so `:nth-of-type` counts the items as the read shows them. Then the value's own
 *  element inside that item. Undefined when none is. */
const placed = (nodes: readonly Node[], target: Node, k: number): string | undefined => {
  if (k < 2) return undefined;
  const ofTag = (node: Node) => nodes.filter((other) => other.parent === node.parent && other.el.tag === node.el.tag);
  let depth = 0;
  for (let item: Node | undefined = target; item !== undefined && depth < 5; item = item.parent, depth += 1) {
    const siblings = ofTag(item);
    if (siblings.indexOf(item) !== k - 1) continue;
    for (const name of classesOf(item.el)) {
      if (!siblings.every((node) => classesOf(node.el).includes(name))) continue;
      const tag = item.el.tag;
      // One item in the read at that place: no other list of the class has one there.
      if (nodes.filter((node) => node.el.tag === tag && classesOf(node.el).includes(name) && ofTag(node).indexOf(node) === k - 1).length !== 1) continue;
      const base = `${tag}.${name}:nth-of-type(${String(k)})`;
      if (item === target) return base;
      const holder = item;
      const inside = nodes.filter((node) => within(node, holder));
      for (const c of candidates(target.el, 'answer')) {
        const found = inside.filter((node) => matches(node.el, c));
        if (found.length === 1 && found[0] === target) return `${base} ${render(c)}`;
      }
    }
  }
  return undefined;
};

const elementsOf = (el: OutlineElement): OutlineElement[] =>
  el.children.filter((child): child is OutlineElement => child.kind === 'element');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** A text with commas and semicolons set aside. */
// 2026-11-20 — and a list's "and" ("books, inspirational, reading, and tea" for four tags, task H).
const looseText = (value: string): string => plain(value).replace(/[,;]/gu, ' ').replace(/(?:^|\s)(?:and|&)(?=\s|$)/gu, ' ')
  .replace(/\s+/gu, ' ').trim();
/** D-402 slice B4 — a date's usual forms, as `looseText` writes them: "20 january 2012", "january 20
 *  2012", "2012-01-20". None for a value that is not a date. */
const dateForms = (value: string): string[] => {
  const shown = looseText(value);
  let day: number, month: number, year: string;
  const dayFirst = /^(\d{1,2}) ([a-z]+) (\d{4})$/u.exec(shown);
  const monthFirst = /^([a-z]+) (\d{1,2}) (\d{4})$/u.exec(shown);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(shown);
  if (dayFirst !== null && MONTHS.includes(dayFirst[2]!)) [day, month, year] = [Number(dayFirst[1]), MONTHS.indexOf(dayFirst[2]!) + 1, dayFirst[3]!];
  else if (monthFirst !== null && MONTHS.includes(monthFirst[1]!)) [day, month, year] = [Number(monthFirst[2]), MONTHS.indexOf(monthFirst[1]!) + 1, monthFirst[3]!];
  else if (iso !== null) [day, month, year] = [Number(iso[3]), Number(iso[2]), iso[1]!];
  else return [];
  if (month < 1 || month > 12 || day < 1 || day > 31) return [];
  const name = MONTHS[month - 1]!;
  return [`${String(day)} ${name} ${year}`, `${name} ${String(day)} ${year}`, `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`];
};

/** Whether `node` sits inside `ancestor`. */
const within = (node: Node, ancestor: Node): boolean => {
  for (let up = node.parent; up !== undefined; up = up.parent) if (up === ancestor) return true;
  return false;
};

/** The label of the row a value sits in: its table row's heading cell (or first other cell), its
 *  definition's term, or a list item's bold lead. Undefined when there is none, or it holds the value. */
const rowLabel = (node: Node, needle: string): string | undefined => {
  const usable = (text: string | undefined): string | undefined => {
    const label = text?.replace(/[:\s]+$/u, '').trim();
    // Never the value itself, spacing aside (a value matched with its spacing taken out).
    return label !== undefined && label.length >= 2 && label.length <= 100 && !plain(label).includes(needle)
      && !squashed(label).includes(needle.replace(/\s+/gu, '')) ? label : undefined;
  };
  let cell: Node = node;
  for (let up: Node | undefined = node, depth = 0; up !== undefined && depth < 5; up = up.parent, depth += 1) {
    if (up.el.tag === 'tr') {
      const cells = elementsOf(up.el).filter((child) => child.tag === 'th' || child.tag === 'td');
      const heading = cells.find((child) => child.tag === 'th' && child !== cell.el);
      return usable(heading !== undefined ? elementText(heading) : elementText(cells.find((child) => child !== cell.el) ?? up.el));
    }
    if (up.el.tag === 'dd' && up.parent !== undefined) {
      const siblings = elementsOf(up.parent.el);
      const term = siblings.slice(0, siblings.indexOf(up.el)).reverse().find((child) => child.tag === 'dt');
      return term === undefined ? undefined : usable(elementText(term));
    }
    if (up.el.tag === 'li') {
      const lead = elementsOf(up.el)[0];
      return lead !== undefined && ['b', 'strong'].includes(lead.tag) ? usable(elementText(lead)) : undefined;
    }
    cell = up;
  }
  return undefined;
};

export const findValueInRead = (html: string, value: string, loose = false, places: readonly number[] = []): ValueInRead | undefined => {
  const needle = plain(value);
  if (needle.length < 2) return undefined;
  // Slice B4 — loosely, as an answer may write what a page shows: commas and semicolons set aside
  // ("Robert Griesemer, Rob Pike, Ken Thompson" for a cell of three links), and a date in each of
  // its usual forms ("20 January 2012" for "January 20, 2012").
  const form = loose ? looseText : plain;
  const needles = loose ? [...new Set([looseText(value), ...dateForms(value)])] : [needle];
  const root = parseInspectHtml(html);
  const nodes = walk(root);
  const exact = new Set<Node>();
  const near = new Set<Node>();
  const holding =(shape: (text: string) => string, wants: readonly string[]) => {
    for (const node of nodes) {
      const shown = shape(elementText(node.el));
      for (const wanted of wants) {
        if (!shown.includes(wanted)) continue;
        if (shown === wanted) exact.add(node);
        // An element that holds the value with much else around it is a section, not the value's own.
        else if (shown.length <= Math.max(80, wanted.length * 2)) near.add(node);
      }
    }
  };
  holding(form, needles);
  // 2026-11-20 — else spacing aside: a page draws a thin space by an empty element (Wikipedia's
  //   "(c.<span></span>1843)"), so its text reads "c.1843" where the page shows, and the answer writes,
  //   "c. 1843" (benchmark task C). Only for a value of some length, and only once nothing else matched.
  if (exact.size === 0 && near.size === 0 && squashed(value).length >= 6) holding(squashed, needles.map(squashed));
  // The value's own elements: those holding it exactly when any do, and of those the innermost (the
  // link in a cell, not the cell). Slice B4 — every place the page shows it, in the page's order: a
  // name in an infobox's row is shown again in the links at the page's foot, and the row reads it.
  const held = exact.size > 0 ? exact : near;
  const own = nodes.filter((node) => held.has(node) && !nodes.some((other) => other !== node && held.has(other) && within(other, node)));
  if (own.length === 0) return undefined;
  // A row's label is read with `find`, which answers every line that holds it: only a label the page
  // shows once. 2026-11-20 — Hacker News ranks its stories "1.", "2.", … "11.", so a top story's row label
  // read the 11th and 21st with it (benchmark task B); such a label is a last resort, after a selector.
  const page = plain(elementText(root));
  let shared: { find: string; text: string } | undefined;
  for (const node of own) {
    const label = rowLabel(node, needle);
    if (label === undefined) continue;
    if (page.split(plain(label)).length - 1 <= 1) return { find: label, text: elementText(node.el) };
    shared ??= { find: label, text: elementText(node.el) };
  }
  for (const node of own) {
    const selector = selectorFor(nodes, node, 'answer');
    if (selector !== undefined) return { selector, text: elementText(node.el) };
  }
  const first = own[0]!;
  const text = elementText(first.el);
  // Several alike, the value's the first of them: read as the first (a top story, the newest message).
  for (const c of candidates(first.el, 'answer').filter((part) => part.classes !== undefined)) {
    if (nodes.find((node) => matches(node.el, c)) === first) return { selector: render(c), first: true, text };
  }
  // 2026-11-20 — or, with no class of its own (a story's title link), by its tag inside the nearest
  //   ancestor a class names, when it is the first such in the read: `span.titleline a` (task B). Only an
  //   item first in its list: it and each element up to that ancestor the first of its tag beside it. A
  //   class every other row carries is no list of its own: "Bob Williams", the first cell of the first
  //   `tr.even`, sat in the table's second row (task M), and a run whose page drew no `tr.even` stopped.
  const firstOfTag = (node: Node): boolean => nodes.find((other) => other.parent === node.parent && other.el.tag === node.el.tag) === node;
  let leading = firstOfTag(first);
  for (let up = first.parent, depth = 0; leading && up !== undefined && depth < 3; up = up.parent, depth += 1) {
    leading = firstOfTag(up);
    if (!leading) break;
    for (const c of candidates(up.el, 'answer').filter((part) => part.classes !== undefined && part.attrs === undefined)) {
      const inside = (node: Node): boolean => {
        for (let p = node.parent; p !== undefined; p = p.parent) if (matches(p.el, c)) return true;
        return false;
      };
      if (nodes.find((node) => node.el.tag === first.el.tag && inside(node)) === first) {
        return { selector: `${render(c)} ${first.el.tag}`, first: true, text };
      }
    }
  }
  // 2026-11-20 — or by its place, when the request names it ("the second quote", task H). A list that
  //   changes moves an item (rule 10), but the place is then what the request asked for.
  for (const place of places) {
    const selector = placed(nodes, first, place);
    if (selector !== undefined) return { selector, place, text };
  }
  if (shared !== undefined) return shared;
  // Slice B4 — else the section it sits in, by its heading, which a read with `find` answers whole.
  // Not the page's own title (`h1`), whose section is the whole page.
  let heading: string | undefined;
  for (const node of nodes) {
    if (node === first) break;
    if (/^h[2-6]$/u.test(node.el.tag)) {
      const shown = elementText(node.el).replace(/\[edit\]$/iu, '').trim();
      if (shown.length >= 2 && shown.length <= 100 && !plain(shown).includes(needle)) heading = shown;
    }
  }
  return heading !== undefined ? { find: heading, text } : { text };
};

/** D-402 slice E3a (§6.1, "picked one of several items") — the list a job picked one item from, as a read
 *  showed it: the elements alike to the one whose whole text it chose (or to what wraps it alone), by a
 *  class two or more of them share, else by their tag inside the nearest container a selector finds
 *  alone. Never by place among them. Undefined when the read did not show the item, or nothing alike. */
export const choicesInRead = (html: string, chose: string): { items: string; count: number } | undefined => {
  const needle = plain(chose);
  if (needle.length < 2) return undefined;
  const nodes = walk(parseInspectHtml(html));
  const exact = new Set(nodes.filter((node) => plain(elementText(node.el)) === needle));
  const own = [...exact].filter((node) => ![...exact].some((other) => other !== node && within(other, node)));
  for (const node of own) {
    const outward: Node[] = [];
    for (let at: Node | undefined = node; at !== undefined && exact.has(at); at = at.parent) outward.push(at);
    for (const at of outward) {
      for (const part of candidates(at.el, 'answer').filter((one) => one.classes !== undefined)) {
        const alike: Node[] = nodes.filter((one) => matches(one.el, part));
        if (alike.length >= 2 && alike.includes(at)) return { items: render(part), count: alike.length };
      }
      const ups: Node[] = [];
      for (let up: Node | undefined = at.parent; up !== undefined; up = up.parent) ups.push(up);
      for (const up of ups) {
        const anchor = candidates(up.el).find((one) => (one.id !== undefined || one.attrs !== undefined || one.classes !== undefined)
          && count(nodes, [one]) === 1);
        if (anchor === undefined) continue;
        const inside: Node[] = nodes.filter((one) => one.el.tag === at.el.tag && within(one, up));
        if (inside.length >= 2) return { items: `${render(anchor)} ${at.el.tag}`, count: inside.length };
        break;
      }
    }
  }
  return undefined;
};

/** D-402 slice E1 (§6.1) — whether a read showed a value anywhere in its text (case, spacing and quotes
 *  set aside), whether or not one element holds it. */
export const readShows = (html: string, value: string): boolean => {
  const needle = plain(value);
  if (needle.length < 2) return false;
  const tops = walk(parseInspectHtml(html)).filter((node) => node.parent === undefined).map((node) => elementText(node.el));
  // 2026-11-20 — spacing aside too, as `findValueInRead` matches a value of some length (task C's caption).
  const flat = squashed(value);
  return tops.some((text) => plain(text).includes(needle) || (flat.length >= 6 && squashed(text).includes(flat)));
};

/** D-402 slice E4d — a value as a read shows it, in the page's own case and spacing. `readShows` finds
 *  a value whatever its case, but a recipe's test of a page's text is exact (`contains` is
 *  case-sensitive), so a decision written as a label gave it ("in stock") would hold against the very
 *  page the job went on with ("In stock"). Undefined when the read does not show it. */
export const shownAs = (html: string, value: string): string | undefined => {
  const needle = plain(value);
  if (needle.length < 2) return undefined;
  const pattern = new RegExp(needle.split(' ').map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+'), 'iu');
  for (const node of walk(parseInspectHtml(html))) {
    if (node.parent !== undefined) continue;
    const found = pattern.exec(elementText(node.el).normalize('NFKC'));
    if (found !== null) return found[0].replace(/\s+/gu, ' ');
  }
  return undefined;
};

/** D-402 slice D4 (§5) — where a read showed a value a later step typed. */
export interface ValueElement {
  /** A selector that finds the element whose whole text was the value alone, or (`first`) the first of
   *  several alike, as a read takes it. Undefined when none finds it. */
  selector?: string;
  first?: true;
  /** The elements whose whole text was the value, when there were several. */
  places?: number;
  /** The value sat only inside a longer text: the shortest that held it. */
  partial?: string;
}

/** D-402 slice D4 (§5) — the element a read showed a typed value in: the innermost whose whole text is
 *  the value (case, spacing and quotes set aside), else one around it showing the same text (the cell
 *  around a link), by a selector that finds it alone; else, the value's the first of several alike.
 *  Undefined when the read did not show the value at all. */
export const valueElementInRead = (html: string, value: string): ValueElement | undefined => {
  const needle = plain(value);
  if (needle.length < 2) return undefined;
  const nodes = walk(parseInspectHtml(html));
  const exact = new Set(nodes.filter((node) => plain(elementText(node.el)) === needle));
  if (exact.size === 0) {
    const holding = nodes.filter((node) => plain(elementText(node.el)).includes(needle));
    const shortest = holding.map((node) => elementText(node.el)).sort((a, b) => a.length - b.length)[0];
    return shortest === undefined ? undefined : { partial: shortest.length > 200 ? `${shortest.slice(0, 200).trimEnd()}…` : shortest };
  }
  const own = [...exact].filter((node) => ![...exact].some((other) => other !== node && within(other, node)));
  const places = own.length > 1 ? { places: own.length } : {};
  /** The element and those around it that show the same text, innermost first. */
  const outward = (node: Node): Node[] => {
    const out: Node[] = [];
    for (let at: Node | undefined = node; at !== undefined && exact.has(at); at = at.parent) out.push(at);
    return out;
  };
  for (const node of own) {
    for (const at of outward(node)) {
      const selector = selectorFor(nodes, at, 'answer');
      if (selector !== undefined) return { selector, ...places };
    }
  }
  // Several alike, the value's the first of them, by a class on it or on what wraps it alone.
  for (const at of outward(own[0]!)) {
    for (const c of candidates(at.el, 'answer').filter((part) => part.classes !== undefined)) {
      if (nodes.find((node) => matches(node.el, c)) === at) return { selector: render(c), first: true, ...places };
    }
  }
  return places;
};

/** D-402 slice D5b (§4 rule 9) — a list of page links, as a read showed it. */
export interface PageLinks {
  /** A selector for the links of the list (its numbers, and any "Previous" or "Next" beside them), which
   *  a collect takes. */
  items: string;
  /** A selector for what marks the current page (a class or `aria-current` on its link, or on the item
   *  the link sits in, that no other number's has), which matches that one element in the read. */
  marker?: string;
  /** The number the read showed as the current page. */
  current?: number;
}

/** D-402 slice D5b (§4 rule 9) — the page links whose numbers the job clicked, in the read before it
 *  did: the nearest list holding one link of each number, the links of that list by a selector, and the
 *  current page's mark. Undefined when the read did not show each number as a link, or no selector a
 *  collect takes finds the list. */
export const pageLinksInRead = (html: string, labels: readonly string[]): PageLinks | undefined => {
  const nodes = walk(parseInspectHtml(html));
  const linkish = (node: Node): boolean => ['a', 'button'].includes(node.el.tag) || ['link', 'button'].includes(attr(node.el, 'role') ?? '');
  const numbered = nodes.filter((node) => linkish(node) && /^\d{1,3}$/u.test(elementText(node.el)));
  const clicked = labels.map((label) => numbered.filter((node) => elementText(node.el) === label));
  if (labels.length === 0 || clicked.some((found) => found.length === 0)) return undefined;
  let list: Node | undefined = clicked[0]![0]!.parent;
  while (list !== undefined && !clicked.every((found) => found.some((node) => within(node, list!)))) list = list.parent;
  if (list === undefined) return undefined;
  const listSelector = selectorFor(nodes, list);
  const tag = clicked[0]![0]!.el.tag;
  if (listSelector === undefined || clicked.some((found) => found.every((node) => node.el.tag !== tag))) return undefined;
  const items = `${listSelector} ${tag}`;
  // The current page: at the link, or at an element around it inside the list, one number's alone has a
  // class (or `aria-current`) the others' have not.
  const pages = numbered.filter((node) => within(node, list!));
  const at = (node: Node, depth: number): Node | undefined => {
    let up: Node | undefined = node;
    for (let k = 0; k < depth && up !== undefined; k += 1) up = up.parent;
    return up !== undefined && up !== list && within(up, list!) ? up : undefined;
  };
  for (let depth = 0; depth < 3; depth += 1) {
    const levels = pages.map((node) => at(node, depth));
    if (levels.some((level) => level === undefined)) break;
    const els = levels as Node[];
    const current = els.filter((el) => attr(el.el, 'aria-current') !== undefined && attr(el.el, 'aria-current') !== 'false');
    const byAria = current.length === 1 ? current[0] : undefined;
    const counts = new Map<string, number>();
    for (const el of els) for (const name of classesOf(el.el)) counts.set(name, (counts.get(name) ?? 0) + 1);
    const lone = [...counts].filter(([, n]) => n === 1).map(([name]) => name);
    const byClass = lone.length === 1 ? els.find((el) => classesOf(el.el).includes(lone[0]!)) : undefined;
    const marked = byAria ?? byClass;
    if (marked === undefined) continue;
    const marker = byAria !== undefined ? `${listSelector} [aria-current=${quote(attr(marked.el, 'aria-current')!)}]`
      : `${listSelector} ${marked.el.tag}.${lone[0]!}`;
    const shown = Number(elementText(pages[els.indexOf(marked)]!.el));
    return { items, marker, current: shown };
  }
  return { items };
};

/** D-402 slice G (§4.1) — the texts the row around the element a ref names shows, beside its own: the
 *  nearest list item, table row, article or row by its role above it (the Bridge's own list), read as
 *  its leaf elements' texts (the sender, the subject), never the element's own nor another control's.
 *  Undefined for an element in no row, or a row that shows nothing else. At most three. */
export const rowTextsForRef = (html: string, ref: string): string[] | undefined => {
  const nodes = walk(parseInspectHtml(html));
  const target = nodes.find((node) => node.el.attrs.ref === ref);
  if (target === undefined) return undefined;
  let row: Node | undefined;
  for (let up = target.parent; up !== undefined; up = up.parent) {
    if (['li', 'tr', 'article'].includes(up.el.tag) || ['row', 'listitem', 'option', 'article'].includes(String(up.el.attrs.role ?? ''))) {
      row = up; break;
    }
  }
  if (row === undefined) return undefined;
  const controls = new Set(['a', 'button', 'input', 'select', 'textarea', 'label']);
  const texts: string[] = [];
  const visit = (node: OutlineElement, inside: boolean): void => {
    if (inside || node === target.el || controls.has(node.tag) || node.attrs.ref !== undefined) return;
    const leaf = node.children.every((child) => child.kind === 'text');
    if (leaf) {
      const shown = elementText(node).trim();
      if (/\w{2,}/u.test(shown) && shown.length <= 200 && !texts.includes(shown)) texts.push(shown);
      return;
    }
    for (const child of node.children) if (child.kind === 'element') visit(child, false);
  };
  for (const child of row.el.children) if (child.kind === 'element') visit(child, false);
  return texts.length > 0 ? texts.slice(0, 3) : undefined;
};

/** D-402 slice G — how many rows of a read show every one of these texts and hold an element so named.
 *  2026-11-21 (task P) — or, with `card`, how many cards of that kind (`isOfCardKind`). */
export const rowsShowing = (html: string, texts: readonly string[], name: string, card?: string): number => {
  const nodes = walk(parseInspectHtml(html));
  const wanted = texts.map(plain);
  const label = plain(name);
  return nodes.filter((node) => (card !== undefined ? isOfCardKind(node.el, card) : ['li', 'tr', 'article'].includes(node.el.tag)
    || ['row', 'listitem', 'option', 'article'].includes(String(node.el.attrs.role ?? '')))
    && wanted.every((text) => plain(elementText(node.el)).includes(text))
    && nodes.some((inner) => within(inner, node) && plain(elementText(inner.el)) === label)).length;
};

/** 2026-11-21 (D-402, task P) — the cards around the element a ref names, when no row holds it: each kind of
 *  card above it that the read shows more than once (`cardKindOf`), nearest first, with the nearest element
 *  of that kind (as the Bridge's `closest()` finds it) and every text it shows beside its controls and the
 *  element's own, as `rowTextsForRef` reads a row's. Undefined in a row, or in none. */
export const cardsForRef = (html: string, ref: string): Array<{ card: string; texts: string[] }> | undefined => {
  const nodes = walk(parseInspectHtml(html));
  const target = nodes.find((node) => node.el.attrs.ref === ref);
  if (target === undefined) return undefined;
  const above: Node[] = [];
  for (let up = target.parent; up !== undefined; up = up.parent) {
    if (['li', 'tr', 'article'].includes(up.el.tag) || ['row', 'listitem', 'option', 'article'].includes(String(up.el.attrs.role ?? ''))) return undefined;
    above.push(up);
  }
  const controls = new Set(['a', 'button', 'input', 'select', 'textarea', 'label']);
  const textsOf = (card: Node): string[] => {
    const texts: string[] = [];
    const visit = (node: OutlineElement): void => {
      if (node === target.el || controls.has(node.tag) || node.attrs.ref !== undefined) return;
      if (node.children.every((child) => child.kind === 'text')) {
        const shown = elementText(node).trim();
        if (/\w{2,}/u.test(shown) && shown.length <= 200 && !texts.includes(shown)) texts.push(shown);
        return;
      }
      for (const child of node.children) if (child.kind === 'element') visit(child);
    };
    for (const child of card.el.children) if (child.kind === 'element') visit(child);
    return texts;
  };
  const out: Array<{ card: string; texts: string[] }> = [];
  for (const kind of new Set(above.map((node) => cardKindOf(node.el)).filter((one): one is string => one !== undefined))) {
    if (nodes.filter((node) => isOfCardKind(node.el, kind)).length < 2) continue;
    const texts = textsOf(above.find((node) => isOfCardKind(node.el, kind))!);
    if (texts.length > 0) out.push({ card: kind, texts });
  }
  return out.length > 0 ? out : undefined;
};

/** D-402 slice B4 — how many elements a read showed under a name, as a step names one by what it shows:
 *  its text, or for a field its `aria-label`, `title`, `placeholder` or `name` (Q's three checkboxes are
 *  each "checkboxes[]"). The innermost of an element and the ones around it that show the same text. */
export const countShowing = (html: string, shown: string): number => {
  const wanted = plain(shown);
  if (wanted === '') return 0;
  const nodes = walk(parseInspectHtml(html));
  const named = new Set(nodes.filter((node) => plain(elementText(node.el)) === wanted
    || ['aria-label', 'title', 'placeholder', 'name'].some((key) => typeof node.el.attrs[key] === 'string' && plain(node.el.attrs[key] as string) === wanted)));
  return [...named].filter((node) => ![...named].some((other) => other !== node && within(other, node))).length;
};

/** D-402 slice B3 — whether a read showed an element a simple selector names (ids, tags, classes,
 *  attributes, and descendants of those): true or false; undefined for a selector this cannot read
 *  (`>`, `:`, `+`, `~`, `*`), which the caller treats as unknown. */
export const selectorInRead = (html: string, selector: string): boolean | undefined => {
  const parts = selector.trim().split(/\s+/u);
  const chain: Compound[] = [];
  for (const part of parts) {
    if (/[>:+~*]/u.test(part) || part === '') return undefined;
    const compound: Compound = {};
    const pattern = /([#.]?)([\w-]+)|\[([\w-]+)="([^"]*)"\]/gu;
    let consumed = '';
    for (const match of part.matchAll(pattern)) {
      consumed += match[0];
      if (match[3] !== undefined) (compound.attrs ??= []).push([match[3], match[4]!]);
      else if (match[1] === '#') compound.id = match[2]!;
      else if (match[1] === '.') (compound.classes ??= []).push(match[2]!);
      else compound.tag = match[2]!.toLowerCase();
    }
    if (consumed !== part) return undefined;
    chain.push(compound);
  }
  return count(walk(parseInspectHtml(html)), chain, 1) > 0;
};

/** D-402 rule 6 (2026-11-20) — an element a later read of a page shows and an earlier read of it did not: what
 *  a pause with no action before it waited for, such as quotes a page's script draws seconds after it loads
 *  (benchmark task H). The first, in the later read's order, that shows some text and that a readable id,
 *  test id, name, class, role or type names, where nothing in the earlier read matches it; never one only its
 *  tag names. Undefined when the later read shows nothing new by such a name. */
export const appearedInRead = (before: string, after: string): string | undefined => {
  const was = walk(parseInspectHtml(before));
  for (const node of walk(parseInspectHtml(after))) {
    if (elementText(node.el).trim() === '') continue;
    for (const part of candidates(node.el, 'answer')) {
      if (part.id === undefined && part.classes === undefined && part.attrs === undefined) continue;
      if (!was.some((other) => matches(other.el, part))) return render(part);
    }
  }
  return undefined;
};
