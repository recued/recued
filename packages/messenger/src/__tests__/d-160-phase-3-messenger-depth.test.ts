/** D-160 P3 -- messenger ChannelInbound dispatch_depth stamping. */

import { describe, expect, it } from 'vitest';
import {
  createInMemorySessionStore,
  type ChannelInbound,
} from '@recued/chat';
import { createMessengerChannel } from '@recued/messenger';
import type {
  OutboundMessage,
  ParsedInbound,
  Transport,
  TransportSendResult,
  TransportVendor,
} from '@recued/transport';

interface FakeTransport {
  transport: Transport;
  sends: OutboundMessage[];
  parsedPayloads: unknown[];
}

const fakeTransport = (
  vendor: TransportVendor,
  options: {
    sendResult?: TransportSendResult;
    parsed?: ParsedInbound | null | ((payload: unknown) => ParsedInbound | null);
  } = {},
): FakeTransport => {
  const sends: OutboundMessage[] = [];
  const parsedPayloads: unknown[] = [];
  const transport: Transport = {
    vendor,
    parseConversationId: () => null,
    async send(message) {
      sends.push(message);
      return options.sendResult ?? { ok: true, vendor_message_id: 'vendor-1' };
    },
    parseInbound(payload) {
      parsedPayloads.push(payload);
      if (typeof options.parsed === 'function') return options.parsed(payload);
      return options.parsed ?? null;
    },
    async fetchMedia(ref) {
      return {
        temp_path: '/tmp/media.bin',
        size: 5,
        head_bytes: Buffer.from('media'),
        filename: 'media.bin',
        mime_type: ref.mime,
      };
    },
  };
  return { transport, sends, parsedPayloads };
};

const messengerChannel = (fake: FakeTransport) =>
  createMessengerChannel({
    transport: fake.transport,
    sessionStore: createInMemorySessionStore(),
    token: 'byo-token',
    recipient: 'recipient-1',
    sessionId: 'session-1',
    now: () => 1_716_141_000_000,
  });

describe('D-160 P3 messenger ChannelInbound dispatch_depth', () => {
  it('defaults ingest(payload) to dispatch_depth 0', async () => {
    const inbound: ChannelInbound[] = [];
    const payload = { vendor: 'slack', id: 1 };
    const fake = fakeTransport('slack', {
      parsed: { from: 'sender-1', text: 'user over messenger' },
    });
    const channel = messengerChannel(fake);
    channel.onInbound((message) => {
      inbound.push(message);
    });

    await channel.ingest(payload);

    expect(fake.parsedPayloads).toEqual([payload]);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      session_id: 'session-1',
      surface: 'messenger-slack',
      text: 'user over messenger',
      from: 'sender-1',
      dispatch_depth: 0,
      source: {
        channel: 'messenger',
        actor: 'user_self',
        vendor: 'slack',
        from: 'sender-1',
      },
    });
  });

  it('stamps a supplied re-entrant dispatch_depth', async () => {
    const inbound: ChannelInbound[] = [];
    const payload = { vendor: 'telegram', id: 2 };
    const fake = fakeTransport('telegram', {
      parsed: { from: 'sender-2', text: 'user over telegram' },
    });
    const channel = messengerChannel(fake);
    channel.onInbound((message) => {
      inbound.push(message);
    });

    await channel.ingest(payload, 17);

    expect(fake.parsedPayloads).toEqual([payload]);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      session_id: 'session-1',
      surface: 'messenger-telegram',
      text: 'user over telegram',
      from: 'sender-2',
      dispatch_depth: 17,
      source: {
        channel: 'messenger',
        actor: 'user_self',
        vendor: 'telegram',
        from: 'sender-2',
      },
    });
  });
});
