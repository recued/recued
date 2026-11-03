import { describe, expect, it, vi } from 'vitest';
import { MESSENGER_VENDOR_SLUGS } from '@recued/contracts';
import {
  createRemoteChannel,
  type AskOption,
  type CredentialResolver,
  type NotificationMessage,
  type RemoteChannelCredential,
  type RemotePromptRecord,
} from '@recued/notification';
import { createInMemoryCollection, type Collection } from '@recued/storage';
import type {
  InteractiveTransport,
  TransportSendResult,
  TransportVendor,
} from '@recued/transport';

const credential: RemoteChannelCredential = {
  recipient: 'C123',
  token: 'xoxb-token',
};

const notifyMessage: NotificationMessage = {
  title: 'Build ready',
  text: 'Deploy finished',
  link_url: 'https://recued.test/runs/1',
};

const askMessage: NotificationMessage = {
  title: 'Decision ready',
  text: 'Approve the plan?',
};

const askOptions: readonly AskOption[] = [
  { id: 'approve', label: 'Approve' },
  { id: 'reject', label: 'Reject' },
];

const ok = (vendor_message_id?: string): TransportSendResult =>
  vendor_message_id === undefined
    ? { ok: true }
    : { ok: true, vendor_message_id };

const fail = (detail = 'vendor rejected'): TransportSendResult => ({
  ok: false,
  error: { kind: 'vendor_error', detail },
});

const credentialResolver = (
  value: RemoteChannelCredential | null = credential,
): ReturnType<typeof vi.fn<CredentialResolver>> =>
  vi.fn<CredentialResolver>(async () => value);

const fakeTransport = (
  vendor: TransportVendor = 'slack',
  defaults: {
    sendResult?: TransportSendResult;
    sendPromptResult?: TransportSendResult;
    closeResult?: TransportSendResult;
  } = {},
) => {
  const send = vi.fn<InteractiveTransport['send']>(
    async () => defaults.sendResult ?? ok('notify-1'),
  );
  const parseInbound = vi.fn<InteractiveTransport['parseInbound']>(() => null);
  const sendPrompt = vi.fn<InteractiveTransport['sendPrompt']>(
    async () => defaults.sendPromptResult ?? ok('prompt-1'),
  );
  const parseInboundChoice = vi.fn<InteractiveTransport['parseInboundChoice']>(
    () => null,
  );
  const closePrompt = vi.fn<InteractiveTransport['closePrompt']>(
    async () => defaults.closeResult ?? ok('closed-1'),
  );
  const transport: InteractiveTransport = {
    vendor,
    send,
    parseInbound,
    parseConversationId: () => null,
    sendPrompt,
    parseInboundChoice,
    parseCallbackConversationId: () => null,
    closePrompt,
  };
  return { transport, send, sendPrompt, parseInboundChoice, closePrompt };
};

describe('D-158 P2a createRemoteChannel identity and notify delivery', () => {
  it('derives name from the injected transport vendor', () => {
    const fake = fakeTransport('telegram');
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential: credentialResolver(),
    });

    expect(channel.name).toBe('telegram');
  });

  it('deliverNotify resolves credentials and sends the notification body', async () => {
    const fake = fakeTransport();
    const resolveCredential = credentialResolver();
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential,
    });

    await channel.deliverNotify(notifyMessage);

    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(fake.send).toHaveBeenCalledTimes(1);
    expect(fake.send).toHaveBeenCalledWith({
      recipient: 'C123',
      token: 'xoxb-token',
      title: 'Build ready',
      text: 'Deploy finished',
      link_url: 'https://recued.test/runs/1',
    });
  });

  it('deliverNotify throws on transport failure and on missing credentials', async () => {
    const failed = fakeTransport('slack', { sendResult: fail('channel missing') });
    const failedChannel = createRemoteChannel({
      transport: failed.transport,
      resolveCredential: credentialResolver(),
    });

    await expect(failedChannel.deliverNotify(notifyMessage)).rejects.toThrow(
      /deliverNotify.*vendor_error.*channel missing/,
    );

    const missing = fakeTransport();
    const missingChannel = createRemoteChannel({
      transport: missing.transport,
      resolveCredential: credentialResolver(null),
    });

    await expect(missingChannel.deliverNotify(notifyMessage)).rejects.toThrow(
      /deliverNotify.*no connection\.notification credential/,
    );
    expect(missing.send).not.toHaveBeenCalled();
  });
});

