/**
 * D-267 — one global chord that puts the owner in universal search, typing.
 *
 * ⛔ THIS OPENS NO SEARCH SURFACE. It puts the owner in `#data/search`, which is
 * where the answer is computed. The obvious symmetry with the Create overlay is
 * to portal a search modal, and it would be wrong: `renderUniversalSearch` is
 * pure and would render fine, but the *answer* lives in the Data route's
 * `runUniversalSearch` — sequence guard, debounce, the recipe/pack rank, the
 * pack-absorbs-member rule, and the owner-initiated-only marketplace posture. A
 * second surface computing its own answer is a second answer, and the wrong one
 * would be the one nobody is looking at. Search's problem was REACH, not
 * surface: the route is durable and deep-linkable and stays the only one.
 *
 * ⚠ Declines while a modal holds the UI — a chord that navigated away from an
 * unfinished Create capture would destroy it. Same question the Run palette
 * asks, through the same helper.
 *
 * Pure module (DOM + a navigate callback; no engine, no rpc).
 */

import { activeBlockingModal } from './blocking-modal.js';

/** `aria-keyshortcuts` spelling for any control that advertises this chord. */
export const UNIVERSAL_SEARCH_SHORTCUT = 'Control+/ Meta+/';

/** How to SAY the chord to a person, per platform. ⛔ Exported because a chord
 *  with no visible spelling is a chord nobody finds: the Run palette earns its
 *  ⌘K by putting it on a top-bar trigger, and search has no such trigger — the
 *  Find chip is where this one has to be said. Keeping the spelling here means
 *  the chord and the label it advertises cannot drift apart. */
export const universalSearchShortcutLabel = (doc: Document): string => {
  const platform = doc.defaultView?.navigator?.platform
    ?? (globalThis as { navigator?: Navigator }).navigator?.platform
    ?? '';
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '⌘/' : 'Ctrl /';
};

export type UniversalSearchShortcutEvent = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'isComposing' | 'key' | 'metaKey' | 'shiftKey'
>;

/** Exact global chord: Ctrl/Cmd + `/`. ⚠ Deliberately NOT bare `/` — the
 *  webclient is full of text inputs, and a bare-slash chord would swallow the
 *  character in every one of them. Shift is excluded so `Cmd+?` (help, on many
 *  layouts the same physical key) stays free. */
export const isUniversalSearchShortcut = (
  event: UniversalSearchShortcutEvent,
): boolean =>
  !event.isComposing
  && !event.altKey
  && !event.shiftKey
  && (event.ctrlKey || event.metaKey)
  && event.key === '/';

export interface UniversalSearchShortcutOptions {
  readonly document: Document;
  /** Navigate to the search surface. The shell passes its hash writer. */
  readonly navigate: () => void;
  /** ⛔ True when the search surface is ALREADY the active address. Without
   *  this the chord is a no-op exactly where the owner most expects it to work:
   *  `navigate` writes the hash it already has, no hashchange fires, nothing
   *  remounts, and nothing claims the box — so pressing it after clicking into
   *  a result left focus parked on that row. Measured in a real browser before
   *  this existed: hash unchanged, activeElement still the tab. */
  readonly isActive?: () => boolean;
  /** Put the caret back in the box without navigating. Used only when
   *  `isActive` says the address is already correct. */
  readonly focusActive?: () => void;
  /** Close transient shell chrome (the drawer) before navigating. */
  readonly prepareOpen?: () => void;
}

export interface UniversalSearchShortcutHandle {
  /** Fired by the chord, the composer chip, and anything else that should land
   *  the owner in search. Returns false when a modal owns the UI. */
  open(): boolean;
  dispose(): void;
}

export const mountUniversalSearchShortcut = (
  opts: UniversalSearchShortcutOptions,
): UniversalSearchShortcutHandle => {
  const doc = opts.document;
  let disposed = false;

  const open = (): boolean => {
    if (disposed) return false;
    if (activeBlockingModal(doc) !== null) return false;
    opts.prepareOpen?.();
    // 🔑 THE CHORD'S PROMISE IS "you are now typing in search", not "the address
    // is now search". Those differ only when the address already matched, which
    // is the case a hash writer cannot serve.
    if (opts.isActive?.() === true) opts.focusActive?.();
    else opts.navigate();
    return true;
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (!isUniversalSearchShortcut(event)) return;
    // Claim every accepted chord, including one pressed while a modal is up, so
    // the browser does not open its own find-in-page over the app.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    open();
  };
  doc.addEventListener('keydown', onKeydown, true);

  return {
    open,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      doc.removeEventListener('keydown', onKeydown, true);
    },
  };
};
