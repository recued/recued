/** D-165 P3.enroll-host — the generic `connection.*` REACH enrollment panel.
 *
 *  The host that MOUNTS `renderConnectionsPage` (D-125 Phase 7's enrollment
 *  renderer). It is the UI path to CREATE a generic connection — list / add
 *  (kind → optional subtype → form) / edit / delete / probe. Rehosted under
 *  the `Others` tab of the restructured `#connections` route (R13–R16); the
 *  foundational Mail / Calendar / Files lanes have their own panel
 *  (`connections/accounts-lane-panel.ts`). The standalone per-connection
 *  "Operation grants" matrix retired with R13.
 *
 *  ── Why the webclient is the enrollment surface ─────────────────────
 *  Enrollment means typing API keys / OAuth secrets into the PWA, which
 *  flow over the TLS-pinned pair WS to the server's connection store
 *  (the server AEAD-encrypts at rest — `collection.connection.enroll`).
 *  This is consistent with "display + HID": the webclient already
 *  accepts the 24-word recovery phrase (the system's root secret) at
 *  pair time, and D-125 Phase 7 specced the client Settings → Connections
 *  page as the enroll/edit/delete surface. Secrets never persist on the
 *  PWA — they transit to the server which owns the store.
 *
 *  ── Render model: innerHTML + delegated dispatch (NOT DOM nodes) ─────
 *  `renderConnectionsPage` returns an HTML STRING (unlike the grant
 *  panel, which builds `createElement` nodes), so this host mirrors the
 *  reception authoring mount instead: `host.innerHTML = render(...)`, a
 *  `createActionDispatcher` for the `data-action` clicks, and a sibling
 *  delegated `input` / `change` listener for the `data-conn-field` form
 *  controls. Mounted `embedded` (no standalone back-button header — the
 *  Settings section supplies the chrome).
 *
 *  ── Field edits are silent; only structural changes re-render ────────
 *  Every re-render rebuilds `host.innerHTML` and loses input focus, so a
 *  text edit must NOT re-render (you could not type a multi-char token).
 *  Text/secret edits therefore mutate `dialog.values` silently. Two
 *  exceptions re-render: a `<select>` edit (auth.type drives `showWhen`
 *  field visibility), and the first edit after a failed submit (clears
 *  the stale `dialog.error`, the deliberate single focus cost — same
 *  discipline as `reception-authoring-mount.ts`).
 *
 *  The connections renderer disables Submit live whenever
 *  `validateConnectionForm` fails (unlike reception's submit). With
 *  silent edits the rendered button would stay stale-disabled, so after
 *  each silent text edit the host imperatively syncs ONLY the submit
 *  button's `disabled` attribute (the field being typed is never
 *  rebuilt → focus preserved). The submit handler ALSO re-validates
 *  before firing the rpc, so correctness never depends on the button's
 *  visual state — the imperative sync is the browser-UX layer and
 *  no-ops where `host.querySelector` is unavailable (the string-only
 *  test host).
 *
 *  ── Optional follow-on affordances (honest, not dead) ────────────────
 *  The renderer also emits affordances whose callers may be absent in
 *  older / narrowed hosts. Rather than leave dead buttons, their clicks
 *  surface an honest message via the renderer's EXISTING state slots:
 *    - `connections-authorize-vendor` → `dialog.oauthError` (rendered
 *      above the manual Refresh-Token field, which IS usable — vendor
 *      connections enroll fine by pasting a Developer-Portal token).
 *    - `connections-engagement-toggle` → calls the D-139
 *      `collection.connection.engagementHealth` rpc when wired; otherwise
 *      expands the row's panel with `engagementHealth.error` (the panel
 *      renders error-only when its `data` is null — no dead action buttons).
 *
 *  ── Email send hydration (D-165 P3 — wired) ─────────────────────────
 *  The email-notification subtype's `sender_mail_instance` picker reads a
 *  dynamic-options list (`MAIL_SEND_CAPABLE_INSTANCES_SOURCE`). The OPTIONAL
 *  `runMailList` caller (`collection.mail.list`) hydrates it with the
 *  send-capable `data.mail.<slug>` accounts — best-effort: a missing caller
 *  or a failed rpc leaves the list empty so the field surfaces its
 *  `emptyGuidance` rather than a broken empty dropdown. Hydration is silent
 *  unless the email form is the one on screen (a populated picker only needs
 *  to repaint when it's visible — avoids stealing focus from another open
 *  form). It refreshes on mount, when the email subtype is picked (freshest
 *  at point-of-use, catches mid-session mail enrollment), and on host-driven
 *  `refresh()`. The mount gate stays at the FIVE connection callers — email
 *  hydration is additive, never a mount prerequisite.
 *
 *  Spec: docs/d-125-spec.md § 7.1 (the enrollment surface); the host
 *  mirrors `reception-authoring-mount.ts` (innerHTML + dispatcher +
 *  silent field edits). */

import type {
  BulkPackManifest,
  ConnectionAuth,
  ConnectionDataPurgeSummary,
  ConnectionHealth,
  ConnectionKind,
  ConnectionView,
  EngagementHealthResponse,
  MessageMatchPattern,
  PackListEntry,
  ReprobeEngagementCapabilitiesResponse,
} from '@recued/contracts';
import {
  OAUTH_CLOUD_CALLBACK_URL,
  GENERIC_OAUTH_VENDOR,
  getVendorProvider,
  unionRequiredScopesForConnection,
  MAX_HEADER_AUTH_ENTRIES,
  MESSAGE_MATCH_MAX_PATTERNS,
} from '@recued/contracts';
import {
  collectHeaderRows,
  collectMatchPatternRows,
  matchPatternRowsToPatterns,
  renderConnectionsPage,
  validateConnectionForm,
  initialConnectionsPageState,
  initialConnectionsDialogState,
  connectionRowKey,
  projectConnectionPayload,
  shouldPatchConnectionAuth,
  buildConnectionEditDialogPatch,
  resolveConnectionSchema,
  resolveVendorSchema,
  initialVendorSchemaValues,
  syncVendorOAuthEndpointValue,
  CONNECTION_NAME_REGEX,
  applyVendorOAuthResultValues,
  isVendorSandboxSelected,
  MAIL_SEND_CAPABLE_INSTANCES_SOURCE,
  type ConnectionsPageState,
  type ConnectionPayload,
  type ConnectionFormValues,
  type ConnectionSchema,
  type VendorOAuthResultValuePatch,
} from '@recued/ui-shared';
import { createActionDispatcher } from '@recued/ui-shared/action-dispatcher';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { humanizeRpcError } from '../shell/rpc-error-copy.js';

// ════════════════════════════════════════════════════════════════
// Caller seams
// ════════════════════════════════════════════════════════════════

/** `collection.connection.list` caller — NO kind filter (the enrollment
 *  list shows every kind, unlike the grant panel's api-only list). */
export type ConnectionsEnrollListCaller = () => Promise<{
  connections: ReadonlyArray<ConnectionView>;
}>;

/** `collection.connection.enroll` caller. Takes the `projectConnection
 *  Payload` output verbatim (its shape IS the enroll rpc input). */
export type ConnectionsEnrollCaller = (
  args: ConnectionPayload,
) => Promise<{ connection: ConnectionView; probe?: ConnectionHealth }>;

/** `collection.connection.update` caller. Identity (`kind`, `name`) is
 *  immutable; only `display_name` / `config` / `auth` patch. */
export type ConnectionsUpdateCaller = (args: {
  name: string;
  kind: ConnectionKind;
  patch: {
    display_name?: string;
    config?: Record<string, unknown>;
    auth?: ConnectionAuth;
  };
}) => Promise<{ connection: ConnectionView }>;

/** `collection.connection.delete` caller. D-192 slice 5 — `remove_mirror_data`
 *  carries the confirm dialog's "also remove the [N] item(s)" opt-in (default
 *  off); `purged` returns the per-facet teardown counts when it ran. */
export type ConnectionsDeleteCaller = (args: {
  name: string;
  kind: ConnectionKind;
  remove_mirror_data?: boolean;
}) => Promise<{ deleted: boolean; purged?: ConnectionDataPurgeSummary }>;

/** D-192 slice 5 — `collection.connection.previewPurge` caller. The removal
 *  dialog fetches it on open to label the "also remove the [N] item(s)"
 *  checkbox with the count a `remove_mirror_data: true` delete would remove
 *  (api CRM mirror + work-entity records; messenger contact-link
 *  associations). Returns 0 for a non-purgeable connection. */
export type ConnectionsPreviewPurgeCaller = (args: {
  name: string;
  kind: ConnectionKind;
}) => Promise<{ count: number }>;

/** D-192 M4c-UI — `collection.connection.getMatchPatterns` caller. Reads a
 *  messenger connection's stored triggers (stripped from `ConnectionView`, so
 *  the edit form seeds the trigger editor from this). */
export type ConnectionsGetMatchPatternsCaller = (args: {
  name: string;
  kind: ConnectionKind;
}) => Promise<{ match_patterns: MessageMatchPattern[] }>;

/** D-192 M4c-UI — `collection.connection.setMatchPatterns` caller. Merge-writes
 *  the triggers (preserving other config); fired by the submit handler
 *  alongside the connection enroll/update. */
export type ConnectionsSetMatchPatternsCaller = (args: {
  name: string;
  kind: ConnectionKind;
  match_patterns: MessageMatchPattern[];
}) => Promise<{ match_patterns: MessageMatchPattern[] }>;

/** `collection.connection.probe` caller. */
export type ConnectionsProbeCaller = (args: {
  name: string;
  kind: ConnectionKind;
}) => Promise<{ health: ConnectionHealth }>;

/** `collection.connection.engagementHealth` caller — OPTIONAL D-139 P2
 *  per-entity health surface for HubSpot / Salesforce api connections. */
