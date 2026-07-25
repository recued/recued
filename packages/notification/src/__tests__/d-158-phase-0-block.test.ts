import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  createAskStore,
  createNotificationBlock,
  createNotificationSettingsStore,
  createUiChannel,
  type AskOption,
  type Channel,
  type ChannelCapability,
  type ChannelName,
  type NotificationMessage,
  type NotificationSettings,
  type NotificationSettingsStore,
  type PendingAsk,
  type RemoteChannelName,
  type UiNotificationEvent,
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

interface ChannelHooks {
  deliverNotify?: (message: NotificationMessage) => void | Promise<void>;
  deliverAsk?: (
    ask_id: string,
    message: NotificationMessage,
    options: readonly AskOption[],
  ) => void | Promise<void>;
  closeAsk?: (ask_id: string) => void | Promise<void>;
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
  hooks: ChannelHooks = {},
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
      await hooks.deliverNotify?.(nextMessage);
    },
    async deliverAsk(ask_id, nextMessage, nextOptions) {
      channel.askDeliveries.push({
        ask_id,
        message: nextMessage,
        options: nextOptions,
      });
      await hooks.deliverAsk?.(ask_id, nextMessage, nextOptions);
    },
    async closeAsk(ask_id) {
      channel.closes.push(ask_id);
      await hooks.closeAsk?.(ask_id);
    },
  };
  return channel;
};

const mintSequence = (ids: string[]): (() => string) => {
  const remaining = [...ids];
  return () => {
    const next = remaining.shift();
    if (next === undefined) throw new Error('unexpected ask_id mint');
    return next;
  };
};

const nowSequence = (times: number[]): (() => number) => {
  const remaining = [...times];
  return () => {
    const next = remaining.shift();
    if (next === undefined) throw new Error('unexpected clock read');
    return next;
  };
};

/** A fresh block-owned settings store. P1 gates fan-out on the settings
 *  record (`ui` is always on); `enable` pre-toggles the remote channels
 *  a multi-channel test exercises so `ask` / `notify` actually fan out
 *  to them. With no args it is the default record — `ui` only. */
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

describe('D-158 P0 NotificationBlock notify', () => {
  it('fans out to ui, emits notification.notify, and stays best-effort over a throwing channel', async () => {
    const events: UiNotificationEvent[] = [];
    const throwing = createRecordedChannel('email', {
      deliverNotify: () => {
        throw new Error('email unavailable');
      },
    });
    const ui = createUiChannel({
      busSink: (event) => events.push(event),
    });
    const recorder = createRecordedChannel('slack');
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [throwing, ui, recorder],
      settingsStore: await settingsWith('email', 'slack'),
      now: () => 1000,
      mintAskId: () => 'ask-unused',
    });

    await expect(block.notify(message)).resolves.toBeUndefined();

    expect(throwing.notifyMessages).toEqual([message]);
    expect(events).toEqual([{ kind: 'notification.notify', message }]);
    expect(recorder.notifyMessages).toEqual([message]);
  });
});

describe('D-158 P0 NotificationBlock ask', () => {
  it('persists an open PendingAsk with fanout_channels before delivery', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    let rowDuringDelivery: PendingAsk | null = null;
    const ui = createRecordedChannel('ui', {
      deliverAsk: async (ask_id) => {
        rowDuringDelivery = await store.get(ask_id);
      },
    });
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui],
      settingsStore: await settingsWith(),
      now: () => 1111,
      mintAskId: () => 'ask-before-delivery',
    });

    await block.ask(message, options, handlerRef);

    expect(rowDuringDelivery).toMatchObject({
      ask_id: 'ask-before-delivery',
      status: 'open',
      message,
      options,
      handler_kind: handlerRef.kind,
      handler_payload: handlerRef.payload,
      fanout_channels: ['ui'],
      created_at: 1111,
    });
    expect(rowDuringDelivery).not.toHaveProperty('delivered_channels');
    expect(ui.askDeliveries).toEqual([
      { ask_id: 'ask-before-delivery', message, options },
    ]);
  });

  it('emits a notification.ask card and resolves exactly with ask_id, never an answer', async () => {
    const events: UiNotificationEvent[] = [];
    const ui = createUiChannel({ busSink: (event) => events.push(event) });
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [ui],
      settingsStore: await settingsWith(),
      now: () => 2222,
      mintAskId: () => 'ask-card',
    });

    const promise = block.ask(message, options, handlerRef);
    const expectAskPromise = (_promise: Promise<{ ask_id: string }>): void => undefined;
    expectAskPromise(promise);
    const result = await promise;

    expect(result).toEqual({ ask_id: 'ask-card' });
    expect(Object.keys(result)).toEqual(['ask_id']);
    expect(events).toEqual([
      { kind: 'notification.ask', ask_id: 'ask-card', message, options },
    ]);
  });

  it('leaves a durable open row after ask returns', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const block = createNotificationBlock({
      askStore: store,
      channels: [createRecordedChannel('ui')],
      settingsStore: await settingsWith(),
      now: () => 3333,
      mintAskId: () => 'ask-durable',
    });

    await block.ask(message, options, handlerRef);

    expect(await store.get('ask-durable')).toMatchObject({
      ask_id: 'ask-durable',
      status: 'open',
      fanout_channels: ['ui'],
    });
  });
});

