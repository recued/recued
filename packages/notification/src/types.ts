/** D-158 P0 — `@recued/notification` shared shapes.
 *
 *  The notification block's own type surface (A.1 `types.ts`). The
 *  types live in the block, not in `@recued/contracts` — the block is a
 *  self-contained leaf, the same way D-160's `Channel` shapes live in
 *  `@recued/chat`. Nothing here is recipe-wire shape; it is the
 *  block-internal + flow-controller-facing surface.
 *
 *  Spec: D-158 § N.1-N.6 / A.1-A.3.
 */

import {
  NOTIFICATION_CHANNEL_NAMES,
  type NotificationChannelName,
  type NotificationCredentialChannel,
} from '@recued/contracts';

/** A message delivered to the user. Channel-agnostic — the block hands
 *  this to a channel adapter, which renders it for its surface. The
 *  block delivers whatever message it is handed; deciding *what* to say
 *  is the calling flow controller's concern (Non-goal 5). */
export interface NotificationMessage {
  /** Short heading. */
  title?: string;
  /** The message body. */
  text: string;
  /** Optional deep link a surface renders as an affordance. */
  link_url?: string;
}

/** D-234 § 234.4e — whether an ask invites a written reason with the answer.
 *  Absent (the common case) ⇒ no note is offered. */
export type AskNotePrompt = 'optional' | 'required';

/** ⚠ THE FAR SIDE MAY HAVE WRITTEN THIS. On a peer ask the note is authored by
 *  ANOTHER SERVER'S OWNER and travels back over the wire, so it is bounded at the
 *  point of entry rather than trusted — the same posture (and the same bound) as
 *  `PEER_ASK_QUESTION_MAX`. A reason that does not fit in 600 characters is a
 *  document, and a document belongs behind a link, not in an answer row. */
export const ASK_NOTE_MAX = 600;

/** D-234 § 234.4f — what an ask can carry BESIDES its message, options and
 *  handler. One object rather than a growing tail of positionals: `note_prompt`
 *  was the fifth parameter and `body` would have been the sixth, which is the
 *  point at which a caller starts passing `undefined` to reach the one it wants.
 *
 *  ⛔⛔ EVERY FIELD HERE IS DELIBERATELY *NOT* ON `NotificationMessage`. That
 *  type is what channel adapters render into Slack / Telegram / email and what
 *  the bearer `/ask/<ask_id>` landing shows. Anything in it is readable by
 *  whoever holds the notification. These ride the ASK RECORD instead — reachable
 *  only through the pair-authenticated `pending_asks` rpc and the owner's own
 *  broadcast bus. */
export interface AskExtras {
  /** Invite a written reason with the answer. */
  note_prompt?: AskNotePrompt;
  /** D-234 § 234.4f — the document the answerer opens to READ before deciding.
   *  Bounded at {@link ASK_BODY_MAX} on entry; the far side may have written it. */
  body?: string;
  /** Host-reserved, cryptographically random ask capability for a durable
   * idempotency mapping. Ordinary callers omit this and let the block mint.
   * The caller MUST persist the value before invoking `ask`; the block then
   * treats an exact replay as the same ask instead of minting a second owner
   * decision. Never derive this from a public operation id. */
  reserved_ask_id?: string;
  /** Host-only durability hook. Runs after the PendingAsk is persisted and
   * before any channel delivery (and again for an exact reserved-id replay).
   * It is neither persisted nor passed to channel adapters. A throw leaves the
   * ask open and undelivered so the caller or boot recovery can retry safely. */
  on_persisted?: (ask_id: string) => void | Promise<void>;
}

/** ⚠ Mirrors `PEER_ASK_BODY_MAX`. A body that does not fit is TRUNCATED at
 *  entry, not refused: the decision still has to be answerable, and a reviewer
 *  who can read four pages of five is better served than one who gets an error
 *  where the draft should be. The surface says it was truncated. */
export const ASK_BODY_MAX = 16_384;

/** One answer choice on an `ask`. `id` is the stable slug a handler
 *  branches on; `label` is what the user sees. */
export interface AskOption {
  /** Stable choice slug — the value an `Answer` carries. */
  id: string;
  /** Human-readable label rendered on the surface. */
  label: string;
}

