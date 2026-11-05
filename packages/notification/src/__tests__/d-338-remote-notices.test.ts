/** D-338 — a notify to a messenger the owner chats with Recued on goes out as a notice: the host
 *  supplies the notice's words and records it once the messenger accepted it. The channel's part
 *  is only to send what it is handed and to report the message id, and never to let the hook cost
 *  the notification. */
import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteChannel,
  type NotificationMessage,
  type RemoteNoticeHook,
} from '@recued/notification';
import type { InteractiveTransport, TransportSendResult } from '@recued/transport';

const message: NotificationMessage = {
  title: 'Agenda · Tue 3 Nov',
  text: '09:00  Dentist',
  link_url: 'https://recued.test/today',
};

const transportSending = (result: TransportSendResult = { ok: true, vendor_message_id: '801' }) => {
  const send = vi.fn<InteractiveTransport['send']>(async () => result);
  const transport: InteractiveTransport = {
    vendor: 'telegram',
    send,
    parseInbound: () => null,
    parseConversationId: () => null,
    sendPrompt: async () => ({ ok: true, vendor_message_id: 'prompt-1' }),
    parseInboundChoice: () => null,
    parseCallbackConversationId: () => null,
    closePrompt: async () => ({ ok: true }),
  };
  return { transport, send };
};

const channelWith = (notices: RemoteNoticeHook | undefined, result?: TransportSendResult) => {
  const { transport, send } = transportSending(result);
  const channel = createRemoteChannel({
    transport,
    resolveCredential: async () => ({ token: 'bot-token', recipient: 'chat-1' }),
    ...(notices ? { notices } : {}),
  });
  return { channel, send };
};

describe('D-338 a notify that is a notice', () => {
  it('sends the notice the host prepared and reports the id the messenger gave it', async () => {
    const sent = vi.fn(async () => {});
    const prepare = vi.fn<RemoteNoticeHook['prepare']>(async () => ({
      title: 'Notice · Agenda · Tue 3 Nov', text: '09:00  Dentist\n\nRule line.', sent,
    }));
    const { channel, send } = channelWith({ prepare });

    await channel.deliverNotify(message);

    expect(prepare).toHaveBeenCalledWith({ vendor: 'telegram', recipient: 'chat-1', token: 'bot-token', message });
    expect(send).toHaveBeenCalledWith({
      recipient: 'chat-1', token: 'bot-token', title: 'Notice · Agenda · Tue 3 Nov',
      text: '09:00  Dentist\n\nRule line.', link_url: 'https://recued.test/today',
    });
    expect(sent).toHaveBeenCalledWith('801');
  });

  it('sends the notification as before when the host has no notice for it', async () => {
    const { channel, send } = channelWith({ prepare: async () => undefined });
    await channel.deliverNotify(message);
    expect(send).toHaveBeenCalledWith({
      recipient: 'chat-1', token: 'bot-token', title: 'Agenda · Tue 3 Nov', text: '09:00  Dentist',
      link_url: 'https://recued.test/today',
    });
  });

  it('never lets the hook cost the notification', async () => {
    const throwing = channelWith({ prepare: async () => { throw new Error('identity unavailable'); } });
    await throwing.channel.deliverNotify(message);
    expect(throwing.send).toHaveBeenCalledWith(expect.objectContaining({ title: 'Agenda · Tue 3 Nov', text: '09:00  Dentist' }));

    const failingRecord = channelWith({ prepare: async () => ({
      title: 'Notice · Agenda · Tue 3 Nov', text: 'body', sent: async () => { throw new Error('vault sealed'); },
    }) });
    await expect(failingRecord.channel.deliverNotify(message)).resolves.toBeUndefined();
    expect(failingRecord.send).toHaveBeenCalledTimes(1);
  });

  it('records nothing when the messenger refused the notice', async () => {
    const sent = vi.fn(async () => {});
    const { channel } = channelWith(
      { prepare: async () => ({ title: 'Notice', text: 'body', sent }) },
      { ok: false, error: { kind: 'vendor_error', detail: 'chat not found' } },
    );
    await expect(channel.deliverNotify(message)).rejects.toThrow();
    expect(sent).not.toHaveBeenCalled();
  });
});
