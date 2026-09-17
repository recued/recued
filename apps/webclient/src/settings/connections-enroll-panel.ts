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
 *  discipline as `authoring-mount.ts`).
 *
 *  The connections renderer disables Submit live whenever
 *  `validateConnectionForm` fails (unlike reception's submit). With
 *  silent edits the rendered button would stay stale-disabled, so after
 *  each silent text edit the host imperatively syncs the submit button and
 *  the compact "Next" validation checkpoint (the field being typed is never
 *  rebuilt → focus preserved). The submit handler ALSO re-validates before
 *  firing the rpc, so correctness never depends on this browser-UX layer.
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
 *  `refresh()`. The mount gate stays at the SIX core connection callers — email
 *  hydration is additive, never a mount prerequisite.
 *
 *  Spec: D-125 § 7.1 (the enrollment surface); the host
 *  mirrors `authoring-mount.ts` (innerHTML + dispatcher +
 *  silent field edits). */

import {
  runOAuthPopup,
  defaultFoundationalOAuthEnv,
  type FoundationalOAuthEnv,
} from '../connections/foundational-oauth-popup.js';
import type {
  BulkPackManifest,
  ConnectionAuth,
  ConnectionCredentialPostSafeStopVerificationSummary,
  ConnectionCredentialCorrectionFieldKey,
  ConnectionCredentialRejectionCorrection,
  ConnectionCredentialRejectionResolution,
  ConnectionCredentialRejectionTriageFieldKey,
  ConnectionCredentialRejectionTriageStage,
  ConnectionCredentialRotationActivity,
  ConnectionCredentialRotationFailureReason,
  ConnectionCredentialRotationOutcome,
  ConnectionCredentialRotationSafeStopAcknowledgement,
  ConnectionCredentialRotationSafeStopSummary,
  ConnectionCredentialVerification,
  ConnectionDataPurgeSummary,
  ConnectionHealth,
  McpPackReviewRow,
  ConnectionKind,
  ConnectionView,
  EngagementHealthResponse,
  InstallAccessTier,
  InstallAudienceSelection,
  InstallGrantSelection,
  MessageMatchPattern,
  PackListEntry,
  ReprobeEngagementCapabilitiesResponse,
} from '@recued/contracts';
import {
  OAUTH_CLOUD_CALLBACK_URL,
  buildOpenerRelayRedirectUri,
  isLoopbackOrigin,
  alternateOAuthCallbackUrl,
  oauthCallbackUrlForPwa,
  CONNECTION_AUTH_TYPES,
  CONNECTION_CREDENTIAL_ROTATION_ATTEMPT_ID_REGEX,
  CONNECTION_CREDENTIAL_SAFE_STOP_TOKEN_REGEX,
  connectionCredentialRejectionCorrection,
  connectionCredentialRejectionTriage,
  GENERIC_OAUTH_VENDOR,
  getVendorProvider,
  unionRequiredScopesForConnection,
  requiredScopesByConnection,
  MAX_HEADER_AUTH_ENTRIES,
  MESSAGE_MATCH_MAX_PATTERNS,
} from '@recued/contracts';
import {
  collectHeaderRows,
  collectMatchPatternRows,
  matchPatternRowsToPatterns,
  renderConnectionsPage,
  connectionFormValidationIssue,
  connectionFormValidationSummary,
  connectionFormValidationShouldAnnounce,
  connectionCredentialRegenerationAdminHandoff,
  validateConnectionForm,
  initialConnectionsPageState,
  initialConnectionsDialogState,
  connectionRowKey,
  projectConnectionPayload,
  shouldPatchConnectionAuth,
  buildConnectionEditDialogPatch,
  resolveConnectionSchema,
  resolveVendorSchema,
  applyConnectionHints,
  connectionHintValues,
  initialVendorSchemaValues,
  type AppliedConnectionHint,
  type ConnectionHintSource,
  syncVendorOAuthEndpointValue,
  CONNECTION_NAME_REGEX,
  applyVendorOAuthResultValues,
  isVendorSandboxSelected,
  buildConnectionSetupGuidePreview,
  connectionSetupGuideContextsMatch,
  canApplyConnectionSetupGuideSuggestion,
  connectionSetupGuideReturnTarget,
  connectionFormRunsOAuthDance,
  connectionOAuthCredentialReadiness,
  invalidatesConnectionOAuthResult,
  isConnectionOAuthLockedField,
  type ConnectionFormValidationIssue,
  initialConnectionsSetupGuideState,
  MAIL_SEND_CAPABLE_INSTANCES_SOURCE,
  MCP_PACK_INSTALL_SCOPE_HOST_ATTR,
  type ConnectionsPageState,
  type ConnectionsPostSafeStopProfileHandoff,
  type ConnectionsDialogCredentialCorrectionState,
  type ConnectionsServerUpdateTriage,
  type ServerUpdateReceiptVerificationState,
  type ConnectionPayload,
  type ConnectionFormValues,
  type ConnectionSchema,
  type VendorOAuthResultValuePatch,
  type ConnectionSetupGuideRequest,
  type ConnectionSetupGuideResult,
  type ConnectionOAuthCredentialFieldKey,
  mcpPackReviewView,
} from '@recued/ui-shared';
import {
  createActionDispatcher,
  type ActionHandlers,
} from '@recued/ui-shared/action-dispatcher';
import type { BroadcastSubscriber } from '../realtime/subscriber.js';
import { classifyRpcError, humanizeRpcError } from '../shell/rpc-error-copy.js';
import type {
  CredentialRotationContinuityStore,
} from '../connections/credential-rotation-continuity.js';
import type {
  CredentialRotationTabConvergence,
  CredentialRotationTabHint,
  CredentialRotationOwnershipLease,
  ServerUpdateTabProgress,
} from '../connections/credential-rotation-tab-convergence.js';
import type {
  CredentialRotationServerUpdateContinuity,
  CredentialRotationServerUpdateMarker,
} from '../connections/credential-rotation-server-update-continuity.js';
import type { ProviderSetupContinuityStore } from '../connections/provider-setup-continuity.js';
import {
  installGrantModelFromMcpReviewRows,
  renderInstallGrantPicker,
  resolveInstallAudienceSelection,
  type InstallGrantPickerModel,
} from './install-grant-picker.js';

// ════════════════════════════════════════════════════════════════
// Caller seams
// ════════════════════════════════════════════════════════════════

/** `collection.connection.list` caller — NO kind filter (the enrollment
 *  list shows every kind, unlike the grant panel's api-only list). */
export type ConnectionsEnrollListCaller = () => Promise<{
  connections: ReadonlyArray<ConnectionView>;
  credential_rotation_safe_stops?: ReadonlyArray<
    ConnectionCredentialRotationSafeStopSummary
  >;
  credential_post_safe_stop_verifications?: ReadonlyArray<
    ConnectionCredentialPostSafeStopVerificationSummary
  >;
}>;

/** `collection.connection.enroll` caller. Takes the `projectConnection
 *  Payload` output verbatim (its shape IS the enroll rpc input). The optional
 *  `probe` response is the enrollment baseline retained for wire compatibility;
 *  "Save and probe" always follows with the authoritative probe rpc. */
export type ConnectionsEnrollCaller = (
  args: ConnectionPayload,
) => Promise<{ connection: ConnectionView; probe?: ConnectionHealth }>;

/** `collection.connection.update` caller. Identity (`kind`, `name`) is
 *  immutable and credential material is intentionally excluded; replacement
 *  credentials must use the verified rotation caller below. */
export type ConnectionsUpdateCaller = (args: {
  name: string;
  kind: ConnectionKind;
  expected_updated_at?: number;
  patch: {
    display_name?: string;
    config?: Record<string, unknown>;
  };
}) => Promise<{ connection: ConnectionView }>;

/** `collection.connection.rotateCredentials` caller. Unlike ordinary update,
 * this verifies a complete candidate on the paired server before swapping it
 * into durable storage. */
export type ConnectionsRotateCredentialsCaller = (args: {
  attempt_id: string;
  name: string;
  kind: ConnectionKind;
  expected_updated_at?: number;
  patch: {
    display_name?: string;
    config?: Record<string, unknown>;
    auth: ConnectionAuth;
  };
  granted_scopes?: string[];
  match_patterns?: MessageMatchPattern[];
}) => Promise<{
  connection: ConnectionView;
  verification: ConnectionCredentialVerification;
}>;

/** Secret-free read used after a reload/reconnect when the credential-bearing
 * rotation request may have committed but its response did not arrive. */
export type ConnectionsCredentialRotationStatusCaller = (args: {
  attempt_id: string;
  name: string;
  kind: ConnectionKind;
}) => Promise<{ outcome: ConnectionCredentialRotationOutcome }>;

/** Secret-free ownership read used only after this tab wins the browser lease.
 * It prevents a takeover from replaying credentials while the paired server
 * is still checking the original tab's attempt. */
export type ConnectionsCredentialRotationActivityCaller = (args: {
  name: string;
  kind: ConnectionKind;
}) => Promise<{ activity: ConnectionCredentialRotationActivity }>;

export type ConnectionsAcknowledgeCredentialRotationSafeStopCaller = (args: {
  name: string;
  kind: ConnectionKind;
  acknowledgement_token: string;
}) => Promise<{
  acknowledgement: ConnectionCredentialRotationSafeStopAcknowledgement;
}>;

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
  expected_updated_at?: number;
}) => Promise<{
  health: ConnectionHealth;
  connection_updated_at?: number;
  credential_correction?: ConnectionCredentialRejectionCorrection;
}>;

/** D-225 Slice 2 — `collection.connection.mcpPackPreview` caller. Probes the
 *  server live and returns one review row per tool. OPTIONAL: a host without it
 *  renders the badge but offers no review, rather than a button that does
 *  nothing. */
export type ConnectionsMcpPackPreviewCaller = (args: {
  name: string;
  kind: ConnectionKind;
}) => Promise<{ pack_slug: string; rows: McpPackReviewRow[] }>;

/** D-225 Slice 2 — `collection.connection.mcpPackCommit` caller. `reviewed_ops`
 *  is the TOCTOU guard: the server refuses if its tools changed while the owner
 *  was deciding, so the op ids MUST be the ones the review actually showed. */
export type ConnectionsMcpPackCommitCaller = (args: {
  name: string;
  kind: ConnectionKind;
  reviewed_ops: string[];
  /** Explicit Access × Audience consent collected beside the reviewed tools. */
  install_scope: InstallGrantSelection;
}) => Promise<{ pack_slug: string; operations: number }>;

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

/** `collection.mail.list` caller — an OPTIONAL companion (D-165 P3, email
 *  send hydration). Hydrates the email-notification `sender_mail_instance`
 *  picker's dynamic-options list (`MAIL_SEND_CAPABLE_INSTANCES_SOURCE`) with
 *  the send-capable `data.mail.<slug>` instance slugs. When absent the email
 *  subtype degrades honestly to its `emptyGuidance` ("Configure SMTP first…")
 *  — the panel still mounts (the mount gate stays at the six core connection
 *  callers). Only `slug` + `send_capable` are consumed; the rpc returns more
 *  per instance (structurally wider returns are accepted). */
export type ConnectionsMailListCaller = () => Promise<{
  instances: ReadonlyArray<{ slug: string; send_capable: boolean }>;
}>;

/** Owner-triggered read-only AI setup assistance. The request shape cannot
 *  carry credentials or free-form connection values: only the reviewed public
 *  URL, selected auth type, and visible field keys cross the RPC boundary. */
export type ConnectionsSuggestSetupCaller = (
  args: ConnectionSetupGuideRequest,
) => Promise<ConnectionSetupGuideResult>;

/** Privacy-safe identity carried from an unsupported safe-start receipt to
 * the persistent Account/server-update guide and back. Connection form values
 * and credentials are deliberately outside this shape. */
export interface CredentialRotationServerUpdateTarget {
  kind: ConnectionKind;
  name: string;
}

/** Server-authoritative, credential-free diagnosis used only after an explicit
 * update return still receives `unknown_method` for the safe activity check. */
export type ConnectionsCredentialRotationServerUpdateTriageCaller = (
  target: CredentialRotationServerUpdateTarget,
) => Promise<ConnectionsServerUpdateTriage>;

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
/** R26.2 Option B for vendor connections — the pure code-exchange rpc
 *  (`collection.connection.completeVendorOAuth`). Absent ⇒ the loopback
 *  self-serve path is not offered and the flow stays on `startVendorOAuth`. */
export type ConnectionsCompleteVendorOAuthCaller = (args: {
  vendor: string;
  code: string;
  redirect_uri: string;
  client_id: string;
  client_secret?: string;
  authorize_url?: string;
  token_endpoint?: string;
}) => Promise<{ refresh_token: string; granted_scopes: string[]; instance_url?: string }>;

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
  /** Optional only for mixed-version hosts. When absent, credential fields may
   *  be left blank to keep the current credential, but replacement is rejected
   *  locally rather than falling back to an unsafe ordinary update. */
  runRotateCredentials?: ConnectionsRotateCredentialsCaller;
  runCredentialRotationStatus?: ConnectionsCredentialRotationStatusCaller;
  runCredentialRotationActivity?: ConnectionsCredentialRotationActivityCaller;
  runAcknowledgeCredentialRotationSafeStop?:
    ConnectionsAcknowledgeCredentialRotationSafeStopCaller;
  /** Same-tab, active-profile-scoped marker written before rotation. The
   * marker carries only attempt id + connection identity, never form values. */
  credentialRotationContinuity?: CredentialRotationContinuityStore;
  /** Boot-scoped, privacy-safe sibling-tab invalidation channel. Exact hints
   * contain only profile-bound connection identity. An exact editor pauses
   * immediately, then every hint re-reads the server before refreshing rows or
   * declaring the editor authoritatively stale. */
  credentialRotationTabConvergence?: CredentialRotationTabConvergence;
  /** Route-independent server-capability result owned by boot. A sibling may
   * resolve a stale unsupported diagnosis while this panel is mounted; this
   * surface presents the one-shot result without navigating or opening a form. */
  credentialRotationServerUpdateContinuity?: Pick<
    CredentialRotationServerUpdateContinuity,
    'beginExactReturn' | 'read' | 'resumeResolvedRetry' | 'subscribe'
  >;
  /** Reconnect subscription. The boot shell passes a callback that fires only
   * after the active paired server is connected again. */
  onReconnect?: (listener: () => void) => () => void;
  /** Persistent Account/server-profile guide handoff. Optional hosts retain
   * the direct Check again action and do not render a dead guide affordance. */
  onOpenCredentialRotationServerUpdateGuide?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  /** Reads `update.check` against the currently paired profile and records its
   * safe version/channel/status evidence in boot continuity. */
  runCredentialRotationServerUpdateTriage?:
    ConnectionsCredentialRotationServerUpdateTriageCaller;
  /** One-shot return from that guide. The route validates and carries only the
   * exact non-secret identity; this panel re-lists and reruns the authoritative
   * preflight before opening a clean editor. */
  initialCredentialRotationServerUpdateRetry?:
    CredentialRotationServerUpdateTarget;
  /** Exact Attention handoff into one unresolved post-ack check/reopen. The
   * target is identity-only; the first authoritative list must still contain
   * it before the panel selects it. */
  initialPostSafeStopRecovery?: CredentialRotationServerUpdateTarget;
  /** Presentation-only label for the profile whose active server supplied the
   * post-ack queue. It is never used as authority. */
  postSafeStopProfileLabel?: string;
  /** A legacy/cross-profile link must pause on this explicit handoff instead
   * of selecting a same-named connection from the current server. */
  postSafeStopProfileHandoff?: ConnectionsPostSafeStopProfileHandoff;
  /** Route-independent Account/server-profile roster. */
  onOpenPostSafeStopServerProfiles?: () => void;
  /** Retires the bound route once the owner intentionally dismisses it or
   * reviews the active profile instead. */
  onPostSafeStopProfileHandoffSettled?: () => void;
  /** Memory-only one-shot completion captured before boot consumes the
   * temporary exact-return route. It is never restored from browser storage
   * and is used only to orient the first mounted clean editor. */
  initialCredentialRotationServerUpdateCompletion?:
    ServerUpdateReceiptVerificationState;
  /** Retire the durable server-update pointer only after this panel reaches a
   * stable authoritative landing (or the owner explicitly dismisses it).
   * Waiting/in-flight states deliberately keep it reload-safe. */
  onCredentialRotationServerUpdateRetrySettled?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  /** The exact preflight opened an untouched clean editor. Persist only the
   * target + ready phase so route/reload interruption can offer one resume. */
  onCredentialRotationCleanEditorReady?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  /** The owner changed the clean editor for the first time. Its target-only
   * continuation must retire before any memory-only value can be mistaken for
   * something a later mount could restore. */
  onCredentialRotationCleanEditorChanged?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  /** The consumed exact-return route unmounted before a stable landing. Boot
   * drops only this tab's active-owner bit and keeps the secret-free target
   * durable so Account can offer an explicit resume. */
  onCredentialRotationServerUpdateRetryInterrupted?: (
    target: CredentialRotationServerUpdateTarget,
  ) => void;
  /** Deterministic attempt-id seam; production uses crypto.randomUUID(). */
  credentialRotationAttemptId?: () => string;
  runDelete: ConnectionsDeleteCaller;
  /** D-192 slice 5 — OPTIONAL removal-preview count. Present → the delete
   *  confirm dialog fetches the "[N] item(s)" count on open and shows the "also
   *  remove the mirrored data" checkbox; absent (or a 0 count) → the dialog is a
   *  plain confirm with no checkbox (the delete still works, mirror data kept —
   *  the ratified default). */
  runPreviewPurge?: ConnectionsPreviewPurgeCaller;
  runProbe: ConnectionsProbeCaller;
  /** D-225 Slice 2 — the generated-pack review + install. Both OPTIONAL and
   *  supplied together in practice; absent → the review action is not offered
   *  at all, which beats a button that fails. */
  runMcpPackPreview?: ConnectionsMcpPackPreviewCaller;
  runMcpPackCommit?: ConnectionsMcpPackCommitCaller;
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
  /** OPTIONAL — privacy-reviewed "Suggest and guide" caller for API forms.
   *  Absent hosts keep the affordance but explain that guidance is unavailable
   *  when the owner confirms generation. */
  runSuggestSetup?: ConnectionsSuggestSetupCaller;
  /** Boot-owned, profile-scoped safe guide continuity. It stores no form
   *  values; route remounts and reloads reconstruct the API form from schema
   *  defaults before offering one explicit resume action. */
  providerSetupContinuity?: ProviderSetupContinuityStore;
  /** OPTIONAL clipboard seam for the exact OAuth callback URI. The callback
   *  always remains visible when clipboard access is missing or denied. */
  copyText?: (value: string) => Promise<void>;
  /** OPTIONAL (D-165 slice 3) — vendor OAuth popup callers + bus. The
   *  "Authorize with <Vendor>" button runs the real popup dance ONLY when
   *  ALL THREE of `runStartVendorOAuth` / `runTakeVendorOAuthResult` /
   *  `subscribe` are wired AND a browser env is available; otherwise it
   *  degrades to the honest "paste a refresh token" fallback. `subscribe`
   *  is the shared `BroadcastSubscriber['on']`; the panel listens for the
   *  `connection.vendor_oauth_completed` frame matching its own `flow_id`. */
  runStartVendorOAuth?: ConnectionsStartVendorOAuthCaller;
  runTakeVendorOAuthResult?: ConnectionsTakeVendorOAuthResultCaller;
  /** R26.2 Option B — the pure code-exchange rpc. Wired ⇒ a LOOPBACK PWA runs
   *  the dance entirely on this machine: the provider redirects to the
   *  same-origin relay page the LAN webclient bundle already serves, the opener
   *  takes the code, and this exchanges it. No public HTTPS server URL is
   *  involved, which is what `startVendorOAuth` demands and a self-hosted server
   *  at `127.0.0.1` cannot supply. */
  runCompleteVendorOAuth?: ConnectionsCompleteVendorOAuthCaller;
  /** Popup/message seam for the self-serve path. Defaults to the real window. */
  foundationalOAuthEnv?: FoundationalOAuthEnv;
  subscribe?: BroadcastSubscriber['on'];
  /** OPTIONAL browser seam for the popup + sessionStorage + timers. Defaults
   *  to `globalThis.window`; injected in tests. */
  oauthEnv?: VendorOAuthBrowserEnv;
  /** Optional deterministic seam for dirty form Back/Cancel confirmation.
   * Production falls back to this panel's document.defaultView.confirm. */
  confirmDiscardDraft?: (prompt: string) => boolean;
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
  /** Refreshes presentation-only profile names after Account re-reads its
   * local roster. The server-bound queue and target are unchanged. */
  setPostSafeStopProfileContext(context: {
    activeProfileLabel: string;
    sourceProfileLabel?: string;
  }): void;
  /** A user-started connection write/verification is still settling. */
  hasInFlightWork(): boolean;
  /** Meaningful form values differ from the in-memory baseline captured when
   * this exact editor opened. Credentials and baselines never leave the mount. */
  hasUnsavedChanges(): boolean;
  /** Privacy-safe route-leave copy. Returns null while no draft would be lost. */
  unsavedChangesPrompt(): string | null;
  /** Effective generated-pack consent, or null while no runnable MCP review is
   *  open. The same value is sent as `install_scope` on Save. */
  getMcpPackInstallScope(): InstallGrantSelection | null;
  /** Test/host seam matching one access-radio choice in the mounted picker. */
  clickMcpPackAccessOption(tier: InstallAccessTier): void;
  /** Test/host seam matching a complete Audience-checklist change. */
  setMcpPackInstallAudience(audience: InstallAudienceSelection): void;
  /** Tear down both dispatchers + clear the host. Idempotent. */
  dispose(): void;
}

// ════════════════════════════════════════════════════════════════
// Action union + small helpers
// ════════════════════════════════════════════════════════════════

/** The `data-action` strings this host handles. */
type ConnectionsEnrollAction =
  | 'connections-open-add'
  | 'connections-retry-pack-context'
  | 'connections-pick-kind'
  | 'connections-pick-vendor'
  | 'connections-pick-subtype'
  | 'connections-back-to-kind'
  | 'connections-back-to-subtype'
  | 'connections-cancel-dialog'
  | 'connections-focus-first-invalid'
  | 'connections-focus-credential-correction'
  | 'connections-focus-credential-triage'
  | 'connections-confirm-credential-handoff'
  | 'connections-check-saved-after-safe-stop'
  | 'connections-recheck-post-safe-stop'
  | 'connections-review-post-safe-stop'
  | 'connections-continue-post-safe-stop'
  | 'connections-open-post-safe-stop-profile'
  | 'connections-review-active-post-safe-stop'
  | 'connections-dismiss-post-safe-stop-profile'
  | 'connections-copy-credential-admin-handoff'
  | 'connections-submit-form'
  | 'connections-add-header'
  | 'connections-remove-header'
  | 'connections-add-pattern'
  | 'connections-remove-pattern'
  | 'connections-edit'
  | 'connections-check-credential-rotation'
  | 'connections-check-credential-safe-stop'
  | 'connections-review-credential-rotation'
  | 'connections-start-fresh-credential-rotation'
  | 'connections-review-server-update'
  | 'connections-dismiss-credential-rotation'
  | 'connections-check-credential-rotation-owner'
  | 'connections-reload-stale-editor'
  | 'connections-probe'
  | 'connections-delete'
  | 'connections-delete-confirm'
  | 'connections-delete-cancel'
  | 'connections-delete-toggle-mirror'
  | 'connections-authorize-vendor'
  | 'connections-guide-open'
  | 'connections-guide-close'
  | 'connections-guide-review'
  | 'connections-guide-edit'
  | 'connections-guide-generate'
  | 'connections-guide-review-again'
  | 'connections-guide-copy-callback'
  | 'connections-guide-copy-scopes'
  | 'connections-guide-use-suggestion'
  | 'connections-guide-return-to-form'
  | 'connections-guide-resume'
  | 'connections-engagement-toggle'
  | 'connections-engagement-reprobe'
  | 'connections-engagement-install-puller'
  | 'connections-engagement-configure-cadence'
  | 'connections-mcp-pack-generate'
  | 'connections-mcp-pack-review'
  | 'connections-mcp-pack-probe'
  | 'connections-mcp-pack-save'
  | 'connections-mcp-pack-cancel';

const SUBMIT_SELECTOR = '[data-action="connections-submit-form"]';
const SAFE_STOP_CHECK_SAVED_SELECTOR =
  '[data-action="connections-check-saved-after-safe-stop"]';
const FORM_VALIDATION_PANEL_SELECTOR = '[data-connection-form-validation]';
const FORM_VALIDATION_TITLE_SELECTOR =
  '[data-connection-form-validation-title]';
const FORM_VALIDATION_MESSAGE_SELECTOR =
  '[data-connection-form-validation-message]';
const FORM_VALIDATION_ACTION_WRAP_SELECTOR =
  '[data-connection-form-validation-action]';
const FORM_VALIDATION_ACTION_SELECTOR =
  '[data-action="connections-focus-first-invalid"]';
const CREDENTIAL_CORRECTION_PANEL_SELECTOR =
  '[data-connection-credential-correction]';
const CREDENTIAL_ADMIN_HANDOFF_SUMMARY_SELECTOR =
  '[data-credential-admin-handoff-summary]';
const CREDENTIAL_ADMIN_HANDOFF_STATUS_SELECTOR =
  '[data-credential-admin-handoff-status]';
const GUIDE_REVIEW_SELECTOR = '[data-action="connections-guide-review"]';
const GUIDE_OPEN_SELECTOR = '[data-action="connections-guide-open"]';
const GUIDE_GENERATE_SELECTOR = '[data-action="connections-guide-generate"]';
const GUIDE_URL_SELECTOR = '[data-connection-guide-url]';
const GUIDE_PANEL_SELECTOR = '[data-connection-guide-panel]';
const GUIDE_ERROR_SELECTOR = '[data-connection-guide-error]';
const OAUTH_AUTHORIZE_SELECTOR = '[data-action="connections-authorize-vendor"]';
const PACK_INVENTORY_RETRY_SELECTOR =
  '[data-action="connections-retry-pack-context"]';
const PACK_USAGE_SELECTOR = '[data-conn-pack-usage]';
const OPEN_ADD_SELECTOR = '[data-action="connections-open-add"]';
const VALID_KINDS: ReadonlySet<string> = new Set(['api', 'mcp', 'notification']);
const ROTATION_UNAVAILABLE_COPY =
  'Recued cannot safely replace keys on this server yet. Your current keys were not changed. Update the server, then try again.';
const ROTATION_CONTINUITY_UNAVAILABLE_COPY =
  "Recued couldn't protect this replacement through a reload, so nothing was sent. Keep this tab open, allow session storage for this site, then try again.";
const ROTATION_CONTINUITY_OCCUPIED_COPY =
  'You started swapping a key in this tab and it has not finished. Go back to the server where you started it before you start another.';
const CREDENTIAL_ROTATION_STATUS_POLL_MS = 2_000;
const CREDENTIAL_ROTATION_SUCCESSOR_POLL_MS = 2_000;
const SERVER_UPDATE_EDITOR_PAUSE_PREFIX =
  'A server change is in progress in an open Recued tab.';

const serverUpdateEditorPauseCopy = (
  progress: ServerUpdateTabProgress,
): string => progress.phase === 'applying'
  ? `${SERVER_UPDATE_EDITOR_PAUSE_PREFIX} Your unsaved form stays in this tab, but Save is paused until the update or rollback settles.`
  : `${SERVER_UPDATE_EDITOR_PAUSE_PREFIX} Your unsaved form stays in this tab, but Save is paused until this tab reconnects to the restarted server.`;

const defaultCredentialRotationAttemptId = (): string => {
  const cryptoLike = (globalThis as {
    crypto?: {
      randomUUID?: () => string;
      getRandomValues?: (array: Uint8Array) => Uint8Array;
    };
  }).crypto;
  try {
    if (cryptoLike?.randomUUID !== undefined) return cryptoLike.randomUUID();
    if (cryptoLike?.getRandomValues !== undefined) {
      const bytes = cryptoLike.getRandomValues(new Uint8Array(16));
      const encoded = Array.from(
        bytes,
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      return `rotation-${encoded}`;
    }
  } catch {
    // Fall through to the invalid sentinel. The submit boundary rejects it
    // before persisting anything or sending credential material.
  }
  return '';
};

const errMessage = (err: unknown): string =>
  humanizeRpcError(err);

interface OAuthCorrection {
  readonly message: string;
  readonly fieldKey: ConnectionOAuthCredentialFieldKey | null;
}

const isRecordValue = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Rebuild, rather than cast, a correction from the shared closed-list map.
 * Receipt/status responses cross a mixed-version network boundary just like
 * RPC errors do, so optional new metadata must not enter page state merely
 * because the TypeScript caller says it has the current shape. */
const validatedConnectionCredentialRejectionCorrection = (
  correction: unknown,
  kind: ConnectionKind,
): ConnectionCredentialRejectionCorrection | null => {
  if (!isRecordValue(correction)) return null;
  const authType = CONNECTION_AUTH_TYPES.find((candidate) =>
    candidate === correction.auth_type);
  if (authType === undefined || !Array.isArray(correction.field_keys)) {
    return null;
  }
  const expected = connectionCredentialRejectionCorrection(authType);
  if (
    expected === null
    || correction.field_keys.length !== expected.field_keys.length
    || correction.field_keys.some((key, index) =>
      key !== expected.field_keys[index])
  ) return null;
  if (correction.triage === undefined) return expected;
  if (!isRecordValue(correction.triage)) return expected;
  const stage: ConnectionCredentialRejectionTriageStage | undefined =
    correction.triage.stage === 'credential_exchange'
    || correction.triage.stage === 'provider_probe'
      ? correction.triage.stage
      : undefined;
  if (
    correction.triage.reason !== 'repeated_auth_rejection'
    || stage === undefined
    || !Array.isArray(correction.triage.endpoint_field_keys)
  ) return expected;
  const resolution: ConnectionCredentialRejectionResolution | undefined =
    correction.triage.resolution
      === 'regenerate_credential_or_contact_admin'
      ? correction.triage.resolution
      : undefined;
  const triage = connectionCredentialRejectionTriage(
    kind,
    authType,
    stage,
    resolution,
  );
  if (
    triage === null
    || correction.triage.endpoint_field_keys.length
      !== triage.endpoint_field_keys.length
    || correction.triage.endpoint_field_keys.some((key, index) =>
      key !== triage.endpoint_field_keys[index])
  ) return expected;
  return { ...expected, triage };
};

const hasCredentialRegenerationSafeStop = (
  correction: {
    triage?: { resolution?: ConnectionCredentialRejectionResolution };
  } | null | undefined,
): boolean => correction?.triage?.resolution
  === 'regenerate_credential_or_contact_admin';

type ValidatedCredentialRotationSafeStop = {
  finishedAt: number;
  correction: ConnectionCredentialRejectionCorrection;
  /** Null only for a pre-closure server. The handoff remains visible, but its
   * provider-fix acknowledgement stays blocked until the server is updated. */
  acknowledgementToken: string | null;
};

/** Runtime-check the additive activity projection. `supported: false`
 * distinguishes an older server (or malformed response) from a current server
 * authoritatively saying there is no safe stop. */
const credentialRotationSafeStopFromActivity = (
  activity: ConnectionCredentialRotationActivity,
  kind: ConnectionKind,
): {
  supported: boolean;
  safeStop: ValidatedCredentialRotationSafeStop | null;
} => {
  if (
    activity.status !== 'idle'
    || !Object.hasOwn(activity, 'safe_stop')
  ) return { supported: false, safeStop: null };
  const raw = activity.safe_stop;
  if (raw === null) return { supported: true, safeStop: null };
  if (
    !isRecordValue(raw)
    || typeof raw.finished_at !== 'number'
    || !Number.isSafeInteger(raw.finished_at)
    || raw.finished_at < 0
  ) return { supported: false, safeStop: null };
  const correction = validatedConnectionCredentialRejectionCorrection(
    raw.correction,
    kind,
  );
  const acknowledgementToken = raw.acknowledgement_token === undefined
    ? null
    : typeof raw.acknowledgement_token === 'string'
      && CONNECTION_CREDENTIAL_SAFE_STOP_TOKEN_REGEX.test(
        raw.acknowledgement_token,
      )
      ? raw.acknowledgement_token
      : undefined;
  if (
    correction === null
    || !hasCredentialRegenerationSafeStop(correction)
    || acknowledgementToken === undefined
  ) {
    return { supported: false, safeStop: null };
  }
  return {
    supported: true,
    safeStop: {
      finishedAt: raw.finished_at,
      correction,
      acknowledgementToken,
    },
  };
};

type ValidatedCredentialRotationSafeStopSummary =
  ValidatedCredentialRotationSafeStop & {
    kind: ConnectionKind;
    name: string;
  };

/** Validate the optional cold-discovery sidecar as one closed set. A malformed,
 * duplicate, orphaned, or token-less entry invalidates the whole projection so
 * partial data can never clear or reorder an existing recovery handoff. */
const validatedCredentialRotationSafeStopSummaries = (
  value: unknown,
  connections: ReadonlyArray<ConnectionView>,
): ReadonlyArray<ValidatedCredentialRotationSafeStopSummary> | null => {
  if (!Array.isArray(value) || value.length > connections.length) return null;
  const connectionKeys = new Set(connections.map((connection) =>
    connectionRowKey(connection.kind, connection.name)));
  const seen = new Set<string>();
  const summaries: ValidatedCredentialRotationSafeStopSummary[] = [];
  for (const raw of value) {
    if (!isRecordValue(raw)) return null;
    const kind = typeof raw.kind === 'string' ? asKind(raw.kind) : null;
    const name = raw.name;
    if (
      kind === null
      || typeof name !== 'string'
      || !CONNECTION_NAME_REGEX.test(name)
    ) return null;
    const key = connectionRowKey(kind, name);
    if (!connectionKeys.has(key) || seen.has(key)) return null;
    const validated = credentialRotationSafeStopFromActivity({
      status: 'idle',
      safe_stop: raw as unknown as Extract<
        ConnectionCredentialRotationActivity,
        { status: 'idle' }
      >['safe_stop'],
    }, kind);
    if (
      !validated.supported
      || validated.safeStop === null
      || validated.safeStop.acknowledgementToken === null
    ) return null;
    seen.add(key);
    summaries.push({ kind, name, ...validated.safeStop });
  }
  return summaries;
};

type ValidatedPostSafeStopVerificationSummary = {
  kind: ConnectionKind;
  name: string;
  status: 'pending' | 'auth_failed' | 'unreachable' | 'unknown';
  acknowledgedAt: number;
  checkedAt?: number;
  connectionUpdatedAt?: number;
  correction?: ConnectionCredentialRejectionCorrection;
};

/** Validate the whole durable post-ack projection before choosing its first
 * server-ordered item. Every non-pending result must be bound to the exact row
 * revision in the same list response; malformed input cannot become an
 * all-clear, field selector, or stale recovery reopen. */
const validatedPostSafeStopVerificationSummaries = (
  value: unknown,
  connections: ReadonlyArray<ConnectionView>,
): ReadonlyArray<ValidatedPostSafeStopVerificationSummary> | null => {
  if (!Array.isArray(value) || value.length > connections.length) return null;
  const connectionByKey = new Map(connections.map((connection) => [
    connectionRowKey(connection.kind, connection.name),
    connection,
  ]));
  const seen = new Set<string>();
  const summaries: ValidatedPostSafeStopVerificationSummary[] = [];
  for (const raw of value) {
    if (!isRecordValue(raw)) return null;
    const kind = typeof raw.kind === 'string' ? asKind(raw.kind) : null;
    const name = raw.name;
    const acknowledgedAt = raw.acknowledged_at;
    const status = raw.status;
    if (
      kind === null
      || typeof name !== 'string'
      || !CONNECTION_NAME_REGEX.test(name)
      || (
        status !== 'pending'
        && status !== 'auth_failed'
        && status !== 'unreachable'
        && status !== 'unknown'
      )
      || typeof acknowledgedAt !== 'number'
      || !Number.isSafeInteger(acknowledgedAt)
      || acknowledgedAt < 0
    ) return null;
    const key = connectionRowKey(kind, name);
    const connection = connectionByKey.get(key);
    if (connection === undefined || seen.has(key)) return null;
    seen.add(key);
    if (status === 'pending') {
      if (
        raw.checked_at !== undefined
        || raw.connection_updated_at !== undefined
        || raw.credential_correction !== undefined
      ) return null;
      summaries.push({ kind, name, status, acknowledgedAt });
      continue;
    }
    const checkedAt = raw.checked_at;
    const connectionUpdatedAt = raw.connection_updated_at;
    if (
      typeof checkedAt !== 'number'
      || !Number.isSafeInteger(checkedAt)
      || checkedAt < 0
      || typeof connectionUpdatedAt !== 'number'
      || !Number.isSafeInteger(connectionUpdatedAt)
      || connectionUpdatedAt < 0
      || connection.updated_at !== connectionUpdatedAt
    ) return null;
    const correction = validatedConnectionCredentialRejectionCorrection(
      raw.credential_correction,
      kind,
    );
    if (
      status !== 'auth_failed'
      && raw.credential_correction !== undefined
    ) return null;
    // A closed-list correction is still only a field-target hint. Bind it to
    // the auth discriminant from this exact list row; a locked/mixed-version
    // row keeps the authoritative rejection but falls back to generic review.
    const boundCorrection = correction !== null
      && connection.auth_type === correction.auth_type
      ? correction
      : null;
    summaries.push({
      kind,
      name,
      status,
      acknowledgedAt,
      checkedAt,
      connectionUpdatedAt,
      ...(boundCorrection !== null ? { correction: boundCorrection } : {}),
    });
  }
  return summaries;
};

/** Accept a server correction only when it matches the auth shape submitted
 * by this still-open editor and its complete field list exactly matches the
 * shared contract. Unknown, partial, reordered, or stale lists fall back to
 * the ordinary server error; they never become selectors. Contract-valid
 * fixed fields may be hidden by a provider schema and are simply omitted from
 * the owner's visible correction targets. */
const connectionCredentialCorrectionState = (
  correction: unknown,
  schema: ConnectionSchema,
  values: ConnectionFormValues,
  message: string,
): ConnectionsDialogCredentialCorrectionState | null => {
  const expected = validatedConnectionCredentialRejectionCorrection(
    correction,
    schema.kind,
  );
  if (expected === null || expected.auth_type !== values['auth.type']) return null;
  const fieldKeys: ConnectionCredentialCorrectionFieldKey[] = [];
  for (const rawKey of expected.field_keys) {
    const field = schema.fields.find((candidate) =>
      candidate.key === rawKey
      && !candidate.hidden
      && !candidate.readonly
      && (candidate.showWhen?.(values) ?? true));
    if (field !== undefined) fieldKeys.push(rawKey);
  }
  if (fieldKeys.length === 0) return null;
  const endpointFieldKeys: ConnectionCredentialRejectionTriageFieldKey[] = [];
  for (const rawKey of expected.triage?.endpoint_field_keys ?? []) {
    const field = schema.fields.find((candidate) =>
      candidate.key === rawKey
      && !candidate.hidden
      && !candidate.readonly
      && (candidate.showWhen?.(values) ?? true));
    if (field !== undefined) endpointFieldKeys.push(rawKey);
  }
  return {
    message,
    fieldKeys,
    ...(expected.triage !== undefined
      ? {
          triage: {
            stage: expected.triage.stage,
            endpointFieldKeys,
            ...(expected.triage.resolution !== undefined
              ? { resolution: expected.triage.resolution }
              : {}),
          },
        }
      : {}),
  };
};

const connectionCredentialCorrectionFromError = (
  error: unknown,
  schema: ConnectionSchema,
  values: ConnectionFormValues,
): {
  correction: ConnectionCredentialRejectionCorrection;
  state: ConnectionsDialogCredentialCorrectionState;
} | null => {
  if (!isRecordValue(error) || error.code !== 'credential_verification_failed') {
    return null;
  }
  const details = isRecordValue(error.details) ? error.details : null;
  if (
    details?.verification_status !== 'auth_failed'
    || details.existing_credential_preserved !== true
  ) return null;
  const correction = validatedConnectionCredentialRejectionCorrection(
    details.correction,
    schema.kind,
  );
  if (correction === null) return null;
  const correctionState = connectionCredentialCorrectionState(
    correction,
    schema,
    values,
    errMessage(error),
  );
  if (
    correctionState !== null
    && hasCredentialRegenerationSafeStop(correction)
  ) correctionState.safeStopClosure = { phase: 'checking', error: null };
  return correctionState === null
    ? null
    : { correction, state: correctionState };
};

/** Map only failures with a concrete, evidenced remedy. Unknown provider
 * responses stay verbatim instead of guessing which credential is wrong. */
const oauthCorrection = (message: string): OAuthCorrection => {
  const normalized = message.toLowerCase();
  if (normalized.includes('requires client_secret')) {
    return {
      message: 'This provider requires its client secret. Re-copy the secret issued for this exact app, then retry.',
      fieldKey: 'auth.client_secret',
    };
  }
  if (normalized.includes('client_id is required')) {
    return {
      message: 'Paste the provider-issued Client ID before authorizing.',
      fieldKey: 'auth.client_id',
    };
  }
  if (normalized.includes('authorize_url')) {
    return {
      message: 'The Authorize URL must be a complete HTTPS provider endpoint.',
      fieldKey: 'auth.authorize_url',
    };
  }
  if (normalized.includes('token_endpoint')) {
    return {
      message: 'The Token Endpoint must be a complete HTTPS provider endpoint.',
      fieldKey: 'auth.token_endpoint',
    };
  }
  if (
    normalized.includes('invalid_client')
    || normalized.includes('client id or secret')
    || normalized.includes('client credentials')
  ) {
    return {
      message: 'The provider rejected this app identity. Re-copy the Client ID first, then verify its matching client secret.',
      fieldKey: 'auth.client_id',
    };
  }
  if (normalized.includes('redirect_uri') || normalized.includes('redirect uri')) {
    return {
      // Same defect d97baf6c7 fixed on the form: naming the CLOUD URL here sends
      // a loopback owner to register a URI their flow will never use.
      message: `The callback did not match. Register ${resolveOAuthCallbackUrlForThisPwa()} exactly in the provider app, then retry.`,
      fieldKey: null,
    };
  }
  if (normalized.includes('server public url')) {
    return {
      message: 'Your server needs a reachable HTTPS address before provider authorization can return to Recued. Check the active server profile, then retry.',
      fieldKey: null,
    };
  }
  return { message, fieldKey: null };
};

const asKind = (raw: string | undefined): ConnectionKind | null =>
  raw !== undefined && VALID_KINDS.has(raw) ? (raw as ConnectionKind) : null;

interface ConnectionEditorRevision {
  readonly key: string;
  readonly updatedAt?: number;
  readonly fingerprint: string;
}

interface ConnectionDialogDraftBaseline {
  readonly dialogGeneration: number;
  readonly values: ConnectionFormValues;
  readonly oauthGrantedScopes: readonly string[] | null;
}

/** Compare in place rather than serializing the live form: a typed credential
 * must not gain an unnecessary second copy inside a JSON fingerprint. Empty
 * controls equal absent controls, and granted scopes have set semantics. */
const connectionDialogDraftChanged = (
  values: ConnectionFormValues,
  oauthGrantedScopes: readonly string[] | null,
  baselineValues: ConnectionFormValues,
  baselineOAuthGrantedScopes: readonly string[] | null,
): boolean => {
  const keys = new Set([
    ...Object.keys(values),
    ...Object.keys(baselineValues),
  ]);
  for (const key of keys) {
    if ((values[key] ?? '') !== (baselineValues[key] ?? '')) return true;
  }
  const grantedScopes = new Set(oauthGrantedScopes ?? []);
  const baselineGrantedScopes = new Set(baselineOAuthGrantedScopes ?? []);
  return grantedScopes.size !== baselineGrantedScopes.size
    || [...grantedScopes].some((scope) => !baselineGrantedScopes.has(scope));
};

const stableConnectionValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableConnectionValue);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'bound_pack_slugs'
        && key !== 'supports_engagement_health')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, stableConnectionValue(nested)]),
  );
};

