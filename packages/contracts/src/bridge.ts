/** D-148 § A.3 — Browser Bridge contract.
 *
 *  The bridge is a thin executor: receives one BridgeCommand from
 *  server → executes against the browser session → returns one
 *  BridgeResult. No engine. No recipe shape. No DOM logic beyond the
 *  closed-list `BridgeAction` set. The server is the orchestrator;
 *  the bridge is the actuator.
 *
 *  P1 ships the contract types + per-domain permission gates +
 *  capacity-gap remediation surface. P3 builds the bridge app
 *  (`apps/bridge/`) against this contract.
 *
 *  Hard rules per § A.3.4 + § A.3.4.1 (D-169 P0 amends per-command
 *  authority signing — see N.3 / I-3):
 *   - Bridge stores only the documented closed-list of fields.
 *   - No `<all_urls>` blanket grant — per-ingredient per-domain
 *     `chrome.permissions.request()` flow is the only path to a
 *     host permission.
 *   - Two-way intersection per § A.7: command's `target_domain_pattern`
 *     MUST be a member of the ingredient's signed `domain_allowlist`
 *     AND of the user's per-ingredient grant for that bridge.
 *   - No per-command Authority signing on either webclient or bridge
 *     (DL-1) — WS connection auth (pair-blob) is the trust boundary.
 */

/** D-148 § A.3.1 — closed list of browser-DOM actions the bridge can
 *  perform. The bridge declines anything not in this set; ingredient
 *  manifests declare `permitted_actions` from this list at publish
 *  time. */
export type BridgeAction =
  /** What the element shows, as `{ text }`: a form field's value (a list's
   *  chosen options, `true`/`false` for a checkbox or radio button), else its
   *  `innerText`. A password, hidden, sign-in code or payment card field
   *  answers `field_protected` instead of its value. */
  | 'read_dom'
  | 'click'
  /** Types `value` into an input, textarea, list (by option value or text),
   *  checkbox or radio button (`true`/`false`), or rich-text editor, then
   *  confirms the element holds it; otherwise answers `value_not_applied`. */
  | 'fill'
  | 'wait_for_selector'
  | 'extract_table'
  | 'screenshot'
  | 'os_notification'
  /** D-335 — the page, or one region of it, as cleaned HTML for an AI to read,
   *  as `{ page, url, title, html, truncated }`. `args.selector` names a region
   *  by CSS; `args.page` (a handle an earlier inspect answered) with `args.ref`
   *  names an element that inspect marked. `apps/bridge/src/actions/page-inspect.ts`. */
  | 'inspect'
  /** D-335 slice B — one element as a person would name it, read live for an
   *  approval ask: `{ page, url, title, role, label, protected }`. Named like
   *  an inspect region: `args.selector`, or `args.page` with `args.ref`. */
  | 'describe'
  /** D-335 slice C — the open tabs on the command's site, never the owner
   *  client: `{ tabs: [{ page, url, title }], truncated }`. `page-tabs.ts`. */
  | 'list_tabs'
  /** D-335 slice C — opens `args.url` in a new background tab, never in one
   *  already open, and answers the loaded page: `{ page, url, title }`. */
  | 'open_tab'
  /** D-335 slice H — waits in the document `args.page` names until an element
   *  matching `args.selector` shows (or, with `args.until: 'gone'`, until none
   *  does), holding `args.text` when given, for at most `args.timeout_ms`:
   *  `{ page, url, title, found, waited_ms }`. Not finding it in time answers
   *  `found: false`, not an error. ⛔ Not `wait_for_selector`, which an older
   *  Bridge runs against whichever tab matches the site, and checks only once.
   *  `apps/bridge/src/actions/page-wait.ts`. */
  | 'wait_for_element'
  /** D-335 slice H — one table in the document `args.page` names: a `<table>`
   *  or an ARIA table or grid, by `args.selector` or `args.ref`, else the first
   *  shown. `{ page, url, title, columns, rows, truncated }`: the text a person
   *  sees in each cell, a protected field's value left out. ⛔ Not
   *  `extract_table`, which reads hidden text and has no bound.
   *  `apps/bridge/src/actions/page-table.ts`. */
  | 'read_table'
  /** D-335 slice H — a picture of the document `args.page` names as Chrome draws
   *  it: the visible part of the page, or the element `args.ref` or
   *  `args.selector` names. `{ page, url, title, image, mime_type, width,
   *  height }`, `image` in base64. Chrome only captures the tab in front, so the
   *  Bridge brings the tab forward for the capture and then puts back the tab the
   *  owner was on (owner's ruling, 2026-11-01). ⛔ Not `screenshot`, which an
   *  older Bridge takes of whichever tab matches the site, and leaves in front.
   *  `apps/bridge/src/actions/page-capture.ts`.
   *
   *
   *  Chrome captures a tab only for an extension holding `<all_urls>` or
   *  `activeTab`. The owner's ruling (2026-11-01) amends invariant I-9 (D-148
   *  § A.3.4): `<all_urls>` is an optional grant the owner asks for with "Allow
   *  screenshots" in the side panel, never in the manifest's host permissions.
   *  Without it the Bridge refuses before any tab moves, naming the switch. */
  | 'screenshot_page';

