import { randomBytes } from 'node:crypto';
import { createSavedDataViewStore } from '../saved-data-view-store.js';
import { createSavedTaskViewReader } from '../saved-data-view-task-reader.js';
import { createSavedRecordsViewReader } from '../saved-data-view-records-reader.js';
import { createSavedDataViewAlertRuntime } from '../saved-data-view-alert-runtime.js';
import { createFormDefinitionReader } from '../form-contract-gate.js';
import { join, dirname } from 'node:path';

import { createCertChainHolder, DEFAULT_PUBLIC_PORT } from '@recued/server-tls';
import { createCliBinaryReachabilityProbe } from '../cli-binary-reachability.js';
import { createSqliteHandleStateStore } from '../handle/sqlite-store.js';
import { composeWebhookAndHookListeners } from '../composition/bin/wire-webhook-and-hook-listeners.js';
import { composeVendorWebhookPort } from '../composition/bin/wire-vendor-webhook-port.js';
import { composeInboundAnswerDispatcher } from '../composition/bin/wire-inbound-answer-dispatcher.js';
import { createPreapprovalTelegramIngress } from '../preapproval-telegram-ingress.js';
import { composePreapproval } from '../composition/bin/wire-preapproval.js';
import { composeInboundEmailAnswer } from '../composition/bin/wire-inbound-email-answer.js';
import { materializeMailBody } from '../mail-body-read-handler.js';
import { composeMessengerTurnIngest } from '../composition/bin/wire-messenger-turn.js';
import { composeMessengerLiveControl } from '../composition/bin/wire-messenger-live-control.js';
import { getMessengerNotificationRefresher } from '../composition/bin/wire-messenger-refresher.js';
import { composeSessionGrantPasses } from '../composition/bin/wire-session-grant-passes.js';
import { composeReceptionInboxDeps } from '../composition/bin/wire-reception-inbox-deps.js';
import { countCalendarOverlap } from '../collections/calendar/overlap-counter.js';
import { createInMemoryAskLandingNonceStore } from '../ask-landing-nonce-store.js';
import { createAskLandingDetailResolver } from '../ask-landing-held-op-details.js';
import { createAskCardDetailResolver } from '../ask-card-held-op-details.js';
import { resolveArgEditSchema } from '../preflight-arg-schema-resolver.js';
import { buildResolverDeps } from '../composition/bin/wire-reception-inbox-deps.js';
import { createAskLandingEditApproval } from '../ask-landing-edit-approval.js';
import {
  findReceptionHoldItem,
  handleReceptionInboxApprove,
} from '../reception-inbox-handler.js';
import {
  buildPacksSurfaceLink,
  buildUpdatesSurfaceLink,
  resolvePublicBaseUrl,
} from '../ask-landing-answer-link.js';
import { createWebhookProfileListener } from '../webhook-profile-listener.js';
import { createWebhookProfileRuntimeRegistry } from '../webhook-profile-runtime.js';
import {
  createBuiltinWebhookDeliveryProfileAdapters,
} from '../webhook-delivery-profile-presets.js';
import { BUILTIN_WEBHOOK_PROFILE_POLICIES } from '../webhook-profile-policy.js';
import {
  createWebhookClockHealthAuthority,
  resolveWebhookClockAuthorityUrl,
} from '../webhook-clock-health.js';
import { createWebhookTestDeliveryService } from '../webhook-test-delivery.js';
import { createWebhookManagedRegistrationService } from '../webhook-registration-reconciler.js';
import {
  createBuiltinWebhookRegistrationProfileRegistry,
} from '../webhook-registration-profile-presets.js';
import { createWebhookOutboxRuntime } from '../webhook-outbox-dispatcher.js';
import { createWebhookRecipeOutboxSink } from '../webhook-recipe-consumer.js';
import {
  createOperationBoundWebhookFixtureAdapters,
  createWebhookCallbackBindingRuntimeRegistry,
  createWebhookOperationBindingResolver,
} from '../webhook-operation-binding.js';
import {
  createExecuteWebhookRecipeRunner,
  reconcileWebhookAwaitingApprovalDispatches,
} from '../webhook-recipe-runner.js';
import {
  composeDoorRecipeResolver,
  composeInstallConfigResolver,
  composeRecipeOpResolver,
} from '../recipe-capability-wiring.js';
import type { WebhookDoorEnrollDeps } from '../webhook-door-enroll.js';
import { assertRecordsNonOwnerRecipeExposure } from '../records/non-owner-exposure.js';
import { readRootProjections, readRootProjectionsBatch } from '../records/root-projection.js';
import type { TimelineRollup } from '@recued/contracts';
import type { ContactRpcDeps } from '../contact-handler.js';
import { createReceptionInboxSubviewStore } from '../storage/reception-inbox-subview-store.js';
import { createContractGrantEntryStore } from '../storage/contract-grant-entry-store.js';
import { liveVendorRegistry } from '../connection-convention-families.js';
import { createReceptionCalendarEventSeam } from '../ports/reception/projection/reception-calendar-event.js';
import { createReceptionBookingMintSeam } from '../ports/reception/projection/reception-booking-mint.js';
import {
  deriveFormSubmissionPiiKeyFromSubDek,
  openFormSubmissionField,
} from '../ports/reception/form-pii.js';
import { deriveReceptionPepperFromSubDek } from '../ports/reception/server-secret-pepper.js';
import { createReceptionAttachFileSeam } from '../ports/reception/projection/reception-attach-file.js';
import { composeTelegramCallbackAck } from '../composition/bin/wire-telegram-callback-ack.js';
import { createMessengerIngressStateStore } from '../storage/messenger-ingress-state-store.js';
import {
  createMessengerIngressSupervisor,
  type MessengerIngressSupervisor,
} from '../messenger-ingress/supervisor.js';
import {
  createProductionPathListenerCoordinator,
  type ProductionPathListenerCoordinator,
} from '../network/path-listener-coordinator.js';
import { resolveLanAddress } from '../network/resolve-lan-address.js';
import { readDefaultRouteGateway } from '../network/read-default-route-gateway.js';
import { createPortMappingStore } from '../network/port-mapping-store.js';
import {
  composePortMappingDesire,
  createPortMappingSupervisor,
  type PortMappingSupervisor,
} from '../network/port-mapping-supervisor.js';
import { detectPortMappingSupport } from '../network/port-mapping-support.js';
import {
  createIgdDescriptionFetch,
  createIgdHttpPost,
  createSsdpTransport,
  resolvePortMappingActuator,
} from '../network/port-mapping-actuator.js';
import {
  createServerHandlerSet,
  type ServerConfig,
  type ServerHandlerSet,
} from '../server.js';
import {
  loadWebclientBundleFromDisk,
  resolveServedWebclientBundleDir,
  WebclientBundleLoadError,
} from '../webclient-bundle-loader.js';
import type { SystemStatusDeps } from '../system-status-handler.js';
import {
  listRecipeRunnability,
  listRecipesWorsenedByPackUninstall,
  makeRecipeRunnabilityBroadcaster,
  type RecipeRunnabilityHandlerDeps,
} from '../recipe-runnability-handler.js';
import {
  buildPackOpResolution,
  missingPackDependencies,
  privateByoDropIds,
} from '../pack-inventory.js';
import type { ContractBroadcastEvent } from '../contract-handler.js';
import type { HistoryDeps } from '../history-handler.js';
import type { WsServerHandle } from '../ws-server.js';
import type { BridgeDispatcher } from '../bridges/dispatcher.js';
import { createBridgeRegistry } from '../bridges/registry.js';
import type { BootedServerIdentity } from '../identity/boot.js';
import {
  createVendorOAuthFlowStore,
  createVendorOAuthResultStore,
} from '../connection-vendor-oauth-flow.js';
import { createWorkEntityResolver } from '../work-entity-resolver.js';
import {
  buildLoadFileCollectionRecord,
  createFileViewResolverFromRegistry,
} from '../file-view-resolver.js';
import { createPreviewConnectionExecute } from '../ingredient-authoring/preview-execute.js';
import type { IngredientDraftRpcDeps } from '../ingredient-authoring/draft-preview-rpc.js';
import { supervisorWillRespawn as supervisorRespawns } from '@recued/contracts';
import type { Lifecycle } from '../lifecycle/index.js';
import type { ArchiveRpcDeps } from '../archive/archive-handler.js';
import { createHostnameSniBindingLookup } from '../hostname/index.js';
import type { CollectionContext } from './compose-collection-context.js';
import type { ExecutionContext } from './compose-execution-context.js';
import type { AppContext } from './compose-app-context.js';
import type { NotificationMessage } from '@recued/notification';
import { composeEventTriggers } from '../composition/bin/wire-event-triggers.js';
import { composeWatchManager } from '../composition/bin/wire-watch-manager.js';
import {
  getDefaultWatchSourceRegistry,
  messengerSourceKey,
} from '../watch/source-registry.js';
import { emitAutomationRule } from '../events/emit-sites.js';
import type { EventTriggerDispatcher } from '../triggers/dispatcher.js';
import type { PollManagerHandle } from '../watch/poll-manager.js';
import {
  RpcError,
  catalogSlugForVendor,
  unionRequiredScopesForConnection,
  verifyWebclientBundle,
  type ConnectionDataPurgeSummary,
  type IngredientManifest,
  type ReceptionInboxScanStatus,
  type WatchSourceStatusEntry,
  type WebclientBundleFile,
  webhookProfile,
  webhookProfileRequiresPairedConnection,
  getMessengerVendorDeclaration,
  listMessengerVendors,
  GENERATED_PACK_PUBLISHER,
  type FormFieldContractFormView,
} from '@recued/contracts';
// D-225 Slice 2 — the generated-pack install closure handed to connectionDeps.
import { handlePacksInstall } from '../pack-install-handler.js';
import { handlePacksUninstall } from '../pack-uninstall-handler.js';
import { reconcileInstalledPacksOnBoot } from '../pack-reconciliation.js';
import {
  checkInstalledManifestsOnBoot,
  notifyUnrunnablePacks,
} from '../ingredient-authoring/installed-manifest-boot-check.js';
import { projectUnrunnableFindingsToPacks } from '../unrunnable-pack-notice.js';
import {
  decodeAuthFromStorage,
  firstMintGeneratedPack,
  handleConnectionDelete,
} from '../connection-handler.js';
// D-225 auto-mint — the loopback diff's exposed-tool-set resolver.
import { exposedToolNamesForPeerContract } from '../peer-exposed-tools.js';
// D-228 slice 3 — the tool_overrides -> pack-op classification migration.
import { carryMcpToolClassifications } from '../mcp-classification-carryover.js';
import {
  createChatConnectionMcpStore,
  ensureChatConnectionMcpAnnotationSchema,
} from '../storage/chat-connection-mcp-store.js';
import type { McpPackFirstMintDeps } from '../housekeeping/tasks/mcp-pack-first-mint.js';
import { removePackOwnerRulings } from '../pack-inventory.js';
import { mcpConnectionForPackSlug } from '@recued/ingredient-authoring';
import { executeLLM } from '@recued/llm';
import {
  CONNECTION_SETUP_GUIDE_MANIFEST,
  CONNECTION_SETUP_GUIDE_TIMEOUT_MS,
} from '../connection-setup-guide.js';
import { parseIntakeFormConfig } from '../ports/reception/transformations/intake-form.js';
import {
  purgeConnectionData as runPurgeConnectionData,
  previewConnectionPurgeCount as runPreviewConnectionPurgeCount,
} from '../source-mirror/connection-purge.js';
import { listInstalledPackManifests } from '../pack-list-handler.js';
import type { InitialAcmeDomainIssuer } from '../keys/rotation/acme-domain-renewer.js';
import { buildApplyOrchestratorDeps, buildReleaseCheckDeps, buildUpdateModeDeps } from '../update/release-config.js';
import { buildUpdateReleaseEntry, updateAutoApplyRegistry } from '../update/auto-apply-registry.js';
import { runUpdateBootReconcile as runUpdateBootReconcileImpl } from '../update/boot-reconcile.js';
import { createUpdateOwnerAlertSink } from '../update/owner-alert.js';
import { SERVER_VERSION } from '../server-version.js';
import type { RpcContext } from './compose-rpc-context.js';
import type { StorageContext } from './compose-storage-context.js';

type CollectionDeps = NonNullable<ServerConfig['collectionDeps']>;

export interface ListenerServerFacade {
  wsServer: ServerHandlerSet['wsHandle'];
  port: number;
  close(): Promise<void>;
}

export interface ComposeListenersResult {
  serverHandlerSet: ServerHandlerSet;
  listenerCoordinator: ProductionPathListenerCoordinator;
  /** What the LAN listener BINDS (`0.0.0.0` for a detected LAN address).
   *  Feeds the exposure machine's `bind_addresses.lan`. Not an address to
   *  publish — see `lanAdvertisedAddress`. */
  lanBindAddress: string;
  /** Where the server is REACHABLE on the LAN — the detected interface IP,
   *  or loopback when none resolved. Feeds the pairing address hints
   *  (`wss://<addr>:<port>/ws`), which `0.0.0.0` would make meaningless. */
  lanAdvertisedAddress: string;
  /** True iff a verified webclient bundle loaded at boot, so `/webclient/*`
   *  (and the LAN bare-`/` redirect) actually serve. The boot banner uses it
   *  to decide whether to advertise the local webclient URL. */
  webclientServed: boolean;
  server: ListenerServerFacade;
  /** Reactive-substrate slice 1 — live event-trigger dispatcher
   *  (undefined on dbless boots). The post-listener runtime registers
   *  its stop closure with the background-services registry. */
  eventTriggerDispatcher: EventTriggerDispatcher | undefined;
  /** Poll-manager / G6 — live watch manager (undefined on dbless
   *  boots). Same lifecycle posture as the dispatcher: the
   *  post-listener runtime registers its stop closure; maintenance
   *  exit recomputes via the late-bound getter. */
  watchManager: PollManagerHandle | undefined;
  /** Local-first Slack/Telegram/Discord ingress. Starts after the shared
   * inbound dispatcher is composed and stops with the listener lifecycle. */
  messengerIngressSupervisor?: MessengerIngressSupervisor;
  /** D-178 slice 4b — on-boot update reconcile (commit / auto-revert +
   *  ledger→audit replay). Undefined on a delegated channel / dbless boot.
   *  The post-housekeeping tail invokes it AFTER markBooted so a healthy
   *  boot of a staged release commits. Best-effort (never throws). */
  runUpdateBootReconcile: (() => Promise<void>) | undefined;
  /** D-225 auto-mint — deps for the `mcp-pack-first-mint` housekeeping sweep,
   *  bound to the composition-capable generated-pack seam. Handed to the
   *  post-listener runtime, which registers the task. Undefined on a boot with no
   *  connection store ⇒ the retry + backfill never runs. */
  mcpPackFirstMintDeps: McpPackFirstMintDeps | undefined;
}

export interface ComposeListenersOptions {
  port: number;
  webhookPort: number;
  storage: Pick<
    StorageContext,
    | 'pairing'
    | 'serverInstanceId'
    | 'pairedInstances'
    | 'recoveryKeyCheck'
    // Slice 3b — keyfile ServerKeyStore getter for /auth/pair server-vault
    // enrollment (read live; the signing identity boots lazily).
    | 'signingIdentity'
    | 'auditLog'
    | 'preapprovalStorage'
    // D-175 P5 — account-binding manager backs the `account.*` pair-RPC.
    | 'accountBindingManager'
    // D-175 P8 — Pro convenience provisioner backs `pro_convenience.status`.
    | 'proConvenienceProvisioner'
    // R27 delta-B — DDNS pause/resume handler deps back `ddns.*`.
    | 'ddnsHandlerDeps'
    | 'fileStack'
    | 'workEntityStoreRef'
    | 'formResponseStoreRef'
    | 'recordsStore'
    | 's2sPreviewStoreRef'
    // D-170 — local manifest body store + recipe store back the
    // `ingredient.install` / `ingredient.uninstall` rpc (provisioning +
    // pin-guard). N.4 / N.15 — `draftStore` backs the draft rpc + preview.
    | 'localManifestStore'
    | 'draftStore'
    | 'recipeStore'
    | 'hostnameRegistryStore'
    | 'serverTimeZoneStore'
    | 'notificationKindPolicyStore'
    | 'quietHoursStore'
    // D-173 INT-3 — Reception Inbox boot-wiring. `db` backs the SQLite
    // subview store (D10); `checkpointStore` is the held-state + N.5 narrow
    // writer; `eventBus` carries the `reception_inbox` broadcast.
    | 'db'
    | 'checkpointStore'
    | 'eventBus'
    // D-210 step 2a / A.8 slice 4c — the record read surface
    // (`reception.record.list`) reads ONE table now: bookings and intakes are
    // both `reception_form_submission` rows, so the booking-store ref that used
    // to sit beside this is gone.
    | 'intakeFormSubmissionStoreRef'
    // D-210 slice 3 — the endpoint registry, read by the booking-mint seam for
    // the endpoint's owner-authored `display_name` (the booking's title; the
    // visitor-derived alternatives all carry their name / free text).
    | 'publicEndpointRegistryStoreRef'
    | 'receptionRateLimiterRef'
    | 'ipBlockStoreRef'
  >;
  app: Pick<
    AppContext,
    | 'authDeps'
    | 'llmManager'
    | 'resolveLlmConfig'
    | 'llmQuota'
    | 'llmAdapterRegistry'
    | 'llmEmbeddingsAdapterRegistry'
    | 'llmTranscriptionAdapterRegistry'
    | 'emptyTabProbe'
    | 'cacheDeps'
    // D-250 — the daily batch reads a recipe-defined board's pending result from here.
    // ⚠ The store is built in `compose-app-context`; this hop was the only one missing,
    // which is why an eval board could be granted locally and never submitted.
    | 'sharedStoreRef'
    // D-172 — the CAS root; the messenger media scratch dir is derived as a
    // data-volume sibling so large downloads stream to disk, not tmpfs.
    | 'cacheBlobs'
    // D-198 Slice 2 — the owner-authored `user_memory` store backs the
    // `memory.create/get/update/delete` write half of the Memory lens.
    | 'userMemoryStore'
    // D-198 Slice 4 — the redaction-marker store backs `memory.delete`'s
    // non-`user_self` "forget" path (overlay, never mutates the audit log).
    | 'memoryRedactionStore'
    | 'sharedDeps'
    | 'annotationDeps'
    | 'annotationStoreRef'
    | 'enrichmentStoreRef'
    | 'crmRecordMirrorStoreRef'
    // D-192 Fork B — the remote-file meta-store feeds the `data.mirror.search`
    // files picker (CAS collection + vendor mirror, one resolver).
    | 'fileMetaStoreRef'
    // D-192 remote byte-fetch — the file-source connection resolver, so the
    // `data.file.read` path can authenticate a lazy vendor byte fetch.
    | 'fileSourceConnResolverRef'
    // D-192 remote byte-fetch — the shared `remote` bundle builder for the
    // `data.file.read` pair-RPC (the same one the recipe/ai/mail channels use).
    | 'getRemoteFileReadDeps'
    | 'fileSourceSyncStateRef'
    // D-205 #2c — per-Source CONTACT sync health, for `contact.source.list` (the
    // Sources strip on `#data/contact`). The first reader of the runner's counts.
    | 'contactSourceSyncStateRef'
    // D-192 read resolution — per-Source sync cursor/health rows; the
    // work-entity CRUD rpc's freshness metadata reads them through the
    // resolver.
    | 'workEntitySourceSyncStateRef'
    | 'workEntityCrudDepsRef'
    | 'calendarWriteDepsRef'
    // D-192 P5 — work-graph edges for the CRUD rpc's `get` decoration.
    | 'workEntityEdgeStoreRef'
    // D-192 — the post-commit work-entity Source reconcile the install/uninstall
    // deps drive (enroll-before-install registration).
    | 'reconcileWorkEntitySourcesRef'
    | 'enrichmentCascadeRef'
    | 'connectionStoreRef'
    | 'contractGrantStoreRef'
    | 'connectionCatalogBindingStoreRef'
    | 'contractStoreRef'
    | 'sellerStoreRef'
    | 'sellerOrderStoreRef'
    | 'webhookIngressStoreRef'
    | 'webhookDeliveryStoreRef'
    | 'webhookConsumerStoreRef'
    | 'sellerClaimStoreRef'
    | 'receptionManageCredentialStoreRef'
    | 'chatInboundTokenStoreRef'
    | 'clientTokensRef'
    | 'contactStoreRef'
    // D-139 P5 — the engagement-evidence resolver bundle backs the
    // `data.contact.engagements.list` pair-RPC (and the MCP read).
    | 'contactEngagementsResolveDepsRef'
    | 'chatDeps'
    | 'keys'
    // R21.1 — gates the event-trigger dispatcher + watch poll-manager on
    // vault-unlocked (drop fan-out / disarm loops while sealed).
    | 'isVaultUnlocked'
    | 'vaultStateBus'
    // Reactive-substrate slice 1 — the event-trigger dispatcher
    // subscribes enabled trigger patterns on the warehouse bus.
    | 'warehouseBus'
    // D-160 A.8 step 6 — the messenger turn wiring drives
    // `runMessengerTurn` + shares the orchestrator's session store.
    | 'chatOrchestratorRef'
    // D-188 — master pause flag closes the inbound webhook listeners.
    | 'serverState'
  >;
  collection: Pick<
    CollectionContext,
    | 'collectionRegistry'
    | 'webhookWatcherQueue'
    | 'watcherDispatcher'
    | 'calendarStack'
    | 'mailStack'
    | 'serviceStack'
    | 'supervisionStack'
    | 'channelDispatchers'
    | 'oauthClientConfigDeps'
    | 'oauthAppConfigDeps'
    // D-174 #22 — the bus + cascade-wired work-entity dispatcher instance
    // (constructed in compose-collection-context); reused by the
    // `work_entity.{upsert,delete}` pair-RPC so writes emit warehouse
    // events on the SAME path the ingredient channel uses.
    | 'workEntityDispatchers'
    // D-160 A.8 step 6 — inbound messenger media lands in the D-172
    // `received` collection (`origin: 'messenger_media'`).
    | 'inboundFileCollection'
    // D-172 resumable uploads — the webclient upload service backs the
    // `upload.*` rpc + the binary `/ws/upload` socket + the sweep task.
    | 'uploadService'
    // M4 archive download — the webclient download service backs the binary
    // `/ws/download` socket.
    | 'downloadService'
    // M4b.1 archive upload — backs `server.archive.upload.*` + the binary
    // `/ws/archive-upload` socket.
    | 'archiveUploadService'
  >;
  execution: Pick<
    ExecutionContext,
    | 'executeDeps'
    | 'notificationBlock'
    // The `/ask` landing's live batch-membership read — a single-member batch
    // may render its held op's values; a multi-member one may not.
    | 'getBatch'
    // D-210 Phase C — the decorated resumer, for the inbox's no-ask release.
    | 'preflightResumer'
    | 'messengerChannels'
    | 'executorConfig'
    | 'connectionOperationProfileStore'
    | 'reconcileConnectionProfile'
    // D-209 #1 W2b — the webhook door mint writes into the SAME contract
    // stores the Gateway reads (threaded, never rebuilt here).
    | 'contractDefinitionStore'
    | 'grantEntryStore'
  >;
  rpc: Pick<
    RpcContext,
    | 'housekeepingRpcDeps'
    | 'upstreamMergeDeps'
    | 'contactMergeDeps'
    | 'engagementHealthDeps'
    | 'notificationsDeps'
    | 'packInstallDeps'
    | 'packListDeps'
    | 'packUninstallDeps'
    | 'observabilityBundle'
    | 'recipeTrustStore'
    | 'autoRunDeps'
  >;
  runtimeConfig: ServerConfig['runtimeConfig'];
  bootstrapDeps: ServerConfig['bootstrapDeps'];
  scheduleDeps: ServerConfig['scheduleDeps'];
  dishDeps: ServerConfig['dishDeps'];
  migrateDeps: ServerConfig['migrateDeps'];
  pressureDeps: ServerConfig['pressureDeps'];
  lifecycle: Lifecycle | undefined;
  /** Scope-B (D-108/D-109) — the live `server.archive.*` runtime deps,
   *  assembled upstream where the lifecycle (restart drain) + db + version
   *  + exit coexist. Absent (db-less / no-lifecycle harness) → the rpc
   *  stays unwired (`makeArchiveHandlers(undefined).slice === undefined`). */
  archiveDeps?: ArchiveRpcDeps;
  clientTokens: ServerConfig['clientTokens'];
  exposureDeps: ServerConfig['exposureDeps'];
  tlsDomainDeps: ServerConfig['tlsDomainDeps'];
  tokenRotationEmitter:
    | NonNullable<ServerConfig['tokenRotationDeps']>['emitter']
    | undefined;
  rotationEngine:
    | NonNullable<ServerConfig['tlsRenewDeps']>['engine']
    | undefined;
  passportFetchDeps: ServerConfig['passportFetchDeps'];
  identityProbeDeps: ServerConfig['identityProbeDeps'];
  passportUserRpcDeps: ServerConfig['passportUserRpcDeps'];
  keyRotateDeps: ServerConfig['keyRotateDeps'];
  proAuthMachine:
    | NonNullable<ServerConfig['proAuthDeps']>['machine']
    | undefined;
  initialAcmeDomainIssuer?: () => InitialAcmeDomainIssuer | undefined;
  receptionRpcDeps: ServerConfig['receptionRpcDeps'];
  receptionPortDeps: ServerConfig['receptionPortDeps'];
  mcpHttpDeps: ServerConfig['mcpHttpDeps'];
  llmGatewayDeps: ServerConfig['llmGatewayDeps'];
  /** D-148 § A.12 / D-165 enroll-host #1 — booted server identity. Wires
   *  the vendor OAuth substrate: `startVendorOAuth` signs the `state`
   *  token with it and the `/oauth/complete` handler verifies the echoed
   *  state against the same key. Threaded by the pre-listener runtime
   *  (identity is booted before listeners compose; see
   *  `startBootRecoveryAndAdapters`). Absent (db-less / pre-boot harness)
   *  → the whole vendor OAuth substrate stays unwired, exactly like
   *  passport.fetch (start rpc → `not_configured`; `oauth` path role
   *  absent → path-router 404). */
  signingIdentity?: BootedServerIdentity;
  /** D-169 P0 follow-on (Codex 2026-05-28 Angle 2 fold) — publish the
   *  live bridge dispatcher to the executor's late-bound ref BEFORE
   *  the listener starts accepting scheduler dispatches. Wired by
   *  the boot site (`startPostStorageAppCollectionExecutionRuntime`)
   *  to `lateBound.publishBridgeDispatcher`; without this in-chain
   *  publish, cron + auto_run can fire a DOM step into the dom slot
   *  before the dispatcher is wired, mis-classifying the unwired
   *  state as `ROLE_RESTRICTION` "no bridge connected." */
  publishBridgeDispatcher?: (dispatcher: BridgeDispatcher | undefined) => void;
}

