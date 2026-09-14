import { withQueuedChatTurns } from '../../chat-turn-queue.js';
import { createChatMessengerBridge } from '../../chat-messenger-bridge.js';
/** D-137 — boot composer for the AI Chat substrate.
 *
 *  Wires the per-pair chat surface end-to-end:
 *    - SQLite-backed ChatStore + ChatToolCatalogStore +
 *      ChatConnectionMcpStore + ChatInboundTokenStore
 *    - First-party middleware registry + D-164 P4 prompt-cache
 *      registration (the registry is a substrate hook today — no
 *      consumer reads it; D-164 P4 builds on it)
 *    - SQLite-backed plan approvals + execution receipts
 *    - Tool-handler bundle (Tier 1 + Tier 2 dispatch over the
 *      `InternalToolRegistry`) with late-bound getters for every
 *      downstream store the chat surface dispatches against
 *    - Tier 3 source backed by a per-call filter that drops MCP
 *      annotations whose connection rows were removed (D-137 W2.3
 *      Codex P2 fold)
 *    - Direct `executeLLM` closure used as the chat-orchestrator's
 *      `executeAiCall` handle (D-164 P6.0 (b) — no framework seam).
 *      Aliasing-only on the PII path (D-191 retired the force-local
 *      availability masking; routing is slot_1/slot_2/free_pool, and a
 *      manual pick of a configured slot is fail-closed via `pinSlot`)
 *    - ChatOrchestrator + ChatRpcDeps
 *
 *  Late-bound late-resolution invariant: many of the stores referenced
 *  by chat tool dispatch (contact, collection-registry, enrichment,
 *  connection, mcp-visibility, executor-config, execute-handler-deps)
 *  bootstrap LATER in `bin.ts` than the chat surface does. Every late
 *  reference flows through a getter that resolves at dispatch time —
 *  the closures here MUST NOT capture the current value at compose
 *  time, only the getter. The orchestrator never fires a turn until
 *  every downstream store has wired, so undefined-getter paths are
 *  test-harness only (surface `execution_error` rather than
 *  crashing).
 */

import type Database from 'better-sqlite3';
import { createServerTimeZoneStore } from '../../storage/server-timezone-store.js';
import { resolveServerTimeZone } from '@recued/contracts';
import { canonicalOpToolsForConnections } from '../../canonical-op-tool-catalog.js';
import { resolveConnectionVendor } from '../../storage/connection-store.js';
import {
  LLMError,
  executeLLM,
  createDefaultTranscriptionRegistry,
} from '@recued/llm';
import { resolveChatInputTokenBudget } from '../../chat-context-budget.js';
import type { PreflightRunSettled } from '../../preflight-resumer.js';
import { buildPriorToolPointers } from '../../chat-orchestrator.js';
import { createChatRunSettledSink } from '../../chat-run-settled-sink.js';
import {
  CHAT_MESSAGE_RECALL_ELIGIBILITY,
  deriveChatMessageRecallEligibility,
} from '../../storage/chat-store.js';
import type {
  AdapterRegistry as LLMAdapterRegistry,
  LLMConfig,
  QuotaTracker,
  TranscribeDeps,
  TokenUsage,
} from '@recued/llm';
import type {
  ChatModelRoutingLayer,
  ChatModelSourceId,
  ConnectionMcpAnnotationState,
  InternalToolRegistry,
  WebChatTab,
} from '@recued/contracts';
import type { ExecutionSource, ToolEntry } from '@recued/contracts';
import { isExecutionSource, opGrantEntry, recipeGrantEntry, primitiveGrantEntry,
  isGrantableKernelOp,
  isRegisteredKernelOp,
  RAW_OP_TOOL_PREFIX,
} from '@recued/contracts';
import { deriveResolvedRecipeCapability } from '../../derive-recipe-capability.js';
import {
  composeRecipeIngredientKindResolver,
  composeRecipeOpKindsResolver,
  composeRecipeOpResolver,
} from '../../recipe-capability-wiring.js';
import {
  analyzeReceptionRecipeCost,
  RECEPTION_RECIPE_MAX_STEPS,
} from '../../reception-recipe-cost-policy.js';
import {
  KERNEL_OP_REGISTRY,
  CHAT_CATALOG_DELIVERY_MODES,
  isEnrichmentTopic,
  resolveEnrichmentTrustDefault,
  type EnrichmentTopic,
  type EnrichmentTrustState,
} from '@recued/contracts';
import { createMiddlewareRegistry } from '@recued/middleware';

import { createInternalToolRegistry } from '@recued/middleware/internal-tool-registry/index.js';
import { buildTier2Catalog, createOpKindLookup, hashRecipe, parseRecipe } from '@recued/recipes';
import { registerFirstPartyMiddlewares } from '@recued/middleware-recued';
import { registerPromptCacheMiddleware } from '@recued/middleware-prompt-cache';
import { buildPackOpResolution } from '../../pack-inventory.js';
import { createContactPrefetchSearch } from '../../chat-prefetch-search.js';
import { createTrustStore } from '../../housekeeping/index.js';
import { wrapRegistryWithEnrichmentTopicTools } from '../../chat-enrichment-topic-tools.js';
import { wrapChatRegistryForCatalogModes } from '../../chat-tools-search.js';
import { createRecallSearchBackend } from '../../chat-recall-search.js';
import { wrapRegistryWithRecallSearch } from '../../chat-recall-search-tool.js';
import { createPromptCacheGateDeps } from '../../chat-prompt-cache-gate.js';
import { createContactKnownValueIndexBuilder } from '../../chat-recall-index.js';
import {
  createSessionForwardedSenderIndex,
  type SessionForwardedSenderIndex,
} from '../../chat-forwarded-sender-index.js';
import type { ScopedGrantParseDeps } from '../../chat-scoped-grant-middleware.js';
import { composeSpanAnchor } from './wire-span-anchor.js';
import {
  composeExecutionCases,
  readExecutionCaseExperimentEnv,
  type ComposedExecutionCases,
} from './wire-execution-cases.js';
import type {
  ExecutionCaseLifecycle,
} from '../../chat-execution-case-tools.js';
import {
  eligiblePrecedentRowFlows,
  executionCaseLearnedEntry,
  selectOriginObservation,
} from '../../execution-case-precedent.js';
import {
  buildRecipeAuthoringVocabulary,
  draftRecipeForCase,
  recipeShapeExample,
  RECIPE_DRAFT_MANIFEST,
  RECIPE_DRAFT_FIELDS,
} from '../../execution-case-recipe-draft.js';
import {
  aliasCasePromptForAuthoring,
} from '../../execution-case-draft-egress.js';
import {
  createChatPiiSlotOrderingSeeder,
} from '../../chat-pii-slot-ordering.js';
import { KERNEL_MANIFESTS } from '../../kernel-manifests.js';
import {
  createExecutionCaseAuthoredStore,
  recordAuthoredLink,
  resolveAuthoredState,
} from '../../storage/execution-case-authored-store.js';
import { createScopedGrantSuggestionStore } from '../../storage/scoped-grant-suggestion-store.js';
import { createConnectionCatalogBindingStore } from '../../storage/connection-catalog-binding-store.js';
import { createChatConnectionPackCoverage } from '../../chat-connection-pack-coverage.js';
import type { ContractStore } from '../../storage/contract-store.js';
import { createContractDefinitionStore } from '../../storage/contract-definition-store.js';
import { createContractStore } from '../../storage/contract-store.js';
import { backfillInboundTokenContracts } from '../../storage/inbound-token-contract-backfill.js';
import type { WorkEntityResolver } from '../../work-entity-resolver.js';
import type { WorkEntityEdgeStore } from '../../storage/work-entity-edge-store.js';
import type { WorkEntityTargetedReadDeps } from '../../work-entity-write-executor.js';
import type { WorkEntityCrudRpcDeps } from '../../work-entity-crud-handler.js';
import type { CalendarWriteDeps } from '../../chat-tool-handlers.js';
import { createGatedReadGrantResolver } from '../../read-grant-checker.js';
import {
  deriveBoundCrmMirrorSources,
  deriveBoundCrmConnections,
  syncedAtFromReconcileState,
  liveVendorRegistry,
} from '../../connection-convention-families.js';
import { createHousekeepingStateStore, type HousekeepingStateStore } from '../../housekeeping/state-store.js';
import { reconciliationTaskId } from '../../housekeeping/reconciliation/vendor-reconciler.js';
import { buildCanonicalPollDeps } from '../../watch/canonical-poll-deps.js';
import { runCanonicalWatchPoll } from '../../watch/canonical-poll.js';
import { deriveChannelSessionId, piiEgress } from '@recued/gateway';
import type { AuditLogStore, Collection } from '@recued/storage';
import type { AnnotationRpcDeps } from '../../annotation-handler.js';
import {
  createChatStore,
  ensureChatSchema,
  type ChatStore,
} from '../../storage/chat-store.js';
import { createSqliteChatPlanStore } from '../../storage/chat-plan-store.js';
import {
  createChatToolCatalogStore,
  ensureChatToolCatalogSchema,
  type ChatToolCatalogStore,
} from '../../storage/chat-tool-catalog-store.js';
import {
  createChatConnectionMcpStore,
  ensureChatConnectionMcpAnnotationSchema,
  type ChatConnectionMcpStore,
} from '../../storage/chat-connection-mcp-store.js';
import {
  createChatInboundTokenStore,
  ensureChatInboundTokenSchema,
  type ChatInboundTokenStore,
} from '../../storage/chat-inbound-token-store.js';
import {
  buildChatIndexContext,
  chatIndexSessionRowsEnabled,
  CHAT_INDEX_TOO_COMMON_CAP,
  CHAT_INDEX_PROBE_ARGS,
  chatIndexProbeTool,
} from '../../chat-index-context.js';
import {
  RECALL_SEARCH_TOOL_NAME,
  registerRecallTurnSource,
  registerVisibleInteractionItemIds,
} from '../../chat-recall-search-tool.js';
import type { ChatDispatchContext } from '../../chat-tool-handlers.js';
import {
  broadcastEmitterFromBus,
  createChatOrchestrator,
  parseChatCatalogProjectionEnv,
  resolveCatalogProjectionForSource,
  type ChatOrchestrator,
  type ExecuteChatAiCall,
} from '../../chat-orchestrator.js';
import {
  createChatSessionBusyRegistry,
  withChatSessionBusy,
} from '../../chat-session-busy.js';
import {
  resolveLlmSystemPrompt,
  type LlmPromptSurface,
} from '../../llm-system-prompt.js';
import type { ChatRpcDeps } from '../../chat-handler.js';
import { assertRecordsNonOwnerRecipeExposure } from '../../records/non-owner-exposure.js';
import { buildChatToolRegistryInputs } from '../../chat-tool-handlers.js';
import type { FileViewResolver } from '../../file-view-resolver.js';
import { DATA_FILE_RECEIVED_SLUG } from '../../collections/file/file-read-handler.js';
import { tokenUsageToReport } from '../../chat-token-usage.js';
import type { EventBus } from '../../events/bus.js';
import type { KeyManager } from '../../key-manager.js';
import type { ContactStore } from '../../storage/contact-store.js';
import type { MemoryEmbedder, UserMemoryStore } from '../../user-memory-store.js';
import type { MemoryRedactionRecord } from '../../memory-rpc-handler.js';
import { createCorrectionEventsStore } from '../../storage/correction-events-store.js';
import { createLocalManifestStore } from '../../ingredient-authoring/local-manifest-store.js';
import { createMetaFieldPrivacyResolverFromLocalManifestStore } from '../../meta-field-privacy-resolver.js';
import {
  CANONICAL_PII_ENTITY_SCHEMAS,
  CANONICAL_PII_CATALOG_MANIFESTS,
  CANONICAL_PII_ENTITY_PRIVACY_TAGS,
} from '../../canonical-pii-schemas.js';
import type { EnrichmentStore } from '../../storage/enrichment-store.js';
import type { CrmRecordMirrorStore } from '../../storage/crm-record-mirror-store.js';
import type { ConnectionStoreSqlite } from '../../storage/connection-store.js';
import type { CollectionRegistry } from '../../collections/registry.js';
import type { RecipeStore } from '../../recipe-store.js';
import type { ServerExecutorConfig } from '../../server-executor.js';
import type { PairedInstancesStore } from '../../paired-instances-store.js';
import type { ExecuteHandlerDeps } from '../../execute-handler.js';
import type { SharedStore } from '../../storage/shared-store.js';
import { handleExecute } from '../../execute-handler.js';
import {
  buildMcpGrantCatalogLegacyEntries,
  buildRecipeOpCoverage,
} from '../../mcp-server.js';
import { sweepMcpRecipeCallbackRetention } from '../../mcp-recipe-callback.js';

