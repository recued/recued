/** Connection indicator (topbar chip + offline banner) acceptance.
 *
 *  Drives `mountConnectionIndicator` over a createElement fake DOM (the
 *  node-env discipline the webclient uses — no jsdom) + a controllable
 *  status seam. Pins: the chip's `data-state` / aria-label / label text
 *  per status, the offline-only banner gate, live updates on a status
 *  transition, and dispose teardown (nodes removed + subscription
 *  dropped). */

import { describe, expect, it } from 'vitest';

import {
  CONNECTION_CHIP_ATTR,
  CONNECTION_BANNER_ATTR,
  mountConnectionIndicator,
} from '../shell/connection-indicator.js';
import type { WebclientConnectionStatus } from '../realtime/connection-status.js';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (createElement nodes, no innerHTML / no jsdom)
// ──────────────────────────────────────────────────────────────────

interface FakeEl {
  tagName: string;
  textContent: string;
  className: string;
  children: FakeEl[];
  parent: FakeEl | null;
  attrs: Map<string, string>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
}

const makeEl = (tagName: string): FakeEl => {
  const el: FakeEl = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    className: '',
    children: [],
    parent: null,
    attrs: new Map(),
    setAttribute(k, v) {
      el.attrs.set(k, v);
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
  };
  return el;
};

const fakeDoc = () => ({ createElement: makeEl }) as unknown as Document;

const findByAttr = (root: FakeEl, attr: string): FakeEl | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit) return hit;
  }
  return null;
};

const labelTextOf = (chip: FakeEl): string =>
  chip.children.map((c) => c.textContent).join('');

