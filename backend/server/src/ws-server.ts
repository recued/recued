/** WebSocket server — real-time channel between server and extension(s).
 *
 *  Upgrades HTTP connections on /ws to WebSocket. Each connected client
 *  authenticates with a realm token and registers an instance_id.
 *
 *  All extension→server method calls use a generic rpc envelope:
 *
 *    Extension → Server: { type: 'rpc', request_id, method, args? }
 *    Server → Extension: { type: 'rpc_result', request_id, result|error }
 *
 *  Methods exposed on the server side:
 *    execute                — run a recipe (mirrors POST /execute)
 *    schedules.list         — list schedules (mirrors GET /schedules)
 *    schedules.create       — create a schedule
 *    schedules.update       — update by schedule_id
 *    schedules.delete       — delete by schedule_id
 *
 *  The HTTP endpoints (POST /execute, /schedules CRUD) still exist for
 *  bootstrap/dev access; the extension uses WS exclusively post-pair.
 *
 *  Server-pushed message types:
 *    { type: 'ai_request', request_id, slug, input }
 *
 *  Zero external deps — uses Node's built-in WebSocket support (Node 22+).
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { PortUpgradeHandler } from '@recued/server-tls';
import { createRequire } from 'node:module';
import {
  composeHandlers,
  createPendingMap,
  getPref,
  SERVER_RPC_METHOD_SET,
  WS_VERSION_SUBPROTOCOL,
  decodeBearerSubprotocol,
  type BridgeCapabilityProfile,
  type BridgeResult,
  type BridgeWireEnvelope,
  type InstancePrefs,
  type ServerRpcRegistry,
} from '@recued/contracts';
import type { BridgeRegistry } from './bridges/registry.js';
import {
  createBridgeDispatcher,
  createBridgeResultListener,
  type BridgeDispatcher,
  type BridgeResultListener,
  type BridgeSendResult,
  type BridgeTransport,
} from './bridges/dispatcher.js';
import type { AuditLogStore } from '@recued/storage';
import type { ClientKind } from './pairing/client-tokens.js';
import { makeExecuteHandlers, type ExecuteHandlerDeps } from './execute-handler.js';
import { makeExecutionControlHandlers } from './execution-control-handler.js';
import { makeUploadHandlers, type UploadHandlerDeps } from './upload-handler.js';
import { UPLOAD_WS_MAX_PAYLOAD_BYTES } from './upload/webclient-upload-service.js';
import {
  DOWNLOAD_WS_MAX_INBOUND_BYTES,
  type DownloadHandlerDeps,
  type DownloadSink,
} from './download/webclient-download-service.js';
import {
  makeArchiveUploadHandlers,
  type ArchiveUploadHandlerDeps,
} from './archive-upload-handler.js';
import { makeRecipeListHandlers } from './recipe-list-handler.js';
import { makeRecipePiiHandlers } from './recipe-pii-handler.js';
import { makeRecipeSaveHandlers } from './recipe-save-handler.js';
import { makeRecipeRunnabilityHandlers } from './recipe-runnability-handler.js';
import { makeApprovalHandlers, type ApprovalHandlerDeps } from './approval-handler.js';
import { makeEventsHandlers, type EventsHandlerDeps } from './events/handler.js';
import { makeScheduleHandlers, type ScheduleHandlerDeps } from './schedule-handler.js';
import { makeDishHandlers, type DishHandlerDeps } from './dish-handler.js';
import { makeCacheHandlers, type CacheRpcDeps } from './cache-rpc-handler.js';
import { makeSharedHandlers, type SharedRpcDeps } from './shared-handler.js';
import { makeAnnotationHandlers, type AnnotationRpcDeps } from './annotation-handler.js';
import { makeChatHandlers, type ChatRpcDeps } from './chat-handler.js';
import { makeContactHandlers, type ContactRpcDeps } from './contact-handler.js';
import { makeContactMergeHandlers, type ContactMergeRpcDeps } from './contact-merge-handler.js';
import { makeUpstreamMergeHandlers, type UpstreamMergeRpcDeps } from './upstream-merge-handler.js';
import {
  makeConnectionHandlers,
  type ConnectionRpcDeps,
} from './connection-handler.js';
import {
  makeWebhookIngressHandlers,
  type WebhookIngressRpcDeps,
} from './webhook-ingress-handler.js';
import {
  makeContractHandlers,
  type ContractRpcDeps,
} from './contract-handler.js';
import {
  makeCliReachabilityHandlers,
  type CliReachabilityRpcDeps,
} from './cli-reachability-handler.js';
import {
  makeHostnameHandlers,
  type HostnameRpcDeps,
} from './hostname-handler.js';
import {
  makeNetworkHandlers,
  type NetworkRpcDeps,
} from './network-handler.js';
import {
  makeEngagementHealthHandlers,
  type EngagementHealthDeps,
} from './engagement-health-handler.js';
// D-122 Phase 4.5 — enrichment + notification + mail-get rpc slices.
import {
  makeEnrichmentHandlers,
  type EnrichmentRpcDeps,
} from './enrichment-handler.js';
import {
  makeNotificationHandlers,
  type NotificationDeps,
} from './notification-handler.js';
import {
  makeMailGetHandlers,
  type MailGetDeps,
} from './mail-get-handler.js';
// D-123 Phase 5 — housekeeping rpc slice.
import {
  makeHousekeepingHandlers,
  type HousekeepingRpcDeps,
} from './housekeeping-handler.js';
// D-163 Slice C — Settings → Notifications rpc slice. Wires the three
// `notifications.*` rpcs against the `@recued/notification` block's
// settings surface. Channel-isolation invariant — `notifications.` is
// in `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel agents cannot toggle
// the user's approval-bearing channels or overwrite the anti-phishing
// verification phrase.
import {
  makeNotificationsHandlers,
  type NotificationRpcDeps,
} from './notifications-handler.js';
// D-169 P1 — `system.status` rpc slice. Bridge side-panel reads its
// rich status snapshot from here on mount + periodic refresh.
import {
  makeSystemStatusHandlers,
  type SystemStatusDeps,
} from './system-status-handler.js';
// D-169 P2 — historical-view rpc slice (`execution.recent` /
// `notification.recent` / `notification.pending_asks`). Bridge side panel
// reads its recent slice from here on mount + every reconnect.
import {
  makeHistoryHandlers,
  type HistoryDeps,
} from './history-handler.js';
// D-174 Runs/Audit read seam (`execution.list` / `execution.get`).
// Webclient `#runs` consumes this richer sibling of `execution.recent`.
import {
  makeExecutionFeedHandlers,
  type ExecutionFeedRpcDeps,
} from './execution-feed-handler.js';
// D-145 PA10 follow-on — `packs.install` rpc slice. Wires the
// bulk-pack install transaction (recipes + body-content grants + pack-
// shipped Standing Instruction rows). Channel-isolation invariant —
// `packs.` is in `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel agents
// cannot ship attacker-controlled SI rules / body grants / recipes.
import {
  makePackInstallHandlers,
  type PackInstallRpcDeps,
} from './pack-install-handler.js';
// D-145 PA10 follow-on — `packs.list` rpc slice. Read counterpart to
// `packs.install`. Same `packs.` reserved-prefix gate; same per-pair
// `RecipeStore` handle for the `installed` join.
import {
  makePackListHandlers,
  type PackListRpcDeps,
} from './pack-list-handler.js';
// D-145 PA10 follow-on Slice B — `packs.uninstall` rpc slice. Reverses
// the install transaction (drops pack-installed SI rows by prefix +
// deletes each recipe in the bundled manifest). Same `packs.`
// reserved-prefix gate; same per-pair `RecipeStore` + SI store handles
// as install + list so the three rpcs see the same per-pair state.
import {
  makePackUninstallHandlers,
  type PackUninstallRpcDeps,
} from './pack-uninstall-handler.js';
// D-170 — `ingredient.install` / `ingredient.uninstall` rpc (the
// direct-manifest authoring install path; reserved-prefix gated like packs.*).
import {
  makeIngredientAuthoringHandlers,
  type IngredientAuthoringRpcDeps,
} from './ingredient-authoring/install-rpc.js';
// D-170 N.4 / N.15 / #2 — `ingredient.draft.*`,
// `ingredient.preview`, and `ingredient.compose.decompose` rpc (authoring
// draft store + test-before-save preview/decompose; same reserved-prefix posture).
import {
  makeIngredientDraftHandlers,
  type IngredientDraftRpcDeps,
} from './ingredient-authoring/draft-preview-rpc.js';
// D-136 §A.13.5 P7.G — MCP visibility user-override rpc slice.
import {
  makeMCPVisibilityHandlers,
  type MCPVisibilityRpcDeps,
} from './mcp-visibility-handler.js';
// Grant-foundation slice 3 — unified (contract × grant) matrix rpc slice.
import {
  makeContractGrantHandlers,
  type ContractGrantRpcDeps,
} from './contract-grant-handler.js';
// D-148 W3.FU — Per-path Exposure state mutators rpc slice.
import {
  makeExposureHandlers,
  type ExposureRpcDeps,
} from './exposure-handler.js';
// D-148 follow-up #4 — BYO cert upload + remove + list rpc slice.
import {
  makeTlsDomainHandlers,
  type TlsDomainRpcDeps,
} from './tls-domain-handler.js';
// D-148 follow-up #5 — Pro auto-managed `<handle>.recued.cloud` unbind rpc.
import {
  makeProAcmeHandlers,
  type ProAcmeRpcDeps,
} from './pro-acme-handler.js';
// D-148 § A.4.4 — `token.rotate` rpc slice. Wires the per-client
// bearer rotation + `token.rotated` broadcast emit path.
import {
  makeTokenRotationHandlers,
  type TokenRotationRpcDeps,
} from './pairing/token-rotation-handler.js';
// D-148 § A.6.5 — `tls.renew` rpc slice. Wires the operator-initiated
// TLS cert renewal path against the shared `RotationEngine` composed
// in bin.ts (cert-rotation broadcaster + signing identity + audit
// sink). The engine returns `key_not_loaded` until the production
// `tls` substrate hook lands; the slice surfaces that verbatim.
import {
  makeTlsRenewHandlers,
  type TlsRenewRpcDeps,
} from './keys/rotation/tls-renew-handler.js';
// R26.4 Delta 3 (D-148 § A.11) — `key.rotate` + `key.health` rpc slice.
// Operator-initiated key rotation (Settings → Server → Key Health)
// against the SAME shared `RotationEngine` + the compromise-ledger-
// backed health view. `key.` is in `MCP_RESERVED_RPC_PREFIXES`.
import {
  makeKeyRotateHandlers,
  type KeyRotationRpcDeps,
} from './keys/rotation/key-rotate-handler.js';
// D-148 § A.6.5 + § A.9 — `passport.fetch` rpc slice. Wires the
// webclient post-WS-connect verify path against the passport block-
// providers + `server_identity_key` keypair composed in bin.ts.
// Closes the gap between the rotation-notice handler (which stages a
// `next_fingerprint` but cannot observe a TLS cert directly through the
// browser's `WebSocket` API) and real promotion of the staged-next.
// Absent deps → `passport.fetch` returns `not_configured` (db-less
// harness or a boot whose providers haven't been composed yet — the
// full `passport.export` substrate wiring is a separate slice).
import {
  makePassportFetchHandlers,
  type PassportFetchRpcDeps,
} from './passport/fetch-handler.js';
// R26.4 Delta 2 — `passport.export` + `passport.history.list` (the
// user-initiated half; the "separate slice" the comment above named).
import {
  makePassportExportHandlers,
  makePassportHistoryListHandlers,
  type PassportUserRpcDeps,
} from './passport/export-handler.js';
// R26.4 Delta 5 — `passport.import` (new-server migration commit).
import { makePassportImportHandlers } from './passport/import-handler.js';
// D-156 P9 retired the `pair.mint` / `pair.consume` rpc slices (and
// their handler / consume-ledger / pair-blob substrate). CLI
// `recued-server pair` + `POST /auth/pair` is the sole pair path now.
// D-148 § A.5.3 / § A.6.5 — Pro auth rpc slice. Wires Settings → Pro
// against the per-pair `ProAuthStateMachine` composed in bin.ts so the
// `authenticate` / `signOut` mutations flow through `onStateChanged`
// to the ACME factory's `ProAuthResolver` ref. Channel-isolation
// invariant — `pro.` is in `MCP_RESERVED_RPC_PREFIXES`.
import {
  makeProAuthHandlers,
  type ProAuthRpcDeps,
} from './pro-auth/handler.js';
// D-149 P3 § A.3 — Public Reception registry rpc slice. Closes over the
// per-pair `PublicEndpointRegistryStore` + the preview-hash store + the
// reception pepper getter; the path-router-side handler (`createReceptionPortHandler`)
// closes over the rate limiter / registry cache for visitor traffic.
import {
  makeReceptionHandlers,
  makeReceptionInboxRpcHandlers,
  makeReceptionRecordRpcHandlers,
  makeReceptionLookupRevokeRpcHandlers,
  makeReceptionManageMintRpcHandlers,
  type ReceptionInboxDeps,
  type ReceptionRecordDeps,
  type ReceptionManageMintDeps,
  type ReceptionLookupRevokeDeps,
  type ReceptionRpcDeps,
} from './reception-rpc-handler.js';
// D-145 PA11 — Settings → Work Entities Source management rpc slice.
import {
  makeWorkEntitySourceHandlers,
  type WorkEntitySourceRpcDeps,
} from './work-entity-source-handler.js';
// D-205 #2c — `contact.source.list`: per-Source contact sync health.
import { makeContactImportHandlers, type ContactImportRpcDeps } from './contact-import-handler.js';
import {
  makeContactSourceHandlers,
  type ContactSourceRpcDeps,
} from './contact-source-handler.js';
import {
  makeWorkEntityCrudHandlers,
  type WorkEntityCrudRpcDeps,
} from './work-entity-crud-handler.js';
import {
  makeFormResponseHandlers,
  type FormResponseRpcDeps,
} from './form-response-handler.js';
import {
  makeRecordsRpcHandlers,
  type RecordsRpcDeps,
} from './records-rpc-handler.js';
import {
  makeTimelineRpcHandlers,
  type TimelineRpcDeps,
} from './timeline-rpc-handler.js';
import {
  makeMemoryRpcHandlers,
  type MemoryRpcDeps,
} from './memory-rpc-handler.js';
import {
  makeFileReadRpcHandlers,
  type FileReadRpcDeps,
} from './file-read-rpc-handler.js';
// D-139 P5 — `data.contact.engagements.list` resolver pair-RPC slice.
import {
  makeContactEngagementsRpcHandlers,
  type ContactEngagementsResolveDeps,
} from './contact-engagements-rpc-handler.js';
// D-145 PB12 — Peer-Recued Preview (`s2s_preview.{build,consume}`) rpc slice.
import {
  makeS2SPreviewHandlers,
  type S2SPreviewRpcDeps,
} from './s2s-preview/handlers.js';
import { makeWatcherRpcHandlers, type WatcherRpcDeps } from './watcher-rpc-handler.js';
import {
  makeTriggerTestRpcHandlers,
  type TriggerTestRpcDeps,
} from './trigger-test-rpc-handler.js';
import {
  makeBootstrapHandlers,
  type BootstrapHandlerDeps,
} from './bootstrap-handler.js';
import {
  makeOAuthClientConfigHandlers,
  type OAuthClientConfigDeps,
} from './oauth-client-config-handler.js';
import {
  makeOAuthAppConfigHandlers,
  type OAuthAppConfigHandlerDeps,
} from './oauth-app-config-handler.js';
import {
  makePressureHandlers,
  type PressureHandlerDeps,
} from './pressure-handler.js';
import {
  handleCollectionMailSend,
  makeCollectionHandlers,
  type CollectionHandlerDeps,
} from './collections/collection-handler.js';
import {
  makeAuditExportHandlers,
  type AuditExportRpcDeps,
} from './audit-export-handler.js';
import {
  makeTriggersHandlers,
  type TriggersRpcDeps,
} from './triggers/handler.js';
import {
  makeElementWatchHandlers,
  type ElementWatchRpcDeps,
} from './element-watch-handler.js';
import {
  makeAutoRunHandlers,
  type AutoRunRpcDeps,
} from './auto-run-handler.js';
import {
  makeWatchHandlers,
  type WatchRpcDeps,
} from './watch/handler.js';
import {
  makeArchiveHandlers,
  type ArchiveRpcDeps,
} from './archive/archive-handler.js';
import { makeAuthHandlers, type AuthDeps } from './auth-handler.js';
import {
  makeMigrateHandlers,
  type MigrateDeps,
} from './migration/auth-migrate-handler.js';
import { makePrefsHandlers } from './prefs-handler.js';
import { makePairHandlers } from './pair-handler.js';
import { makeAccountBindingHandlers } from './account-binding-handler.js';
import { makeProConvenienceHandlers } from './pro-convenience-handler.js';
import { makeDdnsHandlers } from './ddns-handler.js';
import { makeSupervisionHandlers } from './supervision-handler.js';
import { makeUpdateHandlers } from './update-handler.js';
import {
  makeBridgeCapabilityHandlers,
  type BridgeCapabilityHandlerDeps,
} from './bridge-capability-handler.js';
import { makeRecoveryHandlers } from './recovery-key-processor.js';
import { makeConfigHandlers } from './config-schema.js';
import { makeSellerOverviewHandlers } from './seller-overview-handler.js';
import { createSellerStripeEntitlementProvider } from './seller/stripe-entitlement-sync.js';
import { createRpcDispatcher } from './rpc-dispatcher.js';
import type { PairedInstancesStore } from './paired-instances-store.js';
import type { ChatInboundTokenStore } from './storage/chat-inbound-token-store.js';
import type { ContractStore } from './storage/contract-store.js';
import type { SellerOrderStore } from './storage/seller-order-store.js';
import type { SellerStore } from './storage/seller-store.js';
import type { SellerClaimStore } from './storage/seller-claim-store.js';

/** M5 S3 — rpc methods accepted on a bearer-verified but NOT-yet-realm-enrolled
 *  server, beyond the enrollment method itself. Until now `pair.registerRecoveryKey`
 *  was the sole exception; the pre-pair "restore from backup" onboarding needs a
 *  code-paired (bearer-verified) client to stage + validate + restore a backup
 *  BEFORE the realm is sealed (the realm arrives in the archive's own sentinel at
 *  a successful commit). These are read-only / ciphertext-staging ops; the
 *  destructive `import` is independently authorized by the recovery-key realm
 *  check + the empty-warehouse guard in `verifyRestoreRealm`. */
const PRE_ENROLLMENT_ALLOWED_RPC_METHODS: ReadonlySet<string> = new Set([
  'pair.registerRecoveryKey',
  'server.archive.upload.create',
  'server.archive.upload.probe',
  'server.archive.upload.finalize',
  'server.archive.upload.delete',
  'server.archive.import',
]);

/** Look up the merged prefs view for a paired instance. Returns
 *  `undefined` when the row is missing so callers can let
 *  `getPref` fall back to registry defaults in one branch. */
const loadPrefsOrUndefined = (
  store: PairedInstancesStore,
  instance_id: string,
): Partial<InstancePrefs> | undefined => {
  const row = store.get(instance_id);
  if (!row) return undefined;
  return store.getPrefs(instance_id);
};
import type { LLMConfigManager } from './llm-config.js';
import type { RuntimeConfigStore } from '@recued/config';

// ⛔ `?? __filename` is what makes this survive inside the SEA binary, not
// defensive padding. esbuild replaces `import.meta` with `{}` in CJS output, so
// `import.meta.url` is UNDEFINED there and `createRequire(undefined)` throws at
// MODULE LOAD — `recued serve` died before printing anything with "The argument
// 'filename' must be a file URL object, file URL string, or absolute path
// string. Received undefined". `__filename` is native in CJS and never
// evaluated under ESM (`??` short-circuits), so one expression covers the ESM
// source, the ESM bundle, and the CJS/SEA bundle.
const require = createRequire(import.meta.url ?? __filename);

/** D-169 P0 follow-on — empty-but-typed capability profile used as the
 *  seed value at WS-upgrade `bridgeRegistry.attach()` time. The bridge
 *  SW's `onConnected` hook fires the first capability push immediately
 *  after the WS opens (see `apps/bridge/src/boot/service-worker-bootstrap.ts`),
 *  overwriting these defaults with the real grants. Until that push
 *  arrives, an empty `granted_origins` keeps the dispatcher's
 *  eligibility filter honest — no bridge appears eligible for any
 *  pattern until it has actually reported its grants. */
const emptyBridgeCapabilityProfile = (): BridgeCapabilityProfile => ({
  software_version: '',
  chrome_version: '',
  permissions_granted: [],
  granted_origins: [],
  offscreen_supported: false,
  alarms_supported: false,
});

/** Maximum size of one inbound JSON message on the primary rpc socket.
 *
 *  Recipe authoring and other application envelopes can legitimately be much
 *  larger than the small HTTP control bodies, so keep a generous 4 MiB
 *  ceiling. The `ws` default is 100 MiB, however, which lets one authenticated
 *  client make the server allocate and then stringify/parse a very large frame
 *  before any rpc-level validation can run. Binary file and archive traffic
 *  uses the separately capped data sockets below. */
export const RPC_WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

/** Bound asynchronous rpc work admitted from the primary socket.
 *
 *  A paired client may legitimately fan out independent reads, so these are
 *  deliberately generous rather than a throughput throttle. Without a hard
 *  ceiling, however, one buggy or compromised bearer can enqueue an
 *  unbounded number of slow handlers and retain their request state until the
 *  downstream calls settle. The global ceiling also covers reconnect/many-tab
 *  fan-out that would evade a per-socket limit. */
export const RPC_WS_MAX_IN_FLIGHT_PER_CLIENT = 64;
export const RPC_WS_MAX_IN_FLIGHT_GLOBAL = 256;

/** Maximum simultaneously running upload chunks / archive chunks / archive
 *  downloads across all data sockets. The shipped upload transport is
 *  strictly ack-paced (one chunk in flight per socket); this process-wide cap
 *  prevents a bearer from bypassing that property with many sockets. */
export const DATA_WS_MAX_IN_FLIGHT_GLOBAL = 16;

/** Maximum serialized JSON bytes queued on one WebSocket. A normal socket
 *  drains each send promptly; crossing this generous ceiling means the peer is
 *  stalled (or one response is pathologically large), and retaining more
 *  frames only converts that peer into an unbounded process-memory sink. */
export const WS_JSON_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export type BoundedWsJsonSendResult =
  | { ok: true; bytes: number }
  | {
      ok: false;
      reason: 'closed' | 'serialization_error' | 'backpressure' | 'transport_error';
      detail?: string;
    };

/** Serialize + enqueue one JSON frame under a hard per-socket pressure cap.
 *  Exported as a leaf helper so the memory-safety behavior is testable without
 *  manufacturing kernel socket backpressure. */
