import type { OutlineElement } from './page-outline.js';

/** Interaction scope from the same cleaned snapshot. Background controls stay
 * readable but cannot be chosen by name while a modal is open. */
export const browserControlScope = (root: OutlineElement) => {
  const nodes: OutlineElement[] = [], parents = new Map<OutlineElement, OutlineElement>();
  const pending: Array<{ node: OutlineElement; depth: number }> = [{ node: root, depth: 0 }];
  let complete = true;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (nodes.length >= 15_000 || depth > 128) { complete = false; break; }
    if (node.structuralOnly || Object.hasOwn(node.attrs, 'hidden') || node.attrs['aria-hidden'] === 'true'
      || ['script', 'style', 'template', 'noscript'].includes(node.tag)) continue;
    nodes.push(node);
    for (const child of [...node.children].reverse()) if (child.kind === 'element') {
      parents.set(child, node); pending.push({ node: child, depth: depth + 1 });
    }
  }
  const inside = (node: OutlineElement, parent: OutlineElement): boolean => {
    for (let at: OutlineElement | undefined = node; at; at = parents.get(at)) if (at === parent) return true;
    return false;
  };
  const ids = new Map<string, OutlineElement | null>();
  for (const node of nodes) if (typeof node.attrs.id === 'string') {
    ids.set(node.attrs.id, ids.has(node.attrs.id) ? null : node);
  }
  // 2026-11-22 — and what the Bridge found covering the page though the page marks it hidden (`data-recued-cover`).
  const modals = nodes.filter(node => Object.hasOwn(node.attrs, 'modal') || node.attrs['aria-modal'] === 'true'
    || Object.hasOwn(node.attrs, 'data-recued-cover'));
  const modalAncestors = new Set<OutlineElement>();
  for (const node of modals) for (let at = parents.get(node); at; at = parents.get(at)) modalAncestors.add(at);
  const active = modals.filter(node => !modalAncestors.has(node));
  const modal = active.length === 1 ? active[0] : undefined;
  const allowed = new Set(nodes.filter(node => complete && (modals.length === 0 || modal !== undefined && inside(node, modal))));
  const lists = new Map<OutlineElement, OutlineElement[]>();
  let comboCount = 0;
  for (const node of nodes) {
    if (node.attrs.role !== 'combobox') continue;
    if (++comboCount > 64) { complete = false; break; }
    const linked: OutlineElement[] = [];
    for (const key of ['aria-controls', 'aria-owns']) {
      for (const id of String(node.attrs[key] ?? '').split(/\s+/).filter(Boolean).slice(0, 32)) {
        const list = ids.get(id);
        if (list && ['listbox', 'menu', 'tree', 'grid'].includes(String(list.attrs.role))
          && !(modal?.tag === 'dialog' && Object.hasOwn(modal.attrs, 'modal') && !inside(list, modal))
          && !modals.some(other => other !== modal && inside(list, other))) linked.push(list);
      }
    }
    lists.set(node, [...new Set(linked)]);
    // ARIA-linked popup options may be portalled beside the dialog. Never
    // broaden to an unrelated list just because it contains matching text.
    if (allowed.has(node)) for (const list of linked) for (const child of nodes) if (inside(child, list)) allowed.add(child);
  }
  if (!complete) allowed.clear();
  return { nodes, parents, ids, inside, allowed, lists, modal,
    modal_open: modals.length > 0, complete: complete && active.length <= 1 };
};