/** Direct + late-bound dependencies the chat composer needs. */
export interface ComposeChatOrchestratorDeps {
  db: Database.Database;
  keys: KeyManager | undefined;
  eventBus: EventBus;
  auditLog: AuditLogStore | undefined;
  serverInstanceId: string;
  recipeStore: RecipeStore;
  llmConfig: LLMConfig | undefined;
  /** D-174 R28 Slice A — per-use LIVE LLM-config getter (off
   *  `llmManager.getConfig()`), injected into the chat store so the persisted
   *  default `source_id` resolves to a concrete `{layer, model_hint}` against
   *  the current config at read time (a slot's speed/locality can change via
   *  field-level writes). Distinct from the boot-snapshot `llmConfig`. */
  getLlmConfig: () => LLMConfig | undefined;
  /** D-250 § D — the owner's daily token counter (`LLMConfigManager.addUsage`).
   *
   *  ⛔ CHAT NEVER REACHED IT, AND THAT MADE THE BUDGET A HALF-MEASURE. The
   *  daily budget is enforced by `isOverBudget`, which reads the counter that
   *  only the RECIPE executor fed — so `schedule_cutoff`, `warning` and
   *  `hard_limit` all governed automation while chat, typically the largest
   *  consumer, spent freely past every threshold. The turn's own usage was
   *  captured here all along and used only to build the transparency event.
   *
   *  ⚠ SEPARATE FROM the `chat_message_sent` audit row, which is the RECORD.
   *  This is the GATE. Both are fed from the same provider result and neither
   *  substitutes for the other. */
  addOwnerTokenUsage?: (tokens: number) => void;
  llmQuota: QuotaTracker;
  llmAdapterRegistry: LLMAdapterRegistry;
  emptyTabProbe: () => Promise<Set<WebChatTab>>;
  pairedInstances: PairedInstancesStore | undefined;
  annotationDeps?: AnnotationRpcDeps | undefined;
  /** Existing durable shared store used by the recipe-callback mailbox. */
  sharedStore?: Pick<SharedStore, 'list' | 'read' | 'compareAndSet'> | undefined;
  /** Late-bound late-resolution getters — see module doc. */
  getContactStore: () => ContactStore | undefined;
  getCollectionRegistry: () => CollectionRegistry | undefined;
  /** The unified local+remote file view `file.search`'s owner-wide scope reads.
   *  Late-bound because the D-192 meta store is assigned after this wire is
   *  built; absent ⇒ the tool falls back to the single-collection read, which is
   *  the pre-existing behaviour. */
  getFileViewResolver?: () => FileViewResolver | undefined;
  getEnrichmentStore: () => EnrichmentStore | undefined;
  /** D-198 Slice 4 — the `user_memory` store the `memory.write` chat tool writes
   *  to + the widened `memory.search` unions. Late-bound like the other store
   *  getters; absent (db-less) → the write tool degrades + search stays
   *  audit-only. */
  getUserMemoryStore?: () => UserMemoryStore | undefined;
  /** D-198 Slice 4 — the redaction-marker store so `memory.search` omits
   *  "forgotten" rows from recall. Late-bound alongside the user_memory store. */
  getMemoryRedactionStore?: () => Collection<MemoryRedactionRecord> | undefined;
  /** RUNG 4 — the query embedder `memory.search` falls through to when NO
   *  lexical rung matched. Late-bound + optional: absent leaves rung 4 off and
   *  keeps the tool a zero-token SQL read. */
  getMemoryEmbedder?: () => MemoryEmbedder | undefined;
  /** D-190 (generic reconciler MS3) — the dedicated CRM record mirror that
   *  `deal.search` reads (the producer-independent base-row store MS2 writes).
   *  Late-bound like the other store getters; absent → deal.search returns empty. */
  getCrmRecordMirror?: () => CrmRecordMirrorStore | undefined;
  getConnectionStore: () => ConnectionStoreSqlite | undefined;
  getExecutorConfig: () => ServerExecutorConfig | undefined;
  getExecuteDeps: () => ExecuteHandlerDeps | undefined;
  /** D-177 N.11 rule 5 (5.c, slice C) — the contract store, for the
   *  scoped-grant parse hook's suggestion store + binding store. Late-bound
   *  (the contract store bootstraps after the chat surface in
   *  compose-app-context); absent or resolving undefined → the parse hook
   *  is a faithful no-op. */
  getContractStore?: () => ContractStore | undefined;
  /** D-192 read resolution — `work.search` / `work.read` deps: the
   *  freshness-enabled work-entity resolver + the targeted-read spine
   *  (populated by the post-listener runtime). Late-bound like every
   *  other store getter; absent → the tools surface `execution_error` /
   *  local-only degradation. */
  getWorkEntityResolver?: () => WorkEntityResolver | undefined;
  getWorkEntityTargetedReadDeps?: () => WorkEntityTargetedReadDeps | undefined;
  /** Slice 1 — the LOCAL work-entity write deps behind the Tier-1
   *  `work.create` tool. Same late-bound shape as the read deps above. */
  getWorkEntityCrudDeps?: () => WorkEntityCrudRpcDeps | undefined;
  /** Slice 2 — the calendar write dispatchers. */
  getCalendarWriteDeps?: () => CalendarWriteDeps | undefined;
  /** D-192 P5 edges — backs `work.read`'s `include_related`. */
  getWorkEntityEdgeStore?: () => Pick<WorkEntityEdgeStore, 'listByOwner'> | undefined;
}

/** Everything `bin.ts` retains on the module-scope `let`-bindings. */
export interface ChatOrchestratorBundle {
  /** D-137 — writes the RESULT half of a paired tool call when a held run
   *  settles, long after the turn that asked for it ended. Published into the
   *  execution refs bag at boot; see `publishRunSettledSink`. */
  readonly runSettledSink: (settled: PreflightRunSettled) => void;

  chatStore: ChatStore;
  toolCatalogStore: ChatToolCatalogStore;
  connectionMcpStore: ChatConnectionMcpStore;
  inboundTokenStore: ChatInboundTokenStore;
  internalRegistry: InternalToolRegistry;
  orchestrator: ChatOrchestrator;
  chatDeps: ChatRpcDeps;
  /** D-214 close/compile hook, retained for plan cancellation and the existing
   * D-157 approval-staleness sweep. */
  executionCaseLifecycle: ExecutionCaseLifecycle;
  executionCaseVerificationRecorder:
    ComposedExecutionCases['verificationRecorder'];
  /** D-219 slice 9c — the boot hand-off for the owner-facing offer. The
   *  notification block is composed AFTER the chat substrate, so the block's
   *  owner pushes it here rather than this composer pulling it. Until it is
   *  called, the offer is never raised and never retired. */
  publishExecutionCaseOfferNotifier:
    ComposedExecutionCases['publishExecutionCaseOfferNotifier'];
  /** D-219 — the capture-only argument buffer, surfaced so the retention
   *  pruner can bound it. ⛔ No read path consumes it. */
  executionCaseArgumentStore: ComposedExecutionCases['argumentStore'];
  /** D-219 — the source-corpus retention sweep, narrowed to the one method so
   *  this hand-off cannot compile, rebuild, or delete a root. */
  executionCaseSourcePruner:
    Pick<ComposedExecutionCases['compiler'], 'pruneSourcesOlderThan'>;
  /** D-177 N.11 rule 5 (5.d hot-path) — the per-session forwarded-sender
   *  candidate index; slice D threads `candidates()` into the gateway's
   *  scoped-grant match context. */
  forwardedSenderIndex: SessionForwardedSenderIndex;
}

/** Compose the chat substrate. Synchronous — no I/O at compose time;
 *  every dispatch path resolves through the late-bound getters. */