export const sendBoundedWsJson = (
  socket: {
    readyState: number;
    bufferedAmount?: number;
    send(data: string): void;
    terminate?: () => void;
    close?: () => void;
  },
  data: unknown,
  openState = 1,
): BoundedWsJsonSendResult => {
  if (socket.readyState !== openState) return { ok: false, reason: 'closed' };
  const terminate = (): void => {
    try {
      if (typeof socket.terminate === 'function') socket.terminate();
      else socket.close?.();
    } catch { /* already closed */ }
  };

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch (err) {
    terminate();
    return {
      ok: false,
      reason: 'serialization_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (serialized === undefined) {
    terminate();
    return { ok: false, reason: 'serialization_error', detail: 'JSON value is not serializable' };
  }

  const bytes = Buffer.byteLength(serialized, 'utf8');
  const rawBuffered = socket.bufferedAmount;
  const buffered = typeof rawBuffered === 'number' && Number.isFinite(rawBuffered) && rawBuffered > 0
    ? rawBuffered
    : 0;
  if (bytes > WS_JSON_MAX_BUFFERED_BYTES || buffered > WS_JSON_MAX_BUFFERED_BYTES - bytes) {
    terminate();
    return { ok: false, reason: 'backpressure' };
  }

  try {
    socket.send(serialized);
    return { ok: true, bytes };
  } catch (err) {
    // Preserve the caller-visible transport error without forcing a second
    // lifecycle transition here. In-memory/test transports and some adapters
    // deliberately throw while the socket remains closable; the owner decides
    // whether/when to revoke it. Backpressure above is the branch that must
    // terminate immediately to bound retained memory.
    return {
      ok: false,
      reason: 'transport_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
};

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface WsClient {
  ws: any; // WebSocket instance (from ws package)
  realm: string;
  /** Set ONLY by the `register` message (extensions / bridges). Webclients
   *  are bearer-only and never register, so theirs stays null. Every
   *  "find/broadcast to a connected extension" path (delegateAi /
   *  delegateChat / peerCache* / kernel-recipe / server-heartbeat) +
   *  the `maxInstances` count key on this field, so it must stay the
   *  "registered extension" marker — do NOT populate it for webclients
   *  (that would mis-route bridge-only frames to a webclient that drops
   *  them, and count webclient tabs against the extension limit). */
  instance_id: string | null;
  /** D-151 follow-on — paired-instance identity DERIVED from the verified
   *  client token's `metadata.instance_id` (stamped at `/auth/pair`,
   *  inherited across token rotation). Set for ANY structured-bearer
   *  client (incl. bearer-only webclients that never `register`), gated
   *  on the instance not being revoked. Consumed ONLY by the rpc gate
   *  layer: at rpc dispatch (the `case 'rpc'` handler) a webclient with
   *  null `instance_id` is handed the gated handlers a shallow copy whose
   *  `instance_id` is resolved to this value, so every
   *  `requireCallerInstance` gate (reception / hostname / timeline /
   *  inbox / exposure / …) accepts a paired webclient WITHOUT this value
   *  ever reaching an `instance_id`-keyed routing/limit path (the live
   *  `clients` map entry keeps its null). This is the "bearer-derived
   *  identity" D-156 P7/P10 called for. */
  token_instance_id?: string | null;
  display_name: string;
  connected_at: number;
  /** User_id reported by the extension on `register`. Populated when
   *  the ext is signed in; undefined for anonymous/free use. The
   *  server-heartbeat emitter uses any registered client's user_id as
   *  the `uid` on its own heartbeat payload — all of one account's
   *  exts + server share the same uid in the cloud aggregator. */
  user_id?: string;
  /** D-148 § A.2.1 — durable `client_tokens.token_id` resolved at WS
   *  bearer-verify time. Populated for clients that present the
   *  structured `<token_id>.<bearer>` shape AND match an active row in
   *  `client_tokens` (via `clientTokens.verify` on upgrade). Undefined
   *  only for db-less compositions that don't wire `clientTokens`
   *  through `AttachWebSocketOptions`. `revokeConnectedInstance` returns
   *  this field so `handlePairRevoke` can stamp
   *  `detail.client_token_id` — the `pair_revoke` ledger row then joins
   *  directly to `pair_consume` (whose `target` IS the
   *  `client_token_id`). Independent of `pair.list`, which still
   *  resolves rows by `instance_id` — the device-revoke UX is unchanged
   *  for callers that don't care about the audit join. */
  client_token_id?: string;
  /** D-169 P0 — `client_tokens.client_kind` resolved alongside
   *  `client_token_id` at WS bearer-verify time. Closes the seam between
   *  this slice's WS-upgrade `bridgeRegistry.attach()` and the
   *  `bridge.capabilityProfile.push` rpc: the on-close handler reads
   *  `client_kind === 'bridge'` to decide whether to detach a registry
   *  record. Undefined for compositions that don't wire `clientTokens`
   *  through. */
  client_kind?: ClientKind;
  /** D-169 P0 — `client_tokens.client_label` resolved alongside
   *  `client_token_id`. Threaded into the `BridgeRegistry` record's
   *  `client_label` slot so `byLabel(label)` lookups (used by the
   *  dispatcher's `preferred_bridge_label` fast-path in Slice 4) hit
   *  this connection. Undefined when the issued token had no label. */
  client_label?: string;
  /** D-169 P0 — per-WS-connection bridge session id (random UUID),
   *  populated for `client_kind === 'bridge'` connections. Lets the
   *  on-close handler safely detach from `BridgeRegistry` without racing
   *  a fresh reconnect: detach only when the registry's current record's
   *  `session_id` still matches this socket's stamp. A reconnect that
   *  raced the close handler will have overwritten `session_id` via the
   *  attach call, so the stale close skips the detach. */
  bridge_session_id?: string;
}

// D-151 / D-156 follow-on — the pure client-identity resolvers live in the
// `ws-client-identity.ts` leaf module so the `*-handler.ts` files can import
// them at runtime without the ws-server ↔ handler dependency cycle (ws-server
// imports every `make*Handlers`; handlers `import type` from ws-server only).
// Re-exported here for back-compat: existing callers + tests import these
// from `../ws-server.js`. The internal upgrade + dispatch paths below use the
// re-exported bindings.
export {
  deriveBearerInstanceId,
  resolveGatedClientInstanceId,
  resolveGatedClientOwnerId,
  SELF_HOST_OWNER_ID,
} from './ws-client-identity.js';
import {
  deriveBearerInstanceId,
  resolveGatedClientInstanceId,
} from './ws-client-identity.js';

/** Pending AI delegation request — server waits for extension to relay. */
export interface AiDelegation {
  request_id: string;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface WsServerHandle {
  /** Number of connected registered clients (with instance_id). */
  clientCount(): number;
  /** List currently-connected registered instances. Used by the
   *  server-heartbeat emitter to publish its authoritative roster
   *  (`ServerHeartbeat.instances_online`). Each entry snapshots name +
   *  connected_at; instance_id is the key, guaranteed non-null for
   *  every element (unregistered connections are excluded). */
  listConnectedInstances(): Array<{
    instance_id: string;
    name: string;
    connected_at: number;
  }>;
  /** D-156 follow-on — currently-connected *paired* instance ids for the
   *  `pair.list` `connected` / `connected_at` columns, INCLUDING bearer-only
   *  webclients. Distinct from `listConnectedInstances` (extension-only,
   *  drives the server-heartbeat roster): a webclient keeps a null
   *  `instance_id` in the live `clients` map — its paired identity lives in
   *  `token_instance_id` (derived from the verified token at upgrade) — so it
   *  is absent from `listConnectedInstances` and would otherwise always
   *  render as offline. This method falls back to `token_instance_id`, so a
   *  live webclient matches its durable `paired_instances` row (whose
   *  `instance_id` is the same `/auth/pair` value). `connected_at` is unix
   *  seconds, matching `listConnectedInstances`. */
  listConnectedPairedInstances(): Array<{
    instance_id: string;
    connected_at: number;
  }>;
  /** Last-seen `user_id` from any connected client. The server-heartbeat
   *  emitter uses this as `uid` on its own heartbeat payload so the cloud
   *  aggregator groups server + ext under the same user bucket.
   *  Undefined when no signed-in client has ever registered. */
  getPairedUserId(): string | undefined;
  /** Forcibly disconnect a connected instance with the
   *  `instance_revoked` close message. Used by `pair.revoke` (explicit
   *  user action) and the `register { intent: 'replace' }` path. The
   *  extension's on-close handler reads the close reason and self-
   *  cleans vault + installed state.
   *
   *  Returns `{ revoked, client_token_id? }`. `revoked: true` iff the
   *  instance was found and closed. `client_token_id` (when present)
   *  is the durable `client_tokens.token_id` the closed socket was
   *  authenticated under — read from `WsClient.client_token_id`
   *  BEFORE the socket is deleted from the `clients` map. Populated
   *  for sockets that completed the structured `<token_id>.<bearer>`
   *  bearer-verify handshake; undefined only when the composition does
   *  not wire `clientTokens`, so the caller stamps `detail.client_token_id` only when the join is
   *  actually meaningful. Mirrors `pair_consume`'s targeting
   *  convention so the device-credential ledger joins consume → revoke
   *  on the same column. */
  revokeConnectedInstance(instance_id: string): {
    revoked: boolean;
    client_token_id?: string;
  };
  /** D-148 § A.6.5 — close every connected WS client with the
   *  `instance_revoked` close message (code 4003), same wire semantics
   *  `revokeConnectedInstance` uses for the per-instance case. Called
   *  from the rotation engine's `closeActiveSessions` hook on
   *  `server_identity_key` rotation: after every paired_instances row
   *  is marked revoked in SQLite, the WS layer kicks the in-flight
   *  sessions so paired clients receive the close + wipe their cached
   *  pair state rather than retry against the rotated fingerprint.
   *  Returns the number of clients closed. Distinct from
   *  `closeAllForWsLockout` (code 4004 / vault preserved) — this is the
   *  "your server identity changed, re-pair" semantic that aligns with
   *  the per-instance revoke flow. */
  revokeAllConnectedInstances(): number;
  /** D-148 W3.FU + spec § A.6.6 — close every connected WS client with
   *  the `ws_lockout` close message + close code 4004 ('ws path
   *  disabled'). Distinct from `revokeConnectedInstance`: the latter is
   *  a per-instance revocation that signals the client to wipe
   *  vault/installed state; this method is a path-level disable that
   *  the client treats as transient (the path may come back). Returns
   *  the number of clients closed.
   *
   *  Called by the `exposure.*` rpc handlers after a successful
   *  mutation when `/ws` resolution lands on `{ lan: false, public:
   *  false }` — the substrate's "disconnect webclients" / "disable ws"
   *  phrase gate is a contract that this method makes good on per spec
   *  § A.6.6 ("listener-set rebind triggers graceful WS connection
   *  drain"). */
  closeAllForWsLockout(reason: string): number;
  /** Max extension instances allowed. 0 = unlimited. Default: 1 (free tier). */
  maxInstances: number;
  /** Delegate an AI call to a connected extension (picks first client). */
  delegateAi(slug: string, input: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Delegate a chat ingredient via broadcast → claim → execute.
   *  Broadcasts to all clients, first to claim wins, others are revoked.
   *  Returns the chat result from the claiming client. */
  delegateChat(slug: string, input: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Query the paired extension's installed ingredient catalog. Used by
   *  the MCP tool-list generator to implement the extension-first rule:
   *  when the extension is online, its ingredients take priority; when
   *  offline this method returns null so the caller falls back to the
   *  server-local catalog. */
  listExtensionIngredients(
    timeoutMs?: number,
  ): Promise<Array<{ slug: string; manifest: unknown }> | null>;
  /** Delegate a kernel recipe (`run-ingredient`) to the paired extension.
   *  Used by MCP per-ingredient tool dispatch when the extension holds
   *  the ingredient. Returns the extension's execute result. */
  runKernelRecipeOnExtension(
    recipe_id: string,
    config: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  /** Peer-query the extension's cache on server-side miss. Returns the
   *  entry or null. Used by the server's peer-wrapped cache store to
   *  pull warehouse-pre-computed entries the extension may already
   *  hold — the reverse of the existing ext→srv cache.get flow. */
  peerCacheGet(
    key: string,
    timeoutMs?: number,
  ): Promise<import('@recued/cache').CacheEntry | null>;
  /** Broadcast fresh cache entries to all connected extensions.
   *  Fire-and-forget — extensions treat their local cache as
   *  advisory, so a missed push is recovered on the next miss via
   *  peerCacheGet. Symmetric with the existing ext→srv cache.put. */
  peerCachePut(entries: import('@recued/cache').CacheEntry[]): void;
  /** D-169 P0 follow-on — multi-bridge dispatcher composed inside the
   *  ws layer when `bridgeRegistry` is wired (Slice 4's
   *  `createBridgeDispatcher` over the per-connection `clients` map as
   *  the WS transport + the per-process `BridgeResultListener` for
   *  inbound `{kind: 'result'}` correlation). Undefined when
   *  `bridgeRegistry` was not threaded through — callers should treat
   *  the slot as opt-in. Downstream DOM-ingredient runners pull this
   *  from the handle to fire `dispatch(...)`; the dispatcher owns
   *  eligibility filtering (Slice 4), sequential fall-through, and
   *  per-bridge 429 retry. */
  bridgeDispatcher?: BridgeDispatcher;
  // D-103: peerCacheInvalidate + cache.invalidate rpc removed. TTL +
  // LRU handle expiry without cross-peer coordination.
  /** Phase G (D-109) — broadcast the server's current runtime state
   *  to every registered extension. The extension's SW receives it
   *  under the `server_heartbeat` ws message type and caches +
   *  broadcasts to its pill listeners. `payload` is the same shape
   *  the cloud-side heartbeat emitter builds. Fire-and-forget —
   *  a missed push surfaces as a stale snapshot (pill goes gray). */
  broadcastServerHeartbeat(payload: unknown): void;
  /** Close upgrade/message admission + all connections, then drain rpc/data
   *  handlers and bearer checks admitted before teardown began. Idempotent. */
  close(): Promise<void>;
}

// ────────────────────────────────────────────────────────────────
// Implementation
// ────────────────────────────────────────────────────────────────

export interface AttachWebSocketOptions {
  /** Recipe execution dependencies. When provided, rpc method 'execute'
   *  invokes handleExecute. Without it, returns not_configured error. */
  executeDeps?: ExecuteHandlerDeps;
  /** Schedule CRUD dependencies. When provided, rpc 'schedules.*' methods
   *  are dispatched. Without it, returns not_configured error. */
  scheduleDeps?: ScheduleHandlerDeps;
  /** D-179 P1 — dish CRUD dependencies. When provided, rpc 'dishes.*'
   *  methods are dispatched. Without it, returns not_configured. */
  dishDeps?: DishHandlerDeps;
  /** Cache rpc dependencies. When provided, cache.* methods are dispatched
   *  (cache.get/put/since). Without it, returns not_configured. */
  cacheDeps?: CacheRpcDeps;
  /** Shared-store rpc dependencies (D-103 Phase A). When provided,
   *  shared.* methods dispatch against the durable `data.shared.*`
   *  store. Absent → not_configured; the ext kernel ingredient falls
   *  back to `server_not_reachable`. */
  sharedDeps?: SharedRpcDeps;
  /** Auth rpc dependencies. When provided, auth.* methods are dispatched
   *  (auth.state/init/unlock/lock). Without it, returns not_configured. */
  authDeps?: AuthDeps;
  /** Migrate rpc dependencies. When provided, auth.migrate.* methods
   *  are dispatched. Activating the migration marker puts ws dispatch
   *  into maintenance mode — only auth.* and status/resume are allowed. */
  migrateDeps?: MigrateDeps;
  /** LLM config manager. When provided, server.getLLMConfig and
   *  server.setLLMConfig are dispatched — this is the primary provisioning
   *  path for the paired extension's "Server LLM settings" panel. */
  llmConfigManager?: LLMConfigManager;
  /** Runtime config store (D-103 Phase A). Provides the non-LLM half
   *  of `server.getConfigSchema` / `server.setConfigField` — every
   *  scalar `RUNTIME_SCHEMA` key that isn't LLM-managed routes through
   *  here. Optional so existing tests + minimal compositions keep
   *  returning the LLM-only schema. */
  runtimeConfig?: RuntimeConfigStore;
  /** D-196 S2 — Settings -> Seller overview and manual local writes. Absent on
   *  db-less boots so the rpc returns `not_configured`. */
  sellerStore?: SellerStore;
  /** D-207 order-is-the-lifecycle — `core.seller.order` read store backing the
   *  owner Orders view (`server.seller.listOrders`). Absent → that rpc 503s. */
  sellerOrderStore?: SellerOrderStore;
  /** D-196 S2 — contract substrate for manual customer issue/extend. */
  sellerContractStore?: ContractStore;
  /** D-196 S2 — inbound token substrate for manual customer issue/extend. */
  sellerInboundTokenStore?: ChatInboundTokenStore;
  /** D-196 S3c — sealed one-time claim substrate for bearer delivery. */
  sellerClaimStore?: SellerClaimStore;
  /** Bootstrap / status rpc deps (D-103 Phase A). When
   *  provided, the `server.getBootstrap` / `stageBootstrap` /
   *  `requestRestart` / `getStatus` / `setPaused` / `getPauseState`
   *  methods dispatch. Absent → those rpc methods return
   *  `not_configured`. */
  bootstrapDeps?: BootstrapHandlerDeps;
  /** Server's stable id (UUID), persisted in SQLite at first boot. Sent
   *  back to the extension on `registered` so the ext can pin the server
   *  identity in its SyncConfig and advertise `srv_id` on heartbeats.
   *  Address-independent — same id regardless of which URL the ext used
   *  to reach the server. */
  serverId?: string;
  /** Durable paired-device roster. When provided, `pair.list` and
   *  `pair.revoke` RPCs are dispatched AND the register path upserts
   *  a row on first successful register per instance. Without it, the
   *  pair.* RPCs return `not_configured` and register relies only on
   *  in-memory state (legacy free-tier behavior). */
  pairedInstances?: import('./paired-instances-store.js').PairedInstancesStore;
  /** D-148 § A.2.1 — signed-wrapper audit sink for `pair.revoke`'s
   *  high-assurance `pair_revoke` row emission. Optional; composer-
   *  side absence is a no-op (the rpc still revokes the device + closes
   *  the ws, just without a ledger entry). bin.ts passes its
   *  `createSigningAuditLog`-wrapped store so the Ed25519 signature
   *  lands at emit time. */
  pairRevokeAuditLog?: Pick<import('@recued/storage').AuditLogStore, 'logActivity'>;
  /** D-175 P5 — recued.com account-binding handler deps. When provided,
   *  the `account.bind` / `account.unbind` / `account.bindingStatus`
   *  RPCs dispatch against the binding manager (receive token → exchange
   *  with the auth Worker → store the server-scoped credential as
   *  identity-root material; conflict-gated, audited). Absent → those
   *  methods return `not_configured` (db-less harness, or a boot before
   *  the signing identity is wired). `account.` is in
   *  `MCP_RESERVED_RPC_PREFIXES`, so the namespace never bridges to MCP. */
  accountBindingDeps?: import('./account-binding-handler.js').AccountBindingHandlerDeps;
  /** D-175 P8 — Pro convenience status handler deps. Backs the
   *  `pro_convenience.status` RPC. The provisioner reads the binding
   *  (secret-free) + gates on the Pro entitlement resolved off the
   *  binding credential. Absent → the method returns `not_configured`.
   *  `pro_convenience.` is in `MCP_RESERVED_RPC_PREFIXES`, so the
   *  namespace never bridges to MCP. */
  proConvenienceDeps?: import('./pro-convenience-handler.js').ProConvenienceHandlerDeps;
  /** R27 delta-B — DDNS pause/resume handler deps (local publish flag +
   *  handle-state target + cloud-pause client). Absent → `ddns.*` returns
   *  `not_configured`. `ddns.` is in `MCP_RESERVED_RPC_PREFIXES`, so the
   *  namespace never bridges to MCP. */
  ddnsDeps?: import('./ddns-handler.js').DdnsHandlerDeps;
  /** D-178 — release update-check handler deps. Backs the owner-only,
   *  reserved-out-of-MCP `update.check` RPC (fetch + verify + locally
   *  resolve the signed release manifest). Absent → the method returns
   *  `not_configured`; wired-but-keyless (pre-GA) → `status: 'not-configured'`.
   *  `update.` is in `MCP_RESERVED_RPC_PREFIXES`. */
  updateDeps?: import('./update-handler.js').UpdateHandlerDeps;
  /** Realm-scoped recovery-key check store. When provided, the
   *  `pair.registerRecoveryKey` RPC is dispatched (first-call enroll
   *  + subsequent verify against the stored sealed sentinel). Without
   *  it, the rpc returns `not_configured` and pair flows can't
   *  cross-bind the account. */
  recoveryKeyCheck?: import('./recovery-key-store.js').RecoveryKeyCheckStore;
  /** Encryption handles for `pair.registerRecoveryKey`. Wired alongside
   *  `recoveryKeyCheck` so the WS enrollment door turns at-rest encryption
   *  on exactly as the HTTP `/auth/pair` twin does. Absent ⇒ sentinel-only
   *  enrollment, which is correct ONLY for db-less test compositions. */
  recoveryVaultDeps?: import('./recovery-key-processor.js').RecoveryVaultDeps;
  /** D-148 § A.2.1 — `ClientTokenStore` verify / touch slice for
   *  WS-handshake bearer-validation tightening. When provided AND the
   *  incoming bearer carries the structured `<token_id>.<bearer>`
   *  shape, the upgrade handler calls `verify(token_id, bearer)`. On
   *  success, the connected `WsClient.client_token_id` field is
   *  populated + `touch(token_id)` stamps `last_used_at`; on failure
   *  the upgrade is rejected with 401. Raw-bearer requests (no `.`
   *  separator) are rejected when this store is wired.
   *
   *  Absent → db-less harnesses retain the legacy raw-bearer accept-any
   *  path. */
  clientTokens?: Pick<
    import('./pairing/client-tokens.js').ClientTokenStore,
    'verify' | 'touch' | 'revoke' | 'list'
  >;
  /** Phase B pressure admin deps. When provided, the
   *  `server.runPressureReclaim` / `server.setPressureOverride`
   *  methods dispatch. Absent → those methods return
   *  `not_configured`. */
  pressureDeps?: PressureHandlerDeps;
  /** Phase C lifecycle handler slice. When provided, the three
   *  lifecycle rpc methods dispatch; the dispatcher also gates
   *  non-exempt methods during `booting` / `draining` via
   *  `lifecycleState`. Absent → lifecycle methods return
   *  `not_configured` and all rpc calls proceed without gating. */
  lifecycleHandlers?: import('@recued/contracts').AnyHandlerSlice<ServerRpcRegistry, WsClient>;
  /** Phase C lifecycle-state getter. When provided, the dispatcher
   *  rejects non-exempt rpc calls while the state is not `running`.
   *  See `LIFECYCLE_ALLOWED_METHODS` for the exemption set. */
  lifecycleState?: () => import('@recued/contracts').LifecycleState;
  /** Phase D collection rpc deps (D-106). When provided, the
   *  `collection.list` / `search` / `get` / `runRetention` /
   *  `listEndpoints` methods dispatch against the collection
   *  registry. Absent → those methods return `not_configured` and
   *  kernel ingredients (`email-list`, `file-list`, `webhook-list`,
   *  …) fail with `server_not_reachable` on the ext side. */
  collectionDeps?: CollectionHandlerDeps;
  /** D-120 Phase 7 — unified memory export rpc deps. Enables
   *  `audit.export.estimate` + `audit.export.page` — the export dialog
   *  on the extension's Memory tab (server scope). D-157 P0 deleted the
   *  legacy `audit.*` read-rpc family, so this is the whole `audit.*`
   *  rpc surface. */
  auditExportDeps?: AuditExportRpcDeps;
  /** Phase G triggers rpc deps (D-109). Enables `triggers.list` /
   *  `create` / `update` / `delete` — the Options → Recipes trigger
   *  attachment UI. */
  triggersDeps?: TriggersRpcDeps;
  /** "Watch this element" dom-watch affordance — `triggers.createElementWatch`
   *  rpc deps. Scaffolds + saves a local notify recipe from a (url, selector)
   *  target; the declarative reconciler materializes the watch trigger
   *  (DISARMED by default — D-179 P5c; the user arms it in #automation).
   *  Composed in `compose-listeners.ts` against `executeDeps.recipeStore`. */
  elementWatchDeps?: ElementWatchRpcDeps;
  /** Reactive-substrate slice 1 — `auto_run.list` / `auto_run.update`
   *  rpc deps. The per-recipe arm/disarm surface for auto-run recipes;
   *  composed in `compose-rpc-context.ts`. */
  autoRunDeps?: AutoRunRpcDeps;
  /** Poll-manager / G6 — `watch.list` / `watch.update` rpc deps. The
   *  watch-key governance surface (pause/resume connection-entity poll
   *  loops); composed in `compose-listeners.ts` alongside the
   *  event-trigger substrate. */
  watchDeps?: WatchRpcDeps;
  /** Phase G archive rpc deps (D-109). Enables `server.archive.*`
   *  methods — the Server → Config archive panel. */
  archiveDeps?: ArchiveRpcDeps;
  /** D-115 Phase 6D — `runtime.runWatcher` forwarder deps. When
   *  provided, the rpc dispatches into the watcher dispatcher; the
   *  extension's local watcher dispatcher rpcs `mail-watcher` /
   *  `file-watcher` / `calendar-watcher` / `webhook-watcher` here.
   *  Absent → the rpc returns `not_configured` and the ext kernel
   *  adapter surfaces it as `SERVER_NOT_REACHABLE` for those slugs. */
  watcherRpcDeps?: WatcherRpcDeps;
  /** D-116 Phase 3 — `runtime.testTrigger` rpc deps. Backs the
   *  Kitchen "Test trigger" forward for warehouse-routed watchers.
   *  Shares the same dispatcher binding as `runtime.runWatcher`. */
  triggerTestRpcDeps?: TriggerTestRpcDeps;
  /** D-119 Phase 5 — `recipe.list` rpc deps. The extension's server-
   *  scope sidebar fetches the paired server's installed-recipe roster
   *  through this rpc. Absent → returns `not_configured`; the sidebar
   *  shows an empty server-scope list with a recoverable error label. */
  recipeListDeps?: import('./recipe-list-handler.js').RecipeListHandlerDeps;
  /** D-201 Slice 5B1 — writable Kitchen recipe + webhook consumer authority. */
  recipeSaveDeps?: import('./recipe-save-handler.js').RecipeSaveHandlerDeps;
  /** R2 build step 4c.1 — `recipe.runnability` rpc deps. Backs the webclient
   *  recipes view's derived-runnability disclosure. Absent → `not_configured`
   *  (same posture as `recipe.list`). */
  recipeRunnabilityDeps?: import('./recipe-runnability-handler.js').RecipeRunnabilityHandlerDeps;
  /** D-119 Phase 10 — approval rpc deps. Wires `approval.list`,
   *  `approval.resolve`, `approval.subscribe`. The store is in-memory;
   *  bin.ts composes one shared instance + passes `pushToClient`
   *  bound to the WS send helper. Absent → those rpc methods return
   *  `not_configured`. */
  approvalDeps?: ApprovalHandlerDeps;
  /** D-119 Phase 13 — annotation + link warehouse rpc. Wires
   *  `annotation.write|list|search|delete|forRecord` and
   *  `link.write|list|delete|forRecord`. Absent → those methods
   *  return `not_configured`; the ext kernel ingredient surface
   *  yields `SERVER_NOT_REACHABLE`. */
  annotationDeps?: AnnotationRpcDeps;
  /** D-121 Phase 1 — contact warehouse rpc. Wires
   *  `contact.{upsert,list,get,delete}`. Absent → those methods
   *  return `not_configured`. */
  contactDeps?: ContactRpcDeps;
  /** D-138 Phase 1 — contact-merge rpc. Wires
   *  `contact.merge.{list,confirm,reject,split,undo_rejection,
   *  resolve_remerge_prompt}`. Local-UI only — registry excludes
   *  these from the MCP catalog. Absent → all six methods return
   *  `not_configured`. */
  contactMergeDeps?: ContactMergeRpcDeps;
  /** D-138 Phase 5 — upstream-merge outbox rpc. Wires
   *  `upstream_merge.{describe,request,retry,discard,list}`. Local-UI
   *  only — registry excludes these from the MCP catalog. Absent →
   *  all five methods return `not_configured`. */
  upstreamMergeDeps?: UpstreamMergeRpcDeps;
  /** D-125 Phase 2.1 — connection substrate rpc. Wires
   *  `collection.connection.{list,enroll,update,delete,probe}`.
   *  Absent → those methods return `not_configured` (e.g. when the
   *  server runs without a SQLite db). */
  connectionDeps?: ConnectionRpcDeps;
  /** D-201 Slice 1 — owner-only ingress metadata + credential rotation.
   * No public listener is mounted by this dependency. */
  webhookIngressDeps?: WebhookIngressRpcDeps;
  /** D-166 override-write path — `collection.contract.*` rpc deps. Wires
   *  `contract.{upsert,delete,list}Override` over the local `contract.*`
   *  store (the same handle the catalog gateway's override-tightening scan
   *  reads) + the catalog-form manifest lookup. Absent → those methods
   *  return `not_configured` (e.g. db-less harnesses or no catalog). */
  contractDeps?: ContractRpcDeps;
  /** D-182 §7.2 — `cli.reachability.*` grid rpc deps. Wires
   *  `cli.reachability.{list,set}` over the same local `contract.*` store the
   *  gateway's cli-reachability resolver reads, so a freshly-granted cell
   *  authorizes the next dispatch with no reseed. Owner-only
   *  (`cli.reachability.` in `MCP_RESERVED_RPC_PREFIXES`). Absent → those methods
   *  return `not_configured` (db-less harnesses). */
  cliReachabilityDeps?: CliReachabilityRpcDeps;
  /** Supervision feature — owner-only `supervision.*` rpc deps (cli-daemon
   *  keep-alive). `supervision.` is in `MCP_RESERVED_RPC_PREFIXES`. Absent →
   *  those methods return `not_configured` (db-less harnesses). */
  supervisionDeps?: import('./supervision-handler.js').SupervisionRpcDeps;
  /** D-152 — `collection.hostname.*` registry deps. Wires hostname
   *  CRUD + ownership-proof transitions over the same store the SNI
   *  binding lookup reads. Absent → those methods return
   *  `not_configured` (db-less harnesses or pre-D-152 boots). */
  hostnameDeps?: HostnameRpcDeps;
  /** LAN-URL kickstart — `network.local_urls` deps (the live listen port).
   *  Absent → the method returns `not_configured` (db-less harnesses). */
  networkDeps?: NetworkRpcDeps;
  /** D-139 P2 — Connection-page UX rpc deps (per-entity engagement
   *  health surface + Salesforce capability re-probe). Absent → both
   *  methods return `not_configured` (e.g. db-less harnesses or
   *  pre-D-139 boots). */
  engagementHealthDeps?: EngagementHealthDeps;
  /** D-122 Phase 4.5 — enrichment substrate rpc. Wires
   *  `enrichment.{upsert,list}`. Absent → those methods return
   *  `not_configured`; the kernel ingredient surface yields
   *  `SERVER_NOT_REACHABLE`. */
  enrichmentDeps?: EnrichmentRpcDeps;
  /** D-123 Phase 5 — housekeeping rpc. Wires
   *  `housekeeping.config.{read,write}`, `housekeeping.status.read`,
   *  `housekeeping.task.run_now`. Absent → those methods return
   *  `not_configured` (e.g. db-less harnesses or pre-P7 boots). */
  housekeepingDeps?: HousekeepingRpcDeps;
  /** D-163 Slice C — Settings → Notifications rpc. Wires
   *  `notifications.{describe,set_channel,set_verification_phrase}`
   *  against the `@recued/notification` block's settings surface.
   *  Absent → all three methods return `not_configured` (e.g. db-less
   *  harnesses, or a boot where the notification block's four
   *  prerequisites didn't resolve so the block never composed).
   *  Channel-isolation invariant — `notifications.` is in
   *  `MCP_RESERVED_RPC_PREFIXES` (D-138 ratchet asserts the prefix
   *  stays reserved), so MCP-channel agents cannot toggle the user's
   *  approval-bearing channels or overwrite the anti-phishing
   *  verification phrase. */
  notificationsDeps?: NotificationRpcDeps;
  /** D-145 PA10 follow-on — `packs.install` rpc. Wires the bulk-pack
   *  install transaction (recipes + body-content grants + pack-shipped
   *  Standing Instruction rows). Absent → `packs.install` returns
   *  `not_configured` (e.g. db-less harnesses or pre-D-103-Phase-A boots
   *  whose `RecipeStore` hasn't composed yet). Channel-isolation
   *  invariant — `packs.` is in `MCP_RESERVED_RPC_PREFIXES`; a pack
   *  install commits recipes + body grants + per-pair SI rules in one
   *  atomic step, so the reserved prefix keeps MCP-channel agents off
   *  the writer entirely. */
  packInstallDeps?: PackInstallRpcDeps;
  /** D-145 PA10 follow-on — `packs.list` rpc. Read counterpart to
   *  `packs.install`; reads bundled pack manifests off disk + joins
   *  with the per-pair `RecipeStore` to compute each pack's
   *  `installed` flag. Absent → `packs.list` returns `not_configured`
   *  (same db-less / pre-D-103-Phase-A reasoning as `packInstallDeps`).
   *  Same `packs.` reserved-prefix gate (read-only enumeration is
   *  low-risk, but the uniform private-prefix discipline keeps the
   *  `packs.*` surface a Settings-UI-only namespace). */
  packListDeps?: PackListRpcDeps;
  /** D-145 PA10 follow-on Slice B — `packs.uninstall` rpc. Reverses
   *  the install transaction: drops every `source = 'pack_installed'`
   *  SI row whose id begins with `<pack_slug>:`, then deletes each
   *  recipe in the bundled manifest from the per-pair `RecipeStore`.
   *  Absent → `packs.uninstall` returns `not_configured` (same db-less
   *  / pre-D-103-Phase-A reasoning as `packInstallDeps`). Same
   *  `packs.` reserved-prefix gate. */
  packUninstallDeps?: PackUninstallRpcDeps;
  /** D-170 — `ingredient.install` / `ingredient.uninstall` rpc deps. The
   *  direct-manifest install path: validate (decompose + reuse the D-165
   *  validators) → persist decomposed bodies to the local manifest store +
   *  record inventory in the SAME `contract.*` store the gateway resolves
   *  through → register the catalog for live resolution (N.16). Uninstall is
   *  refcount-aware with an `ingredient_pins` dependency guard (N.14). Absent
   *  (db-less / no contract store) → both methods return `not_configured`.
   *  Channel-isolation: `ingredient.` is in `MCP_RESERVED_RPC_PREFIXES`. */
  ingredientAuthoringDeps?: IngredientAuthoringRpcDeps;
  /** D-170 N.4 / N.15 / #2 — `ingredient.draft.{save,list,get,delete}`,
   *  `ingredient.preview`, and `ingredient.compose.decompose` rpc deps. The
   *  draft store backs the draft and decompose methods; `connectionLookup` +
   *  `previewExecute` (the real connection adapter, no audit) drive the
   *  test-before-save read execution. Absent (or absent `draftStore`) → the
   *  slice is un-wired. Channel-isolation: `ingredient.` is in
   *  `MCP_RESERVED_RPC_PREFIXES`. */
  ingredientDraftDeps?: IngredientDraftRpcDeps;
  /** D-169 P0 — `bridge.capabilityProfile.push` rpc deps. Wires the
   *  per-pair `BridgeRegistry` instance that Slice 4's multi-bridge
   *  dispatcher pre-filters against. Absent → the rpc returns
   *  `not_configured` (test compositions that don't exercise the bridge
   *  registry; pre-D-169 boots before bin.ts threads the registry
   *  through). Channel-isolation invariant — `bridge.` is in
   *  `MCP_RESERVED_RPC_PREFIXES` (D-138 ratchet test asserts the prefix
   *  stays reserved), so MCP-channel agents cannot drive this surface. */
  bridgeCapabilityDeps?: BridgeCapabilityHandlerDeps;
  /** D-169 P1 — `system.status` rpc deps. Wires the rich server-status
   *  snapshot the bridge side-panel reads on mount + each periodic
   *  refresh (N.5 #1). Absent → the rpc surface isn't wired (callers
   *  surface `not_configured`). Channel-isolation invariant — `system.`
   *  is in `MCP_RESERVED_RPC_PREFIXES` so MCP-channel agents cannot
   *  enumerate host telemetry (paired client count discloses
   *  device-fleet topology). */
  systemStatusDeps?: SystemStatusDeps;
  /** D-169 P2 — historical-view rpc deps (`execution.recent` /
   *  `notification.recent` / `notification.pending_asks`) the bridge side
   *  panel reads on mount + reconnect. Absent → the slice is dropped (the
   *  rpcs surface `not_configured`). Channel-isolation: these methods are
   *  omitted from `MCP_TOOL_CATALOG`, same posture as `system.status`. */
  historyDeps?: HistoryDeps;
  /** D-174 Runs/Audit rpc deps (`execution.list` / `execution.get`) for
   *  the webclient Runs route. Absent → the slice is dropped. Local-UI /
   *  paired-client only by registered-client gate + MCP catalog omission. */
  executionFeedDeps?: ExecutionFeedRpcDeps;
  /** D-169 P0 follow-on — the WS upgrade calls `bridgeRegistry.attach()`
   *  when a bearer-verified client's `client_kind === 'bridge'`, so the
   *  subsequent `bridge.capabilityProfile.push` rpc lands via
   *  `updateCapabilities` instead of the no-op pre-attach branch (Codex
   *  2026-05-28 Angle 1 fold). Detach piggybacks on the ws `close` /
   *  `error` events. Absent → the upgrade skips the attach call (test
   *  compositions that don't exercise the bridge registry; pre-wiring
   *  boots that haven't composed the registry yet). Production threads
   *  the same instance into `bridgeCapabilityDeps.registry` so attach
   *  + push share one map. */
  bridgeRegistry?: BridgeRegistry;
  /** D-169 P0 follow-on — optional audit log for the multi-bridge
   *  `BridgeDispatcher` composed inside ws-server when `bridgeRegistry`
   *  is wired. Drives two roles (per `DispatcherOptions.auditLog` in
   *  `bridges/dispatcher.ts`): per-bridge `lastSuccessfulBridgeDispatch`
   *  reads inform `orderForDispatch`'s iteration order; success records
   *  emit a `'bridge_dispatch_succeeded'` activity row so the *next*
   *  dispatch sees the prior success. Absent → iteration order falls
   *  back to WS-attachment recency alone (acceptable for tests +
   *  pre-wired boots). Mirrors `pairRevokeAuditLog`'s opt-in pattern —
   *  the ws layer doesn't require the log to function, but a wired log
   *  makes the dispatcher smarter. */
  bridgeDispatcherAuditLog?: AuditLogStore;
  /** D-136 §A.13.5 P7.G — MCP visibility user-override rpc deps.
   *  Wires `mcp.visibility.{read,write}` so the Settings UI capstone
   *  can persist per-topic privacy toggles. Absent → those methods
   *  return `not_configured` (e.g. db-less harnesses). */
  mcpVisibilityDeps?: MCPVisibilityRpcDeps;
  /** Grant-foundation slice 3 — `contract.grant.{read,read_by_entry,write}` rpc
   *  deps. Wires the unified (contract × grant) matrix CRUD against the shared
   *  contract store. Absent → those methods unregistered (db-less harnesses). */
  contractGrantDeps?: ContractGrantRpcDeps;
  /** D-148 W3.FU — Per-path Exposure state mutators rpc deps. Wires
   *  `exposure.{apply_preset,set_path_resolution,
   *  set_public_mcp_acknowledgement}` against the in-process
   *  `ExposureStateMachine` composed at boot. Absent → those methods
   *  return `not_configured` (e.g. db-less harnesses or pre-W3.5
   *  boots). */
  exposureDeps?: ExposureRpcDeps;
  /** D-148 follow-up #4 — `tls_domain.{upload,remove,list}` rpc deps.
   *  Wires the W3.6 `SqliteTlsDomainStore` for the
   *  Settings → Server → TLS Certificates page. Absent → those methods
   *  return `not_configured` (e.g. db-less harnesses or pre-W3.6
   *  boots that haven't composed the store yet). */
  tlsDomainDeps?: TlsDomainRpcDeps;
  /** D-148 follow-up #5 — `pro_acme.unbind` rpc deps. Wires the
   *  `proAcmeUnbind` substrate (W3.6 store + DDNS release adapter +
   *  signed audit sink). Absent → the method returns `not_configured`
   *  (e.g. db-less harnesses + pre-W3.6 boots + production boots whose
   *  cloud `DdnsHandleControl` adapter hasn't landed yet). */
  proAcmeDeps?: ProAcmeRpcDeps;
  /** D-148 § A.4.4 — `token.rotate` rpc deps. Wires the
   *  `createTokenRotationEmitter` orchestrator (production
   *  `ClientTokenStore` from `pairing/client-tokens.ts` + the D-121
   *  `EventBus`). Absent → `token.rotate` returns `not_configured`
   *  (e.g. db-less harnesses, or pre-D-148 § A.4.4 boots that don't
   *  yet compose the emitter). Channel-isolation invariant — `token.`
   *  is in `MCP_RESERVED_RPC_PREFIXES` (D-138 ratchet test asserts the
   *  prefix stays reserved), so MCP-channel agents cannot drive
   *  credential rotation. */
  tokenRotationDeps?: TokenRotationRpcDeps;
  /** D-148 § A.6.5 — `tls.renew` rpc deps. Wires the shared
   *  `RotationEngine` composed in bin.ts (cert-rotation broadcaster +
   *  signing identity + audit sink). Absent → `tls.renew` returns
   *  `not_configured` (e.g. db-less harnesses, or boots where
   *  `db && auditLog` doesn't hold so the engine never composes).
   *  Channel-isolation invariant — `tls.` is in
   *  `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel agents cannot
   *  drive TLS cert rotation. */
  tlsRenewDeps?: TlsRenewRpcDeps;
  /** D-148 § A.6.5 + § A.9 — `passport.fetch` rpc deps. Wires the
   *  webclient post-WS-connect verify path against the passport
   *  block-providers + `server_identity_key` keypair. Absent →
   *  `passport.fetch` returns `not_configured` (db-less harness, or a
   *  boot where the production passport-block-provider substrate
   *  hasn't been composed yet — separate from the `tls.renew` engine
   *  composition above). Channel-isolation invariant — `passport.` is
   *  in `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel agents cannot
   *  fetch the passport projection. */
  passportFetchDeps?: PassportFetchRpcDeps;
  /** R26.4 Delta 2 — `passport.export` + `passport.history.list` deps.
   *  Absent → both return `not_configured` (db-less / no-audit boot). */
  passportUserRpcDeps?: PassportUserRpcDeps;
  /** R26.4 Delta 3 — `key.rotate` + `key.health` deps (same
   *  `RotationEngine` as `tls.renew` + the compromise-ledger health
   *  view). Absent → both return `not_configured` (db-less / no-engine
   *  boot). `key.` is in `MCP_RESERVED_RPC_PREFIXES`. */
  keyRotateDeps?: KeyRotationRpcDeps;
  // D-156 P9 retired `pairMintDeps` + `pairConsumeDeps` — the
  // pair-blob substrate is gone; CLI `recued-server pair` is the sole
  // pair path.
  /** D-148 § A.5.3 / § A.6.5 — `pro.*` rpc deps. Wires the per-pair
   *  `ProAuthStateMachine` composed in bin.ts (SQLite-backed store +
   *  `onStateChanged` listener that flips the ACME factory's
   *  `ProAuthResolver` ref). Absent → `pro.authenticate` /
   *  `pro.signOut` / `pro.current` all return `not_configured`
   *  (db-less harness). Channel-isolation invariant — `pro.` is in
   *  `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel agents cannot
   *  mutate or read subscription bearer state. */
  proAuthDeps?: ProAuthRpcDeps;
  /** D-149 P3 § A.3 — Public Reception registry rpc deps. Wires the
   *  ten `reception.*` admin-only methods. Absent → those methods
   *  return `not_configured` (e.g. db-less harnesses + pre-D-149 boots
   *  whose pepper / preview-hash store haven't been composed yet).
   *  Per § Must Hold I-3 the namespace is in `MCP_RESERVED_RPC_PREFIXES`. */
  receptionDeps?: ReceptionRpcDeps;
  /** D-173 N.2 — Reception Inbox rpc deps. Wires the three admin-only
   *  `reception.inbox.{list,approve,reject}` methods (the review-then-
   *  approve inbox over held `approval_required` ops). `approve` is the
   *  SOLE writer of `checkpoint.arg_overrides` (the N.5 boundary). Absent →
   *  those methods return `not_configured`. Per Must Hold I-3 the
   *  `reception.` namespace is in `MCP_RESERVED_RPC_PREFIXES`. */
  receptionInboxDeps?: ReceptionInboxDeps;
  /** D-210 step 2a — `reception.record.list`. Absent ⇒ the method is not registered (a
   *  db-less boot has no records to be honest about). */
  receptionRecordDeps?: ReceptionRecordDeps;
  /** D-210 Appendix B — `reception.manage.mint` (on-the-go reschedule link).
   *  Absent ⇒ the method is not registered (no credential store / booking store /
   *  link walk wired). */
  receptionManageMintDeps?: ReceptionManageMintDeps;
  /** D-240 § D11 — per-record viewback revoke. Absent ⇒ the method is simply not
   *  registered (db-less boot), same posture as its neighbours. */
  receptionLookupRevokeDeps?: ReceptionLookupRevokeDeps;
  /** D-145 PA11 — Settings → Work Entities Source management rpc.
   *  Wires `work_entity.source.{list,set_enabled,
   *  set_default,clear_default}` so the panel can render + persist
   *  per-Source toggles + per-kind defaults. Absent → those methods
   *  return `not_configured` (e.g. db-less harnesses). */
  workEntitySourceDeps?: WorkEntitySourceRpcDeps;
  /** D-205 #2c — `contact.source.list`: per-Source contact sync health (the
   *  Sources strip on `#data/contact`). Absent → the method returns
   *  `not_configured` and the strip does not render. */
  contactSourceDeps?: ContactSourceRpcDeps;
  /** D-205 #5 — `contact.import.{candidates,promote}`: selective CRM promotion (the
   *  cold-start escape hatch — a CRM is `hydrate_on_match`, so on an empty graph it
   *  mints ZERO contacts and `#data/contact` stays empty). Absent → the methods
   *  return `not_configured` and the picker does not render. */
  contactImportDeps?: ContactImportRpcDeps;
  /** D-174 #22 — work-entity warehouse CRUD rpc. Wires
   *  `work_entity.{list,get,upsert,delete}` over the four own-it kinds
   *  for the webclient Data route. Reads through the resolver; writes
   *  route through the event-emitting dispatchers. Absent → those
   *  methods return `not_configured` (db-less harness or pre-warehouse
   *  boot). Local-UI only — mirrors `contact.*`'s channel treatment. */
  workEntityCrudDeps?: WorkEntityCrudRpcDeps;
  /** Accepted Reception form responses for the owner Data browser. Summary
   *  list + full detail; the handler requires a registered paired client. */
  formResponseDeps?: FormResponseRpcDeps;
  /** D-221 owner-only `records.*` explorer/lifecycle control plane. */
  recordsRpcDeps?: RecordsRpcDeps;
  /** D-174 #22 — `data.timeline` read pair-RPC. Wraps the shared
   *  `handleTimelineRequest` query (third channel alongside MCP +
   *  recipe). Absent → returns `not_configured` (db-less harness or a
   *  boot missing db/auditLog/annotationStore). Read-only; paired-client
   *  reads see private rows (no MCP privacy gate). */
  timelineRpcDeps?: TimelineRpcDeps;
  /** D-198 Slice 1 — `memory.list` owner-trusted read pair-RPC deps (the
   *  Memory lens feed). Absent → `not_configured` (db-less harness or a boot
   *  missing `auditLog`). Read-only; registered-client boundary, no contract
   *  gate (mirrors `timelineRpcDeps`). */
  memoryRpcDeps?: MemoryRpcDeps;
  /** D-172 Half-A "open" — `data.file.read` owner read pair-RPC (Files tab
   *  open/download). Absent → `not_configured` (dbless / no CAS blob store).
   *  Owner-trusted: a registered-paired-client boundary in the handler, no
   *  contract/egress gate (that gate is only the AI/recipe channels). */
  fileReadRpcDeps?: FileReadRpcDeps;
  /** D-139 P5 — `data.contact.engagements.list` resolver pair-RPC.
   *  Absent → returns `not_configured` (boot missing engagement /
   *  contact stores). Full-shape read (body included); registered-client
   *  gated, no MCP privacy gate. */
  contactEngagementsRpcDeps?: ContactEngagementsResolveDeps;
  /** D-145 PB12 — Peer-Recued Preview consumer rpc. Wires
   *  `s2s_preview.{build,consume}` against the substrate
   *  `buildRedactedPacket` + the SQLite token store. Absent → those
   *  methods return `not_configured` (e.g. db-less harnesses). */
  s2sPreviewDeps?: S2SPreviewRpcDeps;
  /** D-122 Phase 4.5 — generic notification dispatcher. Per-channel
   *  dispatchers come from the broadcast bus / remote-trigger config
   *  layer; absent → `notification.send` reports every channel as
   *  failed but the rpc itself stays `200 OK`. */
  notificationDeps?: NotificationDeps;
  /** D-122 Phase 4.5 — `mail.get` rpc. Closes over the
   *  CollectionRegistry. Absent → method returns `not_configured`. */
  mailGetDeps?: MailGetDeps;
  /** D-121 Phase 6 — realtime broadcast bus deps. When provided the
   *  `events.subscribe` rpc dispatches against the shared bus + the
   *  ws-server tears down the per-client subscription on disconnect.
   *  Absent → events.subscribe returns `not_configured`; emit sites
   *  call no-op (bin.ts wires this only when the bus is composed). */
  eventsDeps?: Pick<EventsHandlerDeps, 'bus'>;
  /** D-127 wire-up — `server.getOAuthClientConfig` deps. Returns the
   *  per-provider public client_id this server is configured with so
   *  the extension can construct authorize URLs. Absent → the rpc
   *  returns `not_configured`. */
  oauthClientConfigDeps?: OAuthClientConfigDeps;
  /** BYO OAuth app config rpc deps (get/set/clear). Absent → that rpc
   *  slice 404s; the env-var path still works. */
  oauthAppConfigDeps?: OAuthAppConfigHandlerDeps;
  /** D-137 P1.2 — AI Chat rpc deps (Wire A). Wires the ten
   *  `chat.*` methods + the server-side orchestrator's per-turn
   *  broadcast emission. Absent → those methods return
   *  `not_configured` (e.g. db-less harnesses or pre-D-137 boots).
   *  Per § Wire A — the orchestrator runs in-process here; the
   *  webclient is display + HID. */
  chatDeps?: ChatRpcDeps;
  /** D-172 resumable uploads — webclient upload service. When provided, the
   *  `upload.{create,probe,finalize,delete}` rpc methods dispatch AND the
   *  dedicated binary `/ws/upload` socket accepts chunk frames into the service.
   *  Absent → those rpc methods return `not_configured` and `/ws/upload`
   *  upgrades are rejected (db-less / no-CAS harness). Owner-only; `upload.` is
   *  in `MCP_RESERVED_RPC_PREFIXES`, so the namespace never bridges to MCP. */
  uploadDeps?: UploadHandlerDeps;
  /** M4 archive download — webclient download service. When provided, the
   *  dedicated binary `/ws/download` socket streams a finished export file
   *  (confined to a generated name under `exports/`) to the client with
   *  backpressure. Absent → `/ws/download` upgrades 503-close (db-less /
   *  pre-archive boot). Owner-facing like the archive rpc; no MCP surface. */
  downloadDeps?: DownloadHandlerDeps;
  /** M4b.1 archive upload (no-SSH migrate) — archive upload service. When
   *  provided, the `server.archive.upload.{create,probe,finalize,delete}` rpc
   *  methods dispatch AND the dedicated binary `/ws/archive-upload` socket
   *  accepts chunk frames into the service (finalize STAGES the assembled
   *  archive under `exports/` for `server.archive.import`). Absent → those rpc
   *  methods return `not_configured` and `/ws/archive-upload` upgrades 503-close
   *  (db-less / pre-archive boot). Owner-facing like the archive rpc; no MCP. */
  archiveUploadDeps?: ArchiveUploadHandlerDeps;
}

/** D-148 W3.5b — `createWebSocketUpgrade` returns the WS upgrade
 *  callback alongside the dispatcher handle, so the production
 *  path-listener-set can wire the same upgrade into BOTH the LAN + public
 *  listeners' `'upgrade'` events (via the path-router's `ws` role upgrade
 *  slot). The legacy `attachWebSocket(httpServer, options)` wrapper keeps
 *  the single-listener behaviour tests rely on by binding the returned
 *  upgrade to one http server. */
export interface WebSocketUpgradeBinding {
  /** The dispatcher handle — same surface as the legacy `WsServerHandle`. */
  handle: WsServerHandle;
  /** Upgrade callback. Wire onto each listener's `'upgrade'` event
   *  (path-router auto-wires this for the `ws` role). */
  upgrade: PortUpgradeHandler;
}

export const createWebSocketUpgrade = (
  options: AttachWebSocketOptions = {},
): WebSocketUpgradeBinding => {
  // Internal helper: build the dispatcher + upgrade callback against a
  // synthetic "request emitter" so the same logic works whether wired
  // onto a single http server (legacy) or fanned across two listeners
  // (W3.5b path-routed flow). The captured `httpServer` slot is null
  // for the new flow — the upgrade callback delivers raw sockets via
  // the path-router instead of an `httpServer.on('upgrade', ...)` bind.
  return buildWsBinding(options, null);
};

/** Attach a WebSocket server to an existing HTTP server.
 *  Handles upgrade requests on the /ws path. */
export const attachWebSocket = (
  httpServer: Server,
  options: AttachWebSocketOptions = {},
): WsServerHandle => {
  const binding = buildWsBinding(options, httpServer);
  return binding.handle;
};

/** D-196 Rev 16 Rule 7 — Seller readiness must resolve the currently registered
 *  mail collection, not trust a stored instance id or a stale enrollment row.
 *  Keep `sendCapable` and the executable `send` method in lockstep so a malformed
 *  collection cannot make Settings report outbound mail as ready. */
export const isLiveSendCapableMailInstance = (
  registry: Pick<CollectionHandlerDeps['registry'], 'get'>,
  instanceId: string,
): boolean => {
  const collection = registry.get('mail', instanceId);
  return collection !== undefined
    && 'sendCapable' in collection
    && collection.sendCapable === true
    && 'send' in collection
    && typeof collection.send === 'function';
};

const buildWsBinding = (
  options: AttachWebSocketOptions,
  httpServer: Server | null,
): WebSocketUpgradeBinding => {
  const {
    executeDeps, scheduleDeps, dishDeps, cacheDeps, sharedDeps, authDeps, migrateDeps,
    llmConfigManager, runtimeConfig, sellerStore, sellerOrderStore, sellerContractStore, sellerInboundTokenStore,
    sellerClaimStore,
    bootstrapDeps,
    serverId, pairedInstances, pairRevokeAuditLog, accountBindingDeps, proConvenienceDeps, ddnsDeps, updateDeps, recoveryKeyCheck, recoveryVaultDeps, clientTokens, pressureDeps,
    lifecycleHandlers, lifecycleState, collectionDeps,
    auditExportDeps, triggersDeps, elementWatchDeps, autoRunDeps, watchDeps, archiveDeps,
    watcherRpcDeps, triggerTestRpcDeps,
    recipeListDeps, recipeSaveDeps, recipeRunnabilityDeps, approvalDeps, annotationDeps, contactDeps, contactMergeDeps,
    upstreamMergeDeps,
    connectionDeps,
    webhookIngressDeps,
    contractDeps,
    cliReachabilityDeps,
    supervisionDeps,
    hostnameDeps,
    networkDeps,
    engagementHealthDeps,
    enrichmentDeps, notificationDeps, mailGetDeps,
    housekeepingDeps,
    notificationsDeps,
    systemStatusDeps,
    historyDeps,
    executionFeedDeps,
    packInstallDeps,
    packListDeps,
    packUninstallDeps,
    ingredientAuthoringDeps,
    ingredientDraftDeps,
    bridgeCapabilityDeps,
    bridgeRegistry,
    bridgeDispatcherAuditLog,
    mcpVisibilityDeps,
    contractGrantDeps,
    exposureDeps,
    tlsDomainDeps,
    proAcmeDeps,
    tokenRotationDeps,
    tlsRenewDeps,
    passportFetchDeps,
    passportUserRpcDeps,
    keyRotateDeps,
    proAuthDeps,
    receptionDeps,
    receptionInboxDeps,
    receptionRecordDeps,
    receptionManageMintDeps,
    receptionLookupRevokeDeps,
    workEntitySourceDeps,
    contactSourceDeps,
    contactImportDeps,
    workEntityCrudDeps,
    formResponseDeps,
    recordsRpcDeps,
    timelineRpcDeps,
    memoryRpcDeps,
    fileReadRpcDeps,
    contactEngagementsRpcDeps,
    s2sPreviewDeps,
    eventsDeps, oauthClientConfigDeps, oauthAppConfigDeps,
    chatDeps,
    uploadDeps,
    downloadDeps,
    archiveUploadDeps,
  } = options;
  // Latest `user_id` reported by any registered client — used as `uid`
  // on the server-heartbeat payload. First client to register with a
  // non-empty user_id wins; subsequent exts' user_id should match (all
  // paired devices share one account) but we don't currently enforce —
  // mismatches are a register-time reject path (future work).
  let pairedUserId: string | undefined;
  let ws: any;
  try {
    ws = require('ws');
  } catch {
    // `ws` package missing — surface a stub handle. The path-router /
    // legacy server.on('upgrade') wiring rejects upgrades because the
    // upgrade callback is a no-op (closes the socket immediately).
    return {
      handle: {
        clientCount: () => 0,
        listConnectedInstances: () => [],
        listConnectedPairedInstances: () => [],
        getPairedUserId: () => undefined,
        maxInstances: 1,
        delegateAi: () => Promise.reject(new Error('ws package not installed')),
        delegateChat: () => Promise.reject(new Error('ws package not installed')),
        listExtensionIngredients: () => Promise.resolve(null),
        runKernelRecipeOnExtension: () => Promise.reject(new Error('ws package not installed')),
        peerCacheGet: () => Promise.resolve(null),
        peerCachePut: () => {},
        broadcastServerHeartbeat: () => {},
        revokeConnectedInstance: () => ({ revoked: false }),
        revokeAllConnectedInstances: () => 0,
        closeAllForWsLockout: () => 0,
        close: () => Promise.resolve(),
      },
      upgrade: (_req, socket) => { try { socket.destroy(); } catch { /* socket already closed */ } },
    };
  }

  // Resolve the prefs view for a specific connected client. Reads
  // the paired-instances row on every call so the cache-rpc gate
  // picks up `prefs.set` writes without caching. Unknown or missing
  // instance_id → undefined (registry defaults apply).
  const peerPrefsFor = (client: WsClient): ReturnType<typeof loadPrefsOrUndefined> => {
    if (!pairedInstances || !client.instance_id) return undefined;
    return loadPrefsOrUndefined(pairedInstances, client.instance_id);
  };

  // ────────────────────────────────────────────────────────────────
  // RPC dispatch — typed handler registry keyed by the shared
  // `ServerRpcRegistry` from contracts. Each namespace lives in its
  // own `make*Handlers(deps)` factory under its `*-handler.ts` file;
  // `composeHandlers` merges the slices + returns a `wiredMethods`
  // set for boot-time validation. A slice whose deps are unwired
  // returns `undefined` and drops silently — `not_configured` (501)
  // then falls out of the dispatcher's sparse-map lookup. Migration
  // gate + auto-lock activity tracking stay on the dispatcher.
  // ────────────────────────────────────────────────────────────────

  // Forward-declared so `makePairHandlers` can close over it. The
  // handle is assigned at the bottom of this function, after the
  // dispatcher is built — pair handlers only run after a registered
  // client sends the rpc, by which point the assignment has landed.
  let handle: WsServerHandle;

  // D-181 slice 4 — the owner-only live-control surface over the in-flight
  // registry (the SAME instance `executeDeps` feeds). The bridge-approval gate
  // resolves a bridge's `approval` mode from the notification block's roster
  // (absent block ⇒ a bridge caller is denied control, fail-closed). Unwired
  // registry (no executeDeps / dbless) ⇒ the slice drops to `not_configured`.
  const executionControlDeps = executeDeps?.inFlightRegistry
    ? {
        registry: executeDeps.inFlightRegistry,
        ...(notificationsDeps?.block
          ? {
              bridgeApprovalLookup: async (clientTokenId: string): Promise<boolean> => {
                const rows = await notificationsDeps.block.describeNotificationBridges();
                return rows.find((r) => r.client_token_id === clientTokenId)?.modes.approval === true;
              },
            }
          : {}),
      }
    : undefined;

  // D-156 follow-on — `pair.list_changed` roster fan-out for the pair
  // handler's revoke path. Captured here so the closure passed to
  // `makePairHandlers` closes over a definitely-typed bus (db-less / no-bus →
  // undefined → the handler skips the emit). The bus stamps the cursor.
  // Mirrors the contract-handler `broadcast` discipline.
  const pairRosterBus = eventsDeps?.bus;
  const stripeEntitlementProvider = executeDeps
    ? createSellerStripeEntitlementProvider(executeDeps)
    : undefined;
  const { handlers, wiredMethods } = composeHandlers<ServerRpcRegistry, WsClient>([
    makeExecuteHandlers(executeDeps),
    makeExecutionControlHandlers(executionControlDeps),
    // D-172 resumable uploads — the owner-only webclient upload control plane
    // (create / probe / finalize / delete). The chunk BYTES ride the dedicated
    // binary `/ws/upload` socket below, NOT these rpc methods. Unwired
    // (`uploadDeps` absent on a db-less / no-CAS boot) ⇒ drops to
    // `not_configured`. `upload.` is reserved out of MCP.
    makeUploadHandlers(uploadDeps),
    // M4b.1 — the owner-only archive-upload control plane (create / probe /
    // finalize / delete). The chunk BYTES ride the dedicated binary
    // `/ws/archive-upload` socket below, NOT these rpc methods. Unwired
    // (`archiveUploadDeps` absent on a db-less / pre-archive boot) ⇒ drops to
    // `not_configured`. Off MCP by catalog omission (like the sibling archive rpc).
    makeArchiveUploadHandlers(archiveUploadDeps),
    makeScheduleHandlers(scheduleDeps),
    makeDishHandlers(dishDeps),
    makeCacheHandlers(cacheDeps, peerPrefsFor),
    makeSharedHandlers(sharedDeps),
    makePrefsHandlers(pairedInstances),
    makeAuthHandlers(authDeps),
    makeMigrateHandlers(migrateDeps),
    makePairHandlers(
      pairedInstances,
      () => handle,
      pairRevokeAuditLog,
      clientTokens,
      pairRosterBus ? (event) => pairRosterBus.emit(event) : undefined,
    ),
    // D-175 P5 — recued.com account binding pair-RPC. Receives the
    // relayed binding token, exchanges it with the auth Worker, and
    // stores the server-scoped credential as identity-root material
    // (conflict-gated, audited). Reserved local-UI only — `account.` is
    // in `MCP_RESERVED_RPC_PREFIXES`, so a compromised MCP-channel agent
    // can never relay a token, tear down a binding, or read ownership.
    makeAccountBindingHandlers(accountBindingDeps),
    makeProConvenienceHandlers(proConvenienceDeps),
    makeDdnsHandlers(ddnsDeps),
    makeSupervisionHandlers(supervisionDeps),
    makeUpdateHandlers(updateDeps),
    makeRecoveryHandlers(recoveryKeyCheck, recoveryVaultDeps),
    makeConfigHandlers(llmConfigManager, runtimeConfig),
    makeSellerOverviewHandlers(sellerStore ? {
      sellerStore,
      ...(sellerOrderStore ? { sellerOrderStore } : {}),
      ...(sellerContractStore ? { contractStore: sellerContractStore } : {}),
      ...(sellerInboundTokenStore ? { inboundTokenStore: sellerInboundTokenStore } : {}),
      ...(sellerClaimStore ? { sellerClaimStore } : {}),
      ...(stripeEntitlementProvider && sellerContractStore
        ? { stripeEntitlementProvider }
        : {}),
      ...(receptionDeps ? { getPublicBaseUrl: receptionDeps.getShareBaseUrl } : {}),
      ...(llmConfigManager ? { llmManager: llmConfigManager } : {}),
      ...(collectionDeps
        ? {
            isLiveSendCapableMailInstance: (instanceId: string): boolean =>
              isLiveSendCapableMailInstance(collectionDeps.registry, instanceId),
            sendClaimMail: async (input: {
              readonly instance_id: string;
              readonly to: string;
              readonly subject: string;
              readonly body_text: string;
            }) => handleCollectionMailSend(collectionDeps, {
              instance: input.instance_id,
              to: [input.to],
              subject: input.subject,
              body_text: input.body_text,
            }),
          }
        : {}),
      mintedBy: serverId ? `server:${serverId}:seller` : 'server:seller',
    } : undefined),
    makeBootstrapHandlers(bootstrapDeps),
    // D-127 wire-up — `server.getOAuthClientConfig` exposes the
    // public client_id per provider so the extension can build the
    // authorize URL the OAuth popup opens. Secrets stay server-side.
    makeOAuthClientConfigHandlers(oauthClientConfigDeps),
    // BYO OAuth app credentials — owner-entered client_id + client_secret
    // (encrypted), env vars as fallback. Absent deps → slice unwired.
    makeOAuthAppConfigHandlers(oauthAppConfigDeps),
    makePressureHandlers(pressureDeps),
    // Phase C — lifecycle rpc slice (server.requestShutdown,
    // getLifecycleState, resetCrashLoop). `server.requestRestart`
    // stays in makeBootstrapHandlers and delegates via bootstrap-
    // handler.onRestartRequested to the same lifecycle surface.
    lifecycleHandlers,
    // Phase D — collection rpc slice (collection.list / search /
    // get / runRetention / listEndpoints). Ingredients lookup
    // `data.{mail,file,webhook}.*` through these.
    makeCollectionHandlers(collectionDeps),
    // D-120 Phase 7 — unified memory export rpc pair (estimate + page).
    // Needs the SQLite handle for the `links` + `recipe_insights`
    // joins. D-157 P0 deleted the legacy `audit.*` read-rpc family;
    // this pair is the whole `audit.*` rpc surface.
    makeAuditExportHandlers(auditExportDeps),
    // Phase G (D-109) — trigger CRUD (Options → Recipes triggers).
    makeTriggersHandlers(triggersDeps),
    // "Watch this element" — `triggers.createElementWatch` scaffolds a local
    // notify recipe from a (url, selector) target; the reconciler materializes
    // the watch trigger (disarmed by default — the user arms it in
    // #automation). Owner-only via the `triggers.` MCP-reserved prefix.
    makeElementWatchHandlers(elementWatchDeps),
    // Reactive-substrate slice 1 — auto-run arm/disarm.
    makeAutoRunHandlers(autoRunDeps),
    // Poll-manager / G6 — watch pause/resume + topology list.
    makeWatchHandlers(watchDeps),
    // Phase G (D-109) — archive export/import rpc (Config → Archive).
    makeArchiveHandlers(archiveDeps).slice,
    // D-115 Phase 6D — `runtime.runWatcher` pair-rpc forwarder for
    // the extension's watcher dispatcher.
    makeWatcherRpcHandlers(watcherRpcDeps),
    // D-116 Phase 3 — `runtime.testTrigger` pair-rpc forwarder for
    // Kitchen's warehouse-routed trigger-test flow.
    makeTriggerTestRpcHandlers(triggerTestRpcDeps),
    // D-119 Phase 5 — `recipe.list` for the server-scope sidebar.
    makeRecipeListHandlers(recipeListDeps),
    // R2 build step 4c.1 — `recipe.runnability` derived-runnability read surface.
    makeRecipeRunnabilityHandlers(recipeRunnabilityDeps),
    // § 7 surfacing slice — `recipe.pii` per-recipe posture read surface.
    // Rides the recipe-list deps (it only needs the store).
    makeRecipePiiHandlers(recipeListDeps),
    // Recipe-editor authoring seam — `recipe.save` + `recipe.validate`.
    // Rides the recipe-list deps too (it only needs the writable store —
    // `recipeListDeps.store` is the full `recipeStore`).
    makeRecipeSaveHandlers(recipeSaveDeps ?? recipeListDeps),
    // D-119 Phase 10 — approval cross-device sync.
    makeApprovalHandlers(approvalDeps),
    // D-119 Phase 13 — annotation + link warehouse.
    makeAnnotationHandlers(annotationDeps),
    // D-121 Phase 1 — contact warehouse rpc.
    makeContactHandlers(contactDeps),
    // D-138 Phase 1 — contact merge substrate (local-UI only;
    // namespace excluded from MCP catalog by ratchet).
    makeContactMergeHandlers(contactMergeDeps),
    // D-138 Phase 5 — upstream-merge outbox + driver (local-UI only;
    // namespace excluded from MCP catalog by ratchet).
    makeUpstreamMergeHandlers(upstreamMergeDeps),
    // D-125 Phase 2.1 — connection substrate rpc (list / enroll /
    // update / delete / probe). Probe is a placeholder until P4.x
    // ships per-kind handlers.
    makeConnectionHandlers(connectionDeps),
    // D-201 Slice 1 — draft ingress CRUD + encrypted credential-version
    // control plane. Intentionally independent of every HTTP listener.
    makeWebhookIngressHandlers(webhookIngressDeps),
    // D-166 override-write path — `collection.contract.*` override authoring
    // (Settings-only; reserved out of the MCP catalog). Writes the same
    // `contract.*` store the catalog gateway's override-tightening scan reads.
    makeContractHandlers(contractDeps),
    // D-182 §7.2 — `cli.reachability.*` grid rpc. Authors the per-contract cli
    // reachability allowlist over the same `contract.*` store the gateway's
    // cli-reachability resolver reads. Owner-only via the `cli.reachability.`
    // MCP-reserved prefix.
    makeCliReachabilityHandlers(cliReachabilityDeps),
    // D-152 — Settings → Reachability hostname registry CRUD +
    // ownership-proof transitions. Same store as the listener SNI
    // binding lookup, so a verified/enabled RPC mutation is the state
    // the TLS listener consults on the next handshake.
    makeHostnameHandlers(hostnameDeps),
    // LAN-URL kickstart — network.local_urls (loopback + LAN reachable URLs).
    makeNetworkHandlers(networkDeps),
    // D-139 P2 — Connection-page UX rpc (per-entity engagement health
    // surface + Salesforce capability re-probe). Salesforce-only
    // re-probe; HubSpot rejects with a hint at
    // `collection.connection.probe`.
    makeEngagementHealthHandlers(engagementHealthDeps),
    // D-122 Phase 4.5 — enrichment substrate rpc + notification +
    // mail-get. Each slice gates on its own deps so dbless harnesses
    // surface `not_configured` rather than crashing on undefined
    // lookups.
    makeEnrichmentHandlers(enrichmentDeps),
    makeNotificationHandlers(notificationDeps),
    makeMailGetHandlers(mailGetDeps),
    // D-123 Phase 5 — Settings → Server → Housekeeping panel rpc.
    // Scheduler instance stays internal to bin.ts; the deps' runOnce
    // arrow points at it so `task.run_now` fires through the same
    // code path the scheduler tick does.
    makeHousekeepingHandlers(housekeepingDeps),
    // D-163 Slice C — Settings → Notifications rpc surface. Wires
    // `notifications.{describe,set_channel,set_verification_phrase}`
    // against the `@recued/notification` block's settings surface.
    // Per-pair only — `notifications.` is in `MCP_RESERVED_RPC_PREFIXES`,
    // so MCP-channel agents cannot drive these mutators (the D-138
    // ratchet test asserts the prefix stays reserved).
    makeNotificationsHandlers(notificationsDeps),
    // D-169 P1 — `system.status` rpc slice. Bridge side-panel section
    // #1 reads on mount + each periodic refresh; webclient server
    // dashboard adopts the same rpc when it ships (O-7). Reserved
    // local-UI / local-bridge via `system.` prefix in
    // MCP_RESERVED_RPC_PREFIXES; the snapshot exposes paired client
    // count + WS state + activity counters that an MCP-channel agent
    // must not enumerate.
    makeSystemStatusHandlers(systemStatusDeps),
    // D-169 P2 — historical-view rpc slice. Bridge side-panel sections
    // #2/#3/#4 fetch their recent slice on mount + every reconnect
    // (cursorless re-fetch, spec § A.5). Thin reads over the D-120 audit
    // log + D-158 ask store; local-UI / local-bridge only (omitted from
    // MCP_TOOL_CATALOG, same posture as `system.status`).
    makeHistoryHandlers(historyDeps),
    // D-174 Runs/Audit feed + detail. Richer, cursor-paginated sibling of
    // `execution.recent`; registered-paired-client gated at the slice arrow.
    makeExecutionFeedHandlers(executionFeedDeps),
    // D-145 PA10 follow-on — Settings → Packs install rpc. Wires the
    // bulk-pack install transaction (recipes + body-content grants +
    // pack-shipped Standing Instruction rows) over the same engine
    // path foundation packs use at boot. Per-pair only — `packs.` is
    // in `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel agents cannot
    // ship attacker-controlled SI rules / body grants / recipes (the
    // D-138 ratchet test asserts the prefix stays reserved).
    makePackInstallHandlers(packInstallDeps),
    // D-145 PA10 follow-on — Settings → Packs list rpc. Read counterpart
    // to `packs.install`; reads bundled pack manifests off disk +
    // joins each with the per-pair `RecipeStore` to compute the
    // `installed` flag. Same `packs.` reserved-prefix gate.
    makePackListHandlers(packListDeps),
    // D-145 PA10 follow-on Slice B — Settings → Packs uninstall rpc.
    // Reverses the install transaction: drops pack-installed SI rows by
    // `<slug>:` prefix + deletes each recipe in the bundled manifest.
    // Same `packs.` reserved-prefix gate; same per-pair `RecipeStore` +
    // SI store handles as install + list.
    makePackUninstallHandlers(packUninstallDeps),
    // D-170 — Kitchen / Connection Setup ingredient-authoring install rpc.
    // `ingredient.install` decomposes a composition / app_pack → persists
    // bodies + inventory + registers the catalog for gateway resolution (N.16);
    // `ingredient.uninstall` reverses it refcount-aware with the `ingredient_pins`
    // dependency guard (N.14). Same reserved-prefix posture as packs.* —
    // authoring installs a callable capability, never reachable by MCP agents.
    makeIngredientAuthoringHandlers(ingredientAuthoringDeps),
    // D-170 N.4 / N.15 / #2 — the authoring side that precedes install:
    // `ingredient.draft.{save,list,get,delete}` persist an in-progress
    // composition; `ingredient.preview` runs one operation through the real
    // connection adapter (reads execute, mutations never do); `ingredient.
    // compose.decompose` validates + returns compiled artifacts for review.
    // Same `ingredient.` reserved-prefix channel-isolation as install.
    makeIngredientDraftHandlers(ingredientDraftDeps),
    // D-169 P0 — bridge capability profile push rpc. Slice 4's multi-
    // bridge dispatcher pre-filters on each connected bridge's most-
    // recent `granted_origins`; this slice closes the producer side —
    // the bridge SW pushes a fresh `BridgeCapabilityProfile` on every
    // (re)connect AND on every chrome.permissions onAdded/onRemoved
    // event (TR-17). The handler stamps the authenticated WS caller's
    // `client_token_id` as the registry key; channel-isolation is
    // belt-and-suspenders via the `bridge.` reserved-prefix gate.
    makeBridgeCapabilityHandlers(bridgeCapabilityDeps),
    // D-136 §A.13.5 P7.G — Settings → MCP per-topic visibility toggle.
    // Wires `mcp.visibility.{read,write}` against the same store the
    // MCP-side read gates consult, so a user toggle takes effect
    // immediately without a server restart.
    makeMCPVisibilityHandlers(mcpVisibilityDeps),
    // Grant-foundation slice 3 — Settings → contract grants CRUD. Wires the unified
    // (contract × grant) matrix (`contract.grant.{read,read_by_entry,write}`) against
    // the shared contract store; `contract.grant.` is MCP-reserved (channel isolation).
    makeContractGrantHandlers(contractGrantDeps),
    // D-148 W3.FU — Settings → Server → Exposure rpc surface. Wires
    // `exposure.{apply_preset,set_path_resolution,
    // set_public_mcp_acknowledgement}` against the in-process
    // `ExposureStateMachine` composed in bin.ts (W3.5 state machine +
    // W3.9 SQLite persistence + W3.10 reset-flag failsafe + FU6 signed
    // audit emission). Channel-isolation invariant intact —
    // `exposure.*` is in `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel
    // agents cannot drive these mutators (the ratchet test asserts the
    // prefix stays reserved).
    makeExposureHandlers(exposureDeps),
    // D-148 follow-up #4 — Settings → Server → TLS Certificates rpc.
    // Wires `tls_domain.{upload,remove,list}` against the W3.6
    // `SqliteTlsDomainStore` composed in bin.ts. Channel-isolation
    // invariant intact — `tls_domain.*` is in `MCP_RESERVED_RPC_PREFIXES`,
    // so MCP-channel agents cannot drive a cert upload / replace /
    // remove (the D-138 ratchet test asserts the prefix stays
    // reserved). Absent deps → every `tls_domain.*` method returns
    // `not_configured` (db-less harness or pre-W3.6 boot).
    makeTlsDomainHandlers(tlsDomainDeps),
    // D-148 follow-up #5 — Pro auto-managed `<handle>.recued.cloud`
    // unbind rpc. Wires `pro_acme.unbind` against the `proAcmeUnbind`
    // substrate (W3.6 `SqliteTlsDomainStore` + cloud `DdnsHandleControl`
    // adapter + signed audit sink). Channel-isolation invariant — the
    // `pro_acme.` prefix is in `MCP_RESERVED_RPC_PREFIXES` (D-138
    // ratchet test asserts the prefix stays reserved). Absent deps →
    // `pro_acme.unbind` returns `not_configured` (db-less harness, or
    // a production boot whose cloud DDNS release adapter hasn't landed
    // yet — the substrate ships ahead of the cloud-side endpoint per
    // the FU2-style substrate-then-wiring pattern).
    makeProAcmeHandlers(proAcmeDeps),
    // D-148 § A.4.4 — `token.rotate` rpc. Wires the per-client bearer
    // rotation primitive + `token.rotated` broadcast emit path against
    // the production `ClientTokenStore` + the D-121 `EventBus`.
    // Channel-isolation invariant — `token.` is in
    // `MCP_RESERVED_RPC_PREFIXES` (D-138 ratchet test asserts the
    // prefix stays reserved), so MCP-channel agents cannot drive
    // credential rotation. Absent deps → `token.rotate` returns
    // `not_configured` (db-less harness, or a boot whose
    // `createTokenRotationEmitter` hasn't been composed yet).
    makeTokenRotationHandlers(tokenRotationDeps),
    // D-148 § A.6.5 — `tls.renew` rpc. Wires operator-initiated TLS
    // cert renewal against the shared `RotationEngine` composed in
    // bin.ts (cert-rotation broadcaster + signing identity + audit
    // sink). Channel-isolation invariant — `tls.` is in
    // `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel agents cannot
    // drive TLS cert rotation. Absent deps → `tls.renew` returns
    // `not_configured` (db-less harness, or a boot where
    // `db && auditLog` doesn't hold so the engine never composes).
    // Engine returns `key_not_loaded` until the production `tls`
    // substrate hook lands; the slice surfaces that verbatim.
    makeTlsRenewHandlers(tlsRenewDeps),
    // D-148 § A.6.5 + § A.9 — `passport.fetch` rpc. Wires the
    // webclient post-WS-connect verify path against the passport
    // block-providers + `server_identity_key` keypair. Mints a fresh
    // `support_redacted` projection per call; deliberately skips the
    // `passport.exported` high-assurance audit row (every reconnect
    // would otherwise flood the ledger — fetch is internal, not
    // user-initiated export). Channel-isolation invariant —
    // `passport.` is in `MCP_RESERVED_RPC_PREFIXES`; MCP-channel
    // agents cannot fetch the passport projection. Absent deps →
    // `passport.fetch` returns `not_configured` (db-less harness, or
    // a boot whose passport-block-provider substrate hasn't been
    // composed yet — separate from the `tls.renew` engine above).
    makePassportFetchHandlers(passportFetchDeps),
    // R26.4 Delta 2 — `passport.export` + `passport.history.list` rpc.
    // The user-initiated half: a deliberate export mints a signed
    // projection at the chosen profile, emits the `passport.exported`
    // high-assurance audit row + appends to the durable history store;
    // history.list reads that store for Settings → Backup & Recovery.
    // Same `passport.` MCP reservation as fetch. Absent deps (db-less /
    // no-audit boot) → both return `not_configured`.
    makePassportExportHandlers(passportUserRpcDeps?.export),
    makePassportHistoryListHandlers(passportUserRpcDeps?.historyList),
    // R26.4 Delta 5 — `passport.import` rpc (new-server migration commit).
    // Re-verifies the uploaded migration_full passport + records the
    // `passport.imported` high-assurance provenance row. Same `passport.`
    // MCP reservation. Absent deps (db-less / no-audit boot) →
    // `not_configured`.
    makePassportImportHandlers(passportUserRpcDeps?.import),
    // R26.4 Delta 3 (D-148 § A.11 / § P7) — `key.rotate` + `key.health`
    // rpc. Operator-initiated key rotation + the Key Health read against
    // the SAME `RotationEngine` the `tls.renew` slice uses. `key.rotate`
    // dispatches `server_identity_rotate` / `mark_compromised` (+ the
    // self-host-dormant `master_dek` / `publisher` / `webhook` ops, which
    // surface `key_not_loaded`); `key.health` reads the per-class bundle
    // + availability map. Same operator-only posture as `tls.renew`
    // (`key.` is in `MCP_RESERVED_RPC_PREFIXES`). Absent deps (db-less /
    // no-engine boot) → both return `not_configured`.
    makeKeyRotateHandlers(keyRotateDeps),
    // D-148 § A.5.3 / § A.6.5 — `pro.*` rpc. Wires Settings → Pro
    // against the per-pair `ProAuthStateMachine` composed in bin.ts.
    // Mutations flow through the state machine's `onStateChanged`
    // listener to flip the ACME factory's `ProAuthResolver` ref so
    // the next renewal cycle picks up the new bearer (or reverts to
    // `pro_auth_unavailable` on sign-out). Channel-isolation
    // invariant — `pro.` is in `MCP_RESERVED_RPC_PREFIXES`, so
    // MCP-channel agents cannot mutate or read the subscription
    // bearer slot. Absent deps → all three `pro.*` methods return
    // `not_configured` (db-less harness).
    makeProAuthHandlers(proAuthDeps),
    // D-149 P3 § A.3 — Public Reception registry rpc. Wires the ten
    // `reception.*` admin-only methods against the per-pair
    // `PublicEndpointRegistryStore` + the preview-hash store + the
    // reception pepper. Channel-isolation invariant — `reception.*` is
    // in `MCP_RESERVED_RPC_PREFIXES` so external AI agents cannot drive
    // endpoint creation / token rotation / revocation. Absent deps →
    // every `reception.*` method returns `not_configured` (db-less
    // harness, pre-D-149 boot, or master_dek still locked so the
    // reception pepper can't be derived).
    makeReceptionHandlers(receptionDeps),
    // D-173 N.2 — Reception Inbox rpc trio (the review-then-approve inbox
    // over held `approval_required` operations). `reception.inbox.approve` is
    // the SOLE writer of `checkpoint.arg_overrides` (the N.5 security
    // boundary) — it validates the user's edits against the operation's
    // `ArgEditSchema` allowlist BEFORE the narrow `setArgOverrides` writer,
    // then releases the held op through the EXISTING preflight resume path.
    // Channel-isolation invariant — `reception.` is in
    // `MCP_RESERVED_RPC_PREFIXES`, so MCP-channel / anonymous-reception
    // callers can never list held visitor requests or drive the materialize.
    // Absent deps → every `reception.inbox.*` method returns `not_configured`
    // (db-less harness, or a boot whose `composeReceptionInboxDeps` gate
    // handles aren't composed).
    makeReceptionInboxRpcHandlers(receptionInboxDeps),
    // D-210 step 2a — `reception.record.list`. Admin-gated in the handler like the inbox
    // trio; the `reception.` reserved prefix keeps it off MCP.
    makeReceptionRecordRpcHandlers(receptionRecordDeps),
    // D-210 Appendix B — `reception.manage.mint` (on-the-go reschedule link).
    // Admin-gated in the handler; the `reception.` reserved prefix keeps it off MCP.
    makeReceptionManageMintRpcHandlers(receptionManageMintDeps),
    // D-240 § D11 — `reception.lookup.revoke`. Per-RECORD, because
    // `reception.endpoint.rotate_token` is per-ENDPOINT and would cut off every
    // submitter at once. Admin-gated in the handler; the reserved prefix keeps
    // it off MCP.
    makeReceptionLookupRevokeRpcHandlers(receptionLookupRevokeDeps),
    // D-145 PA11 — Settings → Work Entities panel rpc. Wires
    // `work_entity.source.{list,set_enabled,
    // set_default,clear_default}` against the work-entity resolver +
    // store. Threads through the same resolver instance the kernel
    // ingredients use (constructed in bin.ts) so toggle writes are
    // visible to recipe-side polymorphic reads on the next call.
    makeWorkEntitySourceHandlers(workEntitySourceDeps),
    makeContactSourceHandlers(contactSourceDeps),
    makeContactImportHandlers(contactImportDeps),
    // D-174 #22 — work-entity warehouse CRUD rpc (Data route). Wires
    // `work_entity.{list,get,upsert,delete}` over the four own-it kinds:
    // list/get read through the resolver; upsert/delete route through the
    // same event-emitting `createWorkEntityDispatchers` slots the
    // ingredient channel uses (reactive/trigger semantics hold). Local-UI
    // only — mirrors `contact.*` (not in `MCP_RESERVED_RPC_PREFIXES`; the
    // MCP catalog is a closed `recued_*` allowlist so the rpc name can't
    // bridge onto it, and MCP-channel writes go through the gateway-gated
    // ingredient path). Absent deps → every method returns `not_configured`.
    makeWorkEntityCrudHandlers(workEntityCrudDeps),
    // Accepted intake responses — immutable owner-local Data browser. The
    // slice itself enforces the registered-client boundary and the namespace
    // is reserved out of MCP.
    makeFormResponseHandlers(formResponseDeps),
    // D-221 — full-ref Records explorer and lifecycle controls. Every arrow
    // enforces a registered paired client and `records.` is MCP-reserved.
    makeRecordsRpcHandlers(recordsRpcDeps),
    // D-174 #22 — `data.timeline` read pair-RPC (Data route drill-down).
    // Third isolated channel wrapping the shared `handleTimelineRequest`
    // (alongside MCP `recued_dataTimeline` + recipe `timeline-read`):
    // same SELECT, separate dispatcher. Read-only; paired-client reads
    // see private rows (no MCP gate). Absent deps → `not_configured`.
    makeTimelineRpcHandlers(timelineRpcDeps),
    // D-198 Slice 1 — `memory.list` owner-trusted read pair-RPC (the Memory
    // lens feed). Whole-feed, origin-filtered; registered-client boundary,
    // no contract gate. Absent deps → `not_configured`.
    makeMemoryRpcHandlers(memoryRpcDeps),
    // D-172 Half-A "open" — `data.file.read` owner read pair-RPC (Files tab
    // open/download). Fourth isolated channel over `handleFileRead`; owner-
    // trusted (registered-client boundary), no contract/egress gate.
    makeFileReadRpcHandlers(fileReadRpcDeps),
    // D-139 P5 — `data.contact.engagements.list` resolver pair-RPC.
    makeContactEngagementsRpcHandlers(contactEngagementsRpcDeps),
    // D-145 PB12 — Peer-Recued Preview consumer rpc. Wires
    // `s2s_preview.{build,consume}` against the substrate
    // `buildRedactedPacket` + the SQLite token store. The two
    // methods are the local-callable entry point for both the
    // S2S Preview consumer (D-145 ships) and the future D-149
    // reception consumer (downstream); per-pair only — no
    // cross-cloud sync (D-097 / D-168).
    makeS2SPreviewHandlers(s2sPreviewDeps),
    // D-137 P1.2 — AI Chat rpc slice (Wire A). Wires the ten
    // `chat.*` methods against the per-pair ChatStore + server-side
    // orchestrator + D-121 broadcast bus. Absent deps → every
    // chat method returns `not_configured` (chat substrate hasn't
    // booted yet, e.g. db-less harness).
    makeChatHandlers(chatDeps),
    // D-121 Phase 6 — realtime broadcast bus subscribe rpc.
    // pushToClient mirrors the approvalDeps shape (drops on
    // not-OPEN; never throws to the bus). Subscriber id is the
    // WS reference itself — object identity is stable for the
    // lifetime of the connection.
    makeEventsHandlers(
      eventsDeps
        ? {
            bus: eventsDeps.bus,
            pushToClient: (client, payload) => {
              send(client.ws, payload);
            },
            subscriberId: (client) => client.ws,
          }
        : undefined,
    ),
  ]);

  // Boot-time safety net — every wired method must be in the
  // contract-side set. Catches typos in adapter slices early.
  for (const m of wiredMethods) {
    if (!SERVER_RPC_METHOD_SET.has(m as string)) {
      throw new Error(`ws-server: handler wired for '${String(m)}' which is not in SERVER_RPC_METHOD_SET`);
    }
  }

  const dispatchRpc = createRpcDispatcher<ServerRpcRegistry, WsClient>(handlers, {
    migrationActive: migrateDeps ? () => migrateDeps.migrationState.exists() : undefined,
    touchActivity: authDeps ? () => authDeps.keys.touch() : undefined,
    knownMethods: SERVER_RPC_METHOD_SET,
    lifecycleState,
  });

  const WsServer = ws.WebSocketServer as new (opts: {
    noServer: boolean;
    maxPayload?: number;
    perMessageDeflate?: boolean;
    /** `ws`'s subprotocol-selection hook. Typed here because this local shape
     *  is hand-written — an option absent from it is a compile error, which is
     *  the desired behaviour: a security-relevant option must not be passable
     *  by accident, and must be declared to be usable. */
    handleProtocols?: (
      protocols: ReadonlySet<string>,
      request: IncomingMessage,
    ) => string | false;
  }) => any;
  const WS_OPEN = ws.WebSocket?.OPEN ?? ws.OPEN ?? 1;

  const wss = new WsServer({
    noServer: true,
    maxPayload: RPC_WS_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    // ⛔ PIN THE SELECTION — do not let `ws` pick. Its default is
    // `protocols.values().next().value`, the client's FIRST offered value, and
    // the selection is echoed in the `Sec-WebSocket-Protocol` RESPONSE header.
    // Since browsers now carry the bearer in that field, a client that offered
    // it first would have its secret echoed straight back into the response —
    // and into whatever logs that header. `selectWsSubprotocol` only ever
    // returns the version marker, or nothing.
    handleProtocols: selectWsSubprotocol,
  });
  const clients = new Map<any, WsClient>();
  const activeRpcDispatches = new Set<Promise<void>>();
  const activeRpcDispatchCountBySocket = new WeakMap<object, number>();
  const activeDataSocketDispatches = new Set<Promise<void>>();
  const activeUpgradeVerifications = new Set<Promise<void>>();
  let upgradeAdmissionOpen = true;
  let rpcAdmissionOpen = true;
  let dataSocketAdmissionOpen = true;
  let closePromise: Promise<void> | undefined;

  /** Own async work launched by the three binary data sockets. Transport
   *  teardown stops new messages, but the service promise may already be past
   *  its socket read and writing SQLite/files; terminal close must wait for it
   *  before the caller closes those resources. */
  const trackDataSocketDispatch = (task: Promise<void>): void => {
    activeDataSocketDispatches.add(task);
    const clear = (): void => { activeDataSocketDispatches.delete(task); };
    void task.then(clear, clear);
  };

  const trackUpgradeVerification = (task: Promise<void>): void => {
    activeUpgradeVerifications.add(task);
    const clear = (): void => { activeUpgradeVerifications.delete(task); };
    void task.then(clear, clear);
  };

  const terminateDataSocket = (socket: any): void => {
    try {
      if (typeof socket.terminate === 'function') socket.terminate();
      else socket.close();
    } catch { /* already closed */ }
  };

  // D-172 resumable uploads — a SEPARATE WebSocketServer for the dedicated
  // binary `/ws/upload` data socket. Kept distinct from the rpc `wss` on
  // purpose: (1) the rpc wire is text-JSON only, this one is binary; (2) an
  // upload socket must NOT join `clients` / the broadcast bus (it is a pure byte
  // pipe, no rpc, no events); (3) isolating large chunk frames here means a
  // multi-minute upload never head-of-line-blocks rpc / event traffic on the
  // shared socket. Only constructed when an upload service is wired. A tight
  // `maxPayload` (one max chunk + the frame header budget) rejects an over-cap
  // frame at the WS layer — before a 100 MiB (`ws` default) buffer + the
  // service-side copy (Codex 2026-06-24 fold).
  const uploadWss = uploadDeps
    ? new WsServer({
        noServer: true,
        maxPayload: UPLOAD_WS_MAX_PAYLOAD_BYTES,
        // Same pin as the rpc socket: never echo a client's bearer back in the
        // handshake response. These data sockets carry the bearer in the
        // subprotocol too, so `ws`'s first-offered default is a live hazard here.
        handleProtocols: selectWsSubprotocol,
      })
    : null;

  // M4 archive download — a SEPARATE WebSocketServer for the dedicated binary
  // `/ws/download` data socket, kept distinct from the rpc `wss` for the same
  // reasons as `uploadWss`: it's a pure byte pipe (no rpc, no broadcast bus),
  // and isolating a multi-second archive stream here means it never head-of-
  // line-blocks rpc / event traffic. The tight `maxPayload` rejects an oversized
  // INBOUND frame at the WS layer — the client only ever sends one small
  // `download_start`; the server's outbound chunks are unbounded by this cap
  // (it gates inbound only) and self-paced by the read stream + backpressure.
  const downloadWss = downloadDeps
    ? new WsServer({
        noServer: true,
        maxPayload: DOWNLOAD_WS_MAX_INBOUND_BYTES,
        handleProtocols: selectWsSubprotocol,
      })
    : null;

  // M4b.1 archive upload (no-SSH migrate) — a SEPARATE WebSocketServer for the
  // dedicated binary `/ws/archive-upload` data socket. Same posture + rationale
  // as `uploadWss` (it IS the same generic chunk-frame transport, just a
  // different finalize policy): a pure byte pipe, off `clients` / the broadcast
  // bus, isolated so a multi-minute archive upload never head-of-line-blocks rpc
  // / event traffic. The same tight `maxPayload` (one max chunk + the frame
  // header budget) rejects an over-cap frame at the WS layer.
  const archiveUploadWss = archiveUploadDeps
    ? new WsServer({
        noServer: true,
        maxPayload: UPLOAD_WS_MAX_PAYLOAD_BYTES,
        handleProtocols: selectWsSubprotocol,
      })
    : null;

  // D-169 P0 follow-on — multi-bridge dispatcher composition. The
  // dispatcher needs three deps the ws layer naturally owns:
  //   1. `BridgeRegistry` — per-pair shared map (created in
  //      `compose-listeners.ts`; threaded in via `bridgeRegistry` option
  //      so the same instance backs both attach + `bridgeCapabilityDeps`).
  //   2. `BridgeResultListener` — process-local pending-promise map.
  //      Inbound `{kind: 'result'}` frames from the bridge SW resolve
  //      a matching slot here; the dispatcher pre-registers a slot
  //      before sending each command (Codex P1 #3 fold per dispatcher
  //      docstring) so a sub-millisecond response can't beat the
  //      listener registration.
  //   3. `BridgeTransport` — closes over the `clients` map; finds the
  //      WsClient whose `client_token_id` matches the dispatcher's
  //      target + sends a JSON-stringified `BridgeWireEnvelope`.
  //      Disconnected bridges surface as `bridge_offline`; write errors
  //      surface as `transport_error`. A remote 429 / queue_full comes
  //      back asynchronously as a rejected BridgeResult and resolves
  //      the same per-attempt listener slot.
  // Gated on `bridgeRegistry` being wired — composes only when the
  // pair-shared registry is available. Test compositions that don't
  // exercise the bridge surface leave `bridgeRegistry` undefined; the
  // returned handle then carries `bridgeDispatcher: undefined`.
  let bridgeDispatcher: BridgeDispatcher | undefined;
  let bridgeResultListener: BridgeResultListener | undefined;
  if (bridgeRegistry) {
    bridgeResultListener = createBridgeResultListener();
    /** Find the WsClient that owns the CURRENT session for a given
     *  bridge `client_token_id`. Reconnect races can leave an old +
     *  new socket alive simultaneously while the registry's
     *  `session_id` has already rolled to the new one (Codex
     *  2026-05-28 Angle 2 fold). Cross-checking the registry's current
     *  `session_id` against each candidate's `bridge_session_id`
     *  ensures we never send to a stale socket — the old close
     *  handler's race-guarded detach (310th-session slice `f93d3d9b`)
     *  uses the identical invariant on the inverse path. When the
     *  registry has no record for the token (capability push raced
     *  the attach, or the bridge has disconnected and the close has
     *  already run), fall back to first-match-by-token so a
     *  pre-attach-window dispatch still resolves a connected bridge
     *  rather than silently 404'ing — the registry-current case is
     *  the steady-state path. */
    const findBridgeClient = (client_token_id: string): WsClient | undefined => {
      const record = bridgeRegistry.get(client_token_id);
      const target_session_id = record?.session_id;
      let fallback: WsClient | undefined;
      for (const c of clients.values()) {
        if (c.client_kind !== 'bridge' || c.client_token_id !== client_token_id) {
          continue;
        }
        if (target_session_id !== undefined) {
          if (c.bridge_session_id === target_session_id) return c;
          continue;
        }
        // No registry record — first-match-by-token fallback.
        if (!fallback) fallback = c;
      }
      return fallback;
    };
    /** WS-transport `send` implementation. Returns the closed-list
     *  `BridgeSendResult` shape:
     *
     *    - `{ok: true}` — JSON.stringified envelope written to the
     *      bridge's open WS without throwing.
     *    - `{ok: false, reason: 'bridge_offline'}` — no client with
     *      matching `(client_kind: 'bridge', client_token_id)` found
     *      (disconnected) OR the matched client's `readyState` is
     *      anything other than OPEN (closing / closed).
     *    - `{ok: false, reason: 'transport_error', detail}` — the
     *      `ws.send()` call threw.
     *
     *  `queue_full` is necessarily absent from this synchronous return:
     *  WS send completion only means the frame was written. The bridge
     *  reports saturation as `{kind:'result', status:'rejected',
     *  error.code:'queue_full'}`; the dispatcher's per-attempt waiter
     *  consumes that control result and retries with backoff. Transports
     *  that can report local queue depth may still return the existing
     *  synchronous `queue_full` reason. */
    const sendEnvelope = (
      client_token_id: string,
      envelope: BridgeWireEnvelope,
    ): BridgeSendResult => {
      const target = findBridgeClient(client_token_id);
      if (!target) {
        return { ok: false, reason: 'bridge_offline' };
      }
      if (target.ws.readyState !== WS_OPEN) {
        return { ok: false, reason: 'bridge_offline' };
      }
      const sent = sendBoundedWsJson(target.ws, envelope, WS_OPEN);
      if (!sent.ok) {
        if (sent.reason === 'closed') return { ok: false, reason: 'bridge_offline' };
        return {
          ok: false,
          reason: 'transport_error',
          detail: sent.detail ?? sent.reason,
        };
      }
      return { ok: true };
    };
    const bridgeTransport: BridgeTransport = {
      async send(client_token_id, envelope) {
        return sendEnvelope(client_token_id, envelope);
      },
      async cancel(client_token_id, cancel) {
        return sendEnvelope(client_token_id, { kind: 'cancel', cancel });
      },
    };
    bridgeDispatcher = createBridgeDispatcher({
      registry: bridgeRegistry,
      transport: bridgeTransport,
      listener: bridgeResultListener,
      ...(bridgeDispatcherAuditLog ? { auditLog: bridgeDispatcherAuditLog } : {}),
    });
  }
  /** All five `*Delegations`/queries maps use `createPendingMap` —
   *  centralizes timeout cleanup on delete + reject-all on shutdown
   *  so request_id correlation stays leak-free even when the paired
   *  extension disappears mid-flight. Domain fields (slug, input,
   *  claimed_by, …) live in each map's value type; the primitive
   *  only cares about the resolve/reject/timeout triple. */
  const aiDelegations = createPendingMap<AiDelegation>();
  /** Chat delegations: broadcast → first claim wins → execute → result */
  const chatDelegations = createPendingMap<{
    request_id: string;
    slug: string;
    input: Record<string, unknown>;
    claimed_by: string | null;
    /** The WS connection that WON the claim. `chat_result` is accepted ONLY
     *  from this exact socket (object identity) — binding to the connection
     *  rather than `claimed_by` (instance_id, null for a bearer-only client +
     *  null before any claim) closes the result-forgery hole for every client
     *  kind. The claim-once gate also keys on this. */
    claimed_ws: unknown;
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  /** Pending kernel-recipe delegations (server → ext single-target RPC,
   *  used by MCP per-ingredient tool dispatch). */
  const kernelRecipeDelegations = createPendingMap<{
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  /** Pending ingredient-catalog queries (server → ext; used by MCP
   *  tool-list to merge extension ingredients ahead of server's). */
  const ingredientQueries = createPendingMap<{
    resolve: (ingredients: Array<{ slug: string; manifest: unknown }>) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  /** Pending peer-cache queries (server → ext on L2 miss). */
  const cacheGetRequests = createPendingMap<{
    resolve: (entry: import('@recued/cache').CacheEntry | null) => void;
    reject: (err: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  // Upgrade HTTP → WebSocket on /ws path. Named callback so the
  // legacy `httpServer.on('upgrade', upgradeHandler)` binding (tests +
  // pre-W3.5b production) AND the new path-router `ws` role upgrade slot
  // (W3.5b path-routed production) share one implementation.
  //
  // D-148 § A.2.1 — when `clientTokens` is wired AND the bearer matches
  // the structured `<token_id>.<bearer>` shape, the upgrade verifies
  // against `client_tokens` BEFORE accepting the socket. On success,
  // the resolved `token_id` lands on `WsClient.client_token_id` so the
  // `pair_revoke` ledger row's `detail.client_token_id` join column
  // auto-populates (no further plumbing on the audit side). When the
  // store is wired, raw/opaque bearers reject at upgrade; db-less
  // harnesses without the store retain their legacy path.
  const upgradeHandler: PortUpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!upgradeAdmissionOpen) {
      try { socket.destroy(); } catch { /* already closed */ }
      return;
    }
    const url = req.url ?? '';
    if (!url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    // D-172 — the dedicated binary upload data socket shares the `/ws` role
    // prefix (so it routes through this same upgrade handler) but dispatches to
    // a SEPARATE WebSocketServer below. Strip the query before matching.
    const [pathname] = url.split('?');

    // Consolidated 401 reject — write + destroy, both best-effort.
    const reject401 = (): void => {
      try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch { /* socket already closed */ }
      try { socket.destroy(); } catch { /* already destroyed */ }
    };

    // Auth: Bearer token from query string or header
    const realm = extractRealm(req);
    if (!realm) {
      reject401();
      return;
    }

    const acceptUpgrade = (
      verified: {
        token_id: string;
        client_kind: ClientKind;
        client_label: string | null;
        /** D-151 follow-on — paired-instance id derived from the verified
         *  client token's `metadata.instance_id` (already revoke-checked
         *  by the caller). Lands on `WsClient.token_instance_id`, NOT
         *  `instance_id` — see those fields' docs for why the split
         *  matters. */
        token_instance_id?: string | null;
      } | undefined,
    ): void => {
      wss.handleUpgrade(req, socket, head, (ws: any) => {
        const now = Date.now();
        const client: WsClient = {
          ws,
          realm,
          instance_id: null,
          token_instance_id: verified?.token_instance_id ?? null,
          display_name: 'unknown',
          connected_at: now,
          ...(verified !== undefined
            ? {
                client_token_id: verified.token_id,
                client_kind: verified.client_kind,
                ...(verified.client_label !== null
                  ? { client_label: verified.client_label }
                  : {}),
              }
            : {}),
        };
        // D-169 P0 follow-on — seed the `BridgeRegistry` so the
        // `bridge.capabilityProfile.push` rpc lands via
        // `updateCapabilities` instead of the no-op pre-attach branch
        // (Codex 2026-05-28 Angle 1 fold). Empty-but-typed capabilities
        // here; the bridge SW's `onConnected` hook fires the first push
        // immediately after the WS opens, overwriting these defaults
        // with the real grants. Until that push arrives, an empty
        // `granted_origins` keeps the dispatcher's eligibility filter
        // honest — no bridge appears eligible for any pattern until
        // it has actually reported its grants. Gated on
        // `client_kind === 'bridge'` so webclients / CLI clients don't
        // pollute the bridge registry. The session id is opaque to
        // callers; we stash it on the WsClient so the close handler can
        // safely detach (only if the registry's current session_id
        // still matches — guards against a fresh reconnect that already
        // rolled `attach()` over).
        if (
          bridgeRegistry &&
          verified !== undefined &&
          verified.client_kind === 'bridge'
        ) {
          const session_id = randomUUID();
          bridgeRegistry.attach({
            client_token_id: verified.token_id,
            ...(verified.client_label !== null
              ? { client_label: verified.client_label }
              : {}),
            session_id,
            online_since: now,
            last_seen_at: now,
            capabilities: emptyBridgeCapabilityProfile(),
          });
          client.bridge_session_id = session_id;
        }
        clients.set(ws, client);
        wss.emit('connection', ws, req);
      });
    };

    // D-172 — accept a verified upload data socket onto the SEPARATE binary
    // `uploadWss`. NOT registered in `clients` + never joins the broadcast bus:
    // it is a pure chunk-frame pipe. The scope key is the verified paired-
    // instance identity; a client with no scope identity (legacy raw-bearer /
    // unverified) can't be isolated, so it's rejected rather than accepted into
    // a shared bucket. Each binary frame is one `UploadChunkFrame`; the ack is a
    // JSON text frame correlated by `req_id`.
    const acceptUploadUpgrade = (
      verified: {
        token_id: string;
        client_kind: ClientKind;
        client_label: string | null;
        token_instance_id?: string | null;
      } | undefined,
    ): void => {
      const scope_key = verified?.token_instance_id ?? null;
      if (!uploadWss || !uploadDeps || typeof scope_key !== 'string' || scope_key.length === 0) {
        reject401();
        return;
      }
      const uploadService = uploadDeps.service;
      uploadWss.handleUpgrade(req, socket, head, (wsUp: any) => {
        wsUp.binaryType = 'nodebuffer';
        let chunkInFlight = false;
        wsUp.on('message', (raw: any, isBinary: boolean) => {
          if (!dataSocketAdmissionOpen) return;
          // The data socket carries ONLY binary chunk frames; the control plane
          // (create / probe / finalize / delete) is rpc on the other socket. A
          // text frame is a protocol violation → ignore.
          if (!isBinary) return;
          // The client is ack-paced. A second frame before the first settles
          // would otherwise append another retained closure to the upload
          // core's per-id promise chain. Many sockets are bounded globally.
          if (chunkInFlight || activeDataSocketDispatches.size >= DATA_WS_MAX_IN_FLIGHT_GLOBAL) {
            terminateDataSocket(wsUp);
            return;
          }
          chunkInFlight = true;
          const frame: Uint8Array = Array.isArray(raw) ? Buffer.concat(raw) : (raw as Uint8Array);
          const task = uploadService
            .handleChunkFrame(scope_key, frame)
            .then((ack) => {
              sendBoundedWsJson(wsUp, ack, WS_OPEN);
            })
            .catch(() => {
              // `handleChunkFrame` is total (every path resolves to an ack), so
              // this only guards against an unexpected unhandled rejection —
              // drop quietly; the client re-sends on its no-ack timeout.
            });
          trackDataSocketDispatch(task.finally(() => { chunkInFlight = false; }));
        });
        wsUp.on('error', () => { /* socket-level error — the close path tears down */ });
      });
    };

    // M4b.1 — accept a verified archive-upload data socket onto the SEPARATE
    // binary `archiveUploadWss`. Identical mechanics to `acceptUploadUpgrade`
    // (the chunk frame is the SAME generic transport) — only the service differs
    // (its finalize STAGES to `exports/` instead of ingesting a warehouse row).
    // NOT registered in `clients` + never joins the broadcast bus; scoped to the
    // verified paired-instance identity (a client with no scope identity is
    // rejected, not pooled). The archive bytes are recovery-key ciphertext, so
    // the bearer gate is sufficient (decryption needs the key, supplied only at
    // import).
    const acceptArchiveUploadUpgrade = (
      verified: {
        token_id: string;
        client_kind: ClientKind;
        client_label: string | null;
        token_instance_id?: string | null;
      } | undefined,
    ): void => {
      const scope_key = verified?.token_instance_id ?? null;
      if (!archiveUploadWss || !archiveUploadDeps || typeof scope_key !== 'string' || scope_key.length === 0) {
        reject401();
        return;
      }
      const archiveUploadService = archiveUploadDeps.service;
      archiveUploadWss.handleUpgrade(req, socket, head, (wsUp: any) => {
        wsUp.binaryType = 'nodebuffer';
        let chunkInFlight = false;
        wsUp.on('message', (raw: any, isBinary: boolean) => {
          if (!dataSocketAdmissionOpen) return;
          // The data socket carries ONLY binary chunk frames; the control plane
          // (create / probe / finalize / delete) is rpc on the other socket. A
          // text frame is a protocol violation → ignore.
          if (!isBinary) return;
          if (chunkInFlight || activeDataSocketDispatches.size >= DATA_WS_MAX_IN_FLIGHT_GLOBAL) {
            terminateDataSocket(wsUp);
            return;
          }
          chunkInFlight = true;
          const frame: Uint8Array = Array.isArray(raw) ? Buffer.concat(raw) : (raw as Uint8Array);
          const task = archiveUploadService
            .handleChunkFrame(scope_key, frame)
            .then((ack) => {
              sendBoundedWsJson(wsUp, ack, WS_OPEN);
            })
            .catch(() => {
              // `handleChunkFrame` is total (every path resolves to an ack), so
              // this only guards an unexpected unhandled rejection — drop
              // quietly; the client re-sends on its no-ack timeout.
            });
          trackDataSocketDispatch(task.finally(() => { chunkInFlight = false; }));
        });
        wsUp.on('error', () => { /* socket-level error — the close path tears down */ });
      });
    };

    // M4 — accept a verified download data socket onto the SEPARATE binary
    // `downloadWss`. Same posture as the upload socket: NOT registered in
    // `clients`, never joins the broadcast bus, scoped to the verified paired-
    // instance identity (a client with no scope identity is rejected, not pooled
    // into a shared bucket). The client sends ONE text `download_start`; the
    // server replies with raw binary chunk frames + a terminal text control
    // frame. The archive bytes are recovery-key ciphertext, so the bearer gate
    // is sufficient (decryption needs the key, supplied only at import).
    const acceptDownloadUpgrade = (
      verified: {
        token_id: string;
        client_kind: ClientKind;
        client_label: string | null;
        token_instance_id?: string | null;
      } | undefined,
    ): void => {
      const scope_key = verified?.token_instance_id ?? null;
      if (!downloadWss || !downloadDeps || typeof scope_key !== 'string' || scope_key.length === 0) {
        reject401();
        return;
      }
      const downloadService = downloadDeps.service;
      downloadWss.handleUpgrade(req, socket, head, (wsDl: any) => {
        wsDl.binaryType = 'nodebuffer';
        // The sink wraps the raw socket; `send(chunk, cb)` fires the callback
        // after the frame flushes, which the service awaits as backpressure.
        const sink: DownloadSink = {
          isOpen: () => wsDl.readyState === WS_OPEN,
          sendBinary: (chunk, cb) => {
            try { wsDl.send(chunk, cb); } catch (err) { cb(err as Error); }
          },
          sendControl: (frame) => {
            if (wsDl.readyState === WS_OPEN) { try { wsDl.send(frame); } catch { /* closed */ } }
          },
        };
        // Single-shot: honor exactly ONE `download_start` text frame. Binary
        // inbound is a protocol violation, and a second start while one stream
        // is in flight would interleave chunks — both ignored.
        let started = false;
        wsDl.on('message', (raw: any, isBinary: boolean) => {
          if (!dataSocketAdmissionOpen || isBinary || started) return;
          if (activeDataSocketDispatches.size >= DATA_WS_MAX_IN_FLIGHT_GLOBAL) {
            terminateDataSocket(wsDl);
            return;
          }
          started = true;
          const text = typeof raw === 'string' ? raw : (raw as Buffer).toString('utf8');
          const task = downloadService.handleStart(text, sink).catch(() => {
            // handleStart is total; this only guards an unexpected rejection.
          });
          trackDataSocketDispatch(task);
        });
        wsDl.on('error', () => { /* socket-level error — the close path tears down */ });
      });
    };

    // Shared verify ceremony, used by BOTH the rpc accept + the upload accept:
    // a structured bearer is verified against `client_tokens` BEFORE accepting
    // the socket. A malformed / expired / revoked structured bearer is a hard
    // reject (the caller picked the strict form intentionally — falling through
    // to legacy accept-any would defeat the tightening). The legacy / db-less
    // path (no token store) accepts-any with `undefined`. Async-aware: the
    // upgrade handler holds the raw socket open until either `handleUpgrade` or
    // `socket.destroy()` resolves the suspended state.
    const dispatchVerifiedUpgrade = (
      accept: (
        verified: {
          token_id: string;
          client_kind: ClientKind;
          client_label: string | null;
          token_instance_id?: string | null;
        } | undefined,
      ) => void,
    ): void => {
      const structured = clientTokens ? parseStructuredBearer(realm) : null;
      if (!structured) {
        if (clientTokens) { reject401(); return; }
        accept(undefined);
        return;
      }
      const task = clientTokens!
        .verify(structured.token_id, structured.bearer)
        .then(({ ok, record }) => {
          // The verifier may have been doing Argon2 work while terminal close
          // shut every WebSocketServer. Never touch SQLite or accept the raw
          // socket after that fence.
          if (!upgradeAdmissionOpen) {
            try { socket.destroy(); } catch { /* already closed */ }
            return;
          }
          if (!ok || !record) { reject401(); return; }
          // Stamp last_used_at — best-effort; a touch failure shouldn't block
          // the accepted upgrade (the verify already succeeded so the bearer is
          // authoritative).
          try { clientTokens!.touch(record.token_id); } catch { /* non-fatal */ }
          // D-151 follow-on — derive the bearer's paired-instance identity from
          // the token metadata, revoke-gated (see `deriveBearerInstanceId`).
          accept({
            token_id: record.token_id,
            client_kind: record.client_kind,
            client_label: record.client_label,
            token_instance_id: deriveBearerInstanceId(
              record.metadata?.['instance_id'],
              (id) => pairedInstances?.isRevoked(id) ?? false,
            ),
          });
        })
        .catch(() => {
          // verify throws are treated as auth-failure (defense in depth — an
          // unexpected Argon2id throw must not silently accept).
          reject401();
        });
      trackUpgradeVerification(task);
    };

    // Route the upgrade: the dedicated binary upload data socket (only when the
    // service is wired — else 503-close) vs. the rpc socket. Both share the
    // verify ceremony above; they differ only in which WebSocketServer + client
    // model they accept into.
    if (pathname === '/ws/upload') {
      if (!uploadWss) {
        try { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); } catch { /* closed */ }
        try { socket.destroy(); } catch { /* destroyed */ }
        return;
      }
      dispatchVerifiedUpgrade(acceptUploadUpgrade);
      return;
    }
    if (pathname === '/ws/download') {
      if (!downloadWss) {
        try { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); } catch { /* closed */ }
        try { socket.destroy(); } catch { /* destroyed */ }
        return;
      }
      dispatchVerifiedUpgrade(acceptDownloadUpgrade);
      return;
    }
    if (pathname === '/ws/archive-upload') {
      if (!archiveUploadWss) {
        try { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); } catch { /* closed */ }
        try { socket.destroy(); } catch { /* destroyed */ }
        return;
      }
      dispatchVerifiedUpgrade(acceptArchiveUploadUpgrade);
      return;
    }
    dispatchVerifiedUpgrade(acceptUpgrade);
  };

  // Legacy single-listener binding — preserved for `attachWebSocket`
  // callers (tests + the pre-W3.5b production path). The path-routed
  // flow leaves `httpServer === null` and consumes `upgradeHandler`
  // from the returned binding instead.
  if (httpServer) {
    httpServer.on('upgrade', upgradeHandler);
  }

  wss.on('connection', (ws: any) => {
    const client = clients.get(ws);
    if (!client) return;

    ws.on('message', (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleMessage(client, msg);
      } catch {
        // Malformed message — ignore
      }
    });

    // D-169 P0 follow-on — detach the `BridgeRegistry` record so a
    // disconnected bridge stops appearing eligible in Slice 4's
    // dispatcher iteration. Race-safe: only detach if the registry's
    // current `session_id` for this `client_token_id` still matches
    // this socket's stamp — a fresh reconnect that already rolled
    // `attach()` over wrote a new session_id, and we leave the new
    // record alone. Shared helper for close + error so both paths take
    // the same gate.
    const detachBridgeOnDisconnect = (): void => {
      if (
        !bridgeRegistry ||
        client.client_kind !== 'bridge' ||
        !client.client_token_id ||
        !client.bridge_session_id
      ) {
        return;
      }
      const current = bridgeRegistry.get(client.client_token_id);
      if (current && current.session_id === client.bridge_session_id) {
        bridgeRegistry.detach(client.client_token_id);
      }
    };

    ws.on('close', () => {
      detachBridgeOnDisconnect();
      clients.delete(ws);
      // D-121 Phase 6 — drop the bus subscription so a stale callback
      // doesn't keep the closed WS alive in the bus subscribers map.
      eventsDeps?.bus.unsubscribe(ws);
    });

    ws.on('error', () => {
      detachBridgeOnDisconnect();
      clients.delete(ws);
      eventsDeps?.bus.unsubscribe(ws);
    });
  });

  const handleMessage = (client: WsClient, msg: Record<string, unknown>): void => {
    // D-169 P0 follow-on — `BridgeFromBridgeWireEnvelope` discriminator.
    // The bridge SW serializes its inbound→server frames as
    // `{kind: 'result', result: BridgeResult}` (see
    // `apps/bridge/src/boot/service-worker-bootstrap.ts` `sendBridgeResult`).
    // We branch on the union's `kind` discriminator BEFORE the legacy
    // `msg.type` switch so a future widening of `BridgeFromBridgeWireEnvelope`
    // (capability re-push frames live on the rpc envelope; cancel-ack
    // frames are a candidate) can chain off the same prefix. Gated on
    // `client_kind === 'bridge'` so a webclient / extension can't spoof
    // a result frame for an in-flight bridge command. Defensive shape
    // check on `result.command_id` keeps a malformed bridge frame from
    // throwing into `listener.resolveResult()`'s consumer paths.
    if (
      bridgeResultListener &&
      client.client_kind === 'bridge' &&
      typeof msg.kind === 'string'
    ) {
      if (msg.kind === 'result') {
        const result = msg.result as BridgeResult | undefined;
        if (
          result &&
          typeof result === 'object' &&
          typeof result.command_id === 'string' &&
          result.command_id.length > 0 &&
          client.client_token_id !== undefined &&
          // D-169 P0 follow-on — per-bridge ownership check (Codex
          // 2026-05-28 Angle 4 fold). The listener resolves by
          // `command_id` alone, so without this gate a malicious
          // authenticated bridge could resolve another bridge's
          // in-flight command by guessing or replaying the id. The
          // dispatcher's `inflight` map tracks `command_id →
          // bridge_client_token_id`; `canResolve` queries it. Drop
          // silently on mismatch — same posture as the listener uses
          // when no matching pending slot exists.
          bridgeDispatcher?.canResolve(result.command_id, client.client_token_id)
        ) {
          bridgeResultListener.resolveResult(result);
        }
        return;
      }
      // Unknown bridge envelope kind — drop silently. The
      // `BridgeFromBridgeWireEnvelope` union is closed; an unknown kind
      // is either a wire-protocol drift or a malformed frame, and the
      // legacy `msg.type` switch wouldn't have done anything useful
      // either.
      return;
    }
    switch (msg.type) {
      case 'register': {
        // Pre-enrollment gate: a server with the recovery-key store
        // wired but no realm-binding yet refuses to register any
        // instance. The only way through is `pair.registerRecoveryKey`
        // via the rpc envelope (also gated below). Once that succeeds,
        // subsequent registers proceed normally.
        if (recoveryKeyCheck && !recoveryKeyCheck.exists()) {
          send(client.ws, {
            type: 'register_error',
            code: 'server_not_enrolled',
            message: 'Server is not encrypted yet. Pair via the extension to enroll a recovery key first.',
          });
          client.ws.close(4001, 'server not enrolled');
          clients.delete(client.ws);
          break;
        }

        const requestedId = (msg.instance_id as string) ?? null;
        const intent = (msg.intent as string | undefined) ?? 'new';
        const replaceOld = msg.replace_old as string | undefined;
        const reportedUserId = msg.user_id as string | undefined;

        // ── Intent: replace ──────────────────────────────────────
        // Atomic swap: revoke replace_old + accept requestedId. This
        // bypasses the maxInstances limit (swap not growth) and drives
        // the "I'm migrating from device A to B" UX. Free-tier users
        // pick this; Pro users pick "add as new" (intent=new) instead.
        if (intent === 'replace') {
          if (!replaceOld) {
            send(client.ws, {
              type: 'register_error',
              code: 'bad_request',
              message: 'intent="replace" requires replace_old',
            });
            client.ws.close(4000, 'bad register');
            clients.delete(client.ws);
            break;
          }
          if (!pairedInstances) {
            send(client.ws, {
              type: 'register_error',
              code: 'not_configured',
              message: 'server has no durable pairing store; cannot process replace',
            });
            client.ws.close(4000, 'bad register');
            clients.delete(client.ws);
            break;
          }
          const oldRow = pairedInstances.get(replaceOld);
          if (!oldRow) {
            send(client.ws, {
              type: 'register_error',
              code: 'not_found',
              message: `replace_old instance ${replaceOld} not found in paired roster`,
            });
            client.ws.close(4000, 'bad register');
            clients.delete(client.ws);
            break;
          }
          if (reportedUserId && oldRow.user_id !== reportedUserId) {
            send(client.ws, {
              type: 'register_error',
              code: 'forbidden',
              message: 'replace_old belongs to a different user',
            });
            client.ws.close(4003, 'forbidden');
            clients.delete(client.ws);
            break;
          }
          // Close old's ws (if any) + revoke durable row + upsert new.
          handle.revokeConnectedInstance(replaceOld);
          pairedInstances.replace({
            old_instance_id: replaceOld,
            new_instance_id: requestedId!,
            user_id: reportedUserId ?? oldRow.user_id,
            new_display_name: (msg.display_name as string) ?? 'unknown',
            // D-156 P10 — the client kind resolved from the verified
            // client token at WS bearer-verify (undefined for legacy /
            // db-less registers, which the store COALESCEs to the prior
            // recorded kind).
            ...(client.client_kind ? { new_kind: client.client_kind } : {}),
          });
          // D-156 follow-on — the replace is an atomic revoke-old + add-new
          // roster mutation, so fan one `pair.list_changed` to every paired
          // client. A single signal suffices: subscribers re-call `pair.list`,
          // and the re-fetched authoritative roster reflects BOTH the old's
          // revocation and the new's addition. `op: 'added'` is the replace's
          // headline (the user is migrating TO this device). Best-effort: a
          // bus throw must not abort the registration the user just completed.
          try {
            pairRosterBus?.emit({ kind: 'pair.list_changed', op: 'added' });
          } catch {
            /* observability-only; never abort the register on emit failure. */
          }
          // Fall through to normal register. No maxInstances check (swap).
        } else {
          // ── Intent: new (or unspecified — default) ─────────────
          // Instance limit check — count registered clients excluding this one.
          if (handle.maxInstances > 0 && requestedId) {
            const registered = [...clients.values()].filter(
              c => c.instance_id && c.instance_id !== requestedId && c.ws !== client.ws,
            );
            if (registered.length >= handle.maxInstances) {
              // Include the user's current paired devices so the UI
              // can render the "new device or replace" picker without
              // a second round-trip. Only populated when the client
              // sent user_id on register AND pairedInstances is wired
              // (durable roster available).
              let devices: Array<{
                instance_id: string;
                display_name: string;
                added_at: number;
                connected: boolean;
              }> | undefined;
              if (pairedInstances && reportedUserId) {
                const active = pairedInstances.listActive(reportedUserId);
                const live = new Set(
                  [...clients.values()]
                    .map((c) => c.instance_id)
                    .filter((id): id is string => !!id),
                );
                devices = active.map((row) => ({
                  instance_id: row.instance_id,
                  display_name: row.display_name,
                  added_at: row.added_at,
                  connected: live.has(row.instance_id),
                }));
              }
              send(client.ws, {
                type: 'instance_limit',
                message: `This server allows ${handle.maxInstances} extension${handle.maxInstances > 1 ? 's' : ''}. `
                  + 'Run your own recued instance to connect more devices, or upgrade to Pro for hosted multi-device sync.',
                max: handle.maxInstances,
                current: registered.length,
                ...(devices ? { devices } : {}),
              });
              client.ws.close(4001, 'instance limit');
              clients.delete(client.ws);
              break;
            }
          }
        }

        // Reject if the instance_id was revoked earlier — the device
        // must be re-registered as a new instance (user goes through
        // the pair flow again). Skipped for intent=replace since we
        // just upserted (revoked_at=NULL) in the replace transaction.
        if (intent !== 'replace' && pairedInstances && pairedInstances.isRevoked(requestedId!)) {
          send(client.ws, {
            type: 'instance_revoked',
            instance_id: requestedId,
            reason: 'this instance was previously revoked; re-pair as a new device',
          });
          client.ws.close(4003, 'instance revoked');
          clients.delete(client.ws);
          break;
        }

        client.instance_id = requestedId;
        client.display_name = (msg.display_name as string) ?? 'unknown';
        if (reportedUserId) {
          client.user_id = reportedUserId;
          pairedUserId ??= reportedUserId;
        }

        // Upsert durable row so `pair.list` can show this device even
        // when it's offline. Only when user_id is known (anonymous /
        // free-tier without sign-in has no durable roster). Skipped
        // for intent=replace since the replace() transaction already
        // did an upsert atomically with the revoke.
        if (intent !== 'replace' && pairedInstances && client.user_id && client.instance_id) {
          pairedInstances.addOrRefresh({
            instance_id: client.instance_id,
            user_id: client.user_id,
            display_name: client.display_name,
            // D-156 P10 — kind from the verified client token (see replace
            // above). A registering extension/bridge carries 'bridge';
            // absent → store keeps any prior recorded kind (COALESCE).
            ...(client.client_kind ? { kind: client.client_kind } : {}),
          });
        }

        send(client.ws, {
          type: 'registered',
          instance_id: client.instance_id,
          // Send back the server's stable id so the ext can persist it
          // in its SyncConfig + advertise it in future heartbeats as
          // `srv_id`. Omitted when the server wasn't given one (legacy
          // callers / tests that don't care about identity).
          ...(serverId ? { server_id: serverId } : {}),
        });
        break;
      }

      case 'ping':
        send(client.ws, { type: 'pong' });
        break;

      case 'pong':
        // Client responded to our ping — connection alive
        break;

      case 'ai_response': {
        const delegation = aiDelegations.get(msg.request_id as string);
        if (delegation) {
          aiDelegations.delete(msg.request_id as string); // also clears timeout
          if (msg.error) {
            delegation.reject(new Error(msg.error as string));
          } else {
            delegation.resolve(msg.result);
          }
        }
        break;
      }

      case 'chat_claim': {
        const cd = chatDelegations.get(msg.request_id as string);
        if (!cd || cd.claimed_ws) {
          // Already claimed or unknown — reject this claimer. Gate on
          // `claimed_ws` (the winning connection) not `claimed_by` — a
          // null instance_id claimer would otherwise leave the claim-once
          // gate falsy and admit a second claimer.
          send(client.ws, { type: 'chat_revoked', request_id: msg.request_id });
          break;
        }
        // First claim wins — bind the result to THIS connection.
        cd.claimed_by = client.instance_id;
        cd.claimed_ws = client.ws;
        // Confirm to winner with full input
        send(client.ws, { type: 'chat_confirmed', request_id: cd.request_id, slug: cd.slug, input: cd.input });
        // Revoke all others
        for (const other of clients.values()) {
          if (other.ws !== client.ws) {
            send(other.ws, { type: 'chat_revoked', request_id: cd.request_id });
          }
        }
        break;
      }

      case 'chat_result': {
        const cd = chatDelegations.get(msg.request_id as string);
        // Only the WINNING claimant's connection may submit the result.
        // Without this, any connected client (a losing claimant, or one that
        // never received the broadcast) could resolve the delegation by
        // request_id with attacker-controlled output — the chat analog of the
        // D-169 bridge `canResolve` ownership check. Drop silently on
        // mismatch (incl. before any claim, when `claimed_ws` is null) — same
        // posture as an unknown request_id.
        if (cd && cd.claimed_ws === client.ws) {
          chatDelegations.delete(msg.request_id as string); // also clears timeout
          if (msg.error) {
            cd.reject(new Error(msg.error as string));
          } else {
            cd.resolve(msg.result);
          }
        }
        break;
      }

      // Response to a server-initiated kernel-recipe delegation (server
      // asked the paired extension to run a kernel recipe — typically
      // run-ingredient dispatched by an MCP per-ingredient tool call).
      case 'kernel_recipe_response': {
        const kd = kernelRecipeDelegations.get(msg.request_id as string);
        if (kd) {
          kernelRecipeDelegations.delete(msg.request_id as string); // also clears timeout
          if (msg.error) {
            kd.reject(new Error(msg.error as string));
          } else {
            kd.resolve(msg.result);
          }
        }
        break;
      }

      // Response to a server-initiated ingredient-catalog query.
      case 'ingredients_response': {
        const iq = ingredientQueries.get(msg.request_id as string);
        if (iq) {
          ingredientQueries.delete(msg.request_id as string); // also clears timeout
          if (msg.error) {
            iq.reject(new Error(msg.error as string));
          } else {
            iq.resolve((msg.ingredients as Array<{ slug: string; manifest: unknown }>) ?? []);
          }
        }
        break;
      }

      // Response to a server-initiated peer-cache get. Mirrors the
      // existing ext→srv cache.get RPC but inverted: when the server's
      // L2 store misses, it asks the paired extension whether it holds
      // the entry. Enables the warehouse → extension fast-path
      // (server-precomputed entries surface instantly in the sidebar).
      case 'cache_get_response': {
        const cr = cacheGetRequests.get(msg.request_id as string);
        if (cr) {
          cacheGetRequests.delete(msg.request_id as string); // also clears timeout
          if (msg.error) {
            cr.reject(new Error(msg.error as string));
          } else {
            cr.resolve((msg.entry as import('@recued/cache').CacheEntry | null) ?? null);
          }
        }
        break;
      }

      // Generic rpc envelope — extension-initiated method calls. Replaces
      // separate per-endpoint message types (execute_request, etc.). The
      // handler runs async; the message loop never blocks on a slow rpc.
      case 'rpc': {
        // Terminal close flips this before taking the active-dispatch snapshot.
        // The event loop cannot interleave another message between those two
        // synchronous operations, so every admitted task is owned by close().
        if (!rpcAdmissionOpen) break;
        const requestId = msg.request_id as string;
        if (!requestId) break; // can't correlate a reply, drop silently
        const method = msg.method as string;
        const args = (msg.args as Record<string, unknown>) ?? {};

        const socketInFlight = activeRpcDispatchCountBySocket.get(client.ws) ?? 0;
        if (
          socketInFlight >= RPC_WS_MAX_IN_FLIGHT_PER_CLIENT
          || activeRpcDispatches.size >= RPC_WS_MAX_IN_FLIGHT_GLOBAL
        ) {
          send(client.ws, {
            type: 'rpc_result',
            request_id: requestId,
            error: {
              code: 'rpc_overloaded',
              message: 'Too many RPC calls are already running; retry shortly.',
            },
          });
          break;
        }

        // Pre-enrollment gate (mirror of the register-message gate):
        // until the realm has a recovery-key check enrolled, the only
        // methods we accept are enrollment + the M5 S3 pre-pair restore
        // onboarding set (`PRE_ENROLLMENT_ALLOWED_RPC_METHODS`). Everything
        // else returns `server_not_enrolled` so callers know to enroll first
        // instead of guessing at obscure errors.
        if (
          recoveryKeyCheck && !recoveryKeyCheck.exists()
          && !PRE_ENROLLMENT_ALLOWED_RPC_METHODS.has(method)
        ) {
          send(client.ws, {
            type: 'rpc_result',
            request_id: requestId,
            error: {
              code: 'server_not_enrolled',
              message: 'Server is not encrypted yet. Send pair.registerRecoveryKey first.',
            },
          });
          break;
        }

        const task = (async () => {
          try {
            // D-151 follow-on — resolve the caller's paired-instance
            // identity for the rpc gate layer ONLY. Webclients are
            // bearer-only and never `register`, so their `instance_id` is
            // null; their identity lives in `token_instance_id` (derived
            // from the verified token + revoke-checked at upgrade). Hand
            // the gated handlers a shallow copy with the resolved id so
            // every `requireCallerInstance` gate (reception / hostname /
            // timeline / inbox / exposure / …) accepts any paired client.
            // The copy leaves the live `clients` map entry untouched, so
            // every `instance_id`-keyed routing/limit path (delegateAi,
            // peerCache*, server-heartbeat, maxInstances) still sees the
            // original null for webclients — bridge-only frames never
            // mis-route to a webclient, and webclient tabs don't count
            // against the extension limit. Bridges/extensions (real
            // `instance_id`) pass through unchanged (no copy).
            const gatedInstanceId = resolveGatedClientInstanceId(client);
            const gatedClient =
              gatedInstanceId === client.instance_id
                ? client
                : { ...client, instance_id: gatedInstanceId };
            const result = await dispatchRpc(method, args, gatedClient);
            if (result.ok) {
              send(client.ws, { type: 'rpc_result', request_id: requestId, result: result.body });
            } else {
              send(client.ws, { type: 'rpc_result', request_id: requestId, error: result.error });
            }
          } catch (e) {
            send(client.ws, {
              type: 'rpc_result',
              request_id: requestId,
              error: { code: 'rpc_error', message: e instanceof Error ? e.message : String(e) },
            });
          }
        })();
        activeRpcDispatches.add(task);
        activeRpcDispatchCountBySocket.set(client.ws, socketInFlight + 1);
        const clear = (): void => {
          activeRpcDispatches.delete(task);
          const remaining = (activeRpcDispatchCountBySocket.get(client.ws) ?? 1) - 1;
          if (remaining > 0) activeRpcDispatchCountBySocket.set(client.ws, remaining);
          else activeRpcDispatchCountBySocket.delete(client.ws);
        };
        void task.then(clear, clear);
        break;
      }
    }
  };

  const send = (ws: any, data: unknown): void => {
    sendBoundedWsJson(ws, data, WS_OPEN);
  };

  handle = {
    maxInstances: 1, // Free tier: 1 extension. Self-hosters change this freely (AGPL).

    clientCount() {
      return clients.size;
    },

    listConnectedInstances() {
      const out: Array<{ instance_id: string; name: string; connected_at: number }> = [];
      for (const c of clients.values()) {
        if (!c.instance_id) continue;
        out.push({
          instance_id: c.instance_id,
          name: c.display_name,
          connected_at: Math.floor(c.connected_at / 1000),
        });
      }
      return out;
    },

    listConnectedPairedInstances() {
      // D-156 follow-on — paired identity = explicit `instance_id`
      // (extension/bridge) ?? `token_instance_id` (bearer-only webclient).
      // A webclient keeps a null `instance_id` so it never appears in
      // `listConnectedInstances`; fall back to the token-derived id so its
      // durable row's `connected` column reflects the live socket.
      const out: Array<{ instance_id: string; connected_at: number }> = [];
      for (const c of clients.values()) {
        const id = c.instance_id ?? c.token_instance_id ?? null;
        if (!id) continue;
        out.push({
          instance_id: id,
          connected_at: Math.floor(c.connected_at / 1000),
        });
      }
      return out;
    },

    getPairedUserId() {
      return pairedUserId;
    },

    revokeConnectedInstance(instance_id) {
      for (const [ws, client] of clients) {
        // D-156 follow-on — match a bearer-only webclient too (null
        // `instance_id`, paired identity in `token_instance_id`) so a
        // `pair.revoke` against a webclient's durable row also closes its
        // live socket (4003 → the webclient's reauth/re-pair path). An
        // extension's `token_instance_id` (when derived) equals its
        // `instance_id`, so the fallback is a no-op for it.
        const liveId = client.instance_id ?? client.token_instance_id ?? null;
        if (liveId !== instance_id) continue;
        // Snapshot the durable `client_tokens.token_id` (D-148 § A.2.1)
        // BEFORE the close + delete so the caller can stamp
        // `pair_revoke.detail.client_token_id` without racing the
        // socket teardown. Populated by the structured-bearer upgrade
        // path that flips WS auth to `clientTokens.verify`; undefined
        // only for db-less compositions that did not wire
        // `clientTokens`, in which case the audit stamp is omitted so
        // the join stays clean.
        const client_token_id = client.client_token_id;
        // Tell the ext why — on-close handler reads this to wipe local
        // vault + installed state so a revoked device can't linger with
        // cached secrets. Close code 4003 chosen to distinguish from
        // instance_limit (4001) and generic close.
        send(client.ws, {
          type: 'instance_revoked',
          instance_id,
          at: Math.floor(Date.now() / 1000),
        });
        try { client.ws.close(4003, 'instance revoked'); } catch { /* already closed */ }
        clients.delete(ws);
        return {
          revoked: true,
          ...(client_token_id !== undefined ? { client_token_id } : {}),
        };
      }
      return { revoked: false };
    },

    revokeAllConnectedInstances() {
      // D-148 § A.6.5 — sweep every connected client with the same
      // wire semantics `revokeConnectedInstance` emits for the per-
      // instance case: `instance_revoked` message + close code 4003.
      // The paired-instances row was already revoked by the rotation
      // engine's `revokeAllPairedClients` hook on the DB side; this
      // method handles the WS-layer fan-out. Iterating `[...clients]`
      // snapshots the Map so the `clients.delete(ws)` mutation inside
      // the loop doesn't invalidate the iterator.
      let count = 0;
      const at = Math.floor(Date.now() / 1000);
      for (const [ws, client] of [...clients]) {
        if (!client.instance_id) {
          // Pre-register clients haven't claimed an instance_id yet —
          // skip the `instance_revoked` message (which the receiver
          // keys on `instance_id`) but still close the socket; there's
          // no pair state to wipe.
          try { client.ws.close(4003, 'instance revoked'); } catch { /* already closed */ }
          clients.delete(ws);
          count += 1;
          continue;
        }
        try {
          send(client.ws, {
            type: 'instance_revoked',
            instance_id: client.instance_id,
            at,
          });
        } catch { /* socket may already be in failing state */ }
        try { client.ws.close(4003, 'instance revoked'); } catch { /* already closed */ }
        clients.delete(ws);
        count += 1;
      }
      return count;
    },

    closeAllForWsLockout(reason) {
      // D-148 W3.FU + spec § A.6.6 — graceful drain on `/ws` lockout.
      // Distinct close code (4004 = `ws path disabled`) so the client
      // can tell this apart from `instance_revoked` (4003): a `4004` is
      // a transient path disable + the client should NOT wipe its
      // vault, just back off + retry connect after the operator
      // re-enables /ws. Pre-close ws_lockout notification gives the
      // renderer a millisecond head-start to show the "server unreach-
      // able" surface before the socket actually closes.
      let count = 0;
      const at = Math.floor(Date.now() / 1000);
      for (const [ws, client] of [...clients]) {
        try {
          send(client.ws, { type: 'ws_lockout', reason, at });
        } catch { /* socket may already be in failing state */ }
        try { client.ws.close(4004, 'ws path disabled'); } catch { /* already closed */ }
        clients.delete(ws);
        count += 1;
      }
      return count;
    },

    async delegateAi(slug, input, timeoutMs = 60_000) {
      // Find a connected client to delegate to
      const client = [...clients.values()].find(c => c.instance_id);
      if (!client) {
        throw new Error('No extension connected — cannot delegate AI call');
      }

      const request_id = `ai-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

      return new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          aiDelegations.delete(request_id);
          reject(new Error(`AI delegation timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        aiDelegations.set(request_id, { request_id, resolve, reject, timeout });
        send(client.ws, { type: 'ai_request', request_id, slug, input });
      });
    },

    async delegateChat(slug, input, timeoutMs = 120_000) {
      const available = [...clients.values()].filter(c => c.instance_id);
      if (available.length === 0) {
        throw new Error('No extension connected — cannot delegate chat ingredient');
      }

      const request_id = `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

      return new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          chatDelegations.delete(request_id);
          reject(new Error(`Chat delegation timed out after ${timeoutMs}ms — no extension claimed or completed`));
        }, timeoutMs);

        chatDelegations.set(request_id, {
          request_id, slug, input,
          claimed_by: null,
          claimed_ws: null,
          resolve, reject, timeout,
        });

        // Broadcast to all connected clients (lightweight — no full input yet)
        for (const client of available) {
          send(client.ws, { type: 'chat_broadcast', request_id, slug });
        }
      });
    },

    async listExtensionIngredients(timeoutMs = 8_000) {
      const client = [...clients.values()].find((c) => c.instance_id);
      if (!client) return null;
      const request_id = `ing-list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      return new Promise<Array<{ slug: string; manifest: unknown }> | null>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ingredientQueries.delete(request_id);
          // Timeout → treat as "extension offline" for catalog purposes.
          resolve(null);
        }, timeoutMs);
        ingredientQueries.set(request_id, {
          resolve: (ings) => resolve(ings),
          reject: (err) => reject(err),
          timeout,
        });
        send(client.ws, { type: 'ingredients_query', request_id });
      });
    },

    async runKernelRecipeOnExtension(recipe_id, config, timeoutMs = 120_000) {
      const client = [...clients.values()].find((c) => c.instance_id);
      if (!client) {
        throw new Error('No extension connected — cannot dispatch kernel recipe');
      }
      const request_id = `krn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      return new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          kernelRecipeDelegations.delete(request_id);
          reject(new Error(`Kernel recipe delegation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        kernelRecipeDelegations.set(request_id, { resolve, reject, timeout });
        send(client.ws, { type: 'kernel_recipe_request', request_id, recipe_id, config });
      });
    },

    async peerCacheGet(key, timeoutMs = 8_000) {
      // Only a BRIDGE can serve the ext cache protocol (`cache_get_request`
      // → `cache_get_response`); webclients / CLI / harness clients register
      // with an instance_id too but never answer, so targeting them turns
      // every cold cache miss into a full-timeout stall. No bridge online →
      // null, peer-wrapper degrades to local-only.
      const client = [...clients.values()].find(
        (c) => c.instance_id && c.client_kind === 'bridge',
      );
      if (!client) return null;
      const request_id = `cg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      return new Promise<import('@recued/cache').CacheEntry | null>((resolve) => {
        const timeout = setTimeout(() => {
          cacheGetRequests.delete(request_id);
          // Timeout is a miss, not an error — peer-wrapper swallows errors anyway.
          resolve(null);
        }, timeoutMs);
        cacheGetRequests.set(request_id, {
          resolve: (entry) => resolve(entry),
          // Errors surface as null too, so peer-wrapper's catch doesn't
          // have to branch: a misbehaving extension never breaks local reads.
          reject: () => resolve(null),
          timeout,
        });
        send(client.ws, { type: 'cache_get_request', request_id, key });
      });
    },

    peerCachePut(entries) {
      if (entries.length === 0) return;
      for (const client of clients.values()) {
        if (!client.instance_id) continue;
        // Per-peer L2 filter: strip step entries from broadcasts
        // targeting any ext that has toggled `cache.sync_l2=false`.
        // Other categories still ship — matches the narrow pref scope.
        const prefs = peerPrefsFor(client);
        const payload = getPref(prefs, 'cache.sync_l2')
          ? entries
          : entries.filter((e) => e.category !== 'step');
        if (payload.length === 0) continue;
        send(client.ws, { type: 'cache_put_request', entries: payload });
      }
    },

    // Phase G (D-109) — push the server's own runtime state to every
    // PAIRED client. The ext SW decodes + caches + broadcasts to
    // popup / sidebar pill listeners; the webclient consumes it as a
    // liveness signal (a stalled-server half-open detector — Tier 3).
    // No filtering / no ack — this is ambient status info, a dropped
    // push shows as a stale pill / a stalled connection-status chip.
    //
    // `resolveGatedClientInstanceId` is the established "does this
    // connection carry a paired-instance identity" resolver: a registered
    // extension/bridge keeps its explicit `instance_id`; a bearer-only
    // webclient (which never `register`s, so its map `instance_id` stays
    // null) falls back to its token-derived `token_instance_id`. null →
    // an unpaired pre-enrollment connection, skipped. Reusing it (vs the
    // bridge-only frames' strict `instance_id`-only gate) is what reaches
    // webclients — without the fallback the whole feature was dead for them.
    broadcastServerHeartbeat(payload) {
      for (const client of clients.values()) {
        if (resolveGatedClientInstanceId(client) === null) continue;
        send(client.ws, { type: 'server_heartbeat', payload });
      }
    },

    ...(bridgeDispatcher ? { bridgeDispatcher } : {}),

    close() {
      if (closePromise) return closePromise;
      // Close every admission door before snapshotting the tasks below. Work
      // admitted before these assignments is already in an owned Set; work
      // observed after them is rejected/dropped before dispatch.
      upgradeAdmissionOpen = false;
      rpcAdmissionOpen = false;
      dataSocketAdmissionOpen = false;
      for (const { ws } of clients.values()) {
        // This is terminal server teardown, not the user-visible `/ws`
        // lockout ceremony (`closeAllForWsLockout`). A graceful `ws.close()`
        // waits up to the library's 30-second close timeout when a peer never
        // replies, while the lifecycle close_ws step has a much shorter hard
        // deadline. Terminate the transport so one uncooperative paired client
        // cannot abort shutdown, restart, or online-restore drain.
        try {
          if (typeof ws.terminate === 'function') ws.terminate();
          else ws.close();
        } catch { /* already closed */ }
      }
      clients.clear();
      // Reject-all on the four delegation maps whose callers expect an
      // error on transport teardown. Fixes a pre-existing bug where
      // `kernelRecipeDelegations` and `ingredientQueries` leaked their
      // timeouts + left callers hanging on shutdown — now they get a
      // concrete "Server shutting down" error like the other two.
      aiDelegations.clear('Server shutting down');
      chatDelegations.clear('Server shutting down');
      kernelRecipeDelegations.clear('Server shutting down');
      ingredientQueries.clear('Server shutting down');
      // D-169 P0 follow-on — drain pending bridge dispatches so callers
      // don't hang up to ~65s on shutdown (Codex 2026-05-28 Angle 2
      // fold). Each pending awaitResult resolves to null — the same
      // shape callers see on timeout.
      bridgeResultListener?.clear?.();
      // cacheGetRequests is the odd one out: the peer-cache contract
      // treats "no answer" as a cache miss, not an error. Resolve each
      // pending fetch with `null` so warehouse fallbacks still succeed
      // when the server is spinning down.
      for (const d of cacheGetRequests.values()) {
        clearTimeout(d.timeout);
        d.resolve(null);
      }
      wss.close();
      // D-172 — tear down the dedicated upload data socket server too. Its
      // sockets aren't in the local `clients` map, and `WebSocketServer.close()`
      // only stops the listener (it does NOT terminate live connections), so an
      // in-flight upload would keep accepting chunks past shutdown. Terminate
      // each tracked socket first (`uploadWss.clients` is the `ws` lib's own
      // tracking Set, populated by `handleUpgrade`), then close the server
      // (Codex 2026-06-24 fold).
      if (uploadWss) {
        for (const s of uploadWss.clients as Set<{ terminate?: () => void }>) {
          try { s.terminate?.(); } catch { /* already gone */ }
        }
        uploadWss.close();
      }
      // M4 — same teardown for the dedicated download data socket server: its
      // sockets aren't in `clients` either, and an in-flight stream would
      // otherwise survive close() (keeping a read stream / fd alive). Terminate
      // each tracked socket — which also unwinds the pump (the send callback
      // errors → the read stream is destroyed) — then close the listener.
      if (downloadWss) {
        for (const s of downloadWss.clients as Set<{ terminate?: () => void }>) {
          try { s.terminate?.(); } catch { /* already gone */ }
        }
        downloadWss.close();
      }
      // M4b.1 — same teardown for the dedicated archive-upload data socket
      // server: its sockets aren't in `clients`, and an in-flight upload would
      // otherwise keep accepting chunks past shutdown.
      if (archiveUploadWss) {
        for (const s of archiveUploadWss.clients as Set<{ terminate?: () => void }>) {
          try { s.terminate?.(); } catch { /* already gone */ }
        }
        archiveUploadWss.close();
      }
      // Handler errors are normalized/contained by their dispatch wrappers;
      // allSettled is still deliberate defense-in-depth so teardown itself
      // never rejects merely because a future reply/error path regresses.
      closePromise = Promise.allSettled([
        ...activeRpcDispatches,
        ...activeDataSocketDispatches,
        ...activeUpgradeVerifications,
      ]).then(() => undefined);
      return closePromise;
    },
  };

  return { handle, upgrade: upgradeHandler };
};

/** Extract bearer token from Authorization header or ?token= query param.
 *
 *  DOCUMENT-AND-DEFER (Codex WS hunt 2026-06-19): the `?token=` query fallback
 *  is necessary because the browser WebSocket API can't set request headers,
 *  but a bearer in the URL can leak via reverse-proxy / access / crash logs +
 *  browser URL telemetry. The header form is preferred when available (non-
 *  browser clients use it). The clean hardening is to carry the token in the
 *  `Sec-WebSocket-Protocol` subprotocol (browsers CAN set that) instead of the
 *  query string — a client+server change, owner-gated. Lower-bounded today by:
 *  the bearer is over TLS in production, and a leaked bearer is independently
 *  revocable via `pair.revoke` (which now also kills the client token). */
const extractRealm = (req: IncomingMessage): string | null => {
  // 1. Authorization header — non-browser clients (CLI, server-to-server).
  const header = req.headers.authorization;
  if (header) {
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim() || null;
  }
  // 2. `Sec-WebSocket-Protocol` — the browser carrier. A browser cannot set
  //    request headers on `new WebSocket(url, protocols)`, and this is the one
  //    header the constructor DOES reach. See `@recued/contracts`
  //    `ws-subprotocol.ts` for the encoding and why it is base64url.
  const bySubprotocol = decodeBearerSubprotocol(req.headers['sec-websocket-protocol']);
  if (bySubprotocol) return bySubprotocol;
  // 3. `?token=` — LEGACY, and the reason the carrier above exists. A URL is
  //    the worst place for a secret: reverse-proxy and access logs, crash
  //    reports and browser URL telemetry all capture it, none are covered by
  //    TLS, and `client_tokens` has NO expiry column — so a bearer that reached
  //    a log stays valid until somebody revokes it by hand.
  //
  //    ⚠ STILL ACCEPTED ON PURPOSE, AND NOT YET REMOVABLE. A PWA serves its
  //    cached bundle before it replaces itself, so browsers are still running
  //    webclient builds that send this form, and an extension updates on its
  //    own schedule. Removing it now would 401 every un-upgraded client with no
  //    way for them to tell why. Retire it once no shipped client emits it —
  //    the check is that no `token=` remains in `apps/webclient/src/realtime/`
  //    or `apps/bridge/src/boot/`, plus a deliberate wait for caches to turn
  //    over. Until then this is a transition, and the bearer is only as safe as
  //    the oldest client still using it.
  const url = req.url ?? '';
  const qmark = url.indexOf('?');
  if (qmark !== -1) {
    const params = new URLSearchParams(url.slice(qmark + 1));
    const token = params.get('token');
    if (token) return token;
  }
  return null;
};

/** Which subprotocol the server selects, and echoes back in the handshake.
 *
 *  ⛔ NEVER THE BEARER. `ws`'s default selection is
 *  `protocols.values().next().value` — whatever the CLIENT offered first — and
 *  the selected value goes back in the `Sec-WebSocket-Protocol` RESPONSE header.
 *  A client that offered the bearer first would therefore have its secret echoed
 *  into a response header, i.e. straight back into the logs this change exists
 *  to keep it out of. Our clients offer `recued.v1` first, but that is a
 *  client-side guarantee and the server must not depend on one.
 *
 *  Returning `false` means "select nothing", which RFC 6455 permits and browsers
 *  accept — the right answer for a client that offered only a bearer. */
export const selectWsSubprotocol = (
  offered: ReadonlySet<string> | ReadonlyArray<string>,
): string | false => {
  for (const value of offered) {
    if (value === WS_VERSION_SUBPROTOCOL) return WS_VERSION_SUBPROTOCOL;
  }
  return false;
};

/** D-148 § A.2.1 — canonical length of `client_tokens.token_id`
 *  produced by `generateTokenId` in `pairing/client-tokens.ts`
 *  (12 random bytes → base64 with trailing `=` padding stripped → 16
 *  chars). Pinned as a constant here so the WS upgrade pre-check can
 *  reject malformed structured bearers cheaply BEFORE invoking
 *  `clientTokens.verify` (which runs an Argon2id hash; cheap pre-
 *  rejection closes a DoS amplification vector documented in Codex
 *  2026-05-17 P1 #2). If `generateTokenId` ever widens its output the
 *  constant + the producer must move together. */
export const STRUCTURED_BEARER_TOKEN_ID_LEN = 16;

/** D-148 § A.2.1 — canonical length of the cleartext bearer produced
 *  by `generateBearerToken` (32 random bytes → standard base64 with
 *  `=` padding → 44 chars). Same DoS-prevention rationale as
 *  `STRUCTURED_BEARER_TOKEN_ID_LEN`. */
export const STRUCTURED_BEARER_LEN = 44;

/** D-148 § A.2.1 — structured bearer parsing for WS-handshake
 *  bearer-validation tightening. The structured shape is
 *  `<token_id>.<bearer>` where `<token_id>` is the public
 *  `client_tokens.token_id` (16-char base64; `STRUCTURED_BEARER_TOKEN_ID_LEN`)
 *  and `<bearer>` is the cleartext bearer (44-char base64 with `=`
 *  padding; `STRUCTURED_BEARER_LEN`) issued by `pair.consume`. Both
 *  pieces are standard base64 (no `.`), so a single `.` separator is
 *  unambiguous.
 *
 *  Returns:
 *    - `{ token_id, bearer }` when the raw realm matches the canonical
 *      structured shape (split on FIRST `.`; token_id is exactly
 *      `STRUCTURED_BEARER_TOKEN_ID_LEN` chars; bearer is exactly
 *      `STRUCTURED_BEARER_LEN` chars).
 *    - `null` when the raw realm is not canonical structured shape
 *      (no `.`, or either half empty / off-canonical-length) — callers
 *      with `clientTokens` wired reject; db-less callers may keep the
 *      legacy path.
 *
 *  Length pre-check is the DoS-mitigation surface (Codex 2026-05-17
 *  P1 #2). An attacker who probes `/ws?token=a.b` would previously
 *  reach `clientTokens.verify` (Argon2id, t=2, m=64 MiB → tens-of-ms
 *  CPU per attempt) for every malformed request. With the canonical-
 *  length pre-check, only requests whose token_id + bearer are
 *  exactly the right size pay the Argon2id cost — defenders pay the
 *  CPU only for shaped-malformed-bearer attacks, which still pay the
 *  legitimate-receiver's verify cost but cannot amplify beyond it.
 *
 *  Constant-time discipline within the canonical-length set is
 *  preserved by `clientTokens.verify`'s dummy-hash path (unknown
 *  token_id runs the same Argon2id call as a real one). The
 *  length pre-check sits OUTSIDE that constant-time region — by
 *  design: rejecting non-canonical shapes synchronously is exactly
 *  the goal, and the lengths are public (encoded in the issuance
 *  substrate). Splitting on FIRST `.` (rather than last) matches the
 *  substrate's emission convention; a future structured bearer that
 *  embeds additional `.`-delimited fields would extend the bearer
 *  half, not the token_id half. */
export const parseStructuredBearer = (
  raw: string,
): { token_id: string; bearer: string } | null => {
  const idx = raw.indexOf('.');
  if (idx <= 0) return null;
  const token_id = raw.slice(0, idx);
  const bearer = raw.slice(idx + 1);
  if (token_id.length !== STRUCTURED_BEARER_TOKEN_ID_LEN) return null;
  if (bearer.length !== STRUCTURED_BEARER_LEN) return null;
  return { token_id, bearer };
};
