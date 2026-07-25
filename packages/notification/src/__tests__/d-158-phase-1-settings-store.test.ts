import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it } from 'vitest';
import {
  createNotificationSettingsStore,
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_SETTINGS_KEY,
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

describe('D-158 P1 NotificationSettingsStore', () => {
  it('get returns the default settings record when nothing is persisted', async () => {
    const { store } = createStoreFixture();

    await expect(store.get()).resolves.toEqual(DEFAULT_NOTIFICATION_SETTINGS);
  });

  it('setChannelMode writes one togglable channel and returns the new record', async () => {
    const { backing, store } = createStoreFixture();

    const result = await store.setChannelMode('slack', {
      notification: true,
      approval: true,
    });

    expect(result).toEqual({
      ui: true,
      bridge: false,
      slack: { notification: true, approval: true, messenger: false },
      telegram: { notification: false, approval: false, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      email: { notification: false, approval: false, messenger: false },
      bridges: {},
    });
    await expect(backing.get(NOTIFICATION_SETTINGS_KEY)).resolves.toEqual(result);
  });

  it('setChannelMode toggles bridge independently of the other channels', async () => {
    const { store } = createStoreFixture();
    await store.setChannelMode('slack', { notification: true, approval: true });

    const result = await store.setChannelMode('bridge', { notification: true });

    expect(result).toEqual({
      ui: true,
      bridge: true,
      slack: { notification: true, approval: true, messenger: false },
      telegram: { notification: false, approval: false, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      email: { notification: false, approval: false, messenger: false },
      bridges: {},
    });
    await expect(store.get()).resolves.toEqual(result);
  });

  it('setChannelMode updates one channel while preserving the other toggles', async () => {
    const { store } = createStoreFixture();
    await store.setChannelMode('slack', { notification: true, approval: true });
    await store.setChannelMode('telegram', { notification: true, approval: true });

    const result = await store.setChannelMode('slack', {
      notification: false,
      approval: false,
    });

    expect(result).toEqual({
      ui: true,
      bridge: false,
      slack: { notification: false, approval: false, messenger: false },
      telegram: { notification: true, approval: true, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      email: { notification: false, approval: false, messenger: false },
      bridges: {},
    });
    await expect(store.get()).resolves.toEqual(result);
  });

  it('get forces ui true even when the persisted row is malformed', async () => {
    const { backing, store } = createStoreFixture();
    await backing.set(NOTIFICATION_SETTINGS_KEY, {
      ui: false,
      slack: { notification: true, approval: true, messenger: false },
      telegram: { notification: false, approval: false, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      email: { notification: true, approval: true, messenger: false },
    } as any);

    await expect(store.get()).resolves.toEqual({
      ui: true,
      bridge: false,
      slack: { notification: true, approval: true, messenger: false },
      telegram: { notification: false, approval: false, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      email: { notification: true, approval: true, messenger: false },
      bridges: {},
    });
  });

  it('get back-fills bridge=false when a pre-D-163 row is persisted without it', async () => {
    const { backing, store } = createStoreFixture();
    await backing.set(NOTIFICATION_SETTINGS_KEY, {
      ui: true,
      slack: { notification: true, approval: true, messenger: false },
      telegram: { notification: false, approval: false, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      email: { notification: false, approval: false, messenger: false },
    } as any);

    await expect(store.get()).resolves.toEqual({
      ui: true,
      bridge: false,
      slack: { notification: true, approval: true, messenger: false },
      telegram: { notification: false, approval: false, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      email: { notification: false, approval: false, messenger: false },
      bridges: {},
    });
  });

  it('serializes concurrent toggles so different channels do not lose updates', async () => {
    const { store } = createStoreFixture();

    const [slackResult, telegramResult] = await Promise.all([
      store.setChannelMode('slack', { notification: true, approval: true }),
      store.setChannelMode('telegram', { notification: true, approval: true }),
    ]);

    expect(slackResult.slack).toEqual({ notification: true, approval: true, messenger: false });
    expect(telegramResult).toEqual({
      ui: true,
      bridge: false,
      slack: { notification: true, approval: true, messenger: false },
      telegram: { notification: true, approval: true, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      email: { notification: false, approval: false, messenger: false },
      bridges: {},
    });
    await expect(store.get()).resolves.toEqual({
      ui: true,
      bridge: false,
      slack: { notification: true, approval: true, messenger: false },
      telegram: { notification: true, approval: true, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      email: { notification: false, approval: false, messenger: false },
      bridges: {},
    });
  });
});
