/** D-148 § A.4 — Thin Webclient.
 *
 *  P4 entrypoint. The webclient is a thin display-only client to the
 *  user's `recued-server`. It stores ONLY the closed-list 5 fields per
 *  spec § A.4.1 (`server_url`, `webclient_token`, `server_public_key`,
 *  `pair_metadata`, `cert_pin_state`); ephemeral session state lives
 *  in `sessionStorage`; cached UI assets live in the SW cache. No
 *  vault. No recipes. No engine. No durable application state. "Clear
 *  this browser" wipes the IDB store + sessionStorage + the SW cache;
 *  the user re-pairs to re-enter.
 *
 *  Hard rule (D-148 invariant I-11 + role-boundary lint): the
 *  webclient is forbidden from importing `@recued/engine`,
 *  `@recued/recipes`, `@recued/storage`, `@recued/cache`,
 *  `@recued/scheduler`, or `@recued/marketplace`. The role-boundary
 *  lint test (`role-boundary/lint.test.ts`) scans every TS file under
 *  `src/` and asserts no matches.
 */

export { WEBCLIENT_RESERVATION_MARKER } from './reservation.js';
export {
  createInMemoryWebclientLocalStore,
  createIndexedDbWebclientLocalStore,
  WEBCLIENT_LOCAL_KEYS,
} from './storage/local-store.js';
export type { WebclientLocalStore } from './storage/local-store.js';
export {
  createWebclientTokenStore,
  WEBCLIENT_TOKEN_AES_PARAMS,
} from './storage/token-store.js';
export type { WebclientTokenStore, WebclientTokenWrapDeps } from './storage/token-store.js';
export { clearThisBrowser } from './auth/clear-this-browser.js';
export type { ClearThisBrowserOptions, ClearThisBrowserResult } from './auth/clear-this-browser.js';
// D-148 § A.4 — webclient PWA entrypoint exports. The `main()` boot
// IIFE lives in `webclient-main.ts` (bundled to `build/`); the named
// export below is the Codex P2 fold for "Clear this browser" — the
// future Settings → Privacy UI passes it to
// `clearThisBrowser({ crypto_keys_wiper })` so the AES key store
// (recued.webclient.token_key) is wiped alongside the closed-list 5
// fields. Re-exporting from the barrel keeps the consumer surface tidy.
export { wipeWebclientCryptoKeyStore } from './webclient-main.js';

// D-148 § A.4.1 — Settings → Privacy "Clear this browser" panel (slice 109).
// Self-contained DOM panel that composes `clearThisBrowser` +
// `unregisterServiceWorker` behind a two-tap destructive-guard UX.
export {
  mountClearThisBrowserPanel,
  CLEAR_THIS_BROWSER_PANEL_STYLES,
  CLEAR_THIS_BROWSER_PANEL_ATTR,
  CLEAR_THIS_BROWSER_PANEL_STATE_ATTR,
  CLEAR_THIS_BROWSER_CLEAR_BTN_ATTR,
  CLEAR_THIS_BROWSER_CONFIRM_BTN_ATTR,
  CLEAR_THIS_BROWSER_CANCEL_BTN_ATTR,
  CLEAR_THIS_BROWSER_RETRY_BTN_ATTR,
  CLEAR_THIS_BROWSER_RELOAD_BTN_ATTR,
  CLEAR_THIS_BROWSER_STATUS_ATTR,
  CLEAR_THIS_BROWSER_RESULT_ATTR,
} from './settings/clear-this-browser-panel.js';
export type {
  MountClearThisBrowserPanelOptions,
  ClearThisBrowserPanelMount,
  ClearThisBrowserPanelState,
} from './settings/clear-this-browser-panel.js';

// D-148 § A.4.1 — Settings route bootstrap (slice 110 + 111).
// `WebclientRouteId = 'settings'` arm of the bootstrap; hosts the
// Privacy section (Clear this browser panel) at slice 110 + the
// Server section (TLS renew panel) at slice 111. Webclient-main
// threads the production `wipeWebclientCryptoKeyStore` through
// `bootstrapWebclient`'s `cryptoKeysWiper` option so the AES-GCM key
// store is wiped end-to-end; the production `tls.renew` caller is
// composed inside `bootstrapWebclient` from the rpc conn.
export {
  bootstrapSettingsRoute,
  SETTINGS_ROUTE_ROOT_ATTR,
  SETTINGS_ROUTE_SECTION_ATTR,
  SETTINGS_ROUTE_STYLES_MARKER,
  SETTINGS_ROUTE_STYLES,
  SETTINGS_ROUTE_NAV_ATTR,
  SETTINGS_ROUTE_NAV_ITEM_ATTR,
  SETTINGS_ROUTE_VIEWS_ATTR,
  SETTINGS_ROUTE_ACTIVE_ATTR,
  SETTINGS_ROUTE_SUBTAB_ATTR,
  SETTINGS_ROUTE_SUBTAB_PANEL_ATTR,
} from './settings/bootstrap-settings-route.js';
export type {
  BootstrapSettingsRouteOptions,
  SettingsRoute,
} from './settings/bootstrap-settings-route.js';