export const BRIDGE_ACTIONS: ReadonlyArray<BridgeAction> = [
  'read_dom',
  'click',
  'fill',
  'wait_for_selector',
  'extract_table',
  'screenshot',
  'os_notification',
  'inspect',
  'describe',
  'list_tabs',
  'open_tab',
  'wait_for_element',
  'read_table',
  'screenshot_page',
] as const;

/** The actions every Bridge has run since D-148. A Bridge whose capability
 *  profile has no `supported_actions` predates `inspect` and runs only these. */
export const ORIGINAL_BRIDGE_ACTIONS: ReadonlyArray<BridgeAction> = [
  'read_dom',
  'click',
  'fill',
  'wait_for_selector',
  'extract_table',
  'screenshot',
  'os_notification',
] as const;

/** Whether a Bridge with this profile runs `action`, so the server can say
 *  "update the Bridge" before sending one it would answer "unsupported". */
export const bridgeRunsAction = (
  profile: Pick<BridgeCapabilityProfile, 'supported_actions'>,
  action: BridgeAction,
): boolean => {
  const actions: readonly string[] = profile.supported_actions ?? ORIGINAL_BRIDGE_ACTIONS;
  return actions.includes(action);
};

/** Whether a Bridge with this profile runs this command. A `fill` or `click`
 *  that names a page handle or a ref needs a Bridge that runs `describe`: the
 *  two came in the same Bridge (D-335 slice B), and an older Bridge answers a
 *  write with no selector "requires selector argument". */
export const bridgeRunsCommand = (
  profile: Pick<BridgeCapabilityProfile, 'supported_actions'>,
  action: BridgeAction,
  args: Record<string, unknown>,
): boolean => bridgeRunsAction(profile, action)
  && (action === 'inspect' || action === 'describe' || (args.page === undefined && args.ref === undefined)
    || bridgeRunsAction(profile, 'describe'));

/** D-335 §3.2 — the most HTML one `inspect` answers, about 10k tokens. A page
 *  that does not fit is cut at an element boundary and answers `truncated`. */
export const BRIDGE_INSPECT_MAX_CHARS = 40_000;
/** D-335 §3.2 — the most of one text node, field value or attribute `inspect`
 *  keeps; a longer one is cut and ends with an ellipsis. */
export const BRIDGE_INSPECT_MAX_VALUE_CHARS = 2_000;
/** The keys of an `inspect` answer. */
export const BRIDGE_INSPECT_OUTPUT_KEYS = ['page', 'url', 'title', 'html', 'truncated'] as const;
/** The keys of a `describe` answer. */
export const BRIDGE_DESCRIBE_OUTPUT_KEYS = ['page', 'url', 'title', 'role', 'label', 'protected'] as const;
/** The keys of a `list_tabs` answer, and the most tabs it lists. */
export const BRIDGE_TABS_OUTPUT_KEYS = ['tabs', 'truncated'] as const;
export const BRIDGE_TABS_MAX = 50;
/** The keys of an `open_tab` answer. */
export const BRIDGE_OPEN_OUTPUT_KEYS = ['page', 'url', 'title'] as const;

/** D-335 slice H — how long `wait_for_element` waits when no time is given,
 *  and the longest it waits. The command's own budget stays above it. */
export const BRIDGE_WAIT_DEFAULT_MS = 10_000;
export const BRIDGE_WAIT_MAX_MS = 30_000;
/** The keys of a `wait_for_element` answer. */
export const BRIDGE_WAIT_OUTPUT_KEYS = ['page', 'url', 'title', 'found', 'waited_ms'] as const;
/** D-335 slice H — the most rows one `read_table` answers. Its cells share
 *  inspect's budget: at most {@link BRIDGE_INSPECT_MAX_CHARS} characters in all,
 *  and at most {@link BRIDGE_INSPECT_MAX_VALUE_CHARS} in one cell. A table that
 *  does not fit answers the rows that did, with `truncated`. */
