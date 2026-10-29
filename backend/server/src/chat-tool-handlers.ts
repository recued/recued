import { createHash } from 'node:crypto';
import {
  FTS_STOPWORDS,
  absentFromAll,
  boundedEditDistance,
  mergeSpellingChecks,
  spellingMaxDistance,
  type FtsWordCheck,
} from '@recued/fts';

import { createReadScope, SPHERE_READ_REFUSAL } from './situations/read-scope.js';
import { situationPersonName } from './situations/model-projection.js';
import {
  AssetTypeError,
  assetTypeIssueText,
  assetTypeIssues,
  assetTypeNeedsHolder,
  describeAssetType,
  listAssetTypes,
  unknownAssetTypeText,
  type AssetTypes,
  type AssetTypeWords,
} from './situations/asset-types.js';
import { calendarChatUpdateInput } from './collections/calendar/chat-update-input.js';
/** D-137 Trio #A — Chat tool handler wiring.
 *
 *  Bridges the `InternalToolRegistry` to the server's live warehouse
 *  stores + recipe executor. Until this slice landed, every chat
 *  dispatch resolved `not_implemented` and the orchestrator's tool
 *  loop ran but executed nothing — the main turn emitted `tool_calls`,
 *  the registry rejected each one, and the agent saw stub failures
 *  back through `chat.tool_call_completed` broadcast events.
 *
 *  Per-Tier-1 primitive (TIER1_TOOL_DESCRIPTORS):
 *    - `contact.search`    → `ContactStore.list / get`
 *    - `mail.search`       → `CollectionRegistry` fan-out (mail platform)
 *    - `calendar.search`   → `CollectionRegistry` fan-out (calendar platform)
 *    - `memory.search`     → `UserMemoryStore.search` — the memory POOL
 *      ONLY. It does NOT read the audit log; `getAuditLog` is wired but
 *      never called from this file (see `createMemorySearchHandler`).
 *    - `enrichment.search` → `EnrichmentStore.list`
 *    - `recipe.run`        → `handleExecute` (same path manual / scheduled
 *      runs take; trigger_source: 'chat')
 *
 *  Per Tier-2 dispatch: `<publisher>/<recipe_id>` tool name → resolve
 *  via `RecipeStore.get(recipe_id)` → `handleExecute` with the same
 *  trigger_source. Tier 2 catalog enumeration uses
 *  `RecipeStore.listStored()` + the executor's manifest registry for
 *  `IngredientKindLookup` (so Mary's per-kind catalog scope toggle
 *  gates correctly).
 *
 *  Late-bound refs: every dep is supplied through a getter closure so
 *  `bin.ts` can compose the registry before all stores are wired
 *  (`enrichmentStoreRef`, the enrichment-visibility resolver, the final
 *  `executeDeps` shape — all built AFTER the chat orchestrator). At dispatch time
 *  (per chat turn) every getter resolves to the live ref. Getters
 *  returning undefined surface `execution_error` with a diagnostic
 *  detail rather than crashing — keeps the dbless test harness path
 *  identical to the legacy `not_implemented` behaviour. */

import {
  ASSET_DOCUMENT_DETAILS_ATTRIBUTE,
  ASSET_SEARCH_TERMS,
  AssetValidationError,
  parseAssetSearchTerms,
  parseQualifiedWorkEntityId,
  WORK_ENTITY_KIND_SET,
  calendarDayMs,
  COMMITMENT_DIRECTION_SET,
  isAssetDate,
  zonedWallClockToEpochMs,
  type ApprovalValueLabels,
  type Asset,
  type AssetContributionKind,
  type AssetPatch,
  type AssetReading,
  type AssetRule,
  type WorkEntityKind,
  isReadableCollection,
  OP_ENTITY_COLLECTION,
  TIER1_CLASSIFICATIONS,
  TIER1_TOOL_ENTITY,
  CONNECTION_MCP_READ_SLUG,
  CONNECTION_MCP_WRITE_SLUG,
  isCliIngredient,
  isContactAliasPlatform,
  isEnrichmentTopic,
  formatTier3ToolName,
  canonicalCrmField,
  PII_ENTITY_MARKER_KEY,
  // D-206 — the declared relationships on a crm_alias. The deal ref resolver reads
  // THIS rather than hardcoding `'contact_id'`.
  crmRefFields,
  composePlatformRecordTargetId,
  cronZoneFor,
  executionSourceContractId,
  ownerApprovesCallsOf,
  isDelegatedMcpToken,
  // D-237 P1 — the per-instance freshness verdict the AI-facing collection
  // reads now carry, alongside the CRM trio's `crm_freshness`.
  collectionSourceFreshnessFanOut,
  type CollectionHealth,
  type CollectionSourceFreshnessEntry,
  type ExecutionSource,
  type ChatConfidenceEnvelope,
  type ChatContactCandidate,
  type ChatContactRecord,
  type ChatDealCandidate,
  type ChatAccountCandidate,
  type CrmConnectionFreshness,
  type ChatDispatchContext,
  type ChatDispatchResult,
  type ConnectionMcpAnnotationState,
  type ContactAliasPlatform,
  type ContactContributionSource,
  type ContactRecord,
  type CrmAlias,
  type DishWebhookDoorChange,
  type EnrichmentScope,
  type EnrichmentTopic,
  type IngredientManifest,
  type ReadableCollection,
  type RecipeDefinition,
  type RecipeError,
  type ScopeSearchResult,
  type ScopeSearchSourceId,
  type ScopeSearchCandidate,
  recipeGrantEntry,
  truncateUtf8,
} from '@recued/contracts';
import {
  confidenceShape,
  runScopeSearchFanout,
  type ScopeSearchSource,
} from '@recued/middleware-recued';
import {
  type Tier1Handler,
  type Tier2Handler,
  type Tier2Source,
  type Tier3Handler,
} from '@recued/middleware/internal-tool-registry/index.js';
import type { Tier2ConnectionSlot, Tier2RecipeEntry, IngredientKindLookup } from '@recued/recipes';
import type {
  AuditEntry,
  AuditLogStore,
  Collection as StorageCollection,
} from '@recued/storage';
import { recipeDateArgumentIssue } from './date-argument-format.js';
import { AssetFieldHeldError, unambiguousDateMs } from './storage/work-entity-store.js';
import type { AssetAiWrite } from './work-entity-ingredients.js';
import { isMentionOnlyEmail, type ContactStore } from './storage/contact-store.js';
import type { EnrichmentStore } from './storage/enrichment-store.js';
import type { CrmRecordMirrorStore } from './storage/crm-record-mirror-store.js';
import type { CollectionRegistry } from './collections/registry.js';
import { deriveChannelSessionId } from '@recued/gateway';
import type { InFlightRegistry } from './execution/in-flight-registry.js';
import { DATA_FILE_RECEIVED_SLUG } from './collections/file/file-read-handler.js';
import { scoreFileNeedle, type FileViewResolver, type DataFileView } from './file-view-resolver.js';
import { isWatchedFolderCollection } from './collections/file/watched-folder-collection.js';
import { isMirroredCollection } from './collections/mirrored-collection.js';
import { mediaClassForMimeType } from './collections/file/inbound-file-collection.js';
import type { Collection } from './collections/types.js';
import type {
  CalendarCollection,
} from './collections/calendar/calendar-collection.js';
import type { RecipeStore } from './recipe-store.js';
import {
  projectRunResultForAgent,
  runCancellationMessage,
} from './run-result-agent-projection.js';
import { RUN_INGREDIENT_RECIPE } from './run-ingredient-recipe.js';
import { createMailReadHandler } from './mail-read-tool.js';
import { mailEvidenceMetadata } from './mail-evidence.js';
import { mailboxAddressOf } from './mail-senders.js';
import { resolveRecipeId } from './recipe-tool-name.js';
import { createDocumentReadHandler } from './document-read-tool.js';
import type { MailAttachmentReader } from './mail-attachment-evidence.js';

import type { ServerExecutorConfig } from './server-executor.js';
import {
  executeResponseAuditRunId,
  executeResponseStandingDishId,
} from './types.js';
import type { ExecuteRequest, ExecuteResponse } from './types.js';
import {
  AUTHOR_DEFAULT_READ_GRANT_CHECKER,
  collectionReadFencedHint,
  type GatedReadGrantResolver,
} from './read-grant-checker.js';
import {
  applySourceLiveEscalation,
  type SourceLiveEscalationUnit,
} from './source-mirror/live-escalation.js';
import {
  runWorkEntityReadTool,
  runWorkEntitySearchTool,
  type WorkEntityReadToolsDeps,
} from './work-entity-read-tools.js';
import {
  admitSourceCatalogEscalation,
  escalationOrigin,
  type EscalationOrigin,
} from './escalation-admission.js';
import type { OpAdmissionGate } from './op-admission-gate.js';
import type { ContractOverlayResolver } from './policy-contract-overlay.js';
import { createStoreBackedMemoryWriteAdapter } from './memory-write-adapter.js';
import { authoringContractId } from './grant-governing-contract.js';
import {
  checkForgetOwnEntry,
  checkOwnEntry,
  currentVersionOf,
  forgetOwnEntry,
  forgottenIds,
  liveReplacementOf,
  memoryRowAuthor,
  withRevisionLock,
} from './memory-revision.js';
import { emitMemoryUser } from './events/emit-sites.js';
import type { MemoryRedactionRecord } from './memory-rpc-handler.js';
import type { EventBus } from './events/bus.js';
import type {
  MemoryEmbedder,
  MemorySearchResult,
  UserMemoryRow,
  UserMemorySession,
  UserMemoryStore,
} from './user-memory-store.js';
import type { WorkEntityResolver } from './work-entity-resolver.js';
import type { WorkEntityEdgeStore } from './storage/work-entity-edge-store.js';
import type { WorkEntityTargetedReadDeps } from './work-entity-write-executor.js';
import { guardTaskMarkDone, handleWorkEntityUpsert } from './work-entity-crud-handler.js';
import {
  DEFAULT_LOCAL_CALENDAR_ID,
  DEFAULT_LOCAL_CALENDAR_SLUG,
} from './collections/calendar/local-provider.js';
import type { WorkEntityCrudRpcDeps } from './work-entity-crud-handler.js';
// D-225 § 9.5.1 — the raw catalog-op projection, shared with the inbound door.
import {
  OP_TOOL_PREFIX,
  buildRawOpToolDescriptors,
  buildRecipeOpCoverage,
  rawOpToolEntriesFrom,
  visibleRawOps,
  type RawOpToolEntry,
  type RawOpToolDescriptor,
} from './raw-op-tool-catalog.js';
import {
  runCanonicalSearchFanout,
  type CanonicalOpToolDescriptor,
} from './canonical-op-tool-catalog.js';
import { buildCanonicalOpRecipe, CANONICAL_OP_CONNECTION_VAR } from '@recued/recipes';
import { CANONICAL_OP_TOOL_PREFIX } from '@recued/contracts';
import {
  dispatchRawOp,
  type RawOpDispatchDeps,
  type RawOpDispatchOutcome,
} from './raw-op-dispatch.js';
import { buildPackOpResolution, type InstalledPackScan } from './pack-inventory.js';
import { missingPacksOfRefusal } from './install-offers/needed-packs.js';
import type { InstalledRecipeScheduleInput, InstalledRecipeScheduler } from './schedule-installed-recipe.js';
import { formatIsoWithOffset } from './collections/calendar/iso-offset.js';
import { calendarAddressOf } from './collections/calendar/provider.js';
import { parseInstantWithOffset } from '@recued/transforms';
import { eventWhenOnTurnClock } from './chat-clock.js';

/** Executor closure shape. `chat-tool-handlers` calls this rather than
 *  importing `handleExecute` directly so tests can substitute a fake
 *  without standing up the full execute-deps cone. bin.ts binds the
 *  production executor to `(req) => handleExecute(executeDeps, req)`
 *  after `executeDeps` finalises. */
export type ChatRecipeExecutor = (request: ExecuteRequest) => Promise<ExecuteResponse>;

/** Late-bound dep providers. Each getter resolves at dispatch time so
 *  stores wired after the chat orchestrator (enrichment, the enrichment-
 *  visibility resolver, the executor composite) are picked up live. */
export interface ChatToolHandlerDeps {
  readMailBody?: (record: import('@recued/contracts').CollectionRecord) => Promise<string | null>;
  mailAttachments?: MailAttachmentReader;
  documentPacks?: InstalledPackScan;
  /** D-259 § 7.4.3 — the live in-flight registry, for `recipe.stop`. Late-bound
   *  like the executor: `bin.ts` composes the handler table before the
   *  registry exists. Absent ⇒ `recipe.stop` reports the registry unavailable
   *  rather than silently reporting nothing to stop. */
  getInFlightRegistry?: () => InFlightRegistry | undefined;
  /** D-320 §3.5 — for one catalog listing, the slots each recipe signs in through
   *  where the owner has a choice of connection (`recipe-connection-choices.ts`).
   *  Called once per listing, so the stores are read once. Absent ⇒ no recipe
   *  tool takes a `connections` argument. */
  connectionChoices?: () => (recipe: RecipeDefinition) => ReadonlyArray<Tier2ConnectionSlot>;
  /** D-237 P1 — injectable clock for the source-freshness verdicts the
   *  collection reads now carry. Absent ⇒ `Date.now`, matching every D-236 call
   *  site. Present so a test can pin an age rather than infer one from wall
   *  clock, which is how a staleness assertion becomes a flake. */
  now?: () => number;
  getSituationAccess?: () => import('./situations/access.js').SituationAccess | undefined;
  getContactStore: () => ContactStore | undefined;
  getCollectionRegistry: () => CollectionRegistry | undefined;
  /** The unified local+remote file view. ⛔ WITHOUT IT `file.search` SEES ONE
   *  COLLECTION AND NO REMOTE SOURCE AT ALL — it read
   *  `registry.get('file', 'received')` directly, alone among the search tools
   *  (`mail` and `calendar` both fan out across their platform), and D-192
   *  remote files live in `file_meta_ref`, which is not a collection, so no
   *  amount of fan-out would have reached them either.
   *
   *  Late-bound and optional: a dbless / partial harness has no meta store, and
   *  absent ⇒ the handler falls back to the single-collection read rather than
   *  failing. That fallback is the PRE-EXISTING behaviour, so a missing wire
   *  costs remote reach and never correctness. */
  getFileViewResolver?: () => FileViewResolver | undefined;
  /** D-172 P2 — the session's own message rows, for `file.search`'s default
   *  (and safe) scope. Optional because a dbless / partial harness has no chat
   *  store; absent ⇒ session scope returns EMPTY with a stated reason rather
   *  than silently falling through to the whole file store. */
  getChatStore?: () => {
    listMessages(session_id: string): Promise<ReadonlyArray<{
      attachments?: ReadonlyArray<{ file_id: string }>;
    }>>;
  } | undefined;
  /** ⛔ WIRED BUT UNCALLED — DELIBERATE. DO NOT TIDY THIS AWAY.
   *
   *  No handler in this file reads it (verified 2026-08-24: no call site and no
   *  destructured form, tree-wide). It went unused in `1e8552e3b` (D-198), which
   *  deleted `memory.search`'s audit half and left the seam behind.
   *
   *  ⛔⛔ CORRECTED 2026-08-24 — AN EARLIER VERSION OF THIS NOTE CALLED THE MISSING
   *  AUDIT CHAT TOOL A "GAP" AND ARGUED THIS DEP SHOULD BE KEPT TO BUILD ONE.
   *  That is backwards. Owner ruling, same day: **audit is OUT of chat because it
   *  is NOISE on that surface** — its removal from `memory.search` in `1e8552e3b`
   *  was the design working, not decay. And `data.timeline()` is NOT missing: it
   *  is alive on TWO surfaces (`mcp/timeline.ts` and `timeline-rpc-handler.ts`,
   *  D-174 #22) and spans strictly more than recall does — mail, calendar,
   *  enrichment, memory, annotation and link, entity-scoped — where
   *  `recall.search` is interaction + memory, query-scoped. The consumers that
   *  want a chronological feed HAVE one; chat is deliberately not among them.
   *
   *  ⇒ SO THE "A SPEND TOOL WILL NEED THIS HOOK" ARGUMENT IS RETIRED. D-250
   *  (`d94d8e444`) did add `AuditEntry.total_usage`, and nothing reads it back
   *  (chat reports only the CURRENT turn's usage on `ChatTurnAck`), but that is
   *  not a reason to keep a CHAT-tool dep: reading run spend belongs on the
   *  surfaces that already own run history, not here. Whoever next audits this
   *  file should decide keep-or-remove on the cost below, NOT on a future chat
   *  tool — there is no such tool planned.
   *
   *  ⚠ Bench task 75 was narrowed for this reason: it asked chat "what actions
   *  has Recued taken", the model correctly declined, and the task scored that
   *  honesty as a routing miss. The prompt was asking the chat surface for
   *  something that is deliberately not its job.
   *
   *  ⚠ "Uncalled" is not "safe to delete", and the two were conflated once
   *  already. It is supplied by the composition root
   *  (`wire-chat-orchestrator.ts`) and stubbed in 19 test files, so removing and
   *  later restoring it costs strictly more than leaving it. */
  getAuditLog: () => AuditLogStore | undefined;
  /** D-198 Slice 4 — the owner-authored + AI/customer-written `user_memory`
   *  store. `memory.write` writes here (stamped `contracted_user`) and
   *  `memory.search` reads it. Absent (db-less harness / pre-wire) →
   *  `memory.write` reports `execution_error` and `memory.search` returns an
   *  EMPTY result marked `unavailable`.
   *
   *  ⛔⛔ CORRECTED 2026-08-24 — THIS COMMENT DESCRIBED A REMOVED FEATURE, and it
   *  cost a reader real time. It said the "widened `memory.search` unions it with
   *  the audit log" and "falls back to the audit-only read". Neither is true:
   *  `createMemorySearchHandler` reads ONLY this store and returns
   *  `emptyMemoryResult(..., 'unavailable')` without it, and the handler's own
   *  comment is the current one — "The pool is now the ONLY half". The audit
   *  union was removed and the comment was not.
   *
   *  🔑 WHY A STALE COMMENT HERE IS EXPENSIVE, not cosmetic. This tool's
   *  DESCRIPTION is model-facing and says outright "It does NOT hold run
   *  history (what a recipe did)" — which is CORRECT. A reader who trusts this
   *  comment over the handler concludes the description is the thing that is
   *  wrong, and the obvious "fix" is to advertise run history to the model. That
   *  would make `memory.search` claim a capability it does not implement, so the
   *  model would route run-history questions here and get an empty pool back.
   *  ⇒ The description and the handler agree. This comment was the outlier. */
  getUserMemoryStore?: () => UserMemoryStore | undefined;
  /** D-198 Slice 4 — the redaction-marker store, so `memory.search` HONORS the
   *  "forget this" overlay: a redacted (forgotten) row is omitted from recall
   *  (§5), never handed back to the model. Threaded alongside the user_memory
   *  store (both db-gated); absent → recall can't consult it (unreachable in a
   *  db-backed server where the user_memory store also exists). */
  getMemoryRedactionStore?: () => StorageCollection<MemoryRedactionRecord> | undefined;
  /** RUNG 4 — turns the QUERY into a vector so `memory.search` can fall through
   *  to meaning when no rung of the lexical ladder matched.
   *
   *  ⚠ THIS IS THE ONLY LLM CALL IN THE TOOL, which is why it is late-bound and
   *  optional rather than a required dep: absent ⇒ rung 4 is simply off, and
   *  `memory.search` stays the zero-token, provider-free SQL read it is today.
   *  It fires only after rungs 1–3 return nothing (~3% of queries on the pilot
   *  corpus), so the common path never pays for it. */
  getMemoryEmbedder?: () => MemoryEmbedder | undefined;
  /** D-198 Slice 4 — the realtime bus, so a `memory.write` fans a `memory`
   *  event and paired Memory lenses live-refresh (mirrors the owner-direct
   *  `memory.create` rpc, spec §7.7). Absent → the write still persists; the
   *  feed just refreshes on next navigation instead of live. */
  getEventBus?: () => EventBus | undefined;
  getEnrichmentStore: () => EnrichmentStore | undefined;
  getRecipeStore: () => RecipeStore;
  getExecutorConfig: () => ServerExecutorConfig;
  /** D-225 § 9.5.1 — the installed-pack inventory scan. Supplied ⇒ the chat
   *  catalog ALSO offers raw catalog ops (`recued_op_<opid>`), the SAME source
   *  the inbound door has had since D-182 §8.
   *
   *  ⛔ This absence is the entire reason declared pack ops had no chat
   *  presence. Nothing about the projection was door-specific — chat has its own
   *  catalog and simply never received the source. Absent here ⇒ no raw ops,
   *  which is today's behaviour and keeps every dbless / partial harness working
   *  unchanged. */
  scanInstalledPacks?: InstalledPackScan;
  /** D-225 § 9.5.1 step 2b — the raw-op dispatch deps, late-bound like
   *  `getExecuteRecipe` (they compose after the executor). Supplied ⇒ a chat
   *  caller can INVOKE the `recued_op_*` tools `createChatRawOpSource` offers.
   *
   *  ⚠ Source and dispatch are separate deps ON PURPOSE. A host that offered
   *  the tools without wiring the dispatch would advertise calls it cannot
   *  make; the registry builder below refuses that pairing rather than letting
   *  the model discover it at call time. */
  getRawOpDispatchDeps?: () => RawOpDispatchDeps | undefined;
  /** Recipe executor closure. Bound late by bin.ts (resolves the
   *  composed `executeDeps` at call time). When undefined the
   *  `recipe.run` + Tier 2 handlers surface `execution_error`. */
  getExecuteRecipe: () => ChatRecipeExecutor | undefined;
  /** D-193 amendment — chat's `recipe.schedule`: the scheduler over the
   *  server's schedule store (`schedule-installed-recipe.ts`). Late-bound: the
   *  store composes after the chat substrate. Undefined ⇒ the tool says
   *  scheduling is unavailable. */
  getPromptSchedules?: () => import('./prompt-schedules.js').PromptSchedules | undefined;
  getInstalledRecipeScheduler?: () => InstalledRecipeScheduler | undefined;
  /** D-255 — the canonical op tools reachable for this server's bound
   *  connections, already filtered by each connection's operation profile.
   *
   *  🔑 A THUNK, because the OWNER'S CATALOG AND A DOOR'S MUST COME FROM ONE
   *  BUILDER. The owner is the `user_self` contract and a door is another
   *  contract id; both resolve through the same grant, so a second producer here
   *  would be an owner/door branch wearing a different name. The composition root
   *  supplies `canonicalOpToolsForConnections(...)`, the same call `mcp-server`
   *  makes. Absent ⇒ no canonical tools in chat, which is the dbless posture. */
  getCanonicalOpTools?: () => ReadonlyArray<CanonicalOpToolDescriptor>;
  /** D-221 §3.3.3 defense-in-depth for an external MCP invocation. Grant
   * preflight owns the exposure-time refusal; this live check closes stale
   * grants, recipe upgrades, and the generic `recipe.run` umbrella. */
  preflightExternalRecipeDispatch?: (recipe: RecipeDefinition) => void;
  /** D-137/M-CHAT-2 — live Tier 3 annotation snapshot used by
   *  `createChatTier3Dispatch` to resolve `<connection>.<tool>` back
   *  to the upstream MCP tool name + Mary's current classification
   *  before dispatch. Optional for tests / dbless harnesses; absent
   *  means Tier 3 dispatch fails closed with `unknown_tool`. */
  getConnectionMcpAnnotations?: () => ReadonlyArray<ConnectionMcpAnnotationState> | undefined;
  /** D-228 slice 3 — which upstream MCP tools a governed pack op already
   *  reaches, for the connection named. The SAME lookup the chat catalog
   *  consults, so a name the catalog withdrew cannot be dispatched anyway.
   *
   *  ⛔ Absent ⇒ no suppression, matching the catalog's own absent branch. The
   *  two must agree on that default or a tool would be advertised and refused. */
  connectionMcpPackCoverage?: (connection_name: string) => ReadonlySet<string> | undefined;
  /** D-187 AMENDMENT — per-contract read-grant resolver. Threaded into the
   *  channel-aware gate for `enrichment.search` so Settings → MCP grant toggles take
   *  effect against external-agent dispatches the way they do for the
   *  `recued_enrichmentRead` / `enrichment-list` recipe reads. Optional — dbless harness
   *  skips. When absent, the gate falls back to the author-default checker (registry
   *  `mcp_exposed`). */
  getReadGrantResolver?: () => GatedReadGrantResolver | undefined;
  /** D-190 — the bound CRM mirror sources for a `crm_alias` (`deal`/`contact`/
   *  `account`), derived from the user's bound connections × the live vendor
   *  registry (`deriveBoundCrmMirrorSources`). The GENERIC replacement for the old
   *  hardcoded hubspot/salesforce source list — any bound CRM vendor (built-in or
   *  pack-declared) participates. Resolved at dispatch so a connection enroll /
   *  pack install is reflected on the next turn. Absent (db-less harness) → the
   *  fan-out has no mirror sources. */
  getBoundCrmMirrorSources?: (
    crmAlias: CrmAlias,
  ) => ReadonlyArray<{ source_id: string; scope: EnrichmentScope }>;
  /** S1 (CRM mirror freshness) — per-connection `synced_at` for a `crm_alias`,
   *  read from each bound connection's reconcile state (`last_run_at`, gated on a
   *  non-error last run). `deal.search` / `contact.search` attach the list to their
   *  result as `crm_freshness` so the AI can caveat / escalate stale mirror data
   *  (the mirror is eventually-consistent, not live). Absent (db-less harness /
   *  pre-housekeeping boot) → the handlers attach an empty list. */
  getCrmConnectionFreshness?: (
    crmAlias: CrmAlias,
  ) => ReadonlyArray<CrmConnectionFreshness>;
  /** S3 — live-fetch a connection's CURRENT record set from the vendor (the match-all
   *  canonical `<entity>.search` the reconciler's poll uses), for escalation when the
   *  mirror is stale or a narrow lookup missed. Returns the projected canonical
   *  records keyed by native id, or null on a failed / unavailable / un-granted poll
   *  (the handler then keeps the mirror result for that connection). Absent (db-less /
   *  no executor) → no escalation, mirror-only.
   *
   *  `origin` (D-192 CRM escalation parity) — the dispatch ctx's caller identity,
   *  threaded VERBATIM onto the poll's gated invoke (honest audit attribution + the
   *  catalog gateway's per-actor `contract.override` tightening — never the lying
   *  background `system` posture for a caller-triggered fetch). */
  getCrmLiveRecords?: (input: {
    vendor: string;
    entity: string;
    connection_name: string;
    origin?: EscalationOrigin;
  }) => Promise<Map<string, Record<string, unknown>> | null>;
  /** D-192 CRM escalation parity — resolve a bound connection's catalog binding
   *  (operation profile `catalog_slug` → installed manifest) so the S3 admission
   *  seam can judge the BACKING catalog tool + the `${entity}.search` op before
   *  any live fetch. Null = unresolvable (not enrolled / no binding / manifest
   *  missing — the poll's own config guards would refuse the same key). Absent
   *  (db-less harness) ⇒ admission runs binding-less: owner chat attempts (the
   *  poll's config guards own the failure), an external dispatch is refused
   *  fail-closed (admission that cannot run never admits). */
  getCrmEscalationBinding?: (
    connection_name: string,
  ) => { catalogSlug: string; manifest: IngredientManifest } | null;
  /** D-190 (generic reconciler MS3) — the dedicated CRM record mirror
   *  (`crm_record_mirror`) that `deal.search` reads. The reconciler + webhook
   *  funnels write one row per CRM record UNCONDITIONALLY (MS2), so reading the
   *  mirror — not the producer-gated enrichment store — surfaces EVERY deal, not
   *  just AI-enriched ones. Optional — absent (db-less harness / pre-wire) → the
   *  per-vendor deal sources return empty, same degradation as an absent
   *  `getBoundCrmMirrorSources`. */
  getCrmRecordMirror?: () => CrmRecordMirrorStore | undefined;
  /** D-192 read resolution — the freshness-enabled work-entity resolver
   *  `work.search` / `work.read` read (rich meta + `sourceFreshness`
   *  verdicts). Optional — absent (db-less harness) → both tools
   *  surface `execution_error`. */
  getWorkEntityResolver?: () => WorkEntityResolver | undefined;
  /** D-192 read resolution — the targeted-read spine (gateway fetch
   *  deps + the SAME declaration resolver the sync/write wires use).
   *  Late-populated by the post-listener runtime; absent → remote
   *  escalation degrades to the honest local answer. */
  getWorkEntityTargetedReadDeps?: () => WorkEntityTargetedReadDeps | undefined;
  /** D-192 P5 edges — backs `work.read`'s `include_related`. Same collection
   *  and therefore same grants as the owner row (see the dep's note in
   *  `work-entity-read-tools.ts`); absent → the flag discloses that the store
   *  is unwired rather than reporting an empty relationship set. */
  getWorkEntityEdgeStore?: () => Pick<WorkEntityEdgeStore, 'listByOwner'> | undefined;
  /** The LOCAL work-entity write path for the Tier-1 `work.create` tool — the
   *  same `WorkEntityCrudRpcDeps` the `work_entity.upsert` rpc uses, so a chat
   *  create and an owner's own click land through ONE dispatcher (warehouse
   *  events, enrichment cascade and audit all fan identically). Late-bound: the
   *  deps are assembled in `compose-listeners` once the store AND the
   *  bus-wired dispatchers exist. Absent ⇒ the tool reports `execution_error`
   *  rather than silently doing nothing. */
  getWorkEntityCrudDeps?: () => WorkEntityCrudRpcDeps | undefined;
  /** D-325 (2026-10-24) — the asset types `work.type` describes and `work.create`
   *  names (`asset-types.ts`). Absent ⇒ both report `execution_error`. */
  getAssetTypes?: () => AssetTypes | undefined;
  /** Slice 2 — the calendar write dispatchers behind `calendar.create` /
   *  `calendar.update` (`calendarStack.kernelDispatchers.*`). The SAME
   *  verified-then-reflected pair the reception booking seam and the
   *  `calendar-create` recipe step use, so a chat mutation, a booking and a
   *  recipe all land through one provider call + one warehouse mirror. */
  getCalendarWriteDeps?: () => CalendarWriteDeps | undefined;
  /** D-188 + the D-192 admission seam — the op-admission gate
   *  (`isFrozenByPause` + `isOpGranted`) for caller-triggered vendor
   *  escalations, which never traverse the op-admission gate on the
   *  invoke spine. Consulted by BOTH escalation families: the
   *  work-entity targeted reads (`work.search`/`work.read`) and the
   *  CRM S3 live escalation (`contact.search`/`deal.search`/
   *  `account.search`). Absent (dbless) ⇒ pause + op grants unenforced
   *  for owner chat; EXTERNAL escalation refused outright (fail closed
   *  — a door's admission cannot run without the gate). */
  getOpAdmissionGate?: () =>
    | Pick<OpAdmissionGate, 'isFrozenByPause' | 'isOpGranted' | 'isOwnerRecipeGranted' | 'isOwnerGoverned'>
    | undefined;
  /** D-320 audit — the governing contract's connection axis for the same escalations
   *  (late-bound off execute deps, like the gate): a contract that lists connections
   *  bounds the connection an escalated read signs in through. Absent (dbless) ⇒ that
   *  connection is not fenced, as at raw-op dispatch. */
  getContractOverlay?: () => Pick<ContractOverlayResolver, 'admitsConnection'> | undefined;
}

/** Hard ceilings to bound the per-call payload landing in the chat
 *  agent's main-turn prompt + the `chat.tool_call_completed` broadcast.
 *  Each list / search defaults to `DEFAULT_LIMIT` when args omit one;
 *  user-supplied values clamp to `MAX_LIMIT`. */
const DEFAULT_LIMIT = 20;

/** Body preview length on the LIST path (filters / date-range reads, which have
 *  no FTS snippet to stand in for content). Long enough to carry a short reply
 *  in full; short enough that listing a thread does not dump every message. */
const LIST_PREVIEW_CHARS = 400;
const MAX_LIMIT = 100;

const clampLimit = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_LIMIT;
  const n = Math.floor(raw);
  if (n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
};

const asObject = (raw: unknown): Record<string, unknown> | null => {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
};

const invalidArgs = (detail: string): ChatDispatchResult => ({
  ok: false,
  reason: 'invalid_args',
  detail,
});

const executionError = (detail: string): ChatDispatchResult => ({
  ok: false,
  reason: 'execution_error',
  detail,
});

/** Wrap a recipe.run result for the chat tool-loop.
 *
 *  Three outcomes, three shapes:
 *    - **owner-cancelled** (D-181 § 9 — `run_terminated` set: an
 *      `execution.kill` mid-flight or an `execution.cancel` of a queued call)
 *      → `{ ok: false, reason: 'run_cancelled', detail }`. NOT `ok: true`: a
 *      deliberate user cancellation is not a usable result, and the `detail`
 *      (the model-facing `runCancellationMessage`) echoes WHICH tool ran
 *      (`toolLabel`, never the args) + the do-NOT-retry / resolve-with-user
 *      posture, so the agent stops re-issuing the call and turns to the user.
 *    - **held for approval** → `{ ok: true, result: awaiting_approval shape }`
 *      via `projectRunResultForAgent` (no bare `success: false`, which a model
 *      reads as a silent failure → re-sends → loops).
 *    - **otherwise** (success / ordinary failure) → `{ ok: true, result }`
 *      passes through `projectRunResultForAgent` unchanged.
 *
 *  `toolLabel` is the tool the agent actually invoked (Tier 1 / 2 recipe id,
 *  Tier 3 `<connection>.<tool>`); it defaults to the run's `recipe_id`. The
 *  awaiting-approval projection still backs the MCP runRecipe paths; the
 *  cancellation `ok: false` shape is the chat-dispatch surface (the MCP wire
 *  returns its own result envelope). */
/** D-182 — the concise user-facing error line for a failed run (the activity row).
 *  The first error's message (the cli `not found` line / the step failure), never
 *  its `details` (no secrets — same content the Runs detail + the model see). */
const runFailureDetail = (result: ExecuteResponse): string => {
  const first = result.errors?.[0];
  const msg =
    first !== null && typeof first === 'object' && 'message' in first
      ? (first as { message?: unknown }).message
      : undefined;
  return typeof msg === 'string' && msg.length > 0 ? msg : 'the run did not complete';
};

export const wrapRecipeRunResult = (
  result: ExecuteResponse,
  toolLabel?: string,
): ChatDispatchResult => {
  // Host-owned metadata: never infer this from `result_ref`, recipe ids, or
  // model-visible output. It exists only when the execute handler confirmed
  // that the exact audit anchor was durably written.
  const run_id = executeResponseAuditRunId(result);
  const dish_id = executeResponseStandingDishId(result);
  const runAddress = {
    ...(run_id !== undefined ? { run_id } : {}),
    ...(dish_id !== undefined ? { dish_id } : {}),
  };
  if (result.run_terminated !== undefined) {
    return {
      ok: false,
      reason: 'run_cancelled',
      detail: runCancellationMessage(result.run_terminated, toolLabel ?? result.recipe_id),
      ...runAddress,
    };
  }
  const projected = projectRunResultForAgent(result);
  if (result.awaiting_approval === true) {
    return {
      ok: true,
      result: projected,
      run_held: { kind: 'approval' },
      ...runAddress,
    };
  }
  if (result.container_pick_required !== undefined) {
    return {
      ok: true,
      result: projected,
      run_held: { kind: 'container_pick' },
      ...runAddress,
    };
  }
  if (result.create_plan_required !== undefined) {
    return {
      ok: true,
      result: projected,
      run_held: { kind: 'create_plan' },
      ...runAddress,
    };
  }
  // D-182 — a genuinely FAILED run (returned errors, NOT held for approval) carries
  // a user-facing failure line the chat broadcast renders as an ERROR activity row.
  // The model-facing result stays `ok: true` (the projected shape) — the tuned
  // anti-loop posture is intact; the model still gets the full errors[] to narrate.
  // All held third states returned above, so only a genuine completed failure
  // reaches this activity-row signal.
  if (result.success === false) {
    return {
      ok: true,
      result: projected,
      run_failed: { detail: runFailureDetail(result) },
      ...runAddress,
    };
  }
  return { ok: true, result: projected, ...runAddress };
};

const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** A run or a schedule that threw. D-323 — a `pack_not_installed` refusal keeps
 *  its packs as data beside its sentence, so chat can offer them under its
 *  answer (`install-offers/needed-packs.ts`). */
const refusalOf = (error: unknown): ChatDispatchResult => {
  const missing_packs = missingPacksOfRefusal(error);
  return missing_packs.length > 0
    ? { ok: false, reason: 'execution_error', detail: errMessage(error), missing_packs }
    : executionError(errMessage(error));
};

/** D-137 P2 § A.4 Codex P2 fold — clamp merged fan-out candidates to
 *  the per-call ceiling. Each source threads the user-supplied `limit`
 *  in isolation, so a 3-source fan-out with `limit: 10` can return up
 *  to 30 candidates. The chat agent's main-turn prompt + broadcast
 *  payload assume the documented `MAX_LIMIT` ceiling holds at the
 *  envelope level; truncating after the merge enforces it.
 *
 *  Sequential fan-out order is preserved (local first, then platform
 *  mirrors); the truncation drops trailing platform-source rows when
 *  the cap binds. `partial` / `partial_failures` carry through
 *  unchanged — degradation state isn't a function of how much was
 *  returned. */
const clampScopeSearchResult = <T>(
  result: import('@recued/contracts').ScopeSearchResult<T>,
  limit: number,
): import('@recued/contracts').ScopeSearchResult<T> => {
  if (result.candidates.length <= limit) return result;
  const truncated = result.candidates.slice(0, limit);
  return result.partial
    ? {
        candidates: truncated,
        partial: true,
        ...(result.partial_failures
          ? { partial_failures: result.partial_failures }
          : {}),
      }
    : { candidates: truncated };
};

/** D-137 P3 § A.5 — wrap a clamped fan-out result with a confidence-
 *  shape envelope so the chat agent loop drives disambiguation UX off
 *  the candidate distribution instead of a tunable confidence knob.
 *
 *  Reuses the per-source `score` field carried through fan-out (P2
 *  preserved it on `ScopeSearchCandidate<T>`). Per-record recency
 *  resolver is supplied per tool — `contact.search` keys off
 *  `recent_activity_at`; `deal.search` keys off `close_date`.
 *
 *  Pure. The wrapped envelope contains the same `candidates` /
 *  `partial` / `partial_failures` triplet plus a `shape` discriminator;
 *  the agent's main-turn prompt reads `shape.pattern` to select the
 *  per-pattern response template. */
