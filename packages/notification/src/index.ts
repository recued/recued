/** @recued/notification — D-158 the notification block.
 *
 *  The discrete user-surface leaf block (N.1): `notify` (fire-and-
 *  forget) + `ask` (one durable, bounded round-trip). Its single
 *  responsibility — deliver a message to the user, and, when the
 *  message is a question, collect the reply, across channels, per the
 *  user's settings. Nothing else.
 *
 *  The block is COMPOSED by the flow controllers — the `gateway`
 *  (D-157) and, later, the `engine` (Flow 1); it is not one. It
 *  composes the channel leaf adapters. It holds no flow-control logic:
 *  *whether* to ask is the calling flow controller's call, *delivering*
 *  the ask is the block's (N.1 / TR-9).
 *
 *  `ask` is durable by construction and returns a durable `ask_id`,
 *  never an awaited answer (I-3): a held answer-promise cannot survive
 *  the caller's execution ending (D-157's gateway ends the execution at
 *  a preflight gate) or a process restart. The `ask_id` + the
 *  boot-wired `on_answer` handler IS the primitive (A.3).
 *
 *  P0 ships the block skeleton + the always-on `ui` channel. P1 adds
 *  the per-pair settings record; P2 the BYO remote channels; P3
 *  hardening (multi-channel close, the staleness guard); P4 the
 *  D-149 / D-152 existing-consumer migration.
 *
 *  Spec: D-158 § N.1-N.9 / A.1-A.9 / P0.
 */

import { CHANNEL_ROLES } from '@recued/contracts';
import { ASK_BODY_MAX, ASK_NOTE_MAX } from './types.js';
import type { AskStore, NewPendingAsk } from './ask-store.js';
import {
  createAskSerializer,
  mintAskId as defaultMintAskId,
  selectAskOption,
} from './correlation.js';
import {
  createHandlerRegistry,
  dispatchAnswer,
  type HandlerRegistry,
} from './handler-registry.js';
import {
  channelApprovalEnabled,
  channelNotifyEnabled,
  createNotificationSettings,
  type BridgeRosterProbe,
  type BridgeRowView,
  type ChannelReadinessProbe,
  type ChannelToggleView,
  type NotificationSettingsStore,
  type SetBridgeModeResult,
  type SetChannelResult,
  type SetVerificationPhraseResult,
} from './settings.js';
import {
  routeBridgeAsk,
  routeBridgeNotify,
} from './bridge-routing.js';
import type { Channel } from './channels/channel.js';
import type {
  Answer,
  AskHandlerFn,
  AskHandlerKind,
  AskHandlerRef,
  AskOption,
  BridgeModeSettings,
  ChannelModeSettings,
  ChannelName,
  ChannelSelector,
  InboundReply,
  NotificationMessage,
  NotificationSettings,
  PendingAsk,
  AnswerAuditRecord,
  AskExtras,
  AskNotePrompt,
} from './types.js';

// ── Public surface ───────────────────────────────────────────────
export {
  HANDLED_ASK_RETENTION_MS,
  createAskStore,
  type AskStore,
  type NewPendingAsk,
} from './ask-store.js';
export { mintAskId } from './correlation.js';
export {
  createHandlerRegistry,
  type HandlerRegistry,
} from './handler-registry.js';
export {
  BRIDGE_INSTALL_URL,
  createNotificationSettings,
  createNotificationSettingsStore,
  DEFAULT_BRIDGE_MODE_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_SETTINGS_KEY,
  NOTIFICATION_VERIFICATION_PHRASE_MAX,
  type BridgeRosterProbe,
  type BridgeRowView,
  type ChannelReadinessProbe,
  type ChannelToggleView,
  type NotificationSettingsDeps,
  type NotificationSettingsStore,
  type NotificationSettingsSurface,
  type SetBridgeModeResult,
  type SetChannelResult,
  type SetVerificationPhraseResult,
} from './settings.js';
export {
  CHANNEL_CAPABILITIES,
  isChannelCapability,
  type Channel,
  type ChannelCapability,
} from './channels/channel.js';
export {
  createUiChannel,
  type UiBusSink,
  type UiChannelOptions,
  type UiNotificationEvent,
} from './channels/ui.js';
export {
  createBridgeChannel,
  type BridgeChannelDeps,
  type BridgeSink,
} from './channels/bridge.js';
export {
  routeBridgeAsk,
  routeBridgeNotify,
  type BridgeAskDisposition,
} from './bridge-routing.js';
export {
  createRemoteChannel,
  type CredentialResolver,
  type RemoteChannel,
  type RemoteChannelCredential,
  type RemoteChannelDeps,
} from './channels/remote.js';
export {
  createEmailChannel,
  extractAskId,
  parseEmailReply,
  type EmailChannelDeps,
  type EmailReplyInput,
  type EmailSender,
  type OutboundEmail,
} from './channels/email.js';
export {
  ASK_LANDING_RESPONSE_HEADERS,
  ASK_LANDING_VIA_KEY,
  parseAskLandingSubmission,
  resolveAskLandingVia,
  renderAskLandingHtml,
  type AskLandingDetail,
  type AskLandingEditControl,
  type AskLandingRenderInput,
  type AskLandingSubmission,
} from './channels/ask-landing.js';
export { ASK_BODY_MAX, ASK_NOTE_MAX } from './types.js';
export type {
  Answer,
  AnswerAuditRecord,
  AskHandlerFn,
  AskHandlerKind,
  AskHandlerRef,
  AskOption,
  BridgeModeSettings,
  ChannelModeSettings,
  ChannelName,
  ChannelSelector,
  InboundReply,
  NotificationMessage,
  NotificationSettings,
  PendingAsk,
  PendingAskStatus,
  RemoteChannelName,
  AskExtras,
  AskNotePrompt,
} from './types.js';

