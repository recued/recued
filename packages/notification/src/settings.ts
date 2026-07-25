/** D-158 P1 / D-163 P0 — the block-owned per-pair notification-settings
 *  record + the Settings → Notifications surface (D-158 N.5 / A.6 / I-7
 *  + D-163 N.5 / N.6).
 *
 *  The block owns its settings (D-158 I-7): a dedicated per-pair store —
 *  not `prefs` (recipe-wire plumbing), not `connection.notification`
 *  (credentials, not on/off policy). A settings surface living in the
 *  gateway or the engine is the god-object failure the D-153 re-
 *  architecture exists to avoid — so the record, the store, and the
 *  Settings surface all live here, in the leaf.
 *
 *  Two things ship here:
 *   - `NotificationSettingsStore` — durable persistence of the single
 *     per-pair `NotificationSettings` record, on the same `Collection`
 *     primitive `ask-store.ts` uses (in-memory in tests, SQLite on the
 *     server).
 *   - `createNotificationSettings` — the Settings → Notifications
 *     surface: `get` (the record `ask` / `notify` read for fan-out),
 *     `describe` (the render model the webclient page draws), and
 *     `setChannel` (a readiness-gated per-channel toggle).
 *
 *  The readiness gate (D-163 N.5): enabling a togglable channel requires
 *  its backing to be present. The block is a leaf and cannot reach
 *  either the connection store (Slack / Telegram / Email credentials) OR
 *  the pair store (Bridge presence), so the existence check is an
 *  injected `ChannelReadinessProbe` seam — the same injected-narrow-
 *  seam pattern the `ui` channel's `UiBusSink` uses. `backend/server`
 *  supplies the real probe at wire time; absent it, no togglable channel
 *  can be enabled (the un-server-wired default — fail closed).
 *
 *  D-163 N.6 widens the render model with `capability` (the badge the
 *  Settings UI renders alongside each row) and `install_url?` (the
 *  Bridge "Install Browser Bridge" CTA target).
 *
 *  Spec: D-158 § N.5 / A.6 / I-7 / O-4 + D-163
 *        § N.5 / N.6 / A.5.
 */

import type { Collection } from '@recued/storage';
import {
  CHANNEL_ROLES,
  MESSENGER_VENDOR_SLUGS,
  NOTIFICATION_CREDENTIAL_CHANNELS,
  type NotificationCredentialChannel,
} from '@recued/contracts';

import type { ChannelCapability } from './channels/channel.js';
import type {
  BridgeModeSettings,
  ChannelModeSettings,
  ChannelName,
  NotificationSettings,
  RemoteChannelName,
} from './types.js';

/** The single fixed key the one per-pair settings record is stored
 *  under in the backing `Collection`. The collection holds exactly one
 *  row — `NotificationSettings` is one record per pair, not a table. */
export const NOTIFICATION_SETTINGS_KEY = 'notification_settings';

/** The default record — `ui` on (always), every togglable channel off
 *  (opt-in, N.5), no verification phrase set. Returned by `get` until
 *  the user changes something.
 *
 *  D-169 P1 widening: an always-present (empty) `bridges` map so the
 *  read-side never sees `undefined` even on stored rows that pre-date
 *  the field. */
/** D-192 seam 10 — both axes default `false` for EVERY credential-backed channel
 *  (each declared chat transport + email), built off the registry so a new
 *  transport defaults correctly (opt-in, TR-8) with no edit here. */
const defaultChannelModes = (): Record<NotificationCredentialChannel, ChannelModeSettings> => {
  const modes = {} as Record<NotificationCredentialChannel, ChannelModeSettings>;
  for (const channel of NOTIFICATION_CREDENTIAL_CHANNELS) {
    modes[channel] = { notification: false, approval: false, messenger: false };
  }
  return modes;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  ui: true,
  bridge: false,
  ...defaultChannelModes(),
  bridges: {},
};

