import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';

import {
  createNotificationBlock,
  createNotificationSettings,
  createNotificationSettingsStore,
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_SETTINGS_KEY,
  type AskStore,
  type BridgeRosterProbe,
  type Channel,
  type NotificationSettings,
  type NotificationSettingsStore,
} from '../index.js';

interface StoreFixture {
  backing: ReturnType<typeof createInMemoryCollection<NotificationSettings>>;
  store: NotificationSettingsStore;
}

const createStoreFixture = (): StoreFixture => {
  const backing = createInMemoryCollection<NotificationSettings>();
  return {
    backing,
    store: createNotificationSettingsStore(backing),
  };
};

const baseSettings = (
  patch: Partial<NotificationSettings> = {},
): NotificationSettings => ({
  ui: true,
  bridge: false,
  slack: { notification: false, approval: false, messenger: false },
  telegram: { notification: false, approval: false, messenger: false },
  whatsapp: { notification: false, approval: false, messenger: false },
  discord: { notification: false, approval: false, messenger: false },
  teams: { notification: false, approval: false, messenger: false },
  email: { notification: false, approval: false, messenger: false },
  bridges: {},
  ...patch,
});

const uiChannel: Channel = {
  name: 'ui',
  capability: 'inline',
  owns_llm_egress: true,
  deliverNotify: vi.fn(async () => undefined),
  deliverAsk: vi.fn(async () => undefined),
  closeAsk: vi.fn(async () => undefined),
};

const askStore: AskStore = {
  create: vi.fn(async () => undefined),
  recordAnswer: vi.fn(async () => undefined),
  markHandled: vi.fn(async () => undefined),
  cancel: vi.fn(async () => 'not_open' as const),
  pruneHandled: vi.fn(async () => 0),
  get: vi.fn(async () => null),
  listByStatus: vi.fn(async () => []),
  countOpen: vi.fn(async () => 0),
};