/** What `createNotificationBlock` is wired with. The block is channel-
 *  agnostic — it is handed concrete `Channel` adapters and treats them
 *  uniformly; which channels exist, and how they are built, is the
 *  composing server's concern (N.7). */
export interface NotificationBlockDeps {
  /** The durable pending-ask store (`createAskStore` over a
   *  `Collection<PendingAsk>`). */
  askStore: AskStore;
  /** The channel adapters the block fans out to. P0: `[ui]`. */
  channels: readonly Channel[];
  /** The block-owned per-pair notification-settings store (I-7). `ask`
   *  / `notify` read it to compute the fan-out set; the block's
   *  settings methods are its only writer. Required — a P1 block is
   *  defined to own a settings record (A.6 / I-7). */
  settingsStore: NotificationSettingsStore;
  /** D-163 N.5 — probes whether a togglable channel's readiness backing
   *  is present (a `connection.notification` credential for Slack /
   *  Telegram / Email; a paired Bridge in the pair store for Bridge).
   *  The block is a leaf and cannot reach either backing; `backend/
   *  server` injects this at wire time. Absent → no togglable channel
   *  can be enabled (fail closed). */
  readinessProbe?: ChannelReadinessProbe;
  /** D-169 P1 — probes the set of paired bridges (durable + connected).
   *  The block is a leaf and cannot reach the pair / WS rosters;
   *  `backend/server` injects this at wire time. Absent → Settings
   *  surface returns an empty per-bridge row list. */
  bridgeRosterProbe?: BridgeRosterProbe;
  /** The boot-wired handler registry. Defaults to a fresh empty one;
   *  a server may pass a shared instance it registers handlers on
   *  directly. */
  registry?: HandlerRegistry;
  /** Record an answered ask in the durable activity log.
   *
   *  The block is a leaf and owns no audit store, so `backend/server`
   *  injects this. It is called ONCE per ask, immediately after the
   *  `open → answered` write wins — the once-only dedup point — so a
   *  replayed or concurrent reply produces no second row.
   *
   *  ⚠ Best-effort BY DESIGN, and the tradeoff is deliberate: at the call
   *  site the user's decision is ALREADY durable, and D-158 TR-4's
   *  forbidden failure is silently dropping a decision the user made.
   *  Letting an audit-store fault reject `submitAnswer` would report a
   *  recorded approval back to the user as a failure. So a throw is
   *  swallowed and the answer proceeds.
   *
   *  Absent ⇒ no row. ⛔ Anything that PRUNES terminal asks depends on this
   *  being wired — see `AskStore.pruneHandled`. */
  recordAnswerAudit?: (record: AnswerAuditRecord) => Promise<void>;
  /** Clock — injectable for deterministic tests; defaults to
   *  `Date.now`. */
  now?: () => number;
  /** `ask_id` minter — injectable for deterministic tests; defaults to
   *  the UUID minter in `correlation.ts`. */
  mintAskId?: () => string;
  /** D-210 A.8 slice 3d — the `/ask/<ask_id>` landing-page URL, appended to
   *  the ask text on `inline` channels.
   *
   *  🔑 `inline` ONLY, and the exclusion is the design, not an optimization: a
   *  `landing-page` channel (email) already composes its own affordance, so
   *  appending here would give it the same URL twice. The capability is the
   *  discriminator because it is exactly the fact in question — "does this
   *  channel render its own way to answer".
   *
   *  ⚠ Injected, because the block is a LEAF: the public base URL lives in
   *  `backend/server`, and resolving it here would be an upward import. Absent
   *  (the default, and the case on any non-public deployment) → asks stay
   *  text-only, exactly as they were. */
  askAnswerLink?: (ask_id: string) => string;
}

/** The notification block's public operations. */
export interface NotificationBlock {
  // ── N.2 — the flow-controller surface ──────────────────────────

  /** Fire-and-forget. Delivers `message` to the fan-out set; collects
   *  no reply; never throws on a delivery failure (best-effort). */
  notify(
    message: NotificationMessage,
    channels?: ChannelSelector,
  ): Promise<void>;

  /** Interactive. Mints a durable `ask_id`, persists the pending ask
   *  BEFORE any delivery, fans the ask out, and resolves IMMEDIATELY
   *  with `{ ask_id }` — never with the user's answer (I-3). The answer
   *  arrives later via the handler registered under `handler.kind`. */
  ask(
    message: NotificationMessage,
    options: readonly AskOption[],
    handler: AskHandlerRef,
    channels?: ChannelSelector,
    /** D-234 § 234.4e/f — everything an ask carries besides its message: the
     *  note prompt and the readable body. ⛔ ONE OBJECT, not a tail of
     *  positionals — `body` would have been the sixth parameter, which is where
     *  callers start passing `undefined` to reach the one they want. */
    extras?: AskExtras,
  ): Promise<{ ask_id: string }>;

