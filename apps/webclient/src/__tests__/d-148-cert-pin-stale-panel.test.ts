/** D-148 § A.6.5 — cert-pin overlap panel (slice 113) acceptance.
 *
 *  Drives `mountCertPinStalePanel` through a fake Document — same
 *  pattern as `d-148-tls-renew-panel.test.ts`, simplified because
 *  the panel has no buttons / state machine (informational only).
 *
 *  Covers:
 *   - construction throws when no document is available.
 *   - panel renders empty (no children) when the watcher's state is
 *     `null` (no rotation pending).
 *   - panel renders empty when `next_fingerprint` is undefined.
 *   - panel renders empty when `current_valid_until <= now`
 *     (post-flip — the surface auto-hides).
 *   - panel renders the title + copy + flip time + both fingerprint
 *     short codes during an active overlap window.
 *   - the panel re-renders on watcher transitions.
 *   - dispose unsubscribes + clears the host.
 *   - `getViewState()` returns the projected view (or null when
 *     hidden) for host introspection.
 *   - `buildCertPinStaleView` pure transitions for every gate. */

import { describe, expect, it } from 'vitest';

import {
  CERT_PIN_STALE_COPY,
  CERT_PIN_STALE_CURRENT_FP_ATTR,
  CERT_PIN_STALE_FLIP_AT_ATTR,
  CERT_PIN_STALE_NEXT_FP_ATTR,
  CERT_PIN_STALE_PANEL_ATTR,
  CERT_PIN_STALE_TITLE_ATTR,
  buildCertPinStaleView,
  mountCertPinStalePanel,
} from '../settings/cert-pin-stale-panel.js';
import { createCertPinStateWatcher } from '../realtime/cert-pin-state-watcher.js';
import { createInMemoryWebclientLocalStore } from '../storage/local-store.js';
import type { WebclientCertPinState } from '@recued/contracts';

// ──────────────────────────────────────────────────────────────────
// Fake DOM — same shape as the TLS renew panel test fake.
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  className: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    className: '',
    children,
    parent: null,
    attrs,
    setAttribute: (k, v) => attrs.set(k, v),
    getAttribute: (k) => attrs.get(k) ?? null,
    hasAttribute: (k) => attrs.has(k),
    appendChild: (next) => {
      children.push(next);
      next.parent = el;
      return next;
    },
    removeChild: (target) => {
      const idx = children.indexOf(target);
      if (idx < 0) throw new Error('removeChild: not a child');
      children.splice(idx, 1);
      target.parent = null;
      return target;
    },
    get firstChild() {
      return children[0] ?? null;
    },
    remove: () => {
      if (el.parent !== null) el.parent.removeChild(el);
    },
  };
  return el;
};

interface FakeDocument {
  createElement(tag: string): FakeElement;
}

const makeFakeDocument = (): FakeDocument => ({
  createElement: (tag) => makeFakeElement(tag),
});

const findByAttr = (root: FakeElement, attr: string): FakeElement | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit) return hit;
  }
  return null;
};

const collectText = (root: FakeElement): string => {
  if (root.children.length === 0) return root.textContent;
  return root.children.map(collectText).join('|');
};

// ──────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────

const FIXED_NOW = 1_799_000_000_000;
const FLIP_AT_FUTURE = FIXED_NOW + 3 * 24 * 60 * 60 * 1000; // +3d
const FLIP_AT_PAST = FIXED_NOW - 60_000; // 1m ago

const STATE_ACTIVE: WebclientCertPinState = {
  current_fingerprint:
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  next_fingerprint:
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  current_valid_until: FLIP_AT_FUTURE,
};

const STATE_NO_NEXT: WebclientCertPinState = {
  current_fingerprint: 'aaaaaaaaaaaaaaaa',
  current_valid_until: FLIP_AT_FUTURE,
};

const STATE_POST_FLIP: WebclientCertPinState = {
  ...STATE_ACTIVE,
  current_valid_until: FLIP_AT_PAST,
};

// ──────────────────────────────────────────────────────────────────
// Pure projection
// ──────────────────────────────────────────────────────────────────

