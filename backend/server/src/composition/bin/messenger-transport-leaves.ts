/** D-192 CORE #6 (seams 4/5) — the per-vendor messenger transport + recipient
 *  leaves, and the registry-driven builders the turn / live-control composers
 *  use instead of hardcoded `{ slack, telegram }` map literals.
 *
 *  Kinds-taxonomy §0: the shared composers are written ONCE against the
 *  messenger-vendor registry (`listMessengerVendors`); the only per-vendor code
 *  is the thin adapter leaf named here by slug — the `@recued/transport`
 *  factory and the `config_json` recipient resolver. A new chat transport
 *  (Discord / Teams / …) adds ONE entry to each leaf map + its declaration, and
 *  flows through the turn AND live-control composers with no shared-code edit
 *  (the make-live acceptance test). Mirrors M1b's `MESSENGER_PROFILE_EMAIL_LEAVES`. */

import {
  createDiscordTransport,
  createSlackTransport,
  createTelegramTransport,
  createWhatsAppTransport,
  type InteractiveTransport,
} from '@recued/transport';
import { listMessengerVendors } from '@recued/contracts';
import {
  createRemoteChannel,
  type RemoteChannel,
  type RemoteChannelCredential,
} from '@recued/notification';
import type { KeyManager } from '../../key-manager.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import {
  createRemoteCredentialResolver,
  type RemoteChannelRecipientResolver,
} from './wire-remote-channel.js';
import { resolveSlackRecipient } from './wire-slack-channel.js';
import { resolveTelegramRecipient } from './wire-telegram-channel.js';
import { resolveWhatsAppRecipient } from './wire-whatsapp-channel.js';
import { resolveDiscordRecipient } from './wire-discord-channel.js';

/** Transport options threaded to a vendor's `@recued/transport` factory. All
 *  optional (each factory `??`-defaults every field, so an explicit-undefined
 *  key is byte-identical to omission), so a composer passes only what it uses:
 *  the turn threads `downloadDir` for media ingest, live-control omits it. */
export interface MessengerTransportOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  downloadDir?: string;
}

/** Per-vendor transport-factory leaf map (§0 adapter). A new chat transport
 *  adds ONE entry here; the builders below iterate it. */
export const MESSENGER_TRANSPORT_FACTORIES: Record<
  string,
  (opts?: MessengerTransportOptions) => InteractiveTransport
> = {
  slack: createSlackTransport,
  telegram: createTelegramTransport,
  whatsapp: createWhatsAppTransport,
  discord: createDiscordTransport,
};

/** Per-vendor recipient-resolver leaf map — the `config_json` recipient shape
 *  (Slack `channel_id`, Telegram `chat_id`), the one real per-vendor delta in
 *  the shared credential-resolution path. */
export const MESSENGER_RECIPIENT_RESOLVERS: Record<string, RemoteChannelRecipientResolver> = {
  slack: resolveSlackRecipient,
  telegram: resolveTelegramRecipient,
  // ⚠ WhatsApp's is a PAIR, not an id — `<phone_number_id>/<wa_id>`. See
  // `wire-whatsapp-channel.ts`: the send URL is account-scoped, so the address
  // carries both halves rather than widening the shared transport contract.
  whatsapp: resolveWhatsAppRecipient,
  // The simplest of the four: the channel id is BOTH the send URL and the bound
  // conversation, so one field does both jobs.
  discord: resolveDiscordRecipient,
};

/** Build the `vendor → InteractiveTransport` map by iterating the messenger
 *  registry + the transport-factory leaves — replaces the hardcoded
 *  `{ slack, telegram }` literal in the turn / live-control composers. A
 *  declared vendor with no factory leaf is skipped (structural no-op). */
export const buildMessengerTransports = (
  opts: MessengerTransportOptions = {},
): Record<string, InteractiveTransport> => {
  const out: Record<string, InteractiveTransport> = {};
  for (const vendor of listMessengerVendors()) {
    const factory = MESSENGER_TRANSPORT_FACTORIES[vendor];
    if (factory !== undefined) out[vendor] = factory(opts);
  }
  return out;
};

/** Build the `vendor → credential resolver` map by iterating the registry +
 *  the recipient-resolver leaves. Each resolver reads the canonical
 *  `connection.notification.<vendor>` row per call (a boot→unlock transition
 *  lands without a rebuild). */
export const buildMessengerCredentialResolvers = (deps: {
  connectionStore: ConnectionStoreSqlite;
  keys?: KeyManager;
}): Record<string, () => Promise<RemoteChannelCredential | null>> => {
  const out: Record<string, () => Promise<RemoteChannelCredential | null>> = {};
  for (const vendor of listMessengerVendors()) {
    const resolveRecipient = MESSENGER_RECIPIENT_RESOLVERS[vendor];
    if (resolveRecipient !== undefined) {
      out[vendor] = createRemoteCredentialResolver({
        connectionStore: deps.connectionStore,
        vendor,
        resolveRecipient,
        ...(deps.keys ? { keys: deps.keys } : {}),
      });
    }
  }
  return out;
};

/** Build the `vendor → RemoteChannel` registry (D-192 CORE #6 seam 7 / Group D)
 *  by iterating the messenger registry + the transport-factory and
 *  recipient-resolver leaves, wrapping each pair with `createRemoteChannel`.
 *  Replaces the two hardcoded `composeSlackChannel` / `composeTelegramChannel`
 *  calls in `compose-execution-context`: the ONE map returned here is threaded
 *  to BOTH the notification block's fan-out array AND the inbound-answer
 *  dispatcher, so the block's `closeAsk` and the dispatcher's `parseInboundReply`
 *  act on the SAME `RemoteChannel` instances (D-163 lock-step invariant — build
 *  the registry ONCE, thread that one map to both).
 *
 *  A declared vendor missing either leaf is skipped (structural no-op).
 *  `createRemoteChannel` fails LOUD if a vendor's transport slug is not a
 *  registered notification `ChannelName` (seam 10).
 *
 *  ⛔ THERE IS NO CHANNEL LIST TO EDIT. This used to read "a new chat transport
 *  must be added to `CHANNEL_NAMES` first", which is wrong twice: `CHANNEL_NAMES`
 *  is a derived ALIAS nothing imports, and `NOTIFICATION_CHANNEL_NAMES` SPLICES
 *  `...MESSENGER_VENDOR_SLUGS`, so a declared vendor is already a channel. The
 *  procedure is the one `messenger-vendors.ts` states five lines under its own
 *  slug list: the slug + a `MESSENGER_VENDOR_DECLARATIONS` entry (a boot check
 *  enforces both directions) + the adapter leaves below. "Nothing else to
 *  widen." Following the old note sent you to hand-edit a derived list. */
export const buildMessengerRemoteChannels = (deps: {
  connectionStore: ConnectionStoreSqlite;
  keys?: KeyManager;
  transportOptions?: MessengerTransportOptions;
}): Record<string, RemoteChannel> => {
  const transports = buildMessengerTransports(deps.transportOptions ?? {});
  const resolvers = buildMessengerCredentialResolvers({
    connectionStore: deps.connectionStore,
    ...(deps.keys ? { keys: deps.keys } : {}),
  });
  const out: Record<string, RemoteChannel> = {};
  for (const vendor of listMessengerVendors()) {
    const transport = transports[vendor];
    const resolveCredential = resolvers[vendor];
    if (transport !== undefined && resolveCredential !== undefined) {
      out[vendor] = createRemoteChannel({ transport, resolveCredential });
    }
  }
  return out;
};
