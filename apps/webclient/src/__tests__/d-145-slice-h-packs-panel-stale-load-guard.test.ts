/** D-145 PA10 follow-on Slice H - packs-panel stale-load guard. */

import { describe, expect, it } from 'vitest';

import {
  PACKS_ROW_SLUG_ATTR,
  PACKS_PANEL_ATTR,
  PACKS_PANEL_STATE_ATTR,
  mountPacksPanel,
  type PacksInstallCaller,
  type PacksListCaller,
  type PacksUninstallCaller,
} from '../settings/packs-panel.js';
import type {
  BulkPackInstallResultLike,
  BulkPackManifest,
  BulkPackUninstallResultLike,
  PackListEntry,
} from '@recued/contracts';

// ──────────────────────────────────────────────────────────────────
// Fake DOM (mirrors Slice A test harness shape)
// ──────────────────────────────────────────────────────────────────

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  checked: boolean;
  className: string;
  id: string;
  type: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  removeEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
}

const makeFakeElement = (tagName: string): FakeElement => {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const attrs = new Map<string, string>();
  const children: FakeElement[] = [];
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    checked: false,
    className: '',
    id: '',
    type: '',
    children,
    parent: null,
    attrs,
    listeners,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
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
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener: (name, fn) => {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
    },
    removeEventListener: (name, fn) => {
      const arr = listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(fn);
      if (idx >= 0) arr.splice(idx, 1);
    },
    click: () => {
      const arr = listeners.get('click') ?? [];
      for (const fn of arr) fn({ target: el });
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

const findAllByAttr = (root: FakeElement, attr: string): FakeElement[] => {
  const out: FakeElement[] = [];
  const walk = (n: FakeElement): void => {
    if (n.hasAttribute(attr)) out.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return out;
};

const findByAttrValue = (
  root: FakeElement,
  attr: string,
  value: string,
): FakeElement | null => {
  if (root.hasAttribute(attr) && root.getAttribute(attr) === value) return root;
  for (const c of root.children) {
    const hit = findByAttrValue(c, attr, value);
    if (hit) return hit;
  }
  return null;
};

// ──────────────────────────────────────────────────────────────────
// Builders
// ──────────────────────────────────────────────────────────────────

const baseManifest = (overrides: Partial<BulkPackManifest> = {}): BulkPackManifest => ({
  manifest_version: 1,
  slug: 'test-pack',
  publisher: 'recued-core',
  name: 'Test Pack',
  description: 'A pack for testing.',
  version: 1,
  recipes: [{ slug: 'recipe-a', version: 1 }],
  requires: ['install_bulk_pack'],
  tags: ['test'],
  ...overrides,
});

const baseEntry = (overrides: Partial<PackListEntry> = {}): PackListEntry => {
  const manifest = overrides.manifest ?? baseManifest();
  return {
    slug: manifest.slug,
    publisher: manifest.publisher,
    name: manifest.name,
    description: manifest.description,
    version: manifest.version,
    pre_install: manifest.pre_install === true,
    installed: false,
    requires: [...manifest.requires],
    recipe_count: manifest.recipes.length,
    body_visibility_grant_count:
      manifest.mcp_body_visibility_grants?.length ?? 0,
    manifest,
    ...overrides,
  };
};

const okUninstallResult = (): BulkPackUninstallResultLike => ({
  ok: true,
  removed: {
    recipes: ['recipe-a'],
    body_grants: [],
  },
});

const okInstallResult = (): BulkPackInstallResultLike => ({
  ok: true,
  installed: [
    {
      slug: 'recipe-a',
      publisher_id: 'recued-core',
      version: 1,
      fresh_install: true,
    },
  ],
  rolled_back: [],
});

// ──────────────────────────────────────────────────────────────────
// Setup helper
// ──────────────────────────────────────────────────────────────────

interface SetupOptions {
  runList?: PacksListCaller;
  runInstall?: PacksInstallCaller | null; // null -> omit
  runUninstall?: PacksUninstallCaller | null; // null -> omit
  /** Seed the DETAIL selection on mount (the panel is now detail-only).
   *  Defaults to the first pack in `initialPacks`. */
  initialSlug?: string;
}

interface SetupResult {
  host: FakeElement;
  doc: FakeDocument;
  mount: ReturnType<typeof mountPacksPanel>;
  listCalls: Array<undefined>;
  uninstallCalls: Array<{ pack_slug: string }>;
  installCalls: Array<{ manifest: unknown; granted_permissions: ReadonlyArray<string> }>;
  swapPacks(next: ReadonlyArray<PackListEntry>): void;
}

const setupMount = (
  initialPacks: ReadonlyArray<PackListEntry> = [],
  overrides: SetupOptions = {},
): SetupResult => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const listCalls: Array<undefined> = [];
  const uninstallCalls: SetupResult['uninstallCalls'] = [];
  const installCalls: SetupResult['installCalls'] = [];
  let currentPacks: ReadonlyArray<PackListEntry> = initialPacks;

  const defaultRunList: PacksListCaller = async () => {
    listCalls.push(undefined);
    return { packs: currentPacks };
  };

  const defaultRunInstall: PacksInstallCaller = async (args) => {
    installCalls.push(args);
    return { result: okInstallResult() };
  };

  const defaultRunUninstall: PacksUninstallCaller = async (args) => {
    uninstallCalls.push(args);
    return { result: okUninstallResult() };
  };

  // The panel is now the DETAIL only (the browse list moved to the surface).
  // Auto-open the first pack's detail so the shared-machinery seams reach the
  // detail. These stale-load tests load packs via the async queue (empty
  // `initialPacks`), so no detail is selected — the guard is verified via the
  // committed roster (`getPacks`), not rendered rows.
  const autoSlug = overrides.initialSlug ?? initialPacks[0]?.slug;
  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList: overrides.runList ?? defaultRunList,
    ...(autoSlug !== undefined ? { initialSlug: autoSlug } : {}),
    ...(overrides.runInstall === null
      ? {}
      : { runInstall: overrides.runInstall ?? defaultRunInstall }),
    ...(overrides.runUninstall === null
      ? {}
      : { runUninstall: overrides.runUninstall ?? defaultRunUninstall }),
  });

  return {
    host,
    doc,
    mount,
    listCalls,
    installCalls,
    uninstallCalls,
    swapPacks: (next) => {
      currentPacks = next;
    },
  };
};