describe('D-148 § A.6.5 — buildCertPinStaleView', () => {
  it('returns null for state === null', () => {
    expect(buildCertPinStaleView(null, FIXED_NOW)).toBeNull();
  });

  it('returns null when next_fingerprint is undefined', () => {
    expect(buildCertPinStaleView(STATE_NO_NEXT, FIXED_NOW)).toBeNull();
  });

  it('returns null when next_fingerprint is empty string', () => {
    expect(
      buildCertPinStaleView(
        { ...STATE_ACTIVE, next_fingerprint: '' },
        FIXED_NOW,
      ),
    ).toBeNull();
  });

  it('returns null when current_valid_until is in the past', () => {
    expect(buildCertPinStaleView(STATE_POST_FLIP, FIXED_NOW)).toBeNull();
  });

  it('returns null when current_valid_until exactly equals now', () => {
    expect(
      buildCertPinStaleView(
        { ...STATE_ACTIVE, current_valid_until: FIXED_NOW },
        FIXED_NOW,
      ),
    ).toBeNull();
  });

  it('returns the projected view during an active overlap window', () => {
    const view = buildCertPinStaleView(STATE_ACTIVE, FIXED_NOW);
    expect(view).not.toBeNull();
    expect(view!.current_fingerprint).toBe(STATE_ACTIVE.current_fingerprint);
    expect(view!.next_fingerprint).toBe(STATE_ACTIVE.next_fingerprint);
    expect(view!.current_valid_until).toBe(FLIP_AT_FUTURE);
    expect(view!.flip_at_iso).toBe(new Date(FLIP_AT_FUTURE).toISOString());
    expect(view!.flip_at_relative).toBe('in ~3d');
  });

  it('formats relative time as `in ~Nh` for sub-day windows', () => {
    const flip = FIXED_NOW + 5 * 60 * 60 * 1000; // +5h
    const view = buildCertPinStaleView(
      { ...STATE_ACTIVE, current_valid_until: flip },
      FIXED_NOW,
    );
    expect(view!.flip_at_relative).toBe('in ~5h');
  });

  it('formats relative time as `in <1h` for sub-hour windows', () => {
    const flip = FIXED_NOW + 10 * 60 * 1000; // +10m
    const view = buildCertPinStaleView(
      { ...STATE_ACTIVE, current_valid_until: flip },
      FIXED_NOW,
    );
    expect(view!.flip_at_relative).toBe('in <1h');
  });
});

// ──────────────────────────────────────────────────────────────────
// Mount: render + watcher integration
// ──────────────────────────────────────────────────────────────────

describe('D-148 § A.6.5 — mountCertPinStalePanel: construction', () => {
  it('throws when no document is available', () => {
    const host = makeFakeElement('div');
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    const originalDoc = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = undefined;
    try {
      expect(() =>
        mountCertPinStalePanel({
          host: host as unknown as HTMLElement,
          watcher,
        }),
      ).toThrow(/no document available/);
    } finally {
      (globalThis as { document?: unknown }).document = originalDoc;
      watcher.dispose();
    }
  });

  it('renders empty when watcher state is null', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    const panel = mountCertPinStalePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      watcher,
      now: () => FIXED_NOW,
    });
    // The wrapper div is always present; the panel itself is the
    // gated render. Assert no panel attribute under host + empty
    // wrapper.
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).toBeNull();
    expect(host.children[0]?.children.length).toBe(0);
    expect(panel.getViewState()).toBeNull();
    panel.dispose();
    watcher.dispose();
  });
});

describe('D-148 § A.6.5 — mountCertPinStalePanel: gating', () => {
  it('renders empty when next_fingerprint is undefined', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    watcher.notify(STATE_NO_NEXT);
    const panel = mountCertPinStalePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      watcher,
      now: () => FIXED_NOW,
    });
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).toBeNull();
    expect(panel.getViewState()).toBeNull();
    panel.dispose();
    watcher.dispose();
  });

  it('renders empty when current_valid_until is in the past (post-flip)', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    watcher.notify(STATE_POST_FLIP);
    const panel = mountCertPinStalePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      watcher,
      now: () => FIXED_NOW,
    });
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).toBeNull();
    expect(panel.getViewState()).toBeNull();
    panel.dispose();
    watcher.dispose();
  });
});