  /** Boot-time: wire the function a persisted `handler.kind` re-
   *  dispatches to. Each consumer calls this once at boot (I-4). */
  registerAskHandler(kind: AskHandlerKind, handler: AskHandlerFn): void;

  // ── Channel / server surface ────────────────────────────────────

  /** Funnel an authenticated inbound reply (I-9) into the block. The
   *  block is the correlation owner: it dedups (first answer wins,
   *  every later reply a no-op — I-6), records the answer durably,
   *  closes the ask on every channel it was delivered to, and
   *  dispatches `on_answer`. A reply to an unknown / already-answered
   *  ask, or one carrying an option the ask never offered, is a no-op.
   *  Resolves once the reply is processed (a handler failure does not
   *  reject — the answer is durably recorded and the boot sweep
   *  retries dispatch). */
  submitAnswer(reply: InboundReply): Promise<void>;

  /** D-177 P5a — retire a still-`open` ask WITHOUT an answer and close
   *  its prompt on every delivered channel. The batch-approval JOIN uses
   *  it to supersede the prior payload version's ask with the
   *  re-rendered one (each version is one ask; the version guard at the
   *  answer handler is the correctness backstop — cancellation is the
   *  UX half). Serialized against `submitAnswer` for the same `ask_id`:
   *  a reply that wins the race is processed normally and the cancel
   *  degrades to a no-op (`'not_open'`). Never throws on state. */
  cancelAsk(ask_id: string): Promise<'cancelled' | 'not_open'>;

  /** Boot recovery sweep (I-2 / I-4). Re-delivers still-`open` asks and
   *  re-dispatches `answered`-but-unhandled asks. Idempotent. Intended
   *  to run once at server boot, before live inbound traffic. */
  recoverPendingAsks(): Promise<void>;
  /** D-210 — drop `handled` asks older than `before` (unix-ms on
   *  `created_at`); returns how many went. The retention half of the
   *  store's long-standing "small + bounded" claim, which until now had no
   *  implementation. `handled` only — see `AskStore.pruneHandled` for why
   *  `answered` and `open` are untouchable. */
  pruneHandledAsks(before: number): Promise<number>;

  /** Cheap count of outstanding (`open`) asks — backs the `ui`
   *  "N asks awaiting you" badge (N.9 SHOULD). */
  countOutstandingAsks(): Promise<number>;

  /** D-169 P2 — the currently-open asks, oldest first. Backs the bridge
   *  side panel section #4 (N.5 #4) `notification.pending_asks` rpc: the
   *  block owns its ask store, so this read is exposed here rather than
   *  leaking the store to the composing server (symmetric with
   *  `countOutstandingAsks`). Slice 2 renders the result read-only;
   *  Slice 3 wires the interactive approval card + `submitAnswer`. */
  listOpenAsks(): Promise<PendingAsk[]>;

  /** D-157 N.8 — one ask row by id, or `null` when unknown. Backs the
   *  stale-checkpoint retention sweep's never-drop-a-decision check
   *  (an `answered` ask is deferred to its dispatch, not expired).
   *  Same store-read-stays-behind-the-block posture as `listOpenAsks`. */
  getAsk(ask_id: string): Promise<PendingAsk | null>;

  // ── Settings surface (A.6 / I-7) ────────────────────────────────

  /** The per-pair notification-settings record. `ui` is always `true`;
   *  the remote channels reflect the user's toggles. The same record
   *  `ask` / `notify` read internally to compute the fan-out set. */
  getNotificationSettings(): Promise<NotificationSettings>;

  /** The Settings → Notifications render model — one toggle row per
   *  channel (`ui` first), each carrying its enabled state, whether it
   *  is togglable (`ui` is not), the capability badge each row carries
   *  (D-163 N.6), and the readiness state the togglable rows gate on
   *  (D-163 N.5). */
  describeNotificationChannels(): Promise<readonly ChannelToggleView[]>;

  /** R31 — patch one channel's two-axis mode for Settings → Approval &
   *  notifications. `ui` is fixed-on (`ui_fixed`); an approval patch on a
   *  notify-only channel is refused (`approval_unsupported`); enabling an
   *  axis whose readiness backing is absent is refused (D-163 N.5 —
   *  `not_ready`) so the surface can route to the install / connect CTA.
   *  Disabling is never readiness-gated. */
  setNotificationChannelMode(
    channel: ChannelName,
    patch: Partial<ChannelModeSettings>,
  ): Promise<SetChannelResult>;

  /** Set or clear the anti-phishing verification phrase (A.6 — rendered
   *  on the `ask` landing page). A non-empty string sets it; `null` or
   *  an empty / whitespace-only string clears it. An over-length phrase
   *  is refused (`too_long`) so the Settings surface can cap the input.
   *  The block is the single front door for its settings (I-7). */
  setNotificationVerificationPhrase(
    phrase: string | null,
  ): Promise<SetVerificationPhraseResult>;

  /** D-169 P1 — render model for the per-bridge sub-row group in
   *  Settings → Notifications. One `BridgeRowView` per paired bridge in
   *  pair-time order. Returns `[]` when no bridges are paired or the
   *  `bridgeRosterProbe` is absent. */
  describeNotificationBridges(): Promise<readonly BridgeRowView[]>;