/** Deep-clone every credential channel's two-axis record, falling back to the
 *  default for any the caller has no stored value for.
 *
 *  D-192 WhatsApp make-live — this used to be three hand-spelled lines
 *  (`slack:`, `telegram:`, `email:`) sitting directly beneath a comment
 *  explaining why the clone is load-bearing. `DEFAULT_NOTIFICATION_SETTINGS`
 *  itself was already registry-driven, so a newly declared vendor's record
 *  arrived through the `...DEFAULT` spread — BY REFERENCE, never cloned, because
 *  the hand-spelled list did not know about it. A single caller mutating
 *  `settings.whatsapp.notification` would then have poisoned the shared DEFAULT
 *  constant for the whole process: precisely the failure the clone exists to
 *  prevent, silently reintroduced for every vendor after the third. The type was
 *  registry-driven; the runtime was not. It is now. */
const cloneChannelModes = (
  stored: Partial<Record<NotificationCredentialChannel, ChannelModeSettings>>,
): Record<NotificationCredentialChannel, ChannelModeSettings> => {
  const modes = {} as Record<NotificationCredentialChannel, ChannelModeSettings>;
  for (const channel of NOTIFICATION_CREDENTIAL_CHANNELS) {
    modes[channel] = cloneMode(stored[channel] ?? DEFAULT_NOTIFICATION_SETTINGS[channel]);
  }
  return modes;
};

/** THE THREE AXES — eligibility = "does the channel SUPPORT it" AND "has the owner
 *  TURNED IT ON".
 *
 *  D-192 — the support half is now DECLARED (`CHANNEL_ROLES`) rather than branched.
 *  `channelApprovalEnabled` used to read `if (channel === 'bridge') return false` —
 *  a per-channel capability fact hardcoded inside shared logic, which is precisely
 *  the seam this arc exists to remove. Now a channel that cannot do a thing says so
 *  in one place, and every gate reads it.
 *
 *  Checking support FIRST is what makes this fail-closed: a stale, hand-edited, or
 *  future-schema settings row cannot enable a role the channel does not have. The
 *  owner's toggle can only ever turn something OFF that the channel could do. */

/** Notify-axis eligibility. `ui` is structurally always-on; `bridge` reads its own
 *  channel-level boolean (its per-bridge modes ride the separate D-169 roster path);
 *  every credential channel reads the `notification` axis of its mode row. */
export const channelNotifyEnabled = (
  settings: NotificationSettings,
  channel: ChannelName,
): boolean => {
  if (!CHANNEL_ROLES[channel].notification) return false;
  if (channel === 'ui') return true;
  if (channel === 'bridge') return settings.bridge;
  return settings[channel].notification;
};

/** Approval-axis eligibility. `ui` is always on — the approval FLOOR, and the reason
 *  every other channel can be best-effort: an ask is ALWAYS resolvable in the
 *  webclient. `bridge` now falls out to `false` from its declared role rather than a
 *  hardcoded arm; WhatsApp does too, for an entirely different reason (Meta's 24-hour
 *  window makes an unprompted ask unreachable), and neither needed a branch here. */
export const channelApprovalEnabled = (
  settings: NotificationSettings,
  channel: ChannelName,
): boolean => {
  if (!CHANNEL_ROLES[channel].approval) return false;
  if (channel === 'ui') return true;
  if (channel === 'bridge') return false;
  return settings[channel].approval;
};

/** Messenger-axis eligibility — D-192's third axis: can you TALK to Recued here.
 *
 *  Discord declares `messenger: false` (its Interactions webhook carries button
 *  presses, never plain messages), so the turn and the commitment funnel skip it
 *  EXPLICITLY rather than relying on `parseInbound` happening to return null. Same
 *  outcome, but stated where a human and the Settings UI can both read it. */
export const channelMessengerEnabled = (
  settings: NotificationSettings,
  channel: ChannelName,
): boolean => {
  if (!CHANNEL_ROLES[channel].messenger) return false;
  // The webclient IS the chat surface (D-137) — not a togglable destination.
  if (channel === 'ui') return true;
  if (channel === 'bridge') return false;
  return settings[channel].messenger;
};

/** D-169 P1 — default per-bridge mode record. Both modes default
 *  `false` on a freshly paired bridge (N.6 + TR-8). */
export const DEFAULT_BRIDGE_MODE_SETTINGS: BridgeModeSettings = {
  notification: false,
  approval: false,
};

