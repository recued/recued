/** Notification channel boot registry — the explicit list of pluggable
 *  outbound notification channels the server's connection-notification
 *  substrate wires at boot.
 *
 *  Before this registry, the channel → subtype mapping + per-channel
 *  dispatcher closure construction lived inside
 *  `notification-dispatchers.ts` as a hard-coded `SUBTYPE_FOR_CHANNEL`
 *  constant + `createChannelDispatchersFromConnections` loop. Every
 *  additional channel (sms, discord webhook, …) would have meant
 *  editing the same central file rather than appending to an
 *  enumeration.
 *
 *  The registry inverts that, mirroring `VENDOR_BOOT_REGISTRY`. The
 *  connection-notification composer iterates this list once; each
 *  channel module owns its own boot under `data/notification/<channel>/
 *  boot.ts` and decides what to build internally. Adding a channel
 *  becomes:
 *
 *    1. Widen `NotificationChannel` in `../notification-handler.ts`
 *       (and `NotificationSubtype` in `@recued/contracts` if the wire
 *       name differs from the channel id).
 *    2. New `data/notification/<channel>/boot.ts` exporting
 *       `boot<Channel>Channel(deps)`.
 *    3. One entry appended to `NOTIFICATION_CHANNEL_REGISTRY` below.
 *    4. Per-subtype dispatch in `packages/ingredients/src/
 *       connection-notification.ts`'s switch — the wire transport stays
 *       in the portable ingredients package; only the server-side
 *       bridge layer plugs in here.
 *
 *  The contract is intentionally minimal today: every channel's bridge
 *  dispatcher is structurally identical (find the first matching
 *  connection row by subtype → call the shared notification handler).
 *  The shared closure builder lives in `notification-dispatchers.ts` as
 *  `buildSubtypeDispatcher`. Per-channel modules invoke it with their
 *  own channel + subtype labels so future divergence (e.g. per-channel
 *  rate limit, default-config validator, capability flag) has a
 *  natural home without touching the registry contract. */

import { MESSENGER_VENDOR_SLUGS, type NotificationSubtype } from '@recued/contracts';
import type { ConnectionKindHandler } from '@recued/ingredients';
import { bootChatTransportChannel } from './notification/chat-transport/boot.js';
import { bootEmailChannel } from './notification/email/boot.js';
import { bootInAppChannel } from './notification/in-app/boot.js';
import type {
  NotificationChannel,
  NotificationChannelDispatcher,
} from '../notification-handler.js';
import type { ConnectionStoreSqlite } from '../storage/connection-store.js';

/** Shared deps passed to every channel's `boot`. The connection store
 *  is the per-call lookup substrate (rescanned on every dispatch so
 *  re-enrollments pick up immediately — see `notification-dispatchers.ts`
 *  for the rationale). The handler is the same
 *  `ConnectionKindHandler` instance the connection adapter uses, so
 *  one auth-decode + transport path services both the connection
 *  adapter and the kernel `notification-send` dispatcher.
 *
 *  `channel` + `subtype` are threaded from the registry entry so the
 *  registry remains the single source of truth — boot modules build
 *  their dispatcher against the registry's labels rather than hard-
 *  coding their own. A future per-channel override is still free to
 *  ignore these and pass custom values to `buildSubtypeDispatcher`,
 *  but the default flow keeps registry metadata authoritative. */
export interface NotificationChannelBootDeps {
  connectionStore: ConnectionStoreSqlite;
  notificationHandler: ConnectionKindHandler;
  channel: NotificationChannel;
  subtype: NotificationSubtype;
  /** D-312 — the server's own broadcast of a notification to its paired
   *  clients. The in-app channel falls back to it when no in-app connection is
   *  enrolled: in-app has no credentials and no destination to enroll. */
  emitInApp?: (body: { text: string; title?: string; link_url?: string }) => void;
}

/** Per-channel boot entry — the channel id used by the kernel
 *  `notification-send` rpc + the underlying connection-row subtype +
 *  the channel's dispatcher builder.
 *
 *  `channel` and `subtype` differ for `in_app` ↔ `in-app` (underscore
 *  for rpc identifiers, dash for connection-row subtype — D-122 P4.5
 *  rpc contract vs D-125 P1.1 row contract). Carrying both on the entry
 *  keeps the mapping explicit + lets future channels diverge without
 *  touching a central constant. */
export interface NotificationChannelEntry {
  channel: NotificationChannel;
  subtype: NotificationSubtype;
  boot: (deps: NotificationChannelBootDeps) => NotificationChannelDispatcher;
}

/** The canonical channel list. Order is preserved by registry
 *  iteration; the resulting dispatcher map is keyed on channel id so
 *  ordering only affects deterministic boot logs + audit traces.
 *
 *  Static imports — each per-channel module is server-side core that
 *  loads with the connection-notification substrate regardless. There
 *  is no defensible deferral path (unlike vendors, which are skipped
 *  for dbless harnesses): the channel registry exists precisely
 *  because the connection store is wired. */
export const NOTIFICATION_CHANNEL_REGISTRY: ReadonlyArray<NotificationChannelEntry> = [
  // D-192 WhatsApp make-live — the chat transports are DERIVED, not listed.
  //
  // This was a hand-spelled array, and an ARRAY cannot be checked for
  // completeness by the compiler the way a `Record` can. So a newly declared chat
  // transport type-checked as a delivery channel everywhere (seam 10 made
  // `NOTIFICATION_DELIVERY_CHANNELS` registry-driven) while having NO entry here —
  // meaning no dispatcher, meaning `notification.send` aimed at it would resolve,
  // enrol, probe healthy, and then do NOTHING. Green, ready, and mute: the same
  // failure this arc has now met three times, and the reason it is worth deriving
  // a four-line list.
  //
  // Deriving is honest rather than clever, because the per-vendor `boot<X>Channel`
  // functions carried no vendor knowledge at all: all four were byte-identical
  // (`buildSubtypeDispatcher(deps)`), differing only in the labels the registry
  // already supplies. `channel === subtype` for every chat transport (the two
  // spellings only diverge for `in_app` / `in-app`, which is not one).
  ...MESSENGER_VENDOR_SLUGS.map((vendor) => ({
    channel: vendor,
    subtype: vendor,
    boot: bootChatTransportChannel,
  })),
  // NOT chat transports, and named literally for that reason: `email` is a façade
  // over a warehouse mail instance, `in_app` rides the broadcast bus — and its
  // channel id genuinely differs from its wire subtype (`in_app` / `in-app`).
  { channel: 'email',  subtype: 'email',  boot: bootEmailChannel  },
  { channel: 'in_app', subtype: 'in-app', boot: bootInAppChannel  },
];
