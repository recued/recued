/** D-169 P2 Slice 5 (toast half) — notify toast overlay acceptance.
 *
 *  Drives `mountNotifyToasts` through a fake Document + a fake broadcast
 *  subscriber (captures the `notification.notify` listener) + a controllable
 *  timer seam (so auto-dismiss fires deterministically without a clock).
 *
 *  Covers Codex adversarial-review's "next steps": malformed frames, manual
 *  dismiss, eviction timer cleanup, fired-auto-dismiss-after-dispose, dispose
 *  idempotency — plus push / stacking / one-way render / a11y. */

import { describe, expect, it, vi } from 'vitest';

import type {
  BroadcastEventKind,
  ServerEvent,
} from '@recued/contracts';

import {
  type BroadcastListener,
  type BroadcastSubscriber,
} from '../realtime/subscriber.js';
import {
  NOTIFY_TOASTS_HOST_ATTR,
  NOTIFY_TOAST_ATTR,
  NOTIFY_TOAST_DISMISS_ATTR,
  NOTIFY_TOASTS_STYLES,
  mountNotifyToasts,
  type MountNotifyToastsOptions,
} from '../notify-toasts.js';

// ──────────────────────────────────────────────────────────────────
// Fake DOM
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  type: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  insertBefore(el: FakeElement, reference: FakeElement | null): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  closest(selector: string): FakeElement | null;
  contains(candidate: FakeElement): boolean;
  focus?: () => void;
  click(): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    className: '',
    type: '',
    children: [],
    parent: null,
    attrs: new Map(),
    listeners: new Map(),
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(child) {
      el.children.push(child);
      child.parent = el;
      return child;
    },
    insertBefore(child, reference) {
      if (child.parent !== null) child.parent.removeChild(child);
      if (reference === null) return el.appendChild(child);
      const idx = el.children.indexOf(reference);
      if (idx < 0) throw new Error('insertBefore: reference is not a child');
      el.children.splice(idx, 0, child);
      child.parent = el;
      return child;
    },
    removeChild(child) {
      const idx = el.children.indexOf(child);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      child.parent = null;
      return child;
    },
    get firstChild() {
      return el.children[0] ?? null;
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener(name, fn) {
      const arr = el.listeners.get(name) ?? [];
      arr.push(fn);
      el.listeners.set(name, arr);
    },
    closest(selector) {
      const attr = selector.match(/^\[([^\]]+)\]$/)?.[1];
      if (attr === undefined) return null;
      let candidate: FakeElement | null = el;
      while (candidate !== null) {
        if (candidate.hasAttribute(attr)) return candidate;
        candidate = candidate.parent;
      }
      return null;
    },
    contains(candidate) {
      if (candidate === el) return true;
      return el.children.some((child) => child.contains(candidate));
    },
    click() {
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
  };
  return el;
};

interface FakeDocument {
  activeElement: FakeElement | null;
  createElement(tagName: string): FakeElement;
}

const makeFakeDocument = (): FakeDocument => {
  const document: FakeDocument = {
    activeElement: null,
    createElement(tagName) {
      const element = makeFakeElement(tagName);
      element.focus = () => { document.activeElement = element; };
      return element;
    },
  };
  return document;
};

const textOf = (el: FakeElement): string =>
  `${el.textContent}${el.children.map(textOf).join('')}`;

const findAllByAttr = (
  root: FakeElement,
  attr: string,
  value?: string,
  out: FakeElement[] = [],
): FakeElement[] => {
  if (
    root.hasAttribute(attr)
    && (value === undefined || root.getAttribute(attr) === value)
  ) {
    out.push(root);
  }
  for (const child of root.children) findAllByAttr(child, attr, value, out);
  return out;
};

const findContainer = (host: FakeElement): FakeElement =>
  findAllByAttr(host, NOTIFY_TOASTS_HOST_ATTR)[0]!;

// ──────────────────────────────────────────────────────────────────
// Fake broadcast subscriber
// ──────────────────────────────────────────────────────────────────

type NotifyEvent = Extract<ServerEvent, { kind: 'notification.notify' }>;

interface CapturedSubscription {
  kind: BroadcastEventKind;
  listener: (event: NotifyEvent) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
}