// D-174/D-175 — Settings -> Account binding touchpoint.
export {
  mountAccountBindingPanel,
  ACCOUNT_BINDING_PANEL_ATTR,
  ACCOUNT_BINDING_PANEL_STATE_ATTR,
  ACCOUNT_BINDING_LOADING_ATTR,
  ACCOUNT_BINDING_ERROR_ATTR,
  ACCOUNT_BINDING_RETRY_ATTR,
  ACCOUNT_BINDING_STATUS_CHIP_ATTR,
  ACCOUNT_BINDING_SUMMARY_ATTR,
  ACCOUNT_BINDING_CONNECT_ATTR,
  ACCOUNT_BINDING_CONFIRM_REBIND_ATTR,
  ACCOUNT_BINDING_CANCEL_REBIND_ATTR,
  ACCOUNT_BINDING_UNBIND_ATTR,
  ACCOUNT_BINDING_UNBIND_CONFIRMATION_ATTR,
  ACCOUNT_BINDING_CONFIRM_UNBIND_ATTR,
  ACCOUNT_BINDING_CANCEL_UNBIND_ATTR,
  ACCOUNT_BINDING_SIGNOUT_ATTR,
  ACCOUNT_BINDING_SESSION_ATTR,
  ACCOUNT_BINDING_DASHBOARD_LINK_ATTR,
  ACCOUNT_BINDING_FREE_CARD_ATTR,
  ACCOUNT_BINDING_FREE_HANDLE_ATTR,
  ACCOUNT_BINDING_FREE_CLAIM_ATTR,
  ACCOUNT_BINDING_PUBLISHING_LINK_ATTR,
  ACCOUNT_BINDING_PRO_ITEM_ATTR,
  ACCOUNT_BINDING_PRO_LIFECYCLE_ATTR,
  ACCOUNT_BINDING_PRO_SUBSCRIBE_ATTR,
  ACCOUNT_BINDING_ACTION_MESSAGE_ATTR,
  ACCOUNT_BINDING_PANEL_STYLES,
  type AccountBindingPanelMount,
  type AccountBindingPanelState,
  type AccountBindingStatusCaller,
  type AccountBindCaller,
  type AccountUnbindCaller,
  type ProConvenienceStatusCaller,
  type AccountBindingTokenMintCaller,
  type AccountBindingSessionCaller,
  type AccountSignOutCaller,
} from './settings/account-binding-panel.js';
export {
  createAccountBindingAuthClient,
  resolveAccountBindingAuthWorkerUrl,
  resolveAccountBindingDashboardUrl,
  type AccountBindingAuthClient,
  type AccountBindingAuthSession,
  type AccountBindingAuthUser,
  type AccountBindingFetch,
  type BindingTokenMintResponse,
  type CreateAccountBindingAuthClientOptions,
} from './settings/account-binding-auth-client.js';

// D-174 P5 — Compose local draft surface. Freeform capture commits to
// contact.upsert or work_entity.upsert for the four atomic local kinds.
export {
  bootstrapComposeRoute,
  COMPOSE_LOCAL_TARGETS,
  COMPOSE_ROUTE_STYLES,
  COMPOSE_ROUTE_STYLES_MARKER,
  COMPOSE_ROUTE_HOST_ATTR,
  COMPOSE_ROUTE_HEADING_ATTR,
  COMPOSE_ROUTE_INTENT_ATTR,
  COMPOSE_ROUTE_TARGET_CHIP_ATTR,
  COMPOSE_ROUTE_FIELD_ATTR,
  COMPOSE_ROUTE_COMMIT_ATTR,
  COMPOSE_ROUTE_CONFIRMATION_ATTR,
  COMPOSE_ROUTE_STATUS_ATTR,
  COMPOSE_ROUTE_ERROR_ATTR,
  COMPOSE_ROUTE_PREVIEW_ATTR,
  COMPOSE_ROUTE_RECEPTION_LINK_ATTR,
  COMPOSE_ROUTE_KITCHEN_LINK_ATTR,
  type BootstrapComposeRouteOptions,
  type ComposeContactUpsertCaller,
  type ComposeLocalTargetKind,
  type ComposeRoute,
  type ComposeRouteStage,
  type ComposeRouteState,
  type ComposeWorkEntityUpsertCaller,
} from './compose/compose-route.js';