export type ConnectionsEngagementHealthCaller = (args: {
  name: string;
}) => Promise<EngagementHealthResponse>;

/** `collection.connection.reprobeEngagementCapabilities` caller —
 *  OPTIONAL D-139 P2 Salesforce-only capability re-probe. */
export type ConnectionsReprobeEngagementCapabilitiesCaller = (args: {
  name: string;
}) => Promise<ReprobeEngagementCapabilitiesResponse>;

/** `collection.mail.list` caller — the OPTIONAL 6th caller (D-165 P3, email
 *  send hydration). Hydrates the email-notification `sender_mail_instance`
 *  picker's dynamic-options list (`MAIL_SEND_CAPABLE_INSTANCES_SOURCE`) with
 *  the send-capable `data.mail.<slug>` instance slugs. When absent the email
 *  subtype degrades honestly to its `emptyGuidance` ("Configure SMTP first…")
 *  — the panel still mounts (the mount gate stays at the five connection
 *  callers). Only `slug` + `send_capable` are consumed; the rpc returns more
 *  per instance (structurally wider returns are accepted). */
export type ConnectionsMailListCaller = () => Promise<{
  instances: ReadonlyArray<{ slug: string; send_capable: boolean }>;
}>;

/** `collection.connection.startVendorOAuth` caller (D-165 slice 3). Returns
 *  the authorize URL the popup is sent to, plus the `flow_id`, the server-
 *  identity public key the cloud callback page verifies the signed state
 *  against, and the owner-binding `claim_secret` the dialog presents to
 *  `runTakeVendorOAuthResult`. */
export type ConnectionsStartVendorOAuthCaller = (args: {
  vendor: string;
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  sandbox?: boolean;
  /** R14 — form-supplied OAuth config for a generic (non-registry) vendor.
   *  When present the server synthesizes the provider from these instead of
   *  resolving `vendor` in the registry, so the in-app consent dance runs for
   *  any BYO vendor. */
  authorize_url?: string;
  token_endpoint?: string;
  scopes?: string[];
}) => Promise<{
  authorize_url: string;
  flow_id: string;
  server_identity_public_key_b64: string;
  claim_secret: string;
}>;

/** `collection.connection.takeVendorOAuthResult` caller (D-165 slice 3). The
 *  owner-bound claim fired when the `connection.vendor_oauth_completed`
 *  broadcast matches the dialog's own `flow_id`. `result` is null on a wrong
 *  secret / already-claimed / expired flow. */
export type ConnectionsTakeVendorOAuthResultCaller = (args: {
  flow_id: string;
  claim_secret: string;
}) => Promise<{
  result: { refresh_token: string; granted_scopes: string[]; instance_url?: string } | null;
}>;

/** The blank popup handle the panel opens synchronously inside the click
 *  gesture (a post-`await` `window.open` is popup-blocked) and navigates to
 *  the authorize URL once the start rpc returns. Structurally satisfied by a
 *  real `Window`. */
export interface VendorOAuthPopupHandle {
  readonly closed: boolean;
  close(): void;
  location: { href: string };
  /** The popup's OWN sessionStorage. While the popup is still the
   *  about:blank window we opened, it is same-origin with the opener
   *  (`app.recued.com`), so we can write the cached server-identity public
   *  key (`oauth_jwks_<flow_id>`) into THIS context BEFORE navigating it.
   *  sessionStorage is scoped per top-level browsing context, so the cloud
   *  callback page — which later loads in this same popup after the vendor
   *  bounce — reads it from here, NOT from the opener's storage. */
  sessionStorage?: Pick<Storage, 'setItem'>;
  /** The popup's back-reference to this app. We null it before navigating to
   *  the (cross-origin) vendor consent page so a malicious / compromised
   *  authorize page cannot reach back and navigate the main app tab (reverse
   *  tabnabbing) — `noopener` on `window.open` would null the handle we need
   *  to write sessionStorage + detect blocking, so we sever it explicitly
   *  instead. Settable on a real `Window`. */
  opener?: unknown;
}

/** Narrow browser seam for the vendor OAuth popup — injectable so the panel
 *  unit-tests without a real `window` (the test host is string-only). The
 *  default wraps `globalThis.window`; absent it (non-browser) the
 *  "Authorize" button degrades to the honest manual-token fallback. The
 *  jwks write targets the POPUP's sessionStorage (see
 *  {@link VendorOAuthPopupHandle}), not the opener's, so no opener storage
 *  is needed here. */
export interface VendorOAuthBrowserEnv {
  open(url: string, target: string): VendorOAuthPopupHandle | null;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MountConnectionsEnrollPanelOptions {
  /** Host element the page renders into — replaced on every structural
   *  re-render, cleared on `dispose()`. */
  host: HTMLElement;
  /** DOM document seam. Defaults to `globalThis.document`. */
  document?: Document;
  runList: ConnectionsEnrollListCaller;
  runEnroll: ConnectionsEnrollCaller;
  runUpdate: ConnectionsUpdateCaller;
  runDelete: ConnectionsDeleteCaller;
  /** D-192 slice 5 — OPTIONAL removal-preview count. Present → the delete
   *  confirm dialog fetches the "[N] item(s)" count on open and shows the "also
   *  remove the mirrored data" checkbox; absent (or a 0 count) → the dialog is a
   *  plain confirm with no checkbox (the delete still works, mirror data kept —
   *  the ratified default). */
  runPreviewPurge?: ConnectionsPreviewPurgeCaller;
  runProbe: ConnectionsProbeCaller;
  /** D-192 M4c-UI — messenger trigger read + merge-write. Present → the
   *  slack/telegram "Message triggers" editor pre-populates (on edit) and
   *  saves alongside the connection. Absent → the editor renders but triggers
   *  don't persist (graceful degrade; the connection config still saves). */
  runGetMatchPatterns?: ConnectionsGetMatchPatternsCaller;
  runSetMatchPatterns?: ConnectionsSetMatchPatternsCaller;
  /** OPTIONAL — D-139 P2 engagement-health surface. Present → expanding a
   *  HubSpot / Salesforce row hydrates the inline health table; absent → the
   *  row expands with an honest unavailable error. */
  runEngagementHealth?: ConnectionsEngagementHealthCaller;
  /** OPTIONAL — D-139 P2 Salesforce capability re-probe. Present → the
   *  Salesforce "Re-probe capabilities" button calls the rpc and patches
   *  refreshed rows + PushTopic status into the panel; absent → the panel
   *  surfaces an honest unavailable error. */
  runReprobeEngagementCapabilities?: ConnectionsReprobeEngagementCapabilitiesCaller;
  /** OPTIONAL — `collection.mail.list` caller. Present → the email
   *  `sender_mail_instance` picker is hydrated with send-capable accounts;
   *  absent → the picker shows its `emptyGuidance` (the email subtype stays
   *  enrollable for nothing, but degrades honestly). See
   *  {@link ConnectionsMailListCaller}. */
  runMailList?: ConnectionsMailListCaller;
  /** OPTIONAL (D-165 slice 3) — vendor OAuth popup callers + bus. The
   *  "Authorize with <Vendor>" button runs the real popup dance ONLY when
   *  ALL THREE of `runStartVendorOAuth` / `runTakeVendorOAuthResult` /
   *  `subscribe` are wired AND a browser env is available; otherwise it
   *  degrades to the honest "paste a refresh token" fallback. `subscribe`
   *  is the shared `BroadcastSubscriber['on']`; the panel listens for the
   *  `connection.vendor_oauth_completed` frame matching its own `flow_id`. */
  runStartVendorOAuth?: ConnectionsStartVendorOAuthCaller;
  runTakeVendorOAuthResult?: ConnectionsTakeVendorOAuthResultCaller;
  subscribe?: BroadcastSubscriber['on'];
  /** OPTIONAL browser seam for the popup + sessionStorage + timers. Defaults
   *  to `globalThis.window`; injected in tests. */
  oauthEnv?: VendorOAuthBrowserEnv;
  /** OPTIONAL (Fork 1 B) — `packs.list` caller. Present → opening a registered
   *  vendor's enroll dialog pre-fills the editable `Scopes` field with the
   *  vendor defaults UNIONed with the installed packs' `required_scopes` for
   *  that vendor, and the start passes the (edited) set. Absent / failed → the
   *  field stays blank and the server computes the union itself (Fork 1 A). */
  runPacksList?: () => Promise<{ packs: ReadonlyArray<PackListEntry> }>;
  /** OPTIONAL (packs "Set up" deep link) — a vendor segment to open the
   *  enroll form pre-selected for, once the initial load settles (the packs
   *  fetch rides the load, so the registered-vendor scope pre-fill is ready).
   *  A registered vendor opens its vendor form (same path as clicking its
   *  picker card); an unregistered API-key vendor (Stripe, Exa, …) opens the
   *  bare `api` form seeded with `name` + the hidden `config.vendor` tag so
   *  readiness vendor-matching recognizes the enrollment. Ignored when it
   *  fails the connection-name regex or the user has already begun a dialog
   *  interaction by the time the load settles. */
  initialVendor?: string;
}

export interface ConnectionsEnrollPanelMount {
  /** The full page state — the primary surface for tests + host
   *  introspection (dialog stage, form values, enrolled rows, errors). */
  getState(): ConnectionsPageState;
  /** Host-driven refresh — re-lists enrolled connections. Returns the
   *  load promise. */
  refresh(): Promise<void>;
  /** Initial / most-recent load promise — resolves after the list settles. */
  whenLoaded(): Promise<void>;
  /** Tear down both dispatchers + clear the host. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Action union + small helpers
// ════════════════════════════════════════════════════════════════

/** The `data-action` strings this host handles. */
type ConnectionsEnrollAction =
  | 'connections-open-add'
  | 'connections-pick-kind'
  | 'connections-pick-vendor'
  | 'connections-pick-subtype'
  | 'connections-back-to-kind'
  | 'connections-back-to-subtype'
  | 'connections-cancel-dialog'
  | 'connections-submit-form'
  | 'connections-add-header'
  | 'connections-remove-header'
  | 'connections-add-pattern'
  | 'connections-remove-pattern'
  | 'connections-edit'
  | 'connections-probe'
  | 'connections-delete'
  | 'connections-delete-confirm'
  | 'connections-delete-cancel'
  | 'connections-delete-toggle-mirror'
  | 'connections-authorize-vendor'
  | 'connections-engagement-toggle'
  | 'connections-engagement-reprobe'
  | 'connections-engagement-install-puller'
  | 'connections-engagement-configure-cadence';

const SUBMIT_SELECTOR = '[data-action="connections-submit-form"]';
const VALID_KINDS: ReadonlySet<string> = new Set(['api', 'mcp', 'notification']);

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

const asKind = (raw: string | undefined): ConnectionKind | null =>
  raw !== undefined && VALID_KINDS.has(raw) ? (raw as ConnectionKind) : null;

/** Seed a bare-kind form's `<select>` defaults so the first-option the
 *  renderer auto-selects is actually captured into `values` (the renderer
 *  shows option[0] selected, but never writes it to state until the user
 *  changes it — without this seed an untouched `auth.type` would project
 *  as absent → `{ type: 'none' }`). Vendor flows seed via
 *  `initialVendorSchemaValues` instead (includes locked/hidden fields). */
const seedSchemaDefaults = (schema: ConnectionSchema): ConnectionFormValues => {
  const values: ConnectionFormValues = {};
  for (const field of schema.fields) {
    if (
      field.type === 'select'
      && !field.options_source
      && field.options
      && field.options.length > 0
    ) {
      values[field.key] = field.options[0]!;
    }
  }
  return values;
};

// ════════════════════════════════════════════════════════════════
// Vendor OAuth popup (D-165 slice 3)
// ════════════════════════════════════════════════════════════════

/** How long the dialog waits for the `connection.vendor_oauth_completed`
 *  broadcast before giving up. The happy path is the bus event (sub-second
 *  after the user consents); this is the safety net for a denied / abandoned
 *  / popup-closed flow, which fires no completion broadcast. */
const VENDOR_OAUTH_TIMEOUT_MS = 5 * 60_000;

/** sessionStorage key the cloud callback page reads the cached server-identity
 *  public key from. MUST match `oauth-callback.ts`'s `'oauth_jwks_' + flow_id`. */
const oauthJwksKey = (flow_id: string): string => `oauth_jwks_${flow_id}`;

/** Derive the default browser env from `globalThis.window`. Returns undefined
 *  in a non-browser host so the "Authorize" button falls back honestly. The
 *  popup it returns from `open` is a real `Window`, which exposes the
 *  `.sessionStorage` the jwks is written into (per-popup, not the opener). */
const defaultVendorOAuthEnv = (): VendorOAuthBrowserEnv | undefined => {
  const w = (globalThis as { window?: Window }).window;
  if (!w || typeof w.open !== 'function') return undefined;
  return {
    open: (url, target) =>
      w.open(url, target) as unknown as VendorOAuthPopupHandle | null,
    setTimeout: (fn, ms) => w.setTimeout(fn, ms),
    clearTimeout: (h) => w.clearTimeout(h as number),
  };
};

/** Live pending-flow state the click handler hands off to the async driver +
 *  the completion bus listener. The `claim_secret` lives ONLY here (a closure
 *  variable), never in rendered dialog state. */
interface PendingVendorOAuth {
  flow_id: string;
  claim_secret: string;
  vendor: string;
  sandbox: boolean;
  /** Captured `dialogGen` — a completion is dropped if the user navigated the
   *  dialog away mid-flow (matches the submit / list staleness discipline). */
  dialogGen: number;
  popup: VendorOAuthPopupHandle;
  timer: unknown | null;
}

// ════════════════════════════════════════════════════════════════
// Mount
// ════════════════════════════════════════════════════════════════

export const mountConnectionsEnrollPanel = (
  opts: MountConnectionsEnrollPanelOptions,
): ConnectionsEnrollPanelMount => {
  const doc =
    opts.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'mountConnectionsEnrollPanel: no document available — pass `opts.document` for non-browser environments',
    );
  }

