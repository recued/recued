/** D-163 Slice C + R31 — Settings → Approval & notifications panel.
 *
 *  Surfaces the 5-row channel matrix per spec § A.5 / § N.6 — `ui`,
 *  `bridge`, `slack`, `telegram`, `email`. Each row carries:
 *    - the channel's display name
 *    - a capability badge in DELIVERY language (Answer here / Answer via
 *      link / Notify only) per § N.6 — R31 reframe of the pre-R31
 *      "Inline approvals / Approvals via link / Notifications only" copy
 *    - the readiness state (ready / not-ready + install/connect CTA; the
 *      credential-backed remotes deep-link `#connections`, email renders
 *      a 3-step setup guide)
 *    - R31 — TWO axis cells (Notify | Approvals) instead of one enabled
 *      toggle. `ui` is fixed-on on both (the approval floor); notify-only
 *      channels (`bridge`) disable the approval cell (can't carry an ask).
 *  Plus a panel-level anti-phishing verification-phrase field (D-158
 *  P2b-ii — the rpc existed; R31 surfaces the editor).
 *
 *  ── Three exports ──────────────────────────────────────────────────
 *    - `mountNotificationsPanel(opts)` — DOM-construction mount.
 *      Returns a handle with `dispose()` / `getRows()` + test seams.
 *      Kicks off `runDescribe` on mount + manages its own state machine.
 *    - `NOTIFICATIONS_PANEL_STYLES` — self-scoped CSS the host injects
 *      once at boot (mirrors the SI panel's style export).
 *    - `NOTIFICATIONS_PANEL_*_ATTR` — stable hooks for DOM-based tests.
 *
 *  ── State machine ──────────────────────────────────────────────────
 *
 *      mount ── runDescribe resolved ──▶ ready
 *      mount ── runDescribe threw     ──▶ error
 *      error ── click Retry           ──▶ loading ── … ──▶ ready | error
 *
 *  Per-row:
 *      ready ── click Toggle ──▶ row toggling (ARIA guarded, label "…")
 *      row toggling ── runSetChannel ok:true   ──▶ refresh (rows reload)
 *      row toggling ── runSetChannel ok:false  ──▶ row error chip surfaces
 *      row toggling ── runSetChannel threw     ──▶ row error chip surfaces
 *
 *  ── Key design decisions (READ before touching) ────────────────────
 *
 *  DD#1 — Caller seams are narrow Promise functions, not a baked-in
 *  `Conn<ServerRpcRegistry>` reference. The route wires the rpc conn
 *  through two thunks (`runDescribe` / `runSetChannel`); tests inject
 *  fakes. Same pattern as the SI panel's DD#1.
 *
 *  DD#2 — `ok: false` SetChannelResult variants (`ui_fixed`,
 *  `not_ready`) are NOT thrown — the rpc handler returns them as data.
 *  The panel surfaces them inline on the row's error chip. A thrown rpc
 *  error (network drop, `not_configured`, `bad_request`) also lands on
 *  the row's error chip — both paths converge.
 *
 *  DD#3 — Render-on-transition rebuild. Same pattern as the SI panel
 *  + the TLS renew panel + the Privacy panel. Every state change
 *  rebuilds the panel's inner DOM via `createElement` + new event
 *  listeners — no diffing, no virtual-DOM, no surprise re-attachments.
 *
 *  DD#4 — Toggling on a not-ready row is allowed AT THE UI LAYER (the
 *  button is enabled + clickable) so the rpc's `not_ready` rejection
 *  is the source of truth + the inline CTA path stays exercised. A
 *  best-effort UX nudge would be to disable the toggle when ready =
 *  false, but that would (a) duplicate the readiness gate, (b) make
 *  the install CTA the only way to "do anything" on the row which is
 *  awkward when the user just wants to toggle off a previously-ready
 *  channel that went stale. The rpc owns the gate.
 *
 *  DD#5 — Fixed display order matches the substrate's `describe()`
 *  output order (`ui` first, then `bridge`, then credential-backed
 *  remotes). The panel does NOT re-sort — the substrate is the
 *  source of truth for row order so a future reshape lands once.
 *
 *  Spec: D-163 § N.5 / N.6 / A.5. */

import type {
  NotificationBridgeModeRow,
  NotificationBridgeRow,
  NotificationChannelCapability,
  NotificationChannelModeRow,
  NotificationChannelName,
  NotificationChannelToggleView,
  NotificationSetBridgeModeResult,
  NotificationSetChannelResult,
  NotificationSetVerificationPhraseResult,
} from '@recued/contracts';
import {
  MESSENGER_VENDOR_SLUGS,
  getMessengerVendorDeclaration,
} from '@recued/contracts';

import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Local type aliases
// ════════════════════════════════════════════════════════════════

/** D-169 P1 — the two bridge mode field names. Kept as a string-literal
 *  union (not `keyof NotificationBridgeModeRow`) so template-literal
 *  coercions (`${id}::${mode}`) and `setAttribute` calls type-check
 *  without `String(...)` wrappers. */
type BridgeModeName = 'notification' | 'approval';

/** R31 — the two channel-level axis names (Notify / Approvals columns).
 *  Structurally the same union as `BridgeModeName` — the per-bridge
 *  sub-rows and the channel-level rows share one axis vocabulary + one
 *  `{ notification, approval }` patch shape. */
type ChannelAxis = 'notification' | 'approval';

// ════════════════════════════════════════════════════════════════
// Attribute constants — stable hooks for DOM tests
// ════════════════════════════════════════════════════════════════

export const NOTIFICATIONS_PANEL_ATTR = 'data-recued-notifications-panel';
export const NOTIFICATIONS_PANEL_STATE_ATTR =
  'data-recued-notifications-panel-state';
export const NOTIFICATIONS_RETRY_BTN_ATTR =
  'data-recued-notifications-retry';
export const NOTIFICATIONS_ROW_ATTR = 'data-recued-notifications-row';
export const NOTIFICATIONS_ROW_CHANNEL_ATTR =
  'data-recued-notifications-row-channel';
export const NOTIFICATIONS_ROW_TOGGLE_BTN_ATTR =
  'data-recued-notifications-row-toggle';
/** R31 — the axis (`notification` / `approval`) a channel-row toggle or
 *  cell drives. Stamped on the toggle button + the cell wrapper + the
 *  fixed indicator so tests target one axis without coupling to layout. */
export const NOTIFICATIONS_AXIS_ATTR = 'data-recued-notifications-axis';
export const NOTIFICATIONS_AXIS_CELL_ATTR =
  'data-recued-notifications-axis-cell';
/** R31 — a non-togglable axis cell: the always-on floor (`ui`) or a
 *  notify-only channel's unavailable approval cell. */
export const NOTIFICATIONS_AXIS_FIXED_ATTR =
  'data-recued-notifications-axis-fixed';
/** R31 — the panel-level anti-phishing verification-phrase field. */
export const NOTIFICATIONS_PHRASE_INPUT_ATTR =
  'data-recued-notifications-phrase-input';
export const NOTIFICATIONS_PHRASE_SAVE_ATTR =
  'data-recued-notifications-phrase-save';
export const NOTIFICATIONS_PHRASE_ERROR_ATTR =
  'data-recued-notifications-phrase-error';
export const NOTIFICATIONS_ROW_INSTALL_LINK_ATTR =
  'data-recued-notifications-row-install';
/** R31 slice 1 — in-app deep-link to `#connections` on a not-ready
 *  credential-backed channel (slack / telegram). Replaces the stale
 *  "via Settings → Connections" text hint (the route graduated to the
 *  top-level `#connections` in R13–R16). */
export const NOTIFICATIONS_ROW_CONNECT_LINK_ATTR =
  'data-recued-notifications-row-connect';
/** R31 slice 1 — the email channel's 3-step setup instruction list,
 *  rendered in place of a single CTA while email is not-ready (its
 *  Path-A wiring is a follow-on slice; the row stays visible with the
 *  instruction, never hidden). */
export const NOTIFICATIONS_EMAIL_STEPS_ATTR =
  'data-recued-notifications-email-steps';
export const NOTIFICATIONS_ROW_ERROR_ATTR =
  'data-recued-notifications-row-error';
export const NOTIFICATIONS_LIST_ERROR_ATTR =
  'data-recued-notifications-list-error';
/** D-169 P1 — per-bridge sub-row group under the channel-level
 *  Browser Bridge toggle. One row per paired bridge with the bridge's
 *  client_token_id stamped on the `data-…-bridge-row` attribute. */
export const NOTIFICATIONS_BRIDGE_ROW_ATTR =
  'data-recued-notifications-bridge-row';
export const NOTIFICATIONS_BRIDGE_MODE_BTN_ATTR =
  'data-recued-notifications-bridge-mode-btn';
export const NOTIFICATIONS_BRIDGE_MODE_ATTR =
  'data-recued-notifications-bridge-mode';
export const NOTIFICATIONS_BRIDGE_ROW_ERROR_ATTR =
  'data-recued-notifications-bridge-row-error';
