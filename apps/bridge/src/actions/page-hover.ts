/** D-335 slice X (2026-11-06) — pointing at an element, as a person moves the mouse onto it, for a
 *  menu that opens under the pointer.
 *
 *  The owner, on what the toolkit should do that browser-use does: *"maybe we need to consider
 *  expanding the common dom operation supports to better help with tasks"*. The pointer's events
 *  go to the element and, for `enter`, which does not bubble, to each element around it from the
 *  outside in, as a pointer arriving from outside the page would cross them: a menu that opens on
 *  `mouseenter` of its list item opens when the link inside is pointed at.
 *
 *  ⚠ A style sheet's `:hover` rule does not apply: only a real pointer sets it. A menu drawn by
 *  CSS alone stays shut, and the answer cannot tell; the read after it can.
 *
 *  ⛔ INJECTED, SO SELF-CONTAINED: nothing is imported. */

export const hoverPageElement = (selector: string, expectedUrl?: string | null, ref?: string | null):
  { hovered: true } | { blocked: true } | { missing: true } | { stale: true } => {
  // Chrome passes arguments as JSON, so an absent one can arrive as null.
  if (document.documentElement.hasAttribute('data-recued-owner-surface')
    || (expectedUrl != null && location.href !== expectedUrl)) return { blocked: true };
  const marked = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } }).recuedPageRefs;
  const found = ref == null ? document.querySelector(selector) : marked?.byRef.get(ref) ?? null;
  if (ref != null && !found?.isConnected) return { stale: true };
  if (!found) return { missing: true };
  const element = found as HTMLElement;
  element.scrollIntoView?.({ block: 'center', inline: 'center' });
  const box = element.getBoundingClientRect();
  const win = (element.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
  const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, view: win, composed: true };
  const pointer = { ...at, pointerType: 'mouse', isPrimary: true };
  // The elements a pointer crosses on its way in, from the outside: their `enter` does not bubble.
  const around: Element[] = [];
  for (let node: Element | null = element; node !== null && node !== element.ownerDocument.documentElement; node = node.parentElement) {
    around.unshift(node);
  }
  element.dispatchEvent(new win.PointerEvent('pointerover', { ...pointer, bubbles: true, cancelable: true }));
  for (const node of around) node.dispatchEvent(new win.PointerEvent('pointerenter', { ...pointer, bubbles: false }));
  element.dispatchEvent(new win.MouseEvent('mouseover', { ...at, bubbles: true, cancelable: true }));
  for (const node of around) node.dispatchEvent(new win.MouseEvent('mouseenter', { ...at, bubbles: false }));
  element.dispatchEvent(new win.PointerEvent('pointermove', { ...pointer, bubbles: true, cancelable: true }));
  element.dispatchEvent(new win.MouseEvent('mousemove', { ...at, bubbles: true, cancelable: true }));
  return { hovered: true };
};
