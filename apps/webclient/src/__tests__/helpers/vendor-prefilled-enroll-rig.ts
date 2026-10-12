/** The connections enroll panel on a string-innerHTML fake DOM, for the vendor
 *  prefilled enroll tests. Its own module so a case that reads a shipped pack lives
 *  in a `-corpus` file (the public export omits any test reading `community/`, whole)
 *  while the rest ship. */
import { vi } from 'vitest';
import {
  requiredScopesByConnection,
  type BulkPackManifest,
  type ConnectionHealth,
  type ConnectionView,
  type PackListEntry,
} from '@recued/contracts';

import {
  mountConnectionsEnrollPanel,
  type ConnectionsDeleteCaller,
  type ConnectionsEnrollCaller,
  type ConnectionsEnrollListCaller,
  type ConnectionsProbeCaller,
  type ConnectionsUpdateCaller,
} from '../../settings/connections-enroll-panel.js';

// ════════════════════════════════════════════════════════════════
// String-innerHTML fake DOM, cribbed from the neighboring connection tests.
// ════════════════════════════════════════════════════════════════

export interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  value: string;
  innerHTML: string;
  attrs: Map<string, string>;
  children: FakeEl[];
  parent: FakeEl | null;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev: unknown) => void): void;
  removeEventListener(type: string, fn: (ev: unknown) => void): void;
  contains(el: unknown): boolean;
  querySelector(sel: string): FakeEl | null;
  click(): void;
  remove(): void;
}

export interface FakeDoc {
  styleElements: FakeEl[];
  head: { querySelector(sel: string): FakeEl | null; appendChild(el: FakeEl): FakeEl };
  createElement(tag: string): FakeEl;
}

export const SUBMIT_SELECTORS = new Set([
  '[data-action="connections-submit-form"]',
  '[data-action="accounts-submit-form"]',
]);

export const makeSubmitButton = (): FakeEl => {
  const button = makeFakeEl('button');
  button.querySelector = () => null;
  return button;
};