/** List decorators can move independently of the connection row. Exclude them
 * from the fallback fingerprint; the server-stamped revision remains primary. */
const connectionEditorRevision = (
  view: ConnectionView,
): ConnectionEditorRevision => ({
  key: connectionRowKey(view.kind, view.name),
  ...(typeof view.updated_at === 'number' && Number.isSafeInteger(view.updated_at)
    ? { updatedAt: view.updated_at }
    : {}),
  fingerprint: JSON.stringify(stableConnectionValue(view)),
});

const connectionRevisionChanged = (
  before: ConnectionEditorRevision,
  after: ConnectionView,
): boolean => {
  const next = connectionEditorRevision(after);
  if (before.updatedAt !== undefined && next.updatedAt !== undefined) {
    return before.updatedAt !== next.updatedAt;
  }
  return before.fingerprint !== next.fingerprint;
};

type CredentialRotationRecoveryState = NonNullable<
  ConnectionsPageState['credentialRotationRecovery']
>;

/** The marker-backed attempt has already reached a terminal outcome for these
 * phases. They are a memory-only, secret-free offer to verify that a brand-new
 * editor is still safe to open; marker reconciliation must not clear them. */
const isFreshStartCredentialRotationRecovery = (
  recovery: ConnectionsPageState['credentialRotationRecovery'],
): recovery is CredentialRotationRecoveryState => recovery !== null && (
  recovery.phase === 'restart_ready'
  || recovery.phase === 'editor_ready'
  || recovery.phase === 'restart_checking'
  || recovery.phase === 'restart_triaging'
  || recovery.phase === 'restart_handoff'
  || recovery.phase === 'restart_waiting'
  || recovery.phase === 'restart_unsupported'
  || recovery.phase === 'restart_resolved'
);