  /** D-169 P1 — toggle one mode flag on one paired bridge. An unknown
   *  bridge id returns `bridge_unknown` so the Settings UI re-fetches.
   *  Disabling never fails; enabling is not readiness-gated (the
   *  bridge's existence in the roster is the readiness check). The
   *  `patch` shape lets the caller toggle notification, approval, or
   *  both in one call; absent fields preserve their prior value. */
  setNotificationBridgeMode(
    bridge_id: string,
    patch: Partial<BridgeModeSettings>,
  ): Promise<SetBridgeModeResult>;
}

/** Create a notification block. */
export const createNotificationBlock = (
  deps: NotificationBlockDeps,
): NotificationBlock => {
  const now = deps.now ?? Date.now;
  const mint = deps.mintAskId ?? defaultMintAskId;
  const registry = deps.registry ?? createHandlerRegistry();
  const store = deps.askStore;
  const allChannels = deps.channels;
  // The `ui` channel is always-on (N.4). A block wired without a `ui`
  // adapter has no always-available delivery surface — and every `ask`
  // / `notify` would silently skip it: the settings record keeps `ui`
  // enabled, but `resolveChannels` can only return adapters it was
  // handed. Fail loudly at construction rather than degrade silently.
  if (!allChannels.some((channel) => channel.name === 'ui')) {
    throw new Error(
      'createNotificationBlock: the always-on `ui` channel (N.4) must '
        + 'be present in `channels`',
    );
  }
  // D-192 — ROLES and CAPABILITY are orthogonal, but not unconstrained. This is the
  // ONE rule that ties them, and it is checked here because this is the only place
  // both facts are in scope: the declared role (`CHANNEL_ROLES`) and the adapter's
  // actual rendering capability (`channel.capability`).
  //
  //   A `notify-only` channel MUST declare `approval: false`.
  //   You cannot approve where you cannot render.
  //
  // Without it, an ask would be fanned out to a channel structurally unable to carry
  // it — accepted, counted as delivered, and never actually answerable. Green, and
  // mute. Fail at construction instead: the two are declared in different files, so
  // nothing else would catch them disagreeing.
  const contradictory = allChannels.filter(
    (channel) =>
      channel.capability === 'notify-only' && CHANNEL_ROLES[channel.name].approval,
  );
  if (contradictory.length > 0) {
    throw new Error(
      'createNotificationBlock: channel(s) declare `approval: true` in CHANNEL_ROLES '
        + `but render as 'notify-only': ${contradictory.map((c) => c.name).join(', ')}. `
        + 'An ask fanned out there could never be answered.',
    );
  }
  const serializer = createAskSerializer();
  const settings = createNotificationSettings({
    store: deps.settingsStore,
    ...(deps.readinessProbe ? { readinessProbe: deps.readinessProbe } : {}),
    ...(deps.bridgeRosterProbe ? { bridgeRosterProbe: deps.bridgeRosterProbe } : {}),
  });

  // ── D-169 P2 Slice 4 — per-bridge bridge fan-out ─────────────────
  // The block holds ONE `'bridge'` Channel adapter (D-163 N.4) but the
  // user pairs N bridges, each with independent
  // `BridgeModeSettings { notification, approval }` (D-169 P1). When a
  // `bridgeRosterProbe` is wired AND at least one bridge is paired, the
  // single bridge adapter is dispatched PER paired bridge per its modes
  // (N.6 / I-10), consulted at every ask/notify raise so a toggle takes
  // effect on the next dispatch (TR-12). The legacy channel-level
  // `enabled['bridge']` only governs the bridge when zero bridges are
  // paired (where it is moot — no surface to deliver to).
  //
  // NOTE (the inert-pending-transport reality): in production the bridge
  // channel's `bridgeSink` is a no-op (wire-notification-block.ts) — the
  // actual delivery to paired bridges is the D-121 broadcast bus emitted
  // by the `ui` channel (untargeted fan-out to every subscribed client),
  // and per-bridge approval-mode gating is enforced CLIENT-SIDE on each
  // bridge (D-169 Slice 4 side-panel gate). This server-side per-bridge
  // dispatch is the spec § A.6 routing decision: observable in a
  // recorded-channel unit test, inert at the production bridge adapter
  // until a future slice wires a bridge-targeted sink.
  const bridgeChannel = allChannels.find((channel) => channel.name === 'bridge');
  const hasBridgeRoster = deps.bridgeRosterProbe !== undefined;

  /** D-163 N.3 — resolve enabled channels for `ask` fan-out, split by
   *  capability:
   *    - `deliver`        — capability ≠ `'notify-only'`: receives
   *                         `deliverAsk` (rendered inline or via
   *                         landing-page link).
   *    - `passiveNotify`  — capability === `'notify-only'`: filtered out
   *                         of the ask delivery set (no inbound-reply
   *                         path) and instead receives a passive
   *                         `deliverNotify` carrying the webclient ask
   *                         URL so the user knows approval is pending.
   *
   *  A settings-enabled channel with no wired adapter is simply absent
   *  from both results — so a partially-wired block stays correct
   *  whatever the record says.
   *
   *  The `ChannelSelector` is accepted for D-158 N.2 surface stability
   *  (D-157 keys on it) but does not yet discriminate — per-intent
   *  routing is a v1.x refinement (D-158 O-4); v1.0 ships flat
   *  per-channel on/off. */
  const resolveAskChannels = async (
    _selector?: ChannelSelector,
  ): Promise<{
    deliver: Channel[];
    passiveNotify: Channel[];
    /** D-169 Slice 4 — count of paired bridges whose approval mode is ON
     *  → the single bridge adapter receives `deliverAsk` once per such
     *  bridge (the per-bridge ask fan-out, I-10). */
    bridgeAsk: number;
    /** D-169 Slice 4 — count of paired bridges with approval OFF but
     *  notification ON → the bridge adapter receives a passive
     *  `deliverNotify` once per such bridge (D-163 I-3). */
    bridgePassiveNotify: number;
  }> => {
    const enabled = await settings.get();
    // D-169 Slice 4 — per-ask roster lookup (TR-12). Only when a roster
    // probe is wired AND at least one bridge is paired does the per-bridge
    // split own the bridge adapter; otherwise the bridge routes through
    // the legacy channel-level loop below (preserves pre-D-169-P2
    // behavior + the many harnesses that wire no roster probe).
    const bridgeRows = hasBridgeRoster ? await settings.describeBridges() : [];
    const usePerBridge = bridgeRows.length > 0;
    const deliver: Channel[] = [];
    const passiveNotify: Channel[] = [];
    for (const channel of allChannels) {
      // The bridge adapter is dispatched per-bridge below when the
      // per-bridge split is active — skip it here so it is not ALSO
      // routed by the channel-level capability split (double-delivery).
      if (usePerBridge && channel.name === 'bridge') continue;
      // R31 — split by capability, gating each on the RIGHT axis. A
      // notify-only channel can't carry an ask, so it receives a passive
      // notify (that an approval is pending) IFF its NOTIFICATION axis is
      // on; an inline / landing-page channel receives the ask itself IFF
      // its APPROVAL axis is on. (The pre-R31 single `enabled[name]` flag
      // gated both — a dynamic-index truthiness read that would SILENTLY
      // pass every channel now that the value is a two-axis object.)
      if (channel.capability === 'notify-only') {
        if (channelNotifyEnabled(enabled, channel.name)) {
          passiveNotify.push(channel);
        }
      } else if (channelApprovalEnabled(enabled, channel.name)) {
        deliver.push(channel);
      }
    }
    let bridgeAsk = 0;
    let bridgePassiveNotify = 0;
    if (usePerBridge && bridgeChannel) {
      for (const row of bridgeRows) {
        const disposition = routeBridgeAsk(row.modes);
        if (disposition === 'ask') bridgeAsk += 1;
        else if (disposition === 'passive_notify') bridgePassiveNotify += 1;
        // 'skip' (both modes off) — the bridge is dispatched neither way.
      }
    }
    return { deliver, passiveNotify, bridgeAsk, bridgePassiveNotify };
  };

  /** Resolve enabled channels for `notify` fan-out — every enabled
   *  channel regardless of capability (D-163 N.3). A one-way notification
   *  has no interactive contract to honor. */
  const resolveNotifyChannels = async (
    _selector?: ChannelSelector,
  ): Promise<{
    channels: Channel[];
    /** D-169 Slice 4 — count of paired bridges with notification mode ON
     *  → the bridge adapter receives `deliverNotify` once per such
     *  bridge. */
    bridgeNotify: number;
  }> => {
    const enabled = await settings.get();
    const bridgeRows = hasBridgeRoster ? await settings.describeBridges() : [];
    const usePerBridge = bridgeRows.length > 0;
    // R31 — a one-way notify is gated on the NOTIFICATION axis of each
    // channel (`channelNotifyEnabled` resolves the heterogeneous record:
    // ui always, bridge = the channel-level boolean, remotes = their
    // notification axis). The bridge is excluded here when the per-bridge
    // split owns it below.
    const channels = allChannels.filter(
      (channel) =>
        channelNotifyEnabled(enabled, channel.name)
        && !(usePerBridge && channel.name === 'bridge'),
    );
    let bridgeNotify = 0;
    if (usePerBridge && bridgeChannel) {
      for (const row of bridgeRows) {
        if (routeBridgeNotify(row.modes)) bridgeNotify += 1;
      }
    }
    return { channels, bridgeNotify };
  };

  /** Compose the passive-notify body fired to `'notify-only'` channels
   *  when an `ask` is raised (D-163 N.3 / SHOULD). Carries enough text
   *  for the OS / lock-screen / passive-only surface to convey that an
   *  approval is pending; the actual approval action happens in the
   *  webclient ask URL the SHOULD calls for. The URL itself is woven in
   *  at the `backend/server` wire layer (the block is a leaf and cannot
   *  reach the host-specific webclient URL); v1.0 sets the field
   *  unconditionally so a wired URL renders, and a no-op host leaves
   *  the placeholder visible. */
  const composePassiveAskBody = (
    message: NotificationMessage,
  ): NotificationMessage => ({
    ...(message.title !== undefined ? { title: message.title } : {}),
    text: `${message.text} — approval pending; open Recued to act.`,
  });

  /** The channel adapters an ask was fanned out to — its persisted
   *  `fanout_channels` mapped to live adapter instances. The boot re-
   *  delivery and the close-broadcast both walk THIS set, never the
   *  live settings record: an ask's delivery + close target set is
   *  fixed at `create`, so a settings change after `create` can neither
   *  strand a live prompt on a channel the close-broadcast won't reach,
   *  nor re-deliver to a channel this ask was never part of. A
   *  `fanout_channels` entry with no matching wired adapter is dropped
   *  — harmless: it was never delivered, so there is nothing to re-
   *  deliver or close. */
  const channelsForAsk = (ask: PendingAsk): Channel[] =>
    ask.fanout_channels
      .map((name) => allChannels.find((channel) => channel.name === name))
      .filter((channel): channel is Channel => channel !== undefined);

  /** D-210 A.8 slice 3d — append the landing-page URL to an `inline` channel's
   *  ask text.
   *
   *  Why the text and not a structured field: `OutboundPrompt` (the shape every
   *  messenger transport's `sendPrompt` takes) carries no `link_url` — only
   *  `OutboundMessage` does. Adding one would mean touching four transports to
   *  reach the same visible result, and would still leave any future transport
   *  silently link-less until it opted in. Appending to the text reaches every
   *  inline channel the moment it exists, which is the property that matters
   *  for a link whose absence is invisible.
   *
   *  Returns the message UNTOUCHED when there is no builder or the channel
   *  renders its own — never a partially-composed one. */
  const withAnswerLink = (
    channel: Channel,
    ask_id: string,
    message: NotificationMessage,
  ): NotificationMessage => {
    if (deps.askAnswerLink === undefined || channel.capability !== 'inline') return message;
    let url: string;
    try {
      url = deps.askAnswerLink(ask_id);
    } catch {
      // A link builder that throws must cost the ask its convenience, never its
      // delivery — the buttons still work.
      return message;
    }
    if (url.length === 0) return message;
    return { ...message, text: `${message.text}\n\nOpen to review or edit: ${url}` };
  };

  /** Best-effort `ask` fan-out — a single channel's delivery failure
   *  never fails `ask` (TR-10: a transient no-reachable-channel state
   *  must not drop a durable decision). The ask is already persisted
   *  `open` with its `fanout_channels`; an undelivered channel is
   *  re-tried by the boot sweep. */
  const fanOutAsk = async (
    targets: readonly Channel[],
    ask_id: string,
    message: NotificationMessage,
    options: readonly AskOption[],
    /** D-234 § 234.4e/f — carried to every adapter that can use them. Threaded
     *  rather than read off the ask row because this helper also serves the BOOT
     *  RE-DELIVERY path, where the row is the only source. */
    extras?: AskExtras,
  ): Promise<void> => {
    for (const channel of targets) {
      try {
        await channel.deliverAsk(
          ask_id, withAnswerLink(channel, ask_id, message), options, extras,
        );
      } catch {
        // best-effort — the ask stays durably `open`; the boot sweep
        // re-delivers when the channel recovers (TR-10).
      }
    }
  };

  /** D-163 N.3 — best-effort passive `notify` fan-out fired to
   *  `'notify-only'` channels alongside an `ask` raise. Same best-effort
   *  contract as `notify`: a passive surface that misses the
   *  notification leaves the ask durably `open` on its inbound channels;
   *  the user can still resolve through any capability-≥-landing-page
   *  channel. Not retried on boot — these channels are not in
   *  `fanout_channels`, by D-163 N.3 design. */
  const firePassiveNotify = async (
    targets: readonly Channel[],
    message: NotificationMessage,
  ): Promise<void> => {
    for (const channel of targets) {
      try {
        await channel.deliverNotify(message);
      } catch {
        // best-effort — `notify` collects no reply and never throws.
      }
    }
  };

  /** Close the ask prompt on every channel it was delivered to. The
   *  `ui` channel is multi-surface — D-121 fans one ask out to every
   *  paired client — so the channel a reply arrived on still has
   *  sibling surfaces with a live prompt to resolve. `closeAsk` is
   *  idempotent per channel, so closing every delivered channel
   *  (including the one the answer came in on) is correct and is what
   *  resolves the card on the user's other devices (I-6). */
  const closeOnAllChannels = async (ask: PendingAsk): Promise<void> => {
    for (const channel of channelsForAsk(ask)) {
      try {
        await channel.closeAsk(ask.ask_id);
      } catch {
        // best-effort — a stale prompt on an unreachable channel is
        // tolerable; the answer is already durably recorded.
      }
    }
  };

  return {
    async notify(message, channels) {
      const { channels: targets, bridgeNotify } =
        await resolveNotifyChannels(channels);
      for (const channel of targets) {
        try {
          await channel.deliverNotify(message);
        } catch {
          // best-effort — `notify` collects no reply and never throws.
        }
      }
      // D-169 Slice 4 — per-bridge notify fan-out: one `deliverNotify`
      // per notification-mode-ON paired bridge over the single bridge
      // adapter (see the block-top note on the inert-pending-transport
      // bridge sink — the production delivery is the D-121 bus).
      if (bridgeChannel) {
        for (let i = 0; i < bridgeNotify; i += 1) {
          try {
            await bridgeChannel.deliverNotify(message);
          } catch {
            // best-effort — same contract as the channel loop above.
          }
        }
      }
    },

    async ask(message, options, handler, channels, extras) {
      const ask_id = mint();
      const { deliver, passiveNotify, bridgeAsk, bridgePassiveNotify } =
        await resolveAskChannels(channels);
      const fresh: NewPendingAsk = {
        ask_id,
        message,
        options,
        handler_kind: handler.kind,
        handler_payload: handler.payload,
        // D-234 § 234.4e — persisted WITH the ask, so the answer path can tell an
        // invited note from an uninvited one long after the raise site is gone.
        // Deriving it later from the handler kind would make the rule "some kinds
        // take notes", which is exactly the coupling the per-ask flag avoids.
        ...(extras?.note_prompt !== undefined
          ? { note_prompt: extras.note_prompt }
          : {}),
        // D-234 § 234.4f — TRUNCATED at entry, not refused: the far side wrote
        // it, and a reviewer who can read four pages of five is better served
        // than one who gets an error where the draft should be.
        ...(extras?.body !== undefined && extras.body !== ''
          ? { body: extras.body.slice(0, ASK_BODY_MAX) }
          : {}),
        // The resolved fan-out target set, persisted with the ask
        // BEFORE any delivery: the close-broadcast set is then correct
        // the instant a card can be visible, with no post-delivery
        // read-modify-write to race a fast inbound reply.
        //
        // D-163 N.3 — `passiveNotify` channels are NOT in the fanout
        // set. They have no inbound-reply path (capability is
        // `'notify-only'`); the close-broadcast must never target them,
        // and the boot re-delivery sweep must never re-route an ask
        // through `deliverAsk` on them.
        fanout_channels: deliver.map((c) => c.name),
        created_at: now(),
      };
      // Persist BEFORE any delivery — the ask is durable the instant
      // `ask` can fail (D-158 I-2). A store failure rejects `ask`; a
      // delivery failure (handled inside `fanOutAsk` /
      // `firePassiveNotify`) does not.
      await store.create(fresh);
      await fanOutAsk(deliver, ask_id, message, options, extras);
      // D-163 N.3 / I-3 — passive notify to notify-only channels so
      // the user learns approval is pending on those surfaces (e.g.
      // OS notification via Bridge). Best-effort per channel; a
      // failure leaves the ask durably `open` for normal answer paths.
      const passiveBody = composePassiveAskBody(message);
      await firePassiveNotify(passiveNotify, passiveBody);
      // D-169 Slice 4 — per-bridge bridge fan-out over the single bridge
      // adapter: one `deliverAsk` per approval-mode-ON paired bridge, one
      // passive `deliverNotify` per notification-only bridge (both-off
      // bridges skipped — TR-8). Inert at the production sink (no-op),
      // observable in a recorded-channel unit test; the real bridge
      // surface converges via the `ui` channel's D-121 bus emit + the
      // side-panel approval-mode gate (Slice 4 client side). The bridge is
      // deliberately NOT in `fanout_channels` (above) — its close + boot
      // re-delivery ride the `ui`/bus path, and its adapter `closeAsk` /
      // re-`deliverAsk` are no-ops.
      if (bridgeChannel) {
        for (let i = 0; i < bridgeAsk; i += 1) {
          try {
            await bridgeChannel.deliverAsk(ask_id, message, options, extras);
          } catch {
            // best-effort — the ask stays durably `open` on its inbound
            // channels; the bridge surface converges via the bus.
          }
        }
        for (let i = 0; i < bridgePassiveNotify; i += 1) {
          try {
            await bridgeChannel.deliverNotify(passiveBody);
          } catch {
            // best-effort — passive awareness only.
          }
        }
      }
      // Resolve with the ask_id — before any answer, never an awaited
      // answer (I-3).
      return { ask_id };
    },

    registerAskHandler(kind, handler) {
      registry.register(kind, handler);
    },

    async cancelAsk(ask_id) {
      // Serialize with `submitAnswer` for this ask_id — the load → state
      // check → terminal write cannot interleave with an inbound reply,
      // so exactly one of {answer, cancel} wins and the loser observes
      // the terminal state.
      let outcome: 'cancelled' | 'not_open' = 'not_open';
      await serializer.run(ask_id, async () => {
        const ask = await store.get(ask_id);
        if (ask === null || ask.status !== 'open') return;
        outcome = await store.cancel(ask_id);
        if (outcome === 'cancelled') {
          // Resolve the now-stale prompt on every delivered surface —
          // same close-broadcast the answered path runs (idempotent per
          // channel; best-effort inside `closeOnAllChannels`).
          await closeOnAllChannels(ask);
        }
      });
      return outcome;
    },

    async submitAnswer(reply) {
      // Serialize every reply for this ask_id — the load → dedup-check
      // → `open → answered` write cannot interleave, so a concurrent
      // second reply observes `answered` and is a no-op (I-6 dedup).
      await serializer.run(reply.ask_id, async () => {
        const ask = await store.get(reply.ask_id);
        // Unknown ask, or one already past `open` — first answer won;
        // every later reply is a no-op (I-6).
        if (ask === null || ask.status !== 'open') return;
        // A reply carrying an option the ask never offered is not a
        // valid answer.
        if (selectAskOption(ask, reply.option) === undefined) return;

        // D-234 § 234.4e — THE NOTE, admitted only if this ask invited one.
        //
        // ⛔ AN UNINVITED NOTE IS DROPPED, NOT REFUSED. The option is the
        // decision and it is already valid; rejecting a recorded decision over an
        // extra field is TR-4's forbidden failure. Dropping also means a surface
        // that always sends a note cannot write prose onto asks that never asked
        // for any.
        const trimmedNote = typeof reply.note === 'string' ? reply.note.trim() : '';
        const invited = ask.note_prompt !== undefined;
        const note = invited && trimmedNote !== ''
          ? trimmedNote.slice(0, ASK_NOTE_MAX)
          : undefined;
        // ⚠ REQUIRED MEANS THE REPLY IS INVALID WITHOUT ONE — the same no-op the
        // block gives an option it never offered, and for the same reason: a
        // half-answer must not become the durable, once-only recorded answer.
        // The surface is expected to enforce this before sending; this is the
        // backstop for one that does not.
        if (ask.note_prompt === 'required' && note === undefined) return;

        const answer: Answer = {
          option: reply.option,
          answered_at: now(),
          ...(note !== undefined ? { note } : {}),
        };
        // `open → answered` — the durable, once-only dedup point (A.5).
        await store.recordAnswer(reply.ask_id, answer, reply.via);

        const answered: PendingAsk = {
          ...ask,
          status: 'answered',
          answer,
          answered_via: reply.via,
        };
        // Record the decision in the durable activity log, HERE — this is
        // the only point that knows which channel answered (`dispatchAnswer`
        // strips it, I-10), and it is inside the once-only dedup window so a
        // replayed reply writes no second row.
        //
        // Best-effort: the decision is already durable above, and rejecting
        // `submitAnswer` over an audit fault would report a recorded answer
        // back to the user as a failure (TR-4's forbidden failure).
        if (deps.recordAnswerAudit !== undefined) {
          try {
            await deps.recordAnswerAudit({
              ask_id: ask.ask_id,
              handler_kind: ask.handler_kind,
              option: answer.option,
              option_label:
                selectAskOption(ask, answer.option)?.label ?? answer.option,
              ...(ask.message.title !== undefined ? { title: ask.message.title } : {}),
              answered_at: answer.answered_at,
              answered_via: reply.via,
            });
          } catch {
            /* audit is not the decision — never lose the answer over it. */
          }
        }
        // Resolve the prompt on every delivered channel (A.2 step 7).
        await closeOnAllChannels(answered);
        // Dispatch `on_answer` (A.2 step 8). A missing or throwing
        // handler leaves the ask `answered`; the boot sweep re-
        // dispatches it. The reply itself succeeded — `submitAnswer`
        // resolves regardless.
        try {
          await dispatchAnswer({ registry, store, ask: answered });
        } catch {
          // handler threw — ask stays `answered`, next boot retries.
        }
      });
    },

    pruneHandledAsks(before) {
      return store.pruneHandled(before);
    },

    async recoverPendingAsks() {
      // `open` — re-deliver. A crash before / during the original
      // fan-out left the ask undelivered or partially delivered;
      // `Channel.deliverAsk` is idempotent per `ask_id`, so re-
      // delivering to an already-shown surface reconciles rather than
      // double-renders. Re-delivery targets the ask's persisted
      // `fanout_channels` (via `channelsForAsk`), NOT the live settings
      // record: a channel the user toggled off after `create` still
      // holds a live prompt to reconcile, and a channel toggled on
      // after `create` was never part of this ask — delivering to it
      // would leave a prompt the close-broadcast (also `fanout_
      // channels`-keyed) can never resolve.
      for (const ask of await store.listByStatus('open')) {
        await fanOutAsk(
          channelsForAsk(ask),
          ask.ask_id,
          ask.message,
          ask.options,
          // ⚠ OFF THE PERSISTED ROW, not a caller argument — this is the BOOT
          // re-delivery path, where the raise site is long gone. An ask that
          // invited a reason must still invite one after a restart, and the
          // document must still be there to read.
          {
            ...(ask.note_prompt !== undefined
              ? { note_prompt: ask.note_prompt }
              : {}),
            ...(ask.body !== undefined ? { body: ask.body } : {}),
          },
        );
      }
      // `answered` — finish the post-answer steps a crash interrupted.
      // A crash between `recordAnswer` (A.2 step 6) and the close-
      // broadcast (step 7) leaves an answered ask with prompts still
      // live, so close every fan-out channel first — `closeAsk` is
      // idempotent, so re-closing an already-closed prompt is a no-op
      // — then re-dispatch the handler (step 8, I-4). A still-
      // unregistered or throwing handler leaves the ask `answered` for
      // a later boot.
      for (const ask of await store.listByStatus('answered')) {
        await closeOnAllChannels(ask);
        try {
          await dispatchAnswer({ registry, store, ask });
        } catch {
          // handler threw again — stays `answered`, next boot retries.
        }
      }
    },

    countOutstandingAsks() {
      return store.countOpen();
    },

    listOpenAsks() {
      return store.listByStatus('open');
    },

    getAsk(ask_id) {
      return store.get(ask_id);
    },

    getNotificationSettings() {
      return settings.get();
    },

    describeNotificationChannels() {
      return settings.describe();
    },

    setNotificationChannelMode(channel, patch) {
      return settings.setChannelMode(channel, patch);
    },

    setNotificationVerificationPhrase(phrase) {
      return settings.setVerificationPhrase(phrase);
    },

    describeNotificationBridges() {
      return settings.describeBridges();
    },

    setNotificationBridgeMode(bridge_id, patch) {
      return settings.setBridgeMode(bridge_id, patch);
    },
  };
};