describe('D-158 P2a createRemoteChannel ask delivery', () => {
  it('deliverAsk sends one prompt per ask_id with ask_id as correlation_id', async () => {
    const fake = fakeTransport();
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential: credentialResolver(),
    });

    await channel.deliverAsk('ask-1', askMessage, askOptions);
    await channel.deliverAsk('ask-1', { text: 'Different text' }, [
      { id: 'different', label: 'Different' },
    ]);

    expect(fake.sendPrompt).toHaveBeenCalledTimes(1);
    expect(fake.sendPrompt).toHaveBeenCalledWith({
      recipient: 'C123',
      token: 'xoxb-token',
      title: 'Decision ready',
      text: 'Approve the plan?',
      correlation_id: 'ask-1',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    });
  });

  it('deliverAsk throws on sendPrompt failure and leaves the ask retryable', async () => {
    const fake = fakeTransport();
    fake.sendPrompt
      .mockResolvedValueOnce(fail('buttons rejected'))
      .mockResolvedValueOnce(ok('prompt-retry'));
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential: credentialResolver(),
    });

    await expect(
      channel.deliverAsk('ask-retry', askMessage, askOptions),
    ).rejects.toThrow(/deliverAsk.*buttons rejected/);
    await channel.deliverAsk('ask-retry', askMessage, askOptions);

    expect(fake.sendPrompt).toHaveBeenCalledTimes(2);
  });
});

describe('D-158 P2a createRemoteChannel closeAsk', () => {
  it('closes a successfully delivered prompt using the recorded vendor message id', async () => {
    const fake = fakeTransport();
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential: credentialResolver(),
    });

    await channel.deliverAsk('ask-close', askMessage, askOptions);
    await channel.closeAsk('ask-close');

    expect(fake.closePrompt).toHaveBeenCalledTimes(1);
    expect(fake.closePrompt).toHaveBeenCalledWith({
      recipient: 'C123',
      token: 'xoxb-token',
      vendor_message_id: 'prompt-1',
      text: 'Decision ready\n\nApprove the plan?',
    });
  });

  it('closeAsk is a no-op for an unknown ask_id', async () => {
    const fake = fakeTransport();
    const resolveCredential = credentialResolver();
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential,
    });

    await expect(channel.closeAsk('missing')).resolves.toBeUndefined();

    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fake.closePrompt).not.toHaveBeenCalled();
  });

  it('closeAsk is a no-op when delivery succeeded without a vendor_message_id', async () => {
    const fake = fakeTransport('slack', { sendPromptResult: ok() });
    const resolveCredential = credentialResolver();
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential,
    });

    await channel.deliverAsk('ask-no-id', askMessage, askOptions);
    await channel.closeAsk('ask-no-id');

    expect(resolveCredential).toHaveBeenCalledTimes(1);
    expect(fake.closePrompt).not.toHaveBeenCalled();
  });

  it('closeAsk no-ops when credentials disappeared after delivery', async () => {
    const fake = fakeTransport();
    const resolveCredential = vi.fn<CredentialResolver>();
    resolveCredential.mockResolvedValueOnce(credential).mockResolvedValueOnce(null);
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential,
    });

    await channel.deliverAsk('ask-credential-gone', askMessage, askOptions);
    await expect(channel.closeAsk('ask-credential-gone')).resolves.toBeUndefined();

    expect(fake.closePrompt).not.toHaveBeenCalled();
  });

  it('closeAsk treats a closePrompt failure as best-effort', async () => {
    const fake = fakeTransport('slack', { closeResult: fail('message gone') });
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential: credentialResolver(),
    });

    await channel.deliverAsk('ask-close-fail', askMessage, askOptions);
    await expect(channel.closeAsk('ask-close-fail')).resolves.toBeUndefined();

    expect(fake.closePrompt).toHaveBeenCalledTimes(1);
  });
});

