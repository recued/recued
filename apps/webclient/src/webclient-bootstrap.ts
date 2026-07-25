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
 *  Spec: docs/d-148-spec.md § A.4 (Thin Webclient). */

import type {
  Conn,
  DiagnosticResponse,
  HostnameProjection,
  ReachabilityReport,
  RpcRequest,
  ServerRpcRegistry,
  WebclientTokenRecord,
} from '@recued/contracts';
import { canBindHostname } from '@recued/contracts';
import { Upload } from '@recued/ui-shared';

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
  mountWebclientServerPill,
  isServerHeartbeatSnapshot,
  SERVER_PILL_STYLES,
  SERVER_PILL_STYLES_MARKER,
  SERVER_PILL_HOST_ATTR,
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
import { bootstrapReceptionRoute } from './settings/reception-bootstrap.js';
import { createArchiveDownload } from './settings/archive-download.js';
import { createArchiveUpload } from './settings/archive-upload.js';
import { createArchiveRebindStash } from './settings/archive-rebind-stash.js';
import {
  bootstrapSettingsRoute,
  type SettingsRoute,
} from './settings/bootstrap-settings-route.js';
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
import type {
  WorkEntitiesPanelClearDefaultCaller,
  WorkEntitiesPanelSetDefaultCaller,
  WorkEntitiesPanelSetEnabledCaller,
  WorkEntitiesPanelSetMcpExposedCaller,
  WorkEntitiesPanelSourceListCaller,
} from './settings/work-entities-panel-mount.js';
import {
  bootstrapApprovalsRoute,
  type ApprovalChangedSubscriber,
  type ApprovalListCaller,
  type ApprovalResolveCaller,
  type ApprovalSubscribeCaller,
} from './approvals/bootstrap-approvals-route.js';
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
  type GrantContractsCaller as GrantMatrixContractsCaller,
  type GrantCatalogOperationsCaller,
  type GrantRegistryDescribeCaller,
  type GrantSetDoorTypesCaller,
} from './contracts/contract-grants-panel.js';
import {
  bootstrapConnectionsRoute,
} from './connections/bootstrap-connections-route.js';
import {
  bootstrapPacksRoute,
  resolvePackInput,
} from './packs/bootstrap-packs-route.js';
import {
  bootstrapRecipesRoute,
  type RecipeExecuteCaller,
  type RecipesListCaller,
  type RecipesPiiCaller,
  type RecipesRunnabilityCaller,
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
  type DataFormResponseGetCaller,
  type DataFormResponseListCaller,
  type DataMemoryCreateCaller,
  type DataMemoryDeleteCaller,
  type DataMemoryGetCaller,
  type DataMemoryImportCaller,
  type DataMemoryListCaller,
  type DataMemoryUpdateCaller,
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
  type ChatRouteConn,
} from './chat/bootstrap-chat-route.js';
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
  parseRouteFromHash,
  parseShellRoute,
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
  PacksInstallCaller,
  PacksListCaller,
  PacksResolveCaller,
  PacksUninstallCaller,
} from './settings/packs-panel.js';
import type {
  SupervisionListCaller,
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
  type ApprovalAttentionPopoverMount,
} from './attention/approval-attention-popover.js';
import {
  mountLiveControlBubble,
  type LiveControlBubbleMount,
} from './live-control/live-control-bubble.js';
import {
  mountThemeToggle,
  THEME_TOGGLE_ATTR,
  THEME_TOGGLE_STYLES,
} from './shell/theme-controller.js';
import type {
  MailLaneCallers,
  CalendarLaneCallers,
  FileLaneCallers,
} from './connections/accounts-lane-panel.js';
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
  ConnectionsEnrollListCaller,
  ConnectionsEnrollCaller,
  ConnectionsUpdateCaller,
  ConnectionsDeleteCaller,
  ConnectionsPreviewPurgeCaller,
  ConnectionsProbeCaller,
  ConnectionsGetMatchPatternsCaller,
  ConnectionsSetMatchPatternsCaller,
  ConnectionsEngagementHealthCaller,
  ConnectionsReprobeEngagementCapabilitiesCaller,
  ConnectionsMailListCaller,
  ConnectionsStartVendorOAuthCaller,
  ConnectionsTakeVendorOAuthResultCaller,
} from './settings/connections-enroll-panel.js';
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
  LocalToolsContractsCaller,
  LocalToolsListCaller,
  LocalToolsSetCaller,
  LocalToolsUniverseCaller,
} from './settings/local-tools-panel.js';
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
import {
  createReceptionPageShell,
  type ReceptionPageShell,
} from './settings/reception-page-shell.js';
import type {
  ReceptionStatusInput,
} from './settings/reception.js';
import type { WebclientLocalStore } from './storage/local-store.js';
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
/** The `●` account control in the top bar (§D.L1) — deep-links to
 *  Settings ▸ Account. */
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
 * Wiring: `New chat`/`Chats` → `#chat` (the chat home is the empty-hash default
 * landing, §D.L1 Step 5), `Create` is an ACTION seat that opens the shared
 * Create overlay (the same 4-kind capture as the L1 composer button — it
 * absorbed the retired `#compose` route), `Account` → `#settings` (an Account
 * Settings subview until shell-routing deep-links it). `Packs` is its own
 * `#packs` route (D-187 §6 follow-on — installed packs + the Local tools they
 * install), promoted out of Settings. `home`/`kitchen`/`approvals` are
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
  /** Leading affordance glyph for action seats (`+ New chat`, `✎ Create`). */
  readonly glyph?: string;
  /** Whether this seat owns the active highlight for its `route`. EXACTLY one
   *  seat per route sets this, so the duplicate wirings (New chat + Chats →
   *  #chat, Settings + Account → #settings) light a single row. */
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
      { id: 'new-chat', label: 'New chat', glyph: '+', route: 'chat' },
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
      { id: 'account', label: 'Account', route: 'settings' },
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
  overflow: hidden;
  display: grid;
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
  gap: 10px;
  color: var(--fg-strong, var(--fg));
  font-size: 16px;
  font-weight: 750;
  letter-spacing: -0.025em;
  text-decoration: none;
}
[${WEBCLIENT_SHELL_TOPBAR_ATTR}] .webclient-shell-brand::before {
  content: "";
  width: 11px;
  height: 11px;
  border-radius: 4px;
  background: var(--accent);
  box-shadow: 0 0 0 5px var(--accent-weak);
}
/* The theme toggle takes the auto margin so it + the attention host both
   sit at the right edge of the topbar (toggle then attention). */
[${WEBCLIENT_SHELL_TOPBAR_ATTR}] [${THEME_TOGGLE_ATTR}] {
  margin-left: auto;
}
[${WEBCLIENT_SHELL_ATTENTION_HOST_ATTR}] {
  margin-left: 0;
}
/* Connection-status chip slot — sits just after the brand on the left.
   Empty (zero-width) until the bootstrap mounts the chip into it. */
[${WEBCLIENT_SHELL_CONNECTION_HOST_ATTR}] {
  display: inline-flex;
  align-items: center;
}
[${WEBCLIENT_SHELL_CONNECTION_HOST_ATTR}]:not(:empty) {
  margin-left: 2px;
}
/* §D.L1 — the account control, rightmost in the top bar. A small round
   icon-link, sibling to the drawer toggle / theme glyphs. */
