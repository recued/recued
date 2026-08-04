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
import {
  LLMError,
  executeLLM,
  createDefaultTranscriptionRegistry,
} from '@recued/llm';
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
import { primitiveGrantEntry } from '@recued/contracts';
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
import { createOpKindLookup, hashRecipe, parseRecipe } from '@recued/recipes';
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
import type { ContractStore } from '../../storage/contract-store.js';
import { createContractDefinitionStore } from '../../storage/contract-definition-store.js';
import type { WorkEntityResolver } from '../../work-entity-resolver.js';
import type { WorkEntityTargetedReadDeps } from '../../work-entity-write-executor.js';
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
import { piiEgress } from '@recued/gateway';
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
  broadcastEmitterFromBus,
  createChatOrchestrator,
  parseChatCatalogProjectionEnv,
  resolveCatalogProjectionForSource,
  type ChatOrchestrator,
  type ExecuteChatAiCall,
} from '../../chat-orchestrator.js';
import {
  resolveLlmSystemPrompt,
  type LlmPromptSurface,
} from '../../llm-system-prompt.js';
import type { ChatRpcDeps } from '../../chat-handler.js';
import { assertRecordsNonOwnerRecipeExposure } from '../../records/non-owner-exposure.js';
import { buildChatToolRegistryInputs } from '../../chat-tool-handlers.js';
import { tokenUsageToReport } from '../../chat-token-usage.js';
import type { EventBus } from '../../events/bus.js';
import type { KeyManager } from '../../key-manager.js';
import type { ContactStore } from '../../storage/contact-store.js';
import type { UserMemoryStore } from '../../user-memory-store.js';
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
  getEnrichmentStore: () => EnrichmentStore | undefined;
  /** D-198 Slice 4 — the `user_memory` store the `memory.write` chat tool writes
   *  to + the widened `memory.search` unions. Late-bound like the other store
   *  getters; absent (db-less) → the write tool degrades + search stays
   *  audit-only. */
  getUserMemoryStore?: () => UserMemoryStore | undefined;
  /** D-198 Slice 4 — the redaction-marker store so `memory.search` omits
   *  "forgotten" rows from recall. Late-bound alongside the user_memory store. */
  getMemoryRedactionStore?: () => Collection<MemoryRedactionRecord> | undefined;
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
}

/** Everything `bin.ts` retains on the module-scope `let`-bindings. */
export interface ChatOrchestratorBundle {
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
    getCrmRecordMirror,
    getConnectionStore,
    getExecutorConfig,
    getExecuteDeps,
    getContractStore,
    getWorkEntityResolver,
    getWorkEntityTargetedReadDeps,
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
  const chatToolRegistryInputs = buildChatToolRegistryInputs({
    getContactStore,
    getCollectionRegistry,
    getAuditLog: () => auditLog,
    // D-198 Slice 4 — memory.write target + memory.search union source + the
    // redaction store (recall omits forgotten rows) + the realtime bus so an AI
    // memory write live-refreshes paired Memory lenses.
    ...(getUserMemoryStore ? { getUserMemoryStore } : {}),
    ...(getMemoryRedactionStore ? { getMemoryRedactionStore } : {}),
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
    // D-225 § 9.5.1 step 2b — the raw-op dispatch deps, late-bound for the same
    // reason `getExecuteRecipe` is: this composes before the executor exists.
    // `dispatchRawOp` takes a Pick of the execute deps, so this is the same
    // handle, narrowed by the callee rather than here.
    getRawOpDispatchDeps: () => getExecuteDeps(),
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
    admitTier1: (name, ctx) => {
      const gate = getExecuteDeps()?.opAdmissionGate;
      if (gate === undefined || ctx.execution_source === undefined) return true;
      return gate.isOpGranted(ctx.execution_source, primitiveGrantEntry(name));
    },
    tier2Source: chatToolRegistryInputs.tier2Source,
    manifestLookup: chatToolRegistryInputs.manifestLookup,
    opKindLookup,
    tier2Dispatch: chatToolRegistryInputs.tier2Dispatch,
    tier3Dispatch: chatToolRegistryInputs.tier3Dispatch,
    tier3Source: {
      listAnnotations: () => listLiveMcpAnnotations(),
    },
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
  // Lever-2 per-slot — the smart auto-default (`free_pool → index`, BYOK slots
  // stay `full`). ON by default as of 2026-07-03: the "proven-safe" gate cleared
  // both qwen3.7-plus (discovery 92%) and a weak reasoning model (gemma-4-31b-it,
  // 3-pass: free_pool→index holds routing, over-search guard intact,
  // reports/leancore-discovery-weakmodel-FINDING.md). Set the value to the
  // literal `0` to opt out; ONLY `0` disables (any other value, incl. unset,
  // enables — the symmetric inversion of the prior `=== '1'`). A per-source
  // override in Settings → AI/Models still wins over the smart default either way.
  //
  // ⚠ Precedence (resolveCatalogModeForSource): explicit override → smart
  // default (known source) → env-global `RECUED_CHAT_CATALOG_MODE` → full. So
  // with smart-defaults ON, the per-source default now takes precedence over an
  // env-global mode for a KNOWN source: a deployment that thinned EVERYTHING via
  // `RECUED_CHAT_CATALOG_MODE=index` sees its BYOK slots revert to `full` on
  // upgrade (free_pool stays index). A local BYOK slot (Ollama/vLLM — no prompt
  // cache) that wants thinning must set `RECUED_CHAT_CATALOG_SMART_DEFAULTS=0`
  // (restores the env-global/full resolution) or a per-source `index` override.
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
    ),
    {
      backend: createRecallSearchBackend(chatStore),
      // The contract substrate boots after chat composition. Resolve the live
      // store at dispatch time; the definition wrapper is stateless.
      getContractDefinitionStore: () => {
        const store = getContractStore?.();
        return store ? createContractDefinitionStore(store) : undefined;
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
    };
    const body = await executeLLM(manifest, input, {
      config: cfg,
      adapters: llmAdapterRegistry,
      quota: llmQuota,
      tabProbe: emptyTabProbe,
      webChatSupported: false,
      onTokenUsage: captureUsage,
    });
    return {
      body,
      ...(captured ? { usage: tokenUsageToReport(captured) } : {}),
    };
  };
  const messengerVoiceTranscription = llmConfig
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
          tabProbe: emptyTabProbe,
          webChatSupported: false,
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

  const orchestrator = createChatOrchestrator({
    chatStore,
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
    rawOpSource: chatToolRegistryInputs.rawOpSource,
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
    ...(messengerVoiceTranscription ? { messengerVoiceTranscription } : {}),
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
  });

  const chatDeps: ChatRpcDeps = {
    store: chatStore,
    toolCatalogStore,
    connectionMcpStore,
    orchestrator,
    broadcast,
    ...(auditLog ? { auditLog } : {}),
    selfSignature,
    planApprovalStore: planApprovalStoreShared,
    inboundTokenStore,
    preflightExternalToolGrant: (toolName) => {
      const entry = internalRegistry.getByName(toolName);
      if (entry === null) {
        throw new Error(`tool '${toolName}' is not currently grantable`);
      }
      if (entry.tier !== 2) return;
      const separator = toolName.indexOf('/');
      if (separator <= 0 || separator === toolName.length - 1) return;
      const recipe = recipeStore.get(toolName.slice(separator + 1));
      const recordsStore = getExecuteDeps()?.recordsStore;
      if (recipe === null || recordsStore === undefined) return;
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
      const registryEntries = internalRegistry
        .list()
        .filter((entry) => entry.tier !== 3);
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
