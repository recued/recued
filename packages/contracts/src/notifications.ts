/** D-163 Slice C — notifications rpc payload contracts.
 *
 *  The `@recued/notification` block owns the runtime types (Channel /
 *  NotificationSettings / ChannelToggleView / SetChannelResult / etc.).
 *  Contracts cannot import from `@recued/notification` (it would invert
 *  the canonical dependency direction — every other package imports
 *  from contracts, never the other way), so the rpc payload shapes are
 *  re-declared here as a thin structural twin.
 *
 *  A ratchet test in `__tests__/d-163-notifications-rpc.test.ts`
 *  imports both surfaces and asserts the structural equivalence so a
 *  drift on the notification block's side surfaces at the contracts
 *  test boundary, not later at a webclient call site.
 *
 *  Spec: D-163 § N.5 / N.6 / A.5. */

import type { ChannelRoles } from './channel-roles.js';
import {
  MESSENGER_VENDOR_DECLARATIONS,
  MESSENGER_VENDOR_SLUGS,
} from './messenger-vendors.js';

// ── Channel + capability vocabularies ──────────────────────────────────

/** D-158 + D-163 — the closed channel list, and (D-192 seam 10) the ONE place
 *  it is spelled. `@recued/notification`'s `CHANNEL_NAMES` / `ChannelName` are
 *  now derived from this rather than re-declared beside it, so the twin cannot
 *  drift by construction (which is what the ratchet test above existed to catch).
 *
 *  Three structural channels — `ui` (always-on), `bridge` (a first-class
 *  `notify-only` adapter since D-163 N.4), `email` (a façade over a warehouse
 *  mail instance) — plus every declared CHAT TRANSPORT, spliced in from
 *  `MESSENGER_VENDOR_SLUGS`. Order matters only cosmetically; membership is what
 *  the seam-10 guard (`createRemoteChannel`) enforces. */
export const NOTIFICATION_CHANNEL_NAMES = [
  'ui',
  'bridge',
  ...MESSENGER_VENDOR_SLUGS,
  'email',
] as const;
export type NotificationChannelName = (typeof NOTIFICATION_CHANNEL_NAMES)[number];

/** D-158 N.4 / N.5 — the user-togglable subset. `ui` is structurally
 *  always-on; every other channel is opt-in. Splicing a const TUPLE above (not a
 *  runtime `string[]`) is what keeps this `Exclude` meaningful — it makes "you
 *  cannot toggle `ui`" a compile error rather than a runtime check. */
export type NotificationRemoteChannelName = Exclude<
  NotificationChannelName,
  'ui'
>;

/** The `notification.send` DELIVERY vocabulary — every declared chat transport
 *  plus `email` and `in_app`.
 *
 *  ⚠ Deliberately distinct from `NotificationChannelName` above: this list has
 *  no `ui` / `bridge` (you cannot aim `notification.send` at them) and spells the
 *  in-app destination `in_app` where the CONNECTION subtype spells it `in-app`
 *  (`NotificationSubtype`). Three near-identical vocabularies is genuinely what
 *  the wire has; seam 10 de-hardcodes the VENDOR half of each without unifying
 *  the spellings, since changing either is a breaking wire change. */
export const NOTIFICATION_DELIVERY_CHANNELS = [
  ...MESSENGER_VENDOR_SLUGS,
  'email',
  'in_app',
] as const;
export type NotificationDeliveryChannel = (typeof NOTIFICATION_DELIVERY_CHANNELS)[number];

/** The CREDENTIAL-BACKED remote channels — every chat transport plus `email`.
 *  These are exactly the channels that (a) carry the two-axis
 *  `{ notification, approval }` mode and (b) gate readiness on a
 *  `connection.notification.<channel>` row. `ui` is structurally always-on and
 *  `bridge` is a single boolean backed by pair-presence, so neither belongs here.
 *
 *  D-192 seam 10 — this is what keys the settings record, so a declared chat
 *  transport gets its Settings toggles with no edit. */