/** R31 — shallow clone of a two-axis mode record (defensive copy so a
 *  returned settings object never shares a sub-object ref with the
 *  store's cached state or the shared DEFAULT constant). The `=== true`
 *  coercions also guarantee VALID booleans out of the read boundary — a
 *  malformed / partial stored value (e.g. a field left `undefined`)
 *  reads as `false` rather than propagating `undefined` into the record
 *  (and thence into a persisted patch). Valid records are unchanged. */
const cloneMode = (m: ChannelModeSettings): ChannelModeSettings => ({
  notification: m.notification === true,
  approval: m.approval === true,
  // D-192's third axis. The `=== true` coercion matters most HERE: every stored row
  // written before this field existed has it `undefined`, and reading `undefined` as
  // `false` is the correct — and safe — interpretation of "never turned on".
  messenger: m.messenger === true,
});

/** Max length of the anti-phishing `verification_phrase` (D-158
 *  P2b-ii) — a recognizable phrase, not an essay. The surface refuses an
 *  over-length value (`too_long`) so the Settings input can cap it. */
export const NOTIFICATION_VERIFICATION_PHRASE_MAX = 80;

/** Render order for the Settings → Notifications channel list — `ui`
 *  first (the always-on row), then `bridge` (D-163 N.4 — promoted to a
 *  first-class adapter; sits next to `ui` because both render through
 *  the host device), then the credential-backed chat transports, then
 *  `email`. A fixed order keeps the surface stable across renders.
 *
 *  ⚠ DERIVED from `CHANNEL_ROLES`, not hand-spelled. This panel toggles the
 *  notification + approval axes ONLY, so a chat transport belongs here IFF it can
 *  be toggled on at least one of them (`roles.notification || roles.approval`).
 *  Discord (notify + approve, no free-text converse) therefore appears; WhatsApp
 *  (converse ONLY — Meta's 24h window forbids unprompted notify/approve, so both
 *  axes are declared `false`) is correctly absent and is configured under
 *  Connections instead. Hand-spelling this list is exactly what silently dropped
 *  Discord — it enrolled, probed green, and reported ready, yet no row was ever
 *  drawn so its axes could never be enabled. A new transport that declares a
 *  notify/approve role now appears here with no edit. */
const CHANNEL_ORDER: readonly ChannelName[] = [
  'ui',
  'bridge',
  ...MESSENGER_VENDOR_SLUGS.filter(
    (v) => CHANNEL_ROLES[v].notification || CHANNEL_ROLES[v].approval,
  ),
  'email',
];

/** D-163 N.5 — probes whether the backing for a togglable channel is
 *  present (a `connection.notification` credential for Slack / Telegram
 *  / Email; a paired Bridge in the pair store for Bridge). Renamed from
 *  D-158's `CredentialProbe` to reflect the unified seam. Injected: the
 *  block is a leaf and cannot reach either backing store. */
export type ChannelReadinessProbe = (
  channel: RemoteChannelName,
) => boolean | Promise<boolean>;

/** One channel's row in the Settings → Notifications render model
 *  (D-158 A.6 + D-163 N.6 / A.5). The webclient page draws one toggle
 *  per `ChannelToggleView`. */
export interface ChannelToggleView {
  channel: ChannelName;
  /** D-163 N.6 — the capability class (`'inline'` / `'landing-page'` /
   *  `'notify-only'`); the Settings UI renders a delivery badge per row
   *  from this value + uses it to constrain the approval axis. */
  capability: ChannelCapability;
  /** R31 — current NOTIFICATION-axis state. `ui` always `true`; `bridge`
   *  is the channel-level group enable. Field name matches the
   *  `{ notification, approval }` patch + the per-bridge sub-row axes. */
  notification: boolean;
  /** R31 — current APPROVAL-axis state. `ui` always `true` (the floor);
   *  notify-only channels (`bridge`) always `false`. */
  approval: boolean;
  /** R31 — whether the NOTIFICATION axis is user-togglable. `false` for
   *  `ui` (fixed-on). `true` for every other channel. */
  notification_togglable: boolean;
  /** R31 — whether the APPROVAL axis is user-togglable. `false` for `ui`
   *  (fixed-on floor) AND for notify-only channels (structurally cannot
   *  carry an ask); `true` for `inline` / `landing-page`. */
  approval_togglable: boolean;
  /** D-163 N.5 / N.6 — whether the channel's readiness backing is
   *  present. Always `true` for `ui`. For a togglable channel: `false`
   *  → toggling on is refused (`not_ready`) and the surface routes the
   *  user to the channel's install / connect CTA (`install_url`). */
  ready: boolean;
  /** D-163 N.6 — channel-specific install / connect CTA URL the
   *  Settings UI surfaces when `ready === false`. Bridge: the Browser
   *  Bridge install guide / Chrome Web Store entry. The other togglable
   *  channels route through Settings → Connections, which the webclient
   *  surfaces from a fixed route — those rows leave this field `undefined`. */
  install_url?: string;
}