const makeFakeSubscribe = (): {
  subscribe: BroadcastSubscriber['on'];
  calls: CapturedSubscription[];
} => {
  const calls: CapturedSubscription[] = [];
  const subscribe = (<K extends BroadcastEventKind>(
    kind: K,
    listener: BroadcastListener<K>,
  ) => {
    const unsubscribe = vi.fn();
    calls.push({
      kind,
      listener: listener as unknown as (event: NotifyEvent) => void,
      unsubscribe,
    });
    return unsubscribe;
  }) as BroadcastSubscriber['on'];
  return { subscribe, calls };
};

const notifyListener = (
  fake: ReturnType<typeof makeFakeSubscribe>,
): ((event: NotifyEvent) => void) => {
  const call = fake.calls.find((c) => c.kind === 'notification.notify');
  if (!call) throw new Error('missing notification.notify listener');
  return call.listener;
};

const notifyEvent = (text: string, title?: string): NotifyEvent => ({
  kind: 'notification.notify',
  ...(title !== undefined ? { title } : {}),
  text,
  cursor: 1,
});

// ──────────────────────────────────────────────────────────────────
// Controllable timer seam
// ──────────────────────────────────────────────────────────────────

const makeFakeTimers = () => {
  let seq = 0;
  const scheduled = new Map<number, () => void>();
  const cleared: number[] = [];
  return {
    setTimer: (fn: () => void): unknown => {
      const handle = (seq += 1);
      scheduled.set(handle, fn);
      return handle;
    },
    clearTimer: (handle: unknown): void => {
      cleared.push(handle as number);
      scheduled.delete(handle as number);
    },
    /** Fire (and remove) the scheduled callback for a handle. */
    fire: (handle: number): void => {
      const fn = scheduled.get(handle);
      if (fn) {
        scheduled.delete(handle);
        fn();
      }
    },
    scheduledCount: (): number => scheduled.size,
    clearedCount: (): number => cleared.length,
    /** Handles still pending, in scheduling order. */
    pending: (): number[] => [...scheduled.keys()],
  };
};