/** D-226 — the projection -> wire shape, in ONE place.
 *
 *  ⛔ ENUMERATING PROJECTION. It names the fields it forwards, so a field it
 *  omits reaches the client as `undefined` and the section silently never
 *  renders. That already happened once to `rollups` one layer out, which is why
 *  the per-entity reader and the batched list reader now share this rather than
 *  each keeping their own copy. */
const toWireRollup = (
  projection: ReturnType<typeof readRootProjections>[number],
): TimelineRollup => ({
  publisher: projection.publisher,
  pack_slug: projection.pack_slug,
  ...(projection.label === undefined ? {} : { label: projection.label }),
  value: projection.value,
  complete: projection.complete,
  ...(projection.incomplete_reason === undefined
    ? {}
    : { incomplete_reason: projection.incomplete_reason }),
});

/** D-226 — ⛔ ONE definition for THREE call sites. `contactDeps` was built
 *  three times in `composeListeners`; wiring the batched rollup reader into one
 *  of them would have left the other two serving a contact list with no columns
 *  and nothing failing anywhere — the shape that keeps costing us. */
const buildContactDeps = (
  contactStore: NonNullable<AppContext['contactStoreRef']>,
  recordsStore: StorageContext['recordsStore'],
): ContactRpcDeps => ({
  store: contactStore,
  // ⚠ BATCHED, and it must stay that way. Looping `readRootProjections` here
  // would read identically and reintroduce the N+1 the batch exists to kill:
  // 50 rows x 20 packs is 2,050 queries against 41.
  rollupsForKeys: (emails: readonly string[]) => {
    const out: Record<string, TimelineRollup[]> = {};
    for (const [key, projections] of readRootProjectionsBatch(recordsStore, 'contact', emails)) {
      out[key] = projections.map(toWireRollup);
    }
    return out;
  },
});

