import { dirname, join, resolve } from 'node:path';

import type Database from 'better-sqlite3';
import type { CacheStore } from '@recued/cache';
import type { ServerBundle } from '@recued/crypto';
import type { InternalToolRegistry, ConnectionRow, IngredientManifest } from '@recued/contracts';
import {
  D165_CONTRACT_SCHEMA,
  WEBHOOK_PROFILE_REGISTRY,
  setVendorAliasRegistryResolver,
} from '@recued/contracts';
import type { LLMConfig } from '@recued/llm';
import { executeEmbedding } from '@recued/llm';
import { createMemoryEmbedder } from '../memory-embedder.js';
import type { AuditLogStore, Collection } from '@recued/storage';
import type { MemoryRedactionRecord } from '../memory-rpc-handler.js';
import { createWarehouseEventBus, type WarehouseEventBus } from '@recued/warehouse-events';

import type { AuthDeps } from '../auth-handler.js';
import type { CacheRpcDeps } from '../cache-rpc-handler.js';
import type { CollectionRegistry } from '../collections/registry.js';
import {
  composeContactStore,
  type ContactStoreBundle,
} from '../composition/bin/wire-contact-store.js';
import {
  composeHousekeepingStores,
  type HousekeepingStores,
} from '../composition/bin/wire-housekeeping-substrate.js';
import {
  composeLlmSubstrate,
  type LlmSubstrate,
} from '../composition/bin/wire-llm-substrate.js';
import {
  composeChatOrchestrator,
  type ChatOrchestratorBundle,
} from '../composition/bin/wire-chat-orchestrator.js';
import type { ExecuteHandlerDeps } from '../execute-handler.js';
import type { EventBus } from '../events/bus.js';
import {
  bridgeEnrichmentCascade,
  bridgeWarehouseEvents,
} from '../events/emit-sites.js';
import {
  createHousekeepingInvalidator,
  listHousekeepingTasks,
  type HousekeepingConfigStore,
  type HousekeepingStateStore,
  type LlmResultCacheStore,
  type TrustStore,
  type TunableParamsStore,
} from '../housekeeping/index.js';
import { createBundleStore, type BundleStore } from '../bundle-store.js';
import {
  createServerBundleStore,
  type ServerBundleStore,
} from '../server-bundle-store.js';
import { createKeyManager, type KeyManager } from '../key-manager.js';
import { makeConnectionCredentialPersistFailureSink } from '../connection-credential-persist-failure.js';
import { createVaultStateBus, type VaultStateBus } from '../vault-state-bus.js';
import type { PairedInstancesStore } from '../paired-instances-store.js';
import {
  createClientTokenStore,
  type ClientTokenStore,
} from '../pairing/client-tokens.js';
import type { RecipeStore } from '../recipe-store.js';
import type { AnnotationRpcDeps } from '../annotation-handler.js';
import type { SharedRpcDeps } from '../shared-handler.js';
import { createServerStateStore, type ServerStateStore } from '../server-state.js';
import {
  createEncryptedBlobStore,
  createSQLiteCacheStore,
  type BlobStore,
} from '../storage/index.js';
import { createSQLiteCollection } from '../sqlite-collection.js';
import {
  createUserMemoryStore,
  type UserMemoryRow,
  type UserMemoryStore,
} from '../user-memory-store.js';
import { createAnnotationStore, type AnnotationStore } from '../storage/annotation-store.js';
import type { ChatOrchestrator } from '../chat-orchestrator.js';
import type { SessionForwardedSenderIndex } from '../chat-forwarded-sender-index.js';
import type { ChatRpcDeps } from '../chat-handler.js';
import type {
  ExecutionCaseLifecycle,
} from '../chat-execution-case-tools.js';
import {
  currentExecutionCaseVerificationContext,
} from '../execution-case-verification-context.js';
import type { ChatConnectionMcpStore } from '../storage/chat-connection-mcp-store.js';
import type { ChatInboundTokenStore } from '../storage/chat-inbound-token-store.js';
import type { ChatStore } from '../storage/chat-store.js';
import type { ChatToolCatalogStore } from '../storage/chat-tool-catalog-store.js';
import {
  createConnectionStore,
  type ConnectionStoreSqlite,
} from '../storage/connection-store.js';
import {
  createContractGrantStore,
  wireConnectionGrantCleanup,
  type ContractGrantStore,
} from '../storage/contract-grant-store.js';
import {
  createConnectionCatalogBindingStore,
  type ConnectionCatalogBindingStore,
} from '../storage/connection-catalog-binding-store.js';
import {
  createContractStore,
  type ContractStore,
} from '../storage/contract-store.js';
import {
  createSellerStore,
  type SellerStore,
} from '../storage/seller-store.js';
import {
  createSellerOrderStore,
  type SellerOrderStore,
} from '../storage/seller-order-store.js';
import {
  createSellerClaimStore,
  type SellerClaimStore,
} from '../storage/seller-claim-store.js';
import {
  createReceptionManageCredentialStore,
  type ReceptionManageCredentialStore,
} from '../storage/reception-manage-credential-store.js';
import {
  createWebhookIngressStore,
  type WebhookIngressStore,
} from '../storage/webhook-ingress-store.js';
import {
  createWebhookDeliveryStore,
  type WebhookDeliveryStore,
} from '../storage/webhook-delivery-store.js';
import {
  createWebhookConsumerStore,
  type WebhookConsumerStore,
} from '../storage/webhook-consumer-store.js';
import { grandfatherPrimitiveGrants, reconcileOwnerGrants } from '../owner-grant-reconcile.js';
import { catalogSlugForConnection } from '../connection-operation-profile-boot.js';
import { createLocalManifestStore } from '../ingredient-authoring/local-manifest-store.js';
import { liveVendorRegistry } from '../connection-convention-families.js';
import type { ContactStore } from '../storage/contact-store.js';
import {
  createEnrichmentCascade,
  type CascadeEngine,
} from '../storage/enrichment-cascade.js';
import {
  createEnrichmentStore,
  type EnrichmentStore,
} from '../storage/enrichment-store.js';
import {
  createCrmRecordMirrorStore,
  ensureCrmRecordMirrorSchema,
  type CrmRecordMirrorStore,
} from '../storage/crm-record-mirror-store.js';
import {
  createExternalContextDependencyRegistry,
  type ExternalContextDependencyRegistry,
} from '../storage/external-context-pulse.js';
import {
  createEngagementCapabilityStore,
  type EngagementCapabilityStore,
} from '../storage/engagement-capability-store.js';
import {
  createEngagementRateControlStore,
  type EngagementRateControlStore,
} from '../storage/engagement-rate-control-store.js';
import {
  createVendorRateGate,
  type VendorRateGate,
} from '../housekeeping/reconciliation/vendor-rate-gate.js';
import {
  createEngagementStore,
  type EngagementStore,
} from '../storage/engagement-store.js';
import { buildEngagementsResolverDeps } from '../engagement-resolver-deps.js';
import { createMailUnionTwinResolver } from '../collections/mail/mail-union-twin-resolver.js';
import type { ContactEngagementsResolveDeps } from '../contact-engagements-rpc-handler.js';
import { createSharedStore, type SharedStore } from '../storage/shared-store.js';
import type { WorkEntityStore } from '../storage/work-entity-store.js';
import {
  createWorkEntitySourceMirrorStore,
  createWorkEntitySourceSyncStateStore,
  ensureWorkEntitySourceSyncStateSchema,
  type WorkEntitySourceMirrorStore,
  type WorkEntitySourceSyncStateStore,
} from '../storage/work-entity-source-mirror.js';
import {
  createWorkEntityEdgeStore,
  ensureWorkEntityEdgeSchema,
  type WorkEntityEdgeStore,
} from '../storage/work-entity-edge-store.js';
import {
  createSourceDependencyEntityStore,
  ensureSourceDependencyEntitySchema,
  type SourceDependencyEntityStore,
} from '../storage/source-dependency-entity-store.js';
import {
  createFileMetaStore,
  ensureFileMetaSchema,
  type FileMetaStore,
} from '../storage/file-meta-store.js';
import type { FileConnectionResolver } from '../file-source-adapters/index.js';
import {
  createFileSourceSyncStateStore,
  ensureFileSourceSyncStateSchema,
  type FileSourceSyncStateStore,
} from '../storage/file-source-sync-state.js';
import { wireFileSourceSync } from '../file-source-sync.js';
import { wireFileSourceBoot } from '../file-source-boot.js';
import { wireContactSourceSync } from '../contact-source-sync.js';
import {
  createContactSourceSyncStateStore,
  ensureContactSourceSyncStateSchema,
  type ContactSourceSyncStateStore,
} from '../storage/contact-source-sync-state.js';
import { wireContactSourceBoot } from '../contact-source-boot.js';
import { buildContactSourceAdapterResolver } from '../contact-source-adapters/index.js';
import { buildFileSourceAdapterResolver } from '../file-source-adapters/index.js';
import type {
  RemoteFileReadDeps,
  RemoteFileByteResolverRegistry,
} from '../collections/file/remote-file-byte-resolver.js';
import { buildRemoteFileByteResolvers } from '../collections/file/remote-byte-resolvers/index.js';
import type { GateRegistry } from '../storage-gates.js';
import type { ServerExecutorConfig } from '../server-executor.js';
import type { SourceMirrorFetchDeps } from '../source-mirror/fetch.js';
import { purgeSourceData } from '../source-mirror/purge.js';
import {
  resolveWorkEntitySourceBinding,
  wireWorkEntitySourceBoot,
} from '../work-entity-source-boot.js';
import {
  createWorkEntitySourceWriteExecutor,
  type WorkEntitySourceWriteExecutor,
  type WorkEntityTargetedReadDeps,
} from '../work-entity-write-executor.js';
import {
  createWorkEntityResolver,
  type WorkEntityResolver,
} from '../work-entity-resolver.js';
import {
  wireCommitmentEvidenceCapture,
  resolveCounterpartyFromContactEmails,
  COMMITMENT_COUNTERPARTY_CANDIDATE_CAP,
  type CommitmentEvidenceRuntime,
} from '../commitment-evidence-capture.js';
import {
  createCommitmentEvidenceLedger,
  type CommitmentEvidenceLedger,
} from '../storage/commitment-evidence-ledger.js';
import { wireMessengerCommitmentFunnel } from '../wire-messenger-commitment-funnel.js';
import {
  createMessageCommitmentLedger,
  type MessageCommitmentLedger,
} from '../storage/message-commitment-ledger.js';

