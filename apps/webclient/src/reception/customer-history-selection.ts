/** Capture immediately before repainting, after the read and any held gesture.
 * A different request or changed reply must never inherit the old selection. */
export const keepCustomerReplySelection = (doc: Document, history: HTMLElement, entryAttribute: string): (() => void) | undefined => {
  const selection = doc.defaultView?.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
  const text = selection.anchorNode;
  if (!text || text !== selection.focusNode || text.nodeType !== 3) return;
  const source = text.parentElement;
  if (!source?.hasAttribute('data-customer-response-text') || !history.contains(source)) return;
  const entryId = source.closest('[' + entryAttribute + ']')?.getAttribute(entryAttribute);
  if (!entryId) return;
  const kind = source.getAttribute('data-customer-response-text');
  const value = source.textContent;
  const anchor = selection.anchorOffset; const focus = selection.focusOffset;
  return () => {
    if (!history.isConnected) return;
    const entry = [...history.querySelectorAll<HTMLElement>('[' + entryAttribute + ']')]
      .find(node => node.getAttribute(entryAttribute) === entryId);
    const target = entry && [...entry.querySelectorAll<HTMLElement>('[data-customer-response-text]')]
      .find(node => node.getAttribute('data-customer-response-text') === kind);
    const replacement = target?.firstChild;
    if (!target || target.textContent !== value || target.childNodes.length !== 1 || replacement?.nodeType !== 3) return;
    selection.setBaseAndExtent(replacement, anchor, replacement, focus);
  };
};