export const NOTIFICATION_CREDENTIAL_CHANNELS = [
  ...MESSENGER_VENDOR_SLUGS,
  'email',
] as const;
export type NotificationCredentialChannel =
  (typeof NOTIFICATION_CREDENTIAL_CHANNELS)[number];

/** What every channel is FOR — the three axes, DECLARED rather than branched.
 *
 *  This replaces the hand-spelled arms that used to live inside the shared gates —
 *  `channelApprovalEnabled` literally read `if (channel === 'bridge') return false`,
 *  a per-channel capability fact hardcoded in shared logic, which is the exact seam
 *  this whole arc exists to remove. Now the gate reads the declaration.
 *
 *  Chat transports are DERIVED from the messenger registry, so a new one arrives with
 *  its roles already stated in the one place it is declared. `ui` / `bridge` / `email`
 *  are literal because they are not transports and never will be. */
export const CHANNEL_ROLES: Record<NotificationChannelName, ChannelRoles> = {
  // The floor. Always-on for notify + approval (an ask must ALWAYS be resolvable
  // somewhere — that invariant is what makes every other channel best-effort), and a
  // messenger because the webclient carries the D-137 AI chat.
  ui: { notification: true, approval: true, messenger: true },
  // Notify-only (D-163 N.1) — structurally unable to carry an ask through the channel
  // fan-out, and not a place you hold a conversation. (Its per-bridge approval cards
  // ride the separate D-169 roster path, not this one.)
  bridge: { notification: true, approval: false, messenger: false },
  // A façade over a warehouse mail instance. It notifies, and its ask goes to a
  // landing page (`capability: 'landing-page'`) — but you do not chat with Recued by
  // email.
  email: { notification: true, approval: true, messenger: false },
  // Every declared chat transport states its own roles. NOTE `discord` and `email`
  // land on the SAME triple by completely different routes, which is the clearest
  // proof that roles and capability are orthogonal.
  ...(Object.fromEntries(
    MESSENGER_VENDOR_DECLARATIONS.map((d) => [d.vendor, d.roles]),
  ) as Record<(typeof MESSENGER_VENDOR_SLUGS)[number], ChannelRoles>),
};

/** A channel with no roles at all would be enrollable, settable, and completely
 *  inert — the silent-until-runtime shape this arc keeps meeting. Fail at load. */
const _rolelessChannels = NOTIFICATION_CHANNEL_NAMES.filter((c) => {
  const r = CHANNEL_ROLES[c];
  return !r.notification && !r.approval && !r.messenger;
});
if (_rolelessChannels.length > 0) {
  throw new Error(
    `CHANNEL_ROLES boot validation failed — channel(s) declaring no role at all: ${
      _rolelessChannels.join(', ')
    }. A channel that can neither notify, approve, nor converse cannot do anything.`,
  );
}

/** D-163 N.1 — three capability classes. */
export type NotificationChannelCapability =
  | 'inline'
  | 'landing-page'
  | 'notify-only';

// ── Settings record + toggle view ──────────────────────────────────────

/** D-158 A.6 + D-163 N.6 / A.5 + R31 — one row in the Settings →
 *  Approval & notifications render model. R31 lifts the single `enabled`
 *  flag to TWO independent axes (Notify / Approvals) — the same split
 *  the per-bridge sub-rows already carry — with the approval axis
 *  capability-constrained. */