/** D-169 P1 — one paired bridge's render row for Settings →
 *  Notifications. The Settings UI renders one row per paired bridge
 *  under the `bridge` channel section (which itself remains the
 *  channel-level toggle). Per N.6 the user can rename the row inline;
 *  the rename writes through to `client_tokens.client_label` (existing
 *  rpc — D-156 webclient devices list already calls it). */
export interface BridgeRowView {
  /** Durable `client_tokens.token_id` — the stable identity used to key
   *  the `bridges` map. The Settings UI passes this back on every
   *  `setBridgeMode` / rename call. */
  client_token_id: string;
  /** Display label assembled at pair time as
   *  `Bridge${N} ${user_agent_class}` (e.g. `Bridge1 Chrome on macOS`)
   *  per N.6, or the user-supplied rename. Falls back to the raw
   *  `client_token_id` when no label has ever been persisted. */
  label: string;
  /** Current mode flags. Defaults to both `false` when no per-bridge
   *  record exists yet for this id. */
  modes: BridgeModeSettings;
  /** Unix-seconds the bridge was first paired (joined from
   *  `paired_instances`). Optional — pre-D-156 rows may not carry it. */
  added_at?: number;
  /** Whether the bridge currently holds an active WS — joined from the
   *  live ws roster (mirrors `pair.list`'s `connected` field). */
  connected: boolean;
}

/** The outcome of a `setChannel` toggle (D-158 A.6 + D-163 N.5). A
 *  typed result, not a throw — `ui_fixed` and `not_ready` are expected
 *  user-flow branches the surface renders, not exceptions. */
export type SetChannelResult =
  /** Patch applied; `settings` is the new record. */
  | { ok: true; settings: NotificationSettings }
  /** `ui` cannot be toggled (D-158 N.4) — it is fixed-on. The surface
   *  marks the `ui` axes non-interactive, so reaching here at all is a
   *  defense-in-depth backstop. */
  | { ok: false; reason: 'ui_fixed' }
  /** D-163 N.5 — enabling an axis on a togglable channel with no backing
   *  (no `connection.notification` credential for Slack / Telegram /
   *  Email; no paired Bridge for Bridge). The surface routes the user to
   *  the channel's install / connect CTA. Disabling is never readiness-
   *  gated, so this is only ever returned for an enable. */
  | { ok: false; reason: 'not_ready'; channel: RemoteChannelName }
  /** R31 — an approval-axis patch on a notify-only channel (`bridge`),
   *  which structurally cannot carry an ask (D-163 I-1). The surface
   *  disables the approval cell for such channels, so this is a
   *  defense-in-depth backstop. */
  | { ok: false; reason: 'approval_unsupported'; channel: RemoteChannelName };

/** D-169 P1 — the outcome of `setBridgeMode`. A typed result, not a
 *  throw — `bridge_unknown` is an expected user-flow branch (the user
 *  tried to toggle a row whose bridge was just unpaired in another
 *  tab); the surface refreshes its row list on receipt. */
export type SetBridgeModeResult =
  | { ok: true; settings: NotificationSettings }
  | { ok: false; reason: 'bridge_unknown'; bridge_id: string };

/** The outcome of a `setVerificationPhrase` toggle (D-158 P2b-ii). A
 *  typed result, not a throw — `too_long` is an expected user-input
 *  branch the Settings surface renders inline. */