const augmentWithConfidenceShape = <T>(
  result: ScopeSearchResult<T>,
  recencyKey?: (item: T) => number,
): ScopeSearchResult<T> & { envelope: ChatConfidenceEnvelope<T> } => {
  const scored: ReadonlyArray<confidenceShape.ScoredCandidate<T>> =
    result.candidates.map((c: ScopeSearchCandidate<T>) =>
      typeof c.score === 'number'
        ? { record: c.record, score: c.score }
        : { record: c.record },
    );
  const shape = confidenceShape.classifyConfidenceShape(scored, {
    ...(recencyKey ? { recencyKey } : {}),
  });
  // Closed-list pattern → ChatConfidenceShape projection. The internal
  // `ConfidenceShape<T>` and contract `ChatConfidenceShape<T>` agree on
  // every field; the projection is a structural copy so the contract
  // surface doesn't depend on the engine package's types directly.
  const projected: ChatConfidenceEnvelope<T>['shape'] =
    shape.pattern === 1
      ? {
          pattern: 1,
          top: shape.top,
          alternatives: shape.alternatives,
          measures: shape.measures,
        }
      : shape.pattern === 2
        ? {
            pattern: 2,
            top: shape.top,
            close: shape.close,
            alternatives: shape.alternatives,
            measures: shape.measures,
          }
        : shape.pattern === 3
          ? {
              pattern: 3,
              candidates: shape.candidates,
              measures: shape.measures,
            }
          : { pattern: 4, measures: shape.measures };
  return { ...result, envelope: { shape: projected } };
};

const recencyKeyForContact = (c: ChatContactCandidate): number =>
  typeof c.recent_activity_at === 'number' && Number.isFinite(c.recent_activity_at)
    ? c.recent_activity_at
    : 0;

const recencyKeyForDeal = (c: ChatDealCandidate): number =>
  typeof c.close_date === 'number' && Number.isFinite(c.close_date)
    ? c.close_date
    : 0;

// Accounts carry no uniform recency field across vendors (no close_date /
// activity timestamp on the canonical projection), so the confidence-shape
// tie-break ranks by score alone — a constant 0 is the honest signal.
const recencyKeyForAccount = (_c: ChatAccountCandidate): number => 0;

/** D-137 Trio #D Codex P1 fold — derive ExecuteRequest's
 *  `trigger_source` from the dispatch channel. MCP-wire dispatches
 *  trip the engine's `gate_mcp_private` chain (`execute-handler.ts`
 *  L236: `isMcpTriggeredRecipe = request.trigger_source === 'mcp'`),
 *  which threads through `createEnrichmentReader` + the kernel
 *  `enrichment-list` ingredient + timeline filtering. Internal-channel
 *  dispatches stay `'chat'` so audit attribution + Memory's "Recent
 *  activity" feed shape stay unchanged for Mary's own chat usage. */
const channelTriggerSource = (
  ctx: ChatDispatchContext,
): 'mcp' | 'chat' =>
  ctx.channel === 'mcp_wire' ? 'mcp' : 'chat';

/** D-187 AMENDMENT — read-grant reject helper. Mirrors the recipe-channel
 *  `enrichment-list` gate so an external MCP agent invoking `enrichment.search` honours
 *  the same per-topic `enrichment.<topic>` grant. D-187 AMENDMENT 3b — resolves the
 *  grant against the dispatch's GOVERNING contract via {@link GatedReadGrantResolver.resolveForSource}:
 *  the owner's own chat / messenger agent → the OWNER contract (permissive by default,
 *  honouring an explicit topic revoke — the D-153 admit-all `user_self` skip for AI
 *  channels is GONE), an external MCP-wire agent → its door contract, a contract-free
 *  dispatch → the author-default; per-(contract, topic), folding the former scope-fence +
 *  `mcp_exposed` visibility. Returns `null` when allowed, or a `bad_request`-shaped
 *  `ChatDispatchResult` when rejected. The owner's revoke of a topic now reaches their
 *  own AI's reads — behavior-preserving at zero revokes (the owner is permissive). */
const mcpPrivateRejection = (
  ctx: ChatDispatchContext,
  topic: string,
  readGrantResolver: GatedReadGrantResolver | undefined,
): ChatDispatchResult | null => {
  if (!isEnrichmentTopic(topic)) return null;
  const checker = ctx.execution_source
    ? (readGrantResolver?.resolveForSource(ctx.execution_source)
      ?? AUTHOR_DEFAULT_READ_GRANT_CHECKER)
    : AUTHOR_DEFAULT_READ_GRANT_CHECKER;
  if (checker.isTopicReadGranted(topic as EnrichmentTopic)) {
    return null;
  }
  return {
    ok: false,
    reason: 'classification_blocked',
    detail: `topic '${topic}' is not read-granted to this contract (read rejected)`,
  };
};

/** D-205 #3 — the RAW-COLLECTION read fence for the Tier-1 scope-search plane.
 *
 *  The sibling of {@link mcpPrivateRejection} (which fences enrichment TOPICS) over the
 *  other half of the same `(contract × grant)` matrix: the `data.<collection>` grant rows
 *  the D-187 read-grant checker resolves. Same governing-contract resolution — owner →
 *  permissive, a door → its bound contract's row, contract-free → author-default.
 *
 *  🔑 **Why this exists.** The native MCP read tools (`recued_dataTimeline`,
 *  `recued_contactEngagementsList`) honour these rows, and so does the recipe plane (the
 *  same grants derive `scope_restrictions`, which `evaluateScopeRestrictions` enforces at
 *  the preflight gate). The Tier-1 tools did NOT: `isCollectionReadGranted` had zero call
 *  sites in this file, so a door whose owner had REVOKED `contact` in the grants panel
 *  still read the entire contact graph through `contact.search`. Two fences on one door,
 *  and the one the owner can see did not compose with the one that ran — a revoke that
 *  did not revoke. The default posture is UNCHANGED (owner ruling, 2026-07-12: the raw
 *  collections stay author-default ADMIT — it is the owner's call which contract gets the
 *  spine, not ours to predict). This makes that call ENFORCEABLE, nothing more:
 *  behavior-preserving at zero revokes.
 *
 *  ⚠ Callers pass a `CanonicalCollectionName`; a collection outside `READABLE_COLLECTIONS`
 *  is out of this fence's jurisdiction (`memory` / enrichment topics / sidecars keep their
 *  own gates — see `read-collection-grant.ts`). */
export const isCollectionReadGrantedForDispatch = (
  deps: ChatToolHandlerDeps,
  ctx: ChatDispatchContext,
  collection: ReadableCollection,
): boolean => {
  const checker = ctx.execution_source
    ? (deps.getReadGrantResolver?.()?.resolveForSource(ctx.execution_source)
      ?? AUTHOR_DEFAULT_READ_GRANT_CHECKER)
    : AUTHOR_DEFAULT_READ_GRANT_CHECKER;
  return checker.isCollectionReadGranted(collection);
};

// ────────────────────────────────────────────────────────────────
// contact.search — D-137 P2 fan-out across local + HubSpot + Salesforce
// ────────────────────────────────────────────────────────────────

/** D-137 P2 § A.4 — per-tool source args. Both contact / deal fan-outs
 *  share this shape; per-source projections do their own field-name
 *  mapping at the meta layer.
 *
 *  D-145 PA8 follow-on extends the contact fan-out with `phone` and
 *  `alias` identifier args. The platform-mirror sources don't (yet)
 *  carry the same merge-predicate fields as the local warehouse, so
 *  they ignore phone/alias and silently return empty for those
 *  identifier kinds — the local source carries the load. */
interface ScopeSearchArgs {
  query?: string;
  email?: string;
  /** D-167 B3 — org-scoped contact search (case-insensitive `company`
   *  substring). The chat dispatch boundary routes an aliased `pii.Org`
   *  here from `query`; a raw org name the model passes directly also
   *  lands here. Local source only — platform mirrors don't carry a
   *  normalized company column yet (they return empty, like phone/alias). */
  company?: string;
  /** D-145 PA8 follow-on — exact-match E.164-canonical phone lookup. */
  phone?: string;
  /** D-145 PA8 follow-on — alias-pattern lookup. When `platform` is
   *  supplied the substrate uses the `platform_id` branch (cross-
   *  contact globally unique); when omitted, the substrate uses the
   *  `chat_alias` branch (per-contact dedup; may surface alternatives). */
  alias?: string;
  platform?: ContactAliasPlatform;
  /** D-190 deal.search union slice — canonical deal filters applied uniformly
   *  over the cross-vendor materialized mirror union (every vendor projects these
   *  identically, so the AI vocabulary is vendor-neutral). `close_state` is
   *  enum-validated at the handler; `close_since`/`close_until` bound the deal
   *  close date (unix-ms, inclusive). Deal fan-out only — the contact sources
   *  ignore them. */
  close_state?: string;
  close_since?: number;
  close_until?: number;
  /** D-190 account.search — exact case-insensitive website-domain lookup, the
   *  CRM account's strong identifier. Account fan-out only (deal / contact
   *  sources ignore it). */
  domain?: string;
  /** **D-206 — the REVERSE relationship lookup: this CONTACT's deals.** An email of one
   *  of the user's OWN contacts. Deal fan-out only.
   *
   *  The other end of the contract step 2 reads forward: a deal DECLARES `contact_id →
   *  ref{contact}`, so *"which deals point at this person?"* is the same declaration read
   *  backward — resolved through the durable identity link, filtered on the declared field,
   *  and answered with a COMPLETE total. Nothing is stored to make it work.
   *
   *  🔴 Reading it needs the `data.contact` grant (it resolves a core contact); a fenced
   *  door gets a NAMED partial_failure, never an empty list that reads as "no deals". */
  contact?: string;
  limit: number;
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** D-167 E.2 — stamp a chat-egress candidate with its inline `__entity`
 *  privacy marker so the entity-keyed resolver tags this record's PII
 *  (`email`/`name`/`target_id` for a contact; `owner` for a deal) wherever it
 *  re-embeds — the `candidates[].record` envelope AND every confidence-shape
 *  slot (the same record by ref) — from ONE bare entity declaration
 *  (`CANONICAL_PII_ENTITY_PRIVACY_TAGS`), and the model-bound seam strips the
 *  marker before egress. The marker is a runtime-only field read by FIELD NAME
 *  (`PII_ENTITY_MARKER_KEY`) by the resolver + strip, so it does not widen the
 *  candidate's typed contract. Mutates + returns the freshly-built candidate. */
const markEntity = <T extends ChatContactCandidate | ChatContactRecord | ChatDealCandidate | ChatAccountCandidate>(
  candidate: T,
  entity_id: 'contact' | 'deal' | 'account',
): T => {
  (candidate as unknown as Record<string, unknown>)[PII_ENTITY_MARKER_KEY] = entity_id;
  return candidate;
};

/** D-137 P2 — project local `ContactRecord` into the unified
 *  `ChatContactCandidate` shape. Preserves the email / name /
 *  lifecycle / recency fields the agent reasons over; richer local-
 *  only fields (`platform_ids`, `network_domain`, …) stay accessible
 *  through `data.contact.<email>` follow-up reads. */
const projectLocalContact = (
  row: Record<string, unknown>,
): ChatContactCandidate => {
  const email = typeof row['email'] === 'string' ? row['email'] : null;
  const candidate: ChatContactCandidate = {
    email,
    target_id: email ?? (typeof row['_id'] === 'string' ? row['_id'] : ''),
  };
  if (isString(row['name'])) candidate.name = row['name'];
  if (isString(row['identity_status'])) candidate.lifecycle_stage = row['identity_status'];
  if (isNumber(row['last_interaction'])) candidate.recent_activity_at = row['last_interaction'];
  if (isString(row['phone'])) candidate.phone = row['phone'];
  if (isString(row['company'])) candidate.company = row['company'];
  return markEntity(candidate, 'contact');
};

/** D-137 P2 — project a platform-reference enrichment meta snapshot
 *  into the unified `ChatContactCandidate` shape. HubSpot + Salesforce
 *  meta fields converge on `email` / `name` / `lifecycle_stage` /
 *  `recent_activity_at` per `CONNECTION_VENDOR_ENTITIES`; the projection
 *  reads those keys defensively (meta is open-vocabulary). */
const projectPlatformContact = (
  target_id: string,
  meta: Record<string, unknown>,
): ChatContactCandidate => {
  const email = isString(meta['email']) ? meta['email'] : null;
  const candidate: ChatContactCandidate = { email, target_id };
  if (isString(meta['name'])) candidate.name = meta['name'];
  if (isString(meta['lifecycle_stage'])) candidate.lifecycle_stage = meta['lifecycle_stage'];
  if (isNumber(meta['recent_activity_at'])) candidate.recent_activity_at = meta['recent_activity_at'];
  // The canonical keys every contact reconciler writes (`CRM_RECALL_SEED_FIELDS`).
  if (isString(meta['phone'])) candidate.phone = meta['phone'];
  if (isString(meta['company'])) candidate.company = meta['company'];
  return markEntity(candidate, 'contact');
};

/** D-137 P3 § A.5 Codex P1 fold #3 — synthesise a per-candidate
 *  confidence score from the source's filter shape. Without scores,
 *  every result passes through the classifier as Pattern 3 (refuse +
 *  show), which makes even a single exact-email lookup look
 *  ambiguous to the agent. Two filter intents drive the score
 *  ladder:
 *
 *    - `'exact'` (caller filtered by `email`) — primary key lookup;
 *      the source returned the row that exactly matches the
 *      requested identifier. Score `1.0` → top is high → Pattern 1
 *      (silent execute) when there's a single match, Pattern 2 when
 *      multiple sources independently returned the same identifier.
 *    - `'fuzzy'` (caller filtered by `query` substring) — substring
 *      match doesn't carry intent strength. Score `0.75` (above
 *      `CONFIDENCE_DOMINANT_SCORE` so single-result fuzzy still
 *      collapses to Pattern 1 — "I think you mean Peter"; multi-
 *      result fuzzy with identical scores collapses to Pattern 2 —
 *      "I'm guessing Peter A; other Peters: B, C").
 *    - `'list'` (no filter — bare listing) — score `0.6` (below
 *      `CONFIDENCE_DOMINANT_SCORE`; surfaces as Pattern 3 — refuse
 *      + show — which is the correct UX for "what contacts do I
 *      have?" intent).
 *
 *  The numeric values stay synced with `confidence-shape/classify.ts`
 *  threshold constants by inspection; future telemetry-driven
 *  retuning may calibrate per-source signals more precisely. */
const SOURCE_SCORE_EXACT = 1.0;
const SOURCE_SCORE_FUZZY = 0.75;
const SOURCE_SCORE_LIST = 0.6;

type ContactLookupKind = 'exact' | 'fuzzy' | 'list';
const lookupKindForArgs = (args: ScopeSearchArgs): ContactLookupKind => {
  // Identifier lookups (email / phone / platform_id alias) are exact
  // primary-key hits; plain chat alias + free-text query are fuzzy;
  // bare listing scores below the dominant threshold per § A.5.
  if (args.email || args.phone || args.domain || (args.alias && args.platform)) return 'exact';
  if (args.alias || args.query || args.company) return 'fuzzy';
  return 'list';
};
const scoreForLookupKind = (kind: ContactLookupKind): number =>
  kind === 'exact'
    ? SOURCE_SCORE_EXACT
    : kind === 'fuzzy'
      ? SOURCE_SCORE_FUZZY
      : SOURCE_SCORE_LIST;

/** D-137 P2 § A.4 — local source for contact fan-out. Reuses the P1
 *  query path (`ContactStore.list` / `.get`) but projects results into
 *  the unified candidate shape. Always enabled (the `'local'` source
 *  is never toggleable per `INSTANCE_PREFS` design — gating it would
 *  surface an empty tool). Throws propagate to the runner as
 *  `partial_failures` so a corrupt warehouse doesn't crash the fan-out. */
const buildLocalContactSource = (
  deps: ChatToolHandlerDeps,
  ctx: ChatDispatchContext,
): ScopeSearchSource<ScopeSearchArgs, ChatContactCandidate> => ({
  id: 'local',
  query: async (args) => {
    // D-205 #3 — the `data.contact` read fence on the CORE graph. Fences the LOCAL
    // source only: the vendor MIRROR + the outbound live escalation are a different
    // authorization axis (the connection's own grant — `admitSourceCatalogEscalation`
    // already judges the escalation per connection), and collapsing the two would deny
    // a door its granted CRM lens because it lacks the core-graph grant.
    //
    // THROWS rather than skipping. The fan-out turns a throw into a NAMED
    // `partial_failure` (+ `partial: true`); `isEnabled: false` would skip SILENTLY. A
    // protection decision has to be visible — an unexplained empty reads as "this person
    // does not exist", a false negative the model will report to the user as fact. And it
    // must never become `ok:false`: the Tier-1 ANTI-LOOP invariant (see
    // `createMemorySearchHandler`) is that an ungranted read is a guided EMPTY, because an
    // errored read sends a reasoning model into a retry-to-timeout loop.
    if (!isCollectionReadGrantedForDispatch(deps, ctx, 'contact')) {
      throw new Error(
        'the local contact graph is not read-granted to this contract (data.contact)',
      );
    }
    const store = deps.getContactStore();
    if (!store) throw new Error('contact store unavailable');
    const score = scoreForLookupKind(lookupKindForArgs(args));
    if (args.email) {
      const row = store.get(args.email);
      if (!row) return [];
      return [{
        record: projectLocalContact(row as unknown as Record<string, unknown>),
        score,
      }];
    }
    if (args.phone) {
      const result = store.findByPhone(args.phone);
      if (result.contact) {
        return [{
          record: projectLocalContact(result.contact as unknown as Record<string, unknown>),
          score,
        }];
      }
      // Multiple non-tombstoned contacts share the phone (transitional
      // pre-D-138-merge state) — surface as fuzzy-scored alternatives
      // so the orchestrator doesn't collapse the ambiguous result to
      // Pattern 1 silent-execute.
      const altScore = SOURCE_SCORE_FUZZY;
      return result.alternatives
        .slice(0, args.limit)
        .map((alt) => ({
          record: projectLocalContact(alt as unknown as Record<string, unknown>),
          score: altScore,
        }));
    }
    if (args.alias) {
      const result = store.findByAlias({
        alias_pattern: args.alias,
        ...(args.platform !== undefined ? { platform: args.platform } : {}),
      });
      // Single resolved match → one candidate at the lookup-kind score.
      if (result.contact) {
        return [{
          record: projectLocalContact(result.contact as unknown as Record<string, unknown>),
          score,
        }];
      }
      // Ambiguous chat_alias → surface alternatives so the agent can
      // present a disambiguation prompt. Drop the score to the fuzzy
      // tier — the orchestrator's confidence-shape dispatch reads each
      // candidate's score; an exact-tier marker on ambiguous results
      // would mis-classify multi-candidate output as Pattern 1.
      const altScore = SOURCE_SCORE_FUZZY;
      return result.alternatives
        .slice(0, args.limit)
        .map((alt) => ({
          record: projectLocalContact(alt as unknown as Record<string, unknown>),
          score: altScore,
        }));
    }
    // D-167 B3 — org-scoped contact search. The chat boundary routes an aliased
    // `pii.Org` here from `query`; a raw org name lands here directly. Exclusive
    // branch (like name/email/phone) — when both `query` and `company` are set
    // the boundary has already cleared the one it moved, so only one fires.
    if (args.company) {
      const rows = store.list({ company_contains: args.company, limit: args.limit });
      return rows.map((r) => ({
        record: projectLocalContact(r as unknown as Record<string, unknown>),
        score,
      }));
    }
    const rows = store.list({
      ...(args.query ? { name_contains: args.query } : {}),
      limit: args.limit,
    });
    return rows.map((r) => ({
      record: projectLocalContact(r as unknown as Record<string, unknown>),
      score,
    }));
  },
});

/** D-137 P2 § A.4 — platform-mirror contact source factory. D-190 — GENERIC over
 *  vendor (`source_id` = any bound CRM vendor, `scope` its `connection.api.<vendor>
 *  .contact` mirror scope) AND reads the dedicated CRM record mirror (the generic
 *  reconciler MS3 repoint), NOT the producer-gated enrichment store — so EVERY
 *  contact surfaces, not just AI-enriched ones. Skips silently when the mirror
 *  isn't wired (dbless harness / pre-wire). Errors from the store surface as
 *  `partial_failure` entries via the runner. */
const buildPlatformContactSource = (
  deps: ChatToolHandlerDeps,
  source_id: string,
  scope: EnrichmentScope,
): ScopeSearchSource<ScopeSearchArgs, ChatContactCandidate> => ({
  id: source_id,
  query: async (args) => {
    const store = deps.getCrmRecordMirror?.();
    if (!store) return [];
    // Platform mirrors carry email + name on the meta snapshot today;
    // phone / alias aren't reconciled across vendors yet (D-128 platform-
    // reference substrate doesn't materialize a normalized phone column).
    // When the caller asks by phone / alias only, the right answer from
    // the platform source is "no match"; returning the full list would
    // be noise. The local source handles phone / alias on its own.
    if (!args.email && !args.query) return [];
    const score = scoreForLookupKind(lookupKindForArgs(args));
    const rows = store.list(scope, {
      ...(args.query ? { name_contains: args.query } : {}),
      ...(args.email ? { email_exact: args.email } : {}),
      limit: args.limit,
    });
    return rows.map((r) => ({
      record: projectPlatformContact(
        r.target_id,
        r.meta as unknown as Record<string, unknown>,
      ),
      score,
    }));
  },
});

/** How many contacts each candidate lookup of the name spelling check reads,
 *  and how many close names the hint offers. */
const CONTACT_SPELLING_CANDIDATES = 300;
const CONTACT_SPELLING_NAMES = 3;

/** The names on file a name lookup that found no one comes close to.
 *
 *  ⛔ FULL NAMES, NEVER A WORD OF ONE. The chat's privacy layer swaps the names
 *  on file for placeholders in everything the model reads, matching WHOLE names;
 *  a surname lifted out of one could slip through as the real word. A full name
 *  is swapped like any other, and a placeholder the model then searches with is
 *  turned back into the name before the search runs (`restoreChatAiResult`).
 *
 *  ⛔ ASKED OF THE SAME SOURCES, NEVER THE LIVE CRM. Absence is "this word alone
 *  finds no one" in the local graph and the bound CRM mirrors — the fan-out's
 *  own sources, behind their own read fences — and candidates are those sources'
 *  answers for the word's first and last three letters (a name lookup is a
 *  substring match). The live escalation is a vendor call made on the owner's
 *  credentials; a spelling hint must not spend one.
 *
 *  ⛔ FAILS CLOSED: a source that failed (fenced, unreachable) may hold the name,
 *  so a partial read anywhere means no hint. */
const contactNameRespellings = async (
  query: string,
  sources: ReadonlyArray<ScopeSearchSource<ScopeSearchArgs, ChatContactCandidate>>,
): Promise<{ typed: string[]; names: string[] } | undefined> => {
  const lookup = (needle: string, limit: number) => runScopeSearchFanout({ query: needle, limit }, sources);
  const typed: string[] = [];
  const close = new Map<string, { name: string; distance: number }>();
  // A name's words, split as the names on file are below ("O'Brian", "Smith-Jnes");
  // a part holding a digit or an "@" is a number or an address, not a name.
  const words = query.split(/\s+/u)
    .filter((part) => !/[\p{N}@]/u.test(part))
    .flatMap((part) => part.split(/[^\p{L}\p{M}]+/u));
  const seen = new Set<string>();
  for (const word of words) {
    const term = word.toLowerCase();
    const max = spellingMaxDistance([...term].length);
    if (max === 0 || seen.has(term) || FTS_STOPWORDS.has(term)) continue;
    seen.add(term);
    const alone = await lookup(term, 1);
    if (alone.partial === true) return undefined;
    if (alone.candidates.length > 0) continue;
    typed.push(word);
    for (const needle of new Set([term.slice(0, 3), term.slice(-3)])) {
      const near = await lookup(needle, CONTACT_SPELLING_CANDIDATES);
      if (near.partial === true) return undefined;
      for (const candidate of near.candidates) {
        const name = candidate.record.name?.trim();
        if (name === undefined || name.length === 0) continue;
        let distance = max + 1;
        for (const token of name.split(/[^\p{L}\p{M}]+/u)) {
          if (token.length > 0) distance = Math.min(distance, boundedEditDistance(term, token.toLowerCase(), max));
        }
        // 0 would mean the name holds the word, which the lookup just denied.
        if (distance === 0 || distance > max) continue;
        const key = name.toLowerCase();
        const prior = close.get(key);
        if (prior === undefined || distance < prior.distance) close.set(key, { name, distance });
      }
    }
  }
  if (typed.length === 0 || close.size === 0) return undefined;
  const names = [...close.values()]
    .sort((a, b) => (a.distance - b.distance) || a.name.localeCompare(b.name))
    .slice(0, CONTACT_SPELLING_NAMES)
    .map((c) => c.name);
  return { typed, names };
};

/** ⚠ Model-facing. A name on file reaches the model as a placeholder
 *  (`pii.PersonN`), so it cannot judge the spelling itself: the hint says the
 *  search already did, and names the reading the answer begins with. Measured:
 *  "If that is who the owner meant" left that judgement to a model that could not
 *  make it, and it asked the owner to respell instead. Several close names are
 *  the owner's to choose between. */
const contactSpellingHint = (r: { typed: string[]; names: string[] }): string => {
  const quoted = (xs: readonly string[]): string => xs.length < 2
    ? `"${xs[0] ?? ''}"`
    : `${xs.slice(0, -1).map((x) => `"${x}"`).join(', ')} or "${xs.at(-1) ?? ''}"`;
  const typed = quoted(r.typed);
  const names = r.names.map((n) => `"${n}"`);
  const judged = 'Names can reach you as placeholders, so do not judge the spelling yourself: this search '
    + 'already compared them.';
  if (names.length === 1) {
    return `No contact's name holds ${typed}, but one contact's name is a close spelling of it: ${names[0]}. `
      + `${judged} Search again with the query ${names[0]}, then answer from that contact, beginning by `
      + `telling the owner you read ${typed} as ${names[0]}: it may be a different person.`;
  }
  return `No contact's name holds ${typed}, but these contacts' names are close spellings of it: `
    + `${names.join(', ')}. ${judged} Ask the owner which of them they meant, naming each.`;
};

const createContactSearchHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => {
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');
    const limit = clampLimit(args.limit);
    const email = typeof args.email === 'string' && args.email.length ? args.email : undefined;
    const query = typeof args.query === 'string' && args.query.length ? args.query : undefined;
    const phone = typeof args.phone === 'string' && args.phone.length ? args.phone : undefined;
    // D-167 B3 — org-scoped contact search (the chat boundary routes an aliased
    // `pii.Org` here; a raw org name lands here directly). MUST be threaded into
    // the fan-out args or the local source's company branch is unreachable.
    const company = typeof args.company === 'string' && args.company.length ? args.company : undefined;
    const alias = typeof args.alias === 'string' && args.alias.length ? args.alias : undefined;
    const rawPlatform = typeof args.platform === 'string' ? args.platform : undefined;
    if (rawPlatform !== undefined && !isContactAliasPlatform(rawPlatform)) {
      return invalidArgs(`platform '${rawPlatform}' is not a supported contact alias platform`);
    }
    const platform: ContactAliasPlatform | undefined = rawPlatform;
    const fanoutArgs: ScopeSearchArgs = {
      limit,
      ...(email ? { email } : {}),
      ...(query ? { query } : {}),
      ...(phone ? { phone } : {}),
      ...(company ? { company } : {}),
      ...(alias ? { alias } : {}),
      ...(platform ? { platform } : {}),
    };
    // D-190 — GENERIC cross-vendor fan-out (parity with deal.search): the local
    // `data.contact` source + one mirror source per BOUND CRM connection whose
    // vendor declares a `crm_alias: 'contact'` entity (built-in hb/sf OR a
    // pack-declared CRM), enumerated at dispatch from the live vendor registry — no
    // hardcoded vendor list. A user with no bound CRM still gets the local source.
    const platformSources = (deps.getBoundCrmMirrorSources?.('contact') ?? []).map((s) =>
      buildPlatformContactSource(deps, s.source_id, s.scope),
    );
    const sources: ReadonlyArray<
      ScopeSearchSource<ScopeSearchArgs, ChatContactCandidate>
    > = [buildLocalContactSource(deps, ctx), ...platformSources];
    try {
      const result = await runScopeSearchFanout(fanoutArgs, sources);
      // S3 — live-escalate stale / narrow-miss CRM connections (the local data.contact
      // source's email-keyed candidates are never matched by a connection prefix, so
      // they're preserved). narrow = a name/email lookup (what the mirror filters on).
      const freshness = deps.getCrmConnectionFreshness?.('contact') ?? [];
      const escalated = await applyCrmLiveEscalation(deps, ctx, result, freshness, {
        narrowLookup: query !== undefined || email !== undefined,
        now: Date.now(),
        score: scoreForLookupKind(lookupKindForArgs(fanoutArgs)),
        project: projectPlatformContact,
        matches: (m) => matchesContact(m, { query, email }),
      });
      const clamped = clampScopeSearchResult({ ...result, candidates: escalated.candidates }, limit);
      const augmented = augmentWithConfidenceShape(clamped, recencyKeyForContact);
      // A NAME lookup that found no one, anywhere, with every source answering:
      // the closest names on file (`contactNameRespellings`).
      const respelled = query !== undefined && email === undefined && phone === undefined
        && company === undefined && alias === undefined
        && clamped.candidates.length === 0 && result.partial !== true
        ? await contactNameRespellings(query, sources)
        : undefined;
      return {
        ok: true,
        result: {
          ...augmented,
          crm_freshness: escalated.crm_freshness,
          ...(respelled !== undefined ? { hint: contactSpellingHint(respelled) } : {}),
        },
      };
    } catch (e) {
      return executionError(errMessage(e));
    }
  };

// ────────────────────────────────────────────────────────────────
// contact.read — one address-book contact's full record
// ────────────────────────────────────────────────────────────────

/** The provenance map's key (a contribution KIND) → the `ChatContactRecord` field it
 *  fills. Two differ (`org` → company, `address` → mailing_address), which is why
 *  it is a table (`CONTACT_MATCH_FIELD_CONTRIBUTION_KIND` records the same lesson).
 *  `photo` is never read by an agent. */
const CONTACT_READ_SOURCE_FIELDS: Readonly<Record<string, keyof ChatContactRecord>> = {
  name: 'name', org: 'company', title: 'title', address: 'mailing_address', birthday: 'birthday', phone: 'phone',
};

/** ⚠ Model-facing — each provenance rung in words, so a guessed company reads as a
 *  guess. */
const CONTACT_SOURCE_WORDS: Readonly<Record<ContactContributionSource, string>> = {
  manual: 'typed by the owner',
  user_confirmed: 'confirmed by the owner',
  vendor_meta: 'a CRM',
  contact_book: "the owner's contact book",
  derived: 'mail or calendar',
  ai_inferred: 'an AI guess',
  domain_inferred: 'a guess from the email domain',
};

const isoFromMs = (ms: unknown): string | undefined =>
  isNumber(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;

/** One address-book contact as an agent reads it: `contact.get`'s record, less
 *  what `ChatContactRecord` says an agent must not see. */
const projectContactRecord = (row: ContactRecord): ChatContactRecord => {
  const record: ChatContactRecord = {
    target_id: row.email,
    email: isMentionOnlyEmail(row.email) ? null : row.email,
  };
  if (isString(row.name)) record.name = row.name;
  if (isString(row.phone)) record.phone = row.phone;
  if (isString(row.company)) record.company = row.company;
  if (isString(row.title)) record.title = row.title;
  if (isString(row.birthday)) record.birthday = row.birthday;
  if (isString(row.anniversary)) record.anniversary = row.anniversary;
  if (row.relationship !== undefined) record.relationship = row.relationship;
  if (row.mailing_address !== undefined) record.mailing_address = row.mailing_address;
  if (row.privacy_marks !== undefined && row.privacy_marks.length > 0) record.privacy_marks = row.privacy_marks;
  if (isString(row.identity_status)) record.lifecycle_stage = row.identity_status;
  const firstSeen = isoFromMs(row.first_seen);
  if (firstSeen !== undefined) record.first_seen_at = firstSeen;
  const lastInteraction = isoFromMs(row.last_interaction);
  if (lastInteraction !== undefined) record.last_interaction_at = lastInteraction;
  if (isNumber(row.interaction_count)) record.interaction_count = row.interaction_count;
  const sources: Record<string, string> = {};
  for (const [kind, field] of Object.entries(CONTACT_READ_SOURCE_FIELDS)) {
    const source = row.projection_provenance?.[kind]?.source;
    // Only for a value the record shows: the source of an absent value explains nothing.
    if (source !== undefined && record[field] !== undefined) sources[field] = CONTACT_SOURCE_WORDS[source] ?? source;
  }
  if (Object.keys(sources).length > 0) record.sources = sources;
  return markEntity(record, 'contact');
};

/** ⚠ Model-facing — what the catalog description leaves out to stay small, said only
 *  when this record has it. */
const contactReadNotes = (record: ChatContactRecord): string | undefined => {
  const notes: string[] = [];
  if (record.privacy_marks !== undefined) {
    const marks = record.privacy_marks.map((mark) => mark.replace('_', ' ')).join(' and ');
    notes.push(`The owner marked this contact ${marks}: do not suggest reaching out unless the owner asks.`);
  }
  if (record.birthday?.startsWith('--') === true || record.anniversary?.startsWith('--') === true) {
    notes.push('A date written --MM-DD has no known year.');
  }
  return notes.length > 0 ? notes.join(' ') : undefined;
};

/** ⚠ Model-facing. */
const CONTACT_READ_NOT_FOUND = 'No contact in the owner\'s address book has this target_id. A CRM '
  + 'record\'s target_id (it starts with the CRM\'s name) is not in the address book: its details come '
  + 'from that CRM\'s own tools. Otherwise pass the `target_id` of a contact.search candidate.';

/** ⛔ The ADDRESS BOOK ONLY, so the table's `data.contact` fence covers all of it: a
 *  CRM record is never read here, and never resolved to the owner's contact through
 *  its link (D-205 keeps that edge moot by never projecting it). */
const createContactReadHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw) => {
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');
    const targetId = typeof args.target_id === 'string' ? args.target_id.trim() : '';
    if (targetId.length === 0) return invalidArgs('target_id is required');
    // A read that could not run is not one that found nothing (`withExplicitEmpty`).
    const failed = (reason: string): ChatDispatchResult => ({
      ok: true,
      result: { contacts: [], partial: true, partial_failures: [{ source: 'local', reason }] },
    });
    const store = deps.getContactStore();
    if (!store) return failed('contact store unavailable');
    try {
      // An email reads the survivor of any merge; anything else may be a contact id,
      // which `contact.get` reads too.
      let row: ContactRecord | null;
      if (targetId.includes('@')) {
        let canonical = targetId;
        try { canonical = store.resolveCanonicalEmail(targetId).canonical_email; } catch { /* a broken chain: read the row itself */ }
        row = store.get(canonical);
      } else {
        row = store.getByContactIdResolved(targetId);
      }
      if (row === null) return { ok: true, result: { contacts: [], hint: CONTACT_READ_NOT_FOUND } };
      const record = projectContactRecord(row);
      const notes = contactReadNotes(record);
      return { ok: true, result: { contacts: [record], ...(notes !== undefined ? { hint: notes } : {}) } };
    } catch (e) {
      return failed(errMessage(e));
    }
  };

// ────────────────────────────────────────────────────────────────
// mail.search — generic Collection fan-out
// ────────────────────────────────────────────────────────────────

/** ⚠ `collectionReadFenced` LIVED HERE AND IS GONE. It built the fenced result for the
 *  three handlers that each called the fence by hand; `wrapCollectionFence` now does it
 *  at the table, from the tool's own `entity` + `FENCED_EMPTY_CONTAINER`, so nothing
 *  called this any more. TypeScript does not flag an unused module const, so it sat
 *  green — the same shape as the fence it replaced. `collectionReadFencedHint` survives
 *  and is the live copy. */

/** D-INDEX — did a fan-out FILL its quota, i.e. is the caller seeing a SLICE?
 *
 *  ⛔⛔ SILENCE ABOUT TRUNCATION IS WORSE THAN THE TRUNCATION. A model handed 20
 *  of 1,616 matches with no marker reports a complete-looking answer from a
 *  slice it has no reason to doubt — and it cannot know to narrow the query,
 *  because nothing told it there was anything to narrow. "Nothing here" and "I
 *  could not see everything" look identical to the consumer.
 *
 *  ⚠ `recall.search` has carried this vocabulary from the start (`partial`,
 *  `more_matches`, `exhausted`); the collection surfaces sliced silently. This
 *  brings them into line rather than inventing a new idea.
 *
 *  Approximate BY DESIGN: a store that returned exactly its quota probably has
 *  more, and one that returned fewer certainly does not. Counting the true total
 *  would mean a second unbounded query per store per turn — the cost the limit
 *  exists to avoid. False "there may be more" is cheap; false "that is all" is
 *  the failure being fixed. */
const filledQuota = (returned: number, quota: number): boolean => returned >= quota;

/** What a mail or calendar search did with words no record holds, and the
 *  closest word on file for each — the hint a `mail.search` / `calendar.search`
 *  result carries.
 *
 *  ⛔⛔ THESE SEARCHES RARELY COME BACK EMPTY, WHICH IS WHY THEY NEED THIS MORE
 *  THAN `work.search` DOES. On a miss a store retries over only the words its
 *  index holds (`relaxToPresentPrefixTokens`), so "Castelanos invoice" quietly
 *  becomes "invoice" and returns every invoice, from every sender, looking like
 *  an answer. No row says the name was dropped; this does, and names the
 *  spelling on file when one is close enough (`checkQuerySpelling`). Without a
 *  close word it still says the rows are not about the dropped word — an invoice
 *  from a stranger must not be answered with someone else's.
 *
 *  🔑 SAFE TO SUGGEST FROM THESE INDEXES. A caller reaches the handler only past
 *  the collection read fence (`wrapCollectionFence`) and never sphere-limited
 *  (`wrapSphereFence` refuses those outright), and the handler reads every row of
 *  every store it searches, so a word in their index is one this caller could
 *  have searched for itself.
 *
 *  ⛔ FAILS CLOSED. A store that cannot check its words, or throws trying, ends
 *  it: it may hold the word, and "no email holds X" would then be false.
 *
 *  ⚠ No rows and nothing close: undefined, so the explicit empty says it
 *  (`withExplicitEmpty`). ⚠ Model-facing — `chat-prompt-optimization-log.md`. */
const collectionSearchSpellingHint = (
  stores: ReadonlyArray<Pick<Collection, 'checkSpelling'>>,
  query: string,
  noun: { one: string; many: string },
  returnedRows: boolean,
): string | undefined => {
  const checks: FtsWordCheck[][] = [];
  for (const store of stores) {
    if (store.checkSpelling === undefined) return undefined;
    try {
      checks.push(store.checkSpelling(query));
    } catch {
      return undefined;
    }
  }
  const absent = absentFromAll(checks);
  if (absent.length === 0) return undefined;
  const corrections = mergeSpellingChecks(checks);
  if (!returnedRows && corrections.length === 0) return undefined;
  const quoted = (words: readonly string[]): string => words.length < 2
    ? `"${words[0] ?? ''}"`
    : `${words.slice(0, -1).map((w) => `"${w}"`).join(', ')} or "${words.at(-1) ?? ''}"`;
  const parts = [returnedRows
    ? `No ${noun.one} holds ${quoted(absent)}, so the results below match only the other words in the query.`
    : `No ${noun.one} holds ${quoted(absent)}.`];
  if (returnedRows && corrections.length === 0) {
    parts.push(`Do not answer as if they were about ${quoted(absent)}.`);
  }
  for (const c of corrections) {
    parts.push(`"${c.word}" is in ${c.records} ${c.records === 1 ? noun.one : noun.many}.`);
  }
  const [only] = corrections;
  if (corrections.length === 1 && only !== undefined) {
    parts.push(`If that is who or what the owner meant, search again for "${only.word}", and begin `
      + `your answer by telling the owner you read "${only.typed}" as "${only.word}": it may be a `
      + 'different name.');
  } else if (corrections.length > 1) {
    parts.push('If those are who or what the owner meant, search again with them, and begin your '
      + 'answer by telling the owner how you read their words: they may be different names.');
  }
  return parts.join(' ');
};

/** Each mailbox a `mail.search` result covers, by the `collection_slug` its
 *  matches carry, with the address it signed in as and its provider.
 *
 *  ⛔ A slug is whatever the mailbox was connected under, and the owner says "my
 *  Outlook" or an address: with slugs alone the model can only guess which
 *  mailbox they mean (owner, 2026-10-18: the model should see the address too,
 *  because the name does not always match how the owner refers to a mailbox). */
const mailboxAddresses = (collections: readonly Collection[]) =>
  collections.map((c) => ({ collection_slug: c.slug, ...mailboxAddressOf(c) }));

const createMailSearchHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => {
    // D-205 #3 — the `data.mail` read fence, BEFORE the registry is touched. Same hole
    // `contact.search` had, and `mail` is the more sensitive collection.
    const registry = deps.getCollectionRegistry();
    if (!registry) return executionError('collection registry unavailable');
    // Each searched mailbox's verdict. An SMTP-only account is searched (its sent
    // copies) but mirrors no mailbox, so it has none (`isMirroredCollection`).
    const mailFreshness = (searched: readonly Collection[]) =>
      collectionSourceFreshnessFanOut(searched.filter(isMirroredCollection), (deps.now ?? Date.now)());
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');
    const limit = clampLimit(args.limit);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const since = typeof args.since === 'number' ? args.since : undefined;
    const until = typeof args.until === 'number' ? args.until : undefined;
    const filters =
      args.filters && typeof args.filters === 'object' && !Array.isArray(args.filters)
        ? (args.filters as Record<string, unknown>)
        : undefined;
    // `near_id` + `next`/`prev`: step outward from a matched message.
    const nearId = typeof args.near_id === 'string' && args.near_id.length
      ? args.near_id : undefined;
    const nextN = typeof args.next === 'number' && args.next > 0
      ? Math.min(10, Math.floor(args.next)) : 0;
    const prevN = typeof args.prev === 'number' && args.prev > 0
      ? Math.min(10, Math.floor(args.prev)) : 0;
    // One mailbox, when named. Record ids are only unique within a mailbox.
    const slug = typeof args.slug === 'string' && args.slug.length ? args.slug : undefined;
    const enrolled = registry.list().filter((c) => c.platform === 'mail');
    if (enrolled.length === 0) {
      // D-237 P1 — no mailbox is enrolled. `collections: []` is the fact, and
      // `source_freshness: []` must not be read as "the sources are fine": the
      // two empties answer different questions and the descriptor says so.
      return { ok: true, result: { matches: [], collections: [], source_freshness: [] } };
    }
    const collections = slug === undefined ? enrolled : enrolled.filter((c) => c.slug === slug);
    if (collections.length === 0) {
      // Named, not emptied: `collections: []` would claim no mailbox is enrolled.
      return {
        ok: true,
        result: {
          matches: [],
          more_matches: false,
          collections: enrolled.map((c) => c.slug),
          mailbox_addresses: mailboxAddresses(enrolled),
          mailbox_not_found: slug,
          note: `No enrolled mailbox has slug ${JSON.stringify(slug)}. Use a collection_slug returned by an earlier search.`,
          source_freshness: mailFreshness(enrolled),
        },
      };
    }
    try {
      // FTS5 path when the agent supplied a free-text query. Hot-field
      // path otherwise — `since` / `until` / `filters` still surface
      // even when query is empty. Per-collection limit divides the
      // budget so a single mailbox can't starve the others.
      const perCollectionLimit = Math.max(
        1,
        Math.ceil(limit / collections.length),
      );
      const aggregated: Array<Record<string, unknown>> = [];
      // Set when any store returned a full quota — see `filledQuota`.
      let moreAvailable = false;
      if (nearId !== undefined && (nextN > 0 || prevN > 0)) {
        // ── RELATIVE NAVIGATION ────────────────────────────────────────────
        // Walk outward from a message that DID match. A conversational answer
        // repeats none of the question's vocabulary, so no query reaches it —
        // only stepping to the next message can. DIRECTION is what makes it
        // cheap: the reply is AFTER, the context BEFORE, so the caller asks for
        // one side instead of paying for a whole thread.
        // ⛔⛔ AN UNRESOLVABLE ANCHOR MUST NOT ANSWER WITH AN EMPTY PAGE.
        // `neighbours()` returns [] both for "the anchor exists and has no
        // neighbour on that side" and for "no such record", so without this
        // check the two are ONE observation and the caller cannot tell a real
        // edge from an id it made up. Measured, that is not hypothetical: a
        // live model composed six `near_id` values it had never read
        // (`mail:pobm0001pob` …, pattern-matched off the corpus's id scheme)
        // and every one came back `ok: true, matches: []` — refusing by
        // SUCCEEDING, which reads as "the thread ends here" and is the one
        // answer that invites no correction.
        //
        // Stays `ok: true`: a Tier-1 read reports absence in the BODY, never by
        // failing, because `ok` is the anti-loop signal and an `ok: false` here
        // re-opens the agent retry loop over a caller error that retrying
        // cannot fix.
        const anchored = collections.filter((c) => {
          try {
            return c.get(nearId) !== null;
          } catch {
            return false;
          }
        });
        if (anchored.length === 0) {
          return {
            ok: true,
            result: {
              matches: [],
              more_matches: false,
              collections: collections.map((c) => c.slug),
              mailbox_addresses: mailboxAddresses(collections),
              anchor_not_found: nearId,
              note:
                `No message with record_id ${JSON.stringify(nearId)} exists in `
                + `${slug === undefined ? 'the enrolled mailboxes' : `mailbox ${JSON.stringify(slug)}`}, so there is nothing to step from. `
                + `Pass a record_id returned by an earlier search — ids cannot `
                + `be constructed or guessed.`,
              source_freshness: mailFreshness(collections),
            },
          };
        }
        // Two mailboxes can hold different messages under one record_id (an
        // IMAP `uid@folder` repeats across accounts). Walking both would mix
        // two conversations, so an unscoped anchor must be unique.
        if (anchored.length > 1) {
          return {
            ok: true,
            result: {
              matches: [],
              more_matches: false,
              collections: collections.map((c) => c.slug),
              mailbox_addresses: mailboxAddresses(collections),
              anchor_ambiguous: nearId,
              mailboxes: anchored.map((c) => c.slug),
              note:
                `record_id ${JSON.stringify(nearId)} exists in more than one mailbox, so its `
                + `neighbours would mix different messages. Pass slug with near_id: the `
                + `collection_slug of the result you are stepping from.`,
              source_freshness: mailFreshness(collections),
            },
          };
        }
        for (const c of anchored) {
          const near = (c as unknown as {
            neighbours?: (q: { anchor_id: string; next?: number; prev?: number }) => Array<{
              record_id: string; hot_fields: Record<string, unknown>;
              body_inline?: string; received_at: number;
            }>;
          }).neighbours;
          if (typeof near !== 'function') continue;
          // One direction at a time, asking for one message more than wanted:
          // only a message beyond the page means more context remains there.
          const side = (q: { next: number } | { prev: number }, wanted: number) => {
            if (wanted <= 0) return [];
            const rows = near.call(c, { anchor_id: nearId, ...q });
            if (rows.length > wanted) moreAvailable = true;
            return rows.slice(0, wanted);
          };
          const neighbours = [...side({ next: nextN + 1 }, nextN), ...side({ prev: prevN + 1 }, prevN)];
          for (const r of neighbours) {
            aggregated.push({
              collection_slug: c.slug,
              record_id: r.record_id,
              hot_fields: r.hot_fields,
              received_at: r.received_at,
              ...mailEvidenceMetadata(c.slug, r.record_id, r.received_at, ctx?.time_zone),
              ...(typeof r.body_inline === 'string' && r.body_inline.length > 0
                ? { preview: r.body_inline.slice(0, LIST_PREVIEW_CHARS) }
                : {}),
            });
          }
        }
        return {
          ok: true,
          result: {
            matches: aggregated.slice(0, limit),
            more_matches: moreAvailable || aggregated.length > limit,
            collections: collections.map((c) => c.slug),
            mailbox_addresses: mailboxAddresses(collections),
            source_freshness: mailFreshness(collections),
          },
        };
      }
      for (const c of collections) {
        if (query) {
          const matches = c.search({
            platform: c.platform,
            slug: c.slug,
            query,
            limit: perCollectionLimit,
          });
          if (filledQuota(matches.length, perCollectionLimit)) moreAvailable = true;
          for (const m of matches) {
            aggregated.push({
              collection_slug: c.slug,
              record_id: m.record_id,
              hot_fields: m.hot_fields,
              // ⛔ The DATE must reach the model. Search returns RELEVANCE order,
              // so without this a retrieved conversation cannot be re-sorted and
              // the reader cannot tell a refusal from the acceptance that
              // followed it. The list path carried this all along.
              ...(typeof m.received_at === 'number' ? { received_at: m.received_at } : {}),
              ...mailEvidenceMetadata(c.slug, m.record_id, m.received_at, ctx?.time_zone),
              rank: m.rank,
              // ⛔⛔ THE BODY MUST SURVIVE THIS PROJECTION, and it is the reason
              // the row is worth anything. `snippet` is a window centred on the
              // match terms; hydrated `body` is the record. Dropped here, the
              // model is back to computing from a fragment — bench 276 reached
              // the right mail 11/11 and answered 0/11 that way, because the
              // window stopped one token before the rates the sum needed. There
              // is also a `mail.read` for exact/full reads, but retaining this
              // text avoids forcing another tool call for each search match.
              ...(typeof m.body === 'string' ? { body: m.body } : {}),
              ...(m.body_truncated ? { body_truncated: true } : {}),
              // ⛔ The label MUST survive this projection. Dropped here, the row
              // reaches the model indistinguishable from a full match and the
              // whole disclose-don't-decide argument for surfacing it collapses.
              ...(m.partial_match ? { partial_match: true } : {}),
              ...(m.thread_context ? { thread_context: true } : {}),
            });
          }
        } else {
          const rows = c.list({
            platform: c.platform,
            slug: c.slug,
            ...(filters ? { filters } : {}),
            ...(since !== undefined ? { since } : {}),
            ...(until !== undefined ? { until } : {}),
            limit: perCollectionLimit,
          });
          if (filledQuota(rows.length, perCollectionLimit)) moreAvailable = true;
          for (const r of rows) {
            aggregated.push({
              collection_slug: c.slug,
              record_id: r.record_id,
              hot_fields: r.hot_fields,
              received_at: r.received_at,
              ...mailEvidenceMetadata(c.slug, r.record_id, r.received_at, ctx?.time_zone),
              // ⛔⛔ THE LIST PATH RETURNED NO BODY, WHICH MADE THREAD-FOLLOWING
              // USELESS. Measured: told how to follow a conversation, the model
              // did it correctly — `query: null, filters: { thread_id }` — and
              // got back subjects and metadata with no text, then reported "the
              // messages are truncated and I can't see the settled figure". One
              // run fell back to the PROPOSAL (90 days) as if it were the
              // outcome. The search path has always carried a `snippet`; this
              // path carried nothing, so the answer was unreadable by
              // construction.
              //
              // Bounded, not full-fidelity: enough to read a short reply like
              // "no lets be fair and change it to 60 days", which is exactly the
              // shape a conversational answer takes.
              ...(typeof r.body_inline === 'string' && r.body_inline.length > 0
                ? { preview: r.body_inline.slice(0, LIST_PREVIEW_CHARS) }
                : {}),
            });
          }
        }
      }
      // Clamp aggregated to the requested limit — fan-out can return
      // up to `perCollectionLimit * N_collections`, which slightly
      // overshoots the user's limit. Truncate deterministically (rank
      // for FTS path stays the natural FTS5 BM25 order; hot-field path
      // keeps registration order across collections).
      const truncated = aggregated.slice(0, limit);
      // Fan-out overshoot is itself evidence of more.
      if (aggregated.length > limit) moreAvailable = true;
      // Words no mailbox holds — never for a search narrowed to one mailbox,
      // whose missing word may be in another.
      const hint = query && slug === undefined
        ? collectionSearchSpellingHint(collections, query, { one: 'email', many: 'emails' }, truncated.length > 0)
        : undefined;
      // D-237 P1 — the verdict rides out with the records it qualifies, exactly
      // as D-236 made it ride `collection.list`. An empty `matches` here is an
      // ABSENCE, and an absence is only a fact once you know the source was
      // current when it was read.
      return {
        ok: true,
        result: {
          matches: truncated,
          more_matches: moreAvailable,
          collections: collections.map((c) => c.slug),
          mailbox_addresses: mailboxAddresses(collections),
          source_freshness: mailFreshness(collections),
          ...(hint !== undefined ? { hint } : {}),
        },
      };
    } catch (e) {
      return executionError(errMessage(e));
    }
  };

// ────────────────────────────────────────────────────────────────
// calendar.search — per-instance CalendarCollectionTable fan-out
// ────────────────────────────────────────────────────────────────

/** D-117 — CalendarCollection's `Collection.list / search / get` are
 *  intentional no-ops (per its docstring); real events live behind
 *  the dedicated `CalendarCollectionTable`. The collection exposes the
 *  table on a `table` property. Codex review P2 fold (2026-05-12). */
const isCalendarCollection = (c: Collection): c is CalendarCollection =>
  'table' in c && (c as Partial<CalendarCollection>).table !== undefined;

const createCalendarSearchHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => {
    // D-205 #3 — the `data.calendar` read fence, BEFORE the registry is touched.
    const registry = deps.getCollectionRegistry();
    if (!registry) return executionError('collection registry unavailable');
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');
    const limit = clampLimit(args.limit);
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    // Calendar-specific window: agent passes `start_since` / `start_until`
    // (event-time bounds — what the user typically wants when asking
    // about meetings). We accept `since` / `until` as friendly aliases
    // mirroring `mail.search` for the AI's mental model.
    const startSince =
      typeof args.start_since === 'number'
        ? args.start_since
        : typeof args.since === 'number'
          ? args.since
          : undefined;
    const startUntil =
      typeof args.start_until === 'number'
        ? args.start_until
        : typeof args.until === 'number'
          ? args.until
          : undefined;
    const calendarId =
      typeof args.calendar_id === 'string' ? args.calendar_id : undefined;
    const collections = registry
      .list()
      .filter((c) => c.platform === 'calendar')
      .filter(isCalendarCollection);
    if (collections.length === 0) {
      // D-237 P1 — see `mail.search`: no calendar enrolled is a different fact
      // from an enrolled calendar that is behind.
      return { ok: true, result: { matches: [], collections: [], source_freshness: [] } };
    }
    try {
      const perCollectionLimit = Math.max(
        1,
        Math.ceil(limit / collections.length),
      );
      const aggregated: Array<Record<string, unknown>> = [];
      // Set when any store returned a full quota — see `filledQuota`.
      let moreAvailable = false;
      for (const c of collections) {
        if (query) {
          const calMatches = c.table.search({
            query,
            limit: perCollectionLimit,
          });
          if (filledQuota(calMatches.length, perCollectionLimit)) moreAvailable = true;
          for (const m of calMatches) {
            const when = eventWhenOnTurnClock(m.hot, ctx.time_zone);
            aggregated.push({
              collection_slug: c.slug,
              record_id: m.record_id,
              hot_fields: m.hot,
              ...(when !== undefined ? { when } : {}),
              rank: m.rank,
              // Calendar's own description, hydrated from the row.
              ...(typeof m.body === 'string' ? { body: m.body } : {}),
              ...(m.body_truncated ? { body_truncated: true } : {}),
            });
          }
        } else {
          // listSnapshots vs list: snapshots carry both the canonical
          // `record_id` needed by collection.get and the provider-native
          // `source_id` without a second round-trip. Slightly heavier
          // (deserializes JSON payload) but the per-collection cap bounds
          // the cost.
          const rows = c.table.listSnapshots({
            ...(startSince !== undefined ? { start_since: startSince } : {}),
            ...(startUntil !== undefined ? { start_until: startUntil } : {}),
            ...(calendarId ? { calendar_id: calendarId } : {}),
            limit: perCollectionLimit,
          });
          for (const r of rows) {
            const when = eventWhenOnTurnClock(r.hot, ctx.time_zone);
            aggregated.push({
              collection_slug: c.slug,
              // Exact Data/collection.get address. `source_id` is provider
              // native and cannot round-trip through the generic explorer.
              record_id: r.record_id,
              hot_fields: r.hot,
              ...(when !== undefined ? { when } : {}),
              received_at: r.received_at,
            });
          }
        }
      }
      const truncated = aggregated.slice(0, limit);
      // Fan-out overshoot is itself evidence of more.
      if (aggregated.length > limit) moreAvailable = true;
      const hint = query
        ? collectionSearchSpellingHint(
          collections, query, { one: 'calendar event', many: 'calendar events' }, truncated.length > 0,
        )
        : undefined;
      // D-237 P1 — calendar reads its own `CalendarCollectionTable` rather than
      // the `collection.list` path, exactly as `calendar-dispatcher.ts` does, so
      // the verdict is DERIVED here from the same `health()` rather than
      // approximated or omitted.
      return {
        ok: true,
        result: {
          matches: truncated,
          more_matches: moreAvailable,
          collections: collections.map((c) => c.slug),
          // Which account each calendar is, by the `collection_slug` its matches
          // carry: the owner says "my Google calendar" or an address, never the
          // slug it was connected under.
          calendar_addresses: collections.map((c) => ({ collection_slug: c.slug, ...calendarAddressOf(c) })),
          source_freshness: collectionSourceFreshnessFanOut(
            collections,
            (deps.now ?? Date.now)(),
          ),
          ...(hint !== undefined ? { hint } : {}),
        },
      };
    } catch (e) {
      return executionError(errMessage(e));
    }
  };

// ────────────────────────────────────────────────────────────────
// memory.search
// ────────────────────────────────────────────────────────────────

/** D-137 Trio #D follow-on — MCP-wire-safe projection of an audit
 *  entry. Mirrors `data.timeline()`'s memory-source projection
 *  (`mcp/timeline.ts:246-263`) so the two MCP read paths surface the
 *  same shape for the same row.
 *
 *  Drops these fields when crossing the MCP wire:
 *    - `config_snapshot` — user-set recipe variables. Pre-vault BYOK
 *      onboarding can route API keys / tokens through `config.*`
 *      before they migrate to `vault.*`; even when no credential
 *      slips through, business-private thresholds + filter strings
 *      (e.g. `customer_email_filter: "vip@*.com"`) are not the
 *      external agent's business.
 *    - `errors[].{message,details,timestamp}` — `RecipeError.details`
 *      is free-form `Record<string, unknown>` and routinely carries
 *      filesystem paths, internal step refs, vendor response
 *      fragments; the closed `code + severity + retryable + source`
 *      enum is the load-bearing portion for agent-side diagnosis.
 *
 *  Kept verbatim: stable identifying + outcome fields
 *  (`run_id` / `recipe_id` / `recipe_hash` / `started_at` /
 *  `finished_at` / `duration_ms` / `commit_status`), provenance metadata
 *  (`trigger_url` / `trigger_source` / `instance_id` / `process_id` /
 *  `run_mode` / `event_at`), short post-run summary (`output_string`,
 *  size-capped at `AUDIT_OUTPUT_STRING_MAX`), backfill rollup
 *  (`backfill`), recipe-shape pointer (`recipe_insight_id` —
 *  surrogate FK into `recipe_insights`, no payload). */
type MCPSafeRecipeError = Pick<
  RecipeError,
  'error_id' | 'code' | 'severity' | 'retryable' | 'source'
>;

/** Allow-list of `AuditEntry` keys safe to surface across the MCP
 *  trust boundary. Mirrors `data.timeline()`'s memory-source projection
 *  pattern (`mcp/timeline.ts:246-263`) — explicit enumeration, no
 *  rest-spread — so any new `AuditEntry` field stays out of the MCP
 *  surface until it's added here by name.
 *
 *  Intentionally excluded:
 *    - `config_snapshot` — user-set recipe variables (BYOK keys, etc.).
 *    - `reserve` / `budget_ms` — internal retention + tuning telemetry.
 *    - D-153 commit-substrate internals: `commit_kind`,
 *      `channel_session_id`, `cognition_session_id`, `correlation_id`,
 *      `idempotency_key`, `predecessor_commit_id`, `contract_snapshot`.
 *      Session ids are replay vectors + cross-session correlation
 *      surface; contract_snapshot exposes resolved tool allow-lists,
 *      rate limits, and scope_restrictions that the agent has no
 *      business reading back through `memory.search`. */
type MCPPassThroughKey =
  | 'run_id'
  | 'recipe_id'
  | 'recipe_hash'
  | 'started_at'
  | 'finished_at'
  | 'duration_ms'
  | 'commit_status'
  | 'trigger_url'
  | 'trigger_source'
  | 'instance_id'
  | 'process_id'
  | 'output_string'
  | 'recipe_insight_id'
  | 'event_at'
  | 'run_mode'
  | 'backfill';

type MCPSafeAuditEntry = Pick<AuditEntry, MCPPassThroughKey> & {
  errors: ReadonlyArray<MCPSafeRecipeError>;
};

const projectRecipeErrorForMcp = (e: RecipeError): MCPSafeRecipeError => ({
  error_id: e.error_id,
  code: e.code,
  severity: e.severity,
  retryable: e.retryable,
  source: e.source,
});

export const projectAuditEntryForMcp = (
  entry: AuditEntry,
): MCPSafeAuditEntry => ({
  run_id: entry.run_id,
  recipe_id: entry.recipe_id,
  recipe_hash: entry.recipe_hash,
  started_at: entry.started_at,
  finished_at: entry.finished_at,
  duration_ms: entry.duration_ms,
  commit_status: entry.commit_status,
  trigger_url: entry.trigger_url,
  trigger_source: entry.trigger_source,
  instance_id: entry.instance_id,
  ...(entry.process_id !== undefined ? { process_id: entry.process_id } : {}),
  ...(entry.output_string !== undefined
    ? { output_string: entry.output_string }
    : {}),
  ...(entry.recipe_insight_id !== undefined
    ? { recipe_insight_id: entry.recipe_insight_id }
    : {}),
  ...(entry.event_at !== undefined ? { event_at: entry.event_at } : {}),
  ...(entry.run_mode !== undefined ? { run_mode: entry.run_mode } : {}),
  ...(entry.backfill !== undefined ? { backfill: entry.backfill } : {}),
  errors: (entry.errors ?? []).map(projectRecipeErrorForMcp),
});

/** D-198 §3 — the `core.memory.read` grant op governing the shared-read half of
 *  memory.search (the `user_memory` pool union). */
export const MEMORY_READ_OP_ID = 'core.memory.read';

/** D-198 §3 — admit the `user_memory` union portion of a memory.search. The
 *  audit portion stays owner-trusted (unchanged); the pool's durable memories
 *  are shared by the `core.memory.read` grant — permissive for the owner,
 *  fail-closed for a door until the seller grants the tier. Absent gate / absent
 *  source ⇒ excluded (fail closed; the audit rows still flow, so no regression).
 *  Per-topic `scope_restrictions` (build-plan §D) ride the grant itself; v1
 *  gates the whole pool read per §3's separate-server-per-product curation. */
type AiToolGrantGate = Pick<OpAdmissionGate, 'isOpGranted' | 'isOwnerGoverned'>;
/** A scheduled prompt retains system provenance while using current owner
 * grants. Ordinary recipe and housekeeping system sources stay excluded. */
const isAiToolPrincipal = (gate: AiToolGrantGate, source: ExecutionSource): boolean =>
  source.actor === 'user_self' || source.actor === 'contracted_user'
  || source.channel === 'schedule' && source.prompt_schedule !== undefined && gate.isOwnerGoverned(source);

const admitMemoryRead = (
  gate: AiToolGrantGate | undefined,
  source: ExecutionSource | undefined,
): boolean =>
  gate !== undefined
  && source !== undefined
  && isAiToolPrincipal(gate, source)
  && gate.isOpGranted(source, MEMORY_READ_OP_ID);

/** Bodies inlined per `memory.search` call. The budget is SERVER-side and is
 *  deliberately NOT an arg: a model handed a `max_bytes` knob can set it high
 *  enough to bomb its own context. ~16 KB ≈ 4k tokens — comfortably several
 *  ordinary memories, never a 64 KB monster. */
const MEMORY_SEARCH_BUDGET_BYTES = 16 * 1024;

/** Cap on the `memory_id` fetch-one body. A pool body can exceed 64 KB (the CAS
 *  half), so the "call again with the id for the full text" escape hatch needs
 *  its OWN ceiling or it becomes the context bomb the budget exists to prevent. */
const MEMORY_FETCH_ONE_CAP_BYTES = 64 * 1024;

/** Server-fixed page size. Replaces the old `limit` arg for the same reason the
 *  budget is server-side — `limit: 100` × bodies is a footgun. The model pages
 *  with the opaque `cursor` instead: an affordance it can only FOLLOW. */
const MEMORY_SEARCH_PAGE_SIZE = 20;

/** Over-fetch factor for the ranked path — redaction + time filters run AFTER
 *  the match, so ask FTS5 for more than one page to avoid a short page. */
const MEMORY_SEARCH_OVERFETCH = 4;

interface MemorySearchCursor { o: number }

const encodeMemoryCursor = (offset: number): string =>
  Buffer.from(JSON.stringify({ o: offset } satisfies MemorySearchCursor), 'utf8').toString('base64');

/** Fail-OPEN to offset 0 on a malformed cursor — a thrown `invalid_args` here
 *  would re-open the agent retry loop (see the 2026-06-09 `enrichment.search`
 *  entry in internal design notes). */
const decodeMemoryCursor = (raw: unknown): number => {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as MemorySearchCursor;
    return Number.isInteger(parsed.o) && parsed.o >= 0 ? parsed.o : 0;
  } catch {
    return 0;
  }
};

