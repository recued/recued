/** Unified `#packs` surface — the list↔detail composition layer
 *  (`packs/packs-surface.ts`). Drives `mountPacksSurface` with FAKE list + detail
 *  factories (the real discover panel + packs panel are covered by their own
 *  unit tests) so this asserts ONLY the composition concerns: which host is
 *  shown per selection, that both children stay mounted across the toggle (browse
 *  state survives a detail visit — the A1 promise), the hash-sync funnel, the
 *  deep-link initial paint, the Add-by-slug/URL header, and dispose.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PACKS_SURFACE_ADD_ERROR_ATTR,
  PACKS_SURFACE_DETAIL_ATTR,
  PACKS_SURFACE_LIST_ATTR,
  mountPacksSurface,
  type PacksSurfaceDetailHandle,
} from '../packs/packs-surface.js';

// ── Minimal fake DOM (mirrors the packs-panel test harness + a `hidden` prop) ──
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  value: string;
  hidden: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(t: string, fn: (ev: unknown) => void): void;
  removeEventListener(t: string, fn: (ev: unknown) => void): void;
  click(): void;
  remove(): void;
}

const makeEl = (tag: string): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    value: '',
    hidden: false,
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
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
    addEventListener: (t, fn) => {
      const a = el.listeners.get(t) ?? [];
      a.push(fn);
      el.listeners.set(t, a);
    },
    removeEventListener: (t, fn) => {
      const a = el.listeners.get(t);
      if (a === undefined) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    click: () => {
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    remove: () => {
      if (el.parent !== null) el.parent.removeChild(el);
    },
  };
  return el;
};

const fakeDoc = () => {
  const styles: FakeEl[] = [];
  return {
    head: {
      querySelector: () => null, // never dedup styles in the fake
      appendChild: (el: FakeEl) => {
        styles.push(el);
        return el;
      },
    },
    createElement: (tag: string) => makeEl(tag),
  };
};

const findByAttr = (root: FakeEl, attr: string): FakeEl | null => {
  if (root.hasAttribute(attr)) return root;
  for (const c of root.children) {
    const hit = findByAttr(c, attr);
    if (hit !== null) return hit;
  }
  return null;
};

/** A fake detail handle whose `clickSelectPack` fires `onSelectSlug` — exactly
 *  what the real packs panel does via `selectPack`. `dispose` is spied. */
const makeFakeDetail = (
  onSelectSlug: (slug: string | null) => void,
): PacksSurfaceDetailHandle & { disposed: boolean; selected: string | null } => {
  const handle = {
    disposed: false,
    selected: null as string | null,
    clickSelectPack: (slug: string) => {
      handle.selected = slug;
      onSelectSlug(slug);
    },
    // The panel's Back button fires onSelectSlug(null) + clears its selection —
    // model that so the surface's backToList (which drives this) stays in sync.
    clickBackToList: () => {
      handle.selected = null;
      onSelectSlug(null);
    },
    dispose: () => {
      handle.disposed = true;
    },
  };
  return handle;
};

interface Harness {
  root: FakeEl;
  navCalls: Array<string | null>;
  listDisposed: () => boolean;
  detail: ReturnType<typeof makeFakeDetail>;
  listOnSelect: (slug: string) => void;
  surface: ReturnType<typeof mountPacksSurface>;
}

const setup = (opts: { initialSlug?: string; enableAdd?: boolean } = {}): Harness => {
  const doc = fakeDoc();
  const root = makeEl('div');
  const navCalls: Array<string | null> = [];
  let listDisposed = false;
  let listOnSelect: (slug: string) => void = () => undefined;
  let detail!: ReturnType<typeof makeFakeDetail>;

  const surface = mountPacksSurface({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    mountList: (_host, onSelect) => {
      listOnSelect = onSelect;
      return { dispose: () => { listDisposed = true; } };
    },
    mountDetail: (_host, onSelectSlug) => {
      detail = makeFakeDetail(onSelectSlug);
      return detail;
    },
    ...(opts.initialSlug !== undefined ? { initialSlug: opts.initialSlug } : {}),
    onNavigate: (slug) => navCalls.push(slug),
    ...(opts.enableAdd !== undefined ? { enableAdd: opts.enableAdd } : {}),
  });

  return {
    root,
    navCalls,
    listDisposed: () => listDisposed,
    detail,
    listOnSelect: (slug) => listOnSelect(slug),
    surface,
  };
};

const listView = (root: FakeEl): FakeEl => findByAttr(root, PACKS_SURFACE_LIST_ATTR)!;
const detailHost = (root: FakeEl): FakeEl => findByAttr(root, PACKS_SURFACE_DETAIL_ATTR)!;