// ──────────────────────────────────────────────────────────────────
// Slice H helpers
// ──────────────────────────────────────────────────────────────────

type ListResult = Awaited<ReturnType<PacksListCaller>>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const listResult = (
  packs: ReadonlyArray<PackListEntry>,
): ListResult => ({ packs });

const packEntry = (slug: string, installed = false): PackListEntry =>
  baseEntry({
    slug,
    installed,
    manifest: baseManifest({
      slug,
      name: slug,
      description: `${slug} description`,
    }),
  });

const makeQueuedRunList = () => {
  const steps: Array<() => Promise<ListResult>> = [];
  const calls: number[] = [];
  const runList: PacksListCaller = () => {
    calls.push(calls.length + 1);
    const step = steps.shift();
    if (step === undefined) {
      return Promise.reject(new Error(`unexpected packs.list call ${calls.length}`));
    }
    return step();
  };
  return {
    runList,
    calls,
    push: (step: () => Promise<ListResult>) => {
      steps.push(step);
    },
    pushValue: (packs: ReadonlyArray<PackListEntry>) => {
      steps.push(() => Promise.resolve(listResult(packs)));
    },
    pushError: (message: string) => {
      steps.push(() => Promise.reject(new Error(message)));
    },
    pushDeferred: (next: Deferred<ListResult>) => {
      steps.push(() => next.promise);
    },
  };
};

const setupLoadedQueuedMount = async (
  initialPacks: ReadonlyArray<PackListEntry> = [packEntry('seed-pack')],
) => {
  const queue = makeQueuedRunList();
  queue.pushValue(initialPacks);
  const mounted = setupMount([], { runList: queue.runList });
  await mounted.mount.whenLoaded();
  expect(mounted.mount.getState()).toBe('ready');
  return { ...mounted, queue };
};

const renderedSlugs = (host: FakeElement): string[] =>
  findAllByAttr(host, PACKS_ROW_SLUG_ATTR).map((row) =>
    row.getAttribute(PACKS_ROW_SLUG_ATTR) ?? '',
  );

const expectPanelRows = (
  mount: ReturnType<typeof mountPacksPanel>,
  host: FakeElement,
  slugs: ReadonlyArray<string>,
): void => {
  // The panel is now the `#packs/<slug>` DETAIL only — no list rows. These
  // stale-load tests never select a pack, so the authoritative "which load
  // won" signal is the roster the panel committed (`getPacks`), not rendered
  // rows. The detail surface renders zero pack rows regardless.
  expect(mount.getState()).toBe('ready');
  expect(mount.getPacks().map((p) => p.slug)).toEqual(slugs);
  expect(renderedSlugs(host)).toEqual([]);
};

const expectPanelLoading = (
  mount: ReturnType<typeof mountPacksPanel>,
  host: FakeElement,
): void => {
  expect(mount.getState()).toBe('loading');
  const wrapper = findByAttr(host, PACKS_PANEL_ATTR);
  expect(wrapper?.getAttribute(PACKS_PANEL_STATE_ATTR)).toBe('loading');
  expect(renderedSlugs(host)).toEqual([]);
};