  const { host } = opts;
  const state: ConnectionsPageState = initialConnectionsPageState();
  let disposed = false;
  // Bumped before every list await; a post-await write only lands when its
  // captured generation is still current (drops a stale in-flight list when
  // a newer refresh / delete-driven re-list overtakes it).
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  // Bumped by every dialog navigation (open / pick / back / cancel / edit /
  // reset). A submit captures the current value before its rpc; if a
  // navigation bumps it mid-flight, the completion is stale and must not
  // reset / clobber the newer dialog the user has moved on to.
  let dialogGen = 0;
  // D-192 slice 5 — monotonic token per delete-confirm open. A late-landing
  // previewPurge result may only write its count when its captured seq still
  // matches — so a cancel+reopen (even of the SAME row) drops an earlier,
  // slower preview instead of filling the fresh modal with a stale count.
  let deletePreviewSeq = 0;
  // D-192 M4c-UI — is the current edit dialog's messenger trigger editor
  // trustworthy to write? Default true (create has nothing stored to lose;
  // non-messenger has no trigger field). Set FALSE when a messenger EDIT dialog
  // opens (its triggers are stripped from the view, so the editor starts empty
  // until `hydrateMatchPatterns` loads them) and back TRUE on a successful load.
  // The submit gate refuses to write triggers on an un-hydrated edit, so a
  // failed / still-in-flight read can never silently wipe the stored triggers.
  let matchPatternsHydrated = true;
  // SURVIVES dialog navigation (unlike `dialog.saving`, which a Back clears).
  // Blocks a SECOND write rpc while one is still settling — without it a user
  // could Back out of a slow enroll, submit again, and race two concurrent
  // upsert writes whose server-side order is undefined.
  //
  // SCOPE: this fences one MOUNTED panel. It does NOT survive a Settings route
  // remount (a fresh mount starts unlocked) — `dispose()` doesn't abort the
  // already-issued rpc, the same ambient property every webclient write panel
  // has (none abort on dispose). Nor does it fence a second CLIENT. The real
  // cross-remount / cross-client guard is server-side CAS / idempotency on the
  // `collection.connection.enroll` upsert — a server concern, not this host's
  // (a module-global lock here would risk a permanent global wedge if an rpc
  // never settled). The narrow in-view concurrent-submit case is what this
  // closes; the outcome of the tail race is recoverable last-write-wins on a
  // record the user is actively creating.
  let submitInFlight = false;
  // Bumped before every mail-list await; a post-await write only lands when its
  // captured generation is still current (a slow earlier hydrate can't clobber
  // a newer one — the email-subtype-pick / refresh paths can overlap the mount
  // hydrate). Separate from `loadGeneration` so a mail-list outcome never
  // touches the connection-list view.
  let mailOptionsGen = 0;
  // D-165 slice 3 — vendor OAuth popup. The browser seam (popup + same-origin
  // sessionStorage + timers); undefined → the "Authorize" button falls back to
  // the honest manual-token message. `pendingOAuth` holds the live flow incl.
  // the `claim_secret` (closure-only, never rendered). `oauthUnsub` is the bus
  // subscription torn down on dispose.
  const oauthEnv = opts.oauthEnv ?? defaultVendorOAuthEnv();
  let pendingOAuth: PendingVendorOAuth | null = null;
  let oauthUnsub: (() => void) | null = null;

  const render = (): void => {
    if (disposed) return;
    host.innerHTML = renderConnectionsPage({ ...state, layout: 'embedded' });
  };

  // ── Email send-from options hydration (best-effort, D-165 P3) ──
  // Fills the email-notification `sender_mail_instance` picker's dynamic list
  // from `collection.mail.list` (send-capable slugs only). No-op without the
  // optional caller; a failed rpc leaves the list empty (→ the field's
  // `emptyGuidance`) and never touches `state.error` — the connection list is
  // the panel's primary concern, and the email subtype must degrade honestly,
  // not block. Re-renders ONLY when the email form is on screen so a populated
  // picker repaints in place without stealing focus from another open form.
  const hydrateMailOptions = (): Promise<void> => {
    const run = opts.runMailList;
    if (run === undefined) return Promise.resolve();
    const gen = ++mailOptionsGen;
    return (async () => {
      try {
        const { instances } = await run();
        if (disposed || gen !== mailOptionsGen) return;
        const slugs = instances
          .filter((i) => i.send_capable)
          .map((i) => i.slug);
        state.dynamicOptions = {
          ...state.dynamicOptions,
          [MAIL_SEND_CAPABLE_INSTANCES_SOURCE]: slugs,
        };
        const onEmailForm =
          state.dialog.stage === 'form'
          && state.dialog.kind === 'notification'
          && state.dialog.subtype === 'email';
        if (onEmailForm) {
          // Reconcile a now-stale selection: if the open email form points at a
          // sender the refresh just dropped (an account that lost send
          // capability, or an edit-prefilled sender no longer in the list),
          // clear it so the picker resets to "— select —" instead of silently
          // holding an account the user can no longer see. `validateConnection
          // Form` also rejects a non-member value (the hard gate); clearing here
          // keeps state ↔ display consistent. Derived from the schema's
          // `options_source`, not a hard-coded field key.
          const emailSchema = resolveConnectionSchema('notification', 'email');
          let nextValues = state.dialog.values;
          for (const field of emailSchema?.fields ?? []) {
            if (field.options_source !== MAIL_SEND_CAPABLE_INSTANCES_SOURCE) continue;
            const cur = nextValues[field.key];
            if (cur && !slugs.includes(cur)) {
              nextValues = { ...nextValues, [field.key]: '' };
            }
          }
          state.dialog.values = nextValues;
          render();
        }
      } catch {
        // Best-effort, last-known-good: a failed refresh RETAINS the prior
        // list (deliberate — a transient mail.list blip shouldn't wipe the
        // accounts a successful mount pre-warm already fetched and strand a
        // user with valid send-capable mail). If no prior hydrate ever
        // succeeded the list stays empty → the field's emptyGuidance.
        //
        // The picker is UX guidance, NOT the send-capability boundary: the
        // membership gate (validateConnectionForm) stops a value OUTSIDE the
        // displayed list from being submitted, and the SERVER is authoritative
        // — kernel `mail-send` / `connection-notification` re-check
        // `send_capable` at send time (and the enroll-time `verify_send_capable`
        // probe, a connection-handler P4.x placeholder today, is the proper
        // closure). So a sender that lost capability between the last good
        // hydrate and submit fails LOUDLY at send time, never silent — a
        // cache→send TOCTOU no client refresh can close. Swallow here; never
        // block enrollment on a list-fetch failure.
      }
    })();
  };

