import { BRIDGE_READ_SETTLE_MAX_MS, BRIDGE_WAIT_CHANGE_MAX_MS } from '@recued/contracts';

/** 2026-11-20 — whether a page has stopped changing, for a read asked to settle (`settle_ms`, `executor.ts`).
 *
 *  Injected into the document, so it is self-contained. The first call in a document starts watching it for added,
 *  removed or changed content: a `MutationObserver` kept on the window of the extension's own world, where later
 *  calls in the same document find it. A change to attributes alone, such as an animation's or a focus ring's, does
 *  not count. Each call answers how long the content has been still, whether a shown region says it is busy
 *  (`aria-busy="true"`), and whether a finite animation is running on a shown element (`animating`).
 *
 *  A document is read at once on a click that loads nothing (`BRIDGE_CLICK_SETTLE_MS` watches only for a page that
 *  starts loading). So a dialog, a list a script draws, or a route change was read as it was drawn, and the model
 *  padded nearly every batch with a fixed wait (`BRIDGE_READ_QUIET_MS`).
 *
 *  2026-11-20 (the owner: "go ahead", a wait at the Bridge) — a plain wait of seconds waits here for the page to change
 *  (`wait_change_ms`, `executor.ts`). The watch counts each change (`changes`), and a read that settles leaves a mark
 *  (`mark`): the count it read at (`marked`), and the endless animations then running. A later wait counts a change
 *  past the mark, and holds while an endless animation started since then runs on a shown element (`spinning`): a
 *  spinner that came with a click says the page is still loading, where one already there is decoration. `fresh`
 *  says this call began the watch, so the Bridge had never read the document with it: to a wait, a changed page. */
export interface PageSettleState {
  quiet_ms: number;
  busy: boolean;
  animating: boolean;
  changes: number;
  marked: number | null;
  fresh: boolean;
  spinning: boolean;
}
export const pageSettleProbe = (mark = false): PageSettleState => {
  const KEY = '__recuedPageSettle';
  type Watch = { last: number; changes: number; marked: number | null; spinners: WeakSet<Animation> | null };
  const holder = window as unknown as Record<string, Watch | undefined>;
  let watch = holder[KEY];
  let fresh = false;
  if (watch === undefined) {
    const created: Watch = { last: performance.now(), changes: 0, marked: null, spinners: null };
    new MutationObserver((records) => {
      if (records.some((record) => record.type !== 'attributes')) {
        created.last = performance.now();
        created.changes += 1;
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
    holder[KEY] = created;
    watch = created;
    fresh = true;
  }
  const shown = (element: Element): boolean => {
    const visible = (element as Element & { checkVisibility?: (options: object) => boolean }).checkVisibility;
    return typeof visible !== 'function' || visible.call(element, { checkVisibilityCSS: true });
  };
  const busy = Array.from(document.querySelectorAll('[aria-busy="true"]')).some(shown);
  // 2026-11-20 (the owner: "go ahead", the animated modal) — a modal fading out changes only its style, which the watch
  //   above leaves out on purpose, so a read could land mid-fade with the modal still shown. The browser lists the
  //   animations it runs (CSS transitions and animations included). One with an end, on a shown element, counts. An
  //   endless one (a spinner, a looping banner) never ends, so it does not count, or a page with a spinner would never
  //   settle. A carousel's slide change is a finite transition, so it holds a read until that slide has moved.
  let animating = false;
  let spinning = false;
  const endless: Animation[] = [];
  for (const animation of typeof document.getAnimations === 'function' ? document.getAnimations() : []) {
    if (animation.playState !== 'running' || !animation.effect) continue;
    const target = (animation.effect as KeyframeEffect).target;
    if (!target || !shown(target)) continue;
    if (Number.isFinite(Number(animation.effect.getComputedTiming().endTime))) {
      animating = true;
    } else {
      endless.push(animation);
      if (watch.spinners !== null && !watch.spinners.has(animation)) spinning = true;
    }
  }
  const state: PageSettleState = { quiet_ms: Math.max(0, Math.round(performance.now() - watch.last)), busy, animating,
    changes: watch.changes, marked: watch.marked, fresh, spinning };
  if (mark) {
    watch.marked = watch.changes;
    watch.spinners = new WeakSet(endless);
  }
  return state;
};

/** How often a settling read asks the page again. */
export const BRIDGE_READ_SETTLE_POLL_MS = 100;

/** The settle a read asks for, in milliseconds: none when it asks none or nonsense, at most
 *  {@link BRIDGE_READ_SETTLE_MAX_MS}. */
export const readSettleMs = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, BRIDGE_READ_SETTLE_MAX_MS) : undefined;

/** The wait for a change a read asks for, in milliseconds: none when it asks none or nonsense, at most
 *  {@link BRIDGE_WAIT_CHANGE_MAX_MS}. */
export const readWaitChangeMs = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, BRIDGE_WAIT_CHANGE_MAX_MS) : undefined;
