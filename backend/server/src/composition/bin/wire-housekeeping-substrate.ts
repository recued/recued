/** D-123 — housekeeping substrate composer.
 *
 *  Three composers in one file. All three touch the D-123 housekeeping
 *  surface; colocating them keeps the substrate code in one place.
 *
 *  1. `composeHousekeepingStores` — module-level boot. Constructs the
 *     four long-lived housekeeping stores: config (singleton row),
 *     state (per-task cursor rows), trust (D-132 P2 per-topic
 *     trust + pool policy), and the MCP visibility user-override store
 *     (D-136 §A.13.5 P7.G). Gated on `db` — dbless harnesses leave
 *     every field undefined so the rpc surface returns
 *     `not_configured`.
 *
 *  2. `composeHousekeepingRpcDeps` — rpc-deps for the Settings →
 *     Server → Housekeeping panel. Wires the `runOnce` /
 *     `getEnrichmentInfo` closures against the stores + the late-bound
 *     scheduler ref (via getter). Returns `undefined` when stores
 *     aren't configured so the caller spreads `{}` into the handler
 *     set args.
 *
 *  3. `composeHousekeepingScheduler` — cmdServe-resident, async. Runs
 *     the producer registration loop (the four core tasks +
 *     conditional contact-merge / TLS cert / work-entity sweep tasks
 *     from D-138 / D-148 / D-145 + every `PER_RECORD_PRODUCERS`
 *     entry), constructs the composite busy signal (auto-run + adapter
 *     drains), builds the `HousekeepingScheduler` with its full ctx
 *     (LLM callables, trust store, event bus, cache blobs, audit
 *     emitter, cycle observers), and arms `.start()` iff the user's
 *     preset isn't `'off'`. Returns the scheduler + the per-task
 *     enrichment-producer map for the `housekeeping.status.read` rpc.
 *
 *  Late-bound state — `autoRunHandle`, the contact-merge cycle
 *  observer, the active contact-merge scan mode, and the housekeeping
 *  scheduler itself — flow as getter closures (`() => autoRunHandle?
 *  .inFlight()` etc.) so the scheduler / rpc handlers see the live
 *  values at runtime even though the construction order is fixed. */

import type Database from 'better-sqlite3';
import type { ActivityAction, AuditLogStore } from '@recued/storage';
import type { WarehouseEventBus } from '@recued/warehouse-events';
import type { ReminderLedger } from '../../work-entity-reminder-sweep.js';
import type { EventBus } from '../../events/bus.js';
import type { ContactStore } from '../../storage/contact-store.js';
import type { ContractStore } from '../../storage/contract-store.js';
import type {
  SellerAccessReconcileDeps,
} from '../../housekeeping/tasks/seller-access-reconcile.js';
import type {
  McpToolsDriftProbeDeps,
} from '../../housekeeping/tasks/mcp-tools-drift-probe.js';
import type {
  McpPackFirstMintDeps,
} from '../../housekeeping/tasks/mcp-pack-first-mint.js';
import type { EnrichmentStore } from '../../storage/enrichment-store.js';
import type { CrmRecordMirrorStore } from '../../storage/crm-record-mirror-store.js';
import { resolveServerTimeZone, shouldSuppressForQuietHours } from '@recued/contracts';
import type { WorkEntityStore } from '../../storage/work-entity-store.js';
import type { UserMemoryStore } from '../../user-memory-store.js';
import type { WebclientUploadService } from '../../upload/webclient-upload-service.js';
import type { ArchiveUploadService } from '../../archive/archive-upload-service.js';
import type { RecipeStore } from '../../recipe-store.js';
import type { CollectionRegistry } from '../../collections/registry.js';
import type { ContactMergeCycleObserver } from '../../contact-merge-cycle-observer.js';
import type { BlobStore } from '../../storage/index.js';
import type {
  HousekeepingConfigStore,
  HousekeepingEnrichmentProducer,
  HousekeepingScheduler,
  HousekeepingStateStore,
  LlmResultCacheStore,
  PerRecordWalkerKind,
  SourceCollectionWalker,
  TrustStore,
  TunableParamsStore,
} from '../../housekeeping/index.js';
import {
  createHousekeepingConfigStore,
  createHousekeepingStateStore,
  createHousekeepingScheduler,
  createEngineBusySignal,
  registerHousekeepingTask,
  getHousekeepingTask,
  listHousekeepingTasks,
  buildEnrichmentProducerTask,
  createLlmResultCacheStore,
  createMailSourceWalker,
  createFileSourceWalker,
  createNoteSourceWalker,
  createTaskSourceWalker,
  createProjectSourceWalker,
  createSourceWalkerRegistry,
  createTunableParamsAccessor,
  createTunableParamsStore,
  hashMailRecordWithBody,
  STANDALONE_TASKS,
  PER_RECORD_PRODUCERS,
  createTrustStore,
  probeAiPathAvailability,
  probeEmbeddingsPathAvailability,
  isByokAllowedForBackground,
} from '../../housekeeping/index.js';
import { buildTlsCertRenewalTask } from '../../housekeeping/tasks/tls-cert-renewal.js';
import type { VendorRateGate } from '../../housekeeping/reconciliation/vendor-rate-gate.js';
import { createUpdateAutoApplyTask } from '../../update/auto-apply-task.js';
import { updateAutoApplyRegistry } from '../../update/auto-apply-registry.js';
import { createEnrichmentPiiTagSourceFromLocalManifestStore } from '../../housekeeping/enrichment-pii-tag-source.js';
import { CANONICAL_PII_ENTITY_SCHEMAS } from '../../canonical-pii-schemas.js';
import type {
  EnrichmentPiiTagSource,
  HousekeepingTaskInstance,
} from '../../housekeeping/registry.js';
import { createLocalManifestStore } from '../../ingredient-authoring/local-manifest-store.js';
import { liveVendorRegistry } from '../../connection-convention-families.js';
import type { ContactEngagementsResolveDeps } from '../../contact-engagements-rpc-handler.js';
import type { CommitmentEvidenceRuntime } from '../../commitment-evidence-capture.js';
import { createCommitmentExtractionLedger } from '../../storage/commitment-extraction-ledger.js';
import { runCommitmentProposalFunnel } from '../../housekeeping/engagement-aggregates/commitment-extraction-funnel.js';
import type { ContractGrantEntryStore } from '../../storage/contract-grant-entry-store.js';
import type { CascadeEngine } from '../../storage/enrichment-cascade.js';
import type { ExternalContextDependencyRegistry } from '../../storage/external-context-pulse.js';
import type { CertSource } from '../../pairing/cert-source.js';
import type { RotationEngine } from '../../keys/rotation/index.js';
import type { HousekeepingLlmCallables } from './wire-llm-substrate.js';
import type { HousekeepingRpcDeps } from '../../housekeeping-handler.js';
import type {
  HousekeepingEnrichmentInfo,
  HousekeepingScopeReadEntry,
} from '@recued/contracts';
import type { LLMConfig, QuotaTracker } from '@recued/llm';
import type { EnrichmentProducerEntry } from './housekeeping-scheduler-instance.js';
import { listCollectionDataTables } from '../../collections/table.js';

/**
 * STORE COMPOSER — Phase 1.
 */

export interface ComposeHousekeepingStoresDeps {
  db: Database.Database | undefined;
}

export interface HousekeepingStores {
  configStore: HousekeepingConfigStore | undefined;
  stateStore: HousekeepingStateStore | undefined;
  trustStore: TrustStore | undefined;
  /** D-145 § A.7.8 (Amended 2026-05-26) — per-topic tunable-params
   *  store. Producers read effective values through the accessor on
   *  `HousekeepingContext.tunableParams`; the accessor is constructed
   *  off this store in `composeHousekeepingScheduler`. Mutations write
   *  through `housekeeping.tunable_params.*` rpcs that pick the store
   *  off the rpc deps. */
  tunableParamsStore: TunableParamsStore | undefined;
  /** D-145 § A.7.10 (Amended 2026-05-26) — content-addressed LLM
   *  result cache. AI producers opt into reuse via `compose_input` on
   *  `runAIProducer`; identical inputs across records skip the model
   *  call. Wired onto `HousekeepingContext.llmResultCache` so the
   *  wrapper picks it up automatically. */
  llmResultCacheStore: LlmResultCacheStore | undefined;
}