  // ── Vendor OAuth popup (D-165 slice 3) ────────────────────────
  // The "Authorize with <Vendor>" button runs the Model-B dance: start rpc
  // (signs a state token + stashes the pending flow) → cache the server-
  // identity public key in same-origin sessionStorage for the cloud callback
  // page → open the consent popup → on the `{ flow_id }` completion broadcast,
  // claim the exchanged credential point-to-point (owner-bound by
  // `claim_secret`) and patch it into the form. The refresh token never rides
  // the bus; the claim secret never leaves this closure.
  const vendorOAuthWired = (): boolean =>
    opts.runStartVendorOAuth !== undefined
    && opts.runTakeVendorOAuthResult !== undefined
    && opts.subscribe !== undefined
    && oauthEnv !== undefined;

  const closePopupQuietly = (popup: VendorOAuthPopupHandle): void => {
    try {
      if (!popup.closed) popup.close();
    } catch {
      // a cross-origin popup may refuse `.closed` / `.close()` — ignore
    }
  };

  /** Tear down the live flow's popup + timer. Idempotent; leaves dialog state
   *  to the caller (navigation handlers reset it themselves). Closing the
   *  popup destroys its sessionStorage, so the cached jwks needs no separate
   *  cleanup. */
  const cancelPendingOAuth = (): void => {
    const p = pendingOAuth;
    if (p === null) return;
    pendingOAuth = null;
    if (p.timer !== null) oauthEnv?.clearTimeout(p.timer);
    closePopupQuietly(p.popup);
  };

  /** Settle the flow into the dialog (success patch or error), then clear the
   *  pending flow + its popup/timer. A completion is dropped (state untouched)
   *  if the user navigated the dialog away mid-flow — matches the submit /
   *  list staleness discipline. */
  const settlePendingOAuth = (
    p: PendingVendorOAuth,
    outcome:
      | { result: { refresh_token: string; granted_scopes: string[]; instance_url?: string } }
      | { error: string },
  ): void => {
    if (p.timer !== null) oauthEnv?.clearTimeout(p.timer);
    closePopupQuietly(p.popup);
    // Fail closed for a STALE attempt: object identity is the generation, so a
    // late `runTake` resolving after this flow already timed out (or after a
    // retry replaced it with a newer flow) is no longer current and must NOT
    // patch its credential into the dialog — that would write a stale token
    // into a settled form / a newer pending flow. Tear its popup/timer down
    // (above) but leave the dialog alone.
    if (pendingOAuth !== p) return;
    pendingOAuth = null;
    if (disposed || p.dialogGen !== dialogGen) return;
    state.dialog.oauthInFlight = false;
    if ('error' in outcome) {
      state.dialog.oauthError = outcome.error;
    } else {
      const patch: VendorOAuthResultValuePatch = {
        refresh_token: outcome.result.refresh_token,
        ...(outcome.result.instance_url !== undefined
          ? { instance_url: outcome.result.instance_url }
          : {}),
      };
      state.dialog.values = applyVendorOAuthResultValues(
        p.vendor,
        state.dialog.values,
        patch,
        { sandbox: p.sandbox },
      );
      state.dialog.oauthGrantedScopes = outcome.result.granted_scopes;
      state.dialog.oauthError = null;
    }
    render();
  };

  /** Completion bus listener — fires on EVERY paired client, but only the one
   *  holding the matching `claim_secret` (this client, if it started the flow)
   *  gets a non-null result back. */
  const onVendorOAuthCompleted = async (flow_id: string): Promise<void> => {
    const p = pendingOAuth;
    if (p === null || p.flow_id !== flow_id) return; // not our flow
    const runTake = opts.runTakeVendorOAuthResult;
    if (runTake === undefined) return;
    let claimed: Awaited<ReturnType<ConnectionsTakeVendorOAuthResultCaller>>;
    try {
      claimed = await runTake({ flow_id, claim_secret: p.claim_secret });
    } catch (err) {
      settlePendingOAuth(p, { error: errMessage(err) });
      return;
    }
    if (claimed.result === null) {
      // null = already consumed (a duplicate broadcast) or wrong secret. Don't
      // error or clear — a re-fire after a successful claim is a no-op, and the
      // timeout still covers a genuinely-stuck flow.
      return;
    }
    settlePendingOAuth(p, { result: claimed.result });
  };

  /** Async half of the click handler: start the flow, cache the jwks, navigate
   *  the (already-open) popup, and arm the completion timeout. */
  const driveVendorOAuth = async (ctx: {
    vendor: string;
    client_id: string;
    client_secret: string;
    sandbox: boolean;
    popup: VendorOAuthPopupHandle;
    dialogGen: number;
    /** R14 — form-supplied OAuth config (generic BYO vendor). Absent for a
     *  registered-vendor flow (the server resolves the registry). */
    authorize_url?: string;
    token_endpoint?: string;
    scopes?: string[];
  }): Promise<void> => {
    const runStart = opts.runStartVendorOAuth;
    if (runStart === undefined || oauthEnv === undefined) {
      closePopupQuietly(ctx.popup);
      return;
    }
    let started: Awaited<ReturnType<ConnectionsStartVendorOAuthCaller>>;
    try {
      started = await runStart({
        vendor: ctx.vendor,
        client_id: ctx.client_id,
        ...(ctx.client_secret ? { client_secret: ctx.client_secret } : {}),
        // Model B — the user registers the cloud callback page as their BYO
        // vendor app's redirect URI; it shares this origin's sessionStorage.
        redirect_uri: OAUTH_CLOUD_CALLBACK_URL,
        sandbox: ctx.sandbox,
        ...(ctx.authorize_url !== undefined ? { authorize_url: ctx.authorize_url } : {}),
        ...(ctx.token_endpoint !== undefined ? { token_endpoint: ctx.token_endpoint } : {}),
        ...(ctx.scopes !== undefined ? { scopes: ctx.scopes } : {}),
      });
    } catch (err) {
      closePopupQuietly(ctx.popup);
      if (!disposed && ctx.dialogGen === dialogGen) {
        state.dialog.oauthInFlight = false;
        state.dialog.oauthError = errMessage(err);
        render();
      }
      return;
    }
    // User navigated away (or the panel disposed) while the start rpc was in
    // flight — abandon: close the popup, write nothing into a moved-on dialog.
    if (disposed || ctx.dialogGen !== dialogGen) {
      closePopupQuietly(ctx.popup);
      return;
    }
    // Cache the server-identity public key for the cloud callback page, into
    // the POPUP's OWN sessionStorage — the popup is still the same-origin
    // about:blank window we opened, so this lands in the browsing context the
    // callback page later loads into (after the vendor bounce), NOT the
    // opener's. Must precede navigation (once it leaves our origin we lose
    // access). Best-effort — the direct-redirect path doesn't need it and a
    // private-mode / closed-popup failure shouldn't abort.
    try {
      ctx.popup.sessionStorage?.setItem(
        oauthJwksKey(started.flow_id),
        started.server_identity_public_key_b64,
      );
    } catch {
      /* ignore */
    }
    // Sever the popup's back-reference to this app BEFORE handing it to the
    // cross-origin vendor — the authorize page must not be able to navigate
    // our tab (reverse tabnabbing). Done after the same-origin sessionStorage
    // write (which doesn't depend on the opener link) and before navigation.
    // The opener's own handle to the popup is unaffected, so `popup.close()`
    // on settle still works.
    try {
      (ctx.popup as { opener?: unknown }).opener = null;
    } catch {
      /* ignore — some hosts make `opener` read-only */
    }
    // Send the already-open popup to the vendor consent screen.
    try {
      ctx.popup.location.href = started.authorize_url;
    } catch {
      closePopupQuietly(ctx.popup);
      state.dialog.oauthInFlight = false;
      state.dialog.oauthError = 'Could not open the authorization page — try again.';
      render();
      return;
    }
    const timer = oauthEnv.setTimeout(() => {
      const p = pendingOAuth;
      if (p !== null && p.flow_id === started.flow_id) {
        settlePendingOAuth(p, {
          error: 'Authorization timed out — close the popup and try again.',
        });
      }
    }, VENDOR_OAUTH_TIMEOUT_MS);
    pendingOAuth = {
      flow_id: started.flow_id,
      claim_secret: started.claim_secret,
      vendor: ctx.vendor,
      sandbox: ctx.sandbox,
      dialogGen: ctx.dialogGen,
      popup: ctx.popup,
      timer,
    };
  };

