/** D-210 A.8 slice 3d — the `/ask/<ask_id>` link on `inline` channel asks.
 *
 *  ⚠ Why this file exists at all: the link is threaded through FOUR conditional
 *  spreads (`compose-execution-context` → `composeExecuteDeps` →
 *  `composeNotificationBlock` → `createNotificationBlock`), and a conditional
 *  spread is exactly the shape that silently dropped `receptionManageMintDeps`
 *  from `ServerConfig` — property absent, tsc green, feature dead on the wire.
 *  A link nobody receives is invisible: the ask still delivers, the buttons
 *  still work, and the only missing thing is a URL nobody knew to expect.
 *  So the arrival is asserted, not assumed. [[feedback_a_call_site_is_not_a_wired_seam]] */

import { createInMemoryCollection } from '@recued/storage';
import { describe, expect, it } from 'vitest';
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
  type PendingAsk,
} from '../index.js';

const message: NotificationMessage = {
  title: 'Approve booking',
  text: 'Approve the pending reservation?',
};

const options: readonly AskOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'deny', label: 'Deny' },
];

const handlerRef = {
  kind: 'gateway.preflight',
  payload: { checkpoint_id: 'checkpoint-1' },
};

interface Recorded extends Channel {
  delivered: NotificationMessage[];
}

const recorder = (name: ChannelName, capability: ChannelCapability): Recorded => {
  const delivered: NotificationMessage[] = [];
  return {
    name,
    capability,
    delivered,
    deliverNotify: async () => {},
    // Annotated, not inferred: the `as unknown as Recorded` cast below means
    // these params get NO contextual type, so vitest runs happily while
    // `typecheck:tests` reds. [[feedback_typecheck_tests_after_test_edits]]
    deliverAsk: async (_ask_id: string, msg: NotificationMessage) => {
      delivered.push(msg);
    },
    closeAsk: async () => {},
  } as unknown as Recorded;
};

const buildBlock = async (
  channels: readonly Channel[],
  askAnswerLink?: (ask_id: string) => string,
) => {
  const settingsStore = createNotificationSettingsStore(
    createInMemoryCollection<NotificationSettings>(),
  );
  for (const channel of channels) {
    if (channel.name === 'ui') continue;
    await settingsStore.setChannelMode(channel.name as never, {
      notification: true,
      approval: true,
    });
  }
  return createNotificationBlock({
    askStore: createAskStore(createInMemoryCollection<PendingAsk>()),
    channels,
    settingsStore,
    now: () => 1000,
    mintAskId: () => 'ask-42',
    ...(askAnswerLink !== undefined ? { askAnswerLink } : {}),
  });
};

describe('D-210 s3d — the ask answer link', () => {
  it('reaches an inline channel, carrying the real ask_id', async () => {
    const slack = recorder('slack', 'inline');
    const block = await buildBlock(
      [createUiChannel({ busSink: () => {} }), slack],
      (ask_id) => `https://example.test/ask/${ask_id}`,
    );

    await block.ask(message, options, handlerRef);

    expect(slack.delivered.length).toBe(1);
    // The MINTED id, not a placeholder — a builder called with the wrong
    // argument would still produce a plausible-looking URL.
    expect(slack.delivered[0]!.text).toContain('https://example.test/ask/ask-42');
    // The original text survives; the link is additive, never a replacement.
    expect(slack.delivered[0]!.text).toContain('Approve the pending reservation?');
  });

  it('does NOT append to a landing-page channel — email composes its own', async () => {
    // Not a style preference: the email adapter already renders an "Answer now"
    // button from the same builder, so appending here would put the identical
    // URL in the message twice.
    const email = recorder('email', 'landing-page');
    const block = await buildBlock(
      [createUiChannel({ busSink: () => {} }), email],
      (ask_id) => `https://example.test/ask/${ask_id}`,
    );

    await block.ask(message, options, handlerRef);

    expect(email.delivered.length).toBe(1);
    expect(email.delivered[0]!.text).not.toContain('https://example.test');
    expect(email.delivered[0]!).toEqual(message);
  });

  it('changes NOTHING when no builder is injected — the pre-3d posture', async () => {
    // The non-public deployment, and the case a dropped conditional spread
    // would also produce. This test passing does not prove the wiring works;
    // the first test is what does. Both are needed: this one pins that absence
    // is graceful, that one pins that presence is real.
    const slack = recorder('slack', 'inline');
    const block = await buildBlock([createUiChannel({ busSink: () => {} }), slack]);

    await block.ask(message, options, handlerRef);

    expect(slack.delivered[0]!).toEqual(message);
  });

  it('still delivers the ask when the link builder throws', async () => {
    // The link is a convenience; the approval is not. A builder that throws
    // must cost the ask its URL, never its delivery — the buttons still work.
    const slack = recorder('slack', 'inline');
    const block = await buildBlock(
      [createUiChannel({ busSink: () => {} }), slack],
      () => {
        throw new Error('base url resolution blew up');
      },
    );

    await block.ask(message, options, handlerRef);

    expect(slack.delivered.length).toBe(1);
    expect(slack.delivered[0]!).toEqual(message);
  });
});