// ==================================================================
// Group 1 - Two-kick race, newer resolves first
// ==================================================================

describe('D-145 Slice H packs panel - newer refresh wins', () => {
  it('drops stale success after a newer successful refresh paints', async () => {
    const { host, mount, queue } = await setupLoadedQueuedMount();
    const stale = deferred<ListResult>();
    queue.pushDeferred(stale);
    mount.refresh();
    expectPanelLoading(mount, host);

    queue.pushValue([packEntry('fresh-pack')]);
    mount.refresh();
    await mount.whenLoaded();
    expectPanelRows(mount, host, ['fresh-pack']);

    stale.resolve(listResult([packEntry('stale-pack')]));
    await flush();
    expectPanelRows(mount, host, ['fresh-pack']);
  });

  it('drops stale throw after a newer successful refresh paints', async () => {
    const { host, mount, queue } = await setupLoadedQueuedMount();
    const stale = deferred<ListResult>();
    queue.pushDeferred(stale);
    mount.refresh();

    queue.pushValue([packEntry('fresh-pack')]);
    mount.refresh();
    await mount.whenLoaded();
    expectPanelRows(mount, host, ['fresh-pack']);

    stale.reject(new Error('stale failure'));
    await flush();
    expect(mount.getListError()).toBeNull();
    expectPanelRows(mount, host, ['fresh-pack']);
  });

  it('stays loading until the freshest in-flight refresh resolves', async () => {
    const { host, mount, queue } = await setupLoadedQueuedMount();
    const stale = deferred<ListResult>();
    const fresh = deferred<ListResult>();
    queue.pushDeferred(stale);
    mount.refresh();
    queue.pushDeferred(fresh);
    mount.refresh();

    expectPanelLoading(mount, host);
    fresh.resolve(listResult([packEntry('fresh-pack')]));
    await mount.whenLoaded();
    expectPanelRows(mount, host, ['fresh-pack']);

    stale.resolve(listResult([packEntry('stale-pack')]));
    await flush();
    expectPanelRows(mount, host, ['fresh-pack']);
  });
});

// ==================================================================
// Group 2 - Two-kick race, older resolves first
// ==================================================================

describe('D-145 Slice H packs panel - older result cannot leak', () => {
  it('drops an immediately resolved older refresh when a newer kick starts before its microtask', async () => {
    const { host, mount, queue } = await setupLoadedQueuedMount();
    const fresh = deferred<ListResult>();

    queue.pushValue([packEntry('old-pack')]);
    mount.refresh();
    queue.pushDeferred(fresh);
    mount.refresh();

    await flush();
    expectPanelLoading(mount, host);
    expect(mount.getPacks().map((p) => p.slug)).toEqual(['seed-pack']);

    fresh.resolve(listResult([packEntry('fresh-pack')]));
    await mount.whenLoaded();
    expectPanelRows(mount, host, ['fresh-pack']);
  });

  it('drops a controlled older refresh that resolves before the newer one', async () => {
    const { host, mount, queue } = await setupLoadedQueuedMount();
    const old = deferred<ListResult>();
    const fresh = deferred<ListResult>();

    queue.pushDeferred(old);
    mount.refresh();
    queue.pushDeferred(fresh);
    mount.refresh();

    old.resolve(listResult([packEntry('old-pack')]));
    await flush();
    expectPanelLoading(mount, host);
    expect(mount.getPacks().map((p) => p.slug)).toEqual(['seed-pack']);

    fresh.resolve(listResult([packEntry('fresh-pack')]));
    await mount.whenLoaded();
    expectPanelRows(mount, host, ['fresh-pack']);
  });
});

// ==================================================================
// Group 3 - Three+ kicks
// ==================================================================

describe('D-145 Slice H packs panel - three refreshes', () => {
  it('keeps C data when A and B resolve after C', async () => {
    const { host, mount, queue } = await setupLoadedQueuedMount();
    const a = deferred<ListResult>();
    const b = deferred<ListResult>();
    queue.pushDeferred(a);
    mount.refresh();
    queue.pushDeferred(b);
    mount.refresh();
    queue.pushValue([packEntry('fresh-c')]);
    mount.refresh();

    await mount.whenLoaded();
    expectPanelRows(mount, host, ['fresh-c']);

    a.resolve(listResult([packEntry('stale-a')]));
    b.resolve(listResult([packEntry('stale-b')]));
    await flush();
    expectPanelRows(mount, host, ['fresh-c']);
  });
});

// ==================================================================
// Group 4 - Error path guard
// ==================================================================

