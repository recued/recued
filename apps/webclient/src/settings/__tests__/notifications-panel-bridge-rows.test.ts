import { describe, expect, it, vi } from 'vitest';

import type {
  NotificationBridgeRow,
  NotificationChannelToggleView,
  NotificationSetBridgeModeResult,
  NotificationSetChannelResult,
} from '@recued/contracts';

import {
  NOTIFICATIONS_BRIDGE_EMPTY_ATTR,
  NOTIFICATIONS_BRIDGE_MODE_ATTR,
  NOTIFICATIONS_BRIDGE_MODE_BTN_ATTR,
  NOTIFICATIONS_BRIDGE_ROW_ATTR,
  NOTIFICATIONS_BRIDGE_ROW_ERROR_ATTR,
  NOTIFICATIONS_ROW_ATTR,
  NOTIFICATIONS_ROW_CHANNEL_ATTR,
  mountNotificationsPanel,
} from '../notifications-panel.js';

interface FakeElement {
  tagName: string;
  textContent: string;
  disabled: boolean;
  className: string;
  children: FakeElement[];
  parent: FakeElement | null;
  attrs: Map<string, string>;
  listeners: Map<string, Array<(ev: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  appendChild(el: FakeElement): FakeElement;
  removeChild(el: FakeElement): FakeElement;
  readonly firstChild: FakeElement | null;
  remove(): void;
  addEventListener(name: string, fn: (ev: unknown) => void): void;
  click(): void;
  type: string;
  classList: { add: (cls: string) => void };
}

const makeFakeElement = (tagName: string): FakeElement => {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent: '',
    disabled: false,
    className: '',
    type: '',
    children: [],
    parent: null,
    attrs: new Map(),
    listeners: new Map(),
    classList: {
      add(cls) {
        el.className = el.className === '' ? cls : `${el.className} ${cls}`;
      },
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    appendChild(child) {
      el.children.push(child);
      child.parent = el;
      return child;
    },
    removeChild(child) {
      const idx = el.children.indexOf(child);
      if (idx < 0) throw new Error('removeChild: not a child');
      el.children.splice(idx, 1);
      child.parent = null;
      return child;
    },
    get firstChild() {
      return el.children[0] ?? null;
    },
    remove() {
      if (el.parent) el.parent.removeChild(el);
    },
    addEventListener(name, fn) {
      const arr = el.listeners.get(name) ?? [];
      arr.push(fn);
      el.listeners.set(name, arr);
    },
    click() {
      for (const fn of el.listeners.get('click') ?? []) fn({ target: el });
    },
  };
  return el;
};

const makeFakeDocument = () => ({
  createElement: makeFakeElement,
  createTextNode(text: string) {
    const node = makeFakeElement('#text');
    node.textContent = text;
    return node;
  },
});

const textOf = (el: FakeElement): string =>
  `${el.textContent}${el.children.map(textOf).join('')}`;

const findAllByAttr = (
  root: FakeElement,
  attr: string,
  value?: string,
  out: FakeElement[] = [],
): FakeElement[] => {
  if (
    root.hasAttribute(attr)
    && (value === undefined || root.getAttribute(attr) === value)
  ) {
    out.push(root);
  }
  for (const child of root.children) findAllByAttr(child, attr, value, out);
  return out;
};

const findByAttr = (
  root: FakeElement,
  attr: string,
  value?: string,
): FakeElement | null =>
  findAllByAttr(root, attr, value)[0] ?? null;

const channelRows: ReadonlyArray<NotificationChannelToggleView> = [
  {
    channel: 'ui',
    capability: 'inline',
    notification: true,
    approval: true,
    notification_togglable: false,
    approval_togglable: false,
    ready: true,
  },
  {
    channel: 'bridge',
    capability: 'notify-only',
    notification: true,
    approval: false,
    notification_togglable: true,
    approval_togglable: false,
    ready: true,
  },
  {
    channel: 'slack',
    capability: 'inline',
    notification: false,
    approval: false,
    notification_togglable: true,
    approval_togglable: true,
    ready: false,
  },
  {
    channel: 'telegram',
    capability: 'inline',
    notification: false,
    approval: false,
    notification_togglable: true,
    approval_togglable: true,
    ready: false,
  },
  {
    channel: 'email',
    capability: 'landing-page',
    notification: false,
    approval: false,
    notification_togglable: true,
    approval_togglable: true,
    ready: false,
  },
];

const bridgeRows: ReadonlyArray<NotificationBridgeRow> = [
  {
    client_token_id: 'bridge-1',
    label: 'Bridge1 Chrome on macOS',
    modes: { notification: true, approval: false },
    added_at: 1_700_000_000,
    connected: true,
  },
  {
    client_token_id: 'bridge-2',
    label: 'Bridge2 Edge on Windows',
    modes: { notification: false, approval: true },
    connected: false,
  },
];

const okSettings = (
  id: string,
  modes: NotificationBridgeRow['modes'],
): NotificationSetBridgeModeResult => ({
  ok: true,
  settings: {
    ui: true,
    bridge: true,
    slack: { notification: false, approval: false, messenger: false },
    telegram: { notification: false, approval: false, messenger: false },
    whatsapp: { notification: false, approval: false, messenger: false },
    discord: { notification: false, approval: false, messenger: false },
    email: { notification: false, approval: false, messenger: false },
    bridges: { [id]: modes },
  },
});

describe('D-169 P1 notifications panel bridge rows', () => {
  it('renders no bridge rows when the describe_bridges caller is absent', async () => {
    const host = makeFakeElement('div');
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runDescribe: async () => ({ rows: channelRows }),
      runSetChannel: async () =>
        ({ ok: false, reason: 'ui_fixed' }) satisfies NotificationSetChannelResult,
    });
    await panel.whenLoaded();

    expect(findAllByAttr(host, NOTIFICATIONS_BRIDGE_ROW_ATTR)).toHaveLength(0);
    expect(panel.getBridgeRows()).toEqual([]);
  });