export const NOTIFICATIONS_BRIDGE_EMPTY_ATTR =
  'data-recued-notifications-bridge-empty';

// ════════════════════════════════════════════════════════════════
// Caller seams + handle
// ════════════════════════════════════════════════════════════════

export type NotificationsDescribeCaller = () => Promise<{
  rows: ReadonlyArray<NotificationChannelToggleView>;
  /** R31 — the current anti-phishing verification phrase, so the panel
   *  can render + edit it as a panel-level setting. Absent when unset. */
  verification_phrase?: string;
}>;

/** R31 — `notifications.set_channel` is an axis patch (was a single
 *  `enabled` boolean): toggle the notification and / or approval axis of
 *  one channel; an absent field preserves its prior value. */
export type NotificationsSetChannelCaller = (args: {
  channel: NotificationChannelName;
  patch: Partial<NotificationChannelModeRow>;
}) => Promise<NotificationSetChannelResult>;

/** R31 — `notifications.set_verification_phrase` caller seam. Optional on
 *  the mount; absent ⇒ the phrase field renders read-only guidance. */
export type NotificationsSetVerificationPhraseCaller = (args: {
  phrase: string | null;
}) => Promise<NotificationSetVerificationPhraseResult>;

/** D-169 P1 — `notifications.describe_bridges` caller seam. */
export type NotificationsDescribeBridgesCaller = () => Promise<{
  rows: ReadonlyArray<NotificationBridgeRow>;
}>;

/** D-169 P1 — `notifications.set_bridge_mode` caller seam. */
export type NotificationsSetBridgeModeCaller = (args: {
  bridge_id: string;
  patch: Partial<NotificationBridgeModeRow>;
}) => Promise<NotificationSetBridgeModeResult>;

export type NotificationsPanelState = 'loading' | 'ready' | 'error';

export interface MountNotificationsPanelOptions {
  /** Host element the panel renders into. The panel appends a single
   *  wrapper div + rebuilds its inner contents across state changes.
   *  `dispose()` drops the wrapper. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  /** `notifications.describe` caller seam (DD#1). */
  runDescribe: NotificationsDescribeCaller;
  /** `notifications.set_channel` caller seam (DD#1). */
  runSetChannel: NotificationsSetChannelCaller;
  /** D-169 P1 — `notifications.describe_bridges` caller seam. Optional;
   *  absent ⇒ the per-bridge sub-row group never renders (legacy
   *  pre-D-169 surface). Present ⇒ the bridge channel section gains a
   *  sub-row group showing one row per paired bridge. */
  runDescribeBridges?: NotificationsDescribeBridgesCaller;
  /** D-169 P1 — `notifications.set_bridge_mode` caller seam. Required
   *  when `runDescribeBridges` is present (the bridge rows are
   *  interactive). */
  runSetBridgeMode?: NotificationsSetBridgeModeCaller;
  /** R31 — `notifications.set_verification_phrase` caller seam. When
   *  present, the panel renders an editable anti-phishing phrase input
   *  (a panel-level setting, shown on every ask so the user can tell a
   *  genuine Recued message from a phishing clone). Absent ⇒ read-only. */
  runSetVerificationPhrase?: NotificationsSetVerificationPhraseCaller;
  /** D-169 P2 Slice 4 follow-on — live broadcast subscription seam.
   *  When provided alongside `runDescribeBridges`, the mount subscribes
   *  to `notification.bridge_mode_changed` on creation and splices the
   *  event's inline post-change `modes` into the matching per-bridge row
   *  (keyed on `client_token_id`) — no `describe_bridges` refetch, no
   *  loading flash. This is what makes a bridge-mode toggle on another
   *  paired client (or the bridge's own surface) reflect live in this
   *  client's per-bridge rows, mirroring the bridge SW's own re-read of
   *  its self-scoped mode. Unsubscribes on dispose. Optional: omitting it
   *  (or omitting `runDescribeBridges`, since there'd be no rows to
   *  update) keeps the panel on the mount + retry + post-toggle-refresh
   *  cadence — used by the read-only test paths + pre-D-169 layouts. */
  subscribe?: BroadcastSubscriber['on'];
}

export interface NotificationsPanelMount {
  /** Current panel state — primary surface for tests + host introspection. */
  getState(): NotificationsPanelState;
  /** Currently-rendered rows in display order. Empty when state != `ready`. */
  getRows(): ReadonlyArray<NotificationChannelToggleView>;
  /** R31 — pending per-axis toggles, keyed on `${channel}::${axis}` so
   *  the panel can disable just the in-flight cell (not the whole row). */
  getTogglingAxes(): ReadonlySet<string>;
  /** Per-row toggle error messages by channel (one error line per row). */
  getRowError(channel: NotificationChannelName): string | undefined;
  /** Top-level list error message. Null when state != `error`. */
  getListError(): string | null;
  /** User-started writes that have not settled yet. Initial/background reads
   * are deliberately excluded so route navigation is guarded only by work the
   * owner explicitly started. */
  hasInFlightWork(): boolean;
  /** Whether the verification phrase differs from the last authoritative
   * value. Used by the Settings route's leave and beforeunload guards. */
  hasUnsavedChanges(): boolean;
  /** Host-driven refresh — re-issues `runDescribe`. Use after a known
   *  notification-settings mutation happens elsewhere (e.g. a connection
   *  enrolment that flips a row's readiness). */
  refresh(): void;
  /** Initial load promise — resolves after the first `runDescribe`
   *  settles (success → `ready`, failure → `error`). Subsequent
   *  `refresh()` calls also update the tracked promise. */
  whenLoaded(): Promise<void>;
  /** Tear down the panel DOM + remove event listeners. Idempotent. */
  dispose(): void;
  /** Test-only: drive the error → loading retry transition. */
  clickRetry(): void;
  /** R31 — drive one axis cell's toggle on a channel row. Awaits the
   *  in-flight rpc. */
  clickAxis(
    channel: NotificationChannelName,
    axis: ChannelAxis,
  ): Promise<void>;
  /** R31 — current verification-phrase input value (panel-level setting). */
  getVerificationPhrase(): string;
  /** R31 — phrase save error message (`too_long` / network), or undefined. */
  getPhraseError(): string | undefined;
  /** R31 — test-only: set the phrase input + save it. Awaits the rpc. */
  savePhrase(next: string): Promise<void>;
  /** D-169 P1 — per-bridge sub-row group state surfaces. Tests read
   *  these to assert the per-bridge rows match the rpc snapshot + the
   *  mode toggles drove the right `set_bridge_mode` payload. */
  getBridgeRows(): ReadonlyArray<NotificationBridgeRow>;
  /** D-169 P1 — per-bridge-row pending toggles, keyed on
   *  `(client_token_id, mode_name)` so the panel can disable both
   *  buttons of the in-flight row simultaneously. */
  getBridgeRowToggling(): ReadonlySet<string>;
  /** D-169 P1 — per-bridge row error message; surfaces an
   *  `bridge_unknown` outcome or a network drop inline. */
  getBridgeRowError(client_token_id: string): string | undefined;
  /** D-169 P1 — test affordance: click a bridge row's mode toggle. */
  clickBridgeMode(
    client_token_id: string,
    mode: BridgeModeName,
  ): Promise<void>;
}

// ════════════════════════════════════════════════════════════════
// Copy
// ════════════════════════════════════════════════════════════════

const COPY = {
  loading: 'Loading notification channels…',
  error_heading: 'Could not load notification channels.',
  toggling_label: 'Updating…',
  enabled_label: 'On',
  disabled_label: 'Off',
  fixed_on_label: 'Always on',
  not_ready_label: 'Not set up',
  retry_label: 'Retry',
  retrying_label: 'Retrying…',
  // CTA labels — Bridge ships with an external install URL; the
  // credential-backed remotes deep-link the top-level `#connections`
  // route (R13–R16 graduated it out of Settings). Email uses the
  // 3-step instruction block instead of a single CTA.
  install_bridge: 'Install Browser Bridge',
  connect_in_connections: 'Connect in Connections',
  // R31 slice 1 — email's 3-step setup instruction (Path-A is a
  // follow-on slice; the row stays with the instruction, never hidden).
  email_step_1: 'Add a mail account in Connections',
  email_step_2: 'Pick it as the email sender',
  email_step_3: 'Enable email here — approvals arrive as a link',
  // R31 slice 2 — the two-axis matrix column labels + the fixed-cell
  // states (an unavailable approval cell on a notify-only channel).
  axis_notify: 'Notify',
  axis_approvals: 'Approvals',
  axis_na: '—',
  axis_na_hint: 'Notify only — approvals are answered in the webclient.',
  // R31 slice 2 — the panel-level anti-phishing verification phrase.
  phrase_heading: 'Anti-phishing phrase',
  phrase_hint:
    'Shown on every message Recued sends — a phrase only you know, so you can tell a genuine message from a phishing copy.',
  phrase_placeholder: 'e.g. purple otter',
  phrase_save: 'Save',
  phrase_saving: 'Saving…',
} as const;

// ════════════════════════════════════════════════════════════════
// Presentation tables
// ════════════════════════════════════════════════════════════════

