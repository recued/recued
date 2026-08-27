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
  PACKS_SURFACE_INSTALLED_ONLY_ERROR_ATTR,
  PACKS_SURFACE_LIST_ATTR,
  mountPacksSurface,
  PACKS_SURFACE_INSTALLED_ONLY_ATTR,
  type PacksSurfaceDetailHandle,
} from '../packs/packs-surface.js';
import {
  LIST_PREVIEW_ATTR,
  LIST_PREVIEW_CLOSE_ATTR,
  LIST_PREVIEW_OPEN_ATTR,
  type ListPreviewContent,
} from '../shell/list-preview-continuity.js';

// ── Minimal fake DOM (mirrors the packs-panel test harness + a `hidden` prop) ──
interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  scrollTop: number;
  scrollLeft: number;
  type: string;
  value: string;
  hidden: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(t: string, fn: (ev: unknown) => void): void;
  removeEventListener(t: string, fn: (ev: unknown) => void): void;
  contains(candidate: FakeEl): boolean;
  focus(): void;
  click(): void;
  remove(): void;
}

const makeEl = (
  tag: string,
  onFocus: (element: FakeEl) => void = () => {},
): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    scrollTop: 0,
    scrollLeft: 0,
    type: '',
    value: '',
    hidden: false,
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    setAttribute: (k, v) => el.attrs.set(k, v),
    removeAttribute: (k) => { el.attrs.delete(k); },
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
    contains: (candidate) =>
      candidate === el || el.children.some((child) => child.contains(candidate)),
    focus: () => onFocus(el),
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
  let activeElement: FakeEl | null = null;
  return {
    get activeElement() {
      return activeElement;
    },
    head: {
      querySelector: () => null, // never dedup styles in the fake
      appendChild: (el: FakeEl) => {
        styles.push(el);
        return el;
      },
    },
    createElement: (tag: string) => makeEl(tag, (element) => {
      activeElement = element;
    }),
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
  doc: ReturnType<typeof fakeDoc>;
  root: FakeEl;
  listControl: FakeEl;
  navCalls: Array<string | null>;
  listDisposed: () => boolean;
  detail: ReturnType<typeof makeFakeDetail>;
  listOnSelect: (slug: string) => void;
  listOnPreview: (content: ListPreviewContent, opener: FakeEl) => void;
  surface: ReturnType<typeof mountPacksSurface>;
  installedOnlyCalls: boolean[];
}