describe('D-158 P0 NotificationBlock submitAnswer', () => {
  it('transitions open to handled, closes every fanout channel, and dispatches the stripped answer', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const ui = createRecordedChannel('ui');
    const email = createRecordedChannel('email');
    const handler = vi.fn();
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui, email],
      settingsStore: await settingsWith('email'),
      now: nowSequence([1000, 2000]),
      mintAskId: () => 'ask-happy',
    });
    block.registerAskHandler(handlerRef.kind, handler);

    await block.ask(message, options, handlerRef);
    await block.submitAnswer({
      ask_id: 'ask-happy',
      option: 'approve',
      via: 'ui',
    });

    expect(ui.closes).toEqual(['ask-happy']);
    expect(email.closes).toEqual(['ask-happy']);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(handlerRef.payload, {
      option: 'approve',
      answered_at: 2000,
    });
    expect(await store.get('ask-happy')).toMatchObject({
      status: 'handled',
      answer: { option: 'approve', answered_at: 2000 },
      answered_via: 'ui',
    });
  });

  it('strips answered_via and every channel detail from the handler answer argument', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    const handler = vi.fn();
    const block = createNotificationBlock({
      askStore: store,
      channels: [createRecordedChannel('ui')],
      settingsStore: await settingsWith(),
      now: nowSequence([1000, 2000]),
      mintAskId: () => 'ask-answer-shape',
    });
    block.registerAskHandler(handlerRef.kind, handler);

    await block.ask(message, options, handlerRef);
    await block.submitAnswer({
      ask_id: 'ask-answer-shape',
      option: 'reject',
      via: 'ui',
    });

    const answerArg = handler.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(answerArg).toEqual({ option: 'reject', answered_at: 2000 });
    expect(Object.keys(answerArg).sort()).toEqual(['answered_at', 'option']);
    expect(answerArg).not.toHaveProperty('answered_via');
    expect(answerArg).not.toHaveProperty('via');
    expect(answerArg).not.toHaveProperty('channel');
    expect(answerArg).not.toHaveProperty('channel_message_id');
  });

  it('dedups two sequential replies so the first answer wins and the second is a no-op', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const ui = createRecordedChannel('ui');
    const email = createRecordedChannel('email');
    const handler = vi.fn();
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui, email],
      settingsStore: await settingsWith('email'),
      now: nowSequence([1000, 2000]),
      mintAskId: () => 'ask-sequential-dedup',
    });
    block.registerAskHandler(handlerRef.kind, handler);

    await block.ask(message, options, handlerRef);
    await block.submitAnswer({
      ask_id: 'ask-sequential-dedup',
      option: 'approve',
      via: 'ui',
    });
    await block.submitAnswer({
      ask_id: 'ask-sequential-dedup',
      option: 'reject',
      via: 'email',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(handlerRef.payload, {
      option: 'approve',
      answered_at: 2000,
    });
    expect(ui.closes).toEqual(['ask-sequential-dedup']);
    expect(email.closes).toEqual(['ask-sequential-dedup']);
    expect(await store.get('ask-sequential-dedup')).toMatchObject({
      status: 'handled',
      answer: { option: 'approve', answered_at: 2000 },
      answered_via: 'ui',
    });
  });

  it('dedups concurrent replies through the per-ask serializer', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const ui = createRecordedChannel('ui');
    const email = createRecordedChannel('email');
    const handler = vi.fn();
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui, email],
      settingsStore: await settingsWith('email'),
      now: nowSequence([1000, 2000]),
      mintAskId: () => 'ask-concurrent-dedup',
    });
    block.registerAskHandler(handlerRef.kind, handler);

    await block.ask(message, options, handlerRef);
    await Promise.all([
      block.submitAnswer({
        ask_id: 'ask-concurrent-dedup',
        option: 'approve',
        via: 'ui',
      }),
      block.submitAnswer({
        ask_id: 'ask-concurrent-dedup',
        option: 'reject',
        via: 'email',
      }),
    ]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(handlerRef.payload, {
      option: 'approve',
      answered_at: 2000,
    });
    expect(ui.closes).toEqual(['ask-concurrent-dedup']);
    expect(email.closes).toEqual(['ask-concurrent-dedup']);
    expect(await store.get('ask-concurrent-dedup')).toMatchObject({
      status: 'handled',
      answer: { option: 'approve', answered_at: 2000 },
      answered_via: 'ui',
    });
  });

  it('no-ops for an unknown ask_id without throwing, closing, or dispatching', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    const ui = createRecordedChannel('ui');
    const handler = vi.fn();
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui],
      settingsStore: await settingsWith(),
      now: () => 1000,
      mintAskId: () => 'ask-unused',
    });
    block.registerAskHandler(handlerRef.kind, handler);

    await expect(
      block.submitAnswer({ ask_id: 'ask-missing', option: 'approve', via: 'ui' }),
    ).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(ui.closes).toEqual([]);
  });

  it('no-ops for an already-answered ask without throwing, closing, or dispatching', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const ui = createRecordedChannel('ui');
    const handler = vi.fn();
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui],
      settingsStore: await settingsWith(),
      now: nowSequence([1000]),
      mintAskId: () => 'ask-already-answered',
    });
    block.registerAskHandler(handlerRef.kind, handler);
    await block.ask(message, options, handlerRef);
    await store.recordAnswer(
      'ask-already-answered',
      { option: 'approve', answered_at: 2000 },
      'ui',
    );

    await expect(
      block.submitAnswer({
        ask_id: 'ask-already-answered',
        option: 'reject',
        via: 'ui',
      }),
    ).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(ui.closes).toEqual([]);
    expect(await store.get('ask-already-answered')).toMatchObject({
      status: 'answered',
      answer: { option: 'approve', answered_at: 2000 },
    });
  });

  it('no-ops for an option id the ask did not offer', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const ui = createRecordedChannel('ui');
    const handler = vi.fn();
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui],
      settingsStore: await settingsWith(),
      now: nowSequence([1000]),
      mintAskId: () => 'ask-invalid-option',
    });
    block.registerAskHandler(handlerRef.kind, handler);

    await block.ask(message, options, handlerRef);
    await expect(
      block.submitAnswer({
        ask_id: 'ask-invalid-option',
        option: 'maybe',
        via: 'ui',
      }),
    ).resolves.toBeUndefined();

    expect(handler).not.toHaveBeenCalled();
    expect(ui.closes).toEqual([]);
    const row = await store.get('ask-invalid-option');
    expect(row).toMatchObject({ status: 'open' });
    expect(row).not.toHaveProperty('answer');
    expect(row).not.toHaveProperty('answered_via');
  });
});