  /** Click handler — SYNCHRONOUS up to `window.open` so the popup survives the
   *  blocker, then hands off to the async driver. */
  const startVendorOAuthFromClick = (): void => {
    const dialog = state.dialog;
    const vendor = dialog.vendor;
    // R14 — a generic `api` oauth2_refresh form (no registered vendor) runs the
    // dance with the typed authorize/token URLs + scopes.
    const isGeneric =
      vendor === null
      && dialog.kind === 'api'
      && dialog.values['auth.type'] === 'oauth2_refresh';
    if (
      !vendorOAuthWired()
      || oauthEnv === undefined
      || (vendor === null && !isGeneric)
    ) {
      dialog.oauthError =
        'In-app authorization is not available in this view yet. Paste a refresh token below — create one in your Developer Portal app.';
      render();
      return;
    }
    if (pendingOAuth !== null) return; // one flow at a time
    const client_id = (dialog.values['auth.client_id'] ?? '').trim();
    if (client_id.length === 0) {
      dialog.oauthError = 'Enter your OAuth client ID before authorizing.';
      render();
      return;
    }
    // Generic flow — read the typed OAuth config off the form (the server
    // synthesizes the provider from it). Both URLs are required to authorize;
    // otherwise point the user at the paste-a-token fallback.
    // Fork 1 B — the (pre-filled, editable) scopes the user authorized. Both
    // paths read the same field: generic carries them in `formConfig` (with the
    // typed URLs); a registered vendor passes them so the server requests
    // const ∪ these. Blank → the server unions the installed packs itself (A).
    const scopes = (dialog.values['auth.scopes'] ?? '')
      .trim()
      .split(/\s+/)
      .filter((s) => s.length > 0);
    let formConfig:
      | { authorize_url: string; token_endpoint: string; scopes: string[] }
      | null = null;
    if (vendor === null) {
      const authorize_url = (dialog.values['auth.authorize_url'] ?? '').trim();
      const token_endpoint = (dialog.values['auth.token_endpoint'] ?? '').trim();
      if (authorize_url.length === 0 || token_endpoint.length === 0) {
        dialog.oauthError =
          'Enter the Authorize URL and Token Endpoint to authorize in-app (or paste a refresh token below).';
        render();
        return;
      }
      formConfig = { authorize_url, token_endpoint, scopes };
    }
    // Open the popup INSIDE the gesture (a post-await open is blocked); the
    // async driver navigates this blank window to the authorize URL.
    const popup = oauthEnv.open('', '_blank');
    if (popup === null) {
      dialog.oauthError = 'Popup blocked — allow popups for this site, then try again.';
      render();
      return;
    }
    const client_secret = (dialog.values['auth.client_secret'] ?? '').trim();
    const sandbox = isVendorSandboxSelected(dialog.values);
    dialog.oauthError = null;
    dialog.oauthInFlight = true;
    render();
    void driveVendorOAuth({
      // Registered flow keeps its vendor slug; a generic flow uses the generic
      // sentinel (NOT the connection name — a name colliding with a registered
      // slug would route the server to the registry path and ignore the typed
      // endpoints).
      vendor: vendor ?? GENERIC_OAUTH_VENDOR,
      client_id,
      client_secret,
      sandbox,
      popup,
      dialogGen,
      ...(formConfig ?? {}),
      // Registered flow: pass the editable scopes (generic already carries them
      // in formConfig). Empty → omitted → the server computes the union (A).
      ...(vendor !== null && scopes.length > 0 ? { scopes } : {}),
    });
  };

  // Subscribe once at mount — the listener no-ops until a flow this client
  // started is live (`pendingOAuth` matches the broadcast `flow_id`).
  if (opts.subscribe !== undefined) {
    oauthUnsub = opts.subscribe('connection.vendor_oauth_completed', (event) => {
      void onVendorOAuthCompleted(event.flow_id);
    });
  }

  // ── Dialog transitions ────────────────────────────────────────
  const resetDialog = (): void => {
    cancelPendingOAuth();
    dialogGen += 1;
    // Preserve the recent-probe banner across a dialog close so the
    // post-save probe outcome stays visible above the list.
    const recentProbe = state.dialog.recentProbe ?? null;
    state.dialog = { ...initialConnectionsDialogState(), recentProbe };
  };

  /** Begin an IN-PLACE dialog navigation (Back / pick a different kind or
   *  subtype). Bumps `dialogGen` so any in-flight submit's completion is
   *  treated as stale, AND clears `saving` — these handlers mutate the
   *  existing dialog object, so without this a Back clicked mid-save would
   *  leave `saving=true` stuck on the next form (the re-entrancy guard then
   *  wedges every later submit). `resetDialog` / `edit` instead REPLACE the
   *  dialog with a fresh `saving:false` object, so they don't need this. */
  const beginDialogNavigation = (): void => {
    cancelPendingOAuth();
    dialogGen += 1;
    state.dialog.saving = false;
    // A Back/pick clicked mid-OAuth must not leave the new form stuck on
    // "Authorizing…" (this mutates the existing dialog object in place).
    state.dialog.oauthInFlight = false;
  };

  const activeSchema = (): ConnectionSchema | undefined =>
    state.dialog.kind === null
      ? undefined
      : resolveConnectionSchema(
          state.dialog.kind,
          state.dialog.subtype ?? undefined,
          state.dialog.vendor ?? undefined,
        );

  // ── Imperative Submit-disabled sync (cosmetic; browser-UX only) ──
  // Keeps the live-validation-gated Submit button in sync after a SILENT
  // text edit, touching ONLY its `disabled` attribute so the edited field
  // is never rebuilt (focus preserved). The submit handler re-validates
  // regardless, so this is not load-bearing for correctness — and it
  // no-ops where `querySelector` is unavailable (the test host).
  const syncSubmitDisabled = (): void => {
    if (typeof host.querySelector !== 'function') return;
    const schema = activeSchema();
    if (schema === undefined) return;
    const btn = host.querySelector(SUBMIT_SELECTOR);
    if (btn === null) return;
    const valid =
      validateConnectionForm(
        schema,
        state.dialog.values,
        state.dynamicOptions,
        state.dialog.mode,
      ) === null;
    if (valid && !state.dialog.saving) btn.removeAttribute('disabled');
    else btn.setAttribute('disabled', '');
  };

  // ── installed-pack manifests — drives BOTH the Fork-1 B vendor-scope
  // pre-fill AND the connection-detail "Used by packs" inverse pivot. Fetched
  // once (best-effort) alongside the connection list; `null` until loaded / on
  // failure (pre-fill skipped → the server unions; no "Used by packs" section).
  let installedManifests: BulkPackManifest[] | null = null;
  let packsFetchStarted = false;
  const ensurePacksLoaded = (): Promise<void> => {
    if (packsFetchStarted || opts.runPacksList === undefined) return Promise.resolve();
    packsFetchStarted = true;
    return opts
      .runPacksList()
      .then((r) => {
        if (!disposed) {
          installedManifests = r.packs
            .filter((p) => p.installed)
            .map((p) => p.manifest);
          // Surface to the renderer so each api connection row can show its
          // "Used by packs" coverage, and re-render — the connection list
          // typically painted before this best-effort fetch resolved.
          state.installedPackManifests = installedManifests;
          render();
        }
      })
      .catch(() => {
        /* best-effort: leave null → pre-fill skipped, server unions */
      });
  };

  /** Fork 1 B — the pre-filled scopes for a registered vendor's editable field:
   *  the vendor const seed UNIONed with the installed packs' needs. Empty when
   *  the pack list hasn't loaded (→ the field stays blank + the start passes
   *  nothing → the server computes the union itself). */
  const prefillVendorScopes = (vendor: string): string => {
    if (installedManifests === null) return '';
    const seed = getVendorProvider(vendor)?.oauth.scopes ?? [];
    const union = unionRequiredScopesForConnection(installedManifests, vendor);
    return [...new Set([...seed, ...union])].join(' ');
  };

  /** Open the enroll form pre-selected for a vendor — the shared body behind
   *  the kind-picker's vendor cards AND the packs "Set up" deep link. A
   *  registered vendor takes the vendor-schema path (locked `config.vendor`
   *  + hidden OAuth defaults + the Fork-1 B scope pre-fill). An unregistered
   *  API-key vendor takes the BARE `api` form — `dialog.vendor` stays null
   *  deliberately (non-null means "registered vendor flow": it routes the
   *  Authorize click to the server registry and skips the R14 generic
   *  typed-URL path) — seeded with `name` + the hidden `config.vendor` tag,
   *  which is what pack-readiness / runnability vendor-matching reads. The
   *  caller renders. */
  const openVendorEnrollForm = (vendor: string): void => {
    beginDialogNavigation();
    state.dialog.kind = 'api';
    state.dialog.subtype = null;
    state.dialog.error = null;
    if (resolveVendorSchema(vendor) !== undefined) {
      state.dialog.vendor = vendor;
      // Fork 1 B — pre-fill the editable Scopes field with the vendor const ∪
      // the installed packs' needs (empty when the pack list isn't loaded →
      // the field stays blank + the server computes the union itself).
      const prefill = prefillVendorScopes(vendor);
      state.dialog.values = {
        ...initialVendorSchemaValues(vendor),
        ...(prefill.length > 0 ? { 'auth.scopes': prefill } : {}),
      };
    } else {
      state.dialog.vendor = null;
      const schema = resolveConnectionSchema('api');
      state.dialog.values = {
        ...(schema ? seedSchemaDefaults(schema) : {}),
        // Name defaults to the vendor so recipe `{{connection.api.<name>}}`
        // NAME-matching lines up with the pack's vendor-matching; editable.
        ...(CONNECTION_NAME_REGEX.test(vendor) ? { name: vendor } : {}),
        'config.vendor': vendor,
      };
    }
    state.dialog.stage = 'form';
  };

