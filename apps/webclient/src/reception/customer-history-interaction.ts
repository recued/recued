/** Keep an action or reply text alive through native activation or selection.
 * Pointer-up capture is too early to render: click follows it in the same task. */
export const guardCustomerHistoryInteraction = (doc: Document, host: HTMLElement) => {
  const pointers = new Set<number>(); const keys = new Set<string>();
  let disposed = false; let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<boolean> | undefined; let resolve: ((ready: boolean) => void) | undefined;
  const active = () => pointers.size > 0 || keys.size > 0;
  const flush = () => {
    if (!resolve) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!active()) { const done = resolve; resolve = undefined; pending = undefined; done?.(!disposed); }
    }, 0);
  };
  const action = (event: Event) => (event.target as Element)?.closest?.('button,a,summary');
  const down = (event: PointerEvent) => {
    if (event.button === 0 && (action(event) || (event.target as Element)?.closest?.('[data-customer-response-text]'))) pointers.add(event.pointerId);
  };
  const up = (event: PointerEvent) => { pointers.delete(event.pointerId); flush(); };
  const move = (event: PointerEvent) => { if (event.buttons === 0 && pointers.size) { pointers.clear(); flush(); } };
  const keyDown = (event: KeyboardEvent) => { if ((event.key === ' ' || event.key === 'Enter') && action(event)) keys.add(event.key); };
  const keyUp = (event: KeyboardEvent) => { keys.delete(event.key); flush(); };
  const release = () => { pointers.clear(); keys.clear(); flush(); };
  const visibility = () => { if (doc.visibilityState === 'hidden') release(); };
  host.addEventListener('pointerdown', down, true); host.addEventListener('keydown', keyDown, true);
  doc.addEventListener?.('pointerup', up, true); doc.addEventListener?.('pointercancel', up, true);
  doc.addEventListener?.('pointermove', move, true); doc.addEventListener?.('keyup', keyUp, true);
  doc.addEventListener?.('visibilitychange', visibility); doc.defaultView?.addEventListener('blur', release);
  return {
    ready: (): Promise<boolean> => disposed ? Promise.resolve(false) : !active() ? Promise.resolve(true)
      : pending ?? (pending = new Promise<boolean>(done => { resolve = done; })),
    dispose: () => {
      disposed = true; if (timer !== undefined) clearTimeout(timer);
      host.removeEventListener?.('pointerdown', down, true); host.removeEventListener?.('keydown', keyDown, true);
      doc.removeEventListener?.('pointerup', up, true); doc.removeEventListener?.('pointercancel', up, true);
      doc.removeEventListener?.('pointermove', move, true); doc.removeEventListener?.('keyup', keyUp, true);
      doc.removeEventListener?.('visibilitychange', visibility); doc.defaultView?.removeEventListener('blur', release);
      pointers.clear(); keys.clear(); resolve?.(false); resolve = undefined; pending = undefined;
    },
  };
};