export const composeHousekeepingStores = (
  deps: ComposeHousekeepingStoresDeps,
): HousekeepingStores => {
  if (!deps.db) {
    return {
      configStore: undefined,
      stateStore: undefined,
      trustStore: undefined,
      tunableParamsStore: undefined,
      llmResultCacheStore: undefined,
    };
  }
  return {
    configStore: createHousekeepingConfigStore(deps.db),
    stateStore: createHousekeepingStateStore(deps.db),
    // D-132 P2 — trust + pool-policy store. Drives the scheduler's
    // idle-eligibility filter and the enrichment harness's per-record
    // forceLayer threading.
    trustStore: createTrustStore(deps.db),
    // D-145 § A.7.8 — per-topic tunable-params store. Accessor on the
    // scheduler ctx is constructed off this single instance.
    tunableParamsStore: createTunableParamsStore(deps.db),
    // D-145 § A.7.10 — content-addressed LLM result cache. Single
    // instance per pair; threaded into the scheduler ctx so
    // `runAIProducer` resolves hits before re-calling the model.
    llmResultCacheStore: createLlmResultCacheStore(deps.db),
  };
};

/**
 * RPC-DEPS COMPOSER — Phase 1.5.
 */

/** Counts source records in a given enrichment scope. Drives the
 *  Run-Now dialog's "estimated tokens × N records" preview. Mail is
 *  the only scope D-123 + first AI producer (`summary`) cover; other
 *  scopes return 0 until their producers ship. The query scans
 *  `sqlite_master` for the per-account `collection_<scope>_<hash>`
 *  tables — same approach the canary `thread_signals` producer uses
 *  for its thread-walk SQL — so new mail accounts are picked up
 *  without a registry pass. */
const countHousekeepingSourceRecords = (
  database: Database.Database,
  scope: string,
): number => {
  if (scope !== 'mail') return 0;
  const tables = listCollectionDataTables(database, 'mail');
  let total = 0;
  for (const name of tables) {
    const row = database
      .prepare(`SELECT COUNT(*) AS n FROM "${name}"`)
      .get() as { n: number };
    total += row.n;
  }
  return total;
};

export interface ComposeHousekeepingRpcDepsArgs {
  db: Database.Database | undefined;
  /** Output of `composeHousekeepingStores`. `configStore` + `stateStore`
   *  must be defined for the composer to return a deps object;
   *  otherwise the composer returns `undefined` and the caller spreads
   *  `{}` into the handler-set args. */
  stores: HousekeepingStores;
  enrichmentStore: EnrichmentStore | undefined;
  auditLog: AuditLogStore | undefined;
  eventBus: EventBus;
  /** LLM substrate handles for the Run-Now AI-availability probe.
   *  `llmConfig` is undefined when the encryption substrate is locked /
   *  uninitialized — the probe surfaces `no_chat_model` then. */
  llmConfig: LLMConfig | undefined;
  /** D-174 R28 Slice C — per-use LIVE config resolver (from the LLM
   *  substrate). The EMBEDDINGS probe calls this so a saved embeddings slot
   *  is reflected in the Run-Now dialog without a restart; the chat probe
   *  ⚠ Was "keeps the boot `llmConfig` (matches the still-boot chat executor)"
   *  until 2026-09-07 — the chat executor now resolves live too, so this is the
   *  single source both it and the idle-cycle AI gate read. */
  resolveLlmConfig: () => LLMConfig | undefined;
  llmQuota: QuotaTracker;
  /** Caller-owned producer registry — same map the scheduler composer
   *  populates (production wires the shared
   *  `housekeepingSchedulerRegistry.producers()` Map into both
   *  composers). The rpc closure reads it by reference so post-compose
   *  registrations are visible. */
  enrichmentProducers: Map<string, EnrichmentProducerEntry>;
  /** Late-bound — the housekeeping scheduler is constructed AFTER this
   *  composer runs (rpc handlers fire after server boot completes). The
   *  closure reads the live ref at call time. */
  getScheduler: () => HousekeepingScheduler | undefined;
  /** D-187 AMENDMENT — the unified per-contract grant store (built from the contract
   *  store upstream). Threaded into `housekeeping.registry.describe` so the Settings
   *  panel resolves effective `mcp_exposed` against the OWNER contract's
   *  `enrichment.<topic>` grant rows. Optional; absent (dbless / no contract store) →
   *  registry author defaults. */
  grantEntryStore?: ContractGrantEntryStore;
}

/** D-286 — the part of a standalone task's enrichment info that needs no IO,
 *  split out so it can be tested against the REAL task objects rather than
 *  through the composer's mocks.
 *
 *  Returns undefined for a task that is absent or not `kind: 'enrichment'`.
 *  Otherwise reports the only two things a standalone task actually knows
 *  about its own cost: whether it spends tokens, and (sometimes) how many per
 *  record. Never a source-record count — see the caller. */
export const standaloneEnrichmentBase = (
  task: HousekeepingTaskInstance | undefined,
): HousekeepingEnrichmentInfo | undefined => {
  if (!task || task.meta.kind !== 'enrichment') return undefined;
  if (task.is_ai_surface !== true) {
    // Deterministic: zero is a REAL zero here, and the preview short-circuits
    // on it without ever needing a record count.
    return { token_estimate_per_record: 0, is_ai_surface: false };
  }
  // ⛔ The estimate is passed through, not defaulted. Five AI-surface
  // standalone tasks declare none, and a 0 would read as "costs nothing".
  return {
    ...(task.token_estimate_per_record !== undefined
      ? { token_estimate_per_record: task.token_estimate_per_record }
      : {}),
    is_ai_surface: true,
  };
};