const buildFakeStatus = (initial: WebclientConnectionStatus) => {
  let cur = initial;
  const listeners = new Set<(s: WebclientConnectionStatus) => void>();
  return {
    status: () => cur,
    onStatus: (l: (s: WebclientConnectionStatus) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    set: (next: WebclientConnectionStatus) => {
      cur = next;
      for (const l of [...listeners]) l(next);
    },
    listenerCount: () => listeners.size,
  };
};

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('connection indicator', () => {
  it('mounts a chip into the chip host + a banner into the banner host', () => {
    const chipHost = makeEl('span');
    const bannerHost = makeEl('div');
    const status = buildFakeStatus('connected');
    const mount = mountConnectionIndicator({
      chipHost: chipHost as unknown as HTMLElement,
      bannerHost: bannerHost as unknown as HTMLElement,
      document: fakeDoc(),
      status: status.status,
      onStatus: status.onStatus,
    });
    expect(findByAttr(chipHost, CONNECTION_CHIP_ATTR)).not.toBeNull();
    expect(findByAttr(bannerHost, CONNECTION_BANNER_ATTR)).not.toBeNull();
    mount.dispose();
  });

  it('renders connected as a bare dot (no label text) with a non-offline banner', () => {
    const chipHost = makeEl('span');
    const bannerHost = makeEl('div');
    const status = buildFakeStatus('connected');
    const mount = mountConnectionIndicator({
      chipHost: chipHost as unknown as HTMLElement,
      bannerHost: bannerHost as unknown as HTMLElement,
      document: fakeDoc(),
      status: status.status,
      onStatus: status.onStatus,
    });
    const chip = findByAttr(chipHost, CONNECTION_CHIP_ATTR)!;
    const banner = findByAttr(bannerHost, CONNECTION_BANNER_ATTR)!;
    expect(chip.getAttribute('data-state')).toBe('connected');
    expect(labelTextOf(chip)).toBe(''); // quiet happy path
    expect(chip.getAttribute('aria-label')).toContain('Connected');
    expect(banner.getAttribute('data-state')).toBe('ok'); // hidden
    mount.dispose();
  });

  it('shows the offline banner + an Offline chip when offline', () => {
    const chipHost = makeEl('span');
    const bannerHost = makeEl('div');
    const status = buildFakeStatus('offline');
    const mount = mountConnectionIndicator({
      chipHost: chipHost as unknown as HTMLElement,
      bannerHost: bannerHost as unknown as HTMLElement,
      document: fakeDoc(),
      status: status.status,
      onStatus: status.onStatus,
    });
    const chip = findByAttr(chipHost, CONNECTION_CHIP_ATTR)!;
    const banner = findByAttr(bannerHost, CONNECTION_BANNER_ATTR)!;
    expect(chip.getAttribute('data-state')).toBe('offline');
    expect(labelTextOf(chip)).toBe('Offline');
    expect(banner.getAttribute('data-state')).toBe('offline'); // shown
    mount.dispose();
  });

  it('renders stalled as the calm Reconnecting chip with NO banner', () => {
    const chipHost = makeEl('span');
    const bannerHost = makeEl('div');
    const status = buildFakeStatus('stalled');
    const mount = mountConnectionIndicator({
      chipHost: chipHost as unknown as HTMLElement,
      bannerHost: bannerHost as unknown as HTMLElement,
      document: fakeDoc(),
      status: status.status,
      onStatus: status.onStatus,
    });
    const chip = findByAttr(chipHost, CONNECTION_CHIP_ATTR)!;
    const banner = findByAttr(bannerHost, CONNECTION_BANNER_ATTR)!;
    // A half-open server is presented exactly like reconnecting — calm, and
    // crucially NO red offline banner (it auto-recovers; nothing to act on).
    expect(chip.getAttribute('data-state')).toBe('stalled');
    expect(labelTextOf(chip)).toBe('Reconnecting…');
    expect(chip.getAttribute('aria-label')).toContain('Reconnecting');
    expect(banner.getAttribute('data-state')).toBe('ok'); // hidden
    mount.dispose();
  });

  it('updates both surfaces live on a status transition', () => {
    const chipHost = makeEl('span');
    const bannerHost = makeEl('div');
    const status = buildFakeStatus('connected');
    const mount = mountConnectionIndicator({
      chipHost: chipHost as unknown as HTMLElement,
      bannerHost: bannerHost as unknown as HTMLElement,
      document: fakeDoc(),
      status: status.status,
      onStatus: status.onStatus,
    });
    const chip = findByAttr(chipHost, CONNECTION_CHIP_ATTR)!;
    const banner = findByAttr(bannerHost, CONNECTION_BANNER_ATTR)!;

    status.set('reconnecting');
    expect(chip.getAttribute('data-state')).toBe('reconnecting');
    expect(labelTextOf(chip)).toBe('Reconnecting…');
    expect(banner.getAttribute('data-state')).toBe('ok'); // blip ≠ banner

    status.set('offline');
    expect(chip.getAttribute('data-state')).toBe('offline');
    expect(banner.getAttribute('data-state')).toBe('offline');

    status.set('connected');
    expect(chip.getAttribute('data-state')).toBe('connected');
    expect(banner.getAttribute('data-state')).toBe('ok');
    mount.dispose();
  });

  it('dispose removes both nodes + drops the status subscription', () => {
    const chipHost = makeEl('span');
    const bannerHost = makeEl('div');
    const status = buildFakeStatus('connected');
    const mount = mountConnectionIndicator({
      chipHost: chipHost as unknown as HTMLElement,
      bannerHost: bannerHost as unknown as HTMLElement,
      document: fakeDoc(),
      status: status.status,
      onStatus: status.onStatus,
    });
    expect(status.listenerCount()).toBe(1);
    expect(chipHost.children.length).toBe(1);
    expect(bannerHost.children.length).toBe(1);

    mount.dispose();
    expect(status.listenerCount()).toBe(0);
    expect(chipHost.children.length).toBe(0);
    expect(bannerHost.children.length).toBe(0);
    // Idempotent + post-dispose status changes are inert.
    expect(() => mount.dispose()).not.toThrow();
    expect(() => status.set('offline')).not.toThrow();
  });
});
