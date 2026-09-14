/** D-267 — universal search becomes reachable from anywhere.
 *
 *  Pins the chord itself and the one entry every surface calls. ⛔ What is
 *  deliberately NOT here is a second search surface: the chord puts the owner
 *  IN `#data/search` (navigating, or re-focusing when already there), because
 *  the answer is computed in the Data route's
 *  `runUniversalSearch` (sequence guard, recipe/pack rank, the
 *  owner-initiated-only marketplace posture). Two surfaces computing their own
 *  answers is two answers, and the wrong one would be the one nobody is
 *  looking at.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  isUniversalSearchShortcut,
  mountUniversalSearchShortcut,
  UNIVERSAL_SEARCH_SHORTCUT,
} from '../shell/universal-search-shortcut.js';

interface FakeModal {
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
}

const makeDoc = (modals: FakeModal[] = []) => {
  const listeners: Array<(event: unknown) => void> = [];
  const doc = {
    querySelectorAll: (selector: string): FakeModal[] =>
      selector === '[aria-modal="true"]' ? modals : [],
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (type === 'keydown') listeners.push(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      if (type !== 'keydown') return;
      const index = listeners.indexOf(fn);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  const press = (overrides: Record<string, unknown> = {}) => {
    const event = {
      key: '/',
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      isComposing: false,
      repeat: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...overrides,
    };
    for (const fn of [...listeners]) fn(event);
    return event;
  };
  return { doc: doc as unknown as Document, press, listenerCount: () => listeners.length };
};

const visibleModal: FakeModal = {
  hasAttribute: () => false,
  getAttribute: () => null,
};

describe('D-267 — the universal-search chord', () => {
  it('accepts Ctrl+/ and Cmd+/ and nothing adjacent to them', () => {
    const base = {
      key: '/', metaKey: false, ctrlKey: false,
      shiftKey: false, altKey: false, isComposing: false,
    };
    expect(isUniversalSearchShortcut({ ...base, metaKey: true })).toBe(true);
    expect(isUniversalSearchShortcut({ ...base, ctrlKey: true })).toBe(true);
    // ⛔ NOT bare `/`. The webclient is full of text inputs and a bare-slash
    // chord would swallow the character in every one of them.
    expect(isUniversalSearchShortcut(base)).toBe(false);
    // Shift is excluded so Cmd+? (the same physical key on many layouts)
    // stays free for a help affordance.
    expect(isUniversalSearchShortcut({ ...base, metaKey: true, shiftKey: true })).toBe(false);
    expect(isUniversalSearchShortcut({ ...base, metaKey: true, altKey: true })).toBe(false);
    expect(isUniversalSearchShortcut({ ...base, metaKey: true, isComposing: true })).toBe(false);
    expect(isUniversalSearchShortcut({ ...base, key: 'k', metaKey: true })).toBe(false);
    // The advertised spelling is what a control would put in aria-keyshortcuts.
    expect(UNIVERSAL_SEARCH_SHORTCUT).toBe('Control+/ Meta+/');
  });

  it('closes transient chrome, then navigates — in that order', () => {
    const order: string[] = [];
    const { doc, press } = makeDoc();
    const handle = mountUniversalSearchShortcut({
      document: doc,
      prepareOpen: () => order.push('prepare'),
      navigate: () => order.push('navigate'),
    });
    const event = press();
    expect(order).toEqual(['prepare', 'navigate']);
    // Claimed unconditionally so the browser never opens its own find-in-page
    // over the app.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('⛔ declines while a modal owns the UI — an open capture is not navigated away from', () => {
    const navigate = vi.fn();
    const prepareOpen = vi.fn();
    const { doc, press } = makeDoc([visibleModal]);
    const handle = mountUniversalSearchShortcut({ document: doc, navigate, prepareOpen });
    const event = press();
    expect(navigate).not.toHaveBeenCalled();
    // ⚠ prepareOpen must NOT run either: it closes the drawer, and a declined
    // chord that still closed chrome would be a visible half-action.
    expect(prepareOpen).not.toHaveBeenCalled();
    // Still claimed — the browser's own UI must not take focus out of the app
    // just because Recued declined.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(handle.open()).toBe(false);
    handle.dispose();
  });

  it('ignores a held chord and stops answering after dispose', () => {
    const navigate = vi.fn();
    const { doc, press, listenerCount } = makeDoc();
    const handle = mountUniversalSearchShortcut({ document: doc, navigate });
    press();
    press({ repeat: true });
    expect(navigate).toHaveBeenCalledTimes(1);
    // A non-chord keystroke is not claimed at all.
    const other = press({ key: 'a' });
    expect(other.preventDefault).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);

    handle.dispose();
    expect(listenerCount()).toBe(0);
    expect(handle.open()).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('⛔ re-focuses instead of re-navigating when search is ALREADY the address', () => {
    const navigate = vi.fn();
    const focusActive = vi.fn();
    const { doc, press } = makeDoc();
    const handle = mountUniversalSearchShortcut({
      document: doc,
      navigate,
      focusActive,
      isActive: () => true,
    });
    press();
    // ⛔ THE PAIR IS THE ASSERTION. Navigating to the hash you already have
    // fires no hashchange, so nothing remounts and nothing claims the box —
    // the chord became a silent no-op in the one place the owner most expects
    // it (they clicked a result, then reached for the chord to search again).
    // Measured in a real browser before this branch existed: hash unchanged,
    // activeElement still the tab they had tabbed to.
    expect(focusActive).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('still navigates when the address is elsewhere, and never does both', () => {
    const navigate = vi.fn();
    const focusActive = vi.fn();
    const { doc, press } = makeDoc();
    const handle = mountUniversalSearchShortcut({
      document: doc,
      navigate,
      focusActive,
      isActive: () => false,
    });
    press();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(focusActive).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('a host that wires neither predicate keeps navigating', () => {
    const navigate = vi.fn();
    const { doc, press } = makeDoc();
    const handle = mountUniversalSearchShortcut({ document: doc, navigate });
    press();
    expect(navigate).toHaveBeenCalledTimes(1);
    handle.dispose();
  });
});