/** A memory projected for recall. `body` is present when it fit the call's byte
 *  budget; otherwise `body_preview` + `truncated: true` + `size_bytes` tell the
 *  agent there is more and `memory_id` is how to get it. */
interface MemorySearchEntry {
  memory_id: string;
  origin_actor: UserMemoryRow['origin_actor'];
  kind: string;
  summary?: string;
  body?: string;
  body_preview?: string;
  size_bytes: number;
  truncated: boolean;
  ts: number;
  event_at?: number;
  /** D-198 §10 — present on an entry YOU saved: the ones you may replace
   *  (`memory.write` `replaces`) or forget (`memory.forget`). */
  by_you?: true;
  /** D-198 §10 — on a by-id fetch of an entry a newer version replaced: that
   *  version's id. Recall pages never carry replaced entries. */
  replaced_by?: string;
}

const projectMemoryEntry = (
  r: UserMemoryRow,
  body: string | undefined,
  truncated: boolean,
  author?: string,
): MemorySearchEntry => ({
  memory_id: r.memory_id,
  origin_actor: r.origin_actor,
  kind: r.kind,
  ...(r.summary !== undefined ? { summary: r.summary } : {}),
  ...(body !== undefined ? { body } : {}),
  ...(body === undefined && r.body_preview !== undefined ? { body_preview: r.body_preview } : {}),
  size_bytes: r.size_bytes,
  truncated,
  ts: r.ts,
  ...(r.event_at !== undefined ? { event_at: r.event_at } : {}),
  ...(author !== undefined && memoryRowAuthor(r) === author ? { by_you: true as const } : {}),
});

/** Effective (bistemporal) time — real-world `event_at` when the row carries one,
 *  else ingestion `ts`. The axis `since`/`until` filter on (D-120 P7.5). */
const effectiveTime = (r: UserMemoryRow): number => r.event_at ?? r.ts;

/** How far the FIRST result outscores the SECOND, in `[0, 1]`.
 *
 *  The question a recall caller actually has is not "how many results are
 *  there" but "is the top one THE one" — and that is a property of the score
 *  DISTRIBUTION, not a constant. Near 1: the leader dominates, act on it. Near
 *  0: the top two are interchangeable and picking one silently is a guess
 *  wearing an answer's clothes. Mirrors `ChatConfidenceMeasures.top_margin`,
 *  which `contact` / `deal` / `account.search` already carry.
 *
 *  ⚠ RELATIVE, not absolute, because bm25 is unbounded and corpus-dependent —
 *  a raw gap of "0.4" means nothing on its own, while "the leader scored 40%
 *  above the runner-up" is the same statement at any corpus size.
 *
 *  ⚠ `rank` IS A COST: FTS5 returns bm25 as a negative number, most-negative
 *  first. Flipped to a score here; a non-positive leader (or an unranked
 *  substring-harness hit) yields `null` rather than a fabricated number. */
const topMargin = (ranks: ReadonlyArray<number | null>): number | null => {
  if (ranks.length < 2) return null;
  const [first, second] = ranks;
  if (first === null || first === undefined || second === null || second === undefined) {
    return null;
  }
  const lead = -first;
  const runnerUp = -second;
  if (!(lead > 0)) return null;
  const margin = (lead - runnerUp) / lead;
  if (!Number.isFinite(margin)) return null;
  return Math.round(Math.min(1, Math.max(0, margin)) * 1000) / 1000;
};

/** Every non-result exit is a GUIDED EMPTY, never an error. An `ok:false` from a
 *  recall tool makes the agent retry-to-timeout (the loop the 2026-06-09
 *  `enrichment.search` fix closed, which cited memory.search's own never-error
 *  fallback as the precedent). Keep it that way. */
const emptyMemoryResult = (
  hint: string,
  coverage?: 'unavailable',
) => ({
  ok: true as const,
  result: {
    memories: [] as MemorySearchEntry[],
    budget: { limit_bytes: MEMORY_SEARCH_BUDGET_BYTES, used_bytes: 0, truncated_count: 0 },
    ...(coverage !== undefined ? { coverage } : {}),
    hint,
  },
});

/** `memory.search` — RECALL over the D-198 knowledge pool.
 *
 *  ⚠ The AUDIT half is GONE (was: `auditLog.listRecent(limit)` ∪ the pool).
 *  Two independent reasons, both load-bearing:
 *    1. SECURITY — it read the audit log with NO grant check at all, while the
 *       MCP door path gates the very same data behind `core.audit.read`
 *       (`mcp-server.ts`, "Run history reveals the owner's automation activity").
 *       Same data, two doors, one gated: a bypassed gate, not a missing one.
 *    2. QUALITY — audit is the highest-VOLUME / lowest-VALUE feed (every cron run
 *       writes a row) and it arrived by RECENCY, never having matched anything.
 *       In a fixed body budget it crowds out the curated knowledge that IS the
 *       answer. Run history is Runs / `#logs` (D-198 §4 keeps them distinct);
 *       recall is knowledge. If audit ever needs a chat surface it is its own
 *       owner-only, query-matched `runs.search` — gated by the op that exists.
 *
 *  Result = one ranked list, bodies filled GREEDILY in rank order until the
 *  16 KB budget is spent (skip-what-doesn't-fit, so a fat rank-1 cannot starve
 *  every smaller hit below it), degrading to `body_preview` + `size_bytes` +
 *  `truncated`. `memory_id` re-fetches ONE entry in full.
 *
 *  ANTI-LOOP INVARIANT: every non-result exit is a guided EMPTY (`ok:true`,
 *  `memories: []`, `hint`), never `ok:false`. A missing arg, a junk query, an
 *  ungranted read, an unknown id — none may error. See the 2026-06-09
 *  `enrichment.search` entry in internal design notes, which
 *  cites THIS tool's never-error fallback as the precedent it copied. */
/** D-172 P2 — `file.search`: file IDENTITY, session-scoped by default.
 *
 *  ⛔⛔ THE DEFAULT IS THE CONTAINMENT. Scope is an argument, so it is the
 *  MODEL that chooses it — and the model is often reading text a stranger
 *  wrote (an inbound email it was asked to summarize). If omitting the
 *  argument meant "everything", a prompt-injected instruction would reach the
 *  owner's whole file store just by saying nothing, and the model could name
 *  a file the owner never put in front of it. So `session` is what you get for
 *  free and `'all'` has to be asked for out loud, where it shows up in the
 *  tool trace.
 *
 *  🔑 The reason to prefer narrow is not primarily security, it is PRECISION,
 *  and the asymmetry is what settles it: failing to find a file costs one turn
 *  ("no, the other one"); attaching the WRONG file to an outbound email cannot
 *  be taken back. Bias toward returning too few.
 *
 *  ⚠ IDENTITY ONLY — no bytes, ever. Content egress stays on the Gateway-gated
 *  `data-file-read`, which is a separate admission and writes its own
 *  `file_content_read` audit row. Naming a file is free; reading one is an
 *  observable act. That split is what lets "attach this" cost nothing while
 *  "what does this say" stays gated. */
const FILE_SEARCH_DEFAULT_LIMIT = 20;
const FILE_SEARCH_MAX_LIMIT = 100;

interface ChatFileRow {
  file_id: string;
  filename: string;
  /** The file's path within its tree — a LOCAL relative path, or the vendor
   *  tree path mirrored into `FileMetaProjection.path` for a D-192 remote
   *  source. Projected because it is now matchable: a hit the model cannot see
   *  the reason for is one it will describe wrongly. Omitted when absent. */
  path?: string;
  media_class: string;
  size_bytes: number;
  origin: string;
  scan_status: string;
  received_at: number;
  /** Present only for a D-192 mirrored file (`remote`) or a file in a folder
   *  Recued watches on the owner's machine (`local`): the model should be able
   *  to tell a file the owner HOLDS from one a vendor holds on their behalf, and
   *  both from one sitting in her own folder. */
  posture?: 'remote' | 'local';
  provider?: string;
  /** `local` only: the watched folder (its name) the file is in. */
  folder?: string;
}

const projectChatFileRow = (record: {
  record_id: string;
  received_at?: number;
  size_bytes?: number;
  hot_fields: Record<string, unknown>;
}): ChatFileRow => {
  const hot = record.hot_fields;
  const str = (v: unknown, fallback: string): string =>
    typeof v === 'string' && v.length > 0 ? v : fallback;
  return {
    file_id: record.record_id,
    filename: str(hot.filename, record.record_id),
    ...(typeof hot.path === 'string' && hot.path.length > 0 ? { path: hot.path } : {}),
    media_class: str(hot.media_class, 'other'),
    size_bytes: typeof hot.size === 'number'
      ? hot.size
      : typeof record.size_bytes === 'number' ? record.size_bytes : 0,
    origin: str(hot.origin, 'unknown'),
    // ⚠ NOT defaulted to 'clean'. An absent scan status is UNKNOWN, and a
    // reader deciding whether to send a file outward must not be told
    // "checked" about a file nobody checked.
    scan_status: str(hot.scan_status, 'unscanned'),
    received_at: typeof record.received_at === 'number' ? record.received_at : 0,
  };
};

/** A unified view as the chat row. ⚠ `origin` / `scan_status` / `media_class`
 *  have NO remote analogue, so a mirrored file reports `unknown` / `unscanned` /
 *  `other` rather than borrowing a CAS row's defaults — a reader deciding
 *  whether to send a file outward must not be told "checked" about a file
 *  nobody checked. `provider` is carried so the model can say WHERE the file
 *  lives, which is the difference between "you have it" and "Dropbox has it". */
const projectFileView = (v: DataFileView): ChatFileRow => ({
  file_id: v.record_id,
  filename: v.filename,
  ...(v.path !== undefined && v.path.length > 0 ? { path: v.path } : {}),
  media_class: v.media_class
    ?? (v.posture === 'local' && v.mime_type !== undefined ? mediaClassForMimeType(v.mime_type) : 'other'),
  size_bytes: v.size ?? 0,
  // A watched folder's file is the owner's own, from her own disk.
  origin: v.origin ?? (v.posture === 'local' ? 'watched_folder' : 'unknown'),
  scan_status: v.scan_status ?? 'unscanned',
  received_at: v.event_at ?? 0,
  ...(v.posture === 'remote' || v.posture === 'local' ? { posture: v.posture } : {}),
  ...(v.provider !== undefined ? { provider: v.provider } : {}),
  ...(v.folder !== undefined ? { folder: v.folder } : {}),
});

/** How many files each candidate lookup of the file spelling check reads. */
const FILE_SPELLING_CANDIDATES = 300;

/** The words of a file's name and folder path as written. `CastellanosLease`
 *  splits too: file names are often written that way. */
const fileNameWords = (filename: string, path: string): string[] =>
  `${filename}\n${path}`.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .split(/[^\p{L}\p{N}\p{M}]+/u)
    .filter((word) => word.length > 0);

/** A query term no file name or folder holds, the closest word one does, and
 *  how many files hold that word (a floor when `capped`). */
type FileRespelling = { typed: string; word: string; files: number; capped: boolean };

/** "Did you mean" for a file search, from the words of the file names and
 *  folders the same search reaches.
 *
 *  ⛔ NOT THE CONTENT INDEX. `file.search` matches a term as a substring of a
 *  file's NAME and PATH (`scoreFileNeedle`), never its text. So "absent" is
 *  asked of the search itself (the term alone finds nothing), and a suggestion
 *  is a word in a name or folder it can return. The content index would call
 *  `Castellanos_lease.pdf` absent whenever its text was not indexed, and would
 *  offer words from inside files that the search cannot find by them.
 *
 *  ⚠ CANDIDATES COME FROM TWO SEARCHES, on the term's first three letters and on
 *  its last three: the names and folders holding either, up to
 *  `FILE_SPELLING_CANDIDATES` files each. A typo at both ends finds none — the
 *  stated cost of not reading every file name the owner has, which for a
 *  mirrored drive can be tens of thousands. A watched folder's index matches
 *  word STARTS, so there only the first-letters search reaches. */
const fileSearchRespellings = (
  rawQuery: string,
  search: {
    present: (term: string) => boolean;
    candidates: (term: string) => ReadonlyArray<{ filename: string; path?: string }>;
    count: (word: string) => { files: number; capped: boolean };
  },
): FileRespelling[] => {
  const out: FileRespelling[] = [];
  const seen = new Set<string>();
  for (const part of rawQuery.split(/\s+/u)) {
    const typed = part.replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/gu, '');
    const term = typed.toLowerCase();
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    const length = [...term].length;
    const max = spellingMaxDistance(length);
    // Words only: a number, a stopword, or a token with punctuation inside it is
    // not a misspelling of anything.
    if (max === 0 || !/^[\p{L}\p{M}]+$/u.test(term) || FTS_STOPWORDS.has(term)) continue;
    if (search.present(term)) continue;
    const byWord = new Map<string, { word: string; distance: number; files: Set<string> }>();
    for (const file of search.candidates(term)) {
      const fileKey = `${file.filename}\n${file.path ?? ''}`;
      for (const word of new Set(fileNameWords(file.filename, file.path ?? ''))) {
        const key = word.toLowerCase();
        if (!/^[\p{L}\p{M}]+$/u.test(key) || Math.abs([...key].length - length) > max) continue;
        const distance = boundedEditDistance(term, key, max);
        // The term itself is no correction — and on file means `present` erred.
        if (distance === 0 || distance > max) continue;
        const entry = byWord.get(key) ?? { word, distance, files: new Set<string>() };
        // A capitalised spelling wins, as it does for the indexed stores.
        if (!/\p{Lu}/u.test(entry.word) && /\p{Lu}/u.test(word)) entry.word = word;
        entry.files.add(fileKey);
        byWord.set(key, entry);
      }
    }
    const [best] = [...byWord.values()].sort((a, b) => (a.distance - b.distance)
      || (b.files.size - a.files.size) || a.word.localeCompare(b.word));
    if (best !== undefined) out.push({ typed, word: best.word, ...search.count(best.word) });
  }
  return out;
};