describe('D-158 P0 NotificationBlock restart and recovery', () => {
  it('uses persisted handler kind and payload after restart instead of carrying a closure', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const storeA = createAskStore(collection);
    const blockA = createNotificationBlock({
      askStore: storeA,
      channels: [createRecordedChannel('ui')],
      settingsStore: await settingsWith(),
      now: () => 1000,
      mintAskId: () => 'ask-restart',
    });
    const preRestartHandler = vi.fn();
    blockA.registerAskHandler(handlerRef.kind, preRestartHandler);
    await blockA.ask(message, options, handlerRef);

    const storeB = createAskStore(collection);
    const postRestartHandler = vi.fn();
    const blockB = createNotificationBlock({
      askStore: storeB,
      channels: [createRecordedChannel('ui')],
      settingsStore: await settingsWith(),
      now: () => 9000,
      mintAskId: () => 'ask-should-not-mint',
    });
    blockB.registerAskHandler(handlerRef.kind, postRestartHandler);

    await blockB.submitAnswer({
      ask_id: 'ask-restart',
      option: 'approve',
      via: 'ui',
    });

    expect(preRestartHandler).not.toHaveBeenCalled();
    expect(postRestartHandler).toHaveBeenCalledTimes(1);
    expect(postRestartHandler).toHaveBeenCalledWith(handlerRef.payload, {
      option: 'approve',
      answered_at: 9000,
    });
    expect(await storeB.get('ask-restart')).toMatchObject({ status: 'handled' });
  });

  it('recoverPendingAsks re-delivers open asks to the ui channel', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const storeA = createAskStore(collection);
    const eventsA: UiNotificationEvent[] = [];
    const blockA = createNotificationBlock({
      askStore: storeA,
      channels: [createUiChannel({ busSink: (event) => eventsA.push(event) })],
      settingsStore: await settingsWith(),
      now: () => 1000,
      mintAskId: () => 'ask-open-recovery',
    });
    await blockA.ask(message, options, handlerRef);

    const eventsB: UiNotificationEvent[] = [];
    const storeB = createAskStore(collection);
    const blockB = createNotificationBlock({
      askStore: storeB,
      channels: [createUiChannel({ busSink: (event) => eventsB.push(event) })],
      settingsStore: await settingsWith(),
      now: () => 2000,
      mintAskId: () => 'ask-should-not-mint',
    });

    await blockB.recoverPendingAsks();

    expect(eventsA).toEqual([
      { kind: 'notification.ask', ask_id: 'ask-open-recovery', message, options },
    ]);
    expect(eventsB).toEqual([
      { kind: 'notification.ask', ask_id: 'ask-open-recovery', message, options },
    ]);
    expect(await storeB.get('ask-open-recovery')).toMatchObject({
      status: 'open',
    });
  });

  it('recoverPendingAsks re-closes answered asks before re-dispatching their handler', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const storeA = createAskStore(collection);
    const blockA = createNotificationBlock({
      askStore: storeA,
      channels: [createRecordedChannel('ui'), createRecordedChannel('email')],
      settingsStore: await settingsWith('email'),
      now: () => 1000,
      mintAskId: () => 'ask-answered-recovery',
    });
    await blockA.ask(message, options, handlerRef);
    await storeA.recordAnswer(
      'ask-answered-recovery',
      { option: 'approve', answered_at: 2000 },
      'email',
    );

    const uiB = createRecordedChannel('ui');
    const emailB = createRecordedChannel('email');
    const handler = vi.fn();
    const storeB = createAskStore(collection);
    const blockB = createNotificationBlock({
      askStore: storeB,
      channels: [uiB, emailB],
      settingsStore: await settingsWith(),
      now: () => 3000,
      mintAskId: () => 'ask-should-not-mint',
    });
    blockB.registerAskHandler(handlerRef.kind, handler);

    await blockB.recoverPendingAsks();

    expect(uiB.closes).toEqual(['ask-answered-recovery']);
    expect(emailB.closes).toEqual(['ask-answered-recovery']);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(handlerRef.payload, {
      option: 'approve',
      answered_at: 2000,
    });
    expect(await storeB.get('ask-answered-recovery')).toMatchObject({
      status: 'handled',
    });
  });
});