  it('renders an empty-state under the bridge channel row when the roster is empty', async () => {
    const host = makeFakeElement('div');
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runDescribe: async () => ({ rows: channelRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
      runDescribeBridges: async () => ({ rows: [] }),
      runSetBridgeMode: async () => okSettings('bridge-1', {
        notification: true,
        approval: false,
      }),
    });
    await panel.whenLoaded();

    const bridgeChannel = findByAttr(host, NOTIFICATIONS_ROW_CHANNEL_ATTR, 'bridge')!;
    const empty = findByAttr(bridgeChannel, NOTIFICATIONS_BRIDGE_EMPTY_ATTR);
    expect(empty).not.toBeNull();
    expect(textOf(empty!)).toContain('No bridges paired yet');
  });

  it('renders one row per bridge with labels, presence, mode buttons, and ARIA states', async () => {
    const host = makeFakeElement('div');
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runDescribe: async () => ({ rows: channelRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
      runDescribeBridges: async () => ({ rows: bridgeRows }),
      runSetBridgeMode: async () => okSettings('bridge-1', {
        notification: true,
        approval: false,
      }),
    });
    await panel.whenLoaded();

    const rows = findAllByAttr(host, NOTIFICATIONS_BRIDGE_ROW_ATTR);
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0])).toContain('Bridge1 Chrome on macOS');
    expect(textOf(rows[0])).toContain('Online');
    expect(textOf(rows[1])).toContain('Bridge2 Edge on Windows');
    expect(textOf(rows[1])).toContain('Offline');

    const bridge1Buttons = findAllByAttr(
      rows[0],
      NOTIFICATIONS_BRIDGE_MODE_BTN_ATTR,
      'bridge-1',
    );
    expect(bridge1Buttons).toHaveLength(2);
    expect(bridge1Buttons.map((b) => b.getAttribute(NOTIFICATIONS_BRIDGE_MODE_ATTR))).toEqual([
      'notification',
      'approval',
    ]);
    expect(bridge1Buttons.map((b) => b.getAttribute('role'))).toEqual([
      'switch',
      'switch',
    ]);
    expect(bridge1Buttons.map((b) => b.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
    ]);
    const modeButtonNames = findAllByAttr(
      host,
      NOTIFICATIONS_BRIDGE_MODE_BTN_ATTR,
    ).map((b) => b.getAttribute('aria-label'));
    expect(modeButtonNames).toEqual([
      'Bridge1 Chrome on macOS notifications (bridge-1)',
      'Bridge1 Chrome on macOS approvals (bridge-1)',
      'Bridge2 Edge on Windows notifications (bridge-2)',
      'Bridge2 Edge on Windows approvals (bridge-2)',
    ]);
    expect(new Set(modeButtonNames).size).toBe(modeButtonNames.length);
  });

  it('clicking notification and approval mode buttons sends the expected set_bridge_mode payloads', async () => {
    const host = makeFakeElement('div');
    const setBridgeMode = vi.fn(async (args: {
      bridge_id: string;
      patch: Partial<NotificationBridgeRow['modes']>;
    }) =>
      okSettings(args.bridge_id, {
        notification: args.patch.notification ?? false,
        approval: args.patch.approval ?? false,
      }),
    );
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runDescribe: async () => ({ rows: channelRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
      runDescribeBridges: async () => ({ rows: bridgeRows }),
      runSetBridgeMode: setBridgeMode,
    });
    await panel.whenLoaded();

    await panel.clickBridgeMode('bridge-2', 'notification');
    await panel.clickBridgeMode('bridge-1', 'approval');

    expect(setBridgeMode).toHaveBeenNthCalledWith(1, {
      bridge_id: 'bridge-2',
      patch: { notification: true },
    });
    expect(setBridgeMode).toHaveBeenNthCalledWith(2, {
      bridge_id: 'bridge-1',
      patch: { approval: true },
    });
  });

  it('surfaces bridge_unknown inline on the row', async () => {
    const host = makeFakeElement('div');
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runDescribe: async () => ({ rows: channelRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
      runDescribeBridges: async () => ({ rows: bridgeRows }),
      runSetBridgeMode: async () => ({
        ok: false,
        reason: 'bridge_unknown',
        bridge_id: 'bridge-1',
      }),
    });
    await panel.whenLoaded();

    await panel.clickBridgeMode('bridge-1', 'approval');

    expect(panel.getBridgeRowError('bridge-1')).toContain('unpaired elsewhere');
    const err = findByAttr(host, NOTIFICATIONS_BRIDGE_ROW_ERROR_ATTR);
    expect(err).not.toBeNull();
    expect(textOf(err!)).toContain('unpaired elsewhere');
  });

  it('does not fire a duplicate rpc for a re-entry while a bridge toggle is in flight', async () => {
    const host = makeFakeElement('div');
    const dispatch: { resolve: (r: NotificationSetBridgeModeResult) => void } = {
      resolve: () => undefined,
    };
    const setBridgeMode = vi.fn(
      () =>
        new Promise<NotificationSetBridgeModeResult>((resolve) => {
          dispatch.resolve = resolve;
        }),
    );
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runDescribe: async () => ({ rows: channelRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
      runDescribeBridges: async () => ({ rows: bridgeRows }),
      runSetBridgeMode: setBridgeMode,
    });
    await panel.whenLoaded();

    const first = panel.clickBridgeMode('bridge-1', 'approval');
    expect(panel.getBridgeRowToggling().has('bridge-1::approval')).toBe(true);
    const busy = findAllByAttr(
      host,
      NOTIFICATIONS_BRIDGE_MODE_BTN_ATTR,
      'bridge-1',
    ).find((button) =>
      button.getAttribute(NOTIFICATIONS_BRIDGE_MODE_ATTR) === 'approval',
    );
    expect(busy?.disabled).toBe(false);
    expect(busy?.getAttribute('aria-disabled')).toBe('true');
    expect(busy?.getAttribute('aria-busy')).toBe('true');
    const second = panel.clickBridgeMode('bridge-1', 'approval');
    dispatch.resolve(okSettings('bridge-1', {
      notification: true,
      approval: true,
    }));
    await Promise.all([first, second]);

    expect(setBridgeMode).toHaveBeenCalledTimes(1);
    expect(panel.getBridgeRowToggling().has('bridge-1::approval')).toBe(false);
  });

  it('surfaces bridge fetch failure inline without breaking channel rows above', async () => {
    const host = makeFakeElement('div');
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runDescribe: async () => ({ rows: channelRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
      runDescribeBridges: async () => {
        throw new Error('bridge roster offline');
      },
      runSetBridgeMode: async () => okSettings('bridge-1', {
        notification: true,
        approval: false,
      }),
    });
    await panel.whenLoaded();

    expect(findAllByAttr(host, NOTIFICATIONS_ROW_ATTR)).toHaveLength(5);
    expect(panel.getState()).toBe('ready');
    expect(panel.getBridgeRows()).toEqual([]);
    expect(findByAttr(host, NOTIFICATIONS_BRIDGE_ROW_ERROR_ATTR)).not.toBeNull();
    expect(textOf(findByAttr(host, NOTIFICATIONS_BRIDGE_ROW_ERROR_ATTR)!)).toContain(
      'bridge roster offline',
    );
  });

  it('getBridgeRows, getBridgeRowToggling, getBridgeRowError, and clickBridgeMode reflect state', async () => {
    const host = makeFakeElement('div');
    const panel = mountNotificationsPanel({
      host: host as unknown as HTMLElement,
      document: makeFakeDocument() as unknown as Document,
      runDescribe: async () => ({ rows: channelRows }),
      runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
      runDescribeBridges: async () => ({ rows: bridgeRows }),
      runSetBridgeMode: async () => ({
        ok: false,
        reason: 'bridge_unknown',
        bridge_id: 'bridge-2',
      }),
    });
    await panel.whenLoaded();

    expect(panel.getBridgeRows()).toEqual(bridgeRows);
    expect(panel.getBridgeRowToggling().size).toBe(0);
    await panel.clickBridgeMode('bridge-2', 'notification');
    expect(panel.getBridgeRowError('bridge-2')).toContain('unpaired elsewhere');
  });
});
