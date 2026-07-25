/** D-160 P3 -- chat ChannelInbound dispatch_depth stamping. */

import { describe, expect, it } from 'vitest';
import {
  createChatChannel,
  createInMemorySessionStore,
  type ChannelInbound,
} from '@recued/chat';

describe('D-160 P3 chat ChannelInbound dispatch_depth', () => {
  it('stamps receiveUserMessage inbounds with dispatch_depth 0', async () => {
    const inbound: ChannelInbound[] = [];
    const channel = createChatChannel({
      sink: () => undefined,
      sessionStore: createInMemorySessionStore(),
      userId: 'user-1',
      now: () => 1_716_141_000_000,
    });
    channel.onInbound((message) => {
      inbound.push(message);
    });

    await channel.receiveUserMessage({
      session_id: 'session-1',
      text: 'hello from chat',
    });

    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      session_id: 'session-1',
      surface: 'chat',
      text: 'hello from chat',
      dispatch_depth: 0,
      source: {
        channel: 'chat',
        actor: 'user_self',
        chat_session_id: 'session-1',
        user_id: 'user-1',
      },
    });
  });
});
