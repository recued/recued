/** D-163 — Telegram `RemoteChannel` composer (thin shim over
 *  `composeRemoteChannel`).
 *
 *  The D-163 notification block's Telegram adapter binds to the
 *  `connection.notification` record whose `name === 'telegram'`. The
 *  consolidated `composeRemoteChannel` owns the credential resolver;
 *  this file contributes the two Telegram-specific pieces:
 *    - the transport factory (`createTelegramTransport`), with optional
 *      `fetchImpl` / `timeoutMs` overrides for tests
 *    - the recipient validator: `config.chat_id` may be either a
 *      non-empty string (`@channelname` form for public channels) OR a
 *      finite number (numeric chat ids for private chats and super-
 *      groups, all within JS safe-integer range). Both shapes are
 *      coerced to string for the transport's `OutboundMessage.recipient:
 *      string` slot. Mirrors the existing
 *      `connection-notification` ingredient's telegram branch
 *      (`packages/ingredients/src/connection-notification.ts`).
 *
 *  Spec: D-163 § N.5 / A.1; `connection.notification.telegram`
 *  shape: D-148 § A.13 (auth); outbound transport:
 *  D-160 P0 `createTelegramTransport` (`@recued/transport`). */

import type { RemoteChannel } from '@recued/notification';
import { createTelegramTransport } from '@recued/transport';
import {
  composeRemoteChannel,
  type RemoteChannelRecipientResolver,
} from './wire-remote-channel.js';
import type { KeyManager } from '../../key-manager.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';

/** Telegram: `config.chat_id` is a non-empty string OR a finite
 *  number; coerce to string. Exported for the messenger turn wiring
 *  (`wire-messenger-turn.ts`), which resolves the same
 *  `connection.notification.telegram` row. */
export const resolveTelegramRecipient: RemoteChannelRecipientResolver = (config) => {
  if (config === null) return null;
  const chat_id_raw = config.chat_id;
  if (typeof chat_id_raw === 'string' && chat_id_raw.length > 0) {
    return chat_id_raw;
  }
  if (typeof chat_id_raw === 'number' && Number.isFinite(chat_id_raw)) {
    return String(chat_id_raw);
  }
  return null;
};

export interface ComposeTelegramChannelDeps {
  connectionStore: ConnectionStoreSqlite;
  /** Optional sub-DEK source. See `composeRemoteChannel`'s `keys` doc
   *  for the re-read-per-dispatch divergence rationale. */
  keys?: KeyManager;
  /** Test-only override for the raw HTTP path; defaults to
   *  `globalThis.fetch` inside `createTelegramTransport`. */
  fetchImpl?: typeof fetch;
  /** Test-only override for the Telegram Bot API timeout; defaults to
   *  the transport's `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export const composeTelegramChannel = (
  deps: ComposeTelegramChannelDeps,
): RemoteChannel => {
  // `createTelegramTransport` already `??`-defaults `fetchImpl` and
  // `timeoutMs`, so passing `undefined` is byte-identical to omitting
  // the key.
  const transport = createTelegramTransport({
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
  return composeRemoteChannel({
    connectionStore: deps.connectionStore,
    transport,
    resolveRecipient: resolveTelegramRecipient,
    ...(deps.keys ? { keys: deps.keys } : {}),
  });
};
