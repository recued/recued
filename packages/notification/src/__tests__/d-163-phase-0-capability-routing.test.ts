/** D-163 P0 — block routes asks by channel capability.
 *
 *  Invariants under test:
 *   - I-1: capability is a structural, readonly declaration on every adapter
 *   - I-2: a `'notify-only'` channel never receives `deliverAsk`
 *   - I-3: a `'notify-only'` channel receives a passive `deliverNotify` on
 *          every ask raise
 *   - PendingAsk.fanout_channels excludes `'notify-only'` channels (boot
 *          recovery + close-broadcast never target them)
 */

import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it } from 'vitest';
import {
  createAskStore,
  createBridgeChannel,
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
} from '../index.js';

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

interface RecordedChannel extends Channel {
  notifyCalls: NotificationMessage[];
  askCalls: { ask_id: string; message: NotificationMessage; options: readonly AskOption[] }[];
  closes: string[];
}

const createRecordedChannel = (
  name: ChannelName,
  capability: ChannelCapability = DEFAULT_CAPABILITY[name],
): RecordedChannel => {
  const channel: RecordedChannel = {
    name,
    capability,
    owns_llm_egress: name === 'ui',
    notifyCalls: [],
    askCalls: [],
    closes: [],
    async deliverNotify(message) { channel.notifyCalls.push(message); },
    async deliverAsk(ask_id, message, options) {
      channel.askCalls.push({ ask_id, message, options });
    },
    async closeAsk(ask_id) { channel.closes.push(ask_id); },
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

const askMessage: NotificationMessage = {
  title: 'Approve transfer',
  text: 'Approve the pending transfer?',
};

const askOptions: readonly AskOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];

describe('D-163 I-1 — structural capability declaration', () => {
  it('every shipped adapter exposes a readonly capability field', () => {
    const ui = createUiChannel({ busSink: () => {} });
    const bridge = createBridgeChannel({ bridgeSink: () => {} });
    expect(ui.capability).toBe('inline');
    expect(bridge.capability).toBe('notify-only');
  });

  it('capability cannot be mutated post-construction (declared as readonly)', () => {
    // The compile-time `readonly` is the structural enforcement
    // (TR-1); a runtime guard would only catch the literal mutation
    // attempt, and TypeScript already refuses that. This test is the
    // structural ratchet — the fields exist and read the value we
    // expect at construction time.
    const bridge = createBridgeChannel({ bridgeSink: () => {} });
    expect(bridge.capability).toBe('notify-only');
    // @ts-expect-error — readonly capability cannot be reassigned at compile time.
    bridge.capability = 'inline';
    // Even if a caller forces a runtime mutation past TS, the block reads
    // `channel.capability` per call so a structural test exercising the
    // ratchet at construction time is the contract.
  });
});

describe('D-163 I-2 — notify-only channels never receive deliverAsk', () => {
  it('filters notify-only channels out of the ask fan-out set', async () => {
    const ui = createRecordedChannel('ui');
    const bridge = createRecordedChannel('bridge');
    const slack = createRecordedChannel('slack');

    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [ui, bridge, slack],
      settingsStore: await settingsWith('bridge', 'slack'),
      now: () => 1000,
      mintAskId: () => 'ask-cap-1',
    });

    await block.ask(askMessage, askOptions, {
      kind: 'gateway.preflight',
      payload: { checkpoint_id: 'cp-1' },
    });

    expect(ui.askCalls.map((c) => c.ask_id)).toEqual(['ask-cap-1']);
    expect(slack.askCalls.map((c) => c.ask_id)).toEqual(['ask-cap-1']);
    expect(bridge.askCalls).toEqual([]);   // I-2
  });

  it('fanout_channels persists only non-notify-only channels', async () => {
    const askStoreBacking = createInMemoryCollection<PendingAsk>();
    const block = createNotificationBlock({
      askStore: createAskStore(askStoreBacking),
      channels: [
        createRecordedChannel('ui'),
        createRecordedChannel('bridge'),
        createRecordedChannel('slack'),
      ],
      settingsStore: await settingsWith('bridge', 'slack'),
      now: () => 1000,
      mintAskId: () => 'ask-fanout',
    });

    await block.ask(askMessage, askOptions, {
      kind: 'gateway.preflight',
      payload: { checkpoint_id: 'cp-1' },
    });

    const persisted = await askStoreBacking.get('ask-fanout');
    expect(persisted?.fanout_channels).toEqual(['ui', 'slack']);
  });
});

