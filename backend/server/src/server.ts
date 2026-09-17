/** Thin Node http server — minimal HTTP surface for recued-server.
 *
 *  All extension↔server method calls (execute, schedules CRUD) flow over
 *  the WebSocket via rpc envelope (see ws-server.ts). HTTP exists only
 *  for what cannot be WS:
 *
 *    POST   /auth/pair         — pair entry. Accepts `code` (CLI-issued)
 *                                and/or `recoveryKey`. On a fresh server
 *                                `code` is required (proof of console
 *                                access); once the realm is enrolled,
 *                                `recoveryKey` alone suffices (recovery
 *                                from lost code) and `code` becomes
 *                                optional. The two collapsed the prior
 *                                `/auth/recover-pair` endpoint into one
 *                                pair entry per D-121 Phase 5.
 *    GET    /health            — pre-auth liveness probe
 *
 *  Schedules are INSTANCE-LOCAL: this server owns its own schedule list
 *  and its own cron loop. No mirroring to cloud or other servers. The
 *  extension aggregates schedules from each connected instance for
 *  display but never arbitrates firing.
 */

import { type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import {
  createCertChainHolder,
  createPathListenerSet,
  DEFAULT_PUBLIC_PORT,
  type PathListenerSet,
  type PathRouterLegacyAlias,
  type PortRequestHandler,
  type PortUpgradeHandler,
} from '@recued/server-tls';
import type { PathResolution, PathRole, RootApexMode, TLSDomainStore } from '@recued/contracts';
import { DEFAULT_ROOT_APEX_MODE } from '@recued/contracts';
import {
  IDENTITY_PROBE_PATH,
  buildIdentityProbePayload,
  isIdentityProbeRequest,
} from '@recued/contracts';
import type { HandlerResult } from './types.js';
import type { ExecuteHandlerDeps } from './execute-handler.js';
import { createWebSocketUpgrade, SELF_HOST_OWNER_ID, type WsServerHandle } from './ws-server.js';
import { createReceptionPortHandler } from './ports/reception/handler.js';
import { createVendorOAuthCompletePortHandler } from './connection-vendor-oauth-complete-port.js';
import { createAskLandingPortHandler } from './ask-landing-port.js';
import {
  createMcpPortHandler,
  type McpSubscriptionsPort,
  MCP_RATE_LIMIT_PER_MIN,
  MCP_RATE_LIMIT_WINDOW_MS,
  type McpBearerVerifier,
  type McpCatalogDispatch,
  type McpConcurrencyLimitResolver,
  type McpDispatch,
} from './ports/mcp/handler.js';
import {
  createLlmGatewayPortHandler,
  type LlmGatewayHandlerDeps,
} from './ports/llm-gateway/handler.js';
import { createRateLimiter, type RateLimiter } from './ports/common/rate-limit.js';
import {
  createRootApexHandler,
  createLanWebclientRootHandler,
} from './root-redirect-handler.js';
import { createWebclientBundleHandler } from './webclient-handler.js';
import type { WebclientBundleFile, WebclientBundleManifest } from '@recued/contracts';
import { createHostnameSniBindingLookup } from './hostname/index.js';
import type { PairingManager } from './pairing.js';
import { isClientKind, type ClientKind } from './pairing/client-tokens.js';
import { handlePassportFetch } from './passport/fetch-handler.js';
import type { ScheduleHandlerDeps } from './schedule-handler.js';
import type { CacheRpcDeps } from './cache-rpc-handler.js';
import type { AuthDeps } from './auth-handler.js';
import type { MigrateDeps } from './migration/auth-migrate-handler.js';
import type { LLMConfigManager } from './llm-config.js';
import type {
  AdapterRegistry,
  EmbeddingsAdapterRegistry,
  TranscriptionAdapterRegistry,
  QuotaTracker,
} from '@recued/llm';
import type { RuntimeConfigStore } from '@recued/config';
import type { ChatInboundTokenStore } from './storage/chat-inbound-token-store.js';
import type { ContractStore } from './storage/contract-store.js';
import type { SellerOrderStore } from './storage/seller-order-store.js';
import type { SellerStore } from './storage/seller-store.js';
import type { SellerClaimStore } from './storage/seller-claim-store.js';

export interface RunningServer {
  server: Server;
  /** Actual port the server is listening on (useful when `port = 0`). */
  port: number;
  /** WebSocket handle — pair-sync, chat delegation, rpc dispatch. */
  wsServer: WsServerHandle;
  close(): Promise<void>;
}

export interface ServerConfig {
  now?: () => number;
  /** Recipe execution dependencies. Forwarded to the WS server so
   *  rpc('execute') can dispatch. */
  executeDeps?: ExecuteHandlerDeps;
  /** Pairing manager for extension ↔ server auth. */
  pairing?: PairingManager;
  /** Schedule CRUD dependencies. Forwarded to the WS server so
   *  rpc('schedules.*') can dispatch. */
  scheduleDeps?: ScheduleHandlerDeps;
  /** D-179 P1 — dish CRUD dependencies. Forwarded to the WS server so
   *  rpc('dishes.*') can dispatch. */
  dishDeps?: import('./dish-handler.js').DishHandlerDeps;
  /** Event-trigger CRUD dependencies (reactive-substrate slice 1).
   *  Forwarded to the WS server so rpc('triggers.*') can dispatch.
   *  Composed by `wire-event-triggers.ts` in production — before that
   *  composer existed, ws-server accepted this field but nothing
   *  constructed it (the D-167 P5 Slice 2b silent-dead-surface trap). */
  triggersDeps?: import('./triggers/handler.js').TriggersRpcDeps;
  /** "Watch this element" dom-watch affordance rpc dependencies.
   *  Forwarded to the WS server so rpc('triggers.createElementWatch') can
   *  dispatch — scaffolds + saves a local notify recipe; the reconciler
   *  materializes the watch trigger DISARMED (the user arms it in
   *  #automation). Composed in `compose-listeners.ts` against the recipe store. */
  elementWatchDeps?: import('./element-watch-handler.js').ElementWatchRpcDeps;
  /** Auto-run arm/disarm rpc dependencies (reactive-substrate slice 1).
   *  Forwarded to the WS server so rpc('auto_run.*') can dispatch. */
  autoRunDeps?: import('./auto-run-handler.js').AutoRunRpcDeps;
  /** Watch pause/resume rpc dependencies (poll-manager / G6).
   *  Forwarded to the WS server so rpc('watch.*') can dispatch. */
  watchDeps?: import('./watch/handler.js').WatchRpcDeps;
  /** Cache rpc dependencies. Forwarded to the WS server so
   *  rpc('cache.*') can dispatch. */
  cacheDeps?: CacheRpcDeps;
  /** Shared-store rpc dependencies (D-103 Phase A). Forwarded so
   *  rpc('shared.*') can dispatch against the durable data.shared.*
   *  store. */
  sharedDeps?: import('./shared-handler.js').SharedRpcDeps;
  /** Auth rpc dependencies. Forwarded to the WS server so
   *  rpc('auth.*') can dispatch. */
  authDeps?: AuthDeps;
  /** Migrate rpc dependencies. */
  migrateDeps?: MigrateDeps;
  /** LLM config manager. Enables server.getLLMConfig / server.setLLMConfig
   *  over the pair WS — the primary provisioning path for the paired
   *  extension's Server LLM settings panel. */
  llmConfigManager?: LLMConfigManager;
  /** Test connection — the config rpc slice's only execution deps (adapter
   *  registry + quota tracker). Absent answers `unavailable` rather than
   *  pretending it probed. */
  llmProbe?: {
    adapters: AdapterRegistry;
    quota: QuotaTracker;
    embeddingsAdapters?: EmbeddingsAdapterRegistry;
    /** D-262 § B7 — transcription is `transcribe`, a third provider call. */
    transcriptionAdapters?: TranscriptionAdapterRegistry;
  };
  /** D-196 S2 — local seller substrate for the Settings -> Seller overview. */
  sellerStore?: SellerStore;
  /** D-207 order-is-the-lifecycle — `core.seller.order` read store for the
   *  owner Orders view (`server.seller.listOrders`). */
  sellerOrderStore?: SellerOrderStore;
  /** D-196 S2 — contract substrate for manual customer issue/extend. */
  sellerContractStore?: ContractStore;
  /** D-196 S2 — inbound token substrate for manual customer issue/extend. */
  sellerInboundTokenStore?: ChatInboundTokenStore;
  /** D-196 S3c — sealed one-time claim substrate for bearer delivery. */
  sellerClaimStore?: SellerClaimStore;
  /** Runtime config store (D-103 Phase A). Backs the non-LLM half of
   *  `server.getConfigSchema` / `server.setConfigField` — vault quotas,
   *  log levels, scheduler minimums, etc. Omitting it narrows the
   *  schema to the LLM fields only (legacy / test compositions). */
  runtimeConfig?: RuntimeConfigStore;
  /** Bootstrap / status deps (D-103 Phase A). Backs
   *  `server.getBootstrap` / `stageBootstrap` / `requestRestart` /
   *  `getStatus` / `setPaused` / `getPauseState`. Absent → those
   *  rpc methods return `not_configured`. */
  bootstrapDeps?: import('./bootstrap-handler.js').BootstrapHandlerDeps;
  /** Server's stable id (UUID), persisted in SQLite. Sent to the ext on
   *  the `registered` WS response and used as `sid` on the server's
   *  heartbeat emission. Address-independent identity — the same server
   *  reached via localhost / LAN IP / Tailscale shares one id. */
  serverId?: string;
  /** Durable paired-device roster. Backs `pair.list` / `pair.revoke`
   *  RPCs. Without it, the "new device or replace" UX can't fetch the
   *  account's device list; ext-side UX falls back to register-with-
   *  intent only (no picker). */
  pairedInstances?: import('./paired-instances-store.js').PairedInstancesStore;
  /** D-148 § A.2.1 — signed-wrapper audit sink for `pair.revoke`'s
   *  high-assurance `pair_revoke` row emission. bin.ts threads its
   *  `createSigningAuditLog`-wrapped store so the Ed25519 signature
   *  + reserve flag land at emit time. Optional; absence is a no-op
   *  (rpc still revokes the device + closes the ws). */
  pairRevokeAuditLog?: Pick<import('@recued/storage').AuditLogStore, 'logActivity'>;
  /** D-175 P5 — recued.com account-binding handler deps. Backs the
   *  `account.bind` / `account.unbind` / `account.bindingStatus` RPCs.
   *  Built in `compose-storage-context.ts` against the booted signing
   *  identity + signed audit sink, forwarded here by composeListeners.
   *  Absent → those methods return `not_configured`. */
  accountBindingDeps?: import('./account-binding-handler.js').AccountBindingHandlerDeps;
  /** D-175 P8 — Pro convenience status handler deps. Backs the
   *  `pro_convenience.status` RPC (secret-free per-item {handle, ddns,
   *  acme} state). Built in `compose-storage-context.ts`, forwarded here
   *  by composeListeners. Absent → the method returns `not_configured`. */
  proConvenienceDeps?: import('./pro-convenience-handler.js').ProConvenienceHandlerDeps;
  /** R27 delta-B — DDNS pause/resume handler deps. Backs `ddns.status` /
   *  `ddns.setEnabled` (the server-local publish flag + cloud-pause call).
   *  Built in `compose-storage-context.ts`, forwarded here by composeListeners.
   *  Absent → the methods return `not_configured`. */
  ddnsDeps?: import('./ddns-handler.js').DdnsHandlerDeps;
  /** Realm-scoped recovery-key check store. Enables the
   *  `pair.registerRecoveryKey` RPC: first call enrolls the realm
   *  with a sealed sentinel; every subsequent call must supply the
   *  same recovery key. Without it, the rpc returns `not_configured`. */
  recoveryKeyCheck?: import('./recovery-key-store.js').RecoveryKeyCheckStore;
  /** Encryption handles for the `pair.registerRecoveryKey` WS door, so it
   *  turns at-rest encryption on exactly as `/auth/pair` does. Forwarded
   *  straight through to the ws server. */
  recoveryVaultDeps?: import('./recovery-key-processor.js').RecoveryVaultDeps;
  /** Slice 3b — the KeyManager, for first-boot server-vault enrollment at
   *  `/auth/pair`: turn on real at-rest encryption from the confirmed
   *  recovery key (dual-wrap Master DEK under the keyfile server key +
   *  the recovery key). Absent on db-less / test compositions ⇒
   *  enrollment is skipped (the legacy sentinel-only path). */
  keys?: import('./key-manager.js').KeyManager;
  /** D-212 slice 3 — the live multiple-ciphers handle. First recovery-key
   *  enrollment rekeys this exact connection before the realm gate opens. */
  database?: import('better-sqlite3').Database;
  /** Slice 3b — live keyfile `ServerKeyStore` getter (read at call time;
   *  the signing identity boots lazily). Paired with `keys` to persist
   *  the server vault key during enrollment. */
  getServerKeyStore?: () => import('./keys/index.js').ServerKeyStore | undefined;
  /** D-148 § A.2.1 — `ClientTokenStore.verify` / `touch` slice used by
   *  the WS-handshake bearer-validation tightening path. When present,
   *  upgrade calls bearing the structured `<token_id>.<bearer>` shape
   *  are matched against `client_tokens` BEFORE socket acceptance; the
   *  resolved `token_id` lands on `WsClient.client_token_id` so the
   *  `pair_revoke` audit row's `detail.client_token_id` join column
   *  auto-populates. When present, non-canonical raw bearers reject at
   *  upgrade; absent db-less harnesses retain the legacy accept-any
   *  path. */
  clientTokens?: Pick<
    import('./pairing/client-tokens.js').ClientTokenStore,
    'issue' | 'verify' | 'touch' | 'list' | 'revoke'
  >;
  /** Phase B pressure admin deps. Backs
   *  `server.runPressureReclaim` / `server.setPressureOverride`. */
  pressureDeps?: import('./pressure-handler.js').PressureHandlerDeps;
  /** Phase C lifecycle handler slice. When provided, the three
   *  lifecycle rpc methods (`server.requestShutdown` /
   *  `server.getLifecycleState` / `server.resetCrashLoop`) dispatch. */
  lifecycleHandlers?: import('@recued/contracts').AnyHandlerSlice<import('@recued/contracts').ServerRpcRegistry, import('./ws-server.js').WsClient>;
  /** Phase C lifecycle-state getter. When provided, the rpc
   *  dispatcher gates non-exempt rpc calls while state is not
   *  `running`. See `LIFECYCLE_ALLOWED_METHODS`. */
  lifecycleState?: () => import('@recued/contracts').LifecycleState;
  /** Phase D collection rpc deps (D-106). Backs `collection.list` /
   *  `search` / `get` / `runRetention` / `listEndpoints`. When
   *  absent, those methods return `not_configured`. */
  collectionDeps?: import('./collections/collection-handler.js').CollectionHandlerDeps;
  /** D-115 Phase 6C `/hook/{recipe_id}/{slug}` listener. Same gate
   *  as the Phase D webhook listener below — only mounted when
   *  `webhook_port>0` so self-hosters must bring their own public
   *  address. Enqueues into the webhook-watcher queue consumed by
   *  reactive recipes' `trigger_steps`. */
  hookListener?: import('./watchers/webhook-hook-listener.js').HookRequestHandler;
  /** Phase D webhook listener (D-106). When wired, enables
   *  `POST /webhook/{slug}`. bin.ts wires this only when
   *  `public_reachable=true` AND `webhook_port>0` — D-096 keeps
   *  webhook ingestion self-host-only. Absent → POST /webhook/*
   *  returns 404 like any other unknown route. */
  webhookListener?: import('./collections/webhook/webhook-listener.js').WebhookRequestHandler;
  /** D-201 Slice 2/5A — opaque profile route `/v1/webhooks/<public-id>`.
   * Production supplies this only with the durable binding-aware consumer and
   * admitted code-backed profile subset. The listener stays on a generic 404
   * floor until that consumer reports started. */
  webhookProfileListener?: import('./webhook-profile-listener.js').WebhookProfileRequestHandler;
  /** D-128 P3 — `POST /v1/connection/webhook/<vendor>/<connection_name>`
   *  receiver for vendor-pushed reconciliation events (HubSpot,
   *  Salesforce, etc.). bin.ts mounts this only when the operator
   *  has set `public_reachable=true` — D-097 keeps inbound webhooks
   *  off the cloud relay. The funnel inside the listener does the
   *  HMAC verify, dedup, and synthetic warehouse-event emission;
   *  this slot is the HTTP plumbing that hands off to it. Absent →
   *  POSTs to that path return 404 like any unknown route. */
  connectionWebhookListener?: import('./connection-webhook-listener.js').ConnectionWebhookRequestHandler;
  /** D-148 P9 § A.13 — `POST /webhooks/<vendor>/<connection_name>`
   *  vendor port for Slack + Telegram bot callbacks. Same
   *  `webhook_port > 0` gate as `webhookListener` (D-096 keeps inbound
   *  webhooks self-host-only). The handler does its own internal
   *  vendor-prefix matching + signature verification + idempotency
   *  ledger dedup; this slot is the path-router branch that delegates
   *  any `/webhooks/*` POST to it. Absent → `/webhooks/*` falls through
   *  to the floor 404, preserving the spec's "don't fingerprint which
   *  vendors are wired" posture. */
  vendorWebhookListener?: import('./composition/bin/wire-vendor-webhook-port.js').VendorWebhookPortHandler;
  /** D-115 Phase 6D — `runtime.runWatcher` rpc deps. Backs the pair-
   *  rpc forwarder the extension's local watcher dispatcher uses for
   *  warehouse-routed slugs (mail / file / calendar / webhook).
   *  Absent → the rpc returns `not_configured` and the ext kernel
   *  adapter surfaces it as `SERVER_NOT_REACHABLE` for those slugs. */
  watcherRpcDeps?: import('./watcher-rpc-handler.js').WatcherRpcDeps;
  /** D-116 Phase 3 — `runtime.testTrigger` rpc deps. Backs Kitchen's
   *  warehouse-routed trigger-test forward. Shares the same watcher
   *  dispatcher binding as `runtime.runWatcher`. Absent → the rpc
   *  returns `not_configured`. */
  triggerTestRpcDeps?: import('./trigger-test-rpc-handler.js').TriggerTestRpcDeps;
  /** D-116 follow-up — `/status` + `/status.json` HTML/JSON mirror of
   *  the auto-disabled list. Bearer-token gated. Absent → both routes
   *  return 404. */
  statusPageDeps?: import('./status-page.js').StatusPageDeps;
  /** D-119 Phase 5 — `recipe.list` rpc deps. Backs the extension's
   *  server-scope sidebar (the recipe list shown when the user picks
   *  the paired server in the Devices Dropdown). Absent → returns
   *  `not_configured`. */
  recipeListDeps?: import('./recipe-list-handler.js').RecipeListHandlerDeps;
  /** D-201 Slice 5B1 — Kitchen recipe save plus disarmed webhook binding and
   * explicit local-recipe arm/disarm authority. */
  recipeSaveDeps?: import('./recipe-save-handler.js').RecipeSaveHandlerDeps;
  /** R2 build step 4c.1 — `recipe.runnability` rpc deps. Backs the webclient
   *  recipes view's derived-runnability disclosure ("born blocked — add a
   *  provider"). Absent → `not_configured` (same posture as `recipe.list`). */
  recipeRunnabilityDeps?: import('./recipe-runnability-handler.js').RecipeRunnabilityHandlerDeps;
  /** D-119 Phase 10 — approval rpc deps. Backs cross-device approval
   *  sync. Absent → those rpc methods return `not_configured` and
   *  paired extensions fall back to local-only approval state. */
  approvalDeps?: import('./approval-handler.js').ApprovalHandlerDeps;
  /** D-120 Phase 7 — unified memory export rpc deps. Backs
   *  `audit.export.estimate` + `audit.export.page`, the dialog the
   *  extension's Memory tab (server scope) drives. Absent → those rpc
   *  methods return `not_configured`. */
  auditExportDeps?: import('./audit-export-handler.js').AuditExportRpcDeps;
  /** D-174 Runs/Audit rpc deps. Backs `execution.list` /
   *  `execution.get` for the webclient Runs route. Absent → those
   *  methods return `not_configured`. */
  executionFeedDeps?: import('./execution-feed-handler.js').ExecutionFeedRpcDeps;
  /** D-121 Phase 6 — realtime broadcast bus deps. Wires the
   *  `events.subscribe` rpc + per-client subscription teardown on
   *  WS close. The bus itself is composed in bin.ts and every emit
   *  site captures it via the relevant handler deps. */
  eventsDeps?: { bus: import('./events/bus.js').EventBus };
  /** D-122 Phase 4.5 — enrichment substrate rpc. Wires
   *  `enrichment.{upsert,list}`. Absent → those rpc methods return
   *  `not_configured`. */
  enrichmentDeps?: import('./enrichment-handler.js').EnrichmentRpcDeps;
  /** D-122 Phase 4.5 — generic notification rpc. */
  notificationDeps?: import('./notification-handler.js').NotificationDeps;
  /** D-122 Phase 4.5 — `mail.get` rpc. */
  mailGetDeps?: import('./mail-get-handler.js').MailGetDeps;
  /** D-123 Phase 5 — housekeeping rpc deps. Backs the Settings →
   *  Server → Housekeeping panel. */
  housekeepingDeps?: import('./housekeeping-handler.js').HousekeepingRpcDeps;
  /** D-250 § D7 — `metric.read`. ⛔ SAME FORWARD-OR-DEAD-RPC SEAM as `archiveDeps`:
   *  composed in `compose-listeners.ts`, but this file forwards each dep EXPLICITLY, so
   *  omitting it here leaves the method answering `not_configured` on the live wire while
   *  every handler and runtime unit test passes. Pinned by `archive-rpc-wiring.test.ts`. */
  metricDeps?: import('./metrics-handler.js').MetricRpcDeps;
  // ── rpc-deps forward completion (D-167 P5 Slice 2b drive-by) ──────
  // The seven families below were composed in `composeRpcContext` and
  // passed by `composeListeners`, but never declared here nor forwarded
  // into the WS upgrade — so they were silently dropped (TS skips
  // excess-property checks on the conditional spreads `composeListeners`
  // uses), leaving every one of their rpcs at `not_configured` since the
  // D-159 bin→compose-* extraction. `housekeepingDeps` was the last
  // family wired through this file; these landed after it. Declaring +
  // forwarding them (below) completes the chain. No production / unit
  // test exercised the real `createServerHandlerSet` → ws-dispatch path,
  // which is why the drop stayed invisible.
  /** D-139 — engagement-health rpc deps. */
  engagementHealthDeps?: import('./engagement-health-handler.js').EngagementHealthDeps;
  /** D-145 PA10 — `packs.install` rpc deps. */
  packInstallDeps?: import('./pack-install-handler.js').PackInstallRpcDeps;
  /** D-145 PA10 — `packs.list` rpc deps. */
  packListDeps?: import('./pack-list-handler.js').PackListRpcDeps;
  /** D-145 PA10 Slice B — `packs.uninstall` rpc deps. */
  packUninstallDeps?: import('./pack-uninstall-handler.js').PackUninstallRpcDeps;
  /** D-170 — `ingredient.install` / `ingredient.uninstall` rpc deps. */
  ingredientAuthoringDeps?: import('./ingredient-authoring/install-rpc.js').IngredientAuthoringRpcDeps;
  /** D-170 N.4 / N.15 / #2 — `ingredient.draft.*`,
   *  `ingredient.preview`, and `ingredient.compose.decompose` rpc deps. */
  ingredientDraftDeps?: import('./ingredient-authoring/draft-preview-rpc.js').IngredientDraftRpcDeps;
  /** D-163 / D-169 — `notifications.{describe,set_channel,
   *  set_verification_phrase,set_bridge_mode}` rpc deps. */
  notificationsDeps?: import('./notifications-handler.js').NotificationRpcDeps;
  /** D-119 Phase 13 — annotation + link warehouse rpc deps. Wires
   *  `annotation.{upsert,list,delete}` + `link.{upsert,list,delete}`.
   *  Absent → those rpc methods return `not_configured`. */
  annotationDeps?: import('./annotation-handler.js').AnnotationRpcDeps;
  /** D-121 Phase 1 — `data.contact` warehouse rpc deps. Wires
   *  `contact.{upsert,list,get,delete}`. Absent → those rpc methods
   *  return `not_configured`. */
  contactDeps?: import('./contact-handler.js').ContactRpcDeps;
  /** D-145 PA11 — Settings → Work Entities Source-management rpc deps.
   *  Wires `work_entity.source.{list,set_enabled,
   *  set_default,clear_default}`. Absent → those methods return
   *  `not_configured`. (D-174 #22: this forward was missing — the deps
   *  were composed in `composeListeners` but never threaded into the WS
   *  upgrade, leaving the panel's rpc dead in production; added here
   *  alongside the new `work_entity.*` CRUD surface.) */
  workEntitySourceDeps?: import('./work-entity-source-handler.js').WorkEntitySourceRpcDeps;
  /** D-205 #2c — `contact.source.list` (per-Source contact sync health). */
  contactSourceDeps?: import('./contact-source-handler.js').ContactSourceRpcDeps;
  /** D-174 #22 — work-entity warehouse CRUD rpc deps (Data route). Wires
   *  `work_entity.{list,get,upsert,delete}` over the four own-it kinds.
   *  Absent → those methods return `not_configured`. */
  workEntityCrudDeps?: import('./work-entity-crud-handler.js').WorkEntityCrudRpcDeps;
  /** Immutable accepted intake-response reads for the owner Data browser. */
  formResponseDeps?: import('./form-response-handler.js').FormResponseRpcDeps;
  /** D-221 owner-only pack Records explorer and lifecycle rpc deps. */
  recordsRpcDeps?: import('./records-rpc-handler.js').RecordsRpcDeps;
  savedDataViewStore?: import('./saved-data-view-store.js').SavedDataViewStore;
  preapprovalDeps?: import('./preapproval-handler.js').PreapprovalHandlerDeps;
  /** D-174 #22 — `data.timeline` read pair-RPC deps (Data route
   *  drill-down). Wraps the shared `handleTimelineRequest`. Absent →
   *  the method returns `not_configured`. */
  timelineRpcDeps?: import('./timeline-rpc-handler.js').TimelineRpcDeps;
  /** D-198 Slice 1 — `memory.list` owner-trusted read pair-RPC deps (Memory
   *  lens feed). Composed in `composeListeners`; absent → the method returns
   *  `not_configured`. */
  memoryRpcDeps?: import('./memory-rpc-handler.js').MemoryRpcDeps;
  /** D-172 Half-A "open" — `data.file.read` owner read pair-RPC (Files tab
   *  open/download). Composed in `composeListeners`; absent → the method
   *  returns `not_configured`. Owner-trusted (registered-client boundary). */
  fileReadRpcDeps?: import('./file-read-rpc-handler.js').FileReadRpcDeps;
  /** D-138 Phase 1 — contact-merge substrate rpc deps. Wires
   *  `contact.merge.{list,confirm,reject,split,undo_rejection,
   *  resolve_remerge_prompt,scan_now}`. Absent → those rpc methods
   *  return `not_configured`. */
  contactMergeDeps?: import('./contact-merge-handler.js').ContactMergeRpcDeps;
  /** D-138 Phase 5 — upstream-merge outbox rpc deps. Wires
   *  `upstream_merge.{describe,request,retry,discard,list}`. Absent →
   *  those rpc methods return `not_configured`. */
  upstreamMergeDeps?: import('./upstream-merge-handler.js').UpstreamMergeRpcDeps;
  /** D-125 Phase 2.1 — connection substrate rpc deps. Wires
   *  `collection.connection.{list,enroll,update,delete,probe,
   *  completeVendorOAuth}`. Absent → those rpc methods return
   *  `not_configured`. */
  connectionDeps?: import('./connection-handler.js').ConnectionRpcDeps;
  /** D-201 Slices 1/5A/5B2B — owner-only ingress lifecycle, encrypted
   * credentials, readiness gates, and accepted/rejected delivery reads. */
  webhookIngressDeps?: import('./webhook-ingress-handler.js').WebhookIngressRpcDeps;
  /** D-166 override-write path — `collection.contract.*` rpc deps. Wires
   *  `contract.{upsert,delete,list}Override`. Absent → those rpc methods
   *  return `not_configured`. Forwarded into the WS upgrade below — without
   *  BOTH the declaration here AND the forward, `composeListeners`' spread
   *  is silently dropped (the D-167 P5 Slice 2b trap). */
  contractDeps?: import('./contract-handler.js').ContractRpcDeps;
  /** D-182 §7.2 — `cli.reachability.*` grid rpc deps. Wires
   *  `cli.reachability.{list,set}`. Absent → those rpc methods return
   *  `not_configured`. Forwarded into the WS upgrade below — without BOTH the
   *  declaration here AND the forward, `composeListeners`' spread is silently
   *  dropped (the D-167 P5 Slice 2b trap). */
  cliReachabilityDeps?: import('./cli-reachability-handler.js').CliReachabilityRpcDeps;
  /** D-269 step 1 — `server.timezone.*` rpc deps: the owner declares whether
   *  this machine stays put (`fixed`) or travels with them (`follows_host`).
   *  Same forward-or-dead-rpc trap as `cliReachabilityDeps` — BOTH this
   *  declaration AND the forward below are required. */
  serverTimeZoneDeps?: import('./server-timezone-handler.js').ServerTimeZoneRpcDeps;
  /** D-269 step 2 — `notification.kind_policy.*` rpc deps. Same
   *  forward-or-dead-rpc trap as `cliReachabilityDeps`: BOTH this declaration
   *  AND the forward below are required. */
  notificationKindPolicyDeps?: import('./notification-kind-policy-handler.js').NotificationKindPolicyRpcDeps;
  /** D-269 step 3 — `notification.quiet_hours.*`. Same forward-or-dead-rpc
   *  trap: BOTH this declaration AND the forward below are required. */
  quietHoursDeps?: import('./quiet-hours-handler.js').QuietHoursRpcDeps;
  /** Supervision feature — owner-only `supervision.*` rpc deps (cli-daemon
   *  keep-alive). `composeListeners` builds these from
   *  `collection.supervisionStack`. Same forward-or-dead-rpc trap as
   *  `cliReachabilityDeps`: BOTH this declaration AND the forward below are
   *  required, else the spread is silently dropped. */
  supervisionDeps?: import('./supervision-handler.js').SupervisionRpcDeps;
  /** D-152 — `collection.hostname.*` rpc deps. Wires hostname CRUD +
   *  ownership-proof transitions over the same registry store the SNI
   *  binding lookup reads. Absent → those rpc methods return
   *  `not_configured`. */
  hostnameDeps?: import('./hostname-handler.js').HostnameRpcDeps;
  /** LAN-URL kickstart — `network.local_urls` deps (live listen port). */
  networkDeps?: import('./network-handler.js').NetworkRpcDeps;
  /** D-273 — `network.port_mapping`. */
  portMappingDeps?: import('./network-handler.js').PortMappingRpcDeps;
  /** D-169 P0 — `bridge.capabilityProfile.push` rpc deps. Wires the
   *  per-pair `BridgeRegistry` instance that Slice 4's dispatcher
   *  pre-filters against. Absent → the rpc returns `not_configured`. */
  bridgeCapabilityDeps?: import('./bridge-capability-handler.js').BridgeCapabilityHandlerDeps;
  /** D-169 P1 — `system.status` rpc deps. Bridge side-panel section
   *  #1 reads its rich status snapshot from here on mount + each
   *  periodic refresh. Absent → the rpc surfaces `not_configured` and
   *  the side panel renders a load error. Channel-isolation via
   *  `system.` prefix in `MCP_RESERVED_RPC_PREFIXES`. */
  systemStatusDeps?: import('./system-status-handler.js').SystemStatusDeps;
  /** D-169 P2 — historical-view rpc deps (`execution.recent` /
   *  `notification.recent` / `notification.pending_asks`) the bridge side
   *  panel reads on mount + reconnect. Absent → the rpcs surface
   *  `not_configured`. Local-UI / local-bridge only (omitted from
   *  `MCP_TOOL_CATALOG`, same posture as `system.status`). */
  historyDeps?: import('./history-handler.js').HistoryDeps;
  /** D-169 P0 follow-on — same per-pair `BridgeRegistry` instance as
   *  `bridgeCapabilityDeps.registry`, threaded separately into the WS
   *  upgrade so the bearer-verify path can call `attach()` when the
   *  authenticated client is a bridge. Without this seam, capability
   *  pushes from a bridge land in a `updateCapabilities returns false`
   *  no-op (the rpc still returns `{ ok: true }`, but the registry stays
   *  empty); Slice 4's eligibility filter then has no bridges to
   *  iterate over. Absent → the upgrade skips the attach call (test
   *  compositions). Production must thread the same registry instance
   *  here AND into `bridgeCapabilityDeps.registry` so attach + push
   *  share one map. */
  bridgeRegistry?: import('./bridges/registry.js').BridgeRegistry;
  /** D-169 P0 follow-on — optional audit log for the multi-bridge
   *  `BridgeDispatcher` composed inside ws-server when `bridgeRegistry`
   *  is wired. The dispatcher reads `lastSuccessfulBridgeDispatch` for
   *  per-(bridge, pattern) recency ordering + writes
   *  `bridge_dispatch_succeeded` activity rows on success. Absent →
   *  iteration order falls back to WS-attachment recency alone. Mirrors
   *  `pairRevokeAuditLog`'s opt-in pattern. */
  bridgeDispatcherAuditLog?: import('@recued/storage').AuditLogStore;
  /** D-136 §A.13.5 P7.G — `mcp.visibility.{read,write}` rpc deps. */
  mcpVisibilityDeps?: import('./mcp-visibility-handler.js').MCPVisibilityRpcDeps;
  /** Grant-foundation slice 3 — `contract.grant.{read,read_by_entry,write}` rpc deps
   *  (the unified (contract × grant) matrix CRUD). */
  contractGrantDeps?: import('./contract-grant-handler.js').ContractGrantRpcDeps;
  /** D-148 W3.FU — `exposure.{apply_preset,set_path_resolution,
   *  set_public_mcp_acknowledgement}` rpc deps. Wires the in-process
   *  `ExposureStateMachine` so the webclient Exposure surface can drive
   *  the path-routing toggle grid. Absent → those methods return
   *  `not_configured` (e.g. test compositions that skip the state
   *  machine). */
  exposureDeps?: import('./exposure-handler.js').ExposureRpcDeps;
  /** D-148 follow-up #4 — `tls_domain.{upload,remove,list}` rpc deps.
   *  Wires the W3.6 `SqliteTlsDomainStore` so the webclient
   *  Settings → Server → TLS Certificates page can upload + remove
   *  + list per-domain certs. Absent → those methods return
   *  `not_configured` (e.g. db-less harnesses or pre-W3.6 boots that
   *  haven't composed the store yet). */
  tlsDomainDeps?: import('./tls-domain-handler.js').TlsDomainRpcDeps;
  /** D-152 P0 — hostname-registry-gated SNI dispatch. The hostname
   *  registry supplies the enabled + ownership-verified binding and TLS
   *  topology; the TLS-domain store supplies per-domain cert material. */
  hostnameSniDeps?: {
    hostnameRegistry: Pick<import('./storage/hostname-registry.js').HostnameRegistryStore, 'get'>;
    tlsDomainStore: Pick<TLSDomainStore, 'lookup'>;
  };
  /** D-148 § A.4.4 — `token.rotate` rpc deps. Wires the
   *  `createTokenRotationEmitter` orchestrator against the production
   *  `ClientTokenStore` + the D-121 `EventBus`. Absent → `token.rotate`
   *  returns `not_configured` (db-less harnesses / pre-A.4.4 boots that
   *  don't compose the emitter). Channel-isolation invariant — `token.`
   *  is in `MCP_RESERVED_RPC_PREFIXES` so MCP-channel agents cannot drive
   *  credential rotation. */
  tokenRotationDeps?: import('./pairing/token-rotation-handler.js').TokenRotationRpcDeps;
  /** D-148 § A.6.5 — `tls.renew` rpc deps. Wires the shared
   *  `RotationEngine` (cert-rotation broadcaster + signing identity +
   *  audit sink) composed in bin.ts. Absent → `tls.renew` returns
   *  `not_configured` (db-less harnesses, or boots where
   *  `db && auditLog` doesn't hold so the engine never composes).
   *  Channel-isolation invariant — `tls.` is in
   *  `MCP_RESERVED_RPC_PREFIXES` so MCP-channel agents cannot
   *  drive TLS cert rotation. */
  tlsRenewDeps?: import('./keys/rotation/tls-renew-handler.js').TlsRenewRpcDeps;
  /** D-148 § A.6.5 + § A.9 — `passport.fetch` rpc deps. Wires the
   *  webclient post-WS-connect verify path against the passport
   *  block-providers + `server_identity_key` keypair. Absent →
   *  `passport.fetch` returns `not_configured` (db-less harness, or a
   *  boot where the production passport-block-provider substrate
   *  hasn't been composed yet). Channel-isolation invariant —
   *  `passport.` is in `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel
   *  agents cannot fetch the passport projection. */
  passportFetchDeps?: import('./passport/fetch-handler.js').PassportFetchRpcDeps;
  /** D-148 — pre-auth identity probe deps (`POST /auth/identity-probe`).
   *  Absent → the route 404s exactly as an unknown path would, which is the
   *  same answer a fingerprint mismatch gets, so a scanner cannot tell a
   *  server without the feature from one that is not the server it wanted.
   *
   *  ⛔ `sign` MUST be handed the output of `buildIdentityProbePayload` and
   *  nothing else. It is `signWithServerIdentity`, whose key also signs DDNS
   *  updates and ACME requests — signing a caller-supplied string here would
   *  be a DNS-takeover oracle. See `packages/contracts/src/identity-probe.ts`. */
  identityProbeDeps?: {
    /** Current `server_identity_key` — public half + its `sha256:<hex>`
     *  fingerprint. Read per request rather than captured, so a key rotation
     *  takes effect without a restart. */
    serverIdentityKey: () => { public_key_b64: string; public_key_fingerprint: string };
    sign: (payload: string) => string;
  };
  /** R26.4 Delta 2 (D-148 § A.9 P8) — `passport.export` +
   *  `passport.history.list` rpc deps (the user-initiated half). Absent →
   *  both return `not_configured` (db-less harness, or a boot whose audit
   *  log hasn't composed). Channel-isolation invariant — `passport.` is
   *  in `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel agents cannot mint a
   *  passport nor enumerate export history. */
  passportUserRpcDeps?: import('./passport/export-handler.js').PassportUserRpcDeps;
  /** R26.4 Delta 3 (D-148 § A.11 / § P7) — `key.rotate` + `key.health`
   *  rpc deps (Settings → Server → Key Health). Wires the same composed
   *  rotation engine + the compromise-ledger-backed health view. Absent →
   *  both return `not_configured` (db-less harness, or a boot without the
   *  rotation engine). Channel-isolation invariant — `key.` is in
   *  `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel agents cannot rotate
   *  keys nor read the key-health posture. */
  keyRotateDeps?: import('./keys/rotation/key-rotate-handler.js').KeyRotationRpcDeps;
  // D-156 P9 retired `pairMintDeps` + `pairConsumeDeps` — the pair-blob
  // substrate is gone; CLI `recued-server pair` is the sole pair path.
  /** D-148 § A.5.3 / § A.6.5 — `pro.*` rpc deps. Wires the per-pair
   *  `ProAuthStateMachine` composed in bin.ts (SQLite-backed store +
   *  `onStateChanged` listener that flips the ACME factory's
   *  `ProAuthResolver` ref). Absent → all three `pro.*` methods
   *  return `not_configured` (db-less harness). Channel-isolation
   *  invariant — `pro.` is in `MCP_RESERVED_RPC_PREFIXES`, so
   *  MCP-channel agents cannot mutate or read subscription bearer
   *  state. */
  proAuthDeps?: import('./pro-auth/handler.js').ProAuthRpcDeps;
  /** D-127 wire-up — `server.getOAuthClientConfig` deps. Returns the
   *  per-provider public client_id so the extension can build
   *  authorize URLs. Secrets stay on the server. Absent → the rpc
   *  returns `not_configured`. */
  oauthClientConfigDeps?: import('./oauth-client-config-handler.js').OAuthClientConfigDeps;
  /** BYO OAuth app config rpc deps (server.{get,set,clear}OAuthAppConfig). */
  oauthAppConfigDeps?: import('./oauth-app-config-handler.js').OAuthAppConfigHandlerDeps;
  /** D-145 PB12 — `s2s_preview.{build,consume}` rpc deps. Backs the
   *  Peer-Recued Preview consumer surface (peer-MCP-future + D-149
   *  reception both consume the same substrate). Absent → those
   *  methods return `not_configured` (db-less harnesses /
   *  pre-PB12 boots). */
  s2sPreviewDeps?: import('./s2s-preview/handlers.js').S2SPreviewRpcDeps;
  /** D-149 P3 § A.3 — Public Reception registry rpc deps. Wires the
   *  ten `reception.*` admin-only methods against the per-pair
   *  `PublicEndpointRegistryStore`. Absent → those methods return
   *  `not_configured`. Channel-isolation invariant — `reception.*`
   *  prefix is reserved (`MCP_RESERVED_RPC_PREFIXES`). */
  receptionRpcDeps?: import('./reception-rpc-handler.js').ReceptionRpcDeps;
  /** D-149 P3 § A.2 — Reception path-handler deps for visitor traffic.
   *  Wires the `createReceptionPortHandler` registry-aware branch
   *  (token presentation, per-IP rate limit, registry cache lookup,
   *  per-kind handler dispatch). Absent → the path-router keeps
   *  returning the P1 vendor-agnostic 404 floor (visitor-facing
   *  surfaces stay closed-list per Must Hold I-1 default-off baseline). */
  receptionPortDeps?: import('./ports/reception/handler.js').ReceptionPortHandlerDeps;
  /** D-173 N.2 — Reception Inbox rpc deps. Wires the three admin-only
   *  `reception.inbox.{list,approve,reject}` methods (the review-then-
   *  approve inbox over held `approval_required` ops). `approve` is the
   *  SOLE writer of `checkpoint.arg_overrides` (the N.5 security boundary).
   *  Absent → those methods return `not_configured` (db-less harness, or a
   *  boot whose `composeReceptionInboxDeps` gate handles aren't composed).
   *  Channel-isolation invariant — `reception.*` prefix is reserved
   *  (`MCP_RESERVED_RPC_PREFIXES`). */
  receptionInboxDeps?: import('./reception-inbox-handler.js').ReceptionInboxDeps;
  /** D-165 enroll-host #1 (vendor OAuth popup) § A.12 — `/oauth/complete`
   *  path-handler deps. When supplied, `createServerHandlerSet` mounts
   *  the `createVendorOAuthCompletePortHandler` adapter on the `oauth`
   *  path role (LAN + public per the exposure resolution). Absent → the
   *  `oauth` role has no handler entry and the path-router 404s
   *  (`/oauth/complete` stays closed until the start↔complete stores +
   *  completion bus are wired). The shared flow/result stores +
   *  `onCompleted` bus seam are constructed in `composeListeners`
   *  (slice 2b Piece W/B); this is the type-checked mount seam they
   *  plug into. */
  oauthCompletePortDeps?: import('./connection-vendor-oauth-complete-port.js').VendorOAuthCompletePortHandlerDeps;
  /** D-158 P2b-ii — `/ask/<ask_id>` notification ask-landing path-handler
   *  deps. When supplied, `createServerHandlerSet` mounts the
   *  `createAskLandingPortHandler` adapter on the `ask` path role (served
   *  publicly under the `public` preset, like `oauth` / `reception`).
   *  Absent → the `ask` role has no handler entry and the path-router 404s
   *  (db-less harness / pre-D-158 boot). The deps close over the
   *  notification block (`getAsk` / `submitAnswer` / verification phrase) +
   *  the single-use nonce store, constructed in `composeListeners`. */
  askLandingPortDeps?: import('./ask-landing-port.js').AskLandingPortHandlerDeps;
  /** D-137 P1.2 — AI Chat rpc deps (Wire A). Backs the ten
   *  `chat.*` methods + the server-side orchestrator's per-turn
   *  broadcast emission. Absent → those methods return
   *  `not_configured` (db-less harnesses or pre-D-137 boots). */
  chatDeps?: import('./chat-handler.js').ChatRpcDeps;
  /** D-172 resumable uploads — webclient upload service deps. When provided,
   *  the `upload.*` rpc methods dispatch AND the dedicated binary `/ws/upload`
   *  socket accepts chunk frames. Absent → `not_configured` + `/ws/upload`
   *  upgrades 503-close (db-less / no-CAS harness). */
  uploadDeps?: import('./upload-handler.js').UploadHandlerDeps;
  /** M4 archive download — webclient download service deps. When provided, the
   *  dedicated binary `/ws/download` socket streams a finished export off disk.
   *  Absent → `/ws/download` upgrades 503-close. */
  downloadDeps?: import('./download/webclient-download-service.js').DownloadHandlerDeps;
  /** M4b.1 archive upload (no-SSH migrate) — archive upload service deps. When
   *  provided, the `server.archive.upload.*` rpc methods dispatch AND the binary
   *  `/ws/archive-upload` socket accepts chunk frames + STAGES the assembled
   *  archive under `exports/` for `server.archive.import`. Absent → those rpc
   *  methods return `not_configured` + `/ws/archive-upload` upgrades 503-close. */
  archiveUploadDeps?: import('./archive-upload-handler.js').ArchiveUploadHandlerDeps;
  /** Phase G (D-108/D-109) — the live `server.archive.*` export/import rpc deps,
   *  composed in `start-lifecycle-recovery-pre-listener-runtime`. Absent → the
   *  `server.archive.export` / `server.archive.import` methods return
   *  `not_configured`. Forward-or-dead-rpc trap (see `workEntitySourceDeps` /
   *  `contractDeps` / `cliReachabilityDeps` below): omitting the forward leaves
   *  the whole archive export/restore surface dead over the live wire even though
   *  the handler + runtime unit tests pass. */
  archiveDeps?: import('./archive/archive-handler.js').ArchiveRpcDeps;
  /** D-178 — release/update substrate rpc deps (`update.check` / `update.mode` /
   *  `update.set_mode` / `update.apply` / `update.rollback`). Same
   *  forward-or-dead-rpc trap as `archiveDeps` — found in the same audit, was
   *  composed in `composeListeners` + handler-registered in the ws-server but
   *  never forwarded here, so all five methods returned `not_configured` live. */
  updateDeps?: import('./update-handler.js').UpdateHandlerDeps;
  /** D-139 — `data.contact.engagements.list` resolver rpc deps. Same audit, same
   *  trap: composed + registered but never forwarded → `not_configured` live. */
  contactEngagementsRpcDeps?: import('./contact-engagements-rpc-handler.js').ContactEngagementsResolveDeps;
  /** D-148 follow-up #7 — disable the bare-302 root redirect handler.
   *  When `true`, `createServerHandlerSet` omits the `rootHandler`
   *  slot; the path-listener-set then leaves bare `/` 404'ing on the
   *  public listener like a non-recued.cloud host. Default (`undefined`
   *  / `false`) → the redirect handler is wired. Tests and dev
   *  compositions opt out by setting `true`. */
  rootRedirectDisabled?: boolean;
  /** D-152 § A.16 — LAN-only webclient bundle. When set,
   *  `createServerHandlerSet` composes the static-file mount handler;
   *  the path-listener-set threads it onto the LAN listener only.
   *  Absent → `/webclient/*` 404s as today (no mount). Production
   *  wiring composes the bundle from disk + manifest at server boot
   *  before passing it here. */
  webclientBundle?: {
    files: ReadonlyArray<WebclientBundleFile>;
    manifest?: WebclientBundleManifest;
  };
  /** D-137 P1 follow-on — HTTP MCP transport deps. When set, the
   *  `mcp` role handler dispatches JSON-RPC envelopes through
   *  `createMcpPortHandler` instead of the placeholder 404. The
   *  verifier validates the canonical structured client token. The
   *  dispatch closure wraps `mcp-server.ts`'s dispatch with per-request
   *  `mcpTokenId` derivation. Optional rate limiter — absent → 60 rpc/min default
   *  (MCP_RATE_LIMIT_PER_MIN). Catalog dispatch is reserved for the
   *  follow-up that wires `GET /mcp/catalog` token-scoped enumeration. */
  mcpHttpDeps?: {
    verifier: McpBearerVerifier;
    dispatch: McpDispatch;
    /** D-137 authored 3 / 5 / 10 concurrent-call tier for inbound door
     *  bearers. Canonical owner CLI tokens return undefined. */
    resolveConcurrencyLimit?: McpConcurrencyLimitResolver;
    rateLimiter?: RateLimiter;
    catalog?: McpCatalogDispatch;
    /** MCP 2026-07-28 `subscriptions/listen`. Absent → the method falls
     *  through to the dispatcher and answers `-32601` (404 to a modern
     *  client), which is the accurate "this server does not push". */
    subscriptions?: McpSubscriptionsPort;
  };
  /** D-196 S2c — OpenAI-compatible HTTP chat-completions gateway. Mounted on
   *  the `llm_gateway` path role when inbound token + LLM route deps exist. */
  llmGatewayDeps?: LlmGatewayHandlerDeps;
}

// ────────────────────────────────────────────────────────────────
// D-148 W3.5b — per-role handler decomposition + path-routed startup
// ────────────────────────────────────────────────────────────────

/** D-148 W3.5b — closed-list legacy alias map.
 *
 *  Maps existing path shapes (`/auth/pair`, `/status*`, `/webhook/*`,
 *  `/v1/connection/webhook/*`, `/hook/*`) to
 *  the appropriate canonical role. Production wiring (bin.ts) and the
 *  test-side `startServer` shim both thread this through `createPathListenerSet`
 *  so existing paths keep dispatching. A follow-up slice retires the
 *  aliases by renaming paths to canonical (`/ws/pair`, `/webhooks/<vendor>/<conn>`,
 *  etc.) + updating tests / provider docs in one cascading sweep.
 *
 *  Channel-isolation invariant intact: each legacy path maps to exactly
 *  one role; aliases live alongside (never replace) the canonical
 *  `matchesPathRole` lookup. */
export const SERVER_LEGACY_PATH_ALIASES: ReadonlyArray<PathRouterLegacyAlias> = [
  { kind: 'exact', path: '/auth/pair', role: 'ws' },
  // ⛔⛔ WITHOUT THIS LINE THE IDENTITY PROBE IS DEAD IN PRODUCTION, and it
  // shipped without it. `matchesPathRole` claims a path for a role only when
  // the path IS the role's base or sits under it — `/auth/identity-probe`
  // matches NO role, exactly like its sibling `/auth/pair`, so the router 404s
  // it before any handler runs.
  //
  // ⚠ Every test of the route passed anyway: they call `handlers.ws` directly,
  // which is one layer BELOW the thing that decides whether `handlers.ws` is
  // ever reached. Reasoning about the role's exposure bits is not reasoning
  // about the router's path matching, and I did the first while believing I had
  // done the second.
  { kind: 'exact', path: IDENTITY_PROBE_PATH, role: 'ws' },
  { kind: 'exact', path: '/status', role: 'ws' },
  { kind: 'exact', path: '/status.json', role: 'ws' },
  { kind: 'exact', path: '/v1/models', role: 'llm_gateway' },
  { kind: 'exact', path: '/v1/chat/completions', role: 'llm_gateway' },
  { kind: 'prefix', prefix: '/webhook/', role: 'webhooks' },
  { kind: 'prefix', prefix: '/v1/webhooks/', role: 'webhooks' },
  { kind: 'prefix', prefix: '/v1/connection/webhook/', role: 'webhooks' },
  { kind: 'prefix', prefix: '/hook/', role: 'webhooks' },
];

/** Per-role handler set returned by `createServerHandlerSet`. The
 *  handlers slot into `createPathListenerSet`'s `handlers` /
 *  `upgradeHandlers` maps; the `legacyAliases` slot threads through to
 *  the underlying `PathRouter` so existing path shapes keep dispatching. */
export interface ServerHandlerSet {
  handlers: Partial<Record<PathRole, PortRequestHandler>>;
  upgradeHandlers: Partial<Record<PathRole, PortUpgradeHandler>>;
  legacyAliases: ReadonlyArray<PathRouterLegacyAlias>;
  /** D-148 FU#7 — bare-root request handler. Wired into the public
   *  listener via `PathListenerSetOptions.rootHandler` when present;
   *  absent → public-listener bare `/` 404s. Production wires this by
   *  default; the test-side `startServer` shim leaves it unset (the
   *  fixture suite exercises role surfaces, not the redirect). */
  rootHandler?: PortRequestHandler;
  /** Offline-pairing convenience — bare-root handler for the LAN listener
   *  only (mirror of `rootHandler`, which is public-only). Present only when
   *  a webclient bundle is loaded (`config.webclientBundle`); the path-
   *  listener-set threads it onto the LAN listener, where a self-hoster's
   *  bare `/` 302-redirects to the embedded webclient at `/webclient/` to
   *  pair offline. Absent → LAN bare `/` 404s. */
  lanRootHandler?: PortRequestHandler;
  /** WS handle — surfaces the same `WsServerHandle` shape that
   *  `attachWebSocket` previously returned. bin.ts wires this into
   *  heartbeat emission + the auto-run scheduler + peer cache transport. */
  wsHandle: WsServerHandle;
  /** Idempotent teardown. Closes the WS dispatcher; the path-listener-set
   *  itself is closed by its own `.stop()` (the caller owns the set). */
  close(): Promise<void>;
}

/** Build the per-role handler decomposition over a `ServerConfig`. The
 *  health / ws / webhooks roles get concrete handlers; the mcp role
 *  returns 404 (production MCP stays stdio at v1; HTTP `/mcp` + `/mcp/catalog`
 *  are reserved for a follow-up W3.x); the reception role delegates to
 *  D-149 P1's `createReceptionPortHandler`; the oauth role delegates to
 *  D-165's `createVendorOAuthCompletePortHandler` when
 *  `oauthCompletePortDeps` is supplied (else the role is absent → 404).
 *
 *  D-148 follow-up #7 — emits a bare-302 root redirect handler in the
 *  `rootHandler` slot (default-on). The path-listener-set threads it
 *  onto the public listener only; LAN bare `/` keeps 404'ing. The
 *  `config.rootRedirectDisabled` switch suppresses the wiring for tests
 *  + dev compositions. */
export const createServerHandlerSet = (config: ServerConfig = {}): ServerHandlerSet => {
  const now = config.now ?? (() => Date.now());

  // ─── health role ────────────────────────────────────────────────
  const healthHandler: PortRequestHandler = (req, res) => {
    if ((req.method ?? 'GET') !== 'GET') {
      respond(res, { ok: false, status: 405, error: { code: 'method_not_allowed', message: 'GET only on /health' } });
      return;
    }
    respond(res, { ok: true, status: 200, body: { status: 'ok', now: now() } });
  };

  // ─── ws role ────────────────────────────────────────────────────
  // Request side handles the legacy admin-channel-adjacent paths
  // (`/auth/pair`, `/status`, `/status.json`) + their CORS preflights;
  // the WS upgrade itself comes through the `upgradeHandlers` map.
  const wsHandler: PortRequestHandler = async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      const [pathname] = url.split('?');

      // D-121 Phase 5 — CORS preflight for the pair entry points.
      if (method === 'OPTIONS' && isPairCorsPath(pathname)) {
        writePairCorsHeaders(res);
        res.statusCode = 204;
        res.end();
        return;
      }

      // Pre-auth: identity probe. Proves this server holds the key the caller
      // names, over a nonce the caller supplies, WITHOUT the caller presenting
      // a bearer first — the whole point being that a client can check a
      // candidate address before trusting it with a token.
      if (pathname === IDENTITY_PROBE_PATH && method === 'POST') {
        writePairCorsHeaders(res);
        const probeDeps = config.identityProbeDeps;
        // ⛔ ONE REFUSAL FOR EVERY "NO" — not configured, malformed, oversized,
        // or a fingerprint that isn't ours. What that buys is the property
        // that matters: a caller WITHOUT the fingerprint learns nothing about
        // WHO this server is — no signature, no key, no yes-or-no about any
        // particular identity. A caller that DOES hold the pin gets proof.
        //
        // ⚠ IT DOES *NOT* HIDE THAT THE ROUTE EXISTS, AND AN EARLIER COMMENT
        // HERE CLAIMED IT DID ("a scanner cannot distinguish 'wrong server'
        // from 'no such route'"). That was false in every case, not just the
        // edge ones: the floor handler's 404 carries a different body
        // ("No HTTP handler for POST <path>…"), so the two never matched. The
        // test that was supposed to prove it compared these refusals to EACH
        // OTHER and never to an unknown path — it asserted the field it was
        // written against rather than the claim.
        //
        // 🔑 Not worth engineering away: `/health` and `/auth/pair` already
        // announce a Recued server to anyone who asks, so hiding this one route
        // would buy version-granularity fingerprinting and nothing else. The
        // uniformity below is kept because a route whose OWN answers vary by
        // input is a different and avoidable problem.
        const refuse = (): void => {
          respond(res, {
            ok: false,
            status: 404,
            error: { code: 'not_found', message: 'not found' },
          });
        };
        if (!probeDeps) { refuse(); return; }
        // ⚠ CAUGHT HERE, NOT LEFT TO THE OUTER HANDLER. `readJsonBody` throws
        // `InvalidJsonBodyError` / `RequestBodyTooLargeError`, which `wsHandler`
        // turns into 400 and 413 — so without this, malformed and oversized
        // bodies answered differently from every other refusal on this route.
        let probeBody: unknown;
        try {
          probeBody = await readJsonBody(req);
        } catch {
          refuse();
          return;
        }
        if (!isIdentityProbeRequest(probeBody)) { refuse(); return; }
        const identityKey = probeDeps.serverIdentityKey();
        // Plain comparison: the fingerprint is not a secret (it is the
        // `publisher_id` the Server Passport already publishes), so there is
        // no timing channel worth closing here.
        if (probeBody.expect_fingerprint !== identityKey.public_key_fingerprint) {
          refuse();
          return;
        }
        // ⛔ The signed bytes are BUILT HERE, never taken from the request. The
        // nonce rides inside as a shape-checked field.
        const signature = probeDeps.sign(
          buildIdentityProbePayload({
            nonce: probeBody.nonce,
            server_public_key: identityKey.public_key_b64,
          }),
        );
        respond(res, { ok: true, status: 200, body: { signature } });
        return;
      }

      // Pre-auth: pair entry.
      if (pathname === '/auth/pair' && method === 'POST' && config.pairing) {
        if (isPairCorsPath(pathname)) writePairCorsHeaders(res);
        const body = await readJsonBody(req) as {
          code?: string;
          recoveryKey?: string;
          instanceId?: string;
          displayName?: string;
          clientKind?: string;
        } | undefined;
        const code = typeof body?.code === 'string' && body.code.length > 0 ? body.code : null;
        const recoveryKey = typeof body?.recoveryKey === 'string' && body.recoveryKey.length > 0 ? body.recoveryKey : null;
        if (!code && !recoveryKey) {
          respond(res, { ok: false, status: 400, error: { code: 'bad_request', message: 'code or recoveryKey is required' } });
          return;
        }
        const realmEnrolled = !!config.recoveryKeyCheck && config.recoveryKeyCheck.exists();
        if (!realmEnrolled && !code) {
          respond(res, { ok: false, status: 400, error: { code: 'bad_request', message: 'code is required for the first pair on this server' } });
          return;
        }
        // Prove the pairing code BEFORE any recovery-key side effect. Every
        // step below this line is durable and realm-binding — the sentinel,
        // the vault bundle, the database rekey — so running them ahead of
        // authentication handed an unauthenticated caller the realm: a bogus
        // code still bound their recovery key, and a second, code-less
        // request then paired against it for real. Checked non-consumingly
        // so a mistyped recovery key rejects without burning the code;
        // `pair()` below is still the authoritative check-and-consume.
        //
        // A code that expires in the window between the two leaves the realm
        // enrolled but the pair refused. That residual is benign and must not
        // be "fixed" by consuming earlier: passing this gate already proves
        // the caller held a valid code, so the key that bound the realm is
        // theirs, and their retry with a fresh code verifies against it.
        if (code && !config.pairing.checkCode(code)) {
          respond(res, { ok: false, status: 401, error: { code: 'invalid_code', message: 'Invalid, expired, or already-used pairing code' } });
          return;
        }
        // Reject a malformed `clientKind` HERE — ahead of the recovery-key
        // enrollment and, crucially, ahead of `pairing.pair(code)` below, which
        // CONSUMES the code. This validation used to sit after the consume, so a
        // client that sent a typo'd kind burned a single-use pairing code to earn
        // its 400: the honest retry with the corrected kind then got a 401
        // `invalid_code` for a code the user had just been told was fine, and the
        // only way forward was to go back to the terminal for a new one. It reads
        // nothing but the request body, so it leaks nothing to an unauthenticated
        // prober — unlike the revoked-instance check further down, which stays
        // after authentication deliberately.
        const clientKindRaw = body?.clientKind;
        if (clientKindRaw !== undefined && !isClientKind(clientKindRaw)) {
          respond(res, { ok: false, status: 400, error: { code: 'bad_request', message: 'clientKind must be bridge, webclient, or cli' } });
          return;
        }
        const clientKind: ClientKind = isClientKind(clientKindRaw) ? clientKindRaw : 'webclient';
        if (recoveryKey) {
          if (!config.recoveryKeyCheck) {
            respond(res, { ok: false, status: 503, error: { code: 'server_not_configured', message: 'Server has no recovery-key check store.' } });
            return;
          }
          // Slice 3b — verify against the realm, turn real at-rest encryption
          // on, then open the sentinel gate LAST, so a pairing completes only
          // if encryption actually turned on. Shared with the
          // `pair.registerRecoveryKey` WS twin so the two cannot drift.
          const { enrollRealmRecoveryKey } = await import('./server-vault-enrollment.js');
          const verify = await enrollRealmRecoveryKey({
            recoveryKeyCheck: config.recoveryKeyCheck,
            recoveryKey,
            keys: config.keys,
            keyStore: config.keys ? config.getServerKeyStore?.() : undefined,
            database: config.database,
          });
          if (!verify.ok) {
            respond(res, {
              ok: false,
              status: verify.code === 'mismatch'
                ? 401
                : verify.code === 'not_configured' || verify.code === 'busy'
                  ? 503
                  : verify.code === 'realm_conflict'
                    ? 409
                    : 400,
              error: {
                code: verify.code === 'not_configured'
                  ? 'database_encryption_not_configured'
                  : verify.code === 'busy'
                    ? 'encryption_enrollment_busy'
                    // The realm is fine and so is the key — say so, rather than
                    // letting this fall through to `recovery_key_invalid`.
                    : verify.code === 'realm_conflict'
                      ? 'realm_directory_conflict'
                      : 'recovery_key_invalid',
                message: verify.message,
              },
            });
            return;
          }
        }
        if (code) {
          const token = config.pairing.pair(code);
          if (!token) {
            respond(res, { ok: false, status: 401, error: { code: 'invalid_code', message: 'Invalid, expired, or already-used pairing code' } });
            return;
          }
        }
        // Reject a re-pair that reuses a REVOKED instance_id. The roster
        // upsert below would otherwise clear `revoked_at` (resurrecting the
        // device) and a later re-revoke would reuse the deterministic
        // `pair_revoke:<instance_id>` audit id, overwriting the original
        // signed revocation row. Mirror the WS register guard (ws-server.ts
        // `isRevoked` → close 4003): a revoked device must re-pair under a
        // fresh identity — the webclient already wipes its persisted
        // instance_id on the 4003 reauth path, so a legitimate re-pair mints
        // a new id and never trips this. Checked only AFTER the
        // code/recoveryKey is verified so it never leaks revoked-status to an
        // unauthenticated prober.
        if (config.pairedInstances
            && typeof body?.instanceId === 'string' && body.instanceId.length > 0
            && config.pairedInstances.isRevoked(body.instanceId)) {
          respond(res, { ok: false, status: 403, error: { code: 'instance_revoked', message: 'this instance was previously revoked; re-pair as a new device' } });
          return;
        }
        // `clientKind` is resolved above, before the code is consumed — the
        // durable row still records the surface this device paired as (D-156
        // P10 — drives the Devices roster's kind label).
        if (config.pairedInstances
            && typeof body?.instanceId === 'string' && body.instanceId.length > 0) {
          config.pairedInstances.addOrRefresh({
            instance_id: body.instanceId,
            // D-156 follow-on — seed the stable self-host owner id (not '')
            // so the row is enumerable by `pair.list` / revocable by
            // `pair.revoke` for the bearer-only webclient, which never
            // reports a cloud `user_id`. A cloud-signed-in extension still
            // overwrites this with its real `user_id` on `register` (the
            // store upserts `user_id = excluded.user_id`), so the
            // Cloud-multi-tenant path is unchanged. See `SELF_HOST_OWNER_ID`.
            user_id: SELF_HOST_OWNER_ID,
            display_name: body.displayName ?? 'unknown device',
            kind: clientKind,
          });
          // D-156 follow-on — announce the new device to every paired client so
          // their Settings → Devices roster live-refreshes off the bus (the
          // `op: 'revoked'` companion is emitted from the `pair.revoke` rpc
          // handler). The durable row is committed above, so `pair.list` —
          // which the subscribers re-call on the event — already reflects it.
          // `addOrRefresh` is an upsert, but a re-pair mints a fresh
          // instance_id, so this is a genuine roster-add in practice.
          // Best-effort: the bus is observability, never a reason to fail the
          // pairing the user just completed.
          try {
            config.eventsDeps?.bus.emit({ kind: 'pair.list_changed', op: 'added' });
          } catch {
            /* observability-only; never abort the pairing on emit failure. */
          }
        }
        const clientLabel =
          typeof body?.displayName === 'string' && body.displayName.length > 0
            ? body.displayName
            : undefined;
        const issued = config.clientTokens
          ? await config.clientTokens.issue({
              client_kind: clientKind,
              ...(clientLabel ? { client_label: clientLabel } : {}),
              metadata: {
                issued_via: '/auth/pair',
                ...(typeof body?.instanceId === 'string' && body.instanceId.length > 0
                  ? { instance_id: body.instanceId }
                  : {}),
              },
            })
          : undefined;
        let passport: unknown;
        if (config.passportFetchDeps) {
          try {
            passport = (await handlePassportFetch(
              config.passportFetchDeps,
              undefined,
              {
                instance_id:
                  typeof body?.instanceId === 'string' && body.instanceId.length > 0
                    ? body.instanceId
                    : null,
              } as import('./ws-server.js').WsClient,
            )).passport;
          } catch {
            passport = undefined;
          }
        }
        respond(res, {
          ok: true,
          status: 200,
          body: {
            token: issued?.bearer ?? config.pairing.getRealmToken(),
            ...(issued ? { token_id: issued.token_id, bearer: issued.bearer } : {}),
            ...(passport !== undefined ? { passport } : {}),
            message: 'Paired successfully',
            ...(config.serverId ? { serverId: config.serverId } : {}),
          },
        });
        return;
      }

      // D-116 follow-up — `/status` HTML + `/status.json`.
      if ((pathname === '/status' || pathname === '/status.json')
          && method === 'GET' && config.statusPageDeps) {
        const { handleStatusRequest } = await import('./status-page.js');
        handleStatusRequest(
          config.statusPageDeps,
          req,
          res,
          pathname === '/status.json' ? 'json' : 'html',
        );
        return;
      }

      // No match for the ws role's request surface.
      respond(res, {
        ok: false,
        status: 404,
        error: { code: 'not_found', message: `No HTTP handler for ${method} ${pathname}. Use the WebSocket rpc channel for execute and schedules.` },
      });
    } catch (e) {
      if (e instanceof RequestBodyTooLargeError) {
        respond(res, {
          ok: false,
          status: 413,
          error: { code: 'payload_too_large', message: 'request body too large' },
        });
        return;
      }
      if (e instanceof InvalidJsonBodyError) {
        respond(res, {
          ok: false,
          status: 400,
          error: { code: 'bad_request', message: 'Invalid JSON body' },
        });
        return;
      }
      // The message stays SERVER-SIDE. This handler fronts pre-auth surfaces
      // (`/auth/pair`, `/status.json`), so an unauthenticated caller was reading
      // raw thrown text — sqlite constraint strings, filesystem paths, upstream
      // hostnames — from any unhandled path. The webhook handler below has
      // always done it this way and says why; this one was the outlier.
      //
      // ⚠ DELIBERATE DEVIATION: this is the only `console.*` in this file, and
      // the webhook handler's comment says server.ts "logs nothing by design".
      // That was true when written and is the reason it is called out here. The
      // alternative is a 500 that leaves no trace anywhere, and on a self-hosted
      // server the operator IS at the terminal — dropping the detail from the
      // response only helps if it survives somewhere they can read it.
      console.error('[http] unhandled request error', {
        method: req.method ?? 'GET',
        path: (req.url ?? '/').split('?')[0],
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
      respond(res, {
        ok: false,
        status: 500,
        error: { code: 'internal_error', message: 'internal error' },
      });
    }
  };

  // ─── mcp role ───────────────────────────────────────────────────
  // D-137 P1 follow-on — HTTP MCP transport. When `mcpHttpDeps` is wired,
  // the role dispatches JSON-RPC envelopes through `createMcpPortHandler`
  // (bearer + per-token rate limit). Absent → vendor-agnostic 404 so we
  // don't fingerprint the surface (matches the pre-wire stub shape).
  const mcpHandler: PortRequestHandler = config.mcpHttpDeps
    ? createMcpPortHandler({
        verifier: config.mcpHttpDeps.verifier,
        limiter: config.mcpHttpDeps.rateLimiter ?? createRateLimiter({
          capacity: MCP_RATE_LIMIT_PER_MIN,
          refill_window_ms: MCP_RATE_LIMIT_WINDOW_MS,
        }),
        dispatch: config.mcpHttpDeps.dispatch,
        ...(config.mcpHttpDeps.resolveConcurrencyLimit
          ? {
              resolve_concurrency_limit:
                config.mcpHttpDeps.resolveConcurrencyLimit,
            }
          : {}),
        ...(config.mcpHttpDeps.catalog ? { catalog: config.mcpHttpDeps.catalog } : {}),
        ...(config.mcpHttpDeps.subscriptions
          ? { subscriptions: config.mcpHttpDeps.subscriptions }
          : {}),
      })
    : (_req, res) => {
        respond(res, { ok: false, status: 404, error: { code: 'not_found', message: 'mcp http transport reserved' } });
      };

  // ─── llm_gateway role (D-196 S2c) ───────────────────────────────
  const llmGatewayHandler: PortRequestHandler | undefined = config.llmGatewayDeps
    ? createLlmGatewayPortHandler(config.llmGatewayDeps)
    : undefined;

  // ─── webhooks role ──────────────────────────────────────────────
  // Decode a single path segment without letting a malformed
  // percent-escape (`%`, `%zz`, a lone surrogate) throw a `URIError`.
  // An un-guarded `decodeURIComponent` on an attacker-controlled
  // webhook path segment would otherwise punch through the
  // vendor-agnostic 404 floor below with a 500 + leaked exception
  // text to an UNAUTHENTICATED caller. Returns null on malformed
  // input so each route maps it to its own generic 400.
  const safeDecodeURIComponent = (raw: string): string | null => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  };
  const webhooksHandler: PortRequestHandler = async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      const [pathname] = url.split('?');

      // Phase D — `POST /webhook/<slug>` collection webhook listener.
      if (pathname.startsWith('/webhook/') && method === 'POST' && config.webhookListener) {
        const slug = safeDecodeURIComponent(pathname.slice('/webhook/'.length));
        if (slug === null || slug.length === 0 || slug.includes('/')) {
          respond(res, {
            ok: false,
            status: 400,
            error: { code: 'bad_request', message: 'webhook slug must be a single non-empty path segment' },
          });
          return;
        }
        await config.webhookListener(req, res, slug);
        return;
      }

      // D-148 P9 § A.13 — `POST /webhooks/<vendor>/<connection_name>`
      // vendor port. The handler does its own vendor-prefix matching,
      // signature verification, and vendor-appropriate replay handling;
      // this branch delegates the original request stream without reading or
      // rewriting its body. Note the trailing slash distinguishes this from
      // the Phase D `/webhook/` (singular) listener above.
      // D-192 WhatsApp make-live — GET is delegated too, and ONLY so the port can
      // answer a vendor's ownership handshake (Meta will not deliver a single POST
      // until this endpoint echoes `hub.challenge` on a GET). The port itself
      // still 404s a GET for any vendor that declares no `verifyChallenge`, and
      // 404s a failed handshake identically, so nothing here is newly reachable or
      // newly fingerprintable — the method gate simply stopped being the thing
      // that made a whole vendor class impossible to host.
      if (
        pathname.startsWith('/webhooks/')
        && (method === 'POST' || method === 'GET')
        && config.vendorWebhookListener
      ) {
        await config.vendorWebhookListener(req, res);
        return;
      }

      // D-201 Slice 2 — one opaque ingress id, no vendor/profile/connection
      // material in the path. Delegate every method so the trusted profile
      // kernel can apply its own closed method contract before body capture.
      // Invalid/unwired ids share the generic 404 floor.
      if (pathname.startsWith('/v1/webhooks/') && config.webhookProfileListener) {
        const publicId = pathname.slice('/v1/webhooks/'.length);
        if (!/^[A-Za-z0-9_-]{32}$/.test(publicId)) {
          respond(res, {
            ok: false,
            status: 404,
            error: { code: 'not_found', message: 'no webhook handler matched' },
          });
          return;
        }
        await config.webhookProfileListener(req, res, publicId);
        return;
      }

      // D-128 P3 — `POST /v1/connection/webhook/<vendor>/<connection_name>`.
      if (pathname.startsWith('/v1/connection/webhook/')
          && method === 'POST'
          && config.connectionWebhookListener) {
        const parts = pathname.slice('/v1/connection/webhook/'.length).split('/');
        if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
          respond(res, {
            ok: false,
            status: 400,
            error: {
              code: 'bad_request',
              message:
                '/v1/connection/webhook path must be /v1/connection/webhook/{vendor}/{connection_name}',
            },
          });
          return;
        }
        const vendor = safeDecodeURIComponent(parts[0]);
        const connection_name = safeDecodeURIComponent(parts[1]);
        if (vendor === null || connection_name === null) {
          respond(res, {
            ok: false,
            status: 400,
            error: {
              code: 'bad_request',
              message:
                '/v1/connection/webhook path must be /v1/connection/webhook/{vendor}/{connection_name}',
            },
          });
          return;
        }
        await config.connectionWebhookListener(req, res, vendor, connection_name);
        return;
      }

      // D-115 Phase 6C — `POST /hook/<recipe_id>/<slug>` reactive recipe webhook.
      if (pathname.startsWith('/hook/') && method === 'POST' && config.hookListener) {
        const parts = pathname.slice('/hook/'.length).split('/');
        if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
          respond(res, {
            ok: false,
            status: 400,
            error: {
              code: 'bad_request',
              message: '/hook path must be /hook/{recipe_id}/{slug}',
            },
          });
          return;
        }
        const recipe_id = safeDecodeURIComponent(parts[0]);
        const slug = safeDecodeURIComponent(parts[1]);
        if (recipe_id === null || slug === null) {
          respond(res, {
            ok: false,
            status: 400,
            error: {
              code: 'bad_request',
              message: '/hook path must be /hook/{recipe_id}/{slug}',
            },
          });
          return;
        }
        await config.hookListener(req, res, recipe_id, slug);
        return;
      }

      // No match — vendor-agnostic 404 (spec § A.6.2 fingerprint discipline).
      respond(res, { ok: false, status: 404, error: { code: 'not_found', message: 'no webhook handler matched' } });
    } catch {
      // Never echo the raw exception text back to an unauthenticated
      // webhook caller — `e.message` can carry internal paths / state.
      // The webhook surface is unauthenticated at this layer, so the
      // 500 body stays a fixed generic string. (This used to add "server.ts
      // logs nothing by design; the daemon's higher-level wiring owns
      // diagnostics" — no longer true: the ws-role handler above now logs the
      // detail it stopped returning. This one still doesn't; a webhook sender
      // retries and the daemon sees the delivery failure.)
      respond(res, {
        ok: false,
        status: 500,
        error: { code: 'internal_error', message: 'internal error' },
      });
    }
  };

  // ─── reception role (D-149 P1 + P3) ────────────────────────────
  // The path-router dispatches `/reception/*` to this handler on both
  // listeners (per § A.2). P3 wires the registry-aware dispatch when
  // `receptionPortDeps` is supplied; absent → the handler stays on
  // the P1 vendor-agnostic 404 floor (visitor surfaces stay closed-
  // list per Must Hold I-1 default-off baseline).
  const receptionHandler = createReceptionPortHandler(config.receptionPortDeps);

  // ─── oauth role (D-165 enroll-host #1, slice 2b Piece M) ───────
  // The path-router dispatches `/oauth/complete` to this handler on
  // both listeners (per the `oauth` exposure resolution — on under the
  // `public` preset). Mounted only when `oauthCompletePortDeps` is
  // supplied (the shared start↔complete stores + completion bus seam
  // wired in `composeListeners`); absent → no `oauth` handler entry and
  // the path-router 404s, exactly like the unwired `reception` floor.
  const oauthCompleteHandler: PortRequestHandler | undefined =
    config.oauthCompletePortDeps
      ? createVendorOAuthCompletePortHandler(config.oauthCompletePortDeps)
      : undefined;

  // ─── ask role (D-158 P2b-ii notification ask-landing) ──────────
  // The path-router dispatches `/ask/<ask_id>` to this handler (served on
  // the public listener under the `public` preset). Mounted only when
  // `askLandingPortDeps` is supplied (the notification-block closures +
  // nonce store, wired in `composeListeners`); absent → no `ask` handler
  // entry and the path-router 404s, like the unwired `reception` floor.
  const askLandingHandler: PortRequestHandler | undefined =
    config.askLandingPortDeps
      ? createAskLandingPortHandler(config.askLandingPortDeps)
      : undefined;

  // ─── root redirect (D-148 FU#7) ────────────────────────────────
  // R26.2 Delta 2 — apex (`GET /`) handler on the public listener only
  // (LAN visitors never see it). Default mode is the bare-302 redirect
  // from `<handle>.recued.cloud/` to `https://app.recued.com/`. The mode +
  // the `serve_reception` consistency gate are read PER REQUEST so a config
  // flip is hot (the handler instance is reused across listener rebuilds).
  // `rootRedirectDisabled` suppresses wiring for tests + dev composes.
  const rootHandler: PortRequestHandler | undefined = config.rootRedirectDisabled
    ? undefined
    : createRootApexHandler({
        getApexMode: () =>
          (config.runtimeConfig?.get('network.apex_mode') as
            | RootApexMode
            | undefined) ?? DEFAULT_ROOT_APEX_MODE,
        getReceptionPublic: async () => {
          // Request-time read of the live exposure resolution. `getMachine`
          // is a boot-order thunk that throws pre-wire; at request time the
          // machine is up, but guard defensively so a serve_reception apex
          // 404s rather than 500s if the ref is ever unset.
          try {
            const machine = config.exposureDeps?.getMachine();
            if (!machine) return false;
            return (await machine.current()).resolution.reception.public === true;
          } catch {
            return false;
          }
        },
        receptionHandler,
        // R26.2 Delta 3 — serve the apex as the embedded webclient only when
        // BOTH hold: a verified bundle loaded at boot (else `/webclient/`
        // 404s — no content) AND `/webclient` public on the grid (else
        // `/webclient/` 404s — path disabled on the public listener). Both
        // signals are local here (`config.webclientBundle` + the exposure
        // machine), so no cross-boot late-binding is needed. Mirrors
        // `getReceptionPublic`'s defensive machine read.
        getWebclientServable: async () => {
          if (!config.webclientBundle) return false;
          try {
            const machine = config.exposureDeps?.getMachine();
            if (!machine) return false;
            return (await machine.current()).resolution.webclient.public === true;
          } catch {
            return false;
          }
        },
      });

  // ─── webclient bundle mount (D-152 § A.16 + R26.2 Delta 3) ─────
  // Static-file handler for the embedded webclient bundle, wired into
  // the `webclient` path role (see the `handlers` map below). Whether it
  // serves on LAN / public is the per-listener `resolution.webclient`
  // grid bit (LAN-on, public-off by default) — no longer a structural
  // LAN-only carve-out. Manifest verification runs inside
  // `createWebclientBundleHandler` when present; bundle-load failures
  // throw to the caller. Production wiring catches at boot + emits the
  // `webclient_bundle_unverified` audit row + skips the mount.
  const webclientHandler: PortRequestHandler | undefined = config.webclientBundle
    ? createWebclientBundleHandler({
        files: config.webclientBundle.files,
        ...(config.webclientBundle.manifest ? { manifest: config.webclientBundle.manifest } : {}),
      })
    : undefined;

  // ─── LAN bare-`/` → embedded webclient (offline-pairing convenience) ──
  // The LAN listener's bare `/` lands the operator on `/webclient/` so they
  // can pair to their OWN server offline / in-house (secure context on
  // localhost → Web Crypto works). Distinct from the public apex handler
  // above: that redirects a stranger to app.recued.com; this is a fixed
  // serve-my-own-webclient behavior, NOT driven by `network.apex_mode`
  // (an apex mode is a public-exposure choice). Built only when a webclient
  // bundle loaded — no bundle → no handler → LAN bare `/` stays 404, so a
  // source build without the bundle is unaffected. Gated at request time on
  // the SAME servability predicate the public serve_webclient mode uses, but
  // reads the `.lan` grid bit (LAN-on by default) instead of `.public`, so a
  // bare-`/` redirect only fires when `/webclient/` actually serves on LAN.
  const lanRootHandler: PortRequestHandler | undefined = config.webclientBundle
    ? createLanWebclientRootHandler({
        getWebclientServable: async () => {
          if (!config.webclientBundle) return false;
          try {
            const machine = config.exposureDeps?.getMachine();
            if (!machine) return false;
            return (await machine.current()).resolution.webclient.lan === true;
          } catch {
            return false;
          }
        },
      })
    : undefined;

  // ─── ws upgrade (path-router consumer) ─────────────────────────
  // Build the WS dispatcher without auto-binding to an http server —
  // the path-router calls `upgradeHandler` for the `ws` role.
  const executeDeps: ExecuteHandlerDeps | undefined =
    config.executeDeps && config.annotationDeps?.store
      ? {
          ...config.executeDeps,
          annotationStore: config.annotationDeps.store,
        }
      : config.executeDeps;
  const wsBinding = createWebSocketUpgrade({
    executeDeps,
    scheduleDeps: config.scheduleDeps,
    ...(config.dishDeps ? { dishDeps: config.dishDeps } : {}),
    ...(config.triggersDeps ? { triggersDeps: config.triggersDeps } : {}),
    ...(config.elementWatchDeps ? { elementWatchDeps: config.elementWatchDeps } : {}),
    ...(config.autoRunDeps ? { autoRunDeps: config.autoRunDeps } : {}),
    ...(config.watchDeps ? { watchDeps: config.watchDeps } : {}),
    cacheDeps: config.cacheDeps,
    sharedDeps: config.sharedDeps,
    authDeps: config.authDeps,
    migrateDeps: config.migrateDeps,
    llmConfigManager: config.llmConfigManager,
    ...(config.llmProbe ? { llmProbe: config.llmProbe } : {}),
    sellerStore: config.sellerStore,
    sellerOrderStore: config.sellerOrderStore,
    sellerContractStore: config.sellerContractStore,
    sellerInboundTokenStore: config.sellerInboundTokenStore,
    sellerClaimStore: config.sellerClaimStore,
    runtimeConfig: config.runtimeConfig,
    bootstrapDeps: config.bootstrapDeps,
    serverId: config.serverId,
    pairedInstances: config.pairedInstances,
    ...(config.pairRevokeAuditLog
      ? { pairRevokeAuditLog: config.pairRevokeAuditLog }
      : {}),
    ...(config.accountBindingDeps
      ? { accountBindingDeps: config.accountBindingDeps }
      : {}),
    ...(config.proConvenienceDeps
      ? { proConvenienceDeps: config.proConvenienceDeps }
      : {}),
    ...(config.ddnsDeps ? { ddnsDeps: config.ddnsDeps } : {}),
    recoveryKeyCheck: config.recoveryKeyCheck,
    ...(config.recoveryVaultDeps ? { recoveryVaultDeps: config.recoveryVaultDeps } : {}),
    ...(config.clientTokens ? { clientTokens: config.clientTokens } : {}),
    pressureDeps: config.pressureDeps,
    lifecycleHandlers: config.lifecycleHandlers,
    lifecycleState: config.lifecycleState,
    collectionDeps: config.collectionDeps,
    watcherRpcDeps: config.watcherRpcDeps,
    triggerTestRpcDeps: config.triggerTestRpcDeps,
    recipeListDeps: config.recipeListDeps,
    recipeSaveDeps: config.recipeSaveDeps,
    recipeRunnabilityDeps: config.recipeRunnabilityDeps,
    approvalDeps: config.approvalDeps,
    auditExportDeps: config.auditExportDeps,
    executionFeedDeps: config.executionFeedDeps,
    eventsDeps: config.eventsDeps,
    enrichmentDeps: config.enrichmentDeps,
    notificationDeps: config.notificationDeps,
    mailGetDeps: config.mailGetDeps,
    housekeepingDeps: config.housekeepingDeps,
    // D-250 § D7 — see the note on the field above; this forward is the whole reason
    // the rpc is reachable.
    metricDeps: config.metricDeps,
    // ── rpc-deps forward completion (D-167 P5 Slice 2b) ────────────
    // Forward the families that `composeListeners` passes but this
    // file previously dropped (see the matching `ServerConfig` block).
    // Each gates on presence so dbless / partial compositions keep
    // returning `not_configured` exactly as before — wiring only changes
    // the case where the dep IS composed. These were the same one-line
    // fix for already-shipped surfaces that were silently dead in
    // production.
    ...(config.engagementHealthDeps
      ? { engagementHealthDeps: config.engagementHealthDeps }
      : {}),
    ...(config.packInstallDeps
      ? { packInstallDeps: config.packInstallDeps }
      : {}),
    ...(config.packListDeps ? { packListDeps: config.packListDeps } : {}),
    ...(config.packUninstallDeps
      ? { packUninstallDeps: config.packUninstallDeps }
      : {}),
    ...(config.ingredientAuthoringDeps
      ? { ingredientAuthoringDeps: config.ingredientAuthoringDeps }
      : {}),
    ...(config.ingredientDraftDeps
      ? { ingredientDraftDeps: config.ingredientDraftDeps }
      : {}),
    ...(config.notificationsDeps
      ? { notificationsDeps: config.notificationsDeps }
      : {}),
    annotationDeps: config.annotationDeps,
    contactDeps: config.contactDeps,
    // D-145 PA11 — forward Source-management deps (D-174 #22 fix: this
    // was missing, leaving `work_entity.source.*` dead in production).
    workEntitySourceDeps: config.workEntitySourceDeps,
    contactSourceDeps: config.contactSourceDeps,
    // D-174 #22 — work-entity warehouse CRUD + timeline read (Data route).
    workEntityCrudDeps: config.workEntityCrudDeps,
    formResponseDeps: config.formResponseDeps,
    recordsRpcDeps: config.recordsRpcDeps,
    savedDataViewStore: config.savedDataViewStore,
    preapprovalDeps: config.preapprovalDeps,
    timelineRpcDeps: config.timelineRpcDeps,
    memoryRpcDeps: config.memoryRpcDeps,
    fileReadRpcDeps: config.fileReadRpcDeps,
    contactMergeDeps: config.contactMergeDeps,
    upstreamMergeDeps: config.upstreamMergeDeps,
    connectionDeps: config.connectionDeps,
    webhookIngressDeps: config.webhookIngressDeps,
    // D-166 override-write path — forward the `collection.contract.*` deps
    // `composeListeners` composes from `app.contractStoreRef`. Without this
    // line the handler slice registers with `undefined` deps → all three
    // override rpcs return `not_configured` (the D-167 P5 Slice 2b trap).
    contractDeps: config.contractDeps,
    // D-182 §7.2 — forward the `cli.reachability.*` deps `composeListeners`
    // builds from `app.contractStoreRef`. Same forward-or-dead-rpc trap as
    // `contractDeps` above.
    cliReachabilityDeps: config.cliReachabilityDeps,
    serverTimeZoneDeps: config.serverTimeZoneDeps,
    notificationKindPolicyDeps: config.notificationKindPolicyDeps,
    quietHoursDeps: config.quietHoursDeps,
    // Supervision feature — forward the `supervision.*` deps composeListeners
    // builds from `collection.supervisionStack`. Forward-or-dead-rpc trap.
    supervisionDeps: config.supervisionDeps,
    hostnameDeps: config.hostnameDeps,
    networkDeps: config.networkDeps,
    portMappingDeps: config.portMappingDeps,
    ...(config.bridgeCapabilityDeps
      ? { bridgeCapabilityDeps: config.bridgeCapabilityDeps }
      : {}),
    ...(config.systemStatusDeps
      ? { systemStatusDeps: config.systemStatusDeps }
      : {}),
    ...(config.historyDeps ? { historyDeps: config.historyDeps } : {}),
    ...(config.executionFeedDeps
      ? { executionFeedDeps: config.executionFeedDeps }
      : {}),
    ...(config.bridgeRegistry
      ? { bridgeRegistry: config.bridgeRegistry }
      : {}),
    ...(config.bridgeDispatcherAuditLog
      ? { bridgeDispatcherAuditLog: config.bridgeDispatcherAuditLog }
      : {}),
    mcpVisibilityDeps: config.mcpVisibilityDeps,
    contractGrantDeps: config.contractGrantDeps,
    exposureDeps: config.exposureDeps,
    tlsDomainDeps: config.tlsDomainDeps,
    tokenRotationDeps: config.tokenRotationDeps,
    tlsRenewDeps: config.tlsRenewDeps,
    passportFetchDeps: config.passportFetchDeps,
    passportUserRpcDeps: config.passportUserRpcDeps,
    keyRotateDeps: config.keyRotateDeps,
    proAuthDeps: config.proAuthDeps,
    oauthClientConfigDeps: config.oauthClientConfigDeps,
    oauthAppConfigDeps: config.oauthAppConfigDeps,
    s2sPreviewDeps: config.s2sPreviewDeps,
    receptionDeps: config.receptionRpcDeps,
    receptionInboxDeps: config.receptionInboxDeps,
    chatDeps: config.chatDeps,
    ...(config.uploadDeps ? { uploadDeps: config.uploadDeps } : {}),
    ...(config.downloadDeps ? { downloadDeps: config.downloadDeps } : {}),
    ...(config.archiveUploadDeps ? { archiveUploadDeps: config.archiveUploadDeps } : {}),
    // Phase G (D-108/D-109) — WAS MISSING: `archiveDeps` is composed upstream +
    // threaded through `composeListeners`, but never forwarded into the ws-server
    // here, so `server.archive.export` / `server.archive.import` returned
    // `not_configured` over the live wire (the handler/runtime unit tests pass
    // because they bypass this seam). Same forward-or-dead-rpc trap as
    // `workEntitySourceDeps` / `contractDeps` above. Surfaced by a live
    // endpoint probe of the pre-pair restore flow (M5).
    ...(config.archiveDeps ? { archiveDeps: config.archiveDeps } : {}),
    // Sibling forward-or-dead-rpc bugs found in the SAME audit (Codex sibling
    // sweep over the compose→ServerConfig→ws-server pipeline): both were
    // composed in `composeListeners` + handler-registered in the ws-server but
    // never forwarded here, so their methods returned `not_configured` over the
    // live wire. `updateDeps` → `update.{check,mode,set_mode,apply,rollback}`
    // (D-178); `contactEngagementsRpcDeps` → `data.contact.engagements.list`
    // (D-139).
    ...(config.updateDeps ? { updateDeps: config.updateDeps } : {}),
    ...(config.contactEngagementsRpcDeps
      ? { contactEngagementsRpcDeps: config.contactEngagementsRpcDeps }
      : {}),
  });

  return {
    handlers: {
      health: healthHandler,
      ws: wsHandler,
      mcp: mcpHandler,
      ...(llmGatewayHandler ? { llm_gateway: llmGatewayHandler } : {}),
      webhooks: webhooksHandler,
      reception: receptionHandler,
      // D-165 — only mounted when the OAuth stores + bus are wired
      // (slice 2b Piece W); absent → path-router 404s `/oauth/complete`.
      ...(oauthCompleteHandler ? { oauth: oauthCompleteHandler } : {}),
      // D-158 P2b-ii — only mounted when the notification block is wired
      // (`composeListeners`); absent → path-router 404s `/ask/*`.
      ...(askLandingHandler ? { ask: askLandingHandler } : {}),
      // R26.2 Delta 3 — the embedded webclient bundle is a first-class
      // `webclient` path role. Mounted only when a verified bundle loaded
      // at boot (`config.webclientBundle`); absent → path-router 404s
      // `/webclient/*`. The per-listener `resolution.webclient` grid bit
      // gates whether it serves on LAN / public (LAN-on, public-off by
      // default), so this is wired identically on both listeners.
      ...(webclientHandler ? { webclient: webclientHandler } : {}),
    },
    upgradeHandlers: {
      ws: wsBinding.upgrade,
    },
    legacyAliases: SERVER_LEGACY_PATH_ALIASES,
    ...(rootHandler ? { rootHandler } : {}),
    ...(lanRootHandler ? { lanRootHandler } : {}),
    wsHandle: wsBinding.handle,
    close: () => wsBinding.handle.close(),
  };
};

