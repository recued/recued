/** D-122/D-125/D-127 connection-notification boot composition. */

import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  NOTIFICATION_DELIVERY_CHANNELS,
  type ConnectionKind,
  type ConnectionRow,
} from '@recued/contracts';
import type { ConnectionKindHandler } from '@recued/ingredients';
import type { CollectionRegistry } from '../collections/registry.js';
import type { EventBus } from '../events/bus.js';
import type {
  KeyManager,
  KeyManagerState,
} from '../key-manager.js';
import type { NotificationChannel } from '../notification-handler.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';
import {
  composeConnectionNotification,
  type ComposeConnectionNotificationDeps,
} from '../composition/bin/wire-connection-notification.js';

type TestEventBus = EventBus & { emit: ReturnType<typeof vi.fn> };
type TestConnectionStore = ConnectionStoreSqlite & {
  list: ReturnType<typeof vi.fn>;
};
type TestKeyManager = KeyManager & {
  state: ReturnType<typeof vi.fn>;
  keyProvider: ReturnType<typeof vi.fn>;
};

// Derived, not hand-spelled: the dispatcher map must cover exactly the channels
// `notification.send` accepts. A literal list here would have quietly disagreed
// with the registry the moment a vendor shipped — which is exactly how WhatsApp
// came to be a declared delivery channel with no dispatcher behind it.
const CHANNELS: readonly NotificationChannel[] = NOTIFICATION_DELIVERY_CHANNELS;

const buildRow = (
  overrides: Partial<ConnectionRow> = {},
): ConnectionRow => ({
  pk: 'notification:alerts',
  kind: 'notification',
  name: 'alerts',
  subtype: 'slack',
  display_name: 'Alerts',
  config_json: '{}',
  auth_ciphertext: 'ciphertext',
  enrolled_at: 1,
  updated_at: 1,
  ...overrides,
});

const buildStore = (
  rows: ConnectionRow[] = [],
): TestConnectionStore => {
  const list = vi.fn((query?: { kind?: ConnectionKind }) =>
    query?.kind
      ? rows.filter((row) => row.kind === query.kind)
      : rows.slice());

  return {
    upsert: vi.fn(() => {
      throw new Error('not implemented in stub');
    }),
    get: vi.fn((kind: ConnectionKind, name: string) =>
      rows.find((row) => row.kind === kind && row.name === name) ?? null),
    list,
    listSince: vi.fn(() => []),
    delete: vi.fn(() => false),
    count: vi.fn(() => rows.length),
  } as unknown as TestConnectionStore;
};

const eventBus = (
  emit: ReturnType<typeof vi.fn> = vi.fn((event: unknown) => ({
    ...(event as Record<string, unknown>),
    cursor: 1,
  })),
): TestEventBus => ({
  cursor: vi.fn(() => 0),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  emit,
  replay: vi.fn(() => []),
  subscriberCount: vi.fn(() => 0),
}) as unknown as TestEventBus;

const collectionRegistry = (): CollectionRegistry =>
  ({}) as unknown as CollectionRegistry;

const keyManager = (
  stateValue: KeyManagerState,
  provider: () => Uint8Array | null = vi.fn(() => null),
): TestKeyManager => ({
  state: vi.fn(() => stateValue),
  keyProvider: vi.fn(() => provider),
}) as unknown as TestKeyManager;

const buildDeps = (
  overrides: Partial<ComposeConnectionNotificationDeps> = {},
): ComposeConnectionNotificationDeps => ({
  connectionStore: buildStore(),
  keys: undefined,
  eventBus: eventBus(),
  collectionRegistry: collectionRegistry(),
  ...overrides,
});