export const composeHousekeepingRpcDeps = (
  args: ComposeHousekeepingRpcDepsArgs,
): HousekeepingRpcDeps | undefined => {
  const { configStore, stateStore, trustStore, llmResultCacheStore } =
    args.stores;
  if (!configStore || !stateStore) return undefined;

  const {
    db,
    enrichmentStore,
    auditLog,
    eventBus,
    llmConfig,
    resolveLlmConfig,
    llmQuota,
    enrichmentProducers,
    getScheduler,
  } = args;

/** D-286 — enrichment info for a STANDALONE task: one registered directly
   *  via `registerHousekeepingTask` rather than built by
   *  `buildEnrichmentProducerTask`, so it has no walker and no entry in
   *  `enrichmentProducers`.
   *
   *  ⛔ WHAT THIS FIXES. `getEnrichmentInfo` returned undefined for these, and
   *  the panel's `runNowDisabled = !enrichment || trustState === 'off'` turned
   *  that into a *Run now* button that could never be pressed — 26 of 74 rows,
   *  including `confidence_drift_signal`, whose banner is the only drift
   *  surface the owner has. Worse for the AI ones: `_record-ai-task`'s own
   *  comment says `maybeBumpManualRun` counts a Run-Now toward promotion ONLY
   *  for an AI-surface enrichment task, and D-139 slice 4 registered those
   *  tasks precisely so `manual_run_count` could reach `MANUAL_RUN_THRESHOLD`.
   *  The disabled button meant it still could not.
   *
   *  ⚠ WHAT IT DELIBERATELY DOES NOT CLAIM. A standalone task declares no
   *  source scope, so `source_collection_count` is genuinely unknown and is
   *  OMITTED rather than sent as 0 — a zero renders "0 tokens" on a run that
   *  spends them. And five of these declare `is_ai_surface` with NO
   *  `token_estimate_per_record`, so the estimate is omitted too: keying off
   *  `tokens > 0` would have labelled `topic_cluster`, both
   *  `lifecycle_stage_inferred*`, `memory_embed_backlog` and
   *  `commitment_tracker` DETERMINISTIC — "pure SQL aggregation, no token
   *  cost" on the confirm dialog of a producer that fires AI calls. */
  const standaloneEnrichmentInfo = async (
    task_id: string,
  ): Promise<HousekeepingEnrichmentInfo | undefined> => {
    const base = standaloneEnrichmentBase(getHousekeepingTask(task_id));
    if (!base) return undefined;
    if (!base.is_ai_surface) return base;
    const task = getHousekeepingTask(task_id)!;
    const tokens = task.token_estimate_per_record;
    const probe = await probeAiPathAvailability(llmConfig, llmQuota);
    const trust = task.topic && trustStore ? trustStore.read(task.topic, true) : undefined;
    const global_byok_allowed = db ? isByokAllowedForBackground(db) : false;
    return {
      ...(tokens !== undefined ? { token_estimate_per_record: tokens } : {}),
      is_ai_surface: true,
      ai_path_available: probe.available,
      ...(probe.reason ? { ai_path_reason: probe.reason } : {}),
      effective_pool_policy: !global_byok_allowed
        ? ('free_only' as const)
        : (trust?.pool_policy ?? 'free_then_byok'),
      global_byok_allowed,
    };
  };

  return {
    config: configStore,
    state: stateStore,
    registry: () => listHousekeepingTasks(),
    runOnce: async (opts) => {
      const scheduler = getScheduler();
      if (!scheduler) {
        throw new Error('housekeeping scheduler not yet constructed');
      }
      return scheduler.runOnce(opts);
    },
    // Per-task token-cost preview + AI-availability probe for the
    // Run-Now dialog. AI-driven producers
    // (`estimate_per_record_tokens > 0`) trigger the
    // `buildAvailability` snapshot; the dialog renders the warning
    // state when no slot / pool path resolves. Deterministic producers
    // skip the probe — `ai_path_available` is left undefined so the
    // dialog renders the standard "no token cost" body.
    getEnrichmentInfo: async (task_id) => {
      if (!db) return undefined;
      const entry = enrichmentProducers.get(task_id);
      if (!entry) return standaloneEnrichmentInfo(task_id);
      const tokens = entry.producer.estimate_per_record_tokens();
      const source_collection_count = countHousekeepingSourceRecords(
        db,
        entry.producer.source_scope,
      );
      // D-132 P6 — declared scope-of-read with per-collection record
      // counts. The producer registers the manifest at boot; bin counts
      // records per collection at preview time so the dialog reflects
      // warehouse growth without a re-register. Counts fall back to
      // `undefined` for non-mail scopes until walkers ship —
      // `record_count` is optional on the wire shape.
      const scope_read: HousekeepingScopeReadEntry[] =
        entry.producer.scope_read_declaration.map((spec) => {
          const count = countHousekeepingSourceRecords(db, spec.collection);
          return {
            collection: spec.collection,
            sample_field_paths: spec.sample_field_paths,
            ...(count > 0 || spec.collection === entry.producer.source_scope
              ? { record_count: count }
              : {}),
          };
        });
      if (tokens === 0) {
        return {
          token_estimate_per_record: 0,
          is_ai_surface: false,
          source_collection_count,
          scope_read,
        };
      }
      // D-131 A.3 — `embedding` (and the future `semantic_cluster`)
      // probe the embeddings surface instead of chat. Pure-Anthropic
      // users surface `no_embeddings_model` here rather than
      // "available" followed by a use-time throw.
      // D-174 R28 Slice C — the embeddings probe reads LIVE config (matches
      // the per-use embeddings executor) so a just-saved embeddings slot
      // unblocks the dialog without a restart. The chat probe stays on the
      // boot snapshot (matches the still-boot chat executor — deferred).
      const probe = entry.producer.ai_surface === 'embeddings'
        ? probeEmbeddingsPathAvailability(resolveLlmConfig(), llmQuota)
        : await probeAiPathAvailability(llmConfig, llmQuota);
      // D-132 P6 — effective pool policy + global BYOK master. The
      // trust store's per-topic policy collapses to `'free_only'` when
      // the global master is off; surface both so the dialog can render
      // "free pool only — global BYOK switch is off" inline.
      const trust = trustStore
        ? trustStore.read(entry.producer.topic, true)
        : undefined;
      const global_byok_allowed = isByokAllowedForBackground(db);
      const effective_pool_policy = !global_byok_allowed
        ? ('free_only' as const)
        : (trust?.pool_policy ?? 'free_then_byok');
      return {
        token_estimate_per_record: tokens,
        is_ai_surface: true,
        source_collection_count,
        ai_path_available: probe.available,
        ...(probe.reason ? { ai_path_reason: probe.reason } : {}),
        scope_read,
        effective_pool_policy,
        global_byok_allowed,
      };
    },
    // D-132 P4 — per-topic trust state + pool policy. Drives
    // `housekeeping.trust.*` rpcs + the manual_run_count bump hook on
    // `task.run_now` for AI-surface manual producers.
    ...(trustStore !== undefined ? { trustStore } : {}),
    // D-132 P4 — realtime fan-out for the
    // `enrichment_promotion_suggested` event. Best-effort — missed
    // events recover on the next reconnect-replay from the bus ring.
    eventBus,
    // D-136 §A.12 P7 — `housekeeping.topic.reset` rpc deps. Both
    // optional so test setups exercising only trust / status surfaces
    // keep working; absent → topic-reset rejects with `unsupported`.
    ...(enrichmentStore ? { enrichmentStore } : {}),
    ...(auditLog ? { auditLog } : {}),
    // D-136 §A.13.1 + D-187 S3b — Settings UI capstone.
    // `housekeeping.registry.describe` reuses the MCP-side handler with
    // `includePrivateTopics: true`; the unified grant store (resolved against the OWNER
    // contract) + raw db handle let it surface effective `mcp_exposed` policies + the
    // same un-granted-topic-row subtraction as the MCP path. Optional throughout —
    // absent stores degrade to registry author default + skipped row counts.
    ...(args.grantEntryStore
      ? { grantEntryStore: args.grantEntryStore }
      : {}),
    ...(db ? { db } : {}),
    // D-145 PA11 — LLM result cache stats + Clear-cache rpcs. Optional
    // so test setups exercising only trust / status surfaces keep
    // working; absent → both cache rpcs reject with `unsupported`.
    ...(llmResultCacheStore ? { llmResultCache: llmResultCacheStore } : {}),
  };
};

/**
 * SCHEDULER COMPOSER — Phase 2.
 */

export interface ComposeHousekeepingSchedulerDeps {
  /** Required — the entire late phase no-ops without a database. */
  db: Database.Database;
  /** Output of `composeHousekeepingStores`. `configStore` + `stateStore`
   *  must be defined for the scheduler to compose; otherwise the
   *  composer returns an empty bundle. */
  stores: HousekeepingStores;
  /** Required for the producer registrations + the scheduler ctx. */
  enrichmentStore: EnrichmentStore;
  /** D-190 — the dedicated CRM record mirror, threaded onto the scheduler ctx so
   *  the vendor reconciliation harness upserts every CRM record unconditionally
   *  (deal.search reads it). Optional — absent ⇒ the harness skips the mirror
   *  write (dbless harnesses / tests). */
  crmRecordMirror?: CrmRecordMirrorStore;
  recipeStore: RecipeStore;
  collectionRegistry: CollectionRegistry;
  cacheBlobs: BlobStore;
  eventBus: EventBus;
  warehouseBus: WarehouseEventBus;
  auditLog: AuditLogStore | undefined;
  llmCallables: HousekeepingLlmCallables;

  /** Optional collaborators — each gates a per-task registration. */
  contactStore?: ContactStore;
  workEntityStore?: WorkEntityStore;
  /** D-269 step 2 — the per-kind notification policy the due-status sweep
   *  reads. Absent ⇒ the sweep falls back to the shared 24h constant with every
   *  kind enabled, which is the pre-D-269 behaviour. */
  notificationKindPolicyStore?: import('../../storage/notification-kind-policy-store.js').NotificationKindPolicyStore;
  /** D-269 step 3 — the one quiet-hours window, and the zone it is read in.
   *  Either absent ⇒ the sweep is never quiet, which is today's behaviour. */
  quietHoursStore?: import('../../storage/quiet-hours-store.js').QuietHoursStore;
  /** D-269 — the sink a booking/calendar reminder is DELIVERED through.
   *
   *  ⛔ A NOTIFY, NOT AN EVENT, AND THAT IS THE POINT. The due-status sweep
   *  gates a warehouse event, which drives recipes — so quiet hours there can in
   *  principle delay WORK. Here the policy gates a DELIVERY, which is what quiet
   *  hours is defined to suppress. These two kinds are the shape the other two
   *  should migrate to, not the exception. */
  notifyReminder?: (message: { title: string; text: string }) => void;
  /** D-269 step 4 — called once when the quiet-hours window ENDS, with a digest
   *  recomputed from the anchor rows. ⚠ Absent ⇒ the edge is still tracked (so
   *  it is not mis-detected later) but no card is sent. */
  onQuietHoursReleased?: (digest: import('@recued/contracts').QuietHoursDigest) => void;
  serverTimeZoneStore?: import('../../storage/server-timezone-store.js').ServerTimeZoneStore;
  /** RUNG 4 — the owner's memory pool, for the `memory-embed-backlog` task.
   *  Absent on dbless boots ⇒ the task no-ops. */
  userMemoryStore?: UserMemoryStore;
  /** D-192 email flagship (E2b) — the contact-engagements resolver bundle
   *  (`{ engagementStore, resolverDeps }`) the AppContext already builds for
   *  the WS-rpc / MCP read channels. Threaded here so the ctx can expose a
   *  `resolveContactEngagements` closure for the `commitment_tracker` task.
   *  Absent on a dbless boot ⇒ the task no-ops. */
  contactEngagementsResolveDeps?: ContactEngagementsResolveDeps;
  /** D-192 email flagship (E3) — the F1 proposal `fire` runtime ref. Read
   *  LAZILY (`.current`) by the funnel closure at task-run time — the ref is
   *  populated late by the post-listener wire, long after this composer runs.
   *  Absent ⇒ the `commitment_tracker` task produces enrichment rows without
   *  funnelling them to held commitment-propose proposals. */
  commitmentEvidenceRuntimeRef?: { current: CommitmentEvidenceRuntime | null };
  /** D-172 — the webclient upload service; gates the `upload-session-sweep`
   *  TTL/orphan reaper. Absent on a db-less / no-CAS boot (no upload substrate)
   *  ⇒ the task simply doesn't register. */
  uploadService?: Pick<WebclientUploadService, 'sweepExpired'>;
  /** M4b.1 — the archive upload service; gates the `archive-upload-sweep`
   *  session/scratch reaper + staged-archive TTL prune. Absent on a db-less
   *  boot ⇒ the task doesn't register. */
  archiveUploadService?: Pick<ArchiveUploadService, 'sweepExpired'>;
  enrichmentCascade?: CascadeEngine;
  externalContextRegistry?: ExternalContextDependencyRegistry;
  /** D-184 — the shared per-(connection, vendor) rate gate, threaded onto the
   *  scheduler ctx so the vendor reconciliation harness caps the daily API
   *  budget + skips concurrent pulls across ALL reconcilers. Optional — absent
   *  ⇒ ungated (dbless harnesses / tests). */
  rateGate?: VendorRateGate;
  /** D-177 N.13 (P6b) — gates the `delegation-rule-suggestion-scan` learner
   *  registration. The composer wraps it as the definition + suggestion
   *  stores (both stateless wrappers over this one handle). Absent on dbless
   *  harnesses / boots without the contract substrate — the learner simply
   *  doesn't register. */
  contractStore?: ContractStore;

