import { describe, expect, it, vi } from 'vitest';

import {
  mountConnectionsGrantPanel,
  CONNECTIONS_GRANT_CARD_ATTR,
  CONNECTIONS_GRANT_GROUP_ERROR_ATTR,
  CONNECTIONS_GRANT_PANEL_EMPTY_ATTR,
  CONNECTIONS_GRANT_PANEL_ERROR_ATTR,
  CONNECTIONS_GRANT_PANEL_LOADING_ATTR,
  CONNECTIONS_GRANT_PANEL_STYLES,
  CONNECTIONS_GRANT_TOGGLE_ATTR,
  type ConnectionsGrantGroupCaller,
  type ConnectionsListCaller,
  type ConnectionsListGroupsCaller,
  type ConnectionsRevokeGroupCaller,
} from '../settings/connections-grant-panel.js';
import type {
  ConnectionView,
  OperationGroupGrantState,
  OperationGroupGrantView,
} from '@recued/contracts';

// ════════════════════════════════════════════════════════════════
// Interactive fake DOM
// ════════════════════════════════════════════════════════════════

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  type: string;
  disabled: boolean;
  hidden: boolean;
  attrs: Map<string, string>;
  children: FakeEl[];
  listeners: Map<string, Array<(ev?: unknown) => void>>;
  parent: FakeEl | null;
  readonly firstChild: FakeEl | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  removeEventListener(type: string, fn: (ev?: unknown) => void): void;
  contains(candidate: unknown): boolean;
  focus(options?: unknown): void;
  click(): void;
  remove(): void;
}

interface FakeDocument {
  readonly activeElement: FakeEl | null;
  createElement(tag: string): FakeEl;
  head: {
    appendChild(el: FakeEl): FakeEl;
    querySelector(selector: string): FakeEl | null;
  };
  styleTags: FakeEl[];
}

const makeFakeElement = (
  tag: string,
  onFocus: (el: FakeEl) => void,
): FakeEl => {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    disabled: false,
    hidden: false,
    attrs: new Map(),
    children: [],
    listeners: new Map(),
    parent: null,
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
    addEventListener(type, fn) {
      const list = el.listeners.get(type) ?? [];
      list.push(fn);
      el.listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = el.listeners.get(type);
      if (list === undefined) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    contains(candidate) {
      if (candidate === el) return true;
      return el.children.some((child) => child.contains(candidate));
    },
    focus() {
      onFocus(el);
    },
    click() {
      // A disabled button fires no click. The panel sets disabled by
      // attribute, so checking the attr keeps the fake honest.
      if (el.disabled || el.attrs.has('disabled')) return;
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
    },
  };
  return el;
};

const makeFakeDocument = (): FakeDocument => {
  const styleTags: FakeEl[] = [];
  let activeElement: FakeEl | null = null;
  const parseSelector = (sel: string): { tag: string; attr: string } | null => {
    const m = sel.match(/^([\w-]+)\[([\w-]+)\]$/);
    return m === null ? null : { tag: m[1]!.toUpperCase(), attr: m[2]! };
  };
  return {
    get activeElement() {
      return activeElement;
    },
    createElement(tag) {
      return makeFakeElement(tag, (el) => {
        activeElement = el;
      });
    },
    head: {
      appendChild(el) {
        styleTags.push(el);
        return el;
      },
      querySelector(selector) {
        const parsed = parseSelector(selector);
        if (parsed === null) return null;
        return (
          styleTags.find(
            (s) => s.tagName === parsed.tag && s.attrs.has(parsed.attr),
          ) ?? null
        );
      },
    },
    styleTags,
  };
};

const collectByAttr = (
  root: FakeEl,
  attr: string,
  out: FakeEl[] = [],
): FakeEl[] => {
  if (root.attrs.has(attr)) out.push(root);
  for (const c of root.children) collectByAttr(c, attr, out);
  return out;
};

const allText = (root: FakeEl, acc: string[] = []): string[] => {
  if (root.textContent) acc.push(root.textContent);
  for (const c of root.children) allText(c, acc);
  return acc;
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

const tick = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};

// ════════════════════════════════════════════════════════════════
// Fixtures + mount helper
// ════════════════════════════════════════════════════════════════

