/** Replace the siblings along the native field's path without disconnecting any
 * ancestor. Native date controls keep partial segments outside `value`; even
 * reinserting the same input resets which segment receives the next keystroke.
 * Returns false for a different path shape so the caller can replace or defer. */
export const reconcileNativeField = (
  current: Element, next: Element, field: Element, nextField: Element,
): boolean => {
  const path = (leaf: Element, host: Element): Element[] => {
    const nodes: Element[] = [];
    for (let node: Element | null = leaf; node !== host; node = node.parentElement) {
      if (node === null) return [];
      nodes.unshift(node);
    }
    return nodes;
  };
  const before = path(field, current); const after = path(nextField, next);
  if (before.length === 0 || before.length !== after.length
    || before.some((node, index) => node.tagName !== after[index]!.tagName)) return false;
  const attributes = (target: Element, source: Element): void => {
    for (const attr of Array.from(target.attributes)) {
      if (target === field && attr.name === 'value') continue;
      if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    }
    for (const attr of Array.from(source.attributes)) {
      if (target === field && attr.name === 'value') continue;
      if (target.getAttribute(attr.name) !== attr.value) target.setAttribute(attr.name, attr.value);
    }
  };
  for (let index = 0; index < before.length; index++) {
    const parent = index === 0 ? current : before[index - 1]!;
    const nextParent = index === 0 ? next : after[index - 1]!;
    const branch = before[index]!; const nextBranch = after[index]!;
    attributes(parent, nextParent);
    for (const node of Array.from(parent.childNodes)) if (node !== branch) parent.removeChild(node);
    let following = false;
    for (const node of Array.from(nextParent.childNodes)) {
      if (node === nextBranch) { following = true; continue; }
      parent.insertBefore(node, following ? null : branch);
    }
  }
  attributes(field, nextField);
  return true;
};