describe('D-148 § A.6.5 — mountCertPinStalePanel: active overlap render', () => {
  it('renders the panel with title, copy, flip time, and both fingerprint rows', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    watcher.notify(STATE_ACTIVE);
    const panel = mountCertPinStalePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      watcher,
      now: () => FIXED_NOW,
    });
    const panelEl = findByAttr(host, CERT_PIN_STALE_PANEL_ATTR);
    expect(panelEl).not.toBeNull();
    expect(panelEl?.getAttribute('role')).toBe('status');

    const title = findByAttr(host, CERT_PIN_STALE_TITLE_ATTR);
    expect(title?.textContent).toBe(CERT_PIN_STALE_COPY.title);

    const flipRow = findByAttr(host, CERT_PIN_STALE_FLIP_AT_ATTR);
    expect(flipRow).not.toBeNull();
    expect(flipRow?.getAttribute('title')).toBe(
      new Date(FLIP_AT_FUTURE).toISOString(),
    );
    expect(collectText(flipRow!)).toContain(CERT_PIN_STALE_COPY.flip_label);
    expect(collectText(flipRow!)).toContain('in ~3d');

    const currentRow = findByAttr(host, CERT_PIN_STALE_CURRENT_FP_ATTR);
    expect(currentRow).not.toBeNull();
    expect(currentRow?.getAttribute('title')).toBe(STATE_ACTIVE.current_fingerprint);
    expect(collectText(currentRow!)).toContain(CERT_PIN_STALE_COPY.current_label);
    expect(collectText(currentRow!)).toContain('aaaaaaaaaaaaaaaa…');

    const nextRow = findByAttr(host, CERT_PIN_STALE_NEXT_FP_ATTR);
    expect(nextRow).not.toBeNull();
    expect(nextRow?.getAttribute('title')).toBe(STATE_ACTIVE.next_fingerprint);
    expect(collectText(nextRow!)).toContain(CERT_PIN_STALE_COPY.next_label);
    expect(collectText(nextRow!)).toContain('bbbbbbbbbbbbbbbb…');

    expect(panel.getViewState()).not.toBeNull();
    expect(panel.getViewState()!.flip_at_relative).toBe('in ~3d');

    panel.dispose();
    watcher.dispose();
  });
});

describe('D-148 § A.6.5 — mountCertPinStalePanel: re-render on watcher transitions', () => {
  it('renders the panel when watcher transitions from null → active', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    const panel = mountCertPinStalePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      watcher,
      now: () => FIXED_NOW,
    });
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).toBeNull();
    watcher.notify(STATE_ACTIVE);
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).not.toBeNull();
    expect(panel.getViewState()).not.toBeNull();
    panel.dispose();
    watcher.dispose();
  });

  it('hides the panel when watcher transitions from active → null (rotation_reverted)', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    watcher.notify(STATE_ACTIVE);
    const panel = mountCertPinStalePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      watcher,
      now: () => FIXED_NOW,
    });
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).not.toBeNull();
    watcher.notify({
      current_fingerprint: STATE_ACTIVE.current_fingerprint,
      current_valid_until: STATE_ACTIVE.current_valid_until,
      last_rotated_at: FIXED_NOW,
    });
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).toBeNull();
    expect(panel.getViewState()).toBeNull();
    panel.dispose();
    watcher.dispose();
  });

  it('hides the panel after explicit update() once `now` crosses current_valid_until', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    watcher.notify(STATE_ACTIVE);
    // Mutable now seam — tests advance the clock between renders.
    let currentNow = FIXED_NOW;
    const panel = mountCertPinStalePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      watcher,
      now: () => currentNow,
    });
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).not.toBeNull();
    // Advance past the flip + force a redraw.
    currentNow = FLIP_AT_FUTURE + 1;
    panel.update();
    expect(findByAttr(host, CERT_PIN_STALE_PANEL_ATTR)).toBeNull();
    panel.dispose();
    watcher.dispose();
  });
});