/** ⚠ Model-facing — the wording of the indexed stores' hint, naming files. */
const fileSpellingHint = (respelled: ReadonlyArray<FileRespelling>): string => {
  const facts = respelled.map((r) => `No file name or folder holds "${r.typed}", but "${r.word}" `
    + `is in ${r.capped ? 'at least ' : ''}${r.files} file${r.files === 1 ? '' : 's'}.`);
  const [only] = respelled;
  const retry = respelled.length === 1 && only !== undefined
    ? `If that is who or what the owner meant, search again for "${only.word}", and begin your `
      + `answer by telling the owner you read "${only.typed}" as "${only.word}": it may be a `
      + 'different name.'
    : 'If those are who or what the owner meant, search again with them, and begin your answer by '
      + 'telling the owner how you read their words: they may be different names.';
  return `${facts.join(' ')} ${retry}`;
};

const createFileSearchHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => {
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');

    const registry = deps.getCollectionRegistry();
    // D-237 P1 — `health` is widened into the structural cast so this handler
    // can reach the same verdict the collection reads carry. ⚠ Typed
    // non-optional deliberately: if the object somehow has no `health`, the
    // call throws INSIDE `collectionSourceFreshnessOf`'s try and yields the
    // never-synced/stale verdict — which is the direction this fact must always
    // fail, and is why no extra guard is written here.
    const collection = registry?.get('file', DATA_FILE_RECEIVED_SLUG) as
      | {
          get(id: string): unknown;
          list?: (limit?: number) => unknown[];
          health: () => CollectionHealth;
        }
      | undefined;
    if (!collection) {
      return {
        ok: true,
        result: {
          files: [],
          source_freshness: [],
          hint: 'the file store is not available on this server',
        },
      };
    }
    /** The verdict for each store this read reached. `withFolders` when the
     *  answer may hold a watched folder's files: those rows are as current as
     *  that folder's index, so each folder answers for its own (`folder` on a
     *  row joins `collection_slug`). */
    const fileSourceFreshness = (withFolders = false): CollectionSourceFreshnessEntry[] =>
      collectionSourceFreshnessFanOut(
        [
          { slug: DATA_FILE_RECEIVED_SLUG, health: collection.health },
          ...(withFolders
            ? (registry?.list() ?? []).filter(isWatchedFolderCollection)
              .map((c) => ({ slug: c.slug, health: () => c.health() }))
            : []),
        ],
        (deps.now ?? Date.now)(),
      );

    const rawScope = typeof args.scope === 'string' ? args.scope : 'session';
    // An unrecognized scope falls back to the NARROW one. A typo must never be
    // the thing that widens a search whose whole point is being narrow.
    const scope: 'session' | 'all' = rawScope === 'all' ? 'all' : 'session';
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    // As typed, for a spelling hint to echo: the lower-cased form above is a
    // string the model did not write.
    const typedQuery = typeof args.query === 'string' ? args.query.trim() : '';
    const limit = Math.min(
      typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? Math.floor(args.limit)
        : FILE_SEARCH_DEFAULT_LIMIT,
      FILE_SEARCH_MAX_LIMIT,
    );

    let rows: ChatFileRow[] = [];
    // Set when the unified resolver answered: it has already matched AND ranked,
    // so the local filter/sort below must not run over its output.
    let resolved = false;
    /** How many files matched SOME of a multi-term query that matched none in
     *  full — the cause behind an empty page. 0 when not applicable. */
    let partialTermMatches = 0;
    // The owner-wide resolver, when this search went through it.
    let resolver: FileViewResolver | undefined;
    if (scope === 'session') {
      const store = deps.getChatStore?.();
      if (!store || ctx.session_id === undefined) {
        return {
          ok: true,
          result: {
            files: [],
            scope,
            source_freshness: fileSourceFreshness(),
            hint: 'no conversation files are readable here — this turn has no session context',
          },
        };
      }
      const messages = await store.listMessages(ctx.session_id);
      const seen = new Set<string>();
      for (const message of messages) {
        for (const att of message.attachments ?? []) {
          if (seen.has(att.file_id)) continue;
          seen.add(att.file_id);
          const record = collection.get(att.file_id) as Parameters<typeof projectChatFileRow>[0] | null;
          // A referenced file whose record is gone is SKIPPED, not surfaced as
          // a bare id — an entry the model cannot describe is one it will
          // describe wrongly.
          if (record) rows.push(projectChatFileRow(record));
        }
      }
    } else {
      // ── OWNER-WIDE SCOPE ────────────────────────────────────────────────
      // ⛔ ROUTED THROUGH THE UNIFIED RESOLVER WHEN THERE IS A NEEDLE. Reading
      // the collection directly is what made every DECLARED REMOTE SOURCE
      // invisible to chat: `searchFileViews` merges the CAS space with
      // `file_meta_ref` across every enrolled Source and applies the same
      // tiered `scoreFileNeedle`, so local and remote answer one question.
      //
      // ⚠ A BLANK QUERY STAYS LOCAL, and that is a property of the substrate
      // rather than a shortcut: `searchAll` is cross-scope but needle-driven
      // (blank ⇒ `[]`, because the picker fires per keystroke), and the mirror
      // has no cross-scope LIST. So "list everything" enumerates the CAS space
      // only — stated in the tool description rather than left to be discovered.
      resolver = deps.getFileViewResolver?.();
      if (resolver && query.length > 0) {
        const cap = Math.min(FILE_SEARCH_MAX_LIMIT, Math.max(limit, 1));
        rows = resolver.searchFileViews(query, cap).map(projectFileView);
        resolved = true;
        // ⛔ THE CAUSE MUST BE COMPUTED HERE TOO, AND THE FIRST CUT PUT IT ONLY
        // ON THE FALLBACK PATH — where production never goes for this scope.
        // My own test caught it: the matrix wires a resolver, so the disclosure
        // silently never fired on the one path that matters. A branch that
        // exists only where the code does not run is worse than no branch.
        const qTerms = query.split(/\s+/).filter((t) => t.length > 0);
        if (rows.length === 0 && qTerms.length > 1) {
          const seenIds = new Set<string>();
          for (const t of qTerms) {
            for (const v of resolver.searchFileViews(t, cap)) seenIds.add(v.record_id);
          }
          partialTermMatches = seenIds.size;
        }
      } else {
        const listed = collection.list?.(FILE_SEARCH_MAX_LIMIT) ?? [];
        rows = (listed as Parameters<typeof projectChatFileRow>[0][]).map(projectChatFileRow);
      }
    }

    // What a query was matched against when no resolver answered: the
    // conversation's files, or the listed received files.
    const universe = rows;
    const terms = query.split(/\s+/).filter((t) => t.length > 0);
    // ⚠ `resolved` ⇒ the resolver ALREADY applied `scoreFileNeedle` and ranked.
    // Re-filtering here would be the same rule run twice, and re-sorting would
    // discard its merge order across the two postures.
    if (query.length > 0 && !resolved) {
      // ⛔ FILENAME ALONE LOSES THE FOLDER, AND THE FOLDER IS OFTEN THE SUBJECT.
      // A file at `Clients/Sandhurst/2026/terms.pdf` is ABOUT Sandhurst and says
      // so nowhere in its leaf name, so a filename-only match answered nothing
      // for the one term a person would actually search. `path` is already in
      // `hot_fields` for local files, and is mirrored from
      // `FileMetaProjection.path` — the vendor tree path — for a D-192 remote
      // source, so this costs no new storage and no new read.
      // ⛔⛔ AND THE WHOLE QUERY WAS MATCHED AS ONE LITERAL SUBSTRING, so any
      // multi-word query missed almost everything. Measured — the index named
      // `file.search` for `sandhurst`, `renewal` AND `notice` separately, the
      // model then asked for "Sandhurst renewal notice" as a phrase, and got
      // ZERO against a file named `renewal-notice-83-days.pdf` under
      // `Clients/Sandhurst/2026/`. Every term was present; the phrase was not.
      // The index is what made this visible: it asserted the store held the
      // words, and the tool could not retrieve them.
      //
      // Now every TERM must appear somewhere in name+path — the same
      // all-terms-must-match rule the FTS stores get from FTS5's implicit AND.
      // A single-term query behaves exactly as before.
      // ⛔ CALL THE RULE, DO NOT RE-IMPLEMENT IT — `scoreFileNeedle` is the one
      // definition, and this file having its own copy is how the two drifted
      // apart in the first place (filename-only here, path-only there).
      //
      // 🔑 SCORED, NOT FILTERED: a VERBATIM hit outranks an every-term hit, and
      // the sort below puts it first. Flattening the two would hand back
      // `Sandhurst/invoice-10823.pdf` and `renewal-notice.pdf` as equals for the
      // query "renewal notice" and let recency alone decide — which is the same
      // relevance-then-recency ordering the FTS stores get, thrown away.
      const scored = new Map<string, 0 | 1 | 2>();
      const before = rows;
      rows = rows.filter((r) => {
        const score = scoreFileNeedle(r.filename, r.path ?? '', query);
        if (score > 0) scored.set(r.file_id, score);
        return score > 0;
      });
      // ⛔⛔ AN EMPTY ANSWER MUST NAME ITS CAUSE. Measured against a live model,
      // 7 runs out of 7: the index line said `renewal: file.search; sandhurst:
      // file.search` — two entries, two DIFFERENT files — the model asked
      // `file.search("Sandhurst renewal")`, matched nothing (correctly: no one
      // file is both), and reported "no Sandhurst renewal document" WITHOUT
      // ever surfacing the two files that were plainly relevant. Not one run
      // invented the intersection, which was the risk worth checking; every run
      // hid the parts.
      //
      // ⚠ THIS IS A DISCLOSURE, NOT PARTIAL RESULTS. It reports a COUNT of
      // rows matching some-but-not-all terms and returns none of them. Handing
      // the weak rows over is the `RECUED_PARTIAL_SLOTS` widening, which was
      // measured on the FTS stores to have a structural ceiling and ships OFF —
      // a partial row presented as a hit is worse than a stated absence. A
      // stated absence with its CAUSE is better than either.
      if (rows.length === 0 && terms.length > 1) {
        partialTermMatches = before.filter((r) => {
          const hay = `${r.filename}\n${r.path ?? ''}`.toLowerCase();
          return terms.some((t) => hay.includes(t));
        }).length;
      }
      rows.sort((a, b) => (scored.get(b.file_id) ?? 0) - (scored.get(a.file_id) ?? 0)
        || b.received_at - a.received_at);
    }
    // ⚠ ONLY when there is no query. A ranked list must not be re-sorted by
    // recency alone — that is exactly the eviction the recency FLOOR exists to
    // bound on the FTS stores, and doing it here would silently discard the
    // phrase-vs-terms distinction the scorer just drew.
    if (query.length === 0 && !resolved) rows.sort((a, b) => b.received_at - a.received_at);
    const truncated = rows.length > limit;
    rows = rows.slice(0, limit);
    // An empty page whose term no file name or folder holds: the closest word
    // one does, from the same search (`fileSearchRespellings`).
    const owner = resolved ? resolver : undefined;
    const respelled = rows.length === 0 && query.length > 0
      ? fileSearchRespellings(typedQuery, owner !== undefined
        ? {
          present: (term) => owner.searchFileViews(term, 1).length > 0,
          candidates: (term) => [
            ...owner.searchFileViews(term.slice(0, 3), FILE_SPELLING_CANDIDATES),
            ...owner.searchFileViews(term.slice(-3), FILE_SPELLING_CANDIDATES),
          ],
          count: (word) => {
            const files = owner.searchFileViews(word, FILE_SEARCH_MAX_LIMIT).length;
            return { files, capped: files >= FILE_SEARCH_MAX_LIMIT };
          },
        }
        : {
          present: (term) => universe.some((r) => scoreFileNeedle(r.filename, r.path ?? '', term) > 0),
          candidates: () => universe,
          count: (word) => ({
            files: universe.filter((r) => scoreFileNeedle(r.filename, r.path ?? '', word) > 0).length,
            capped: false,
          }),
        })
      : [];
    const partialTermsReason = partialTermMatches > 0
      ? `No file matches ALL of ${JSON.stringify(query)}, but `
        + `${partialTermMatches} file(s) match some of those words. `
        + `Search a single distinctive word to see them — do not report `
        + `that the owner has nothing on this.`
      : undefined;
    const noMatchReason = [
      ...(respelled.length > 0 ? [fileSpellingHint(respelled)] : []),
      ...(partialTermsReason !== undefined ? [partialTermsReason] : []),
    ].join(' ');

    // D-237 P1 — session scope reads the conversation's attachments THROUGH the
    // file collection (`collection.get`), and a referenced file whose record has
    // not landed yet is SKIPPED by design a few lines up. So a lagging file
    // source silently shortens this list, and the verdict qualifies both scopes.
    return {
      ok: true,
      result: {
        files: rows,
        // Same disclosure as mail/calendar: a full page is evidence the caller
        // is seeing a SLICE. Silence here would let the model report a
        // complete-looking answer from a partial one.
        more_matches: filledQuota(rows.length, limit),
        scope,
        source_freshness: fileSourceFreshness(resolved),
        ...(truncated ? { truncated: true } : {}),
        // ⛔ THE CAUSE OF AN EMPTY PAGE, when there is one to give. See the note
        // where this is computed: a multi-term query that matches nothing in
        // full, while files match some of the words, is the shape that made a
        // model report a flat absence 7 runs out of 7 and never mention the
        // relevant files. A COUNT, never the rows.
        ...(partialTermMatches > 0 ? { partial_term_matches: partialTermMatches } : {}),
        // A term no file name or folder holds comes first: it is the more
        // specific cause, and the one a retry with different words cannot fix.
        ...(noMatchReason.length > 0 ? { no_match_reason: noMatchReason } : {}),
        // The scope is stated back on EVERY result, not just when widened. A
        // model that forgot which set it searched will otherwise report an
        // absence it never actually established.
        hint: scope === 'session'
          ? 'These are the files of THIS conversation only. If the user means a file from elsewhere, ask them before widening.'
          : 'This searched EVERY file the owner holds, including uploads from strangers via the owner\'s public form. Check `origin` and `scan_status` before putting any of these into something that leaves the owner\'s machine.',
      },
    };
  };

const createMemorySearchHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => {
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');

    // The pool is now the ONLY half, so this grant gates the WHOLE tool (it used
    // to gate just the pool union while audit flowed free). Owner-permissive; a
    // door needs the seller's explicit `core.memory.read` (owner-default-only).
    if (!admitMemoryRead(deps.getOpAdmissionGate?.(), ctx.execution_source)) {
      return emptyMemoryResult('reading the memory pool is not granted for this caller');
    }

    const store = deps.getUserMemoryStore?.();
    if (!store) {
      return emptyMemoryResult(
        'memory pool unavailable on this server',
        'unavailable',
      );
    }

    try {
      // D-198 §5 — HONOR the redaction overlay: a "forgotten" row is OMITTED
      // from recall entirely (unlike the transparent feed, which shows a
      // content-cleared tombstone). This is the surface that reaches a granted
      // door, so it must never hand back forgotten content.
      const redacted = await forgottenIds(deps.getMemoryRedactionStore?.());
      // D-198 §10 — the caller's own entries are marked `by_you`, the ones it may
      // replace or forget.
      const author = ctx.execution_source
        ? authoringContractId(ctx.execution_source)
        : undefined;

      // ── memory_id → fetch ONE in full (the escape hatch for a `truncated` hit)
      const memoryId =
        typeof args.memory_id === 'string' && args.memory_id.length > 0
          ? args.memory_id
          : undefined;
      if (memoryId !== undefined) {
        if (redacted.has(memoryId)) return emptyMemoryResult('that memory was forgotten');
        const resolved = await store.get(memoryId);
        if (resolved === null) return emptyMemoryResult(`no memory with id '${memoryId}'`);
        const full = resolved.body;
        const overCap =
          full !== undefined && Buffer.byteLength(full, 'utf8') > MEMORY_FETCH_ONE_CAP_BYTES;
        // ⛔ `slice` COUNTS UTF-16 UNITS, THE CAP COUNTS BYTES. A CJK body came
        //   back at 3x `limit_bytes` — and `used_bytes` below measured the real
        //   size, so the result openly reported itself over its own budget.
        const body = overCap ? truncateUtf8(full!, MEMORY_FETCH_ONE_CAP_BYTES) : full;
        const current = await currentVersionOf(store, redacted, memoryId);
        const entry: MemorySearchEntry = {
          ...projectMemoryEntry(resolved.row, body, overCap, author),
          ...(current !== memoryId ? { replaced_by: current } : {}),
        };
        return {
          ok: true,
          result: {
            memories: [entry],
            budget: {
              limit_bytes: MEMORY_FETCH_ONE_CAP_BYTES,
              used_bytes: body === undefined ? 0 : Buffer.byteLength(body, 'utf8'),
              truncated_count: overCap ? 1 : 0,
            },
          },
        };
      }

      // ── query → FTS5 rank; no query → most recent (the ANTI-LOOP fallback:
      //    a bare `memory.search` must still answer, never error).
      const query =
        typeof args.query === 'string' && args.query.trim().length > 0
          ? args.query.trim()
          : undefined;
      const since = typeof args.since === 'number' ? args.since : undefined;
      const until = typeof args.until === 'number' ? args.until : undefined;
      const offset = decodeMemoryCursor(args.cursor);

      let ordered: UserMemoryRow[];
      // Which relaxation rung answered + each hit's bm25 rank. Both absent on
      // the no-query path — "the 20 most recent" is a listing, not a match, so
      // reporting match quality about it would be a fabricated signal.
      let matchKind: MemorySearchResult['match'];
      /** Why rung 4 did not run, when it did not. Shapes the empty's hint so
       *  "no semantic neighbour" and "semantic recall was never possible" stay
       *  distinguishable to the agent. */
      let semanticSkipped:
        | 'no_embedder' | 'not_embedded' | 'cohort_mismatch' | 'embed_failed'
        | undefined;
      const rankById = new Map<string, number | null>();
      if (query !== undefined) {
        // Fetch PAST the requested offset so `next_cursor` stays truthful when
        // the agent pages deep (a fixed over-fetch would silently cap paging).
        const overFetch = offset + MEMORY_SEARCH_PAGE_SIZE * MEMORY_SEARCH_OVERFETCH;
        const found = await store.search(query, overFetch);
        matchKind = found.match;
        let hits = found.hits;

        // ── RUNG 4 — semantic, and ONLY when the lexical ladder found nothing.
        //
        // Conditional for a reason that is not thrift: `memory.search` is pure
        // SQL today — zero token cost, no provider dependency, instant — and
        // embedding the query puts an LLM call in the chat read path. Gating it
        // on total lexical failure keeps that cost off the ~97% of queries the
        // ladder already answers (measured 29/30 on the pilot corpus) and means
        // NO query that works today changes at all.
        //
        // The case it exists for shares no token with its answer, so no amount
        // of relaxation reaches it: "How do I turn on 2FA?" against an entry
        // saying "two-factor authentication" matches at rung 1, 2 and 3 alike —
        // which is to say, not at all.
        if (hits.length === 0) {
          const embedder = deps.getMemoryEmbedder?.();
          const coverage = store.vectorCoverage();
          if (embedder === undefined || coverage.model === undefined) {
            // ⛔ NOT "nothing matches" — semantic recall never RAN. An
            // unembedded pool and a pool with no neighbour produce identical
            // zero rows, and conflating them is the absence-reads-as-an-answer
            // failure. Which one is true rides out on the hint.
            semanticSkipped = embedder === undefined ? 'no_embedder' : 'not_embedded';
          } else {
            try {
              const probe = await embedder(query);
              // Cohort guard: a query embedded by a different model than the
              // pool is not comparable, and comparing anyway returns confident
              // nonsense. Skip rather than mislead.
              if (probe.model === coverage.model) {
                hits = store.semanticSearch(probe, overFetch);
                if (hits.length > 0) matchKind = 'semantic';
              } else {
                semanticSkipped = 'cohort_mismatch';
              }
            } catch {
              // No embeddings path, quota, timeout. Rung 4 is an ENHANCEMENT
              // over an already-empty answer, so a failure degrades to that
              // empty — never to an error the agent would retry.
              semanticSkipped = 'embed_failed';
            }
          }
        }
        for (const hit of hits) rankById.set(hit.memory_id, hit.rank);
        // Rows only — NEVER `store.get` here. `get` resolves the body (a CAS blob
        // read for every > 64 KB memory) and `list` scans the whole pool loading
        // every inline body; we need bodies for at most ONE page AFTER the budget
        // decides. Point-get the ranked ids, preserving rank order.
        // ⛔ `hits`, NOT `found.hits` — rung 4 REPLACES the (empty) lexical hits,
        // and reading the original array here silently discarded every semantic
        // result while still reporting `match: 'semantic'`. Each half was right;
        // the join was the defect, and only the seam test saw it.
        const rows = await Promise.all(hits.map((h) => store.getRow(h.memory_id)));
        ordered = rows.filter((r): r is UserMemoryRow => r !== null); // rank order preserved
      } else {
        ordered = (await store.list()).sort((a, b) => effectiveTime(b) - effectiveTime(a));
      }

      // D-198 §10 — a REPLACED entry is not current, so no page carries it (the
      // owner's feed still shows it). A replacement that is itself forgotten no
      // longer counts: forgetting the newer version brings the older one back.
      // The listing already holds every row; a ranked page asks per hit.
      const replaced = new Set<string>();
      if (query === undefined) {
        for (const r of ordered) {
          if (r.replaces !== undefined && !redacted.has(r.memory_id)) replaced.add(r.replaces);
        }
      } else {
        for (const r of ordered) {
          if (await liveReplacementOf(store, redacted, r.memory_id)) replaced.add(r.memory_id);
        }
      }
      const filtered = ordered.filter(
        (r) =>
          !redacted.has(r.memory_id)
          && !replaced.has(r.memory_id)
          && (since === undefined || effectiveTime(r) >= since)
          && (until === undefined || effectiveTime(r) <= until),
      );

      const page = filtered.slice(offset, offset + MEMORY_SEARCH_PAGE_SIZE);
      if (page.length === 0) {
        if (query === undefined) {
          return emptyMemoryResult('no memories saved yet — write one with memory.write');
        }
        // ⛔ SAY WHICH EMPTY THIS IS. "No entry matches" is a fact about the
        // pool; "semantic recall could not run" is a fact about the SERVER, and
        // an agent that reads the second as the first will tell Mary her
        // knowledge is not there when it may simply not be embedded.
        return emptyMemoryResult(
          semanticSkipped === undefined
            ? `nothing in the memory pool matches '${query}' — including by meaning`
            : semanticSkipped === 'not_embedded'
              // ⛔ NO "Mary can enable it in Settings" — there is no such
              // control yet (see `embedBacklog`'s caller gap). Naming an
              // affordance that does not exist sends her looking for it and
              // makes the tool the liar.
              ? `no entry contains those words, and meaning-based recall could not be`
                + ` tried: this pool has not been embedded. An entry phrased`
                + ` differently would not be found, so do not conclude the knowledge`
                + ` is absent.`
              : `no entry contains those words. Meaning-based recall is unavailable on`
                + ` this server, so an entry phrased differently would not be found.`
                + ` Do not conclude the knowledge is absent.`,
        );
      }

      // ── Budgeted greedy body fill. Walk in RANK order and inline each body
      //    while it fits; a body that does NOT fit is SKIPPED (not a stop) so a
      //    single fat entry can't starve every smaller hit ranked below it.
      let used = 0;
      let truncatedCount = 0;
      const memories: MemorySearchEntry[] = [];
      for (const row of page) {
        const fits = row.size_bytes > 0 && used + row.size_bytes <= MEMORY_SEARCH_BUDGET_BYTES;
        if (fits) {
          const resolved = await store.get(row.memory_id);
          const body = resolved?.body;
          if (body !== undefined) {
            used += row.size_bytes;
            memories.push(projectMemoryEntry(row, body, false, author));
            continue;
          }
        }
        // Didn't fit (or has no body / the blob vanished) → preview + the id.
        if (row.size_bytes > 0) truncatedCount += 1;
        memories.push(projectMemoryEntry(row, undefined, row.size_bytes > 0, author));
      }

      const hasMore = filtered.length > offset + page.length;
      // Computed over the PAGE, after redaction + time filters — the set the
      // agent is actually looking at. Computing it in the store would describe
      // a ranking that a redacted top hit may have already invalidated.
      const margin = topMargin(page.map((r) => rankById.get(r.memory_id) ?? null));
      return {
        ok: true,
        result: {
          memories,
          budget: {
            limit_bytes: MEMORY_SEARCH_BUDGET_BYTES,
            used_bytes: used,
            truncated_count: truncatedCount,
          },
          ...(matchKind !== undefined ? { match: matchKind } : {}),
          ...(margin !== null ? { top_margin: margin } : {}),
          ...(hasMore ? { next_cursor: encodeMemoryCursor(offset + page.length) } : {}),
        },
      };
    } catch (e) {
      return executionError(errMessage(e));
    }
  };

// ────────────────────────────────────────────────────────────────
// memory.write — D-198 Slice 4 collective-memory write (contracted_user)
// ────────────────────────────────────────────────────────────────

/** D-198 §3 — the `core.memory.write` grant op the contract governs. */
export const MEMORY_WRITE_OP_ID = 'core.memory.write';

/** Gate a memory write on the governing contract's `core.memory.write` grant
 *  (mirrors `admitVendorWrite`): only `user_self` (owner chat — permissive by
 *  default) and `contracted_user` (a door the seller granted) may write; the
 *  gate fails closed when absent. The store always stamps `contracted_user` (§3
 *  origin-honesty — the AI writes under a contract; the owner's own direct
 *  webclient writes are the only `user_self` rows). */
const admitMemoryWrite = (
  gate: AiToolGrantGate | undefined,
  source: ExecutionSource | undefined,
): boolean =>
  gate !== undefined
  && source !== undefined
  && isAiToolPrincipal(gate, source)
  && gate.isOpGranted(source, MEMORY_WRITE_OP_ID);

/** D-198 Slice 4 — the live `memory.write` path (Fork 2 = A). "Remember this" in
 *  owner chat + (when a seller grants a tier) autonomous customer contributions,
 *  both writing `contracted_user` rows into the ONE pool via the store-backed
 *  adapter. Grant-gated (`core.memory.write`) — the enforcement boundary, NOT
 *  plan-approval (the tool is `classification: 'unknown'` so it bypasses P3;
 *  §3 soft writes). Reversible via the Memory lens redact. */
const createMemoryWriteHandler =
  (deps: ChatToolHandlerDeps, check = false): Tier1Handler =>
  async (raw, ctx) => {
    const store = deps.getUserMemoryStore?.();
    if (!store) return executionError('memory store unavailable');
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');

    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (summary.length === 0) {
      return invalidArgs('memory.write requires a non-empty summary');
    }
    // D-198 §10 — `replaces`: the id of an entry YOU saved that this one corrects.
    const replaces =
      typeof args.replaces === 'string' && args.replaces.trim().length > 0
        ? args.replaces.trim()
        : undefined;

    // Grant gate — the enforcement boundary (§3). Owner chat resolves to the
    // permissive owner contract; a door needs `core.memory.write` (default-off).
    // Fail closed → `classification_blocked` when ungranted / no source / no gate.
    if (!admitMemoryWrite(deps.getOpAdmissionGate?.(), ctx.execution_source)) {
      return {
        ok: false,
        reason: 'classification_blocked',
        detail: 'memory.write is not granted to this contract (write rejected)',
      };
    }

    // Session provenance rides from the dispatch ctx; origin is stamped
    // `contracted_user` by the adapter (never from the request — origin-honesty).
    const session: UserMemorySession = {};
    if (ctx.session_id !== undefined) session.channel_session_id = ctx.session_id;
    const contractId = ctx.execution_source
      ? executionSourceContractId(ctx.execution_source)
      : undefined;
    if (contractId !== undefined) session.contract_id = contractId;
    const hasSession = session.channel_session_id !== undefined || session.contract_id !== undefined;
    // D-198 §10 — the author contract, stamped on every row so a later replace or
    // forget can prove the entry is the caller's own.
    const author = ctx.execution_source ? authoringContractId(ctx.execution_source) : undefined;

    const body =
      typeof args.body === 'string' && args.body.length > 0 ? args.body : undefined;
    const provenance = Array.isArray(args.provenance_entity_ids)
      ? args.provenance_entity_ids.filter(
          (x): x is string => typeof x === 'string' && x.length > 0,
        )
      : [];
    const write = (replacing: string | undefined) =>
      createStoreBackedMemoryWriteAdapter({
        store,
        origin_actor: 'contracted_user',
        ...(hasSession ? { session } : {}),
        ...(author !== undefined ? { author_contract_id: author } : {}),
        ...(replacing !== undefined ? { replaces: replacing } : {}),
      }).write({
        kind: 'chat_memory',
        summary,
        reason_code: 'chat_write',
        ...(body !== undefined ? { payload: body } : {}),
        ...(provenance.length > 0 ? { provenance_entity_ids: provenance } : {}),
      });

    /** Why `target` cannot be replaced (D-198 §10), or `undefined` when it can. */
    const replaceRefusal = async (target: string): Promise<string | undefined> => {
      const forgotten = await forgottenIds(deps.getMemoryRedactionStore?.());
      const owned = await checkOwnEntry(store, forgotten, target, author);
      if (!owned.ok) {
        return owned.refusal === 'forgotten'
          ? `${owned.message}, so there is nothing to replace; save a new memory instead`
          : `${owned.message}. Leave it as it is; if it looks wrong, tell the user`;
      }
      const current = await currentVersionOf(store, forgotten, target);
      return current === target ? undefined
        : `'${target}' was already replaced by '${current}'; pass '${current}' as replaces instead`;
    };
    // D-329 — a check makes the write's own checks, `replaces` included, and stops before
    // it writes.
    if (check) {
      const refused = replaces === undefined ? undefined : await replaceRefusal(replaces);
      return refused === undefined ? WOULD_RUN : invalidArgs(refused);
    }
    try {
      if (replaces === undefined) {
        const result = await write(undefined);
        // Fan a `memory` refresh so paired Memory lenses live-update (§7.7).
        emitMemoryUser(deps.getEventBus?.(), result.memory_id);
        return { ok: true, result };
      }
      // D-198 §10 — check then write under the store's revision lock, so two
      // writes batched into one turn cannot both replace the same entry.
      const outcome = await withRevisionLock(store, async () => {
        const refused = await replaceRefusal(replaces);
        if (refused !== undefined) return { ok: false as const, refused };
        return { ok: true as const, result: await write(replaces) };
      });
      if (!outcome.ok) return invalidArgs(outcome.refused);
      emitMemoryUser(deps.getEventBus?.(), outcome.result.memory_id);
      return { ok: true, result: { ...outcome.result, replaces } };
    } catch (e) {
      return executionError(errMessage(e));
    }
  };

/** The longest `memory.forget` reason kept for the owner to read. */
const MEMORY_FORGET_REASON_MAX = 200;

/** D-198 §10 — `memory.forget`: an agent forgets an entry it saved, and the
 *  earlier versions that entry replaced. Gated by `core.memory.write`, like the
 *  write it reverses. Recorded on the redaction overlay with the forgetting
 *  contract, so the owner sees who forgot what and can restore it — which is
 *  why it stays `unknown` (no plan approval) like `memory.write`. */
const createMemoryForgetHandler =
  (deps: ChatToolHandlerDeps, check = false): Tier1Handler =>
  async (raw, ctx) => {
    const store = deps.getUserMemoryStore?.();
    const redactions = deps.getMemoryRedactionStore?.();
    if (!store || !redactions) return executionError('memory store unavailable');
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');
    const memoryId = typeof args.memory_id === 'string' ? args.memory_id.trim() : '';
    if (memoryId.length === 0) {
      return invalidArgs('memory.forget requires the memory_id of an entry you saved');
    }
    const stated = typeof args.reason === 'string' ? args.reason.trim() : '';
    const reason = stated.length > 0 ? stated.slice(0, MEMORY_FORGET_REASON_MAX) : undefined;

    if (!admitMemoryWrite(deps.getOpAdmissionGate?.(), ctx.execution_source)) {
      return {
        ok: false,
        reason: 'classification_blocked',
        detail: 'memory.forget is not granted to this contract (it needs the memory write grant)',
      };
    }
    const author = ctx.execution_source ? authoringContractId(ctx.execution_source) : undefined;
    const refused = (message: string): ChatDispatchResult =>
      invalidArgs(`${message}. Leave it as it is; if it should go, tell the user`);
    // D-329 — a check makes the forget's own checks and stops before it marks anything.
    if (check) {
      const checked = await checkForgetOwnEntry({ store, redactions, memory_id: memoryId, author });
      return checked.ok ? WOULD_RUN : refused(checked.message);
    }
    try {
      const outcome = await withRevisionLock(store, () => forgetOwnEntry({
        store,
        redactions,
        memory_id: memoryId,
        author,
        ...(reason !== undefined ? { reason } : {}),
        now: (deps.now ?? Date.now)(),
      }));
      if (!outcome.ok) return refused(outcome.message);
      if (outcome.result.versions > 0) emitMemoryUser(deps.getEventBus?.(), memoryId);
      return { ok: true, result: outcome.result };
    } catch (e) {
      return executionError(errMessage(e));
    }
  };

// ────────────────────────────────────────────────────────────────
// deal.search — D-137 P2 fan-out across HubSpot deals + Salesforce
// opportunities + future local `data.enrichment.deal.*` shape
// ────────────────────────────────────────────────────────────────

/** D-190 deal.search union slice — the json paths of the shared canonical deal
 *  filter fields in the materialized mirror `meta`. The supported v1 vocabulary is
 *  the universally-projected, vendor-neutral subset: `close_state` (every vendor
 *  materializes the derived tri-state) + the `close_date` window. (stage / owner are
 *  deferred — their VALUES are vendor-specific ids, so a cross-vendor filter on them
 *  is semantically vendor-scoped; amount likewise deferred.) */
const DEAL_CLOSE_STATE_META_PATH = '$.close_state';
const DEAL_CLOSE_DATE_META_PATH = '$.key_dates.close_date';

/** The accepted `close_state` values, single-sourced from the canonical CRM schema
 *  (D-190 Slice 2/3 — `'open' | 'won' | 'lost'`) so the handler's enum guard can't
 *  drift from the standard. */
const DEAL_CLOSE_STATES: ReadonlySet<string> = new Set(
  canonicalCrmField('deal', 'close_state')?.enum_values ?? [],
);

/** D-137 P2 — project a vendor deal meta snapshot into the unified
 *  `ChatDealCandidate` shape. Reads defensively against the open-
 *  vocabulary meta — vendors declare the canonical field set in
 *  `CONNECTION_VENDOR_ENTITIES` but partial / pre-refresh rows may
 *  omit fields. */
/** Read the nested numeric `key_dates.close_date` off a projected deal meta (the vendor
 *  entity declarations nest it under `key_dates`, mirrored in SQL as the
 *  `$.key_dates.close_date` json path). Used by both projection + live re-filter. */
const readDealCloseDate = (meta: Record<string, unknown>): number | undefined => {
  const keyDates = meta['key_dates'];
  if (keyDates && typeof keyDates === 'object' && !Array.isArray(keyDates)) {
    const close = (keyDates as Record<string, unknown>)['close_date'];
    if (isNumber(close)) return close;
  }
  return undefined;
};

/** D-206 — resolve a deal's DECLARED contact relationship.
 *
 *  🔑 **Declaration-driven, never hardcoded.** The field to read comes from
 *  `crmRefFields('deal')` — the canonical schema's own `ref` declarations — so a
 *  relationship added there lights up here with no change to this function. That is the
 *  whole point of declaring it rather than writing a resolver per vendor.
 *
 *  🔑 **And it stores NOTHING.** The deal's `contact_id` is the vendor's RAW record id;
 *  `contact_platform_link` already maps `(vendor, raw id) → the core contact`, durably and
 *  merge-safely. Two facts we already had, joined at read time. No edge is written.
 *
 *  🔴 **THE FENCE — and this is the first thing in the tree that actually crosses the two
 *  planes.** `deal` is NOT in `READABLE_COLLECTIONS`: the CRM plane runs on the
 *  connection's own authorization axis. But `contact` IS, and resolving a CRM record to
 *  *"your contact Bob"* reads the core contact graph. That is precisely the gate-crossing
 *  edge D-205 §3 was written for — the one that was MOOT until now only because nothing
 *  in the tree actually joined the planes.
 *
 *  So the core hop is gated on the `data.contact` grant, and the rule is D-205 §3's,
 *  verbatim: **`crm = yes, core = no` ⇒ the CRM record renders AS ITSELF** (its own
 *  `contact_id`), never as one of the user's people. **Do not resolve the link.**
 *
 *  ⚠ A refusal is FLAGGED, never silent (`contact_core_fenced`). An unexplained missing
 *  `contact` would be indistinguishable from *"this deal's contact is not one of your
 *  people"* — a claim about the user's DATA, which the model would state as fact. */
const resolveDealContactRef = (
  deps: ChatToolHandlerDeps,
  ctx: ChatDispatchContext,
  vendor: string,
  meta: Record<string, unknown>,
): Pick<ChatDealCandidate, 'contact_id' | 'contact' | 'contact_core_fenced'> => {
  // The DECLARATION decides which field carries the relationship — not this code.
  const ref = crmRefFields('deal').find((r) => r.entity === 'contact');
  if (ref === undefined) return {};
  const raw = meta[ref.field];
  // A vendor that does not model deal→contact as a property (HubSpot, Salesforce) simply
  // does not project the field. Absence is not a failure — it is that vendor saying it
  // has no property route, and the association route is a different substrate entirely.
  const vendorId = isString(raw) ? raw : isNumber(raw) ? String(raw) : undefined;
  if (vendorId === undefined || vendorId.length === 0) return {};

  // The vendor's own id is CRM-plane data on the CRM's own axis — always returned.
  const out: Pick<ChatDealCandidate, 'contact_id' | 'contact' | 'contact_core_fenced'> = {
    contact_id: vendorId,
  };

  // 🔴 The plane crossing. Refuse it, visibly, without the core-graph grant.
  if (!isCollectionReadGrantedForDispatch(deps, ctx, 'contact')) {
    out.contact_core_fenced = true;
    return out;
  }

  const store = deps.getContactStore();
  if (!store) return out;
  // The identity link — already durable, already written, already merge-safe.
  const email = store.lookupPlatformLink(vendor, vendorId);
  if (email === null) return out; // We LOOKED and there is no link. Not fenced — genuinely absent.
  const linked = store.get(email);
  if (!linked?.contact_id) return out;
  // ⚠ Through the merge chain to the TERMINAL survivor: the linked address may be a
  // tombstone, and the model must be handed the LIVE person, not a merged-away one. This
  // is exactly why identity is a durable link and not a read-time email join.
  const live = store.getByContactIdResolved(linked.contact_id);
  if (!live) return out;
  // `projectLocalContact` stamps the `contact` PII entity marker, so the nested record's
  // email / name are aliased by the D-167 egress walk like any other contact.
  out.contact = projectLocalContact(live as unknown as Record<string, unknown>);
  return out;
};

