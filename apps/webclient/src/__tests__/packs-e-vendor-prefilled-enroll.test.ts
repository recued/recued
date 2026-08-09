import { describe, expect, it, vi } from 'vitest';
import type { ConnectionHealth, ConnectionView, PackListEntry } from '@recued/contracts';
import {
  buildConnectionEditDialogPatch,
  projectConnectionPayload,
  resolveConnectionSchema,
  BLUESKY_API_BASE,
  TAVILY_API_BASE,
} from '@recued/ui-shared';

import {
  bootstrapConnectionsRoute,
} from '../connections/bootstrap-connections-route.js';
import {
  mountConnectionsEnrollPanel,
  type ConnectionsDeleteCaller,
  type ConnectionsEnrollCaller,
  type ConnectionsEnrollListCaller,
  type ConnectionsProbeCaller,
  type ConnectionsUpdateCaller,
} from '../settings/connections-enroll-panel.js';

// ════════════════════════════════════════════════════════════════
// String-innerHTML fake DOM, cribbed from the neighboring connection tests.
// ════════════════════════════════════════════════════════════════

interface FakeEl {
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

interface FakeDoc {
  styleElements: FakeEl[];
  head: { querySelector(sel: string): FakeEl | null; appendChild(el: FakeEl): FakeEl };
  createElement(tag: string): FakeEl;
}

const SUBMIT_SELECTORS = new Set([
  '[data-action="connections-submit-form"]',
  '[data-action="accounts-submit-form"]',
]);

const makeSubmitButton = (): FakeEl => {
  const button = makeFakeEl('button');
  button.querySelector = () => null;
  return button;
};

const makeFakeEl = (tag: string): FakeEl => {
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

const makeFakeDocument = (): FakeDoc => {
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

const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const fire = (host: FakeEl, type: string, ev: unknown): void => {
  for (const fn of [...(host.listeners.get(type) ?? [])]) fn(ev);
};

const clickAction = (host: FakeEl, data: Record<string, string>): void => {
  const el = { dataset: data, closest: () => el };
  fire(host, 'click', { target: el, preventDefault() {} });
};

const field = (
  host: FakeEl,
  key: string,
  value: string,
  tagName = 'INPUT',
): void => {
  const el = { dataset: { connField: key }, value, tagName, closest: () => el };
  const type = tagName === 'SELECT' ? 'change' : 'input';
  fire(host, type, { target: el, type });
};

const connection = (
  name: string,
  over: Partial<ConnectionView> = {},
): ConnectionView => ({
  name,
  kind: 'api',
  display_name: name,
  ...over,
});

const httpIngredient = (slug: string, connName: string): unknown => ({
  slug,
  kind: 'http',
  http: { base: 'https://api.example.test', connection: connName },
});

const op = (
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

const installedPackWith = (
  ingredients: unknown[],
  operations: unknown[],
): PackListEntry =>
  ({
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
    manifest: {
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
    },
  }) as unknown as PackListEntry;

interface MountOpts {
  connections?: ReadonlyArray<ConnectionView>;
  initialVendor?: string;
  runList?: ConnectionsEnrollListCaller;
  runPacksList?: () => Promise<{ packs: ReadonlyArray<PackListEntry> }>;
}

const makeEnrollCallers = (opts: MountOpts = {}) => {
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

const mountPanel = (opts: MountOpts = {}) => {
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
  });
  return { doc, host, panel, calls: callers };
};

describe('packs item E — vendor-prefilled connection enroll deep link', () => {
  it('⛔⛔⛔ the deep-linked enroll form carries THIS origin\'s callback URL', async () => {
    /** `#connections/others/enroll/<vendor>` — where the packs "Set up" CTA lands.
     *  It opens through `openVendorEnrollForm`, which MUTATES the dialog field by
     *  field instead of rebuilding it, and its hand-written list never included the
     *  callback fields. The renderer falls back to the cloud URL on an unset field,
     *  so this form told the owner to register `https://app.recued.com/oauth-callback`
     *  while they were on `http://localhost:7891` — a URL the flow does not send and
     *  the provider cannot match. The re-authorize dialog REBUILDS its state and so
     *  showed the correct one: the same screen disagreeing with itself, which is what
     *  made it read as a caching problem rather than a code one.
     *  ⚠ Asserted on the DIALOG STATE, not the HTML, so the fallback in the renderer
     *  cannot mask an unset field — that fallback is exactly what hid this. */
    /** ⚠ The resolver reads `globalThis.location.origin` and falls back to the cloud
     *  URL off-browser — correctly. Without an origin here the test would "reproduce"
     *  the bug for an environment reason and pass on a fix that changed nothing, so
     *  the origin is supplied and restored. */
    const priorLocation = (globalThis as { location?: unknown }).location;
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'http://localhost:7891' }, configurable: true, writable: true,
    });
    const { panel } = mountPanel({ initialVendor: 'onedrive' });
    await panel.whenLoaded();
    await flush();

    const { dialog } = panel.getState();
    if (priorLocation === undefined) {
      delete (globalThis as { location?: unknown }).location;
    } else {
      Object.defineProperty(globalThis, 'location', {
        value: priorLocation, configurable: true, writable: true,
      });
    }
    expect(dialog.stage).toBe('form');
    expect(dialog.oauthCallbackUrl,
      'the deep-linked form must resolve a callback URL, not leave it unset')
      .toBeDefined();
    expect(dialog.oauthCallbackUrl,
      'and it must NOT be the cloud callback while on a loopback origin')
      .not.toBe('https://app.recued.com/oauth-callback');
    expect(dialog.oauthCallbackUrl).toBe(
      'http://localhost:7891/webclient/oauth-callback.html');
    /** ⚠ The alternate must be the OTHER one, so "register both" names a real pair. */
    expect(dialog.oauthCallbackAlternateUrl).toBe('https://app.recued.com/oauth-callback');
    panel.dispose();
  });

  it('auto-opens a registered HubSpot vendor form from initialVendor', async () => {
    const { panel } = mountPanel({ initialVendor: 'hubspot' });

    await panel.whenLoaded();
    await flush();

    const { dialog } = panel.getState();
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('api');
    expect(dialog.vendor).toBe('hubspot');
    expect(dialog.values['config.vendor']).toBe('hubspot');
    panel.dispose();
  });

  it('auto-opens the registered OneDrive vendor form from initialVendor (D-192 interim enroll)', async () => {
    // The `#connections/others/enroll/onedrive` deep link — makes the already-
    // shipped OneDrive file-source leaf user-reachable. Seeds the locked hidden
    // config.vendor + base_url + token_endpoint from ONEDRIVE_SCHEMA_INITIAL_VALUES.
    const { panel } = mountPanel({ initialVendor: 'onedrive' });

    await panel.whenLoaded();
    await flush();

    const { dialog } = panel.getState();
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('api');
    expect(dialog.vendor).toBe('onedrive');
    expect(dialog.values['config.vendor']).toBe('onedrive');
    expect(dialog.values['config.base_url']).toBe('https://graph.microsoft.com/v1.0');
    expect(dialog.values['auth.token_endpoint']).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    );
    panel.dispose();
  });

