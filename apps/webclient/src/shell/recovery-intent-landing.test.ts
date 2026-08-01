import { describe, expect, it, vi } from 'vitest';

import {
  focusRecoveryIntentLanding,
  mountRecoveryIntentOrientation,
  RECOVERY_INTENT_ANNOUNCER_ATTR,
  RECOVERY_INTENT_CUE_ATTR,
  RECOVERY_INTENT_CUE_DURATION_MS,
  RECOVERY_INTENT_RESUME_WINDOW_MS,
} from './recovery-intent-landing.js';
import { WEBCLIENT_POLISH_STYLES } from './webclient-polish-styles.js';

interface TestElement extends HTMLElement {
  readonly attrs: Map<string, string>;
  readonly childList: TestElement[];
  readonly focusMock: ReturnType<typeof vi.fn<(options?: FocusOptions) => void>>;
  readonly textContentWrites: string[];
  parentRef: TestElement | null;
  append(...children: TestElement[]): void;
}

const element = (
  tag: string,
  attrs: Record<string, string> = {},
  children: TestElement[] = [],
): TestElement => {
  const attributeMap = new Map(Object.entries(attrs));
  const childList = [...children];
  const focusMock = vi.fn<(options?: FocusOptions) => void>();
  const textContentWrites: string[] = [];
  let textContent = '';
  const target = {
    tagName: tag.toUpperCase(),
    attrs: attributeMap,
    childList,
    focusMock,
    textContentWrites,
    parentRef: null,
    get parentElement(): TestElement | null {
      return (target as unknown as TestElement).parentRef;
    },
    focus(options?: FocusOptions): void {
      focusMock(options);
    },
    get children(): HTMLCollection {
      return childList as unknown as HTMLCollection;
    },
    hasAttribute(name: string): boolean {
      return attributeMap.has(name);
    },
    getAttribute(name: string): string | null {
      return attributeMap.get(name) ?? null;
    },
    setAttribute(name: string, value: string): void {
      attributeMap.set(name, value);
    },
    removeAttribute(name: string): void {
      attributeMap.delete(name);
    },
    get textContent(): string {
      return textContent;
    },
    set textContent(value: string) {
      textContent = value;
      textContentWrites.push(value);
    },
    appendChild(child: TestElement): TestElement {
      childList.push(child);
      child.parentRef = target as unknown as TestElement;
      return child;
    },
    removeChild(child: TestElement): TestElement {
      const index = childList.indexOf(child);
      if (index < 0) throw new Error('removeChild: not a child');
      childList.splice(index, 1);
      child.parentRef = null;
      return child;
    },
    remove(): void {
      const self = target as unknown as TestElement;
      self.parentRef?.removeChild(self);
    },
    append(...next: TestElement[]): void {
      for (const child of next) {
        (target as unknown as TestElement).appendChild(child);
      }
    },
  };
  const result = target as unknown as TestElement;
  for (const child of childList) child.parentRef = result;
  return result;
};

interface TestDocument extends Document {
  fireEvent(type: string, target?: EventTarget): void;
  firePageHide(): void;
  listenerCount(type: string): number;
  pageHideListenerCount(): number;
}

const testDocument = (): TestDocument => {
  const documentListeners = new Map<string, Set<EventListener>>();
  const pageListeners = new Set<() => void>();
  const view = {
    addEventListener(type: string, listener: () => void): void {
      if (type === 'pagehide') pageListeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void): void {
      if (type === 'pagehide') pageListeners.delete(listener);
    },
  };
  return {
    createElement: (tag: string): TestElement => element(tag),
    addEventListener: (type: string, listener: EventListener): void => {
      const set = documentListeners.get(type) ?? new Set<EventListener>();
      set.add(listener);
      documentListeners.set(type, set);
    },
    removeEventListener: (type: string, listener: EventListener): void => {
      documentListeners.get(type)?.delete(listener);
    },
    defaultView: view,
    fireEvent: (type: string, target?: EventTarget): void => {
      const event = { type, target: target ?? null } as unknown as Event;
      for (const listener of [...documentListeners.get(type) ?? []]) {
        listener(event);
      }
    },
    firePageHide: (): void => {
      for (const listener of [...pageListeners]) listener();
    },
    listenerCount: (type: string): number =>
      documentListeners.get(type)?.size ?? 0,
    pageHideListenerCount: (): number => pageListeners.size,
  } as unknown as TestDocument;
};