export type SetVerificationPhraseResult =
  /** Applied; `settings` is the new record (the phrase set, or cleared
   *  when the input was empty / whitespace-only). */
  | { ok: true; settings: NotificationSettings }
  /** The phrase (trimmed) exceeded `NOTIFICATION_VERIFICATION_PHRASE_MAX`
   *  — the surface should cap the input and re-prompt. */
  | { ok: false; reason: 'too_long'; max: number };

// ── The persistence store ──────────────────────────────────────────

/** Durable persistence of the single per-pair `NotificationSettings`
 *  record. The block is the sole writer (D-158 I-7). */
export interface NotificationSettingsStore {
  /** The current record, or `DEFAULT_NOTIFICATION_SETTINGS` when none
   *  is persisted yet. `ui` is forced `true` on every read — the
   *  always-on invariant (D-158 N.4) holds even against a malformed
   *  stored row. */
  get(): Promise<NotificationSettings>;
  /** R31 — patch one channel's two-axis mode; resolves with the new
   *  record. `ui` is excluded by the `RemoteChannelName` parameter type
   *  — the always-on invariant is unbreakable at this layer. `bridge` is
   *  notify-only: only the `notification` field applies (it maps to the
   *  channel-level boolean); an `approval` field is ignored here (the
   *  surface rejects it upstream). For slack / telegram / email the patch
   *  merges into the two-axis record. The read-modify-write runs under a
   *  per-store mutex so two concurrent patches cannot lose an update. */
  setChannelMode(
    channel: RemoteChannelName,
    patch: Partial<ChannelModeSettings>,
  ): Promise<NotificationSettings>;
  /** Set or clear the anti-phishing `verification_phrase` (D-158
   *  P2b-ii); resolves with the new record. A non-empty trimmed string
   *  sets it; `null` / an empty / a whitespace-only string clears it. */
  setVerificationPhrase(
    phrase: string | null,
  ): Promise<NotificationSettings>;
  /** D-169 P1 — set one bridge's mode flags; resolves with the new
   *  record. Caller passes the bridge's durable `client_tokens.token_id`
   *  as the key. Writes merge `patch` into the existing per-bridge
   *  record (or the default if absent), then persists; the read-modify-
   *  write rides the same per-store mutex as the channel toggles so two
   *  rapid clicks cannot lose an update. Removing a bridge entirely is
   *  done via `clearBridgeMode` (paired with an unpair cleanup); the
   *  setter never deletes. */
  setBridgeMode(
    bridge_id: string,
    patch: Partial<BridgeModeSettings>,
  ): Promise<NotificationSettings>;
  /** D-169 P1 — drop one bridge's mode record entirely. Invoked from
   *  the pair-revoke path so a re-pair of the same bridge starts at
   *  default (N.6 — no setting persistence across un-pair / re-pair). */
  clearBridgeMode(bridge_id: string): Promise<NotificationSettings>;
}

/** Build a `NotificationSettingsStore` over a backing `Collection` — an
 *  in-memory collection in tests, a SQLite collection on the server. */
