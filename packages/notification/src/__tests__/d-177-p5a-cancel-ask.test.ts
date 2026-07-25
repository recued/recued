/** D-177 P5a AskStore and NotificationBlock cancelAsk tests. */

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
  type NewPendingAsk,
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

const settingsWith = async (
  ...enable: RemoteChannelName[]
): Promise<NotificationSettingsStore> => {
  const store = createNotificationSettingsStore(
    createInMemoryCollection<NotificationSettings>(),
  );
  for (const channel of enable)
    await store.setChannelMode(channel, { notification: true, approval: true });
  return store;
};

const nowSequence = (times: number[]): (() => number) => {
  const remaining = [...times];
  return () => {
    const next = remaining.shift();
    if (next === undefined) throw new Error('unexpected clock read');
    return next;
  };
};

const makeAsk = (
  ask_id: string,
  created_at = 1000,
): NewPendingAsk => ({
  ask_id,
  message: { text: `Question ${ask_id}` },
  options,
  handler_kind: handlerRef.kind,
  handler_payload: handlerRef.payload,
  fanout_channels: ['ui'],
  created_at,
});

describe('D-177 P5a AskStore.cancel', () => {
  it('cancels an open ask and transitions it to handled', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    await store.create(makeAsk('ask-open'));

    await expect(store.cancel('ask-open')).resolves.toBe('cancelled');

    expect(await store.get('ask-open')).toMatchObject({
      ask_id: 'ask-open',
      status: 'handled',
    });
    expect(await store.get('ask-open')).not.toHaveProperty('answer');
    expect(await store.countOpen()).toBe(0);
  });

  it('returns not_open for an already-answered ask', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    await store.create(makeAsk('ask-answered'));
    await store.recordAnswer(
      'ask-answered',
      { option: 'approve', answered_at: 2000 },
      'ui',
    );

    await expect(store.cancel('ask-answered')).resolves.toBe('not_open');

    expect(await store.get('ask-answered')).toMatchObject({
      status: 'answered',
      answer: { option: 'approve', answered_at: 2000 },
    });
  });

  it('returns not_open for an already-handled ask', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    await store.create(makeAsk('ask-handled'));
    await store.recordAnswer(
      'ask-handled',
      { option: 'approve', answered_at: 2000 },
      'ui',
    );
    await store.markHandled('ask-handled');

    await expect(store.cancel('ask-handled')).resolves.toBe('not_open');

    expect(await store.get('ask-handled')).toMatchObject({
      status: 'handled',
      answer: { option: 'approve', answered_at: 2000 },
    });
  });

  it('returns not_open for an unknown ask id', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());

    await expect(store.cancel('ask-missing')).resolves.toBe('not_open');
  });
});

describe('D-177 P5a NotificationBlock.cancelAsk', () => {
  it('closes the ask on every fanout channel after cancellation', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    const ui = createRecordedChannel('ui');
    const email = createRecordedChannel('email');
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui, email],
      settingsStore: await settingsWith('email'),
      now: () => 1000,
      mintAskId: () => 'ask-cancel',
    });

    await block.ask(message, options, handlerRef);
    await expect(block.cancelAsk('ask-cancel')).resolves.toBe('cancelled');

    expect(ui.closes).toEqual(['ask-cancel']);
    expect(email.closes).toEqual(['ask-cancel']);
    expect(await store.get('ask-cancel')).toMatchObject({ status: 'handled' });
  });

  it('lets an answer win before cancel; the handler runs and cancel returns not_open', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    const ui = createRecordedChannel('ui');
    const handler = vi.fn();
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui],
      settingsStore: await settingsWith(),
      now: nowSequence([1000, 2000]),
      mintAskId: () => 'ask-answer-first',
    });
    block.registerAskHandler(handlerRef.kind, handler);

    await block.ask(message, options, handlerRef);
    await block.submitAnswer({
      ask_id: 'ask-answer-first',
      option: 'approve',
      via: 'ui',
    });

    await expect(block.cancelAsk('ask-answer-first')).resolves.toBe('not_open');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(handlerRef.payload, {
      option: 'approve',
      answered_at: 2000,
    });
    expect(ui.closes).toEqual(['ask-answer-first']);
    expect(await store.get('ask-answer-first')).toMatchObject({
      status: 'handled',
      answer: { option: 'approve', answered_at: 2000 },
    });
  });

  it('lets cancel win before submitAnswer; later answers are no-ops', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    const ui = createRecordedChannel('ui');
    const handler = vi.fn();
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui],
      settingsStore: await settingsWith(),
      now: () => 1000,
      mintAskId: () => 'ask-cancel-first',
    });
    block.registerAskHandler(handlerRef.kind, handler);

    await block.ask(message, options, handlerRef);
    await expect(block.cancelAsk('ask-cancel-first')).resolves.toBe('cancelled');
    await expect(block.submitAnswer({
      ask_id: 'ask-cancel-first',
      option: 'approve',
      via: 'ui',
    })).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(ui.closes).toEqual(['ask-cancel-first']);
    expect(await store.get('ask-cancel-first')).toMatchObject({ status: 'handled' });
    expect(await store.get('ask-cancel-first')).not.toHaveProperty('answer');
  });
});