/** Resolution table that enables every role on the LAN listener only —
 *  the test-side `startServer` baseline. Mirrors `lan_only`'s spec shape
 *  but widens `webhooks` + `reception` so tests exercising those paths
 *  reach their handlers. The production state machine in bin.ts wires
 *  the actual `DEFAULT_EXPOSURE_STATE` (which is `lan_only`'s narrower
 *  shape) + lets the user mutate from there. */
const TEST_ALL_PATHS_LAN_RESOLUTION: Record<PathRole, PathResolution> = {
  health: { lan: true, public: false },
  ws: { lan: true, public: false },
  mcp: { lan: true, public: false },
  llm_gateway: { lan: true, public: false },
  webhooks: { lan: true, public: false },
  reception: { lan: true, public: false },
  oauth: { lan: true, public: false },
  ask: { lan: true, public: false },
  webclient: { lan: true, public: false },
};
/** Start a single-listener path-routed server on the given port. Port 0
 *  picks a random free port — ideal for tests. Production wires through
 *  `createServerHandlerSet` + `createPathListenerSet` directly via the
 *  `ExposureStateMachine`; this helper is the test convenience that wires
 *  every role onto one LAN listener so existing fetch-based tests keep
 *  working unchanged. */
export const startServer = async (
  port: number,
  config: ServerConfig = {},
): Promise<RunningServer> => {
  const handlerSet = createServerHandlerSet(config);
  const certChain = createCertChainHolder(null);
  const hostnameSniDeps = config.hostnameSniDeps;
  const hostnameBindingLookup = hostnameSniDeps
    ? createHostnameSniBindingLookup(hostnameSniDeps.hostnameRegistry)
    : undefined;
  const publicPort = config.runtimeConfig
    ? (config.runtimeConfig.get('public_port') as number)
    : DEFAULT_PUBLIC_PORT;
  const listenerSet: PathListenerSet = createPathListenerSet({
    resolution: TEST_ALL_PATHS_LAN_RESOLUTION,
    handlers: handlerSet.handlers,
    upgradeHandlers: handlerSet.upgradeHandlers,
    legacyAliases: handlerSet.legacyAliases,
    // Offline-pairing convenience — thread the LAN bare-`/` handler onto the
    // test listener too (present only when the caller passed a
    // `webclientBundle`). `TEST_ALL_PATHS_LAN_RESOLUTION` enables
    // `webclient.lan`, so a test that also supplies `exposureDeps` returning
    // that resolution gets the 302; without a machine the handler 404s.
    ...(handlerSet.lanRootHandler ? { lanRootHandler: handlerSet.lanRootHandler } : {}),
    // R26.2 Delta 3 — the webclient handler is now a normal `webclient`
    // entry in `handlerSet.handlers` (gated by `resolution.webclient`),
    // forwarded via the `handlers` line above. A test that does
    // `startServer(0, { webclientBundle: {...} })` reaches `/webclient/*`
    // because `TEST_ALL_PATHS_LAN_RESOLUTION` enables `webclient.lan`.
    cert_chain: certChain,
    ...(hostnameBindingLookup && hostnameSniDeps
      ? {
          hostname_binding_lookup: hostnameBindingLookup,
          tls_domain_lookup: (servername: string) => hostnameSniDeps.tlsDomainStore.lookup(servername),
        }
      : {}),
    lan_port: port,
    lan_bind_address: '127.0.0.1',
    // Public listener never binds for the test baseline (no public path
    // is enabled in TEST_ALL_PATHS_LAN_RESOLUTION), but keep the public
    // status/config port aligned with recued.config.
    public_port: publicPort,
    public_bind_address: '127.0.0.1',
  });
  let closePromise: Promise<void> | undefined;
  const closeResources = (): Promise<void> => {
    if (closePromise) return closePromise;
    const begin = (stop: () => void | Promise<void>): Promise<void> => {
      try { return Promise.resolve(stop()); }
      catch (err) { return Promise.reject(err); }
    };
    // Both calls synchronously close admission before returning a drain
    // promise. Start both before awaiting either so one failed drain cannot
    // leave the sibling network surface accepting.
    const drains = [
      begin(() => handlerSet.close()),
      begin(() => listenerSet.stop()),
    ];
    closePromise = Promise.allSettled(drains).then((results) => {
      const errors = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, 'server teardown failed');
    });
    return closePromise;
  };
  const statuses = await listenerSet.start();
  const lanStatus = statuses.find((s) => s.listener === 'lan');
  if (!lanStatus || !lanStatus.listening) {
    await closeResources();
    throw new Error(`startServer: LAN listener failed to bind (${lanStatus?.failure ?? 'unknown'})`);
  }

  // The `Server` slot of `RunningServer` carries a thin façade so legacy
  // callers can call `.close()` through it; we delegate to the listener
  // set's stop. We never expose the underlying http.Server instance — it
  // was only used by the legacy single-listener flow.
  const serverFacade = {
    close: (cb?: (err?: Error) => void) => {
      void closeResources().then(() => cb?.()).catch((e) => cb?.(e as Error));
    },
  } as unknown as Server;

  return {
    server: serverFacade,
    port: lanStatus.port,
    wsServer: handlerSet.wsHandle,
    close: closeResources,
  };
};

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/** Read the request body and parse it as JSON. Empty body → undefined.
 *  Invalid JSON throws to surface as a 400 upstream. */