export const BRIDGE_TABLE_MAX_ROWS = 500;
/** The keys of a `read_table` answer. */
export const BRIDGE_TABLE_OUTPUT_KEYS = ['page', 'url', 'title', 'columns', 'rows', 'truncated'] as const;
/** D-335 slice H — the longest side of a screenshot, in pixels. A larger capture
 *  is scaled down to it: about the most a model reads at full detail. */
export const BRIDGE_SCREENSHOT_MAX_EDGE = 1568;
/** The most base64 one screenshot may be (about 1.5 MB of picture), well under
 *  the server socket's 4 MiB message cap. A JPEG over it is re-encoded smaller. */
export const BRIDGE_SCREENSHOT_MAX_BASE64 = 2_000_000;
/** The keys of a `screenshot_page` answer. */
export const BRIDGE_SCREENSHOT_OUTPUT_KEYS = ['page', 'url', 'title', 'image', 'mime_type', 'width', 'height'] as const;

/** D-335 slice H — a picture in a step's output, by reference: the server keeps
 *  the bytes for {@link BROWSER_IMAGE_TTL_MS} and the output carries this. An
 *  AI app over MCP receives the picture itself beside the result; a run's
 *  history, chat and the audit log keep only the reference, so a screenshot is
 *  never stored with them. */
export interface BrowserImageRef {
  type: 'image';
  image_id: string;
  mime_type: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
}

/** How long the server keeps a screenshot after taking it. */
export const BROWSER_IMAGE_TTL_MS = 10 * 60_000;

export const isBrowserImageRef = (value: unknown): value is BrowserImageRef => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return ref.type === 'image' && typeof ref.image_id === 'string' && /^[\w-]{8,64}$/.test(ref.image_id)
    && (ref.mime_type === 'image/jpeg' || ref.mime_type === 'image/png')
    && Number.isSafeInteger(ref.width) && (ref.width as number) > 0
    && Number.isSafeInteger(ref.height) && (ref.height as number) > 0;
};

/** D-148 § A.3.1 — the surface kind a bridge-bound ingredient
 *  represents. `messaging` is permanently rejected by the marketplace
 *  validator (D-145 publishing-vs-messaging rule); only the three
 *  values below are accepted at publish time. */
export type BridgeSurfaceKind = 'publishing' | 'authoring' | 'reading';

export const BRIDGE_SURFACE_KINDS: ReadonlyArray<BridgeSurfaceKind> = [
  'publishing',
  'authoring',
  'reading',
] as const;

export interface BridgeIngredientRef {
  slug: string;
  publisher_id: string;
  /** Semver of the published ingredient. Bridge persists per-version
   *  domain grants — a new version with a wider domain list re-prompts. */
  version: string;
  surface_kind: BridgeSurfaceKind;
  /** Closed list of URL patterns the ingredient touches. Signed by
   *  the ingredient publisher's `publisher_identity_key` at publish
   *  time; bridge verifies the signature at install + at every
   *  grant prompt + at every command dispatch. Tampered domain
   *  lists fail with `ingredient_domain_signature_invalid`. */
  domain_allowlist: string[];
  /** Ed25519 signature over canonical JSON of the ingredient
   *  manifest's domain block, signed with the ingredient's
   *  `publisher_identity_key`. P1 reserves the field; P3 + the
   *  marketplace validator (later D) populate. Spec field name. */
  domain_allowlist_signature: string;
}

/** D-169 P0 Slice 2A — per-command capability envelope (unsigned).
 *
 *  Pre-D-169 the scope rode inside a server-signed `BridgeAuthority`
 *  struct that the bridge verified at every dispatch. D-169 retires the
 *  signing layer (DL-1) — Recued's single-trust-context server makes
 *  per-RPC signing asymmetric defense at a smaller harm surface than
 *  the webclient. The scope shape (action × domain pattern × duration)
 *  is preserved as plain unsigned envelope fields on `BridgeCommand`.
 *
 *  Per-action authorization is the two-way intersection per § A.7:
 *    1. Ingredient's signed `domain_allowlist` includes `target_domain_pattern`
 *       (signature verified upstream; the bridge trusts the ingredient
 *       ref's `domain_allowlist` as already-verified at dispatch).
 *    2. User's `BridgeIngredientGrant.granted_origins` includes the
 *       same pattern.
 *
 *  Both must hold; failure raises `authority_invalid_grant_scope`.
 *  Wider-than-allowlist patterns shouldn't be reachable: the server-side
 *  dispatcher only sends commands whose `target_domain_pattern` is a
 *  member of the ingredient's allowlist (server-side fail-fast). */