const importComposerWithHelperMocks = async () => {
  vi.resetModules();

  const decodedAuth = { access_token: 'decoded' };
  const decodeAuthFromStorageMock = vi.fn(async () => decodedAuth);
  const emitNotificationMock = vi.fn();
  const mailSendResult = {
    source_id: 'source-1',
    message_id: 'message-1',
    sent_at: 10,
    _id: null,
    _collection: 'data.mail' as const,
  };
  const handleCollectionMailSendMock = vi.fn(async () => mailSendResult);

  vi.doMock('../connection-handler.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../connection-handler.js')>();
    return {
      ...actual,
      decodeAuthFromStorage: decodeAuthFromStorageMock,
    };
  });
  vi.doMock('../events/emit-sites.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../events/emit-sites.js')>();
    return {
      ...actual,
      emitNotification: emitNotificationMock,
    };
  });
  vi.doMock('../collections/collection-handler.js', async (importOriginal) => {
    const actual =
      await importOriginal<typeof import('../collections/collection-handler.js')>();
    return {
      ...actual,
      handleCollectionMailSend: handleCollectionMailSendMock,
    };
  });

  const mod = await import('../composition/bin/wire-connection-notification.js');
  return {
    compose: mod.composeConnectionNotification,
    decodedAuth,
    decodeAuthFromStorageMock,
    emitNotificationMock,
    handleCollectionMailSendMock,
    mailSendResult,
  };
};

const importComposerWithFactoryMocks = async () => {
  vi.resetModules();

  const notificationHandler: ConnectionKindHandler = vi.fn(async () => ({
    status: 'ok',
    result: {},
    headers: undefined,
  }));
  const channelDispatchers: Record<NotificationChannel, ReturnType<typeof vi.fn>> = {
    slack: vi.fn(async () => ({ ok: true })),
    telegram: vi.fn(async () => ({ ok: true })),
    whatsapp: vi.fn(async () => ({ ok: true })),
    discord: vi.fn(async () => ({ ok: true })),
    email: vi.fn(async () => ({ ok: true })),
    // D-238 — Teams joined `NotificationChannel`. The mock is typed as a
    // Record over the FULL union, so a missing member is a compile error as
    // well as a boot failure ("no dispatcher registered for channel 'teams'").
    teams: vi.fn(async () => ({ ok: true })),
    in_app: vi.fn(async () => ({ ok: true })),
  };
  const createConnectionNotificationHandlerMock =
    vi.fn(() => notificationHandler);
  // Mock the registry — each entry's `boot` returns the matching pre-
  // built dispatcher stub above. Recording the full deps argument lets
  // the test assert the composer threads the connection store +
  // handler + (channel, subtype) through the registry boundary
  // verbatim, so registry metadata stays authoritative downstream.
  type StubBootDeps = {
    connectionStore: unknown;
    notificationHandler: ConnectionKindHandler;
    channel: NotificationChannel;
    subtype: string;
  };
  const bootCalls: Array<{
    channel: NotificationChannel;
    deps: StubBootDeps;
  }> = [];
  // Derived — a hand-spelled list here would stub a registry that DISAGREES with
  // the real one, and then happily pass while the composer dropped a channel.
  const registryStub = CHANNELS.map((channel) => ({
    channel,
    subtype: channel === 'in_app' ? ('in-app' as const) : channel,
    boot: vi.fn((deps: StubBootDeps) => {
      bootCalls.push({ channel, deps });
      return channelDispatchers[channel];
    }),
  }));

  vi.doMock('@recued/ingredients', () => ({
    createConnectionNotificationHandler: createConnectionNotificationHandlerMock,
  }));
  vi.doMock('../data/notification-channel-registry.js', () => ({
    NOTIFICATION_CHANNEL_REGISTRY: registryStub,
  }));

  const mod = await import('../composition/bin/wire-connection-notification.js');
  return {
    compose: mod.composeConnectionNotification,
    notificationHandler,
    channelDispatchers,
    createConnectionNotificationHandlerMock,
    registryStub,
    bootCalls,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../connection-handler.js');
  vi.doUnmock('../events/emit-sites.js');
  vi.doUnmock('../collections/collection-handler.js');
  vi.doUnmock('@recued/ingredients');
  vi.doUnmock('../data/notification-channel-registry.js');
});

