import type { BrowserInteractionContext } from '@recued/contracts';
import type { OutlineElement, OutlineNode } from './page-outline.js';
import type { browserControlScope } from './browser-control-scope.js';

type Scope = ReturnType<typeof browserControlScope>;
const attribute = (node: OutlineElement, key: string) => typeof node.attrs[key] === 'string' ? String(node.attrs[key]) : '';
const dialog = (node: OutlineElement) => node.tag === 'dialog' || node.attrs['aria-modal'] === 'true' || node.attrs.role === 'dialog';
const omitted = (node: OutlineElement) => node.structuralOnly || Object.hasOwn(node.attrs, 'hidden') || node.attrs['aria-hidden'] === 'true'
  || ['input', 'textarea', 'select', 'button', 'script', 'style', 'template'].includes(node.tag)
  || ['true', '', 'plaintext-only'].includes(attribute(node, 'contenteditable').toLowerCase()) && Object.hasOwn(node.attrs, 'contenteditable');
const words = (node: OutlineElement): string => {
  const pending: OutlineNode[] = [...node.children].reverse(); let text = '', visited = 0;
  while (pending.length && visited++ < 2_000 && text.length <= 240) {
    const part = pending.pop()!;
    if (part.kind === 'text') text += part.text;
    else if (!omitted(part) && !dialog(part)) pending.push(...[...part.children].reverse());
  }
  return text.replace(/\s+/g, ' ').trim();
};

/** Containment and order from this capture, never a task match or a selected
 * entity assertion. Portalled dialogs do not inherit a preceding record. */
