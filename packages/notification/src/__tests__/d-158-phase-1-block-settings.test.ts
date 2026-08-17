import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  createAskStore,
  createNotificationBlock,
  createNotificationSettingsStore,
  type AskOption,
  type Channel,
  type ChannelCapability,
  type ChannelName,
  type ChannelReadinessProbe,
  type NotificationMessage,
  type NotificationSettings,
  type NotificationSettingsStore,
  type PendingAsk,
  type RemoteChannelName,
} from '../index.js';

const message: NotificationMessage = {
  title: 'Approve transfer',
  text: 'Approve the pending transfer?',
  link_url: '/asks/transfer',
};

const options: readonly AskOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];

const handlerRef = {
  kind: 'gateway.preflight',
  payload: { checkpoint_id: 'checkpoint-1', recipe_id: 'recipe-1' },
};

interface RecordedAskDelivery {
  ask_id: string;
  message: NotificationMessage;
  options: readonly AskOption[];
}

interface RecordedChannel extends Channel {
  notifyMessages: NotificationMessage[];
  askDeliveries: RecordedAskDelivery[];
  closes: string[];
}

const DEFAULT_CAPABILITY: Readonly<Record<ChannelName, ChannelCapability>> = {
  ui:       'inline',
  bridge:   'notify-only',
  slack:    'inline',
  telegram: 'inline',
  whatsapp: 'inline',
  discord: 'inline',
  teams: 'landing-page',
  email:    'landing-page',
};

const createRecordedChannel = (
  name: ChannelName,
  capability: ChannelCapability = DEFAULT_CAPABILITY[name],
): RecordedChannel => {
  const channel: RecordedChannel = {
    name,
    capability,
    owns_llm_egress: name === 'ui',
    notifyMessages: [],
    askDeliveries: [],
    closes: [],
    async deliverNotify(nextMessage) {
      channel.notifyMessages.push(nextMessage);
    },
    async deliverAsk(ask_id, nextMessage, nextOptions) {
      channel.askDeliveries.push({
        ask_id,
        message: nextMessage,
        options: nextOptions,
      });
    },
    async closeAsk(ask_id) {
      channel.closes.push(ask_id);
    },
  };
  return channel;
};

const createSettingsStore = async (
  ...enabled: RemoteChannelName[]
): Promise<NotificationSettingsStore> => {
  const store = createNotificationSettingsStore(
    createInMemoryCollection<NotificationSettings>(),
  );
  for (const channel of enabled)
    await store.setChannelMode(channel, { notification: true, approval: true });
  return store;
};