/** The channel-stripped answer surfaced to a caller's `on_answer`
 *  handler (I-10): never a channel message id, never a channel name —
 *  the block is the correlation owner and hands the caller a clean
 *  answer only. */
export interface Answer {
  /** The chosen `AskOption.id`. */
  option: string;
  /** Unix-ms the winning answer was recorded. */
  answered_at: number;
  /** D-234 § 234.4e — free text the answerer added, when the ask OFFERED it
   *  ({@link PendingAsk.note_prompt}). Absent on every ask that did not.
   *
   *  🔑 THE OPTION IS THE DECISION; THIS IS THE REASON. They are different kinds
   *  of fact and the split is deliberate: a handler branches on `option` and must
   *  never have to parse prose to learn what was decided. Nothing downstream may
   *  make behaviour depend on this field — it is for the human on the other end.
   *
   *  ⚠ Capped at {@link ASK_NOTE_MAX} at the point of entry, because on a peer
   *  ask the author of this text is ANOTHER SERVER'S OWNER. */
  note?: string;
}

/** A consumer's handler slug — a closed-list string identifying the
 *  function the block re-dispatches an answer to (A.3). The block
 *  stores this in place of a closure (I-4): a closure cannot be
 *  persisted or re-dispatched after a restart. D-157 will register e.g.
 *  `'gateway.preflight'` / `'gateway.in_doubt'`. The block never
 *  interprets the slug — it is an opaque registry key. */
export type AskHandlerKind = string;

/** The function a consumer registers under an `AskHandlerKind` via
 *  `registerAskHandler`. Invoked — when the ask is answered — with the
 *  consumer's own JSON `payload` and the channel-stripped `Answer`. */
export type AskHandlerFn = (
  payload: Record<string, unknown>,
  answer: Answer,
) => void | Promise<void>;

/** What `ask`'s caller passes in place of a closure (I-4): a stable
 *  handler-kind slug + a JSON-serialisable payload. The block persists
 *  exactly this `(kind, payload)` pair; `registerAskHandler` wires the
 *  function fresh at every boot. The block never interprets `payload` —
 *  for a D-157 preflight ask it is the checkpoint id, for an `in_doubt`
 *  ask the `commit_id` / `correlation_id` (A.3). */
export interface AskHandlerRef {
  kind: AskHandlerKind;
  /** JSON-serialisable handler context. A closure is never persisted. */
  payload: Record<string, unknown>;
}

/** The closed channel list (D-158 N.4 + D-163 N.4). `ui` is always-on and cannot
 *  be disabled; `bridge` / `email` / every chat transport are BYO opt-in. D-163
 *  promotes `bridge` from a UI sub-component to a first-class `'notify-only'`
 *  adapter.
 *
 *  D-192 seam 10: this list is no longer spelled here — it IS the contracts list
 *  (`NOTIFICATION_CHANNEL_NAMES`), which splices in the declared chat-transport
 *  slugs. It used to be a hand-maintained twin of the contracts one, kept honest
 *  by a ratchet test; deriving it instead means the twin cannot drift at all, and
 *  a new chat transport lands here with no edit. Importing contracts is the
 *  canonical dependency direction (every package imports contracts, never the
 *  reverse) and adds no coupling layer — `@recued/storage`, already a dep of this
 *  block, imports it too. */
// ⛔ MODULE-PRIVATE. Retired as an export 2026-08-11: no caller ever imported it
// — every consumer takes `NOTIFICATION_CHANNEL_NAMES` from contracts directly —
// while FIVE prose sites named it as the thing to add a channel to. It survives
// only because `isChannelName` below closes over it; the name is kept so the
// predicate reads the same. `ChannelName` stays exported (77 references).
const CHANNEL_NAMES = NOTIFICATION_CHANNEL_NAMES;
export type ChannelName = NotificationChannelName;
/** Predicate — true when `value` is a registered notification `ChannelName`.
 *  D-192 CORE #6: bridges the widened `TransportVendor` (an open slug) back to
 *  the closed notification-channel set when a transport-backed `RemoteChannel`
 *  is built (a messenger transport's channel name IS its vendor).
 *
 *  ⛔ NOT "add the transport to `CHANNEL_NAMES` first" — the fifth site to say
 *  so, and the one closest to the code. There is no list to edit:
 *  `NOTIFICATION_CHANNEL_NAMES` splices `...MESSENGER_VENDOR_SLUGS`, so
 *  declaring the vendor in contracts IS what makes it a channel. See
 *  `messenger-vendors.ts` § ADDING A VENDOR. */
