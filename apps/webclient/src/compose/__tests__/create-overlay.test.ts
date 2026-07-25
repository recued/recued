/** Shell-frame Step 5 — the shared Create overlay opener (§D.L1).
 *
 *  Pins the handle contract that BOTH callers (the chat composer button + the
 *  §D.L2 drawer "Create" seat) rely on:
 *   - returns null when no write path is wired;
 *   - opens portaled to body (or an explicit portal) with the Create title +
 *     the compose route's 4 target chips;
 *   - `close()` detaches the overlay AND removes the document keydown listener
 *     AND fires `onClose` exactly once — the teardown the bootstrap dispose +
 *     the chat-route dispose both lean on (regression for the discarded-handle
 *     leak);
 *   - `close()` is idempotent (a dispose may close an already-closed overlay);
 *   - Escape / backdrop / Close all tear it down and fire `onClose`.
 *
 *  Rolls a small query+dispatch-capable fake document (the webclient has no
 *  jsdom; the bootstrap test's fake lacks `body` + `document.addEventListener`,
 *  both of which the portaled overlay needs).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  openCreateOverlay,
  CREATE_OVERLAY_ATTR,
  CREATE_OVERLAY_CLOSE_ATTR,
} from '../create-overlay.js';
import { COMPOSE_ROUTE_TARGET_CHIP_ATTR } from '../compose-route.js';

// ── fake DOM ──────────────────────────────────────────────────────

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  value: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  remove(): void;
  addEventListener(t: string, fn: (ev: unknown) => void): void;
  removeEventListener(t: string, fn: (ev: unknown) => void): void;
  querySelector(sel: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
  click(): void;
  focus(): void;
}

const matchAttr = (sel: string): string | null => {
  const m = sel.match(/^\[([\w-]+)\]$/);
  return m?.[1] ?? null;
};

const makeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    value: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute: (k, v) => el.attrs.set(k, v),
    getAttribute: (k) => el.attrs.get(k) ?? null,
    hasAttribute: (k) => el.attrs.has(k),
    appendChild: (c) => {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild: (c) => {
      const i = el.children.indexOf(c);
      if (i < 0) throw new Error('removeChild: not a child');
      el.children.splice(i, 1);
      c.parent = null;
      return c;
    },
    remove: () => {
      if (el.parent === null) return;
      const i = el.parent.children.indexOf(el);
      if (i >= 0) el.parent.children.splice(i, 1);
      el.parent = null;
    },
    addEventListener: (t, fn) => {
      const list = el.listeners.get(t) ?? [];
      list.push(fn);
      el.listeners.set(t, list);
    },
    removeEventListener: (t, fn) => {
      const list = el.listeners.get(t);
      if (list === undefined) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    querySelector: (sel) => el.querySelectorAll(sel)[0] ?? null,
    querySelectorAll: (sel) => {
      const attr = matchAttr(sel);
      if (attr === null) return [];
      const out: FakeEl[] = [];
      const walk = (n: FakeEl): void => {
        for (const c of n.children) {
          if (c.attrs.has(attr)) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    click: () => {
      if (el.disabled) return;
      for (const fn of [...(el.listeners.get('click') ?? [])]) fn({ target: el });
    },
    focus: () => undefined, // overridden per-document to track activeElement
  };
  return el;
};

interface FakeDoc {
  body: FakeEl;
  activeElement: FakeEl | null;
  head: {
    querySelector(sel: string): FakeEl | null;
    appendChild(el: FakeEl): FakeEl;
  };
  styles: FakeEl[];
  keydownCount(): number;
  createElement(tag: string): FakeEl;
  addEventListener(t: string, fn: (ev: unknown) => void): void;
  removeEventListener(t: string, fn: (ev: unknown) => void): void;
  fireKeydown(key: string): void;
}

const makeDoc = (): FakeDoc => {
  const styles: FakeEl[] = [];
  const keydown: Array<(ev: unknown) => void> = [];
  let activeElement: FakeEl | null = null;
  const create = (tag: string): FakeEl => {
    const el = makeEl(tag);
    el.focus = () => {
      activeElement = el;
    };
    return el;
  };
  const body = create('body');
  return {
    body,
    get activeElement() {
      return activeElement;
    },
    styles,
    head: {
      querySelector(sel) {
        const m = sel.match(/^style\[([\w-]+)\]$/);
        const attr = m?.[1];
        if (attr === undefined) return null;
        return styles.find((s) => s.attrs.has(attr)) ?? null;
      },
      appendChild(el) {
        styles.push(el);
        return el;
      },
    },
    keydownCount: () => keydown.length,
    createElement: create,
    addEventListener: (t, fn) => {
      if (t === 'keydown') keydown.push(fn);
    },
    removeEventListener: (t, fn) => {
      if (t !== 'keydown') return;
      const i = keydown.indexOf(fn);
      if (i >= 0) keydown.splice(i, 1);
    },
    fireKeydown(key) {
      for (const fn of [...keydown]) fn({ key });
    },
  };
};

const collectByAttr = (root: FakeEl, attr: string): FakeEl[] => {
  const out: FakeEl[] = [];
  const walk = (n: FakeEl): void => {
    if (n.attrs.has(attr)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};

const allText = (root: FakeEl): string =>
  [root.textContent, ...root.children.map(allText)].join(' ');

const wiredCallers = () => ({
  contactUpsertCaller: vi.fn(async () => ({ contact: {} as never })),
  workEntityUpsertCaller: vi.fn(async () => ({ entity: {} as never })),
});

const open = (doc: FakeDoc, extra: Record<string, unknown> = {}) =>
  openCreateOverlay({
    document: doc as unknown as Document,
    ...wiredCallers(),
    ...extra,
  });

// ── tests ─────────────────────────────────────────────────────────

describe('Shell-frame Step 5 — shared Create overlay opener', () => {
  it('returns null when no write path is wired', () => {
    const doc = makeDoc();
    expect(openCreateOverlay({ document: doc as unknown as Document })).toBeNull();
    expect(collectByAttr(doc.body, CREATE_OVERLAY_ATTR)).toHaveLength(0);
  });

  it('opens portaled to body with the Create title + compose targets', () => {
    const doc = makeDoc();
    const handle = open(doc);
    expect(handle).not.toBeNull();
    const overlays = collectByAttr(doc.body, CREATE_OVERLAY_ATTR);
    expect(overlays).toHaveLength(1);
    expect(allText(overlays[0]!)).toContain('Create');
    expect(collectByAttr(overlays[0]!, CREATE_OVERLAY_CLOSE_ATTR)).toHaveLength(1);
    expect(
      collectByAttr(overlays[0]!, COMPOSE_ROUTE_TARGET_CHIP_ATTR).length,
    ).toBeGreaterThanOrEqual(4);
  });

  it('portals to an explicit portal when provided', () => {
    const doc = makeDoc();
    const portal = doc.createElement('div');
    open(doc, { portal: portal as unknown as HTMLElement });
    expect(collectByAttr(portal, CREATE_OVERLAY_ATTR)).toHaveLength(1);
    expect(collectByAttr(doc.body, CREATE_OVERLAY_ATTR)).toHaveLength(0);
  });

  it('close() detaches the overlay, removes both keydown listeners, and fires onClose once', () => {
    const doc = makeDoc();
    const onClose = vi.fn();
    const handle = open(doc, { onClose });
    expect(handle).not.toBeNull();
    // Two doc keydown listeners while open: the overlay's Escape + the shared
    // focus-trap's Tab handler.
    expect(doc.keydownCount()).toBe(2);
    handle!.close();
    expect(collectByAttr(doc.body, CREATE_OVERLAY_ATTR)).toHaveLength(0);
    expect(doc.keydownCount()).toBe(0); // both removed → no leak
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('close() is idempotent (a dispose may close an already-closed overlay)', () => {
    const doc = makeDoc();
    const onClose = vi.fn();
    const handle = open(doc, { onClose });
    handle!.close();
    handle!.close(); // second call no-ops
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(collectByAttr(doc.body, CREATE_OVERLAY_ATTR)).toHaveLength(0);
  });

  it('Escape closes the overlay and fires onClose', () => {
    const doc = makeDoc();
    const onClose = vi.fn();
    open(doc, { onClose });
    expect(collectByAttr(doc.body, CREATE_OVERLAY_ATTR)).toHaveLength(1);
    doc.fireKeydown('Escape');
    expect(collectByAttr(doc.body, CREATE_OVERLAY_ATTR)).toHaveLength(0);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the Close button and a backdrop click each tear the overlay down', () => {
    const docA = makeDoc();
    open(docA);
    collectByAttr(docA.body, CREATE_OVERLAY_CLOSE_ATTR)[0]!.click();
    expect(collectByAttr(docA.body, CREATE_OVERLAY_ATTR)).toHaveLength(0);

    const docB = makeDoc();
    open(docB);
    const overlay = collectByAttr(docB.body, CREATE_OVERLAY_ATTR)[0]!;
    overlay.click(); // target === overlay → backdrop close
    expect(collectByAttr(docB.body, CREATE_OVERLAY_ATTR)).toHaveLength(0);
  });

  it('moves focus into the dialog on open and restores it on close', () => {
    const doc = makeDoc();
    const opener = doc.createElement('button');
    opener.focus(); // the caller (Create button / drawer seat) holds focus
    expect(doc.activeElement).toBe(opener);
    const handle = open(doc);
    // focus moved into the dialog panel (the overlay's first child)
    const panel = collectByAttr(doc.body, CREATE_OVERLAY_ATTR)[0]!.children[0]!;
    expect(doc.activeElement).toBe(panel);
    handle!.close();
    expect(doc.activeElement).toBe(opener); // restored on close
  });
});
