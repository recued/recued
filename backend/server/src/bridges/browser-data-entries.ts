import type { OutlineElement, OutlineNode } from './page-outline.js';

export interface BrowserPageEntry {
  kind: 'list_item' | 'definition_term'; text: string; section: string; heading: string;
  heading_path: string[]; group: string; list: number; position: number; depth: number;
}
type DisplayPosition = { direction: 'top-to-bottom' | 'left-to-right'; position: number };
export interface BrowserEntrySnapshot {
  rows: BrowserPageEntry[]; complete: boolean;
  /** Internal alignment with the ordinary read. Not a column in retained data. */
  line_numbers?: Array<number | undefined>;
  display_positions?: Record<number, DisplayPosition>;
}
const omitted = (node: OutlineElement) => node.structuralOnly || node.attrs.hidden !== undefined
  || node.attrs['aria-hidden'] === 'true' || ['nav', 'header', 'footer', 'aside', 'form', 'script', 'style', 'template', 'input', 'textarea', 'select', 'button'].includes(node.tag)
  || ['navigation', 'menu', 'menubar'].includes(String(node.attrs.role));
const lists = new Set(['ul', 'ol', 'dl']);

export const renderedTextOf = (element: OutlineElement): string | undefined => {
  const rendered = element.attrs['data-recued-rendered-text'];
  return typeof rendered === 'string' ? rendered : undefined;
};

/** The complete sequence of observed, ranked children for one layout. */
export const displayedChildrenOf = (element: OutlineElement) => {
  const specification = element.attrs['data-recued-display-order'];
  if (typeof specification !== 'string') return undefined;
  const match = /^(top-to-bottom|left-to-right):(\d{1,2})$/.exec(specification);
  if (!match) return undefined;
  const children = element.children.flatMap(child => {
    if (child.kind !== 'element') return [];
    const raw = child.attrs['data-recued-display-position'];
    if (typeof raw !== 'string') return [];
    const rank = /^position-(\d{1,2})$/.exec(raw);
    return rank ? [{ child, position: Number(rank[1]) }] : [];
  }).sort((first, second) => first.position - second.position);
  if (children.length < 2 || children.length !== Number(match[2])
    || children.some(({ position }, i) => position !== i + 1)) return undefined;
  const direction = match[1] === 'top-to-bottom' ? 'top-to-bottom' as const : 'left-to-right' as const;
  return { direction, children };
};

/** Preserve observed semantic entries, without interpreting their domain or
 * inferring rows from visual line wrapping. Nested lists have their own rows. */
export const browserDataEntries = (root: OutlineElement, lineOf?: (node: OutlineElement) => number | undefined): BrowserEntrySnapshot => {
  const result: BrowserEntrySnapshot = { rows: [], complete: true };
  if (lineOf) result.line_numbers = [];
  let nodes = 0, chars = 0, nextList = 0;
  const headings: string[] = [];
  const text = (node: OutlineElement): string => {
    const rendered = renderedTextOf(node);
    const pieces: string[] = rendered === undefined ? [] : [rendered];
    const pending: OutlineNode[] = rendered === undefined ? [...node.children].reverse() : [];
    while (pending.length) {
      if (++nodes > 100_000) { result.complete = false; break; }
      const child = pending.pop()!;
      if (child.kind === 'text') pieces.push(child.text);
      else if (!omitted(child) && !lists.has(child.tag)) {
        const block = ['br', 'p', 'div', 'section', 'table', 'blockquote'].includes(child.tag) || /^h[1-6]$/.test(child.tag);
        if (block) { pieces.push(' '); pending.push({ kind: 'text', text: ' ' }); }
        const displayed = renderedTextOf(child);
        if (displayed === undefined) pending.push(...[...child.children].reverse());
        else pieces.push(displayed);
      }
    }
    const full = pieces.join('').replace(/\s+/g, ' ').trim();
    if (full.length > 2_000) result.complete = false;
    return full.slice(0, 2_000);
  };
  type Frame = { node: OutlineElement; list: number; depth: number; position: number; display?: DisplayPosition } | { restore: string[] };
  const pending: Frame[] = [{ node: root, list: 0, depth: 0, position: 0 }];
  while (pending.length) {
    if (++nodes > 100_000 || result.rows.length >= 5_000 || chars > 500_000) { result.complete = false; break; }
    const frame = pending.pop()!;
    if ('restore' in frame) { headings.splice(0, headings.length, ...frame.restore); continue; }
    const { node, list, depth, position } = frame;
    if (omitted(node)) continue;
    if (['article', 'section', 'li', 'dt'].includes(node.tag) || ['listitem', 'term'].includes(String(node.attrs.role)))
      pending.push({ restore: [...headings] });
    const rank = /^h([1-6])$/.exec(node.tag);
    if (rank) {
      const level = Number(rank[1]); headings.length = level;
      headings[level - 1] = text(node);
    }
    const definition = node.tag === 'dt' || node.attrs.role === 'term';
    if (node.tag === 'li' || node.attrs.role === 'listitem' || definition) {
      const content = text(node);
      if (content) {
        const path = headings.filter(Boolean);
        result.rows.push({ kind: definition ? 'definition_term' : 'list_item', text: content,
          section: headings[1] || headings[0] || '', heading: path.at(-1) ?? '', heading_path: [...path], group: JSON.stringify(path), list, position, depth });
        result.line_numbers?.push(lineOf?.(node));
        if (frame.display) (result.display_positions ??= {})[result.rows.length - 1] = frame.display;
        chars += content.length + 2 * path.join('').length + (headings[1] || headings[0] || '').length + (path.at(-1) ?? '').length + 200;
      }
    }
    const isList = lists.has(node.tag) || node.attrs.role === 'list', next = isList ? ++nextList : list;
    const displayed = lineOf && isList ? displayedChildrenOf(node) : undefined;
    const positions = displayed && new Map(displayed.children.map(({ child, position }) => [child,
      { direction: displayed.direction, position }]));
    let ordinal = 0;
    const children = node.children.filter((child): child is OutlineElement => child.kind === 'element')
      .map(child => ({ node: child, list: next, depth: isList ? depth + 1 : depth,
        display: positions?.get(child),
        position: ['li', 'dt'].includes(child.tag) || ['listitem', 'term'].includes(String(child.attrs.role)) ? ++ordinal : 0 }));
    pending.push(...children.reverse());
  }
  return result;
};