export const isChannelName = (value: unknown): value is ChannelName =>
  typeof value === 'string' && (CHANNEL_NAMES as readonly string[]).includes(value);

/** The user-togglable subset of `ChannelName` — every channel except
 *  the always-on `ui` (N.4 / N.5). Enabling one is gated on the
 *  `ChannelReadinessProbe` (D-163 N.5); `ui` needs no readiness check
 *  and cannot be toggled, so it is excluded from this type by
 *  construction — a `RemoteChannelName` parameter makes "you cannot
 *  toggle `ui`" a compile error, not a runtime check. */
export type RemoteChannelName = Exclude<ChannelName, 'ui'>;

/** The block-owned per-pair notification-settings record (N.5 / A.6 /
 *  I-7). A flat per-channel enabled boolean — no per-event-type routing
 *  (that is a v1.x refinement, O-4) — plus, since D-158 P2b-ii, the
 *  optional anti-phishing `verification_phrase`. `ui` is always-on and
 *  not user-disablable, so it is typed as the literal `true`; the remote
 *  channels are opt-in and default `false`.
 *
 *  This record is the block's OWN config — not `prefs` (recipe-wire
 *  plumbing, never a user config surface), not `connection.notification`
 *  (credentials, not on/off policy). It is read by `ask` / `notify` to
 *  compute the fan-out set and written only through the block (I-7).
 *  Per-pair, never cloud-synced (D-090 / D-097). */
export type NotificationSettings = NotificationSettingsBase &
  /** D-192 seam 10 — R31's two-axis `{ notification, approval }` mode, one per
   *  credential-backed channel (every declared chat transport + email). Keyed off
   *  the registry, so a new transport gets its toggles with no edit here. Both
   *  axes opt-in, default `false`; enabling either is readiness-gated on a
   *  `connection.notification` credential (D-158 A.6). */
  Record<NotificationCredentialChannel, ChannelModeSettings>;

interface NotificationSettingsBase {
  /** Always-on (N.4) — the literal `true` makes the invariant a type. */
  ui: true;
  /** D-163 N.4 — Bridge as a first-class togglable channel. Notify-only
   *  (D-163 N.1), so a single boolean — the channel-level group enable
   *  gating whether any bridge fan-out happens. Opt-in; default `false`.
   *  Enabling is readiness-gated on a paired Bridge existing in the pair
   *  store. */
  bridge: boolean;
  /** D-158 P2b-ii — the anti-phishing verification phrase. A short
   *  user-set string the genuine server renders on the `ask` landing
   *  page (A.4 email channel); a static phishing clone of that page
   *  cannot know it, so a wrong / absent phrase is the user's soft-trust
   *  signal. Absent → the user set no phrase; the landing page renders
   *  no phrase block. Set in Settings → Notifications, block-owned (I-7),
   *  per-pair, never cloud-synced. */
  verification_phrase?: string;
  /** D-169 P1 — per-paired-bridge mode toggles, keyed on
   *  `client_tokens.token_id`. Each bridge instance the user paired
   *  appears as its own row in Settings → Notifications; both modes
   *  default `false` on a fresh pair (TR-8 — opt-in, not opt-out). The
   *  routing decision happens per ask raise (TR-12) so toggling takes
   *  effect immediately on the next ask. P1 ships the persistence + the
   *  Settings UI rows; P2 wires the routing decision to inspect this
   *  record (D-169 N.6 / I-10). Absent / unrecognised bridge ids are
   *  treated as both modes off; an unpair + re-pair starts at default
   *  (no setting persistence across un-pair / re-pair per N.6).
   *
   *  This field is OPTIONAL on stored rows so a row that pre-dates
   *  D-169 reads as the empty record; `createNotificationSettingsStore`
   *  merges over `DEFAULT_NOTIFICATION_SETTINGS` so the in-memory record
   *  always carries a non-undefined `bridges` map. */
  bridges?: Record<string, BridgeModeSettings>;
}

