import { BRIDGE_INSPECT_CEILING_CHARS, BROWSER_FIELD_TAGS, isBrowserTitleTag,
  type BrowserEvidenceValue, type BrowserEvidenceItem, type BrowserFieldEvidence } from '@recued/contracts';
export type { BrowserEvidenceValue, BrowserEvidenceItem, BrowserFieldEvidence } from '@recued/contracts';
import { parseInspectHtml, type OutlineElement, type OutlineNode } from './page-outline.js';

/** A small companion to the outline, derived only from the same cleaned read.
 * Values name their DOM source; an attribute is never promoted to visible text. */
export const BROWSER_FIELD_EVIDENCE_CHARS = 4_000;
export const BROWSER_FIELD_EVIDENCE_ITEMS = 16;
const VALUE_CHARS = 1_000;
const MAX_NODES = 15_000;
const NOTE = 'Copy requested values exactly, including punctuation. Attributes and text are separate sources; alt is not a caption. This is a bounded field view, not a page inventory.';
type Source = BrowserEvidenceValue['source'];
const attr = (node: OutlineElement, name: string) => typeof node.attrs[name] === 'string' ? node.attrs[name] as string : undefined;
const omitted = (node: OutlineElement) => ['nav', 'header', 'footer', 'script', 'style', 'template', 'noscript', 'input', 'textarea', 'select'].includes(node.tag)
  || Object.hasOwn(node.attrs, 'hidden') || attr(node, 'aria-hidden') === 'true';