const projectPlatformDeal = (
  target_id: string,
  meta: Record<string, unknown>,
  refs: Pick<ChatDealCandidate, 'contact_id' | 'contact' | 'contact_core_fenced'> = {},
): ChatDealCandidate => {
  const name = isString(meta['name']) ? meta['name'] : target_id;
  const candidate: ChatDealCandidate = { name, target_id };
  if (isString(meta['stage'])) candidate.stage = meta['stage'];
  if (isNumber(meta['amount'])) candidate.amount = meta['amount'];
  if (isString(meta['owner'])) candidate.owner = meta['owner'];
  const close = readDealCloseDate(meta);
  if (close !== undefined) candidate.close_date = close;
  if (isString(meta['close_state'])) candidate.close_state = meta['close_state'];
  // D-206 — the declared relationship, resolved (and fenced) by the caller.
  if (refs.contact_id !== undefined) candidate.contact_id = refs.contact_id;
  if (refs.contact !== undefined) candidate.contact = refs.contact;
  if (refs.contact_core_fenced === true) candidate.contact_core_fenced = true;
  return markEntity(candidate, 'deal');
};

/** D-137 P2 § A.4 — platform-mirror deal source factory. D-190 — GENERIC over
 *  vendor: `source_id` is any bound CRM vendor and `scope` its mirror scope
 *  (`connection.api.<vendor>.<entity>` — HubSpot deal, Salesforce opportunity,
 *  Pipedrive deal, a pack-declared CRM's entity, …). Every vendor projects through
 *  the same `projectPlatformDeal` shape because the canonical `crm_alias:'deal'`
 *  projection (D-130 P7 / D-190) unifies them at the consumer layer. */
const buildPlatformDealSource = (
  deps: ChatToolHandlerDeps,
  // D-206 — the dispatch ctx, needed for the `data.contact` fence on the ref's CORE hop.
  // The source is the ONLY place that knows its vendor, and the fence needs both.
  ctx: ChatDispatchContext,
  source_id: string,
  scope: EnrichmentScope,
  // D-206 — the COMPLETE match count, accumulated across vendors for the reverse lookup.
  // The fan-out has no channel for a per-source total, and the total is the whole reason
  // the reverse door exists: a page without it is a truncated set that reads as the set.
  refTotal?: { value: number },
): ScopeSearchSource<ScopeSearchArgs, ChatDealCandidate> => ({
  id: source_id,
  query: async (args) => {
    // D-190 (generic reconciler MS3) — read the dedicated CRM record mirror, NOT
    // the producer-gated enrichment store. The reconciler + funnels write a mirror
    // row per CRM record unconditionally (MS2), so this surfaces EVERY deal — not
    // just AI-enriched ones (the pre-MS3 `listScopeMeta WHERE meta IS NOT NULL`
    // read hid un-enriched deals). `list`'s filter opts + `{scope,target_id,meta}`
    // row shape are identical to the old `listScopeMeta`, so the union-slice
    // close_state / close-date push-down below carries over verbatim.
    const store = deps.getCrmRecordMirror?.();
    if (!store) return [];

    // ── D-206 — the REVERSE lookup: this CONTACT's deals ──────────────────────────
    if (args.contact !== undefined && args.contact.length > 0) {
      // 🔴 The plane crossing, same as the forward resolver: resolving an email to one of
      // the user's own contacts READS the core graph. THROWS rather than returning [] — the
      // fan-out turns a throw into a NAMED `partial_failure`, while an empty list would be
      // indistinguishable from "this person has no deals": a claim about the user's DATA
      // that the model states as fact. Same invariant as `contact.search`'s local source.
      if (!isCollectionReadGrantedForDispatch(deps, ctx, 'contact')) {
        throw new Error(
          'the local contact graph is not read-granted to this contract (data.contact), so deals cannot be resolved for a contact',
        );
      }
      const contacts = deps.getContactStore();
      if (!contacts) throw new Error('contact store unavailable');
      const row = contacts.get(args.contact);
      // Through the merge chain — the caller may name a merged-away address, and the deals
      // hang off the LIVE person's vendor links.
      const live = row?.contact_id ? contacts.getByContactIdResolved(row.contact_id) : null;
      // Which of THIS vendor's records is that person? No link ⇒ this CRM does not know
      // them, and contributes nothing. (A genuine zero, not a truncation.)
      const platformId = live?.platform_ids?.find((p) => p.vendor === source_id)?.platform_id;
      if (platformId === undefined) return [];
      // The DECLARATION says which field to filter on — never hardcoded.
      const ref = crmRefFields('deal').find((r) => r.entity === 'contact');
      if (ref === undefined) return [];
      const { rows, total } = store.listByRef(scope, {
        field: ref.field,
        value: platformId,
        limit: args.limit,
      });
      if (refTotal) refTotal.value += total; // the COMPLETE count, across vendors
      const refScore = scoreForLookupKind('exact');
      return rows.map((r) => {
        const meta = r.meta as unknown as Record<string, unknown>;
        return {
          record: projectPlatformDeal(
            r.target_id,
            meta,
            resolveDealContactRef(deps, ctx, source_id, meta),
          ),
          score: refScore,
        };
      });
    }

    // Codex P3 review P1 fold #3 — synthesise per-candidate score
    // so the confidence-shape classifier sees real signal. Deal
    // search has no exact-id arg today (vendor target_ids are
    // rarely typed by Mary); `query` is fuzzy substring against
    // deal name. Bare listing collapses to LIST score → Pattern 3
    // refuse + show.
    const score = scoreForLookupKind(lookupKindForArgs(args));
    const rows = store.list(scope, {
      ...(args.query ? { name_contains: args.query } : {}),
      // D-190 union slice — push the canonical filters into the SAME mirror SQL.
      // On the materialized mirror close_state is a plain stored key, so the
      // live-API derived-field asymmetry doesn't apply here; LIMIT applies
      // post-filter so the per-source result honours both filter + cap.
      ...(args.close_state
        ? { meta_equals: [{ path: DEAL_CLOSE_STATE_META_PATH, value: args.close_state }] }
        : {}),
      ...(args.close_since !== undefined || args.close_until !== undefined
        ? {
            meta_ranges: [
              {
                path: DEAL_CLOSE_DATE_META_PATH,
                ...(args.close_since !== undefined ? { min: args.close_since } : {}),
                ...(args.close_until !== undefined ? { max: args.close_until } : {}),
              },
            ],
          }
        : {}),
      limit: args.limit,
    });
    return rows.map((r) => {
      const meta = r.meta as unknown as Record<string, unknown>;
      // D-206 — `source_id` IS the vendor for a CRM mirror source.
      return {
        record: projectPlatformDeal(
          r.target_id,
          meta,
          resolveDealContactRef(deps, ctx, source_id, meta),
        ),
        score,
      };
    });
  },
});

// ────────────────────────────────────────────────────────────────
// S3 — live escalation for stale / narrow-miss CRM connections
// ────────────────────────────────────────────────────────────────

/** Stale = no successful sync, OR older than 2× the (vendor-default) reconcile
 *  cadence. Per-connection cadence overrides are future work; the generic tier runs
 *  the 6h default, so 2× = 12h. */
const CRM_STALE_THRESHOLD_MS = 2 * 6 * 60 * 60 * 1000;

/** Local re-filter of a LIVE-fetched deal — matches against the RAW projected `meta`
 *  (NOT the candidate) so it mirrors `buildPlatformDealSource`'s mirror SQL EXACTLY:
 *  `LOWER(json_extract(meta,'$.name')) LIKE '%q%'` (no `target_id` fallback — a record
 *  with no `name` can't match, just as `json_extract` → NULL drops the row), close_state
 *  equality, and the `$.key_dates.close_date` numeric window. Matching the candidate
 *  instead would (a) let `projectPlatformDeal`'s name→`target_id` fallback match the
 *  composed id where the mirror would not. */
const matchesDeal = (
  meta: Record<string, unknown>,
  args: { query?: string; close_state?: string; close_since?: number; close_until?: number },
): boolean => {
  const name = meta['name'];
  if (args.query !== undefined
    && !(isString(name) && name.toLowerCase().includes(args.query.toLowerCase()))) return false;
  if (args.close_state !== undefined && meta['close_state'] !== args.close_state) return false;
  const close = readDealCloseDate(meta);
  if (args.close_since !== undefined && !(close !== undefined && close >= args.close_since)) return false;
  if (args.close_until !== undefined && !(close !== undefined && close <= args.close_until)) return false;
  return true;
};

/** Local re-filter of a LIVE-fetched contact — matches against the RAW projected `meta`
 *  so it mirrors `buildPlatformContactSource`'s mirror SQL EXACTLY: `email_exact` is
 *  `LOWER(json_extract(meta,'$.email')) = LOWER(?)` (CASE-INSENSITIVE — a raw `===` would
 *  reject `Jordan@…` vs `jordan@…` where the mirror matches) and `name_contains` is a
 *  case-insensitive LIKE on `$.name`. The platform contact source ONLY participates in
 *  identifier lookups (returns [] when neither email nor query is present), so the live
 *  leg keeps that gate — else a stale connection on a phone/company-only search would
 *  over-return EVERY contact. */
const matchesContact = (
  meta: Record<string, unknown>,
  args: { query?: string; email?: string },
): boolean => {
  if (args.query === undefined && args.email === undefined) return false;
  const email = meta['email'];
  if (args.email !== undefined
    && !(isString(email) && email.toLowerCase() === args.email.toLowerCase())) return false;
  const name = meta['name'];
  if (args.query !== undefined
    && !(isString(name) && name.toLowerCase().includes(args.query.toLowerCase()))) return false;
  return true;
};

/** S3 — escalate per bound connection to a LIVE vendor fetch when its mirror is STALE
 *  (`synced_at` null / older than 2× cadence) or a NARROW lookup MISSED (a narrow
 *  query/email is present but no mirror candidate came from that connection). For each
 *  escalated connection whose live fetch succeeds, its mirror candidates are REPLACED
 *  by freshly-fetched + locally-filtered live ones, and its `crm_freshness` flips to
 *  `filter_applied:'server'` + `synced_at:now`. A failed / unavailable live fetch keeps
 *  the mirror (graceful) as `'local'`. COLD (zero-row) connections are covered by STALE
 *  — a just-bound / never-reconciled connection has `synced_at:null`. The merge drop is
 *  gated on the PLATFORM source id (`source === vendor`) so a LOCAL `data.contact`
 *  candidate — whose `target_id` is the email and could COINCIDENTALLY start with a CRM
 *  prefix — is never dropped.
 *
 *  D-192 read resolution — the escalate/replace/restamp core is the neutral
 *  `applySourceLiveEscalation` (`source-mirror/live-escalation.ts`); this adapter
 *  keeps everything CRM: the 2×-cadence staleness verdict, the platform target-id
 *  prefix semantics (narrow-miss matches prefix only — the drop additionally gates
 *  on the source id), and the live fetch + `matches` re-filter + projection.
 *
 *  THE ADMISSION SEAM (D-192 CRM escalation parity — the work-entity seam's
 *  sibling): each ESCALATING unit runs the shared per-dispatch catalog-op
 *  admission (`admitSourceCatalogEscalation` → `admitCatalogOpForSource`:
 *  the snapshot's `allowed_tools` + `scope_restrictions` + op-risk probe, the
 *  D-188 pause freeze, `isOpGranted` on the declared `${entity}.search` op)
 *  BEFORE its live fetch — inside `fetchLive`, so only units the freshness
 *  trigger actually escalates are judged, and a refusal keeps the zero-invoke
 *  property. Channel posture lives in `escalation-admission.ts` (one home
 *  with the work-entity seam): an mcp_wire dispatch without source/snapshot/
 *  gate — or whose contract lacks the BACKING catalog tool — never reaches
 *  the vendor; owner chat gates on pause + an owner-contract op revoke.
 *  DELIBERATE asymmetry vs the work-entity seam (enumerated per the
 *  asymmetric-guards rule): a refusal here is SILENT-graceful — the unit
 *  keeps its mirror rows and `filter_applied: 'local'` + `synced_at` stay
 *  honest — because CRM escalation is freshness-driven, never
 *  model-requested (no named refusal copy to relay, no retry-loop to
 *  prevent; pre-seam vendor failures already degraded identically). An
 *  unresolvable catalog binding refuses external dispatches fail-closed and
 *  lets owner chat attempt (the poll's own config guards refuse the same
 *  key with family wording). Admitted fetches thread the dispatch origin
 *  verbatim (honest audit + per-actor `contract.override` tightening at the
 *  gateway — never the lying background `system` posture). */
const applyCrmLiveEscalation = async <
  T extends ChatDealCandidate | ChatContactCandidate | ChatAccountCandidate,
>(
  deps: ChatToolHandlerDeps,
  ctx: ChatDispatchContext,
  base: ScopeSearchResult<T>,
  freshness: ReadonlyArray<CrmConnectionFreshness>,
  opts: {
    narrowLookup: boolean;
    now: number;
    score: number;
    project: (target_id: string, meta: Record<string, unknown>) => T;
    /** Re-filter predicate over the RAW live `meta` (mirrors the mirror SQL exactly —
     *  see `matchesDeal` / `matchesContact`). Runs BEFORE projection. */
    matches: (meta: Record<string, unknown>) => boolean;
  },
): Promise<{ candidates: ScopeSearchCandidate<T>[]; crm_freshness: CrmConnectionFreshness[] }> => {
  const liveFetch = deps.getCrmLiveRecords;

  if (!liveFetch || freshness.length === 0) {
    // No live path → everything stays local.
    return {
      candidates: [...base.candidates],
      crm_freshness: freshness.map((f) => ({ ...f, filter_applied: 'local' as const })),
    };
  }

  const external = ctx.channel === 'mcp_wire';
  const origin = escalationOrigin(ctx);
  const admitUnit = (f: CrmConnectionFreshness): boolean => {
    const binding = deps.getCrmEscalationBinding?.(f.connection_name) ?? null;
    if (binding === null) return !external; // see the module note: fail-closed for doors
    const overlay = deps.getContractOverlay?.();
    return admitSourceCatalogEscalation(deps.getOpAdmissionGate?.(), ctx, {
      catalogSlug: binding.catalogSlug,
      manifest: binding.manifest,
      operation: `${f.entity}.search`,
      connectionName: f.connection_name,
    }, overlay === undefined ? undefined : (source, name) => overlay.admitsConnection(source, name)).admitted;
  };

  const units = freshness.map((f): SourceLiveEscalationUnit<ScopeSearchCandidate<T>> => {
    const prefix = `${f.vendor}_${f.entity}_${f.connection_name}_`;
    return {
      key: f.connection_name,
      stale: f.synced_at === null || opts.now - f.synced_at > CRM_STALE_THRESHOLD_MS,
      presentInBase: base.candidates.some((c) => c.record.target_id.startsWith(prefix)),
      owns: (c) => c.source === f.vendor && c.record.target_id.startsWith(prefix),
      fetchLive: async () => {
        // Admission before ANY vendor invoke (zero-invoke on refusal);
        // a refusal keeps the mirror exactly like a failed fetch.
        if (!admitUnit(f)) return null;
        const records = await liveFetch({
          vendor: f.vendor,
          entity: f.entity,
          connection_name: f.connection_name,
          origin,
        });
        if (records === null) return null; // failed / un-granted / unavailable → keep mirror
        const live: ScopeSearchCandidate<T>[] = [];
        for (const [nativeId, meta] of records) {
          if (!opts.matches(meta)) continue;
          const target_id = composePlatformRecordTargetId(f.vendor, f.entity, f.connection_name, nativeId);
          live.push({ source: f.vendor, record: opts.project(target_id, meta), score: opts.score });
        }
        return live;
      },
    };
  });

  const { candidates, escalated } = await applySourceLiveEscalation(
    base.candidates,
    units,
    { narrowLookup: opts.narrowLookup },
  );

  const crm_freshness = freshness.map((f) =>
    escalated.has(f.connection_name)
      ? { ...f, synced_at: opts.now, filter_applied: 'server' as const }
      : { ...f, filter_applied: 'local' as const });

  return { candidates, crm_freshness };
};

const createDealSearchHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => {
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');
    const limit = clampLimit(args.limit);
    const query = typeof args.query === 'string' ? args.query : undefined;
    // D-190 union slice — canonical deal filters (applied over the cross-vendor
    // mirror union). close_state is enum-validated up front so a bogus value fails
    // with the allowed list (substrate-support) rather than silently matching nothing.
    const close_state = typeof args.close_state === 'string' ? args.close_state : undefined;
    if (close_state !== undefined && !DEAL_CLOSE_STATES.has(close_state)) {
      return invalidArgs(
        `close_state must be one of: ${[...DEAL_CLOSE_STATES].join(', ')}`,
      );
    }
    const close_since = isNumber(args.close_since) ? args.close_since : undefined;
    const close_until = isNumber(args.close_until) ? args.close_until : undefined;
    // D-206 — the reverse relationship lookup: this CONTACT's deals.
    const contact = typeof args.contact === 'string' && args.contact.length > 0
      ? args.contact
      : undefined;
    const fanoutArgs: ScopeSearchArgs = {
      limit,
      ...(query ? { query } : {}),
      ...(contact ? { contact } : {}),
      ...(close_state ? { close_state } : {}),
      ...(close_since !== undefined ? { close_since } : {}),
      ...(close_until !== undefined ? { close_until } : {}),
    };
    // D-206 — the COMPLETE match count for the reverse lookup, summed across vendors.
    // ⚠ Reported ONLY on that path, and that is deliberate: it is the only query this tool
    // can back a completeness claim for. A free-text / stage query reads through `list()`,
    // which is hard-capped at 200 — so a `total` there would be a NUMBER WE CANNOT STAND
    // BEHIND, and the model would state it as fact. Absent means "not computed", never zero.
    const refTotal = { value: 0 };
    // D-190 — GENERIC cross-vendor fan-out: enumerate the user's BOUND CRM
    // connections (built-in or pack-declared `crm_alias:'deal'`) × the live vendor
    // registry, one mirror source per vendor scope — no hardcoded vendor list. A
    // user with no bound CRM gets zero sources (an empty result), and a pack CRM
    // joins the moment its connection is enrolled + its records mirror. (No `local`
    // source: `data.enrichment.deal.*` is a derived-entity layer, not a raw mirror;
    // the per-vendor mirror scopes ARE the `data.crm.deal.*` lens for chat.)
    const sources: ReadonlyArray<
      ScopeSearchSource<ScopeSearchArgs, ChatDealCandidate>
    > = (deps.getBoundCrmMirrorSources?.('deal') ?? []).map((s) =>
      buildPlatformDealSource(deps, ctx, s.source_id, s.scope, refTotal),
    );
    try {
      const result = await runScopeSearchFanout(fanoutArgs, sources);
      // S3 — live-escalate stale / narrow-miss connections (cold is covered by stale).
      // S1's per-connection freshness drives the decision; the result gains
      // `crm_freshness` (with `filter_applied` + a refreshed `synced_at` for live ones).
      const freshness = deps.getCrmConnectionFreshness?.('deal') ?? [];
      const escalated = await applyCrmLiveEscalation(deps, ctx, result, freshness, {
        narrowLookup: query !== undefined,
        now: Date.now(),
        score: scoreForLookupKind(lookupKindForArgs(fanoutArgs)),
        project: projectPlatformDeal,
        matches: (m) => matchesDeal(m, { query, close_state, close_since, close_until }),
      });
      const clamped = clampScopeSearchResult({ ...result, candidates: escalated.candidates }, limit);
      const augmented = augmentWithConfidenceShape(clamped, recencyKeyForDeal);
      return {
        ok: true,
        result: {
          ...augmented,
          crm_freshness: escalated.crm_freshness,
          // D-206 — the COMPLETE number of deals referencing this contact, across every
          // bound CRM. `candidates` is a bounded PAGE; this is the true size, so a
          // truncated page can never be mistaken for the whole set.
          ...(contact !== undefined ? { total: refTotal.value } : {}),
        },
      };
    } catch (e) {
      return executionError(errMessage(e));
    }
  };

// ────────────────────────────────────────────────────────────────
// account.search — D-190 fan-out across HubSpot companies + Salesforce
// accounts + Pipedrive organizations (every `crm_alias:'account'` entity)
// ────────────────────────────────────────────────────────────────

/** D-190 — project a platform-reference account meta snapshot into the unified
 *  `ChatAccountCandidate`. HubSpot company / Salesforce account / Pipedrive
 *  organization converge on `name` / `domain` / `industry` / `owner` /
 *  `num_employees` / `annual_revenue` per `CONNECTION_VENDOR_ENTITIES`; reads
 *  defensively (meta is open-vocabulary). Name falls back to `target_id` for
 *  display only — `matchesAccount` never searches the fallback. */
const projectPlatformAccount = (
  target_id: string,
  meta: Record<string, unknown>,
): ChatAccountCandidate => {
  const name = isString(meta['name']) ? meta['name'] : target_id;
  const candidate: ChatAccountCandidate = { name, target_id };
  if (isString(meta['domain'])) candidate.domain = meta['domain'];
  if (isString(meta['industry'])) candidate.industry = meta['industry'];
  if (isString(meta['owner'])) candidate.owner = meta['owner'];
  if (isNumber(meta['num_employees'])) candidate.num_employees = meta['num_employees'];
  if (isNumber(meta['annual_revenue'])) candidate.annual_revenue = meta['annual_revenue'];
  return markEntity(candidate, 'account');
};

/** D-190 — platform-mirror account source factory. GENERIC over vendor
 *  (`source_id` = any bound CRM vendor declaring a `crm_alias:'account'` entity;
 *  `scope` its `connection.api.<vendor>.<entity>` mirror scope). Reads the
 *  dedicated CRM record mirror so EVERY account surfaces, not just AI-enriched
 *  ones. Unlike contact, accounts are NOT identifier-gated — a bare account.search
 *  lists accounts (like deal.search); `query` (name substring) + `domain` (exact,
 *  case-insensitive) push down into the SAME mirror SQL. */
const buildPlatformAccountSource = (
  deps: ChatToolHandlerDeps,
  source_id: string,
  scope: EnrichmentScope,
): ScopeSearchSource<ScopeSearchArgs, ChatAccountCandidate> => ({
  id: source_id,
  query: async (args) => {
    const store = deps.getCrmRecordMirror?.();
    if (!store) return [];
    const score = scoreForLookupKind(lookupKindForArgs(args));
    const rows = store.list(scope, {
      ...(args.query ? { name_contains: args.query } : {}),
      ...(args.domain ? { domain_exact: args.domain } : {}),
      limit: args.limit,
    });
    return rows.map((r) => ({
      record: projectPlatformAccount(
        r.target_id,
        r.meta as unknown as Record<string, unknown>,
      ),
      score,
    }));
  },
});

/** Local re-filter of a LIVE-fetched account — matches the RAW projected `meta`
 *  (mirrors `buildPlatformAccountSource`'s mirror SQL EXACTLY): name substring
 *  (case-insensitive, NO `target_id` fallback) + `domain` exact (case-insensitive
 *  `LOWER(...)=LOWER(...)`). No identifier gate — a no-filter account search lists
 *  everything, so empty args match `true` (parity with `matchesDeal`). */
const matchesAccount = (
  meta: Record<string, unknown>,
  args: { query?: string; domain?: string },
): boolean => {
  const name = meta['name'];
  if (args.query !== undefined
    && !(isString(name) && name.toLowerCase().includes(args.query.toLowerCase()))) return false;
  const domain = meta['domain'];
  if (args.domain !== undefined
    && !(isString(domain) && domain.toLowerCase() === args.domain.toLowerCase())) return false;
  return true;
};

const createAccountSearchHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => {
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');
    const limit = clampLimit(args.limit);
    const query = typeof args.query === 'string' && args.query.length ? args.query : undefined;
    const domain = typeof args.domain === 'string' && args.domain.length ? args.domain : undefined;
    const fanoutArgs: ScopeSearchArgs = {
      limit,
      ...(query ? { query } : {}),
      ...(domain ? { domain } : {}),
    };
    // GENERIC cross-vendor fan-out (parity with deal.search): one mirror source
    // per BOUND CRM connection whose vendor declares a `crm_alias:'account'`
    // entity (built-in hb/sf/pd OR a pack-declared CRM), enumerated from the live
    // vendor registry — no hardcoded vendor list. No `local` source: there's no
    // `data.account` warehouse (the per-vendor mirror scopes ARE the account lens).
    const sources: ReadonlyArray<
      ScopeSearchSource<ScopeSearchArgs, ChatAccountCandidate>
    > = (deps.getBoundCrmMirrorSources?.('account') ?? []).map((s) =>
      buildPlatformAccountSource(deps, s.source_id, s.scope),
    );
    try {
      const result = await runScopeSearchFanout(fanoutArgs, sources);
      // S3 — live-escalate stale / narrow-miss connections (cold covered by stale).
      const freshness = deps.getCrmConnectionFreshness?.('account') ?? [];
      const escalated = await applyCrmLiveEscalation(deps, ctx, result, freshness, {
        narrowLookup: query !== undefined || domain !== undefined,
        now: Date.now(),
        score: scoreForLookupKind(lookupKindForArgs(fanoutArgs)),
        project: projectPlatformAccount,
        matches: (m) => matchesAccount(m, { query, domain }),
      });
      const clamped = clampScopeSearchResult({ ...result, candidates: escalated.candidates }, limit);
      const augmented = augmentWithConfidenceShape(clamped, recencyKeyForAccount);
      return { ok: true, result: { ...augmented, crm_freshness: escalated.crm_freshness } };
    } catch (e) {
      return executionError(errMessage(e));
    }
  };

// ────────────────────────────────────────────────────────────────
// enrichment.search
// ────────────────────────────────────────────────────────────────

const createEnrichmentSearchHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => {
    const store = deps.getEnrichmentStore();
    if (!store) return executionError('enrichment store unavailable');
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');
    const topic = typeof args.topic === 'string' ? args.topic : undefined;
    if (!topic) {
      // Substrate-support — a MISSING `topic` returns a GUIDED EMPTY result
      // (ok:true), NOT `invalid_args`. enrichment.search keys its read on a
      // topic, but answering a topic-less call with an error makes a tool-
      // looping agent RETRY blindly until the turn times out — observed live:
      // a capable model (qwen3.7-plus) loops on an abstract "what enrichment
      // do you have?" query; an inferior / local model fares worse (the
      // mission targets "any reasoning AI, incl. local"). Mirrors
      // memory.search, which never errors on a missing optional arg, and the
      // `wrapRecipeRunResult` precedent above (a failure shape "a model reads
      // as a silent failure → re-sends → loops"). The agent gets a usable
      // empty result + a hint to supply a topic (or fall through to a raw-
      // record search) and answers in one more turn. An UNKNOWN topic already
      // returns [] (the store's `list` guards with `isEnrichmentTopic`), so a
      // guessed topic doesn't loop either. See internal benchmarks
      // tasks/76-routing-enrichment-live.json.
      return {
        ok: true,
        result: {
          enrichments: [],
          hint:
            'enrichment.search needs a specific `topic` (a pre-computed-fact name, ' +
            'e.g. deal_health_score or engagement_velocity) — none was supplied, so ' +
            'nothing was searched. Re-call with a topic, ask the user which pre-computed ' +
            'fact they want, or use contact/mail/calendar/deal.search for raw records.',
        },
      };
    }
    // D-137 Trio #D Codex P1 fold — when dispatched over the MCP wire
    // (external AI agent), reject reads on topics declared
    // `mcp_exposed: 'private'` (registry default or per-pair user
    // override). Mirrors the legacy `enrichment-list` ingredient's
    // gate at `enrichment-handler.ts:175-187` so the read envelope is
    // identical across both MCP entry paths. Internal-channel
    // dispatches (Mary's own chat agent) skip the gate — user-
    // permissive by construction.
    const mcpRejection = mcpPrivateRejection(
      ctx,
      topic,
      deps.getReadGrantResolver?.(),
    );
    if (mcpRejection) return mcpRejection;
    const limit = clampLimit(args.limit);
    const scope =
      typeof args.scope === 'string' ? (args.scope as never) : undefined;
    const targetId =
      typeof args.target_id === 'string' ? args.target_id : undefined;
    try {
      const rows = store.list({
        topic,
        ...(scope ? { scope } : {}),
        ...(targetId ? { target_id: targetId } : {}),
        limit,
      });
      return { ok: true, result: { enrichments: rows } };
    } catch (e) {
      return executionError(errMessage(e));
    }
  };

// ────────────────────────────────────────────────────────────────
// recipe.run + Tier 2 dispatch (shared executor path)
// ────────────────────────────────────────────────────────────────

/** Validate + project a Tier-1 / Tier-2 args bundle into the shape
 *  `handleExecute` expects. `recipe_id_override` lets the Tier 2 path
 *  inject the slug parsed out of `<publisher>/<recipe_id>` rather than
 *  trust the AI to re-state it in args (the main turn already knows
 *  the tool name; making it re-state the slug invites drift).
 *
 *  Codex review P1 fold (2026-05-12) — when `recipeIdOverride` is set
 *  (Tier 2 path), `args.recipe` (inline definition) is dropped. The
 *  registered Tier 2 tool name pins ONE installed recipe whose
 *  manifest already passed the kind-gate + filter-tools selection;
 *  allowing the AI to substitute an inline definition would let it
 *  execute arbitrary recipes under the umbrella of a kind-gated tool
 *  name (`handleExecute` resolves inline `recipe` BEFORE `recipe_id`).
 *  The Tier 1 `recipe.run` path keeps both — that surface is the
 *  AI's escape hatch for ad-hoc recipes per § A.11.
 *
 *  D-153 P2.C — takes the dispatch `ctx` directly (not just
 *  `trigger_source`) so the producer-resolved `execution_source` +
 *  `contract_snapshot` thread onto the `ExecuteRequest`. The
 *  execute-handler's policy gate fires whenever `ctx.execution_source`
 *  is set AND `execution_source.channel` is in any of the gated sets
 *  (`POLICY_GATED_SYSTEM_CHANNELS`, `POLICY_GATED_USER_CHANNELS`,
 *  `POLICY_GATED_CONTRACT_CHANNELS`). Two producers thread the ctx
 *  through `buildExecuteRequest` today: the chat orchestrator's
 *  `buildInternalDispatchCtx` (chat user_self, no `contract_snapshot`)
 *  and the mcp wire's `handleToolCall` (mcp contracted_user, both
 *  fields). Producers that haven't been wired yet leave both undefined,
 *  and the request flows through without gating. `trigger_source`
 *  derives from `ctx.channel` via `channelTriggerSource(ctx)`. */
const buildExecuteRequest = (
  args: Record<string, unknown>,
  ctx: ChatDispatchContext,
  recipeIdOverride?: string,
  /** D-320 §3.5 — a Tier-2 call's flat args are the recipe's settings, so its
   *  `connections` (the run's choice of connection) is lifted out of them, unless
   *  the recipe declares a setting of that name: then it is that setting. */
  liftConnections = true,
): ExecuteRequest | string => {
  const recipeId =
    recipeIdOverride ??
    (typeof args.recipe_id === 'string' ? args.recipe_id : undefined);
  const inlineRecipe = recipeIdOverride === undefined ? args.recipe : undefined;
  if (!recipeId && !inlineRecipe) {
    return 'recipe_id or recipe is required';
  }
  if (
    recipeIdOverride !== undefined
    && (
      Object.prototype.hasOwnProperty.call(args, 'vault')
      || Object.prototype.hasOwnProperty.call(args, 'context')
    )
  ) {
    return 'Tier 2 recipe args cannot supply server-owned vault or execution context';
  }
  // Tier 2 (`recipeIdOverride` set) vs Tier 1 (`recipe.run`) read config
  // DIFFERENTLY, because their arg schemas differ. `deriveTier2ArgSchema`
  // (chat-catalog.ts) projects a Tier-2 recipe's `variables` as a FLAT arg
  // schema, so the model passes config values at the TOP LEVEL
  // (`{ to, body, … }`) — those args ARE the recipe config. The Tier-1
  // `recipe.run` umbrella instead documents the nested `{ recipe_id, config }`
  // envelope. Reading `args.config` on the Tier-2 path drops EVERY
  // model-supplied arg, running the recipe with empty config — a required
  // variable then resolves empty (e.g. a gated `mail-send` whose `to` is the
  // model's composed recipient executes, post-approval, with no recipient and
  // fails). So: Tier 2 → the flat args ARE the config; Tier 1 → the nested
  // `args.config` envelope.
  const tier2Connections = recipeIdOverride !== undefined
    && liftConnections
    && Object.prototype.hasOwnProperty.call(args, 'connections');
  const config =
    recipeIdOverride !== undefined
      ? (tier2Connections
          ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'connections'))
          : args)
      : args.config && typeof args.config === 'object' && !Array.isArray(args.config)
        ? (args.config as Record<string, unknown>)
        : undefined;
  // Checked in `handleExecute` (`readConnectionChoices`), which refuses a malformed
  // one in words the model can act on.
  const connections = recipeIdOverride !== undefined
    ? (tier2Connections ? args.connections : undefined)
    : args.connections;
  const vault =
    args.vault && typeof args.vault === 'object' && !Array.isArray(args.vault)
      ? (args.vault as Record<string, unknown>)
      : undefined;
  const context =
    args.context && typeof args.context === 'object' && !Array.isArray(args.context)
      ? (args.context as Record<string, unknown>)
      : undefined;
  return {
    ...(recipeId ? { recipe_id: recipeId } : {}),
    ...(inlineRecipe ? { recipe: inlineRecipe } : {}),
    ...(config ? { config } : {}),
    ...(vault ? { vault } : {}),
    ...(context ? { context } : {}),
    ...(connections !== undefined ? { connections: connections as Record<string, string> } : {}),
    trigger_source: channelTriggerSource(ctx),
    ...(ctx.execution_source ? { execution_source: ctx.execution_source } : {}),
    ...(ctx.contract_snapshot ? { contract_snapshot: ctx.contract_snapshot } : {}),
    // The I-7 hop token rides beside the source (D-160 P3): a messenger
    // turn's recipe dispatch runs at the turn's ingest depth, so the
    // Gateway's loop ceiling sees re-entrant fires truthfully.
    ...(ctx.dispatch_depth !== undefined ? { dispatch_depth: ctx.dispatch_depth } : {}),
  };
};

const createRecipeRunHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => {
    const execute = deps.getExecuteRecipe();
    if (!execute) return executionError('recipe executor unavailable');
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');
    // D-137 Trio #D Codex P1 fold — propagate channel to the execute
    // request so the engine's `gate_mcp_private` chain (enrichment
    // reads + timeline filter + redacted-blob path) gates correctly
    // when an external agent invokes `recipe.run` on an arbitrary
    // user recipe.
    //
    // D-153 P2.C — `buildExecuteRequest` now takes `ctx` directly so
    // it can also thread the mcp-wire-resolved `execution_source` +
    // `contract_snapshot` onto the request; the execute-handler's
    // policy gate fires when both are present.
    const req = buildExecuteRequest(args, ctx);
    if (typeof req === 'string') return invalidArgs(req);
    // Resolve `<publisher>/<recipe_id>` → bare recipe_id when the
    // store knows the bare form. Leaves inline `recipe` requests
    // alone (no recipe_id to resolve).
    if (req.recipe_id) {
      req.recipe_id = resolveRecipeId(req.recipe_id, deps.getRecipeStore());
    }
    if (ctx.channel === 'mcp_wire' && deps.preflightExternalRecipeDispatch) {
      const exposedRecipe = (req.recipe as RecipeDefinition | undefined)
        ?? (req.recipe_id ? deps.getRecipeStore().get(req.recipe_id) : null);
      if (exposedRecipe) {
        try {
          deps.preflightExternalRecipeDispatch(exposedRecipe);
        } catch (error) {
          return executionError(errMessage(error));
        }
      }
    }
    try {
      const result = await execute(req);
      return wrapRecipeRunResult(result);
    } catch (e) {
      return refusalOf(e);
    }
  };

/** Parse a Tier 2 tool name (`<publisher>/<recipe_id>`) into its
 *  components. Returns null when the shape doesn't match — the
 *  dispatcher uses this null to bail out with `unknown_tool` style
 *  failure (mapped to invalid_args here since the registry already
 *  resolved it as a Tier 2 entry; arriving with a malformed name
 *  indicates a contract violation upstream, not an unknown tool). */
const parseTier2ToolName = (
  toolName: string,
): { publisher_id: string; recipe_id: string } | null => {
  const slash = toolName.indexOf('/');
  if (slash <= 0 || slash === toolName.length - 1) return null;
  return {
    publisher_id: toolName.slice(0, slash),
    recipe_id: toolName.slice(slash + 1),
  };
};

export const createChatTier2Dispatch =
  (deps: ChatToolHandlerDeps): Tier2Handler =>
  async (toolName, raw, ctx) => {
    const parsed = parseTier2ToolName(toolName);
    if (!parsed) {
      return invalidArgs(
        `malformed Tier 2 tool name "${toolName}" — expected "<publisher>/<recipe_id>"`,
      );
    }
    const execute = deps.getExecuteRecipe();
    if (!execute) return executionError('recipe executor unavailable');
    const args = asObject(raw) ?? {};
    // Validate the recipe is actually installed (registry already
    // enumerated it; this catches uninstall-mid-turn races).
    const recipeStore = deps.getRecipeStore();
    const recipe = recipeStore.get(parsed.recipe_id);
    if (!recipe) {
      return executionError(
        `recipe "${parsed.recipe_id}" not found in store`,
      );
    }
    if (ctx.channel === 'mcp_wire' && deps.preflightExternalRecipeDispatch) {
      try {
        deps.preflightExternalRecipeDispatch(recipe);
      } catch (error) {
        return executionError(errMessage(error));
      }
    }
    // A date setting gets a date. The arg schema advertises `format: date` /
    // `date-time`, and until this only the contracted gateway checked it — the
    // owner's own chat handed the recipe whatever the model wrote.
    const dateIssue = recipeDateArgumentIssue(recipe, args);
    if (dateIssue !== null) return invalidArgs(dateIssue);
    // D-137 Trio #D Codex P1 fold — channel-aware trigger_source so
    // Tier 2 recipes invoked over MCP wire trip the same engine gates
    // as legacy `recued_runRecipe` would (the legacy path explicitly
    // sets `trigger_source: 'mcp'` at the `recued_runRecipe` switch
    // case — see `mcp-server.ts:617`).
    //
    // D-153 P2.C — `buildExecuteRequest` reads `execution_source` +
    // `contract_snapshot` straight off `ctx` so Tier 2 dispatches
    // reach the execute-handler's policy gate the same way Tier 1
    // `recipe.run` does.
    const req = buildExecuteRequest(
      args,
      ctx,
      parsed.recipe_id,
      !Object.prototype.hasOwnProperty.call(recipe.variables ?? {}, 'connections'),
    );
    if (typeof req === 'string') return invalidArgs(req);
    try {
      const result = await execute(req);
      return wrapRecipeRunResult(result);
    } catch (e) {
      return refusalOf(e);
    }
  };