export {
  bootstrapIngredientBuilderRoute,
  INGREDIENT_BUILDER_ADD_ROW_ATTR,
  INGREDIENT_BUILDER_FIELD_ATTR,
  INGREDIENT_BUILDER_REMOVE_ROW_ATTR,
  INGREDIENT_BUILDER_REVIEW_STATUS_ATTR,
  INGREDIENT_BUILDER_ROUTE_ATTR,
  INGREDIENT_BUILDER_ROW_ATTR,
  INGREDIENT_BUILDER_SAVE_ATTR,
  INGREDIENT_BUILDER_SLUG_ATTR,
  INGREDIENT_BUILDER_STATUS_ATTR,
  INGREDIENT_BUILDER_STYLES,
  INGREDIENT_BUILDER_STYLES_MARKER,
  INGREDIENT_BUILDER_TABLE_ATTR,
  INGREDIENT_BUILDER_TITLE_ATTR,
  type BootstrapIngredientBuilderRouteOptions,
  type IngredientBuilderConn,
  type IngredientBuilderRoute,
  type IngredientBuilderSaveStage,
  type OperationFamilyRowDraft,
} from './kitchen/ingredient-builder/operation-family-table.js';

// The cockpit (`home/`) was retired in shell-frame Step 5 — the chat home is
// the default landing; its content re-homed to the bell / Log / live-control
// bubble / composer buttons (§D.L1). No `home/*` exports remain.

// D-148 § A.6.5 — Settings → Server "Renew TLS cert now" panel (slice 111).
// Self-contained DOM panel that composes the `tls.renew` rpc behind a
// two-tap operator-intentional guard. The Settings route mounts this
// inside its `<section data-recued-settings-section="server">` when
// `bootstrapWebclient` is configured with `enableTlsRenewPanel !== false`.
export {
  mountTlsRenewPanel,
  TLS_RENEW_PANEL_STYLES,
  TLS_RENEW_PANEL_ATTR,
  TLS_RENEW_PANEL_STATE_ATTR,
  TLS_RENEW_RENEW_BTN_ATTR,
  TLS_RENEW_CONFIRM_BTN_ATTR,
  TLS_RENEW_CANCEL_BTN_ATTR,
  TLS_RENEW_RETRY_BTN_ATTR,
  TLS_RENEW_CLOSE_BTN_ATTR,
  TLS_RENEW_STATUS_ATTR,
  TLS_RENEW_FINGERPRINT_ATTR,
  TLS_RENEW_ROTATED_AT_ATTR,
  TLS_RENEW_ERROR_CODE_ATTR,
} from './settings/tls-renew-panel.js';
export type {
  MountTlsRenewPanelOptions,
  TlsRenewPanelMount,
  TlsRenewPanelState,
  TlsRenewCaller,
} from './settings/tls-renew-panel.js';

// R26.4 Delta 3 (D-148 § A.11) — Settings → Server → Key Health page
// (Rotation Center). Mounts in the Server section when `bootstrapWebclient`
// is configured with `enableKeyHealthPanel !== false`.
export {
  mountKeyHealthPanel,
  KEY_HEALTH_PANEL_STYLES,
  KEY_HEALTH_PANEL_ATTR,
  KEY_HEALTH_PANEL_STATE_ATTR,
  KEY_HEALTH_CARD_ATTR,
  KEY_HEALTH_CARD_CLASS_ATTR,
  KEY_HEALTH_ROTATE_BTN_ATTR,
  KEY_HEALTH_COMPROMISE_BTN_ATTR,
  KEY_HEALTH_CONFIRM_BTN_ATTR,
  KEY_HEALTH_CANCEL_BTN_ATTR,
  KEY_HEALTH_CLOSE_BTN_ATTR,
  KEY_HEALTH_BACK_BTN_ATTR,
  KEY_HEALTH_RETRY_BTN_ATTR,
  KEY_HEALTH_STATUS_ATTR,
  KEY_HEALTH_COMPROMISE_BANNER_ATTR,
  KEY_HEALTH_ERROR_CODE_ATTR,
  KEYFILE_POSTURE_CARD_ATTR,
  KEYFILE_POSTURE_TONE_ATTR,
  KEYFILE_POSTURE_CONSEQUENCE_ATTR,
  KEYFILE_POSTURE_REMEDIATION_ATTR,
} from './settings/key-health-panel.js';
export type {
  MountKeyHealthPanelOptions,
  KeyHealthPanelMount,
  KeyHealthPanelState,
  KeyHealthLoader,
  KeyRotateCaller,
  SystemStatusLoader,
} from './settings/key-health-panel.js';