/** Per-channel display name. The substrate ships internal channel slugs
 *  (`ui` / `bridge` / etc.); this Record turns them into the strings the
 *  user reads. Still a closed Record over the literal union, so a new
 *  STRUCTURAL channel breaks it at compile time and forces a render decision.
 *
 *  D-192 seam 10 — a chat transport already declares the string the user should
 *  read (`MessengerVendorDeclaration.display_name`), so those rows derive rather
 *  than being re-typed here where they could drift from the enroll card and the
 *  connection picker (which read the same field). */
const CHANNEL_DISPLAY_NAME: Record<NotificationChannelName, string> = {
  ui: 'Webclient cards',
  bridge: 'Browser Bridge OS',
  email: 'Email',
  ...Object.fromEntries(
    MESSENGER_VENDOR_SLUGS.map((vendor) => [
      vendor,
      getMessengerVendorDeclaration(vendor)?.display_name ?? vendor,
    ]),
  ),
} as Record<NotificationChannelName, string>;

/** Per-capability badge presentation. The substrate's three
 *  `NotificationChannelCapability` classes each map to a fixed badge
 *  label + tone class. Closed Record forces an exhaustive render
 *  decision per D-163 N.1.
 *
 *  R31 (defect #3) — the copy reads as DELIVERY, not as the approval
 *  queue: what CAN this channel do with an ask? "Answer here" (inline —
 *  renders the buttons in-surface), "Answer via link" (landing-page —
 *  delivers a one-link ask page), "Notify only" (can't carry an ask at
 *  all). The three tones render three DISTINCT looks — pre-R31 `inline`
 *  and `landing-page` shared the identical accent pill, so the user
 *  couldn't tell can-answer-here from can-answer-via-link apart. */
const CAPABILITY_PRESENTATION: Record<
  NotificationChannelCapability,
  { label: string; tone: 'inline' | 'landing-page' | 'notify-only' }
> = {
  'inline':        { label: 'Answer here',     tone: 'inline' },
  'landing-page':  { label: 'Answer via link', tone: 'landing-page' },
  'notify-only':   { label: 'Notify only',     tone: 'notify-only' },
};

/** Per-channel not-ready CTA label. Bridge ships an external
 *  `install_url`; a chat transport deep-links the in-app `#connections`
 *  route (empty here would suppress the link). Email is `''` — it
 *  renders the 3-step instruction block instead of a single CTA. The
 *  `ui` entry never renders because `ui` is always-ready by construction.
 *
 *  D-192 seam 10 — every chat transport enrolls through the SAME
 *  Settings → Connections route, so its CTA was never per-vendor knowledge,
 *  just an enumeration. It derives. */
const NOT_READY_CTA_LABEL: Record<NotificationChannelName, string> = {
  ui: '',
  bridge: COPY.install_bridge,
  email: '',
  ...Object.fromEntries(
    MESSENGER_VENDOR_SLUGS.map((vendor) => [vendor, COPY.connect_in_connections]),
  ),
} as Record<NotificationChannelName, string>;

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

/** Mount the panel into `opts.host`. Kicks off the initial `runDescribe`
 *  call; the panel renders `loading` until it resolves. */