export interface NotificationChannelToggleView {
  channel: NotificationChannelName;
  /** D-163 N.6 — capability badge text. Reads as delivery language in
   *  the R31 UI: `inline` = "Answer here", `landing-page` = "Answer via
   *  link", `notify-only` = "Notify only". */
  capability: NotificationChannelCapability;
  /** R31 — current NOTIFICATION-axis state (fan a `notify` here?). `ui`
   *  always `true`. For `bridge` this is the channel-level group enable.
   *  Field name matches the `{ notification, approval }` patch + the
   *  per-bridge sub-row axes so the whole panel speaks one vocabulary. */
  notification: boolean;
  /** R31 — current APPROVAL-axis state (fan an `ask` here to answer?).
   *  `ui` always `true` (the approval floor); notify-only channels
   *  (`bridge`) always `false` (no inbound-reply path). */
  approval: boolean;
  /** R31 — whether the NOTIFICATION axis is user-togglable. `false` for
   *  `ui` (fixed-on). `true` for every other channel. */
  notification_togglable: boolean;
  /** R31 — whether the APPROVAL axis is user-togglable. `false` for `ui`
   *  (fixed-on floor) AND for notify-only channels (structurally cannot
   *  carry an ask — D-163 I-1); `true` for `inline` / `landing-page`. */
  approval_togglable: boolean;
  /** D-163 N.5 / N.6 — backing readiness. `true` for `ui` always; for
   *  togglable channels, `false` → enabling is refused with `not_ready`
   *  and the surface should route to the install / connect CTA. */
  ready: boolean;
  /** D-163 N.6 — channel-specific install / connect CTA URL. Populated
   *  on the Bridge row only (today); other channels surface their CTA
   *  via the Settings → Connections route. Omitted when undefined. */
  install_url?: string;
}

/** D-158 N.5 + R31 — the per-pair notification-settings record. R31
 *  lifts the credential-backed remotes (slack / telegram / email) from a
 *  single `enabled` boolean to the two-axis `{notification, approval}`
 *  mode record — the same shape the per-bridge sub-rows already use. The
 *  channel-level `bridge` stays a plain boolean (notify-only; it gates
 *  whether any bridge fan-out happens — engineering call, R31 slice 2). */
export type NotificationSettingsRow = NotificationSettingsRowBase &
  /** D-192 seam 10 — one two-axis mode per credential-backed channel (every chat
   *  transport + email), keyed off the registry rather than hand-spelled, so a
   *  declared vendor gets its Settings row for free. */
  Record<NotificationCredentialChannel, NotificationChannelModeRow>;

interface NotificationSettingsRowBase {
  /** Always-on (N.4) — the literal `true` makes the invariant a type. */
  ui: true;
  /** D-163 N.4 — Bridge as a first-class togglable channel. Notify-only,
   *  so a single boolean (the channel-level group enable). */
  bridge: boolean;
  /** D-158 P2b-ii — anti-phishing phrase rendered on the ask landing
   *  page. Optional; the Settings UI clears it by passing `null` /
   *  empty / whitespace-only. */
  verification_phrase?: string;
  /** D-169 P1 — per-paired-bridge mode toggles keyed on
   *  `client_tokens.token_id`. Always present on the in-memory
   *  projection (an empty record when no bridges configured); the rpc
   *  wire shape preserves the optional `?` so legacy stored rows
   *  decode. */
  bridges?: Record<string, NotificationBridgeModeRow>;
}

/** One credential channel's THREE-axis mode flags. All default `false`.
 *
 *  D-192 — the third axis. `notification` and `approval` have been here since R31;
 *  `messenger` was the missing one, and its absence was why a channel that cannot
 *  carry a conversation (Discord) and a channel that cannot be reached unprompted
 *  (WhatsApp) both had to be described in prose instead of declared.
 *
 *  The three are genuinely INDEPENDENT — several useful combinations are occupied:
 *    - `bridge`   — notify only
 *    - `email`    — notify + approve (via a landing page), never a conversation
 *    - `discord`  — all three in local Gateway mode; webhook mode is approvals-only
 *    - `whatsapp` — conversation only (Meta's 24h window blocks the unprompted half)
 *    - `slack` / `telegram` / `ui` — all three
 *
 *  What a channel SUPPORTS is declared (`CHANNEL_ROLES`); what the owner has TURNED
 *  ON is this row. The gates read both, so an unsupported role can never be enabled
 *  by a stale or hand-edited settings row. */
export interface NotificationChannelModeRow {
  notification: boolean;
  approval: boolean;
  messenger: boolean;
}