export const createNotificationSettingsStore = (
  backing: Collection<NotificationSettings>,
): NotificationSettingsStore => {
  let tail: Promise<unknown> = Promise.resolve();
  const serialised = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const read = async (): Promise<NotificationSettings> => {
    const stored = await backing.get(NOTIFICATION_SETTINGS_KEY);
    if (stored === null) return cloneDefault();
    // `ui` is structurally always-on — force it regardless of what the
    // row holds, so a malformed / future-schema row can never disable
    // the one channel that cannot be disabled (D-158 N.4). Merge over
    // the default so a stored row missing the D-163 `bridge` field
    // returns `false`, not `undefined`. The `bridges` map is read-
    // through (we don't merge per-bridge defaults here — see
    // `readBridgeMode` for the per-id lookup that falls back to default).
    const merged: NotificationSettings = {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      ...stored,
      ui: true,
      // R31 — fresh-clone the two-axis remote records (like `bridges`)
      // so a caller mutating the returned object can't poison the shared
      // DEFAULT constant or a cached stored ref.
      ...cloneChannelModes(stored),
      bridges: { ...(stored.bridges ?? {}) },
    };
    return merged;
  };

  // D-169 P1 + R31 — Always hand out a fresh clone of the default so
  // callers that mutate the returned object don't poison the shared
  // constant (the two-axis remote records + `bridges` are deep-cloned).
  const cloneDefault = (): NotificationSettings => ({
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...cloneChannelModes({}),
    bridges: {},
  });

  return {
    get: read,

    setChannelMode(channel, patch) {
      return serialised(async () => {
        const current = await read();
        let next: NotificationSettings;
        if (channel === 'bridge') {
          // Bridge is notify-only — only the notification axis applies,
          // and it maps to the channel-level boolean. An approval field
          // is a no-op here (the surface rejects it upstream).
          next = {
            ...current,
            bridge:
              patch.notification === undefined
                ? current.bridge
                : patch.notification,
          };
        } else {
          // ⚠ SPREAD the existing row, then overlay the patch — do NOT rebuild it
          // field by field.
          //
          // It WAS rebuilt field by field, naming `notification` and `approval`
          // explicitly, which meant the writer silently DROPPED any axis it did not
          // know about. The moment `messenger` landed, every `setChannelMode` call
          // erased it. A per-field rebuild of a GROWING record is a bug with a delay
          // fuse: it works perfectly until the record grows, and then it starts
          // deleting data — and nothing fails, because the field just quietly isn't
          // there any more.
          //
          // The overlay drops explicit-`undefined` keys, so a patch that mentions only
          // one axis leaves the others exactly as they were.
          const existing = current[channel];
          const overlay = Object.fromEntries(
            Object.entries(patch).filter(([, v]) => v !== undefined),
          ) as Partial<ChannelModeSettings>;
          next = {
            ...current,
            [channel]: { ...existing, ...overlay },
          };
        }
        await backing.set(NOTIFICATION_SETTINGS_KEY, next);
        return next;
      });
    },

    setVerificationPhrase(phrase) {
      return serialised(async () => {
        const next: NotificationSettings = { ...(await read()) };
        const trimmed = (phrase ?? '').trim();
        if (trimmed.length > 0) {
          next.verification_phrase = trimmed;
        } else {
          delete next.verification_phrase;
        }
        await backing.set(NOTIFICATION_SETTINGS_KEY, next);
        return next;
      });
    },

    setBridgeMode(bridge_id, patch) {
      return serialised(async () => {
        const current = await read();
        const existing = current.bridges?.[bridge_id] ?? DEFAULT_BRIDGE_MODE_SETTINGS;
        const merged: BridgeModeSettings = {
          notification:
            patch.notification === undefined
              ? existing.notification
              : patch.notification,
          approval:
            patch.approval === undefined ? existing.approval : patch.approval,
        };
        const next: NotificationSettings = {
          ...current,
          bridges: { ...(current.bridges ?? {}), [bridge_id]: merged },
        };
        await backing.set(NOTIFICATION_SETTINGS_KEY, next);
        return next;
      });
    },

    clearBridgeMode(bridge_id) {
      return serialised(async () => {
        const current = await read();
        if (current.bridges?.[bridge_id] === undefined) return current;
        const nextBridges = { ...(current.bridges ?? {}) };
        delete nextBridges[bridge_id];
        const next: NotificationSettings = { ...current, bridges: nextBridges };
        await backing.set(NOTIFICATION_SETTINGS_KEY, next);
        return next;
      });
    },
  };
};

// ── The Settings → Notifications surface ───────────────────────────

/** Per-channel capability table the surface reads to populate
 *  `ChannelToggleView.capability`. Lifted out of the channel adapters
 *  so the render model stays computable without instantiating every
 *  adapter. Must stay aligned with each adapter's declared
 *  `Channel.capability`; the D-163 test suite ratchets this. */
const CHANNEL_CAPABILITY_TABLE: Readonly<Record<ChannelName, ChannelCapability>> = {
  ui:     'inline',
  bridge: 'notify-only',
  email:  'landing-page',
  // D-192 seam 10 — every chat transport is `inline`, and that is a FACT of the
  // substrate rather than a per-vendor choice: a messenger vendor's channel is
  // built by `createRemoteChannel`, which declares `capability: 'inline'` because
  // the vendor implements the INTERACTIVE transport (sendPrompt + close). So this
  // derives instead of enumerating, and stays aligned with the adapter by
  // construction — which is exactly what the D-163 ratchet asserts. A future
  // non-interactive transport would need a declared capability facet; none exists,
  // so none is invented here.
  ...Object.fromEntries(MESSENGER_VENDOR_SLUGS.map((vendor) => [vendor, 'inline'])),
} as Readonly<Record<ChannelName, ChannelCapability>>;

