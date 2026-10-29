import { describe, expect, it, vi } from 'vitest';

import type {
  BroadcastEventKind,
  NotificationBridgeRow,
  NotificationChannelToggleView,
  NotificationSetBridgeModeResult,
  ServerEvent,
} from '@recued/contracts';

import {
  WEBCLIENT_DEFAULT_SUBSCRIPTIONS,
  type BroadcastListener,
  type BroadcastSubscriber,
} from '../../realtime/subscriber.js';
import {
  NOTIFICATIONS_BRIDGE_MODE_ATTR,
  NOTIFICATIONS_BRIDGE_MODE_BTN_ATTR,
  NOTIFICATIONS_BRIDGE_LOADING_ATTR,
  NOTIFICATIONS_BRIDGE_EMPTY_ATTR,
  NOTIFICATIONS_BRIDGE_RETRY_ATTR,
  NOTIFICATIONS_ROW_CHANNEL_ATTR,
  mountNotificationsPanel,
  type MountNotificationsPanelOptions,
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
): Extract<NotificationSetBridgeModeResult, { ok: true }> => ({
  ok: true,
  settings: {
    ui: true,
    bridge: true,
    slack: { notification: false, approval: false, messenger: false },
    telegram: { notification: false, approval: false, messenger: false },
    whatsapp: { notification: false, approval: false, messenger: false },
    discord: { notification: false, approval: false, messenger: false },
    teams: { notification: false, approval: false, messenger: false },
    email: { notification: false, approval: false, messenger: false },
    bridges: { [id]: modes },
  },
});

type BridgeModeChangedEvent = Extract<
  ServerEvent,
  { kind: 'notification.bridge_mode_changed' }
>;

interface CapturedSubscription {
  kind: BroadcastEventKind;
  listener: (event: BridgeModeChangedEvent) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
}

const makeFakeSubscribe = (): {
  subscribe: BroadcastSubscriber['on'];
  calls: CapturedSubscription[];
} => {
  const calls: CapturedSubscription[] = [];
  const subscribe = (<K extends BroadcastEventKind>(
    kind: K,
    listener: BroadcastListener<K>,
  ) => {
    const unsubscribe = vi.fn();
    calls.push({
      kind,
      listener: listener as unknown as (event: BridgeModeChangedEvent) => void,
      unsubscribe,
    });
    return unsubscribe;
  }) as BroadcastSubscriber['on'];
  return { subscribe, calls };
};

const bridgeModeEvent = (
  client_token_id: string,
  modes: BridgeModeChangedEvent['modes'],
  cursor = 1,
): BridgeModeChangedEvent => ({
  kind: 'notification.bridge_mode_changed',
  client_token_id,
  modes,
  cursor,
});

const bridgeModeSubscription = (
  fake: ReturnType<typeof makeFakeSubscribe>,
): CapturedSubscription => {
  const call = fake.calls.find(
    (c) => c.kind === 'notification.bridge_mode_changed',
  );
  if (!call) throw new Error('missing notification.bridge_mode_changed listener');
  return call;
};

const cloneBridgeRows = (
  rows: ReadonlyArray<NotificationBridgeRow>,
): NotificationBridgeRow[] =>
  rows.map((row) => ({ ...row, modes: { ...row.modes } }));

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushAsyncHandlers = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const mountPanel = (
  overrides: Partial<MountNotificationsPanelOptions> = {},
): { host: FakeElement; panel: ReturnType<typeof mountNotificationsPanel> } => {
  const host = makeFakeElement('div');
  const panel = mountNotificationsPanel({
    host: host as unknown as HTMLElement,
    document: makeFakeDocument() as unknown as Document,
    runDescribe: async () => ({ rows: channelRows }),
    runSetChannel: async () => ({ ok: false, reason: 'ui_fixed' }),
    runSetBridgeMode: async ({ bridge_id }) =>
      okSettings(bridge_id, { notification: true, approval: false }),
    ...overrides,
  });
  return { host, panel };
};

const bridgeModeAriaChecked = (
  host: FakeElement,
  clientTokenId: string,
  mode: keyof NotificationBridgeRow['modes'],
): string | null => {
  const button = findAllByAttr(
    host,
    NOTIFICATIONS_BRIDGE_MODE_BTN_ATTR,
    clientTokenId,
  ).find((el) => el.getAttribute(NOTIFICATIONS_BRIDGE_MODE_ATTR) === mode);
  return button?.getAttribute('aria-checked') ?? null;
};