describe('D-158 P1 NotificationBlock settings fan-out', () => {
  it('throws when the wired channels do not include the always-on ui channel', async () => {
    expect(() => {
      createNotificationBlock({
        askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
        channels: [createRecordedChannel('slack')],
        settingsStore: createNotificationSettingsStore(
          createInMemoryCollection<NotificationSettings>(),
        ),
      });
    }).toThrow(/always-on .ui. channel/);
  });

  it('notify delivers only to settings-enabled channels and observes a later slack enable', async () => {
    const settingsStore = await createSettingsStore();
    const ui = createRecordedChannel('ui');
    const slack = createRecordedChannel('slack');
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [ui, slack],
      settingsStore,
      mintAskId: () => 'ask-unused',
    });

    await block.notify(message);
    await settingsStore.setChannelMode('slack', {
      notification: true,
      approval: true,
    });
    await block.notify({ ...message, text: 'Slack is now enabled.' });

    expect(ui.notifyMessages).toEqual([
      message,
      { ...message, text: 'Slack is now enabled.' },
    ]);
    expect(slack.notifyMessages).toEqual([
      { ...message, text: 'Slack is now enabled.' },
    ]);
  });

  it('ask persists and delivers the settings-enabled subset when slack is disabled', async () => {
    const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
    const ui = createRecordedChannel('ui');
    const slack = createRecordedChannel('slack');
    const block = createNotificationBlock({
      askStore,
      channels: [ui, slack],
      settingsStore: await createSettingsStore(),
      now: () => 1111,
      mintAskId: () => 'ask-ui-only',
    });

    await block.ask(message, options, handlerRef);

    await expect(askStore.get('ask-ui-only')).resolves.toMatchObject({
      ask_id: 'ask-ui-only',
      status: 'open',
      fanout_channels: ['ui'],
      created_at: 1111,
    });
    expect(ui.askDeliveries).toEqual([
      { ask_id: 'ask-ui-only', message, options },
    ]);
    expect(slack.askDeliveries).toEqual([]);
  });

  it('ask persists and delivers ui plus slack when slack is enabled', async () => {
    const askStore = createAskStore(createInMemoryCollection<PendingAsk>());
    const ui = createRecordedChannel('ui');
    const slack = createRecordedChannel('slack');
    const block = createNotificationBlock({
      askStore,
      channels: [ui, slack],
      settingsStore: await createSettingsStore('slack'),
      now: () => 2222,
      mintAskId: () => 'ask-ui-slack',
    });

    await block.ask(message, options, handlerRef);

    await expect(askStore.get('ask-ui-slack')).resolves.toMatchObject({
      ask_id: 'ask-ui-slack',
      status: 'open',
      fanout_channels: ['ui', 'slack'],
      created_at: 2222,
    });
    expect(ui.askDeliveries).toEqual([
      { ask_id: 'ask-ui-slack', message, options },
    ]);
    expect(slack.askDeliveries).toEqual([
      { ask_id: 'ask-ui-slack', message, options },
    ]);
  });

  it('recoverPendingAsks re-delivers to persisted fanout channels after live settings disable slack', async () => {
    const askCollection = createInMemoryCollection<PendingAsk>();
    const storeA = createAskStore(askCollection);
    const uiA = createRecordedChannel('ui');
    const slackA = createRecordedChannel('slack');
    const blockA = createNotificationBlock({
      askStore: storeA,
      channels: [uiA, slackA],
      settingsStore: await createSettingsStore('slack'),
      now: () => 3333,
      mintAskId: () => 'ask-recover-slack',
    });
    await blockA.ask(message, options, handlerRef);
    await expect(storeA.get('ask-recover-slack')).resolves.toMatchObject({
      fanout_channels: ['ui', 'slack'],
      status: 'open',
    });

    const storeB = createAskStore(askCollection);
    const uiB = createRecordedChannel('ui');
    const slackB = createRecordedChannel('slack');
    const blockB = createNotificationBlock({
      askStore: storeB,
      channels: [uiB, slackB],
      settingsStore: await createSettingsStore(),
      now: () => 4444,
      mintAskId: () => 'ask-should-not-mint',
    });

    await blockB.recoverPendingAsks();

    expect(uiB.askDeliveries).toEqual([
      { ask_id: 'ask-recover-slack', message, options },
    ]);
    expect(slackB.askDeliveries).toEqual([
      { ask_id: 'ask-recover-slack', message, options },
    ]);
  });

  it('recoverPendingAsks does not add channels enabled after the ask was created', async () => {
    const askCollection = createInMemoryCollection<PendingAsk>();
    const storeA = createAskStore(askCollection);
    const blockA = createNotificationBlock({
      askStore: storeA,
      channels: [createRecordedChannel('ui'), createRecordedChannel('slack')],
      settingsStore: await createSettingsStore(),
      now: () => 5555,
      mintAskId: () => 'ask-recover-ui-only',
    });
    await blockA.ask(message, options, handlerRef);

    const storeB = createAskStore(askCollection);
    const uiB = createRecordedChannel('ui');
    const slackB = createRecordedChannel('slack');
    const blockB = createNotificationBlock({
      askStore: storeB,
      channels: [uiB, slackB],
      settingsStore: await createSettingsStore('slack'),
      now: () => 6666,
      mintAskId: () => 'ask-should-not-mint',
    });

    await blockB.recoverPendingAsks();

    expect(uiB.askDeliveries).toEqual([
      { ask_id: 'ask-recover-ui-only', message, options },
    ]);
    expect(slackB.askDeliveries).toEqual([]);
    await expect(storeB.get('ask-recover-ui-only')).resolves.toMatchObject({
      fanout_channels: ['ui'],
    });
  });
});