  // ── List load (generation-guarded) ───────────────────────────
  const doRefresh = (): Promise<void> => {
    // Fork 1 B — kick off the (once, best-effort) packs fetch in PARALLEL so it
    // never delays the connection list; await it at the end of `pendingLoad` so
    // `whenLoaded()` covers it (the vendor dialog opens after load, so the
    // pre-fill data is ready by the time a vendor is picked).
    const packsP = ensurePacksLoaded();
    const gen = ++loadGeneration;
    state.loading = true;
    // Paint the loading state synchronously (the initial mount render ran
    // before this flipped `loading`, and a re-list after a write should
    // show the spinner while the fresh rows arrive).
    render();
    pendingLoad = (async () => {
      try {
        const { connections } = await opts.runList();
        if (disposed || gen !== loadGeneration) return;
        state.connections = [...connections];
        state.loading = false;
        state.error = null;
        render();
      } catch (err) {
        if (disposed || gen !== loadGeneration) return;
        state.loading = false;
        state.error = errMessage(err);
        render();
      }
      // Settle the (best-effort) packs fetch within whenLoaded so the pre-fill
      // is deterministic; its own .catch already swallowed any failure.
      await packsP;
    })();
    return pendingLoad;
  };

  // D-192 M4c-UI — seed the trigger editor from the connection's stored
  // `match_patterns` (stripped from `ConnectionView`, so read via the dedicated
  // rpc). Best-effort: a failure / an unwired caller leaves the editor empty; a
  // navigation away before the read returns is ignored (editingId guard). Only
  // slack/telegram connections declare the trigger field.
  const hydrateMatchPatterns = async (
    kind: ConnectionKind,
    name: string,
    editingId: string,
  ): Promise<void> => {
    const run = opts.runGetMatchPatterns;
    if (!run) return;
    let patterns: MessageMatchPattern[];
    try {
      patterns = (await run({ name, kind })).match_patterns;
    } catch {
      return; // best-effort — the editor stays empty, the form still works
    }
    // Stale read — the user cancelled or opened a different dialog.
    if (state.dialog.mode !== 'edit' || state.dialog.editingId !== editingId) return;
    const baseKey = 'config.match_patterns';
    const next = { ...state.dialog.values };
    for (const k of Object.keys(next)) {
      if (k.startsWith(`${baseKey}.`)) delete next[k];
    }
    patterns.forEach((p, i) => {
      next[`${baseKey}.${i}.kind`] = p.kind;
      next[`${baseKey}.${i}.value`] = p.value;
      next[`${baseKey}.${i}.mode`] = p.kind === 'content' ? (p.mode ?? '') : '';
    });
    state.dialog.values = next;
    // The editor now reflects the stored triggers — safe to write on Save.
    matchPatternsHydrated = true;
    render();
  };

  // D-192 M4c-UI — compile the messenger triggers to write on Save, or `null`
  // to leave the stored triggers untouched. Snapshotted from `dialog.values` at
  // Save-CLICK time (before any await) so a mid-save navigation can't corrupt or
  // cross-contaminate the write, and GATED so a write only happens when the
  // editor is trustworthy: create (nothing stored to lose) or a successfully
  // hydrated edit. An un-hydrated edit (read failed / Save raced the read)
  // returns `null` → the stored triggers are preserved, never wiped with `[]`.
  const compileTriggerWrite = (
    schema: ConnectionSchema,
    values: ConnectionFormValues,
    isEdit: boolean,
  ): MessageMatchPattern[] | null => {
    if (!opts.runSetMatchPatterns) return null;
    const field = schema.fields.find((f) => f.type === 'match-pattern-list');
    if (!field) return null;
    if (isEdit && !matchPatternsHydrated) return null;
    return matchPatternRowsToPatterns(collectMatchPatternRows(values, field.key));
  };

  // ── Submit (enroll on create, update on edit) ─────────────────
  const submitForm = async (): Promise<void> => {
    // A write rpc from a PRIOR submit is still settling — block a concurrent
    // one (this survives a Back / Cancel that cleared `dialog.saving`).
    if (submitInFlight) return;
    // Re-entrancy guard — a second submit while one is in flight is dropped
    // (the rendered button is disabled, but a delegated double-fire isn't).
    if (state.dialog.saving) return;
    const schema = activeSchema();
    const { dialog } = state;
    if (schema === undefined || dialog.kind === null) {
      dialog.error = 'Connection kind missing — pick a kind to continue.';
      render();
      return;
    }
    // A vendor flow re-derives the (hidden) OAuth endpoint from the sandbox
    // toggle here too — covers any path that set `config.sandbox` without a
    // select event. Idempotent for non-vendor / non-sandbox forms.
    if (dialog.vendor !== null) {
      dialog.values = syncVendorOAuthEndpointValue(dialog.vendor, dialog.values);
    }
    // Re-validate with the SAME rule the renderer gates the button on —
    // the imperative sync is cosmetic, so this is the real gate.
    const invalid = validateConnectionForm(
      schema,
      dialog.values,
      state.dynamicOptions,
      dialog.mode,
    );
    if (invalid !== null) {
      dialog.error = invalid;
      render();
      return;
    }
    const payload = projectConnectionPayload(
      schema,
      dialog.values,
      dialog.kind,
      dialog.subtype,
    );
    // granted-scopes — carry the vendor-granted set captured during the dance
    // (dialog state, set at :607 from completeVendorOAuth; not a form field)
    // into the enroll payload so the server persists it for pack-readiness
    // coverage. Flows via runEnroll only — the update rpc preserves the stored
    // set server-side, so a re-authorize that re-scopes routes through enroll.
    // Empty/absent → omitted → server preserves any existing set.
    if (dialog.oauthGrantedScopes && dialog.oauthGrantedScopes.length > 0) {
      payload.granted_scopes = [...dialog.oauthGrantedScopes];
    }
    const isEdit = dialog.mode === 'edit';
    // Build the edit patch up-front from the captured dialog. Identity is
    // immutable — `values.name` is the readonly original. Auth secrets aren't
    // re-sent unless the user supplied a fresh credential (edit mode never
    // hydrates stored auth).
    const patch: {
      display_name?: string;
      config?: Record<string, unknown>;
      auth?: ConnectionAuth;
    } = { display_name: payload.display_name, config: payload.config };
    if (isEdit && shouldPatchConnectionAuth(schema, dialog.values)) {
      patch.auth = payload.auth;
    }
    // D-192 M4c-UI — snapshot the messenger triggers to write NOW (before any
    // await), gated on the editor being trustworthy. `null` → leave stored
    // triggers untouched (see `compileTriggerWrite`).
    const triggerWrite = compileTriggerWrite(schema, dialog.values, isEdit);
    // Claim a dialog generation — a navigation during the in-flight rpc bumps
    // it, marking this completion stale so it can't reset the newer dialog.
    const gen = ++dialogGen;
    submitInFlight = true;
    dialog.saving = true;
    dialog.error = null;
    render();
    try {
      let probe: ConnectionHealth | undefined;
      // The saved connection's CANONICAL name (the server trims / canonicalizes
      // on enroll) — used for the trigger write so a padded create name can't
      // 404 the follow-up `setMatchPatterns`.
      let savedName = payload.name;
      if (isEdit) {
        const { connection } = await opts.runUpdate({ name: payload.name, kind: dialog.kind, patch });
        savedName = connection.name;
      } else {
        const result = await opts.runEnroll(payload);
        probe = result.probe;
        savedName = result.connection.name;
      }
      // D-192 M4c-UI — the messenger triggers save via their own merge-write now
      // that the connection exists (create + edit), from the pre-await snapshot.
      // A failure surfaces on the dialog below; the connection is already saved,
      // and a retry re-saves both (update + setMatchPatterns are idempotent).
      if (triggerWrite !== null && opts.runSetMatchPatterns) {
        await opts.runSetMatchPatterns({
          name: savedName,
          kind: payload.kind,
          match_patterns: triggerWrite,
        });
      }
      // Stale-completion guard: a cancel / back / new add during the rpc moved
      // the user to a different dialog — don't reset it or drop their input.
      if (disposed || gen !== dialogGen) return;
      resetDialog();
      if (!isEdit) {
        state.dialog.recentProbe = probe
          ? { kind: payload.kind, name: payload.name, status: probe.status }
          : null;
      }
      // Re-list so the new / patched row appears with its server view.
      await doRefresh();
    } catch (err) {
      if (disposed || gen !== dialogGen) return;
      state.dialog.saving = false;
      state.dialog.error = errMessage(err);
      render();
    } finally {
      // Release the cross-navigation write lock once the rpc settles, whether
      // this completion was applied or treated as stale.
      submitInFlight = false;
    }
  };

  // ── Per-row probe ─────────────────────────────────────────────
  const probeRow = async (kind: ConnectionKind, name: string): Promise<void> => {
    const key = connectionRowKey(kind, name);
    if (state.probeInFlight.has(key)) return;
    state.probeInFlight.add(key);
    render();
    try {
      const { health } = await opts.runProbe({ name, kind });
      if (disposed) return;
      state.dialog.recentProbe = { kind, name, status: health.status };
    } catch (err) {
      if (disposed) return;
      // Surface as a non-ok/unknown recent-probe → the renderer styles it
      // with the error tone.
      state.dialog.recentProbe = { kind, name, status: errMessage(err) };
    } finally {
      if (!disposed) {
        state.probeInFlight.delete(key);
        render();
      }
    }
  };

