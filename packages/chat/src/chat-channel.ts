/** D-160 P0 — the `chat` channel: the in-app conversation surface.
 *
 *  `chat` renders over the D-121 broadcast bus → webclient. Because
 *  nothing in `packages/` may import `backend/`, the bus is reached
 *  through an injected `ChatBusSink` — `backend/server/` adapts each
 *  `ChannelOutbound` to a `chat.*` D-121 broadcast event (the same
 *  injected-narrow-interface pattern the D-137 chat orchestrator uses).
 *
 *  P0 formalizes chat as a `Channel`. The wholesale D-137 chat-
 *  orchestrator rewire onto this substrate is incremental (D-160 O-5)
 *  and out of P0 scope — P0 ships the channel, P1 wires the framework.
 *
 *  Spec: docs/d-160-spec.md § N.5 / A.5.
 */

import type { ExecutionSource } from '@recued/contracts';
import type {
  Channel,
  ChannelInbound,
  ChannelOutbound,
  InboundHandler,
} from './channel.js';
import type { SessionStateStore } from './session-store.js';

/** The bus seam. `backend/server/` provides a sink that translates a
 *  `ChannelOutbound` into a D-121 `chat.*` broadcast event. */
export type ChatBusSink = (event: ChannelOutbound) => void;

export interface ChatChannelOptions {
  sink: ChatBusSink;
  sessionStore: SessionStateStore;
  /** The single warehouse user (one server = one human). Stamped onto
   *  the inbound `ExecutionSource`. */
  userId: string;
  /** Clock — injectable for deterministic tests; defaults to `Date.now`. */
  now?: () => number;
}

/** A webclient HID message arriving from the user. */
export interface ChatUserMessage {
  session_id: string;
  text: string;
}

/** The `chat` channel plus its inbound entry point. */
export interface ChatChannel extends Channel {
  /** Feed a webclient HID user message into the channel. Wired by
   *  `backend/server/` from the webclient → D-121 HID path. Resolves
   *  once the registered inbound handler has been invoked. */
  receiveUserMessage(message: ChatUserMessage): Promise<void>;
}

export const createChatChannel = (options: ChatChannelOptions): ChatChannel => {
  const now = options.now ?? Date.now;
  let inboundHandler: InboundHandler | null = null;

  return {
    surface: 'chat',

    async deliver(event: ChannelOutbound): Promise<void> {
      // Only a completed assistant message is a conversation entry —
      // token deltas / transparency notes / done markers are out-stream
      // detail, not history. The webclient receives every kind via the
      // sink for live rendering.
      if (event.kind === 'message') {
        options.sessionStore.append({
          session_id: event.session_id,
          surface: 'chat',
          role: 'assistant',
          text: event.text,
          ts: now(),
        });
      }
      options.sink(event);
    },

    onInbound(handler: InboundHandler): void {
      inboundHandler = handler;
    },

    async receiveUserMessage(message: ChatUserMessage): Promise<void> {
      const ts = now();
      options.sessionStore.append({
        session_id: message.session_id,
        surface: 'chat',
        role: 'user',
        text: message.text,
        ts,
      });
      const source: ExecutionSource = {
        channel: 'chat',
        actor: 'user_self',
        chat_session_id: message.session_id,
        user_id: options.userId,
      };
      const inbound: ChannelInbound = {
        session_id: message.session_id,
        surface: 'chat',
        text: message.text,
        from: options.userId,
        source,
        // A webclient HID message is always a genuine top-level user
        // action — `chat` has no egress→ingress re-trigger path, so the
        // I-7 hop token is always `0` here (D-160 P3).
        dispatch_depth: 0,
        ts,
      };
      await inboundHandler?.(inbound);
    },
  };
};
