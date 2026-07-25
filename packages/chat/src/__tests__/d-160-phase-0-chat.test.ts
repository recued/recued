/** D-160 P0 -- in-app chat channel and shared session store.
 *
 *  The chat channel records only completed assistant/user messages in
 *  history, while every outbound event still reaches the injected bus
 *  sink for live rendering.
 *
 *  Spec: docs/d-160-spec.md sections N.5 / N.6 / A.5.
 */

import { describe, expect, it } from 'vitest';
import {
  createChatChannel,
  createInMemorySessionStore,
  type ChannelInbound,
  type ChannelOutbound,
  type SessionEntry,
} from '@recued/chat';

const messageEvent = (
  overrides: Partial<Extract<ChannelOutbound, { kind: 'message' }>> = {},
): Extract<ChannelOutbound, { kind: 'message' }> => ({
  kind: 'message',
  session_id: 'session-1',
  turn_id: 'turn-1',
  text: 'assistant answer',
  ...overrides,
});

describe('D-160 P0 createInMemorySessionStore', () => {
  it('preserves append order and surface tags inside one session history', () => {
    const store = createInMemorySessionStore();
    const first: SessionEntry = {
      session_id: 'session-1',
      surface: 'chat',
      role: 'user',
      text: 'hello',
      ts: 100,
    };
    const second: SessionEntry = {
      session_id: 'session-1',
      surface: 'messenger-telegram',
      role: 'assistant',
      text: 'answer',
      ts: 101,
    };

    store.append(first);
    store.append(second);

    expect(store.history('session-1')).toEqual([first, second]);
  });

  it('isolates entries by session id and returns an empty history for missing sessions', () => {
    const store = createInMemorySessionStore();
    const sessionA: SessionEntry = {
      session_id: 'session-a',
      surface: 'chat',
      role: 'user',
      text: 'a',
      ts: 1,
    };
    const sessionB: SessionEntry = {
      session_id: 'session-b',
      surface: 'messenger-slack',
      role: 'assistant',
      text: 'b',
      ts: 2,
    };

    store.append(sessionA);
    store.append(sessionB);

    expect(store.history('session-a')).toEqual([sessionA]);
    expect(store.history('session-b')).toEqual([sessionB]);
    expect(store.history('session-missing')).toEqual([]);
  });
});

describe('D-160 P0 createChatChannel', () => {
  it('exposes the chat surface', () => {
    const channel = createChatChannel({
      sink: () => undefined,
      sessionStore: createInMemorySessionStore(),
      userId: 'user-1',
    });

    expect(channel.surface).toBe('chat');
  });

  it('deliver(message) appends one assistant chat entry and calls the sink', async () => {
    const store = createInMemorySessionStore();
    const delivered: ChannelOutbound[] = [];
    const channel = createChatChannel({
      sink: (event) => delivered.push(event),
      sessionStore: store,
      userId: 'user-1',
      now: () => 1716141000000,
    });
    const event = messageEvent();

    await channel.deliver(event);

    expect(delivered).toEqual([event]);
    expect(store.history('session-1')).toEqual([
      {
        session_id: 'session-1',
        surface: 'chat',
        role: 'assistant',
        text: 'assistant answer',
        ts: 1716141000000,
      },
    ]);
  });

  it.each([
    {
      kind: 'token',
      event: {
        kind: 'token',
        session_id: 'session-1',
        turn_id: 'turn-1',
        delta: 'partial',
      } satisfies ChannelOutbound,
    },
    {
      kind: 'transparency',
      event: {
        kind: 'transparency',
        session_id: 'session-1',
        turn_id: 'turn-1',
        note: 'calling tool',
      } satisfies ChannelOutbound,
    },
    {
      kind: 'done',
      event: {
        kind: 'done',
        session_id: 'session-1',
        turn_id: 'turn-1',
      } satisfies ChannelOutbound,
    },
  ])('deliver($kind) calls the sink but appends no history entry', async (c) => {
    const store = createInMemorySessionStore();
    const delivered: ChannelOutbound[] = [];
    const channel = createChatChannel({
      sink: (event) => delivered.push(event),
      sessionStore: store,
      userId: 'user-1',
      now: () => 1716141000000,
    });

    await channel.deliver(c.event);

    expect(delivered).toEqual([c.event]);
    expect(store.history('session-1')).toEqual([]);
  });

  it('receiveUserMessage appends a user chat entry and invokes the inbound handler with chat source', async () => {
    const store = createInMemorySessionStore();
    const inbound: ChannelInbound[] = [];
    const channel = createChatChannel({
      sink: () => undefined,
      sessionStore: store,
      userId: 'user-1',
      now: () => 1716141000000,
    });
    channel.onInbound((message) => {
      inbound.push(message);
    });

    await channel.receiveUserMessage({
      session_id: 'session-1',
      text: 'user says hello',
    });

    expect(store.history('session-1')).toEqual([
      {
        session_id: 'session-1',
        surface: 'chat',
        role: 'user',
        text: 'user says hello',
        ts: 1716141000000,
      },
    ]);
    expect(inbound).toEqual([
      {
        session_id: 'session-1',
        surface: 'chat',
        text: 'user says hello',
        from: 'user-1',
        source: {
          channel: 'chat',
          actor: 'user_self',
          chat_session_id: 'session-1',
          user_id: 'user-1',
        },
        // D-160 P3 — a webclient HID message is always top-level.
        dispatch_depth: 0,
        ts: 1716141000000,
      },
    ]);
  });

  it('receiveUserMessage still stores the user entry when no inbound handler is registered', async () => {
    const store = createInMemorySessionStore();
    const channel = createChatChannel({
      sink: () => undefined,
      sessionStore: store,
      userId: 'user-1',
      now: () => 1716141000000,
    });

    await channel.receiveUserMessage({
      session_id: 'session-1',
      text: 'stored without handler',
    });

    expect(store.history('session-1')).toEqual([
      {
        session_id: 'session-1',
        surface: 'chat',
        role: 'user',
        text: 'stored without handler',
        ts: 1716141000000,
      },
    ]);
  });
});