describe('D-163 I-3 — passive notify on ask raise to notify-only channels', () => {
  it('fires deliverNotify on every enabled notify-only channel for each ask', async () => {
    const bridge = createRecordedChannel('bridge');
    const ui = createRecordedChannel('ui');

    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [ui, bridge],
      settingsStore: await settingsWith('bridge'),
      now: () => 1000,
      mintAskId: () => 'ask-passive',
    });

    await block.ask(askMessage, askOptions, {
      kind: 'gateway.preflight',
      payload: {},
    });

    expect(bridge.notifyCalls).toHaveLength(1);
    expect(bridge.notifyCalls[0].title).toBe(askMessage.title);
    expect(bridge.notifyCalls[0].text).toContain('approval pending');
  });

  it('does NOT fire passive notify when the notify-only channel is disabled', async () => {
    const bridge = createRecordedChannel('bridge');
    const ui = createRecordedChannel('ui');
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [ui, bridge],
      settingsStore: await settingsWith(),     // bridge disabled by default
      now: () => 1000,
      mintAskId: () => 'ask-disabled-bridge',
    });

    await block.ask(askMessage, askOptions, {
      kind: 'gateway.preflight',
      payload: {},
    });

    expect(bridge.notifyCalls).toEqual([]);
  });

  it('a throwing notify-only channel does not fail the ask raise (best-effort)', async () => {
    const bridge: Channel = {
      name: 'bridge',
      capability: 'notify-only',
      owns_llm_egress: false,
      async deliverNotify() { throw new Error('os notif failed'); },
      async deliverAsk() {},
      async closeAsk() {},
    };
    const ui = createRecordedChannel('ui');
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [ui, bridge],
      settingsStore: await settingsWith('bridge'),
      now: () => 1000,
      mintAskId: () => 'ask-throwing-bridge',
    });

    await expect(
      block.ask(askMessage, askOptions, {
        kind: 'gateway.preflight',
        payload: {},
      }),
    ).resolves.toEqual({ ask_id: 'ask-throwing-bridge' });
    expect(ui.askCalls.map((c) => c.ask_id)).toEqual(['ask-throwing-bridge']);
  });
});

describe('D-163 — boot recovery + close-broadcast skip notify-only channels', () => {
  it('recoverPendingAsks re-delivers only to channels in fanout_channels (excludes bridge)', async () => {
    const askStoreBacking = createInMemoryCollection<PendingAsk>();
    const ui = createRecordedChannel('ui');
    const bridge = createRecordedChannel('bridge');
    const block = createNotificationBlock({
      askStore: createAskStore(askStoreBacking),
      channels: [ui, bridge],
      settingsStore: await settingsWith('bridge'),
      now: () => 1000,
      mintAskId: () => 'ask-boot-cap',
    });

    await block.ask(askMessage, askOptions, {
      kind: 'gateway.preflight',
      payload: {},
    });

    // Reset call recorders to simulate "after crash, before recovery".
    ui.askCalls.length = 0;
    bridge.notifyCalls.length = 0;
    bridge.askCalls.length = 0;

    await block.recoverPendingAsks();

    // UI re-delivered (it's in fanout_channels).
    expect(ui.askCalls.map((c) => c.ask_id)).toEqual(['ask-boot-cap']);
    // Bridge never sees deliverAsk (I-2), and recovery does NOT
    // re-fire the passive notify (not in fanout_channels by design).
    expect(bridge.askCalls).toEqual([]);
    expect(bridge.notifyCalls).toEqual([]);
  });
});