// D-212 §7.10 — the keyfile-posture projection behind that card. Exported
// so the next surface to render the posture reuses these words instead of
// paraphrasing them (`'none'` and `null` must not converge).
export { describeKeyfilePosture } from './settings/keyfile-posture.js';
export type {
  KeyfileSealing,
  KeyfilePostureInput,
  KeyfilePostureTone,
  KeyfilePostureView,
} from './settings/keyfile-posture.js';

export {
  createWebclientWsClient,
  WEBCLIENT_WS_RECONNECT_INITIAL_MS,
  WEBCLIENT_WS_RECONNECT_MAX_MS,
  WebclientReauthRequiredError,
} from './realtime/ws-client.js';
export type {
  WebclientWsClient,
  WebclientWsTransport,
  WebclientWsState,
} from './realtime/ws-client.js';

// D-148 § A.4.2 — production browser-WebSocket-backed transport. The
// factory consumers wire into `bootstrapWebclient({ transport })`. Tests
// keep the in-memory loopback they already use; production code path
// hits this module.
export {
  createBrowserWebclientTransport,
  buildDefaultConnectUrl,
  WEBCLIENT_WS_SUBPROTOCOL,
  WEBCLIENT_AUTH_CLOSE_CODES,
  type BrowserWebclientTransportOptions,
  type BrowserWebSocketConstructor,
  type BrowserWebSocketLike,
} from './realtime/browser-transport.js';
export {
  createBroadcastSubscriber,
  WEBCLIENT_DEFAULT_SUBSCRIPTIONS,
} from './realtime/subscriber.js';
export type {
  BroadcastSubscriber,
  BroadcastListener,
} from './realtime/subscriber.js';

// D-148 § A.4.4 — `token.rotated` broadcast handler. Closes the
// credential-refresh loop: wraps + persists + applies a server-issued
// rotation push so the next WS reconnect uses the fresh bearer.
// Sibling clients (the user's other paired surfaces) filter on
// `target_token_id` mismatch and no-op.
export {
  createTokenRotationHandler,
  type CreateTokenRotationHandlerOptions,
  type TokenRotationHandler,
  type TokenRotationFailureContext,
  type TokenRotationFailureStage,
} from './realtime/token-rotation.js';
// D-148 § A.6.5 — cert-pin rotation handler. Subscribes to
// `cert.rotation_notice` + `cert.rotation_reverted`, verifies the
// Ed25519 signature against the pinned `server_public_key`, drives
// the two-pin overlap protocol in `WebclientLocalStore.cert_pin_state`.
export {
  createCertPinHandler,
  applyRotationNoticeToState,
  applyRotationRevertedToState,
  type CertPinHandler,
  type CertPinFailureContext,
  type CertPinFailureStage,
  type CreateCertPinHandlerOptions,
} from './realtime/cert-pin.js';
// D-148 § A.6.5 — cert-pin state watcher (slice 113). In-memory
// mirror of `cert_pin_state` feeding the Settings → Server overlap
// panel. Wired as the cert-pin handler's `onStateChanged` callback;
// reads the cold-boot snapshot via `refresh()`.
export {
  createCertPinStateWatcher,
  type CertPinStateWatcher,
  type CreateCertPinStateWatcherOptions,
} from './realtime/cert-pin-state-watcher.js';
// D-148 § A.6.5 — Settings → Server cert-pin overlap panel
// (slice 113). Renders an info-toned "Cert pin rotation pending"
// block during the 7d overlap window; hides on `current_valid_until
// <= now` and when no `next_fingerprint` is staged.
export {
  mountCertPinStalePanel,
  buildCertPinStaleView,
  CERT_PIN_STALE_PANEL_STYLES,
  CERT_PIN_STALE_PANEL_ATTR,
  CERT_PIN_STALE_TITLE_ATTR,
  CERT_PIN_STALE_FLIP_AT_ATTR,
  CERT_PIN_STALE_CURRENT_FP_ATTR,
  CERT_PIN_STALE_NEXT_FP_ATTR,
  CERT_PIN_STALE_COPY,
  type MountCertPinStalePanelOptions,
  type CertPinStalePanelMount,
  type CertPinStaleView,
} from './settings/cert-pin-stale-panel.js';
export {
  createSurfaceSnapshotCache,
} from './state-snapshot/surface-cache.js';
export type {
  SurfaceSnapshotCache,
  SurfaceSnapshotEntry,
} from './state-snapshot/surface-cache.js';
export {
  createInternalStepStream,
} from './internal-steps/stream.js';
export type {
  InternalStepStream,
  InternalStepListener,
} from './internal-steps/stream.js';
export {
  buildKeyHealthRows,
  KEY_HEALTH_STATUS_ORDER,
} from './settings/key-health.js';
export type { KeyHealthRow } from './settings/key-health.js';
export {
  buildExposureSwitcherModel,
  isPresetTransitionAllowed,
  isPathResolutionTransitionAllowed,
} from './settings/exposure-profile.js';
export type {
  ExposureSwitcherModel,
  ExposureTransitionEvaluation,
  ExposureTransitionError,
} from './settings/exposure-profile.js';