/** A main-frame document observed by the paired bridge. Document IDs come
 * from Chrome, rotate on navigation, and are never supplied by a recipe. */
export interface BridgeDocumentIdentity {
  tab_id: number;
  document_id: string;
  url: string;
}

export const BRIDGE_REVIEW_DOCUMENT_LIMIT = 128;
export const isBridgeDocumentIdentity = (value: unknown): value is BridgeDocumentIdentity => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !['tab_id', 'document_id', 'url'].includes(key))
    || !Number.isSafeInteger(row.tab_id) || (row.tab_id as number) < 0
    || typeof row.document_id !== 'string' || row.document_id.length < 1 || row.document_id.length > 128
    || typeof row.url !== 'string' || row.url.length > 8192) return false;
  try { const url = new URL(row.url); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
};

export interface BridgeCommand {
  /** Server-issued opaque id. Bridge uses for idempotency. */
  command_id: string;
  /** Server-side recipe execution id; used for audit cross-reference
   *  and cancellation routing. */
  recipe_run_id: string;
  /** Server-side step id; used for audit cross-reference. */
  step_id: string;
  ingredient: BridgeIngredientRef;
  /** D-169 P0 Slice 2A — explicit action discriminator (was
   *  `authority.permitted_actions[0]`). Must be a member of the
   *  ingredient manifest's `permitted_actions` (server-side gate). */
  action: BridgeAction;
  /** D-169 P0 Slice 2A — Chrome match-pattern naming the tab + origin
   *  the bridge dispatches against (was `authority.domain_pattern`).
   *  Must be a member of the ingredient's signed `domain_allowlist`
   *  AND the user's per-ingredient grant. */
  target_domain_pattern: string;
  args: Record<string, unknown>;
  /** Closed list per the ingredient manifest. Bridge validates the
   *  output keys it returns are in this set. */
  expects_output_keys: string[];
  /** Wall-clock budget. Default 30_000; max 60_000. */
  timeout_ms: number;
  /** Server-issued idempotency key. Bridge stores in IndexedDB for
   *  24h and replays prior result on retry. */
  idempotency_key: string;
  /** Server-narrowed execution target; never grants a browser permission. An
   * older bridge without this capability cannot be selected for review. */
  reviewed_document?: BridgeDocumentIdentity;
}

export const BRIDGE_COMMAND_DEFAULT_TIMEOUT_MS = 30_000;
export const BRIDGE_COMMAND_MAX_TIMEOUT_MS = 60_000;

/** D-148 § A.3.1 — closed list of error codes a bridge returns. */
export type BridgeErrorCode =
  | 'capacity_gap_logged_in'
  | 'capacity_gap_tab_unavailable'
  | 'capacity_gap_permission_missing'
  | 'selector_not_found'
  | 'authority_invalid'
  | 'authority_expired'
  | 'authority_invalid_grant_scope'
  | 'ingredient_domain_signature_invalid'
  | 'tab_navigation_blocked'
  | 'idempotency_violation'
  | 'delivery_uncertain'
  /** A `fill` ran and read the element back, and it does not hold the value:
   *  an editor that ignored the text, a list with no matching option, a date or
   *  number field that emptied what it could not parse, an element that takes
   *  no typing. Confirmed, unlike `delivery_uncertain`. */
  | 'value_not_applied'
  /** A `read_dom` reached a password, hidden, sign-in code or payment card
   *  field. The bridge never returns what such a field holds. */
  | 'field_protected'
  | 'mv3_lifecycle_killed'
  | 'queue_full'
  | 'unknown';

export const BRIDGE_ERROR_CODES: ReadonlyArray<BridgeErrorCode> = [
  'capacity_gap_logged_in',
  'capacity_gap_tab_unavailable',
  'capacity_gap_permission_missing',
  'selector_not_found',
  'authority_invalid',
  'authority_expired',
  'authority_invalid_grant_scope',
  'ingredient_domain_signature_invalid',
  'tab_navigation_blocked',
  'idempotency_violation',
  'delivery_uncertain',
  'value_not_applied',
  'field_protected',
  'mv3_lifecycle_killed',
  'queue_full',
  'unknown',
] as const;