export interface AppContextChatLateBoundGetters {
  getCollectionRegistry: () => CollectionRegistry | undefined;
  getExecutorConfig: () => ServerExecutorConfig | undefined;
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
}

export interface ComposeAppContextOptions {
  db: Database.Database | undefined;
  dbPath: string;
  /** D-212 slice 1 — pre-storage-composed filesystem bundle store. Production
   *  passes this from the boot layer so enrollment discovery no longer depends
   *  on an open database. Tests/direct composers may omit it. */
  serverBundleStore?: ServerBundleStore;
  /** Bundle read by the boot layer before SQLite opens. When provided (even as
   *  null), KeyManager construction consumes this snapshot instead of doing
   *  its initial sidecar read post-storage. Later reads remain live. */
  initialServerBundle?: ServerBundle | null;
  envLlmConfig: LLMConfig | undefined;
  gateRegistry: GateRegistry | undefined;
  auditLog: AuditLogStore | undefined;
  eventBus: EventBus;
  serverInstanceId: string;
  recipeStore: RecipeStore;
  pairedInstances: PairedInstancesStore | undefined;
  workEntityStore: WorkEntityStore | undefined;
  chatLateBound: AppContextChatLateBoundGetters;
}

export interface AppContext extends LlmSubstrate {
  serverState: ServerStateStore | undefined;
  keys: KeyManager | undefined;
  /** Live vault-unlocked predicate. `true` when there is no vault
   *  (db-less / no KeyManager) so non-vault harnesses + the db-less boot
   *  stay un-gated; otherwise `keys.state() === 'unlocked'`. Gates every
   *  autonomous executor (schedules / triggers / auto-run / watches /
   *  housekeeping) so none run — and so none write cache rows — while
   *  the vault is sealed. */
  isVaultUnlocked: () => boolean;
  /** Fan-out of `KeyManager` state transitions (wired into its single
   *  `onStateChange` callback). The autonomous-executor coordinator
   *  subscribes to resume work on unlock. */
  vaultStateBus: VaultStateBus;
  authDeps: AuthDeps | undefined;
  bundleStoreRef: BundleStore | undefined;
  cacheStore: CacheStore | undefined;
  cacheDeps: CacheRpcDeps | undefined;
  cacheBlobs: BlobStore | undefined;
  /** D-198 Slice 2 — the owner-authored `user_memory` store (Memory-lens
   *  writes). Backed by its OWN CAS blob root (`memory_blobs`), isolated from
   *  the cache/shared eviction sweep. Undefined on a db-less boot. */
  userMemoryStore: UserMemoryStore | undefined;
  /** D-198 Slice 4 — the memory redaction-marker store (§5 "forget"). Undefined
   *  on a db-less boot. */
  memoryRedactionStore: Collection<MemoryRedactionRecord> | undefined;
  sharedDeps: SharedRpcDeps | undefined;
  sharedStoreRef: SharedStore | undefined;
  /** The ENCRYPTED `<data>/blobs` CAS root (shared-store + annotation bodies).
   *  Handed to the eviction cascade so it sweeps this root against the shared ∪
   *  annotation reference set — never the separate `cacheBlobs` root. Undefined
   *  on a db-less boot. */
  sharedBlobs: BlobStore | undefined;
  annotationDeps: AnnotationRpcDeps | undefined;
  annotationStoreRef: AnnotationStore | undefined;
  chatStoreRef: ChatStore | undefined;
  chatToolCatalogStoreRef: ChatToolCatalogStore | undefined;
  chatConnectionMcpStoreRef: ChatConnectionMcpStore | undefined;
  chatInboundTokenStoreRef: ChatInboundTokenStore | undefined;
  chatOrchestratorRef: ChatOrchestrator | undefined;
  chatDeps: ChatRpcDeps | undefined;
  executionCaseLifecycle: ExecutionCaseLifecycle | undefined;
  /** D-219 slice 9c — boot hand-off for the owner-facing execution-case offer.
   *  The notification block is composed in the EXECUTION context, after this
   *  one, so the block's owner publishes it here. `undefined` on the db-less /
   *  chat-less path ⇒ no offer is ever raised (silence, not a half-wired ask). */
  publishExecutionCaseOfferNotifier:
    ChatOrchestratorBundle['publishExecutionCaseOfferNotifier'] | undefined;
  /** D-219 — the capture-only argument buffer. Surfaced ONLY so the retention
   *  pruner can bound it: an unread store of raw arguments with no age sweep
   *  would be an archive nobody decided to keep. ⛔ No read path consumes it. */
  executionCaseArgumentStore:
    ChatOrchestratorBundle['executionCaseArgumentStore'] | undefined;
  /** D-219 — the source-corpus retention sweep (reports + observations that
   *  back no case). Surfaced for the pruner family only. */
  executionCaseSourcePruner:
    ChatOrchestratorBundle['executionCaseSourcePruner'] | undefined;
  internalRegistryRef: InternalToolRegistry | undefined;
  /** D-177 N.11 rule 5 (slice D) — the chat bundle's per-session
   *  forwarded-sender candidate index, retained so the execution-context
   *  composer can close `executeDeps.scopedSenderCandidates` over it
   *  (`scopedCandidatesForChannelSession`). `undefined` on the db-less /
   *  chat-less path ⇒ scoped grants never match (fail closed). */
  chatForwardedSenderIndexRef: SessionForwardedSenderIndex | undefined;
  warehouseBus: WarehouseEventBus;
  /** Close warehouse-bus bridge admission and drain every async capture that
   *  was admitted before shutdown. Registered as an emitter lifecycle by the
   *  post-storage runtime. */
  stopWarehouseEventBridges: () => Promise<void>;
  housekeepingConfigRef: HousekeepingConfigStore | undefined;
  housekeepingStateRef: HousekeepingStateStore | undefined;
  housekeepingTrustRef: TrustStore | undefined;
  housekeepingTunableParamsRef: TunableParamsStore | undefined;
  housekeepingLlmResultCacheRef: LlmResultCacheStore | undefined;
  enrichmentStoreRef: EnrichmentStore | undefined;
  /** D-190 — the dedicated CRM record mirror (`crm_record_mirror`). Threaded
   *  beside `enrichmentStoreRef` to the reconciliation harness + webhook funnels
   *  (which upsert one row per CRM record unconditionally) and, at MS3, to the
   *  chat `deal.search` fan-out (which reads it). Undefined on a dbless boot. */
  crmRecordMirrorStoreRef: CrmRecordMirrorStore | undefined;
  /** D-192 file SOURCE family — the `file_meta_ref` metadata mirror. Consumed
   *  by `wireFileSourceSync` and the unified `data.file.*` view; explicit reads
   *  may resolve provider bytes lazily through `getRemoteFileReadDeps` below.
   *  Undefined on a dbless boot. */
  fileMetaStoreRef: FileMetaStore | undefined;
  /** D-192 remote byte-fetch — the file-source connection resolver (decrypt +
   *  lazy OAuth refresh), exposed so the `data.file.read` path can authenticate a
   *  lazy vendor byte fetch the SAME way the mirror walk did. Undefined until the
   *  file-source wiring block runs (needs the meta-store + connection store). */
  fileSourceConnResolverRef: FileConnectionResolver | undefined;
  /** D-192 remote byte-fetch — the ONE shared builder of the `remote`
   *  `FileReadDeps` bundle every file-read channel (recipe `data-file-read`,
   *  ai-* multimodal, mail-send attach, the `data.file.read` pair-RPC) spreads
   *  onto its deps so a `file:remote:*` id lazily fetches the vendor's bytes.
   *  LAZY (reads the file-source refs at call time, both set deep in the boot)
   *  + memoized; returns undefined until the file-source wiring runs (dbless /
   *  no file-source boot → the pre-byte-fetch 501 stays). */
  getRemoteFileReadDeps: () => RemoteFileReadDeps | undefined;
  /** D-192 Fork B hardening — the per-Source file sync-state store; the
   *  `data.file.*` read resolver reads it to stamp `DataFileView.freshness` on a
   *  remote mirror. Undefined on a dbless boot. */
  fileSourceSyncStateRef: FileSourceSyncStateStore | undefined;
  /** D-205 #2c — the per-Source contact sync-state store. The file twin above has
   *  been on the context since D-192; this one was a function-local `let` reachable
   *  only by the sync wire, which is why its health could not be surfaced. Lifting
   *  it here is what lets `contact.source.list` read it. Undefined on a dbless boot. */
  contactSourceSyncStateRef: ContactSourceSyncStateStore | undefined;
  /** D-192 P3b — the Source-identity adapter over `data_task` /
   *  `data_project` plus the per-Source sync cursor/health rows.
   *  Consumed by the post-listener sync wire
   *  (`composeWorkEntitySourceSync`). Undefined on a dbless boot or
   *  without a work-entity store. */
  workEntitySourceMirrorRef: WorkEntitySourceMirrorStore | undefined;
  workEntitySourceSyncStateRef: WorkEntitySourceSyncStateStore | undefined;
  /** D-192 P5 — the `work_entity_edge` store (work-graph relationship
   *  edges). Consumed by the post-listener sync wire (fold-time edge
   *  reconciliation) + the crud handler's `get` decoration. Undefined
   *  on a dbless boot or without a work-entity store. */
  workEntityEdgeStoreRef: WorkEntityEdgeStore | undefined;
  /** D-192 — the container-entity selection store
   *  (`source_dependency_entity`). Consumed by the post-listener sync
   *  wire so `resolve: 'persist'` dependencies actually resolve in
   *  production — the sync cycle both POPULATES selections (lone-option
   *  auto-select) and consumes them for list scoping + the CORE #8b
   *  hydration read args (codex HIGH: the store previously reached only
   *  the boot wire + the write executor, leaving the sync-side persist
   *  paths test-only). Undefined on a dbless boot or without a
   *  work-entity store. */
  workEntitySourceDependencyStoreRef: SourceDependencyEntityStore | undefined;
  /** D-192 P4b — the declaration-driven write executor, LATE-BOUND: it
   *  needs the gateway fetch deps (composed post-listener), while the
   *  work-entity dispatchers that consume it are built earlier. The
   *  dispatchers hold a getter over this ref; the post-listener wire
   *  calls `composeWorkEntityWriteExecutor(fetchDeps)` (a closure over
   *  this context's store/mirror/connection-store) to populate it.
   *  Stays null on a dbless boot / without the work-entity substrate —
   *  connection-Source writes then refuse with
   *  `SOURCE_NOT_WRITE_CAPABLE` (the pre-executor posture). */
  workEntityWriteExecutorRef: { current: WorkEntitySourceWriteExecutor | null };
  composeWorkEntityWriteExecutor: ((fetchDeps: SourceMirrorFetchDeps) => void) | undefined;
  /** D-192 — connection row → its bound catalog manifest's
   *  `work_entity_sources` declarations. The boot wire + write executor
   *  consume it in-context; the post-listener sync wire
   *  (`composeWorkEntitySourceSync`) threads it so registration, write, and
   *  sync enumerate ONE declaration set (pack declarations first, then legacy
   *  compatibility fallbacks). Undefined without a work-entity store. */
  resolveWorkEntityCatalogManifestRef:
    | ((row: ConnectionRow) => IngredientManifest | null)
    | undefined;
  /** D-192 — the by-name work-entity Source reconcile the install/uninstall deps
   *  call post-commit (enroll-before-install registration; mirrors
   *  `reconcileConnectionProfile`). A stable fan-out over the boot + sync
   *  reconcilers. Undefined without a work-entity store. */
  reconcileWorkEntitySourcesRef: ((connectionName: string) => void) | undefined;
  /** D-192 — append a reconciler to the `reconcileWorkEntitySourcesRef` fan-out.
   *  The post-listener sync wire registers its by-name reconcile here so a pack
   *  reinstall re-derives the sync task (fresh declaration) alongside the Source.
   *  Undefined without a work-entity store. */
  registerWorkEntitySourceReconcilerRef:
    | ((fn: (connectionName: string) => void) => void)
    | undefined;
  /** D-192 F1 — the commitment-evidence capture producer's late-bound
   *  runtime half (proposal dispatch over `handleExecute` + the live
   *  merged vendor registry), populated by the post-listener wire once
   *  executeDeps exist (the `workEntityWriteExecutorRef` idiom). The
   *  bus subscriber itself is wired at compose time; captures before
   *  population are skipped WITHOUT claiming the dedup ledger. */
  commitmentEvidenceRuntimeRef: { current: CommitmentEvidenceRuntime | null };
  /** D-192 F1 — the `record_contact_edges` counterparty resolver the
   *  post-listener wire hands the capture runtime. Deal `full_target_id`
   *  → the deal's engagement-mediated `data.contact` contact edges →
   *  D-138 `merged_into` forward-resolve + dedup → the single distinct
   *  counterparty, or undefined (no / ambiguous contact — owner fills at
   *  approval). Self-degrades to undefined on a dbless boot (no
   *  engagement / contact store). */
  resolveCommitmentEvidenceCounterparty: (full_target_id: string) => string | undefined;
  enrichmentCascadeRef: CascadeEngine | undefined;
  externalContextRegistryRef: ExternalContextDependencyRegistry | undefined;
  connectionStoreRef: ConnectionStoreSqlite | undefined;
  /** D-165 P3.grant migration — the `contract.grant`-backed user-grant store
   *  (`ContractGrantStore`, wraps `contractStoreRef`). Backs the `write→ask`
   *  reachability surface: the boot profile seed merges these grants, and the
   *  `grant/revoke/listOperationGroup` rpcs write here. `undefined` on the
   *  db-less path. */
  contractGrantStoreRef: ContractGrantStore | undefined;
  /** D-170 gap #2 — the `contract.connection_catalog_binding`-backed store binding a
   *  connection to the private/local composition catalog installed against it (wraps
   *  `contractStoreRef`). The boot profile seed + the grant gate resolve a local-
   *  catalog connection through it; the install planner writes it. `undefined` on the
   *  db-less path. */
  connectionCatalogBindingStoreRef: ConnectionCatalogBindingStore | undefined;
  /** D-166 Slice 4d.1 — gateway-read-only `contract.*` store handle (the
   *  `contract_store` table; seeded with the spec schema at boot). RETAINED from
   *  boot (previously discarded after `seedSchema`) so the D-166 4d.4 catalog-gate
   *  resolver can `scan` contract rows (via `createContractScanFn`) when composing
   *  per-role policy. `undefined` on the db-less path. Recipes never reference
   *  `contract.*` — it is absent from the resolver `NS` by construction. */
  contractStoreRef: ContractStore | undefined;
  /** D-196 — seller-customer access substrate, adjacent to contract + inbound
   *  token stores. Undefined on dbless boots. */
  sellerStoreRef: SellerStore | undefined;
  /** D-207 §4.3 — the order (money) leg, over the same db. Undefined on dbless
   *  boots, exactly like the seller store it sits beside. */
  sellerOrderStoreRef: SellerOrderStore | undefined;
  /** D-201 Slice 1 — ingress lifecycle + encrypted credential versions.
   * Undefined on db-less boots. */
  webhookIngressStoreRef: WebhookIngressStore | undefined;
  /** D-201 Slice 2 — encrypted accepted deliveries/events + durable outbox.
   * The store alone is dormant; Slice 5A mounts a public route only when the
   * consumer, audit anchor, adapters, and outbox runtime are all wired. */
  webhookDeliveryStoreRef: WebhookDeliveryStore | undefined;
  /** D-201 Slice 4 — owner-approved logical bindings, exact recipe triggers,
   * idempotent fan-out authority, and active-run payload pins. */
  webhookConsumerStoreRef: WebhookConsumerStore | undefined;
  /** D-196 S3b — sealed one-time claim credentials, shared by seller issue
   * wiring and the public Reception claim handler. Undefined on dbless boots. */
  sellerClaimStoreRef: SellerClaimStore | undefined;
  /** D-210 Appendix B — single-use, per-record credentials backing the
   * on-the-go `/reception/manage` reschedule link. Undefined on dbless boots. */
  receptionManageCredentialStoreRef: ReceptionManageCredentialStore | undefined;
  /** D-163 Slice B — `client_tokens` SQL store handle lifted into the
   *  per-pair "app" stores so the notification block's
   *  `ChannelReadinessProbe` can consult it for Bridge pair-presence
   *  (D-163 N.5). Construction runs once at boot inside
   *  `composeAppContext`'s `if (db)` block, then is re-used by
   *  `composeClientSecurityContext` (which wraps it in
   *  `createTokenRotationEmitter` + cert-stack consumers) and by
   *  `composeNotificationBlock` (which reads `list({ client_kind:
   *  'bridge' })` from the probe). Both consumers see the same
   *  SQLite-backed identity; the store itself holds no in-memory state. */
  clientTokensRef: ClientTokenStore | undefined;
  engagementStoreRef: EngagementStore | undefined;
  engagementRateControlStoreRef: EngagementRateControlStore | undefined;
  /** D-184 — shared per-(connection, vendor) rate gate over the rate-control
   *  store; threaded onto the housekeeping scheduler ctx for the reconciliation
   *  harness. Absent on dbless boots. */
  vendorRateGateRef: VendorRateGate | undefined;
  engagementCapabilityStoreRef: EngagementCapabilityStore | undefined;
  contactStoreRef: ContactStore | undefined;
  /** D-139 P5 — engagement-evidence resolver bundle (`{ engagementStore,
   *  resolverDeps }`) shared by the `data.contact.engagements.list` WS-rpc
   *  + the `recued_contactEngagementsList` MCP read. Built once so both
   *  channels resolve identically. Absent on dbless boots / missing
   *  engagement+contact+connection stores. */
  contactEngagementsResolveDepsRef: ContactEngagementsResolveDeps | undefined;
  remergePromptStoreRef: ContactStoreBundle['remergePromptStore'];
  contactMergeCycleObserverRef: ContactStoreBundle['contactMergeCycleObserver'];
  upstreamMergeStoreRef: ContactStoreBundle['upstreamMergeStore'];
  contactBackfillDone: ContactStoreBundle['backfillDone'];
}

