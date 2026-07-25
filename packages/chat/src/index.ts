/** @recued/chat — D-160 P0 `chat` channel leaf block.
 *
 *  Owns the D-160 stream `Channel` contract (the continuous /
 *  bidirectional surface, shared with `@recued/messenger`), the shared
 *  `SessionStateStore`, and the `chat` channel itself — the in-app
 *  webclient conversation surface over the D-121 broadcast bus.
 *
 *  Spec: docs/d-160-spec.md § N.5 / A.5.
 */

export type {
  Channel,
  ChannelInbound,
  ChannelOutbound,
  InboundHandler,
  SurfaceTag,
} from './channel.js';
export { surfaceMessengerVendor } from './channel.js';
export type { SessionEntry, SessionStateStore } from './session-store.js';
export { createInMemorySessionStore } from './session-store.js';
export {
  createChatChannel,
  type ChatBusSink,
  type ChatChannel,
  type ChatChannelOptions,
  type ChatUserMessage,
} from './chat-channel.js';