export type BridgeResultStatus = 'ok' | 'error' | 'timeout' | 'cancelled' | 'rejected';

export interface BridgeResult {
  command_id: string;
  status: BridgeResultStatus;
  /** Present when `status === 'ok'`. Keys are subset of the
   *  command's `expects_output_keys`. */
  outputs?: Record<string, unknown>;
  error?: {
    code: BridgeErrorCode;
    message: string;
    detail?: string;
  };
  duration_ms: number;
  bridge_version: string;
  /** True iff the server retried with an idempotency_key this bridge
   *  has already seen — helps server detect drift between server
   *  + bridge views. */
  idempotency_key_seen: boolean;
}

/** D-148 § A.3.2 — bridge cancellation primitive. Server can cancel
 *  a queued or executing command; bridge attempts cooperative
 *  cancel + returns BridgeResult `status: 'cancelled'`. */
export interface BridgeCancelCommand {
  command_id: string;
  reason: string;
}

/** D-148 § A.3 — server → bridge wire-envelope union. The bridge SW
 *  parses inbound JSON text frames into one of these variants and
 *  routes to the matching handler (action executor for `command`,
 *  cancel router for `cancel`, OS-notification dispatcher for
 *  `notification`). Adding a fourth variant requires extending this
 *  union — the bridge's envelope router asserts exhaustivity, so an
 *  unhandled kind is a compile-time error.
 *
 *  Lives in `@recued/contracts` so both the server-side dispatcher
 *  (which composes the union) and the bridge-side SW (which consumes
 *  it) share one source of truth — wire-protocol drift is a
 *  compile-time failure on one side or the other. */
export type BridgeWireEnvelope =
  | { kind: 'command'; command: BridgeCommand }
  | { kind: 'cancel'; cancel: BridgeCancelCommand }
  | { kind: 'notification'; notification: ServerToBridgeNotification; receipt_request_id?: string }
  | { kind: 'notification.probe'; request_id: string }
  | { kind: 'notification.clear'; request_id: string; notification_id: string };

/** D-169 P0 Slice 1 — bridge → server wire-envelope union. Sister to
 *  `BridgeWireEnvelope` (server → bridge). Today only `result` is
 *  defined; future bridge → server frames (capability profile
 *  re-push, cancel ack, etc.) add new `kind` variants to this union.
 *
 *  Wire format: same JSON-text framing as the inbound side. The bridge
 *  serializes via `JSON.stringify` + `WsClient.send`; the server-side
 *  inbound router parses + dispatches by `kind`.
 *
 *  Lives in `@recued/contracts` so the bridge (producer) + the future
 *  server-side WS inbound router (consumer) share one source of truth.
 *  Wire-protocol drift between sides is a compile-time failure. */
export type BridgeFromBridgeWireEnvelope =
  | { kind: 'result'; result: BridgeResult }
  | { kind: 'notification_receipt'; receipt: BridgeNotificationReceipt };

export interface BridgeNotificationReceipt {
  request_id: string;
  outcome: 'ready' | 'denied' | 'displayed' | 'cleared' | 'failed';
  notification_id?: string;
}

/** D-148 § A.3.2 — queue state visible to server. Bridge enforces
 *  `max_queue_depth = 32` by default; overflow returns 429 to server. */
export interface BridgeQueueState {
  current_command_id?: string;
  queue: BridgeCommand[];
  max_queue_depth: number;
  paused: boolean;
}

export const BRIDGE_MAX_QUEUE_DEPTH = 32;
export const BRIDGE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

/** D-148 § A.3.5 — content-minimized notification payload server →
 *  bridge. Body field renders as plain text without inline detail by
 *  default (lock-screen leak protection); user opts into expanded
 *  notifications per-recipe in settings. */
export interface ServerToBridgeNotification {
  notification_id: string;
  title: string;
  body: string;
  icon_url?: string;
  /** Groups same-tag notifications to avoid spam. */
  tag?: string;
  click_action?: BridgeClickAction;
}

export type BridgeClickAction =
  | { kind: 'open_url'; url: string }
  | { kind: 'open_webclient'; path: string }
  | { kind: 'rpc_callback'; rpc: string; args: Record<string, unknown> };

