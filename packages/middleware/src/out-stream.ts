/** D-160 P1 — the transparency out-stream (§ N.6 / A.4).
 *
 *  The out-stream is the pipeline's continuous, user-facing output —
 *  not a hook, the pipeline's *output*. A turn is internal (N.2 / I-6):
 *  what reaches the user is a *selective projection* over turns, and
 *  the out-stream is the typed gate that carries it. Each method builds
 *  one `ChannelOutbound` and hands it to the channel; the channel
 *  decides how its surface renders it.
 *
 *  `projectTurnToOutStream` is the projection rule the framework
 *  applies to an *internal* turn: its tool activity becomes
 *  transparency *notes*, never a flood of raw turn messages. The final
 *  assistant answer is emitted once, separately, by the pipeline — so
 *  a multi-turn tool-calling loop reads as a legible narration, not a
 *  raw turn dump (I-6 / TR-5).
 *
 *  Note — `./transparency-stream/` holds the richer D-145 closed-
 *  taxonomy `TransparencyEvent` composer; a middleware that emits
 *  structured transparency events composes through that. This
 *  framework out-stream is the channel-carrier projection — the
 *  minimal surface the turn loop itself needs.
 *
 *  Spec: D-160 § N.6 / A.4.
 */

import type { Channel } from '@recued/chat';

import type { ChannelOutbound, OutStream, TurnOutput } from './types.js';

/** Create an out-stream bound to a channel + session. Every event it
 *  emits is delivered through `channel.deliver`. */
export const createOutStream = (
  channel: Channel,
  session_id: string,
): OutStream => {
  let count = 0;

  const deliver = async (event: ChannelOutbound): Promise<void> => {
    await channel.deliver(event);
    // Count delivered, not attempted — a `deliver` that throws is not
    // a delivery; the throw propagates to the pipeline.
    count += 1;
  };

  return {
    async token(turn_id: string, delta: string): Promise<void> {
      await deliver({ kind: 'token', session_id, turn_id, delta });
    },
    async note(turn_id: string, text: string): Promise<void> {
      await deliver({ kind: 'transparency', session_id, turn_id, note: text });
    },
    async message(turn_id: string, text: string): Promise<void> {
      await deliver({ kind: 'message', session_id, turn_id, text });
    },
    async done(turn_id: string): Promise<void> {
      await deliver({ kind: 'done', session_id, turn_id });
    },
    delivered(): number {
      return count;
    },
  };
};

/** Project one *internal* turn onto the out-stream (§ N.6 / I-6).
 *
 *  The rule: a turn's tool calls become transparency notes — the user
 *  sees *that* a tool ran without being shown the raw turn. The turn's
 *  assistant text is deliberately NOT emitted here; intermediate turns
 *  are internal, and the pipeline emits the *final* turn's text once,
 *  as a single `message`. A turn with no tool calls projects to
 *  nothing — silence is the right projection for a plain answer turn
 *  whose text the pipeline will surface as the final message. */
export const projectTurnToOutStream = async (
  out: OutStream,
  turn_id: string,
  output: TurnOutput,
): Promise<void> => {
  for (const call of output.tool_calls ?? []) {
    await out.note(
      turn_id,
      `${call.ok ? 'Ran' : 'Tried'} ${call.name}`,
    );
  }
};
