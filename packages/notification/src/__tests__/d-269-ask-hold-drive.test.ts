/** D-269 step 5 — the quiet-hours ask HOLD, driven.
 *
 *  ⛔⛔ THE HOLD HAD NO BEHAVIOURAL COVERAGE AT ALL. `shouldHoldAsk` appeared in
 *  exactly two places outside the block: a grep asserting the composition root
 *  mentions it, and a grep asserting the source contains
 *  `'if (!held) await firePassiveNotify(passiveNotify, passiveBody);'`. Both are
 *  SOURCE-TEXT assertions, and both are blind in the same direction — a second
 *  delivery inserted ABOVE the gate leaves the string intact and the owner woken.
 *
 *  🔑 AND THE ORDER CLAIM WAS THE WORST OF THEM: I-2 ("persist BEFORE deliver")
 *  was asserted as `src.indexOf('await store.create(fresh);') <
 *  src.indexOf('const held = deps.shouldHoldAsk?.(')`. That pins a LAYOUT. It
 *  reds on a refactor that changes nothing and passes on a reorder that breaks
 *  everything — a held ask that was never stored is one quiet hours DELETED
 *  rather than deferred, which is the single thing step 5 must never do.
 *
 *  ⇒ Driven here against the real block. */

import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it } from 'vitest';
import {
  createAskStore,
  createNotificationBlock,
  createNotificationSettingsStore,
  type AskOption,
  type Channel,
  type ChannelName,
  type NotificationMessage,
  type NotificationSettings,
  type NotificationSettingsStore,
  type PendingAsk,
} from '../index.js';

const message: NotificationMessage = { title: 'Approve transfer', text: 'Approve it?' };
const options: readonly AskOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];
const handlerRef = { kind: 'gateway.preflight', payload: { checkpoint_id: 'c-1' } };

interface Recorded extends Channel {
  notifyMessages: NotificationMessage[];
  askDeliveries: string[];
}
const recorded = (name: ChannelName, capability: 'inline' | 'landing-page' | 'notify-only'): Recorded => {
  const c: Recorded = {
    name, capability, owns_llm_egress: name === 'ui',
    notifyMessages: [], askDeliveries: [],
    async deliverNotify(m) { c.notifyMessages.push(m); },
    async deliverAsk(id) { c.askDeliveries.push(id); },
    async closeAsk() {},
  } as Recorded;
  return c;
};

/** ⚠ NOTIFICATION ON, APPROVAL OFF — `routeBridgeAsk` is
 *  `approval ? 'ask' : notification ? 'passive_notify' : 'skip'`, so this is the
 *  ONLY mode combination that reaches the per-bridge PASSIVE notify and its
 *  `&& !held` gate. With approval on, the bridge takes `deliverAsk` instead and
 *  the gate is never evaluated — which is exactly how an earlier attempt at this
 *  test fooled itself. */
const perBridgeSettings = async (): Promise<NotificationSettingsStore> => {
  const store = createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>());
  await store.setChannelMode('slack' as never, { notification: true, approval: true });
  await store.setBridgeMode('bridge-1', { notification: true, approval: false });
  return store;
};

const settingsWith = async (...enable: Array<'slack' | 'bridge'>): Promise<NotificationSettingsStore> => {
  const store = createNotificationSettingsStore(createInMemoryCollection<NotificationSettings>());
  for (const ch of enable) {
    await store.setChannelMode(ch as never, { notification: true, approval: true });
  }
  return store;
};