const DEALS_WRITE = 'recued-core/hubspot.deals.write';
const CONTACTS_WRITE = 'recued-core/hubspot.contacts.write';
const DEALS_READ = 'recued-core/hubspot.deals.read';
const LOCAL_TICKETS_WRITE = 'acme/support.tickets.write';

const operationFor = (groupId: string): string => {
  const slash = groupId.lastIndexOf('/');
  return slash >= 0 ? groupId.slice(slash + 1) : groupId;
};

const connection = (
  name: string,
  over: Partial<ConnectionView> = {},
): ConnectionView => ({
  name,
  kind: 'api',
  display_name: name,
  vendor: 'hubspot',
  ...over,
});

const group = (
  group_id: string,
  over: Partial<OperationGroupGrantState> = {},
): OperationGroupGrantState => ({
  group_id,
  operations: [operationFor(group_id)],
  risk_floor: group_id.endsWith('.read') ? 'read' : 'write',
  granted: false,
  ...over,
});

const grantView = (
  connectionName: string,
  groups: OperationGroupGrantState[],
  over: Partial<OperationGroupGrantView> = {},
): OperationGroupGrantView => ({
  connection_name: connectionName,
  granted_groups: groups.filter((g) => g.granted).map((g) => g.group_id),
  allowed_operations: groups
    .filter((g) => g.risk_floor === 'read' || g.granted)
    .flatMap((g) => g.operations),
  available_groups: groups,
  ...over,
});

type GroupFixture =
  | OperationGroupGrantView
  | Promise<OperationGroupGrantView>;

interface MountForOptions {
  connections?: ReadonlyArray<ConnectionView>;
  groupsByName?: Record<string, GroupFixture>;
  runListConnections?: ConnectionsListCaller;
  runListGroups?: ConnectionsListGroupsCaller;
  runGrant?: ConnectionsGrantGroupCaller;
  runRevoke?: ConnectionsRevokeGroupCaller;
}

const mountFor = (opts: MountForOptions = {}) => {
  const doc = makeFakeDocument();
  const host = doc.createElement('div');
  const groupsByName = opts.groupsByName ?? {};

  const runListConnections = vi.fn<ConnectionsListCaller>();
  runListConnections.mockImplementation(
    opts.runListConnections
      ?? (async () => ({ connections: opts.connections ?? [] })),
  );

  const runListGroups = vi.fn<ConnectionsListGroupsCaller>();
  runListGroups.mockImplementation(
    opts.runListGroups
      ?? (async ({ name }) => {
        const view = groupsByName[name];
        if (view === undefined) throw new Error(`missing groups for ${name}`);
        return view;
      }),
  );

  const runGrant = vi.fn<ConnectionsGrantGroupCaller>();
  runGrant.mockImplementation(
    opts.runGrant
      ?? (async ({ name }) => grantView(name, [])),
  );

  const runRevoke = vi.fn<ConnectionsRevokeGroupCaller>();
  runRevoke.mockImplementation(
    opts.runRevoke
      ?? (async ({ name }) => grantView(name, [])),
  );

  const mount = mountConnectionsGrantPanel({
    host: host as unknown as HTMLElement,
    document: doc as unknown as Document,
    runListConnections,
    runListGroups,
    runGrant,
    runRevoke,
  });

  return {
    doc,
    host,
    mount,
    calls: { runListConnections, runListGroups, runGrant, runRevoke },
  };
};

const cardFor = (root: FakeEl, connectionName: string): FakeEl => {
  const card = collectByAttr(root, CONNECTIONS_GRANT_CARD_ATTR).find(
    (c) => c.getAttribute('data-connection-name') === connectionName,
  );
  if (card === undefined) throw new Error(`missing card ${connectionName}`);
  return card;
};

const toggleFor = (
  root: FakeEl,
  groupId: string,
  connectionName?: string,
): FakeEl | undefined =>
  collectByAttr(root, CONNECTIONS_GRANT_TOGGLE_ATTR).find(
    (b) =>
      b.getAttribute('data-group-id') === groupId
      && (connectionName === undefined
        || b.getAttribute('data-connection-name') === connectionName),
  );

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

