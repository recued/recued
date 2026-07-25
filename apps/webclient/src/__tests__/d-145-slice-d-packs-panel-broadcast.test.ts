/** D-145 PA10 follow-on Slice D - Settings -> Packs broadcast refresh. */

import { describe, expect, it } from 'vitest';

import type {
  BroadcastEventKind,
  BulkPackManifest,
  PackListEntry,
  ServerEvent,
} from '@recued/contracts';

import {
  WEBCLIENT_DEFAULT_SUBSCRIPTIONS,
  type BroadcastListener,
  type BroadcastSubscriber,
} from '../realtime/subscriber.js';
import {
  mountPacksPanel,
  type PacksListCaller,
} from '../settings/packs-panel.js';

type PackInstalledEvent = Extract<ServerEvent, { kind: 'pack_installed' }>;
type PackUninstalledEvent = Extract<ServerEvent, { kind: 'pack_uninstalled' }>;
type AnyListener = (event: ServerEvent) => void;

// ------------------------------------------------------------------
// Fake DOM (mirrors the PA10 packs-panel test harness shape)
// ------------------------------------------------------------------

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

// ------------------------------------------------------------------
// Broadcast fake
// ------------------------------------------------------------------

interface FakeSubscribeCall {
  kind: BroadcastEventKind;
  listener: AnyListener;
  unsubscribeCalls: number;
  unsubscribed: boolean;
}

interface FakeSubscribeOptions {
  throwOnUnsubscribe?: boolean;
}

const makeFakeSubscribe = (opts: FakeSubscribeOptions = {}) => {
  const calls: FakeSubscribeCall[] = [];
  const listeners = new Map<BroadcastEventKind, Set<AnyListener>>();

  const subscribe = (<K extends BroadcastEventKind>(
    kind: K,
    listener: BroadcastListener<K>,
  ): (() => void) => {
    const narrowed = listener as unknown as AnyListener;
    const call: FakeSubscribeCall = {
      kind,
      listener: narrowed,
      unsubscribeCalls: 0,
      unsubscribed: false,
    };
    calls.push(call);
    const set = listeners.get(kind) ?? new Set<AnyListener>();
    set.add(narrowed);
    listeners.set(kind, set);

    return () => {
      call.unsubscribeCalls += 1;
      call.unsubscribed = true;
      set.delete(narrowed);
      if (set.size === 0) listeners.delete(kind);
      if (opts.throwOnUnsubscribe) {
        throw new Error(`unsubscribe failed for ${kind}`);
      }
    };
  }) as BroadcastSubscriber['on'];

  const activeCount = (): number => {
    let total = 0;
    for (const set of listeners.values()) total += set.size;
    return total;
  };

  const dispatch = (event: ServerEvent): void => {
    const set = listeners.get(event.kind);
    if (!set) return;
    for (const listener of [...set]) listener(event);
  };

  const fireStored = (event: ServerEvent): void => {
    for (const call of calls) {
      if (call.kind === event.kind) call.listener(event);
    }
  };

  return { subscribe, calls, listeners, activeCount, dispatch, fireStored };
};

// ------------------------------------------------------------------
// Builders and setup
// ------------------------------------------------------------------

const baseManifest = (
  overrides: Partial<BulkPackManifest> = {},
): BulkPackManifest => ({
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

interface SetupOptions {
  runList?: PacksListCaller;
  subscribe?: BroadcastSubscriber['on'];
}

interface SetupResult {
  host: FakeElement;
  doc: FakeDocument;
  mount: ReturnType<typeof mountPacksPanel>;
  listCalls: Array<undefined>;
}

const setupMount = (
  initialPacks: ReadonlyArray<PackListEntry> = [baseEntry()],
  overrides: SetupOptions = {},
): SetupResult => {
  const host = makeFakeElement('div');
  const doc = makeFakeDocument();
  const listCalls: Array<undefined> = [];

  const defaultRunList: PacksListCaller = async () => {
    listCalls.push(undefined);
    return { packs: initialPacks };
  };

  const mount = mountPacksPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList: overrides.runList ?? defaultRunList,
    ...(overrides.subscribe ? { subscribe: overrides.subscribe } : {}),
  });

  return { host, doc, mount, listCalls };
};

const packInstalledEvent = (cursor = 1): PackInstalledEvent => ({
  kind: 'pack_installed',
  pack_slug: 'test-pack',
  pack_name: 'Test Pack',
  pack_version: 1,
  installed_recipe_count: 1,
  cursor,
});