// D-148 W3.8 — Settings → Server → Exposure page + the /mcp.public + /ws modals.
export {
  EXPOSURE_PRESET_COPY,
  EXPOSURE_PATH_COPY,
  EXPOSURE_ERROR_COPY,
  buildExposurePageModel,
  buildPresetDispatch,
  buildPathResolutionDispatch,
  buildPublicMcpDispatch,
  projectWsLockoutPhrase,
  projectPresetWsLockout,
  projectPathWsLockout,
  projectRequiresPublicMcpAck,
  projectCellToggle,
  WS_LOCKOUT_DISCONNECT_PHRASE,
  WS_LOCKOUT_DISABLE_PHRASE,
} from './settings/exposure-surface.js';
export type {
  ExposurePresetRow,
  ExposurePathRow,
  ExposurePageModel,
  ExposurePresetDispatch,
  ExposurePathResolutionDispatch,
  ExposurePublicMcpDispatch,
  ExposureDispatch,
  WsLockoutPhrase,
} from './settings/exposure-surface.js';
export {
  PUBLIC_MCP_MODAL_COPY,
  PUBLIC_MCP_ACKNOWLEDGEMENT_PHRASE,
  openPublicMcpModal,
  typePublicMcpPhrase,
  closePublicMcpModal,
  submitPublicMcpModal,
  failPublicMcpModal,
  isPublicMcpAcknowledgementActive,
} from './settings/public-mcp-modal.js';
export type {
  PublicMcpModalKind,
  PublicMcpModalState,
  PublicMcpSubmitOutcome,
} from './settings/public-mcp-modal.js';
export {
  WS_LOCKOUT_MODAL_COPY,
  pickWsLockoutFlavor,
  requiredPhraseForFlavor,
  openWsLockoutModal,
  typeWsLockoutPhrase,
  closeWsLockoutModal,
  submitWsLockoutModal,
  failWsLockoutModal,
} from './settings/ws-lockout-modal.js';
export type {
  WsLockoutCallerChannel,
  WsLockoutFlavor,
  WsLockoutTrigger,
  WsLockoutModalState,
  WsLockoutSubmitOutcome,
} from './settings/ws-lockout-modal.js';
export {
  TLS_CERT_SOURCE_LABEL,
  TLS_UPLOAD_ISSUE_COPY,
  TLS_CERT_MIN_VALIDITY_MS,
  TLS_CERTIFICATES_PANEL_STYLES,
  TLS_CERTS_EMPTY_ATTR,
  TLS_CERTS_ERROR_ATTR,
  TLS_CERTS_ISSUE_ATTR,
  TLS_CERTS_PANEL_ATTR,
  TLS_CERTS_REMOVE_CANCEL_BTN_ATTR,
  TLS_CERTS_REMOVE_CONFIRM_BTN_ATTR,
  TLS_CERTS_REMOVE_OPEN_BTN_ATTR,
  TLS_CERTS_RESULT_ATTR,
  TLS_CERTS_ROW_ATTR,
  TLS_CERTS_ROW_SEVERITY_ATTR,
  TLS_CERTS_STATUS_ATTR,
  TLS_CERTS_UPLOAD_CANCEL_BTN_ATTR,
  TLS_CERTS_UPLOAD_FIELD_ATTR,
  TLS_CERTS_UPLOAD_FILE_ATTR,
  TLS_CERTS_UPLOAD_FORM_ATTR,
  TLS_CERTS_UPLOAD_OPEN_BTN_ATTR,
  TLS_CERTS_UPLOAD_SUBMIT_BTN_ATTR,
  buildTLSCertRow,
  buildTLSCertificatesPageModel,
  buildTLSDomainUploadDispatch,
  buildTLSDomainRemoveDispatch,
  extractUploadIssues,
  mountTlsCertificatesPanel,
  projectUploadValidation,
} from './settings/tls-certificates.js';
export type {
  MountTlsCertificatesPanelOptions,
  TLSCertRow,
  TLSCertRowSeverity,
  TLSCertificatesPageModel,
  TLSDomainUploadDispatch,
  TLSDomainRemoveDispatch,
  TLSDomainUploadFormState,
  TlsCertificatesPanelMount,
  TlsCertificatesPanelState,
  TlsCertificatesUploadFormValues,
  TlsDomainListCaller,
  TlsDomainRemoveCaller,
  TlsDomainUploadCaller,
} from './settings/tls-certificates.js';

