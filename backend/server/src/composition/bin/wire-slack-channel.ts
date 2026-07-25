/** D-163 — Slack `RemoteChannel` composer (thin shim over
 *  `composeRemoteChannel`).
 *
 *  The D-163 notification block's Slack adapter binds to the
 *  `connection.notification` record whose `name === 'slack'`. The
 *  consolidated `composeRemoteChannel` owns the credential resolver
 *  (connection-store lookup keyed on `transport.vendor`, sub-DEK
 *  decode, bearer-auth narrowing, config_json safe-parse); this file
 *  contributes the two Slack-specific pieces:
 *    - the transport factory (`createSlackTransport`), with optional
 *      `fetchImpl` / `timeoutMs` overrides for tests
 *    - the recipient validator: `config.channel_id` must be a
 *      non-empty string. Slack channel ids are uppercase alphanumeric
 *      tokens (e.g. `C0123456789`) — never numeric — so the validator
 *      stays string-only.
 *
 *  Spec: D-163 § N.5 / A.1; `connection.notification.slack`
 *  shape: D-125 § Phase 1.1; outbound transport: D-160 P0
 *  `createSlackTransport` (`@recued/transport`). */

import type { RemoteChannel } from '@recued/notification';
import { createSlackTransport } from '@recued/transport';
import {
  composeRemoteChannel,
  type RemoteChannelRecipientResolver,
} from './wire-remote-channel.js';
import type { KeyManager } from '../../key-manager.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';

/** Slack: `config.channel_id` must be a non-empty string. Exported for
 *  the messenger turn wiring (`wire-messenger-turn.ts`), which resolves
 *  the same `connection.notification.slack` row. */
export const resolveSlackRecipient: RemoteChannelRecipientResolver = (config) => {
  if (config === null) return null;
  const channel_id = config.channel_id;
  if (typeof channel_id !== 'string' || channel_id.length === 0) return null;
  return channel_id;
};

export interface ComposeSlackChannelDeps {
  connectionStore: ConnectionStoreSqlite;
  /** Optional sub-DEK source. See `composeRemoteChannel`'s `keys` doc
   *  for the re-read-per-dispatch divergence rationale. */
  keys?: KeyManager;
  /** Test-only override for the raw HTTP path; defaults to
   *  `globalThis.fetch` inside `createSlackTransport`. */
  fetchImpl?: typeof fetch;
  /** Test-only override for the Slack API timeout; defaults to the
   *  transport's `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export const composeSlackChannel = (
  deps: ComposeSlackChannelDeps,
): RemoteChannel => {
  // `createSlackTransport` already `??`-defaults `fetchImpl` and
  // `timeoutMs`, so passing `undefined` is byte-identical to omitting
  // the key.
  const transport = createSlackTransport({
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
  });
  return composeRemoteChannel({
    connectionStore: deps.connectionStore,
    transport,
    resolveRecipient: resolveSlackRecipient,
    ...(deps.keys ? { keys: deps.keys } : {}),
  });
};
