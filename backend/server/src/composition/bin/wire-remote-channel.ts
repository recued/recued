/** D-163 — consolidated `RemoteChannel` composer for transport-backed
 *  credential channels.
 *
 *  Slack (commit 76d4cc4d) and Telegram (commit 20613f3e) shipped
 *  byte-similar composer files — only the transport factory, the
 *  recipient field name, and the recipient type validator differ. With
 *  two instances present, `composeRemoteChannel` extracts the shared
 *  structure: the credential resolver (connection-store lookup, sub-DEK
 *  decode, bearer-auth narrowing, config_json safe-parse) + the channel
 *  wrap (`createRemoteChannel`).
 *
 *  Per-vendor concerns stay in the per-vendor wrapper (`composeSlackChannel`
 *  / `composeTelegramChannel`):
 *    - Building the transport with vendor-specific HTTP defaults
 *      (`createSlackTransport` / `createTelegramTransport`).
 *    - Defining the `resolveRecipient` validator for the vendor's config
 *      shape (Slack: `channel_id` string-only; Telegram: `chat_id`
 *      string-OR-finite-number).
 *
 *  Lock-step invariant (D-163 I-4) — the `connection.notification.<name>`
 *  row this channel resolves against is keyed on `transport.vendor`, NOT
 *  a separate `connectionName` parameter. That makes adapter name
 *  (the channel's `name`, set by `createRemoteChannel` from
 *  `transport.vendor`) and credential row lookup
 *  (`connectionStore.get('notification', transport.vendor)`) share the
 *  same field — the probe's `hasAdapter(name)` and the credential read
 *  cannot diverge by construction.
 *
 *  Spec: D-163 § N.5 / A.1; outbound transport contract:
 *  D-160 P0 (`@recued/transport`). */

import {
  getMessengerVendorDeclaration,
  MESSENGER_PRINCIPAL_CONFIG_KEY,
  resolveMessengerSendToken,
} from '@recued/contracts';
import {
  createRemoteChannel,
  type RemoteChannel,
  type RemoteChannelCredential,
} from '@recued/notification';
import type { InteractiveTransport } from '@recued/transport';
import { decodeAuthFromStorage } from '../../connection-handler.js';
import type { MessengerNotificationRefresher } from '../../messenger-notification-refresh.js';
import type { KeyManager } from '../../key-manager.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';

/** Vendor-specific recipient validator. Reads the parsed config (or
 *  null when malformed) and returns either a string recipient for the
 *  transport's `OutboundMessage.recipient: string` slot, or null when
 *  the config doesn't carry a valid recipient. The helper threads
 *  `config: null` through when `config_json` was malformed or
 *  non-object, so validators must handle that case (typically returning
 *  null). */
export type RemoteChannelRecipientResolver = (
  config: Record<string, unknown> | null,
) => string | null;

export interface ComposeRemoteChannelDeps {
  connectionStore: ConnectionStoreSqlite;
  /** Pre-built vendor transport. The channel's `name` is
   *  `transport.vendor`, and the same `vendor` is used as the
   *  `connection.notification.<name>` row lookup key. */
  transport: InteractiveTransport;
  /** Vendor-specific recipient validator. */
  resolveRecipient: RemoteChannelRecipientResolver;
  /** Optional sub-DEK source. Re-read inside `resolveCredential` per
   *  call (NOT captured at compose time) — divergence from
   *  `composeConnectionNotification`'s snapshot-at-boot pattern. The
   *  per-call read lets a mid-process KeyManager transition (boot →
   *  unlock) land transparently on delivery without a channel
   *  rebuild, which matters because the composer runs at boot whenever
   *  `connectionStoreRef` is wired (Settings can list the row before
   *  the user has unlocked). Locked / decrypt-failure throws still
   *  propagate to the channel's best-effort fan-out catch. */
  keys?: KeyManager;
  /** D-238 — the `/ask/<ask_id>` builder, threaded to a `landing-page` channel
   *  so its ask carries a link as well as the typed-reply hint. Absent on a
   *  non-public deployment (`ask-landing-answer-link.ts` refuses a private
   *  hostname), which is exactly when the typed path is the one that works. */
  answerLink?: (ask_id: string, via?: string) => string;
}

export interface CreateRemoteCredentialResolverDeps {
  connectionStore: ConnectionStoreSqlite;
  /** `connection.notification` row key — the transport's vendor
   *  (D-163 I-4: row name IS the vendor). */
  vendor: string;
  /** Vendor-specific recipient validator. */
  resolveRecipient: RemoteChannelRecipientResolver;
  /** Optional sub-DEK source — re-read per call, see
   *  `ComposeRemoteChannelDeps.keys`. */
  keys?: KeyManager;
  /** D-238 § 2a — renew an expiring credential before it is used.
   *
   *  Absent ⇒ the credential is passed through untouched, which is exactly
   *  right for every vendor declared today: all of them are `auth: 'bot_token'`,
   *  a static bearer with nothing to renew. It becomes load-bearing for the
   *  first `auth: 'oauth'` transport, whose Graph token dies in about an hour.
   *
   *  ⚠ This runs on the SEND path, so it must not be able to fail the send:
   *  `refreshIfNeeded` never throws and never returns null by contract, and a
   *  failed renewal returns the stale credential so the provider issues an
   *  honest 401 rather than this resolver returning null — which the fan-out
   *  would swallow as a silent drop. */
  refreshAuth?: MessengerNotificationRefresher;
}