describe('D-165 Connections operation-group grant panel', () => {
  it('gives operation decisions a full action target', () => {
    expect(CONNECTIONS_GRANT_PANEL_STYLES).toMatch(
      /\.conn-grant-toggle\s*\{[^}]*min-height:\s*36px/s,
    );
  });

  it('contains long connection and operation identities without shrinking actions', () => {
    expect(CONNECTIONS_GRANT_PANEL_STYLES).toContain(
      '[data-recued-connections-grant-panel] {\n  box-sizing: border-box;\n  min-width: 0;\n  max-width: 100%;',
    );
    expect(CONNECTIONS_GRANT_PANEL_STYLES).toContain(
      '.conn-grant-display {\n  min-width: 0;\n  overflow-wrap: anywhere;',
    );
    expect(CONNECTIONS_GRANT_PANEL_STYLES).toContain(
      '.conn-grant-name {\n  min-width: 0;\n  max-width: 100%;\n  overflow-wrap: anywhere;',
    );
    expect(CONNECTIONS_GRANT_PANEL_STYLES).toContain(
      '.conn-grant-group-id {\n  min-width: 0;\n  overflow-wrap: anywhere;',
    );
    expect(CONNECTIONS_GRANT_PANEL_STYLES).toContain(
      '.conn-grant-group-ops {\n  min-width: 0;\n  overflow-wrap: anywhere;',
    );
    expect(CONNECTIONS_GRANT_PANEL_STYLES).toMatch(
      /\.conn-grant-toggle\s*\{[^}]*flex:\s*0 0 auto/s,
    );
  });

  it('renders loading, then one card per api connection with resolved groups', async () => {
    const list = deferred<{ connections: ReadonlyArray<ConnectionView> }>();
    const hsA = connection('hs-a', { display_name: 'HubSpot A' });
    const hsB = connection('hs-b', { display_name: 'HubSpot B' });
    const { host, mount, calls } = mountFor({
      runListConnections: () => list.promise,
      groupsByName: {
        'hs-a': grantView('hs-a', [group(DEALS_WRITE)]),
        'hs-b': grantView('hs-b', [group(CONTACTS_WRITE)]),
      },
    });

    expect(mount.getState()).toBe('loading');
    expect(collectByAttr(host, CONNECTIONS_GRANT_PANEL_LOADING_ATTR)).toHaveLength(1);
    expect(allText(host).join(' ')).toContain('Loading connections');

    list.resolve({ connections: [hsA, hsB] });
    await mount.whenLoaded();

    expect(mount.getState()).toBe('ready');
    expect(mount.getConnections()).toHaveLength(2);
    expect(collectByAttr(host, CONNECTIONS_GRANT_CARD_ATTR)).toHaveLength(2);
    expect(calls.runListGroups).toHaveBeenCalledTimes(2);
    expect(calls.runListGroups).toHaveBeenNthCalledWith(1, {
      name: 'hs-a',
      kind: 'api',
    });
    expect(calls.runListGroups).toHaveBeenNthCalledWith(2, {
      name: 'hs-b',
      kind: 'api',
    });
    mount.dispose();
  });

  it('reads groups for api connections, including local/private catalog candidates', async () => {
    const hubspot = connection('hs', { display_name: 'HubSpot' });
    const localCatalog = connection('support', {
      display_name: 'Local Support',
      vendor: 'custom',
    });
    const { host, mount, calls } = mountFor({
      connections: [
        hubspot,
        localCatalog,
        connection('mcp', {
          kind: 'mcp',
          subtype: 'sse',
          display_name: 'MCP',
        }),
        connection('notify', {
          kind: 'notification',
          subtype: 'slack',
          display_name: 'Slack',
        }),
      ],
      groupsByName: {
        hs: grantView('hs', [group(DEALS_WRITE)]),
        support: grantView('support', [group(LOCAL_TICKETS_WRITE)]),
      },
    });

    await mount.whenLoaded();

    const cards = collectByAttr(host, CONNECTIONS_GRANT_CARD_ATTR);
    expect(cards).toHaveLength(2);
    expect(cards[0]!.getAttribute('data-connection-name')).toBe('hs');
    expect(cards[1]!.getAttribute('data-connection-name')).toBe('support');
    expect(mount.getConnections().map((r) => r.connection.name)).toEqual(['hs', 'support']);
    expect(calls.runListGroups).toHaveBeenCalledTimes(2);
    expect(calls.runListGroups).toHaveBeenNthCalledWith(1, {
      name: 'hs',
      kind: 'api',
    });
    expect(calls.runListGroups).toHaveBeenNthCalledWith(2, {
      name: 'support',
      kind: 'api',
    });
    expect(toggleFor(host, LOCAL_TICKETS_WRITE, 'support')).toBeDefined();
    mount.dispose();
  });

  it('renders read groups as always allowed and write groups as toggles', async () => {
    const { host, mount } = mountFor({
      connections: [connection('hs', { display_name: 'HubSpot' })],
      groupsByName: {
        hs: grantView('hs', [
          group(DEALS_READ),
          group(DEALS_WRITE),
          group(CONTACTS_WRITE, { granted: true }),
        ]),
      },
    });

    await mount.whenLoaded();

    expect(allText(host).join(' ')).toContain('Always allowed');
    expect(toggleFor(host, DEALS_READ)).toBeUndefined();

    const grant = toggleFor(host, DEALS_WRITE)!;
    expect(grant.textContent).toBe('Grant');
    expect(grant.getAttribute('aria-label')).toBe(
      'Grant hubspot.deals.write for HubSpot (hs)',
    );
    expect(grant.getAttribute('aria-pressed')).toBe('false');
    expect(grant.getAttribute('data-granted')).toBe('false');

    const revoke = toggleFor(host, CONTACTS_WRITE)!;
    expect(revoke.textContent).toBe('Revoke');
    expect(revoke.getAttribute('aria-label')).toBe(
      'Revoke hubspot.contacts.write for HubSpot (hs)',
    );
    expect(revoke.getAttribute('aria-pressed')).toBe('true');
    expect(revoke.getAttribute('data-granted')).toBe('true');
    mount.dispose();
  });

  it('grant click writes the returned fresh view without re-listing groups', async () => {
    const oldView = grantView('hs', [group(DEALS_WRITE)]);
    const freshView = grantView('hs', [group(DEALS_WRITE, { granted: true })]);
    const { host, mount, calls } = mountFor({
      connections: [connection('hs')],
      groupsByName: { hs: oldView },
      runGrant: async () => freshView,
    });
    await mount.whenLoaded();

    toggleFor(host, DEALS_WRITE)!.click();
    await tick();

    expect(calls.runGrant).toHaveBeenCalledTimes(1);
    expect(calls.runGrant).toHaveBeenCalledWith({
      name: 'hs',
      kind: 'api',
      group_id: DEALS_WRITE,
    });
    expect(calls.runRevoke).not.toHaveBeenCalled();
    expect(calls.runListGroups).toHaveBeenCalledTimes(1);
    const toggle = toggleFor(host, DEALS_WRITE)!;
    expect(toggle.textContent).toBe('Revoke');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(toggle.getAttribute('data-granted')).toBe('true');
    mount.dispose();
  });

  it('revoke click calls revoke and flips the fresh view back to grant', async () => {
    const oldView = grantView('hs', [group(DEALS_WRITE, { granted: true })]);
    const freshView = grantView('hs', [group(DEALS_WRITE, { granted: false })]);
    const { host, mount, calls } = mountFor({
      connections: [connection('hs')],
      groupsByName: { hs: oldView },
      runRevoke: async () => freshView,
    });
    await mount.whenLoaded();

    toggleFor(host, DEALS_WRITE)!.click();
    await tick();

    expect(calls.runRevoke).toHaveBeenCalledTimes(1);
    expect(calls.runRevoke).toHaveBeenCalledWith({
      name: 'hs',
      kind: 'api',
      group_id: DEALS_WRITE,
    });
    expect(calls.runGrant).not.toHaveBeenCalled();
    const toggle = toggleFor(host, DEALS_WRITE)!;
    expect(toggle.textContent).toBe('Grant');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('data-granted')).toBe('false');
    mount.dispose();
  });

  it('serializes mutations per connection while a grant is in flight', async () => {
    const grantDone = deferred<OperationGroupGrantView>();
    const { doc, host, mount, calls } = mountFor({
      connections: [connection('hs', { display_name: 'HubSpot' })],
      groupsByName: {
        hs: grantView('hs', [group(DEALS_WRITE), group(CONTACTS_WRITE)]),
      },
      runGrant: () => grantDone.promise,
    });
    await mount.whenLoaded();

    toggleFor(host, DEALS_WRITE)!.focus();
    toggleFor(host, DEALS_WRITE)!.click();
    await tick();

    const card = cardFor(host, 'hs');
    const toggles = collectByAttr(card, CONNECTIONS_GRANT_TOGGLE_ATTR);
    expect(toggles).toHaveLength(2);
    expect(toggles.map((t) => t.getAttribute('disabled'))).toEqual([null, null]);
    expect(toggles.map((t) => t.getAttribute('aria-disabled'))).toEqual([
      'true',
      'true',
    ]);
    expect(toggles[0]!.getAttribute('aria-busy')).toBe('true');
    expect(toggles[0]!.getAttribute('aria-label')).toBe(
      'Granting… hubspot.deals.write for HubSpot (hs)',
    );
    expect(toggles[1]!.getAttribute('aria-busy')).toBeNull();
    expect(toggles[1]!.getAttribute('aria-label')).toBe(
      'Grant hubspot.contacts.write for HubSpot (hs)',
    );
    expect(doc.activeElement).toBe(toggleFor(host, DEALS_WRITE));
    expect(mount.hasInFlightWork()).toBe(true);
    expect(calls.runGrant).toHaveBeenCalledTimes(1);

    await mount.toggleGroup('hs', CONTACTS_WRITE);
    expect(calls.runGrant.mock.calls.length + calls.runRevoke.mock.calls.length).toBe(1);

    grantDone.resolve(
      grantView('hs', [
        group(DEALS_WRITE, { granted: true }),
        group(CONTACTS_WRITE),
      ]),
    );
    await tick();

    const enabled = collectByAttr(cardFor(host, 'hs'), CONNECTIONS_GRANT_TOGGLE_ATTR);
    expect(enabled.map((t) => t.getAttribute('disabled'))).toEqual([null, null]);
    expect(enabled.map((t) => t.getAttribute('aria-disabled'))).toEqual([
      null,
      null,
    ]);
    expect(toggleFor(host, DEALS_WRITE)!.textContent).toBe('Revoke');
    expect(doc.activeElement).toBe(toggleFor(host, DEALS_WRITE));
    expect(mount.hasInFlightWork()).toBe(false);
    mount.dispose();
  });

  it('restores the exact toggle and exposes its card error after a failed grant', async () => {
    const grantDone = deferred<OperationGroupGrantView>();
    const { doc, host, mount } = mountFor({
      connections: [connection('hs')],
      groupsByName: { hs: grantView('hs', [group(DEALS_WRITE)]) },
      runGrant: () => grantDone.promise,
    });
    await mount.whenLoaded();

    const initial = toggleFor(host, DEALS_WRITE)!;
    initial.focus();
    initial.click();
    await tick();
    expect(doc.activeElement).toBe(toggleFor(host, DEALS_WRITE));

    grantDone.reject(new Error('grant denied'));
    await tick();

    const restored = toggleFor(host, DEALS_WRITE)!;
    expect(restored.textContent).toBe('Grant');
    expect(restored.getAttribute('aria-disabled')).toBeNull();
    expect(doc.activeElement).toBe(restored);
    const errors = collectByAttr(host, CONNECTIONS_GRANT_GROUP_ERROR_ATTR);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.textContent).toContain('grant denied');
    mount.dispose();
  });

  it('drops a stale in-flight refresh after a toggle writes a fresh view', async () => {
    const oldView = grantView('hs', [group(DEALS_WRITE)]);
    const freshView = grantView('hs', [group(DEALS_WRITE, { granted: true })]);
    const refreshGroups = deferred<OperationGroupGrantView>();
    let groupsCall = 0;
    const { host, mount, calls } = mountFor({
      connections: [connection('hs')],
      runListGroups: async () => {
        groupsCall += 1;
        return groupsCall === 1 ? oldView : refreshGroups.promise;
      },
      runGrant: async () => freshView,
    });
    await mount.whenLoaded();
    expect(toggleFor(host, DEALS_WRITE)!.textContent).toBe('Grant');

    const refresh = mount.refresh();
    await tick();
    expect(calls.runListGroups).toHaveBeenCalledTimes(2);

    await mount.toggleGroup('hs', DEALS_WRITE);
    expect(toggleFor(host, DEALS_WRITE)!.textContent).toBe('Revoke');
    expect(toggleFor(host, DEALS_WRITE)!.getAttribute('data-granted')).toBe('true');

    refreshGroups.resolve(oldView);
    await refresh;
    await tick();

    expect(toggleFor(host, DEALS_WRITE)!.textContent).toBe('Revoke');
    expect(toggleFor(host, DEALS_WRITE)!.getAttribute('aria-pressed')).toBe('true');
    expect(calls.runGrant).toHaveBeenCalledTimes(1);
    mount.dispose();
  });

  it('surfaces per-connection listGroups failure without failing the panel', async () => {
    const { host, mount, calls } = mountFor({
      connections: [connection('bad'), connection('ok')],
      runListGroups: async ({ name }) => {
        if (name === 'bad') throw new Error('group rpc down');
        return grantView(name, [group(DEALS_WRITE)]);
      },
    });

    await mount.whenLoaded();

    expect(calls.runListGroups).toHaveBeenCalledTimes(2);
    expect(mount.getState()).toBe('ready');
    expect(mount.getListError()).toBeNull();
    expect(collectByAttr(host, CONNECTIONS_GRANT_CARD_ATTR)).toHaveLength(2);

    const bad = cardFor(host, 'bad');
    const chips = collectByAttr(bad, CONNECTIONS_GRANT_GROUP_ERROR_ATTR);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('group rpc down');
    expect(toggleFor(cardFor(host, 'ok'), DEALS_WRITE)).toBeDefined();
    mount.dispose();
  });

  it('recovers from list failure and retains rows on a later refresh failure', async () => {
    const hs = connection('hs');
    const runListConnections = vi.fn<ConnectionsListCaller>();
    runListConnections
      .mockRejectedValueOnce(new Error('list down'))
      .mockResolvedValueOnce({ connections: [hs] })
      .mockRejectedValueOnce(new Error('transient'));
    const { host, mount } = mountFor({
      runListConnections,
      groupsByName: {
        hs: grantView('hs', [group(DEALS_WRITE)]),
      },
    });

    await mount.whenLoaded();
    expect(mount.getState()).toBe('error');
    expect(mount.getListError()).toBe('list down');
    expect(collectByAttr(host, CONNECTIONS_GRANT_PANEL_ERROR_ATTR)).toHaveLength(1);
    expect(collectByAttr(host, CONNECTIONS_GRANT_CARD_ATTR)).toHaveLength(0);

    await mount.refresh();
    expect(mount.getState()).toBe('ready');
    expect(mount.getListError()).toBeNull();
    expect(mount.getConnections().map((r) => r.connection.name)).toEqual(['hs']);
    expect(collectByAttr(host, CONNECTIONS_GRANT_CARD_ATTR)).toHaveLength(1);

    await mount.refresh();
    expect(mount.getState()).toBe('error');
    expect(mount.getListError()).toBe('transient');
    expect(collectByAttr(host, CONNECTIONS_GRANT_PANEL_ERROR_ATTR)).toHaveLength(1);
    expect(mount.getConnections().map((r) => r.connection.name)).toEqual(['hs']);
    expect(collectByAttr(host, CONNECTIONS_GRANT_CARD_ATTR)).toHaveLength(1);
    mount.dispose();
  });

  it('renders ready empty state when no api connections exist', async () => {
    const { host, mount, calls } = mountFor({
      connections: [
        connection('mcp', { kind: 'mcp', subtype: 'sse' }),
        connection('notify', { kind: 'notification', subtype: 'slack' }),
      ],
    });

    await mount.whenLoaded();

    expect(mount.getState()).toBe('ready');
    expect(mount.getConnections()).toHaveLength(0);
    expect(calls.runListGroups).not.toHaveBeenCalled();
    expect(collectByAttr(host, CONNECTIONS_GRANT_PANEL_EMPTY_ATTR)).toHaveLength(1);
    expect(allText(host).join(' ')).toContain('No API connections');
    mount.dispose();
  });

  it('dispose removes the wrapper, is idempotent, and ignores late rpc resolution', async () => {
    const list = deferred<{ connections: ReadonlyArray<ConnectionView> }>();
    const { host, mount, calls } = mountFor({
      runListConnections: () => list.promise,
      groupsByName: {
        hs: grantView('hs', [group(DEALS_WRITE)]),
      },
    });

    expect(host.children).toHaveLength(1);
    mount.dispose();
    expect(host.children).toHaveLength(0);
    expect(() => mount.dispose()).not.toThrow();

    list.resolve({ connections: [connection('hs')] });
    await mount.whenLoaded();
    await tick();

    expect(host.children).toHaveLength(0);
    expect(calls.runListGroups).not.toHaveBeenCalled();
    expect(mount.getState()).toBe('loading');
  });

});