const packUninstalledEvent = (cursor = 2): PackUninstalledEvent => ({
  kind: 'pack_uninstalled',
  pack_slug: 'test-pack',
  pack_name: 'Test Pack',
  pack_version: 1,
  removed_recipe_count: 1,
  cursor,
});

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('D-145 Slice D - webclient default pack subscriptions', () => {
  it('WEBCLIENT_DEFAULT_SUBSCRIPTIONS includes both pack broadcast kinds', () => {
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('pack_installed');
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain('pack_uninstalled');
  });
});

describe('D-145 Slice D - mountPacksPanel broadcast subscription', () => {
  it('mounts without subscribe and runs the list once', async () => {
    const { mount, listCalls } = setupMount();

    await mount.whenLoaded();

    expect(mount.getState()).toBe('ready');
    expect(listCalls).toHaveLength(1);
    mount.dispose();
  });

  it('subscribes to pack_installed and pack_uninstalled on mount', async () => {
    const fake = makeFakeSubscribe();
    const { mount } = setupMount([baseEntry()], {
      subscribe: fake.subscribe,
    });
    await mount.whenLoaded();

    expect(fake.listeners.get('pack_installed')?.size).toBe(1);
    expect(fake.listeners.get('pack_uninstalled')?.size).toBe(1);
    expect(fake.calls.map((call) => call.kind)).toEqual([
      'pack_installed',
      'pack_uninstalled',
    ]);
    mount.dispose();
  });

  it('refreshes rows when a pack_installed event fires', async () => {
    const fake = makeFakeSubscribe();
    const { mount, listCalls } = setupMount([baseEntry()], {
      subscribe: fake.subscribe,
    });
    await mount.whenLoaded();
    expect(listCalls).toHaveLength(1);

    fake.dispatch(packInstalledEvent());
    await mount.whenLoaded();

    expect(listCalls).toHaveLength(2);
    mount.dispose();
  });

  it('refreshes rows when a pack_uninstalled event fires', async () => {
    const fake = makeFakeSubscribe();
    const { mount, listCalls } = setupMount([baseEntry()], {
      subscribe: fake.subscribe,
    });
    await mount.whenLoaded();
    expect(listCalls).toHaveLength(1);

    fake.dispatch(packUninstalledEvent());
    await mount.whenLoaded();

    expect(listCalls).toHaveLength(2);
    mount.dispose();
  });

  it('dispose unsubscribes both subscription handles', async () => {
    const fake = makeFakeSubscribe();
    const { mount } = setupMount([baseEntry()], {
      subscribe: fake.subscribe,
    });
    await mount.whenLoaded();

    mount.dispose();

    expect(fake.activeCount()).toBe(0);
    expect(fake.calls.map((call) => call.unsubscribeCalls)).toEqual([1, 1]);
  });

  it('does not refresh when an event listener fires after dispose', async () => {
    const fake = makeFakeSubscribe();
    const { mount, listCalls } = setupMount([baseEntry()], {
      subscribe: fake.subscribe,
    });
    await mount.whenLoaded();

    mount.dispose();
    fake.fireStored(packInstalledEvent());
    fake.fireStored(packUninstalledEvent());
    await flush();

    expect(listCalls).toHaveLength(1);
  });

  it('dispose completes when unsubscribe handles throw', async () => {
    const fake = makeFakeSubscribe({ throwOnUnsubscribe: true });
    const { mount } = setupMount([baseEntry()], {
      subscribe: fake.subscribe,
    });
    await mount.whenLoaded();

    expect(() => mount.dispose()).not.toThrow();
    expect(fake.activeCount()).toBe(0);
    expect(fake.calls.map((call) => call.unsubscribeCalls)).toEqual([1, 1]);
  });

  it('multiple pack events in succession trigger multiple refreshes', async () => {
    const fake = makeFakeSubscribe();
    const { mount, listCalls } = setupMount([baseEntry()], {
      subscribe: fake.subscribe,
    });
    await mount.whenLoaded();
    expect(listCalls).toHaveLength(1);

    fake.dispatch(packInstalledEvent(10));
    fake.dispatch(packUninstalledEvent(11));
    await mount.whenLoaded();

    expect(listCalls).toHaveLength(3);
    mount.dispose();
  });
});