// ────────────────────────────────────────────────────────────────
// Tier 3 dispatch (`<connection_name>.<mcp_tool_name>`)
// ────────────────────────────────────────────────────────────────

/** ⛔⛔ D-228 slice 4 — THE TIER-3 DISPATCH IS GONE, and its absence is the
 *  point.
 *
 *  It resolved `<connection>.<tool>` against `tool_overrides` — the chat
 *  PRESENTATION store — and dispatched through the `connection-mcp-*` kernel
 *  slugs at whatever tier the owner had typed there. D-225 named that surface as
 *  the standing defect: one enrolled MCP tool was reachable from chat twice,
 *  through two different gates, so the owner's single decision about it was
 *  enforced by whichever one the model happened to pick.
 *
 *  🔑 The replacement was already live before this deletion: the tool's
 *  generated pack operation, in the catalog as `recued_op_*`, governed by the
 *  contract and dispatched by `createChatRawOpDispatch`. Slice 3 stood Tier-3
 *  down per tool as packs covered them; this removes what was left.
 *
 *  ⚠ `Tier3Handler` still exists in the registry's vocabulary and this file no
 *  longer supplies one. That is deliberate — see `buildChatToolRegistryInputs`. */

// ────────────────────────────────────────────────────────────────
// work.search / work.read — D-192 read-resolution consumers. Thin
// adapters over the neutral core (`work-entity-read-tools.ts`). Read
// authority is the contract: `core.work-entity.read` (owner-on /
// door-off) ∧ the `data.<kind>` collection grant, both applied here.
// The former per-channel exposure axis (`mcp_wire` → `mcp_exposed`-
// filtered, owner chat → ungated) is GONE with the flag itself
// (D-187 Sources half); both channels resolve the same two grants.
// ────────────────────────────────────────────────────────────────

/** The `core.work-entity.read` grant op governing the Tier-1 work READ tools. */
export const WORK_ENTITY_READ_OP_ID = 'core.work-entity.read';

/** Admit a `work.search` / `work.read` dispatch on the governing contract's
 *  `core.work-entity.read` grant. A verbatim sibling of `admitMemoryRead` —
 *  same actors, same fail-closed posture, same owner-permissive resolution:
 *  owner chat arrives `(chat, user_self)` with NO `contract_id`, so the op
 *  author-default admits it; a door arrives `(mcp, contracted_user)` with one
 *  and needs the explicit grant (`OWNER_DEFAULT_ONLY_GRANT_ENTRIES`).
 *
 *  Fails closed on an absent gate or source. ⚠ That is SAFE for owner chat only
 *  because `buildInternalDispatchCtx` always populates `execution_source`
 *  (falling back to `buildChatExecutionSource` → `user_self`) — the
 *  `ChatDispatchContext.execution_source` doc's "undefined on
 *  internal_function_call today" is STALE. If that fallback is ever removed,
 *  owner chat silently loses its work reads through this predicate. */
const admitWorkEntityRead = (
  gate: AiToolGrantGate | undefined,
  source: ExecutionSource | undefined,
): boolean =>
  gate !== undefined
  && source !== undefined
  && isAiToolPrincipal(gate, source)
  && gate.isOpGranted(source, WORK_ENTITY_READ_OP_ID);

/** The per-kind create op the `work.create` tool gates on. Keyed by kind rather
 *  than one umbrella op so the grant the owner sees in Contracts is the same
 *  vocabulary the kernel and the recipes already use
 *  (`core.work-entity.task.create`), and so granting "may add notes" to a door
 *  never also grants "may add commitments". */
export const WORK_ENTITY_CREATE_OP_ID: Readonly<Record<WorkCreateKind, string>> = {
  task: 'core.work-entity.task.create',
  note: 'core.work-entity.note.create',
  commitment: 'core.work-entity.commitment.create',
  project: 'core.work-entity.project.create',
};
/** D-325 — `work.create` of an `asset` (2026-10-24), `work.type`, which describes a
 *  type for that create, and `work.update` of one (2026-10-25). An asset is kept apart
 *  from `WorkCreateKind` because it takes its own arguments, on its own path in both
 *  tools (`createAssetFromChat`, `updateAssetFromChat`). */
export const ASSET_CREATE_OP_ID = 'core.work-entity.asset.create';
export const ASSET_UPDATE_OP_ID = 'core.work-entity.asset.update';

/** Mirrors {@link admitWorkEntityRead} on the write side — same shape, same
 *  fail-closed posture, different op. The tool is `classification: 'unknown'`
 *  (it bypasses P3 plan-approval by design, see the note in `chat.ts`), so THIS
 *  is the enforcement boundary and nothing else stands behind it. */
const admitWorkEntityCreate = (
  gate: AiToolGrantGate | undefined,
  source: ExecutionSource | undefined,
  kind: WorkCreateKind | 'asset',
): boolean =>
  gate !== undefined
  && source !== undefined
  && isAiToolPrincipal(gate, source)
  && gate.isOpGranted(source, kind === 'asset' ? ASSET_CREATE_OP_ID : WORK_ENTITY_CREATE_OP_ID[kind]);

/** The narrow slice of `KernelDispatchers` the two calendar write tools need.
 *  Declared here rather than importing the whole dispatcher bag so the chat
 *  layer states exactly what it reaches for. */
export interface CalendarWriteDeps {
  readonly calendarCreate: (input: {
    slug: string;
    calendar_id: string;
    event: Record<string, unknown>;
  }) => Promise<{ source_id: string; ical_uid: string }>;
  readonly calendarUpdate: (input: {
    slug: string;
    source_id: string;
    patch: Record<string, unknown>;
  }) => Promise<{ source_id: string }>;
  /** D-329 — what each write checks before it calls the calendar, asked before the owner
   *  is: it throws that write's own refusal. Absent ⇒ the arguments' checks alone. */
  readonly checkCalendarCreate?: (input: { slug: string }) => void;
  readonly checkCalendarUpdate?: (input: {
    slug: string;
    source_id: string;
    patch: Record<string, unknown>;
  }) => void;
}

export const WORK_ENTITY_UPDATE_OP_ID: Readonly<Record<WorkCreateKind, string>> = {
  task: 'core.work-entity.task.update',
  note: 'core.work-entity.note.update',
  commitment: 'core.work-entity.commitment.update',
  project: 'core.work-entity.project.update',
};

/** ⛔ `done` HAS ITS OWN OP AND ITS OWN DISPATCHER, and that is a substrate
 *  decision this tool must respect rather than paper over. `work-entities.ts`
 *  states it: *"`state` never auto-flips `done`: `done` stays the single
 *  completion bit (mark-done dispatcher + `completed` reactive events)"*.
 *  `handleWorkEntityUpsert` does not carry a `done` field AT ALL — routing a
 *  completion through it would silently drop the claim. */
export const TASK_MARK_DONE_OP_ID = 'core.work-entity.task.mark-done';

/** Slice 3 — `work.update`. Two paths behind one tool, because the model should
 *  not have to know which verb the substrate files a change under.
 *
 *  ⛔ A MIXED CALL IS REFUSED rather than split into two dispatches. `done` and a
 *  field edit are different ops with different grants; running both would mean
 *  two gates, two writes, and a half-applied change when the second fails —
 *  reported to the owner as one confirmed action. Doing one thing per call keeps
 *  the approval card honest about what it approved. */
const createWorkUpdateHandler =
  (deps: ChatToolHandlerDeps, check = false): Tier1Handler =>
  async (raw, ctx) => {
    const crud = deps.getWorkEntityCrudDeps?.();
    if (!crud) return executionError('work-entity write path unavailable');
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');

    const kind = args.kind;
    if (kind === 'asset') return updateAssetFromChat(deps, args, ctx, check);
    if (!isWorkCreateKind(kind)) {
      return invalidArgs(
        `work.update requires kind to be one of ${[...WORK_CREATE_KINDS, 'asset'].join(' / ')}`,
      );
    }
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (id.length === 0) {
      return invalidArgs('work.update requires the id of the row to change');
    }
    for (const name of ['dates', 'readings', 'attributes', 'place', 'belongs_to'] as const) {
      if (args[name] !== undefined) return invalidArgs(`work.update: \`${name}\` applies to an asset only`);
    }

    // ⛔ EVERY FIELD GOES WHERE ITS KIND KEEPS IT, OR IS REFUSED. A dispatcher
    // ignores a field it does not have, and this tool reported each such field as
    // changed: a project's `body` (it keeps a `description`), a commitment's
    // `title` (its words are its `statement`), a date on the wrong kind, a note's
    // or a commitment's `state`. Nothing changed; the model was told it had.
    // `patch` is in the dispatcher's words, `changed` in the tool's.
    const patch: Record<string, unknown> = {};
    const changed: string[] = [];
    const put = (argName: string, field: string, value: unknown): void => {
      patch[field] = value;
      changed.push(argName);
    };
    const noPlace = (field: string, hint = ''): ChatDispatchResult =>
      invalidArgs(`work.update: a ${kind} has no \`${field}\`${hint}`);
    const wrongDate = (field: string, owner: WorkCreateKind): ChatDispatchResult =>
      wrongKindDate('work.update', field, owner, kind);

    if (typeof args.title === 'string' && args.title.trim().length > 0) {
      put('title', kind === 'commitment' ? 'statement' : 'title', args.title.trim());
    }
    if (typeof args.body === 'string') {
      if (kind === 'commitment') return noPlace('body', ' — what was promised is its `title`');
      put('body', kind === 'project' ? 'description' : 'body', args.body);
    }
    if (typeof args.state === 'string' && args.state.trim().length > 0) {
      if (kind === 'note' || kind === 'commitment') return noPlace('state');
      put('state', 'state', args.state.trim());
    }
    if (typeof args.due_at === 'number' && Number.isFinite(args.due_at)) {
      if (kind !== 'task') return wrongDate('due_at', 'task');
      put('due_at', 'due_at', args.due_at);
    }
    if (args.clear_due_at === true) {
      if (kind !== 'task') return wrongDate('clear_due_at', 'task');
      if (patch.due_at !== undefined) {
        return invalidArgs('work.update: send a new `due_at` or `clear_due_at`, not both');
      }
      // A task's `null` means "not given", so its removal is a flag.
      put('clear_due_at', 'clear_due_at', true);
    }
    // A project's target is a DAY, so it is asked for as one — no time for the
    // model to invent, no zone to guess — and stored as its UTC midnight, the
    // due-day convention. A project's `null` removes it.
    if (args.target_completion_at !== undefined) {
      if (kind !== 'project') return wrongDate('target_completion_at', 'project');
      const day = typeof args.target_completion_at === 'string'
        ? calendarDayMs(args.target_completion_at.trim())
        : null;
      if (day === null) {
        return invalidArgs('work.update: `target_completion_at` must be a date as YYYY-MM-DD');
      }
      put('target_completion_at', 'target_completion_at', day);
    }
    if (args.clear_target_completion_at === true) {
      if (kind !== 'project') return wrongDate('clear_target_completion_at', 'project');
      if (patch.target_completion_at !== undefined) {
        return invalidArgs(
          'work.update: send a new `target_completion_at` or `clear_target_completion_at`, not both',
        );
      }
      put('clear_target_completion_at', 'target_completion_at', null);
    }
    // A promise is for a day ("by Friday") or, now and then, an exact time — so
    // either, but never a time without its zone, which names no instant.
    if (args.promised_for_at !== undefined) {
      if (kind !== 'commitment') return wrongDate('promised_for_at', 'commitment');
      const when = typeof args.promised_for_at === 'string'
        ? unambiguousDateMs(args.promised_for_at)
        : null;
      if (when === null) {
        return invalidArgs(
          'work.update: `promised_for_at` must be a date as YYYY-MM-DD, or a time with its offset',
        );
      }
      put('promised_for_at', 'promised_for_at', when);
    }
    if (args.clear_promised_for_at === true) {
      if (kind !== 'commitment') return wrongDate('clear_promised_for_at', 'commitment');
      if (patch.promised_for_at !== undefined) {
        return invalidArgs('work.update: send a new `promised_for_at` or `clear_promised_for_at`, not both');
      }
      // A commitment's `null` removes its date.
      put('clear_promised_for_at', 'promised_for_at', null);
    }
    const marksDone = typeof args.done === 'boolean';

    if (marksDone && kind !== 'task') {
      return invalidArgs('work.update: `done` applies to a task only');
    }
    if (marksDone && changed.length > 0) {
      return invalidArgs(
        'work.update: send `done` on its own — a completion and a field edit are separate changes',
      );
    }
    // Same reasoning as `calendar.update`: an empty change would pass the
    // owner's approval card, dispatch, alter nothing and report success.
    if (!marksDone && changed.length === 0) {
      return invalidArgs(
        'work.update: send at least one field to change (done / title / body / state / due_at / clear_due_at / '
          + 'target_completion_at / clear_target_completion_at / promised_for_at / clear_promised_for_at)',
      );
    }

    const opId = marksDone ? TASK_MARK_DONE_OP_ID : WORK_ENTITY_UPDATE_OP_ID[kind];
    if (!admitWriteOp(deps.getOpAdmissionGate?.(), ctx.execution_source, opId)) {
      return {
        ok: false,
        reason: 'classification_blocked',
        detail: `work.update is not granted to this contract for ${kind} (write rejected)`,
      };
    }

    if (check) return WOULD_RUN;
    try {
      if (marksDone) {
        if (!(crud.dispatchers as { taskMarkDone?: unknown }).taskMarkDone) {
          return executionError('work.update: mark-done dispatcher unavailable');
        }
        // ⛔ THROUGH THE GUARD, NOT THE RAW DISPATCHER. Holding
        // `dispatchers.taskMarkDone` directly skips the per-task lock the
        // webclient's Today toggle takes, and re-stamps `completed_at` when the
        // owner says "mark it done" on a task that already is.
        await guardTaskMarkDone(crud, { id, done: args.done as boolean });
        return { ok: true, result: { updated: true, kind, id, done: args.done as boolean } };
      }
      await handleWorkEntityUpsert(
        crud,
        { kind, id, ...patch } as unknown as Parameters<typeof handleWorkEntityUpsert>[1],
        ctx.execution_source,
      );
      return {
        ok: true,
        result: { updated: true, kind, id, fields: changed },
      };
    } catch (e) {
      return executionError(
        `work.update failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

/** The answer a check gets for a `work.create` or `work.update` call that would run. */
const WOULD_RUN: ChatDispatchResult = Object.freeze({ ok: true, result: { would_run: true } });

/** D-329 — a held write's own check, asked before the owner is: its handler in its check
 *  mode, which makes every check the write makes and stops just before it writes. `null`
 *  when it would run. */
const checkedBy = (
  handler: (deps: ChatToolHandlerDeps, check: boolean) => Tier1Handler,
  deps: ChatToolHandlerDeps,
) => async (raw: unknown, ctx: ChatDispatchContext): Promise<ChatDispatchResult | null> => {
  const checked = await handler(deps, true)(raw, ctx);
  return checked === WOULD_RUN ? null : checked;
};

/** D-329 — what a `work.update` call would be refused for, asked before the owner is
 *  asked to approve it: the handler's own checks, stopped just before the write (for an
 *  asset, its dispatcher's checks too, then rolled back). `null` when it would run. */
export const checkWorkUpdate = async (
  deps: ChatToolHandlerDeps,
  raw: unknown,
  ctx: ChatDispatchContext,
): Promise<ChatDispatchResult | null> => {
  const checked = await createWorkUpdateHandler(deps, true)(raw, ctx);
  return checked === WOULD_RUN ? null : checked;
};

export const CALENDAR_CREATE_OP_ID = 'core.data.calendar.create';
export const CALENDAR_UPDATE_OP_ID = 'core.data.calendar.update';

/** The shared op-grant gate for every `classification: 'write'` Tier-1 tool —
 *  both calendar writes and `work.update`.
 *
 *  ⚠ RENAMED FROM `admitCalendarWrite` IN SLICE 3. It was calendar-specific for
 *  exactly one slice, and the second caller made the name a lie: a predicate
 *  named for its first caller invites the next one to write a near-identical
 *  twin rather than reuse it.
 *
 *  ⚠ NOTE what it defends and what it does NOT: `work.create` is
 *  `classification: 'unknown'`, so its grant is the ONLY gate. These tools are
 *  `'write'`, so the owner also sees a plan-approval card — two gates, not one.
 *  The grant still runs FIRST, so an ungranted door never gets to propose. */
const admitWriteOp = (
  gate: AiToolGrantGate | undefined,
  source: ExecutionSource | undefined,
  opId: string,
): boolean =>
  gate !== undefined
  && source !== undefined
  && isAiToolPrincipal(gate, source)
  && gate.isOpGranted(source, opId);

/** Slice 2 — `calendar.create`. Defaults to the LOCAL calendar, which the boot
 *  wiring auto-creates and which declares `create_event: 'yes'` with
 *  `auth: 'none'`, so this works on a machine that has never seen an account. */
const createCalendarCreateHandler =
  (deps: ChatToolHandlerDeps, check = false): Tier1Handler =>
  async (raw, ctx) => {
    const cal = deps.getCalendarWriteDeps?.();
    if (!cal) return executionError('calendar write path unavailable');
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');

    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (summary.length === 0) return invalidArgs('calendar.create requires a summary');
    const start = typeof args.start_at === 'number' ? args.start_at : NaN;
    const end = typeof args.end_at === 'number' ? args.end_at : NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return invalidArgs('calendar.create requires numeric start_at and end_at (Unix ms)');
    }
    // ⛔ Refused here rather than at the provider. An inverted window is not a
    // provider-shaped error — it is a misread instruction, and the model can fix
    // it if told plainly. Some providers would accept it and render nothing.
    if (end <= start) {
      return invalidArgs('calendar.create: end_at must be after start_at');
    }
    const timezone = typeof args.timezone === 'string' ? args.timezone.trim() : '';
    if (timezone.length === 0) {
      return invalidArgs('calendar.create requires an IANA timezone (do not assume UTC)');
    }

    if (!admitWriteOp(deps.getOpAdmissionGate?.(), ctx.execution_source, CALENDAR_CREATE_OP_ID)) {
      return {
        ok: false,
        reason: 'classification_blocked',
        detail: 'calendar.create is not granted to this contract (write rejected)',
      };
    }

    const slug = typeof args.calendar_id === 'string' && args.calendar_id.trim().length > 0
      ? args.calendar_id.trim()
      : DEFAULT_LOCAL_CALENDAR_SLUG;
    // D-329 — a check makes the write's own checks, its calendar's included, and stops
    // before it calls the calendar.
    if (check) {
      try { cal.checkCalendarCreate?.({ slug }); }
      catch (e) { return invalidArgs(`calendar.create: ${e instanceof Error ? e.message : String(e)}`); }
      return WOULD_RUN;
    }
    try {
      const { source_id } = await cal.calendarCreate({
        slug,
        calendar_id: DEFAULT_LOCAL_CALENDAR_ID,
        event: {
          calendar_id: DEFAULT_LOCAL_CALENDAR_ID,
          summary,
          ...(typeof args.description === 'string' && args.description.length > 0
            ? { description: args.description }
            : {}),
          start_at: start,
          end_at: end,
          timezone,
          is_all_day: args.is_all_day === true,
          status: 'confirmed',
        },
      });
      return { ok: true, result: { created: true, source_id, calendar: slug } };
    } catch (e) {
      return executionError(
        `calendar.create failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

/** Slice 2 — `calendar.update`. PATCH semantics: only the fields sent change. */
const createCalendarUpdateHandler =
  (deps: ChatToolHandlerDeps, check = false): Tier1Handler =>
  async (raw, ctx) => {
    const cal = deps.getCalendarWriteDeps?.();
    if (!cal) return executionError('calendar write path unavailable');
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');

    let normalized: ReturnType<typeof calendarChatUpdateInput>;
    try { normalized = calendarChatUpdateInput(args); }
    catch (error) { return invalidArgs(error instanceof Error ? error.message : String(error)); }
    const { slug, source_id: sourceId, patch } = normalized;

    if (!admitWriteOp(deps.getOpAdmissionGate?.(), ctx.execution_source, CALENDAR_UPDATE_OP_ID)) {
      return {
        ok: false,
        reason: 'classification_blocked',
        detail: 'calendar.update is not granted to this contract (write rejected)',
      };
    }

    // D-329 — a check makes the write's own checks, its calendar's included: the event is
    // there, and the change leaves it ending after it starts.
    if (check) {
      try { cal.checkCalendarUpdate?.({ slug, source_id: sourceId, patch }); }
      catch (e) { return invalidArgs(`calendar.update: ${e instanceof Error ? e.message : String(e)}`); }
      return WOULD_RUN;
    }
    try {
      const { source_id } = await cal.calendarUpdate({ slug, source_id: sourceId, patch });
      return {
        ok: true,
        result: { updated: true, source_id, calendar: slug, fields: Object.keys(patch) },
      };
    } catch (e) {
      return executionError(
        `calendar.update failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

const WORK_CREATE_KINDS = ['task', 'note', 'commitment', 'project'] as const;
type WorkCreateKind = (typeof WORK_CREATE_KINDS)[number];

/** Each kind's one date — named when a date is sent to the wrong kind. */
const WORK_DATE_FIELD: Readonly<Record<WorkCreateKind, string | undefined>> = {
  task: 'due_at', project: 'target_completion_at', commitment: 'promised_for_at', note: undefined,
};
const wrongKindDate = (tool: string, field: string, owner: WorkCreateKind, kind: WorkCreateKind) =>
  invalidArgs(
    `${tool}: \`${field}\` applies to a ${owner} only`
    + (WORK_DATE_FIELD[kind] !== undefined
      ? ` — a ${kind}'s date is \`${WORK_DATE_FIELD[kind]}\``
      : ` — a ${kind} has no date`),
  );
/** A canonical email — the key a contact is kept under. A name is not one. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const isWorkCreateKind = (v: unknown): v is WorkCreateKind =>
  typeof v === 'string' && (WORK_CREATE_KINDS as readonly string[]).includes(v);

/** Slice 1 — the local zero-config write. Creates one `task` / `note` /
 *  `commitment` / `project` in the owner's own work graph through the SAME
 *  `handleWorkEntityUpsert` the webclient's own Create button uses, so there is
 *  one validation path, one dispatcher and one audit story rather than a chat
 *  shortcut beside them.
 *
 *  ⛔ `execution_source` is passed as the `callerSource` that handler documents
 *  as "SERVER-DERIVED … never caller-supplied". A chat turn's source IS
 *  server-derived (the orchestrator builds it from the authenticated channel),
 *  which is exactly the contract that argument wants. It is NOT read from the
 *  model's arguments, and the handler strips any forged `origin_execution_source`
 *  off the wire regardless. */
const createWorkCreateHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => workCreate(deps, raw, ctx);

/** D-329 — what a `work.create` call would be refused for, asked before the owner is asked
 *  to approve it (the registry's `checkBeforeAsking`): the handler's own checks, stopped
 *  just before the write, so the check and the run cannot disagree. `null` when it would
 *  run. ⛔ Found live (2026-10-25): an AI sent an asset's details as `body`, the owner
 *  approved, and only then did the create refuse `body`. */
export const checkWorkCreate = async (
  deps: ChatToolHandlerDeps,
  raw: unknown,
  ctx: ChatDispatchContext,
): Promise<ChatDispatchResult | null> => {
  const checked = await workCreate(deps, raw, ctx, true);
  return checked === WOULD_RUN ? null : checked;
};

const workCreate = async (
  deps: ChatToolHandlerDeps,
  raw: unknown,
  ctx: ChatDispatchContext,
  check = false,
): Promise<ChatDispatchResult> => {
  const crud = deps.getWorkEntityCrudDeps?.();
  if (!crud) return executionError('work-entity write path unavailable');
  const args = asObject(raw);
  if (!args) return invalidArgs('args must be an object');

  const kind = args.kind;
  if (kind === 'asset') return createAssetFromChat(deps, args, ctx, check);
  if (!isWorkCreateKind(kind)) {
    return invalidArgs(
      `work.create requires kind to be one of ${[...WORK_CREATE_KINDS, 'asset'].join(' / ')}`,
    );
  }
  for (const name of ['type', 'dates', 'readings', 'holder_email', 'attributes', 'place', 'belongs_to'] as const) {
    if (args[name] !== undefined) return invalidArgs(`work.create: \`${name}\` applies to an asset only`);
  }

  const title = typeof args.title === 'string' ? args.title.trim() : '';
  const body = typeof args.body === 'string' ? args.body.trim() : '';
  // A note IS its body; everything else is identified by its title. Refusing
  // here rather than at the dispatcher keeps the model's error specific to the
  // field it actually omitted.
  if (kind === 'note' ? body.length === 0 : title.length === 0) {
    return invalidArgs(
      kind === 'note'
        ? 'work.create requires a non-empty body for a note'
        : `work.create requires a non-empty title for a ${kind}`,
    );
  }

  if (!admitWorkEntityCreate(deps.getOpAdmissionGate?.(), ctx.execution_source, kind)) {
    return {
      ok: false,
      reason: 'classification_blocked',
      detail: `work.create is not granted to this contract for ${kind} (write rejected)`,
    };
  }

  // ⛔ EVERY FIELD GOES WHERE ITS KIND KEEPS IT, OR IS REFUSED — as in
  // `work.update`. A create dispatcher ignores what it does not have: a
  // project's `body` and date were dropped behind `created: true`, and a
  // commitment could not be created at all (no direction, no derivation, its
  // words not in `statement`). `input` is in the dispatcher's words, `fields`
  // in the tool's.
  const input: Record<string, unknown> = { kind };
  const fields: string[] = [];
  const put = (argName: string, field: string, value: unknown): void => {
    input[field] = value;
    fields.push(argName);
  };
  if (title.length > 0) put('title', kind === 'commitment' ? 'statement' : 'title', title);
  if (body.length > 0) {
    if (kind === 'commitment') {
      return invalidArgs('work.create: a commitment has no `body` — what was promised is its `title`');
    }
    put('body', kind === 'project' ? 'description' : 'body', body);
  }
  if (typeof args.due_at === 'number' && Number.isFinite(args.due_at)) {
    if (kind !== 'task') return wrongKindDate('work.create', 'due_at', 'task', kind);
    put('due_at', 'due_at', args.due_at);
  }
  // A project's target is a DAY — asked for as one, stored as its UTC midnight.
  if (args.target_completion_at !== undefined) {
    if (kind !== 'project') return wrongKindDate('work.create', 'target_completion_at', 'project', kind);
    const day = typeof args.target_completion_at === 'string'
      ? calendarDayMs(args.target_completion_at.trim())
      : null;
    if (day === null) {
      return invalidArgs('work.create: `target_completion_at` must be a date as YYYY-MM-DD');
    }
    put('target_completion_at', 'target_completion_at', day);
  }
  // A promise is for a day or an exact time — never a time without its zone.
  if (args.promised_for_at !== undefined) {
    if (kind !== 'commitment') return wrongKindDate('work.create', 'promised_for_at', 'commitment', kind);
    const when = typeof args.promised_for_at === 'string' ? unambiguousDateMs(args.promised_for_at) : null;
    if (when === null) {
      return invalidArgs(
        'work.create: `promised_for_at` must be a date as YYYY-MM-DD, or a time with its offset',
      );
    }
    put('promised_for_at', 'promised_for_at', when);
  }
  if (args.counterparty_email !== undefined) {
    if (kind !== 'commitment') {
      return invalidArgs('work.create: `counterparty_email` applies to a commitment only');
    }
    const email = typeof args.counterparty_email === 'string'
      ? args.counterparty_email.trim().toLowerCase()
      : '';
    if (!EMAIL_SHAPE.test(email)) {
      return invalidArgs('work.create: `counterparty_email` must be an email address — never a name');
    }
    put('counterparty_email', 'counterparty_contact_id', email);
  }
  if (args.direction !== undefined && kind !== 'commitment') {
    return invalidArgs('work.create: `direction` applies to a commitment only');
  }
  if (kind === 'commitment') {
    // A commitment is WHO promised WHAT. `direction` has no default: a guess
    // would file the user's own promise as one owed to them, or the reverse.
    if (typeof args.direction !== 'string' || !COMMITMENT_DIRECTION_SET.has(args.direction as never)) {
      return invalidArgs(
        'work.create requires `direction` for a commitment: `outbound` (the user promised it), '
          + '`inbound` (someone promised it to the user) or `internal`',
      );
    }
    put('direction', 'direction', args.direction);
    // The user said so: every commitment made here is theirs to have declared.
    input.derivation = 'user_declared';
  }

  if (check) return WOULD_RUN;
  try {
    const res = await handleWorkEntityUpsert(
      crud,
      input as unknown as Parameters<typeof handleWorkEntityUpsert>[1],
      ctx.execution_source,
    );
    const entity = res.entity as { id?: string; _kind?: string } | undefined;
    return {
      ok: true,
      result: {
        created: true,
        kind,
        ...(entity?.id !== undefined ? { id: entity.id } : {}),
        fields,
      },
    };
  } catch (e) {
    return executionError(
      `work.create failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
};

const CHAT_ASSET_TYPE_WORDS: AssetTypeWords = {
  holder: '`holder_email`, the email address of the person it belongs to', describe: 'work.type',
};
const ASSET_CREATE_ARGS: ReadonlySet<string> = new Set(['kind', 'type', 'title', 'dates', 'readings', 'holder_email', 'attributes', 'place', 'belongs_to', 'body']);
const ASSET_UPDATE_ARGS: ReadonlySet<string> = new Set(['kind', 'id', 'title', 'body', 'dates', 'readings', 'attributes', 'place', 'belongs_to']);
/** How much of what the user said about a thing the AI may keep on it. */
const ASSET_ATTRIBUTES_MAX = 20;
const ASSET_ATTRIBUTE_TEXT_MAX = 500;
const ASSET_NAME_MAX = 200;
const ASSET_NOTE_MAX = 2000;
const ASSET_PLACE_MAX = 200;
/** The longest unit `validateAsset` takes. */
const ASSET_UNIT_MAX = 80;

/** An asset argument refused, in its tool's words; the handler answers `invalidArgs`. */
class AssetArgRefusal extends Error {}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const listedNames = (names: readonly string[]): string => {
  const shown = names.map((name) => `\`${name}\``);
  return shown.length < 2 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
};
/** Where an AI's facts about an asset came from: its chat, or the AI app's token. */
const aiAssetSourceRef = (ctx: ChatDispatchContext): string =>
  ctx.channel === 'mcp_wire' ? `mcp:${ctx.mcp_token_id ?? 'agent'}` : `chat:${ctx.session_id ?? 'turn'}`;

/** An attribute's name as Yours keeps one: lower-case words joined by underscores, so
 *  "Frame size" is `frame_size`. ⛔ The Yours form refuses any other name on save, so one
 *  an AI wrote another way would stop the owner saving the thing's details. */
const assetAttributeName = (tool: string, given: string): string => {
  const name = given.trim().toLowerCase().replace(/[\s-]+/gu, '_');
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(name)) {
    throw new AssetArgRefusal(`${tool}: name each attribute in lower-case letters, digits and underscores, starting with a letter, such as \`frame_size\``);
  }
  if (name === ASSET_DOCUMENT_DETAILS_ATTRIBUTE) throw new AssetArgRefusal(`${tool}: \`${name}\` belongs to a document attached in Yours`);
  return name;
};
/** What the user said about a thing, by name, kept where Yours keeps the owner's own
 *  details: plain values, plus the bounded keyword list. On an update, `null`
 *  removes one. Keyword edits replace this asset's additions, never type defaults. */
const assetAttributesArg = (tool: string, raw: unknown, removable: boolean): Record<string, string | number | boolean | string[] | null> => {
  const attributes: Record<string, string | number | boolean | string[] | null> = {};
  if (raw === undefined) return attributes;
  if (!isPlainObject(raw)) throw new AssetArgRefusal(`${tool}: \`attributes\` must be an object of named details, such as {"brand": "Trek"}`);
  const entries = Object.entries(raw);
  if (entries.length > ASSET_ATTRIBUTES_MAX) throw new AssetArgRefusal(`${tool}: send at most ${ASSET_ATTRIBUTES_MAX} attributes at a time`);
  for (const [given, value] of entries) {
    const name = assetAttributeName(tool, given);
    if (Object.hasOwn(attributes, name)) throw new AssetArgRefusal(`${tool}: \`attributes\` names \`${name}\` twice`);
    if (name === ASSET_SEARCH_TERMS) {
      try { const terms = parseAssetSearchTerms(value); attributes[name] = terms.length ? terms : null; }
      catch (error) { throw new AssetArgRefusal(`${tool}: \`attributes.${ASSET_SEARCH_TERMS}\`: ${(error as Error).message}`); }
    }
    else if (typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= ASSET_ATTRIBUTE_TEXT_MAX) attributes[name] = value.trim();
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) attributes[name] = value;
    else if (value === null && removable) attributes[name] = null;
    else {
      throw new AssetArgRefusal(`${tool}: \`attributes.${name}\` must be text of at most ${ASSET_ATTRIBUTE_TEXT_MAX} characters, a number or true/false${removable ? ', or null to remove it' : ''}`);
    }
  }
  return attributes;
};
/** A note about the thing, kept as `attributes.note`. */
const assetNoteArg = (tool: string, raw: unknown, attributes: Record<string, unknown>): string | undefined => {
  const note = typeof raw === 'string' ? raw.trim() : raw;
  if (note === undefined) return undefined;
  if (typeof note !== 'string' || note.length === 0 || [...note].length > ASSET_NOTE_MAX) {
    throw new AssetArgRefusal(`${tool}: \`body\` is a note about the asset, of at most ${ASSET_NOTE_MAX} characters`);
  }
  if (Object.hasOwn(attributes, 'note')) throw new AssetArgRefusal(`${tool}: give an asset its note once, as \`body\` or as \`attributes.note\``);
  return note;
};
const assetPlaceArg = (tool: string, raw: unknown): string | undefined => {
  const place = typeof raw === 'string' ? raw.trim() : raw;
  if (place !== undefined && (typeof place !== 'string' || place.length === 0 || [...place].length > ASSET_PLACE_MAX)) {
    throw new AssetArgRefusal(`${tool}: \`place\` says where it is kept, such as "the garage", in at most ${ASSET_PLACE_MAX} characters`);
  }
  return place;
};
/** What a thing is part of or covers (`belongs_to`): another live asset, by its id as
 *  `work.search` returned it or a local one. The thing then shares that one's place, and
 *  follows it when it is sold or retired: a part is retired with it, and a policy is
 *  given a reminder to cancel or transfer (`retireAsset`). */
const assetParentArg = (tool: string, raw: unknown, assetById: (id: string) => Asset, self?: string): string | undefined => {
  if (raw === undefined) return undefined;
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (id.length === 0) throw new AssetArgRefusal(`${tool}: \`belongs_to\` is the id of another thing they own, as \`work.search\` returned it`);
  let parent: Asset;
  try {
    parent = assetById(id);
  } catch (e) {
    throw new AssetArgRefusal(`${tool}: \`belongs_to\` names no thing they own (${e instanceof Error ? e.message : String(e)}). Find it with \`work.search\``);
  }
  if (parent.id === self) throw new AssetArgRefusal(`${tool}: a thing cannot belong to itself`);
  return parent.id;
};
/** The unit a reading is recorded in, as the Yours reading form holds the owner to it:
 *  its last reading's, else the one its reminders read it in. `null` when those
 *  reminders disagree; `undefined` when any unit will do. */
const assetReadingUnit = (field: string, last: AssetReading | null | undefined, rules: readonly AssetRule[]): string | null | undefined => {
  if (last) return last.unit;
  const units = [...new Set(rules.flatMap((rule) => rule.when.kind === 'objective' && rule.when.field === field ? [rule.when.unit] : []))];
  return units.length > 1 ? null : units[0];
};
/** When a reading was observed, as epoch ms: a time the AI gave with its offset; a day,
 *  at its noon in the turn's zone (UTC on the MCP wire, which has none), or now while
 *  that noon is still to come; or now. `null` for a time that has not happened yet. */
const assetReadingTime = (raw: unknown, now: number, timeZone: string | undefined): number | null => {
  if (raw === undefined) return now;
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (text.length === 10 && calendarDayMs(text) !== null) {
    const start = zonedWallClockToEpochMs(`${text}T00:00`, timeZone ?? 'UTC');
    const noon = zonedWallClockToEpochMs(`${text}T12:00`, timeZone ?? 'UTC');
    return start === null || noon === null || start > now ? null : Math.min(noon, now);
  }
  const at = unambiguousDateMs(text);
  return at !== null && at <= now ? at : null;
};
/** Readings the user gave, each recorded as the Yours form records the owner's: a number
 *  in the unit its field is read in, at the time it was observed. */
const assetReadingsArg = (
  tool: string,
  raw: Record<string, unknown>,
  unitOf: (field: string) => string | null | undefined,
  now: number,
  timeZone: string | undefined,
): Record<string, AssetReading> => {
  const readings: Record<string, AssetReading> = {};
  for (const [field, given] of Object.entries(raw)) {
    const named = `\`readings.${field}\``;
    if (!isPlainObject(given) || Object.keys(given).some((key) => !['value', 'unit', 'as_of'].includes(key))) {
      throw new AssetArgRefusal(`${tool}: ${named} is {"value": <the number>, "unit": "<its unit>"}, with \`as_of\` unless it was read just now`);
    }
    const value = given.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AssetArgRefusal(`${tool}: ${named}.value is the number read; leave out a reading the user did not give`);
    }
    const unit = typeof given.unit === 'string' ? given.unit.trim() : '';
    if (unit.length === 0 || [...unit].length > ASSET_UNIT_MAX) throw new AssetArgRefusal(`${tool}: ${named}.unit says what it is read in, such as "km"`);
    const kept = unitOf(field);
    if (kept === null) {
      throw new AssetArgRefusal(`${tool}: the reminders on \`${field}\` read it in different units, so the user fixes them in Yours before a reading is recorded`);
    }
    if (kept !== undefined && unit !== kept) {
      throw new AssetArgRefusal(`${tool}: \`${field}\` is read in \`${kept}\`, not \`${unit}\`. Convert the reading, or ask the user`);
    }
    const as_of = assetReadingTime(given.as_of, now, timeZone);
    if (as_of === null) {
      throw new AssetArgRefusal(`${tool}: ${named}.as_of is when it was read, as YYYY-MM-DD or a time with its offset, and not later than now`);
    }
    readings[field] = { value, unit, as_of, evidence: [] };
  }
  return readings;
};
/** What an asset keeps in a group, against the names a call sent. */
const assetFieldsText = (tool: string, asset: Asset, group: 'dates' | 'readings', extra: readonly string[]): string => {
  const kept = Object.keys(asset[group]);
  return `${tool}: \`${asset.name}\` keeps ${kept.length > 0 ? `the ${group} ${listedNames(kept)}` : `no ${group}`}, not ${listedNames(extra)}. The user can add the field in Yours`;
};
/** Who holds fields an AI may not change, as one clause about them. `owner` names the owner
 *  as the AI knows them: "the user" to the owner, "the owner" to anyone else. */
const assetHeldClause = (kind: AssetContributionKind, shown: string, many: boolean, owner: string): string => {
  switch (kind) {
    case 'owner': return `${owner} set ${shown} themselves`;
    case 'confirmed_document': return `${shown} ${many ? 'come' : 'comes'} from a document ${owner} confirmed`;
    case 'observation': return `a device or recipe reports ${shown}`;
    default: return `${shown} ${many ? 'rank' : 'ranks'} above an AI`;
  }
};
const assetHeldName = (path: string): string => path === 'name' ? 'its name' : path === 'anchors' ? 'where it is kept'
  : path === 'belongs_to' ? 'what it belongs to' : path === 'attributes.note' ? 'its note' : `\`${path.slice(path.indexOf('.') + 1)}\``;
const andList = (items: readonly string[]): string =>
  items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
/** ⛔ The owner's ruling of 2026-10-25 ("readings mine, rest AI's"): an AI fills an empty
 *  field or replaces what an AI wrote. Where the owner set the value, or a document they
 *  confirmed or a device did, it is refused, before the owner is asked. Search keywords
 *  are editable retrieval metadata, under the owner's later ruling, not ranked facts. The
 *  reason is in plain clauses with an instruction to pass it on: live, a parenthesised "(the
 *  user entered it)" was dropped from 2 of 2 answers, which told the owner only to use Yours.
 *  ⚠ The AI is told to say it, so it must be true of whoever it is talking to: a household
 *  member did not set the owner's values and has no Yours, and an AI app's user may not be
 *  the owner either. Only the owner's own chat is told "the user set it". */
const assetHeldText = (tool: string, held: AssetFieldHeldError['held'], ctx: ChatDispatchContext): string => {
  const toOwner = ctx.execution_source === undefined || ctx.execution_source.actor === 'user_self';
  const owner = toOwner ? 'the user' : 'the owner';
  const clauses = [...new Set(held.map((entry) => entry.kind))].map((kind) => {
    const names = held.filter((entry) => entry.kind === kind).map((entry) => assetHeldName(entry.path));
    return assetHeldClause(kind, andList(names), names.length > 1, owner);
  });
  const them = held.length > 1 ? 'them' : 'it';
  return `${tool}: ${andList(clauses)}, so an AI may not change ${them}. `
    + `Tell the user why, and that ${toOwner ? 'they' : 'the owner'} can change ${them} in Yours. Leave ${them} out to change the rest`;
};
/** How an AI's asset write is ranked (`AssetAiWrite`). A check runs as its write will once
 *  approved, and whose approval that is depends on where the call came from: in a chat under
 *  a contract, the write's readings stay the AI's. */
const assetAiWrite = (ctx: ChatDispatchContext, check: boolean): AssetAiWrite => check
  ? { check: true, owner_approved: ctx.execution_source !== undefined && ownerApprovesCallsOf(ctx.execution_source) }
  : { owner_approved: ctx.owner_approved === true };
/** An asset write's refusal in its tool's words, or `null` for a failure of another kind. */
const assetWriteRefusal = (tool: string, error: unknown, ctx: ChatDispatchContext): ChatDispatchResult | null => {
  if (error instanceof AssetArgRefusal) return invalidArgs(error.message);
  if (error instanceof AssetFieldHeldError) return invalidArgs(assetHeldText(tool, error.held, ctx));
  if (error instanceof AssetTypeError) return invalidArgs(`${tool}: ${assetTypeIssueText(error.type, error.issues, CHAT_ASSET_TYPE_WORDS)}`);
  if (error instanceof AssetValidationError) return invalidArgs(`${tool}: ${error.message}`);
  return null;
};

/** D-325 (2026-10-24) — `work.create` of an `asset`, at the AI's own rank
 *  (`extracted`): the user said it and the model wrote it down. It goes through
 *  the create every extracted writer uses, which keeps a typed asset to its type's
 *  fields and starts its type's own reminders. The checks here only answer first,
 *  in this tool's words (`holder_email`, `work.type`). Its readings, once the owner
 *  approves the create, are their own samples (`AssetAiWrite`). */
const createAssetFromChat = async (
  deps: ChatToolHandlerDeps,
  args: Record<string, unknown>,
  ctx: ChatDispatchContext,
  check = false,
): Promise<ChatDispatchResult> => {
  const crud = deps.getWorkEntityCrudDeps?.();
  if (!crud) return executionError('work-entity write path unavailable');
  const other = Object.keys(args).filter((name) => !ASSET_CREATE_ARGS.has(name) && args[name] !== undefined);
  if (other.length > 0) {
    return invalidArgs(
      `work.create: an asset takes \`type\`, \`title\`, \`dates\`, \`readings\`, \`holder_email\`, \`attributes\`, \`place\`, \`belongs_to\` and \`body\`, not ${other.map((name) => `\`${name}\``).join(', ')}`,
    );
  }
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (title.length === 0) {
    return invalidArgs('work.create requires a non-empty title for an asset: its name, such as "Maya\'s passport"');
  }
  if (!admitWorkEntityCreate(deps.getOpAdmissionGate?.(), ctx.execution_source, 'asset')) {
    return {
      ok: false,
      reason: 'classification_blocked',
      detail: 'work.create is not granted to this contract for asset (write rejected)',
    };
  }
  const types = deps.getAssetTypes?.();
  if (!types) return executionError('asset types unavailable');
  const typeId = typeof args.type === 'string' ? args.type.trim() : args.type;
  if (typeId !== undefined && (typeof typeId !== 'string' || typeId.length === 0)) {
    return invalidArgs('work.create: `type` must be an asset type such as `passport`; work.type lists them');
  }
  const type = typeId === undefined ? null : types.get(typeId);
  if (typeId !== undefined && !type) {
    return invalidArgs(`work.create: ${unknownAssetTypeText(typeId, types, 'work.type')}`);
  }
  const dates: Record<string, string> = {};
  if (args.dates !== undefined) {
    if (args.dates === null || typeof args.dates !== 'object' || Array.isArray(args.dates)) {
      return invalidArgs('work.create: `dates` must be an object of dates as YYYY-MM-DD');
    }
    for (const [field, value] of Object.entries(args.dates)) {
      if (!isAssetDate(value)) return invalidArgs(`work.create: \`dates.${field}\` must be a date as YYYY-MM-DD`);
      dates[field] = value;
    }
  }
  if (args.readings !== undefined && !isPlainObject(args.readings)) {
    return invalidArgs('work.create: `readings` must be an object of readings by name, such as {"odometer": {"value": 12400, "unit": "km"}}');
  }
  const givenReadings = (args.readings ?? {}) as Record<string, unknown>;
  if (!type && Object.keys(dates).length + Object.keys(givenReadings).length > 0) {
    return invalidArgs('work.create: an asset with no type keeps no dates or readings. Pass its `type`; work.type lists them.');
  }
  let holder: string | undefined;
  if (args.holder_email !== undefined) {
    const email = typeof args.holder_email === 'string' ? args.holder_email.trim().toLowerCase() : '';
    if (!EMAIL_SHAPE.test(email)) {
      return invalidArgs('work.create: `holder_email` must be an email address — never a name');
    }
    // The holder is kept as the Yours picker keeps it: the contact's id, or the
    // email of someone not in contacts.
    holder = deps.getContactStore()?.get(email)?.contact_id ?? email;
  }
  try {
    // What the user said about it goes where Yours keeps the owner's own details: named
    // values in `attributes`, a note as `attributes.note`, and where it is kept as a place.
    // ⛔ With nowhere to put them, the AI sent them as `body` in 3 of 3 live runs (2026-10-25).
    const attributes = assetAttributesArg('work.create', args.attributes, false);
    const note = assetNoteArg('work.create', args.body, attributes);
    if (note !== undefined) attributes.note = note;
    const place = assetPlaceArg('work.create', args.place);
    const parent = assetParentArg('work.create', args.belongs_to, (id) => crud.dispatchers.assetById(id));
    let readings: Record<string, AssetReading> = {};
    if (type) {
      const issues = assetTypeIssues(type, {
        dates,
        readings: Object.fromEntries(Object.keys(givenReadings).map((field) => [field, null])),
        ...(holder !== undefined ? { holder_contact: holder } : {}),
      });
      if (issues) return invalidArgs(`work.create: ${assetTypeIssueText(type, issues, CHAT_ASSET_TYPE_WORDS)}`);
      readings = assetReadingsArg('work.create', givenReadings, (field) => assetReadingUnit(field, undefined, type.rules),
        deps.now?.() ?? Date.now(), ctx.time_zone);
    }
    const fields = ['title', ...(type ? ['type'] : []), ...(Object.keys(dates).length > 0 ? ['dates'] : []),
      ...(Object.keys(readings).length > 0 ? ['readings'] : []), ...(holder !== undefined ? ['holder_email'] : []),
      ...(args.attributes !== undefined ? ['attributes'] : []), ...(note !== undefined ? ['body'] : []), ...(place !== undefined ? ['place'] : []),
      ...(parent !== undefined ? ['belongs_to'] : [])];
    const { asset } = await crud.dispatchers.assetCreate({
      name: title,
      ...(type ? { class_id: type.id } : {}),
      ...(Object.keys(dates).length > 0 ? { dates } : {}),
      ...(Object.keys(readings).length > 0 ? { readings } : {}),
      ...(holder !== undefined ? { holder_contact: holder } : {}),
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
      ...(place !== undefined ? { anchors: [{ kind: 'place' as const, name: place }] } : {}),
      ...(parent !== undefined ? { belongs_to: parent } : {}),
      source: { kind: 'extracted', ref: aiAssetSourceRef(ctx) },
      ...(ctx.execution_source ? { origin_execution_source: ctx.execution_source } : {}),
    }, assetAiWrite(ctx, check));
    if (check) return WOULD_RUN;
    const on = asset.rules.filter((rule) => rule.enabled && !rule.muted && rule.reaction.notify);
    const waiting = [...new Set(on.flatMap((rule) =>
      (rule.when.kind === 'expiry' || rule.when.kind === 'interval') && asset.dates[rule.when.field] == null
        ? [rule.when.field] : []))];
    return {
      ok: true,
      result: {
        created: true,
        kind: 'asset',
        id: asset.id,
        ...(type ? { type: type.id } : {}),
        fields,
        reminders: on.map((rule) => rule.title),
        // A clock with no date yet sends nothing until the date is entered.
        ...(waiting.length > 0 ? { reminders_wait_for: waiting } : {}),
      },
    };
  } catch (e) {
    return assetWriteRefusal('work.create', e, ctx)
      ?? executionError(`work.create failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** D-325 (2026-10-25) — `work.update` of an `asset`: what the user says about a thing they
 *  own, written as `work.create` writes a new one. Its readings, once the owner approves
 *  the write, are their own samples; the rest keeps the AI's rank, so it fills an empty
 *  field or replaces what an AI wrote, and is refused where the owner set the value
 *  (`assetHeldText`). The dispatcher's strict write makes that refusal, so a check
 *  makes it before the owner is asked. */
const updateAssetFromChat = async (
  deps: ChatToolHandlerDeps,
  args: Record<string, unknown>,
  ctx: ChatDispatchContext,
  check = false,
): Promise<ChatDispatchResult> => {
  const crud = deps.getWorkEntityCrudDeps?.();
  if (!crud) return executionError('work-entity write path unavailable');
  const other = Object.keys(args).filter((name) => !ASSET_UPDATE_ARGS.has(name) && args[name] !== undefined);
  if (other.length > 0) {
    return invalidArgs(
      `work.update: an asset takes \`title\`, \`body\`, \`dates\`, \`readings\`, \`attributes\`, \`place\` and \`belongs_to\`, not ${other.map((name) => `\`${name}\``).join(', ')}`,
    );
  }
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  if (id.length === 0) return invalidArgs('work.update requires the id of the row to change');
  if (!admitWriteOp(deps.getOpAdmissionGate?.(), ctx.execution_source, ASSET_UPDATE_OP_ID)) {
    return {
      ok: false,
      reason: 'classification_blocked',
      detail: 'work.update is not granted to this contract for asset (write rejected)',
    };
  }
  let prior: Asset;
  try {
    prior = crud.dispatchers.assetToUpdate(id);
  } catch (e) {
    return invalidArgs(`work.update: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    const patch: AssetPatch = {};
    const fields: string[] = [];
    if (args.title !== undefined) {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (title.length === 0 || [...title].length > ASSET_NAME_MAX) {
        throw new AssetArgRefusal(`work.update: \`title\` is the asset's new name, of at most ${ASSET_NAME_MAX} characters`);
      }
      patch.name = title;
      fields.push('title');
    }
    const attributes = assetAttributesArg('work.update', args.attributes, true);
    const missing = Object.entries(attributes).filter(([name, value]) => value === null && prior.attributes[name] == null).map(([name]) => name);
    if (missing.length > 0) throw new AssetArgRefusal(`work.update: \`${prior.name}\` has no attribute ${listedNames(missing)} to remove`);
    if (Object.keys(attributes).length > 0) fields.push('attributes');
    const note = assetNoteArg('work.update', args.body, attributes);
    if (note !== undefined) {
      attributes.note = note;
      fields.push('body');
    }
    if (Object.keys(attributes).length > 0) patch.attributes = attributes;
    const place = assetPlaceArg('work.update', args.place);
    if (place !== undefined) {
      // Only its place moves; an identifier or an instrument stays.
      patch.anchors = [...prior.anchors.filter((anchor) => anchor.kind !== 'place'), { kind: 'place', name: place }];
      fields.push('place');
    }
    const parent = assetParentArg('work.update', args.belongs_to, (parentId) => crud.dispatchers.assetById(parentId), prior.id);
    if (parent !== undefined) {
      patch.belongs_to = parent;
      fields.push('belongs_to');
    }
    if (args.dates !== undefined) {
      if (!isPlainObject(args.dates)) throw new AssetArgRefusal('work.update: `dates` must be an object of dates as YYYY-MM-DD');
      const extra = Object.keys(args.dates).filter((field) => !Object.hasOwn(prior.dates, field));
      if (extra.length > 0) throw new AssetArgRefusal(assetFieldsText('work.update', prior, 'dates', extra));
      const dates: Record<string, string> = {};
      for (const [field, value] of Object.entries(args.dates)) {
        if (!isAssetDate(value)) throw new AssetArgRefusal(`work.update: \`dates.${field}\` must be a date as YYYY-MM-DD`);
        dates[field] = value;
      }
      if (Object.keys(dates).length > 0) {
        patch.dates = dates;
        fields.push('dates');
      }
    }
    if (args.readings !== undefined) {
      if (!isPlainObject(args.readings)) {
        throw new AssetArgRefusal('work.update: `readings` must be an object of readings by name, such as {"odometer": {"value": 12400, "unit": "km"}}');
      }
      const extra = Object.keys(args.readings).filter((field) => !Object.hasOwn(prior.readings, field));
      if (extra.length > 0) throw new AssetArgRefusal(assetFieldsText('work.update', prior, 'readings', extra));
      const readings = assetReadingsArg('work.update', args.readings,
        (field) => assetReadingUnit(field, prior.readings[field], prior.rules), deps.now?.() ?? Date.now(), ctx.time_zone);
      if (Object.keys(readings).length > 0) {
        patch.readings = readings;
        fields.push('readings');
      }
    }
    // Same reasoning as the other kinds: an empty change would be put to the owner,
    // change nothing and report success.
    if (fields.length === 0) {
      throw new AssetArgRefusal('work.update: send at least one change to the asset (title / body / dates / readings / attributes / place / belongs_to)');
    }
    const { asset } = await crud.dispatchers.assetUpdate({
      ...patch,
      id: prior.id,
      source: { kind: 'extracted', ref: aiAssetSourceRef(ctx) },
      ...(ctx.execution_source ? { origin_execution_source: ctx.execution_source } : {}),
    }, assetAiWrite(ctx, check));
    if (check) {
      return JSON.stringify(asset) === JSON.stringify(prior)
        ? invalidArgs(`work.update: \`${prior.name}\` already says that, so nothing would change`)
        : WOULD_RUN;
    }
    return { ok: true, result: { updated: true, kind: 'asset', id, fields } };
  } catch (e) {
    return assetWriteRefusal('work.update', e, ctx)
      ?? executionError(`work.update failed: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** The field each kind of work row is known by. */
const WORK_ROW_NAME_FIELD: Readonly<Record<WorkEntityKind, string>> = {
  task: 'title', note: 'title', project: 'title', booking: 'title', commitment: 'statement', asset: 'name',
};
/** The name the owner knows a work row by, from the id a tool holds (local, or as
 *  `work.search` returned it), or `undefined` when it names none. */
const workRowName = (crud: NonNullable<ReturnType<NonNullable<ChatToolHandlerDeps['getWorkEntityCrudDeps']>>>,
  kind: WorkEntityKind, id: string): string | undefined => {
  try {
    const qualified = parseQualifiedWorkEntityId(id);
    const row = qualified === null ? crud.resolver.readEntity(kind, id)
      : qualified.kind !== kind ? null
        : qualified.identity === 'source'
          ? crud.resolver.readEntityBySourceIdentity(kind, qualified.source_id, qualified.record_id)
          : crud.resolver.readEntity(kind, qualified.record_id);
    const name = row === null ? undefined : (row as unknown as Record<string, unknown>)[WORK_ROW_NAME_FIELD[kind]];
    return typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined;
  } catch {
    return undefined;
  }
};
/** D-329 — how the owner knows the rows a held `work.create` or `work.update` names: its
 *  `id`, and an asset's `belongs_to`, by their own names. Recorded on the ask and the card
 *  (`value_labels`), never shown to the AI. ⛔ Found live (2026-10-25): an asset's reading
 *  was put to the owner as "id: we1:asset:recued.asset:local:e1a798e8…", so with two cars
 *  they could not tell which one they were approving. */
export const workAskLabels = async (deps: ChatToolHandlerDeps, raw: unknown): Promise<ApprovalValueLabels | undefined> => {
  const crud = deps.getWorkEntityCrudDeps?.();
  const args = asObject(raw);
  if (!crud || !args) return undefined;
  const labels: Record<string, Record<string, string>> = {};
  const label = (key: string, kind: unknown): void => {
    const value = args[key];
    if (typeof value !== 'string' || typeof kind !== 'string' || !WORK_ENTITY_KIND_SET.has(kind as WorkEntityKind)) return;
    const name = workRowName(crud, kind as WorkEntityKind, value);
    if (name !== undefined) labels[key] = { [value]: name };
  };
  label('id', args.kind);
  if (args.kind === 'asset') label('belongs_to', 'asset');
  return Object.keys(labels).length > 0 ? labels : undefined;
};
/** D-329 — how the owner knows the event a held `calendar.update` changes: its title and
 *  when it is, on the turn's clock (the MCP wire has none, so there its title alone). */
export const calendarAskLabels = async (
  deps: ChatToolHandlerDeps,
  raw: unknown,
  ctx: ChatDispatchContext,
): Promise<ApprovalValueLabels | undefined> => {
  const args = asObject(raw);
  const id = typeof args?.source_id === 'string' ? args.source_id : undefined;
  if (args === null || id === undefined) return undefined;
  const slug = typeof args.calendar_id === 'string' && args.calendar_id.trim() ? args.calendar_id.trim() : DEFAULT_LOCAL_CALENDAR_SLUG;
  const calendar = deps.getCollectionRegistry()?.list()
    .filter(isCalendarCollection).find((collection) => collection.slug === slug);
  const event = calendar?.table.get(id)?.event;
  const summary = typeof event?.summary === 'string' ? event.summary.trim() : '';
  if (summary.length === 0) return undefined;
  const when = eventWhenOnTurnClock(event, ctx.time_zone);
  return { source_id: { [id]: when === undefined ? summary : `${summary}, ${when}` } };
};

/** D-325 (2026-10-24) — `work.type`: what a type of thing the owner keeps holds,
 *  so an AI can create one from nothing (the owner: "hint.tool for the create job
 *  so AI knows what shape the passport obj is"). Chat and the MCP wire carry this
 *  one tool and its one description. `kind` keeps the call generic; only assets
 *  have types today. Gated by the asset create's op: a type is described for
 *  creating one. */
const createWorkTypeHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) => {
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');
    if (args.kind !== 'asset') {
      return invalidArgs(
        'work.type describes `asset` types only; the fields of a task, note, commitment or project are in work.create',
      );
    }
    if (!admitWorkEntityCreate(deps.getOpAdmissionGate?.(), ctx.execution_source, 'asset')) {
      return {
        ok: false,
        reason: 'classification_blocked',
        detail: 'work.type is not granted to this contract: it needs the switch that adds things you own',
      };
    }
    const types = deps.getAssetTypes?.();
    if (!types) return executionError('asset types unavailable');
    if (args.type === undefined) {
      return {
        ok: true,
        result: {
          kind: 'asset',
          types: listAssetTypes(types.list()),
          note: 'Pass one `type` for its reminders. A thing no type fits is added with no type, and keeps no dates.',
        },
      };
    }
    const id = typeof args.type === 'string' ? args.type.trim() : '';
    if (id.length === 0) {
      return invalidArgs('work.type: `type` is an asset type such as `passport`; omit it to list every type');
    }
    const type = types.get(id);
    if (!type) return invalidArgs(`work.type: ${unknownAssetTypeText(id, types, 'work.type with no `type`')}`);
    return {
      ok: true,
      result: {
        kind: 'asset',
        ...describeAssetType(type),
        note: `Add one with work.create: kind "asset", type "${type.id}", its title${assetTypeNeedsHolder(type) ? ', holder_email' : ''} and dates under these names as YYYY-MM-DD. Leave out a date the user did not give.`,
      },
    };
  };

/** The work-entity read tools' deps, from the chat tools' own (exported for the wiring pin,
 *  `escalation-contract-overlay-wiring.test.ts`). */
export const workEntityReadToolsDeps = (deps: ChatToolHandlerDeps): WorkEntityReadToolsDeps => ({
  ...(deps.getSituationAccess ? { getReadScope: (ctx: ChatDispatchContext) => {
    const access = deps.getSituationAccess!(); return access ? createReadScope(access, ctx.execution_source) : undefined;
  } } : {}),
  // D-205 #3 — inject the PREDICATE, not the resolver: the gate logic stays in one place
  // and `work-entity-read-tools.ts` grows no grant-store dependency. `kind` IS the
  // collection (`task`/`note`/`commitment`/`project` are all `READABLE_COLLECTIONS`).
  isCollectionReadGranted: (collection, ctx) =>
    isCollectionReadGrantedForDispatch(deps, ctx, collection),
  // The `core.work-entity.read` verb-op — the CAPABILITY axis, same predicate-not-gate
  // injection. Mirrors `admitMemoryRead`'s wiring for `memory.search`.
  isVerbOpGranted: (ctx) =>
    admitWorkEntityRead(deps.getOpAdmissionGate?.(), ctx.execution_source),
  getResolver: () => deps.getWorkEntityResolver?.(),
  getTargetedReadDeps: () => deps.getWorkEntityTargetedReadDeps?.(),
  getOpAdmissionGate: () => deps.getOpAdmissionGate?.(),
  getContractOverlay: () => deps.getContractOverlay?.(),
  getEdgeStore: () => deps.getWorkEntityEdgeStore?.(),
  personName: id => situationPersonName(deps.getContactStore?.())(id),
});

const createWorkSearchHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) =>
    runWorkEntitySearchTool(workEntityReadToolsDeps(deps), raw, ctx);

const createWorkReadHandler =
  (deps: ChatToolHandlerDeps): Tier1Handler =>
  async (raw, ctx) =>
    runWorkEntityReadTool(workEntityReadToolsDeps(deps), raw, ctx);

// ────────────────────────────────────────────────────────────────
// Tier 2 source + manifest lookup
// ────────────────────────────────────────────────────────────────

export const createChatTier2Source = (deps: ChatToolHandlerDeps): Tier2Source => ({
  listRecipes(): ReadonlyArray<Tier2RecipeEntry> {
    // Enumerate every known recipe (SQLite + bundled) and project into
    // `Tier2RecipeEntry`. Bundled recipes aren't in `listStored()`, so
    // walk `ids()` and pull each via `get()` for the parsed
    // `RecipeDefinition`; publisher_id comes from the stored row when
    // present (SQLite path) and falls back to `metadata.author` for
    // bundled-only entries. Kernel recipes (`metadata.author ===
    // 'recued'`) get filtered out — they're runtime-bundled
    // implementation detail per `RESERVED_HANDLES` and never surface
    // in the marketplace / chat catalog. The downstream
    // `isRecipeChatExposed` filter still applies (`chat_exposed:
    // false` opt-out), so a kernel recipe missed here would still drop
    // at catalog-build time. */
    const store = deps.getRecipeStore();
    const entries: Tier2RecipeEntry[] = [];
    // D-320 §3.5 — read once per listing; see `ChatToolHandlerDeps.connectionChoices`.
    const connectionSlotsOf = deps.connectionChoices?.();
    for (const id of store.ids()) {
      const recipe = store.get(id);
      if (!recipe) continue;
      if (recipe.metadata?.author === 'recued') continue;
      const stored = store.getStored(id);
      const publisher_id =
        stored?.publisher_id ?? recipe.metadata?.author ?? '';
      entries.push({
        recipe_id: id,
        publisher_id,
        recipe,
        // 2026-07-02 default flip — `source: 'inline'` = user-authored
        // (Kitchen / compose / authored provisioning): an absent
        // `chat_exposed` defaults EXPOSED for these. Bundled dir recipes
        // (no stored row) and pack-installed rows (`'pair-sync'` /
        // `'bundled'`) are distributed content: absent defaults HIDDEN —
        // the author opts in with explicit `chat_exposed: true`.
        user_authored: stored?.source === 'inline',
        ...((slots) => (slots.length > 0 ? { connection_slots: slots } : {}))(
          connectionSlotsOf?.(recipe) ?? [],
        ),
      });
    }
    return entries;
  },
});