/** Thrown by `readJsonBody` when the request body exceeds the byte cap.
 *  The `wsHandler` catch maps it to 413 instead of a generic 500. */
class RequestBodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'RequestBodyTooLargeError';
  }
}

/** A body that is not JSON. Typed for the same reason `RequestBodyTooLargeError`
 *  is: the outer handler can only map a failure to the right status if the
 *  failure says what it is. `readJsonBody`'s contract is "throws on a malformed
 *  body", but the handler had no arm for it, so a syntax error fell to the
 *  catch-all and came back as a 500 whose message was the raw parser text — a
 *  server-fault status for a caller-fault input. */
class InvalidJsonBodyError extends Error {
  constructor() {
    super('Invalid JSON body');
    this.name = 'InvalidJsonBodyError';
  }
}

/** Cap the pre-auth request body. The only caller is `/auth/pair`, whose
 *  payloads are a few hundred bytes; bounding the buffer stops an
 *  unauthenticated LAN client from growing process memory with a giant
 *  POST before any code/recovery-key validation runs. */
const MAX_JSON_BODY_BYTES = 16 * 1024; // 16 KiB

const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
  // Explicit 'data'/'end' listeners + `req.pause()` on overflow (mirrors the
  // reception drop-link cap) rather than `for await` — throwing out of a
  // for-await closes the async iterator, which destroys the request stream
  // and can race the 413 response / stall keep-alive. Here we pause at the
  // source and reject; the socket stays intact for the `wsHandler` catch to
  // write the 413 cleanly.
  new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    function cleanup() {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    }
    function onData(chunk: Buffer) {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        settled = true;
        cleanup();
        req.pause(); // stop the flood at the source
        reject(new RequestBodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      if (chunks.length === 0) return resolve(undefined);
      const text = Buffer.concat(chunks).toString('utf-8');
      if (!text.trim()) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new InvalidJsonBodyError());
      }
    }
    function onError(err: unknown) {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });

