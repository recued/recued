/** D-335 slice U (2026-11-05) — a page scrolled a screen at a time, and left there.
 *
 *  browser-use scrolls; the toolkit read the whole page, which is enough for most of them but not
 *  for a feed that loads more as you scroll, or a long list an app draws only near the window (most
 *  of a mail list or a table of deals is not on the page until it is scrolled to). So `scroll` moves
 *  the page (or the panel it scrolls instead, or an element) by a screen, as a screenshot's `screen`
 *  counts them (`measurePageArea`, a Page Down apart), and gives the page a moment to draw what that
 *  brought in. A screenshot puts back what it scrolled; a scroll does not, since the point is to stay.
 */

import type { BridgeScrollTo } from '@recued/contracts';

/** How long the page may be busy drawing after a scroll before it is answered: it is given
 *  {@link PAGE_SCROLL_FIRST_MS} to start (a feed asks its site for more, which takes a moment), is
 *  answered once nothing has changed for {@link PAGE_SCROLL_QUIET_MS} after that, and at most after
 *  this. */
export const PAGE_SCROLL_SETTLE_MS = 1_500;
export const PAGE_SCROLL_FIRST_MS = 800;
export const PAGE_SCROLL_QUIET_MS = 250;

/** The screen a scroll goes to, from the one the page begins in now, of how many. */
export const scrollTarget = (now: { screen: number; screens: number }, to: BridgeScrollTo | undefined, screen?: number): number =>
  screen !== undefined ? screen
    : to === 'top' ? 1
      : to === 'bottom' ? now.screens
        : to === 'previous' ? Math.max(1, now.screen - 1)
          : Math.min(now.screens, now.screen + 1);

/** Resolves once the page has changed and then nothing has for `quietMs`, when nothing changed for
 *  `firstMs`, or after `maxMs`: a feed that loads more as it is scrolled draws it then. Answers
 *  whether anything changed. Injected, so self-contained. */
export const waitForQuiet = (quietMs: number, maxMs: number, firstMs = quietMs): Promise<boolean> => new Promise(resolve => {
  let changed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    changed = true;
    clearTimeout(timer);
    timer = setTimeout(done, quietMs);
  });
  const limit = setTimeout(done, maxMs);
  function done() {
    observer.disconnect();
    clearTimeout(timer);
    clearTimeout(limit);
    resolve(changed);
  }
  observer.observe(document, { childList: true, subtree: true, characterData: true });
  timer = setTimeout(done, firstMs);
});
