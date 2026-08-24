/** D-148 § A.4 — PWA-wide webclient bootstrap.
 *
 *  This is the composition layer that wires the webclient's
 *  independently-shipped substrates into a runnable single-page app:
 *
 *    1. **Pair state hydration** — reads the closed-list 5 fields from
 *       `WebclientLocalStore`, asserts the post-pair invariant
 *       (`webclient_token` + `server_url` + `server_public_key`
 *       present), and surfaces the unwrap AAD context for the bearer
 *       resolver. A pre-pair launch throws
 *       `WebclientUnpairedError` so the caller can route to the
 *       (separately-shipped) pair-blob input flow.
 *    2. **WS client** — `createWebclientWsClient` over the supplied
 *       transport, with `resolveBearer` plumbed to unwrap on each
 *       connect attempt (so a rotated bearer is picked up without
 *       restart) + `resolveServerUrl` reading the same store.
 *    3. **Broadcast subscriber** — `createBroadcastSubscriber` wired to
 *       the ws-client's `onMessage` stream; the conn factory + the
 *       subscriber coexist on the stream because they filter on
 *       disjoint envelope fields (`type === 'rpc_result'` vs
 *       `kind === '<broadcast>'`).
 *    4. **Typed rpc conn** — `createWebclientRpcConn` over the ws-client
 *       (request_id correlation + timeouts + AbortSignal + reauth
 *       mapping); the resulting `Conn<ServerRpcRegistry>` is the input
 *       every Settings shell already takes.
 *    5. **Reception page shell** — `createReceptionPageShell` over the
 *       conn + subscriber. Home / Reception / Settings / Approvals /
 *       Compose mount through the same route registry.
 *    6. **Route discriminator** — URL-hash based (`#reception`,
 *       defaults to Home). Reads `location.hash` once at boot +
 *       once per `hashchange`. Forward-compatible: adding Connections
 *       / Exposure / Devices is a one-line registry entry once those
 *       surfaces ship their own bootstrap.
 *    7. **Reception bootstrap call** — `bootstrapReceptionRoute` over
 *       the supplied root element + the constructed shell + conn.
 *
 *  ── Key design decisions (non-obvious — READ before touching) ──────
 *
 *  DD#1 — The bootstrap takes a SEAM for `transport` (not a built-in
 *  WebSocket factory). The webclient ships no real-WebSocket factory
 *  yet (P4 wired transport mocking + a future "production" transport
 *  that opens `new WebSocket(server_url, ['recued.v1'])` with the
 *  bearer in the `Sec-WebSocket-Protocol` header is its own phase).
 *  Until that lands, the bootstrap composes whatever transport the
 *  consumer provides — tests inject an in-memory loopback; a
 *  productionised consumer would inject the WebSocket-backed one.
 *
 *  DD#2 — `resolveBearer` re-reads the token-store on every call. The
 *  WS client's reconnect loop invokes `resolveBearer` per attempt
 *  (`ws-client.ts` line 261-263). A token rotation that lands via
 *  `token.rotated` broadcast + a writeback to the store will be
 *  observed by the next reconnect without restart. We never CACHE the
 *  unwrapped bearer here — keeping the plaintext in memory between
 *  WS opens would defeat the whole AES-GCM-on-storage design.
 *
 *  DD#3 — The WS client is `connect()`-ed inside the bootstrap (not
 *  left dormant for the caller). The reception page shell calls
 *  `loadPage()` synchronously from its mount path; a dormant ws-client
 *  would queue + drain on the first explicit `connect`. We auto-connect
 *  + treat the queue as an implementation detail of the
 *  disconnect/reconnect lifecycle rather than the boot-up flow.
 *
 *  DD#4 — The route discriminator's default is the chat home
 *  (`WEBCLIENT_DEFAULT_ROUTE`, §D.L1 shell-frame Step 5 — it replaced
 *  the retired cockpit). An unknown hash also routes there (rather than
 *  throwing); rationale: a fresh-pair user has no last-route bookmark,
 *  so the safest landing is the act-first chat home. Routing-error UX
 *  is a polish phase, not a boot blocker.
 *
 *  DD#5 — Initial-pair status seeding uses pessimistic defaults
 *  (`reception_public: false`, `emergency_disabled: false`,
 *  `base_url: null`). The bootstrap consumes `exposure_changed` and
 *  calls the reception shell's `setStatus` when the `/reception`
 *  public bit changes; the boot-time status is "we don't know yet,
 *  render the safe view". The reception page model handles
 *  `base_url: null` natively (renders the "no domain configured"
 *  empty state).
 *
 *  DD#6 — `dispose()` tears down in REVERSE construction order:
 *  Reception route → reception shell → rpc conn → ws client → hash
 *  listener. The route owns the DOM; the shell owns broadcast
 *  subscriptions; the conn owns pending entries; the ws-client owns
 *  the socket. Reversing on teardown means downstream pending callers
 *  reject through the conn (carrying `transport_disposed`) BEFORE the
 *  ws-client's socket closes raw — surfacing the typed error rather
 *  than a transport-drop scramble.
 *
 *  DD#7 — the `token.rotated` broadcast handler is wired BEFORE the
 *  ws-client connects so a rotation broadcast in the very first
 *  events.subscribe replay window is observed. The handler is
 *  forward-compatible with sibling clients (filters on
 *  `target_token_id`); only the targeted client mutates local state.
 *  Failures inside the handler are reported through
 *  `onTokenRotationError` (best-effort) and degrade to the
 *  next-reconnect 401 → reauth_required → re-pair path — they never
 *  abort the bootstrap or surface as a thrown error to the dispatch
 *  loop.
 *
 *  DD#8 — the bootstrap fires `events.subscribe` immediately after
 *  `ws.connect()` resolves. Without that round-trip the server's
 *  broadcast bus has no subscription record for this client and fans
 *  nothing out (`backend/server/src/events/handler.ts` only adds the
 *  push closure when `events.subscribe` is invoked). The call is
 *  fire-and-forget — a failure leaves the page in its initial /
 *  cached-state view until the next `ws.connect()` retries. The
 *  subscription set covers every kind the webclient cares about
 *  (`WEBCLIENT_DEFAULT_SUBSCRIPTIONS`), including `token.rotated`,
 *  reception, chat, warehouse, approvals, and the rest.
 *
 *  DD#9 — the re-pair banner (§ A.6.5) mounts as a SIBLING of the
 *  active route, not a child of it. The bootstrap appends one extra
 *  `<div data-recued-webclient-banner>` to `options.root` BEFORE
 *  `bootstrapReceptionRoute` fires; the banner mount renders into
 *  that slot. Two reasons it can't live inside the route mount:
 *    (a) Lifetime — the banner outlives any single route. A route
 *        switch (hashchange) would tear the route's DOM down + with
 *        it the banner mount; the bus event would re-fire only on the
 *        next `pair_required` (latest-wins handler), losing the
 *        signal in between.
 *    (b) Layout — the banner is positioned `fixed` at the top of the
 *        viewport. Mounting it inside the route's `position: relative`
 *        container would constrain it; mounting at the root keeps it
 *        viewport-level above every modal except Reception's modal /
 *        prompts (which use `z-index: 100/200`; the banner uses 50).
 *  The bootstrap also injects `RE_PAIR_BANNER_STYLES` + a tiny
 *  banner-slot positioning rule into `<head>`, marker-guarded so a
 *  re-bootstrap (e.g. after dispose) skips the duplicate injection.
 *
 *  DD#10 — § A.6.5 / slice 114 — cert-pin overlap panel polling tick.
 *  The cert-pin overlap panel (slice 113) hides at render-time when
 *  `current_valid_until <= now`, but without a periodic re-render the
 *  clock crossing the flip time is invisible to the user until the
 *  next watcher transition (a `cert.rotation_*` broadcast or a route
 *  flip). The bootstrap wires a `CERT_PIN_POLL_INTERVAL_MS` (60s)
 *  ticker that calls `activeSettingsRoute?.certPinStalePanel()?.update()`
 *  so the panel naturally auto-hides on the clock crossing
 *  `current_valid_until` even without a broadcast. The ticker runs for
 *  the bootstrap's lifetime — when Reception is active or the panel
 *  is unmounted, the optional-chained `update()` call short-circuits
 *  to a no-op. Gated on `certPinWatcher !== null` (no watcher → no
 *  panel → no value in ticking). Seam: `setCertPinPollTimer` defaults
 *  to a `globalThis.setInterval`-backed impl; tests inject a fake
 *  that captures the handler so they can drive ticks deterministically.
 *
 *  Spec: D-148 § A.4 (Thin Webclient). */

import type {
  Conn,
  DiagnosticResponse,
  HostnameProjection,
  ReachabilityReport,
  RpcRequest,
  ServerRpcRegistry,
  WebclientServerProfile,
  WebclientTokenRecord,
} from '@recued/contracts';
import {
  encodeBearerSubprotocol, canBindHostname } from '@recued/contracts';
import {
  bindRecordRefSearchToRecipe,
  createRecordRefSearchCaller,
} from './record-ref-search.js';
import {
  RunModal, Upload } from '@recued/ui-shared';

import {
  createBroadcastSubscriber,
  WEBCLIENT_DEFAULT_SUBSCRIPTIONS,
  type BroadcastSubscriber,
} from './realtime/subscriber.js';
import {
  createWebclientRpcConn,
  type WebclientRpcConn,
} from './realtime/rpc-conn.js';
import {
  createWebclientWsClient,
  type WebclientWsClient,
  type WebclientWsTransport,
} from './realtime/ws-client.js';
import {
  createWebclientConnectionStatus,
  reconnectSubscriberFromStatus,
  type WebclientConnectionStatusController,
  type WebclientReconnectSubscriber,
} from './realtime/connection-status.js';
import {
  mountConnectionIndicator,
  CONNECTION_INDICATOR_STYLES,
  CONNECTION_INDICATOR_STYLES_MARKER,
  type ConnectionIndicatorMount,
} from './shell/connection-indicator.js';
import {
  SERVER_SWITCHER_STYLES,
  serverSwitchReviewCoversActiveWork,
  serverSwitchReviewCoversWorkState,
  serverSwitchWorkStateHasChatDraft,
  type ServerSwitchWorkState,
} from './shell/server-switcher.js';
import {
  createServerSwitchWorkTracker,
  type ServerSwitchActiveWork,
  type ServerSwitchWorkDetails,
  type ServerSwitchWorkLease,
} from './shell/server-switch-work-tracker.js';
import {
  mountAccountMenu,
  ACCOUNT_MENU_TRIGGER_ATTR,
  ACCOUNT_MENU_STYLES,
  ACCOUNT_MENU_STYLES_MARKER,
  type AccountMenuMount,
} from './shell/account-menu.js';
import { humanizeRpcError } from './shell/rpc-error-copy.js';
import { runSelfPairRevocation } from './shell/server-profile-revocation.js';
import {
  consumeServerSwitchArrival,
  requestServerSwitchReload,
  safeServerSwitchLandingHash,
  serverSwitchLandingAreaLabel,
  type RecoveryReturnContext,
  type ServerSwitchContinuityStorage,
} from './shell/server-switch-continuity.js';
import {
  reconcileRecoveryContext,
  recoveryReturnAfterReconnectReceipt,
  recoveryReturnReceipt,
  type RecoveryContextProbe,
  type RecoveryReturnReceipt,
} from './shell/recovery-return-reconciliation.js';
import {
  focusRecoveryIntentLanding,
  mountRecoveryIntentOrientation,
  type RecoveryLandingIntent,
} from './shell/recovery-intent-landing.js';
import {
  createRecoveryIntentContinuationStore,
  createRecoveryIntentDeferredCheckStore,
  type RecoveryIntentContinuation,
  type RecoveryIntentContinuationStorage,
  type RecoveryIntentDeferredCheck,
  type RecoveryIntentReviewVerification,
} from './shell/recovery-intent-continuation.js';
import {
  mountServerSwitchConvergence,
  type ServerSwitchConvergenceIdentity,
  type ServerSwitchConvergenceMount,
  type ServerSwitchConvergenceState,
} from './shell/server-switch-convergence.js';
import {
  isUnresolvedServerControlActionOutcome,
  mountWebclientServerPill,
  isServerHeartbeatSnapshot,
  SERVER_PILL_STYLES,
  SERVER_PILL_STYLES_MARKER,
  SERVER_PILL_HOST_ATTR,
  type ServerControlActionOutcome,
  type ServerControlCurrentStateObservation,
  type WebclientServerPillMount,
} from './shell/server-pill-host.js';
import { WEBCLIENT_WS_SUBPROTOCOL } from './realtime/browser-transport.js';
import {
  createTokenRotationHandler,
  type TokenRotationFailureContext,
} from './realtime/token-rotation.js';
import {
  createCertPinHandler,
  type CertPinFailureContext,
} from './realtime/cert-pin.js';
import {
  createCertPinStateWatcher,
  type CertPinStateWatcher,
} from './realtime/cert-pin-state-watcher.js';
import {
  runPassportFetchVerify,
  type PassportFetchVerifyFailureContext,
  type PassportFetchVerifyPairRequiredContext,
} from './realtime/passport-fetch-verify.js';
import {
  bootstrapReceptionRoute,
  type BootstrapReceptionRouteOptions,
} from './settings/reception-bootstrap.js';
import { createArchiveDownload } from './settings/archive-download.js';
import { createArchiveUpload } from './settings/archive-upload.js';
import { createArchiveRebindStash } from './settings/archive-rebind-stash.js';
import {
  bootstrapSettingsRoute,
  type SettingsRoute,
} from './settings/bootstrap-settings-route.js';
import type {
  TlsDomainListCaller,
  TlsDomainRemoveCaller,
  TlsDomainUploadCaller,
} from './settings/tls-certificates.js';
import type {
  HousekeepingConfigReadCaller,
  HousekeepingConfigWriteCaller,
  HousekeepingDismissPromotionCaller,
  HousekeepingRegistryDescribeCaller,
  HousekeepingRunNowCaller,
  HousekeepingStatusReadCaller,
  HousekeepingTopicResetCaller,
  HousekeepingTrustReadCaller,
  HousekeepingTrustWriteCaller,
} from './settings/housekeeping-panel-mount.js';
import {
  bootstrapApprovalsRoute,
  type ApprovalChangedSubscriber,
  type ApprovalListCaller,
  type ApprovalResolveCaller,
  type ApprovalSubscribeCaller,
} from './approvals/bootstrap-approvals-route.js';
import { bootstrapMailRoute } from './mail/bootstrap-mail-route.js';
import {
  createPendingChatPlansStore,
  type PendingChatPlansStore,
} from './approvals/pending-chat-plans-store.js';
import {
  bootstrapContractsRoute,
  isContractsListTab,
} from './contracts/bootstrap-contracts-route.js';
import {
  type GrantReadCaller,
  type GrantReadByEntryCaller,
  type GrantWriteCaller,
  type GrantContractsCaller,
  type GrantContractsCaller as GrantMatrixContractsCaller,
  type GrantCatalogOperationsCaller,
  type GrantRecipeOpUsageCaller,
  type GrantRecipeListCaller,
  // The cli reachability pair the by-pack ACCESS panel writes its cli op
  // toggles through (the roster-wide Local tools grid that used to own these
  // rpcs is retired — ACCESS + `#contracts` are the two surviving axes).
  type GrantCliReachabilityListCaller,
  type GrantCliReachabilitySetCaller,
  type GrantRegistryDescribeCaller,
  type GrantSetDoorTypesCaller,
} from './contracts/contract-grants-panel.js';
import {
  bootstrapConnectionsRoute,
  parseConnectionsCredentialRotationRetry,
  resolveProfileBoundPostSafeStopRecovery,
  serializeConnectionsCredentialRotationRetry,
  serializeConnectionsPostSafeStopRecovery,
} from './connections/bootstrap-connections-route.js';
import {
  bootstrapPacksRoute,
  resolvePackInput,
} from './packs/bootstrap-packs-route.js';
import type {
  OwnerOperationDeleteCaller,
  OwnerOperationInventoryCaller,
  OwnerOperationListCaller,
  OwnerOperationUpsertCaller,
} from './settings/owner-operation-controls.js';
import {
  bootstrapRecipesRoute,
  type RecipeConfigSetCaller,
  type RecipeExecuteCaller,
  type RecipesListCaller,
  type RecipesPiiCaller,
  type RecipesRunnabilityCaller,
  type RecipesSchedulesCreateCaller,
  type RecipesToolCatalogCaller,
} from './recipes/bootstrap-recipes-route.js';
import { fileRefOptionsFromMirrorResults } from './recipes/file-ref-picker.js';
import { mountDiscoverySurface } from './discover/discovery-surface.js';
import { mountRecipeDiscovery } from './discover/recipe-discovery.js';
import {
  fetchPackCatalog,
  fetchRecipeCatalog,
} from './discover/catalog-client.js';
import {
  bootstrapDataRoute,
  type DataContactDeleteCaller,
  type DataContactContributionsCaller,
  type DataContactGetCaller,
  type DataContactListCaller,
  type DataContactMergeConfirmCaller,
  type DataContactMergeListCaller,
  type DataContactMergeRejectCaller,
  type DataContactMergeScanNowCaller,
  type DataContactSourceListCaller,
  type DataContactImportCandidatesCaller,
  type DataContactImportPromoteCaller,
  type DataContactImportFilePreviewCaller,
  type DataContactImportFileApplyCaller,
  type DataContactUpsertCaller,
  type DataMirrorSearchCaller,
  type DataFileReadCaller,
  type DataCollectionGetCaller,
  type DataCollectionListCaller,
  type DataCollectionListInstancesCaller,
  type DataAnnotationListCaller,
  type DataLinkListCaller,
  type DataSharedListCaller,
  type DataRecordsNamespaceListCaller,
  type DataRecordsKindListCaller,
  type DataRecordsSearchCaller,
  type DataRecordsGetCaller,
  type DataRecordsDeleteCaller,
  type DataRecordsRetentionListCaller,
  type DataRecordsExportCaller,
  type DataRecordsOutboxListCaller,
  type DataRecordsOutboxRetireCaller,
  type DataRecordsPurgeCaller,
  type DataFormResponseGetCaller,
  type DataFormResponseListCaller,
  type DataFormResponseUpdateCaller,
  type DataFormResponseSetStateCaller,
  type DataFormResponseExportCaller,
  type DataMemoryCreateCaller,
  type DataMemoryDeleteCaller,
  type DataMemoryGetCaller,
  type DataMemoryImportCaller,
  type DataMemoryListCaller,
  type DataMemoryUpdateCaller,
  type DataManageRescheduleLinkCaller,
  type DataTimelineCaller,
  type DataUploadCreateCaller,
  type DataUploadDeleteCaller,
  type DataUploadFinalizeCaller,
  type DataUploadProbeCaller,
  type DataWorkEntityDeleteCaller,
  type DataWorkEntityGetCaller,
  type DataWorkEntityListCaller,
  type DataWorkEntityUpsertCaller,
  type WorkEntitySourceListCaller,
} from './data/bootstrap-data-route.js';
import {
  bootstrapLogsRoute,
  type RunsActiveCaller,
  type RunsCancelCaller,
  type RunsGetCaller,
  type RunsKillCaller,
  type RunsListCaller,
  type RunsPromoteCaller,
  type RunsSessionGrantListCaller,
  type RunsSessionGrantRevokeCaller,
} from './logs/bootstrap-logs-route.js';
import {
  bootstrapAutomationRoute,
  isAutomationSectionToken,
  type AuthStateCaller as AutomationAuthStateCaller,
  type AutoRunListCaller as AutomationAutoRunListCaller,
  type DishesListCaller as AutomationDishesListCaller,
  type DishesUpdateCaller as AutomationDishesUpdateCaller,
  type DishesDeleteCaller as AutomationDishesDeleteCaller,
  type DishesCreateCaller as AutomationDishesCreateCaller,
  type DishesHistoryCaller as AutomationDishesHistoryCaller,
  type AutoRunUpdateCaller as AutomationAutoRunUpdateCaller,
  type RecipeNamesCaller as AutomationRecipeNamesCaller,
  type SchedulesDeleteCaller as AutomationSchedulesDeleteCaller,
  type SchedulesListCaller as AutomationSchedulesListCaller,
  type SchedulesUpdateCaller as AutomationSchedulesUpdateCaller,
  type TriggersDeleteCaller as AutomationTriggersDeleteCaller,
  type TriggersListCaller as AutomationTriggersListCaller,
  type TriggersUpdateCaller as AutomationTriggersUpdateCaller,
  type WatchListCaller as AutomationWatchListCaller,
  type WatchUpdateCaller as AutomationWatchUpdateCaller,
  type WatchRunNowCaller as AutomationWatchRunNowCaller,
} from './automation/bootstrap-automation-route.js';
import {
  bootstrapChatRoute,
  type ChatRouteRecoveryDraft,
  type ChatRouteConn,
} from './chat/bootstrap-chat-route.js';
import {
  parseConnectedSourceChatSetup,
  parseChatConnectedSource,
  projectChatConnectedSourceStatus,
  serializeChatConnectedSource,
} from './chat/connected-source-handoff.js';
import {
  openCreateOverlay,
  type CreateOverlayHandle,
} from './compose/create-overlay.js';
import {
  bootstrapIngredientBuilderRoute,
  type IngredientBuilderConn,
} from './kitchen/ingredient-builder/operation-family-table.js';
import {
  mountFormResponseRecipeSeedRoute,
  mountRecipeEditorRoute,
} from './kitchen/recipe-editor/mount-recipe-editor-route.js';
import { mountKitchenChrome } from './kitchen/kitchen-route-chrome.js';
import { injectWebclientPolishStyles } from './shell/webclient-polish-styles.js';
import {
  WEBCLIENT_ROUTE_IDS,
  WEBCLIENT_DEFAULT_ROUTE,
  kitchenEditRecipeId,
  kitchenNewRecipeSeed,
  kitchenPackDraftId,
  parseChatAnswerAddress,
  parseChatPlanAddress,
  parseChatSessionAddress,
  parseDataEntityVerificationAddress,
  parseLogsRunAddress,
  parseRouteFromHash,
  parseShellRoute,
  parseSourceRecordAddress,
  parseSourceRecordVerificationAddress,
  serializeShellRoute,
  shouldRemountForSameRoute,
  type WebclientRouteId,
} from './shell/route.js';
import type {
  NotificationsDescribeBridgesCaller,
  NotificationsDescribeCaller,
  NotificationsSetBridgeModeCaller,
  NotificationsSetChannelCaller,
  NotificationsSetVerificationPhraseCaller,
} from './settings/notifications-panel.js';
import type {
  PacksInstallBySlugCaller,
  PacksInstallPreviewCaller,
  PacksInstallCaller,
  PacksListCaller,
  PacksResolveCaller,
  PacksUninstallCaller,
} from './settings/packs-panel.js';
import type {
  SupervisionListCaller,
  SupervisionReachabilityCaller,
  SupervisionSetCaller,
} from './settings/supervision-controls.js';
import type {
  AsksListCaller,
  AsksSubmitAnswerCaller,
} from './approvals/asks-panel.js';
import {
  NOTIFY_TOASTS_STYLES,
  NOTIFY_TOASTS_STYLES_MARKER,
  mountNotifyToasts,
  type NotifyToastsMount,
} from './notify-toasts.js';
import {
  mountApprovalAttentionPopover,
  type AttentionInactiveConnectionRecoveryHint,
  type AttentionRecoveryExcursionReturn,
  type AttentionRecoveryIntentContinuation,
  type AttentionRecoveryIntentExpiryHandoff,
  type AttentionRecoveryIntentInterruption,
  type AttentionRecoveryIntentRemediation,
  type AttentionRecoveryIntentReviewTarget,
  type ApprovalAttentionPopoverMount,
} from './attention/approval-attention-popover.js';
import {
  createBrowserInactiveProfileRecoveryDiscovery,
  createInactiveProfileRecoveryReviewContinuity,
  type InactiveProfileRecoveryStorage,
  type InactiveProfileRecoveryReviewState,
} from './attention/inactive-profile-recovery.js';
import {
  mountLiveControlBubble,
  type LiveControlBubbleMount,
} from './live-control/live-control-bubble.js';
import {
  mountThemeToggle,
  THEME_TOGGLE_ATTR,
  THEME_TOGGLE_STYLES,
  type ThemeToggleMount,
} from './shell/theme-controller.js';
import type {
  MailLaneCallers,
  CalendarLaneCallers,
  FileLaneCallers,
} from './connections/accounts-lane-panel.js';
import { createFoundationalOAuthContinuity } from './connections/foundational-oauth-continuity.js';
import type { FoundationalOAuthContinuityStorage } from './connections/foundational-oauth-reload.js';
import {
  createProviderSetupContinuityStore,
  type ProviderSetupContinuityStorage,
} from './connections/provider-setup-continuity.js';
import {
  createCredentialRotationContinuityStore,
  type CredentialRotationContinuityStorage,
} from './connections/credential-rotation-continuity.js';
import {
  classifyCredentialRotationServerUpdateTriage,
  createCredentialRotationServerUpdateContinuity,
  type CredentialRotationServerUpdateContinuityStorage,
  type CredentialRotationServerUpdateTarget,
} from './connections/credential-rotation-server-update-continuity.js';
import {
  createBrowserCredentialRotationTabConvergence,
  type CredentialRotationTabConvergence,
  type CredentialRotationTabHint,
  type CredentialRotationTabStorage,
  type ServerUpdateTabProgress,
} from './connections/credential-rotation-tab-convergence.js';
import {
  createServerUpdateReceiptVerification,
  type ServerUpdateReceiptVerificationController,
  type ServerUpdateReceiptVerificationScheduler,
} from './connections/server-update-receipt-verification.js';
import type {
  WebhooksCreateCaller,
  WebhooksCredentialRetireCaller,
  WebhooksCredentialWriteCaller,
  WebhooksDeliveryEventGetCaller,
  WebhooksDeliveryGetCaller,
  WebhooksDeliveryListCaller,
  WebhooksDisableCaller,
  WebhooksEnableCaller,
  WebhooksListCaller,
  WebhooksManualConfirmCaller,
  WebhooksRegistrationReconcileCaller,
  WebhooksRejectedDeliveryListCaller,
  WebhooksRetireCaller,
  WebhooksTestDeliveryCaller,
  WebhooksRetentionPruneCaller,
} from './connections/webhooks-panel.js';
import type {
  ConnectionsCompleteVendorOAuthCaller,
  ConnectionsEnrollListCaller,
  ConnectionsEnrollCaller,
  ConnectionsRotateCredentialsCaller,
  ConnectionsCredentialRotationStatusCaller,
  ConnectionsCredentialRotationActivityCaller,
  ConnectionsAcknowledgeCredentialRotationSafeStopCaller,
  ConnectionsCredentialRotationServerUpdateTriageCaller,
  ConnectionsUpdateCaller,
  ConnectionsDeleteCaller,
  ConnectionsPreviewPurgeCaller,
  ConnectionsProbeCaller,
  ConnectionsMcpPackPreviewCaller,
  ConnectionsMcpPackCommitCaller,
  ConnectionsGetMatchPatternsCaller,
  ConnectionsSetMatchPatternsCaller,
  ConnectionsEngagementHealthCaller,
  ConnectionsReprobeEngagementCapabilitiesCaller,
  ConnectionsMailListCaller,
  ConnectionsStartVendorOAuthCaller,
  ConnectionsTakeVendorOAuthResultCaller,
  ConnectionsSuggestSetupCaller,
} from './settings/connections-enroll-panel.js';
import type {
  ConnectionsGrantGroupCaller,
  ConnectionsListCaller,
  ConnectionsListGroupsCaller,
  ConnectionsRevokeGroupCaller,
} from './settings/connections-grant-panel.js';
import type {
  PermissionsListOverridesCaller,
  PermissionsDeleteOverrideCaller,
  PermissionsUpsertOverrideCaller,
  PermissionsListCatalogOperationsCaller,
  PermissionsListInboundTokensCaller,
  PermissionsIssueInboundTokenCaller,
  PermissionsRevokeInboundTokenCaller,
  PermissionsUpdateInboundTokenCaller,
  PermissionsToolCatalogCaller,
  PermissionsMintContractCaller,
  PermissionsRevokeContractCaller,
  PermissionsListContractsCaller,
  PermissionsUpdateInboundContractCaller,
} from './settings/permissions-panel.js';
import type {
  ContractsListCaller,
  ContractsRevokeCaller,
} from './settings/contracts-panel.js';
import type {
  SuggestionsAcceptCaller,
  SuggestionsDismissCaller,
  SuggestionsListCaller,
} from './contracts/suggested-rules-panel.js';
import type {
  ScopedSuggestionsAcceptCaller,
  ScopedSuggestionsDismissCaller,
  ScopedSuggestionsListCaller,
} from './contracts/scoped-grant-panel.js';
import type {
  LlmResultCacheClearCaller,
  LlmResultCacheStatsCaller,
} from './settings/llm-result-cache-card-mount.js';
import type {
  TransparencyPrefsGetCaller,
  TransparencyPrefsSetCaller,
} from './settings/transparency-panel.js';
import {
  LEARNING_DRAFT_RPC_TIMEOUT_MS,
  type LearningCaseForgetCaller,
  type LearningCasesListCaller,
  type LearningDraftRecipeCaller,
  type LearningPrefsGetCaller,
  type LearningPrefsSetCaller,
} from './settings/learning-panel.js';
import {
  RECIPE_DRAFT_CONFIRMATION,
  RECIPE_REFINE_CONFIRMATION,
} from '@recued/contracts';
import {
  readExecutionCaseDraft,
  stashExecutionCaseDraft,
  type ExecutionCaseDraftStorage,
} from './kitchen/recipe-editor/execution-case-draft-stash.js';
import {
  mountExecutionCaseDraftRoute,
} from './kitchen/recipe-editor/mount-execution-case-draft-route.js';
import type {
  AiModelsConfigFieldSetCaller,
  AiModelsConfigSchemaGetCaller,
  AiModelsHousekeepingConfigReadCaller,
  AiModelsHousekeepingConfigWriteCaller,
  AiModelsLlmConfigGetCaller,
  AiModelsLlmSlotSetCaller,
  AiModelsEmbeddingsSlotSetCaller,
  AiModelsFreePoolEntryUpsertCaller,
  AiModelsFreePoolEntryRemoveCaller,
  AiModelsFreePoolEntryEnabledCaller,
  AiModelsSetChatCatalogModeCaller,
  AiModelsLlmPromptsGetCaller,
  AiModelsLlmPromptSetCaller,
  AiModelsProbeSourceCaller,
  ChatDefaultModelPrefGetCaller,
  ChatDefaultModelPrefSetCaller,
} from './settings/ai-models-page.js';
import type {
  SellerListOrdersCaller,
  SellerMailListCaller,
  SellerManualCustomerCloseCaller,
  SellerManualCustomerExtendCaller,
  SellerManualCustomerIssueCaller,
  SellerManualCustomerReissueTokenCaller,
  SellerManualCustomerSwapTierCaller,
  SellerAcknowledgeLlmGatewayPaidCaller,
  SellerManualTierBulkAdjustCaller,
  SellerManualTierUpsertCaller,
  SellerTierUsagePolicyCaller,
  SellerCreatePassTierCaller,
  SellerOfferStateTransitionCaller,
  SellerOverviewCaller,
  SellerSettingsUpdateCaller,
  SellerStripeSynchronizeCaller,
} from './settings/seller-page.js';
import type {
  UpdateCheckCaller,
  UpdateModeGetCaller,
  UpdateModeSetCaller,
  UpdateApplyCaller,
  UpdateRollbackCaller,
} from './settings/updates-page.js';
import type {
  DdnsSetEnabledCaller,
  DdnsStatusCaller,
  HostnamesAddCaller,
  HostnamesGetCaller,
  HostnamesListCaller,
  HostnamesRemoveCaller,
  HostnamesUpdateCaller,
  HostnamesVerifyOwnershipCaller,
  NetworkLocalUrlsCaller,
} from './settings/hostnames.js';
import type {
  CustomDomainPreflightCaller,
  CustomDomainReadinessCaller,
} from './settings/custom-domains.js';
import type {
  ExposureApplyPresetCaller,
  ExposureGetCaller,
  ExposureHasDdnsCaller,
  ExposureSetApexCaller,
  ExposureSetPathResolutionCaller,
  ExposureSetPublicMcpAckCaller,
} from './settings/exposure-panel.js';
import type {
  AccountBindCaller,
  AccountBindingSessionCaller,
  AccountBindingStatusCaller,
  AccountBindingTokenMintCaller,
  AccountSignOutCaller,
  AccountUnbindCaller,
  ProConvenienceStatusCaller,
} from './settings/account-binding-panel.js';
import {
  createAccountBindingAuthClient,
  resolveAccountBindingDashboardUrl,
  type AccountBindingFetch,
} from './settings/account-binding-auth-client.js';
import {
  createReachabilityDiagnosticProbeCaller,
  diagnosticResponseShowsReachableUrl,
  type ReachabilityDiagnosticFetch,
  type ReachabilityExternalProbeCaller,
} from './settings/reachability.js';
import type { ClearThisBrowserResult } from './auth/clear-this-browser.js';
import { serverKeyFingerprint } from './auth/server-fingerprint.js';
import {
  createReceptionPageShell,
  type ReceptionPageShell,
} from './settings/reception-page-shell.js';
import type {
  ReceptionStatusInput,
} from './settings/reception.js';
import type {
  WebclientLocalStore,
  WebclientProfileStore,
} from './storage/local-store.js';
import { defaultProfileLabel } from './storage/server-profiles.js';
import type {
  WebclientTokenStore,
  WebclientTokenAad,
} from './storage/token-store.js';

// ════════════════════════════════════════════════════════════════
// Route registry + errors
// ════════════════════════════════════════════════════════════════

// The route registry + the `#surface/subview/item[/subtab]` parser/serializer
// live in `./shell/route.js` (the §D.shell central router, R16). Re-exported
// here so the package barrel + existing imports keep resolving against the
// shell composition root.
export {
  WEBCLIENT_ROUTE_IDS,
  WEBCLIENT_DEFAULT_ROUTE,
  parseRouteFromHash,
};
export type { WebclientRouteId };

export const WEBCLIENT_SHELL_STYLES_MARKER =
  'data-recued-webclient-shell-styles';
export const WEBCLIENT_SHELL_HOST_ATTR = 'data-recued-webclient-shell';
export const WEBCLIENT_SHELL_TOPBAR_ATTR = 'data-recued-webclient-topbar';
export const WEBCLIENT_SHELL_ATTENTION_HOST_ATTR =
  'data-recued-webclient-attention-host';
export const WEBCLIENT_SHELL_CONNECTION_HOST_ATTR =
  'data-recued-webclient-connection-host';
// §D.L2 — the navigation drawer hooks (rev R7). Replaces the flat
// `…-rail` chrome: `…-drawer` is the off-canvas panel, `…-toggle` the
// top-bar ☰ that opens it, `…-backdrop` the click-to-close scrim, and
// `…-open` the boolean state attribute the shell host carries while open
// (CSS keys the slide-in + the scrim off it).
export const WEBCLIENT_SHELL_DRAWER_ATTR = 'data-recued-webclient-drawer';
export const WEBCLIENT_SHELL_DRAWER_LINK_ATTR =
  'data-recued-webclient-drawer-link';
export const WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR =
  'data-recued-webclient-drawer-active';
export const WEBCLIENT_SHELL_DRAWER_TOGGLE_ATTR =
  'data-recued-webclient-drawer-toggle';
export const WEBCLIENT_SHELL_DRAWER_BACKDROP_ATTR =
  'data-recued-webclient-drawer-backdrop';
export const WEBCLIENT_SHELL_DRAWER_OPEN_ATTR =
  'data-recued-webclient-drawer-open';
/** A disabled "coming soon" drawer seat (a not-yet-built destination).
 *  Carries the seat id. No seat uses it today — retained for a future stub. */
export const WEBCLIENT_SHELL_DRAWER_STUB_ATTR =
  'data-recued-webclient-drawer-stub';
/** An ACTION drawer seat — a button that fires a shell callback instead of
 *  navigating (the §D.L2 "Create" seat opens the shared Create overlay, the
 *  same modal as the L1 composer button). Carries the seat id. */
export const WEBCLIENT_SHELL_DRAWER_ACTION_ATTR =
  'data-recued-webclient-drawer-action';
/** The Account and server-profiles control in the top bar (§D.L1). */
export const WEBCLIENT_SHELL_ACCOUNT_ATTR =
  'data-recued-webclient-account';
export const WEBCLIENT_SHELL_CONTENT_ATTR =
  'data-recued-webclient-content';

/**
 * §D.L2 — the navigation drawer (LOCKED 2026-06-19, rev R7). ONE flat list of
 * destinations ordered by frequency + action (the gradient do → look → manage
 * → review → config), grouped only by subtle dividers — the prior
 * Workspace/Back-office split is retired (it was arbitrary). Each
 * `WebclientDrawerSection` renders its items then a divider; the trailing
 * `pinnedBottom` section (Settings / Account) sinks to the drawer foot.
 *
 * Wiring: `New chat` → `#chat/new`; `Chats` → `#chat` (the history home is the
 * empty-hash default landing, §D.L1 Step 5). `Create` is an ACTION seat that opens the shared
 * Create overlay (the same 4-kind capture as the L1 composer button — it
 * absorbed the retired `#compose` route), `Account` → `#settings/account`.
 * `Packs` is its own
 * `#packs` route (D-187 §6 follow-on — the browse → detail surface over the
 * catalog ∪ installed roster), promoted out of Settings. `home`/`kitchen`/`approvals` are
 * deliberately absent: the cockpit was
 * retired (chat is the landing), Kitchen is reached via Recipes/Packs
 * [Author/Edit], Approvals is the top-bar 🔔 bell.
 */
interface WebclientDrawerItem {
  /** Stable seat id — unique even when two seats share a `route`. */
  readonly id: string;
  readonly label: string;
  /** Where this seat navigates, or `null` for a not-yet-built stub / an action
   *  seat (which fires a shell callback instead of navigating). */
  readonly route: WebclientRouteId | null;
  /** Optional positional tail for a distinct destination on the same route.
   * `New chat` uses `['new']` so it cannot collapse into the Chats history
   * landing while still participating in the shell's leave guard. */
  readonly segments?: ReadonlyArray<string>;
  /** Leading affordance glyph for action seats (`+ New chat`, `✎ Create`). */
  readonly glyph?: string;
  /** Whether this seat owns the active highlight for its `route`. EXACTLY one
   *  seat per route sets this, so same-surface destinations (New chat + Chats
   *  under Chat, Settings + Account under Settings) light a single row. */
  readonly highlight?: boolean;
  /** A disabled "coming soon" seat — no link, no navigation, no highlight. */
  readonly stub?: boolean;
  /** An action seat — a button that fires a shell callback rather than
   *  navigating. `'create'` opens the shared Create overlay. */
  readonly action?: 'create';
}

interface WebclientDrawerSection {
  readonly items: ReadonlyArray<WebclientDrawerItem>;
  /** Sinks this section to the drawer foot (the config tier: Settings/Account). */
  readonly pinnedBottom?: boolean;
}

const WEBCLIENT_DRAWER_SECTIONS: ReadonlyArray<WebclientDrawerSection> = [
  {
    items: [
      {
        id: 'new-chat',
        label: 'New chat',
        glyph: '+',
        route: 'chat',
        segments: ['new'],
      },
      { id: 'chats', label: 'Chats', route: 'chat', highlight: true },
    ],
  },
  {
    items: [
      { id: 'create', label: 'Create', glyph: '✎', route: null, action: 'create' },
      { id: 'data', label: 'Data', route: 'data', highlight: true },
      { id: 'recipes', label: 'Recipes', route: 'recipes', highlight: true },
      { id: 'automation', label: 'Automation', route: 'automation', highlight: true },
    ],
  },
  {
    // The control-plane stack — dependency order: reach → bundle+access → grantee.
    items: [
      { id: 'connections', label: 'Connections', route: 'connections', highlight: true },
      { id: 'packs', label: 'Packs', route: 'packs', highlight: true },
      { id: 'contracts', label: 'Contracts', route: 'contracts', highlight: true },
      { id: 'reception', label: 'Reception', route: 'reception', highlight: true },
    ],
  },
  {
    items: [{ id: 'log', label: 'Logs', route: 'logs', highlight: true }],
  },
  {
    pinnedBottom: true,
    items: [
      { id: 'settings', label: 'Settings', route: 'settings', highlight: true },
      {
        id: 'account',
        label: 'Account',
        route: 'settings',
        segments: ['account'],
      },
    ],
  },
];

const WEBCLIENT_SHELL_STYLES = `
[${WEBCLIENT_SHELL_HOST_ATTR}] {
  /* Inherit the shell tokens from index.html :root (which ships the
     light + prefers-color-scheme:dark palette) instead of hard-pinning
     light values here. Hard-coding --surface/--fg on the shell host —
     which wraps every route — was the root of the app-wide dark-on-dark
     in dark mode (visual-UX review). */
  min-height: 100vh;
  min-height: 100dvh;
  height: 100vh;
  height: 100dvh;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  overflow: hidden;
  display: grid;
  /* Prevent a wide route's min-content size from widening the one implicit
     shell column (and, transitively, the top bar) beyond the viewport. */
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto minmax(0, 1fr);
  background:
    radial-gradient(circle at 18% 0%, var(--accent-weak), transparent 34rem),
    var(--surface-sunk);
  color: var(--fg);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
[${WEBCLIENT_SHELL_TOPBAR_ATTR}] {
  position: relative;
  z-index: 50;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  min-height: 58px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 18px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  box-shadow: 0 1px 0 rgba(24, 24, 27, 0.02), 0 8px 24px rgba(24, 24, 27, 0.035);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
/* ☰ drawer trigger — leads the top bar (top-left), the sole opener. */
[${WEBCLIENT_SHELL_DRAWER_TOGGLE_ATTR}] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--fg-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  transition: background 90ms ease, color 90ms ease, border-color 90ms ease;
}
[${WEBCLIENT_SHELL_DRAWER_TOGGLE_ATTR}]:hover {
  background: var(--surface-sunk);
  color: var(--fg);
  border-color: var(--border-strong);
}
[${WEBCLIENT_SHELL_DRAWER_TOGGLE_ATTR}]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${WEBCLIENT_SHELL_TOPBAR_ATTR}] .webclient-shell-brand {
  display: inline-flex;
  align-items: center;
  box-sizing: border-box;
  min-height: 38px;
  padding: 0 4px;
  border-radius: 8px;
  gap: 10px;
  color: var(--fg-strong, var(--fg));
  font-size: 16px;
  font-weight: 750;
  letter-spacing: -0.025em;
  text-decoration: none;
  transition: color 90ms ease;
}
[${WEBCLIENT_SHELL_TOPBAR_ATTR}] .webclient-shell-brand:hover {
  color: var(--accent);
}
[${WEBCLIENT_SHELL_TOPBAR_ATTR}] .webclient-shell-brand:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
[${WEBCLIENT_SHELL_TOPBAR_ATTR}] .webclient-shell-brand::before {
  content: "";
  width: 11px;
  height: 11px;
  border-radius: 4px;
  background: var(--accent);
  box-shadow: 0 0 0 5px var(--accent-weak);
}
/* The theme toggle is mounted inside Account. The rule remains scoped for
   bespoke shells that mount it directly. */
[${WEBCLIENT_SHELL_TOPBAR_ATTR}] [${THEME_TOGGLE_ATTR}] {
  margin-left: auto;
}
[${WEBCLIENT_SHELL_ATTENTION_HOST_ATTR}] {
  /* This host starts the right-hand cluster. The retired connection chip used
     to provide the flexible spacer; keep Account pinned to the viewport edge
     now that the non-visual announcer has no width. */
  margin-left: auto;
}
/* Screen-reader connection-status host. It has no visual footprint; sustained
   outages use the route-independent banner and Account owns all detail/actions. */
[${WEBCLIENT_SHELL_CONNECTION_HOST_ATTR}] {
  display: inline-flex;
  align-items: center;
}
/* §D.L1 — the account control, rightmost in the top bar. Its full 44px frame
   is the interactive target, not a smaller host around an overflowing button. */
[${WEBCLIENT_SHELL_ACCOUNT_ATTR}] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1;
  text-decoration: none;
  transition: background 90ms ease, color 90ms ease, border-color 90ms ease;
}
[${WEBCLIENT_SHELL_ACCOUNT_ATTR}]:hover {
  background: var(--surface-sunk);
  color: var(--fg);
  border-color: var(--border-strong);
}
[${WEBCLIENT_SHELL_ACCOUNT_ATTR}]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
/* Body — the content fills the row; the drawer overlays it off-canvas, so the
   body is a single column with no rail gutter. */
[${WEBCLIENT_SHELL_HOST_ATTR}] .webclient-shell-body {
  min-width: 0;
  min-height: 0;
  display: block;
}
[${WEBCLIENT_SHELL_CONTENT_ATTR}] {
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: auto;
  background:
    radial-gradient(circle at 72% -8%, var(--accent-weak), transparent 30rem),
    var(--surface-sunk);
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
}
/* Backdrop — dims the app while the drawer is open; click closes. Held in the
   tree always; the host's open-state attr fades it in. */
[${WEBCLIENT_SHELL_DRAWER_BACKDROP_ATTR}] {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(9, 9, 11, 0.52);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
  opacity: 0;
  visibility: hidden;
  transition: opacity 160ms ease, visibility 0s linear 160ms;
}
[${WEBCLIENT_SHELL_HOST_ATTR}][${WEBCLIENT_SHELL_DRAWER_OPEN_ATTR}] [${WEBCLIENT_SHELL_DRAWER_BACKDROP_ATTR}] {
  opacity: 1;
  visibility: visible;
  transition: opacity 160ms ease;
}
/* Off-canvas drawer — slides in from the left over the content + top bar.
   visibility:hidden when closed keeps the seats out of the tab order; the
   delayed transition lets it animate out before going untabbable. */
[${WEBCLIENT_SHELL_DRAWER_ATTR}] {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 70;
  box-sizing: border-box;
  width: min(306px, 88vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 12px 16px;
  border-right: 1px solid var(--border);
  background:
    linear-gradient(160deg, var(--accent-weak), transparent 180px),
    var(--surface);
  box-shadow: 14px 0 48px rgba(9, 9, 11, 0.24);
  transform: translateX(-100%);
  visibility: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  transition: transform 180ms cubic-bezier(0.4, 0, 0.2, 1), visibility 0s linear 180ms;
}
[${WEBCLIENT_SHELL_HOST_ATTR}][${WEBCLIENT_SHELL_DRAWER_OPEN_ATTR}] [${WEBCLIENT_SHELL_DRAWER_ATTR}] {
  transform: translateX(0);
  visibility: visible;
  transition: transform 180ms cubic-bezier(0.4, 0, 0.2, 1);
}
/* Drawer header — a close affordance (the top-bar ☰ is the opener). */
[${WEBCLIENT_SHELL_DRAWER_ATTR}] .webclient-shell-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 4px 12px 12px;
}
[${WEBCLIENT_SHELL_DRAWER_ATTR}] .webclient-shell-drawer-title {
  color: var(--fg-subtle);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
[${WEBCLIENT_SHELL_DRAWER_ATTR}] .webclient-shell-drawer-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--fg-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  transition: background 90ms ease, color 90ms ease;
}
[${WEBCLIENT_SHELL_DRAWER_ATTR}] .webclient-shell-drawer-close:hover {
  background: var(--surface-sunk);
  color: var(--fg);
}
[${WEBCLIENT_SHELL_DRAWER_ATTR}] .webclient-shell-drawer-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
/* One section = a group of seats; dividers fall between sections. */
[${WEBCLIENT_SHELL_DRAWER_ATTR}] .webclient-shell-drawer-section {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
/* The config tier (Settings/Account) sinks to the foot, above-ruled. */
[${WEBCLIENT_SHELL_DRAWER_ATTR}] .webclient-shell-drawer-section--pinned {
  margin-top: auto;
  padding-top: 9px;
  border-top: 1px solid var(--border);
}
[${WEBCLIENT_SHELL_DRAWER_ATTR}] .webclient-shell-drawer-divider {
  height: 1px;
  margin: 8px 10px;
  background: var(--border);
}
[${WEBCLIENT_SHELL_DRAWER_LINK_ATTR}],
[${WEBCLIENT_SHELL_DRAWER_ACTION_ATTR}] {
  position: relative;
  min-height: 40px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 10px;
  color: var(--fg-muted);
  font-size: 13.5px;
  font-weight: 550;
  text-decoration: none;
  transition: background 90ms ease, color 90ms ease;
}
/* The "Create" action seat is a <button> styled as a drawer link — strip the
   native button chrome so it reads identically to its sibling nav links. */
[${WEBCLIENT_SHELL_DRAWER_ACTION_ATTR}] {
  width: 100%;
  appearance: none;
  border: 0;
  background: transparent;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
[${WEBCLIENT_SHELL_DRAWER_LINK_ATTR}] .webclient-shell-drawer-glyph,
[${WEBCLIENT_SHELL_DRAWER_ACTION_ATTR}] .webclient-shell-drawer-glyph {
  display: inline-flex;
  width: 15px;
  justify-content: center;
  color: var(--fg-subtle);
  font-weight: 600;
}
[${WEBCLIENT_SHELL_DRAWER_LINK_ATTR}]:hover,
[${WEBCLIENT_SHELL_DRAWER_ACTION_ATTR}]:hover {
  background: var(--surface-sunk);
  color: var(--fg);
}
[${WEBCLIENT_SHELL_DRAWER_LINK_ATTR}]:focus-visible,
[${WEBCLIENT_SHELL_DRAWER_ACTION_ATTR}]:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}
/* Active — sunk surface + inset accent rule (carries the prior rail accent). */
[${WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR}] {
  background: color-mix(in srgb, var(--accent-weak) 70%, var(--surface));
  color: var(--fg-strong);
  font-weight: 650;
  box-shadow: inset 3px 0 0 var(--accent), 0 1px 2px rgba(24, 24, 27, 0.04);
}
[${WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR}] .webclient-shell-drawer-glyph {
  color: var(--accent);
}
/* Disabled "Soon" stub — a not-yet-built destination (none today). */
[${WEBCLIENT_SHELL_DRAWER_ATTR}] .webclient-shell-drawer-stub {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 7px 12px;
  border-radius: 8px;
  color: var(--fg-subtle);
  font-size: 13.5px;
  font-weight: 500;
  cursor: not-allowed;
}
[${WEBCLIENT_SHELL_DRAWER_ATTR}] .webclient-shell-drawer-soon {
  margin-left: auto;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-sunk);
  color: var(--fg-subtle);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
@media (max-width: 760px) {
  [${WEBCLIENT_SHELL_TOPBAR_ATTR}] {
    min-height: 56px;
    gap: 8px;
    padding: 8px 10px;
  }
  [${WEBCLIENT_SHELL_TOPBAR_ATTR}] .webclient-shell-brand {
    font-size: 15px;
  }
  /* Server health and pause/restart controls now live inside the scroll-bounded
     Account dialog, so they remain available at phone widths. */
  [${WEBCLIENT_SHELL_DRAWER_ATTR}] {
    width: min(300px, 92vw);
  }
}
@media (prefers-reduced-motion: reduce) {
  [${WEBCLIENT_SHELL_DRAWER_ATTR}],
  [${WEBCLIENT_SHELL_DRAWER_BACKDROP_ATTR}] {
    transition: none;
  }
}
`;

interface WebclientShell {
  readonly root: HTMLElement;
  readonly contentRoot: HTMLElement;
  readonly attentionHost: HTMLElement;
  /** Non-visual host for connection-status announcements. */
  readonly connectionHost: HTMLElement;
  /** Topbar's rightmost slot — the account menu (trigger + badge + theme +
   *  settings + servers) mounts here. */
  readonly accountHost: HTMLElement;
  readonly setActiveRoute: (
    route: WebclientRouteId,
    segments?: readonly string[],
  ) => void;
  readonly dispose: () => void;
}

const WEBCLIENT_SHELL_DRAWER_ID = 'webclient-shell-drawer';

/** Best-effort focus — guarded so the fake-DOM tests (no `.focus`) + detached
 *  nodes never throw out of an open/close transition. */
const focusShellElement = (el: HTMLElement | null | undefined): void => {
  if (el === null || el === undefined) return;
  const focus = (el as { focus?: () => void }).focus;
  if (typeof focus !== 'function') return;
  try {
    focus.call(el);
  } catch {
    /* fake DOM / detached node — focus is a nicety, never load-bearing */
  }
};

const createWebclientShell = (opts: {
  readonly root: HTMLElement;
  readonly document: Document;
  readonly activeRoute: WebclientRouteId;
  readonly activeSegments?: readonly string[];
  /** Fired by the §D.L2 drawer "Create" action seat — opens the shared Create
   *  overlay (the same modal as the L1 composer button). */
  readonly onCreateSeat?: () => void;
}): WebclientShell => {
  const doc = opts.document;
  if (
    doc.head.querySelector(`style[${WEBCLIENT_SHELL_STYLES_MARKER}]`) === null
  ) {
    const style = doc.createElement('style');
    style.setAttribute(WEBCLIENT_SHELL_STYLES_MARKER, '');
    style.textContent = `${WEBCLIENT_SHELL_STYLES}\n${THEME_TOGGLE_STYLES}`;
    doc.head.appendChild(style);
  }

  // D-174 polish layer — one normalization pass over every route's
  // controls / cards / floating panels, layered on top of the per-route
  // styles. Injected here (once, idempotent) so it covers whatever route
  // the shell mounts into `contentRoot`. See webclient-polish-styles.ts.
  injectWebclientPolishStyles(doc);

  const shellRoot = doc.createElement('div');
  shellRoot.setAttribute(WEBCLIENT_SHELL_HOST_ATTR, '');

  // ── Top bar: ☰ · Recued · (spacer) · ◐ theme · 🔔 attention ──────────
  const topbar = doc.createElement('header');
  topbar.setAttribute(WEBCLIENT_SHELL_TOPBAR_ATTR, '');
  // The ☰ drawer trigger leads the bar — the one opener for the §D.L2 menu.
  const toggleBtn = doc.createElement('button');
  toggleBtn.setAttribute('type', 'button');
  toggleBtn.setAttribute(WEBCLIENT_SHELL_DRAWER_TOGGLE_ATTR, '');
  toggleBtn.setAttribute('aria-controls', WEBCLIENT_SHELL_DRAWER_ID);
  toggleBtn.setAttribute('aria-expanded', 'false');
  toggleBtn.setAttribute('aria-label', 'Open navigation');
  toggleBtn.textContent = '☰'; // ☰
  topbar.appendChild(toggleBtn);
  const brand = doc.createElement('a');
  brand.className = 'webclient-shell-brand';
  brand.setAttribute('href', serializeShellRoute('chat'));
  brand.textContent = 'Recued';
  topbar.appendChild(brand);
  // Visually hidden connection-status announcer slot. The retired chip and its
  // popover no longer render here; the persistent banner announces sustained
  // outages and Account owns server identity, detail, and actions.
  const connectionHost = doc.createElement('div');
  connectionHost.setAttribute(WEBCLIENT_SHELL_CONNECTION_HOST_ATTR, '');
  topbar.appendChild(connectionHost);
  // The server-status pill NO LONGER sits in the bar. It moved into the
  // account menu, which is now the one "me and my server" surface. It is not
  // merely a readout:
  // it carries the D-188 pause / restart controls, so this is a rehome, not
  // a removal.
  // The theme toggle NO LONGER sits in the bar — it moved into the account
  // menu's quick row, so the topbar carries one icon fewer. It is mounted
  // later, into the slot that menu exposes; `margin-left: auto` on the
  // attention host still pushes the right-hand cluster over.
  const attentionHost = doc.createElement('div');
  attentionHost.setAttribute(WEBCLIENT_SHELL_ATTENTION_HOST_ATTR, '');
  topbar.appendChild(attentionHost);
  // §D.L1 — the account slot, the topbar's rightmost. The bootstrap mounts
  // the account MENU here (trigger + badge + theme + settings + servers).
  // Empty until then, so a shell composed without the menu renders nothing
  // rather than a broken control.
  const accountHost = doc.createElement('div');
  accountHost.setAttribute(WEBCLIENT_SHELL_ACCOUNT_ATTR, '');
  topbar.appendChild(accountHost);
  shellRoot.appendChild(topbar);

  // ── Body: just the content mount (the drawer overlays it off-canvas) ──
  const body = doc.createElement('div');
  body.className = 'webclient-shell-body';
  const contentRoot = doc.createElement('main');
  contentRoot.setAttribute(WEBCLIENT_SHELL_CONTENT_ATTR, '');
  // A recovery-return receipt can hand keyboard and assistive-technology focus
  // back to the mounted work area without guessing at a route-owned control.
  contentRoot.setAttribute('tabindex', '-1');
  body.appendChild(contentRoot);
  shellRoot.appendChild(body);

  // ── §D.L2 drawer: backdrop + off-canvas side menu ───────────────────
  const backdrop = doc.createElement('div');
  backdrop.setAttribute(WEBCLIENT_SHELL_DRAWER_BACKDROP_ATTR, '');
  backdrop.setAttribute('aria-hidden', 'true');
  shellRoot.appendChild(backdrop);

  const drawer = doc.createElement('nav');
  drawer.setAttribute(WEBCLIENT_SHELL_DRAWER_ATTR, '');
  drawer.setAttribute('id', WEBCLIENT_SHELL_DRAWER_ID);
  drawer.setAttribute('aria-label', 'Primary navigation');
  drawer.setAttribute('aria-hidden', 'true');

  const head = doc.createElement('div');
  head.className = 'webclient-shell-drawer-head';
  const title = doc.createElement('span');
  title.className = 'webclient-shell-drawer-title';
  title.textContent = 'Navigate';
  const closeBtn = doc.createElement('button');
  closeBtn.setAttribute('type', 'button');
  closeBtn.className = 'webclient-shell-drawer-close';
  closeBtn.setAttribute('aria-label', 'Close navigation');
  closeBtn.textContent = '✕'; // ✕
  head.appendChild(title);
  head.appendChild(closeBtn);
  drawer.appendChild(head);

  // All live controls inside the overlay, in DOM order. The array is filled
  // while the seats render below and is also the drawer's focus-loop source.
  const drawerFocusables: HTMLElement[] = [closeBtn];

  // Track every destination so exact sibling addresses (`#chat/new`,
  // `#settings/account`) can own the current-page marker. A `highlight` seat
  // remains the route fallback for deeper addresses without their own drawer
  // row (`#chat/session/<id>`, `#settings/privacy`, and so on).
  const destinationLinks: Array<{
    readonly route: WebclientRouteId;
    readonly segments: readonly string[];
    readonly fallback: boolean;
    readonly link: HTMLElement;
  }> = [];

  // ── Open / close state (declared before the render loop so each seat's
  //    close-on-navigate handler can close it) ─────────────────────────
  let drawerOpen = false;
  let activeDrawerLink: HTMLElement | null = null;
  const setDrawerOpen = (
    open: boolean,
    behavior?: { readonly returnFocus?: boolean },
  ): void => {
    drawerOpen = open;
    if (open) {
      shellRoot.setAttribute(WEBCLIENT_SHELL_DRAWER_OPEN_ATTR, '');
    } else {
      shellRoot.removeAttribute(WEBCLIENT_SHELL_DRAWER_OPEN_ATTR);
    }
    toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggleBtn.setAttribute(
      'aria-label',
      open ? 'Close navigation' : 'Open navigation',
    );
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    // The drawer behaves as a modal overlay. Native `inert` removes the
    // obscured app chrome + route from keyboard and accessibility traversal;
    // the document-level Tab loop below keeps focus contained as a fallback.
    if (open) {
      topbar.setAttribute('inert', '');
      body.setAttribute('inert', '');
    } else {
      topbar.removeAttribute('inert');
      body.removeAttribute('inert');
    }
    if (open) {
      // Start at the current destination so opening navigation does not make
      // keyboard users traverse the whole menu again. Routes without a drawer
      // seat retain the stable first-link fallback.
      focusShellElement(
        activeDrawerLink
          ?? destinationLinks.find((item) => item.fallback)?.link
          ?? closeBtn,
      );
    } else if (behavior?.returnFocus === true) {
      // Closed via ✕ / Escape / backdrop / nav-link — hand focus back to the
      // ☰ trigger (a stable, visible landing). A closed drawer's seats go
      // untabbable and routes don't claim focus, so without this focus would
      // drop to <body>.
      focusShellElement(toggleBtn);
    }
  };

  WEBCLIENT_DRAWER_SECTIONS.forEach((section, idx) => {
    const sectionEl = doc.createElement('div');
    sectionEl.className =
      'webclient-shell-drawer-section'
      + (section.pinnedBottom === true
        ? ' webclient-shell-drawer-section--pinned'
        : '');
    for (const item of section.items) {
      if (item.action === 'create') {
        // An ACTION seat (Create) — a button that opens the shared Create
        // overlay instead of navigating. Checked BEFORE the stub branch because
        // an action seat also carries `route: null`. Close onto the stable ☰
        // trigger BEFORE opening the portal: its focus trap captures that visible
        // opener, so closing Create cannot restore focus to an off-canvas seat.
        const button = doc.createElement('button');
        button.setAttribute('type', 'button');
        button.setAttribute(WEBCLIENT_SHELL_DRAWER_ACTION_ATTR, item.id);
        button.addEventListener('click', () => {
          setDrawerOpen(false, { returnFocus: true });
          opts.onCreateSeat?.();
        });
        if (item.glyph !== undefined) {
          const glyph = doc.createElement('span');
          glyph.className = 'webclient-shell-drawer-glyph';
          glyph.setAttribute('aria-hidden', 'true');
          glyph.textContent = item.glyph;
          button.appendChild(glyph);
        }
        const actionLabel = doc.createElement('span');
        actionLabel.className = 'webclient-shell-drawer-label';
        actionLabel.textContent = item.label;
        button.appendChild(actionLabel);
        sectionEl.appendChild(button);
        drawerFocusables.push(button);
        continue;
      }
      if (item.stub === true || item.route === null) {
        // A not-yet-built destination — a disabled "Soon" seat that never
        // navigates and never highlights. No seat uses this today (Packs
        // graduated to its own `#packs` route, D-187 §6); retained as the
        // general mechanism for a future not-yet-built nav entry.
        const stub = doc.createElement('span');
        stub.className = 'webclient-shell-drawer-stub';
        stub.setAttribute(WEBCLIENT_SHELL_DRAWER_STUB_ATTR, item.id);
        stub.setAttribute('aria-disabled', 'true');
        const stubLabel = doc.createElement('span');
        stubLabel.textContent = item.label;
        stub.appendChild(stubLabel);
        const soon = doc.createElement('span');
        soon.className = 'webclient-shell-drawer-soon';
        soon.textContent = 'Soon';
        stub.appendChild(soon);
        sectionEl.appendChild(stub);
        continue;
      }
      const link = doc.createElement('a');
      // The link hook carries the SEAT id (unique), not the route — two seats
      // can share a route (New chat/Chats under Chat, Settings/Account under
      // Settings) and must stay individually addressable.
      link.setAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR, item.id);
      link.setAttribute(
        'href',
        serializeShellRoute(item.route, ...(item.segments ?? [])),
      );
      // Close on navigate — the route swap happens via the href. Return focus
      // to the ☰ trigger: the seat we'd otherwise leave focus on goes
      // visibility:hidden with the closing drawer (dropping focus to <body>),
      // and the route mount doesn't claim focus, so the toggle is the stable
      // landing a keyboard user continues tabbing from.
      link.addEventListener('click', () =>
        setDrawerOpen(false, { returnFocus: true }),
      );
      drawerFocusables.push(link);
      if (item.glyph !== undefined) {
        const glyph = doc.createElement('span');
        glyph.className = 'webclient-shell-drawer-glyph';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = item.glyph;
        link.appendChild(glyph);
      }
      const labelEl = doc.createElement('span');
      labelEl.className = 'webclient-shell-drawer-label';
      labelEl.textContent = item.label;
      link.appendChild(labelEl);
      destinationLinks.push({
        route: item.route,
        segments: item.segments ?? [],
        fallback: item.highlight === true,
        link,
      });
      sectionEl.appendChild(link);
    }
    drawer.appendChild(sectionEl);
    // A divider falls between consecutive non-pinned sections; the pinned
    // (config) section is set off by its own top rule instead.
    const next = WEBCLIENT_DRAWER_SECTIONS[idx + 1];
    if (next !== undefined && next.pinnedBottom !== true) {
      const divider = doc.createElement('div');
      divider.className = 'webclient-shell-drawer-divider';
      divider.setAttribute('role', 'separator');
      drawer.appendChild(divider);
    }
  });
  shellRoot.appendChild(drawer);
  opts.root.appendChild(shellRoot);

  // ── Wire the open/close triggers ────────────────────────────────────
  toggleBtn.addEventListener('click', () => setDrawerOpen(!drawerOpen));
  closeBtn.addEventListener('click', () =>
    setDrawerOpen(false, { returnFocus: true }),
  );
  backdrop.addEventListener('click', () =>
    setDrawerOpen(false, { returnFocus: true }),
  );

  // Escape closes the drawer. Attached at the document so it fires regardless
  // of where focus sits; guarded because the fake-DOM document used in tests
  // has no `addEventListener`.
  const docEvents = doc as unknown as {
    addEventListener?: (type: string, fn: (event: Event) => void) => void;
    removeEventListener?: (type: string, fn: (event: Event) => void) => void;
  };
  const onDocKeydown = (event: Event): void => {
    if (!drawerOpen) return;
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.key === 'Escape') {
      setDrawerOpen(false, { returnFocus: true });
      return;
    }
    if (keyEvent.key === 'Tab') {
      const active = doc.activeElement as HTMLElement | null;
      const activeIndex = active === null ? -1 : drawerFocusables.indexOf(active);
      const nextIndex = keyEvent.shiftKey
        ? activeIndex <= 0
          ? drawerFocusables.length - 1
          : activeIndex - 1
        : activeIndex < 0 || activeIndex >= drawerFocusables.length - 1
          ? 0
          : activeIndex + 1;
      keyEvent.preventDefault();
      focusShellElement(drawerFocusables[nextIndex] ?? closeBtn);
    }
  };
  docEvents.addEventListener?.('keydown', onDocKeydown);

  const setActiveRoute = (
    route: WebclientRouteId,
    segments: readonly string[] = [],
  ): void => {
    const exact = destinationLinks.find((item) =>
      item.route === route
      && item.segments.length === segments.length
      && item.segments.every((segment, index) => segment === segments[index]),
    );
    const active = exact ?? destinationLinks.find(
      (item) => item.route === route && item.fallback,
    );
    activeDrawerLink = active?.link ?? null;
    for (const item of destinationLinks) {
      if (item === active) {
        item.link.setAttribute('aria-current', 'page');
        item.link.setAttribute(WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR, '');
      } else {
        item.link.removeAttribute('aria-current');
        item.link.removeAttribute(WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR);
      }
    }
  };
  setActiveRoute(opts.activeRoute, opts.activeSegments);

  return {
    root: shellRoot,
    contentRoot,
    attentionHost,
    connectionHost,
    accountHost,
    setActiveRoute,
    dispose: () => {
      docEvents.removeEventListener?.('keydown', onDocKeydown);
      try {
        opts.root.removeChild(shellRoot);
      } catch {
        shellRoot.remove();
      }
    },
  };
};

const parseApprovalChangedMessage = (
  message: unknown,
): { seq: number; pending_count: number } | null => {
  if (message === null || typeof message !== 'object') return null;
  const envelope = message as { type?: unknown; event?: unknown };
  if (envelope.type !== 'approval_changed') return null;
  if (envelope.event === null || typeof envelope.event !== 'object') return null;
  const event = envelope.event as { seq?: unknown; pending_count?: unknown };
  if (
    typeof event.seq !== 'number'
    || typeof event.pending_count !== 'number'
  ) {
    return null;
  }
  return { seq: event.seq, pending_count: event.pending_count };
};

/** Thrown when the bootstrap is invoked before the webclient has
 *  paired (no `webclient_token` / `server_url` / `server_public_key`
 *  in local storage). The caller routes to a pair-blob input surface
 *  — that flow is owned by a separate (future) module. */
export class WebclientUnpairedError extends Error {
  readonly code = 'webclient_unpaired' as const;
  constructor(public readonly reason: string = 'pair state missing') {
    super(`webclient bootstrap: ${reason}`);
  }
}

// ════════════════════════════════════════════════════════════════
// Options + handle
// ════════════════════════════════════════════════════════════════

export interface BootstrapWebclientOptions {
  /** Root DOM element the Reception route mounts into. The bootstrap
   *  hands this through to `bootstrapReceptionRoute` — the bootstrap
   *  itself does no DOM construction outside what that route already
   *  owns. */
  root: HTMLElement;
  /** Closed-list 5-field local store (`createIndexedDbWebclientLocalStore`
   *  in production; `createInMemoryWebclientLocalStore` in tests). */
  localStore: WebclientLocalStore;
  /** The roster half of the same store, when the caller has one.
   *
   *  Separate from `localStore` on purpose: the five-key surface is what the
   *  rest of the bootstrap (and every hand-rolled test fixture) speaks, while
   *  cold-boot profile restore + the switcher need the profile methods.
   *  Production passes the same object for both —
   *  `createIndexedDbWebclientLocalStore` returns a
   *  `WebclientProfileAwareStore`. Absent ⇒ no explicit profile restore and no
   *  switcher, which is the compatibility reading for a caller with no roster. */
  profileStore?: WebclientProfileStore;
  /** Bearer wrap/unwrap store — `crypto.subtle` AES-GCM backed in
   *  production; deterministic fake in tests. */
  tokenStore: WebclientTokenStore;
  /** WS transport — production wires a `WebSocket`-backed transport;
   *  tests inject an in-memory loopback. DD#1. */
  transport: WebclientWsTransport;
  /** Currently active exposure profile id. Forwarded to the Reception
   *  route. A future exposure-state-mirror will refresh this through
   *  `setStatus`; the boot value is "what was active at pair time". */
  exposureProfile: string;
  /** Optional initial reception status (DD#5). Defaults to the safe
   *  view: pessimistic public / not-emergency / no base URL. */
  initialReceptionStatus?: ReceptionStatusInput;
  /** Optional override for the URL-hash source. Tests inject a fake
   *  `window`-shape; production reads `globalThis.location.hash` +
   *  `addEventListener('hashchange', …)`. */
  hashSource?: WebclientHashSource;
  /** Optional clock seam (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Optional document seam — forwarded to `bootstrapReceptionRoute`. */
  document?: Document;
  /** Optional sink for `token.rotated` handler failures. Stages:
   *  `read_pair_context` / `wrap` / `persist`. Defaults to silent —
   *  failures simply fall back to the next-reconnect 401 → reauth_required
   *  → re-pair path. Production wires this to the audit / telemetry
   *  surface that already covers transport errors. */
  onTokenRotationError?: (
    err: Error,
    context: TokenRotationFailureContext,
  ) => void;
  /** Best-effort observer after a rotated token envelope is durable. The
   * pair-fallback host uses this to converge same-origin sibling tabs without
   * treating this tab's own rotation as an external credential replacement. */
  onTokenRotated?: (record: WebclientTokenRecord) => void;
  /** Optional sink for `cert.rotation_notice` + `cert.rotation_reverted`
   *  handler failures. Stages: `verify` / `read_pair_context` /
   *  `persist`. Defaults to silent — failures degrade to "the pin
   *  state didn't advance"; the next valid notice or a future
   *  passport fetch picks it up. Production wires this to the same
   *  audit surface as the token-rotation sink. */
  onCertPinError?: (err: Error, context: CertPinFailureContext) => void;
  /** Optional sink for the bootstrap's `events.subscribe` rpc failure
   *  (DD#8). The webclient depends on this round-trip to start
   *  receiving broadcasts; a failure here means the page falls back
   *  to its initial-state view until the next reconnect retries.
   *  Defaults to silent. */
  onSubscribeError?: (err: Error) => void;
  /** § A.4.1 — AES-GCM key store wiper, threaded through to the
   *  Settings → Privacy "Clear this browser" panel as
   *  `crypto_keys_wiper`. Production wires
   *  `wipeWebclientCryptoKeyStore` from `webclient-main.ts`; tests
   *  inject a counted fake. When omitted the panel still works but
   *  the `done` state's result row reports
   *  `cleared_crypto_keys: false`. */
  cryptoKeysWiper?: () => Promise<void>;
  /** Host lifecycle hook immediately after Settings clears the durable
   * five-field credential record. Unlike `onPrivacyClear`, this still fires
   * when a later cache, session, or key cleanup step fails. */
  onPrivacyCredentialsCleared?: () => void;
  /** Best-effort host signal after a server profile has been durably removed.
   *  The pair-fallback host broadcasts a credential-free convergence hint so
   *  sibling tabs re-read the shared profile store.
   *  @deprecated Use `onServerProfilesChanged`, which also covers names and
   *  connection recency. */
  onServerProfileRemoved?: () => void;
  /** Best-effort host signal after the local server roster changes without a
   *  credential-generation change: rename, connection recency, or removal.
   *  Sibling tabs use it only as a hint and re-read durable storage. */
  onServerProfilesChanged?: () => void;
  /** Best-effort, detail-free host signal after the durable active-profile
   * pointer moves. Siblings use the distinct hint to pause before their first
   * IndexedDB read, then resolve the exact target from durable storage. */
  onActiveServerProfileChanged?: () => void;
  /** § A.4.1 — telemetry sink invoked after a successful Privacy
   *  panel clear. Receives the structured `ClearThisBrowserResult` +
   *  the `sw_unregistered` flag. Best-effort; throws are swallowed
   *  by the panel. */
  onPrivacyClear?: (
    result: ClearThisBrowserResult,
    sw_unregistered: boolean,
  ) => void;
  /** D-156 P8 — Codex P1 fold. Fires when the bootstrap detects the
   *  paired session is no longer authentic + the user must re-pair:
   *  EITHER the ws-client transitions to `reauth_required` (server
   *  rotated `server_identity_key` → bearer rejected with 1008/4401),
   *  OR `runPassportFetchVerify` rejects with
   *  `observed_fingerprint_unknown` (MITM-class). The bootstrap fires
   *  this callback exactly once per session — the caller is
   *  responsible for wiping the 5 IDB fields + tearing down the
   *  active handle + re-entering the pair form (the same
   *  `runBootstrapWithPairFallback` re-entry the unpaired-error path
   *  uses on cold boot). When absent the user is stranded on a
   *  stale session — the bootstrap does NOT auto-wipe local state
   *  because the recovery UX is owned by the host (`webclient-main`
   *  in production). */
  onReauthRequired?: () => void;
  /** In-memory return context captured before a reauth-required teardown.
   * Production passes it only into the post-pair bootstrap: the exact route
   * remounts from `returnHash`, an unsent Chat draft is restored after its
   * durable session hydrates, and the connection surface confirms recovery. */
  reauthRecovery?: WebclientRecoverySnapshot;
  /** Optional one-shot confirmation for the first connected frame. The pair
   * fallback uses this after pairing or a successful explicit startup retry;
   * it remains in memory only and shares the route-independent connection
   * receipt used by guided reauth. */
  initialConnectedReceiptCopy?: string;
  /** Suppress both the explicit and guided-reauth first-connected receipt for
   * a passive sibling-tab adoption. Recovery route/draft context still lands;
   * only the tab that actually completed pairing owns the confirmation. */
  suppressInitialConnectedReceipt?: boolean;
  /** Host-owned lifecycle hook invoked once when this mounted shell begins
   * disposal. Pair-fallback uses it to retire the tab credential observer
   * before the shell and its route closures disappear. */
  onSessionDispose?: () => void;
  /** § A.6.5 / slice 111 — when set to `true`, the Settings route
   *  mounts the Server section's TLS renew panel and binds its rpc
   *  caller to the bootstrap's typed conn. The caller does NOT
   *  forward `rotation_at_offset_ms`; the engine's 7d default lead
   *  (`DEFAULT_TLS_ROTATION_NOTICE_LEAD_MS`) drives the overlap window.
   *  Defaults to `true` in production composition; tests opt out by
   *  passing `false` when they do not exercise the Server section. */
  enableTlsRenewPanel?: boolean;
  /** R26.4 Backup & Migration Unification (M1) — when not `false`, the Settings
   *  route mounts the consolidated Backup & Recovery surface and binds its
   *  `server.archive.{export,status,import}` callers (the spine). Defaults to
   *  `true` in production; tests opt out by passing `false`. */
  enableArchiveBackupPanel?: boolean;
  /** R26.4 M1 — when not `false`, the unified Backup & Recovery surface renders
   *  the lightweight "Export identity passport only" action and binds its
   *  `passport.export` caller. Defaults to `true` in production; tests opt out
   *  by passing `false`. */
  enablePassportPanel?: boolean;
  /** R26.4 Delta 3 — when not `false`, the Settings route mounts the
   *  Server section's Key Health page and binds its `key.health` +
   *  `key.rotate` callers. Defaults to `true` in production; tests opt
   *  out by passing `false` (same discipline as `enableTlsRenewPanel`). */
  enableKeyHealthPanel?: boolean;
  /** § A.6.5 / slice 111 — telemetry sink invoked after a successful
   *  TLS renew lands in the `done` state. Receives the substrate's
   *  `RotationResult` success branch. Best-effort; throws are
   *  swallowed by the panel. The Reachability Doctor's TLS row also
   *  picks up the renewal via the `cert.rotation_notice` broadcast,
   *  so this hook is purely additive telemetry. */
  onTlsRenewed?: (
    result: Extract<import('@recued/contracts').RotationResult, { ok: true }>,
  ) => void;
  /** § A.6.5 / slice 113 — when set to `true` (default), the Settings
   *  route mounts the Server section's "Cert pin rotation pending"
   *  panel against a watcher subscribed to the cert-pin handler. The
   *  watcher reads `cert_pin_state` from `localStore` once at boot
   *  (cold-load snapshot) + receives post-persist transitions via
   *  the cert-pin handler's `onStateChanged` hook. Tests opt out by
   *  passing `false` when they do not exercise the Server section
   *  (same discipline as `enableTlsRenewPanel`). */
  enableCertPinStalePanel?: boolean;
  /** § A.6.5 / slice 113 — best-effort failure sink for the watcher's
   *  cold-boot `refresh()` read. A read failure leaves the prior
   *  state intact so the panel hides until the first
   *  `cert.rotation_notice` broadcast lands. Production wires the
   *  same audit / telemetry surface as `onCertPinError`. */
  onCertPinRefreshError?: (err: Error) => void;
  /** § A.6.5 / slice 114 — recurring-timer seam for the cert-pin
   *  overlap panel's time-passage auto-hide tick (DD#10). The handler
   *  is invoked every `intervalMs` (60_000 by default); the bootstrap
   *  uses it to call `route.certPinStalePanel()?.update()` so the
   *  panel re-evaluates the `current_valid_until > now` gate against
   *  the current clock. Defaults to `globalThis.setInterval` +
   *  `clearInterval`. Tests inject a fake that captures the handler
   *  so they can drive ticks deterministically; production keeps the
   *  default + accepts the 60s-resolution auto-hide. Inert when
   *  `enableCertPinStalePanel: false` (no watcher → no timer). */
  setCertPinPollTimer?: (
    handler: () => void,
    intervalMs: number,
  ) => { cancel: () => void };
  /** Connection-status grace window (ms) — how long the socket may sit
   *  continuously non-`connected` before the chip/banner/rpc layer treat
   *  it as `offline`. Defaults to `WEBCLIENT_OFFLINE_GRACE_MS` (6s).
   *  Tests shorten it (alongside `setConnectionStatusTimer`) to drive
   *  the offline transition without a real wait. */
  connectionStatusGraceMs?: number;
  /** Timer seam for the connection-status controller's grace deadline.
   *  Mirrors the ws-client's `setTimer`. Defaults to a `setTimeout`-
   *  backed timer. Tests inject a fake to fire the grace deadline
   *  deterministically. */
  setConnectionStatusTimer?: (
    handler: () => void,
    delayMs: number,
  ) => { cancel: () => void };
  /** § A.6.5 / slice 114 — polling cadence in ms for the cert-pin
   *  overlap panel's time-passage auto-hide tick (DD#10). Defaults to
   *  `CERT_PIN_POLL_INTERVAL_MS = 60_000`. The flip-time formatter
   *  buckets at `1h` / `1d` granularity so a 60s tick catches the
   *  bucket boundary within a minute + catches the actual flip within
   *  a minute. Tests can shorten the cadence to verify multiple ticks
   *  without `vi.useFakeTimers()`. */
  certPinPollIntervalMs?: number;
  /** § A.6.5 + § A.9 / slice 116 — when set to `true` (the default
   *  post-slice 128), the bootstrap fires the passport-fetch verify
   *  pipeline on every successful WS reconnect. Calls `passport.
   *  fetch`, threads the signed projection through
   *  `verifyPassportCertAttestation`, and on `outcome === 'promoted'
   *  | 'seeded'` persists + fires the cert-pin watcher's `notify()`
   *  so the Settings → Server cert-pin-stale panel hides synchronously.
   *
   *  Default flipped to `true` in slice 128. Slice 117 wired the
   *  production `passportFetchDeps` substrate in `bin.ts`; slice 118
   *  took the conservative explicit-opt-in path in `webclient-main.ts`
   *  to validate the substrate against real reconnect cycles; this
   *  slice closes the loop so dev + early-adopter compositions also
   *  default to the verify path. Tests + bespoke compositions opt out
   *  by passing `false` (most tests don't exercise rpc round-trips
   *  against a real handler — the orchestrator's fire-and-forget
   *  `void runPassportFetchVerify(...)` shape means an unanswered
   *  `passport.fetch` call lands on `onError(..., stage: 'rpc')` /
   *  times out without back-pressuring the bootstrap, so test
   *  fixtures stay green by default; opt out only when the test is
   *  specifically about asserting rpc call ordering). */
  enablePassportFetchVerify?: boolean;
  /** § A.6.5 + § A.9 / slice 116 — best-effort failure sink for the
   *  passport-fetch verify pipeline. Closed-list stages:
   *  `rpc` (passport.fetch rpc rejection — typically `not_configured`
   *  until the server's passport-block-provider substrate composes),
   *  `read` (cert_pin_state localStore read failed),
   *  `verify` (signature_invalid / passport_stale /
   *  identity_key_mismatch / cert_fingerprint_missing — the verify-
   *  reason ships in the context),
   *  `persist` (cert_pin_state write failed). The MITM-class
   *  `observed_fingerprint_unknown` rejection routes to
   *  `onPassportFetchPairRequired` instead. Defaults to silent —
   *  failures leave the pin state intact for the next reconnect to
   *  re-attempt; production wires the same audit surface as
   *  `onCertPinError`. */
  onPassportFetchVerifyError?: (
    err: Error,
    context: PassportFetchVerifyFailureContext,
  ) => void;
  /** § A.6.5 + § A.9 / slice 116 — local pair-required trigger. Fires
   *  ONLY when the verify primitive rejects with
   *  `observed_fingerprint_unknown` (the passport's cert claim
   *  matches neither the pinned current nor the staged next AND a
   *  prior pin exists — MITM-class signal per spec § A.6.5 line 918).
   *  The host bridges this to its re-pair UX (force re-pair through
   *  the admin-token-gated flow); defaults to silent telemetry. D-156
   *  P8 retired the server-broadcast `pair_required` handler + the
   *  re-pair banner / overlay — the natural disconnect →
   *  unpaired-state → pair-form flow handles every re-pair scenario
   *  (per spec § Open questions Q2). The bootstrap still disconnects
   *  the suspect WS so the reconnect loop drops into the unpaired
   *  fallback even if the host callback no-ops. */
  onPassportFetchPairRequired?: (
    context: PassportFetchVerifyPairRequiredContext,
  ) => void;
  /** D-156 P5 — when set to `true`, the Settings → Devices section
   *  mounts the roster + revoke panel using `pair.list` + `pair.revoke`
   *  rpcs over the bootstrap's typed conn. **The bootstrap default stays
   *  OFF**, but the production boot path (`runBootstrapWithPairFallback`)
   *  now passes `true` explicitly — same opt-in-for-tests discipline as
   *  `enableReachabilityDoctor` / `enablePassportFetchVerify`.
   *
   *  The original OFF rationale (Codex 2026-05-18 P5 R3 fold) was that
   *  the server-side handlers gated on `client.user_id`, which the
   *  bearer-only webclient never populated (no `register` rpc) — so the
   *  roster came back empty. That gap is closed by the self-host owner
   *  identity fix (`057df5e6`): `/auth/pair` seeds `SELF_HOST_OWNER_ID`
   *  and `pair.list` / `pair.revoke` resolve a verified bearer to it, so
   *  the webclient enumerates + revokes itself. Tests + the P7
   *  acceptance harness still pass `true` explicitly. */
  enableDevicesPage?: boolean;
  /** D-156 P5 — best-effort failure sink for the devices-page's
   *  `pair.list` rpc. Defaults to silent. Production wires the same
   *  audit / telemetry surface as `onCertPinError`. */
  onDevicesListError?: (err: Error) => void;
  /** D-156 P5 — the locally-known instance id for this client.
   *  Pinned at pair time via `pair_metadata` for the matching
   *  Devices row to render with "This device" + no Revoke button
   *  (self-revoke blocked). Optional; absent → every row renders a
   *  Revoke button (since the renderer is the only enforcer of the
   *  self-revoke gate, this is technically unsafe; production
   *  threads the value through the success-path persistence). */
  currentInstanceId?: string;
  /** D-163 Slice C — when set to `true` (the default), the Settings
   *  route mounts the Notifications section. Calls `notifications.describe`
   *  on mount + `notifications.set_channel` per row toggle. The Slice C
   *  handlers run on the standard pair-WS channel (per-pair-only;
   *  `notifications.` is in `MCP_RESERVED_RPC_PREFIXES`), so the
   *  webclient's bearer auth path is sufficient. Tests opt out by
   *  passing `false` when they do not exercise the section. */
  enableNotificationsPanel?: boolean;
  /** D-145 PA10 follow-on — when set to `true` (the default), the
   *  packs.* callers are wired (`packs.list` on mount + `packs.install`
   *  per install dialog). D-187 §6 — these feed the top-level `#packs`
   *  route (and are reused by the `#recipes` route's pack modal). Both
   *  handlers run on the standard pair-WS channel (per-pair-only;
   *  `packs.` is in `MCP_RESERVED_RPC_PREFIXES`), so the webclient's
   *  bearer auth path is sufficient. Tests opt out by passing `false`
   *  when they do not exercise the surface. */
  enablePacksPanel?: boolean;
  /** D-174 D14 — when set to `true` (the default), the Settings route
   *  mounts the consolidated AI / Models section. Calls the existing
   *  `chat.default_model_pref.*`, `server.{get,set}LLMConfig`,
   *  `server.{getConfigSchema,setConfigField}`, `housekeeping.config.*`,
   *  and `housekeeping.cache.*` RPCs. Tests opt out by passing `false`. */
  enableAiModelsPage?: boolean;
  /** D-178 — Settings → Updates page. Default ON; tests pass `false` to skip. */
  enableUpdatesPage?: boolean;
  /** D-196 S2 — Settings -> Seller overview/manual tier controls. Default ON;
   *  tests/narrowed hosts can pass `false` to hide the section. Calls
   *  `server.seller.*` on the standard pair-WS channel. */
  enableSellerPage?: boolean;
  /** D-145 PA11 — when set to `true` (the default), the Settings route
   *  mounts the "LLM result cache" card inside the AI / Models section.
   *  Calls `housekeeping.cache.stats` on mount + `housekeeping.cache.
   *  clear` on the two-stage confirm. Both handlers run on the
   *  standard pair-WS channel. Tests opt out by passing `false` when
   *  they do not exercise the card. */
  enableHousekeepingCacheCard?: boolean;
  /** D-145 § B.8.9 — when set to `true` (the default), the Settings
   *  route mounts the Transparency section (inline-thought-stream
   *  visibility controls persisted as `ui.transparency.*` instance
   *  prefs). Calls `prefs.get` / `prefs.set` on the standard pair-WS
   *  channel. Tests opt out by passing `false`. */
  enableTransparencyPanel?: boolean;
  /** D-132/D-133 — when set to `true` (the default), the Settings route
   *  mounts the Housekeeping trust panel (per-topic AI-trust radios +
   *  pool policy + schedule + Run-now). Calls
   *  `housekeeping.{config.read,config.write,status.read,task.run_now,
   *  trust.read,trust.write}` on the standard pair-WS channel. Tests opt
   *  out by passing `false` when they do not exercise the panel. */
  enableHousekeepingPanel?: boolean;
  /** D-152 P6 — when set to `true` (the default), the Settings route mounts
   *  the Server -> Hostnames panel. Calls
   *  `collection.hostname.{list,get,add,update,remove,verifyOwnership}` on the
   *  standard pair-WS channel (local UI only; `collection.hostname.` is
   *  reserved from MCP).
   *  Tests opt out by passing `false` when they do not exercise the panel. */
  enableHostnamesPanel?: boolean;
  /** R26.2 Delta 1 — Settings → Server → Exposure grid. Default ON; tests opt
   *  out by passing `false`. Builds `exposure.{get,apply_preset,set_path_-
   *  resolution,set_public_mcp_acknowledgement}` on the pair-WS channel (local
   *  UI only; `exposure.` is MCP-reserved). */
  enableExposurePanel?: boolean;
  /** M-REACH-4 — Settings → Server Reachability Doctor front-door. Defaults OFF
   *  for direct bootstrap tests; production `runBootstrapWithPairFallback` passes
   *  true. When enabled, the external-probe button posts to the free
   *  `/v1/diagnostics/probe` worker unless `reachabilityExternalProbeCaller` is
   *  supplied. */
  enableReachabilityDoctor?: boolean;
  /** Optional initial internal Reachability Doctor report. M-REACH-4 wires the
   *  external probe front-door; the server report RPC is intentionally outside
   *  this webclient-only slice, so callers that already have a report can pass it
   *  here for display. */
  reachabilityReport?: ReachabilityReport;
  /** Test/host override for the external-probe button. When omitted and the
   *  doctor is enabled, the bootstrap builds a fetch-backed caller. */
  reachabilityExternalProbeCaller?: ReachabilityExternalProbeCaller;
  /** Optional diagnostics Worker base URL. Defaults to `https://probe.recued.com`
   *  (D-176 Phase 5 — the probe Worker's own subdomain, split off the api host). */
  diagnosticsApiBaseUrl?: string;
  /** Optional fetch seam for tests or non-browser hosts. */
  diagnosticsFetch?: ReachabilityDiagnosticFetch;
  /** Optional cloud account id override for `/v1/diagnostics/probe`. When omitted,
   *  the current paired handle is used as the only existing non-secret account
   *  identifier in the webclient store. */
  diagnosticsAccountId?: string;
  /** Optional hostname override for `/v1/diagnostics/probe`. When omitted, the
   *  paired handle becomes `<handle>.recued.cloud` unless it already contains a
   *  dot. */
  diagnosticsHostname?: string;
  /** D-174 — when not explicitly `false` (the default is ON), the
   *  top-level Approvals route mounts the pending-decisions queue:
   *  `approval.*` gates plus the D-158 asks panel. Calls
   *  `approval.list` / `approval.subscribe` on mount, `approval.resolve`
   *  from approve/reject buttons, `notification.pending_asks` on mount +
   *  ask broadcasts, and `notification.submitAnswer` on ask-card clicks.
   *  Tests opt out by passing `false`. */
  enableApprovalsRoute?: boolean;
  /** D-169 P2 Slice 5 (toast half) — when not explicitly `false` (the
   *  default is ON), the bootstrap mounts the route-independent notify
   *  toast overlay at `options.root`: an ephemeral pop on each
   *  `notification.notify` bus frame (bus-driven; no rpc). This is the sole
   *  webclient surface for a one-way `notify` — the durable feed was retired
   *  (R31 delta D); `notification_fired` audit rows still persist server-side.
   *  Tests opt out by passing `false`. */
  enableNotifyToasts?: boolean;
  /** Live connection indicator — when not explicitly `false` (the default is
   *  ON), the bootstrap mounts a screen-reader status announcer + the
   *  route-independent offline banner, both driven by the `connection-status`
   *  controller. Account owns the visible status detail and recovery actions.
   *  Tests that assert exact root DOM opt out with `false`. */
  enableConnectionIndicator?: boolean;
  /** Reload seam for a server switch. Defaults to `location.reload()`; tests
   *  inject a spy. Mirrors `startup-reload-recovery`'s `reload` option — a
   *  boot is how this app changes which server it is talking to, since every
   *  live surface (ws client, broadcast cursor, route caches) is wired to
   *  exactly one. */
  reloadForServerSwitch?: () => void;
  /** Same-tab, one-shot switch receipt storage. Defaults to sessionStorage;
   *  null disables the receipt without preventing a safe switch. */
  serverSwitchContinuityStorage?: ServerSwitchContinuityStorage | null;
  /** Privacy-safe, same-tab interrupted OAuth marker. Defaults to
   * sessionStorage and is bound to the active server profile; null disables
   * reload recovery without ever persisting codes, state, or secrets. */
  foundationalOAuthContinuityStorage?: FoundationalOAuthContinuityStorage | null;
  /** Privacy-safe, same-tab provider-app guide draft. Defaults to
   * sessionStorage, is bound to the active server profile, and never stores
   * connection-form values or credentials. */
  providerSetupContinuityStorage?: ProviderSetupContinuityStorage | null;
  /** Secret-free, same-tab pointer for an interrupted credential replacement.
   * Defaults to sessionStorage and is bound to the active server profile. */
  credentialRotationContinuityStorage?: CredentialRotationContinuityStorage | null;
  /** Secret-free, same-tab pointer from an unsupported rotation preflight,
   * through a server update/restart, back to that exact connection. */
  credentialRotationServerUpdateContinuityStorage?:
    CredentialRotationServerUpdateContinuityStorage | null;
  /** Origin-wide, privacy-safe rotation pulse storage. Persisted pulses contain
   * only profile scope + opaque event id; connection identity is ephemeral on
   * BroadcastChannel. Defaults to localStorage, null disables that fallback. */
  credentialRotationTabStorage?: CredentialRotationTabStorage | null;
  /** Origin-wide, profile-only last-observed recovery availability. Records
   * contain an opaque profile id, boolean, and observation time only. Defaults
   * to localStorage; null disables inactive-profile discovery. */
  inactiveProfileRecoveryStorage?: InactiveProfileRecoveryStorage | null;
  /** Same-tab, profile-only intent from an inactive reminder through the
   * deliberate switch reload to a fresh Attention list. Defaults to
   * sessionStorage; null disables automatic destination recheck continuity. */
  inactiveProfileRecoveryReviewStorage?:
    InactiveProfileRecoveryStorage | null;
  /** Same-tab, privacy-safe continuation after automatic recovery focus pauses.
   * Stores only active profile, scrubbed route, closed intent, and timestamp. */
  recoveryIntentContinuationStorage?:
    RecoveryIntentContinuationStorage | null;
  /** Bounded receipt-retry timer seam. Production uses a short setTimeout;
   * tests may capture callbacks without sleeping. */
  serverUpdateReceiptScheduleRetry?:
    ServerUpdateReceiptVerificationScheduler;
  /** D-219 item 2b — same-tab carrier for an AI-written recipe draft. Defaults
   *  to sessionStorage; null disables the Kitchen hand-off without breaking the
   *  panel. */
  draftStashStorage?: ExecutionCaseDraftStorage | null;
  /** Silent URL rewrite used to remove source-server record ids before the
   *  reload. Production defaults to history.replaceState. */
  replaceHashForServerSwitch?: (hash: string) => void;
  /** Short grace for the final `instance_revoked` frame after a self-revoke
   *  rpc loses its reply with the closing socket. Production uses the helper
   *  default; deterministic tests may shorten it. */
  selfRevokeReceiptGraceMs?: number;
  /** Shell-frame Step 2 — when not explicitly `false` (the default is ON), the
   *  route-independent live-control bubble (D-181 RUNNING + D-186 GRANTS) mounts
   *  at the webclient root beside the bell. Tests that don't exercise it opt out
   *  with `false` (same discipline as `enableTlsRenewPanel`). */
  enableLiveControlBubble?: boolean;
  /** D-165 P3.enroll-host + D-174 P3 + D-201 Slices 5A/5B2B — when not explicitly
   *  `false` (the default is ON), the top-level `#connections` route mounts
   *  outbound connection enrollment and the inbound Webhooks control plane:
   *  list / add
   *  (kind → optional subtype → form) / edit / delete / probe over the five
   *  `collection.connection.{list,enroll,update,delete,probe}` handlers. The
   *  only UI path to CREATE a connection (the grant panel only manages grants
   *  on existing ones). All five run on the standard pair-WS channel
   *  (per-pair-only; `collection.connection.` is reserved from MCP), so the
   *  webclient's bearer auth path is sufficient. Tests opt out by passing
   *  `false`. */
  enableConnectionsEnrollPanel?: boolean;
  /** D-174 P2.1 — when not explicitly `false` (the default is ON), the
   *  top-level `#contracts` route mounts the contract credential surface: the MCP
   *  door token lifecycle plus optional `contract.override.*` restriction
   *  editor. The handlers run on the standard pair-WS channel (per-pair-only;
   *  `collection.contract.` / `chat.inbound_token.` are reserved from MCP), so
   *  the webclient's bearer auth path is sufficient. Tests opt out by passing
   *  `false`. */
  enablePermissionsPanel?: boolean;
  /** D-166 contract_id lifecycle — when not explicitly `false` (the default is
   *  ON), the top-level `#contracts` route mounts the contract inventory:
   *  list minted contracts with their lifecycle pill + revoke one (the
   *  kill-switch). The `collection.contract.{listContracts,revokeContract}`
   *  handlers run on the standard pair-WS channel (per-pair-only;
   *  `collection.contract.` is reserved from MCP), so the webclient's bearer
   *  auth path is sufficient. Tests opt out by passing `false`. */
  enableContractsPanel?: boolean;
  /** D-182 §7.2 (increment 4) — when not explicitly `false` (the default is ON),
   *  the cli.reachability callers are wired: reads `cli.reachability.universe` +
   *  `cli.reachability.list` + `collection.contract.listContracts`, writes
   *  `cli.reachability.set`. The `cli.reachability.` family is reserved from MCP
   *  (owner-only), so the webclient's bearer auth path is sufficient. Tests opt
   *  out by passing `false`.
   *
   *  ⚠ 2026-07-27 — renamed from `enableLocalToolsPanel`. The roster-wide "Local
   *  tools" section it used to gate is deleted, but these callers are NOT
   *  panel-specific: passing `false` now also strips the by-pack ACCESS panel's
   *  cli op toggles (they render inert with no `set` writer) and ungates
   *  supervised-daemon Start/Auto for a binary that isn't on PATH. It is a
   *  cli-reachability kill-switch, not a UI toggle. */
  enableCliReachability?: boolean;
  /** D-174/D-175 — when not explicitly `false` (the default is ON), the
   *  Settings -> Account section mounts the recued.com binding touchpoint.
   *  It reads `account.bindingStatus` + `pro_convenience.status`, relays
   *  Worker-minted binding tokens through `account.bind`, and unbinds via
   *  `account.unbind`. Tests opt out by passing `false`. */
  enableAccountBindingPanel?: boolean;
  /** Optional auth Worker base URL for binding-token minting. Defaults from
   *  the build-time cloud apex (`auth.<apex>`, default `auth.recued.com`). */
  accountBindingAuthWorkerUrl?: string;
  /** Optional dashboard URL for account/billing links. Defaults from the
   *  build-time cloud apex (`dashboard.<apex>`, default `dashboard.recued.com`). */
  accountBindingDashboardUrl?: string;
  /** Optional fetch seam for auth Worker session/token calls. */
  accountBindingFetch?: AccountBindingFetch;
}

/** Minimal contract for the URL-hash source. Tests inject a fake;
 *  production wires `globalThis.location` + `globalThis.window`. */
export interface WebclientHashSource {
  /** Current hash (with or without leading `#`). */
  getHash(): string;
  /** Subscribe to hash changes. Returns an unsubscribe fn. */
  onChange(listener: (hash: string) => void): () => void;
  /** Optional imperative navigation seam. Production and the full-app browser
   * harness provide it; read-only embedders may omit it. */
  setHash?(hash: string): void;
}

/** Mounted webclient handle — tear-down + introspection. */
export interface WebclientHandle {
  /** Active route id (driven by the hash listener). */
  activeRoute(): WebclientRouteId;
  /** The constructed Reception shell — exposed so the host runtime
   *  can drive surfaces the bootstrap didn't subscribe to (e.g.
   *  `setStatus` on exposure change). */
  receptionShell(): ReceptionPageShell;
  /** Typed rpc dispatch — exposed for surfaces that aren't owned by
   *  any shell yet (e.g. a future Settings → Privacy "Clear this
   *  browser" button that calls a server rpc directly). */
  conn(): Conn<ServerRpcRegistry>;
  /** § A.4.1 — the Settings route handle when `'settings'` is the
   *  active route. Returns `null` when a non-settings route is
   *  mounted; tests use this to drive the Privacy "This browser" wipe
   *  through the route's `clearThisBrowserPanel()` accessor. The route's
   *  lifecycle is owned by the bootstrap. */
  settingsRoute(): SettingsRoute | null;
  /** § A.6.5 / slice 113 — the cert-pin state watcher feeding the
   *  Settings → Server overlap panel. Returns `null` when the
   *  bootstrap opted out via `enableCertPinStalePanel: false`.
   *  Exposed so tests can `notify()` synthetic transitions + hosts
   *  can read the latest snapshot without round-tripping through
   *  `localStore`. */
  certPinStateWatcher(): CertPinStateWatcher | null;
  /** Exact local profile this live shell booted against. Unlike the durable
   * active pointer, this value never changes during the handle's lifetime. */
  serverProfileId(): string | null;
  /** Reconcile this already-mounted shell after a sibling changed the durable
   * active profile. Clean routes reload silently; dirty routes pause behind an
   * explicit, copy-safe discard boundary. A detail-free cross-tab hint omits
   * the target so this handle resolves it from durable storage itself. */
  requestServerProfileConvergence(targetProfileId?: string): void;
  /** Capture the exact in-memory work that a forced re-pair would otherwise
   * destroy. Durable route data is intentionally excluded and re-read from
   * the server after pairing. */
  captureRecoverySnapshot(): WebclientRecoverySnapshot;
  /** Re-read the local server roster without remounting the shell. The
   *  pair-fallback host calls this on credential-free sibling-tab hints, even
   *  when the active credential generation itself did not change. */
  refreshServerProfiles?(): void;
  /** Tear down every constructed surface in reverse order (DD#6).
   *  Idempotent. */
  dispose(): Promise<void>;
}

export interface WebclientRecoverySnapshot {
  /** Exact live hash, including deep-link segments silently written by Chat. */
  readonly returnHash: string;
  /** Present only when Chat currently holds non-empty unsent composer text. */
  readonly chatDraft?: ChatRouteRecoveryDraft;
}

// ════════════════════════════════════════════════════════════════
// Pair-state hydration
// ════════════════════════════════════════════════════════════════

/** Post-pair invariant — the three fields every connection needs.
 *  `pair_metadata` + `cert_pin_state` may be partial during certain
 *  re-pair transitions; the three below are strict. */
interface HydratedPairState {
  serverUrl: string;
  serverPublicKey: string;
  token: WebclientTokenRecord;
}

const hydratePairState = async (
  store: WebclientLocalStore,
): Promise<HydratedPairState> => {
  const serverUrl = await store.get('server_url');
  const serverPublicKey = await store.get('server_public_key');
  const token = await store.get('webclient_token');
  if (!serverUrl) throw new WebclientUnpairedError('server_url missing');
  if (!serverPublicKey)
    throw new WebclientUnpairedError('server_public_key missing');
  if (!token) throw new WebclientUnpairedError('webclient_token missing');
  return { serverUrl, serverPublicKey, token };
};

const buildAad = (pair: HydratedPairState): WebclientTokenAad => ({
  token_id: pair.token.token_id,
  server_url: pair.serverUrl,
  server_public_key: pair.serverPublicKey,
});

// ════════════════════════════════════════════════════════════════
// Default hash source
// ════════════════════════════════════════════════════════════════

interface BrowserGlobalShape {
  location?: { hash?: string; pathname?: string };
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

const resolveDefaultHashSource = (): WebclientHashSource | null => {
  const g = globalThis as BrowserGlobalShape;
  if (!g.location || typeof g.addEventListener !== 'function' || typeof g.removeEventListener !== 'function') {
    return null;
  }
  const readRouteish = (): string => {
    const hash = g.location?.hash ?? '';
    if (hash.length > 0) return hash;
    return g.location?.pathname ?? '';
  };
  return {
    getHash: readRouteish,
    onChange: (listener) => {
      const wrapped = (): void => listener(readRouteish());
      g.addEventListener!('hashchange', wrapped);
      g.addEventListener!('popstate', wrapped);
      return () => {
        g.removeEventListener!('hashchange', wrapped);
        g.removeEventListener!('popstate', wrapped);
      };
    },
    setHash: (hash) => {
      if (g.location !== undefined) g.location.hash = hash;
    },
  };
};

// ════════════════════════════════════════════════════════════════
// bootstrapWebclient
// ════════════════════════════════════════════════════════════════

const DEFAULT_RECEPTION_STATUS: ReceptionStatusInput = {
  reception_public: false,
  emergency_disabled: false,
  base_url: null,
};

export const deriveComposeReceptionStatusFromHostnames = (
  hostnames: ReadonlyArray<HostnameProjection>,
  current: ReceptionStatusInput = DEFAULT_RECEPTION_STATUS,
  probeResult: DiagnosticResponse | null = null,
): (ReceptionStatusInput & { reachable: boolean }) | null => {
  for (const hostname of hostnames) {
    if (!canBindHostname(hostname)) continue;
    const port = hostname.listener_ports.includes(443)
      ? 443
      : hostname.listener_ports[0];
    if (port === undefined) continue;
    const authority =
      port === 443 ? hostname.hostname : `${hostname.hostname}:${port}`;
    return {
      emergency_disabled: current.emergency_disabled,
      reception_public: true,
      base_url: `https://${authority}/reception/`,
      reachable: diagnosticResponseShowsReachableUrl(
        probeResult,
        hostname.hostname,
        port,
      ),
    };
  }
  return null;
};

/** § A.6.5 / slice 114 — default polling cadence (60_000 ms) for the
 *  cert-pin overlap panel's time-passage auto-hide tick (DD#10). The
 *  flip-time formatter (`buildCertPinStaleView`) buckets relative
 *  time at `1h` / `1d` granularity + collapses sub-hour windows to
 *  `'in <1h'`. A 60s tick catches both the bucket boundary + the
 *  actual `current_valid_until` flip within a minute — fine-grained
 *  enough for the user-visible auto-hide, coarse enough that an idle
 *  page doesn't churn through redundant ticks. */
export const CERT_PIN_POLL_INTERVAL_MS = 60_000;

/** Real-interval implementation for the cert-pin polling seam (DD#10).
 *  Returns a cancel handle so the bootstrap's dispose() chain tears
 *  the timer down without leaking a `setInterval` reference. */
const realCertPinPollTimer = (
  handler: () => void,
  intervalMs: number,
): { cancel: () => void } => {
  const id = setInterval(handler, intervalMs);
  return { cancel: () => clearInterval(id) };
};

const hostnameFromHandle = (handle: string): string | null => {
  const normalized = handle.trim().toLowerCase();
  if (normalized.length === 0) return null;
  return normalized.includes('.') ? normalized : `${normalized}.recued.cloud`;
};

/** Build the `execute` rpc args for a route-initiated recipe run.
 *
 *  ⛔ EXTRACTED AND EXPORTED ON PURPOSE — this is the whole webclient→server
 *  wire for `execute`, and a member missing here is dropped SILENTLY while the
 *  route that supplied it still reads as correct. Inside the `bootstrapWebclient`
 *  closure it was unreachable by any test, and D-222 shipped with `invocation`
 *  erased right here: `bootstrap-recipes-route` passed it, `buildRpcExecuteRequest`
 *  on the server accepted it, and this adapter in between quietly deleted it — so
 *  every filter submit arrived as an ordinary run and the server skipped stored
 *  hash/section re-resolution AND the per-block allowlist. The route's own tests
 *  substitute their own `recipeExecuteCaller`, so they could never see it.
 *
 *  ⚠ A TYPE CANNOT GUARD THIS. The registry's `execute` request carries an
 *  `[k: string]: unknown` index signature, so a narrower hand-written shape — and
 *  a derived one — both typecheck with members missing. Only a test over this
 *  function proves the wire carries what the caller handed it. Mirrors the
 *  server's `buildRpcExecuteRequest`, exported for the same reason. */
export const buildRecipeExecuteArgs = (
  args: Parameters<RecipeExecuteCaller>[0],
): RpcRequest<ServerRpcRegistry, 'execute'> => {
  const executeArgs: RpcRequest<ServerRpcRegistry, 'execute'> = {
    recipe_id: args.recipe_id,
    trigger_source: 'manual',
  };
  if (args.config !== undefined) {
    executeArgs.config = args.config;
  }
  // Targeting guard (design § 8) — the run modal's filled target
  // fields ride the run as caller context (e.g. `{ entity_id }`).
  if (args.context !== undefined) {
    executeArgs.context = args.context;
  }
  // D-222 § 6.2 — host control-plane provenance for a submit that came through
  // an authored `filter` block. Without it the server cannot tell a filter
  // submit from an ordinary run carrying the same `config`, so a stale view
  // submits silently instead of refusing `filter_invocation_stale`. The ordinary
  // run modal never authors it.
  if (args.invocation !== undefined) {
    executeArgs.invocation = args.invocation;
  }
  return executeArgs;
};

/** Compose the webclient PWA. Returns a handle whose `dispose()` tears
 *  down every constructed surface in reverse order. Throws
 *  `WebclientUnpairedError` synchronously (as a rejected promise) when
 *  the local store has no pair state. */
export const bootstrapWebclient = async (
  options: BootstrapWebclientOptions,
): Promise<WebclientHandle> => {
  // 1. Hydrate pair state — the rest of the pipeline depends on this.
  const pair = await hydratePairState(options.localStore);
  // Restore the hydrated server as a named profile deliberately. The logical
  // five-key read above already resolves through the persisted active pointer,
  // but making the roster boundary explicit keeps cold boot (including lazy
  // legacy migration) from depending on `set('server_url')` side effects that
  // happen to have run during an earlier pairing.
  const bootProfileId = options.profileStore !== undefined
    ? await options.profileStore.ensureProfile(pair.serverUrl)
    : null;
  let bootProfileLabel = defaultProfileLabel(pair.serverUrl);
  let knownServerProfiles: ReadonlyArray<WebclientServerProfile> = [];
  const serverSwitchArrival = consumeServerSwitchArrival(
    options.serverSwitchContinuityStorage,
  );
  let serverSwitchArrivalReceiptCopy: string | undefined;
  let serverSwitchArrivalProfileLabel: string | undefined;
  if (
    serverSwitchArrival !== null
    && bootProfileId !== null
    && serverSwitchArrival.targetProfileId === bootProfileId
    && options.profileStore !== undefined
  ) {
    try {
      const arrivedProfile = (await options.profileStore.listProfiles())
        .find((profile) => profile.id === bootProfileId);
      if (arrivedProfile !== undefined) {
        const arrivedLabel = arrivedProfile.label.trim();
        serverSwitchArrivalProfileLabel = arrivedLabel.length > 0
          ? arrivedLabel
          : bootProfileLabel;
        serverSwitchArrivalReceiptCopy =
          `Now using ${serverSwitchArrivalProfileLabel}.`;
      }
    } catch {
      // The target id was verified, but identity copy without the local roster
      // would be vague. The switch still succeeds; only its receipt degrades.
    }
  }
  const aad = buildAad(pair);

  // 2. WS client — `resolveBearer` re-unwraps on every reconnect (DD#2).
  const ws: WebclientWsClient = createWebclientWsClient({
    transport: options.transport,
    resolveServerUrl: async () => {
      // Tolerate a paranoid store-mutation case: the user clears the
      // browser mid-session, the store now returns null. The ws-client
      // surfaces a reconnect failure via its own error path; we just
      // refuse to fabricate a URL.
      const current = await options.localStore.get('server_url');
      return current ?? pair.serverUrl;
    },
    resolveBearer: async () => {
      const current = await options.localStore.get('webclient_token');
      const record = current ?? pair.token;
      // DD#2 — unwrap fresh on every call; never cache plaintext.
      const plaintext = await options.tokenStore.unwrap(record, {
        ...aad,
        token_id: record.token_id,
      });
      // D-148 § A.2.1 — structured `<token_id>.<bearer>` bearer shape.
      // The server-side `parseStructuredBearer` splits on the first `.`
      // and calls `clientTokens.verify(token_id, bearer)` BEFORE socket
      // acceptance. Populating `token_id` on the wire is what unlocks
      // the `pair.mint` webclient gate (the verify result lands on
      // `WsClient.client_token_id` + the rpc-layer gate admits the
      // caller via the second of two acceptance paths) AND auto-fills
      // the `pair_revoke.detail.client_token_id` join column. Pre-slice
      // 127 the webclient sent just the raw bearer, so the server fell
      // through to the legacy accept-any path + `pair.mint` rejected
      // every webclient with `unauthorized` (no `register` rpc → no
      // `user_id`). Token_id is opaque + safe to log; base64 alphabet
      // never contains `.` so the separator is unambiguous.
      return `${record.token_id}.${plaintext}`;
    },
  });

  // 2.5. Connection-status controller — derives the coarse, debounced
  //      `connecting / connected / reconnecting / offline` view of the
  //      ws-client's raw state machine that BOTH the topbar chip/banner
  //      and the rpc conn read. Constructed BEFORE the rpc conn (which it
  //      feeds) and BEFORE `ws.connect()` (it boots non-connected + arms
  //      its grace timer immediately, so a server that's down at boot
  //      still surfaces `offline`). See `realtime/connection-status.ts`.
  const connectionStatus: WebclientConnectionStatusController =
    createWebclientConnectionStatus({
      ws,
      ...(options.connectionStatusGraceMs !== undefined
        ? { offlineGraceMs: options.connectionStatusGraceMs }
        : {}),
      ...(options.setConnectionStatusTimer !== undefined
        ? { setTimer: options.setConnectionStatusTimer }
        : {}),
    });
  // Reconnect seam derived from the controller — fires on each `connected`
  // transition. Threaded into the surfaces holding a one-shot
  // `approval.subscribe` (the approvals route + the attention popover) so
  // they re-register with a possibly-restarted server + clear a stale
  // "live updates unavailable" error on reconnect.
  const reconnect: WebclientReconnectSubscriber =
    reconnectSubscriberFromStatus(connectionStatus);

  // 3. Broadcast subscriber + rpc conn — both filter on disjoint
  //    envelope fields, so they coexist on `ws.onMessage`. The
  //    production wire shape from `backend/server/src/events/handler.ts`
  //    is `{ type: 'server_event', event: ServerEvent }` (per
  //    `packages/contracts/src/events.ts` line 11); the subscriber is
  //    a pure dispatcher over `ServerEvent`, so the wire-shape concern
  //    is owned at this boundary. Codex 2026-05-16 P2 #1 fold —
  //    pre-fold, every broadcast handler (cert-pin, token-rotation,
  //    reception, this new pair-required slice) was dead in production
  //    because the dispatcher only saw `e.kind` at the envelope top-
  //    level, not under `e.event.kind`. We unwrap iff the top-level
  //    `type` is `'server_event'`; non-matching shapes fall through so
  //    tests that synthesise bare events through `subscriber.dispatch`
  //    keep working without an envelope-aware fixture.
  const subscriber: BroadcastSubscriber = createBroadcastSubscriber();
  // Server-status pill handle — assigned when the connection chrome mounts
  // (below). The demux feeds it heartbeat snapshots; the `?.` guards the case
  // where the chrome is disabled (tests) and the handle stays null.
  let serverPill: WebclientServerPillMount | null = null;
  const detachBroadcast = ws.onMessage((message) => {
    if (message !== null && typeof message === 'object') {
      const messageType = (message as { type?: unknown }).type;
      // Tier 3 — a `server_heartbeat` arrival proves the paired server is
      // responsive right now (the server pushes these only while `running`).
      // Feed it to the connection-status controller's half-open detector; it
      // is NOT a `ServerEvent`, so it must not reach the subscriber.
      if (messageType === 'server_heartbeat') {
        connectionStatus.noteHeartbeat();
        // D-109 — also feed the server-status pill the snapshot. The emitter
        // sends `{ type, payload: ServerHeartbeatSnapshot }`; the structural
        // guard drops a malformed frame (the shared renderer only null-guards,
        // so a partial object would otherwise render a bogus "Server · 0s").
        const payload = (message as { payload?: unknown }).payload;
        if (isServerHeartbeatSnapshot(payload)) {
          serverPill?.noteSnapshot(payload);
        }
        return;
      }
      if (messageType === 'server_event') {
        subscriber.dispatch((message as { event?: unknown }).event);
        return;
      }
    }
    subscriber.dispatch(message);
  });
  const rpcConn: WebclientRpcConn<ServerRpcRegistry> = createWebclientRpcConn({
    ws,
    connectionStatus,
  });
  // A self-`pair.revoke` intentionally closes this session. Keep that known
  // retirement out of the generic rejected-credential recovery funnel: the
  // Account action owns revoke → durable local removal → reload. If the
  // revoke itself fails, replay any reauth signal that arrived while the
  // attempt was in flight so a genuinely rejected session still recovers.
  let intentionalProfileRetirement = false;
  let suppressedRetirementReauth = false;
  let replaySuppressedRetirementReauth = (): void => undefined;
  const onApprovalChanged: ApprovalChangedSubscriber = (listener) =>
    ws.onMessage((message) => {
      const event = parseApprovalChangedMessage(message);
      if (event !== null) listener(event);
    });

  // 3.5. `token.rotated` handler — closes the credential-refresh
  //      loop. Subscribed BEFORE `ws.connect()` (DD#7) so a rotation
  //      that lands in the replay window of the next subscribe ack
  //      is observed. Sibling subscribers (the user's other paired
  //      surfaces) receive the same broadcast but filter on
  //      `target_token_id` and no-op.
  const tokenRotation = createTokenRotationHandler({
    localStore: options.localStore,
    tokenStore: options.tokenStore,
    subscriber,
    ws,
    ...(options.onTokenRotationError !== undefined
      ? { onError: options.onTokenRotationError }
      : {}),
    ...(options.onTokenRotated !== undefined
      ? { onRotated: options.onTokenRotated }
      : {}),
  });

  // 3.6. `cert.rotation_notice` + `cert.rotation_reverted` handler —
  //      § A.6.5 two-pin overlap protocol. Each notice is signed by
  //      the server identity key the pair-blob acquisition pinned;
  //      invalid signatures are dropped silently. Subscribed BEFORE
  //      `ws.connect()` for the same DD#7 reason. Every paired client
  //      applies cert rotations independently (no `target_*`
  //      discriminator — there's one cert per server).
  //
  //      Slice 113 — `certPinWatcher` is the in-memory mirror feeding
  //      the Settings → Server cert-pin overlap panel. The watcher's
  //      `notify` is wired as the cert-pin handler's `onStateChanged`
  //      callback so a post-persist transition surfaces synchronously
  //      to the panel; a cold boot reads the persisted snapshot via
  //      `watcher.refresh()` after the handler is constructed. The
  //      panel is gated on `enableCertPinStalePanel !== false`
  //      (default-on in production; tests opt out per Server-section
  //      discipline).
  const certPinWatcher: CertPinStateWatcher | null =
    options.enableCertPinStalePanel === false
      ? null
      : createCertPinStateWatcher({
          localStore: options.localStore,
          ...(options.onCertPinRefreshError !== undefined
            ? { onRefreshError: options.onCertPinRefreshError }
            : {}),
        });
  const certPin = createCertPinHandler({
    localStore: options.localStore,
    subscriber,
    ...(options.onCertPinError !== undefined
      ? { onError: options.onCertPinError }
      : {}),
    ...(certPinWatcher !== null
      ? { onStateChanged: certPinWatcher.notify }
      : {}),
  });
  // Cold-boot snapshot read. Fire-and-forget — failures surface via
  // `onCertPinRefreshError` (when wired); the panel hides until the
  // first valid `cert.rotation_notice` broadcast lands. Awaiting here
  // would race the rest of the bootstrap's setup for a UI surface
  // that's secondary to the user's primary flow.
  if (certPinWatcher !== null) {
    void certPinWatcher.refresh();
  }

  // D-156 P8 retired the `pair_required` broadcast handler + the
  // re-pair banner mount (per spec § Open questions Q2): the natural
  // disconnect → unpaired-state → pair-form flow replaces them. The
  // `doc` lookup below still happens because the Settings route mount
  // (further down) needs it.
  const doc = options.document ?? (globalThis as { document?: Document }).document;
  if (doc === undefined) {
    throw new Error(
      'bootstrapWebclient: no document available — pass `options.document` for non-browser environments',
    );
  }

  // 3.9. Notify toasts (D-169 P2 Slice 5, toast half). The route-
  //      independent ephemeral pop on each `notification.notify` bus
  //      frame, mounted at `options.root` so it survives route swaps (the
  //      posture the retired re-pair banner used per DD#9). Bus-driven
  //      only (no rpc) + additive to the Settings → Notifications feed,
  //      which owns the durable record. Default ON; tests opt out via
  //      `enableNotifyToasts: false`. Styles inject once into <head>,
  //      marker-guarded (same discipline as the settings route's bundle).
  let notifyToasts: NotifyToastsMount | null = null;
  if (options.enableNotifyToasts !== false) {
    if (
      doc.head !== undefined
      && doc.head.querySelector(`style[${NOTIFY_TOASTS_STYLES_MARKER}]`) === null
    ) {
      const toastStyle = doc.createElement('style');
      toastStyle.setAttribute(NOTIFY_TOASTS_STYLES_MARKER, '');
      toastStyle.textContent = NOTIFY_TOASTS_STYLES;
      doc.head.appendChild(toastStyle);
    }
    notifyToasts = mountNotifyToasts({
      host: options.root,
      document: doc,
      subscribe: subscriber.on,
    });
  }

  // 4. Reception page shell — constructed once because the `#reception`
  // route owns its broadcast-backed Settings projection.
  const receptionShell = createReceptionPageShell({
    call: rpcConn.call,
    subscribe: subscriber.on,
    now: options.now ?? Date.now,
    initialStatus: options.initialReceptionStatus ?? DEFAULT_RECEPTION_STATUS,
  });
  const detachExposureChanged = subscriber.on('exposure_changed', (event) => {
    const current = receptionShell.getState().status;
    const reception_public = event.resolution.reception.public;
    receptionShell.setStatus({
      ...current,
      reception_public,
      base_url: reception_public ? current.base_url : null,
    });
  });

  // 5. Route discriminator — read once + subscribe to hashchange.
  const hashSource = options.hashSource ?? resolveDefaultHashSource();
  // Resolve a hash to the route that will ACTUALLY mount. `#approvals`
  // needs the pending-decisions callers wired; when the route is disabled
  // (`enableApprovalsRoute: false`) it degrades to the
  // default route — so the tracked `activeRoute` always matches what
  // `mountRoute` mounts and the hashchange no-op guard below stays correct.
  const resolveRoute = (hash: string): WebclientRouteId => {
    const parsed = parseRouteFromHash(hash);
    if (parsed === 'approvals' && options.enableApprovalsRoute === false) {
      return WEBCLIENT_DEFAULT_ROUTE;
    }
    return parsed;
  };
  let activeRoute: WebclientRouteId = hashSource
    ? resolveRoute(hashSource.getHash())
    : WEBCLIENT_DEFAULT_ROUTE;
  let activeHash = hashSource?.getHash() ?? serializeShellRoute(activeRoute);
  let recoveryReturnArrival: {
    readonly landingHash: string;
    readonly areaLabel: string;
    readonly profileLabel: string;
    readonly returnContext: RecoveryReturnContext | undefined;
  } | undefined;
  if (
    serverSwitchArrivalProfileLabel !== undefined
    && serverSwitchArrival?.recoveryReturnLandingHash !== undefined
    && serverSwitchArrival.recoveryReturnLandingHash === activeHash
    // A feature-gated route can resolve to a different mounted surface while
    // leaving its original hash in the address bar. Confirm resumed work only
    // when the route named by the marker is the route this shell will mount.
    && parseRouteFromHash(activeHash) === activeRoute
  ) {
    const areaLabel = serverSwitchLandingAreaLabel(activeHash);
    recoveryReturnArrival = {
      landingHash: activeHash,
      areaLabel,
      profileLabel: serverSwitchArrivalProfileLabel,
      returnContext: serverSwitchArrival.recoveryReturnContext,
    };
  }
  let settledProfileRecoveryNeedsAddressCleanup = false;
  const serverSwitchLandingHash = (
    sourceHash: string,
    targetProfileId: string,
  ): string => {
    if (settledProfileRecoveryNeedsAddressCleanup) {
      return safeServerSwitchLandingHash(sourceHash);
    }
    const route = parseShellRoute(sourceHash);
    if (route.surface === 'connections') {
      const resolution = resolveProfileBoundPostSafeStopRecovery(
        route.segments,
        targetProfileId,
      );
      if (resolution.status === 'matched') {
        return serializeConnectionsPostSafeStopRecovery(resolution.target);
      }
    }
    return safeServerSwitchLandingHash(sourceHash);
  };
  const navigateHash = (hash: string): void => {
    if (hashSource?.setHash !== undefined) {
      hashSource.setHash(hash);
      return;
    }
    const location = doc.defaultView?.location;
    if (location !== undefined) location.hash = hash;
  };

  // Mount the active route. The discriminator now knows two routes:
  // `'reception'` (default) and `'settings'` (slice 110 — currently
  // hosts the Privacy "Clear this browser" panel; future sections
  // graduate by appending to the route's container). A future
  // Settings surface (Connections / Exposure / Devices / TLS) either
  // grows a third arm here OR adds a section to the settings route.
  let activeSettingsRoute: SettingsRoute | null = null;
  // The §D.L2 drawer "Create" action seat opens the shared Create overlay. The
  // shell is built here, before the local-write callers below, so the seat
  // calls through a stable thunk that resolves to `createSeatHandler` (assigned
  // once those callers exist). The thunk is only ever invoked on a user click,
  // long after the synchronous bootstrap finishes, so the late binding is safe.
  // The open handle is tracked so bootstrap `dispose()` can tear a drawer-opened
  // overlay down (it portals to document.body, OUTSIDE the shell root) and so a
  // second click can't stack a duplicate while one is open.
  let createSeatHandler: (() => void) | undefined;
  let drawerCreateOverlay: CreateOverlayHandle | null = null;
  const appShell = createWebclientShell({
    root: options.root,
    document: doc,
    activeRoute,
    activeSegments: parseShellRoute(activeHash).segments,
    onCreateSeat: () => createSeatHandler?.(),
  });

  // Live connection callout — a visually hidden topbar announcer plus the
  // route-independent offline/restoration banner, both driven by the
  // `connection-status` controller. Default ON;
  // `enableConnectionIndicator: false` opts out (tests that assert exact
  // topbar / root DOM without the chrome). See `shell/connection-indicator.ts`.
  let connectionIndicator: ConnectionIndicatorMount | null = null;
  let deferredRecoveryReturnArrival: typeof recoveryReturnArrival;
  let pendingRecoveryReturnAction: {
    readonly landingHash: string;
    readonly onArrival: (handle: RecoveryContextProbe) => void;
    readonly onDeclined: () => void;
  } | null = null;
  let resolveRecoveryReturnDeparture: (() => void) | null = null;
  const markRecoveryReturnDeparted = (): void => {
    const resolve = resolveRecoveryReturnDeparture;
    resolveRecoveryReturnDeparture = null;
    resolve?.();
  };
  let accountMenu: AccountMenuMount | null = null;
  let approvalAttentionPopover: ApprovalAttentionPopoverMount | null = null;
  const recoveryIntentNow = (): number => {
    try {
      const value = (options.now ?? Date.now)();
      return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
    } catch {
      return Date.now();
    }
  };
  const recoveryIntentContinuationStore =
    createRecoveryIntentContinuationStore({
      document: doc,
      ...(options.recoveryIntentContinuationStorage !== undefined
        ? { storage: options.recoveryIntentContinuationStorage }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  const recoveryIntentDeferredCheckStore =
    createRecoveryIntentDeferredCheckStore({
      document: doc,
      ...(options.recoveryIntentContinuationStorage !== undefined
        ? { storage: options.recoveryIntentContinuationStorage }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  let bootRecoveryIntentDeferredCheck: RecoveryIntentDeferredCheck | null =
    bootProfileId === null
      ? null
      : recoveryIntentDeferredCheckStore.readForProfile(bootProfileId);
  if (
    bootRecoveryIntentDeferredCheck !== null
    && (
      recoveryReturnArrival !== undefined
      || resolveRoute(bootRecoveryIntentDeferredCheck.landingHash)
        !== parseRouteFromHash(bootRecoveryIntentDeferredCheck.landingHash)
    )
  ) {
    recoveryIntentDeferredCheckStore.clear();
    bootRecoveryIntentDeferredCheck = null;
  }
  let bootDeferredCheckExpired =
    bootRecoveryIntentDeferredCheck !== null
    && recoveryIntentNow() >= bootRecoveryIntentDeferredCheck.expiresAt;
  if (
    bootDeferredCheckExpired
    && bootRecoveryIntentDeferredCheck?.diagnosisOutcome
      === 'recheck_started'
  ) {
    // A reload consumes an in-flight post-diagnosis recheck. It becomes a
    // closure-only area result before routes or reconnect observers mount;
    // the one-shot check is never replayed after boot.
    bootRecoveryIntentDeferredCheck =
      recoveryIntentDeferredCheckStore.recordDiagnosisRecheckFailure(
        bootRecoveryIntentDeferredCheck,
        'area',
      );
    if (bootRecoveryIntentDeferredCheck === null) {
      recoveryIntentDeferredCheckStore.clear();
      bootDeferredCheckExpired = false;
    }
  }
  if (
    bootDeferredCheckExpired
    && bootRecoveryIntentDeferredCheck !== null
    && bootRecoveryIntentDeferredCheck.attemptCount >= 2
    && bootRecoveryIntentDeferredCheck.diagnosisTarget === null
  ) {
    // A second broad-area attempt that survives only as an in-flight marker
    // was interrupted by this reload. Close the retry loop before any route
    // read or reconnect observer can run; persist only its broad diagnosis
    // owner, never the interrupted response or error.
    bootRecoveryIntentDeferredCheck =
      recoveryIntentDeferredCheckStore.recordReviewFailure(
        bootRecoveryIntentDeferredCheck,
        'area',
      );
    if (bootRecoveryIntentDeferredCheck === null) {
      recoveryIntentDeferredCheckStore.clear();
      bootDeferredCheckExpired = false;
    }
  }
  let recoveryIntentContinuationMarker: RecoveryIntentContinuation | null =
    bootProfileId === null
      ? null
      : recoveryIntentContinuationStore.readForProfile(bootProfileId);
  if (bootProfileId === null) {
    recoveryIntentContinuationStore.retire();
  }
  if (bootDeferredCheckExpired && bootRecoveryIntentDeferredCheck !== null) {
    const belongsToCurrentParent =
      recoveryIntentContinuationMarker !== null
      && recoveryIntentContinuationMarker.profileId
        === bootRecoveryIntentDeferredCheck.profileId
      && recoveryIntentContinuationMarker.landingHash
        === bootRecoveryIntentDeferredCheck.landingHash
      && recoveryIntentContinuationMarker.pausedAt
        === bootRecoveryIntentDeferredCheck.pausedAt;
    if (
      recoveryIntentContinuationMarker !== null
      && !belongsToCurrentParent
    ) {
      // A stale expiry notice must never retire a newer exact return. Keep the
      // current parent authoritative and discard only the mismatched quiet key.
      recoveryIntentDeferredCheckStore.clear();
      bootRecoveryIntentDeferredCheck = null;
      bootDeferredCheckExpired = false;
    } else {
      recoveryIntentContinuationStore.retire();
      recoveryIntentContinuationMarker = null;
    }
  }
  if (bootProfileId === null) recoveryIntentDeferredCheckStore.clear();
  if (
    recoveryIntentContinuationMarker !== null
    && (
      recoveryReturnArrival !== undefined
      || resolveRoute(recoveryIntentContinuationMarker.landingHash)
        !== parseRouteFromHash(recoveryIntentContinuationMarker.landingHash)
    )
  ) {
    // A fresh recovery arrival supersedes an older paused landing. Likewise, a
    // feature-gated route that no longer mounts cannot retain a dead action.
    recoveryIntentContinuationStore.retire();
    recoveryIntentDeferredCheckStore.clear();
    recoveryIntentContinuationMarker = null;
    bootRecoveryIntentDeferredCheck = null;
  }
  let bootRecoveryIntentReviewVerification:
    RecoveryIntentReviewVerification | null =
      recoveryIntentContinuationMarker === null
        ? null
        : recoveryIntentContinuationStore.readReviewVerification(
            recoveryIntentContinuationMarker,
          );
  if (
    recoveryIntentContinuationMarker !== null
    && bootRecoveryIntentReviewVerification?.state === 'checking'
  ) {
    // A verifier still marked in flight can only reach a fresh bootstrap via
    // reload/crash. Count that interruption once, then persist the bounded
    // posture before any route read or reconnect observation can race it.
    bootRecoveryIntentReviewVerification =
      recoveryIntentContinuationStore.interruptReviewVerification(
        recoveryIntentContinuationMarker,
        bootRecoveryIntentReviewVerification.reviewTarget,
        'reload',
      );
  }
  if (
    bootRecoveryIntentDeferredCheck !== null
    && !bootDeferredCheckExpired
    && (
      recoveryIntentContinuationMarker === null
      || bootRecoveryIntentReviewVerification?.state !== 'ready'
      || bootRecoveryIntentReviewVerification.reviewTarget !== 'server'
      || bootRecoveryIntentDeferredCheck.profileId
        !== recoveryIntentContinuationMarker.profileId
      || bootRecoveryIntentDeferredCheck.landingHash
        !== recoveryIntentContinuationMarker.landingHash
      || bootRecoveryIntentDeferredCheck.pausedAt
        !== recoveryIntentContinuationMarker.pausedAt
    )
  ) {
    recoveryIntentDeferredCheckStore.clear();
    bootRecoveryIntentDeferredCheck = null;
  }
  const reviewVerificationPhase = (
    verification: RecoveryIntentReviewVerification,
  ): AttentionRecoveryIntentContinuation['phase'] =>
    verification.state === 'ready'
      ? 'verification_ready'
      : verification.interruptionCount >= 2
        ? 'verification_handoff'
        : 'verification_interrupted';
  let recoveryIntentContinuationPhase:
    AttentionRecoveryIntentContinuation['phase'] =
      bootRecoveryIntentReviewVerification === null
        ? 'ready'
        : reviewVerificationPhase(bootRecoveryIntentReviewVerification);
  let recoveryIntentContinuationRemediation:
    AttentionRecoveryIntentRemediation | null =
      bootRecoveryIntentReviewVerification === null ? null : 'escalated';
  let recoveryIntentContinuationReviewTarget:
    AttentionRecoveryIntentReviewTarget | null =
      bootRecoveryIntentReviewVerification?.reviewTarget ?? null;
  let recoveryIntentReviewVerificationTarget:
    AttentionRecoveryIntentReviewTarget | null =
      bootRecoveryIntentReviewVerification?.reviewTarget ?? null;
  let recoveryIntentContinuationInterruptionReason:
    AttentionRecoveryIntentInterruption | null =
      bootRecoveryIntentReviewVerification?.lastInterruption ?? null;
  let recoveryIntentDeferredCheck: RecoveryIntentDeferredCheck | null =
    bootDeferredCheckExpired ? null : bootRecoveryIntentDeferredCheck;
  let recoveryIntentExpiredDeferredCheck: RecoveryIntentDeferredCheck | null =
    bootDeferredCheckExpired ? bootRecoveryIntentDeferredCheck : null;
  let recoveryIntentExpiryHandoff:
    AttentionRecoveryIntentExpiryHandoff | null =
      bootDeferredCheckExpired && bootRecoveryIntentDeferredCheck !== null
        ? {
            serverProfileId: bootRecoveryIntentDeferredCheck.profileId,
            serverProfileLabel: bootProfileLabel,
            landingHash: bootRecoveryIntentDeferredCheck.landingHash,
            areaLabel: serverSwitchLandingAreaLabel(
              bootRecoveryIntentDeferredCheck.landingHash,
            ),
            deferredAt: bootRecoveryIntentDeferredCheck.deferredAt,
            expiredAt: bootRecoveryIntentDeferredCheck.expiresAt,
            phase: bootRecoveryIntentDeferredCheck.diagnosisOutcome
              === 'choose'
              ? 'outcome'
              : bootRecoveryIntentDeferredCheck.diagnosisOutcome
                  === 'recheck_started'
                ? 'rechecking'
                : bootRecoveryIntentDeferredCheck.diagnosisOutcome
                    === 'area_unconfirmed'
                  || bootRecoveryIntentDeferredCheck.diagnosisOutcome
                    === 'server_unavailable'
                  ? 'closure'
                  : bootRecoveryIntentDeferredCheck.diagnosisTarget !== null
                    ? 'handoff'
                    : bootRecoveryIntentDeferredCheck.attemptCount === 0
                      ? 'ready'
                      : 'retry',
            ...(bootRecoveryIntentDeferredCheck.diagnosisOutcome
                === 'area_unconfirmed'
              || bootRecoveryIntentDeferredCheck.diagnosisOutcome
                === 'server_unavailable'
              ? {
                  closureTarget:
                    bootRecoveryIntentDeferredCheck.diagnosisOutcome
                      === 'server_unavailable'
                      ? 'server' as const
                      : 'area' as const,
                }
              : bootRecoveryIntentDeferredCheck.diagnosisTarget !== null
                  && bootRecoveryIntentDeferredCheck.diagnosisOutcome === null
              ? {
                  diagnosisTarget:
                    bootRecoveryIntentDeferredCheck.diagnosisTarget,
                }
              : bootRecoveryIntentDeferredCheck.diagnosisOutcome !== null
                  || bootRecoveryIntentDeferredCheck.attemptCount === 0
                ? {}
                : { retryReason: 'interrupted' as const }),
            ...(bootRecoveryIntentDeferredCheck.diagnosisOutcome === 'choose'
                && connectionStatus.status() !== 'connected'
              ? { checkBlocker: 'server' as const }
              : {}),
          }
        : null;
  // Receipt outcomes are deliberately memory-only. Durable recovery markers
  // restore the saved route and bounded verification posture, never a server
  // action result from a previous page lifetime.
  let recoveryIntentServerControlOutcome:
    ServerControlActionOutcome | null = null;
  let recoveryIntentServerCurrentState:
    ServerControlCurrentStateObservation | null = null;
  const recoveryIntentContinuationPresentation = (
    marker: RecoveryIntentContinuation,
    phase = recoveryIntentContinuationPhase,
    remediation = recoveryIntentContinuationRemediation,
    reviewTarget = recoveryIntentContinuationReviewTarget,
    interruptionReason = recoveryIntentContinuationInterruptionReason,
    serverControlOutcome = recoveryIntentServerControlOutcome,
    serverCurrentState = recoveryIntentServerCurrentState,
  ): AttentionRecoveryIntentContinuation => ({
    serverProfileId: marker.profileId,
    serverProfileLabel: bootProfileLabel,
    landingHash: marker.landingHash,
    areaLabel: serverSwitchLandingAreaLabel(marker.landingHash),
    intent: marker.intent,
    phase,
    remediation,
    ...(reviewTarget === null ? {} : { reviewTarget }),
    ...(interruptionReason === null ? {} : { interruptionReason }),
    ...(phase === 'awaiting_review_outcome'
        && reviewTarget === 'server'
        && serverControlOutcome !== null
      ? { serverControlOutcome }
      : {}),
    ...(phase === 'awaiting_review_outcome'
        && reviewTarget === 'server'
        && serverControlOutcome !== null
        && serverCurrentState !== null
      ? { serverCurrentState }
      : {}),
    ...(phase === 'verification_ready'
        && recoveryIntentDeferredCheck !== null
        && recoveryIntentDeferredCheck.profileId === marker.profileId
        && recoveryIntentDeferredCheck.landingHash === marker.landingHash
        && recoveryIntentDeferredCheck.pausedAt === marker.pausedAt
      ? {
          deferredAt: recoveryIntentDeferredCheck.deferredAt,
          expiresAt: recoveryIntentDeferredCheck.expiresAt,
        }
      : {}),
  });
  let recoveryIntentContinuation = recoveryIntentContinuationMarker === null
    ? null
    : recoveryIntentContinuationPresentation(
        recoveryIntentContinuationMarker,
      );
  let recoveryIntentLandingHash = recoveryReturnArrival?.landingHash
    ?? recoveryIntentContinuationMarker?.landingHash
    ?? null;
  let recoveryIntentContinuationExpiryTimer:
    | ReturnType<typeof globalThis.setTimeout>
    | null = null;
  let recoveryIntentExpiryHandoffTimer:
    | ReturnType<typeof globalThis.setTimeout>
    | null = null;
  let recoveryIntentContinuationRunGeneration = 0;
  let recoveryIntentContinuationRunInFlight = false;
  let recoveryIntentExpiryReviewGeneration = 0;
  let recoveryIntentExpiryReviewInFlight = false;
  let recoveryIntentOrientation:
    ReturnType<typeof mountRecoveryIntentOrientation> | null = null;
  let recoveryIntentRetryOnReconnect = false;
  let recoveryIntentConnectionDiagnosisSequence = 0;
  const serverControlActionOutcomesMatch = (
    left: ServerControlActionOutcome | null | undefined,
    right: ServerControlActionOutcome | null | undefined,
  ): boolean => left?.action === right?.action
    && left?.phase === right?.phase
    && left?.currentState === right?.currentState;
  interface PendingRecoveryIntentConnectionDiagnosisBase {
    readonly id: string;
    readonly profileId: string;
    readonly landingHash: string;
    readonly intent: RecoveryIntentContinuation['intent'];
    readonly pausedAt: number;
  }
  type PendingRecoveryIntentConnectionDiagnosis =
    | (PendingRecoveryIntentConnectionDiagnosisBase & {
        readonly source: 'bounded_handoff';
        readonly reviewTarget: AttentionRecoveryIntentReviewTarget;
        readonly interruptionReason: AttentionRecoveryIntentInterruption;
      })
    | (PendingRecoveryIntentConnectionDiagnosisBase & {
        readonly source: 'unresolved_receipt';
        readonly priorServerOutcome: ServerControlActionOutcome;
      })
    | {
        readonly source: 'expired_area_review';
        readonly id: string;
        readonly profileId: string;
        readonly landingHash: string;
        readonly deferredAt: number;
        readonly expiredAt: number;
      };
  let pendingRecoveryIntentConnectionDiagnosis:
    PendingRecoveryIntentConnectionDiagnosis | null = null;
  const clearRecoveryIntentConnectionDiagnosis = (): void => {
    pendingRecoveryIntentConnectionDiagnosis = null;
    serverPill?.closeControls();
    accountMenu?.clearConnectionDiagnosis();
  };
  const recoveryIntentFailureLimit = 2;
  let recoveryIntentFailureCount =
    bootRecoveryIntentReviewVerification === null
      || bootRecoveryIntentReviewVerification.state === 'ready'
      ? 0
      : recoveryIntentFailureLimit;
  let recoveryIntentOwnershipListenersActive = false;
  const recoveryIntentOwnershipEvents = [
    'pointerdown',
    'click',
    'keydown',
    'input',
  ] as const;
  function onRecoveryIntentRouteOwnership(event: Event): void {
    const marker = recoveryIntentContinuationMarker;
    const eventTarget = event.target as Node | null;
    if (
      marker === null
      || eventTarget === null
      || !appShell.contentRoot.contains(eventTarget)
      || recoveryIntentContinuationPhase === 'awaiting_review_outcome'
      || recoveryIntentContinuationPhase === 'verification_ready'
      || recoveryIntentContinuationPhase === 'verification_interrupted'
      || recoveryIntentContinuationPhase === 'verification_handoff'
    ) return;
    if (
      recoveryIntentContinuationPhase === 'checking'
      && recoveryIntentReviewVerificationTarget !== null
    ) {
      interruptRecoveryIntentReviewVerification('ownership');
      return;
    }
    const currentHash = hashSource?.getHash() ?? activeHash;
    if (safeServerSwitchLandingHash(currentHash) !== marker.landingHash) return;
    recoveryIntentLandingHash = null;
    retireRecoveryIntentContinuation();
  }
  const attachRecoveryIntentOwnershipListeners = (): void => {
    if (recoveryIntentOwnershipListenersActive) return;
    recoveryIntentOwnershipListenersActive = true;
    for (const type of recoveryIntentOwnershipEvents) {
      doc.addEventListener(type, onRecoveryIntentRouteOwnership, true);
    }
  };
  const detachRecoveryIntentOwnershipListeners = (): void => {
    if (!recoveryIntentOwnershipListenersActive) return;
    recoveryIntentOwnershipListenersActive = false;
    for (const type of recoveryIntentOwnershipEvents) {
      doc.removeEventListener(type, onRecoveryIntentRouteOwnership, true);
    }
  };
  const cancelRecoveryIntentContinuationExpiry = (): void => {
    if (recoveryIntentContinuationExpiryTimer === null) return;
    globalThis.clearTimeout(recoveryIntentContinuationExpiryTimer);
    recoveryIntentContinuationExpiryTimer = null;
  };
  const cancelRecoveryIntentExpiryHandoff = (): void => {
    if (recoveryIntentExpiryHandoffTimer === null) return;
    globalThis.clearTimeout(recoveryIntentExpiryHandoffTimer);
    recoveryIntentExpiryHandoffTimer = null;
  };
  const clearRecoveryIntentExpiryHandoff = (): void => {
    recoveryIntentExpiryReviewGeneration += 1;
    recoveryIntentExpiryReviewInFlight = false;
    cancelRecoveryIntentExpiryHandoff();
    recoveryIntentDeferredCheckStore.clear();
    recoveryIntentDeferredCheck = null;
    recoveryIntentExpiredDeferredCheck = null;
    recoveryIntentExpiryHandoff = null;
    if (pendingRecoveryIntentConnectionDiagnosis?.source
      === 'expired_area_review') {
      pendingRecoveryIntentConnectionDiagnosis = null;
      serverPill?.closeControls();
      accountMenu?.clearConnectionDiagnosis();
    }
    approvalAttentionPopover?.setRecoveryIntentExpiryHandoff(null);
  };
  const setRecoveryIntentExpiryHandoffState = (
    phase: AttentionRecoveryIntentExpiryHandoff['phase'],
    retryReason?: NonNullable<
      AttentionRecoveryIntentExpiryHandoff['retryReason']
    >,
    diagnosisTarget?: NonNullable<
      AttentionRecoveryIntentExpiryHandoff['diagnosisTarget']
    >,
    closureTarget?: NonNullable<
      AttentionRecoveryIntentExpiryHandoff['closureTarget']
    >,
    checkBlocker?: NonNullable<
      AttentionRecoveryIntentExpiryHandoff['checkBlocker']
    >,
  ): void => {
    const current = recoveryIntentExpiryHandoff;
    if (current === null) return;
    const {
      retryReason: _priorRetryReason,
      diagnosisTarget: _priorDiagnosisTarget,
      closureTarget: _priorClosureTarget,
      checkBlocker: _priorCheckBlocker,
      ...base
    } = current;
    void _priorRetryReason;
    void _priorDiagnosisTarget;
    void _priorClosureTarget;
    void _priorCheckBlocker;
    recoveryIntentExpiryHandoff = {
      ...base,
      phase,
      ...(phase === 'retry' && retryReason !== undefined
        ? { retryReason }
        : {}),
      ...(phase === 'handoff' && diagnosisTarget !== undefined
        ? { diagnosisTarget }
        : {}),
      ...(phase === 'closure' && closureTarget !== undefined
        ? { closureTarget }
        : {}),
      ...(phase === 'outcome' && checkBlocker !== undefined
        ? { checkBlocker }
        : {}),
    };
    approvalAttentionPopover?.setRecoveryIntentExpiryHandoff(
      recoveryIntentExpiryHandoff,
    );
  };
  const recordRecoveryIntentExpiryReviewFailure = (
    diagnosisTarget: 'area' | 'server',
    retryReason: NonNullable<
      AttentionRecoveryIntentExpiryHandoff['retryReason']
    >,
  ): void => {
    const deferred = recoveryIntentExpiredDeferredCheck;
    if (deferred === null) {
      clearRecoveryIntentExpiryHandoff();
      return;
    }
    const failed = recoveryIntentDeferredCheckStore.recordReviewFailure(
      deferred,
      diagnosisTarget,
    );
    if (failed === null) {
      clearRecoveryIntentExpiryHandoff();
      return;
    }
    recoveryIntentExpiredDeferredCheck = failed;
    if (failed.diagnosisTarget !== null) {
      setRecoveryIntentExpiryHandoffState(
        'handoff',
        undefined,
        failed.diagnosisTarget,
      );
      return;
    }
    setRecoveryIntentExpiryHandoffState('retry', retryReason);
  };
  const recordRecoveryIntentDiagnosisRecheckFailure = (
    target: 'area' | 'server',
  ): void => {
    const deferred = recoveryIntentExpiredDeferredCheck;
    if (deferred === null) {
      clearRecoveryIntentExpiryHandoff();
      return;
    }
    const failed =
      recoveryIntentDeferredCheckStore.recordDiagnosisRecheckFailure(
        deferred,
        target,
      );
    if (failed === null) {
      clearRecoveryIntentExpiryHandoff();
      return;
    }
    recoveryIntentExpiredDeferredCheck = failed;
    setRecoveryIntentExpiryHandoffState(
      'closure',
      undefined,
      undefined,
      target,
    );
  };
  const interruptRecoveryIntentExpiryReviewForNavigation = (
    destinationHash: string,
  ): void => {
    if (
      !recoveryIntentExpiryReviewInFlight
      || (
        recoveryIntentExpiryHandoff?.phase !== 'checking'
        && recoveryIntentExpiryHandoff?.phase !== 'rechecking'
      )
      || pendingRecoveryReturnAction?.landingHash === destinationHash
    ) return;
    recoveryIntentExpiryReviewGeneration += 1;
    recoveryIntentExpiryReviewInFlight = false;
    if (recoveryIntentExpiryHandoff?.phase === 'rechecking') {
      recordRecoveryIntentDiagnosisRecheckFailure('area');
    } else {
      recordRecoveryIntentExpiryReviewFailure('area', 'interrupted');
    }
  };
  const scheduleRecoveryIntentExpiryHandoff = (): void => {
    cancelRecoveryIntentExpiryHandoff();
    const deferred = recoveryIntentExpiredDeferredCheck;
    if (deferred === null || recoveryIntentExpiryHandoff === null) return;
    const delay = Math.max(
      0,
      deferred.handoffExpiresAt - recoveryIntentNow(),
    );
    recoveryIntentExpiryHandoffTimer = globalThis.setTimeout(() => {
      recoveryIntentExpiryHandoffTimer = null;
      if (
        recoveryIntentExpiredDeferredCheck?.deferredAt
          !== deferred.deferredAt
        || recoveryIntentExpiryHandoff?.expiredAt !== deferred.expiresAt
      ) return;
      recoveryIntentDeferredCheckStore.clear();
      recoveryIntentExpiryReviewGeneration += 1;
      recoveryIntentExpiryReviewInFlight = false;
      recoveryIntentExpiredDeferredCheck = null;
      recoveryIntentExpiryHandoff = null;
      approvalAttentionPopover?.setRecoveryIntentExpiryHandoff(null);
    }, delay);
  };
  const scheduleRecoveryIntentContinuationExpiry = (): void => {
    cancelRecoveryIntentContinuationExpiry();
    const marker = recoveryIntentContinuationMarker;
    if (marker === null) return;
    const currentTime = recoveryIntentNow();
    const delay = Math.max(0, marker.expiresAt - currentTime);
    recoveryIntentContinuationExpiryTimer = globalThis.setTimeout(() => {
      recoveryIntentContinuationExpiryTimer = null;
      if (recoveryIntentContinuationMarker?.pausedAt !== marker.pausedAt) return;
      recoveryIntentContinuationRunGeneration += 1;
      recoveryIntentContinuationRunInFlight = false;
      recoveryIntentLandingHash = null;
      clearRecoveryIntentConnectionDiagnosis();
      detachRecoveryIntentOwnershipListeners();
      const deferred = recoveryIntentDeferredCheck !== null
        && recoveryIntentDeferredCheck.profileId === marker.profileId
        && recoveryIntentDeferredCheck.landingHash === marker.landingHash
        && recoveryIntentDeferredCheck.pausedAt === marker.pausedAt
        ? recoveryIntentDeferredCheck
        : null;
      recoveryIntentContinuationStore.retire();
      recoveryIntentContinuationMarker = null;
      recoveryIntentContinuation = null;
      recoveryIntentContinuationPhase = 'ready';
      recoveryIntentContinuationRemediation = null;
      recoveryIntentContinuationReviewTarget = null;
      recoveryIntentReviewVerificationTarget = null;
      recoveryIntentContinuationInterruptionReason = null;
      recoveryIntentDeferredCheck = null;
      recoveryIntentServerControlOutcome = null;
      recoveryIntentServerCurrentState = null;
      recoveryIntentRetryOnReconnect = false;
      recoveryIntentFailureCount = 0;
      if (
        deferred === null
        || recoveryIntentNow() >= deferred.handoffExpiresAt
      ) {
        recoveryIntentDeferredCheckStore.clear();
        recoveryIntentExpiredDeferredCheck = null;
        recoveryIntentExpiryHandoff = null;
        approvalAttentionPopover?.setRecoveryIntentContinuation(null);
        return;
      }
      recoveryIntentExpiredDeferredCheck = deferred;
      recoveryIntentExpiryHandoff = {
        serverProfileId: deferred.profileId,
        serverProfileLabel: bootProfileLabel,
        landingHash: deferred.landingHash,
        areaLabel: serverSwitchLandingAreaLabel(deferred.landingHash),
        deferredAt: deferred.deferredAt,
        expiredAt: deferred.expiresAt,
        phase: deferred.diagnosisOutcome === 'choose'
          ? 'outcome'
          : deferred.diagnosisOutcome === 'recheck_started'
            ? 'rechecking'
            : deferred.diagnosisOutcome === 'area_unconfirmed'
              || deferred.diagnosisOutcome === 'server_unavailable'
              ? 'closure'
              : deferred.diagnosisTarget !== null
                ? 'handoff'
                : deferred.attemptCount === 0
                  ? 'ready'
                  : 'retry',
        ...(deferred.diagnosisOutcome === 'area_unconfirmed'
            || deferred.diagnosisOutcome === 'server_unavailable'
          ? {
              closureTarget: deferred.diagnosisOutcome
                === 'server_unavailable'
                ? 'server' as const
                : 'area' as const,
            }
          : deferred.diagnosisTarget !== null
              && deferred.diagnosisOutcome === null
          ? { diagnosisTarget: deferred.diagnosisTarget }
          : deferred.diagnosisOutcome !== null
              || deferred.attemptCount === 0
            ? {}
            : { retryReason: 'interrupted' as const }),
        ...(deferred.diagnosisOutcome === 'choose'
            && connectionStatus.status() !== 'connected'
          ? { checkBlocker: 'server' as const }
          : {}),
      };
      approvalAttentionPopover?.setRecoveryIntentExpiryHandoff(
        recoveryIntentExpiryHandoff,
      );
      scheduleRecoveryIntentExpiryHandoff();
    }, delay);
  };
  const setRecoveryIntentContinuationState = (
    phase: AttentionRecoveryIntentContinuation['phase'],
    remediation: AttentionRecoveryIntentRemediation | null = null,
    reviewTarget: AttentionRecoveryIntentReviewTarget | null = null,
    interruptionReason: AttentionRecoveryIntentInterruption | null = null,
    serverControlOutcome: ServerControlActionOutcome | null = null,
    serverCurrentState: ServerControlCurrentStateObservation | null = null,
  ): void => {
    const marker = recoveryIntentContinuationMarker;
    if (
      phase !== 'verification_ready'
      && recoveryIntentDeferredCheck !== null
    ) {
      recoveryIntentDeferredCheckStore.clear();
      recoveryIntentDeferredCheck = null;
    }
    const nextServerControlOutcome =
      phase === 'awaiting_review_outcome' && reviewTarget === 'server'
        ? serverControlOutcome
        : null;
    const nextServerCurrentState = nextServerControlOutcome !== null
      && phase === 'awaiting_review_outcome'
      && reviewTarget === 'server'
        ? serverCurrentState
        : null;
    if (
      marker === null
      || (
        recoveryIntentContinuationPhase === phase
        && recoveryIntentContinuationRemediation === remediation
        && recoveryIntentContinuationReviewTarget === reviewTarget
        && recoveryIntentContinuationInterruptionReason === interruptionReason
        && recoveryIntentServerControlOutcome?.action
          === nextServerControlOutcome?.action
        && recoveryIntentServerControlOutcome?.phase
          === nextServerControlOutcome?.phase
        && recoveryIntentServerControlOutcome?.currentState
          === nextServerControlOutcome?.currentState
        && recoveryIntentServerCurrentState?.state
          === nextServerCurrentState?.state
      )
    ) return;
    recoveryIntentContinuationPhase = phase;
    recoveryIntentContinuationRemediation = remediation;
    recoveryIntentContinuationReviewTarget = reviewTarget;
    recoveryIntentContinuationInterruptionReason = interruptionReason;
    recoveryIntentServerControlOutcome = nextServerControlOutcome;
    recoveryIntentServerCurrentState = nextServerCurrentState;
    recoveryIntentContinuation = recoveryIntentContinuationPresentation(
      marker,
      phase,
      remediation,
      reviewTarget,
      interruptionReason,
      nextServerControlOutcome,
      nextServerCurrentState,
    );
    approvalAttentionPopover?.setRecoveryIntentContinuation(
      recoveryIntentContinuation,
    );
  };
  const setRecoveryIntentContinuation = (
    marker: RecoveryIntentContinuation,
  ): void => {
    const current = recoveryIntentContinuationMarker;
    const changed = current === null
      || current.profileId !== marker.profileId
      || current.landingHash !== marker.landingHash
      || current.intent !== marker.intent
      || current.pausedAt !== marker.pausedAt;
    // The orientation timer can surface the same durable marker again. It is
    // not a new recovery attempt and must not erase an in-tab failure cap.
    if (!changed) return;
    clearRecoveryIntentConnectionDiagnosis();
    clearRecoveryIntentExpiryHandoff();
    recoveryIntentContinuationRunGeneration += 1;
    recoveryIntentContinuationRunInFlight = false;
    recoveryIntentContinuationPhase = 'ready';
    recoveryIntentContinuationRemediation = null;
    recoveryIntentContinuationReviewTarget = null;
    recoveryIntentReviewVerificationTarget = null;
    recoveryIntentContinuationInterruptionReason = null;
    recoveryIntentServerControlOutcome = null;
    recoveryIntentServerCurrentState = null;
    recoveryIntentRetryOnReconnect = false;
    recoveryIntentFailureCount = 0;
    recoveryIntentContinuationMarker = marker;
    recoveryIntentContinuation = recoveryIntentContinuationPresentation(
      marker,
      'ready',
      null,
    );
    approvalAttentionPopover?.setRecoveryIntentContinuation(
      recoveryIntentContinuation,
    );
    attachRecoveryIntentOwnershipListeners();
    scheduleRecoveryIntentContinuationExpiry();
  };
  const retireRecoveryIntentContinuation = (
    completedRouteLanding = false,
  ): void => {
    clearRecoveryIntentConnectionDiagnosis();
    recoveryIntentContinuationRunGeneration += 1;
    recoveryIntentContinuationRunInFlight = false;
    cancelRecoveryIntentContinuationExpiry();
    detachRecoveryIntentOwnershipListeners();
    recoveryIntentContinuationStore.retire();
    clearRecoveryIntentExpiryHandoff();
    recoveryIntentContinuationMarker = null;
    recoveryIntentContinuation = null;
    recoveryIntentContinuationPhase = 'ready';
    recoveryIntentContinuationRemediation = null;
    recoveryIntentContinuationReviewTarget = null;
    recoveryIntentReviewVerificationTarget = null;
    recoveryIntentContinuationInterruptionReason = null;
    recoveryIntentServerControlOutcome = null;
    recoveryIntentServerCurrentState = null;
    recoveryIntentRetryOnReconnect = false;
    recoveryIntentFailureCount = 0;
    if (completedRouteLanding) {
      approvalAttentionPopover?.completeRecoveryIntentContinuation();
    } else {
      approvalAttentionPopover?.setRecoveryIntentContinuation(null);
    }
  };
  const clearRecoveryIntentReviewVerification = (): void => {
    recoveryIntentReviewVerificationTarget = null;
    recoveryIntentContinuationInterruptionReason = null;
    recoveryIntentContinuationStore.clearReviewVerification();
    recoveryIntentDeferredCheckStore.clear();
    recoveryIntentDeferredCheck = null;
  };
  function interruptRecoveryIntentReviewVerification(
    reason: AttentionRecoveryIntentInterruption,
  ): boolean {
    const marker = recoveryIntentContinuationMarker;
    const reviewTarget = recoveryIntentReviewVerificationTarget;
    if (marker === null || reviewTarget === null) return false;
    const verification =
      recoveryIntentContinuationStore.interruptReviewVerification(
        marker,
        reviewTarget,
        reason,
      );
    if (verification === null) return false;
    recoveryIntentReviewVerificationTarget = verification.reviewTarget;
    recoveryIntentContinuationInterruptionReason =
      verification.lastInterruption;
    recoveryIntentContinuationRunGeneration += 1;
    recoveryIntentContinuationRunInFlight = false;
    pendingRecoveryReturnAction = null;
    recoveryIntentRetryOnReconnect = false;
    setRecoveryIntentContinuationState(
      reviewVerificationPhase(verification),
      'escalated',
      verification.reviewTarget,
      verification.lastInterruption,
    );
    return true;
  }
  let resumeRecoveryIntentContinuation: (
    continuation: AttentionRecoveryIntentContinuation,
    source?: 'attention' | 'connection_repaired' | 'review_resolved',
  ) => 'started' | 'missing' | 'unavailable' = () => 'unavailable';
  let reviewRecoveryIntentContinuation: (
    continuation: AttentionRecoveryIntentContinuation,
  ) => 'started' | 'missing' | 'unavailable' = () => 'unavailable';
  let remediateRecoveryIntentConnection: (
    continuation: AttentionRecoveryIntentContinuation,
  ) => 'started' | 'missing' | 'unavailable' = () => 'unavailable';
  let reviewRecoveryIntentServer: (
    continuation: AttentionRecoveryIntentContinuation,
  ) => 'started' | 'missing' | 'unavailable' = () => 'unavailable';
  let keepRecoveryIntentReviewBlocked: (
    continuation: AttentionRecoveryIntentContinuation,
  ) => 'started' | 'missing' | 'unavailable' = () => 'unavailable';
  let deferRecoveryIntentVerification: (
    continuation: AttentionRecoveryIntentContinuation,
  ) => 'started' | 'missing' | 'unavailable' = () => 'unavailable';
  let reviewRecoveryIntentExpiryHandoff: (
    handoff: AttentionRecoveryIntentExpiryHandoff,
  ) => 'started' | 'missing' | 'unavailable' = () => 'unavailable';
  const recoveryIntentExpiryRetryReasonForStatus = (): NonNullable<
    AttentionRecoveryIntentExpiryHandoff['retryReason']
  > => {
    const status = connectionStatus.status();
    if (status === 'offline') return 'offline';
    if (status === 'reconnecting') return 'interrupted';
    return 'unavailable';
  };
  const detachRecoveryIntentReviewVerificationStatus =
    connectionStatus.onStatus((status) => {
      if (
        status !== 'connected'
        && recoveryIntentExpiryReviewInFlight
        && (
          recoveryIntentExpiryHandoff?.phase === 'checking'
          || recoveryIntentExpiryHandoff?.phase === 'rechecking'
        )
      ) {
        // A connection gap makes the broad route read indeterminate. Preserve
        // one manual retry or stop at the durable two-attempt server handoff;
        // never replay either when the socket reconnects.
        recoveryIntentExpiryReviewGeneration += 1;
        recoveryIntentExpiryReviewInFlight = false;
        if (recoveryIntentExpiryHandoff.phase === 'rechecking') {
          recordRecoveryIntentDiagnosisRecheckFailure('server');
        } else {
          recordRecoveryIntentExpiryReviewFailure(
            'server',
            recoveryIntentExpiryRetryReasonForStatus(),
          );
        }
      } else if (
        status !== 'connected'
        && recoveryIntentExpiryHandoff?.phase === 'outcome'
        && recoveryIntentExpiryHandoff.checkBlocker !== 'server'
      ) {
        // A known blocker disables the one-shot choice without consuming it.
        setRecoveryIntentExpiryHandoffState(
          'outcome',
          undefined,
          undefined,
          undefined,
          'server',
        );
      } else if (
        status === 'connected'
        && recoveryIntentExpiryHandoff?.phase === 'outcome'
        && recoveryIntentExpiryHandoff.checkBlocker === 'server'
      ) {
        // Reconnect only enables the explicit choice; it never dispatches it.
        setRecoveryIntentExpiryHandoffState('outcome');
      } else if (
        status === 'offline'
        && recoveryIntentExpiryHandoff?.phase === 'retry'
        && recoveryIntentExpiryHandoff.retryReason !== 'offline'
      ) {
        // A retry can outlive the reconnect grace period. Once reachability is
        // known to be lost, replace a generic interruption with honest offline
        // guidance without starting the saved read.
        setRecoveryIntentExpiryHandoffState('retry', 'offline');
      } else if (
        status === 'connected'
        && recoveryIntentExpiryHandoff?.phase === 'retry'
        && recoveryIntentExpiryHandoff.retryReason === 'offline'
      ) {
        // Reconnect removes the blocker, not the retry obligation. The owner
        // still decides when the route performs its next authoritative read.
        setRecoveryIntentExpiryHandoffState('retry', 'interrupted');
      }
      if (
        status !== 'connected'
        && recoveryIntentContinuationPhase === 'checking'
        && recoveryIntentReviewVerificationTarget !== null
      ) {
        // A transport transition makes the pending answer indeterminate. Stop
        // owning that request immediately; reconnect only restores the manual
        // Retry verification choice and never dispatches another read.
        interruptRecoveryIntentReviewVerification('connection');
      }
    });
  const detachRecoveryIntentContinuationReconnect = reconnect(() => {
    const marker = recoveryIntentContinuationMarker;
    if (marker === null) return;
    if (
      recoveryIntentContinuationPhase === 'waiting_for_connection'
      && recoveryIntentContinuationRemediation === 'connection'
      && recoveryIntentRetryOnReconnect
    ) {
      // The owner explicitly chose connection remediation. Let every status
      // listener observe `connected` first, then close the Account detour and
      // retry the exact scrubbed route + closed-list landing intent once.
      recoveryIntentRetryOnReconnect = false;
      const pausedAt = marker.pausedAt;
      void Promise.resolve().then(() => {
        if (
          recoveryIntentContinuationMarker?.pausedAt !== pausedAt
          || recoveryIntentContinuationPhase !== 'waiting_for_connection'
          || recoveryIntentContinuationRemediation !== 'connection'
        ) return;
        if (connectionStatus.status() !== 'connected') {
          // A second drop can overtake this microtask. Keep the explicit wait
          // armed for the next stable connected observation; do not close
          // Account or dispatch a route read into another transition.
          recoveryIntentRetryOnReconnect = true;
          return;
        }
        // The owner armed an automatic exact return, so Account is normally
        // only the remediation detour. A deliberate profile mutation that
        // crossed its commit boundary keeps ownership, though: do not close
        // its progress or navigate a route retry underneath it. The durable
        // intent remains as a quiet manual recheck if that operation returns.
        if (
          accountMenu?.isOpen() === true
          && !accountMenu.close()
        ) {
          setRecoveryIntentContinuationState('ready');
          return;
        }
        const result = resumeRecoveryIntentContinuation(
          recoveryIntentContinuationPresentation(
            marker,
            'waiting_for_connection',
            'connection',
          ),
          'connection_repaired',
        );
        if (
          result === 'unavailable'
          && recoveryIntentContinuationMarker?.pausedAt === pausedAt
        ) setRecoveryIntentContinuationState('ready');
      });
      return;
    }
    if (
      recoveryIntentContinuationPhase === 'failed'
      && recoveryIntentContinuationRemediation !== 'review'
      && recoveryIntentContinuationRemediation !== 'escalated'
    ) {
      // A reconnect alone never navigates. It only makes a failed saved return
      // manually actionable again unless the owner armed the exact retry above.
      // A review-only route has no retry seam for reconnect to restore, so its
      // explicit route-review diagnosis remains truthful.
      setRecoveryIntentContinuationState('ready');
    }
  });
  if (recoveryIntentContinuationMarker !== null) {
    attachRecoveryIntentOwnershipListeners();
  }
  scheduleRecoveryIntentContinuationExpiry();
  scheduleRecoveryIntentExpiryHandoff();
  const inactiveProfileRecoveryDiscovery =
    createBrowserInactiveProfileRecoveryDiscovery({
      document: doc,
      ...(options.inactiveProfileRecoveryStorage !== undefined
        ? { storage: options.inactiveProfileRecoveryStorage }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  const inactiveProfileRecoveryReview =
    createInactiveProfileRecoveryReviewContinuity({
      document: doc,
      ...(options.inactiveProfileRecoveryReviewStorage !== undefined
        ? { storage: options.inactiveProfileRecoveryReviewStorage }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  const initialInactiveProfileRecoveryReview = bootProfileId === null
    ? null
    : inactiveProfileRecoveryReview.readForProfile(bootProfileId);
  type RecoveryExcursionState = Extract<
    InactiveProfileRecoveryReviewState,
    { readonly sourceProfileId: string }
  >;
  const asRecoveryExcursion = (
    state: InactiveProfileRecoveryReviewState | null,
  ): RecoveryExcursionState | null =>
    state !== null && 'sourceProfileId' in state ? state : null;
  let activeRecoveryExcursion = asRecoveryExcursion(
    initialInactiveProfileRecoveryReview,
  );
  let recoveryExcursionReturn: AttentionRecoveryExcursionReturn | null = null;
  let pendingRecoveryExcursionReturn: RecoveryExcursionState | null = null;
  let inactiveConnectionRecoveryHints: ReadonlyArray<
    AttentionInactiveConnectionRecoveryHint
  > = [];
  let pendingInactiveProfileRecoveryReviewId: string | null = null;
  let detachInactiveProfileRecoveryDiscovery = (): void => undefined;
  let themeToggle: ThemeToggleMount | null = null;
  let unsubscribeAccountStatus: (() => void) | null = null;
  let detachServerSwitchWork = (): void => undefined;
  let requestServerProfileRefresh = (): void => undefined;
  let refreshActivePostSafeStopProfileContext = (
    _profiles: ReadonlyArray<WebclientServerProfile>,
  ): void => undefined;
  // The inline switch review is the discard authority for this one reload.
  // Keep the ordinary native guard armed for every other reload/close.
  let intentionalServerSwitchReload = false;
  let serverSwitchConvergence: ServerSwitchConvergenceMount | null = null;
  let serverSwitchConvergenceRevision = 0;
  const pendingServerSwitchTarget = Symbol('pending-server-switch-target');
  let serverSwitchConvergenceTargetId:
    | string
    | typeof pendingServerSwitchTarget
    | null = null;
  let releaseServerSwitchPause: (() => void) | null = null;
  let detachPendingServerSwitchSignal = (): void => undefined;
  let disposed = false;
  const profileStore = options.profileStore;
  const refreshRecoveryExcursionReturn = (
    profiles: ReadonlyArray<WebclientServerProfile>,
  ): void => {
    const excursion = activeRecoveryExcursion;
    if (
      excursion === null
      || bootProfileId === null
      || excursion.targetProfileId !== bootProfileId
    ) {
      recoveryExcursionReturn = null;
      approvalAttentionPopover?.setRecoveryExcursionReturn(null);
      return;
    }
    const source = profiles.find((profile) =>
      profile.id === excursion.sourceProfileId
      && profile.server_url.length > 0);
    if (source === undefined) {
      inactiveProfileRecoveryReview.retire(excursion.targetProfileId);
      activeRecoveryExcursion = null;
      pendingRecoveryExcursionReturn = null;
      recoveryExcursionReturn = null;
      approvalAttentionPopover?.setRecoveryExcursionReturn(null);
      return;
    }
    if (excursion.phase !== 'return_ready') {
      recoveryExcursionReturn = null;
      approvalAttentionPopover?.setRecoveryExcursionReturn(null);
      return;
    }
    const label = source.label.trim();
    recoveryExcursionReturn = {
      serverProfileId: source.id,
      serverProfileLabel: label.length > 0
        ? label
        : defaultProfileLabel(source.server_url),
    };
    approvalAttentionPopover?.setRecoveryExcursionReturn(
      recoveryExcursionReturn,
    );
  };
  const refreshInactiveConnectionRecoveryHints = (
    profiles: ReadonlyArray<WebclientServerProfile>,
  ): void => {
    if (bootProfileId === null || accountMenu === null) {
      inactiveConnectionRecoveryHints = [];
      approvalAttentionPopover?.setInactiveConnectionRecoveryHints([]);
      return;
    }
    const inactiveProfiles = profiles.filter((profile) =>
      profile.id !== bootProfileId && profile.server_url.length > 0);
    const observed = inactiveProfileRecoveryDiscovery.read(
      inactiveProfiles.map((profile) => profile.id),
    );
    const profileById = new Map(
      inactiveProfiles.map((profile) => [profile.id, profile] as const),
    );
    inactiveConnectionRecoveryHints = observed.flatMap((hint) => {
      const profile = profileById.get(hint.profileId);
      if (profile === undefined) return [];
      const label = profile.label.trim();
      return [{
        serverProfileId: profile.id,
        serverProfileLabel: label.length > 0
          ? label
          : defaultProfileLabel(profile.server_url),
        observedAt: hint.observedAt,
      }];
    });
    approvalAttentionPopover?.setInactiveConnectionRecoveryHints(
      inactiveConnectionRecoveryHints,
    );
  };
  detachInactiveProfileRecoveryDiscovery =
    inactiveProfileRecoveryDiscovery.subscribe(() => {
      if (knownServerProfiles.length === 0) {
        requestServerProfileRefresh();
        return;
      }
      refreshInactiveConnectionRecoveryHints(knownServerProfiles);
    });
  const beginInactiveConnectionRecoveryReview = (
    profileId: string,
  ): 'opened' | 'missing' | 'unavailable' => {
    if (accountMenu === null || profileStore === undefined) {
      return 'unavailable';
    }
    const profile = knownServerProfiles.find((candidate) =>
      candidate.id === profileId && candidate.server_url.length > 0);
    if (profile === undefined || profileId === bootProfileId) {
      inactiveProfileRecoveryDiscovery.purge(profileId);
      refreshInactiveConnectionRecoveryHints(knownServerProfiles);
      return 'missing';
    }
    // Account's outside-click guard runs in the capture phase, before this
    // Attention action. Opening now lets us report a missing rendered target
    // synchronously while the ordinary profile click remains the deliberate
    // selection boundary.
    const openResult = accountMenu.openServerProfile(profileId);
    if (openResult === 'opened') {
      if (
        pendingInactiveProfileRecoveryReviewId !== null
        && pendingInactiveProfileRecoveryReviewId !== profileId
      ) {
        inactiveProfileRecoveryReview.retire(
          pendingInactiveProfileRecoveryReviewId,
        );
      }
      pendingInactiveProfileRecoveryReviewId = profileId;
      const excursionReturnHash = safeServerSwitchLandingHash(activeHash);
      const armed = bootProfileId === null
        ? inactiveProfileRecoveryReview.arm(profileId)
        : inactiveProfileRecoveryReview.armExcursion({
            sourceProfileId: bootProfileId,
            targetProfileId: profileId,
            returnHash: excursionReturnHash,
            returnContext: excursionReturnHash === activeHash
              ? 'area'
              : 'detail_withheld',
          });
      if (armed && activeRecoveryExcursion !== null) {
        // One tab carries one excursion. A successfully opened new recovery
        // review deliberately supersedes its older return; an unavailable or
        // missing Account target above never gets this authority.
        activeRecoveryExcursion = null;
        pendingRecoveryExcursionReturn = null;
        recoveryExcursionReturn = null;
        approvalAttentionPopover?.setRecoveryExcursionReturn(null);
      }
      return 'opened';
    }
    if (openResult === 'missing') {
      inactiveProfileRecoveryDiscovery.purge(profileId);
      refreshInactiveConnectionRecoveryHints(knownServerProfiles);
      return 'missing';
    }
    return 'unavailable';
  };
  const beginRecoveryExcursionReturn = (
    profileId: string,
  ): 'opened' | 'missing' | 'unavailable' => {
    const excursion = activeRecoveryExcursion;
    if (
      accountMenu === null
      || profileStore === undefined
      || excursion === null
      || excursion.phase !== 'return_ready'
      || excursion.sourceProfileId !== profileId
    ) return 'unavailable';
    const source = knownServerProfiles.find((profile) =>
      profile.id === profileId && profile.server_url.length > 0);
    if (source === undefined) {
      inactiveProfileRecoveryReview.retire(excursion.targetProfileId);
      activeRecoveryExcursion = null;
      pendingRecoveryExcursionReturn = null;
      recoveryExcursionReturn = null;
      approvalAttentionPopover?.setRecoveryExcursionReturn(null);
      return 'missing';
    }
    pendingRecoveryExcursionReturn = excursion;
    const openResult = accountMenu.openServerProfile(profileId);
    if (openResult === 'opened') return 'opened';
    pendingRecoveryExcursionReturn = null;
    if (openResult === 'missing') {
      inactiveProfileRecoveryReview.retire(excursion.targetProfileId);
      activeRecoveryExcursion = null;
      recoveryExcursionReturn = null;
      approvalAttentionPopover?.setRecoveryExcursionReturn(null);
      return 'missing';
    }
    return 'unavailable';
  };
  const switchLocation = options.reloadForServerSwitch === undefined
    ? (globalThis as { location?: Location }).location
    : undefined;
  const reloadForServerSwitch = options.reloadForServerSwitch
    ?? (switchLocation !== undefined ? () => switchLocation.reload() : undefined);
  const switchHistory = options.replaceHashForServerSwitch === undefined
    ? doc?.defaultView?.history
    : undefined;
  const replaceHashForServerSwitch = options.replaceHashForServerSwitch
    ?? (typeof switchHistory?.replaceState === 'function'
      ? (hash: string): void => switchHistory.replaceState(null, '', hash)
      : undefined);
  const replaceActiveHashWithoutNavigation = (hash: string): boolean => {
    if (replaceHashForServerSwitch === undefined) return false;
    try {
      replaceHashForServerSwitch(hash);
      activeHash = hash;
      return true;
    } catch {
      return false;
    }
  };
  const currentRouteWorkDetails = (): ServerSwitchWorkDetails => {
    const routeCopy: Record<WebclientRouteId, { label: string; returnLabel: string }> = {
      reception: { label: 'Updating Reception', returnLabel: 'Return to Reception' },
      settings: { label: 'Saving a Settings change', returnLabel: 'Return to Settings' },
      approvals: { label: 'Resolving an approval', returnLabel: 'Return to Approvals' },
      kitchen: { label: 'Finishing Kitchen work', returnLabel: 'Return to Kitchen' },
      contracts: { label: 'Updating Contracts', returnLabel: 'Return to Contracts' },
      connections: { label: 'Updating a connection', returnLabel: 'Return to Connections' },
      packs: { label: 'Updating a pack', returnLabel: 'Return to Packs' },
      recipes: { label: 'Finishing a Recipe action', returnLabel: 'Return to Recipes' },
      automation: { label: 'Updating automation', returnLabel: 'Return to Automation' },
      data: { label: 'Saving a Data change', returnLabel: 'Return to Data' },
      logs: { label: 'Finishing a run action', returnLabel: 'Return to Runs' },
      chat: { label: 'Finishing a Chat action', returnLabel: 'Return to Chat' },
      mail: { label: 'Finishing a mail action', returnLabel: 'Return to Mail' },
    };
    return {
      ...routeCopy[activeRoute],
      returnHref: activeHash,
    };
  };
  const switchWorkTracker = createServerSwitchWorkTracker(
    currentRouteWorkDetails,
  );
  // A foundational OAuth consent popup belongs to this authenticated boot,
  // not to the Connections route that happened to open it. Its Account work
  // item remains actionable while routes swap, then becomes a one-shot result
  // link back to the exact Mail / Calendar lane.
  const foundationalOAuthContinuity = createFoundationalOAuthContinuity({
    beginWork: (details) => switchWorkTracker.begin(details),
    storage: options.foundationalOAuthContinuityStorage,
    scopeId: bootProfileId,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const providerSetupContinuity = createProviderSetupContinuityStore({
    storage: options.providerSetupContinuityStorage,
    scopeId: bootProfileId,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const credentialRotationContinuity = createCredentialRotationContinuityStore({
    storage: options.credentialRotationContinuityStorage,
    scopeId: bootProfileId,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  const credentialRotationServerUpdateContinuity =
    createCredentialRotationServerUpdateContinuity({
      storage: options.credentialRotationServerUpdateContinuityStorage,
      scopeId: bootProfileId,
      status: connectionStatus.status,
      onStatus: connectionStatus.onStatus,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  let serverUpdateReceiptVerification:
    ServerUpdateReceiptVerificationController | null = null;
  const retireServerUpdateReturn = (
    target: CredentialRotationServerUpdateTarget,
  ): void => {
    credentialRotationServerUpdateContinuity.retire(target);
    const completion = serverUpdateReceiptVerification?.read() ?? null;
    const affected = completion?.baseline?.affectedConnection;
    if (
      completion?.phase === 'completed'
      && affected?.kind === target.kind
      && affected.name === target.name
    ) {
      serverUpdateReceiptVerification?.dismissCompletion();
    }
  };
  const accountServerUpdateGuideFor = (
    target: CredentialRotationServerUpdateTarget,
  ) => {
    const marker = credentialRotationServerUpdateContinuity.read();
    const matchingMarker = marker !== null
      && marker.kind === target.kind
      && marker.name === target.name
      ? marker
      : null;
    return {
      connectionIdentity: `${target.kind}/${target.name}`,
      updateHref: serializeShellRoute('settings', 'updates'),
      returnHref: serializeConnectionsCredentialRotationRetry(target),
      reloadSafe: credentialRotationServerUpdateContinuity.isDurable(),
      phase: matchingMarker?.phase ?? 'guide',
      ...(matchingMarker?.exactReturnActive === true
        ? { exactReturnActive: true as const }
        : {}),
      ...(matchingMarker?.serverUpdateTriage !== undefined
        ? { serverUpdateTriage: matchingMarker.serverUpdateTriage }
        : {}),
      ...(matchingMarker?.serverUpdateProgress !== undefined
        ? { serverUpdateProgress: matchingMarker.serverUpdateProgress }
        : {}),
      ...(matchingMarker?.serverUpdateVerification !== undefined
        ? {
            serverUpdateVerification:
              matchingMarker.serverUpdateVerification,
          }
        : {}),
    };
  };
  const syncAccountServerUpdateGuide = (): void => {
    const marker = credentialRotationServerUpdateContinuity.read();
    accountMenu?.setServerUpdateGuide(
      marker === null ? null : accountServerUpdateGuideFor(marker),
    );
  };
  let credentialRotationTabConvergence:
    CredentialRotationTabConvergence | null = null;
  let detachCredentialRotationServerUpdateGuide =
    credentialRotationServerUpdateContinuity.subscribe((marker) => {
      if (
        marker !== null
        && marker.serverUpdateProgress === undefined
      ) {
        const progress =
          credentialRotationTabConvergence?.readServerUpdateProgress()
          ?? null;
        if (progress !== null) {
          // A guide can begin after the server-global update already started.
          // Project the current tab latch immediately instead of waiting for a
          // second channel message that may never arrive.
          credentialRotationServerUpdateContinuity
            .observeServerUpdateProgress(progress);
        }
      }
      syncAccountServerUpdateGuide();
    });
  credentialRotationTabConvergence =
    createBrowserCredentialRotationTabConvergence({
      document: doc,
      scopeId: bootProfileId,
      ...(options.credentialRotationTabStorage !== undefined
        ? { storage: options.credentialRotationTabStorage }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
  const initialServerUpdateProgress =
    credentialRotationTabConvergence?.readServerUpdateProgress() ?? null;
  credentialRotationServerUpdateContinuity.observeServerUpdateProgress(
    initialServerUpdateProgress,
  );
  type ServerUpdateReconnectLineage = Pick<
    ServerUpdateTabProgress,
    'operation' | 'startedAt' | 'operationId'
  >;
  const sameServerUpdateLineage = (
    progress: ServerUpdateTabProgress,
    lineage: ServerUpdateReconnectLineage | null,
  ): boolean => lineage !== null
    && progress.operation === lineage.operation
    && progress.startedAt === lineage.startedAt
    && progress.operationId === lineage.operationId;
  const serverUpdateLineageOf = (
    progress: ServerUpdateTabProgress,
  ): ServerUpdateReconnectLineage => ({
    operation: progress.operation,
    startedAt: progress.startedAt,
    ...(progress.operationId !== undefined
      ? { operationId: progress.operationId }
      : {}),
  });
  // A reconnect is proof only when this live tab already observed the accepted
  // restart for this exact action lineage. A cold/reloaded tab's ordinary
  // initial connect is not a restart boundary: when an opaque receipt is
  // available it must ask the selected server to resolve that exact receipt.
  // Keep the legacy fallback only for pre-receipt durable markers. An older
  // disconnect must never settle a later update or rollback, and an
  // "applying" disconnect is not strong enough to claim that the server had
  // accepted a restart yet.
  let serverUpdateReconnectProof =
    initialServerUpdateProgress?.phase === 'awaiting_reconnect'
      && initialServerUpdateProgress.operationId === undefined
      && connectionStatus.status() !== 'connected'
      ? serverUpdateLineageOf(initialServerUpdateProgress)
      : null;
  let detachCredentialRotationCapabilityResolution: () => void =
    () => undefined;
  let detachCredentialRotationCapabilityLineage: () => void =
    () => undefined;
  let detachCredentialRotationCapabilityReconnect: () => void =
    () => undefined;
  let detachServerUpdateReceiptVerification: () => void =
    () => undefined;
  type UntypedRpcCall = (method: string, payload?: unknown) => Promise<unknown>;
  const rawUntypedRpcCall = rpcConn.call as unknown as UntypedRpcCall;
  /** Lift only owner-started writes/actions into the boot-scoped tracker. Reads
   * stay quiet, while a route may still use its fully typed Conn facade. */
  const trackSelectedRpcMethods = <T>(methods: ReadonlySet<string>): T => (
    (method: string, payload?: unknown): Promise<unknown> => {
      const invoke = (): Promise<unknown> => payload === undefined
        ? rawUntypedRpcCall(method)
        : rawUntypedRpcCall(method, payload);
      return methods.has(method)
        ? switchWorkTracker.track(invoke)()
        : invoke();
    }
  ) as T;
  interface ServerSwitchWorkSnapshot {
    readonly workState: ServerSwitchWorkState;
    readonly chatDraft: ChatRouteRecoveryDraft | null;
    readonly activeWork: ReadonlyArray<ServerSwitchActiveWork>;
  }
  const currentServerSwitchWorkSnapshot = (): ServerSwitchWorkSnapshot => {
    // Boot-owned leases are authoritative even if a route-local probe is
    // broken. Capture them outside the route try/catch so the fail-closed path
    // retains their names, exact return routes, and one-use action ids.
    const trackedWork = switchWorkTracker.activeWork();
    try {
      const chatDraft = mountedRouteHandle.getRecoveryDraft?.() ?? null;
      const hasChatDraft = chatDraft !== null
        && chatDraft.text.trim().length > 0;
      const hasUnsavedChanges =
        drawerCreateOverlay?.hasUnsavedChanges() === true
        || mountedRouteHandle.hasUnsavedChanges?.() === true;
      const routeHasInFlightWork = (
        mountedRouteHandle.hasRouteInFlightWork
        ?? mountedRouteHandle.hasInFlightWork
      )?.() === true;
      const hasInFlightWork = switchWorkTracker.hasInFlightWork()
        || routeHasInFlightWork;
      // Native route state covers multi-step UI work that does not travel
      // through a wrapped caller (Chat streaming, local cleanup). Give it a
      // useful source-route identity when there is no more specific lease.
      const trackedCurrentRoute = trackedWork.some(
        (work) => work.returnHref === activeHash,
      );
      const activeWork = [
        ...trackedWork,
        ...(routeHasInFlightWork && !trackedCurrentRoute ? [{
            id: `route:${activeRoute}:${activeHash}`,
            ...currentRouteWorkDetails(),
          }] : []),
      ];
      if (hasInFlightWork) {
        if (hasChatDraft) {
          return {
            workState: 'in_flight_with_chat_draft',
            chatDraft,
            activeWork,
          };
        }
        if (hasUnsavedChanges) {
          return {
            workState: 'in_flight_with_unsaved_changes',
            chatDraft: null,
            activeWork,
          };
        }
        return { workState: 'in_flight', chatDraft: null, activeWork };
      }
      if (hasChatDraft) {
        return { workState: 'chat_draft', chatDraft, activeWork: [] };
      }
      return {
        workState: hasUnsavedChanges ? 'unsaved_changes' : 'clean',
        chatDraft: null,
        activeWork: [],
      };
    } catch {
      // A broken route probe is never evidence that leaving is safe.
      return trackedWork.length > 0
        ? {
            workState: 'in_flight_with_unsaved_changes',
            chatDraft: null,
            activeWork: trackedWork,
          }
        : { workState: 'unsaved_changes', chatDraft: null, activeWork: [] };
    }
  };
  const currentServerSwitchWorkState = (): ServerSwitchWorkState =>
    currentServerSwitchWorkSnapshot().workState;
  const currentServerSwitchActiveWork = (): ReadonlyArray<ServerSwitchActiveWork> =>
    currentServerSwitchWorkSnapshot().activeWork;

  // Chat's send rpc acknowledges acceptance before the model turn finishes.
  // Keep one boot-scoped lease through the terminal broadcast so navigating
  // away from Chat does not turn a still-running answer into invisible work.
  const chatTurnLeases = new Set<ServerSwitchWorkLease>();
  const chatTurnLeaseById = new Map<string, ServerSwitchWorkLease>();
  const settledChatTurnIds = new Set<string>();
  const releaseChatTurnLease = (lease: ServerSwitchWorkLease): void => {
    lease();
    chatTurnLeases.delete(lease);
    for (const [turnId, candidate] of chatTurnLeaseById) {
      if (candidate === lease) chatTurnLeaseById.delete(turnId);
    }
  };
  const settleChatTurn = (turnId: string): void => {
    const lease = chatTurnLeaseById.get(turnId);
    if (lease !== undefined) {
      releaseChatTurnLease(lease);
      return;
    }
    settledChatTurnIds.add(turnId);
    while (settledChatTurnIds.size > 100) {
      const oldest = settledChatTurnIds.values().next().value;
      if (oldest === undefined) break;
      settledChatTurnIds.delete(oldest);
    }
  };
  const detachChatTurnCompleteWork = subscriber.on(
    'chat.message_complete',
    (event) => settleChatTurn(event.turn_id),
  );
  const detachChatTurnFailedWork = subscriber.on(
    'chat.transparency',
    (event) => {
      if (
        event.event !== null
        && typeof event.event === 'object'
        && (event.event as { kind?: unknown }).kind === 'engine.turn_failed'
      ) {
        settleChatTurn(event.turn_id);
      }
    },
  );

  const pauseServerSwitchSurface = (): void => {
    if (
      serverSwitchConvergence !== null
      || releaseServerSwitchPause !== null
    ) return;
    const obscured = new Map<HTMLElement, boolean>();
    for (const child of Array.from(options.root.children)) {
      const element = child as HTMLElement;
      obscured.set(element, element.hasAttribute('inert'));
      element.setAttribute('inert', '');
    }
    releaseServerSwitchPause = (): void => {
      for (const [element, wasInert] of obscured) {
        if (!wasInert) element.removeAttribute('inert');
      }
    };
  };
  const resumeServerSwitchSurface = (): void => {
    const release = releaseServerSwitchPause;
    releaseServerSwitchPause = null;
    release?.();
  };
  const signalServerProfilesChanged = (profileRemoved = false): void => {
    try {
      options.onServerProfilesChanged?.();
    } catch (err) {
      // The durable local write already won. A sibling hint is best-effort and
      // cannot roll it back.
      console.error('webclient: server profile signal failed', err);
    }
    if (!profileRemoved) return;
    try {
      options.onServerProfileRemoved?.();
    } catch (err) {
      // Compatibility callback for older hosts; same post-commit semantics.
      console.error('webclient: server profile removal signal failed', err);
    }
  };
  const signalActiveServerProfileChanged = (): void => {
    if (options.onActiveServerProfileChanged === undefined) {
      // Compatibility for direct hosts that only consume the original roster
      // callback. Production pair fallback provides the distinct fast hint.
      signalServerProfilesChanged();
      return;
    }
    try {
      options.onActiveServerProfileChanged();
    } catch (err) {
      // The durable pointer already won. Focus reconciliation remains the
      // fallback if the immediate sibling hint cannot be delivered.
      console.error('webclient: active server profile signal failed', err);
    }
  };
  const armAcceptedServerSwitchSignal = (): boolean => {
    const pageEvents = doc.defaultView as unknown as {
      addEventListener?: (type: string, listener: (event: Event) => void) => void;
      removeEventListener?: (type: string, listener: (event: Event) => void) => void;
    } | null;
    if (typeof pageEvents?.addEventListener !== 'function') return false;
    detachPendingServerSwitchSignal();
    let armed = true;
    const onPageHide = (): void => {
      if (!armed) return;
      armed = false;
      pageEvents.removeEventListener?.('pagehide', onPageHide);
      detachPendingServerSwitchSignal = (): void => undefined;
      // pagehide proves the browser accepted the reload. Signal here instead
      // of after location.reload(), where Chromium may tear the document down
      // before the post-reload statement runs.
      signalActiveServerProfileChanged();
    };
    pageEvents.addEventListener('pagehide', onPageHide);
    detachPendingServerSwitchSignal = (): void => {
      if (!armed) return;
      armed = false;
      pageEvents.removeEventListener?.('pagehide', onPageHide);
      detachPendingServerSwitchSignal = (): void => undefined;
    };
    return true;
  };

  const profileIdentity = (
    profile: WebclientServerProfile | undefined,
    fallback: ServerSwitchConvergenceIdentity,
  ): ServerSwitchConvergenceIdentity => profile === undefined
    ? fallback
    : {
        id: profile.id,
        label: profile.label.trim().length > 0 ? profile.label : fallback.label,
        serverUrl: profile.server_url,
      };

  const fallbackConvergenceIdentities = (
    targetProfileId: string,
  ): {
    source: ServerSwitchConvergenceIdentity;
    target: ServerSwitchConvergenceIdentity;
  } => ({
    source: {
      id: bootProfileId ?? 'source-profile',
      label: 'the server this tab opened with',
      serverUrl: pair.serverUrl,
    },
    target: {
      id: targetProfileId,
      label: 'the newly selected server',
      serverUrl: '',
    },
  });

  const convergenceIdentities = async (
    targetProfileId: string,
  ): Promise<{
    source: ServerSwitchConvergenceIdentity;
    target: ServerSwitchConvergenceIdentity;
  }> => {
    const fallback = fallbackConvergenceIdentities(targetProfileId);
    let profiles: ReadonlyArray<WebclientServerProfile> = [];
    try {
      profiles = await profileStore?.listProfiles() ?? [];
    } catch {
      // Identity degrades to explicit, non-invented fallback copy. The active
      // pointer remains authoritative and convergence must still be possible.
    }
    return {
      source: profileIdentity(
        profiles.find((profile) => profile.id === bootProfileId),
        fallback.source,
      ),
      target: profileIdentity(
        profiles.find((profile) => profile.id === targetProfileId),
        fallback.target,
      ),
    };
  };

  const closeServerSwitchConvergence = (): void => {
    serverSwitchConvergenceRevision += 1;
    serverSwitchConvergenceTargetId = null;
    serverSwitchConvergence?.dispose();
    serverSwitchConvergence = null;
    resumeServerSwitchSurface();
  };

  const buildServerSwitchConvergenceState = (
    identities: {
      source: ServerSwitchConvergenceIdentity;
      target: ServerSwitchConvergenceIdentity;
    },
    extra: Pick<ServerSwitchConvergenceState, 'error' | 'status'> = {},
    workSnapshot = currentServerSwitchWorkSnapshot(),
  ): ServerSwitchConvergenceState => {
    return {
      ...identities,
      workState: workSnapshot.workState,
      ...(workSnapshot.activeWork.length > 0
        ? { activeWork: workSnapshot.activeWork }
        : {}),
      ...(
        serverSwitchWorkStateHasChatDraft(workSnapshot.workState)
        && workSnapshot.chatDraft !== null
          ? { chatDraft: workSnapshot.chatDraft.text }
          : {}
      ),
      ...extra,
    };
  };

  const reloadForSiblingServerSwitch = async (
    requestedTargetProfileId: string,
    reviewedWork: Pick<
      ServerSwitchWorkSnapshot,
      'workState' | 'activeWork'
    > | null,
  ): Promise<'reload_requested' | 'choice_reverted' | 'confirmation_required'> => {
    if (
      profileStore === undefined
      || reloadForServerSwitch === undefined
      || bootProfileId === null
    ) {
      throw new Error('This tab cannot finish the server change automatically.');
    }
    let activeTarget: string | null;
    try {
      activeTarget = await profileStore.activeProfileId();
    } catch (cause) {
      throw new Error(
        'Recued couldn’t confirm the selected server. Your work is still here; try again.',
        { cause },
      );
    }
    if (activeTarget === bootProfileId) {
      // The origin-wide choice was reversed before this owner committed. The
      // still-mounted shell is coherent again; retain all in-memory work.
      closeServerSwitchConvergence();
      return 'choice_reverted';
    }
    if (activeTarget === null) {
      throw new Error(
        'The selected server is no longer saved. Reload this tab to review server setup.',
      );
    }
    if (activeTarget !== requestedTargetProfileId) {
      requestServerProfileConvergence(
        activeTarget,
        'The active server changed again. Review the updated destination before switching this tab.',
      );
      throw new Error(
        'The active server changed again. Review the updated destination before switching this tab.',
      );
    }

    // A clean tab can become dirty while the active-profile read is awaiting
    // IndexedDB. The provisional inert boundary prevents ordinary interaction,
    // and this final check protects against programmatic/in-flight edits before
    // any source-owned route or draft is discarded.
    const latestWork = currentServerSwitchWorkSnapshot();
    const requiresConfirmation = reviewedWork === null
      ? latestWork.workState !== 'clean'
      : !serverSwitchReviewCoversWorkState(
          reviewedWork.workState,
          latestWork.workState,
        ) || !serverSwitchReviewCoversActiveWork(
          reviewedWork.activeWork,
          latestWork.activeWork,
        );
    if (requiresConfirmation) {
      return 'confirmation_required';
    }

    const sourceHash = activeHash;
    const landingHash = serverSwitchLandingHash(
      sourceHash,
      requestedTargetProfileId,
    );
    if (
      landingHash !== sourceHash
      && replaceHashForServerSwitch === undefined
    ) {
      throw new Error(
        'This tab cannot safely remove the original server’s detail link before reloading.',
      );
    }
    let hashRewriteAttempted = false;
    try {
      if (landingHash !== sourceHash) {
        hashRewriteAttempted = true;
        replaceHashForServerSwitch?.(landingHash);
      }
      // The convergence overlay/clean-state check is the discard authority for
      // this reload. Do not arm the initiating tab's success marker: a sibling
      // silently follows the durable choice and must not replay its receipt.
      intentionalServerSwitchReload = true;
      reloadForServerSwitch();
      return 'reload_requested';
    } catch (error) {
      intentionalServerSwitchReload = false;
      if (hashRewriteAttempted) {
        try {
          replaceHashForServerSwitch?.(sourceHash);
        } catch {
          /* in-memory work remains behind the blocking boundary */
        }
      }
      throw new Error(
        'This tab could not reload automatically. Your work is still here; try again.',
        { cause: error },
      );
    }
  };

  const showServerSwitchConvergence = (
    identities: {
      source: ServerSwitchConvergenceIdentity;
      target: ServerSwitchConvergenceIdentity;
    },
    notice?: string,
  ): void => {
    const state = buildServerSwitchConvergenceState(identities, {
      ...(notice !== undefined ? { error: notice } : {}),
    });
    // Transfer the temporary inert lease to the modal synchronously so there
    // is no interactive gap while the durable pointer and live shell differ.
    resumeServerSwitchSurface();
    if (serverSwitchConvergence === null) {
      serverSwitchConvergence = mountServerSwitchConvergence({
        portal: options.root,
        background: appShell.root,
        document: doc,
        state,
        onContinue: async (
          targetProfileId,
          reviewedWorkState,
          reviewedActiveWork = [],
        ) => {
          const latestWorkSnapshot = currentServerSwitchWorkSnapshot();
          const latestWorkState = latestWorkSnapshot.workState;
          if (!serverSwitchReviewCoversWorkState(
            reviewedWorkState,
            latestWorkState,
          ) || !serverSwitchReviewCoversActiveWork(
            reviewedActiveWork,
            latestWorkSnapshot.activeWork,
          )) {
            const latestIdentities = await convergenceIdentities(targetProfileId);
            if (disposed) return;
            serverSwitchConvergence?.update(
              buildServerSwitchConvergenceState(latestIdentities, {
                status: 'Your work changed while this choice was open. Review the updated boundary before switching.',
              }),
            );
            return;
          }
          const outcome = await reloadForSiblingServerSwitch(targetProfileId, {
            workState: reviewedWorkState,
            activeWork: reviewedActiveWork,
          });
          if (outcome === 'confirmation_required') {
            const latestIdentities = await convergenceIdentities(targetProfileId);
            if (disposed) return;
            serverSwitchConvergence?.update(
              buildServerSwitchConvergenceState(latestIdentities, {
                status: 'Your work changed while this switch was being checked. Review the updated boundary before switching.',
              }),
            );
          }
        },
        onCheck: async (expectedTargetProfileId) => {
          if (
            profileStore === undefined
            || bootProfileId === null
          ) {
            throw new Error('This tab cannot check the server change automatically.');
          }
          let activeTarget: string | null;
          try {
            activeTarget = await profileStore.activeProfileId();
          } catch (cause) {
            throw new Error(
              'Recued couldn’t confirm the selected server. Your work is still here; try again.',
              { cause },
            );
          }
          if (activeTarget === bootProfileId) {
            closeServerSwitchConvergence();
            return null;
          }
          if (activeTarget === null) {
            throw new Error(
              'The selected server is no longer saved. Your source-server work is still here.',
            );
          }
          const identities = await convergenceIdentities(activeTarget);
          if (disposed) return null;
          const changed = activeTarget !== expectedTargetProfileId;
          const latestWorkSnapshot = currentServerSwitchWorkSnapshot();
          const latestWorkState = latestWorkSnapshot.workState;
          const sourceLabel = identities.source.label;
          const resultReadyOnly = latestWorkSnapshot.activeWork.length > 0
            && latestWorkSnapshot.activeWork.every(
              (work) => work.phase === 'result_ready',
            );
          const status = resultReadyOnly
            ? `A result is ready to review on ${sourceLabel}. It will stay on that server if you switch this tab.`
            : latestWorkState === 'in_flight'
            || latestWorkState === 'in_flight_with_chat_draft'
            || latestWorkState === 'in_flight_with_unsaved_changes'
              ? `Work is still finishing on ${sourceLabel}. Stay here and check again.`
              : latestWorkState === 'clean'
                ? `The request settled on ${sourceLabel}. You can switch this tab; its result or error stays there.`
                : `The request finished on ${sourceLabel}. Review the remaining work before switching.`;
          return buildServerSwitchConvergenceState(identities, {
            ...(changed
              ? {
                error: 'The active server changed again. Review the updated destination before switching this tab.',
              }
              : {}),
            status,
          }, latestWorkSnapshot);
        },
      });
    } else {
      serverSwitchConvergence.update(state);
    }
  };

  const requestServerProfileConvergence = (
    requestedTargetProfileId?: string,
    notice?: string,
  ): void => {
    if (
      requestedTargetProfileId !== undefined
      && requestedTargetProfileId === bootProfileId
    ) {
      closeServerSwitchConvergence();
      return;
    }
    if (
      disposed
      || bootProfileId === null
      || profileStore === undefined
    ) return;
    const requestedTargetKey = requestedTargetProfileId
      ?? pendingServerSwitchTarget;
    if (serverSwitchConvergenceTargetId === requestedTargetKey) return;
    // Pause every existing root surface before the first async profile read.
    // A clean sibling must not gain a last-moment old-server interaction while
    // another tab's durable choice already points somewhere else.
    pauseServerSwitchSurface();
    serverSwitchConvergenceTargetId = requestedTargetKey;
    const revision = ++serverSwitchConvergenceRevision;
    void (async () => {
      // Empty is an intentionally unresolved UI identity, never a durable
      // profile id produced by the store. A retry must resolve and display the
      // exact target before a dirty tab can discard its source work.
      let targetProfileId = requestedTargetProfileId ?? '';
      try {
        const activeTarget = await profileStore.activeProfileId();
        if (disposed || revision !== serverSwitchConvergenceRevision) return;
        if (activeTarget === bootProfileId) {
          closeServerSwitchConvergence();
          return;
        }
        if (activeTarget !== null) {
          targetProfileId = activeTarget;
          serverSwitchConvergenceTargetId = activeTarget;
        }
        const identities = await convergenceIdentities(targetProfileId);
        if (disposed || revision !== serverSwitchConvergenceRevision) return;
        const workState = currentServerSwitchWorkState();
        if (workState === 'clean' && serverSwitchConvergence === null) {
          try {
            const outcome = await reloadForSiblingServerSwitch(
              targetProfileId,
              null,
            );
            if (outcome === 'confirmation_required') {
              showServerSwitchConvergence(identities, notice);
            }
            return;
          } catch (error) {
            if (disposed || revision !== serverSwitchConvergenceRevision) return;
            const message = error instanceof Error
              ? error.message
              : 'This tab could not reload automatically. Try again.';
            showServerSwitchConvergence(identities, message);
            return;
          }
        }
        showServerSwitchConvergence(identities, notice);
      } catch (error) {
        if (!disposed && revision === serverSwitchConvergenceRevision) {
          // Keep the source shell paused and surface a safe retry. Resetting the
          // target dedupe also lets the next BroadcastChannel/focus hint retry
          // the durable read without requiring the user to discard anything.
          serverSwitchConvergenceTargetId = null;
          console.error('webclient: sibling server-switch convergence failed', error);
          showServerSwitchConvergence(
            fallbackConvergenceIdentities(targetProfileId),
            'Recued couldn’t confirm the selected server. Your work is still here; try again.',
          );
        }
      }
    })();
  };
  const diagnosticClipboard = doc.defaultView?.navigator?.clipboard;
  const serverUpdateDiagnosticWriter =
    typeof diagnosticClipboard?.writeText === 'function'
      ? (summary: string) => diagnosticClipboard.writeText(summary)
      : undefined;
  if (options.enableConnectionIndicator !== false) {
    // Inject the announcer + banner styles once into <head> (marker-guarded so a
    // re-bootstrap on the same document doesn't stack them) — the same
    // mount-creates-nodes / bootstrap-injects-styles split the notify toasts
    // use, which keeps `mountConnectionIndicator` touching only createElement.
    if (
      doc.head !== undefined
      && doc.head.querySelector(
        `style[${CONNECTION_INDICATOR_STYLES_MARKER}]`,
      ) === null
    ) {
      const connStyle = doc.createElement('style');
      connStyle.setAttribute(CONNECTION_INDICATOR_STYLES_MARKER, '');
      connStyle.textContent = CONNECTION_INDICATOR_STYLES;
      doc.head.appendChild(connStyle);
    }
    // A recovery return earns its receipt only after the mounted route's own
    // first server read settles. Ordinary profile switches and reauth returns
    // keep their immediate, one-shot receipt.
    deferredRecoveryReturnArrival =
      options.suppressInitialConnectedReceipt !== true
      && options.initialConnectedReceiptCopy === undefined
        ? recoveryReturnArrival
        : undefined;
    const initialConnectedReceiptCopy =
      options.suppressInitialConnectedReceipt === true
        ? undefined
        : options.initialConnectedReceiptCopy
          ?? (deferredRecoveryReturnArrival === undefined
            ? serverSwitchArrivalReceiptCopy
            : undefined)
          ?? (deferredRecoveryReturnArrival === undefined
            && options.reauthRecovery !== undefined
            ? options.reauthRecovery.chatDraft !== undefined
              ? 'Reconnected. Your Chat draft is ready where you left it.'
              : 'Reconnected. You’re back where you left off.'
            : undefined);
    connectionIndicator = mountConnectionIndicator({
      statusHost: appShell.connectionHost,
      bannerHost: options.root,
      document: doc,
      status: connectionStatus.status,
      onStatus: connectionStatus.onStatus,
      ...(initialConnectedReceiptCopy !== undefined
        ? {
            receiptOnFirstConnected: true,
            firstConnectedReceiptCopy: initialConnectedReceiptCopy,
          }
        : {}),
      // "Review server profiles" opens Account — the badge, explanation, and
      // profile list all live there. It used to open a second popover whose
      // third step linked to Settings ▸ Server, every panel of which is rpc-
      // driven and therefore unreachable during the outage that raised it.
      onRecoveryAction: () => accountMenu?.open(),
      focusAfterActionRetires: () =>
        appShell.accountHost.querySelector<HTMLElement>(
          `[${ACCOUNT_MENU_TRIGGER_ATTR}]`,
        ),
    });
    // Account menu — the topbar's rightmost control, and the answer to
    // "where do I go when my server stops answering".
    //
    // The route-independent banner reports an outage; this is where the owner
    // can act on it. Its badge is driven by the same `connection-status`
    // controller, and the profile list reads local storage only, so it stays
    // usable with nothing running on the other end.
    if (
      doc.head !== undefined
      && doc.head.querySelector(`style[${ACCOUNT_MENU_STYLES_MARKER}]`) === null
    ) {
      const accountStyle = doc.createElement('style');
      accountStyle.setAttribute(ACCOUNT_MENU_STYLES_MARKER, '');
      accountStyle.textContent = `${ACCOUNT_MENU_STYLES}\n${SERVER_SWITCHER_STYLES}`;
      doc.head.appendChild(accountStyle);
    }
    // Re-read the roster from storage rather than trusting a cached copy:
    // another tab may have switched, renamed, or forgotten a server since
    // this one booted.
    const refreshAccountMenu = (): void => {
      void (async () => {
        try {
          const [profiles, activeId] = await Promise.all([
            profileStore?.listProfiles() ?? Promise.resolve([]),
            profileStore?.activeProfileId() ?? Promise.resolve(null),
          ]);
          const currentProfileIds = new Set(
            profiles.map((profile) => profile.id),
          );
          for (const previous of knownServerProfiles) {
            if (!currentProfileIds.has(previous.id)) {
              inactiveProfileRecoveryDiscovery.purge(previous.id);
            }
          }
          knownServerProfiles = profiles;
          const bootProfile = profiles.find((profile) =>
            profile.id === bootProfileId);
          if (bootProfile !== undefined) {
            const label = bootProfile.label.trim();
            bootProfileLabel = label.length > 0
              ? label
              : defaultProfileLabel(bootProfile.server_url);
            if (recoveryIntentContinuationMarker !== null) {
              recoveryIntentContinuation =
                recoveryIntentContinuationPresentation(
                  recoveryIntentContinuationMarker,
                );
              approvalAttentionPopover?.setRecoveryIntentContinuation(
                recoveryIntentContinuation,
              );
            }
            if (recoveryIntentExpiryHandoff !== null) {
              recoveryIntentExpiryHandoff = {
                ...recoveryIntentExpiryHandoff,
                serverProfileLabel: bootProfileLabel,
              };
              approvalAttentionPopover?.setRecoveryIntentExpiryHandoff(
                recoveryIntentExpiryHandoff,
              );
            }
            approvalAttentionPopover?.setConnectionRecoveryProfileLabel(
              bootProfileLabel,
            );
          }
          if (
            pendingInactiveProfileRecoveryReviewId !== null
            && !profiles.some((profile) =>
              profile.id === pendingInactiveProfileRecoveryReviewId
              && profile.server_url.length > 0)
          ) {
            inactiveProfileRecoveryReview.retire(
              pendingInactiveProfileRecoveryReviewId,
            );
            inactiveProfileRecoveryDiscovery.purge(
              pendingInactiveProfileRecoveryReviewId,
            );
            pendingInactiveProfileRecoveryReviewId = null;
          }
          refreshInactiveConnectionRecoveryHints(profiles);
          refreshRecoveryExcursionReturn(profiles);
          refreshActivePostSafeStopProfileContext(profiles);
          accountMenu?.refresh(profiles, activeId);
        } catch (err) {
          // A roster read failure must not take down the shell; the menu keeps
          // showing what it last rendered.
          console.error('webclient: account menu refresh failed', err);
        }
      })();
    };
    requestServerProfileRefresh = refreshAccountMenu;
    // Mount the Account surface synchronously, then hydrate its local roster.
    // Theme, Settings, and the banner handoff must remain usable even when an
    // IndexedDB profile read is slow or fails; gating the whole menu on that
    // Promise made the banner's only action briefly inert and could remove the
    // account control altogether on a storage error.
    try {
        accountMenu = mountAccountMenu({
          host: appShell.accountHost,
          document: doc,
          profiles: [],
          activeProfileId: null,
          unreachable: connectionStatus.status() === 'offline',
          activeConnected: connectionStatus.status() === 'connected',
          ...(options.now !== undefined ? { now: options.now } : {}),
          ...(serverUpdateDiagnosticWriter !== undefined
            ? { serverUpdateDiagnosticWriter }
            : {}),
          settingsHref: serializeShellRoute('settings', 'account'),
          onClose: () => {
            serverPill?.closeControls();
            if (pendingInactiveProfileRecoveryReviewId !== null) {
              inactiveProfileRecoveryReview.retire(
                pendingInactiveProfileRecoveryReviewId,
              );
              pendingInactiveProfileRecoveryReviewId = null;
            }
            // Closing the reviewed return does not abandon it. Keep the
            // durable neutral Attention offer; only clear this Account-open
            // selection so a later unrelated switch cannot inherit its route.
            pendingRecoveryExcursionReturn = null;
          },
          onConnectionDiagnosisClosed: (
            diagnosis,
            disposition,
            serverOutcome,
            serverCurrentState,
          ) => {
            serverPill?.closeControls();
            const pending = pendingRecoveryIntentConnectionDiagnosis;
            if (pending === null || diagnosis.id !== pending.id) return;
            pendingRecoveryIntentConnectionDiagnosis = null;
            if (pending.source === 'expired_area_review') {
              const deferred = recoveryIntentExpiredDeferredCheck;
              const current = recoveryIntentExpiryHandoff;
              const stillMatches = deferred !== null
                && current !== null
                && current.phase === 'handoff'
                && current.diagnosisTarget === 'server'
                && diagnosis.kind === 'expired_area_review'
                && diagnosis.profileId === pending.profileId
                && deferred.profileId === pending.profileId
                && deferred.landingHash === pending.landingHash
                && deferred.deferredAt === pending.deferredAt
                && deferred.expiresAt === pending.expiredAt
                && deferred.diagnosisTarget === 'server';
              if (!stillMatches) return;
              if (disposition === 'return') {
                // Account can finish diagnosis, but it cannot infer that the
                // route recovered. Persist one intent-free choice and hand it
                // back to Attention: one fresh broad-area check or closure.
                const outcome = recoveryIntentDeferredCheckStore
                  .recordDiagnosisOutcome(deferred);
                if (outcome === null) {
                  clearRecoveryIntentExpiryHandoff();
                  return;
                }
                recoveryIntentExpiredDeferredCheck = outcome;
                setRecoveryIntentExpiryHandoffState(
                  'outcome',
                  undefined,
                  undefined,
                  undefined,
                  connectionStatus.status() === 'connected'
                    ? undefined
                    : 'server',
                );
                void Promise.resolve().then(() => {
                  const currentOutcome = recoveryIntentExpiredDeferredCheck;
                  if (
                    currentOutcome?.diagnosisOutcome !== 'choose'
                    || recoveryIntentExpiryHandoff?.phase !== 'outcome'
                  ) return;
                  approvalAttentionPopover?.open();
                });
              } else {
                // Merely closing Account keeps the quiet diagnosis reminder.
                // Republish because the initiating Attention click consumed
                // its local copy while Account temporarily owned focus.
                approvalAttentionPopover?.setRecoveryIntentExpiryHandoff(
                  current,
                );
              }
              return;
            }
            if (disposition !== 'return') return;
            const marker = recoveryIntentContinuationMarker;
            const markerStillMatches =
              marker === null
                ? false
                : diagnosis.profileId === pending.profileId
                  && marker.profileId === pending.profileId
                  && marker.landingHash === pending.landingHash
                  && marker.intent === pending.intent
                  && marker.pausedAt === pending.pausedAt;
            const reviewStateStillMatches = pending.source
              === 'bounded_handoff'
              ? recoveryIntentContinuationPhase === 'verification_handoff'
                && recoveryIntentContinuationRemediation === 'escalated'
                && recoveryIntentContinuationReviewTarget
                  === pending.reviewTarget
                && recoveryIntentReviewVerificationTarget
                  === pending.reviewTarget
                && recoveryIntentContinuationInterruptionReason
                  === pending.interruptionReason
              : recoveryIntentContinuationPhase === 'awaiting_review_outcome'
                && recoveryIntentContinuationRemediation === 'escalated'
                && recoveryIntentContinuationReviewTarget === 'server'
                && isUnresolvedServerControlActionOutcome(
                  pending.priorServerOutcome,
                )
                && serverControlActionOutcomesMatch(
                  recoveryIntentServerControlOutcome,
                  pending.priorServerOutcome,
                );
            if (
              marker === null
              || !markerStillMatches
              || !reviewStateStillMatches
            ) return;
            // The explicit return, not merely opening or closing Account, is
            // the reviewed boundary that releases an old two-interruption
            // verifier. A receipt re-review instead keeps its last projection
            // unless a deliberate new server action produced a fresher one.
            if (pending.source === 'bounded_handoff') {
              clearRecoveryIntentReviewVerification();
            }
            const nextServerOutcome = serverOutcome
              ?? (pending.source === 'unresolved_receipt'
                ? pending.priorServerOutcome
                : null);
            const nextServerCurrentState:
              ServerControlCurrentStateObservation | null = pending.source
              === 'unresolved_receipt'
              && (
                serverCurrentState?.state === 'running'
                || serverCurrentState?.state === 'paused'
              )
                ? { state: serverCurrentState.state }
                : null;
            if (nextServerCurrentState !== null) {
              // Crossing from an unresolved historical receipt to a fresh
              // server-state baseline leaves exactly one route-owned area
              // check. Persist only that closed-list obligation and its
              // existing profile/route/intent binding; the action, receipt,
              // and paused/running observation remain memory-only.
              const verification =
                recoveryIntentContinuationStore.prepareReviewVerification(
                  marker,
                );
              if (verification !== null) {
                recoveryIntentReviewVerificationTarget =
                  verification.reviewTarget;
              }
            }
            setRecoveryIntentContinuationState(
              'awaiting_review_outcome',
              'escalated',
              'server',
              null,
              nextServerOutcome,
              nextServerCurrentState,
            );
            approvalAttentionPopover?.open();
          },
          onReviewConnectionDiagnosisServerControls: (diagnosis, handoff) =>
            diagnosis.profileId === bootProfileId
              ? serverPill?.openControls(handoff) ?? 'unavailable'
              : 'unavailable',
          onReadConnectionDiagnosisServerCurrentState: (diagnosis) => {
            const pending = pendingRecoveryIntentConnectionDiagnosis;
            if (
              diagnosis.profileId !== bootProfileId
              || pending?.source !== 'unresolved_receipt'
              || pending.id !== diagnosis.id
              || pending.profileId !== diagnosis.profileId
            ) return null;
            const observation = serverPill?.readCurrentState() ?? null;
            if (observation !== null) serverPill?.closeControls();
            return observation;
          },
          ...(profileStore !== undefined && reloadForServerSwitch !== undefined
            ? {
              onAddServer: () => {
                void (async () => {
                  // Open a pending profile, then reload. The boot reads no
                  // `server_url` and lands on the pair form — the existing,
                  // fully-tested pairing surface rather than a second one
                  // built inside this menu. Pairing adopts the pending
                  // record; abandoning is recoverable because that form now
                  // offers a way back to a server that still works.
                  try {
                    await profileStore.beginNewProfile();
                  } catch (err) {
                    console.error('webclient: add server failed', err);
                    refreshAccountMenu();
                    return;
                  }
                  reloadForServerSwitch();
                })();
              },
            }
            : {}),
          switchWorkState: currentServerSwitchWorkState,
          switchActiveWork: currentServerSwitchActiveWork,
          activeWork: switchWorkTracker.activeWork(),
          onReturnToWork: navigateHash,
          onResumeServerUpdateGuide: (guide) => {
            const marker = credentialRotationServerUpdateContinuity.read();
            if (
              marker?.phase === 'resolved_elsewhere'
              && guide.returnHref
                === serializeConnectionsCredentialRotationRetry(marker)
            ) {
              credentialRotationServerUpdateContinuity
                .resumeResolvedRetry(marker);
            }
          },
          onDismissServerUpdateGuide: (guide) => {
            const marker = credentialRotationServerUpdateContinuity.read();
            if (
              marker !== null
              && guide.returnHref
                === serializeConnectionsCredentialRotationRetry(marker)
            ) {
              retireServerUpdateReturn(marker);
            }
          },
          onRetryServerUpdateReceipt: () => {
            serverUpdateReceiptVerification?.retry();
          },
          onFinishServerUpdateReceiptClosure: () => {
            serverUpdateReceiptVerification?.finishClosure();
          },
          onSwitch: async (
            id,
            reviewedWorkState,
            reviewedActiveWork = [],
          ) => {
            // Persist FIRST, verify the exact target, silently remove any
            // source-owned URL identity, then reload. The inline profile-list
            // review above is the one discard decision; the ordinary native
            // beforeunload guard is suppressed only after every precondition
            // has committed.
            if (
              pendingInactiveProfileRecoveryReviewId !== null
              && pendingInactiveProfileRecoveryReviewId !== id
            ) {
              inactiveProfileRecoveryReview.retire(
                pendingInactiveProfileRecoveryReviewId,
              );
              pendingInactiveProfileRecoveryReviewId = null;
            }
            if (
              profileStore === undefined
              || reloadForServerSwitch === undefined
              || bootProfileId === null
            ) {
              throw new Error('Server switching is not available in this tab.');
            }
            const sourceHash = activeHash;
            const recoveryReturn =
              pendingRecoveryExcursionReturn?.sourceProfileId === id
                ? pendingRecoveryExcursionReturn
                : null;
            const landingHash = recoveryReturn?.returnHash
              ?? serverSwitchLandingHash(sourceHash, id);
            if (
              landingHash !== sourceHash
              && replaceHashForServerSwitch === undefined
            ) {
              throw new Error(
                'This tab cannot safely remove the current server’s detail link before switching.',
              );
            }

            let switchAttempted = false;
            let hashRewriteAttempted = false;
            let failureStage:
              | 'preflight_read'
              | 'preflight_changed'
              | 'work_changed'
              | 'persist'
              | 'verify'
              | 'rewrite'
              | 'reload' = 'preflight_read';
            try {
              const activeBeforeSwitch = await profileStore.activeProfileId();
              if (activeBeforeSwitch !== bootProfileId) {
                failureStage = 'preflight_changed';
                throw new Error('active profile changed before switch');
              }
              const workBeforePersist = currentServerSwitchWorkSnapshot();
              if (!serverSwitchReviewCoversWorkState(
                reviewedWorkState,
                workBeforePersist.workState,
              ) || !serverSwitchReviewCoversActiveWork(
                reviewedActiveWork,
                workBeforePersist.activeWork,
              )) {
                failureStage = 'work_changed';
                throw new Error('source work changed before switch');
              }

              failureStage = 'persist';
              switchAttempted = true;
              await profileStore.switchProfile(id);
              failureStage = 'verify';
              if (await profileStore.activeProfileId() !== id) {
                throw new Error('selected profile was not made active');
              }
              const workBeforeReload = currentServerSwitchWorkSnapshot();
              if (!serverSwitchReviewCoversWorkState(
                reviewedWorkState,
                workBeforeReload.workState,
              ) || !serverSwitchReviewCoversActiveWork(
                reviewedActiveWork,
                workBeforeReload.activeWork,
              )) {
                failureStage = 'work_changed';
                throw new Error('source work changed while switch was finishing');
              }

              failureStage = 'rewrite';
              if (landingHash !== sourceHash) {
                hashRewriteAttempted = true;
                replaceHashForServerSwitch?.(landingHash);
              }

              failureStage = 'reload';
              intentionalServerSwitchReload = true;
              const acceptedReloadSignalArmed = armAcceptedServerSwitchSignal();
              requestServerSwitchReload({
                targetProfileId: id,
                ...(recoveryReturn !== null
                  ? { recoveryReturnLandingHash: landingHash }
                  : {}),
                ...(recoveryReturn?.returnContext !== undefined
                  ? { recoveryReturnContext: recoveryReturn.returnContext }
                  : {}),
                ...(options.serverSwitchContinuityStorage !== undefined
                  ? { storage: options.serverSwitchContinuityStorage }
                  : {}),
                reload: reloadForServerSwitch,
              });
              // Account closes after an accepted switch. That close is not an
              // abandonment: leave the session marker for the destination
              // boot, but clear this source-tab owner so `onClose` cannot
              // retire it before navigation commits. A thrown reload stays in
              // the catch path with the owner intact, so the person can retry
              // here or explicitly close Account to abandon the handoff.
              if (pendingInactiveProfileRecoveryReviewId === id) {
                pendingInactiveProfileRecoveryReviewId = null;
              }
              // The reviewed switch is now accepted. Whether the owner chose
              // the saved source or deliberately selected another profile,
              // this target-owned excursion no longer has work to resume.
              if (activeRecoveryExcursion !== null) {
                inactiveProfileRecoveryReview.retire(
                  activeRecoveryExcursion.targetProfileId,
                );
                activeRecoveryExcursion = null;
                recoveryExcursionReturn = null;
                approvalAttentionPopover?.setRecoveryExcursionReturn(null);
              }
              pendingRecoveryExcursionReturn = null;
              // Non-window/test hosts cannot expose pagehide; their injected
              // reload returning is the strongest available acceptance seam.
              if (!acceptedReloadSignalArmed) {
                signalActiveServerProfileChanged();
              }
            } catch (err) {
              detachPendingServerSwitchSignal();
              intentionalServerSwitchReload = false;
              let rollbackFailed = false;
              let pointerChangedExternally = false;
              if (switchAttempted) {
                let activeAfterFailure: string | null | undefined;
                try {
                  activeAfterFailure = await profileStore.activeProfileId();
                } catch {
                  // An unreadable pointer after a returned/partial write is
                  // unsafe. An idempotent rollback below is the only way to
                  // keep this still-mounted shell aligned with its source.
                  activeAfterFailure = undefined;
                }
                try {
                  // Do not overwrite a positively observed newer sibling-tab
                  // choice. Roll back the selected target—or an unreadable
                  // result—to the server this live shell is still using.
                  if (activeAfterFailure === id || activeAfterFailure === undefined) {
                    await profileStore.switchProfile(bootProfileId);
                    if (await profileStore.activeProfileId() !== bootProfileId) {
                      rollbackFailed = true;
                    }
                  } else if (activeAfterFailure !== bootProfileId) {
                    // A sibling won with another profile. Preserve its choice,
                    // but this old shell is no longer coherent with storage.
                    pointerChangedExternally = true;
                  }
                } catch {
                  rollbackFailed = true;
                }
              }
              if (hashRewriteAttempted) {
                try {
                  replaceHashForServerSwitch?.(sourceHash);
                } catch {
                  // The mounted route and its in-memory work still exist. A
                  // stale address-bar rewrite is less harmful than claiming
                  // the server pointer recovered when it did not.
                }
              }
              console.error('webclient: server switch failed', err);
              refreshAccountMenu();
              if (pointerChangedExternally) {
                throw new Error(
                  'The active server changed in another tab while this switch was finishing. Reload this tab before continuing.',
                );
              }
              if (rollbackFailed) {
                throw new Error(
                  'The saved server changed, but this tab couldn’t reload. Reload this tab before continuing.',
                );
              }
              if (failureStage === 'preflight_changed') {
                throw new Error(
                  'The active server changed in another tab. Review the server list and try again.',
                );
              }
              if (failureStage === 'work_changed') {
                throw new Error(
                  'Your work changed while this switch was finishing. Review the updated boundary before switching.',
                );
              }
              if (failureStage === 'verify') {
                throw new Error(
                  'Couldn’t confirm the selected server. Nothing was switched here.',
                );
              }
              if (failureStage === 'reload') {
                throw new Error(
                  'This tab couldn’t reload automatically. Your work is still here; try the switch again.',
                );
              }
              throw new Error(
                'Couldn’t switch servers. Your work is still here; try again.',
              );
            }
          },
          ...(profileStore !== undefined
            ? {
              onRename: async (id: string, label: string) => {
                try {
                  const savedLabel = await profileStore.renameProfile(id, label);
                  if (savedLabel === null) {
                    throw new Error(
                      'This server profile was removed in another tab.',
                    );
                  }
                  signalServerProfilesChanged();
                  return savedLabel;
                } catch (err) {
                  console.error('webclient: rename server profile failed', err);
                  throw new Error(
                    `Couldn’t save this server name. ${humanizeRpcError(err)}`,
                  );
                }
              },
            }
            : {}),
          ...(profileStore !== undefined && reloadForServerSwitch !== undefined
            ? {
              onRemove: async (id, mode) => {
                const [profiles, activeId] = await Promise.all([
                  profileStore.listProfiles(),
                  profileStore.activeProfileId(),
                ]).catch((err: unknown): never => {
                  console.error('webclient: read server profile failed', err);
                  throw new Error(
                    'Couldn’t check this saved server profile. Nothing was removed. Try again.',
                  );
                });
                const profile = profiles.find((candidate) => candidate.id === id);
                if (profile === undefined) {
                  // A sibling tab already completed the durable operation.
                  // Treat that as convergence, not as a destructive-action
                  // failure that asks the owner to retry a missing record.
                  inactiveProfileRecoveryReview.retire(id);
                  inactiveProfileRecoveryDiscovery.purge(id);
                  if (pendingInactiveProfileRecoveryReviewId === id) {
                    pendingInactiveProfileRecoveryReviewId = null;
                  }
                  refreshAccountMenu();
                  return;
                }
                const wasActive = activeId === id;
                let revokeCommitted = false;

                if (mode === 'revoke') {
                  const instanceId = profile.pair_metadata?.instance_id?.trim() ?? '';
                  if (!wasActive) {
                    throw new Error(
                      'Switch to this server before revoking this browser’s access.',
                    );
                  }
                  if (connectionStatus.status() !== 'connected') {
                    throw new Error(
                      'Reconnect to this server before revoking access. The saved profile is still available.',
                    );
                  }
                  if (instanceId.length === 0) {
                    throw new Error(
                      'This older profile has no revocable browser identity. Forget it on this browser instead.',
                    );
                  }

                  intentionalProfileRetirement = true;
                  try {
                    await runSelfPairRevocation({
                      instanceId,
                      runRevoke: (signal) =>
                        rpcConn.call(
                          'pair.revoke',
                          { instance_id: instanceId },
                          { signal },
                        ),
                      onMessage: ws.onMessage,
                      ...(options.selfRevokeReceiptGraceMs !== undefined
                        ? {
                            receiptGraceMs:
                              options.selfRevokeReceiptGraceMs,
                          }
                        : {}),
                    });
                    revokeCommitted = true;
                  } catch (err) {
                    intentionalProfileRetirement = false;
                    replaySuppressedRetirementReauth();
                    console.error('webclient: revoke server access failed', err);
                    throw new Error(
                      `Couldn’t revoke this browser’s access. ${humanizeRpcError(err)} The saved profile is still here; retry or forget it locally.`,
                    );
                  }
                }

                try {
                  // Remote proof FIRST, durable local deletion SECOND. A
                  // failed revoke therefore never silently degrades into a
                  // local forget and leaves the server-side bearer live.
                  await profileStore.removeProfile(id);
                } catch (err) {
                  console.error('webclient: forget server failed', err);
                  if (revokeCommitted) {
                    // Keep retirement suppression: this bearer really was
                    // revoked, and the inline local-only action is now the
                    // honest recovery from a failed IndexedDB deletion.
                    throw new Error(
                      'Access was revoked, but this browser could not remove the saved profile. Try “Forget on this browser” again.',
                    );
                  }
                  throw new Error(
                    `Couldn’t forget this server on this browser. ${humanizeRpcError(err)}`,
                  );
                }

                inactiveProfileRecoveryReview.retire(id);
                inactiveProfileRecoveryDiscovery.purge(id);
                if (pendingInactiveProfileRecoveryReviewId === id) {
                  pendingInactiveProfileRecoveryReviewId = null;
                }

                signalServerProfilesChanged(true);

                // Forgetting the server this tab is CONNECTED to leaves the
                // app running against credentials it no longer holds, so that
                // case reboots onto the roster fallback. Forgetting any other
                // profile is a local roster edit and only needs a re-render.
                if (wasActive) reloadForServerSwitch();
                else refreshAccountMenu();
              },
            }
            : {}),
        });
        detachServerSwitchWork = switchWorkTracker.subscribe((work) => {
          accountMenu?.setActiveWork(work);
        });
        // A reload restores the privacy-safe pointer quietly: discoverable in
        // Account, but never forcing the popover over the owner's exact route.
        syncAccountServerUpdateGuide();
        // The theme toggle lives in the menu's quick row now, so it mounts
        // once the menu exists and exposes its slot.
        themeToggle = mountThemeToggle({
          host: accountMenu.themeSlot(),
          document: doc,
        });
        // D-109 server-status pill — now INSIDE this menu (see the topbar
        // note above). Mounted HERE, not beside the menu: the slot only
        // exists once `mountAccountMenu` has returned. Same style-inject
        // discipline (marker-guarded). The pill
        // still hides itself while not connected (the banner + active profile
        // own the down-signal), so the menu's status row collapses then.
        if (
          doc.head !== undefined
          && doc.head.querySelector(`style[${SERVER_PILL_STYLES_MARKER}]`) === null
        ) {
          const pillStyle = doc.createElement('style');
          pillStyle.setAttribute(SERVER_PILL_STYLES_MARKER, '');
          pillStyle.textContent = SERVER_PILL_STYLES;
          doc.head.appendChild(pillStyle);
        }
        // The menu's slot IS the pill host now, so it has to carry the host
        // attribute: every pill style is scoped under it, and a slot without
        // it renders an unstyled pill.
        const pillHost = accountMenu.serverSlot();
        pillHost.setAttribute(SERVER_PILL_HOST_ATTR, '');
        serverPill = mountWebclientServerPill({
          host: pillHost,
          status: connectionStatus.status,
          onStatus: connectionStatus.onStatus,
          ...(options.now !== undefined ? { now: options.now } : {}),
          // D-188 — the master pause control. Owner-only `server.setPaused`
          // rides the bearer-gated WS (never MCP-bridged); reachable while
          // paused since it never routes through the op-admission gate.
          runSetPaused: (active: boolean) =>
            rpcConn.call('server.setPaused', { active }),
          // D-188 — restart control (drain + supervisor handoff). The popover
          // gates the button on a respawning supervisor_mode from the
          // heartbeat, so an un-supervised server never shows it; it doubles
          // as the crash-halt recovery action.
          runRequestRestart: () =>
            rpcConn.call('server.requestRestart', { reason: 'webclient' }),
          onControlAvailabilityChange: (available) => {
            accountMenu?.setConnectionDiagnosisControlAvailability(
              bootProfileId,
              available,
            );
          },
          onCurrentStateAvailabilityChange: (available) => {
            accountMenu?.setConnectionDiagnosisCurrentStateAvailability(
              bootProfileId,
              available,
            );
          },
        });
        // Badge follows the same controller as the banner, so the two can
        // never disagree about whether the current server is reachable.
        unsubscribeAccountStatus = connectionStatus.onStatus((status) => {
          accountMenu?.setUnreachable(status === 'offline');
          accountMenu?.setActiveConnected(status === 'connected');
        });
        refreshAccountMenu();
      } catch (err) {
        console.error('webclient: account menu unavailable', err);
      }
  }

  // Profile recency belongs to the exact credential generation this shell
  // hydrated, not whatever shared active pointer a sibling may write later.
  // Drive it from the raw socket's `connected` transition (rather than the
  // coarse status controller, whose stalled -> connected recovery is not a new
  // connection). Writes are serialized so a quick reconnect cannot overtake
  // the prior stamp. Failure is non-fatal: the live app remains connected and
  // the next reconnect tries again.
  let profileRecencyObserverDisposed = false;
  let profileRecencyWrite: Promise<void> = Promise.resolve();
  let profileRecencyFailureReported = false;
  const detachProfileRecency =
    options.profileStore !== undefined
    && bootProfileId !== null
    && bootProfileId.length > 0
      ? ws.onState((state) => {
          if (state !== 'connected') return;
          const connectedAt = (options.now ?? Date.now)();
          if (!Number.isFinite(connectedAt) || connectedAt < 0) return;
          const run = profileRecencyWrite.then(async () => {
            await options.profileStore!.noteProfileConnected(
              bootProfileId,
              connectedAt,
            );
            profileRecencyFailureReported = false;
            if (profileRecencyObserverDisposed) return;
            requestServerProfileRefresh();
            signalServerProfilesChanged();
          });
          profileRecencyWrite = run.catch((err: unknown) => {
            if (!profileRecencyFailureReported) {
              profileRecencyFailureReported = true;
              console.error('webclient: server profile recency update failed', err);
            }
          });
        })
      : (): void => undefined;

  // Slice 111 — production composer for the `tls.renew` caller seam.
  // `enableTlsRenewPanel: false` opts out (tests that don't exercise
  // Server section pass `false` so the bootstrap doesn't surface a
  // "Renew TLS" button against their fakes). `undefined` defaults to
  // enabled — production paths see the Server section without per-
  // entrypoint plumbing. The closure captures `rpcConn.call` once;
  // the bootstrap's dispose order tears down the route before
  // `rpcConn.dispose()`, so a click that lands after dispose() is
  // best-effort + the conn's dispose-side abort surfaces as a thrown
  // error → error state with the rpc's message.
  const tlsRenewCaller =
    options.enableTlsRenewPanel === false
      ? undefined
      : ({ reason }: { reason?: string }) =>
          rpcConn.call(
            'tls.renew',
            reason !== undefined ? { reason } : {},
          );

  // `tls_domain.*` — the Certificates tab's installed-cert list + BYO upload.
  // Gated on the SAME `enableTlsRenewPanel` flag rather than a second knob:
  // that option already means "do not surface cert management against my
  // fakes", and the two surfaces share one tab. `tls_domain.*` is in
  // `MCP_RESERVED_RPC_PREFIXES` — these are first-party WS calls only; an AI
  // agent must never be able to drive a cert upload, because the cert + key
  // pair IS this server's identity to its pinned clients.
  const tlsDomainPanelOff = options.enableTlsRenewPanel === false;
  const tlsDomainListCaller: TlsDomainListCaller | undefined = tlsDomainPanelOff
    ? undefined
    : () => rpcConn.call('tls_domain.list', {});
  const tlsDomainUploadCaller: TlsDomainUploadCaller | undefined = tlsDomainPanelOff
    ? undefined
    : (req) => rpcConn.call('tls_domain.upload', req);
  const tlsDomainRemoveCaller: TlsDomainRemoveCaller | undefined = tlsDomainPanelOff
    ? undefined
    : (req) => rpcConn.call('tls_domain.remove', req);

  // R26.2 Delta 1 — Settings → Server → Exposure grid callers. Default ON;
  // `enableExposurePanel: false` opts out (same discipline as
  // `enableTlsRenewPanel`). The read + three mutators are first-party WS
  // calls; `exposure.*` is MCP-reserved so the catalog stays off AI agents.
  // `exposureHasDdnsCaller` derives the DDNS-configured advisory from
  // `collection.hostname.list` (any row with `ddns_managed`) independent of
  // the Hostnames panel gate; an older server's unknown-method error degrades
  // to `has_ddns: false` panel-side (`runHasDdns` is `.catch`-guarded there).
  const exposurePanelOff = options.enableExposurePanel === false;
  const exposureGetCaller: ExposureGetCaller | undefined = exposurePanelOff
    ? undefined
    : () => rpcConn.call('exposure.get', undefined);
  const exposureApplyPresetCaller: ExposureApplyPresetCaller | undefined =
    exposurePanelOff ? undefined : (req) => rpcConn.call('exposure.apply_preset', req);
  const exposureSetPathResolutionCaller:
    | ExposureSetPathResolutionCaller
    | undefined = exposurePanelOff
    ? undefined
    : (req) => rpcConn.call('exposure.set_path_resolution', req);
  const exposureSetPublicMcpAckCaller:
    | ExposureSetPublicMcpAckCaller
    | undefined = exposurePanelOff
    ? undefined
    : (req) => rpcConn.call('exposure.set_public_mcp_acknowledgement', req);
  const exposureSetApexCaller: ExposureSetApexCaller | undefined =
    exposurePanelOff ? undefined : (req) => rpcConn.call('exposure.set_apex', req);
  const exposureHasDdnsCaller: ExposureHasDdnsCaller | undefined =
    exposurePanelOff
      ? undefined
      : async () => {
          const res = await rpcConn.call('collection.hostname.list', undefined);
          return res.hostnames.some((h) => h.ddns_managed);
        };

  // R26.4 Backup & Migration Unification (M1) — `server.archive.{export,status,
  // import}` callers for the consolidated Backup & Recovery surface. Default ON;
  // `enableArchiveBackupPanel: false` opts out (same discipline as
  // `enableTlsRenewPanel`). Auth-gated first-party WS calls; the rpc is MCP-
  // reserved so the catalog stays off AI agents. The recovery key is sent
  // in-flow per call (export seals / restore decrypts); the committing import
  // restarts the server — the panel handles the WS drop as expected (see the
  // panel header). `include_passport` embeds the identity passport in the
  // archive; `currentRealmKey` authorizes a Q2 cross-realm restore.
  const archiveBackupOff = options.enableArchiveBackupPanel === false;
  const archiveExportCaller = archiveBackupOff
    ? undefined
    : (args: {
        include_blobs?: boolean;
        include_passport?: boolean;
        recoveryKey: string;
      }) => rpcConn.call('server.archive.export', args);
  const archiveStatusCaller = archiveBackupOff
    ? undefined
    : (args: { job_id: string }) => rpcConn.call('server.archive.status', args);
  const archiveImportCaller = archiveBackupOff
    ? undefined
    : (args: {
        path: string;
        recoveryKey: string;
        currentRealmKey?: string;
        force?: boolean;
        dry_run?: boolean;
      }) => rpcConn.call('server.archive.import', args);

  // An archive export is longer-lived than its start rpc. Keep the start
  // promise + server job id at boot scope so leaving Settings does not orphan
  // the operation; a later `#settings/backup` mount can attach to the same
  // promise and resume polling without asking for the recovery key again.
  type ActiveArchiveExport = {
    readonly start: Promise<{ job_id: string }>;
    jobId: string | null;
    terminalStatus: Awaited<
      ReturnType<NonNullable<typeof archiveStatusCaller>>
    > | null;
    readonly release: ServerSwitchWorkLease;
  };
  let activeArchiveExport: ActiveArchiveExport | null = null;
  const settleActiveArchiveExport = (jobId?: string): void => {
    if (
      activeArchiveExport === null
      || (jobId !== undefined
        && activeArchiveExport.jobId !== null
        && activeArchiveExport.jobId !== jobId)
    ) return;
    activeArchiveExport.release();
    activeArchiveExport = null;
  };
  const continuousArchiveExportCaller = archiveExportCaller === undefined
    ? undefined
    : (args: Parameters<NonNullable<typeof archiveExportCaller>>[0]) => {
        if (activeArchiveExport !== null) {
          return Promise.reject(new Error(
            'A backup is already running. Return to Backup & Recovery to check it.',
          ));
        }
        const release = switchWorkTracker.begin({
          id: 'settings:archive-export',
          label: 'Creating a full backup',
          returnHref: serializeShellRoute('settings', 'backup'),
          returnLabel: 'View backup progress',
        });
        const start = Promise.resolve().then(() => archiveExportCaller(args));
        const entry: ActiveArchiveExport = {
          start,
          jobId: null,
          terminalStatus: null,
          release,
        };
        activeArchiveExport = entry;
        void start.then(
          ({ job_id }) => {
            if (activeArchiveExport !== entry) return;
            entry.jobId = job_id;
            release.update({ jobId: job_id });
          },
          () => {
            if (activeArchiveExport !== entry) return;
            release.update({
              label: 'Backup could not start — view details',
              returnLabel: 'View backup details',
              phase: 'result_ready',
            });
          },
        );
        return start;
      };
  const continuousArchiveStatusCaller = archiveStatusCaller === undefined
    ? undefined
    : async (args: Parameters<NonNullable<typeof archiveStatusCaller>>[0]) => {
        const entry = activeArchiveExport;
        if (
          entry !== null
          && entry.terminalStatus !== null
          && (entry.jobId === null || entry.jobId === args.job_id)
        ) {
          return entry.terminalStatus;
        }
        let status: Awaited<ReturnType<NonNullable<typeof archiveStatusCaller>>>;
        try {
          status = await archiveStatusCaller(args);
        } catch (error) {
          if (
            activeArchiveExport !== null
            && (activeArchiveExport.jobId === null
              || activeArchiveExport.jobId === args.job_id)
          ) {
            activeArchiveExport.release.update({
              label: 'Backup status needs attention',
              returnLabel: 'Check backup status',
            });
          }
          throw error;
        }
        if (
          (status.state === 'done' || status.state === 'error')
          && activeArchiveExport !== null
          && (activeArchiveExport.jobId === null
            || activeArchiveExport.jobId === args.job_id)
        ) {
          activeArchiveExport.terminalStatus = status;
          activeArchiveExport.release.update({
            label: status.state === 'done'
              ? 'Backup ready to review'
              : 'Backup finished with an error',
            returnLabel: status.state === 'done'
              ? 'View backup result'
              : 'View backup details',
            phase: 'result_ready',
          });
        }
        return status;
      };

  // M5 S2b — stash the rebind a committing restore returns so the post-restart
  // reconnect re-pairs seamlessly (the swap wiped this driving client's bearer
  // row; the server minted a fresh one into the restored db + returned it).
  // See `createArchiveRebindStash` for the envelope-match + best-effort detail.
  const archiveRebindStash = archiveBackupOff
    ? undefined
    : createArchiveRebindStash({
        localStore: options.localStore,
        tokenStore: options.tokenStore,
      });

  // R26.4 M1 — `passport.export` caller for the unified surface's lightweight
  // "Export identity passport only" action (support / audit JSON). Default ON;
  // `enablePassportPanel: false` opts out. Auth-gated first-party WS call;
  // `passport.` is MCP-reserved so the catalog stays off AI agents. History +
  // paste-import are retired (the in-archive passport embed covers migration).
  const passportPanelOff = options.enablePassportPanel === false;
  const passportExportCaller = passportPanelOff
    ? undefined
    : (args: import('@recued/contracts').ServerPassportExportOptions) =>
        rpcConn.call('passport.export', args);

  // M4 — browser archive download. Opens a DEDICATED binary `/ws/download`
  // socket (mirrors `uploadConnectFactory`: pinned `server_url` rewritten to
  // `…/ws/download`, fresh bearer unwrapped per open, `binaryType='arraybuffer'`),
  // streams the export, assembles a Blob, and triggers a save. Gated with the
  // archive callers; the protocol core (`createArchiveDownload`) is transport-
  // agnostic so only this glue is browser-specific. NOTE (v1): the Blob holds
  // the archive in browser-managed memory (may spill to disk) — a future File
  // System Access path could stream very large archives straight to disk.
  const archiveDownload = archiveBackupOff
    ? undefined
    : createArchiveDownload({
        openSocket: async () => {
          const serverUrl =
            (await options.localStore.get('server_url')) ?? pair.serverUrl;
          const record =
            (await options.localStore.get('webclient_token')) ?? pair.token;
          const plaintext = await options.tokenStore.unwrap(record, {
            ...aad,
            token_id: record.token_id,
          });
          const bearer = `${record.token_id}.${plaintext}`;
          const base = serverUrl.replace(/\/ws(?=$|\?)/, '/ws/download');
          const separator = base.includes('?') ? '&' : '?';
          // Bearer in the SUBPROTOCOL, not the URL — same carrier as the rpc
          // socket (`realtime/browser-transport.ts` DD#1). Fixing only that one
          // left FOUR data sockets still writing the secret into a URL; the
          // minified bundle is what showed it (`grep -c 'token=' → 9`).
          const url = base;
          const WsCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
          if (WsCtor === undefined) {
            throw new Error('download: globalThis.WebSocket unavailable');
          }
          const ws = new WsCtor(url, [
            WEBCLIENT_WS_SUBPROTOCOL,
            encodeBearerSubprotocol(bearer),
          ]);
          ws.binaryType = 'arraybuffer';
          await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => resolve());
            ws.addEventListener('error', () => reject(new Error('download ws failed to open')));
          });
          return {
            send: (text) => ws.send(text),
            close: () => ws.close(),
            onText: (cb) =>
              ws.addEventListener('message', (ev: MessageEvent) => {
                if (typeof ev.data === 'string') cb(ev.data);
              }),
            onBinary: (cb) =>
              ws.addEventListener('message', (ev: MessageEvent) => {
                if (ev.data instanceof ArrayBuffer) cb(ev.data);
              }),
            onClose: (cb) => ws.addEventListener('close', () => cb()),
            onError: (cb) => ws.addEventListener('error', () => cb()),
          };
        },
        saveBlob: (filename, parts) => {
          const urlApi = (globalThis as { URL?: typeof URL }).URL;
          const blobCtor = (globalThis as { Blob?: typeof Blob }).Blob;
          const docRef = (globalThis as { document?: Document }).document;
          if (!urlApi?.createObjectURL || !blobCtor || !docRef) {
            throw new Error('download: Blob / URL / document unavailable');
          }
          const href = urlApi.createObjectURL(
            new blobCtor(parts, { type: 'application/octet-stream' }),
          );
          const a = docRef.createElement('a');
          a.setAttribute('href', href);
          a.setAttribute('download', filename);
          a.click();
          urlApi.revokeObjectURL?.(href);
        },
        newReqId: () =>
          (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.() ??
          `dl-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
      });

  // M4b.2 — browser archive UPLOAD (the no-SSH migrate path). Opens a dedicated
  // binary `/ws/archive-upload` socket (mirrors `uploadConnectFactory` + the
  // download seam: pinned `…/ws` rewritten, fresh bearer unwrapped per open,
  // `binaryType='arraybuffer'`), chunks the chosen `.recued.archive` over the
  // SHARED resumable upload engine + transport, and stages it server-side; the
  // returned `staged_name` feeds the existing restore import. Gated with the
  // archive callers; the protocol core (`createArchiveUpload`) is transport-
  // agnostic so only this connect glue is browser-specific.
  const archiveUpload = archiveBackupOff
    ? undefined
    : createArchiveUpload({
        connect: async () => {
          const serverUrl =
            (await options.localStore.get('server_url')) ?? pair.serverUrl;
          const record =
            (await options.localStore.get('webclient_token')) ?? pair.token;
          const plaintext = await options.tokenStore.unwrap(record, {
            ...aad,
            token_id: record.token_id,
          });
          const bearer = `${record.token_id}.${plaintext}`;
          const base = serverUrl.replace(/\/ws(?=$|\?)/, '/ws/archive-upload');
          const separator = base.includes('?') ? '&' : '?';
          // Bearer in the SUBPROTOCOL, not the URL — same carrier as the rpc
          // socket (`realtime/browser-transport.ts` DD#1). Fixing only that one
          // left FOUR data sockets still writing the secret into a URL; the
          // minified bundle is what showed it (`grep -c 'token=' → 9`).
          const url = base;
          const WsCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
          if (WsCtor === undefined) {
            throw new Error('archive-upload: globalThis.WebSocket unavailable');
          }
          const ws = new WsCtor(url, [
            WEBCLIENT_WS_SUBPROTOCOL,
            encodeBearerSubprotocol(bearer),
          ]);
          ws.binaryType = 'arraybuffer';
          await new Promise<void>((resolve, reject) => {
            ws.addEventListener('open', () => resolve());
            ws.addEventListener('error', () =>
              reject(new Error('archive-upload ws failed to open')),
            );
          });
          return ws as unknown as Upload.UploadSocket;
        },
        callers: {
          create: (args) => rpcConn.call('server.archive.upload.create', args),
          probe: (args) => rpcConn.call('server.archive.upload.probe', args),
          finalize: (args) =>
            rpcConn.call('server.archive.upload.finalize', args),
          delete: (args) => rpcConn.call('server.archive.upload.delete', args),
        },
      });

  // R26.4 Delta 3 — `key.health` + `key.rotate` callers for the Server →
  // Key Health page. Default ON; `enableKeyHealthPanel: false` opts out
  // (same discipline as `enableTlsRenewPanel`). Auth-gated first-party WS
  // calls; `key.` is MCP-reserved so the catalog stays off AI agents.
  // `key.rotate` of `server_identity_rotate` revokes this client's bearer
  // — the panel handles the resulting WS drop as a commit (see its
  // header).
  const keyHealthPanelOff = options.enableKeyHealthPanel === false;
  const keyHealthLoader = keyHealthPanelOff
    ? undefined
    : () => rpcConn.call('key.health', undefined);
  const keyRotateCaller = keyHealthPanelOff
    ? undefined
    : (req: import('@recued/contracts').KeyRotateRequest) =>
        rpcConn.call('key.rotate', req);
  // D-212 §7.10 — the webclient's first `system.status` consumer: the Key
  // Health page's keyfile-posture card. The rpc is `system.`-prefixed, i.e.
  // MCP-reserved (host telemetry stays off AI agents) and paired-client
  // only, same posture as `key.health` beside it. The seam hands the panel
  // the status object; the rpc envelope (`{ status }`) is unwrapped here so
  // the panel never learns the wire shape.
  //
  // Gated with the Key Health page because that page is where it renders —
  // opting out of the page must not leave a live status read with nothing
  // to draw.
  const systemStatusLoader = keyHealthPanelOff
    ? undefined
    : async () => (await rpcConn.call('system.status', undefined)).status;

  // D-156 P5 — Devices roster + revoke callers. The bootstrap default
  // stays OFF (opt-in-for-tests discipline), but the production boot
  // path passes `enableDevicesPage: true`. The original OFF rationale —
  // the server-side `pair.list` / `pair.revoke` handlers gated on
  // `client.user_id`, which the bearer-only webclient never populated
  // (no `register` rpc), so the roster came back empty + revoke 401'd —
  // is closed by the self-host owner identity fix (`057df5e6`):
  // `/auth/pair` seeds `SELF_HOST_OWNER_ID` and the gate resolves a
  // verified bearer to it, so the webclient enumerates + revokes
  // itself. Tests + the P7 acceptance harness opt in explicitly via
  // `enableDevicesPage: true`.
  const pairListCaller =
    options.enableDevicesPage === true
      ? () => rpcConn.call('pair.list', undefined)
      : undefined;
  const pairRevokeCaller =
    options.enableDevicesPage === true
      ? (args: { instance_id: string }) => rpcConn.call('pair.revoke', args)
      : undefined;

  // D-163 Slice C — Notifications describe + set_channel callers.
  // Default ON; tests pass `enableNotificationsPanel: false` when they
  // do not exercise the section (same discipline as
  // `enableTlsRenewPanel`). The handlers are gated on the
  // server having a composed notification block — a webclient running
  // against a pre-Slice-C server surfaces `not_configured` inside the
  // panel's list-error chip, not a hard route crash.
  const notificationsDescribeCaller: NotificationsDescribeCaller | undefined =
    options.enableNotificationsPanel === false
      ? undefined
      : () => rpcConn.call('notifications.describe', undefined);
  const notificationsSetChannelCaller: NotificationsSetChannelCaller | undefined =
    options.enableNotificationsPanel === false
      ? undefined
      : (args) => rpcConn.call('notifications.set_channel', args);
  // D-169 P1 Codex Angle 4 fold — per-bridge sub-row callers. Wired
  // alongside the channel-level toggles so Settings → Notifications
  // renders one row per paired bridge with notification + approval
  // mode toggles (spec § A.6). Same `enableNotificationsPanel` gate +
  // server-not-configured-friendly surface as the channel callers.
  const notificationsDescribeBridgesCaller:
    | NotificationsDescribeBridgesCaller
    | undefined =
    options.enableNotificationsPanel === false
      ? undefined
      : () => rpcConn.call('notifications.describe_bridges', undefined);
  const notificationsSetBridgeModeCaller:
    | NotificationsSetBridgeModeCaller
    | undefined =
    options.enableNotificationsPanel === false
      ? undefined
      : (args) => rpcConn.call('notifications.set_bridge_mode', args);
  // R31 — anti-phishing verification-phrase caller (panel-level setting).
  // Same `enableNotificationsPanel` gate; the rpc already existed
  // (D-158 P2b-ii) but had no client caller until R31 surfaced the field.
  const notificationsSetVerificationPhraseCaller:
    | NotificationsSetVerificationPhraseCaller
    | undefined =
    options.enableNotificationsPanel === false
      ? undefined
      : (args) => rpcConn.call('notifications.set_verification_phrase', args);

  // D-145 PA10 follow-on — Packs list + install callers. Default ON;
  // tests opt out via `enablePacksPanel: false` when they do not
  // exercise the section (same discipline as
  // `enableTlsRenewPanel`). The handlers gate on the per-
  // pair `RecipeStore` being composed — a db-less harness running the
  // bootstrap with `enablePacksPanel: true` will surface
  // `not_configured` inside the panel's list-error chip, not a hard
  // route crash. Per-pair-only by `packs.` in
  // `MCP_RESERVED_RPC_PREFIXES`; webclient bearer auth path is
  // sufficient (no `client.user_id` gate).
  const packsListCaller: PacksListCaller | undefined =
    options.enablePacksPanel === false
      ? undefined
      : () => rpcConn.call('packs.list', undefined);
  const packsInstallCaller: PacksInstallCaller | undefined =
    options.enablePacksPanel === false
      ? undefined
      : (args) => rpcConn.call('packs.install', args);
  // D-145 PA10 follow-on Slice B — Packs uninstall caller. Same
  // `enablePacksPanel` gate as the list + install callers; tests that
  // exercise the read-only or read-only-plus-install surface pass
  // `enablePacksPanel: false` (suppresses all three) OR omit Delete by
  // stubbing the caller pre-mount via a custom panel-wiring fork. The
  // panel hides the Delete button on rows when the caller is absent,
  // so the production default of ON is the safer surface.
  const packsUninstallCaller: PacksUninstallCaller | undefined =
    options.enablePacksPanel === false
      ? undefined
      : (args) => rpcConn.call('packs.uninstall', args);
  // Add-a-pack (2026-07-01) — install-by-slug + resolve (manifest preview)
  // callers for the "Add a pack" section. Same `enablePacksPanel` gate.
  const packsInstallBySlugCaller: PacksInstallBySlugCaller | undefined =
    options.enablePacksPanel === false
      ? undefined
      : (args) => rpcConn.call('packs.installBySlug', args);
  // The resolve caller parses the typed input (slug vs URL) HERE — the panel
  // stays parse-free + the webclient never imports @recued/marketplace. A
  // marketplace slug (or a recued.com/packs/… URL) → `packs.resolveBySlug`; an
  // arbitrary URL is the (deferred) local-import path → surfaced as a failure so
  // the dialog explains it rather than silently trying an unsupported fetch.
  // D-247 D15 — the install dialog's recipe disclosure + grant-picker tier. The
  // SERVER resolves it (a manifest carries recipe refs, not bodies). Same
  // `enablePacksPanel` gate as the other packs callers; the panel treats a
  // rejection as "no preview", so a server predating D-247 needs no gate here.
  const packsInstallPreviewCaller: PacksInstallPreviewCaller | undefined =
    options.enablePacksPanel === false
      ? undefined
      : (args) => rpcConn.call('packs.install_preview', args);
  const packsResolveCaller: PacksResolveCaller | undefined =
    options.enablePacksPanel === false
      ? undefined
      : (input) => {
          const parsed = resolvePackInput(input);
          if (parsed === null) {
            return Promise.resolve({
              manifest: null,
              failure: { code: 'unresolved', message: 'Enter a marketplace pack slug or URL.' },
            });
          }
          if ('url' in parsed) {
            return Promise.resolve({
              manifest: null,
              failure: {
                code: 'unresolved',
                message:
                  'Importing a pack from an arbitrary URL is not supported yet — paste a marketplace slug or a recued.com/packs/… link.',
              },
            });
          }
          return rpcConn.call('packs.resolveBySlug', { slug: parsed.slug });
        };
  // Supervision feature (Slice 4) — the pack-detail daemon controls' callers.
  // Same `enablePacksPanel` gate as the packs callers; owner-only via
  // `supervision.` in `MCP_RESERVED_RPC_PREFIXES`.
  const supervisionListCaller: SupervisionListCaller | undefined =
    options.enablePacksPanel === false
      ? undefined
      : () => rpcConn.call('supervision.list', undefined);
  const supervisionSetCaller: SupervisionSetCaller | undefined =
    options.enablePacksPanel === false
      ? undefined
      : (args) => rpcConn.call('supervision.set', args);
  // D-174 P4 — Recipes route callers. `recipe.list` is the installed-library
  // inventory; the run modal uses the existing top-level `execute` RPC
  // (there is no separate `recipe.execute` registry key today).
  const recipesListCaller: RecipesListCaller = () =>
    rpcConn.call('recipe.list', undefined);
  // Discover (#recipes → Discovery tab) — install a standalone marketplace
  // recipe by slug. A standalone recipe carries no pack `requires[]`, so there's
  // no consent gate: one trusted server call fetches + validates + saves it.
  const recipeInstallBySlugCaller = (slug: string) =>
    rpcConn.call('recipe.installBySlug', { slug });
  // R2 build step 4 webclient consumer — derived recipe runnability read.
  // Soft in the route: a failure (`not_configured` on dbless boots) just
  // means no per-recipe runnability pills render.
  const recipesRunnabilityCaller: RecipesRunnabilityCaller = () =>
    rpcConn.call('recipe.runnability', undefined);
  // § 7 surfacing slice — per-recipe PII posture read. Soft like
  // runnability: a failure just means no PII lines render.
  const recipesPiiCaller: RecipesPiiCaller = () =>
    rpcConn.call('recipe.pii', undefined);
  const recipeExecuteCaller: RecipeExecuteCaller = (args) =>
    rpcConn.call('execute', buildRecipeExecuteArgs(args));

  // D-210 Appendix B — build the absolute manage URL from the paired WS server.
  // The RPC intentionally returns a path: a WS call has no request Host, while
  // this client knows the actual LAN/DDNS origin through which it is connected.
  const receptionHttpBaseFromWsUrl = (wsUrl: string): string => {
    const url = new URL(wsUrl);
    const protocol = url.protocol === 'wss:'
      ? 'https:'
      : url.protocol === 'ws:' ? 'http:' : url.protocol;
    return `${protocol}//${url.host}`;
  };
  const manageRescheduleLinkCaller: DataManageRescheduleLinkCaller =
    switchWorkTracker.track(async (input) => {
      const result = await rpcConn.call('reception.manage.mint', input);
      const serverUrl = (await options.localStore.get('server_url')) ?? pair.serverUrl;
      return {
        url: `${receptionHttpBaseFromWsUrl(serverUrl)}${result.manage_path}`,
        expires_at: result.expires_at,
      };
    });

  // D-174 P5 — Data route callers. These are local-UI pair RPCs only:
  // editable own-it rows use contact.* + work_entity.*, while mirror
  // collections drill down through data.timeline().
  const dataWorkEntitySourceListCaller: WorkEntitySourceListCaller = () =>
    rpcConn.call('work_entity.source.list', undefined);
  const dataWorkEntityListCaller: DataWorkEntityListCaller = (args) =>
    rpcConn.call('work_entity.list', args);
  const dataWorkEntityGetCaller: DataWorkEntityGetCaller = (args) =>
    rpcConn.call('work_entity.get', args);
  const dataWorkEntityUpsertCaller: DataWorkEntityUpsertCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('work_entity.upsert', input),
    )(args);
  const dataWorkEntityDeleteCaller: DataWorkEntityDeleteCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('work_entity.delete', input),
    )(args);
  const dataContactListCaller: DataContactListCaller = (args) =>
    rpcConn.call('contact.list', args);
  const dataContactGetCaller: DataContactGetCaller = (args) =>
    rpcConn.call('contact.get', args);
  // D-205 merge-review item 3 — what every OTHER source says about each field. The
  // projection keeps one value; this is the rest of the evidence behind it.
  const dataContactContributionsCaller: DataContactContributionsCaller = (args) =>
    rpcConn.call('contact.contributions', args);
  const dataContactUpsertCaller: DataContactUpsertCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('contact.upsert', input),
    )(args);
  const dataContactDeleteCaller: DataContactDeleteCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('contact.delete', input),
    )(args);
  // D-205 #2b — `#data/contact/scan`. These four rpcs shipped with D-138 and
  // have had NO caller until now; `contact.merge.*` is in the MCP reserved-prefix
  // set, so a merge decision is user-authoritative by construction and this is
  // the only surface that can author one.
  const dataContactMergeListCaller: DataContactMergeListCaller = (args) =>
    rpcConn.call('contact.merge.list', args);
  const dataContactMergeConfirmCaller: DataContactMergeConfirmCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('contact.merge.confirm', input),
    )(args);
  const dataContactMergeRejectCaller: DataContactMergeRejectCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('contact.merge.reject', input),
    )(args);
  const dataContactMergeScanNowCaller: DataContactMergeScanNowCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('contact.merge.scan_now', input),
    )(args);
  // D-205 #2c — the Sources health strip. The first reader of the contact runner's
  // per-cycle counters, which have been persisted and unread since D-205 #1.
  const dataContactSourceListCaller: DataContactSourceListCaller = () =>
    rpcConn.call('contact.source.list', undefined);
  // D-205 #5b — selective CRM promotion (`#data/contact/import`). The cold-start
  // escape hatch: a CRM is `hydrate_on_match`, so on an empty graph it mints ZERO
  // contacts and `#data/contact` sits empty after you connected ten thousand records.
  const dataContactImportCandidatesCaller: DataContactImportCandidatesCaller = (args) =>
    rpcConn.call('contact.import.candidates', args);
  const dataContactImportPromoteCaller: DataContactImportPromoteCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('contact.import.promote', input),
    )(args);
  // D-205 #5c — the manual vCard / CSV import. A BATCH `contact.upsert`, not a Source:
  // everything it writes lands at the `manual` rung, and the review shows only the
  // CONFLICTS — the adds have nothing to overwrite.
  const dataContactImportFilePreviewCaller: DataContactImportFilePreviewCaller = (args) =>
    rpcConn.call('contact.import.file_preview', args);
  const dataContactImportFileApplyCaller: DataContactImportFileApplyCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('contact.import.file_apply', input),
    )(args);
  const dataFormResponseListCaller: DataFormResponseListCaller = (args) =>
    rpcConn.call('form_response.list', args);
  const dataFormResponseGetCaller: DataFormResponseGetCaller = (args) =>
    rpcConn.call('form_response.get', args);
  const dataFormResponseUpdateCaller: DataFormResponseUpdateCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('form_response.update', input),
    )(args);
  const dataFormResponseSetStateCaller: DataFormResponseSetStateCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('form_response.set_state', input),
    )(args);
  const dataFormResponseExportCaller: DataFormResponseExportCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('form_response.export', input),
    )(args);
  // Wire the §D.L2 drawer "Create" action seat (its shell thunk resolves here)
  // to the shared Create overlay — the same 4-kind capture the L1 composer
  // [✎ Create] button opens, with the same local-write callers as Data. Track
  // the handle so it survives one-at-a-time (a re-click is a no-op while open)
  // and so bootstrap `dispose()` can tear it down (it portals to body).
  createSeatHandler = () => {
    if (drawerCreateOverlay !== null) return;
    drawerCreateOverlay = openCreateOverlay({
      document: doc,
      contactUpsertCaller: dataContactUpsertCaller,
      workEntityUpsertCaller: dataWorkEntityUpsertCaller,
      onClose: () => {
        drawerCreateOverlay = null;
      },
    });
  };
  const dataTimelineCaller: DataTimelineCaller = (args) =>
    rpcConn.call('data.timeline', args);
  const dataMirrorSearchCaller: DataMirrorSearchCaller = (args) =>
    rpcConn.call('data.mirror.search', args);
  const fileRefSearchCaller = async (query: string) => {
    const { results } = await dataMirrorSearchCaller({
      kind: 'files',
      query,
      limit: 20,
    });
    return fileRefOptionsFromMirrorResults(results);
  };
  /** D-221 record picker — one pack entity's rows as pickable options.
   *
   *  ⚠ `records.search` filters by FIELD, not by free text, and which field
   *  holds the human name differs per entity. So a page is fetched and matched
   *  in memory — which is what `RefPicker` is built for ("a server-backed
   *  inventory and an in-memory one share one shape"). It is honest for the
   *  sizes a picker is usable at and does NOT pretend to search the whole book:
   *  beyond a page the owner narrows by typing against what was fetched.
   *
   *  The label is a best guess (`name` / `label` / `title`, else the first
   *  string field, else the id) and the id is ALWAYS the sublabel — so a wrong
   *  guess is cosmetic and the owner can still tell two rows apart. Nothing
   *  here gates anything: the op's own binding still admits or refuses the
   *  write.
   */
  // The `record_ref` picker's inventory read — extracted to `record-ref-search.ts`
  // so the capped-page disclosure is reachable by a test. See its header.
  const recordRefSearchCaller = createRecordRefSearchCaller({
    search: (args) => rpcConn.call('records.search', args) as Promise<
      { records?: Array<Record<string, unknown>> }>,
  });

  // D-198 Slice 1b — the Memory lens feed read (owner-trusted whole-feed `memory.list`).
  const dataMemoryListCaller: DataMemoryListCaller = (args) =>
    rpcConn.call('memory.list', args);
  // D-198 Slice 2 — owner memory CRUD (`memory.get/create/update/delete`).
  const dataMemoryGetCaller: DataMemoryGetCaller = (args) =>
    rpcConn.call('memory.get', args);
  const dataMemoryCreateCaller: DataMemoryCreateCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('memory.create', input),
    )(args);
  const dataMemoryUpdateCaller: DataMemoryUpdateCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('memory.update', input),
    )(args);
  const dataMemoryDeleteCaller: DataMemoryDeleteCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('memory.delete', input),
    )(args);
  const dataMemoryImportCaller: DataMemoryImportCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('memory.import', input),
    )(args);
  // D-198 Slice 5 — the generic collection explorer reads (schema-driven
  // list→detail over the adapter-backed collections; mail / calendar tabs).
  const dataCollectionListInstancesCaller: DataCollectionListInstancesCaller = () =>
    rpcConn.call('collection.listInstances', {});
  const dataCollectionListCaller: DataCollectionListCaller = (args) =>
    rpcConn.call('collection.list', args);
  const dataCollectionGetCaller: DataCollectionGetCaller = (args) =>
    rpcConn.call('collection.get', args);
  // D-198 Phase 2 — the "Provenance" cluster reads: annotation / link whole-
  // collection browse (empty filter = whole table).
  const dataAnnotationListCaller: DataAnnotationListCaller = () =>
    rpcConn.call('annotation.list', {});
  const dataLinkListCaller: DataLinkListCaller = () =>
    rpcConn.call('link.list', {});
  // D-198 Phase 3 — the durable shared KV browse (`data.shared.` prefix = the
  // durable SQLite tier; `shared.` alone would hit the ephemeral cache tier).
  const dataSharedListCaller: DataSharedListCaller = () =>
    rpcConn.call('shared.list', { prefix: 'data.shared.' });
  // D-221 — owner-pair Records explorer. This deliberately uses only the
  // MCP-reserved `records.*` control plane; recipes use stamped Tier-P ops and
  // never acquire a `data.records.*` resolver.
  const dataRecordsNamespaceListCaller: DataRecordsNamespaceListCaller = () =>
    rpcConn.call('records.namespace.list', undefined);
  const dataRecordsKindListCaller: DataRecordsKindListCaller = (args) =>
    rpcConn.call('records.kind.list', args);
  const dataRecordsSearchCaller: DataRecordsSearchCaller = (args) =>
    rpcConn.call('records.search', args);
  const dataRecordsGetCaller: DataRecordsGetCaller = (args) =>
    rpcConn.call('records.get', args);
  const dataRecordsDeleteCaller: DataRecordsDeleteCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('records.delete', input),
    )(args);
  const dataRecordsRetentionListCaller: DataRecordsRetentionListCaller = (args) =>
    rpcConn.call('records.retention.list', args);
  const dataRecordsExportCaller: DataRecordsExportCaller = (args) =>
    rpcConn.call('records.export', args);
  const dataRecordsOutboxListCaller: DataRecordsOutboxListCaller = (args) =>
    rpcConn.call('records.outbox.list', args);
  const dataRecordsOutboxRetireCaller: DataRecordsOutboxRetireCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('records.outbox.retire', input),
    )(args);
  const dataRecordsPurgeCaller: DataRecordsPurgeCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('records.purge', input),
    )(args);
  // D-172 Half-A "open" — owner file-content read for the Files-tab download.
  // Owner-trusted `data.file.read` pair-RPC (bearer-gated WS = the auth), not
  // the contract/egress-gated op path.
  const dataFileReadCaller: DataFileReadCaller = (args) =>
    rpcConn.call('data.file.read', args);
  // D-172 — Data → File upload. The four control-plane callers ride the typed
  // rpc registry; the chunk BYTES ride a DEDICATED binary `/ws/upload` socket
  // the host opens via this factory (ui-shared can't reach the token store).
  const dataUploadCreateCaller: DataUploadCreateCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('upload.create', input),
    )(args);
  const dataUploadProbeCaller: DataUploadProbeCaller = (args) =>
    rpcConn.call('upload.probe', args);
  const dataUploadFinalizeCaller: DataUploadFinalizeCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('upload.finalize', input),
    )(args);
  const dataUploadDeleteCaller: DataUploadDeleteCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('upload.delete', input),
    )(args);
  // Open an authenticated binary upload socket. Mirrors `resolveBearer`
  // (DD#2 — unwrap fresh, never cache plaintext) + `buildDefaultConnectUrl`,
  // but rewrites the pinned `…/ws` path to `…/ws/upload` and pins
  // `binaryType='arraybuffer'` (the chunk frames are binary; acks are text
  // frames ON the same socket). The scheme (ws/wss) is baked into the stored
  // `server_url` — never derived from `location.protocol`.
  const uploadConnectFactory: Upload.UploadConnectFactory = async () => {
    const serverUrl =
      (await options.localStore.get('server_url')) ?? pair.serverUrl;
    const record =
      (await options.localStore.get('webclient_token')) ?? pair.token;
    const plaintext = await options.tokenStore.unwrap(record, {
      ...aad,
      token_id: record.token_id,
    });
    const bearer = `${record.token_id}.${plaintext}`;
    const base = serverUrl.replace(/\/ws(?=$|\?)/, '/ws/upload');
    const separator = base.includes('?') ? '&' : '?';
    // Bearer in the SUBPROTOCOL, not the URL — same carrier as the rpc
    // socket (`realtime/browser-transport.ts` DD#1). Fixing only that one
    // left FOUR data sockets still writing the secret into a URL; the
    // minified bundle is what showed it (`grep -c 'token=' → 9`).
    const url = base;
    const WsCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (WsCtor === undefined) {
      throw new Error('upload: globalThis.WebSocket unavailable');
    }
    const ws = new WsCtor(url, [
      WEBCLIENT_WS_SUBPROTOCOL,
      encodeBearerSubprotocol(bearer),
    ]);
    ws.binaryType = 'arraybuffer';
    return new Promise<Upload.UploadSocket>((resolve, reject) => {
      ws.addEventListener('open', () =>
        resolve(ws as unknown as Upload.UploadSocket),
      );
      ws.addEventListener('error', () =>
        reject(new Error('upload ws failed to open')),
      );
    });
  };
  const runsListCaller: RunsListCaller = (args) =>
    rpcConn.call('execution.list', args);
  const runsGetCaller: RunsGetCaller = (args) =>
    rpcConn.call('execution.get', args);
  // D-181 slice 5b — the Runs "Active" section live-control seam.
  const runsActiveCaller: RunsActiveCaller = (args) =>
    rpcConn.call('execution.active', args);
  const runsKillCaller: RunsKillCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('execution.kill', input),
      {
        label: 'Stopping an active run',
        returnHref: serializeShellRoute('logs', 'active'),
        returnLabel: 'View active runs',
      },
    )(args);
  const runsCancelCaller: RunsCancelCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('execution.cancel', input),
      {
        label: 'Cancelling an active run',
        returnHref: serializeShellRoute('logs', 'active'),
        returnLabel: 'View active runs',
      },
    )(args);
  const runsPromoteCaller: RunsPromoteCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) => rpcConn.call('execution.promote', input),
      {
        label: 'Promoting an active run',
        returnHref: serializeShellRoute('logs', 'active'),
        returnLabel: 'View active runs',
      },
    )(args);
  // D-186 Slice C — the Runs "Active passes" (session-grant) live-control seam.
  const runsGrantsListCaller: RunsSessionGrantListCaller = (args) =>
    rpcConn.call('collection.contract.session_grant.list', args);
  const runsGrantsRevokeCaller: RunsSessionGrantRevokeCaller = (args) =>
    switchWorkTracker.track(
      (input: typeof args) =>
        rpcConn.call('collection.contract.session_grant.revoke', input),
      {
        label: 'Revoking an active pass',
        returnHref: serializeShellRoute('logs', 'active'),
        returnLabel: 'View active runs',
      },
    )(args);

  // Reactive-substrate slice 1 — Automation route callers. The four
  // mechanism families (schedules / event-triggers / watches / auto-run)
  // each degrade independently inside the route
  // when the server side surfaces `not_configured`.
  const automationSchedulesListCaller: AutomationSchedulesListCaller = () =>
    rpcConn.call('schedules.list', {});
  const automationSchedulesUpdateCaller: AutomationSchedulesUpdateCaller = (args) =>
    rpcConn.call('schedules.update', args);
  const automationSchedulesDeleteCaller: AutomationSchedulesDeleteCaller = (args) =>
    rpcConn.call('schedules.delete', args);
  const automationTriggersListCaller: AutomationTriggersListCaller = () =>
    rpcConn.call('triggers.list', undefined);
  const automationTriggersUpdateCaller: AutomationTriggersUpdateCaller = (args) =>
    rpcConn.call('triggers.update', args);
  const automationTriggersDeleteCaller: AutomationTriggersDeleteCaller = (args) =>
    rpcConn.call('triggers.delete', args);
  const automationAutoRunListCaller: AutomationAutoRunListCaller = () =>
    rpcConn.call('auto_run.list', undefined);
  // D-215 slice 3 — the Dishes section's read. `last_runs` rides along on
  // the same response (one audit scan server-side), so the list needs no
  // second round-trip for its last-outcome column.
  const automationDishesListCaller: AutomationDishesListCaller = () =>
    rpcConn.call('dishes.list', {});
  // D-215 slice 4 — a user-assigned dish's own mutations. A MANAGED dish
  // never reaches these: the route routes a one-shot to `schedules.*` and
  // every other managed dish to a link, and the server-side guard refuses
  // them regardless (defence in depth, not belt-and-braces theatre).
  const automationDishesUpdateCaller: AutomationDishesUpdateCaller = (args) =>
    rpcConn.call('dishes.update', args);
  const automationDishesDeleteCaller: AutomationDishesDeleteCaller = (args) =>
    rpcConn.call('dishes.delete', args);
  const automationDishesCreateCaller: AutomationDishesCreateCaller = (args) =>
    rpcConn.call('dishes.create', args);
  const automationDishesHistoryCaller: AutomationDishesHistoryCaller = (args) =>
    rpcConn.call('dishes.history', args);
  const automationAutoRunUpdateCaller: AutomationAutoRunUpdateCaller = (args) =>
    rpcConn.call('auto_run.update', args);
  const automationWatchListCaller: AutomationWatchListCaller = () =>
    rpcConn.call('watch.list', undefined);
  const automationWatchUpdateCaller: AutomationWatchUpdateCaller = (args) =>
    rpcConn.call('watch.update', args);
  const automationWatchRunNowCaller: AutomationWatchRunNowCaller = (args) =>
    rpcConn.call('watch.run_now', args);
  // R21.1 — vault lock state for the "automation paused" banner.
  const automationAuthStateCaller: AutomationAuthStateCaller = () =>
    rpcConn.call('auth.state', undefined);
  // Soft recipe-name resolution — reuses `recipe.list`; failures inside a
  // route just mean raw recipe ids render. Shared by the Automation rules
  // view and the Runs Recipe-filter combobox (identical shape; the
  // `AutomationRecipeNamesCaller` annotation just pins it).
  const recipeNamesCaller: AutomationRecipeNamesCaller = async () => {
    const result = await rpcConn.call('recipe.list', undefined);
    return {
      recipes: result.recipes.map((r) => {
        const name = r.recipe.metadata?.name;
        return {
          recipe_id: r.recipe_id,
          ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
        };
      }),
    };
  };

  // D-174 — top-level Approvals deep queue callers. Default ON; tests
  // opt out via `enableApprovalsRoute: false`. The route
  // gates on approval + ask callers together. Missing backend
  // composition surfaces as route/panel error chips, not a hard crash.
  const approvalListCaller: ApprovalListCaller | undefined =
    options.enableApprovalsRoute === false
      ? undefined
      : () => rpcConn.call('approval.list', undefined);
  const approvalResolveCaller: ApprovalResolveCaller | undefined =
    options.enableApprovalsRoute === false
      ? undefined
      : (args) => switchWorkTracker.track(
          (input: typeof args) => rpcConn.call('approval.resolve', input),
          {
            label: 'Resolving an approval',
            returnHref: serializeShellRoute('approvals'),
            returnLabel: 'View approvals',
          },
        )(args);
  const approvalSubscribeCaller: ApprovalSubscribeCaller | undefined =
    options.enableApprovalsRoute === false
      ? undefined
      : () => rpcConn.call('approval.subscribe', undefined);
  const notificationAsksListCaller: AsksListCaller | undefined =
    options.enableApprovalsRoute === false
      ? undefined
      : () => rpcConn.call('notification.pending_asks', undefined);
  const notificationAsksSubmitAnswerCaller: AsksSubmitAnswerCaller | undefined =
    options.enableApprovalsRoute === false
      ? undefined
      : (args) => switchWorkTracker.track(
          (input: typeof args) =>
            rpcConn.call('notification.submitAnswer', input),
          {
            label: 'Sending an approval answer',
            returnHref: serializeShellRoute('approvals'),
            returnLabel: 'View approvals',
          },
        )(args);
  // Resolve a durable Chat plan from #approvals / the bell popover.
  // approve → chat.plan.approve, reject → chat.plan.cancel (wire verb
  // unchanged; only the label is "Reject"). Branched so each call carries a
  // concrete method type.
  const chatPlanResolveCaller =
    options.enableApprovalsRoute === false
      ? undefined
      : (args: { plan_id: string; decision: 'approve' | 'reject' }) =>
          switchWorkTracker.track(
            async (input: typeof args) => input.decision === 'approve'
              ? rpcConn.call('chat.plan.approve', { plan_id: input.plan_id })
              : rpcConn.call('chat.plan.cancel', { plan_id: input.plan_id }),
            {
              label: args.decision === 'approve'
                ? 'Approving a Chat action'
                : 'Rejecting a Chat action',
              returnHref: serializeShellRoute('approvals'),
              returnLabel: 'View approvals',
            },
          )(args);
  const chatPlanPendingListCaller =
    options.enableApprovalsRoute === false
      ? undefined
      : () => rpcConn.call('chat.plans.pending.list', undefined);

  // One authoritative read serves both the global Attention recovery
  // projection and the Apps & APIs route. Keeping one caller seam avoids a
  // parallel notification store or a second recovery RPC.
  let connectionListReadInFlight: Promise<
    Awaited<ReturnType<ConnectionsEnrollListCaller>>
  > | null = null;
  const connectionsEnrollListCaller: ConnectionsEnrollListCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : () => {
          if (connectionListReadInFlight !== null) {
            return connectionListReadInFlight;
          }
          const read = rpcConn.call(
            'collection.connection.list',
            undefined,
          );
          connectionListReadInFlight = read;
          const releaseTurnDedupe = (): void => {
            if (connectionListReadInFlight === read) {
              connectionListReadInFlight = null;
            }
          };
          // Coalesce shell + route reads started in this mount turn, but never
          // let a slow background Attention read hold a later route refresh.
          void Promise.resolve().then(releaseTurnDedupe);
          void read.then(releaseTurnDedupe, releaseTurnDedupe);
          return read;
        };

  // Route-independent durable Chat approval inbox. It subscribes before its
  // first all-session snapshot, replays racing events over that read, and
  // reconciles again on reconnect. Created once so both the bell and
  // #approvals share one truthful map across route swaps.
  // D-165 follow-on, RESTORED after R13 — the operation-group grant callers.
  // The rpc family never went away; only its consumer did. Gated on the same
  // flag as the enroll panel: the two are one lane, and a grant surface with no
  // enrol surface has nothing to grant against.
  // ⛔ REUSES the enroll panel's list caller rather than issuing its own
  // `{ kind: 'api' }` read (which is what the pre-R13 wiring did). That read
  // would bypass `connectionListReadInFlight`, the turn-dedupe that exists to
  // "coalesce shell + route reads started in this mount turn" — so mounting the
  // grant panel would double every Connections-route connection read.
  //
  // 🔑 Safe because the panel filters for itself: `isGrantCandidate`
  // (`connections-grant-panel.ts:216`) keeps only `kind === 'api'`. The server
  // filter was never load-bearing.
  const connectionsGrantListCaller: ConnectionsListCaller | undefined =
    connectionsEnrollListCaller as ConnectionsListCaller | undefined;
  const connectionsListGroupsCaller: ConnectionsListGroupsCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : ((args) => rpcConn.call('collection.connection.listOperationGroups', args)) as ConnectionsListGroupsCaller;
  const connectionsGrantGroupCaller: ConnectionsGrantGroupCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : ((args) => rpcConn.call('collection.connection.grantOperationGroup', args)) as ConnectionsGrantGroupCaller;
  const connectionsRevokeGroupCaller: ConnectionsRevokeGroupCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : ((args) => rpcConn.call('collection.connection.revokeOperationGroup', args)) as ConnectionsRevokeGroupCaller;

  const pendingChatPlansStore: PendingChatPlansStore | null =
    options.enableApprovalsRoute === false
      ? null
      : createPendingChatPlansStore({
          subscribe: subscriber.on,
          listPending: chatPlanPendingListCaller!,
          reconnect,
          ...(options.now !== undefined ? { now: options.now } : {}),
        });

  // D-174 / R6 - global approval attention popover. This is
  // route-independent chrome mounted at the webclient root, so it
  // survives hash route swaps and reuses the exact approval.* plus
  // notification.pending_asks callers as the #approvals deep queue.
  approvalAttentionPopover =
    approvalListCaller !== undefined
      && approvalResolveCaller !== undefined
      && approvalSubscribeCaller !== undefined
      && notificationAsksListCaller !== undefined
      && notificationAsksSubmitAnswerCaller !== undefined
      ? mountApprovalAttentionPopover({
          host: appShell.attentionHost,
          document: doc,
          runApprovalList: approvalListCaller,
          runApprovalResolve: approvalResolveCaller,
          runApprovalSubscribe: approvalSubscribeCaller,
          runPendingAsksList: notificationAsksListCaller,
          runPendingAskSubmitAnswer: notificationAsksSubmitAnswerCaller,
          onApprovalChanged,
          subscribe: subscriber.on,
          reconnect,
          ...(pendingChatPlansStore !== null
            ? { chatPlans: pendingChatPlansStore }
            : {}),
          ...(chatPlanResolveCaller !== undefined
            ? { runChatPlanResolve: chatPlanResolveCaller }
            : {}),
          ...(recoveryIntentContinuation !== null
            ? {
                initialRecoveryIntentContinuation:
                  recoveryIntentContinuation,
              }
            : {}),
          ...(recoveryIntentExpiryHandoff !== null
            ? {
                initialRecoveryIntentExpiryHandoff:
                  recoveryIntentExpiryHandoff,
              }
            : {}),
          onResumeRecoveryIntentContinuation: (continuation) =>
            resumeRecoveryIntentContinuation(continuation),
          onResolveRecoveryIntentReview: (continuation) =>
            resumeRecoveryIntentContinuation(continuation, 'review_resolved'),
          onKeepRecoveryIntentReviewBlocked: (continuation) =>
            keepRecoveryIntentReviewBlocked(continuation),
          onDeferRecoveryIntentVerification: (continuation) =>
            deferRecoveryIntentVerification(continuation),
          onReviewRecoveryIntentExpiryHandoff: (handoff) =>
            reviewRecoveryIntentExpiryHandoff(handoff),
          onDismissRecoveryIntentExpiryHandoff: () => {
            clearRecoveryIntentExpiryHandoff();
            recoveryIntentOrientation?.clear();
          },
          onReviewRecoveryIntentContinuation: (continuation) =>
            reviewRecoveryIntentContinuation(continuation),
          ...(accountMenu !== null
            ? {
                onRemediateRecoveryIntentConnection: (continuation) =>
                  remediateRecoveryIntentConnection(continuation),
                onReviewRecoveryIntentServer: (continuation) =>
                  reviewRecoveryIntentServer(continuation),
              }
            : {}),
          onDismissRecoveryIntentContinuation:
            retireRecoveryIntentContinuation,
          ...(connectionsEnrollListCaller !== undefined
            && bootProfileId !== null
            && bootProfileId.trim().length > 0
            && bootProfileId.length <= 256
            ? {
                runConnectionRecoveryList: connectionsEnrollListCaller,
                connectionRecoveryProfile: {
                  id: bootProfileId,
                  label: bootProfileLabel,
                },
                inactiveConnectionRecoveryHints,
                ...(accountMenu !== null && profileStore !== undefined
                  ? {
                      onReviewInactiveConnectionRecovery:
                        beginInactiveConnectionRecoveryReview,
                    }
                  : {}),
                ...(initialInactiveProfileRecoveryReview !== null
                  && (activeRecoveryExcursion === null
                    || activeRecoveryExcursion.phase !== 'return_ready')
                  ? {
                      initialConnectionRecoveryReview: {
                        serverProfileId:
                          initialInactiveProfileRecoveryReview.targetProfileId,
                      },
                    }
                  : {}),
                ...(recoveryExcursionReturn !== null
                  ? {
                      initialRecoveryExcursionReturn:
                        recoveryExcursionReturn,
                    }
                  : {}),
                onReviewRecoveryExcursionReturn:
                  beginRecoveryExcursionReturn,
                onDismissRecoveryExcursionReturn: () => {
                  if (activeRecoveryExcursion === null) return;
                  inactiveProfileRecoveryReview.retire(
                    activeRecoveryExcursion.targetProfileId,
                  );
                  activeRecoveryExcursion = null;
                  pendingRecoveryExcursionReturn = null;
                  recoveryExcursionReturn = null;
                },
                onConnectionRecoverySnapshot: (snapshot) => {
                  inactiveProfileRecoveryDiscovery.record({
                    profileId: snapshot.serverProfileId,
                    hasRecoveries: snapshot.hasRecoveries,
                    observedAt: snapshot.observedAt,
                  });
                  const next = asRecoveryExcursion(
                    inactiveProfileRecoveryReview.recordSnapshot(
                      snapshot.serverProfileId,
                      snapshot.hasRecoveries,
                    ),
                  );
                  if (next !== null) {
                    activeRecoveryExcursion = next;
                    if (knownServerProfiles.length > 0) {
                      refreshRecoveryExcursionReturn(knownServerProfiles);
                    }
                  }
                },
                onConnectionRecoveryReviewDismissed: (profileId) => {
                  inactiveProfileRecoveryReview.retire(profileId);
                  if (
                    activeRecoveryExcursion?.targetProfileId === profileId
                  ) {
                    activeRecoveryExcursion = null;
                    pendingRecoveryExcursionReturn = null;
                    recoveryExcursionReturn = null;
                    approvalAttentionPopover?.setRecoveryExcursionReturn(null);
                  }
                },
                connectionRecoveryHref:
                  serializeConnectionsPostSafeStopRecovery,
                subscribeConnectionRecovery: (listener: () => void) =>
                  credentialRotationTabConvergence?.subscribe((hint) => {
                    if (
                      hint.type === 'reconcile'
                      || hint.type === 'credential_rotation_safe_stop_resolved'
                      || hint.type === 'credential_rotated'
                    ) listener();
                  }) ?? (() => {}),
                ...(options.now !== undefined ? { now: options.now } : {}),
              }
            : {}),
        })
      : null;

  if (
    approvalAttentionPopover === null
    && recoveryIntentContinuationMarker !== null
  ) {
    // A continuation without its only discovery surface would be invisible
    // state. Retire it immediately instead of carrying an unusable reminder
    // until its timer or a later route interaction happens to clean it up.
    recoveryIntentLandingHash = null;
    retireRecoveryIntentContinuation();
  }

  // Shell-frame Step 2 — the live-control bubble (D-181 RUNNING + D-186
  // GRANTS), route-independent chrome mounted at the webclient root beside the
  // bell, so it survives hash route swaps and stays live off the `execution`
  // and `contract.contract_definition_changed` bus. Reuses the SAME
  // `execution.*` + `session_grant.*` callers the Runs route wires. The chat
  // route no longer renders its own running bubble (lifted here). Ambient: the
  // bubble is invisible until something is running / a pass is active.
  const liveControlBubble: LiveControlBubbleMount | null =
    options.enableLiveControlBubble === false
      ? null
      : mountLiveControlBubble({
          host: appShell.root,
          document: doc,
          activeCaller: runsActiveCaller,
          killCaller: runsKillCaller,
          cancelCaller: runsCancelCaller,
          promoteCaller: runsPromoteCaller,
          grantsListCaller: runsGrantsListCaller,
          grantsRevokeCaller: runsGrantsRevokeCaller,
          subscribe: subscriber.on,
          ...(options.now !== undefined ? { now: options.now } : {}),
        });

  // Connections ▸ foundational account lanes (Mail · Calendar · Files) — the
  // `collection.{mail,calendar,file}.*` enroll / list / lifecycle callers
  // behind the restructured Connections surface (treemap §6, R13–R16). Gated
  // on the same flag as the enrollment panel. The enroll args are the pure
  // `Record<string, unknown>` projections from the accounts schema; the cast
  // to the typed rpc request lands here at the one wire boundary. A pre-
  // substrate server surfaces the rpc unknown-method error inside the lane's
  // inline error, not a route crash. (The standalone per-connection
  // "Operation grants" matrix retired with R13.)
  const connectionsMailLane: MailLaneCallers | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : {
          list: () => rpcConn.call('collection.mail.list', undefined),
          enrollImap: (args) =>
            switchWorkTracker.track((input: typeof args) =>
              rpcConn.call(
                'collection.mail.enrollImap',
                input as RpcRequest<ServerRpcRegistry, 'collection.mail.enrollImap'>,
              ))(args),
          // Foundational OAuth owns one lease over save + consent + exchange;
          // wrapping this final RPC separately would expose a duplicate action.
          enrollOAuth: (args) => rpcConn.call(
            'collection.mail.enrollOAuth',
            args as RpcRequest<ServerRpcRegistry, 'collection.mail.enrollOAuth'>,
          ),
          delete: (args) => switchWorkTracker.track(
            (input: typeof args) => rpcConn.call('collection.mail.delete', input),
          )(args),
        };
  // Shared OAuth client-config caller — lane-agnostic (Mail + Calendar
  // sign-in). Forwarded INDEPENDENTLY of the per-lane enroll callers.
  const connectionsGetOAuthClientConfig =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : () => rpcConn.call('server.getOAuthClientConfig', undefined);
  // BYO OAuth-app config callers — the in-UI "Set up Google / Microsoft
  // sign-in" surface (store the operator's own OAuth app client_id + secret
  // instead of the RECUED_* env vars). Also lane-agnostic.
  const connectionsGetOAuthAppConfig =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : () => rpcConn.call('server.getOAuthAppConfig', undefined);
  const connectionsSetOAuthAppConfig =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args: RpcRequest<ServerRpcRegistry, 'server.setOAuthAppConfig'>) =>
          rpcConn.call('server.setOAuthAppConfig', args);
  const connectionsCalendarLane: CalendarLaneCallers | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : {
          list: () => rpcConn.call('collection.calendar.list', undefined),
          delete: (args) => switchWorkTracker.track(
            (input: typeof args) => rpcConn.call('collection.calendar.delete', input),
          )(args),
          resync: (args) => switchWorkTracker.track(
            (input: typeof args) => rpcConn.call('collection.calendar.resync', input),
          )(args),
          reauth: (args) => switchWorkTracker.track(
            (input: typeof args) => rpcConn.call('collection.calendar.reauth', input),
          )(args),
          enrollOAuth: (args) => rpcConn.call(
            'collection.calendar.enrollOAuth',
            args as RpcRequest<ServerRpcRegistry, 'collection.calendar.enrollOAuth'>,
          ),
          // Microsoft-only — adopt the `graph` grant the mail enroll just wrote,
          // so the "Also connect Calendar" opt-in needs no second consent.
          attachGraphGrant: (args) => rpcConn.call(
            'collection.calendar.attachGraphGrant',
            args as RpcRequest<ServerRpcRegistry, 'collection.calendar.attachGraphGrant'>,
          ),
          enrollBasic: (args) =>
            switchWorkTracker.track((input: typeof args) =>
              rpcConn.call(
                'collection.calendar.enrollBasic',
                input as RpcRequest<ServerRpcRegistry, 'collection.calendar.enrollBasic'>,
              ))(args),
        };
  const connectionsFileLane: FileLaneCallers | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : {
          list: () => rpcConn.call('collection.listInstances', { type: 'file' }),
          enroll: (args) =>
            switchWorkTracker.track((input: typeof args) =>
              rpcConn.call(
                'collection.file.enroll',
                input as RpcRequest<ServerRpcRegistry, 'collection.file.enroll'>,
              ))(args),
          delete: (args) => switchWorkTracker.track(
            (input: typeof args) => rpcConn.call('collection.file.delete', input),
          )(args),
          resync: (args) => switchWorkTracker.track(
            (input: typeof args) => rpcConn.call('collection.file.resync', input),
          )(args),
        };

  // D-165 P3.enroll-host — remaining Connections ENROLLMENT callers. Default
  // ON; tests opt out via `enableConnectionsEnrollPanel: false`. The shared,
  // unfiltered list caller lives above because persistent Attention consumes
  // the same read as this route.
  // Per-pair-only by `collection.connection.` being reserved from MCP; the
  // webclient bearer auth path is sufficient. A pre-enroll server surfaces the
  // rpc unknown-method error inside the page's inline error, not a route crash.
  const connectionsEnrollCaller: ConnectionsEnrollCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.enroll', args);
  const connectionsUpdateCaller: ConnectionsUpdateCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.update', args);
  const connectionsRotateCredentialsCaller: ConnectionsRotateCredentialsCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.rotateCredentials', args);
  const connectionsCredentialRotationStatusCaller:
    ConnectionsCredentialRotationStatusCaller | undefined =
      options.enableConnectionsEnrollPanel === false
        ? undefined
        : (args) => rpcConn.call(
            'collection.connection.credentialRotationStatus',
            args,
          );
  const connectionsCredentialRotationActivityCaller:
    ConnectionsCredentialRotationActivityCaller | undefined =
      options.enableConnectionsEnrollPanel === false
        ? undefined
        : (args) => rpcConn.call(
            'collection.connection.credentialRotationActivity',
            args,
          );
  const connectionsAcknowledgeCredentialRotationSafeStopCaller:
    ConnectionsAcknowledgeCredentialRotationSafeStopCaller | undefined =
      options.enableConnectionsEnrollPanel === false
        ? undefined
        : (args) => rpcConn.call(
            'collection.connection.acknowledgeCredentialRotationSafeStop',
            args,
          );

  let credentialRotationCapabilityCheck: {
    readonly key: string;
    readonly startedAt: number;
  } | null = null;
  let credentialRotationCapabilityCheckGeneration = 0;
  serverUpdateReceiptVerification =
    createServerUpdateReceiptVerification({
      readProgress: () => credentialRotationTabConvergence
        ?.readServerUpdateProgress() ?? null,
      isConnected: () => connectionStatus.status() === 'connected',
      verify: (operationId) => rpcConn.call('update.operation_status', {
        operation_id: operationId,
        include_closed: true,
      }),
      close: (operationId, expectedOperation) =>
        rpcConn.call('update.operation_close', {
          operation_id: operationId,
          expected_operation: expectedOperation,
        }),
      readCurrentState: async (progress) => {
        const readAffectedTarget = () => {
          const marker = credentialRotationServerUpdateContinuity.read();
          const markerProgress = marker?.serverUpdateProgress;
          return marker !== null
            && markerProgress?.phase === 'awaiting_reconnect'
            && sameServerUpdateLineage(markerProgress, progress)
            ? { kind: marker.kind, name: marker.name }
            : null;
        };
        const target = readAffectedTarget();
        const affectedConnection = target === null
          ? Promise.resolve(undefined)
          : connectionsCredentialRotationActivityCaller === undefined
            ? Promise.resolve({
                ...target,
                activity: 'unavailable' as const,
              })
            : connectionsCredentialRotationActivityCaller(target).then(
                ({ activity }) => ({
                  ...target,
                  activity: activity.status,
                }),
                () => ({
                  ...target,
                  activity: 'unavailable' as const,
                }),
              );
        const [release, affected] = await Promise.all([
          rpcConn.call('update.check', undefined),
          affectedConnection,
        ]);
        const latestTarget = readAffectedTarget();
        if (
          target === null
            ? latestTarget !== null
            : latestTarget === null
              || latestTarget.kind !== target.kind
              || latestTarget.name !== target.name
        ) {
          // A connection-specific continuation changed while the two fresh
          // reads were settling. Do not label either identity as the affected
          // current-state baseline; the explicit retry will read one coherent
          // target from this same selected server.
          throw new Error('affected connection changed during baseline read');
        }
        return {
          release,
          ...(affected === undefined
            ? {}
            : { affectedConnection: affected }),
        };
      },
      clearProgress: async (progress) =>
        await credentialRotationTabConvergence
          ?.clearServerUpdateProgress(progress) ?? false,
      ...(options.serverUpdateReceiptScheduleRetry !== undefined
        ? { scheduleRetry: options.serverUpdateReceiptScheduleRetry }
        : {}),
    });
  detachServerUpdateReceiptVerification =
    serverUpdateReceiptVerification.subscribe((state) => {
      credentialRotationServerUpdateContinuity
        .observeServerUpdateVerification(state);
    });
  const reconcileServerUpdateOutcome = (): void => {
    if (disposed) return;
    serverUpdateReceiptVerification?.reconcile();
  };
  const reconcileCredentialRotationServerCapability = (
    hint: CredentialRotationTabHint,
  ): void => {
    if (
      hint.type !== 'server_capability_resolved'
      && hint.type !== 'reconcile'
    ) return;
    if (connectionsCredentialRotationActivityCaller === undefined) return;
    const marker = credentialRotationServerUpdateContinuity.read();
    if (marker?.phase !== 'triage') return;
    if (
      marker.serverUpdateProgress !== undefined
      || (
        credentialRotationTabConvergence?.readServerUpdateProgress() ?? null
      ) !== null
    ) {
      // A focus pulse or reconnect can race the accepted restart. Do not ask
      // the old/in-transition server to settle the credential handoff, and do
      // not clear the server-global progress from that premature reply.
      return;
    }
    if (
      hint.type === 'server_capability_resolved'
      && (hint.kind !== marker.kind || hint.name !== marker.name)
    ) return;
    const target = { kind: marker.kind, name: marker.name };
    const key = `${target.kind}/${target.name}`;
    if (
      credentialRotationCapabilityCheck?.key === key
      && credentialRotationCapabilityCheck.startedAt === marker.startedAt
    ) return;
    const generation = ++credentialRotationCapabilityCheckGeneration;
    credentialRotationCapabilityCheck = {
      key,
      startedAt: marker.startedAt,
    };
    // Treat every channel/pulse/focus signal as advisory. Only a fresh reply
    // from this tab's currently paired server can replace durable triage.
    void connectionsCredentialRotationActivityCaller(target).then(async (result) => {
      if (generation !== credentialRotationCapabilityCheckGeneration) return;
      if (
        result.activity.status !== 'idle'
        && result.activity.status !== 'pending'
      ) return;
      const latest = credentialRotationServerUpdateContinuity.read();
      if (
        latest?.phase !== 'triage'
        || latest.kind !== target.kind
        || latest.name !== target.name
        || latest.startedAt !== marker.startedAt
      ) return;
      const resolved = credentialRotationServerUpdateContinuity
        .markCapabilityResolvedElsewhere(target);
      if (resolved) {
        const progress = credentialRotationTabConvergence
          ?.readServerUpdateProgress() ?? null;
        if (progress !== null) {
          await credentialRotationTabConvergence
            ?.clearServerUpdateProgress(progress);
        }
      }
    }).catch(() => {
      // Unknown/failed reads leave the durable diagnosis intact. A later
      // opaque pulse, focus, or visibility return may retry it safely.
    }).finally(() => {
      if (generation === credentialRotationCapabilityCheckGeneration) {
        credentialRotationCapabilityCheck = null;
      }
    });
  };
  detachCredentialRotationCapabilityResolution =
    credentialRotationTabConvergence?.subscribe((hint) => {
      if (hint.type === 'server_update_progress') {
        credentialRotationServerUpdateContinuity
          .observeServerUpdateProgress(hint.progress);
        reconcileServerUpdateOutcome();
        if (hint.progress === null) {
          serverUpdateReconnectProof = null;
          // The exact local action lineage is now settled. Only at this point
          // may the returned server authoritatively resolve the saved
          // credential-capability diagnosis.
          reconcileCredentialRotationServerCapability({ type: 'reconcile' });
          return;
        }
        if (hint.progress.phase === 'applying') {
          serverUpdateReconnectProof = null;
        } else if (
          hint.progress.operationId === undefined
          && !sameServerUpdateLineage(
            hint.progress,
            serverUpdateReconnectProof,
          )
        ) {
          serverUpdateReconnectProof =
            connectionStatus.status() !== 'connected'
              ? serverUpdateLineageOf(hint.progress)
              : null;
        }
        if (
          hint.progress.phase === 'awaiting_reconnect'
          && hint.progress.operationId === undefined
          && connectionStatus.status() === 'connected'
          && sameServerUpdateLineage(
            hint.progress,
            serverUpdateReconnectProof,
          )
        ) {
          const settled = hint.progress;
          serverUpdateReconnectProof = null;
          void credentialRotationTabConvergence
            ?.clearServerUpdateProgress(settled);
        }
        reconcileServerUpdateOutcome();
        return;
      }
      if (hint.type === 'reconcile') reconcileServerUpdateOutcome();
      reconcileCredentialRotationServerCapability(hint);
    }) ?? (() => undefined);
  // Any continuity mutation is a newer lineage, even when two user actions
  // share the same Date.now() value. Invalidate the older reply directly
  // instead of manufacturing a future recovery timestamp.
  detachCredentialRotationCapabilityLineage =
    credentialRotationServerUpdateContinuity.subscribe(() => {
      credentialRotationCapabilityCheckGeneration += 1;
      credentialRotationCapabilityCheck = null;
    });
  detachCredentialRotationCapabilityReconnect =
    connectionStatus.onStatus((status) => {
      const progress = credentialRotationTabConvergence
        ?.readServerUpdateProgress() ?? null;
      if (progress === null) {
        serverUpdateReconnectProof = null;
      } else if (
        progress.phase === 'awaiting_reconnect'
        && progress.operationId === undefined
        && status !== 'connected'
      ) {
        serverUpdateReconnectProof = serverUpdateLineageOf(progress);
      } else if (
        progress.phase === 'awaiting_reconnect'
        && progress.operationId === undefined
        && sameServerUpdateLineage(progress, serverUpdateReconnectProof)
      ) {
        serverUpdateReconnectProof = null;
        void credentialRotationTabConvergence
          ?.clearServerUpdateProgress(progress);
      } else if (progress.phase === 'applying') {
        serverUpdateReconnectProof = null;
      }
      if (status === 'connected') {
        reconcileServerUpdateOutcome();
        reconcileCredentialRotationServerCapability({ type: 'reconcile' });
      }
    });
  void credentialRotationTabConvergence
    ?.reconcileServerUpdateProgress()
    .then(() => reconcileServerUpdateOutcome());
  reconcileServerUpdateOutcome();
  // A restored triage marker may boot after the sibling's one-shot channel
  // message and opaque storage pulse have already happened. Re-read the
  // selected server once now instead of waiting for a later focus transition.
  reconcileCredentialRotationServerCapability({ type: 'reconcile' });
  const connectionsDeleteCaller: ConnectionsDeleteCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.delete', args);
  // D-192 slice 5 — the delete-confirm "[N] item(s)" removal preview.
  const connectionsPreviewPurgeCaller: ConnectionsPreviewPurgeCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.previewPurge', args);
  const connectionsProbeCaller: ConnectionsProbeCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.probe', args);
  // D-225 Slice 2 — the generated-pack enrollment chain. Preview PROBES the
  // server live (the owner classifies what it says now, not a cached list);
  // commit installs and carries `reviewed_ops` so the server can refuse if the
  // tools changed while the owner was deciding.
  const connectionsMcpPackPreviewCaller: ConnectionsMcpPackPreviewCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.mcpPackPreview', args);
  const connectionsMcpPackCommitCaller: ConnectionsMcpPackCommitCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.mcpPackCommit', args);
  const connectionsSuggestSetupCaller: ConnectionsSuggestSetupCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.suggestSetup', args);
  // D-192 M4c-UI — messenger trigger read + merge-write for the slack/telegram
  // "Message triggers" editor. Gated on the same enrollment flag.
  const connectionsGetMatchPatternsCaller: ConnectionsGetMatchPatternsCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.getMatchPatterns', args);
  const connectionsSetMatchPatternsCaller: ConnectionsSetMatchPatternsCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.setMatchPatterns', args);
  // D-139 P2 — engagement-health RPC surface. Gated on the same enrollment
  // flag, but forwarded independently of the five-caller mount gate: older /
  // narrowed hosts can still mount the enrollment surface and show an honest
  // unavailable panel if these are omitted.
  const connectionsEngagementHealthCaller:
    | ConnectionsEngagementHealthCaller
    | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.engagementHealth', args);
  const connectionsReprobeEngagementCapabilitiesCaller:
    | ConnectionsReprobeEngagementCapabilitiesCaller
    | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) =>
          rpcConn.call('collection.connection.reprobeEngagementCapabilities', args);
  // D-165 P3 (email send hydration) — OPTIONAL 6th caller. Gated on the same
  // enrollment flag, but forwarded INDEPENDENTLY (the section's mount gate is
  // the five connection callers — this only hydrates the email send-from
  // picker; without it that subtype degrades to its emptyGuidance).
  const connectionsMailListCaller: ConnectionsMailListCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : () => rpcConn.call('collection.mail.list', undefined);
  // D-165 slice 3 — vendor OAuth popup callers. Gated on the same enrollment
  // flag, forwarded INDEPENDENTLY of the five-caller mount gate (with them the
  // Authorize button runs the real popup dance; without, it degrades to the
  // manual-token message). A pre-slice-3 server surfaces the rpc unknown-method
  // error inside the dialog's `oauthError`, not a route crash.
  const connectionsStartVendorOAuthCaller: ConnectionsStartVendorOAuthCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.startVendorOAuth', args);
  // R26.2 Option B — the pure code-exchange rpc. Wired unconditionally with the
  // enroll panel: the PANEL decides whether to use it (loopback only), so the
  // cloud path is untouched for every other origin.
  const connectionsCompleteVendorOAuthCaller:
    | ConnectionsCompleteVendorOAuthCaller
    | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : ((args) =>
          rpcConn.call('collection.connection.completeVendorOAuth', args)
        ) as ConnectionsCompleteVendorOAuthCaller;
  const connectionsTakeVendorOAuthResultCaller:
    | ConnectionsTakeVendorOAuthResultCaller
    | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.takeVendorOAuthResult', args);

  // D-201 Slices 5A + 5B2B — owner-only inbound webhook control-plane callers. They
  // share the Connections feature gate but mount independently on the Webhooks
  // tab; older servers surface the typed unknown/not-configured failure inline.
  const webhooksListCaller: WebhooksListCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : () => rpcConn.call('webhook.ingress.list', undefined);
  const webhooksCreateCaller: WebhooksCreateCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.ingress.create', args);
  const webhooksCredentialWriteCaller: WebhooksCredentialWriteCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.ingress.credentials.write', args);
  const webhooksCredentialRetireCaller: WebhooksCredentialRetireCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.ingress.credentials.retire', args);
  const webhooksManualConfirmCaller: WebhooksManualConfirmCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.ingress.manual.confirm', args);
  const webhooksRegistrationReconcileCaller:
    | WebhooksRegistrationReconcileCaller
    | undefined = options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.ingress.registration.reconcile', args);
  const webhooksEnableCaller: WebhooksEnableCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.ingress.enable', args);
  const webhooksDisableCaller: WebhooksDisableCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.ingress.disable', args);
  const webhooksTestDeliveryCaller: WebhooksTestDeliveryCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.ingress.test.deliver', args);
  const webhooksDeliveryListCaller: WebhooksDeliveryListCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.delivery.list', args);
  const webhooksDeliveryGetCaller: WebhooksDeliveryGetCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.delivery.get', args);
  const webhooksDeliveryEventGetCaller: WebhooksDeliveryEventGetCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.delivery.event.get', args);
  const webhooksRejectedDeliveryListCaller:
    | WebhooksRejectedDeliveryListCaller
    | undefined = options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.delivery.rejected.list', args);
  const webhooksRetireCaller: WebhooksRetireCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.ingress.retire', args);
  const webhooksRetentionPruneCaller: WebhooksRetentionPruneCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('webhook.delivery.retention.prune', args);

  // D-166/D-174 — contract override callers for the optional non-door
  // restriction editor under `#contracts`. Default ON; tests opt out via
  // `enablePermissionsPanel: false`. Per-pair-only by `collection.contract.`
  // being reserved from MCP; the webclient bearer auth path is sufficient. A
  // pre-D-166 server surfaces the rpc unknown-method error inside the panel's
  // error chip, not a route crash.
  const permissionsListOverridesCaller: PermissionsListOverridesCaller | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : () => rpcConn.call('collection.contract.listOverrides', undefined);
  const permissionsDeleteOverrideCaller: PermissionsDeleteOverrideCaller | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.contract.deleteOverride', args);
  const permissionsUpsertOverrideCaller: PermissionsUpsertOverrideCaller | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.contract.upsertOverride', args);
  const permissionsListCatalogOperationsCaller:
    | PermissionsListCatalogOperationsCaller
    | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : () => rpcConn.call('collection.contract.listCatalogOperations', undefined);

  // D-171/D-174 — `#contracts` MCP-door credential callers. Default ON with
  // the Contracts detail surface; tests opt out via
  // `enablePermissionsPanel: false`. `chat.inbound_token.*` is reserved from
  // the MCP channel (local-UI only over the pair WS-rpc), so the webclient
  // bearer auth path is sufficient. A pre-D-137-P5 server surfaces the rpc
  // unknown-method error inside the door's error chip, not a route crash.
  const permissionsListInboundTokensCaller:
    | PermissionsListInboundTokensCaller
    | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : () => rpcConn.call('chat.inbound_token.list', undefined);
  const permissionsIssueInboundTokenCaller:
    | PermissionsIssueInboundTokenCaller
    | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : (args) => rpcConn.call('chat.inbound_token.issue', args);
  const permissionsRevokeInboundTokenCaller:
    | PermissionsRevokeInboundTokenCaller
    | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : (args) => rpcConn.call('chat.inbound_token.revoke', args);
  // D-171 slice 2b — the Chat row toggles the live token's chat_mode in place
  // via update_grants (token value stable). Gates the Chat row independently of
  // the door's lifecycle trio above.
  const permissionsUpdateInboundTokenCaller:
    | PermissionsUpdateInboundTokenCaller
    | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : (args) => rpcConn.call('chat.inbound_token.update_grants', args);
  // D-171 slice 2c — the grant checklist's live self tool catalog. Read-only;
  // local-UI only over the pair WS-rpc (`chat.inbound_token.` is reserved from
  // the MCP channel). Gates the checklist alongside the update caller above.
  const permissionsToolCatalogCaller:
    | PermissionsToolCatalogCaller
    | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : () => rpcConn.call('chat.inbound_token.tool_catalog', undefined);
  const recipesToolCatalogCaller: RecipesToolCatalogCaller | undefined =
    permissionsToolCatalogCaller;
  // D-171 slice 3b / D-196 R3 — the `#contracts` normal authoring caller plus
  // the MCP-door Advanced sub-panel (lazy cap/expiry). Gated with the contracts
  // Contracts detail surface.
  // `collection.contract.{mintContract,revokeContract,listContracts}` are
  // per-pair-only (reserved from MCP); `chat.inbound_token.update_contract`
  // (slice 3a) rebinds the live token's bound contract in place. R3 exposes the
  // same owner-only mint on the Contracts route for standing doors and customer
  // templates; customer instances remain server-lifecycle-only.
  const permissionsMintContractCaller:
    | PermissionsMintContractCaller
    | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.contract.mintContract', args);
  const permissionsRevokeContractCaller:
    | PermissionsRevokeContractCaller
    | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.contract.revokeContract', args);
  const permissionsListContractsCaller:
    | PermissionsListContractsCaller
    | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : () => rpcConn.call('collection.contract.listContracts', undefined);
  const permissionsUpdateInboundContractCaller:
    | PermissionsUpdateInboundContractCaller
    | undefined =
    options.enablePermissionsPanel === false
      ? undefined
      : (args) => rpcConn.call('chat.inbound_token.update_contract', args);

  // D-166 contract_id lifecycle — `#contracts` inventory callers. Default ON;
  // tests opt out via `enableContractsPanel: false`. List + revoke gate the
  // panel (the inventory + its kill-switch). The mint caller above supplies
  // the route's ordinary-contract authoring action; Seller owns tier templates.
  // Per-pair-only by `collection.contract.` being reserved from MCP; the webclient
  // bearer auth path is sufficient. A pre-lifecycle server surfaces the rpc
  // unknown-method error inside the panel's error chip, not a route crash.
  const contractsListCaller: ContractsListCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.contract.listContracts', args);
  const contractsRevokeCaller: ContractsRevokeCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.contract.revokeContract', args);
  // D-187 §6 (grant-foundation slice 3c) — the unified grant matrix on the
  // #contracts route. The frozen `contract.grant.*` trio + the three universe
  // readers (catalog ops / contract list / topic registry) feed the two
  // transpose views. Dedicated callers (not the panel-specific ones) so the
  // grant matrix's universe stays self-consistent regardless of which other
  // Settings panels are enabled. `contract.grant.*` is MCP-reserved (an agent
  // can never widen its own grants); the webclient bearer auth path suffices.
  const grantReadCaller: GrantReadCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : (args) => rpcConn.call('contract.grant.read', args);
  const grantReadByEntryCaller: GrantReadByEntryCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : (args) => rpcConn.call('contract.grant.read_by_entry', args);
  const grantWriteCaller: GrantWriteCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : (args) => rpcConn.call('contract.grant.write', args);
  const grantListContractsCaller: GrantMatrixContractsCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : () => rpcConn.call('collection.contract.listContracts', undefined);
  const grantCatalogOperationsCaller: GrantCatalogOperationsCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : () => rpcConn.call('collection.contract.listCatalogOperations', undefined);
  // D-247 D11 — the op row's evidence: which recipes COULD reach an op, and which
  // runs DID because a grant covered them. One rpc for both halves, so the row
  // cannot show two different moments side by side.
  const grantRecipeOpUsageCaller: GrantRecipeOpUsageCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : (args) => rpcConn.call('contract.recipeOpUsage', args);
  // D-247 — the recipe half of the grant universe. Without it the `recipe` kind
  // is a permission with no way to reach it: the seed writes the rows and the
  // gate reads them, but nothing puts the keys on the page.
  const grantRecipeListCaller: GrantRecipeListCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : () => rpcConn.call('recipe.list', undefined);
  // D-211 — owner replacements for pack-authored operation defaults are
  // global, actorless, and edited only from the pack detail. Keep their
  // inventory reader independent of the contract-grant feature flag: Access
  // and operation defaults are separate axes. The operation namespace includes
  // simple-form ingredients that the contract catalog inventory intentionally
  // excludes.
  const ownerOperationInventoryCaller: OwnerOperationInventoryCaller | undefined =
    options.enablePacksPanel === false
      ? undefined
      : () => rpcConn.call('collection.operation.listOperations', undefined);
  const ownerOperationListCaller: OwnerOperationListCaller | undefined =
    options.enablePacksPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.operation.listOwnerOverrides', args);
  const ownerOperationUpsertCaller: OwnerOperationUpsertCaller | undefined =
    options.enablePacksPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.operation.upsertOwnerOverride', args);
  const ownerOperationDeleteCaller: OwnerOperationDeleteCaller | undefined =
    options.enablePacksPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.operation.deleteOwnerOverride', args);
  const grantRegistryDescribeCaller: GrantRegistryDescribeCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : () => rpcConn.call('housekeeping.registry.describe', undefined);
  const grantSetDoorTypesCaller: GrantSetDoorTypesCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.contract.setDoorTypes', args);
  // D-182 §7.2 (increment 4) — the cli-reachability callers. The universe/list
  // reads + the per-cell set write are all under the MCP-reserved
  // `cli.reachability.` prefix (owner-only). The contracts read is a dedicated
  // caller (not the `enableContractsPanel`-gated one) so the consumers below
  // still get contract rows when #contracts is disabled. A pre-increment-4
  // server surfaces the rpc unknown-method error inside the consuming panel's
  // error chip.
  //
  // Three consumers, all on the `#packs` detail (the roster-wide Local tools
  // section these were built for is retired — see `bootstrap-packs-route.ts`):
  // the ACCESS panel's cli op toggles (list + set + contracts) and the
  // supervised-daemon binary-on-PATH gate (universe).
  const localToolsUniverseCaller: SupervisionReachabilityCaller | undefined =
    options.enableCliReachability === false
      ? undefined
      : () => rpcConn.call('cli.reachability.universe', undefined);
  const localToolsListCaller: GrantCliReachabilityListCaller | undefined =
    options.enableCliReachability === false
      ? undefined
      : () => rpcConn.call('cli.reachability.list', undefined);
  const localToolsSetCaller: GrantCliReachabilitySetCaller | undefined =
    options.enableCliReachability === false
      ? undefined
      : (args) => rpcConn.call('cli.reachability.set', args);
  const localToolsContractsCaller: GrantContractsCaller | undefined =
    options.enableCliReachability === false
      ? undefined
      : () => rpcConn.call('collection.contract.listContracts', undefined);
  // D-177 N.13 (P6c) — the staged-trust "Suggested rules" section (same panel
  // gate). List + accept-mint + permanent dismiss; the rpc family is reserved
  // out of MCP, so the webclient bearer path is the only caller.
  const suggestionsListCaller: SuggestionsListCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : () => rpcConn.call('collection.contract.listDelegationSuggestions', undefined);
  const suggestionsAcceptCaller: SuggestionsAcceptCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.contract.acceptDelegationSuggestion', args);
  const suggestionsDismissCaller: SuggestionsDismissCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.contract.dismissDelegationSuggestion', args);
  // D-177 rule 5 (5.c, slice C) — the scoped-grant proposal section (same
  // panel gate; same reserved-out-of-MCP family — the webclient bearer path
  // is the only caller).
  const scopedSuggestionsListCaller: ScopedSuggestionsListCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : () => rpcConn.call('collection.contract.listScopedGrantSuggestions', undefined);
  const scopedSuggestionsAcceptCaller: ScopedSuggestionsAcceptCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.contract.acceptScopedGrantSuggestion', args);
  const scopedSuggestionsDismissCaller: ScopedSuggestionsDismissCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.contract.dismissScopedGrantSuggestion', args);
  // D-174 D14 — Settings -> AI / Models consolidated LLM config page.
  //
  // Default ON; tests pass `enableAiModelsPage: false` when they do not
  // exercise the page. Every caller below is an existing server RPC.
  const aiModelsDefaultModelPrefGetCaller:
    | ChatDefaultModelPrefGetCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : () => rpcConn.call('chat.default_model_pref.get', undefined);
  const aiModelsDefaultModelPrefSetCaller:
    | ChatDefaultModelPrefSetCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : (args) => rpcConn.call('chat.default_model_pref.set', args);
  const aiModelsGetLLMConfigCaller: AiModelsLlmConfigGetCaller | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : () => rpcConn.call('server.getLLMConfig', undefined);
  // D-174 R28 — field-level write callers (replace the whole-blob
  // `server.setLLMConfig` so two surfaces editing different slots don't
  // clobber). `setLLMConfig` stays a server rpc for bulk/import; the page
  // no longer drives it.
  const aiModelsSetLLMSlotCaller: AiModelsLlmSlotSetCaller | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : (args) => rpcConn.call('server.setLLMSlot', args);
  const aiModelsSetEmbeddingsSlotCaller: AiModelsEmbeddingsSlotSetCaller | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : (args) => rpcConn.call('server.setEmbeddingsSlot', args);
  const aiModelsUpsertFreePoolEntryCaller:
    | AiModelsFreePoolEntryUpsertCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : (args) => rpcConn.call('server.upsertFreePoolEntry', args);
  const aiModelsRemoveFreePoolEntryCaller:
    | AiModelsFreePoolEntryRemoveCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : (args) => rpcConn.call('server.removeFreePoolEntry', args);
  const aiModelsSetFreePoolEntryEnabledCaller:
    | AiModelsFreePoolEntryEnabledCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : (args) => rpcConn.call('server.setFreePoolEntryEnabled', args);
  // Lever-2 per-slot (Phase 3) — field-level per-source chat-catalog mode
  // write (mirrors the R28 field-level pattern; server does a
  // read-modify-write so it never clobbers another source).
  const aiModelsSetChatCatalogModeCaller:
    | AiModelsSetChatCatalogModeCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : (args) => rpcConn.call('server.setChatCatalogMode', args);
  // Owner-authored system prompts. The read ships the built-in DEFAULT beside
  // the effective prompt, so the editor pre-fills with real text and "Reset to
  // default" has something to restore to.
  const aiModelsGetLlmPromptsCaller:
    | AiModelsLlmPromptsGetCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : () => rpcConn.call('server.getLlmPrompts', undefined);
  const aiModelsSetLlmPromptCaller:
    | AiModelsLlmPromptSetCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : (args) => rpcConn.call('server.setLlmPrompt', args);
  // Test connection — one real completion against a slot. Button-driven only:
  // it costs a request against the owner's credential, so nothing calls it on
  // load, on save, or on a field change.
  const aiModelsProbeLlmSourceCaller:
    | AiModelsProbeSourceCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : (args) => rpcConn.call('server.probeLlmSource', args);
  const aiModelsGetConfigSchemaCaller:
    | AiModelsConfigSchemaGetCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : () => rpcConn.call('server.getConfigSchema', undefined);
  const aiModelsSetConfigFieldCaller:
    | AiModelsConfigFieldSetCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : (args) => rpcConn.call('server.setConfigField', args);
  const aiModelsHousekeepingConfigReadCaller:
    | AiModelsHousekeepingConfigReadCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : () => rpcConn.call('housekeeping.config.read', undefined);
  const aiModelsHousekeepingConfigWriteCaller:
    | AiModelsHousekeepingConfigWriteCaller
    | undefined =
    options.enableAiModelsPage === false
      ? undefined
      : (args) => rpcConn.call('housekeeping.config.write', args);

  // D-196 S2 — Settings -> Seller consolidator.
  const sellerOverviewCaller: SellerOverviewCaller | undefined =
    options.enableSellerPage === false
      ? undefined
      : () => rpcConn.call('server.seller.getOverview', undefined);
  // D-207 order-is-the-lifecycle — the owner Orders view read caller.
  const sellerOrdersCaller: SellerListOrdersCaller | undefined =
    options.enableSellerPage === false
      ? undefined
      : (args) => rpcConn.call('server.seller.listOrders', args);
  const sellerOfferStateTransitionCaller:
    SellerOfferStateTransitionCaller | undefined =
      options.enableSellerPage === false
        ? undefined
        : (args) => rpcConn.call('server.seller.transitionOfferState', args);
  // D-196 §4.7 — the Seller sender chooser owns this caller independently
  // from Connections enrollment, so disabling that route cannot suppress the
  // seller's live send-capable mail choices.
  const sellerMailListCaller: SellerMailListCaller | undefined =
    options.enableSellerPage === false
      ? undefined
      : () => rpcConn.call('collection.mail.list', undefined);
  const sellerSettingsUpdateCaller: SellerSettingsUpdateCaller | undefined =
    options.enableSellerPage === false
      ? undefined
      : (args) => rpcConn.call('server.seller.updateSettings', args);
  const sellerManualTierUpsertCaller: SellerManualTierUpsertCaller | undefined =
    options.enableSellerPage === false
      ? undefined
      : (args) => rpcConn.call('server.seller.upsertManualTier', args);
  const sellerTierUsagePolicyCaller: SellerTierUsagePolicyCaller | undefined =
    options.enableSellerPage === false
      ? undefined
      : (args) => rpcConn.call('server.seller.setTierUsagePolicy', args);
  const sellerCreatePassTierCaller: SellerCreatePassTierCaller | undefined =
    options.enableSellerPage === false
      ? undefined
      : (args) => rpcConn.call('server.seller.createPassTier', args);
  const sellerManualCustomerIssueCaller: SellerManualCustomerIssueCaller | undefined =
    options.enableSellerPage === false
      ? undefined
      : (args) => rpcConn.call('server.seller.issueManualCustomer', args);
  const sellerManualCustomerExtendCaller: SellerManualCustomerExtendCaller | undefined =
    options.enableSellerPage === false
      ? undefined
      : (args) => rpcConn.call('server.seller.extendManualCustomer', args);
  const sellerManualCustomerSwapTierCaller: SellerManualCustomerSwapTierCaller | undefined =
    options.enableSellerPage === false
      ? undefined
      : (args) => rpcConn.call('server.seller.swapManualCustomerTier', args);
  const sellerManualCustomerCloseCaller: SellerManualCustomerCloseCaller | undefined =
    options.enableSellerPage === false
      ? undefined
      : (args) => rpcConn.call('server.seller.closeManualCustomer', args);
  const sellerManualCustomerReissueTokenCaller:
    SellerManualCustomerReissueTokenCaller | undefined =
      options.enableSellerPage === false
        ? undefined
        : (args) => rpcConn.call('server.seller.reissueManualCustomerToken', args);
  const sellerManualTierBulkAdjustCaller:
    SellerManualTierBulkAdjustCaller | undefined =
      options.enableSellerPage === false
        ? undefined
        : (args) => rpcConn.call('server.seller.bulkAdjustManualTierCustomers', args);
  const sellerStripeSynchronizeCaller: SellerStripeSynchronizeCaller | undefined =
    options.enableSellerPage === false
      ? undefined
      : (args) => rpcConn.call('server.seller.synchronizeStripeEntitlements', args);
  // D-196 §4.9 / I-7 — owner-only paid-gateway acknowledgment (reserved out of MCP).
  const sellerAcknowledgeLlmGatewayPaidCaller:
    | SellerAcknowledgeLlmGatewayPaidCaller
    | undefined =
    options.enableSellerPage === false
      ? undefined
      : (args) => rpcConn.call('server.seller.acknowledgeLlmGatewayPaid', args);

  // D-178 — Settings → Updates. Default ON; tests pass `enableUpdatesPage: false`.
  // Every caller is an existing owner-only server RPC (reserved out of MCP).
  const updatesEnabled = options.enableUpdatesPage !== false;
  const updateCheckCaller: UpdateCheckCaller | undefined = updatesEnabled
    ? () => rpcConn.call('update.check', undefined)
    : undefined;
  const updateModeGetCaller: UpdateModeGetCaller | undefined = updatesEnabled
    ? () => rpcConn.call('update.mode', undefined)
    : undefined;
  const updateModeSetCaller: UpdateModeSetCaller | undefined = updatesEnabled
    ? (args) => rpcConn.call('update.set_mode', args)
    : undefined;
  const updateApplyCaller: UpdateApplyCaller | undefined = updatesEnabled
    ? (args) => rpcConn.call('update.apply', args)
    : undefined;
  const updateRollbackCaller: UpdateRollbackCaller | undefined = updatesEnabled
    ? () => rpcConn.call('update.rollback', undefined)
    : undefined;
  const connectionsCredentialRotationServerUpdateTriageCaller:
    ConnectionsCredentialRotationServerUpdateTriageCaller | undefined =
      options.enableConnectionsEnrollPanel === false
        ? undefined
        : async (target) => {
            let check: Awaited<ReturnType<UpdateCheckCaller>> | null = null;
            if (updateCheckCaller !== undefined) {
              try {
                check = await updateCheckCaller();
              } catch {
                // The absent activity method remains authoritative. The
                // diagnosis will explicitly say the signed check was
                // unavailable instead of turning a read failure into a guess.
              }
            }
            let triage = credentialRotationServerUpdateContinuity
              .markStillUnsupported(target, check);
            if (
              triage === null
              && credentialRotationServerUpdateContinuity.read() === null
            ) {
              // A manually restored exact retry URL may arrive without its
              // session marker. Once the selected server itself confirms the
              // capability is absent, reconstruct only the safe target and
              // diagnosis so Account does not fall back into the generic
              // update loop.
              credentialRotationServerUpdateContinuity.begin(target);
              triage = credentialRotationServerUpdateContinuity
                .markStillUnsupported(target, check);
            }
            return triage ?? classifyCredentialRotationServerUpdateTriage(
              undefined,
              check,
            );
          };
  const updatesStartPoll = (cb: () => void, ms: number): (() => void) => {
    const id = setInterval(cb, ms);
    return () => clearInterval(id);
  };

  // D-145 § B.8.9 — Settings → Transparency panel: per-pair
  // `ui.transparency.*` prefs over the standard pair-WS prefs rpc.
  // Default ON; tests pass `enableTransparencyPanel: false` when they
  // do not exercise the panel.
  const transparencyPrefsGetCaller: TransparencyPrefsGetCaller | undefined =
    options.enableTransparencyPanel === false
      ? undefined
      : () => rpcConn.call('prefs.get', undefined);
  const transparencyPrefsSetCaller: TransparencyPrefsSetCaller | undefined =
    options.enableTransparencyPanel === false
      ? undefined
      : (args) => rpcConn.call('prefs.set', args);

  // D-219 slice 9c — Settings → Learning: the `chat.execution_case_offer`
  // pref over the SAME pair-WS prefs rpc. Its own caller pair rather than
  // reusing the transparency thunks, so a test can drive either panel in
  // isolation and neither panel's failure surfaces in the other. Rides the
  // transparency enable flag: both are prefs panels on the same rpc, and a
  // harness that stubs out one has no server for the other either.
  const learningPrefsGetCaller: LearningPrefsGetCaller | undefined =
    options.enableTransparencyPanel === false
      ? undefined
      : () => rpcConn.call('prefs.get', undefined);
  const learningPrefsSetCaller: LearningPrefsSetCaller | undefined =
    options.enableTransparencyPanel === false
      ? undefined
      : (args) => rpcConn.call('prefs.set', args);

  // D-219 item 2 — Settings → Learning: WHAT Recued has learned, and unlearning
  // one case. Wired as a PAIR, on the same flag as the pref thunks above: a
  // page that lists what was learned and cannot unlearn it reads as a control
  // surface without being one, which is worse than not listing it.
  const learningCasesListCaller: LearningCasesListCaller | undefined =
    options.enableTransparencyPanel === false
      ? undefined
      : () => rpcConn.call('chat.execution.learned', undefined);
  const learningCaseForgetCaller: LearningCaseForgetCaller | undefined =
    options.enableTransparencyPanel === false
      ? undefined
      : (args) => rpcConn.call('chat.execution.forget', args);
  // D-219 item 2b — ask the owner's own model to draft a recipe from a case.
  const learningDraftRecipeCaller: LearningDraftRecipeCaller | undefined =
    options.enableTransparencyPanel === false
      ? undefined
      // ⛔ THE DEFAULT 30s TIMEOUT LOSES THIS CALL. Every other rpc here is a
      // local read; this one waits on the owner's model writing a whole recipe,
      // which on a reasoning model is comfortably past 30s. Live run
      // 2026-07-29: the server drafted fine and the CLIENT gave up at exactly
      // 30s, so the owner paid for a draft, saw "Your server isn't responding
      // right now", and got nothing — and an immediate retry hit the
      // singleflight. The server's own generate path is the real ceiling; this
      // just stops the client abandoning a call it already paid for.
      : (args) => rpcConn.call('chat.execution.draft_recipe', args, {
          timeout: LEARNING_DRAFT_RPC_TIMEOUT_MS,
        });
  /** Same-tab carrier for an AI-written draft between Settings and the Kitchen.
   *  ⚠ sessionStorage by default, so a refresh keeps a draft the owner paid
   *  for; absent storage degrades to no hand-off rather than throwing. */
  const draftStashStorage = options.draftStashStorage
    ?? (typeof sessionStorage === 'undefined' ? null : sessionStorage);

  // D-145 PA11 — Housekeeping LLM result cache card, relocated under
  // D-174 D14's AI / Models section.
  //
  // Default ON; tests pass `enableHousekeepingCacheCard: false` when
  // they do not exercise the card. The handlers run on the standard
  // pair-WS channel (per-pair-only by `housekeeping.` in
  // `MCP_RESERVED_RPC_PREFIXES`); the webclient bearer auth path is
  // sufficient. The handlers gate on `llmResultCache` being wired
  // server-side — a db-less harness running the bootstrap with this
  // option ON will surface the rpc `unsupported` error inside the
  // card's load-error chip, not a hard route crash.
  const housekeepingCacheStatsCaller: LlmResultCacheStatsCaller | undefined =
    options.enableHousekeepingCacheCard === false
      || options.enableAiModelsPage === false
      ? undefined
      : () => rpcConn.call('housekeeping.cache.stats', undefined);
  const housekeepingCacheClearCaller: LlmResultCacheClearCaller | undefined =
    options.enableHousekeepingCacheCard === false
      || options.enableAiModelsPage === false
      ? undefined
      : () => rpcConn.call('housekeeping.cache.clear', undefined);

  // D-132/D-133 — Housekeeping trust panel callers (Settings →
  // Housekeeping). Default ON; tests pass `enableHousekeepingPanel: false`.
  // All run on the standard pair-WS channel (`housekeeping.` is
  // per-pair-only). The panel mounts when the four read/write seams are
  // present; Run-now + trust write are independently optional.
  const housekeepingPanelConfigReadCaller:
    | HousekeepingConfigReadCaller
    | undefined =
    options.enableHousekeepingPanel === false
      ? undefined
      : () => rpcConn.call('housekeeping.config.read', undefined);
  const housekeepingPanelConfigWriteCaller:
    | HousekeepingConfigWriteCaller
    | undefined =
    options.enableHousekeepingPanel === false
      ? undefined
      : (args) => rpcConn.call('housekeeping.config.write', args);
  const housekeepingPanelStatusReadCaller:
    | HousekeepingStatusReadCaller
    | undefined =
    options.enableHousekeepingPanel === false
      ? undefined
      : () => rpcConn.call('housekeeping.status.read', undefined);
  const housekeepingPanelRunNowCaller: HousekeepingRunNowCaller | undefined =
    options.enableHousekeepingPanel === false
      ? undefined
      : (args) => rpcConn.call('housekeeping.task.run_now', args);
  // Server ▸ Maintenance storage read-out. ⚠ Gated on the SAME flag as the rest
  // of the tab — a Storage section on a panel that is otherwise switched off
  // would be the only thing rendering there.
  const maintenanceServerStatusCaller =
    options.enableHousekeepingPanel === false
      ? undefined
      : () => rpcConn.call('server.getStatus', undefined);
  const maintenanceReclaimCaller =
    options.enableHousekeepingPanel === false
      ? undefined
      : (args: { surface: string; force?: boolean }) =>
        rpcConn.call('server.runPressureReclaim', args);
  const housekeepingPanelTrustReadCaller:
    | HousekeepingTrustReadCaller
    | undefined =
    options.enableHousekeepingPanel === false
      ? undefined
      : () => rpcConn.call('housekeeping.trust.read', undefined);
  const housekeepingPanelTrustWriteCaller:
    | HousekeepingTrustWriteCaller
    | undefined =
    options.enableHousekeepingPanel === false
      ? undefined
      : (args) => rpcConn.call('housekeeping.trust.write', args);
  // Commit 2 — promotion Don't-ask-again, MCP-exposure coverage +
  // override, and the destructive topic-reset. All per-pair-only
  // (`housekeeping.` / `mcp.` prefixes) on the standard pair-WS channel.
  const housekeepingPanelDismissPromotionCaller:
    | HousekeepingDismissPromotionCaller
    | undefined =
    options.enableHousekeepingPanel === false
      ? undefined
      : (args) => rpcConn.call('housekeeping.trust.dismiss_promotion', args);
  const housekeepingPanelRegistryDescribeCaller:
    | HousekeepingRegistryDescribeCaller
    | undefined =
    options.enableHousekeepingPanel === false
      ? undefined
      : () => rpcConn.call('housekeeping.registry.describe', undefined);
  const housekeepingPanelTopicResetCaller:
    | HousekeepingTopicResetCaller
    | undefined =
    options.enableHousekeepingPanel === false
      ? undefined
      : (args) => rpcConn.call('housekeeping.topic.reset', args);

  // D-152 P6 — Hostname registry panel callers. Default ON; tests opt out via
  // `enableHostnamesPanel: false`. The callers are forwarded as a full
  // CRUD/proof group. A pre-D-152 server surfaces unknown-method errors inside
  // the panel, not as a route crash.
  const hostnamesListCaller: HostnamesListCaller | undefined =
    options.enableHostnamesPanel === false
      ? undefined
      : () => rpcConn.call('collection.hostname.list', undefined);
  const hostnamesGetCaller: HostnamesGetCaller | undefined =
    options.enableHostnamesPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.hostname.get', args);
  const hostnamesAddCaller: HostnamesAddCaller | undefined =
    options.enableHostnamesPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.hostname.add', args);
  const hostnamesUpdateCaller: HostnamesUpdateCaller | undefined =
    options.enableHostnamesPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.hostname.update', args);
  const hostnamesRemoveCaller: HostnamesRemoveCaller | undefined =
    options.enableHostnamesPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.hostname.remove', args);
  const hostnamesVerifyOwnershipCaller:
    | HostnamesVerifyOwnershipCaller
    | undefined =
    options.enableHostnamesPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.hostname.verifyOwnership', args);
  // D-235 P5 — Settings → Server → Domains. Both are READ-ONLY on the server
  // (preflight resolves DNS and mutates nothing), so they ride the same gate as
  // the rest of the hostname surface without further conditions. ⚠ An older
  // server has neither method; the panel surfaces the rpc error rather than
  // pretending the DNS check passed.
  const customDomainPreflightCaller: CustomDomainPreflightCaller | undefined =
    options.enableHostnamesPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.hostname.preflight', args);
  const customDomainReadinessCaller: CustomDomainReadinessCaller | undefined =
    options.enableHostnamesPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.hostname.issuanceReadiness', args);
  // LAN-URL kickstart (slice 2) — `network.local_urls` powers the Hostnames
  // panel's read-only "Reachable on your network" section. Built + forwarded
  // unconditionally (not bundled into the all-or-nothing hostname-CRUD group):
  // it is a harmless local read on any paired server, and the panel ignores it
  // when the section can't mount. Missing rpc (older server) is caught panel-
  // side and renders nothing.
  const networkLocalUrlsCaller: NetworkLocalUrlsCaller = () =>
    rpcConn.call('network.local_urls', undefined);

  // R27 delta-B — Pro DDNS pause/resume rpc callers for the Hostnames panel's
  // "Pro web address (DDNS)" control. Owner-only + MCP-reserved server-side;
  // the panel only OFFERS the toggle when DDNS is published (the route composes
  // that gate from pro_convenience.status). Older servers (no ddns.* rpc) are
  // caught panel-side (the section silently does not render).
  const ddnsStatusCaller: DdnsStatusCaller = () =>
    rpcConn.call('ddns.status', undefined);
  const ddnsSetEnabledCaller: DdnsSetEnabledCaller = (args) =>
    rpcConn.call('ddns.setEnabled', args);

  // D-174/D-175 — Settings -> Account binding touchpoint.
  //
  // Default ON; tests pass `enableAccountBindingPanel: false` when they do not
  // exercise the section. The status/pro reads are pair-RPCs and degrade to
  // inline error chips on pre-D-175 servers. R27 wires the session read so the
  // recued.com card can surface "Signed in as …" + a Sign out action. ⛔ That
  // read is a cross-origin GET to the auth Worker and the panel GATES it on the
  // server holding an account binding (plus the user-initiated Connect press):
  // the Settings route mounts every section eagerly, so an ungated read turned
  // opening ANY settings surface into a recued.com call on a self-hosted server
  // with no account. See `account-binding-panel.ts`.
  const accountBindingAuthClient =
    options.enableAccountBindingPanel === false
      ? null
      : createAccountBindingAuthClient({
          ...(options.accountBindingAuthWorkerUrl !== undefined
            ? { workerUrl: options.accountBindingAuthWorkerUrl }
            : {}),
          ...(options.accountBindingFetch !== undefined
            ? { fetch: options.accountBindingFetch }
            : {}),
        });
  const accountBindingStatusCaller: AccountBindingStatusCaller | undefined =
    options.enableAccountBindingPanel === false
      ? undefined
      : () => rpcConn.call('account.bindingStatus', undefined);
  const accountBindCaller: AccountBindCaller | undefined =
    options.enableAccountBindingPanel === false
      ? undefined
      : (args) => rpcConn.call('account.bind', args);
  const accountUnbindCaller: AccountUnbindCaller | undefined =
    options.enableAccountBindingPanel === false
      ? undefined
      : () => rpcConn.call('account.unbind', undefined);
  const accountProConvenienceStatusCaller:
    | ProConvenienceStatusCaller
    | undefined =
    options.enableAccountBindingPanel === false
      ? undefined
      : () => rpcConn.call('pro_convenience.status', undefined);
  // ⛔ `server_fingerprint` IS THE POINT OF THIS CALL. It used to be
  // `mintBindingToken()` with no arguments, which mints a token bound to no
  // server — and the auth Worker's own source spells out the consequence: a
  // captured token is then redeemable by ANY server with a valid self-proof,
  // binding the attacker's server to this account and consuming the single-use
  // nonce, so the victim's own server afterwards gets `nonce_reused`. The
  // enforcement has always been there (the DO rejects a proving fingerprint
  // that differs from `intended_server`); nothing was ever naming the server.
  //
  // `pair.serverPublicKey` is the key this browser pinned at pair time, so the
  // token is bound to the server the user is actually looking at. A derivation
  // failure THROWS through to the panel's error copy rather than falling back
  // to an unbound mint — falling back would silently restore the hole.
  const accountBindingTokenMintCaller:
    | AccountBindingTokenMintCaller
    | undefined =
    accountBindingAuthClient === null
      ? undefined
      : async () => accountBindingAuthClient.mintBindingToken({
        server_fingerprint: await serverKeyFingerprint(pair.serverPublicKey),
      });
  const accountBindingSessionCaller: AccountBindingSessionCaller | undefined =
    accountBindingAuthClient === null
      ? undefined
      : () => accountBindingAuthClient.getSession();
  const accountSignOutCaller: AccountSignOutCaller | undefined =
    accountBindingAuthClient === null
      ? undefined
      : () => accountBindingAuthClient.signOut();
  const accountDashboardUrl =
    options.accountBindingDashboardUrl ?? resolveAccountBindingDashboardUrl();

  let lastReachabilityProbeResponse: DiagnosticResponse | null = null;
  const baseReachabilityExternalProbeCaller: ReachabilityExternalProbeCaller | undefined =
    options.enableReachabilityDoctor === true
      ? options.reachabilityExternalProbeCaller
        ?? createReachabilityDiagnosticProbeCaller({
          ...(options.diagnosticsFetch !== undefined
            ? { fetcher: options.diagnosticsFetch }
            : {}),
          ...(options.diagnosticsApiBaseUrl !== undefined
            ? { baseUrl: options.diagnosticsApiBaseUrl }
            : {}),
          resolveTarget: async () => {
            const pairMetadata = await options.localStore.get('pair_metadata');
            const handle = pairMetadata?.server_handle_at_pair ?? '';
            const accountId = options.diagnosticsAccountId ?? handle.trim();
            const hostname =
              options.diagnosticsHostname ?? hostnameFromHandle(handle);
            if (accountId.length === 0) {
              throw new Error('diagnostics account id is unavailable');
            }
            if (hostname === null) {
              throw new Error('diagnostics hostname is unavailable');
            }
            const expectedPublicIp =
              options.reachabilityReport?.network.public_ipv4
              ?? options.reachabilityReport?.network.public_ipv6
              ?? undefined;
            const target = {
              account_id: accountId,
              hostname,
              ...(expectedPublicIp !== undefined
                ? { expected_public_ip: expectedPublicIp }
                : {}),
            };
            return target;
          },
        })
      : undefined;
  const reachabilityExternalProbeCaller: ReachabilityExternalProbeCaller | undefined =
    baseReachabilityExternalProbeCaller === undefined
      ? undefined
      : async (override) => {
          const response = await baseReachabilityExternalProbeCaller(override);
          lastReachabilityProbeResponse = response;
          return response;
        };

  // §D.shell — the live deep-link segment for `route` (its `initial*`
  // selection), or undefined when the current hash points at a different
  // surface so a stale segment from a prior surface never leaks into the
  // mount. Index defaults to segment 0 (the "subview"/selected item).
  const deepLinkSegment = (
    route: WebclientRouteId,
    index = 0,
  ): string | undefined => {
    if (hashSource === null) return undefined;
    const parsed = parseShellRoute(hashSource.getHash());
    return parsed.surface === route ? parsed.segments[index] : undefined;
  };

  const mountRoute = (
    route: WebclientRouteId,
  ): RecoveryContextProbe & {
    update?: () => void;
    dispose: () => void;
    /** Leave-guard seam — a route with unsaved work returns true and the
     *  hash listener asks before tearing it down. Absent = never guarded. */
    hasUnsavedChanges?: () => boolean;
    /** Optional privacy-safe context for the route-change confirmation.
     * Native beforeunload prompts remain browser-controlled. */
    unsavedChangesPrompt?: () => string | null;
    /** User-started source work whose outcome is not known yet. */
    hasInFlightWork?: () => boolean;
    /** Opt-in route-leave copy for in-flight work that must retain its owner.
     * Absent/null leaves ordinary tracked background work navigable. */
    inFlightWorkPrompt?: () => string | null;
    /** Native mount-only work before the boot-scoped tracker is composed. */
    hasRouteInFlightWork?: () => boolean;
    /** Same-surface deep links can opt into an in-place transition. This is
     * used by Chat plan handoffs to preserve a same-thread composer draft. */
    navigateDeepLink?: (hash: string) => boolean;
    /** Chat-only in-memory rescue seam for a forced re-pair. */
    getRecoveryDraft?: () => ChatRouteRecoveryDraft | null;
  } => {
    settledProfileRecoveryNeedsAddressCleanup = false;
    refreshActivePostSafeStopProfileContext = () => undefined;
    const withTrackedServerSwitchWork = <T extends { dispose(): void }>(
      handle: T,
    ): T & {
      hasInFlightWork(): boolean;
      hasRouteInFlightWork(): boolean;
      retryRecoveryContext?: () => Promise<void>;
    } => {
      const routeHasInFlightWork = (
        handle as T & { hasInFlightWork?: () => boolean }
      ).hasInFlightWork;
      const explicitRecoveryRetry = (
        handle as T & { retryRecoveryContext?: () => Promise<void> }
      ).retryRecoveryContext;
      const routeRefresh = (
        handle as T & { refresh?: () => void | Promise<void> }
      ).refresh;
      const routeWhenLoaded = (
        handle as T & { whenLoaded?: () => Promise<void> }
      ).whenLoaded;
      const retryRecoveryContext = explicitRecoveryRetry ?? routeRefresh;
      return {
        ...handle,
        ...(retryRecoveryContext !== undefined
          ? {
              retryRecoveryContext: async (): Promise<void> => {
                await retryRecoveryContext.call(handle);
                // A few route refresh seams schedule their read and return
                // synchronously. Await the route-owned boundary after dispatch
                // so the receipt never races ahead of the authoritative result.
                await routeWhenLoaded?.call(handle);
              },
            }
          : {}),
        hasInFlightWork: () => switchWorkTracker.hasInFlightWork()
          || routeHasInFlightWork?.call(handle) === true,
        hasRouteInFlightWork: () => routeHasInFlightWork?.call(handle) === true,
      };
    };
    if (route === 'contracts') {
      activeSettingsRoute = null;
      const contractsSubview = deepLinkSegment('contracts');
      const contractsListTabCandidate = contractsSubview === 'view'
        ? deepLinkSegment('contracts', 1)
        : undefined;
      const contractsListTab = isContractsListTab(contractsListTabCandidate)
        ? contractsListTabCandidate
        : undefined;
      return withTrackedServerSwitchWork(bootstrapContractsRoute({
        root: appShell.contentRoot,
        serverUrl: pair.serverUrl,
        ...(options.document !== undefined ? { document: options.document } : {}),
        ...(permissionsListOverridesCaller !== undefined
          && permissionsDeleteOverrideCaller !== undefined
          && permissionsUpsertOverrideCaller !== undefined
          && permissionsListCatalogOperationsCaller !== undefined
          ? {
              permissionsListOverridesCaller,
              permissionsDeleteOverrideCaller: switchWorkTracker.track(
                permissionsDeleteOverrideCaller,
              ),
              permissionsUpsertOverrideCaller: switchWorkTracker.track(
                permissionsUpsertOverrideCaller,
              ),
              permissionsListCatalogOperationsCaller,
            }
          : {}),
        ...(permissionsListInboundTokensCaller !== undefined
          && permissionsIssueInboundTokenCaller !== undefined
          && permissionsRevokeInboundTokenCaller !== undefined
          ? {
              permissionsListInboundTokensCaller,
              permissionsIssueInboundTokenCaller: switchWorkTracker.track(
                permissionsIssueInboundTokenCaller,
              ),
              permissionsRevokeInboundTokenCaller: switchWorkTracker.track(
                permissionsRevokeInboundTokenCaller,
              ),
            }
          : {}),
        ...(permissionsUpdateInboundTokenCaller !== undefined
          ? {
              permissionsUpdateInboundTokenCaller: switchWorkTracker.track(
                permissionsUpdateInboundTokenCaller,
              ),
            }
          : {}),
        ...(permissionsToolCatalogCaller !== undefined
          ? { permissionsToolCatalogCaller }
          : {}),
        ...(permissionsMintContractCaller !== undefined
          && permissionsRevokeContractCaller !== undefined
          && permissionsListContractsCaller !== undefined
          && permissionsUpdateInboundContractCaller !== undefined
          ? {
              permissionsMintContractCaller: switchWorkTracker.track(
                permissionsMintContractCaller,
              ),
              permissionsRevokeContractCaller: switchWorkTracker.track(
                permissionsRevokeContractCaller,
              ),
              permissionsListContractsCaller,
              permissionsUpdateInboundContractCaller: switchWorkTracker.track(
                permissionsUpdateInboundContractCaller,
              ),
            }
          : {}),
        ...(contractsListCaller !== undefined
          && contractsRevokeCaller !== undefined
          ? {
              contractsListCaller,
              contractsRevokeCaller: switchWorkTracker.track(
                contractsRevokeCaller,
              ),
            }
          : {}),
        ...(grantReadCaller !== undefined
          && grantReadByEntryCaller !== undefined
          && grantWriteCaller !== undefined
          ? {
              grantReadCaller,
              grantReadByEntryCaller,
              grantWriteCaller: switchWorkTracker.track(grantWriteCaller),
              ...(grantListContractsCaller !== undefined
                ? { grantListContractsCaller }
                : {}),
              ...(grantRecipeOpUsageCaller !== undefined
                ? { grantRecipeOpUsageCaller }
                : {}),
              ...(grantRecipeListCaller !== undefined
                ? { grantRecipeListCaller }
                : {}),
              ...(grantRecipeOpUsageCaller !== undefined
          ? { grantRecipeOpUsageCaller }
          : {}),
        ...(grantRecipeListCaller !== undefined
          ? { grantRecipeListCaller }
          : {}),
        ...(grantCatalogOperationsCaller !== undefined
                ? { grantCatalogOperationsCaller }
                : {}),
              ...(grantRegistryDescribeCaller !== undefined
                ? { grantRegistryDescribeCaller }
                : {}),
              ...(grantSetDoorTypesCaller !== undefined
                ? {
                    grantSetDoorTypesCaller: switchWorkTracker.track(
                      grantSetDoorTypesCaller,
                    ),
                  }
                : {}),
              // GAP-B fix — route CLI ops in the Ops grant panel to
              // cli_reachability (their real authority), reusing the same
              // `cli.reachability.{list,set}` callers the by-pack ACCESS panel
              // writes through.
              ...(localToolsListCaller !== undefined
                ? { grantCliReachabilityListCaller: localToolsListCaller }
                : {}),
              ...(localToolsSetCaller !== undefined
                ? {
                    grantCliReachabilitySetCaller: switchWorkTracker.track(
                      localToolsSetCaller,
                    ),
                  }
                : {}),
            }
          : {}),
        ...(suggestionsListCaller !== undefined
          && suggestionsAcceptCaller !== undefined
          && suggestionsDismissCaller !== undefined
          ? {
              suggestionsListCaller,
              suggestionsAcceptCaller: switchWorkTracker.track(
                suggestionsAcceptCaller,
              ),
              suggestionsDismissCaller: switchWorkTracker.track(
                suggestionsDismissCaller,
              ),
            }
          : {}),
        ...(scopedSuggestionsListCaller !== undefined
          && scopedSuggestionsAcceptCaller !== undefined
          && scopedSuggestionsDismissCaller !== undefined
          ? {
              scopedSuggestionsListCaller,
              scopedSuggestionsAcceptCaller: switchWorkTracker.track(
                scopedSuggestionsAcceptCaller,
              ),
              scopedSuggestionsDismissCaller: switchWorkTracker.track(
                scopedSuggestionsDismissCaller,
              ),
            }
          : {}),
        runsListCaller,
        ...(options.now !== undefined ? { now: options.now } : {}),
        subscribe: subscriber.on,
        ...(contractsListTab !== undefined ? { initialListTab: contractsListTab } : {}),
        ...(hashSource !== null && contractsSubview !== 'view'
          ? {
              initialContractId: contractsSubview,
              initialContractTab: deepLinkSegment('contracts', 1),
            }
          : {}),
      }));
    }
    if (route === 'connections') {
      activeSettingsRoute = null;
      // Capture the complete address before consuming a temporary retry or
      // validating a profile-bound recovery. Account's credential retry is
      // one-shot; a valid recovery address remains reload-safe until the owner
      // settles it or switches to a different profile.
      const connectionsAddress = hashSource === null
        ? null
        : parseShellRoute(hashSource.getHash());
      const connectionsSegments = connectionsAddress?.surface === 'connections'
        ? connectionsAddress.segments
        : [];
      const initialCredentialRotationServerUpdateRetry =
        parseConnectionsCredentialRotationRetry(connectionsSegments);
      const postSafeStopRecoveryResolution =
        resolveProfileBoundPostSafeStopRecovery(
          connectionsSegments,
          bootProfileId,
        );
      const initialPostSafeStopRecovery =
        postSafeStopRecoveryResolution.status === 'matched'
          ? {
              kind: postSafeStopRecoveryResolution.target.kind,
              name: postSafeStopRecoveryResolution.target.name,
            }
          : null;
      const postSafeStopProfileHandoff = (() => {
        if (postSafeStopRecoveryResolution.status === 'unbound') {
          return {
            reason: 'unbound' as const,
            activeProfileLabel: bootProfileLabel,
            serverProfilesAvailable:
              accountMenu !== null && profileStore !== undefined,
          };
        }
        if (postSafeStopRecoveryResolution.status !== 'profile_mismatch') {
          return null;
        }
        const sourceProfile = knownServerProfiles.find((profile) =>
          profile.id === postSafeStopRecoveryResolution.target.serverProfileId);
        const sourceProfileLabel = sourceProfile?.label.trim();
        return {
          reason: 'profile_mismatch' as const,
          activeProfileLabel: bootProfileLabel,
          ...(sourceProfileLabel !== undefined && sourceProfileLabel.length > 0
            ? { sourceProfileLabel }
            : {}),
          serverProfilesAvailable:
            accountMenu !== null && profileStore !== undefined,
        };
      })();
      const initialCredentialRotationServerUpdateCompletion = (() => {
        if (initialCredentialRotationServerUpdateRetry === null) return null;
        const marker = credentialRotationServerUpdateContinuity.read();
        const verification = marker?.serverUpdateVerification
          ?? serverUpdateReceiptVerification?.read()
          ?? null;
        const affected = verification?.baseline?.affectedConnection;
        return verification?.phase === 'completed'
          && marker?.kind === initialCredentialRotationServerUpdateRetry.kind
          && marker.name === initialCredentialRotationServerUpdateRetry.name
          && affected?.kind === initialCredentialRotationServerUpdateRetry.kind
          && affected.name === initialCredentialRotationServerUpdateRetry.name
          ? verification
          : null;
      })();
      let exactReturnOwned = false;
      if (initialCredentialRotationServerUpdateRetry !== null) {
        exactReturnOwned =
          credentialRotationServerUpdateContinuity.beginExactReturn(
            initialCredentialRotationServerUpdateRetry,
          );
        const canonicalHash = serializeShellRoute('connections', 'others');
        const history = doc.defaultView?.history;
        if (history?.replaceState !== undefined) {
          try {
            history.replaceState(null, '', canonicalHash);
            activeHash = canonicalHash;
          } catch {
            // A constrained embedder may reject History writes. The retry is
            // still safe; only one-shot address cleanup degrades.
          }
        }
      }
      if (postSafeStopRecoveryResolution.status === 'unbound') {
        const canonicalHash = serializeShellRoute('connections', 'others');
        replaceActiveHashWithoutNavigation(canonicalHash);
      }
      const connectionsRoute = bootstrapConnectionsRoute({
        root: appShell.contentRoot,
        ...(options.document !== undefined ? { document: options.document } : {}),
        navigate: navigateHash,
        // Deep link — segment 0 = the lane tab (mail/calendar/file/others),
        // segment 1 = a foundational account to open in detail, OR the
        // `enroll` verb with segment 2 = a vendor to pre-open the Others
        // enroll form for (`#connections/others/enroll/<vendor>` — the packs
        // "Set up" CTA), OR the one-shot credential-retry return consumed
        // above.
        ...(connectionsSegments[0] !== undefined
          ? { initialTab: connectionsSegments[0] }
          : {}),
        ...(connectionsSegments[1] !== undefined
          ? { initialDetailSlug: connectionsSegments[1] }
          : {}),
        ...(connectionsSegments[1] === 'enroll'
          && connectionsSegments[2] !== undefined
          ? { initialEnrollVendor: connectionsSegments[2] }
          : {}),
        ...(initialCredentialRotationServerUpdateRetry !== null
          ? {
              initialCredentialRotationServerUpdateRetry,
            }
          : {}),
        ...(initialPostSafeStopRecovery !== null
          ? { initialPostSafeStopRecovery }
          : {}),
        postSafeStopProfileLabel: bootProfileLabel,
        ...(postSafeStopProfileHandoff !== null
          ? { postSafeStopProfileHandoff }
          : {}),
        ...(accountMenu !== null && profileStore !== undefined
          ? {
              onOpenPostSafeStopServerProfiles: () => accountMenu?.open(),
            }
          : {}),
        onPostSafeStopProfileHandoffSettled: () => {
          const canonicalHash = serializeShellRoute('connections', 'others');
          settledProfileRecoveryNeedsAddressCleanup =
            !replaceActiveHashWithoutNavigation(canonicalHash);
        },
        ...(exactReturnOwned
          && initialCredentialRotationServerUpdateCompletion !== null
          ? {
              initialCredentialRotationServerUpdateCompletion,
            }
          : {}),
        onCredentialRotationServerUpdateRetrySettled: (target) => {
          retireServerUpdateReturn(target);
        },
        onCredentialRotationCleanEditorReady: (target) => {
          if (
            !credentialRotationServerUpdateContinuity
              .markExactEditorReady(target)
          ) {
            throw new Error(
              'credential rotation clean-editor continuity was not accepted',
            );
          }
        },
        onCredentialRotationCleanEditorChanged: (target) => {
          retireServerUpdateReturn(target);
        },
        onCredentialRotationServerUpdateRetryInterrupted: (target) => {
          credentialRotationServerUpdateContinuity
            .interruptExactReturn(target);
        },
        ...(accountMenu !== null
          ? {
              onOpenCredentialRotationServerUpdateGuide: (target) => {
                const current =
                  credentialRotationServerUpdateContinuity.read();
                const preservedTriage = current !== null
                  && current.phase === 'triage'
                  && current.kind === target.kind
                  && current.name === target.name;
                if (!preservedTriage) {
                  credentialRotationServerUpdateContinuity.begin(target);
                }
                accountMenu?.openServerUpdateGuide(
                  accountServerUpdateGuideFor(target),
                );
              },
            }
          : {}),
        // Foundational lanes (Mail · Calendar · Files).
        ...(connectionsMailLane !== undefined ? { mail: connectionsMailLane } : {}),
        ...(connectionsCalendarLane !== undefined
          ? { calendar: connectionsCalendarLane }
          : {}),
        ...(connectionsFileLane !== undefined ? { file: connectionsFileLane } : {}),
        ...(connectionsGetOAuthClientConfig !== undefined
          ? { getOAuthClientConfig: connectionsGetOAuthClientConfig }
          : {}),
        ...(connectionsGetOAuthAppConfig !== undefined
          ? { getOAuthAppConfig: connectionsGetOAuthAppConfig }
          : {}),
        ...(connectionsSetOAuthAppConfig !== undefined
          ? { setOAuthAppConfig: connectionsSetOAuthAppConfig }
          : {}),
        foundationalOAuthContinuity,
        providerSetupContinuity,
        credentialRotationContinuity,
        ...(credentialRotationTabConvergence !== null
          ? { credentialRotationTabConvergence }
          : {}),
        credentialRotationServerUpdateContinuity,
        onReconnect: (listener) => connectionStatus.onStatus((status) => {
          if (status === 'connected') listener();
        }),
        ...(options.now !== undefined ? { now: options.now } : {}),
        // Others — the operation-group grant surface, beneath the enroll form.
        ...(connectionsGrantListCaller !== undefined
          && connectionsListGroupsCaller !== undefined
          && connectionsGrantGroupCaller !== undefined
          && connectionsRevokeGroupCaller !== undefined
          ? {
              connectionsListCaller: connectionsGrantListCaller,
              connectionsListGroupsCaller,
              connectionsGrantGroupCaller,
              connectionsRevokeGroupCaller,
            }
          : {}),
        // Others — the generic connection.* REACH enroll panel.
        ...(connectionsEnrollListCaller !== undefined
          && connectionsEnrollCaller !== undefined
          && connectionsUpdateCaller !== undefined
          && connectionsRotateCredentialsCaller !== undefined
          && connectionsDeleteCaller !== undefined
          && connectionsProbeCaller !== undefined
          ? {
              connectionsEnrollListCaller,
              connectionsEnrollCaller: switchWorkTracker.track(
                connectionsEnrollCaller,
              ),
              connectionsUpdateCaller: switchWorkTracker.track(
                connectionsUpdateCaller,
              ),
              connectionsRotateCredentialsCaller: switchWorkTracker.track(
                connectionsRotateCredentialsCaller,
              ),
              ...(connectionsCredentialRotationStatusCaller !== undefined
                ? { connectionsCredentialRotationStatusCaller }
                : {}),
              ...(connectionsCredentialRotationActivityCaller !== undefined
                ? { connectionsCredentialRotationActivityCaller }
                : {}),
              ...(connectionsAcknowledgeCredentialRotationSafeStopCaller
                !== undefined
                ? {
                    connectionsAcknowledgeCredentialRotationSafeStopCaller:
                      switchWorkTracker.track(
                        connectionsAcknowledgeCredentialRotationSafeStopCaller,
                      ),
                  }
                : {}),
              ...(connectionsCredentialRotationServerUpdateTriageCaller
                !== undefined
                ? {
                    connectionsCredentialRotationServerUpdateTriageCaller,
                  }
                : {}),
              connectionsDeleteCaller: switchWorkTracker.track(
                connectionsDeleteCaller,
              ),
              connectionsProbeCaller: switchWorkTracker.track(
                connectionsProbeCaller,
              ),
              ...(connectionsMcpPackPreviewCaller !== undefined
                ? {
                    connectionsMcpPackPreviewCaller: switchWorkTracker.track(
                      connectionsMcpPackPreviewCaller,
                    ),
                  }
                : {}),
              ...(connectionsMcpPackCommitCaller !== undefined
                ? {
                    connectionsMcpPackCommitCaller: switchWorkTracker.track(
                      connectionsMcpPackCommitCaller,
                    ),
                  }
                : {}),
              ...(connectionsSuggestSetupCaller !== undefined
                ? {
                    connectionsSuggestSetupCaller: switchWorkTracker.track(
                      connectionsSuggestSetupCaller,
                    ),
                  }
                : {}),
              connectionsGetMatchPatternsCaller,
              ...(connectionsSetMatchPatternsCaller !== undefined
                ? {
                    connectionsSetMatchPatternsCaller: switchWorkTracker.track(
                      connectionsSetMatchPatternsCaller,
                    ),
                  }
                : {}),
              ...(connectionsPreviewPurgeCaller !== undefined
                ? { connectionsPreviewPurgeCaller }
                : {}),
            }
          : {}),
        ...(connectionsEngagementHealthCaller !== undefined
          ? { connectionsEngagementHealthCaller }
          : {}),
        ...(connectionsReprobeEngagementCapabilitiesCaller !== undefined
          ? {
              connectionsReprobeEngagementCapabilitiesCaller:
                switchWorkTracker.track(
                  connectionsReprobeEngagementCapabilitiesCaller,
                ),
            }
          : {}),
        // Fork 1 B — reuse the packs.list caller so the enroll dialog can
        // pre-fill the editable vendor-scope field from installed packs' needs.
        ...(packsListCaller !== undefined
          ? { connectionsPacksListCaller: packsListCaller }
          : {}),
        ...(connectionsMailListCaller !== undefined
          ? { connectionsMailListCaller }
          : {}),
        ...(connectionsCompleteVendorOAuthCaller !== undefined
          ? {
              connectionsCompleteVendorOAuthCaller: switchWorkTracker.track(
                connectionsCompleteVendorOAuthCaller,
              ),
            }
          : {}),
        ...(connectionsStartVendorOAuthCaller !== undefined
          && connectionsTakeVendorOAuthResultCaller !== undefined
          ? {
              connectionsStartVendorOAuthCaller: switchWorkTracker.track(
                connectionsStartVendorOAuthCaller,
              ),
              connectionsTakeVendorOAuthResultCaller: switchWorkTracker.track(
                connectionsTakeVendorOAuthResultCaller,
              ),
            }
          : {}),
        ...(webhooksListCaller !== undefined
          && webhooksCreateCaller !== undefined
          && webhooksCredentialWriteCaller !== undefined
          && webhooksCredentialRetireCaller !== undefined
          && webhooksManualConfirmCaller !== undefined
          && webhooksRegistrationReconcileCaller !== undefined
          && webhooksEnableCaller !== undefined
          && webhooksDisableCaller !== undefined
          && webhooksTestDeliveryCaller !== undefined
          && webhooksDeliveryListCaller !== undefined
          && webhooksDeliveryGetCaller !== undefined
          && webhooksDeliveryEventGetCaller !== undefined
          && webhooksRejectedDeliveryListCaller !== undefined
          && webhooksRetireCaller !== undefined
          && webhooksRetentionPruneCaller !== undefined
          ? {
              webhooksListCaller,
              webhooksCreateCaller: switchWorkTracker.track(webhooksCreateCaller),
              webhooksCredentialWriteCaller: switchWorkTracker.track(
                webhooksCredentialWriteCaller,
              ),
              webhooksCredentialRetireCaller: switchWorkTracker.track(
                webhooksCredentialRetireCaller,
              ),
              webhooksManualConfirmCaller: switchWorkTracker.track(
                webhooksManualConfirmCaller,
              ),
              webhooksRegistrationReconcileCaller: switchWorkTracker.track(
                webhooksRegistrationReconcileCaller,
              ),
              webhooksEnableCaller: switchWorkTracker.track(webhooksEnableCaller),
              webhooksDisableCaller: switchWorkTracker.track(webhooksDisableCaller),
              webhooksTestDeliveryCaller: switchWorkTracker.track(
                webhooksTestDeliveryCaller,
              ),
              webhooksDeliveryListCaller,
              webhooksDeliveryGetCaller,
              webhooksDeliveryEventGetCaller,
              webhooksRejectedDeliveryListCaller,
              webhooksRetireCaller: switchWorkTracker.track(webhooksRetireCaller),
              webhooksRetentionPruneCaller: switchWorkTracker.track(
                webhooksRetentionPruneCaller,
              ),
            }
          : {}),
        subscribe: subscriber.on,
      });
      const sourceProfileId =
        postSafeStopRecoveryResolution.status === 'profile_mismatch'
          ? postSafeStopRecoveryResolution.target.serverProfileId
          : null;
      const updatePostSafeStopProfileContext = (
        profiles: ReadonlyArray<WebclientServerProfile>,
      ): void => {
        const activeProfile = profiles.find((profile) =>
          profile.id === bootProfileId);
        const activeLabel = activeProfile === undefined
          ? bootProfileLabel
          : activeProfile.label.trim().length > 0
            ? activeProfile.label.trim()
            : defaultProfileLabel(activeProfile.server_url);
        const sourceProfile = sourceProfileId === null
          ? undefined
          : profiles.find((profile) => profile.id === sourceProfileId);
        const sourceLabel = sourceProfile === undefined
          ? undefined
          : sourceProfile.label.trim().length > 0
            ? sourceProfile.label.trim()
            : defaultProfileLabel(sourceProfile.server_url);
        connectionsRoute.setPostSafeStopProfileContext({
          activeProfileLabel: activeLabel,
          ...(sourceLabel !== undefined
            ? { sourceProfileLabel: sourceLabel }
            : {}),
        });
      };
      refreshActivePostSafeStopProfileContext =
        updatePostSafeStopProfileContext;
      if (knownServerProfiles.length > 0) {
        updatePostSafeStopProfileContext(knownServerProfiles);
      }
      if (
        exactReturnOwned
        && initialCredentialRotationServerUpdateCompletion !== null
      ) {
        // The one-shot completion crossed into this first Connections mount as
        // a direct memory value. Retire the verifier's copy only after that
        // mount succeeds, so interruption or a later resume cannot replay the
        // success receipt while mount failure remains recoverable.
        serverUpdateReceiptVerification?.dismissCompletion();
      }
      const trackedConnectionsRoute =
        withTrackedServerSwitchWork(connectionsRoute);
      return {
        ...trackedConnectionsRoute,
        dispose: () => {
          if (
            refreshActivePostSafeStopProfileContext
              === updatePostSafeStopProfileContext
          ) {
            refreshActivePostSafeStopProfileContext = () => undefined;
          }
          trackedConnectionsRoute.dispose();
        },
      };
    }
    if (route === 'packs') {
      activeSettingsRoute = null;
      /** The one run modal the Packs route may have open. Held here (not in the
       *  panel) so the one-modal-at-a-time rule is a property of the route
       *  rather than of whichever surface happened to open it. */
      let packsRunModal: RunModal.RunModalHandle | null = null;
      // The unified `#packs` surface — one list → detail (the [Installed |
      // Discover] tab split is retired). `bootstrapPacksRoute` now composes the
      // browse list (discover panel over the catalog ∪ roster union) → the
      // `#packs/<slug>` detail (the packs panel in detail-only mode, resolving a
      // marketplace pack whose manifest isn't bundled) internally. This branch
      // just forwards the same packs.* + cli.reachability + grant callers.
      return withTrackedServerSwitchWork(bootstrapPacksRoute({
        root: appShell.contentRoot,
        ...(options.document !== undefined ? { document: options.document } : {}),
        ...(packsListCaller !== undefined ? { packsListCaller } : {}),
        ...(packsInstallCaller !== undefined
          ? { packsInstallCaller: switchWorkTracker.track(packsInstallCaller) }
          : {}),
        ...(packsUninstallCaller !== undefined
          ? { packsUninstallCaller: switchWorkTracker.track(packsUninstallCaller) }
          : {}),
        ...(packsResolveCaller !== undefined ? { packsResolveCaller } : {}),
        ...(packsInstallPreviewCaller !== undefined
          ? { packsInstallPreviewCaller }
          : {}),
        ...(packsInstallBySlugCaller !== undefined
          ? {
              packsInstallBySlugCaller: switchWorkTracker.track(
                packsInstallBySlugCaller,
              ),
            }
          : {}),
        ...(sellerOverviewCaller !== undefined ? { sellerOverviewCaller } : {}),
        // ── Use tab — the pack rendered as the app it is ──
        // The SAME list + execute callers the recipes route uses: the pack
        // detail runs a pack's own recipes, so a second execute seam here
        // would be a second place for run semantics to drift.
        recipesListCaller,
        recipeExecuteCaller: switchWorkTracker.track(recipeExecuteCaller),
        // The SAME owner file read the recipes route uses — a verified file
        // card opens on identical terms wherever it renders.
        fileReadCaller: (args) => rpcConn.call('data.file.read', args),
        // The SAME pack-owned Records inventory as the Recipes route. Ref
        // cells in a Use-tab editable table therefore become scoped name
        // pickers instead of asking the owner to type a durable id.
        recordRefSearchCaller,
        // The pack's operations open the shared Run | Schedule modal. Owned at
        // the route so one-modal-at-a-time holds; `onRan` hands the returned
        // output back to Pack Use, where it becomes the current task result.
        openRunModal: (entry, onRan, prefill) => {
          if (packsRunModal !== null) return;
          const runRecordRefSearch = bindRecordRefSearchToRecipe(
            recordRefSearchCaller,
            entry.recipe,
          );
          packsRunModal = RunModal.wireRunModal({
            recipe: entry,
            ...(options.document !== undefined ? { document: options.document } : {}),
            initialTab: 'run',
            execute: switchWorkTracker.track(recipeExecuteCaller),
            fileRefSearch: fileRefSearchCaller,
            ...(runRecordRefSearch !== undefined
              ? { recordRefSearch: runRecordRefSearch }
              : {}),
            onClose: () => { packsRunModal = null; },
            ...(onRan !== undefined ? { onRan } : {}),
          });
          // A row action carries the chosen record — fill the form with it, so
          // "Open" on a building row opens `show-building` already pointed at
          // that building. Mirrors the recipes route's own prefill.
          if (prefill?.config !== undefined) {
            let configText = '{}';
            try {
              configText = JSON.stringify(prefill.config, null, 2) ?? '{}';
            } catch {
              configText = '{}';
            }
            packsRunModal.setConfigText(configText);
          }
          if (prefill?.context !== undefined) {
            packsRunModal.setContextValues(prefill.context);
          }
          // ⛔⛔ ATTACH IT. `wireRunModal` BUILDS the overlay and never mounts it
          // — "the host appends it to `document.body` (or its own portal)". The
          // other five hosts do; this one did not, so every Pack Use press wired
          // a modal into nothing, showed nothing, and then LATCHED: the
          // `packsRunModal !== null` guard above turned every later press on
          // every button into a silent no-op for the rest of the session.
          //
          // That is why it read as "the buttons are not clickable" — the click
          // handler ran correctly every time, all the way to a modal that was
          // never on screen.
          //
          // Portal to body so a route repaint cannot wipe an open run; the
          // fake-doc tests have no `body`, so they fall back to the route root
          // (same shape as the recipes route).
          const packsModalPortal = (doc as { body?: HTMLElement }).body
            ?? appShell.contentRoot;
          packsModalPortal.appendChild(packsRunModal.element);
        },
        ...(supervisionListCaller !== undefined ? { supervisionListCaller } : {}),
        ...(supervisionSetCaller !== undefined
          ? { supervisionSetCaller: switchWorkTracker.track(supervisionSetCaller) }
          : {}),
        // Forwarded INDEPENDENTLY. These used to ride an all-three gate because
        // the retired Local tools section needed the universe+list+set trio to
        // mount; each now has its own consumer on the pack detail, so an
        // all-three gate would strip ACCESS's cli toggles on a server that
        // serves list/set but not universe.
        ...(localToolsUniverseCaller !== undefined
          ? { localToolsUniverseCaller }
          : {}),
        ...(localToolsListCaller !== undefined ? { localToolsListCaller } : {}),
        ...(localToolsSetCaller !== undefined
          ? { localToolsSetCaller: switchWorkTracker.track(localToolsSetCaller) }
          : {}),
        ...(localToolsContractsCaller !== undefined
          ? { localToolsContractsCaller }
          : {}),
        // Reuse the unfiltered enrolled-connection list (same caller the
        // connections + recipes routes use) so each pack row can show
        // connection scope readiness. Soft: absent → no readiness block.
        ...(connectionsEnrollListCaller !== undefined
          ? { connectionsListCaller: connectionsEnrollListCaller }
          : {}),
        // R3 — by-PACK Access (the detail's ACCESS section). Reuses the
        // #contracts grant callers; contracts + cli list/set ride the
        // local-tools callers forwarded above. Soft: absent → placeholder.
        ...(grantReadCaller !== undefined
          ? { contractGrantReadCaller: grantReadCaller }
          : {}),
        ...(grantWriteCaller !== undefined
          ? {
              contractGrantWriteCaller: switchWorkTracker.track(
                grantWriteCaller,
              ),
            }
          : {}),
        ...(grantCatalogOperationsCaller !== undefined
          ? { catalogOperationsCaller: grantCatalogOperationsCaller }
          : {}),
        ...(ownerOperationInventoryCaller !== undefined
          ? { ownerOperationInventoryCaller }
          : {}),
        ...(ownerOperationListCaller !== undefined
          ? { ownerOperationListCaller }
          : {}),
        ...(ownerOperationUpsertCaller !== undefined
          ? {
              ownerOperationUpsertCaller: switchWorkTracker.track(
                ownerOperationUpsertCaller,
              ),
            }
          : {}),
        ...(ownerOperationDeleteCaller !== undefined
          ? {
              ownerOperationDeleteCaller: switchWorkTracker.track(
                ownerOperationDeleteCaller,
              ),
            }
          : {}),
        // The Access panel's contract rows ride the SAME flag family as the
        // grant callers (enableContractsPanel) — the local-tools contracts
        // caller alone would strand the panel when local-tools is disabled.
        ...(grantListContractsCaller !== undefined
          ? { accessContractsCaller: grantListContractsCaller }
          : {}),
        // list→detail — seed the DETAIL selection from `#packs/<slug>` (mirrors
        // the recipes route). Undefined segment ⇒ the LIST view.
        ...(hashSource !== null
          ? { initialPackSlug: deepLinkSegment('packs') }
          : {}),
        // Keep the router's cached `activeHash` in lockstep with an in-page
        // pack selection (which uses `replaceState`, firing no hashchange).
        // Without this, a later hashchange to the slug that was mounted BEFORE
        // the in-page selection would normalize-equal the stale `activeHash`
        // and be dropped as a no-op, stranding the panel on the wrong pack.
        onHashSync: (hash) => {
          activeHash = hash;
        },
        subscribe: subscriber.on,
      }));
    }
    if (route === 'recipes') {
      activeSettingsRoute = null;
      const recipeSegment = deepLinkSegment('recipes');
      const recipeInstallIntent = recipeSegment === 'install'
        ? deepLinkSegment('recipes', 1)
        : undefined;
      const initialRecipeId = recipeSegment !== 'install'
        ? recipeSegment
        : undefined;
      const createRecipeSchedule: RecipesSchedulesCreateCaller = (args) =>
        rpcConn.call('schedules.create', args);
      const setRecipeConfig: RecipeConfigSetCaller = (args) =>
        rpcConn.call('recipe_config.set', args);
      // Wrap the run-library route in the [Installed | Discover] tab shell. The
      // route mounts UNCHANGED into the Installed pane; the Discover pane
      // browses the marketplace recipe catalog (lazy-loaded on first open).
      const mountInstalled = (host: HTMLElement) =>
        bootstrapRecipesRoute({
          root: host,
          ...(options.document !== undefined ? { document: options.document } : {}),
          recipesListCaller,
          recipeExecuteCaller: switchWorkTracker.track(recipeExecuteCaller),
          runnabilityCaller: recipesRunnabilityCaller,
          piiCaller: recipesPiiCaller,
          ...(recipesToolCatalogCaller !== undefined
            ? { toolCatalogCaller: recipesToolCatalogCaller }
            : {}),
          // UX-review flow-10 — reuse the unfiltered enrolled-connection list so
          // the per-recipe provenance can show connected / needs-setup per
          // connection. Optional + soft: absent → provenance shows need + CTA only.
          ...(connectionsEnrollListCaller !== undefined
            ? { connectionsListCaller: connectionsEnrollListCaller }
            : {}),
          // D-221 — the installed-pack roster backs the recipe detail's Records
          // disclosure (what a recipe reads / writes / DELETES in pack-owned
          // storage) and its author-declared risk, both joined from each
          // manifest's composition operation rows. Optional + soft: absent →
          // the disclosure says the roster is unavailable.
          ...(packsListCaller !== undefined ? { packsListCaller } : {}),
          // R24 — pack install/uninstall moved to the dedicated #packs route
          // (the recipes route keeps only the by-pack FILTER).
          // Schedule callers light up the shared Run | Schedule modal's
          // Schedule tab (quick-schedule from a recipe's detail); the list
          // callers feed the automation status line. Trigger management lives
          // at #automation; bundled recipes also get a quick auto-run toggle.
          dishesListCaller: automationDishesListCaller,
          schedulesListCaller: automationSchedulesListCaller,
          schedulesCreateCaller: switchWorkTracker.track(createRecipeSchedule),
          schedulesUpdateCaller: switchWorkTracker.track(
            automationSchedulesUpdateCaller,
          ),
          schedulesDeleteCaller: switchWorkTracker.track(
            automationSchedulesDeleteCaller,
          ),
          triggersListCaller: automationTriggersListCaller,
          autoRunListCaller: automationAutoRunListCaller,
          autoRunUpdateCaller: switchWorkTracker.track(
            automationAutoRunUpdateCaller,
          ),
          // D-179 — the recipe detail's install-config editor (default-dish
          // overlay applied as a base to every dishless run).
          recipeConfigGetCaller: (args) => rpcConn.call('recipe_config.get', args),
          recipeConfigSetCaller: switchWorkTracker.track(setRecipeConfig),
          fileRefSearchCaller,
          recordRefSearchCaller,
          // D-200 — the same paired-client owner read used by Data Files backs
          // exact artifact preview/download in recipe results. The result host
          // rechecks ref/hash/MIME/name/size before it opens returned bytes.
          fileReadCaller: (args) => rpcConn.call('data.file.read', args),
          // D-195 optional workflow install: these lightweight public
          // projections prove the directly named BulkPackManifest carries all
          // current recipe_bundle members. Catalog failure keeps the CTA
          // closed; a carrier-artifact failure is retryable in the detail.
          recipeCatalogCaller: () => fetchRecipeCatalog(),
          packCatalogCaller: () => fetchPackCatalog(),
          // Tool exposure is per-(recipe × contract) and lives in #contracts —
          // the recipes detail carries no per-recipe exposure toggle (a single
          // global toggle can't express "exposed via contract A but not B").
          ...(hashSource !== null && initialRecipeId !== undefined
            ? { initialRecipeId }
            : {}),
          // Recipe list/detail navigation uses replaceState, so it must update
          // the router cache explicitly just like Packs and Automation do.
          onHashSync: (hash) => {
            activeHash = hash;
          },
          subscribe: subscriber.on,
        });
      let recipeDiscover: ReturnType<typeof mountRecipeDiscovery> | null = null;
      return withTrackedServerSwitchWork(mountDiscoverySurface({
        root: appShell.contentRoot,
        ...(options.document !== undefined ? { document: options.document } : {}),
        idPrefix: 'recued-recipes-library',
        tabListLabel: 'Recipe library sections',
        mountInstalled,
        mountDiscover: (host) => {
          recipeDiscover = mountRecipeDiscovery({
            host,
            ...(options.document !== undefined ? { document: options.document } : {}),
            installBySlug: switchWorkTracker.track(recipeInstallBySlugCaller),
            listInstalled: recipesListCaller,
            // Deps box — resolve the recipe's depends_on against the pack roster
            // and co-install missing packs in the consent dialog. Both gate on
            // the packs feature (absent ⇒ one-click install).
            ...(packsListCaller !== undefined ? { listPacks: packsListCaller } : {}),
            ...(packsInstallBySlugCaller !== undefined
              ? {
                  installPack: switchWorkTracker.track(
                    packsInstallBySlugCaller,
                  ),
                }
              : {}),
            ...(recipeInstallIntent !== undefined
              ? { initialInstallRecipeId: recipeInstallIntent }
              : {}),
            subscribe: subscriber.on,
          });
          return recipeDiscover;
        },
        ...(recipeInstallIntent !== undefined
          ? { initialTab: 'discover' as const }
          : {}),
        // "Parse the version regularly" — on each return to Discover, re-run the
        // current query AND re-read the installed roster's catalogue versions,
        // so upgrade badges reflect fresh upstream versions. (Server search +
        // the bounded `/catalog/versions` lookup replace the old whole-corpus
        // re-download; the surface's `refresh` drives both.)
        onReactivate: (tab) => {
          if (tab === 'discover') recipeDiscover?.refresh();
        },
      }));
    }
    if (route === 'data') {
      activeSettingsRoute = null;
      const parsedDataRoute = hashSource === null
        ? null
        : parseShellRoute(hashSource.getHash());
      const sourceRecordAddress = parsedDataRoute === null
        ? null
        : parseSourceRecordAddress(parsedDataRoute);
      const sourceRecordVerificationAddress = parsedDataRoute === null
        ? null
        : parseSourceRecordVerificationAddress(parsedDataRoute);
      const dataEntityVerificationAddress = parsedDataRoute === null
        ? null
        : parseDataEntityVerificationAddress(parsedDataRoute);
      return withTrackedServerSwitchWork(bootstrapDataRoute({
        root: appShell.contentRoot,
        ...(options.document !== undefined ? { document: options.document } : {}),
        workEntitySourceListCaller: dataWorkEntitySourceListCaller,
        workEntityListCaller: dataWorkEntityListCaller,
        workEntityGetCaller: dataWorkEntityGetCaller,
        workEntityUpsertCaller: dataWorkEntityUpsertCaller,
        workEntityDeleteCaller: dataWorkEntityDeleteCaller,
        contactListCaller: dataContactListCaller,
        contactGetCaller: dataContactGetCaller,
        contactContributionsCaller: dataContactContributionsCaller,
        contactUpsertCaller: dataContactUpsertCaller,
        contactDeleteCaller: dataContactDeleteCaller,
        contactMergeListCaller: dataContactMergeListCaller,
        contactMergeConfirmCaller: dataContactMergeConfirmCaller,
        contactMergeRejectCaller: dataContactMergeRejectCaller,
        contactMergeScanNowCaller: dataContactMergeScanNowCaller,
        contactSourceListCaller: dataContactSourceListCaller,
        contactImportCandidatesCaller: dataContactImportCandidatesCaller,
        contactImportPromoteCaller: dataContactImportPromoteCaller,
        contactImportFilePreviewCaller: dataContactImportFilePreviewCaller,
        contactImportFileApplyCaller: dataContactImportFileApplyCaller,
        formResponseListCaller: dataFormResponseListCaller,
        formResponseGetCaller: dataFormResponseGetCaller,
        formResponseUpdateCaller: dataFormResponseUpdateCaller,
        formResponseSetStateCaller: dataFormResponseSetStateCaller,
        formResponseExportCaller: dataFormResponseExportCaller,
        recipeListCaller: recipesListCaller,
        recipeExecuteCaller: switchWorkTracker.track(recipeExecuteCaller),
        manageRescheduleLinkCaller,
        timelineCaller: dataTimelineCaller,
        mirrorSearchCaller: dataMirrorSearchCaller,
        memoryListCaller: dataMemoryListCaller,
        memoryGetCaller: dataMemoryGetCaller,
        memoryCreateCaller: dataMemoryCreateCaller,
        memoryUpdateCaller: dataMemoryUpdateCaller,
        memoryDeleteCaller: dataMemoryDeleteCaller,
        memoryImportCaller: dataMemoryImportCaller,
        collectionListInstancesCaller: dataCollectionListInstancesCaller,
        collectionListCaller: dataCollectionListCaller,
        collectionGetCaller: dataCollectionGetCaller,
        annotationListCaller: dataAnnotationListCaller,
        linkListCaller: dataLinkListCaller,
        sharedListCaller: dataSharedListCaller,
        recordsNamespaceListCaller: dataRecordsNamespaceListCaller,
        recordsKindListCaller: dataRecordsKindListCaller,
        recordsSearchCaller: dataRecordsSearchCaller,
        recordsGetCaller: dataRecordsGetCaller,
        recordsDeleteCaller: dataRecordsDeleteCaller,
        recordsRetentionListCaller: dataRecordsRetentionListCaller,
        recordsExportCaller: dataRecordsExportCaller,
        recordsOutboxListCaller: dataRecordsOutboxListCaller,
        recordsOutboxRetireCaller: dataRecordsOutboxRetireCaller,
        recordsPurgeCaller: dataRecordsPurgeCaller,
        uploadCreateCaller: dataUploadCreateCaller,
        uploadProbeCaller: dataUploadProbeCaller,
        uploadFinalizeCaller: dataUploadFinalizeCaller,
        uploadDeleteCaller: dataUploadDeleteCaller,
        uploadConnectFactory,
        fileReadCaller: dataFileReadCaller,
        // Exact citation route wins over the legacy positional deep link. It
        // carries the collection instance needed to disambiguate two accounts.
        ...(sourceRecordAddress !== null
          ? { initialTab: sourceRecordAddress.tab }
          : sourceRecordVerificationAddress !== null
            ? { initialTab: sourceRecordVerificationAddress.tab }
            : dataEntityVerificationAddress !== null
              ? { initialTab: dataEntityVerificationAddress.tab }
          : deepLinkSegment('data') !== undefined
            ? { initialTab: deepLinkSegment('data') }
            : {}),
        ...(sourceRecordAddress !== null
          ? { initialCollectionSlug: sourceRecordAddress.collectionSlug }
          : {}),
        ...(sourceRecordAddress !== null
          ? { initialEntityId: sourceRecordAddress.recordId }
          : sourceRecordVerificationAddress !== null
            ? { initialEntityId: sourceRecordVerificationAddress.recordId }
            : dataEntityVerificationAddress !== null
              ? { initialEntityId: dataEntityVerificationAddress.entityId }
          : deepLinkSegment('data', 1) !== undefined
            ? { initialEntityId: deepLinkSegment('data', 1) }
            : {}),
        ...(sourceRecordAddress?.returnToChat !== undefined
          ? { chatReturn: sourceRecordAddress.returnToChat }
          : {}),
        ...(sourceRecordAddress?.returnToRun !== undefined
          ? { logsReturn: sourceRecordAddress.returnToRun }
          : sourceRecordVerificationAddress !== null
            ? { logsReturn: sourceRecordVerificationAddress.returnToRun }
            : dataEntityVerificationAddress !== null
              ? { logsReturn: dataEntityVerificationAddress.returnToRun }
              : {}),
        ...(sourceRecordVerificationAddress !== null
          ? { verifyInitialSourceRecord: true }
          : {}),
        ...(sourceRecordAddress !== null
          && sourceRecordAddress.returnToRun !== undefined
          && sourceRecordAddress.verificationRelationship !== undefined
          ? {
              verificationRelationship:
                sourceRecordAddress.verificationRelationship,
            }
          : sourceRecordVerificationAddress?.verificationRelationship
              !== undefined
            ? {
                verificationRelationship:
                  sourceRecordVerificationAddress.verificationRelationship,
              }
            : dataEntityVerificationAddress?.verificationRelationship
                !== undefined
              ? {
                  verificationRelationship:
                    dataEntityVerificationAddress.verificationRelationship,
                }
              : {}),
        // Data changes tabs and opens/closes details with replaceState, so no
        // hashchange reaches the shell. Keep the router cache aligned or a
        // later navigation back to the pre-detail hash is dropped as a no-op.
        onHashSync: (hash) => {
          activeHash = hash;
        },
        subscribe: subscriber.on,
      }));
    }
    if (route === 'automation') {
      activeSettingsRoute = null;
      const createAutomationSchedule: RunModal.RunModalSchedulesCreateCaller =
        (args) => rpcConn.call('schedules.create', args);
      const createAutomationTrigger: RunModal.RunModalTriggersCreateCaller =
        (args) => rpcConn.call('triggers.create', args);
      return withTrackedServerSwitchWork(bootstrapAutomationRoute({
        root: appShell.contentRoot,
        ...(options.document !== undefined ? { document: options.document } : {}),
        schedulesListCaller: automationSchedulesListCaller,
        schedulesUpdateCaller: switchWorkTracker.track(
          automationSchedulesUpdateCaller,
        ),
        schedulesDeleteCaller: switchWorkTracker.track(
          automationSchedulesDeleteCaller,
        ),
        triggersListCaller: automationTriggersListCaller,
        triggersUpdateCaller: switchWorkTracker.track(
          automationTriggersUpdateCaller,
        ),
        triggersDeleteCaller: switchWorkTracker.track(
          automationTriggersDeleteCaller,
        ),
        dishesListCaller: automationDishesListCaller,
        dishesUpdateCaller: switchWorkTracker.track(
          automationDishesUpdateCaller,
        ),
        dishesDeleteCaller: switchWorkTracker.track(
          automationDishesDeleteCaller,
        ),
        dishesCreateCaller: switchWorkTracker.track(
          automationDishesCreateCaller,
        ),
        dishesHistoryCaller: automationDishesHistoryCaller,
        autoRunListCaller: automationAutoRunListCaller,
        autoRunUpdateCaller: switchWorkTracker.track(
          automationAutoRunUpdateCaller,
        ),
        watchListCaller: automationWatchListCaller,
        watchUpdateCaller: switchWorkTracker.track(
          automationWatchUpdateCaller,
        ),
        watchRunNowCaller: switchWorkTracker.track(
          automationWatchRunNowCaller,
        ),
        recipeNamesCaller,
        authStateCaller: automationAuthStateCaller,
        // R21 create path — Add → recipe picker → the shared run-modal on
        // the Schedule|Trigger tab.
        recipeEntriesCaller: () => rpcConn.call('recipe.list', undefined),
        schedulesCreateCaller: switchWorkTracker.track(
          createAutomationSchedule,
        ),
        triggersCreateCaller: switchWorkTracker.track(createAutomationTrigger),
        fileRefSearchCaller,
        // R21 — keep the router's cached activeHash in lockstep with the
        // route's in-page replaceState syncs (tab/detail changes fire no
        // hashchange; same seam as the packs route).
        onHashSync: (hash) => {
          activeHash = hash;
        },
        // R21 — `#automation/<section>` picks a tab; any OTHER first
        // segment keeps the legacy recipe-focus meaning (the Recipes R24
        // detail links `#automation/<recipe-id>`).
        ...(() => {
          const seg = hashSource !== null ? deepLinkSegment('automation') : undefined;
          if (seg === undefined || seg.length === 0) return {};
          if (!isAutomationSectionToken(seg)) return { initialRecipeFilter: seg };
          // `#automation/<section>/<id>` — segment 1 deep-links a detail.
          const detail = deepLinkSegment('automation', 1);
          return {
            initialSection: seg,
            ...(detail !== undefined && detail.length > 0
              ? { initialDetailId: detail }
              : {}),
          };
        })(),
        ...(options.now !== undefined ? { now: options.now } : {}),
        subscribe: subscriber.on,
      }));
    }
    if (route === 'logs') {
      activeSettingsRoute = null;
      // R17 — `#logs/active` mounts the full operator console; `#logs/<run_id>`
      // deep-links a run's detail; bare `#logs` is the default History view.
      // R24 follow-on — `#logs/recipe/<recipe_id>` opens History pre-scoped to a
      // recipe's runs (the recipe detail's "View runs in Logs" link).
      const parsedLogsRoute = hashSource === null
        ? null
        : parseShellRoute(hashSource.getHash());
      const logsRunAddress = parsedLogsRoute === null
        ? null
        : parseLogsRunAddress(parsedLogsRoute);
      const logsSegment = deepLinkSegment('logs');
      const logsRecipeId = deepLinkSegment('logs', 1);
      return withTrackedServerSwitchWork(bootstrapLogsRoute({
        root: appShell.contentRoot,
        ...(options.document !== undefined ? { document: options.document } : {}),
        listCaller: runsListCaller,
        getCaller: runsGetCaller,
        activeCaller: runsActiveCaller,
        killCaller: runsKillCaller,
        cancelCaller: runsCancelCaller,
        promoteCaller: runsPromoteCaller,
        // D-186 Slice C — the Runs "Active passes" (session-grant) section.
        grantsListCaller: runsGrantsListCaller,
        grantsRevokeCaller: runsGrantsRevokeCaller,
        // ★ ref-picker — backs the Recipe filter combobox.
        recipeNamesCaller,
        ...(logsSegment === 'active'
          ? { initialView: 'active' as const }
          : logsSegment === 'recipe' && logsRecipeId !== undefined
            ? { initialRecipeId: logsRecipeId }
            : logsRunAddress !== null
              ? {
                  initialRunId: logsRunAddress.runId,
                  ...(logsRunAddress.returnToChat !== undefined
                    ? { chatReturn: logsRunAddress.returnToChat }
                    : {}),
                }
              : logsSegment !== undefined
                ? { initialRunId: logsSegment }
              : {}),
        // Run selection uses replaceState so the History table can keep its
        // scroll/load state. Tell the shell which run the mount now owns.
        onHashSync: (hash) => {
          activeHash = hash;
        },
        ...(options.now !== undefined ? { now: options.now } : {}),
        subscribe: subscriber.on,
      }));
    }
    if (route === 'chat') {
      activeSettingsRoute = null;
      const parsedChatRoute = hashSource === null
        ? null
        : parseShellRoute(hashSource.getHash());
      const chatAnswerAddress = parsedChatRoute === null
        ? null
        : parseChatAnswerAddress(parsedChatRoute);
      const chatPlanAddress = parsedChatRoute === null
        ? null
        : parseChatPlanAddress(parsedChatRoute);
      const chatSessionAddress = parsedChatRoute === null
        ? null
        : parseChatSessionAddress(parsedChatRoute);
      const chatDeepLink = deepLinkSegment('chat');
      const chatSessionId = chatPlanAddress?.sessionId
        ?? chatAnswerAddress?.sessionId
        ?? chatSessionAddress?.sessionId;
      const chatConnectedSource = hashSource === null
        ? null
        : parseChatConnectedSource(parseShellRoute(hashSource.getHash()));
      const chatConnectedSourceLane = chatConnectedSource === null
        ? undefined
        : chatConnectedSource.lane === 'mail'
          ? connectionsMailLane
          : chatConnectedSource.lane === 'calendar'
            ? connectionsCalendarLane
            : connectionsFileLane;
      const createChatSchedule: RunModal.RunModalSchedulesCreateCaller =
        (args) => rpcConn.call('schedules.create', args);
      const rawChatConn = rpcConn.call as unknown as (
        method: string,
        payload?: unknown,
      ) => Promise<unknown>;
      const chatConn = ((method: string, payload?: unknown): Promise<unknown> => {
        const invoke = (): Promise<unknown> => payload === undefined
          ? rawChatConn(method)
          : rawChatConn(method, payload);
        if (method !== 'chat.send') return invoke();
        const release = switchWorkTracker.begin({
          label: 'Waiting for a Chat answer',
          returnHref: activeHash,
          returnLabel: 'Return to Chat',
        });
        chatTurnLeases.add(release);
        let result: Promise<unknown>;
        try {
          result = invoke();
        } catch (error) {
          releaseChatTurnLease(release);
          throw error;
        }
        return result.then(
          (value) => {
            const turnId = value !== null
              && typeof value === 'object'
              && typeof (value as { turn_id?: unknown }).turn_id === 'string'
              ? (value as { turn_id: string }).turn_id
              : null;
            if (turnId === null || settledChatTurnIds.delete(turnId)) {
              releaseChatTurnLease(release);
            } else {
              release.update({ jobId: turnId });
              chatTurnLeaseById.set(turnId, release);
            }
            return value;
          },
          (error: unknown) => {
            releaseChatTurnLease(release);
            throw error;
          },
        );
      }) as ChatRouteConn;
      // The live-control "running" bubble was lifted out of the chat header into
      // route-independent shell chrome (`liveControlBubble`, mounted above), so
      // the chat route no longer wires the `execution.*` callers.
      const chatRoute = bootstrapChatRoute({
        root: appShell.contentRoot,
        conn: chatConn,
        // D-172 P2 — the same `upload.*` control plane + binary socket the
        // Data → Files panel uses, so a file dropped in Chat lands in the ONE
        // `data.file` inventory rather than a second one. Passed as a pair: the
        // route renders the attach control only when both are present, because
        // half-wired it would open a picker that can never finish.
        uploadCallers: {
          create: dataUploadCreateCaller,
          probe: dataUploadProbeCaller,
          finalize: dataUploadFinalizeCaller,
          delete: dataUploadDeleteCaller,
        },
        uploadConnect: uploadConnectFactory,
        ...(options.document !== undefined ? { document: options.document } : {}),
        subscribe: subscriber.on,
        reconnect,
        ...(options.reauthRecovery?.chatDraft !== undefined
          ? { initialRecoveryDraft: options.reauthRecovery.chatDraft }
          : {}),
        // Shell-frame Step 4 — the [✎ Create] composer overlay reuses the
        // compose route's local-write callers.
        contactUpsertCaller: dataContactUpsertCaller,
        workEntityUpsertCaller: dataWorkEntityUpsertCaller,
        // Shell-frame Step 4c — the [▶ Run a recipe] palette: the same
        // recipe.list / execute / schedules.* / auto_run.* callers the
        // Recipes + Automation routes already use.
        recipeListCaller: recipesListCaller,
        recipeExecuteCaller: switchWorkTracker.track(recipeExecuteCaller),
        schedulesListCaller: automationSchedulesListCaller,
        schedulesCreateCaller: switchWorkTracker.track(createChatSchedule),
        schedulesUpdateCaller: switchWorkTracker.track(
          automationSchedulesUpdateCaller,
        ),
        schedulesDeleteCaller: switchWorkTracker.track(
          automationSchedulesDeleteCaller,
        ),
        autoRunListCaller: automationAutoRunListCaller,
        autoRunUpdateCaller: switchWorkTracker.track(
          automationAutoRunUpdateCaller,
        ),
        // The default landing owns the first-run activation surface. Embedded
        // chat mounts opt in explicitly so their established empty state stays
        // stable.
        enableFirstRunActivation: true,
        // Bare Chat is the returning-user history landing. Typed setup/source
        // links and `#chat/new` remain deliberate draft experiences; a
        // session/answer/plan link opens its exact durable thread below.
        initialLanding:
          chatDeepLink === undefined ? 'history' : 'new',
        onAddressChange: (hash, mode) => {
          const history = doc.defaultView?.history;
          const writer = mode === 'push'
            ? history?.pushState
            : history?.replaceState;
          if (writer === undefined) return;
          try {
            writer.call(history, null, '', hash);
            // History API writes do not emit hashchange. Keep the router's
            // deep-link comparison baseline aligned so Back/Forward evaluates
            // against the address the Chat mount actually owns.
            activeHash = hash;
          } catch {
            // Constrained embedders may reject History writes. The in-memory
            // Chat transition still succeeds; only reload/back continuity
            // degrades.
          }
        },
        ...(chatDeepLink === 'start'
          ? { initialStarterPrompt: true }
          : {}),
        ...(chatSessionId !== undefined
          ? { initialSessionId: chatSessionId }
          : {}),
        ...(chatAnswerAddress !== null
          ? { initialMessageId: chatAnswerAddress.messageId }
          : chatPlanAddress?.messageId !== undefined
            ? { initialMessageId: chatPlanAddress.messageId }
            : {}),
        ...(chatPlanAddress !== null
          ? { initialPlanId: chatPlanAddress.planId }
          : {}),
        ...(chatPlanAddress?.dataVerification !== undefined
          ? {
              initialDataVerificationReturn:
                chatPlanAddress.dataVerification,
            }
          : {}),
        ...(chatConnectedSource !== null
          ? {
              initialConnectedSource: chatConnectedSource,
              onConnectedSourceRetired: () => {
                const nextHash = serializeShellRoute('chat');
                const history = doc.defaultView?.history;
                if (history?.replaceState === undefined) return;
                try {
                  history.replaceState(null, '', nextHash);
                  activeHash = nextHash;
                } catch {
                  // A constrained embedder may reject History writes. The
                  // in-memory handoff still retires; the current draft must
                  // not be sacrificed to a remount fallback.
                }
              },
              ...(chatConnectedSourceLane !== undefined
                ? {
                    connectedSourceStatusCaller: async () => {
                      const { instances } = await chatConnectedSourceLane.list();
                      return projectChatConnectedSourceStatus(
                        chatConnectedSource,
                        instances,
                      );
                    },
                  }
                : {}),
            }
          : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      return withTrackedServerSwitchWork({
        ...chatRoute,
        navigateDeepLink: (hash: string): boolean => {
          const address = parseChatPlanAddress(parseShellRoute(hash));
          return address === null
            ? false
            : chatRoute.openPlanLanding(address);
        },
      });
    }
    if (route === 'settings') {
      const sellerRouteMode = deepLinkSegment('settings', 2);
      const chatSetupSessionId =
        deepLinkSegment('settings', 2) === 'session'
          ? deepLinkSegment('settings', 3)
          : undefined;
      const chatSetupConnectedSource =
        hashSource === null
          ? null
          : parseConnectedSourceChatSetup(
              parseShellRoute(hashSource.getHash()),
            );
      const chatSetupReturnHref = chatSetupSessionId === undefined
        ? chatSetupConnectedSource === null
          ? serializeShellRoute('chat', 'start')
          : serializeChatConnectedSource(chatSetupConnectedSource)
        : serializeShellRoute('chat', 'session', chatSetupSessionId);
      const downloadDriver = archiveDownload;
      const trackedArchiveDownload = downloadDriver === undefined
        ? undefined
        : (
            request: Parameters<NonNullable<typeof archiveDownload>>[0],
          ): ReturnType<NonNullable<typeof archiveDownload>> => {
            const release = switchWorkTracker.begin();
            try {
              const cancel = downloadDriver({
                ...request,
                onError: (message) => {
                  release();
                  request.onError(message);
                },
                onDone: () => {
                  release();
                  request.onDone();
                },
              });
              return () => {
                release();
                cancel();
              };
            } catch (error) {
              release();
              throw error;
            }
          };
      const uploadDriver = archiveUpload;
      const trackedArchiveUpload = uploadDriver === undefined
        ? undefined
        : (
            request: Parameters<NonNullable<typeof archiveUpload>>[0],
          ): ReturnType<NonNullable<typeof archiveUpload>> => {
            const release = switchWorkTracker.begin();
            try {
              const cancel = uploadDriver({
                ...request,
                onError: (message) => {
                  release();
                  request.onError(message);
                },
                onDone: (result) => {
                  release();
                  request.onDone(result);
                },
              });
              return () => {
                release();
                cancel();
              };
            } catch (error) {
              release();
              throw error;
            }
          };
      const settings = withTrackedServerSwitchWork(bootstrapSettingsRoute({
        root: appShell.contentRoot,
        localStore: options.localStore,
        // D-196 1d — the same generic runner the Recipes route uses; the Seller
        // page's order actions launch recipes through it rather than each one
        // needing its own `server.seller.*` method.
        recipeExecuteCaller: switchWorkTracker.track(recipeExecuteCaller),
        ...(options.document !== undefined ? { document: options.document } : {}),
        ...(hashSource !== null
          ? {
              initialSectionId: deepLinkSegment('settings'),
              initialServerTabId: deepLinkSegment('settings', 1),
              ...(deepLinkSegment('settings', 1) === 'setup'
                ? { initialAiModelsView: 'chat-setup' as const }
                : {}),
              initialSellerSubpage: deepLinkSegment('settings', 1),
              initialSellerItemId: sellerRouteMode === 'detail'
                ? deepLinkSegment('settings', 3)
                : undefined,
              initialSellerPage: sellerRouteMode === 'page'
                ? deepLinkSegment('settings', 3)
                : undefined,
              // The rail reports the section it switched to so the address
              // names what is on screen and Back has somewhere to land. Every
              // section is already mounted, so the write is a History call —
              // it emits NO hashchange — and `activeHash` is realigned so the
              // shell does not re-mount what it is already showing.
              //
              // EXCEPT when the current address carries state deeper than a
              // section (`#settings/seller/orders`, `#settings/server/<tab>`,
              // `#settings/ai-models/setup`): that state is passed at MOUNT
              // time, so an in-place write would leave the deep view on screen
              // under a shallower address. Navigate for real there and let the
              // hash listener re-mount at the requested section.
              onAddressChange: (hash: string, mode: 'push' | 'replace') => {
                if (parseShellRoute(activeHash).segments.length > 1) {
                  navigateHash(hash);
                  return;
                }
                const history = doc.defaultView?.history;
                const writer = mode === 'push'
                  ? history?.pushState
                  : history?.replaceState;
                if (writer === undefined) return;
                try {
                  writer.call(history, null, '', hash);
                  activeHash = hash;
                  appShell.setActiveRoute(
                    'settings',
                    parseShellRoute(hash).segments,
                  );
                } catch {
                  // A constrained embedder may reject History writes. The
                  // section switch still stands; only address continuity
                  // degrades.
                }
              },
            }
          : {}),
        onChatSetupComplete: () => {
          navigateHash(chatSetupReturnHref);
        },
        ...(chatSetupSessionId !== undefined || chatSetupConnectedSource !== null
          ? { chatSetupReturnHref }
          : {}),
        ...(options.cryptoKeysWiper !== undefined
          ? { cryptoKeysWiper: options.cryptoKeysWiper }
          : {}),
        ...(options.onPrivacyCredentialsCleared !== undefined
          ? {
              onLocalCredentialsCleared:
                options.onPrivacyCredentialsCleared,
            }
          : {}),
        ...(options.onPrivacyClear !== undefined
          ? { onCleared: options.onPrivacyClear }
          : {}),
        ...(tlsRenewCaller !== undefined
          ? { tlsRenewCaller: switchWorkTracker.track(tlsRenewCaller) }
          : {}),
        // List + upload go together — the route's `canMountTlsCertificates`
        // gate requires both, because a list with no upload path is the dead
        // end this panel exists to close.
        ...(tlsDomainListCaller !== undefined && tlsDomainUploadCaller !== undefined
          ? {
              tlsDomainListCaller,
              tlsDomainUploadCaller: switchWorkTracker.track(tlsDomainUploadCaller),
            }
          : {}),
        ...(tlsDomainRemoveCaller !== undefined
          ? { tlsDomainRemoveCaller: switchWorkTracker.track(tlsDomainRemoveCaller) }
          : {}),
        // R26.2 Delta 1 — the Exposure grid mounts only when all four callers
        // are present (the route's `canMountExposure` gate). `runHasDdns` is
        // independently optional.
        ...(exposureGetCaller !== undefined
          && exposureApplyPresetCaller !== undefined
          && exposureSetPathResolutionCaller !== undefined
          && exposureSetPublicMcpAckCaller !== undefined
          ? {
              exposureGetCaller,
              exposureApplyPresetCaller: switchWorkTracker.track(
                exposureApplyPresetCaller,
              ),
              exposureSetPathResolutionCaller: switchWorkTracker.track(
                exposureSetPathResolutionCaller,
              ),
              exposureSetPublicMcpAckCaller: switchWorkTracker.track(
                exposureSetPublicMcpAckCaller,
              ),
            }
          : {}),
        ...(exposureSetApexCaller !== undefined
          ? {
              exposureSetApexCaller: switchWorkTracker.track(
                exposureSetApexCaller,
              ),
            }
          : {}),
        ...(exposureHasDdnsCaller !== undefined
          ? { exposureHasDdnsCaller }
          : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.onTlsRenewed !== undefined
          ? { onTlsRenewed: options.onTlsRenewed }
          : {}),
        ...(keyHealthLoader !== undefined && keyRotateCaller !== undefined
          ? {
              keyHealthLoader,
              keyRotateCaller: switchWorkTracker.track(keyRotateCaller),
            }
          : {}),
        // D-212 §7.10 — keyfile posture on the Key Health page.
        ...(systemStatusLoader !== undefined ? { systemStatusLoader } : {}),
        ...(certPinWatcher !== null ? { certPinWatcher } : {}),
        ...(pairListCaller !== undefined && pairRevokeCaller !== undefined
          ? {
              pairListCaller,
              pairRevokeCaller: switchWorkTracker.track(pairRevokeCaller),
            }
          : {}),
        ...(options.currentInstanceId !== undefined
          ? { currentInstanceId: options.currentInstanceId }
          : {}),
        ...(options.onDevicesListError !== undefined
          ? { onDevicesListError: options.onDevicesListError }
          : {}),
        ...(notificationsDescribeCaller !== undefined
          && notificationsSetChannelCaller !== undefined
          ? {
              notificationsDescribeCaller,
              notificationsSetChannelCaller: switchWorkTracker.track(
                notificationsSetChannelCaller,
              ),
              // D-169 P1 — per-bridge sub-row callers. Always paired
              // with the channel-level callers (same gate); the
              // notifications panel renders the sub-row group only
              // when both bridge callers are present.
              ...(notificationsDescribeBridgesCaller !== undefined
                && notificationsSetBridgeModeCaller !== undefined
                ? {
                    notificationsDescribeBridgesCaller,
                    notificationsSetBridgeModeCaller: switchWorkTracker.track(
                      notificationsSetBridgeModeCaller,
                    ),
                  }
                : {}),
              // R31 — the verification-phrase caller (panel-level).
              ...(notificationsSetVerificationPhraseCaller !== undefined
                ? {
                    notificationsSetVerificationPhraseCaller:
                      switchWorkTracker.track(
                        notificationsSetVerificationPhraseCaller,
                      ),
                  }
                : {}),
            }
          : {}),
        // D-187 §6 follow-on — packs.* callers no longer flow to Settings.
        // They are forwarded to the top-level `#packs` route branch instead.
        // D-169 P2 — the Approvals callers no longer flow to the Settings
        // route (the Approvals section graduated to the top-level
        // `#approvals` route — see the `mountRoute` `approvals` branch).
        // They are still built above + forwarded to that branch.
        // R31 (delta D) — the one-way notify FEED was retired (see
        // `enableNotifyToasts`); only the ephemeral toast overlay remains.
        // D-174 P3 — Connections callers no longer flow to Settings. They are
        // still built above and forwarded to the top-level `#connections`
        // route branch.
        ...(aiModelsDefaultModelPrefGetCaller !== undefined
          ? { aiModelsDefaultModelPrefGetCaller }
          : {}),
        ...(aiModelsDefaultModelPrefSetCaller !== undefined
          ? {
              aiModelsDefaultModelPrefSetCaller: switchWorkTracker.track(
                aiModelsDefaultModelPrefSetCaller,
              ),
            }
          : {}),
        ...(aiModelsGetLLMConfigCaller !== undefined
          ? { aiModelsGetLLMConfigCaller }
          : {}),
        ...(aiModelsSetLLMSlotCaller !== undefined
          ? {
              aiModelsSetLLMSlotCaller: switchWorkTracker.track(
                aiModelsSetLLMSlotCaller,
              ),
            }
          : {}),
        ...(aiModelsSetEmbeddingsSlotCaller !== undefined
          ? {
              aiModelsSetEmbeddingsSlotCaller: switchWorkTracker.track(
                aiModelsSetEmbeddingsSlotCaller,
              ),
            }
          : {}),
        ...(aiModelsUpsertFreePoolEntryCaller !== undefined
          ? {
              aiModelsUpsertFreePoolEntryCaller: switchWorkTracker.track(
                aiModelsUpsertFreePoolEntryCaller,
              ),
            }
          : {}),
        ...(aiModelsRemoveFreePoolEntryCaller !== undefined
          ? {
              aiModelsRemoveFreePoolEntryCaller: switchWorkTracker.track(
                aiModelsRemoveFreePoolEntryCaller,
              ),
            }
          : {}),
        ...(aiModelsSetFreePoolEntryEnabledCaller !== undefined
          ? {
              aiModelsSetFreePoolEntryEnabledCaller: switchWorkTracker.track(
                aiModelsSetFreePoolEntryEnabledCaller,
              ),
            }
          : {}),
        ...(aiModelsSetChatCatalogModeCaller !== undefined
          ? {
              aiModelsSetChatCatalogModeCaller: switchWorkTracker.track(
                aiModelsSetChatCatalogModeCaller,
              ),
            }
          : {}),
        ...(aiModelsGetLlmPromptsCaller !== undefined
          ? { aiModelsGetLlmPromptsCaller }
          : {}),
        ...(aiModelsSetLlmPromptCaller !== undefined
          ? {
              aiModelsSetLlmPromptCaller: switchWorkTracker.track(
                aiModelsSetLlmPromptCaller,
              ),
            }
          : {}),
        ...(aiModelsProbeLlmSourceCaller !== undefined
          ? {
              aiModelsProbeLlmSourceCaller: switchWorkTracker.track(
                aiModelsProbeLlmSourceCaller,
              ),
            }
          : {}),
        ...(aiModelsGetConfigSchemaCaller !== undefined
          ? { aiModelsGetConfigSchemaCaller }
          : {}),
        ...(aiModelsSetConfigFieldCaller !== undefined
          ? {
              aiModelsSetConfigFieldCaller: switchWorkTracker.track(
                aiModelsSetConfigFieldCaller,
              ),
            }
          : {}),
        ...(aiModelsHousekeepingConfigReadCaller !== undefined
          ? { aiModelsHousekeepingConfigReadCaller }
          : {}),
        ...(aiModelsHousekeepingConfigWriteCaller !== undefined
          ? {
              aiModelsHousekeepingConfigWriteCaller: switchWorkTracker.track(
                aiModelsHousekeepingConfigWriteCaller,
              ),
            }
          : {}),
        ...(sellerOverviewCaller !== undefined ? { sellerOverviewCaller } : {}),
        ...(sellerOrdersCaller !== undefined ? { sellerOrdersCaller } : {}),
        ...(sellerOfferStateTransitionCaller !== undefined
          ? {
              sellerOfferStateTransitionCaller: switchWorkTracker.track(
                sellerOfferStateTransitionCaller,
              ),
            }
          : {}),
        ...(sellerMailListCaller !== undefined ? { sellerMailListCaller } : {}),
        ...(sellerSettingsUpdateCaller !== undefined
          ? {
              sellerSettingsUpdateCaller: switchWorkTracker.track(
                sellerSettingsUpdateCaller,
              ),
            }
          : {}),
        ...(sellerManualTierUpsertCaller !== undefined
          ? {
              sellerManualTierUpsertCaller: switchWorkTracker.track(
                sellerManualTierUpsertCaller,
              ),
            }
          : {}),
        ...(sellerTierUsagePolicyCaller !== undefined
          ? {
              sellerTierUsagePolicyCaller: switchWorkTracker.track(
                sellerTierUsagePolicyCaller,
              ),
            }
          : {}),
        ...(sellerCreatePassTierCaller !== undefined
          ? {
              sellerCreatePassTierCaller: switchWorkTracker.track(
                sellerCreatePassTierCaller,
              ),
            }
          : {}),
        ...(sellerManualCustomerIssueCaller !== undefined
          ? {
              sellerManualCustomerIssueCaller: switchWorkTracker.track(
                sellerManualCustomerIssueCaller,
              ),
            }
          : {}),
        ...(sellerManualCustomerExtendCaller !== undefined
          ? {
              sellerManualCustomerExtendCaller: switchWorkTracker.track(
                sellerManualCustomerExtendCaller,
              ),
            }
          : {}),
        ...(sellerManualCustomerSwapTierCaller !== undefined
          ? {
              sellerManualCustomerSwapTierCaller: switchWorkTracker.track(
                sellerManualCustomerSwapTierCaller,
              ),
            }
          : {}),
        ...(sellerManualCustomerCloseCaller !== undefined
          ? {
              sellerManualCustomerCloseCaller: switchWorkTracker.track(
                sellerManualCustomerCloseCaller,
              ),
            }
          : {}),
        ...(sellerManualCustomerReissueTokenCaller !== undefined
          ? {
              sellerManualCustomerReissueTokenCaller: switchWorkTracker.track(
                sellerManualCustomerReissueTokenCaller,
              ),
            }
          : {}),
        ...(sellerManualTierBulkAdjustCaller !== undefined
          ? {
              sellerManualTierBulkAdjustCaller: switchWorkTracker.track(
                sellerManualTierBulkAdjustCaller,
              ),
            }
          : {}),
        ...(sellerStripeSynchronizeCaller !== undefined
          ? {
              sellerStripeSynchronizeCaller: switchWorkTracker.track(
                sellerStripeSynchronizeCaller,
              ),
            }
          : {}),
        ...(sellerAcknowledgeLlmGatewayPaidCaller !== undefined
          ? {
              sellerAcknowledgeLlmGatewayPaidCaller: switchWorkTracker.track(
                sellerAcknowledgeLlmGatewayPaidCaller,
              ),
            }
          : {}),
        ...(updateCheckCaller !== undefined
          ? {
              updateCheckCaller,
              updatesStartPoll,
              credentialRotationServerUpdateContinuity,
              ...(credentialRotationTabConvergence !== null
                ? {
                    serverUpdateTabConvergence:
                      credentialRotationTabConvergence,
                  }
                : {}),
              serverConnectionStatus: connectionStatus,
              ...(serverUpdateReceiptVerification !== null
                ? {
                    serverUpdateReceiptVerification,
                    serverUpdateReceiptDiagnosticContext: {
                      serverUrl: pair.serverUrl,
                    },
                    ...(serverUpdateDiagnosticWriter !== undefined
                      ? { serverUpdateReceiptDiagnosticWriter:
                          serverUpdateDiagnosticWriter }
                      : {}),
                  }
                : {}),
              onReturnToCredentialRotationRetry: (target) => {
                navigateHash(
                  serializeConnectionsCredentialRotationRetry(target),
                );
              },
              ...(updateModeGetCaller !== undefined ? { updateModeGetCaller } : {}),
              ...(updateModeSetCaller !== undefined
                ? {
                    updateModeSetCaller: switchWorkTracker.track(
                      updateModeSetCaller,
                    ),
                  }
                : {}),
              ...(updateApplyCaller !== undefined
                ? {
                    updateApplyCaller: switchWorkTracker.track(
                      updateApplyCaller,
                    ),
                  }
                : {}),
              ...(updateRollbackCaller !== undefined
                ? {
                    updateRollbackCaller: switchWorkTracker.track(
                      updateRollbackCaller,
                    ),
                  }
                : {}),
            }
          : {}),
        ...(housekeepingCacheStatsCaller !== undefined
          ? { housekeepingCacheStatsCaller }
          : {}),
        ...(housekeepingCacheClearCaller !== undefined
          ? {
              housekeepingCacheClearCaller: switchWorkTracker.track(
                housekeepingCacheClearCaller,
              ),
            }
          : {}),
        ...(transparencyPrefsGetCaller !== undefined
          && transparencyPrefsSetCaller !== undefined
          ? {
              transparencyPrefsGetCaller,
              transparencyPrefsSetCaller: switchWorkTracker.track(
                transparencyPrefsSetCaller,
              ),
            }
          : {}),
        ...(learningPrefsGetCaller !== undefined
          && learningPrefsSetCaller !== undefined
          ? {
              learningPrefsGetCaller,
              learningPrefsSetCaller: switchWorkTracker.track(
                learningPrefsSetCaller,
              ),
            }
          : {}),
        ...(learningCasesListCaller !== undefined
          && learningCaseForgetCaller !== undefined
          ? {
              learningCasesListCaller,
              learningCaseForgetCaller,
            }
          : {}),
        ...(learningDraftRecipeCaller !== undefined
          ? {
              learningDraftRecipeCaller,
              learningDraftConfirmation: RECIPE_DRAFT_CONFIRMATION,
              // ⛔ The panel hands the draft back; the SHELL routes. Stash it
              // and open the Kitchen on the key — the recipe itself is too big
              // for a hash and cannot be rebuilt without paying for it again.
              onLearningDraftReady: (draft: {
                case_id: string;
                recipe: unknown;
                request_aliased: boolean;
              }) => {
                const draft_key = stashExecutionCaseDraft(draftStashStorage, {
                  case_id: draft.case_id,
                  recipe: draft.recipe,
                  request_aliased: draft.request_aliased,
                });
                // ⚠ A stash that could not be written means no hand-off, and
                // the panel must be TOLD: returning silently discarded a draft
                // the owner had just paid for, with no error anywhere.
                if (draft_key === null) return false;
                if (hashSource?.setHash === undefined) return false;
                // ⛔ STASHED ABOVE, UNCONDITIONALLY — the draft is saved whether
                // or not we navigate. But only YANK the owner into the Kitchen
                // if they are still where they started it: a 90-second call that
                // lands after they have moved on must not steal the page from
                // under them. The draft is on the slot either way, and pressing
                // again re-opens it without paying twice.
                const here = hashSource.getHash?.() ?? '';
                if (!here.startsWith('#settings')) return true;
                hashSource.setHash(serializeShellRoute(
                  'kitchen', 'new', 'execution-case', draft_key,
                ));
                return true;
              },
            }
          : {}),
        ...(housekeepingPanelConfigReadCaller !== undefined
          ? { housekeepingPanelConfigReadCaller }
          : {}),
        ...(housekeepingPanelConfigWriteCaller !== undefined
          ? {
              housekeepingPanelConfigWriteCaller: switchWorkTracker.track(
                housekeepingPanelConfigWriteCaller,
              ),
            }
          : {}),
        ...(housekeepingPanelStatusReadCaller !== undefined
          ? { housekeepingPanelStatusReadCaller }
          : {}),
        ...(housekeepingPanelRunNowCaller !== undefined
          ? {
              housekeepingPanelRunNowCaller: switchWorkTracker.track(
                housekeepingPanelRunNowCaller,
              ),
            }
          : {}),
        ...(maintenanceServerStatusCaller !== undefined
          ? { maintenanceServerStatusCaller }
          : {}),
        ...(maintenanceReclaimCaller !== undefined
          ? {
              maintenanceReclaimCaller: switchWorkTracker.track(
                maintenanceReclaimCaller,
              ),
            }
          : {}),
        ...(housekeepingPanelTrustReadCaller !== undefined
          ? { housekeepingPanelTrustReadCaller }
          : {}),
        ...(housekeepingPanelTrustWriteCaller !== undefined
          ? {
              housekeepingPanelTrustWriteCaller: switchWorkTracker.track(
                housekeepingPanelTrustWriteCaller,
              ),
            }
          : {}),
        ...(housekeepingPanelDismissPromotionCaller !== undefined
          ? {
              housekeepingPanelDismissPromotionCaller: switchWorkTracker.track(
                housekeepingPanelDismissPromotionCaller,
              ),
            }
          : {}),
        ...(housekeepingPanelRegistryDescribeCaller !== undefined
          ? { housekeepingPanelRegistryDescribeCaller }
          : {}),
        ...(housekeepingPanelTopicResetCaller !== undefined
          ? {
              housekeepingPanelTopicResetCaller: switchWorkTracker.track(
                housekeepingPanelTopicResetCaller,
              ),
            }
          : {}),
        ...(hostnamesListCaller !== undefined
          && hostnamesGetCaller !== undefined
          && hostnamesAddCaller !== undefined
          && hostnamesUpdateCaller !== undefined
          && hostnamesRemoveCaller !== undefined
          && hostnamesVerifyOwnershipCaller !== undefined
          ? {
              hostnamesListCaller,
              hostnamesGetCaller,
              hostnamesAddCaller: switchWorkTracker.track(hostnamesAddCaller),
              hostnamesUpdateCaller: switchWorkTracker.track(
                hostnamesUpdateCaller,
              ),
              hostnamesRemoveCaller: switchWorkTracker.track(
                hostnamesRemoveCaller,
              ),
              hostnamesVerifyOwnershipCaller: switchWorkTracker.track(
                hostnamesVerifyOwnershipCaller,
              ),
            }
          : {}),
        // D-235 P5 — forwarded independently of the CRUD bundle above. The
        // Domains panel is useful on its own (checking DNS needs no write
        // capability at all), so gating it behind the whole CRUD group would
        // hide the diagnostics precisely when a partial surface made them most
        // worth having.
        ...(customDomainPreflightCaller !== undefined
          ? { customDomainPreflightCaller }
          : {}),
        ...(customDomainReadinessCaller !== undefined
          ? { customDomainReadinessCaller }
          : {}),
        // LAN-URL kickstart (slice 2) — forwarded independently of the CRUD
        // bundle above so it reaches the panel even if a future config gates
        // the CRUD callers off. Always defined; the panel renders the section
        // only when the call resolves with addresses.
        networkLocalUrlsCaller,
        // R27 delta-B — Pro DDNS toggle callers, forwarded independently (the
        // route gates the section on pro-convenience-published + composes the
        // self-disconnect context).
        ddnsStatusCaller,
        ddnsSetEnabledCaller: switchWorkTracker.track(ddnsSetEnabledCaller),
        ...(options.enableReachabilityDoctor === true
          && (options.reachabilityReport !== undefined
            || reachabilityExternalProbeCaller !== undefined)
          ? {
              ...(options.reachabilityReport !== undefined
                ? { reachabilityReport: options.reachabilityReport }
                : {}),
              ...(reachabilityExternalProbeCaller !== undefined
                ? {
                    reachabilityExternalProbeCaller: switchWorkTracker.track(
                      reachabilityExternalProbeCaller,
                    ),
                  }
                : {}),
            }
          : {}),
        ...(accountBindingStatusCaller !== undefined
          && accountBindCaller !== undefined
          && accountUnbindCaller !== undefined
          && accountProConvenienceStatusCaller !== undefined
          && accountBindingTokenMintCaller !== undefined
          ? {
              accountBindingStatusCaller,
              accountBindCaller: switchWorkTracker.track(accountBindCaller),
              accountUnbindCaller: switchWorkTracker.track(
                accountUnbindCaller,
              ),
              accountProConvenienceStatusCaller,
              accountBindingTokenMintCaller: switchWorkTracker.track(
                accountBindingTokenMintCaller,
              ),
              accountDashboardUrl,
              ...(accountBindingSessionCaller !== undefined
                ? { accountBindingSessionCaller }
                : {}),
              ...(accountSignOutCaller !== undefined
                ? {
                    accountSignOutCaller: switchWorkTracker.track(
                      accountSignOutCaller,
                    ),
                  }
                : {}),
            }
          : {}),
        // R26.4 M1 — the consolidated Backup & Recovery surface: the three
        // archive callers are the spine; the passport-export caller rides
        // alongside as the optional standalone "Export identity passport only"
        // action.
        ...(continuousArchiveExportCaller !== undefined
          && continuousArchiveStatusCaller !== undefined
          && archiveImportCaller !== undefined
          ? {
              archiveExportCaller: continuousArchiveExportCaller,
              archiveStatusCaller: continuousArchiveStatusCaller,
              archiveResumeExportStart: () =>
                activeArchiveExport?.start ?? null,
              archiveExportSettled: settleActiveArchiveExport,
              archiveImportCaller: switchWorkTracker.track(archiveImportCaller),
              ...(passportExportCaller !== undefined
                ? {
                    passportExportCaller: switchWorkTracker.track(
                      passportExportCaller,
                    ),
                  }
                : {}),
              ...(trackedArchiveDownload !== undefined
                ? { archiveDownload: trackedArchiveDownload }
                : {}),
              ...(trackedArchiveUpload !== undefined
                ? { archiveUpload: trackedArchiveUpload }
                : {}),
              ...(archiveRebindStash !== undefined
                ? {
                    archiveRebindStash: switchWorkTracker.track(
                      archiveRebindStash,
                    ),
                  }
                : {}),
            }
          : {}),
        // D-187 §6 follow-on — cli reachability callers no longer flow to
        // Settings. They are forwarded to the top-level `#packs` route branch
        // (alongside the packs.* callers the install→cli-grant-dialog flow
        // binds them to).
        // D-145 PA11 follow-on — broadcast-subscriber seam, shared
        // across every Settings panel that wants a live refresh
        // (cache card's `housekeeping_cycle` filter, etc.).
        // Forwarded unconditionally; each consumer's own gate decides
        // whether to subscribe (e.g. cache card needs stats wired).
        subscribe: subscriber.on,
      }));
      activeSettingsRoute = settings;
      return {
        ...settings,
        // Back/Forward between plain `#settings/<section>` addresses is the
        // rail switch in reverse — every section is already built, so the
        // mounted route serves it in place. Anything deeper on either side
        // (a Seller sub-page, a Server tab) is mount-time state: return false
        // and take the shell's re-mount.
        navigateDeepLink: (hash: string): boolean => {
          const from = parseShellRoute(activeHash);
          const to = parseShellRoute(hash);
          if (to.surface !== 'settings') return false;
          if (from.segments.length > 1 || to.segments.length > 1) return false;
          return settings.navigateToSection(to.segments[0] ?? null);
        },
      };
    }
    if (
      route === 'approvals'
      && approvalListCaller !== undefined
      && approvalResolveCaller !== undefined
      && approvalSubscribeCaller !== undefined
      && notificationAsksListCaller !== undefined
      && notificationAsksSubmitAnswerCaller !== undefined
    ) {
      // D-174 — top-level Approvals deep queue. It composes the
      // approval.* pending-gate snapshot/resolve/subscribe path with
      // the existing notification.* asks panel. The guard is
      // belt-and-suspenders + type-narrowing: `resolveRoute` upstream
      // already degrades a callers-absent `#approvals` to the default
      // route.
      activeSettingsRoute = null;
      return withTrackedServerSwitchWork(bootstrapApprovalsRoute({
        root: appShell.contentRoot,
        ...(options.document !== undefined ? { document: options.document } : {}),
        runApprovalList: approvalListCaller,
        runApprovalResolve: approvalResolveCaller,
        runApprovalSubscribe: approvalSubscribeCaller,
        onApprovalChanged,
        runList: notificationAsksListCaller,
        runSubmitAnswer: notificationAsksSubmitAnswerCaller,
        subscribe: subscriber.on,
        reconnect,
        // D-174 #4 — resolve recipe_id → name + initiator_instance → device
        // name for the card meta. Both are soft (the route falls back to the
        // raw id on error); pair.list resolves for the webclient post-057df5e6
        // and is independent of the Devices-page roster gate.
        recipeNamesCaller,
        pairListCaller: () => rpcConn.call('pair.list', undefined),
        ...(pendingChatPlansStore !== null
          ? { chatPlans: pendingChatPlansStore }
          : {}),
        ...(chatPlanResolveCaller !== undefined
          ? { runChatPlanResolve: chatPlanResolveCaller }
          : {}),
        // R17 — `#approvals/<id>` (e.g. from a Runs detail "Approval" link)
        // focuses + highlights that one card.
        ...(deepLinkSegment('approvals') !== undefined
          ? { initialFocusId: deepLinkSegment('approvals') }
          : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      }));
    }
    if (route === 'mail') {
      // D-145 PA7 / D-172 P2 — the compose host.
      //
      // ⛔ SEND IS AN `execute` RUN, NOT AN RPC. D-177 N.12 removed
      // `collection.mail.send` from the wire method set, so this route
      // dispatches the `send-composed-mail` recipe and the D-157 gate lifts the
      // outbound step to `ask`. The owner approves in #approvals; a dispatch
      // that resolves means the run was ACCEPTED, never that mail was sent.
      activeSettingsRoute = null;
      return bootstrapMailRoute({
        root: appShell.contentRoot,
        ...(options.document !== undefined ? { document: options.document } : {}),
        listMailInstances: () => rpcConn.call('collection.mail.list', undefined),
        runExecute: (args) =>
          rpcConn.call('execute', { ...args, trigger_source: 'manual' }),
        // The attachment chooser's inventory. Same read Data → Files browses,
        // so an uploaded file is attachable without a second index.
        searchFiles: (args) => rpcConn.call('data.mirror.search', args),
      });
    }
    if (route === 'kitchen') {
      activeSettingsRoute = null;
      // Edit→Kitchen — one route, two sibling authoring surfaces:
      //   #kitchen/recipe/<id>       → the recipe editor (recipes-detail link)
      //   #kitchen/new/form-response/<form_definition_id>
      //                              → a new accepted-response automation
      //   #kitchen/pack[/<draft_id>] → the pack editor (bare #kitchen too)
      // `kitchen` is a deep-link route, so switching between them re-mounts.
      const kitchenRoute =
        hashSource !== null ? parseShellRoute(hashSource.getHash()) : null;
      const kitchenRecipeId =
        kitchenRoute !== null ? kitchenEditRecipeId(kitchenRoute) : null;
      const kitchenRecipeSeed =
        kitchenRoute !== null ? kitchenNewRecipeSeed(kitchenRoute) : null;
      const isRecipeSurface =
        kitchenRecipeId !== null || kitchenRecipeSeed !== null;
      const kitchenRecipeHref = kitchenRecipeSeed === null
        ? undefined
        : kitchenRecipeSeed.kind === 'form_response'
          ? serializeShellRoute(
              'kitchen',
              'new',
              'form-response',
              kitchenRecipeSeed.form_definition_id,
            )
          : serializeShellRoute(
              'kitchen',
              'new',
              'execution-case',
              kitchenRecipeSeed.draft_key,
            );
      // Route chrome — the persistent `[ Recipe | Ingredient pack ]` tab bar.
      // Mounted FIRST so it survives the editor's loading / not-found / error
      // states; the active surface mounts into its content slot. The Recipe tab
      // is contextual (points at the open recipe on the recipe surface, else at
      // `#recipes` to pick one); the Pack tab always opens `#kitchen/pack`.
      const kitchenChrome = mountKitchenChrome({
        root: appShell.contentRoot,
        active: isRecipeSurface ? 'recipe' : 'pack',
        ...(kitchenRecipeId !== null ? { recipeId: kitchenRecipeId } : {}),
        ...(kitchenRecipeHref !== undefined ? { recipeHref: kitchenRecipeHref } : {}),
        ...(options.document !== undefined ? { document: options.document } : {}),
      });
      const syncSavedRecipeRoute = (result: { recipe_id: string }): void => {
        const nextHash = serializeShellRoute('kitchen', 'recipe', result.recipe_id);
        const history = doc.defaultView?.history;
        if (history?.replaceState !== undefined) {
          history.replaceState(null, '', nextHash);
        }
        activeHash = nextHash;
        kitchenChrome.setRecipeHref(nextHash);
      };
      let editor: ReturnType<typeof mountRecipeEditorRoute> | null = null;
      if (kitchenRecipeSeed?.kind === 'execution_case') {
        // D-219 item 2b — an AI-written draft the Settings panel already
        // generated. ⛔ This route does NOT regenerate: doing so on a refresh
        // would spend the owner's model quota again without them asking, so an
        // unmatched key is a not-found.
        const stashed = readExecutionCaseDraft(
          draftStashStorage,
          kitchenRecipeSeed.draft_key,
        );
        editor = mountExecutionCaseDraftRoute({
          root: kitchenChrome.contentRoot,
          draft: stashed,
          validateCaller: switchWorkTracker.track(
            (args) => rpcConn.call('recipe.validate', args),
          ),
          saveCaller: switchWorkTracker.track(
            (args) => rpcConn.call('recipe.save', args),
          ),
          onSaved: syncSavedRecipeRoute,
          // D-219 — annotate the Learning list with "you already made one".
          // ⚠ Fire-and-forget with a swallowed rejection: the save succeeded,
          // and losing the annotation must not read as losing the recipe.
          onAuthored: (input) => {
            void rpcConn.call('chat.execution.authored', input).catch(() => {});
          },
          // D-219 — iterative refinement, wired as the same PAIR the panel uses.
          // ⛔ Re-stash under a NEW key and reopen: the route reads its draft
          // from the slot, so a revision becomes visible the same way the first
          // draft did, and the old key stops resolving rather than lingering as
          // a second openable draft.
          ...(learningDraftRecipeCaller !== undefined
            ? {
                runDraftRecipe: (args) => rpcConn.call(
                  'chat.execution.draft_recipe', args,
                  { timeout: LEARNING_DRAFT_RPC_TIMEOUT_MS },
                ),
                // ⛔ The REFINE copy, not the draft copy: the owner is looking
                // at a draft, so "will write a recipe from this turn" and
                // "FIRST DRAFT" describe the wrong action, and the thing they
                // actually need warning about is that it REPLACES their edits.
                refineConfirmation: RECIPE_REFINE_CONFIRMATION,
                onRefined: (draft: {
                  case_id: string;
                  recipe: unknown;
                  request_aliased: boolean;
                  silent?: boolean;
                }) => {
                  const draft_key = stashExecutionCaseDraft(draftStashStorage, {
                    case_id: draft.case_id,
                    recipe: draft.recipe,
                    request_aliased: draft.request_aliased,
                  });
                  if (draft_key === null) return false;
                  if (hashSource?.setHash === undefined) return false;
                  // Stashed above either way; `silent` means the route is gone,
                  // so reopening it would drag the owner back to a page they
                  // deliberately left.
                  if (draft.silent === true) return true;
                  hashSource.setHash(serializeShellRoute(
                    'kitchen', 'new', 'execution-case', draft_key,
                  ));
                  return true;
                },
              }
            : {}),
          ...(options.document !== undefined ? { document: options.document } : {}),
        });
      } else if (kitchenRecipeSeed !== null) {
        editor = mountFormResponseRecipeSeedRoute({
          root: kitchenChrome.contentRoot,
          formDefinitionId: kitchenRecipeSeed.form_definition_id,
          listCaller: recipesListCaller,
          validateCaller: switchWorkTracker.track(
            (args) => rpcConn.call('recipe.validate', args),
          ),
          saveCaller: switchWorkTracker.track(
            (args) => rpcConn.call('recipe.save', args),
          ),
          onSaved: syncSavedRecipeRoute,
          ...(options.document !== undefined ? { document: options.document } : {}),
        });
      } else if (kitchenRecipeId !== null) {
        editor = mountRecipeEditorRoute({
          root: kitchenChrome.contentRoot,
          recipeId: kitchenRecipeId,
          listCaller: recipesListCaller,
          validateCaller: switchWorkTracker.track(
            (args) => rpcConn.call('recipe.validate', args),
          ),
          saveCaller: switchWorkTracker.track(
            (args) => rpcConn.call('recipe.save', args),
          ),
          webhookIngressListCaller: () => rpcConn.call('webhook.ingress.list', undefined),
          webhookStatusCaller: (args) => rpcConn.call('recipe.webhook.status', args),
          webhookArmCaller: switchWorkTracker.track(
            (args) => rpcConn.call('recipe.webhook.arm', args),
          ),
          webhookDisarmCaller: switchWorkTracker.track(
            (args) => rpcConn.call('recipe.webhook.disarm', args),
          ),
          onSaved: syncSavedRecipeRoute,
          ...(options.document !== undefined ? { document: options.document } : {}),
        });
      }
      if (editor !== null) {
        const mountedEditor = editor;
        return withTrackedServerSwitchWork({
          // `finally` so the chrome host + its injected style are always torn
          // down even if the surface dispose throws — route disposal runs on
          // every flip, so a leak here would accumulate.
          dispose: () => {
            try {
              mountedEditor.dispose();
            } finally {
              kitchenChrome.dispose();
            }
          },
          hasUnsavedChanges: () => mountedEditor.hasUnsavedChanges(),
          hasInFlightWork: () => mountedEditor.hasInFlightWork(),
        });
      }
      // Pack editor. A draft id in seg 1 (`#kitchen/pack/<draft_id>`) self-loads
      // that draft; in-page draft selection syncs the URL through onDraftChange
      // so a selected draft is a durable, shareable deep link. Bare `#kitchen`
      // (or any non-`pack` sub-route) canonicalizes to `#kitchen/pack` via
      // replaceState (silent — no hashchange, no remount). The URL write lives
      // HERE, not in the route (mirrors the packs route's replaceState +
      // onHashSync); the builder stays route-agnostic.
      const packDraftId =
        kitchenRoute !== null ? kitchenPackDraftId(kitchenRoute) : null;
      const syncPackHash = (draftId: string | undefined): void => {
        const nextHash = serializeShellRoute('kitchen', 'pack', draftId);
        const history = doc?.defaultView?.history;
        if (history?.replaceState !== undefined) {
          history.replaceState(null, '', nextHash);
        }
        activeHash = nextHash;
      };
      if (kitchenRoute !== null && kitchenRoute.segments[0] !== 'pack') {
        syncPackHash(packDraftId ?? undefined);
      }
      const kitchenMutationMethods = new Set<string>([
        'ingredient.draft.save',
        'ingredient.compose.decompose',
        'ingredient.install',
      ]);
      const builder = bootstrapIngredientBuilderRoute({
        root: kitchenChrome.contentRoot,
        conn: trackSelectedRpcMethods<IngredientBuilderConn>(
          kitchenMutationMethods,
        ),
        ...(packDraftId !== null ? { initialDraftId: packDraftId } : {}),
        onDraftChange: syncPackHash,
        ...(options.document !== undefined ? { document: options.document } : {}),
      });
      return withTrackedServerSwitchWork({
        // See the recipe path — chrome teardown in `finally` so it can't leak.
        dispose: () => {
          try {
            builder.dispose();
          } finally {
            kitchenChrome.dispose();
          }
        },
        hasUnsavedChanges: () => builder.hasUnsavedChanges(),
        hasInFlightWork: () => builder.hasInFlightWork(),
      });
    }
    activeSettingsRoute = null;
    const receptionMutationMethods = new Set<string>([
      'reception.compose.propose',
      'reception.intake_recipe_pair.bind',
      'reception.intake_recipe_pair.configure',
      'reception.intake_recipe_pair.clear',
      'reception.inbox.approve',
      'reception.inbox.reject',
      'execute',
    ]);
    return withTrackedServerSwitchWork(bootstrapReceptionRoute({
      root: appShell.contentRoot,
      shell: receptionShell,
      conn: trackSelectedRpcMethods<BootstrapReceptionRouteOptions['conn']>(
        receptionMutationMethods,
      ),
      exposureProfile: options.exposureProfile,
      // R19 — `#reception/<section>` (inbox · abuse · endpoints); a section
      // switch changes the hash + re-mounts this route with the new
      // section (reception is a deep-link surface). Absent ⇒ inbox default.
      ...(deepLinkSegment('reception') !== undefined
        ? { initialSection: deepLinkSegment('reception') }
        : {}),
      // R19 / D-200 — deeper segments route full-page endpoint tools:
      // `#reception/endpoints/new|edit/<kind>` or
      // `#reception/endpoints/pair/<endpoint-id>`.
      ...(deepLinkSegment('reception', 1) !== undefined
        ? { initialSubview: deepLinkSegment('reception', 1) }
        : {}),
      ...(deepLinkSegment('reception', 2) !== undefined
        ? { initialKind: deepLinkSegment('reception', 2) }
        : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.document !== undefined ? { document: options.document } : {}),
      // Reception always receives the shared bus: its Inbox and D-200 pair
      // selector own live invalidations independently of the Approvals route.
      // Only the cross-route Approvals badge/read follows the feature flag, so
      // disabling `#approvals` neither renders a dead badge nor silently cuts
      // unrelated Reception subscriptions.
      subscribe: subscriber.on,
      enablePendingAsks: options.enableApprovalsRoute !== false,
    }));
  };

  let mountedRouteHandle: RecoveryContextProbe & {
    update?: () => void;
    dispose: () => void;
    hasUnsavedChanges?: () => boolean;
    unsavedChangesPrompt?: () => string | null;
    hasInFlightWork?: () => boolean;
    inFlightWorkPrompt?: () => string | null;
    hasRouteInFlightWork?: () => boolean;
    navigateDeepLink?: (hash: string) => boolean;
    getRecoveryDraft?: () => ChatRouteRecoveryDraft | null;
  } = mountRoute(activeRoute);

  recoveryIntentLandingHash = deferredRecoveryReturnArrival?.landingHash
    ?? recoveryIntentContinuationMarker?.landingHash
    ?? null;
  recoveryIntentOrientation =
    deferredRecoveryReturnArrival !== undefined
      || recoveryIntentContinuationMarker !== null
      || recoveryIntentExpiredDeferredCheck !== null
      ? mountRecoveryIntentOrientation({
          root: appShell.contentRoot,
          statusHost: appShell.connectionHost,
          document: doc,
          onResumeWindowExpired: ({ route, intent }) => {
            const landingHash = recoveryIntentLandingHash;
            const currentHash = hashSource?.getHash() ?? activeHash;
            if (
              approvalAttentionPopover === null
              || bootProfileId === null
              || landingHash === null
              || route !== activeRoute
              || currentHash !== landingHash
              || parseRouteFromHash(landingHash) !== route
            ) return;
            const marker = recoveryIntentContinuationStore.arm({
              profileId: bootProfileId,
              landingHash,
              intent,
            });
            if (marker !== null) setRecoveryIntentContinuation(marker);
          },
          onUserOwnership: () => {
            // Direct review deliberately hands ownership to the route before
            // asking what happened. Route interaction may clear its temporary
            // focus cue, but only the explicit outcome can retire the reminder.
            if (
              recoveryIntentContinuationPhase === 'awaiting_review_outcome'
              || recoveryIntentContinuationPhase === 'verification_ready'
              || recoveryIntentContinuationPhase === 'verification_interrupted'
              || recoveryIntentContinuationPhase === 'verification_handoff'
            ) return;
            if (
              recoveryIntentContinuationPhase === 'checking'
              && recoveryIntentReviewVerificationTarget !== null
            ) {
              interruptRecoveryIntentReviewVerification('ownership');
              return;
            }
            recoveryIntentLandingHash = null;
            if (recoveryIntentContinuationMarker !== null) {
              retireRecoveryIntentContinuation();
            }
          },
        })
      : null;

  const focusRecoveryReturnLanding = (
    intent: RecoveryReturnReceipt['intent'],
    options: { readonly focusBroadFallback?: boolean } = {},
  ): boolean => {
    if (intent === 'retry' || intent === 'return') return false;
    const landingIntent: RecoveryLandingIntent = intent;
    const target = focusRecoveryIntentLanding({
      root: appShell.contentRoot,
      route: activeRoute,
      intent: landingIntent,
    });
    if (target === null) {
      recoveryIntentOrientation?.clear();
      // A partially mounted or legacy route can still lack its public hooks.
      // Preserve the old safe fallback without making it the normal landing.
      if (options.focusBroadFallback !== false) {
        focusShellElement(appShell.contentRoot);
      }
      return false;
    }
    recoveryIntentOrientation?.orient({
      target,
      intent: landingIntent,
      route: activeRoute,
    });
    return true;
  };

  reviewRecoveryIntentExpiryHandoff = (requested) => {
    const matchesLineage = (): boolean => {
      const current = recoveryIntentExpiryHandoff;
      const deferred = recoveryIntentExpiredDeferredCheck;
      return current !== null
        && deferred !== null
        && recoveryIntentContinuationMarker === null
        && bootProfileId !== null
        && requested.serverProfileId === bootProfileId
        && current.serverProfileId === requested.serverProfileId
        && current.landingHash === requested.landingHash
        && current.deferredAt === requested.deferredAt
        && current.expiredAt === requested.expiredAt
        && deferred.profileId === requested.serverProfileId
        && deferred.landingHash === requested.landingHash
        && deferred.deferredAt === requested.deferredAt
        && deferred.expiresAt === requested.expiredAt;
    };
    if (!matchesLineage()) {
      clearRecoveryIntentExpiryHandoff();
      return 'missing';
    }
    if (
      recoveryIntentExpiryHandoff?.phase !== requested.phase
      || (recoveryIntentExpiryHandoff.retryReason ?? null)
        !== (requested.retryReason ?? null)
      || (recoveryIntentExpiryHandoff.diagnosisTarget ?? null)
        !== (requested.diagnosisTarget ?? null)
      || (recoveryIntentExpiryHandoff.closureTarget ?? null)
        !== (requested.closureTarget ?? null)
      || (recoveryIntentExpiryHandoff.checkBlocker ?? null)
        !== (requested.checkBlocker ?? null)
      || recoveryIntentExpiryReviewInFlight
      || pendingRecoveryReturnAction !== null
    ) return 'unavailable';

    const restoreQuietHandoff = (): void => {
      if (!matchesLineage() || recoveryIntentExpiryHandoff === null) return;
      approvalAttentionPopover?.setRecoveryIntentExpiryHandoff(
        recoveryIntentExpiryHandoff,
      );
      approvalAttentionPopover?.open();
    };
    const publishHandoffAfterAttentionAction = (): void => {
      // `started` closes and clears the popover's captured item after this
      // callback returns. Republish the live checking/retry/handoff state on
      // the next microtask so the quiet bell remains truthful while the route
      // owns work.
      void Promise.resolve().then(() => {
        if (!matchesLineage() || recoveryIntentExpiryHandoff === null) return;
        approvalAttentionPopover?.setRecoveryIntentExpiryHandoff(
          recoveryIntentExpiryHandoff,
        );
      });
    };
    const restoreQuietHandoffAfterAttentionAction = (): void => {
      // An injected hash source may run its leave guard synchronously inside
      // this click callback. Reopen after the popover has processed `started`
      // so a declined dirty-route transition cannot immediately close it again.
      void Promise.resolve().then(restoreQuietHandoff);
    };
    const orientClosureWithoutRecheck = (): void => {
      if (
        !matchesLineage()
        || recoveryIntentExpiryHandoff?.phase !== 'closure'
      ) return;
      // The route can perform its ordinary mount read. This reminder starts
      // no recovery-owned check and remains until explicit closure.
      focusRecoveryReturnLanding('review');
      publishHandoffAfterAttentionAction();
    };
    if (requested.phase === 'closure') {
      const selectedHash = hashSource?.getHash() ?? activeHash;
      if (selectedHash !== requested.landingHash) {
        pendingRecoveryReturnAction = {
          landingHash: requested.landingHash,
          onArrival: () => {
            void Promise.resolve().then(orientClosureWithoutRecheck);
          },
          onDeclined: restoreQuietHandoffAfterAttentionAction,
        };
        navigateHash(requested.landingHash);
      } else {
        void Promise.resolve().then(orientClosureWithoutRecheck);
      }
      return 'started';
    }
    if (requested.phase === 'handoff') {
      if (requested.diagnosisTarget === 'area') {
        const finishAreaDiagnosis = (): void => {
          if (
            !matchesLineage()
            || recoveryIntentExpiryHandoff?.phase !== 'handoff'
            || recoveryIntentExpiryHandoff.diagnosisTarget !== 'area'
          ) return;
          // This is orientation, not another saved-check retry. The route may
          // perform its ordinary mount read, but this handoff dispatches no
          // additional recovery read and never restores the expired intent.
          clearRecoveryIntentExpiryHandoff();
          focusRecoveryReturnLanding('review');
        };
        const selectedHash = hashSource?.getHash() ?? activeHash;
        if (selectedHash !== requested.landingHash) {
          pendingRecoveryReturnAction = {
            landingHash: requested.landingHash,
            onArrival: () => {
              void Promise.resolve().then(finishAreaDiagnosis);
            },
            onDeclined: restoreQuietHandoffAfterAttentionAction,
          };
          navigateHash(requested.landingHash);
        } else {
          // Let the popover close and return focus first, then place focus on
          // the route-owned status/error target without a transient bell hop.
          void Promise.resolve().then(finishAreaDiagnosis);
        }
        return 'started';
      }
      if (
        requested.diagnosisTarget !== 'server'
        || accountMenu === null
        || !accountMenu.canOpenConnectionDiagnosis(
          requested.serverProfileId,
        )
      ) return 'unavailable';
      const diagnosisId = [
        'expired-area-review',
        requested.expiredAt,
        ++recoveryIntentConnectionDiagnosisSequence,
      ].join(':');
      pendingRecoveryIntentConnectionDiagnosis = {
        source: 'expired_area_review',
        id: diagnosisId,
        profileId: requested.serverProfileId,
        landingHash: requested.landingHash,
        deferredAt: requested.deferredAt,
        expiredAt: requested.expiredAt,
      };
      void Promise.resolve().then(() => {
        const pending = pendingRecoveryIntentConnectionDiagnosis;
        if (
          pending?.source !== 'expired_area_review'
          || pending.id !== diagnosisId
          || !matchesLineage()
          || recoveryIntentExpiryHandoff?.phase !== 'handoff'
          || recoveryIntentExpiryHandoff.diagnosisTarget !== 'server'
          || accountMenu === null
        ) {
          if (pending?.id === diagnosisId) {
            pendingRecoveryIntentConnectionDiagnosis = null;
            restoreQuietHandoff();
          }
          return;
        }
        const opened = accountMenu.openConnectionDiagnosis({
          id: diagnosisId,
          profileId: requested.serverProfileId,
          profileLabel: recoveryIntentExpiryHandoff.serverProfileLabel,
          areaLabel: requested.areaLabel,
          kind: 'expired_area_review',
        });
        if (opened === 'opened') return;
        if (pendingRecoveryIntentConnectionDiagnosis?.id === diagnosisId) {
          pendingRecoveryIntentConnectionDiagnosis = null;
        }
        restoreQuietHandoff();
      });
      return 'started';
    }
    const markDiagnosisRecheckStarted = (): boolean => {
      const deferred = recoveryIntentExpiredDeferredCheck;
      if (deferred === null) return false;
      const started = recoveryIntentDeferredCheckStore
        .markDiagnosisRecheckStarted(deferred);
      if (started === null) return false;
      recoveryIntentExpiredDeferredCheck = started;
      return true;
    };
    const landForDiagnosisRecheck = (
      handle: RecoveryContextProbe,
      routeJustMounted: boolean,
    ): void => {
      if (!matchesLineage() || !markDiagnosisRecheckStarted()) {
        clearRecoveryIntentExpiryHandoff();
        return;
      }
      if (connectionStatus.status() !== 'connected') {
        recordRecoveryIntentDiagnosisRecheckFailure('server');
        publishHandoffAfterAttentionAction();
        return;
      }
      const generation = ++recoveryIntentExpiryReviewGeneration;
      recoveryIntentExpiryReviewInFlight = true;
      setRecoveryIntentExpiryHandoffState('rechecking');
      publishHandoffAfterAttentionAction();
      void (async (): Promise<void> => {
        let freshness: Awaited<ReturnType<typeof reconcileRecoveryContext>>;
        if (!routeJustMounted && handle.retryRecoveryContext === undefined) {
          await Promise.resolve();
          freshness = 'mounted_only';
        } else {
          try {
            if (!routeJustMounted) await handle.retryRecoveryContext?.();
            freshness = await reconcileRecoveryContext(handle);
          } catch {
            freshness = 'unavailable';
          }
        }
        if (
          disposed
          || generation !== recoveryIntentExpiryReviewGeneration
          || !matchesLineage()
        ) return;
        recoveryIntentExpiryReviewInFlight = false;
        const currentHash = hashSource?.getHash() ?? activeHash;
        const routeStillActive = !(
          mountedRouteHandle !== handle
          || currentHash !== requested.landingHash
          || parseRouteFromHash(currentHash) !== activeRoute
        );
        if (!routeStillActive) {
          recordRecoveryIntentDiagnosisRecheckFailure('area');
          return;
        }
        if (freshness !== 'current') {
          recordRecoveryIntentDiagnosisRecheckFailure(
            connectionStatus.status() === 'connected' ? 'area' : 'server',
          );
          focusRecoveryReturnLanding('review');
          return;
        }
        clearRecoveryIntentExpiryHandoff();
        focusRecoveryReturnLanding('review');
      })();
    };
    if (requested.phase === 'outcome') {
      if (
        requested.checkBlocker === 'server'
        || connectionStatus.status() !== 'connected'
      ) {
        // Known downtime cannot spend the one-shot choice. Keep it disabled
        // until reconnect, which only removes the blocker.
        setRecoveryIntentExpiryHandoffState(
          'outcome',
          undefined,
          undefined,
          undefined,
          'server',
        );
        return 'unavailable';
      }
      const selectedHash = hashSource?.getHash() ?? activeHash;
      if (selectedHash !== requested.landingHash) {
        pendingRecoveryReturnAction = {
          landingHash: requested.landingHash,
          onArrival: (handle) => landForDiagnosisRecheck(handle, true),
          onDeclined: restoreQuietHandoffAfterAttentionAction,
        };
        navigateHash(requested.landingHash);
        return 'started';
      }
      landForDiagnosisRecheck(mountedRouteHandle, false);
      return 'started';
    }
    const markReviewStarted = (): boolean => {
      const deferred = recoveryIntentExpiredDeferredCheck;
      if (deferred === null) return false;
      const started = recoveryIntentDeferredCheckStore.markReviewStarted(
        deferred,
      );
      if (started === null) return false;
      recoveryIntentExpiredDeferredCheck = started;
      return true;
    };
    const landForBroadReview = (
      handle: RecoveryContextProbe,
      routeJustMounted: boolean,
    ): void => {
      if (!matchesLineage() || !markReviewStarted()) {
        clearRecoveryIntentExpiryHandoff();
        return;
      }
      if (connectionStatus.status() !== 'connected') {
        recordRecoveryIntentExpiryReviewFailure(
          'server',
          recoveryIntentExpiryRetryReasonForStatus(),
        );
        publishHandoffAfterAttentionAction();
        return;
      }
      const generation = ++recoveryIntentExpiryReviewGeneration;
      recoveryIntentExpiryReviewInFlight = true;
      setRecoveryIntentExpiryHandoffState('checking');
      publishHandoffAfterAttentionAction();
      void (async (): Promise<void> => {
        let freshness: Awaited<ReturnType<typeof reconcileRecoveryContext>>;
        if (!routeJustMounted && handle.retryRecoveryContext === undefined) {
          // A settled mount is not evidence of a fresh deliberate review. A
          // route without a retry seam remains reviewable but cannot close the
          // saved retry by inference.
          await Promise.resolve();
          freshness = 'mounted_only';
        } else {
          try {
            // Mounting the broad route already starts its current read. An
            // existing mount must dispatch the route's explicit retry seam.
            if (!routeJustMounted) await handle.retryRecoveryContext?.();
            freshness = await reconcileRecoveryContext(handle);
          } catch {
            freshness = 'unavailable';
          }
        }
        if (
          disposed
          || generation !== recoveryIntentExpiryReviewGeneration
          || !matchesLineage()
        ) return;
        recoveryIntentExpiryReviewInFlight = false;
        const currentHash = hashSource?.getHash() ?? activeHash;
        const routeStillActive = !(
          mountedRouteHandle !== handle
          || currentHash !== requested.landingHash
          || parseRouteFromHash(currentHash) !== activeRoute
        );
        if (!routeStillActive) {
          recordRecoveryIntentExpiryReviewFailure(
            'area',
            'interrupted',
          );
          return;
        }
        if (freshness !== 'current') {
          const connected = connectionStatus.status() === 'connected';
          recordRecoveryIntentExpiryReviewFailure(
            connected ? 'area' : 'server',
            connected
              ? 'unavailable'
              : recoveryIntentExpiryRetryReasonForStatus(),
          );
          focusRecoveryReturnLanding('review');
          return;
        }
        clearRecoveryIntentExpiryHandoff();
        focusRecoveryReturnLanding('review');
      })();
    };

    if (connectionStatus.status() !== 'connected') {
      if (!markReviewStarted()) {
        clearRecoveryIntentExpiryHandoff();
        return 'missing';
      }
      recordRecoveryIntentExpiryReviewFailure(
        'server',
        recoveryIntentExpiryRetryReasonForStatus(),
      );
      publishHandoffAfterAttentionAction();
      return 'started';
    }

    const selectedHash = hashSource?.getHash() ?? activeHash;
    if (selectedHash !== requested.landingHash) {
      pendingRecoveryReturnAction = {
        landingHash: requested.landingHash,
        onArrival: (handle) => landForBroadReview(handle, true),
        onDeclined: restoreQuietHandoffAfterAttentionAction,
      };
      navigateHash(requested.landingHash);
      return 'started';
    }
    landForBroadReview(mountedRouteHandle, false);
    return 'started';
  };

  if (
    deferredRecoveryReturnArrival !== undefined
    && connectionIndicator !== null
  ) {
    const arrival = deferredRecoveryReturnArrival;
    const arrivalHandle = mountedRouteHandle;
    const runRecoveryReturnIntent = (
      intent: RecoveryReturnReceipt['intent'],
      handle: RecoveryContextProbe,
      routeJustMounted = false,
    ): void => {
      if (intent === 'review' && !routeJustMounted) {
        focusRecoveryReturnLanding('review');
        return;
      }
      const performRetry = intent === 'retry' && !routeJustMounted;
      const needsFreshArrivalRead = routeJustMounted || intent === 'return';
      if (
        !performRetry
        && !needsFreshArrivalRead
      ) {
        focusRecoveryReturnLanding(intent);
        return;
      }
      if (performRetry && handle.retryRecoveryContext === undefined) {
        focusRecoveryReturnLanding('review');
        return;
      }
      if (intent === 'retry' || intent === 'return') {
        showRecoveryReturnProgress();
      }
      void (async (): Promise<void> => {
        let freshness: Awaited<ReturnType<typeof reconcileRecoveryContext>>;
        try {
          if (performRetry) await handle.retryRecoveryContext?.();
          freshness = await reconcileRecoveryContext(handle);
        } catch {
          freshness = 'unavailable';
        }
        if (disposed || connectionIndicator === null) return;
        const currentHash = hashSource?.getHash() ?? activeHash;
        const routeStillActive =
          mountedRouteHandle === handle
          && currentHash === arrival.landingHash
          && parseRouteFromHash(currentHash) === activeRoute;
        const nextReceipt = recoveryReturnReceipt({
          profileLabel: arrival.profileLabel,
          areaLabel: arrival.areaLabel,
          ...(arrival.returnContext !== undefined
            ? { returnContext: arrival.returnContext }
            : {}),
          freshness,
          routeStillActive,
          canRetry:
            routeStillActive && handle.retryRecoveryContext !== undefined,
        });
        if (routeStillActive && routeJustMounted && intent === 'review') {
          // A routed Review must land after the destination's initial read.
          // Otherwise its loading render can replace the focused node. Review
          // still makes no freshness claim and does not replay its receipt.
          focusRecoveryReturnLanding('review');
          return;
        }
        if (
          routeStillActive
          && freshness === 'current'
          && routeJustMounted
          && intent !== 'retry'
          && intent !== 'return'
        ) {
          // Continue/choose-again actions complete only after the newly
          // mounted route proves current; they do not replay another receipt.
          focusRecoveryReturnLanding(intent);
          return;
        }
        if (
          routeStillActive
          && intent === 'return'
          && (
            nextReceipt.intent === 'continue'
            || nextReceipt.intent === 'choose_again'
            || nextReceipt.intent === 'review'
          )
        ) {
          focusRecoveryReturnLanding(nextReceipt.intent);
        }
        showRecoveryReturnReceipt(nextReceipt);
      })();
    };
    const recoveryReturnAction = (
      receipt: RecoveryReturnReceipt,
    ): { label: string; onSelect: () => void } => ({
      label: receipt.actionLabel,
      onSelect: () => {
        const selectedHash = hashSource?.getHash() ?? activeHash;
        if (selectedHash !== arrival.landingHash) {
          // The pending closure holds only the scrubbed broad landing and the
          // closed-list intent. The newly mounted route supplies every read.
          pendingRecoveryReturnAction = {
            landingHash: arrival.landingHash,
            onArrival: (handle) => {
              // Mounting the safe route already starts its authoritative read.
              // Treat that read as the requested retry instead of issuing a
              // duplicate request immediately after mount.
              runRecoveryReturnIntent(receipt.intent, handle, true);
            },
            // The banner action dismisses itself before navigation asks the
            // route leave guard. Restore the exact privacy-safe handoff when
            // the person keeps an unsaved draft instead of making it vanish.
            onDeclined: () => showRecoveryReturnReceipt(receipt),
          };
          navigateHash(arrival.landingHash);
          return;
        }
        runRecoveryReturnIntent(receipt.intent, mountedRouteHandle);
      },
    });
    const showRecoveryReturnReceipt = (
      receipt: RecoveryReturnReceipt,
    ): void => {
      if (disposed || connectionIndicator === null) return;
      const afterReconnect = recoveryReturnAfterReconnectReceipt({
        profileLabel: arrival.profileLabel,
        areaLabel: arrival.areaLabel,
      });
      connectionIndicator.showConnectedReceipt({
        copy: receipt.copy,
        tone: receipt.tone,
        action: recoveryReturnAction(receipt),
        afterReconnect: {
          copy: afterReconnect.copy,
          tone: afterReconnect.tone,
          // A connection gap invalidates a route-qualified retry result. The
          // deferred action therefore reviews instead of replaying the retry.
          action: recoveryReturnAction(afterReconnect),
        },
      });
    };
    const showRecoveryReturnProgress = (): void => {
      if (disposed || connectionIndicator === null) return;
      const afterReconnect = recoveryReturnAfterReconnectReceipt({
        profileLabel: arrival.profileLabel,
        areaLabel: arrival.areaLabel,
      });
      connectionIndicator.showConnectedReceipt({
        copy: `Checking ${arrival.areaLabel} on ${arrival.profileLabel} for the latest information…`,
        tone: 'attention',
        afterReconnect: {
          copy: afterReconnect.copy,
          tone: afterReconnect.tone,
          action: recoveryReturnAction(afterReconnect),
        },
      });
    };
    const routeDeparture = new Promise<void>((resolve) => {
      resolveRecoveryReturnDeparture = resolve;
    });
    void Promise.race([
      reconcileRecoveryContext(arrivalHandle).then((freshness) => ({
        freshness,
        routeDeparted: false as const,
      })),
      routeDeparture.then(() => ({
        freshness: 'mounted_only' as const,
        routeDeparted: true as const,
      })),
    ]).then(({ freshness, routeDeparted }) => {
      resolveRecoveryReturnDeparture = null;
      if (disposed || connectionIndicator === null) return;
      const currentHash = hashSource?.getHash() ?? activeHash;
      const routeStillActive =
        !routeDeparted
        && mountedRouteHandle === arrivalHandle
        && currentHash === arrival.landingHash
        && parseRouteFromHash(currentHash) === activeRoute;
      const receipt = recoveryReturnReceipt({
        profileLabel: arrival.profileLabel,
        areaLabel: arrival.areaLabel,
        ...(arrival.returnContext !== undefined
          ? { returnContext: arrival.returnContext }
          : {}),
        freshness,
        routeStillActive,
        canRetry:
          routeStillActive
          && arrivalHandle.retryRecoveryContext !== undefined,
      });
      showRecoveryReturnReceipt(receipt);
    });
  }

  const recoveryIntentRemediationFor = (
    handle: RecoveryContextProbe,
  ): Exclude<AttentionRecoveryIntentRemediation, 'escalated'> => {
    if (connectionStatus.status() !== 'connected') {
      return accountMenu === null ? 'review' : 'connection';
    }
    return handle.retryRecoveryContext === undefined ? 'review' : 'retry';
  };

  const recordRecoveryIntentFailure = (
    remediation: Exclude<AttentionRecoveryIntentRemediation, 'escalated'>,
  ): void => {
    // A settled current-state check is no longer "unfinished", even when its
    // authoritative answer is a failure that needs direct remediation.
    clearRecoveryIntentReviewVerification();
    recoveryIntentFailureCount = Math.min(
      recoveryIntentFailureLimit,
      recoveryIntentFailureCount + 1,
    );
    setRecoveryIntentContinuationState(
      'failed',
      recoveryIntentFailureCount >= recoveryIntentFailureLimit
        ? 'escalated'
        : remediation,
    );
  };

  resumeRecoveryIntentContinuation = (requested, source = 'attention') => {
    const marker = recoveryIntentContinuationMarker;
    if (
      marker === null
      || bootProfileId === null
      || marker.profileId !== bootProfileId
      || requested.serverProfileId !== marker.profileId
      || requested.landingHash !== marker.landingHash
      || requested.intent !== marker.intent
    ) {
      retireRecoveryIntentContinuation();
      return 'missing';
    }
    if (
      recoveryIntentContinuationRunInFlight
      || recoveryIntentContinuationPhase === 'checking'
    ) return 'started';
    if (
      requested.phase !== recoveryIntentContinuationPhase
      || requested.remediation !== recoveryIntentContinuationRemediation
      || (requested.reviewTarget ?? null)
        !== recoveryIntentContinuationReviewTarget
      || (requested.interruptionReason ?? null)
        !== recoveryIntentContinuationInterruptionReason
    ) {
      return 'unavailable';
    }
    const resumable = (
      requested.phase === 'ready'
      && requested.remediation === null
    ) || (
      requested.phase === 'failed'
      && requested.remediation === 'retry'
    ) || (
      source === 'connection_repaired'
      && requested.remediation === 'connection'
      && (
        requested.phase === 'failed'
        || requested.phase === 'waiting_for_connection'
      )
    ) || (
      source === 'review_resolved'
      && (
        requested.phase === 'awaiting_review_outcome'
        || requested.phase === 'verification_ready'
        || requested.phase === 'verification_interrupted'
      )
      && requested.remediation === 'escalated'
      && requested.reviewTarget !== undefined
    );
    if (!resumable) return 'unavailable';
    if (pendingRecoveryReturnAction !== null) return 'unavailable';
    recoveryIntentLandingHash = marker.landingHash;
    const reviewOutcomeTarget = requested.reviewTarget ?? null;
    if (
      source === 'review_resolved'
      && reviewOutcomeTarget !== null
    ) {
      const verification =
        recoveryIntentContinuationStore.armReviewVerification(
          marker,
          reviewOutcomeTarget,
        );
      if (verification === null) return 'unavailable';
      recoveryIntentReviewVerificationTarget = verification.reviewTarget;
      if (connectionStatus.status() !== 'connected') {
        // The owner can ask while a reconnect banner is already present, in
        // which case no new status edge would arrive to interrupt a hung read.
        // Stay on the explicit re-entry choice and dispatch nothing.
        interruptRecoveryIntentReviewVerification('connection');
        return 'unavailable';
      }
    }
    const generation = ++recoveryIntentContinuationRunGeneration;
    recoveryIntentContinuationRunInFlight = true;
    recoveryIntentRetryOnReconnect = false;
    setRecoveryIntentContinuationState('checking');
    const restoreInterruptedResume = (): void => {
      recoveryIntentContinuationRunInFlight = false;
      if (source === 'review_resolved' && reviewOutcomeTarget !== null) {
        interruptRecoveryIntentReviewVerification('navigation');
        return;
      }
      setRecoveryIntentContinuationState('ready');
    };
    const run = (
      handle: RecoveryContextProbe,
      routeJustMounted: boolean,
    ): void => {
      void (async (): Promise<void> => {
        let freshness: Awaited<ReturnType<typeof reconcileRecoveryContext>>;
        if (
          !routeJustMounted
          && handle.retryRecoveryContext === undefined
        ) {
          // An already-mounted route must prove it dispatched a new read. Its
          // previously settled `whenLoaded` promise is never fresh evidence.
          // Yield once so the Attention action can close before the route's
          // Review target takes focus below.
          await Promise.resolve();
          freshness = 'unavailable';
        } else {
          try {
            // A newly mounted route already began its authoritative load. On
            // an existing mount, require its explicit retry seam instead of
            // treating an older successful read as a fresh re-entry check.
            if (!routeJustMounted) await handle.retryRecoveryContext?.();
            freshness = await reconcileRecoveryContext(handle);
          } catch {
            freshness = 'unavailable';
          }
        }
        if (
          disposed
          || generation !== recoveryIntentContinuationRunGeneration
          || recoveryIntentContinuationMarker?.pausedAt !== marker.pausedAt
        ) return;
        const currentHash = hashSource?.getHash() ?? activeHash;
        const routeStillActive =
          mountedRouteHandle === handle
          && currentHash === marker.landingHash
          && parseRouteFromHash(currentHash) === activeRoute;
        if (!routeStillActive) {
          restoreInterruptedResume();
          return;
        }
        if (freshness !== 'current') {
          if (
            source === 'review_resolved'
            && connectionStatus.status() !== 'connected'
            && interruptRecoveryIntentReviewVerification('connection')
          ) return;
          // The owner explicitly asked to re-enter, so orient to the route's
          // current Review condition without inventing another banner receipt.
          recoveryIntentContinuationRunInFlight = false;
          const attentionOpen = approvalAttentionPopover?.isOpen() === true;
          recordRecoveryIntentFailure(recoveryIntentRemediationFor(handle));
          if (!attentionOpen) focusRecoveryReturnLanding('review');
          return;
        }
        const attentionOpen = approvalAttentionPopover?.isOpen() === true;
        if (focusRecoveryReturnLanding(marker.intent, {
          focusBroadFallback: !attentionOpen,
        })) {
          retireRecoveryIntentContinuation(true);
          return;
        }
        // A current legacy/partial route with no useful action remains
        // discoverable in Attention. A closed popover gets the broad content
        // fallback; a reopened popover keeps its dialog focus.
        recoveryIntentContinuationRunInFlight = false;
        recordRecoveryIntentFailure('review');
      })();
    };
    const selectedHash = hashSource?.getHash() ?? activeHash;
    if (selectedHash !== marker.landingHash) {
      pendingRecoveryReturnAction = {
        landingHash: marker.landingHash,
        onArrival: (handle) => run(handle, true),
        // A declined unsaved-work guard leaves the quiet Attention item intact.
        onDeclined: () => {
          if (generation === recoveryIntentContinuationRunGeneration) {
            restoreInterruptedResume();
          }
        },
      };
      navigateHash(marker.landingHash);
      return 'started';
    }
    run(mountedRouteHandle, false);
    return 'started';
  };

  reviewRecoveryIntentContinuation = (requested) => {
    const marker = recoveryIntentContinuationMarker;
    if (
      marker === null
      || bootProfileId === null
      || marker.profileId !== bootProfileId
      || requested.serverProfileId !== marker.profileId
      || requested.landingHash !== marker.landingHash
      || requested.intent !== marker.intent
    ) {
      retireRecoveryIntentContinuation();
      return 'missing';
    }
    const resumingInterruptedReview =
      (
        requested.phase === 'verification_interrupted'
        || requested.phase === 'verification_handoff'
      )
      && requested.remediation === 'escalated'
      && requested.reviewTarget === 'area'
      && recoveryIntentContinuationPhase === requested.phase
      && recoveryIntentContinuationRemediation === 'escalated'
      && recoveryIntentContinuationReviewTarget === 'area'
      && recoveryIntentReviewVerificationTarget === 'area'
      && requested.interruptionReason
        === recoveryIntentContinuationInterruptionReason;
    if (
      !(
        (
          requested.phase === 'failed'
          && recoveryIntentContinuationPhase === 'failed'
          && requested.remediation === recoveryIntentContinuationRemediation
        )
        || resumingInterruptedReview
      )
      || recoveryIntentContinuationRunInFlight
      || pendingRecoveryReturnAction !== null
    ) return 'unavailable';

    const failedRemediation = resumingInterruptedReview
      ? 'escalated'
      : recoveryIntentContinuationRemediation ?? 'review';
    recoveryIntentLandingHash = marker.landingHash;
    const generation = ++recoveryIntentContinuationRunGeneration;
    recoveryIntentContinuationRunInFlight = true;
    setRecoveryIntentContinuationState('checking');
    const landForReview = (
      handle: RecoveryContextProbe,
      routeJustMounted: boolean,
    ): void => {
      void (async (): Promise<void> => {
        if (routeJustMounted) {
          // A newly mounted route owns the read. Review waits for it to settle
          // so loading DOM cannot replace the focused error/status target.
          await reconcileRecoveryContext(handle);
        } else {
          // Let the Attention click finish closing and restore its trigger
          // before the route deliberately takes focus.
          await Promise.resolve();
        }
        if (
          disposed
          || generation !== recoveryIntentContinuationRunGeneration
          || recoveryIntentContinuationMarker?.pausedAt !== marker.pausedAt
        ) return;
        const currentHash = hashSource?.getHash() ?? activeHash;
        const routeStillActive =
          mountedRouteHandle === handle
          && currentHash === marker.landingHash
          && parseRouteFromHash(currentHash) === activeRoute;
        if (!routeStillActive) {
          if (!interruptRecoveryIntentReviewVerification('navigation')) {
            recoveryIntentContinuationRunInFlight = false;
            setRecoveryIntentContinuationState('failed', failedRemediation);
          }
          return;
        }
        if (focusRecoveryReturnLanding('review')) {
          if (failedRemediation === 'escalated') {
            clearRecoveryIntentReviewVerification();
            recoveryIntentContinuationRunInFlight = false;
            setRecoveryIntentContinuationState(
              'awaiting_review_outcome',
              'escalated',
              'area',
            );
            return;
          }
          retireRecoveryIntentContinuation(true);
          return;
        }
        recoveryIntentContinuationRunInFlight = false;
        recordRecoveryIntentFailure('review');
      })();
    };

    const selectedHash = hashSource?.getHash() ?? activeHash;
    if (selectedHash !== marker.landingHash) {
      pendingRecoveryReturnAction = {
        landingHash: marker.landingHash,
        onArrival: (handle) => landForReview(handle, true),
        onDeclined: () => {
          if (generation === recoveryIntentContinuationRunGeneration) {
            if (!interruptRecoveryIntentReviewVerification('navigation')) {
              recoveryIntentContinuationRunInFlight = false;
              setRecoveryIntentContinuationState('failed', failedRemediation);
            }
          }
        },
      };
      navigateHash(marker.landingHash);
      return 'started';
    }
    landForReview(mountedRouteHandle, false);
    return 'started';
  };

  remediateRecoveryIntentConnection = (requested) => {
    const marker = recoveryIntentContinuationMarker;
    if (
      marker === null
      || bootProfileId === null
      || marker.profileId !== bootProfileId
      || requested.serverProfileId !== marker.profileId
      || requested.landingHash !== marker.landingHash
      || requested.intent !== marker.intent
    ) {
      retireRecoveryIntentContinuation();
      return 'missing';
    }
    if (
      requested.remediation !== 'connection'
      || recoveryIntentContinuationRemediation !== 'connection'
      || (
        requested.phase !== 'failed'
        && requested.phase !== 'waiting_for_connection'
      )
      || requested.phase !== recoveryIntentContinuationPhase
      || recoveryIntentContinuationRunInFlight
      || pendingRecoveryReturnAction !== null
      || accountMenu === null
    ) return 'unavailable';

    // A reconnect may win the race with the owner's click. In that case skip
    // the detour and immediately run the same exact continuation.
    if (connectionStatus.status() === 'connected') {
      return resumeRecoveryIntentContinuation(
        requested,
        'connection_repaired',
      );
    }

    recoveryIntentRetryOnReconnect = true;
    setRecoveryIntentContinuationState(
      'waiting_for_connection',
      'connection',
    );
    const pausedAt = marker.pausedAt;
    void Promise.resolve().then(() => {
      if (
        recoveryIntentContinuationMarker?.pausedAt !== pausedAt
        || recoveryIntentContinuationPhase !== 'waiting_for_connection'
        || recoveryIntentContinuationRemediation !== 'connection'
        || connectionStatus.status() === 'connected'
        || accountMenu === null
      ) return;
      accountMenu.open();
    });
    return 'started';
  };

  reviewRecoveryIntentServer = (requested) => {
    const marker = recoveryIntentContinuationMarker;
    if (
      marker === null
      || bootProfileId === null
      || marker.profileId !== bootProfileId
      || requested.serverProfileId !== marker.profileId
      || requested.landingHash !== marker.landingHash
      || requested.intent !== marker.intent
    ) {
      retireRecoveryIntentContinuation();
      return 'missing';
    }
    const resumingInterruptedReview =
      (
        (
          requested.phase === 'verification_interrupted'
          && requested.reviewTarget === 'server'
        )
        || requested.phase === 'verification_handoff'
      )
      && requested.reviewTarget !== undefined
      && recoveryIntentContinuationPhase === requested.phase
      && recoveryIntentContinuationReviewTarget === requested.reviewTarget
      && recoveryIntentReviewVerificationTarget === requested.reviewTarget
      && requested.interruptionReason
        === recoveryIntentContinuationInterruptionReason;
    const unresolvedReceiptReview =
      requested.phase === 'awaiting_review_outcome'
      && requested.reviewTarget === 'server'
      && requested.serverControlOutcome !== undefined
      && isUnresolvedServerControlActionOutcome(
        requested.serverControlOutcome,
      )
      && recoveryIntentContinuationPhase === 'awaiting_review_outcome'
      && recoveryIntentContinuationReviewTarget === 'server'
      && recoveryIntentServerControlOutcome !== null
      && isUnresolvedServerControlActionOutcome(
        recoveryIntentServerControlOutcome,
      )
      && serverControlActionOutcomesMatch(
        requested.serverControlOutcome,
        recoveryIntentServerControlOutcome,
      );
    if (
      !(
        (
          requested.phase === 'failed'
          && recoveryIntentContinuationPhase === 'failed'
        )
        || resumingInterruptedReview
        || unresolvedReceiptReview
      )
      || requested.remediation !== 'escalated'
      || recoveryIntentContinuationRemediation !== 'escalated'
      || recoveryIntentContinuationRunInFlight
      || pendingRecoveryReturnAction !== null
      || accountMenu === null
      || !accountMenu.canOpenConnectionDiagnosis(marker.profileId)
    ) return 'unavailable';

    let diagnosisId: string | null = null;
    if (
      requested.phase === 'verification_handoff'
      && requested.reviewTarget !== undefined
      && requested.interruptionReason !== undefined
    ) {
      diagnosisId = `recovery-verification:${marker.pausedAt}:${
        ++recoveryIntentConnectionDiagnosisSequence
      }`;
      pendingRecoveryIntentConnectionDiagnosis = {
        source: 'bounded_handoff',
        id: diagnosisId,
        profileId: marker.profileId,
        landingHash: marker.landingHash,
        intent: marker.intent,
        pausedAt: marker.pausedAt,
        reviewTarget: requested.reviewTarget,
        interruptionReason: requested.interruptionReason,
      };
    } else if (
      unresolvedReceiptReview
      && requested.serverControlOutcome !== undefined
    ) {
      diagnosisId = `recovery-server-re-review:${marker.pausedAt}:${
        ++recoveryIntentConnectionDiagnosisSequence
      }`;
      pendingRecoveryIntentConnectionDiagnosis = {
        source: 'unresolved_receipt',
        id: diagnosisId,
        profileId: marker.profileId,
        landingHash: marker.landingHash,
        intent: marker.intent,
        pausedAt: marker.pausedAt,
        priorServerOutcome: { ...requested.serverControlOutcome },
      };
    }
    // A bounded handoff remains durably bounded while Account owns the review.
    // Only its explicit Return action releases the old verifier. An unresolved
    // receipt stays memory-only and keeps its exact projection while Account
    // reopens the current profile's controls; neither path replays an action.
    const pausedAt = marker.pausedAt;
    void Promise.resolve().then(() => {
      if (
        recoveryIntentContinuationMarker?.pausedAt !== pausedAt
        || recoveryIntentContinuationPhase !== requested.phase
        || recoveryIntentContinuationRemediation !== 'escalated'
        || recoveryIntentContinuationReviewTarget
          !== (requested.reviewTarget ?? null)
        || recoveryIntentContinuationInterruptionReason
          !== (requested.interruptionReason ?? null)
        || (
          unresolvedReceiptReview
          && !serverControlActionOutcomesMatch(
            requested.serverControlOutcome,
            recoveryIntentServerControlOutcome,
          )
        )
        || accountMenu === null
      ) {
        if (
          diagnosisId !== null
          && pendingRecoveryIntentConnectionDiagnosis?.id === diagnosisId
        ) {
          pendingRecoveryIntentConnectionDiagnosis = null;
          approvalAttentionPopover?.open();
        }
        return;
      }
      if (diagnosisId !== null) {
        const pending = pendingRecoveryIntentConnectionDiagnosis;
        if (pending === null || pending.id !== diagnosisId) {
          approvalAttentionPopover?.open();
          return;
        }
        const diagnosis = {
          id: diagnosisId,
          profileId: marker.profileId,
          profileLabel: bootProfileLabel,
          areaLabel: serverSwitchLandingAreaLabel(marker.landingHash),
          ...(pending.source === 'bounded_handoff'
            ? { interruptionReason: pending.interruptionReason }
            : {}),
        };
        const opened = pending.source === 'unresolved_receipt'
          ? accountMenu.openConnectionDiagnosis(diagnosis, {
              initialServerOutcome: pending.priorServerOutcome,
              reviewServerControls: true,
            })
          : accountMenu.openConnectionDiagnosis(diagnosis);
        if (opened !== 'opened') {
          if (pendingRecoveryIntentConnectionDiagnosis?.id === diagnosisId) {
            pendingRecoveryIntentConnectionDiagnosis = null;
          }
          approvalAttentionPopover?.open();
        }
        return;
      }
      clearRecoveryIntentReviewVerification();
      setRecoveryIntentContinuationState(
        'awaiting_review_outcome',
        'escalated',
        'server',
      );
      accountMenu.open();
    });
    return 'started';
  };

  keepRecoveryIntentReviewBlocked = (requested) => {
    const marker = recoveryIntentContinuationMarker;
    if (
      marker === null
      || bootProfileId === null
      || marker.profileId !== bootProfileId
      || requested.serverProfileId !== marker.profileId
      || requested.landingHash !== marker.landingHash
      || requested.intent !== marker.intent
    ) {
      retireRecoveryIntentContinuation();
      return 'missing';
    }
    if (
      requested.phase !== 'awaiting_review_outcome'
      || requested.remediation !== 'escalated'
      || requested.reviewTarget === undefined
      || recoveryIntentContinuationPhase !== 'awaiting_review_outcome'
      || recoveryIntentContinuationRemediation !== 'escalated'
      || recoveryIntentContinuationReviewTarget !== requested.reviewTarget
      || recoveryIntentContinuationRunInFlight
      || pendingRecoveryReturnAction !== null
    ) return 'unavailable';

    // The person explicitly kept this blocked, so a prepared post-
    // reconciliation check is no longer the next promised action. Retain the
    // parent return but clear that narrow obligation before closing Attention.
    clearRecoveryIntentReviewVerification();
    return 'started';
  };

  deferRecoveryIntentVerification = (requested) => {
    const marker = recoveryIntentContinuationMarker;
    if (
      marker === null
      || bootProfileId === null
      || marker.profileId !== bootProfileId
      || requested.serverProfileId !== marker.profileId
      || requested.landingHash !== marker.landingHash
      || requested.intent !== marker.intent
    ) {
      retireRecoveryIntentContinuation();
      return 'missing';
    }
    if (
      requested.phase !== 'verification_ready'
      || requested.remediation !== 'escalated'
      || requested.reviewTarget !== 'server'
      || recoveryIntentContinuationPhase !== 'verification_ready'
      || recoveryIntentContinuationRemediation !== 'escalated'
      || recoveryIntentContinuationReviewTarget !== 'server'
      || recoveryIntentReviewVerificationTarget !== 'server'
      || recoveryIntentContinuationInterruptionReason !== null
      || (requested.deferredAt ?? null)
        !== (recoveryIntentDeferredCheck?.deferredAt ?? null)
      || (requested.expiresAt ?? null)
        !== (recoveryIntentDeferredCheck?.expiresAt ?? null)
      || recoveryIntentContinuationRunInFlight
      || pendingRecoveryReturnAction !== null
    ) return 'unavailable';

    const deferred = recoveryIntentDeferredCheckStore.defer(marker);
    if (deferred === null) return 'unavailable';
    recoveryIntentDeferredCheck = deferred;
    recoveryIntentContinuation = recoveryIntentContinuationPresentation(
      marker,
    );
    approvalAttentionPopover?.setRecoveryIntentContinuation(
      recoveryIntentContinuation,
    );
    // The parent and unfinished-check markers remain byte-for-byte unchanged.
    // A third intent-free marker only quiets their presentation and preserves
    // a bounded broad-area handoff after expiry; no route or request starts.
    return 'started';
  };

  const finishPendingRecoveryReturnAction = (hash: string): void => {
    const pending = pendingRecoveryReturnAction;
    if (pending === null || pending.landingHash !== hash) return;
    pendingRecoveryReturnAction = null;
    pending.onArrival(mountedRouteHandle);
  };

  // 5.5. § A.6.5 + § A.9 / slice 116 — passport-fetch verify pipeline.
  //      Subscribed BEFORE `ws.connect()` (DD#7) so the initial
  //      `'connecting' → 'connected'` transition catches the listener;
  //      every subsequent reconnect re-fires it via the ws-client's
  //      backoff loop. Closes the WS-handshake side of the two-pin
  //      overlap protocol end-to-end: the rotation-notice handler
  //      stages `next_fingerprint`; this verify path promotes it on
  //      observation of the new cert + retains `previous_fingerprint`
  //      so a post-promotion `cert.rotation_reverted` still finds the
  //      OLD current as a trusted rollback target (slice 115 follow-up
  //      contract change).
  //
  //      Fire-and-forget — a slow rpc + verify pipeline must not
  //      back-pressure the WS reconnect loop. Concurrent invocations
  //      (a reconnect storm) are tolerated: each call composes against
  //      the freshest pin state at its own moment, the last persist
  //      wins, and the server's vouched cert is the same per reconnect
  //      attempt so the outcome is deterministic.
  //
  //      Gated on `enablePassportFetchVerify !== false` (default-on
  //      post-slice 128; tests + bespoke compositions opt out by
  //      passing `false`). `not_configured` from the server-side rpc
  //      (db-less harness or a boot whose `passportFetchDeps` haven't
  //      composed) routes to `onPassportFetchVerifyError` with
  //      `stage: 'rpc'`; the WS stays connected + the panel keeps
  //      rendering, so the surface graduates to "real defense" once
  //      the providers wire up without re-bootstrapping the webclient.
  //
  // Default flipped from `=== true` to `!== false` in slice 128. The
  // substrate composer landed in slice 117 + the explicit production
  // opt-in shipped in slice 118; this slice closes the loop so dev
  // compositions inherit the verify path automatically. The
  // fire-and-forget orchestrator shape (`void runPassportFetchVerify
  // (...)`) means an unanswered rpc call (fake transport / no rpc
  // handler) lands on the error sink + times out without
  // back-pressuring the bootstrap, so test fixtures stay green by
  // default; opt out only when the test is specifically about
  // asserting rpc call ordering.
  const passportFetchVerifyEnabled =
    options.enablePassportFetchVerify !== false;
  // D-156 P8 — re-auth funnel (Codex P1 fold). The pair-required
  // handler + banner retired in this slice (spec § Open questions
  // Q2); the only remaining way to surface a re-pair signal is the
  // host's `onReauthRequired` callback, which the webclient main
  // wires to wipe-and-remount. Two paths feed this funnel:
  //   (1) `ws-client` transitions to `reauth_required` — the server
  //       closed the WS with 1008/4401 because the bearer is no
  //       longer accepted (e.g. server_identity_key rotated → every
  //       paired client is kicked).
  //   (2) `runPassportFetchVerify` rejects with
  //       `observed_fingerprint_unknown` — MITM-class signal where
  //       the passport's cert claim doesn't match the pinned
  //       fingerprint AND a prior pin exists.
  // Both paths fire the callback once per session. The fire-once
  // guard prevents duplicate wipes if both paths trigger
  // (a MITM signal usually leads to a server-side reject too).
  let reauthFired = false;
  const fireOnReauthRequired = (): void => {
    if (intentionalProfileRetirement) {
      suppressedRetirementReauth = true;
      return;
    }
    if (reauthFired) return;
    reauthFired = true;
    if (options.onReauthRequired) {
      try {
        options.onReauthRequired();
      } catch {
        /* caller sink isolation — see runPassportFetchVerify */
      }
    }
  };
  replaySuppressedRetirementReauth = (): void => {
    if (!suppressedRetirementReauth || intentionalProfileRetirement) return;
    suppressedRetirementReauth = false;
    fireOnReauthRequired();
  };

  const onPassportFetchPairRequiredHandler = (
    context: PassportFetchVerifyPairRequiredContext,
  ): void => {
    void ws.disconnect().catch(() => {
      /* disconnect failures are best-effort — the WS itself is the
       * threat; the reauth funnel + bootstrap fallback is the
       * backstop. */
    });
    if (options.onPassportFetchPairRequired) {
      try {
        options.onPassportFetchPairRequired(context);
      } catch {
        /* caller sink isolation — see runPassportFetchVerify */
      }
    }
    fireOnReauthRequired();
  };

  // Subscribe to the ws-client state machine: any transition into
  // `reauth_required` funnels into the host's recovery path.
  // Subscribed BEFORE `ws.connect()` so the very first auth-rejected
  // handshake (e.g. server already rotated before the user opened
  // the page) lands on the callback.
  const detachReauthListener = ws.onState((state) => {
    if (state === 'reauth_required') fireOnReauthRequired();
  });
  const detachPassportFetchOnConnect: () => void =
    passportFetchVerifyEnabled
      ? ws.onState((state) => {
          if (state !== 'connected') return;
          void runPassportFetchVerify({
            conn: rpcConn.call,
            localStore: options.localStore,
            pinnedServerPublicKey: pair.serverPublicKey,
            ...(certPinWatcher !== null
              ? { certPinWatcher }
              : {}),
            ...(options.now !== undefined ? { now: options.now } : {}),
            ...(options.onPassportFetchVerifyError !== undefined
              ? { onError: options.onPassportFetchVerifyError }
              : {}),
            onPairRequired: onPassportFetchPairRequiredHandler,
          });
        })
      : (): void => undefined;

  // 6.0. `events.subscribe` rpc — DD#8. Without this round-trip the
  //      server never starts pushing broadcasts to this client (see
  //      `backend/server/src/events/handler.ts` — the bus only fans
  //      out to subscribers that have called `events.subscribe`). Every
  //      paired client subscribes by default to the full
  //      `WEBCLIENT_DEFAULT_SUBSCRIPTIONS` set so the Reception page,
  //      the rotation handler, and every future shell receives its
  //      events. The call is fire-and-forget — failures land in
  //      `onSubscribeError` if supplied (best-effort telemetry sink).
  //
  //      Re-fired on EVERY (re)connect, not just the first. The server
  //      drops a client's bus subscription when its socket closes, and a
  //      RESTARTED server (e.g. after a restore commit) boots with no
  //      subscription record at all — so a one-shot subscribe goes dead
  //      the moment the socket first drops, and live updates never
  //      resume. Driving it off the connection-status controller's
  //      `connected` transitions re-registers the bus on each reconnect.
  const fireEventsSubscribe = (): void => {
    void rpcConn
      .call('events.subscribe', {
        kinds: [...WEBCLIENT_DEFAULT_SUBSCRIPTIONS],
      })
      .catch((err: unknown) => {
        if (!options.onSubscribeError) return;
        const wrapped = err instanceof Error ? err : new Error(String(err));
        try {
          options.onSubscribeError(wrapped);
        } catch {
          /* failure-report sink must never re-enter the bootstrap */
        }
      });
  };
  // Subscribed BEFORE `ws.connect()` so the controller's initial
  // `connecting → connected` transition (emitted during the connect
  // below) catches it + fires the first subscribe; every subsequent
  // reconnect re-fires it. Detached in dispose.
  const detachResubscribe = connectionStatus.onStatus((status) => {
    if (status === 'connected') fireEventsSubscribe();
  });

  // 6. Auto-connect the ws-client (DD#3).
  await ws.connect();

  // 6.6. § A.6.5 / slice 114 — cert-pin overlap panel polling tick
  //      (DD#10). When a watcher is constructed (default-on production
  //      composition), schedule a recurring timer that calls
  //      `activeSettingsRoute?.certPinStalePanel()?.update()` every
  //      `certPinPollIntervalMs` (60s by default). The optional chain
  //      no-ops when Reception is the active route (settings handle is
  //      null) + when the watcher's state has no staged rotation
  //      (panel mount returns null from `certPinStalePanel()` only
  //      when the bootstrap omitted the watcher; otherwise the mount
  //      handle exists + its `update()` re-evaluates the render-time
  //      gate against the current clock). Gated on
  //      `certPinWatcher !== null` so a `enableCertPinStalePanel:
  //      false` boot pays zero timer cost.
  const setCertPinPollTimer =
    options.setCertPinPollTimer ?? realCertPinPollTimer;
  const certPinPollIntervalMs =
    options.certPinPollIntervalMs ?? CERT_PIN_POLL_INTERVAL_MS;
  const certPinPollHandle: { cancel: () => void } | null =
    certPinWatcher !== null
      ? setCertPinPollTimer(() => {
          activeSettingsRoute?.certPinStalePanel()?.update();
        }, certPinPollIntervalMs)
      : null;


  // Hash listener — when the user navigates to a different route, tear
  // down the current mount + mount the new route via `mountRoute`. A
  // hashchange that resolves to the active route is a no-op so the
  // listener stays cheap — UNLESS it's a deep-link surface whose segment
  // changed (e.g. `#logs/<a>` → `#logs/<b>`), which re-mounts so the new
  // `initial*` selection takes (§D.shell). Slice 110 made the two-route
  // case real: `#reception` ↔ `#settings` flips the route through the helper.
  const detachHash = hashSource
    ? hashSource.onChange((hash) => {
        if (
          hash !== activeHash
          && recoveryIntentContinuationPhase === 'checking'
          && recoveryIntentReviewVerificationTarget !== null
          && pendingRecoveryReturnAction?.landingHash !== hash
        ) {
          // Leaving while the post-review read is pending makes its answer
          // unsafe to apply to the new view. Preserve only explicit re-entry.
          interruptRecoveryIntentReviewVerification('navigation');
        }
        if (hash !== activeHash) recoveryIntentOrientation?.clear();
        const next = resolveRoute(hash);
        const remountForDeepLink =
          next === activeRoute
          && shouldRemountForSameRoute(next, activeHash, hash);
        if (next === activeRoute && !remountForDeepLink) {
          if (hash !== activeHash) {
            interruptRecoveryIntentExpiryReviewForNavigation(hash);
            markRecoveryReturnDeparted();
          }
          finishPendingRecoveryReturnAction(hash);
          return;
        }
        if (
          remountForDeepLink
          && mountedRouteHandle.navigateDeepLink?.(hash) === true
        ) {
          interruptRecoveryIntentExpiryReviewForNavigation(hash);
          markRecoveryReturnDeparted();
          activeHash = hash;
          appShell.setActiveRoute(next, parseShellRoute(hash).segments);
          finishPendingRecoveryReturnAction(hash);
          return;
        }
        // Leave guards — route-owned in-flight work may opt in with contextual
        // copy, and unsaved work (Kitchen editors, Settings drafts, or Chat)
        // always gets a chance to keep the user. Declining restores the URL by
        // SETTING the hash (a new entry) — replaceState would DESTROY the
        // history entry a Back/Forward decline traversed to, decaying the back
        // stack entry by entry. The resulting hashchange re-dispatch no-ops
        // here (same route, same hash). Environments without confirm (tests)
        // proceed.
        const view = doc?.defaultView;
        const declineRouteLeave = (): void => {
          const declinedRecoveryReturn = pendingRecoveryReturnAction;
          pendingRecoveryReturnAction = null;
          declinedRecoveryReturn?.onDeclined();
          if (view?.location !== undefined) {
            view.location.hash = activeHash;
          } else if (view?.history?.replaceState !== undefined) {
            view.history.replaceState(null, '', activeHash);
          }
        };
        const inFlightPrompt =
          mountedRouteHandle.inFlightWorkPrompt?.()?.trim() ?? '';
        if (
          inFlightPrompt.length > 0
          && mountedRouteHandle.hasInFlightWork?.() === true
        ) {
          const proceed = typeof view?.confirm === 'function'
            ? view.confirm(inFlightPrompt)
            : true;
          if (!proceed) {
            declineRouteLeave();
            return;
          }
        } else if (mountedRouteHandle.hasUnsavedChanges?.() === true) {
          const routePrompt =
            mountedRouteHandle.unsavedChangesPrompt?.()?.trim();
          const proceed =
            typeof view?.confirm === 'function'
              ? view.confirm(
                  routePrompt && routePrompt.length > 0
                    ? routePrompt
                    : 'Discard unsaved changes?',
                )
              : true;
          if (!proceed) {
            declineRouteLeave();
            return;
          }
        }
        interruptRecoveryIntentExpiryReviewForNavigation(hash);
        markRecoveryReturnDeparted();
        mountedRouteHandle.dispose();
        activeRoute = next;
        activeHash = hash;
        appShell.setActiveRoute(next, parseShellRoute(hash).segments);
        mountedRouteHandle = mountRoute(next);
        finishPendingRecoveryReturnAction(hash);
      })
    : (): void => undefined;

  // Tab-close twin of the leave guard: while the mounted route holds unsaved
  // work, or persistent Attention chrome owns an unresolved decision,
  // closing/reloading the tab asks first. Routes never register their own
  // listeners.
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    const guardedInFlightPrompt =
      mountedRouteHandle.inFlightWorkPrompt?.()?.trim() ?? '';
    if (
      !intentionalServerSwitchReload
      && (
        approvalAttentionPopover?.hasInFlightWork() === true
        || drawerCreateOverlay?.hasUnsavedChanges() === true
        || drawerCreateOverlay?.hasInFlightWork() === true
        || mountedRouteHandle.hasUnsavedChanges?.() === true
        || (
          guardedInFlightPrompt.length > 0
          && mountedRouteHandle.hasInFlightWork?.() === true
        )
      )
    ) {
      event.preventDefault();
      // Chrome requires a set returnValue for the native prompt.
      event.returnValue = '';
    }
  };
  const beforeUnloadView = doc?.defaultView;
  if (typeof beforeUnloadView?.addEventListener === 'function') {
    beforeUnloadView.addEventListener('beforeunload', onBeforeUnload);
  }

  return {
    activeRoute: () => activeRoute,
    receptionShell: () => receptionShell,
    conn: () => rpcConn.call,
    settingsRoute: () => activeSettingsRoute,
    certPinStateWatcher: () => certPinWatcher,
    serverProfileId: () => bootProfileId,
    requestServerProfileConvergence,
    refreshServerProfiles: () => requestServerProfileRefresh(),
    captureRecoverySnapshot: () => {
      const chatDraft = mountedRouteHandle.getRecoveryDraft?.() ?? null;
      return {
        returnHash: activeHash,
        ...(chatDraft !== null ? { chatDraft } : {}),
      };
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      pendingRecoveryReturnAction = null;
      markRecoveryReturnDeparted();
      detachPendingServerSwitchSignal();
      if (options.onSessionDispose) {
        try {
          options.onSessionDispose();
        } catch {
          // Host lifecycle cleanup is best-effort; shell teardown must finish.
        }
      }
      // DD#6 — reverse construction order. Token-rotation handler is
      // disposed AFTER the reception shell so any in-flight
      // `token.rotated` broadcast still reaches the shell's pending-
      // approvals refresh if it cares; in practice the shell ignores
      // this kind, but the ordering keeps the contract uniform with
      // every other subscriber.
      // DD#10 — cancel the cert-pin polling tick BEFORE the route
      // mount disposes so a tick that fires mid-dispose doesn't try
      // to call `update()` on a torn-down panel mount. Idempotent —
      // the cancel handle is null when polling is disabled.
      if (certPinPollHandle !== null) certPinPollHandle.cancel();
      // Slice 116 — detach the ws-state listener that drives the
      // post-WS-connect passport-fetch verify pipeline. Detached
      // BEFORE `ws.disconnect()` below so a `'connected' → 'closed'`
      // transition fired by dispose can't re-trigger the orchestrator
      // against a torn-down rpcConn. Idempotent — the closure resolves
      // to a no-op when `enablePassportFetchVerify: false`.
      detachPassportFetchOnConnect();
      detachReauthListener();
      profileRecencyObserverDisposed = true;
      detachProfileRecency();
      // Detach the reconnect-driven `events.subscribe` re-fire BEFORE
      // `ws.disconnect()` so the dispose-fired `'closed'` transition
      // can't re-enter a torn-down rpcConn.
      detachResubscribe();
      detachHash();
      if (typeof beforeUnloadView?.removeEventListener === 'function') {
        beforeUnloadView.removeEventListener('beforeunload', onBeforeUnload);
      }
      detachChatTurnCompleteWork();
      detachChatTurnFailedWork();
      for (const lease of [...chatTurnLeases]) releaseChatTurnLease(lease);
      settledChatTurnIds.clear();
      recoveryIntentContinuationRunInFlight = false;
      recoveryIntentExpiryReviewGeneration += 1;
      recoveryIntentExpiryReviewInFlight = false;
      detachRecoveryIntentReviewVerificationStatus();
      detachRecoveryIntentContinuationReconnect();
      detachRecoveryIntentOwnershipListeners();
      cancelRecoveryIntentContinuationExpiry();
      cancelRecoveryIntentExpiryHandoff();
      recoveryIntentOrientation?.dispose();
      mountedRouteHandle.dispose();
      foundationalOAuthContinuity.dispose();
      detachCredentialRotationServerUpdateGuide();
      detachCredentialRotationServerUpdateGuide = () => undefined;
      detachCredentialRotationCapabilityResolution();
      detachCredentialRotationCapabilityResolution = () => undefined;
      detachCredentialRotationCapabilityLineage();
      detachCredentialRotationCapabilityLineage = () => undefined;
      detachCredentialRotationCapabilityReconnect();
      detachCredentialRotationCapabilityReconnect = () => undefined;
      detachServerUpdateReceiptVerification();
      detachServerUpdateReceiptVerification = () => undefined;
      serverUpdateReceiptVerification?.dispose();
      serverUpdateReceiptVerification = null;
      credentialRotationCapabilityCheckGeneration += 1;
      credentialRotationCapabilityCheck = null;
      credentialRotationServerUpdateContinuity.dispose();
      credentialRotationTabConvergence?.close();
      detachInactiveProfileRecoveryDiscovery();
      detachInactiveProfileRecoveryDiscovery = () => undefined;
      inactiveProfileRecoveryDiscovery.close();
      if (approvalAttentionPopover !== null) {
        approvalAttentionPopover.dispose();
      }
      if (pendingChatPlansStore !== null) {
        pendingChatPlansStore.dispose();
      }
      // Dispose the live-control bubble BEFORE the shell tears down its root
      // (the bubble mounts into `appShell.root`).
      if (liveControlBubble !== null) {
        liveControlBubble.dispose();
      }
      // Dispose the connection indicator BEFORE the shell tears down its root
      // (the announcer mounts into `appShell.connectionHost`; the banner into
      // `options.root`).
      if (connectionIndicator !== null) {
        connectionIndicator.dispose();
      }
      // Same — Account owns the theme and server-control hosts, so both child
      // mounts dispose before their parent removes the dialog subtree.
      if (unsubscribeAccountStatus !== null) {
        unsubscribeAccountStatus();
        unsubscribeAccountStatus = null;
      }
      detachServerSwitchWork();
      detachServerSwitchWork = (): void => undefined;
      if (themeToggle !== null) {
        themeToggle.dispose();
        themeToggle = null;
      }
      if (serverPill !== null) {
        serverPill.dispose();
        serverPill = null;
      }
      if (accountMenu !== null) {
        accountMenu.dispose();
        accountMenu = null;
      }
      // Tear down a drawer-opened Create overlay — it portals to document.body
      // (OUTSIDE the shell root), so `appShell.dispose()` won't reach it; left
      // open it would leak its DOM node, document keydown listener, and the
      // compose route's rpc closures. (The chat-route-opened overlay is closed
      // by the chat route's own dispose via `mountedRouteHandle.dispose()`.)
      if (drawerCreateOverlay !== null) {
        drawerCreateOverlay.close();
        drawerCreateOverlay = null;
      }
      // The convergence overlay portals beside the shell and marks the shell
      // inert, so retire it before removing either subtree.
      closeServerSwitchConvergence();
      appShell.dispose();
      detachExposureChanged();
      receptionShell.dispose();
      certPin.dispose();
      if (certPinWatcher !== null) certPinWatcher.dispose();
      // D-169 P2 Slice 5 (toast half) — drop the toast's bus subscription +
      // clear its pending auto-dismiss timers before `detachBroadcast()`
      // stops feeding the subscriber.
      if (notifyToasts !== null) notifyToasts.dispose();
      tokenRotation.dispose();
      rpcConn.dispose();
      // Dispose the connection-status controller AFTER the rpcConn (which
      // detaches its own onStatus listener in dispose) — detaches the
      // ws-state subscription + cancels the grace timer.
      connectionStatus.dispose();
      detachBroadcast();
      await ws.disconnect();
    },
  };
};