export {
  collectWebclientImports,
  scanForForbiddenImports,
} from './role-boundary/lint.js';
export type { ForbiddenImportFinding } from './role-boundary/lint.js';

// D-137 P1.4 — chat surface state reducer + model-routing badge.
export {
  initialChatThreadState,
  hydrateThreadFromSnapshot,
  beginInFlightTurn,
  reduceChatThreadEvent,
  isChatThreadEvent,
  buildModelRoutingBadge,
  CHAT_MODEL_ROUTING_LAYER_OPTIONS,
  type ChatThreadState,
  type InFlightTurn,
  type InFlightToolCall,
  type ModelRoutingBadge,
  type ModelRoutingBadgeKind,
  type ResolvedModelRoutingBadge,
  type PendingModelRoutingBadge,
} from './chat/index.js';

// D-149 follow-on § A.9 — Reception page shell. The stateful container
// that wires the § A.9 spine + the five satellite projection modules
// (`reception/reception*.ts`) to the `reception.*` rpc surface + the
// reception broadcast subscription. The projection modules themselves
// stay deep-importable from `reception/`; this barrel surfaces the
// integration layer the host PWA mounts.
// ⚠ They lived under `settings/` until 2026-09-16 — a deep import of
// `settings/reception-*.js` will not resolve.
export {
  createReceptionPageShell,
  RECEPTION_PAGE_SHELL_BROADCAST_KINDS,
  type ReceptionConn,
  type ReceptionPageShell,
  type ReceptionPageShellDeps,
  type ReceptionPageShellState,
  type ReceptionPageShellError,
  type LaunchWizardRunResult,
} from './reception/page-shell.js';

// D-149 follow-on § A.9 — Reception page renderer + mount. The
// host-side framework renderer: `renderReceptionPage` projects
// `ReceptionPageShellState` to an HTML string (the `renderConnectionsPage`
// shape); `mountReceptionPage` subscribes the shell to a host element +
// installs the delegated `data-action` dispatcher (the `mountServerPill`
// shape). The first webclient↔`@recued/ui-shared` consumer.
export {
  renderReceptionPage,
  mountReceptionPage,
  resolveReceptionActiveView,
  RECEPTION_PAGE_ACTIONS,
  RECEPTION_PAGE_NATIVE_ACTIONS,
  RECEPTION_PAGE_STYLES,
  RECEPTION_SETTINGS_LINK_ATTR,
  RECEPTION_APPROVALS_COUNT_ATTR,
  type ReceptionPageAction,
  type ReceptionActiveView,
  type ReceptionPageView,
  type ReceptionPageViewOptions,
} from './reception/page-render.js';

// D-149 follow-on § A.9 + § A.5.x — per-kind authoring-form renderer.
// `renderAuthoringForm` projects a `<Kind>FormModel` (from
// `authoring.ts`) into an HTML string, tagging every control
// with the `data-field-*` / `data-repeater-*` markup a working-config
// container binds value edits to + a typed `data-action` on every
// discrete button. Pure projection — the `mountX` + working-config
// container is the next unit (see the module docstring).
export {
  renderAuthoringForm,
  AUTHORING_FORM_ACTIONS,
  RECEPTION_AUTHORING_STYLES,
  type AuthoringFormAction,
  type AuthoringFormView,
} from './reception/authoring-render.js';