/** D-148 § A.3.6 — closed list of bridge capacity gaps. The server
 *  invokes a bridge-bound ingredient + the bridge can't serve →
 *  engine returns a `capacity_gap` with one of these kinds + a
 *  remediation hint. */
export type BridgeCapacityGap =
  | { kind: 'bridge_online' }
  | { kind: 'logged_in'; site: string }
  | { kind: 'tab_unavailable'; url_pattern: string }
  | { kind: 'permission_missing'; permission: string };

/** D-169 P0 Slice 4 § N.9 / A.8 — aggregate capacity gap.
 *
 *  When the multi-bridge dispatcher exhausts every eligible bridge
 *  with `capacity_gap_*` results, it returns this aggregate. Per-bridge
 *  `gap_reason` carries the specific gap each bridge reported so the
 *  user-visible remediation surface (D-169 P2 side-panel display-only
 *  card, or recipe engine's capacity-gap projection) can render
 *  "Bridge A: tab not open; Bridge B: not logged in" instead of a
 *  generic "no bridge can serve this".
 *
 *  Sibling to `BridgeCapacityGap` (per-bridge single-gap). The
 *  dispatcher emits one or the other depending on whether the
 *  eligibility filter found 0 candidates (single `bridge_online`
 *  gap) or 1+ candidates that all returned per-bridge gaps
 *  (aggregate). */
export interface AggregateCapacityGap {
  kind: 'aggregate_capacity_gap';
  bridges: ReadonlyArray<{
    bridge_id: string;
    bridge_label: string;
    gap_reason: BridgeCapacityGap;
    /** D-335 slice H — what the Bridge said, worded for the AI to pass on
     *  ("Screenshots are off: turn on …", "Chrome's window with this page is
     *  minimized …"). Absent when it said nothing. */
    message?: string;
  }>;
}

export type BridgeCapacityRemediationAction =
  | 'show_bridge_install_prompt'
  | 'open_login_tab'
  | 'request_tab_grant'
  | 'request_permission_grant';

export interface BridgeCapacityRemediation {
  gap: BridgeCapacityGap;
  action: BridgeCapacityRemediationAction;
  user_facing_copy: string;
}

/** D-148 § A.3.4 — closed list of Chrome permissions the bridge
 *  manifest declares. Anything else is a CI lint failure (Appendix I.4).
 *  `<all_urls>` is explicitly excluded — host permissions follow the
 *  per-domain opt-in flow. */
export const BRIDGE_ALLOWED_CHROME_PERMISSIONS: ReadonlyArray<string> = [
  'storage',
  'alarms',
  'offscreen',
  'notifications',
  'tabs',
  'scripting',
  // D-169 P1 § A.3 — `sidePanel` permission enables
  // `chrome.sidePanel.open` from the SW so the action-icon click
  // routes to the side-panel viewer (the bridge's primary user
  // surface per N.5). No additional capability surface; the API
  // operates against the panel registered via the manifest's
  // `side_panel.default_path` field.
  'sidePanel',
] as const;

/** D-148 § A.3.4 — explicitly-prohibited Chrome permissions. CI gate
 *  fails any PR that adds one. */
export const BRIDGE_PROHIBITED_CHROME_PERMISSIONS: ReadonlyArray<string> = [
  'cookies',
  'webRequest',
  'webRequestBlocking',
  'history',
  'bookmarks',
  'tabCapture',
  'desktopCapture',
  'pageCapture',
  'proxy',
  'vpnProvider',
  'debugger',
  '<all_urls>',
] as const;

/** D-148 § A.3.6 — bridge capability profile carried in
 *  `context.bridge.capabilities`, pushed over the wire by D-169's
 *  `bridge.capability.push` and held per-bridge in the server's registry.
 *  ⚠ It was ALSO carried in `ReachabilityBridgeEntry`, which was deleted with
 *  the rest of the report family (2026-09-16) — reachability.ts no longer
 *  re-exports this type, and `index.ts` exports it from here. */