  it('auto-opens Tavily with its fixed API origin and bearer mode prefilled', async () => {
    const { panel } = mountPanel({ initialVendor: 'tavily' });

    await panel.whenLoaded();
    await flush();

    const { dialog } = panel.getState();
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('api');
    expect(dialog.vendor).toBe('tavily');
    expect(dialog.values.name).toBe('tavily');
    expect(dialog.values['config.vendor']).toBe('tavily');
    expect(dialog.values['config.base_url']).toBe(TAVILY_API_BASE);
    expect(dialog.values['auth.type']).toBe('bearer');
    panel.dispose();
  });

  it('auto-opens Bluesky with AT Protocol session auth, not generic bearer', async () => {
    const { panel } = mountPanel({ initialVendor: 'bluesky' });

    await panel.whenLoaded();
    await flush();

    const { dialog } = panel.getState();
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('api');
    expect(dialog.vendor).toBe('bluesky');
    expect(dialog.values['config.vendor']).toBe('bluesky');
    expect(dialog.values['config.base_url']).toBe(BLUESKY_API_BASE);
    expect(dialog.values['auth.type']).toBe('atproto_session');
    panel.dispose();
  });

  it('waits for packs.list before pre-filling registered vendor scopes', async () => {
    const pack = installedPackWith(
      [httpIngredient('hubspot-catalog', 'hubspot')],
      [op('deal.read', 'hubspot-catalog', ['crm.objects.deals.read'])],
    );
    const { panel } = mountPanel({
      initialVendor: 'hubspot',
      runPacksList: async () => ({ packs: [pack] }),
    });

    await panel.whenLoaded();
    await flush();

    const scopes = (panel.getState().dialog.values['auth.scopes'] ?? '').split(/\s+/);
    expect(scopes).toContain('crm.objects.deals.read');
    panel.dispose();
  });

  it('auto-opens an unregistered API-key vendor as a bare api form', async () => {
    const { panel } = mountPanel({ initialVendor: 'stripe' });

    await panel.whenLoaded();
    await flush();

    const { dialog } = panel.getState();
    expect(dialog.stage).toBe('form');
    expect(dialog.kind).toBe('api');
    expect(dialog.vendor).toBeNull();
    expect(dialog.values.name).toBe('stripe');
    expect(dialog.values['config.vendor']).toBe('stripe');
    expect(dialog.values['auth.type']).toBe('bearer');
    panel.dispose();
  });

