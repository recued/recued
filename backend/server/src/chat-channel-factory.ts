import { CHAT_MAIN_TURN_TOOL_LOOP_CAP } from '@recued/contracts';
import { createChatChannel, type ChatChannel } from '@recued/chat';
import { createCapacity, type Capacity } from '@recued/middleware';
import type { ChatStore } from './storage/chat-store.js';
import { createChatBusSink, type ChatChannelBus } from './chat-channel-sink.js';
import {
  createChatStoreSessionStateStore,
  type ChatStoreBackedSessionStateStore,
} from './chat-channel-session-store.js';

export interface CreateServerChatChannelOptions {
  bus: ChatChannelBus;
  chatStore: ChatStore;
  userId: string;
  /** Forwarded to the sink. Default `true` (channel owns final delivery).
   *  The D-160 Stage 2 chat flip passes `false` — the orchestrator's
   *  rich finalize emits the fully-shaped `chat.message_complete`, so the
   *  channel must not also emit a text-only one. */
  deliverFinalMessage?: boolean;
}

/** The channel plus its cache-only session store. `runStream` needs both
 *  as separate inputs, so the factory returns the store alongside the
 *  channel (the store is otherwise internal to the channel). */
export interface ServerChatChannel {
  channel: ChatChannel;
  sessionStore: ChatStoreBackedSessionStateStore;
}

export const chatCapacity = (): Partial<Capacity> =>
  createCapacity({ max_turns: CHAT_MAIN_TURN_TOOL_LOOP_CAP });

export const createServerChatChannel = (
  options: CreateServerChatChannelOptions,
): ServerChatChannel => {
  const sink = createChatBusSink(options.bus, {
    deliverFinalMessage: options.deliverFinalMessage ?? true,
  });
  const sessionStore = createChatStoreSessionStateStore(options.chatStore);
  const channel = createChatChannel({
    sink,
    sessionStore,
    userId: options.userId,
  });
  return { channel, sessionStore };
};