  /** D-196 §6.3 (s2b) — gates the `seller-access-reconcile` registration: the
   *  sweep that re-reads each subscription customer's state from the payment
   *  provider and converges local access. §6.3: "the reconciler is the
   *  authority; the webhook is the accelerator."
   *
   *  Arrives PRE-BUILT rather than as its constituent stores, because building
   *  it needs `ExecuteHandlerDeps` (the gateway spine) as well as the seller
   *  stores, and this composer has neither — its caller
   *  (`start-post-listener-runtime`) is the first place BOTH exist. Absent on a
   *  dbless boot / a harness without the seller substrate ⇒ the task simply
   *  doesn't register, exactly like the sweeps above. */
  sellerAccessReconcileDeps?: SellerAccessReconcileDeps;

  /** D-225 § 11 — deps for `mcp-tools-drift-probe`, the task that makes a stale
   *  generated pack REPORT as stale. Built by the caller for the same reason as
   *  `sellerAccessReconcileDeps`: it needs the connection store AND a bound
   *  probe, and this composer has neither.
   *
   *  ⛔ Absent ⇒ the task does not register ⇒ `ConnectionHealth.tool_hashes` is
   *  only ever refreshed when the owner acts, and the drift badge reports what
   *  was true at the last manual probe. That is the pre-D-225-§11 behaviour, so
   *  a boot without these deps is no worse than before — but it is also not the
   *  detection this task exists to provide, and a harness that omits them is
   *  not exercising it. */
  mcpToolsDriftProbeDeps?: McpToolsDriftProbeDeps;

  /** D-225 auto-mint — deps for `mcp-pack-first-mint`, the retry + backfill for
   *  connections that have no generated pack. Built by the caller for the same
   *  reason as `mcpToolsDriftProbeDeps` above: it needs the connection store AND
   *  a bound mint, and this composer has neither.
   *
   *  ⛔ Absent ⇒ the task does not register ⇒ a connection whose server was down
   *  at enroll stays at `no_pack` until the owner runs the review chain by hand,
   *  and the pre-auto-mint backlog is never drained. */
  mcpPackFirstMintDeps?: McpPackFirstMintDeps;

  /** D-148 § A.6.5 TLS cert renewal — registers only when all three
   *  refs are populated (rotation engine + production cert source +
   *  ACME renewer). */
  rotationEngine?: RotationEngine;
  tlsCertSource?: CertSource;
  tlsRenewerConfigured?: boolean;

  /** R21.1 — live vault-unlocked predicate. Gates the autonomous idle
   *  probe loop (NOT the explicit `runOnce`). Absent → un-gated. */
  isVaultUnlocked?: () => boolean;

  /** Late-bound state read by the scheduler at runtime. Each getter
   *  returns the current value of the underlying binding so a
   *  re-create (e.g., onExitMaintenance for auto-run) is transparent. */
  getAutoRunInFlight?: () => boolean;
  /** D-138 P3 — runtime mode getter so the singleton contact-merge
   *  scan task reports `mode: 'full'` while `runScanNow` is mid-flight
   *  and `'delta'` otherwise. */
  getActiveContactMergeScanMode?: () => 'delta' | 'full';
  /** D-138 P3 — observer used by `onCycleStart` / `onCycleComplete`. */
  getContactMergeCycleObserver?: () => ContactMergeCycleObserver | undefined;

  /** Caller-owned producer registry. Production wires the shared
   *  `housekeepingSchedulerRegistry.producers()` Map; the composer
   *  clears + populates it in place so the rpc-deps composer's
   *  `getEnrichmentInfo` closure (which captured the same Map by
   *  reference at earlier-boot composer-call time) observes the
   *  registered tasks. See `housekeeping.status.read` →
   *  `getEnrichmentInfo` for the consumer. */
  enrichmentProducers: Map<string, EnrichmentProducerEntry>;
}

export interface HousekeepingSchedulerBundle {
  scheduler: HousekeepingScheduler | undefined;
}