export const mountNotificationsPanel = (
  opts: MountNotificationsPanelOptions,
): NotificationsPanelMount => {
  const doc = opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountNotificationsPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  // ── State ────────────────────────────────────────────────────────
  let state: NotificationsPanelState = 'loading';
  let disposed = false;
  let rows: NotificationChannelToggleView[] = [];
  let listError: string | null = null;
  /** R31 — pending per-axis toggles, keyed on `${channel}::${axis}` so a
   *  notification toggle and an approval toggle on the same row can be
   *  in flight independently (only the clicked cell disables). */
  const togglingAxes = new Set<string>();
  /** R31 — per-AXIS error messages, keyed on `${channel}::${axis}`. Axis-
   *  keyed (not channel-keyed) so a success on one axis of a row can't
   *  clear a concurrent failure on the other axis; the row renders the
   *  first non-empty of its two axes. */
  const rowErrors = new Map<string, string>();
  /** R31 — panel-level anti-phishing verification phrase. Seeded from
   *  `describe`, edited inline, persisted via `runSetVerificationPhrase`. */
  let verificationPhrase = '';
  /** Last authoritative phrase observed from describe/save. Kept separate
   * from the draft so typing back to the saved value clears dirty state. */
  let persistedVerificationPhrase = '';
  /** True once the user edits the phrase input — suppresses re-seeding
   *  from a `describe` refresh so an unsaved edit isn't clobbered.
   *  Cleared on a successful save. */
  let phraseDirty = false;
  let phraseError: string | undefined;
  let phraseSaving = false;
  let pendingPhrasePromise: Promise<void> | null = null;
  let pendingPhraseSaveFocus = false;
  let renderedPhraseSave: HTMLButtonElement | undefined;
  let renderedPhraseInput: HTMLInputElement | undefined;
  /** Most-recent `runDescribe` promise, exposed via `whenLoaded()`. */
  let pendingDescribePromise: Promise<void> = Promise.resolve();
  let retryTransition = false;
  let pendingRetryFocus = false;
  let renderedRetryButton: HTMLButtonElement | undefined;
  /** D-169 P2 Slice 4 follow-on — broadcast unsubscribe handles, dropped
   *  on dispose. Holds the `notification.bridge_mode_changed` listener
   *  when `subscribe` + `runDescribeBridges` are both wired. */
  const unsubscribes: Array<() => void> = [];

  // D-169 P1 — per-bridge sub-row state. The rows are fetched alongside
  // the channel rows (one `describe_bridges` call paired with each
  // `describe`); per-row toggles fire `set_bridge_mode` calls.
  let bridgeRows: NotificationBridgeRow[] = [];
  /** D-169 P2 Slice 4 follow-on — monotonic generation guarding every
   *  bridge-roster read (`refreshRows`'s inline fetch + the event-driven
   *  `reloadBridgeRows`). Bumped before each read; a read applies its rows
   *  only if its captured generation is still current, so an
   *  event-triggered reload supersedes an in-flight (now-stale) load
   *  instead of being clobbered by it. Mirrors the asks / packs /
   *  cache-card `loadGeneration` DD. */
  let bridgeLoadGeneration = 0;
  const bridgeRowToggling = new Set<string>(); // keys: `${token_id}::${mode}`
  const bridgeRowErrors = new Map<string, string>(); // keys: client_token_id
  const pendingBridgeTogglePromises = new Map<string, Promise<void>>();
  const bridgeToggleKey = (
    client_token_id: string,
    mode: BridgeModeName,
  ): string => `${client_token_id}::${mode}`;
  let pendingBridgeFocus: string | null = null;
  let renderedBridgeButtons = new Map<string, HTMLButtonElement>();
  const focusedBridgeKey = (
    element: Element | null | undefined,
  ): string | null => {
    const bridgeId = element?.getAttribute?.(NOTIFICATIONS_BRIDGE_MODE_BTN_ATTR);
    const mode = element?.getAttribute?.(NOTIFICATIONS_BRIDGE_MODE_ATTR);
    return bridgeId === null || bridgeId === undefined
      || (mode !== 'notification' && mode !== 'approval')
      ? null
      : `${bridgeId}::${mode}`;
  };
  /** R31 — per-axis in-flight `runSetChannel` promises, keyed on
   *  `${channel}::${axis}`. Re-entry through the click handler returns
   *  the existing in-flight promise rather than starting a duplicate
   *  toggle — same discipline as the per-bridge toggles. */
  const pendingTogglePromises = new Map<string, Promise<void>>();
  /** Exact channel-axis control that initiated a mutation. The panel rebuilds
   *  on every transition, so this identity—not the detached element—owns
   *  focus until success/failure unless the owner deliberately moves away. */
  let pendingAxisFocus: string | null = null;
  let renderedAxisButtons = new Map<string, HTMLButtonElement>();
  const channelAxisKey = (
    channel: NotificationChannelName,
    axis: ChannelAxis,
  ): string => `${channel}::${axis}`;
  const focusedAxisKey = (element: Element | null | undefined): string | null => {
    const channel = element?.getAttribute?.(NOTIFICATIONS_ROW_TOGGLE_BTN_ATTR);
    const axis = element?.getAttribute?.(NOTIFICATIONS_AXIS_ATTR);
    return channel === null || channel === undefined
      || (axis !== 'notification' && axis !== 'approval')
      ? null
      : `${channel}::${axis}`;
  };
  /** R31 — the row's error to render: the first non-empty of its two
   *  axis-keyed errors (the row shows one chip, but each axis owns its
   *  own error so a success on one can't clear the other's failure). */
  const rowErrorFor = (
    channel: NotificationChannelName,
  ): string | undefined =>
    rowErrors.get(channelAxisKey(channel, 'notification'))
    ?? rowErrors.get(channelAxisKey(channel, 'approval'));

  // ── Wrapper ──────────────────────────────────────────────────────
  const wrapper = doc.createElement('div');
  wrapper.setAttribute(NOTIFICATIONS_PANEL_ATTR, '');
  wrapper.setAttribute(NOTIFICATIONS_PANEL_STATE_ATTR, state);
  wrapper.className = 'notif-panel';
  opts.host.appendChild(wrapper);

  // ── Transitions ──────────────────────────────────────────────────
  const transitionTo = (
    next: NotificationsPanelState,
    force = false,
  ): void => {
    if (disposed) return;
    if (!force && state === next) return;
    state = next;
    wrapper.setAttribute(NOTIFICATIONS_PANEL_STATE_ATTR, state);
    render();
  };

  const refreshRows = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    listError = null;
    rowErrors.clear();
    bridgeRowErrors.clear();
    transitionTo('loading');
    const promise = (async () => {
      try {
        // D-169 P1 — fetch channel rows + per-bridge sub-rows in
        // parallel when the bridge-roster caller is wired. A failure on
        // the bridge fetch surfaces inline at the bridge row group (the
        // channel rows still render); a failure on the channel fetch
        // is the panel-wide error path.
        const bridgeGen = opts.runDescribeBridges
          ? ++bridgeLoadGeneration
          : 0;
        const bridgePromise = opts.runDescribeBridges
          ? opts.runDescribeBridges().catch((err: unknown) => ({
              __error__: humanizeRpcError(err),
            }))
          : null;
        const result = await opts.runDescribe();
        if (disposed) return;
        rows = [...result.rows];
        // R31 — seed the phrase input from the authoritative record, but
        // never over an unsaved user edit (a refresh mid-typing keeps the
        // draft). Always advance the comparison baseline: if an external
        // write happens to match the local draft, it is no longer unsaved.
        persistedVerificationPhrase = result.verification_phrase ?? '';
        if (!phraseDirty) {
          verificationPhrase = persistedVerificationPhrase;
        } else {
          phraseDirty = verificationPhrase !== persistedVerificationPhrase;
        }
        if (bridgePromise) {
          const br = await bridgePromise;
          if (disposed) return;
          // Skip if an event-triggered `reloadBridgeRows` (or a newer
          // refresh) superseded this read while it was in flight — don't
          // clobber the fresher roster with our now-stale snapshot. This
          // closes the mount/retry race where a `bridge_mode_changed`
          // arriving mid-load would otherwise be lost + overwritten.
          if (bridgeGen === bridgeLoadGeneration) {
            if ('__error__' in br) {
              bridgeRows = [];
              // Surface as a list-error-shaped string but only on the
              // bridge group — the channel rows render normally.
              bridgeRowErrors.set('', br.__error__);
            } else {
              bridgeRows = [...br.rows];
            }
          }
        } else {
          bridgeRows = [];
        }
        transitionTo('ready');
      } catch (err) {
        if (disposed) return;
        listError = humanizeRpcError(err);
        transitionTo('error');
      }
    })();
    pendingDescribePromise = promise;
    return promise;
  };

  /** Splice a post-change `modes` snapshot into the matching bridge row
   *  in place — no re-fetch. Returns true iff a row matched (the caller
   *  decides whether to re-render). Shared by the local-toggle success
   *  path (D-169 P1) + the live `notification.bridge_mode_changed`
   *  handler (D-169 P2 Slice 4) so both stay in lockstep: a partial patch
   *  (the toggle's `set_bridge_mode` result row) and a full snapshot (the
   *  event's inline `modes`) are both merged the same way. An event for a
   *  bridge not in the current roster matches nothing → returns false so
   *  the caller skips a needless rebuild (the bridge surfaces on the next
   *  full `describe_bridges` fetch). */
  const applyBridgeModes = (
    client_token_id: string,
    modes: Partial<NotificationBridgeModeRow>,
  ): boolean => {
    let matched = false;
    bridgeRows = bridgeRows.map((r) => {
      if (r.client_token_id !== client_token_id) return r;
      matched = true;
      return { ...r, modes: { ...r.modes, ...modes } };
    });
    return matched;
  };

  /** D-169 P2 Slice 4 follow-on — re-read the authoritative bridge roster
   *  out-of-band (no panel-wide loading flash; the channel rows stay put),
   *  generation-guarded so the freshest read wins. Used by the live
   *  `bridge_mode_changed` handler when the event names a bridge not in
   *  the current roster — either the initial `refreshRows` load hasn't
   *  resolved yet (so an in-place splice would be lost, then overwritten
   *  by the in-flight stale read) or the bridge was paired after our last
   *  fetch. Because this reload is initiated AFTER the event arrived, its
   *  read reflects the event's change (and any later ones); the generation
   *  bump discards any in-flight load so the stale snapshot can't clobber
   *  it. The render is gated on `state` like every other painter — when a
   *  channel load is still in flight (`state === 'loading'`) the fresh
   *  rows land in memory + surface at the eventual `transitionTo('ready')`. */
  const reloadBridgeRows = (): void => {
    if (disposed || !opts.runDescribeBridges) return;
    const gen = ++bridgeLoadGeneration;
    const run = opts.runDescribeBridges;
    void (async () => {
      try {
        const br = await run();
        if (disposed || gen !== bridgeLoadGeneration) return;
        bridgeRows = [...br.rows];
        bridgeRowErrors.delete('');
        render();
      } catch (err) {
        if (disposed || gen !== bridgeLoadGeneration) return;
        bridgeRows = [];
        bridgeRowErrors.set('', humanizeRpcError(err));
        render();
      }
    })();
  };

  /** D-169 P1 — drive one bridge row's mode toggle. Idempotent
   *  re-entry (matches `toggleRow`'s pattern): a click while the row
   *  is in-flight returns the in-flight promise rather than firing a
   *  duplicate toggle. */
  const toggleBridgeMode = (
    client_token_id: string,
    mode: BridgeModeName,
    nextEnabled: boolean,
  ): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (!opts.runSetBridgeMode) return Promise.resolve();
    const key = bridgeToggleKey(client_token_id, mode);
    const existing = pendingBridgeTogglePromises.get(key);
    if (existing !== undefined) return existing;
    bridgeRowToggling.add(key);
    bridgeRowErrors.delete(client_token_id);
    render();
    const setBridgeMode = opts.runSetBridgeMode;
    const promise = (async () => {
      try {
        const result = await setBridgeMode({
          bridge_id: client_token_id,
          patch: { [mode]: nextEnabled } as Partial<NotificationBridgeModeRow>,
        });
        if (disposed) return;
        if (result.ok === true) {
          // Refresh bridge rows locally — the rpc result carries the
          // new settings record; we can splice the new mode value into
          // the matching row without a re-fetch.
          const fresh = result.settings.bridges?.[client_token_id];
          if (fresh) applyBridgeModes(client_token_id, fresh);
          return;
        }
        // `ok: false` variants — surface inline on the bridge row.
        if (result.reason === 'bridge_unknown') {
          bridgeRowErrors.set(
            client_token_id,
            'This bridge was unpaired elsewhere. Refresh to update the list.',
          );
        }
      } catch (err) {
        if (disposed) return;
        bridgeRowErrors.set(
          client_token_id,
          humanizeRpcError(err),
        );
      } finally {
        bridgeRowToggling.delete(key);
        pendingBridgeTogglePromises.delete(key);
        if (!disposed) render();
      }
    })();
    pendingBridgeTogglePromises.set(key, promise);
    return promise;
  };

  const surfaceSetChannelResult = (
    channel: NotificationChannelName,
    axis: ChannelAxis,
    nextEnabled: boolean,
    result: NotificationSetChannelResult,
  ): void => {
    const errKey = channelAxisKey(channel, axis);
    if (result.ok === true) {
      rowErrors.delete(errKey);
      // R31 — splice the confirmed axis value into the matching row. The
      // server applied exactly our patch, so the toggled axis equals what
      // we sent and the other axis is unchanged (mirrors the per-bridge
      // `applyBridgeModes` splice; avoids a second `describe` round-trip).
      rows = rows.map((r) =>
        r.channel === channel ? { ...r, [axis]: nextEnabled } : r,
      );
      return;
    }
    // DD#2 — `ok: false` variants are user-flow branches, not throws.
    // Keyed per axis so a concurrent success on the row's OTHER axis
    // can't clear this failure (R31 — the axes are independent).
    if (result.reason === 'ui_fixed') {
      // Defense-in-depth — the UI marks `ui`'s cells non-interactive so
      // this is unreachable through the click handler; still surface a
      // chip so a programmatic test / future bypass doesn't drop silently.
      rowErrors.set(
        errKey,
        'The webclient channel is always on and cannot be changed.',
      );
      return;
    }
    if (result.reason === 'approval_unsupported') {
      // R31 — an approval patch on a notify-only channel. The UI disables
      // that cell, so this is a defense-in-depth backstop.
      rowErrors.set(
        errKey,
        'This channel can only notify — it can’t receive approvals.',
      );
      return;
    }
    // `not_ready` — surface a short chip; the row's install / connect CTA
    // stays rendered because the underlying `ready` flag is still `false`.
    rowErrors.set(
      errKey,
      'Not set up yet — connect the channel before enabling.',
    );
  };

  /** R31 — drive one axis cell's toggle on a channel row. Idempotent
   *  re-entry per `(channel, axis)`: a click while that cell is in flight
   *  returns the in-flight promise rather than firing a duplicate. */
  const toggleAxis = (
    channel: NotificationChannelName,
    axis: ChannelAxis,
    nextEnabled: boolean,
  ): Promise<void> => {
    if (disposed) return Promise.resolve();
    const key = channelAxisKey(channel, axis);
    const existing = pendingTogglePromises.get(key);
    if (existing !== undefined) return existing;
    togglingAxes.add(key);
    rowErrors.delete(key);
    render();
    const promise = (async () => {
      try {
        const result = await opts.runSetChannel({
          channel,
          patch: { [axis]: nextEnabled } as Partial<NotificationChannelModeRow>,
        });
        if (disposed) return;
        surfaceSetChannelResult(channel, axis, nextEnabled, result);
      } catch (err) {
        if (disposed) return;
        // Network drop / `bad_request` / `not_configured` — surface the
        // error message verbatim on the row chip (keyed per axis).
        rowErrors.set(key, humanizeRpcError(err));
      } finally {
        togglingAxes.delete(key);
        pendingTogglePromises.delete(key);
        if (!disposed) render();
      }
    })();
    pendingTogglePromises.set(key, promise);
    return promise;
  };

  /** R31 — persist the panel-level anti-phishing verification phrase. An
   *  empty / whitespace-only value clears it (the rpc treats "" as null).
   *  Idempotent re-entry while a save is in flight. */
  const savePhrase = (next: string): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (!opts.runSetVerificationPhrase) return Promise.resolve();
    if (pendingPhrasePromise) return pendingPhrasePromise;
    verificationPhrase = next;
    phraseError = undefined;
    phraseSaving = true;
    render();
    const setPhrase = opts.runSetVerificationPhrase;
    const promise = (async () => {
      try {
        const trimmed = next.trim();
        const result = await setPhrase({ phrase: trimmed === '' ? null : trimmed });
        if (disposed) return;
        if (result.ok === true) {
          phraseDirty = false;
          verificationPhrase = result.settings.verification_phrase ?? '';
          persistedVerificationPhrase = verificationPhrase;
        } else {
          // `too_long` — surface inline; the input keeps the draft.
          phraseError = `Too long — keep it under ${result.max} characters.`;
        }
      } catch (err) {
        if (disposed) return;
        phraseError = humanizeRpcError(err);
      } finally {
        phraseSaving = false;
        pendingPhrasePromise = null;
        if (!disposed) render();
      }
    })();
    pendingPhrasePromise = promise;
    return promise;
  };

  // ── Render ───────────────────────────────────────────────────────
  const clearChildren = (): void => {
    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
  };

  const renderLoading = (): void => {
    const status = doc.createElement('p');
    status.className = 'notif-status';
    status.setAttribute('role', 'status');
    status.textContent = COPY.loading;
    wrapper.appendChild(status);
    if (retryTransition) {
      const retry = doc.createElement('button');
      retry.type = 'button';
      retry.setAttribute(NOTIFICATIONS_RETRY_BTN_ATTR, '');
      retry.setAttribute('aria-disabled', 'true');
      retry.setAttribute('aria-busy', 'true');
      retry.className = 'rx-btn rx-btn-secondary rx-btn-sm';
      retry.textContent = COPY.retrying_label;
      renderedRetryButton = retry;
      wrapper.appendChild(retry);
    }
  };

  const renderError = (): void => {
    const heading = doc.createElement('h3');
    heading.className = 'notif-title notif-title-error';
    heading.textContent = COPY.error_heading;

    const detail = doc.createElement('p');
    detail.className = 'notif-error';
    detail.setAttribute(NOTIFICATIONS_LIST_ERROR_ATTR, '');
    detail.setAttribute('role', 'alert');
    detail.textContent = listError ?? 'Unknown error.';

    const actions = doc.createElement('div');
    actions.className = 'notif-actions';
    const retry = doc.createElement('button');
    retry.type = 'button';
    retry.setAttribute(NOTIFICATIONS_RETRY_BTN_ATTR, '');
    retry.className = 'rx-btn rx-btn-secondary rx-btn-sm';
    retry.textContent = COPY.retry_label;
    retry.addEventListener('click', () => {
      if (retryTransition) return;
      retryTransition = true;
      pendingRetryFocus =
        (doc as Document & { activeElement?: Element | null }).activeElement === retry;
      void refreshRows();
    });
    renderedRetryButton = retry;
    actions.appendChild(retry);

    wrapper.appendChild(heading);
    wrapper.appendChild(detail);
    wrapper.appendChild(actions);
  };

  // R31 slice 1 (defect #1) — the email channel's 3-step setup guide,
  // rendered while email is not-ready. Step ① is an in-app deep link to
  // `#connections` (the Connections mail-enroll UI is the headline gap
  // this bottoms out at — R31 delta C cross-refs, does not duplicate);
  // steps ②/③ are static guidance. Kept as its own helper so the render
  // stays flat + the step list is one place to edit.
  const renderEmailSetupSteps = (): HTMLElement => {
    const steps = doc.createElement('ol');
    steps.setAttribute(NOTIFICATIONS_EMAIL_STEPS_ATTR, '');
    steps.className = 'notif-email-steps';

    const step1 = doc.createElement('li');
    const step1Link = doc.createElement('a');
    step1Link.setAttribute(NOTIFICATIONS_ROW_CONNECT_LINK_ATTR, '');
    step1Link.setAttribute('href', '#connections');
    step1Link.className = 'notif-row-connect-link';
    step1Link.textContent = COPY.email_step_1;
    step1.appendChild(step1Link);

    const step2 = doc.createElement('li');
    step2.textContent = COPY.email_step_2;

    const step3 = doc.createElement('li');
    step3.textContent = COPY.email_step_3;

    steps.appendChild(step1);
    steps.appendChild(step2);
    steps.appendChild(step3);
    return steps;
  };

  // R31 — render one axis cell (Notify or Approvals) of a channel row.
  // A togglable axis renders a switch button; a non-togglable axis
  // renders a fixed indicator — "Always on" for the `ui` floor, or the
  // "—" not-available marker for a notify-only channel's approval cell.
  const renderAxisCell = (
    row: NotificationChannelToggleView,
    axis: ChannelAxis,
  ): HTMLElement => {
    const enabled = axis === 'notification' ? row.notification : row.approval;
    const togglable =
      axis === 'notification' ? row.notification_togglable : row.approval_togglable;

    const cell = doc.createElement('div');
    cell.className = 'notif-axis-cell';
    cell.setAttribute(NOTIFICATIONS_AXIS_CELL_ATTR, axis);

    const label = doc.createElement('span');
    label.className = 'notif-axis-label';
    label.textContent =
      axis === 'notification' ? COPY.axis_notify : COPY.axis_approvals;
    cell.appendChild(label);

    if (!togglable) {
      // Fixed cell — the always-on floor (`ui`, `enabled === true`) or a
      // notify-only channel's unavailable approval axis (`enabled === false`).
      const fixed = doc.createElement('span');
      fixed.setAttribute(NOTIFICATIONS_AXIS_FIXED_ATTR, '');
      fixed.setAttribute(NOTIFICATIONS_AXIS_ATTR, axis);
      if (enabled) {
        fixed.className = 'notif-axis-fixed notif-axis-fixed-on';
        fixed.textContent = COPY.fixed_on_label;
      } else {
        fixed.className = 'notif-axis-fixed notif-axis-na';
        fixed.textContent = COPY.axis_na;
        fixed.setAttribute('title', COPY.axis_na_hint);
        fixed.setAttribute('aria-label', COPY.axis_na_hint);
      }
      cell.appendChild(fixed);
      return cell;
    }

    const key = channelAxisKey(row.channel, axis);
    const toggling = togglingAxes.has(key);
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.setAttribute(NOTIFICATIONS_ROW_TOGGLE_BTN_ATTR, row.channel);
    btn.setAttribute(NOTIFICATIONS_AXIS_ATTR, axis);
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', enabled ? 'true' : 'false');
    btn.className = `rx-btn rx-btn-sm ${
      enabled ? 'rx-btn-primary' : 'rx-btn-secondary'
    } notif-axis-toggle`;
    if (toggling) {
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-busy', 'true');
    }
    btn.textContent = toggling
      ? COPY.toggling_label
      : enabled
        ? COPY.enabled_label
        : COPY.disabled_label;
    btn.addEventListener('click', () => {
      if (toggling) return;
      if ((doc as Document & { activeElement?: Element | null }).activeElement === btn) {
        pendingAxisFocus = key;
      }
      void toggleAxis(row.channel, axis, !enabled);
    });
    renderedAxisButtons.set(key, btn);
    cell.appendChild(btn);
    return cell;
  };

  const renderRow = (row: NotificationChannelToggleView): HTMLElement => {
    const item = doc.createElement('article');
    item.setAttribute(NOTIFICATIONS_ROW_ATTR, '');
    item.setAttribute(NOTIFICATIONS_ROW_CHANNEL_ATTR, row.channel);
    item.className = 'notif-row';

    // Header — name + capability badge
    const header = doc.createElement('header');
    header.className = 'notif-row-header';

    const nameLabel = doc.createElement('span');
    nameLabel.className = 'notif-row-name';
    nameLabel.textContent = CHANNEL_DISPLAY_NAME[row.channel];
    header.appendChild(nameLabel);

    const capPres = CAPABILITY_PRESENTATION[row.capability];
    const capBadge = doc.createElement('span');
    capBadge.className = `notif-row-capability notif-row-capability-${capPres.tone}`;
    capBadge.textContent = capPres.label;
    header.appendChild(capBadge);

    item.appendChild(header);

    // Readiness state + (not-ready only) install / connect CTA
    const status = doc.createElement('p');
    status.className = 'notif-row-status';
    if (row.channel === 'ui') {
      status.textContent = COPY.fixed_on_label;
    } else if (!row.ready) {
      status.textContent = COPY.not_ready_label;
      status.classList.add('notif-row-status-not-ready');
      const ctaLabel = NOT_READY_CTA_LABEL[row.channel];
      // Bridge ships an explicit external `install_url`; slack / telegram
      // deep-link the in-app `#connections` route (R31 defect #2 — the
      // stale "via Settings → Connections" text hint pointed at a route
      // that graduated to the top-level `#connections` in R13–R16). Email
      // renders the 3-step instruction block below instead of a CTA here.
      if (row.install_url !== undefined) {
        const link = doc.createElement('a');
        link.setAttribute(NOTIFICATIONS_ROW_INSTALL_LINK_ATTR, '');
        link.setAttribute('href', row.install_url);
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
        link.className = 'notif-row-install-link';
        link.textContent = ctaLabel || 'Connect';
        status.appendChild(doc.createTextNode(' — '));
        status.appendChild(link);
      } else if (ctaLabel) {
        // In-app hash link — the shell's hash-router intercepts the
        // click, so no navigation seam is threaded into this leaf panel
        // (mirrors R29's privacy directory anchors).
        const cta = doc.createElement('a');
        cta.setAttribute(NOTIFICATIONS_ROW_CONNECT_LINK_ATTR, '');
        cta.setAttribute('href', '#connections');
        cta.className = 'notif-row-connect-link';
        cta.textContent = ctaLabel;
        status.appendChild(doc.createTextNode(' — '));
        status.appendChild(cta);
      }
    } else {
      // Ready + togglable — keep the status terse; the toggle button
      // carries the enabled/disabled state visually.
      status.textContent = '';
    }
    if (status.textContent !== '' || status.children.length > 0) {
      item.appendChild(status);
    }

    // R31 (defect #1) — the email row STAYS with a 3-step setup
    // instruction while it is not-ready (its Path-A wiring is a follow-on
    // slice), never hidden. Step ① deep-links Connections.
    if (row.channel === 'email' && !row.ready) {
      item.appendChild(renderEmailSetupSteps());
    }

    // R31 — the two-axis matrix cells (Notify | Approvals) + the per-row
    // error chip. Each cell toggles ONE axis; the approval cell is a
    // fixed indicator on `ui` (always-on floor) and on notify-only
    // channels (which structurally cannot carry an ask).
    const footer = doc.createElement('footer');
    footer.className = 'notif-row-footer';

    const cells = doc.createElement('div');
    cells.className = 'notif-row-cells';
    cells.appendChild(renderAxisCell(row, 'notification'));
    cells.appendChild(renderAxisCell(row, 'approval'));
    footer.appendChild(cells);

    const rowError = rowErrorFor(row.channel);
    if (rowError !== undefined) {
      const errBox = doc.createElement('span');
      errBox.setAttribute(NOTIFICATIONS_ROW_ERROR_ATTR, '');
      errBox.setAttribute('role', 'alert');
      errBox.className = 'notif-row-error';
      errBox.textContent = rowError;
      footer.appendChild(errBox);
    }

    item.appendChild(footer);

    // D-169 P1 — per-bridge sub-row group rendered under the channel-
    // level Browser Bridge row. The group only renders for the
    // `bridge` channel + only when the bridge-roster caller is wired.
    // When the bridge channel is OFF at the channel level, the sub-row
    // group still renders (each per-bridge row's modes are independent
    // policy + persistence; the channel-level toggle gates whether ANY
    // bridge fan-out happens, but the per-bridge intent is durable).
    if (row.channel === 'bridge' && opts.runDescribeBridges) {
      item.appendChild(renderBridgeRowGroup());
    }
    return item;
  };

  // D-169 P1 — render the per-bridge sub-row group + its error chip
  // when the bridge fetch failed independently of the channel fetch.
  const renderBridgeRowGroup = (): HTMLElement => {
    const groupContainer = doc.createElement('div');
    groupContainer.className = 'notif-bridge-group';
    const fetchError = bridgeRowErrors.get('');
    if (fetchError !== undefined) {
      const err = doc.createElement('p');
      err.setAttribute(NOTIFICATIONS_BRIDGE_ROW_ERROR_ATTR, '');
      err.className = 'notif-row-error';
      err.setAttribute('role', 'alert');
      err.textContent = `Could not list bridges: ${fetchError}`;
      groupContainer.appendChild(err);
      return groupContainer;
    }
    if (bridgeRows.length === 0) {
      const empty = doc.createElement('p');
      empty.setAttribute(NOTIFICATIONS_BRIDGE_EMPTY_ATTR, '');
      empty.className = 'notif-bridge-empty';
      empty.textContent =
        'No bridges paired yet. Install the Browser Bridge + pair it from its popup.';
      groupContainer.appendChild(empty);
      return groupContainer;
    }
    for (const br of bridgeRows) {
      groupContainer.appendChild(renderBridgeRow(br));
    }
    return groupContainer;
  };

  // D-169 P1 — render one paired bridge's row + its two mode toggles.
  // The mode buttons fire `set_bridge_mode` patches; the in-flight
  // states + per-row errors live on `bridgeRowToggling` /
  // `bridgeRowErrors`.
  const renderBridgeRow = (br: NotificationBridgeRow): HTMLElement => {
    const row = doc.createElement('div');
    row.setAttribute(NOTIFICATIONS_BRIDGE_ROW_ATTR, br.client_token_id);
    row.className = 'notif-bridge-row';

    const head = doc.createElement('header');
    head.className = 'notif-bridge-row-head';

    const label = doc.createElement('span');
    label.className = 'notif-bridge-row-label';
    label.textContent = br.label;
    head.appendChild(label);

    const presencePill = doc.createElement('span');
    presencePill.className = `notif-bridge-row-presence ${
      br.connected ? 'notif-bridge-row-presence-online' : ''
    }`;
    presencePill.textContent = br.connected ? 'Online' : 'Offline';
    head.appendChild(presencePill);

    row.appendChild(head);

    const buttons = doc.createElement('div');
    buttons.className = 'notif-bridge-row-buttons';
    buttons.appendChild(renderBridgeModeButton(br, 'notification'));
    buttons.appendChild(renderBridgeModeButton(br, 'approval'));
    row.appendChild(buttons);

    const err = bridgeRowErrors.get(br.client_token_id);
    if (err !== undefined) {
      const errBox = doc.createElement('p');
      errBox.setAttribute(NOTIFICATIONS_BRIDGE_ROW_ERROR_ATTR, '');
      errBox.className = 'notif-row-error';
      errBox.setAttribute('role', 'alert');
      errBox.textContent = err;
      row.appendChild(errBox);
    }
    return row;
  };

  const renderBridgeModeButton = (
    br: NotificationBridgeRow,
    mode: BridgeModeName,
  ): HTMLElement => {
    const enabled = br.modes[mode];
    const key = bridgeToggleKey(br.client_token_id, mode);
    const toggling = bridgeRowToggling.has(key);
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.setAttribute(NOTIFICATIONS_BRIDGE_MODE_BTN_ATTR, br.client_token_id);
    btn.setAttribute(NOTIFICATIONS_BRIDGE_MODE_ATTR, mode);
    btn.setAttribute('role', 'switch');
    btn.setAttribute('aria-checked', enabled ? 'true' : 'false');
    btn.className = `rx-btn rx-btn-sm ${
      enabled ? 'rx-btn-primary' : 'rx-btn-secondary'
    } notif-bridge-mode-btn`;
    if (toggling) {
      btn.setAttribute('aria-disabled', 'true');
      btn.setAttribute('aria-busy', 'true');
    }
    btn.textContent = toggling
      ? COPY.toggling_label
      : mode === 'notification'
        ? enabled
          ? 'Notifications On'
          : 'Notifications Off'
        : enabled
          ? 'Approvals On'
          : 'Approvals Off';
    btn.addEventListener('click', () => {
      if (toggling) return;
      if ((doc as Document & { activeElement?: Element | null }).activeElement === btn) {
        pendingBridgeFocus = key;
      }
      void toggleBridgeMode(br.client_token_id, mode, !enabled);
    });
    renderedBridgeButtons.set(key, btn);
    return btn;
  };

  const renderReady = (): void => {
    const list = doc.createElement('div');
    list.className = 'notif-list';
    for (const row of rows) {
      list.appendChild(renderRow(row));
    }
    wrapper.appendChild(list);
    // R31 — the panel-level anti-phishing phrase, below the matrix.
    if (opts.runSetVerificationPhrase) {
      wrapper.appendChild(renderPhraseField());
    }
  };

  // R31 — the anti-phishing verification-phrase field (panel-level). The
  // input tracks `verificationPhrase` in state (updated on each keystroke
  // WITHOUT a re-render so the caret is preserved); Save persists it. A
  // full rebuild (from another state change) restores the current draft.
  const renderPhraseField = (): HTMLElement => {
    const section = doc.createElement('div');
    section.className = 'notif-phrase';

    const heading = doc.createElement('h4');
    heading.className = 'notif-phrase-heading';
    heading.textContent = COPY.phrase_heading;
    section.appendChild(heading);

    const hint = doc.createElement('p');
    hint.className = 'notif-phrase-hint';
    hint.textContent = COPY.phrase_hint;
    section.appendChild(hint);

    const controls = doc.createElement('div');
    controls.className = 'notif-phrase-controls';

    const input = doc.createElement('input');
    input.setAttribute(NOTIFICATIONS_PHRASE_INPUT_ATTR, '');
    input.setAttribute('type', 'text');
    input.setAttribute('placeholder', COPY.phrase_placeholder);
    input.className = 'notif-phrase-input rx-input';
    (input as unknown as { value: string }).value = verificationPhrase;
    if (phraseSaving) input.disabled = true;
    // Track edits in state without a re-render (preserves caret); mark
    // dirty so a `describe` refresh won't clobber the draft.
    input.addEventListener('input', (ev) => {
      const target = ev.target as unknown as { value?: string };
      verificationPhrase = target.value ?? '';
      phraseDirty = verificationPhrase !== persistedVerificationPhrase;
    });
    renderedPhraseInput = input;
    controls.appendChild(input);

    const save = doc.createElement('button');
    save.type = 'button';
    save.setAttribute(NOTIFICATIONS_PHRASE_SAVE_ATTR, '');
    save.className = 'rx-btn rx-btn-sm rx-btn-secondary notif-phrase-save';
    save.textContent = phraseSaving ? COPY.phrase_saving : COPY.phrase_save;
    if (phraseSaving) {
      save.setAttribute('aria-disabled', 'true');
      save.setAttribute('aria-busy', 'true');
    }
    save.addEventListener('click', () => {
      if (phraseSaving) return;
      if ((doc as Document & { activeElement?: Element | null }).activeElement === save) {
        pendingPhraseSaveFocus = true;
      }
      void savePhrase(verificationPhrase);
    });
    renderedPhraseSave = save;
    controls.appendChild(save);
    section.appendChild(controls);

    if (phraseError !== undefined) {
      const err = doc.createElement('p');
      err.setAttribute(NOTIFICATIONS_PHRASE_ERROR_ATTR, '');
      err.setAttribute('role', 'alert');
      err.className = 'notif-row-error';
      err.textContent = phraseError;
      section.appendChild(err);
    }
    return section;
  };

  const render = (): void => {
    if (disposed) return;
    if (pendingAxisFocus !== null) {
      const focusDoc = doc as Document & {
        activeElement?: Element | null;
        body?: HTMLElement;
      };
      const active = focusDoc.activeElement;
      const liveOwnerMoved = active !== null
        && active !== undefined
        && active !== focusDoc.body
        && (active as HTMLElement).isConnected !== false
        && focusedAxisKey(active) !== pendingAxisFocus;
      if (liveOwnerMoved) pendingAxisFocus = null;
    }
    if (pendingBridgeFocus !== null) {
      const focusDoc = doc as Document & {
        activeElement?: Element | null;
        body?: HTMLElement;
      };
      const active = focusDoc.activeElement;
      const liveOwnerMoved = active !== null
        && active !== undefined
        && active !== focusDoc.body
        && (active as HTMLElement).isConnected !== false
        && focusedBridgeKey(active) !== pendingBridgeFocus;
      if (liveOwnerMoved) pendingBridgeFocus = null;
    }
    if (pendingPhraseSaveFocus) {
      const focusDoc = doc as Document & {
        activeElement?: Element | null;
        body?: HTMLElement;
      };
      const active = focusDoc.activeElement;
      const liveOwnerMoved = active !== null
        && active !== undefined
        && active !== focusDoc.body
        && (active as HTMLElement).isConnected !== false
        && active.hasAttribute?.(NOTIFICATIONS_PHRASE_SAVE_ATTR) !== true;
      if (liveOwnerMoved) pendingPhraseSaveFocus = false;
    }
    if (pendingRetryFocus) {
      const focusDoc = doc as Document & {
        activeElement?: Element | null;
        body?: HTMLElement;
      };
      const active = focusDoc.activeElement;
      const liveOwnerMoved = active !== null
        && active !== undefined
        && active !== focusDoc.body
        && (active as HTMLElement).isConnected !== false
        && active.hasAttribute?.(NOTIFICATIONS_RETRY_BTN_ATTR) !== true;
      if (liveOwnerMoved) pendingRetryFocus = false;
    }
    renderedAxisButtons = new Map<string, HTMLButtonElement>();
    renderedBridgeButtons = new Map<string, HTMLButtonElement>();
    renderedPhraseSave = undefined;
    renderedPhraseInput = undefined;
    renderedRetryButton = undefined;
    clearChildren();
    switch (state) {
      case 'loading':
        renderLoading();
        break;
      case 'ready':
        renderReady();
        break;
      case 'error':
        renderError();
        break;
    }
    if (pendingAxisFocus !== null) {
      const key = pendingAxisFocus;
      const replacement = renderedAxisButtons.get(key);
      replacement?.focus?.({ preventScroll: true });
      replacement?.scrollIntoView?.({ block: 'nearest' });
      if (!togglingAxes.has(key)) pendingAxisFocus = null;
    }
    if (pendingBridgeFocus !== null) {
      const key = pendingBridgeFocus;
      const replacement = renderedBridgeButtons.get(key);
      replacement?.focus?.({ preventScroll: true });
      replacement?.scrollIntoView?.({ block: 'nearest' });
      if (!bridgeRowToggling.has(key)) pendingBridgeFocus = null;
    }
    if (pendingPhraseSaveFocus) {
      // `renderPhraseField()` mutates this closure-owned reference; TS does
      // not follow that nested call through `renderReady()` above.
      const replacement = renderedPhraseSave as HTMLButtonElement | undefined;
      replacement?.focus?.({ preventScroll: true });
      replacement?.scrollIntoView?.({ block: 'nearest' });
      if (!phraseSaving) pendingPhraseSaveFocus = false;
    }
    if (pendingRetryFocus) {
      const firstAxis = renderedAxisButtons.values().next().value as
        | HTMLButtonElement
        | undefined;
      const replacement = state === 'ready'
        ? firstAxis
          ?? (renderedPhraseInput as HTMLInputElement | undefined)
        : (renderedRetryButton as HTMLButtonElement | undefined);
      replacement?.focus?.({ preventScroll: true });
      replacement?.scrollIntoView?.({ block: 'nearest' });
      if (state !== 'loading') pendingRetryFocus = false;
    }
    if (state !== 'loading') retryTransition = false;
  };

  // Initial paint + kick off the first fetch. `refreshRows` would
  // re-call render via transitionTo, but the same-state short-circuit
  // means the explicit `render()` is the only painter of the initial
  // loading frame.
  render();
  void refreshRows();

  // ── Live broadcast subscription (D-169 P2 Slice 4 follow-on) ──────
  // A bridge-mode toggle on any paired client fans a
  // `notification.bridge_mode_changed` carrying the affected bridge's
  // durable `client_token_id` + its COMPLETE post-change `modes`. We
  // splice that snapshot straight into the matching per-bridge row — no
  // `describe_bridges` round-trip, no loading flash (the event is
  // self-contained by design). Only wired when BOTH `subscribe` and
  // `runDescribeBridges` are present: without the roster caller there
  // are no per-bridge rows to update, so the listener would be dead.
  //
  // A self-originated echo (this client's own `set_bridge_mode` also
  // broadcasts back to it) is idempotent — it re-applies the same modes
  // the toggle's success path already spliced, and an in-flight row's
  // "Updating…" button masks any transient mid-flight render.
  if (opts.subscribe && opts.runDescribeBridges) {
    unsubscribes.push(
      opts.subscribe('notification.bridge_mode_changed', (event) => {
        if (disposed) return;
        // Fast path: the bridge is already in our roster → splice the
        // event's inline post-change modes in place (no round-trip).
        if (applyBridgeModes(event.client_token_id, event.modes)) {
          render();
          return;
        }
        // Slow path: the bridge isn't in our current roster — either the
        // initial roster load hasn't resolved yet (an in-place splice
        // here would be lost, then the in-flight stale read would install
        // pre-change modes) or the bridge was paired after our last
        // fetch. Re-read the authoritative roster; the generation guard
        // makes this fresher read win over any in-flight load. Skipping
        // the refetch would leave the per-bridge row silently stale.
        reloadBridgeRows();
      }),
    );
  }

  // ── Test seams ───────────────────────────────────────────────────
  const findBtn = (
    attr: string,
    attrValue?: string,
  ): HTMLButtonElement | null => {
    const walk = (node: HTMLElement): HTMLButtonElement | null => {
      if (
        typeof node.hasAttribute === 'function'
        && node.hasAttribute(attr)
        && node.tagName === 'BUTTON'
        && (attrValue === undefined || node.getAttribute(attr) === attrValue)
      ) {
        return node as HTMLButtonElement;
      }
      const kids =
        (node as unknown as { children?: ArrayLike<HTMLElement> }).children
        ?? (node as unknown as { childList?: ArrayLike<HTMLElement> }).childList;
      if (!kids) return null;
      const length = (kids as { length: number }).length;
      for (let i = 0; i < length; i += 1) {
        const hit = walk(kids[i] as HTMLElement);
        if (hit) return hit;
      }
      return null;
    };
    return walk(wrapper as HTMLElement);
  };

  return {
    getState: () => state,
    getRows: () => rows,
    getTogglingAxes: () => togglingAxes,
    getRowError: (channel) => rowErrorFor(channel),
    getListError: () => listError,
    hasInFlightWork: () =>
      pendingTogglePromises.size > 0
      || pendingBridgeTogglePromises.size > 0
      || pendingPhrasePromise !== null,
    hasUnsavedChanges: () => phraseDirty,
    getVerificationPhrase: () => verificationPhrase,
    getPhraseError: () => phraseError,
    savePhrase: (next) => savePhrase(next),
    refresh: () => {
      void refreshRows();
    },
    whenLoaded: () => pendingDescribePromise,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Drop the live broadcast subscription before tearing down the DOM
      // so a frame arriving mid-dispose can't splice into a removed
      // wrapper (the handler's own `disposed` guard covers it too — belt
      // + braces, mirroring the asks panel).
      for (const unsub of unsubscribes) {
        try {
          unsub();
        } catch {
          // Unsubscribe errors are isolated — the subscriber owns its
          // own teardown; we just need to drop the handle.
        }
      }
      unsubscribes.length = 0;
      try {
        opts.host.removeChild(wrapper);
      } catch {
        wrapper.remove();
      }
    },
    clickRetry: () => {
      const b = findBtn(NOTIFICATIONS_RETRY_BTN_ATTR);
      if (b && !b.disabled) b.click();
    },
    clickAxis: async (channel, axis) => {
      // Find the toggle button carrying BOTH the channel + the axis
      // (a channel row now has two toggle buttons — one per axis).
      let btn: HTMLButtonElement | null = null;
      const walk = (node: HTMLElement): void => {
        if (
          btn === null
          && typeof node.hasAttribute === 'function'
          && node.tagName === 'BUTTON'
          && node.hasAttribute(NOTIFICATIONS_ROW_TOGGLE_BTN_ATTR)
          && node.getAttribute(NOTIFICATIONS_ROW_TOGGLE_BTN_ATTR) === channel
          && node.getAttribute(NOTIFICATIONS_AXIS_ATTR) === axis
        ) {
          btn = node as HTMLButtonElement;
          return;
        }
        const kids = (node as unknown as { children?: ArrayLike<HTMLElement> })
          .children;
        if (!kids) return;
        const len = (kids as { length: number }).length;
        for (let i = 0; i < len && btn === null; i += 1) {
          walk(kids[i] as HTMLElement);
        }
      };
      walk(wrapper as HTMLElement);
      const matched = btn as HTMLButtonElement | null;
      if (!matched || matched.disabled) return;
      matched.click();
      const pending = pendingTogglePromises.get(channelAxisKey(channel, axis));
      if (pending) await pending;
    },
    getBridgeRows: () => bridgeRows,
    getBridgeRowToggling: () => bridgeRowToggling,
    getBridgeRowError: (client_token_id) =>
      bridgeRowErrors.get(client_token_id),
    clickBridgeMode: async (client_token_id, mode) => {
      // Walk all per-bridge mode buttons for the row + filter on the
      // mode attribute. Stable hooks let tests + this seam drive the
      // toggle without coupling to layout.
      let btn: HTMLButtonElement | null = null;
      const walk = (node: HTMLElement): void => {
        if (
          btn === null
          && typeof node.hasAttribute === 'function'
          && node.tagName === 'BUTTON'
          && node.hasAttribute(NOTIFICATIONS_BRIDGE_MODE_BTN_ATTR)
          && node.getAttribute(NOTIFICATIONS_BRIDGE_MODE_BTN_ATTR) === client_token_id
          && node.getAttribute(NOTIFICATIONS_BRIDGE_MODE_ATTR) === mode
        ) {
          btn = node as HTMLButtonElement;
          return;
        }
        const kids = (node as unknown as { children?: ArrayLike<HTMLElement> }).children;
        if (!kids) return;
        const len = (kids as { length: number }).length;
        for (let i = 0; i < len && btn === null; i += 1) {
          walk(kids[i] as HTMLElement);
        }
      };
      walk(wrapper as HTMLElement);
      // Type assertion needed because TS narrows `btn` to `null` from
      // the initial assignment; the walk above mutates it but TS doesn't
      // track mutations through closures.
      const matched = btn as HTMLButtonElement | null;
      if (!matched || matched.disabled) return;
      matched.click();
      const pending = pendingBridgeTogglePromises.get(
        bridgeToggleKey(client_token_id, mode),
      );
      if (pending) await pending;
    },
  };
};

