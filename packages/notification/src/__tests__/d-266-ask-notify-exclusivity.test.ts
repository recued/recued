/** ONE MESSAGE PER CHANNEL PER ASK — and the settings door into I-3.
 *
 *  Two rules, measured together because they are the same `if/else`:
 *
 *   1. **A channel gets the ask OR the passive notice, never both.** On a
 *      chat transport the two land in the SAME conversation, so sending
 *      both reads as a duplicate. `ui` and `bridge` both firing is NOT
 *      that case — an in-app card and an OS notification are different
 *      places to look, and the owner wants both.
 *
 *   2. **"Don't ask me here" is not "don't tell me anything here."** The
 *      fallback used to be reachable only through the CAPABILITY door
 *      (`if (capability === 'notify-only')`), so an ask-capable channel
 *      whose owner had turned APPROVAL OFF and NOTIFICATION ON received
 *      nothing at all — while the bridge in the equivalent state got its
 *      ping. That is I-3's own named failure ("a silent ask on a user
 *      surface = lost approval") arriving through the settings door; the
 *      spec only ever reasoned about the capability one.
 */
import { CHANNEL_ROLES, PREAPPROVAL_NOTIFICATION_HANDLER } from '@recued/contracts';
import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it } from 'vitest';
import {
  createAskStore,
  createNotificationBlock,
  createNotificationSettingsStore,
  createProtectedAskController,
  type AskOption,
  type Channel,
  type ChannelCapability,
  type ChannelName,
  type NotificationMessage,
  type NotificationSettings,
  type PendingAsk,
} from '../index.js';

const CAPABILITY: Record<string, ChannelCapability> = {
  ui: 'inline',
  bridge: 'notify-only',
  slack: 'inline',
  telegram: 'inline',
  email: 'landing-page',
};

interface Recorded extends Channel {
  asks: number;
  notifies: number;
}

const recorded = (name: ChannelName): Recorded => {
  const channel = {
    name,
    capability: CAPABILITY[name]!,
    owns_llm_egress: name === 'ui',
    asks: 0,
    notifies: 0,
    async deliverAsk() { channel.asks += 1; },
    async deliverNotify() { channel.notifies += 1; },
    async closeAsk() {},
  } as unknown as Recorded;
  return channel;
};

const MESSAGE: NotificationMessage = { title: 'Approve transfer', text: 'ok?' };
const OPTIONS: readonly AskOption[] = [{ id: 'yes', label: 'Yes' }];

/** Raise one ask with every remote channel set to the given axes. */
const raise = async (axes: { notification: boolean; approval: boolean }) => {
  const settings = createNotificationSettingsStore(
    createInMemoryCollection<NotificationSettings>(),
  );
  await settings.setChannelMode('telegram', axes);
  await settings.setChannelMode('slack', axes);
  await settings.setChannelMode('email', axes);
  await settings.setChannelMode('bridge', { notification: axes.notification } as never);

  const channels = {
    ui: recorded('ui'),
    bridge: recorded('bridge'),
    telegram: recorded('telegram'),
    slack: recorded('slack'),
    email: recorded('email'),
  };
  const backing = createInMemoryCollection<PendingAsk>();
  const block = createNotificationBlock({
    askStore: createAskStore(backing),
    channels: Object.values(channels),
    settingsStore: settings,
    now: () => 1000,
    mintAskId: () => 'ask-1',
  });
  await block.ask(MESSAGE, OPTIONS, {
    kind: 'gateway.preflight',
    payload: { checkpoint_id: 'cp-1' },
  });
  return { channels, persisted: await backing.get('ask-1') };
};

