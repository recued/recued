/** Copy an owner-selected value, including on browsers without the Clipboard API. */
export const copyText = async (doc: Document, text: string): Promise<boolean> => {
  try {
    const clipboard = doc.defaultView?.navigator.clipboard;
    if (clipboard?.writeText) { await clipboard.writeText(text); return true; }
    if (typeof doc.execCommand !== 'function') return false;
    const input = doc.createElement('textarea');
    input.value = text; input.readOnly = true;
    input.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
    const focused = doc.activeElement as HTMLElement | null;
    doc.body.append(input);
    try { input.focus({ preventScroll: true }); input.select(); return doc.execCommand('copy'); }
    finally { input.remove(); focused?.focus?.({ preventScroll: true }); }
  } catch { return false; }
};