export interface BridgeCapabilityProfile {
  /** Bridge-side semver matching the `apps/bridge/` package version. */
  software_version: string;
  /** Major Chrome version detected at the bridge's offscreen
   *  document — `chrome.runtime.getPlatformInfo()` + UA parsing. */
  chrome_version: string;
  /** Active Chrome permissions visible to the bridge (subset of
   *  `BRIDGE_ALLOWED_CHROME_PERMISSIONS`). */
  permissions_granted: string[];
  /** Active per-domain Chrome host permissions. Shape:
   *  `['*://app.hubspot.com/*', '*://linkedin.com/*']`. */
  granted_origins: string[];
  /** Whether the offscreen-document keepalive is active. P3 gate. */
  offscreen_supported: boolean;
  /** Whether the chrome.alarms keepalive is active. P3 gate. */
  alarms_supported: boolean;
  /** Optional user-agent string for diagnostic context. */
  user_agent?: string;
  /** Private preparation metadata. The server registry removes this inventory
   * from public presence/context/diagnostic profiles. No page content. */
  dom_documents?: { version: 1; documents: BridgeDocumentIdentity[] };
  /** The `BridgeAction`s this Bridge runs (D-335). Absent on a Bridge that
   *  predates `inspect`: it runs {@link ORIGINAL_BRIDGE_ACTIONS}. Strings, since
   *  a newer Bridge may list an action this server does not know. */
  supported_actions?: string[];
}

/** D-148 § A.3.4 — closed list of fields the bridge persists in
 *  chrome.storage.local (plus an IndexedDB-backed AES-GCM key for
 *  the wrapped bearer record). The popup inspector renders these;
 *  CI gate (Appendix I.15) asserts no other stores exist.
 *
 *  D-169 P0 Slice 2B — `bridge_token` (raw bearer string) retired.
 *  The bridge now persists the same AES-GCM-wrapped `webclient_token`
 *  record the webclient does (carrying `token_id` + `ciphertext_b64`
 *  + `iv_b64` + `issued_at`), plus the two § A.4.1-aligned widenings
 *  (`pair_metadata` + `cert_pin_state`). The substrate matches
 *  `WEBCLIENT_LOCAL_STORAGE_FIELDS` for the auth + pair-state slice;
 *  the bridge-specific fields (`chrome_permissions_state`,
 *  `idempotency_cache`, `pending_outbox`) follow because the bridge
 *  carries DOM-executor state the webclient doesn't.
 *
 *  Auth pivot rationale: per § N.3 / N.8 / TR-1, two parallel auth
 *  paths (`bridge_token` + `webclient_token`) doubled the substrate
 *  surface; the bridge now follows the webclient's pair-blob flow
 *  end-to-end so a single rotation / re-pair primitive serves both
 *  paired clients. */
export const BRIDGE_LOCAL_STORAGE_FIELDS: ReadonlyArray<string> = [
  'server_url',
  'webclient_token',
  'server_public_key',
  'pair_metadata',
  'cert_pin_state',
  'chrome_permissions_state',
  'idempotency_cache',
  'pending_outbox',
  // D-335 slice G — the owner's list of sites Recued must never use: hosts,
  // kept when the Bridge is disconnected (`clear`), since dropping it would
  // let the Bridge act on a site the owner listed.
  'blocked_sites',
  // D-163 O-2's follow-up — the approvals this Bridge has shown as OS
  // notifications: ids only, the newest 200, so each shows once. An id leaves
  // once its approval closes; `clear` drops the list, unlike `blocked_sites`.
  'approval_notices_shown',
] as const;

/** Per-ingredient grant record persisted by the bridge. Three-way
 *  intersection per § A.3.4.1 binds a granted origin to a specific
 *  `(publisher_id, slug, version)` tuple — re-installing a different
 *  version of the same ingredient with a wider domain list does NOT
 *  inherit the prior grant; the user must re-confirm. P3 builds the
 *  IndexedDB persistence; P1 ships the contract + check function. */
export interface BridgeIngredientGrant {
  publisher_id: string;
  slug: string;
  version: string;
  granted_origins: string[];
  granted_at: number;
}

/** Type predicate — does this URL pattern fall within the granted
 *  origin set for a specific ingredient version? Three-way
 *  intersection enforcement (§ A.3.4.1):
 *    1. The grant must match the ingredient's
 *       `(publisher_id, slug, version)` tuple.
 *    2. The pattern must be present in the ingredient's signed
 *       `domain_allowlist` (signature verified upstream by the
 *       caller; this function trusts the ingredient ref's allowlist
 *       as already-verified).
 *    3. The pattern must be a subset of the user's granted origins
 *       for that ingredient.
 *
 *  All three must hold. Returns false if any axis fails.
 *
 *  Closed-form for use at every BridgeCommand dispatch + at every
 *  authority signature verification path. */