describe("a protected ask's authority gates the passive notice too", () => {
  /** A D-261 preapproval declares `canDeliverTo: ui` — the review happens
   *  in the webclient and nowhere else.
   *
   *  ⛔ THE PASSIVE NOTICE CARRIES THE ASK'S OWN TITLE AND TEXT
   *  (`composePassiveAskBody`), so leaving `passiveNotify` unfiltered put
   *  a protected review's content on channels the authority had named as
   *  ineligible. The hole predates the settings-door fix — the BRIDGE was
   *  already receiving it — and that fix widened it to every ask-capable
   *  channel with approval off, which is how it surfaced.
   *
   *  🔑 `canDeliverTo` restricts DELIVERY OF THIS ASK, not answering. A
   *  module wanting awareness elsewhere while the answer stays in one
   *  place must say so; reading that permission into "it is only a
   *  notice" is the authority deciding on its own behalf. */
  it('⛔ sends NOTHING — not even a notice — to a channel the authority excluded', async () => {
    const settings = createNotificationSettingsStore(
      createInMemoryCollection<NotificationSettings>(),
    );
    await settings.setChannelMode('telegram', { notification: true, approval: false });
    await settings.setChannelMode('slack', { notification: true, approval: true });
    await settings.setChannelMode('bridge', { notification: true } as never);

    const channels = {
      ui: recorded('ui'),
      bridge: recorded('bridge'),
      telegram: recorded('telegram'),
      slack: recorded('slack'),
    };
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: Object.values(channels),
      settingsStore: settings,
      now: () => 1000,
      mintAskId: () => 'ask-protected',
    });
    const controller = createProtectedAskController(block, PREAPPROVAL_NOTIFICATION_HANDLER, {
      canDeliverTo: (channel) => channel.name === 'ui',
      async validatePrompt() {},
      async resolveProjection() { return null; },
    });

    await controller.ask(
      { title: 'Review future execution', text: 'the operations and their reads' },
      OPTIONS,
      { proposal_id: 'p1' },
      { intent: 'interactive' },
      { reserved_ask_id: 'ask-protected' },
    );

    expect(channels.ui).toMatchObject({ asks: 1, notifies: 0 });
    for (const name of ['bridge', 'telegram', 'slack'] as const) {
      expect(channels[name], name).toMatchObject({ asks: 0, notifies: 0 });
    }
  });

  it('⛔ the PER-BRIDGE path is gated too — the same hole, one line down', async () => {
    // D-169 routes the bridge per paired device once a roster probe is
    // wired, on a code path PARALLEL to the channel loop. Without a probe
    // that path never runs, so a test that omits one passes whatever the
    // gate does there — which is exactly what happened: the first fix
    // caught the channel loop and a mutation of the bridge branch stayed
    // green until this test existed.
    // ⚠ The roster probe rides the BLOCK, not the settings store — the
    // store takes one argument. Passing it here typechecked under vitest
    // (extra args are ignored at runtime) and failed `typecheck:tests`,
    // which is the CI gate the suite is not.
    const settings = createNotificationSettingsStore(
      createInMemoryCollection<NotificationSettings>(),
    );
    await settings.setBridgeMode('b1', { notification: true, approval: false });

    const bridge = recorded('bridge');
    const ui = recorded('ui');
    const block = createNotificationBlock({
      askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
      channels: [ui, bridge],
      settingsStore: settings,
      bridgeRosterProbe: async () => [
        { client_token_id: 'b1', label: 'Bridge1', connected: true },
      ],
      now: () => 1000,
      mintAskId: () => 'ask-pb',
    });
    const controller = createProtectedAskController(block, PREAPPROVAL_NOTIFICATION_HANDLER, {
      canDeliverTo: (channel) => channel.name === 'ui',
      async validatePrompt() {},
      async resolveProjection() { return null; },
    });

    await controller.ask(
      { title: 'Review future execution', text: 'the operations and their reads' },
      OPTIONS,
      { proposal_id: 'p2' },
      { intent: 'interactive' },
      { reserved_ask_id: 'ask-pb' },
    );

    expect(ui).toMatchObject({ asks: 1, notifies: 0 });
    expect(bridge).toMatchObject({ asks: 0, notifies: 0 });
  });

  it('an ORDINARY ask is untouched by the gate — every eligible channel still hears', async () => {
    // `eligibleChannels` is identity without an authority, so the D-163
    // I-3 guarantee must be exactly as before for non-protected asks.
    const { channels } = await raise({ notification: true, approval: false });
    expect(channels.bridge.notifies).toBe(1);
    expect(channels.telegram.notifies).toBe(1);
  });
});

describe('one message per channel per ask', () => {
  it('⛔ NO channel is ever sent both the ask and the notice, in ANY axis state', async () => {
    for (const notification of [true, false]) {
      for (const approval of [true, false]) {
        const { channels } = await raise({ notification, approval });
        for (const channel of Object.values(channels)) {
          expect(
            channel.asks + channel.notifies,
            `${channel.name} @ notification=${notification} approval=${approval}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('both axes on ⇒ the ASK, and no second message beside it', async () => {
    const { channels } = await raise({ notification: true, approval: true });
    expect(channels.telegram).toMatchObject({ asks: 1, notifies: 0 });
    expect(channels.slack).toMatchObject({ asks: 1, notifies: 0 });
    expect(channels.email).toMatchObject({ asks: 1, notifies: 0 });
  });

  it('⛔ approval OFF + notification ON ⇒ ONE notice, where it used to be silence', async () => {
    // Control: with notification ALSO off, the notice must not appear —
    // otherwise this test would pass on a change that notifies everyone.
    const off = await raise({ notification: false, approval: false });
    expect(off.channels.telegram).toMatchObject({ asks: 0, notifies: 0 });

    const on = await raise({ notification: true, approval: false });
    expect(on.channels.telegram).toMatchObject({ asks: 0, notifies: 1 });
    expect(on.channels.slack).toMatchObject({ asks: 0, notifies: 1 });
    expect(on.channels.email).toMatchObject({ asks: 0, notifies: 1 });
  });

  it('approval ON + notification OFF ⇒ still the ask — the owner can answer here', async () => {
    const { channels } = await raise({ notification: false, approval: true });
    expect(channels.telegram).toMatchObject({ asks: 1, notifies: 0 });
  });

  it('both axes off ⇒ nothing at all', async () => {
    const { channels } = await raise({ notification: false, approval: false });
    expect(channels.telegram).toMatchObject({ asks: 0, notifies: 0 });
    expect(channels.slack).toMatchObject({ asks: 0, notifies: 0 });
  });

  it('ui and bridge BOTH fire — different places to look, not a duplicate', async () => {
    const { channels } = await raise({ notification: true, approval: true });
    expect(channels.ui).toMatchObject({ asks: 1, notifies: 0 });
    expect(channels.bridge).toMatchObject({ asks: 0, notifies: 1 });
  });

  it('`ui` keeps the approval FLOOR — an ask is resolvable even with everything off', async () => {
    const { channels } = await raise({ notification: false, approval: false });
    expect(channels.ui).toMatchObject({ asks: 1, notifies: 0 });
    expect(CHANNEL_ROLES.ui.approval).toBe(true);
  });

  it('⛔ a passively-notified channel stays OUT of fanout_channels — no card there to close', async () => {
    // The set is derived from what was DELIVERED, not from capability —
    // which is what keeps it right now that an ask-CAPABLE channel can be
    // in the notify bucket. Those channels can reply; there is simply
    // nothing on them to close or re-deliver.
    const { persisted } = await raise({ notification: true, approval: false });
    expect(persisted?.fanout_channels).toEqual(['ui']);

    const both = await raise({ notification: true, approval: true });
    expect(both.persisted?.fanout_channels)
      .toEqual(['ui', 'telegram', 'slack', 'email']);
  });
});