/** Serialize a HandlerResult to the ServerResponse. */
const respond = (res: ServerResponse, result: HandlerResult<unknown>): void => {
  res.statusCode = result.status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (result.ok) {
    res.end(JSON.stringify(result.body));
  } else {
    res.end(JSON.stringify({ error: result.error }));
  }
};

/** D-121 Phase 5 — paths that the webapp may call cross-origin during
 *  pairing. The webapp lives at `app.recued.com` (or wherever the
 *  operator hosts it) while the user's server is at an arbitrary URL.
 *  Browsers block cross-origin POST without CORS, so we explicitly
 *  allow the canonical pair entry points (and only those — every other
 *  surface stays same-origin). The auth here is the request body
 *  (pairing_code + recovery_key), not browser-managed credentials, so
 *  `Access-Control-Allow-Origin: *` is appropriate. */
const PAIR_CORS_PATHS: ReadonlySet<string> = new Set([
  '/auth/pair',
  // D-148 — the identity probe has the same cross-origin shape and the same
  // reason to be safe: the webclient at `app.recued.com` must call a server at
  // an arbitrary URL, and what authorises the reply is the request body (a
  // fingerprint the caller must already hold), not browser-managed credentials.
  IDENTITY_PROBE_PATH,
]);

const isPairCorsPath = (pathname: string): boolean => PAIR_CORS_PATHS.has(pathname);

const writePairCorsHeaders = (res: ServerResponse): void => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
};
