import { ANSWER_CODE_BLOCK_ATTR, ANSWER_CODE_COPY_ATTR, ANSWER_CODE_STATUS_ATTR, ANSWER_CONTROL_ATTR } from './answer-text.js';

interface CopyState {
  readonly text: string;
  phase: 'pending' | 'copied' | 'failed';
}
interface AnswerPosition {
  readonly focused: { key: string; element: Element } | null;
  readonly horizontal: Map<string, number>;
}

/** Route-local clipboard state. Stable message/block identities keep feedback
 * and focus through repaints; nothing is persisted or submitted to the server. */
export const createAnswerCodeCopy = (doc: Document, root: HTMLElement) => {
  const copies = new Map<string, CopyState>();
  let disposed = false;
  const boxes = (): HTMLElement[] => Array.from(root.querySelectorAll?.<HTMLElement>(`[${ANSWER_CODE_BLOCK_ATTR}]`) ?? []);
  const repaint = (announce?: string): void => {
    if (disposed) return;
    const visible = new Set<string>();
    for (const box of boxes()) {
      const key = box.getAttribute(ANSWER_CODE_BLOCK_ATTR)!;
      visible.add(key);
      const button = box.querySelector<HTMLButtonElement>(`[${ANSWER_CODE_COPY_ATTR}]`);
      const status = box.querySelector<HTMLElement>(`[${ANSWER_CODE_STATUS_ATTR}]`);
      const text = box.querySelector('code')?.textContent ?? '';
      const state = copies.get(key);
      if (!button || !status) continue;
      const pending = state?.phase === 'pending';
      const copied = state?.phase === 'copied' && state.text === text;
      button.textContent = pending ? 'Copying…' : copied ? 'Copied' : 'Copy';
      button.setAttribute('aria-disabled', String(pending));
      button.setAttribute('aria-busy', String(pending));
      status.setAttribute('aria-live', announce === key ? 'polite' : 'off');
      status.textContent = state?.phase === 'failed' ? 'Could not copy. Select the code and copy it.'
        : state?.phase === 'copied' ? copied ? 'Code copied.' : 'The code changed while copying. Copy again for the current text.' : '';
      if (copied) status.setAttribute('data-copy-quiet', '');
      else status.removeAttribute('data-copy-quiet');
    }
    for (const [key, state] of copies) if (!visible.has(key) && state.phase !== 'pending') copies.delete(key);
  };
  const capture = (): AnswerPosition => {
    const active = doc.activeElement;
    const key = active && root.contains?.(active) ? active.getAttribute(ANSWER_CONTROL_ATTR) : null;
    const horizontal = new Map<string, number>();
    for (const box of boxes()) {
      const pre = box.querySelector('pre');
      if (pre) horizontal.set(box.getAttribute(ANSWER_CODE_BLOCK_ATTR)!, pre.scrollLeft);
    }
    return { focused: key && active ? { key, element: active } : null, horizontal };
  };
  const restore = (saved: AnswerPosition, fallback?: () => void): void => {
    if (disposed) return;
    repaint();
    for (const box of boxes()) {
      const left = saved.horizontal.get(box.getAttribute(ANSWER_CODE_BLOCK_ATTR)!);
      const pre = box.querySelector('pre');
      if (pre && left !== undefined) pre.scrollLeft = left;
    }
    if (!saved.focused) return;
    const active = doc.activeElement;
    if (active && active !== saved.focused.element && active !== doc.body && active.isConnected) return;
    const target = Array.from(root.querySelectorAll?.<HTMLElement>(`[${ANSWER_CONTROL_ATTR}]`) ?? [])
      .find(element => element.getAttribute(ANSWER_CONTROL_ATTR) === saved.focused!.key);
    if (target) target.focus({ preventScroll: true }); else fallback?.();
  };
  const handleClick = (event: Event): void => {
    const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>(`[${ANSWER_CODE_COPY_ATTR}]`);
    if (!button || disposed || !root.contains(button)) return;
    const box = button.closest<HTMLElement>(`[${ANSWER_CODE_BLOCK_ATTR}]`);
    const key = button.getAttribute(ANSWER_CODE_COPY_ATTR);
    const code = box?.querySelector('code');
    if (!box || !key || !code || copies.get(key)?.phase === 'pending') return;
    // Capture the exact code, excluding the fence, language and button labels.
    const operation: CopyState = { text: code.textContent ?? '', phase: 'pending' };
    copies.set(key, operation); repaint();
    const selection = doc.defaultView?.getSelection();
    const originalSelection = selection && { anchorNode: selection.anchorNode, anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode, focusOffset: selection.focusOffset };
    void (async () => {
      try {
        const clipboard = doc.defaultView?.navigator?.clipboard;
        if (typeof clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
        await clipboard.writeText(operation.text);
        if (disposed || copies.get(key) !== operation) return;
        operation.phase = 'copied'; repaint(key);
      } catch {
        if (disposed || copies.get(key) !== operation) return;
        // Read before feedback repaint can change a range in the button itself.
        const selection = doc.defaultView?.getSelection();
        const ownsSelection = originalSelection ? selection?.anchorNode === originalSelection.anchorNode
          && selection.anchorOffset === originalSelection.anchorOffset && selection.focusNode === originalSelection.focusNode
          && selection.focusOffset === originalSelection.focusOffset : !selection;
        operation.phase = 'failed'; repaint(key);
        // An explicit denial offers native selection only while this action
        // still owns focus and selection. A later reading or editing choice wins.
        const current = boxes().find(element => element.getAttribute(ANSWER_CODE_BLOCK_ATTR) === key);
        const currentButton = current?.querySelector(`[${ANSWER_CODE_COPY_ATTR}]`);
        if (currentButton && doc.activeElement === currentButton && ownsSelection) {
          const pre = current?.querySelector('pre'), body = pre?.querySelector('code');
          if (pre && body) {
            pre.focus({ preventScroll: true });
            const selection = doc.defaultView?.getSelection();
            if (selection) {
              const range = doc.createRange(); range.selectNodeContents(body);
              selection.removeAllRanges(); selection.addRange(range);
            }
          }
        }
      }
    })();
  };
  root.addEventListener('click', handleClick);
  return { capture, restore, dispose: () => {
    disposed = true; copies.clear(); root.removeEventListener?.('click', handleClick);
  } };
};