// D-149 follow-on § A.20.1 — Launch Wizard renderer. `renderLaunchWizard`
// projects the cursor-driven stepper + validation gate + plan preview
// (from `launch-wizard.ts`) into an HTML string. Owns the
// wizard *frame*; the per-step content goes into a host-filled
// `data-wizard-step` slot. Pure projection — same `renderReceptionPage`
// shape, no `mountX` (see the module docstring).
export {
  renderLaunchWizard,
  LAUNCH_WIZARD_ACTIONS,
  LAUNCH_WIZARD_STYLES,
  type LaunchWizardAction,
  type LaunchWizardRenderView,
} from './reception/launch-wizard-render.js';

// D-149 follow-on § A.9 + § A.5.x — per-kind authoring-form mount. The
// stateful working-config container the authoring renderer was built
// for: `mountAuthoringForm` seeds a per-kind config blob, wires the
// renderer's `data-field-*` / `data-action` markup, and drives the
// `reception.*` rpc (preview → create / page upsert) through the
// `ReceptionPageShell`. The `mountReceptionPage` shape. The shared
// working-config machinery (`seedWorkingConfig` / `applyFieldDelegateEvent`
// / …) stays deep-importable from `reception/reception-authoring-mount.js`.
export {
  mountAuthoringForm,
  type AuthoringFormMount,
  type AuthoringFormMountOptions,
} from './reception/authoring-mount.js';

// D-149 follow-on § A.20.1 — Launch Wizard mount. The wizard's
// step-cursor + per-step working-config container: `mountLaunchWizard`
// holds the four config-editing steps' working configs + the cursor +
// the `include_drop_link` decision, injects `renderAuthoringForm` into
// the renderer's `data-wizard-step` slot, and on finish fires
// `buildLaunchWizardDispatchPlan` → `shell.runLaunchWizard`.
export {
  mountLaunchWizard,
  LAUNCH_WIZARD_MOUNT_STYLES,
  type LaunchWizardMount,
  type LaunchWizardMountOptions,
} from './reception/launch-wizard-mount.js';

// D-149 follow-on § A.9 + § A.20.1 — Reception Settings host runtime.
// The composition target the prior phases were building toward: catches
// the page mount's `onUnhandledAction` forwards + mounts the right
// satellite (`mountAuthoringForm` / `mountLaunchWizard`) into a separate
// overlay element, derives the per-kind `PacketDeclaration` (default
// factory covers `scheduling_link` / `intake_form` / `drop_link`; the
// consumer overrides for `approval_link` / `status_link`), and on close
// registers each `share_url_once` via `shell.setEndpointShare` so the
// next `openDetail` draws the § A.20.4 Share Cards.
export {
  mountReceptionPageHost,
  buildDefaultPacketDeclaration,
  RECEPTION_HOST_MOUNT_ACTIONS,
  RECEPTION_HOST_PROMPT_ACTIONS,
  type ReceptionHostMountAction,
  type ReceptionHostPromptAction,
  type ReceptionPageHost,
  type ReceptionPageHostOptions,
} from './reception/page-host.js';

// D-149 follow-on § A.9 — Reception Settings prompts host runtime. The
// fourth host element in the Reception Settings composition: catches
// the page host's `onPromptAction` bridge and renders the appropriate
// modal for each of the four prompt-driven forwards
// (`reception-extend` / `reception-rotate-token` / `reception-revoke` /
// `reception-emergency-disable-all`). On rotate-token success it looks
// the row up in the shell's loaded page model and registers the fresh
// one-shot `share_url_once` via `shell.setEndpointShare` so the next
// `openDetail` surfaces the rotated Share Cards.
export {
  mountReceptionPromptsHost,
  RECEPTION_PROMPT_ACTIONS,
  RECEPTION_PROMPT_KINDS,
  RECEPTION_EMERGENCY_DISABLE_CONFIRM_PHRASE,
  RECEPTION_PROMPTS_HOST_STYLES,
  type ReceptionPromptAction,
  type ReceptionPromptKind,
  type ReceptionPromptsHost,
  type ReceptionPromptsHostOptions,
} from './reception/prompts-host.js';