export const createChatManifestLookup =
  (deps: ChatToolHandlerDeps): IngredientKindLookup =>
  (slug) => {
    const manifest = deps.getExecutorConfig().manifests.get(slug);
    if (!manifest) return null;
    // D-182 — a decomposed cli toolkit catalog is stamped `kind: 'connection'`
    // (decomposer.ts `catalogIngredient`); its cli-ness lives in the
    // `cli_invocation` connector runtime. Surface it as the `cli` kind so the
    // Tier-2 catalog gate's "Local tools" toggle governs whisper/docling/etc.,
    // not "Outbound connections". Mirrors `createManifestKindLookup`.
    if (isCliIngredient(manifest)) return 'cli';
    return manifest.kind ?? null;
  };

// ────────────────────────────────────────────────────────────────
// Tier 1 handler bundle factory
// ────────────────────────────────────────────────────────────────

/** ⛔⛔ SAY "NOTHING FOUND" IN WORDS, on every read that returns nothing.
 *
 *  Audited across ~1700 live empty dispatch results, and the signal was
 *  inconsistent three ways. `memory.search` says it plainly
 *  (`hint: "no memories saved yet — write one with memory.write"`).
 *  `contact` / `deal` / `account.search` bury it in
 *  `envelope.shape.measures.candidate_count: 0`. `mail.search` and
 *  `calendar.search` return a BARE `{ matches: [], collections: ["bench-mail"] }`
 *  — and `memory.search` has a second path returning `{ entries: [] }` with no
 *  hint at all. Same fact, four presentations, one of them wordless.
 *
 *  This file already knew: the D-205 fenced-read hint exists because
 *  "`{ matches: [] }` is indistinguishable from an empty mailbox". That
 *  reasoning was applied to the FENCE and never to the ordinary empty.
 *
 *  🔑 WHY IT MATTERS HERE: a model that does not register "there is nothing"
 *  supplies the value itself. Task 123 fabricated `pat@example.com` immediately
 *  after `deal.search` returned `candidates: []`. The grounding gate now refuses
 *  such a call at dispatch, but a refusal is a late, lossy correction — saying
 *  the truth plainly is the cheap one, and the two are complementary rather than
 *  alternatives.
 *
 *  ⚠ ADDITIVE ONLY. The existing container stays exactly as it was — callers and
 *  the D-214 flow compiler read `matches` / `candidates` / `entries`, and a
 *  changed envelope would break them. This adds a `hint` where none exists and
 *  NEVER overwrites one: `memory.search`'s "nothing matches 'pilotnote213'" is
 *  more specific than anything generic, and the fenced-read hint says something
 *  categorically different ("you are not allowed to read this", not "this is
 *  empty") — overwriting that would re-open the exact hole D-205 closed.
 *
 *  ⚠ Model-facing string — see `chat-prompt-optimization-log.md`. */
const EMPTY_RESULT_CONTAINERS = [
  // ⚠ `files` was ABSENT until the collection fence needed it, so `file.search`'s
  // empty result never got the explicit-empty sentence every other reader got — the
  // same enumeration-missed-one shape as the fence itself. An unlisted container does
  // not fail; it just stays quiet, which is the failure mode this list exists to fix.
  'matches', 'candidates', 'entries', 'memories', 'enrichments', 'rows', 'items', 'files',
] as const;

export const withExplicitEmpty = (
  tool: string,
  result: unknown,
): unknown => {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  const row = result as Record<string, unknown>;
  // ⛔ Never clobber a hint that is already there — it is always more specific,
  // and the fenced-read one means something else entirely.
  if (typeof row['hint'] === 'string' && row['hint'].length > 0) return result;
  // ⛔⛔ A PARTIAL READ IS NOT AN EMPTY ONE, and conflating them is the D-205
  // hazard wearing new clothes. `contact.search` returns
  // `{ candidates: [], partial: true, partial_failures: [{ source: 'local',
  // reason: '…' }] }` when a source could not be reached — the search did not
  // find nothing, it could not finish. Telling the owner "there are no matching
  // records" because their contact store was down is a confident false
  // statement, which is worse than the bare empty this function exists to fix.
  // Caught by probing the real handler, not by review.
  //
  // ⛔⛔ BUT IT GETS ITS OWN WORDS, because silence here INVERTED the signalling:
  // the first cut made a benign empty explicit and left the DANGEROUS case mute,
  // so `{ candidates: [], partial: true }` said less than `{ candidates: [] }`.
  // That is precisely the 2026-06-08 failure this codebase already paid for —
  // a held run returned `{"status":"ok","result":{"success":false,"steps":[],
  // "errors":[]}}` and a reasoning model read the flag-plus-empty-arrays as a
  // silent failure and looped until the turn timed out. A boolean beside an
  // empty collection is not a sentence, and the model supplies the sentence.
  //
  // ⚠ Fires whether or not the containers are empty: a partial read WITH rows
  // is just as misleading ("here are your 3 contacts" when ten exist).
  const failures = Array.isArray(row['partial_failures']) ? row['partial_failures'] : [];
  if (row['partial'] === true || failures.length > 0) {
    return {
      ...row,
      hint: `${tool} did NOT finish — `
        + `${failures.length > 0 ? `${failures.length} source(s) failed` : 'a source was unreachable'}`
        + '. Records may exist that are not shown here, so do not conclude there'
        + ' are none and do not supply a value from memory. Say the lookup was'
        + ' incomplete, or retry.',
    };
  }
  const containers = EMPTY_RESULT_CONTAINERS.filter((key) => Array.isArray(row[key]));
  // ⚠ No container ⇒ not a list-shaped read (a `.get`, a write receipt). Saying
  // "found nothing" about those would be a lie, not a clarification.
  if (containers.length === 0) return result;
  if (!containers.every((key) => (row[key] as unknown[]).length === 0)) return result;
  return {
    ...row,
    hint: `${tool} found nothing — there are no matching records. `
      + 'Do not supply a value it would have returned; say so, or ask.',
  };
};

/** ⛔⛔ THE COLLECTION READ FENCE, APPLIED AT THE TABLE — derived from the tool's own
 *  `entity`, never hand-written per handler.
 *
 *  ⛔ THIS EXISTS BECAUSE THE HAND-WRITTEN VERSION MISSED ONE AND NOTHING FAILED.
 *  `contact` / `mail` / `calendar` each called the fence inside their handler;
 *  `file.search` never did, so an owner who revoked `data.file` still got their files
 *  back — driven, not theorised. The mail handler's own comment already recorded the
 *  pattern ("Same hole `contact.search` had"), which is the tell: a fence retrofitted
 *  reader-by-reader is a fence the next reader forgets. Same reasoning as
 *  `wrapEmptyResults` directly below — "applied at the TABLE, not inside each handler."
 *
 *  ⛔ IT FENCES THE TOOL'S OWN COLLECTION ONLY. The two other `contact` checks in this
 *  file are PLANE CROSSINGS — `deal.search` resolving a CRM record's contact reads the
 *  core graph — and belong where they are: they gate a sub-read inside a tool whose own
 *  entity is `crm`. Hoisting those here would fence the whole tool on a grant that only
 *  governs part of its answer.
 *
 *  ⚠ `work.*` IS DELIBERATELY OUT. Its collection is the work-entity KIND, which varies
 *  per call (`task` / `note` / `commitment` / …), so the check has to see the args —
 *  `work-entity-read-tools.ts` keeps it for that reason, through the same predicate. */
/** ⛔⛔ TOOLS WHOSE ANSWER SPANS PLANES, SO THE FENCE MUST STAY PER-SOURCE.
 *  `contact.search` fans out across the local graph AND the CRM mirrors. Its local
 *  source already fences — by THROWING, so the fan-out converts it into a NAMED
 *  `partial_failure` and the vendor candidates still come back. Fencing the whole tool
 *  at the table would replace a partial answer with an empty one and drop the CRM half
 *  on a grant that never governed it.
 *
 *  ⚠ THIS IS A HAND-WRITTEN EXCEPTION TO A DERIVED RULE, WHICH IS USUALLY THE BUG
 *  REPORT RATHER THAN THE FIX. The property it stands in for is "this tool reads
 *  exactly one collection", and nothing declares that today. The principled version is
 *  a per-tool marker on `Tier1ToolDescriptor` (single-source vs fan-out); until that
 *  exists, one named entry with its reason is honest and a silent regression is not. */
const FAN_OUT_TOOLS: ReadonlySet<string> = new Set(['contact.search']);

/** The array field each table-fenced tool answers in. A fenced read must return the
 *  tool's OWN empty container beside the hint — a caller that reads `files` and gets a
 *  bare `{hint}` sees an absent key, which is a third state neither "denied" nor
 *  "empty". The hand-written fence returned a mail-shaped `{matches, collections}` for
 *  every collection, so a fenced `calendar.search` answered in a field its own schema
 *  does not describe.
 *
 *  ⛔ Every tool `wrapCollectionFence` wraps MUST appear here — asserted by test, since
 *  a missing entry produces exactly the bare `{hint}` described above and nothing
 *  throws. */
export const FENCED_EMPTY_CONTAINER: Readonly<Record<string, string>> = {
  'contact.read': 'contacts',
  'mail.search': 'matches',
  'mail.read': 'messages',
  'document.read': 'documents',
  'calendar.search': 'matches',
  'file.search': 'files',
};

export const wrapCollectionFence = (
  handlers: Record<string, Tier1Handler>,
  deps: ChatToolHandlerDeps,
): Record<string, Tier1Handler> =>
  Object.fromEntries(Object.entries(handlers).map(([tool, handler]) => {
    // Collection read grants fence reads. Writes reach their own operation
    // grant checks and must never be turned into successful empty reads.
    if (TIER1_CLASSIFICATIONS[tool as keyof typeof TIER1_CLASSIFICATIONS] !== 'read') return [tool, handler];
    const entity = TIER1_TOOL_ENTITY[tool as keyof typeof TIER1_TOOL_ENTITY];
    const collection = entity === undefined || entity === 'work' || FAN_OUT_TOOLS.has(tool)
      ? undefined
      : OP_ENTITY_COLLECTION[entity];
    if (collection === undefined || !isReadableCollection(collection)) return [tool, handler];
    return [
      tool,
      (async (raw, ctx) => {
        if (!isCollectionReadGrantedForDispatch(deps, ctx, collection)) {
          // The tool's OWN empty shape + the fence hint — not a borrowed one. The
          // hand-written version returned a mail-shaped `{matches, collections}` for
          // contact and calendar too, so a fenced `contact.search` answered in a field
          // its caller does not read.
          const container = FENCED_EMPTY_CONTAINER[tool];
          return {
            ok: true,
            result: {
              ...(container !== undefined ? { [container]: [] as unknown[] } : {}),
              hint: collectionReadFencedHint(collection),
            },
          };
        }
        return handler(raw, ctx);
      }) satisfies Tier1Handler,
    ];
  }));

/** D-259 § 7.4.3 — the chat/messenger half of the stop.
 *
 *  ⛔ WHY THIS EXISTS AT ALL: `recipe.run` is a Tier-1 tool and, until this
 *  landed, there was no Tier-1 stop. So when the owner said "forget that, do X
 *  instead", the model started X while the old run KEPT GOING — "instead"
 *  silently became "as well", against their real accounts. The duplicate gate
 *  does not catch it: that collapses an IDENTICAL recipe+args twin, and a steer
 *  is by definition to something else.
 *
 *  🔑 ONE MECHANISM, ANOTHER DOOR. This does not re-implement the arity rule —
 *  it calls the SAME `stopOwnRun` the MCP tool calls, scoped by the SAME
 *  `deriveChannelSessionId`. Re-implementing "one match stops, more than one
 *  refuses" per channel is how the two ends drift.
 *
 *  Authority is derived, never supplied: the wire carries INTENT (a recipe id)
 *  and the server resolves ownership from the stored source. */
const createRecipeStopHandler =
  (deps: ChatToolHandlerDeps, check = false): Tier1Handler =>
  async (raw, ctx) => {
    const registry = deps.getInFlightRegistry?.();
    if (!registry) return executionError('execution registry unavailable');
    if (!ctx.execution_source) {
      // No source ⇒ no ownership can be established. Fail closed rather than
      // fall back to a broader scope.
      return executionError('no execution source on this turn');
    }
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');
    const runId = typeof args.run_id === 'string' ? args.run_id.trim() : '';
    const recipeId = typeof args.recipe_id === 'string' ? args.recipe_id.trim() : '';
    if ((runId === '') === (recipeId === '')) {
      return invalidArgs('pass exactly one of recipe_id or run_id');
    }
    // D-329 — a check stops here. A run that is not there is told after the yes, as
    // `not_found`, which is an answer rather than a refusal.
    if (check) return WOULD_RUN;
    const result = registry.stopOwnRun(
      deriveChannelSessionId(ctx.execution_source),
      runId !== '' ? { run_id: runId } : { recipe_id: recipeId },
    );
    // ⚠ `not_yours` is collapsed to `not_found` on the wire (§ 7.4.4): a model
    // that can tell them apart can probe for the owner's run ids. The registry
    // keeps both, and the audit row records which.
    const projected = result.status === 'not_yours'
      ? { status: 'not_found' as const }
      : result;
    return { ok: true, result: projected };
  };

// ────────────────────────────────────────────────────────────────
// recipe.schedule — D-193 amendment: chat's own way to schedule
// ────────────────────────────────────────────────────────────────

/** The grant op `recipe.schedule` is governed by (a native op: no recipe step
 *  can schedule another recipe, 2026-10-05). */
export const SCHEDULE_RECIPE_OP_ID = 'core.schedule.recipe';