const canRunFreshStartCredentialRotationPreflight = (
  recovery: ConnectionsPageState['credentialRotationRecovery'],
): recovery is CredentialRotationRecoveryState => recovery !== null
  && recovery.serverUpdateProgress === undefined
  && (
    recovery.phase === 'restart_ready'
    || recovery.phase === 'editor_ready'
    || recovery.phase === 'restart_handoff'
    || recovery.phase === 'restart_waiting'
    || recovery.phase === 'restart_unsupported'
    || recovery.phase === 'restart_resolved'
  );

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
    // D-238 — a declared constant (an OAuth token endpoint, a fixed API root).
    // A hidden field with only a `placeholder` projects as ABSENT, so the form
    // blocks on a value the owner cannot see or supply.
    if (field.initial !== undefined && field.initial.length > 0) {
      values[field.key] = field.initial;
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

/** The EXACT provider callback URL for THIS PWA's origin.
 *
 *  ⛔ Resolved from the live origin, never the cloud constant. `page.ts` used to
 *  print `OAUTH_CLOUD_CALLBACK_URL` unconditionally beneath "Register this
 *  unchanged in the provider app" — but `pickOAuthCallbackHost` sends a LOOPBACK
 *  PWA's flow to its own origin (R26.2 Option B), so on a self-served
 *  `127.0.0.1` webclient the printed URI and the used URI disagreed and the
 *  provider answered `redirect_uri_mismatch`.
 *
 *  Falls back to the cloud URL off-browser, which is what a non-loopback PWA
 *  resolves to anyway. */
const resolveOAuthCallbackUrlForThisPwa = (): string => {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  return typeof origin === 'string' && origin.length > 0
    ? oauthCallbackUrlForPwa(origin)
    : OAUTH_CLOUD_CALLBACK_URL;
};

/** The OTHER usable address's callback URL, when there is one to name. */
const resolveOAuthCallbackAlternateForThisPwa = (): string | undefined => {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (typeof origin !== 'string' || origin.length === 0) return undefined;
  return alternateOAuthCallbackUrl(origin) ?? undefined;
};

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
  /** A safe stop cleared only for the duration of the popup flow. Failed or
   * timed-out authorization restores it; a claimed fresh token retires it. */
  credentialSafeStop?: ConnectionsDialogCredentialCorrectionState;
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
  /** Host-owned state for the generated MCP pack's shared install picker. It
   *  is deliberately separate from the pure shared-page render model: the
   *  latter contains only reviewed tool disclosure, while this is the consent
   *  that becomes `install_scope`. Reset on every review open/close. */
  let mcpPackGrantModel: InstallGrantPickerModel | null = null;
  let mcpPackGrantAccess: InstallAccessTier = 'read';
  let mcpPackGrantAudience: InstallAudienceSelection =
    resolveInstallAudienceSelection(undefined);
  let disposed = false;
  let postSafeStopProfileLabel = (() => {
    const label = opts.postSafeStopProfileLabel?.trim();
    return label === undefined || label.length === 0 ? undefined : label;
  })();
  let postSafeStopProfileHandoff = (() => {
    const handoff = opts.postSafeStopProfileHandoff;
    if (handoff === undefined) return null;
    const activeProfileLabel = handoff.activeProfileLabel.trim();
    const sourceProfileLabel = handoff.sourceProfileLabel?.trim();
    return {
      reason: handoff.reason,
      activeProfileLabel: activeProfileLabel.length > 0
        ? activeProfileLabel
        : 'this server profile',
      ...(sourceProfileLabel !== undefined && sourceProfileLabel.length > 0
        ? { sourceProfileLabel }
        : {}),
      serverProfilesAvailable:
        handoff.serverProfilesAvailable
        && opts.onOpenPostSafeStopServerProfiles !== undefined,
    } satisfies ConnectionsPostSafeStopProfileHandoff;
  })();
  // A mismatched/unbound route may never decay into the ordinary cold-start
  // behavior that selects the first active-server recovery. Dismiss keeps this
  // guard for the mount; only the explicit "Review this server instead" choice
  // releases it.
  let suppressAutomaticPostSafeStopRecovery =
    postSafeStopProfileHandoff !== null;
  // Bumped before every list await; a post-await write only lands when its
  // captured generation is still current (drops a stale in-flight list when
  // a newer refresh / delete-driven re-list overtakes it).
  let loadGeneration = 0;
  let pendingLoad: Promise<void> = Promise.resolve();
  // Separates the acknowledgement handoff's causal check from ordinary row
  // probes. A later check (or ordinary probe) invalidates an older completion
  // before it can overwrite the receipt the owner is currently reading.
  let postSafeStopVerificationGeneration = 0;
  // Bumped by every dialog navigation (open / pick / back / cancel / edit /
  // reset). A submit captures the current value before its rpc; if a
  // navigation bumps it mid-flight, the completion is stale and must not
  // reset / clobber the newer dialog the user has moved on to.
  let dialogGen = 0;
  // Safe snapshot of the exact list row an edit form was built from. Form
  // values (including replacement credentials) stay in `dialog.values`; this
  // carries only the server revision + auth-excluded view fingerprint used to
  // detect a stale editor after a sibling/focus refresh.
  let editorRevision: ConnectionEditorRevision | null = null;
  // Exact, memory-only baseline for route/reload protection. Unlike
  // `editorRevision`, this intentionally includes the current form values so a
  // draft can be compared without ever copying it into browser storage, a URL,
  // Account, or another tab.
  let dialogDraftBaseline: ConnectionDialogDraftBaseline | null = null;
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
  // A guide call is a paid owner-triggered model request. Keep a mount-level
  // lock across dialog navigation so Back/Close cannot start a duplicate while
  // the first call still settles; generation drops its stale presentation.
  let guideInFlight = false;
  let guideGeneration = 0;
  let credentialRotationTabUnsub: (() => void) | null = null;
  let credentialRotationServerUpdateUnsub: (() => void) | null = null;
  let credentialRotationServerUpdateRetrySettled = false;
  let credentialRotationServerUpdateRetryTarget:
    CredentialRotationServerUpdateTarget | null = null;
  let credentialRotationCleanEditorContinuityRetired = false;
  let credentialRotationStartedSignalGeneration = 0;
  let credentialRotationFreshStartPreflightGeneration = 0;
  let credentialRotationOwnershipLease: {
    key: string;
    kind: ConnectionKind;
    name: string;
    lease: CredentialRotationOwnershipLease;
    announced: boolean;
  } | null = null;
  let credentialRotationActivityCheck: {
    key: string;
    dialogGeneration: number;
    ownership: NonNullable<
      ConnectionsPageState['dialog']['credentialRotationOwnership']
    >;
    promise: Promise<void>;
  } | null = null;
  let credentialRotationSafeStopCheck: {
    key: string;
    generation: number;
    pauseRequired: boolean;
    promise: Promise<void>;
  } | null = null;
  let credentialRotationSafeStopCheckGeneration = 0;
  /** Opaque CAS capability for the exact safe stop currently rendered. It is
   * never copied into renderer state, HTML, browser storage, a URL, or a tab
   * message. */
  let credentialRotationSafeStopClosure: {
    key: string;
    acknowledgementToken: string;
  } | null = null;
  let credentialRotationSafeStopAcknowledgementGeneration = 0;
  /** Memory-only acknowledgement for the current editor generation. Once the
   * owner materially corrects a confirmed safe stop (or explicitly confirms a
   * provider-side fix), routine focus/reconnect reads must not resurrect that
   * historical stop before the promised one new verification. A fresh exact
   * sibling safe-stop signal still overrides this local acknowledgement. */
  let credentialRotationResolvedSafeStopEditor: {
    key: string;
    dialogGeneration: number;
  } | null = null;
  let credentialRotationSuccessorPollTimer:
    | ReturnType<typeof setTimeout>
    | null = null;

  const captureDialogDraftBaseline = (): void => {
    if (state.dialog.stage !== 'form') {
      dialogDraftBaseline = null;
      return;
    }
    dialogDraftBaseline = {
      dialogGeneration: dialogGen,
      values: { ...state.dialog.values },
      oauthGrantedScopes: state.dialog.oauthGrantedScopes === null
        ? null
        : [...state.dialog.oauthGrantedScopes],
    };
  };

  const updateDialogDraftBaselineValues = (
    update: (values: ConnectionFormValues) => ConnectionFormValues,
  ): void => {
    const baseline = dialogDraftBaseline;
    if (
      baseline === null
      || baseline.dialogGeneration !== dialogGen
      || state.dialog.stage !== 'form'
    ) return;
    dialogDraftBaseline = {
      ...baseline,
      values: update({ ...baseline.values }),
    };
  };

  const hasUnsavedConnectionDraft = (): boolean => {
    const baseline = dialogDraftBaseline;
    return !disposed
      && state.dialog.stage === 'form'
      && baseline !== null
      && baseline.dialogGeneration === dialogGen
      && connectionDialogDraftChanged(
        state.dialog.values,
        state.dialog.oauthGrantedScopes,
        baseline.values,
        baseline.oauthGrantedScopes,
      );
  };

  const connectionDraftLeavePrompt = (): string | null => {
    if (!hasUnsavedConnectionDraft()) return null;
    if (state.dialog.saving) {
      return 'Leave while this Connection is saving? Choose Cancel to stay. Recued may still save it, and if you leave and it goes wrong, what you typed cannot be brought back.';
    }
    const subject = state.dialog.mode === 'edit'
      && state.dialog.editingId !== null
      ? `changes to ${state.dialog.editingId}`
      : 'this new connection setup';
    // A completed provider consent lives ONLY in this draft until Save. The
    // generic "credential fields cannot be restored" reads as "retype your
    // secret" — it does not tell you that OK means going back through the
    // provider's consent screen. Name the actual cost when there is one.
    if (state.dialog.oauthGrantedScopes !== null) {
      return `Discard ${subject}? The provider authorization you just completed has not been saved yet and will be discarded with it — you would have to authorize with the provider again. Select Cancel to stay and keep editing, or OK to discard.`;
    }
    return `Discard ${subject}? Select Cancel to stay and keep editing, or OK to discard. Credential fields are not saved in your browser and cannot be restored after leaving.`;
  };

  const confirmDiscardConnectionDraft = (): boolean => {
    const prompt = connectionDraftLeavePrompt();
    if (prompt === null) return true;
    const confirm = opts.confirmDiscardDraft
      ?? doc.defaultView?.confirm?.bind(doc.defaultView);
    return confirm === undefined ? true : confirm(prompt);
  };

  const retireProviderSetupContinuity = (): void => {
    opts.providerSetupContinuity?.retire();
  };

  const markCredentialRotationCleanEditorReady = (
    kind: ConnectionKind,
    name: string,
  ): void => {
    credentialRotationCleanEditorContinuityRetired = false;
    try {
      opts.onCredentialRotationCleanEditorReady?.({ kind, name });
      credentialRotationServerUpdateRetrySettled = true;
      credentialRotationServerUpdateRetryTarget = null;
    } catch {
      // The clean local editor remains usable. Keeping the existing durable
      // preflight marker is safer than pretending host bookkeeping completed.
    }
  };

  const retireCredentialRotationCleanEditorContinuity = (
    kind: ConnectionKind,
    name: string,
  ): void => {
    if (credentialRotationCleanEditorContinuityRetired) return;
    try {
      opts.onCredentialRotationCleanEditorChanged?.({ kind, name });
      credentialRotationCleanEditorContinuityRetired = true;
    } catch {
      // A later edit can retry this target-only retirement. No form value is
      // ever passed to the host callback.
    }
  };

  const resetMcpPackGrantSelection = (): void => {
    mcpPackGrantModel = null;
    mcpPackGrantAccess = 'read';
    mcpPackGrantAudience = resolveInstallAudienceSelection(undefined);
  };

  /** The exact consent the open review will send. Null means there is no
   *  reviewed, grantable generated pack and therefore no install scope to
   *  invent. Access is clamped again here so programmatic/test callers cannot
   *  submit a tier the reviewed tool set did not offer. */
  const effectiveMcpPackInstallScope = (): InstallGrantSelection | null => {
    const review = state.mcpPackReview;
    const model = mcpPackGrantModel;
    if (review?.view === null || review?.view === undefined || model === null) {
      return null;
    }
    const access = model.accessOptions.includes(mcpPackGrantAccess)
      ? mcpPackGrantAccess
      : model.defaultAccess;
    return {
      access,
      audience: resolveInstallAudienceSelection(mcpPackGrantAudience),
    };
  };

  const setMcpPackGrantAccess = (tier: InstallAccessTier): void => {
    if (state.mcpPackReview?.saving === true) return;
    if (mcpPackGrantModel === null) return;
    if (!mcpPackGrantModel.accessOptions.includes(tier)) return;
    mcpPackGrantAccess = tier;
    render();
  };

  const setMcpPackGrantAudience = (
    audience: InstallAudienceSelection,
  ): void => {
    if (state.mcpPackReview?.saving === true || mcpPackGrantModel === null) return;
    mcpPackGrantAudience = resolveInstallAudienceSelection(audience);
    render();
  };

  /** `renderConnectionsPage` is intentionally a pure HTML-string renderer.
   *  Adopt its slot and mount the same interactive picker ordinary Pack install
   *  and Kitchen already use, so copy, tier rules, and Audience semantics have
   *  one implementation. */
  const mountMcpPackInstallScopePicker = (): void => {
    const review = state.mcpPackReview;
    const model = mcpPackGrantModel;
    if (review?.view === null || review?.view === undefined || model === null) return;
    const slot = host.querySelector<HTMLElement>(
      `[${MCP_PACK_INSTALL_SCOPE_HOST_ATTR}]`,
    );
    if (slot === null) return;
    slot.appendChild(renderInstallGrantPicker({
      document: doc,
      model,
      access: effectiveMcpPackInstallScope()?.access ?? model.defaultAccess,
      audience: mcpPackGrantAudience,
      disabled: review.saving,
      onAccess: setMcpPackGrantAccess,
      onAudience: setMcpPackGrantAudience,
    }));
  };

  const render = (): void => {
    if (disposed) return;
    let serverUpdateProgress: ServerUpdateTabProgress | null = null;
    if (state.dialog.stage === 'form') {
      serverUpdateProgress = opts.credentialRotationTabConvergence
        ?.readServerUpdateProgress() ?? null;
      if (serverUpdateProgress !== null) {
        // A form opened after the sibling's one-shot channel hint needs the
        // same explanation as a form that was already open when it arrived.
        state.dialog.error = serverUpdateEditorPauseCopy(serverUpdateProgress);
      } else if (
        state.dialog.error?.startsWith(SERVER_UPDATE_EDITOR_PAUSE_PREFIX)
          === true
      ) {
        state.dialog.error = null;
      }
    }
    host.innerHTML = renderConnectionsPage({
      ...state,
      layout: 'embedded',
      credentialRotationServerUpdateGuideAvailable:
        opts.onOpenCredentialRotationServerUpdateGuide !== undefined,
      ...(postSafeStopProfileLabel !== undefined
        ? { postSafeStopProfileLabel }
        : {}),
      ...(postSafeStopProfileHandoff !== null
        ? { postSafeStopProfileHandoff }
        : {}),
    });
    mountMcpPackInstallScopePicker();
    if (
      serverUpdateProgress !== null
      && typeof host.querySelector === 'function'
    ) {
      host.querySelector(SUBMIT_SELECTOR)?.setAttribute('disabled', '');
    }
  };

  /** A sibling hint can arrive between keystrokes. Rebuilding is needed to
   * expose the blocking warning, but the draft must keep both its value and
   * keyboard position. */
  const renderPreservingActiveField = (): void => {
    const active = host.ownerDocument?.activeElement as (HTMLElement & {
      selectionStart?: number | null;
      selectionEnd?: number | null;
      selectionDirection?: 'forward' | 'backward' | 'none' | null;
      setSelectionRange?: (
        start: number,
        end: number,
        direction?: 'forward' | 'backward' | 'none',
      ) => void;
    }) | null;
    const key = active != null && host.contains(active)
      ? active.dataset?.connField
      : undefined;
    const selectionStart = active?.selectionStart;
    const selectionEnd = active?.selectionEnd;
    const selectionDirection = active?.selectionDirection ?? undefined;
    render();
    if (key === undefined || typeof host.querySelector !== 'function') return;
    const replacement = host.querySelector(
      `[data-conn-field="${key}"]`,
    ) as (HTMLElement & {
      setSelectionRange?: (
        start: number,
        end: number,
        direction?: 'forward' | 'backward' | 'none',
      ) => void;
    }) | null;
    replacement?.focus?.({ preventScroll: true });
    if (
      replacement?.setSelectionRange !== undefined
      && typeof selectionStart === 'number'
      && typeof selectionEnd === 'number'
    ) {
      try {
        replacement.setSelectionRange(
          selectionStart,
          selectionEnd,
          selectionDirection,
        );
      } catch {
        // Some input types expose selection APIs but reject their use.
      }
    }
  };

  /** Pack-context reads repaint the whole shared page. Preserve an unrelated
   *  form field (including its caret) or exact delegated list action across
   *  that background repaint; a Retry that owns focus is handled separately
   *  because success advances it to the recovered content. */
  const renderPreservingPackContextFocus = (): void => {
    // ⛔ `?? null` IS LOAD-BEARING. `ownerDocument?.activeElement` yields
    // UNDEFINED when either is absent, and the `as HTMLElement | null` cast
    // said otherwise — so the `!== null` guards below passed and `.dataset`
    // threw. Normalised here so the declared type is true and both guards
    // mean what they read as. (The sibling above copes with `!= null`.)
    const active = (host.ownerDocument?.activeElement ?? null) as HTMLElement | null;
    if (
      active !== null
      && host.contains(active)
      && active.dataset?.connField !== undefined
    ) {
      renderPreservingActiveField();
      return;
    }
    const activeDataset = active !== null
      && host.contains(active)
      && active.dataset?.action !== undefined
      ? Object.fromEntries(
          Object.entries(active.dataset)
            .filter((entry): entry is [string, string] => entry[1] !== undefined),
        )
      : null;
    render();
    const queryable = host as HTMLElement & {
      querySelectorAll?: (selector: string) => NodeListOf<HTMLElement>;
    };
    if (activeDataset === null || typeof queryable.querySelectorAll !== 'function') return;
    const replacement = [
      ...(queryable.querySelectorAll('[data-action]') as NodeListOf<HTMLElement>),
    ]
      .find((candidate) => Object.entries(activeDataset).every(
        ([key, value]) => candidate.dataset[key] === value,
      ));
    replacement?.focus?.({ preventScroll: true });
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
        if (onEmailForm && state.dialog.externalChange === null) {
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
              updateDialogDraftBaselineValues((baselineValues) => ({
                ...baselineValues,
                [field.key]: '',
              }));
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
        // `send_capable` at send time (and the live enrollment follow-up probe
        // is the proper closure). So a sender that lost capability between the
        // last good hydrate and submit fails LOUDLY at send time, never silent — a
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

  /** R26.2 Option B — the loopback self-serve path is wired INDEPENDENTLY of the
   *  cloud one, and deliberately so: it needs neither `startVendorOAuth` (whose
   *  signed state demands a public server URL) nor `takeVendorOAuthResult` nor
   *  the broadcast bus, because the code never leaves this machine. Gating it
   *  behind `vendorOAuthWired()` would refuse a loopback-only host for missing
   *  exactly the callers it has no use for. */
  const loopbackSelfServeWired = (): boolean =>
    opts.runCompleteVendorOAuth !== undefined
    && oauthEnv !== undefined
    && isLoopbackOrigin(
      (opts.foundationalOAuthEnv ?? defaultFoundationalOAuthEnv()).origin,
    );

  const focusOAuthCorrection = (
    fieldKey: ConnectionOAuthCredentialFieldKey | null,
  ): void => {
    if (disposed) return;
    focusGuideTarget(
      fieldKey === null
        ? OAUTH_AUTHORIZE_SELECTOR
        : `[data-conn-field="${fieldKey}"]`,
    );
  };

  const setOAuthCorrection = (correction: OAuthCorrection): void => {
    state.dialog.oauthError = correction.message;
    state.dialog.oauthErrorFieldKey = correction.fieldKey;
  };

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
      if (
        p.credentialSafeStop !== undefined
        && state.dialog.credentialCorrection === null
      ) state.dialog.credentialCorrection = p.credentialSafeStop;
      setOAuthCorrection(oauthCorrection(outcome.error));
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
      state.dialog.oauthErrorFieldKey = null;
      state.dialog.oauthNeedsReauthorization = false;
      if (p.credentialSafeStop !== undefined) {
        retireCredentialRegenerationSafeStop(p.credentialSafeStop);
        state.dialog.credentialCorrection = null;
      }
      if (state.dialog.kind !== null) {
        clearFreshStartCredentialRotationRecovery(
          state.dialog.kind,
          state.dialog.values.name ?? '',
        );
      }
      syncCredentialRotationSuccessorEligibility();
    }
    render();
    if ('error' in outcome) {
      focusOAuthCorrection(state.dialog.oauthErrorFieldKey);
    } else {
      focusGuideTarget(SUBMIT_SELECTOR);
    }
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
    credentialSafeStop?: ConnectionsDialogCredentialCorrectionState;
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
        /** ⛔⛔⛔ RESOLVED FROM THIS PWA'S ORIGIN, never the cloud constant.
         *  Hardcoding the cloud URL here made the flow UNUSABLE on a loopback
         *  webclient: the cloud relay shares `sessionStorage` with
         *  app.recued.com, NOT with `127.0.0.1`, so the code could never reach
         *  the opener that minted the state. R26.2 Option B exists for exactly
         *  this — the server serves its own relay at
         *  `/webclient/oauth-callback.html` so the whole round-trip stays on the
         *  owner's machine — and it was fully built, tested, and never reached,
         *  because this one line never asked for it.
         *  ⚠ It must equal what the form TELLS the owner to register; the two
         *  now come from the same helper so they cannot drift apart. */
        redirect_uri: resolveOAuthCallbackUrlForThisPwa(),
        sandbox: ctx.sandbox,
        ...(ctx.authorize_url !== undefined ? { authorize_url: ctx.authorize_url } : {}),
        ...(ctx.token_endpoint !== undefined ? { token_endpoint: ctx.token_endpoint } : {}),
        ...(ctx.scopes !== undefined ? { scopes: ctx.scopes } : {}),
      });
    } catch (err) {
      closePopupQuietly(ctx.popup);
      if (!disposed && ctx.dialogGen === dialogGen) {
        state.dialog.oauthInFlight = false;
        if (
          ctx.credentialSafeStop !== undefined
          && state.dialog.credentialCorrection === null
        ) state.dialog.credentialCorrection = ctx.credentialSafeStop;
        setOAuthCorrection(oauthCorrection(errMessage(err)));
        render();
        focusOAuthCorrection(state.dialog.oauthErrorFieldKey);
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
      if (
        ctx.credentialSafeStop !== undefined
        && state.dialog.credentialCorrection === null
      ) state.dialog.credentialCorrection = ctx.credentialSafeStop;
      setOAuthCorrection({
        message: 'Recued could not open the other service’s sign-in page. What you typed is still here. Try again.',
        fieldKey: null,
      });
      render();
      focusOAuthCorrection(null);
      return;
    }
    // The provider consent transition is now real. Retire the guide-resume
    // marker only after navigation succeeds so a blocked/failed start can
    // still recover the provider-app walkthrough on reload.
    retireProviderSetupContinuity();
    state.dialog.setupGuide.resumeAvailable = false;
    state.dialog.setupGuide.resumeFieldKey = null;
    render();
    const timer = oauthEnv.setTimeout(() => {
      const p = pendingOAuth;
      if (p !== null && p.flow_id === started.flow_id) {
        settlePendingOAuth(p, {
          error:
            'Signing in took too long and never came back to Recued. What you typed is still here. Check the exact address to come back to, and the app keys shown above, then try again.',
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
      ...(ctx.credentialSafeStop === undefined
        ? {}
        : { credentialSafeStop: ctx.credentialSafeStop }),
    };
  };

  /** Click handler — SYNCHRONOUS up to `window.open` so the popup survives the
   *  blocker, then hands off to the async driver. */
  /** R26.2 Option B for vendor connections — the whole dance on this machine.
   *
   *  Runs INSTEAD of `startVendorOAuth` when the PWA is on loopback, because
   *  that rpc refuses without a clean HTTPS server public URL: its signed state
   *  carries one and both of its redirect choices end at
   *  `<server_url>/oauth/complete`. A self-hosted server reached at
   *  `http://127.0.0.1:<port>` has none, which is the "needs a reachable HTTPS
   *  address" dead end.
   *
   *  Nothing here is new machinery. `runOAuthPopup` is the foundational flow's
   *  driver (it mints the `frelay_` state, pins the sender origin and verifies
   *  the full state for CSRF); the relay page is the one the LAN webclient
   *  bundle already serves same-origin; and `completeVendorOAuth` is the
   *  pure-exchange rpc that never needed a public server. Option B simply was
   *  never pointed at vendor connections.
   *
   *  ⚠ `noQueryMarker: true`. Entra rejects a query string in a registered
   *  redirect URI, and on the loopback page the marker is redundant anyway —
   *  that page is opener-relay-only and discriminates on the state prefix. It
   *  also makes the registered URI byte-identical to what the form prints. */
  const runLoopbackSelfServeOAuth = async (
    popup: VendorOAuthPopupHandle,
    vendor: string,
    values: Record<string, string>,
  ): Promise<void> => {
    const complete = opts.runCompleteVendorOAuth;
    const fenv = opts.foundationalOAuthEnv ?? defaultFoundationalOAuthEnv();
    if (complete === undefined) return;
    const redirect_uri = buildOpenerRelayRedirectUri(fenv.origin, true);
    const authorizeBase = (values['auth.authorize_url'] ?? '').trim();
    const token_endpoint = (values['auth.token_endpoint'] ?? '').trim();
    const client_id = (values['auth.client_id'] ?? '').trim();
    const client_secret = (values['auth.client_secret'] ?? '').trim();
    const scopes = (values['auth.scopes'] ?? '').trim();

    state.dialog.oauthInFlight = true;
    render();
    const outcome = await runOAuthPopup(fenv, {
      popup: popup as unknown as Parameters<typeof runOAuthPopup>[1]['popup'],
      // Same-origin by construction on loopback: the relay page is served from
      // this very origin, so the only sender we trust is ourselves.
      expectedSenderOrigin: new URL(redirect_uri).origin,
      buildAuthorizeUrl: (oauthState) => {
        const url = new URL(authorizeBase);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', client_id);
        url.searchParams.set('redirect_uri', redirect_uri);
        url.searchParams.set('state', oauthState);
        if (scopes.length > 0) url.searchParams.set('scope', scopes);
        return url.toString();
      },
    });
    if (disposed) return;
    state.dialog.oauthInFlight = false;
    if (!outcome.ok) {
      setOAuthCorrection({
        message: outcome.reason === 'popup_blocked'
          ? 'Your browser blocked the pop-up. Allow pop-ups for this Recued address, then try again. What you typed is unchanged.'
          : outcome.reason === 'denied'
            ? 'The provider did not grant access. Check the app’s permissions, then retry.'
            : `Authorization did not finish (${outcome.reason}). Your credential entries are unchanged.`,
        fieldKey: null,
      });
      render();
      focusOAuthCorrection(null);
      return;
    }
    try {
      const result = await complete({
        vendor,
        code: outcome.code,
        redirect_uri,
        client_id,
        ...(client_secret.length > 0 ? { client_secret } : {}),
        // Ignored for a registered vendor — the server always prefers its
        // registry config, so these can never weaken one.
        ...(authorizeBase.length > 0 ? { authorize_url: authorizeBase } : {}),
        ...(token_endpoint.length > 0 ? { token_endpoint } : {}),
      });
      if (disposed) return;
      state.dialog.values = applyVendorOAuthResultValues(
        vendor,
        state.dialog.values,
        { refresh_token: result.refresh_token },
        {},
      );
      state.dialog.oauthGrantedScopes = result.granted_scopes;
      state.dialog.oauthError = null;
      state.dialog.oauthErrorFieldKey = null;
      state.dialog.oauthNeedsReauthorization = false;
      render();
    } catch (err) {
      if (disposed) return;
      setOAuthCorrection(oauthCorrection(humanizeRpcError(err)));
      render();
      focusOAuthCorrection(null);
    }
  };

  const startVendorOAuthFromClick = (): void => {
    const dialog = state.dialog;
    const vendor = dialog.vendor;
    // R14 — a generic oauth2_refresh form (no registered vendor) runs the dance
    // with the typed authorize/token URLs + scopes. D-238 widened this beyond
    // `api`: the predicate is shared with the renderer and the readiness
    // projection precisely so a Teams card cannot render an Authorize button the
    // handler then refuses, or the reverse.
    const isGeneric =
      vendor === null
      && connectionFormRunsOAuthDance({ kind: dialog.kind, values: dialog.values });
    if (
      (!vendorOAuthWired() && !loopbackSelfServeWired())
      || oauthEnv === undefined
      || (vendor === null && !isGeneric)
    ) {
      setOAuthCorrection({
        message:
          'In-app authorization is not available in this view yet. Paste a refresh token in the Refresh Token field—create one in your provider app.',
        fieldKey: null,
      });
      render();
      focusOAuthCorrection(null);
      return;
    }
    // `pendingOAuth` is assigned after the start RPC returns. The visible
    // in-flight bit also covers that pre-pending window so a delegated double
    // click cannot open two popups or launch two server flows.
    //
    // ⛔ This used to be a BARE `return` — the click did nothing and said
    // nothing. That is indistinguishable from a dead button, and it is reachable
    // on a path that is not a double click: the failure handlers clear
    // `oauthInFlight` only when `ctx.dialogGen === dialogGen`, so a generation
    // bump mid-flight leaves the latch set and every later click silently does
    // nothing. Whatever set it, the owner is owed a reason.
    if (dialog.saving || dialog.oauthInFlight || pendingOAuth !== null) {
      setOAuthCorrection({
        message: dialog.saving
          ? 'Saving this connection — wait for it to finish, then authorize.'
          : 'An authorization attempt is already open. Finish or close the provider window, then try again.',
        fieldKey: null,
      });
      render();
      focusOAuthCorrection(null);
      return;
    }
    const readiness = connectionOAuthCredentialReadiness({
      vendor,
      kind: dialog.kind,
      values: dialog.values,
    });
    if (readiness === null || readiness.issue !== null) {
      const issue = readiness?.issue ?? {
        fieldKey: null,
        message: 'Choose OAuth with refresh token before authorizing.',
      };
      setOAuthCorrection(issue);
      render();
      focusOAuthCorrection(issue.fieldKey);
      return;
    }
    const client_id = (dialog.values['auth.client_id'] ?? '').trim();
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
      formConfig = { authorize_url, token_endpoint, scopes };
    }
    // Open the popup INSIDE the gesture (a post-await open is blocked); the
    // async driver navigates this blank window to the authorize URL.
    const popup = oauthEnv.open('', '_blank');
    if (popup === null) {
      setOAuthCorrection({
        message: 'Your browser blocked the pop-up. Allow pop-ups for this Recued address, then try again. What you typed is unchanged.',
        fieldKey: null,
      });
      render();
      focusOAuthCorrection(null);
      return;
    }
    // R26.2 Option B — a LOOPBACK PWA finishes the dance on this machine and
    // never touches `startVendorOAuth`, which would refuse for want of a public
    // HTTPS server URL. Gated on the exchange caller being wired so an older
    // host silently keeps the cloud path rather than opening a popup that
    // cannot complete.
    if (loopbackSelfServeWired()) {
      void runLoopbackSelfServeOAuth(popup, vendor ?? GENERIC_OAUTH_VENDOR, dialog.values);
      return;
    }
    const client_secret = (dialog.values['auth.client_secret'] ?? '').trim();
    const sandbox = isVendorSandboxSelected(dialog.values);
    const credentialSafeStop = hasCredentialRegenerationSafeStop(
      dialog.credentialCorrection,
    )
      ? dialog.credentialCorrection ?? undefined
      : undefined;
    if (dialog.kind !== null && dialog.mode === 'edit') {
      invalidateCredentialRotationSafeStopCheckFor(
        dialog.kind,
        dialog.values.name ?? '',
      );
    }
    dialog.oauthError = null;
    dialog.oauthErrorFieldKey = null;
    dialog.oauthNeedsReauthorization = false;
    dialog.credentialCorrection = null;
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
      ...(credentialSafeStop === undefined ? {} : { credentialSafeStop }),
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

  const cancelCredentialRotationSuccessorPoll = (): void => {
    if (credentialRotationSuccessorPollTimer === null) return;
    globalThis.clearTimeout(credentialRotationSuccessorPollTimer);
    credentialRotationSuccessorPollTimer = null;
  };

  /** Activity reads cannot be aborted, but they are secret-free and read-only.
   * Detach an obsolete read from route-switch gating; its captured dialog and
   * ownership object still prevent any late result from landing. */
  const invalidateCredentialRotationActivityCheck = (): void => {
    credentialRotationActivityCheck = null;
    cancelCredentialRotationSuccessorPoll();
  };

  const invalidateCredentialRotationSafeStopCheck = (): void => {
    credentialRotationSafeStopCheckGeneration += 1;
    credentialRotationSafeStopCheck = null;
  };

  const invalidateCredentialSafeStopAcknowledgement = (
    clearToken = true,
  ): void => {
    credentialRotationSafeStopAcknowledgementGeneration += 1;
    if (clearToken) credentialRotationSafeStopClosure = null;
  };

  const invalidateCredentialRotationSafeStopCheckFor = (
    kind: ConnectionKind,
    name: string,
  ): void => {
    if (
      credentialRotationSafeStopCheck?.key === connectionRowKey(kind, name)
    ) invalidateCredentialRotationSafeStopCheck();
  };

  const releaseCredentialRotationOwnership = (
    announceRelease: boolean,
  ): void => {
    const held = credentialRotationOwnershipLease;
    credentialRotationOwnershipLease = null;
    cancelCredentialRotationSuccessorPoll();
    if (held === null) return;
    held.lease.release();
    if (announceRelease && held.announced) {
      opts.credentialRotationTabConvergence
        ?.notifyCredentialRotationReleased({
          kind: held.kind,
          name: held.name,
        });
    }
  };

  const rememberCredentialRotationOwnership = (
    kind: ConnectionKind,
    name: string,
    lease: CredentialRotationOwnershipLease,
  ): void => {
    const key = connectionRowKey(kind, name);
    if (credentialRotationOwnershipLease?.lease === lease) return;
    if (
      credentialRotationOwnershipLease !== null
      && credentialRotationOwnershipLease.lease !== lease
    ) releaseCredentialRotationOwnership(true);
    credentialRotationOwnershipLease = {
      key,
      kind,
      name,
      lease,
      announced: false,
    };
  };

  const announceCredentialRotationOwnership = (
    kind: ConnectionKind,
    name: string,
  ): void => {
    const held = credentialRotationOwnershipLease;
    if (
      held === null
      || held.key !== connectionRowKey(kind, name)
      || held.announced
    ) return;
    held.announced = true;
    opts.credentialRotationTabConvergence
      ?.notifyCredentialRotationStarted({ kind, name });
  };

  /** A resumable receipt is a one-shot presentation tied to a live,
   * memory-only editor. It never survives closing that editor or a newer
   * ownership/change signal for the same connection. */
  const clearResumableCredentialRotationRecovery = (
    kind?: ConnectionKind,
    name?: string,
  ): boolean => {
    const recovery = state.credentialRotationRecovery;
    if (
      recovery?.phase !== 'resumable'
      || (
        kind !== undefined
        && name !== undefined
        && (recovery.kind !== kind || recovery.name !== name)
      )
    ) return false;
    state.credentialRotationRecovery = null;
    return true;
  };

  /** The empty-draft receipt has served its purpose once the exact editor
   * contains a new replacement. Keeping it would incorrectly claim that no
   * draft exists while the normal ownership checks are already taking over. */
  const retireUntouchedCleanEditorIfCurrent = (): boolean => {
    const recovery = state.credentialRotationRecovery;
    if (
      recovery?.returnedFromServerUpdate !== true
      || (
        recovery.phase !== 'restart_ready'
        && recovery.phase !== 'editor_ready'
      )
      || state.dialog.stage !== 'form'
      || state.dialog.mode !== 'edit'
      || state.dialog.editingId !== connectionRowKey(
        recovery.kind,
        recovery.name,
      )
    ) return false;
    retireCredentialRotationCleanEditorContinuity(
      recovery.kind,
      recovery.name,
    );
    state.credentialRotationRecovery = null;
    return true;
  };

  const clearFreshStartCredentialRotationRecovery = (
    kind: ConnectionKind,
    name: string,
  ): boolean => {
    const recovery = state.credentialRotationRecovery;
    if (
      (
        recovery?.phase !== 'restart_ready'
        && recovery?.phase !== 'editor_ready'
      )
      || recovery.kind !== kind
      || recovery.name !== name
      || state.dialog.stage !== 'form'
      || state.dialog.mode !== 'edit'
      || state.dialog.editingId !== connectionRowKey(kind, name)
    ) return false;
    retireUntouchedCleanEditorIfCurrent();
    state.credentialRotationRecovery = null;
    return true;
  };

  // ── Dialog transitions ────────────────────────────────────────
  const resetDialog = (): void => {
    // A lease retained for an uncertain request stays boot-scoped until its
    // continuity marker reaches a terminal receipt. Draft-only/available
    // ownership is yielded when the owner closes the editor.
    const marker = opts.credentialRotationContinuity?.read() ?? null;
    if (
      credentialRotationOwnershipLease !== null
      && (
        marker === null
        || connectionRowKey(marker.kind, marker.name)
          !== credentialRotationOwnershipLease.key
      )
    ) releaseCredentialRotationOwnership(true);
    retireProviderSetupContinuity();
    cancelPendingOAuth();
    dialogGen += 1;
    invalidateCredentialRotationActivityCheck();
    invalidateCredentialRotationSafeStopCheck();
    invalidateCredentialSafeStopAcknowledgement();
    credentialRotationResolvedSafeStopEditor = null;
    guideGeneration += 1;
    editorRevision = null;
    dialogDraftBaseline = null;
    clearResumableCredentialRotationRecovery();
    // Preserve the recent-probe banner across a dialog close so the
    // post-save probe outcome stays visible above the list.
    const recentProbe = state.dialog.recentProbe ?? null;
    state.dialog = {
      ...initialConnectionsDialogState(),
      oauthCallbackUrl: resolveOAuthCallbackUrlForThisPwa(),
      oauthCallbackAlternateUrl: resolveOAuthCallbackAlternateForThisPwa(),
      recentProbe,
    };
  };

  /** Begin an IN-PLACE dialog navigation (Back / pick a different kind or
   *  subtype). Bumps `dialogGen` so any in-flight submit's completion is
   *  treated as stale, AND clears `saving` — these handlers mutate the
   *  existing dialog object, so without this a Back clicked mid-save would
   *  leave `saving=true` stuck on the next form (the re-entrancy guard then
   *  wedges every later submit). `resetDialog` / `edit` instead REPLACE the
   *  dialog with a fresh `saving:false` object, so they don't need this. */
  const beginDialogNavigation = (): void => {
    releaseCredentialRotationOwnership(true);
    retireProviderSetupContinuity();
    cancelPendingOAuth();
    dialogGen += 1;
    invalidateCredentialRotationActivityCheck();
    invalidateCredentialRotationSafeStopCheck();
    invalidateCredentialSafeStopAcknowledgement();
    guideGeneration += 1;
    editorRevision = null;
    dialogDraftBaseline = null;
    state.dialog.saving = false;
    /** ⛔⛔⛔ THE CALLBACK URL BELONGS TO EVERY OPENED DIALOG, SET HERE ONCE. The five
     *  in-place open paths MUTATE the existing dialog field by field rather than
     *  rebuilding it, so each carries a hand-written list of what to set — and
     *  `openVendorEnrollForm` (the `#connections/others/enroll/<vendor>` deep link,
     *  which is where the packs "Set up" CTA lands) never listed the callback fields.
     *  The renderer falls back to `OAUTH_CLOUD_CALLBACK_URL` on an unset field, so
     *  that form told the owner to register the CLOUD callback while on a loopback
     *  address — a URL the flow does not use and the provider cannot match. The
     *  re-authorize dialog, which REBUILDS its state, showed the right one; the same
     *  screen disagreeing with itself is what makes this class of bug so hard to
     *  read from the outside.
     *  ⇒ Set on the shared entry every open path already calls, so a sixth path
     *  cannot reintroduce it by forgetting a line. The rebuilding sites set it too;
     *  that is harmless duplication, not a second source — both call one resolver. */
    state.dialog.oauthCallbackUrl = resolveOAuthCallbackUrlForThisPwa();
    state.dialog.oauthCallbackAlternateUrl = resolveOAuthCallbackAlternateForThisPwa();
    // A Back/pick clicked mid-OAuth must not leave the new form stuck on
    // "Authorizing…" or carry the prior provider's correction/scopes into a
    // different connection (this mutates the existing dialog object in place).
    state.dialog.oauthInFlight = false;
    state.dialog.oauthError = null;
    state.dialog.oauthErrorFieldKey = null;
    state.dialog.credentialCorrection = null;
    state.dialog.oauthNeedsReauthorization = false;
    state.dialog.oauthGrantedScopes = null;
    state.dialog.setupGuide = initialConnectionsSetupGuideState();
  };

  const rotationFailureCopy = (
    reason: ConnectionCredentialRotationFailureReason,
  ): string => {
    if (reason === 'auth_failed') {
      return 'The provider rejected the replacement. Your Recued kept the old key; correct the replacement and try again.';
    }
    if (reason === 'unreachable') {
      return "The provider check couldn't finish. Your Recued kept the old key; check the provider connection before retrying.";
    }
    if (reason === 'inconclusive') {
      return "The provider couldn't prove the replacement was valid. Your Recued kept the old key; review the endpoint before retrying.";
    }
    if (reason === 'conflict') {
      return 'This connection changed during verification, so the replacement was not applied. Review the latest connection before retrying.';
    }
    return 'The replacement did not complete. Your Recued kept the old key; review the connection before retrying.';
  };

  let credentialRotationReconcilePromise: Promise<void> | null = null;
  let credentialRotationSuccessorObservedAttemptId: string | null = null;
  let credentialRotationPollTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelCredentialRotationPoll = (): void => {
    if (credentialRotationPollTimer === null) return;
    globalThis.clearTimeout(credentialRotationPollTimer);
    credentialRotationPollTimer = null;
  };
  const scheduleCredentialRotationPoll = (): void => {
    cancelCredentialRotationPoll();
    credentialRotationPollTimer = globalThis.setTimeout(() => {
      credentialRotationPollTimer = null;
      if (!disposed) void reconcileCredentialRotation(true, false);
    }, CREDENTIAL_ROTATION_STATUS_POLL_MS);
  };
  const reconcileCredentialRotation = (
    refreshConnectionList = true,
    announceChecking = true,
  ): Promise<void> => {
    if (credentialRotationReconcilePromise !== null) {
      return credentialRotationReconcilePromise;
    }
    cancelCredentialRotationPoll();
    const marker = opts.credentialRotationContinuity?.read() ?? null;
    if (marker === null) {
      credentialRotationSuccessorObservedAttemptId = null;
      const recovery = state.credentialRotationRecovery;
      const exactResumableDraft = recovery?.phase === 'resumable'
        && state.dialog.stage === 'form'
        && state.dialog.mode === 'edit'
        && state.dialog.editingId === connectionRowKey(
          recovery.kind,
          recovery.name,
        );
      const freshStartPreflight =
        isFreshStartCredentialRotationRecovery(recovery);
      const crossTabSafeStop = recovery?.phase === 'safe_stop_checking'
        || recovery?.phase === 'safe_stopped'
        || recovery?.phase === 'safe_stop_unconfirmed';
      if (
        recovery !== null
        && !exactResumableDraft
        && !freshStartPreflight
        && !crossTabSafeStop
      ) {
        state.credentialRotationRecovery = null;
        // Recovery status is not rendered behind an unrelated open form.
        // Keep that editor's DOM/cursor stable while clearing hidden state.
        if (state.dialog.stage !== 'form') render();
      }
      return Promise.resolve();
    }
    if (marker.successorObservedAt !== undefined) {
      credentialRotationSuccessorObservedAttemptId = marker.attemptId;
    } else if (
      credentialRotationSuccessorObservedAttemptId !== null
      && credentialRotationSuccessorObservedAttemptId !== marker.attemptId
    ) credentialRotationSuccessorObservedAttemptId = null;

    const recoveryDialogGeneration = dialogGen;
    const originatingExactEditor = state.dialog.stage === 'form'
      && state.dialog.mode === 'edit'
      && state.dialog.editingId === connectionRowKey(marker.kind, marker.name);
    const markerStillCurrent = (): boolean => {
      const current = opts.credentialRotationContinuity?.read() ?? null;
      return current !== null
        && current.attemptId === marker.attemptId
        && current.kind === marker.kind
        && current.name === marker.name;
    };
    const exactEditorNow = (): boolean => !disposed
      && state.dialog.stage === 'form'
      && state.dialog.mode === 'edit'
      && state.dialog.editingId === connectionRowKey(marker.kind, marker.name);
    const exactEditorHasRetainedCredentialDraft = (): boolean => {
      if (
        !exactEditorNow()
        || state.dialog.kind === null
        || state.dialog.externalChange !== null
      ) return false;
      const schema = resolveConnectionSchema(
        state.dialog.kind,
        state.dialog.subtype ?? undefined,
        state.dialog.vendor ?? undefined,
      );
      return schema !== undefined
        && shouldPatchConnectionAuth(schema, state.dialog.values);
    };
    const originatingEditorStillCurrent = (): boolean =>
      originatingExactEditor
      && recoveryDialogGeneration === dialogGen
      && exactEditorNow();
    const renderRecoveryPresentation = (): void => {
      if (state.dialog.stage !== 'form') {
        render();
        return;
      }
      // Recovery for another row is hidden behind this dialog. Do not rebuild
      // an unrelated form (and steal its cursor) merely to update hidden list
      // state or retain a receipt for the eventual return to the list.
      if (!exactEditorNow()) return;
      renderPreservingActiveField();
      syncSubmitDisabled();
    };
    const pauseExactEditorForHandoff = (): void => {
      if (!exactEditorNow()) return;
      state.dialog.saving = false;
      state.dialog.error = null;
      state.dialog.credentialRotationOwnership = {
        kind: marker.kind,
        name: marker.name,
        phase: 'handoff',
        automaticTakeover: false,
        error: null,
      };
    };
    const showHandoffWaiting = (): void => {
      state.credentialRotationRecovery = {
        kind: marker.kind,
        name: marker.name,
        phase: 'handoff_waiting',
      };
      pauseExactEditorForHandoff();
      renderRecoveryPresentation();
    };
    const showSuccessorHandoff = (): void => {
      credentialRotationSuccessorObservedAttemptId = marker.attemptId;
      opts.credentialRotationContinuity?.markSuccessorObserved(
        marker.attemptId,
      );
      const alreadyHandedOff =
        state.credentialRotationRecovery?.phase === 'handoff'
        && state.credentialRotationRecovery.kind === marker.kind
        && state.credentialRotationRecovery.name === marker.name;
      const exactEditorAlreadyPaused = !exactEditorNow()
        || (
          state.dialog.credentialRotationOwnership?.kind === marker.kind
          && state.dialog.credentialRotationOwnership.name === marker.name
          && state.dialog.credentialRotationOwnership.phase === 'handoff'
        );
      state.credentialRotationRecovery = {
        kind: marker.kind,
        name: marker.name,
        phase: 'handoff',
      };
      pauseExactEditorForHandoff();
      if (!alreadyHandedOff || !exactEditorAlreadyPaused) {
        renderRecoveryPresentation();
      }
      scheduleCredentialRotationPoll();
    };

    if (announceChecking || state.credentialRotationRecovery === null) {
      state.credentialRotationRecovery = {
        kind: marker.kind,
        name: marker.name,
        phase: 'checking',
      };
      renderRecoveryPresentation();
    }

    credentialRotationReconcilePromise = (async () => {
      const runStatus = opts.runCredentialRotationStatus;
      if (runStatus === undefined) {
        if (!disposed) {
          state.credentialRotationRecovery = {
            kind: marker.kind,
            name: marker.name,
            phase: 'unsupported',
          };
          renderRecoveryPresentation();
        }
        return;
      }

      let outcome: ConnectionCredentialRotationOutcome;
      try {
        ({ outcome } = await runStatus({
          attempt_id: marker.attemptId,
          kind: marker.kind,
          name: marker.name,
        }));
      } catch (error) {
        const classified = classifyRpcError(error);
        if (!disposed && markerStillCurrent()) {
          state.credentialRotationRecovery = {
            kind: marker.kind,
            name: marker.name,
            phase: classified.code === 'unknown_method'
              ? 'unsupported'
              : 'waiting',
          };
          if (originatingEditorStillCurrent()) {
            state.dialog.saving = false;
            state.dialog.error = classified.code === 'unknown_method'
              ? `This server cannot recover the interrupted receipt. Probe ${marker.kind}/${marker.name} before deciding whether to retry.`
              : `The replacement outcome is not confirmed yet. Recued will check again after reconnecting; do not retry ${marker.kind}/${marker.name} meanwhile.`;
          }
          renderRecoveryPresentation();
        }
        return;
      }

      if (disposed || !markerStillCurrent()) return;
      if (
        outcome.status === 'failed'
        && typeof outcome.safe_stop_acknowledged_at === 'number'
        && Number.isSafeInteger(outcome.safe_stop_acknowledged_at)
        && outcome.safe_stop_acknowledged_at >= 0
      ) {
        const key = connectionRowKey(marker.kind, marker.name);
        const recoveryBeforeClosure = state.credentialRotationRecovery;
        const sameRecoveryAlreadyPresented =
          recoveryBeforeClosure?.kind === marker.kind
          && recoveryBeforeClosure.name === marker.name
          && recoveryBeforeClosure.phase !== 'checking';
        const exactClosureAlreadyPresented =
          credentialRotationSafeStopClosure?.key === key;
        // The status and cold-list reads start together. If the list (or a tab
        // wake-up) has already presented same-connection state, this exact old
        // receipt cannot clear it merely because its slower response arrived
        // last. Repeat the connection-current activity read first; it either
        // preserves a newer pending/safe stop or authoritatively clears the old
        // presentation. A different connection's queued stop is left intact.
        if (sameRecoveryAlreadyPresented || exactClosureAlreadyPresented) {
          await reconcileCredentialRotationSafeStop(
            marker.kind,
            marker.name,
            true,
          );
          if (disposed || !markerStillCurrent()) return;
        }
        releaseCredentialRotationOwnership(false);
        invalidateCredentialRotationSafeStopCheckFor(
          marker.kind,
          marker.name,
        );
        const recoveryAfterClosure = state.credentialRotationRecovery;
        const sameRecoveryStillActive =
          recoveryAfterClosure?.kind === marker.kind
          && recoveryAfterClosure.name === marker.name
          && recoveryAfterClosure.phase !== 'checking';
        const unrelatedRecoveryIsPresented = recoveryAfterClosure !== null
          && (
            recoveryAfterClosure.kind !== marker.kind
            || recoveryAfterClosure.name !== marker.name
          );
        if (!sameRecoveryStillActive) {
          credentialRotationSuccessorObservedAttemptId = null;
          opts.credentialRotationContinuity?.retire(marker.attemptId);
          opts.credentialRotationTabConvergence
            ?.notifyCredentialRotationSafeStopResolved({
              kind: marker.kind,
              name: marker.name,
            });
        }
        if (!sameRecoveryStillActive && !unrelatedRecoveryIsPresented) {
          state.credentialRotationRecovery = null;
        }
        if (!sameRecoveryStillActive && exactEditorNow()) {
          state.dialog.saving = false;
          state.dialog.error = null;
          state.dialog.credentialCorrection = null;
          state.dialog.credentialRotationOwnership = null;
          if (exactEditorHasRetainedCredentialDraft()) {
            state.dialog.credentialSafeStopClosureNotice = {
              kind: marker.kind,
              name: marker.name,
              nextStep: 'verify_replacement',
            };
            credentialRotationResolvedSafeStopEditor = {
              key: connectionRowKey(marker.kind, marker.name),
              dialogGeneration: dialogGen,
            };
          }
        }
        renderRecoveryPresentation();
        if (state.dialog.credentialSafeStopClosureNotice !== null) {
          focusGuideTarget(SUBMIT_SELECTOR);
        }
        return;
      }
      const recoveredCorrection = outcome.status === 'failed'
        ? validatedConnectionCredentialRejectionCorrection(
            outcome.correction,
            marker.kind,
          )
        : null;
      const recoveredSafeStop = hasCredentialRegenerationSafeStop(
        recoveredCorrection,
      );
      if (recoveredSafeStop) {
        opts.credentialRotationTabConvergence
          ?.notifyCredentialRotationSafeStopped({
            kind: marker.kind,
            name: marker.name,
          });
      }
      if (outcome.status === 'pending') {
        const alreadyPending = state.credentialRotationRecovery?.phase === 'pending'
          && state.credentialRotationRecovery.kind === marker.kind
          && state.credentialRotationRecovery.name === marker.name;
        if (!alreadyPending) {
          state.credentialRotationRecovery = {
            kind: marker.kind,
            name: marker.name,
            phase: 'pending',
          };
          if (originatingEditorStillCurrent()) {
            state.dialog.saving = false;
            state.dialog.error = 'The server is still checking this replacement. Do not retry until its outcome is confirmed.';
          }
          renderRecoveryPresentation();
        }
        // Only a receipt that is actually pending may reclaim the browser
        // lease. A terminal late return must never broadcast itself as owner
        // after a successor has already taken over.
        const convergence = opts.credentialRotationTabConvergence;
        if (
          convergence?.supportsOwnershipLeases === true
          && credentialRotationOwnershipLease?.key
            !== connectionRowKey(marker.kind, marker.name)
        ) {
          const lease = await convergence.claimCredentialRotationOwnership({
            kind: marker.kind,
            name: marker.name,
          });
          if (disposed || !markerStillCurrent()) {
            lease?.release();
            return;
          }
          if (lease !== null) {
            rememberCredentialRotationOwnership(marker.kind, marker.name, lease);
            announceCredentialRotationOwnership(marker.kind, marker.name);
          }
        }
        scheduleCredentialRotationPoll();
        return;
      }

      if (outcome.status === 'succeeded') {
        credentialRotationSuccessorObservedAttemptId = null;
        opts.credentialRotationContinuity?.retire(marker.attemptId);
        opts.credentialRotationTabConvergence?.notifyCredentialRotated({
          kind: marker.kind,
          name: marker.name,
        });
        releaseCredentialRotationOwnership(false);
        const laterExactEditor = exactEditorNow()
          && !originatingEditorStillCurrent();
        if (originatingEditorStillCurrent()) {
          resetDialog();
        } else if (laterExactEditor) {
          state.dialog.credentialRotationOwnership = null;
          state.dialog.credentialCorrection = null;
        }
        state.credentialRotationRecovery = null;
        state.dialog.recentProbe = {
          kind: marker.kind,
          name: marker.name,
          status: outcome.verification.status,
          purpose: 'credential_rotation',
          recovered: true,
          verified_at: outcome.verification.verified_at,
          auth_type: outcome.verification.auth_type,
          ...(outcome.verification.access_expires_at !== undefined
            ? { access_expires_at: outcome.verification.access_expires_at }
            : {}),
        };
        renderRecoveryPresentation();
        if (refreshConnectionList || laterExactEditor) {
          await reconcileCredentialRotationTabs(laterExactEditor
            ? {
                type: 'credential_rotated',
                kind: marker.kind,
                name: marker.name,
              }
            : { type: 'reconcile' });
        }
        return;
      }

      // The former owner's receipt is terminal. Yield any lease it retained,
      // then observe connection-scoped activity: a pending row at this point
      // can only belong to a newer successor attempt.
      releaseCredentialRotationOwnership(true);
      const startedSignalGenerationAtTerminal =
        credentialRotationStartedSignalGeneration;
      const runActivity = opts.runCredentialRotationActivity;
      if (runActivity !== undefined) {
        try {
          const { activity } = await runActivity({
            kind: marker.kind,
            name: marker.name,
          });
          if (disposed || !markerStillCurrent()) return;
          if (activity.status === 'pending') {
            showSuccessorHandoff();
            return;
          }
          const authoritativeSafeStop =
            credentialRotationSafeStopFromActivity(activity, marker.kind);
          if (authoritativeSafeStop.safeStop !== null) {
            presentAuthoritativeCredentialSafeStop(
              marker.kind,
              marker.name,
              authoritativeSafeStop.safeStop,
              false,
            );
            return;
          }
        } catch (error) {
          if (disposed || !markerStillCurrent()) return;
          const classified = classifyRpcError(error);
          if (
            classified.code !== 'unknown_method'
            && classified.code !== 'not_configured'
          ) {
            showHandoffWaiting();
            return;
          }
        }
      }

      // A successor can hold the origin-scoped browser lease briefly before
      // its new server attempt exists. Use a non-waiting claim as an advisory
      // probe in that narrow idle window. A probe win is yielded immediately,
      // never remembered, and never announced as recovered ownership.
      const convergence = opts.credentialRotationTabConvergence;
      if (convergence?.supportsOwnershipLeases === true) {
        let probeLease: CredentialRotationOwnershipLease | null;
        try {
          probeLease = await convergence.claimCredentialRotationOwnership({
            kind: marker.kind,
            name: marker.name,
          });
        } catch {
          if (!disposed && markerStillCurrent()) showHandoffWaiting();
          return;
        }
        if (disposed || !markerStillCurrent()) {
          probeLease?.release();
          return;
        }
        if (probeLease === null) {
          showSuccessorHandoff();
          return;
        }
        probeLease.release();
      }

      // The successor is idle. Take one causally-later, secret-free snapshot
      // before presenting the old failure. The baseline revision proves
      // whether another tab committed or removed the connection in between.
      const listGeneration = loadGeneration;
      let connections: ReadonlyArray<ConnectionView>;
      try {
        ({ connections } = await opts.runList());
      } catch {
        if (!disposed && markerStillCurrent()) showHandoffWaiting();
        return;
      }
      if (disposed || !markerStillCurrent()) return;
      if (listGeneration !== loadGeneration) {
        // A newer focus/sibling/reload read overtook this snapshot. Do not use
        // the older response to retire the only recovery pointer or label the
        // successor outcome; the next explicit/reconnect check can reconcile
        // against a causally-later row.
        showHandoffWaiting();
        return;
      }
      loadGeneration += 1;
      state.connections = [...connections];
      state.loading = false;
      state.error = null;
      if (
        credentialRotationStartedSignalGeneration
          !== startedSignalGenerationAtTerminal
      ) {
        // A sibling can claim immediately after this tab's advisory lease
        // probe and before the list response lands. Its start signal is newer
        // than this snapshot, so retain the marker and return to handoff.
        showSuccessorHandoff();
        return;
      }
      const latest = connections.find((connection) =>
        connection.kind === marker.kind && connection.name === marker.name);
      const latestRevision = latest?.updated_at;
      const exactEditorRevisionChanged = exactEditorNow()
        && editorRevision !== null
        && editorRevision.key === connectionRowKey(marker.kind, marker.name)
        && latest !== undefined
        && connectionRevisionChanged(editorRevision, latest);
      const missingRevision = latest !== undefined
        && marker.baselineUpdatedAt !== undefined
        && latestRevision === undefined;
      const changedAfterAttempt = latest === undefined
        || (
          marker.baselineUpdatedAt !== undefined
            ? latestRevision !== undefined
              && latestRevision !== marker.baselineUpdatedAt
            : outcome.status === 'failed'
              && latestRevision !== undefined
              && latestRevision > outcome.started_at
        )
        || exactEditorRevisionChanged;
      if (missingRevision) {
        showHandoffWaiting();
        return;
      }

      if (!recoveredSafeStop || changedAfterAttempt) {
        opts.credentialRotationContinuity?.retire(marker.attemptId);
      }
      if (changedAfterAttempt) {
        credentialRotationSuccessorObservedAttemptId = null;
        state.credentialRotationRecovery = {
          kind: marker.kind,
          name: marker.name,
          phase: 'superseded',
        };
        if (exactEditorNow()) {
          state.dialog.saving = false;
          state.dialog.error = null;
          state.dialog.credentialCorrection = null;
          state.dialog.credentialRotationOwnership = null;
          state.dialog.externalChange = {
            kind: marker.kind,
            name: marker.name,
            phase: latest === undefined ? 'removed' : 'changed',
            reloading: false,
            error: null,
          };
        }
        renderRecoveryPresentation();
        return;
      }

      if (exactEditorNow()) {
        state.dialog.credentialRotationOwnership = null;
      }
      const exactEditorRevisionProvesUnchanged = exactEditorNow()
        && editorRevision !== null
        && editorRevision.key === connectionRowKey(marker.kind, marker.name)
        && editorRevision.updatedAt !== undefined
        && latestRevision !== undefined
        && editorRevision.updatedAt === latestRevision;
      const attemptRevisionProvesUnchanged = marker.baselineUpdatedAt !== undefined
        ? latestRevision === marker.baselineUpdatedAt
        : outcome.status === 'failed'
          && latestRevision !== undefined
          && latestRevision <= outcome.started_at;
      const retainedCredentialDraft = exactEditorHasRetainedCredentialDraft();
      const successorWasObserved =
        credentialRotationSuccessorObservedAttemptId === marker.attemptId;
      const canResumeRetainedDraft = retainedCredentialDraft
        && successorWasObserved
        && exactEditorRevisionProvesUnchanged
        && attemptRevisionProvesUnchanged
        && !(outcome.status === 'failed' && outcome.reason === 'conflict');
      if (canResumeRetainedDraft) {
        credentialRotationSuccessorObservedAttemptId = null;
        state.credentialRotationRecovery = {
          kind: marker.kind,
          name: marker.name,
          phase: 'resumable',
          ...(outcome.status === 'failed'
            ? { failureReason: outcome.reason }
            : {}),
          ...(recoveredCorrection !== null
            ? { correction: recoveredCorrection }
            : {}),
        };
        state.dialog.saving = false;
        state.dialog.error = null;
        const hasCorrection = outcome.status === 'failed'
          && setDialogCredentialCorrection(
            recoveredCorrection ?? undefined,
            rotationFailureCopy(outcome.reason),
          );
        renderRecoveryPresentation();
        if (hasCorrection) focusCredentialCorrection();
        return;
      }
      const canStartFresh = !retainedCredentialDraft
        && successorWasObserved
        && latestRevision !== undefined
        && attemptRevisionProvesUnchanged
        && (!exactEditorNow() || state.dialog.externalChange === null)
        && !(outcome.status === 'failed' && outcome.reason === 'conflict');
      if (canStartFresh) {
        credentialRotationSuccessorObservedAttemptId = null;
        state.credentialRotationRecovery = {
          kind: marker.kind,
          name: marker.name,
          phase: 'restart_ready',
          baselineUpdatedAt: latestRevision,
          ...(outcome.status === 'failed'
            ? { failureReason: outcome.reason }
            : {}),
          ...(recoveredCorrection !== null
            ? { correction: recoveredCorrection }
            : {}),
        };
        if (exactEditorNow()) {
          state.dialog.saving = false;
          state.dialog.error = null;
        }
        renderRecoveryPresentation();
        return;
      }
      credentialRotationSuccessorObservedAttemptId = null;
      if (outcome.status === 'not_found') {
        state.credentialRotationRecovery = {
          kind: marker.kind,
          name: marker.name,
          phase: 'not_received',
        };
        if (originatingEditorStillCurrent()) {
          state.dialog.saving = false;
          state.dialog.credentialCorrection = null;
          state.dialog.error = 'Your server has no receipt for this swap. It was not used on any Connection you have set up with this name. Look at the Connection before you try again.';
        }
      } else {
        state.credentialRotationRecovery = {
          kind: marker.kind,
          name: marker.name,
          phase: 'failed',
          failureReason: outcome.reason,
          ...(recoveredCorrection !== null
            ? { correction: recoveredCorrection }
            : {}),
        };
        if (originatingEditorStillCurrent()) {
          state.dialog.saving = false;
          if (outcome.reason === 'conflict') {
            state.dialog.error = null;
            state.dialog.credentialCorrection = null;
            state.dialog.externalChange = {
              kind: marker.kind,
              name: marker.name,
              phase: 'changed',
              reloading: false,
              error: null,
            };
          } else {
            const message = rotationFailureCopy(outcome.reason);
            if (!setDialogCredentialCorrection(
              recoveredCorrection ?? undefined,
              message,
            )) {
              state.dialog.error = message;
            } else {
              state.dialog.error = null;
            }
          }
        }
      }
      renderRecoveryPresentation();
      if (
        outcome.status === 'failed'
        && recoveredCorrection !== null
        && originatingEditorStillCurrent()
        && state.dialog.credentialCorrection !== null
      ) focusCredentialCorrection();
    })().finally(() => {
      credentialRotationReconcilePromise = null;
    });
    return credentialRotationReconcilePromise;
  };

  const activeSchema = (): ConnectionSchema | undefined =>
    state.dialog.kind === null
      ? undefined
      : resolveConnectionSchema(
          state.dialog.kind,
          state.dialog.subtype ?? undefined,
          state.dialog.vendor ?? undefined,
        );

  const setDialogCredentialCorrection = (
    correction: ConnectionCredentialRejectionCorrection | undefined,
    message: string,
  ): boolean => {
    const schema = activeSchema();
    if (schema === undefined || correction === undefined) {
      state.dialog.credentialCorrection = null;
      return false;
    }
    const next = connectionCredentialCorrectionState(
      correction,
      schema,
      state.dialog.values,
      message,
    );
    if (next !== null && hasCredentialRegenerationSafeStop(correction)) {
      const kind = state.dialog.kind;
      const name = state.dialog.values.name ?? '';
      const key = kind === null ? null : connectionRowKey(kind, name);
      const hasExactToken = key !== null
        && credentialRotationSafeStopClosure?.key === key;
      if (
        hasExactToken
        && opts.runAcknowledgeCredentialRotationSafeStop !== undefined
      ) {
        next.safeStopClosure = { phase: 'ready', error: null };
      } else if (
        opts.runCredentialRotationActivity === undefined
        || hasExactToken
      ) {
        next.safeStopClosure = {
          phase: 'unsupported',
          error: hasExactToken
            ? 'This browser cannot tell your server that it stopped safely. Update it, or type a properly different key before you check again.'
            : 'Your server cannot say yet that it stopped safely. Update it, or type a properly different key before you check again.',
        };
      } else {
        next.safeStopClosure = { phase: 'checking', error: null };
      }
    }
    state.dialog.credentialCorrection = next;
    return next !== null;
  };

  const setDialogCredentialSafeStopClosure = (
    phase: NonNullable<
      ConnectionsDialogCredentialCorrectionState['safeStopClosure']
    >['phase'],
    error: string | null,
  ): boolean => {
    const correction = state.dialog.credentialCorrection;
    if (!hasCredentialRegenerationSafeStop(correction)) return false;
    correction!.safeStopClosure = { phase, error };
    return true;
  };

  const applyCredentialSafeStopClosureCapability = (
    kind: ConnectionKind,
    name: string,
    acknowledgementToken: string | null,
  ): void => {
    const key = connectionRowKey(kind, name);
    if (
      credentialRotationSafeStopClosure?.key !== key
      || credentialRotationSafeStopClosure.acknowledgementToken
        !== acknowledgementToken
    ) credentialRotationSafeStopAcknowledgementGeneration += 1;
    credentialRotationSafeStopClosure = acknowledgementToken === null
      ? null
      : { key, acknowledgementToken };
    if (!exactOpenEditor(kind, name)) return;
    if (
      acknowledgementToken !== null
      && opts.runAcknowledgeCredentialRotationSafeStop !== undefined
    ) {
      setDialogCredentialSafeStopClosure('ready', null);
      return;
    }
    setDialogCredentialSafeStopClosure(
      'unsupported',
      acknowledgementToken === null
        ? 'Your server can show this safe stop, but cannot write down that it is finished. Update it, or type a properly different key before you check again.'
        : 'This browser cannot tell your server that it stopped safely. Update it, or type a properly different key before you check again.',
    );
  };

  /** Retire only the safe-stop receipt for this exact open editor. The marker
   * contains no secret, but keeping it until the owner edits a routed field or
   * explicitly confirms a provider-side fix is what makes the handoff durable
   * across route changes and reloads without permitting an unchanged retry. */
  const retireCredentialRegenerationSafeStop = (
    correction = state.dialog.credentialCorrection,
  ): boolean => {
    if (
      !hasCredentialRegenerationSafeStop(correction)
      || state.dialog.kind === null
      || state.dialog.mode !== 'edit'
    ) return false;
    const name = state.dialog.values.name ?? '';
    const key = connectionRowKey(state.dialog.kind, name);
    if (state.dialog.editingId !== key) return false;
    const marker = opts.credentialRotationContinuity?.read() ?? null;
    if (
      marker !== null
      && marker.kind === state.dialog.kind
      && marker.name === name
    ) opts.credentialRotationContinuity?.retire(marker.attemptId);
    const recovery = state.credentialRotationRecovery;
    if (
      recovery?.kind === state.dialog.kind
      && recovery.name === name
      && hasCredentialRegenerationSafeStop(recovery.correction)
    ) state.credentialRotationRecovery = null;
    invalidateCredentialRotationSafeStopCheckFor(
      state.dialog.kind,
      name,
    );
    if (credentialRotationSafeStopClosure?.key === key) {
      invalidateCredentialSafeStopAcknowledgement();
    }
    state.dialog.credentialSafeStopClosureNotice = null;
    credentialRotationResolvedSafeStopEditor = {
      key,
      dialogGeneration: dialogGen,
    };
    return true;
  };

  /** Only tabs carrying a complete, memory-only replacement may compete for
   * an automatic successor lease. A metadata-only or half-filled editor still
   * observes the owner's outcome, but cannot starve a sibling that can
   * actually continue the credential rotation. */
  const hasActionableCredentialRotationDraft = (): boolean => {
    const schema = activeSchema();
    return state.dialog.mode === 'edit'
      && schema !== undefined
      && shouldPatchConnectionAuth(schema, state.dialog.values)
      && validateConnectionForm(
        schema,
        state.dialog.values,
        state.dynamicOptions,
        state.dialog.mode,
      ) === null;
  };

  /** Non-secret renderer projection used to decide when a text edit actually
   *  changes the OAuth checklist/CTA. Most keystrokes stay on the imperative
   *  no-render path; missing→present, invalid→valid, scope-count, and token
   *  presence transitions rebuild once so the visible readiness cannot lag. */
  const oauthCredentialProjectionKey = (values: ConnectionFormValues): string =>
    JSON.stringify({
      readiness: connectionOAuthCredentialReadiness({
        vendor: state.dialog.vendor,
        kind: state.dialog.kind,
        values,
      }),
      hasRefreshToken: (values['auth.refresh_token'] ?? '').trim().length > 0,
    });

  /** Guide transitions replace their trigger's DOM node. Restore focus to the
   *  next useful control (or the status panel) so keyboard and screen-reader
   *  users do not fall back to the document body after each render. */
  const focusGuideTarget = (selector: string): void => {
    if (typeof host.querySelector !== 'function') return;
    const target = host.querySelector(selector) as (HTMLElement & {
      focus?: () => void;
    }) | null;
    target?.focus?.();
  };

  const currentConnectionFormValidationIssue = ():
    ConnectionFormValidationIssue | null | undefined => {
    const schema = activeSchema();
    if (schema === undefined) return undefined;
    return connectionFormValidationIssue(
      schema,
      state.dialog.values,
      state.dynamicOptions,
      state.dialog.mode,
    );
  };

  /** Resolve the issue again at activation time rather than trusting the
   * rendered button's dataset: silent edits can advance the first problem
   * without replacing that DOM node. Repeatable controls receive exact dotted
   * keys; group-level problems land on the labelled field wrapper. */
  const focusFirstConnectionFormIssue = (): void => {
    if (typeof host.querySelector !== 'function') return;
    const issue = currentConnectionFormValidationIssue();
    if (issue === undefined) return;
    if (issue === null) {
      focusGuideTarget(SUBMIT_SELECTOR);
      return;
    }
    type FocusTarget = HTMLElement & { disabled?: boolean; focus?: () => void };
    const direct = host.querySelector(
      `[data-conn-field="${issue.fieldKey}"]`,
    ) as FocusTarget | null;
    const directDisabled = direct?.disabled === true
      || direct?.hasAttribute?.('disabled') === true
      || direct?.getAttribute?.('aria-disabled') === 'true';
    const group = host.querySelector(
      `[data-field-key="${issue.fieldKey}"]`,
    ) as FocusTarget | null;
    const panel = host.querySelector(
      FORM_VALIDATION_PANEL_SELECTOR,
    ) as FocusTarget | null;
    const target = direct !== null && !directDisabled
      ? direct
      : group ?? panel;
    if (target === null) return;
    if (target !== direct) target.setAttribute('tabindex', '-1');
    target.focus?.();
  };

  /** Re-resolve the authoritative target from state at activation time. A
   * forged `data-field-key` cannot redirect focus, and a repeatable credential
   * (headers) falls back to its labelled group when no single base control
   * exists. */
  const focusCredentialCorrection = (): void => {
    if (typeof host.querySelector !== 'function') return;
    const fieldKey = state.dialog.credentialCorrection?.fieldKeys[0];
    if (fieldKey === undefined) return;
    type FocusTarget = HTMLElement & { disabled?: boolean; focus?: () => void };
    const direct = fieldKey === 'auth.headers'
      ? null
      : host.querySelector(
          `[data-conn-field="${fieldKey}"]`,
        ) as FocusTarget | null;
    const directDisabled = direct?.disabled === true
      || direct?.hasAttribute?.('disabled') === true
      || direct?.getAttribute?.('aria-disabled') === 'true';
    const group = host.querySelector(
      `.connections-field-row[data-field-key="${fieldKey}"]`,
    ) as FocusTarget | null;
    const panel = host.querySelector(
      CREDENTIAL_CORRECTION_PANEL_SELECTOR,
    ) as FocusTarget | null;
    const target = direct !== null && !directDisabled
      ? direct
      : group ?? panel;
    if (target === null) return;
    if (target !== direct) target.setAttribute('tabindex', '-1');
    target.focus?.();
  };

  /** Like the correction focus route, resolve the server-authoritative endpoint
   * target from live state rather than trusting the clicked data attribute. */
  const focusCredentialTriage = (): void => {
    if (typeof host.querySelector !== 'function') return;
    const fieldKey = state.dialog.credentialCorrection?.triage
      ?.endpointFieldKeys[0];
    if (fieldKey === undefined) return;
    type FocusTarget = HTMLElement & { disabled?: boolean; focus?: () => void };
    const direct = host.querySelector(
      `[data-conn-field="${fieldKey}"]`,
    ) as FocusTarget | null;
    const disabled = direct?.disabled === true
      || direct?.hasAttribute?.('disabled') === true
      || direct?.getAttribute?.('aria-disabled') === 'true';
    const panel = host.querySelector(
      CREDENTIAL_CORRECTION_PANEL_SELECTOR,
    ) as FocusTarget | null;
    const target = direct !== null && !disabled ? direct : panel;
    if (target === null) return;
    if (target !== direct) target.setAttribute('tabindex', '-1');
    target.focus?.();
  };

  /** A provider-side repair may make the same locally held credential usable
   * without changing its text. Record that exact safe-stop closure on the
   * paired server, then require a fresh activity read before unlocking one
   * separate verification click. */
  const confirmCredentialHandoffResolved = async (): Promise<void> => {
    const schema = activeSchema();
    if (
      state.dialog.saving
      || schema === undefined
      || !hasCredentialRegenerationSafeStop(
        state.dialog.credentialCorrection,
      )
    ) return;
    const kind = state.dialog.kind;
    const name = state.dialog.values.name ?? '';
    if (
      kind === null
      || state.dialog.mode !== 'edit'
      || state.dialog.editingId !== connectionRowKey(kind, name)
    ) return;
    const closureState = state.dialog.credentialCorrection?.safeStopClosure;
    if (
      closureState?.phase !== 'ready'
      && closureState?.phase !== 'unconfirmed'
    ) return;
    const key = connectionRowKey(kind, name);
    const closure = credentialRotationSafeStopClosure;
    const runAcknowledge = opts.runAcknowledgeCredentialRotationSafeStop;
    if (
      closure?.key !== key
      || runAcknowledge === undefined
    ) {
      setDialogCredentialSafeStopClosure(
        'unsupported',
        'Neither this browser nor your server can write down that it stopped safely. Update them, or type a properly different key before you check again.',
      );
      renderPreservingActiveField();
      return;
    }

    const correctionAtStart = state.dialog.credentialCorrection;
    const hadCredentialDraftAtStart = shouldPatchConnectionAuth(
      schema,
      state.dialog.values,
    );
    const dialogGenerationAtStart = dialogGen;
    const acknowledgementGeneration =
      ++credentialRotationSafeStopAcknowledgementGeneration;
    const actionStillCurrent = (): boolean => !disposed
      && dialogGen === dialogGenerationAtStart
      && state.dialog.credentialCorrection === correctionAtStart
      && credentialRotationSafeStopAcknowledgementGeneration
        === acknowledgementGeneration
      && credentialRotationSafeStopClosure?.key === key;
    setDialogCredentialSafeStopClosure('acknowledging', null);
    state.dialog.error = null;
    renderPreservingActiveField();
    syncSubmitDisabled();

    let serverRecordedClosure = false;
    let serverReportedSuperseded = false;
    try {
      const { acknowledgement } = await runAcknowledge({
        kind,
        name,
        acknowledgement_token: closure.acknowledgementToken,
      });
      if (!actionStillCurrent()) return;
      serverRecordedClosure = acknowledgement.status === 'acknowledged'
        || acknowledgement.status === 'already_acknowledged';
      serverReportedSuperseded = acknowledgement.status === 'superseded';
      if (serverRecordedClosure) {
        opts.credentialRotationTabConvergence
          ?.notifyCredentialRotationSafeStopResolved({ kind, name });
      }
    } catch (error) {
      if (!actionStillCurrent()) return;
      const classified = classifyRpcError(error);
      if (
        classified.code === 'unknown_method'
        || classified.code === 'not_configured'
      ) {
        setDialogCredentialSafeStopClosure(
          'unsupported',
          'Your server cannot write down yet that it stopped safely. Update it, or type a properly different key before you check again.',
        );
        renderPreservingActiveField();
        syncSubmitDisabled();
        return;
      }
      // The write may have committed before its reply was lost. The same
      // server-authoritative activity read below safely distinguishes that
      // outcome from an unchanged or superseded stop.
    }

    await reconcileCredentialRotationSafeStop(kind, name, true);
    if (disposed || dialogGen !== dialogGenerationAtStart) return;
    const recovery = state.credentialRotationRecovery;
    const exactEditor = exactOpenEditor(kind, name);
    const stopCleared = exactEditor
      && state.dialog.credentialCorrection === null
      && !(
        recovery?.kind === kind
        && recovery.name === name
        && (
          recovery.phase === 'handoff'
          || recovery.phase === 'pending'
          || recovery.phase === 'handoff_waiting'
        )
      );
    if (stopCleared) {
      const continuityMarker = opts.credentialRotationContinuity?.read() ?? null;
      if (
        continuityMarker?.kind === kind
        && continuityMarker.name === name
      ) {
        opts.credentialRotationContinuity?.retire(
          continuityMarker.attemptId,
        );
      }
      if (serverReportedSuperseded) {
        // The token belonged to an older causal row. Reuse the exact-change
        // preflight so this tab reads the current connection revision and
        // cannot present a stale editor as an acknowledged closure.
        await reconcileCredentialRotationTabs({
          type: 'credential_rotated',
          kind,
          name,
        });
        return;
      }
      if (!serverRecordedClosure) {
        opts.credentialRotationTabConvergence
          ?.notifyCredentialRotationSafeStopResolved({ kind, name });
      }
      state.dialog.credentialSafeStopClosureNotice = {
        kind,
        name,
        nextStep: hadCredentialDraftAtStart
          ? 'verify_replacement'
          : 'check_saved_connection',
      };
      credentialRotationResolvedSafeStopEditor = {
        key,
        dialogGeneration: dialogGen,
      };
      renderPreservingActiveField();
      syncSubmitDisabled();
      focusGuideTarget(
        hadCredentialDraftAtStart
          ? SUBMIT_SELECTOR
          : SAFE_STOP_CHECK_SAVED_SELECTOR,
      );
      return;
    }
    const correctionAfterVerification = state.dialog.credentialCorrection;
    if (
      exactEditor
      && correctionAfterVerification === correctionAtStart
      && correctionAfterVerification?.safeStopClosure?.phase
        === 'acknowledging'
    ) {
      setDialogCredentialSafeStopClosure(
        'unconfirmed',
        'Recued could not confirm that your server wrote this fix down. Reconnect and check before you try again. Your new key stays only in this tab.',
      );
      renderPreservingActiveField();
      syncSubmitDisabled();
    }
  };

  /** Start fresh replaces the activating button with an edit form. Land on
   * the first visible credential control so keyboard and screen-reader users
   * do not fall back to the document body after that DOM replacement. */
  const focusCredentialReplacementStart = (): void => {
    const schema = activeSchema();
    if (schema === undefined) return;
    const values = state.dialog.values;
    const field = schema.fields.find((candidate) =>
      candidate.key.startsWith('auth.')
      && candidate.key !== 'auth.type'
      && !candidate.hidden
      && !candidate.readonly
      && (candidate.showWhen?.(values) ?? true))
      ?? schema.fields.find((candidate) =>
        candidate.key === 'auth.type'
        && !candidate.hidden
        && !candidate.readonly);
    if (field === undefined) return;
    const fieldKey = field.type === 'header-list'
      ? `${field.key}.0.header_name`
      : field.key;
    focusGuideTarget(`[data-conn-field="${fieldKey}"]`);
  };

  /** An async completion may restore the guide panel only when the owner left
   *  focus inside the loading guide. If they continued filling another form
   *  field while AI worked, the result's live region announces itself without
   *  stealing their cursor mid-entry. */
  const guideOwnsActiveFocus = (): boolean => {
    const active = host.ownerDocument?.activeElement;
    if (active === null || active === undefined || typeof host.querySelector !== 'function') {
      return false;
    }
    const panel = host.querySelector(GUIDE_PANEL_SELECTOR);
    return panel !== null
      && typeof panel.contains === 'function'
      && panel.contains(active);
  };

  const openSetupGuide = (): void => {
    if (activeSchema()?.kind !== 'api' || state.dialog.saving) return;
    retireProviderSetupContinuity();
    const current = state.dialog.setupGuide;
    state.dialog.setupGuide = {
      ...initialConnectionsSetupGuideState(),
      stage: 'entry',
      targetUrl: current.targetUrl,
    };
    render();
    focusGuideTarget(GUIDE_URL_SELECTOR);
  };

  const closeSetupGuide = (): void => {
    retireProviderSetupContinuity();
    guideGeneration += 1;
    // Closing hides the AI result and invalidates any late completion, but the
    // non-secret provider URL stays with this connection dialog so reopening
    // does not make the owner type it again. Dialog navigation/reset still
    // clears the entire guide state.
    const targetUrl = state.dialog.setupGuide.targetUrl;
    state.dialog.setupGuide = {
      ...initialConnectionsSetupGuideState(),
      targetUrl,
    };
    render();
    focusGuideTarget(GUIDE_OPEN_SELECTOR);
  };

  const reviewSetupGuide = (): void => {
    const schema = activeSchema();
    if (schema === undefined || schema.kind !== 'api') return;
    const built = buildConnectionSetupGuidePreview(
      schema,
      state.dialog.values,
      state.dialog.setupGuide.targetUrl,
    );
    if (!built.ok) {
      state.dialog.setupGuide.error = built.error;
      state.dialog.setupGuide.stage = 'entry';
      render();
      focusGuideTarget(GUIDE_URL_SELECTOR);
      return;
    }
    retireProviderSetupContinuity();
    guideGeneration += 1;
    state.dialog.setupGuide = {
      stage: 'preview',
      targetUrl: built.preview.target_url,
      preview: built.preview,
      result: null,
      error: null,
      resumeAvailable: false,
      resumeFieldKey: null,
    };
    render();
    focusGuideTarget(GUIDE_GENERATE_SELECTOR);
  };

  const editSetupGuide = (): void => {
    retireProviderSetupContinuity();
    guideGeneration += 1;
    const targetUrl = state.dialog.setupGuide.targetUrl;
    state.dialog.setupGuide = {
      ...initialConnectionsSetupGuideState(),
      stage: 'entry',
      targetUrl,
    };
    render();
    focusGuideTarget(GUIDE_URL_SELECTOR);
  };

  const generateSetupGuide = async (): Promise<void> => {
    if (guideInFlight) {
      // Closing a guide deliberately hides its eventual result, but it does not
      // cancel the paid model call. If the owner reopens before that call
      // settles, make the lock visible instead of turning Generate into a
      // mysterious no-op.
      if (state.dialog.setupGuide.stage !== 'loading') {
        state.dialog.setupGuide.stage = state.dialog.setupGuide.preview === null
          ? 'entry'
          : 'error';
        state.dialog.setupGuide.error =
          'Your previous setup-guide request is still finishing. Wait a moment, then try again.';
        render();
        focusGuideTarget(GUIDE_PANEL_SELECTOR);
      }
      return;
    }
    const preview = state.dialog.setupGuide.preview;
    if (preview === null) {
      state.dialog.setupGuide.stage = 'entry';
      state.dialog.setupGuide.error = 'Review the setup context before asking your AI.';
      render();
      focusGuideTarget(GUIDE_URL_SELECTOR);
      return;
    }
    if (opts.runSuggestSetup === undefined) {
      state.dialog.setupGuide.stage = 'error';
      state.dialog.setupGuide.error =
        'Setup guidance is not available in this view yet. You can still complete the form manually.';
      render();
      focusGuideTarget(GUIDE_PANEL_SELECTOR);
      return;
    }
    const request: ConnectionSetupGuideRequest = {
      target_url: preview.target_url,
      auth_type: preview.auth_type,
      field_keys: [...preview.field_keys],
    };
    const generation = ++guideGeneration;
    const owningDialog = dialogGen;
    guideInFlight = true;
    state.dialog.setupGuide.stage = 'loading';
    state.dialog.setupGuide.result = null;
    state.dialog.setupGuide.error = null;
    render();
    focusGuideTarget(GUIDE_PANEL_SELECTOR);
    try {
      const result = await opts.runSuggestSetup(request);
      if (
        disposed
        || generation !== guideGeneration
        || owningDialog !== dialogGen
      ) return;
      const restoreGuideFocus = guideOwnsActiveFocus();
      if (!connectionSetupGuideContextsMatch(request, result.shared_context)) {
        state.dialog.setupGuide.stage = 'error';
        state.dialog.setupGuide.error =
          'The guide did not match the context you reviewed, so Recued did not show it. Try again.';
        render();
        if (restoreGuideFocus) focusGuideTarget(GUIDE_PANEL_SELECTOR);
        return;
      }
      state.dialog.setupGuide.stage = 'ready';
      state.dialog.setupGuide.result = result;
      state.dialog.setupGuide.error = null;
      state.dialog.setupGuide.resumeAvailable = false;
      state.dialog.setupGuide.resumeFieldKey = null;
      if (state.dialog.mode === 'create') {
        const configuredVendor = (state.dialog.values['config.vendor'] ?? '').trim();
        const schemaVendor = state.dialog.vendor
          ?? (CONNECTION_NAME_REGEX.test(configuredVendor) ? configuredVendor : null);
        const schemaKind = state.dialog.vendor !== null
          ? 'registered_vendor'
          : schemaVendor === null
            ? 'bare_api'
            : 'pack_vendor';
        const schema = activeSchema();
        const returnTarget = schema === undefined
          ? null
          : connectionSetupGuideReturnTarget(schema, state.dialog.values);
        const resumeFieldKey = returnTarget?.kind === 'field'
          && result.shared_context.field_keys.includes(returnTarget.fieldKey)
          ? returnTarget.fieldKey
          : null;
        opts.providerSetupContinuity?.write({
          schemaKind,
          schemaVendor,
          resumeFieldKey,
          result,
        });
      }
      render();
      if (restoreGuideFocus) focusGuideTarget(GUIDE_PANEL_SELECTOR);
    } catch (err) {
      if (
        disposed
        || generation !== guideGeneration
        || owningDialog !== dialogGen
      ) return;
      const restoreGuideFocus = guideOwnsActiveFocus();
      state.dialog.setupGuide.stage = 'error';
      state.dialog.setupGuide.error = errMessage(err);
      render();
      if (restoreGuideFocus) focusGuideTarget(GUIDE_PANEL_SELECTOR);
    } finally {
      guideInFlight = false;
    }
  };

  const reviewSetupGuideAgain = (): void => {
    if (state.dialog.setupGuide.preview === null) {
      editSetupGuide();
      return;
    }
    retireProviderSetupContinuity();
    guideGeneration += 1;
    state.dialog.setupGuide.stage = 'preview';
    state.dialog.setupGuide.result = null;
    state.dialog.setupGuide.error = null;
    render();
    focusGuideTarget(GUIDE_GENERATE_SELECTOR);
  };

  /** Best-effort copy for the callback URI the OAuth start RPC actually uses.
   *  The value stays visibly selectable in the handoff card when clipboard
   *  access is unavailable, denied, or throws synchronously. */
  const copySetupGuideCallback = (element: HTMLElement): void => {
    element.setAttribute('aria-live', 'polite');
    element.setAttribute('aria-atomic', 'true');
    const feedback = (visible: string, accessible: string): void => {
      element.textContent = visible;
      element.setAttribute('aria-label', accessible);
    };
    const copy = opts.copyText
      ?? (doc.defaultView?.navigator.clipboard?.writeText === undefined
        ? undefined
        : (value: string) => doc.defaultView!.navigator.clipboard.writeText(value));
    if (copy === undefined) {
      feedback('Copy manually', 'Recued could not copy it. Select the address to come back to and copy it yourself.');
      return;
    }
    try {
      /** ⛔ The SAME resolved value the form displays and the flow sends. This
       *  copied the cloud constant unconditionally, so on a loopback webclient
       *  the owner pasted a URL the flow never uses — and copy is what people
       *  actually paste. */
      void copy(resolveOAuthCallbackUrlForThisPwa())
        .then(() => {
          if (!disposed) feedback('Copied', 'Callback URL copied.');
        })
        .catch(() => {
          if (!disposed) {
            feedback('Copy manually', 'Copy failed. Select and copy the callback URL manually.');
          }
        });
    } catch {
      feedback('Copy manually', 'Copy failed. Select and copy the callback URL manually.');
    }
  };

  /** Copy the exact scope string the authorize request will carry.
   *
   *  ⛔ REBUILT FROM THE LIVE FIELD, never read back from the DOM — the owner may have
   *  edited the Scopes input since the last render, and copying stale text would hand
   *  them a permission list to register that does not match what Recued then asks for.
   *  That mismatch fails at the provider AFTER an app has been configured, which is the
   *  expensive place to discover it. Same reasoning as the callback-URL copy above,
   *  which shipped the cloud constant while the flow used a loopback URL. */
  const copyRequestedScopes = (element: HTMLElement): void => {
    element.setAttribute('aria-live', 'polite');
    element.setAttribute('aria-atomic', 'true');
    const feedback = (visible: string, accessible: string): void => {
      element.textContent = visible;
      element.setAttribute('aria-label', accessible);
    };
    const scopes = (state.dialog?.values['auth.scopes'] ?? '')
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .join(' ');
    if (scopes === '') {
      feedback('Nothing to copy', 'No scopes are set on this connection yet.');
      return;
    }
    const copy = opts.copyText
      ?? (doc.defaultView?.navigator.clipboard?.writeText === undefined
        ? undefined
        : (value: string) => doc.defaultView!.navigator.clipboard.writeText(value));
    if (copy === undefined) {
      feedback('Copy manually', 'Recued could not copy it. Select what it may do and copy it yourself.');
      return;
    }
    try {
      void copy(scopes)
        .then(() => {
          if (!disposed) feedback('Copied', 'Requested scopes copied.');
        })
        .catch(() => {
          if (!disposed) {
            feedback('Copy manually', 'Copy failed. Select and copy the scopes manually.');
          }
        });
    } catch {
      feedback('Copy manually', 'Copy failed. Select and copy the scopes manually.');
    }
  };

  /** Copy only the pure, allowlisted handoff projection rendered beside the
   * safe stop. Rebuild it from live state instead of trusting DOM text or a
   * clicked data attribute, then leave the visible summary selectable when
   * clipboard access is missing or denied. */
  const copyCredentialAdminHandoff = (element: HTMLElement): void => {
    const schema = activeSchema();
    const summary = schema === undefined
      ? null
      : connectionCredentialRegenerationAdminHandoff(state.dialog, schema);
    if (summary === null) return;
    const owningDialog = dialogGen;
    const status = typeof host.querySelector === 'function'
      ? host.querySelector(
          CREDENTIAL_ADMIN_HANDOFF_STATUS_SELECTOR,
        ) as HTMLElement | null
      : null;
    const summaryElement = typeof host.querySelector === 'function'
      ? host.querySelector(
          CREDENTIAL_ADMIN_HANDOFF_SUMMARY_SELECTOR,
        ) as HTMLElement | null
      : null;
    const feedback = (label: string, message: string, focusSummary = false): void => {
      if (disposed || owningDialog !== dialogGen) return;
      element.removeAttribute('disabled');
      element.textContent = label;
      if (status !== null) status.textContent = message;
      if (focusSummary) summaryElement?.focus?.();
    };
    const copy = opts.copyText
      ?? (doc.defaultView?.navigator.clipboard?.writeText === undefined
        ? undefined
        : (value: string) => doc.defaultView!.navigator.clipboard.writeText(value));
    if (copy === undefined) {
      feedback(
        'Copy manually',
        'Recued could not copy it. The safe hand-over is selected, so you can copy it yourself.',
        true,
      );
      return;
    }
    element.setAttribute('disabled', '');
    element.textContent = 'Copying…';
    if (status !== null) status.textContent = 'Copying the hand-over you looked at…';
    try {
      void copy(summary)
        .then(() => feedback(
          'Copied',
          'Safe hand-over copied. Recued sent nothing by itself.',
        ))
        .catch(() => feedback(
          'Copy manually',
          'Copying did not work. The safe hand-over is selected, so you can copy it yourself.',
          true,
        ));
    } catch {
      feedback(
        'Copy manually',
        'Copying did not work. The safe hand-over is selected, so you can copy it yourself.',
        true,
      );
    }
  };

  /** Move one reviewed, non-secret suggestion into its exact form field. The
   *  field key is re-derived from the current result and checked against the
   *  live schema; a forged data attribute can neither select a secret field nor
   *  smuggle an arbitrary value into form state. */
  const applySetupGuideSuggestion = (fieldKey: string | undefined): void => {
    if (
      fieldKey === undefined
      || state.dialog.saving
      || state.dialog.oauthInFlight
      || state.dialog.setupGuide.stage !== 'ready'
    ) return;
    const schema = activeSchema();
    const guide = state.dialog.setupGuide;
    if (schema === undefined || guide.result === null || guide.preview === null) return;
    const suggestion = guide.result.guide.field_suggestions.find(
      (candidate) => candidate.field_key === fieldKey,
    );
    if (
      suggestion === undefined
      || !guide.preview.field_keys.includes(fieldKey)
      || !canApplyConnectionSetupGuideSuggestion(fieldKey, suggestion.suggested_value)
    ) return;
    const field = schema.fields.find((candidate) =>
      candidate.key === fieldKey
      && !candidate.hidden
      && !candidate.readonly
      && candidate.type !== 'secret'
      && (candidate.showWhen?.(state.dialog.values) ?? true));
    if (field === undefined) return;
    if (guide.resumeAvailable) {
      retireProviderSetupContinuity();
      guide.resumeAvailable = false;
      guide.resumeFieldKey = null;
    }
    const suggestedValue = suggestion.suggested_value!.trim();
    const suggestionChangesValue =
      (state.dialog.values[fieldKey] ?? '') !== suggestedValue;
    const invalidatedOAuthResult =
      state.dialog.oauthGrantedScopes !== null
      && invalidatesConnectionOAuthResult(fieldKey)
      && suggestionChangesValue;
    if (
      suggestionChangesValue
      || invalidatedOAuthResult
    ) retireUntouchedCleanEditorIfCurrent();
    state.dialog.values = {
      ...state.dialog.values,
      [fieldKey]: suggestedValue,
      ...(invalidatedOAuthResult ? { 'auth.refresh_token': '' } : {}),
    };
    if (invalidatedOAuthResult) {
      state.dialog.oauthGrantedScopes = null;
      state.dialog.oauthNeedsReauthorization =
        state.dialog.values['auth.type'] === 'oauth2_refresh';
    }
    syncCredentialRotationSuccessorEligibility();
    state.dialog.error = null;
    const clearsCredentialCorrection = suggestionChangesValue && (
      fieldKey.startsWith('config.')
      || state.dialog.credentialCorrection?.fieldKeys.includes(
        fieldKey as ConnectionCredentialCorrectionFieldKey,
      ) === true
    );
    if (clearsCredentialCorrection) {
      retireCredentialRegenerationSafeStop();
      state.dialog.credentialCorrection = null;
    }
    if (fieldKey.startsWith('auth.') || invalidatedOAuthResult) {
      state.dialog.oauthError = null;
      state.dialog.oauthErrorFieldKey = null;
    }
    render();
    focusGuideTarget(`[data-conn-field="${fieldKey}"]`);
  };

  /** Resume at the first unfinished OAuth-app field (or the next real form
   *  action once app details are complete) without collapsing the reviewed
   *  guide the owner may still need to consult. */
  const returnFromSetupGuide = (): void => {
    const schema = activeSchema();
    if (
      schema === undefined
      || state.dialog.saving
      || state.dialog.setupGuide.stage !== 'ready'
    ) return;
    const target = connectionSetupGuideReturnTarget(schema, state.dialog.values);
    if (target === null) return;
    if (target.kind === 'field') {
      focusGuideTarget(`[data-conn-field="${target.fieldKey}"]`);
      return;
    }
    focusGuideTarget(target.kind === 'authorize' ? OAUTH_AUTHORIZE_SELECTOR : SUBMIT_SELECTOR);
  };

  /** Consume the durable offer before touching the DOM, then resolve the next
   *  target from the newly rebuilt live form. A denied storage removal cannot
   *  make this store instance replay because retirement is in-memory first. */
  const resumeProviderSetup = (): void => {
    if (state.dialog.saving || !state.dialog.setupGuide.resumeAvailable) return;
    const resumeFieldKey = state.dialog.setupGuide.resumeFieldKey;
    retireProviderSetupContinuity();
    state.dialog.setupGuide.resumeAvailable = false;
    state.dialog.setupGuide.resumeFieldKey = null;
    render();
    if (resumeFieldKey !== null) {
      focusGuideTarget(`[data-conn-field="${resumeFieldKey}"]`);
      return;
    }
    returnFromSetupGuide();
  };

  // ── Imperative form-readiness sync (cosmetic; browser-UX only) ──
  // Keeps the live-validation checkpoint + gated Submit button in sync after
  // a SILENT text edit, without rebuilding the edited field or losing focus.
  // The submit handler re-validates regardless, so this is not load-bearing.
  const syncSubmitDisabled = (): void => {
    if (typeof host.querySelector !== 'function') return;
    const issue = currentConnectionFormValidationIssue();
    if (issue === undefined) return;
    const summary = connectionFormValidationSummary(issue);
    const ready = summary.status === 'ready';
    const announce = connectionFormValidationShouldAnnounce(
      state.dialog,
      issue,
    );
    const panel = host.querySelector(FORM_VALIDATION_PANEL_SELECTOR);
    const title = host.querySelector(FORM_VALIDATION_TITLE_SELECTOR);
    const message = host.querySelector(FORM_VALIDATION_MESSAGE_SELECTOR);
    const actionWrap = host.querySelector(FORM_VALIDATION_ACTION_WRAP_SELECTOR);
    const action = host.querySelector(FORM_VALIDATION_ACTION_SELECTOR);
    const unchanged = panel?.getAttribute('data-status') === summary.status
      && panel?.getAttribute('data-field-key') === summary.fieldKey
      && panel?.getAttribute('role') === (announce ? 'status' : 'group')
      && title?.textContent === summary.title
      && message?.textContent === summary.message;
    if (!unchanged) {
      panel?.setAttribute('aria-busy', 'true');
      panel?.setAttribute('data-status', summary.status);
      panel?.setAttribute('data-field-key', summary.fieldKey);
      panel?.setAttribute('role', announce ? 'status' : 'group');
      if (announce) {
        panel?.setAttribute('aria-live', 'polite');
        panel?.setAttribute('aria-atomic', 'true');
        panel?.removeAttribute('aria-labelledby');
        panel?.removeAttribute('aria-describedby');
      } else {
        panel?.removeAttribute('aria-live');
        panel?.removeAttribute('aria-atomic');
        panel?.setAttribute(
          'aria-labelledby',
          'connections-form-validation-title',
        );
        panel?.setAttribute(
          'aria-describedby',
          'connections-form-validation-message',
        );
      }
      if (title !== null) title.textContent = summary.title;
      if (message !== null) message.textContent = summary.message;
      if (action !== null) {
        action.textContent = summary.actionLabel;
        action.setAttribute('data-field-key', summary.fieldKey);
      }
      if (ready) actionWrap?.setAttribute('hidden', '');
      else actionWrap?.removeAttribute('hidden');
      panel?.removeAttribute('aria-busy');
    }
    const btn = host.querySelector(SUBMIT_SELECTOR);
    if (btn === null) return;
    if (
      ready
      && !state.dialog.saving
      && !state.dialog.oauthInFlight
      && state.dialog.externalChange === null
      && !hasCredentialRegenerationSafeStop(
        state.dialog.credentialCorrection,
      )
      && (
        opts.credentialRotationTabConvergence
          ?.readServerUpdateProgress() ?? null
      ) === null
      && (
        state.dialog.credentialRotationOwnership === null
        || state.dialog.credentialRotationOwnership.phase === 'available'
      )
    ) {
      btn.removeAttribute('disabled');
    }
    else btn.setAttribute('disabled', '');
  };

  /** Focus-preserving twin for the guide URL field. Typing does not rebuild the
   *  form; only the Review button's disabled state changes imperatively. */
  const syncGuideReviewDisabled = (): void => {
    if (typeof host.querySelector !== 'function') return;
    const btn = host.querySelector(GUIDE_REVIEW_SELECTOR);
    if (btn === null) return;
    if (state.dialog.setupGuide.targetUrl.trim().length > 0) {
      btn.removeAttribute('disabled');
    } else {
      btn.setAttribute('disabled', '');
    }
  };

  // ── installed-pack manifests — drives BOTH the Fork-1 B vendor-scope
  // pre-fill AND the connection-detail "Used by packs" inverse pivot. The
  // first read stays parallel with the connection list. A wired failure is a
  // visible degraded projection with an explicit retry: `null` is not proof
  // that no packs use these connections.
  let installedManifests: BulkPackManifest[] | null = null;
  let packsFetchAttempted = false;
  let packsFetchInFlight: Promise<void> | null = null;
  let packsFetchGeneration = 0;
  let packsRefreshPending = false;
  const packRetryOwnsFocus = (): boolean => {
    const active = doc.activeElement as HTMLElement | null | undefined;
    return active?.getAttribute?.('data-action')
      === 'connections-retry-pack-context';
  };
  const focusRecoveredPackContext = (): void => {
    if (typeof host.querySelector !== 'function') return;
    const target = host.querySelector(PACK_USAGE_SELECTOR)
      ?? host.querySelector(OPEN_ADD_SELECTOR);
    (target as HTMLElement | null)?.focus?.();
  };
  const ensurePacksLoaded = (options: {
    force?: boolean;
    reclaimFocus?: boolean;
  } = {}): Promise<void> => {
    if (opts.runPacksList === undefined || installedManifests !== null) {
      return Promise.resolve();
    }
    if (packsFetchInFlight !== null) return packsFetchInFlight;
    if (packsFetchAttempted && options.force !== true) return Promise.resolve();
    packsFetchAttempted = true;
    if (options.force === true) {
      state.packInventoryRecovery = {
        phase: 'retrying',
        message: state.packInventoryRecovery?.message ?? '',
      };
      if (options.reclaimFocus === true) {
        render();
        focusGuideTarget(PACK_INVENTORY_RETRY_SELECTOR);
      } else {
        renderPreservingPackContextFocus();
      }
    }
    const generationAtDispatch = packsFetchGeneration;
    const request = Promise.resolve()
      .then(() => opts.runPacksList!())
      .then((r) => {
        if (!disposed && generationAtDispatch === packsFetchGeneration) {
          // `manifest` is present only for installed packs, and this already
          // wanted exactly those — the filter below narrows the type rather
          // than changing what is collected.
          installedManifests = r.packs
            .filter((p) => p.installed)
            .map((p) => p.manifest)
            .filter((m): m is BulkPackManifest => m !== undefined);
          // Surface to the renderer so each api connection row can show its
          // "Used by packs" coverage, and re-render — the connection list
          // typically painted before this best-effort fetch resolved.
          state.installedPackManifests = installedManifests;
          const reclaimFocus = packRetryOwnsFocus();
          delete state.packInventoryRecovery;
          if (reclaimFocus) {
            render();
            focusRecoveredPackContext();
          } else {
            renderPreservingPackContextFocus();
          }
        }
      })
      .catch((error: unknown) => {
        if (disposed || generationAtDispatch !== packsFetchGeneration) return;
        const reclaimFocus = packRetryOwnsFocus();
        state.packInventoryRecovery = {
          phase: 'error',
          message: errMessage(error),
        };
        if (reclaimFocus) {
          render();
          focusGuideTarget(PACK_INVENTORY_RETRY_SELECTOR);
        } else {
          renderPreservingPackContextFocus();
        }
      })
      .finally(() => {
        if (packsFetchInFlight !== request) return;
        packsFetchInFlight = null;
        if (!disposed && packsRefreshPending) {
          packsRefreshPending = false;
          packsFetchAttempted = false;
          // Keep the original promise (including initial `whenLoaded`) open
          // through the causally-later read that superseded it.
          return ensurePacksLoaded({ reclaimFocus: packRetryOwnsFocus() });
        }
      });
    packsFetchInFlight = request;
    return request;
  };

  /** Pack broadcasts carry only the changed pack, while both consumers need
   *  the complete installed roster. Invalidate and re-list; rapid events
   *  coalesce behind the current request, and its generation guard prevents a
   *  superseded middle snapshot from painting. */
  const refreshPacksAfterBroadcast = (): void => {
    if (disposed || opts.runPacksList === undefined) return;
    packsFetchGeneration += 1;
    installedManifests = null;
    packsFetchAttempted = false;
    if (packsFetchInFlight !== null) {
      packsRefreshPending = true;
      return;
    }
    void ensurePacksLoaded();
  };
  const packInventoryUnsubscribers: Array<() => void> = [];
  if (opts.subscribe !== undefined && opts.runPacksList !== undefined) {
    packInventoryUnsubscribers.push(
      opts.subscribe('pack_installed', refreshPacksAfterBroadcast),
      opts.subscribe('pack_uninstalled', refreshPacksAfterBroadcast),
    );
  }

  /** Fork 1 B — the pre-filled scopes for a vendor's editable field: the vendor
   *  const seed UNIONed with the installed packs' needs. Empty when the pack list
   *  hasn't loaded (→ the field stays blank + the start passes nothing → the
   *  server computes the union itself).
   *
   *  ⛔⛔⛔ THE UNION IS KEYED BY CONNECTION SLOT, NOT BY VENDOR SEGMENT, and for
   *  several vendors those are DIFFERENT STRINGS. Every Microsoft Graph pack binds
   *  the connection `microsoft`, while the vendor segments are `onedrive` /
   *  `sharepoint` / `excel` — so looking the union up by the vendor segment
   *  returned EMPTY and the Scopes box rendered blank. The owner could then click
   *  Authorize and be rejected by Microsoft for requesting no scopes: a dead end
   *  with nothing on screen explaining it.
   *
   *  🔑 It went unnoticed because the vendors where segment and slot happen to be
   *  the SAME string (`google`, `hubspot`, `pipedrive`, `salesforce`) worked
   *  perfectly — the working majority is exactly what made the broken ones look
   *  like a different problem. So the slots are DERIVED from the installed packs
   *  rather than assumed equal to the segment: every slot a pack of this vendor
   *  actually binds contributes, and the segment stays in the set so nothing that
   *  worked before can stop working. */
  const scopeSlotsForVendor = (vendor: string): string[] => {
    const slots = new Set<string>([vendor]);
    for (const manifest of installedManifests ?? []) {
      const declares = (manifest.connection_requirements ?? [])
        .some((r) => (r as { vendor?: string }).vendor === vendor);
      if (!declares) continue;
      for (const slot of Object.keys(requiredScopesByConnection(manifest))) slots.add(slot);
    }
    return [...slots];
  };
  const prefillVendorScopes = (vendor: string): string => {
    if (installedManifests === null) return '';
    const seed = getVendorProvider(vendor)?.oauth.scopes ?? [];
    const union = scopeSlotsForVendor(vendor)
      .flatMap((slot) => unionRequiredScopesForConnection(installedManifests ?? [], slot));
    return [...new Set([...seed, ...union])].sort().join(' ');
  };

  /** D-223 — the installed packs' declared pre-fills for this connection.
   *  Same shape as the Fork-1 B scope pre-fill above: best-effort, skipped
   *  entirely until the pack list settles. A hint only ever contributes a VALUE,
   *  and `applyConnectionHints` drops any aimed at a field the schema renders
   *  hidden or readonly — so a pre-fill can never set something the owner cannot
   *  see and change. */
  const hintSourcesFor = (): ConnectionHintSource[] => {
    if (installedManifests === null) return [];
    return installedManifests
      .filter((m) => Array.isArray(m.connection_hints) && m.connection_hints.length > 0)
      .map((m) => ({ publisher: m.publisher, hints: m.connection_hints ?? [] }));
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
  const vendorEnrollSeed = (vendor: string | null): {
    vendor: string | null;
    values: ConnectionFormValues;
    schema: ConnectionSchema | undefined;
    /** D-223 — which seeded values came from a pack, for attribution (Slice 2). */
    hints: readonly AppliedConnectionHint[];
  } => {
    if (vendor === null) {
      // No vendor => nothing to match a hint's `connection` against, so the bare
      // form seeds from the schema alone.
      const schema = resolveConnectionSchema('api');
      return {
        vendor: null,
        values: schema ? seedSchemaDefaults(schema) : {},
        schema,
        hints: [],
      };
    }
    if (resolveVendorSchema(vendor) !== undefined) {
      const schema = resolveConnectionSchema('api', undefined, vendor);
      // Fork 1 B — pre-fill the editable Scopes field with the vendor const ∪
      // the installed packs' needs (empty when the pack list isn't loaded →
      // the field stays blank + the server computes the union itself).
      const prefill = prefillVendorScopes(vendor);
      const vendorHints = applyConnectionHints(schema, hintSourcesFor(), vendor);
      return {
        vendor,
        values: {
          ...initialVendorSchemaValues(vendor),
          ...(prefill.length > 0 ? { 'auth.scopes': prefill } : {}),
          // Last so a hint beats a schema default — but `applyConnectionHints`
          // has already dropped anything targeting a hidden/readonly field, so
          // this cannot overwrite a vendor-locked value.
          ...connectionHintValues(vendorHints),
        },
        schema,
        hints: vendorHints,
      };
    }
    const schema = resolveConnectionSchema('api');
    const genericHints = applyConnectionHints(schema, hintSourcesFor(), vendor);
    /** ⛔ THE GENERIC FORK PRE-FILLS SCOPES TOO. A vendor with no REGISTERED schema
     *  (`excel` is one) falls through to here, and the prefill used to live only in
     *  the registered-vendor branch above — so its Scopes box was blank however
     *  well the pack declared `required_scopes`, and Authorize failed at the
     *  provider for requesting none. The pack's own declarations are the whole
     *  source here; a registered schema is not a precondition for knowing what a
     *  pack needs. */
    const genericPrefill = prefillVendorScopes(vendor);
    return {
      vendor: null,
      values: {
        ...(schema ? seedSchemaDefaults(schema) : {}),
        // Name defaults to the vendor so recipe `{{connection.api.<name>}}`
        // NAME-matching lines up with the pack's vendor-matching; editable.
        ...(CONNECTION_NAME_REGEX.test(vendor) ? { name: vendor } : {}),
        'config.vendor': vendor,
        ...(genericPrefill.length > 0 ? { 'auth.scopes': genericPrefill } : {}),
        ...connectionHintValues(genericHints),
      },
      schema,
      hints: genericHints,
    };
  };

  const openVendorEnrollForm = (vendor: string): void => {
    beginDialogNavigation();
    const seed = vendorEnrollSeed(vendor);
    state.dialog.kind = 'api';
    state.dialog.subtype = null;
    state.dialog.vendor = seed.vendor;
    state.dialog.values = seed.values;
    state.dialog.hintedFields = Object.fromEntries(
      seed.hints.map(({ key, publisher }) => [key, publisher]),
    );
    state.dialog.error = null;
    state.dialog.stage = 'form';
    captureDialogDraftBaseline();
  };

  /** Restore only after the list + pack schema inputs settle. The form is a
   *  fresh local projection; matching the rebuilt preview against the stored
   *  echo prevents a stale schema or tampered marker from relabeling a guide. */
  const restoreProviderSetup = (): boolean => {
    const draft = opts.providerSetupContinuity?.read();
    if (draft === undefined || draft === null) return false;
    const registeredNow = draft.schemaVendor !== null
      && resolveVendorSchema(draft.schemaVendor) !== undefined;
    if (
      (draft.schemaKind === 'registered_vendor' && !registeredNow)
      || (draft.schemaKind === 'pack_vendor' && registeredNow)
    ) {
      retireProviderSetupContinuity();
      return false;
    }
    const seed = vendorEnrollSeed(draft.schemaVendor);
    if (seed.schema === undefined) {
      retireProviderSetupContinuity();
      return false;
    }
    let values: ConnectionFormValues = {
      ...seed.values,
      'auth.type': draft.result.shared_context.auth_type,
    };
    if (seed.vendor !== null) {
      values = syncVendorOAuthEndpointValue(seed.vendor, values);
    }
    const rebuilt = buildConnectionSetupGuidePreview(
      seed.schema,
      values,
      draft.result.shared_context.target_url,
    );
    if (
      !rebuilt.ok
      || !connectionSetupGuideContextsMatch(
        rebuilt.preview,
        draft.result.shared_context,
      )
    ) {
      retireProviderSetupContinuity();
      return false;
    }
    if (draft.resumeFieldKey !== null) {
      const resumeField = seed.schema.fields.find((field) =>
        field.key === draft.resumeFieldKey
        && !field.hidden
        && !field.readonly
        && (field.showWhen?.(values) ?? true));
      if (
        resumeField === undefined
        || !rebuilt.preview.field_keys.includes(draft.resumeFieldKey)
      ) {
        retireProviderSetupContinuity();
        return false;
      }
    }

    dialogGen += 1;
    invalidateCredentialRotationSafeStopCheck();
    invalidateCredentialSafeStopAcknowledgement();
    guideGeneration += 1;
    state.dialog = {
      ...initialConnectionsDialogState(),
      oauthCallbackUrl: resolveOAuthCallbackUrlForThisPwa(),
      oauthCallbackAlternateUrl: resolveOAuthCallbackAlternateForThisPwa(),
      stage: 'form',
      mode: 'create',
      kind: 'api',
      subtype: null,
      vendor: seed.vendor,
      values,
      setupGuide: {
        stage: 'ready',
        targetUrl: rebuilt.preview.target_url,
        preview: rebuilt.preview,
        result: draft.result,
        error: null,
        resumeAvailable: true,
        resumeFieldKey: draft.resumeFieldKey,
      },
    };
    captureDialogDraftBaseline();
    render();
    return true;
  };

  const exactOpenEditor = (
    kind: ConnectionKind,
    name: string,
  ): boolean => state.dialog.stage === 'form'
    && state.dialog.mode === 'edit'
    && state.dialog.editingId === connectionRowKey(kind, name);

  const isCrossTabCredentialSafeStopRecovery = (
    recovery: ConnectionsPageState['credentialRotationRecovery'],
    kind: ConnectionKind,
    name: string,
  ): boolean => recovery?.kind === kind
    && recovery.name === name
    && (
      recovery.phase === 'safe_stop_checking'
      || recovery.phase === 'safe_stopped'
      || recovery.phase === 'safe_stop_unconfirmed'
    );

  const isCrossTabCredentialSafeStopOwnership = (
    ownership: ConnectionsPageState['dialog']['credentialRotationOwnership'],
    kind: ConnectionKind,
    name: string,
  ): boolean => ownership?.kind === kind
    && ownership.name === name
    && (
      ownership.phase === 'safe_stop_checking'
      || ownership.phase === 'safe_stopped'
      || ownership.phase === 'safe_stop_unconfirmed'
    );

  /** Retire only the exact cross-tab safe-stop projection. A newer started
   * hint may also retire the older local receipt because the server has
   * causally accepted a successor claim for this connection. */
  const clearCredentialRotationSafeStopPresentation = (
    kind: ConnectionKind,
    name: string,
    includeLocalReceipt = false,
  ): boolean => {
    let changed = false;
    const recovery = state.credentialRotationRecovery;
    const hadAuthoritativeSafeStop = (
      recovery?.kind === kind
      && recovery.name === name
      && hasCredentialRegenerationSafeStop(recovery.correction)
    )
      || (
        exactOpenEditor(kind, name)
        && hasCredentialRegenerationSafeStop(
          state.dialog.credentialCorrection,
        )
      );
    const clearsRecovery = isCrossTabCredentialSafeStopRecovery(
      recovery,
      kind,
      name,
    ) || (
      includeLocalReceipt
      && recovery?.kind === kind
      && recovery.name === name
      && hasCredentialRegenerationSafeStop(recovery.correction)
    );
    if (clearsRecovery) {
      state.credentialRotationRecovery = null;
      changed = true;
    }
    if (
      exactOpenEditor(kind, name)
      && hasCredentialRegenerationSafeStop(
        state.dialog.credentialCorrection,
      )
      && (clearsRecovery || includeLocalReceipt)
    ) {
      state.dialog.credentialCorrection = null;
      changed = true;
    }
    if (isCrossTabCredentialSafeStopOwnership(
      state.dialog.credentialRotationOwnership,
      kind,
      name,
    )) {
      state.dialog.credentialRotationOwnership = null;
      changed = true;
    }
    if (
      credentialRotationSafeStopClosure?.key === connectionRowKey(kind, name)
    ) invalidateCredentialSafeStopAcknowledgement();
    if (includeLocalReceipt && hadAuthoritativeSafeStop) {
      const marker = opts.credentialRotationContinuity?.read() ?? null;
      if (marker?.kind === kind && marker.name === name) {
        opts.credentialRotationContinuity?.retire(marker.attemptId);
      }
    }
    return changed;
  };

  /** A causally-later full list that no longer contains the exact target is
   * stronger evidence than an older safe-stop projection. Drop the orphaned
   * banner/correction so its fallback “Dismiss” action can never become a
   * button that appears to work but immediately redraws the same recovery. */
  const clearCredentialSafeStopForMissingConnection = (
    connections: ReadonlyArray<ConnectionView>,
  ): boolean => {
    const recovery = state.credentialRotationRecovery;
    if (
      recovery === null
      || !isCrossTabCredentialSafeStopRecovery(
        recovery,
        recovery.kind,
        recovery.name,
      )
      || connections.some((connection) =>
        connection.kind === recovery.kind
        && connection.name === recovery.name)
    ) return false;
    invalidateCredentialRotationSafeStopCheckFor(
      recovery.kind,
      recovery.name,
    );
    return clearCredentialRotationSafeStopPresentation(
      recovery.kind,
      recovery.name,
    );
  };

  const presentAuthoritativeCredentialSafeStop = (
    kind: ConnectionKind,
    name: string,
    safeStop: ValidatedCredentialRotationSafeStop,
    announce: boolean,
    options: {
      outstandingSafeStopCount?: number;
      render?: boolean;
    } = {},
  ): void => {
    const key = connectionRowKey(kind, name);
    if (
      credentialRotationResolvedSafeStopEditor?.key === key
      && credentialRotationResolvedSafeStopEditor.dialogGeneration
        === dialogGen
    ) credentialRotationResolvedSafeStopEditor = null;
    const exactEditor = exactOpenEditor(kind, name);
    state.dialog.credentialSafeStopClosureNotice = null;
    state.credentialRotationRecovery = {
      kind,
      name,
      phase: 'safe_stopped',
      failureReason: 'auth_failed',
      correction: safeStop.correction,
      ...(options.outstandingSafeStopCount !== undefined
        ? { outstandingSafeStopCount: options.outstandingSafeStopCount }
        : {}),
    };
    if (exactEditor) {
      state.dialog.error = null;
      const correctionLanded = setDialogCredentialCorrection(
        safeStop.correction,
        'Your server says it stopped trying after the key was refused again and again. The key it had saved was not changed.',
      );
      state.dialog.credentialRotationOwnership = correctionLanded
        ? null
        : {
            kind,
            name,
            phase: 'safe_stopped',
            automaticTakeover: false,
            error: 'The sign-in that was refused is not the one in this form. Look at what happened before you start another check.',
          };
    }
    applyCredentialSafeStopClosureCapability(
      kind,
      name,
      safeStop.acknowledgementToken,
    );
    if (credentialRotationOwnershipLease?.key === key) {
      releaseCredentialRotationOwnership(true);
    }
    if (announce) {
      opts.credentialRotationTabConvergence
        ?.notifyCredentialRotationSafeStopped({ kind, name });
    }
    if (options.render !== false) {
      renderPreservingActiveField();
      syncSubmitDisabled();
    }
  };

  /** Apply the optional list sidecar used by cold/reloaded tabs. It can add a
   * server-confirmed handoff, but absence never clears an existing one; exact
   * activity is still required for that causally stronger transition. */
  const applyCredentialSafeStopDiscovery = (
    response: Awaited<ReturnType<ConnectionsEnrollListCaller>>,
    connections: ReadonlyArray<ConnectionView>,
    renderPresentation = false,
  ): boolean => {
    if (response.credential_rotation_safe_stops === undefined) return false;
    const summaries = validatedCredentialRotationSafeStopSummaries(
      response.credential_rotation_safe_stops,
      connections,
    );
    if (summaries === null || summaries.length === 0) return false;
    const recovery = state.credentialRotationRecovery;
    const currentIsSafeStop = recovery !== null && (
      // Boot starts the exact interrupted-receipt read and the current list in
      // parallel. Let a valid list sidecar replace only that provisional
      // `checking` presentation; the later receipt result must then reconcile
      // rather than silently discarding a current safe stop that landed first.
      recovery.phase === 'checking'
      || isCrossTabCredentialSafeStopRecovery(
        recovery,
        recovery.kind,
        recovery.name,
      )
      || hasCredentialRegenerationSafeStop(recovery.correction)
    );
    if (recovery !== null && !currentIsSafeStop) return false;
    const exactEditorKey = state.dialog.stage === 'form'
      && state.dialog.mode === 'edit'
      && state.dialog.kind !== null
      ? connectionRowKey(
          state.dialog.kind,
          state.dialog.values.name ?? '',
        )
      : null;
    const target = summaries.find((summary) =>
      connectionRowKey(summary.kind, summary.name) === exactEditorKey)
      ?? (recovery === null
        ? undefined
        : summaries.find((summary) =>
            summary.kind === recovery.kind && summary.name === recovery.name))
      ?? summaries[0]!;
    presentAuthoritativeCredentialSafeStop(
      target.kind,
      target.name,
      target,
      false,
      {
        outstandingSafeStopCount: summaries.length,
        render: renderPresentation,
      },
    );
    return true;
  };

  /** Restore only unresolved work from the server's post-ack sidecar. An empty
   * array is authoritative closure on a current server; a missing property is
   * an older server and cannot clear live state. Local checking/all-clear
   * receipts stay one-shot and are never replaced by their own list reread. */
  const applyPostSafeStopVerificationDiscovery = (
    response: Awaited<ReturnType<ConnectionsEnrollListCaller>>,
    connections: ReadonlyArray<ConnectionView>,
    renderPresentation = false,
  ): boolean => {
    const raw = response.credential_post_safe_stop_verifications;
    if (raw === undefined) return false;
    const summaries = validatedPostSafeStopVerificationSummaries(
      raw,
      connections,
    );
    if (summaries === null) {
      state.postSafeStopRecoveries = [];
      return false;
    }
    state.postSafeStopRecoveries = summaries.map((summary) => ({
      kind: summary.kind,
      name: summary.name,
      status: summary.status,
      acknowledgedAt: summary.acknowledgedAt,
      ...(summary.checkedAt !== undefined
        ? { checkedAt: summary.checkedAt }
        : {}),
      ...(summary.correction !== undefined
        ? { credentialCorrection: summary.correction }
        : {}),
    }));
    const requestedTarget = initialPostSafeStopRecoveryTarget;
    initialPostSafeStopRecoveryTarget = null;
    const current = state.dialog.recentProbe;
    if (
      postSafeStopProfileHandoff !== null
      || suppressAutomaticPostSafeStopRecovery
    ) {
      // The queue belongs to the server that answered this boot, but the
      // incoming address did not. Keep the current queue reviewable only as a
      // new explicit choice; never let kind/name fall through across profiles.
      if (current?.purpose === 'post_safe_stop') {
        state.dialog.recentProbe = null;
      }
      if (renderPresentation) renderPreservingActiveField();
      return true;
    }
    const currentIdentityIsUnresolved = current?.purpose === 'post_safe_stop'
      && summaries.some((summary) =>
        summary.kind === current.kind && summary.name === current.name);
    if (
      current?.purpose === 'post_safe_stop'
      && (
        current.resolution === 'checking'
        || (
          (current.resolution === 'resolved' || current.resolution === 'removed')
          && !currentIdentityIsUnresolved
        )
      )
    ) {
      if (renderPresentation) renderPreservingActiveField();
      return true;
    }
    if (summaries.length === 0) {
      if (current?.purpose !== 'post_safe_stop') return false;
      state.dialog.recentProbe = null;
      if (renderPresentation) renderPreservingActiveField();
      return true;
    }
    const target = (
      requestedTarget === null
        ? undefined
        : summaries.find((summary) =>
            summary.kind === requestedTarget.kind
            && summary.name === requestedTarget.name)
    ) ?? (
      current?.purpose !== 'post_safe_stop'
        ? undefined
        : summaries.find((summary) =>
            summary.kind === current.kind && summary.name === current.name)
    ) ?? summaries[0]!;
    state.dialog.recentProbe = {
      kind: target.kind,
      name: target.name,
      status: target.status,
      purpose: 'post_safe_stop',
      resolution: target.status === 'auth_failed' ? 'reopen' : 'retry',
      ...(target.correction !== undefined
        ? { credential_correction: target.correction }
        : {}),
      ...(target.checkedAt !== undefined
        ? { checked_at: target.checkedAt }
        : {}),
    };
    if (renderPresentation) renderPreservingActiveField();
    return true;
  };

  const presentPostSafeStopRecovery = (
    recovery: ConnectionsPageState['postSafeStopRecoveries'][number],
  ): void => {
    state.dialog.recentProbe = {
      kind: recovery.kind,
      name: recovery.name,
      status: recovery.status,
      purpose: 'post_safe_stop',
      resolution: recovery.status === 'auth_failed' ? 'reopen' : 'retry',
      ...(recovery.credentialCorrection !== undefined
        ? { credential_correction: recovery.credentialCorrection }
        : {}),
      ...(recovery.checkedAt !== undefined
        ? { checked_at: recovery.checkedAt }
        : {}),
    };
  };

  /** Treat the tab hint as a wake-up only. The selected server must repeat its
   * secret-free activity read before this tab renders an admin handoff or
   * clears a prior one. */
  const reconcileCredentialRotationSafeStop = (
    kind: ConnectionKind,
    name: string,
    announced: boolean,
  ): Promise<void> => {
    const key = connectionRowKey(kind, name);
    const exactEditor = exactOpenEditor(kind, name);
    const schema = exactEditor ? activeSchema() : undefined;
    const savingCredentialRotation = state.dialog.saving
      && schema !== undefined
      && shouldPatchConnectionAuth(schema, state.dialog.values);
    if (
      exactEditor
      && (
        savingCredentialRotation
        || state.dialog.oauthInFlight
        || credentialRotationOwnershipLease?.key === key
      )
    ) {
      // This tab is already advancing the exact credential editor. A delayed
      // advisory stop cannot outrank its live OAuth/rotation transition; that
      // transition's terminal result will publish or restore the next state.
      // A metadata-only save is deliberately not covered: it must still retain
      // a sibling safe stop as a list-level handoff after that save settles.
      invalidateCredentialRotationSafeStopCheckFor(kind, name);
      return Promise.resolve();
    }
    const existingCheck = credentialRotationSafeStopCheck?.key === key
      ? credentialRotationSafeStopCheck
      : null;
    if (existingCheck !== null) {
      if (announced && !existingCheck.pauseRequired) {
        existingCheck.pauseRequired = true;
        const recovery = state.credentialRotationRecovery;
        const alreadyConfirmed = recovery?.kind === kind
          && recovery.name === name
          && hasCredentialRegenerationSafeStop(recovery.correction);
        if (!alreadyConfirmed) {
          state.credentialRotationRecovery = {
            kind,
            name,
            phase: 'safe_stop_checking',
          };
          if (exactOpenEditor(kind, name)) {
            state.dialog.credentialRotationOwnership = {
              kind,
              name,
              phase: 'safe_stop_checking',
              automaticTakeover: false,
              error: null,
            };
          }
          renderPreservingActiveField();
          syncSubmitDisabled();
        }
      }
      return existingCheck.promise;
    }
    const recovery = state.credentialRotationRecovery;
    const relevantRecovery = recovery?.kind === kind && recovery.name === name;
    const shouldPauseWhileChecking = announced
      || isCrossTabCredentialSafeStopRecovery(recovery, kind, name)
      || isCrossTabCredentialSafeStopOwnership(
        state.dialog.credentialRotationOwnership,
        kind,
        name,
      );
    const localSafeStop = relevantRecovery
      && hasCredentialRegenerationSafeStop(recovery.correction)
      && !isCrossTabCredentialSafeStopRecovery(recovery, kind, name);
    const locallyResolvedInThisEditor = !announced
      && exactEditor
      && credentialRotationResolvedSafeStopEditor?.key === key
      && credentialRotationResolvedSafeStopEditor.dialogGeneration
        === dialogGen;
    if (
      (!announced && !exactEditor
        && !isCrossTabCredentialSafeStopRecovery(recovery, kind, name)
        && !localSafeStop)
      || (
        locallyResolvedInThisEditor
        && !isCrossTabCredentialSafeStopRecovery(recovery, kind, name)
        && !isCrossTabCredentialSafeStopOwnership(
          state.dialog.credentialRotationOwnership,
          kind,
          name,
        )
      )
    ) return Promise.resolve();

    const hadConfirmedSafeStop = relevantRecovery
      && hasCredentialRegenerationSafeStop(recovery?.correction);
    if (!hadConfirmedSafeStop && shouldPauseWhileChecking) {
      state.credentialRotationRecovery = {
        kind,
        name,
        phase: 'safe_stop_checking',
      };
      if (exactEditor) {
        state.dialog.credentialRotationOwnership = {
          kind,
          name,
          phase: 'safe_stop_checking',
          automaticTakeover: false,
          error: null,
        };
      }
      renderPreservingActiveField();
      syncSubmitDisabled();
    }

    const generation = ++credentialRotationSafeStopCheckGeneration;
    const check = {
      key,
      generation,
      pauseRequired: shouldPauseWhileChecking,
      promise: Promise.resolve(),
    };
    const checkStillCurrent = (): boolean => !disposed
      && credentialRotationSafeStopCheck === check
      && credentialRotationSafeStopCheckGeneration === generation;
    check.promise = (async () => {
      const runActivity = opts.runCredentialRotationActivity;
      if (runActivity === undefined) {
        if (!checkStillCurrent()) return;
        if (hadConfirmedSafeStop) {
          applyCredentialSafeStopClosureCapability(kind, name, null);
          renderPreservingActiveField();
          syncSubmitDisabled();
          return;
        }
        if (!check.pauseRequired) return;
        state.credentialRotationRecovery = {
          kind,
          name,
          phase: 'safe_stop_unconfirmed',
        };
        if (exactOpenEditor(kind, name)) {
          state.dialog.credentialRotationOwnership = {
            kind,
            name,
            phase: 'safe_stop_unconfirmed',
            automaticTakeover: false,
            error: 'This server cannot confirm the safe stop across tabs. Carry on in the tab you started in, or update the server.',
          };
        }
        renderPreservingActiveField();
        syncSubmitDisabled();
        return;
      }

      try {
        const { activity } = await runActivity({ kind, name });
        if (!checkStillCurrent()) return;
        if (activity.status === 'pending') {
          clearCredentialRotationSafeStopPresentation(kind, name, true);
          state.credentialRotationRecovery = {
            kind,
            name,
            phase: 'handoff',
          };
          if (exactOpenEditor(kind, name)) {
            state.dialog.credentialRotationOwnership = {
              kind,
              name,
              phase: 'active',
              automaticTakeover:
                opts.credentialRotationTabConvergence
                  ?.supportsOwnershipLeases === true
                && hasActionableCredentialRotationDraft(),
              error: null,
            };
            scheduleCredentialRotationSuccessorPoll();
          }
          renderPreservingActiveField();
          syncSubmitDisabled();
          return;
        }
        const authoritative = credentialRotationSafeStopFromActivity(
          activity,
          kind,
        );
        if (!authoritative.supported) {
          if (hadConfirmedSafeStop) {
            applyCredentialSafeStopClosureCapability(kind, name, null);
            renderPreservingActiveField();
            syncSubmitDisabled();
            return;
          }
          if (!check.pauseRequired) return;
          state.credentialRotationRecovery = {
            kind,
            name,
            phase: 'safe_stop_unconfirmed',
          };
          if (exactOpenEditor(kind, name)) {
            state.dialog.credentialRotationOwnership = {
              kind,
              name,
              phase: 'safe_stop_unconfirmed',
              automaticTakeover: false,
              error: 'Your server did not say whether it stopped safely. Carry on in the tab you started in, or update the server.',
            };
          }
          renderPreservingActiveField();
          syncSubmitDisabled();
          return;
        }
        if (authoritative.safeStop === null) {
          if (clearCredentialRotationSafeStopPresentation(
            kind,
            name,
            localSafeStop,
          )) {
            renderPreservingActiveField();
            syncSubmitDisabled();
          }
          return;
        }
        presentAuthoritativeCredentialSafeStop(
          kind,
          name,
          authoritative.safeStop,
          false,
        );
      } catch {
        if (!checkStillCurrent()) return;
        if (hadConfirmedSafeStop) {
          setDialogCredentialSafeStopClosure(
            'unconfirmed',
            'Recued could not reach your server to check it finished safely. Reconnect and try again. Your new key stays only in this tab.',
          );
          renderPreservingActiveField();
          syncSubmitDisabled();
          return;
        }
        if (!check.pauseRequired) return;
        state.credentialRotationRecovery = {
          kind,
          name,
          phase: 'safe_stop_unconfirmed',
        };
        if (exactOpenEditor(kind, name)) {
          state.dialog.credentialRotationOwnership = {
            kind,
            name,
            phase: 'safe_stop_unconfirmed',
            automaticTakeover: false,
            error: 'Recued could not reach the paired server to confirm the safe stop. Reconnect and check again; your draft stays only in this tab.',
          };
        }
        renderPreservingActiveField();
        syncSubmitDisabled();
      }
    })().finally(() => {
      if (credentialRotationSafeStopCheck === check) {
        credentialRotationSafeStopCheck = null;
      }
    });
    credentialRotationSafeStopCheck = check;
    return check.promise;
  };

  /** Quietly compete for an abandoned browser lock, then keep polling server
   * activity if this tab becomes the one elected successor. This timer carries
   * no identity outside memory and never replaces the form while another tab
   * still owns the lock. */
  const scheduleCredentialRotationSuccessorPoll = (): void => {
    cancelCredentialRotationSuccessorPoll();
    const ownership = state.dialog.credentialRotationOwnership;
    if (
      ownership === null
      || ownership.automaticTakeover !== true
      || (ownership.phase !== 'active' && ownership.phase !== 'pending')
      || !exactOpenEditor(ownership.kind, ownership.name)
    ) return;
    credentialRotationSuccessorPollTimer = globalThis.setTimeout(() => {
      credentialRotationSuccessorPollTimer = null;
      if (!disposed) void checkCredentialRotationOwnership(false);
    }, CREDENTIAL_ROTATION_SUCCESSOR_POLL_MS);
  };

  /** Keep automatic-election eligibility aligned with the live, memory-only
   * form. Once this tab owns a still-pending server attempt it must continue
   * shepherding that attempt to a receipt even if the user clears the draft;
   * otherwise an editor without a replacement yields immediately. */
  const syncCredentialRotationSuccessorEligibility = (): boolean => {
    const ownership = state.dialog.credentialRotationOwnership;
    if (ownership === null) return false;
    // A returned former owner observes the successor through its durable
    // attempt marker. It must not quietly join the successor election again.
    if (ownership.phase === 'handoff') {
      cancelCredentialRotationSuccessorPoll();
      if (!ownership.automaticTakeover) return false;
      ownership.automaticTakeover = false;
      return true;
    }
    const key = connectionRowKey(ownership.kind, ownership.name);
    const holdsLease = credentialRotationOwnershipLease?.key === key;
    if (holdsLease && ownership.phase === 'pending') {
      if (!ownership.automaticTakeover) {
        ownership.automaticTakeover = true;
        scheduleCredentialRotationSuccessorPoll();
      }
      return false;
    }
    const eligible =
      opts.credentialRotationTabConvergence?.supportsOwnershipLeases === true
      && hasActionableCredentialRotationDraft();
    if (ownership.automaticTakeover === eligible) return false;
    ownership.automaticTakeover = eligible;
    if (eligible) {
      scheduleCredentialRotationSuccessorPoll();
      return true;
    }
    cancelCredentialRotationSuccessorPoll();
    if (!holdsLease || ownership.phase === 'checking') return true;
    releaseCredentialRotationOwnership(true);
    if (ownership.phase === 'available') {
      state.dialog.credentialRotationOwnership = null;
    } else {
      ownership.phase = 'active';
      ownership.error = null;
    }
    return true;
  };

  /** Elect one successor tab, then ask the paired server whether the original
   * provider check is actually finished. The draft is never read or rebuilt by
   * this path. A server-idle result is still followed by a revision read before
   * this tab becomes actionable. */
  const checkCredentialRotationOwnership = (
    announceChecking = true,
  ): Promise<void> => {
    const ownership = state.dialog.credentialRotationOwnership;
    if (
      ownership === null
      || (!announceChecking && ownership.automaticTakeover !== true)
      || !exactOpenEditor(ownership.kind, ownership.name)
    ) return Promise.resolve();
    const kind = ownership.kind;
    const name = ownership.name;
    const key = connectionRowKey(kind, name);
    const dialogAtStart = dialogGen;
    const editorAtStart = editorRevision;
    const automaticCheck = !announceChecking;
    const existingCheck = credentialRotationActivityCheck;
    if (
      existingCheck !== null
      && existingCheck.key === key
      && existingCheck.dialogGeneration === dialogAtStart
      && existingCheck.ownership === ownership
    ) return existingCheck.promise;
    const checkStillCurrent = (): boolean => !disposed
      && dialogAtStart === dialogGen
      && exactOpenEditor(kind, name)
      && state.dialog.credentialRotationOwnership === ownership
      && (!automaticCheck || ownership.automaticTakeover);
    cancelCredentialRotationSuccessorPoll();
    if (announceChecking) {
      ownership.phase = 'checking';
      ownership.error = null;
      renderPreservingActiveField();
      syncSubmitDisabled();
    }

    const check = {
      key,
      dialogGeneration: dialogAtStart,
      ownership,
      promise: Promise.resolve(),
    };
    check.promise = (async () => {
      const convergence = opts.credentialRotationTabConvergence;
      if (convergence?.supportsOwnershipLeases !== true) {
        if (checkStillCurrent()) {
          ownership.phase = 'unconfirmed';
          ownership.error = 'This browser cannot safely pick which tab is in charge. Finish the check, or close it, in the tab you started in.';
          renderPreservingActiveField();
          syncSubmitDisabled();
        }
        return;
      }

      let lease = credentialRotationOwnershipLease?.key === key
        ? credentialRotationOwnershipLease.lease
        : null;
      let leaseWasRemembered = lease !== null;
      const releaseClaimedLease = (): void => {
        if (lease === null) return;
        if (credentialRotationOwnershipLease?.lease === lease) {
          releaseCredentialRotationOwnership(true);
        } else if (!leaseWasRemembered) {
          // A claim that landed after the editor was replaced was never put in
          // panel state, so no dialog transition could have yielded it for us.
          lease.release();
        }
      };
      if (lease === null) {
        lease = await convergence.claimCredentialRotationOwnership({ kind, name });
      }
      if (!checkStillCurrent()) {
        releaseClaimedLease();
        return;
      }
      if (lease === null) {
        const presentationChanged = ownership.phase !== 'active'
          || ownership.error !== null;
        ownership.phase = 'active';
        ownership.error = null;
        if (presentationChanged) {
          renderPreservingActiveField();
          syncSubmitDisabled();
        }
        scheduleCredentialRotationSuccessorPoll();
        return;
      }
      rememberCredentialRotationOwnership(kind, name, lease);
      leaseWasRemembered = true;

      const runActivity = opts.runCredentialRotationActivity;
      if (runActivity === undefined) {
        releaseCredentialRotationOwnership(false);
        ownership.phase = 'unconfirmed';
        ownership.automaticTakeover = false;
        ownership.error = 'This server cannot confirm whether the earlier provider check finished. Update the server before taking over.';
        renderPreservingActiveField();
        syncSubmitDisabled();
        return;
      }

      let activity: ConnectionCredentialRotationActivity;
      try {
        ({ activity } = await runActivity({ kind, name }));
      } catch (error) {
        if (!checkStillCurrent()) {
          releaseClaimedLease();
          return;
        }
        const classified = classifyRpcError(error);
        const unavailable = classified.code === 'unknown_method'
          || classified.code === 'not_configured';
        if (unavailable) {
          releaseCredentialRotationOwnership(false);
          ownership.automaticTakeover = false;
        } else {
          // A manually checked tab that successfully won the browser lease is
          // now the sole recovery observer too. Keep that observation moving
          // after reconnect even when it has no replacement draft of its own.
          ownership.automaticTakeover = true;
        }
        ownership.phase = 'unconfirmed';
        ownership.error = unavailable
          ? 'This server cannot confirm whether the earlier provider check finished. Update the server before taking over.'
          : ownership.automaticTakeover
            ? 'Recued could not reach the paired server to confirm ownership. It will check again after reconnecting.'
            : 'Recued could not reach the paired server to confirm ownership. Reconnect, then check again.';
        renderPreservingActiveField();
        syncSubmitDisabled();
        return;
      }
      if (!checkStillCurrent()) {
        releaseClaimedLease();
        return;
      }
      if (activity.status === 'pending') {
        announceCredentialRotationOwnership(kind, name);
        const presentationChanged = ownership.phase !== 'pending'
          || ownership.error !== null;
        ownership.phase = 'pending';
        ownership.automaticTakeover = true;
        ownership.error = null;
        if (presentationChanged) {
          renderPreservingActiveField();
          syncSubmitDisabled();
        }
        scheduleCredentialRotationSuccessorPoll();
        return;
      }
      const authoritativeSafeStop = credentialRotationSafeStopFromActivity(
        activity,
        kind,
      );
      if (authoritativeSafeStop.safeStop !== null) {
        presentAuthoritativeCredentialSafeStop(
          kind,
          name,
          authoritativeSafeStop.safeStop,
          true,
        );
        return;
      }

      try {
        const { connections } = await opts.runList();
        if (!checkStillCurrent()) {
          releaseClaimedLease();
          return;
        }
        state.connections = [...connections];
        state.loading = false;
        state.error = null;
        const latest = state.connections.find((connection) =>
          connection.kind === kind && connection.name === name);
        const changed = editorAtStart === null
          || latest === undefined
          || connectionRevisionChanged(editorAtStart, latest);
        if (changed) {
          state.dialog.credentialRotationOwnership = null;
          state.dialog.credentialCorrection = null;
          state.dialog.externalChange = {
            kind,
            name,
            phase: latest === undefined ? 'removed' : 'changed',
            reloading: false,
            error: null,
          };
          convergence.notifyCredentialRotated({ kind, name });
          releaseCredentialRotationOwnership(false);
        } else if (!hasActionableCredentialRotationDraft()) {
          // This successor still owned the pending server observation after
          // its local replacement was cleared. Once the server is idle and
          // the row is unchanged, yield instead of parking an unusable lease
          // ahead of another tab that still has a replacement to verify.
          state.dialog.credentialRotationOwnership = null;
          releaseCredentialRotationOwnership(true);
        } else {
          announceCredentialRotationOwnership(kind, name);
          ownership.phase = 'available';
          ownership.error = null;
        }
        renderPreservingActiveField();
        syncSubmitDisabled();
      } catch {
        if (!checkStillCurrent()) {
          releaseClaimedLease();
          return;
        }
        announceCredentialRotationOwnership(kind, name);
        ownership.phase = 'unconfirmed';
        ownership.automaticTakeover = true;
        ownership.error = 'The server is idle, but Recued could not verify that this editor still matches the saved connection. It will check again after reconnecting.';
        renderPreservingActiveField();
        syncSubmitDisabled();
      }
    })().finally(() => {
      if (credentialRotationActivityCheck === check) {
        credentialRotationActivityCheck = null;
      }
    });
    credentialRotationActivityCheck = check;
    return check.promise;
  };

  /** Re-read after a sibling hint/focus without replacing the open form. An
   * exact signal blocks its matching editor immediately; a generic focus hint
   * blocks only after the server revision proves the row changed. */
  const reconcileCredentialRotationTabs = async (
    hint: CredentialRotationTabHint,
  ): Promise<void> => {
    if (hint.type === 'server_capability_resolved') {
      // The exact channel message is advisory. Boot independently repeats the
      // server read and projects only that authoritative result through
      // server-update continuity; this panel never trusts the hint directly.
      return;
    }
    if (hint.type === 'server_update_progress') {
      if (state.dialog.stage === 'form') {
        if (hint.progress !== null) {
          state.dialog.error = serverUpdateEditorPauseCopy(hint.progress);
        } else if (
          state.dialog.error?.startsWith(
            SERVER_UPDATE_EDITOR_PAUSE_PREFIX,
          ) === true
        ) {
          state.dialog.error = null;
        }
        renderPreservingActiveField();
        syncSubmitDisabled();
      }
      // Boot projects this privacy-safe signal into the targeted recovery
      // callout. The direct hint only protects an already-open form.
      return;
    }
    if (hint.type === 'credential_rotation_safe_stopped') {
      await reconcileCredentialRotationSafeStop(
        hint.kind,
        hint.name,
        true,
      );
      return;
    }
    if (hint.type === 'credential_rotation_safe_stop_resolved') {
      const exactEditor = exactOpenEditor(hint.kind, hint.name);
      const hadConfirmedStop = (
        state.credentialRotationRecovery?.kind === hint.kind
        && state.credentialRotationRecovery.name === hint.name
        && hasCredentialRegenerationSafeStop(
          state.credentialRotationRecovery.correction,
        )
      ) || (
        exactEditor
        && hasCredentialRegenerationSafeStop(
          state.dialog.credentialCorrection,
        )
      );
      await reconcileCredentialRotationSafeStop(
        hint.kind,
        hint.name,
        true,
      );
      if (
        hadConfirmedStop
        && exactOpenEditor(hint.kind, hint.name)
        && state.dialog.credentialCorrection === null
        && state.credentialRotationRecovery?.phase !== 'handoff'
      ) {
        const nextStep = hasActionableCredentialRotationDraft()
          ? 'verify_replacement' as const
          : 'check_saved_connection' as const;
        state.dialog.credentialSafeStopClosureNotice = {
          kind: hint.kind,
          name: hint.name,
          nextStep,
        };
        credentialRotationResolvedSafeStopEditor = {
          key: connectionRowKey(hint.kind, hint.name),
          dialogGeneration: dialogGen,
        };
        renderPreservingActiveField();
        syncSubmitDisabled();
        focusGuideTarget(
          nextStep === 'verify_replacement'
            ? SUBMIT_SELECTOR
            : SAFE_STOP_CHECK_SAVED_SELECTOR,
        );
      }
      return;
    }
    if (hint.type === 'reconcile') {
      const openKind = state.dialog.stage === 'form'
        && state.dialog.mode === 'edit'
        ? state.dialog.kind
        : null;
      const openName = openKind === null
        ? null
        : state.dialog.values.name ?? null;
      if (
        openKind !== null
        && openName !== null
        && exactOpenEditor(openKind, openName)
        && (
          state.dialog.credentialRotationOwnership === null
          || isCrossTabCredentialSafeStopOwnership(
            state.dialog.credentialRotationOwnership,
            openKind,
            openName,
          )
        )
      ) {
        // A storage pulse carries no identity. Re-read only this already-open
        // editor, keeping connection names out of persistent browser storage.
        await reconcileCredentialRotationSafeStop(
          openKind,
          openName,
          false,
        );
      } else {
        const recovery = state.credentialRotationRecovery;
        if (
          recovery !== null
          && (
            isCrossTabCredentialSafeStopRecovery(
              recovery,
              recovery.kind,
              recovery.name,
            )
            || hasCredentialRegenerationSafeStop(recovery.correction)
          )
        ) {
          await reconcileCredentialRotationSafeStop(
            recovery.kind,
            recovery.name,
            false,
          );
        }
      }
    }
    if (hint.type === 'credential_rotation_started') {
      invalidateCredentialRotationSafeStopCheckFor(
        hint.kind,
        hint.name,
      );
      if (
        credentialRotationResolvedSafeStopEditor?.key
          === connectionRowKey(hint.kind, hint.name)
      ) credentialRotationResolvedSafeStopEditor = null;
      clearCredentialRotationSafeStopPresentation(
        hint.kind,
        hint.name,
        true,
      );
    }
    if (hint.type === 'credential_rotated') {
      invalidateCredentialRotationSafeStopCheckFor(
        hint.kind,
        hint.name,
      );
      if (
        credentialRotationResolvedSafeStopEditor?.key
          === connectionRowKey(hint.kind, hint.name)
      ) credentialRotationResolvedSafeStopEditor = null;
    }
    const startedForExactEditor = hint.type === 'credential_rotation_started'
      && exactOpenEditor(hint.kind, hint.name);
    const startedForRecovery = hint.type === 'credential_rotation_started'
      && state.credentialRotationRecovery?.kind === hint.kind
      && state.credentialRotationRecovery.name === hint.name;
    if (startedForExactEditor || startedForRecovery) {
      credentialRotationStartedSignalGeneration += 1;
    }
    const freshStartRecoveryAtSignal = startedForRecovery
      && isFreshStartCredentialRotationRecovery(
        state.credentialRotationRecovery,
      )
      ? state.credentialRotationRecovery
      : null;
    if (freshStartRecoveryAtSignal !== null) {
      // An exact start signal is newer than the unchanged snapshot that made
      // the empty-draft receipt actionable. Revoke the action synchronously so
      // the stale tab never continues to promise a clear path while a sibling
      // owns the next provider check. Closed views retain a handoff receipt;
      // an already-open editor uses its more specific ownership warning.
      state.credentialRotationRecovery = startedForExactEditor
        ? null
        : {
            ...freshStartRecoveryAtSignal,
            phase: 'restart_handoff',
          };
      if (state.dialog.stage !== 'form') render();
    }
    if (
      hint.type === 'credential_rotation_started'
      && exactOpenEditor(hint.kind, hint.name)
      && state.dialog.externalChange === null
      && credentialRotationOwnershipLease?.key
        !== connectionRowKey(hint.kind, hint.name)
    ) {
      invalidateCredentialRotationActivityCheck();
      clearResumableCredentialRotationRecovery(hint.kind, hint.name);
      state.dialog.credentialRotationOwnership = {
        kind: hint.kind,
        name: hint.name,
        phase: 'active',
        automaticTakeover:
          opts.credentialRotationTabConvergence?.supportsOwnershipLeases === true
          && hasActionableCredentialRotationDraft(),
        error: null,
      };
      renderPreservingActiveField();
      syncSubmitDisabled();
      scheduleCredentialRotationSuccessorPoll();
      return;
    }
    if (hint.type === 'credential_rotation_released') {
      if (
        exactOpenEditor(hint.kind, hint.name)
        && state.dialog.externalChange === null
        && state.dialog.credentialRotationOwnership?.kind === hint.kind
        && state.dialog.credentialRotationOwnership.name === hint.name
        && credentialRotationOwnershipLease?.key
          !== connectionRowKey(hint.kind, hint.name)
      ) {
        state.dialog.credentialRotationOwnership.phase = 'active';
        state.dialog.credentialRotationOwnership.error = null;
        renderPreservingActiveField();
        syncSubmitDisabled();
        void checkCredentialRotationOwnership();
      }
      return;
    }
    const freshStartAtStart = isFreshStartCredentialRotationRecovery(
      state.credentialRotationRecovery,
    )
      ? state.credentialRotationRecovery
      : null;
    const exactKey = hint.type === 'credential_rotated'
      ? connectionRowKey(hint.kind, hint.name)
      : null;
    const recoveryAtStart = hint.type === 'credential_rotated'
      && state.credentialRotationRecovery?.kind === hint.kind
      && state.credentialRotationRecovery.name === hint.name
      && (
        state.credentialRotationRecovery.phase === 'handoff'
        || state.credentialRotationRecovery.phase === 'handoff_waiting'
        || state.credentialRotationRecovery.phase === 'failed'
        || state.credentialRotationRecovery.phase === 'not_received'
        || state.credentialRotationRecovery.phase === 'superseded'
      )
      ? state.credentialRotationRecovery
      : null;
    const recoveryMarkerAtStart = recoveryAtStart === null
      ? null
      : opts.credentialRotationContinuity?.read() ?? null;
    const recoveryRowAtStart = recoveryAtStart === null
      ? undefined
      : state.connections.find((connection) =>
          connection.kind === recoveryAtStart.kind
          && connection.name === recoveryAtStart.name);
    const dialogAtStart = dialogGen;
    const editorAtStart = editorRevision;
    const exactEditorAtStart = hint.type === 'credential_rotated'
      && exactOpenEditor(hint.kind, hint.name);
    // A newer hint may overtake the read started by an explicit Reload latest.
    // Carry that consent forward so the newer authoritative snapshot completes
    // the requested discard instead of leaving `reloading` wedged forever.
    const reloadConsentAtStart = editorAtStart !== null
      && state.dialog.editingId === editorAtStart.key
      && state.dialog.externalChange?.reloading === true;
    if (
      hint.type === 'reconcile'
      && (
        state.dialog.credentialRotationOwnership?.phase === 'active'
        || state.dialog.credentialRotationOwnership?.phase === 'pending'
        || state.dialog.credentialRotationOwnership?.phase === 'unconfirmed'
      )
      && state.dialog.credentialRotationOwnership.automaticTakeover
    ) {
      // Background timers may be throttled. Focus/visibility/reconnect is a
      // safe opportunity to attempt the same non-waiting election immediately;
      // the list reconciliation below still runs in case the row already won.
      void checkCredentialRotationOwnership(false);
    }
    if (
      exactEditorAtStart
      && state.dialog.credentialRotationOwnership !== null
      && exactKey === connectionRowKey(
        state.dialog.credentialRotationOwnership.kind,
        state.dialog.credentialRotationOwnership.name,
      )
    ) {
      invalidateCredentialRotationActivityCheck();
      state.dialog.credentialRotationOwnership = null;
      releaseCredentialRotationOwnership(false);
    }
    if (exactEditorAtStart && !reloadConsentAtStart) {
      clearResumableCredentialRotationRecovery(hint.kind, hint.name);
      state.dialog.credentialCorrection = null;
      state.dialog.externalChange = {
        kind: hint.kind,
        name: hint.name,
        phase: 'checking',
        reloading: false,
        error: null,
      };
      renderPreservingActiveField();
      syncSubmitDisabled();
    }

    const gen = ++loadGeneration;
    try {
      const response = await opts.runList();
      const { connections } = response;
      if (disposed || gen !== loadGeneration) return;
      state.connections = [...connections];
      state.loading = false;
      state.error = null;
      clearCredentialSafeStopForMissingConnection(connections);
      applyCredentialSafeStopDiscovery(response, connections);
      applyPostSafeStopVerificationDiscovery(response, connections);

      let newlyOpenedRestartEditorBecameStale = false;
      if (
        freshStartAtStart !== null
        && isFreshStartCredentialRotationRecovery(
          state.credentialRotationRecovery,
        )
        && state.credentialRotationRecovery.kind === freshStartAtStart.kind
        && state.credentialRotationRecovery.name === freshStartAtStart.name
        && state.credentialRotationRecovery.baselineUpdatedAt
          === freshStartAtStart.baselineUpdatedAt
      ) {
        const latestRestartRow = connections.find((connection) =>
          connection.kind === freshStartAtStart.kind
          && connection.name === freshStartAtStart.name);
        const awaitingServerUpdateBaseline =
          hint.type === 'reconcile'
          && freshStartAtStart.returnedFromServerUpdate === true
          && freshStartAtStart.baselineUpdatedAt === undefined;
        if (awaitingServerUpdateBaseline && latestRestartRow === undefined) {
          state.credentialRotationRecovery = {
            kind: freshStartAtStart.kind,
            name: freshStartAtStart.name,
            phase: 'superseded',
            returnedFromServerUpdate: true,
          };
        } else if (
          awaitingServerUpdateBaseline
          && typeof latestRestartRow?.updated_at === 'number'
          && Number.isSafeInteger(latestRestartRow.updated_at)
        ) {
          // The first return read may have failed while the updated server was
          // restarting. This reconnect list is the first authoritative row
          // revision, not evidence that the row changed. Adopt it so the
          // explicit return can continue into the normal activity + later-list
          // preflight instead of falsely reporting a sibling overwrite.
          state.credentialRotationRecovery = {
            ...state.credentialRotationRecovery,
            phase:
              state.credentialRotationRecovery.phase === 'restart_checking'
                ? 'restart_waiting'
                : state.credentialRotationRecovery.phase,
            baselineUpdatedAt: latestRestartRow.updated_at,
          };
        } else if (
          !awaitingServerUpdateBaseline
          && (
            freshStartAtStart.baselineUpdatedAt === undefined
            || latestRestartRow?.updated_at
              !== freshStartAtStart.baselineUpdatedAt
          )
        ) {
          state.credentialRotationRecovery = {
            kind: freshStartAtStart.kind,
            name: freshStartAtStart.name,
            phase: 'superseded',
          };
        }
      } else if (
        freshStartAtStart !== null
        && state.credentialRotationRecovery === null
        && !state.dialog.saving
        && editorRevision !== null
        && editorRevision !== editorAtStart
        && editorRevision.key === connectionRowKey(
          freshStartAtStart.kind,
          freshStartAtStart.name,
        )
        && editorRevision.updatedAt
          === freshStartAtStart.baselineUpdatedAt
        && exactOpenEditor(
          freshStartAtStart.kind,
          freshStartAtStart.name,
        )
      ) {
        const latestRestartRow = connections.find((connection) =>
          connection.kind === freshStartAtStart.kind
          && connection.name === freshStartAtStart.name);
        if (
          freshStartAtStart.baselineUpdatedAt === undefined
          || latestRestartRow?.updated_at
            !== freshStartAtStart.baselineUpdatedAt
        ) {
          // The owner used Start fresh while this authoritative read was in
          // flight. Preserve any new memory-only input, but block the editor
          // rather than landing the later row silently behind it.
          state.credentialRotationRecovery = {
            kind: freshStartAtStart.kind,
            name: freshStartAtStart.name,
            phase: 'superseded',
          };
          state.dialog.credentialRotationOwnership = null;
          state.dialog.credentialCorrection = null;
          state.dialog.externalChange = {
            kind: freshStartAtStart.kind,
            name: freshStartAtStart.name,
            phase: latestRestartRow === undefined ? 'removed' : 'changed',
            reloading: false,
            error: null,
          };
          releaseCredentialRotationOwnership(false);
          newlyOpenedRestartEditorBecameStale = true;
        }
      }

      const recoveryNow = state.credentialRotationRecovery;
      const recoveryMarkerNow = recoveryAtStart === null
        ? null
        : opts.credentialRotationContinuity?.read() ?? null;
      const latestRecoveryRow = recoveryAtStart === null
        ? undefined
        : connections.find((connection) =>
            connection.kind === recoveryAtStart.kind
            && connection.name === recoveryAtStart.name);
      const recoveryBroadcastShowsNewerState = recoveryAtStart !== null
        && (
          recoveryMarkerAtStart?.baselineUpdatedAt !== undefined
            ? latestRecoveryRow === undefined
              || (
                latestRecoveryRow.updated_at !== undefined
                && latestRecoveryRow.updated_at
                  !== recoveryMarkerAtStart.baselineUpdatedAt
              )
            : recoveryMarkerAtStart !== null
              ? latestRecoveryRow === undefined
                || (
                  latestRecoveryRow.updated_at !== undefined
                  && latestRecoveryRow.updated_at
                    > recoveryMarkerAtStart.startedAt
                )
              : recoveryRowAtStart === undefined
                ? latestRecoveryRow !== undefined
                : latestRecoveryRow === undefined
                  || connectionRevisionChanged(
                    connectionEditorRevision(recoveryRowAtStart),
                    latestRecoveryRow,
                  )
        );
      const sameRecoveryMarkerLineage = recoveryMarkerAtStart === null
        ? recoveryMarkerNow === null
        : recoveryMarkerNow === null
          || (
            recoveryMarkerNow.attemptId === recoveryMarkerAtStart.attemptId
            && recoveryMarkerNow.kind === recoveryMarkerAtStart.kind
            && recoveryMarkerNow.name === recoveryMarkerAtStart.name
          );
      if (
        recoveryAtStart !== null
        && hint.type === 'credential_rotated'
        && recoveryNow?.kind === hint.kind
        && recoveryNow.name === hint.name
        && (
          recoveryNow.phase === 'handoff'
          || recoveryNow.phase === 'handoff_waiting'
          || recoveryNow.phase === 'failed'
          || recoveryNow.phase === 'not_received'
          || recoveryNow.phase === 'superseded'
        )
        && recoveryBroadcastShowsNewerState
        && sameRecoveryMarkerLineage
      ) {
        if (
          recoveryMarkerAtStart !== null
          && recoveryMarkerAtStart.kind === hint.kind
          && recoveryMarkerAtStart.name === hint.name
        ) {
          opts.credentialRotationContinuity?.retire(
            recoveryMarkerAtStart.attemptId,
          );
        }
        cancelCredentialRotationPoll();
        state.credentialRotationRecovery = {
          kind: hint.kind,
          name: hint.name,
          phase: 'superseded',
        };
      }

      const editorStillExact = editorAtStart !== null
        && dialogAtStart === dialogGen
        && state.dialog.mode === 'edit'
        && state.dialog.editingId === editorAtStart.key
        && editorRevision === editorAtStart;
      let editorBecameStale = false;
      if (editorStillExact) {
        const latest = state.connections.find(
          (connection) => connectionRowKey(connection.kind, connection.name)
            === editorAtStart.key,
        );
        if (reloadConsentAtStart) {
          if (latest === undefined) {
            const currentChange = state.dialog.externalChange;
            if (currentChange !== null) {
              currentChange.phase = 'removed';
              currentChange.reloading = false;
              currentChange.error = null;
            }
            render();
          } else {
            if (
              state.credentialRotationRecovery?.kind === latest.kind
              && state.credentialRotationRecovery.name === latest.name
            ) state.credentialRotationRecovery = null;
            openEditConnection(latest.kind, latest.name);
          }
          return;
        }
        const exactSignalForEditor = exactKey === editorAtStart.key;
        if (
          exactSignalForEditor
          || latest === undefined
          || connectionRevisionChanged(editorAtStart, latest)
        ) {
          const [kind, ...nameParts] = editorAtStart.key.split('/');
          state.dialog.credentialCorrection = null;
          state.dialog.externalChange = {
            kind: kind as ConnectionKind,
            name: nameParts.join('/'),
            phase: latest === undefined ? 'removed' : 'changed',
            reloading: false,
            error: null,
          };
          state.dialog.credentialRotationOwnership = null;
          clearResumableCredentialRotationRecovery(
            kind as ConnectionKind,
            nameParts.join('/'),
          );
          releaseCredentialRotationOwnership(false);
          editorBecameStale = true;
        } else if (state.dialog.externalChange?.phase === 'checking') {
          // Only an exact signal creates `checking`, and exact signals always
          // take the stale branch above. Keep this defensive cleanup for a
          // malformed/mixed-version view rather than wedging the editor.
          state.dialog.externalChange = null;
        }
      }

      // A form for another row keeps its DOM/focus while the hidden list state
      // refreshes. List-only and newly-stale views repaint immediately.
      if (
        state.dialog.stage !== 'form'
        || editorBecameStale
        || newlyOpenedRestartEditorBecameStale
      ) {
        renderPreservingActiveField();
        if (editorBecameStale || newlyOpenedRestartEditorBecameStale) {
          syncSubmitDisabled();
        }
      }
    } catch {
      if (disposed || gen !== loadGeneration) return;
      state.loading = false;
      if (reloadConsentAtStart && dialogAtStart === dialogGen) {
        const currentChange = state.dialog.externalChange;
        if (currentChange !== null) {
          currentChange.phase = 'unconfirmed';
          currentChange.reloading = false;
          currentChange.error = 'The latest connection could not be loaded. Your draft is still in this tab; reconnect and try again.';
          renderPreservingActiveField();
          syncSubmitDisabled();
        }
      } else if (
        exactEditorAtStart
        && dialogAtStart === dialogGen
        && hint.type === 'credential_rotated'
        && exactOpenEditor(hint.kind, hint.name)
      ) {
        state.dialog.credentialCorrection = null;
        state.dialog.externalChange = {
          kind: hint.kind,
          name: hint.name,
          phase: 'unconfirmed',
          reloading: false,
          error: 'Recued could not read the latest server state. Reconnect, then reload before saving.',
        };
        renderPreservingActiveField();
        syncSubmitDisabled();
      }
      // Generic focus reconciliation is best-effort; the existing list stays
      // usable and the server-side expected revision still rejects stale saves.
    }
  };

  /** Explicit discard boundary. Until this action succeeds the old form values
   * (including any secret) remain untouched and every save stays blocked. */
  const reloadStaleEditor = async (): Promise<void> => {
    const change = state.dialog.externalChange;
    if (change === null || change.reloading || state.dialog.saving) return;
    if (change.phase === 'removed') {
      resetDialog();
      render();
      return;
    }
    const expectedDialogGen = dialogGen;
    change.reloading = true;
    change.error = null;
    renderPreservingActiveField();
    const gen = ++loadGeneration;
    try {
      const { connections } = await opts.runList();
      if (
        disposed
        || gen !== loadGeneration
        || expectedDialogGen !== dialogGen
        || state.dialog.externalChange !== change
      ) return;
      state.connections = [...connections];
      state.loading = false;
      state.error = null;
      const latest = state.connections.find((connection) =>
        connection.kind === change.kind && connection.name === change.name);
      if (latest === undefined) {
        change.phase = 'removed';
        change.reloading = false;
        render();
        return;
      }
      if (
        state.credentialRotationRecovery?.kind === change.kind
        && state.credentialRotationRecovery.name === change.name
      ) state.credentialRotationRecovery = null;
      // `openEditConnection` rebuilds from this authoritative safe view and
      // clears every credential field. The owner explicitly chose that discard.
      openEditConnection(change.kind, change.name);
    } catch {
      if (
        disposed
        || gen !== loadGeneration
        || expectedDialogGen !== dialogGen
        || state.dialog.externalChange !== change
      ) return;
      state.loading = false;
      change.phase = 'unconfirmed';
      change.reloading = false;
      change.error = 'The latest connection could not be loaded. Your draft is still in this tab; reconnect and try again.';
      render();
    }
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
      const rotationMarker = opts.credentialRotationContinuity?.read() ?? null;
      const rotationRecovery = reconcileCredentialRotation(false);
      try {
        const response = await opts.runList();
        const { connections } = response;
        if (disposed) return;
        if (gen === loadGeneration) {
          state.connections = [...connections];
          state.loading = false;
          state.error = null;
          clearCredentialSafeStopForMissingConnection(connections);
          applyCredentialSafeStopDiscovery(response, connections);
          applyPostSafeStopVerificationDiscovery(response, connections);
          render();
        }
      } catch (err) {
        if (disposed) return;
        if (gen === loadGeneration) {
          state.loading = false;
          state.error = errMessage(err);
          render();
        }
      }
      // A passive sibling/focus read may supersede this list generation, but
      // `whenLoaded()` is also the provider-schema readiness boundary. Still
      // await recovery + packs so a deep-linked form cannot open with an
      // under-hydrated scope/default projection merely because another tab
      // rotated a credential during boot.
      await rotationRecovery;
      const recoveredRotation = rotationMarker !== null
        && state.credentialRotationRecovery === null
        && state.dialog.recentProbe?.purpose === 'credential_rotation'
        && state.dialog.recentProbe.kind === rotationMarker.kind
        && state.dialog.recentProbe.name === rotationMarker.name;
      if (!disposed && gen === loadGeneration && recoveredRotation) {
        try {
          // The first list and the result again intentionally start together
          // so a slow provider cannot block the page. Once success is known,
          // take one causally-later snapshot so an old pre-swap list response
          // cannot leave the confirmed connection looking stale.
          const response = await opts.runList();
          const { connections } = response;
          if (!disposed && gen === loadGeneration) {
            state.connections = [...connections];
            state.error = null;
            clearCredentialSafeStopForMissingConnection(connections);
            applyCredentialSafeStopDiscovery(response, connections);
            applyPostSafeStopVerificationDiscovery(response, connections);
            const exactRecoveredEditor = state.dialog.stage === 'form'
              && state.dialog.mode === 'edit'
              && state.dialog.editingId === connectionRowKey(
                rotationMarker.kind,
                rotationMarker.name,
              );
            if (state.dialog.stage !== 'form') {
              render();
            } else if (exactRecoveredEditor) {
              renderPreservingActiveField();
              syncSubmitDisabled();
            }
          }
        } catch {
          // The secret-free success receipt remains authoritative. A later
          // manual refresh or reconnect can restore the updated row view.
        }
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
  // navigation away before the read returns is ignored (generation + identity
  // guards). The caller is selected from the active schema's trigger field.
  const hydrateMatchPatterns = async (
    kind: ConnectionKind,
    name: string,
    editingId: string,
  ): Promise<void> => {
    const run = opts.runGetMatchPatterns;
    if (!run) return;
    const expectedDialogGeneration = dialogGen;
    let patterns: MessageMatchPattern[];
    try {
      patterns = (await run({ name, kind })).match_patterns;
    } catch {
      return; // best-effort — the editor stays empty, the form still works
    }
    // Stale read — the user cancelled or opened a different dialog.
    if (
      dialogGen !== expectedDialogGeneration
      || state.dialog.stage !== 'form'
      || state.dialog.mode !== 'edit'
      || state.dialog.editingId !== editingId
      || state.dialog.externalChange !== null
    ) return;
    const baseKey = 'config.match_patterns';
    const patternPrefix = `${baseKey}.`;
    const baselineValues = dialogDraftBaseline?.dialogGeneration === dialogGen
      ? dialogDraftBaseline.values
      : {};
    // The form is usable while this best-effort read is pending. Preserve any
    // owner-authored pattern field as an override instead of letting the late
    // response erase it and then bless the replacement as clean.
    const ownerOverrides = new Map<string, string>();
    const candidateKeys = new Set([
      ...Object.keys(state.dialog.values),
      ...Object.keys(baselineValues),
    ]);
    for (const key of candidateKeys) {
      if (
        key.startsWith(patternPrefix)
        && (state.dialog.values[key] ?? '') !== (baselineValues[key] ?? '')
      ) ownerOverrides.set(key, state.dialog.values[key] ?? '');
    }
    const hydratedPatternValues: ConnectionFormValues = {};
    patterns.forEach((pattern, index) => {
      hydratedPatternValues[`${baseKey}.${index}.kind`] = pattern.kind;
      hydratedPatternValues[`${baseKey}.${index}.value`] = pattern.value;
      hydratedPatternValues[`${baseKey}.${index}.mode`] =
        pattern.kind === 'content' ? (pattern.mode ?? '') : '';
    });
    const next = { ...state.dialog.values };
    for (const k of Object.keys(next)) {
      if (k.startsWith(patternPrefix)) delete next[k];
    }
    Object.assign(next, hydratedPatternValues);
    for (const [key, value] of ownerOverrides) next[key] = value;
    state.dialog.values = next;
    updateDialogDraftBaselineValues((baselineValues) => {
      for (const key of Object.keys(baselineValues)) {
        if (key.startsWith(patternPrefix)) delete baselineValues[key];
      }
      Object.assign(baselineValues, hydratedPatternValues);
      return baselineValues;
    });
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
    if (state.dialog.saving || state.dialog.oauthInFlight) return;
    const serverUpdateProgress = opts.credentialRotationTabConvergence
      ?.readServerUpdateProgress() ?? null;
    if (serverUpdateProgress !== null) {
      state.dialog.error = serverUpdateEditorPauseCopy(serverUpdateProgress);
      renderPreservingActiveField();
      syncSubmitDisabled();
      return;
    }
    // A sibling/focus reconciliation never discards the draft, but it does
    // revoke this editor's authority to write until the owner reloads latest.
    if (state.dialog.externalChange !== null) {
      syncSubmitDisabled();
      return;
    }
    if (
      state.dialog.credentialRotationOwnership !== null
      && state.dialog.credentialRotationOwnership.phase !== 'available'
    ) {
      syncSubmitDisabled();
      return;
    }
    if (hasCredentialRegenerationSafeStop(state.dialog.credentialCorrection)) {
      focusGuideTarget(CREDENTIAL_CORRECTION_PANEL_SELECTOR);
      return;
    }
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
    const validationIssue = connectionFormValidationIssue(
      schema,
      dialog.values,
      state.dynamicOptions,
      dialog.mode,
    );
    if (validationIssue !== null) {
      dialog.credentialCorrection = null;
      dialog.error = validationIssue.message;
      render();
      focusFirstConnectionFormIssue();
      return;
    }
    const payload = projectConnectionPayload(
      schema,
      dialog.values,
      dialog.kind,
      dialog.subtype,
    );
    // granted-scopes — carry the vendor-granted set captured during the dance
    // (dialog state, set from completeVendorOAuth; not a form field) into the
    // create payload or the verified-rotation rpc. Empty/absent → omitted →
    // server preserves any existing set.
    if (dialog.oauthGrantedScopes && dialog.oauthGrantedScopes.length > 0) {
      payload.granted_scopes = [...dialog.oauthGrantedScopes];
    }
    const isEdit = dialog.mode === 'edit';
    const expectedUpdatedAt = isEdit
      && editorRevision?.key === dialog.editingId
      ? editorRevision.updatedAt
      : undefined;
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
    if (patch.auth !== undefined) {
      clearResumableCredentialRotationRecovery(dialog.kind, payload.name);
      invalidateCredentialRotationSafeStopCheckFor(
        dialog.kind,
        payload.name,
      );
    }
    // D-192 M4c-UI — snapshot the messenger triggers to write NOW (before any
    // await), gated on the editor being trustworthy. `null` → leave stored
    // triggers untouched (see `compileTriggerWrite`).
    const triggerWrite = compileTriggerWrite(schema, dialog.values, isEdit);
    // Claim a dialog generation — a navigation during the in-flight rpc bumps
    // it, marking this completion stale so it can't reset the newer dialog.
    const gen = ++dialogGen;
    // Submit advances the async-staleness generation without opening a new
    // editor. Keep the original clean baseline attached to this generation so
    // reload/route protection remains active while the write is pending and
    // after a failed write. Durable success resets the dialog (and baseline).
    if (
      dialogDraftBaseline !== null
      && dialogDraftBaseline.dialogGeneration === gen - 1
    ) {
      dialogDraftBaseline = {
        ...dialogDraftBaseline,
        dialogGeneration: gen,
      };
    }
    submitInFlight = true;
    dialog.saving = true;
    dialog.error = null;
    dialog.credentialCorrection = null;
    dialog.credentialSafeStopClosureNotice = null;
    render();
    let submittedRotationAttemptId: string | null = null;
    let submittedRotationIdentity: {
      kind: ConnectionKind;
      name: string;
    } | null = null;
    let ownershipBacksExistingContinuity = false;
    try {
      let probeStatus: string | undefined;
      let credentialVerification: ConnectionCredentialVerification | undefined;
      // The saved connection's CANONICAL name (the server trims / canonicalizes
      // on enroll) — used for the trigger write so a padded create name can't
      // 404 the follow-up `setMatchPatterns`.
      let savedName = payload.name;
      if (isEdit) {
        if (patch.auth !== undefined) {
          if (opts.runRotateCredentials === undefined) {
            throw new Error(ROTATION_UNAVAILABLE_COPY);
          }
          const rotationIdentity = { kind: dialog.kind, name: payload.name };
          const convergence = opts.credentialRotationTabConvergence;
          if (convergence?.supportsOwnershipLeases === true) {
            const lease = await convergence.claimCredentialRotationOwnership(
              rotationIdentity,
            );
            if (disposed || gen !== dialogGen) {
              lease?.release();
              return;
            }
            if (lease !== null && dialog.externalChange !== null) {
              if (credentialRotationOwnershipLease?.lease === lease) {
                releaseCredentialRotationOwnership(false);
              } else {
                lease.release();
              }
              dialog.saving = false;
              renderPreservingActiveField();
              syncSubmitDisabled();
              return;
            }
            if (lease === null) {
              dialog.saving = false;
              dialog.credentialRotationOwnership = {
                ...rotationIdentity,
                phase: 'active',
                automaticTakeover: true,
                error: null,
              };
              renderPreservingActiveField();
              syncSubmitDisabled();
              scheduleCredentialRotationSuccessorPoll();
              return;
            }
            rememberCredentialRotationOwnership(
              rotationIdentity.kind,
              rotationIdentity.name,
              lease,
            );
          }
          submittedRotationIdentity = rotationIdentity;
          const attemptId = (
            opts.credentialRotationAttemptId
            ?? defaultCredentialRotationAttemptId
          )();
          if (!CONNECTION_CREDENTIAL_ROTATION_ATTEMPT_ID_REGEX.test(attemptId)) {
            throw new Error(ROTATION_CONTINUITY_UNAVAILABLE_COPY);
          }
          const continuityWrite = opts.credentialRotationContinuity?.write({
            attemptId,
            kind: dialog.kind,
            name: payload.name,
            ...(expectedUpdatedAt !== undefined
              ? { baselineUpdatedAt: expectedUpdatedAt }
              : {}),
          });
          if (continuityWrite === 'occupied') {
            const existingMarker = opts.credentialRotationContinuity?.read()
              ?? null;
            ownershipBacksExistingContinuity = existingMarker !== null
              && existingMarker.kind === rotationIdentity.kind
              && existingMarker.name === rotationIdentity.name;
            throw new Error(ROTATION_CONTINUITY_OCCUPIED_COPY);
          }
          if (continuityWrite !== 'stored') {
            throw new Error(ROTATION_CONTINUITY_UNAVAILABLE_COPY);
          }
          submittedRotationAttemptId = attemptId;
          announceCredentialRotationOwnership(
            rotationIdentity.kind,
            rotationIdentity.name,
          );
          const result = await opts.runRotateCredentials({
            attempt_id: attemptId,
            name: payload.name,
            kind: dialog.kind,
            ...(expectedUpdatedAt !== undefined
              ? { expected_updated_at: expectedUpdatedAt }
              : {}),
            patch: { ...patch, auth: patch.auth },
            ...(dialog.oauthGrantedScopes && dialog.oauthGrantedScopes.length > 0
              ? { granted_scopes: [...dialog.oauthGrantedScopes] }
              : {}),
            ...(triggerWrite !== null ? { match_patterns: triggerWrite } : {}),
          });
          savedName = result.connection.name;
          credentialVerification = result.verification;
          // The server has confirmed the atomic swap. Publish only identity;
          // sibling tabs re-read the row and never receive this credential or
          // this tab's verification receipt.
          opts.credentialRotationTabConvergence?.notifyCredentialRotated({
            kind: dialog.kind,
            name: savedName,
          });
          releaseCredentialRotationOwnership(false);
        } else {
          const { connection } = await opts.runUpdate({
            name: payload.name,
            kind: dialog.kind,
            ...(expectedUpdatedAt !== undefined
              ? { expected_updated_at: expectedUpdatedAt }
              : {}),
            patch,
          });
          savedName = connection.name;
        }
      } else {
        const result = await opts.runEnroll(payload);
        savedName = result.connection.name;
        // Enrollment is the durable completion boundary even if its follow-up
        // probe or this route later disappears. Do not resurrect an already
        // saved provider-app guide on the next mount.
        retireProviderSetupContinuity();
        dialog.setupGuide.resumeAvailable = false;
        dialog.setupGuide.resumeFieldKey = null;
        // Enrollment intentionally commits before health checking so an
        // unreachable service cannot roll back the credential/config the user
        // needs to repair. The button promises a real probe, though, so invoke
        // the same rpc as the row action and surface either its health or its
        // transport-level failure in the retained banner.
        try {
          const { health } = await opts.runProbe({
            name: savedName,
            kind: payload.kind,
          });
          probeStatus = health.status;
        } catch (err) {
          probeStatus = errMessage(err);
        }
      }
      // D-192 M4c-UI — creates and metadata-only edits still use the dedicated
      // merge-write after the connection exists. Credential rotation carries
      // the same snapshot in its isolated candidate so the credential, trigger
      // edit, verification receipt, and durable swap are one outcome.
      if (
        triggerWrite !== null
        && opts.runSetMatchPatterns
        && credentialVerification === undefined
      ) {
        await opts.runSetMatchPatterns({
          name: savedName,
          kind: payload.kind,
          match_patterns: triggerWrite,
        });
      }
      // Stale-completion guard: a cancel / back / new add during the rpc moved
      // the user to a different dialog — don't reset it or drop their input.
      if (disposed || gen !== dialogGen) return;
      if (submittedRotationAttemptId !== null) {
        opts.credentialRotationContinuity?.retire(submittedRotationAttemptId);
      }
      resetDialog();
      const postSaveDialogGen = dialogGen;
      if (credentialVerification !== undefined) {
        state.credentialRotationRecovery = null;
        state.dialog.recentProbe = {
          kind: payload.kind,
          name: savedName,
          status: credentialVerification.status,
          purpose: 'credential_rotation',
          verified_at: credentialVerification.verified_at,
          auth_type: credentialVerification.auth_type,
          ...(credentialVerification.access_expires_at !== undefined
            ? { access_expires_at: credentialVerification.access_expires_at }
            : {}),
        };
      } else if (!isEdit) {
        state.dialog.recentProbe = {
          kind: payload.kind,
          name: savedName,
          status: probeStatus ?? 'unknown',
        };
      }
      // Re-list so the new / patched row appears with its server view.
      await doRefresh();
      // A newly enrolled MCP server is not finished until the owner reviews
      // its live tool list and chooses the generated pack's install scope.
      // Open that consent step directly: this host does not hydrate the
      // resting-state MCP pack badge, so relying on its action would leave the
      // first-party enrollment chain with no reachable commit surface.
      if (
        !disposed
        && dialogGen === postSaveDialogGen
        && !isEdit
        && payload.kind === 'mcp'
        && opts.runMcpPackPreview !== undefined
        && opts.runMcpPackCommit !== undefined
      ) {
        void openMcpPackReview(savedName);
      }
    } catch (err) {
      let presentedError = err;
      let reconcileAfterCatch = false;
      let retireRotationMarker = false;
      let rotationOwnedElsewhere = false;
      let credentialCorrectionToFocus = false;
      const classified = classifyRpcError(err);
      const credentialCorrectionResult = isEdit && patch.auth !== undefined
        ? connectionCredentialCorrectionFromError(
            err,
            schema,
            dialog.values,
          )
        : null;
      const credentialCorrection = credentialCorrectionResult?.state ?? null;
      const credentialSafeStop = hasCredentialRegenerationSafeStop(
        credentialCorrectionResult?.correction,
      );
      if (
        submittedRotationIdentity !== null
        && submittedRotationAttemptId === null
        && !ownershipBacksExistingContinuity
      ) releaseCredentialRotationOwnership(true);
      if (submittedRotationAttemptId !== null) {
        const definitelyNotSent = classified.code === 'server_offline'
          || classified.code === 'server_unresponsive';
        const outcomeUncertain = classified.code === 'connection_lost'
          || classified.code === 'timeout'
          || classified.code === 'transport'
          || classified.code === 'transport_disposed'
          || classified.code === 'credential_rotation_outcome_unknown'
          || classified.code === 'credential_rotation_in_progress';
        if (classified.code === 'credential_rotation_owned_elsewhere') {
          retireRotationMarker = true;
          rotationOwnedElsewhere = true;
          presentedError = new Error(
            'Another tab or paired client is already checking a replacement for this connection.',
          );
        } else if (classified.code === 'unknown_method') {
          retireRotationMarker = true;
          presentedError = new Error(ROTATION_UNAVAILABLE_COPY);
        } else if (definitelyNotSent || !outcomeUncertain) {
          retireRotationMarker = !credentialSafeStop;
        } else if (!disposed) {
          reconcileAfterCatch = true;
          state.credentialRotationRecovery = {
            kind: payload.kind,
            name: payload.name,
            phase: 'waiting',
          };
          if (submittedRotationIdentity !== null) {
            state.dialog.credentialRotationOwnership = {
              ...submittedRotationIdentity,
              phase: 'pending',
              automaticTakeover:
                opts.credentialRotationTabConvergence?.supportsOwnershipLeases === true,
              error: null,
            };
          }
          presentedError = new Error(
            `The replacement outcome is not confirmed yet. Recued will check ${payload.kind}/${payload.name} after reconnecting; do not retry meanwhile.`,
          );
        }
      }
      if (disposed || gen !== dialogGen) return;
      if (retireRotationMarker && submittedRotationAttemptId !== null) {
        opts.credentialRotationContinuity?.retire(submittedRotationAttemptId);
        releaseCredentialRotationOwnership(true);
      }
      state.dialog.saving = false;
      if (
        credentialSafeStop
        && submittedRotationAttemptId !== null
        && credentialCorrectionResult !== null
      ) {
        releaseCredentialRotationOwnership(true);
        state.dialog.credentialRotationOwnership = null;
        state.credentialRotationRecovery = {
          kind: payload.kind,
          name: payload.name,
          phase: 'failed',
          failureReason: 'auth_failed',
          correction: credentialCorrectionResult.correction,
        };
        opts.credentialRotationTabConvergence
          ?.notifyCredentialRotationSafeStopped({
            kind: payload.kind,
            name: payload.name,
          });
      }
      if (
        submittedRotationIdentity !== null
        && submittedRotationAttemptId === null
        && !ownershipBacksExistingContinuity
      ) state.dialog.credentialRotationOwnership = null;
      if (ownershipBacksExistingContinuity) {
        state.dialog.credentialRotationOwnership = {
          ...submittedRotationIdentity!,
          phase: 'pending',
          automaticTakeover:
            opts.credentialRotationTabConvergence?.supportsOwnershipLeases === true,
          error: null,
        };
        reconcileAfterCatch = true;
      }
      if (retireRotationMarker && !rotationOwnedElsewhere) {
        state.dialog.credentialRotationOwnership = null;
      }
      if (
        rotationOwnedElsewhere
        && submittedRotationIdentity !== null
        && state.dialog.editingId === connectionRowKey(
          submittedRotationIdentity.kind,
          submittedRotationIdentity.name,
        )
      ) {
        state.dialog.error = null;
        state.dialog.credentialRotationOwnership = {
          ...submittedRotationIdentity,
          phase: 'active',
          automaticTakeover:
            opts.credentialRotationTabConvergence?.supportsOwnershipLeases === true,
          error: null,
        };
        scheduleCredentialRotationSuccessorPoll();
      } else if (
        isEdit
        && classified.code === 'conflict'
        && state.dialog.editingId === connectionRowKey(payload.kind, payload.name)
      ) {
        // The server CAS is the final guard for a missed/racing browser hint.
        // Keep the complete draft in memory and route through the same explicit
        // reload boundary rather than reducing this to a generic inline error.
        state.dialog.error = null;
        state.dialog.credentialCorrection = null;
        state.dialog.externalChange = {
          kind: payload.kind,
          name: payload.name,
          phase: 'changed',
          reloading: false,
          error: null,
        };
      } else if (credentialCorrection !== null) {
        state.dialog.error = null;
        state.dialog.credentialCorrection = credentialCorrection;
        credentialCorrectionToFocus = true;
      } else {
        state.dialog.error = errMessage(presentedError);
      }
      render();
      if (credentialCorrectionToFocus) focusCredentialCorrection();
      if (credentialSafeStop) {
        void reconcileCredentialRotationSafeStop(
          payload.kind,
          payload.name,
          false,
        );
      }
      if (reconcileAfterCatch) void reconcileCredentialRotation();
    } finally {
      // Release the cross-navigation write lock once the rpc settles, whether
      // this completion was applied or treated as stale.
      submitInFlight = false;
    }
  };

  // ── Per-row probe ─────────────────────────────────────────────
  // ── D-225 Slice 2 — the generated-pack enrollment chain ───────────────
  //
  // `#connections → mcp → create → success` → openMcpPackReview → saveMcpPack
  // → the pack lands, and the owner continues to pack detail to tune it. This
  // panel deliberately never writes a risk/approval ruling: those go through
  // `contract.ownerOperation.*`, which enforces the approval floor and the
  // downgrade confirm.

  /** Open the review and probe the server for what it publishes NOW. */
  const openMcpPackReview = async (name: string): Promise<void> => {
    if (disposed || !opts.runMcpPackPreview) return;
    resetMcpPackGrantSelection();
    state.mcpPackReview = {
      connection: { kind: 'mcp', name },
      loading: true,
      error: null,
      pack_slug: null,
      view: null,
      saving: false,
    };
    render();
    try {
      const { pack_slug, rows } = await opts.runMcpPackPreview({ name, kind: 'mcp' });
      if (disposed || state.mcpPackReview?.connection.name !== name) return;
      mcpPackGrantModel = installGrantModelFromMcpReviewRows(rows);
      mcpPackGrantAccess = mcpPackGrantModel?.defaultAccess ?? 'read';
      state.mcpPackReview = {
        ...state.mcpPackReview,
        loading: false,
        pack_slug,
        view: mcpPackReviewView(rows),
      };
    } catch (err) {
      if (disposed || state.mcpPackReview?.connection.name !== name) return;
      // ⛔ Surfaced, never swallowed into an empty list: zero rows reads as
      // "this server has no tools", and an owner could Save that believing
      // they had reviewed something.
      state.mcpPackReview = {
        ...state.mcpPackReview,
        loading: false,
        error: errMessage(err),
      };
    }
    render();
  };

  /** Install the reviewed pack. */
  const saveMcpPack = async (): Promise<void> => {
    const review = state.mcpPackReview;
    if (!opts.runMcpPackCommit || review === null || review.view === null) return;
    if (review.saving) return;
    // The first-party interactive path must never silently fall back to the
    // headless/absent-scope branch. No tools means no Save; any real review has
    // a derived model and therefore an explicit default or owner choice.
    if (review.view.rows.length === 0) return;
    const installScope = effectiveMcpPackInstallScope();
    if (installScope === null) return;
    state.mcpPackReview = { ...review, saving: true, error: null };
    render();
    try {
      await opts.runMcpPackCommit({
        name: review.connection.name,
        kind: 'mcp',
        // ⚠ The op ids the review ACTUALLY SHOWED. The server compares them
        // against a fresh probe and refuses if its tools changed while the
        // owner was deciding — sending anything else would defeat that.
        reviewed_ops: review.view.reviewed_ops,
        install_scope: installScope,
      });
      if (disposed) return;
      state.mcpPackReview = null;
      resetMcpPackGrantSelection();
      // The pack now exists, so the badge's status is stale — re-list so the
      // row reflects it rather than showing the state that prompted the review.
      try {
        const { connections } = await opts.runList();
        if (!disposed) state.connections = [...connections];
      } catch {
        // Best-effort: the install SUCCEEDED, and failing the whole action over
        // a refresh would tell the owner the opposite of what happened.
      }
      render();
    } catch (err) {
      if (disposed || state.mcpPackReview === null) return;
      // A `conflict` here is the TOCTOU refusal — the message tells the owner
      // to re-review, and the screen stays open so they can.
      state.mcpPackReview = { ...state.mcpPackReview, saving: false, error: errMessage(err) };
      render();
    }
  };

  const closeMcpPackReview = (): void => {
    if (state.mcpPackReview === null) return;
    state.mcpPackReview = null;
    resetMcpPackGrantSelection();
    render();
  };

  const probeRow = async (kind: ConnectionKind, name: string): Promise<void> => {
    const key = connectionRowKey(kind, name);
    if (state.probeInFlight.has(key)) return;
    postSafeStopVerificationGeneration += 1;
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
    const removesProjectedRecovery = state.postSafeStopRecoveries.some(
      (recovery) => recovery.kind === kind && recovery.name === name,
    );
    dc.deleting = true;
    state.deleteInFlight.add(key);
    render();
    try {
      await opts.runDelete({ name, kind, remove_mirror_data: dc.removeMirror });
      if (disposed) return;
      state.deleteInFlight.delete(key);
      state.deleteConfirm = null;
      await doRefresh();
      // Deleting a connection also removes any unresolved post-ack recovery
      // projected for it. Wake this tab's Attention shell and sibling tabs;
      // each consumer re-lists the server before changing its badge or queue.
      if (removesProjectedRecovery) {
        opts.credentialRotationTabConvergence
          ?.notifyPostSafeStopVerificationChanged();
      }
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
        'Recued cannot check what Salesforce can do from here.',
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

  const openEditConnection = (kind: ConnectionKind, name: string): void => {
    const view = state.connections.find(
      (connection) => connection.kind === kind && connection.name === name,
    );
    if (view === undefined) return;
    const rotationMarker = opts.credentialRotationContinuity?.read() ?? null;
    if (
      credentialRotationOwnershipLease !== null
      && (
        rotationMarker === null
        || connectionRowKey(rotationMarker.kind, rotationMarker.name)
          !== credentialRotationOwnershipLease.key
      )
    ) releaseCredentialRotationOwnership(true);
    retireProviderSetupContinuity();
    state.deleteConfirm = null;
    cancelPendingOAuth();
    dialogGen += 1;
    invalidateCredentialRotationActivityCheck();
    invalidateCredentialRotationSafeStopCheck();
    invalidateCredentialSafeStopAcknowledgement();
    const patch = buildConnectionEditDialogPatch(view);
    editorRevision = connectionEditorRevision(view);
    state.dialog = {
      ...initialConnectionsDialogState(),
      oauthCallbackUrl: resolveOAuthCallbackUrlForThisPwa(),
      oauthCallbackAlternateUrl: resolveOAuthCallbackAlternateForThisPwa(),
      ...patch,
    };
    captureDialogDraftBaseline();
    if (
      rotationMarker !== null
      && rotationMarker.kind === kind
      && rotationMarker.name === name
    ) {
      // The editor may open while boot/reconnect recovery is still awaiting
      // the old attempt. Keep any newly entered replacement in memory, but do
      // not let this returned editor race the authoritative outcome.
      state.dialog.credentialRotationOwnership = {
        kind,
        name,
        phase: 'handoff',
        automaticTakeover: false,
        error: null,
      };
    }
    render();
    if (state.dialog.kind === 'notification' && state.dialog.subtype === 'email') {
      void hydrateMailOptions();
    }
    // Trigger values are stripped from ConnectionView. Keep submit fail-closed
    // until the exact notification editor has hydrated them.
    if (
      state.dialog.kind === 'notification'
      && activeSchema()?.fields.some((field) => field.type === 'match-pattern-list') === true
    ) {
      matchPatternsHydrated = false;
      void hydrateMatchPatterns(kind, name, patch.editingId);
    }
  };

  /** Close the acknowledgement journey with one result bound to the exact
   * saved row the paired server checked. Probe first, then list: reversing or
   * parallelizing those reads can make an old row appear to own a new result.
   * The optional revision/correction fields are treated as mixed-version wire
   * input and validated before they influence a resolution or field target. */
  const verifySavedConnectionAfterSafeStop = async (
    kind: ConnectionKind,
    name: string,
  ): Promise<void> => {
    const key = connectionRowKey(kind, name);
    if (state.probeInFlight.has(key)) return;
    const nonnegativeSafeInteger = (value: unknown): number | null =>
      typeof value === 'number'
      && Number.isSafeInteger(value)
      && value >= 0
        ? value
        : null;
    const startingRow = state.connections.find((connection) =>
      connection.kind === kind && connection.name === name);
    const expectedUpdatedAt = nonnegativeSafeInteger(startingRow?.updated_at);
    const generation = ++postSafeStopVerificationGeneration;
    const checkingReceipt = {
      kind,
      name,
      status: 'checking',
      purpose: 'post_safe_stop' as const,
      resolution: 'checking' as const,
    };
    state.dialog.recentProbe = checkingReceipt;
    state.probeInFlight.add(key);
    render();
    const receiptStillCurrent = (): boolean => !disposed
      && generation === postSafeStopVerificationGeneration
      && state.dialog.recentProbe === checkingReceipt;

    try {
      let health: ConnectionHealth | null = null;
      let checkedUpdatedAt: number | null = null;
      let correction: ConnectionCredentialRejectionCorrection | null = null;
      let requestFailure: 'conflict' | 'not_found' | 'request_failed' | null = null;
      try {
        const result = await opts.runProbe({
          kind,
          name,
          ...(expectedUpdatedAt !== null
            ? { expected_updated_at: expectedUpdatedAt }
            : {}),
        });
        if (!receiptStillCurrent()) return;
        const status = result.health?.status;
        if (
          status === 'ok'
          || status === 'auth_failed'
          || status === 'unreachable'
          || status === 'unknown'
        ) health = result.health;
        checkedUpdatedAt = nonnegativeSafeInteger(
          result.connection_updated_at,
        );
        correction = validatedConnectionCredentialRejectionCorrection(
          result.credential_correction,
          kind,
        );
      } catch (error) {
        const classified = classifyRpcError(error);
        requestFailure = classified.code === 'conflict'
          ? 'conflict'
          : classified.code === 'not_found'
            ? 'not_found'
            : 'request_failed';
      }

      if (!receiptStillCurrent()) return;

      // This read is intentionally causally later than the probe response. It
      // binds the result to the row revision the owner will act on and also lets
      // another newly-current safe stop take precedence over this receipt.
      const listGeneration = ++loadGeneration;
      let latest: ConnectionView | undefined;
      let listConfirmed = false;
      let postSafeStopProjectionConfirmed = false;
      try {
        const response = await opts.runList();
        if (!receiptStillCurrent()) return;
        if (listGeneration === loadGeneration) {
          state.connections = [...response.connections];
          state.loading = false;
          state.error = null;
          clearCredentialSafeStopForMissingConnection(response.connections);
          applyCredentialSafeStopDiscovery(response, response.connections);
          postSafeStopProjectionConfirmed =
            applyPostSafeStopVerificationDiscovery(
              response,
              response.connections,
            );
          latest = response.connections.find((connection) =>
            connection.kind === kind && connection.name === name);
          listConfirmed = true;
        }
      } catch {
        // The probe outcome remains useful, but without the causally-later row
        // it cannot become an all-clear or credential-correction target.
      }

      if (!receiptStillCurrent()) return;
      const authoritativeRecovery = postSafeStopProjectionConfirmed
        ? state.postSafeStopRecoveries.find((recovery) =>
            recovery.kind === kind && recovery.name === name)
        : undefined;
      if (authoritativeRecovery !== undefined) {
        // The causally-later list observed a still/newly unresolved lineage for
        // this exact connection. It outranks the just-finished probe receipt;
        // do not briefly claim success or depend on a tab signal to correct it.
        state.dialog.recentProbe = {
          kind,
          name,
          status: authoritativeRecovery.status,
          purpose: 'post_safe_stop',
          resolution: authoritativeRecovery.status === 'auth_failed'
            ? 'reopen'
            : 'retry',
          ...(authoritativeRecovery.credentialCorrection !== undefined
            ? {
                credential_correction:
                  authoritativeRecovery.credentialCorrection,
              }
            : {}),
          ...(authoritativeRecovery.checkedAt !== undefined
            ? { checked_at: authoritativeRecovery.checkedAt }
            : {}),
        };
        opts.credentialRotationTabConvergence
          ?.notifyPostSafeStopVerificationChanged();
        render();
        return;
      }
      const newlyCurrentSafeStop = state.credentialRotationRecovery;
      if (
        newlyCurrentSafeStop?.kind === kind
        && newlyCurrentSafeStop.name === name
        && newlyCurrentSafeStop.phase === 'safe_stopped'
      ) {
        state.dialog.recentProbe = null;
        return;
      }

      const latestUpdatedAt = nonnegativeSafeInteger(latest?.updated_at);
      const resultOwnsLatestRow = listConfirmed
        && latest !== undefined
        && checkedUpdatedAt !== null
        && latestUpdatedAt === checkedUpdatedAt;
      let resolution:
        | 'resolved'
        | 'reopen'
        | 'retry'
        | 'unsupported'
        | 'changed'
        | 'removed';
      if (listConfirmed && latest === undefined) {
        resolution = 'removed';
      } else if (requestFailure === 'conflict') {
        resolution = listConfirmed ? 'changed' : 'retry';
      } else if (requestFailure === 'not_found') {
        resolution = listConfirmed && latest === undefined ? 'removed' : 'retry';
      } else if (requestFailure !== null || health === null) {
        resolution = 'retry';
      } else if (checkedUpdatedAt === null) {
        // The provider check ran, but an older paired server cannot bind its
        // answer to the exact durable row. Do not invite an endless retry loop
        // that cannot become authoritative until that server is updated.
        resolution = 'unsupported';
      } else if (!resultOwnsLatestRow) {
        resolution = listConfirmed
          && latest !== undefined
          && checkedUpdatedAt !== null
          ? 'changed'
          : 'retry';
      } else if (health.status === 'ok') {
        resolution = 'resolved';
      } else if (health.status === 'auth_failed') {
        resolution = 'reopen';
      } else {
        resolution = 'retry';
      }

      const checkedAt = nonnegativeSafeInteger(health?.last_probed_at);
      state.dialog.recentProbe = {
        kind,
        name,
        status: health?.status ?? requestFailure ?? 'request_failed',
        purpose: 'post_safe_stop',
        resolution,
        ...(resolution === 'reopen'
          && correction !== null
          && latest?.auth_type === correction.auth_type
          ? { credential_correction: correction }
          : {}),
        ...(checkedAt !== null ? { checked_at: checkedAt } : {}),
      };
      if (
        (health !== null && checkedUpdatedAt !== null)
        || postSafeStopProjectionConfirmed
      ) {
        opts.credentialRotationTabConvergence
          ?.notifyPostSafeStopVerificationChanged();
      }
      render();
    } finally {
      if (!disposed) {
        state.probeInFlight.delete(key);
        render();
      }
    }
  };

  const settleCredentialRotationServerUpdateRetry = (
    kind: ConnectionKind,
    name: string,
  ): void => {
    try {
      opts.onCredentialRotationServerUpdateRetrySettled?.({ kind, name });
      credentialRotationServerUpdateRetrySettled = true;
      credentialRotationServerUpdateRetryTarget = null;
    } catch {
      // A stable local landing must not be undone by host bookkeeping.
    }
  };

  const presentServerUpdateContinuity = (
    marker: CredentialRotationServerUpdateMarker | null,
  ): void => {
    if (disposed) return;
    let current = state.credentialRotationRecovery;
    const progress = marker?.serverUpdateProgress ?? null;
    if (
      marker === null
      && current?.returnedFromServerUpdate === true
      && (
        current.phase === 'editor_ready'
        || (
          current.phase === 'restart_ready'
          && exactOpenEditor(current.kind, current.name)
        )
      )
    ) {
      // Account may dismiss the target-only handoff while Connections still
      // owns the clean form. The editor and its memory-only values stay put,
      // but its now-retired "untouched" orientation must disappear in this
      // same render instead of resurfacing after Cancel.
      credentialRotationFreshStartPreflightGeneration += 1;
      state.credentialRotationRecovery = null;
      render();
      return;
    }
    if (
      marker?.phase === 'editor_ready'
      && progress === null
      && state.dialog.stage !== 'form'
      && current === null
    ) {
      credentialRotationFreshStartPreflightGeneration += 1;
      state.credentialRotationRecovery = {
        kind: marker.kind,
        name: marker.name,
        phase: 'editor_ready',
        returnedFromServerUpdate: true,
      };
      render();
      return;
    }
    if (marker !== null && progress !== null) {
      // Never replace an editor or unrelated recovery. A matching clean-start
      // state can safely become a passive observer: changing its object and
      // generation also invalidates any older preflight response before it can
      // open a form.
      if (
        state.dialog.stage === 'form'
        || (
          current !== null
          && (
            current.kind !== marker.kind
            || current.name !== marker.name
            || !isFreshStartCredentialRotationRecovery(current)
          )
        )
      ) return;
      const latest = state.connections.find((connection) =>
        connection.kind === marker.kind && connection.name === marker.name);
      const baselineUpdatedAt = current?.baselineUpdatedAt
        ?? (typeof latest?.updated_at === 'number'
          && Number.isSafeInteger(latest.updated_at)
          ? latest.updated_at
          : undefined);
      const underlyingPhase = current?.phase
        ?? (marker.phase === 'ready'
          ? 'restart_ready'
          : 'restart_unsupported');
      credentialRotationFreshStartPreflightGeneration += 1;
      state.credentialRotationRecovery = {
        ...(current ?? {
          kind: marker.kind,
          name: marker.name,
          phase: underlyingPhase,
        }),
        kind: marker.kind,
        name: marker.name,
        phase: underlyingPhase,
        returnedFromServerUpdate: true,
        ...(marker.serverUpdateTriage !== undefined
          ? { serverUpdateTriage: marker.serverUpdateTriage }
          : {}),
        ...(baselineUpdatedAt !== undefined ? { baselineUpdatedAt } : {}),
        serverUpdateProgress: { ...progress },
        ...(marker.serverUpdateVerification !== undefined
          ? {
              serverUpdateVerification: {
                ...marker.serverUpdateVerification,
              },
            }
          : {}),
      };
      if (
        marker.serverUpdateVerification === undefined
        && state.credentialRotationRecovery.serverUpdateVerification
          !== undefined
      ) {
        const {
          serverUpdateVerification: _verification,
          ...withoutVerification
        } = state.credentialRotationRecovery;
        state.credentialRotationRecovery = withoutVerification;
      }
      // The polite live region announces progress without changing route or
      // focus. All clean-start actions disappear while the overlay is present.
      render();
      return;
    }
    const completion =
      marker?.serverUpdateVerification?.phase === 'completed'
        ? marker.serverUpdateVerification
        : null;
    if (marker !== null && progress === null && completion !== null) {
      if (
        state.dialog.stage === 'form'
        || (
          current !== null
          && (
            current.kind !== marker.kind
            || current.name !== marker.name
            || !isFreshStartCredentialRotationRecovery(current)
          )
        )
      ) return;
      const latest = state.connections.find((connection) =>
        connection.kind === marker.kind && connection.name === marker.name);
      const baselineUpdatedAt = current?.baselineUpdatedAt
        ?? (typeof latest?.updated_at === 'number'
          && Number.isSafeInteger(latest.updated_at)
          ? latest.updated_at
          : undefined);
      credentialRotationFreshStartPreflightGeneration += 1;
      state.credentialRotationRecovery = {
        ...(current ?? {
          kind: marker.kind,
          name: marker.name,
          phase: marker.phase === 'ready'
            ? 'restart_ready'
            : 'restart_waiting',
        }),
        kind: marker.kind,
        name: marker.name,
        returnedFromServerUpdate: true,
        serverUpdateVerification: completion,
        ...(baselineUpdatedAt !== undefined ? { baselineUpdatedAt } : {}),
      };
      render();
      return;
    }
    let removedProgress = false;
    if (current?.serverUpdateProgress !== undefined) {
      const {
        serverUpdateProgress: _progress,
        serverUpdateVerification: _verification,
        ...rest
      } = current;
      current = marker?.phase === 'ready'
        ? { ...rest, phase: 'restart_ready' }
        : marker?.phase === 'triage'
          ? {
              ...rest,
              phase: 'restart_unsupported',
              ...(marker.serverUpdateTriage !== undefined
                ? { serverUpdateTriage: marker.serverUpdateTriage }
                : {}),
            }
          : rest;
      state.credentialRotationRecovery = current;
      removedProgress = true;
    }
    if (marker?.phase !== 'resolved_elsewhere') {
      if (current?.phase === 'restart_resolved') {
        credentialRotationFreshStartPreflightGeneration += 1;
        state.credentialRotationRecovery = null;
        if (state.dialog.stage !== 'form') render();
      } else if (removedProgress && state.dialog.stage !== 'form') {
        render();
      }
      return;
    }
    // Never replace a form or an unrelated recovery. The route-independent
    // Account receipt remains available if the owner is already doing newer
    // work here. A matching stale fresh-start state can be safely retired.
    if (
      state.dialog.stage === 'form'
      || (
        current !== null
        && (
          current.kind !== marker.kind
          || current.name !== marker.name
          || !isFreshStartCredentialRotationRecovery(current)
        )
      )
    ) return;
    const latest = state.connections.find((connection) =>
      connection.kind === marker.kind && connection.name === marker.name);
    const baselineUpdatedAt = current?.baselineUpdatedAt
      ?? (typeof latest?.updated_at === 'number'
        && Number.isSafeInteger(latest.updated_at)
        ? latest.updated_at
        : undefined);
    credentialRotationFreshStartPreflightGeneration += 1;
    state.credentialRotationRecovery = {
      kind: marker.kind,
      name: marker.name,
      phase: 'restart_resolved',
      returnedFromServerUpdate: true,
      ...(baselineUpdatedAt !== undefined ? { baselineUpdatedAt } : {}),
    };
    // This is a passive sibling result. The polite live region announces it,
    // but focus and the exact route stay where the owner left them.
    render();
  };

  /** "Start fresh" is deliberately more than a route into Edit. The earlier
   * terminal receipt proves only that the row was unchanged at that moment;
   * this fresh, server-authoritative activity + list pair confirms an idle
   * check and the exact saved revision before a blank credential editor
   * appears. The server's unique pending-attempt claim remains the final race
   * boundary on submit. No form value is read or sent during this preflight. */
  const startFreshCredentialRotation = async (
    kind: ConnectionKind,
    name: string,
  ): Promise<void> => {
    const recovery = state.credentialRotationRecovery;
    if (
      disposed
      || !canRunFreshStartCredentialRotationPreflight(recovery)
      || (
        opts.credentialRotationTabConvergence
          ?.readServerUpdateProgress() ?? null
      ) !== null
      || recovery.kind !== kind
      || recovery.name !== name
    ) return;

    const preflightGeneration =
      ++credentialRotationFreshStartPreflightGeneration;
    const dialogGenerationAtStart = dialogGen;
    const startedSignalGenerationAtStart =
      credentialRotationStartedSignalGeneration;
    const checking: CredentialRotationRecoveryState = {
      ...recovery,
      phase: 'restart_checking',
      resumePreflightOnReconnect: true,
    };
    state.credentialRotationRecovery = checking;
    if (recovery.phase === 'restart_resolved') {
      opts.credentialRotationServerUpdateContinuity
        ?.resumeResolvedRetry({ kind, name });
    }
    if (state.dialog.stage !== 'form') {
      render();
      focusGuideTarget(
        '[data-connection-credential-recovery="restart_checking"]',
      );
    }

    const preflightStillCurrent = (): boolean => !disposed
      && preflightGeneration
        === credentialRotationFreshStartPreflightGeneration
      && state.credentialRotationRecovery === checking;
    const showPreflightPhase = (
      phase:
        | 'restart_handoff'
        | 'restart_waiting'
        | 'restart_unsupported',
    ): void => {
      if (!preflightStillCurrent()) return;
      state.credentialRotationRecovery = { ...checking, phase };
      if (state.dialog.stage !== 'form') {
        render();
        focusGuideTarget(
          '[data-action="connections-start-fresh-credential-rotation"]',
        );
      }
    };
    const showUnsupportedAfterReturn = async (): Promise<void> => {
      if (!preflightStillCurrent()) return;
      if (checking.returnedFromServerUpdate !== true) {
        showPreflightPhase('restart_unsupported');
        return;
      }
      const triaging: CredentialRotationRecoveryState = {
        ...checking,
        phase: 'restart_triaging',
      };
      state.credentialRotationRecovery = triaging;
      if (state.dialog.stage !== 'form') {
        render();
        focusGuideTarget(
          '[data-connection-credential-recovery="restart_triaging"]',
        );
      }
      let serverUpdateTriage: ConnectionsServerUpdateTriage = {
        reason: 'release_check_inconclusive',
        checkStatus: 'unavailable',
      };
      try {
        serverUpdateTriage =
          await opts.runCredentialRotationServerUpdateTriage?.({ kind, name })
          ?? serverUpdateTriage;
      } catch {
        // The missing activity method is already authoritative. A failed
        // update check changes only the specificity of the guidance.
      }
      if (
        disposed
        || preflightGeneration
          !== credentialRotationFreshStartPreflightGeneration
        || state.credentialRotationRecovery !== triaging
      ) return;
      state.credentialRotationRecovery = {
        ...checking,
        phase: 'restart_unsupported',
        serverUpdateTriage,
      };
      if (state.dialog.stage !== 'form') {
        render();
        focusGuideTarget(
          opts.onOpenCredentialRotationServerUpdateGuide === undefined
            ? '[data-action="connections-start-fresh-credential-rotation"]'
            : '[data-action="connections-review-server-update"]',
        );
      }
    };

    const runActivity = opts.runCredentialRotationActivity;
    if (runActivity === undefined) {
      await showUnsupportedAfterReturn();
      return;
    }
    let activity: ConnectionCredentialRotationActivity;
    try {
      ({ activity } = await runActivity({ kind, name }));
    } catch (error) {
      if (!preflightStillCurrent()) return;
      const classified = classifyRpcError(error);
      if (
        classified.code === 'unknown_method'
        || classified.code === 'not_configured'
      ) await showUnsupportedAfterReturn();
      else showPreflightPhase('restart_waiting');
      return;
    }
    if (!preflightStillCurrent()) return;
    if (checking.returnedFromServerUpdate === true) {
      // This exact tab has now proved the formerly missing safe read exists.
      // The signal carries no credential and cannot resolve a sibling by
      // itself; boot repeats the same server read before changing its receipt.
      opts.credentialRotationTabConvergence
        ?.notifyServerCapabilityResolved({ kind, name });
    }
    if (activity.status === 'pending') {
      showPreflightPhase('restart_handoff');
      return;
    }
    const authoritativeSafeStop = credentialRotationSafeStopFromActivity(
      activity,
      kind,
    );
    if (authoritativeSafeStop.safeStop !== null) {
      presentAuthoritativeCredentialSafeStop(
        kind,
        name,
        authoritativeSafeStop.safeStop,
        true,
      );
      return;
    }

    // A sibling can hold the origin-scoped lease briefly before its new RPC
    // has durably claimed the server row. The activity read is still `idle` in
    // that window, so probe the browser owner too. A successful probe is
    // advisory only and is yielded immediately; the submit path will claim
    // again before it sends any credential.
    const convergence = opts.credentialRotationTabConvergence;
    if (convergence?.supportsOwnershipLeases === true) {
      let probeLease: CredentialRotationOwnershipLease | null;
      try {
        probeLease = await convergence.claimCredentialRotationOwnership({
          kind,
          name,
        });
      } catch {
        showPreflightPhase('restart_waiting');
        return;
      }
      if (!preflightStillCurrent()) {
        probeLease?.release();
        return;
      }
      if (probeLease === null) {
        showPreflightPhase('restart_handoff');
        return;
      }
      probeLease.release();
    }

    // The list read is causally later than the idle activity result. Share the
    // normal list generation so a newer focus/reconnect read wins; a superseded
    // preflight remains retryable instead of opening from an older response.
    const listGeneration = ++loadGeneration;
    let connections: ReadonlyArray<ConnectionView>;
    try {
      ({ connections } = await opts.runList());
    } catch {
      showPreflightPhase('restart_waiting');
      return;
    }
    if (!preflightStillCurrent()) return;
    if (listGeneration !== loadGeneration) {
      showPreflightPhase('restart_waiting');
      return;
    }

    state.connections = [...connections];
    state.loading = false;
    state.error = null;
    const latest = connections.find((connection) =>
      connection.kind === kind && connection.name === name);
    if (
      recovery.baselineUpdatedAt === undefined
      || (latest !== undefined && latest.updated_at === undefined)
    ) {
      // Without matching server revisions there is no positive proof that the
      // editor would be built from the same row that earned Start fresh.
      showPreflightPhase('restart_waiting');
      return;
    }
    if (
      latest === undefined
      || latest.updated_at !== recovery.baselineUpdatedAt
    ) {
      state.credentialRotationRecovery = {
        kind,
        name,
        phase: 'superseded',
        ...(checking.returnedFromServerUpdate === true
          ? { returnedFromServerUpdate: true }
          : {}),
        ...(checking.serverUpdateVerification?.phase === 'completed'
          ? {
              serverUpdateVerification:
                checking.serverUpdateVerification,
            }
          : {}),
      };
      if (state.dialog.stage !== 'form') render();
      if (recovery.returnedFromServerUpdate === true) {
        settleCredentialRotationServerUpdateRetry(kind, name);
      }
      return;
    }
    if (
      credentialRotationStartedSignalGeneration
        !== startedSignalGenerationAtStart
    ) {
      showPreflightPhase('restart_handoff');
      return;
    }
    if (
      dialogGenerationAtStart !== dialogGen
      || state.dialog.stage !== 'closed'
    ) {
      // The owner moved elsewhere while the read was in flight. Keep the
      // freshly-proved offer, but never replace their newer route or form.
      state.credentialRotationRecovery = {
        kind,
        name,
        phase: 'restart_ready',
        baselineUpdatedAt: latest.updated_at,
        ...(checking.returnedFromServerUpdate === true
          ? { returnedFromServerUpdate: true }
          : {}),
        ...(checking.serverUpdateVerification?.phase === 'completed'
          ? {
              serverUpdateVerification:
                checking.serverUpdateVerification,
            }
          : {}),
        ...(checking.failureReason !== undefined
          ? { failureReason: checking.failureReason }
          : {}),
        ...(checking.correction !== undefined
          ? { correction: checking.correction }
          : {}),
      };
      if (state.dialog.stage !== 'form') render();
      return;
    }

    state.credentialRotationRecovery =
      checking.returnedFromServerUpdate === true
        ? checking.serverUpdateVerification?.phase === 'completed'
          ? {
              kind,
              name,
              phase: 'restart_ready',
              baselineUpdatedAt: latest.updated_at,
              returnedFromServerUpdate: true,
              serverUpdateVerification: checking.serverUpdateVerification,
              ...(checking.failureReason === undefined
                ? {}
                : { failureReason: checking.failureReason }),
              ...(checking.correction === undefined
                ? {}
                : { correction: checking.correction }),
            }
          : {
              kind,
              name,
              phase: 'editor_ready',
              baselineUpdatedAt: latest.updated_at,
              returnedFromServerUpdate: true,
              ...(checking.failureReason === undefined
                ? {}
                : { failureReason: checking.failureReason }),
              ...(checking.correction === undefined
                ? {}
                : { correction: checking.correction }),
            }
        : null;
    releaseCredentialRotationOwnership(true);
    openEditConnection(kind, name);
    if (exactOpenEditor(kind, name)) {
      if (recovery.returnedFromServerUpdate === true) {
        markCredentialRotationCleanEditorReady(kind, name);
      }
      const hasCorrection = setDialogCredentialCorrection(
        checking.correction,
        rotationFailureCopy(checking.failureReason ?? 'auth_failed'),
      );
      if (hasCorrection) render();
      if (hasCorrection) focusCredentialCorrection();
      else focusCredentialReplacementStart();
    }
  };

  // ── Fresh-start return helper ─────────────────────────────────
  /** A guide return can land while the restarted server is still reconnecting,
   * before any trustworthy row revision was loaded. Re-establish that baseline
   * first, then enter the normal activity + causally-later-list preflight. */
  const retryFreshCredentialRotation = async (
    kind: ConnectionKind,
    name: string,
  ): Promise<void> => {
    const recovery = state.credentialRotationRecovery;
    const cleanEditorMarker =
      opts.credentialRotationServerUpdateContinuity?.read() ?? null;
    if (
      cleanEditorMarker?.phase === 'editor_ready'
      && cleanEditorMarker.kind === kind
      && cleanEditorMarker.name === name
    ) {
      if (
        opts.credentialRotationServerUpdateContinuity
          ?.beginExactReturn({ kind, name }) !== true
      ) return;
      credentialRotationServerUpdateRetryTarget = { kind, name };
      credentialRotationServerUpdateRetrySettled = false;
    }
    if (
      recovery?.returnedFromServerUpdate !== true
      || recovery.baselineUpdatedAt !== undefined
    ) {
      await startFreshCredentialRotation(kind, name);
      return;
    }
    if (
      disposed
      || !canRunFreshStartCredentialRotationPreflight(recovery)
      || (
        opts.credentialRotationTabConvergence
          ?.readServerUpdateProgress() ?? null
      ) !== null
      || recovery.kind !== kind
      || recovery.name !== name
    ) return;

    const preflightGeneration =
      ++credentialRotationFreshStartPreflightGeneration;
    const dialogGenerationAtStart = dialogGen;
    const checking: CredentialRotationRecoveryState = {
      ...recovery,
      phase: 'restart_checking',
      resumePreflightOnReconnect: true,
    };
    state.credentialRotationRecovery = checking;
    if (recovery.phase === 'restart_resolved') {
      opts.credentialRotationServerUpdateContinuity
        ?.resumeResolvedRetry({ kind, name });
    }
    state.error = null;
    if (state.dialog.stage !== 'form') {
      render();
      focusGuideTarget(
        '[data-connection-credential-recovery="restart_checking"]',
      );
    }

    const preflightStillCurrent = (): boolean => !disposed
      && preflightGeneration
        === credentialRotationFreshStartPreflightGeneration
      && state.credentialRotationRecovery === checking;
    const showWaiting = (): void => {
      if (!preflightStillCurrent()) return;
      state.loading = false;
      state.error = null;
      state.credentialRotationRecovery = {
        ...checking,
        phase: 'restart_waiting',
      };
      if (state.dialog.stage !== 'form') {
        render();
        focusGuideTarget(
          '[data-action="connections-start-fresh-credential-rotation"]',
        );
      }
    };

    const listGeneration = ++loadGeneration;
    let connections: ReadonlyArray<ConnectionView>;
    try {
      ({ connections } = await opts.runList());
    } catch {
      showWaiting();
      return;
    }
    if (!preflightStillCurrent()) return;
    if (listGeneration !== loadGeneration) {
      showWaiting();
      return;
    }
    state.connections = [...connections];
    state.loading = false;
    state.error = null;
    const latest = connections.find((connection) =>
      connection.kind === kind && connection.name === name);
    if (latest === undefined) {
      state.credentialRotationRecovery = {
        kind,
        name,
        phase: 'superseded',
        returnedFromServerUpdate: true,
        ...(checking.serverUpdateVerification?.phase === 'completed'
          ? {
              serverUpdateVerification:
                checking.serverUpdateVerification,
            }
          : {}),
      };
      if (state.dialog.stage !== 'form') render();
      settleCredentialRotationServerUpdateRetry(kind, name);
      return;
    }
    if (
      typeof latest.updated_at !== 'number'
      || !Number.isSafeInteger(latest.updated_at)
    ) {
      showWaiting();
      return;
    }
    const ready: CredentialRotationRecoveryState = {
      ...checking,
      phase: 'restart_ready',
      baselineUpdatedAt: latest.updated_at,
    };
    state.credentialRotationRecovery = ready;
    if (
      dialogGenerationAtStart !== dialogGen
      || state.dialog.stage !== 'closed'
    ) {
      if (state.dialog.stage !== 'form') render();
      return;
    }
    await startFreshCredentialRotation(kind, name);
  };

  // ── Action handlers ───────────────────────────────────────────
  const handlers: ActionHandlers<ConnectionsEnrollAction> = {
    'connections-retry-pack-context': (_dataset, _event, element) => {
      if (
        state.packInventoryRecovery?.phase !== 'error'
        || packsFetchInFlight !== null
      ) return;
      void ensurePacksLoaded({
        force: true,
        reclaimFocus: doc.activeElement === element,
      });
    },
    'connections-open-add': () => {
      if (!confirmDiscardConnectionDraft()) return;
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
        captureDialogDraftBaseline();
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
      captureDialogDraftBaseline();
      render();
      // The email subtype's send-from picker reads the dynamic send-capable
      // list — re-pull it now the form is on screen (freshest at point-of-use,
      // catches a mail account enrolled since mount). It repaints in place.
      if (state.dialog.kind === 'notification' && subtype === 'email') {
        void hydrateMailOptions();
      }
    },
    'connections-back-to-kind': () => {
      if (!confirmDiscardConnectionDraft()) return;
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
      if (!confirmDiscardConnectionDraft()) return;
      beginDialogNavigation();
      state.dialog.stage = 'subtype-picker';
      state.dialog.subtype = null;
      state.dialog.vendor = null;
      state.dialog.values = {};
      state.dialog.error = null;
      render();
    },
    'connections-cancel-dialog': () => {
      const schema = activeSchema();
      if (
        state.dialog.saving
        && state.dialog.mode === 'edit'
        && schema !== undefined
        && shouldPatchConnectionAuth(schema, state.dialog.values)
      ) return;
      if (!confirmDiscardConnectionDraft()) return;
      const refreshSafeStopQueue =
        state.dialog.credentialSafeStopClosureNotice !== null;
      resetDialog();
      render();
      if (refreshSafeStopQueue) void doRefresh();
    },
    'connections-submit-form': () => {
      void submitForm();
    },
    'connections-focus-first-invalid': () => {
      focusFirstConnectionFormIssue();
    },
    'connections-focus-credential-correction': () => {
      focusCredentialCorrection();
    },
    'connections-focus-credential-triage': () => {
      focusCredentialTriage();
    },
    'connections-confirm-credential-handoff': () => {
      void confirmCredentialHandoffResolved();
    },
    'connections-check-saved-after-safe-stop': (dataset) => {
      const notice = state.dialog.credentialSafeStopClosureNotice;
      const kind = asKind(dataset.kind);
      const name = dataset.name;
      if (
        notice === null
        || notice.nextStep !== 'check_saved_connection'
        || kind === null
        || name === undefined
        || notice.kind !== kind
        || notice.name !== name
        || !exactOpenEditor(kind, name)
        || !confirmDiscardConnectionDraft()
      ) return;
      resetDialog();
      void verifySavedConnectionAfterSafeStop(kind, name);
    },
    'connections-recheck-post-safe-stop': (dataset) => {
      const receipt = state.dialog.recentProbe;
      const kind = asKind(dataset.kind);
      const name = dataset.name;
      if (
        state.dialog.stage !== 'closed'
        || receipt?.purpose !== 'post_safe_stop'
        || (
          receipt.resolution !== 'retry'
          && receipt.resolution !== 'unsupported'
          && receipt.resolution !== 'changed'
        )
        || kind === null
        || name === undefined
        || receipt.kind !== kind
        || receipt.name !== name
      ) return;
      void verifySavedConnectionAfterSafeStop(kind, name);
    },
    'connections-review-post-safe-stop': (dataset) => {
      const receipt = state.dialog.recentProbe;
      const kind = asKind(dataset.kind);
      const name = dataset.name;
      if (
        state.dialog.stage !== 'closed'
        || receipt?.purpose !== 'post_safe_stop'
        || receipt.resolution !== 'reopen'
        || kind === null
        || name === undefined
        || receipt.kind !== kind
        || receipt.name !== name
      ) return;
      const latest = state.connections.find((connection) =>
        connection.kind === kind && connection.name === name);
      if (latest === undefined) {
        state.dialog.recentProbe = {
          ...receipt,
          resolution: 'removed',
        };
        render();
        return;
      }
      const correction = receipt.credential_correction;
      if (
        correction !== undefined
        && latest.auth_type !== correction.auth_type
      ) {
        state.dialog.recentProbe = {
          ...receipt,
          resolution: 'changed',
        };
        render();
        return;
      }
      openEditConnection(kind, name);
      const message = correction === undefined
        ? 'A new check could not sign in with this saved Connection. The earlier stop stays closed. Look at the address and the way it signs in before you check again.'
        : 'A new check found the other service still refuses the key you have saved. The earlier stop stays closed. Type a new one and check it once.';
      const correctionLanded = setDialogCredentialCorrection(
        correction,
        message,
      );
      if (!correctionLanded) state.dialog.error = message;
      render();
      if (correctionLanded) focusCredentialCorrection();
      else focusCredentialReplacementStart();
    },
    'connections-continue-post-safe-stop': (dataset) => {
      const receipt = state.dialog.recentProbe;
      const kind = asKind(dataset.kind);
      const name = dataset.name;
      if (
        state.dialog.stage !== 'closed'
        || receipt?.purpose !== 'post_safe_stop'
        || (receipt.resolution !== 'resolved' && receipt.resolution !== 'removed')
        || kind === null
        || name === undefined
      ) return;
      const next = state.postSafeStopRecoveries.find((candidate) =>
        candidate.kind === kind && candidate.name === name);
      if (next === undefined) return;
      presentPostSafeStopRecovery(next);
      render();
      focusGuideTarget(
        next.status === 'auth_failed'
          ? '[data-action="connections-review-post-safe-stop"]'
          : '[data-action="connections-recheck-post-safe-stop"]',
      );
    },
    'connections-open-post-safe-stop-profile': () => {
      if (postSafeStopProfileHandoff === null) return;
      opts.onOpenPostSafeStopServerProfiles?.();
    },
    'connections-review-active-post-safe-stop': () => {
      if (
        state.dialog.stage !== 'closed'
        || postSafeStopProfileHandoff === null
      ) return;
      const next = state.postSafeStopRecoveries[0];
      if (next === undefined) return;
      postSafeStopProfileHandoff = null;
      suppressAutomaticPostSafeStopRecovery = false;
      opts.onPostSafeStopProfileHandoffSettled?.();
      presentPostSafeStopRecovery(next);
      render();
      focusGuideTarget(
        next.status === 'auth_failed'
          ? '[data-action="connections-review-post-safe-stop"]'
          : '[data-action="connections-recheck-post-safe-stop"]',
      );
    },
    'connections-dismiss-post-safe-stop-profile': () => {
      if (postSafeStopProfileHandoff === null) return;
      postSafeStopProfileHandoff = null;
      opts.onPostSafeStopProfileHandoffSettled?.();
      render();
    },
    'connections-copy-credential-admin-handoff': (_dataset, _event, element) => {
      copyCredentialAdminHandoff(element);
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
      // ⚠ Defaults to `header_name` when the button carries no `name-key` —
      // every header-list button rendered before this existed, and the
      // header-list is the shape this handler was written for.
      const nameKey = dataset.nameKey === 'field_name' ? 'field_name' : 'header_name';
      const collected = collectHeaderRows(state.dialog.values, baseKey, nameKey);
      const shown =
        collected.length > 0
          ? collected
          : [{ index: 0, header_name: '', name: '', value: '' }];
      if (shown.length >= MAX_HEADER_AUTH_ENTRIES) return;
      const next = { ...state.dialog.values };
      for (const r of shown) {
        next[`${baseKey}.${r.index}.${nameKey}`] = r.name;
        next[`${baseKey}.${r.index}.value`] = r.value;
      }
      const nextIndex = Math.max(...shown.map((r) => r.index)) + 1;
      next[`${baseKey}.${nextIndex}.${nameKey}`] = '';
      next[`${baseKey}.${nextIndex}.value`] = '';
      retireUntouchedCleanEditorIfCurrent();
      state.dialog.values = next;
      if (state.dialog.credentialCorrection?.fieldKeys.includes(
        baseKey as ConnectionCredentialCorrectionFieldKey,
      )) {
        retireCredentialRegenerationSafeStop();
        state.dialog.credentialCorrection = null;
      }
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
      const nameKey = dataset.nameKey === 'field_name' ? 'field_name' : 'header_name';
      const next = { ...state.dialog.values };
      delete next[`${baseKey}.${idx}.${nameKey}`];
      delete next[`${baseKey}.${idx}.value`];
      retireUntouchedCleanEditorIfCurrent();
      state.dialog.values = next;
      if (state.dialog.credentialCorrection?.fieldKeys.includes(
        baseKey as ConnectionCredentialCorrectionFieldKey,
      )) {
        retireCredentialRegenerationSafeStop();
        state.dialog.credentialCorrection = null;
      }
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
      retireUntouchedCleanEditorIfCurrent();
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
      retireUntouchedCleanEditorIfCurrent();
      state.dialog.values = next;
      render();
    },
    'connections-edit': (dataset) => {
      const kind = asKind(dataset.kind);
      const name = dataset.name;
      if (kind === null || name === undefined) return;
      if (!confirmDiscardConnectionDraft()) return;
      openEditConnection(kind, name);
    },
    'connections-check-credential-rotation': () => {
      void reconcileCredentialRotation();
    },
    'connections-check-credential-safe-stop': (dataset) => {
      const requestedKind = asKind(dataset.kind);
      const requestedName = dataset.name;
      const ownership = state.dialog.credentialRotationOwnership;
      const recovery = state.credentialRotationRecovery;
      const target = ownership !== null
        && isCrossTabCredentialSafeStopOwnership(
          ownership,
          ownership.kind,
          ownership.name,
        )
        ? { kind: ownership.kind, name: ownership.name }
        : recovery !== null
          && isCrossTabCredentialSafeStopRecovery(
            recovery,
            recovery.kind,
            recovery.name,
          )
          ? { kind: recovery.kind, name: recovery.name }
          : null;
      if (
        target === null
        || requestedKind !== target.kind
        || requestedName !== target.name
      ) return;
      void reconcileCredentialRotationSafeStop(
        target.kind,
        target.name,
        true,
      );
    },
    'connections-review-credential-rotation': (dataset) => {
      const kind = asKind(dataset.kind);
      const name = dataset.name;
      if (kind === null || name === undefined) return;
      const recovery = state.credentialRotationRecovery;
      if (
        recovery === null
        || recovery.kind !== kind
        || recovery.name !== name
      ) return;
      const correction = recovery.correction;
      const failureReason = recovery.failureReason;
      const safeStop = hasCredentialRegenerationSafeStop(correction);
      const targetStillExists = state.connections.some((connection) =>
        connection.kind === kind && connection.name === name);
      if (safeStop && !targetStillExists) {
        clearCredentialRotationSafeStopPresentation(kind, name);
        render();
        return;
      }
      if (!confirmDiscardConnectionDraft()) return;
      const marker = opts.credentialRotationContinuity?.read() ?? null;
      if (
        !safeStop
        && marker !== null
        && marker.kind === kind
        && marker.name === name
      ) {
        opts.credentialRotationContinuity?.retire(marker.attemptId);
      }
      if (!safeStop) state.credentialRotationRecovery = null;
      const safeStopAcknowledgementToken = safeStop
        && credentialRotationSafeStopClosure?.key
          === connectionRowKey(kind, name)
        ? credentialRotationSafeStopClosure.acknowledgementToken
        : null;
      releaseCredentialRotationOwnership(true);
      openEditConnection(kind, name);
      if (safeStop && correction !== undefined) {
        // The rejected candidate can use a different sign-in method than the
        // still-saved credential. This explicit, discard-confirmed recovery
        // action restores that non-secret method while leaving every rejected
        // credential field blank, so the exact correction can map safely.
        state.dialog.values = {
          ...state.dialog.values,
          'auth.type': correction.auth_type,
        };
        if (state.dialog.vendor !== null) {
          state.dialog.values = syncVendorOAuthEndpointValue(
            state.dialog.vendor,
            state.dialog.values,
          );
        }
      }
      const correctionLanded = correction !== undefined
        && setDialogCredentialCorrection(
          correction,
          rotationFailureCopy(failureReason ?? 'auth_failed'),
        );
      if (safeStop) {
        applyCredentialSafeStopClosureCapability(
          kind,
          name,
          safeStopAcknowledgementToken,
        );
        state.dialog.credentialRotationOwnership = correctionLanded
          ? null
          : {
              kind,
              name,
              phase: 'safe_stopped',
              automaticTakeover: false,
              error: 'What your server sorted out does not fit this kind of Connection. Saving stays paused. Update this browser or your server before you try again.',
            };
      }
      if (correctionLanded) {
        render();
        focusCredentialCorrection();
      } else if (safeStop) {
        render();
      }
    },
    'connections-start-fresh-credential-rotation': (dataset) => {
      const kind = asKind(dataset.kind);
      const name = dataset.name;
      if (kind === null || name === undefined) return;
      void retryFreshCredentialRotation(kind, name);
    },
    'connections-review-server-update': (dataset) => {
      const kind = asKind(dataset.kind);
      const name = dataset.name;
      const recovery = state.credentialRotationRecovery;
      if (
        kind === null
        || name === undefined
        || recovery?.phase !== 'restart_unsupported'
        || recovery.kind !== kind
        || recovery.name !== name
      ) return;
      opts.onOpenCredentialRotationServerUpdateGuide?.({ kind, name });
    },
    'connections-dismiss-credential-rotation': (dataset) => {
      const kind = asKind(dataset.kind);
      const name = dataset.name;
      const recovery = state.credentialRotationRecovery;
      if (
        kind === null
        || name === undefined
        || recovery === null
        || recovery.kind !== kind
        || recovery.name !== name
      ) return;
      credentialRotationFreshStartPreflightGeneration += 1;
      state.credentialRotationRecovery = null;
      if (state.dialog.stage !== 'form') render();
      if (recovery.returnedFromServerUpdate === true) {
        settleCredentialRotationServerUpdateRetry(kind, name);
      }
    },
    'connections-check-credential-rotation-owner': () => {
      void checkCredentialRotationOwnership();
    },
    'connections-reload-stale-editor': () => {
      void reloadStaleEditor();
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
      if (state.dialog.externalChange !== null) return;
      startVendorOAuthFromClick();
    },
    'connections-guide-open': () => {
      openSetupGuide();
    },
    'connections-guide-close': () => {
      closeSetupGuide();
    },
    'connections-guide-review': () => {
      reviewSetupGuide();
    },
    'connections-guide-edit': () => {
      editSetupGuide();
    },
    'connections-guide-generate': () => {
      void generateSetupGuide();
    },
    'connections-guide-review-again': () => {
      reviewSetupGuideAgain();
    },
    'connections-guide-copy-callback': (_dataset, _event, element) => {
      copySetupGuideCallback(element);
    },
    'connections-guide-copy-scopes': (_dataset, _event, element) => {
      copyRequestedScopes(element);
    },
    'connections-guide-use-suggestion': (dataset) => {
      applySetupGuideSuggestion(dataset.fieldKey);
    },
    'connections-guide-return-to-form': () => {
      returnFromSetupGuide();
    },
    'connections-guide-resume': () => {
      resumeProviderSetup();
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
    // D-225 Slice 2 — the enrollment chain's actions. `generate` and `review`
    // are the SAME operation (open the review and probe); the badge labels them
    // differently because one is a first mint and the other a re-review, but a
    // first mint IS a review the owner has not done yet.
    'connections-mcp-pack-generate': (dataset) => {
      if (dataset.name === undefined) return;
      void openMcpPackReview(dataset.name);
    },
    'connections-mcp-pack-review': (dataset) => {
      if (dataset.name === undefined) return;
      void openMcpPackReview(dataset.name);
    },
    'connections-mcp-pack-probe': (dataset) => {
      // The `unknown` badge's offer: it says the connection has not been
      // probed, so the action is an ordinary probe — which refreshes
      // `tool_hashes` and therefore the badge itself.
      if (dataset.name === undefined) return;
      void probeRow('mcp', dataset.name);
    },
    'connections-mcp-pack-save': () => {
      void saveMcpPack();
    },
    'connections-mcp-pack-cancel': () => {
      closeMcpPackReview();
    },
    'connections-engagement-configure-cadence': (dataset) => {
      if (dataset.name === undefined) return;
      const key = connectionRowKey('api', dataset.name);
      setEngagementError(
        key,
        'You cannot set how often tidying runs from here yet. Use the server’s Housekeeping settings.',
      );
      render();
    },
  };

  // ── Field-edit delegation (`data-conn-field`) ─────────────────
  // Silent value capture, focus-preserving. Mirrors the reception
  // `attachFieldDelegator` shape but resolves the connections renderer's
  // `data-conn-field` markup instead of `data-field-control`.
  type FieldElement = HTMLElement & {
    value?: string;
    selectionStart?: number | null;
    selectionEnd?: number | null;
    selectionDirection?: 'forward' | 'backward' | 'none' | null;
    setSelectionRange?: (
      start: number,
      end: number,
      direction?: 'forward' | 'backward' | 'none',
    ) => void;
  };
  const onFieldEvent = (event: Event): void => {
    const target = event.target as FieldElement | null;
    if (target === null) return;
    const guideUrlEl = (
      typeof target.closest === 'function'
        ? target.closest('[data-connection-guide-url]')
        : null
    ) as FieldElement | null;
    if (
      guideUrlEl !== null
      && host.contains(guideUrlEl)
      && guideUrlEl.dataset.connectionGuideUrl !== undefined
    ) {
      if (event.type !== 'input' || state.dialog.saving) return;
      state.dialog.setupGuide.targetUrl = guideUrlEl.value ?? '';
      state.dialog.setupGuide.error = null;
      guideUrlEl.removeAttribute?.('aria-invalid');
      guideUrlEl.removeAttribute?.('aria-errormessage');
      guideUrlEl.setAttribute?.('aria-describedby', 'connection-setup-guide-privacy');
      const renderedError = typeof host.querySelector === 'function'
        ? host.querySelector(GUIDE_ERROR_SELECTOR) as (Element & { remove?: () => void }) | null
        : null;
      renderedError?.remove?.();
      syncGuideReviewDisabled();
      return;
    }
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
    // Lock values already captured by a submit/OAuth attempt or authoritatively
    // replaced by its result. This prevents a returned token from being paired
    // with different app details—or erasing a base-URL edit made meanwhile.
    if (state.dialog.saving) return;
    const oauthCapturedField = isConnectionOAuthLockedField(key);
    if (state.dialog.oauthInFlight && oauthCapturedField) return;
    const schemaBeforeEdit = activeSchema();
    const previousCredentialRotationIntent =
      state.dialog.mode === 'edit'
      && schemaBeforeEdit !== undefined
      && shouldPatchConnectionAuth(schemaBeforeEdit, state.dialog.values);
    const previousProjection = oauthCredentialProjectionKey(state.dialog.values);
    const previousValue = state.dialog.values[key] ?? '';
    const nextValue = el.value ?? '';
    const valueChanged = previousValue !== nextValue;
    if (valueChanged) state.dialog.credentialSafeStopClosureNotice = null;
    const credentialCorrectionBeforeEdit = state.dialog.credentialCorrection;
    const crossTabSafeStopCorrection = state.dialog.kind !== null
      && state.credentialRotationRecovery?.kind === state.dialog.kind
      && state.credentialRotationRecovery.name
        === (state.dialog.values.name ?? '')
      && hasCredentialRegenerationSafeStop(
        state.credentialRotationRecovery.correction,
      )
      ? state.credentialRotationRecovery.correction
      : undefined;
    const clearsUnmappedCrossTabSafeStop = valueChanged
      && state.dialog.kind !== null
      && crossTabSafeStopCorrection !== undefined
      && isCrossTabCredentialSafeStopOwnership(
        state.dialog.credentialRotationOwnership,
        state.dialog.kind,
        state.dialog.values.name ?? '',
      )
      && state.dialog.credentialRotationOwnership?.phase === 'safe_stopped'
      && (
        key.startsWith('auth.')
        || crossTabSafeStopCorrection.triage?.endpoint_field_keys.some(
          (fieldKey) => key === fieldKey || key.startsWith(`${fieldKey}.`),
        ) === true
      );
    const clearedCredentialCorrection = valueChanged
      && credentialCorrectionBeforeEdit !== null
      && (
        key === 'auth.type'
        || key.startsWith('config.')
        || credentialCorrectionBeforeEdit.fieldKeys.some((fieldKey) =>
          key === fieldKey || key.startsWith(`${fieldKey}.`))
      );
    const retainedCredentialCorrectionChanged = valueChanged
      && credentialCorrectionBeforeEdit !== null
      && !clearedCredentialCorrection;
    const untouchedCleanEditorChanged =
      valueChanged && retireUntouchedCleanEditorIfCurrent();
    const invalidatedOAuthResult =
      valueChanged
      && state.dialog.oauthGrantedScopes !== null
      && invalidatesConnectionOAuthResult(key);
    const replacedReturnedToken =
      valueChanged
      && key === 'auth.refresh_token'
      && (
        state.dialog.oauthGrantedScopes !== null
        || state.dialog.oauthNeedsReauthorization
      );
    state.dialog.values = {
      ...state.dialog.values,
      [key]: nextValue,
      ...(invalidatedOAuthResult ? { 'auth.refresh_token': '' } : {}),
    };
    if (clearedCredentialCorrection) {
      retireCredentialRegenerationSafeStop(
        credentialCorrectionBeforeEdit,
      );
      state.dialog.credentialCorrection = null;
    }
    if (clearsUnmappedCrossTabSafeStop && state.dialog.kind !== null) {
      const resolvedKind = state.dialog.kind;
      const resolvedName = state.dialog.values.name ?? '';
      invalidateCredentialRotationSafeStopCheckFor(
        resolvedKind,
        resolvedName,
      );
      clearCredentialRotationSafeStopPresentation(
        resolvedKind,
        resolvedName,
      );
      credentialRotationResolvedSafeStopEditor = {
        key: connectionRowKey(resolvedKind, resolvedName),
        dialogGeneration: dialogGen,
      };
    }
    // D-223 — the owner has touched this box, so the value is theirs now and the
    // publisher marker goes. Keyed on the edit itself rather than on the value
    // differing: re-typing the suggested value is still the owner looking at it
    // and deciding, which is precisely what the marker was asking for.
    const clearedHintMarker = state.dialog.hintedFields[key] !== undefined;
    if (clearedHintMarker) {
      const { [key]: _cleared, ...rest } = state.dialog.hintedFields;
      state.dialog.hintedFields = rest;
    }
    if (invalidatedOAuthResult) {
      state.dialog.oauthGrantedScopes = null;
      state.dialog.oauthNeedsReauthorization =
        state.dialog.values['auth.type'] === 'oauth2_refresh';
    } else if (replacedReturnedToken) {
      state.dialog.oauthGrantedScopes = null;
      state.dialog.oauthNeedsReauthorization = false;
    }
    // D-223 — dropping the publisher marker changes what is rendered, and a text
    // input otherwise does NOT re-render (deliberately: re-rendering per keystroke
    // would move the caret). This fires at most ONCE per hinted field — on the
    // transition, never on subsequent keystrokes — and restores focus the same way
    // the guide-target path does.
    if (clearedHintMarker) {
      render();
      focusGuideTarget(`[data-conn-field="${key}"]`);
    }
    if (key === 'auth.type' && nextValue !== 'oauth2_refresh') {
      state.dialog.oauthNeedsReauthorization = false;
    }
    const credentialRotationIntent =
      state.dialog.mode === 'edit'
      && schemaBeforeEdit !== undefined
      && shouldPatchConnectionAuth(schemaBeforeEdit, state.dialog.values);
    const credentialRotationIntentChanged =
      previousCredentialRotationIntent !== credentialRotationIntent;
    const resumableCredentialRotationCleared = !credentialRotationIntent
      && state.dialog.kind !== null
      && clearResumableCredentialRotationRecovery(
        state.dialog.kind,
        state.dialog.values.name ?? '',
      );
    const freshStartCredentialRotationBegan = credentialRotationIntent
      && state.dialog.kind !== null
      && clearFreshStartCredentialRotationRecovery(
        state.dialog.kind,
        state.dialog.values.name ?? '',
      );
    const correctionField = state.dialog.oauthErrorFieldKey;
    const clearedOAuthError = state.dialog.oauthError !== null && (
      (key === 'auth.type' && nextValue !== 'oauth2_refresh')
      || correctionField === key
      // `invalid_client` cannot distinguish the ID from its matching secret;
      // focus starts at the ID, but correcting either app-identity half clears it.
      || (
        correctionField === 'auth.client_id'
        && key === 'auth.client_secret'
      )
      || (correctionField === null && oauthCapturedField)
    );
    if (clearedOAuthError) {
      state.dialog.oauthError = null;
      state.dialog.oauthErrorFieldKey = null;
    }
    if (isSelect) {
      if (key === 'auth.type' && state.dialog.setupGuide.stage !== 'closed') {
        // The reviewed field set depends on auth.type. Preserve the typed URL,
        // but require a fresh privacy review before another model call.
        guideGeneration += 1;
        retireProviderSetupContinuity();
        const targetUrl = state.dialog.setupGuide.targetUrl;
        state.dialog.setupGuide = {
          ...initialConnectionsSetupGuideState(),
          stage: 'entry',
          targetUrl,
        };
      }
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
      syncCredentialRotationSuccessorEligibility();
      // auth.type (and other selects) gate `showWhen` field visibility —
      // a structural change, so re-render to reveal / hide fields.
      render();
      if (
        invalidatedOAuthResult
        || replacedReturnedToken
        || clearedOAuthError
        || clearedCredentialCorrection
        || previousProjection !== oauthCredentialProjectionKey(state.dialog.values)
        // Messenger mode swaps the provider checklist and credential shape.
        // The whole form re-renders, so restore the select that initiated the
        // change instead of dropping keyboard focus onto the document body.
        || schemaBeforeEdit?.onboarding?.selectorKey === key
      ) focusGuideTarget(`[data-conn-field="${key}"]`);
      return;
    }
    const oauthProjectionChanged =
      previousProjection !== oauthCredentialProjectionKey(state.dialog.values);
    const credentialRotationOwnershipChanged =
      syncCredentialRotationSuccessorEligibility();
    const renderRestoringField = (): void => {
      const selectionStart = el.selectionStart;
      const selectionEnd = el.selectionEnd;
      const selectionDirection = el.selectionDirection ?? undefined;
      render();
      const replacement = typeof host.querySelector === 'function'
        ? host.querySelector(`[data-conn-field="${key}"]`) as FieldElement | null
        : null;
      replacement?.focus?.();
      if (
        replacement?.setSelectionRange !== undefined
        && typeof selectionStart === 'number'
        && typeof selectionEnd === 'number'
      ) {
        try {
          replacement.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
        } catch {
          // Some input types expose the method but reject selection updates.
        }
      }
    };
    if (state.dialog.error !== null) {
      // First edit after a failed submit clears the stale error (the one
      // deliberate focus cost — re-enables Submit by re-render).
      state.dialog.error = null;
      renderRestoringField();
      return;
    }
    if (
      invalidatedOAuthResult
      || replacedReturnedToken
      || clearedOAuthError
      || clearedCredentialCorrection
      || clearsUnmappedCrossTabSafeStop
      || retainedCredentialCorrectionChanged
      || oauthProjectionChanged
      || credentialRotationIntentChanged
      || credentialRotationOwnershipChanged
      || resumableCredentialRotationCleared
      || freshStartCredentialRotationBegan
      || untouchedCleanEditorChanged
    ) {
      // Rebuild only when a non-secret readiness/rotation projection changes.
      // The selection restore prevents checklist freshness from moving the
      // caret; ordinary credential keystrokes remain on the silent path.
      renderRestoringField();
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
  credentialRotationTabUnsub =
    opts.credentialRotationTabConvergence?.subscribe((hint) => {
      void reconcileCredentialRotationTabs(hint);
    }) ?? null;
  credentialRotationServerUpdateUnsub =
    opts.credentialRotationServerUpdateContinuity?.subscribe((marker) => {
      presentServerUpdateContinuity(marker);
    }) ?? null;
  const detachReconnect = opts.onReconnect?.(() => {
    void (async () => {
      await Promise.all([
        reconcileCredentialRotationTabs({ type: 'reconcile' }),
        reconcileCredentialRotation(),
      ]);
      const recovery = state.credentialRotationRecovery;
      if (
        recovery?.resumePreflightOnReconnect === true
        && (
          recovery.phase === 'restart_handoff'
          || recovery.phase === 'restart_waiting'
          || recovery.phase === 'restart_unsupported'
        )
      ) {
        await retryFreshCredentialRotation(recovery.kind, recovery.name);
      }
    })();
  }) ?? null;

  let initialPostSafeStopRecoveryTarget = (() => {
    const target = opts.initialPostSafeStopRecovery;
    if (
      target === undefined
      || asKind(target.kind) === null
      || !CONNECTION_NAME_REGEX.test(target.name)
    ) return null;
    return { kind: target.kind, name: target.name };
  })();
  const initialCredentialRotationServerUpdateRetry = (() => {
    const target = opts.initialCredentialRotationServerUpdateRetry;
    if (
      target === undefined
      || asKind(target.kind) === null
      || !CONNECTION_NAME_REGEX.test(target.name)
    ) return null;
    return { kind: target.kind, name: target.name };
  })();
  if (initialCredentialRotationServerUpdateRetry !== null) {
    credentialRotationServerUpdateRetryTarget = {
      ...initialCredentialRotationServerUpdateRetry,
    };
  }
  const initialServerUpdateCompletion = (() => {
    if (initialCredentialRotationServerUpdateRetry === null) return null;
    const marker =
      opts.credentialRotationServerUpdateContinuity?.read() ?? null;
    const verification =
      opts.initialCredentialRotationServerUpdateCompletion
      ?? marker?.serverUpdateVerification;
    const affected = verification?.baseline?.affectedConnection;
    return verification?.phase === 'completed'
      && marker?.kind === initialCredentialRotationServerUpdateRetry.kind
      && marker.name === initialCredentialRotationServerUpdateRetry.name
      && affected?.kind === initialCredentialRotationServerUpdateRetry.kind
      && affected.name === initialCredentialRotationServerUpdateRetry.name
      ? verification
      : null;
  })();
  const initialVendor = opts.initialVendor !== undefined
    && CONNECTION_NAME_REGEX.test(opts.initialVendor)
    ? opts.initialVendor
    : null;
  if (initialCredentialRotationServerUpdateRetry !== null) {
    // The exact existing-connection return is newer than an abandoned API-app
    // creation guide. Do not let that older, safe-but-stale guide resurface if
    // this retry later waits or is dismissed.
    retireProviderSetupContinuity();
  }
  render();
  presentServerUpdateContinuity(
    opts.credentialRotationServerUpdateContinuity?.read() ?? null,
  );
  void doRefresh();
  const initialLoadGeneration = loadGeneration;
  // A safe same-profile guide needs no server or pack data to reconstruct its
  // field set. Restore in this mount task so a slow/hung list request cannot
  // strand continuity or flash the closed form first; later list/pack renders
  // preserve the dialog state. An explicit deep link remains the newer intent.
  if (
    initialVendor === null
    && initialCredentialRotationServerUpdateRetry === null
    && dialogGen === 0
    && state.dialog.stage === 'closed'
    && state.credentialRotationRecovery === null
  ) restoreProviderSetup();
  // Pre-warm the email send-from picker so it's populated by the time the
  // user reaches the email-notification form (silent — no email form open yet).
  void hydrateMailOptions();

  // A packs "Set up" deep link still waits for the best-effort pack fetch so
  // its new vendor form receives the normal installed-pack scope prefill.
  if (initialVendor !== null) {
    void pendingLoad.then(() => {
      if (disposed || dialogGen !== 0 || state.dialog.stage !== 'closed') return;
      retireProviderSetupContinuity();
      openVendorEnrollForm(initialVendor);
      render();
    });
  }

  // Returning from Account is itself the explicit retry gesture. Wait for the
  // first authoritative list to establish the exact row revision, then run the
  // normal activity + later-list preflight. A missing/changed row never opens;
  // no form value is reconstructed or carried through the route.
  if (initialCredentialRotationServerUpdateRetry !== null) {
    void pendingLoad.then(() => {
      if (
        disposed
        || dialogGen !== 0
        || state.dialog.stage !== 'closed'
      ) return;
      const { kind, name } = initialCredentialRotationServerUpdateRetry;
      if (loadGeneration !== initialLoadGeneration) {
        // A reconnect or sibling reconciliation overtook the mount's first
        // list. Its response may still be in flight, so the empty initial
        // state is not evidence that the exact connection disappeared. Start
        // a new generation-owned baseline read; it safely supersedes the
        // overlap and then enters the ordinary activity + later-list check.
        state.error = null;
        state.credentialRotationRecovery = {
          kind,
          name,
          phase: 'restart_waiting',
          resumePreflightOnReconnect: true,
          returnedFromServerUpdate: true,
          ...(initialServerUpdateCompletion === null
            ? {}
            : {
                serverUpdateVerification:
                  initialServerUpdateCompletion,
              }),
        };
        void retryFreshCredentialRotation(kind, name);
        return;
      }
      if (state.error !== null) {
        state.loading = false;
        state.error = null;
        state.credentialRotationRecovery = {
          kind,
          name,
          phase: 'restart_waiting',
          resumePreflightOnReconnect: true,
          returnedFromServerUpdate: true,
          ...(initialServerUpdateCompletion === null
            ? {}
            : {
                serverUpdateVerification:
                  initialServerUpdateCompletion,
              }),
        };
        render();
        focusGuideTarget(
          '[data-action="connections-start-fresh-credential-rotation"]',
        );
        return;
      }
      const latest = state.connections.find((connection) =>
        connection.kind === kind && connection.name === name);
      if (latest === undefined) {
        state.credentialRotationRecovery = {
          kind,
          name,
          phase: 'superseded',
          returnedFromServerUpdate: true,
          ...(initialServerUpdateCompletion === null
            ? {}
            : {
                serverUpdateVerification:
                  initialServerUpdateCompletion,
              }),
        };
        render();
        focusGuideTarget(
          '[data-action="connections-dismiss-credential-rotation"]',
        );
        settleCredentialRotationServerUpdateRetry(kind, name);
        return;
      }
      if (
        typeof latest.updated_at !== 'number'
        || !Number.isSafeInteger(latest.updated_at)
      ) {
        state.credentialRotationRecovery = {
          kind,
          name,
          phase: 'restart_waiting',
          resumePreflightOnReconnect: true,
          returnedFromServerUpdate: true,
          ...(initialServerUpdateCompletion === null
            ? {}
            : {
                serverUpdateVerification:
                  initialServerUpdateCompletion,
              }),
        };
        render();
        focusGuideTarget(
          '[data-action="connections-start-fresh-credential-rotation"]',
        );
        return;
      }
      state.credentialRotationRecovery = {
        kind,
        name,
        phase: 'restart_ready',
        baselineUpdatedAt: latest.updated_at,
        returnedFromServerUpdate: true,
        ...(initialServerUpdateCompletion === null
          ? {}
          : {
              serverUpdateVerification: initialServerUpdateCompletion,
            }),
      };
      void startFreshCredentialRotation(kind, name);
    });
  }

  return {
    getState: () => state,
    refresh: async () => {
      // Re-pull the send-from options too (a mail account may have been
      // enrolled elsewhere since mount); list settle drives the returned promise.
      void hydrateMailOptions();
      await Promise.all([
        reconcileCredentialRotationTabs({ type: 'reconcile' }),
        reconcileCredentialRotation(),
      ]);
    },
    whenLoaded: () => pendingLoad,
    setPostSafeStopProfileContext: (context) => {
      const activeProfileLabel = context.activeProfileLabel.trim();
      if (activeProfileLabel.length === 0) return;
      postSafeStopProfileLabel = activeProfileLabel;
      if (postSafeStopProfileHandoff !== null) {
        const sourceProfileLabel = context.sourceProfileLabel?.trim();
        postSafeStopProfileHandoff = {
          reason: postSafeStopProfileHandoff.reason,
          activeProfileLabel,
          serverProfilesAvailable:
            postSafeStopProfileHandoff.serverProfilesAvailable,
          ...(sourceProfileLabel !== undefined && sourceProfileLabel.length > 0
            ? { sourceProfileLabel }
            : {}),
        };
      }
      renderPreservingActiveField();
    },
    hasInFlightWork: () => submitInFlight
      || pendingOAuth !== null
      || guideInFlight
      || credentialRotationActivityCheck !== null
      || credentialRotationSafeStopCheck !== null
      || state.dialog.credentialCorrection?.safeStopClosure?.phase
        === 'acknowledging'
      || credentialRotationOwnershipLease !== null
      || state.dialog.saving
      || state.mcpPackReview?.saving === true
      || state.probeInFlight.size > 0
      || state.deleteConfirm?.deleting === true
      || state.engagementHealth.reprobing.size > 0,
    hasUnsavedChanges: hasUnsavedConnectionDraft,
    unsavedChangesPrompt: connectionDraftLeavePrompt,
    getMcpPackInstallScope: effectiveMcpPackInstallScope,
    clickMcpPackAccessOption: setMcpPackGrantAccess,
    setMcpPackInstallAudience: setMcpPackGrantAudience,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      invalidateCredentialRotationSafeStopCheck();
      invalidateCredentialSafeStopAcknowledgement();
      if (
        credentialRotationServerUpdateRetryTarget !== null
        && !credentialRotationServerUpdateRetrySettled
      ) {
        try {
          opts.onCredentialRotationServerUpdateRetryInterrupted?.(
            credentialRotationServerUpdateRetryTarget,
          );
        } catch {
          // Route teardown must continue even if host continuity bookkeeping
          // is unavailable. The persisted phase already remains secret-free.
        }
      }
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
      for (const unsubscribe of packInventoryUnsubscribers.splice(0)) {
        try {
          unsubscribe();
        } catch {
          // The subscriber owns teardown; one listener cannot block the rest.
        }
      }
      detachReconnect?.();
      credentialRotationTabUnsub?.();
      credentialRotationTabUnsub = null;
      credentialRotationServerUpdateUnsub?.();
      credentialRotationServerUpdateUnsub = null;
      cancelCredentialRotationPoll();
      cancelCredentialRotationSuccessorPoll();
      invalidateCredentialRotationActivityCheck();
      const marker = opts.credentialRotationContinuity?.read() ?? null;
      if (
        credentialRotationOwnershipLease !== null
        && (
          marker === null
          || connectionRowKey(marker.kind, marker.name)
            !== credentialRotationOwnershipLease.key
        )
      ) releaseCredentialRotationOwnership(true);
      detachActions();
      host.removeEventListener('input', onFieldEvent);
      host.removeEventListener('change', onFieldEvent);
      host.innerHTML = '';
    },
  };
};
