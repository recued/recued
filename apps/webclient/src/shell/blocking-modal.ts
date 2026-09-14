/**
 * Is a modal currently holding the UI?
 *
 * Extracted from `global-run-palette.ts` (D-267) so the universal-search
 * shortcut asks the same question the Run palette asks, rather than growing a
 * second opinion about what "a modal is open" means. A global chord that
 * navigated away while an unfinished Create capture was on screen would destroy
 * it, and the palette already had the correct answer.
 *
 * Pure module (DOM read only).
 */

/** The first visible `aria-modal="true"` element, or `null`. */
export const activeBlockingModal = (doc: Document): Element | null => {
  const queryAll = (doc as Document & {
    querySelectorAll?: (selector: string) => Iterable<Element>;
  }).querySelectorAll;
  if (typeof queryAll !== 'function') return null;
  for (const candidate of queryAll.call(doc, '[aria-modal="true"]')) {
    if (
      candidate.hasAttribute('hidden')
      || candidate.getAttribute('aria-hidden') === 'true'
    ) continue;
    const getClientRects = (candidate as Element & {
      getClientRects?: () => { readonly length: number };
    }).getClientRects;
    // Real DOM: exclude route-owned dialog shells that remain mounted under
    // display:none. Minimal test DOMs without layout treat a present modal as
    // active, which is the conservative fallback.
    if (
      typeof getClientRects !== 'function'
      || getClientRects.call(candidate).length > 0
    ) return candidate;
  }
  return null;
};