describe('D-163 — notify fan-out unchanged (every enabled channel)', () => {
  it('one-way notify reaches every enabled channel including notify-only ones', async () => {
    const ui = createRecordedChannel('ui');
    const bridge = createRecordedChannel('bridge');
    const slack = createRecordedChannel('slack');

    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [ui, bridge, slack],
      settingsStore: await settingsWith('bridge', 'slack'),
    });

    const message: NotificationMessage = {
      title: 'Update',
      text: 'Sync completed',
    };
    await block.notify(message);

    expect(ui.notifyCalls).toEqual([message]);
    expect(bridge.notifyCalls).toEqual([message]);
    expect(slack.notifyCalls).toEqual([message]);
  });
});

describe('R31 — per-channel notify / approval axis split', () => {
  // slack: NOTIFICATION axis ON, APPROVAL OFF. telegram: the reverse.
  // The whole point of the two axes — a channel can carry notifies
  // without carrying asks, and vice-versa.
  const splitStore = async (): Promise<NotificationSettingsStore> => {
    const store = createNotificationSettingsStore(
      createInMemoryCollection<NotificationSettings>(),
    );
    await store.setChannelMode('slack', { notification: true, approval: false });
    await store.setChannelMode('telegram', {
      notification: false,
      approval: true,
    });
    return store;
  };

  it('a one-way notify fans to the notification axis only', async () => {
    const ui = createRecordedChannel('ui');
    const slack = createRecordedChannel('slack'); // notification ON
    const telegram = createRecordedChannel('telegram'); // notification OFF
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [ui, slack, telegram],
      settingsStore: await splitStore(),
      now: () => 1000,
      mintAskId: () => 'ask-split-n',
    });

    await block.notify({ text: 'heads up' });

    expect(ui.notifyCalls.length).toBe(1); // floor — always
    expect(slack.notifyCalls.length).toBe(1); // notification axis ON
    expect(telegram.notifyCalls.length).toBe(0); // notification axis OFF
  });

  it('an ask delivers to the approval axis only', async () => {
    const ui = createRecordedChannel('ui');
    const slack = createRecordedChannel('slack'); // approval OFF
    const telegram = createRecordedChannel('telegram'); // approval ON
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [ui, slack, telegram],
      settingsStore: await splitStore(),
      now: () => 1000,
      mintAskId: () => 'ask-split-a',
    });

    await block.ask(askMessage, askOptions, {
      kind: 'gateway.preflight',
      payload: {},
    });

    // ui (floor) + telegram (approval ON) receive the ask; slack, whose
    // approval axis is OFF even though its notification axis is ON, does
    // NOT — the pre-R31 single flag would have delivered it.
    expect(ui.askCalls.map((c) => c.ask_id)).toEqual(['ask-split-a']);
    expect(telegram.askCalls.map((c) => c.ask_id)).toEqual(['ask-split-a']);
    expect(slack.askCalls).toEqual([]);
    // ⇒ AMENDED: slack now receives the PASSIVE NOTICE instead of silence.
    //
    // This line used to read `expect(slack.notifyCalls).toEqual([])`, and its
    // reason was a CONSEQUENCE stated as a guarantee — "inline channels are
    // gated purely on the approval axis" was true of the code, and nobody had
    // decided it should be. The owner's settings say "don't ASK me on slack"
    // and "DO notify me on slack"; delivering neither answers a question they
    // did not ask, and it is I-3's own named failure ("a silent ask on a user
    // surface = lost approval") reached through the settings door rather than
    // the capability door.
    //
    // ⛔ The property this test actually guards is UNCHANGED and still above:
    // approval OFF means NO ASK. One notice, never the ask, never both.
    expect(slack.notifyCalls.length).toBe(1);
    expect(slack.notifyCalls[0]?.text).toMatch(/approval pending/);
  });
});