describe('D-158 P2a createRemoteChannel parseInboundReply', () => {
  it('maps transport choices to channel inbound replies', () => {
    const fake = fakeTransport('telegram');
    fake.parseInboundChoice.mockReturnValueOnce({
      correlation_id: 'ask-choice',
      option_id: 'approve',
      from: '7001',
      vendor_message_id: '42',
    });
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential: credentialResolver(),
    });
    const payload = { raw: true };

    expect(channel.parseInboundReply(payload)).toEqual({
      ask_id: 'ask-choice',
      option: 'approve',
      via: 'telegram',
    });
    expect(fake.parseInboundChoice).toHaveBeenCalledWith(payload);
  });

  it('returns null when the transport finds no choice', () => {
    const fake = fakeTransport();
    fake.parseInboundChoice.mockReturnValueOnce(null);
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential: credentialResolver(),
    });

    expect(channel.parseInboundReply({ raw: false })).toBeNull();
  });
});

describe('WatchSource — parseInboundMessage delegation', () => {
  it('delegates to transport.parseInbound and returns its result verbatim', () => {
    const fake = fakeTransport();
    fake.transport.parseInbound = vi.fn(() => ({
      from: 'U-1',
      text: 'hello there',
      vendor_message_id: 'm-9',
    }));
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential: credentialResolver(),
    });

    expect(channel.parseInboundMessage({ any: 'payload' })).toEqual({
      from: 'U-1',
      text: 'hello there',
      vendor_message_id: 'm-9',
    });
  });

  it('returns null for non-message payloads (transport contract)', () => {
    const fake = fakeTransport();
    const channel = createRemoteChannel({
      transport: fake.transport,
      resolveCredential: credentialResolver(),
    });

    expect(channel.parseInboundMessage({ type: 'block_actions' })).toBeNull();
  });
});

/** D-192 CORE #6 seam 10 — the boot guard that gates a new chat transport.
 *
 *  `createRemoteChannel` fails LOUD when a transport's vendor is not a registered
 *  notification `ChannelName`, so a declared vendor that never reached the channel
 *  list cannot back a channel — it throws at composition
 *  (`buildMessengerRemoteChannels`), i.e. at BOOT. That is precisely the thing
 *  that would have blocked Teams.
 *
 *  Seam 10 made the channel list derive from `MESSENGER_VENDOR_SLUGS`, so this
 *  now holds for free. The table iterates the LIVE registry: a newly declared
 *  vendor is covered here the moment it is declared, with no edit to this file. */
describe('D-192 seam 10 — every declared chat transport can back a remote channel', () => {
  it.each(MESSENGER_VENDOR_SLUGS.map((v) => [v] as const))(
    'admits %s at composition',
    (vendor) => {
      const fake = fakeTransport(vendor);
      expect(() =>
        createRemoteChannel({
          transport: fake.transport,
          resolveCredential: credentialResolver(),
        }),
      ).not.toThrow();
      expect(
        createRemoteChannel({
          transport: fake.transport,
          resolveCredential: credentialResolver(),
        }).name,
      ).toBe(vendor);
    },
  );

  it('still fails loud for a vendor that is not a registered channel', () => {
    // The guard must keep biting — a transport wired for an UNDECLARED vendor is
    // a composition bug, and surfacing it at boot is the whole point.
    //
    // ⚠ This fixture used to be the literal `whatsapp`, and the day WhatsApp
    // shipped it stopped testing "an unregistered vendor" and started asserting
    // something false. A negative fixture named after "a vendor we haven't built
    // yet" has an expiry date; one that can never BE a vendor does not. (Third
    // occurrence of this exact trap in the messenger suites.)
    const fake = fakeTransport('not_a_transport');
    expect(() =>
      createRemoteChannel({
        transport: fake.transport,
        resolveCredential: credentialResolver(),
      }),
    ).toThrow(/not a registered notification channel/);
  });
});