/** Why `recipe.schedule` is refused for this dispatch, or `undefined` when it is
 *  admitted. Two sources may schedule, both the owner:
 *    - the owner's chat and messenger turns, governed by the owner's contract,
 *      while it holds `core.schedule.recipe` (granted unless the owner revoked it);
 *    - the owner's own local MCP client (stdio / canonical CLI). It is
 *      contract-less with the owner's full trust (`resolveTrustCeiling`), and the
 *      one MCP source that is not a door (`isDelegatedMcpToken`). Like every op on
 *      that connection, no grant applies to it (owner, 2026-10-05: "cli: allows").
 *
 *  ⛔ Every other source is refused, whatever it holds. A schedule arms the
 *  OWNER's automation: its runs fire later on the system channel, which no
 *  contract governs, and run whatever recipe it names. A door's recipe authority
 *  is its inbound token, which this gate cannot read (`isOwnerRecipeGranted`
 *  answers for the owner only, by design), so a door that scheduled would reach
 *  past its token. That includes every remote MCP token, bound or not. The op's
 *  grant is NOT what keeps doors out, and it is not owner-default-only: D-261's
 *  pre-approval reads it too, for a door's one-shot that runs under the door's
 *  own retained authority once the owner approves
 *  (`preapproval-origin-authority.ts`).
 *
 *  Fail closed when no gate or source is wired. */
const recipeScheduleRefusal = (
  gate: Pick<OpAdmissionGate, 'isOpGranted' | 'isOwnerGoverned'> | undefined,
  source: ExecutionSource | undefined,
): string | undefined => {
  if (gate === undefined || source === undefined) {
    return 'recipe.schedule is not available here (nothing was scheduled)';
  }
  // Positively the owner's local client: anything else on the mcp channel is a
  // door (fail closed by construction — the sentinel is the only way in).
  if (source.channel === 'mcp' && !isDelegatedMcpToken(source.mcp_token_id)) return undefined;
  if (source.channel === 'schedule' || !gate.isOwnerGoverned(source)) {
    return "recipe.schedule is only for the owner's own chat and local MCP client (nothing was scheduled)";
  }
  if (!gate.isOpGranted(source, SCHEDULE_RECIPE_OP_ID)) {
    return 'recipe.schedule is not granted to this contract (nothing was scheduled)';
  }
  return undefined;
};

/** One entry of a door's diff, in words: a connection by name, a tool or an
 *  action by its id (as the webclient's notice words it). */
const doorEntryLabel = (entry: string): string => {
  if (entry.startsWith('connection:')) return `the ${entry.slice('connection:'.length)} connection`;
  if (entry.startsWith('ingredient:')) return entry.slice('ingredient:'.length);
  return entry;
};

/** What scheduling did to the recipe's webhook, for the model to pass on.
 *
 *  A schedule belongs to the recipe's main dish, made (with no settings) when
 *  it has none, and the recipe's webhook follows that dish (D-209). So the
 *  first schedule of a webhook recipe can move its door. The webclient tells
 *  the owner with a sticky notice on `schedules.create`; a chat result never
 *  reaches that, so the model is told to say it. A widening has to be named
 *  (D-207 §5.1g). An unchanged door is not news, so it is not here. */
const webhookDoorNote = (changes: readonly DishWebhookDoorChange[] | undefined): string | undefined => {
  const sentences: string[] = [];
  for (const change of changes ?? []) {
    const name = change.recipe_name?.trim() || change.recipe_id;
    const list = (entries: readonly string[] | undefined): string => (entries ?? []).map(doorEntryLabel).join(', ');
    switch (change.state) {
      case 'opened': {
        const added = list(change.added);
        const removed = list(change.removed);
        if (!change.was_open) {
          sentences.push(`${name}'s webhook is now on: messages coming in run with its main settings`
            + (added === '' ? '.' : ` and may use ${added}.`));
        } else {
          sentences.push(`${name}'s webhook changed what messages coming in may use`
            + (added === '' ? '' : `; now: ${added}`)
            + (removed === '' ? '' : `; no longer: ${removed}`) + '.');
        }
        break;
      }
      case 'closed': {
        const why = change.reason_code === 'no_account'
          ? ' until its settings choose a connection'
          : change.reason_code === 'refused' && change.reason !== undefined && change.reason.trim() !== ''
            ? ` (${change.reason.trim().replace(/\.$/, '')})`
            : ' for now; saving its settings again retries';
        sentences.push(`${name}'s webhook is ${change.was_open ? 'now ' : ''}off: messages coming in are refused${why}.`);
        break;
      }
      case 'kept_revoked':
        sentences.push(`${name}'s webhook stays off: its access was turned off, and scheduling does not turn it back on.`);
        break;
      default:
        break;
    }
  }
  return sentences.length === 0 ? undefined : `Tell the user: ${sentences.join(' ')}`;
};

/** D-193 amendment (2026-10-05) — schedule an installed recipe from chat.
 *
 *  It replaced the D-193 "Schedule recipe" RECIPE, whose `core.schedule.recipe`
 *  step was the only one that could schedule another recipe. The owner ruled no
 *  recipe step may; chat schedules here, granted by its contract. The same
 *  handler the Run dialog and Automation use makes the row
 *  (`schedule-installed-recipe.ts`), so its refusals are theirs: a recipe that is
 *  not installed, a pack it needs that is missing, a cron below the floor. */
const createRecipeScheduleHandler =
  (deps: ChatToolHandlerDeps, check = false): Tier1Handler =>
  async (raw, ctx) => {
    const args = asObject(raw);
    if (!args) return invalidArgs('args must be an object');
    const refusal = recipeScheduleRefusal(deps.getOpAdmissionGate?.(), ctx.execution_source);
    if (refusal !== undefined) return { ok: false, reason: 'classification_blocked', detail: refusal };
    const schedule = deps.getInstalledRecipeScheduler?.();
    if (!schedule) return executionError('scheduling is unavailable on this server');

    const rawId = typeof args.recipe_id === 'string' ? args.recipe_id.trim() : '';
    if (rawId === '') return invalidArgs('recipe.schedule needs recipe_id, as <publisher>/<slug>');
    if (args.mode !== 'one_shot' && args.mode !== 'recurring') {
      return invalidArgs('mode must be "one_shot" or "recurring"');
    }
    const mode = args.mode;
    let run_at: number | undefined;
    let cron_expression: string | undefined;
    if (mode === 'one_shot') {
      run_at = parseInstantWithOffset(args.run_at) ?? undefined;
      if (run_at === undefined) {
        return invalidArgs(
          'one_shot needs run_at: an ISO 8601 date-time WITH a timezone offset, e.g. 2026-07-04T15:00:00-07:00',
        );
      }
    } else {
      cron_expression = typeof args.cron_expression === 'string' ? args.cron_expression.trim() : '';
      if (cron_expression === '') {
        return invalidArgs('recurring needs cron_expression: five fields, e.g. "0 8 * * 1" for Mondays at 8:00');
      }
    }
    if (args.dish_id !== undefined && (typeof args.dish_id !== 'string' || args.dish_id.trim() === '')) {
      return invalidArgs('dish_id, when given, must be a dish id; normally omit it');
    }
    if (args.enabled !== undefined && typeof args.enabled !== 'boolean') {
      return invalidArgs('enabled, when given, must be true or false; normally omit it');
    }

    const store = deps.getRecipeStore();
    const recipe_id = resolveRecipeId(rawId, store);
    // The recipe's own publisher, as the Run dialog sends it. (The retired step
    // sent none, so its schedules all read `local`.)
    const publisher_id = store.getStored(recipe_id)?.publisher_id
      ?? store.get(recipe_id)?.metadata?.author
      ?? 'local';
    const input: InstalledRecipeScheduleInput = {
      recipe_id,
      publisher_id,
      mode,
      ...(run_at !== undefined ? { run_at } : {}),
      ...(cron_expression !== undefined ? { cron_expression } : {}),
      ...(typeof args.dish_id === 'string' ? { dish_id: args.dish_id.trim() } : {}),
      ...(typeof args.enabled === 'boolean' ? { enabled: args.enabled } : {}),
    };
    try {
      // D-329 — a check makes the schedule's own checks and stops before it arms anything
      // or makes a dish.
      if (check) {
        schedule(input, { check: true });
        return WOULD_RUN;
      }
      const { schedule: made, webhook_doors } = schedule(input);
      const note = webhookDoorNote(webhook_doors);
      // The next run in the zone the schedule runs in (its own, else the host's,
      // as the scheduler reads it), with that zone's offset. "…T08:00:00-07:00"
      // reads as the time the user asked for; UTC would leave the model a
      // conversion to get wrong in what it tells them.
      const zone = cronZoneFor(made, Intl.DateTimeFormat().resolvedOptions().timeZone);
      return {
        ok: true,
        result: {
          status: 'scheduled',
          schedule_id: made.schedule_id,
          recipe_id: `${publisher_id}/${recipe_id}`,
          mode,
          ...(made.next_run_at !== null ? { next_run_at: formatIsoWithOffset(made.next_run_at, zone) } : {}),
          enabled: made.enabled,
          ...(note !== undefined ? { note } : {}),
        },
      };
    } catch (error) {
      // The handler's refusals are written for a person: "Recipe 'x' not found",
      // the missing packs by name, an invalid cron.
      return refusalOf(error);
    }
  };


const createPromptScheduleHandler = (deps: ChatToolHandlerDeps,
  action: 'run_prompt' | 'list' | 'update' | 'pause' | 'resume' | 'remove', check = false): Tier1Handler => async (raw, ctx) => {
  const args = asObject(raw);
  if (!args) return invalidArgs('args must be an object');
  const source = ctx.execution_source, gate = deps.getOpAdmissionGate?.();
  const localMcp = source?.channel === 'mcp' && !isDelegatedMcpToken(source.mcp_token_id);
  const ownerChat = source && (source.channel === 'chat' || source.channel === 'messenger') && source.actor === 'user_self';
  if (!source || !gate || (!localMcp && (!ownerChat || !gate.isOwnerGoverned(source)))
    || (!localMcp && !gate.isOpGranted(source, 'core.schedule.prompt'))) {
    return { ok: false, reason: 'classification_blocked', detail: 'Scheduled prompts require your own chat or local MCP client and the Scheduled prompts grant.' };
  }
  const service = deps.getPromptSchedules?.();
  if (!service) return executionError('Scheduled prompts are unavailable.');
  try {
    if (action === 'list') return { ok: true, result: await service.list(args.all === true ? undefined : ctx.session_id) };
    let result;
    if (action === 'run_prompt') {
      const id = typeof args.creation_id === 'string' ? args.creation_id
        : ctx.turn_id ? `tool:${ctx.turn_id}:${JSON.stringify(args)}` : undefined;
      if (!id) return invalidArgs('An external MCP client must supply a stable creation_id.');
      result = await service.create(args, createHash('sha256').update(id).digest('hex'), check);
    } else if (action === 'update') result = await service.update(args, check);
    else result = await service.control(action, args, check);
    return check ? WOULD_RUN : { ok: true, result: result ? { ...result,
      conversation_href: `#chat/session/${encodeURIComponent(result.session_id)}` } : { removed: true, schedule_id: args.schedule_id } };
  } catch (error) { return refusalOf(error); }
};

export const buildChatTier1Handlers = (
  deps: ChatToolHandlerDeps,
): Record<string, Tier1Handler> => wrapSphereFence(wrapCollectionFence(wrapEmptyResults({
  'contact.search': createContactSearchHandler(deps),
  'contact.read': createContactReadHandler(deps),
  'mail.search': createMailSearchHandler(deps),
  'mail.read': createMailReadHandler(deps),
  'document.read': createDocumentReadHandler(deps),
  'calendar.search': createCalendarSearchHandler(deps),
  'memory.search': createMemorySearchHandler(deps),
  'memory.write': createMemoryWriteHandler(deps),
  'memory.forget': createMemoryForgetHandler(deps),
  'enrichment.search': createEnrichmentSearchHandler(deps),
  'deal.search': createDealSearchHandler(deps),
  'account.search': createAccountSearchHandler(deps),
  'situation.query': async (raw, ctx) => {
    const access = deps.getSituationAccess?.();
    if (!access) return executionError('Situation query unavailable');
    try {
      const { situationModelProjection } = await import('./situations/model-projection.js');
      const { situationSourceCitations } = await import('./chat-situation-source-citations.js');
      const native = await access.read(raw, ctx.execution_source);
      return { ok: true, ...situationSourceCitations(native, situationModelProjection(native, situationPersonName(deps.getContactStore?.()))) };
    } catch (error) {
      const { SituationAccessError } = await import('./situations/access.js');
      if (error instanceof SituationAccessError) return { ok: true, result: { refused: true, hint: error.message } };
      return invalidArgs(error instanceof Error ? error.message : 'Invalid situation query');
    }
  },
  'work.search': createWorkSearchHandler(deps),
  'work.read': createWorkReadHandler(deps),
  'work.type': createWorkTypeHandler(deps),
  'work.create': createWorkCreateHandler(deps),
  'calendar.create': createCalendarCreateHandler(deps),
  'calendar.update': createCalendarUpdateHandler(deps),
  'work.update': createWorkUpdateHandler(deps),
  'file.search': createFileSearchHandler(deps),
  'recipe.run': createRecipeRunHandler(deps),
  'recipe.stop': createRecipeStopHandler(deps),
  'recipe.schedule': createRecipeScheduleHandler(deps),
  'schedule.run_prompt': createPromptScheduleHandler(deps, 'run_prompt'),
  'schedule.list': createPromptScheduleHandler(deps, 'list'),
  'schedule.update': createPromptScheduleHandler(deps, 'update'),
  'schedule.pause': createPromptScheduleHandler(deps, 'pause'),
  'schedule.resume': createPromptScheduleHandler(deps, 'resume'),
  'schedule.remove': createPromptScheduleHandler(deps, 'remove'),
}), deps), deps);

/** No source-specific native reader can silently ignore an item boundary.
 * Work reads filter before counting; situation reads have their own adapter. */
const wrapSphereFence = (handlers: Record<string, Tier1Handler>, deps: ChatToolHandlerDeps): Record<string, Tier1Handler> =>
  Object.fromEntries(Object.entries(handlers).map(([tool, handler]) => [tool, (async (raw, ctx) => {
    const access = deps.getSituationAccess?.();
    const signature = (): string | undefined => {
      if (!access) return undefined;
      const scope = createReadScope(access, ctx.execution_source);
      return JSON.stringify([scope.context.owner, scope.context.all_spheres, scope.context.spheres,
        scope.context.grants.isVerbOpGranted('core.work-entity.read'),
        ['asset', 'task', 'note', 'commitment', 'project', 'booking'].map(kind => scope.context.grants.isCollectionReadGranted(kind))]);
    };
    let before: string | undefined;
    if (tool === 'work.search' || tool === 'work.read') {
      try { before = signature(); }
      catch (error) { return { ok: true, result: { refused: true, hint: error instanceof Error ? error.message : 'This contract cannot read these records' } }; }
    }
    if (['contact.search', 'contact.read', 'mail.search', 'mail.read', 'document.read', 'calendar.search', 'memory.search', 'enrichment.search', 'deal.search', 'account.search', 'file.search'].includes(tool)) {
      if (access) {
        try { if (createReadScope(access, ctx.execution_source).limited) return { ok: true, result: { refused: true, hint: SPHERE_READ_REFUSAL } }; }
        catch (error) { return { ok: true, result: { refused: true, hint: error instanceof Error ? error.message : 'This contract cannot read these records' } }; }
      }
    }
    const result = await handler(raw, ctx);
    if (before !== undefined) {
      try { if (before !== signature()) return { ok: true, result: { refused: true, hint: 'Permissions changed during this read. Refresh before relying on it.' } }; }
      catch { return { ok: true, result: { refused: true, hint: 'This contract no longer permits this read.' } }; }
    }
    return result;
  }) satisfies Tier1Handler]));

/** ⛔ Applied at the TABLE, not inside each handler. Eight readers each
 *  remembering to describe their own empty is eight chances to drift, and the
 *  audit above is what that drift looks like after a year. */
export const wrapEmptyResults = (
  handlers: Record<string, Tier1Handler>,
): Record<string, Tier1Handler> =>
  Object.fromEntries(Object.entries(handlers).map(([tool, handler]) => [
    tool,
    (async (raw, ctx) => {
      const out = await handler(raw, ctx);
      return out.ok ? { ...out, result: withExplicitEmpty(tool, out.result) } : out;
    }) satisfies Tier1Handler,
  ]));

/** Convenience export — bin.ts passes this entire bundle to
 *  `createInternalToolRegistry({ tier1Handlers, tier2Source,
 *  manifestLookup, tier2Dispatch, tier3Dispatch })`. The registry's
 *  per-name override table only applies known Tier 1 names; the unused
 *  channel-isolation guard + `getByName` shape stay verbatim. */
/** D-225 § 9.5.1 — the chat catalog's raw catalog-op source.
 *
 *  Byte-identical rows to the door's, from the shared `rawOpToolEntries` — a raw
 *  op describing itself differently to chat than to the door would be one op
 *  wearing two faces while the owner's single grant covers both.
 *
 *  🔑 Emitting an entry is VISIBILITY, not authority. What a chat caller may
 *  actually invoke is still the contract's per-op grant, and whether a given
 *  call holds is still the op's risk/approval — the two axes of § 9.7. Chat
 *  arrives as `user_self`, so the owner's author-default admits; a door arrives
 *  with a contract id and needs its grant.
 *
 *  ⚠ No `recipeOpCoverage` is passed. The door suppresses a raw WRITE op a
 *  recipe already provides, because at the door a recipe is the guardrailed
 *  form of the same action. That reasoning is the door's; whether chat wants the
 *  same suppression is a UX question nobody has answered, and quietly inheriting
 *  it would answer it by accident. Absent ⇒ no suppression. */
/** D-247 D9 — is this Tier-2 catalog entry REACHABLE for `source`?
 *
 *  ⛔⛔ KEPT BESIDE THE REGISTRY, NOT THREADED THROUGH IT, and that is doctrine
 *  rather than convenience: `chat-orchestrator.ts` states it for the raw ops —
 *  *"Kept beside (rather than inside) the ordinary registry because raw
 *  visibility is derived from the turn's contract"* — and a recipe's visibility
 *  became contract-derived the moment D-247 gave it a grant. `InternalToolRegistry`
 *  and its three wrappers stay unchanged; touching them is the sign this drifted
 *  back to threading a source through `list` / `listByTier` / `getByName`.
 *
 *  ⛔ THREE EXPOSURE SURFACES CONSUME THIS AND THEY FAIL INDEPENDENTLY: the chat
 *  catalog (`buildCatalog`), the `tools.search` handler (which returns Tier-2
 *  matches straight to the model), and the MCP door's `tools/list`. Each has a
 *  source in hand; a filter wired into one of them is a hole in the other two.
 *  Dispatch re-checks separately (`admitTier2`), because a name the model already
 *  holds from an earlier turn survives a revoke otherwise.
 *
 *  ⚠ THE KEY IS DERIVED FROM THE TOOL NAME, not from a store read, and the two
 *  must agree. A Tier-2 entry's name is `<publisher>/<recipe_id>` where the
 *  publisher came from `stored.publisher_id ?? metadata.author` — the SAME
 *  resolution `recipeGrantKeyFor` performs. Deriving from the name keeps this off
 *  the per-turn hot path (no SQLite read per entry per turn); the equivalence is
 *  pinned by test, because a key formed two ways is a grant that writes to one
 *  address and reads from another. */
export const createChatTier2GrantFilter = (
  deps: ChatToolHandlerDeps,
): ((source?: ExecutionSource) => (toolName: string) => boolean) => (source) => {
  const gate = deps.getOpAdmissionGate?.();
  // ⚠ No gate wired ⇒ UNFILTERED, which is today's behaviour and keeps every
  // dbless / partial harness working. Deliberate, and pinned by test so it stays
  // a decision someone reads rather than a hole. Mirrors `createChatRawOpSource`.
  if (!gate) return () => true;
  // ⛔ An ABSENT source DENIES, for the same reason the raw-op source fails
  // closed: `isOwnerRecipeGranted` answers `false` for anything ungoverned, so a
  // synthesised source would look identical to a working one while admitting on
  // a different question.
  if (!source) return () => false;
  // ⛔⛔ A DOOR IS NOT OURS TO GATE, AND CONFUSING THAT WITH "NO GRANT" HIDES
  // EVERY TIER-2 RECIPE ON EVERY DOOR. A door's recipe authority is its INBOUND
  // TOKEN (`inboundTokenAuthorize` → `allowed_tools`, D-232 § 20.19), already
  // enforced on that path; the `recipe.*` axis is owner-scoped (D7). Asking
  // `isOwnerRecipeGranted` without this check reads a door's structural `false`
  // as a revoke and takes the whole catalog down on a surface that was working.
  if (!gate.isOwnerGoverned(source)) return () => true;
  return (toolName: string) => {
    const slash = toolName.indexOf('/');
    // Not a `<publisher>/<recipe_id>` name ⇒ not a Tier-2 recipe ⇒ not ours to
    // gate. An ingredient slug never contains `/`, which is what makes this safe.
    if (slash <= 0 || slash === toolName.length - 1) return true;
    return gate.isOwnerRecipeGranted(
      source,
      recipeGrantEntry(toolName.slice(0, slash), toolName.slice(slash + 1)),
    );
  };
};

/** D-247 D9 — refuse to serve the OWNER'S catalog to a source that is not the
 *  owner. The fail-CLOSED sibling of {@link createChatTier2GrantFilter}.
 *
 *  ⛔⛔ THE FILTER BESIDE THIS ONE DELIBERATELY RETURNS `() => true` FOR A DOOR,
 *  and that is correct on the path it was written for: a door's recipe
 *  authority is its inbound token, and the llm_gateway turn never calls
 *  `buildCatalog` at all — it builds its own catalog from `allowed_tool_names`
 *  and omits `tools.search` entirely. So today a door cannot reach these two
 *  surfaces, and the `() => true` branch is unreached.
 *
 *  ⛔ WHICH MEANS THE ISOLATION IS STRUCTURAL, NOT ENFORCED — safe by ROUTING.
 *  The day a contracted source reaches the ordinary chat path (an `mcp.chat`
 *  driven by a non-`user_self` caller is exactly that change), both surfaces
 *  hand over the owner's ENTIRE installed catalog — names, descriptions and arg
 *  schemas — because `allowed_tools` gates dispatch on that path, not listing.
 *  Nothing would be dispatchable and nothing would fail; the owner's whole
 *  workflow inventory would simply be readable.
 *
 *  🔑 SO THIS IS A REFUSAL, NOT A FILTER. Adding filtering here would duplicate
 *  the inbound token's job and invite the two to disagree. Refusing says the
 *  truth: these surfaces serve one tenant, and a second one arriving is a
 *  routing error, not a narrower catalog.
 *
 *  ⚠ It fires ONLY on an AFFIRMATIVELY non-owner-governed source. No gate
 *  wired, or no source, proceeds exactly as today — so this cannot break a
 *  dbless / partial harness, and it is a no-op on every path that works now.
 *  ⚠ The precedent for throwing rather than returning an empty catalog is
 *  `assertRecallCorpusSelector`: at an authority boundary a silent empty result
 *  reads as "nothing is installed", which is a worse answer than a failure.
 *
 *  ⚠ THIS CLASS HAS FAILED HERE BEFORE. `tools.search` accepted and threaded
 *  `tier2GrantFilter` but never READ it until 2026-08-20 — "the grant worked in
 *  the catalog and silently did not in search". Three surfaces, one question,
 *  and they fail independently. */
export const createChatOwnerCatalogGuard = (
  deps: ChatToolHandlerDeps,
): ((source?: ExecutionSource) => void) => (source) => {
  const gate = deps.getOpAdmissionGate?.();
  if (!gate || !source) return;
  if (gate.isOwnerGoverned(source)) return;
  throw new Error(
    'chat catalog: the owner tool catalog is not servable to a contracted source',
  );
};

export const createChatRawOpSource = (
  deps: ChatToolHandlerDeps,
): ((source?: ExecutionSource) => RawOpToolEntry[]) => (source) => {
  // ⛔ COMPUTED BEFORE THE PACK-SCAN EARLY EXIT. Canonical tools do not come from
  // an installed pack, so a server with no packs scanned must still offer them —
  // the first cut sat below `if (!scan) return []` and contributed nothing on
  // exactly the setup that has connections but no Tier-P packs.
  const canonical = rawOpToolEntriesFrom(
    (deps.getCanonicalOpTools?.() ?? []) as unknown as readonly RawOpToolDescriptor[],
  );
  const scan = deps.scanInstalledPacks;
  if (!scan) return canonical;
  const getManifest = (slug: string) => deps.getExecutorConfig().manifests.get(slug);
  // D-247 open item 2 — §8 RECIPE-PREFERRED SUPPRESSION, same as the door.
  // ⛔ This call passed two args while the MCP door passed three, so a raw WRITE
  // an installed recipe already covers stayed VISIBLE to chat while the grant
  // catalog beside it (`wire-chat-orchestrator`, which has always passed
  // coverage) had already suppressed it — one doctrine answered two ways on one
  // surface. Under D2 it is not load-bearing (op rows default OFF, so the raw
  // tool is gated anyway); it is wired because a second answer is how the first
  // one stops being true.
  //
  // 🔑 The pack resolution must be the SAME one the descriptors use, or an
  // `ingredient:`-authored write maps to no op id and silently fails to suppress.
  //
  // ⚠ `getRecipeStore` is DECLARED required, but `wire-reception-substrate.ts:466`
  // supplies it through a conditional spread, so a real composition can omit it
  // and the compiler cannot see that. Absent ⇒ no coverage, which is this
  // module's documented safe direction (over-exposure, never hiding a write) and
  // leaves the raw op gated by its own grant regardless.
  const recipeStore = deps.getRecipeStore?.();
  const coverage = recipeStore
    ? buildRecipeOpCoverage(recipeStore, buildPackOpResolution(scan, getManifest))
    : undefined;
  const universe = buildRawOpToolDescriptors(scan, getManifest, coverage);
  const gate = deps.getOpAdmissionGate?.();
  // ⚠ No gate wired ⇒ unfiltered, which is today's behaviour and keeps every
  // dbless / partial harness working. Deliberate, and pinned by test so it stays
  // a decision someone reads rather than a hole.
  // D-255 — canonical entries ride the SAME source hook, so chat-orchestrator's
  // single `rawOpSource` lookup finds them and routes them to the single
  // `rawOpDispatch`. ⛔ They carry NO per-op contract grant of their own: a
  // canonical op dispatches its RESOLVED vendor op, which the gate judges inside
  // the run, and its visibility was already decided by the connection's operation
  // profile in the builder.
  if (!gate) return [...rawOpToolEntriesFrom(universe), ...canonical];
  // ⛔ An ABSENT source DENIES. `TurnContext.source` is optional ("only for bare
  // test harnesses"), so a missing one is reachable — and `isOpGranted` returns
  // TRUE when no contract governs, so passing a synthesised or undefined source
  // would make the filter admit everything while looking identical to a working
  // one. Fail closed instead: no source, no derived catalog.
  if (!source) return [];
  return [
    ...rawOpToolEntriesFrom(visibleRawOps(universe, (opId) => gate.isOpGranted(source, opId))),
    ...canonical,
  ];
};

/** D-225 § 9.5.1 step 2b — invoke a raw catalog op from chat.
 *
 *  Mirrors `createChatTier2Dispatch`: resolve, dispatch, project. The dispatch
 *  itself is `dispatchRawOp`, unchanged and unwrapped — the SAME function the
 *  inbound door calls. Chat supplies its own `execution_source` (owner chat
 *  arrives `(chat, user_self)`), so the admission resolves to the owner
 *  author-default rather than a door's grant, and the op's risk/approval is the
 *  global row either way (§ 9.7).
 *
 *  🔑 **ONE ASK.** A `held` outcome projects to the same `awaiting_approval`
 *  shape Tier 1/2/3 already surface — chat does not add a second consent step of
 *  its own. Two asks for one action trains click-through, and the engine's
 *  preflight gate is already the single boundary ("no second enforcement path").
 *
 *  ⚠ `held` and `ask` are NOT errors. A held write is the expected, successful
 *  outcome of asking for one; returning an error envelope would tell a weak
 *  model to retry, which is exactly the loop the door's own handler avoids. */
/** D-255 — dispatch a CANONICAL op from chat. Routed inside the raw-op dispatch
 *  below, so one hook serves both and chat-orchestrator needs no branch.
 *
 *  ⛔ THE SAME TRANSIENT-RECIPE PATH THE DOOR USES. A canonical op-step expands to
 *  a vendor dispatch PLUS the projection that makes the result canonical, so the
 *  unit of execution is a recipe; R2 resolves it against the named connection
 *  INSIDE the run, and the gate judges the RESOLVED vendor op. Chat supplies
 *  `(chat, user_self)` and a door supplies its own contract — the same code, a
 *  different contract id, which is the whole point of not branching here. */
const dispatchChatCanonicalOp = async (
  deps: ChatToolHandlerDeps,
  toolName: string,
  args: unknown,
  ctx: ChatDispatchContext,
): Promise<ChatDispatchResult> => {
  // ⛔ VALIDATE BEFORE REACHING FOR THE EXECUTOR. A bad alias or a missing
  // connection is the caller's error and must say so; surfacing "executor
  // unavailable" first would blame the server for the caller's typo.
  const opId = toolName.slice(CANONICAL_OP_TOOL_PREFIX.length);
  const dot = opId.indexOf('.');
  if (dot <= 0) {
    return { ok: false, reason: 'execution_error', detail: `unknown canonical op '${toolName}'` };
  }
  const a = (args ?? {}) as Record<string, unknown>;
  const verb = opId.slice(dot + 1);
  const connection = a.connection;
  const named = typeof connection === 'string' && connection.length > 0;
  // ⛔⛔ FAN-OUT IS `search`-ONLY. Omitting the connection on a write would write to
  // EVERY connected CRM, and `read` takes an id that belongs to exactly one
  // connection (D-254). `search` alone has no id and no side effect, so
  // "look everywhere unless told otherwise" is safe and is what a caller means.
  if (!named && verb !== 'search') {
    return {
      ok: false,
      reason: 'execution_error',
      detail: `'${toolName}' requires a 'connection' argument naming the enrolled connection.`,
    };
  }
  const built = buildCanonicalOpRecipe({
    alias: opId.slice(0, dot),
    verb: opId.slice(dot + 1),
    ...(a.args !== undefined ? { args: a.args as Record<string, unknown> } : {}),
  });
  if (!built.ok) return { ok: false, reason: 'execution_error', detail: built.reason };

  const execute = deps.getExecuteRecipe?.();
  if (!execute) {
    return { ok: false, reason: 'execution_error', detail: 'recipe executor unavailable' };
  }
  const runOne = (conn: string): Promise<unknown> => execute({
    recipe: built.recipe,
    config: { [CANONICAL_OP_CONNECTION_VAR]: conn },
    trigger_source: 'chat',
    ...(ctx.execution_source !== undefined ? { execution_source: ctx.execution_source } : {}),
  } as unknown as ExecuteRequest);

  if (named) {
    const response = (await runOne(connection as string)) as ExecuteResponse;
    // The run's address, and its hold, beside what the model reads (unchanged):
    // a write held for the owner's approval is then known by its run — the
    // owner's chat records its late result, and the email door its follow-up
    // (D-318 audit). A recipe run's dispatch carries the same (`wrapRecipeRunResult`).
    const run_id = executeResponseAuditRunId(response);
    return {
      ok: true,
      result: response as unknown as Record<string, unknown>,
      ...(response.awaiting_approval === true ? { run_held: { kind: 'approval' as const } } : {}),
      ...(run_id !== undefined ? { run_id } : {}),
    };
  }
  // Unnamed `search` — every connection the DESCRIPTOR offers, which is already the
  // profile-granted set, so the fan-out can never reach a connection the catalog
  // would not have advertised.
  const serving = (deps.getCanonicalOpTools?.() ?? [])
    .find((d) => d.opId === opId)?.connections ?? [];
  if (serving.length === 0) {
    return {
      ok: false,
      reason: 'execution_error',
      detail: `no connection serves '${opId}' — name one, or enrol a connection that does.`,
    };
  }
  const fanout = await runCanonicalSearchFanout(serving, runOne);
  return { ok: true, result: fanout as unknown as Record<string, unknown> };
};

export const createChatRawOpDispatch = (
  deps: ChatToolHandlerDeps,
): ChatRawOpDispatch => async (toolName, args, ctx) => {
  // D-255 — one hook, two derived families. Routed by prefix here rather than by a
  // second hook in chat-orchestrator, so the catalog lookup, the dispatch seam and
  // the audit path stay single.
  if (toolName.startsWith(CANONICAL_OP_TOOL_PREFIX)) {
    return dispatchChatCanonicalOp(deps, toolName, args, ctx);
  }
  const getDispatchDeps = deps.getRawOpDispatchDeps;
  if (!getDispatchDeps) return executionError('raw op dispatch unavailable');
  const dispatchDeps = getDispatchDeps();
  if (!dispatchDeps) return executionError('raw op dispatch unavailable');
  if (!toolName.startsWith(OP_TOOL_PREFIX)) {
    return invalidArgs(`not a raw catalog op: ${toolName}`);
  }
  const opArgs = asObject(args);
  if (opArgs === null) return invalidArgs('raw catalog-op arguments must be an object');
  const opId = toolName.slice(OP_TOOL_PREFIX.length);
  // ⛔ REFUSE RATHER THAN DISPATCH WITHOUT A SOURCE. `executionSource` is a
  // REQUIRED field of `RawOpDispatchRequest`, but `ctx.execution_source` is
  // optional — and this call used to spread it in conditionally under a
  // whole-object `as`, which silenced the missing-field check. A source-less
  // request reaches `admitRawOp`, whose gates no-op for contract-free sources
  // by design ("no governing contract ⇒ the gate is a no-op"; "Contract-free
  // sources bypass" `isFrozenByPause`), and then dereferences
  // `executionSource.channel`. Neither outcome is one to reach by accident.
  if (!ctx.execution_source) {
    return executionError('cannot dispatch operation: no execution source on this turn');
  }
  try {
    const outcome = await dispatchRawOp(dispatchDeps, {
      opId,
      args: opArgs,
      executionSource: ctx.execution_source,
      ...(ctx.contract_snapshot ? { contractSnapshot: ctx.contract_snapshot } : {}),
    });
    return projectRawOpOutcome(outcome);
  } catch (e) {
    return executionError(errMessage(e));
  }
};

/** D-225 § 9.5.1 — project a `dispatchRawOp` outcome into a chat tool result.
 *
 *  🔑 Extracted as a PURE function rather than injecting a fake dispatcher. The
 *  behaviour worth pinning here is the PROJECTION — what the agent is told about
 *  a held run — not that a stub was called. A test-only dependency seam would
 *  have added a hole to production shape to observe something that was never
 *  about the dependency.
 *
 *  ⛔ `held` and `ask` are SUCCESSES, not errors. A held write is the expected
 *  outcome of asking for one; an error envelope tells a weak model to retry,
 *  which is the loop the door's own handler is careful to avoid. The held
 *  message therefore carries do-NOT-resend + tell-the-user.
 *
 *  🔑 ONE ASK: `held` projects to the same `awaiting_approval` shape Tier 1/2/3
 *  already surface, so chat adds no second consent of its own. */
export const projectRawOpOutcome = (
  outcome: RawOpDispatchOutcome,
): ChatDispatchResult => {
  switch (outcome.kind) {
    case 'result':
      return { ok: true, result: outcome.result };
    case 'held':
      return {
        ok: true,
        run_held: { kind: 'approval' },
        run_id: outcome.run_id,
        result: {
          status: 'awaiting_approval',
          awaiting_approval: true,
          op: outcome.op_id,
          message: HELD_FOR_APPROVAL_CHAT_MESSAGE,
        },
      };
    case 'ask':
      return {
        ok: true,
        result: { status: 'requires_approval', op: outcome.op_id, message: outcome.message },
      };
    case 'refused':
      return {
        ok: false,
        reason: outcome.code !== undefined ? 'invalid_args' : 'execution_error',
        detail: outcome.message,
      };
  }
};

/** What a chat raw-op dispatch returns. Structural, matching the shape the
 *  other chat dispatches use. */
export type ChatRawOpDispatch = (
  toolName: string,
  args: unknown,
  ctx: ChatDispatchContext,
) => Promise<ChatDispatchResult>;

/** The held-run message. Expected-outcome framing + do-NOT-resend + tell-the-
 *  user, so a weak/local model never loops on an approval it cannot resolve. */
const HELD_FOR_APPROVAL_CHAT_MESSAGE =
  'This operation is held for the owner\'s approval. Do NOT resend it — tell the '
  + 'user it is waiting for them to approve.';

export const buildChatToolRegistryInputs = (deps: ChatToolHandlerDeps) => ({
  tier1Handlers: buildChatTier1Handlers(deps),
  // D-329 — a write's own refusal, asked before the owner is (`checkBeforeAsking`).
  tier1Checks: {
    'work.create': (args: unknown, ctx: ChatDispatchContext) => checkWorkCreate(deps, args, ctx),
    'work.update': (args: unknown, ctx: ChatDispatchContext) => checkWorkUpdate(deps, args, ctx),
    'calendar.create': checkedBy(createCalendarCreateHandler, deps),
    'calendar.update': checkedBy(createCalendarUpdateHandler, deps),
    'memory.write': checkedBy(createMemoryWriteHandler, deps),
    'memory.forget': checkedBy(createMemoryForgetHandler, deps),
    'recipe.stop': checkedBy(createRecipeStopHandler, deps),
    'recipe.schedule': checkedBy(createRecipeScheduleHandler, deps),
    'schedule.run_prompt': checkedBy((d, check) => createPromptScheduleHandler(d, 'run_prompt', check), deps),
    'schedule.update': checkedBy((d, check) => createPromptScheduleHandler(d, 'update', check), deps),
    'schedule.pause': checkedBy((d, check) => createPromptScheduleHandler(d, 'pause', check), deps),
    'schedule.resume': checkedBy((d, check) => createPromptScheduleHandler(d, 'resume', check), deps),
    'schedule.remove': checkedBy((d, check) => createPromptScheduleHandler(d, 'remove', check), deps),
  },
  tier1AskLabels: {
    'work.create': (args: unknown) => workAskLabels(deps, args),
    'work.update': (args: unknown) => workAskLabels(deps, args),
    'calendar.update': (args: unknown, ctx: ChatDispatchContext) => calendarAskLabels(deps, args, ctx),
  },
  tier2Source: createChatTier2Source(deps),
  manifestLookup: createChatManifestLookup(deps),
  tier2Dispatch: createChatTier2Dispatch(deps),
  // ⛔ D-228 slice 4 — NO `tier3Dispatch`. The registry's parameter is optional
  // and the catalog now emits no tier-3 entry, so a dispatch could only ever be
  // reached by a name nothing advertised. Supplying a handler that refuses
  // everything would be a second, silent gate; supplying none says the surface
  // does not exist, which is the truth.
  rawOpSource: createChatRawOpSource(deps),
  // D-247 D9 — shared by all three Tier-2 exposure surfaces.
  tier2GrantFilter: createChatTier2GrantFilter(deps),
  ownerCatalogGuard: createChatOwnerCatalogGuard(deps),
  rawOpDispatch: createChatRawOpDispatch(deps),
});

/** Re-export for callers that want to construct the ctx for
 *  out-of-orchestrator dispatches (tests, future MCP wire wrapping).
 *  No new contract — this just narrows the import surface. */
export type { ChatDispatchContext, ChatDispatchResult };