// ════════════════════════════════════════════════════════════════
// Styles
// ════════════════════════════════════════════════════════════════

export const NOTIFICATIONS_PANEL_STYLES = `
[${NOTIFICATIONS_PANEL_ATTR}] {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--fg);
  font-size: 13px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-status {
  margin: 0;
  color: var(--fg-muted);
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-title-error {
  color: var(--danger);
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-error {
  margin: 0;
  padding: 6px 8px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, monospace;
  font-size: 12px;
  word-break: break-all;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 4px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row-name {
  font-weight: 600;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row-capability {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 500;
  /* Filled accent = 'inline' (Answer here). The transparent border keeps
     all three tones the same box size so the outlined landing-page pill
     doesn't shift 1px against its neighbours. */
  background: var(--accent-bg);
  color: var(--accent);
  border: 1px solid transparent;
}
/* R31 (defect #3) — 'landing-page' (Answer via link) renders as an
   OUTLINED accent pill so it reads distinct from the filled 'inline'
   pill; pre-R31 both shared the identical filled accent. */
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row-capability-landing-page {
  background: var(--bg);
  color: var(--accent);
  border-color: var(--accent);
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row-capability-notify-only {
  background: var(--muted-bg);
  color: var(--fg-muted);
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row-status {
  margin: 0;
  color: var(--fg-muted);
  font-size: 12px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row-status-not-ready {
  /* R31 — "not set up" is a SETUP-PENDING instruction, not a failure.
     Pre-R31 this used --danger (red), which read as an error; the
     reframe wants it calm + neutral, with the accent carried by the
     connect CTA / setup steps below. */
  color: var(--fg-muted);
  font-weight: 500;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row-install-link {
  color: var(--accent);
  text-decoration: underline;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row-connect-link {
  color: var(--accent);
  text-decoration: underline;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-email-steps {
  margin: 4px 0 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  color: var(--fg-muted);
  font-size: 12px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
/* R31 — the two-axis matrix cells (Notify | Approvals). */
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row-cells {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-axis-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 72px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-axis-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--fg-muted);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-axis-fixed {
  display: inline-flex;
  align-items: center;
  height: 24px;
  font-size: 12px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-axis-fixed-on {
  color: var(--accent);
  font-weight: 500;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-axis-na {
  color: var(--fg-muted);
  cursor: help;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-row-error {
  padding: 4px 8px;
  background: var(--danger-bg);
  color: var(--danger);
  border-radius: 4px;
  font-size: 12px;
}
/* R31 — the panel-level anti-phishing verification phrase. */
[${NOTIFICATIONS_PANEL_ATTR}] .notif-phrase {
  margin-top: 6px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-phrase-heading {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-phrase-hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-phrase-controls {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-phrase-input {
  flex: 1 1 200px;
  min-width: 160px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-bridge-group {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-bridge-empty {
  margin: 0;
  font-size: 11px;
  color: var(--fg-muted);
  font-style: italic;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-bridge-row {
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-bridge-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-bridge-row-label {
  font-weight: 500;
  font-size: 12px;
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-bridge-row-presence {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--muted-bg);
  color: var(--fg-muted);
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-bridge-row-presence-online {
  background: var(--ok-bg);
  color: var(--ok-fg);
}
[${NOTIFICATIONS_PANEL_ATTR}] .notif-bridge-row-buttons {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
`;