describe('D-158 P0 NotificationBlock remaining invariants', () => {
  it('keeps an old open ask answerable after an arbitrary clock advance', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    let clock = 1000;
    const handler = vi.fn();
    const block = createNotificationBlock({
      askStore: store,
      channels: [createRecordedChannel('ui')],
      settingsStore: await settingsWith(),
      now: () => clock,
      mintAskId: () => 'ask-no-timeout',
    });
    block.registerAskHandler(handlerRef.kind, handler);

    await block.ask(message, options, handlerRef);
    clock = 1000 + (1000 * 60 * 60 * 24 * 365 * 50);
    await block.submitAnswer({
      ask_id: 'ask-no-timeout',
      option: 'approve',
      via: 'ui',
    });

    expect(handler).toHaveBeenCalledWith(handlerRef.payload, {
      option: 'approve',
      answered_at: clock,
    });
    expect(await store.get('ask-no-timeout')).toMatchObject({
      status: 'handled',
    });
  });

  it('countOutstandingAsks counts open asks only', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const handler = vi.fn();
    const block = createNotificationBlock({
      askStore: store,
      channels: [createRecordedChannel('ui')],
      settingsStore: await settingsWith(),
      now: nowSequence([1000, 1001, 2000]),
      mintAskId: mintSequence(['ask-count-1', 'ask-count-2']),
    });
    block.registerAskHandler(handlerRef.kind, handler);

    await block.ask(message, options, handlerRef);
    await block.ask(message, options, handlerRef);
    expect(await block.countOutstandingAsks()).toBe(2);

    await block.submitAnswer({
      ask_id: 'ask-count-1',
      option: 'approve',
      via: 'ui',
    });

    expect(await block.countOutstandingAsks()).toBe(1);
  });

  it('registerAskHandler throws on a duplicate handler kind', async () => {
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [createRecordedChannel('ui')],
      settingsStore: await settingsWith(),
      now: () => 1000,
      mintAskId: () => 'ask-unused',
    });

    block.registerAskHandler('gateway.preflight', vi.fn());

    expect(() => {
      block.registerAskHandler('gateway.preflight', vi.fn());
    }).toThrow(/already registered/);
  });
});