/** D-192 — a credential channel's THREE-axis mode flags. All default `false`.
 *  Mirrors `NotificationChannelModeRow` in contracts (the wire shape).
 *
 *  `notification` fans the one-way notify surface; `approval` delivers an ask to be
 *  answered here; `messenger` lets you hold a CONVERSATION here. The third axis is
 *  D-192's: it is what lets Discord (presses but no messages) and WhatsApp (messages
 *  but no unprompted reach) be DECLARED rather than described in prose.
 *
 *  ⚠ Turning a mode on is only ever a request — `CHANNEL_ROLES` decides whether the
 *  channel can do it at all, and the gates check support FIRST. */
export interface ChannelModeSettings {
  /** OS notification / message fan-out. Default `false`. */
  notification: boolean;
  /** Interactive ask delivery + first-answer-wins participation.
   *  Default `false`. */
  approval: boolean;
  /** Chat turns — you talk to Recued here. Default `false`. */
  messenger: boolean;
}

/** D-169 P1 — per-bridge mode toggles. TWO axes.
 *
 *  ⚠ D-192 — deliberately no longer an alias of `ChannelModeSettings`. A browser
 *  bridge renders notifications and approval cards; it is not somewhere you hold a
 *  conversation. While they were aliased, the third axis would have handed every
 *  paired bridge a meaningless `messenger` toggle — the alias was true by coincidence,
 *  and the coincidence ended.
 *
 *  Notification mode fans the OS notification + side-panel surface; approval mode
 *  treats the bridge channel as `'inline'` capability for ask fan-out (D-163 N.3 /
 *  D-169 N.6). With both off, the bridge is skipped entirely for any ask / notify the
 *  block dispatches (its DOM executor role is unaffected — this record gates
 *  user-visible notification fan-out only). */
export interface BridgeModeSettings {
  notification: boolean;
  approval: boolean;
}

/** Why a notification is being sent. A flow controller MAY pass a
 *  selector to *restrict* fan-out — by *intent*, never by channel name
 *  (N.7). P0 ships one always-on channel (`ui`) that serves every
 *  intent, so the selector does not yet discriminate; it becomes
 *  meaningful in P1/P2 once the settings record gates a multi-channel
 *  set. The type is fixed now so the N.2 `notify` / `ask` surface is
 *  stable for D-157. */
export interface ChannelSelector {
  /** `interactive` — a decision the user must make; `informational` —
   *  a fire-and-forget update. */
  intent: 'interactive' | 'informational';
}

/** Lifecycle of a persisted `ask` (A.2). P0 ships three states; D-158
 *  P3 adds `'stale'` together with the optional staleness guard that
 *  produces it.
 *   - `open`     — delivered (or pending delivery), awaiting an answer
 *   - `answered` — an answer is durably recorded; `on_answer` dispatch
 *                  is pending or has failed and will be retried on boot
 *   - `handled`  — `on_answer` ran to completion (terminal) */
export type PendingAskStatus = 'open' | 'answered' | 'handled';

/** A durable pending-ask row (A.2). Persisted before any delivery so an
 *  outstanding ask survives a server crash / restart (I-2). Per-pair,
 *  never cloud-synced (D-090 / D-097). */
export interface PendingAsk {
  ask_id: string;
  message: NotificationMessage;
  options: readonly AskOption[];
  /** The persisted handler reference — kind + JSON payload, never a
   *  closure (I-4). */
  handler_kind: AskHandlerKind;
  handler_payload: Record<string, unknown>;
  /** The channels this ask was fanned out to — the close-broadcast
   *  target set. Persisted with the ask at `create`, BEFORE any
   *  delivery: the spec's A.2 records it *after* delivery, but that
   *  post-delivery write is a read-modify-write that races a fast
   *  inbound reply (it can clobber a recorded answer back to `open`).
   *  Persisting the resolved fan-out set up front removes the race.
   *  It is the *attempted* set — a channel whose transport delivery
   *  failed stays listed; closing it later is a harmless idempotent
   *  no-op (`Channel.closeAsk` contract). */
  fanout_channels: ChannelName[];
  status: PendingAskStatus;
  /** Unix-ms the ask was minted + persisted. */
  created_at: number;
  /** D-234 § 234.4e — does this ask invite a written reason, and is one
   *  required? Absent ⇒ the surface renders no note field and any note on a
   *  reply is dropped.
   *
   *  ⛔ OPT-IN, NOT ALWAYS-ON. Rendering a free-text box on every approval card
   *  would train people to explain routine decisions nobody reads, and the field
   *  costs a durable row per answer. An ask asks for prose when the prose is the
   *  point — a peer review's reasoning — and stays a two-tap decision otherwise.
   *
   *  ⚠ `'required'` is enforced by the SURFACE, not by the block: a reply that
   *  arrives without one is treated as invalid and no-ops, exactly as an
   *  unoffered option does, so a surface that ignores the flag cannot record a
   *  half-answer. */
  note_prompt?: AskNotePrompt;
  /** D-234 § 234.4f — the document behind the question. Persisted WITH the ask,
   *  so it lives and dies with the conversation and needs no second store or
   *  eviction rule. ⛔ Never copied into `message` — see {@link AskExtras}. */
  body?: string;
  /** Recorded once `status` leaves `open`. */
  answer?: Answer;
  /** Provenance — which channel the winning answer arrived on (A.2
   *  step 6). Recorded for audit; never surfaced to the caller (I-10). */
  answered_via?: ChannelName;
}

