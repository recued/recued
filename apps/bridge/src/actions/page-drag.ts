import type { BrowserDragTarget } from '@recued/contracts';
import type { PageFieldAnswer } from './page-fields.js';

/** Injected into one observed document. Dispatch the HTML drag sequence with one data transfer. */
export const dragPageElement = (
  start: BrowserDragTarget, drop: BrowserDragTarget, expectedUrl: string,
): PageFieldAnswer => {
  if (location.href !== expectedUrl || document.documentElement.hasAttribute('data-recued-owner-surface')) return { blocked: true };
  const refs = (globalThis as typeof globalThis & { recuedPageRefs?: { byRef: Map<string, Element> } }).recuedPageRefs;
  const find = (target: BrowserDragTarget): Element | undefined => {
    if (target.ref !== undefined) return refs?.byRef.get(target.ref);
    try {
      const matches = [...document.querySelectorAll(target.selector)].filter(element =>
        element.checkVisibility({ checkVisibilityCSS: true }));
      return matches.length === 1 ? matches[0] : undefined;
    } catch { return undefined; }
  };
  const source = find(start);
  const destination = find(drop);
  if (!source || !destination || source.ownerDocument !== document || destination.ownerDocument !== document
    || !source.isConnected || !destination.isConnected) {
    return { not_applied: 'The drag needs two current elements in the same observed document.' };
  }
  if (!(source instanceof HTMLElement) || !source.draggable || source === destination || source.contains(destination)) {
    return { not_applied: 'The source must be draggable, with a distinct drop target outside it.' };
  }
  const inside = (ancestor: Element, element: Element): boolean => {
    for (let at: Element | null = element; at; at = at.parentElement ?? (at.getRootNode() as ShadowRoot).host ?? null) {
      if (at === ancestor) return true;
    }
    return false;
  };
  const point = (element: Element) => {
    if (!element.isConnected || !element.checkVisibility({ checkVisibilityCSS: true })) return undefined;
    for (let at: Element | null = element; at; at = at.parentElement ?? (at.getRootNode() as ShadowRoot).host ?? null) {
      if (at.matches(':disabled, [aria-disabled="true"], [aria-hidden="true"], [inert]')) return undefined;
    }
    for (const modal of document.querySelectorAll('dialog:modal, [aria-modal="true"]')) {
      if (modal.checkVisibility({ checkVisibilityCSS: true }) && !inside(modal, element)) return undefined;
    }
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return undefined;
    const x = (left + right) / 2, y = (top + bottom) / 2;
    for (let at: Element | null = element; at;) {
      const root = at.getRootNode() as Document | ShadowRoot;
      const hit = root.elementFromPoint(x, y);
      if (hit === null || !at.contains(hit)) return undefined;
      at = (root as ShadowRoot).host ?? null;
    }
    return { x, y };
  };
  const end = point(destination);
  const begin = point(source);
  if (!begin || !end || location.href !== expectedUrl || find(start) !== source || find(drop) !== destination) {
    return { not_applied: 'The drag source or drop target is covered, unavailable, or changed.' };
  }
  const transfer = new DataTransfer();
  const fire = (element: Element, type: string, at: { x: number; y: number }) =>
    element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer,
      clientX: at.x, clientY: at.y }));
  if (!fire(source, 'dragstart', begin)) return { not_applied: 'The page cancelled the drag start.' };
  let endAt = begin;
  let entered = false;
  let dropped = false;
  try {
    const targetNow = location.href === expectedUrl && find(drop) === destination ? point(destination) : undefined;
    if (!targetNow) return { uncertain: true };
    endAt = targetNow;
    fire(source, 'drag', begin);
    fire(destination, 'dragenter', endAt);
    entered = true;
    // Chromium leaves native drag-operation flags unset on a script-created
    // transfer. The app accepts this target by cancelling its dragover.
    if (fire(destination, 'dragover', endAt)) {
      return { not_applied: 'The page did not accept a drop at that target.' };
    }
    if (location.href !== expectedUrl || find(drop) !== destination || !destination.isConnected) return { uncertain: true };
    fire(destination, 'drop', endAt);
    dropped = true;
    return { outputs: { dropped: true } };
  } finally {
    if (entered && !dropped) fire(destination, 'dragleave', endAt);
    fire(source, 'dragend', endAt);
  }
};