export const composeListeners = async (
  options: ComposeListenersOptions,
): Promise<ComposeListenersResult> => {
  const {
    port,
    webhookPort,
    storage,
    app,
    collection,
    execution,
    rpc,
    runtimeConfig,
    bootstrapDeps,
    scheduleDeps,
    dishDeps,
    migrateDeps,
    pressureDeps,
    lifecycle,
    archiveDeps,
    clientTokens,
    exposureDeps,
    tlsDomainDeps,
    tokenRotationEmitter,
    rotationEngine,
    passportFetchDeps,
    identityProbeDeps,
    passportUserRpcDeps,
    keyRotateDeps,
    proAuthMachine,
    initialAcmeDomainIssuer,
    receptionRpcDeps,
    receptionPortDeps,
    mcpHttpDeps,
    llmGatewayDeps,
  } = options;

  // D-259 launch gate — this is the FIRST stateful work in this composer. Repair
  // only the hash-pinned, authority-equivalent CLI migrations before any mail,
  // webhook, messenger, HTTP, or WebSocket listener/poller can accept work. The
  // validator check runs AFTER the attempt, so it reports only packs still
  // broken/held rather than warning about a body this boot just repaired.
  if (app.contractStoreRef) {
    await reconcileInstalledPacksOnBoot({
      contractStore: app.contractStoreRef,
      localManifestStore: storage.localManifestStore,
      registry: execution.executorConfig.manifests,
      now: rpc.packInstallDeps?.now ?? (() => Date.now()),
      ...(rpc.packInstallDeps?.packDir !== undefined
        ? { packDir: rpc.packInstallDeps.packDir }
        : {}),
      log: (message: string) => console.warn(message),
    });
  }
  if (typeof storage.localManifestStore.listManifests === 'function') {
    const unrunnable = checkInstalledManifestsOnBoot({
      listManifests: () => storage.localManifestStore.listManifests(),
      log: (message: string) => console.warn(message),
    });
    // ⛔ THE LOG LINE ABOVE REACHES NOBODY ON THE SERVER THIS EXISTS FOR.
    //    An unattended owner is not tailing stdout, and after the reconciler
    //    what survives to here is precisely what a machine DECLINED to fix —
    //    the set a human has to see. So it also pings, with a link.
    //
    // ⚠ Two sibling producers in this tree (`pingReceptionInbox`,
    //   `offerExecutionCase`) are marked "ready-to-wire, boot wiring
    //   DEFERRED" and nothing calls either. A third unwired ping would be
    //   the same non-delivery in a new file, so this one is wired here.
    const notifier = execution.notificationBlock;
    if (unrunnable.length > 0 && notifier !== undefined) {
      // `local_manifest` stores the DECOMPOSED catalog (`codex`), while the
      // surface the owner can update is keyed by the installed PACK
      // (`codex-pack`). Join through installed_pack.ingredient_ids before
      // naming or linking the notice. If that identity cannot be proved, the
      // list remains safe; a guessed detail URL does not.
      const notices = projectUnrunnableFindingsToPacks(
        unrunnable,
        app.contractStoreRef,
      );
      // D-259 — the deep link. `#packs/<slug>` is a real parsed webclient
      // address, so the only open question was the ORIGIN, and the server has
      // one whenever it is publicly named. Exactly one unrunnable pack has an
      // unambiguous destination (its detail page); several do not, so they get
      // the list. `buildPacksSurfaceLink` returns null on a non-public server
      // and the ping then carries no link at all — deliberately, per
      // `execute-handler.ts:3014`.
      const packsLink = buildPacksSurfaceLink(
        resolvePublicBaseUrl(process.env.RECUED_PUBLIC_BASE_URL),
      );
      const linkUrl =
        packsLink === null
          ? undefined
          : packsLink(
              notices.exact_pack_identities && notices.findings.length === 1
                ? notices.findings[0]?.slug
                : undefined,
            );
      // ⚠ NO RESTART DEDUP, AND NONE IS NEEDED. This is `notify`, not `ask`:
      // fire-and-forget, persisting no row, so a restart cannot accumulate
      // anything to deduplicate. The dedup this replaced existed only to stop
      // an ASK minting a fresh open row every boot. Re-announcing a condition
      // that is still true on a restart is what a notification is FOR; the
      // durable half lives on the Packs surface (`packs.unrunnable`).
      void notifyUnrunnablePacks(
        notices.findings,
        (message) => notifier.notify(message),
        linkUrl,
      ).catch(() => undefined);
    }
  }

  // WatchSource generalization — the push-source governance registry
  // (process-wide default; salesforce CometD boot + the reception
  // substrate reach the same instance module-globally).
  const watchSourceRegistry = getDefaultWatchSourceRegistry();
  // Push sources (webhook / messenger / reception / salesforce CometD)
  // are pull-based in the registry, so a fire only bumps `last_event_at`
  // — the #automation surface wouldn't refresh until a manual reload.
  // Wire the notifier here (where `storage.eventBus` exists): a
  // `markEvent` window rate-caps to ≤1 `automation_rule_changed('watch')`
  // per second and the client re-pulls `watch.list`, recomputing
  // `active`/`last_event_at` fresh. Reuses the `'watch'` mechanism —
  // push rows render in the watch section and the client ignores the
  // mechanism beyond a hint.
  watchSourceRegistry.setChangeNotifier(() =>
    emitAutomationRule(storage.eventBus, 'watch'),
  );

  const { webhookListener, hookListener, connectionWebhookListener } =
    await composeWebhookAndHookListeners({
      webhookPort,
      collectionRegistry: collection.collectionRegistry,
      webhookWatcherQueue: collection.webhookWatcherQueue,
      // D-128 P3 vendor-connection webhook receiver + the webhook
      // push-source provider (WatchSource generalization — this wires
      // the receiver module that existed unwired since D-128).
      ...(app.connectionStoreRef ? { connectionStore: app.connectionStoreRef } : {}),
      ...(app.enrichmentStoreRef ? { enrichmentStore: app.enrichmentStoreRef } : {}),
      // D-190 — mirror records on HubSpot HTTP-webhook-accelerated changes too,
      // matching the reconciliation cycle + the Salesforce CometD funnel.
      ...(app.crmRecordMirrorStoreRef ? { crmRecordMirror: app.crmRecordMirrorStoreRef } : {}),
      warehouseBus: app.warehouseBus,
      sourceRegistry: watchSourceRegistry,
      // D-188 — close inbound webhook intake while the server is paused.
      ...(app.serverState
        ? { isPaused: (): boolean => app.serverState!.isPaused() }
        : {}),
    });

  // D-169 P0 — in-process bridge registry. Slice 4's multi-bridge
  // dispatcher pre-filters on each connected bridge's most-recent
  // `granted_origins`; this slice wires the producer side
  // (`bridge.capabilityProfile.push` rpc). The registry is in-RAM —
  // bridge identities persist in `client_tokens`, capability state
  // re-pushes on every reconnect (cold-boot recovery without a
  // durable store).
  const bridgeRegistry = createBridgeRegistry();

  // D-148 P9 § A.13 — vendor webhook port (Slack + Telegram bot
  // callbacks). Shares the same `webhook_port > 0` gate; absent
  // connectionStore (daemon-only) ⇒ port stays unwired and the
  // `/webhooks/*` branch in server.ts never engages. The substrate
  // slice (commit 81554dc8) shipped the port handler + per-vendor
  // descriptors + idempotency ledger.
  //
  // D-163 inbound-answer-dispatcher slice — wire the dispatch seams
  // through `composeInboundAnswerDispatcher` so verified `block_actions`
  // / `callback_query` payloads route through the matching
  // `RemoteChannel.parseInboundReply` into `block.submitAnswer`. Non-
  // callback payloads (Slack `event_callback`, plain Telegram messages)
  // still fall through to the substrate slice's log + drop behavior.
  // The dispatcher always returns both seams — degraded inputs (absent
  // block, absent channel) collapse the corresponding dispatcher to log
  // + drop, so the webhook port has a stable seam regardless.
  // D-163 polish — Telegram `answerCallbackQuery` ack. Composed when
  // the connection store is wired so the inbound-answer dispatcher can
  // clear the user's inline-keyboard spinner after `submitAnswer`
  // records the press. Absent connection store ⇒ ack is undefined and
  // the dispatcher skips the call (Telegram's client-side ~5s timeout
  // clears the spinner on its own — annoying-not-broken).
  const telegramAck = app.connectionStoreRef
    ? composeTelegramCallbackAck({
        connectionStore: app.connectionStoreRef,
        ...(app.keys ? { keys: app.keys } : {}),
      })
    : undefined;
  // D-160 A.8 step 6 downstream consumer — the messenger turn wiring.
  // A verified non-callback user message in the bound conversation
  // queues `runMessengerTurn`; the reply posts back over the vendor
  // transport. Degrades to undefined (seam absent — pre-slice posture)
  // without the orchestrator or connection store. Logged to the
  // console deliberately: the binding-gate refusal (a stranger
  // messaging the bot) is an operator-relevant security line.
  const messengerTurnIngest = composeMessengerTurnIngest({
    ...(app.chatOrchestratorRef ? { orchestrator: app.chatOrchestratorRef } : {}),
    ...(app.connectionStoreRef ? { connectionStore: app.connectionStoreRef } : {}),
    ...(app.keys ? { keys: app.keys } : {}),
    ...(collection.inboundFileCollection
      ? { fileCollection: collection.inboundFileCollection }
      : {}),
    // Media downloads stream to a data-volume scratch dir (sibling of the CAS
    // root), NOT a tmpfs `/tmp` — so a large download never routes through RAM
    // (D-172 streaming ingest). Same-volume as the CAS keeps putFile's
    // temp→rename atomic.
    ...(app.cacheBlobs
      ? { downloadDir: join(dirname(app.cacheBlobs.root), 'messenger_media_tmp') }
      : {}),
    log: (level, msg, data) => {
      const fn = level === 'warn' ? console.warn : console.log;
      fn(`[messenger] ${msg}`, data ?? '');
    },
  });
  // D-181 slice 6b — the messenger live-control surface (`/recued running` +
  // interactive kill/cancel/promote buttons). Reads the SAME live in-flight
  // registry the `execution.*` rpc wraps; resolves the canonical vendor
  // credential like the turn. Degrades to undefined (the seam stays absent —
  // no `/recued` command, no control buttons) without the registry or the
  // connection store.
  // D-186 — the "Active passes" seam backing `/recued passes`: list + early-
  // revoke active session grants through the SAME `contract-handler` helpers
  // (+ the SAME `contract.contract_definition_changed` broadcast on revoke) the
  // `session_grant.{list,revoke}` rpc uses, so the messenger surface never
  // drifts from the webclient "Active passes" bubble. Absent without the
  // contract store (graceful — the run-control half is unaffected).
  const sessionGrantPasses = app.contractStoreRef
    ? composeSessionGrantPasses({
        contractStore: app.contractStoreRef,
        broadcast: (event) => rpc.observabilityBundle.eventsDeps.bus.emit(event),
      })
    : undefined;
  const messengerLiveControl = composeMessengerLiveControl({
    ...(execution.executeDeps.inFlightRegistry
      ? { registry: execution.executeDeps.inFlightRegistry }
      : {}),
    ...(app.connectionStoreRef ? { connectionStore: app.connectionStoreRef } : {}),
    ...(app.keys ? { keys: app.keys } : {}),
    ...(sessionGrantPasses ? { passes: sessionGrantPasses } : {}),
    log: (level, msg, data) => {
      const fn = level === 'warn' ? console.warn : console.log;
      fn(`[messenger] ${msg}`, data ?? '');
    },
  });
  const { messengerDispatchers } = composeInboundAnswerDispatcher({
    ...(storage.preapprovalStorage ? { preapprovalReview: createPreapprovalTelegramIngress(storage.preapprovalStorage.repository) } : {}),
    ...(execution.notificationBlock ? { block: execution.notificationBlock } : {}),
    // D-192 CORE #6 seam 7 (Group D) — the vendor→RemoteChannel registry, the
    // SAME instances the notification block registered (lock-step). Always an
    // object (empty when no connection store) so it threads directly.
    messengerChannels: execution.messengerChannels,
    ...(telegramAck ? { telegramAck } : {}),
    ...(messengerTurnIngest ? { messengerTurnIngest } : {}),
    ...(messengerLiveControl ? { messengerLiveControl } : {}),
    // WatchSource messenger push source — verified non-callback user
    // messages emit `data.messenger.<vendor>.message.created`.
    warehouseBus: app.warehouseBus,
    markSourceEvent: (source_key, at) => watchSourceRegistry.markEvent(source_key, at),
  });

  // Several embedders compose a deliberately narrow, read-only connection
  // lookup. Local ingress needs the full live store contract so it can follow
  // enroll, rotation, and delete events; do not mistake a lookup-only adapter
  // for that lifecycle-capable store at runtime.
  const messengerIngressStore = app.connectionStoreRef;
  const canSuperviseMessengerIngress = messengerIngressStore
    && typeof messengerIngressStore.list === 'function'
    && typeof messengerIngressStore.addOnUpsert === 'function'
    && typeof messengerIngressStore.addOnDelete === 'function';
  const messengerIngressSupervisor = canSuperviseMessengerIngress && storage.db
    ? createMessengerIngressSupervisor({
        connectionStore: messengerIngressStore,
        stateStore: createMessengerIngressStateStore(storage.db),
        dispatchers: messengerDispatchers,
        decodeAuth: (row) => {
          const keyProvider = app.keys && app.keys.state() !== 'uninitialized'
            ? app.keys.keyProvider('connection')
            : undefined;
          return decodeAuthFromStorage(
            row.auth_ciphertext,
            { kind: row.kind, name: row.name },
            keyProvider,
          );
        },
        ...(app.serverState
          ? { isPaused: (): boolean => app.serverState!.isPaused() }
          : {}),
        isVaultUnlocked: app.isVaultUnlocked,
        // D-238 — the SAME process-shared refresher the send path uses
        // (memoized per connection store). Without it a Teams poll runs on the
        // stored access token and stops working about an hour after enrolment;
        // with a SECOND instance, a poll and a send could exchange concurrently
        // and each invalidate the other's rotated refresh token.
        refreshAuth: getMessengerNotificationRefresher({
          connectionStore: messengerIngressStore,
          ...(app.keys ? { keys: app.keys } : {}),
          onFailure: (failure) => {
            console.warn(
              `[messenger-refresh] ${failure.vendor}: ${failure.reason} — ${failure.detail}`,
            );
          },
        }),
        ...(app.vaultStateBus
          ? { subscribeVault: (listener) => app.vaultStateBus.subscribe(listener) }
          : {}),
        log: (level, message, data) => {
          const fn = level === 'warn' ? console.warn : console.log;
          fn(`[messenger-ingress] ${message}`, data ?? '');
        },
      })
    : undefined;
  // D-158 P2b — the inbound reply-by-email funnel: the watcher-driven peer
  // of the Slack / Telegram webhook dispatcher above. Email has no webhook —
  // a reply lands in the notification account's own mirrored mailbox — so
  // this subscribes to the warehouse bus and decodes each newly-synced mail
  // record as a possible answer to an open ask. Inert unless the block +
  // bus + connection store (to resolve the notification.email account) +
  // blob store (to materialize the reply body) are all composed.
  const emailReplyConnStore = app.connectionStoreRef;
  const emailReplyBlobs = app.cacheBlobs;
  const inboundEmailAnswer = composeInboundEmailAnswer({
    ...(execution.notificationBlock ? { block: execution.notificationBlock } : {}),
    bus: app.warehouseBus,
    ...(emailReplyConnStore
      ? {
          resolveEmailAccountSlug: (): string | null => {
            const record = emailReplyConnStore.get('notification', 'email');
            if (record === null) return null;
            try {
              const cfg = JSON.parse(record.config_json) as {
                sender_mail_instance?: unknown;
              };
              return typeof cfg.sender_mail_instance === 'string' &&
                cfg.sender_mail_instance.length > 0
                ? cfg.sender_mail_instance
                : null;
            } catch {
              return null;
            }
          },
        }
      : {}),
    ...(emailReplyBlobs
      ? {
          readInboundMail: async (slug, record_id) => {
            const mailCollection = collection.collectionRegistry.get('mail', slug);
            if (mailCollection === undefined) return null;
            const rec = mailCollection.get(record_id);
            if (rec === null) return null;
            const body = await materializeMailBody(rec, emailReplyBlobs);
            const hf = rec.hot_fields;
            return {
              subject: typeof hf.subject === 'string' ? hf.subject : '',
              folder: typeof hf.folder === 'string' ? hf.folder : '',
              from: typeof hf.from === 'string' ? hf.from : '',
              body_text: body ?? '',
            };
          },
        }
      : {}),
    log: (level, msg, data) => {
      const fn = level === 'warn' ? console.warn : console.log;
      fn(`[email-reply] ${msg}`, data ?? '');
    },
  });
  inboundEmailAnswer.start();

  const vendorWebhookListener = composeVendorWebhookPort({
    webhookPort,
    ...(app.connectionStoreRef ? { connectionStore: app.connectionStoreRef } : {}),
    // D-192 seam 11 — vendor → dispatcher, built once over the registry. A new
    // chat transport threads through here with no edit.
    messengerDispatchers,
    // D-188 — close the vendor webhook port (chat-transport intake) while paused.
    ...(app.serverState
      ? { isPaused: (): boolean => app.serverState!.isPaused() }
      : {}),
  });

  if (app.chatDeps) app.chatDeps.messengerReceiveStatus = vendor => {
    if (!app.isVaultUnlocked()) return 'locked';
    if (app.serverState?.isPaused()) return 'paused';
    const status = messengerIngressSupervisor?.status(vendor, vendor);
    if (status?.state === 'webhook' && vendorWebhookListener === undefined) return 'not_connected';
    return status?.state ?? 'unknown';
  };

  // WatchSource messenger push-source provider — one governance row per
  // enrolled messenger-capable notification connection (slack /
  // telegram; the row name IS the vendor per D-163 I-4). Active when
  // the vendor webhook port is composed — per-message auth lives at the
  // port (HMAC / secret-token), so reachability is just network
  // plumbing the operator owns.
  if (app.connectionStoreRef) {
    const messengerConnectionStore = app.connectionStoreRef;
    watchSourceRegistry.register('messenger', {
      list() {
        const rows: WatchSourceStatusEntry[] = [];
        // D-192 seam 12 — every declared chat transport, so a new one appears in
        // the watch-source list with no edit here.
        for (const vendor of listMessengerVendors()) {
          const connection = messengerConnectionStore.get('notification', vendor);
          if (connection === null) continue;
          const status = messengerIngressSupervisor?.status(vendor, vendor) ?? null;
          const webhookActive = status?.state === 'webhook' && vendorWebhookListener !== undefined;
          const localActive = status?.state === 'active';
          const active = webhookActive || localActive;
          rows.push({
            source_key: messengerSourceKey(vendor),
            mechanism: 'messenger',
            // The declaration already carries the string a human should read.
            label: `${getMessengerVendorDeclaration(vendor)?.display_name ?? vendor} inbound messages`,
            emits: [`data.messenger.${vendor}.message.created`],
            active,
            inactive_reason: active
              ? null
              : status?.detail
                ?? (status?.state === 'webhook'
                  ? 'inbound webhook port not configured'
                  : status === null
                    ? 'messenger ingress is not configured'
                    : `messenger ingress is ${status.state}`),
            last_event_at: null,
          });
        }
        return rows;
      },
    });
  }

  const collectionDeps: CollectionDeps = {
    registry: collection.collectionRegistry,
    // D-192 Fork B — surface vendor-mirrored files (`file_meta_ref`) in the
    // `data.mirror.search` files picker alongside the CAS collection.
    ...(app.fileMetaStoreRef ? { fileMetaStore: app.fileMetaStoreRef } : {}),
    ...(app.fileSourceSyncStateRef ? { fileSourceSyncState: app.fileSourceSyncStateRef } : {}),
    ...(storage.fileStack ? { fileEnroll: storage.fileStack.enrollDeps } : {}),
    ...(collection.calendarStack
      ? { calendarEnroll: collection.calendarStack.enrollDeps }
      : {}),
    ...(collection.serviceStack
      ? { serviceEnroll: collection.serviceStack.enrollDeps }
      : {}),
    ...(collection.mailStack ? { mailEnroll: collection.mailStack.enrollDeps } : {}),
    ...(app.annotationStoreRef
      ? {
          annotationCascade: (col: string, id: string) =>
            app.annotationStoreRef!.cascadeDelete(col, id),
        }
      : {}),
    ...(app.enrichmentCascadeRef
      ? {
          enrichmentCascadeOnDelete: (scope, id) =>
            app.enrichmentCascadeRef!.cascadeForSourceDelete(scope, id),
          enrichmentCascadeOnUpdate: (scope, id) =>
            app.enrichmentCascadeRef!.cascadeForSourceUpdate(scope, id),
        }
      : {}),
  };

  // D-169 P1 Codex Angle 6/7 fold — `system.status` rpc deps. The
  // bridge side-panel section #1 reads its rich status snapshot from
  // here on mount + each periodic refresh; without composing this slot
  // the rpc surfaces `not_configured` and the panel never populates
  // (P1 acceptance gap). Lazy-bound wsHandle: `createServerHandlerSet`
  // takes deps as input + returns the handle, so we hold a ref + thunk
  // through it; the post-construct line below assigns the live handle.
  let wsHandleForStatusRef: WsServerHandle | undefined;
  /** D-272 — the address the LAN listener BOUND, filled further down where the
   *  resolution happens. Same lazy-ref discipline as `wsHandleForStatusRef`
   *  above: `network.local_urls` is composed before `resolveLanAddress` runs,
   *  and a getter wants the call-time value anyway.
   *
   *  ⚠ `undefined` until then, and the handler OMITS the field rather than
   *  guessing — a probe that has not run must not report "not exposed". */
  let lanBindAddressRef: string | undefined;
  /** D-273 — the port-mapping supervisor, built once the LAN address and the
   *  runtime config are both known. Held as a ref for the same reason as
   *  `lanBindAddressRef`: `network.port_mapping` is composed before this exists,
   *  and the rpc must read the LIVE status rather than a snapshot taken at
   *  compose time — which would report the state before the first reconcile
   *  forever. */
  let portMappingSupervisorRef: PortMappingSupervisor | null = null;
  let portMappingProtocolRef: 'igd' | 'nat-pmp' | undefined;
  const serverStartedAtSeconds = Math.floor(Date.now() / 1000);
  // ⛔⛔ READ THE IDENTIFIER, NEVER `globalThis.__RECUED_SERVER_VERSION__`.
  // `__RECUED_SERVER_VERSION__` is an esbuild DEFINE, and a define substitutes
  // IDENTIFIER REFERENCES — not the property half of a member expression. So
  // this line compiled to a literal `globalThis.__RECUED_SERVER_VERSION__`
  // lookup in every shipped bundle (verified in 26.8.28's `dist/bin.js`),
  // nothing ever assigns that property, and it was `undefined` on every server
  // that has ever run. The banner reads correctly only because it goes through
  // `SERVER_VERSION`, which uses the bare identifier.
  //
  // 🔑 IT WAS NOT COSMETIC. D-178 later wired the update path to this same
  // variable, so `boot-reconcile` compared `stable:unknown` against the staged
  // `stable:<version>`, never matched, and counted every HEALTHY boot as a
  // failed one — auto-reverting the update on the third restart. Measured on a
  // real enrolled realm against the published 26.8.28: three clean boots
  // (`Status: Running`, /health 200), then `rolled_back … boot health failed 3
  // times`. No update could ever commit.
  const SERVER_VERSION_DEFINE: string = SERVER_VERSION;
  const systemStatusDeps: SystemStatusDeps = {
    getServerDisplayName: () =>
      execution.executeDeps?.serverName ?? 'recued',
    getServerVersion: () => SERVER_VERSION_DEFINE,
    getUptimeSeconds: () =>
      Math.max(0, Math.floor(Date.now() / 1000) - serverStartedAtSeconds),
    getWsServer: () => wsHandleForStatusRef,
    // Approximate last-sync as the most-recent `connected_at` across
    // the live WS roster — a fresh inbound message extends connected_at
    // on every register frame the dispatcher receives. Sufficient
    // resolution for the side-panel's "Last sync 5m ago" UX without
    // threading a per-message timestamp tracker through the dispatcher
    // (a follow-on slice can replace with that finer signal).
    getLastSyncAt: () => {
      if (!wsHandleForStatusRef) return null;
      const rows = wsHandleForStatusRef.listConnectedInstances();
      if (rows.length === 0) return null;
      let max = 0;
      for (const r of rows) {
        if (r.connected_at > max) max = r.connected_at;
      }
      return max > 0 ? max * 1000 : null;
    },
    // Pending-asks counter rides off the notification block when wired
    // (block-internal `countOutstandingAsks`); absent → `null` (the
    // side panel renders "—" without faking zeros).
    ...(execution.notificationBlock
      ? {
          countPendingAsks: () =>
            execution.notificationBlock!.countOutstandingAsks().then(
              (n) => n,
              () => null,
            ),
          // λ×W ask-load readout — same block, same best-effort posture.
          getAskLoadStats: () =>
            execution.notificationBlock!.askLoadStats().then(
              (s) => s,
              () => null,
            ),
        }
      : {}),
    // Durable paired-device count — includes offline pairs per spec
    // § N.5 #1. Joins `client_tokens` (non-revoked) when wired; absent
    // → falls back to the live connected count (degraded shape, still
    // functional). Counts ALL kinds (`bridge` + `webclient` + `cli`).
    ...(clientTokens
      ? {
          getPairedClientCount: () =>
            clientTokens.list({ include_revoked: false }).length,
        }
      : {}),
    // D-212 §7.10 — the standing sealing posture. Read live from the key
    // store's own header on every snapshot, not captured at compose time:
    // `bootSigningIdentity` runs after this deps object is built, and a
    // posture cached from before it would report `null` forever.
    //
    // 🔑 This is the floor that replaced the retracted §7.9 refusal. An
    // operator may run an unsealed keyfile; what they may not do is run one
    // without knowing, so `'none'` has to reach a client and be rendered as
    // the warning it is — never collapsed into the not-wired `null`.
    getKeyfileSealing: () =>
      storage.signingIdentity?.keyStore.sealingPosture?.() ?? null,
  };

  // D-178 — release update-check orchestrator deps. Shares the booted db
  // (rollout salt + anti-replay floor in `server_state`); current version
  // from the build-time define. Undefined on an unsupported platform.
  const releaseCheckDeps = buildReleaseCheckDeps({
    db: storage.db,
    currentVersion: SERVER_VERSION_DEFINE,
  });
  const updateModeDeps = buildUpdateModeDeps(storage.db);

  // D-235 P1 — this server's Pro DDNS reservation, for the custom-domain
  // preflight's delegation target. Read-only, and a parallel read-only instance
  // of the very row the cert-stack handle state machine writes — safe.
  let proDdnsBindingStore: ReturnType<typeof createSqliteHandleStateStore> | undefined;
  const readProDdnsBinding = async (): Promise<
    { handle: string; zone_label?: string; subscription_active: boolean } | null
  > => {
    proDdnsBindingStore ??= createSqliteHandleStateStore({ db: storage.db });
    const state = await proDdnsBindingStore.load();
    if (!state || state.current_handle.length === 0) return null;
    return {
      handle: state.current_handle,
      ...(state.ddns_zone !== undefined ? { zone_label: state.ddns_zone } : {}),
      // ⚠ `active` ONLY — `grace` is deliberately excluded, the same call
      //   `wire-pro-cert-enrollment.ts` makes: the cloud has already pulled a
      //   lapsed subscription's DNS records, so DNS-01 cannot validate and
      //   every attempt would burn CA quota to fail.
      subscription_active: state.subscription_state === 'active',
    };
  };
  // D-178 slice 4b — apply/rollback orchestrator. Built only on a self-applying
  // channel (binary / docker-thin); the restart port rides the SAME lifecycle
  // drain → supervisor handoff the bootstrap `requestRestart` rpc uses, read
  // lazily so compose-lifecycle's late `onRestartRequested` assignment is in
  // place by apply time.
  //
  // D-178 P1 — `isQuiesced` is now a REAL signal (I-5: no active runs, engine
  // idle). Two sources, both fail-closed:
  //   - the housekeeping engine-busy signal (auto-run scheduler in-flight +
  //     adapter drains), late-bound by the housekeeping composer via
  //     `bindBusySignal` (no shared signal exists yet at this boot point) — until
  //     bound, the auto path defers rather than restarting;
  //   - the live in-flight registry, which tracks the runs the engine-busy
  //     signal does NOT see (owner / MCP / chat / reactive / scheduled runs
  //     between `registerRun` and `completeRun`).
  // The owner rpc forces `trigger: 'manual'`, which never consults `isQuiesced`,
  // so manual apply works throughout the boot window. Consulted only on `auto`
  // triggers (the `update-auto-apply` housekeeping task).
  //
  // The check→restart admission window is now closed at the DRAIN: the
  // lifecycle restart drain (`compose-lifecycle.ts`'s `getInFlightCount`)
  // awaits BOTH the cron in-flight counter AND this registry's
  // `activeRunCount()` (wired in `start-post-app-collection-execution-runtime`
  // via `getActiveRunCount`), so a run admitted between the quiesce check and
  // the restart still blocks the `await_inflight` step. Benefits every restart
  // trigger, not just auto-apply. (D-153's no-auto-resume + checkpointing
  // already made a mid-run restart safe; the drain now also waits it out.)
  let isEngineBusy: (() => boolean) | undefined;
  const inFlightRegistry = execution.executeDeps.inFlightRegistry;
  const isQuiescedNow = (): boolean => {
    if (!isEngineBusy || isEngineBusy()) return false;
    if (inFlightRegistry && inFlightRegistry.activeRunCount() > 0) return false;
    return true;
  };
  const updateApplyDeps =
    releaseCheckDeps
      ? buildApplyOrchestratorDeps({
          db: storage.db,
          releaseCheckDeps,
          requestRestart: (onDrained) =>
            bootstrapDeps?.onRestartRequested?.('update apply', onDrained),
          // ⛔ The orchestrator refuses an apply nothing would restart. The mode
          // comes from the SAME supervisor the handoff above uses, so the guard
          // and the exit can never disagree about who is watching.
          supervisorWillRespawn: () => supervisorRespawns(lifecycle?.supervisor.mode),
          isQuiesced: isQuiescedNow,
          // D-152 § A.16 — lets a self-update extract the matched webclient to the
          // SAME dir the loader below reads (RECUED_WEBCLIENT_DIR / CAS sibling).
          cacheBlobsRoot: app.cacheBlobs?.root,
        })
      : undefined;
  // D-178 P1 — publish the periodic-release entry for the housekeeping composer
  // (which owns the engine-busy signal). It registers the `update-auto-apply`
  // idle task + calls `bindBusySignal` to back the `isQuiesced` port above.
  // Cleared (published `undefined`) only on an UNSUPPORTED PLATFORM, so a prior
  // boot's entry can't leak into a re-compose.
  //
  // ⛔ The gate is `releaseCheckDeps`, NOT `updateApplyDeps`. It used to be
  // both — which registered NOTHING on `docker-baked` / `source`, the two
  // channels whose default mode is `notify`. They defaulted to being told about
  // releases and had nothing that ever looked.
  updateAutoApplyRegistry.publish(
    buildUpdateReleaseEntry({
      releaseCheckDeps,
      applyDeps: updateApplyDeps,
      modeStore: updateModeDeps.store,
      channel: updateModeDeps.channel,
      ...(updateModeDeps.envMode !== undefined ? { envMode: updateModeDeps.envMode } : {}),
      bindBusySignal: (fn) => {
        isEngineBusy = fn;
      },
      // D-158 — what makes `notify` mode reach a person rather than only the
      // audit log. Absent on a db-less boot, where the audit row is the report.
      ...(execution.notificationBlock ? { notificationBlock: execution.notificationBlock } : {}),
    }),
  );
  // D-178 slice 4b items 3-4 — the on-boot reconcile thunk (commit / auto-revert
  // + ledger→audit replay). Run AFTER markBooted (the server is serving, so a
  // staged release that reached here booted healthy → commit). Best-effort:
  // wrapped so a reconcile failure never blocks the boot it runs after.
  //
  // The owner alert is bound through `NotificationBlock.notify` ONLY. There is
  // no answer to collect after the state machine has decided an outcome, and an
  // ask with a lone Dismiss option would put an error report in the decision
  // queue and let an answer clear it while the condition remained true. The
  // update ledger/journal carries the durable condition; this is its heads-up.
  const updateOwnerAlert = execution.notificationBlock
    ? createUpdateOwnerAlertSink(
        execution.notificationBlock,
        buildUpdatesSurfaceLink(
          resolvePublicBaseUrl(process.env.RECUED_PUBLIC_BASE_URL),
        ) ?? undefined,
      )
    : undefined;
  const runUpdateBootReconcile =
    updateApplyDeps && releaseCheckDeps
      ? async (): Promise<void> => {
          try {
            const outcome = await runUpdateBootReconcileImpl({
              ports: updateApplyDeps.ports,
              channel: releaseCheckDeps.channel === 'edge' ? 'edge' : 'stable',
              currentVersion: SERVER_VERSION_DEFINE,
              ...(storage.auditLog ? { auditLog: storage.auditLog } : {}),
              ...(updateOwnerAlert ? { ownerAlert: updateOwnerAlert } : {}),
              // The exact success/abandon result is known only after lifecycle
              // has closed SQLite. Keep that late callback a local log; the
              // owner notification begins before the drain through the port
              // above, while its settings store is still usable.
              postDrainLog: (m) => console.error(`[update] ${m}`),
            });
            if (outcome.action === 'manual-rollback-recovery-failed') {
              console.error(
                `[update] manual rollback recovery FAILED for ${outcome.releaseIdentity}: `
                + `${outcome.reason}. The durable journal was retained for operator recovery.`,
              );
            }
          } catch (err) {
            console.error('[update] boot reconcile failed', err);
          }
        }
      : undefined;

  // D-169 P2 — historical-view rpc deps. Reads only; sources are
  // already-in-scope state: the D-120 audit log backs `execution.recent`
  // + `notification.recent` (`notification_fired` rows), and the
  // notification block's `listOpenAsks` backs `notification.pending_asks`.
  // Each source is wired only when present; an absent source resolves its
  // read to `[]` (the handler self-gates), matching the `system.status`
  // null-counter posture.
  // D-270 — the approval card's "what will happen" rows.
  //
  // 🔑 BOUND INDEPENDENTLY OF THE RECEPTION BUNDLE, deliberately. The obvious
  // wiring is to reach for `receptionInboxBundle.receptionInboxDeps` (it already
  // holds a live-catalog `resolveArgEditSchema`) — and it would have tied the
  // CARD's details to whether the RECEPTION lane composed, which is exactly the
  // coupling this entry exists to undo. `resolveArgEditSchema` + `buildResolverDeps`
  // are importable on their own and need only the manifest store, so the card's
  // resolver needs nothing the reception lane owns.
  const askCardDetails = storage.auditLog && execution.executeDeps.checkpointStore
    ? createAskCardDetailResolver({
      getCheckpoint: (id: string) => execution.executeDeps.checkpointStore!.get(id),
      getAnchor: (run_id: string) => storage.auditLog!.get(run_id),
      resolveArgEditSchema: (operationId, prefilledArgs) =>
        resolveArgEditSchema(
          operationId,
          prefilledArgs,
          buildResolverDeps(storage.localManifestStore),
        ),
      // ⛔ REQUIRED or every batched ask fails closed and renders no rows — the
      // same silent feature-off the `/ask` page had before its own membership
      // read was threaded. Not passing it is not a smaller feature, it is none.
      ...(execution.getBatch !== undefined ? { getBatch: execution.getBatch } : {}),
    })
    : undefined;

  const historyDeps: HistoryDeps = {
    ...(storage.auditLog ? { auditLog: storage.auditLog } : {}),
    ...(askCardDetails ? { resolveAskDetails: askCardDetails } : {}),
    ...(execution.notificationBlock
      ? {
          listOpenAsks: () => execution.notificationBlock!.listOpenAsks(),
          // D-169 P2 Slice 3 — the bridge approval card's submit funnel.
          // The wire layer owns the `via` channel decision (the interactive
          // answer arrives on the `ui` inbound path; the first-class
          // `bridge` channel is notify-only), so the handler stays
          // channel-agnostic.
          submitAnswer: (ask_id: string, option_id: string, note?: string) =>
            execution.notificationBlock!.submitAnswer({
              ask_id,
              option: option_id,
              via: 'ui',
              // D-234 § 234.4e — forwarded verbatim; the block decides whether
              // this ask invited a note, caps it, and refuses a missing required
              // one. Nothing here re-judges any of that.
              ...(note !== undefined ? { note } : {}),
            }),
        }
      : {}),
  };

  // D-173 INT-3 — Reception Inbox boot-wiring. Converges Lane P (the
  // ArgEditSchema resolver over the installed catalog's lowered
  // `editable_args`) + Lane I (the inbox handlers + the N.5 boundary writer)
  // into a working review-then-approve inbox. `submitAnswer` is the SAME
  // notification-block resume funnel `historyDeps` uses (pre-bound to the
  // `ui` channel); the gate handles (`auditLog` / `checkpointStore` /
  // `localManifestStore`) gate the slice (absent → `not_configured`). The
  // returned `projectReception` effect (`runReceptionProjection`-backed) is
  // the ready seam the P3 dispatch-routing slice binds as the catalog op's
  // connection-adapter effect.
  // D-173 P4.3 — the local-calendar create seam for the inbox-side
  // `projectReception` effect (the `calendar.event` branch).
  //
  // ⚠ Since D-210 A.2 that branch serves an INTAKE targeting a calendar, NOT a
  // reservation — a booking is never in the calendar, so the scheduling booking
  // store is no longer one of this seam's deps. Absent → a calendar projection
  // fail-closes. Mirrors the executor-config kernel binding.
  const receptionCalendarSeam = collection.calendarStack
    ? createReceptionCalendarEventSeam({
        calendarCreate: collection.calendarStack.kernelDispatchers.calendarCreate,
      })
    : undefined;

  // D-210 A.2 / slice 3b — the SCHEDULING booking write path: the reservation's
  // whole materialization, replacing the calendar event it used to hang off.
  // Needs BOTH the work-entity store (the row) and the scheduling booking store
  // (the sealed slot + provenance); absent → a reservation projection
  // fail-closes rather than silently dropping an approved booking.
  //
  // The counterparty (sealed email → contact id) and the title (endpoint
  // `display_name`) are each independently optional, so a partial substrate
  // costs the booking a FIELD, never the row.
  const receptionBookingSeam =
    storage.workEntityStoreRef && storage.intakeFormSubmissionStoreRef && app.keys
      ? createReceptionBookingMintSeam({
          writeBooking: (writeInput, now) =>
            storage.workEntityStoreRef!.writeBooking(writeInput, now),
          readBooking: (id) => storage.workEntityStoreRef!.readBooking(id),
          findBooking: (request_id) =>
            storage.intakeFormSubmissionStoreRef!.findById(request_id),
          markProcessed: (input) => storage.intakeFormSubmissionStoreRef!.markProcessed(input),
          ...(storage.publicEndpointRegistryStoreRef
            ? {
                findEndpoint: (endpoint_id) =>
                  storage.publicEndpointRegistryStoreRef!.findById(endpoint_id),
              }
            : {}),
          // The same reception key both verifies the drain-minted id binding
          // and (when contact storage exists) opens the sealed visitor email.
          // The seam is not constructed without it: unauthenticated ids must
          // fail closed rather than becoming a weaker no-counterparty booking.
          getFormSubmissionPiiKey: () =>
            deriveFormSubmissionPiiKeyFromSubDek(app.keys!.getSubDEK('reception')),
          ...(app.contactStoreRef
      ? { contactDeps: buildContactDeps(app.contactStoreRef, storage.recordsStore) }
      : {}),
        })
      : undefined;

  // D-173 P5 — the file-attach seam for the inbox-side `projectReception`
  // effect (the drop branch: a task with the file attached). Built only when
  // the annotation store is up; absent → a work-entity projection carrying a
  // `file_id` fail-closes. Mirrors the executor-config kernel binding.
  const receptionAttachSeam = app.annotationDeps
    ? createReceptionAttachFileSeam({
        attachDeps: {
          annotationDeps: app.annotationDeps,
          registry: collection.collectionRegistry,
        },
      })
    : undefined;

  // D-177 N.14.8 fork 3 — ONE instance: the inbox WRITES rejects through it and
  // the suggestion read COUNTS them through it. Two instances would be two
  // handles on the same table, but naming it once makes the shared-ness the
  // code's claim rather than SQLite's coincidence.
  const receptionInboxSubviewStore = createReceptionInboxSubviewStore(storage.db);

  const receptionInboxBundle = composeReceptionInboxDeps({
    auditLog: storage.auditLog,
    checkpointStore: storage.checkpointStore,
    localManifestStore: storage.localManifestStore,
    eventBus: storage.eventBus,
    subviewStore: receptionInboxSubviewStore,
    // D-173 D7 — "confirmed at approval": the OWNER-facing overlap count over
    // every calendar they have, so a held booking can say what else is on then.
    // Absent (no calendar stack) ⇒ no count surfaces, and the inbox renders
    // nothing rather than a misleading zero.
    //
    // ⛔ Owner-facing only. The VISITOR slot picker keeps the null reader
    // (`wire-reception-substrate.ts`) — free/busy-vs-your-calendar stays out of
    // scope for visitors per D7, and event intervals are a free/busy
    // disclosure. Same data, opposite audience; never cross-wire these.
    ...(collection.calendarStack
      ? {
          countCalendarOverlap: (window_start: number, window_end: number) => {
            const stack = collection.calendarStack!;
            // Rebuilt per call — calendars can be enrolled or started after
            // boot, and a stale map would silently drop one from the count.
            const live = new Map(stack.listLive().map((c) => [c.slug, c.table]));
            return countCalendarOverlap(
              {
                instances: stack.instances,
                // An enrolled instance with no live collection (never synced /
                // failed to start) resolves to null ⇒ counted as UNREADABLE,
                // never as zero. The gap between `instances` and `listLive()`
                // is exactly the calendar we cannot speak for.
                getTable: (slug) => live.get(slug) ?? null,
              },
              window_start,
              window_end,
            );
          },
        }
      : {}),
    // D-210 A.5.3b — owner-side lookup only. Re-derive from the
    // substrate-authored projection args at this privacy boundary rather than
    // treating the presentation-layer source ref as authority.
    ...(storage.intakeFormSubmissionStoreRef
      && storage.workEntityStoreRef
      && app.contactStoreRef
      && app.keys
      ? {
          lookupBookingHistory: async (
            source: { kind: string },
            args: Readonly<Record<string, unknown>>,
          ) => {
            // A managed reschedule already names the existing booking. Its
            // opaque contact id is enough for an owner-side history lookup and
            // avoids reopening any visitor PII. Exclude the current row so the
            // panel is genuinely prior history.
            const bookingId = args.booking_id;
            if (typeof bookingId === 'string' && bookingId.length > 0) {
              const booking = storage.workEntityStoreRef!.readBooking(bookingId);
              if (booking?.counterparty_contact_id === undefined) return undefined;
              return storage.workEntityStoreRef!.getBookingHistory({
                counterparty_contact_id: booking.counterparty_contact_id,
                exclude_booking_id: booking.id,
                limit: 10,
              });
            }

            // A fresh scheduling approval has no booking yet, so resolve the
            // sealed request email to the local contact id. Other reception
            // sources neither carry this request id nor receive visitor PII.
            if (source.kind !== 'scheduling_link') return undefined;
            const requestId = args.booking_request_id;
            if (typeof requestId !== 'string' || requestId.length === 0) return undefined;
            const row = storage.intakeFormSubmissionStoreRef!.findById(requestId);
            if (row === null || row.slot === null || row.visitor_email_encrypted === null) {
              return undefined;
            }
            const email = await openFormSubmissionField({
              key: deriveFormSubmissionPiiKeyFromSubDek(app.keys!.getSubDEK('reception')),
              endpoint_id: row.endpoint_id,
              submission_id: row.submission_id,
              field: 'visitor_email',
              ciphertext: row.visitor_email_encrypted,
            });
            if (email === null || email.trim().length === 0) return undefined;
            const contact = app.contactStoreRef!.get(email.trim().toLowerCase());
            if (contact?.contact_id === undefined) return undefined;
            return storage.workEntityStoreRef!.getBookingHistory({
              counterparty_contact_id: contact.contact_id,
              limit: 10,
            });
          },
        }
      : {}),
    // A form_response destination is the owner-editable working copy. Reveal
    // its sealed source only on this paired-admin approval surface; public
    // visitor links never receive this resolver.
    ...(storage.intakeFormSubmissionStoreRef && app.keys
      ? {
          resolveFormResponseEdit: async (
            source: { kind: string },
            args: Readonly<Record<string, unknown>>,
          ) => {
            if (source.kind !== 'intake_form') return undefined;
            const metadata = args.metadata;
            if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
              return undefined;
            }
            const submissionId = (metadata as Record<string, unknown>)
              .reception_form_submission_id;
            if (typeof submissionId !== 'string' || submissionId.length === 0) return undefined;
            const row = storage.intakeFormSubmissionStoreRef!.findById(submissionId);
            if (row === null || row.submission_blob_encrypted === null) return undefined;
            const key = deriveFormSubmissionPiiKeyFromSubDek(app.keys!.getSubDEK('reception'));
            const [payloadJson, visitorEmail] = await Promise.all([
              openFormSubmissionField({
                key,
                endpoint_id: row.endpoint_id,
                submission_id: row.submission_id,
                field: 'submission_blob',
                ciphertext: row.submission_blob_encrypted,
              }),
              openFormSubmissionField({
                key,
                endpoint_id: row.endpoint_id,
                submission_id: row.submission_id,
                field: 'visitor_email',
                ciphertext: row.visitor_email_encrypted,
              }),
            ]);
            if (payloadJson === null) return undefined;
            const payload = JSON.parse(payloadJson) as unknown;
            if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
              return undefined;
            }
            const fields = (payload as Record<string, unknown>).fields;
            if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
              return undefined;
            }
            return {
              values: fields as Readonly<Record<string, unknown>>,
              ...(visitorEmail !== null ? { visitor_email: visitorEmail } : {}),
            };
          },
        }
      : {}),
    // D-210 Phase C — the no-ask release leg. Independent of the block:
    // a notify-mode hold has no ask to answer, so this is the ONLY way it
    // can be approved or rejected from the inbox.
    ...(execution.preflightResumer
      ? { preflightResumer: execution.preflightResumer }
      : {}),
    ...(execution.notificationBlock
      ? {
          submitAnswer: (ask_id: string, option_id: string, note?: string) =>
            execution.notificationBlock!.submitAnswer({
              ask_id,
              option: option_id,
              via: 'ui',
              // D-234 § 234.4e — forwarded verbatim; the block decides whether
              // this ask invited a note, caps it, and refuses a missing required
              // one. Nothing here re-judges any of that.
              ...(note !== undefined ? { note } : {}),
            }),
          // D-177 N.14 — the allow-for-this-form offer, read off the REAL
          // ask (as raised, never recomputed): present iff the ask is
          // still open, actually carries the `allow_session` option, and
          // its payload holds the offer bounds. Feeds the InboxItem hint
          // + the approve path's act-site re-verify.
          readAskAllowOffer: async (ask_id: string) => {
            const ask = await execution.notificationBlock!.getAsk(ask_id);
            if (ask === null || ask.status !== 'open') return undefined;
            if (!ask.options.some((o) => o.id === 'allow_session')) {
              return undefined;
            }
            const offer = (
              ask.handler_payload as {
                session_grant?: { ttl_ms?: unknown; max_uses?: unknown };
              }
            ).session_grant;
            if (
              offer === undefined
              || typeof offer.ttl_ms !== 'number'
              || typeof offer.max_uses !== 'number'
            ) {
              return undefined;
            }
            return { ttl_ms: offer.ttl_ms, max_uses: offer.max_uses };
          },
        }
      : {}),
    ...(storage.workEntityStoreRef ? { workEntityStore: storage.workEntityStoreRef } : {}),
    ...(storage.formResponseStoreRef
      ? { formResponseStore: storage.formResponseStoreRef }
      : {}),
    ...(app.contactStoreRef
      ? { contactDeps: buildContactDeps(app.contactStoreRef, storage.recordsStore) }
      : {}),
    ...(receptionCalendarSeam ? { createCalendarEvent: receptionCalendarSeam } : {}),
    ...(receptionBookingSeam ? { createBooking: receptionBookingSeam } : {}),
    ...(receptionAttachSeam ? { attachFile: receptionAttachSeam } : {}),
    // D-173 P5 (scan-gate part B) — surface a drop attachment's LIVE
    // data.file.received scan_status (the ClamAV pack writes the verdict via
    // core.storage.file.set-scan-status) in the inbox, instead of the static
    // `unscanned` the source resolver stamps. Narrow read over the registry;
    // a missing collection / record yields undefined → the default `unscanned`
    // stands and the advisory gate still warns.
    readFileScanStatus: (file_id: string): ReceptionInboxScanStatus | undefined => {
      const fileCollection = collection.collectionRegistry.get('file', 'received') as
        | { get(id: string): { hot_fields?: { scan_status?: ReceptionInboxScanStatus } } | null }
        | undefined;
      return fileCollection?.get(file_id)?.hot_fields?.scan_status;
    },
  });

  // D-158 P2b-ii — notification ask-landing route deps. Built only when the
  // block is up; closes over the block's getAsk / submitAnswer / verification-
  // phrase reads + a per-process single-use form-nonce store.
  // `createServerHandlerSet` mounts the `/ask/<ask_id>` handler on the `ask`
  // path role when present (else absent → path-router 404s). Honors the same
  // `RECUED_RECEPTION_TRUST_PROXY` gate reception uses for the same-origin
  // scheme tightening.
  //
  // ⚠ ORDER IS LOAD-BEARING since D-210 A.8 3d-2b: this block reads
  // `receptionInboxBundle` for the held-op detail resolver, so it must stay
  // BELOW that composition. It used to sit above it (nearer the other port
  // deps), which is why the move happened rather than a lazily-captured
  // binding — a closure over a `let` assigned later would have compiled and
  // silently resolved `undefined` at every early request.
  const askTrustForwardedProto =
    process.env.RECUED_RECEPTION_TRUST_PROXY === 'true' ||
    process.env.RECUED_RECEPTION_TRUST_PROXY === '1';

  // D-210 A.8 3d-2b — what this approval actually commits to, rendered above
  // the options. Bound only when the inbox is wired: absent ⇒ the page
  // renders exactly as it did pre-3d-2b.
  //
  // ⚠ The ANNOTATION is the point, not decoration. This reaches the deps
  // through a conditional SPREAD, and a spread skips TypeScript's
  // excess-property check — so renaming `resolveDetails` on
  // `AskLandingPortHandlerDeps` would leave this site spreading a key
  // nothing reads, at tsc ZERO, with the feature silently dead. That is the
  // same shape that left `receptionManageMintDeps` dead on the wire.
  // `Pick<…, 'resolveDetails'>` fails the build the moment the key moves.
  //
  // ⚠ `editable` and `submitEditedApproval` are bound TOGETHER off the same
  // bundle (D-210 A.8 3d-2c). They must never come apart: controls the
  // submit path cannot honour would let the owner retime a slot, approve,
  // and have the original value land at `success: true`.
  const askDetailDeps: Pick<
    NonNullable<ServerConfig['askLandingPortDeps']>,
    'resolveDetails' | 'submitEditedApproval'
  > =
    receptionInboxBundle !== undefined
      ? {
          resolveDetails: createAskLandingDetailResolver({
            findHoldItem: (hold_id: string) =>
              findReceptionHoldItem(receptionInboxBundle.receptionInboxDeps, hold_id),
            // ⛔ REQUIRED for a reception hold to render at all. Reception maps
            // to a run-scoped origin unit, so its holds are SINGLE-MEMBER
            // batches; without a live membership read the resolver fails closed
            // on every one of them and the `/ask` page shows no details and no
            // edit controls — which is exactly what it did before this was
            // wired. Not passing it is a silent feature-off, so it is threaded
            // from the same bundle that owns the batch rows.
            ...(execution.getBatch !== undefined
              ? { getBatch: execution.getBatch }
              : {}),
            editable: true,
          }),
          submitEditedApproval: createAskLandingEditApproval({
            findHoldItem: (hold_id: string) =>
              findReceptionHoldItem(receptionInboxBundle.receptionInboxDeps, hold_id),
            approve: async ({ hold_id, edits, ask_id }) => {
              // The ask capability is the authority — NOT a synthesised
              // instance_id. `resolveApprover` takes this arm and the audit
              // detail names it.
              const out = await handleReceptionInboxApprove(
                receptionInboxBundle.receptionInboxDeps,
                { hold_id, edits },
                { ask_landing: { ask_id } },
              );
              return {
                released: out.released,
                ...(out.reason !== undefined ? { reason: out.reason } : {}),
              };
            },
          }),
        }
      : {};

  const askLandingPortDeps: ServerConfig['askLandingPortDeps'] =
    execution.notificationBlock
      && storage.publicEndpointRegistryStoreRef
      && storage.receptionRateLimiterRef
      && storage.ipBlockStoreRef
      && app.keys
      ? {
          getAsk: (ask_id: string) => execution.notificationBlock!.getAsk(ask_id),
          submitAnswer: (reply) => execution.notificationBlock!.submitAnswer(reply),
          getVerificationPhrase: async () =>
            (await execution.notificationBlock!.getNotificationSettings())
              .verification_phrase,
          nonceStore: createInMemoryAskLandingNonceStore(),
          trustForwardedProto: askTrustForwardedProto,
          abuse: {
            getStore: () => storage.publicEndpointRegistryStoreRef!,
            getRateLimiter: () => storage.receptionRateLimiterRef!,
            getIpBlockStore: () => storage.ipBlockStoreRef!,
            getPepper: () => deriveReceptionPepperFromSubDek(
              app.keys!.getSubDEK('reception'),
            ),
            trustForwardedFor: askTrustForwardedProto,
          },
          ...askDetailDeps,
        }
      : undefined;

  // D-165 enroll-host #1 (vendor OAuth popup) — slice 2b Piece W.
  // Construct the shared start↔complete stores ONCE so the start rpc
  // (`connectionDeps.vendorOAuthStart`) and the `/oauth/complete` port
  // handler (`oauthCompletePortDeps`) hand the pending flow + the
  // exchanged credential through the SAME in-memory maps: start `put`s a
  // flow, complete `take`s it + `put`s the result, the result-claim rpc
  // `take`s that. Gated on the booted signing identity — the start rpc
  // signs the `state` token and the complete handler verifies the echoed
  // state against the same key, so without identity neither side can
  // function. Absent → the substrate stays unwired (start rpc →
  // `not_configured`; the `oauth` path role is never mounted → 404),
  // mirroring `composePassportFetchSubstrate`'s identity gate.
  const vendorOAuthIdentity = options.signingIdentity?.identity;
  const vendorOAuth = vendorOAuthIdentity
    ? {
        identity: vendorOAuthIdentity,
        flowStore: createVendorOAuthFlowStore(),
        resultStore: createVendorOAuthResultStore(),
        // The signed state carries this; the cloud callback page forwards
        // the code to `<server_url>/oauth/complete`, and it forms the
        // direct-redirect choice. Read live per-call so a mid-run env
        // change is honoured; canonicalisation happens in the rpc / core.
        serverPublicUrl: (): string | null =>
          process.env.RECUED_PUBLIC_BASE_URL?.trim() || null,
      }
    : undefined;

  // D-170 N.4 / N.15 — draft store + test-before-save preview deps. The draft
  // store is always present (per-pair db). The preview's READ-execution seam
  // is the SAME connection store + api-handler deps the live executor wires —
  // so a previewed read is the call the installed catalog would make — and
  // degrades cleanly to a non-executing redacted plan when either is absent
  // (dbless / key-uninitialised). The mutation gate lives in the preview
  // itself; this seam is reached only for reads. `ingredient.saveAsNew` rides
  // the same dependency family and uses the local manifest store for the local
  // publish half without a new server.ts forward.
  const previewConnectionStore = app.connectionStoreRef;
  const previewConnectionApi = execution.executorConfig.connectionApi;
  const ingredientDraftDeps: IngredientDraftRpcDeps = {
    draftStore: storage.draftStore,
    localManifestStore: storage.localManifestStore,
    ...(previewConnectionStore
      ? { connectionLookup: (kind, name) => previewConnectionStore.get(kind, name) }
      : {}),
    ...(previewConnectionStore && previewConnectionApi
      ? {
          previewExecute: createPreviewConnectionExecute({
            store: previewConnectionStore,
            connectionApi: previewConnectionApi,
          }),
        }
      : {}),
  };

  // R2 build step 4c.1 — `recipe.runnability` read surface. The gatherer
  // reverse-maps each bound `api` connection's vendor op grants to canonical
  // capabilities, so it needs the live connection store + the LIVE operation-
  // profile instance the gateway reads; the local-manifest store (when present)
  // feeds the merged vendor registry so a 3rd-party CRM pack resolves too.
  // recipeStore is always present; the rpc gates on the connection store (absent in
  // a dbless harness) → `not_configured`, like `recipe.list`. R1 is family-coarse,
  // so the uninstall reverse-walk needs only the manifest store + the pack's
  // refcount-aware local-catalog drop-ids (`privateByoDropIds`) to simulate the
  // post-uninstall registry shrink — the former grant/profile/binding deps are gone.
  const contractStore = app.contractStoreRef;
  const recipeRunnabilityDeps: RecipeRunnabilityHandlerDeps | undefined =
    app.connectionStoreRef
      ? {
          connectionStore: app.connectionStoreRef,
          recipeStore: storage.recipeStore,
          ...(storage.localManifestStore
            ? { localManifestStore: storage.localManifestStore }
            : {}),
          ...(contractStore
            ? {
                localCatalogDropIdsForPack: (pack_slug: string) =>
                  privateByoDropIds(contractStore, pack_slug),
                // The pack arm of the disclosure. Built from the SAME
                // `buildPackOpResolution` the run path lowers through, so the
                // detail cannot advertise a recipe runnable that the run then
                // refuses for a missing pack — the property the whole
                // disclosure exists to hold.
                installedPackRefs: () => new Set(
                  buildPackOpResolution(
                    () => contractStore.scan('installed_pack', []),
                    (slug: string) => execution.executorConfig.manifests.get(slug),
                  ).keys(),
                ),
              }
            : {}),
        }
      : undefined;

  // R2 build step 4c.4 — one broadcaster over the SAME deps as the read surface,
  // bound to the bus. The connection (enroll/delete/grant/revoke) + pack
  // (install/uninstall) handlers call `recomputeAndEmit()` after their mutation
  // commits → a `recipe_runnability_changed` snapshot fans to paired clients.
  // Gated on the bus; best-effort by construction (the broadcaster swallows).
  const recipeRunnabilityBroadcaster =
    recipeRunnabilityDeps && storage.eventBus
      ? makeRecipeRunnabilityBroadcaster(recipeRunnabilityDeps, (event) => {
          storage.eventBus.emit(event);
        })
      : undefined;

  // Reactive-substrate slice 1 — boot the event-trigger substrate
  // (store + warehouse-bus dispatcher) and hand its rpc deps to the
  // handler set below. Returns undefined on dbless boots → the
  // `triggers.*` rpc surface stays `not_configured`.
  const eventTriggersBundle = composeEventTriggers({
    db: storage.db,
    warehouseBus: app.warehouseBus,
    executeDeps: execution.executeDeps,
    auditLog: storage.auditLog,
    eventBus: storage.eventBus,
    localManifestStore: storage.localManifestStore,
    // R21.1 — reactive fan-out drops while the vault is sealed.
    isVaultUnlocked: app.isVaultUnlocked,
    // D-268 — a failed reactive fire finally reaches the owner. Bound here
    // because this is where the dispatcher composition and the notification
    // block meet; the dispatcher itself stays ignorant of the block.
    // ⚠ Fire-and-forget: a dead owner channel must not delay a fan-out.
    ...(execution.notificationBlock
      ? {
        onAutomationFailure: (notice: NotificationMessage): void => {
          void execution.notificationBlock!.notify(notice).catch((err: unknown) => {
            console.warn('[d-268] trigger failure notice not delivered', err);
          });
        },
      }
      : {}),
  });

  let refreshPreapprovalAutomations: (() => void | Promise<void>) | undefined;
  const preapproval = storage.preapprovalStorage && app.clientTokensRef && app.connectionStoreRef
    && scheduleDeps && dishDeps?.groupStore && rpc.autoRunDeps && eventTriggersBundle
    && execution.contractDefinitionStore && execution.notificationBlock
    && execution.executeDeps.opAdmissionGate && execution.executeDeps.approvalResumeAuthority
    && execution.executeDeps.commitStore && execution.executeDeps.checkpointStore && execution.executeDeps.gatedActionStore
    ? composePreapproval({ ownerId: storage.serverInstanceId, storage: storage.preapprovalStorage,
      sources: { db: storage.db, recipes: storage.recipeStore, dishes: dishDeps.store, groups: dishDeps.groupStore,
        schedules: scheduleDeps.store, autoRun: rpc.autoRunDeps.settingsStore, triggers: eventTriggersBundle.store },
      circuits: rpc.autoRunDeps.circuitStore, execution: execution.executeDeps,
      profiles: { connectionStore: app.connectionStoreRef, getManifest: slug => execution.executorConfig.manifests.get(slug),
        contractGrantStore: app.contractGrantStoreRef, connectionCatalogBindingStore: app.connectionCatalogBindingStoreRef },
      clientTokens: app.clientTokensRef, definitions: execution.contractDefinitionStore, inboundTokens: app.chatInboundTokenStoreRef,
      notifications: execution.notificationBlock, keys: app.keys,
      onActivationChanged: () => refreshPreapprovalAutomations?.(),
      ...(collection.mailStack && app.cacheBlobs ? { mail: {
        registry: collection.collectionRegistry, instances: collection.mailStack.instances, blobs: app.cacheBlobs,
      } } : {}),
      reviewLink: proposalId => {
        const base = resolvePublicBaseUrl(process.env.RECUED_PUBLIC_BASE_URL);
        return base ? `${base}/#approvals/preapproval/${encodeURIComponent(proposalId)}` : null;
      },
    }) : undefined;
  if (preapproval) {
    if (scheduleDeps) scheduleDeps.preapprovalStatus = preapproval.scheduleStatus;
    if (eventTriggersBundle) eventTriggersBundle.triggersDeps.preapprovalStatus = preapproval.triggerStatus;
  }
  if (preapproval && await storage.preapprovalStorage!.recover()) await preapproval.outbox.drain();

  // Poll-manager / G6 — the watch substrate composes on top of the
  // trigger store (its demand source). Demand-changing seams hook
  // recompute below: trigger CRUD (late-bound `onRulesChanged`),
  // recipe-store mutations (declarative reconcile first, so a freshly
  // installed recipe's triggers exist before demand derivation), and
  // connection enroll/delete (the profile reseed hooks registered at
  // boot run first — registration order — so the poll path sees the
  // updated grants).
  const watchBundle = composeWatchManager({
    sourceRegistry: watchSourceRegistry,
    db: storage.db,
    warehouseBus: app.warehouseBus,
    executeDeps: execution.executeDeps,
    triggersStore: eventTriggersBundle?.store,
    eventBus: storage.eventBus,
    localManifestStore: storage.localManifestStore,
    // R21.1 — poll loops disarm while the vault is sealed.
    isVaultUnlocked: app.isVaultUnlocked,
  });
  refreshPreapprovalAutomations = async () => {
    eventTriggersBundle?.dispatcher.rebuild();
    watchBundle?.manager.recompute();
    await rpc.autoRunDeps?.getHandle()?.refreshRoster();
    emitAutomationRule(storage.eventBus, 'event_trigger');
    emitAutomationRule(storage.eventBus, 'auto_run');
  };
  if (eventTriggersBundle && watchBundle) {
    eventTriggersBundle.triggersDeps.onRulesChanged = () => watchBundle.manager.recompute();
  }
  if (eventTriggersBundle || watchBundle) {
    execution.executeDeps.recipeStore.setOnMutated(() => {
      eventTriggersBundle?.reconcile();
      watchBundle?.manager.recompute();
    });
  }
  if (watchBundle && execution.executeDeps.connectionStore) {
    execution.executeDeps.connectionStore.addOnUpsert(() => watchBundle.manager.recompute());
    execution.executeDeps.connectionStore.addOnDelete(() => watchBundle.manager.recompute());
  }

  // D-201 Slice 8J — production installs one closed delivery-profile preset
  // registry. Clock-dependent mechanism presets are omitted unless the
  // boot-pinned HTTPS authority exists; their wrappers re-check that authority
  // for every delivery, handshake, and profile-aware test build.
  const webhookClockAuthorityUrl = resolveWebhookClockAuthorityUrl(
    process.env.RECUED_WEBHOOK_CLOCK_AUTHORITY_URL,
  );
  const webhookClockAuthority = webhookClockAuthorityUrl === null
    ? null
    : createWebhookClockHealthAuthority({
        authorityUrl: webhookClockAuthorityUrl,
      });
  const webhookProfiles = createWebhookProfileRuntimeRegistry(
    createBuiltinWebhookDeliveryProfileAdapters(webhookClockAuthority),
  );
  // D-179 — a recipe's install config lives on its `is_default` dish. ONE
  // construction, shared by the webhook RUNNER's execute merge and the webhook
  // DOOR's capability derivation below, so the closure the owner's door grants
  // is derived from the exact config the run will use (the same bind-vs-run
  // rule `wire-reception-substrate.ts` pins for the reception door).
  const resolveWebhookInstallConfig = composeInstallConfigResolver(
    execution.executeDeps.dishStore,
  );
  const resolveWebhookDoorRecipe = composeDoorRecipeResolver(execution.executeDeps);
  const resolveWebhookRecipeOp = composeRecipeOpResolver(execution.executeDeps);

  // D-209 #1 W2b — the webhook DOOR substrate: what `recipe.save` /
  // `packs.install` mint a webhook-declaring recipe's derived door with, and
  // what `packs.uninstall` retires them against. The contract stores are the
  // SAME instances the Gateway reads its verdicts from (threaded down from
  // the execution context, never rebuilt here) — a grant the mint writes must
  // be a grant the gate can see. Absent on partial harnesses ⇒ no door mints
  // and the dispatch path stays fail-closed at the contract floor.
  /** § 234.4p.16d — `packs.install` deps that can actually PROVISION a
   *  `composition` content, hoisted so every caller shares ONE definition.
   *
   *  ⛔⛔ THE BUG THIS EXISTS TO CLOSE. `canProvisionComposition`
   *  (`pack-install-handler.ts:664`) requires `contractStore &&
   *  localManifestStore && registry`. The bare `rpc.packInstallDeps`
   *  (`wire-pack-install-rpc-deps.ts`) carries only the first, so any caller
   *  handed that slice DEFERS its composition — silently, because the install
   *  still returns `ok: true` with `installed: []` and a populated
   *  `deferred_contents`. The ws rpc registration below used to add the missing
   *  two INLINE, which meant the one caller that did not go through that literal
   *  — `installGeneratedPack` — never provisioned anything: a generated MCP pack
   *  reported `operations: N` and put nothing in the installed-pack inventory,
   *  so Tier-P resolution said `pack_not_installed` and the raw-op door catalog
   *  surfaced zero ops (driven three ways in `dev/mcp-two-roads-drive.ts`).
   *
   *  🔑 HOISTED RATHER THAN COPIED, and that IS the fix: the enrichment living
   *  inside one object literal is exactly what let a second caller be built
   *  without it. A shared const cannot be forgotten by the next one. */
  const packInstallDepsWithComposition = rpc.packInstallDeps
    ? {
        ...rpc.packInstallDeps,
        ...(app.contractStoreRef
          ? {
              localManifestStore: storage.localManifestStore,
              registry: execution.executorConfig.manifests,
            }
          : {}),
        // ⛔⛔ AND THE PROFILE RECONCILER, for the SAME reason and found the same
        // way. Provisioning the composition is not enough to make its ops
        // dispatchable: the D-165 gateway admits on
        // `source.allowed_operations`, which is DERIVED from granted operation
        // GROUPS (`deriveAllowedOperations` over the `contract.grant` store) and
        // only (re)seeded when the connection's operation profile is
        // reconciled. Without this, a freshly installed pack's ops resolve and
        // then deny `operation_not_granted` forever — grants recorded, profile
        // never re-derived. Chased down from that exact deny reason.
        ...(execution.reconcileConnectionProfile
          ? { reconcileConnectionProfile: execution.reconcileConnectionProfile }
          : {}),
      }
    : undefined;


  /** § 234.4p.16d + D-225 auto-mint — the GENERATED-PACK SEAM: everything a
   *  caller needs to probe an mcp connection, turn its `tools/list` into an
   *  installed pack, look that pack up, and tear it down — in ONE place.
   *
   *  ⛔⛔ HOISTED FOR THE REASON `packInstallDepsWithComposition` ABOVE WAS.
   *  That defect was a second caller built without a field that lived inside one
   *  object literal, and it reported success while installing nothing. This is
   *  the same shape one level up: auto-mint runs from the connection rpc AND
   *  from the `mcp-pack-first-mint` housekeeping sweep, which is composed
   *  elsewhere entirely. Spreading these fields at that second site would
   *  reproduce the bug exactly — a sweep that probes, mints, and provisions
   *  nothing. A shared const cannot be forgotten by the next consumer.
   *
   *  🔑 The probe seams (`getEncryptionKey` / `wsConnect` / `spawnStdioMcp`) ride
   *  along for the same reason `mcpToolsDriftProbeDeps` reuses them: the idle
   *  mint and the owner's manual Save must be the SAME probe, or a connection
   *  behaves one way when the owner looks and another when nobody does. */
  const connectionGeneratedPackDeps = {
    ...(app.keys && app.keys.state() !== 'uninitialized'
      ? { getEncryptionKey: app.keys.keyProvider('connection') }
      : {}),
    // Manual MCP probes use the exact Node transport capabilities already
    // composed for live recipe execution. Reusing these seams keeps websocket
    // auth/redirect handling and stdio shell/env hardening identical between
    // "Probe" and a real MCP call.
    ...(execution.executorConfig.connectionMcp?.wsConnect
      ? { wsConnect: execution.executorConfig.connectionMcp.wsConnect }
      : {}),
    ...(execution.executorConfig.connectionMcp?.spawnStdioMcp
      ? { spawnStdioMcp: execution.executorConfig.connectionMcp.spawnStdioMcp }
      : {}),
    // D-225 Slice 2 — the Save of the MCP enrollment chain, and (since
    // auto-mint) of the enroll itself. Supplied as a closure so the connection
    // handler needs one verb rather than the whole install dep surface; absent
    // (dbless / partial harness) ⇒ `mcpPackCommit` refuses instead of
    // half-succeeding, and `firstMintGeneratedPack` skips.
    ...(packInstallDepsWithComposition
      ? {
          installGeneratedPack: async (
            manifest: unknown,
            install_scope?: unknown,
          ): Promise<void> => {
            // The generated publisher is VERIFIED here, not taken from
            // the manifest: the runtime authored this derivation, and
            // nothing on the wire chose the handle.
            //
            // ⛔ § 234.4p.16d — the COMPOSITION-CAPABLE deps, not the
            // bare slice. A generated pack's ONLY content is a
            // `composition`, so on the bare slice this install deferred
            // it and wrote no inventory row while still returning
            // `ok: true`.
            const installed = await handlePacksInstall(
              packInstallDepsWithComposition,
              {
                manifest,
                // ⛔⛔ MANDATORY — `parsePacksInstallArgs` rejects
                // `packs.install` outright unless this is an ARRAY, so
                // omitting it made this whole closure throw on every
                // call and slice 3 was inert until a Codex review found
                // it. `[]` is the correct value, not a placeholder: the
                // checker seeds `granted` with BULK_PACK_INSTALL_PERMISSION
                // itself, and that is the only thing a generated pack's
                // `requires` carries (see `mcp-pack.ts` — it is what the
                // install is authorized BY, not a capability the pack
                // requests). A generated pack asks for no capabilities,
                // so granting none is both correct and fail-closed: if a
                // future generated pack ever declares a real requirement,
                // this install fails LOUDLY with `permission_denied`
                // naming it, rather than silently self-granting.
                granted_permissions: [],
                // D-228 slice 3 — spread only when chosen, so an absent
                // selection stays ABSENT rather than becoming an
                // explicit `undefined` the parser might read differently
                // from "not supplied".
                //
                // ⛔ The cast is NARROWED to this one field on purpose.
                // It used to wrap the WHOLE object (`{...} as
                // Parameters<...>[1]`), which suppressed the missing
                // `granted_permissions` above — a whole-object cast
                // silences the very check that would have caught it.
                // Only `install_scope` genuinely needs one (it arrives
                // as `unknown` from the connection handler); `manifest`
                // is typed `unknown` by the callee and needs none.
                ...(install_scope !== undefined
                  ? {
                      install_scope: install_scope as Parameters<
                        typeof handlePacksInstall
                      >[1]['install_scope'],
                    }
                  : {}),
              },
              GENERATED_PACK_PUBLISHER,
            );
            // ⛔⛔ § 234.4p.16d — READ THE RESULT. This closure used to
            // be `Promise<void>` over a discarded return, and that is
            // what made the first defect invisible: `handlePacksInstall`
            // reports `ok: true` with `installed: []` when it DEFERS a
            // composition, so `mcpPackCommit` answered `operations: N`
            // for a pack that had installed nothing. A deferred
            // composition is a FAILED generated-pack install — the
            // composition IS the pack — so it must refuse loudly rather
            // than hand back a success the inventory cannot honour.
            const deferred = installed.result.deferred_contents ?? [];
            if (!installed.result.ok) {
              throw new Error(
                `generated pack install failed: ${JSON.stringify(installed.result.failure ?? null)}`,
              );
            }
            if (deferred.length > 0) {
              throw new Error(
                'generated pack install deferred its composition '
                + `(${String(deferred.length)} content(s)) — the pack would report installed `
                + 'while its operations reach no catalog. This means the install deps could '
                + 'not provision a composition (contractStore + localManifestStore + registry).',
              );
            }
          },
        }
      : {}),
    // D-225 Slice 2 — destroy, direction 1: deleting an MCP connection
    // tears down the pack it minted. ⛔ The deps handed to the uninstall
    // OMIT `removeGeneratedPackConnection`, so the reverse cascade
    // cannot fire back into the connection delete that is already
    // running — the cycle is broken by ABSENCE, not by a flag.
    ...(rpc.packUninstallDeps
      ? {
          teardownGeneratedPack: async (packSlug: string): Promise<void> => {
            await handlePacksUninstall(
              rpc.packUninstallDeps!,
              { pack_slug: packSlug } as Parameters<typeof handlePacksUninstall>[1],
            );
            // ⛔ And the owner's per-op rulings, which pack uninstall
            // deliberately does NOT purge (correct for a marketplace
            // pack; wrong here, where the slug is derived-stable and a
            // re-enrolled connection would silently re-adopt them).
            if (rpc.packUninstallDeps!.contractStore) {
              removePackOwnerRulings(rpc.packUninstallDeps!.contractStore, [packSlug]);
            }
          },
        }
      : {}),
    // D-225 Slice 2 — the drift badge's manifest lookup. Reuses the
    // SAME registry the install path registers into, so the badge reads
    // the pack that is actually live rather than a second view of it.
    // ⛔ § 234.4p.16d — off the COMPOSITION-CAPABLE deps. `registry` is
    // one of the two fields the bare slice never carried, so this read
    // was permanently undefined and the badge silently had no catalog
    // lookup at all — the same root cause as the install itself.
    ...(packInstallDepsWithComposition?.registry
      ? {
          getInstalledCatalog: (slug: string) =>
            packInstallDepsWithComposition.registry!.get(slug),
        }
      : {}),
    // ⛔⛔ D-228 slice 3 — carry the owner's existing per-tool `read`
    // classification onto the freshly minted pack ops. WITHOUT THIS the chat
    // swap is a regression wearing a security improvement: every generated op is
    // `write` + `ask` by construction, so a tool the owner had already
    // classified `read` (and which dispatched with no prompt through Tier-3)
    // would start asking on every call.
    //
    // ⚠ Lazy store construction, for the D-164 trust-store reason
    // `connection-mcp-gate.ts` documents: the annotation schema is ensured by
    // the chat substrate, which composes AFTER this, so an eager `db.prepare`
    // here would crash a fresh-db boot. `ensure…` is idempotent.
    ...(app.contractStoreRef && packInstallDepsWithComposition?.registry && storage.db
      ? {
          carryMcpToolClassifications: (input: {
            connection_name: string;
            pack_slug: string;
          }): void => {
            ensureChatConnectionMcpAnnotationSchema(storage.db!);
            const annotations = createChatConnectionMcpStore(storage.db!);
            carryMcpToolClassifications(
              {
                contractStore: app.contractStoreRef!,
                getAnnotation: (name) => annotations.getAnnotation(name),
                getManifest: (slug) =>
                  packInstallDepsWithComposition.registry!.get(slug),
              },
              input,
            );
          },
        }
      : {}),
    // D-225 auto-mint — the loopback diff's ONLY input: what this server
    // exposes to the peer a connection points at. Both stores are the
    // SAME instances the doors gate on (threaded down, never rebuilt), so
    // "what we expose" here is what a peer actually receives rather than a
    // second view that can disagree. Absent stores ⇒ the closure is not
    // supplied ⇒ no subtraction (see the dep's own doc for why that
    // direction is the safe one).
    ...(execution.grantEntryStore || app.chatInboundTokenStoreRef
      ? {
          exposedToolNamesForPeerContract: (contract_id: string) =>
            exposedToolNamesForPeerContract(
              {
                ...(execution.grantEntryStore
                  ? { grantEntryStore: execution.grantEntryStore }
                  : {}),
                ...(app.chatInboundTokenStoreRef
                  ? { inboundTokenStore: app.chatInboundTokenStoreRef }
                  : {}),
              },
              contract_id,
            ),
        }
      : {}),
  };

  /** D-225 auto-mint — the `mcp-pack-first-mint` sweep's deps, built HERE off the
   *  hoisted seam above rather than in the post-listener wire.
   *
   *  ⛔⛔ THE PLACEMENT IS THE POINT, and it is § 234.4p.16d's lesson applied
   *  before it can bite again. The natural home would be beside
   *  `mcpToolsDriftProbeDeps` in `start-post-listener-runtime.ts` — which builds
   *  its own probe slice from first principles. Doing that here would mean
   *  re-deriving `installGeneratedPack` at a site that has no
   *  `packInstallDepsWithComposition`, and a mint on a bare install slice DEFERS
   *  its composition while reporting `ok: true`. The sweep would run every idle
   *  cycle, report mints, and provision nothing. So the deps are assembled where
   *  the composition-capable seam already exists and travel to housekeeping as a
   *  bound closure.
   *
   *  ⚠ `store` is added here rather than living in the seam: it is a single ref,
   *  not a composed slice, so there is nothing about it to get subtly wrong. */
  const mcpPackFirstMintDeps: McpPackFirstMintDeps | undefined =
    app.connectionStoreRef !== undefined
      ? {
          listConnections: (query) => app.connectionStoreRef!.list(query),
          firstMint: (connection) => firstMintGeneratedPack(
            { store: app.connectionStoreRef!, ...connectionGeneratedPackDeps },
            connection,
          ),
        }
      : undefined;

  const webhookDoorDeps: WebhookDoorEnrollDeps | undefined =
    execution.contractDefinitionStore !== undefined
      && execution.grantEntryStore !== undefined
      && app.webhookConsumerStoreRef !== undefined
      ? {
          definitionStore: execution.contractDefinitionStore,
          grantEntryStore: execution.grantEntryStore,
          consumerStore: app.webhookConsumerStoreRef,
          now: () => Date.now(),
          resolveConfig: resolveWebhookInstallConfig,
          resolveDoorRecipe: resolveWebhookDoorRecipe,
          preflightNonOwnerRecipeExposure: (recipe) =>
            assertRecordsNonOwnerRecipeExposure(
              recipe,
              'webhook',
              {
                isOperationId: (operationId) =>
                  storage.recordsStore.isInstalledOperationId(operationId),
                isCatalogOperation: (catalogSlug, operationKey) =>
                  storage.recordsStore.isInstalledCatalogOperation(catalogSlug, operationKey),
              },
            ),
          ...(resolveWebhookRecipeOp ? { resolveOp: resolveWebhookRecipeOp } : {}),
        }
      : undefined;

  const webhookRuntimeComposable = app.webhookIngressStoreRef !== undefined
    && app.webhookDeliveryStoreRef !== undefined
    && app.webhookConsumerStoreRef !== undefined
    && storage.auditLog !== undefined;
  const webhookOutboxRuntime = webhookRuntimeComposable
    ? createWebhookOutboxRuntime(
        app.webhookDeliveryStoreRef!,
        createWebhookRecipeOutboxSink(
          app.webhookConsumerStoreRef!,
          createExecuteWebhookRecipeRunner({
            executeDeps: execution.executeDeps,
            auditLog: storage.auditLog!,
            // D-179 — the runner must pass the install config explicitly
            // because its idempotency `run_id` suppresses `handleExecute`'s
            // dish merge (see `ExecuteWebhookRecipeRunnerDeps.resolveConfig`).
            resolveConfig: resolveWebhookInstallConfig,
            resolveDoorRecipe: resolveWebhookDoorRecipe,
            ...(resolveWebhookRecipeOp ? { resolveOp: resolveWebhookRecipeOp } : {}),
            // D-209 #1 W3 — the door snapshot resolves from the SAME store the
            // Gateway reads (a grant the mint wrote must be a grant the gate can
            // see). A partial harness without one resolves every stamped door
            // DEAD (empty allowlist → denies) — fail-closed, never fail-open.
            definitionStore:
              execution.contractDefinitionStore ?? { get: () => null },
          }),
        ),
        {
          reconcileWaitingDispatches: async () => {
            await reconcileWebhookAwaitingApprovalDispatches(
              app.webhookConsumerStoreRef!,
              storage.auditLog!,
            );
          },
          canDispatch: () => app.isVaultUnlocked()
            && !(app.serverState?.isPaused() ?? false),
          log: (level, message, metadata) => {
            const sink = level === 'error' ? console.error : console.warn;
            sink(`[webhook-outbox] ${message}`, metadata);
          },
        },
      )
    : undefined;

  const webhookPublicReachabilityEnabled = (): boolean => {
    const raw = process.env.RECUED_PUBLIC_REACHABLE;
    return raw === 'true' || raw === '1';
  };
  const webhookPublicBaseUrl = (): string | null => {
    const base = resolvePublicBaseUrl(process.env.RECUED_PUBLIC_BASE_URL);
    if (base === null) return null;
    try {
      const parsed = new URL(base);
      if (parsed.protocol !== 'https:'
        || parsed.username.length > 0
        || parsed.password.length > 0
        || base.includes('?')
        || base.includes('#')
        || parsed.search.length > 0
        || parsed.hash.length > 0) {
        return null;
      }
      // A path prefix is allowed for an operator-owned reverse proxy, but the
      // projected vendor URL must never inherit URL credentials/query/fragment.
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
      return parsed.href.replace(/\/+$/, '');
    } catch {
      return null;
    }
  };
  const webhookEndpointUrl = (publicId: string): string | null => {
    const base = webhookPublicBaseUrl();
    if (base === null) return null;
    const endpoint = `${base}/v1/webhooks/${publicId}`;
    return Buffer.byteLength(endpoint, 'utf8') <= 4_096 ? endpoint : null;
  };
  // D-201 Slice 6B3 — operation-bound provider calls resolve the same durable
  // owner binding as inbound dispatch, then inject the callback only inside the
  // final trusted catalog dispatch. The reserved first-party fixture adapter
  // proves both attach and detach; any other profile/catalog/operation tuple
  // fails closed until trusted code is registered.
  if (app.webhookIngressStoreRef && app.webhookConsumerStoreRef) {
    execution.executeDeps.operationBoundWebhook = createWebhookOperationBindingResolver({
      ingressStore: app.webhookIngressStoreRef,
      consumerStore: app.webhookConsumerStoreRef,
      adapters: createWebhookCallbackBindingRuntimeRegistry(
        createOperationBoundWebhookFixtureAdapters(),
      ),
      resolveCanonicalEndpoint: (ingress) => webhookEndpointUrl(ingress.public_id),
    });
  }
  const webhookPublicExposureEnabled = async (): Promise<boolean> => {
    try {
      const machine = exposureDeps?.getMachine();
      return machine !== undefined
        && (await machine.current()).resolution.webhooks.public;
    } catch {
      return false;
    }
  };
  const webhookPublicListenerBound = (): boolean => {
    try {
      return listenerCoordinator.status().some(
        (status) => status.listener === 'public' && status.listening,
      );
    } catch {
      return false;
    }
  };
  const webhookTestDelivery = app.webhookIngressStoreRef !== undefined
    && app.webhookDeliveryStoreRef !== undefined
    ? createWebhookTestDeliveryService({
        ingressStore: app.webhookIngressStoreRef,
        deliveryStore: app.webhookDeliveryStoreRef,
        profiles: webhookProfiles,
      })
    : undefined;
  const webhookProfileListener = webhookPort > 0
    && webhookOutboxRuntime !== undefined
    && app.webhookIngressStoreRef !== undefined
    && app.webhookDeliveryStoreRef !== undefined
    ? createWebhookProfileListener({
        ingressStore: app.webhookIngressStoreRef,
        deliveryStore: app.webhookDeliveryStoreRef,
        profiles: webhookProfiles,
        isOutboxDispatcherStarted: webhookOutboxRuntime.isStarted,
        ...(app.serverState
          ? { isPaused: (): boolean => app.serverState!.isPaused() }
          : {}),
        isIntakeReachable: async () => app.isVaultUnlocked()
          && webhookPublicBaseUrl() !== null
          && webhookPublicReachabilityEnabled()
          && webhookPublicListenerBound()
          && await webhookPublicExposureEnabled(),
        resolveCanonicalPublicUrl: ({ ingress }) =>
          webhookPublicReachabilityEnabled()
            ? webhookEndpointUrl(ingress.public_id)
            : null,
        onHandshakeReadinessProven: (ingressId) => {
          app.webhookIngressStoreRef!.confirmHandshakeReadiness(ingressId);
        },
        log: (level, message, metadata) => {
          const sink = level === 'error' ? console.error : console.warn;
          sink(`[webhook-profile] ${message}`, metadata);
        },
      })
    : undefined;

  const webhookRuntimeReadiness = async (
    ingress: import('@recued/contracts').WebhookIngressRecord,
    profile: import('@recued/contracts').WebhookProfileDescriptor,
  ) => {
    const endpointUrl = webhookEndpointUrl(ingress.public_id);
    const endpointTransportReady = endpointUrl !== null
      && BUILTIN_WEBHOOK_PROFILE_POLICIES.get(profile.profile_id)
        .endpointSupported(endpointUrl);
    // An unavailable exposure authority is a closed listener, never an
    // invitation to infer reachability from the URL alone.
    const webhookPublicExposed = await webhookPublicExposureEnabled();
    const publicListenerBound = webhookPublicListenerBound();
    let clockReady = true;
    if (profile.mechanism_kind === 'timestamped_hmac') {
      try {
        clockReady = webhookClockAuthority !== null
          && (await webhookClockAuthority.check()).healthy;
      } catch {
        clockReady = false;
      }
    }
    const pairedConnectionRequired = webhookProfileRequiresPairedConnection(
      profile,
      ingress.registration_mode,
    );
    return {
      endpoint_url: endpointUrl,
      profile_runtime_available: webhookProfiles.get(profile.profile_id) !== null,
      paired_connection_available: !pairedConnectionRequired
        || (ingress.paired_connection_id !== null
          && (app.connectionStoreRef?.get('api', ingress.paired_connection_id) ?? null) !== null),
      listener_available: webhookProfileListener !== undefined
        && (webhookOutboxRuntime?.isStarted() ?? false)
        && publicListenerBound,
      public_reachability_enabled: webhookPublicReachabilityEnabled()
        && webhookPublicExposed,
      tls_ready: endpointTransportReady,
      clock_ready: clockReady,
      test_delivery_supported: ingress.environment === 'test'
        && (webhookTestDelivery?.supports(profile.profile_id) ?? false),
      vault_unlocked: app.isVaultUnlocked(),
      server_unpaused: !(app.serverState?.isPaused() ?? false),
    };
  };

  // D-201 Slice 8J — managed registration stays a separate trusted preset
  // registry from delivery admission. Generic composition does not select a
  // vendor, connection shape, endpoint lifecycle, or ownership rule itself.
  const webhookRegistrationRuntime = app.webhookIngressStoreRef
    && app.connectionStoreRef
    && app.keys
    ? createBuiltinWebhookRegistrationProfileRegistry({
        connectionStore: app.connectionStoreRef,
        ingressStore: app.webhookIngressStoreRef,
        connectionKeyProvider: app.keys.keyProvider('connection'),
      })
    : null;
  const webhookManagedRegistration = app.webhookIngressStoreRef
    && webhookRegistrationRuntime
    ? createWebhookManagedRegistrationService({
        store: app.webhookIngressStoreRef,
        adapters: webhookRegistrationRuntime,
        profilePolicies: BUILTIN_WEBHOOK_PROFILE_POLICIES,
        resolveCanonicalEndpoint: (ingress) =>
          webhookEndpointUrl(ingress.public_id),
      })
    : undefined;
  const webhookProfileCapabilities = Object.freeze(webhookProfiles.list().map((adapter) => {
    const descriptor = webhookProfile(adapter.profile_id);
    if (!descriptor) {
      throw new Error(`webhook profile capability: unknown profile '${adapter.profile_id}'`);
    }
    return Object.freeze({
      profile_id: adapter.profile_id,
      registration_modes: Object.freeze(descriptor.registration_modes.filter((mode) =>
        mode !== 'managed_endpoint'
          || (webhookRegistrationRuntime !== null
            && webhookRegistrationRuntime.get(adapter.profile_id) !== null))),
      deduplication: Object.freeze({
        ...descriptor.deduplication,
        identity: Object.freeze({ ...descriptor.deduplication.identity }),
      }),
    });
  }));

  // D-152 § A.16 — load the webclient bundle from disk (the production wiring
  // the substrate deferred). The release tarball extracts to
  // `<data-volume>/webclient/` (a CAS-root sibling, same convention as the
  // messenger media scratch dir above); `RECUED_WEBCLIENT_DIR` overrides for
  // non-standard layouts; and in a SOURCE CHECKOUT `apps/webclient/build` is
  // picked up automatically (`resolveServedWebclientBundleDir`) so a dev serve
  // needs no env var. Serving is grid-gated per listener — R26.2 Delta 3 made
  // `/webclient` a first-class path role (`resolution.webclient`, LAN-on /
  // public-off by default), so this is no longer the D-152 LAN-only carve-out;
  // public serving is an owner opt-in on the exposure grid. Outcomes:
  //   - no dir / no manifest → `null`, mount stays dormant (the common case:
  //     the webclient is primarily served from app.recued.com).
  //   - manifest present-but-untrusted (unreadable / malformed / wrong shape),
  //     OR sha / one-to-one drift → logged `webclient_bundle_unverified`,
  //     mount stays dormant (a tampered or partial bundle never serves).
  //   - verified bundle → passed to `createServerHandlerSet`.
  // We verify HERE with the same contract validator the handler factory uses,
  // rather than letting the factory throw mid-construction: a bad bundle is
  // dropped BEFORE the call, so `createServerHandlerSet` runs exactly once on
  // every path. The loader already re-hashed each file from disk into its
  // `sha256` slot, so this `verifyWebclientBundle` pass compares real bytes
  // against the shipped manifest.
  const webclientBundleDir = resolveServedWebclientBundleDir(
    app.cacheBlobs?.root,
    process.env.RECUED_WEBCLIENT_DIR,
  );
  let webclientBundle: { files: ReadonlyArray<WebclientBundleFile> } | undefined;
  if (webclientBundleDir) {
    try {
      const loaded = await loadWebclientBundleFromDisk(webclientBundleDir);
      if (loaded) {
        const verified = verifyWebclientBundle(loaded.manifest, loaded.files);
        if (verified.ok) {
          webclientBundle = { files: loaded.files };
        } else {
          console.warn(
            `[webclient] webclient_bundle_unverified: ${verified.issues
              .map((i) => i.code)
              .join(',')} (dir=${webclientBundleDir}) — not mounting /webclient`,
          );
        }
      }
    } catch (err) {
      // Present-but-untrusted manifest (unreadable / malformed / wrong shape) —
      // distinct from "absent" (→ null above). Warn loudly, stay dormant.
      if (err instanceof WebclientBundleLoadError) {
        console.warn(
          `[webclient] webclient_bundle_unverified: ${err.reason} (dir=${webclientBundleDir}) — not mounting /webclient`,
        );
      } else {
        throw err;
      }
    }
  }

  const savedDataViewStore = createSavedDataViewStore(storage.db, {
    ...(storage.workEntityStoreRef && execution.notificationBlock && storage.auditLog
      ? { readTasks: createSavedTaskViewReader(storage.workEntityStoreRef) } : {}),
    ...(execution.notificationBlock && storage.auditLog
      ? { readRecords: createSavedRecordsViewReader(storage.recordsStore) } : {}),
  });
  const savedDataViewAlerts = execution.notificationBlock && storage.auditLog
    ? createSavedDataViewAlertRuntime({ store: savedDataViewStore.alerts, auditLog: storage.auditLog,
      notifier: execution.notificationBlock,
      publicBaseUrl: resolvePublicBaseUrl(process.env.RECUED_PUBLIC_BASE_URL) ?? undefined,
    }) : undefined;

  // D-174 #22 + slice 1 — built ONCE, used TWICE: the `work_entity.{upsert,
  // delete}` pair-RPC below and the Tier-1 `work.create` chat tool both
  // dispatch through this object.
  //
  // ⛔ HOISTED RATHER THAN BUILT TWICE ON PURPOSE. Re-deriving it for the chat
  // path would mint a SECOND `createWorkEntityResolver` over the same store —
  // two readers with independently-cached freshness, and a chat create landing
  // through a different instance than the click that the owner can see. One
  // object keeps the warehouse events, the enrichment cascade and the audit
  // trail identical whichever surface asked.
  const workEntityCrudDepsShared =
    storage.workEntityStoreRef && collection.workEntityDispatchers
      ? {
          store: storage.workEntityStoreRef,
          // D-192 read resolution — the sync-state dep lights up the
          // resolver's `sourceFreshness`, so `work_entity.{list,get}`
          // responses carry per-Source freshness metadata.
          resolver: createWorkEntityResolver(
            storage.workEntityStoreRef,
            app.workEntitySourceSyncStateRef !== undefined
              ? { syncState: app.workEntitySourceSyncStateRef }
              : {},
          ),
          dispatchers: collection.workEntityDispatchers,
          // D-192 P5 — `get` responses carry the row's work-graph
          // edges; contact edges forward-resolve to the survivor's
          // display identity at read time.
          ...(app.workEntityEdgeStoreRef !== undefined
            ? { edges: app.workEntityEdgeStoreRef }
            : {}),
          ...(app.contactStoreRef !== undefined
            ? { contactDisplay: app.contactStoreRef }
            : {}),
        }
      : undefined;
  // Publish for the chat tool. Set BEFORE the handler set is built so no
  // ordering question exists between the two consumers.
  app.workEntityCrudDepsRef.current = workEntityCrudDepsShared ?? null;
  // Slice 2 — publish the SAME calendar dispatchers the recipe step and the
  // reception booking seam use, so a chat mutation is not a third path into the
  // provider with its own mirroring behaviour.
  app.calendarWriteDepsRef.current = collection.calendarStack
    ? {
        calendarCreate: collection.calendarStack.kernelDispatchers.calendarCreate,
        calendarUpdate: collection.calendarStack.kernelDispatchers.calendarUpdate,
      } as never
    : null;

  const serverHandlerSet = createServerHandlerSet({
    ...(preapproval ? { preapprovalDeps: preapproval.handlers } : {}),
    ...(webclientBundle ? { webclientBundle } : {}),
    executeDeps: execution.executeDeps,
    pairing: storage.pairing,
    // Slice 3b — first-boot server-vault enrollment at /auth/pair. Both
    // are live: `app.keys` is the KeyManager; the keyStore getter reads
    // the (lazily-booted) signing identity at call time.
    ...(app.keys ? { keys: app.keys } : {}),
    ...(app.keys ? { database: storage.db } : {}),
    getServerKeyStore: () => storage.signingIdentity?.keyStore,
    // Schedule-creation pack refusal. Augmented HERE rather than where
    // `scheduleDeps` is built: the maintenance composer holds neither the
    // contract store nor the manifest registry, and threading both through it
    // to reach one predicate would widen a deliberately narrow context.
    //
    // ⚠ Only the pack dep is added — `recipeStore` is left off on purpose. It
    // would switch on the dormant existence check as a side effect, and that
    // dormancy is documented as deliberate for the legacy UI path.
    scheduleDeps: scheduleDeps && contractStore
      ? {
          ...scheduleDeps,
          missingPackDepsForRecipe: (recipe_id: string) => {
            const recipe = storage.recipeStore.get(recipe_id);
            if (recipe === null) return [];
            return missingPackDependencies(
              recipe,
              buildPackOpResolution(
                () => contractStore.scan('installed_pack', []),
                (slug: string) => execution.executorConfig.manifests.get(slug),
              ),
            );
          },
        }
      : scheduleDeps,
    ...(dishDeps ? { dishDeps } : {}),
    ...(eventTriggersBundle
      ? { triggersDeps: eventTriggersBundle.triggersDeps }
      : {}),
    // "Watch this element" — scaffold + save a local notify recipe; the
    // reconciler (above, on recipeStore.setOnMutated) materializes the watch
    // trigger DISARMED (the user arms it in #automation — D-179 P5c). Gated
    // on the event-trigger bundle being present: without the reconciler a
    // saved recipe would never materialize a trigger row at all.
    ...(eventTriggersBundle
      ? { elementWatchDeps: { recipeStore: execution.executeDeps.recipeStore } }
      : {}),
    ...(rpc.autoRunDeps ? { autoRunDeps: { ...rpc.autoRunDeps,
      ...(preapproval ? { preapprovalStatus: preapproval.autoRunStatus } : {}),
    } } : {}),
    ...(watchBundle ? { watchDeps: watchBundle.watchDeps } : {}),
    // Scope-B (D-108/D-109) — the live `server.archive.*` runtime,
    // assembled upstream (start-lifecycle-recovery-pre-listener-runtime)
    // where the restart-drain lifecycle + db + version + exit coexist.
    ...(archiveDeps ? { archiveDeps } : {}),
    // D-172 resumable uploads — wire the webclient upload service (built in
    // compose-collection-context where the CAS + file collection are born) so
    // the `upload.*` rpc + the binary `/ws/upload` socket dispatch. Absent on a
    // db-less / no-CAS boot ⇒ the rpc 501s + `/ws/upload` 503-closes.
    ...(collection.uploadService
      ? { uploadDeps: { service: collection.uploadService } }
      : {}),
    // M4 archive download — the binary `/ws/download` socket streams a finished
    // export off disk. Built alongside the upload service (data dir lives there);
    // absent on a db-less boot ⇒ `/ws/download` 503-closes.
    ...(collection.downloadService
      ? { downloadDeps: { service: collection.downloadService } }
      : {}),
    // M4b.1 archive upload (no-SSH migrate) — the binary `/ws/archive-upload`
    // socket lands a resumable upload + STAGES it under `exports/` for
    // `server.archive.import`. Db-gated like the download service; absent on a
    // db-less boot ⇒ the rpc 501s + `/ws/archive-upload` 503-closes.
    ...(collection.archiveUploadService
      ? { archiveUploadDeps: { service: collection.archiveUploadService } }
      : {}),
    cacheDeps: app.cacheDeps,
    sharedDeps: app.sharedDeps,
    authDeps: app.authDeps,
    migrateDeps,
    llmConfigManager: app.llmManager,
    llmProbe: {
      adapters: app.llmAdapterRegistry,
      quota: app.llmQuota,
      embeddingsAdapters: app.llmEmbeddingsAdapterRegistry,
      // D-262 § B7 — the SAME registry the runtime transcribes with, so the
      // Test button proves the path that will actually run.
      transcriptionAdapters: app.llmTranscriptionAdapterRegistry,
    },
    sellerStore: app.sellerStoreRef,
    sellerOrderStore: app.sellerOrderStoreRef,
    ...(app.webhookIngressStoreRef
      ? {
          webhookIngressDeps: {
            store: app.webhookIngressStoreRef,
            profileCapabilities: webhookProfileCapabilities,
            profilePolicies: BUILTIN_WEBHOOK_PROFILE_POLICIES,
            ...(app.webhookDeliveryStoreRef
              ? { deliveryStore: app.webhookDeliveryStoreRef }
              : {}),
            ...(app.webhookConsumerStoreRef
              ? {
                  countConsumerBindings: (ingressId: string): number =>
                    app.webhookConsumerStoreRef!.listBindings()
                      .filter((binding) => binding.ingress_id === ingressId).length,
                }
              : {}),
            ...(webhookTestDelivery ? { testDelivery: webhookTestDelivery } : {}),
            ...(webhookManagedRegistration
              ? { managedRegistration: webhookManagedRegistration }
              : {}),
            ...(app.connectionStoreRef
              ? {
                  pairedConnectionAvailable: (pairedConnectionId: string): boolean =>
                    app.connectionStoreRef!.get('api', pairedConnectionId) !== null,
                }
              : {}),
            runtimeReadiness: webhookRuntimeReadiness,
          },
        }
      : {}),
    sellerContractStore: app.contractStoreRef,
    sellerInboundTokenStore: app.chatInboundTokenStoreRef,
    sellerClaimStore: app.sellerClaimStoreRef,
    runtimeConfig,
    bootstrapDeps,
    serverId: storage.serverInstanceId,
    pairedInstances: storage.pairedInstances,
    ...(storage.auditLog ? { pairRevokeAuditLog: storage.auditLog } : {}),
    // D-175 P5 — recued.com account binding pair-RPC. The manager is
    // built in compose-storage-context against the booted signing
    // identity (proof + binding-credential storage) + the signed audit
    // sink; forward it as the handler dep.
    accountBindingDeps: { manager: storage.accountBindingManager },
    // D-175 P8 — Pro convenience status pair-RPC. The provisioner reads
    // the binding (secret-free) + gates on the Pro entitlement seam
    // (pending until the cloud entitlement-mint endpoint lands).
    proConvenienceDeps: { provisioner: storage.proConvenienceProvisioner },
    // R27 delta-B — DDNS pause/resume pair-RPC. The deps (local publish flag +
    // handle-state target + lazily-bound cloud-pause client) are built in
    // compose-storage-context against the booted signing identity.
    ddnsDeps: storage.ddnsHandlerDeps,
    // Supervision feature — owner-only `supervision.*` (cli-daemon keep-alive).
    // The stack (store + supervisor + getManifest) is composed in
    // compose-collection-context; absent on a db-less boot.
    supervisionDeps: collection.supervisionStack?.rpcDeps,
    // D-178 — owner-only release update-check. The trusted release pubkey is
    // empty pre-GA, so this resolves to `not-configured` until the signing
    // identity is wired (slice 3+); undefined on an unsupported platform.
    ...(releaseCheckDeps
      ? {
          updateDeps: {
            releaseCheckDeps,
            modeDeps: updateModeDeps,
            ...(updateApplyDeps ? { applyDeps: updateApplyDeps } : {}),
            // D-257 — `update.apply` returns `applying` and the outcome comes
            // back on the bus. WITHOUT THIS WIRE the rpc answers immediately and
            // nothing ever reports the result, which is worse than the
            // 30s-timeout bug it replaces: the UI would sit on "applying"
            // forever. Same emit seam the contract handler uses.
            broadcast: (event) => rpc.observabilityBundle.eventsDeps.bus.emit(event),
          },
        }
      : {}),
    recoveryKeyCheck: storage.recoveryKeyCheck,
    // The WS enrollment twin gets the SAME encryption handles as the HTTP
    // `/auth/pair` door above. It previously got only the check store, so
    // enrolling over WS opened the gate on a plaintext database.
    ...(app.keys
      ? {
          recoveryVaultDeps: {
            keys: app.keys,
            database: storage.db,
            getServerKeyStore: () => storage.signingIdentity?.keyStore,
          },
        }
      : {}),
    ...(clientTokens ? { clientTokens } : {}),
    pressureDeps,
    oauthClientConfigDeps: collection.oauthClientConfigDeps,
    ...(collection.oauthAppConfigDeps
      ? { oauthAppConfigDeps: collection.oauthAppConfigDeps }
      : {}),
    lifecycleHandlers: lifecycle?.handlerSlice,
    lifecycleState: lifecycle ? () => lifecycle.machine.state : undefined,
    collectionDeps,
    webhookListener,
    ...(webhookProfileListener ? { webhookProfileListener } : {}),
    ...(hookListener ? { hookListener } : {}),
    ...(vendorWebhookListener ? { vendorWebhookListener } : {}),
    ...(connectionWebhookListener ? { connectionWebhookListener } : {}),
    watcherRpcDeps: { watcherDispatcher: collection.watcherDispatcher },
    triggerTestRpcDeps: { watcherDispatcher: collection.watcherDispatcher },
    recipeListDeps: rpc.observabilityBundle.recipeListDeps,
    recipeSaveDeps: {
      store: rpc.observabilityBundle.recipeListDeps.store,
      ...(app.webhookConsumerStoreRef
        ? { webhookConsumerStore: app.webhookConsumerStoreRef }
        : {}),
      // D-209 #1 W2b — a webhook-declaring save mints the recipe's door
      // after the cross-store save commits; status/arm read it back.
      ...(webhookDoorDeps ? { webhookDoor: webhookDoorDeps } : {}),
      // D-220 Slice A2b — arming a `form_response.accepted` trigger onto a LIVE
      // form whose fields contradict the recipe's `requires_form_fields` is
      // refused at save. Reads the endpoint registry directly: `include_revoked`
      // is deliberately NOT set, so a revoked form reads as absent — there is
      // nothing live to contradict, and re-creating the form is gated by A2c.
      // ⛔ Built by the SHARED factory, not an inline closure: the MCP save path
      // needs the identical reader, and a second copy is how the two save paths
      // drifted in the first place (finding 3.2).
      ...(storage.publicEndpointRegistryStoreRef
        ? {
            formDefinitionReader: createFormDefinitionReader(
              (filter) => storage.publicEndpointRegistryStoreRef!.list(filter),
              parseIntakeFormConfig,
            ),
          }
        : {}),
    },
    ...(recipeRunnabilityDeps ? { recipeRunnabilityDeps } : {}),
    approvalDeps: rpc.observabilityBundle.approvalDeps,
    ...(app.annotationDeps ? { annotationDeps: app.annotationDeps } : {}),
    ...(app.contactStoreRef
      ? { contactDeps: buildContactDeps(app.contactStoreRef, storage.recordsStore) }
      : {}),
    ...(rpc.contactMergeDeps ? { contactMergeDeps: rpc.contactMergeDeps } : {}),
    ...(app.connectionStoreRef
      ? {
          connectionDeps: {
            store: app.connectionStoreRef,
            // Owner-triggered "Suggest and guide" uses the live configured AI
            // route and shared quota, but receives only the minimized prompt
            // built by `connection-setup-guide.ts`. It never fetches the URL
            // and never writes through the connection store.
            setupGuide: {
              generate: async (prompt: string): Promise<string> => {
                const config = app.resolveLlmConfig();
                if (!config) {
                  throw new RpcError(
                    'not_configured',
                    'Set up an AI provider in Settings → AI before asking for a connection guide.',
                    503,
                    'collection.connection.suggestSetup',
                  );
                }
                const body = await executeLLM(
                  CONNECTION_SETUP_GUIDE_MANIFEST,
                  {
                    'llm.data': prompt,
                    'llm.template_type': 'connection setup guide json',
                    'llm.tone': 'clear and cautious',
                  },
                  {
                    config,
                    adapters: app.llmAdapterRegistry,
                    quota: app.llmQuota,
                    tabProbe: app.emptyTabProbe,
                    webChatSupported: false,
                    // D-250 § D — owner-triggered one-off, but it is still the owner's
                    // provider spend, so it counts toward their daily budget like every
                    // other call. Previously reported nothing at all.
                    onTokenUsage: (u) => { app.llmManager?.addUsage(u.total_tokens); },
                    timeout_ms: CONNECTION_SETUP_GUIDE_TIMEOUT_MS,
                  },
                );
                const content = (body as { content?: unknown })?.content;
                return typeof content === 'string' ? content : JSON.stringify(body);
              },
            },
            ...connectionGeneratedPackDeps,
            ...(app.enrichmentCascadeRef
              ? {
                  cascadeForConnectionDelete: (
                    kind: 'api' | 'mcp' | 'notification',
                    name: string,
                    vendor?: string,
                  ): void => {
                    app.enrichmentCascadeRef!.cascadeForConnectionDelete(
                      kind,
                      name,
                      vendor,
                    );
                  },
                }
              : {}),
            // D-192 source-data-removal — the opt-in teardown purge. Pre-bind
            // the per-Source purge stores so `handleConnectionDelete` fans the
            // hard-delete over the connection's registry Sources when the user
            // checks "also remove the mirrored data". Wired only when the whole
            // warehouse quorum is present (dbless / partial harnesses skip it —
            // the delete then leaves the mirror data in place). `auditLog`
            // records the `source_data_purged` provenance row.
            ...(storage.db &&
            storage.workEntityStoreRef &&
            app.fileMetaStoreRef &&
            app.annotationStoreRef &&
            app.enrichmentStoreRef &&
            app.workEntityEdgeStoreRef
              ? {
                  purgeConnectionData: (purgeInput: {
                    connection_name: string;
                    vendor?: string;
                    messenger_vendor?: string;
                  }): ConnectionDataPurgeSummary =>
                    runPurgeConnectionData(purgeInput, {
                      db: storage.db!,
                      workEntityStore: storage.workEntityStoreRef!,
                      fileMetaStore: app.fileMetaStoreRef!,
                      annotationStore: app.annotationStoreRef!,
                      enrichmentStore: app.enrichmentStoreRef!,
                      edges: app.workEntityEdgeStoreRef!,
                      // D-192 slice 3b — the D-190 CRM mirror (per-connection
                      // prefix cut). Optional: absent for non-CRM warehouses.
                      ...(app.crmRecordMirrorStoreRef
                        ? { crmRecordMirror: app.crmRecordMirrorStoreRef }
                        : {}),
                      // D-192 slice 4 — the D-138 contact store, for the messenger
                      // contact-link retract leg. Optional (dbless skips it).
                      ...(app.contactStoreRef ? { contactStore: app.contactStoreRef } : {}),
                    }),
                }
              : {}),
            // D-192 source-data-removal slice 3c — the read-only "[N] records"
            // removal-preview count (the COUNT twin of the purge above). Smaller
            // quorum: the work-entity registry + file mirror COUNTs (+ the
            // optional CRM mirror) — no db / annotation / edge stores, since it
            // never deletes. Absent → the preview rpc returns 0.
            ...(storage.workEntityStoreRef && app.fileMetaStoreRef
              ? {
                  previewConnectionPurgeCount: (previewInput: {
                    connection_name: string;
                    vendor?: string;
                    messenger_vendor?: string;
                  }): number =>
                    runPreviewConnectionPurgeCount(previewInput, {
                      workEntityStore: storage.workEntityStoreRef!,
                      fileMetaStore: app.fileMetaStoreRef!,
                      ...(app.crmRecordMirrorStoreRef
                        ? { crmRecordMirror: app.crmRecordMirrorStoreRef }
                        : {}),
                      // D-192 slice 4 — the D-138 contact store, for the messenger
                      // contact-link count leg (mirrors the purge quorum).
                      ...(app.contactStoreRef ? { contactStore: app.contactStoreRef } : {}),
                    }),
                }
              : {}),
            ...(storage.auditLog ? { auditLog: storage.auditLog } : {}),
            // D-165 follow-on — operation-group grant management. Wires the
            // durable grant store + the LIVE profile instance the gateway reads
            // (`execution.connectionOperationProfileStore`) so a grant/revoke
            // re-derives that exact profile (write→ask reachable next dispatch).
            // `getCatalogManifest` resolves a connection's vendor to its catalog
            // (`CATALOG_VENDOR_SLUGS`: hubspot / salesforce); a vendor with no
            // catalog returns undefined → the grant rpcs reject it.
            ...(app.contractGrantStoreRef && execution.connectionOperationProfileStore
              ? {
                  operationGrants: {
                    store: app.contractGrantStoreRef,
                    profileStore: execution.connectionOperationProfileStore,
                    getCatalogManifest: (vendor) => {
                      const slug = catalogSlugForVendor(vendor);
                      return slug
                        ? execution.executorConfig.manifests.get(slug)
                        : undefined;
                    },
                    // D-170 gap #2 — resolve a connection bound to a private/local
                    // composition catalog → its manifest (the install-recorded binding
                    // by connection name + the SAME live manifest registry the gateway
                    // resolves through), so the grant rpcs admit a local-catalog
                    // connection + the re-seed derives its profile.
                    ...(app.connectionCatalogBindingStoreRef
                      ? {
                          resolveLocalCatalog: (name: string) => {
                            const slug =
                              app.connectionCatalogBindingStoreRef!.resolveCatalogSlug(name);
                            return slug
                              ? execution.executorConfig.manifests.get(slug)
                              : undefined;
                          },
                        }
                      : {}),
                  },
                }
              : {}),
            // D-194 #6 — the connection-precise "Used by packs" set for the
            // connection-detail list. Reads the SAME grant store as
            // `operationGrants`, but needs no catalog/profile machinery — just the
            // pack ids granted on a connection name. Guarded on the grant store
            // alone so it lights up even where the profile store is absent.
            ...(app.contractGrantStoreRef
              ? {
                  boundPackSlugsForConnection: (name: string) =>
                    app.contractGrantStoreRef!.listPacksForConnection(name),
                }
              : {}),
            // D-192 S5 — the live merged vendor registry (built-ins + installed
            // packs) so `handleConnectionList` can stamp each api row's
            // `supports_engagement_health`, lighting up the engagement-health
            // toggle for a pack-declared CRM (e.g. Dynamics), not just the
            // built-in hubspot/salesforce. Wired unconditionally: an absent
            // manifest store degrades to the built-ins (the same registry the
            // engagement-health data rpc gates on).
            resolveVendorRegistry: () => liveVendorRegistry(storage.localManifestStore),
            // D-165 enroll-host #1 — vendor OAuth-start. Rides the shared
            // `vendorOAuth` stores constructed above so the start rpc and the
            // `/oauth/complete` handler operate over one flow + result map.
            // Gated on the booted signing identity (the state signer); absent
            // → the start rpc rejects `not_configured`. `vendorOAuthResult`
            // (slice 3) rides the SAME shared `resultStore` the
            // `/oauth/complete` port handler writes, so the owner-bound
            // `takeVendorOAuthResult` rpc consumes exactly what the completion
            // stashed — gated on the `claim_secret` the start rpc handed the
            // originating client.
            ...(vendorOAuth
              ? {
                  vendorOAuthStart: {
                    identity: vendorOAuth.identity,
                    flowStore: vendorOAuth.flowStore,
                    serverPublicUrl: vendorOAuth.serverPublicUrl,
                    // Fork 1 — request a registered vendor's installed packs'
                    // required scopes on top of its const floor (lazy: only
                    // evaluated when the client passes no explicit set).
                    installedPackScopeUnion: (vendor) =>
                      unionRequiredScopesForConnection(
                        listInstalledPackManifests(app.contractStoreRef),
                        vendor,
                      ),
                  },
                  vendorOAuthResult: {
                    resultStore: vendorOAuth.resultStore,
                  },
                }
              : {}),
            // R2 build step 4c.4 — enroll/delete/grant/revoke fan a fresh
            // runnability snapshot after the mutation commits.
            ...(recipeRunnabilityBroadcaster
              ? { recipeRunnabilityBroadcast: recipeRunnabilityBroadcaster }
              : {}),
          },
        }
      : {}),
    // D-166 override-write path — `collection.contract.*` override authoring.
    // Same `app.contractStoreRef` the gateway's override-tightening scan reads
    // (wired into the execution context at 4d.4), so an authored override
    // tightens the next dispatch with no reseed. `getManifest` resolves a
    // catalog-form manifest by the override's `ingredient_id` slug for the
    // declared-operation validation gate. Absent (no db) → the three methods
    // return `not_configured`.
    ...(app.contractStoreRef
      ? {
          contractDeps: {
            store: app.contractStoreRef,
            // D-247 D11 — the recipe roster for the op row's STATIC half. Without
            // it `could` is empty everywhere and the row silently degrades to the
            // usage half alone, which is the shape that cannot tell "no recipe
            // reaches this" from "we did not look".
            recipeStore: execution.executeDeps.recipeStore,
            // D-247 D13 — the coverage ledger's read side.
            ...(storage.auditLog ? { auditLog: storage.auditLog } : {}),
            // D-177 N.14.8 fork 3 (owner: "surface") — the suggestion card's
            // counter-evidence: how often the owner REFUSED this door over the
            // learner's own lookback. Evidence only; it gates nothing.
            countDoorRejects: (door_contract_id, since_ms) =>
              receptionInboxSubviewStore.countRejectsForDoor(door_contract_id, since_ms),
            getManifest: (slug: string) => execution.executorConfig.manifests.get(slug),
            // Slice A2 — enumerate the registry for `listCatalogOperations`. The
            // handler filters to catalog-form + projects; this just yields every
            // loaded manifest (slugs() → get(), dropping any null).
            listManifests: () => {
              const registry = execution.executorConfig.manifests;
              return registry.slugs().flatMap((slug) => {
                const manifest = registry.get(slug);
                return manifest ? [manifest] : [];
              });
            },
            // D-171 — emit `contract_definition` lifecycle (mint / revoke) on the
            // D-121 bus so paired clients' Contracts inspector + the MCP-door
            // Advanced cap/expiry summary re-list off the authoritative signal
            // (dropping the `chat.inbound_token_changed` proxy). The bus stamps
            // the cursor; `eventsDeps.bus` is always composed in production.
            // D-177 N.13 (P6c): the suggestion accept/dismiss rides the same
            // seam for its `delegation_rule_suggestion_resolved` fan-out.
            broadcast: (event: ContractBroadcastEvent) => {
              rpc.observabilityBundle.eventsDeps.bus.emit(event);
            },
            // D-177 N.13 (P6c) — reserve-class `delegation_rule_minted` audit
            // on the suggestion accept (best-effort, same posture as the
            // session-grant resolver's mint audit).
            ...(storage.auditLog ? { auditLog: storage.auditLog } : {}),
            // D-177 rule 5 (5.c, slice C) — the scoped accept rpc's LIVE
            // connection-candidate validation source.
            getConnectionStore: () => app.connectionStoreRef,
          },
        }
      : {}),
    // D-182 §7.2 — `cli.reachability.*` grid rpc. The SAME `app.contractStoreRef`
    // the gateway's cli-reachability resolver reads (wired into the execution
    // context above), so granting a cell authorizes the next dispatch with no
    // reseed. The audit log records the grant/revoke (reserve-class). Absent
    // (no db) → the two methods return `not_configured`.
    ...(app.contractStoreRef
      ? {
          cliReachabilityDeps: {
            store: app.contractStoreRef,
            ...(storage.auditLog ? { auditLog: storage.auditLog } : {}),
            // D-182 §7.2 (increment 4) — the installed manifest snapshot the
            // `cli.reachability.universe` read derives the Local-tools grid's
            // tool rows + risk columns from. Read live off the executor config's
            // registry so an install/uninstall is reflected without a reseed.
            getManifests: (): IngredientManifest[] => {
              const reg = execution.executorConfig.manifests;
              return reg
                .slugs()
                .map((slug) => reg.get(slug))
                .filter((m): m is IngredientManifest => m !== null);
            },
            // D-182 — proactive cli-tool readiness: the Local-tools surface shows
            // "not installed" before a run, matching the run-time CLI_TOOL_NOT_FOUND
            // verdict. Spawn-free binary-on-PATH check, never runs the tool.
            probeCliToolReachable: createCliBinaryReachabilityProbe(),
          },
        }
      : {}),
    // D-269 step 1 — `server.timezone.*`. The owner states whether this machine
    // travels with them; every wall-clock surface resolves through the answer
    // instead of guessing from a host clock that cannot know.
    serverTimeZoneDeps: { store: storage.serverTimeZoneStore },
    // D-269 step 2 — the per-kind reminder policy.
    notificationKindPolicyDeps: { store: storage.notificationKindPolicyStore },
    // D-269 step 3 — the quiet-hours window. Carries the timezone store because
    // arming is gated on a resolvable zone: a wall-clock window with no zone is
    // a setting that silently does nothing.
    quietHoursDeps: {
      store: storage.quietHoursStore,
      timezoneStore: storage.serverTimeZoneStore,
    },
    hostnameDeps: {
      store: storage.hostnameRegistryStore,
      serverIdentityId: storage.serverInstanceId,
      ...(initialAcmeDomainIssuer ? { initialAcmeIssuer: initialAcmeDomainIssuer } : {}),
      // D-235 P1 — the delegation target `collection.hostname.preflight` checks
      // against comes from THIS server's own reservation, never from the
      // request. Lazily constructed on first use (same discipline as the
      // zone-reader in `compose-storage-context.ts`): this composer can run
      // before boot has created `server_config`, and a `db.prepare` at compose
      // time would throw on a fresh install.
      proDdnsBinding: readProDdnsBinding,
    },
    // LAN-URL kickstart — `network.local_urls` reports the loopback + LAN URLs.
    // `getPort` reads the LIVE listener port at call time via the `server`
    // facade's post-bind getter (defined below), so a configured bind_port of 0
    // (OS-assigned) resolves to the ACTUAL bound port, not `:0`.
    networkDeps: {
      getPort: () => server.port,
      // ⛔⛔ THE PORT BEING SERVED, NOT THE ONE CONFIGURED. This read the config
      // key at call time, on the stated grounds that "`public_port` is a runtime
      // key the owner can change without a restart" — which was never true of
      // the listener. Editing it made `network.local_urls` start handing out an
      // address on a port nothing was bound to, so every client surface agreed
      // on a URL that refuses. `boundPublicPort` is what this process serves.
      // ⚠ Still a getter, for the reason the one beside it is: the value is
      // declared further down and a lazy read keeps the two in one place.
      getPublicPort: () => boundPublicPort,
      // ⛔ THE BOUND ADDRESS, NOT THE ADVERTISED ONE — see `getLanBindAddress`.
      // Read through the ref for the same reason as `getPublicPort` beside it:
      // the resolution happens later in this function.
      getLanBindAddress: () => lanBindAddressRef,
    },
    // D-273 — automatic port mapping. ⚠ Every accessor reads through a ref at
    // CALL time; the supervisor does not exist yet at this point in the compose.
    portMappingDeps: {
      getStatus: () => portMappingSupervisorRef?.status() ?? null,
      isEnabled: () => runtimeConfig?.get('network.auto_port_mapping') === true,
      getProtocol: () => portMappingProtocolRef,
    },
    ...(rpc.engagementHealthDeps
      ? { engagementHealthDeps: rpc.engagementHealthDeps }
      : {}),
    ...(rpc.upstreamMergeDeps ? { upstreamMergeDeps: rpc.upstreamMergeDeps } : {}),
    ...(app.enrichmentStoreRef
      ? { enrichmentDeps: { store: app.enrichmentStoreRef } }
      : {}),
    notificationDeps: { dispatchers: collection.channelDispatchers ?? {} },
    mailGetDeps: { registry: collection.collectionRegistry },
    ...(rpc.housekeepingRpcDeps
      ? { housekeepingDeps: rpc.housekeepingRpcDeps }
      : {}),
    // D-250 § D7 — `metric.read`. The stores live on the same server db that
    // housekeeping writes them into, but the DEP is separate: this slice READS and
    // housekeeping WRITES, so a hidden coupling would make "no metrics" read as a
    // housekeeping fault. Absent db (harness / db-less boot) => the slice is simply not
    // registered, which is the same degrade every store-backed slice takes.
    ...(rpc.housekeepingRpcDeps?.db
      ? {
          metricDeps: {
            // ⛔ ADAPTED TO A NARROW READER RIGHT HERE, so nothing downstream holds the store.
            // `read` answers `SharedRecord | null`; the batch wants the VALUE, and a missing
            // row is the same silence as a row with nothing useful in it.
            ...(app.sharedStoreRef === undefined
              ? {}
              : {
                  readPendingBoardResult: async (key: string): Promise<unknown> =>
                    (await app.sharedStoreRef!.read(key))?.value,
                }),
            db: rpc.housekeepingRpcDeps.db,
            // D-250 § B3.3 — everything the daily batch needs and this module cannot
            // derive. ⛔ RETURNS undefined WHEN THE SERVER CANNOT PUBLISH (no booted
            // signing identity), and `metric.submit` then reports `sent: false`. Not
            // publishing is the DEFAULT state, so it must not read as a fault.
            submitter: () => {
              const identity = storage.signingIdentity?.identity;
              if (identity === undefined) return undefined;
              const db = rpc.housekeepingRpcDeps!.db!;
              return {
                // ⛔ A SIGN FUNCTION, NOT THE KEYPAIR — the key never leaves the
                // identity module.
                sign: (payload: string) => identity.signWithServerIdentity(payload),
                // ⚠ RESOLVED PER SEND, not captured here. A handle can be reserved,
                // changed or transferred while the server runs; a captured one would
                // keep signing for a name the cloud no longer maps to this publisher,
                // and every submission would 403 as a handle mismatch.
                resolveTarget: async () => {
                  const state = await createSqliteHandleStateStore({ db }).load();
                  if (!state || state.current_handle.length === 0) return null;
                  return { publisher_id: state.publisher_id, handle: state.current_handle };
                },
                endpoint: `${
                  ((): string => {
                    try {
                      const v = runtimeConfig?.get('cloud.base_url');
                      return typeof v === 'string' && v.length > 0 ? v : 'https://api.recued.com';
                    } catch { return 'https://api.recued.com'; }
                  })()
                }/v1/boards/submit`,
                post: async (url: string, body: string) =>
                  fetch(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body,
                  }),
              };
            },
          },
        }
      : {}),
    ...(rpc.notificationsDeps
      ? { notificationsDeps: rpc.notificationsDeps }
      : {}),
    // D-169 P1 — `system.status` rpc. The deps construct above
    // assembles every source from already-in-scope state; the thunk-
    // backed `getWsServer` resolves once the post-construct ref below
    // fires.
    systemStatusDeps,
    // D-169 P2 — historical-view rpc deps (built above from in-scope
    // audit log + notification block). Always passed; the slice self-gates
    // per-source on the deps.
    historyDeps,
    ...(packInstallDepsWithComposition
      ? {
          packInstallDeps: {
            ...packInstallDepsWithComposition,
            // D-247 D15 — manifest lookup so the install preview can resolve a
            // catalog op's risk tier. Absent ⇒ the recipe reports `unknown`
            // rather than a guessed class, which is the honest degradation.
            // ⚠ `?? undefined` — the registry answers `null` for a miss while the
            // dep is typed `undefined`; conflating them would be a type-level lie.
            getManifest: (slug: string) => execution.executorConfig.manifests.get(slug) ?? undefined,
            // D-247 D15.1 — the grant rows, so the install can PRE-WRITE each
            // recipe's with the owner's chosen ceiling applied, before the save.
            // Without it the store hook seeds on `chat_exposed` alone and the
            // install dialog's answer is decorative.
            ...(app.contractStoreRef
              ? { grantEntryStore: createContractGrantEntryStore(app.contractStoreRef) }
              : {}),
            // D-209 #1 W2b — a successful install mints one webhook door per
            // webhook-declaring recipe (installs default ARMED; the install
            // consent screen is the gesture).
            ...(webhookDoorDeps ? { webhookDoor: webhookDoorDeps } : {}),
            // D-170 (packs.install composition branch) — the local manifest
            // store + live registry that let an `app_pack` carrying a
            // `composition` content (N.17) provision it alongside its recipes,
            // so the gateway resolves its operations (N.16).
            //
            // ⛔ § 234.4p.16d — these now come from the HOISTED
            // `packInstallDepsWithComposition` rather than being spread inline
            // here. Inline was the defect: this literal was the only place the
            // two fields existed, so `installGeneratedPack` — built from the
            // bare slice — deferred every composition it ever installed.
            // D-170 gap #2 live-reconcile — (re)derive the bound connection's
            // operation profile the moment the composition's binding + grants
            // commit, so a connect-BEFORE-install dispatch works at once.
            ...(execution.reconcileConnectionProfile
              ? { reconcileConnectionProfile: execution.reconcileConnectionProfile }
              : {}),
            // D-192 — register/unregister pack-declared work-entity Sources for the
            // bound connection the moment the binding commits / drops (enroll-before-
            // install; mirrors reconcileConnectionProfile).
            ...(app.reconcileWorkEntitySourcesRef
              ? { reconcileWorkEntitySources: app.reconcileWorkEntitySourcesRef }
              : {}),
            // R2 build step 4c.4 — a successful install fans a fresh runnability
            // snapshot (new recipes + their provisioned grants).
            ...(recipeRunnabilityBroadcaster
              ? { recipeRunnabilityBroadcast: recipeRunnabilityBroadcaster }
              : {}),
            // R2 build step 4c.2 — the install result's born-blocked/-degraded
            // disclosure reads the SAME runnability service the broadcaster + rpc
            // use. Gated on the same deps (absent → the result omits the born
            // fields, like `recipe.runnability` returning `not_configured`).
            ...(recipeRunnabilityDeps
              ? { computeRunnability: () => listRecipeRunnability(recipeRunnabilityDeps).recipes }
              : {}),
          },
        }
      : {}),
    ...(rpc.packListDeps
      ? { packListDeps: rpc.packListDeps }
      : {}),
    // D-259 — the durable half of the boot pack finding. Composed HERE rather
    // than threaded through `rpc`, because both inputs are already in scope and
    // both must be the SAME sources the boot check reads: if the rpc and the
    // boot notification could disagree, the Packs surface would contradict the
    // message that sent the owner to it.
    ...(typeof storage.localManifestStore.listManifests === 'function'
      ? {
          packUnrunnableDeps: {
            listManifests: () => storage.localManifestStore.listManifests!(),
            getContractStore: () => app.contractStoreRef,
          },
        }
      : {}),
    ...(rpc.packUninstallDeps
      ? {
          packUninstallDeps: {
            ...rpc.packUninstallDeps,
            // D-225 Slice 2 — destroy, direction 2: uninstalling a GENERATED
            // pack removes the MCP connection it was minted from. The mapping
            // is RECOMPUTED (`mcpConnectionForPackSlug`) rather than stored —
            // the slug is a one-way hash of `{kind, name}`, and a stored
            // mapping could disagree with the derivation it claims to describe.
            // ⛔ The connection-delete deps here OMIT `teardownGeneratedPack`,
            // so this cannot cascade back into the uninstall already running.
            ...(app.connectionStoreRef
              ? {
                  removeGeneratedPackConnection: async (
                    packSlug: string,
                  ): Promise<string | null> => {
                    const store = app.connectionStoreRef!;
                    const found = await mcpConnectionForPackSlug(
                      packSlug,
                      store.list({ kind: 'mcp' }).map((row) => ({
                        kind: row.kind,
                        name: row.name,
                      })),
                    );
                    if (found === null) return null;
                    await handleConnectionDelete(
                      { store },
                      { name: found.name, kind: 'mcp' } as Parameters<
                        typeof handleConnectionDelete
                      >[1],
                    );
                    return found.name;
                  },
                }
              : {}),
            // D-209 #1 W2b — uninstall retires the pack's webhook doors
            // alongside their trigger rows (mint/retire symmetry).
            ...(webhookDoorDeps
              ? { webhookDoorDefinitionStore: webhookDoorDeps.definitionStore }
              : {}),
            // D-170 (packs.install composition branch) — same local manifest
            // store + registry as `packInstallDeps`, so uninstalling a pack the
            // install path provisioned a composition for also deletes its local
            // catalog body + deregisters it (the install/uninstall symmetry).
            ...(app.contractStoreRef
              ? {
                  localManifestStore: storage.localManifestStore,
                  registry: execution.executorConfig.manifests,
                }
              : {}),
            // D-170 gap #2 live-reconcile — drop the formerly-bound connection's
            // now-orphan profile the moment its binding is removed (symmetry with
            // install; a registered-vendor connection keeps its vendor profile).
            ...(execution.reconcileConnectionProfile
              ? { reconcileConnectionProfile: execution.reconcileConnectionProfile }
              : {}),
            // D-192 — register/unregister pack-declared work-entity Sources for the
            // bound connection the moment the binding commits / drops (enroll-before-
            // install; mirrors reconcileConnectionProfile).
            ...(app.reconcileWorkEntitySourcesRef
              ? { reconcileWorkEntitySources: app.reconcileWorkEntitySourcesRef }
              : {}),
            // R2 build step 4c.4 — a successful uninstall fans a fresh runnability
            // snapshot (survivors that lost their last provider go blocked).
            ...(recipeRunnabilityBroadcaster
              ? { recipeRunnabilityBroadcast: recipeRunnabilityBroadcaster }
              : {}),
            // R2 build step 4c.3 + §1.6 follow-on — the "disables N recipes"
            // disclosure reverse-walks the SAME runnability deps the broadcaster +
            // rpc use; gated identically (absent → the result omits `would_disable`
            // / `would_degrade`, like `not_configured`). The walk derives the
            // pack's bound + grant-target connections from its own stores.
            ...(recipeRunnabilityDeps
              ? {
                  computeWouldWorsen: (pack_slug: string) =>
                    listRecipesWorsenedByPackUninstall(recipeRunnabilityDeps, pack_slug),
                }
              : {}),
          },
        }
      : {}),
    // D-170 — `ingredient.install` / `ingredient.uninstall` rpc. Provisioning
    // writes bodies to the local manifest store + inventory to the SAME
    // `contract.*` store the gateway resolves through, then registers the
    // catalog into the live registry (N.16). The pin-guard scans the recipe
    // store. Gated on the contract store + local manifest store; absent (db-
    // less) → both methods return `not_configured`.
    ...(app.contractStoreRef
      ? {
          ingredientAuthoringDeps: {
            localManifestStore: storage.localManifestStore,
            contractStore: app.contractStoreRef,
            registry: execution.executorConfig.manifests,
            recipeStore: storage.recipeStore,
            compiledRecipeStore: storage.recipeStore,
            recipeTrustStore: rpc.recipeTrustStore,
            // D-170 gap #2 live-reconcile — install seeds the bound connection's
            // profile post-commit; uninstall drops it. Lets a connect-BEFORE-
            // install (or an uninstall) take effect at dispatch immediately.
            ...(execution.reconcileConnectionProfile
              ? { reconcileConnectionProfile: execution.reconcileConnectionProfile }
              : {}),
            // D-192 — register/unregister pack-declared work-entity Sources for the
            // bound connection the moment the binding commits / drops (enroll-before-
            // install; mirrors reconcileConnectionProfile).
            ...(app.reconcileWorkEntitySourcesRef
              ? { reconcileWorkEntitySources: app.reconcileWorkEntitySourcesRef }
              : {}),
            ...(app.sellerStoreRef
              ? { sellerStore: app.sellerStoreRef }
              : {}),
            ...(app.chatInboundTokenStoreRef
              ? { inboundTokenStore: app.chatInboundTokenStoreRef }
              : {}),
          },
        }
      : {}),
    // D-170 N.4 / N.15 / #2 — `ingredient.draft.*`,
    // `ingredient.preview`, and `ingredient.compose.decompose` rpc deps. Built
    // above with the preview READ-execution seam. The decompose method operates
    // on drafts, so it rides this same dependency family and the single
    // server.ts forward for `ingredientDraftDeps`.
    ...{ ingredientDraftDeps },
    bridgeCapabilityDeps: { registry: bridgeRegistry },
    // D-169 P0 follow-on — same registry instance threaded through the
    // WS upgrade's `bridgeRegistry.attach()` call (gated on
    // `client_kind === 'bridge'`). Keeps attach + push pinned to one
    // map so capability pushes land via `updateCapabilities` instead of
    // the no-op pre-attach branch.
    bridgeRegistry,
    // D-169 P0 follow-on — optional audit log for the multi-bridge
    // dispatcher's `lastSuccessfulBridgeDispatch` recency ordering +
    // `bridge_dispatch_succeeded` activity emit. When absent (db-less
    // harness) the dispatcher's iteration order degrades to WS
    // attachment recency alone — same posture as `pairRevokeAuditLog`.
    ...(storage.auditLog
      ? { bridgeDispatcherAuditLog: storage.auditLog }
      : {}),
    // D-187 AMENDMENT — `mcp.visibility.{read,write}` rpc operates on the OWNER
    // contract's `enrichment.<topic>` grant rows via the unified grant store (a
    // stateless wrap of the shared contract store).
    ...(app.contractStoreRef
      ? {
          mcpVisibilityDeps: {
            store: createContractGrantEntryStore(app.contractStoreRef),
          },
        }
      : {}),
    // Grant-foundation slice 3 — `contract.grant.{read,read_by_entry,write}` over the
    // unified grant store (a stateless wrap of the shared contract store).
    ...(app.contractStoreRef
      ? {
          contractGrantDeps: {
            store: createContractGrantEntryStore(app.contractStoreRef),
          },
        }
      : {}),
    exposureDeps,
    ...(tlsDomainDeps ? { tlsDomainDeps } : {}),
    ...(tokenRotationEmitter
      ? { tokenRotationDeps: { emitter: tokenRotationEmitter } }
      : {}),
    ...(rotationEngine ? { tlsRenewDeps: { engine: rotationEngine } } : {}),
    ...(passportFetchDeps ? { passportFetchDeps } : {}),
    ...(identityProbeDeps ? { identityProbeDeps } : {}),
    ...(passportUserRpcDeps ? { passportUserRpcDeps } : {}),
    ...(keyRotateDeps ? { keyRotateDeps } : {}),
    ...(proAuthMachine ? { proAuthDeps: { machine: proAuthMachine } } : {}),
    ...(storage.workEntityStoreRef
      ? {
          workEntitySourceDeps: {
            resolver: createWorkEntityResolver(storage.workEntityStoreRef),
          },
        }
      : {}),
    // D-205 #2c — `contact.source.list`: the Sources health strip on `#data/contact`.
    // Needs BOTH the Source registry (for `source_label` / `enabled`, off the work-
    // entity store like its `work_entity.source.list` sibling) and the contact
    // sync-state rows (for the health + the runner's cycle counts). Either absent →
    // the method returns `not_configured` and the strip simply does not render.
    ...(storage.workEntityStoreRef && app.contactSourceSyncStateRef
      ? {
          contactSourceDeps: {
            resolver: createWorkEntityResolver(storage.workEntityStoreRef),
            syncState: app.contactSourceSyncStateRef,
          },
        }
      : {}),
    // D-205 #5 — selective CRM promotion. The strangers are ALREADY on disk: the
    // reconcilers mirror every CRM contact into `crm_record_mirror` regardless of
    // whether Recued knows the person, and the contact sync already COUNTS them
    // (`last_cycle.skipped`). So this is a picker over data we already hold, not an
    // import. Both stores required — no mirror means no CRM, hence no strangers.
    ...(app.contactStoreRef && app.crmRecordMirrorStoreRef
      ? {
          contactImportDeps: {
            store: app.contactStoreRef,
            mirror: app.crmRecordMirrorStoreRef,
          },
        }
      : {}),
    // D-174 #22 — work-entity warehouse CRUD pair-RPC (Data route).
    // Reads through a resolver over the store; writes through the SAME
    // bus + cascade-wired dispatcher instance compose-collection-context
    // built (so `work_entity.{upsert,delete}` emit warehouse events on
    // the ingredient channel's path). Gated on both the store + the
    // dispatchers (the latter is undefined when the store is absent).
    // Slice 1 (`work.create`) — the SAME deps object is also published onto
    // `app.workEntityCrudDepsRef` ABOVE, so the Tier-1 chat tool writes
    // through this exact dispatcher instance rather than a second one. One
    // write path, one set of warehouse events, one audit story.
    ...(workEntityCrudDepsShared
      ? { workEntityCrudDeps: workEntityCrudDepsShared }
      : {}),
    // Accepted Reception forms are canonical owner data independent of any
    // downstream materialization plan. Expose their immutable store through a
    // dedicated registered-client read slice for Data → Form responses.
    ...(storage.formResponseStoreRef
      ? { formResponseDeps: { store: storage.formResponseStoreRef } }
      : {}),
    // D-221 — #data Records uses this owner-pair control plane, never a
    // `data.records.*` resolver or the agent-facing Tier-P executor.
    recordsRpcDeps: { store: storage.recordsStore },
    savedDataViewStore,
    // D-198 — `memory.*` owner-trusted pair-RPCs (Memory lens). Slice 1
    // `memory.list` reuses the audit store's `listRecent` origin filter; Slice
    // 2 adds the owner-authored `user_memory` store (create/get/update/delete +
    // the read union) and the realtime bus so a write silently refreshes paired
    // lenses. Absent `auditLog` → the whole slice drops (`not_configured`).
    ...(storage.auditLog
      ? {
          memoryRpcDeps: {
            auditLog: storage.auditLog,
            ...(app.userMemoryStore ? { userMemoryStore: app.userMemoryStore } : {}),
            ...(app.memoryRedactionStore ? { redactionStore: app.memoryRedactionStore } : {}),
            ...(storage.eventBus ? { bus: storage.eventBus } : {}),
          },
        }
      : {}),
    // D-174 #22 — `data.timeline` read pair-RPC (Data route drill-down).
    // Mirrors the recipe-channel `timeline-read` deps construction
    // (wire-executor-config.ts): db + auditLog + annotationStore are
    // required; enrichment + mcp-visibility stores fold in when present.
    // `gateMcpPrivate` is intentionally OMITTED → paired-client reads see
    // private rows (the MCP channel keeps its own gated handler).
    ...(storage.db && storage.auditLog && app.annotationStoreRef
      ? {
          timelineRpcDeps: {
            timelineDeps: {
              db: storage.db,
              auditLog: storage.auditLog,
              annotationStore: app.annotationStoreRef,
              ...(app.enrichmentStoreRef
                ? { enrichmentStore: app.enrichmentStoreRef }
                : {}),
              // D-192 Fork B (B2) — surface a file record (CAS or vendor-mirror)
              // as the timeline's raw-record source, so the webclient Data→Files
              // drill-down shows the file's metadata. The loader is file-scoped
              // (returns null for other collections, unchanged). This is the
              // FIRST implementation of the long-unwired `loadCollectionRecord`.
              loadCollectionRecord: buildLoadFileCollectionRecord(
                createFileViewResolverFromRegistry(
                  collection.collectionRegistry,
                  app.fileMetaStoreRef,
                  app.fileSourceSyncStateRef,
                ),
              ),
              // D-226 — each installed pack's declared projection onto this
              // identity, computed from its live rows. The paired client is the
              // owner's own UI, so it sees this on the same terms it sees
              // private rows; the MCP channel wires the same loader behind its
              // own grant fence.
              rollupsForEntity: (collectionName: string, id: string) =>
                collectionName === 'contact'
                  ? readRootProjections(storage.recordsStore, 'contact', id).map(toWireRollup)
                  : [],
            },
          },
        }
      : {}),
    // D-172 Half-A "open" — `data.file.read` owner read pair-RPC (Files tab
    // open/download). Same lazy `fileReadDeps` shape as compose-collection-
    // context's mail-send closure (registry + blobs + auditLog); yields
    // undefined on a dbless / no-CAS boot so the handler returns not_configured
    // rather than half-reading. Owner-trusted (registered-client boundary in the
    // handler) — the contract/egress gate is only for the AI/recipe channels.
    fileReadRpcDeps: {
      ...(storage.db && app.connectionStoreRef && storage.workEntityStoreRef ? {
        cloudAttachments: { db: storage.db, connections: app.connectionStoreRef, sources: storage.workEntityStoreRef,
          ...(app.fileSourceSyncStateRef ? { syncState: app.fileSourceSyncStateRef } : {}) },
      } : {}),
      getFileReadDeps: () => {
        if (!app.cacheBlobs) return undefined;
        // D-192 remote byte-fetch — when the file-source mirror + its connection
        // resolver are wired, a `file:remote:*` id lazily fetches the vendor's
        // bytes (S3 GetObject, …) instead of returning 501. The bundle is built
        // once in compose-app-context (shared by every file-read channel — recipe
        // / ai / mail / this pair-RPC).
        const remote = app.getRemoteFileReadDeps();
        return {
          registry: collection.collectionRegistry,
          blobs: app.cacheBlobs,
          ...(storage.auditLog ? { auditLog: storage.auditLog } : {}),
          ...(remote ? { remote } : {}),
        };
      },
    },
    // D-139 P5 — `data.contact.engagements.list` resolver pair-RPC. Reuses
    // the shared resolver bundle built once in compose-app-context so the
    // WS-rpc + MCP channels resolve identically. Absent (dbless boot /
    // missing stores) → the slice drops + the rpc returns `not_configured`.
    ...(app.contactEngagementsResolveDepsRef
      ? { contactEngagementsRpcDeps: app.contactEngagementsResolveDepsRef }
      : {}),
    ...(storage.s2sPreviewStoreRef
      ? {
          s2sPreviewDeps: {
            store: storage.s2sPreviewStoreRef,
            ...(storage.auditLog ? { auditLog: storage.auditLog } : {}),
            now: () => Date.now(),
            randomToken: () => randomBytes(32).toString('hex'),
          },
        }
      : {}),
    ...(receptionRpcDeps ? { receptionRpcDeps } : {}),
    // D-188 — augment the reception port deps with the master pause flag so
    // a paused server closes the public reception door (intake bypasses the
    // op-admission gate). Injected here, where `app.serverState` is in scope.
    ...(receptionPortDeps
      ? {
          receptionPortDeps: app.serverState
            ? { ...receptionPortDeps, isPaused: (): boolean => app.serverState!.isPaused() }
            : receptionPortDeps,
        }
      : {}),
    // D-173 INT-3 — Reception Inbox rpc deps (the convergence). Absent
    // bundle (gate handles unwired) → the slice drops + `reception.inbox.*`
    // returns `not_configured`.
    ...(receptionInboxBundle
      ? { receptionInboxDeps: receptionInboxBundle.receptionInboxDeps }
      : {}),
    // D-210 step 2a — the reception RECORD read surface. Gated on EITHER store: the handler
    // answers with the kind it has, because a missing booking store must not hide the
    // submissions. Neither present ⇒ omitted ⇒ the method is not registered at all, which is
    // the honest answer on a db-less boot (a registered method over no store would answer
    // `[]`, and on THIS surface `[]` reads as "you have received nothing").
    // ⚠ D-210 A.8 slice 4b-ii — BOTH arms read the MERGED store now; the handler
    // tells the two flows apart with `record_kind`, not by which store it holds.
    // 🔴 Pointing `getBookingStore` at the old ref here would have compiled
    // fine (a conditional SPREAD skips tsc's excess-property check) and the
    // owner's booking list would have silently read an EMPTY table.
    ...(storage.intakeFormSubmissionStoreRef
      ? {
          receptionRecordDeps: {
            getBookingStore: () => storage.intakeFormSubmissionStoreRef,
            getSubmissionStore: () => storage.intakeFormSubmissionStoreRef,
          },
        }
      : {}),
    // D-210 Appendix B — `reception.manage.mint`. Needs all three: the manage
    // credential store (to issue), the booking store (event → booking `findById`),
    // and the annotation store (the `scheduled-from` walk, same reader the
    // notify-booking-visitor dispatcher uses). Any absent ⇒ the method is not
    // registered rather than half-wired.
    ...(app.receptionManageCredentialStoreRef
      && storage.intakeFormSubmissionStoreRef
      && app.annotationStoreRef
      ? {
          receptionManageMintDeps: {
            getCredentialStore: () => app.receptionManageCredentialStoreRef!,
            getBookingStore: () => storage.intakeFormSubmissionStoreRef!,
            listInboundLinks: (filter: { to_collection: string; to_id: string }) =>
              app.annotationStoreRef!.listLinks(filter),
            now: () => Date.now(),
          },
        }
      : {}),
    // D-240 § D11 — `reception.lookup.revoke`. Needs only the credential store:
    // it revokes CREDENTIALS, and deliberately does not check that the record
    // still exists (a record collected by retention whose link is still in
    // someone's inbox is exactly when a revoke is most wanted).
    //
    // ⚠ THIS IS A CONDITIONAL SPREAD, so tsc will NOT catch a renamed key —
    // the same shape that left `receptionManageMintDeps` dead on the wire, as
    // the note at the top of this file records. The guard is not a type here; it
    // is `d-240-slice6-lookup-revoke` asserting the METHOD IS REGISTERED.
    ...(app.receptionManageCredentialStoreRef
      ? {
          receptionLookupRevokeDeps: {
            getCredentialStore: () => app.receptionManageCredentialStoreRef!,
            now: () => Date.now(),
          },
        }
      : {}),
    // D-165 enroll-host #1 (vendor OAuth popup) — slice 2b Piece W. The
    // seam in `createServerHandlerSet` mounts the `createVendorOAuthComplete
    // PortHandler` on the `oauth` path role when these deps are present
    // (else the role is absent → path-router 404s `/oauth/complete`). Shares
    // the start↔complete stores + signing identity with `vendorOAuthStart`
    // above. `onCompleted` fires AFTER a successful completion response is
    // written, fanning the `{ flow_id }`-only completion broadcast (NEVER the
    // refresh_token — the bus reaches every paired client) so the dialog
    // claims the credential point-to-point via `takeVendorOAuthResult`.
    ...(vendorOAuth
      ? {
          oauthCompletePortDeps: {
            identity: vendorOAuth.identity,
            flowStore: vendorOAuth.flowStore,
            resultStore: vendorOAuth.resultStore,
            serverPublicUrl: vendorOAuth.serverPublicUrl,
            onCompleted: (flow_id: string) => {
              rpc.observabilityBundle.eventsDeps.bus.emit({
                kind: 'connection.vendor_oauth_completed',
                flow_id,
              });
            },
          },
        }
      : {}),
    // D-158 P2b-ii — mounts the `/ask/<ask_id>` notification ask-landing
    // handler on the `ask` path role when the block is up (else absent →
    // path-router 404s `/ask/*`).
    ...(askLandingPortDeps ? { askLandingPortDeps } : {}),
    eventsDeps: rpc.observabilityBundle.eventsDeps,
    ...(rpc.observabilityBundle.auditExportDeps
      ? { auditExportDeps: rpc.observabilityBundle.auditExportDeps }
      : {}),
    ...(rpc.observabilityBundle.executionFeedDeps
      ? { executionFeedDeps: rpc.observabilityBundle.executionFeedDeps }
      : {}),
    ...(rpc.observabilityBundle.statusPageDeps
      ? { statusPageDeps: rpc.observabilityBundle.statusPageDeps }
      : {}),
    ...(app.chatDeps ? { chatDeps: app.chatDeps } : {}),
    ...(mcpHttpDeps ? { mcpHttpDeps } : {}),
    ...(llmGatewayDeps ? { llmGatewayDeps } : {}),
  });

  // D-169 P0 follow-on (Codex 2026-05-28 Angle 2 fold) — publish the
  // live bridge dispatcher to the executor's late-bound ref BEFORE the
  // listener coordinator starts + before schedulers spin up. The
  // post-extraction chain calls `startPostListenerRuntime` AFTER this
  // helper returns; without an in-chain publish, cron + auto_run could
  // dispatch a DOM step before `lateBound.publishBridgeDispatcher` fires
  // and the runner adapter mis-classifies the unwired state as
  // "no bridge connected." Publishes `undefined` when the registry isn't
  // wired (composeExecutionContext always passes `getBridgeDispatcher`
  // so the ref's getter returns this exact value verbatim).
  options.publishBridgeDispatcher?.(serverHandlerSet.wsHandle.bridgeDispatcher);

  // D-169 P1 — Bind the live WS handle into the system-status thunk
  // ref. Construct order: deps → createServerHandlerSet → wsHandle
  // available. The thunk reads through this ref on every status fetch,
  // so the side-panel's first mount tick sees the live serving count
  // even if the panel opens before the listener accepts traffic.
  wsHandleForStatusRef = serverHandlerSet.wsHandle;

  // Resolve LAN bind address per § A.7.5, with both inputs the resolver has
  // always accepted and nothing supplied until now:
  //   - the owner's `network.lan_bind_address` (config.toml / setConfigField —
  //     there is no generic runtime-config page in the webclient yet);
  //   - the host's default-route gateway, which resolves the multi-interface
  //     case (Docker bridge / VM bridge / VPN alongside the real LAN) that
  //     otherwise lands on `ambiguous_lan_candidates` + loopback.
  // Both are best-effort: no config store (dbless boot) or an unreadable
  // routing table just returns undefined, which is the behaviour this call
  // had unconditionally before.
  const lanResolution = resolveLanAddress({
    override: runtimeConfig
      ? (runtimeConfig.get('network.lan_bind_address') as string)
      : undefined,
    defaultRouteGateway: readDefaultRouteGateway(),
  });
  // Two different addresses, deliberately (see `ResolvedLanAddress`):
  //   - what the listener BINDS — `0.0.0.0` for a detected LAN address, so
  //     the loopback origin the webclient needs is served too;
  //   - what we ADVERTISE — the LAN IP, for pairing address hints + docs.
  const lanBindAddress = lanResolution.bind_address;
  const lanAdvertisedAddress = lanResolution.address;

  /** This machine's advertised LAN address, RE-RESOLVED on demand.
   *
   *  ⛔⛔ THE PORT MAPPING CLOSED OVER THE BOOT-TIME VALUE. After a DHCP renewal
   *  or a network switch the mapping kept naming the machine's OLD internal
   *  client, and `planIgdBoot`'s DHCP-move branch — which exists precisely to
   *  recover from that — could never fire, because production never supplied a
   *  changed address. Half the network snapshot was live (the gateway WAS
   *  re-read every reconcile) and half was frozen at boot.
   *
   *  ⚠ NOT FOR THE BIND. The listener's address is settled at startup by
   *  construction and must not move under a running socket. This is for the
   *  callers whose question is "where am I on this network RIGHT NOW" — the
   *  mapping's destination, and the interface SSDP leaves by.
   *
   *  ⚠ FALLS BACK TO THE BOOT VALUE if a later resolve comes back empty: a
   *  transient failure to read the routing table is not evidence that we moved. */
  const readLanAddressNow = (): string => {
    try {
      const now = resolveLanAddress({
        override: runtimeConfig
          ? (runtimeConfig.get('network.lan_bind_address') as string)
          : undefined,
        defaultRouteGateway: readDefaultRouteGateway(),
      }).address;
      return now.length > 0 ? now : lanAdvertisedAddress;
    } catch {
      return lanAdvertisedAddress;
    }
  };

  /** The public port the LISTENER IS ACTUALLY BOUND ON, right now.
   *
   *  ⛔⛔ ONE VALUE FOR THE LISTENER, THE MAPPING AND THE ADVERTISED URLS,
   *  BECAUSE THEY WERE THREE. The listener captured `public_port` at compose
   *  time; the mapping supervisor re-read the config key every reconcile; the
   *  URL builders read it lazily. Editing 443 to 8446 released a working router
   *  forward, created one to a port nothing served, and started advertising an
   *  address that did not answer.
   *
   *  ⚠ THE FIRST FIX FROZE THE WRONG END. It made the mapping follow the
   *  listener and declared `public_port` restart-required — on the belief that
   *  the path coordinator could not rebind live. It can: `applyResolution`
   *  already stops and rebinds a SINGLE listener for a TLS-mode flip, and a port
   *  change is the same shape (a bound socket cannot move ports any more than it
   *  can move addresses). The restart requirement was a property of the SEAM —
   *  `public_port` was closure-captured, so nothing could ask the listener to
   *  move — not of the system.
   *
   *  ⇒ Now: a write to `public_port` rebinds the public listener in place, and
   *  everything downstream follows because they all read THIS, which is updated
   *  only once a bind actually succeeded. ⛔ It is still the BOUND port, never
   *  the configured one — a failed rebind must not make three surfaces start
   *  advertising a port nothing is listening on. That was the original bug and
   *  it is the one thing that must not come back. */
  let boundPublicPort = runtimeConfig
    ? (runtimeConfig.get('public_port') as number)
    : DEFAULT_PUBLIC_PORT;
  // D-272 — publish the BOUND address to `network.local_urls`, which folds it
  // into `lan_exposure`. Assigned here because this is where it becomes known.
  lanBindAddressRef = lanBindAddress;

  /** ⚠ Rebuilt on every operation rather than cached. Which protocol answers —
   *  and whether either does — changes when the machine moves networks, and a
   *  client pinned at boot would keep talking to the last network's router. */
  const resolvePortMappingActuatorForHost = () => resolvePortMappingActuator({
    gateway: readDefaultRouteGateway(),
    // ⚠ The SSDP bind interface AND the IGD internal client both come from here,
    // so a stale value sends discovery out the wrong interface and names the
    // wrong destination — see `readLanAddressNow`.
    lanAddress: readLanAddressNow(),
    ssdp: createSsdpTransport(),
    httpPost: createIgdHttpPost(),
    fetchDescription: createIgdDescriptionFetch(),
  });

  // ── D-273 — automatic port mapping ──────────────────────────────────────
  //
  // ⛔ OFF UNLESS THE OWNER TURNED IT ON. `network.auto_port_mapping` defaults
  // to false, and the supervisor's first reconcile with it off is a no-op that
  // still runs DETECTION — which is the whole of P0: the router step can say
  // "your router supports this" before anyone opens anything.
  //
  // ⚠ Started only where a database exists. A dbless boot has nowhere to record
  // what we mapped, and without that record we would be the blind-deleting
  // client D-273 exists to avoid.
  // ⛔ THE WHOLE BLOCK IS NON-FATAL. This is an optional convenience that talks
  // to hardware we do not control, over protocols half the fleet implements
  // loosely. `resolvePortMappingActuator` already degrades internally; this is
  // the same rule one level up, where a throw would stop the SERVER starting
  // rather than stopping a port from being mapped. The composition root is
  // exactly where that distinction is decided.
  try {
  if (storage.db) {
    const portMappingStore = createPortMappingStore(storage.db);
    portMappingSupervisorRef = createPortMappingSupervisor({
      store: portMappingStore,
      readDesire: () => composePortMappingDesire({
        enabled: runtimeConfig?.get('network.auto_port_mapping') === true,
        gateway: readDefaultRouteGateway(),
        // ⚠ SSDP IS WIRED HERE, so a host with no readable default route can
        // still find a router. Without this the desire short-circuits to
        // `no_gateway` and win32 — where the read ALWAYS returns undefined —
        // never reaches the IGD path at all.
        discoveryAvailable: true,
        // ⛔ THE ADVERTISED ADDRESS, NOT THE BIND ADDRESS. The bind is `0.0.0.0`
        // so loopback stays served; a mapping must name a real host.
        // ⛔⛔ AND RE-RESOLVED PER RECONCILE — see `readLanAddressNow`. This
        // closed over the boot-time value, so a DHCP move left the mapping
        // naming a host we no longer are, and the planner's DHCP-move branch
        // could never fire because production never supplied a changed address.
        lanAddress: readLanAddressNow(),
        // ⛔⛔ THE PORT THE LISTENER IS ACTUALLY ON, NOT THE CONFIGURED ONE.
        // This read `runtimeConfig.get('public_port')` fresh while the LISTENER
        // held its startup port, so editing 443 to 8446 released the working
        // forward and created one to a port nothing served.
        //
        // 🔑 A MAPPING IS A PROMISE ABOUT A LISTENER, so it is derived from the
        // listener, never from the wish. `boundPublicPort` now MOVES — but only
        // after a rebind succeeds — so the mapping follows a live port change on
        // its next reconcile with no restart and no special handling here. The
        // supervisor was never boot-bound; freezing this value was what made it
        // look that way.
        publicPort: boundPublicPort,
      }),
      // ⛔⛔ `getMapping` IS FORWARDED NOW, AND DROPPING IT WAS THE WHOLE DEFECT.
      // This object used to expose `map`/`unmap` only, so the supervisor could
      // never tell an IGD router from a NAT-PMP one and always ran the blind
      // plan — which overwrites whatever is on the port and deletes without
      // looking. `resolvePortMappingActuator` has returned `getMapping` for IGD
      // since P2; the composition root threw it away.
      //
      // ⚠ IT IS ALWAYS PRESENT AND MAY ANSWER `undefined`, which is the honest
      // shape: the protocol that answers can change between calls when the
      // machine moves networks, so capability is a per-call fact, not a
      // per-composition one. The supervisor treats a thrown/absent answer as
      // "cannot enumerate" and falls back.
      makeActuator: () => ({
        // ⚠ Resolved per call and cached only for the duration of one operation:
        // which protocol answers can change when the machine moves networks.
        map: async (a) => {
          const resolved = await resolvePortMappingActuatorForHost();
          if (resolved === null) throw new Error('port mapping: no gateway answered');
          return resolved.actuator.map(a);
        },
        unmap: async (a) => {
          const resolved = await resolvePortMappingActuatorForHost();
          // ⛔ THROWS RATHER THAN RETURNING QUIETLY. This used to `return`, so a
          // gateway that had gone away read to the caller as a completed
          // deletion — the record was cleared and the owner was told the port
          // was closed while the lease stayed open on the router.
          if (resolved === null) throw new Error('port mapping: no gateway answered');
          await resolved.actuator.unmap(a);
        },
        getMapping: async (a) => {
          const resolved = await resolvePortMappingActuatorForHost();
          if (resolved === null || resolved.getMapping === null) {
            throw new Error('port mapping: this gateway cannot be asked');
          }
          return resolved.getMapping(a);
        },
      }),
      // ⚠ Resolved against whichever gateway answers NOW, not recorded at boot.
      canEnumerate: async () => {
        const resolved = await resolvePortMappingActuatorForHost();
        return resolved !== null && resolved.getMapping !== null;
      },
      detect: async () => {
        const resolved = await resolvePortMappingActuatorForHost();
        if (resolved === null) return { kind: 'unknown', detail: 'no gateway answered' };
        portMappingProtocolRef = resolved.protocol;
        // ⚠ Detection needs ONE method, and the probe type says so — the stub
        // `map`/`unmap` this used to carry were a smell: a detector that could
        // be handed something able to open a port is a detector one edit away
        // from doing it.
        return detectPortMappingSupport({
          externalAddress: () => resolved.externalAddress(),
        });
      },
      // ⚠ GUARDED ON THE METHOD, NOT THE OBJECT. `RuntimeConfigStore` declares
      // `onChange`, but this composer is reached with partial stores, and
      // without the check a missing method turns an OPTIONAL feature into a
      // failed boot. Absent → no live remap on a `public_port` edit, which is a
      // degraded feature rather than a dead server.
      ...(typeof runtimeConfig?.onChange === 'function'
        ? { onConfigChange: (listener) => runtimeConfig.onChange(() => { listener(); }) }
        : {}),
      log: (level, message) => {
        if (level === 'warn') console.warn(message);
        else console.log(message);
      },
    });
    portMappingSupervisorRef.start();
  }
  } catch (err) {
    portMappingSupervisorRef = null;
    console.warn(
      '[port-mapping] disabled: '
      + (err instanceof Error ? err.message : String(err)),
    );
  }
  // Spell out what the bind actually reaches. `0.0.0.0` serves loopback AND
  // the LAN IP; a single address serves only itself — and an operator who
  // pinned one needs to see that loopback went with it, because that is the
  // origin the bundled webclient can boot from.
  const reachable = lanBindAddress === '0.0.0.0'
    ? [...new Set(['127.0.0.1', lanAdvertisedAddress])].join(' + ')
    : lanBindAddress;
  console.log(
    `[network] LAN bind: ${lanBindAddress} (reachable at ${reachable};`
    + ` source=${lanResolution.source}; candidates=${lanResolution.candidates.length})`,
  );
  // Loud, standing, and actionable: a silently-dropped override reads exactly
  // like one that was never saved. Names the value, why it lost, and what the
  // machine actually offers.
  if (lanResolution.override_ignored) {
    console.warn(
      `[network] ignoring network.lan_bind_address='${lanResolution.override_ignored.value}'`
      + ` — this machine has no such address (reason=${lanResolution.override_ignored.reason}).`
      + ` Bound ${lanBindAddress} instead.`
      + (lanResolution.candidates.length > 0
        ? ` Available: ${lanResolution.candidates.map((c) => `${c.address} (${c.iface})`).join(', ')}.`
        : ''),
    );
  }

  // Cert holder starts empty — TLS-on-public is configured at a later
  // bind phase (Pro ACME flow / BYO upload via § A.6.3 TLSDomainStore).
  // Public listener binds plaintext when the holder is empty (upstream
  // proxy mode) or never binds if no path's `public` bit is true.
  const certChain = createCertChainHolder(null);
  // ⚠ The same value the port mapping is derived from — see `boundPublicPort`.
  const publicPort = boundPublicPort;
  const tlsDomainStore = tlsDomainDeps?.getStore();
  const hostnameBindingLookup = tlsDomainStore
    ? createHostnameSniBindingLookup(storage.hostnameRegistryStore)
    : undefined;

  const listenerCoordinator = createProductionPathListenerCoordinator({
    handlers: serverHandlerSet.handlers,
    upgradeHandlers: serverHandlerSet.upgradeHandlers,
    legacyAliases: serverHandlerSet.legacyAliases,
    // D-148 FU#7 — bare-302 root redirect handler. The coordinator
    // threads this onto the public listener via `PathListenerSetOptions.rootHandler`
    // on every rebuild; LAN listener never sees it (the path-router
    // gates it with `listener === 'public'`). Absent → public-listener
    // bare `/` 404s as it did pre-FU#7.
    ...(serverHandlerSet.rootHandler
      ? { rootHandler: serverHandlerSet.rootHandler }
      : {}),
    // Offline-pairing convenience — the LAN bare-`/` handler (mirror of
    // `rootHandler`, LAN-scoped). Present only when a verified webclient
    // bundle loaded at boot; the coordinator threads it onto the LAN
    // listener so a self-hoster's `http://localhost:<port>/` 302-redirects
    // to `/webclient/` to pair offline. Absent → LAN bare `/` 404s.
    ...(serverHandlerSet.lanRootHandler
      ? { lanRootHandler: serverHandlerSet.lanRootHandler }
      : {}),
    // R26.2 Delta 3 — the webclient bundle handler is now a normal
    // `webclient` entry in `serverHandlerSet.handlers` (forwarded via the
    // `handlers` line above), gated by the per-listener
    // `resolution.webclient` grid bit. No separate threading + no
    // structural LAN-only carve-out.
    cert_chain: certChain,
    ...(hostnameBindingLookup ? { hostname_binding_lookup: hostnameBindingLookup } : {}),
    ...(tlsDomainStore
      ? { tls_domain_lookup: (servername: string) => tlsDomainStore.lookup(servername) }
      : {}),
    lan_port: port,
    // Public listener port defaults to 443 unless overridden in
    // recued.config. The persisted exposure state's `public` bits are
    // false at first boot (lan_only), so this listener doesn't actually
    // bind until the user toggles.
    public_port: publicPort,
    log: (level, msg, data) => {
      const fn =
        level === 'error'
          ? console.error
          : level === 'warn'
            ? console.warn
            : console.log;
      fn(`[listener] ${msg}`, data ?? '');
    },
  });

  // ── a live `public_port` edit moves the listener ────────────────────────
  //
  // ⛔⛔ THE PORT IS THE ONE SETTING WHOSE WHOLE POINT IS TO MOVE. A self-hoster
  // putting Recued behind an existing web server needs 443 free; telling them to
  // restart for it — as this did until today — makes the setting useless on a
  // machine they cannot casually bounce.
  //
  // ⚠ ONLY `boundPublicPort` MOVES ON SUCCESS. The rebind can fail (the new port
  // is taken, privileged, or the machine refuses it), and `startListener`
  // records that rather than throwing. If the advertised port followed the
  // CONFIG instead of the BIND, a failed move would leave three surfaces
  // publishing an address nothing serves — which is the original defect, from
  // the other direction.
  //
  // ⚠ NON-FATAL, like every other optional block here: a throw while rebinding
  // must not take down a server that is currently serving.
  if (runtimeConfig !== undefined && typeof runtimeConfig.onChange === 'function') {
    runtimeConfig.onChange(() => {
      const wanted = runtimeConfig.get('public_port') as number;
      if (typeof wanted !== 'number' || wanted === boundPublicPort) return;
      void (async () => {
        try {
          // ⚠ THE LIVE RESOLUTION, not a remembered one. `applyResolution`
          // rewrites the shared table, so passing a stale copy would silently
          // revert whatever exposure change happened since.
          const machine = exposureDeps?.getMachine();
          if (machine === undefined) return;
          const { resolution } = await machine.current();
          const statuses = await listenerCoordinator.apply({
            resolution,
            bind_addresses: { lan: lanBindAddress, public: lanBindAddress },
            ports: { public: wanted },
          });
          if (statuses.public.listening) {
            boundPublicPort = wanted;
            console.log(`[listener] public port moved to ${String(wanted)}`);
          } else {
            // ⛔ NOT ADOPTED. Everything downstream keeps advertising — and the
            // router mapping keeps pointing at — the port still being served.
            console.warn(
              `[listener] public port ${String(wanted)} did not bind`
              + ` (${statuses.public.failure ?? 'unknown'}); still on `
              + `${String(boundPublicPort)}`,
            );
          }
        } catch (err) {
          console.warn('[listener] public port change failed', err);
        }
      })();
    });
  }

  // Start only after every handler and listener dependency has composed. If a
  // later constructor above throws, no polling timer survives failed startup.
  await messengerIngressSupervisor?.start();
  webhookOutboxRuntime?.start();
  savedDataViewAlerts?.start();

  let closePromise: Promise<void> | undefined;
  const closeServer = (): Promise<void> => {
    if (closePromise) return closePromise;
    const begin = (stop: () => void | Promise<void>): Promise<void> => {
      try { return Promise.resolve(stop()); }
      catch (err) { return Promise.reject(err); }
    };
    // Close every independent admission door before waiting for a potentially
    // slow or failed sibling. Database teardown happens later in lifecycle;
    // report failures only after every network/background branch has drained.
    const drains = [
      ...(savedDataViewAlerts ? [begin(() => savedDataViewAlerts.stop())] : []),
      ...(webhookOutboxRuntime ? [begin(() => webhookOutboxRuntime.stop())] : []),
      ...(messengerIngressSupervisor
        ? [begin(() => messengerIngressSupervisor.stop())]
        : []),
      begin(() => inboundEmailAnswer.dispose()),
      begin(() => serverHandlerSet.close()),
      begin(() => listenerCoordinator.stop()),
      // ⛔⛔ THE PORT-MAPPING SUPERVISOR WAS STARTED AND NEVER STOPPED. Its
      // renewal timer and its runtime-config subscription outlived listener
      // teardown, so a reconcile could still be in flight — talking to a router,
      // then writing its record — while the database it writes to was being
      // closed underneath it. And a process that stays alive after `closeServer`
      // kept renewing a mapping for a server that no longer serves.
      //
      // ⚠ `stop()` DELIBERATELY DOES NOT RELEASE THE MAPPING. D-273 lets the
      // lease expire instead, because the process is not reliably alive at this
      // point anyway. This drains OUR side: admission, timers, subscription.
      ...(portMappingSupervisorRef !== null
        ? [begin(() => { portMappingSupervisorRef?.stop(); })]
        : []),
    ];
    closePromise = Promise.allSettled(drains).then((results) => {
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .flatMap((result) => result.reason instanceof AggregateError
          ? result.reason.errors
          : [result.reason]);
      if (errors.length > 0) {
        throw new AggregateError(errors, 'listener runtime teardown failed');
      }
    });
    return closePromise;
  };

  // Surface a `RunningServer`-shaped facade so the remaining serve
  // orchestration keeps reading `server.wsServer` / `server.port` /
  // `server.close` unchanged. The port getter observes the coordinator
  // after exposure finalization starts the LAN listener.
  const server: ListenerServerFacade = {
    wsServer: serverHandlerSet.wsHandle,
    get port(): number {
      const lanStatus = listenerCoordinator
        .status()
        .find((s) => s.listener === 'lan');
      return lanStatus?.port ?? port;
    },
    close: closeServer,
  };

  return {
    serverHandlerSet,
    listenerCoordinator,
    lanBindAddress,
    lanAdvertisedAddress,
    webclientServed: webclientBundle != null,
    server,
    eventTriggerDispatcher: eventTriggersBundle?.dispatcher,
    watchManager: watchBundle?.manager,
    messengerIngressSupervisor,
    runUpdateBootReconcile,
    mcpPackFirstMintDeps,
  };
};
