/** Connection recovery surface acceptance.
 *
 *  The chip and its popover LEFT this module: the account menu's badge is the
 *  signal now, and that menu carries the explanation and the servers list —
 *  the popover's own third step used to link to Settings ▸ Server, every panel
 *  of which is rpc-driven and so unreachable during the outage that raised it.
 *
 *  What stayed, and is pinned here: the route-independent banner and its
 *  hand-off action, the polite back-online receipt (including its one-shot
 *  and history-restore rules), the visually-hidden aria-live announcer — a
 *  badge is a colour cue, so without this a screen reader learns nothing —
 *  and complete teardown. */

import { describe, expect, it, vi } from 'vitest';

import type { WebclientConnectionStatus } from '../realtime/connection-status.js';
import {
  CONNECTION_BANNER_ACTION_ATTR,
  CONNECTION_BANNER_ATTR,
  CONNECTION_INDICATOR_ATTR,
  CONNECTION_STATUS_ANNOUNCER_ATTR,
  mountConnectionIndicator,
} from '../shell/connection-indicator.js';

interface FakeEvent {
  type: string;
  target: FakeEl | null;
  key?: string;
  defaultPrevented: boolean;
  preventDefault(): void;
}

type FakeListener = (event: FakeEvent) => void;

interface FakeEl {
  tagName: string;
  textContent: string;
  className: string;
  children: FakeEl[];
  parent: FakeEl | null;
  attrs: Map<string, string>;
  listeners: Map<string, Set<FakeListener>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, listener: FakeListener): void;
  click(): void;
  focus(): void;
  contains(node: FakeEl): boolean;
}

interface FakeDocument {
  readonly document: Document;
  readonly activeElement: () => FakeEl | null;
  create(tagName: string): FakeEl;
  fire(type: string, init?: { target?: FakeEl; key?: string }): FakeEvent;
  firePage(type: string): FakeEvent;
  listenerCount(type: string): number;
  pageListenerCount(type: string): number;
}

const buildFakeDocument = (): FakeDocument => {
  let active: FakeEl | null = null;
  const documentListeners = new Map<string, Set<FakeListener>>();
  const pageListeners = new Map<string, Set<FakeListener>>();

  const makeEl = (tagName: string): FakeEl => {
    const el: FakeEl = {
      tagName: tagName.toUpperCase(),
      textContent: '',
      className: '',
      children: [],
      parent: null,
      attrs: new Map(),
      listeners: new Map(),
      setAttribute(k, v) {
        el.attrs.set(k, v);
      },
      removeAttribute(k) {
        el.attrs.delete(k);
      },
      getAttribute(k) {
        return el.attrs.get(k) ?? null;
      },
      hasAttribute(k) {
        return el.attrs.has(k);
      },
      appendChild(c) {
        el.children.push(c);
        c.parent = el;
        return c;
      },
      removeChild(c) {
        const i = el.children.indexOf(c);
        if (i < 0) throw new Error('removeChild: not a child');
        el.children.splice(i, 1);
        c.parent = null;
        return c;
      },
      addEventListener(type, listener) {
        const listeners = el.listeners.get(type) ?? new Set<FakeListener>();
        listeners.add(listener);
        el.listeners.set(type, listeners);
      },
      click() {
        const event = makeEvent('click', el);
        for (const listener of [...(el.listeners.get('click') ?? [])]) {
          listener(event);
        }
      },
      focus() {
        active = el;
      },
      contains(node) {
        if (node === el) return true;
        return el.children.some((child) => child.contains(node));
      },
    };
    return el;
  };

  const makeEvent = (
    type: string,
    target: FakeEl | null,
    key?: string,
  ): FakeEvent => ({
    type,
    target,
    ...(key !== undefined ? { key } : {}),
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  });

  const doc = {
    get activeElement() {
      return active;
    },
    createElement: makeEl,
    addEventListener(type: string, listener: FakeListener) {
      const listeners =
        documentListeners.get(type) ?? new Set<FakeListener>();
      listeners.add(listener);
      documentListeners.set(type, listeners);
    },
    removeEventListener(type: string, listener: FakeListener) {
      documentListeners.get(type)?.delete(listener);
    },
    defaultView: {
      addEventListener(type: string, listener: FakeListener) {
        const listeners = pageListeners.get(type) ?? new Set<FakeListener>();
        listeners.add(listener);
        pageListeners.set(type, listeners);
      },
      removeEventListener(type: string, listener: FakeListener) {
        pageListeners.get(type)?.delete(listener);
      },
    },
  };

  return {
    document: doc as unknown as Document,
    activeElement: () => active,
    create: makeEl,
    fire(type, init) {
      const event = makeEvent(type, init?.target ?? null, init?.key);
      for (const listener of [...(documentListeners.get(type) ?? [])]) {
        listener(event);
      }
      return event;
    },
    firePage(type) {
      const event = makeEvent(type, null);
      for (const listener of [...(pageListeners.get(type) ?? [])]) {
        listener(event);
      }
      return event;
    },
    listenerCount: (type) => documentListeners.get(type)?.size ?? 0,
    pageListenerCount: (type) => pageListeners.get(type)?.size ?? 0,
  };
};