/** Per-channel install / connect CTA URL builder. Bridge points at its
 *  install guide; the credential-backed channels return `undefined`
 *  because their Settings UI routes through Settings → Connections (a
 *  fixed webclient route). The CTA URL is purely a UX hint — readiness
 *  gating is enforced by the probe, not by the URL's presence. */
const installUrlFor = (channel: ChannelName): string | undefined => {
  if (channel === 'bridge') return BRIDGE_INSTALL_URL;
  return undefined;
};

/** Bridge install / connect target. Lifted as a const so the URL is
 *  one-line replaceable when the store listing or marketing site
 *  changes. */
export const BRIDGE_INSTALL_URL = 'https://recued.com/install/bridge';

/** D-169 P1 — probe for the set of paired bridges + their identity /
 *  label / connectedness. Injected because the block is a leaf and
 *  cannot reach the pair store / ws roster. Mirrors the
 *  `ChannelReadinessProbe` pattern. Implementations join
 *  `paired_instances` × `client_tokens` (kind = 'bridge') × live ws
 *  roster; an empty probe (no bridges paired) returns `[]`. */
export type BridgeRosterProbe = () => Promise<
  ReadonlyArray<{
    client_token_id: string;
    label: string;
    added_at?: number;
    connected: boolean;
  }>
>;

/** The Settings → Notifications surface — `get` / `describe` /
 *  `setChannel`. */
export interface NotificationSettingsSurface {
  /** The current settings record — what `ask` / `notify` read to
   *  compute the fan-out set. */
  get(): Promise<NotificationSettings>;
  /** The render model for the Settings → Notifications page — one
   *  `ChannelToggleView` per channel, in `CHANNEL_ORDER`. */
  describe(): Promise<readonly ChannelToggleView[]>;
  /** D-169 P1 — the per-bridge render model: one `BridgeRowView` per
   *  paired bridge, in pair-time order (oldest first). The Settings UI
   *  renders these as a sub-row group under the channel-level `bridge`
   *  toggle. Returns `[]` when no bridges are paired OR the
   *  `bridgeRosterProbe` is absent (fail closed — the surface degrades
   *  to "no bridges configured"). */
  describeBridges(): Promise<readonly BridgeRowView[]>;
  /** R31 — patch one channel's two-axis mode. `ui` is refused
   *  (`ui_fixed`); an approval patch on a notify-only channel is refused
   *  (`approval_unsupported`); enabling an axis with no readiness backing
   *  is refused (`not_ready`) so the surface can route to the install /
   *  connect CTA. Disabling is never readiness-gated. */
  setChannelMode(
    channel: ChannelName,
    patch: Partial<ChannelModeSettings>,
  ): Promise<SetChannelResult>;
  /** D-169 P1 — toggle one mode on one bridge. The bridge must exist
   *  in the roster probe's current snapshot; an unknown id surfaces
   *  `bridge_unknown` so the UI re-fetches its row list. The `patch`
   *  shape allows toggling notification OR approval (or both) in one
   *  call; the underlying store merges per-key so an absent field
   *  preserves its prior value. */
  setBridgeMode(
    bridge_id: string,
    patch: Partial<BridgeModeSettings>,
  ): Promise<SetBridgeModeResult>;
  /** Set or clear the anti-phishing `verification_phrase`. */
  setVerificationPhrase(
    phrase: string | null,
  ): Promise<SetVerificationPhraseResult>;
}

/** The probe used when none is injected — every togglable channel
 *  reported not-ready, so none can be enabled until the server wires
 *  the real probe (fail closed). */
const NO_READINESS: ChannelReadinessProbe = () => false;

