/** D-169 P2 Slice 4 — per-bridge notification fan-out routing.
 *
 *  The block holds ONE `'bridge'` Channel adapter but the user pairs N
 *  bridges, each with independent `BridgeModeSettings`. When a
 *  `bridgeRosterProbe` is wired AND at least one bridge is paired, the
 *  block dispatches the single bridge adapter PER paired bridge per its
 *  modes (N.6 / I-10), re-read at every ask/notify raise (TR-12). Without
 *  a roster probe the bridge routes through the legacy channel-level
 *  toggle (preserves the D-158 / D-163 pre-P2 behavior).
 *
 *  Invariants under test:
 *   - routeBridgeAsk / routeBridgeNotify decision table (approval wins;
 *     both-off skips)
 *   - approval bridge -> deliverAsk; notify-only bridge -> passive
 *     deliverNotify; both-off bridge -> neither (I-10)
 *   - notify fans one deliverNotify per notification-mode bridge
 *   - the bridge is never persisted into `fanout_channels`
 *   - routing is re-evaluated per raise (TR-12)
 *   - no roster probe -> legacy channel-level routing (no regression)
 */

import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it } from 'vitest';
import {
  createAskStore,
  createNotificationBlock,
  createNotificationSettingsStore,
  routeBridgeAsk,
  routeBridgeNotify,
  type AskHandlerRef,
  type AskOption,
  type BridgeRosterProbe,
  type Channel,
  type ChannelCapability,
  type ChannelName,
  type NotificationBlock,
  type NotificationMessage,
  type NotificationSettings,
  type NotificationSettingsStore,
  type PendingAsk,
} from '../index.js';

const DEFAULT_CAPABILITY: Readonly<Record<ChannelName, ChannelCapability>> = {
  ui: 'inline',
  bridge: 'notify-only',
  slack: 'inline',
  telegram: 'inline',
  whatsapp: 'inline',
  discord: 'inline',
  teams: 'landing-page',
  email: 'landing-page',
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
    async deliverNotify(message) {
      channel.notifyCalls.push(message);
    },
    async deliverAsk(ask_id, message, options) {
      channel.askCalls.push({ ask_id, message, options });
    },
    async closeAsk(ask_id) {
      channel.closes.push(ask_id);
    },
  };
  return channel;
};

const emptySettings = (): NotificationSettingsStore =>
  createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>());

const rosterOf = (...ids: string[]): BridgeRosterProbe =>
  async () =>
    ids.map((id) => ({ client_token_id: id, label: id, connected: true }));

const askMessage: NotificationMessage = {
  title: 'Approve transfer',
  text: 'Approve the pending transfer?',
};
const askOptions: readonly AskOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];
const handler: AskHandlerRef = {
  kind: 'gateway.preflight',
  payload: { checkpoint_id: 'cp-1' },
};

const blockWith = (opts: {
  channels: RecordedChannel[];
  store: NotificationSettingsStore;
  roster?: BridgeRosterProbe;
}): NotificationBlock => {
  let n = 0;
  return createNotificationBlock({
    askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
    channels: opts.channels,
    settingsStore: opts.store,
    ...(opts.roster ? { bridgeRosterProbe: opts.roster } : {}),
    now: () => 1000,
    mintAskId: () => `ask-s4-${(n += 1)}`,
  });
};

describe('D-169 Slice 4 — routeBridgeAsk / routeBridgeNotify decision table', () => {
  it('routeBridgeAsk: approval -> ask (wins), notify-only -> passive, both-off -> skip', () => {
    expect(routeBridgeAsk({ approval: true, notification: false })).toBe('ask');
    expect(routeBridgeAsk({ approval: true, notification: true })).toBe('ask');
    expect(routeBridgeAsk({ approval: false, notification: true })).toBe('passive_notify');
    expect(routeBridgeAsk({ approval: false, notification: false })).toBe('skip');
  });

  it('routeBridgeNotify: gated purely on notification mode', () => {
    expect(routeBridgeNotify({ approval: false, notification: true })).toBe(true);
    expect(routeBridgeNotify({ approval: true, notification: true })).toBe(true);
    expect(routeBridgeNotify({ approval: true, notification: false })).toBe(false);
    expect(routeBridgeNotify({ approval: false, notification: false })).toBe(false);
  });
});

