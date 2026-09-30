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
  type Transport,
} from '@recued/transport';
import { getMessengerVendorDeclaration, listMessengerVendors } from '@recued/contracts';
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
import type { MessengerNotificationRefresher } from '../../messenger-notification-refresh.js';
import { createTeamsTransport, normalizeTeamsChatId } from '@recued/transport';

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
  (opts?: MessengerTransportOptions) => InteractiveTransport | Transport
> = {
  slack: createSlackTransport,
  telegram: createTelegramTransport,
  whatsapp: createWhatsAppTransport,
  discord: createDiscordTransport,
  // ⛔ The only BASE `Transport` here — no `sendPrompt`. A Teams card action is
  // delivered to a Bot Framework endpoint and Graph polling returns messages,
  // never interactions, so there is no button press it could ever resolve. Its
  // declaration says `capability: 'landing-page'`, and `createRemoteChannel`
  // throws at construction if those two ever disagree.
  teams: createTeamsTransport,
};

/** Graph chat ids are opaque strings (`19:…@thread.v2`) — never numeric, so
 *  unlike Discord/Telegram there is no unquoted-large-integer hazard to guard
 *  and no coercion to do. Rejecting a non-string is the whole validation. */
const resolveTeamsRecipient: RemoteChannelRecipientResolver = (config) => {
  if (config === null) return null;
  const raw = config.chat_id;
  if (typeof raw !== 'string') return null;
  // Accepts a raw id OR a pasted Teams link — Teams no longer shows the id in
  // the address bar, so Copy link is what an owner can actually get.
  return normalizeTeamsChatId(raw);
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
  teams: resolveTeamsRecipient,
};

/** Build the `vendor → InteractiveTransport` map by iterating the messenger
 *  registry + the transport-factory leaves — replaces the hardcoded
 *  `{ slack, telegram }` literal in the turn / live-control composers. A
 *  declared vendor with no factory leaf is skipped (structural no-op).
 *
 *  ⛔ D-238 — a NON-INTERACTIVE vendor is skipped too, and that is a narrowing
 *  rather than an oversight. Both consumers of this map need the prompt surface:
 *  the turn path decodes button presses, and live control renders `/recued`
 *  option buttons. Teams has neither (Graph cannot deliver a card action to a
 *  poller), so widening the map's type to admit it would push the failure into
 *  those composers — where a missing `sendPrompt` surfaces as a runtime throw on
 *  a best-effort path. Excluding it here keeps their contract exactly as it was.
 *
 *  🔑 Filtered on the CAPABILITY the transport actually exposes, not on a vendor
 *  list: the two facts cannot drift, and the next non-interactive vendor is
 *  handled with no edit. */
export const buildMessengerTransports = (
  opts: MessengerTransportOptions = {},
): Record<string, InteractiveTransport> => {
  const out: Record<string, InteractiveTransport> = {};
  for (const [vendor, transport] of Object.entries(buildAllMessengerTransports(opts))) {
    if (!isInteractiveTransport(transport)) continue;
    out[vendor] = transport;
  }
  return out;
};

/** Does this transport expose the prompt surface? The one narrowing, in one
 *  place, so the channel builder and the turn/live-control builder cannot
 *  disagree about what "interactive" means. */
const isInteractiveTransport = (t: Transport): t is InteractiveTransport =>
  typeof (t as InteractiveTransport).sendPrompt === 'function';

/** Build the `vendor → transport` map with NO capability filter — every declared
 *  vendor that has a factory leaf.
 *
 *  ⛔ This is what the NOTIFICATION CHANNEL registry must build from, and getting
 *  that wrong is how Teams shipped invisible: `buildMessengerRemoteChannels` fed
 *  off the interactive-only map, so `messengerChannels.teams` never existed —
 *  absent from fan-out, absent from readiness, and inbound events dropped as "no
 *  channel adapter wired", with every unit test still green because each one
 *  built its channel directly. A non-interactive vendor is a perfectly good
 *  NOTIFY + APPROVE-by-link channel; it is only the turn and live-control paths
 *  that genuinely need `sendPrompt`. */
export const buildAllMessengerTransports = (
  opts: MessengerTransportOptions = {},
): Record<string, Transport> => {
  const out: Record<string, Transport> = {};
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
  /** D-238 — renew an expiring credential before the send path reads it. Pass
   *  the SAME instance given to the ingress supervisor: single-flight is
   *  per-instance, and two of them race on a rotating refresh token. */
  refreshAuth?: MessengerNotificationRefresher;
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
        ...(deps.refreshAuth ? { refreshAuth: deps.refreshAuth } : {}),
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
  /** D-238 — the `/ask/<id>` builder for a `landing-page` channel, which
   *  composes its OWN answer affordance (`withAnswerLink` skips it precisely so
   *  the URL is not appended twice). It answers nothing on a non-public
   *  deployment; the ask then carries the typed-reply hint alone. */
  answerLink?: (ask_id: string, via?: string) => string | undefined;
  /** D-238 — see `buildMessengerCredentialResolvers`. */
  refreshAuth?: MessengerNotificationRefresher;
}): Record<string, RemoteChannel> => {
  // ⛔ ALL transports, not the interactive subset — see
  // `buildAllMessengerTransports`. A `landing-page` vendor is a real channel.
  const transports = buildAllMessengerTransports(deps.transportOptions ?? {});
  const resolvers = buildMessengerCredentialResolvers({
    connectionStore: deps.connectionStore,
    ...(deps.keys ? { keys: deps.keys } : {}),
    ...(deps.refreshAuth ? { refreshAuth: deps.refreshAuth } : {}),
  });
  const out: Record<string, RemoteChannel> = {};
  for (const vendor of listMessengerVendors()) {
    const transport = transports[vendor];
    const resolveCredential = resolvers[vendor];
    if (transport === undefined || resolveCredential === undefined) continue;
    // The declaration is the authority on how an ask renders here. Omitting it
    // would default every channel to `inline`, and `createRemoteChannel` then
    // throws at construction for a transport with no `sendPrompt` — which is the
    // right failure, but only if the capability is actually threaded.
    const capability = getMessengerVendorDeclaration(vendor)?.capability;
    out[vendor] = createRemoteChannel({
      transport,
      resolveCredential,
      ...(capability !== undefined ? { capability } : {}),
      ...(deps.answerLink !== undefined ? { answerLink: deps.answerLink } : {}),
    });
  }
  return out;
};