export const isCommandWithinIngredientGrant = (
  domain_pattern: string,
  ingredient: Pick<BridgeIngredientRef, 'publisher_id' | 'slug' | 'version' | 'domain_allowlist'>,
  grant: BridgeIngredientGrant,
): boolean => {
  // Axis 1: tuple match.
  if (grant.publisher_id !== ingredient.publisher_id) return false;
  if (grant.slug !== ingredient.slug) return false;
  if (grant.version !== ingredient.version) return false;
  // Axis 2: pattern in ingredient's signed allowlist. Membership
  // check uses the same subset semantics — pattern must be allowed
  // by at least one allowlist entry (allowlist entries are
  // wider-than-exact patterns).
  if (!isPatternWithinGrantedOrigins(domain_pattern, ingredient.domain_allowlist)) {
    return false;
  }
  // Axis 3: pattern within user's granted origins for this grant.
  return isPatternWithinGrantedOrigins(domain_pattern, grant.granted_origins);
};

/** Type predicate — does this URL pattern fall within the granted
 *  origin set? Used by the bridge at command dispatch as the second
 *  axis of three-way intersection (per § A.3.4.1). For full
 *  intersection check including ingredient-tuple binding, use
 *  `isCommandWithinIngredientGrant`. */
export const isPatternWithinGrantedOrigins = (
  domain_pattern: string,
  granted_origins: ReadonlyArray<string>,
): boolean => {
  if (granted_origins.length === 0) return false;
  // Pattern must match at least one granted origin entry.
  // Granted origins use Chrome match-pattern syntax (e.g.
  // '*://app.hubspot.com/*'). The pattern must be a subset:
  // exact equality OR pattern's host is a subdomain match for the
  // granted origin's host, AND pattern's path is a subset of the
  // granted origin's path. P1 ships the simple equality + literal-
  // host-match form; P3 widens to full Chrome match-pattern semantics.
  for (const origin of granted_origins) {
    if (domain_pattern === origin) return true;
    // Conservative subset check: same host + same path-prefix.
    const p = parseChromeMatchPattern(domain_pattern);
    const g = parseChromeMatchPattern(origin);
    if (!p || !g) continue;
    if (p.scheme !== g.scheme && g.scheme !== '*') continue;
    if (!hostMatches(p.host, g.host)) continue;
    if (!pathMatches(p.path, g.path)) continue;
    return true;
  }
  return false;
};

interface ChromeMatchPattern {
  scheme: string;
  host: string;
  path: string;
}

const parseChromeMatchPattern = (pattern: string): ChromeMatchPattern | null => {
  // Format: '<scheme>://<host>/<path>' where scheme ∈ {'*','http','https'}.
  const schemeMatch = pattern.match(/^([\w*]+):\/\/([^/]+)(\/.*)?$/);
  if (!schemeMatch) return null;
  const [, scheme, host, path] = schemeMatch;
  return { scheme, host, path: path ?? '/' };
};

/** True when `pattern` parses as a Chrome match pattern
 *  (`<scheme>://<host>[/<path>]`). The single grammar the bridge's
 *  grant intersection uses — surfaced so authoring boundaries (e.g. the
 *  `triggers.createElementWatch` dom-watch rpc) can fail closed on a
 *  malformed url BEFORE it becomes a `domain_allowlist` /
 *  `target_domain_pattern` that no `granted_origins` entry can ever
 *  match (a silently-dead watch). */
export const isValidChromeMatchPattern = (pattern: string): boolean =>
  parseChromeMatchPattern(pattern) !== null;

const hostMatches = (pattern_host: string, granted_host: string): boolean => {
  if (pattern_host === granted_host) return true;
  if (granted_host === '*') return true;
  if (granted_host.startsWith('*.')) {
    const rest = granted_host.slice(2);
    return pattern_host === rest || pattern_host.endsWith('.' + rest);
  }
  return false;
};

const pathMatches = (pattern_path: string, granted_path: string): boolean => {
  if (granted_path === '/' + '*' || granted_path === '/*') return true;
  if (granted_path === pattern_path) return true;
  // Granted '/foo/*' subsumes pattern '/foo/bar' or '/foo/*'.
  if (granted_path.endsWith('/*')) {
    const prefix = granted_path.slice(0, -2);
    return pattern_path === prefix || pattern_path.startsWith(prefix + '/');
  }
  return false;
};
