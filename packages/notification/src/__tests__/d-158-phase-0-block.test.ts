import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  createAskStore,
  createNotificationBlock,
  createNotificationSettingsStore,
  createUiChannel,
  type AskOption,
  type AskExtras,
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
  extras?: AskExtras;
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
    extras?: AskExtras,
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
  teams: 'landing-page',
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
    async deliverAsk(ask_id, nextMessage, nextOptions, extras) {
      channel.askDeliveries.push({
        ask_id,
        message: nextMessage,
        options: nextOptions,
        ...(extras !== undefined ? { extras } : {}),
      });
      await hooks.deliverAsk?.(ask_id, nextMessage, nextOptions, extras);
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

  it('reuses an exact host-reserved ask id without raising a second decision', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    const ui = createRecordedChannel('ui');
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui],
      settingsStore: await settingsWith(),
      now: () => 4444,
      mintAskId: () => 'ask-must-not-be-minted',
    });
    const extras = { reserved_ask_id: 'ask-reserved-capability' } as const;

    await expect(Promise.all([
      block.ask(message, options, handlerRef, undefined, extras),
      block.ask(message, options, handlerRef, undefined, extras),
    ])).resolves.toEqual([
      { ask_id: 'ask-reserved-capability' },
      { ask_id: 'ask-reserved-capability' },
    ]);

    expect(ui.askDeliveries).toHaveLength(1);
    expect(await store.get('ask-reserved-capability')).toMatchObject({
      status: 'open',
      message,
    });
  });

  it('rejects a reserved ask id replay carrying different content', async () => {
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [createRecordedChannel('ui')],
      settingsStore: await settingsWith(),
      now: () => 5555,
    });
    const extras = { reserved_ask_id: 'ask-reserved-conflict' } as const;
    await block.ask(message, options, handlerRef, undefined, extras);

    await expect(block.ask(
      { ...message, text: 'Different decision' },
      options,
      handlerRef,
      undefined,
      extras,
    )).rejects.toThrow(/different ask/);
  });

  it('runs a host persistence hook before delivery and strips host controls from channels', async () => {
    let anchored = false;
    const delivered = vi.fn((
      _askId: string,
      _message: NotificationMessage,
      _options: readonly AskOption[],
      extras?: AskExtras,
    ) => {
      expect(anchored).toBe(true);
      expect(extras).toEqual({ note_prompt: 'optional', body: 'Review body' });
    });
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [createRecordedChannel('ui', { deliverAsk: delivered })],
      settingsStore: await settingsWith(),
      now: () => 5556,
    });

    await block.ask(message, options, handlerRef, undefined, {
      reserved_ask_id: 'ask-host-owned',
      note_prompt: 'optional',
      body: 'Review body',
      on_persisted: (askId) => {
        expect(askId).toBe('ask-host-owned');
        anchored = true;
      },
    });

    expect(delivered).toHaveBeenCalledOnce();
  });

  it('retries an exact reserved ask after the pre-delivery persistence hook fails', async () => {
    const store = createAskStore(createInMemoryCollection<PendingAsk>());
    const ui = createRecordedChannel('ui');
    const hook = vi.fn()
      .mockRejectedValueOnce(new Error('inbox unavailable'))
      .mockResolvedValueOnce(undefined);
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui],
      settingsStore: await settingsWith(),
      now: () => 5557,
    });
    const extras = {
      reserved_ask_id: 'ask-hook-retry',
      on_persisted: hook,
    } as const;

    await expect(block.ask(message, options, handlerRef, undefined, extras))
      .rejects.toThrow(/inbox unavailable/);
    expect(await store.get('ask-hook-retry')).toMatchObject({ status: 'open' });
    expect(ui.askDeliveries).toEqual([]);

    await expect(block.ask(message, options, handlerRef, undefined, extras))
      .resolves.toEqual({ ask_id: 'ask-hook-retry' });
    expect(hook).toHaveBeenCalledTimes(2);
    expect(ui.askDeliveries).toHaveLength(1);
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

  it('prepares every recovered open ask before re-delivery and retries failures', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const blockA = createNotificationBlock({
      askStore: store,
      channels: [createRecordedChannel('ui')],
      settingsStore: await settingsWith(),
      now: () => 1000,
      mintAskId: () => 'ask-prepare-recovery',
    });
    await blockA.ask(message, options, handlerRef);

    const ui = createRecordedChannel('ui');
    const prepare = vi.fn()
      .mockRejectedValueOnce(new Error('inbox mismatch'))
      .mockResolvedValueOnce(undefined);
    const blockB = createNotificationBlock({
      askStore: createAskStore(collection),
      channels: [ui],
      settingsStore: await settingsWith(),
      prepareRecoveredAsk: prepare,
    });

    await expect(blockB.recoverPendingAsks()).rejects.toThrow(/inbox mismatch/);
    expect(ui.askDeliveries).toEqual([]);
    await expect(blockB.recoverPendingAsks()).resolves.toBeUndefined();
    expect(ui.askDeliveries).toHaveLength(1);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('does not re-deliver an open candidate after a concurrent answer closes it', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const trace: string[] = [];
    const ui = createRecordedChannel('ui', {
      deliverAsk: () => { trace.push('deliver'); },
      closeAsk: () => { trace.push('close'); },
    });
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui],
      settingsStore: await settingsWith(),
      now: () => 2000,
      mintAskId: () => 'ask-open-answer-race',
    });
    block.registerAskHandler(handlerRef.kind, vi.fn());
    await block.ask(message, options, handlerRef);
    trace.length = 0;

    const originalListByStatus = store.listByStatus.bind(store);
    let reportOpenCaptured!: () => void;
    const openCaptured = new Promise<void>((resolve) => {
      reportOpenCaptured = resolve;
    });
    let releaseOpenList!: () => void;
    const openListReleased = new Promise<void>((resolve) => {
      releaseOpenList = resolve;
    });
    vi.spyOn(store, 'listByStatus').mockImplementation(async (status) => {
      const rows = await originalListByStatus(status);
      if (status === 'open') {
        reportOpenCaptured();
        await openListReleased;
      }
      return rows;
    });

    const recovery = block.recoverPendingAsks();
    await openCaptured;
    await block.submitAnswer({
      ask_id: 'ask-open-answer-race',
      option: 'approve',
      via: 'ui',
    });
    expect(trace).toEqual(['close']);
    releaseOpenList();
    await recovery;

    expect(trace).toEqual(['close']);
    expect(await store.get('ask-open-answer-race')).toMatchObject({
      status: 'handled',
    });
  });

  it('does not re-deliver an open candidate after a concurrent cancel closes it', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const trace: string[] = [];
    const ui = createRecordedChannel('ui', {
      deliverAsk: () => { trace.push('deliver'); },
      closeAsk: () => { trace.push('close'); },
    });
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui],
      settingsStore: await settingsWith(),
      now: () => 2000,
      mintAskId: () => 'ask-open-cancel-race',
    });
    await block.ask(message, options, handlerRef);
    trace.length = 0;

    const originalListByStatus = store.listByStatus.bind(store);
    let reportOpenCaptured!: () => void;
    const openCaptured = new Promise<void>((resolve) => {
      reportOpenCaptured = resolve;
    });
    let releaseOpenList!: () => void;
    const openListReleased = new Promise<void>((resolve) => {
      releaseOpenList = resolve;
    });
    vi.spyOn(store, 'listByStatus').mockImplementation(async (status) => {
      const rows = await originalListByStatus(status);
      if (status === 'open') {
        reportOpenCaptured();
        await openListReleased;
      }
      return rows;
    });

    const recovery = block.recoverPendingAsks();
    await openCaptured;
    await expect(block.cancelAsk('ask-open-cancel-race')).resolves.toBe('cancelled');
    expect(trace).toEqual(['close']);
    releaseOpenList();
    await recovery;

    expect(trace).toEqual(['close']);
    expect(await store.get('ask-open-cancel-race')).toMatchObject({
      status: 'handled',
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

  it('serializes overlapping recovery passes for the same answered ask', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const block = createNotificationBlock({
      askStore: store,
      channels: [createRecordedChannel('ui')],
      settingsStore: await settingsWith(),
      now: () => 1000,
      mintAskId: () => 'ask-overlapping-recovery',
    });
    await block.ask(message, options, handlerRef);
    await store.recordAnswer(
      'ask-overlapping-recovery',
      { option: 'approve', answered_at: 2000 },
      'ui',
    );
    const originalListByStatus = store.listByStatus.bind(store);
    let answeredListReads = 0;
    let reportSecondAnsweredList!: () => void;
    const secondAnsweredList = new Promise<void>((resolve) => {
      reportSecondAnsweredList = resolve;
    });
    vi.spyOn(store, 'listByStatus').mockImplementation(async (status) => {
      const rows = await originalListByStatus(status);
      if (status === 'answered' && ++answeredListReads === 2) {
        reportSecondAnsweredList();
      }
      return rows;
    });

    let releaseHandler!: () => void;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let reportHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      reportHandlerStarted = resolve;
    });
    const handler = vi.fn(async () => {
      reportHandlerStarted();
      await handlerReleased;
    });
    block.registerAskHandler(handlerRef.kind, handler);

    const first = block.recoverPendingAsks();
    await handlerStarted;
    const second = block.recoverPendingAsks();
    // Prove the second pass captured the same answered candidate before the
    // first handler returns. One macrotask lets an unserialized implementation
    // enter that handler, making this a regression test rather than a timing bet.
    await secondAnsweredList;
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseHandler();
    await Promise.all([first, second]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await store.get('ask-overlapping-recovery')).toMatchObject({
      status: 'handled',
    });
  });

  it('does not replay a live answer handler when recovery overlaps its dispatch', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const ui = createRecordedChannel('ui');
    const block = createNotificationBlock({
      askStore: store,
      channels: [ui],
      settingsStore: await settingsWith(),
      now: () => 2000,
      mintAskId: () => 'ask-live-recovery-race',
    });
    await block.ask(message, options, handlerRef);
    const originalListByStatus = store.listByStatus.bind(store);
    let reportAnsweredList!: () => void;
    const answeredList = new Promise<void>((resolve) => {
      reportAnsweredList = resolve;
    });
    vi.spyOn(store, 'listByStatus').mockImplementation(async (status) => {
      const rows = await originalListByStatus(status);
      if (status === 'answered') reportAnsweredList();
      return rows;
    });

    let releaseHandler!: () => void;
    const handlerReleased = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let reportHandlerStarted!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      reportHandlerStarted = resolve;
    });
    const handler = vi.fn(async () => {
      reportHandlerStarted();
      await handlerReleased;
    });
    block.registerAskHandler(handlerRef.kind, handler);

    const live = block.submitAnswer({
      ask_id: 'ask-live-recovery-race',
      option: 'approve',
      via: 'ui',
    });
    await handlerStarted;
    const recovery = block.recoverPendingAsks();
    await answeredList;
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseHandler();
    await Promise.all([live, recovery]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(ui.closes).toEqual(['ask-live-recovery-race']);
    expect(await store.get('ask-live-recovery-race')).toMatchObject({
      status: 'handled',
    });
  });
});

describe('D-158 P0 NotificationBlock remaining invariants', () => {
  it('lists open and answered-but-unhandled asks only for boot reconciliation', async () => {
    const collection = createInMemoryCollection<PendingAsk>();
    const store = createAskStore(collection);
    const block = createNotificationBlock({
      askStore: store,
      channels: [createRecordedChannel('ui')],
      settingsStore: await settingsWith(),
      now: nowSequence([1000, 1001, 1002]),
      mintAskId: mintSequence(['ask-open', 'ask-answered', 'ask-handled']),
    });

    await block.ask(message, options, handlerRef);
    await block.ask(message, options, handlerRef);
    await block.ask(message, options, handlerRef);
    await store.recordAnswer(
      'ask-answered',
      { option: 'approve', answered_at: 2000 },
      'ui',
    );
    await store.recordAnswer(
      'ask-handled',
      { option: 'approve', answered_at: 2001 },
      'ui',
    );
    await store.markHandled('ask-handled');

    expect((await block.listOpenAsks()).map((ask) => ask.ask_id)).toEqual([
      'ask-open',
    ]);
    expect((await block.listUnresolvedAsks()).map((ask) => ask.ask_id)).toEqual([
      'ask-open',
      'ask-answered',
    ]);
  });

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