describe('D-158 P1 NotificationBlock settings methods', () => {
  it('getNotificationSettings delegates to the block-owned settings store', async () => {
    const settingsStore = await createSettingsStore('email');
    const get = vi.spyOn(settingsStore, 'get');
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [createRecordedChannel('ui')],
      settingsStore,
    });

    await expect(block.getNotificationSettings()).resolves.toEqual({
      ui: true,
      bridge: false,
      slack: { notification: false, approval: false, messenger: false },
      telegram: { notification: false, approval: false, messenger: false },
      whatsapp: { notification: false, approval: false, messenger: false },
      discord: { notification: false, approval: false, messenger: false },
      teams: { notification: false, approval: false, messenger: false },
      email: { notification: true, approval: true, messenger: false },
      bridges: {},
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('describeNotificationChannels delegates through the settings surface and readiness probe', async () => {
    const settingsStore = await createSettingsStore('slack');
    const readinessProbe: ChannelReadinessProbe = vi.fn(
      async (channel) => channel === 'slack',
    );
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [createRecordedChannel('ui'), createRecordedChannel('slack')],
      settingsStore,
      readinessProbe,
    });

    await expect(block.describeNotificationChannels()).resolves.toMatchObject([
      { channel: 'ui', notification: true, approval: true, ready: true },
      { channel: 'bridge', notification: false, approval: false, ready: false },
      { channel: 'slack', notification: true, approval: true, ready: true },
      { channel: 'telegram', notification: false, approval: false, ready: false },
      { channel: 'discord', notification: false, approval: false, ready: false },
      { channel: 'teams', notification: false, approval: false, ready: false },
      { channel: 'email', notification: false, approval: false, ready: false },
    ]);
    expect(readinessProbe).toHaveBeenCalledWith('bridge');
    expect(readinessProbe).toHaveBeenCalledWith('slack');
    expect(readinessProbe).toHaveBeenCalledWith('telegram');
    expect(readinessProbe).toHaveBeenCalledWith('discord');
    expect(readinessProbe).toHaveBeenCalledWith('email');
  });

  it('setNotificationChannelMode delegates successful togglable enables to the settings store', async () => {
    const settingsStore = await createSettingsStore();
    const setChannelMode = vi.spyOn(settingsStore, 'setChannelMode');
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [createRecordedChannel('ui'), createRecordedChannel('slack')],
      settingsStore,
      readinessProbe: () => true,
    });

    await expect(
      block.setNotificationChannelMode('slack', {
        notification: true,
        approval: true,
      }),
    ).resolves.toEqual({
      ok: true,
      settings: {
        ui: true,
        bridge: false,
        slack: { notification: true, approval: true, messenger: false },
        telegram: { notification: false, approval: false, messenger: false },
        whatsapp: { notification: false, approval: false, messenger: false },
        discord: { notification: false, approval: false, messenger: false },
        teams: { notification: false, approval: false, messenger: false },
        email: { notification: false, approval: false, messenger: false },
        bridges: {},
      },
    });
    expect(setChannelMode).toHaveBeenCalledWith('slack', {
      notification: true,
      approval: true,
    });
  });

  it('setNotificationChannelMode surfaces not_ready without writing', async () => {
    const settingsStore = await createSettingsStore();
    const setChannelMode = vi.spyOn(settingsStore, 'setChannelMode');
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [createRecordedChannel('ui'), createRecordedChannel('slack')],
      settingsStore,
      readinessProbe: () => false,
    });

    await expect(
      block.setNotificationChannelMode('slack', {
        notification: true,
        approval: true,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'not_ready',
      channel: 'slack',
    });
    expect(setChannelMode).not.toHaveBeenCalled();
  });
});