[${WEBCLIENT_SHELL_ACCOUNT_ATTR}] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
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
  width: 28px;
  height: 28px;
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
  [${WEBCLIENT_SHELL_CONNECTION_HOST_ATTR}]:not(:empty) {
    margin-left: 0;
  }
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
  /** Topbar slot for the live connection-status chip (mounted by the
   *  bootstrap from the `connection-status` controller). */
  readonly connectionHost: HTMLElement;
  /** Topbar slot for the server-status pill (D-109) — sits next to the
   *  connection chip; the bootstrap feeds it `server_heartbeat` snapshots. */
  readonly serverPillHost: HTMLElement;
  readonly setActiveRoute: (route: WebclientRouteId) => void;
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
  // Live connection-status chip slot — sits next to the brand on the left.
  // The bootstrap mounts the chip (+ the route-independent offline banner)
  // from the `connection-status` controller into this host. Empty until
  // then so a shell built without the controller (a bespoke composition /
  // a test) renders no chip rather than a broken one.
  const connectionHost = doc.createElement('span');
  connectionHost.setAttribute(WEBCLIENT_SHELL_CONNECTION_HOST_ATTR, '');
  topbar.appendChild(connectionHost);
  // Server-status pill slot — sits next to the connection chip (both are
  // "server connection" info): chip = "can I reach it", pill = "Server · 12h".
  // Empty until the bootstrap mounts the pill + feeds it heartbeat snapshots.
  const serverPillHost = doc.createElement('span');
  serverPillHost.setAttribute(SERVER_PILL_HOST_ATTR, '');
  topbar.appendChild(serverPillHost);
  // Light / dark / system theme toggle — pinned to the right of the topbar
  // (the `margin-left: auto` topbar rule pushes it + the attention host to
  // the right). Applies the persisted theme to <html> on mount (idempotent
  // with the index.html inline boot script).
  const themeToggle = mountThemeToggle({
    host: topbar,
    document: doc,
  });
  const attentionHost = doc.createElement('div');
  attentionHost.setAttribute(WEBCLIENT_SHELL_ATTENTION_HOST_ATTR, '');
  topbar.appendChild(attentionHost);
  // §D.L1 — the account control, the topbar's rightmost slot. Modeled on
  // the (unused-in-webclient) ui-shared `renderAvatar`, but a plain nav entry:
  // it deep-links to Settings ▸ Account (where account binding / tier / the
  // dashboard link live). A user-icon glyph — the webclient pairs to a server
  // and doesn't surface a recued.com identity at the topbar.
  const accountLink = doc.createElement('a');
  accountLink.setAttribute(WEBCLIENT_SHELL_ACCOUNT_ATTR, '');
  accountLink.setAttribute('href', serializeShellRoute('settings', 'account'));
  accountLink.setAttribute('aria-label', 'Account');
  accountLink.setAttribute('title', 'Account');
  // Inline SVG user icon (inherits currentColor). innerHTML is a safe property
  // set under the node fake-DOM (no jsdom) and renders in the real browser.
  accountLink.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
  topbar.appendChild(accountLink);
  shellRoot.appendChild(topbar);

  // ── Body: just the content mount (the drawer overlays it off-canvas) ──
  const body = doc.createElement('div');
  body.className = 'webclient-shell-body';
  const contentRoot = doc.createElement('main');
  contentRoot.setAttribute(WEBCLIENT_SHELL_CONTENT_ATTR, '');
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

  // Track the highlight-owning seats only — a seat with `highlight: true` is
  // the single row lit for its route (so the interim duplicate wirings light
  // one row, not two).
  const highlightLinks: Array<{ route: WebclientRouteId; link: HTMLElement }> =
    [];

  // ── Open / close state (declared before the render loop so each seat's
  //    close-on-navigate handler can close it) ─────────────────────────
  let drawerOpen = false;
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
    if (open) {
      // Move focus into the menu (its first seat) so keyboard + screen-reader
      // users land inside the freshly-opened drawer.
      focusShellElement(highlightLinks[0]?.link ?? closeBtn);
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
        // an action seat also carries `route: null`. The overlay portals over
        // everything (z-index above the drawer), so close the drawer WITHOUT
        // yanking focus (the overlay claims focus on open + restores it itself).
        const button = doc.createElement('button');
        button.setAttribute('type', 'button');
        button.setAttribute(WEBCLIENT_SHELL_DRAWER_ACTION_ATTR, item.id);
        button.addEventListener('click', () => {
          opts.onCreateSeat?.();
          setDrawerOpen(false, { returnFocus: false });
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
      // can share a route (New chat/Chats → #chat, Settings/Account →
      // #settings) and must stay individually addressable.
      link.setAttribute(WEBCLIENT_SHELL_DRAWER_LINK_ATTR, item.id);
      link.setAttribute('href', serializeShellRoute(item.route));
      // Close on navigate — the route swap happens via the href. Return focus
      // to the ☰ trigger: the seat we'd otherwise leave focus on goes
      // visibility:hidden with the closing drawer (dropping focus to <body>),
      // and the route mount doesn't claim focus, so the toggle is the stable
      // landing a keyboard user continues tabbing from.
      link.addEventListener('click', () =>
        setDrawerOpen(false, { returnFocus: true }),
      );
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
      if (item.highlight === true) {
        highlightLinks.push({ route: item.route, link });
      }
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
    if ((event as KeyboardEvent).key === 'Escape') {
      setDrawerOpen(false, { returnFocus: true });
    }
  };
  docEvents.addEventListener?.('keydown', onDocKeydown);

  const setActiveRoute = (route: WebclientRouteId): void => {
    for (const item of highlightLinks) {
      if (item.route === route) {
        item.link.setAttribute('aria-current', 'page');
        item.link.setAttribute(WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR, '');
      } else {
        item.link.removeAttribute('aria-current');
        item.link.removeAttribute(WEBCLIENT_SHELL_DRAWER_ACTIVE_ATTR);
      }
    }
  };
  setActiveRoute(opts.activeRoute);

  return {
    root: shellRoot,
    contentRoot,
    attentionHost,
    connectionHost,
    serverPillHost,
    setActiveRoute,
    dispose: () => {
      docEvents.removeEventListener?.('keydown', onDocKeydown);
      themeToggle.dispose();
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
  /** D-145 PA11 — when set to `true` (the default), the Settings route
   *  mounts the Work Entities panel (per-kind Source registry: enable /
   *  disable, MCP exposure, per-kind default Source). Calls
   *  `work_entity.source.{list,set_enabled,set_mcp_exposed,set_default,
   *  clear_default}` on the standard pair-WS channel (local UI only —
   *  `work_entity.*` is an owner surface a door can never reach). Tests
   *  opt out by passing `false` when they do not exercise the panel. */
  enableWorkEntitiesPanel?: boolean;
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
   *  ON), the bootstrap mounts the topbar connection-status chip + the
   *  route-independent offline banner, both driven by the `connection-status`
   *  controller. Tests that assert exact topbar / root DOM opt out with
   *  `false` (same discipline as `enableNotifyToasts`). */
  enableConnectionIndicator?: boolean;
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
   *  the cli.reachability callers are wired. D-187 §6 — these feed the top-level
   *  `#packs` route's Local tools section: the per-tool contract × risk
   *  reachability grid. Reads `cli.reachability.universe` + `cli.reachability.list`
   *  + `collection.contract.listContracts` and writes `cli.reachability.set` per
   *  cell. The `cli.reachability.` family is reserved from MCP (owner-only), so
   *  the webclient's bearer auth path is sufficient. Tests opt out by passing
   *  `false`. */
  enableLocalToolsPanel?: boolean;
  /** D-174/D-175 — when not explicitly `false` (the default is ON), the
   *  Settings -> Account section mounts the recued.com binding touchpoint.
   *  It reads `account.bindingStatus` + `pro_convenience.status`, relays
   *  Worker-minted binding tokens through `account.bind`, and unbinds via
   *  `account.unbind`. Tests opt out by passing `false`. */
  enableAccountBindingPanel?: boolean;
  /** Optional auth Worker base URL for binding-token minting. Defaults from
   *  the current host (`auth.recued.com`, staging -> `auth.recued2.com`). */
  accountBindingAuthWorkerUrl?: string;
  /** Optional dashboard URL for account/billing links. Defaults from the
   *  current host (`dashboard.recued.com`, staging -> `dashboard.recued2.com`). */
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
  /** Tear down every constructed surface in reverse order (DD#6).
   *  Idempotent. */
  dispose(): Promise<void>;
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

/** Compose the webclient PWA. Returns a handle whose `dispose()` tears
 *  down every constructed surface in reverse order. Throws
 *  `WebclientUnpairedError` synchronously (as a rejected promise) when
 *  the local store has no pair state. */
export const bootstrapWebclient = async (
  options: BootstrapWebclientOptions,
): Promise<WebclientHandle> => {
  // 1. Hydrate pair state — the rest of the pipeline depends on this.
  const pair = await hydratePairState(options.localStore);
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
    onCreateSeat: () => createSeatHandler?.(),
  });

  // Live connection indicator — the topbar chip + the route-independent
  // offline banner, both driven by the `connection-status` controller.
  // Mounted at the shell's connection slot + at `options.root` (the
  // banner survives route swaps, like the notify toasts). Default ON;
  // `enableConnectionIndicator: false` opts out (tests that assert exact
  // topbar / root DOM without the chrome). See `shell/connection-indicator.ts`.
  let connectionIndicator: ConnectionIndicatorMount | null = null;
  if (options.enableConnectionIndicator !== false) {
    // Inject the chip + banner styles once into <head> (marker-guarded so a
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
    connectionIndicator = mountConnectionIndicator({
      chipHost: appShell.connectionHost,
      bannerHost: options.root,
      document: doc,
      status: connectionStatus.status,
      onStatus: connectionStatus.onStatus,
    });
    // D-109 server-status pill — grouped with the connection chip. Same
    // style-inject discipline (marker-guarded). Hides while not connected
    // (B1: the chip owns the down-signal); fed snapshots in the demux above.
    if (
      doc.head !== undefined
      && doc.head.querySelector(`style[${SERVER_PILL_STYLES_MARKER}]`) === null
    ) {
      const pillStyle = doc.createElement('style');
      pillStyle.setAttribute(SERVER_PILL_STYLES_MARKER, '');
      pillStyle.textContent = SERVER_PILL_STYLES;
      doc.head.appendChild(pillStyle);
    }
    serverPill = mountWebclientServerPill({
      host: appShell.serverPillHost,
      status: connectionStatus.status,
      onStatus: connectionStatus.onStatus,
      // D-188 — the master pause control. Owner-only `server.setPaused` rides
      // the bearer-gated WS (never MCP-bridged); reachable while paused since
      // it never routes through the op-admission gate.
      runSetPaused: (active: boolean) =>
        rpcConn.call('server.setPaused', { active }),
      // D-188 — restart control (drain + supervisor handoff). The popover gates
      // the button on a respawning supervisor_mode from the heartbeat, so an
      // un-supervised server never shows it; it doubles as the crash-halt
      // recovery action.
      runRequestRestart: () =>
        rpcConn.call('server.requestRestart', { reason: 'webclient' }),
    });
  }

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
          const url = `${base}${separator}token=${encodeURIComponent(bearer)}`;
          const WsCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
          if (WsCtor === undefined) {
            throw new Error('download: globalThis.WebSocket unavailable');
          }
          const ws = new WsCtor(url, WEBCLIENT_WS_SUBPROTOCOL);
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
          const url = `${base}${separator}token=${encodeURIComponent(bearer)}`;
          const WsCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
          if (WsCtor === undefined) {
            throw new Error('archive-upload: globalThis.WebSocket unavailable');
          }
          const ws = new WsCtor(url, WEBCLIENT_WS_SUBPROTOCOL);
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
  const recipeExecuteCaller: RecipeExecuteCaller = (args) => {
    const executeArgs: {
      recipe_id: string;
      config?: Record<string, unknown>;
      context?: Record<string, unknown>;
      trigger_source: string;
    } = {
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
    return rpcConn.call('execute', executeArgs);
  };

  // ⛔ D-210 A.2 (slice 3b) — the `reception.manage.mint` caller lived here, with
  // a `receptionHttpBaseFromWsUrl` helper that built the link's origin from the
  // paired server's own ws URL (a WS rpc has no request Host, and the server's
  // getShareBaseUrl throws on a private/LAN host — so the link worked on LAN and
  // DDNS alike, which was the whole point of the on-the-go surface).
  //
  // Both went with the "Copy reschedule link" button they fed. The rpc now names
  // a BOOKING, and a booking has no detail surface in the webclient yet (the
  // collection explorer serves mail/calendar/files/webhook; the work-entity page
  // is a list + a dialog). Re-add ALL THREE together — a caller with no button
  // is dead code, and a button with no target is a 404.

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
    rpcConn.call('work_entity.upsert', args);
  const dataWorkEntityDeleteCaller: DataWorkEntityDeleteCaller = (args) =>
    rpcConn.call('work_entity.delete', args);
  const dataContactListCaller: DataContactListCaller = (args) =>
    rpcConn.call('contact.list', args);
  const dataContactGetCaller: DataContactGetCaller = (args) =>
    rpcConn.call('contact.get', args);
  // D-205 merge-review item 3 — what every OTHER source says about each field. The
  // projection keeps one value; this is the rest of the evidence behind it.
  const dataContactContributionsCaller: DataContactContributionsCaller = (args) =>
    rpcConn.call('contact.contributions', args);
  const dataContactUpsertCaller: DataContactUpsertCaller = (args) =>
    rpcConn.call('contact.upsert', args);
  const dataContactDeleteCaller: DataContactDeleteCaller = (args) =>
    rpcConn.call('contact.delete', args);
  // D-205 #2b — `#data/contact/scan`. These four rpcs shipped with D-138 and
  // have had NO caller until now; `contact.merge.*` is in the MCP reserved-prefix
  // set, so a merge decision is user-authoritative by construction and this is
  // the only surface that can author one.
  const dataContactMergeListCaller: DataContactMergeListCaller = (args) =>
    rpcConn.call('contact.merge.list', args);
  const dataContactMergeConfirmCaller: DataContactMergeConfirmCaller = (args) =>
    rpcConn.call('contact.merge.confirm', args);
  const dataContactMergeRejectCaller: DataContactMergeRejectCaller = (args) =>
    rpcConn.call('contact.merge.reject', args);
  const dataContactMergeScanNowCaller: DataContactMergeScanNowCaller = (args) =>
    rpcConn.call('contact.merge.scan_now', args);
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
    rpcConn.call('contact.import.promote', args);
  // D-205 #5c — the manual vCard / CSV import. A BATCH `contact.upsert`, not a Source:
  // everything it writes lands at the `manual` rung, and the review shows only the
  // CONFLICTS — the adds have nothing to overwrite.
  const dataContactImportFilePreviewCaller: DataContactImportFilePreviewCaller = (args) =>
    rpcConn.call('contact.import.file_preview', args);
  const dataContactImportFileApplyCaller: DataContactImportFileApplyCaller = (args) =>
    rpcConn.call('contact.import.file_apply', args);
  const dataFormResponseListCaller: DataFormResponseListCaller = (args) =>
    rpcConn.call('form_response.list', args);
  const dataFormResponseGetCaller: DataFormResponseGetCaller = (args) =>
    rpcConn.call('form_response.get', args);
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
  // D-198 Slice 1b — the Memory lens feed read (owner-trusted whole-feed `memory.list`).
  const dataMemoryListCaller: DataMemoryListCaller = (args) =>
    rpcConn.call('memory.list', args);
  // D-198 Slice 2 — owner memory CRUD (`memory.get/create/update/delete`).
  const dataMemoryGetCaller: DataMemoryGetCaller = (args) =>
    rpcConn.call('memory.get', args);
  const dataMemoryCreateCaller: DataMemoryCreateCaller = (args) =>
    rpcConn.call('memory.create', args);
  const dataMemoryUpdateCaller: DataMemoryUpdateCaller = (args) =>
    rpcConn.call('memory.update', args);
  const dataMemoryDeleteCaller: DataMemoryDeleteCaller = (args) =>
    rpcConn.call('memory.delete', args);
  const dataMemoryImportCaller: DataMemoryImportCaller = (args) =>
    rpcConn.call('memory.import', args);
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
  // D-172 Half-A "open" — owner file-content read for the Files-tab download.
  // Owner-trusted `data.file.read` pair-RPC (bearer-gated WS = the auth), not
  // the contract/egress-gated op path.
  const dataFileReadCaller: DataFileReadCaller = (args) =>
    rpcConn.call('data.file.read', args);
  // D-172 — Data → File upload. The four control-plane callers ride the typed
  // rpc registry; the chunk BYTES ride a DEDICATED binary `/ws/upload` socket
  // the host opens via this factory (ui-shared can't reach the token store).
  const dataUploadCreateCaller: DataUploadCreateCaller = (args) =>
    rpcConn.call('upload.create', args);
  const dataUploadProbeCaller: DataUploadProbeCaller = (args) =>
    rpcConn.call('upload.probe', args);
  const dataUploadFinalizeCaller: DataUploadFinalizeCaller = (args) =>
    rpcConn.call('upload.finalize', args);
  const dataUploadDeleteCaller: DataUploadDeleteCaller = (args) =>
    rpcConn.call('upload.delete', args);
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
    const url = `${base}${separator}token=${encodeURIComponent(bearer)}`;
    const WsCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (WsCtor === undefined) {
      throw new Error('upload: globalThis.WebSocket unavailable');
    }
    const ws = new WsCtor(url, WEBCLIENT_WS_SUBPROTOCOL);
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
    rpcConn.call('execution.kill', args);
  const runsCancelCaller: RunsCancelCaller = (args) =>
    rpcConn.call('execution.cancel', args);
  const runsPromoteCaller: RunsPromoteCaller = (args) =>
    rpcConn.call('execution.promote', args);
  // D-186 Slice C — the Runs "Active passes" (session-grant) live-control seam.
  const runsGrantsListCaller: RunsSessionGrantListCaller = (args) =>
    rpcConn.call('collection.contract.session_grant.list', args);
  const runsGrantsRevokeCaller: RunsSessionGrantRevokeCaller = (args) =>
    rpcConn.call('collection.contract.session_grant.revoke', args);

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
      : (args) => rpcConn.call('approval.resolve', args);
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
      : (args) => rpcConn.call('notification.submitAnswer', args);
  // R20 (Option A) — resolve a chat plan from #approvals / the bell popover.
  // approve → chat.plan.approve, reject → chat.plan.cancel (wire verb
  // unchanged; only the label is "Reject"). Branched so each call carries a
  // concrete method type.
  const chatPlanResolveCaller =
    options.enableApprovalsRoute === false
      ? undefined
      : (args: { plan_id: string; decision: 'approve' | 'reject' }) =>
          args.decision === 'approve'
            ? rpcConn.call('chat.plan.approve', { plan_id: args.plan_id })
            : rpcConn.call('chat.plan.cancel', { plan_id: args.plan_id });

  // R20 (Option A) — live chat-plan aggregator. Route-independent chrome-level
  // state: it subscribes to chat.plan_proposed/resolved on the per-pair bus and
  // holds the session's pending plans so BOTH the #approvals route and the bell
  // popover can surface them (the chat route keeps its own in-context cards).
  // Created once here so it survives hash route swaps; disposed on teardown.
  const pendingChatPlansStore: PendingChatPlansStore | null =
    options.enableApprovalsRoute === false
      ? null
      : createPendingChatPlansStore({ subscribe: subscriber.on });

  // D-174 / R6 - global approval attention popover. This is
  // route-independent chrome mounted at the webclient root, so it
  // survives hash route swaps and reuses the exact approval.* plus
  // notification.pending_asks callers as the #approvals deep queue.
  const approvalAttentionPopover: ApprovalAttentionPopoverMount | null =
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
        })
      : null;

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
            rpcConn.call(
              'collection.mail.enrollImap',
              args as RpcRequest<ServerRpcRegistry, 'collection.mail.enrollImap'>,
            ),
          enrollOAuth: (args) =>
            rpcConn.call(
              'collection.mail.enrollOAuth',
              args as RpcRequest<ServerRpcRegistry, 'collection.mail.enrollOAuth'>,
            ),
          delete: (args) => rpcConn.call('collection.mail.delete', args),
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
          delete: (args) => rpcConn.call('collection.calendar.delete', args),
          resync: (args) => rpcConn.call('collection.calendar.resync', args),
          reauth: (args) => rpcConn.call('collection.calendar.reauth', args),
          enrollOAuth: (args) =>
            rpcConn.call(
              'collection.calendar.enrollOAuth',
              args as RpcRequest<ServerRpcRegistry, 'collection.calendar.enrollOAuth'>,
            ),
          enrollBasic: (args) =>
            rpcConn.call(
              'collection.calendar.enrollBasic',
              args as RpcRequest<ServerRpcRegistry, 'collection.calendar.enrollBasic'>,
            ),
        };
  const connectionsFileLane: FileLaneCallers | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : {
          list: () => rpcConn.call('collection.listInstances', { type: 'file' }),
          enroll: (args) =>
            rpcConn.call(
              'collection.file.enroll',
              args as RpcRequest<ServerRpcRegistry, 'collection.file.enroll'>,
            ),
          delete: (args) => rpcConn.call('collection.file.delete', args),
          resync: (args) => rpcConn.call('collection.file.resync', args),
          reauth: (args) => rpcConn.call('collection.file.reauth', args),
        };

  // D-165 P3.enroll-host — Connections ENROLLMENT section callers. Default ON;
  // tests opt out via `enableConnectionsEnrollPanel: false`. All five wired
  // together (the settings route gates the section on ALL of them). The list
  // caller is UNFILTERED (every kind, unlike the grant panel's api-only list).
  // Per-pair-only by `collection.connection.` being reserved from MCP; the
  // webclient bearer auth path is sufficient. A pre-enroll server surfaces the
  // rpc unknown-method error inside the page's inline error, not a route crash.
  const connectionsEnrollListCaller: ConnectionsEnrollListCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : () => rpcConn.call('collection.connection.list', undefined);
  const connectionsEnrollCaller: ConnectionsEnrollCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.enroll', args);
  const connectionsUpdateCaller: ConnectionsUpdateCaller | undefined =
    options.enableConnectionsEnrollPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.connection.update', args);
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
  const grantRegistryDescribeCaller: GrantRegistryDescribeCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : () => rpcConn.call('housekeeping.registry.describe', undefined);
  const grantSetDoorTypesCaller: GrantSetDoorTypesCaller | undefined =
    options.enableContractsPanel === false
      ? undefined
      : (args) => rpcConn.call('collection.contract.setDoorTypes', args);
  // D-182 §7.2 (increment 4) — Settings → Local tools reachability grid. The
  // universe/list reads + the per-cell set write are all under the MCP-reserved
  // `cli.reachability.` prefix (owner-only). The grid also reads the contract
  // list for its rows — a dedicated caller (not the `enableContractsPanel`-gated
  // one) so the grid mounts even when #contracts is disabled. A pre-increment-4
  // server surfaces the rpc unknown-method error inside the panel's error chip.
  const localToolsUniverseCaller: LocalToolsUniverseCaller | undefined =
    options.enableLocalToolsPanel === false
      ? undefined
      : () => rpcConn.call('cli.reachability.universe', undefined);
  const localToolsListCaller: LocalToolsListCaller | undefined =
    options.enableLocalToolsPanel === false
      ? undefined
      : () => rpcConn.call('cli.reachability.list', undefined);
  const localToolsSetCaller: LocalToolsSetCaller | undefined =
    options.enableLocalToolsPanel === false
      ? undefined
      : (args) => rpcConn.call('cli.reachability.set', args);
  const localToolsContractsCaller: LocalToolsContractsCaller | undefined =
    options.enableLocalToolsPanel === false
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

  // D-145 PA11 — Settings → Work Entities panel callers. All five run on
  // the standard pair-WS channel (`work_entity.source.*` is an OWNER
  // surface — a WS rpc, deliberately unreachable from MCP). Forwarded as
  // one all-or-nothing group: the panel has no read-only mode, so a
  // partial wiring would paint dead toggles (see the route's gate).
  //
  // `set_mcp_exposed` is why this group exists at all. PA11 shipped the
  // renderer + rpc + store and nothing ever called it, so the per-Source
  // `mcp_exposed` flag (boots `false`) had no shipped way to be flipped —
  // leaving `work.search` / `work.read` returning zero rows to every
  // external MCP door, permanently.
  const workEntitiesEnabled = options.enableWorkEntitiesPanel !== false;
  const workEntitiesPanelSourceListCaller:
    | WorkEntitiesPanelSourceListCaller
    | undefined = !workEntitiesEnabled
      ? undefined
      : () => rpcConn.call('work_entity.source.list', undefined);
  const workEntitiesPanelSetEnabledCaller:
    | WorkEntitiesPanelSetEnabledCaller
    | undefined = !workEntitiesEnabled
      ? undefined
      : (args) => rpcConn.call('work_entity.source.set_enabled', args);
  const workEntitiesPanelSetMcpExposedCaller:
    | WorkEntitiesPanelSetMcpExposedCaller
    | undefined = !workEntitiesEnabled
      ? undefined
      : (args) => rpcConn.call('work_entity.source.set_mcp_exposed', args);
  const workEntitiesPanelSetDefaultCaller:
    | WorkEntitiesPanelSetDefaultCaller
    | undefined = !workEntitiesEnabled
      ? undefined
      : (args) => rpcConn.call('work_entity.source.set_default', args);
  const workEntitiesPanelClearDefaultCaller:
    | WorkEntitiesPanelClearDefaultCaller
    | undefined = !workEntitiesEnabled
      ? undefined
      : (args) => rpcConn.call('work_entity.source.clear_default', args);

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
  // recued.com card can surface "Signed in as …" + a Sign out action; the read
  // is a single GET to the auth Worker on panel open that returns
  // `{authenticated:false}` for self-hosters with no account (no error chip).
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
  const accountBindingTokenMintCaller:
    | AccountBindingTokenMintCaller
    | undefined =
    accountBindingAuthClient === null
      ? undefined
      : () => accountBindingAuthClient.mintBindingToken();
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
  ): {
    update?: () => void;
    dispose: () => void;
    /** Leave-guard seam — a route with unsaved work returns true and the
     *  hash listener asks before tearing it down. Absent = never guarded. */
    hasUnsavedChanges?: () => boolean;
  } => {
    if (route === 'contracts') {
      activeSettingsRoute = null;
      const contractsSubview = deepLinkSegment('contracts');
      const contractsListTabCandidate = contractsSubview === 'view'
        ? deepLinkSegment('contracts', 1)
        : undefined;
      const contractsListTab = isContractsListTab(contractsListTabCandidate)
        ? contractsListTabCandidate
        : undefined;
      return bootstrapContractsRoute({
        root: appShell.contentRoot,
        serverUrl: pair.serverUrl,
        ...(options.document !== undefined ? { document: options.document } : {}),
        ...(permissionsListOverridesCaller !== undefined
          && permissionsDeleteOverrideCaller !== undefined
          && permissionsUpsertOverrideCaller !== undefined
          && permissionsListCatalogOperationsCaller !== undefined
          ? {
              permissionsListOverridesCaller,
              permissionsDeleteOverrideCaller,
              permissionsUpsertOverrideCaller,
              permissionsListCatalogOperationsCaller,
            }
          : {}),
        ...(permissionsListInboundTokensCaller !== undefined
          && permissionsIssueInboundTokenCaller !== undefined
          && permissionsRevokeInboundTokenCaller !== undefined
          ? {
              permissionsListInboundTokensCaller,
              permissionsIssueInboundTokenCaller,
              permissionsRevokeInboundTokenCaller,
            }
          : {}),
        ...(permissionsUpdateInboundTokenCaller !== undefined
          ? { permissionsUpdateInboundTokenCaller }
          : {}),
        ...(permissionsToolCatalogCaller !== undefined
          ? { permissionsToolCatalogCaller }
          : {}),
        ...(permissionsMintContractCaller !== undefined
          && permissionsRevokeContractCaller !== undefined
          && permissionsListContractsCaller !== undefined
          && permissionsUpdateInboundContractCaller !== undefined
          ? {
              permissionsMintContractCaller,
              permissionsRevokeContractCaller,
              permissionsListContractsCaller,
              permissionsUpdateInboundContractCaller,
            }
          : {}),
        ...(contractsListCaller !== undefined
          && contractsRevokeCaller !== undefined
          ? {
              contractsListCaller,
              contractsRevokeCaller,
            }
          : {}),
        ...(grantReadCaller !== undefined
          && grantReadByEntryCaller !== undefined
          && grantWriteCaller !== undefined
          ? {
              grantReadCaller,
              grantReadByEntryCaller,
              grantWriteCaller,
              ...(grantListContractsCaller !== undefined
                ? { grantListContractsCaller }
                : {}),
              ...(grantCatalogOperationsCaller !== undefined
                ? { grantCatalogOperationsCaller }
                : {}),
              ...(grantRegistryDescribeCaller !== undefined
                ? { grantRegistryDescribeCaller }
                : {}),
              ...(grantSetDoorTypesCaller !== undefined
                ? { grantSetDoorTypesCaller }
                : {}),
              // GAP-B fix — route CLI ops in the Ops grant panel to
              // cli_reachability (their real authority), reusing the same
              // `cli.reachability.{list,set}` callers the Local-tools grid uses.
              ...(localToolsListCaller !== undefined
                ? { grantCliReachabilityListCaller: localToolsListCaller }
                : {}),
              ...(localToolsSetCaller !== undefined
                ? { grantCliReachabilitySetCaller: localToolsSetCaller }
                : {}),
            }
          : {}),
        ...(suggestionsListCaller !== undefined
          && suggestionsAcceptCaller !== undefined
          && suggestionsDismissCaller !== undefined
          ? {
              suggestionsListCaller,
              suggestionsAcceptCaller,
              suggestionsDismissCaller,
            }
          : {}),
        ...(scopedSuggestionsListCaller !== undefined
          && scopedSuggestionsAcceptCaller !== undefined
          && scopedSuggestionsDismissCaller !== undefined
          ? {
              scopedSuggestionsListCaller,
              scopedSuggestionsAcceptCaller,
              scopedSuggestionsDismissCaller,
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
      });
    }
    if (route === 'connections') {
      activeSettingsRoute = null;
      return bootstrapConnectionsRoute({
        root: appShell.contentRoot,
        ...(options.document !== undefined ? { document: options.document } : {}),
        // Deep link — segment 0 = the lane tab (mail/calendar/file/others),
        // segment 1 = a foundational account to open in detail, OR the
        // `enroll` verb with segment 2 = a vendor to pre-open the Others
        // enroll form for (`#connections/others/enroll/<vendor>` — the packs
        // "Set up" CTA).
        ...(deepLinkSegment('connections') !== undefined
          ? { initialTab: deepLinkSegment('connections') }
          : {}),
        ...(deepLinkSegment('connections', 1) !== undefined
          ? { initialDetailSlug: deepLinkSegment('connections', 1) }
          : {}),
        ...(deepLinkSegment('connections', 1) === 'enroll'
          && deepLinkSegment('connections', 2) !== undefined
          ? { initialEnrollVendor: deepLinkSegment('connections', 2) }
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
        // Others — the generic connection.* REACH enroll panel.
        ...(connectionsEnrollListCaller !== undefined
          && connectionsEnrollCaller !== undefined
          && connectionsUpdateCaller !== undefined
          && connectionsDeleteCaller !== undefined
          && connectionsProbeCaller !== undefined
          ? {
              connectionsEnrollListCaller,
              connectionsEnrollCaller,
              connectionsUpdateCaller,
              connectionsDeleteCaller,
              connectionsProbeCaller,
              connectionsGetMatchPatternsCaller,
              connectionsSetMatchPatternsCaller,
              ...(connectionsPreviewPurgeCaller !== undefined
                ? { connectionsPreviewPurgeCaller }
                : {}),
            }
          : {}),
        ...(connectionsEngagementHealthCaller !== undefined
          ? { connectionsEngagementHealthCaller }
          : {}),
        ...(connectionsReprobeEngagementCapabilitiesCaller !== undefined
          ? { connectionsReprobeEngagementCapabilitiesCaller }
          : {}),
        // Fork 1 B — reuse the packs.list caller so the enroll dialog can
        // pre-fill the editable vendor-scope field from installed packs' needs.
        ...(packsListCaller !== undefined
          ? { connectionsPacksListCaller: packsListCaller }
          : {}),
        ...(connectionsMailListCaller !== undefined
          ? { connectionsMailListCaller }
          : {}),
        ...(connectionsStartVendorOAuthCaller !== undefined
          && connectionsTakeVendorOAuthResultCaller !== undefined
          ? {
              connectionsStartVendorOAuthCaller,
              connectionsTakeVendorOAuthResultCaller,
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
              webhooksCreateCaller,
              webhooksCredentialWriteCaller,
              webhooksCredentialRetireCaller,
              webhooksManualConfirmCaller,
              webhooksRegistrationReconcileCaller,
              webhooksEnableCaller,
              webhooksDisableCaller,
              webhooksTestDeliveryCaller,
              webhooksDeliveryListCaller,
              webhooksDeliveryGetCaller,
              webhooksDeliveryEventGetCaller,
              webhooksRejectedDeliveryListCaller,
              webhooksRetireCaller,
              webhooksRetentionPruneCaller,
            }
          : {}),
        subscribe: subscriber.on,
      });
    }
    if (route === 'packs') {
      activeSettingsRoute = null;
      // The unified `#packs` surface — one list → detail (the [Installed |
      // Discover] tab split is retired). `bootstrapPacksRoute` now composes the
      // browse list (discover panel over the catalog ∪ roster union) → the
      // `#packs/<slug>` detail (the packs panel in detail-only mode, resolving a
      // marketplace pack whose manifest isn't bundled) internally. This branch
      // just forwards the same packs.* + cli.reachability + grant callers.
      return bootstrapPacksRoute({
        root: appShell.contentRoot,
        ...(options.document !== undefined ? { document: options.document } : {}),
        ...(packsListCaller !== undefined ? { packsListCaller } : {}),
        ...(packsInstallCaller !== undefined ? { packsInstallCaller } : {}),
        ...(packsUninstallCaller !== undefined ? { packsUninstallCaller } : {}),
        ...(packsResolveCaller !== undefined ? { packsResolveCaller } : {}),
        ...(packsInstallBySlugCaller !== undefined ? { packsInstallBySlugCaller } : {}),
        ...(sellerOverviewCaller !== undefined ? { sellerOverviewCaller } : {}),
        ...(supervisionListCaller !== undefined ? { supervisionListCaller } : {}),
        ...(supervisionSetCaller !== undefined ? { supervisionSetCaller } : {}),
        ...(localToolsUniverseCaller !== undefined
          && localToolsListCaller !== undefined
          && localToolsSetCaller !== undefined
          ? {
              localToolsUniverseCaller,
              localToolsListCaller,
              localToolsSetCaller,
              ...(localToolsContractsCaller !== undefined
                ? { localToolsContractsCaller }
                : {}),
            }
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
          ? { contractGrantWriteCaller: grantWriteCaller }
          : {}),
        ...(grantCatalogOperationsCaller !== undefined
          ? { catalogOperationsCaller: grantCatalogOperationsCaller }
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
      });
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
      // Wrap the run-library route in the [Installed | Discover] tab shell. The
      // route mounts UNCHANGED into the Installed pane; the Discover pane
      // browses the marketplace recipe catalog (lazy-loaded on first open).
      const mountInstalled = (host: HTMLElement) =>
        bootstrapRecipesRoute({
          root: host,
          ...(options.document !== undefined ? { document: options.document } : {}),
          recipesListCaller,
          recipeExecuteCaller,
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
          // R24 — pack install/uninstall moved to the dedicated #packs route
          // (the recipes route keeps only the by-pack FILTER, off depends_on).
          // Schedule callers light up the shared Run | Schedule modal's
          // Schedule tab (quick-schedule from a recipe's detail); the list
          // callers feed the automation status line. Trigger management lives
          // at #automation; bundled recipes also get a quick auto-run toggle.
          schedulesListCaller: automationSchedulesListCaller,
          schedulesCreateCaller: (args) => rpcConn.call('schedules.create', args),
          schedulesUpdateCaller: automationSchedulesUpdateCaller,
          schedulesDeleteCaller: automationSchedulesDeleteCaller,
          triggersListCaller: automationTriggersListCaller,
          autoRunListCaller: automationAutoRunListCaller,
          autoRunUpdateCaller: automationAutoRunUpdateCaller,
          // D-179 — the recipe detail's install-config editor (default-dish
          // overlay applied as a base to every dishless run).
          recipeConfigGetCaller: (args) => rpcConn.call('recipe_config.get', args),
          recipeConfigSetCaller: (args) => rpcConn.call('recipe_config.set', args),
          fileRefSearchCaller,
          // D-200 — the same paired-client owner read used by Data Files backs
          // exact artifact preview/download in recipe results. The result host
          // rechecks ref/hash/MIME/name/size before it opens returned bytes.
          fileReadCaller: (args) => rpcConn.call('data.file.read', args),
          // D-195 optional workflow install: these lightweight public
          // projections prove the directly named BulkPackManifest carries all
          // current recipe_bundle members. Failure only hides the CTA.
          recipeCatalogCaller: () => fetchRecipeCatalog(),
          packCatalogCaller: () => fetchPackCatalog(),
          // Tool exposure is per-(recipe × contract) and lives in #contracts —
          // the recipes detail carries no per-recipe exposure toggle (a single
          // global toggle can't express "exposed via contract A but not B").
          ...(hashSource !== null && initialRecipeId !== undefined
            ? { initialRecipeId }
            : {}),
          subscribe: subscriber.on,
        });
      let recipeDiscover: ReturnType<typeof mountRecipeDiscovery> | null = null;
      return mountDiscoverySurface({
        root: appShell.contentRoot,
        ...(options.document !== undefined ? { document: options.document } : {}),
        mountInstalled,
        mountDiscover: (host) => {
          recipeDiscover = mountRecipeDiscovery({
            host,
            ...(options.document !== undefined ? { document: options.document } : {}),
            installBySlug: recipeInstallBySlugCaller,
            listInstalled: recipesListCaller,
            // Deps box — resolve the recipe's depends_on against the pack roster
            // and co-install missing packs in the consent dialog. Both gate on
            // the packs feature (absent ⇒ one-click install).
            ...(packsListCaller !== undefined ? { listPacks: packsListCaller } : {}),
            ...(packsInstallBySlugCaller !== undefined ? { installPack: packsInstallBySlugCaller } : {}),
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
        // "Parse the version regularly" — re-download the catalog each time the
        // user returns to Discover so upgrade badges reflect fresh upstream
        // versions (conditional 304s keep the re-check cheap).
        onReactivate: (tab) => {
          if (tab === 'discover') void recipeDiscover?.panel.refresh();
        },
      });
    }
    if (route === 'data') {
      activeSettingsRoute = null;
      return bootstrapDataRoute({
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
        recipeListCaller: recipesListCaller,
        recipeExecuteCaller,
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
        uploadCreateCaller: dataUploadCreateCaller,
        uploadProbeCaller: dataUploadProbeCaller,
        uploadFinalizeCaller: dataUploadFinalizeCaller,
        uploadDeleteCaller: dataUploadDeleteCaller,
        uploadConnectFactory,
        fileReadCaller: dataFileReadCaller,
        // R18 — `#data/<tab>/<entity_id>` deep link (R16): hydrate the tab +
        // open the addressed entity's timeline detail.
        ...(deepLinkSegment('data') !== undefined
          ? { initialTab: deepLinkSegment('data') }
          : {}),
        ...(deepLinkSegment('data', 1) !== undefined
          ? { initialEntityId: deepLinkSegment('data', 1) }
          : {}),
        subscribe: subscriber.on,
      });
    }
    if (route === 'automation') {
      activeSettingsRoute = null;
      return bootstrapAutomationRoute({
        root: appShell.contentRoot,
        ...(options.document !== undefined ? { document: options.document } : {}),
        schedulesListCaller: automationSchedulesListCaller,
        schedulesUpdateCaller: automationSchedulesUpdateCaller,
        schedulesDeleteCaller: automationSchedulesDeleteCaller,
        triggersListCaller: automationTriggersListCaller,
        triggersUpdateCaller: automationTriggersUpdateCaller,
        triggersDeleteCaller: automationTriggersDeleteCaller,
        autoRunListCaller: automationAutoRunListCaller,
        autoRunUpdateCaller: automationAutoRunUpdateCaller,
        watchListCaller: automationWatchListCaller,
        watchUpdateCaller: automationWatchUpdateCaller,
        watchRunNowCaller: automationWatchRunNowCaller,
        recipeNamesCaller,
        authStateCaller: automationAuthStateCaller,
        // R21 create path — Add → recipe picker → the shared run-modal on
        // the Schedule|Trigger tab.
        recipeEntriesCaller: () => rpcConn.call('recipe.list', undefined),
        schedulesCreateCaller: (args) => rpcConn.call('schedules.create', args),
        triggersCreateCaller: (args) => rpcConn.call('triggers.create', args),
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
      });
    }
    if (route === 'logs') {
      activeSettingsRoute = null;
      // R17 — `#logs/active` mounts the full operator console; `#logs/<run_id>`
      // deep-links a run's detail; bare `#logs` is the default History view.
      // R24 follow-on — `#logs/recipe/<recipe_id>` opens History pre-scoped to a
      // recipe's runs (the recipe detail's "View runs in Logs" link).
      const logsSegment = deepLinkSegment('logs');
      const logsRecipeId = deepLinkSegment('logs', 1);
      return bootstrapLogsRoute({
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
            : logsSegment !== undefined
              ? { initialRunId: logsSegment }
              : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
        subscribe: subscriber.on,
      });
    }
    if (route === 'chat') {
      activeSettingsRoute = null;
      // The live-control "running" bubble was lifted out of the chat header into
      // route-independent shell chrome (`liveControlBubble`, mounted above), so
      // the chat route no longer wires the `execution.*` callers.
      return bootstrapChatRoute({
        root: appShell.contentRoot,
        conn: rpcConn.call as ChatRouteConn,
        ...(options.document !== undefined ? { document: options.document } : {}),
        subscribe: subscriber.on,
        // Shell-frame Step 4 — the [✎ Create] composer overlay reuses the
        // compose route's local-write callers.
        contactUpsertCaller: dataContactUpsertCaller,
        workEntityUpsertCaller: dataWorkEntityUpsertCaller,
        // Shell-frame Step 4c — the [▶ Run a recipe] palette: the same
        // recipe.list / execute / schedules.* / auto_run.* callers the
        // Recipes + Automation routes already use.
        recipeListCaller: recipesListCaller,
        recipeExecuteCaller,
        schedulesListCaller: automationSchedulesListCaller,
        schedulesCreateCaller: (args) => rpcConn.call('schedules.create', args),
        schedulesUpdateCaller: automationSchedulesUpdateCaller,
        schedulesDeleteCaller: automationSchedulesDeleteCaller,
        autoRunListCaller: automationAutoRunListCaller,
        autoRunUpdateCaller: automationAutoRunUpdateCaller,
      });
    }
    if (route === 'settings') {
      const sellerRouteMode = deepLinkSegment('settings', 2);
      const settings = bootstrapSettingsRoute({
        root: appShell.contentRoot,
        localStore: options.localStore,
        // D-196 1d — the same generic runner the Recipes route uses; the Seller
        // page's order actions launch recipes through it rather than each one
        // needing its own `server.seller.*` method.
        recipeExecuteCaller,
        ...(options.document !== undefined ? { document: options.document } : {}),
        ...(hashSource !== null
          ? {
              initialSectionId: deepLinkSegment('settings'),
              initialSellerSubpage: deepLinkSegment('settings', 1),
              initialSellerItemId: sellerRouteMode === 'detail'
                ? deepLinkSegment('settings', 3)
                : undefined,
              initialSellerPage: sellerRouteMode === 'page'
                ? deepLinkSegment('settings', 3)
                : undefined,
            }
          : {}),
        ...(options.cryptoKeysWiper !== undefined
          ? { cryptoKeysWiper: options.cryptoKeysWiper }
          : {}),
        ...(options.onPrivacyClear !== undefined
          ? { onCleared: options.onPrivacyClear }
          : {}),
        ...(tlsRenewCaller !== undefined ? { tlsRenewCaller } : {}),
        // R26.2 Delta 1 — the Exposure grid mounts only when all four callers
        // are present (the route's `canMountExposure` gate). `runHasDdns` is
        // independently optional.
        ...(exposureGetCaller !== undefined
          && exposureApplyPresetCaller !== undefined
          && exposureSetPathResolutionCaller !== undefined
          && exposureSetPublicMcpAckCaller !== undefined
          ? {
              exposureGetCaller,
              exposureApplyPresetCaller,
              exposureSetPathResolutionCaller,
              exposureSetPublicMcpAckCaller,
            }
          : {}),
        ...(exposureSetApexCaller !== undefined
          ? { exposureSetApexCaller }
          : {}),
        ...(exposureHasDdnsCaller !== undefined
          ? { exposureHasDdnsCaller }
          : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.onTlsRenewed !== undefined
          ? { onTlsRenewed: options.onTlsRenewed }
          : {}),
        ...(keyHealthLoader !== undefined && keyRotateCaller !== undefined
          ? { keyHealthLoader, keyRotateCaller }
          : {}),
        ...(certPinWatcher !== null ? { certPinWatcher } : {}),
        ...(pairListCaller !== undefined && pairRevokeCaller !== undefined
          ? { pairListCaller, pairRevokeCaller }
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
              notificationsSetChannelCaller,
              // D-169 P1 — per-bridge sub-row callers. Always paired
              // with the channel-level callers (same gate); the
              // notifications panel renders the sub-row group only
              // when both bridge callers are present.
              ...(notificationsDescribeBridgesCaller !== undefined
                && notificationsSetBridgeModeCaller !== undefined
                ? {
                    notificationsDescribeBridgesCaller,
                    notificationsSetBridgeModeCaller,
                  }
                : {}),
              // R31 — the verification-phrase caller (panel-level).
              ...(notificationsSetVerificationPhraseCaller !== undefined
                ? { notificationsSetVerificationPhraseCaller }
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
          ? { aiModelsDefaultModelPrefSetCaller }
          : {}),
        ...(aiModelsGetLLMConfigCaller !== undefined
          ? { aiModelsGetLLMConfigCaller }
          : {}),
        ...(aiModelsSetLLMSlotCaller !== undefined
          ? { aiModelsSetLLMSlotCaller }
          : {}),
        ...(aiModelsSetEmbeddingsSlotCaller !== undefined
          ? { aiModelsSetEmbeddingsSlotCaller }
          : {}),
        ...(aiModelsUpsertFreePoolEntryCaller !== undefined
          ? { aiModelsUpsertFreePoolEntryCaller }
          : {}),
        ...(aiModelsRemoveFreePoolEntryCaller !== undefined
          ? { aiModelsRemoveFreePoolEntryCaller }
          : {}),
        ...(aiModelsSetFreePoolEntryEnabledCaller !== undefined
          ? { aiModelsSetFreePoolEntryEnabledCaller }
          : {}),
        ...(aiModelsSetChatCatalogModeCaller !== undefined
          ? { aiModelsSetChatCatalogModeCaller }
          : {}),
        ...(aiModelsGetLlmPromptsCaller !== undefined
          ? { aiModelsGetLlmPromptsCaller }
          : {}),
        ...(aiModelsSetLlmPromptCaller !== undefined
          ? { aiModelsSetLlmPromptCaller }
          : {}),
        ...(aiModelsGetConfigSchemaCaller !== undefined
          ? { aiModelsGetConfigSchemaCaller }
          : {}),
        ...(aiModelsSetConfigFieldCaller !== undefined
          ? { aiModelsSetConfigFieldCaller }
          : {}),
        ...(aiModelsHousekeepingConfigReadCaller !== undefined
          ? { aiModelsHousekeepingConfigReadCaller }
          : {}),
        ...(aiModelsHousekeepingConfigWriteCaller !== undefined
          ? { aiModelsHousekeepingConfigWriteCaller }
          : {}),
        ...(sellerOverviewCaller !== undefined ? { sellerOverviewCaller } : {}),
        ...(sellerOrdersCaller !== undefined ? { sellerOrdersCaller } : {}),
        ...(sellerOfferStateTransitionCaller !== undefined
          ? { sellerOfferStateTransitionCaller }
          : {}),
        ...(sellerMailListCaller !== undefined ? { sellerMailListCaller } : {}),
        ...(sellerSettingsUpdateCaller !== undefined
          ? { sellerSettingsUpdateCaller }
          : {}),
        ...(sellerManualTierUpsertCaller !== undefined
          ? { sellerManualTierUpsertCaller }
          : {}),
        ...(sellerCreatePassTierCaller !== undefined
          ? { sellerCreatePassTierCaller }
          : {}),
        ...(sellerManualCustomerIssueCaller !== undefined
          ? { sellerManualCustomerIssueCaller }
          : {}),
        ...(sellerManualCustomerExtendCaller !== undefined
          ? { sellerManualCustomerExtendCaller }
          : {}),
        ...(sellerManualCustomerSwapTierCaller !== undefined
          ? { sellerManualCustomerSwapTierCaller }
          : {}),
        ...(sellerManualCustomerCloseCaller !== undefined
          ? { sellerManualCustomerCloseCaller }
          : {}),
        ...(sellerManualCustomerReissueTokenCaller !== undefined
          ? { sellerManualCustomerReissueTokenCaller }
          : {}),
        ...(sellerManualTierBulkAdjustCaller !== undefined
          ? { sellerManualTierBulkAdjustCaller }
          : {}),
        ...(sellerStripeSynchronizeCaller !== undefined
          ? { sellerStripeSynchronizeCaller }
          : {}),
        ...(sellerAcknowledgeLlmGatewayPaidCaller !== undefined
          ? { sellerAcknowledgeLlmGatewayPaidCaller }
          : {}),
        ...(updateCheckCaller !== undefined
          ? {
              updateCheckCaller,
              updatesStartPoll,
              ...(updateModeGetCaller !== undefined ? { updateModeGetCaller } : {}),
              ...(updateModeSetCaller !== undefined ? { updateModeSetCaller } : {}),
              ...(updateApplyCaller !== undefined ? { updateApplyCaller } : {}),
              ...(updateRollbackCaller !== undefined ? { updateRollbackCaller } : {}),
            }
          : {}),
        ...(housekeepingCacheStatsCaller !== undefined
          ? { housekeepingCacheStatsCaller }
          : {}),
        ...(housekeepingCacheClearCaller !== undefined
          ? { housekeepingCacheClearCaller }
          : {}),
        ...(transparencyPrefsGetCaller !== undefined
          && transparencyPrefsSetCaller !== undefined
          ? { transparencyPrefsGetCaller, transparencyPrefsSetCaller }
          : {}),
        ...(housekeepingPanelConfigReadCaller !== undefined
          ? { housekeepingPanelConfigReadCaller }
          : {}),
        ...(housekeepingPanelConfigWriteCaller !== undefined
          ? { housekeepingPanelConfigWriteCaller }
          : {}),
        ...(housekeepingPanelStatusReadCaller !== undefined
          ? { housekeepingPanelStatusReadCaller }
          : {}),
        ...(housekeepingPanelRunNowCaller !== undefined
          ? { housekeepingPanelRunNowCaller }
          : {}),
        ...(housekeepingPanelTrustReadCaller !== undefined
          ? { housekeepingPanelTrustReadCaller }
          : {}),
        ...(housekeepingPanelTrustWriteCaller !== undefined
          ? { housekeepingPanelTrustWriteCaller }
          : {}),
        ...(housekeepingPanelDismissPromotionCaller !== undefined
          ? { housekeepingPanelDismissPromotionCaller }
          : {}),
        ...(housekeepingPanelRegistryDescribeCaller !== undefined
          ? { housekeepingPanelRegistryDescribeCaller }
          : {}),
        ...(housekeepingPanelTopicResetCaller !== undefined
          ? { housekeepingPanelTopicResetCaller }
          : {}),
        // D-145 PA11 — all-or-nothing (the panel has no read-only mode).
        ...(workEntitiesPanelSourceListCaller !== undefined
          && workEntitiesPanelSetEnabledCaller !== undefined
          && workEntitiesPanelSetMcpExposedCaller !== undefined
          && workEntitiesPanelSetDefaultCaller !== undefined
          && workEntitiesPanelClearDefaultCaller !== undefined
          ? {
              workEntitiesPanelSourceListCaller,
              workEntitiesPanelSetEnabledCaller,
              workEntitiesPanelSetMcpExposedCaller,
              workEntitiesPanelSetDefaultCaller,
              workEntitiesPanelClearDefaultCaller,
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
              hostnamesAddCaller,
              hostnamesUpdateCaller,
              hostnamesRemoveCaller,
              hostnamesVerifyOwnershipCaller,
            }
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
        ddnsSetEnabledCaller,
        ...(options.enableReachabilityDoctor === true
          && (options.reachabilityReport !== undefined
            || reachabilityExternalProbeCaller !== undefined)
          ? {
              ...(options.reachabilityReport !== undefined
                ? { reachabilityReport: options.reachabilityReport }
                : {}),
              ...(reachabilityExternalProbeCaller !== undefined
                ? { reachabilityExternalProbeCaller }
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
              accountBindCaller,
              accountUnbindCaller,
              accountProConvenienceStatusCaller,
              accountBindingTokenMintCaller,
              accountDashboardUrl,
              ...(accountBindingSessionCaller !== undefined
                ? { accountBindingSessionCaller }
                : {}),
              ...(accountSignOutCaller !== undefined
                ? { accountSignOutCaller }
                : {}),
            }
          : {}),
        // R26.4 M1 — the consolidated Backup & Recovery surface: the three
        // archive callers are the spine; the passport-export caller rides
        // alongside as the optional standalone "Export identity passport only"
        // action.
        ...(archiveExportCaller !== undefined
          && archiveStatusCaller !== undefined
          && archiveImportCaller !== undefined
          ? {
              archiveExportCaller,
              archiveStatusCaller,
              archiveImportCaller,
              ...(passportExportCaller !== undefined
                ? { passportExportCaller }
                : {}),
              ...(archiveDownload !== undefined ? { archiveDownload } : {}),
              ...(archiveUpload !== undefined ? { archiveUpload } : {}),
              ...(archiveRebindStash !== undefined
                ? { archiveRebindStash }
                : {}),
            }
          : {}),
        // D-187 §6 follow-on — Local tools reachability callers no longer flow
        // to Settings. They are forwarded to the top-level `#packs` route
        // branch (alongside the packs.* callers the install→cli-grant-dialog
        // flow binds them to).
        // D-145 PA11 follow-on — broadcast-subscriber seam, shared
        // across every Settings panel that wants a live refresh
        // (cache card's `housekeeping_cycle` filter, etc.).
        // Forwarded unconditionally; each consumer's own gate decides
        // whether to subscribe (e.g. cache card needs stats wired).
        subscribe: subscriber.on,
      });
      activeSettingsRoute = settings;
      return settings;
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
      return bootstrapApprovalsRoute({
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
        : serializeShellRoute(
            'kitchen',
            'new',
            'form-response',
            kitchenRecipeSeed.form_definition_id,
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
      if (kitchenRecipeSeed !== null) {
        editor = mountFormResponseRecipeSeedRoute({
          root: kitchenChrome.contentRoot,
          formDefinitionId: kitchenRecipeSeed.form_definition_id,
          listCaller: recipesListCaller,
          validateCaller: (args) => rpcConn.call('recipe.validate', args),
          saveCaller: (args) => rpcConn.call('recipe.save', args),
          onSaved: syncSavedRecipeRoute,
          ...(options.document !== undefined ? { document: options.document } : {}),
        });
      } else if (kitchenRecipeId !== null) {
        editor = mountRecipeEditorRoute({
          root: kitchenChrome.contentRoot,
          recipeId: kitchenRecipeId,
          listCaller: recipesListCaller,
          validateCaller: (args) => rpcConn.call('recipe.validate', args),
          saveCaller: (args) => rpcConn.call('recipe.save', args),
          webhookIngressListCaller: () => rpcConn.call('webhook.ingress.list', undefined),
          webhookStatusCaller: (args) => rpcConn.call('recipe.webhook.status', args),
          webhookArmCaller: (args) => rpcConn.call('recipe.webhook.arm', args),
          webhookDisarmCaller: (args) => rpcConn.call('recipe.webhook.disarm', args),
          onSaved: syncSavedRecipeRoute,
          ...(options.document !== undefined ? { document: options.document } : {}),
        });
      }
      if (editor !== null) {
        const mountedEditor = editor;
        return {
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
        };
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
      const builder = bootstrapIngredientBuilderRoute({
        root: kitchenChrome.contentRoot,
        conn: rpcConn.call as IngredientBuilderConn,
        ...(packDraftId !== null ? { initialDraftId: packDraftId } : {}),
        onDraftChange: syncPackHash,
        ...(options.document !== undefined ? { document: options.document } : {}),
      });
      return {
        // See the recipe path — chrome teardown in `finally` so it can't leak.
        dispose: () => {
          try {
            builder.dispose();
          } finally {
            kitchenChrome.dispose();
          }
        },
        hasUnsavedChanges: () => builder.hasUnsavedChanges(),
      };
    }
    activeSettingsRoute = null;
    return bootstrapReceptionRoute({
      root: appShell.contentRoot,
      shell: receptionShell,
      conn: rpcConn.call,
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
    });
  };

  let activeHash = hashSource?.getHash() ?? serializeShellRoute(activeRoute);
  let mountedRouteHandle: {
    update?: () => void;
    dispose: () => void;
    hasUnsavedChanges?: () => boolean;
  } = mountRoute(activeRoute);

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
        const next = resolveRoute(hash);
        const remountForDeepLink =
          next === activeRoute
          && shouldRemountForSameRoute(next, activeHash, hash);
        if (next === activeRoute && !remountForDeepLink) return;
        // Leave guard — a route with unsaved work (Kitchen editors) gets a
        // chance to keep the user. Declining restores the URL by SETTING the
        // hash (a new entry) — replaceState would DESTROY the history entry a
        // Back/Forward decline traversed to, decaying the back stack entry by
        // entry. The resulting hashchange re-dispatch no-ops here (same
        // route, same hash). Environments without confirm (tests) proceed.
        if (mountedRouteHandle.hasUnsavedChanges?.() === true) {
          const view = doc?.defaultView;
          const proceed =
            typeof view?.confirm === 'function'
              ? view.confirm('Discard unsaved changes?')
              : true;
          if (!proceed) {
            if (view?.location !== undefined) {
              view.location.hash = activeHash;
            } else if (view?.history?.replaceState !== undefined) {
              view.history.replaceState(null, '', activeHash);
            }
            return;
          }
        }
        mountedRouteHandle.dispose();
        activeRoute = next;
        activeHash = hash;
        appShell.setActiveRoute(next);
        mountedRouteHandle = mountRoute(next);
      })
    : (): void => undefined;

  // Tab-close twin of the leave guard: while the mounted route holds unsaved
  // work, closing/reloading the tab asks first. One shell-level listener over
  // the current route handle (routes never register their own).
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (mountedRouteHandle.hasUnsavedChanges?.() === true) {
      event.preventDefault();
      // Chrome requires a set returnValue for the native prompt.
      event.returnValue = '';
    }
  };
  const beforeUnloadView = doc?.defaultView;
  if (typeof beforeUnloadView?.addEventListener === 'function') {
    beforeUnloadView.addEventListener('beforeunload', onBeforeUnload);
  }

  let disposed = false;
  return {
    activeRoute: () => activeRoute,
    receptionShell: () => receptionShell,
    conn: () => rpcConn.call,
    settingsRoute: () => activeSettingsRoute,
    certPinStateWatcher: () => certPinWatcher,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
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
      // Detach the reconnect-driven `events.subscribe` re-fire BEFORE
      // `ws.disconnect()` so the dispose-fired `'closed'` transition
      // can't re-enter a torn-down rpcConn.
      detachResubscribe();
      detachHash();
      if (typeof beforeUnloadView?.removeEventListener === 'function') {
        beforeUnloadView.removeEventListener('beforeunload', onBeforeUnload);
      }
      mountedRouteHandle.dispose();
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
      // (the chip mounts into `appShell.connectionHost`; the banner into
      // `options.root`).
      if (connectionIndicator !== null) {
        connectionIndicator.dispose();
      }
      // Same — the server-status pill mounts into `appShell.serverPillHost`.
      if (serverPill !== null) {
        serverPill.dispose();
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
