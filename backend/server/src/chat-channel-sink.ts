import type { ChatBusSink, ChannelOutbound } from '@recued/chat';
import type { BroadcastChatEvent } from './chat-orchestrator.js';

/** The narrow broadcast surface the chat channel's sink emits onto. It
 *  is exactly the orchestrator's `ChatBroadcastEmitter` shape — the sink
 *  only ever produces cursor-less `chat.*` broadcast events — so the
 *  orchestrator can hand its own `deps.broadcast` straight to the
 *  channel, and the D-121 `EventBus['emit']` (which stamps the cursor)
 *  satisfies it by structural assignability. The import is type-only, so
 *  the orchestrator ↔ sink edge is erased at runtime (no require cycle). */
export interface ChatChannelBus {
  emit(event: BroadcastChatEvent): void;
}

export interface ChatChannelTransparencyNote {
  kind: 'chat.channel_note';
  note: string;
}

export const toChatChannelTransparencyNote = (
  note: string,
): ChatChannelTransparencyNote => ({
  kind: 'chat.channel_note',
  note,
});

const safeBroadcast = (
  bus: ChatChannelBus,
  event: BroadcastChatEvent,
): void => {
  try {
    bus.emit(event);
  } catch {
    // Broadcast failures are observability-only; never abort the chat turn.
  }
};

const assertNever = (_event: never): void => {};

/** Options narrowing how the sink projects `ChannelOutbound` to the bus.
 *
 *  `deliverFinalMessage` (default `true`) — whether the `message`
 *  out-stream event (the framework's post-`update` final delivery) emits
 *  `chat.message_complete`. The D-160 Stage 2 chat flip leaves the
 *  RICH finalize in the orchestrator shell (it owns durable ChatStore
 *  persistence + emits the fully-shaped `ChatMessage` row), so that path
 *  registers the channel with `deliverFinalMessage: false` to avoid a
 *  second, text-only `chat.message_complete` racing the shell's. The
 *  default preserves the standalone-channel contract (the channel owns
 *  final delivery) for any consumer that delivers through the channel. */
export interface ChatBusSinkOptions {
  deliverFinalMessage?: boolean;
}

export const createChatBusSink = (
  bus: ChatChannelBus,
  options: ChatBusSinkOptions = {},
): ChatBusSink => {
  const deliverFinalMessage = options.deliverFinalMessage ?? true;
  return (event: ChannelOutbound): void => {
    switch (event.kind) {
      case 'token':
        safeBroadcast(bus, {
          kind: 'chat.token_streamed',
          session_id: event.session_id,
          turn_id: event.turn_id,
          delta: event.delta,
        });
        return;
      case 'transparency':
        safeBroadcast(bus, {
          kind: 'chat.transparency',
          session_id: event.session_id,
          turn_id: event.turn_id,
          event: toChatChannelTransparencyNote(event.note),
        });
        return;
      case 'message':
        if (!deliverFinalMessage) return;
        safeBroadcast(bus, {
          kind: 'chat.message_complete',
          session_id: event.session_id,
          turn_id: event.turn_id,
          final: event.text,
        });
        return;
      case 'done':
        return;
      default:
        assertNever(event);
    }
  };
};