export const composeAppContext = (
  options: ComposeAppContextOptions,
): AppContext => {
  const {
    db,
    dbPath,
    envLlmConfig,
    gateRegistry,
    auditLog,
    eventBus,
    serverInstanceId,
    recipeStore,
    pairedInstances,
    workEntityStore,
    chatLateBound,
  } = options;

  // D-192 unit-3 — bind the pure read-side alias resolvers (parseRef's
  // `data.crm.*` / `data.<vendor>.*` rewrites + the recipe reference
  // validator) to the LIVE merged registry. The pure `@recued/contracts` /
  // `@recued/recipes` layer can't reach `localManifestStore` (public
  // boundary), so composition sets a lazy thunk here, mirroring `setRole`.
  // Recompute-on-read via `chatLateBound.getExecuteDeps()` (the same
  // late-bound handle the chat/MCP read tools use below) so packs installed
  // after boot are picked up; `liveVendorRegistry(undefined)` → frozen
  // builtin before executeDeps exists.
  setVendorAliasRegistryResolver(
    () => liveVendorRegistry(chatLateBound.getExecuteDeps()?.localManifestStore),
  );

  let contactStoreRef: ContactStore | undefined;
  let contactSourceSyncStateRef: ContactSourceSyncStateStore | undefined;
  let enrichmentStoreRef: EnrichmentStore | undefined;
  let crmRecordMirrorStoreRef: CrmRecordMirrorStore | undefined;
  let fileMetaStoreRef: FileMetaStore | undefined;
  let fileSourceConnResolverRef: FileConnectionResolver | undefined;
  let fileSourceSyncStateRef: FileSourceSyncStateStore | undefined;
  // D-192 remote byte-fetch — ONE lazy builder of the `remote` file-read bundle,
  // shared by every file-read channel (see the AppContext field doc). Reads the
  // two file-source refs at CALL time (assigned deep in the `if (db)` block
  // below, after the chat/executor consumers are already composed) and returns
  // undefined until both exist; the stateless byte-resolver registry is built
  // once (memoized). Mirrors the inline bundle the pair-RPC used to build.
  let remoteByteResolversMemo: RemoteFileByteResolverRegistry | undefined;
  const getRemoteFileReadDeps = (): RemoteFileReadDeps | undefined => {
    if (!fileMetaStoreRef || !fileSourceConnResolverRef) return undefined;
    remoteByteResolversMemo ??= buildRemoteFileByteResolvers();
    return {
      fileMetaStore: fileMetaStoreRef,
      resolveConnection: fileSourceConnResolverRef,
      byteResolvers: remoteByteResolversMemo,
    };
  };
  let workEntitySourceMirrorRef: WorkEntitySourceMirrorStore | undefined;
  let workEntitySourceSyncStateRef: WorkEntitySourceSyncStateStore | undefined;
  let workEntityEdgeStoreRef: WorkEntityEdgeStore | undefined;
  let workEntitySourceDependencyStoreRef: SourceDependencyEntityStore | undefined;
  const workEntityWriteExecutorRef: { current: WorkEntitySourceWriteExecutor | null } =
    { current: null };
  let composeWorkEntityWriteExecutor: ((fetchDeps: SourceMirrorFetchDeps) => void) | undefined;
  // D-192 F1 — commitment-evidence capture (dedup ledger + late runtime).
  const commitmentEvidenceRuntimeRef: { current: CommitmentEvidenceRuntime | null } =
    { current: null };
  let commitmentEvidenceLedgerRef: CommitmentEvidenceLedger | undefined;
  // D-192 M4 — the messenger message→commitment funnel's dedup ledger.
  let messageCommitmentLedgerRef: MessageCommitmentLedger | undefined;
  // D-192 read resolution — the chat/MCP read tools' two late-bound
  // handles: a freshness-enabled resolver (created with the sync-state
  // store below) + the targeted-read spine (populated alongside the
  // write executor once the gateway fetch deps exist).
  let workEntityChatResolverRef: WorkEntityResolver | undefined;
  const workEntityTargetedReadDepsRef: { current: WorkEntityTargetedReadDeps | null } =
    { current: null };
  let enrichmentCascadeRef: CascadeEngine | undefined;
  // D-192 — connection → its bound catalog manifest's `work_entity_sources`.
  // Built ONCE (below) over the local manifest table + the catalog binding
  // store; the boot wire, the write executor's declaration resolver, and the
  // post-listener sync wire all consume this SAME closure so registration,
  // write, and sync enumerate one declaration set (pack declarations first,
  // then legacy compatibility fallbacks) and can't drift. Undefined without a
  // work-entity store.
  let resolveWorkEntityCatalogManifestRef:
    | ((row: ConnectionRow) => IngredientManifest | null)
    | undefined;
  // D-192 — the by-name work-entity Source reconcile the install/uninstall deps
  // drive post-commit (enroll-before-install registration; mirrors
  // `reconcileConnectionProfile`). A stable fan-out over the boot + (post-listener)
  // sync reconcilers. Undefined without a work-entity store.
  let reconcileWorkEntitySourcesRef: ((connectionName: string) => void) | undefined;
  // Append a reconciler to the fan-out above (the post-listener sync wire adds its
  // by-name reconcile so a reinstall re-derives sync tasks too).
  let registerWorkEntitySourceReconcilerRef:
    | ((fn: (connectionName: string) => void) => void)
    | undefined;
  let connectionStoreRef: ConnectionStoreSqlite | undefined;
  let contractGrantStoreRef: ContractGrantStore | undefined;
  let connectionCatalogBindingStoreRef: ConnectionCatalogBindingStore | undefined;
  let contractStoreRef: ContractStore | undefined;
  let sellerStoreRef: SellerStore | undefined;
  let sellerOrderStoreRef: SellerOrderStore | undefined;
  let webhookIngressStoreRef: WebhookIngressStore | undefined;
  let webhookDeliveryStoreRef: WebhookDeliveryStore | undefined;
  let webhookConsumerStoreRef: WebhookConsumerStore | undefined;
  let sellerClaimStoreRef: SellerClaimStore | undefined;
  let receptionManageCredentialStoreRef: ReceptionManageCredentialStore | undefined;
  // D-163 Slice B — lifted from `composeClientSecurityContext` so the
  // notification block's `ChannelReadinessProbe` can read it for Bridge
  // pair-presence. The cert-stack composer still wraps the same handle
  // for token rotation + revoke-all; the consumer downstream
  // (`composeClientSecurityContext`) accepts the pre-built store as an
  // injected dep instead of creating its own.
  let clientTokensRef: ClientTokenStore | undefined;

  let serverState: ServerStateStore | undefined;
  if (db) {
    serverState = createServerStateStore(db);
    clientTokensRef = createClientTokenStore(db);
  }

  let keys: KeyManager | undefined;
  let authDeps: AuthDeps | undefined;
  let bundleStoreRef: BundleStore | undefined;
  const vaultStateBus = createVaultStateBus();
  if (db) {
    bundleStoreRef = createBundleStore(db);
    // D-212 slice 1 — the server bundle is a db-adjacent filesystem sidecar,
    // not a `server_config` row. `dbPath` is sufficient to compose it; no read
    // of the database is needed to discover or unlock an enrolled realm.
    const serverBundleStore = options.serverBundleStore
      ?? createServerBundleStore(options.dbPath);
    keys = createKeyManager({
      loadBundle: () => bundleStoreRef!.load(),
      saveBundle: (bundle) => bundleStoreRef!.save(bundle),
      // Server vault bundle (server-key + recovery-key dual-wrap) — the
      // live self-host encryption path. Its existence flips startup state
      // to `locked`; boot auto-unlock (slice 3) opens it with the
      // keyfile-held server key.
      loadServerBundle: () => serverBundleStore.load(),
      ...(Object.prototype.hasOwnProperty.call(options, 'initialServerBundle')
        ? { initialServerBundle: options.initialServerBundle ?? null }
        : {}),
      saveServerBundle: (bundle) => serverBundleStore.save(bundle),
      // Fan transitions to the (otherwise single-callback) state bus so
      // the autonomous-executor coordinator can pause/resume on lock.
      onStateChange: (next, prev) => vaultStateBus.emit(next, prev),
    });
    authDeps = { keys };
  }
  // Default-open when there is no vault: db-less / no-KeyManager boots
  // (and the non-vault test harnesses) must not gate their executors off.
  const isVaultUnlocked = (): boolean => (keys ? keys.state() === 'unlocked' : true);

  const llmSubstrate = composeLlmSubstrate({ db, keys, envLlmConfig });
  const {
    llmConfig,
    llmQuota,
    llmAdapterRegistry,
    emptyTabProbe,
  } = llmSubstrate;

  let cacheStore: CacheStore | undefined;
  let cacheDeps: CacheRpcDeps | undefined;
  let cacheBlobs: BlobStore | undefined;
  if (db) {
    // Archive-blob-encryption fix Phase 1 split CAS roots by content family.
    // Cache + collections (mail / calendar / file bodies reuse this SAME
    // `cacheBlobs` instance) live at `cache_blobs`, separate from the `blobs`
    // root that shared + annotation write to. D-212 slice 4 encrypts every
    // production root; keeping the roots separate still lets each eviction
    // sweep use its own reference set without reaping another family's blob.
    // Pre-launch → just change the root, no migration.
    const blobRoot = join(dirname(resolve(dbPath)), 'cache_blobs');
    // Wire the key providers UNCONDITIONALLY whenever a KeyManager
    // exists — NOT gated on a one-time `state() !== 'uninitialized'`
    // boot snapshot. `keyProvider` is dynamic (returns the live sub-DEK
    // when unlocked, null otherwise), so encryption follows the vault's
    // current state for the store's whole lifetime. The old snapshot
    // froze a server that booted uninitialized into permanent-plaintext
    // mode even after a later init+unlock, which let plaintext rows
    // coexist with ciphertext rows and crashed the encrypted-read path
    // (`atob` on plaintext). With the provider always wired, a write
    // while the vault is sealed (locked / uninitialized) THROWS rather
    // than landing plaintext — so no plaintext rows are produced in
    // production, and the per-row `inline_enc` flag closes the crash for
    // any that pre-date the fix (cleared on the column-add migration).
    const blobs = createEncryptedBlobStore(blobRoot, keys!.keyProvider('blob-store'));
    cacheBlobs = blobs;
    cacheStore = createSQLiteCacheStore(
      db,
      blobs,
      {
        ...(keys ? { getEncryptionKey: keys.keyProvider('server-data') } : {}),
        ...(gateRegistry
          ? { onBytesChanged: (delta: number) => gateRegistry.cache.addUsed(delta) }
          : {}),
      },
    );
    cacheDeps = {
      store: cacheStore,
      db,
      blobs,
      gate: gateRegistry?.cache,
      auditLog,
    };
  }

  // D-198 Slice 2 — the owner-authored `user_memory` store. A dedicated CAS
  // root (`memory_blobs`, a data-volume sibling of `blobs`) keeps > 64 KB
  // memory bodies OFF the shared cache/shared-store blob store, whose orphan
  // sweep (`sweepOrphans`) keeps only cache + shared refs and would otherwise
  // reap a memory blob under storage pressure. Encryption-aware like the cache
  // blobs (same live key provider). Inline (≤ 64 KB) bodies stay in SQLite.
  let userMemoryStore: UserMemoryStore | undefined;
  // D-198 Slice 4 — the redaction-marker store (§5). A plain JSON collection
  // keyed by memory_id; the memory handlers overlay it at read time so a
  // "forgotten" engine/AI row is content-cleared without mutating the (signed)
  // audit log. Cheap — one row per redaction, no blob.
  let memoryRedactionStore: Collection<MemoryRedactionRecord> | undefined;
  if (db) {
    const memoryBlobRoot = join(dirname(resolve(dbPath)), 'memory_blobs');
    const memoryBlobs = createEncryptedBlobStore(
      memoryBlobRoot,
      keys!.keyProvider('blob-store'),
    );
    userMemoryStore = createUserMemoryStore(
      createSQLiteCollection<UserMemoryRow>(db, 'user_memory'),
      memoryBlobs,
      // The raw handle turns on the FTS5 recall index over `summary + body`
      // (`memory.search`'s `query`). Absent → the store's substring fallback.
      { db },
    );
    memoryRedactionStore = createSQLiteCollection<MemoryRedactionRecord>(db, 'memory_redactions');
  }

  let sharedDeps: SharedRpcDeps | undefined;
  let sharedStoreRef: SharedStore | undefined;
  // The ENCRYPTED `<data>/blobs` root, shared by the shared-store + annotation
  // stores (each opens its own handle onto the same root). Exposed so the
  // eviction cascade can orphan-sweep this root with a keyset of shared ∪
  // annotation refs — kept distinct from the cache `cacheBlobs` root above.
  // Any handle sweeps the whole root, so the shared-store's handle stands in
  // for both writers.
  let sharedBlobs: BlobStore | undefined;
  if (db) {
    const blobRoot = join(dirname(resolve(dbPath)), 'blobs');
    sharedBlobs = createEncryptedBlobStore(blobRoot, keys!.keyProvider('blob-store'));
    sharedStoreRef = createSharedStore({
      db,
      blobs: sharedBlobs,
      ...(gateRegistry
        ? { onBytesChanged: (delta: number) => gateRegistry.shared_store.addUsed(delta) }
        : {}),
    });
    sharedDeps = {
      store: sharedStoreRef,
      auditLog,
      gate: gateRegistry?.shared_store,
    };
  }

  let annotationDeps: AnnotationRpcDeps | undefined;
  let annotationStoreRef: AnnotationStore | undefined;
  if (db) {
    const blobRoot = join(dirname(resolve(dbPath)), 'blobs');
    const annotationBlobs = createEncryptedBlobStore(
      blobRoot,
      keys!.keyProvider('blob-store'),
    );
    annotationStoreRef = createAnnotationStore({
      db,
      blobs: annotationBlobs,
    });
    annotationDeps = {
      store: annotationStoreRef,
      auditLog,
    };
  }

  let chatBundle: ChatOrchestratorBundle | undefined;
  if (db) {
    chatBundle = composeChatOrchestrator({
      db,
      keys,
      eventBus,
      auditLog,
      serverInstanceId,
      recipeStore,
      llmConfig,
      // D-174 R28 Slice A — per-use LIVE config getter for the chat store's
      // source_id → {layer, model_hint} resolver. Prefer the manager's live
      // SQLite read (reflects field-level slot edits); fall back to the boot
      // snapshot when the manager is absent (db-less) or locked (getConfig
      // throws) — mirrors `composeLlmSubstrate`'s graceful fallback.
      getLlmConfig: () => {
        try {
          return llmSubstrate.llmManager?.getConfig() ?? llmConfig;
        } catch {
          return llmConfig;
        }
      },
      llmQuota,
      llmAdapterRegistry,
      emptyTabProbe,
      pairedInstances,
      annotationDeps,
      sharedStore: sharedStoreRef,
      getContactStore: () => contactStoreRef,
      getCollectionRegistry: () => chatLateBound.getCollectionRegistry(),
      getEnrichmentStore: () => enrichmentStoreRef,
      // D-198 Slice 4 — the memory.write target + memory.search union source +
      // the redaction store so recall omits "forgotten" rows.
      getUserMemoryStore: () => userMemoryStore,
      getMemoryRedactionStore: () => memoryRedactionStore,
      // RUNG 4 — the query embedder for meaning-based recall. Built from the
      // substrate's own pieces rather than added to `LlmSubstrate`, so the
      // memory path stays self-contained and housekeeping's callable bundle is
      // untouched. Resolved PER CALL for the same reason the housekeeping
      // `embed` does: an embeddings slot saved after boot must apply without a
      // restart. No config at all ⇒ `undefined` ⇒ rung 4 is off by
      // construction, and the handler says so rather than reporting an empty
      // pool. (Config present but no embeddings slot — the pure-Anthropic case
      // — throws inside `executeEmbedding` instead, which the handler
      // degrades to the same empty.)
      getMemoryEmbedder: () => {
        const config = llmSubstrate.resolveLlmConfig();
        if (!config) return undefined;
        return createMemoryEmbedder((manifest, input) =>
          executeEmbedding(manifest, input, {
            config,
            adapters: llmSubstrate.llmEmbeddingsAdapterRegistry,
            quota: llmSubstrate.llmQuota,
          }));
      },
      // D-190 (generic reconciler MS3) — deal.search reads the CRM record mirror.
      getCrmRecordMirror: () => crmRecordMirrorStoreRef,
      getConnectionStore: () => connectionStoreRef,
      getExecutorConfig: () => chatLateBound.getExecutorConfig(),
      getExecuteDeps: () => chatLateBound.getExecuteDeps(),
      // D-177 rule 5 (5.c) — late-bound: contractStoreRef is created below.
      getContractStore: () => contractStoreRef,
      // D-192 read resolution — work.search / work.read. Both refs are
      // created below (resolver with the sync-state store; the
      // targeted-read spine once the post-listener runtime supplies the
      // gateway fetch deps), hence late-bound.
      getWorkEntityResolver: () => workEntityChatResolverRef,
      getWorkEntityTargetedReadDeps: () => workEntityTargetedReadDepsRef.current ?? undefined,
    });
  }

  const warehouseBus = createWarehouseEventBus();

  const housekeepingStores: HousekeepingStores = composeHousekeepingStores({ db });
  const {
    configStore: housekeepingConfigRef,
    stateStore: housekeepingStateRef,
    trustStore: housekeepingTrustRef,
    tunableParamsStore: housekeepingTunableParamsRef,
    llmResultCacheStore: housekeepingLlmResultCacheRef,
  } = housekeepingStores;

  let externalContextRegistryRef: ExternalContextDependencyRegistry | undefined;
  let engagementStoreRef: EngagementStore | undefined;
  let engagementRateControlStoreRef: EngagementRateControlStore | undefined;
  let engagementCapabilityStoreRef: EngagementCapabilityStore | undefined;
  // D-184 — one shared per-(connection, vendor) rate gate over the rate-control
  // store, so the housekeeping reconciliation harness caps the daily API budget
  // + skips concurrent pulls across ALL reconcilers (record + engagement).
  let vendorRateGateRef: VendorRateGate | undefined;
  if (db) {
    enrichmentStoreRef = createEnrichmentStore(db, {
      // D-192 S4b — late-bound live merged registry (built-ins + installed pack
      // entities) so a pack CRM's crm_alias-anchored enrichment scope
      // (contact/deal/account mirror) becomes writable without a per-topic
      // valid_scopes code edit. The same late-bound thunk the cascade uses below;
      // resolves at write time so a runtime install/uninstall is reflected.
      resolveVendorRegistry: () =>
        liveVendorRegistry(chatLateBound.getExecuteDeps()?.localManifestStore),
    });
    // D-190 — the dedicated CRM record mirror, beside the enrichment store.
    // `ensureCrmRecordMirrorSchema` first (idempotent; the create function only
    // prepares statements, so the table must exist before it runs).
    ensureCrmRecordMirrorSchema(db);
    crmRecordMirrorStoreRef = createCrmRecordMirrorStore(db);
    // D-192 file SOURCE family (slice 4) — the `file_meta_ref` meta-store,
    // beside the CRM mirror. `ensureFileMetaSchema` first (idempotent; the
    // create function only prepares statements). Wired to the reconcile tasks
    // by `wireFileSourceSync` once the connection store exists (below).
    ensureFileMetaSchema(db);
    fileMetaStoreRef = createFileMetaStore(db);
    // D-192 — the per-Source runtime health/cursor row beside the meta-store.
    // Seeded/written by `wireFileSourceSync` (below); read for freshness by the
    // `source_freshness_degradation` producer (via `ctx.db`).
    ensureFileSourceSyncStateSchema(db);
    fileSourceSyncStateRef = createFileSourceSyncStateStore(db);
    // D-205 item #1 — the contact family's twin of the row above. Written by the
    // contact sync runner (which cannot be constructed without it), read for freshness
    // by the SAME `source_freshness_degradation` producer. Before this, the runner
    // returned every count — including "every record failed" — to a caller that
    // discarded it, and the producer had no contact branch to look with.
    ensureContactSourceSyncStateSchema(db);
    contactSourceSyncStateRef = createContactSourceSyncStateStore(db);
    externalContextRegistryRef = createExternalContextDependencyRegistry();
    const housekeepingInvalidator =
      housekeepingStateRef !== undefined
        ? createHousekeepingInvalidator({
            registry: () => listHousekeepingTasks(),
            state: housekeepingStateRef,
            context: () => ({
              db,
              bus: warehouseBus,
              enrichmentStore: enrichmentStoreRef!,
              recipeStore,
              now: () => Date.now(),
              emitAuditRow: () => {},
            }),
          })
        : undefined;
    enrichmentCascadeRef = createEnrichmentCascade(enrichmentStoreRef, {
      ...(housekeepingInvalidator ? { notifier: housekeepingInvalidator } : {}),
      externalContextRegistry: externalContextRegistryRef,
      // D-192 — live merged registry (late-bound; resolves at cascade time) so a
      // pack CRM's deal/account edges form their mirror scope + cascade.
      resolveVendorRegistry: () =>
        liveVendorRegistry(chatLateBound.getExecuteDeps()?.localManifestStore),
      engagementEdgeLookup: {
        edges: (connection_id, engagement_target_id) => {
          if (!engagementStoreRef) return [];
          return engagementStoreRef.listEdges({
            connection_id,
            engagement_target_id,
            include_deleted: false,
          });
        },
      },
    });
    recipeStore.setOnUpgrade((recipe_id) => {
      enrichmentCascadeRef!.cascadeForRecipeUpgrade(recipe_id);
    });

    connectionStoreRef = createConnectionStore(db);
    // D-165/D-166 — load the spec-owned contract schema into `contract.schema.*`
    // rows at boot (idempotent). D-166 Slice 4d.1: RETAIN the handle (was
    // discarded) and expose it on AppContext so the 4d.4 catalog-gate resolver can
    // scan contract rows via `createContractScanFn`. Recipes never reference
    // `contract.*` (absent from the resolver NS); the only server-internal readers
    // are the gateway override-tightening scan + the grant store below.
    contractStoreRef = createContractStore(db);
    contractStoreRef.seedSchema(D165_CONTRACT_SCHEMA);
    sellerStoreRef = createSellerStore(db);
    sellerOrderStoreRef = createSellerOrderStore(db);
    webhookIngressStoreRef = createWebhookIngressStore(db, {
      // Dynamic provider: an uninitialized/locked vault closes credential reads
      // and writes; metadata CRUD stays available for recovery/setup.
      getEncryptionKey: keys!.keyProvider('webhook_secrets'),
    });
    // D-201 Slice 9BO — unlike ordinary teardown observers, this hook is part
    // of the authoritative connection-delete transaction and is not swallowed.
    // Required paired ingresses are durably closed before their API authority
    // can disappear; any persistence failure preserves both sides. A later
    // same-name enrollment cannot clear the durable recovery latch.
    connectionStoreRef.addBeforeDelete((kind, name) => {
      if (kind === 'api') {
        webhookIngressStoreRef!.failCloseForDeletedPairedConnection(name);
      }
      return undefined;
    });
    webhookConsumerStoreRef = createWebhookConsumerStore(db, {
      ingressStore: webhookIngressStoreRef,
    });
    webhookDeliveryStoreRef = createWebhookDeliveryStore(db, {
      getEncryptionKey: keys!.keyProvider('webhook_payloads'),
      hasDispatchTarget: (ingressId, eventType) =>
        webhookConsumerStoreRef!.hasDispatchTarget(ingressId, eventType),
      // D-201 Slice 9BP — registry metadata is an explicit production boot
      // requirement. The store validates its effective configured retention
      // against every profile before creating or serving durable delivery rows.
      profileDeduplicationRequirements: Object.values(WEBHOOK_PROFILE_REGISTRY),
    });
    sellerClaimStoreRef = createSellerClaimStore(db);
    receptionManageCredentialStoreRef = createReceptionManageCredentialStore(db);
    // D-187 AMENDMENT 3b — materialize the OWNER contract's grant rows (one
    // `granted:true` per registered kernel op / readable collection / enrichment topic),
    // preserving any explicit owner revoke. Idempotent + atomic; runs right after the
    // policy-matrix seed. Makes the owner's "fully-granted contract" DB state mirror the
    // 3c UI 1:1; the owner-permissive author-default covers ids not enumerated here.
    reconcileOwnerGrants(contractStoreRef);
    // D-228 slice 5 — grandfather EXISTING non-owner contracts onto the Tier-1
    // primitives before the gate can deny them. Must run beside the owner
    // reconcile on BOTH surfaces: a scoped door / D-196 customer is fail-closed
    // by author default and could hold no `primitive.*` row before this slice.
    grandfatherPrimitiveGrants(contractStoreRef);
    // D-165 P3.grant migration — operation-group grants live as `contract.grant`
    // rows (the centralized permission profile). The user-grant store wraps the
    // contract store; the boot profile seed merges these grants + the grant rpcs
    // write here. A connection delete drops that connection's grants — BOTH the
    // user-manual (`__user__`) half AND the pack-owned half (D-194 S-2) — so a
    // stale grant never outlives the connection it described and a same-name
    // re-enroll can't silently revive a pack's access to a different account
    // (deny-until-granted holds; re-consent required, exactly like reinstall).
    contractGrantStoreRef = createContractGrantStore(contractStoreRef);
    wireConnectionGrantCleanup(connectionStoreRef, contractGrantStoreRef);
    // D-170 gap #2 — the connection→local-catalog binding store (stateless wrapper
    // over the same contract store). The binding SURVIVES a connection delete (it is
    // install-state, written by the install planner from the composition's
    // `auth.connection`; if the connection returns under the same name the upsert
    // observer re-seeds), so there is no addOnDelete cleanup here — only uninstall
    // drops a pack's bindings.
    connectionCatalogBindingStoreRef = createConnectionCatalogBindingStore(contractStoreRef);
    if (chatBundle?.connectionMcpStore) {
      const annotationStore = chatBundle.connectionMcpStore;
      connectionStoreRef.addOnDelete((kind, name) => {
        if (kind === 'mcp') {
          annotationStore.deleteAnnotation(name);
        }
      });
    }
    if (workEntityStore) {
      // D-192 P3b — the sync substrate: the Source-identity mirror
      // adapter + the per-Source cursor/health rows. Created before the
      // boot wire so registration seeds sync-state rows (and unregister
      // deletes them) from the first scan.
      ensureWorkEntitySourceSyncStateSchema(db);
      workEntitySourceMirrorRef = createWorkEntitySourceMirrorStore(db, workEntityStore);
      workEntitySourceSyncStateRef = createWorkEntitySourceSyncStateStore(db);
      // D-192 P5 — the work-graph edge substrate. Created alongside the
      // mirror so the boot wire's unregister path can hard-delete a
      // dead Source's edges (derived state, same posture as sync
      // state); the post-listener sync wire threads it into fold-time
      // edge reconciliation.
      ensureWorkEntityEdgeSchema(db);
      workEntityEdgeStoreRef = createWorkEntityEdgeStore(db);
      // D-192 source dependencies — the container-entity selection store (Asana
      // workspace, Linear team). The create-assist preflight
      // (`resolveCreateDependencies`) fetches + caches the choice list here; the
      // boot wire's unregister path hard-deletes a dead Source's rows (derived
      // state, same posture as sync-state / edges).
      ensureSourceDependencyEntitySchema(db);
      workEntitySourceDependencyStoreRef = createSourceDependencyEntityStore(db);
      // D-192 — resolve a connection row → its bound catalog manifest so
      // authoritative pack-declared `work_entity_sources` register + sync before
      // legacy compatibility fallbacks. Reads the PERSISTED `local_manifest`
      // table directly (a fresh, stateless store over the same `db`), so it
      // works at the boot scan below — before the post-listener `executeDeps` exist. The
      // connection→catalog key mirrors `connection-operation-profile-boot`: a
      // registered vendor resolves via `catalogSlugForConnection`, a local
      // composition catalog via the D-170 gap-#2 binding store (registered
      // vendor WINS, the `??` order). ONE closure, shared by all three
      // consumers (boot / write / sync) so they can't drift.
      const workEntityLocalManifestStore = createLocalManifestStore(db);
      const bindingStore = connectionCatalogBindingStoreRef;
      const resolveWorkEntityCatalogManifest = (row: ConnectionRow): IngredientManifest | null => {
        const catalogSlug = catalogSlugForConnection(row)
          ?? bindingStore?.resolveCatalogSlug(row.name);
        if (catalogSlug === undefined) return null;
        return workEntityLocalManifestStore.getManifest(catalogSlug);
      };
      resolveWorkEntityCatalogManifestRef = resolveWorkEntityCatalogManifest;
      // The boot wire re-runs its reconcile on the boot scan + connection
      // upsert/delete. The natural install order works — install-then-enroll
      // fires the enroll upsert AFTER the manifest+binding are committed, so the
      // resolver finds them and the Source registers. Enroll-BEFORE-install (a
      // pre-existing connection, pack installed later) writes the manifest+binding
      // WITHOUT a connection upsert — so the returned `reconcileConnection` is
      // driven post-commit by the install/uninstall deps (mirrors
      // `reconcileConnectionProfile`), registering the Source at once.
      const workEntityBoot = wireWorkEntitySourceBoot({
        connectionStore: connectionStoreRef,
        store: workEntityStore,
        resolveCatalogManifest: resolveWorkEntityCatalogManifest,
        syncState: workEntitySourceSyncStateRef,
        edges: workEntityEdgeStoreRef,
        dependencyEntities: workEntitySourceDependencyStoreRef,
        ...(annotationStoreRef && enrichmentStoreRef && fileMetaStoreRef
          ? {
              purgeMirroredData: (source) => {
                const purged = purgeSourceData(source, {
                  db,
                  fileMetaStore: fileMetaStoreRef!,
                  workEntityStore,
                  annotationStore: annotationStoreRef!,
                  enrichmentStore: enrichmentStoreRef!,
                  edges: workEntityEdgeStoreRef!,
                });
                // The declaration changed a durable retention boundary and the
                // purge really happened. Keep the same immutable provenance
                // action as an owner-requested connection teardown, with an
                // explicit posture-migration reason. Best-effort: a ledger
                // failure cannot put already-removed sensitive rows back.
                if (auditLog) {
                  void auditLog.logActivity({
                    activity_id: '',
                    timestamp: Date.now(),
                    action: 'source_data_purged',
                    target: source.id,
                    detail: JSON.stringify({
                      reason: 'source_posture_migration',
                      from: 'records',
                      to: 'read_through',
                      ...purged,
                    }),
                  }).catch(() => undefined);
                }
              },
            }
          : {}),
      });
      // The install/uninstall deps drive ONE reconcile hook, but two wires derive
      // connection state from a bound catalog: the boot wire (Source registration)
      // now, and the post-listener SYNC wire (housekeeping sync tasks) later. A
      // stable fan-out lets the sync wire append its reconcile once it exists, so
      // a reinstall re-derives BOTH at once (Source + its sync task's declaration
      // closure). Boot reconcile runs first (register the Source before its task).
      const workEntitySourceReconcilers: Array<(connectionName: string) => void> = [
        workEntityBoot.reconcileConnection,
      ];
      reconcileWorkEntitySourcesRef = (connectionName): void => {
        for (const r of workEntitySourceReconcilers) r(connectionName);
      };
      registerWorkEntitySourceReconcilerRef = (fn): void => {
        workEntitySourceReconcilers.push(fn);
      };
      // D-192 P4b — the write-executor factory: closes over this
      // context's store/mirror/connection-store; the post-listener
      // wire supplies the gateway fetch deps once they exist. The
      // declaration resolver walks the SAME `desiredWorkEntitySourcesFor` set
      // that registration + sync enumerate (pack first, then compatibility
      // fallbacks, via `resolveWorkEntityCatalogManifest`), so write, sync, and
      // registration can never drift.
      const mirror = workEntitySourceMirrorRef;
      const connections = connectionStoreRef;
      // D-192 read resolution — the chat tools' resolver reads the same
      // store with the sync-state handle threaded, so `sourceFreshness`
      // verdicts light up (the compose-listeners CRUD resolver does the
      // same; both instances are thin facades over one store).
      workEntityChatResolverRef = createWorkEntityResolver(workEntityStore, {
        syncState: workEntitySourceSyncStateRef,
      });
      composeWorkEntityWriteExecutor = (fetchDeps: SourceMirrorFetchDeps): void => {
        const resolveDeclaration: WorkEntityTargetedReadDeps['resolveDeclaration'] = (
          source_id,
        ) => {
          const binding = resolveWorkEntitySourceBinding(
            connections,
            source_id,
            resolveWorkEntityCatalogManifest,
          );
          if (binding === null) return null;
          const name = binding.row.name;
          const row = binding.row;
          const hit = binding.desired;
          // The connection's non-secret config — the source for the declaration's
          // `create_arg_bindings` (a per-connection STATIC create arg). The entity
          // case (Linear `team`, Asana `workspace`) moved to `source_dependencies`
          // in D-192 Slice 7. A malformed / non-object config resolves to none.
          let connection_config: Record<string, unknown> | undefined;
          try {
            const parsed: unknown = JSON.parse(row.config_json);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              connection_config = parsed as Record<string, unknown>;
            }
          } catch { /* non-JSON config → no create-arg source */ }
          return {
            declaration: hit.declaration,
            connection_name: name,
            ...(connection_config !== undefined ? { connection_config } : {}),
          };
        };
        workEntityWriteExecutorRef.current = createWorkEntitySourceWriteExecutor({
          fetchDeps,
          mirror,
          store: workEntityStore,
          resolveDeclaration,
          // D-192 baseline-admission (S2) — the actor-aware op-admission gate, resolved
          // per-use off the late-bound execute deps (the SAME `getExecuteDeps` idiom the
          // live vendor registry uses; a boot-captured reference would be stale before the
          // execute wiring lands). A vendor CREATE whose run is governed by the OWNER or a
          // granting DOOR is then admitted past the vendor op's `'ask'` gate.
          getOpAdmissionGate: () => chatLateBound.getExecuteDeps()?.opAdmissionGate,
          ...(chatBundle?.executionCaseVerificationRecorder
            ? {
                recordDeterministicVerification:
                  chatBundle.executionCaseVerificationRecorder.record,
                getDeterministicVerificationContext:
                  currentExecutionCaseVerificationContext,
              }
            : {}),
          // Slice 6a activates the store for the CREATE-ASSIST preflight (prompt
          // deps fetch their choice list live). The SYNC wire now receives the
          // store too (D-192 #8b fold — `composeWorkEntitySourceSync`), so persist
          // selections ARE populated in production (lone-option auto-select) and
          // scope the list walk + hydration reads. The chat/MCP read deps below
          // receive the same selected-id view: read-through Sources have no sync
          // cycle to rediscover scope, so an existing Settings pick is their only
          // safe, deterministic container authority.
          ...(workEntitySourceDependencyStoreRef !== undefined
            ? { dependencyStore: workEntitySourceDependencyStoreRef }
            : {}),
        });
        // The read tools' escalation + read-through spine — the SAME fetch deps,
        // declaration resolver, and persisted container picks as write/sync, so
        // a source-backed list/read cannot drift on scope arguments.
        workEntityTargetedReadDepsRef.current = {
          fetchDeps,
          resolveDeclaration,
          ...(workEntitySourceDependencyStoreRef !== undefined
            ? { dependencyStore: workEntitySourceDependencyStoreRef }
            : {}),
        };
      };
    }
    // D-192 file SOURCE family (slice 4/5) — wire one housekeeping reconcile
    // task per file Source (a connection whose vendor carries a
    // `FileVendorDeclaration` AND a resolved adapter leaf). Slice 5 supplies
    // the per-vendor list leaves (Dropbox / S3) via `resolveAdapter`, so a
    // Dropbox / S3 api connection now gets a sync task. This is where the
    // slice-2 meta-store finally gets its consumer (Fork B's `data.file.*` read
    // resolver is the other). Unlike the work-entity sync, the file port is
    // injected (not the gateway), so no post-listener `executeDeps` are needed.
    if (fileMetaStoreRef && fileSourceSyncStateRef && connectionStoreRef) {
      const fileConnectionStore = connectionStoreRef;
      // Connection-scoped AEAD provider; the leaves never touch storage/crypto
      // themselves — they read whatever this resolver decrypts. On a non-vault
      // boot the provider is absent and `decodeAuthFromStorage` yields the
      // plaintext-tolerant shape.
      const fileConnKeyProvider = keys ? keys.keyProvider('connection') : undefined;
      // Built lazily on first resolve (dynamic-imports decode/encode to keep the
      // heavy connection-handler module out of this composer's static boot
      // graph), then memoized so the refresh gate's single-flight map persists
      // across cycles. The resolver runs the decrypted auth through the SAME
      // `createEnsureFreshAuth` gate the `connection.*` handlers use, so a
      // Dropbox `oauth2_refresh` token is refreshed + persisted on demand (S3's
      // `basic` auth passes through untouched) — see
      // `file-source-connection-resolver.ts`.
      let fileConnResolver:
        | ((name: string) => Promise<
            import('../file-source-connection-resolver.js').ResolvedFileSourceConnection | null
          >)
        | null = null;
      const resolveFileSourceConnection = async (
        connection_name: string,
      ): Promise<{
        auth: import('@recued/contracts').ConnectionAuth;
        config: Record<string, unknown>;
      } | null> => {
        if (fileConnResolver === null) {
          const { decodeAuthFromStorage, encodeAuthForStorage } = await import(
            '../connection-handler.js'
          );
          const { createFileSourceConnectionResolver } = await import(
            '../file-source-connection-resolver.js'
          );
          fileConnResolver = createFileSourceConnectionResolver({
            connectionStore: fileConnectionStore,
            decodeAuthFromStorage,
            encodeAuthForStorage,
            keyProvider: fileConnKeyProvider,
            ...(auditLog
              ? {
                  onPersistFailure:
                    makeConnectionCredentialPersistFailureSink(auditLog),
                }
              : {}),
          });
        }
        return fileConnResolver(connection_name);
      };
      // D-192 remote byte-fetch — expose the resolver so `data.file.read` can
      // authenticate a lazy vendor byte fetch (the byte read path reuses it).
      fileSourceConnResolverRef = resolveFileSourceConnection;
      wireFileSourceSync({
        connectionStore: connectionStoreRef,
        store: fileMetaStoreRef,
        syncState: fileSourceSyncStateRef,
        resolveAdapter: buildFileSourceAdapterResolver({
          resolveConnection: resolveFileSourceConnection,
        }),
      });
      // D-192 file SOURCE family — register the `SourceRegistration` rows so an
      // enrolled file Source is VISIBLE in Settings + has a freshness anchor
      // (the sync wire above only registers the reconcile TASKS). Shares the
      // Source registry with `wireWorkEntitySourceBoot`; each reconcile is
      // scoped to its own `top_tier_kind` so the two never sweep each other's
      // rows. Mints the SAME `CONNECTION_SOURCE_ID(vendor, name, 'file')` the
      // sync task reconciles into, so registry + task never drift.
      if (workEntityStore) {
        wireFileSourceBoot({
          connectionStore: connectionStoreRef,
          store: workEntityStore,
        });
      }
    }
    engagementStoreRef = createEngagementStore(db, {
      onEngagementChange: (event) => {
        if (!enrichmentCascadeRef) return;
        const engagement_scope =
          `connection.api.${event.vendor}.${event.entity}` as
          import('@recued/contracts').EnrichmentScope;
        const opts: Parameters<
          NonNullable<typeof enrichmentCascadeRef>['cascadeForEngagementEvent']
        >[3] =
          event.removed_edge_targets && event.removed_edge_targets.length > 0
            ? { extra_edge_targets: event.removed_edge_targets }
            : undefined;
        enrichmentCascadeRef.cascadeForEngagementEvent(
          engagement_scope,
          event.target_id,
          event.connection_id,
          opts,
        );
      },
    });
    engagementRateControlStoreRef = createEngagementRateControlStore(db);
    engagementCapabilityStoreRef = createEngagementCapabilityStore(db);
    vendorRateGateRef = createVendorRateGate(engagementRateControlStoreRef);
    // D-192 F1 — the capture producer's durable dedup ledger (same
    // SQLite as the warehouse the folds land in).
    commitmentEvidenceLedgerRef = createCommitmentEvidenceLedger(db);
    // D-192 M4 — the messenger funnel's message-identity dedup ledger.
    messageCommitmentLedgerRef = createMessageCommitmentLedger(db);
  }

  const contactBundle = composeContactStore({
    db,
    warehouseBus,
    eventBus,
    ...(enrichmentCascadeRef ? { enrichmentCascade: enrichmentCascadeRef } : {}),
  });
  contactStoreRef = contactBundle.contactStore;

  // D-192 C-2 slice 6 — the contact SOURCE family. Two wires, as with files:
  //
  //  - `wireContactSourceBoot` registers the `SourceRegistration` rows, so an
  //    enrolled CRM connection is VISIBLE in Settings as a contact Source with a
  //    freshness anchor. DECLARATION-driven, so it registers even before an adapter
  //    leaf exists — a Source row is a visibility fact, not a runtime one.
  //  - `wireContactSourceSync` registers the housekeeping reconcile TASK, and is
  //    gated on a resolved adapter leaf. Slice 6 passes NO `resolveAdapter`, so no
  //    task is registered yet; slice 7's leaves light them up with no wiring change.
  //
  // Both mint the same `CONNECTION_SOURCE_ID(vendor, name, 'contact')`, which is
  // also the key the mirrored blobs and the contributions are stored under (slice
  // 6a) — one Source, one id, everywhere. The Source registry is SHARED with the
  // file + work-entity boots and each reconcile is scoped to its own
  // `top_tier_kind`, which matters more here than for files: a HubSpot connection
  // legitimately produces a work-entity Source AND a contact Source at once.
  // ⚠ D-205 #4c — the SYNC wire moved OUT of here, to `composeContactSourceSync`
  // (post-listener). Only REGISTRATION stays.
  //
  // The Google People leaf dispatches the pack's own operation through the catalog
  // GATEWAY (gated + audited), and those deps are composed post-listener — this
  // function runs before they exist. Building leaves here could therefore only ever
  // produce the CRM one, which is exactly what used to happen: `resolveAdapter` was
  // passed only `if (crmRecordMirrorStoreRef)`, so a server with no CRM got NO
  // resolver at all and a contact book would have registered, rendered in the health
  // strip, and silently never synced.
  //
  // Registration must stay early and unconditional: a Source that never ran still
  // has to APPEAR (`deriveContactSourceFreshness(null)` → stale + never-synced).
  // Driving the list off "has a sync task" would make an un-runnable Source vanish
  // from the page whose whole job is to explain why it is not running — and absent
  // reads as fine.
  if (connectionStoreRef && contactStoreRef && contactSourceSyncStateRef && workEntityStore) {
    wireContactSourceBoot({
      connectionStore: connectionStoreRef,
      store: workEntityStore,
    });
  }

  const detachWarehouseBridge = bridgeWarehouseEvents(eventBus, warehouseBus);
  const detachEnrichmentCascadeBridge = enrichmentCascadeRef
    ? bridgeEnrichmentCascade(warehouseBus, enrichmentCascadeRef)
    : (() => {});
  // D-192 F1 — the commitment-evidence capture producer rides the same
  // bus the CRM folds emit on. Subscribed at compose time; inert until
  // the post-listener wire populates `commitmentEvidenceRuntimeRef`
  // (and entirely inert on a dbless boot — no ledger, no claim).
  const detachCommitmentEvidenceCapture = wireCommitmentEvidenceCapture({
    bus: warehouseBus,
    getLedger: () => commitmentEvidenceLedgerRef,
    getRuntime: () => commitmentEvidenceRuntimeRef.current ?? undefined,
  });

  // D-192 M4 — the messenger message→commitment funnel rides the same bus:
  // an inbound messenger message that matches the connection's declared
  // `config_json.match_patterns` fires a held `commitment-propose` (reusing
  // the F1 fire on `commitmentEvidenceRuntimeRef`). Inert until the
  // post-listener wire populates the runtime, and entirely inert dbless.
  const detachMessengerCommitmentFunnel = wireMessengerCommitmentFunnel({
    bus: warehouseBus,
    getConnectionStore: () => connectionStoreRef,
    getFire: () => commitmentEvidenceRuntimeRef.current?.fire,
    getLedger: () => messageCommitmentLedgerRef,
    // M3 — the messenger→contact linker resolves the sender through the
    // contact store's `contact_platform_link` table (late-bound; set in the
    // `if (db)` block above).
    getContactStore: () => contactStoreRef,
    // M1b — the declaration-driven link WRITER needs the vendor bot token
    // (Slack `users.info` profile fetch) to POPULATE that table for a
    // first-seen matched sender.
    ...(keys ? { keys } : {}),
  });
  let stopWarehouseEventBridgesPromise: Promise<void> | undefined;
  const stopWarehouseEventBridges = (): Promise<void> => {
    if (stopWarehouseEventBridgesPromise) {
      return stopWarehouseEventBridgesPromise;
    }
    // Invoke every detach before awaiting any drain so no bridge can admit new
    // work while a sibling capture is still settling.
    const begin = (stop: () => void | Promise<void>): Promise<void> => {
      try {
        return Promise.resolve(stop());
      } catch (error) {
        return Promise.reject(error);
      }
    };
    const drains = [
      begin(detachWarehouseBridge),
      begin(detachEnrichmentCascadeBridge),
      begin(detachCommitmentEvidenceCapture),
      begin(detachMessengerCommitmentFunnel),
    ];
    stopWarehouseEventBridgesPromise = Promise.allSettled(drains).then(
      (results) => {
        const errors = results
          .filter((result): result is PromiseRejectedResult =>
            result.status === 'rejected')
          .map((result) => result.reason);
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            'one or more warehouse event bridges failed to stop',
          );
        }
      },
    );
    return stopWarehouseEventBridgesPromise;
  };

  // D-192 F1 — the `record_contact_edges` counterparty resolver. Reads
  // the (late-assigned) engagement + contact store refs at call time, so
  // it is safe to build here even though a capture only ever fires long
  // after compose completes. Both refs are set inside the `if (db)`
  // block above; the in-closure null-check makes a dbless boot (or a
  // pre-store call) degrade to an empty counterparty rather than throw.
  const resolveCommitmentEvidenceCounterparty = (
    full_target_id: string,
  ): string | undefined => {
    const engagementStore = engagementStoreRef;
    const contactStore = contactStoreRef;
    if (!engagementStore || !contactStore) return undefined;
    // Fetch cap + 1 so the resolver can DETECT truncation and fail
    // closed (a > cap result means an unseen candidate could be a second
    // distinct counterparty). Runs once per next_step capture (not a hot
    // path) and the row work is bounded by this one deal's engagement
    // footprint; the LIMIT caps the result set.
    const emails = engagementStore.listDealCounterpartyContactEmails(
      full_target_id,
      COMMITMENT_COUNTERPARTY_CANDIDATE_CAP + 1,
    );
    if (emails.length === 0) return undefined;
    return resolveCounterpartyFromContactEmails(
      emails,
      (email) => contactStore.resolveCanonicalEmail(email).canonical_email,
    );
  };

  // D-139 P5 — engagement-evidence resolver bundle shared by the
  // `data.contact.engagements.list` WS-rpc + the `recued_contactEngagementsList`
  // MCP read. Built ONCE so both channels resolve through an IDENTICAL
  // resolver (same identity-expansion + cross-account mail-twin join +
  // coverage). `engagementStoreRef` is only set inside the `if (db)` block,
  // so `db` is re-asserted here for narrowing. The cross-account mail-twin
  // resolver self-skips when no mail accounts exist (CRM-only stays correct).
  const contactEngagementsResolveDepsRef: ContactEngagementsResolveDeps | undefined =
    db && engagementStoreRef && contactStoreRef && connectionStoreRef
      ? {
          engagementStore: engagementStoreRef,
          resolverDeps: buildEngagementsResolverDeps({
            db,
            contactStore: contactStoreRef,
            connectionStore: connectionStoreRef,
            resolveMailTwins: createMailUnionTwinResolver(db),
            // D-139 — feeds `coverage.sources_degraded`. Created at :509
            // inside the same `if (db)` block as `engagementStoreRef`, so
            // it is set whenever this `db && engagementStoreRef && …` branch
            // runs; the field is optional + tolerates `undefined` regardless.
            rateControlStore: engagementRateControlStoreRef,
            // D-192 — live merged registry (late-bound; resolves per coverage
            // build) so a pack CRM's engagement source scopes list in coverage.
            resolveVendorRegistry: () =>
              liveVendorRegistry(chatLateBound.getExecuteDeps()?.localManifestStore),
            now: () => Date.now(),
          }),
        }
      : undefined;

  return {
    serverState,
    keys,
    isVaultUnlocked,
    vaultStateBus,
    authDeps,
    bundleStoreRef,
    ...llmSubstrate,
    cacheStore,
    cacheDeps,
    cacheBlobs,
    userMemoryStore,
    memoryRedactionStore,
    sharedDeps,
    sharedStoreRef,
    sharedBlobs,
    annotationDeps,
    annotationStoreRef,
    chatStoreRef: chatBundle?.chatStore,
    chatToolCatalogStoreRef: chatBundle?.toolCatalogStore,
    chatConnectionMcpStoreRef: chatBundle?.connectionMcpStore,
    chatInboundTokenStoreRef: chatBundle?.inboundTokenStore,
    chatOrchestratorRef: chatBundle?.orchestrator,
    chatDeps: chatBundle?.chatDeps,
    executionCaseLifecycle: chatBundle?.executionCaseLifecycle,
    publishExecutionCaseOfferNotifier:
      chatBundle?.publishExecutionCaseOfferNotifier,
    executionCaseArgumentStore: chatBundle?.executionCaseArgumentStore,
    executionCaseSourcePruner: chatBundle?.executionCaseSourcePruner,
    internalRegistryRef: chatBundle?.internalRegistry,
    chatForwardedSenderIndexRef: chatBundle?.forwardedSenderIndex,
    warehouseBus,
    stopWarehouseEventBridges,
    housekeepingConfigRef,
    housekeepingStateRef,
    housekeepingTrustRef,
    housekeepingTunableParamsRef,
    housekeepingLlmResultCacheRef,
    enrichmentStoreRef,
    crmRecordMirrorStoreRef,
    fileMetaStoreRef,
    fileSourceConnResolverRef,
    getRemoteFileReadDeps,
    fileSourceSyncStateRef,
    contactSourceSyncStateRef,
    workEntitySourceMirrorRef,
    workEntitySourceSyncStateRef,
    workEntityEdgeStoreRef,
    workEntitySourceDependencyStoreRef,
    workEntityWriteExecutorRef,
    commitmentEvidenceRuntimeRef,
    resolveCommitmentEvidenceCounterparty,
    composeWorkEntityWriteExecutor,
    resolveWorkEntityCatalogManifestRef,
    reconcileWorkEntitySourcesRef,
    registerWorkEntitySourceReconcilerRef,
    enrichmentCascadeRef,
    externalContextRegistryRef,
    connectionStoreRef,
    contractGrantStoreRef,
    connectionCatalogBindingStoreRef,
    contractStoreRef,
    sellerStoreRef,
    sellerOrderStoreRef,
    webhookIngressStoreRef,
    webhookDeliveryStoreRef,
    webhookConsumerStoreRef,
    sellerClaimStoreRef,
    receptionManageCredentialStoreRef,
    clientTokensRef,
    engagementStoreRef,
    engagementRateControlStoreRef,
    vendorRateGateRef,
    engagementCapabilityStoreRef,
    contactStoreRef,
    contactEngagementsResolveDepsRef,
    remergePromptStoreRef: contactBundle.remergePromptStore,
    contactMergeCycleObserverRef: contactBundle.contactMergeCycleObserver,
    upstreamMergeStoreRef: contactBundle.upstreamMergeStore,
    contactBackfillDone: contactBundle.backfillDone,
  };
};