describe('mountPacksSurface — list↔detail composition', () => {
  it('starts on the list (list shown, detail hidden) with no deep-link', () => {
    const h = setup();
    expect(h.surface.activeSlug()).toBeNull();
    expect(listView(h.root).hidden).toBe(false);
    expect(detailHost(h.root).hidden).toBe(true);
  });

  it('a list row click opens the detail (list hidden, detail shown) + syncs the hash', () => {
    const h = setup();
    h.listOnSelect('pack-a');
    expect(h.surface.activeSlug()).toBe('pack-a');
    expect(h.detail.selected).toBe('pack-a'); // the surface drove the detail panel
    expect(listView(h.root).hidden).toBe(true);
    expect(detailHost(h.root).hidden).toBe(false);
    expect(h.navCalls).toEqual(['pack-a']);
  });

  it('Back returns to the list WITHOUT tearing either child down (browse state survives)', () => {
    const h = setup();
    h.listOnSelect('pack-a');
    h.surface.backToList();
    expect(h.surface.activeSlug()).toBeNull();
    expect(listView(h.root).hidden).toBe(false);
    expect(detailHost(h.root).hidden).toBe(true);
    // Neither child was disposed across the toggle — that's the A1 promise.
    expect(h.listDisposed()).toBe(false);
    expect(h.detail.disposed).toBe(false);
    expect(h.navCalls).toEqual(['pack-a', null]);
  });

  it('re-opening the SAME pack after Back works (backToList clears the panel selection too)', () => {
    const h = setup();
    h.listOnSelect('pack-a');
    h.surface.backToList();
    expect(h.detail.selected).toBeNull(); // panel selection cleared, not stale
    // Re-open the same slug — the panel's selectPack no-op guard would strand this
    // if its selection hadn't been cleared on Back.
    h.listOnSelect('pack-a');
    expect(h.surface.activeSlug()).toBe('pack-a');
    expect(detailHost(h.root).hidden).toBe(false);
  });

  it('a deep-link (initialSlug) opens the detail on mount WITHOUT firing onNavigate', () => {
    const h = setup({ initialSlug: 'pack-b' });
    expect(h.surface.activeSlug()).toBe('pack-b');
    expect(detailHost(h.root).hidden).toBe(false);
    expect(listView(h.root).hidden).toBe(true);
    // Hash already matches the deep-link — no replaceState churn on mount.
    expect(h.navCalls).toEqual([]);
  });

  it('dispose tears down both children', () => {
    const h = setup();
    h.surface.dispose();
    expect(h.listDisposed()).toBe(true);
    expect(h.detail.disposed).toBe(true);
  });
});

describe('mountPacksSurface — Add by slug / URL header', () => {
  it('a bare slug navigates to that pack’s detail', () => {
    const h = setup({ enableAdd: true });
    const input = findByAttr(h.root, 'data-recued-packs-surface-add-input')!;
    const submit = findByAttr(h.root, 'data-recued-packs-surface-add-submit')!;
    input.value = 'sales-pack';
    submit.click();
    expect(h.surface.activeSlug()).toBe('sales-pack');
    expect(h.detail.selected).toBe('sales-pack');
  });

  it('a marketplace pack URL resolves to its slug + navigates', () => {
    const h = setup({ enableAdd: true });
    const input = findByAttr(h.root, 'data-recued-packs-surface-add-input')!;
    const submit = findByAttr(h.root, 'data-recued-packs-surface-add-submit')!;
    input.value = 'https://recued.com/packs/sales-pack';
    submit.click();
    expect(h.surface.activeSlug()).toBe('sales-pack');
  });

  it('an arbitrary (non-marketplace) URL shows the deferred-import notice + does NOT navigate', () => {
    const h = setup({ enableAdd: true });
    const input = findByAttr(h.root, 'data-recued-packs-surface-add-input')!;
    const submit = findByAttr(h.root, 'data-recued-packs-surface-add-submit')!;
    input.value = 'https://example.com/my-pack.json';
    submit.click();
    expect(h.surface.activeSlug()).toBeNull();
    const err = findByAttr(h.root, PACKS_SURFACE_ADD_ERROR_ATTR)!;
    expect(err.hidden).toBe(false);
    expect(err.textContent.length).toBeGreaterThan(0);
  });

  it('no Add header when enableAdd is unset', () => {
    const h = setup();
    expect(findByAttr(h.root, 'data-recued-packs-surface-add-input')).toBeNull();
  });
});