const setup = (
  opts: {
    initialSlug?: string;
    enableAdd?: boolean;
    installedOnly?: boolean;
    installedOnlySetter?: (on: boolean) => Promise<void>;
    document?: ReturnType<typeof fakeDoc>;
    /** Capture the callback the surface registers for the list's OWN
     *  installed-first default, so a test can fire it like the real list does. */
    captureInstalledOnlyNotifier?: (fire: (on: boolean) => void) => void;
  } = {},
): Harness => {
  const doc = opts.document ?? fakeDoc();
  const root = doc.createElement('div');
  const navCalls: Array<string | null> = [];
  let listDisposed = false;
  let listOnSelect: (slug: string) => void = () => undefined;
  let listOnPreview: (
    content: ListPreviewContent,
    opener: HTMLElement,
  ) => void = () => undefined;
  let listControl!: FakeEl;
  const installedOnlyCalls: boolean[] = [];
  let detail!: ReturnType<typeof makeFakeDetail>;

  const surface = mountPacksSurface({
    root: root as unknown as HTMLElement,
    document: doc as unknown as Document,
    mountList: (host, onSelect, onPreview) => {
      listOnSelect = onSelect;
      listOnPreview = onPreview;
      listControl = doc.createElement('button');
      host.appendChild(listControl as unknown as Node);
      return {
        dispose: () => { listDisposed = true; },
        // Opt-in, mirroring the real contract: a list that cannot honour the
        // filter simply does not offer one.
        ...(opts.installedOnly === true || opts.installedOnlySetter !== undefined
          ? {
              setInstalledOnly: async (on: boolean) => {
                installedOnlyCalls.push(on);
                await opts.installedOnlySetter?.(on);
              },
              onInstalledOnlyChange: (cb: (on: boolean) => void) => {
                opts.captureInstalledOnlyNotifier?.(cb);
              },
            }
          : {}),
      };
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
    doc,
    root,
    listControl,
    navCalls,
    listDisposed: () => listDisposed,
    detail,
    listOnSelect: (slug) => listOnSelect(slug),
    listOnPreview: (content, opener) =>
      listOnPreview(content, opener as unknown as HTMLElement),
    surface,
    installedOnlyCalls,
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

  it('previews without leaving the list and Escape-equivalent Close restores focus + scroll', () => {
    const h = setup();
    h.listControl.setAttribute('data-recued-discover-card', '');
    h.listControl.setAttribute('data-id', 'pack-a');
    h.listControl.focus();
    h.root.scrollTop = 480;

    h.listOnPreview({
      id: 'pack-a',
      title: 'Pack A',
      summary: 'A pack preview.',
      primaryLabel: 'Open pack',
    }, h.listControl);

    const preview = findByAttr(h.root, LIST_PREVIEW_ATTR)!;
    expect(preview.hidden).toBe(false);
    expect(preview.getAttribute('data-id')).toBe('pack-a');
    expect(h.surface.activeSlug()).toBeNull();
    expect(listView(h.root).hidden).toBe(false);

    h.root.scrollTop = 0;
    findByAttr(h.root, LIST_PREVIEW_CLOSE_ATTR)!.click();
    expect(preview.hidden).toBe(true);
    expect(h.doc.activeElement).toBe(h.listControl);
    expect(h.root.scrollTop).toBe(480);

    h.listOnPreview({ id: 'pack-a', title: 'Pack A' }, h.listControl);
    findByAttr(h.root, LIST_PREVIEW_OPEN_ATTR)!.click();
    expect(h.surface.activeSlug()).toBe('pack-a');
    expect(h.navCalls).toEqual(['pack-a']);
  });

  it('restores the semantic pack row and scroll after a route remount', async () => {
    const document = fakeDoc();
    const first = setup({ document });
    first.listControl.setAttribute('data-recued-discover-card', '');
    first.listControl.setAttribute('data-id', 'pack-a');
    first.listControl.focus();
    first.root.scrollTop = 730;
    first.root.scrollLeft = 6;
    first.listOnPreview({ id: 'pack-a', title: 'Pack A' }, first.listControl);
    first.surface.dispose();

    const second = setup({ document });
    second.listControl.setAttribute('data-recued-discover-card', '');
    second.listControl.setAttribute('data-id', 'pack-a');
    await Promise.resolve();

    expect(second.root.scrollTop).toBe(730);
    expect(second.root.scrollLeft).toBe(6);
    expect(document.activeElement).toBe(second.listControl);
    second.surface.dispose();
  });

  it('focuses the detail host, then restores the exact list opener on Back', async () => {
    const h = setup();
    h.listControl.focus();
    h.root.scrollTop = 640;
    h.root.scrollLeft = 12;

    h.listOnSelect('pack-a');
    await Promise.resolve();
    expect(h.doc.activeElement).toBe(detailHost(h.root));
    expect(h.root.scrollTop).toBe(0);
    expect(h.root.scrollLeft).toBe(0);

    h.surface.backToList();
    expect(h.doc.activeElement).toBe(h.listControl);
    expect(h.root.scrollTop).toBe(640);
    expect(h.root.scrollLeft).toBe(12);
  });

  it('restores the selected card by identity when the hidden list replaces it', async () => {
    const h = setup();
    h.listControl.setAttribute('data-recued-discover-card', '');
    h.listControl.setAttribute('data-id', 'pack-a');
    h.listControl.focus();
    const listHost = h.listControl.parent!;

    h.listOnSelect('pack-a');
    await Promise.resolve();
    h.listControl.remove();
    const replacement = h.doc.createElement('div');
    replacement.setAttribute('data-recued-discover-card', '');
    replacement.setAttribute('data-id', 'pack-a');
    listHost.appendChild(replacement);

    h.surface.backToList();
    expect(h.doc.activeElement).toBe(replacement);
  });

  it('restores a replaced card action by pack identity when it stays actionable', async () => {
    const h = setup();
    h.listControl.setAttribute('data-recued-discover-action', '');
    h.listControl.setAttribute('data-id', 'pack-a');
    h.listControl.focus();
    const listHost = h.listControl.parent!;

    h.listOnSelect('pack-a');
    await Promise.resolve();
    h.listControl.remove();
    const replacement = h.doc.createElement('button');
    replacement.setAttribute('data-recued-discover-action', '');
    replacement.setAttribute('data-id', 'pack-a');
    listHost.appendChild(replacement);

    h.surface.backToList();
    expect(h.doc.activeElement).toBe(replacement);
  });

  it('falls back to the pack card when its replaced action becomes a status', async () => {
    const h = setup();
    const listHost = h.listControl.parent!;
    h.listControl.remove();
    const card = h.doc.createElement('div');
    card.setAttribute('data-recued-discover-card', '');
    card.setAttribute('data-id', 'pack-a');
    h.listControl.setAttribute('data-recued-discover-action', '');
    h.listControl.setAttribute('data-id', 'pack-a');
    card.appendChild(h.listControl);
    listHost.appendChild(card);
    h.listControl.focus();

    h.listOnSelect('pack-a');
    await Promise.resolve();
    card.remove();
    const replacementCard = h.doc.createElement('div');
    replacementCard.setAttribute('data-recued-discover-card', '');
    replacementCard.setAttribute('data-id', 'pack-a');
    const installed = h.doc.createElement('span');
    installed.setAttribute('data-recued-discover-action', '');
    installed.setAttribute('data-id', 'pack-a');
    replacementCard.appendChild(installed);
    listHost.appendChild(replacementCard);

    h.surface.backToList();
    expect(h.doc.activeElement).toBe(replacementCard);
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

  it('a deep-link opens and focuses the detail WITHOUT firing onNavigate', async () => {
    const h = setup({ initialSlug: 'pack-b' });
    await Promise.resolve();
    expect(h.surface.activeSlug()).toBe('pack-b');
    expect(detailHost(h.root).hidden).toBe(false);
    expect(listView(h.root).hidden).toBe(true);
    expect(h.doc.activeElement).toBe(detailHost(h.root));
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
  it('does not open or clear a pack slug while its IME composition is active', () => {
    const h = setup({ enableAdd: true });
    const input = findByAttr(h.root, 'data-recued-packs-surface-add-input')!;
    input.value = '日本語パック';

    const composingPreventDefault = vi.fn();
    for (const listener of input.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        isComposing: true,
        preventDefault: composingPreventDefault,
      });
    }
    expect(composingPreventDefault).not.toHaveBeenCalled();
    expect(input.value).toBe('日本語パック');
    expect(h.surface.activeSlug()).toBeNull();

    const submitPreventDefault = vi.fn();
    for (const listener of input.listeners.get('keydown') ?? []) {
      listener({
        key: 'Enter',
        isComposing: false,
        preventDefault: submitPreventDefault,
      });
    }
    expect(submitPreventDefault).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');
    expect(h.surface.activeSlug()).toBe('日本語パック');
  });

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

describe('the installed-only filter — what replaced the retired Installed tab', () => {
  it('toggles the list source and reflects pressed state', async () => {
    const h = setup({ installedOnly: true });
    const btn = findByAttr(h.root, PACKS_SURFACE_INSTALLED_ONLY_ATTR);
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('aria-pressed')).toBe('false');

    (btn as unknown as FakeEl).click();
    await vi.waitFor(() => {
      expect(btn!.getAttribute('aria-busy')).toBeNull();
    });
    expect(h.installedOnlyCalls).toEqual([true]);
    expect(btn!.getAttribute('aria-pressed')).toBe('true');

    (btn as unknown as FakeEl).click();
    await vi.waitFor(() => {
      expect(btn!.getAttribute('aria-busy')).toBeNull();
    });
    // Toggles BACK — a one-way filter would strand the user in their own packs
    // with no route back to the catalogue.
    expect(h.installedOnlyCalls).toEqual([true, false]);
    expect(btn!.getAttribute('aria-pressed')).toBe('false');
  });

  it('stays focusable and guards re-entry while the source swaps', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const h = setup({ installedOnlySetter: () => pending });
    const btn = findByAttr(h.root, PACKS_SURFACE_INSTALLED_ONLY_ATTR)!;

    btn.click();
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(btn.hasAttribute('disabled')).toBe(false);
    btn.click();
    expect(h.installedOnlyCalls).toEqual([true]);

    release();
    await pending;
    await vi.waitFor(() => {
      expect(btn.getAttribute('aria-disabled')).toBeNull();
      expect(btn.getAttribute('aria-busy')).toBeNull();
    });
  });

  it('rolls back the pressed state and reports a failed source swap', async () => {
    const h = setup({
      installedOnlySetter: async () => {
        throw new Error('refresh failed');
      },
    });
    const btn = findByAttr(h.root, PACKS_SURFACE_INSTALLED_ONLY_ATTR)!;

    btn.click();
    await vi.waitFor(() => {
      expect(btn.getAttribute('aria-pressed')).toBe('false');
      expect(btn.getAttribute('aria-busy')).toBeNull();
    });
    const error = findByAttr(
      h.root,
      PACKS_SURFACE_INSTALLED_ONLY_ERROR_ATTR,
    )!;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('Try again');
  });

  it('⛔ does NOT render when the list cannot honour it', () => {
    // The negative control. A toggle that renders against a list with no
    // `setInstalledOnly` would look live and do nothing — worse than absent.
    const h = setup();
    expect(findByAttr(h.root, PACKS_SURFACE_INSTALLED_ONLY_ATTR)).toBeNull();
    expect(findByAttr(h.root, PACKS_SURFACE_INSTALLED_ONLY_ERROR_ATTR)).toBeNull();
  });
});

/** The list decides the installed-first default for itself, after its roster
 *  lands. The surface owns the control, so it has to be TOLD — otherwise the
 *  list filters while the toggle reads "off", and the user's first press turns
 *  the filter OFF while appearing to turn it on. */
describe('packs surface — the toggle reflects the list-chosen default', () => {
  it('renders pressed when the list reports installed-first', () => {
    let fire: ((on: boolean) => void) | null = null;
    const h = setup({
      installedOnly: true,
      captureInstalledOnlyNotifier: (cb) => { fire = cb; },
    });
    const toggle = findByAttr(h.root, PACKS_SURFACE_INSTALLED_ONLY_ATTR)!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    // The roster landed and the list turned itself on.
    fire!(true);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');

    // 🔑 And the control is now coherent: pressing it turns the filter OFF.
    // Before the mirror this press sent `true` — re-asserting a filter that was
    // already on, which is why it looked like the button did nothing.
    toggle.click();
    expect(h.installedOnlyCalls).toEqual([false]);
    h.surface.dispose();
  });

  it('a server with nothing installed leaves the toggle unpressed', () => {
    // Negative control — the notifier only fires when the list actually flips.
    const h = setup({ installedOnly: true, captureInstalledOnlyNotifier: () => undefined });
    const toggle = findByAttr(h.root, PACKS_SURFACE_INSTALLED_ONLY_ATTR)!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    h.surface.dispose();
  });
});