// D-149 follow-on § A.9 — Reception Settings composition (PWA shell).
// The three Reception Settings hosts — page list + satellite modal +
// prompts modal — wired into one combined surface. Mount order, dispose
// order, and the `onPromptAction → promptsHost.open` bridge all live
// here so the eventual `app.recued.com` Reception route stays a thin
// "build three DOM elements + call mountReceptionSettings" entrypoint.
export {
  mountReceptionSettings,
  RECEPTION_SETTINGS_SHELL_SLOTS,
  RECEPTION_SETTINGS_SHELL_STYLES,
  type ReceptionSettingsHost,
  type ReceptionSettingsOptions,
  type ReceptionSettingsShellSlot,
} from './reception/settings-host.js';

// D-149 follow-on § A.9 — Reception Settings route entrypoint. The PWA-
// shell layer on top of `mountReceptionSettings`: owns the two rpc
// reads the settings host externalises (`reception.page.get` +
// `reception.template.list`), maintains the caches `resolvePageConfig`
// + `resolveTemplateSeed` read from, refreshes the page-config cache
// on every shell-state change so post-upsert / post-broadcast reads
// stay fresh.
export {
  mountReceptionRoute,
  type ReceptionRoute,
  type ReceptionRouteConn,
  type ReceptionRouteOptions,
} from './reception/route.js';

// D-149 follow-on § A.9 — Reception Settings PWA bootstrap. The DOM
// boundary above `mountReceptionRoute` — the ONE place in the webclient
// that calls `document.createElement`. Builds the three slot divs +
// injects the aggregated CSS payload (`PRIMITIVE_STYLES` + every
// Reception-specific style constant) into `document.head` once
// (idempotent), then mounts `mountReceptionRoute` over them.
export {
  bootstrapReceptionRoute,
  RECEPTION_BOOTSTRAP_STYLES,
  RECEPTION_BOOTSTRAP_STYLES_MARKER,
  type BootstrapReceptionRouteOptions,
} from './reception/bootstrap.js';

// D-148 § A.4.2 — webclient typed rpc conn over the fire-and-forget WS
// client. Generates a fresh request_id, sends `{ type: 'rpc', … }`
// through `ws.send`, registers a pending entry, resolves on the
// matching `{ type: 'rpc_result', request_id, … }` reply. Owns
// request-id correlation + timeouts + AbortSignal + reauth mapping
// + lifecycle teardown. The conn the Reception shell (+ every future
// Settings shell) takes as `deps.call`.
export {
  createWebclientRpcConn,
  WEBCLIENT_RPC_DEFAULT_TIMEOUT_MS,
  type WebclientRpcConn,
  type WebclientRpcRequestEnvelope,
  type WebclientRpcResultEnvelope,
} from './realtime/rpc-conn.js';

// D-148 § A.4 — PWA-wide webclient bootstrap. The composition layer
// that wires pair-state hydration + the WS client + the broadcast
// subscriber + the typed rpc conn + the Reception page shell + the
// URL-hash route discriminator + the Reception route mount into one
// runnable PWA. Throws `WebclientUnpairedError` when invoked before
// pairing; otherwise returns a handle whose `dispose()` tears every
// constructed surface down in reverse order.
export {
  bootstrapWebclient,
  parseRouteFromHash,
  WebclientUnpairedError,
  WEBCLIENT_DEFAULT_ROUTE,
  WEBCLIENT_ROUTE_IDS,
  type BootstrapWebclientOptions,
  type WebclientHandle,
  type WebclientHashSource,
  type WebclientRouteId,
} from './webclient-bootstrap.js';

// D-148 § A.4 — service-worker registration helper. The HTML's inline
// registration covers boot; this helper is the programmatic API the
// bundle uses for `update()` / `unregister()` / `clearCaches()`. The
// Settings → Privacy "Clear this browser" surface calls
// `unregisterServiceWorker` directly (paired with `clearThisBrowser`).
export {
  registerServiceWorker,
  unregisterServiceWorker,
  clearServiceWorkerCaches,
  WEBCLIENT_SERVICE_WORKER_URL,
  WEBCLIENT_SERVICE_WORKER_SCOPE,
  type RegisterServiceWorkerOptions,
  type ServiceWorkerEnvironment,
  type ServiceWorkerHandle,
  type ServiceWorkerContainerShape,
  type ServiceWorkerRegistrationShape,
  type CacheStorageShape,
} from './runtime/service-worker.js';
