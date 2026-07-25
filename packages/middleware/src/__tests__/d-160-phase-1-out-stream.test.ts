/** D-160 P1 -- transparency out-stream.
 *
 *  Spec: D-160 sections N.6 / A.4 and Must Hold I-6.
 */

import { describe, expect, it } from 'vitest';
import type { Channel, ChannelOutbound } from '@recued/chat';
import {
  createOutStream,
  projectTurnToOutStream,
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

describe('D-160 P1 createOutStream', () => {
  it('token delivers a token ChannelOutbound event', async () => {
    const channel = recordingChannel();
    const out = createOutStream(channel, 'session-1');

    await out.token('turn-1', 'hel');

    expect(channel.events).toEqual([
      {
        kind: 'token',
        session_id: 'session-1',
        turn_id: 'turn-1',
        delta: 'hel',
      },
    ]);
  });

  it('note delivers a transparency ChannelOutbound event', async () => {
    const channel = recordingChannel();
    const out = createOutStream(channel, 'session-1');

    await out.note('turn-1', 'Ran lookup');

    expect(channel.events).toEqual([
      {
        kind: 'transparency',
        session_id: 'session-1',
        turn_id: 'turn-1',
        note: 'Ran lookup',
      },
    ]);
  });

  it('message delivers a message ChannelOutbound event', async () => {
    const channel = recordingChannel();
    const out = createOutStream(channel, 'session-1');

    await out.message('turn-1', 'assistant answer');

    expect(channel.events).toEqual([
      {
        kind: 'message',
        session_id: 'session-1',
        turn_id: 'turn-1',
        text: 'assistant answer',
      },
    ]);
  });

  it('done delivers a done ChannelOutbound event', async () => {
    const channel = recordingChannel();
    const out = createOutStream(channel, 'session-1');

    await out.done('turn-1');

    expect(channel.events).toEqual([
      { kind: 'done', session_id: 'session-1', turn_id: 'turn-1' },
    ]);
  });

  it('delivered counts successful deliveries only', async () => {
    const channel = recordingChannel();
    const out = createOutStream(channel, 'session-1');

    await out.token('turn-1', 'a');
    await out.note('turn-1', 'Ran lookup');
    await out.message('turn-1', 'answer');
    await out.done('turn-1');

    expect(out.delivered()).toBe(4);
  });

  it('preserves event order across methods', async () => {
    const channel = recordingChannel();
    const out = createOutStream(channel, 'session-1');

    await out.token('turn-1', 'a');
    await out.note('turn-1', 'Ran lookup');
    await out.message('turn-1', 'answer');
    await out.done('turn-1');

    expect(channel.events.map((event) => event.kind)).toEqual([
      'token',
      'transparency',
      'message',
      'done',
    ]);
  });

  it('does not count a delivery that throws', async () => {
    const channel: Channel = {
      surface: 'chat',
      async deliver(): Promise<void> {
        throw new Error('bus down');
      },
      onInbound(): void {
        return undefined;
      },
    };
    const out = createOutStream(channel, 'session-1');

    await expect(out.message('turn-1', 'answer')).rejects.toThrow('bus down');
    expect(out.delivered()).toBe(0);
  });
});

describe('D-160 P1 projectTurnToOutStream', () => {
  it('projects successful and failed tool calls as transparency notes', async () => {
    const channel = recordingChannel();
    const out = createOutStream(channel, 'session-1');

    await projectTurnToOutStream(out, 'turn-1', {
      text: 'internal text',
      tool_calls: [
        { name: 'mail.search', ok: true },
        { name: 'crm.lookup', ok: false },
      ],
    });

    expect(channel.events).toEqual([
      {
        kind: 'transparency',
        session_id: 'session-1',
        turn_id: 'turn-1',
        note: 'Ran mail.search',
      },
      {
        kind: 'transparency',
        session_id: 'session-1',
        turn_id: 'turn-1',
        note: 'Tried crm.lookup',
      },
    ]);
  });

  it('projects a turn with no tool calls to nothing', async () => {
    const channel = recordingChannel();
    const out = createOutStream(channel, 'session-1');

    await projectTurnToOutStream(out, 'turn-1', { text: 'plain answer' });

    expect(channel.events).toEqual([]);
    expect(out.delivered()).toBe(0);
  });
});