export interface NotificationSettingsDeps {
  store: NotificationSettingsStore;
  /** Absent → `NO_READINESS` (no togglable channel can be enabled). */
  readinessProbe?: ChannelReadinessProbe;
  /** D-169 P1 — absent → no bridge rows render (the Settings UI shows
   *  the channel-level bridge toggle only). Production wires the probe
   *  in `backend/server`; dbless harnesses leave it absent. */
  bridgeRosterProbe?: BridgeRosterProbe;
}

/** Build the Settings → Notifications surface over a settings store +
 *  the optional readiness probe. */
export const createNotificationSettings = (
  deps: NotificationSettingsDeps,
): NotificationSettingsSurface => {
  const { store } = deps;
  const probe = deps.readinessProbe ?? NO_READINESS;

  return {
    get: () => store.get(),

    async describe() {
      const current = await store.get();
      return Promise.all(
        CHANNEL_ORDER.map(async (channel): Promise<ChannelToggleView> => {
          const capability = CHANNEL_CAPABILITY_TABLE[channel];
          const notifyOnly = capability === 'notify-only';
          // `ui` — always-on FLOOR: both axes on + fixed, always ready.
          if (channel === 'ui') {
            return {
              channel,
              capability,
              notification: true,
              approval: true,
              notification_togglable: false,
              approval_togglable: false,
              ready: true,
            };
          }
          // A togglable channel. `channel` has narrowed to
          // `RemoteChannelName` past the `ui` branch. The approval axis
          // is available only when the capability can carry an ask
          // (inline / landing-page); notify-only (`bridge`) disables it.
          const install_url = installUrlFor(channel);
          return {
            channel,
            capability,
            notification: channelNotifyEnabled(current, channel),
            approval: channelApprovalEnabled(current, channel),
            notification_togglable: true,
            approval_togglable: !notifyOnly,
            ready: await probe(channel),
            ...(install_url !== undefined ? { install_url } : {}),
          };
        }),
      );
    },

    async setChannelMode(channel, patch) {
      if (channel === 'ui') return { ok: false, reason: 'ui_fixed' };
      // `channel` has narrowed to `RemoteChannelName`. Bridge is
      // notify-only — it has no approval axis to set (defense-in-depth;
      // the surface disables the approval cell for it).
      if (channel === 'bridge' && patch.approval !== undefined) {
        return { ok: false, reason: 'approval_unsupported', channel };
      }
      // The readiness gate is on ENABLING only — a patch that turns any
      // axis ON requires the channel's backing; disabling never is
      // (D-158 A.6, widened by D-163 N.5 + R31's two axes).
      const enablingAny =
        patch.notification === true || patch.approval === true;
      if (enablingAny && !(await probe(channel))) {
        return { ok: false, reason: 'not_ready', channel };
      }
      const settings = await store.setChannelMode(channel, patch);
      return { ok: true, settings };
    },

    async describeBridges() {
      const roster = deps.bridgeRosterProbe ? await deps.bridgeRosterProbe() : [];
      if (roster.length === 0) return [];
      const current = await store.get();
      const map = current.bridges ?? {};
      return roster.map((r): BridgeRowView => {
        const stored = map[r.client_token_id] ?? DEFAULT_BRIDGE_MODE_SETTINGS;
        const out: BridgeRowView = {
          client_token_id: r.client_token_id,
          label: r.label,
          modes: { ...stored },
          connected: r.connected,
        };
        if (r.added_at !== undefined) out.added_at = r.added_at;
        return out;
      });
    },

    async setBridgeMode(bridge_id, patch) {
      const roster = deps.bridgeRosterProbe ? await deps.bridgeRosterProbe() : [];
      const known = roster.some((r) => r.client_token_id === bridge_id);
      if (!known) {
        return { ok: false, reason: 'bridge_unknown', bridge_id };
      }
      const settings = await store.setBridgeMode(bridge_id, patch);
      return { ok: true, settings };
    },

    async setVerificationPhrase(phrase) {
      const trimmed = (phrase ?? '').trim();
      if (trimmed.length > NOTIFICATION_VERIFICATION_PHRASE_MAX) {
        return {
          ok: false,
          reason: 'too_long',
          max: NOTIFICATION_VERIFICATION_PHRASE_MAX,
        };
      }
      const settings = await store.setVerificationPhrase(phrase);
      return { ok: true, settings };
    },
  };
};
