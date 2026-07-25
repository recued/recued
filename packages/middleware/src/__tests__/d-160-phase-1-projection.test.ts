/** D-160 P1 -- out-stream projection over internal turns.
 *
 *  Spec: D-160 sections N.6 / A.4 and Must Hold I-6.
 */

import { describe, expect, it } from 'vitest';
import {
  createInMemorySessionStore,
  type Channel,
  type ChannelInbound,
  type ChannelOutbound,
} from '@recued/chat';
import {
  createMiddlewareRegistry,
  runStream,
  type TurnOutput,
} from '@recued/middleware';

type RecordingChannel = Channel & { readonly events: ChannelOutbound[] };

const recordingChannel = (): RecordingChannel => {
  const events: ChannelOutbound[] = [];
  return {
    surface: 'chat',
    events,
    async deliver(event: ChannelOutbound): Promise<void> {
      events.push(event);
    },
    onInbound(): void {
      return undefined;
    },
  };
};

const inbound = (): ChannelInbound => ({
  session_id: 'session-1',
  surface: 'chat',
  text: 'start',
  from: 'user-1',
  source: {
    channel: 'chat',
    actor: 'user_self',
    chat_session_id: 'session-1',
    user_id: 'user-1',
  },
  // D-160 P3 — `0` = a top-level user message.
  dispatch_depth: 0,
  ts: 1716141000000,
});

const runProjection = async (turns: readonly TurnOutput[]) => {
  const registry = createMiddlewareRegistry();
  const channel = recordingChannel();
  const store = createInMemorySessionStore();
  const message = inbound();
  store.append({
    session_id: message.session_id,
    surface: message.surface,
    role: 'user',
    text: message.text,
    ts: message.ts,
  });
  registry.register({
    id: 'driver',
    update(ctx): void {
      if (ctx.turn_index < turns.length - 1) ctx.requestContinue();
    },
  });
  let nextId = 0;

  const summary = await runStream({
    registry,
    channel,
    sessionStore: store,
    inbound: message,
    runTurn: async (ctx) => turns[ctx.turn_index],
    mintId: () => `turn-${nextId++}`,
    capacity: { max_turns: turns.length },
  });

  return { channel, summary };
};

describe('D-160 P1 I-6 projection', () => {
  it('projects a multi-turn loop as notes plus one final message and one done', async () => {
    const { channel, summary } = await runProjection([
      {
        text: 'internal draft',
        tool_calls: [{ name: 'mail.search', ok: true }],
      },
      { text: 'final answer' },
    ]);

    expect(summary.final_text).toBe('final answer');
    expect(channel.events).toEqual([
      {
        kind: 'transparency',
        session_id: 'session-1',
        turn_id: 'turn-0',
        note: 'Ran mail.search',
      },
      {
        kind: 'message',
        session_id: 'session-1',
        turn_id: 'turn-1',
        text: 'final answer',
      },
      { kind: 'done', session_id: 'session-1', turn_id: 'turn-1' },
    ]);
  });

  it('does not emit one message per internal turn', async () => {
    const { channel } = await runProjection([
      { text: 'first internal text' },
      { text: 'second internal text' },
      { text: 'final text' },
    ]);

    const messages = channel.events.filter((event) => event.kind === 'message');
    expect(messages).toEqual([
      {
        kind: 'message',
        session_id: 'session-1',
        turn_id: 'turn-2',
        text: 'final text',
      },
    ]);
  });

  it('projects tool calls from intermediate turns before the final answer', async () => {
    const { channel } = await runProjection([
      { text: 'first', tool_calls: [{ name: 'mail.search', ok: true }] },
      { text: 'second', tool_calls: [{ name: 'calendar.read', ok: true }] },
      { text: 'final' },
    ]);

    expect(channel.events.map((event) => event.kind)).toEqual([
      'transparency',
      'transparency',
      'message',
      'done',
    ]);
    expect(
      channel.events
        .filter((event) => event.kind === 'transparency')
        .map((event) => event.note),
    ).toEqual(['Ran mail.search', 'Ran calendar.read']);
  });

  it('projects failed tool calls as transparency rather than assistant messages', async () => {
    const { channel } = await runProjection([
      { text: 'tool failed', tool_calls: [{ name: 'crm.lookup', ok: false }] },
      { text: 'final after failure' },
    ]);

    expect(channel.events[0]).toEqual({
      kind: 'transparency',
      session_id: 'session-1',
      turn_id: 'turn-0',
      note: 'Tried crm.lookup',
    });
    expect(
      channel.events.filter((event) => event.kind === 'message'),
    ).toHaveLength(1);
  });

  it('still emits only the final assistant answer when the final turn has tool calls', async () => {
    const { channel } = await runProjection([
      { text: 'first', tool_calls: [{ name: 'mail.search', ok: true }] },
      { text: 'final', tool_calls: [{ name: 'files.read', ok: true }] },
    ]);

    expect(channel.events).toEqual([
      {
        kind: 'transparency',
        session_id: 'session-1',
        turn_id: 'turn-0',
        note: 'Ran mail.search',
      },
      {
        kind: 'transparency',
        session_id: 'session-1',
        turn_id: 'turn-1',
        note: 'Ran files.read',
      },
      {
        kind: 'message',
        session_id: 'session-1',
        turn_id: 'turn-1',
        text: 'final',
      },
      { kind: 'done', session_id: 'session-1', turn_id: 'turn-1' },
    ]);
  });
});