  // ── Per-row delete (D-192 slice 5 — confirm dialog) ────────────
  /** Delete click → open the confirm modal + fetch the removal-preview count
   *  (fills the "also remove the [N] item(s)" checkbox). No rpc mutates until
   *  the user confirms. */
  const openDeleteConfirm = (kind: ConnectionKind, name: string): void => {
    const key = connectionRowKey(kind, name);
    if (state.deleteInFlight.has(key)) return;
    // Mutually exclusive with the enroll/edit dialog — never stack a delete
    // confirm under an open dialog (the confirm is only reachable from the list,
    // but a keyboard user could reach a background button; this fails safe).
    if (state.dialog.stage !== 'closed') return;
    const seq = ++deletePreviewSeq;
    state.deleteConfirm = { kind, name, count: null, removeMirror: false, deleting: false };
    render();
    const preview = opts.runPreviewPurge;
    if (preview === undefined) return; // no count → plain confirm (no checkbox)
    void (async () => {
      try {
        const { count } = await preview({ name, kind });
        if (disposed) return;
        // Only THIS open may write its count. A newer open (cancel+reopen, even
        // same row) bumped the seq → this earlier/slower result is dropped; a
        // cancel-without-reopen nulled `deleteConfirm`.
        if (deletePreviewSeq !== seq || state.deleteConfirm === null) return;
        state.deleteConfirm.count = count;
        render();
      } catch {
        // Preview failure → keep the plain confirm (count stays null, no checkbox).
      }
    })();
  };

  const cancelDeleteConfirm = (): void => {
    if (state.deleteConfirm === null || state.deleteConfirm.deleting) return;
    state.deleteConfirm = null;
    render();
  };

  const toggleDeleteMirror = (): void => {
    const dc = state.deleteConfirm;
    if (dc === null || dc.deleting) return;
    dc.removeMirror = !dc.removeMirror;
    render();
  };

  /** Remove pressed → run the delete with the opt-in, then refresh + close. */
  const confirmDelete = async (): Promise<void> => {
    const dc = state.deleteConfirm;
    if (dc === null || dc.deleting) return;
    const { kind, name } = dc;
    const key = connectionRowKey(kind, name);
    dc.deleting = true;
    state.deleteInFlight.add(key);
    render();
    try {
      await opts.runDelete({ name, kind, remove_mirror_data: dc.removeMirror });
      if (disposed) return;
      state.deleteInFlight.delete(key);
      state.deleteConfirm = null;
      await doRefresh();
    } catch (err) {
      if (disposed) return;
      state.deleteInFlight.delete(key);
      state.deleteConfirm = null;
      state.error = errMessage(err);
      render();
    }
  };

  // ── D-139 engagement health ──────────────────────────────────
  const setEngagementError = (key: string, message: string): void => {
    state.engagementHealth.error[key] = message;
  };

  const loadEngagementHealth = async (name: string): Promise<void> => {
    const key = connectionRowKey('api', name);
    if (state.engagementHealth.loading.has(key)) return;
    const run = opts.runEngagementHealth;
    if (run === undefined) {
      setEngagementError(
        key,
        'Engagement health is not available in this view — the D-139 health caller is not wired.',
      );
      render();
      return;
    }
    state.engagementHealth.loading.add(key);
    delete state.engagementHealth.error[key];
    render();
    try {
      const data = await run({ name });
      if (disposed) return;
      state.engagementHealth.data[key] = data;
      delete state.engagementHealth.error[key];
    } catch (err) {
      if (disposed) return;
      setEngagementError(key, errMessage(err));
    } finally {
      if (!disposed) {
        state.engagementHealth.loading.delete(key);
        render();
      }
    }
  };

  const reprobeEngagementCapabilities = async (name: string): Promise<void> => {
    const key = connectionRowKey('api', name);
    if (state.engagementHealth.reprobing.has(key)) return;
    const run = opts.runReprobeEngagementCapabilities;
    if (run === undefined) {
      setEngagementError(
        key,
        'Salesforce capability re-probe is not available in this view — the D-139 re-probe caller is not wired.',
      );
      render();
      return;
    }
    state.engagementHealth.reprobing.add(key);
    delete state.engagementHealth.error[key];
    render();
    try {
      const reprobe = await run({ name });
      if (disposed) return;
      state.engagementHealth.lastReprobe[key] = reprobe;
      const prior = state.engagementHealth.data[key];
      if (prior !== undefined) {
        state.engagementHealth.data[key] = { ...prior, rows: reprobe.rows };
      }
      delete state.engagementHealth.error[key];
    } catch (err) {
      if (disposed) return;
      setEngagementError(key, errMessage(err));
    } finally {
      if (!disposed) {
        state.engagementHealth.reprobing.delete(key);
        render();
      }
    }
  };