describe('D-169 Slice 4 — per-bridge ask fan-out', () => {
  it('approval -> deliverAsk, notify-only -> passive notify, both-off -> neither (I-10)', async () => {
    const ui = createRecordedChannel('ui');
    const bridge = createRecordedChannel('bridge');
    const store = emptySettings();
    await store.setBridgeMode('bridge-A', { approval: true });
    await store.setBridgeMode('bridge-B', { notification: true });
    // bridge-C: in the roster but no stored mode -> both default false.
    const block = blockWith({
      channels: [ui, bridge],
      store,
      roster: rosterOf('bridge-A', 'bridge-B', 'bridge-C'),
    });

    await block.ask(askMessage, askOptions, handler);

    // The always-on `ui` channel still gets the interactive ask.
    expect(ui.askCalls.map((c) => c.ask_id)).toEqual(['ask-s4-1']);
    // bridge-A (approval) -> one deliverAsk carrying the real message + options.
    expect(bridge.askCalls).toHaveLength(1);
    expect(bridge.askCalls[0].message.text).toBe(askMessage.text);
    expect(bridge.askCalls[0].options).toEqual(askOptions);
    // bridge-B (notify-only) -> one passive deliverNotify; bridge-C -> nothing.
    expect(bridge.notifyCalls).toHaveLength(1);
    expect(bridge.notifyCalls[0].text).toContain('approval pending');

    // The bridge is NEVER persisted into fanout_channels (close + boot
    // re-delivery ride the ui/bus path; the bridge adapter is a no-op).
    const open = await block.listOpenAsks();
    expect(open).toHaveLength(1);
    expect(open[0].fanout_channels).toEqual(['ui']);
  });

  it('approval takes precedence over notification (interactive, not also passive)', async () => {
    const ui = createRecordedChannel('ui');
    const bridge = createRecordedChannel('bridge');
    const store = emptySettings();
    await store.setBridgeMode('bridge-A', { approval: true, notification: true });
    const block = blockWith({ channels: [ui, bridge], store, roster: rosterOf('bridge-A') });

    await block.ask(askMessage, askOptions, handler);

    expect(bridge.askCalls).toHaveLength(1);
    expect(bridge.notifyCalls).toHaveLength(0);
  });

  it('skips the bridge entirely when every paired bridge has both modes off', async () => {
    const ui = createRecordedChannel('ui');
    const bridge = createRecordedChannel('bridge');
    const store = emptySettings();
    // bridge-C present in the roster, no mode stored -> both off.
    const block = blockWith({ channels: [ui, bridge], store, roster: rosterOf('bridge-C') });

    await block.ask(askMessage, askOptions, handler);

    expect(ui.askCalls).toHaveLength(1);
    expect(bridge.askCalls).toHaveLength(0);
    expect(bridge.notifyCalls).toHaveLength(0);
  });

  it('re-evaluates routing per ask raise — a mode toggle takes effect on the next ask (TR-12)', async () => {
    const ui = createRecordedChannel('ui');
    const bridge = createRecordedChannel('bridge');
    const store = emptySettings();
    await store.setBridgeMode('bridge-A', { approval: true });
    const block = blockWith({ channels: [ui, bridge], store, roster: rosterOf('bridge-A') });

    await block.ask(askMessage, askOptions, handler); // 1st raise: approval ON
    expect(bridge.askCalls).toHaveLength(1);

    await store.setBridgeMode('bridge-A', { approval: false, notification: false });
    await block.ask(askMessage, askOptions, handler); // 2nd raise: both OFF

    // The second ask did NOT fan to the bridge in any form.
    expect(bridge.askCalls).toHaveLength(1);
    expect(bridge.notifyCalls).toHaveLength(0);
    // ...while the always-on ui got both.
    expect(ui.askCalls).toHaveLength(2);
  });

  it('without a bridgeRosterProbe, the bridge routes through the legacy channel-level toggle', async () => {
    const ui = createRecordedChannel('ui');
    const bridge = createRecordedChannel('bridge');
    const store = emptySettings();
    await store.setChannelMode('bridge', { notification: true }); // legacy channel-level ON
    const block = blockWith({ channels: [ui, bridge], store /* no roster */ });

    await block.ask(askMessage, askOptions, handler);

    // No regression: notify-only bridge still gets the passive notify, never deliverAsk.
    expect(bridge.askCalls).toHaveLength(0);
    expect(bridge.notifyCalls).toHaveLength(1);
    expect(bridge.notifyCalls[0].text).toContain('approval pending');
  });

  it('a paired roster supersedes the legacy channel-level toggle (per-bridge governs)', async () => {
    const ui = createRecordedChannel('ui');
    const bridge = createRecordedChannel('bridge');
    const store = emptySettings();
    // Channel-level bridge ON, but the only paired bridge has both modes OFF.
    await store.setChannelMode('bridge', { notification: true });
    const block = blockWith({ channels: [ui, bridge], store, roster: rosterOf('bridge-C') });

    await block.ask(askMessage, askOptions, handler);

    // Per-bridge modes (both off) win over the legacy channel-level toggle.
    expect(bridge.askCalls).toHaveLength(0);
    expect(bridge.notifyCalls).toHaveLength(0);
  });
});

describe('D-169 Slice 4 — per-bridge notify fan-out', () => {
  it('fans one deliverNotify per notification-mode bridge', async () => {
    const ui = createRecordedChannel('ui');
    const bridge = createRecordedChannel('bridge');
    const store = emptySettings();
    await store.setBridgeMode('bridge-A', { notification: true });
    await store.setBridgeMode('bridge-B', { notification: true });
    // bridge-C: no mode -> not notified.
    const block = blockWith({
      channels: [ui, bridge],
      store,
      roster: rosterOf('bridge-A', 'bridge-B', 'bridge-C'),
    });

    await block.notify({ text: 'heads up' });

    expect(ui.notifyCalls).toHaveLength(1);
    expect(bridge.notifyCalls).toHaveLength(2); // A + B, not C
    expect(bridge.notifyCalls.every((m) => m.text === 'heads up')).toBe(true);
  });

  it('approval-only bridge is NOT notified on a one-way notify (notification mode off)', async () => {
    const ui = createRecordedChannel('ui');
    const bridge = createRecordedChannel('bridge');
    const store = emptySettings();
    await store.setBridgeMode('bridge-A', { approval: true, notification: false });
    const block = blockWith({ channels: [ui, bridge], store, roster: rosterOf('bridge-A') });

    await block.notify({ text: 'heads up' });

    expect(bridge.notifyCalls).toHaveLength(0);
  });
});