export const composeChatOrchestrator = (
  deps: ComposeChatOrchestratorDeps,
): ChatOrchestratorBundle => {
  const {
    db,
    keys,
    eventBus,
    auditLog,
    serverInstanceId,
    recipeStore,
    llmConfig,
    getLlmConfig,
    llmQuota,
    llmAdapterRegistry,
    emptyTabProbe,
    pairedInstances,
    sharedStore,
    getContactStore,
    getCollectionRegistry,
    getEnrichmentStore,
    getUserMemoryStore,
    getMemoryRedactionStore,
    getMemoryEmbedder,
    getCrmRecordMirror,
    getConnectionStore,
    getExecutorConfig,
    getExecuteDeps,
    getContractStore,
    getWorkEntityResolver,
    getWorkEntityTargetedReadDeps,
    getWorkEntityCrudDeps,
    getCalendarWriteDeps,
    getWorkEntityEdgeStore,
  } = deps;

  // D-160 P2 + D-164 P4 — first-party middleware registry.
  // `registerPromptCacheMiddleware` lands on top of the first-party
  // bundle so the prompt-cache `before-turn` hook is reachable when its
  // consumers wire.
  //
  // D-160 O-5 (light slice) — the registry is now a LIVE consumer: it is
  // threaded into the orchestrator (below), which invokes the two
  // source-wired middlewares — `correction-learning` (before-turn) +
  // `personal-recipes` (after-turn) — at its turn seams via
  // `chat-stream-middleware.ts`. The orchestrator still owns the AI call
  // directly (`executeAiCall`, D-164 P6.0 (b)) — it does NOT run the
  // D-160 `runStream` pipeline; the two hooks are invoked inline. The
  // other registered middlewares (scope-search /
  // confidence-shape / prompt-cache) stay registered-but-unfed — their
  // producers are the heavy O-5 follow-ons + the D-164 P6 catalog
  // consumer.
  const middlewareRegistry = createMiddlewareRegistry();
  registerFirstPartyMiddlewares(middlewareRegistry);
  // Prefetch entity resolution (internal design notes):
  // wire the contact-backed search so the before-turn hook resolves entities
  // the user named and contributes them as labeled "verify" context — saving
  // a tool-call turn. Contributes nothing when no contact matches (zero-harm).
  // The fast-query FTS&RAM index that will replace this whole-warehouse scan is a
  // prefetch concern (D-167 §1.A).
  //
  // D-164 § 3 — also wire the REAL gate deps (contact-attribute template
  // matcher + warehouse data-presence probe + body renderer) so the
  // deterministic short-circuit FIRES: a chat turn whose answer is already in
  // the warehouse ("what is <Name>'s email?") resolves with ZERO LLM calls.
  // Replaces the no-op `DEFAULT_GATE_DEPS` (which always passed through). The
  // probe reads the same per-pair contact store as the prefetch. The
  // connection + enrichment getters feed ONLY the has-email family's
  // CRM-coverage check (the deterministic "no" fires just when no CRM contact
  // source — enrolled connection or surviving platform mirror — could
  // contradict the local store). The contract-scan getter feeds the P10
  // read-permission seam (surface scope = the policy cell that would admit
  // the equivalent storage read; late-bound off executeDeps so the seeded /
  // store-edited `contract.policy_matrix.*` cells apply once wired).
  registerPromptCacheMiddleware(middlewareRegistry, createPromptCacheGateDeps(getContactStore, getCollectionRegistry, getConnectionStore, getEnrichmentStore, () => getExecuteDeps()?.contractScan), {
    search: createContactPrefetchSearch(getContactStore),
  });

  // Codex P1 fold (D-137 P1.2 review) — always wire the chat sub-DEK
  // key provider when KeyManager exists, regardless of state. Provider
  // returns null while uninitialized/locked, which causes
  // `requireChatKey` to throw rather than falling through to a base64-
  // plaintext encoding. Chat content is the most personal-context-
  // dense surface in the substrate; the spec's "encrypted at rest"
  // contract MUST hold whenever the encryption substrate exists.
  const chatKeyProvider = keys ? keys.keyProvider('chat') : undefined;
  ensureChatSchema(db);
  ensureChatToolCatalogSchema(db);
  ensureChatConnectionMcpAnnotationSchema(db);
  ensureChatInboundTokenSchema(db);
  const chatStore = createChatStore(db, chatKeyProvider, getLlmConfig);
  const getSpanAnchorDeps = composeSpanAnchor({ db, chatKeyProvider });
  // Same durable store threads into the dispatch gate, approval RPCs, and
  // session snapshots. Construction never resumes work: a row left `running`
  // by a prior process is reconciled to recovery-only `unknown`.
  const planApprovalStoreShared = createSqliteChatPlanStore(
    db,
    chatKeyProvider,
  );
  // D-174 R28 Slice A — onboarding default (model source). When a provider IS
  // configured but the user has never chosen a chat-model default, seed it to
  // the FIRST configured source (`slot_1` → `slot_2` → `free_pool`) so chat
  // works out of the box. Slot-faithful (NOT local-first): locality no longer
  // picks the default — `'local'` is a display badge, and routing collapses
  // local/byok, so the first slot is honoured whether local or remote. Fires
  // ONLY when unset (`updated_at === 0`); an explicit user choice always wins,
  // and it stays changeable in Settings → AI/Models → Preference.
  if (llmConfig && chatStore.getDefaultModelSourceId().updated_at === 0) {
    const derivedDefaultSourceId: ChatModelSourceId | undefined =
      llmConfig.slot_1 !== undefined
        ? 'slot_1'
        : llmConfig.slot_2 !== undefined
          ? 'slot_2'
          : (llmConfig.free_pool ?? []).length > 0
            ? 'free_pool'
            : undefined;
    if (derivedDefaultSourceId) {
      chatStore.setDefaultModelSourceId(derivedDefaultSourceId);
    }
  }
  const toolCatalogStore = createChatToolCatalogStore(db);
  const connectionMcpStore = createChatConnectionMcpStore(db);
  let inboundTokenStore: ChatInboundTokenStore;
  inboundTokenStore = createChatInboundTokenStore(db, {
    ...(sharedStore
      ? {
          onAuthorityChanged: (token_id: string) =>
            sweepMcpRecipeCallbackRetention({
              store: sharedStore,
              inboundTokenStore,
              token_id,
            }).then(() => undefined),
        }
      : {}),
  });

  // ⛔⛔ BOOT BACKFILL — give every UNBOUND inbound token a contract, and
  // TRANSFER its lifecycle onto that contract rather than minting an empty
  // carrier. Always-contracted issuance was forward-only, so tokens already in
  // the field carry none — and those are exactly the ones nothing is watching:
  // `shouldMeterUse` requires a MINTED contract, so for them the contract
  // enforces nothing at all.
  //
  // Kicked HERE because this is where the token table is guaranteed to exist
  // (`createChatInboundTokenStore` runs its schema guard). `createContractStore`
  // is a stateless db wrapper — the same reasoning the storage composer states
  // for building a fresh one — so there is no boot-ordering dependency.
  //
  // ⚠ Idempotent (only `contract_id IS NULL` rows) and best-effort per row: a
  // failed row stays unbound and the next boot retries it. Never throws — one
  // bad row must not block startup.
  try {
    const backfill = backfillInboundTokenContracts(
      db,
      createContractDefinitionStore(createContractStore(db)),
    );
    if (backfill.unbound > 0) {
      console.warn(
        `[mcp-token-backfill] contracted ${backfill.bound}/${backfill.unbound} unbound tokens`
        + ` (${backfill.revoked} carried a revocation, ${backfill.failed} failed — retried next boot)`,
      );
    }
  } catch {
    // Best-effort; the sweep already swallows per-row failures.
  }

  // D-160 O-5 (light slice) — read view over the per-pair correction
  // stream (D-145 PB14) for the `correction-learning` middleware's
  // before-turn hook. The store is a stateless prepared-statement wrapper
  // over `db` with an idempotent `CREATE TABLE IF NOT EXISTS` schema, so
  // constructing it here (rather than threading the single instance
  // `wire-per-pair-stores.ts` builds for retention pruning through three
  // boot-composition files) is read-equivalent — SQLite is the only
  // source of truth — and keeps this wiring local to the chat composer,
  // matching how the chat-owned stores above are built straight from `db`.
  const correctionEventsStore = createCorrectionEventsStore(db);

  // D-167 P5 S4 — the per-pair session alias-ledger store (RAM-only, never
  // persisted, never synced) the always-on `pii-protect` / `pii-restore`
  // bookend hooks allocate against.
  const sessionLedgerStore = piiEgress.createSessionLedgerStore();
  /** D-219 item 2b — per-case singleflight for recipe drafting. Server-side
   *  because the panel's guard only covers one mounted instance. */
  const draftsInFlight = new Set<string>();

  // D-167 activation — the runtime `MetaField.privacy` source that replaces
  // `noopFieldPrivacyResolver`. D-170 persists decomposed entity schemas in the
  // local manifest store; this resolver reads their `privacy`-tagged fields per
  // egress packet and turns them into the `FieldPrivacyResolver` the
  // `pii-protect` hook applies at the wire seam. Like `sessionLedgerStore` above, a
  // second read-only store over the same per-pair `db` is behavior-identical to
  // the one the D-170 install path builds — SQLite is the single source of
  // truth, the schema bootstrap is idempotent, and the resolver reads live per
  // packet — so constructing it locally keeps this wiring off the shared compose
  // seams. Per packet: a scope whose installed entity schema carries
  // `privacy`-tagged `MetaField`s (authorable via the D-170 entity-field table)
  // gets those fields aliased; a scope with none resolves to `[]`, the alias pass
  // short-circuits, and the egress flow round-trips byte-identical (the no-op the
  // noop resolver always held).
  const fieldPrivacyResolver = createMetaFieldPrivacyResolverFromLocalManifestStore(
    createLocalManifestStore(db),
    // D-167 default-on PII protection: union the shipped first-party canonical /
    // CRM privacy-tagged schemas so a chat catalog-op result (e.g. a HubSpot
    // contact read) is aliased on egress with zero install — the per-pair
    // `local_manifest` only adds the user's own authored compositions on top.
    CANONICAL_PII_ENTITY_SCHEMAS,
    // ...and the built-in CRM catalogs' operation-id index so the resolver
    // matches the fully-qualified `recued-core/<vendor>.contact.read` tool name
    // those connection catalogs surface (they aren't in `local_manifest`).
    CANONICAL_PII_CATALOG_MANIFESTS,
    // D-167 E.1/P2 — the operation-FREE entity-marker privacy tags. With the P2
    // producers now stamping `__entity` (the 3 chat projections + the prefetch
    // gather), wiring these live lets the resolver alias a contact/deal record
    // by its inline marker WHEREVER it re-embeds (the candidate envelope + every
    // confidence-shape slot + the prefetch block) from ONE declaration — the
    // per-envelope re-declaration the explicit `CONTACT_SEARCH`/`DEAL_SEARCH`
    // paths carry (those STAY in P2; the resolver dedups `(path, kind)` so no
    // double-alias — retired in P3). Closes bench task 41.
    CANONICAL_PII_ENTITY_PRIVACY_TAGS,
  );

  // Codex W2.3 review P2 fold — filter annotation projection against
  // live MCP connections. A persisted annotation row whose underlying
  // D-125 connection has been deleted (or was never `kind='mcp'`)
  // would otherwise surface phantom Tier 3 tools in the chat catalog
  // until the row is manually removed. The filter scopes BOTH the
  // catalog projection (tier3Source) AND the orchestrator's
  // transparency-stream disabled-set derivation (annotationProvider),
  // so the two stay consistent.
  //
  // Closure timing: `getConnectionStore` resolves at dispatch time —
  // when undefined (dbless harness / pre-init window) the filter falls
  // open and the raw annotation list passes through.
  const listLiveMcpAnnotations = (): ReadonlyArray<ConnectionMcpAnnotationState> => {
    const all = connectionMcpStore.listAnnotations();
    const store = getConnectionStore();
    if (!store) return all;
    return all.filter((ann) => store.get('mcp', ann.connection_name) !== null);
  };

  // M-CHAT-2 → D-177 P2b — the Tier 3 direct connection-adapter dispatch
  // that lived here (`dispatchTier3Outbound` + a chat-local mcp handler
  // pool) is deleted: `createChatTier3Dispatch` now routes outbound MCP
  // calls through the run-ingredient kernel recipe + `handleExecute`
  // (via `getExecuteRecipe` below), so the commit Gateway + policy
  // verdict + preflight ask apply like every other dispatch and the
  // engine's own `connection.mcp` handler pool serves the wire call.

  // S1 (CRM mirror freshness) — a lazily-memoized read view over the housekeeping
  // state table (the same SQLite the reconciler writes). Mirrors `readTrustState`
  // below: the chat surface composes BEFORE `composeHousekeepingStores` ensures the
  // schema (compose-app-context order), so the store must NOT prepare statements at
  // compose time — retry-while-undefined picks the table up once housekeeping boots;
  // an absent table / db ⇒ `synced_at: null` (the never-synced semantics).
  let chatReconcileStateStore: HousekeepingStateStore | undefined;
  const reconcileSyncedAt = (
    vendor: string,
    entity: string,
    connection_name: string,
  ): number | null => {
    if (!chatReconcileStateStore) {
      if (!deps.db) return null;
      try {
        chatReconcileStateStore = createHousekeepingStateStore(deps.db);
      } catch {
        return null; // pre-housekeeping-boot window — table not yet created.
      }
    }
    return syncedAtFromReconcileState(
      chatReconcileStateStore.get(reconciliationTaskId(vendor, entity, connection_name)),
    );
  };

  // D-137 Trio #A — Tier 1 handlers + Tier 2 source/manifest/dispatch.
  // Late-bound getters resolve at dispatch time so the registry
  // composes before collection / executor / executeDeps are built.
  // ⛔⛔ D-228 slice 3 — ONE coverage lookup, TWO consumers, built ONCE.
  // The chat CATALOG withdraws a covered Tier-3 name and the Tier-3 DISPATCH
  // refuses it, and those two must answer identically: a name the catalog still
  // advertises but the dispatch refuses is a broken tool, and the reverse is the
  // weaker gate reachable by anyone who remembers the name. Two independently
  // built closures would be free to drift, which is precisely how
  // § 234.4p.16d's deps slice went wrong one subsystem over.
  //
  // Late-bound off the same getters everything else here uses, so a pack
  // installed mid-session takes effect on the next turn.
  const connectionMcpPackCoverage = (
    connection_name: string,
  ): ReadonlySet<string> | undefined => {
    const contractStore = getContractStore?.();
    const manifests = getExecutorConfig()?.manifests;
    if (!contractStore || !manifests) return undefined;
    return createChatConnectionPackCoverage({
      bindingStore: createConnectionCatalogBindingStore(contractStore),
      getManifest: (slug) => manifests.get(slug),
    })(connection_name);
  };

  const chatToolRegistryInputs = buildChatToolRegistryInputs({
    getContactStore,
    getCollectionRegistry,
    // D-172 P2 — `file.search`'s DEFAULT (session) scope reads this session's
    // own message rows for their attachments. Without it the tool would have
    // only the owner-wide scope, which is the one we deliberately made
    // opt-in — so the seam being wired is what keeps the safe default usable.
    getChatStore: () => chatStore,
    // D-192 Fork B — the owner-wide file scope now spans enrolled remote
    // Sources, not just the CAS collection. See `getFileViewResolver`.
    ...(deps.getFileViewResolver ? { getFileViewResolver: deps.getFileViewResolver } : {}),
    getAuditLog: () => auditLog,
    // D-198 Slice 4 — memory.write target + memory.search union source + the
    // redaction store (recall omits forgotten rows) + the realtime bus so an AI
    // memory write live-refreshes paired Memory lenses.
    ...(getUserMemoryStore ? { getUserMemoryStore } : {}),
    ...(getMemoryRedactionStore ? { getMemoryRedactionStore } : {}),
    ...(getMemoryEmbedder ? { getMemoryEmbedder } : {}),
    getEventBus: () => eventBus,
    getEnrichmentStore,
    // D-190 (generic reconciler MS3) — the CRM record mirror deal.search reads.
    ...(getCrmRecordMirror ? { getCrmRecordMirror } : {}),
    getRecipeStore: () => recipeStore,
    getExecutorConfig: () => {
      const executorConfig = getExecutorConfig();
      if (!executorConfig) {
        throw new Error('executorConfig not yet wired');
      }
      return executorConfig;
    },
    getExecuteRecipe: () => {
      const executeDeps = getExecuteDeps();
      return executeDeps
        ? (req) => handleExecute(executeDeps, req)
        : undefined;
    },
    // D-259 § 7.4.3 — the SAME registry instance the executor and the MCP
    // stop use. Late-bound for the same reason as the executor above: this
    // composes before the executor exists. A SECOND instance here would mean
    // the chat door could not see the runs the other doors registered.
    getInFlightRegistry: () => getExecuteDeps()?.inFlightRegistry,
    // D-225 § 9.5.1 step 2b — the raw-op dispatch deps, late-bound for the same
    // reason `getExecuteRecipe` is: this composes before the executor exists.
    // `dispatchRawOp` takes a Pick of the execute deps, so this is the same
    // handle, narrowed by the callee rather than here.
    getRawOpDispatchDeps: () => getExecuteDeps(),
    // D-255 — the SAME builder `mcp-server` calls, so the owner's chat catalog and
    // a door's MCP catalog derive canonical tools from one source. The owner is the
    // `user_self` contract and a door is another contract id; a second producer
    // here would be an owner/door branch by another name. Late-bound for the same
    // reason its neighbours are — this composes before the execute deps exist.
    getCanonicalOpTools: () => {
      const ex = getExecuteDeps();
      return canonicalOpToolsForConnections(
        ex?.connectionStore,
        resolveConnectionVendor,
        ex?.connectionOperationProfiles,
      );
    },
    preflightExternalRecipeDispatch: (recipe) => {
      const recordsStore = getExecuteDeps()?.recordsStore;
      if (recordsStore === undefined) return;
      assertRecordsNonOwnerRecipeExposure(
        recipe,
        'mcp',
        {
          isOperationId: (operationId) => recordsStore.isInstalledOperationId(operationId),
          isCatalogOperation: (catalogSlug, operationKey) =>
            recordsStore.isInstalledCatalogOperation(catalogSlug, operationKey),
        },
      );
    },
    getConnectionMcpAnnotations: () => listLiveMcpAnnotations(),
    // D-228 slice 3 — the dispatch half of the swap (the catalog half is on the
    // orchestrator below, and it is the SAME closure).
    connectionMcpPackCoverage,
    // D-187 AMENDMENT — the chat `enrichment.search` mcp-wire reject resolves a topic's
    // `enrichment.<topic>` grant against the chat's bound contract, gated to standing
    // policy contracts. The resolver is a stateless wrapper over the SAME contract store,
    // constructed on demand.
    getReadGrantResolver: () => {
      const cs = getContractStore?.();
      return cs ? createGatedReadGrantResolver(cs) : undefined;
    },
    // D-190 — the per-source enable toggle (`getIsScopeSourceEnabled`) was dropped;
    // `deal.search` / `contact.search` fan out over the bound CRM connections, and a
    // bound connection is already the opt-in. No per-vendor prefs lookup to wire.
    //
    // The GENERIC source enumerator: the bound CRM connections × the LIVE merged
    // vendor registry (built-ins + installed-pack `crm_alias` entities), resolved at
    // dispatch so an enroll / install is reflected next turn. Replaces the old
    // hardcoded hubspot/salesforce deal source list.
    getBoundCrmMirrorSources: (crmAlias) =>
      deriveBoundCrmMirrorSources(
        crmAlias,
        getConnectionStore(),
        liveVendorRegistry(getExecuteDeps()?.localManifestStore),
      ),
    // S1 — per-connection mirror freshness (last successful reconcile wall-clock).
    getCrmConnectionFreshness: (crmAlias) =>
      deriveBoundCrmConnections(
        crmAlias,
        getConnectionStore(),
        liveVendorRegistry(getExecuteDeps()?.localManifestStore),
      ).map((c) => ({
        connection_name: c.connection_name,
        vendor: c.vendor,
        entity: c.entity,
        synced_at: reconcileSyncedAt(c.vendor, c.entity, c.connection_name),
      })),
    // S3 — live-fetch a connection's current set (the SAME gated + audited + projected
    // canonical poll the reconciler uses), for stale / narrow-miss escalation. Only an
    // `ok` AND `complete` poll is authoritative: an INCOMPLETE poll (pagination did not
    // prove a full walk — same `complete` gate S2 delete-detection uses) may return an
    // empty / partial map that is NOT the vendor's true current set. Returning it would
    // make the escalation drop mirror rows + report a server-fresh zero; instead treat
    // incomplete like unavailable (`null`) so the caller keeps the mirror (graceful).
    // D-192 CRM escalation parity — the handler's dispatch `origin` threads verbatim
    // onto the poll's gated invoke (honest audit attribution + per-actor tightening).
    getCrmLiveRecords: async ({ vendor, entity, connection_name, origin }) => {
      const executeDeps = getExecuteDeps();
      if (!executeDeps) return null;
      const outcome = await runCanonicalWatchPoll(
        buildCanonicalPollDeps(executeDeps, getConnectionStore()),
        { vendor, entity, connection_name, ...(origin !== undefined ? { origin } : {}) },
      );
      return outcome.ok && outcome.complete ? outcome.records : null;
    },
    // D-192 CRM escalation parity — the S3 admission seam's catalog binding:
    // the connection's operation profile names the bound catalog, the executor
    // config resolves its installed manifest (the SAME resolution
    // `runCanonicalWatchPoll` performs; unresolvable here fails the poll's own
    // config guards identically).
    getCrmEscalationBinding: (connection_name) => {
      const executeDeps = getExecuteDeps();
      if (!executeDeps) return null;
      const profile = executeDeps.connectionOperationProfiles?.get(connection_name);
      const catalogSlug = profile?.catalog_slug;
      if (catalogSlug === undefined || catalogSlug.length === 0) return null;
      const manifest = executeDeps.executorConfig.manifests.get(catalogSlug) ?? null;
      return manifest === null ? null : { catalogSlug, manifest };
    },
    // D-192 read resolution — work.search / work.read deps (pure
    // pass-through of the app-context late-bound refs).
    ...(getWorkEntityResolver ? { getWorkEntityResolver } : {}),
    ...(getWorkEntityTargetedReadDeps ? { getWorkEntityTargetedReadDeps } : {}),
    ...(getWorkEntityCrudDeps ? { getWorkEntityCrudDeps } : {}),
    ...(getCalendarWriteDeps ? { getCalendarWriteDeps } : {}),
    ...(getWorkEntityEdgeStore ? { getWorkEntityEdgeStore } : {}),
    // D-188 + the D-192 admission seam — a caller-triggered vendor
    // escalation never traverses the op-admission gate on the invoke
    // spine, so BOTH escalation families (the work-entity read tools
    // AND the CRM S3 leg) consult the SAME gate directly (late-bound
    // off execute deps): `isFrozenByPause` for the master pause and
    // `isOpGranted` for the governing contract's op axis. Absent
    // pre-wire/dbless ⇒ owner-chat escalations run pause- +
    // grant-unenforced (the admission gate's own degradation posture)
    // and EXTERNAL escalations refuse outright (fail closed).
    getOpAdmissionGate: () => getExecuteDeps()?.opAdmissionGate,
  });

  // D-182 F2 — op-aware `requires_kinds`. Kernel closed-kind ops resolve inline in
  // `deriveRecipeRequiresKinds`; this resolver covers the rest: canonical →
  // `connection`, and a Tier-P op → its installed pack's decomposed catalog kind.
  // `resolveCatalogSlug` reads live install state lazily (both `contractScan` +
  // `manifests` are late-bound). It is only invoked for Tier-P ops (a minority of
  // recipes), so the per-call `buildPackOpResolution` scan stays bounded — memoizing
  // it behind an install/uninstall invalidation signal is a later optimization.
  const opKindLookup = createOpKindLookup({
    lookup: chatToolRegistryInputs.manifestLookup,
    resolveCatalogSlug: (packRef) => {
      const scan = getExecuteDeps()?.contractScan;
      const manifests = getExecutorConfig()?.manifests;
      if (!scan || !manifests) return null;
      const resolution = buildPackOpResolution(
        () => scan('installed_pack', []),
        (slug) => manifests.get(slug),
      );
      return resolution.get(packRef)?.catalog_slug ?? null;
    },
  });

  // ⛔⛔ D-247 D8 — THE OWNER'S TIER-2 CATALOG, PROJECTED WITHOUT THE
  // `chat_exposed` FILTER, AND THIS IS THE POINT OF THE DECISION.
  //
  // `buildTier2ToolEntry` drops a hidden recipe BEFORE any grant is consulted,
  // and a filter applied downstream can only NARROW what the projection produced.
  // So an owner who explicitly granted a hidden recipe got nothing back: the flag
  // was still the gate D-247 exists to demote to a seed. Projecting the full set
  // and letting the `recipe.*` grant decide is what makes the grant authoritative
  // rather than advisory.
  //
  // ⚠ null for anything NOT owner-governed, leaving the registry's own
  // (still flag-filtered) entries in place. A door has no `recipe.*` axis, so
  // handing it the unfiltered set would widen it with nothing left to narrow it.
  //
  // ⚠ Shared by BOTH owner exposure surfaces — the main catalog and
  // `tools.search`. Wiring one and not the other is a grant that works in the
  // catalog and silently does not in search.
  const tier2OwnerCatalog = (
    source?: ExecutionSource,
  ): ReadonlyArray<ToolEntry> | null => {
    if (source === undefined) return null;
    const gate = getExecuteDeps()?.opAdmissionGate;
    if (gate === undefined || !gate.isOwnerGoverned(source)) return null;
    const reachable = chatToolRegistryInputs.tier2GrantFilter(source);
    return buildTier2Catalog(
      chatToolRegistryInputs.tier2Source.listRecipes(),
      chatToolRegistryInputs.manifestLookup,
      opKindLookup,
      true,
    ).filter((entry) => reachable(entry.name));
  };

  // ⛔ ONE RULE, ONE DEFINITION. The registry gates Tier-1 dispatch with this,
  // and the pre-seed index probes the SAME handlers — so the index must consult
  // the SAME predicate, not a second copy of it. A duplicated gate is the shape
  // where one door tightens and the other quietly keeps admitting.
  const admitTier1 = (name: string, ctx: ChatDispatchContext): boolean => {
    const gate = getExecuteDeps()?.opAdmissionGate;
    if (gate === undefined || ctx.execution_source === undefined) return true;
    return gate.isOpGranted(ctx.execution_source, primitiveGrantEntry(name));
  };

  const internalRegistry = createInternalToolRegistry({
    tier1Handlers: chatToolRegistryInputs.tier1Handlers,
    // ⛔⛔ D-228 slice 5 — the contract gates Tier-1 primitives on the INTERNAL
    // chat channel too, not only `mcp_wire`. `buildInternalDispatchCtx` always
    // sets `execution_source` (a `(chat, user_self)` source), and
    // `resolveGrantGoverningContractId` maps that to `OWNER_CONTRACT_ID` — so
    // the principal here is the OWNER and the gate reads the owner's own rows.
    //
    // 🔑 SAFE BY CONSTRUCTION, and only because the seeding landed first: the
    // owner's author-default is permissive AND the boot reconcile writes an
    // explicit `granted:true` row per primitive, so this changes nothing until
    // the owner REVOKES one in Settings → Contracts. That revoke is the whole
    // point — "permissive, tightenable" had no enforcement on this channel.
    //
    // ⚠ Late-bound off execute deps, matching `getOpAdmissionGate` above:
    // pre-wire / dbless boots have no gate, and there the callback admits
    // rather than dark-booting a chat turn that has no contract substrate to
    // consult in the first place.
    admitTier1,
    // ⛔ D-247 D9 — the DISPATCH re-check. Visibility is filtered beside the
    // registry (three surfaces, each holding the turn's source); this is what
    // stops a name the model already holds from an earlier turn surviving a
    // revoke. Same late-binding as `admitTier1` above, for the same reason.
    admitTier2: (name, ctx) => {
      const gate = getExecuteDeps()?.opAdmissionGate;
      if (gate === undefined || ctx.execution_source === undefined) return true;
      // ⛔⛔ ASK "IS THIS THE OWNER" BEFORE "IS IT GRANTED". `isOwnerRecipeGranted`
      // answers `false` for a DOOR structurally — its recipe authority is its
      // inbound token, not the owner's contract — so skipping this check would
      // refuse every Tier-2 dispatch on every door, a total outage that reads
      // like a working gate.
      if (!gate.isOwnerGoverned(ctx.execution_source)) return true;
      const slash = name.indexOf('/');
      if (slash <= 0 || slash === name.length - 1) return true;
      return gate.isOwnerRecipeGranted(
        ctx.execution_source,
        recipeGrantEntry(name.slice(0, slash), name.slice(slash + 1)),
      );
    },
    tier2Source: chatToolRegistryInputs.tier2Source,
    manifestLookup: chatToolRegistryInputs.manifestLookup,
    opKindLookup,
    tier2Dispatch: chatToolRegistryInputs.tier2Dispatch,
    // ⛔ D-228 slice 4 — no `tier3Dispatch` / `tier3Source`. The tier-3 catalog
    // projects empty since `tool_overrides` was deleted; wiring a source into a
    // producer that returns `[]` would only suggest it still does something.
  });

  // D-164 per-topic enrichment entries — CHAT-ONLY registry view. The
  // orchestrator (catalog build + tool-loop dispatch + tier/concurrency
  // resolution) sees per-topic `enrichment.<topic>` entries in place of
  // the `enrichment.search` umbrella; the RAW `internalRegistry` keeps
  // serving every MCP surface (returned from this wire + threaded via
  // `chatBundle.internalRegistry`), where the umbrella + per-token
  // visibility gates are unchanged. Trust reads go through a local
  // read view over the same SQLite table the housekeeping substrate
  // writes (the store is stateless — both views converge per read).
  // LAZY per the file-header late-resolution invariant: the chat
  // surface composes BEFORE `composeHousekeepingStores` ensures the
  // `enrichment_trust` schema (compose-app-context.ts order), so the
  // store must not prepare its statements at compose time. Memoized on
  // first successful creation; until the table exists, reads fall back
  // to the registry default (exactly the absent-row semantics).
  let chatTrustStore: ReturnType<typeof createTrustStore> | undefined;
  const readTrustState = (topic: EnrichmentTopic): EnrichmentTrustState => {
    if (!chatTrustStore) {
      try {
        chatTrustStore = createTrustStore(deps.db);
      } catch {
        // Creation fails only while the `enrichment_trust` table is
        // absent (statement prepare) — the pre-housekeeping boot
        // window. Absent table ≡ no persisted rows, so the registry
        // default IS the correct read. NOT a blanket fail-open: a read
        // error after a successful prepare propagates, and the
        // wrapper's per-topic catch hides the topic fail-closed (codex
        // review fold — a blanket default could expose a topic whose
        // persisted row says 'off').
        return resolveEnrichmentTrustDefault(topic, false);
      }
    }
    // `read(topic, false)` is exact for the OFF check the wrapper
    // gates on: a persisted row returns as-is, and the synthesised
    // default's `isAiSurface` flag only picks between 'manual'/'auto'
    // (both visible) — 'off' can only come from a persisted row or a
    // registry-declared `default_trust_state` (flag-independent). Same
    // flag-unknown reasoning as `TrustStore.write`'s first-write path.
    return chatTrustStore.read(topic, false).trust_state;
  };
  // Lever-2 — the ENV-global catalog projection (the per-source fallback +
  // back-compat for existing `RECUED_CHAT_CATALOG_MODE` deployments).
  const catalogProjection = parseChatCatalogProjectionEnv(process.env);
  // Lever-2 per-slot — the smart auto-default. ON by default as of 2026-07-03:
  // the "proven-safe" gate cleared both qwen3.7-plus (discovery 92%) and a weak
  // reasoning model (gemma-4-31b-it, 3-pass: free_pool→index holds routing,
  // over-search guard intact, reports/leancore-discovery-weakmodel-FINDING.md).
  // Set the value to the literal `0` to opt out; ONLY `0` disables (any other
  // value, incl. unset, enables — the symmetric inversion of the prior
  // `=== '1'`). A per-source override in Settings → AI/Models still wins over
  // the smart default either way.
  //
  // ⛔ DO NOT RESTATE THE MAP HERE. READ IT:
  // `CHAT_CATALOG_SMART_DEFAULT_BY_SOURCE` (contracts) is the only statement of
  // which mode each source gets, and it has now moved TWICE under a comment that
  // named a value — `full` for BYOK slots, then `index` for every source, and as
  // of this correction (2026-08-18) `lean-core` for every source. Each revision
  // fixed the words and left the same defect in place, because the defect is
  // restating a value that lives somewhere else.
  //
  // ⚠ A stale value here is expensive in a specific way: it makes the DEFAULT
  // look like the costly branch, so a reader goes hunting for a knob that is
  // already on. The previous revision wrote exactly that warning one paragraph
  // below a restated map, and the map went stale anyway.
  //
  // Measured against the live wire (2026-08-05, bench seed, 2,146 recipes, BYOK
  // slot_1) — catalog prefix, and the input tokens it costs. ⚠ These are the
  // costs OF EACH MODE, not a claim about which one ships; the shipping default
  // is whatever the map says today:
  //
  //     full        520,418 chars  110,210 tok
  //     index       232,733 chars   49,091 tok
  //     lean-core    20,211 chars    5,140 tok
  //
  // ⚠ Precedence (resolveCatalogModeForSource): explicit override → smart
  // default (known source) → env-global `RECUED_CHAT_CATALOG_MODE` → full. With
  // smart-defaults ON the per-source default takes precedence over an env-global
  // mode for a KNOWN source, so `RECUED_CHAT_CATALOG_MODE` alone is INERT on a
  // pinned turn — thinning further (or at all, for an unpinned turn) needs
  // `RECUED_CHAT_CATALOG_SMART_DEFAULTS=0` alongside it, or a per-source
  // override.
  const catalogSmartDefaults = process.env.RECUED_CHAT_CATALOG_SMART_DEFAULTS !== '0';
  // Per-turn projection resolver bound into the orchestrator: each turn's mode
  // comes from its LLM source, resolved LIVE against the persisted per-source
  // overrides (`getLlmConfig()?.catalog_modes` — Phase 2) so a mode saved in
  // Settings → AI/Models routes the NEXT turn without a restart (matches the
  // D-174 R28 per-use config read). Precedence (in resolveCatalogModeForSource):
  // explicit per-source override → smart default (known source + flag on) →
  // env-global → full.
  const catalogProjectionForSource = (source: ChatModelSourceId | undefined) =>
    resolveCatalogProjectionForSource(source, getLlmConfig()?.catalog_modes, {
      smartDefaults: catalogSmartDefaults,
      envGlobalMode: catalogProjection.mode,
      ...(catalogProjection.indexDescriptionMaxChars !== undefined
        ? { indexDescriptionMaxChars: catalogProjection.indexDescriptionMaxChars }
        : {}),
    });
  // Per-turn system-prompt resolver — the owner's Settings → AI/Models override
  // when they authored one, else the surface's built-in default. Read LIVE off
  // `getLlmConfig()` for exactly the reason the projection above is: a prompt
  // saved in Settings must route the next turn without a server restart.
  const resolveSystemPrompt = (
    surface: LlmPromptSurface,
    options?: { readonly systemToolsAllowed?: boolean },
  ) => resolveLlmSystemPrompt(surface, getLlmConfig(), options ?? {});
  // The chat registry view the orchestrator consumes: enrichment per-topic
  // tools, then the tools.search recall meta-tool. The wrapper is composed
  // OUTSIDE the enrichment wrapper; the RAW `internalRegistry` the MCP wire +
  // door catalog read is untouched → chat-only. It's applied ONCE at
  // construction and CANNOT be per-turn.
  //
  // Phase 2 — tools.search is enabled ALWAYS, because per-source modes are now
  // LIVE: a user can flip any source full→index/lean-core mid-session via
  // `catalog_modes`, and a construction-time enable snapshot (Phase 1's
  // env-global + smart-defaults set) would go STALE and strand a freshly-leaned
  // turn with a `tools.search` guidance + a thinned catalog but the tool
  // un-dispatchable (a three-way break). Passing the full set of POSSIBLE
  // delivery modes (any source may take any of them at runtime) makes
  // `anyCatalogModeUsesToolsSearch` always true → the tool stays DISPATCHABLE on
  // the chat path. Safe: a `full` turn still drops tools.search from
  // PRESENTATION (buildChatMainTurnTools keys on the per-turn projection.mode),
  // so a full turn stays byte-identical, and tools.search is read-only /
  // chat-only / never presented on full turns.
  const baseChatRegistry = wrapRegistryWithRecallSearch(
    wrapChatRegistryForCatalogModes(
      wrapRegistryWithEnrichmentTopicTools(internalRegistry, {
        listTopicsWithRows: () =>
          getEnrichmentStore()?.listTopicsWithRows() ?? null,
        resolveTrustState: (topic) =>
          isEnrichmentTopic(topic) ? readTrustState(topic) : 'off',
      }),
      CHAT_CATALOG_DELIVERY_MODES,
      () => toolCatalogStore.getScope() ?? null,
      chatToolRegistryInputs.tier2GrantFilter,
      tier2OwnerCatalog,
      chatToolRegistryInputs.ownerCatalogGuard,
    ),
    {
      backend: createRecallSearchBackend(chatStore),
      // The contract substrate boots after chat composition. Resolve the live
      // store at dispatch time; the definition wrapper is stateless.
      getContractDefinitionStore: () => {
        const store = getContractStore?.();
        return store ? createContractDefinitionStore(store) : undefined;
      },
      // ⛔ THE OWNER'S REVOKE OF `core.recall.search`. Same gate + same shape as
      // `admitTier1` above — ONE RULE, ONE DEFINITION: `isOpGranted` applies its own
      // contract-free semantics (a source with no governing contract is admitted), so
      // this must CALL it rather than re-derive "is it granted" from a row.
      isRecallGranted: (source) => {
        const gate = getExecuteDeps()?.opAdmissionGate;
        if (gate === undefined || !isExecutionSource(source)) return true;
        return gate.isOpGranted(source, opGrantEntry('core.recall.search'));
      },
    },
  );
  const d214Experiment = readExecutionCaseExperimentEnv();
  if (!getSpanAnchorDeps) {
    throw new Error('D-214 span-anchor composition is unavailable');
  }
  // D-219 — which cases the owner already authored a recipe from. ⛔ A separate
  // table because a case row is a PROJECTION; keyed on `case_key` because
  // `case_id` is version-scoped. Read the store's header before touching either.
  const authoredStore = createExecutionCaseAuthoredStore(db);
  const executionCases = composeExecutionCases({
    db,
    getContactStore,
    ...(chatKeyProvider ? { chatKeyProvider } : {}),
    registry: baseChatRegistry,
    getSpanAnchorDeps,
    ...(d214Experiment ? { experiment: d214Experiment } : {}),
    ...(process.env.RECUED_D214_EXPERIMENT_SECRET
      ? {
          experimentSecret:
            process.env.RECUED_D214_EXPERIMENT_SECRET,
        }
      : {}),
    // D-219 slice 9c — the owner's switch for the "worth remembering?" ask.
    // Read LIVE per candidate turn off the paired-instance roster, so a toggle
    // in Settings applies to the next turn without a reconnect. Absent store
    // (db-less boot) ⇒ the option is omitted entirely and the ask stays ON,
    // which is the registry default: no roster is not an opt-out.
    ...(pairedInstances
      ? {
          getOfferPrefsRoster: () =>
            pairedInstances
              .listAllActive()
              .map((row) => pairedInstances.getPrefs(row.instance_id)),
        }
      : {}),
  });
  const chatRegistry = executionCases.registry;

  const broadcast = broadcastEmitterFromBus(eventBus);
  const selfSignature = {
    server_kind: 'recued' as const,
    version: process.env.RECUED_VERSION ?? '0.0.0',
    instance_id: serverInstanceId,
  };

  // D-164 P6.3/P6.4 + D-137 W2.4 § A.14 — direct `executeLLM` closure
  // the chat-orchestrator calls via `executeAiCall`. Pre-binds
  // llmConfig / quota / registry / tabProbe so the orchestrator's
  // narrow seam doesn't thread them. P6.4 deleted the per-stage adapter
  // factories the closure used to feed; the orchestrator now composes the
  // AI packet inline per P6.0 (b). D-191 retired chat force-local (the
  // local-only availability mask) — routing is honest to
  // slot_1/slot_2/free_pool and aliasing is the sole PII protection.

  const executeChatAiCall: ExecuteChatAiCall = async (
    manifest,
    input,
    opts,
  ) => {
    // D-174 R28 — resolve config PER-USE (a live db read; getLlmConfig falls
    // back to the boot snapshot internally) so a slot saved mid-session routes
    // correctly WITHOUT a restart, instead of the frozen boot `llmConfig`.
    const cfg = getLlmConfig();
    if (!cfg) {
      throw new LLMError('AI_LLM_UNAVAILABLE', 'no LLM config configured', {});
    }
    // D-137 Trio #E — capture the single per-call `TokenUsage`.
    // `executeLLM`'s zero-retry policy guarantees at most one
    // successful call per invocation.
    let captured: TokenUsage | undefined;
    const captureUsage = (u: TokenUsage) => {
      captured = u;
      // D-250 § D — the same provider result also advances the owner's daily
      // counter, so the budget finally sees chat. See `addOwnerTokenUsage`.
      deps.addOwnerTokenUsage?.(u.total_tokens);
    };
    const body = await executeLLM(manifest, input, {
      config: cfg,
      adapters: llmAdapterRegistry,
      quota: llmQuota,
      tabProbe: emptyTabProbe,
      webChatSupported: false,
      onTokenUsage: captureUsage,
      // Opt-in only; absent leaves `resolveLLMTimeoutMs` at its no-timer default.
      ...(opts?.timeout_ms !== undefined ? { timeout_ms: opts.timeout_ms } : {}),
    });
    return {
      body,
      ...(captured ? { usage: tokenUsageToReport(captured) } : {}),
    };
  };
  const voiceTranscription = llmConfig
    ? {
        readFile: async (record_id: string) => {
          const dataFileRead = getExecutorConfig()?.kernelDispatchers?.dataFileRead;
          if (!dataFileRead) {
            throw new Error('messenger voice transcription file.read unavailable');
          }
          return dataFileRead({ record_id });
        },
        transcribeDeps: {
          // D-174 R28 — live config (boot fallback) so a slot saved mid-session
          // applies WITHOUT a restart. A getter, not a snapshot: the consumer
          // passes this object straight into `transcribe` (no spread), so it
          // re-resolves per voice message.
          get config() { return getLlmConfig() ?? llmConfig; },
          adapters: createDefaultTranscriptionRegistry(),
          quota: llmQuota,
        } satisfies TranscribeDeps,
      }
    : undefined;

  // D-177 N.11 rule 5 (5.d hot-path) — per-session forwarded-sender
  // candidate index. The orchestrator records user chat turns into it;
  // slice D threads `candidates()` into the gateway's scoped-grant match
  // context. In-memory by design — a restart degrades scoped grants to
  // asking (5.f).
  const forwardedSenderIndex = createSessionForwardedSenderIndex();

  // D-177 N.11 rule 5 (5.c, slice C) — the scoped-grant parse hook's deps,
  // resolved LATE per turn (the contract store + executor manifests
  // bootstrap after the chat surface). All three stores present → the hook
  // is live; any absent → faithful no-op. The store wrappers are stateless
  // over the contract-store handle, so per-call construction is cheap and
  // always reads the live rows.
  const getScopedGrantParseDeps = (): ScopedGrantParseDeps | undefined => {
    const contractStore = getContractStore?.();
    const executorConfig = getExecutorConfig();
    const connectionStore = getConnectionStore();
    if (!contractStore || !executorConfig || !connectionStore) return undefined;
    return {
      suggestionStore: createScopedGrantSuggestionStore(contractStore),
      listManifests: () => {
        const registry = executorConfig.manifests;
        return registry.slugs().flatMap((slug) => {
          const manifest = registry.get(slug);
          return manifest ? [manifest] : [];
        });
      },
      connectionStore,
      bindingStore: createConnectionCatalogBindingStore(contractStore),
      emit: (event) => {
        eventBus.emit(event as Parameters<EventBus['emit']>[0]);
      },
    };
  };

  // One registry, two readers: the orchestrator decorator below marks turns
  // as they run, and `chatDeps` reports the set on `chat.sessions.list`.
  const sessionBusy = createChatSessionBusyRegistry(broadcast);

  // D-269 step 1 — the server's own zone for the `current_date` anchor. Built
  // here off the same `db` the chat store uses rather than threaded from the
  // storage context, because this module is also the one a db-less harness
  // skips: no db, no store, no dep, unchanged behaviour.
  const serverTimeZoneStore = createServerTimeZoneStore(db);

  const executionOrchestrator = withChatSessionBusy(createChatOrchestrator({
    chatStore,
    // ⚠ Resolved PER TURN, not captured. Under `follows_host` the answer is the
    // host clock, so a laptop that flew overnight anchors on where it woke up.
    serverTimeZone: (): string => resolveServerTimeZone(
      serverTimeZoneStore.read(),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    // D-259 §7.4.2 — read the singleton registry at TURN time. The source is
    // host-minted; deriving the same channel-session key used at registration
    // keeps a concurrent chat/messenger turn scoped to its own live work.
    // D-213 pointer arm — env-gated inside `buildPriorToolPointers`, so leaving
    // it bound here costs nothing when the flag is unset. Resolves the contract
    // store LAZILY for the same reason the recall lane above does: the contract
    // substrate boots after chat composition.
    buildPriorToolPointers: async (
      source: ExecutionSource,
      session_id: string,
      turn_id: string | undefined,
    ) => {
      const store = getContractStore?.();
      if (!store) return undefined;
      return buildPriorToolPointers(
        chatStore,
        createContractDefinitionStore(store),
        source,
        session_id,
        turn_id,
      );
    },
    buildInFlightContext: (source: ExecutionSource) =>
      getExecuteDeps()?.inFlightRegistry?.promptContext(
        deriveChannelSessionId(source),
      ),
    // Pre-seed INDEX. Probes the ordinary Tier-1 read handlers for the owner's
    // own distinctive terms and reports only WHICH STORES answered — never a
    // row, a title or a count. Two gates apply and neither is re-implemented
    // here: `admitTier1` (shared with the registry, above) and each handler's
    // own collection read-fence. ⛔ The fence answers `ok:TRUE` with an EMPTY
    // `matches` (the Tier-1 anti-loop invariant), so what keeps a revoked store
    // out of the line is the empty array, NOT the `ok` flag — see `hasHit`.
    // ── PRE-SEED INDEX: ON by default, `RECUED_CHAT_INDEX=0` disables ────────
    // 🔑 WHAT THIS BUYS, IN ONE SENTENCE: the probability that the model stops
    // at the store it PREFERS before reaching the one that holds the answer.
    // Everything below follows from that, including the zeroes.
    //
    // Measured (internal benchmarks, arms interleaved inside each batch):
    //   · answer in a NEGLECTED store, decoy in the preferred one:
    //     8/8 vs 1/8 (p=0.0014) — and correctness tracks store-choice exactly:
    //     the single control run that searched mail is the one that answered.
    //     The other seven searched memory, got a REAL hit on the term, and
    //     stopped: "I don't have a record of the notice period" is a truthful
    //     report of an incomplete search.
    //   · 4-sub-question request: 80/92 needles vs 56/92 (p=0.000089); the
    //     mechanism is visible in the calls — 3.5 stores searched vs 2.4
    //   · answer in recall: 24/26 vs 17/26 (p=0.039)
    //   · answer in MEMORY: 100% vs 100% — ZERO gain, because `memory.search`
    //     ran 10/10 without the index and 11/11 with it. Nothing to fix where
    //     the model already looks. `memory` likewise scored 23/23 in BOTH arms
    //     of the multi-task shape.
    //
    // ⇒ the honest range is +0 to +87 points, NOT a uniform lift. A fixture that
    // puts the answer in memory measures nothing; that is a property of the
    // fixture, not of the index.
    //
    // ⛔⛔ THE HARM MODE IS STRUCTURAL AND RETURNS SILENTLY. An INCOMPLETE index
    // is worse than none: when it could not name `recall.search`, the model
    // called that store 0/10 where the no-index control reached it 16/23 — the
    // line SUPPRESSED a tool the model otherwise used, because naming a subset
    // makes the unnamed read as absent. It is complete today only because every
    // probeable store is probed. If a store is ever added to the catalog and not
    // to `CHAT_INDEX_STORES`, or one becomes unprobeable, that failure comes
    // back with nothing failing — see the `work.search` exclusion note there.
    //
    // The off-switch exists so that is one env var, not a redeploy.
    ...(process.env.RECUED_CHAT_INDEX !== '0' ? {
    buildIndexContext: (
      userMessage: string,
      ctx: ChatDispatchContext,
      visibleItemIds: readonly string[],
    ) =>
      buildChatIndexContext(userMessage, ctx, async (store, term, probeCtx) => {
        // A probe key may carry a per-call discriminator (`work.search:note`);
        // admission and handler lookup both need the bare tool name.
        const probeTool = chatIndexProbeTool(store);
        if (!admitTier1(probeTool, probeCtx)) {
          return { ok: false as const, reason: 'channel_denied' as const };
        }
        // ⛔ recall.search is NOT in `tier1Handlers` — it is grafted on by
        // `wrapRegistryWithRecallSearch`, so it dispatches through the registry.
        //
        // 🔑 THE FRESH `turn_state` MAP IS THE WHOLE POINT. Recall's two-call
        // budget lives INSIDE that Map (`getTurnState` creates the counter in
        // whatever scratch it receives), and the model's own dispatches use the
        // turn's `streamState`. Handing the probe its own Map gives it its own
        // `search_calls: 0`, so probing costs the model NOTHING — and a fresh
        // Map per probe means N terms do not exhaust one shared allowance.
        // ⚠ A null/absent turn_state does NOT work: the handler returns
        // `guidedEmpty()` without searching, so the probe would report "no hit"
        // for every term — a dead probe that reads exactly like an empty store.
        // ⛔ recall.search is NOT in `tier1Handlers` — it is grafted on by
        // `wrapRegistryWithRecallSearch`, so it dispatches through the registry.
        //
        // TWO things must BOTH be right, and each fails silently on its own:
        //
        // 1. A FRESH `turn_state` Map. Recall's two-call budget lives INSIDE
        //    that Map (`getTurnState` creates the counter in whatever scratch it
        //    receives) and the model's own dispatches use the turn's
        //    `streamState`. Its own Map = its own `search_calls: 0`, so probing
        //    costs the model NOTHING, and a fresh Map PER probe stops N terms
        //    exhausting one allowance.
        // 2. The TURN SOURCE registered into that Map. The handler resolves its
        //    corpus scope from `state.turn_source` and the code says
        //    "`state.turn_source`, NEVER `ctx.execution_source`" — an authority
        //    boundary it refuses to take from the dispatch ctx. An unregistered
        //    Map resolves the scope to null and returns `guidedEmpty()` WITHOUT
        //    SEARCHING. ⚠ Measured: with (1) alone every term came back
        //    `matches: []` + "No matching recall item was found" — indisting-
        //    uishable from an empty store, so the index silently dropped the one
        //    store that held the answer. This is the same source the orchestrator
        //    registers for the real turn, not a widened one.
        if (probeTool === RECALL_SEARCH_TOOL_NAME) {
          const scratch = new Map<string, unknown>();
          if (probeCtx.execution_source !== undefined) {
            registerRecallTurnSource(scratch, probeCtx.execution_source);
          }
          // 3. THE VISIBLE ROWS registered into that same Map. The fresh Map
          //    that makes the probe free also gives it an EMPTY
          //    `visible_item_ids`, so without this the lane's
          //    `excluded_item_ids` is empty and the probe hits the current
          //    user row plus all three tail rows for every term the owner just
          //    typed — the self-match noise the old `session_relation` filter
          //    existed to suppress, and the reason that filter could be
          //    deleted only together with this line. Seeding it here means the
          //    probe and the model's own dispatches exclude the SAME rows by
          //    the SAME rule, so an own-session turn that has aged out of the
          //    tail is reachable by exactly one of them: the index.
          //    ⚗ Gated with the filter it replaces — see
          //    `chatIndexSessionRowsEnabled`. Registering while the filter is
          //    still on would change CONTROL, not just the treatment.
          if (chatIndexSessionRowsEnabled()) {
            registerVisibleInteractionItemIds(scratch, visibleItemIds);
          }
          return baseChatRegistry.dispatch(
            RECALL_SEARCH_TOOL_NAME,
            { query: term, sources: ['interaction'] },
            { ...probeCtx, turn_state: scratch },
          );
        }
        const handler = chatToolRegistryInputs.tier1Handlers[probeTool];
        if (handler === undefined) return { ok: false, reason: 'not_implemented' };
        // cap + 1 so `hasHit` can tell "some matches" from "too many to mean
        // anything here" — the per-owner replacement for a static word list.
        return handler(
          {
            query: term,
            limit: CHAT_INDEX_TOO_COMMON_CAP + 1,
            // Per-store probe args — see `CHAT_INDEX_PROBE_ARGS`. Without this
            // `file.search` probes its SESSION scope and answers empty forever.
            ...(CHAT_INDEX_PROBE_ARGS[store] ?? {}),
          },
          probeCtx,
        );
      }),
    } : {}),
    // D-172 P2 — names the files the chat tail carries, resolved LIVE from the
    // file collection so a since-deleted file drops out of the marker instead
    // of being offered to the model as an id that resolves to nothing.
    resolveFileNames: (ids) => {
      const names = new Map<string, string>();
      const collection = getCollectionRegistry()?.get('file', DATA_FILE_RECEIVED_SLUG) as
        | { get(id: string): { hot_fields?: { filename?: unknown } } | null }
        | undefined;
      if (!collection) return names;
      for (const id of ids) {
        const filename = collection.get(id)?.hot_fields?.filename;
        if (typeof filename === 'string' && filename.length > 0) names.set(id, filename);
      }
      return names;
    },
    /** The learned-bounds half of context fitting.
     *
     *  ⛔⛔ WHY THIS EXISTS AT ALL. `input_token_budget` is the one input to
     *  every trim in `chat-turn-executor.ts`, and a census (2026-09-03) found
     *  its only source, `slot.context_window_tokens`, is OWNER-TYPED ONLY — no
     *  model table, no probe, no default — and that the ONLY code that ever
     *  supplied the budget was the llm_gateway handler. So on ordinary chat it
     *  was undefined, `promptFits` short-circuited to true, and the whole
     *  fitting path was inert: hence the tail-eviction loop's own comment
     *  ("Normal chat never enters this branch"), a 113,616-token request that
     *  went out and was accepted, and ZERO `ChatContextLength` occurrences in
     *  1,546 stored bench reports. The guard was correct and starved.
     *
     *  ⛔ THE MINIMUM OVER CANDIDATES IS NOT TIMIDITY, IT IS THE ONLY SOUND
     *  ANSWER HERE. `matchLLM` picks among candidates using `deps.rng` and live
     *  quota, so resolving "the" slot before the call is a DIFFERENT DRAW from
     *  the one the call makes — budgeting to a slot that then loses the draw
     *  trims the prompt to the wrong endpoint's limit. Only the smallest known
     *  window is safe for every draw. An endpoint with nothing learned
     *  contributes nothing, so a fresh install stays exactly as it is today. */
    resolveInputTokenBudget: (route) =>
      resolveChatInputTokenBudget(getLlmConfig(), route),
    forwardedSenderIndex,
    getScopedGrantParseDeps,
    getSpanAnchorDeps,
    getExecutionCaseLifecycle:
      executionCases.getExecutionCaseLifecycle,
    // D-219 slice 9c — resolves undefined until a notification block is
    // published, so the offer halves stay faithful no-ops on a db-less or
    // notification-less boot.
    getExecutionCaseOfferLifecycle:
      executionCases.getExecutionCaseOfferLifecycle,
    ...(executionCases.getExecutionCaseAugmentationDeps
      ? {
          getExecutionCaseAugmentationDeps:
            executionCases.getExecutionCaseAugmentationDeps,
        }
      : {}),
    // D-219 — the ordinary-path precedent surface, live with no env at all.
    // This is the line that makes the corpus readable on a normal self-host;
    // `composeExecutionCases` supplies it iff no experiment is configured.
    ...(executionCases.getExecutionCasePrecedentDeps
      ? {
          getExecutionCasePrecedentDeps:
            executionCases.getExecutionCasePrecedentDeps,
        }
      : {}),
    ...(executionCases.getExecutionCaseProposalCritic
      ? {
          getExecutionCaseProposalCritic:
            executionCases.getExecutionCaseProposalCritic,
        }
      : {}),
    registry: chatRegistry,
    // D-225 § 9.8.1 — raw catalog ops, DERIVED per turn from the caller's
    // contract. The source fails closed on an absent turn source, so a bare
    // harness gets no raw ops rather than an unfiltered catalog.
    // D-228 slice 3 — the catalog half of the swap. SAME closure the Tier-3
    // dispatch got above; see its definition for why that matters.
    connectionMcpPackCoverage,
    rawOpSource: chatToolRegistryInputs.rawOpSource,
    // D-247 D9 — the Tier-2 reachability predicate, shared by `tools.search`
    // and the dispatch re-check.
    tier2GrantFilter: chatToolRegistryInputs.tier2GrantFilter,
    ownerCatalogGuard: chatToolRegistryInputs.ownerCatalogGuard,
    // ⛔⛔ D-247 D8 — THE OWNER'S TIER-2 CATALOG IS PROJECTED WITHOUT THE
    // `chat_exposed` FILTER, AND THIS IS THE WHOLE POINT OF THE DECISION.
    //
    // `buildTier2ToolEntry` drops a hidden recipe BEFORE any grant is consulted,
    // and a filter applied downstream can only NARROW what the projection
    // produced. So an owner who explicitly granted a hidden recipe got nothing:
    // the flag was still the gate D-247 exists to demote. Projecting the full set
    // here and letting the `recipe.*` grant decide is what makes the grant
    // authoritative rather than advisory.
    //
    // ⚠ Returns null for anything NOT owner-governed, which leaves the
    // registry's own (still `chat_exposed`-filtered) entries in place. A door has
    // no `recipe.*` axis, so handing it the unfiltered set would widen it with
    // nothing left to narrow it.
    tier2OwnerCatalog,
    // The paired dispatch half. Raw ops stay outside InternalToolRegistry
    // because their visible set is contract-derived per turn; the orchestrator
    // resolves the same source row before routing here.
    rawOpDispatch: chatToolRegistryInputs.rawOpDispatch,
    // Lever-2 (2026-07-02) — prototype catalog-delivery knob. `full`
    // (default) is the launch baseline; `RECUED_CHAT_CATALOG_MODE=index`
    // leans Tier-2 entries to slug+description for on-demand `tools.search`
    // expansion. Resolved once above (turn-invariant → D-164 prefix-safe).
    catalogProjection,
    // Lever-2 per-slot — resolve the per-turn projection from the turn's LLM
    // source (free_pool → index under the smart-default flag; BYOK slots →
    // full). Overrides `catalogProjection` per turn; the fallback stays it.
    catalogProjectionForSource,
    // The owner's Settings → AI/Models system prompt for the surface, read LIVE
    // off `getLlmConfig()` (same per-use pattern as the projection above), so a
    // prompt saved in Settings drives the NEXT turn with no restart. Only the
    // `chat` surface is resolved through here — the gateway resolves its own in
    // the HTTP handler, where `system_tools_allowed` is authoritative.
    resolveSystemPrompt,
    broadcast,
    ...(auditLog ? { auditLog } : {}),
    selfSignature,
    // D-137 W2.2 § A.1.1 — orchestrator reads Mary's per-kind scope
    // at every turn start so the kindGatedTier2Names set stays current
    // with Settings toggles without restarting the chat session.
    scopeProvider: () => toolCatalogStore.getScope() ?? null,
    // D-137 W2.3 § A.10 — same pre-filtered annotation list the Tier 3
    // catalog projection uses (above) — keeps both surfaces consistent.
    annotationProvider: () => listLiveMcpAnnotations(),
    // D-164 P6.3/P6.4 — chat-orchestrator owns inline AI-packet
    // composition + calls `executeLLM` directly via this closure (per
    // P6.0 (b) — no framework `compose-main-turn` seam). Pre-bound
    // with `LLMConfig` / adapters / quota / tab probe + token-usage
    // capture.
    executeAiCall: executeChatAiCall,
    ...(voiceTranscription ? { voiceTranscription } : {}),
    planApprovalStore: planApprovalStoreShared,
    // D-160 O-5 (light slice) — the live middleware registry + the
    // existing per-pair source the orchestrator feeds to the
    // `correction-learning` (before-turn) and `personal-recipes`
    // (after-turn) hooks. `getContactStore` reuses the same late-bound
    // getter the tool-registry inputs consume (resolves at dispatch
    // time); the correction store is a local SQLite read view.
    middlewareRegistry,
    getCorrectionEventsStore: () => correctionEventsStore,
    getContactStore,
    // D-167 P5 S4 + activation — wire the always-on PII bookends + the
    // wire-seam egress enactment, now fed the LIVE `fieldPrivacyResolver`
    // (above) in place of `noopFieldPrivacyResolver`. The seam was already LIVE
    // (D-160 S2/S3 routes the turn through `runStream`); supplying a real
    // resolver lights it up — the alias pass fires the moment an installed
    // entity schema carries a `privacy`-tagged `MetaField`, and tags nothing
    // (every packet round-trips unchanged) until then.
    piiLedgerStore: sessionLedgerStore,
    fieldPrivacyResolver,
    // D-167 (recall path) — the recall-index builder the PII egress uses to alias a
    // `memory.*` result against the warehouse, closing the cross-session memory-recall
    // leak. Reuses the same late-bound `getContactStore` the prefetch search consumes;
    // built lazily + per-turn-memoized inside the egress plan. Tier 2 also feeds it the
    // CRM record mirror: a CRM contact produces NO `contacts` row (`ContactSource` has
    // no CRM member), so a person who lives only in your CRM was invisible to the
    // contact-derived index and their name / phone egressed raw out of a recalled
    // memory body. Optional — a server with no CRM connection degrades to contact-only.
    // The registry MUST be the LIVE merged one (same source as the CRM mirror-source
    // enumerator above): a pack-declared CRM (Zoho / Dynamics) lifts into a per-install
    // registry, never the frozen `CONNECTION_VENDOR_ENTITIES`, but the housekeeping
    // reconciler still writes its `crm_record_mirror` rows — so seeding off the static
    // array would leave those scopes unenumerated and egress those people raw.
    getContactKnownValueIndex: createContactKnownValueIndexBuilder(
      getContactStore,
      getCrmRecordMirror ?? (() => undefined),
      () => liveVendorRegistry(getExecuteDeps()?.localManifestStore),
    ),
  }), sessionBusy);

  const messengerBridge = createChatMessengerBridge({ db, store: chatStore, getKey: chatKeyProvider, broadcast });
  const orchestrator = withQueuedChatTurns(executionOrchestrator, { db, store: chatStore, getKey: chatKeyProvider, broadcast, messengerBridge });

  const chatDeps: ChatRpcDeps = {
    store: chatStore,
    toolCatalogStore,
    connectionMcpStore,
    // D-228 slice 4 — the picker's visibility predicate, off the SAME coverage
    // closure the chat catalog and the Tier-3 retirement use. A peer surfaces in
    // the scope switcher iff its tools are reachable as governed pack ops.
    connectionMcpCoveredToolCount: (name: string) =>
      connectionMcpPackCoverage(name)?.size ?? 0,
    orchestrator,
    broadcast,
    sessionBusy,
    ...(auditLog ? { auditLog } : {}),
    selfSignature,
    planApprovalStore: planApprovalStoreShared,
    inboundTokenStore,
    preflightExternalToolGrant: (toolName) => {
      // D-232 § 20.20 — a KERNEL OP is grantable by its op id, and until now it
      // was not: the registry holds Tier-1 natives, Tier-2 recipes and Tier-3
      // connection tools, so `core.data.calendar.list` fell through to "not
      // currently grantable" and there was NO name by which an owner could give
      // a door a calendar read at all.
      if (isRegisteredKernelOp(toolName)) {
        if (!isGrantableKernelOp(toolName)) {
          // Say WHY. "not currently grantable" reads as a bug for something the
          // owner can see in the op list; these are excluded on purpose and the
          // reason is short enough to give.
          throw new Error(
            `kernel op '${toolName}' is not grantable to a door: `
            + `${toolName.startsWith('core.ai.')
                ? 'a door is already an LLM, and the grant would spend the owner\'s inference budget'
                : toolName.startsWith('core.watch.')
                  ? 'a watcher is a trigger evaluator, not a callable read — pushes reach a door via recipe callbacks'
                  : 'it is how a recipe pushes to a door, not something a door calls'}`
            + ' (D-232 § 20.20).',
          );
        }
        return;
      }
      const entry = internalRegistry.getByName(toolName);
      if (entry === null) {
        throw new Error(`tool '${toolName}' is not currently grantable`);
      }
      if (entry.tier !== 2) return;
      const separator = toolName.indexOf('/');
      if (separator <= 0 || separator === toolName.length - 1) return;
      const recipe = recipeStore.get(toolName.slice(separator + 1));
      const recordsStore = getExecuteDeps()?.recordsStore;
      if (recipe === null) return;
      // ⛔⛔ THE COST BOUND, the same analysis a reception door runs at bind.
      // Its own header: *"Request buckets bound how often a visitor can submit;
      // they do not bound what one accepted submit spends."* A token had
      // NEITHER half — `concurrency_tier` caps simultaneous calls, nothing
      // capped what one call costs.
      //
      // ⚠ AI IS A REFUSAL HERE, not an opt-in as it is on a reception door.
      // `core.ai.*` kernel ops are ALREADY ungrantable to a door — *"a door is
      // already an LLM, and the grant would spend the owner's inference
      // budget"* — and a recipe carrying an `ai-*` step is that same spend
      // through a different door. Refusing closes an existing inconsistency
      // rather than inventing policy; a reception door can opt in because its
      // bind has a consent screen to opt in ON, and token issuance does not.
      // ⚠ The SAME resolvers the reception door bind composes, so a recipe
      // classified unbindable there is classified unbindable here. Absent deps
      // leave the analyzer to fail closed on an unresolvable dispatch kind.
      const costExecuteDeps = getExecuteDeps();
      const opKinds = costExecuteDeps === undefined
        ? undefined
        : composeRecipeOpKindsResolver(costExecuteDeps);
      const cost = analyzeReceptionRecipeCost(recipe, {
        ...(costExecuteDeps === undefined
          ? {}
          : { resolveIngredientKind: composeRecipeIngredientKindResolver(costExecuteDeps) }),
        ...(opKinds === undefined ? {} : { resolveOpKinds: opKinds }),
      });
      if (!cost.ok) {
        // ⛔⛔ SAY WHICH PACK, BECAUSE THE REFUSAL NAMES A STEP THE OWNER DID
        // NOT WRITE. `cost_unknown_dispatch_kind` on a pack op means one thing
        // only — that pack is not installed HERE, YET — and the bare reason
        // sends the owner to read a step id inside someone else's recipe. A
        // live two-server drive spent its whole run on this: it reported
        // `cost_unknown_dispatch_kind (step 'participant_lookup')` for a
        // recipe that grants perfectly well once `federated-projects` is in.
        // ⚠ The refusal itself STANDS. An op we cannot classify is one we
        // cannot prove is not AI, and the grant is standing while the
        // resolution is a snapshot — so this widens the MESSAGE, never the gate.
        const target = cost.refusal.reason === 'cost_unknown_dispatch_kind'
          ? cost.refusal.target
          : undefined;
        const packHint = target !== undefined && !target.startsWith('core.')
          ? ` — '${target}' belongs to a pack that is not installed on this server,`
            + ' so its cost cannot be read. Install the pack, then grant.'
          : '';
        throw new Error(
          `recipe '${toolName}' cannot be granted to a token: ${cost.refusal.reason}`
          + ` (step '${cost.refusal.step_id ?? '<recipe>'}')${packHint}`,
        );
      }
      // ⛔⛔⛔ THE AI REFUSAL IS GONE, AND ITS DELETION IS THE RULING (owner,
      // 2026-08-22). It used to throw on any granted recipe carrying an `ai-*`
      // step. The owner's objection: **the grant IS the consent.** A token's
      // grants map names ONE RECIPE AT A TIME, by hand, for one peer — so
      // refusing it afterwards asks the same owner about the same recipe twice,
      // which is `RECORDS_ACTIONS`' rule quoted in this feature's own scope doc:
      // *"ONE USER INTENT SHOULD NOT COST TWO APPROVALS."*
      //
      // 🔑🔑 AND THE PRECEDENT I CITED FOR THE GATE SAYS THE OPPOSITE ON
      // INSPECTION. `receptionDoorExecutionPolicy` sets `allow_ai:
      // profile.uses_ai` — **DERIVED from the recipe, never ticked by anyone**.
      // A reception door's "consent screen" is the capability DIFF: the owner is
      // TOLD the door now runs AI, and binding it is the one decision. So the
      // matching behaviour for a token was never a second gate; it was disclosure
      // plus the grant. Read *"the owner must opt into it at bind"* as "the bind
      // is where they accept it", not as a toggle.
      //
      // ⛔ WHAT STILL FENCES THIS, so nobody re-adds the gate for lack of one:
      //   1. `core.ai.*` remains UNGRANTABLE DIRECTLY — every `ai`-domain kernel
      //      op is in `KERNEL_OP_GRANT_EXCLUSIONS`, so a peer cannot be handed
      //      raw inference. A NAMED RECIPE is the only route, which is exactly
      //      what makes "the owner granted this" true by construction;
      //   2. VOLUME is the contract's job, not this gate's — `expiry_at` /
      //      `max_uses` on the carrier, metered on the MCP path. That is the
      //      bound for a peer calling a granted recipe in a loop;
      //   3. every other cost refusal STANDS (step limit, `foreach` fan-out,
      //      unresolvable dispatch kind).
      //
      // ⚠ MEASURED, AND WORTH KEEPING EVEN THOUGH THE GATE WENT: nothing
      // downstream asks. `resolveTrustCeiling(peer mcp token) = 'read'`, and
      // `admitByOpRisk` returns ADMIT for a `read` op at a `read` ceiling (`write`
      // and `destructive` return `ask`); `core.ai.classify` is registered `read`
      // because it writes nothing. So a peer-dispatched AI step prompts NOBODY at
      // run time. That is not an argument for refusing the grant — it is the
      // reason the GRANT is where the owner decides, and the reason a future
      // change of mind belongs on `core.ai.*`'s RISK TIER, which is a ruling for
      // every caller rather than a clause here.
      if (recordsStore === undefined) return;
      assertRecordsNonOwnerRecipeExposure(
        recipe,
        'mcp',
        {
          isOperationId: (operationId) => recordsStore.isInstalledOperationId(operationId),
          isCatalogOperation: (catalogSlug, operationKey) =>
            recordsStore.isInstalledCatalogOperation(catalogSlug, operationKey),
        },
      );
    },
    /** Door standing closure, MCP arm — what the owner's tick actually means.
     *
     *  ⛔⛔ THE SAME DERIVATION THE RECEPTION DOOR BIND USES
     *  (`deriveResolvedRecipeCapability` over `composeRecipeOpResolver`'s
     *  lowering), not a second walk of the recipe. A door and a token that
     *  disagreed about which ops a recipe runs would put standing authority on
     *  one list while the gate checked another — and the gate would silently
     *  win, in whichever direction happened to be wrong.
     *
     *  ⚠ NO TIER FILTER HERE, deliberately. `standingClosureAdmits` bounds to
     *  `STANDING_CLOSURE_RISK_TIERS` at dispatch; filtering here as well would
     *  be the same rule in two places, which is exactly how the bind fence and
     *  the gate came apart on the reception arm.
     *
     *  A recipe that fails capability derivation contributes NOTHING rather
     *  than throwing: the owner is issuing a token over several tools, and one
     *  unanalysable recipe should narrow the closure, not refuse the token. If
     *  that empties the closure entirely, the rpc refuses. */
    /** Always-contracted — the limits carrier every newly issued token binds
     *  to. Deliberately the SAME shape the Advanced panel mints
     *  (`scope: { channels: ['mcp'] }`), so a token minted here and one the
     *  panel re-mints when limits change are the same kind of row.
     *
     *  ⚠ NO `expiry_at` / `max_uses`: contracted is not bounded, and minting a
     *  silent default limit would cap tokens the owner never asked to cap. */
    mintTokenContract: ({ label, standingClosureOperationIds, limits }) => {
      const store = getContractStore?.();
      if (!store) {
        throw new Error('contract store is not ready — cannot issue a contracted token');
      }
      const doorPolicy = standingClosureOperationIds === undefined
        ? undefined
        : {
            // The cost bound, same numbers the reception door carries.
            max_steps: RECEPTION_RECIPE_MAX_STEPS,
            // ⚠ `false`, and it means "this contract records no AI opt-in" —
            // NOT "AI is refused". The token path has no runtime cost check to
            // read it, and the AI refusal was deleted above because the GRANT is
            // the consent. Deriving a truthful value here would be a field
            // nothing reads, which is how a claim outlives its backing.
            allow_ai: false,
            standing_closure: true,
          };
      return createContractDefinitionStore(store).mint({
        minted_by: 'operator',
        display_name: `MCP door — ${label}`,
        // ⛔ The closure rides on the CONTRACT: its ops in `scope`, its opt-in
        // in `door_execution_policy` — the same two fields the reception door
        // uses, read by the same overlay accessor at dispatch.
        scope: {
          channels: ['mcp'],
          ...(standingClosureOperationIds === undefined
            ? {}
            : { operation_ids: [...standingClosureOperationIds] }),
        },
        door_types: ['mcp'],
        ...(doorPolicy === undefined ? {} : { door_execution_policy: doorPolicy }),
        ...(limits?.max_uses === undefined ? {} : { max_uses: limits.max_uses }),
        ...(limits?.expiry_at === undefined ? {} : { expiry_at: limits.expiry_at }),
      }).contract_id;
    },
    /** Best-effort orphan cleanup when an issuance fails after minting. */
    revokeTokenContract: (contractId) => {
      const store = getContractStore?.();
      if (!store) return;
      createContractDefinitionStore(store).revoke(
        contractId,
        'issuance failed after the carrier was minted',
      );
    },
    deriveGrantedToolClosure: (grants) => {
      const out = new Set<string>();
      const executeDeps = getExecuteDeps();
      // ⚠ No execute deps ⇒ no op lowering ⇒ recipe closures resolve to
      // nothing. The rpc refuses an empty closure, so a pre-init server cannot
      // mint a token whose promise it could not compute.
      const resolveOp =
        executeDeps === undefined ? undefined : composeRecipeOpResolver(executeDeps);
      for (const [toolName, allowed] of Object.entries(grants)) {
        if (!allowed) continue;
        // A kernel op granted by its own op id (D-232 § 20.20) IS the op id.
        if (isRegisteredKernelOp(toolName) && isGrantableKernelOp(toolName)) {
          out.add(toolName);
          continue;
        }
        if (toolName.startsWith(RAW_OP_TOOL_PREFIX)) {
          const opId = toolName.slice(RAW_OP_TOOL_PREFIX.length);
          if (opId.length > 0) out.add(opId);
          continue;
        }
        const entry = internalRegistry.getByName(toolName);
        if (entry === null || entry.tier !== 2) continue;
        const separator = toolName.indexOf('/');
        if (separator <= 0 || separator === toolName.length - 1) continue;
        const recipe = recipeStore.get(toolName.slice(separator + 1));
        if (recipe === null) continue;
        try {
          const derived = deriveResolvedRecipeCapability(recipe, recipe, {
            ...(resolveOp === undefined ? {} : { resolveOp }),
          });
          if (!derived.ok) continue;
          for (const op of derived.capability.operation_ids) out.add(op);
        } catch {
          // An unanalysable recipe narrows the closure; it never widens it.
        }
      }
      return [...out].sort();
    },
    executionCaseFeedbackRecorder:
      executionCases.feedbackRecorder,
    executionCaseLifecycle: executionCases.lifecycle,
    executionSpanAnchorStore: getSpanAnchorDeps().store,
    deleteSessionExecutionCases: executionCases.deleteSession,
    // D-219 item 2 — the owner's view of their own corpus, and its unlearn.
    // Both go straight to the case store / compiler: there is no experiment
    // gate here and there must not be one. The owner may always see what was
    // learned from them, whatever a study happens to be running.
    executionCaseLearned: async () => {
      await executionCases.compiler.ensureCurrent();
      const rows = (await executionCases.caseStore.listAll())
        .filter((row) => row.superseded_by === undefined);
      // ⛔ ONE query for the whole list, keyed on `case_key` — see the store's
      // header for why not `case_id`. ⚠ `.map(executionCaseLearnedEntry)` would
      // pass the ARRAY INDEX as the second argument now that one exists; the
      // arrow is not stylistic.
      const authored = authoredStore.listForKeys(rows.map((row) => row.case_key));
      // ⛔ Resolve the stored hash against the recipe as it is NOW. Without this
      // the hash was write-only and the annotation could point at a recipe the
      // owner had deleted. Local reads, bounded by what the panel renders.
      const resolved = new Map(
        [...authored].map(([case_key, links]) => [case_key, links.map((link) => ({
          ...link,
          state: resolveAuthoredState(link, (recipe_id) => {
            const recipe = recipeStore.get(recipe_id);
            return recipe ? hashRecipe(recipe) : undefined;
          }),
        }))]),
      );
      return rows
        .map((row) => executionCaseLearnedEntry(row, resolved.get(row.case_key)))
        .sort((left, right) => right.last_seen_at - left.last_seen_at);
    },
    // D-219 — the owner SAVED a recipe they drafted from a case. Recorded here
    // rather than inside `recipe.save`, which knows nothing about cases and
    // should not learn: a missing link costs an annotation, never a recipe.
    //
    // ⛔ The CLIENT SUPPLIES NO HASH AND NO KEY. It knows only `case_id`; this
    // resolves the durable `case_key` off the case row and hashes the stored
    // recipe itself, so a caller cannot assert that some arbitrary recipe came
    // from some arbitrary case.
    executionCaseAuthored: async (input) => recordAuthoredLink({
      loadCaseKey: async (case_id) =>
        (await executionCases.caseStore.get(case_id))?.case_key,
      loadRecipeHash: (recipe_id) => {
        const recipe = recipeStore.get(recipe_id);
        return recipe ? hashRecipe(recipe) : undefined;
      },
      store: authoredStore,
      now: () => Date.now(),
    }, input),
    executionCaseForget: async (case_id) => {
      const result = await executionCases.compiler.forgetCase(case_id);
      return {
        removed: result.removed,
        cases_remaining: result.cases_remaining,
      };
    },
    // D-219 item 2b — the owner's model drafts a recipe from one case.
    // ⛔ Composed, never invoked from here: only the rpc reaches it, and only
    // an owner pressing a button reaches the rpc.
    //
    // ⚠ ONE DRAFT PER CASE AT A TIME, enforced HERE rather than in the panel.
    // The panel's own guard covers one mounted instance; a second tab, a
    // reconnect, or any paired rpc client can fire concurrently, and each call
    // is a slow one against the owner's quota. Concurrent drafts of the SAME
    // case can only produce the same answer twice.
    executionCaseDraftRecipe: async (input) => {
      if (draftsInFlight.has(input.case_id)) {
        return {
          ok: false as const,
          // ⛔ NOT `invalid_recipe`. Nothing was drafted and the model is
          // blameless — a second press landed while the first call is still
          // out. Saying so is the difference between "wait" and "rewrite your
          // instruction", and only one of them is true.
          reason: 'already_running' as const,
          issues: ['A draft for this turn is already being written. '
            + 'Wait for it to finish.'],
        };
      }
      draftsInFlight.add(input.case_id);
      try {
        // ⛔ RECORDED BEFORE THE CALL, not after. The owner is billed the moment
        // the model runs, so the provenance fact must exist even if the response
        // is unusable or the client vanishes mid-flight — otherwise a draft they
        // paid for cannot be annotated when they later save it.
        // ⚠ A draft that fails validation still counts: they paid, and the guard
        // is about "did this server draft for this case", not about the result.
        {
          const row = await executionCases.caseStore.get(input.case_id);
          if (row) authoredStore.recordDraftIssued(row.case_key, Date.now());
        }
        return await draftRecipeForCase(
      {
        // The owner's own model, on the same adapters + quota as everything
        // else. No config resolves ⇒ the call throws and the surface says so,
        // rather than silently drafting from nothing.
        generate: async (prompt) => {
          const cfg = getLlmConfig();
          if (!cfg) {
            throw new LLMError('AI_LLM_UNAVAILABLE', 'no LLM config', {});
          }
          return executeLLM(RECIPE_DRAFT_MANIFEST, {
            'llm.data': prompt,
            // Names the recipe's top-level keys in the system prompt, so the
            // model returns the recipe OBJECT rather than a string holding one.
            'llm.fields': [...RECIPE_DRAFT_FIELDS],
          }, {
            config: cfg,
            adapters: llmAdapterRegistry,
            quota: llmQuota,
            tabProbe: emptyTabProbe,
            webChatSupported: false,
            // D-250 § D — recipe drafting is a real provider call and was the
            // last chat-side path reporting nothing.
            onTokenUsage: (u) => { deps.addOwnerTokenUsage?.(u.total_tokens); },
          }).then((body) => {
            const content = (body as { content?: unknown })?.content;
            return typeof content === 'string' ? content : JSON.stringify(body);
          });
        },
        parse: (value) => {
          const parsed = parseRecipe(value);
          return parsed.ok
            ? { ok: true, recipe: parsed.recipe, issues: parsed.issues }
            : { ok: false, issues: parsed.issues };
        },
        loadEntry: async (case_id) => {
          const row = await executionCases.caseStore.get(case_id);
          return row ? executionCaseLearnedEntry(row) : undefined;
        },
        // ⚠ `session_id`'s first consumer — slice 5 recorded it (V14) and
        // nothing read it until now. The case itself does not carry one; its
        // OBSERVATIONS do, reached through the source reports.
        // ⛔ THE OBSERVATION MUST BE THE ONE THE OWNER IS LOOKING AT. An
        // earlier version took the lexically-first source report's OLDEST
        // observation, while the prompt renders the case's TOP-RANKED flow
        // (weight, then recency). Those disagree the moment a case has more
        // than one flow: the model would get flow B's tool sequence beside
        // flow A's request and example — a description of one turn stitched to
        // the evidence of another.
        //
        // The join is `flow_basis` + the tool sequence, and among matches the
        // NEWEST observation wins — the display orders by weight then recency,
        // so anything else stitches one turn's request to another's recipe.
        // ⚠ Not `exact_signature`, which would be exact: `ExecutionCaseFlow`
        // does not carry it (only the OBSERVATION's `flow_pattern` does), so
        // using it means adding a field to a sealed materialized shape and
        // bumping the compiler version. Two flows with the same basis AND the
        // same tool sequence but different recipes are still indistinguishable
        // here; that is the residual, and it is why this is narrowed rather
        // than called solved.
        loadOrigin: async (case_id) => {
          const row = await executionCases.caseStore.get(case_id);
          // ⛔ THE SAME FLOW THE OWNER SEES, off the shared ordering.
          const top = row ? eligiblePrecedentRowFlows(row)[0] : undefined;
          const observations = [];
          for (const reportId of
            executionCases.caseStore.sourceReportIds(case_id)) {
            const stored = await executionCases.reportStore.get(reportId);
            if (!stored) continue;
            observations.push(...await executionCases.caseStore
              .listObservationsForRoot(stored.report.root_request_id));
          }
          const chosen = selectOriginObservation(observations, top);
          return chosen === undefined ? undefined : {
            session_id: chosen.session_id,
            root_request: chosen.root_request,
            recipes: chosen.flow_pattern.recipe_refs.map((ref) => ({
              recipe_id: ref.recipe_id,
              recipe_hash: ref.recipe_hash,
            })),
          };
        },
        aliasRequest: (aliasInput) => aliasCasePromptForAuthoring(
          {
            harvest: chatStore.harvestPiiSources!,
            // ⛔ A DETACHED ledger store, never `sessionLedgerStore`. Drafting
            // is an offline read that can overlap a live turn, and the live
            // path stages/commits a ledger clone per request precisely so two
            // overlapping requests cannot allocate one alias to two people.
            // Allocating into the live ledger from outside that lease lets a
            // later commit erase this allocation or publish conflicting
            // numbering in a session the owner is reading. The ordering seed
            // still runs, so numbering is derived from the same durable rows.
            ledgers: piiEgress.createSessionLedgerStore(),
            seedSlotOrdering: createChatPiiSlotOrderingSeeder({
              store: chatStore,
            }),
          },
          aliasInput,
        ),
        // ⛔ Two gates, both load-bearing. The HASH: `recipeStore.get` resolves
        // by id, and a recipe the owner edited since is a different thing under
        // the same name — offering v2 as "what this flow ran" is false, and it
        // is a fresh egress surface for whatever they hard-coded into it. The
        // SHAPE projection: a stored recipe may carry literal argument values
        // and string defaults, and this path bypasses the egress boundary the
        // request beside it goes through.
        loadRecipeShape: (ref) => {
          const recipe = recipeStore.get(ref.recipe_id);
          if (!recipe || hashRecipe(recipe) !== ref.recipe_hash) return undefined;
          return recipeShapeExample(recipe);
        },
        vocabulary: () =>
          buildRecipeAuthoringVocabulary(KERNEL_MANIFESTS, KERNEL_OP_REGISTRY),
      },
          {
            case_id: input.case_id,
            ownerPrompt: input.prompt,
            ...(input.previous_recipe !== undefined
              ? { previousRecipe: input.previous_recipe }
              : {}),
          },
        );
      } finally {
        draftsInFlight.delete(input.case_id);
      }
    },
    executionCaseDiagnostics: async () => ({
      active_experiment:
        executionCases.activeExperimentReport !== undefined,
      compiler: await executionCases.compiler.diagnostics(),
      // D-219 — what RETRIEVAL did this boot. `attached / ranked` is the rate
      // the relevance filter exists to hold down, and `single_term_cards` is
      // the residual it cannot: a filter that is language-bound has to be
      // observable per deployment, or an unlisted language degrades in silence.
      ...(executionCases.precedentObservation
        ? { precedent: executionCases.precedentObservation() }
        : {}),
      ...(executionCases.activeExperimentReport
        ? {
            experiment:
              await executionCases.activeExperimentReport(),
          }
        : {}),
    }),
    // D-167 P5 S4 — purge the session's RAM-only PII alias ledger on
    // `chat.session.delete` (spec §"Alias ledger"). Same store the
    // orchestrator's bookend hooks allocate against.
    dropSessionPiiLedger: (session_id) => {
      sessionLedgerStore.drop(session_id);
    },
    // D-171 slice 2c (+ slice-2c follow-on #1) — the Permissions → MCP door
    // per-tool grant checklist's catalog source: the tools an inbound MCP peer
    // using a door token can be granted + call. Read per-call so installs /
    // connection edits reshape the catalog live. Two groups, matching exactly
    // what a door token's `tools/list` advertises + the per-token gate
    // (`inboundTokenAuthorize`) enforces:
    //   1. The `InternalToolRegistry` Tier 1 + 2 surface, filtered to drop
    //      Tier 3 (`connection.mcp.*` peer passthroughs — Mary's OUTBOUND
    //      credentials; the inbound wire hides them from `tools/list` and
    //      `handleToolCall` rejects them, so a Tier 3 grant could never make
    //      the tool callable — Codex slice-2c review P2; no no-op grant).
    //   2. The legacy `recued_*` meta tools + `recued_ingredient_*`
    //      per-ingredient tools `handleToolsList` also advertises. Before the
    //      follow-on the catalog was registry-only, so these were
    //      advertised-but-un-grantable → the same gate denied them forever
    //      (safe default-deny, but a dead surface).
    //      `buildMcpGrantCatalogLegacyEntries` mirrors `handleToolsList`'s
    //      SERVER branch over the executor manifests. Door tokens reach the
    //      HTTP transport whose `baseMcpDeps` carries no `wsServer`, so their
    //      wire surfaces only server manifests (never extension-reported
    //      ingredients) — the projection matches that. Undefined executor
    //      config (pre-wire / dbless harness) ⇒ registry-only.
    catalogProvider: () => {
      // ⛔⛔ D-247 D8 — THE GRANT PICKER SHOWS HIDDEN RECIPES TOO, AND THIS IS THE
      // SAME DEFECT CODEX FOUND ON THE OWNER'S CATALOG, ONE SURFACE OVER.
      //
      // `internalRegistry.list()` projects Tier 2 through the `chat_exposed`
      // filter, so a hidden recipe never appeared here — and the owner could not
      // grant one to a DOOR even deliberately. `chat_exposed` is the AUTHOR's
      // default; it is a good default and a bad gate (D8), and that thesis does
      // not stop at the owner's own catalog.
      //
      // ⚠ THIS WIDENS NOTHING. It is the list the owner PICKS FROM when granting
      // an inbound token; every tool still defaults deny per-token, and a door
      // reaches a recipe only once the owner ticks it. Showing a choice is not
      // making it.
      const registryEntries = [
        ...internalRegistry.list().filter((entry) => entry.tier !== 3 && entry.tier !== 2),
        ...buildTier2Catalog(
          chatToolRegistryInputs.tier2Source.listRecipes(),
          chatToolRegistryInputs.manifestLookup,
          opKindLookup,
          true,
        ),
      ];
      const executorConfig = getExecutorConfig();
      // D-182 §8 — thread the installed-pack inventory scan so the grant catalog
      // ALSO offers grantable raw catalog ops (`recued_op_<opid>`), plus the
      // recipe op-coverage set so a raw WRITE a recipe covers is suppressed
      // (Inc B-writes). Read lazily (live install state); absent (pre-wire /
      // dbless) ⇒ legacy-only, no raw ops / no suppression.
      const executeDeps = getExecuteDeps();
      const contractScan = executeDeps?.contractScan;
      // §8 recipe-preferred suppression — pass the SAME pack resolution the
      // descriptors use so a write a recipe covers via a lowered `ingredient:`
      // step (not just an `op:` step) is mapped to its op id + suppressed.
      const recipeOpCoverage = executeDeps?.recipeStore
        ? buildRecipeOpCoverage(
            executeDeps.recipeStore,
            contractScan && executorConfig
              ? buildPackOpResolution(
                  () => contractScan('installed_pack', []),
                  (slug) => executorConfig.manifests.get(slug),
                )
              : undefined,
          )
        : undefined;
      const legacyEntries = executorConfig
        ? buildMcpGrantCatalogLegacyEntries(
            executorConfig.manifests,
            contractScan ? () => contractScan('installed_pack', []) : undefined,
            recipeOpCoverage,
          )
        : [];
      return [...registryEntries, ...legacyEntries];
    },
  };

  return {
    chatStore,
    // Source-scoped late outcomes for previously held owner-chat calls.
    runSettledSink: createChatRunSettledSink(chatStore, selfSignature, broadcast),
    toolCatalogStore,
    connectionMcpStore,
    inboundTokenStore,
    internalRegistry,
    orchestrator,
    chatDeps,
    executionCaseLifecycle: executionCases.lifecycle,
    executionCaseVerificationRecorder: executionCases.verificationRecorder,
    publishExecutionCaseOfferNotifier:
      executionCases.publishExecutionCaseOfferNotifier,
    executionCaseArgumentStore: executionCases.argumentStore,
    executionCaseSourcePruner: executionCases.compiler,
    forwardedSenderIndex,
  };
};