describe('D-169 P1 notification bridge mode settings', () => {
  it('keeps DEFAULT_NOTIFICATION_SETTINGS.bridges fresh and cloneDefault per caller', async () => {
    const { store } = createStoreFixture();

    expect(DEFAULT_NOTIFICATION_SETTINGS.bridges).toEqual({});
    const first = await store.get();
    const second = await store.get();

    expect(first.bridges).toEqual({});
    expect(second.bridges).toEqual({});
    expect(first.bridges).not.toBe(second.bridges);
    first.bridges!.mutated = { notification: true, approval: true };
    expect(second.bridges).toEqual({});
    expect(DEFAULT_NOTIFICATION_SETTINGS.bridges).toEqual({});
  });

  it('setBridgeMode upserts from the default mode row and writes through', async () => {
    const { backing, store } = createStoreFixture();

    const result = await store.setBridgeMode('bridge-1', { notification: true });

    expect(result.bridges).toEqual({
      'bridge-1': { notification: true, approval: false },
    });
    await expect(backing.get(NOTIFICATION_SETTINGS_KEY)).resolves.toEqual(result);
  });

  it('setBridgeMode preserves the other mode field on partial patches', async () => {
    const { store } = createStoreFixture();
    await store.setBridgeMode('bridge-1', {
      notification: false,
      approval: true,
    });

    const result = await store.setBridgeMode('bridge-1', {
      notification: true,
    });

    expect(result.bridges?.['bridge-1']).toEqual({
      notification: true,
      approval: true,
    });
  });

  it('serializes bridge mode and channel writes through the same mutex', async () => {
    const { store } = createStoreFixture();

    await Promise.all([
      store.setChannelMode('slack', { notification: true, approval: true }),
      store.setBridgeMode('bridge-a', { notification: true }),
      store.setBridgeMode('bridge-b', { approval: true }),
    ]);

    await expect(store.get()).resolves.toMatchObject({
      slack: { notification: true, approval: true, messenger: false },
      bridges: {
        'bridge-a': { notification: true, approval: false },
        'bridge-b': { notification: false, approval: true },
      },
    });
  });

  it('clearBridgeMode removes one bridge entry and no-ops for absent ids', async () => {
    const { store } = createStoreFixture();
    await store.setBridgeMode('bridge-a', { notification: true });
    await store.setBridgeMode('bridge-b', { approval: true });

    const cleared = await store.clearBridgeMode('bridge-a');
    expect(cleared.bridges).toEqual({
      'bridge-b': { notification: false, approval: true },
    });

    const noOp = await store.clearBridgeMode('missing');
    expect(noOp).toEqual(cleared);
  });

  it('read-merges a pre-D-169 stored row to an always-present bridges map', async () => {
    const { backing, store } = createStoreFixture();
    await backing.set(NOTIFICATION_SETTINGS_KEY, {
      ui: true,
      slack: { notification: true, approval: true, messenger: false },
      telegram: { notification: false, approval: false, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      teams: { notification: false, approval: false, messenger: false },
      email: { notification: false, approval: false, messenger: false },
    } as NotificationSettings);

    await expect(store.get()).resolves.toEqual({
      ui: true,
      bridge: false,
      slack: { notification: true, approval: true, messenger: false },
      telegram: { notification: false, approval: false, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      teams: { notification: false, approval: false, messenger: false },
      email: { notification: false, approval: false, messenger: false },
      bridges: {},
    });
  });

  it('mutating a read bridges map does not poison the default constant', async () => {
    const { store } = createStoreFixture();

    const settings = await store.get();
    settings.bridges!.local = { notification: true, approval: true };

    expect(DEFAULT_NOTIFICATION_SETTINGS.bridges).toEqual({});
    await expect(store.get()).resolves.toMatchObject({ bridges: {} });
  });

  it('describeBridges returns [] when no roster probe is injected', async () => {
    const surface = createNotificationSettings({
      store: createNotificationSettingsStore(
        createInMemoryCollection<NotificationSettings>(),
      ),
    });

    await expect(surface.describeBridges()).resolves.toEqual([]);
  });

  it('describeBridges merges roster rows with stored bridge modes', async () => {
    const store = createNotificationSettingsStore(
      createInMemoryCollection<NotificationSettings>(),
    );
    await store.setBridgeMode('bridge-1', { notification: true });
    const roster: BridgeRosterProbe = vi.fn(async () => [
      {
        client_token_id: 'bridge-1',
        label: 'Bridge1 Chrome on macOS',
        added_at: 1_700_000_000,
        connected: true,
      },
      {
        client_token_id: 'bridge-2',
        label: 'Bridge2 Edge on Windows',
        connected: false,
      },
    ]);
    const surface = createNotificationSettings({
      store,
      bridgeRosterProbe: roster,
    });

    await expect(surface.describeBridges()).resolves.toEqual([
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
        modes: { notification: false, approval: false },
        connected: false,
      },
    ]);
  });

  it('setBridgeMode returns bridge_unknown when the roster does not list the id', async () => {
    const store = createNotificationSettingsStore(
      createInMemoryCollection<NotificationSettings>(),
    );
    const surface = createNotificationSettings({
      store,
      bridgeRosterProbe: async () => [
        {
          client_token_id: 'known',
          label: 'Known bridge',
          connected: true,
        },
      ],
    });

    await expect(
      surface.setBridgeMode('missing', { notification: true }),
    ).resolves.toEqual({
      ok: false,
      reason: 'bridge_unknown',
      bridge_id: 'missing',
    });
    await expect(store.get()).resolves.toMatchObject({ bridges: {} });
  });

  it('setBridgeMode persists for a known roster bridge', async () => {
    const store = createNotificationSettingsStore(
      createInMemoryCollection<NotificationSettings>(),
    );
    const surface = createNotificationSettings({
      store,
      bridgeRosterProbe: async () => [
        {
          client_token_id: 'bridge-1',
          label: 'Bridge1',
          connected: true,
        },
      ],
    });

    await expect(
      surface.setBridgeMode('bridge-1', { approval: true }),
    ).resolves.toMatchObject({
      ok: true,
      settings: {
        bridges: {
          'bridge-1': { notification: false, approval: true },
        },
      },
    });
  });

  it('NotificationBlock delegates describeNotificationBridges and setNotificationBridgeMode', async () => {
    const store: NotificationSettingsStore = {
      get: vi.fn(async () =>
        baseSettings({
          bridges: {
            'bridge-1': { notification: false, approval: true },
          },
        }),
      ),
      setChannelMode: vi.fn(),
      setVerificationPhrase: vi.fn(),
      setBridgeMode: vi.fn(async (bridge_id, patch) =>
        baseSettings({
          bridges: {
            [bridge_id]: {
              notification: patch.notification ?? false,
              approval: patch.approval ?? false,
            },
          },
        }),
      ),
      clearBridgeMode: vi.fn(),
    };
    const roster = vi.fn(async () => [
      {
        client_token_id: 'bridge-1',
        label: 'Bridge1',
        connected: true,
      },
    ]);
    const block = createNotificationBlock({
      askStore,
      channels: [uiChannel],
      settingsStore: store,
      bridgeRosterProbe: roster,
    });

    await expect(block.describeNotificationBridges()).resolves.toEqual([
      {
        client_token_id: 'bridge-1',
        label: 'Bridge1',
        modes: { notification: false, approval: true },
        connected: true,
      },
    ]);
    await expect(
      block.setNotificationBridgeMode('bridge-1', { notification: true }),
    ).resolves.toMatchObject({ ok: true });
    expect(store.setBridgeMode).toHaveBeenCalledWith('bridge-1', {
      notification: true,
    });
  });
});