const findByAttr = (root: FakeEl, attr: string): FakeEl | null => {
  if (root.hasAttribute(attr)) return root;
  for (const child of root.children) {
    const hit = findByAttr(child, attr);
    if (hit !== null) return hit;
  }
  return null;
};

const findByClass = (root: FakeEl, className: string): FakeEl | null => {
  if (root.className.split(/\s+/u).includes(className)) return root;
  for (const child of root.children) {
    const hit = findByClass(child, className);
    if (hit !== null) return hit;
  }
  return null;
};

const subtreeText = (root: FakeEl): string =>
  root.textContent + root.children.map(subtreeText).join('');

const buildFakeStatus = (initial: WebclientConnectionStatus) => {
  let current = initial;
  const listeners = new Set<(status: WebclientConnectionStatus) => void>();
  return {
    status: () => current,
    onStatus: (listener: (status: WebclientConnectionStatus) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next: WebclientConnectionStatus) => {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
    listenerCount: () => listeners.size,
  };
};

const setup = (initial: WebclientConnectionStatus = 'connected') => {
  const fake = buildFakeDocument();
  const statusHost = fake.create('span');
  const bannerHost = fake.create('div');
  const status = buildFakeStatus(initial);
  return { fake, statusHost, bannerHost, status };
};

describe('connection recovery surface', () => {
  it('mounts an announcer and no chip — the badge is the visible signal now', () => {
    const fixture = setup();
    const mount = mountConnectionIndicator({
      statusHost: fixture.statusHost as unknown as HTMLElement,
      bannerHost: fixture.bannerHost as unknown as HTMLElement,
      document: fixture.fake.document,
      status: fixture.status.status,
      onStatus: fixture.status.onStatus,
    });

    const indicator = findByAttr(fixture.statusHost, CONNECTION_INDICATOR_ATTR);
    expect(indicator).not.toBeNull();
    const announcer = findByAttr(fixture.statusHost, CONNECTION_STATUS_ANNOUNCER_ATTR);
    expect(announcer).not.toBeNull();
    // Politeness matters: an assertive region would interrupt on every blip.
    expect(announcer!.getAttribute('aria-live')).toBe('polite');
    expect(announcer!.getAttribute('role')).toBe('status');
    // The whole visible topbar footprint is now the announcer, which is
    // visually hidden — nothing renders where the chip used to be.
    expect(indicator!.children).toHaveLength(1);
    mount.dispose();
  });

  it('announces the transitions the badge stays silent for', () => {
    // `reconnecting` / `stalled` self-heal, so the badge deliberately does not
    // light up for them. Without this region those states would be entirely
    // unobservable to a screen reader.
    const fixture = setup('connected');
    const mount = mountConnectionIndicator({
      statusHost: fixture.statusHost as unknown as HTMLElement,
      bannerHost: fixture.bannerHost as unknown as HTMLElement,
      document: fixture.fake.document,
      status: fixture.status.status,
      onStatus: fixture.status.onStatus,
    });
    const announcer = findByAttr(fixture.statusHost, CONNECTION_STATUS_ANNOUNCER_ATTR)!;

    fixture.status.set('reconnecting');
    expect(announcer.textContent).toContain('reconnecting');
    fixture.status.set('stalled');
    expect(announcer.textContent).toContain('not responding');
    fixture.status.set('connected');
    expect(announcer.textContent).toBe('');
    mount.dispose();
  });

  it('raises the offline banner and hands off to the caller\'s recovery action', () => {
    const fixture = setup('connected');
    const onRecoveryAction = vi.fn();
    const mount = mountConnectionIndicator({
      statusHost: fixture.statusHost as unknown as HTMLElement,
      bannerHost: fixture.bannerHost as unknown as HTMLElement,
      document: fixture.fake.document,
      status: fixture.status.status,
      onStatus: fixture.status.onStatus,
      onRecoveryAction,
    });

    const banner = findByAttr(fixture.bannerHost, CONNECTION_BANNER_ATTR)!;
    expect(banner.getAttribute('data-state')).toBe('ok');

    fixture.status.set('offline');
    expect(banner.getAttribute('data-state')).toBe('offline');
    // Assertive here, unlike the announcer: an outage is not a blip.
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.getAttribute('aria-live')).toBe('assertive');

    const action = findByAttr(fixture.bannerHost, CONNECTION_BANNER_ACTION_ATTR)!;
    expect(action.hasAttribute('hidden')).toBe(false);
    expect(action.textContent).toBe('Review server profiles');
    expect(subtreeText(banner)).toContain(
      'Can’t reach the current server. Recued will keep trying.',
    );
    action.click();
    // The banner no longer owns a panel — it points at the account menu, so
    // the alert and the remedy stay one gesture apart.
    expect(onRecoveryAction).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('moves focus to stable shell chrome when recovery retires its action', () => {
    const fixture = setup('connected');
    const fallback = fixture.fake.create('button');
    const mount = mountConnectionIndicator({
      statusHost: fixture.statusHost as unknown as HTMLElement,
      bannerHost: fixture.bannerHost as unknown as HTMLElement,
      document: fixture.fake.document,
      status: fixture.status.status,
      onStatus: fixture.status.onStatus,
      onRecoveryAction: vi.fn(),
      focusAfterActionRetires: () => fallback as unknown as HTMLElement,
    });
    const action = findByAttr(
      fixture.bannerHost,
      CONNECTION_BANNER_ACTION_ATTR,
    )!;

    fixture.status.set('offline');
    action.focus();
    expect(fixture.fake.activeElement()).toBe(action);

    fixture.status.set('connected');

    expect(action.hasAttribute('hidden')).toBe(true);
    expect(fixture.fake.activeElement()).toBe(fallback);
    mount.dispose();
  });

  it('offers one resume action on the first-connected receipt, then retires it', () => {
    const fixture = setup('connected');
    const onSelect = vi.fn();
    const clearTimer = vi.fn();
    const mount = mountConnectionIndicator({
      statusHost: fixture.statusHost as unknown as HTMLElement,
      bannerHost: fixture.bannerHost as unknown as HTMLElement,
      document: fixture.fake.document,
      status: fixture.status.status,
      onStatus: fixture.status.onStatus,
      receiptOnFirstConnected: true,
      firstConnectedReceiptCopy:
        'Back on home. Data · Files is ready where you left it.',
      firstConnectedReceiptAction: {
        label: 'Resume Data · Files',
        onSelect,
      },
      setTimer: () => 'receipt-timer',
      clearTimer,
    });

    const banner = findByAttr(fixture.bannerHost, CONNECTION_BANNER_ATTR)!;
    const action = findByAttr(
      fixture.bannerHost,
      CONNECTION_BANNER_ACTION_ATTR,
    )!;
    expect(banner.getAttribute('data-state')).toBe('restored');
    expect(subtreeText(banner)).toContain('Data · Files is ready');
    expect(action.hasAttribute('hidden')).toBe(false);
    expect(action.textContent).toBe('Resume Data · Files');

    action.click();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(clearTimer).toHaveBeenCalledWith('receipt-timer');
    expect(banner.getAttribute('data-state')).toBe('ok');
    expect(action.hasAttribute('hidden')).toBe(true);
    action.click();
    expect(onSelect).toHaveBeenCalledOnce();

    fixture.status.set('offline');
    fixture.status.set('connected');
    expect(banner.getAttribute('data-state')).toBe('restored');
    expect(subtreeText(banner)).toContain('Back online');
    expect(action.hasAttribute('hidden')).toBe(true);
    mount.dispose();
  });

  it('retires a pending resume receipt before browser-history restoration', () => {
    const fixture = setup('connected');
    const onSelect = vi.fn();
    const mount = mountConnectionIndicator({
      statusHost: fixture.statusHost as unknown as HTMLElement,
      bannerHost: fixture.bannerHost as unknown as HTMLElement,
      document: fixture.fake.document,
      status: fixture.status.status,
      onStatus: fixture.status.onStatus,
      receiptOnFirstConnected: true,
      firstConnectedReceiptAction: {
        label: 'Resume Chat',
        onSelect,
      },
      setTimer: () => 'receipt-timer',
      clearTimer: vi.fn(),
    });
    const banner = findByAttr(fixture.bannerHost, CONNECTION_BANNER_ATTR)!;
    const action = findByAttr(
      fixture.bannerHost,
      CONNECTION_BANNER_ACTION_ATTR,
    )!;

    fixture.fake.firePage('pagehide');
    expect(banner.getAttribute('data-state')).toBe('ok');
    expect(action.hasAttribute('hidden')).toBe(true);
    action.click();
    expect(onSelect).not.toHaveBeenCalled();

    mount.dispose();
    expect(fixture.fake.pageListenerCount('pagehide')).toBe(0);
  });

  it('retires the resume action with its receipt timer', () => {
    const fixture = setup('connected');
    const onSelect = vi.fn();
    let expireReceipt = (): void => {
      throw new Error('receipt timer was not armed');
    };
    const mount = mountConnectionIndicator({
      statusHost: fixture.statusHost as unknown as HTMLElement,
      bannerHost: fixture.bannerHost as unknown as HTMLElement,
      document: fixture.fake.document,
      status: fixture.status.status,
      onStatus: fixture.status.onStatus,
      receiptOnFirstConnected: true,
      firstConnectedReceiptAction: {
        label: 'Resume Runs',
        onSelect,
      },
      setTimer: (handler) => {
        expireReceipt = handler;
        return 'receipt-timer';
      },
      clearTimer: vi.fn(),
    });
    const banner = findByAttr(fixture.bannerHost, CONNECTION_BANNER_ATTR)!;
    const action = findByAttr(
      fixture.bannerHost,
      CONNECTION_BANNER_ACTION_ATTR,
    )!;

    expireReceipt();
    expect(banner.getAttribute('data-state')).toBe('ok');
    expect(action.hasAttribute('hidden')).toBe(true);
    action.click();
    expect(onSelect).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('shows a reconciled attention receipt with one review action', () => {
    const fixture = setup('connected');
    const onSelect = vi.fn();
    const mount = mountConnectionIndicator({
      statusHost: fixture.statusHost as unknown as HTMLElement,
      bannerHost: fixture.bannerHost as unknown as HTMLElement,
      document: fixture.fake.document,
      status: fixture.status.status,
      onStatus: fixture.status.onStatus,
      restoredReceiptMs: 0,
    });
    const banner = findByAttr(fixture.bannerHost, CONNECTION_BANNER_ATTR)!;
    const action = findByAttr(
      fixture.bannerHost,
      CONNECTION_BANNER_ACTION_ATTR,
    )!;

    expect(mount.showConnectedReceipt({
      copy: 'Data · Files changed while you were away.',
      tone: 'attention',
      action: { label: 'Review Data · Files', onSelect },
    })).toBe(true);
    expect(banner.getAttribute('data-state')).toBe('attention');
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('aria-live')).toBe('polite');
    expect(subtreeText(banner)).toContain('changed while you were away');
    expect(action.textContent).toBe('Review Data · Files');

    action.click();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(banner.getAttribute('data-state')).toBe('ok');
    action.click();
    expect(onSelect).toHaveBeenCalledOnce();
    mount.dispose();
  });

  it('queues a reconciled receipt until connected and retires it on pagehide', () => {
    const fixture = setup('connecting');
    const onSelect = vi.fn();
    const mount = mountConnectionIndicator({
      statusHost: fixture.statusHost as unknown as HTMLElement,
      bannerHost: fixture.bannerHost as unknown as HTMLElement,
      document: fixture.fake.document,
      status: fixture.status.status,
      onStatus: fixture.status.onStatus,
      restoredReceiptMs: 0,
    });
    const banner = findByAttr(fixture.bannerHost, CONNECTION_BANNER_ATTR)!;
    const action = findByAttr(
      fixture.bannerHost,
      CONNECTION_BANNER_ACTION_ATTR,
    )!;

    expect(mount.showConnectedReceipt({
      copy: 'Contracts is refreshed and ready.',
      action: { label: 'Continue in Contracts', onSelect },
      afterReconnect: {
        copy: 'Now connected. Review Contracts before continuing.',
        tone: 'attention',
        action: { label: 'Review Contracts', onSelect },
      },
    })).toBe(true);
    expect(banner.getAttribute('data-state')).toBe('ok');
    fixture.status.set('connected');
    expect(banner.getAttribute('data-state')).toBe('attention');
    expect(subtreeText(banner)).toContain(
      'Now connected. Review Contracts before continuing.',
    );
    expect(subtreeText(banner)).not.toContain('refreshed and ready');

    fixture.fake.firePage('pagehide');
    expect(banner.getAttribute('data-state')).toBe('ok');
    expect(action.hasAttribute('hidden')).toBe(true);
    fixture.status.set('offline');
    fixture.status.set('connected');
    expect(subtreeText(banner)).toContain('Back online');
    expect(subtreeText(banner)).not.toContain('Review Contracts before');
    action.click();
    expect(onSelect).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('declines to queue freshness-qualified copy without a reconnect fallback', () => {
    const fixture = setup('connecting');
    const mount = mountConnectionIndicator({
      statusHost: fixture.statusHost as unknown as HTMLElement,
      bannerHost: fixture.bannerHost as unknown as HTMLElement,
      document: fixture.fake.document,
      status: fixture.status.status,
      onStatus: fixture.status.onStatus,
    });
    const banner = findByAttr(fixture.bannerHost, CONNECTION_BANNER_ATTR)!;

    expect(mount.showConnectedReceipt({
      copy: 'This context was fresh before the connection gap.',
    })).toBe(false);
    fixture.status.set('connected');
    expect(banner.getAttribute('data-state')).toBe('ok');
    expect(subtreeText(banner)).not.toContain('context was fresh');
    mount.dispose();
  });

  it('does not resurrect a late reconciled receipt after pagehide', () => {
    const fixture = setup('connected');
    const mount = mountConnectionIndicator({
      statusHost: fixture.statusHost as unknown as HTMLElement,
      bannerHost: fixture.bannerHost as unknown as HTMLElement,
      document: fixture.fake.document,
      status: fixture.status.status,
      onStatus: fixture.status.onStatus,
    });
    const banner = findByAttr(fixture.bannerHost, CONNECTION_BANNER_ATTR)!;

    fixture.fake.firePage('pagehide');
    expect(mount.showConnectedReceipt({
      copy: 'This late route read must stay retired.',
    })).toBe(false);
    expect(banner.getAttribute('data-state')).toBe('ok');
    expect(subtreeText(banner)).not.toContain('late route read');
    mount.dispose();
  });

  it('stays quiet through reconnecting and stalled — no banner for a blip', () => {
    const fixture = setup('connected');
    const mount = mountConnectionIndicator({
      statusHost: fixture.statusHost as unknown as HTMLElement,
      bannerHost: fixture.bannerHost as unknown as HTMLElement,
      document: fixture.fake.document,
      status: fixture.status.status,
      onStatus: fixture.status.onStatus,
    });
    const banner = findByAttr(fixture.bannerHost, CONNECTION_BANNER_ATTR)!;

    fixture.status.set('reconnecting');
    expect(banner.getAttribute('data-state')).toBe('ok');
    fixture.status.set('stalled');
    expect(banner.getAttribute('data-state')).toBe('ok');
    fixture.status.set('offline');
    expect(findByAttr(
      fixture.bannerHost,
      CONNECTION_BANNER_ACTION_ATTR,
    )!.hasAttribute('hidden')).toBe(true);
    mount.dispose();
  });
});