const mount = (
  overrides: Partial<MountNotifyToastsOptions> = {},
): {
  host: FakeElement;
  timers: ReturnType<typeof makeFakeTimers>;
  fake: ReturnType<typeof makeFakeSubscribe>;
  toasts: ReturnType<typeof mountNotifyToasts>;
} => {
  const host = makeFakeElement('div');
  const timers = makeFakeTimers();
  const fake = makeFakeSubscribe();
  const toasts = mountNotifyToasts({
    host: host as unknown as HTMLElement,
    document: makeFakeDocument() as unknown as Document,
    subscribe: fake.subscribe,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  return { host, timers, fake, toasts };
};

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('D-169 P2 Slice 5 notify toasts', () => {
  it.each([
    // D-291 — the canonical saved-view address.
    ['#views/view_00000000-0000-4000-8000-000000000001', true],
    // ⚠ AND THE PRE-D-291 FORM, which notifications already delivered carry.
    // Dropping it from the allowlist does not break the link (the parser still
    // re-points it) — it stops the toast rendering a link AT ALL, silently.
    ['#data/view/view_00000000-0000-4000-8000-000000000001', true],
    ['https://recued.example/#data/view/view_00000000-0000-4000-8000-000000000001', true],
    // ⛔ Neither spelling may be loosened into a general hash allowance.
    ['#views/../settings', false],
    ['#views/not-a-view-id', false],
    ['javascript:alert(1)', false],
    ['data:text/html,hello', false],
    ['//untrusted.example', false],
  ])('renders only safe notification links: %s', (link_url, allowed) => {
    const h = mount();
    notifyListener(h.fake)({ ...notifyEvent('A task now matches.'), link_url });
    expect(findAllByAttr(h.host, 'href')).toHaveLength(allowed ? 1 : 0);
    if (allowed) expect(findAllByAttr(h.host, 'href')[0]?.getAttribute('href')).toBe(link_url);
    h.toasts.dispose();
  });
  it('keeps the dismiss action full-sized with an explicit focus ring', () => {
    expect(NOTIFY_TOASTS_STYLES).toMatch(
      /\.notify-toast-dismiss\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/s,
    );
    expect(NOTIFY_TOASTS_STYLES).toMatch(
      /\.notify-toast-dismiss:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\);/s,
    );
    expect(NOTIFY_TOASTS_STYLES).toMatch(
      /@media \(max-width: 520px\)[\s\S]*?\.notify-toast-dismiss\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/s,
    );
    expect(NOTIFY_TOASTS_STYLES).toContain(
      'width: min(320px, calc(100vw - 32px));',
    );
    expect(NOTIFY_TOASTS_STYLES).toMatch(
      /\.notify-toast-title\s*\{[^}]*overflow-wrap:\s*anywhere;/s,
    );
  });

  it('subscribes to notification.notify and renders a one-way toast on a frame', () => {
    const { host, fake, toasts } = mount();
    expect(fake.calls.filter((c) => c.kind === 'notification.notify')).toHaveLength(1);

    notifyListener(fake)(notifyEvent('Sync complete', 'Storage ready'));

    expect(toasts.getToasts()).toEqual([
      { id: 'toast-1', title: 'Storage ready', text: 'Sync complete' },
    ]);
    const rendered = findAllByAttr(host, NOTIFY_TOAST_ATTR);
    expect(rendered).toHaveLength(1);
    expect(textOf(rendered[0]!)).toContain('Storage ready');
    expect(textOf(rendered[0]!)).toContain('Sync complete');
    // A dismiss control exists; the toast is one-way (no option buttons).
    const dismissBtns = findAllByAttr(host, NOTIFY_TOAST_DISMISS_ATTR);
    expect(dismissBtns).toHaveLength(1);
    expect(dismissBtns[0]!.tagName).toBe('BUTTON');
    expect(dismissBtns[0]!.getAttribute('aria-label')).toBe(
      'Dismiss notification: Storage ready — Sync complete',
    );
  });

  it('accepts a durable owner status through push without a notify frame', () => {
    const { host, fake, toasts } = mount();

    toasts.push({
      title: 'What you allowed was sent',
      text: 'The export was handed off.',
    });

    expect(fake.calls.filter((c) => c.kind === 'notification.notify')).toHaveLength(1);
    expect(toasts.getToasts()).toEqual([{
      id: 'toast-1',
      title: 'What you allowed was sent',
      text: 'The export was handed off.',
    }]);
    expect(textOf(findAllByAttr(host, NOTIFY_TOAST_ATTR)[0]!))
      .toContain('The export was handed off.');
  });

  it('keeps a sticky status until it is dismissed, beside one that still expires', () => {
    const { timers, toasts } = mount();

    toasts.push({ title: 'Webhook off: Camera alert', text: 'Its deliveries are refused.', sticky: true });
    expect(timers.scheduledCount()).toBe(0);
    toasts.push({ title: 'What you allowed was sent', text: 'The export was handed off.' });
    expect(timers.scheduledCount()).toBe(1);

    timers.fire(timers.pending()[0]!);
    expect(toasts.getToasts().map((t) => t.title)).toEqual(['Webhook off: Camera alert']);
    toasts.dismiss(toasts.getToasts()[0]!.id);
    expect(toasts.getToasts()).toEqual([]);
  });

  it('renders an untitled frame as text-only (no title element)', () => {
    const { host, fake } = mount();
    notifyListener(fake)(notifyEvent('Just a body'));
    const row = findAllByAttr(host, NOTIFY_TOAST_ATTR)[0]!;
    expect(textOf(row)).toContain('Just a body');
    // No title means the toast carries exactly the text line + dismiss —
    // no `.notify-toast-title` element is rendered.
    const titleEls = row.children
      .flatMap((c) => c.children)
      .filter((c) => c.className.includes('notify-toast-title'));
    expect(titleEls).toHaveLength(0);
  });

  it('a11y: container is an aria-live polite status region', () => {
    const { host } = mount();
    const container = findContainer(host);
    expect(container.getAttribute('role')).toBe('status');
    expect(container.getAttribute('aria-live')).toBe('polite');
    expect(container.getAttribute('aria-atomic')).toBe('false');
  });

  it('stacks newest-on-top', () => {
    const { host, fake } = mount();
    notifyListener(fake)(notifyEvent('first'));
    notifyListener(fake)(notifyEvent('second'));
    const rows = findAllByAttr(host, NOTIFY_TOAST_ATTR);
    expect(rows.map((r) => r.getAttribute(NOTIFY_TOAST_ATTR))).toEqual([
      'toast-2',
      'toast-1',
    ]);
  });

  it('retains an existing toast node when a newer notification arrives', () => {
    const { host, fake } = mount();
    notifyListener(fake)(notifyEvent('first'));
    const first = findAllByAttr(host, NOTIFY_TOAST_ATTR, 'toast-1')[0]!;

    notifyListener(fake)(notifyEvent('second'));

    expect(findAllByAttr(host, NOTIFY_TOAST_ATTR, 'toast-1')[0]).toBe(first);
  });

  it('auto-dismisses when the timer fires', () => {
    const { fake, timers, toasts } = mount();
    notifyListener(fake)(notifyEvent('disappearing'));
    expect(toasts.getToasts()).toHaveLength(1);
    expect(timers.scheduledCount()).toBe(1);

    timers.fire(timers.pending()[0]!);

    expect(toasts.getToasts()).toHaveLength(0);
  });

  it('defers auto-dismiss while its action owns focus, then expires normally', () => {
    const document = makeFakeDocument();
    const { host, fake, timers, toasts } = mount({
      document: document as unknown as Document,
    });
    notifyListener(fake)(notifyEvent('read this'));
    document.activeElement = findAllByAttr(
      host,
      NOTIFY_TOAST_DISMISS_ATTR,
      'toast-1',
    )[0]!;

    timers.fire(timers.pending()[0]!);

    expect(toasts.getToasts()).toHaveLength(1);
    expect(timers.scheduledCount()).toBe(1);
    document.activeElement = null;
    timers.fire(timers.pending()[0]!);
    expect(toasts.getToasts()).toHaveLength(0);
  });

  it('manual dismiss removes the toast AND cancels its timer', () => {
    const { host, fake, timers, toasts } = mount();
    notifyListener(fake)(notifyEvent('dismiss me'));
    expect(timers.scheduledCount()).toBe(1);

    const dismissBtn = findAllByAttr(host, NOTIFY_TOAST_DISMISS_ATTR)[0]!;
    dismissBtn.click();

    expect(toasts.getToasts()).toHaveLength(0);
    // The pending auto-dismiss timer for that toast was cleared (no leak).
    expect(timers.scheduledCount()).toBe(0);
    expect(timers.clearedCount()).toBe(1);
  });

  it('manual dismiss advances focused ownership to the next visible toast', () => {
    const document = makeFakeDocument();
    const { host, fake, toasts } = mount({
      document: document as unknown as Document,
      durationMs: 0,
    });
    notifyListener(fake)(notifyEvent('older'));
    notifyListener(fake)(notifyEvent('newer'));
    const newerDismiss = findAllByAttr(
      host,
      NOTIFY_TOAST_DISMISS_ATTR,
      'toast-2',
    )[0]!;
    // `focus` is optional on FakeElement but the fake document wires it on every
    // element it creates. Asserted rather than `?.()`-ed: this test is ABOUT
    // focus ownership, so a silently skipped call would leave it passing while
    // measuring nothing.
    newerDismiss.focus!();
    newerDismiss.click();

    expect(toasts.getToasts().map((toast) => toast.id)).toEqual(['toast-1']);
    expect(document.activeElement?.getAttribute(NOTIFY_TOAST_DISMISS_ATTR))
      .toBe('toast-1');
  });

  it('evicts the oldest toast (and clears its timer) beyond maxVisible', () => {
    const { fake, timers, toasts } = mount({ maxVisible: 2 });
    notifyListener(fake)(notifyEvent('one'));
    notifyListener(fake)(notifyEvent('two'));
    notifyListener(fake)(notifyEvent('three'));

    // Cap is 2 → oldest ('one') evicted; 'two' + 'three' remain.
    expect(toasts.getToasts().map((t) => t.text)).toEqual(['two', 'three']);
    expect(toasts.getToasts()).toHaveLength(2);
    // The evicted toast's timer was cleared so it can't fire later.
    expect(timers.clearedCount()).toBe(1);
    expect(timers.scheduledCount()).toBe(2);
  });

  it('evicts the oldest non-focused toast when a burst reaches the cap', () => {
    const document = makeFakeDocument();
    const { host, fake, toasts } = mount({
      document: document as unknown as Document,
      durationMs: 0,
      maxVisible: 2,
    });
    notifyListener(fake)(notifyEvent('one'));
    notifyListener(fake)(notifyEvent('two'));
    const firstCard = findAllByAttr(host, NOTIFY_TOAST_ATTR, 'toast-1')[0]!;
    document.activeElement = findAllByAttr(
      host,
      NOTIFY_TOAST_DISMISS_ATTR,
      'toast-1',
    )[0]!;

    notifyListener(fake)(notifyEvent('three'));

    expect(toasts.getToasts().map((toast) => toast.id)).toEqual([
      'toast-1',
      'toast-3',
    ]);
    expect(findAllByAttr(host, NOTIFY_TOAST_ATTR).map((card) =>
      card.getAttribute(NOTIFY_TOAST_ATTR))).toEqual(['toast-3', 'toast-1']);
    expect(findAllByAttr(host, NOTIFY_TOAST_ATTR, 'toast-1')[0]).toBe(firstCard);
  });

  it('hands focus to the replacement when a one-toast cap must evict it', () => {
    const document = makeFakeDocument();
    const { host, fake, toasts } = mount({
      document: document as unknown as Document,
      durationMs: 0,
      maxVisible: 1,
    });
    notifyListener(fake)(notifyEvent('one'));
    document.activeElement = findAllByAttr(
      host,
      NOTIFY_TOAST_DISMISS_ATTR,
      'toast-1',
    )[0]!;

    notifyListener(fake)(notifyEvent('two'));

    expect(toasts.getToasts().map((toast) => toast.id)).toEqual(['toast-2']);
    expect(document.activeElement?.getAttribute(NOTIFY_TOAST_DISMISS_ATTR))
      .toBe('toast-2');
  });

  it('does not schedule an auto-dismiss timer when durationMs <= 0', () => {
    const { fake, timers, toasts } = mount({ durationMs: 0 });
    notifyListener(fake)(notifyEvent('sticky'));
    expect(toasts.getToasts()).toHaveLength(1);
    expect(timers.scheduledCount()).toBe(0);
  });

  it('drops a malformed frame (non-string text) without state or timer', () => {
    const { host, fake, timers, toasts } = mount();
    // A version-skewed / malformed frame the runtime subscriber only
    // kind-narrows: non-string text must be dropped, not pushed.
    notifyListener(fake)({
      kind: 'notification.notify',
      text: undefined as unknown as string,
      cursor: 1,
    });
    expect(toasts.getToasts()).toHaveLength(0);
    expect(timers.scheduledCount()).toBe(0);
    expect(findAllByAttr(host, NOTIFY_TOAST_ATTR)).toHaveLength(0);
  });

  it('renders a frame with a non-string title as text-only (no throw)', () => {
    const { host, fake, toasts } = mount();
    expect(() => {
      notifyListener(fake)({
        kind: 'notification.notify',
        title: null as unknown as string,
        text: 'body survives',
        cursor: 1,
      });
    }).not.toThrow();
    expect(toasts.getToasts()).toEqual([{ id: 'toast-1', text: 'body survives' }]);
    const row = findAllByAttr(host, NOTIFY_TOAST_ATTR)[0]!;
    expect(textOf(row)).toContain('body survives');
  });

  it('dispose unsubscribes, clears all timers, removes the container, and is idempotent', () => {
    const { host, fake, timers, toasts } = mount();
    notifyListener(fake)(notifyEvent('a'));
    notifyListener(fake)(notifyEvent('b'));
    expect(timers.scheduledCount()).toBe(2);
    const call = fake.calls.find((c) => c.kind === 'notification.notify')!;

    toasts.dispose();
    toasts.dispose(); // idempotent

    expect(call.unsubscribe).toHaveBeenCalledTimes(1);
    expect(timers.scheduledCount()).toBe(0); // every pending timer cleared
    expect(findAllByAttr(host, NOTIFY_TOASTS_HOST_ATTR)).toHaveLength(0);
    expect(toasts.getToasts()).toHaveLength(0);
  });

  it('a timer firing after dispose is a no-op (no throw, no state change)', () => {
    const { fake, timers, toasts } = mount();
    notifyListener(fake)(notifyEvent('stale'));
    const handle = timers.pending()[0]!;

    toasts.dispose();

    // Simulate a setTimeout callback that had already been queued by the
    // platform before dispose cleared it — the disposed guard must hold.
    expect(() => timers.fire(handle)).not.toThrow();
    expect(toasts.getToasts()).toHaveLength(0);
  });

  it('a late bus frame after dispose is ignored', () => {
    const { fake, toasts } = mount();
    const listener = notifyListener(fake);
    toasts.dispose();
    expect(() => listener(notifyEvent('too late'))).not.toThrow();
    expect(toasts.getToasts()).toHaveLength(0);
  });
});