export const makeFakeEl = (tag: string): FakeEl => {
  let submitButton: FakeEl | null = null;
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    value: '',
    innerHTML: '',
    attrs: new Map(),
    children: [],
    parent: null,
    listeners: new Map(),
    get firstChild() {
      return el.children[0] ?? null;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
      if (k === 'disabled') el.disabled = true;
    },
    removeAttribute(k) {
      el.attrs.delete(k);
      if (k === 'disabled') el.disabled = false;
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    removeChild(c) {
      const idx = el.children.indexOf(c);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      c.parent = null;
      return c;
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = el.listeners.get(type);
      if (list === undefined) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    contains() {
      return true;
    },
    querySelector(sel) {
      if (!SUBMIT_SELECTORS.has(sel)) return null;
      submitButton ??= makeSubmitButton();
      return submitButton;
    },
    click() {
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    remove() {
      if (el.parent !== null) el.parent.removeChild(el);
    },
  };
  return el;
};

export const makeFakeDocument = (): FakeDoc => {
  const styleElements: FakeEl[] = [];
  const matchSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    styleElements,
    head: {
      querySelector(sel) {
        const parsed = matchSelector(sel);
        if (parsed === null) return null;
        return (
          styleElements.find(
            (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
          ) ?? null
        );
      },
      appendChild(el) {
        styleElements.push(el);
        return el;
      },
    },
    createElement: (tag) => makeFakeEl(tag),
  };
};

export const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

export const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

export const fire = (host: FakeEl, type: string, ev: unknown): void => {
  for (const fn of [...(host.listeners.get(type) ?? [])]) fn(ev);
};

export const clickAction = (host: FakeEl, data: Record<string, string>): void => {
  const el = { dataset: data, closest: () => el };
  fire(host, 'click', { target: el, preventDefault() {} });
};

export const field = (
  host: FakeEl,
  key: string,
  value: string,
  tagName = 'INPUT',
): void => {
  const el = { dataset: { connField: key }, value, tagName, closest: () => el };
  const type = tagName === 'SELECT' ? 'change' : 'input';
  fire(host, type, { target: el, type });
};

export const connection = (
  name: string,
  over: Partial<ConnectionView> = {},
): ConnectionView => ({
  name,
  kind: 'api',
  display_name: name,
  ...over,
});

export const httpIngredient = (slug: string, connName: string): unknown => ({
  slug,
  kind: 'http',
  http: { base: 'https://api.example.test', connection: connName },
});

export const op = (
  opId: string,
  ingredient: string,
  required_scopes?: string[],
): unknown => ({
  op: opId,
  ingredient,
  risk: 'read',
  approval: 'never',
  bind: { method: 'GET', path: '/' },
  ...(required_scopes !== undefined ? { required_scopes } : {}),
});

/** An installed pack as `packs.list` sends it: no manifest (`b06752cc9`), and
 *  the scopes per connection slot the server lifts from it with this helper. */
export const installedPackWith = (
  ingredients: unknown[],
  operations: unknown[],
): PackListEntry => {
  const manifest = {
    contents: [
      {
        type: 'composition',
        composition: {
          schema_version: 1,
          slug: 'c',
          ingredients,
          operations,
        },
      },
    ],
  } as unknown as BulkPackManifest;
  const scopes = requiredScopesByConnection(manifest);
  return ({
    slug: 'p',
    publisher: 'recued-core',
    name: 'P',
    description: 'P',
    version: 1,
    pre_install: false,
    installed: true,
    requires: [],
    recipe_count: 0,
    body_visibility_grant_count: 0,
    ...(Object.keys(scopes).length > 0 ? { required_scopes_by_connection: scopes } : {}),
  }) as unknown as PackListEntry;
};

export interface MountOpts {
  connections?: ReadonlyArray<ConnectionView>;
  initialVendor?: string;
  initialPack?: { slug: string; slot?: string };
  runList?: ConnectionsEnrollListCaller;
  runPacksList?: () => Promise<{ packs: ReadonlyArray<PackListEntry> }>;
}

export const makeEnrollCallers = (opts: MountOpts = {}) => {
  const runList = vi.fn<ConnectionsEnrollListCaller>();
  runList.mockImplementation(
    opts.runList ?? (async () => ({ connections: opts.connections ?? [] })),
  );
  const runEnroll = vi.fn<ConnectionsEnrollCaller>();
  runEnroll.mockImplementation(async (args) => ({
    connection: connection(args.name, {
      kind: args.kind,
      display_name: args.display_name,
    }),
    probe: { status: 'ok' } as ConnectionHealth,
  }));
  const runUpdate = vi.fn<ConnectionsUpdateCaller>();
  runUpdate.mockImplementation(async (args) => ({
    connection: connection(args.name, { kind: args.kind }),
  }));
  const runDelete = vi.fn<ConnectionsDeleteCaller>();
  runDelete.mockImplementation(async () => ({ deleted: true }));
  const runProbe = vi.fn<ConnectionsProbeCaller>();
  runProbe.mockImplementation(async () => ({
    health: { status: 'ok' } as ConnectionHealth,
  }));
  return { runList, runEnroll, runUpdate, runDelete, runProbe };
};

export const mountPanel = (opts: MountOpts = {}) => {
  const doc = makeFakeDocument();
  const host = doc.createElement('div');
  const callers = makeEnrollCallers(opts);
  const panel = mountConnectionsEnrollPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runList: callers.runList,
    runEnroll: callers.runEnroll,
    runUpdate: callers.runUpdate,
    runDelete: callers.runDelete,
    runProbe: callers.runProbe,
    ...(opts.runPacksList !== undefined ? { runPacksList: opts.runPacksList } : {}),
    ...(opts.initialVendor !== undefined ? { initialVendor: opts.initialVendor } : {}),
    ...(opts.initialPack !== undefined ? { initialPack: opts.initialPack } : {}),
  });
  return { doc, host, panel, calls: callers };
};