describe('D-148 § A.6.5 — mountCertPinStalePanel: idempotency guard (DD#7, slice 114)', () => {
  it('a no-op update() does NOT rebuild the panel DOM (no live-region churn)', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    watcher.notify(STATE_ACTIVE);
    const panel = mountCertPinStalePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      watcher,
      now: () => FIXED_NOW,
    });
    // Capture the rendered panel element reference. The dedup means a
    // re-rendered "same" panel would be a DIFFERENT element (the
    // mount's render() does clearChildren + createElement). With the
    // guard, the reference stays identical.
    const initialPanel = findByAttr(host, CERT_PIN_STALE_PANEL_ATTR);
    expect(initialPanel).not.toBeNull();
    // Drive ten ticks without state or clock movement.
    for (let i = 0; i < 10; i++) panel.update();
    const afterPanel = findByAttr(host, CERT_PIN_STALE_PANEL_ATTR);
    // Same reference — no DOM churn.
    expect(afterPanel).toBe(initialPanel);
    // View state still reflects the latest projection.
    expect(panel.getViewState()).not.toBeNull();
    panel.dispose();
    watcher.dispose();
  });

  it('a clock-bucket crossing DOES rebuild (e.g. `in ~3d` → `in ~2d`)', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    watcher.notify(STATE_ACTIVE);
    let currentNow = FIXED_NOW;
    const panel = mountCertPinStalePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      watcher,
      now: () => currentNow,
    });
    const before = findByAttr(host, CERT_PIN_STALE_PANEL_ATTR);
    expect(before).not.toBeNull();
    expect(panel.getViewState()!.flip_at_relative).toBe('in ~3d');
    // Advance the clock so the relative-time bucket crosses to `in ~2d`.
    currentNow = FIXED_NOW + 1 * 24 * 60 * 60 * 1000; // +1d
    panel.update();
    const after = findByAttr(host, CERT_PIN_STALE_PANEL_ATTR);
    expect(after).not.toBeNull();
    // Bucket boundary forces a re-render → new element reference.
    expect(after).not.toBe(before);
    expect(panel.getViewState()!.flip_at_relative).toBe('in ~2d');
    panel.dispose();
    watcher.dispose();
  });

  it('null → null ticks dedup too (no churn when no rotation is staged)', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    // Watcher state never advances — projection is always null.
    const panel = mountCertPinStalePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      watcher,
      now: () => FIXED_NOW,
    });
    // First render leaves the wrapper empty.
    const wrapper = host.children[0]!;
    expect(wrapper.children.length).toBe(0);
    // Ten subsequent ticks must NOT touch the wrapper (no clearChildren
    // calls on already-empty wrapper would still be a no-op for the
    // DOM, but the guard short-circuits before that).
    for (let i = 0; i < 10; i++) panel.update();
    expect(wrapper.children.length).toBe(0);
    expect(panel.getViewState()).toBeNull();
    panel.dispose();
    watcher.dispose();
  });
});

describe('D-148 § A.6.5 — mountCertPinStalePanel: dispose', () => {
  it('detaches the subscriber + clears the host', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    watcher.notify(STATE_ACTIVE);
    const panel = mountCertPinStalePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      watcher,
      now: () => FIXED_NOW,
    });
    expect(host.children.length).toBeGreaterThan(0);
    panel.dispose();
    expect(host.children.length).toBe(0);
    // Post-dispose watcher transitions do not repopulate the host.
    watcher.notify({
      current_fingerprint: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      next_fingerprint:
        'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      current_valid_until: FLIP_AT_FUTURE,
    });
    expect(host.children.length).toBe(0);
    watcher.dispose();
  });

  it('is idempotent — second dispose is harmless', () => {
    const host = makeFakeElement('div');
    const doc = makeFakeDocument();
    const watcher = createCertPinStateWatcher({
      localStore: createInMemoryWebclientLocalStore(),
    });
    const panel = mountCertPinStalePanel({
      host: host as unknown as HTMLElement,
      document: doc as unknown as Document,
      watcher,
    });
    panel.dispose();
    expect(() => panel.dispose()).not.toThrow();
    watcher.dispose();
  });
});