/** The credential resolver `composeRemoteChannel` builds its channel
 *  over, exported standalone so the messenger turn wiring
 *  (`wire-messenger-turn.ts`) resolves the SAME `connection.
 *  notification.<vendor>` row through the SAME decode path — one
 *  credential read per vendor, two consumers. */
export const createRemoteCredentialResolver = (
  deps: CreateRemoteCredentialResolverDeps,
): (() => Promise<RemoteChannelCredential | null>) => {
  const { connectionStore, vendor, resolveRecipient, refreshAuth } = deps;

  return async (): Promise<RemoteChannelCredential | null> => {
    const row = connectionStore.get('notification', vendor);
    if (row === null) return null;

    // Re-read state per call — see ComposeRemoteChannelDeps.keys doc.
    const keyProvider = deps.keys && deps.keys.state() !== 'uninitialized'
      ? deps.keys.keyProvider('connection')
      : undefined;

    const auth = await decodeAuthFromStorage(
      row.auth_ciphertext,
      { kind: row.kind, name: row.name },
      keyProvider,
    );
    // D-192 CORE #6 make-live — through the shared send-credential seam, not a
    // hand-rolled `auth.type !== 'bearer'`. This is THE credential read behind
    // every generic outbound path (notify / ask / close-ask / turn / live-
    // control), so the hand-rolled check silently dropped every message for any
    // auth shape it didn't recognise — which is how `oauth` stayed a declared,
    // probe-supported auth kind that could never actually deliver. The enroll
    // gate now refuses such a row, and this reads the same authority
    // (`MESSENGER_AUTH_KIND_CONNECTION_TYPES`), so the two cannot drift.
    // D-238 § 2a — renew BEFORE reading the send token, because the read below
    // is a pure narrowing over whatever shape it is handed: an expired
    // `current_access_token` resolves just as happily as a live one, so
    // refreshing afterwards would send the stale value. No-op for every
    // `bot_token` vendor (a static bearer never needs renewing) and for a
    // resolver wired without `refreshAuth`.
    const usable = refreshAuth === undefined
      ? auth
      : await refreshAuth.refreshIfNeeded(vendor, auth);

    const token = resolveMessengerSendToken(usable);
    if (token === undefined) return null;

    let config: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(row.config_json);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed config_json is a re-enrolment ask — fall through to
      // `resolveRecipient(null)` which returns null uniformly.
    }
    const recipient = resolveRecipient(config);
    if (recipient === null) return null;

    // D-238 — the enrolled principal, if this connection bound one. The channel
    // refuses a typed answer from anyone else, and refuses one entirely when
    // this is absent.
    const principal = config?.[MESSENGER_PRINCIPAL_CONFIG_KEY];
    const expected_sender = typeof principal === 'string' && principal.trim().length > 0
      ? principal.trim()
      : undefined;

    return {
      token,
      recipient,
      ...(expected_sender !== undefined ? { expected_sender } : {}),
    };
  };
};

/** Build a `RemoteChannel` ready to slot into `composeNotificationBlock`'s
 *  per-vendor dep. The returned channel's `name` matches `transport.vendor`.
 *
 *  D-238 — its `capability` is now READ FROM THE VENDOR DECLARATION rather than
 *  fixed to `'inline'`. That is what lets a transport with no `sendPrompt`
 *  (Teams) be a channel at all, and `createRemoteChannel` throws at construction
 *  if a declaration claims `inline` while its transport cannot render a prompt —
 *  the alternative being a channel that notifies fine and fails on the first
 *  ask, on a fan-out that catches. */
export const composeRemoteChannel = (
  deps: ComposeRemoteChannelDeps,
): RemoteChannel => {
  const resolveCredential = createRemoteCredentialResolver({
    connectionStore: deps.connectionStore,
    vendor: deps.transport.vendor,
    resolveRecipient: deps.resolveRecipient,
    ...(deps.keys ? { keys: deps.keys } : {}),
  });

  // A vendor with no declaration is not reachable here (the notification block
  // builds channels from the registry), but default rather than assert: the
  // construction check inside `createRemoteChannel` is the one that must fire.
  const capability = getMessengerVendorDeclaration(deps.transport.vendor)?.capability;

  return createRemoteChannel({
    transport: deps.transport,
    resolveCredential,
    ...(capability !== undefined ? { capability } : {}),
    // D-238 — a `landing-page` channel composes its OWN answer affordance;
    // `withAnswerLink` skips it precisely so the URL is not appended twice.
    // Absent on a non-public deployment, where the ask carries the typed-reply
    // hint alone.
    ...(deps.answerLink !== undefined ? { answerLink: deps.answerLink } : {}),
  });
};