  it('projects the unregistered vendor tag on submit', async () => {
    const { host, panel, calls } = mountPanel({ initialVendor: 'stripe' });
    await panel.whenLoaded();
    await flush();

    field(host, 'display_name', 'Stripe');
    field(host, 'config.base_url', 'https://api.stripe.com');
    field(host, 'auth.token', 'sk_test');
    clickAction(host, { action: 'connections-submit-form' });
    await flush();

    expect(calls.runEnroll).toHaveBeenCalledTimes(1);
    const payload = calls.runEnroll.mock.calls[0]![0];
    expect(payload.name).toBe('stripe');
    expect(payload.kind).toBe('api');
    expect(payload.config.vendor).toBe('stripe');
    panel.dispose();
  });

  it('keeps bare api enroll inert when no initialVendor seeded config.vendor', async () => {
    const { host, panel, calls } = mountPanel();
    await panel.whenLoaded();

    clickAction(host, { action: 'connections-open-add' });
    clickAction(host, { action: 'connections-pick-kind', kind: 'api' });
    field(host, 'name', 'my-api');
    field(host, 'display_name', 'My API');
    field(host, 'config.base_url', 'https://api.example.com');
    field(host, 'auth.token', 'secret');
    clickAction(host, { action: 'connections-submit-form' });
    await flush();

    expect(calls.runEnroll).toHaveBeenCalledTimes(1);
    const payload = calls.runEnroll.mock.calls[0]![0];
    expect(payload.config).not.toHaveProperty('vendor');
    panel.dispose();
  });

  it('ignores an invalid initialVendor segment', async () => {
    const { panel } = mountPanel({ initialVendor: 'Not$Valid' });

    await panel.whenLoaded();
    await flush();

    expect(panel.getState().dialog.stage).toBe('closed');
    panel.dispose();
  });

  it('does not clobber user dialog navigation that wins the load race', async () => {
    const list = deferred<{ connections: ReadonlyArray<ConnectionView> }>();
    const { host, panel } = mountPanel({
      initialVendor: 'stripe',
      runList: () => list.promise,
    });

    clickAction(host, { action: 'connections-open-add' });
    expect(panel.getState().dialog.stage).toBe('kind-picker');
    list.resolve({ connections: [] });
    await panel.whenLoaded();
    await flush();

    expect(panel.getState().dialog.stage).toBe('kind-picker');
    panel.dispose();
  });

  it('forwards initialEnrollVendor only to the Others enroll panel', async () => {
    const doc = makeFakeDocument();
    const root = doc.createElement('div');
    const callers = makeEnrollCallers();
    const route = bootstrapConnectionsRoute({
      root: root as unknown as HTMLElement,
      document: doc as unknown as Document,
      initialTab: 'others',
      initialEnrollVendor: 'stripe',
      connectionsEnrollListCaller: callers.runList,
      connectionsEnrollCaller: callers.runEnroll,
      connectionsUpdateCaller: callers.runUpdate,
      connectionsDeleteCaller: callers.runDelete,
      connectionsProbeCaller: callers.runProbe,
    });

    expect(route.connectionsEnrollPanel()).not.toBeNull();
    await route.connectionsEnrollPanel()!.whenLoaded();
    await flush();
    expect(route.connectionsEnrollPanel()!.getState().dialog.stage).toBe('form');
    expect(route.connectionsEnrollPanel()!.getState().dialog.values['config.vendor'])
      .toBe('stripe');
    route.dispose();

    const mailDoc = makeFakeDocument();
    const mailRoot = mailDoc.createElement('div');
    const mailRoute = bootstrapConnectionsRoute({
      root: mailRoot as unknown as HTMLElement,
      document: mailDoc as unknown as Document,
      initialTab: 'mail',
      initialEnrollVendor: 'stripe',
      mail: {
        list: vi.fn(async () => ({ instances: [] })),
        enrollImap: vi.fn(async () => ({ slug: 'mail', send_capable: true })),
        delete: vi.fn(async () => ({ ok: true as const })),
      },
      connectionsEnrollListCaller: callers.runList,
      connectionsEnrollCaller: callers.runEnroll,
      connectionsUpdateCaller: callers.runUpdate,
      connectionsDeleteCaller: callers.runDelete,
      connectionsProbeCaller: callers.runProbe,
    });

    expect(mailRoute.connectionsEnrollPanel()).toBeNull();
    mailRoute.dispose();
  });

  it('round-trips config.vendor for an unregistered vendor edit patch', () => {
    const patch = buildConnectionEditDialogPatch({
      name: 'my-stripe',
      kind: 'api',
      display_name: 'Stripe',
      vendor: 'stripe',
      base_url: 'https://api.stripe.com',
    } as ConnectionView);

    expect(patch.vendor).toBeNull();
    const schema = resolveConnectionSchema(patch.kind, patch.subtype ?? undefined);
    expect(schema).toBeDefined();
    const payload = projectConnectionPayload(
      schema!,
      patch.values,
      patch.kind,
      patch.subtype,
    );

    expect(payload.name).toBe('my-stripe');
    expect(payload.config.vendor).toBe('stripe');
    expect(payload.config.vendor).not.toBe('my-stripe');
  });
});