/** An authenticated inbound reply funnelled into the block from a
 *  channel's inbound path. The `ui` channel's replies arrive over the
 *  pair-authenticated D-121 bus; D-158 P2's remote channels authenticate
 *  via D-148 P9 inbound auth (I-9) before constructing one. The block
 *  trusts an `InboundReply` it is handed — authentication is the
 *  channel inbound path's responsibility, upstream of this funnel. */
export interface InboundReply {
  ask_id: string;
  /** The chosen `AskOption.id`. */
  option: string;
  /** Which channel the reply arrived on. */
  via: ChannelName;
  /** D-234 § 234.4e — free text, when the ask offered a note prompt. A note on
   *  an ask that did not offer one is DROPPED, not refused: the option is the
   *  decision and it is already valid, and failing a recorded decision over an
   *  extra field is TR-4's forbidden failure. */
  note?: string;
}

/** What the block hands its audit seam when an ask is answered.
 *
 *  🔑 WHY THE BLOCK AUDITS THIS AND NOT THE HANDLER. `dispatchAnswer`
 *  deliberately strips channel identity before the `on_answer` handler runs
 *  (I-10) — the handler learns the option, never the surface. So the block
 *  is the ONLY place that knows `answered_via`, and an audit written
 *  downstream can never recover it.
 *
 *  This carries the DECISION FACTS, not the rendered prose. The prompt text
 *  is a rendering of context the run anchor already holds; the option
 *  chosen, the channel it came from, and the moment it happened are not
 *  derivable from anywhere else once the ask row is gone. */
export interface AnswerAuditRecord {
  ask_id: string;
  /** Which handler the ask was raised for — `gateway.preflight` for an
   *  approval gate. Lets a reader tell an approval from any other ask
   *  kind without re-reading the (possibly pruned) row. */
  handler_kind: AskHandlerKind;
  /** The chosen `AskOption.id` (`approve` / `deny` / `allow_session`). */
  option: string;
  /** The option's LABEL — what the user actually read. The id is a token;
   *  the label is the human fact, and a pack may relabel an id. */
  option_label: string;
  /** The ask's one-line title, when it had one — what named the decision
   *  in the notification the user acted on. */
  title?: string;
  answered_at: number;
  answered_via: ChannelName;
  /** FN-2 — the ask's own `handler_payload`, passed through UNINTERPRETED.
   *
   *  ⛔ WHY A PASS-THROUGH AND NOT PARSED FIELDS. This block treats
   *  `handler_kind` as "an opaque registry key" and never interprets a
   *  payload — that is the layering that lets any consumer register any ask
   *  kind. Reading `run_id` out of it HERE would make the leaf understand
   *  `gateway.preflight`, which it must not. So the payload travels and the
   *  HOST — which already knows the preflight shape — extracts identity.
   *
   *  🔑 WHAT IT FIXES. `approval_allow` / `approval_deny` are reserve-class
   *  and outlive normal retention, but the row's only pointer was `ask_id`,
   *  aimed at a `PendingAsk` that `pruneHandled` deletes, while the run
   *  anchor's back-pointer is overwritten on resume (`auditLog.append` is
   *  `set(run_id, …)`). The one durable record of what the owner decided
   *  could not be joined to what they decided ABOUT. */
  handler_payload?: Record<string, unknown>;
}