describe('D-145 Slice H packs panel - error path guard', () => {
  it('drops an older error when a newer success is already in flight', async () => {
    const { host, mount, queue } = await setupLoadedQueuedMount();
    const fresh = deferred<ListResult>();

    queue.pushError('older failure');
    mount.refresh();
    queue.pushDeferred(fresh);
    mount.refresh();

    await flush();
    expectPanelLoading(mount, host);
    expect(mount.getListError()).toBeNull();

    fresh.resolve(listResult([packEntry('fresh-pack')]));
    await mount.whenLoaded();
    expect(mount.getListError()).toBeNull();
    expectPanelRows(mount, host, ['fresh-pack']);
  });

  it('lets the newest error win over an older pending success', async () => {
    const { host, mount, queue } = await setupLoadedQueuedMount();
    const oldSuccess = deferred<ListResult>();

    queue.pushDeferred(oldSuccess);
    mount.refresh();
    queue.pushError('newest failure');
    mount.refresh();
    await mount.whenLoaded();

    expect(mount.getState()).toBe('error');
    expect(mount.getListError()).toBe('newest failure');
    expect(findByAttr(host, PACKS_ROW_SLUG_ATTR)).toBeNull();

    oldSuccess.resolve(listResult([packEntry('old-success')]));
    await flush();
    expect(mount.getState()).toBe('error');
    expect(mount.getListError()).toBe('newest failure');
  });
});

// ==================================================================
// Group 5 - Counter scope
// ==================================================================

describe('D-145 Slice H packs panel - mount-local counter scope', () => {
  it('does not let panel 2 invalidate panel 1 initial load', async () => {
    const panel1Queue = makeQueuedRunList();
    const panel1Load = deferred<ListResult>();
    panel1Queue.pushDeferred(panel1Load);
    const panel1 = setupMount([], { runList: panel1Queue.runList });

    const panel2Queue = makeQueuedRunList();
    panel2Queue.pushValue([packEntry('panel-2-pack')]);
    const panel2 = setupMount([], { runList: panel2Queue.runList });
    await panel2.mount.whenLoaded();
    expectPanelRows(panel2.mount, panel2.host, ['panel-2-pack']);

    panel1Load.resolve(listResult([packEntry('panel-1-pack')]));
    await panel1.mount.whenLoaded();
    expectPanelRows(panel1.mount, panel1.host, ['panel-1-pack']);
  });
});

// ==================================================================
// Group 6 - Dispose interaction
// ==================================================================

describe('D-145 Slice H packs panel - dispose interaction', () => {
  it('does not write state when a hung refresh resolves after dispose', async () => {
    const queue = makeQueuedRunList();
    const hung = deferred<ListResult>();
    queue.pushDeferred(hung);
    const { host, mount } = setupMount([], { runList: queue.runList });

    mount.dispose();
    hung.resolve(listResult([packEntry('post-dispose')]));
    await mount.whenLoaded();
    expect(findByAttr(host, PACKS_PANEL_ATTR)).toBeNull();
    expect(mount.getState()).toBe('loading');
    expect(mount.getPacks()).toEqual([]);
  });

  it('does not write state when multiple hung refreshes resolve after dispose', async () => {
    const { host, mount, queue } = await setupLoadedQueuedMount();
    const a = deferred<ListResult>();
    const b = deferred<ListResult>();
    queue.pushDeferred(a);
    mount.refresh();
    queue.pushDeferred(b);
    mount.refresh();

    mount.dispose();
    a.resolve(listResult([packEntry('post-dispose-a')]));
    b.resolve(listResult([packEntry('post-dispose-b')]));
    await mount.whenLoaded();
    await flush();

    expect(findByAttr(host, PACKS_PANEL_ATTR)).toBeNull();
    expect(mount.getState()).toBe('loading');
    expect(mount.getPacks().map((p) => p.slug)).toEqual(['seed-pack']);
  });
});

// ==================================================================
// Group 7 - Existing call-site compat
// ==================================================================

describe('D-145 Slice H packs panel - whenLoaded tracks latest refresh', () => {
  it('whenLoaded resolves after the latest refresh promise settles', async () => {
    const { host, mount, queue } = await setupLoadedQueuedMount();
    const firstRefresh = deferred<ListResult>();

    queue.pushDeferred(firstRefresh);
    mount.refresh();
    queue.pushValue([packEntry('second-refresh')]);
    mount.refresh();

    await mount.whenLoaded();
    expectPanelRows(mount, host, ['second-refresh']);

    firstRefresh.resolve(listResult([packEntry('first-refresh')]));
    await flush();
    expectPanelRows(mount, host, ['second-refresh']);
  });
});