export const browserFieldEvidence = (html: string, options: { whole: boolean; truncated: boolean }): BrowserFieldEvidence | undefined => {
  const incomplete = new Set<string>(options.truncated ? ['page_truncated'] : []);
  let scope: BrowserFieldEvidence['scope'] = options.whole ? 'page' : 'region';
  const result = (items: BrowserEvidenceItem[]): BrowserFieldEvidence => ({ scope, items, complete: incomplete.size === 0,
    ...(incomplete.size ? { incomplete: [...incomplete] } : {}), note: NOTE });
  // The ordinary outline read is capped at 600,000 characters too. Do not parse an unbounded caller input.
  if (html.length > BRIDGE_INSPECT_CEILING_CHARS) { incomplete.add('source_limit'); return result([]); }
  const root = parseInspectHtml(html), parents = new Map<OutlineElement, OutlineElement>();
  const depths = new Map<OutlineElement, number>([[root, 0]]);
  const all: OutlineElement[] = [], pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (all.length >= MAX_NODES) { incomplete.add('node_limit'); return result([]); }
    if (depths.get(node)! > 128) { incomplete.add('depth_limit'); return result([]); }
    if (omitted(node)) continue;
    all.push(node);
    for (const child of [...node.children].reverse()) if (child.kind === 'element') {
      parents.set(child, node); depths.set(child, depths.get(node)! + 1); pending.push(child);
    }
  }
  const articles = all.filter(node => node.tag === 'article');
  const main = options.whole ? all.find(node => node.tag === 'main' || attr(node, 'role') === 'main')
    ?? (articles.length === 1 ? articles[0] : undefined) : undefined;
  if (main) scope = 'main';
  const inside = (node: OutlineElement, ancestor: OutlineElement): boolean => {
    for (let at: OutlineElement | undefined = node; at; at = parents.get(at)) if (at === ancestor) return true;
    return false;
  };
  const value = (raw: string, source: Source, cut = false): BrowserEvidenceValue => {
    const normalized = raw.replace(/\s+/g, ' ').trim();
    const truncated = cut || normalized.length > VALUE_CHARS;
    if (truncated) incomplete.add('value_truncated');
    // Keep a surrogate pair together when a value reaches its limit.
    let text = normalized.slice(0, VALUE_CHARS);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    return { value: text, source, ...(truncated ? { truncated: true as const } : {}) };
  };
  const text = (node: OutlineElement, source: Source, exclude?: OutlineElement): BrowserEvidenceValue => {
    const stack: OutlineNode[] = [...node.children].reverse(); let raw = '', visited = 0;
    while (stack.length) {
      if (++visited > MAX_NODES) return value(raw, source, true);
      const child = stack.pop()!;
      if (child === exclude) continue;
      if (child.kind === 'text') {
        raw += /\w$/.test(raw) && /^\w/.test(child.text) ? ' ' + child.text : child.text;
        if (raw.length > VALUE_CHARS) return value(raw, source, true);
      } else if (!omitted(child) && child.tag !== 'img') {
        if (['br', 'hr'].includes(child.tag)) raw += ' ';
        else stack.push(...[...child.children].reverse());
      }
    }
    return value(raw, source);
  };
  const ancestor = (node: OutlineElement, tags: string[], roles: string[] = []) => {
    for (let at = parents.get(node); at; at = parents.get(at)) {
      if (tags.includes(at.tag) || roles.includes(attr(at, 'role') ?? '')) return at;
    }
    return undefined;
  };
  const imageCounts = new Map<OutlineElement, number>(), captionsByFigure = new Map<OutlineElement, OutlineElement[]>();
  for (const node of all) {
    if (node.tag === 'img') {
      for (let at = parents.get(node); at; at = parents.get(at)) if (['figure', 'td', 'th'].includes(at.tag)) {
        imageCounts.set(at, (imageCounts.get(at) ?? 0) + 1);
      }
    } else if (node.tag === 'figcaption') {
      const figure = ancestor(node, ['figure']);
      if (figure) captionsByFigure.set(figure, [...(captionsByFigure.get(figure) ?? []), node]);
    }
  }
  // Keep the existing evidence ahead of additional titles within the same limits.
  const primary = (node: OutlineElement) => BROWSER_FIELD_TAGS.includes(node.tag);
  const titles = all.filter(node => !primary(node) && isBrowserTitleTag(node.tag) && attr(node, 'title')?.trim());
  const items: BrowserEvidenceItem[] = [];
  for (const node of [...all.filter(primary), ...titles]) {
    if (main && !inside(node, main)) continue;
    const fields: BrowserEvidenceItem['fields'] = {};
    if (node.tag !== 'img') {
      const own = text(node, 'textContent');
      if (own.value) fields.text = own;
      if (!primary(node)) {
        if (!own.value) continue;
        const entry = ancestor(node, ['tr', 'li', 'dt', 'dd'], ['row', 'listitem', 'term', 'definition'])
          ?? ancestor(node, ['p', 'label']);
        if (entry && (!main || inside(entry, main))) {
          const nearby = text(entry, 'containing-entry.textContent', node);
          if (nearby.value) fields.nearby_text = nearby;
        }
      }
    }
    for (const [name, key] of [['title', 'title_attribute'], ['aria-label', 'aria_label'], ['alt', 'alt']] as const) {
      const raw = attr(node, name);
      if (raw?.trim() && (name !== 'alt' || node.tag === 'img')) fields[key] = value(raw, name);
    }
    if (node.tag === 'img') {
      const figure = ancestor(node, ['figure']), cell = ancestor(node, ['td', 'th']);
      // Relate only one image to one caption; an enclosing cell's text keeps its own name.
      if (figure && imageCounts.get(figure) === 1) {
        const captions = captionsByFigure.get(figure) ?? [];
        if (captions.length === 1) { const caption = text(captions[0]!, 'figcaption.textContent'); if (caption.value) fields.caption = caption; }
      }
      if (!fields.caption && cell && imageCounts.get(cell) === 1) {
        const nearby = text(cell, 'containing-cell.textContent');
        if (nearby.value) fields.nearby_text = nearby;
      }
    }
    if (Object.keys(fields).length === 0) continue;
    if (items.length === BROWSER_FIELD_EVIDENCE_ITEMS) { incomplete.add('item_limit'); break; }
    const ref = attr(node, 'ref');
    const item: BrowserEvidenceItem = { tag: node.tag, ...(ref && /^e\d+$/.test(ref) ? { ref } : {}), fields };
    // Reserve space for scope, limit markers and the one guidance sentence.
    if (JSON.stringify([...items, item]).length > BROWSER_FIELD_EVIDENCE_CHARS - 400) { incomplete.add('character_limit'); break; }
    items.push(item);
  }
  return items.length || incomplete.size ? result(items) : undefined;
};