describe('composeConnectionNotification', () => {
  it('returns all undefined bundle fields when the connection store is absent', () => {
    const keys = keyManager('unlocked');

    const bundle = composeConnectionNotification(buildDeps({
      connectionStore: undefined,
      keys,
    }));

    expect(bundle).toEqual({
      notificationDeps: undefined,
      notificationHandler: undefined,
      channelDispatchers: undefined,
    });
    expect(keys.state).not.toHaveBeenCalled();
    expect(keys.keyProvider).not.toHaveBeenCalled();
  });

  it('returns synchronously instead of returning a Promise', () => {
    const result = composeConnectionNotification(buildDeps());

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown }).then).not.toBe('function');
  });

  it('returns defined notification deps, handler, and channel dispatchers with a connection store', () => {
    const bundle = composeConnectionNotification(buildDeps());

    expect(bundle.notificationDeps).toBeDefined();
    expect(Object.keys(bundle.notificationDeps as object).sort()).toEqual([
      'decodeAuth',
      'emitInApp',
      'mailRpc',
    ]);
    expect(bundle.notificationDeps).toEqual(expect.objectContaining({
      decodeAuth: expect.any(Function),
      emitInApp: expect.any(Function),
      mailRpc: expect.objectContaining({
        send: expect.any(Function),
      }),
    }));
    expect(bundle.notificationHandler).toEqual(expect.any(Function));
    expect(bundle.channelDispatchers).toEqual(expect.objectContaining({
      slack: expect.any(Function),
      telegram: expect.any(Function),
      email: expect.any(Function),
      in_app: expect.any(Function),
    }));
  });

  it('returns exactly the four notification channel dispatcher keys', () => {
    const bundle = composeConnectionNotification(buildDeps());

    expect(Object.keys(bundle.channelDispatchers ?? {}).sort()).toEqual(
      [...CHANNELS].sort(),
    );
  });

  it('does not request the connection key when keys are uninitialized, but decodeAuth remains callable', async () => {
    const {
      compose,
      decodedAuth,
      decodeAuthFromStorageMock,
    } = await importComposerWithHelperMocks();
    const keys = keyManager('uninitialized');

    const bundle = compose(buildDeps({ keys }));
    const out = await bundle.notificationDeps?.decodeAuth(buildRow({
      auth_ciphertext: 'stored-auth',
    }));

    expect(out).toBe(decodedAuth);
    expect(keys.state).toHaveBeenCalledTimes(1);
    expect(keys.keyProvider).not.toHaveBeenCalled();
    expect(decodeAuthFromStorageMock.mock.calls[0]).toEqual([
      'stored-auth',
      { kind: 'notification', name: 'alerts' },
      undefined,
    ]);
  });

  it('requests the connection key provider once when keys are unlocked', () => {
    const provider = vi.fn(() => null);
    const keys = keyManager('unlocked', provider);

    composeConnectionNotification(buildDeps({ keys }));

    expect(keys.state).toHaveBeenCalledTimes(1);
    expect(keys.keyProvider).toHaveBeenCalledTimes(1);
    expect(keys.keyProvider).toHaveBeenCalledWith('connection');
  });

  it('keeps the decodeAuth key provider undefined when keys are absent', async () => {
    const {
      compose,
      decodeAuthFromStorageMock,
    } = await importComposerWithHelperMocks();

    const bundle = compose(buildDeps({ keys: undefined }));
    await bundle.notificationDeps?.decodeAuth(buildRow({
      auth_ciphertext: 'plaintext-auth',
    }));

    expect(decodeAuthFromStorageMock.mock.calls[0]).toEqual([
      'plaintext-auth',
      { kind: 'notification', name: 'alerts' },
      undefined,
    ]);
  });

  it('passes auth ciphertext, row identity, and key provider into decodeAuthFromStorage', async () => {
    const {
      compose,
      decodeAuthFromStorageMock,
    } = await importComposerWithHelperMocks();
    const provider = vi.fn(() => null);
    const keys = keyManager('unlocked', provider);

    const bundle = compose(buildDeps({ keys }));
    await bundle.notificationDeps?.decodeAuth(buildRow({
      auth_ciphertext: 'encrypted-auth',
      kind: 'notification',
      name: 'ops-alerts',
    }));

    expect(keys.keyProvider).toHaveBeenCalledWith('connection');
    expect(decodeAuthFromStorageMock.mock.calls[0]).toEqual([
      'encrypted-auth',
      { kind: 'notification', name: 'ops-alerts' },
      provider,
    ]);
  });

  it('routes emitInApp through emitNotification with the in-app subtype', async () => {
    const {
      compose,
      emitNotificationMock,
    } = await importComposerWithHelperMocks();
    const bus = eventBus();
    const body = {
      text: 'Build finished',
      title: 'Done',
      link_url: 'https://example.test/run/1',
    };

    const bundle = compose(buildDeps({ eventBus: bus }));
    bundle.notificationDeps?.emitInApp?.(body);

    expect(emitNotificationMock.mock.calls[0]).toEqual([
      bus,
      { subtype: 'in-app', body },
    ]);
  });

  it('routes mailRpc.send through handleCollectionMailSend with the collection registry', async () => {
    const {
      compose,
      handleCollectionMailSendMock,
      mailSendResult,
    } = await importComposerWithHelperMocks();
    const registry = collectionRegistry();
    const args = {
      instance: 'work',
      to: ['ada@example.test'],
      subject: 'Alert',
      body_text: 'Check the run.',
    };

    const bundle = compose(buildDeps({ collectionRegistry: registry }));
    const out = await bundle.notificationDeps?.mailRpc?.send(args);

    expect(out).toBe(mailSendResult);
    expect(handleCollectionMailSendMock.mock.calls[0]).toEqual([
      { registry },
      args,
    ]);
  });

  it.each(CHANNELS)(
    'returns NO_CONNECTION_BOUND for %s when the store is empty',
    async (channel) => {
      const bundle = composeConnectionNotification(buildDeps({
        connectionStore: buildStore([]),
      }));

      const out = await bundle.channelDispatchers?.[channel]({
        channel,
        text: 'No connection enrolled',
      });

      expect(out).toEqual({
        ok: false,
        reason: 'NO_CONNECTION_BOUND',
      });
    },
  );

  it('threads the created notification handler + connection store into every registry entry boot', async () => {
    const {
      compose,
      notificationHandler,
      channelDispatchers,
      createConnectionNotificationHandlerMock,
      registryStub,
      bootCalls,
    } = await importComposerWithFactoryMocks();
    const connectionStore = buildStore();

    const bundle = compose(buildDeps({ connectionStore }));

    expect(createConnectionNotificationHandlerMock).toHaveBeenCalledTimes(1);
    expect(bundle.notificationHandler).toBe(notificationHandler);
    // Every channel's dispatcher comes from the stubbed registry entry's
    // `boot` and is identity-mounted onto the composer bundle by channel
    // key — same wiring shape as the real path.
    for (const channel of CHANNELS) {
      expect(bundle.channelDispatchers?.[channel]).toBe(channelDispatchers[channel]);
    }

    // Every registry entry's `boot` is called exactly once with the
    // same `{ connectionStore, notificationHandler }` identity bundle
    // plus the entry's own `channel` + `subtype` threaded through.
    // The (channel, subtype) check is the load-bearing assertion for
    // registry authoritativeness — boot modules ignore their own
    // hard-coded labels and use the registry's labels.
    expect(bootCalls).toHaveLength(registryStub.length);
    for (let i = 0; i < bootCalls.length; i++) {
      const call = bootCalls[i];
      const entry = registryStub[i];
      expect(call?.deps.connectionStore).toBe(connectionStore);
      expect(call?.deps.notificationHandler).toBe(notificationHandler);
      expect(call?.deps.channel).toBe(entry?.channel);
      expect(call?.deps.subtype).toBe(entry?.subtype);
    }
    expect(bootCalls.map((c) => c.channel)).toEqual(
      registryStub.map((entry) => entry.channel),
    );
  });
});