const build = async (hold: boolean, perBridge = false) => {
  const store = createAskStore(createInMemoryCollection<PendingAsk>());
  const ui = recorded('ui', 'inline');
  const slack = recorded('slack', 'inline');
  // ⛔⛔ A NOTIFY-ONLY CHANNEL IS REQUIRED OR THE PASSIVE CLAIM IS VACUOUS.
  // `passiveNotify` is the subset of channels whose capability is `notify-only`;
  // with only inline channels in the set that path never runs, so "no passive
  // ping fired" is true whether the gate is there or not. My first version of
  // this file asserted exactly that, and two mutations removing the gate both
  // passed. The bridge is the real notify-only channel; it belongs here.
  const bridge = recorded('bridge', 'notify-only');
  const block = createNotificationBlock({
    askStore: store,
    channels: [ui, slack, bridge],
    settingsStore: perBridge ? await perBridgeSettings() : await settingsWith('slack', 'bridge'),
    now: () => 1000,
    mintAskId: () => 'ask-held',
    // ⛔⛔ THE PROBE IS WHAT MAKES THE PER-BRIDGE PATH LIVE, and it is supplied in
    // production (`wire-notification-block.ts`). ⇒ Whenever ANY bridge is paired,
    // the per-bridge fan-out — with its own `&& !held` gate — is the path that
    // actually runs; the channel-level loop is the zero-bridges fallback. Leaving
    // that gate to a source-text assertion was understating it.
    // ⛔⛔ THE TWO PASSIVE PATHS ARE MUTUALLY EXCLUSIVE, so one harness cannot
    // cover both — and swapping between them silently moved the coverage rather
    // than adding to it. With NO roster the bridge sits in the capability split
    // (`passiveNotify`, gated by `if (!held)`); with a roster it leaves that set
    // for the per-bridge fan-out (gated by `if (bridgeChannel && !held)`). Each
    // gate needs the harness that makes ITS path run.
    ...(perBridge
      ? {
          bridgeRosterProbe: async () => [
            { client_token_id: 'bridge-1', label: 'laptop', connected: true },
          ],
        }
      : {}),
    shouldHoldAsk: () => hold,
  });
  return { block, store, ui, slack, bridge };
};

describe('D-269 step 5 — a held ask is DEFERRED, never deleted', () => {
  it('⛔⛔ HELD: nothing is delivered, and the ask is still durably OPEN', async () => {
    // The property the `indexOf` comparison was standing in for. A hold that
    // skipped the store would make quiet hours a DELETION with a clock on it.
    const { block, store, ui, slack } = await build(true);
    const { ask_id } = await block.ask(message, options, handlerRef as never);

    expect(ui.askDeliveries).toEqual([]);
    expect(slack.askDeliveries).toEqual([]);
    const persisted = await store.get(ask_id);
    expect(persisted?.status).toBe('open');
    expect(persisted?.fanout_channels?.length ?? 0).toBeGreaterThan(0);
  });

  it('⛔⛔ HELD: the PASSIVE ping is held too, or the hold does nothing', async () => {
    // Passive notify is an OS ping and a line in the chat — exactly the
    // interruption quiet hours exists to stop. Holding only the answerable
    // prompt would silence the prompt and still wake the owner.
    const { block, bridge } = await build(true);
    await block.ask(message, options, handlerRef as never);
    expect(bridge.notifyMessages).toEqual([]);
  });

  it('✅ NOT held: the notify-only channel DOES get the passive ping', async () => {
    // The control for the assertion above — without it, "no ping" is equally
    // consistent with a harness in which the passive path can never fire, which
    // is exactly the hole two mutations walked through.
    const { block, bridge } = await build(false);
    await block.ask(message, options, handlerRef as never);
    expect(bridge.notifyMessages.length).toBeGreaterThan(0);
  });

  it('✅ NOT held: the same call delivers — so the assertions above mean something', async () => {
    // The control. Without it "nothing was delivered" is equally consistent with
    // a block that delivers nothing ever.
    const { block, store, ui, slack } = await build(false);
    const { ask_id } = await block.ask(message, options, handlerRef as never);
    expect([...ui.askDeliveries, ...slack.askDeliveries].length).toBeGreaterThan(0);
    expect((await store.get(ask_id))?.status).toBe('open');
  });
});


describe('D-269 step 5 — the PER-BRIDGE fan-out holds too', () => {
  /** ⛔⛔ THIS IS THE LIVE PATH, NOT AN EXOTIC ONE. `bridgeRosterProbe` is supplied
   *  in production (`wire-notification-block.ts`), so the moment ANY bridge is
   *  paired the per-bridge fan-out owns the bridge and the channel-level loop
   *  above becomes the zero-bridges fallback. Leaving its `&& !held` gate to a
   *  source-text assertion — as REV 21 did — understated it. */
  it('⛔⛔ HELD: a notification-only bridge gets no passive ping', async () => {
    const { block, bridge } = await build(true, true);
    await block.ask(message, options, handlerRef as never);
    expect(bridge.notifyMessages).toEqual([]);
  });

  it('✅ NOT held: the same bridge DOES get it — so the hold is what silenced it', async () => {
    // ⚠ `notification: true, approval: false` is the ONLY combination that
    // reaches this gate: `routeBridgeAsk` sends an approval-capable bridge to
    // `deliverAsk` instead, and an earlier attempt at this test set both and
    // proved nothing.
    const { block, bridge } = await build(false, true);
    await block.ask(message, options, handlerRef as never);
    expect(bridge.notifyMessages.length).toBeGreaterThan(0);
  });
});