export const browserRecordContexts = (scope: Scope) => {
  const excludedText = new Set<OutlineElement>();
  for (const node of scope.nodes) if (omitted(node) || excludedText.has(scope.parents.get(node)!)) excludedText.add(node);
  const contents = new Map<OutlineElement, { links: OutlineElement[]; controls: number }>();
  for (const node of [...scope.nodes].reverse()) {
    const value = { links: node.tag === 'a' ? [node] : [], controls: ['input', 'button', 'select', 'textarea'].includes(node.tag) || node.attrs.role === 'button' ? 1 : 0 };
    for (const child of node.children) if (child.kind === 'element' && contents.has(child)) {
      value.links.push(...contents.get(child)!.links.slice(0, 2)); value.controls += contents.get(child)!.controls;
    }
    value.links = value.links.slice(0, 2); contents.set(node, value);
  }
  type Label = { label: string; tag: string; anchor: OutlineElement };
  const headings = new Map<OutlineElement, Label>();
  for (const node of [...scope.nodes].reverse()) {
    if (excludedText.has(node)) continue;
    if (/^h[1-6]$/.test(node.tag)) {
      const label = words(node); if (label) headings.set(node, { label, tag: node.tag, anchor: node });
    } else for (const child of node.children) if (child.kind === 'element' && !dialog(child) && headings.has(child)) {
      headings.set(node, headings.get(child)!); break;
    }
  }
  // Unmarked cards may use a plain leading title block. Stop at the first
  // control rather than taking a later description or a form's current value.
  const leading = new Map<OutlineElement, Label | null>();
  for (const node of [...scope.nodes].reverse()) {
    if (dialog(node) || node.tag === 'label') continue;
    if (excludedText.has(node) || node.tag === 'a' || node.attrs.role === 'button' || node.attrs.role === 'textbox') { leading.set(node, null); continue; }
    for (const child of node.children) {
      if (child.kind === 'text') {
        const label = child.text.replace(/\s+/g, ' ').trim();
        if (label) { leading.set(node, { label, tag: 'static', anchor: node }); break; }
      } else if (leading.has(child)) { leading.set(node, leading.get(child)!); break; }
    }
  }
  const labels = new Map(scope.nodes.map(node => [node, headings.get(node) ?? leading.get(node)]));
  const groups = new Map<OutlineElement, Omit<BrowserInteractionContext, 'id'>>();
  const anchors = new Map<OutlineElement, OutlineElement>();
  const labelTargets = new Map<OutlineElement, OutlineElement>();
  const peerCache = new Map<OutlineElement, Map<string, OutlineElement[]>>();
  const peers = (node: OutlineElement, tag: string): OutlineElement[] => {
    const parent = scope.parents.get(node); if (!parent) return [];
    let cached = peerCache.get(parent);
    if (!cached) {
      cached = new Map(); peerCache.set(parent, cached);
      for (const child of parent.children) if (child.kind === 'element' && !dialog(child) && labels.get(child)) {
        const key = child.tag + ':' + labels.get(child)!.tag;
        const values = cached.get(key) ?? []; values.push(child); cached.set(key, values);
      }
    }
    return cached.get(node.tag + ':' + tag) ?? [];
  };
  const firstLink = (node: OutlineElement): OutlineElement | undefined => {
    const pending = [node]; let visited = 0;
    while (pending.length && visited++ < 500) {
      const at = pending.pop()!; if (omitted(at) || dialog(at)) continue;
      if (at.tag === 'a' && words(at)) return at;
      pending.push(...at.children.filter((child): child is OutlineElement => child.kind === 'element').reverse());
    }
    return undefined;
  };
  for (const node of scope.nodes) {
    if (excludedText.has(node) || dialog(node)) continue;
    const heading = labels.get(node), siblings = heading ? peers(node, heading.tag) : [];
    const semantic = ['article', 'li'].includes(node.tag) || node.attrs.role === 'listitem';
    let label = '', kind: BrowserInteractionContext['kind'] = 'item', ordinal: string | undefined;
    let labelTarget = heading?.anchor;
    const content = contents.get(node)!;
    if (heading && (content.controls > 0 || content.links.length > 0)
      && (semantic || ['div', 'section'].includes(node.tag) && siblings.length >= 2)) label = heading.label;
    if (node.tag === 'tr' || node.attrs.role === 'row') {
      const cells = node.children.filter((child): child is OutlineElement => child.kind === 'element'
        && (['td', 'th'].includes(child.tag) || ['cell', 'gridcell', 'rowheader'].includes(String(child.attrs.role))));
      const first = cells.find(cell => words(cell));
      if (first) {
        const text = words(first);
        if (/^\d{1,6}[.)]?$/.test(text)) {
          ordinal = text; labelTarget = firstLink(node); label = labelTarget ? words(labelTarget) : '';
        }
        else {
          const links = contents.get(first)?.links ?? [];
          const hasControl = (contents.get(first)?.controls ?? 0) > 0;
          // A plain leading cell, or its one text-only link, can identify a row.
          // Mixed metadata cells with several links are not separate records.
          if (!hasControl && text.length <= 160 && (links.length === 0 || links.length === 1 && words(links[0]!) === text)) {
            label = text; labelTarget = first;
          }
        }
      }
      kind = 'row';
    }
    if (!label) continue;
    if (labelTarget) labelTargets.set(node, labelTarget);
    anchors.set(node, kind === 'item' ? heading!.anchor : node);
    groups.set(node, { kind, label: label.slice(0, 120), ...(label.length > 120 ? { label_truncated: true as const } : {}),
      position: 1, ...(ordinal ? { ordinal } : {}) });
  }
  // A list containing distinct records is not itself the first record. Then
  // collapse wrappers deriving their label from the exact same source node.
  const descendants = new Map<OutlineElement, Set<OutlineElement>>();
  for (const node of [...scope.nodes].reverse()) {
    const found = new Set<OutlineElement>();
    for (const child of node.children) if (child.kind === 'element') {
      for (const anchor of descendants.get(child) ?? []) if (found.size < 2) found.add(anchor);
    }
    if (found.size >= 2) groups.delete(node);
    if (groups.has(node) && found.size < 2) found.add(anchors.get(node)!);
    descendants.set(node, found);
  }
  for (const node of scope.nodes) if (groups.has(node)) {
    for (let at = scope.parents.get(node); at; at = scope.parents.get(at)) if (groups.has(at) && anchors.get(at) === anchors.get(node)) {
      groups.delete(node); break;
    }
  }
  const positions = new Map<OutlineElement, Map<string, number>>();
  for (const [node, group] of groups) {
    const parent = scope.parents.get(node); if (!parent) continue;
    const counts = positions.get(parent) ?? new Map<string, number>();
    group.position = (counts.get(node.tag) ?? 0) + 1;
    counts.set(node.tag, group.position); positions.set(parent, counts);
  }
  const owners = new Map<OutlineElement, OutlineElement>();
  for (const node of scope.nodes) {
    for (let at: OutlineElement | undefined = node; at; at = scope.parents.get(at)) if (groups.has(at)) { owners.set(node, at); break; }
  }
  const ids = new Map<OutlineElement, BrowserInteractionContext>();
  for (const node of scope.nodes) if (groups.has(node)) ids.set(node, { id: `g${ids.size + 1}`, ...groups.get(node)! });
  const excludedHeading = (node: OutlineElement) => {
    for (let at: OutlineElement | undefined = node; at; at = scope.parents.get(at)) if (omitted(at) || ['nav', 'footer', 'aside'].includes(at.tag)
      || ['navigation', 'banner', 'contentinfo'].includes(attribute(at, 'role'))) return true;
    return false;
  };
  const pageHeadings = scope.nodes.filter(node => /^h[1-6]$/.test(node.tag) && scope.allowed.has(node) && !owners.has(node) && !excludedHeading(node))
    .map(node => words(node)).filter(Boolean).slice(0, 3).map(label => label.slice(0, 120));
  return { forNode: (node: OutlineElement) => { const owner = owners.get(node); return owner ? ids.get(owner) : undefined; },
    isLabelTarget: (node: OutlineElement) => {
      const owner = owners.get(node), label = owner ? labelTargets.get(owner) : undefined;
      return node.tag === 'a' && label !== undefined && scope.inside(node, label);
    }, headings: pageHeadings };
};
