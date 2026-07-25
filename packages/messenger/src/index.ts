/** @recued/messenger — D-160 P0 `messenger` channel leaf block.
 *
 *  The `messenger` channel carries a conversation over an external app
 *  (Slack / Telegram) via `@recued/transport`, sharing the one
 *  `SessionStateStore` with the `chat` channel — one conversation, two
 *  windows (D-160 N.5 / A.5).
 *
 *  Spec: docs/d-160-spec.md § N.5 / A.5.
 */

export {
  createMessengerChannel,
  type MessengerChannel,
  type MessengerChannelOptions,
  type MessengerMediaFileSink,
} from './messenger-channel.js';