describe('D-158 P3 — what a channel sent outlives the process', () => {
  // A restart builds the channel again over the same records. The boot sweep re-delivers every
  // open ask, and an answer's close must reach a prompt the earlier process sent.
  const records = () => createInMemoryCollection<RemotePromptRecord>();
  const closeText = 'Decision ready\n\nApprove the plan?';

  it('a prompt sent before a restart is not sent again, and closing it strips its buttons', async () => {
    const store = records();
    const first = fakeTransport('telegram', { sendPromptResult: ok('msg-1001') });
    const before = createRemoteChannel({ transport: first.transport, resolveCredential: credentialResolver(), promptRecords: store });
    await before.deliverAsk('ask-1', askMessage, askOptions);
    expect(first.sendPrompt).toHaveBeenCalledTimes(1);
    expect(await store.get('telegram:ask-1')).toMatchObject({ vendor_message_id: 'msg-1001', close_text: closeText, options: askOptions });

    // The restart: a new process, a new channel, the same records.
    const again = fakeTransport('telegram', { sendPromptResult: ok('msg-2001') });
    const after = createRemoteChannel({ transport: again.transport, resolveCredential: credentialResolver(), promptRecords: store });
    await after.deliverAsk('ask-1', askMessage, askOptions);
    expect(again.sendPrompt).not.toHaveBeenCalled();

    await after.closeAsk('ask-1');
    expect(again.closePrompt).toHaveBeenCalledWith(expect.objectContaining({ vendor_message_id: 'msg-1001', text: closeText }));
    expect(await store.get('telegram:ask-1')).toBeNull();
  });

  it('⛔ closing first after a restart (the expiry sweep before any re-delivery) still strips the first prompt', async () => {
    const store = records();
    const first = fakeTransport('telegram', { sendPromptResult: ok('msg-1001') });
    await createRemoteChannel({ transport: first.transport, resolveCredential: credentialResolver(), promptRecords: store })
      .deliverAsk('ask-1', askMessage, askOptions);
    const again = fakeTransport('telegram');
    const after = createRemoteChannel({ transport: again.transport, resolveCredential: credentialResolver(), promptRecords: store });
    await after.closeAsk('ask-1');
    expect(again.closePrompt).toHaveBeenCalledWith(expect.objectContaining({ vendor_message_id: 'msg-1001', text: closeText }));
  });

  it('⛔ CONTROL: without records, a restart sends the prompt again and cannot close the first', async () => {
    const first = fakeTransport('telegram', { sendPromptResult: ok('msg-1001') });
    await createRemoteChannel({ transport: first.transport, resolveCredential: credentialResolver() })
      .deliverAsk('ask-1', askMessage, askOptions);
    const again = fakeTransport('telegram', { sendPromptResult: ok('msg-2001') });
    const after = createRemoteChannel({ transport: again.transport, resolveCredential: credentialResolver() });
    await after.deliverAsk('ask-1', askMessage, askOptions);
    expect(again.sendPrompt).toHaveBeenCalledTimes(1);
    await after.closeAsk('ask-1');
    expect(again.closePrompt).toHaveBeenCalledWith(expect.objectContaining({ vendor_message_id: 'msg-2001' }));
  });

  it('keeps each channel to its own records', async () => {
    const store = records();
    const slack = fakeTransport('slack', { sendPromptResult: ok('ts-1') });
    await createRemoteChannel({ transport: slack.transport, resolveCredential: credentialResolver(), promptRecords: store })
      .deliverAsk('ask-1', askMessage, askOptions);
    const telegram = fakeTransport('telegram', { sendPromptResult: ok('msg-1') });
    await createRemoteChannel({ transport: telegram.transport, resolveCredential: credentialResolver(), promptRecords: store })
      .deliverAsk('ask-1', askMessage, askOptions);
    expect(telegram.sendPrompt).toHaveBeenCalledTimes(1);
    expect(await store.get('slack:ask-1')).toMatchObject({ vendor_message_id: 'ts-1' });
    expect(await store.get('telegram:ask-1')).toMatchObject({ vendor_message_id: 'msg-1' });
  });

  it('⛔ records that cannot be read or kept cost only what they did before: the prompt still goes out', async () => {
    const broken: Collection<RemotePromptRecord> = {
      ...records(),
      listByPrefix: async () => { throw new Error('locked'); },
      set: async () => { throw new Error('locked'); },
    };
    const fake = fakeTransport('telegram', { sendPromptResult: ok('msg-1') });
    const channel = createRemoteChannel({ transport: fake.transport, resolveCredential: credentialResolver(), promptRecords: broken });
    await channel.deliverAsk('ask-1', askMessage, askOptions);
    expect(fake.sendPrompt).toHaveBeenCalledTimes(1);
    await channel.closeAsk('ask-1');
    expect(fake.closePrompt).toHaveBeenCalledWith(expect.objectContaining({ vendor_message_id: 'msg-1' }));
  });
});