/** One bridge's mode flags — TWO axes.
 *
 *  ⚠ Deliberately NOT an alias of `NotificationChannelModeRow` any more. A browser
 *  bridge renders notifications and approval cards; it is not somewhere you hold a
 *  conversation. While the two were aliased, adding the third axis would have given
 *  every paired bridge a meaningless `messenger` toggle — the alias was only ever
 *  true by coincidence, and the coincidence just ended. */
export interface NotificationBridgeModeRow {
  notification: boolean;
  approval: boolean;
}

/** What a channel is FOR — the three axes, declared per channel.
 *
 *  Not the same question as `NotificationChannelCapability`, and the distinction is
 *  load-bearing:
 *    - **capability** answers HOW an ask renders here (inline buttons / a link / it
 *      cannot). It is a rendering fact.
 *    - **roles** answer WHETHER Recued should use this channel for a thing at all.
 *
 *  They are orthogonal, and both are needed: `discord` and `email` have IDENTICAL
 *  roles (notify + approve, no chat) and completely different capabilities (`inline`
 *  vs `landing-page`). And WhatsApp is `inline`-capable yet `approval: false` — it
 *  can render an approval perfectly; it just cannot reliably be REACHED with one.
 *
 *  ⚠ One consistency rule ties them together, enforced by a boot check in
 *  `@recued/notification`: a `notify-only` channel MUST declare `approval: false`.
 *  You cannot approve where you cannot render. */
export {
  CHANNEL_ROLE_AXES,
  type ChannelRoleAxis,
  type ChannelRoles,
} from './channel-roles.js';

/** D-169 P1 — one paired bridge's render row for the per-bridge sub-row
 *  group under the channel-level Browser Bridge toggle. */
export interface NotificationBridgeRow {
  /** Durable `client_tokens.token_id`. */
  client_token_id: string;
  /** Display label (rename target — writes through to
   *  `client_tokens.client_label`). */
  label: string;
  /** Current mode flags; both default `false` on a fresh pair. */
  modes: NotificationBridgeModeRow;
  /** Unix seconds — first paired-at. Optional for legacy rows. */
  added_at?: number;
  /** Whether the bridge currently holds an active WS. */
  connected: boolean;
}

/** D-169 P1 — outcome of `notifications.set_bridge_mode`. */
export type NotificationSetBridgeModeResult =
  | { ok: true; settings: NotificationSettingsRow }
  | { ok: false; reason: 'bridge_unknown'; bridge_id: string };

// ── Set-channel result (discriminated union) ───────────────────────────

/** D-158 A.6 + D-163 N.5 + R31 — outcome of `notifications.set_channel`
 *  (an axis-patch since R31: `{ channel, patch: { notification?,
 *  approval? } }`). A typed result, not an error throw — every `ok:
 *  false` branch is an expected user-flow the Settings surface renders
 *  inline. `approval_unsupported` = an approval-axis patch on a
 *  notify-only channel (`bridge`), which structurally has no reply path. */
export type NotificationSetChannelResult =
  | { ok: true; settings: NotificationSettingsRow }
  | { ok: false; reason: 'ui_fixed' }
  | { ok: false; reason: 'not_ready'; channel: NotificationRemoteChannelName }
  | {
      ok: false;
      reason: 'approval_unsupported';
      channel: NotificationRemoteChannelName;
    };

// ── Set-verification-phrase result (discriminated union) ───────────────

/** Max length of the anti-phishing verification phrase. Mirrors
 *  `NOTIFICATION_VERIFICATION_PHRASE_MAX` from `@recued/notification`;
 *  duplicated here so callers can validate before the rpc hop. */
export const NOTIFICATION_VERIFICATION_PHRASE_MAX_LENGTH = 80;

/** D-158 P2b-ii — outcome of `notifications.set_verification_phrase`.
 *  Mirrors the block's `SetVerificationPhraseResult`. */
export type NotificationSetVerificationPhraseResult =
  | { ok: true; settings: NotificationSettingsRow }
  | { ok: false; reason: 'too_long'; max: number };