describe('D-169 P2 Slice 4 notifications panel live bridge modes', () => {
  it('keeps both confirmed axes when two device-save replies arrive out of order', async () => {
    const approval = deferred<NotificationSetBridgeModeResult>();
    const notification = deferred<NotificationSetBridgeModeResult>();
    const { host, panel } = mountPanel({ runDescribeBridges: async () => ({ rows: cloneBridgeRows(bridgeRows) }),
      runSetBridgeMode: ({ patch }) => patch.approval !== undefined ? approval.promise : notification.promise });
    await panel.whenLoaded();
    const first = panel.clickBridgeMode('bridge-1', 'approval');
    const second = panel.clickBridgeMode('bridge-1', 'notification');
    notification.resolve(okSettings('bridge-1', { notification: false, approval: true })); await second;
    approval.resolve(okSettings('bridge-1', { notification: true, approval: true })); await first;
    expect(panel.getBridgeRows()[0]?.modes).toEqual({ notification: false, approval: true });
    expect(bridgeModeAriaChecked(host, 'bridge-1', 'notification')).toBe('false');
    expect(bridgeModeAriaChecked(host, 'bridge-1', 'approval')).toBe('true');
  });

  it('reconciles a delayed save reply that disagrees with a newer live mode event', async () => {
    const fakeSubscribe = makeFakeSubscribe();
    const saved = deferred<NotificationSetBridgeModeResult>();
    const latest = cloneBridgeRows(bridgeRows); latest[0]!.modes.approval = true;
    const read = vi.fn(async () => ({ rows: cloneBridgeRows(latest) }))
      .mockResolvedValueOnce({ rows: cloneBridgeRows(bridgeRows) });
    const { panel } = mountPanel({ subscribe: fakeSubscribe.subscribe, runDescribeBridges: read,
      runSetBridgeMode: () => saved.promise });
    await panel.whenLoaded();
    const write = panel.clickBridgeMode('bridge-1', 'notification');
    bridgeModeSubscription(fakeSubscribe).listener(bridgeModeEvent('bridge-1', { notification: true, approval: true }));
    saved.resolve(okSettings('bridge-1', { notification: false, approval: false })); await write;
    await flushAsyncHandlers();
    expect(read).toHaveBeenCalledTimes(2);
    expect(panel.getBridgeRows()[0]?.modes).toEqual({ notification: true, approval: true });
  });

  it.each(['channel', 'device', 'phrase'] as const)('releases %s after a synchronous caller failure and permits another save', async kind => {
    const success = okSettings('bridge-1', { notification: true, approval: true });
    const channel = vi.fn(async () => success).mockImplementationOnce(() => { throw new Error('Channel caller failed'); });
    const device = vi.fn(async () => success).mockImplementationOnce(() => { throw new Error('Device caller failed'); });
    const phrase = vi.fn(async () => success).mockImplementationOnce(() => { throw new Error('Phrase caller failed'); });
    const { panel } = mountPanel({ runDescribeBridges: async () => ({ rows: cloneBridgeRows(bridgeRows) }),
      runSetChannel: channel, runSetBridgeMode: device, runSetVerificationPhrase: phrase });
    await panel.whenLoaded();
    const invoke = kind === 'channel' ? () => panel.clickAxis('slack', 'notification')
      : kind === 'device' ? () => panel.clickBridgeMode('bridge-1', 'approval') : () => panel.savePhrase('Changed phrase');
    await invoke();
    expect(panel.hasInFlightWork()).toBe(false);
    await invoke();
    expect(kind === 'channel' ? channel : kind === 'device' ? device : phrase).toHaveBeenCalledTimes(2);
    expect(panel.hasInFlightWork()).toBe(false);
  });

  it('keeps a matching self-echo without adding a device read for a normal save', async () => {
    const fakeSubscribe = makeFakeSubscribe();
    const saved = deferred<NotificationSetBridgeModeResult>();
    const read = vi.fn(async () => ({ rows: cloneBridgeRows(bridgeRows) }));
    const { panel } = mountPanel({ subscribe: fakeSubscribe.subscribe, runDescribeBridges: read, runSetBridgeMode: () => saved.promise });
    await panel.whenLoaded();
    const write = panel.clickBridgeMode('bridge-1', 'approval');
    bridgeModeSubscription(fakeSubscribe).listener(bridgeModeEvent('bridge-1', { notification: true, approval: true }));
    saved.resolve(okSettings('bridge-1', { notification: true, approval: true })); await write;
    expect(read).toHaveBeenCalledTimes(1);
    expect(panel.getBridgeRows()[0]?.modes).toEqual({ notification: true, approval: true });
  });

  it('confirms the device roster when a successful legacy reply omits its optional bridge settings', async () => {
    const reply = okSettings('bridge-1', { notification: true, approval: true });
    delete reply.settings.bridges;
    const latest = cloneBridgeRows(bridgeRows); latest[0]!.modes.approval = true;
    const read = vi.fn(async () => ({ rows: cloneBridgeRows(latest) }))
      .mockResolvedValueOnce({ rows: cloneBridgeRows(bridgeRows) });
    const { panel } = mountPanel({ runDescribeBridges: read, runSetBridgeMode: async () => reply });
    await panel.whenLoaded();
    await panel.clickBridgeMode('bridge-1', 'approval');
    await flushAsyncHandlers();
    expect(read).toHaveBeenCalledTimes(2);
    expect(panel.getBridgeRows()[0]?.modes.approval).toBe(true);
  });

  it('uses an empty current device roster for pairing guidance instead of pointing at missing controls', async () => {
    const { host, panel } = mountPanel({ runDescribeBridges: async () => ({ rows: [] }) });
    await panel.whenLoaded();
    const card = findAllByAttr(host, NOTIFICATIONS_ROW_CHANNEL_ATTR, 'bridge')[0]!;
    const text = (node: FakeElement): string => node.textContent + node.children.map(text).join(' ');
    expect(text(card)).toContain('Not set up');
    expect(text(card)).not.toContain('Per device');
  });

  it('preserves server delivery readiness when devices are paired without offering to install them again', async () => {
    const { host, panel } = mountPanel({
      runDescribe: async () => ({ rows: channelRows.map(row => row.channel === 'bridge'
        ? { ...row, ready: false, install_url: 'https://example.com/bridge' } : row) }),
      runDescribeBridges: async () => ({ rows: cloneBridgeRows(bridgeRows) }),
    });
    await panel.whenLoaded();
    const card = findAllByAttr(host, NOTIFICATIONS_ROW_CHANNEL_ATTR, 'bridge')[0]!;
    const text = (node: FakeElement): string => node.textContent + node.children.map(text).join(' ');
    expect(text(card)).toContain('Not ready to deliver');
    expect(text(card)).toContain('Per device');
    expect(findAllByAttr(card, 'href', 'https://example.com/bridge')).toHaveLength(0);
    expect(panel.getRows().find(row => row.channel === 'bridge')?.ready).toBe(false);
  });

  it('shows ready channels while devices are pending and distinguishes pending from an empty roster', async () => {
    const devices = deferred<{ rows: ReadonlyArray<NotificationBridgeRow> }>();
    const { host, panel } = mountPanel({ runDescribeBridges: () => devices.promise });
    await flushAsyncHandlers();
    expect(panel.getState()).toBe('ready');
    expect(panel.getRows()).toEqual(channelRows);
    expect(findAllByAttr(host, NOTIFICATIONS_BRIDGE_LOADING_ATTR)).toHaveLength(1);
    expect(findAllByAttr(host, NOTIFICATIONS_BRIDGE_EMPTY_ATTR)).toHaveLength(0);
    expect(panel.hasInFlightWork()).toBe(false);
    devices.resolve({ rows: [] });
    await panel.whenLoaded();
    expect(findAllByAttr(host, NOTIFICATIONS_BRIDGE_LOADING_ATTR)).toHaveLength(0);
    expect(findAllByAttr(host, NOTIFICATIONS_BRIDGE_EMPTY_ATTR)).toHaveLength(1);
  });

  it('contains a synchronous device-read failure and retries only that read once', async () => {
    const retry = deferred<{ rows: ReadonlyArray<NotificationBridgeRow> }>();
    const runDescribe = vi.fn(async () => ({ rows: channelRows }));
    const runDescribeBridges = vi.fn(async (): Promise<{ rows: ReadonlyArray<NotificationBridgeRow> }> => ({ rows: cloneBridgeRows(bridgeRows) }))
      .mockImplementationOnce(() => { throw new Error('Device read unavailable'); })
      .mockReturnValueOnce(retry.promise);
    const runSetChannel = vi.fn(async () => ({ ok: false as const, reason: 'ui_fixed' as const }));
    const { host, panel } = mountPanel({ runDescribe, runDescribeBridges, runSetChannel });
    await panel.whenLoaded();
    expect(panel.getState()).toBe('ready');
    expect(panel.getListError()).toBeNull();
    expect(panel.getBridgeRowError('')).toContain('Device read unavailable');
    const button = findAllByAttr(host, NOTIFICATIONS_BRIDGE_RETRY_ATTR)[0]!;
    button.click(); button.click();
    expect(runDescribeBridges).toHaveBeenCalledTimes(2);
    expect(findAllByAttr(host, NOTIFICATIONS_BRIDGE_LOADING_ATTR)).toHaveLength(1);
    retry.resolve({ rows: cloneBridgeRows(bridgeRows) });
    await flushAsyncHandlers();
    expect(panel.getBridgeRows()).toEqual(bridgeRows);
    expect(panel.getBridgeRowError('')).toBeUndefined();
    expect(runDescribe).toHaveBeenCalledTimes(1);
    expect(runSetChannel).not.toHaveBeenCalled();
  });

  it('ignores an earlier channel failure after a newer refresh has become ready', async () => {
    const first = deferred<{ rows: ReadonlyArray<NotificationChannelToggleView> }>();
    const second = deferred<{ rows: ReadonlyArray<NotificationChannelToggleView> }>();
    const runDescribe = vi.fn(async () => ({ rows: channelRows }))
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { panel } = mountPanel({ runDescribe, runDescribeBridges: async () => ({ rows: [] }) });
    panel.refresh();
    const current = channelRows.map(row => row.channel === 'slack' ? { ...row, ready: true, notification: true } : row);
    second.resolve({ rows: current });
    await panel.whenLoaded();
    first.reject(new Error('Old channel failure'));
    await flushAsyncHandlers();
    expect(panel.getState()).toBe('ready'); expect(panel.getRows()).toEqual(current);
    expect(panel.getListError()).toBeNull();
  });

  it('keeps a known-device event newer than a roster read that was already running', async () => {
    const fakeSubscribe = makeFakeSubscribe();
    const stale = deferred<{ rows: ReadonlyArray<NotificationBridgeRow> }>();
    const fresh = deferred<{ rows: ReadonlyArray<NotificationBridgeRow> }>();
    const runDescribeBridges = vi.fn(async (): Promise<{ rows: ReadonlyArray<NotificationBridgeRow> }> => ({ rows: cloneBridgeRows(bridgeRows) }))
      .mockResolvedValueOnce({ rows: cloneBridgeRows(bridgeRows) })
      .mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const { host, panel } = mountPanel({ subscribe: fakeSubscribe.subscribe, runDescribeBridges });
    await panel.whenLoaded();
    panel.refresh();
    await flushAsyncHandlers();
    bridgeModeSubscription(fakeSubscribe).listener(bridgeModeEvent('bridge-1', { notification: false, approval: true }));
    expect(runDescribeBridges).toHaveBeenCalledTimes(3);
    const newer = cloneBridgeRows(bridgeRows); newer[0]!.modes = { notification: false, approval: true };
    fresh.resolve({ rows: newer });
    await flushAsyncHandlers();
    stale.resolve({ rows: cloneBridgeRows(bridgeRows) });
    await panel.whenLoaded();
    expect(panel.getBridgeRows()).toEqual(newer);
    expect(bridgeModeAriaChecked(host, 'bridge-1', 'approval')).toBe('true');
  });

  it('keeps a confirmed mode change newer than a device read begun before the write settled', async () => {
    const stale = deferred<{ rows: ReadonlyArray<NotificationBridgeRow> }>();
    const fresh = deferred<{ rows: ReadonlyArray<NotificationBridgeRow> }>();
    const saved = deferred<NotificationSetBridgeModeResult>();
    const runDescribeBridges = vi.fn(async (): Promise<{ rows: ReadonlyArray<NotificationBridgeRow> }> => ({ rows: cloneBridgeRows(bridgeRows) }))
      .mockResolvedValueOnce({ rows: cloneBridgeRows(bridgeRows) })
      .mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const { panel } = mountPanel({ runDescribeBridges, runSetBridgeMode: () => saved.promise });
    await panel.whenLoaded();
    const write = panel.clickBridgeMode('bridge-1', 'approval');
    panel.refresh();
    await flushAsyncHandlers();
    saved.resolve(okSettings('bridge-1', { notification: true, approval: true }));
    await write;
    expect(runDescribeBridges).toHaveBeenCalledTimes(3);
    const confirmed = cloneBridgeRows(bridgeRows); confirmed[0]!.modes.approval = true;
    fresh.resolve({ rows: confirmed });
    await flushAsyncHandlers();
    stale.resolve({ rows: cloneBridgeRows(bridgeRows) });
    await panel.whenLoaded();
    expect(panel.getBridgeRows()).toEqual(confirmed);
    expect(panel.hasInFlightWork()).toBe(false);
  });

  it('ignores a late device failure after the panel is disposed', async () => {
    const devices = deferred<{ rows: ReadonlyArray<NotificationBridgeRow> }>();
    const { host, panel } = mountPanel({ runDescribeBridges: () => devices.promise });
    await flushAsyncHandlers();
    expect(panel.getState()).toBe('ready');
    panel.dispose();
    devices.reject(new Error('Late device failure'));
    await panel.whenLoaded();
    expect(host.children).toEqual([]);
    expect(panel.getBridgeRowError('')).toBeUndefined();
  });

  it('subscribes the webclient to notification.bridge_mode_changed by default', () => {
    expect(WEBCLIENT_DEFAULT_SUBSCRIPTIONS).toContain(
      'notification.bridge_mode_changed',
    );
  });

  it('registers the bridge mode listener only when subscribe and runDescribeBridges are both present', async () => {
    const wiredSubscribe = makeFakeSubscribe();
    const { panel: wiredPanel } = mountPanel({
      subscribe: wiredSubscribe.subscribe,
      runDescribeBridges: vi.fn(async () => ({ rows: cloneBridgeRows(bridgeRows) })),
    });
    await wiredPanel.whenLoaded();

    expect(
      wiredSubscribe.calls.filter(
        (c) => c.kind === 'notification.bridge_mode_changed',
      ),
    ).toHaveLength(1);
    wiredPanel.dispose();

    const subscribeOnly = makeFakeSubscribe();
    const { panel: subscribeOnlyPanel } = mountPanel({
      subscribe: subscribeOnly.subscribe,
    });
    await subscribeOnlyPanel.whenLoaded();

    expect(
      subscribeOnly.calls.filter(
        (c) => c.kind === 'notification.bridge_mode_changed',
      ),
    ).toHaveLength(0);
    subscribeOnlyPanel.dispose();
  });

  it('fast-path splices modes for an existing bridge without refetching', async () => {
    const fakeSubscribe = makeFakeSubscribe();
    const runDescribeBridges = vi.fn(async () => ({
      rows: cloneBridgeRows(bridgeRows),
    }));
    const { host, panel } = mountPanel({
      subscribe: fakeSubscribe.subscribe,
      runDescribeBridges,
    });
    await panel.whenLoaded();
    expect(runDescribeBridges).toHaveBeenCalledTimes(1);

    bridgeModeSubscription(fakeSubscribe).listener(
      bridgeModeEvent('bridge-1', { notification: false, approval: true }),
    );
    await flushAsyncHandlers();

    expect(runDescribeBridges).toHaveBeenCalledTimes(1);
    expect(panel.getBridgeRows()).toEqual([
      {
        ...bridgeRows[0],
        modes: { notification: false, approval: true },
      },
      bridgeRows[1],
    ]);
    expect(bridgeModeAriaChecked(host, 'bridge-1', 'notification')).toBe('false');
    expect(bridgeModeAriaChecked(host, 'bridge-1', 'approval')).toBe('true');
  });

  it('slow-path refetches once for an unknown bridge and replaces bridge rows', async () => {
    const fakeSubscribe = makeFakeSubscribe();
    const refetchedRows: ReadonlyArray<NotificationBridgeRow> = [
      bridgeRows[0],
      {
        client_token_id: 'bridge-3',
        label: 'Bridge3 Firefox on Linux',
        modes: { notification: true, approval: true },
        connected: true,
      },
    ];
    const runDescribeBridges = vi
      .fn(async () => ({ rows: cloneBridgeRows(bridgeRows) }))
      .mockResolvedValueOnce({ rows: cloneBridgeRows(bridgeRows) })
      .mockResolvedValueOnce({ rows: cloneBridgeRows(refetchedRows) });
    const { panel } = mountPanel({
      subscribe: fakeSubscribe.subscribe,
      runDescribeBridges,
    });
    await panel.whenLoaded();
    expect(runDescribeBridges).toHaveBeenCalledTimes(1);

    bridgeModeSubscription(fakeSubscribe).listener(
      bridgeModeEvent('bridge-3', { notification: true, approval: true }),
    );
    await flushAsyncHandlers();

    expect(runDescribeBridges).toHaveBeenCalledTimes(2);
    expect(panel.getBridgeRows()).toEqual(refetchedRows);
  });

  it('keeps a slow-path reload fresh when the stale initial roster resolves afterward', async () => {
    const fakeSubscribe = makeFakeSubscribe();
    const initial = deferred<{ rows: ReadonlyArray<NotificationBridgeRow> }>();
    const reload = deferred<{ rows: ReadonlyArray<NotificationBridgeRow> }>();
    const staleInitialRows: ReadonlyArray<NotificationBridgeRow> = [
      {
        ...bridgeRows[0],
        modes: { notification: false, approval: false },
      },
    ];
    const freshReloadRows: ReadonlyArray<NotificationBridgeRow> = [
      {
        ...bridgeRows[0],
        modes: { notification: true, approval: true },
      },
    ];
    const runDescribeBridges = vi
      .fn(
        async (): Promise<{ rows: ReadonlyArray<NotificationBridgeRow> }> => {
          throw new Error('unexpected describe_bridges call');
        },
      )
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(reload.promise);
    const { panel } = mountPanel({
      subscribe: fakeSubscribe.subscribe,
      runDescribeBridges,
    });
    expect(runDescribeBridges).toHaveBeenCalledTimes(1);

    bridgeModeSubscription(fakeSubscribe).listener(
      bridgeModeEvent('bridge-1', { notification: true, approval: true }),
    );
    expect(runDescribeBridges).toHaveBeenCalledTimes(2);

    reload.resolve({ rows: cloneBridgeRows(freshReloadRows) });
    await flushAsyncHandlers();
    expect(panel.getBridgeRows()).toEqual(freshReloadRows);

    initial.resolve({ rows: cloneBridgeRows(staleInitialRows) });
    await panel.whenLoaded();
    await flushAsyncHandlers();

    expect(panel.getState()).toBe('ready');
    expect(panel.getBridgeRows()).toEqual(freshReloadRows);
  });

  it('converges when the same self-echo fast-path event is delivered twice', async () => {
    const fakeSubscribe = makeFakeSubscribe();
    const runDescribeBridges = vi.fn(async () => ({
      rows: cloneBridgeRows(bridgeRows),
    }));
    const { host, panel } = mountPanel({
      subscribe: fakeSubscribe.subscribe,
      runDescribeBridges,
    });
    await panel.whenLoaded();
    const event = bridgeModeEvent('bridge-1', {
      notification: false,
      approval: true,
    });

    bridgeModeSubscription(fakeSubscribe).listener(event);
    bridgeModeSubscription(fakeSubscribe).listener(event);
    await flushAsyncHandlers();

    expect(runDescribeBridges).toHaveBeenCalledTimes(1);
    expect(panel.getBridgeRows()[0]?.modes).toEqual({
      notification: false,
      approval: true,
    });
    expect(bridgeModeAriaChecked(host, 'bridge-1', 'notification')).toBe('false');
    expect(bridgeModeAriaChecked(host, 'bridge-1', 'approval')).toBe('true');
  });

  it('unsubscribe is called on dispose and a late event is a no-op', async () => {
    const fakeSubscribe = makeFakeSubscribe();
    const runDescribeBridges = vi.fn(async () => ({
      rows: cloneBridgeRows(bridgeRows),
    }));
    const { panel } = mountPanel({
      subscribe: fakeSubscribe.subscribe,
      runDescribeBridges,
    });
    await panel.whenLoaded();
    const call = bridgeModeSubscription(fakeSubscribe);
    const before = cloneBridgeRows(panel.getBridgeRows());

    panel.dispose();
    expect(call.unsubscribe).toHaveBeenCalledTimes(1);
    expect(() => {
      call.listener(
        bridgeModeEvent('bridge-1', { notification: false, approval: true }),
      );
    }).not.toThrow();
    await flushAsyncHandlers();

    expect(runDescribeBridges).toHaveBeenCalledTimes(1);
    expect(panel.getBridgeRows()).toEqual(before);
  });
});