export const composeHousekeepingScheduler = async (
  deps: ComposeHousekeepingSchedulerDeps,
): Promise<HousekeepingSchedulerBundle> => {
  const {
    configStore,
    stateStore,
    trustStore,
    tunableParamsStore,
    llmResultCacheStore,
  } = deps.stores;
  const enrichmentProducers = deps.enrichmentProducers;

  if (!configStore || !stateStore) {
    return { scheduler: undefined };
  }

  // The owner's zone, read PER SWEEP like the policies: the setting when there
  // is one, else the host's. A date-only due is due for the whole of its day
  // there, and overdue once that day ends.
  const ownerTimeZone = (): string => resolveServerTimeZone(
    deps.serverTimeZoneStore?.read(),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );

  // D-145 § A.7.8 — single accessor per scheduler boot. Producers read
  // effective tunables via `ctx.tunableParams.getNumber(topic, key)` /
  // `getEnum`; the accessor returns declared defaults when no override
  // row exists. Wired only when the store is available (dbless harnesses
  // leave producers on declaration defaults via the `getTunableNumber` /
  // `getTunableEnum` standalone helpers).
  const tunableParamsAccessor = tunableParamsStore
    ? createTunableParamsAccessor(tunableParamsStore)
    : undefined;

  // Clear AFTER the early-return so a missing-store call doesn't wipe
  // a singleton registry Map that another caller already populated.
  // Production gates the call through `housekeepingSchedulerRegistry`,
  // so the Map is shared across the rpc-deps composer + this one.
  enrichmentProducers.clear();

  // P7 — register the four core tasks + the canary enrichment producer
  // ahead of scheduler construction. The registry lookup
  // (`listHousekeepingTasks`) is invoked per cycle by the scheduler,
  // so registration order vs scheduler construction doesn't matter for
  // runtime correctness — only for `.start()`'s probe-tick catching
  // the right roster on first fire. Clearing the default registry
  // first keeps test re-imports + multi-boot scenarios honest (the
  // registry is module-level state).
  //
  // D-134 P2 — declarative registration. The two arrays in
  // `housekeeping/registration.ts` (`STANDALONE_TASKS` +
  // `PER_RECORD_PRODUCERS`) are the single source of truth for which
  // producers ship; this composer maps `walker_kind` to a concrete
  // walker and silently skips entries whose walker is unavailable
  // (preserves the pre-D-134 nullness-guard for contact / calendar
  // walkers — test scaffolding without a contact store still ships
  // every other producer unaffected).
  //
  // **Caller invariant**: `clearDefaultHousekeepingRegistry()` is the
  // caller's responsibility and must run BEFORE any external call
  // site that itself registers housekeeping tasks (HubSpot +
  // Salesforce vendor boots register reconciliation tasks for every
  // existing connection at startup). Pre-extraction the clear ran
  // inside this body ahead of the inline registration loop in
  // `bin.ts`, BEFORE vendor substrate compose; calling it from the
  // composer would now wipe the vendor-registered tasks. The composer
  // assumes the registry is already empty.
  for (const task of STANDALONE_TASKS) {
    registerHousekeepingTask(task);
  }

  // D-138 P3 — `contact-merge-candidate-scan` registers conditional on
  // the contact store being present (dbless harnesses + harness tests
  // without a warehouse don't ship it). The task walks contacts whose
  // `updated_at > cursor.last_seen_at`, evaluates the merge predicate
  // against blocking-key-narrowed candidates, and enqueues new merge
  // candidates via `store.enqueueMergeCandidate`.
  if (deps.contactStore) {
    const { buildContactMergeCandidateScanTask } = await import(
      '../../housekeeping/tasks/contact-merge-candidate-scan.js'
    );
    registerHousekeepingTask(
      buildContactMergeCandidateScanTask({
        store: deps.contactStore,
        eventBus: deps.eventBus,
        // D-138 P3 (Codex review fix) — runtime mode getter so the
        // singleton task instance reports `mode: 'full'` on bus events
        // while the `runScanNow` rpc handler is mid-flight. Background
        // cycles read `'delta'` (the steady-state value).
        getMode: deps.getActiveContactMergeScanMode ?? (() => 'delta'),
      }),
    );
  }

  // D-177 N.13 (P6b) — `delegation-rule-suggestion-scan` registers
  // conditional on the contract store (the contract substrate's one handle —
  // dbless harnesses + pre-substrate boots skip it cleanly). The learner
  // aggregates session-grant rows by the N.13 key and upserts open
  // suggestion rows; only the human mints a rule from one (P6c — N.9.7).
  // Both store wrappers are stateless over the shared handle, so composing
  // them here alongside the boot-path instances is safe.
  if (deps.contractStore) {
    const { buildDelegationRuleSuggestionScanTask } = await import(
      '../../housekeeping/tasks/delegation-rule-suggestion-scan.js'
    );
    const { createContractDefinitionStore } = await import(
      '../../storage/contract-definition-store.js'
    );
    const { createDelegationSuggestionStore } = await import(
      '../../storage/delegation-suggestion-store.js'
    );
    registerHousekeepingTask(
      buildDelegationRuleSuggestionScanTask({
        definitionStore: createContractDefinitionStore(deps.contractStore),
        suggestionStore: createDelegationSuggestionStore(deps.contractStore),
        eventBus: deps.eventBus,
      }),
    );
  }

  // D-202 Slice 1 — `quality-delegation-suggestion-scan` registers conditional on
  // the contract store, alongside the D-177 learner. The reject-driven quality
  // learner aggregates durable quality VERDICT signals by the (recipe, op) key and
  // upserts open quality-delegation suggestions; only the owner mints a delegation
  // from one (Task 5 accept flow — no auto-promotion, §12.4). All three store
  // wrappers are stateless over the shared handle.
  if (deps.contractStore) {
    const { buildQualityDelegationSuggestionScanTask } = await import(
      '../../housekeeping/tasks/quality-delegation-suggestion-scan.js'
    );
    const { createContractDefinitionStore: createDefStore } = await import(
      '../../storage/contract-definition-store.js'
    );
    const { createQualityDelegationSignalStore } = await import(
      '../../storage/quality-delegation-signal-store.js'
    );
    const { createQualityDelegationSuggestionStore } = await import(
      '../../storage/quality-delegation-suggestion-store.js'
    );
    registerHousekeepingTask(
      buildQualityDelegationSuggestionScanTask({
        signalStore: createQualityDelegationSignalStore(deps.contractStore),
        definitionStore: createDefStore(deps.contractStore),
        suggestionStore: createQualityDelegationSuggestionStore(deps.contractStore),
      }),
    );
  }

  // D-148 § A.6.5 — `tls-cert-renewal` registers conditional on the
  // rotation engine, the production cert source, AND the renewer
  // being wired. All three come from the cert-stack composer
  // (slice 103). With the Pro auth state machine populator (102nd) +
  // handle state machine populator (101st) landed, per-cycle renewals
  // on servers with a reserved handle AND an authenticated Pro slot
  // issue certs end-to-end. Servers missing either populator stay on
  // `subscription_required` / `helper_unavailable` — single audit row
  // per cycle + 6h cooldown, idempotent recovery once the missing
  // populator lands. Operator-initiated `tls.renew` rpc reaches the
  // same production hook + surfaces the matching closed-list reason.
  if (
    deps.rotationEngine &&
    deps.tlsCertSource &&
    deps.tlsRenewerConfigured
  ) {
    registerHousekeepingTask(
      buildTlsCertRenewalTask({
        engine: deps.rotationEngine,
        certSource: deps.tlsCertSource,
      }),
    );
  }

  // D-269 follow-on — ONE reminder ledger, shared by the release card and the
  // per-item reminders. ⛔ Hoisted rather than built inside each block BECAUSE
  // THE SHARING IS THE POINT: the card skips what the reminders already marked
  // and vice versa. Two stores over the same table would happen to work, but
  // only because sqlite is the real shared state — a fact about the storage
  // engine standing in for a design decision, and the next person to swap it for
  // anything in-process would break the exclusion silently.
  // ⛔⛔ LAZY, AND THAT IS NOT A MICRO-OPTIMISATION — IT IS THE GUARD. Built
  // eagerly on `deps.db` alone this ran a `CREATE TABLE` for every caller that
  // merely HAS a db, including harnesses whose `db` is a stub with no `.exec`,
  // and 42 composition tests crashed before a single task registered. The
  // original code created the store inside the one block that needed it; the
  // hoist is for SHARING the instance, so it must not also widen WHEN it is
  // built. Created at first use, under the same guards as before.
  let reminderLedgerMemo: ReminderLedger | undefined;
  const reminderLedgerFor = async (handle: Database.Database): Promise<ReminderLedger> => {
    if (reminderLedgerMemo === undefined) {
      const { createReminderLedgerStore } = await import(
        '../../storage/reminder-ledger-store.js'
      );
      reminderLedgerMemo = createReminderLedgerStore(handle);
    }
    return reminderLedgerMemo;
  };

  // D-145 PA4 — `work-entity-due-status-sweep` registers conditional
  // on the work-entity store being enrolled. Tests + dbless harnesses
  // without a work-entity store skip it cleanly (the housekeeping
  // scheduler then has nothing PA4-specific to fire).
  if (deps.workEntityStore) {
    const { buildWorkEntityDueStatusSweepTask } = await import(
      '../../housekeeping/tasks/work-entity-due-status-sweep.js'
    );
    registerHousekeepingTask(
      buildWorkEntityDueStatusSweepTask({
        deps: {
          store: deps.workEntityStore,
          bus: deps.warehouseBus,
          ...(deps.enrichmentCascade ? { cascade: deps.enrichmentCascade } : {}),
          // A date-only due is judged by its DAY in the owner's zone (`due-day.ts`).
          timeZone: ownerTimeZone,
          // D-269 step 2 — the owner's per-kind horizon, read PER SWEEP so a
          // policy change lands on the next cycle rather than at the next
          // restart. Absent (db-less harness) ⇒ the shared 24h constant with
          // every kind enabled, exactly as before.
          // D-269 step 3 — is the window active for this kind right now? Needs
          // BOTH stores plus the zone: the window is wall clock, and the kind
          // decides whether it may interrupt at all. Any of the three absent ⇒
          // never quiet, which is today's behaviour.
          ...(deps.quietHoursStore && deps.serverTimeZoneStore
            ? {
                isQuiet: (at: number): boolean =>
                  shouldSuppressForQuietHours({
                    policy: deps.quietHoursStore!.read(),
                    instant: at,
                    timeZone: resolveServerTimeZone(
                      deps.serverTimeZoneStore!.read(),
                      Intl.DateTimeFormat().resolvedOptions().timeZone,
                    ),
                  }),
              }
            : {}),
          // D-269 step 4 — the release edge and the card. The marker is ONE
          // integer in the quiet-hours row; the card is recomputed from anchor
          // rows at release, so nothing is held during the window.
          ...(deps.quietHoursStore
            ? {
                wasQuiet: (): number | null => deps.quietHoursStore!.readLastActiveAt(),
                markQuiet: (at: number | null): void => deps.quietHoursStore!.writeLastActiveAt(at),
              }
            : {}),
          ...(deps.onQuietHoursReleased
            ? { onReleased: deps.onQuietHoursReleased }
            : {}),
          // ⚠ Gated on the RELEASE CALLBACK, not merely on a db: the exclusion
          // exists so the card and the per-item reminders do not both speak, and
          // with no callback there is no card to keep quiet.
          ...(deps.onQuietHoursReleased && deps.db
            ? { reminderLedger: await reminderLedgerFor(deps.db) }
            : {}),
          ...(deps.notificationKindPolicyStore
            ? {
                policy: (kind: 'task' | 'commitment') => {
                  const row = deps.notificationKindPolicyStore!.get(kind);
                  return { enabled: row.enabled, offset_ms: row.offset_ms };
                },
              }
            : {}),
        },
      }),
    );
  }

  // D-269 — booking / calendar reminders. Registered only when BOTH the work
  // store and a notify sink exist: this sweep's entire output is a `notify`, so
  // without one it is not a degraded feature but a no-op burning a cycle slot.
  if (deps.workEntityStore && deps.notifyReminder && deps.db) {
    const workEntityStore = deps.workEntityStore;
    const notifyReminder = deps.notifyReminder;
    const db = deps.db;
    const { buildWorkEntityReminderSweepTask } = await import(
      '../../housekeeping/tasks/work-entity-reminder-sweep.js'
    );
    const { createCalendarTable } = await import(
      '../../collections/calendar/calendar-table.js'
    );
    const { createInstanceStore } = await import('../../collections/instance-store.js');
    const instances = createInstanceStore({ db });
    // ⚠ Tables are memoised per slug but the ENROLLED SET is resolved on every
    // read, so a calendar enrolled later is swept without a restart — the same
    // choice the MCP business-context reader makes, and for the same reason.
    const tables = new Map<string, ReturnType<typeof createCalendarTable>>();
    const tableFor = (slug: string): ReturnType<typeof createCalendarTable> => {
      const hit = tables.get(slug);
      if (hit) return hit;
      const made = createCalendarTable({ db, slug });
      tables.set(slug, made);
      return made;
    };

    registerHousekeepingTask(
      buildWorkEntityReminderSweepTask({
        deps: {
          listBookings: () => workEntityStore.listBookings({ sync_states: ['live'] }),
          // D-269 follow-on — the two kinds that had an emitter onto the bus and
          // nobody on the other end. Same `sync_states: ['live']` filter as the
          // bookings above, and a row created in Recued defaults to `live`
          // (`work-entity-store.ts:932`) — so a task you make HERE is swept the
          // moment its deadline enters the horizon, which is the whole point.
          listTasks: () => workEntityStore.listTasks({ sync_states: ['live'] }),
          listCommitments: () => workEntityStore.listCommitments({ sync_states: ['live'] }),
          listCalendar: (from, to) => {
            const out: Array<{ record_id: string; summary: string; start_at: number; status?: string; is_all_day: boolean }> = [];
            for (const instance of instances.list('calendar')) {
              // ⚠ BOUNDED BY THE HORIZON the caller passed. An unbounded read
              // over a synced account is fine on a fixture and ruinous in life.
              for (const row of tableFor(instance.slug).list({
                start_since: from, start_until: to, order_by: 'start_at', limit: 200,
              })) {
                out.push({
                  record_id: `${instance.slug}:${row.ical_uid ?? row.summary}:${row.start_at}`,
                  summary: row.summary,
                  start_at: row.start_at,
                  is_all_day: row.is_all_day === true,
                  ...(row.status !== undefined ? { status: row.status } : {}),
                });
              }
            }
            return out;
          },
          policy: (kind) => {
            const row = deps.notificationKindPolicyStore?.get(kind);
            return row
              ? { enabled: row.enabled, offset_ms: row.offset_ms }
              // ⚠ No policy store ⇒ the kind is OFF rather than defaulted on.
              // True for all four: booking and calendar had no emitter at all
              // before D-269, and task and commitment had one onto a bus with
              // no reader — so "absent" means the same thing for each of them,
              // which is the behaviour that was actually there: silence.
              : { enabled: false, offset_ms: 0 };
          },
          ...(deps.quietHoursStore && deps.serverTimeZoneStore
            ? {
                isQuiet: (at): boolean => shouldSuppressForQuietHours({
                  policy: deps.quietHoursStore!.read(),
                  instant: at,
                  timeZone: resolveServerTimeZone(
                    deps.serverTimeZoneStore!.read(),
                    Intl.DateTimeFormat().resolvedOptions().timeZone,
                  ),
                }),
              }
            : {}),
          // A date-only due is judged by its DAY in the owner's zone (`due-day.ts`).
          timeZone: ownerTimeZone,
          // ⚠ The hoisted instance — `deps.db` is in this block's own guard, so
          // it is present whenever this task registers.
          ledger: await reminderLedgerFor(db),
          notify: notifyReminder,
        },
      }),
    );
  }

  // D-196 §6.3 (s2b) — `seller-access-reconcile` registers iff the seller
  // reconcile deps were built upstream (seller substrate + gateway spine both
  // present). This is THE registration that makes the reconciler-as-authority
  // real: without it the policy, its adapters and all three lanes are inert
  // code, which is exactly what s1/s2a/s2c shipped as.
  if (deps.sellerAccessReconcileDeps) {
    const { buildSellerAccessReconcileTask } = await import(
      '../../housekeeping/tasks/seller-access-reconcile.js'
    );
    registerHousekeepingTask(
      buildSellerAccessReconcileTask({ deps: deps.sellerAccessReconcileDeps }),
    );
  }

  // D-225 § 11 — `mcp-tools-drift-probe`. Slice 2 shipped the drift BADGE over
  // data at rest; nothing refreshed that data on a cadence, so the badge could
  // only report what was true at the owner's last manual probe. This
  // registration is what turns it from a display of drift into a detector of
  // one. It refreshes hashes only — re-minting stays the owner's decision.
  if (deps.mcpToolsDriftProbeDeps) {
    const { buildMcpToolsDriftProbeTask } = await import(
      '../../housekeeping/tasks/mcp-tools-drift-probe.js'
    );
    registerHousekeepingTask(
      buildMcpToolsDriftProbeTask({ deps: deps.mcpToolsDriftProbeDeps }),
    );
  }

  // D-225 auto-mint — `mcp-pack-first-mint`. The enroll-time mint needs a live
  // `tools/list`, and a server that is asleep must still be enrollable; this is
  // what comes back for it, and it drains the pre-auto-mint backlog by the same
  // move. Disjoint population from the drift probe above (no pack vs has one).
  if (deps.mcpPackFirstMintDeps) {
    const { buildMcpPackFirstMintTask } = await import(
      '../../housekeeping/tasks/mcp-pack-first-mint.js'
    );
    registerHousekeepingTask(
      buildMcpPackFirstMintTask({ deps: deps.mcpPackFirstMintDeps }),
    );
  }

  // D-172 resumable uploads — register the TTL/orphan sweep iff the webclient
  // upload service is wired (db + CAS). The reaper frees abandoned-session
  // scratch + budget on the idle cadence.
  if (deps.uploadService) {
    const { buildUploadSweepTask } = await import(
      '../../housekeeping/tasks/upload-sweep.js'
    );
    registerHousekeepingTask(
      buildUploadSweepTask({ service: deps.uploadService }),
    );
  }

  // M4b.1 — register the archive-upload sweep iff the archive upload service is
  // wired (db). Reaps its sessions/scratch + prunes staged archives past their
  // TTL (the export GC ignores staging names by design).
  if (deps.archiveUploadService) {
    const { buildArchiveUploadSweepTask } = await import(
      '../../housekeeping/tasks/archive-upload-sweep.js'
    );
    registerHousekeepingTask(
      buildArchiveUploadSweepTask({ service: deps.archiveUploadService }),
    );
  }

  // Source walkers per kind. Mail-thread + contact + calendar come
  // from the shared registry; mail-body uses a body-hashing walker so
  // summary-style producers (`summarise_thread`, etc.) invalidate on
  // body changes too.
  const sourceWalkers = createSourceWalkerRegistry({
    collections: deps.collectionRegistry,
    ...(deps.contactStore ? { contactStore: deps.contactStore } : {}),
  });
  const summaryWalker = createMailSourceWalker(deps.collectionRegistry, {
    hashRecord: hashMailRecordWithBody,
  });
  const fileWalker = createFileSourceWalker(deps.collectionRegistry);
  // D-145 PA9 — note + task + project walkers wired directly off
  // `WorkEntityStore` (work entities live in the work-entity warehouse,
  // not the `CollectionRegistry`). Gated on store presence — test
  // scaffolding without a work-entity store skips the
  // `note_relevance_decay` + `task_duplicate_candidate` +
  // `project_next_action_gap` producers cleanly, same way missing
  // `contactStore` skips contact-scope producers.
  const noteWalker = deps.workEntityStore
    ? createNoteSourceWalker(deps.workEntityStore)
    : undefined;
  const taskWalker = deps.workEntityStore
    ? createTaskSourceWalker(deps.workEntityStore)
    : undefined;
  const projectWalker = deps.workEntityStore
    ? createProjectSourceWalker(deps.workEntityStore)
    : undefined;
  const walkerByKind: Record<PerRecordWalkerKind, SourceCollectionWalker | undefined> = {
    'mail-thread': sourceWalkers.get('mail') as SourceCollectionWalker | undefined,
    'mail-body': summaryWalker,
    'contact': sourceWalkers.get('contact') as SourceCollectionWalker | undefined,
    'calendar': sourceWalkers.get('calendar') as SourceCollectionWalker | undefined,
    'file': fileWalker as SourceCollectionWalker | undefined,
    'note': noteWalker as SourceCollectionWalker | undefined,
    'task': taskWalker as SourceCollectionWalker | undefined,
    'project': projectWalker as SourceCollectionWalker | undefined,
  };
  const registerEnrichmentProducer = <TData>(
    producer: HousekeepingEnrichmentProducer<TData>,
    walker: SourceCollectionWalker<TData>,
    task_id_suffix?: string,
  ): void => {
    registerHousekeepingTask(
      buildEnrichmentProducerTask({
        producer,
        walker,
        ...(task_id_suffix !== undefined ? { task_id_suffix } : {}),
      }),
    );
    // D-145 PA9 — map key must match the task id so `getEnrichmentInfo`
    // can resolve back from scheduler-emitted task ids. Composition
    // matches `buildEnrichmentProducerTask`'s rule (suffix only when
    // declared).
    const taskId =
      task_id_suffix !== undefined
        ? `enrichment.${producer.topic}.${task_id_suffix}`
        : `enrichment.${producer.topic}`;
    enrichmentProducers.set(taskId, {
      producer: producer as HousekeepingEnrichmentProducer<unknown>,
      walker: walker as SourceCollectionWalker<unknown>,
    });
    // D-136 §A.14.1 P6 — populate the external-context dependency
    // registry from this producer's `consumes_external_context`
    // declarations. Vendor reconcilers + MCP-tool producers fire
    // `cascadeForExternalContextPulseChange(context_id)` after a pulse
    // value diverges; the cascade walks this registry to find every
    // consumer topic that opted into invalidation. Producers with no
    // declarations contribute nothing — the registry stays empty for
    // that topic.
    if (
      deps.externalContextRegistry &&
      producer.consumes_external_context &&
      producer.consumes_external_context.length > 0
    ) {
      deps.externalContextRegistry.add(producer.topic, producer.consumes_external_context);
    }
  };
  for (const { producer, walker_kind, task_id_suffix } of PER_RECORD_PRODUCERS) {
    const walker = walkerByKind[walker_kind];
    if (walker) {
      registerEnrichmentProducer(producer, walker, task_id_suffix);
    }
  }

  // Composite busy signal — auto-run executions + adapter drains.
  // One instance store is constructed here against `db` for the busy
  // signal — the per-stack stores hit the same SQL table, so the
  // busy signal sees the union regardless of which stack composed
  // which row.
  const { createInstanceStore } = await import('../../collections/instance-store.js');
  const housekeepingInstanceStore = createInstanceStore({ db: deps.db });
  const busy = createEngineBusySignal({
    ...(deps.getAutoRunInFlight
      ? { autoRun: { inFlight: deps.getAutoRunInFlight } }
      : {}),
    instances: housekeepingInstanceStore,
  });

  // D-178 P1 — the auto-apply-on-idle task. `composeListeners` published the
  // apply + mode deps (self-applying channels only); we register the idle task
  // and back the orchestrator's `isQuiesced` port with the real engine-busy
  // signal (replacing slice 4b's `() => true` placeholder). Absent entry =
  // delegated channel / unsupported platform → nothing registered.
  const autoApplyEntry = updateAutoApplyRegistry.consume();
  if (autoApplyEntry) {
    autoApplyEntry.bindBusySignal(() => busy.isBusy());
    registerHousekeepingTask(
      createUpdateAutoApplyTask({
        runCheck: autoApplyEntry.runCheck,
        readLastReported: autoApplyEntry.readLastReported,
        writeLastReported: autoApplyEntry.writeLastReported,
        ...(autoApplyEntry.notifyOwner ? { notifyOwner: autoApplyEntry.notifyOwner } : {}),
        // Absent on a delegated channel — the task checks and records there,
        // and never applies.
        ...(autoApplyEntry.applyDeps
          ? {
              apply: {
                ports: autoApplyEntry.applyDeps.ports,
                resolveForApply: autoApplyEntry.applyDeps.resolveForApply,
              },
            }
          : {}),
        modeStore: autoApplyEntry.modeStore,
        channel: autoApplyEntry.channel,
        ...(autoApplyEntry.envMode !== undefined ? { envMode: autoApplyEntry.envMode } : {}),
      }),
    );
  }

  // D-167 activation — enrichment-producer AI-egress PII tag source. Parity
  // with the chat-orchestrator's `MetaField.privacy` resolver (wire-chat-
  // orchestrator.ts): a read-only view over the per-pair `local_manifest` table
  // maps a producer's `source_scope` to the installed entity schema's privacy-
  // tagged fields. The per-record enrichment harness
  // (`wrapHousekeepingCtxForRecord`) seeds its run-local alias ledger from those
  // fields, aliases the producer's LLM-bound packet before egress, and restores
  // the model output before the producer parses it — so the warehouse row +
  // audit see real values, only the cloud / free-pool model sees aliases. A
  // second read-only store over the same `deps.db` is behavior-identical to the
  // one the D-170 install path + chat composer build (SQLite is the single
  // source of truth; the schema bootstrap is idempotent). Until an installed
  // schema carries a privacy-tagged `MetaField` for a producer's scope the
  // resolver returns `[]`, the seam skips the wrap, and producer LLM calls
  // round-trip byte-identical (the comfort default's no-op invariant).
  //
  // Fail-open at construction too: the comfort layer must never break the
  // background scheduler. A no-op `() => []` fallback (the seam then skips the
  // alias wrap) guards the unlikely case where the store's idempotent schema
  // bootstrap throws — degrade quietly rather than abort housekeeping startup.
  const localManifestStore = createLocalManifestStore(deps.db);
  // D-192 E2b — hoisted so the `!== undefined` guard narrows it inside the
  // ctx's `resolveContactEngagements` closure.
  const contactEngagementsResolveDeps = deps.contactEngagementsResolveDeps;
  // D-192 E3 — the extraction→proposal funnel. The dedicated `commitment_id`
  // ledger lives on the same SQLite as the warehouse (its schema bootstrap is
  // idempotent). The funnel reads the F1 proposal `fire` LAZILY from the
  // late-populated runtime ref, resolves the counterparty via the contact
  // store's D-138 canonical walk, and dedups on `commitment_id`. Built only
  // when the runtime ref is threaded (always, in production; absent on the
  // partial-deps unit harnesses).
  const commitmentEvidenceRuntimeRef = deps.commitmentEvidenceRuntimeRef;
  const commitmentContactStore = deps.contactStore;
  const commitmentExtractionLedger =
    commitmentEvidenceRuntimeRef !== undefined
      ? createCommitmentExtractionLedger(deps.db)
      : undefined;
  let enrichmentPiiTagSource: EnrichmentPiiTagSource;
  try {
    enrichmentPiiTagSource = createEnrichmentPiiTagSourceFromLocalManifestStore(
      localManifestStore,
      // D-167 default-on PII protection: union the shipped first-party canonical /
      // CRM privacy-tagged schemas so enrichment producers over `data.mail` /
      // `data.contact` / `data.calendar` / `connection.api.{hubspot,salesforce}.contact`
      // alias known PII before egress with zero install.
      CANONICAL_PII_ENTITY_SCHEMAS,
    );
  } catch {
    enrichmentPiiTagSource = () => [];
  }

  // Build the scheduler with its full ctx. LLM callables are spread
  // directly since their field names match the `HousekeepingContext`
  // shape (`llm` / `llmWithMeta` / `embed`).
  const scheduler = createHousekeepingScheduler({
    // D-269 — the owner's declared zone for the `custom` preset's window, so
    // "between 22:00 and 05:00" means their hours rather than the host's. The
    // same store the due-status sweep's quiet-hours check reads.
    ...(deps.serverTimeZoneStore
      ? {
          serverTimeZone: (): string => resolveServerTimeZone(
            deps.serverTimeZoneStore!.read(),
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          ),
        }
      : {}),
    ctx: {
      db: deps.db,
      bus: deps.warehouseBus,
      enrichmentStore: deps.enrichmentStore,
      recipeStore: deps.recipeStore,
      now: Date.now,
      ...deps.llmCallables,
      // D-167 — enrichment-producer AI-egress PII tag source. Always wired
      // (parity with the chat resolver): an empty / privacy-tag-free
      // `local_manifest` table makes it return `[]` for every scope, leaving
      // the seam a byte-identical no-op.
      enrichmentPiiTagSource,
      // D-132 P2 — trust store flows on the ctx so the harness
      // resolves per-record forceLayer + skip-and-log paths against
      // the same instance the scheduler reads for eligibility.
      ...(trustStore !== undefined ? { trustStore } : {}),
      // Round-12 audit fix (T1 § 8.1) — the drift producer's topic-wide
      // recompute enqueue consults the SAME cascade budget governor the
      // engine's own topic-wide sites reserve against. Bound here so all
      // three writers share one predicate; absent cascade ⇒ ungated, the
      // ctx's standing optional-gate semantic.
      ...(deps.enrichmentCascade
        ? {
            cascadeTopicAdmission: (topic: string) =>
              deps.enrichmentCascade!.reserveTopicRecomputeAdmission(topic),
          }
        : {}),
      // D-133 — eventBus on ctx so the confidence drift task can fan
      // out `enrichment_drift_detected` on severity transitions.
      eventBus: deps.eventBus,
      // D-145 PA9 — workEntityStore on ctx so cross-entity producers
      // (today: `task_duplicate_candidate`'s cross-source candidate
      // lookup via `findCrossSourceTaskCandidates`) can read across
      // multiple task rows in one `produce()` call.
      ...(deps.workEntityStore !== undefined ? { workEntityStore: deps.workEntityStore } : {}),
      // D-145 § A.7.8 (Amended 2026-05-26) — typed per-topic tunable
      // params accessor on ctx so per-record producers read user-
      // effective values via `getTunableNumber(ctx, topic, key)`. Wired
      // when the store is available; absent on dbless harnesses + tests
      // that drive deterministic producers (the helpers fall back to
      // declaration defaults).
      ...(tunableParamsAccessor !== undefined
        ? { tunableParams: tunableParamsAccessor }
        : {}),
      // D-145 § A.7.10 — content-addressed LLM result cache. AI
      // producers opt in via `compose_input` on `runAIProducer`;
      // absent on dbless harnesses, in which case the wrapper degrades
      // to a cache-miss path on every call.
      ...(llmResultCacheStore !== undefined
        ? { llmResultCache: llmResultCacheStore }
        : {}),
      // `cacheBlobs` is set inside the same `if (db)` boot block as
      // the housekeeping refs in bin.ts, so it's defined when the
      // composer runs.
      blobs: deps.cacheBlobs,
      // RUNG 4 — the owner's memory pool, for `memory-embed-backlog`. Absent on
      // a dbless boot ⇒ the task no-ops (and rung 4 reports `not_embedded`
      // rather than pretending the pool holds nothing).
      ...(deps.userMemoryStore !== undefined
        ? { userMemoryStore: deps.userMemoryStore }
        : {}),
      // D-184 — shared vendor rate gate (daily budget + skip-if-busy) for the
      // reconciliation harness. Absent on dbless harnesses ⇒ reconcilers ungated.
      ...(deps.rateGate !== undefined ? { rateGate: deps.rateGate } : {}),
      // D-190 — dedicated CRM record mirror. The reconciliation harness upserts
      // every CRM record into it unconditionally so deal.search surfaces
      // un-enriched records too. Absent on dbless harnesses ⇒ no mirror write.
      ...(deps.crmRecordMirror !== undefined ? { crmRecordMirror: deps.crmRecordMirror } : {}),
      // D-192 email flagship (E2b) — the live vendor registry so the
      // commitment_tracker task resolves its contact scopes DECLARATIVELY
      // (`scopesForCrmAlias('contact', …)`); + the contact-engagements
      // resolver closure it fans in over (reusing the SAME resolver the
      // WS-rpc / MCP read channels use). The bundle threads from the
      // AppContext; absent on a dbless boot ⇒ the task no-ops.
      resolveVendorRegistry: () => liveVendorRegistry(localManifestStore),
      ...(contactEngagementsResolveDeps !== undefined
        ? {
            resolveContactEngagements: (args) =>
              contactEngagementsResolveDeps.engagementStore.resolveEngagementsForContact(
                args,
                contactEngagementsResolveDeps.resolverDeps(args),
              ),
            // D-139 slice 3 — the RECORD-rooted sibling, for the deal /
            // account aggregate tasks. Same store, same coverage builder;
            // the selector differs, not the evidence surface.
            resolveRecordEngagements: (args) =>
              contactEngagementsResolveDeps.engagementStore.resolveEngagementsForRecord(
                args,
                contactEngagementsResolveDeps.recordResolverDeps(args),
              ),
            // D-139 § A.9.2b — the deal's counterparty contacts, for the
            // out-of-band visibility-gap producer. Same store, same F1 join
            // the commitment capture uses.
            listDealContacts: (deal_full_target_id, limit) =>
              contactEngagementsResolveDeps.engagementStore
                .listDealCounterpartyContactEmails(deal_full_target_id, limit),
          }
        : {}),
      // D-192 E3 — the extraction→proposal funnel closure. Present whenever the
      // F1 proposal runtime ref is threaded (the ledger is then built too); the
      // funnel self-degrades to a no-op when `fire` isn't up yet (pre-wire). The
      // contact store's D-138 canonical resolver feeds the E1 counterparty seam;
      // read lazily + fail-closed on a corrupt merge chain.
      ...(commitmentEvidenceRuntimeRef !== undefined && commitmentExtractionLedger !== undefined
        ? {
            commitmentProposalFunnel: (input) =>
              runCommitmentProposalFunnel(
                {
                  getFire: () => commitmentEvidenceRuntimeRef.current?.fire,
                  ledger: commitmentExtractionLedger,
                  resolveCanonical:
                    commitmentContactStore !== undefined
                      ? (email) => commitmentContactStore.resolveCanonicalEmail(email).canonical_email
                      : undefined,
                },
                input,
              ),
          }
        : {}),
      emitAuditRow: (row) => {
        // Map the housekeeping audit row onto the existing
        // ActivityEntry shape — `event_at` + `run_mode` are
        // documented on the spec but don't survive the activity-log
        // schema (those fields live on the recipe-execution
        // AuditEntry). Best-effort emit.
        //
        // Codex P2 #2 fold (D-148 § A.6.5) — honour `row.action`
        // rather than hardcoding `'housekeeping_cycle'`. The prior
        // shape squashed every task's audit row under one action, so
        // Settings → Key Health filters for task-specific events
        // (`'tls_auto_renew_attempted'`, `'lifecycle_queue_drain'`,
        // etc.) returned empty. The scheduler still emits per-cycle
        // rows tagged `'housekeeping_cycle'` for the cycle-level
        // rollup; per-task rows now carry their own discriminator.
        if (!deps.auditLog) return;
        void deps.auditLog
          .logActivity({
            activity_id: '',
            timestamp: row.ts,
            // `row.action` is `string` at the housekeeping registry
            // boundary (the contracts package doesn't depend on
            // `@recued/storage`'s `ActivityAction` enum). Cast at the
            // sink — every task-specific action a registered task can
            // emit lives in the closed `ActivityAction` list
            // (`'housekeeping_cycle'`, `'tls_auto_renew_attempted'`,
            // etc.); unknown strings would write a row the activity-
            // log filter can't query.
            action: row.action as ActivityAction,
            target: row.target,
            detail: JSON.stringify(row.detail),
          })
          .catch(() => { /* best-effort */ });
      },
    },
    config: configStore,
    state: stateStore,
    busy,
    ...(trustStore !== undefined ? { trustStore } : {}),
    // D-262 follow-on — the idle-cycle AI gate. ⚠ `resolveLlmConfig`, the SAME
    // resolver the housekeeping chat executor now uses: a gate reading live
    // config while its executor read a boot snapshot would disagree with
    // itself. The Run-Now dialog's pre-confirm calls this same probe, so the
    // status surface and the gate answer the same question.
    probeAiPath: deps.llmCallables.probeAiPath,
    registry: () => listHousekeepingTasks(),
    // D-138 P3 — open the contact-merge cycle observer's buffer window
    // so A.10 plausibility can correlate link removes + adds inside
    // one cycle. Closes inside `onCycleComplete`.
    onCycleStart: () => {
      deps.getContactMergeCycleObserver?.()?.beginCycle();
    },
    // Fan out the cycle result to every paired client subscribed to
    // `housekeeping_cycle`. Best-effort: bus emit failure doesn't
    // abort the underlying cycle. D-138 P3 also closes the
    // contact-merge cycle observer here — the close hook examines
    // buffered platform-link changes and fires re-merge prompts for
    // any rejected pair whose plausibility window matched.
    onCycleComplete: (cycle) => {
      try {
        deps.getContactMergeCycleObserver?.()?.closeCycle();
      } catch { /* best-effort — observer exceptions don't fail cycle */ }
      try {
        deps.eventBus.emit({
          kind: 'housekeeping_cycle',
          at: Date.now(),
          duration_ms: cycle.duration_ms,
          tasks_complete: cycle.tasks_complete,
          tasks_yielded: cycle.tasks_yielded,
          tasks_errored: cycle.tasks_errored,
          per_task: cycle.per_task,
        });
      } catch { /* see bus.ts — emit failures are swallowed */ }
    },
    ...(deps.isVaultUnlocked ? { isVaultUnlocked: deps.isVaultUnlocked } : {}),
  });

  // P7 — arm the probe loop iff the user's preset isn't `'off'`.
  // `start()` itself short-circuits on `'off'` for defence-in-depth,
  // but reading the config here lets the boot-time log indicate
  // whether housekeeping is actually running.
  if (configStore.read().preset !== 'off') {
    scheduler.start();
  }

  return { scheduler };
};