  // ── Action handlers ───────────────────────────────────────────
  const handlers: Record<ConnectionsEnrollAction, (dataset: DOMStringMap) => void> = {
    'connections-open-add': () => {
      state.deleteConfirm = null; // opening the enroll dialog dismisses a delete confirm
      resetDialog();
      state.dialog.stage = 'kind-picker';
      state.dialog.mode = 'create';
      render();
    },
    'connections-pick-kind': (dataset) => {
      const kind = asKind(dataset.kind);
      if (kind === null) return;
      beginDialogNavigation();
      state.dialog.kind = kind;
      state.dialog.subtype = null;
      state.dialog.vendor = null;
      state.dialog.error = null;
      if (kind === 'api') {
        const schema = resolveConnectionSchema('api');
        state.dialog.values = schema ? seedSchemaDefaults(schema) : {};
        state.dialog.stage = 'form';
      } else {
        state.dialog.values = {};
        state.dialog.stage = 'subtype-picker';
      }
      render();
    },
    'connections-pick-vendor': (dataset) => {
      const vendor = dataset.vendor;
      if (vendor === undefined) return;
      openVendorEnrollForm(vendor);
      render();
    },
    'connections-pick-subtype': (dataset) => {
      const subtype = dataset.subtype;
      if (subtype === undefined || state.dialog.kind === null) return;
      beginDialogNavigation();
      state.dialog.subtype = subtype;
      state.dialog.error = null;
      const schema = resolveConnectionSchema(state.dialog.kind, subtype);
      state.dialog.values = schema ? seedSchemaDefaults(schema) : {};
      state.dialog.stage = 'form';
      render();
      // The email subtype's send-from picker reads the dynamic send-capable
      // list — re-pull it now the form is on screen (freshest at point-of-use,
      // catches a mail account enrolled since mount). It repaints in place.
      if (state.dialog.kind === 'notification' && subtype === 'email') {
        void hydrateMailOptions();
      }
    },
    'connections-back-to-kind': () => {
      beginDialogNavigation();
      state.dialog.stage = 'kind-picker';
      state.dialog.kind = null;
      state.dialog.subtype = null;
      state.dialog.vendor = null;
      state.dialog.values = {};
      state.dialog.error = null;
      render();
    },
    'connections-back-to-subtype': () => {
      beginDialogNavigation();
      state.dialog.stage = 'subtype-picker';
      state.dialog.subtype = null;
      state.dialog.vendor = null;
      state.dialog.values = {};
      state.dialog.error = null;
      render();
    },
    'connections-cancel-dialog': () => {
      resetDialog();
      render();
    },
    'connections-submit-form': () => {
      void submitForm();
    },
    // header-list — append an empty credential-header row. The form shows >=1
    // row (a SYNTHETIC default when none are materialized in `values` yet), so
    // we MATERIALIZE the currently-shown rows then append one — otherwise a
    // click on a fresh form would just re-create the synthetic row 0 (a no-op).
    // Capped at MAX_HEADER_AUTH_ENTRIES (UX; the server re-checks).
    'connections-add-header': (dataset) => {
      if (state.dialog.saving) return;
      const baseKey = dataset.baseKey;
      if (baseKey === undefined) return;
      const collected = collectHeaderRows(state.dialog.values, baseKey);
      const shown =
        collected.length > 0 ? collected : [{ index: 0, header_name: '', value: '' }];
      if (shown.length >= MAX_HEADER_AUTH_ENTRIES) return;
      const next = { ...state.dialog.values };
      for (const r of shown) {
        next[`${baseKey}.${r.index}.header_name`] = r.header_name;
        next[`${baseKey}.${r.index}.value`] = r.value;
      }
      const nextIndex = Math.max(...shown.map((r) => r.index)) + 1;
      next[`${baseKey}.${nextIndex}.header_name`] = '';
      next[`${baseKey}.${nextIndex}.value`] = '';
      state.dialog.values = next;
      render();
    },
    // header-list — drop one row (delete its two keys; the renderer compacts +
    // the projector re-indexes, so the gap leaves no sparse hole). The Remove
    // button is disabled on the last row, so this never empties the list.
    'connections-remove-header': (dataset) => {
      if (state.dialog.saving) return;
      const baseKey = dataset.baseKey;
      const idx = dataset.headerIndex;
      if (baseKey === undefined || idx === undefined) return;
      const next = { ...state.dialog.values };
      delete next[`${baseKey}.${idx}.header_name`];
      delete next[`${baseKey}.${idx}.value`];
      state.dialog.values = next;
      render();
    },
    // match-pattern-list (D-192 M4c-UI) — append an empty trigger row.
    // MATERIALIZE the shown rows first (a fresh form shows a SYNTHETIC row 0),
    // then append. Capped at MESSAGE_MATCH_MAX_PATTERNS (UX; server re-checks).
    'connections-add-pattern': (dataset) => {
      if (state.dialog.saving) return;
      const baseKey = dataset.baseKey;
      if (baseKey === undefined) return;
      const collected = collectMatchPatternRows(state.dialog.values, baseKey);
      const shown =
        collected.length > 0 ? collected : [{ index: 0, kind: '', value: '', mode: '' }];
      if (shown.length >= MESSAGE_MATCH_MAX_PATTERNS) return;
      const next = { ...state.dialog.values };
      for (const r of shown) {
        next[`${baseKey}.${r.index}.kind`] = r.kind;
        next[`${baseKey}.${r.index}.value`] = r.value;
        next[`${baseKey}.${r.index}.mode`] = r.mode;
      }
      const nextIndex = Math.max(...shown.map((r) => r.index)) + 1;
      next[`${baseKey}.${nextIndex}.kind`] = '';
      next[`${baseKey}.${nextIndex}.value`] = '';
      next[`${baseKey}.${nextIndex}.mode`] = '';
      state.dialog.values = next;
      render();
    },
    // match-pattern-list — drop one trigger row (its three keys). Remove is
    // disabled on the last row, so this never empties the visible list.
    'connections-remove-pattern': (dataset) => {
      if (state.dialog.saving) return;
      const baseKey = dataset.baseKey;
      const idx = dataset.patternIndex;
      if (baseKey === undefined || idx === undefined) return;
      const next = { ...state.dialog.values };
      delete next[`${baseKey}.${idx}.kind`];
      delete next[`${baseKey}.${idx}.value`];
      delete next[`${baseKey}.${idx}.mode`];
      state.dialog.values = next;
      render();
    },
    'connections-edit': (dataset) => {
      const kind = asKind(dataset.kind);
      const name = dataset.name;
      if (kind === null || name === undefined) return;
      const view = state.connections.find(
        (c) => c.kind === kind && c.name === name,
      );
      if (view === undefined) return;
      state.deleteConfirm = null; // opening the edit dialog dismisses a delete confirm
      cancelPendingOAuth();
      dialogGen += 1;
      const patch = buildConnectionEditDialogPatch(view);
      state.dialog = { ...initialConnectionsDialogState(), ...patch };
      render();
      // Editing an email-notification row pre-fills `sender_mail_instance` from
      // the stored record — re-pull the live send-capable list so the picker
      // offers current accounts (and a sender that lost send capability since
      // enrollment is reconciled / rejected, not silently re-saved). Mirrors
      // the create email-subtype path; covers a failed/in-flight mount pre-warm.
      if (state.dialog.kind === 'notification' && state.dialog.subtype === 'email') {
        void hydrateMailOptions();
      }
      // D-192 M4c-UI — seed the trigger editor from the stored `match_patterns`
      // (not carried on the view, so read separately) for ANY notification
      // subtype whose schema declares a trigger field. The editor starts EMPTY
      // until the read lands, so mark the triggers NOT-yet-hydrated — the submit
      // gate refuses to write an un-hydrated edit, so a failed / racing read
      // can't wipe the stored triggers with `[]`.
      //
      // ⚠ DRIVEN BY THE SCHEMA FIELD, not a hand-spelled subtype list. A
      // `slack || telegram` check here silently dropped WhatsApp — it carries a
      // match-pattern-list field too, so an edit started the editor empty, the
      // hydrate + the `matchPatternsHydrated = false` reset never fired, and Save
      // wrote `[]`, wiping every stored WhatsApp trigger. This is the SAME
      // field-presence check `compileTriggerWrite` gates the write on, so the
      // hydrate gate and the write gate can never disagree.
      if (
        state.dialog.kind === 'notification' &&
        activeSchema()?.fields.some((f) => f.type === 'match-pattern-list') === true
      ) {
        matchPatternsHydrated = false;
        void hydrateMatchPatterns(kind, name, patch.editingId);
      }
    },
    'connections-probe': (dataset) => {
      const kind = asKind(dataset.kind);
      if (kind === null || dataset.name === undefined) return;
      void probeRow(kind, dataset.name);
    },
    'connections-delete': (dataset) => {
      const kind = asKind(dataset.kind);
      if (kind === null || dataset.name === undefined) return;
      openDeleteConfirm(kind, dataset.name);
    },
    'connections-delete-confirm': () => {
      void confirmDelete();
    },
    'connections-delete-cancel': () => {
      cancelDeleteConfirm();
    },
    'connections-delete-toggle-mirror': () => {
      toggleDeleteMirror();
    },
    // D-165 slice 3 — vendor OAuth popup. Runs the real Model-B dance when the
    // callers + bus + a browser env are wired; otherwise (test host / pre-slice
    // server) it degrades to the honest manual-token message inside the handler.
    'connections-authorize-vendor': () => {
      startVendorOAuthFromClick();
    },
    'connections-engagement-toggle': (dataset) => {
      const kind = asKind(dataset.kind);
      if (kind === null || dataset.name === undefined) return;
      const key = connectionRowKey(kind, dataset.name);
      const { expanded } = state.engagementHealth;
      if (expanded.has(key)) {
        expanded.delete(key);
        delete state.engagementHealth.error[key];
      } else {
        expanded.add(key);
        delete state.engagementHealth.error[key];
        if (state.engagementHealth.data[key] === undefined) {
          void loadEngagementHealth(dataset.name);
          return;
        }
      }
      render();
    },
    'connections-engagement-reprobe': (dataset) => {
      if (dataset.name === undefined) return;
      void reprobeEngagementCapabilities(dataset.name);
    },
    'connections-engagement-install-puller': (dataset) => {
      if (dataset.name === undefined) return;
      const key = connectionRowKey('api', dataset.name);
      setEngagementError(
        key,
        'Scheduled engagement-puller recipe install is not wired from this panel yet. Install the CRM engagement pack from Packs.',
      );
      render();
    },
    'connections-engagement-configure-cadence': (dataset) => {
      if (dataset.name === undefined) return;
      const key = connectionRowKey('api', dataset.name);
      setEngagementError(
        key,
        'Housekeeping cadence configuration is not wired from this panel yet. Use the Server housekeeping settings.',
      );
      render();
    },
  };

  // ── Field-edit delegation (`data-conn-field`) ─────────────────
  // Silent value capture, focus-preserving. Mirrors the reception
  // `attachFieldDelegator` shape but resolves the connections renderer's
  // `data-conn-field` markup instead of `data-field-control`.
  type FieldElement = HTMLElement & { value?: string };
  const onFieldEvent = (event: Event): void => {
    const target = event.target as FieldElement | null;
    if (target === null) return;
    const el = (
      typeof target.closest === 'function'
        ? target.closest('[data-conn-field]')
        : null
    ) as FieldElement | null;
    if (el === null || !host.contains(el)) return;
    const key = el.dataset.connField;
    if (key === undefined) return;
    // A `<select>` fires both `input` and `change`; act on `change` so the
    // visibility re-render runs once. Text/secret inputs act on `input`.
    const isSelect = el.tagName === 'SELECT';
    if ((isSelect ? 'change' : 'input') !== event.type) return;
    // Lock the form while a submit is committing — the rpc already carries
    // the submitted values, so accepting (then silently dropping on success)
    // a mid-save edit would surprise the user. A failed submit clears
    // `saving` + re-renders, re-enabling edits.
    if (state.dialog.saving) return;
    state.dialog.values = { ...state.dialog.values, [key]: el.value ?? '' };
    if (isSelect) {
      // A vendor flow's `config.sandbox` select drives the (hidden) OAuth
      // `auth.token_endpoint` — re-derive it so a sandbox enrollment doesn't
      // ship the seeded PRODUCTION endpoint with sandbox credentials
      // (Salesforce; the helper is a no-op for non-sandbox vendors / changes).
      if (state.dialog.vendor !== null) {
        state.dialog.values = syncVendorOAuthEndpointValue(
          state.dialog.vendor,
          state.dialog.values,
        );
      }
      // auth.type (and other selects) gate `showWhen` field visibility —
      // a structural change, so re-render to reveal / hide fields.
      render();
      return;
    }
    if (state.dialog.error !== null) {
      // First edit after a failed submit clears the stale error (the one
      // deliberate focus cost — re-enables Submit by re-render).
      state.dialog.error = null;
      render();
      return;
    }
    // Pure text edit — keep focus, just resync the Submit button.
    syncSubmitDisabled();
  };

  // ── Wire dispatchers + seed load ──────────────────────────────
  const detachActions = createActionDispatcher<ConnectionsEnrollAction>({
    root: host,
    handlers,
  });
  host.addEventListener('input', onFieldEvent);
  host.addEventListener('change', onFieldEvent);

  render();
  void doRefresh();
  // Pre-warm the email send-from picker so it's populated by the time the
  // user reaches the email-notification form (silent — no email form open yet).
  void hydrateMailOptions();

  // Packs "Set up" deep link — open the enroll form pre-selected for
  // `initialVendor` once the initial load settles (`pendingLoad` covers the
  // best-effort packs fetch, so a registered vendor's scope pre-fill is ready).
  // Regex-gated (the segment rides the URL hash — arbitrary input must not
  // seed `config.vendor`); dropped if the user began a dialog interaction
  // first (`dialogGen` moved) — a deep link never clobbers live navigation.
  if (opts.initialVendor !== undefined && CONNECTION_NAME_REGEX.test(opts.initialVendor)) {
    const vendor = opts.initialVendor;
    void pendingLoad.then(() => {
      if (disposed || dialogGen !== 0 || state.dialog.stage !== 'closed') return;
      openVendorEnrollForm(vendor);
      render();
    });
  }

  return {
    getState: () => state,
    refresh: () => {
      // Re-pull the send-from options too (a mail account may have been
      // enrolled elsewhere since mount); list settle drives the returned promise.
      void hydrateMailOptions();
      return doRefresh();
    },
    whenLoaded: () => pendingLoad,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // Tear down any in-flight OAuth flow (popup + timeout + cached jwks) and
      // the completion subscription so a teardown mid-flow leaks neither.
      cancelPendingOAuth();
      if (oauthUnsub !== null) {
        try {
          oauthUnsub();
        } catch {
          // the subscriber owns its own teardown — never throw out of dispose
        }
        oauthUnsub = null;
      }
      detachActions();
      host.removeEventListener('input', onFieldEvent);
      host.removeEventListener('change', onFieldEvent);
      host.innerHTML = '';
    },
  };
};