describe('route-specific recovery intent landing', () => {
  it('lands Choose again on Chat history search instead of a session or shell', () => {
    const search = element('input', {
      'data-recued-chat-route-history-search': '',
      type: 'search',
    });
    const row = element('a', {
      'data-recued-chat-route-session-row': 'private-session-id',
      href: '#chat/session/private-session-id',
    });
    const shell = element('main', {}, [
      element('section', {}, [row, search]),
    ]);

    const focused = focusRecoveryIntentLanding({
      root: shell,
      route: 'chat',
      intent: 'choose_again',
    });

    expect(focused).toBe(search);
    expect(search.focusMock).toHaveBeenCalledOnce();
    expect(row.focusMock).not.toHaveBeenCalled();
    expect(shell.focusMock).not.toHaveBeenCalled();
  });

  it('lands Continue on the first visible, enabled Contracts work item', () => {
    const hiddenRow = element('a', {
      'data-recued-contracts-row': 'old-private-id',
      href: '#contracts/old-private-id',
      hidden: '',
    });
    const disabledRow = element('button', {
      'data-recued-contracts-row': 'disabled-private-id',
      disabled: '',
    });
    const currentRow = element('a', {
      'data-recued-contracts-row': 'new-private-id',
      href: '#contracts/new-private-id',
    });
    const shell = element('main', {}, [hiddenRow, disabledRow, currentRow]);

    const focused = focusRecoveryIntentLanding({
      root: shell,
      route: 'contracts',
      intent: 'continue',
    });

    expect(focused).toBe(currentRow);
    expect(currentRow.focusMock).toHaveBeenCalledOnce();
    expect(hiddenRow.focusMock).not.toHaveBeenCalled();
    expect(disabledRow.focusMock).not.toHaveBeenCalled();
  });

  it('falls through when a preferred route target cannot accept focus', () => {
    const brokenRow = element('a', {
      'data-recued-contracts-row': 'private-broken-id',
      href: '#contracts/private-broken-id',
    });
    brokenRow.focus = (options?: FocusOptions): void => {
      brokenRow.focusMock(options);
      throw new Error('focus unavailable');
    };
    const usableRow = element('a', {
      'data-recued-contracts-row': 'private-usable-id',
      href: '#contracts/private-usable-id',
    });
    const shell = element('main', {}, [brokenRow, usableRow]);

    const focused = focusRecoveryIntentLanding({
      root: shell,
      route: 'contracts',
      intent: 'continue',
    });

    expect(focused).toBe(usableRow);
    expect(brokenRow.focusMock).toHaveBeenCalledTimes(2);
    expect(usableRow.focusMock).toHaveBeenCalledOnce();
  });

  it('lands Review on the unresolved panel and makes it programmatically focusable', () => {
    const error = element('p', {
      'data-recued-logs-error': 'server-owned error detail',
      role: 'alert',
    });
    const heading = element('h1', {
      'data-recued-logs-route-heading': '',
    });
    const shell = element('main', {}, [heading, error]);

    const focused = focusRecoveryIntentLanding({
      root: shell,
      route: 'logs',
      intent: 'review',
    });

    expect(focused).toBe(error);
    expect(error.getAttribute('tabindex')).toBe('-1');
    expect(error.focusMock).toHaveBeenCalledOnce();
    expect(heading.focusMock).not.toHaveBeenCalled();
  });

  it('uses the active route tab for Choose again, not the first tab in DOM order', () => {
    const mail = element('a', { href: '#connections/mail' });
    const others = element('a', {
      href: '#connections/others',
      'aria-current': 'page',
    });
    const tabs = element('nav', {
      'data-recued-connections-route-tabs': '',
    }, [mail, others]);
    const shell = element('main', {}, [tabs]);

    const focused = focusRecoveryIntentLanding({
      root: shell,
      route: 'connections',
      intent: 'choose_again',
    });

    expect(focused).toBe(others);
    expect(others.focusMock).toHaveBeenCalledOnce();
    expect(mail.focusMock).not.toHaveBeenCalled();
  });

  it('keeps Packs reselection on existing-pack discovery ahead of Add by slug', () => {
    const addInput = element('input', {
      'data-recued-packs-surface-add-input': '',
    });
    const search = element('input', {
      'data-recued-discover-search': '',
      type: 'search',
    });
    const shell = element('main', {}, [addInput, search]);

    const focused = focusRecoveryIntentLanding({
      root: shell,
      route: 'packs',
      intent: 'choose_again',
    });

    expect(focused).toBe(search);
    expect(search.focusMock).toHaveBeenCalledOnce();
    expect(addInput.focusMock).not.toHaveBeenCalled();
  });

  it('keeps Continue inside the active Settings section', () => {
    const staleControl = element('button');
    const staleSection = element('section', {
      'data-recued-settings-section': 'private-old-section',
      'data-active': 'false',
    }, [staleControl]);
    const currentControl = element('button');
    const currentSection = element('section', {
      'data-recued-settings-section': 'private-current-section',
      'data-active': 'true',
    }, [currentControl]);
    const shell = element('main', {}, [staleSection, currentSection]);

    const focused = focusRecoveryIntentLanding({
      root: shell,
      route: 'settings',
      intent: 'continue',
    });

    expect(focused).toBe(currentControl);
    expect(currentControl.focusMock).toHaveBeenCalledOnce();
    expect(staleControl.focusMock).not.toHaveBeenCalled();
  });

  it('returns null instead of treating the broad shell as a route target', () => {
    const shell = element('main');

    expect(focusRecoveryIntentLanding({
      root: shell,
      route: 'data',
      intent: 'review',
    })).toBeNull();
    expect(shell.focusMock).not.toHaveBeenCalled();
    expect(shell.hasAttribute('tabindex')).toBe(false);
  });

  it('orients once, announces only the intent, and clears every replay path', () => {
    const doc = testDocument();
    const target = element('button', {
      'data-private-record-id': 'must-never-be-announced',
    });
    const root = element('main', {}, [target]);
    const statusHost = element('div');
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const clearTimer = vi.fn((handle: unknown) => {
      timers.delete(handle as number);
    });
    const mount = mountRecoveryIntentOrientation({
      root,
      statusHost,
      document: doc,
      setTimer: (handler, delayMs) => {
        expect(delayMs).toBe(RECOVERY_INTENT_CUE_DURATION_MS);
        nextTimer += 1;
        timers.set(nextTimer, handler);
        return nextTimer;
      },
      clearTimer,
    });
    const announcer = statusHost.childList[0]!;
    expect(announcer.hasAttribute(RECOVERY_INTENT_ANNOUNCER_ATTR)).toBe(true);
    expect(announcer.getAttribute('role')).toBe('status');
    expect(announcer.getAttribute('aria-live')).toBe('polite');
    expect(announcer.getAttribute('aria-atomic')).toBe('true');
    expect(announcer.textContent).toBe('');
    expect(doc.listenerCount('click')).toBe(0);
    expect(doc.pageHideListenerCount()).toBe(0);

    mount.orient({ target, intent: 'continue', route: 'contracts' });
    expect(target.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('continue');
    expect(announcer.textContent).toBe('Continue here.');
    expect(announcer.textContent).not.toContain('must-never-be-announced');
    expect(doc.listenerCount('click')).toBe(1);
    expect(doc.listenerCount('focusin')).toBe(1);
    expect(doc.pageHideListenerCount()).toBe(1);

    mount.orient({ target, intent: 'review', route: 'contracts' });
    expect(target.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('review');
    expect(announcer.textContent).toBe(
      'Review this status before continuing.',
    );
    expect(clearTimer).toHaveBeenCalledWith(1);
    doc.fireEvent('click');
    expect(target.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(announcer.textContent).toBe('');
    expect(clearTimer).toHaveBeenCalledWith(2);
    expect(doc.listenerCount('click')).toBe(0);
    expect(doc.listenerCount('focusin')).toBe(0);
    expect(doc.pageHideListenerCount()).toBe(0);

    mount.orient({ target, intent: 'review', route: 'contracts' });
    expect(announcer.textContent).toBe(
      'Review this status before continuing.',
    );
    doc.firePageHide();
    expect(target.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(announcer.textContent).toBe('');
    expect(clearTimer).toHaveBeenCalledWith(3);

    mount.orient({ target, intent: 'choose_again', route: 'contracts' });
    timers.get(4)?.();
    expect(target.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(announcer.textContent).toBe('');

    for (const event of ['pointerdown', 'keydown', 'input']) {
      mount.orient({ target, intent: 'continue', route: 'contracts' });
      doc.fireEvent(event);
      expect(target.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
      expect(announcer.textContent).toBe('');
    }

    mount.dispose();
    expect(statusHost.childList).toHaveLength(0);
    mount.orient({ target, intent: 'continue', route: 'contracts' });
    expect(target.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
  });

  it('keeps one cue aligned through live replacements without reclaiming deliberate focus', () => {
    const doc = testDocument();
    const firstControl = element('button', {
      'data-recued-contracts-row': 'private-first-row',
    });
    const brokenControl = element('button', {
      'data-recued-contracts-row': 'private-broken-row',
    });
    const successorControl = element('button', {
      'data-recued-contracts-row': 'private-successor-row',
    });
    const laterControl = element('button', {
      'data-recued-contracts-row': 'private-later-row',
    });
    const root = element('main', {}, [
      firstControl,
      brokenControl,
      successorControl,
      laterControl,
    ]);
    const statusHost = element('div');
    let fireMutation = (): void => undefined;
    const stopObserving = vi.fn();
    const observeMutations = vi.fn((
      observedRoot: HTMLElement,
      onMutation: () => void,
    ) => {
      expect(observedRoot).toBe(root);
      fireMutation = onMutation;
      return stopObserving;
    });
    const setTimer = vi.fn(() => 41);
    const clearTimer = vi.fn();
    const mount = mountRecoveryIntentOrientation({
      root,
      statusHost,
      document: doc,
      observeMutations,
      setTimer,
      clearTimer,
    });
    for (const control of [
      firstControl,
      successorControl,
      laterControl,
    ]) {
      control.focus = (options?: FocusOptions): void => {
        control.focusMock(options);
        doc.fireEvent('focusin', control);
      };
    }
    brokenControl.focus = (options?: FocusOptions): void => {
      brokenControl.focusMock(options);
      throw new Error('focus unavailable');
    };
    const initialTarget = focusRecoveryIntentLanding({
      root,
      route: 'contracts',
      intent: 'continue',
    });
    expect(initialTarget).toBe(firstControl);
    mount.orient({
      target: initialTarget!,
      intent: 'continue',
      route: 'contracts',
    });
    const announcer = statusHost.childList[0]!;
    const continueAnnouncements = (): number =>
      announcer.textContentWrites.filter((copy) => copy === 'Continue here.')
        .length;
    expect(continueAnnouncements()).toBe(1);
    expect(setTimer).toHaveBeenCalledOnce();
    expect(observeMutations).toHaveBeenCalledOnce();

    // Unrelated live changes do not disturb valid focus.
    fireMutation();
    expect(firstControl.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('continue');
    expect(successorControl.focusMock).not.toHaveBeenCalled();

    // A live update disables the focused row. The current policy chooses and
    // focuses one successor while retaining the original cue deadline/copy.
    firstControl.setAttribute('disabled', '');
    fireMutation();
    expect(firstControl.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(brokenControl.focusMock).toHaveBeenCalledTimes(2);
    expect(successorControl.focusMock).toHaveBeenCalledOnce();
    expect(successorControl.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'continue',
    );
    expect(announcer.textContent).toBe('Continue here.');
    expect(continueAnnouncements()).toBe(1);
    expect(setTimer).toHaveBeenCalledOnce();
    expect(stopObserving).not.toHaveBeenCalled();

    // A second authoritative paint may replace the interim loading DOM. Keep
    // the original cue/timer through that common two-phase refresh as well.
    root.removeChild(successorControl);
    fireMutation();
    expect(successorControl.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(laterControl.focusMock).toHaveBeenCalledOnce();
    expect(laterControl.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'continue',
    );
    expect(announcer.textContent).toBe('Continue here.');
    expect(continueAnnouncements()).toBe(1);
    expect(setTimer).toHaveBeenCalledOnce();
    expect(stopObserving).not.toHaveBeenCalled();

    // A programmatic route focus is deliberate ownership, even without a
    // pointer/key event. Retire now so later mutations cannot pull focus back.
    const routeOwnedStatus = element('p', { role: 'status' });
    root.appendChild(routeOwnedStatus);
    doc.fireEvent('focusin', routeOwnedStatus);
    expect(laterControl.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(announcer.textContent).toBe('');
    expect(clearTimer).toHaveBeenCalledWith(41);
    expect(stopObserving).toHaveBeenCalledOnce();

    root.removeChild(laterControl);
    fireMutation();
    expect(laterControl.focusMock).toHaveBeenCalledOnce();

    mount.dispose();
  });

  it('promotes a stale action cue to one exact Review condition', () => {
    const doc = testDocument();
    const action = element('a', {
      'data-recued-contracts-row': 'private-action',
      href: '#contracts/private-action',
    });
    const root = element('main', {}, [action]);
    const statusHost = element('div');
    let fireMutation = (): void => undefined;
    const stopObserving = vi.fn();
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const setTimer = vi.fn((handler: () => void, _delayMs: number) => {
      nextTimer += 1;
      timers.set(nextTimer, handler);
      return nextTimer;
    });
    const clearTimer = vi.fn((handle: unknown) => {
      timers.delete(handle as number);
    });
    const mount = mountRecoveryIntentOrientation({
      root,
      statusHost,
      document: doc,
      observeMutations: (_root, onMutation) => {
        fireMutation = onMutation;
        return stopObserving;
      },
      setTimer,
      clearTimer,
    });
    mount.orient({ target: action, intent: 'continue', route: 'contracts' });
    const announcer = statusHost.childList[0]!;
    expect(announcer.textContent).toBe('Continue here.');
    expect(setTimer).toHaveBeenCalledOnce();

    // The action can remain mounted while an authoritative route error
    // arrives. The exact error, not a generic heading, becomes the target.
    const firstError = element('p', {
      'data-recued-contracts-unavailable': 'private-error-code',
    });
    firstError.focus = (options?: FocusOptions): void => {
      firstError.focusMock(options);
      doc.fireEvent('focusin', firstError);
    };
    root.appendChild(firstError);
    fireMutation();
    expect(action.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(firstError.focusMock).toHaveBeenCalledOnce();
    expect(firstError.getAttribute('tabindex')).toBe('-1');
    expect(firstError.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('review');
    expect(announcer.textContent).toBe(
      'This changed. Review this status before continuing.',
    );
    expect(announcer.textContent).not.toContain('private-error-code');
    expect(clearTimer).toHaveBeenCalledWith(1);
    expect(setTimer).toHaveBeenCalledTimes(2);

    // Stable mutations neither replay the semantic announcement nor extend
    // its renewed deadline.
    fireMutation();
    expect(firstError.focusMock).toHaveBeenCalledOnce();
    expect(setTimer).toHaveBeenCalledTimes(2);
    expect(announcer.textContentWrites.filter((copy) =>
      copy === 'This changed. Review this status before continuing.'
    )).toHaveLength(1);

    // A higher-priority sibling condition does not reorder an exact Review
    // that remains current.
    const replacementError = element('p', {
      'data-recued-contracts-error': 'private-replacement-code',
    });
    replacementError.focus = (options?: FocusOptions): void => {
      replacementError.focusMock(options);
      doc.fireEvent('focusin', replacementError);
    };
    root.appendChild(replacementError);
    fireMutation();
    expect(firstError.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('review');
    expect(firstError.focusMock).toHaveBeenCalledOnce();
    expect(replacementError.focusMock).not.toHaveBeenCalled();
    expect(setTimer).toHaveBeenCalledTimes(2);

    // Review remains one-way for this short cue window. Once the original
    // marker resolves, an already-mounted replacement inherits the exact cue
    // without reverting to stale Continue language or extending the timer.
    firstError.removeAttribute('data-recued-contracts-unavailable');
    fireMutation();
    expect(firstError.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(replacementError.focusMock).toHaveBeenCalledOnce();
    expect(replacementError.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'review',
    );
    expect(setTimer).toHaveBeenCalledTimes(2);
    expect(announcer.textContent).not.toContain('private-replacement-code');

    // Review is visually short-lived, but its exact passive watch remains.
    // A later authoritative resolution can therefore complete the handoff
    // without keeping a persistent outline or announcement on screen.
    timers.get(2)?.();
    expect(replacementError.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(announcer.textContent).toBe('');
    expect(stopObserving).not.toHaveBeenCalled();
    expect(setTimer).toHaveBeenCalledTimes(3);
    expect(setTimer.mock.calls[2]?.[1]).toBe(
      RECOVERY_INTENT_RESUME_WINDOW_MS,
    );

    replacementError.removeAttribute('data-recued-contracts-error');
    fireMutation();
    expect(action.focusMock).toHaveBeenCalledOnce();
    expect(action.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('continue');
    expect(announcer.textContent).toBe('Ready again. Continue here.');
    expect(announcer.textContent).not.toContain('private-action');
    expect(clearTimer).toHaveBeenCalledWith(3);
    expect(setTimer).toHaveBeenCalledTimes(4);

    // The resolution is announced and focused only once. Ordinary repaint
    // noise cannot replay it or extend its deadline.
    fireMutation();
    expect(action.focusMock).toHaveBeenCalledOnce();
    expect(announcer.textContentWrites.filter((copy) =>
      copy === 'Ready again. Continue here.'
    )).toHaveLength(1);
    expect(setTimer).toHaveBeenCalledTimes(4);

    timers.get(4)?.();
    expect(action.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(announcer.textContent).toBe('');
    expect(stopObserving).toHaveBeenCalledOnce();
    mount.dispose();
  });

  it('classifies an already-settled invalidation before cueing an action', () => {
    const doc = testDocument();
    const action = element('a', {
      'data-recued-contracts-row': 'private-action',
      href: '#contracts/private-action',
    });
    const error = element('p', {
      'data-recued-contracts-error': 'private-error',
    });
    const root = element('main', {}, [action, error]);
    const statusHost = element('div');
    const mount = mountRecoveryIntentOrientation({
      root,
      statusHost,
      document: doc,
      durationMs: 0,
      observeMutations: () => () => undefined,
    });

    mount.orient({ target: action, intent: 'continue', route: 'contracts' });
    expect(action.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(error.focusMock).toHaveBeenCalledOnce();
    expect(error.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('review');
    expect(statusHost.childList[0]!.textContent).toBe(
      'This changed. Review this status before continuing.',
    );
    expect(statusHost.childList[0]!.textContent)
      .not.toContain('private-error');
    mount.dispose();
  });

  it('bounds passive resolution watching after the Review cue fades', () => {
    const doc = testDocument();
    const action = element('a', {
      'data-recued-contracts-row': 'private-action',
      href: '#contracts/private-action',
    });
    const root = element('main', {}, [action]);
    const statusHost = element('div');
    let fireMutation = (): void => undefined;
    const stopObserving = vi.fn();
    const onResumeWindowExpired = vi.fn();
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const mount = mountRecoveryIntentOrientation({
      root,
      statusHost,
      document: doc,
      observeMutations: (_root, onMutation) => {
        fireMutation = onMutation;
        return stopObserving;
      },
      setTimer: (handler) => {
        nextTimer += 1;
        timers.set(nextTimer, handler);
        return nextTimer;
      },
      onResumeWindowExpired,
    });
    mount.orient({ target: action, intent: 'continue', route: 'contracts' });
    const error = element('p', { 'data-recued-contracts-error': '' });
    root.appendChild(error);
    fireMutation();

    timers.get(2)?.();
    expect(stopObserving).not.toHaveBeenCalled();
    timers.get(3)?.();
    expect(stopObserving).toHaveBeenCalledOnce();
    expect(onResumeWindowExpired).toHaveBeenCalledOnce();
    expect(onResumeWindowExpired).toHaveBeenCalledWith({
      route: 'contracts',
      intent: 'continue',
    });
    expect(JSON.stringify(onResumeWindowExpired.mock.calls))
      .not.toContain('private-action');
    // A stale timer callback cannot duplicate the quiet handoff.
    timers.get(3)?.();
    expect(onResumeWindowExpired).toHaveBeenCalledOnce();
    error.removeAttribute('data-recued-contracts-error');
    fireMutation();
    expect(action.focusMock).not.toHaveBeenCalled();
    expect(statusHost.childList[0]!.textContent).toBe('');
    mount.dispose();
  });

  it('restores the original Choose again intent after exact resolution', () => {
    const doc = testDocument();
    const chooser = element('a', {
      'data-recued-contracts-list-tab': '',
      'data-active': 'true',
      href: '#contracts',
    });
    chooser.focus = (options?: FocusOptions): void => {
      chooser.focusMock(options);
      doc.fireEvent('focusin', chooser);
    };
    const root = element('main', {}, [chooser]);
    const statusHost = element('div');
    let fireMutation = (): void => undefined;
    const mount = mountRecoveryIntentOrientation({
      root,
      statusHost,
      document: doc,
      durationMs: 0,
      observeMutations: (_root, onMutation) => {
        fireMutation = onMutation;
        return () => undefined;
      },
    });
    mount.orient({
      target: chooser,
      intent: 'choose_again',
      route: 'contracts',
    });
    const error = element('p', { 'data-recued-contracts-error': '' });
    root.appendChild(error);
    fireMutation();
    expect(error.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('review');

    error.removeAttribute('data-recued-contracts-error');
    fireMutation();
    expect(chooser.focusMock).toHaveBeenCalledOnce();
    expect(chooser.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(
      'choose_again',
    );
    expect(statusHost.childList[0]!.textContent).toBe(
      'Ready again. Choose again here.',
    );
    mount.dispose();
  });

  it('waits for the exact resolved action to become ready', () => {
    const doc = testDocument();
    const action = element('a', {
      'data-recued-contracts-row': 'private-action',
      href: '#contracts/private-action',
    });
    action.focus = (options?: FocusOptions): void => {
      action.focusMock(options);
      doc.fireEvent('focusin', action);
    };
    const root = element('main', {}, [action]);
    const statusHost = element('div');
    let fireMutation = (): void => undefined;
    const stopObserving = vi.fn();
    const mount = mountRecoveryIntentOrientation({
      root,
      statusHost,
      document: doc,
      durationMs: 0,
      observeMutations: (_root, onMutation) => {
        fireMutation = onMutation;
        return stopObserving;
      },
    });
    mount.orient({ target: action, intent: 'continue', route: 'contracts' });
    const error = element('p', { 'data-recued-contracts-error': '' });
    root.appendChild(error);
    fireMutation();

    action.setAttribute('aria-busy', 'true');
    error.removeAttribute('data-recued-contracts-error');
    fireMutation();
    expect(error.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(action.focusMock).not.toHaveBeenCalled();
    expect(action.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(statusHost.childList[0]!.textContent).toBe('');
    expect(stopObserving).not.toHaveBeenCalled();

    action.removeAttribute('aria-busy');
    fireMutation();
    expect(action.focusMock).toHaveBeenCalledOnce();
    expect(action.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('continue');
    expect(statusHost.childList[0]!.textContent).toBe(
      'Ready again. Continue here.',
    );
    mount.dispose();
  });

  it('recognizes only closed route-owned invalidation states', () => {
    const cases: ReadonlyArray<{
      route: Parameters<typeof focusRecoveryIntentLanding>[0]['route'];
      attrs: Record<string, string>;
      scopeAttr?: string;
    }> = [
      {
        route: 'reception',
        attrs: { 'data-recued-reception-response-error': '' },
      },
      { route: 'settings', attrs: { 'data-recued-updates-error': '' } },
      { route: 'approvals', attrs: { 'data-recued-approvals-empty': '' } },
      {
        route: 'kitchen',
        attrs: { 'data-recued-recipe-editor-issues': '' },
      },
      {
        route: 'contracts',
        attrs: { 'data-recued-contracts-unavailable': '' },
      },
      {
        route: 'connections',
        attrs: { 'data-recued-connections-route-unavailable': '' },
      },
      { route: 'packs', attrs: { 'data-recued-packs-list-error': '' } },
      {
        route: 'recipes',
        attrs: { 'data-recued-recipes-runnability': 'blocked' },
        scopeAttr: 'data-recued-recipes-card',
      },
      {
        route: 'automation',
        attrs: {
          'data-recued-automation-state': '',
          'data-armed': 'tripped',
        },
        scopeAttr: 'data-recued-automation-row',
      },
      { route: 'data', attrs: { 'data-recued-data-source-error': '' } },
      {
        route: 'logs',
        attrs: { 'data-recued-logs-status': 'in_doubt' },
        scopeAttr: 'data-recued-logs-row',
      },
      { route: 'chat', attrs: { 'data-recued-chat-route-error': '' } },
    ];

    for (const { route, attrs, scopeAttr } of cases) {
      const doc = testDocument();
      const action = element('button');
      const condition = element('p', attrs);
      const landingHost = scopeAttr === undefined
        ? null
        : element('section', { [scopeAttr]: '' }, [action]);
      const root = element('main', {}, [landingHost ?? action]);
      const statusHost = element('div');
      let fireMutation = (): void => undefined;
      const mount = mountRecoveryIntentOrientation({
        root,
        statusHost,
        document: doc,
        durationMs: 0,
        observeMutations: (_root, onMutation) => {
          fireMutation = onMutation;
          return () => undefined;
        },
      });
      mount.orient({ target: action, intent: 'continue', route });
      (landingHost ?? root).appendChild(condition);
      fireMutation();
      expect(condition.getAttribute(RECOVERY_INTENT_CUE_ATTR), route).toBe(
        'review',
      );
      expect(condition.focusMock, route).toHaveBeenCalledOnce();
      expect(statusHost.childList[0]!.textContent, route).toBe(
        'This changed. Review this status before continuing.',
      );
      mount.dispose();
    }
  });

  it('does not invalidate loading, ordinary input, or non-blocking states', () => {
    const cases: ReadonlyArray<{
      route: Parameters<typeof focusRecoveryIntentLanding>[0]['route'];
      attrs: Record<string, string>;
      scopeAttr?: string;
    }> = [
      {
        route: 'reception',
        attrs: { 'data-recued-reception-inbox-reason': '' },
      },
      { route: 'approvals', attrs: { 'data-recued-approvals-loading': '' } },
      {
        route: 'recipes',
        attrs: { 'data-recued-recipes-runnability': 'runnable' },
        scopeAttr: 'data-recued-recipes-card',
      },
      {
        route: 'automation',
        attrs: {
          'data-recued-automation-state': '',
          'data-armed': 'on',
        },
        scopeAttr: 'data-recued-automation-row',
      },
      {
        route: 'logs',
        attrs: { 'data-recued-logs-status': 'succeeded' },
        scopeAttr: 'data-recued-logs-row',
      },
    ];

    for (const { route, attrs, scopeAttr } of cases) {
      const doc = testDocument();
      const action = element('button');
      const ordinaryState = element('p', attrs);
      const landingHost = scopeAttr === undefined
        ? null
        : element('section', { [scopeAttr]: '' }, [action, ordinaryState]);
      const root = element(
        'main',
        {},
        landingHost === null ? [action, ordinaryState] : [landingHost],
      );
      const statusHost = element('div');
      let fireMutation = (): void => undefined;
      const mount = mountRecoveryIntentOrientation({
        root,
        statusHost,
        document: doc,
        durationMs: 0,
        observeMutations: (_root, onMutation) => {
          fireMutation = onMutation;
          return () => undefined;
        },
      });
      mount.orient({ target: action, intent: 'continue', route });
      fireMutation();
      expect(action.getAttribute(RECOVERY_INTENT_CUE_ATTR), route).toBe(
        'continue',
      );
      expect(ordinaryState.focusMock, route).not.toHaveBeenCalled();
      expect(statusHost.childList[0]!.textContent, route).toBe(
        'Continue here.',
      );
      mount.dispose();
    }
  });

  it('does not jump from the landed item to another item warning', () => {
    const doc = testDocument();
    const action = element('button');
    action.focus = (options?: FocusOptions): void => {
      action.focusMock(options);
      doc.fireEvent('focusin', action);
    };
    const landedState = element('p', {
      'data-recued-recipes-runnability': 'runnable',
    });
    const landedCard = element('article', {
      'data-recued-recipes-card': 'private-landed-recipe',
    }, [action, landedState]);
    const otherBlockedState = element('p', {
      'data-recued-recipes-runnability': 'blocked',
    });
    const otherCard = element('article', {
      'data-recued-recipes-card': 'private-other-recipe',
    }, [otherBlockedState]);
    const root = element('main', {}, [landedCard, otherCard]);
    const statusHost = element('div');
    let fireMutation = (): void => undefined;
    const mount = mountRecoveryIntentOrientation({
      root,
      statusHost,
      document: doc,
      durationMs: 0,
      observeMutations: (_root, onMutation) => {
        fireMutation = onMutation;
        return () => undefined;
      },
    });
    mount.orient({ target: action, intent: 'continue', route: 'recipes' });

    fireMutation();
    expect(action.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('continue');
    expect(otherBlockedState.focusMock).not.toHaveBeenCalled();
    expect(statusHost.childList[0]!.textContent).toBe('Continue here.');

    landedState.setAttribute('data-recued-recipes-runnability', 'blocked');
    fireMutation();
    expect(landedState.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('review');
    expect(landedState.focusMock).toHaveBeenCalledOnce();
    expect(otherBlockedState.focusMock).not.toHaveBeenCalled();
    expect(statusHost.childList[0]!.textContent).toBe(
      'This changed. Review this status before continuing.',
    );

    // If the landed item recovers, return only to its exact original action.
    // The other card's still-blocked state must not inherit either cue.
    landedState.setAttribute('data-recued-recipes-runnability', 'runnable');
    fireMutation();
    expect(landedState.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(action.focusMock).toHaveBeenCalledOnce();
    expect(action.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('continue');
    expect(statusHost.childList[0]!.textContent).toBe(
      'Ready again. Continue here.',
    );
    expect(otherBlockedState.focusMock).not.toHaveBeenCalled();

    // A resumed handoff is one-shot. If readiness regresses, retire instead
    // of bouncing the person back into another Review/Ready focus loop.
    landedState.setAttribute('data-recued-recipes-runnability', 'blocked');
    fireMutation();
    expect(action.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(landedState.focusMock).toHaveBeenCalledOnce();
    expect(statusHost.childList[0]!.textContent).toBe('');
    expect(otherBlockedState.focusMock).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('does not guess a successor when the exact original item disappears', () => {
    const doc = testDocument();
    const originalAction = element('button');
    const originalState = element('p', {
      'data-recued-recipes-runnability': 'runnable',
    });
    const originalCard = element('article', {
      'data-recued-recipes-card': 'private-original-recipe',
    }, [originalAction, originalState]);
    const otherAction = element('button');
    const otherCard = element('article', {
      'data-recued-recipes-card': 'private-other-recipe',
    }, [otherAction]);
    const root = element('main', {}, [originalCard, otherCard]);
    const statusHost = element('div');
    let fireMutation = (): void => undefined;
    const stopObserving = vi.fn();
    const mount = mountRecoveryIntentOrientation({
      root,
      statusHost,
      document: doc,
      durationMs: 0,
      observeMutations: (_root, onMutation) => {
        fireMutation = onMutation;
        return stopObserving;
      },
    });
    mount.orient({
      target: originalAction,
      intent: 'continue',
      route: 'recipes',
    });
    originalState.setAttribute('data-recued-recipes-runnability', 'blocked');
    fireMutation();
    expect(originalState.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('review');

    root.removeChild(originalCard);
    fireMutation();
    expect(otherAction.focusMock).not.toHaveBeenCalled();
    expect(otherAction.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(statusHost.childList[0]!.textContent).toBe('');
    expect(stopObserving).toHaveBeenCalledOnce();
    mount.dispose();
  });

  it('does not reclaim focus after the person takes ownership during Review', () => {
    const doc = testDocument();
    const action = element('a', {
      'data-recued-contracts-row': 'private-action',
      href: '#contracts/private-action',
    });
    const root = element('main', {}, [action]);
    const statusHost = element('div');
    let fireMutation = (): void => undefined;
    const stopObserving = vi.fn();
    const onUserOwnership = vi.fn();
    const onResumeWindowExpired = vi.fn();
    const mount = mountRecoveryIntentOrientation({
      root,
      statusHost,
      document: doc,
      durationMs: 0,
      observeMutations: (_root, onMutation) => {
        fireMutation = onMutation;
        return stopObserving;
      },
      onUserOwnership,
      onResumeWindowExpired,
    });
    mount.orient({ target: action, intent: 'continue', route: 'contracts' });
    const error = element('p', { 'data-recued-contracts-error': '' });
    root.appendChild(error);
    fireMutation();

    const userOwnedControl = element('button');
    root.appendChild(userOwnedControl);
    doc.fireEvent('focusin', userOwnedControl);
    expect(onUserOwnership).toHaveBeenCalledOnce();
    expect(onResumeWindowExpired).not.toHaveBeenCalled();
    expect(stopObserving).toHaveBeenCalledOnce();
    error.removeAttribute('data-recued-contracts-error');
    fireMutation();
    expect(action.focusMock).not.toHaveBeenCalled();
    expect(action.hasAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe(false);
    expect(statusHost.childList[0]!.textContent).toBe('');
    mount.dispose();
  });

  it('keeps a valid Logs landing isolated from sibling-section errors', () => {
    const doc = testDocument();
    const historyRow = element('button', {
      'data-recued-logs-row': 'private-history-run',
    });
    const heading = element('h1', {
      'data-recued-logs-route-heading': '',
    });
    const activeSection = element('section', {
      'data-recued-logs-active': '',
    });
    const root = element('main', {}, [heading, activeSection, historyRow]);
    const statusHost = element('div');
    let fireMutation = (): void => undefined;
    const mount = mountRecoveryIntentOrientation({
      root,
      statusHost,
      document: doc,
      durationMs: 0,
      observeMutations: (_root, onMutation) => {
        fireMutation = onMutation;
        return () => undefined;
      },
    });
    mount.orient({ target: historyRow, intent: 'continue', route: 'logs' });

    const unrelatedActiveError = element('p', {
      'data-recued-logs-error': '',
    });
    activeSection.appendChild(unrelatedActiveError);
    fireMutation();
    expect(historyRow.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('continue');
    expect(unrelatedActiveError.focusMock).not.toHaveBeenCalled();
    expect(statusHost.childList[0]!.textContent).toBe('Continue here.');

    // The History error itself replaces the landed row. Once the original
    // target is gone, the route-wide fallback can safely identify it.
    activeSection.removeChild(unrelatedActiveError);
    root.removeChild(historyRow);
    const historyError = element('p', {
      'data-recued-logs-error': '',
    });
    root.appendChild(historyError);
    fireMutation();
    expect(historyError.getAttribute(RECOVERY_INTENT_CUE_ATTR)).toBe('review');
    expect(historyError.focusMock).toHaveBeenCalledOnce();
    expect(statusHost.childList[0]!.textContent).toBe(
      'This changed. Review this status before continuing.',
    );
    mount.dispose();
  });

  it('keeps the visual cue visible without motion when reduced motion is set', () => {
    expect(WEBCLIENT_POLISH_STYLES).toContain(
      '@keyframes recued-recovery-intent-arrive',
    );
    expect(WEBCLIENT_POLISH_STYLES).toContain(
      '[data-recued-recovery-intent-cue]:focus {',
    );
    expect(WEBCLIENT_POLISH_STYLES).not.toContain(
      'outline-color: transparent',
    );
    expect(WEBCLIENT_POLISH_STYLES).toMatch(
      /prefers-reduced-motion[\s\S]*data-recued-recovery-intent-cue[\s\S]*animation: none !important/,
    );
    expect(WEBCLIENT_POLISH_STYLES).toContain(
      '[data-recued-recovery-intent-announcer]',
    );
  });
});
